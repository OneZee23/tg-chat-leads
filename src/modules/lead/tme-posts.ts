/**
 * Разбор публичной страницы канала t.me/s/<канал>.
 *
 * Вынесено из скрипта `yarn harvest` отдельно ровно по одной причине: это
 * разбор чужой вёрстки, и она однажды поменяется. Когда это случится,
 * скрипт молча соберёт ноль объявлений — а тест на живом фрагменте страницы
 * скажет, что именно отвалилось.
 */

export interface TmePost {
  id: number;
  text: string;
  /** @ник автора объявления — тот, кому мы потом пишем. */
  username: string;
  /** ISO-строка из атрибута datetime; null — даты в разметке не нашлось. */
  date: string | null;
}

export function stripTags(fragment: string): string {
  return decodeEntities(
    fragment
      .replace(/<br\s*\/?>/g, '\n')
      .replace(/<\/p>/g, '\n')
      .replace(/<[^>]+>/g, ''),
  ).trim();
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    '#39': "'",
    nbsp: ' ',
  };
  return text.replace(/&(#?\w+);/g, (whole, code: string) =>
    code.startsWith('#')
      ? String.fromCodePoint(Number(code.slice(1)))
      : (named[code] ?? whole),
  );
}

/**
 * Чей это @ник в посте.
 *
 * Канал подписывает каждое объявление ссылкой на себя, а половина авторов
 * ещё и рекламирует ботов. Поэтому: сначала упоминания в тексте, потом —
 * ссылки (у части постов контакт стоит подписью «автор», а не в теле).
 * Ботов отсекаем: писать им бессмысленно, а в базу они попадают наравне.
 */
export function pickAuthor(body: string, channel: string): string | null {
  const mentions = [...body.matchAll(/>@([A-Za-z0-9_]{4,32})</g)].map((m) => m[1]);
  const links = [...body.matchAll(/href="https:\/\/t\.me\/([A-Za-z0-9_]{4,32})"/g)].map(
    (m) => m[1],
  );

  const usable = (name: string): boolean =>
    name.toLowerCase() !== channel.toLowerCase() && !/bot$/i.test(name);

  return mentions.find(usable) ?? links.find(usable) ?? null;
}

export function parsePosts(page: string, channel: string): TmePost[] {
  const chunks = page.split('<div class="tgme_widget_message ');
  const posts: TmePost[] = [];

  for (const chunk of chunks.slice(1)) {
    const id = chunk.match(/data-post="[^"]*\/(\d+)"/)?.[1];
    const text = chunk.match(
      /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/,
    )?.[1];
    if (!id || !text) continue;

    const username = pickAuthor(chunk, channel);
    if (!username) continue;

    posts.push({
      id: Number(id),
      text: stripTags(text),
      username,
      date: chunk.match(/datetime="([^"]+)"/)?.[1] ?? null,
    });
  }

  return posts;
}
