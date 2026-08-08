export function parseBool(raw?: string): boolean {
  return ['true', 'yes', 'yea', '1'].includes((raw ?? '').trim().toLowerCase());
}

/**
 * Число с дефолтом. Пустая строка и мусор дают дефолт, а не NaN —
 * NaN в паузе между запросами превращает `sleep` в мгновенный цикл,
 * и «потихонечку» становится «залпом».
 */
export const parseIntWithDefault =
  (fallback: number) =>
  (raw?: string): number => {
    const parsed = Number.parseInt((raw ?? '').trim(), 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

/** Список через запятую: пустые элементы выкидываем, края тримим. */
export function parseCsv(raw?: string): string[] {
  return (raw ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/** То же, но в нижнем регистре — для списков ключевых слов. */
export function parseCsvLower(raw?: string): string[] {
  return parseCsv(raw).map((item) => item.toLowerCase());
}
