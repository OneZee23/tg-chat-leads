/**
 * Нормализация того, что человек скопировал с сайта преподавателя.
 *
 * В поле «контакт» прилетает всё подряд: `@nick`, голый `nick`, ссылка
 * `https://t.me/nick?text=...`, `tg://resolve?domain=nick`. Резолвить это
 * в Telegram по-разному нельзя — там нужен один ник, — а дедуп по нику
 * (предварительная отсечка до похода в Telegram) сравнивает строки, поэтому
 * приводим к нижнему регистру: в Telegram ник регистронезависим, и
 * `@ExampleTutor` обязан совпасть с уже лежащим `@exampletutor`.
 */

/**
 * Ограничения Telegram на публичный ник: 5–32 символа, латиница, цифры и
 * подчёркивание, первый символ — буква. Проверяем здесь, а не надеемся на
 * ответ сервера: каждый заведомо мусорный ник — это лишний
 * contacts.ResolveUsername, а он лимитируется отдельно и надолго.
 */
const USERNAME_RE = /^[a-z][a-z0-9_]{4,31}$/;

/**
 * Пути t.me, которые ником не являются. `+`/`joinchat` — инвайты в закрытые
 * группы, `c/` — ссылка на сообщение в супергруппе, `s/` — превью канала.
 * Все они дают «валидный» на вид кусок текста, который резолвится не в того
 * человека или не резолвится вовсе.
 */
const NOT_A_USERNAME = new Set(['joinchat', 'c', 's', 'addstickers', 'proxy', 'socks']);

/**
 * @returns ник в нижнем регистре без `@`, либо null, если это не ник.
 */
export function normalizeUsername(raw: string): string | null {
  const trimmed = (raw ?? '').trim();
  if (trimmed.length === 0) return null;

  const candidate = stripWrapper(trimmed);
  if (candidate === null) return null;

  const lower = candidate.toLowerCase();
  return USERNAME_RE.test(lower) ? lower : null;
}

/** Снимает вокруг ника ссылку, схему `tg://` или `@`. */
function stripWrapper(value: string): string | null {
  const withoutScheme = value.replace(/^(https?:)?\/\//i, '');

  // tg://resolve?domain=nick — так ник копируется из десктопного клиента.
  const tgResolve = /^tg:\/\/resolve\?.*\bdomain=([^&]+)/i.exec(value);
  if (tgResolve) return tgResolve[1];

  const link = /^(?:t\.me|telegram\.me|telegram\.dog)\/(.+)$/i.exec(withoutScheme);
  if (link) {
    // Отрезаем хвост ссылки: `?text=...`, `#anchor`, `/42` (номер сообщения).
    const first = link[1].split(/[/?#]/)[0];
    if (first.length === 0) return null;
    if (first.startsWith('+')) return null;
    if (NOT_A_USERNAME.has(first.toLowerCase())) return null;
    return first;
  }

  // Ссылка на что-то другое — точно не ник, даже если хвост похож.
  if (withoutScheme !== value || value.includes('/')) return null;

  return value.startsWith('@') ? value.slice(1) : value;
}
