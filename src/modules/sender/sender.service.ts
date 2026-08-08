import { Injectable, Logger } from '@nestjs/common';
import { FloodWaitError } from 'telegram/errors';
import { sleepJitter } from '@common/utils/sleep';
import { AccountService } from '@modules/account/account.service';
import { LeadEntity } from '@modules/lead/lead.entity';
import { LeadService } from '@modules/lead/lead.service';
import { loadMessageContent, MessageContent } from '@modules/sender/message-content';
import { SendAttemptService } from '@modules/sender/send-attempt.service';
import { SenderConfig } from '@modules/sender/sender.config';
import { TelegramClientService } from '@modules/telegram/telegram-client.service';

export interface SendReport {
  dryRun: boolean;
  attempted: number;
  sent: number;
  failed: number;
  stoppedBecause: string;
  dailyBudget: { limit: number; used: number; remaining: number };
  entries: Array<{
    username: string;
    result: 'sent' | 'dry-run' | 'failed';
    error?: string;
  }>;
}

/**
 * Ошибки, после которых продолжать нельзя ни при каких обстоятельствах.
 * PEER_FLOOD означает, что аккаунт уже ограничен за рассылку незнакомцам:
 * каждое следующее сообщение только утяжеляет ограничение.
 */
const FATAL_ERRORS = [
  'PEER_FLOOD',
  'USER_BANNED_IN_CHANNEL',
  'AUTH_KEY',
  'SESSION_REVOKED',
];

@Injectable()
export class SenderService {
  private readonly logger = new Logger(SenderService.name);

  private running = false;

  constructor(
    private readonly config: SenderConfig,
    private readonly telegram: TelegramClientService,
    private readonly leads: LeadService,
    private readonly attempts: SendAttemptService,
    private readonly account: AccountService,
  ) {}

  public isRunning(): boolean {
    return this.running;
  }

  public async run(limitOverride?: number): Promise<SendReport> {
    if (this.running) throw new Error('Рассылка уже идёт');

    const content = loadMessageContent(this.config.contentDir);
    // Явный limit из команды главнее SEND_MAX_PER_RUN: ты набираешь это
    // число руками на каждый запуск. Суточный бюджет — другое дело,
    // он обойти не даёт, в том числе и явным числом.
    const requested = limitOverride ?? this.config.maxPerRun;
    const budget = await this.attempts.budget(this.config.maxPerDay);

    const report: SendReport = {
      dryRun: this.config.dryRun,
      attempted: 0,
      sent: 0,
      failed: 0,
      stoppedBecause: 'очередь закончилась',
      dailyBudget: {
        limit: budget.limit,
        used: budget.used,
        remaining: budget.remaining,
      },
      entries: [],
    };

    if (!this.config.dryRun) {
      const blocked = await this.blockReason(budget.remaining);
      if (blocked) {
        report.stoppedBecause = blocked;
        return report;
      }
    }

    // Бюджет режет запрошенное число, и об этом честно пишем в отчёте —
    // молча урезать значит соврать о том, сколько людей получит письмо.
    const limit = this.config.dryRun ? requested : Math.min(requested, budget.remaining);

    this.running = true;
    try {
      // В dry-run лидов не занимаем: статусы должны остаться нетронутыми,
      // иначе «просто посмотреть» молча выведет людей из очереди.
      const targets = this.config.dryRun
        ? (await this.leads.findForOutreach(limit)).items
        : await this.leads.claimForSending(limit);

      let consecutiveErrors = 0;

      for (const [index, lead] of targets.entries()) {
        report.attempted += 1;

        if (this.config.dryRun) {
          report.entries.push({ username: lead.username, result: 'dry-run' });
          continue;
        }

        const outcome = await this.deliver(lead, content);

        if (outcome.ok) {
          report.sent += 1;
          report.entries.push({ username: lead.username, result: 'sent' });
          consecutiveErrors = 0;
          this.logger.log(
            `Отправлено @${lead.username} (${report.sent}/${targets.length})`,
          );
        } else {
          report.failed += 1;
          report.entries.push({
            username: lead.username,
            result: 'failed',
            error: outcome.error,
          });
          consecutiveErrors += 1;
          this.logger.warn(`Не отправлено @${lead.username}: ${outcome.error}`);

          if (outcome.fatal) {
            report.stoppedBecause = `аккаунт ограничен: ${outcome.error}`;
            // Ограничение уже наступило — сбрасываем кеш статуса, чтобы
            // следующий запуск спросил @SpamBot, а не поверил старому «ок».
            await this.account.status(true).catch(() => undefined);
            await this.releaseRest(targets, index + 1);
            break;
          }
          if (consecutiveErrors >= this.config.maxConsecutiveErrors) {
            report.stoppedBecause = `${consecutiveErrors} ошибки подряд — останавливаюсь`;
            await this.releaseRest(targets, index + 1);
            break;
          }
        }

        if (index < targets.length - 1) {
          await sleepJitter(this.config.delaySec * 1000);
        }
      }

      if (report.stoppedBecause === 'очередь закончилась' && report.attempted >= limit) {
        report.stoppedBecause =
          limit < requested
            ? `суточный бюджет: осталось ${budget.remaining} из ${budget.limit}`
            : `упёрлись в лимит запуска (${limit})`;
      }
    } finally {
      this.running = false;
    }

    const after = await this.attempts.budget(this.config.maxPerDay);
    report.dailyBudget = {
      limit: after.limit,
      used: after.used,
      remaining: after.remaining,
    };

    return report;
  }

