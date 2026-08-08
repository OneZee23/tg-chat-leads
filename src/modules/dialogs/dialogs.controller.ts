import { Controller, Get, Post, Query } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';
import { DialogsService } from '@modules/dialogs/dialogs.service';

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
   * Пометить лидов, которым уже писал, чтобы не написать второй раз.
   * curl -XPOST http://127.0.0.1:3010/leads/sync-contacted | jq
   */
  @Post('leads/sync-contacted')
  public syncContacted() {
    return this.dialogs.syncContacted();
  }
}
