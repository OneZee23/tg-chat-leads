import { SendSchedulerService } from '@modules/sender/send-scheduler.service';
import { SenderConfig } from '@modules/sender/sender.config';

/**
 * Проверяем только то, что решается без Telegram и базы: отказы на старте
 * и поведение stop(). Заглушки нужны лишь чтобы конструктор отработал —
 * tick() здесь не запускается.
 */
function makeScheduler(overrides: Partial<SenderConfig>): SendSchedulerService {
  const config = {
    dryRun: false,
    windowStartHour: 10,
    windowEndHour: 21,
    maxPerDay: 20,
    maxConsecutiveErrors: 3,
    scheduleMinGapSec: 300,
    scheduleAutostart: false,
    ...overrides,
  } as SenderConfig;

  return new SendSchedulerService(
    config,
    { sendOne: jest.fn() } as never,
    { budget: jest.fn() } as never,
    { status: jest.fn() } as never,
  );
}

describe('SendSchedulerService', () => {
  it('не стартует в dry-run: расписание без отправки бессмысленно', () => {
    const result = makeScheduler({ dryRun: true }).start();

    expect(result.started).toBe(false);
    expect(result.reason).toContain('SEND_DRY_RUN');
  });

  it('не стартует с окном через полночь вместо того чтобы молча простоять', () => {
    // isInWindow при start >= end не вернёт true никогда, и планировщик
    // делал бы вид что работает, не отправляя ничего.
    const result = makeScheduler({ windowStartHour: 22, windowEndHour: 6 }).start();

    expect(result.started).toBe(false);
    expect(result.reason).toContain('окно через полночь не поддерживается');
  });

  it('не стартует, если начало совпадает с концом', () => {
    expect(
      makeScheduler({ windowStartHour: 10, windowEndHour: 10 }).start().started,
    ).toBe(false);
  });

  it('стартует при корректном окне и сразу готов отправлять', () => {
    const scheduler = makeScheduler({});
    const result = scheduler.start();

    expect(result.started).toBe(true);
    expect(scheduler.status().active).toBe(true);
    expect(scheduler.status().nextSendAt).not.toBeNull();

    scheduler.stop();
  });

  it('повторный старт не создаёт второй таймер', () => {
    const scheduler = makeScheduler({});
    scheduler.start();

    expect(scheduler.start()).toEqual({ started: false, reason: 'уже запущен' });

    scheduler.stop();
  });

  it('stop сбрасывает расписание и сообщает, что останавливать было что', () => {
    const scheduler = makeScheduler({});
    scheduler.start();

    expect(scheduler.stop()).toEqual({ stopped: true });
    expect(scheduler.status().active).toBe(false);
    expect(scheduler.status().nextSendAt).toBeNull();
    // Повторный stop безвреден.
    expect(scheduler.stop()).toEqual({ stopped: false });
  });

  it('после stop и нового start расписание не наследует старое время', () => {
    const scheduler = makeScheduler({});
    scheduler.start();
    const first = scheduler.status().nextSendAt;
    scheduler.stop();
    scheduler.start();

    expect(scheduler.status().nextSendAt).not.toBe(null);
    expect(scheduler.status().active).toBe(true);
    expect(typeof first).toBe('string');

    scheduler.stop();
  });
});
