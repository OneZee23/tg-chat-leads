import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Дайджест кладём в отдельную папку в корне репозитория, по той же логике,
 * что `inbox/` и `outbox/`: там дословные сообщения живых людей, а
 * репозиторий публичный. Папка обязана быть в .gitignore.
 */
export function writeDigest(
  dir: string,
  fileName: string,
  content: string,
  baseDir = process.cwd(),
): string | null {
  // Папка задаётся из env, поэтому проверяем, что она осталась внутри
  // репозитория: RESEARCH_DIR=../../ отправил бы файл с чужими сообщениями
  // куда угодно на диске.
  const target = resolve(baseDir, dir);
  if (!target.startsWith(resolve(baseDir))) {
    throw new Error(`RESEARCH_DIR должен быть внутри репозитория, получено: ${dir}`);
  }

  if (!existsSync(target)) mkdirSync(target, { recursive: true });

  const path = join(target, fileName);
  writeFileSync(path, content, 'utf8');
  return path;
}
