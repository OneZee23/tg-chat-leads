import { Injectable, Logger } from '@nestjs/common';
import { DialogsService } from '@modules/dialogs/dialogs.service';
import { LeadService } from '@modules/lead/lead.service';
import { LeadStatus } from '@modules/lead/lead.entity';
import { ScannerService } from '@modules/scanner/scanner.service';
import {
  formatOutreachList,
  formatRefreshSummary,
} from '@modules/outreach/outreach.format';
import {
  formatAutoReplyResult,
  formatRepliesWorklist,
} from '@modules/outreach/replies.format';
import { formatInbox, formatInboxSummary } from '@modules/outreach/inbox.format';
import { formatOutboxResult } from '@modules/outreach/outbox.format';
import {
  OutboxEntry,
  OutboxParseError,
  extractRecordIds,
  parseOutbox,
} from '@modules/outreach/outbox.parse';
import {
  inboxFileName,
  newestOutboxName,
  parseDumpTimestamp,
  readInbox,
  readOutbox,
  writeInbox,
  UnsafeFileNameError,
} from '@modules/outreach/reply-files';
import { FloodWaitTracker } from '@modules/telegram/flood-wait.tracker';

/**
 * Один сценарий на каждый день, чтобы не помнить три ручки и их порядок.
 *
 * Порядок здесь важен и он не произвольный:
 *   1. скан — добираем новых людей из чатов (только новые сообщения, курсор
 *      хранится в базе);
 *   2. сверка с личкой — убираем тех, кому уже писал, в том числе тех, кому
 *      написал час назад из этого же списка;
 *   3. выдача — что осталось.
 *
 * Если поменять 1 и 2 местами, свежедобавленные лиды не пройдут сверку и
 * ты рискуешь написать человеку второй раз.
 */
@Injectable()
export class OutreachService {
  private readonly logger = new Logger(OutreachService.name);

  constructor(
    private readonly scanner: ScannerService,
    private readonly dialogs: DialogsService,
    private readonly leads: LeadService,
    private readonly flood: FloodWaitTracker,
  ) {}

  public async refresh(limit: number): Promise<string> {
    if (this.scanner.isRunning()) {
      return '\nСкан уже идёт. Подожди и повтори — параллельно запускать нельзя.\n';
    }

    const scan = await this.scanner.runAll();
    const contacted = await this.dialogs.syncContacted();

    const summary = formatRefreshSummary({
      messagesSeen: scan.totals.messagesSeen,
      newLeads: scan.totals.leadsCreated,
      contactedMarked: contacted.leadsMarked,
      repliedMarked: contacted.repliedMarked,
      outreach: await this.leads.outreachSummary(),
      chats: scan.chats.map((chat) => ({
        chat: chat.chat,
        messagesSeen: chat.messagesSeen,
        error: chat.error,
      })),
    });

    return `${summary}\n${await this.next(limit)}`;
  }

  public async next(limit: number): Promise<string> {
    const { total, items } = await this.leads.findForOutreach(limit);
    return formatOutreachList({ leads: items, total });
  }

  /** Полный пересчёт ответов по истории диалогов + worklist. */
  public async recountAndListReplies(): Promise<string> {
    const stat = await this.dialogs.recountReplies();
    const active = this.flood.active();
    const floodLine = active.length
      ? `\n⚠ Лимиты Telegram: ${this.flood.summary()}\n`
      : '';
    const head =
      `\nПересчёт: проверено ${stat.checked}, ждут ответа ${stat.replied}, ` +
      `уже отвечено ${stat.answered}` +
      (stat.deepReads ? ` (глубоких чтений ${stat.deepReads})` : '') +
      '\n' +
      floodLine;
    return head + (await this.replies());
  }

  /** Worklist ответивших без похода в Telegram — из базы. */
  public async replies(): Promise<string> {
    return formatRepliesWorklist(await this.leads.getRepliesWorklist());
  }

