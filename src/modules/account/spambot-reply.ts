/**
 * Разбор ответа @SpamBot — официального бота Telegram, который сообщает,
 * ограничен ли аккаунт за спам.
 *
 * Формат ответа не документирован и может поменяться, поэтому разбор
 * вынесен в чистую функцию с тестами: сломается — увидим в тестах, а не
 * на проде посреди рассылки.
 *
 * `limited: null` означает «не понял ответ». Это не то же самое, что
 * «не ограничен», и вызывающий код обязан различать.
 */

export interface SpamBotStatus {
  limited: boolean | null;
  /** Когда ограничение снимут. null, если бот не назвал дату. */
  until: Date | null;
  raw: string;
}

const FREE_MARKERS = [
  'no limits are currently applied',
  'free as a bird',
  // Русская локализация бота.
  'нет никаких ограничений',
  'свободны как птица',
];

const LIMITED_MARKERS = [
  'is now limited',
  'account is limited',
  'limitations will be lifted',
  'your account will be automatically released',
  'ваш аккаунт ограничен',
  'ограничения будут сняты',
];

const MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

export function parseSpamBotReply(raw: string): SpamBotStatus {
  const text = (raw ?? '').toLowerCase();

  if (text.trim().length === 0) {
    return { limited: null, until: null, raw: raw ?? '' };
  }

  // Порядок важен: сообщение об ограничении часто содержит и дату снятия,
  // а «свободен» — короткое и однозначное. Сначала проверяем ограничение,
  // потому что фраза «no limits» внутри длинного текста об ограничении
  // не встречается, а обратное — вполне.
  const limited = LIMITED_MARKERS.some((marker) => text.includes(marker));
  if (limited) {
    return { limited: true, until: parseUntil(text), raw };
  }

  if (FREE_MARKERS.some((marker) => text.includes(marker))) {
    return { limited: false, until: null, raw };
  }

  return { limited: null, until: null, raw };
}

/**
 * Вытаскивает «8 Aug 2026, 15:59 UTC» из любого места сообщения.
 * Своим разбором, а не Date.parse: Date.parse на таких строках
 * молча берёт локальную зону вместо UTC и даёт сдвиг на часы.
 */
function parseUntil(text: string): Date | null {
  const match = text.match(
    /(\d{1,2})\s+([a-z]{3})[a-z]*\s+(\d{4}),?\s+(\d{1,2}):(\d{2})\s*utc/i,
  );
  if (!match) return null;

  const [, day, monthName, year, hour, minute] = match;
  const month = MONTHS[monthName.slice(0, 3).toLowerCase()];
  if (month === undefined) return null;

  const date = new Date(
    Date.UTC(Number(year), month, Number(day), Number(hour), Number(minute)),
  );
  return Number.isNaN(date.getTime()) ? null : date;
}
