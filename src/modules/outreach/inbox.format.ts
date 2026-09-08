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
  /** Сколько кандидатов есть в базе всего. */
  candidatesTotal: number;
  /**
   * Сколько кандидатов проход НЕ увидел.
   *
   * Обход идёт по последним диалогам аккаунта, и старый диалог, утонувший
   * ниже окна, становится невидимым. Молча — до тех пор, пока эту цифру не
   * начали печатать. Живой случай: 190 человек из 1102 не осматривались, и
   * сообщение двухнедельной давности нашлось только руками.
   */
  candidatesUnseen: number;
  /**
   * Сколько диалогов аккаунта обход прошёл ВСЕГО — вместе с группами и
   * чужими людьми. Если это число меньше DIALOGS_LIMIT, окно ни при чём:
   * диалогов у аккаунта просто столько, и неосмотренных среди них нет.
   */
  dialogsIterated: number;
  /**
   * Кого не нашли — поимённо. Без этого списка причина неосмотренных
   * угадывалась неделю: архив, лимит, неудачные отправки. С ним она
   * проверяется одним взглядом в телеграм.
   */
  unseen: Array<{ tgUserId: string; username: string | null; contactedAt: Date | null }>;
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
    return lines.join('\n') + renderUnseen(dump);
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

  // Список ненайденных — в самом конце, после тривиального: это не работа
  // на сегодня, а материал для разбора.
  return lines.join('\n') + renderUnseen(dump);
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

function renderUnseen(dump: InboxDump): string {
  // Защитно: рендер не должен падать на неполной выгрузке из чужого мока.
  const unseen = dump.unseen ?? [];
  if (unseen.length === 0) return '';
  const lines = [
    '',
    '---',
    '',
    `# Не найдены среди диалогов — ${unseen.length}`,
    '',
    'Помечены как «написано», но диалога с ними обход не увидел. Причины бывают',
    'разные: чат удалён, человек заблокировал, пометка «написано» стояла',
    'вручную. Проверь нескольких глазами в телеграме — по ним станет ясно, что',
    'делать с остальными.',
    '',
  ];
  const sorted = [...unseen].sort(
    (a, b) => (a.contactedAt?.getTime() ?? 0) - (b.contactedAt?.getTime() ?? 0),
  );
  for (const u of sorted) {
    const when = u.contactedAt
      ? u.contactedAt.toISOString().slice(0, 10)
      : 'дата неизвестна';
    lines.push(
      `- ${u.username ? '@' + u.username : 'id' + u.tgUserId}  ·  написано ${when}`,
    );
  }
  return lines.join('\n') + '\n';
}

export function formatInboxSummary(dump: InboxDump, path: string): string {
  return [
    '',
    `Выгрузка на ${dump.createdAt}: нужен ответ — ${dump.dialogs.length}, тривиальных — ${dump.trivial.length}.`,
    `Проверено диалогов с теми, кому писали: ${dump.dialogsSeen} из ${dump.candidatesTotal}. Остановка: ${dump.stoppedBecause}.`,
    ...(dump.candidatesUnseen > 0
      ? [
          '',
          `⚠ НЕ НАЙДЕНО СРЕДИ ДИАЛОГОВ: ${dump.candidatesUnseen}. Обход прошёл ${dump.dialogsIterated} диалогов.`,
          ...(dump.dialogsIterated >= dump.candidatesTotal
            ? [
                '  Окно обхода не упёрлось в лимит — этих людей нет в списке диалогов аккаунта.',
                '  Список в конце файла: проверь по нескольким в телеграме, есть ли с ними чат.',
              ]
            : [
                '  Обход мог упереться в лимит — подними DIALOGS_LIMIT в .env и повтори.',
              ]),
        ]
      : []),
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
