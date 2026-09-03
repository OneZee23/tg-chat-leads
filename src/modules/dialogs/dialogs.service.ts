import { Injectable, Logger } from '@nestjs/common';
import { Api } from 'telegram';
import { sleep, sleepJitter } from '@common/utils/sleep';
import { DialogsConfig } from '@modules/dialogs/dialogs.config';
import { HistoryMessage, sliceUnanswered } from '@modules/dialogs/unanswered';
import { LeadService } from '@modules/lead/lead.service';
import { InboxDialog, InboxDump, InboxMessage } from '@modules/outreach/inbox.format';
import { OutboxSendEntry, OutboxSendResult } from '@modules/outreach/outbox.format';
import { OutboxEntry } from '@modules/outreach/outbox.parse';
import { autoReplyDecision } from '@modules/outreach/reply-draft';
import { AutoAction, ReplyKind } from '@modules/outreach/reply-draft';
import { ScannerConfig } from '@modules/scanner/scanner.config';
import { buildHook } from '@modules/sender/outreach-message';
import { TelegramClientService } from '@modules/telegram/telegram-client.service';

export interface AutoReplyEntry {
  username: string | null;
  tgUserId: string;
  kind: ReplyKind;
  reply: string;
  /** Что решено/сделано: отправить шаблон / закрыть без ответа / оставить тебе. */
  action: AutoAction;
  reason: string;
  result: 'preview' | 'sent' | 'cleared' | 'failed';
  error?: string;
}

export interface AutoReplyResult {
  dryRun: boolean;
  /** Отправлено (или «ушло бы» в dry-run). */
  sent: number;
  /** Закрыто без ответа (короткое нейтральное). */
  cleared: number;
  /** Оставлено тебе (вопрос / просьба / развёрнутый фидбек). */
  manual: number;
  stoppedBecause: string;
  entries: AutoReplyEntry[];
}

export interface DiscoveredChat {
  /** Готовая строка для SCAN_CHATS. */
  ref: string;
  title: string | null;
  id: string;
  username: string | null;
  type: 'group' | 'supergroup' | 'channel';
  participants: number | null;
  /** Уже стоит в SCAN_CHATS. */
  scanning: boolean;
}

export interface ContactedSyncResult {
  dialogsSeen: number;
  privateDialogs: number;
  /** Всего людей, кому ты когда-либо писал (по всем диалогам, не только лидам). */
  contactedTotal: number;
  /** Из них нашлись в собранной базе лидов и были переведены в contacted. */
  leadsMarked: number;
  /** Переведены в `replied`: ответили после нашего письма. */
  repliedMarked: number;
  deepChecks: number;
}

@Injectable()
export class DialogsService {
  private readonly logger = new Logger(DialogsService.name);

  constructor(
    private readonly config: DialogsConfig,
    private readonly scannerConfig: ScannerConfig,
    private readonly telegram: TelegramClientService,
    private readonly leads: LeadService,
  ) {}

  /**
   * Все групповые диалоги аккаунта — чтобы не выписывать @имена руками.
   * Ничего не сканирует: отдаёт список, из которого ты сам выбираешь.
   * В диалогах лежат и рабочие, и личные группы, автоматом туда лезть нельзя.
   */
  public async listChats(withCounts = false): Promise<DiscoveredChat[]> {
    const client = this.telegram.getClient();
    const found: DiscoveredChat[] = [];

    for await (const dialog of client.iterDialogs({ limit: this.config.limit })) {
      if (dialog.isUser) continue;

      const entity = dialog.entity;
      if (!(entity instanceof Api.Chat) && !(entity instanceof Api.Channel)) continue;

      const username = 'username' in entity ? (entity.username ?? null) : null;
      const id = entity.id.toString();

      found.push({
        // Ссылаться лучше по @имени: числовой id тоже работает, но по нему
        // не понять, что за чат, когда через месяц откроешь .env.
        ref: username ? `@${username}` : id,
        title: dialog.title ?? dialog.name ?? null,
        id,
        username,
        type: resolveType(entity),
        participants: await this.countParticipants(entity, withCounts),
        scanning: this.scannerConfig.chats.includes(username ? `@${username}` : id),
      });
    }

    // Большие чаты сверху: обычно именно они интересны, а мелкие рабочие
    // группы уходят вниз и не мешают выбирать.
    found.sort((a, b) => (b.participants ?? 0) - (a.participants ?? 0));

    this.logger.log(`Найдено групп и каналов в диалогах: ${found.length}`);
    return found;
  }

