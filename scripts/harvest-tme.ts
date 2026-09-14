/**
 * Сбор объявлений преподавателей из ПУБЛИЧНОГО телеграм-канала — по http,
 * без участия аккаунта.
 *
 *   yarn harvest englishteachersboard
 *   yarn harvest englishteachersboard --pages 40 --max 300
 *
 * Зачем отдельно от сканера. Сканер читает чаты от живого аккаунта: в них
 * надо вступить, и каждый запрос идёт с той же сессии, которой мы потом
 * пишем людям. Каналы вида «объявления репетиторов» открыты всем и читаются
 * обычным GET на t.me/s/<канал> — аккаунт при этом не участвует вовсе, а
 * значит не рискует. Это и есть внешний источник, ради которого заведено
 * поле `source`: контакты те же телеграмные, но путь до них другой.
 *
 * Скрипт НИЧЕГО не отправляет и в базу не пишет. Он кладёт на диск файл
 * в формате `POST /leads/import`, который человек смотрит глазами и заводит
 * сам. Резолв @ников (а с ним и лимиты Telegram) — уже дело импорта.
 *
 * Что считается объявлением, решает тот же `AdDetector`, что и в сканере:
 * второй эвристики быть не должно, иначе базы двух источников разъедутся
 * по качеству и сравнивать их станет нечем.
 */
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parsePosts, TmePost } from '../src/modules/lead/tme-posts';
import { AdDetector } from '../src/modules/scanner/ad-detector';

/** Сколько объявлений влезает в одну пачку импорта (MAX_IMPORT_BATCH). */
const BATCH = 50;

/** Пауза между страницами. Мы гость на чужом сайте, а не нагрузочный тест. */
const PAGE_DELAY_MS = 1500;

/** Длина текста объявления, которую кладём в sampleText (SAMPLE_TEXT_LIMIT). */
const SAMPLE_LIMIT = Number(process.env.SAMPLE_TEXT_LIMIT ?? 1000);

const AD_MIN_SCORE = Number(process.env.AD_MIN_SCORE ?? 3);

function parseArgs(argv: string[]): {
  channel: string;
  pages: number;
  max: number;
  days: number;
} {
  const positional = argv.filter((a) => !a.startsWith('--'));
  const flag = (name: string, fallback: number): number => {
    const at = argv.indexOf(`--${name}`);
    if (at === -1) return fallback;
    const value = Number(argv[at + 1]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };

  const channel = (positional[0] ?? '')
    .replace(/^@/, '')
    .replace(/^https?:\/\/t\.me\//, '');
  if (!/^[A-Za-z0-9_]{4,32}$/.test(channel)) {
    throw new Error('Укажи канал: yarn harvest englishteachersboard');
  }

  // `days` по умолчанию отсекает совсем старое: объявление двухлетней
  // давности — это человек, который уже мог уйти из репетиторства, а его
  // текст всё равно уйдёт в персональную первую строку письма.
  return {
    channel,
    pages: flag('pages', 20),
    max: flag('max', 500),
    days: flag('days', 180),
  };
}

async function fetchPage(channel: string, before: number | null): Promise<string> {
  const url = before
    ? `https://t.me/s/${channel}?before=${before}`
    : `https://t.me/s/${channel}`;

  const response = await fetch(url, {
    headers: {
      // Без узнаваемого клиента t.me отдаёт урезанную разметку.
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      'accept-language': 'ru,en;q=0.8',
    },
  });

  if (!response.ok) throw new Error(`t.me ответил ${response.status} на ${url}`);
  return response.text();
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms + Math.random() * ms));
}

async function main(): Promise<void> {
  const { channel, pages, max, days } = parseArgs(process.argv.slice(2));
  const oldestAllowed = Date.now() - days * 86_400_000;
  const detector = new AdDetector({ minScore: AD_MIN_SCORE });

  const found = new Map<string, TmePost>();
  let skippedNotAd = 0;
  let skippedOld = 0;
  let seenPosts = 0;
  let before: number | null = null;
  let ranOut = false;

  for (let page = 0; page < pages && found.size < max; page += 1) {
    const html = await fetchPage(channel, before);
    const posts = parsePosts(html, channel);
    if (posts.length === 0) break;

    seenPosts += posts.length;

    for (const post of posts) {
      if (post.date && Date.parse(post.date) < oldestAllowed) {
        skippedOld += 1;
        // Идём от новых к старым: как только начались старые, дальше
        // только старее. Дочитываем страницу и выходим.
        ranOut = true;
        continue;
      }

      const verdict = detector.detect(post.text);
      if (!verdict.isAd) {
        skippedNotAd += 1;
        continue;
      }
      // Ник — ключ: один и тот же человек постит объявление раз в неделю.
      // Оставляем первое встреченное, оно же самое свежее: идём от новых.
      const key = post.username.toLowerCase();
      if (!found.has(key)) found.set(key, post);
      if (found.size >= max) break;
    }

    if (ranOut) break;

    // Следующая страница — от самого старого поста этой.
    const oldest = Math.min(...posts.map((p) => p.id));
    if (before !== null && oldest >= before) break; // канал кончился
    before = oldest;

    process.stdout.write(
      `страница ${page + 1}: постов ${posts.length}, объявлений всего ${found.size}\n`,
    );
    await sleep(PAGE_DELAY_MS);
  }

  const items = [...found.values()].map((post) => ({
    contact: `@${post.username}`,
    about: post.text.slice(0, SAMPLE_LIMIT),
    note: `канал @${channel}, пост ${post.id}${post.date ? `, ${post.date.slice(0, 10)}` : ''}`,
  }));

  const batches = [];
  for (let i = 0; i < items.length; i += BATCH) {
    batches.push({ source: 'tg_public', items: items.slice(i, i + BATCH) });
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const dir = resolve(__dirname, '..', 'export');
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `harvest-${channel}-${stamp}.json`);
  writeFileSync(file, JSON.stringify(batches, null, 2), 'utf-8');

  console.log(
    [
      '',
      `Канал @${channel}: просмотрено постов ${seenPosts}, объявлений ${items.length}, ` +
        `не объявления ${skippedNotAd}, старее ${days} дней ${skippedOld}`,
      `Пачек по ${BATCH}: ${batches.length}`,
      `Файл: ${file}`,
      '',
      'Посмотри файл глазами, потом заводи пачками:',
      `  jq '.[0]' ${file} | curl -sS -XPOST http://127.0.0.1:3010/leads/import \\`,
      "    -H 'content-type: application/json' -d @-",
      '',
    ].join('\n'),
  );
}

main().catch((err: unknown) => {
  console.error('Не получилось:', err instanceof Error ? err.message : err);
  process.exit(1);
});
