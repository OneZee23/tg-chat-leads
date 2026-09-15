import { Injectable, Logger } from '@nestjs/common';
import { Api } from 'telegram';
import { sleep, sleepJitter } from '@common/utils/sleep';
import { DialogsConfig } from '@modules/dialogs/dialogs.config';
import { detectReview } from '@modules/dialogs/review-detect';
import { HistoryMessage, sliceUnanswered } from '@modules/dialogs/unanswered';
import { DialogCandidate, LeadService } from '@modules/lead/lead.service';
import { InboxDialog, InboxDump, InboxMessage } from '@modules/outreach/inbox.format';
import { OutboxSendEntry, OutboxSendResult } from '@modules/outreach/outbox.format';
import { OutboxEntry } from '@modules/outreach/outbox.parse';
import { ReviewEntry, ReviewsDump } from '@modules/outreach/reviews.format';
import { autoReplyDecision } from '@modules/outreach/reply-draft';
import { AutoAction, ReplyKind } from '@modules/outreach/reply-draft';
import { ScannerConfig } from '@modules/scanner/scanner.config';
import { buildHook } from '@modules/sender/outreach-message';
import {
  TelegramAccount,
  TelegramAccountsService,
} from '@modules/telegram/telegram-accounts.service';
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

export interface SendPreparedOptions {
  dryRun: boolean;
  limit: number;
  file: string;
  /** Момент выгрузки из имени файла; null — стампа в имени нет. */
  dumpedAtSec: number | null;
  /** Посчитано вызывающим по самой выгрузке; null — её нет на диске. */
  untouched: number | null;
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

/** Диалог, где последним написал человек: слово за нами. */
export interface WaitingDialog {
  account: string;
  username: string | null;
  tgUserId: string;
  name: string;
  at: Date;
  text: string;
  unread: number;
  /** Когда мы закрыли разговор без ответа. null — не закрывали. */
  closedAt: Date | null;
  /** Есть ли он в базе лидов вообще. */
  known: boolean;
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

  /** Идёт ли прогон outbox прямо сейчас. См. sendPreparedReplies. */
  private sending = false;

  constructor(
    private readonly config: DialogsConfig,
    private readonly scannerConfig: ScannerConfig,
    private readonly telegram: TelegramClientService,
    private readonly accounts: TelegramAccountsService,
    private readonly leads: LeadService,
  ) {}

  /**
   * Диалоги ВСЕХ подключённых аккаунтов, по очереди.
   *
   * Ответ приходит тому, кто писал. Если второй аккаунт отправил письмо, а
   * инбокс читается только с первого, ответ этого человека не увидит никто —
   * фича не экономит время, а теряет живых людей. Поэтому каждый обход идёт
   * по всем аккаунтам, а вместе с диалогом отдаётся и тот, чья это личка:
   * читать историю и отвечать надо ИМЕННО им.
   *
   * Порядок — из `accounts.list()`: основной первый. На этом держится
   * разрешение дублей ниже: человека, который есть в личке у обоих,
   * разбирает первый, а второй пропускает.
   *
   * DIALOGS_LIMIT применяется к каждой папке каждого аккаунта отдельно: это
   * окно обхода «последние N диалогов», и у каждой лички оно своё.
   *
   * АРХИВ ОБХОДИТСЯ ОТДЕЛЬНЫМ ПРОХОДОМ, и это главное здесь.
   * `iterDialogs()` без `archived` возвращает архив ОДНОЙ псевдозаписью
   * `DialogFolder`, а GramJS её пропускает (`client/dialogs.js`: «if (d
   * instanceof Api.DialogFolder) continue»). То есть чаты внутри архива не
   * перечисляются вовсе — при том, что документация обещает обратное.
   *
   * Цена ошибки измерена: 15.09.2026 в выгрузке оказалось 285 человек, чьих
   * диалогов обход «не увидел». У 200 из них наше сообщение реально ушло,
   * то есть чат существует. Туда их кладёт сам Telegram — настройка
   * «архивировать новые чаты от неконтактов» ровно про наш случай: мы
   * пишем незнакомым людям, и их ответы уезжают в архив мимо инбокса.
   */
  private async *eachDialog(): AsyncGenerator<{
    dialog: Awaited<ReturnType<TelegramAccount['client']['getDialogs']>>[number];
    account: TelegramAccount;
  }> {
    for (const account of this.accounts.list()) {
      // false — основная папка, true — архив. Именно двумя проходами:
      // значение undefined архив молча пропускает.
      for (const archived of [false, true]) {
        for await (const dialog of account.client.iterDialogs({
          limit: this.config.limit,
          archived,
        })) {
          yield { dialog, account };
        }
      }
    }
  }