  /**
   * Помечает лидов, которым ты уже писал.
   *
   * Признак — наличие ТВОЕГО исходящего сообщения в личке с человеком.
   * Просто существование диалога не годится: человек мог написать первым,
   * а ты не ответить, и это не «уже связался».
   *
   * Важно: смотрим диалоги ТОГО аккаунта, под которым сейчас залогинены.
   * Если прошлый аутрич шёл с другого аккаунта — здесь будет пусто, и это
   * будет видно по contactedTotal.
   */
  public async syncContacted(): Promise<ContactedSyncResult> {
    const client = this.telegram.getClient();
    const contactedIds: string[] = [];
    const repliedIds: string[] = [];
    const result: ContactedSyncResult = {
      dialogsSeen: 0,
      privateDialogs: 0,
      contactedTotal: 0,
      leadsMarked: 0,
      repliedMarked: 0,
      deepChecks: 0,
    };

    // Кому уже писали и когда. Входящее сообщение считаем ответом только
    // если оно позже нашего письма — иначе в «ответившие» попадут те, кто
    // когда-то писал тебе по другому поводу.
    const contactedAt = await this.leads.getContactedAtMap();

    // Глубокая проверка стоит запрос к Telegram на каждый диалог, и на
    // трёх сотнях личных чатов это гарантированный FloodWait. При этом
    // 9 из 10 диалогов — друзья и родня, которых в базе лидов нет и
    // пометить всё равно некого. Поэтому лезем в историю только к тем,
    // кто реально ждёт своей очереди.
    const pending = await this.leads.getPendingTgIds();

    for await (const dialog of client.iterDialogs({ limit: this.config.limit })) {
      result.dialogsSeen += 1;
      if (!dialog.isUser) continue;

      const entity = dialog.entity;
      if (!(entity instanceof Api.User)) continue;
      if (entity.bot || entity.self) continue;

      result.privateDialogs += 1;
      const peerId = entity.id.toString();

      // Дешёвый путь: моё сообщение последнее. Для холодного аутрича без
      // ответа — самый частый случай, и он бесплатен.
      let iWrote = dialog.message?.out === true;

      if (!iWrote && this.config.deepCheck && pending.has(peerId)) {
        result.deepChecks += 1;
        iWrote = await this.hasOutgoing(entity);
        await sleep(this.config.deepDelayMs);
      }

      if (iWrote) {
        result.contactedTotal += 1;
        contactedIds.push(peerId);
      }

      // Ответ = последнее сообщение в диалоге входящее, и до него было наше.
      // Два источника доказательства «до него было наше»:
      //  • лид уже в статусе contacted — тогда сверяем время, чтобы старая
      //    переписка по другому поводу не сошла за ответ;
      //  • иначе глубокая проверка нашла исходящее в истории. Раз последнее
      //    сообщение входящее, значит человек написал после нас. Это ловит
      //    того, кто ответил на письмо рассылки в тот же день, за один проход.
      if (dialog.message?.out === false) {
        const incomingAt = new Date(dialog.message.date * 1000);
        const sentAt = contactedAt.get(peerId);

        if (contactedAt.has(peerId)) {
          if (!sentAt || incomingAt.getTime() > sentAt.getTime()) {
            repliedIds.push(peerId);
          }
        } else if (iWrote) {
          repliedIds.push(peerId);
        }
      }
    }

    result.leadsMarked = await this.leads.markContacted(contactedIds);
    // Строго после contacted: markReplied переводит только из contacted,
    // поэтому человек, которого мы пометили написанным прямо сейчас,
    // за тот же проход доедет до replied. При обратном порядке застрял бы.
    result.repliedMarked = await this.leads.markReplied(repliedIds);

    this.logger.log(
      `Диалогов ${result.dialogsSeen}, личных ${result.privateDialogs}, ` +
        `уже писал ${result.contactedTotal}, помечено лидов ${result.leadsMarked}, ` +
        `ответили ${result.repliedMarked}`,
    );

    return result;
  }

