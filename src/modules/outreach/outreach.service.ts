import { Injectable, Logger } from '@nestjs/common';
import { DialogsService } from '@modules/dialogs/dialogs.service';
import { LeadService } from '@modules/lead/lead.service';
import { LeadStatus } from '@modules/lead/lead.entity';
import { ScannerService } from '@modules/scanner/scanner.service';
import {
  formatOutreachList,
  formatRefreshSummary,
} from '@modules/outreach/outreach.format';
import { formatRepliesWorklist } from '@modules/outreach/replies.format';

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
    const head =
      `\nПересчёт: проверено ${stat.checked}, ответивших ${stat.replied}` +
      (stat.skippedNoUsername ? `, без ника пропущено ${stat.skippedNoUsername}` : '') +
      '\n';
    return head + (await this.replies());
  }

  /** Worklist ответивших без похода в Telegram — из базы. */
  public async replies(): Promise<string> {
    return formatRepliesWorklist(await this.leads.getRepliesWorklist());
  }

  public async mark(usernames: string[], status: LeadStatus): Promise<string> {
    const affected = await this.leads.markByUsernames(usernames, status);
    this.logger.log(`Помечено как ${status}: ${affected}`);

    if (affected === 0) {
      return `\nНикого не нашёл по этим никам. Проверь написание.\n`;
    }
    return `\nПомечено как ${status}: ${affected}\n`;
  }
}
