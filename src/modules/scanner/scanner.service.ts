import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Api, utils } from 'telegram';
import type { Entity } from 'telegram/define';
import { NewMessage, NewMessageEvent } from 'telegram/events';
import { FloodWaitError } from 'telegram/errors';
import { AdDetector } from '@modules/scanner/ad-detector';
import { ScanStateEntity } from '@modules/scanner/scan-state.entity';
import { ScannerConfig } from '@modules/scanner/scanner.config';
import { LeadService } from '@modules/lead/lead.service';
import { TelegramClientService } from '@modules/telegram/telegram-client.service';
import { sleepJitter } from '@common/utils/sleep';

export interface ChatScanResult {
  chat: string;
  title: string | null;
  messagesSeen: number;
  leadsCreated: number;
  leadsUpdated: number;
  adsFound: number;
  lastMessageId: string;
  error?: string;
}

export interface ScanSummary {
  startedAt: string;
  finishedAt: string;
  chats: ChatScanResult[];
  totals: {
    messagesSeen: number;
    leadsCreated: number;
    leadsUpdated: number;
    adsFound: number;
  };
}

interface ResolvedChat {
  ref: string;
  entity: Entity;
  peerId: string;
  title: string | null;
}

/** Что случилось с одним сообщением. */
interface MessageOutcome {
  saved: 'created' | 'updated' | 'skipped';
  isAd: boolean;
}

