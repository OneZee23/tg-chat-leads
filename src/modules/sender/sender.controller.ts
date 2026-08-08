import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { LeadService } from '@modules/lead/lead.service';
import { SendAttemptService } from '@modules/sender/send-attempt.service';
import { SendSchedulerService } from '@modules/sender/send-scheduler.service';
import { SenderConfig } from '@modules/sender/sender.config';
import { SenderService } from '@modules/sender/sender.service';

class RunSendDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  public readonly limit?: number;
}

class RecentQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  public readonly limit?: number;
}

@Controller('send')
export class SenderController {
  constructor(
    private readonly sender: SenderService,
    private readonly scheduler: SendSchedulerService,
    private readonly attempts: SendAttemptService,
    private readonly leads: LeadService,
    private readonly config: SenderConfig,
  ) {}

  /**
   * Разовая пачка. Ограничена суточным бюджетом независимо от limit.
   * curl -sS -XPOST http://127.0.0.1:3010/send/run -H 'content-type: application/json' -d '{"limit":5}'
   */
  @Post('run')
  public run(@Body() body: RunSendDto) {
    return this.sender.run(body.limit);
  }

  /** Размазанная по дню рассылка вместо пачки. */
  @Post('schedule/start')
  public startSchedule() {
    return { ...this.scheduler.start(), status: this.scheduler.status() };
  }

  @Post('schedule/stop')
  public stopSchedule() {
    return { ...this.scheduler.stop(), status: this.scheduler.status() };
  }

  @Get('status')
  public async status(@Query() query: RecentQueryDto) {
    const budget = await this.attempts.budget(this.config.maxPerDay);
    const unfinished = await this.attempts.listUnfinished();

    return {
      running: this.sender.isRunning(),
      dryRun: this.config.dryRun,
      dailyBudget: budget,
      scheduler: this.scheduler.status(),
      // Отправка началась, исход неизвестен. Такие надо разобрать руками:
      // открыть диалог и посмотреть, ушло сообщение или нет.
      unfinishedAttempts: unfinished,
      recentAttempts: await this.attempts.recent(query.limit ?? 20),
    };
  }

  /**
   * Вернуть в очередь тех, кто застрял в `sending` после аварийной
   * остановки процесса.
   *
   * Возвращаются только те, у кого в журнале нет следа отправки.
   * Остальные приходят в `keptForReview` — им сообщение, скорее всего,
   * уже ушло, и решать по ним надо глядя в диалог, а не в статус.
   * Разобрался — `yarn wrote @ник`.
   */
  @Post('release-stuck')
  public releaseStuck() {
    return this.leads.releaseStuckSending();
  }
}
