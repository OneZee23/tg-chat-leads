import { Body, Controller, Get, Header, Post, Query } from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';
import { HELP_TEXT } from '@common/help.text';
import { formatSendReport, formatSendStatus } from '@modules/sender/send.format';
import { LeadService } from '@modules/lead/lead.service';
import { SendAttemptService } from '@modules/sender/send-attempt.service';
import { SendSchedulerService } from '@modules/sender/send-scheduler.service';
import { SenderConfig } from '@modules/sender/sender.config';
import { SenderService } from '@modules/sender/sender.service';
import { FloodWaitTracker } from '@modules/telegram/flood-wait.tracker';

class RunSendDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  public readonly limit?: number;

  /**
   * Реально слать. По умолчанию false — предпросмотр, как у `outbox/send`.
   *
   * Рассылка незнакомым людям — самое необратимое действие в инструменте:
   * получатели жалуются модераторам, и аккаунт зажимают (см.
   * `docs/postmortem-spam-ban.md`). Значит по умолчанию она показывает,
   * а не делает.
   */
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string'
      ? ['true', '1', 'yes'].includes(value.toLowerCase())
      : value,
  )
  @IsBoolean()
  public readonly send?: boolean;
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
    private readonly flood: FloodWaitTracker,
  ) {}

  /**
   * Разовая пачка. Ограничена суточным бюджетом независимо от limit.
   * curl -sS -XPOST http://127.0.0.1:3010/send/run -H 'content-type: application/json' -d '{"limit":5}'
   */
  @Post('run')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  public async run(@Body() body: RunSendDto): Promise<string> {
    const report = await this.sender.run(body.limit, body.send !== true);
    return formatSendReport(report);
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

  /** Один экран «где я сейчас»: `yarn status`. */
  @Get('status')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  public async status(): Promise<string> {
    const budget = await this.attempts.budget(this.config.maxPerDay);
    const unfinished = await this.attempts.listUnfinished();
    const scheduler = this.scheduler.status();

    return formatSendStatus({
      running: this.sender.isRunning(),
      dryRun: this.config.dryRun,
      dailyBudget: budget,
      scheduler: {
        active: scheduler.active,
        window: scheduler.window,
        nextSendAt: scheduler.nextSendAt,
      },
      floodSummary: this.flood.summary(),
      floodActive: this.flood.active().length,
      unfinishedCount: unfinished.length,
      outreach: await this.leads.outreachSummary(),
      awaitingReply: (await this.leads.getRepliesWorklist()).length,
      queued: (await this.leads.findForOutreach(1)).total,
    });
  }

  /** Машиночитаемое состояние — осталось для отладки: `/send/status.json`. */
  @Get('status.json')
  public async statusJson(@Query() query: RecentQueryDto) {
    const budget = await this.attempts.budget(this.config.maxPerDay);
    const unfinished = await this.attempts.listUnfinished();

    return {
      running: this.sender.isRunning(),
      dryRun: this.config.dryRun,
      dailyBudget: budget,
      scheduler: this.scheduler.status(),
      // Активные ограничения Telegram: до какого времени и что именно зажато.
      floodLimits: this.flood.active(),
      floodSummary: this.flood.summary(),
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

  /** Шпаргалка по дневному циклу: `yarn help`. */
  @Get('help')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  public help(): string {
    return HELP_TEXT;
  }
}