  /**
   * История одного человека → запись выгрузки. null — отвечать нечего.
   *
   * Общий кусок двух проходов: обхода по списку диалогов и добора тех, кого
   * список не отдал. Оба обязаны разбирать переписку одинаково — иначе
   * человек попадал бы в выгрузку по-разному в зависимости от того, каким
   * путём мы до него добрались.
   */
  private async inspectDialog(
    account: TelegramAccount,
    entity: Api.User,
    candidate: DialogCandidate,
  ): Promise<InboxDialog | null> {
    let messages;
    try {
      messages = await account.client.getMessages(entity, {
        limit: this.config.deepLimit,
      });
      await sleep(this.config.deepDelayMs);
    } catch (err) {
      // Историю не прочитали — в выгрузку не кладём: писать ответ вслепую
      // хуже, чем не ответить сейчас и увидеть человека в следующий раз.
      this.logger.warn(
        `Выгрузка: id${candidate.tgUserId} — история недоступна: ${describeError(err)}`,
      );
      return null;
    }

    const slice = sliceUnanswered(toHistory(messages), cursorFloorSec(candidate));
    if (slice.incoming.length === 0) return null;

    const newest = slice.incoming[slice.incoming.length - 1];
    const decision = autoReplyDecision(newest.message);

    // Set по ссылкам, а не повторение предиката sliceUnanswered: incoming
    // собран как history.filter(...), объекты те же самые, поэтому
    // членство проверяется точно и не может разъехаться с курсором.
    const isFresh = new Set(slice.incoming);

    return {
      tgUserId: candidate.tgUserId,
      username: entity.username ?? null,
      // Кто ведёт переписку. В файле это видно человеку, а обратный прогон
      // outbox по этому полю выбирает, с какого аккаунта отвечать.
      account: account.name,
      accountTitle: account.title,
      hook: buildHook(candidate.sampleText),
      about: candidate.sampleText,
      heuristic: {
        kind: decision.kind,
        action: decision.action,
        reason: decision.reason,
      },
      history: slice.history
        // Сообщения без текста — наши скриншоты из рассылки и чужие
        // стикеры. Отвечать на них не на что, а в файле они рисовались
        // пустыми блоками по семь подряд перед каждым письмом.
        //
        // Фильтруем ТОЛЬКО здесь, при рендере. Убрать их раньше, до
        // sliceUnanswered, — значит потерять наше фото как «последнее наше
        // сообщение»: курсор откатится назад, и уже отвеченный диалог
        // всплывёт в следующей выгрузке заново.
        .filter((m) => m.message.trim().length > 0)
        .map((m): InboxMessage => ({
          out: m.out,
          at: formatStamp(new Date(m.date * 1000)),
          text: m.message,
          fresh: isFresh.has(m),
        })),
    };
  }

  /**
   * Читать ли переписку этого человека с этого аккаунта.
   *
   * Пока аккаунт за человеком не закреплён, разбирает первый, у кого нашёлся
   * диалог. Как только закреплён — только он: у человека может быть личный
   * чат и со вторым нашим номером, и тогда «последнее сообщение входящее»
   * относилось бы к совсем другому разговору.
   */
  private ownsDialog(account: TelegramAccount, assigned: string | null): boolean {
    return !assigned || assigned === account.name;
  }

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
   * Кто ждёт ответа ПО ТЕЛЕГРАМУ, а не по нашей базе.
   *
   * Инбокс отвечает на вопрос «кому мы ещё не ответили по нашему учёту», и в
   * нём есть решения, принятые раньше: закрытый директивой CLOSE человек
   * больше не показывается никогда. Обычно это правильно — «спасибо, не
   * интересно» отвечать нечем, — но решение о закрытии принимал ассистент, а
   * проверять его должен человек.
   *
   * Здесь источник правды другой и предельно простой: последнее сообщение в
   * диалоге — его, значит слово за нами. Ничего из нашей базы этот список не
   * фильтрует; статус и дату закрытия он лишь ПОКАЗЫВАЕТ рядом, чтобы было
   * видно, чем именно закончился разговор.
   */
  public async collectWaiting(): Promise<WaitingDialog[]> {
    const candidates = await this.leads.getDialogCandidates();
    const out: WaitingDialog[] = [];

    for (const account of this.accounts.list()) {
      for (const archived of [false, true]) {
        for await (const dialog of account.client.iterDialogs({
          limit: this.config.limit,
          archived,
        })) {
          if (!dialog.isUser) continue;
          const entity = dialog.entity;
          if (!(entity instanceof Api.User)) continue;
          if (entity.bot || entity.self) continue;

          const last = dialog.message;
          if (!last || last.out !== false) continue;

          const candidate = candidates.get(entity.id.toString());
          out.push({
            account: account.title,
            username: entity.username ?? null,
            tgUserId: entity.id.toString(),
            name: [entity.firstName, entity.lastName].filter(Boolean).join(' '),
            at: new Date(last.date * 1000),
            text: messageText(last),
            unread: dialog.unreadCount,
            closedAt: candidate?.closedAt ?? null,
            known: Boolean(candidate),
          });
        }
      }
    }

    out.sort((a, b) => b.at.getTime() - a.at.getTime());
    this.logger.log(`Слово за нами в ${out.length} диалогах`);
    return out;
  }