  /**
   * Полный пересчёт ответов.
   *
   * Быстрая сверка в syncContacted ловит ответ только когда наше последнее
   * сообщение НЕ последнее в диалоге. Но ты активно отвечаешь людям, и тогда
   * последнее сообщение — твоё, а ответ человека остаётся выше по истории и
   * из подсчёта выпадает. Отсюда «7 ответивших» при том, что реально их
   * больше.
   *
   * Здесь читаем историю каждого диалога, где мы писали, и ищем самое свежее
   * ВХОДЯЩЕЕ сообщение позже нашего письма — это и есть ответ. Его текст
   * складываем в базу, чтобы worklist показывал его без повторного чтения.
   *
   * Дорого (запрос к Telegram на каждого, кому писали), поэтому это отдельная
   * ручная операция, а не часть refresh.
   */
  public async recountReplies(): Promise<{
    checked: number;
    replied: number;
    answered: number;
    deepReads: number;
  }> {
    const client = this.telegram.getClient();
    const contacted = await this.leads.getContactedForRecount();
    // id → когда мы писали. Идём по диалогам, а НЕ по никам: getEntity('@ник')
    // делает contacts.ResolveUsername на каждого, а Telegram его жёстко
    // лимитирует — на трёх сотнях это FloodWait по 3-4 секунды каждый.
    // iterDialogs отдаёт уже разрезолвленные сущности за один проход.
    const sentById = new Map(contacted.map((c) => [c.tgUserId, c.contactedAt]));
    const result = { checked: 0, replied: 0, answered: 0, deepReads: 0 };

    for await (const dialog of client.iterDialogs({ limit: this.config.limit })) {
      if (!dialog.isUser) continue;
      const entity = dialog.entity;
      if (!(entity instanceof Api.User)) continue;

      const id = entity.id.toString();
      if (!sentById.has(id)) continue;

      result.checked += 1;
      const sent = sentById.get(id);
      const sentAt = sent ? sent.getTime() : 0;
      const last = dialog.message;

      if (
        last &&
        last.out === false &&
        (last.message ?? '').trim() &&
        last.date * 1000 > sentAt
      ) {
        // Последнее сообщение — их ответ, и он не отвечен (ниже него ничего
        // нашего нет). Ждёт нас.
        await this.leads.recordReply(id, last.message, new Date(last.date * 1000));
        result.replied += 1;
      } else if (last && last.out === true) {
        // Последнее сообщение наше. Либо это исходное письмо (ответа не было),
        // либо мы уже ответили на их ответ. Читаем историю, чтобы отличить.
        try {
          const messages = await client.getMessages(entity, {
            limit: this.config.deepLimit,
          });
          result.deepReads += 1;
          await sleep(this.config.deepDelayMs);

          const reply = messages.find(
            (m: Api.Message) =>
              m.out === false &&
              (m.message ?? '').trim().length > 0 &&
              m.date * 1000 > sentAt,
          );
          if (reply) {
            // Человек ответил, а последнее сообщение наше — значит мы уже
            // ответили руками. Помечаем answered, чтобы worklist не врал.
            await this.leads.markAnswered(id);
            result.answered += 1;
          }
          // Иначе ответа не было (последнее — наше письмо), не трогаем.
        } catch (err) {
          this.logger.warn(`Пересчёт: id${id} — ${describeError(err)}`);
        }
      }
    }

    this.logger.log(
      `Пересчёт: проверено ${result.checked}, ждут ответа ${result.replied}, ` +
        `уже отвечено ${result.answered}, глубоких чтений ${result.deepReads}`,
    );
    return result;
  }

