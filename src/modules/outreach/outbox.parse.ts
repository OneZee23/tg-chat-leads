/**
 * Разбор файла с ответами, который заполняет ассистент.
 *
 * Формат намеренно тупой — markdown, который правят руками:
 *
 *   ## id123456789 @username
 *   SEND
 *   текст ответа, можно в несколько абзацев
 *
 * Всё, что ломает формат, роняет разбор ЦЕЛИКОМ и не отправляет ничего:
 * половина отправленной пачки хуже, чем ни одной, потому что непонятно,
 * где остановились и что переделывать.
 */

export type OutboxDirective = 'send' | 'close' | 'ask';

export interface OutboxEntry {
  tgUserId: string;
  username: string | null;
  directive: OutboxDirective;
  /** Текст ответа для send; вопрос к автору для ask; комментарий для close. */
  body: string;
}

export class OutboxParseError extends Error {}

/** У Telegram 4096; запас на всякий случай. */
export const MAX_REPLY_LEN = 4000;

// Ключ — id, а не ник: ник человек меняет когда захочет, у части его нет.
// Ровно так же устроен дедуп лидов.
const HEADER = /^##\s+id(\d{1,20})(?:\s+@?([A-Za-z0-9_]{1,64}))?\s*$/;

const DIRECTIVES: Record<string, OutboxDirective> = {
  send: 'send',
  close: 'close',
  ask: 'ask',
};

interface RawRecord {
  tgUserId: string;
  username: string | null;
  lines: string[];
}

/**
 * Только id записей, без разбора тел. Нужно, чтобы сверить outbox с самой
 * выгрузкой и назвать вслух тех, кому ответ не написали вовсе: молчаливая
 * потеря лида — ровно то, от чего мы уходим.
 */
export function extractRecordIds(raw: string): string[] {
  const ids: string[] = [];
  for (const line of (raw ?? '').split(/\r?\n/)) {
    const header = HEADER.exec(line);
    if (header) ids.push(header[1]);
  }
  return ids;
}

export function parseOutbox(raw: string): OutboxEntry[] {
  const records: RawRecord[] = [];

  for (const line of (raw ?? '').split(/\r?\n/)) {
    const header = HEADER.exec(line);
    if (header) {
      records.push({ tgUserId: header[1], username: header[2] ?? null, lines: [] });
      continue;
    }
    // До первого заголовка — преамбула: ассистент может написать там что
    // угодно для человека, на разбор это не влияет.
    if (records.length > 0) {
      // Если строка начинается с # но не совпадает с HEADER, это либо
      // сломанный заголовок, либо markdown в теле. Fail-closed, чтобы не
      // потеряться в путанице между записями.
      if (line.startsWith('#')) {
        throw new OutboxParseError(
          `Строка начинается с "#" но не разбирается как заголовок: "${line}". ` +
            'Проверь синтаксис: ## id<число> [@ник].',
        );
      }
      records[records.length - 1].lines.push(line);
    }
  }

  if (records.length === 0) {
    throw new OutboxParseError(
      'В файле нет ни одной записи вида «## id123 @nick». Похоже, ответы не заполнены.',
    );
  }

  const entries = records.map(toEntry);

  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.tgUserId)) {
      throw new OutboxParseError(
        `id${entry.tgUserId} встречается дважды — человек получил бы два сообщения. Оставь одну запись.`,
      );
    }
    seen.add(entry.tgUserId);
  }

  return entries;
}

function toEntry(record: RawRecord): OutboxEntry {
  const firstMeaningful = record.lines.findIndex((l) => l.trim().length > 0);
  if (firstMeaningful === -1) {
    throw new OutboxParseError(
      `id${record.tgUserId}: после заголовка нет директивы. Нужна строка SEND, CLOSE или ASK.`,
    );
  }

  const token = record.lines[firstMeaningful].trim().toLowerCase();
  const directive = DIRECTIVES[token];
  if (!directive) {
    throw new OutboxParseError(
      `id${record.tgUserId}: «${record.lines[firstMeaningful].trim()}» — не директива. Ожидается SEND, CLOSE или ASK.`,
    );
  }

  const body = record.lines
    .slice(firstMeaningful + 1)
    .join('\n')
    .trim();

  if (directive === 'send' && body.length === 0) {
    throw new OutboxParseError(`id${record.tgUserId}: SEND без текста. Нечего отправлять.`);
  }
  // Лимит только для SEND — он один уходит в Telegram. ASK и CLOSE остаются для автора.
  if (directive === 'send' && body.length > MAX_REPLY_LEN) {
    throw new OutboxParseError(
      `id${record.tgUserId}: текст ${body.length} символов, лимит ${MAX_REPLY_LEN}.`,
    );
  }

  return { tgUserId: record.tgUserId, username: record.username, directive, body };
}
