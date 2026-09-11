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
  // Русская локализация бота. Формулировки собраны с живых ответов:
  // 09.08.2026 бот прислал «Ваш аккаунт свободен от каких-либо
  // ограничений», чего в списке не было, и проверка честно ответила
  // «не понял» — то есть заблокировала отправку на ровном месте.
  'свободен от каких-либо ограничений',
  'свободна от каких-либо ограничений',
  'свободен от ограничений',
  'без каких-либо ограничений',
  'нет никаких ограничений',
  'не ограничен',
  'свободны как птица',
];

// Маркеры ограничения — РЕГУЛЯРКИ, а не подстроки, и это не украшение.
//
// 10.09.2026 аккаунт был реально ограничен, а разбор вернул «не понял»:
// подстрока 'ваш аккаунт ограничен' не совпала с живым «Ваш аккаунт
// ВРЕМЕННО ограничен», а 'ограничения будут сняты' — с «Ограничения будут
// АВТОМАТИЧЕСКИ сняты». Каждая промахнулась на одно вставленное слово.
// Спасло только то, что на «не понял» отправка блокируется по умолчанию;
// с ACCOUNT_BLOCK_ON_UNKNOWN=false рассылка пошла бы посреди активного
// бана — то есть прямиком к постоянному (см. postmortem-spam-ban.md).
//
// `[\s\S]{0,40}` между словами терпит любые вставки вроде «временно»,
// «автоматически», «полностью» и переносы строк, но не склеивает
// произвольно далёкие куски текста.
const LIMITED_PATTERNS = [
  /is now limited/,
  /account is limited/,
  /limitations will be lifted/,
  /your account will be automatically released/,
  // (?![а-я]) обязателен: без него «ограничен» совпадал бы с «свободен от
  // каких-либо ОГРАНИЧЕНИЙ», то есть свободный аккаунт объявлялся бы
  // ограниченным навсегда — ошибка в обратную сторону и хуже исходной.
  /ваш аккаунт[\s\S]{0,40}ограничен(?![а-я])/,
  /ограничени[яй][\s\S]{0,40}снят/,
  /вы не можете писать/,
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
  const limited = LIMITED_PATTERNS.some((pattern) => pattern.test(text));
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