  /**
   * Авто-ответ шаблоном тем, кто написал и кому мы ещё НЕ отвечали.
   *
   * Безопаснее рассылки по двум причинам:
   *  • отвечаем тем, кто сам нам написал, — это обычный диалог, а не письмо
   *    незнакомцу, поэтому PEER_FLOOD не грозит;
   *  • шлём по сущности из iterDialogs — без contacts.ResolveUsername,
   *    который и ловил многочасовые лимиты на рассылке.
   *
   * «Ещё не отвечали» определяем по состоянию диалога В МОМЕНТ отправки:
   * последнее сообщение — их (входящее) и оно позже нашего письма. Если ты
   * уже ответил руками, последним будет твоё, и человек сюда не попадёт.
   * Плюс после отправки статус → answered, второй guard от повтора.
   *
   * Шаблон уходит только на однозначные позитив/отказ; вопрос и нейтральное
   * пропускаем — их надо разобрать руками (см. autoReplyTemplate).
   */
  public async autoReplyUnanswered(options: {
    dryRun: boolean;
    limit: number;
  }): Promise<AutoReplyResult> {
    const client = this.telegram.getClient();
    const candidates = await this.leads.getAutoReplyCandidates();
    const cap = Math.min(options.limit, this.config.autoReplyMax);
    const result: AutoReplyResult = {
      dryRun: options.dryRun,
      sent: 0,
      cleared: 0,
      manual: 0,
      stoppedBecause: 'кандидаты закончились',
      entries: [],
    };

    for await (const dialog of client.iterDialogs({ limit: this.config.limit })) {
      // Лимит считаем по отправкам: закрытие без ответа и «оставить тебе»
      // сообщений не шлют, ограничивать их незачем.
      if (result.sent >= cap) {
        result.stoppedBecause = `упёрлись в лимит отправок (${cap})`;
        break;
      }
      if (!dialog.isUser) continue;
      const entity = dialog.entity;
      if (!(entity instanceof Api.User)) continue;

      const id = entity.id.toString();
      const sentAt = candidates.get(id);
      if (sentAt === undefined) continue;
      const cutoff = sentAt ? sentAt.getTime() : 0;

      // Дешёвый пред-фильтр по последнему сообщению: похоже ли на
      // неотвеченный ответ. Отсекает почти всех, не тратя запрос истории.
      const last = dialog.message;
      if (!last || last.out !== false) continue;
      if ((last.message ?? '').trim().length === 0) continue;
      if (last.date * 1000 <= cutoff) continue;

      // Авторитетная проверка по ИСТОРИИ, а не по одному последнему сообщению.
      // Ручной ответ нигде не фиксируется и статус не двигает, поэтому
      // «последнее сообщение — их» ложно пропускает случай «ты ответил руками,
      // человек написал ещё раз». Читаем историю (по резолвнутой сущности —
      // без ResolveUsername) и пропускаем, если после нашего письма есть ХОТЬ
      // ОДНО наше исходящее: значит мы уже ответили (руками или прошлым авто).
      let messages;
      try {
        messages = await client.getMessages(entity, { limit: this.config.deepLimit });
        await sleep(this.config.deepDelayMs);
      } catch (err) {
        // Не смогли прочитать историю — молчим и идём дальше. Отправлять
        // вслепую нельзя: это ровно тот повтор, что мы предотвращаем.
        this.logger.warn(
          `Авто-ответ: id${id} — история недоступна: ${describeError(err)}`,
        );
        continue;
      }

      const weAlreadyAnswered = messages.some(
        (m: Api.Message) => m.out === true && m.date * 1000 > cutoff,
      );
      if (weAlreadyAnswered) continue;

      const theirReply = messages.find(
        (m: Api.Message) =>
          m.out === false &&
          (m.message ?? '').trim().length > 0 &&
          m.date * 1000 > cutoff,
      );
      if (!theirReply) continue;

      const decision = autoReplyDecision(theirReply.message);
      const entry = {
        username: entity.username ?? null,
        tgUserId: id,
        kind: decision.kind,
        action: decision.action,
        reason: decision.reason,
        reply: theirReply.message.replace(/\s+/g, ' ').trim().slice(0, 120),
      };

      // Оставляем тебе: вопрос / просьба о ссылке / развёрнутый фидбек.
      if (decision.action === 'manual') {
        result.manual += 1;
        continue;
      }

      // Закрыть без ответа: короткое нейтральное, ответа не требует.
      if (decision.action === 'clear') {
        result.cleared += 1;
        if (!options.dryRun) {
          try {
            await this.leads.markAnswered(id);
          } catch (err) {
            this.logger.warn(`Авто-закрытие id${id}: markAnswered упал: ${describeError(err)}`);
          }
        }
        result.entries.push({ ...entry, result: options.dryRun ? 'preview' : 'cleared' });
        continue;
      }

      // Отправить шаблон.
      if (options.dryRun) {
        result.entries.push({ ...entry, result: 'preview' });
        result.sent += 1; // в dry-run считаем «сколько бы ушло»
        continue;
      }

      try {
        await client.sendMessage(entity, { message: decision.text ?? '' });
      } catch (err) {
        // Ошибка на отправке (в т.ч. FloodWait — он уже записан трекером
        // через обёртку invoke) останавливает проход: сыпать дальше при
        // проблеме нельзя.
        const message = describeError(err);
        result.entries.push({ ...entry, result: 'failed', error: message });
        result.stoppedBecause = `ошибка отправки: ${message}`;
        break;
      }

      // Сообщение УШЛО. markAnswered отдельно: его сбой не имеет права
      // выдать отправленное за провал. Даже если пометка не пройдёт,
      // следующий запуск увидит наше исходящее в истории и не отправит
      // второй раз.
      result.entries.push({ ...entry, result: 'sent' });
      result.sent += 1;
      try {
        await this.leads.markAnswered(id);
      } catch (err) {
        this.logger.error(
          `Авто-ответ ушёл @${entry.username}, но markAnswered упал: ${describeError(err)}`,
        );
      }
      await sleep(this.config.autoReplyDelaySec * 1000);
    }

    this.logger.log(
      `Авто-ответ (${options.dryRun ? 'preview' : 'боевой'}): ` +
        `отправлено ${result.sent}, закрыто ${result.cleared}, тебе ${result.manual}`,
    );
    return result;
  }

