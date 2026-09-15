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
  /** Имя телеграм-аккаунта, в чьей личке лежит переписка (`main`/`second`). */
  account?: string;
  /** Его @ник — чтобы человек понимал, о каком номере речь. */
  accountTitle?: string;
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
   * Потолок обхода на этот запуск (DIALOGS_LIMIT). Нужен, чтобы отличить
   * «упёрлись в лимит» от «диалоги у аккаунта просто закончились»: без него
   * подсказка сравнивала пройденное с числом кандидатов и советовала поднять
   * лимит там, где он ни при чём.
   *
   * Лимит применяется К КАЖДОМУ аккаунту: у каждой лички своё окно обхода.
   * Поэтому сравнивать `dialogsIterated` надо с лимитом, умноженным на число
   * аккаунтов, — см. `accounts.length`.
   */
  dialogsLimit: number;
  /**
   * Разрез по аккаунтам: где сколько нашлось. С одним аккаунтом строка
   * ровно одна, и в отчёт она не печатается — повторяла бы общий итог.
   */
  accounts: Array<{
    name: string;
    title: string;
    /** Диалогов с теми, кому писали, осмотрено этим аккаунтом. */
    seen: number;
    /** Из них требуют ответа. */
    needReply: number;
  }>;
  /**
   * У кого переписка исчезла — поимённо.
   *
   * Это НЕ сбой обхода, и выяснилось это дорого: 15.09.2026 три гипотезы
   * подряд (архив, устаревшие id, неполный список) не подтвердились, а
   * прямая выгрузка показала, что чатов действительно нет — ни по id, ни
   * по нику, включая людей, которым мы писали тем же утром.
   *
   * Так выглядит «Сообщить о спаме» и «Удалить чат» на той стороне: в
   * личной переписке, начатой незнакомцем, Telegram сносит наше сообщение
   * у обоих, а пустой диалог из списка пропадает. Поэтому цифра здесь —
   * не про инструмент, а про рассылку: сколько людей стёрли нас.
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

  // Аккаунт подписываем, только если он не один: приписка «@мой_основной»
  // в каждом блоке, пока номер единственный, — чистый шум.
  const accounts = new Set(
    [...dump.dialogs, ...dump.trivial].map((d) => d.account).filter(Boolean),
  );
  const showAccount = accounts.size > 1 || (accounts.size === 1 && !accounts.has('main'));

  dump.dialogs.forEach((d) => lines.push(...renderDialog(d, showAccount)));

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
    dump.trivial.forEach((d) => lines.push(...renderDialog(d, showAccount)));
  }

  // Список ненайденных — в самом конце, после тривиального: это не работа
  // на сегодня, а материал для разбора.
  return lines.join('\n') + renderUnseen(dump);
}

function renderDialog(d: InboxDialog, showAccount = false): string[] {
  const lines: string[] = [
    `## id${d.tgUserId}${d.username ? ` @${d.username}` : ''}`,
    '',
    ...(showAccount
      ? [`- переписка с аккаунта: ${d.accountTitle ?? d.account ?? '—'}`]
      : []),
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
    `# Переписка исчезла — ${unseen.length}`,
    '',
    'Мы им писали, а чата с ними больше нет ни в одной папке. Так выглядит',
    '«Сообщить о спаме» или «Удалить чат» у получателя: наше сообщение сносится',
    'у обоих, и пустой диалог уходит из списка. Отвечать тут некому и не на что —',
    'список нужен, чтобы видеть, кто именно и когда нас стёр.',
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
    ...summaryAccountLines(dump),
    ...(dump.candidatesUnseen > 0
      ? [
          '',
          `ПЕРЕПИСКА ИСЧЕЗЛА У ${dump.candidatesUnseen} — это ${sharePercent(dump)}% всех, кому писали.`,
          ...(dump.dialogsIterated >= totalDialogsLimit(dump)
            ? [
                `  Осторожно: обход прошёл ${dump.dialogsIterated} диалогов из ${totalDialogsLimit(dump)} возможных`,
                '  и упёрся в лимит — часть чатов могла не попасть в окно. Подними',
                '  DIALOGS_LIMIT в .env и повтори, прежде чем верить цифре.',
              ]
            : [
                '  Чата с ними нет ни в одной папке ни на одном аккаунте — ни по id,',
                '  ни по нику. Так выглядит «Сообщить о спаме» или «Удалить чат» на',
                '  той стороне: Telegram сносит наше сообщение у обоих, и пустой',
                '  диалог пропадает из списка.',
                '',
                '  Это метрика рассылки, а не сбой инструмента. Растёт — значит текст',
                '  или темп начали раздражать, и следующим будет ограничение аккаунта.',
                '  Список в конце файла.',
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

/**
 * Сколько диалогов обход мог пройти всего. DIALOGS_LIMIT — окно на КАЖДЫЙ
 * аккаунт, поэтому с двумя аккаунтами потолок вдвое выше. Без умножения
 * подсказка советовала бы поднять лимит на ровном месте.
 */
/** Доля стёрших нас — от всех, кому мы писали. */
function sharePercent(dump: InboxDump): number {
  if (dump.candidatesTotal === 0) return 0;
  return Math.round((100 * dump.candidatesUnseen) / dump.candidatesTotal);
}

function totalDialogsLimit(dump: InboxDump): number {
  return dump.dialogsLimit * Math.max(1, dump.accounts?.length ?? 1);
}

/** Где что нашлось. Пока аккаунт один, строка повторяла бы общий итог. */
function summaryAccountLines(dump: InboxDump): string[] {
  const accounts = dump.accounts ?? [];
  if (accounts.length < 2) return [];

  return [
    'По аккаунтам: ' +
      accounts
        .map((a) => `${a.title} — осмотрено ${a.seen}, нужен ответ ${a.needReply}`)
        .join('; '),
  ];
}

function oneLine(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= 300 ? clean : `${clean.slice(0, 300).trimEnd()}…`;
}
