import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Файлы обмена с ассистентом.
 *
 * `inbox/` и `outbox/` лежат в корне репозитория и оба в `.gitignore`: там
 * тексты живых людей, а репозиторий публичный. Логика та же, что у `.env`,
 * `export/` и `posts/cold-outreach/body.md`.
 */

export const INBOX_DIR = 'inbox';
export const OUTBOX_DIR = 'outbox';

export class UnsafeFileNameError extends Error {}

// Только basename: буквы, цифры, точка, дефис, подчёркивание. Слэши и
// абсолютные пути отсекаются набором символов, `..` — отдельной проверкой,
// потому что точка в наборе разрешена.
const SAFE_NAME = /^[A-Za-z0-9._-]{1,64}$/;

export function assertSafeName(name: string): void {
  if (!SAFE_NAME.test(name ?? '') || name.includes('..')) {
    throw new UnsafeFileNameError(
      `Небезопасное имя файла: «${name}». Нужен basename внутри outbox/, например 2026-09-03-1430.md`,
    );
  }
}

/** Стамп до минуты: по имени видно, какой outbox к какому inbox. */
export function inboxFileName(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.md`;
}

const STAMP = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})\.md$/;

/**
 * Момент выгрузки из имени файла, unix-секунды. Нужен, чтобы перед отправкой
 * понять, не написал ли человек ещё раз ПОСЛЕ того, как мы сняли выгрузку:
 * ответ на устаревшую реплику выглядит как невнимательность.
 *
 * null — имя переименовали руками. Тогда проверку свежести делать не по чему,
 * и отправка скажет об этом вслух, а не притворится, что проверила.
 */
export function parseDumpTimestamp(name: string): number | null {
  const m = STAMP.exec(name ?? '');
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const at = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi));
  return Math.floor(at.getTime() / 1000);
}

export function writeInbox(name: string, content: string, baseDir = process.cwd()): string {
  assertSafeName(name);
  const dir = join(baseDir, INBOX_DIR);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, content, 'utf8');
  return path;
}

/**
 * Содержимое выгрузки, если она ещё на диске.
 *
 * null — файла нет (выгрузку сняли на другой машине или удалили). Тогда
 * «кому ответ не написали» посчитать не по чему, и отправка скажет это
 * вслух, а не притворится, что сверила.
 */
export function readInbox(name: string, baseDir = process.cwd()): string | null {
  assertSafeName(name);
  const path = join(baseDir, INBOX_DIR, name);
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8');
}

export function readOutbox(name: string, baseDir = process.cwd()): string {
  assertSafeName(name);
  const path = join(baseDir, OUTBOX_DIR, name);
  if (!existsSync(path)) {
    throw new UnsafeFileNameError(`Файла ${OUTBOX_DIR}/${name} нет. Что лежит рядом: ${listOutbox(baseDir).join(', ') || '(папка пуста)'}`);
  }
  return readFileSync(path, 'utf8');
}

/** Самый свежий файл — чтобы `yarn outbox` работал без аргументов. */
export function newestOutboxName(baseDir = process.cwd()): string | null {
  const names = listOutbox(baseDir);
  if (names.length === 0) return null;
  // Имена — стампы, поэтому лексикографическая сортировка совпадает с
  // хронологической. Читать mtime незачем.
  return [...names].sort().reverse()[0];
}

function listOutbox(baseDir: string): string[] {
  const dir = join(baseDir, OUTBOX_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.endsWith('.md'));
}
