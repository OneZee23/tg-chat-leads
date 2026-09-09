/**
 * Пересчёт скоринга уже собранных лидов по текущему детектору.
 *
 *   yarn rescore          показывает, что изменится, и ничего не пишет
 *   yarn rescore --apply  применяет
 *
 * Зачем это нужно отдельной командой. `AdDetector` работает только в момент
 * скана: score и стоп-слова считаются один раз и ложатся в строку. Когда
 * правила становятся точнее, очередь рассылки этого не узнаёт — в ней
 * остаются люди, отобранные детектором прошлой версии. Ровно так в очереди
 * и оказались перепродавцы конспектов и авторы конкурирующих сервисов: их
 * правила появились позже, чем эти строки.
 *
 * Скрипт ходит только в Postgres и НЕ поднимает приложение: Telegram-сессия
 * одна на аккаунт, второй клиент её аннулирует. Поэтому его можно гонять,
 * пока лидген работает.
 *
 * Трогает только `new` — тех, кому ещё не писали. Уже написанные, ответившие
 * и зарегистрировавшиеся не меняются никогда: их статус — факт переписки,
 * а не мнение эвристики.
 *
 * И ПИШЕТ ТОЛЬКО СТОП-СЛОВА, а пересчитанный балл — никогда. Причина в
 * данных: `sample_text` обрезан по SAMPLE_TEXT_LIMIT (сейчас 1000 символов),
 * у каждого десятого лида в очереди хвост с ценой и контактом отрезан.
 * Балл, посчитанный по обрезку, систематически ЗАНИЖЕН, и запись такого
 * балла выкинула бы из очереди живых преподавателей. Стоп-слово так не
 * ошибается: оно либо есть в видимой части, либо его там нет, и тогда
 * человек просто остаётся в очереди. Ошибка в безопасную сторону.
 */
import 'dotenv/config';
import { Client } from 'pg';
import { AdDetector } from '../src/modules/scanner/ad-detector';

interface Row {
  id: string;
  username: string | null;
  score: number;
  sample_text: string;
}

const APPLY = process.argv.includes('--apply');

function parseCsvLower(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);
}

/** Обрезка для отчёта: одна строка, чтобы список читался глазами. */
function oneLine(text: string, limit = 110): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= limit ? clean : `${clean.slice(0, limit)}…`;
}

async function main(): Promise<void> {
  const detector = new AdDetector({
    minScore: Number(process.env.AD_MIN_SCORE ?? 3),
    extraKeywords: parseCsvLower(process.env.AD_EXTRA_KEYWORDS),
    extraStopWords: parseCsvLower(process.env.AD_EXTRA_STOP_WORDS),
  });

  const db = new Client({
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 5434),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
  });
  await db.connect();

  try {
    const { rows } = await db.query<Row>(
      `SELECT id, username, score, sample_text
         FROM tg_lead
        WHERE status = 'new' AND sample_text IS NOT NULL
        ORDER BY score DESC, last_seen_at DESC`,
    );

    const toSkip: Array<{ row: Row; reason: string }> = [];
    let lowScore = 0;

    for (const row of rows) {
      const result = detector.detect(row.sample_text);
      const stop = result.keywords.find((word) => word.startsWith('stop:'));
      if (stop) {
        toSkip.push({ row, reason: stop });
        continue;
      }
      // Балл ниже порога — НЕ повод выкидывать: см. про обрезанный текст
      // в шапке. Считаем такие случаи, чтобы видеть масштаб, и только.
      if (!result.isAd) lowScore += 1;
    }

    const byReason = new Map<string, Array<{ row: Row }>>();
    for (const item of toSkip) {
      const list = byReason.get(item.reason) ?? [];
      list.push({ row: item.row });
      byReason.set(item.reason, list);
    }

    console.log(`\nВ очереди (status=new): ${rows.length}`);
    console.log(`Отсеивается по стоп-словам: ${toSkip.length}`);
    console.log(
      `Балл по обрезку ниже порога: ${lowScore} — не трогаем, см. шапку скрипта\n`,
    );

    // Список поимённый: решение «правило слишком широкое» принимается
    // глазами по конкретным людям, а не по итоговой цифре.
    for (const [reason, items] of [...byReason.entries()].sort(
      (a, b) => b[1].length - a[1].length,
    )) {
      console.log(`── ${reason} — ${items.length}`);
      for (const { row } of items) {
        const who = row.username ? `@${row.username}` : `id:${row.id.slice(0, 8)}`;
        console.log(`   ${who.padEnd(26)} ${oneLine(row.sample_text)}`);
      }
      console.log('');
    }

    if (!APPLY) {
      console.log('Ничего не записано. Применить: yarn rescore --apply\n');
      return;
    }

    // Отсеянные уходят в `skip`, а не удаляются: строка остаётся видимой,
    // и по matched_keywords потом понятно, какое правило её убрало.
    // `AND status = 'new'` в условии — на случай, если лидген в это же
    // время взял человека в работу: тогда мы его не тронем.
    for (const [reason, items] of byReason.entries()) {
      await db.query(
        `UPDATE tg_lead
            SET status = 'skip', score = 0, matched_keywords = ARRAY[$2::text], updated_at = now()
          WHERE id = ANY($1::uuid[]) AND status = 'new'`,
        [items.map((item) => item.row.id), reason],
      );
    }

    console.log(`Готово: помечено skip — ${toSkip.length}.\n`);
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
