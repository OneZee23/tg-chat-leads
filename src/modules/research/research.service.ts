import { Injectable, Logger } from '@nestjs/common';
import { Api } from 'telegram';
import type { Entity } from 'telegram/define';
import { FloodWaitError } from 'telegram/errors';
import { sleepJitter } from '@common/utils/sleep';
import {
  digestFileName,
  formatDigest,
  type QueryStat,
  type ResearchHit,
  type ResearchResult,
} from '@modules/research/digest.format';
import { ResearchConfig } from '@modules/research/research.config';
import { writeDigest } from '@modules/research/research.files';
import { TelegramClientService } from '@modules/telegram/telegram-client.service';

export interface ResearchRunParams {
  chats?: string[];
  queries?: string[];
  perQueryLimit?: number;
  sinceDays?: number;
}

export interface ResearchRunSummary extends ResearchResult {
  file: string | null;
}

interface ResolvedChat {
  ref: string;
  entity: Entity;
  title: string | null;
  username: string | null;
}

/**
 * Поиск по чатам от живого аккаунта — для ресёрча, а не для лидов.
 *
 * Модуль ТОЛЬКО ЧИТАЕТ. Здесь намеренно нет ни одного вызова, который
 * что-то отправляет: цена ошибки в этом репозитории уже известна
 * (docs/postmortem-spam-ban.md), и разделение «читалка отдельно от
 * отправлялки» дешевле любых предохранителей внутри одного класса.
 */
@Injectable()
export class ResearchService {
  private readonly logger = new Logger(ResearchService.name);

  private readonly chatCache = new Map<string, ResolvedChat>();

  /** Один прогон за раз: параллельные поиски — это FloodWait и каша в файле. */
  private running = false;

  private lastSummary: ResearchRunSummary | null = null;

  constructor(
    private readonly config: ResearchConfig,
    private readonly telegram: TelegramClientService,
  ) {}

  public isRunning(): boolean {
    return this.running;
  }

  public getLastSummary(): ResearchRunSummary | null {
    return this.lastSummary;
  }

  public startInBackground(params: ResearchRunParams): {
    started: boolean;
    reason?: string;
  } {
    if (this.running) return { started: false, reason: 'Поиск уже идёт' };

    const chats = params.chats?.length ? params.chats : this.config.chats;
    if (chats.length === 0) {
      return {
        started: false,
        reason: 'Не задан чат: RESEARCH_CHATS пуст и ?chat= не передан',
      };
    }

    void this.run(params).catch((err) => {
      this.logger.error(`Поиск упал: ${describeError(err)}`);
    });

    return { started: true };
  }

  public async run(params: ResearchRunParams = {}): Promise<ResearchRunSummary> {
    if (this.running) throw new Error('Поиск уже идёт — дождись окончания');

    const chats = params.chats?.length ? params.chats : this.config.chats;
    const queries = params.queries?.length ? params.queries : this.config.queries;
    const perQueryLimit = params.perQueryLimit ?? this.config.perQueryLimit;
    const sinceDays = params.sinceDays ?? this.config.sinceDays;

    if (chats.length === 0) throw new Error('Не задан чат: RESEARCH_CHATS пуст');
    if (queries.length === 0) throw new Error('Не заданы запросы: RESEARCH_QUERIES пуст');

    this.running = true;
    const startedAt = new Date();

    // Дедуп по (чат, id сообщения): одно и то же сообщение почти всегда
    // попадает под несколько запросов сразу («Тбилиси» и «виза D»), и без
    // склейки дайджест наполовину состоит из повторов.
    const hits = new Map<string, ResearchHit>();
    const stats: QueryStat[] = [];
    const minDate =
      sinceDays > 0 ? Math.floor(Date.now() / 1000) - sinceDays * 86_400 : 0;

    try {
      for (const chatRef of chats) {
        let chat: ResolvedChat;
        try {
          chat = await this.resolveChat(chatRef);
        } catch (err) {
          this.logger.error(`Чат ${chatRef}: не открылся — ${describeError(err)}`);
          stats.push({ query: `(чат ${chatRef})`, found: 0, error: describeError(err) });
          continue;
        }

        for (const [index, query] of queries.entries()) {
          if (index > 0) await sleepJitter(this.config.delayBetweenQueriesSec * 1000);
          const stat = await this.searchOne(chat, query, perQueryLimit, minDate, hits);
          stats.push(stat);
        }
      }
    } finally {
      this.running = false;
    }

    const ordered = [...hits.values()].sort((a, b) => b.date - a.date);

    const result: ResearchResult = {
      chats,
      queries: stats,
      hits: ordered,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      sinceDays,
    };

    const file = writeDigest(
      this.config.dir,
      digestFileName(startedAt),
      formatDigest(result),
    );

    const summary: ResearchRunSummary = { ...result, file };
    this.lastSummary = summary;

    this.logger.log(`Поиск завершён: находок ${ordered.length}, файл ${file ?? '—'}`);
    return summary;
  }

  /**
   * Поиск идёт на стороне Telegram (messages.Search через iterMessages
   * search), а не выкачиванием истории с локальным grep. В живом чате на
   * десятки тысяч сообщений выкачивание — это сотни запросов и гарантированный
   * FloodWait ради того же результата.
   */
  private async searchOne(
    chat: ResolvedChat,
    query: string,
    limit: number,
    minDate: number,
    sink: Map<string, ResearchHit>,
  ): Promise<QueryStat> {
    let found = 0;

    try {
      const client = this.telegram.getClient();
      for await (const message of client.iterMessages(chat.entity, {
        search: query,
        limit,
      })) {
        const text = (message.message ?? '').trim();
        if (text.length < this.config.minTextLength) continue;

        const date = Number(message.date ?? 0);
        // Поиск отдаёт от новых к старым: дошли до отсечки — дальше только старее.
        if (minDate > 0 && date > 0 && date < minDate) break;

        const key = `${chat.ref}:${message.id}`;
        const existing = sink.get(key);
        if (existing) {
          if (!existing.matchedQueries.includes(query))
            existing.matchedQueries.push(query);
          found += 1;
          continue;
        }

        sink.set(key, {
          chatRef: chat.ref,
          chatTitle: chat.title,
          messageId: message.id,
          date,
          author: await this.describeSender(message),
          text,
          link: messageLink(chat.username, message.id),
          matchedQueries: [query],
          replyToText: this.config.withContext
            ? await this.fetchReplyText(message)
            : null,
        });
        found += 1;
      }
    } catch (err) {
      const reason =
        err instanceof FloodWaitError
          ? `FloodWait ${err.seconds}s — Telegram просит притормозить`
          : describeError(err);
      this.logger.warn(`Запрос «${query}»: прерван — ${reason}`);
      return { query, found, error: reason };
    }

    return { query, found };
  }

  /** Имя автора. Ошибку глотаем: без ника находка всё ещё полезна. */
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

  private async fetchReplyText(message: Api.Message): Promise<string | null> {
    try {
      const parent = await message.getReplyMessage();
      const text = (parent?.message ?? '').trim();
      return text.length > 0 ? text : null;
    } catch {
      return null;
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

/** Ссылка только для публичных чатов: у приватных t.me/c/ требует членства и id. */
export function messageLink(username: string | null, messageId: number): string | null {
  return username ? `https://t.me/${username}/${messageId}` : null;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
