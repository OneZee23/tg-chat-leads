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
  consecutiveFailures: number;
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

  /**
   * Поколение запуска. Тик, начавшийся до stop(), может завершиться после
   * него — и без этого токена он бы переписал nextSendAt уже остановленного
   * планировщика, а следующий start() унаследовал бы чужое расписание.
   */
  private epoch = 0;

  /** Подряд идущие неудачные отправки. Аналог предохранителя в пачке. */
  private consecutiveFailures = 0;

  constructor(
    private readonly config: SenderConfig,
    private readonly sender: SenderService,
    private readonly attempts: SendAttemptService,
    private readonly account: AccountService,
  ) {}

  public onModuleInit(): void {
    if (this.config.scheduleAutostart) {
      const { started, reason } = this.start();
      if (!started) this.logger.warn(`Автостарт расписания не выполнен: ${reason}`);
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
    // Окно «через полночь» (22:00–06:00) эта арифметика не поддерживает:
    // isInWindow никогда не вернёт true, и планировщик молча простоял бы
    // вечно, делая вид что работает. Лучше честно не запуститься.
    if (this.config.windowStartHour >= this.config.windowEndHour) {
      return {
        started: false,
        reason:
          `бессмысленное окно ${this.windowLabel()}: SEND_WINDOW_START_HOUR должен быть ` +
          'меньше SEND_WINDOW_END_HOUR (окно через полночь не поддерживается)',
      };
    }

    this.active = true;
    this.epoch += 1;
    this.consecutiveFailures = 0;
    this.nextSendAt = new Date();
    this.timer = setInterval(() => void this.tick(this.epoch), TICK_MS);
    // Фоновый таймер не должен сам по себе держать процесс живым: его
    // держит HTTP-сервер. Без unref() Node не завершается по Ctrl+C,
    // а jest ругается на утёкший хендл.
    this.timer.unref();
    this.note('расписание запущено');

    return { started: true, reason: `окно ${this.windowLabel()}` };
  }

  public stop(): { stopped: boolean } {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const wasActive = this.active;
    this.active = false;
    // Смена поколения обесценивает тик, который сейчас в полёте.
    this.epoch += 1;
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
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  private async tick(epoch: number): Promise<void> {
    if (!this.active || this.ticking || epoch !== this.epoch) return;
    this.ticking = true;

    try {
      const now = new Date();
      if (this.nextSendAt && now < this.nextSendAt) return;

      const { windowStartHour: start, windowEndHour: end } = this.config;

      if (!isInWindow(now, start, end)) {
        this.schedule(epoch, nextWindowStart(now, start));
        this.note(`вне окна, жду до ${this.nextSendAt?.toISOString()}`);
        return;
      }

      const budget = await this.attempts.budget(this.config.maxPerDay);
      if (budget.remaining <= 0) {
        // Ждём, пока самая старая отправка выпадет из скользящего окна.
        this.schedule(epoch, budget.resetsAt ?? new Date(now.getTime() + 3_600_000));
        this.note(`суточный бюджет исчерпан (${budget.used}/${budget.limit})`);
        return;
      }

      const status = await this.account.status().catch(() => null);
      if (status && !status.canSend) {
        this.schedule(epoch, status.until ?? new Date(now.getTime() + 30 * 60_000));
        this.note(`аккаунт ограничен: ${status.reason}`);
        return;
      }

      const report = await this.sender.sendOne();

      // Ограничение аккаунта — не повод «попробовать через полчаса».
      // Каждая следующая попытка при живом ограничении удлиняет его,
      // о чём @SpamBot предупреждает прямым текстом. Останавливаемся.
      if (report.fatal) {
        this.note(`остановка: ${report.stoppedBecause}`);
        this.stop();
        return;
      }

      if (report.sent > 0) {
        this.consecutiveFailures = 0;
        this.note(`отправлено @${report.entries[0]?.username}`);
      } else {
        this.note(report.stoppedBecause);

        if (report.failed > 0) {
          this.consecutiveFailures += 1;
          if (this.consecutiveFailures >= this.config.maxConsecutiveErrors) {
            this.note(
              `${this.consecutiveFailures} неудачных отправок подряд — останавливаю расписание`,
            );
            this.stop();
            return;
          }
        }

        // Очередь пуста или бюджет кончился — не долбимся каждые полминуты.
        if (report.attempted === 0) {
          this.schedule(epoch, new Date(now.getTime() + 30 * 60_000));
          return;
        }
      }

      // Когда суточного потолка нет (SEND_MAX_PER_DAY=0, значение по
      // умолчанию с 11.09.2026), размазывать по остатку бюджета нечего:
      // remaining — это MAX_SAFE_INTEGER. Тогда единственный темп —
      // SEND_SCHEDULE_MIN_GAP_SEC, то есть 5 минут по умолчанию,
      // ~130 сообщений за окно 10:00–21:00 вместо прежних 20.
      // Планировщику намеренно не сделали yarn-команду (см. CLAUDE.md):
      // тот, кто включает его курлом, задаёт темп этим зазором.
      this.schedule(
        epoch,
        new Date(
          Date.now() +
            computeSpacingMs({
              remainingMs: msRemainingInWindow(new Date(), start, end),
              remainingBudget: budget.unlimited ? 0 : Math.max(0, budget.remaining - 1),
              minGapMs: this.config.scheduleMinGapSec * 1000,
            }),
        ),
      );
    } catch (err) {
      // Тик не имеет права уронить процесс: он крутится в фоне, и
      // необработанный reject здесь убьёт всё приложение.
      this.note(`ошибка тика: ${err instanceof Error ? err.message : String(err)}`);
      this.schedule(epoch, new Date(Date.now() + 10 * 60_000));
    } finally {
      this.ticking = false;
    }
  }

  /** Запись расписания только от своего поколения — см. комментарий к epoch. */
  private schedule(epoch: number, at: Date): void {
    if (epoch !== this.epoch || !this.active) return;
    this.nextSendAt = at;
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
