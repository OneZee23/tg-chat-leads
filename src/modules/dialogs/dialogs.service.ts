import { Injectable, Logger } from '@nestjs/common';
import { Api } from 'telegram';
import { sleep } from '@common/utils/sleep';
import { DialogsConfig } from '@modules/dialogs/dialogs.config';
import { LeadService } from '@modules/lead/lead.service';
import { ScannerConfig } from '@modules/scanner/scanner.config';
import { TelegramClientService } from '@modules/telegram/telegram-client.service';

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
