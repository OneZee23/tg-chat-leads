import { OUTBOX_DIR } from '@modules/outreach/reply-files';

/**
 * Рендер выгрузки неотвеченного.
 *
 * Файл читают двое: ассистент, который пишет ответы, и человек, который их
 * вычитывает. Поэтому markdown, а не JSON, и поэтому заголовки записей
 * ровно те, что ждёт парсер outbox — ассистент их копирует.
 */

export interface InboxMessage {
  /** true — наше, false — его. */
  out: boolean;
  at: string;
  text: string;
  /** Входящее после курсора: именно на это надо ответить. */
  fresh: boolean;
}

export interface InboxDialog {
  tgUserId: string;
  username: string | null;
  /** Чем зацепили в первом письме. */
  hook: string;
  /** Объявление человека из чата — по нему видно, что он преподаёт. */
  about: string | null;
  /** Вердикт эвристики: второе мнение, не приговор. */
  heuristic: { kind: string; action: string; reason: string };
  history: InboxMessage[];
}

export interface InboxDump {
  createdAt: string;
  /**
   * Сколько диалогов с людьми, кому мы писали, реально проверили. Не «все
   * диалоги аккаунта»: по остальным проход не ходит.
   */
  dialogsSeen: number;
  /** Содержательные: нужен ответ. */
  dialogs: InboxDialog[];
  /** Эвристика говорит «ответа не требует»: закрывается пачкой через CLOSE. */
  trivial: InboxDialog[];
  stoppedBecause: string;
}

export function formatInbox(dump: InboxDump): string {
  const lines: string[] = [
    `# Неотвеченное на ${dump.createdAt}`,
    '',
    `Нужен ответ: ${dump.dialogs.length}. Тривиальных: ${dump.trivial.length}. Проверено диалогов с теми, кому писали: ${dump.dialogsSeen}.`,
    '',
    `Ответы писать в \`${OUTBOX_DIR}/\` файлом с тем же именем. На каждую запись —`,
    'заголовок как здесь, затем `SEND` + текст, либо `CLOSE`, либо `ASK` + вопрос.',
    'Правила ответа — `docs/reply-guidelines.md`.',
    '',
  ];

  if (dump.dialogs.length === 0 && dump.trivial.length === 0) {
    lines.push('Неотвеченного нет — все, кто писал, уже получили ответ.', '');
    return lines.join('\n');
  }

  dump.dialogs.forEach((d) => lines.push(...renderDialog(d)));

  if (dump.trivial.length > 0) {
    lines.push(
      '---',
      '',
      '# Тривиальное',
      '',
      'Эвристика считает, что ответа не требует («ок», «спасибо»). Проверь глазами',
      'и оставь `CLOSE`, если согласен.',
      '',
    );
    dump.trivial.forEach((d) => lines.push(...renderDialog(d)));
  }

  return lines.join('\n');
}

function renderDialog(d: InboxDialog): string[] {
  const lines: string[] = [
    `## id${d.tgUserId}${d.username ? ` @${d.username}` : ''}`,
    '',
    `- наш хук: ${d.hook}`,
    `- о себе в чате: ${d.about ? oneLine(d.about) : '—'}`,
    `- эвристика: ${d.heuristic.kind} / ${d.heuristic.action} — ${d.heuristic.reason}`,
    '',
    '```',
  ];

  d.history.forEach((m) => {
    const who = m.out ? 'мы ' : 'он ';
    const mark = m.fresh ? '  ← НЕОТВЕЧЕНО' : '';
    lines.push(`${m.at}  ${who}${mark}`);
    m.text.split(/\r?\n/).forEach((piece) => lines.push(`    ${piece}`));
  });

  lines.push('```', '');
  return lines;
}

export function formatInboxSummary(dump: InboxDump, path: string): string {
  return [
    '',
    `Выгрузка на ${dump.createdAt}: нужен ответ — ${dump.dialogs.length}, тривиальных — ${dump.trivial.length}.`,
    `Проверено диалогов с теми, кому писали: ${dump.dialogsSeen}. Остановка: ${dump.stoppedBecause}.`,
    '',
    `Файл: ${path}`,
    '',
    '—'.repeat(60),
    'Дальше: попроси ассистента прочитать этот файл и написать ответы',
    `в ${OUTBOX_DIR}/ файлом с тем же именем. Потом: yarn outbox (предпросмотр),`,
    'затем yarn outbox:send.',
    '',
  ].join('\n');
}

function oneLine(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= 300 ? clean : `${clean.slice(0, 300).trimEnd()}…`;
}
