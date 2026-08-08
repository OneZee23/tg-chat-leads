import { Injectable, Logger } from '@nestjs/common';
import { Api } from 'telegram';
import { sleep } from '@common/utils/sleep';
import { AccountConfig } from '@modules/account/account.config';
import { parseSpamBotReply, SpamBotStatus } from '@modules/account/spambot-reply';
import { TelegramClientService } from '@modules/telegram/telegram-client.service';

export interface AccountStatus extends SpamBotStatus {
  checkedAt: Date;
  /** Можно ли сейчас писать незнакомцам. */
  canSend: boolean;
  reason: string;
}

const SPAM_BOT = '@SpamBot';

/**
 * Спрашивает у @SpamBot, не ограничен ли аккаунт.
 *
 * Смысл в одном: не запускать рассылку, пока ограничение висит. Именно
 * повторная попытка во время активного ограничения превращает его из
 * временного в длинное — бот предупреждает об этом прямым текстом.
 */
@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);

  private cached: AccountStatus | null = null;

  constructor(
    private readonly config: AccountConfig,
    private readonly telegram: TelegramClientService,
  ) {}

  public getCached(): AccountStatus | null {
    return this.cached;
  }

  /**
   * Свежий статус. Кеш живёт `ACCOUNT_CHECK_TTL_MIN` минут: дёргать
   * @SpamBot перед каждым сообщением — само по себе подозрительная
   * активность, да и ответ меняется редко.
   */
  public async status(force = false): Promise<AccountStatus> {
    const ttlMs = this.config.checkTtlMin * 60_000;
    const fresh = this.cached && Date.now() - this.cached.checkedAt.getTime() < ttlMs;

    if (fresh && !force) return this.cached;

    // Ограничение с известной датой окончания перепроверять не нужно —
    // достаточно посмотреть на часы, и это ноль запросов к Telegram.
    if (!force && this.cached?.limited && this.cached.until) {
      if (this.cached.until.getTime() > Date.now()) return this.cached;
    }

    const reply = await this.ask();
    const parsed = parseSpamBotReply(reply);
    this.cached = this.decide(parsed);

    this.logger.log(
      `Статус аккаунта: ${this.cached.canSend ? 'можно писать' : 'НЕЛЬЗЯ'} — ${this.cached.reason}`,
    );

    return this.cached;
  }

  private decide(parsed: SpamBotStatus): AccountStatus {
    const checkedAt = new Date();

    if (parsed.limited === false) {
      return { ...parsed, checkedAt, canSend: true, reason: 'ограничений нет' };
    }

    if (parsed.limited === true) {
      // Дата в прошлом означает, что ограничение уже истекло, а мы читаем
      // старое сообщение из переписки с ботом.
      if (parsed.until && parsed.until.getTime() <= Date.now()) {
        return {
          ...parsed,
          checkedAt,
          canSend: true,
          reason: `ограничение истекло ${parsed.until.toISOString()}`,
        };
      }
      const until = parsed.until ? parsed.until.toISOString() : 'срок не назван';
      return {
        ...parsed,
        checkedAt,
        canSend: false,
        reason: `аккаунт ограничен до ${until}`,
      };
    }

    // Ответ не разобрали. По умолчанию не пускаем: смысл этой проверки —
    // не дать запустить рассылку во время ограничения, и «не понял»
    // трактовать как «всё хорошо» означает выключить её молча.
    return {
      ...parsed,
      checkedAt,
      canSend: !this.config.blockOnUnknown,
      reason: this.config.blockOnUnknown
        ? 'ответ @SpamBot не разобран — на всякий случай не пускаю ' +
          '(снять: ACCOUNT_BLOCK_ON_UNKNOWN=false)'
        : 'ответ @SpamBot не разобран, но блокировка отключена конфигом',
    };
  }

  /** Пишет боту /start и ждёт входящий ответ. */
  private async ask(): Promise<string> {
    const client = this.telegram.getClient();
    const bot = await client.getEntity(SPAM_BOT);

    // Запоминаем последний id ДО отправки: иначе легко принять за ответ
    // старое сообщение из прошлой переписки с ботом.
    const before = await client.getMessages(bot, { limit: 1 });
    const lastId = before[0]?.id ?? 0;

    await client.sendMessage(bot, { message: '/start' });

    for (let attempt = 0; attempt < this.config.replyAttempts; attempt += 1) {
      await sleep(this.config.replyPollMs);

      const messages = await client.getMessages(bot, { limit: 5 });
      const reply = messages.find(
        (message: Api.Message) =>
          message.id > lastId &&
          message.out !== true &&
          (message.message ?? '').length > 0,
      );

      if (reply) return reply.message;
    }

    this.logger.warn('@SpamBot не ответил за отведённое время');
    return '';
  }
}
