/**
 * Подрезать длинную реплику для экрана, не потеряв ссылок.
 *
 * Обычная обрезка по числу символов однажды съела ровно то, ради чего
 * сообщение и читали: человек прислал адрес своего профиля в конце длинной
 * фразы, список показал первые 120 символов с многоточием, и ассистент
 * переспросил у него то, что уже было написано. Стыдно и по делу.
 *
 * Поэтому ссылки, не попавшие в видимую часть, дописываются после
 * многоточия: строка остаётся короткой, но ничего важного из неё не
 * исчезает молча.
 */
const URL_RE = /https?:\/\/\S+/g;

export function clipKeepingLinks(text: string | null, limit: number): string {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length <= limit) return clean;

  const cut = `${clean.slice(0, limit).trimEnd()}…`;
  const lost = (clean.match(URL_RE) ?? []).filter((url) => !cut.includes(url));
  return lost.length > 0 ? `${cut} ${lost.join(' ')}` : cut;
}
