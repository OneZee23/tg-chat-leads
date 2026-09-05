/**
 * Разбор файла отзывов с пометками автора.
 *
 * Отдельный проход по тому же файлу, что напечатал formatReviews: человек
 * оставляет `PUBLISH` у нужных и `SKIP` у лишних, лишние цитаты удаляет
 * руками. Разбирать текст, а не хранить решения в базе, — чтобы правка
 * оставалась одним движением в редакторе.
 */

export class ReviewsParseError extends Error {}

export interface ParsedReview {
  tgUserId: string;
  username: string | null;
  displayName: string;
  /** Кем человек себя называет. Пусто — на карточке будет «Преподаватель». */
  role: string;
  quote: string;
  /** Из какой секции файла запись. Именной карточкой публикуем только `given`. */
  section: 'given' | 'pending' | 'refused';
  /**
   * PUBLISH — именная карточка: имя, фото, ссылка. Требует разрешения.
   * ANON   — только цитата, без имени, фото и ссылки. Разрешения не требует:
   *          персональных данных в такой карточке нет.
   * SKIP   — не публиковать.
   */
  directive: 'PUBLISH' | 'ANON' | 'SKIP';
}

const HEAD = /^##\s+id(\d{1,20})(?:\s+@?([A-Za-z0-9_]{1,64}))?\s*$/;
const NAME = /^-\s*имя:\s*(.+)$/;
const ROLE = /^-\s*роль:\s*(.*)$/;
const AT = /^\s{2}\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}\s*$/;
const QUOTE_LINE = /^\s{4}(.*)$/;
const SECTION = /^#\s+(.+?)(?:\s+—\s*\d+)?\s*$/;

function sectionOf(title: string): ParsedReview['section'] | null {
  if (/^Разрешение есть/i.test(title)) return 'given';
  if (/^Разрешения нет/i.test(title)) return 'pending';
  if (/^Отказались/i.test(title)) return 'refused';
  return null;
}

export function parseReviews(raw: string): ParsedReview[] {
  const lines = (raw ?? '').split('\n');
  const out: ParsedReview[] = [];

  let section: ParsedReview['section'] | null = null;
  let current: ParsedReview | null = null;
  let quoteLines: string[] = [];
  let inQuote = false;
  let sawDirective = false;

  const flush = () => {
    if (!current) return;
    if (!sawDirective) {
      throw new ReviewsParseError(
        `У записи id${current.tgUserId} нет директивы. Оставь PUBLISH, ANON или ` +
          `SKIP — иначе непонятно, что с ней делать, а угадывать тут нельзя.`,
      );
    }
    current.quote = quoteLines.join('\n').trim();
    out.push(current);
    current = null;
    quoteLines = [];
    inQuote = false;
    sawDirective = false;
  };

  for (const line of lines) {
    // Заголовок секции разбираем ДО всего остального и закрываем им текущую
    // запись: он встречается, когда предыдущая запись ещё не закончилась, и
    // из-за этого секция раньше не переключалась вовсе — все записи файла
    // считались лежащими в первой, то есть «с разрешением».
    //
    // Спутать с цитатой нельзя: цитаты в файле идут с отступом в четыре
    // пробела, а заголовок начинается с первой колонки.
    const sec = SECTION.exec(line);
    if (sec && sectionOf(sec[1])) {
      flush();
      section = sectionOf(sec[1]);
      continue;
    }

    const head = HEAD.exec(line);
    if (head) {
      flush();
      if (!section) {
        throw new ReviewsParseError(
          `Запись id${head[1]} лежит вне секции. Заголовки секций удалять нельзя: ` +
            `по ним видно, у кого есть разрешение на публикацию.`,
        );
      }
      current = {
        tgUserId: head[1],
        username: head[2] ?? null,
        displayName: '',
        role: '',
        quote: '',
        section,
        directive: 'SKIP',
      };
      continue;
    }

    if (!current) continue;

    const name = NAME.exec(line);
    if (name) {
      current.displayName = name[1].trim();
      continue;
    }

    const role = ROLE.exec(line);
    if (role) {
      current.role = role[1].trim();
      continue;
    }

    const trimmed = line.trim();
    if (trimmed === 'PUBLISH' || trimmed === 'SKIP' || trimmed === 'ANON') {
      current.directive = trimmed;
      sawDirective = true;
      inQuote = false;
      continue;
    }

    if (AT.test(line)) {
      // Вторая и следующие цитаты игнорируются: на карточке лендинга место
      // ровно под одну, и молча склеивать их в простыню — худший вариант.
      inQuote = quoteLines.length === 0;
      continue;
    }

    if (inQuote) {
      const q = QUOTE_LINE.exec(line);
      if (q) {
        quoteLines.push(q[1]);
        continue;
      }
      if (trimmed.length === 0) {
        quoteLines.push('');
        continue;
      }
      inQuote = false;
    }
  }

  flush();
  return out;
}

/**
 * Что реально поедет на лендинг.
 *
 * Именная карточка требует разрешения: `PUBLISH` под записью из любой другой
 * секции — не команда, а недосмотр, и выполнять её нельзя. Цена ошибки тут
 * чужие персональные данные в публичном доступе.
 *
 * Анонимная карточка разрешения не требует и потому доступна из любой секции,
 * КРОМЕ отказа. Человек, прямо сказавший «не публикуйте», имел в виду свои
 * слова, а не только своё имя, — и обходить это через анонимность нельзя.
 */
export function selectPublishable(all: ParsedReview[]): {
  named: ParsedReview[];
  anon: ParsedReview[];
  blocked: ParsedReview[];
} {
  const withQuote = all.filter((r) => r.quote.length > 0);
  const named = withQuote.filter(
    (r) => r.directive === 'PUBLISH' && r.section === 'given',
  );
  const anon = withQuote.filter((r) => r.directive === 'ANON' && r.section !== 'refused');
  const blocked = [
    ...all.filter((r) => r.directive === 'PUBLISH' && r.section !== 'given'),
    ...all.filter((r) => r.directive === 'ANON' && r.section === 'refused'),
  ];
  return { named, anon, blocked };
}

/**
 * Имя для карточки лендинга.
 *
 * В телеграме люди подписываются «🐾Viki🐈‍⬛», «Фарида | педагог по вокалу»
 * и «руся» с маленькой буквы. Как есть на витрину это ставить нельзя, а
 * придумывать за человека новое имя — тем более.
 *
 * Поэтому только уборка, без выдумывания: снимаем эмодзи и служебные
 * символы, берём часть до разделителя (после него обычно род занятий, а не
 * имя) и поднимаем первую букву. Если после уборки не осталось ничего —
 * возвращаем пустую строку, и карточка станет анонимной сама.
 */
export function cleanName(raw: string): string {
  const noEmoji = (raw ?? '')
    // Свойство Unicode вместо перечисления диапазонов руками: перечисление
    // уже промахнулось мимо ⬛ (U+2B1B), а эмодзи в никах бывают любые.
    .replace(/[\p{Extended_Pictographic}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}]/gu, '')
    .trim();

  // «Фарида | педагог по вокалу» → «Фарида».
  const head = noEmoji.split(/[|·•—–\/]/)[0].trim();

  const collapsed = head
    .replace(/\s+/g, ' ')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .trim();
  if (collapsed.length === 0) return '';

  return collapsed.charAt(0).toLocaleUpperCase('ru') + collapsed.slice(1);
}
