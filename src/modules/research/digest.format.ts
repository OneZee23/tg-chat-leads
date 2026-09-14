/**
 * Форматирование дайджеста. Чистые функции без Telegram и файловой системы:
 * то, что читает человек и ассистент, должно проверяться тестом, а не
 * прогоном по живому чату.
 */

export interface ResearchHit {
  chatRef: string;
  chatTitle: string | null;
  messageId: number;
  /** unix-секунды, как отдаёт Telegram */
  date: number;
  author: string;
  text: string;
  link: string | null;
  /** Все запросы, под которые попало сообщение. Первый — где его печатаем. */
  matchedQueries: string[];
  /** Сообщение, на которое отвечали. Без него короткий ответ бессмыслен. */
  replyToText: string | null;
}

export interface QueryStat {
  query: string;
  found: number;
  error?: string;
}

export interface ResearchResult {
  chats: string[];
  queries: QueryStat[];
  hits: ResearchHit[];
  startedAt: string;
  finishedAt: string;
  sinceDays: number;
}

export function formatDate(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Файл на прогон, стамп до минуты — как в inbox/. */
export function digestFileName(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.md`;
}

/**
 * Схлопывает переводы строк: в дайджесте каждая находка это цитата, и
 * десятистрочное сообщение ломает читаемость сильнее, чем помогает.
 */
/**
 * Лимит поднят с 1200 до 3000 знаков 13.09.2026. В каналах вакансий контакт
 * («резюме в лс @user») стоит в самом конце поста, и на 1200 знаках обрезалось
 * ровно то, ради чего пост и читают.
 */
export function flattenText(text: string, limit = 3000): string {
  const flat = text.replace(/\s*\n+\s*/g, ' / ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/**
 * Один блок находки. Дата и автор идут ПЕРЕД текстом: в визовых чатах
 * возраст сообщения важнее его содержания, и читатель должен увидеть его
 * до того, как поверит совету.
 */
export function formatHit(hit: ResearchHit): string {
  const lines: string[] = [];
  const head = [`**${formatDate(hit.date)}**`, hit.author];
  if (hit.link) head.push(`[→](${hit.link})`);
  lines.push(`- ${head.join(' · ')}`);

  if (hit.replyToText) {
    lines.push(`  > в ответ на: ${flattenText(hit.replyToText, 300)}`);
  }
  lines.push(`  ${flattenText(hit.text)}`);

  const also = hit.matchedQueries.slice(1);
  if (also.length > 0) {
    lines.push(`  _также по запросам: ${also.join(', ')}_`);
  }
  return lines.join('\n');
}

export function formatDigest(result: ResearchResult): string {
  const out: string[] = [];

  out.push('# Дайджест по чатам');
  out.push('');
  out.push(`Чаты: ${result.chats.join(', ') || '—'}`);
  out.push(
    `Окно: ${result.sinceDays > 0 ? `последние ${result.sinceDays} дн.` : 'без отсечки по дате'}`,
  );
  out.push(`Прогон: ${result.startedAt} → ${result.finishedAt}`);
  out.push(`Находок: ${result.hits.length}`);
  out.push('');
  out.push(
    '> Это цитаты живых людей из чата, а не источник истины. Всё, что влияет ' +
      'на решение, проверять на сайте консульства или письмом в него.',
  );
  out.push('');

  out.push('## Что нашлось по запросам');
  out.push('');
  for (const stat of result.queries) {
    const suffix = stat.error ? ` — ошибка: ${stat.error}` : '';
    out.push(`- \`${stat.query}\` — ${stat.found}${suffix}`);
  }
  out.push('');

  // Группируем по первому совпавшему запросу: одно сообщение печатается
  // ровно один раз, остальные его запросы уходят в подпись под цитатой.
  const byQuery = new Map<string, ResearchHit[]>();
  for (const hit of result.hits) {
    const key = hit.matchedQueries[0] ?? 'без запроса';
    const bucket = byQuery.get(key);
    if (bucket) bucket.push(hit);
    else byQuery.set(key, [hit]);
  }

  for (const stat of result.queries) {
    const hits = byQuery.get(stat.query);
    if (!hits || hits.length === 0) continue;
    out.push(`## ${stat.query}`);
    out.push('');
    for (const hit of hits) {
      out.push(formatHit(hit));
      out.push('');
    }
  }

  if (result.hits.length === 0) {
    out.push('Ничего не нашлось. Проверь формулировки запросов и окно по дате.');
    out.push('');
  }

  return out.join('\n');
}