  /** Ровно одно сообщение — режим расписания. */
  public async sendOne(): Promise<SendReport> {
    return this.run(1);
  }

  /** Почему отправлять нельзя прямо сейчас. null — можно. */
  private async blockReason(remaining: number): Promise<string | null> {
    if (remaining <= 0) {
      return `суточный бюджет исчерпан (${this.config.maxPerDay} за 24 часа)`;
    }

    try {
      const status = await this.account.status();
      if (!status.canSend) return status.reason;
    } catch (err) {
      // Не смогли спросить @SpamBot — это не повод останавливать работу,
      // но и молчать нельзя: человек должен видеть, что предохранитель
      // в этот раз не сработал.
      this.logger.warn(`Не удалось проверить статус аккаунта: ${describeError(err)}`);
    }

    return null;
  }

  private async deliver(
    lead: LeadEntity,
    content: MessageContent,
  ): Promise<{ ok: boolean; error?: string; fatal?: boolean }> {
    // Журнал пишем ДО обращения к Telegram: если процесс умрёт в этот
    // момент, останется строка `started` без исхода — прямое указание
    // проверить диалог руками, а не гадать.
    const attemptId = await this.attempts.start(lead);

    try {
      await this.sendTo(lead, content);
    } catch (err) {
      const error = describeError(err);
      await this.safeFinishAttempt(attemptId, 'failed', error);
      await this.safeFinishLead(lead, 'failed', `ошибка отправки: ${error}`);
      return { ok: false, error, fatal: isFatal(err) };
    }

    // Отправка удалась. Дальше только запись в базу, и её сбой не имеет
    // права выдать отправленное за неотправленное.
    await this.safeFinishAttempt(attemptId, 'sent');
    await this.safeFinishLead(lead, 'contacted', 'отправлено рассылкой');
    return { ok: true };
  }

  private async safeFinishAttempt(
    id: string,
    result: 'sent' | 'failed',
    error?: string,
  ): Promise<void> {
    try {
      await this.attempts.finish(id, result, error);
    } catch (err) {
      this.logger.error(`Не удалось закрыть попытку ${id}: ${describeError(err)}`);
    }
  }

  private async safeFinishLead(
    lead: LeadEntity,
    outcome: 'contacted' | 'failed',
    note: string,
  ): Promise<void> {
    try {
      await this.leads.finishSending(lead.id, outcome, note);
    } catch (err) {
      this.logger.error(
        `НЕ УДАЛОСЬ ОТМЕТИТЬ @${lead.username} как ${outcome}: ${describeError(err)}. ` +
          `Отметь вручную: yarn wrote @${lead.username}`,
      );
    }
  }

  private async sendTo(lead: LeadEntity, content: MessageContent): Promise<void> {
    const client = this.telegram.getClient();
    const peer = await client.getEntity(`@${lead.username}`);

    if (content.images.length === 0) {
      await client.sendMessage(peer, { message: content.text });
      return;
    }

    if (content.captionFits) {
      await client.sendFile(peer, { file: content.images, caption: content.text });
      return;
    }

    // Текст не влезает в подпись — шлём альбом, следом текст. Порядок
    // такой, чтобы человек сначала увидел скриншоты: без них длинная
    // простыня читается как реклама.
    await client.sendFile(peer, { file: content.images });
    await client.sendMessage(peer, { message: content.text });
  }

  /**
   * Вернуть в очередь тех, до кого не дошли. Им ничего не отправлялось,
   * поэтому `new`, а не `failed` — иначе при первом же PEER_FLOOD хвост
   * пачки молча выпадет из работы.
   */
  private async releaseRest(targets: LeadEntity[], from: number): Promise<number> {
    return this.leads.releaseToQueue(targets.slice(from).map((lead) => lead.id));
  }
}

function isFatal(err: unknown): boolean {
  if (err instanceof FloodWaitError) return err.seconds > 300;
  const message = describeError(err).toUpperCase();
  return FATAL_ERRORS.some((code) => message.includes(code));
}

function describeError(err: unknown): string {
  if (err instanceof FloodWaitError) return `FloodWait ${err.seconds}s`;
  if (err instanceof Error) return err.message;
  return String(err);
}
