import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { TelegramConfig } from '@modules/telegram/telegram.config';
import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';

/**
 * Один MTProto-клиент на всё приложение. Работает от ЖИВОГО аккаунта
 * (userbot), а не от бота: боты не видят историю чатов, в которых состоят,
 * поэтому обычным Bot API эту задачу не решить.
 *
 * Сессия берётся готовой из TG_SESSION. Мы намеренно не логинимся по
 * телефону в рантайме: логин требует ввода кода, а сервис должен либо
 * подняться, либо честно упасть с понятным сообщением.
 */
@Injectable()
export class TelegramClientService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramClientService.name);

  private client: TelegramClient | null = null;

  private me: Api.User | null = null;

  constructor(private readonly config: TelegramConfig) {}

  public async onModuleInit(): Promise<void> {
    const client = new TelegramClient(
      new StringSession(this.config.session),
      this.config.apiId,
      this.config.apiHash,
      {
        connectionRetries: 5,
        // GramJS сам поспит и повторит запрос, если Telegram просит подождать
        // меньше этого порога. Всё что дольше — прилетает исключением, и
        // сканер честно останавливает чат вместо того чтобы долбиться.
        floodSleepThreshold: this.config.floodSleepThreshold,
        // Логи GramJS приглушены: на уровне debug он печатает каждый пакет.
        baseLogger: undefined,
      },
    );

    await client.connect();

    if (!(await client.checkAuthorization())) {
      await client.destroy().catch(() => undefined);
      throw new Error(
        'Telegram session is not authorized. Пересоздай её: `yarn session:create` и положи новую строку в TG_SESSION.',
      );
    }

    this.client = client;
    this.me = await client.getMe();

    this.logger.log(
      `Telegram connected as ${describeUser(this.me)} (id=${this.me.id.toString()})`,
    );
  }

  public async onModuleDestroy(): Promise<void> {
    if (!this.client) return;
    // destroy, а не disconnect: disconnect оставляет живые таймеры обновлений,
    // и процесс не завершается по Ctrl+C.
    await this.client.destroy().catch((err) => {
      this.logger.warn(`Telegram disconnect failed: ${String(err)}`);
    });
    this.client = null;
  }

  public getClient(): TelegramClient {
    if (!this.client) {
      throw new Error('Telegram client is not initialized yet');
    }
    return this.client;
  }

  public getMyId(): string | null {
    return this.me ? this.me.id.toString() : null;
  }
}

export function describeUser(user: Api.User): string {
  if (user.username) return `@${user.username}`;
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ');
  return name || `id${user.id.toString()}`;
}