  /**
   * Выгрузка всего, что осталось без нашего ответа.
   *
   * Дорогая часть — чтение истории, оно же главный источник FloodWait.
   * Поэтому дешёвый пред-фильтр: если последнее сообщение диалога наше,
   * отвечать нечего и историю читать незачем. Это отсекает почти всех.
   */
  public async collectUnanswered(limit: number): Promise<InboxDump> {
    const client = this.telegram.getClient();
    const candidates = await this.leads.getDialogCandidates();

    const dump: InboxDump = {
      createdAt: formatStamp(new Date()),
      dialogsSeen: 0,
      dialogs: [],
      trivial: [],
      stoppedBecause: 'кандидаты закончились',
    };

    for await (const dialog of client.iterDialogs({ limit: this.config.limit })) {
      if (dump.dialogs.length + dump.trivial.length >= limit) {
        dump.stoppedBecause = `упёрлись в лимит выгрузки (${limit})`;
        break;
      }
      if (!dialog.isUser) continue;
      const entity = dialog.entity;
      if (!(entity instanceof Api.User)) continue;

      const candidate = candidates.get(entity.id.toString());
      if (!candidate) continue;
      dump.dialogsSeen += 1;

      // Пред-фильтр: последнее сообщение наше или пустое — читать историю не за чем.
      const last = dialog.message;
      if (!last || last.out !== false) continue;
      if ((last.message ?? '').trim().length === 0) continue;

      let messages;
      try {
        messages = await client.getMessages(entity, { limit: this.config.deepLimit });
        await sleep(this.config.deepDelayMs);
      } catch (err) {
        // Историю не прочитали — в выгрузку не кладём: писать ответ вслепую
        // хуже, чем не ответить сейчас и увидеть человека в следующий раз.
        this.logger.warn(
          `Выгрузка: id${candidate.tgUserId} — история недоступна: ${describeError(err)}`,
        );
        continue;
      }

      const contactedAtSec = candidate.contactedAt
        ? Math.floor(candidate.contactedAt.getTime() / 1000)
        : 0;
      const slice = sliceUnanswered(
        messages.map((m: Api.Message): HistoryMessage => ({
          out: m.out === true,
          date: m.date,
          message: m.message ?? '',
        })),
        contactedAtSec,
      );

      if (slice.incoming.length === 0) continue;

      const newest = slice.incoming[slice.incoming.length - 1];
      const decision = autoReplyDecision(newest.message);

      // Set по ссылкам, а не повторение предиката sliceUnanswered: incoming
      // собран как history.filter(...), объекты те же самые, поэтому
      // членство проверяется точно и не может разъехаться с курсором.
      const isFresh = new Set(slice.incoming);

      const entry: InboxDialog = {
        tgUserId: candidate.tgUserId,
        username: entity.username ?? null,
        hook: buildHook(candidate.sampleText),
        about: candidate.sampleText,
        heuristic: {
          kind: decision.kind,
          action: decision.action,
          reason: decision.reason,
        },
        history: slice.history.map((m): InboxMessage => ({
          out: m.out,
          at: formatStamp(new Date(m.date * 1000)),
          text: m.message,
          fresh: isFresh.has(m),
        })),
      };

      // Эвристика уверена, что ответа не требует, — в отдельный блок, чтобы
      // не тратить внимание на пятьдесят «ок».
      if (decision.action === 'clear') dump.trivial.push(entry);
      else dump.dialogs.push(entry);
    }

    this.logger.log(
      `Выгрузка: нужен ответ ${dump.dialogs.length}, тривиальных ${dump.trivial.length}`,
    );
    return dump;
  }

