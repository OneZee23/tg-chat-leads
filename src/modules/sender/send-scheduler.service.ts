import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AccountService } from '@modules/account/account.service';
import { SendAttemptService } from '@modules/sender/send-attempt.service';
import {
  computeSpacingMs,
  isInWindow,
  msRemainingInWindow,
  nextWindowStart,
} from '@modules/sender/schedule-window';
import { SenderConfig } from '@modules/sender/sender.config';
import { SenderService } from '@modules/sender/sender.service';

export interface SchedulerStatus {
  active: boolean;
  nextSendAt: string | null;
  lastEvent: string | null;
  lastEventAt: string | null;
  window: string;
}

/** Как часто просыпаемся посмотреть, не пора ли. */
const TICK_MS = 30_000;

/**
 * Размазывает суточную норму по дню вместо пачки.
 *
 * Из всех мер против ограничения эта единственная работает по существу:
 * двадцать сообщений, равномерно раскиданных по десяти часам, выглядят
 * как человек; двадцать подряд за четыре минуты — как рассылка, что мы
 * 08.08.2026 и проверили на себе.
 *
 * Состояние держится в памяти намеренно: перезапуск приложения обнуляет
 * расписание, но не бюджет — тот считается по журналу отправок в базе,
 * и обойти его рестартом нельзя.
 */
@Injectable()
export class SendSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SendSchedulerService.name);

  private timer: NodeJS.Timeout | null = null;

  private active = false;

  private nextSendAt: Date | null = null;

  private lastEvent: string | null = null;

  private lastEventAt: Date | null = null;

  /** Защита от наложения тиков, если отправка идёт дольше TICK_MS. */
  private ticking = false;

  constructor(
    private readonly config: SenderConfig,
    private readonly sender: SenderService,
    private readonly attempts: SendAttemptService,
    private readonly account: AccountService,
  ) {}

  public onModuleInit(): void {
    if (this.config.scheduleAutostart) {
      this.start();
    }
  }

  public onModuleDestroy(): void {
    this.stop();
  }

  public start(): { started: boolean; reason: string } {
    if (this.active) return { started: false, reason: 'уже запущен' };
    if (this.config.dryRun) {
      return { started: false, reason: 'SEND_DRY_RUN=true — расписание не имеет смысла' };
    }

    this.active = true;
    this.nextSendAt = new Date();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.note('расписание запущено');

    return { started: true, reason: `окно ${this.windowLabel()}` };
  }

  public stop(): { stopped: boolean } {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const wasActive = this.active;
    this.active = false;
    this.nextSendAt = null;
    if (wasActive) this.note('расписание остановлено');

    return { stopped: wasActive };
  }

  public status(): SchedulerStatus {
    return {
      active: this.active,
      nextSendAt: this.nextSendAt ? this.nextSendAt.toISOString() : null,
      lastEvent: this.lastEvent,
      lastEventAt: this.lastEventAt ? this.lastEventAt.toISOString() : null,
      window: this.windowLabel(),
    };
  }

  private async tick(): Promise<void> {
    if (!this.active || this.ticking) return;
    this.ticking = true;

    try {
      const now = new Date();
      if (this.nextSendAt && now < this.nextSendAt) return;

      const { windowStartHour: start, windowEndHour: end } = this.config;

      if (!isInWindow(now, start, end)) {
        this.nextSendAt = nextWindowStart(now, start);
        this.note(`вне окна, жду до ${this.nextSendAt.toISOString()}`);
        return;
      }

      const budget = await this.attempts.budget(this.config.maxPerDay);
      if (budget.remaining <= 0) {
        // Ждём, пока самая старая отправка выпадет из скользящего окна.
        this.nextSendAt = budget.resetsAt ?? new Date(now.getTime() + 3_600_000);
        this.note(`суточный бюджет исчерпан (${budget.used}/${budget.limit})`);
        return;
      }

      const status = await this.account.status().catch(() => null);
      if (status && !status.canSend) {
        this.nextSendAt = status.until ?? new Date(now.getTime() + 30 * 60_000);
        this.note(`аккаунт ограничен: ${status.reason}`);
        return;
      }

      const report = await this.sender.sendOne();

      if (report.sent > 0) {
        this.note(`отправлено @${report.entries[0]?.username}`);
      } else {
        this.note(report.stoppedBecause);
        // Очередь пуста или что-то не так — не долбимся каждые полминуты.
        if (report.attempted === 0) {
          this.nextSendAt = new Date(now.getTime() + 30 * 60_000);
          return;
        }
      }

      this.nextSendAt = new Date(
        Date.now() +
          computeSpacingMs({
            remainingMs: msRemainingInWindow(new Date(), start, end),
            remainingBudget: Math.max(0, budget.remaining - 1),
            minGapMs: this.config.scheduleMinGapSec * 1000,
          }),
      );
    } catch (err) {
      // Тик не имеет права уронить процесс: он крутится в фоне, и
      // необработанный reject здесь убьёт всё приложение.
      this.note(`ошибка тика: ${err instanceof Error ? err.message : String(err)}`);
      this.nextSendAt = new Date(Date.now() + 10 * 60_000);
    } finally {
      this.ticking = false;
    }
  }

  private note(message: string): void {
    this.lastEvent = message;
    this.lastEventAt = new Date();
    this.logger.log(message);
  }

  private windowLabel(): string {
    return `${this.config.windowStartHour}:00–${this.config.windowEndHour}:00 местного времени`;
  }
}
