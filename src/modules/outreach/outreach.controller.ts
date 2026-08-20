import { Controller, Get, Header, Post, Query } from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
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

class AutoReplyQueryDto {
  /** Реально слать. По умолчанию false — сначала предпросмотр. */
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string'
      ? ['true', '1', 'yes'].includes(value.toLowerCase())
      : value,
  )
  @IsBoolean()
  public readonly send?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  public readonly limit?: number;
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
   * Авто-ответ шаблоном тем, кто ответил и кому ты ещё не отвечал.
   * Без `send=true` — только предпросмотр (`yarn autoreply`).
   * С `send=true` — реально отправляет (`yarn autoreply:send`).
   */
  @Post('auto-reply')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  public autoReply(@Query() query: AutoReplyQueryDto): Promise<string> {
    return this.outreach.autoReply(query.send !== true, query.limit ?? 40);
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