@Injectable()
export class ScannerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ScannerService.name);

  private readonly detector: AdDetector;

  /** Разрешённые сущности чатов, чтобы не дёргать resolve на каждый проход. */
  private readonly chatCache = new Map<string, ResolvedChat>();

  /** peerId → ref. Нужен live-слушателю: у апдейта есть id, а не @имя. */
  private readonly peerToRef = new Map<string, ResolvedChat>();

  /**
   * Один проход за раз. Тот же урок, что с крон-тиками в TeachTrack:
   * два одновременных скана одного чата — это двойные запросы к Telegram
   * (то есть FloodWait) и задвоенные счётчики сообщений у лидов.
   */
  private running = false;

  private timer: NodeJS.Timeout | null = null;

  /** Итог последнего прохода — чтобы GET /scan/status было что показать. */
  private lastSummary: ScanSummary | null = null;

  private liveHandler: ((event: NewMessageEvent) => Promise<void>) | null = null;

  constructor(
    private readonly config: ScannerConfig,
    private readonly telegram: TelegramClientService,
    private readonly leads: LeadService,
    @InjectRepository(ScanStateEntity)
    private readonly stateRepo: Repository<ScanStateEntity>,
  ) {
    this.detector = new AdDetector({
      minScore: this.config.adMinScore,
      extraKeywords: this.config.adExtraKeywords,
      extraStopWords: this.config.adExtraStopWords,
    });
  }

  public async onModuleInit(): Promise<void> {
    if (this.config.chats.length === 0) {
      this.logger.warn('SCAN_CHATS пуст — сканировать нечего. Заполни .env');
      return;
    }

    this.logger.log(`Чаты в работе: ${this.config.chats.join(', ')}`);

    if (this.config.listenEnabled) {
      await this.startListening();
    }

    if (this.config.intervalMinutes > 0) {
      const ms = this.config.intervalMinutes * 60_000;
      this.timer = setInterval(() => {
        void this.runAll().catch((err) => {
          this.logger.error(`Периодический скан упал: ${String(err)}`);
        });
      }, ms);
      this.logger.log(`Периодический скан каждые ${this.config.intervalMinutes} мин`);
    }

    if (this.config.scanOnStart) {
      // Намеренно не await: старт приложения не должен ждать полный проход
      // по истории. Ошибку ловим здесь же, чтобы не словить
      // unhandledRejection и не уронить процесс.
      void this.runAll().catch((err) => {
        this.logger.error(`Стартовый скан упал: ${String(err)}`);
      });
    }
  }

  public onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.liveHandler) {
      this.telegram.getClient().removeEventHandler(this.liveHandler, new NewMessage({}));
      this.liveHandler = null;
    }
  }

  public isRunning(): boolean {
    return this.running;
  }

  public getLastSummary(): ScanSummary | null {
    return this.lastSummary;
  }

  /**
   * Запуск в фоне: полный проход по большому чату идёт минуты, держать на
   * нём HTTP-соединение незачем. За результатом — GET /scan/status.
   */
  public startInBackground(): { started: boolean; reason?: string } {
    if (this.running) return { started: false, reason: 'Скан уже идёт' };
    if (this.config.chats.length === 0) {
      return { started: false, reason: 'SCAN_CHATS пуст' };
    }

    void this.runAll().catch((err) => {
      this.logger.error(`Скан упал: ${describeError(err)}`);
    });

    return { started: true };
  }

  public async runAll(): Promise<ScanSummary> {
    if (this.running) {
      throw new Error('Скан уже идёт — дождись окончания');
    }
    this.running = true;
    const startedAt = new Date();
    const results: ChatScanResult[] = [];

    try {
      for (const [index, chatRef] of this.config.chats.entries()) {
        // Пауза между чатами со случайным разбросом. Ровный ритм запросов —
        // самый заметный признак бота; да и FloodWait ловить не хочется.
        if (index > 0) {
          await sleepJitter(this.config.delayBetweenChatsSec * 1000);
        }
        results.push(await this.scanChat(chatRef));
      }
    } finally {
      this.running = false;
    }

    const summary: ScanSummary = {
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      chats: results,
      totals: {
        messagesSeen: sum(results, (r) => r.messagesSeen),
        leadsCreated: sum(results, (r) => r.leadsCreated),
        leadsUpdated: sum(results, (r) => r.leadsUpdated),
        adsFound: sum(results, (r) => r.adsFound),
      },
    };

    this.lastSummary = summary;

    this.logger.log(
      `Скан завершён: сообщений ${summary.totals.messagesSeen}, ` +
        `новых лидов ${summary.totals.leadsCreated}, ` +
        `обновлено ${summary.totals.leadsUpdated}`,
    );

    return summary;
  }

  public async scanChat(chatRef: string): Promise<ChatScanResult> {
    const state = await this.getOrCreateState(chatRef);

    let chat: ResolvedChat;
    try {
      chat = await this.resolveChat(chatRef);
    } catch (err) {
      const message = describeError(err);
      this.logger.error(`Чат ${chatRef}: не удалось открыть — ${message}`);
      await this.stateRepo.update({ id: state.id }, { lastError: message });
      return emptyResult(chatRef, state.lastMessageId, message);
    }

    state.chatId = chat.peerId;
    state.chatTitle = chat.title;

    const cursor = toNumber(state.lastMessageId);
    const isFirstRun = cursor <= 0;

    // Первый проход — последние N сообщений (новые → старые). Идти от начала
    // истории бессмысленно: в живом чате её сотни тысяч, а объявления
    // трёхлетней давности уже никому не нужны.
    // Дальше — только новее курсора, в прямом порядке (reverse: true).
    const iterParams = isFirstRun
      ? {
          limit: this.config.initialLimit,
          waitTime: this.config.waitTimeSec,
        }
      : {
          reverse: true,
          offsetId: cursor,
          limit: this.config.maxMessagesPerRun,
          waitTime: this.config.waitTimeSec,
        };

    const result: ChatScanResult = {
      chat: chatRef,
      title: chat.title,
      messagesSeen: 0,
      leadsCreated: 0,
      leadsUpdated: 0,
      adsFound: 0,
      lastMessageId: state.lastMessageId,
    };

    let maxId = cursor;
    const cap = isFirstRun ? this.config.initialLimit : this.config.maxMessagesPerRun;

    try {
      const client = this.telegram.getClient();
      for await (const message of client.iterMessages(chat.entity, iterParams)) {
        result.messagesSeen += 1;
        if (message.id > maxId) maxId = message.id;

        const outcome = await this.handleMessage(message, chat);
        if (outcome.saved === 'created') result.leadsCreated += 1;
        if (outcome.saved === 'updated') result.leadsUpdated += 1;
        if (outcome.isAd) result.adsFound += 1;

        if (result.messagesSeen >= cap) break;
      }
      state.lastError = null;
    } catch (err) {
      const message =
        err instanceof FloodWaitError
          ? `FloodWait ${err.seconds}s — Telegram просит притормозить`
          : describeError(err);
      this.logger.warn(`Чат ${chatRef}: скан прерван — ${message}`);
      result.error = message;
      state.lastError = message;
    }

    // Курсор двигаем даже при обрыве: то, что успели прочитать, перечитывать
    // незачем. Цена — при падении в середине первого прохода часть старой
    // истории останется непросмотренной; лечится ручным сбросом курсора
    // (DELETE FROM tg_scan_state WHERE chat_ref = '...').
    state.lastMessageId = String(maxId);
    state.lastScanAt = new Date();
    state.totalMessagesSeen = String(
      toNumber(state.totalMessagesSeen) + result.messagesSeen,
    );
    await this.stateRepo.save(state);

    result.lastMessageId = state.lastMessageId;

    this.logger.log(
      `Чат ${chatRef} (${chat.title ?? '—'}): сообщений ${result.messagesSeen}, ` +
        `рекламных ${result.adsFound}, новых лидов ${result.leadsCreated}`,
    );

    return result;
  }

  /**
   * Live-режим: складываем лидов по мере появления сообщений. Отдельный
   * канал от исторического скана — они спокойно уживаются, дедуп всё равно
   * в уникальном индексе базы.
   */
  private async startListening(): Promise<void> {
    for (const chatRef of this.config.chats) {
      try {
        await this.resolveChat(chatRef);
      } catch (err) {
        this.logger.error(`Live: чат ${chatRef} недоступен — ${describeError(err)}`);
      }
    }

    if (this.peerToRef.size === 0) {
      this.logger.warn('Live-режим не запущен: ни один чат не открылся');
      return;
    }

    // Фильтруем чаты руками, а не через `new NewMessage({ chats })`:
    // тот вариант резолвит сущности внутри себя и молча отваливается,
    // если хоть одна не открылась.
    this.liveHandler = async (event: NewMessageEvent): Promise<void> => {
      try {
        const peerId = event.message?.chatId?.toString();
        if (!peerId) return;
        const chat = this.peerToRef.get(peerId);
        if (!chat) return;

        const outcome = await this.handleMessage(event.message, chat);
        if (outcome.saved === 'created') {
          this.logger.log(`Live: новый лид из ${chat.ref}`);
        }
      } catch (err) {
        // Ошибка обработки одного сообщения не должна убивать слушателя.
        this.logger.warn(`Live: сообщение не обработано — ${describeError(err)}`);
      }
    };

    this.telegram.getClient().addEventHandler(this.liveHandler, new NewMessage({}));
    this.logger.log(`Live-режим включён для ${this.peerToRef.size} чат(ов)`);
  }

  private async handleMessage(
    message: Api.Message,
    chat: ResolvedChat,
  ): Promise<MessageOutcome> {
    const skipped: MessageOutcome = { saved: 'skipped', isAd: false };

    const sender = message.sender;
    // Не Api.User — это пост от имени канала или анонимный админ.
    // Писать такому «человеку» некуда.
    if (!(sender instanceof Api.User)) return skipped;
    if (sender.bot || sender.deleted || sender.self) return skipped;
    if (sender.id.toString() === this.telegram.getMyId()) return skipped;

    const text = message.message ?? '';
    if (text.trim().length === 0) return skipped;

    const detection = this.detector.detect(text);
    if (!detection.isAd && !this.config.saveNonAdAuthors) {
      return { saved: 'skipped', isAd: false };
    }

    const { created } = await this.leads.upsert({
      tgUserId: sender.id.toString(),
      username: sender.username ?? null,
      firstName: sender.firstName ?? null,
      lastName: sender.lastName ?? null,
      phone: sender.phone ?? null,
      isPremium: sender.premium === true,
      langCode: sender.langCode ?? null,
      sourceChat: chat.ref,
      sourceChatTitle: chat.title,
      messageId: String(message.id),
      // date у Telegram в секундах, у JS — в миллисекундах. Без ×1000
      // все лиды оказываются в январе 1970-го.
      messageDate: new Date(message.date * 1000),
      isAd: detection.isAd,
      score: detection.score,
      keywords: detection.keywords,
      sampleText:
        this.config.sampleTextLimit > 0
          ? text.slice(0, this.config.sampleTextLimit)
          : null,
    });

    return { saved: created ? 'created' : 'updated', isAd: detection.isAd };
  }

  private async resolveChat(chatRef: string): Promise<ResolvedChat> {
    const cached = this.chatCache.get(chatRef);
    if (cached) return cached;

    const entity = await this.telegram.getClient().getEntity(chatRef);
    // getPeerId отдаёт «помеченный» id (-100… для супергрупп) — ровно в
    // таком виде он приходит и в message.chatId, так что сравнивать можно
    // напрямую.
    const peerId = utils.getPeerId(entity);
    const title =
      'title' in entity ? ((entity as { title?: string }).title ?? null) : null;

    const resolved: ResolvedChat = { ref: chatRef, entity, peerId, title };
    this.chatCache.set(chatRef, resolved);
    this.peerToRef.set(peerId, resolved);

    return resolved;
  }

  private async getOrCreateState(chatRef: string): Promise<ScanStateEntity> {
    const existing = await this.stateRepo.findOneBy({ chatRef });
    if (existing) return existing;

    const created = this.stateRepo.create({
      chatRef,
      lastMessageId: '0',
      totalMessagesSeen: '0',
    });
    return this.stateRepo.save(created);
  }

  public listStates(): Promise<ScanStateEntity[]> {
    return this.stateRepo.find({ order: { chatRef: 'ASC' } });
  }
}

function sum<T>(items: T[], pick: (item: T) => number): number {
  return items.reduce((acc, item) => acc + pick(item), 0);
}

function toNumber(value: string | number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function emptyResult(chat: string, lastMessageId: string, error: string): ChatScanResult {
  return {
    chat,
    title: null,
    messagesSeen: 0,
    leadsCreated: 0,
    leadsUpdated: 0,
    adsFound: 0,
    lastMessageId,
    error,
  };
}
