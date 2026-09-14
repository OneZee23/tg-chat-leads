import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { FloodWaitTracker } from '@modules/telegram/flood-wait.tracker';
import { TelegramConfig } from '@modules/telegram/telegram.config';
import {
  describeUser,
  TelegramClientService,
} from '@modules/telegram/telegram-client.service';

/**
 * Имена аккаунтов фиксированные, а не произвольные из env.
 *
 * Имя уезжает в базу (`tg_send_attempt.account`, `tg_lead.assigned_account`)
 * и живёт там годами. Если позволить задавать его переменной окружения,
 * однажды строка в базе и строка в конфиге разойдутся, а сверить их будет
 * нечем: по записи «писал аккаунт xyz» уже не понять, какой это номер.
 */
export const ACCOUNT_MAIN = 'main';
export const ACCOUNT_SECOND = 'second';

export type AccountName = typeof ACCOUNT_MAIN | typeof ACCOUNT_SECOND;

export interface TelegramAccount {
  name: AccountName;
  client: TelegramClient;
  /** id самого аккаунта — чтобы отличать свои сообщения от чужих. */
  selfId: string;
  title: string;
}

/**
 * Пул телеграм-аккаунтов.
 *
 * Дизайн: docs/superpowers/specs/2026-09-14-multi-account-design.md
 *
 * Telegram пускает примерно 40–50 сообщений в сутки новым людям. Это
 * потолок платформы, и обойти его нельзя — можно только добавить второй
 * аккаунт, у каждого со своим темпом.
 *
 * ВАЖНО: несколько клиентов живут в ОДНОМ процессе, и у каждого своя
 * строка сессии. Второй экземпляр приложения на той же сессии однажды
 * убил аккаунт (07.09.2026) — поэтому именно так, а не запуском копии
 * лидгена с другим .env.
 *
 * Основной аккаунт переиспользует уже поднятый TelegramClientService:
 * им читают чаты сканер, ресерч и статус, и второго подключения к той же
 * сессии быть не должно.
 */
@Injectable()
export class TelegramAccountsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramAccountsService.name);

  /** Только дополнительные — основной берётся из TelegramClientService. */
  private extra: TelegramAccount[] = [];

  constructor(
    private readonly config: TelegramConfig,
    private readonly floodTracker: FloodWaitTracker,
    private readonly main: TelegramClientService,
  ) {}

  public async onModuleInit(): Promise<void> {
    const session2 = this.config.session2?.trim();
    if (!session2) {
      this.logger.log('Второй аккаунт не задан — работаем с одним (TG_SESSION_2 пуст)');
      return;
    }

    const client = new TelegramClient(
      new StringSession(session2),
      this.config.apiId,
      this.config.apiHash,
      {
        connectionRetries: 5,
        floodSleepThreshold: this.config.floodSleepThreshold,
        baseLogger: undefined,
      },
    );

    this.wrapInvoke(client, ACCOUNT_SECOND);
    await client.connect();

    if (!(await client.checkAuthorization())) {
      await client.destroy().catch(() => undefined);
      // Падаем, а не работаем с одним аккаунтом молча: человек выставил
      // TG_SESSION_2 намеренно, и тихий откат к одному он заметит только
      // через неделю по недобранной статистике.
      throw new Error(
        'TG_SESSION_2 не авторизована. Пересоздай: `yarn session:create` под вторым номером.',
      );
    }

    const me = await client.getMe();
    const selfId = me.id.toString();

    if (selfId === this.main.getMyId()) {
      await client.destroy().catch(() => undefined);
      // Одна и та же сессия в двух переменных — это два клиента на один
      // аккаунт, то есть ровно тот случай, который убил сессию в сентябре.
      throw new Error(
        'TG_SESSION_2 принадлежит тому же аккаунту, что и TG_SESSION. Нужен второй номер.',
      );
    }

    this.extra.push({
      name: ACCOUNT_SECOND,
      client,
      selfId,
      title: describeUser(me),
    });

    this.logger.log(`Второй аккаунт подключён: ${describeUser(me)} (id=${selfId})`);
    await this.warnIfCold(client, describeUser(me));
  }

  public async onModuleDestroy(): Promise<void> {
    for (const account of this.extra) {
      await account.client.destroy().catch((err) => {
        this.logger.warn(`Не удалось отключить ${account.name}: ${String(err)}`);
      });
    }
    this.extra = [];
  }

  /** Все аккаунты, которыми можно писать. Основной всегда первый. */
  public list(): TelegramAccount[] {
    const mainClient = this.main.tryGetClient();
    const mainId = this.main.getMyId();
    if (!mainClient || !mainId) return [...this.extra];

    return [
      {
        name: ACCOUNT_MAIN,
        client: mainClient,
        selfId: mainId,
        title: this.main.getMyTitle() ?? ACCOUNT_MAIN,
      },
      ...this.extra,
    ];
  }

  public names(): AccountName[] {
    return this.list().map((a) => a.name);
  }

  /**
   * Аккаунт по имени. Нужен, когда лид уже закреплён: писать ему вторым
   * аккаунтом нельзя, даже если у первого кончился лимит — для человека
   * это выглядело бы как сообщение от постороннего с тем же текстом.
   */
  public get(name: string): TelegramAccount | null {
    return this.list().find((a) => a.name === name) ?? null;
  }

  public has(name: string): boolean {
    return this.get(name) !== null;
  }

  /**
   * Предупреждение о «холодном» аккаунте.
   *
   * Свежая симка без единого диалога, начинающая писать незнакомым
   * людям, попадает в спамблок за считанные часы. Не запрещаем — решает
   * владелец, — но говорим об этом до первой отправки, а не после бана.
   */
  private async warnIfCold(client: TelegramClient, title: string): Promise<void> {
    try {
      const dialogs = await client.getDialogs({ limit: 5 });
      if (dialogs.length < 3) {
        this.logger.warn(
          `Аккаунт ${title} почти пустой (${dialogs.length} диалогов). ` +
            'Свежие аккаунты банят быстрее всего — прогрей перепиской перед рассылкой.',
        );
      }
    } catch (err) {
      // Не смогли посмотреть диалоги — не повод не запускаться.
      this.logger.warn(`Не удалось оценить прогрев ${title}: ${String(err)}`);
    }
  }

  /**
   * Тот же перехват FloodWait, что у основного клиента, но с именем
   * аккаунта: лимит выдают аккаунту, и общий на двоих счётчик остановил бы
   * отправку с того, кого никто не зажимал.
   */
  private wrapInvoke(client: TelegramClient, account: AccountName): void {
    const original = client.invoke.bind(client);
    (client as unknown as { invoke: typeof client.invoke }).invoke = async (request) => {
      try {
        return await original(request);
      } catch (err) {
        this.floodTracker.record(err, account);
        throw err;
      }
    };
  }
}

/** Хелпер для тестов и логов: человекочитаемое имя аккаунта. */
export function accountLabel(name: string): string {
  return name === ACCOUNT_MAIN ? 'основной' : 'второй';
}

export type { Api };
