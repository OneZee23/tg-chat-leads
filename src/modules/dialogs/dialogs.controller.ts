import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Controller, Get, Header, Post, Query } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';
import { DialogsService } from '@modules/dialogs/dialogs.service';
import { formatWaiting } from '@modules/outreach/waiting.format';

class ListChatsQueryDto {
  /**
   * Дотянуть число участников для супергрупп. Это отдельный запрос на чат,
   * поэтому по умолчанию выключено.
   */
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string'
      ? ['true', '1', 'yes'].includes(value.toLowerCase())
      : value,
  )
  @IsBoolean()
  public readonly withCounts?: boolean;
}

@Controller()
export class DialogsController {
  constructor(private readonly dialogs: DialogsService) {}

  /**
   * curl -s 'http://127.0.0.1:3010/chats?withCounts=true' | jq
   */
  @Get('chats')
  public async listChats(@Query() query: ListChatsQueryDto) {
    const chats = await this.dialogs.listChats(query.withCounts === true);

    return {
      total: chats.length,
      // Готовая строка для .env — остаётся вычеркнуть лишнее.
      scanChatsLine: `SCAN_CHATS=${chats.map((c) => c.ref).join(',')}`,
      chats,
    };
  }

  /**
   * Кто ждёт ответа по телеграму: `curl -XPOST .../dialogs/waiting`.
   *
   * Список строится по состоянию диалогов, а не по нашему учёту: закрытые
   * без ответа сюда попадают тоже, с пометкой когда и чем закончилось.
   */
  @Post('dialogs/waiting')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  public async waiting(): Promise<string> {
    return formatWaiting(await this.dialogs.collectWaiting());
  }

  /**
   * Погасить счётчик непрочитанных там, где мы уже ответили:
   * `curl -XPOST .../dialogs/mark-read`.
   */
  @Post('dialogs/mark-read')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  public async markRead(): Promise<string> {
    const { marked, left } = await this.dialogs.markAnsweredRead();
    return (
      `\nПогашено непрочитанных там, где мы уже ответили: ${marked}.\n` +
      `Осталось с кружком: ${left} — это те, где последним написал человек.\n`
    );
  }

  /**
   * Разовая диагностика списка диалогов: `curl -XPOST .../dialogs/dump`.
   * Пишет CSV в export/ — он в gitignore, там ники живых людей.
   */
  @Post('dialogs/dump')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  public async dumpDialogs(): Promise<string> {
    const csv = await this.dialogs.dumpDialogs();
    const dir = join(process.cwd(), 'export');
    mkdirSync(dir, { recursive: true });
    const path = join(
      dir,
      `dialogs-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.csv`,
    );
    writeFileSync(path, csv, 'utf8');
    return `\nДиалоги выписаны: ${path}\n`;
  }

  /**
   * Пометить лидов, которым уже писал, чтобы не написать второй раз.
   * curl -XPOST http://127.0.0.1:3010/leads/sync-contacted | jq
   */
  @Post('leads/sync-contacted')
  public syncContacted() {
    return this.dialogs.syncContacted();
  }
}