  /**
   * Погасить счётчик непрочитанных там, где мы уже ответили.
   *
   * Отправка через API не помечает чат прочитанным, поэтому синий кружок
   * висит и на тех, кому мы давно ответили. Счётчик в телеграме перестаёт
   * что-либо значить, а человек по привычке читает его как «столько людей
   * ждут ответа» — и не верит инбоксу, который говорит другое.
   *
   * Помечаем ТОЛЬКО те диалоги, где последнее сообщение наше. Там, где
   * последним написал человек, кружок остаётся: это и есть настоящий долг,
   * и гасить его, не ответив, значит врать себе же. Плюс уважение к
   * собеседнику: «прочитано» без ответа — это сообщение само по себе.
   */
  public async markAnsweredRead(): Promise<{ marked: number; left: number }> {
    const result = { marked: 0, left: 0 };

    for (const account of this.accounts.list()) {
      for (const archived of [false, true]) {
        for await (const dialog of account.client.iterDialogs({
          limit: this.config.limit,
          archived,
        })) {
          if (!dialog.isUser || dialog.unreadCount === 0) continue;

          const last = dialog.message;
          if (!last || last.out !== true) {
            result.left += 1;
            continue;
          }

          try {
            await account.client.markAsRead(dialog.entity as Api.User);
            result.marked += 1;
            await sleep(this.config.deepDelayMs);
          } catch (err) {
            this.logger.warn(`Не пометил прочитанным: ${describeError(err)}`);
          }
        }
      }
    }

    this.logger.log(
      `Счётчик непрочитанных: погашено ${result.marked}, осталось ждущих ответа ${result.left}`,
    );
    return result;
  }

