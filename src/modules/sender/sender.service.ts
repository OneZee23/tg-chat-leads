import { Injectable, Logger } from '@nestjs/common';
import { FloodWaitError } from 'telegram/errors';
import { sleepJitter } from '@common/utils/sleep';
import { LeadEntity } from '@modules/lead/lead.entity';
import { LeadService } from '@modules/lead/lead.service';
import { loadMessageContent, MessageContent } from '@modules/sender/message-content';
import { SenderConfig } from '@modules/sender/sender.config';
import { TelegramClientService } from '@modules/telegram/telegram-client.service';

export interface SendReport {
  dryRun: boolean;
  attempted: number;
  sent: number;
  failed: number;
  stoppedBecause: string;
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
  ) {}

  public isRunning(): boolean {
    return this.running;
  }

  public async run(limitOverride?: number): Promise<SendReport> {
    if (this.running) throw new Error('Рассылка уже идёт');

    const content = loadMessageContent(this.config.contentDir);
    const limit = Math.min(limitOverride ?? this.config.maxPerRun, this.config.maxPerRun);

    const report: SendReport = {
      dryRun: this.config.dryRun,
      attempted: 0,
      sent: 0,
      failed: 0,
      stoppedBecause: 'очередь закончилась',
      entries: [],
    };

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

        try {
          await this.sendTo(lead, content);
          await this.leads.finishSending(lead.id, 'contacted', 'отправлено рассылкой');
          report.sent += 1;
          report.entries.push({ username: lead.username, result: 'sent' });
          consecutiveErrors = 0;
          this.logger.log(
            `Отправлено @${lead.username} (${report.sent}/${targets.length})`,
          );
        } catch (err) {
          const message = describeError(err);
          await this.leads.finishSending(
            lead.id,
            'failed',
            `ошибка отправки: ${message}`,
          );
          report.failed += 1;
          report.entries.push({
            username: lead.username,
            result: 'failed',
            error: message,
          });
          consecutiveErrors += 1;
          this.logger.warn(`Не отправлено @${lead.username}: ${message}`);

          if (isFatal(err)) {
            report.stoppedBecause = `аккаунт ограничен: ${message}`;
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

      if (report.attempted >= limit && report.stoppedBecause === 'очередь закончилась') {
        report.stoppedBecause = `упёрлись в лимит запуска (${limit})`;
      }
    } finally {
      this.running = false;
    }

    return report;
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

  /** Вернуть невзятых в очередь, чтобы они не зависли в `sending`. */
  private async releaseRest(targets: LeadEntity[], from: number): Promise<void> {
    for (const lead of targets.slice(from)) {
      await this.leads.finishSending(
        lead.id,
        'failed',
        'не дошла очередь: рассылка остановлена',
      );
    }
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
