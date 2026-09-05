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
  quote: string;
  /** Из какой секции файла запись. Публикуем только `given`. */
  section: 'given' | 'pending' | 'refused';
  publish: boolean;
}

const HEAD = /^##\s+id(\d{1,20})(?:\s+@?([A-Za-z0-9_]{1,64}))?\s*$/;
const NAME = /^-\s*имя:\s*(.+)$/;
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
        `У записи id${current.tgUserId} нет директивы. Оставь PUBLISH или SKIP — ` +
          `иначе непонятно, что с ней делать, а угадывать тут нельзя.`,
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
        quote: '',
        section,
        publish: false,
      };
      continue;
    }

    if (!current) continue;

    const name = NAME.exec(line);
    if (name) {
      current.displayName = name[1].trim();
      continue;
    }

    const trimmed = line.trim();
    if (trimmed === 'PUBLISH' || trimmed === 'SKIP') {
      current.publish = trimmed === 'PUBLISH';
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
 * Fail-closed: секция `given` обязательна. `PUBLISH` под записью без
 * разрешения — не команда, а недосмотр, и выполнять её нельзя: цена ошибки
 * тут чужие персональные данные в публичном доступе.
 */
export function selectPublishable(all: ParsedReview[]): {
  publish: ParsedReview[];
  blocked: ParsedReview[];
} {
  const publish = all.filter(
    (r) => r.publish && r.section === 'given' && r.quote.length > 0,
  );
  const blocked = all.filter((r) => r.publish && r.section !== 'given');
  return { publish, blocked };
}
