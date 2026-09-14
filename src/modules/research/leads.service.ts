import { Injectable, Logger } from '@nestjs/common';
import { Api } from 'telegram';
import type { Entity } from 'telegram/define';
import { FloodWaitError } from 'telegram/errors';
import { sleepJitter } from '@common/utils/sleep';
import {
  formatLeads,
  leadsFileName,
  type LeadsResult,
} from '@modules/research/leads.format';
import {
  buildCandidates,
  getLeadProfile,
  REFERRAL_PROFILE,
  type LeadProfileName,
  type ScoredMessage,
} from '@modules/research/leads.scoring';
import { ResearchConfig } from '@modules/research/research.config';
import { writeDigest } from '@modules/research/research.files';
import { messageLink } from '@modules/research/research.service';
import { TelegramClientService } from '@modules/telegram/telegram-client.service';

export interface LeadsRunParams {
  chats?: string[];
  queries?: string[];
  perQueryLimit?: number;
  sinceDays?: number;
  minScore?: number;
  /** Пусто — визовый профиль поиска рефереров, как и всегда. */
  profile?: LeadProfileName;
}

export interface LeadsRunSummary extends LeadsResult {
  file: string | null;
}

/**
 * Запросы по умолчанию визового профиля. Значение переехало в
 * `leads.scoring.ts` как `REFERRAL_PROFILE.queries` — там же теперь и его
 * профильные соседи (patterns/weights/strongSignals). Имя и содержимое здесь
 * не меняются, чтобы ничего, что импортировало `DEFAULT_LEAD_QUERIES`
 * раньше, не заметило разницы.
 */
export const DEFAULT_LEAD_QUERIES = REFERRAL_PROFILE.queries;

interface ResolvedChat {
  ref: string;
  entity: Entity;
  title: string | null;
  username: string | null;
}

/**
 * Поиск ЛЮДЕЙ в чатах. Как и ResearchService — только чтение.
 *
 * Ни одного вызова, который что-то отправляет: цена ошибки известна,
 * см. docs/postmortem-spam-ban.md. Отчёт с юзернеймами кладётся в
 * gitignore-папку: это живые люди, а репозиторий публичный.
 */
@Injectable()
export class LeadsService {
  private readonly logger = new Logger(LeadsService.name);

  private readonly chatCache = new Map<string, ResolvedChat>();

  private running = false;

  private lastSummary: LeadsRunSummary | null = null;

  constructor(
    private readonly config: ResearchConfig,
    private readonly telegram: TelegramClientService,
  ) {}

  public isRunning(): boolean {
    return this.running;
  }

  public getLastSummary(): LeadsRunSummary | null {
    return this.lastSummary;
  }

  public startInBackground(params: LeadsRunParams): {
    started: boolean;
    reason?: string;
  } {
    if (this.running) return { started: false, reason: 'Сбор лидов уже идёт' };

    const chats = params.chats?.length ? params.chats : this.config.chats;
    if (chats.length === 0) {
      return {
        started: false,
        reason: 'Не задан чат: RESEARCH_CHATS пуст и ?chat= не передан',
      };
    }

    void this.run(params).catch((err) => {
      this.logger.error(`Сбор лидов упал: ${describeError(err)}`);
    });

    return { started: true };
  }

