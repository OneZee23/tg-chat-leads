import type { ConsentState, ReviewQuote } from '@modules/dialogs/review-detect';

export interface ReviewEntry {
  tgUserId: string;
  username: string | null;
  displayName: string;
  /** Пост о себе из чата — по нему автор вспоминает, кто это. */
  about: string | null;
  consent: ConsentState;
  /** Реплики, из которых сделан вывод о согласии. Показываем их автору. */
  consentAsk: string | null;
  consentAnswer: string | null;
  quotes: ReviewQuote[];
}

export interface ReviewsDump {
  createdAt: string;
  dialogsSeen: number;
  entries: ReviewEntry[];
  stoppedBecause: string;
}

const CONSENT_LABEL: Record<ConsentState, string> = {
  given: 'разрешение есть',
  refused: 'ОТКАЗАЛСЯ публиковать',
  'asked-no-answer': 'спрашивали, ответа нет',
  'not-asked': 'разрешение не спрашивали',
};

function at(sec: number): string {
  const d = new Date(sec * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function renderEntry(e: ReviewEntry): string {
  // Под записями без разрешения по умолчанию SKIP: файл не должен предлагать
  // человеку то, что выгрузка всё равно запретит. PUBLISH там — недосмотр,
  // и подсказывать его нельзя.
  const directive = e.consent === 'given' ? 'PUBLISH' : 'SKIP';
  const head = `## id${e.tgUserId}${e.username ? ` @${e.username}` : ''}`;
  const lines = [
    head,
    '',
    `- имя: ${e.displayName}`,
    `- ссылка: ${e.username ? `https://t.me/${e.username}` : '— (нет username, аватарку не забрать)'}`,
    `- согласие: ${CONSENT_LABEL[e.consent]}`,
  ];
  if (e.about) lines.push(`- о себе: ${e.about.slice(0, 160)}`);
  lines.push('');
  // Вердикт о согласии проверяем глазами: эвристика по словам ошибается в
  // обе стороны, а цена ошибки — чужие персональные данные на лендинге.
  if (e.consentAsk) {
    lines.push('  разговор о согласии:');
    lines.push(`    мы:  ${e.consentAsk.replace(/\n+/g, ' ').slice(0, 200)}`);
    lines.push(
      e.consentAnswer
        ? `    он: ${e.consentAnswer.replace(/\n+/g, ' ').slice(0, 200)}`
        : '    он: (не ответил)',
    );
    lines.push('');
  }
  for (const q of e.quotes) {
    lines.push(`  ${at(q.at)}`);
    for (const l of q.text.split('\n')) lines.push(`    ${l}`);
    lines.push('');
  }
  lines.push(directive);
  lines.push('');
  return lines.join('\n');
}

export function formatReviews(dump: ReviewsDump): string {
  const given = dump.entries.filter((e) => e.consent === 'given');
  const pending = dump.entries.filter(
    (e) => e.consent === 'not-asked' || e.consent === 'asked-no-answer',
  );
  const refused = dump.entries.filter((e) => e.consent === 'refused');

  const out: string[] = [
    `# Отзывы на ${dump.createdAt}`,
    '',
    `Найдено: ${dump.entries.length}. Проверено диалогов: ${dump.dialogsSeen}.`,
    '',
    'Под каждой записью директива:',
    '',
    '  PUBLISH  именная карточка — имя, фото, ссылка. Только с разрешением.',
    '  ANON     только цитата, без имени, фото и ссылки. Разрешение не нужно:',
    '           персональных данных в такой карточке не остаётся.',
    '  SKIP     не публиковать.',
    '',
    'Лишние цитаты у записи удали, останется первая; текст можно подрезать.',
    'Дальше: `yarn reviews:build <имя файла>`.',
    '',
    'PUBLISH без разрешения не выполнится — это персональные данные, а',
    'оператор по документам ты лично. ANON у отказавшихся тоже не выполнится:',
    'человек, сказавший «не публикуйте», имел в виду свои слова, а не имя.',
    '',
  ];

  out.push('---', '', `# Разрешение есть — ${given.length}`, '');
  out.push(...given.map(renderEntry));

  out.push('---', '', `# Разрешения нет — ${pending.length}`, '');
  out.push(
    'Цитаты хорошие, но публиковать нельзя. Спроси разрешение в переписке,',
    'потом сними выгрузку заново. `PUBLISH` тут не сработает намеренно.',
    '',
  );
  out.push(...pending.map(renderEntry));

  if (refused.length > 0) {
    out.push('---', '', `# Отказались — ${refused.length}`, '');
    out.push('Не публиковать. Лежат здесь, чтобы не спросить второй раз.', '');
    out.push(...refused.map(renderEntry));
  }

  return out.join('\n');
}

export function formatReviewsSummary(dump: ReviewsDump, path: string): string {
  const given = dump.entries.filter((e) => e.consent === 'given').length;
  const pending = dump.entries.filter(
    (e) => e.consent === 'not-asked' || e.consent === 'asked-no-answer',
  ).length;
  const refused = dump.entries.filter((e) => e.consent === 'refused').length;

  return [
    '',
    `Отзывы на ${dump.createdAt}: найдено ${dump.entries.length}.`,
    `  можно публиковать: ${given}`,
    `  нужно спросить разрешение: ${pending}`,
    `  отказались: ${refused}`,
    `Проверено диалогов: ${dump.dialogsSeen}. Остановка: ${dump.stoppedBecause}.`,
    '',
    `Файл: ${path}`,
    '',
    '—'.repeat(60),
    'Дальше: проверь файл глазами, лишние пометь SKIP,',
    'потом: yarn reviews:build <имя файла>',
    '',
  ].join('\n');
}
