import {
  computeSpacingMs,
  isInWindow,
  msRemainingInWindow,
  nextWindowStart,
} from '@modules/sender/schedule-window';

/** Локальное время, чтобы тесты не зависели от TZ машины. */
function at(hour: number, minute = 0, day = 8): Date {
  return new Date(2026, 7, day, hour, minute, 0, 0);
}

describe('isInWindow', () => {
  it('начало окна включительно, конец — нет', () => {
    expect(isInWindow(at(10), 10, 21)).toBe(true);
    expect(isInWindow(at(20, 59), 10, 21)).toBe(true);
    expect(isInWindow(at(21), 10, 21)).toBe(false);
    expect(isInWindow(at(9, 59), 10, 21)).toBe(false);
    expect(isInWindow(at(3), 10, 21)).toBe(false);
  });
});

describe('nextWindowStart', () => {
  it('до окна — сегодня', () => {
    expect(nextWindowStart(at(7), 10).getTime()).toBe(at(10).getTime());
  });

  it('внутри окна — завтра, а не сейчас', () => {
    expect(nextWindowStart(at(15), 10).getTime()).toBe(at(10, 0, 9).getTime());
  });

  it('после окна — завтра', () => {
    expect(nextWindowStart(at(23), 10).getTime()).toBe(at(10, 0, 9).getTime());
  });

  it('ровно в момент старта — следующий день, иначе получим нулевую паузу', () => {
    expect(nextWindowStart(at(10), 10).getTime()).toBe(at(10, 0, 9).getTime());
  });
});

describe('msRemainingInWindow', () => {
  it('считает остаток до конца окна', () => {
    expect(msRemainingInWindow(at(20), 10, 21)).toBe(3_600_000);
    expect(msRemainingInWindow(at(10, 30), 10, 21)).toBe(10.5 * 3_600_000);
  });

  it('вне окна — ноль', () => {
    expect(msRemainingInWindow(at(22), 10, 21)).toBe(0);
    expect(msRemainingInWindow(at(5), 10, 21)).toBe(0);
  });

  it('окно до полуночи не ломается на перекате суток', () => {
    expect(msRemainingInWindow(at(23), 10, 24)).toBe(3_600_000);
  });
});

describe('computeSpacingMs', () => {
  const minGapMs = 300_000; // 5 минут

  it('размазывает остаток бюджета по остатку окна', () => {
    // 10 часов и 10 сообщений — это час между ними, ±30%.
    const spacing = computeSpacingMs({
      remainingMs: 10 * 3_600_000,
      remainingBudget: 10,
      minGapMs,
      random: () => 0.5,
    });

    expect(spacing).toBe(3_600_000);
  });

  it('не опускается ниже минимального зазора даже при худшем разбросе', () => {
    const spacing = computeSpacingMs({
      remainingMs: 60_000,
      remainingBudget: 50,
      minGapMs,
      random: () => 0,
    });

    expect(spacing).toBeGreaterThanOrEqual(minGapMs);
  });

  it('разброс укладывается в ±30%', () => {
    const input = { remainingMs: 10 * 3_600_000, remainingBudget: 10, minGapMs };

    expect(computeSpacingMs({ ...input, random: () => 0 })).toBe(0.7 * 3_600_000);
    expect(computeSpacingMs({ ...input, random: () => 1 })).toBe(1.3 * 3_600_000);
  });

  it('пустой бюджет не приводит к делению на ноль', () => {
    const spacing = computeSpacingMs({
      remainingMs: 3_600_000,
      remainingBudget: 0,
      minGapMs,
      random: () => 0.5,
    });

    expect(Number.isFinite(spacing)).toBe(true);
    expect(spacing).toBeGreaterThanOrEqual(minGapMs);
  });
});
