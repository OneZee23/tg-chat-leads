import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { DEFAULT_BODY } from '@modules/sender/outreach-message';

/**
 * Содержимое рассылки лежит на диске, а не в коде: текст правится без
 * пересборки, картинки подкладываются в папку.
 *
 *   <OUTREACH_CONTENT_DIR>/
 *     text.md
 *     images/*.png|jpg|jpeg|webp
 */

export interface MessageContent {
  text: string;
  images: string[];
  /** Подпись к альбому не может быть длиннее лимита Telegram. */
  captionFits: boolean;
  /**
   * Тело для персонализированного режима (без приветствия — хук ставит
   * своё). Берётся из body.md; если файла нет — из DEFAULT_BODY.
   */
  body: string;
}

/** Максимальная длина подписи к альбому (Telegram режет на 1024). */
export function captionFits(text: string): boolean {
  return text.length <= CAPTION_LIMIT;
}

// Telegram режет подпись к медиа на 1024 символах. Берём с запасом:
// эмодзи считаются не по одному символу, и упереться в лимит на отправке
// хуже, чем отправить текст отдельным сообщением.
const CAPTION_LIMIT = 900;

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

export function loadMessageContent(dir: string): MessageContent {
  const text = readFileSync(join(dir, 'text.md'), 'utf8').trim();

  if (text.length === 0) {
    throw new Error(`Текст рассылки пуст: ${join(dir, 'text.md')}`);
  }

  return {
    text,
    images: listImages(join(dir, 'images')),
    captionFits: text.length <= CAPTION_LIMIT,
    body: loadBody(dir),
  };
}

/** Тело для персонализированного режима: body.md или дефолт из кода. */
function loadBody(dir: string): string {
  try {
    const body = readFileSync(join(dir, 'body.md'), 'utf8').trim();
    return body.length > 0 ? body : DEFAULT_BODY;
  } catch {
    return DEFAULT_BODY;
  }
}

function listImages(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    // Папки может не быть — тогда рассылка просто текстовая.
    return [];
  }

  return (
    entries
      .filter((name) => IMAGE_EXTENSIONS.has(extname(name).toLowerCase()))
      .map((name) => join(dir, name))
      .filter((path) => statSync(path).isFile())
      // Порядок в альбоме = порядок файлов. Сортируем по имени, чтобы
      // «01-...png, 02-...png» шли предсказуемо, а не как отдала ФС.
      .sort((a, b) => a.localeCompare(b, 'en'))
  );
}
