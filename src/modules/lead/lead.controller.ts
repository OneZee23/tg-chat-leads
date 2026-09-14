import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ImportLeadsDto } from '@modules/lead/dto/import-leads.dto';
import { ListLeadsQueryDto } from '@modules/lead/dto/list-leads.query.dto';
import { UpdateLeadStatusDto } from '@modules/lead/dto/update-lead-status.dto';
import { LeadImportService } from '@modules/lead/lead-import.service';
import { LeadService } from '@modules/lead/lead.service';

@Controller('leads')
export class LeadController {
  constructor(
    private readonly leads: LeadService,
    private readonly importer: LeadImportService,
  ) {}

  @Get()
  public list(@Query() query: ListLeadsQueryDto) {
    return this.leads.list(query);
  }

  @Get('stats')
  public async stats() {
    // Разрез по источникам берём из outreachSummary — того же расчёта,
    // который печатает `yarn refresh`. Второй формулы одной метрики быть
    // не должно: разойдутся они молча, и врать начнёт та, на которую смотрят.
    const { bySource } = await this.leads.outreachSummary();
    return { ...(await this.leads.stats()), bySource };
  }

  /**
   * curl -s 'http://127.0.0.1:3010/leads/export.csv?minScore=3&hasUsername=true' > leads.csv
   */
  @Get('export.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="leads.csv"')
  public exportCsv(@Query() query: ListLeadsQueryDto): Promise<string> {
    return this.leads.exportCsv(query);
  }

  /**
   * Завести контакты, найденные вне Telegram (Google, Яндекс, Instagram).
   *
   * Синхронно и без фонового режима: пачка ограничена MAX_IMPORT_BATCH, и
   * ответ нужен построчный — какая строка завелась, какая нет и почему.
   * Одна неудачная (нет такого ника, удалён, закрыт приватностью) не должна
   * ронять остальные: список собирают руками, и переносить его целиком
   * из-за одной опечатки — верный способ импортировать дважды.
   *
   *   curl -sS -XPOST 'http://127.0.0.1:3010/leads/import' \
   *     -H 'Content-Type: application/json' -d '{
   *       "source": "google",
   *       "items": [
   *         { "contact": "@example_tutor", "note": "репетиторы.ру, английский" },
   *         { "contact": "https://t.me/another_tutor", "name": "Мария" }
   *       ]
   *     }'
   */
  @Post('import')
  public import(@Body() body: ImportLeadsDto) {
    return this.importer.import(body);
  }

  @Patch(':id/status')
  public updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateLeadStatusDto,
  ) {
    return this.leads.updateStatus(id, body.status, body.note);
  }
}
