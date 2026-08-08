import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
} from '@nestjs/common';
import { ListLeadsQueryDto } from '@modules/lead/dto/list-leads.query.dto';
import { UpdateLeadStatusDto } from '@modules/lead/dto/update-lead-status.dto';
import { LeadService } from '@modules/lead/lead.service';

@Controller('leads')
export class LeadController {
  constructor(private readonly leads: LeadService) {}

  @Get()
  public list(@Query() query: ListLeadsQueryDto) {
    return this.leads.list(query);
  }

  @Get('stats')
  public stats() {
    return this.leads.stats();
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

  @Patch(':id/status')
  public updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateLeadStatusDto,
  ) {
    return this.leads.updateStatus(id, body.status, body.note);
  }
}
