import { Injectable, Logger } from '@nestjs/common';
import { Api } from 'telegram';
import { sleep } from '@common/utils/sleep';
import { DialogsConfig } from '@modules/dialogs/dialogs.config';
import { LeadService } from '@modules/lead/lead.service';
import { autoReplyTemplate } from '@modules/outreach/reply-draft';
import { ReplyKind } from '@modules/outreach/reply-draft';
import { ScannerConfig } from '@modules/scanner/scanner.config';
import { TelegramClientService } from '@modules/telegram/telegram-client.service';

export interface AutoReplyEntry {
  username: string | null;
  tgUserId: string;
  kind: ReplyKind;
  reply: string;
  result: 'preview' | 'sent' | 'failed';
  error?: string;
}

export interface AutoReplyResult {
  dryRun: boolean;
  /** Отправлено (или «ушло бы» в dry-run). */
  sent: number;
  /** Пропущено на ручной разбор (вопрос/нейтральное). */
  skippedManual: number;
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
    deepReads: number;
  }> {
    const client = this.telegram.getClient();
    const contacted = await this.leads.getContactedForRecount();
    // id → когда мы писали. Идём по диалогам, а НЕ по никам: getEntity('@ник')
    // делает contacts.ResolveUsername на каждого, а Telegram его жёстко
    // лимитирует — на трёх сотнях это FloodWait по 3-4 секунды каждый.
    // iterDialogs отдаёт уже разрезолвленные сущности за один проход.
    const sentById = new Map(contacted.map((c) => [c.tgUserId, c.contactedAt]));
    const result = { checked: 0, replied: 0, deepReads: 0 };

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

      let reply: Api.Message | undefined;

      if (
        last &&
        last.out === false &&
        (last.message ?? '').trim() &&
        last.date * 1000 > sentAt
      ) {
        // Последнее сообщение — их ответ, текст уже на руках, лишний запрос
        // не нужен.
        reply = last;
      } else if (last && last.out === true) {
        // Мы ответили последними — ответ человека выше по истории. Читаем её,
        // но getMessages по готовой сущности НЕ дёргает ResolveUsername.
        try {
          const messages = await client.getMessages(entity, {
            limit: this.config.deepLimit,
          });
          reply = messages.find(
            (m: Api.Message) =>
              m.out === false &&
              (m.message ?? '').trim().length > 0 &&
              m.date * 1000 > sentAt,
          );
          result.deepReads += 1;
          await sleep(this.config.deepDelayMs);
        } catch (err) {
          this.logger.warn(`Пересчёт: id${id} — ${describeError(err)}`);
        }
      }

      if (reply) {
        await this.leads.recordReply(id, reply.message, new Date(reply.date * 1000));
        result.replied += 1;
      }
    }

    this.logger.log(
      `Пересчёт ответов: проверено ${result.checked}, ответили ${result.replied}, ` +
        `глубоких чтений ${result.deepReads}`,
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
      skippedManual: 0,
      stoppedBecause: 'кандидаты закончились',
      entries: [],
    };

    for await (const dialog of client.iterDialogs({ limit: this.config.limit })) {
      if (result.sent >= cap) {
        result.stoppedBecause = `упёрлись в лимит (${cap})`;
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

      const template = autoReplyTemplate(theirReply.message);
      if (!template.text) {
        result.skippedManual += 1;
        continue;
      }

      const entry = {
        username: entity.username ?? null,
        tgUserId: id,
        kind: template.kind,
        reply: theirReply.message.replace(/\s+/g, ' ').trim().slice(0, 120),
      };

      if (options.dryRun) {
        result.entries.push({ ...entry, result: 'preview' });
        result.sent += 1; // в dry-run считаем «сколько бы ушло»
        continue;
      }

      try {
        await client.sendMessage(entity, { message: template.text });
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
        `${options.dryRun ? 'кандидатов' : 'отправлено'} ${result.sent}, ` +
        `на разбор руками ${result.skippedManual}`,
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