  /**
   * Отправка ответов, подготовленных в outbox.
   *
   * Перед КАЖДОЙ отправкой история диалога перечитывается — в том числе в
   * предпросмотре. Лишние запросы того стоят: предпросмотр, который проверяет
   * не то же, что боевой прогон, показывает не то, что произойдёт.
   *
   * Отсюда бесплатная идемпотентность: повторный запуск того же файла увидит
   * наше исходящее после их входящего и пропустит всё. Таблица отправленных
   * ответов не нужна.
   */
  public async sendPreparedReplies(
    entries: OutboxEntry[],
    options: {
      dryRun: boolean;
      limit: number;
      file: string;
      dumpedAtSec: number | null;
      /** Посчитано вызывающим по самой выгрузке; null — её нет на диске. */
      untouched: number | null;
    },
  ): Promise<OutboxSendResult> {
    const client = this.telegram.getClient();
    const candidates = await this.leads.getDialogCandidates();
    const cap = Math.min(options.limit, this.config.autoReplyMax);

    const result: OutboxSendResult = {
      dryRun: options.dryRun,
      file: options.file,
      sent: 0,
      closed: 0,
      asked: 0,
      skipped: 0,
      untouched: options.untouched,
      notFound: 0,
      stoppedBecause: 'записи закончились',
      staleCheck: options.dumpedAtSec !== null,
      entries: [],
    };

    const pending = new Map(entries.map((e) => [e.tgUserId, e]));

    // ASK ничего не трогает в Telegram — разбираем сразу, не тратя проход.
    for (const entry of entries) {
      if (entry.directive !== 'ask') continue;
      pending.delete(entry.tgUserId);
      result.asked += 1;
      result.entries.push(sendEntry(entry, 'asked'));
    }

    for await (const dialog of client.iterDialogs({ limit: this.config.limit })) {
      if (pending.size === 0) break;
      if (result.sent >= cap) {
        result.stoppedBecause = `упёрлись в лимит отправок (${cap})`;
        break;
      }
      if (!dialog.isUser) continue;
      const dialogEntity = dialog.entity;
      if (!(dialogEntity instanceof Api.User)) continue;

      const id = dialogEntity.id.toString();
      const entry = pending.get(id);
      if (!entry) continue;
      pending.delete(id);

      if (entry.directive === 'close') {
        result.closed += 1;
        if (!options.dryRun) {
          try {
            await this.leads.markAnswered(id);
          } catch (err) {
            this.logger.warn(`CLOSE id${id}: markAnswered упал: ${describeError(err)}`);
          }
        }
        result.entries.push(sendEntry(entry, options.dryRun ? 'preview' : 'closed'));
        continue;
      }

      // SEND: перечитываем историю и решаем, актуален ли ещё черновик.
      let messages;
      try {
        messages = await client.getMessages(dialogEntity, { limit: this.config.deepLimit });
        await sleep(this.config.deepDelayMs);
      } catch (err) {
        result.skipped += 1;
        result.entries.push(sendEntry(entry, 'skipped', `история недоступна: ${describeError(err)}`));
        continue;
      }

      const candidate = candidates.get(id);
      const contactedAtSec = candidate?.contactedAt
        ? Math.floor(candidate.contactedAt.getTime() / 1000)
        : 0;
      const slice = sliceUnanswered(
        messages.map(
          (m: Api.Message): HistoryMessage => ({
            out: m.out === true,
            date: m.date,
            message: m.message ?? '',
          }),
        ),
        contactedAtSec,
      );

      // Неотвеченного нет — значит после выгрузки ты ответил руками.
      if (slice.incoming.length === 0) {
        result.skipped += 1;
        result.entries.push(sendEntry(entry, 'skipped', 'ты ответил руками'));
        continue;
      }

      // Человек написал ещё раз после выгрузки: черновик отвечает на устаревшую
      // реплику, а это выглядит как невнимательность. Пусть попадёт в следующий
      // inbox уже с новым контекстом.
      const newestSec = slice.incoming[slice.incoming.length - 1].date;
      if (options.dumpedAtSec !== null && newestSec > options.dumpedAtSec) {
        result.skipped += 1;
        result.entries.push(sendEntry(entry, 'skipped', 'написал ещё раз после выгрузки'));
        continue;
      }

      if (options.dryRun) {
        result.sent += 1;
        result.entries.push(sendEntry(entry, 'preview'));
        continue;
      }

      try {
        await client.sendMessage(dialogEntity, { message: entry.body });
      } catch (err) {
        const message = describeError(err);
        result.entries.push(sendEntry(entry, 'failed', message));
        result.stoppedBecause = `ошибка отправки: ${message}`;
        break;
      }

      // Сообщение УШЛО. markAnswered отдельно: его сбой не имеет права выдать
      // отправленное за провал. Даже если пометка не пройдёт, следующая
      // выгрузка увидит наше исходящее и не предложит ответить второй раз.
      result.sent += 1;
      result.entries.push(sendEntry(entry, 'sent'));
      try {
        await this.leads.markAnswered(id);
      } catch (err) {
        this.logger.error(
          `Ответ ушёл id${id}, но markAnswered упал: ${describeError(err)}`,
        );
      }

      // Джиттер, а не ровная пауза: ровный ритм запросов — сам по себе
      // признак автоматизации.
      await sleepJitter(this.config.autoReplyDelaySec * 1000);
    }

    // Записи, до которых проход не дошёл: диалога нет в списке, кончился лимит,
    // остановились по ошибке. Это НЕ то же, что `untouched` (там — кому ответ
    // не написали вовсе); оба числа печатаются, чтобы лид не терялся молча.
    result.notFound = pending.size;

    this.logger.log(
      `Outbox ${options.file} (${options.dryRun ? 'preview' : 'боевой'}): ` +
        `отправлено ${result.sent}, закрыто ${result.closed}, тебе ${result.asked}, ` +
        `пропущено ${result.skipped}, не дошёл ${result.notFound}`,
    );
    return result;
  }