  /**
   * Разовая диагностика: выписать всё как есть, без единой догадки.
   *
   * Появилась 15.09.2026, когда три гипотезы подряд не подтвердились: обход
   * стабильно «не находил» 287 человек, которым мы писали, и ни архив, ни
   * узнавание по нику этого не изменили. Дальше гадать дороже, чем один раз
   * посмотреть на сырые данные.
   *
   * Отдаёт по каждому диалогу: аккаунт, папку, id, ник, тип и дату
   * последнего сообщения. И отдельно — кандидатов, которых в списке не
   * оказалось. Сопоставлять их дальше можно уже глазами и SQL.
   */
  public async dumpDialogs(): Promise<string> {
    const candidates = await this.leads.getDialogCandidates();
    const byUsername = new Map<string, string>();
    for (const c of candidates.values()) {
      const nick = c.username?.trim().toLowerCase();
      if (nick) byUsername.set(nick, c.tgUserId);
    }

    const lines: string[] = [
      'аккаунт;папка;id;ник;тип;последнее_сообщение;совпал_с_кандидатом',
    ];
    const seen = new Set<string>();
    let total = 0;

    for (const account of this.accounts.list()) {
      for (const archived of [false, true]) {
        for await (const dialog of account.client.iterDialogs({
          limit: this.config.limit,
          archived,
        })) {
          total += 1;
          const entity = dialog.entity;
          const isUser = entity instanceof Api.User;
          const id = entity && 'id' in entity ? entity.id.toString() : '';
          const nick =
            entity && 'username' in entity ? ((entity.username as string) ?? '') : '';

          const byId = candidates.get(id)?.tgUserId;
          const byNick = nick ? byUsername.get(nick.toLowerCase()) : undefined;
          const matched = byId ?? byNick ?? '';
          if (matched) seen.add(matched);

          const at = dialog.message?.date
            ? new Date(dialog.message.date * 1000).toISOString().slice(0, 16)
            : '';

          lines.push(
            [
              account.name,
              archived ? 'архив' : 'основная',
              id,
              nick,
              isUser ? 'человек' : 'чат',
              at,
              matched,
            ].join(';'),
          );
        }
      }
    }

    lines.push('');
    lines.push(
      `# Диалогов всего: ${total}. Кандидатов: ${candidates.size}. Узнано: ${seen.size}.`,
    );
    lines.push('# Ниже — кандидаты, которых в списке диалогов не оказалось.');
    lines.push('id;ник;когда_писали');
    for (const c of candidates.values()) {
      if (seen.has(c.tgUserId)) continue;
      lines.push(
        [
          c.tgUserId,
          c.username ?? '',
          c.contactedAt?.toISOString().slice(0, 10) ?? '',
        ].join(';'),
      );
    }

    return lines.join('\n') + '\n';
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
    // Кого нашли в личке КАЖДОГО аккаунта: пометка закрепляет за человеком
    // того, у кого нашлось наше исходящее.
    const contactedByAccount = new Map<string, string[]>();
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

    for await (const { dialog, account } of this.eachDialog()) {
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
        iWrote = await this.hasOutgoing(account, entity);
        await sleep(this.config.deepDelayMs);
      }

      if (iWrote) {
        result.contactedTotal += 1;
        const list = contactedByAccount.get(account.name) ?? [];
        list.push(peerId);
        contactedByAccount.set(account.name, list);
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

    // По аккаунтам и в порядке списка: основной первый. Второй проход по
    // тому же человеку ничего не сделает — markContacted трогает только
    // `new`/`sending`, а после первого прохода он уже `contacted`.
    for (const [account, ids] of contactedByAccount) {
      result.leadsMarked += await this.leads.markContacted(ids, account);
    }
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
    const contacted = await this.leads.getContactedForRecount();
    // id → когда мы писали. Идём по диалогам, а НЕ по никам: getEntity('@ник')
    // делает contacts.ResolveUsername на каждого, а Telegram его жёстко
    // лимитирует — на трёх сотнях это FloodWait по 3-4 секунды каждый.
    // iterDialogs отдаёт уже разрезолвленные сущности за один проход.
    const sentById = new Map(contacted.map((c) => [c.tgUserId, c]));
    const result = { checked: 0, replied: 0, answered: 0, deepReads: 0 };
    // Человек может быть в личке у обоих аккаунтов — считаем его один раз.
    const done = new Set<string>();

    for await (const { dialog, account } of this.eachDialog()) {
      if (!dialog.isUser) continue;
      const entity = dialog.entity;
      if (!(entity instanceof Api.User)) continue;

      const id = entity.id.toString();
      const lead = sentById.get(id);
      if (!lead) continue;
      if (done.has(id)) continue;
      if (!this.ownsDialog(account, lead.assignedAccount)) continue;
      done.add(id);

      result.checked += 1;
      const sentAt = lead.contactedAt ? lead.contactedAt.getTime() : 0;
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
          const messages = await account.client.getMessages(entity, {
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

    // Человек в личке у обоих аккаунтов — разбираем один раз, иначе он
    // получит два одинаковых шаблона с разных номеров.
    const done = new Set<string>();

    for await (const { dialog, account } of this.eachDialog()) {
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
      const candidate = candidates.get(id);
      if (!candidate) continue;
      if (done.has(id)) continue;
      // Отвечает тот аккаунт, который вёл переписку: ответ с другого номера
      // человек прочитает как сообщение от постороннего.
      if (!this.ownsDialog(account, candidate.assignedAccount)) continue;
      done.add(id);
      const cutoff = candidate.contactedAt ? candidate.contactedAt.getTime() : 0;

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
        messages = await account.client.getMessages(entity, {
          limit: this.config.deepLimit,
        });
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
            this.logger.warn(
              `Авто-закрытие id${id}: markAnswered упал: ${describeError(err)}`,
            );
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
        await account.client.sendMessage(entity, { message: decision.text ?? '' });
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
    const candidates = await this.leads.getDialogCandidates();

    const dump: InboxDump = {
      createdAt: formatStamp(new Date()),
      dialogsSeen: 0,
      candidatesTotal: candidates.size,
      candidatesUnseen: 0,
      dialogsIterated: 0,
      dialogsLimit: this.config.limit,
      unseen: [],
      accounts: [],
      dialogs: [],
      trivial: [],
      stoppedBecause: 'кандидаты закончились',
    };

    // Счётчики по аккаунтам: с двумя личками надо видеть, где именно копится
    // работа, — иначе непонятно, чей аккаунт открывать.
    const perAccount = new Map<string, InboxDump['accounts'][number]>();
    const countFor = (account: TelegramAccount): InboxDump['accounts'][number] => {
      const row = perAccount.get(account.name) ?? {
        name: account.name,
        title: account.title,
        seen: 0,
        needReply: 0,
      };
      perAccount.set(account.name, row);
      return row;
    };

    // Кого проход реально увидел. Без этого счётчика «кандидаты
    // закончились» читалось как «проверены все», хотя на деле обход идёт
    // по последним диалогам аккаунта и старые в окно не попадают.
    const seen = new Set<string>();

    // Второй ключ к тем же людям — @ник. Нужен потому, что id в базе мог
    // устареть: рассылка открывает человека по НИКУ (`getEntity('@ник')`),
    // а в базе лежит id, записанный сканером месяцем раньше. Между этими
    // двумя моментами ник мог сменить владельца, а человек — аккаунт.
    //
    // Цена расхождения измерена 15.09.2026: обход прошёл 1430 диалогов и
    // узнал в них 1209 кандидатов, а 287 «не нашёл» — при том что 200 из
    // них наше сообщение получили. Больше двух сотен диалогов пролистали
    // мимо, не узнав в них своих.
    const byUsername = new Map<string, DialogCandidate>();
    for (const candidate of candidates.values()) {
      const nick = candidate.username?.trim().toLowerCase();
      if (nick) byUsername.set(nick, candidate);
    }

    for await (const { dialog, account } of this.eachDialog()) {
      dump.dialogsIterated += 1;
      if (dump.dialogs.length + dump.trivial.length >= limit) {
        dump.stoppedBecause = `упёрлись в лимит выгрузки (${limit})`;
        break;
      }
      if (!dialog.isUser) continue;
      const entity = dialog.entity;
      if (!(entity instanceof Api.User)) continue;

      const candidate = matchCandidate(candidates, byUsername, entity);
      if (!candidate) continue;
      if (seen.has(candidate.tgUserId)) continue;
      if (!this.ownsDialog(account, candidate.assignedAccount)) continue;
      dump.dialogsSeen += 1;
      countFor(account).seen += 1;
      seen.add(candidate.tgUserId);

      // Пред-фильтр: последнее сообщение наше или пустое — читать историю не за чем.
      const last = dialog.message;
      if (!last || last.out !== false) continue;
      if (messageText(last).length === 0) continue;

      const entry = await this.inspectDialog(account, entity, candidate);
      if (entry) {
        if (entry.heuristic.action === 'clear') dump.trivial.push(entry);
        else {
          dump.dialogs.push(entry);
          countFor(account).needReply += 1;
        }
      }
    }

    // Порядок как у пула: основной первым. Аккаунты без единого осмотренного
    // диалога в отчёт всё равно попадают — «ноль» здесь тоже ответ.
    dump.accounts = this.accounts.list().map(
      (account) =>
        perAccount.get(account.name) ?? {
          name: account.name,
          title: account.title,
          seen: 0,
          needReply: 0,
        },
    );

    dump.candidatesUnseen = dump.candidatesTotal - seen.size;
    for (const [id, c] of candidates) {
      if (!seen.has(id)) {
        dump.unseen.push({
          tgUserId: c.tgUserId,
          username: c.username ?? null,
          contactedAt: c.contactedAt,
        });
      }
    }
    if (dump.candidatesUnseen > 0) {
      // Предупреждение в лог И в сводку: тихая потеря входящих — худшее,
      // что может делать этот инструмент. Человек доверяет ему вместо того,
      // чтобы листать телеграм руками.
      this.logger.warn(
        `Выгрузка: не осмотрено ${dump.candidatesUnseen} кандидатов — ` +
          `их диалоги вне окна обхода (DIALOGS_LIMIT=${this.config.limit})`,
      );
    }
    this.logger.log(
      `Выгрузка: нужен ответ ${dump.dialogs.length}, тривиальных ${dump.trivial.length}` +
        (dump.accounts.length > 1
          ? ` (${dump.accounts.map((a) => `${a.title}: ${a.needReply}`).join(', ')})`
          : ''),
    );
    return dump;
  }

  /**
   * Сбор отзывов о продукте по всей переписке: `yarn reviews`.
   *
   * Обход тяжёлый — читаем полную историю каждого диалога, — поэтому идём
   * только по тем, кто отвечал (см. getReviewCandidates). Ничего никуда не
   * отправляет: только читает и складывает в файл, который потом смотрит
   * человек.
   */
  public async collectReviews(limit: number): Promise<ReviewsDump> {
    const candidates = await this.leads.getReviewCandidates();

    const dump: ReviewsDump = {
      createdAt: formatStamp(new Date()),
      dialogsSeen: 0,
      entries: [],
      stoppedBecause: 'кандидаты закончились',
    };

    // Один человек — один отзыв, даже если он есть в личке у обоих.
    const done = new Set<string>();

    for await (const { dialog, account } of this.eachDialog()) {
      if (dump.entries.length >= limit) {
        dump.stoppedBecause = `упёрлись в лимит выгрузки (${limit})`;
        break;
      }
      if (!dialog.isUser) continue;
      const entity = dialog.entity;
      if (!(entity instanceof Api.User)) continue;

      const candidate = candidates.get(entity.id.toString());
      if (!candidate) continue;
      if (done.has(candidate.tgUserId)) continue;
      if (!this.ownsDialog(account, candidate.assignedAccount)) continue;
      done.add(candidate.tgUserId);
      dump.dialogsSeen += 1;

      let messages;
      try {
        messages = await account.client.getMessages(entity, {
          limit: this.config.deepLimit,
        });
        await sleep(this.config.deepDelayMs);
      } catch (err) {
        this.logger.warn(
          `Отзывы: id${candidate.tgUserId} — история недоступна: ${describeError(err)}`,
        );
        continue;
      }

      const found = detectReview(
        messages.map((m: Api.Message): HistoryMessage => ({
          out: m.out === true,
          date: m.date,
          message: m.message ?? '',
        })),
      );
      if (!found) continue;

      const name = [entity.firstName, entity.lastName].filter(Boolean).join(' ').trim();
      const entry: ReviewEntry = {
        tgUserId: candidate.tgUserId,
        username: entity.username ?? null,
        displayName: name.length > 0 ? name : 'без имени',
        about: candidate.sampleText,
        consent: found.consent,
        consentAsk: found.consentAsk,
        consentAnswer: found.consentAnswer,
        quotes: found.quotes,
      };
      dump.entries.push(entry);
    }

    this.logger.log(
      `Отзывы: найдено ${dump.entries.length} из ${dump.dialogsSeen} диалогов`,
    );
    return dump;
  }

  /**
   * Аватарки для карточек лендинга.
   *
   * Идём по диалогам и сверяем id, а не дёргаем getEntity по нику: ник
   * человек меняет, id — нет, и access hash у нас уже есть из диалога.
   *
   * Фото может не быть вовсе (закрытый профиль, нет аватарки) — тогда просто
   * не кладём в карту. Карточка должна уметь жить без картинки: падать из-за
   * чужих настроек приватности здесь нечему.
   */
  public async downloadAvatars(tgUserIds: string[]): Promise<Map<string, Buffer>> {
    const wanted = new Set(tgUserIds);
    const out = new Map<string, Buffer>();
    if (wanted.size === 0) return out;

    for await (const { dialog, account } of this.eachDialog()) {
      if (out.size >= wanted.size) break;
      if (!dialog.isUser) continue;
      const entity = dialog.entity;
      if (!(entity instanceof Api.User)) continue;

      const id = entity.id.toString();
      if (!wanted.has(id)) continue;
      // Аватарка у человека одна — если её уже скачали с другого аккаунта,
      // второй раз не ходим.
      if (out.has(id)) continue;

      try {
        const buf = await account.client.downloadProfilePhoto(entity, { isBig: true });
        await sleep(this.config.deepDelayMs);
        if (buf && buf.length > 0) out.set(id, Buffer.from(buf as Buffer));
      } catch (err) {
        this.logger.warn(`Аватарка id${id} не скачалась: ${describeError(err)}`);
      }
    }

    return out;
  }

  /** Идёт ли прогон outbox: параллельно запускать нельзя, см. ниже. */
  public isSending(): boolean {
    return this.sending;
  }

  /**
   * Отправка ответов, подготовленных в outbox.
   *
   * Перед КАЖДОЙ отправкой история диалога перечитывается — в том числе в
   * предпросмотре. Лишние запросы того стоят: предпросмотр, который проверяет
   * не то же, что боевой прогон, показывает не то, что произойдёт.
   *
   * Идемпотентность держится на двух вещах, а не на одном guard'е по истории:
   * guard закрывает случай «человек больше ничего не написал», а сравнение со
   * стампом выгрузки — случай «написал». Стампа в имени файла нет — ни один
   * SEND не уходит: дешевле отложить лид до следующей выгрузки, чем прислать
   * ему второе такое же сообщение.
   *
   * Латч на время прогона: два параллельных запуска успевают оба прочитать
   * историю до того, как первый отправит, и guard пропускает обоих. Тот же
   * приём, что у скана (`ScannerService.isRunning`).
   */
  public async sendPreparedReplies(
    entries: OutboxEntry[],
    options: SendPreparedOptions,
  ): Promise<OutboxSendResult> {
    this.sending = true;
    try {
      return await this.runPreparedReplies(entries, options);
    } finally {
      // Снимаем на любом выходе, включая брошенное исключение: залипший латч
      // означает «отправка больше не запускается до перезапуска процесса».
      this.sending = false;
    }
  }

  private async runPreparedReplies(
    entries: OutboxEntry[],
    options: SendPreparedOptions,
  ): Promise<OutboxSendResult> {
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
    const hadSendEntries = entries.some((e) => e.directive === 'send');

    // Всё, для чего Telegram не нужен, разбираем до прохода и в порядке файла.
    for (const entry of entries) {
      // ASK ничего не отправляет: тело — вопрос к автору.
      if (entry.directive === 'ask') {
        pending.delete(entry.tgUserId);
        result.asked += 1;
        result.entries.push(sendEntry(entry, 'asked'));
        continue;
      }

      // CLOSE — это markAnswered по id из файла, диалог для него не нужен.
      // Разбираем здесь, а не в общем обходе: до записи проход может не
      // дойти (лимит отправок, обрыв на ошибке), и тогда она осела бы в
      // notFound необработанной. markAnswered НЕ защищает от повторного
      // появления в следующей выгрузке — inbox смотрит на неотвеченный
      // хвост истории, а не на статус лида (от этого спасает только
      // `yarn skip`, см. docs/reply-guidelines.md); реальный эффект пометки —
      // запись уходит из worklist `yarn replies` (getRepliesWorklist
      // фильтрует status='replied') и notFound остаётся точным.
      if (entry.directive === 'close') {
        pending.delete(entry.tgUserId);

        // Тот же guard, что у SEND ниже: id пришёл из файла непроверенным, а
        // markAnswered — безусловный UPDATE по tg_user_id. Без сверки с
        // кандидатами опечатка в цифре тихо переводит в answered чужого лида.
        const candidate = candidates.get(entry.tgUserId);
        if (!candidate) {
          result.skipped += 1;
          result.entries.push(
            sendEntry(
              entry,
              'skipped',
              'нет среди кандидатов: помечен skip/rejected или id не тот',
            ),
          );
          continue;
        }

        result.closed += 1;
        if (!options.dryRun) {
          try {
            await this.leads.markAnswered(entry.tgUserId);
          } catch (err) {
            this.logger.warn(
              `CLOSE id${entry.tgUserId}: markAnswered упал: ${describeError(err)}`,
            );
          }
        }
        result.entries.push(sendEntry(entry, options.dryRun ? 'preview' : 'closed'));
        continue;
      }

      // SEND без стампа в имени файла: fail-closed. Если человек ответил на
      // наш ответ («спасибо!»), неотвеченное снова непусто, а курсор стоит на
      // нашем же сообщении — от повторной отправки того же текста защищает
      // ровно сравнение со стампом. Нет стампа — нет защиты.
      //
      // FOLLOWUP сюда не попадает: у него защита от дубля своя и от стампа
      // не зависит — сверка текста с нашими исходящими в этом же диалоге.
      if (entry.directive === 'send' && options.dumpedAtSec === null) {
        pending.delete(entry.tgUserId);
        result.skipped += 1;
        result.entries.push(
          sendEntry(
            entry,
            'skipped',
            'в имени файла нет стампа, повторный запуск мог бы отправить дубль — ' +
              'переименуй в YYYY-MM-DD-HHMM.md',
          ),
        );
      }
    }

    // Ранний выход ДО входа в цикл: `for await` дёрнул бы `iterDialogs` и
    // сходил в Telegram за первой страницей диалогов ещё до первой проверки в
    // теле. Файл, в котором отправлять нечего, не должен трогать сеть вовсе.
    if (pending.size === 0) {
      // Две разные причины ничего не обходить — печатаем ту, что реально
      // случилась, а не общую формулировку «записи закончились»: она
      // подразумевает прошедший обход, а его тут не было вовсе.
      result.stoppedBecause =
        options.dumpedAtSec === null && hadSendEntries
          ? 'в имени файла нет стампа выгрузки — SEND отправлять было нельзя'
          : 'в файле только CLOSE/ASK — по диалогам идти незачем';
      this.logger.log(`Outbox ${options.file}: отправлять нечего, Telegram не трогали`);
      return result;
    }

    for await (const { dialog, account } of this.eachDialog()) {
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

      // Отвечает тот аккаунт, который вёл переписку. Пропускаем, НЕ удаляя
      // из pending: этот же человек встретится дальше в личке своего
      // аккаунта, и там ответ уйдёт. Удалить здесь — значит потерять его.
      const assigned = candidates.get(id)?.assignedAccount ?? null;
      if (!this.ownsDialog(account, assigned)) continue;

      pending.delete(id);

      // Кому писать — решает база, а не файл: человека могли пометить
      // skip/rejected уже после выгрузки, а опечатка в цифре id уводит ответ
      // в посторонний диалог. Проверяем до чтения истории: оно дорогое.
      const candidate = candidates.get(id);
      if (!candidate) {
        result.skipped += 1;
        result.entries.push(
          sendEntry(
            entry,
            'skipped',
            'нет среди кандидатов: помечен skip/rejected или id не тот',
          ),
        );
        continue;
      }

      // SEND: перечитываем историю и решаем, актуален ли ещё черновик.
      let messages;
      try {
        messages = await account.client.getMessages(dialogEntity, {
          limit: this.config.deepLimit,
        });
        await sleep(this.config.deepDelayMs);
      } catch (err) {
        result.skipped += 1;
        result.entries.push(
          sendEntry(entry, 'skipped', `история недоступна: ${describeError(err)}`),
        );
        continue;
      }

      if (entry.directive === 'followup') {
        // Повод написать возник у НАС, а не у человека: неотвеченного в
        // диалоге нет по построению, и guard'ы SEND здесь неприменимы.
        // Вместо них — сверка текста: ровно это сообщение мы ему уже
        // отправляли? Защита не зависит ни от курсора, ни от стампа файла,
        // поэтому переживает повторный запуск той же пачки.
        const already = messages.some(
          (m: Api.Message) => m.out === true && sameText(m.message ?? '', entry.body),
        );
        if (already) {
          result.skipped += 1;
          result.entries.push(
            sendEntry(entry, 'skipped', 'этот текст ему уже отправляли'),
          );
          continue;
        }
      } else {
        const slice = sliceUnanswered(toHistory(messages), cursorFloorSec(candidate));

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
          result.entries.push(
            sendEntry(entry, 'skipped', 'написал ещё раз после выгрузки'),
          );
          continue;
        }
      }

      if (options.dryRun) {
        result.sent += 1;
        result.entries.push(sendEntry(entry, 'preview'));
        continue;
      }

      try {
        // parseMode: false — тело писал ассистент В MARKDOWN-ФАЙЛ, где `**`,
        // `~~` и бэктики родная разметка. Парсер GramJS (он включён по
        // умолчанию) вырезает непарный делимитер молча, и человек получает не
        // те байты, которые автор вычитал. Глобально не выключаем: холодное
        // письмо в sender.service шлётся из body.md и на разметку опирается.
        await account.client.sendMessage(dialogEntity, {
          message: entry.body,
          parseMode: false,
        });
      } catch (err) {
        const message = describeError(err);
        result.entries.push(sendEntry(entry, 'failed', message));
        result.stoppedBecause = `ошибка отправки: ${message}`;
        break;
      }

      // Чат прочитан — мы только что на него ответили. Без этого синий
      // кружок висит вечно: отправка через API сама по себе не помечает
      // диалог прочитанным, и счётчик непрочитанных перестаёт что-либо
      // значить. Ошибку глотаем: пометка — удобство, а не часть отправки.
      await account.client
        .markAsRead(dialogEntity)
        .catch((err) =>
          this.logger.warn(`Не пометил прочитанным: ${describeError(err)}`),
        );

      // Сообщение УШЛО. markAnswered отдельно: его сбой не имеет права выдать
      // отправленное за провал. Даже если пометка не пройдёт, следующая
      // выгрузка увидит наше исходящее и не предложит ответить второй раз.
      result.sent += 1;
      result.entries.push(sendEntry(entry, 'sent'));
      // markAnswered — только для ответа на входящее. FOLLOWUP пишем первыми,
      // и помечать им «мы ответили» нечего: человек нам ничего не писал.
      if (entry.directive !== 'followup') {
        try {
          await this.leads.markAnswered(id);
        } catch (err) {
          this.logger.error(
            `Ответ ушёл id${id}, но markAnswered упал: ${describeError(err)}`,
          );
        }
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
  private async hasOutgoing(account: TelegramAccount, user: Api.User): Promise<boolean> {
    try {
      const messages = await account.client.getMessages(user, {
        limit: this.config.deepLimit,
      });
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

/**
 * Нижняя граница курсора неотвеченного: позднейшее из «когда мы написали» и
 * «когда закрыли диалог без ответа».
 *
 * Общая функция, а не два одинаковых куска: выгрузка и отправка обязаны
 * считать курсор одинаково. Разъедутся — предпросмотр покажет одно, а
 * отправка сделает другое.
 */
/**
 * Кто перед нами: сначала по id, потом по @нику.
 *
 * Ник в Telegram уникален в каждый момент времени, поэтому совпадение по
 * нему — не догадка. А вот id в нашей базе может быть от другого человека:
 * см. комментарий к `byUsername` в collectUnanswered.
 */
function matchCandidate(
  byId: Map<string, DialogCandidate>,
  byUsername: Map<string, DialogCandidate>,
  entity: Api.User,
): DialogCandidate | null {
  const direct = byId.get(entity.id.toString());
  if (direct) return direct;

  const nick = entity.username?.trim().toLowerCase();
  return nick ? (byUsername.get(nick) ?? null) : null;
}

function cursorFloorSec(candidate: {
  contactedAt: Date | null;
  closedAt: Date | null;
}): number {
  return Math.max(toUnixSec(candidate.contactedAt), toUnixSec(candidate.closedAt));
}

function toUnixSec(at: Date | null): number {
  return at ? Math.floor(at.getTime() / 1000) : 0;
}

/**
 * Текст сообщения для выгрузки — с меткой вместо пустоты у вложений.
 *
 * Голосовое, кружок, фото и файл приходят с ПУСТЫМ `message`, а оба фильтра
 * пустого текста (пред-фильтр диалога и `sliceUnanswered`) выбрасывали такие
 * сообщения молча. Человек присылал голосовое — и для инструмента просто
 * исчезал. Живой случай 09.09: руководитель репетиторского центра записал
 * двухминутное голосовое с вопросом, а нашли его только глазами в телеграме.
 *
 * Расшифровать мы не умеем, поэтому подставляем метку. Она длиннее
 * NEUTRAL_CLEAR_MAXLEN, поэтому эвристика не закроет такой диалог как
 * «короткое ок» — он попадёт в «нужен ответ», где его и увидит человек.
 *
 * Стикер меткой не помечаем: это не вопрос, и в выгрузке он был бы шумом.
 */
/**
 * История диалога в виде, который понимает sliceUnanswered.
 *
 * Ровно одна функция на оба места, где мы это делаем, — выгрузку inbox и
 * отправку outbox. Раньше их было две, и они разъехались: выгрузка брала
 * текст через messageText (голосовое и фото превращаются в подпись-заглушку),
 * а отправка — сырой m.message. Из-за этого sliceUnanswered у отправщика
 * считал сообщение пустым, входящих не находил и объявлял «ты ответил
 * руками» — то есть человек, приславший голосовое или фото без подписи, не
 * получал подготовленный ответ НИКОГДА. Так молча висели три недели два
 * живых диалога: в одном пришло фото, в другом голосовое.
 */
function toHistory(messages: Api.Message[]): HistoryMessage[] {
  return messages.map((m) => ({
    out: m.out === true,
    date: m.date,
    message: messageText(m),
  }));
}

function messageText(m: Api.Message): string {
  const text = (m.message ?? '').trim();
  if (text.length > 0) return text;
  const label = mediaLabel(m);
  return label ? `[${label} — расшифровки нет, нужно открыть в телеграме]` : '';
}

function mediaLabel(m: Api.Message): string | null {
  // Свойства-хелперы GramJS (voice, videoNote, photo…) в типах объявлены
  // не все, поэтому читаем через индекс: ошибиться тут безопасно — в худшем
  // случае получим общее «вложение».
  const msg = m as unknown as Record<string, unknown>;
  if (!msg.media) return null;
  if (msg.voice) return 'голосовое сообщение';
  if (msg.videoNote) return 'видеосообщение';
  if (msg.sticker) return null;
  if (msg.photo) return 'фото';
  if (msg.video) return 'видео';
  if (msg.document) return 'файл';
  return 'вложение';
}

/**
 * Тот же ли это текст. Сравниваем по схлопнутым пробелам: Telegram отдаёт
 * отправленное сообщение слово в слово, но перевод строки в конце и двойные
 * пробелы из markdown-файла до него не доезжают.
 */
function sameText(a: string, b: string): boolean {
  const norm = (t: string) => t.replace(/\s+/g, ' ').trim();
  return norm(a).length > 0 && norm(a) === norm(b);
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
    // Тело несём только у ASK: его печатает итог, чтобы автор выбирал
    // вариант из терминала. Тела send и close в выводе не нужны.
    body: entry.directive === 'ask' ? entry.body : undefined,
  };
}
