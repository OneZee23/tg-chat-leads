import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { FloodWaitTracker } from '@modules/telegram/flood-wait.tracker';
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

  constructor(
    private readonly config: TelegramConfig,
    private readonly floodTracker: FloodWaitTracker,
  ) {}

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

    this.wrapInvoke(client);

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

  /**
   * Клиент или null, без исключения.
   *
   * Нужен на остановке приложения: Nest гасит модули в порядке
   * инициализации, а TelegramModule инициализируется раньше тех, кто его
   * импортирует. Значит в их onModuleDestroy клиента уже нет, и обычный
   * getClient() кидает ошибку прямо в процессе штатного выключения.
   */
  public tryGetClient(): TelegramClient | null {
    return this.client;
  }

  public getMyId(): string | null {
    return this.me ? this.me.id.toString() : null;
  }

  /**
   * Единая точка перехвата FloodWait. Все запросы GramJS проходят через
   * client.invoke, поэтому оборачиваем именно его: любой лимит попадает в
   * трекер, не трогая десятки мест, где мы ловим ошибки. Короткие FloodWait,
   * которые GramJS пересиживает сам (ниже floodSleepThreshold), сюда как
   * исключение не долетают — и хорошо, их учитывать не нужно.
   */
  private wrapInvoke(client: TelegramClient): void {
    const original = client.invoke.bind(client);
    (client as unknown as { invoke: typeof client.invoke }).invoke = async (request) => {
      try {
        return await original(request);
      } catch (err) {
        this.floodTracker.record(err);
        throw err;
      }
    };
  }
}

export function describeUser(user: Api.User): string {
  if (user.username) return `@${user.username}`;
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ');
  return name || `id${user.id.toString()}`;
}