  /**
   * Есть ли в переписке хоть одно моё сообщение.
   *
   * Берём обычную историю, а не серверный фильтр `fromUser: 'me'`: в личных
   * чатах Telegram поддерживает его не везде, а промах здесь означает
   * «решили, что не писали» — то есть ровно тот повторный контакт, ради
   * предотвращения которого всё и затевалось.
   *
   * Ограничение честное: смотрим последние N сообщений. Если ты написал
   * один раз, а человек потом прислал сотню — не увидим. На практике
   * переписки после холодного аутрича короткие.
   */
  private async hasOutgoing(user: Api.User): Promise<boolean> {
    try {
      const messages = await this.telegram
        .getClient()
        .getMessages(user, { limit: this.config.deepLimit });
      return messages.some((message) => message.out === true);
    } catch (err) {
      // Диалог мог быть удалён/ограничен — считаем, что не писали, и идём
      // дальше. Молча падать на одном контакте нельзя, но и ронять весь
      // проход из-за него тоже.
      this.logger.warn(
        `Не удалось проверить переписку с id${user.id.toString()}: ${String(err)}`,
      );
      return false;
    }
  }

  private async countParticipants(
    entity: Api.Chat | Api.Channel,
    withCounts: boolean,
  ): Promise<number | null> {
    // У обычной группы количество приходит прямо в диалоге.
    if (entity instanceof Api.Chat) return entity.participantsCount ?? null;
    if (!withCounts) return null;

    // У супергруппы — только отдельным запросом, поэтому по требованию.
    try {
      const full = await this.telegram
        .getClient()
        .invoke(new Api.channels.GetFullChannel({ channel: entity }));
      const info = full.fullChat as Api.ChannelFull;
      await sleep(this.config.deepDelayMs);
      return info.participantsCount ?? null;
    } catch {
      return null;
    }
  }
}

function resolveType(entity: Api.Chat | Api.Channel): DiscoveredChat['type'] {
  if (entity instanceof Api.Chat) return 'group';
  if (entity.broadcast) return 'channel';
  return 'supergroup';
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatStamp(at: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())} ${p(at.getHours())}:${p(at.getMinutes())}`;
}

function sendEntry(
  entry: OutboxEntry,
  outcome: OutboxSendEntry['result'],
  note?: string,
): OutboxSendEntry {
  return {
    tgUserId: entry.tgUserId,
    username: entry.username,
    directive: entry.directive,
    result: outcome,
    note,
  };
}