  /**
   * Авто-ответ шаблоном тем, кто ответил и кому мы ещё не отвечали.
   * dryRun=true (по умолчанию) — только показать, кому что уйдёт.
   */
  public async autoReply(dryRun: boolean, limit: number): Promise<string> {
    const result = await this.dialogs.autoReplyUnanswered({ dryRun, limit });
    return formatAutoReplyResult(result);
  }

  public async mark(usernames: string[], status: LeadStatus): Promise<string> {
    const affected = await this.leads.markByUsernames(usernames, status);
    this.logger.log(`Помечено как ${status}: ${affected}`);

    if (affected === 0) {
      return `\nНикого не нашёл по этим никам. Проверь написание.\n`;
    }
    return `\nПомечено как ${status}: ${affected}\n`;
  }

  /** Выгрузка неотвеченного в файл: `yarn inbox`. */
  public async inbox(limit: number): Promise<string> {
    // Стамп снимаем ДО обхода, а не после. Обход идёт минутами (пауза на
    // каждое чтение истории), и стамп с его конца оказывается позже, чем
    // сообщения, пришедшие уже во время обхода: guard перед отправкой их не
    // считает свежими и мы отвечаем на устаревшую реплику. Стамп с начала
    // ошибается в другую сторону — лишний пропуск, лид уедет в следующий inbox.
    const name = inboxFileName(new Date());
    const dump = await this.dialogs.collectUnanswered(limit);
    const path = writeInbox(name, formatInbox(dump));
    return formatInboxSummary(dump, path);
  }

  /**
   * Отправка ответов из outbox: `yarn outbox` (предпросмотр) и
   * `yarn outbox:send`. Без имени файла берём самый свежий — так у команды
   * без аргументов есть осмысленное поведение.
   */
  public async outboxSend(
    file: string | undefined,
    send: boolean,
    limit: number,
  ): Promise<string> {
    // Два прогона внахлёст успевают оба прочитать историю до того, как первый
    // отправит, и guard по свежести пропускает обоих: человек получает дубль.
    // Ровно та же защита, что у скана выше.
    if (this.dialogs.isSending()) {
      return '\nПрогон outbox уже идёт. Подожди и повтори — параллельно запускать нельзя.\n';
    }

    const name = file ?? newestOutboxName();
    if (!name) {
      return '\nВ outbox/ нет ни одного .md — сначала попроси ассистента написать ответы по файлу из inbox/.\n';
    }

    let raw: string;
    try {
      raw = readOutbox(name);
    } catch (err) {
      if (err instanceof UnsafeFileNameError) return `\n${err.message}\n`;
      throw err;
    }

    let entries;
    try {
      entries = parseOutbox(raw);
    } catch (err) {
      // Разбор упал — значит не отправлено ничего. Это и есть задуманное
      // поведение, поэтому текст ошибки печатаем как обычный ответ.
      if (err instanceof OutboxParseError) {
        return `\nФайл outbox/${name} не разобран, ничего не отправлено:\n${err.message}\n`;
      }
      throw err;
    }

    const result = await this.dialogs.sendPreparedReplies(entries, {
      dryRun: !send,
      limit,
      file: name,
      dumpedAtSec: parseDumpTimestamp(name),
      untouched: this.countUntouched(name, entries),
    });
    return formatOutboxResult(result);
  }

  /**
   * Сколько диалогов из выгрузки остались без записи в outbox.
   *
   * Считается по самому inbox-файлу, а не по результату прохода: иначе
   * человек, для которого ответ просто не написали, нигде не всплывёт —
   * ровно та молчаливая потеря лида, от которой мы уходим. Формат заголовка
   * у inbox и outbox один, поэтому хватает `extractRecordIds`.
   *
   * null — выгрузки на диске уже нет: сверять не по чему, и итог скажет это
   * прямым текстом вместо честного на вид нуля.
   */
  private countUntouched(name: string, entries: OutboxEntry[]): number | null {
    const dump = readInbox(name);
    if (dump === null) return null;
    const answered = new Set(entries.map((e) => e.tgUserId));
    return extractRecordIds(dump).filter((id) => !answered.has(id)).length;
  }
}
