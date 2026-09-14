import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { LeadsService } from '@modules/research/leads.service';
import type { LeadProfileName } from '@modules/research/leads.scoring';
import { ResearchService } from '@modules/research/research.service';

class RunResearchDto {
  /** Пусто — берём RESEARCH_CHATS из .env */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(128, { each: true })
  public readonly chats?: string[];

  /** Пусто — берём RESEARCH_QUERIES из .env */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(256, { each: true })
  public readonly queries?: string[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  public readonly perQueryLimit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  public readonly sinceDays?: number;
}

class RunLeadsDto extends RunResearchDto {
  /** Отсечь мелочь: кандидаты ниже порога в отчёт не попадают. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  public readonly minScore?: number;

  /**
   * Пусто — визовый профиль поиска рефереров (как всегда). Через env не
   * делаем: конфиг читается на старте, а профиль нужно менять между
   * прогонами без перезапуска сервера.
   */
  @IsOptional()
  @IsIn(['referral', 'tutor'])
  public readonly profile?: LeadProfileName;
}

@Controller('research')
export class ResearchController {
  constructor(
    private readonly research: ResearchService,
    private readonly leads: LeadsService,
  ) {}

  /**
   * Фоном: полный прогон по десятку запросов идёт минуты, держать на нём
   * curl незачем. За результатом — GET /research/status.
   */
  @Post('run')
  public run(@Body() body: RunResearchDto) {
    return this.research.startInBackground(body ?? {});
  }

  /** Синхронно, для одного-двух запросов: удобно проверить формулировку. */
  @Post('run-sync')
  public runSync(@Body() body: RunResearchDto) {
    return this.research.run(body ?? {});
  }

  /**
   * Лиды — это другая единица: не «что сказали про визу», а «кому написать».
   * Поэтому отдельный эндпоинт, а не флаг у research/run.
   */
  @Post('leads')
  public runLeads(@Body() body: RunLeadsDto) {
    return this.leads.startInBackground(body ?? {});
  }

  @Get('leads/status')
  public leadsStatus(@Query('full') full?: string) {
    const last = this.leads.getLastSummary();
    return {
      running: this.leads.isRunning(),
      lastSummary: last && full !== 'true' ? { ...last, candidates: undefined } : last,
    };
  }

  @Get('status')
  public status(@Query('full') full?: string) {
    const last = this.research.getLastSummary();
    return {
      running: this.research.isRunning(),
      // По умолчанию без самих находок: их сотни, и в терминале это простыня.
      // Читать дайджест надо файлом, ссылка на него тут же.
      lastSummary: last && full !== 'true' ? { ...last, hits: undefined } : last,
    };
  }
}
