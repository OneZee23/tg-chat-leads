/**
 * Арифметика окна активности и интервалов между сообщениями.
 *
 * Вынесено отдельными чистыми функциями, потому что ошибку тут не видно
 * глазами: неправильный расчёт «сколько ждать» либо остановит рассылку
 * навсегда, либо сожмёт её в очередь без пауз — ровно то, от чего
 * расписание и должно защищать.
 *
 * Часы — местное время машины. Это осознанно: смысл окна в том, чтобы
 * сообщения приходили в разумное время суток там, где сидишь ты и, как
 * правило, твои получатели.
 */

export function isInWindow(now: Date, startHour: number, endHour: number): boolean {
  const hour = now.getHours();
  return hour >= startHour && hour < endHour;
}

/** Ближайшее начало окна строго в будущем. */
export function nextWindowStart(now: Date, startHour: number): Date {
  const candidate = new Date(now);
  candidate.setHours(startHour, 0, 0, 0);

  if (candidate.getTime() <= now.getTime()) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate;
}

/** Сколько миллисекунд осталось до конца окна. Вне окна — 0. */
export function msRemainingInWindow(
  now: Date,
  startHour: number,
  endHour: number,
): number {
  if (!isInWindow(now, startHour, endHour)) return 0;

  const end = new Date(now);
  // setHours(24) корректно перекатывается на 00:00 следующего дня —
  // именно это и нужно для окна, заканчивающегося в полночь.
  end.setHours(endHour, 0, 0, 0);

  return Math.max(0, end.getTime() - now.getTime());
}

export interface SpacingInput {
  /** Сколько времени осталось в окне. */
  remainingMs: number;
  /** Сколько сообщений ещё можно отправить по суточному бюджету. */
  remainingBudget: number;
  minGapMs: number;
  /** Инъекция для тестов; по умолчанию Math.random. */
  random?: () => number;
}

/**
 * Пауза до следующего сообщения: остаток окна делим на остаток бюджета,
 * чтобы норма равномерно размазалась до вечера, и добавляем разброс ±30% —
 * ровный интервал сам по себе выдаёт автоматику.
 *
 * Нижняя граница жёсткая: разброс не имеет права опустить паузу ниже
 * минимального зазора.
 */
export function computeSpacingMs({
  remainingMs,
  remainingBudget,
  minGapMs,
  random = Math.random,
}: SpacingInput): number {
  const even = remainingBudget > 0 ? remainingMs / remainingBudget : minGapMs;
  const base = Math.max(minGapMs, even);
  const jittered = Math.round(base * (0.7 + random() * 0.6));

  return Math.max(minGapMs, jittered);
}