  public async run(params: LeadsRunParams = {}): Promise<LeadsRunSummary> {
    if (this.running) throw new Error('Сбор лидов уже идёт — дождись окончания');

    // Без profile — визовый REFERRAL_PROFILE, ровно как раньше DEFAULT_LEAD_QUERIES.
    const profile = getLeadProfile(params.profile);
    const chats = params.chats?.length ? params.chats : this.config.chats;
    const queries = params.queries?.length ? params.queries : [...profile.queries];
    const perQueryLimit = params.perQueryLimit ?? this.config.perQueryLimit;
    const sinceDays = params.sinceDays ?? this.config.sinceDays;
    const minScore = params.minScore ?? this.config.leadsMinScore;

    if (chats.length === 0) throw new Error('Не задан чат: RESEARCH_CHATS пуст');

    this.running = true;
    const startedAt = new Date();

    // Дедуп по (чат, id): одно сообщение попадает под несколько фраз сразу,
    // иначе автор получил бы кратный вес за один и тот же текст.
    const seen = new Set<string>();
    const collected: ScoredMessage[] = [];
    const minDate =
      sinceDays > 0 ? Math.floor(Date.now() / 1000) - sinceDays * 86_400 : 0;

    try {
      for (const chatRef of chats) {
        let chat: ResolvedChat;
        try {
          chat = await this.resolveChat(chatRef);
        } catch (err) {
          this.logger.error(`Чат ${chatRef}: не открылся — ${describeError(err)}`);
          continue;
        }

        for (const [index, query] of queries.entries()) {
          if (index > 0) await sleepJitter(this.config.delayBetweenQueriesSec * 1000);
          await this.collectOne(chat, query, perQueryLimit, minDate, seen, collected);
        }
      }
    } finally {
      this.running = false;
    }

    const candidates = buildCandidates(
      collected,
      Math.floor(Date.now() / 1000),
      profile,
    ).filter((c) => c.score >= minScore);

    const result: LeadsResult = {
      chats,
      queries,
      scanned: collected.length,
      candidates,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      sinceDays,
    };

    const file = writeDigest(
      this.config.dir,
      leadsFileName(startedAt),
      formatLeads(result),
    );

    const summary: LeadsRunSummary = { ...result, file };
    this.lastSummary = summary;

    this.logger.log(
      `Лиды собраны: сообщений ${collected.length}, кандидатов ${candidates.length}, файл ${file ?? '—'}`,
    );
    return summary;
  }

  private async collectOne(
    chat: ResolvedChat,
    query: string,
    limit: number,
    minDate: number,
    seen: Set<string>,
    sink: ScoredMessage[],
  ): Promise<void> {
    try {
      const client = this.telegram.getClient();
      for await (const message of client.iterMessages(chat.entity, {
        search: query,
        limit,
      })) {
        const text = (message.message ?? '').trim();
        if (text.length < this.config.minTextLength) continue;

        const date = Number(message.date ?? 0);
        if (minDate > 0 && date > 0 && date < minDate) break;

        const key = `${chat.ref}:${message.id}`;
        if (seen.has(key)) continue;
        seen.add(key);

        sink.push({
          author: await this.describeSender(message),
          text,
          date,
          link: messageLink(chat.username, message.id),
        });
      }
    } catch (err) {
      const reason =
        err instanceof FloodWaitError
          ? `FloodWait ${err.seconds}s — Telegram просит притормозить`
          : describeError(err);
      this.logger.warn(`Фраза «${query}»: прервана — ${reason}`);
    }
  }

  private async describeSender(message: Api.Message): Promise<string> {
    try {
      const sender = await message.getSender();
      if (!sender) return 'аноним';
      if (sender instanceof Api.User) {
        if (sender.username) return `@${sender.username}`;
        const name = [sender.firstName, sender.lastName].filter(Boolean).join(' ');
        return name || `id${sender.id.toString()}`;
      }
      if ('title' in sender && typeof sender.title === 'string') return sender.title;
      return 'аноним';
    } catch {
      return 'аноним';
    }
  }

  private async resolveChat(ref: string): Promise<ResolvedChat> {
    const cached = this.chatCache.get(ref);
    if (cached) return cached;

    const client = this.telegram.getClient();
    const entity = await client.getEntity(ref);

    const resolved: ResolvedChat = {
      ref,
      entity,
      title: 'title' in entity && typeof entity.title === 'string' ? entity.title : null,
      username:
        'username' in entity && typeof entity.username === 'string'
          ? entity.username
          : null,
    };

    this.chatCache.set(ref, resolved);
    return resolved;
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
