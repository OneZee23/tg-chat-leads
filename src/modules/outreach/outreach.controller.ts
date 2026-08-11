import { Controller, Get, Header, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { LEAD_STATUSES, LeadStatus } from '@modules/lead/lead.entity';
import { OutreachService } from '@modules/outreach/outreach.service';

class LimitQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  public readonly limit?: number;
}

class MarkQueryDto {
  @IsString()
  @MaxLength(4000)
  public readonly usernames: string;

  @IsOptional()
  @IsIn(LEAD_STATUSES as unknown as string[])
  public readonly status?: LeadStatus;
}

/**
 * Всё отдаётся текстом: это интерфейс для человека в терминале, а не API
 * для другой программы. Машиночитаемое лежит рядом — /leads и /leads/export.csv.
 */
@Controller('outreach')
export class OutreachController {
  constructor(private readonly outreach: OutreachService) {}

  /** Разовое обновление и список: `yarn refresh`. */
  @Post('refresh')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  public refresh(@Query() query: LimitQueryDto): Promise<string> {
    return this.outreach.refresh(query.limit ?? 30);
  }

  /** Только список, без похода в Telegram: `yarn leads`. */
  @Get('next')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  public next(@Query() query: LimitQueryDto): Promise<string> {
    return this.outreach.next(query.limit ?? 30);
  }

  /**
   * Полный пересчёт ответов по истории диалогов + worklist: `yarn recount`.
   * Дорого (запрос к Telegram на каждого, кому писали) — запускать по мере
   * надобности, а не каждый раз.
   */
  @Post('recount-replies')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  public recountReplies(): Promise<string> {
    return this.outreach.recountAndListReplies();
  }

  /** Worklist ответивших из базы, без Telegram: `yarn replies`. */
  @Get('replies')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  public replies(): Promise<string> {
    return this.outreach.replies();
  }

  /**
   * Ручная пометка по никам:
   *   curl -s -XPOST 'http://127.0.0.1:3010/outreach/mark?status=skip&usernames=@a,@b'
   */
  @Post('mark')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  public mark(@Query() query: MarkQueryDto): Promise<string> {
    const usernames = query.usernames.split(',');
    return this.outreach.mark(usernames, query.status ?? 'contacted');
  }
}
