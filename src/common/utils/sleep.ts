export function sleep(ms: number): Promise<void> {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Пауза со случайным разбросом: base .. base*2.
 * Ровный интервал между запросами — сам по себе признак автоматизации,
 * а нам нужно выглядеть как человек, листающий чат.
 */
export function sleepJitter(baseMs: number): Promise<void> {
  if (!Number.isFinite(baseMs) || baseMs <= 0) return Promise.resolve();
  return sleep(baseMs + Math.floor(Math.random() * baseMs));
}
