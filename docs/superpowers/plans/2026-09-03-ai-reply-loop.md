# Цикл ответов на входящие — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Свести обработку пачки входящих ответов к «`yarn inbox` → вычитать файл → `yarn outbox:send`», где содержательные ответы пишет ассистент с доступом к монорепозиторию, а не шаблон.

**Architecture:** Обмен через markdown-файлы. Сервер выгружает неотвеченное в `inbox/<стамп>.md`, ассистент пишет `outbox/<тот же стамп>.md` с директивами `SEND`/`CLOSE`/`ASK`, сервер парсит и отправляет, перечитывая историю каждого диалога перед отправкой. Внешних API нет, ключей нет, схема базы не меняется — миграций в этом плане нет вовсе.

**Tech Stack:** NestJS 10, TypeORM 0.3 (только чтение, без изменений схемы), GramJS (`telegram` 2.26), Jest + ts-jest.

**Spec:** `docs/superpowers/specs/2026-09-03-ai-reply-loop-design.md`

## Global Constraints

- **Ветка `master`.** Коммиты: `feat: …`, `fix: …`, `chore: …`, короткий текст на русском. **Никогда не добавлять `Co-Authored-By`.**
- **`target: es2021`, `lib` не задан.** `Array.prototype.at()` (ES2022) недоступен — брать последний элемент через индекс.
- **`strictNullChecks: false`, `noImplicitAny: false`, `noUnusedLocals: true`** — неиспользуемая локальная переменная роняет сборку.
- Пути через алиасы `@common/*`, `@infra/*`, `@modules/*`. Относительных импортов между модулями в репе нет.
- Комментарии и тексты — по-русски. Комментарий объясняет **почему**, а не что.
- Тесты: `*.spec.ts` рядом с кодом, `rootDir: src`, запуск `yarn test`.
- **Никаких `docker build` локально.**
- **Ключ записи — `tgUserId` (строка), не `@username`.** Ник меняется, у части людей отсутствует.
- **Dry-run по умолчанию** у всего, что пишет в Telegram. Боевой прогон — только с явным `send=true`.
- **Лимит тела ответа — 4000 символов** (у Telegram 4096, оставляем запас).
- Валидация на каждом входе контроллера: `@MaxLength`, `@Min`, `@Max` — как в существующих DTO.
- **После правок DI прогонять реальный bootstrap** (`yarn build && node dist/main.js`): юнит-тесты собирают сервисы мимо контейнера и DI-цикл не поймают.
- Ошибка отправки в Telegram **останавливает проход**, а не пропускает элемент: половина отправленной пачки хуже, чем ни одной.

## Структура файлов

Создаётся:

| Файл | Ответственность |
|---|---|
| `src/modules/dialogs/unanswered.ts` | Чистая логика курсора: что в истории диалога осталось без нашего ответа. Не знает про Telegram и базу. |
| `src/modules/dialogs/unanswered.spec.ts` | Тесты курсора. |
| `src/modules/outreach/outbox.parse.ts` | Парсер outbox-md в записи с директивами. Чистая функция. |
| `src/modules/outreach/outbox.parse.spec.ts` | Тесты парсера, включая всё, что должно ронять разбор. |
| `src/modules/outreach/reply-files.ts` | Пути `inbox/`/`outbox/`, чтение и запись, guard по basename, разбор стампа из имени. |
| `src/modules/outreach/reply-files.spec.ts` | Тесты guard'а и стампа. |
| `src/modules/outreach/inbox.format.ts` | Рендер inbox-md и терминальной сводки. Объявляет типы выгрузки. |
| `src/modules/outreach/inbox.format.spec.ts` | Тесты рендера. |
| `src/modules/outreach/outbox.format.ts` | Рендер результата отправки в терминал. |
| `src/modules/outreach/outbox.format.spec.ts` | Тесты рендера результата. |
| `scripts/outbox.sh` | `yarn outbox [файл]` — по умолчанию самый свежий файл в `outbox/`. |
| `docs/reply-guidelines.md` | Правила ответа: что можно обещать, чего нельзя, когда обязан уйти в `ASK`. |

Правится:

| Файл | Что |
|---|---|
| `src/modules/lead/lead.service.ts` | `getDialogCandidates()` — новый запрос. `getAutoReplyCandidates()` не трогать. |
| `src/modules/dialogs/dialogs.service.ts` | `collectUnanswered()`, `sendPreparedReplies()`. |
| `src/modules/outreach/outreach.service.ts` | `inbox()`, `outboxSend()`. |
| `src/modules/outreach/outreach.controller.ts` | Две ручки + DTO. |
| `package.json` | Скрипты `inbox`, `outbox`, `outbox:send`. |
| `.gitignore` | `inbox/`, `outbox/`. |
| `CLAUDE.md`, `README.md` | Описание потока. |

Границы: чистые функции (`unanswered`, `outbox.parse`, форматтеры) не знают ни про Telegram, ни про базу. `DialogsService` владеет Telegram-I/O и ничего не знает про markdown. `OutreachService` склеивает и трогает файлы.

---

### Task 1: Курсор неотвеченного

Фундамент: чистая логика «что в диалоге осталось без ответа». Отдельно от Telegram, потому что это единственная часть, где легко ошибиться, и единственная, которую иначе не проверить.

**Files:**
- Create: `src/modules/dialogs/unanswered.ts`
- Test: `src/modules/dialogs/unanswered.spec.ts`

**Interfaces:**
- Consumes: ничего.
- Produces: `HistoryMessage { out: boolean; date: number; message: string }`, `UnansweredSlice { cursorSec: number; incoming: HistoryMessage[]; history: HistoryMessage[] }`, `sliceUnanswered(messages: HistoryMessage[], contactedAtSec: number): UnansweredSlice`.

- [ ] **Step 1: Написать падающий тест**

`src/modules/dialogs/unanswered.spec.ts`:

```ts
import { sliceUnanswered } from '@modules/dialogs/unanswered';

/** Хелпер: GramJS отдаёт историю от НОВЫХ к старым — так и передаём. */
function msg(out: boolean, date: number, message: string) {
  return { out, date, message };
}

describe('sliceUnanswered', () => {
  it('курсор — последнее НАШЕ исходящее, а не первое письмо', () => {
    // Мы написали (100), он ответил (200), мы ответили (300), он спросил ещё (400).
    const history = [
      msg(false, 400, 'а как завести учеников?'),
      msg(true, 300, 'рад что заинтересовало'),
      msg(false, 200, 'выглядит интересно'),
      msg(true, 100, 'здравствуйте!'),
    ];

    const slice = sliceUnanswered(history, 100);

    expect(slice.cursorSec).toBe(300);
    expect(slice.incoming.map((m) => m.message)).toEqual(['а как завести учеников?']);
  });

  it('мы ответили последними — отвечать нечего', () => {
    const history = [msg(true, 300, 'ответ'), msg(false, 200, 'вопрос'), msg(true, 100, 'письмо')];
    expect(sliceUnanswered(history, 100).incoming).toEqual([]);
  });

  it('нашего исходящего в окне нет — курсор падает на дату письма', () => {
    // Человек написал больше, чем мы читаем: наше письмо уже за границей окна.
    const history = [msg(false, 400, 'третье'), msg(false, 300, 'второе'), msg(false, 200, 'первое')];

    const slice = sliceUnanswered(history, 150);

    expect(slice.cursorSec).toBe(150);
    expect(slice.incoming.map((m) => m.message)).toEqual(['первое', 'второе', 'третье']);
  });

  it('история отдаётся от старых к новым — это контекст для ответа', () => {
    const history = [msg(false, 200, 'новое'), msg(true, 100, 'старое')];
    expect(sliceUnanswered(history, 100).history.map((m) => m.message)).toEqual([
      'старое',
      'новое',
    ]);
  });

  it('пустые и служебные сообщения не считаются ответом', () => {
    // Стикер/фото приходят с пустым message. Отвечать на них шаблоном не на что,
    // и попадание такого диалога в выгрузку — просто шум.
    const history = [msg(false, 200, '   '), msg(true, 100, 'письмо')];
    expect(sliceUnanswered(history, 100).incoming).toEqual([]);
  });

  it('несколько входящих подряд отдаются все — человек дописывал мысль', () => {
    const history = [
      msg(false, 320, 'и ещё сколько стоит?'),
      msg(false, 310, 'а расписание есть?'),
      msg(true, 300, 'наш ответ'),
    ];
    expect(sliceUnanswered(history, 100).incoming.map((m) => m.message)).toEqual([
      'а расписание есть?',
      'и ещё сколько стоит?',
    ]);
  });

  it('пустая история — пустой результат, без падения', () => {
    const slice = sliceUnanswered([], 100);
    expect(slice.cursorSec).toBe(100);
    expect(slice.incoming).toEqual([]);
    expect(slice.history).toEqual([]);
  });
});
```

- [ ] **Step 2: Прогнать тест и убедиться, что он падает**

Run: `yarn test src/modules/dialogs/unanswered.spec.ts`
Expected: FAIL — `Cannot find module '@modules/dialogs/unanswered'`.

- [ ] **Step 3: Реализация**

`src/modules/dialogs/unanswered.ts`:

```ts
/**
 * Что в диалоге осталось без нашего ответа.
 *
 * Курсор — дата ПОСЛЕДНЕГО нашего исходящего, а не первого письма. Так было
 * не всегда: `autoReplyUnanswered` считает от `contacted_at`, и поэтому
 * диалог, где мы ответили хотя бы раз, становится невидимым навсегда —
 * человек, написавший «а как завести учеников?» после нашего ответа,
 * терялся. А это самые тёплые лиды из всех.
 */

export interface HistoryMessage {
  /** true — наше исходящее, false — его. */
  out: boolean;
  /** Unix-секунды, как отдаёт GramJS. */
  date: number;
  message: string;
}

export interface UnansweredSlice {
  /** Дата, после которой всё входящее считается неотвеченным. */
  cursorSec: number;
  /** Непустые входящие после курсора, от старых к новым. Пусто — отвечать нечего. */
  incoming: HistoryMessage[];
  /** Вся переписка от старых к новым — контекст для ответа. */
  history: HistoryMessage[];
}

export function sliceUnanswered(
  messages: HistoryMessage[],
  contactedAtSec: number,
): UnansweredSlice {
  // GramJS отдаёт от новых к старым; и читать, и рендерить удобнее наоборот.
  const history = [...(messages ?? [])].sort((a, b) => a.date - b.date);

  const outgoing = history.filter((m) => m.out);
  // Нашего исходящего в окне нет вовсе (человек написал больше сообщений, чем
  // мы читаем) — падаем назад на дату письма. Иначе курсора не будет совсем
  // и в выгрузку уедет вся переписка.
  const cursorSec =
    outgoing.length > 0 ? outgoing[outgoing.length - 1].date : contactedAtSec;

  const incoming = history.filter(
    (m) => !m.out && m.date > cursorSec && (m.message ?? '').trim().length > 0,
  );

  return { cursorSec, incoming, history };
}
```

Строго `>`, а не `>=`: ответ в ту же секунду, что наша отправка, физически не случается, а `>=` вернул бы наше же сообщение в набор входящих при совпадении дат.

- [ ] **Step 4: Прогнать тесты**

Run: `yarn test src/modules/dialogs/unanswered.spec.ts`
Expected: PASS, 7 тестов.

- [ ] **Step 5: Коммит**

```bash
git add src/modules/dialogs/unanswered.ts src/modules/dialogs/unanswered.spec.ts
git commit -m "feat: курсор неотвеченного — от последнего нашего сообщения, а не от письма"
```

---

### Task 2: Парсер outbox

**Files:**
- Create: `src/modules/outreach/outbox.parse.ts`
- Test: `src/modules/outreach/outbox.parse.spec.ts`

**Interfaces:**
- Consumes: ничего.
- Produces: `OutboxDirective = 'send' | 'close' | 'ask'`, `OutboxEntry { tgUserId: string; username: string | null; directive: OutboxDirective; body: string }`, `OutboxParseError extends Error`, `MAX_REPLY_LEN = 4000`, `parseOutbox(raw: string): OutboxEntry[]`, `extractRecordIds(raw: string): string[]`.

- [ ] **Step 1: Написать падающий тест**

`src/modules/outreach/outbox.parse.spec.ts`:

```ts
import {
  OutboxParseError,
  extractRecordIds,
  parseOutbox,
} from '@modules/outreach/outbox.parse';

describe('parseOutbox', () => {
  it('разбирает три директивы и многострочное тело', () => {
    const raw = [
      'Преамбула, которую ассистент может дописать — она игнорируется.',
      '',
      '## id123456789 @teacher',
      '',
      'SEND',
      'Супер, рад что заинтересовало)',
      '',
      'Учеников можно завести списком.',
      '',
      '## id987654321 @another',
      'ASK',
      'Спрашивает про Zoom, его нет. Как отвечаем?',
      '',
      '## id555555555',
      'CLOSE',
      '',
    ].join('\n');

    const entries = parseOutbox(raw);

    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual({
      tgUserId: '123456789',
      username: 'teacher',
      directive: 'send',
      body: 'Супер, рад что заинтересовало)\n\nУчеников можно завести списком.',
    });
    expect(entries[1].directive).toBe('ask');
    expect(entries[2]).toEqual({
      tgUserId: '555555555',
      username: null,
      directive: 'close',
      body: '',
    });
  });

  it('директива в любом регистре — файл правят руками', () => {
    const entries = parseOutbox('## id1\nSend\nтекст\n');
    expect(entries[0].directive).toBe('send');
  });

  it('опечатка в директиве роняет разбор целиком', () => {
    // Половина отправленной пачки хуже, чем ни одной: непонятно, где встали.
    expect(() => parseOutbox('## id1\nSEDN\nтекст\n')).toThrow(OutboxParseError);
  });

  it('директивы нет вовсе — ошибка, а не «отправить тело»', () => {
    expect(() => parseOutbox('## id1\nпросто текст без директивы\n')).toThrow(
      OutboxParseError,
    );
  });

  it('пустое тело у SEND — ошибка', () => {
    expect(() => parseOutbox('## id1\nSEND\n\n')).toThrow(OutboxParseError);
  });

  it('пустое тело у ASK и CLOSE допустимо', () => {
    expect(parseOutbox('## id1\nASK\n\n## id2\nCLOSE\n')).toHaveLength(2);
  });

  it('дубль id роняет разбор — иначе человек получит два сообщения', () => {
    expect(() => parseOutbox('## id1\nSEND\nа\n\n## id1\nSEND\nб\n')).toThrow(
      OutboxParseError,
    );
  });

  it('тело длиннее лимита Telegram — ошибка', () => {
    const long = 'я'.repeat(4001);
    expect(() => parseOutbox(`## id1\nSEND\n${long}\n`)).toThrow(OutboxParseError);
  });

  it('файл без записей — ошибка: почти всегда это забытая выгрузка', () => {
    expect(() => parseOutbox('# Ответы\n\nничего не заполнил\n')).toThrow(
      OutboxParseError,
    );
  });

  it('заголовок не того уровня не считается записью', () => {
    // `# id1` — не запись. Такой диалог попадёт в «не тронуто» в итоге,
    // а не молча уедет с чужим телом.
    expect(() => parseOutbox('# id1\nSEND\nтекст\n')).toThrow(OutboxParseError);
  });

  it('извлекает id заголовков без разбора тел — этим же читается inbox-файл', () => {
    // Формат заголовка у inbox и outbox один и тот же by design, поэтому
    // «кому ответ не написали» считается той же функцией.
    expect(extractRecordIds('## id1 @a\nтело\n## id2\nтело\n')).toEqual(['1', '2']);
    expect(extractRecordIds('нет заголовков')).toEqual([]);
  });

  it('ведущие и хвостовые пустые строки в теле срезаются', () => {
    const entries = parseOutbox('## id1\nSEND\n\n\n  текст  \n\n\n');
    expect(entries[0].body).toBe('текст');
  });
});
```

- [ ] **Step 2: Прогнать тест и убедиться, что он падает**

Run: `yarn test src/modules/outreach/outbox.parse.spec.ts`
Expected: FAIL — модуль не найден.

- [ ] **Step 3: Реализация**

`src/modules/outreach/outbox.parse.ts`:

```ts
/**
 * Разбор файла с ответами, который заполняет ассистент.
 *
 * Формат намеренно тупой — markdown, который правят руками:
 *
 *   ## id123456789 @username
 *   SEND
 *   текст ответа, можно в несколько абзацев
 *
 * Всё, что ломает формат, роняет разбор ЦЕЛИКОМ и не отправляет ничего:
 * половина отправленной пачки хуже, чем ни одной, потому что непонятно,
 * где остановились и что переделывать.
 */

export type OutboxDirective = 'send' | 'close' | 'ask';

export interface OutboxEntry {
  tgUserId: string;
  username: string | null;
  directive: OutboxDirective;
  /** Текст ответа для send; вопрос к автору для ask; комментарий для close. */
  body: string;
}

export class OutboxParseError extends Error {}

/** У Telegram 4096; запас на всякий случай. */
export const MAX_REPLY_LEN = 4000;

// Ключ — id, а не ник: ник человек меняет когда захочет, у части его нет.
// Ровно так же устроен дедуп лидов.
const HEADER = /^##\s+id(\d{1,20})(?:\s+@?([A-Za-z0-9_]{1,64}))?\s*$/;

const DIRECTIVES: Record<string, OutboxDirective> = {
  send: 'send',
  close: 'close',
  ask: 'ask',
};

interface RawRecord {
  tgUserId: string;
  username: string | null;
  lines: string[];
}

/**
 * Только id записей, без разбора тел. Нужно, чтобы сверить outbox с самой
 * выгрузкой и назвать вслух тех, кому ответ не написали вовсе: молчаливая
 * потеря лида — ровно то, от чего мы уходим.
 */
export function extractRecordIds(raw: string): string[] {
  const ids: string[] = [];
  for (const line of (raw ?? '').split(/\r?\n/)) {
    const header = HEADER.exec(line);
    if (header) ids.push(header[1]);
  }
  return ids;
}

export function parseOutbox(raw: string): OutboxEntry[] {
  const records: RawRecord[] = [];

  for (const line of (raw ?? '').split(/\r?\n/)) {
    const header = HEADER.exec(line);
    if (header) {
      records.push({ tgUserId: header[1], username: header[2] ?? null, lines: [] });
      continue;
    }
    // До первого заголовка — преамбула: ассистент может написать там что
    // угодно для человека, на разбор это не влияет.
    if (records.length > 0) records[records.length - 1].lines.push(line);
  }

  if (records.length === 0) {
    throw new OutboxParseError(
      'В файле нет ни одной записи вида «## id123 @nick». Похоже, ответы не заполнены.',
    );
  }

  const entries = records.map(toEntry);

  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.tgUserId)) {
      throw new OutboxParseError(
        `id${entry.tgUserId} встречается дважды — человек получил бы два сообщения. Оставь одну запись.`,
      );
    }
    seen.add(entry.tgUserId);
  }

  return entries;
}

function toEntry(record: RawRecord): OutboxEntry {
  const firstMeaningful = record.lines.findIndex((l) => l.trim().length > 0);
  if (firstMeaningful === -1) {
    throw new OutboxParseError(
      `id${record.tgUserId}: после заголовка нет директивы. Нужна строка SEND, CLOSE или ASK.`,
    );
  }

  const token = record.lines[firstMeaningful].trim().toLowerCase();
  const directive = DIRECTIVES[token];
  if (!directive) {
    throw new OutboxParseError(
      `id${record.tgUserId}: «${record.lines[firstMeaningful].trim()}» — не директива. Ожидается SEND, CLOSE или ASK.`,
    );
  }

  const body = record.lines
    .slice(firstMeaningful + 1)
    .join('\n')
    .trim();

  if (directive === 'send' && body.length === 0) {
    throw new OutboxParseError(`id${record.tgUserId}: SEND без текста. Нечего отправлять.`);
  }
  if (body.length > MAX_REPLY_LEN) {
    throw new OutboxParseError(
      `id${record.tgUserId}: текст ${body.length} символов, лимит ${MAX_REPLY_LEN}.`,
    );
  }

  return { tgUserId: record.tgUserId, username: record.username, directive, body };
}
```

- [ ] **Step 4: Прогнать тесты**

Run: `yarn test src/modules/outreach/outbox.parse.spec.ts`
Expected: PASS, 12 тестов.

- [ ] **Step 5: Коммит**

```bash
git add src/modules/outreach/outbox.parse.ts src/modules/outreach/outbox.parse.spec.ts
git commit -m "feat: парсер outbox — SEND/CLOSE/ASK, битый формат роняет разбор целиком"
```

---

### Task 3: Файловый слой

**Files:**
- Create: `src/modules/outreach/reply-files.ts`
- Test: `src/modules/outreach/reply-files.spec.ts`

**Interfaces:**
- Consumes: ничего.
- Produces: `INBOX_DIR = 'inbox'`, `OUTBOX_DIR = 'outbox'`, `UnsafeFileNameError extends Error`, `assertSafeName(name: string): void`, `inboxFileName(now: Date): string`, `parseDumpTimestamp(name: string): number | null`, `writeInbox(name: string, content: string, baseDir?: string): string`, `readInbox(name: string, baseDir?: string): string | null`, `readOutbox(name: string, baseDir?: string): string`, `newestOutboxName(baseDir?: string): string | null`.

- [ ] **Step 1: Написать падающий тест**

`src/modules/outreach/reply-files.spec.ts`:

```ts
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  UnsafeFileNameError,
  assertSafeName,
  inboxFileName,
  newestOutboxName,
  parseDumpTimestamp,
  readInbox,
  readOutbox,
  writeInbox,
} from '@modules/outreach/reply-files';

describe('assertSafeName', () => {
  it('пропускает обычное имя выгрузки', () => {
    expect(() => assertSafeName('2026-09-03-1430.md')).not.toThrow();
  });

  it('режет выход из папки', () => {
    // Ручка висит на localhost, но читать по её просьбе произвольный файл
    // с диска всё равно нечего.
    for (const bad of ['../.env', '../../.env', 'a/b.md', '/etc/passwd', '..', 'a..b']) {
      expect(() => assertSafeName(bad)).toThrow(UnsafeFileNameError);
    }
  });

  it('режет пустое и слишком длинное имя', () => {
    expect(() => assertSafeName('')).toThrow(UnsafeFileNameError);
    expect(() => assertSafeName(`${'a'.repeat(80)}.md`)).toThrow(UnsafeFileNameError);
  });
});

describe('inboxFileName', () => {
  it('стамп до минуты — по нему видно пару inbox/outbox', () => {
    expect(inboxFileName(new Date(2026, 8, 3, 14, 30))).toBe('2026-09-03-1430.md');
  });

  it('однозначные месяц, день, час и минута дополняются нулём', () => {
    expect(inboxFileName(new Date(2026, 0, 5, 7, 9))).toBe('2026-01-05-0709.md');
  });
});

describe('parseDumpTimestamp', () => {
  it('достаёт момент выгрузки из имени файла', () => {
    const at = parseDumpTimestamp('2026-09-03-1430.md');
    expect(at).toBe(Math.floor(new Date(2026, 8, 3, 14, 30).getTime() / 1000));
  });

  it('имя переименовали руками — null, проверку свежести делать не по чему', () => {
    expect(parseDumpTimestamp('ответы-на-вторник.md')).toBeNull();
  });
});

describe('writeInbox / readOutbox / newestOutboxName', () => {
  function sandbox(): string {
    return mkdtempSync(join(tmpdir(), 'leadgen-'));
  }

  it('записывает выгрузку и возвращает путь', () => {
    const base = sandbox();
    const path = writeInbox('2026-09-03-1430.md', 'привет', base);
    expect(readFileSync(path, 'utf8')).toBe('привет');
  });

  it('читает выгрузку, чтобы сверить, кому ответ не написали', () => {
    const base = sandbox();
    writeInbox('2026-09-03-1430.md', 'выгрузка', base);
    expect(readInbox('2026-09-03-1430.md', base)).toBe('выгрузка');
  });

  it('выгрузки на диске нет — null, а не падение: сверять просто нечем', () => {
    expect(readInbox('2026-09-03-1430.md', sandbox())).toBeNull();
  });

  it('читает outbox по basename', () => {
    const base = sandbox();
    mkdirSync(join(base, 'outbox'));
    writeFileSync(join(base, 'outbox', '2026-09-03-1430.md'), 'тело', 'utf8');
    expect(readOutbox('2026-09-03-1430.md', base)).toBe('тело');
  });

  it('внятная ошибка, если файла нет', () => {
    const base = sandbox();
    expect(() => readOutbox('нет.md', base)).toThrow(UnsafeFileNameError);
  });

  it('самый свежий файл в outbox — по имени, оно же стамп', () => {
    const base = sandbox();
    mkdirSync(join(base, 'outbox'));
    for (const name of ['2026-09-01-1000.md', '2026-09-03-1430.md', '2026-09-02-0900.md']) {
      writeFileSync(join(base, 'outbox', name), 'x', 'utf8');
    }
    expect(newestOutboxName(base)).toBe('2026-09-03-1430.md');
  });

  it('папки outbox нет — null, а не падение', () => {
    expect(newestOutboxName(sandbox())).toBeNull();
  });
});
```

`readOutbox('нет.md')` бросает `UnsafeFileNameError`: имя безопасное, но файла нет — это тот же класс «дай другое имя», и отдельный тип ошибки здесь не окупается. В сообщении — что искали и где.

- [ ] **Step 2: Прогнать тест и убедиться, что он падает**

Run: `yarn test src/modules/outreach/reply-files.spec.ts`
Expected: FAIL — модуль не найден.

- [ ] **Step 3: Реализация**

`src/modules/outreach/reply-files.ts`:

```ts
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Файлы обмена с ассистентом.
 *
 * `inbox/` и `outbox/` лежат в корне репозитория и оба в `.gitignore`: там
 * тексты живых людей, а репозиторий публичный. Логика та же, что у `.env`,
 * `export/` и `posts/cold-outreach/body.md`.
 */

export const INBOX_DIR = 'inbox';
export const OUTBOX_DIR = 'outbox';

export class UnsafeFileNameError extends Error {}

// Только basename: буквы, цифры, точка, дефис, подчёркивание. Слэши и
// абсолютные пути отсекаются набором символов, `..` — отдельной проверкой,
// потому что точка в наборе разрешена.
const SAFE_NAME = /^[A-Za-z0-9._-]{1,64}$/;

export function assertSafeName(name: string): void {
  if (!SAFE_NAME.test(name ?? '') || name.includes('..')) {
    throw new UnsafeFileNameError(
      `Небезопасное имя файла: «${name}». Нужен basename внутри outbox/, например 2026-09-03-1430.md`,
    );
  }
}

/** Стамп до минуты: по имени видно, какой outbox к какому inbox. */
export function inboxFileName(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.md`;
}

const STAMP = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})\.md$/;

/**
 * Момент выгрузки из имени файла, unix-секунды. Нужен, чтобы перед отправкой
 * понять, не написал ли человек ещё раз ПОСЛЕ того, как мы сняли выгрузку:
 * ответ на устаревшую реплику выглядит как невнимательность.
 *
 * null — имя переименовали руками. Тогда проверку свежести делать не по чему,
 * и отправка скажет об этом вслух, а не притворится, что проверила.
 */
export function parseDumpTimestamp(name: string): number | null {
  const m = STAMP.exec(name ?? '');
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const at = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi));
  return Math.floor(at.getTime() / 1000);
}

export function writeInbox(name: string, content: string, baseDir = process.cwd()): string {
  assertSafeName(name);
  const dir = join(baseDir, INBOX_DIR);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, content, 'utf8');
  return path;
}

/**
 * Содержимое выгрузки, если она ещё на диске.
 *
 * null — файла нет (выгрузку сняли на другой машине или удалили). Тогда
 * «кому ответ не написали» посчитать не по чему, и отправка скажет это
 * вслух, а не притворится, что сверила.
 */
export function readInbox(name: string, baseDir = process.cwd()): string | null {
  assertSafeName(name);
  const path = join(baseDir, INBOX_DIR, name);
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8');
}

export function readOutbox(name: string, baseDir = process.cwd()): string {
  assertSafeName(name);
  const path = join(baseDir, OUTBOX_DIR, name);
  if (!existsSync(path)) {
    throw new UnsafeFileNameError(`Файла ${OUTBOX_DIR}/${name} нет. Что лежит рядом: ${listOutbox(baseDir).join(', ') || '(папка пуста)'}`);
  }
  return readFileSync(path, 'utf8');
}

/** Самый свежий файл — чтобы `yarn outbox` работал без аргументов. */
export function newestOutboxName(baseDir = process.cwd()): string | null {
  const names = listOutbox(baseDir);
  if (names.length === 0) return null;
  // Имена — стампы, поэтому лексикографическая сортировка совпадает с
  // хронологической. Читать mtime незачем.
  return [...names].sort().reverse()[0];
}

function listOutbox(baseDir: string): string[] {
  const dir = join(baseDir, OUTBOX_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.endsWith('.md'));
}
```

- [ ] **Step 4: Прогнать тесты**

Run: `yarn test src/modules/outreach/reply-files.spec.ts`
Expected: PASS, 14 тестов.

- [ ] **Step 5: Коммит**

```bash
git add src/modules/outreach/reply-files.ts src/modules/outreach/reply-files.spec.ts
git commit -m "feat: файловый слой inbox/outbox — basename-guard и стамп выгрузки"
```

---

### Task 4: Рендер inbox

**Files:**
- Create: `src/modules/outreach/inbox.format.ts`
- Test: `src/modules/outreach/inbox.format.spec.ts`

**Interfaces:**
- Consumes: `OUTBOX_DIR` из `@modules/outreach/reply-files` (Task 3) — в тексте
  файла упоминается папка, куда класть ответы. Task 3 идёт раньше.
- Produces: `InboxMessage { out: boolean; at: string; text: string; fresh: boolean }`, `InboxDialog { tgUserId: string; username: string | null; hook: string; about: string | null; heuristic: { kind: string; action: string; reason: string }; history: InboxMessage[] }`, `InboxDump { createdAt: string; dialogsSeen: number; dialogs: InboxDialog[]; trivial: InboxDialog[]; stoppedBecause: string }`, `formatInbox(dump: InboxDump): string`, `formatInboxSummary(dump: InboxDump, path: string): string`.

Типы объявлены здесь, а не в `dialogs.service.ts`, чтобы форматтер тестировался без Telegram; `DialogsService` их импортирует. Обратной зависимости нет — цикла не возникает.

- [ ] **Step 1: Написать падающий тест**

`src/modules/outreach/inbox.format.spec.ts`:

```ts
import {
  InboxDialog,
  InboxDump,
  formatInbox,
  formatInboxSummary,
} from '@modules/outreach/inbox.format';

function dialog(over: Partial<InboxDialog> = {}): InboxDialog {
  return {
    tgUserId: '123456789',
    username: 'teacher',
    hook: 'Здравствуйте! Видел, что вы набираете учеников по английскому.',
    about: 'Набираю учеников по английскому, взрослые и подростки',
    heuristic: { kind: 'question', action: 'manual', reason: 'вопрос — нужен твой ответ' },
    history: [
      { out: true, at: '2026-09-01 10:00', text: 'наше письмо', fresh: false },
      { out: false, at: '2026-09-03 14:00', text: 'а сколько стоит?', fresh: true },
    ],
    ...over,
  };
}

function dump(over: Partial<InboxDump> = {}): InboxDump {
  return {
    createdAt: '2026-09-03 14:30',
    dialogsSeen: 412,
    dialogs: [dialog()],
    trivial: [],
    stoppedBecause: 'кандидаты закончились',
    ...over,
  };
}

describe('formatInbox', () => {
  it('заголовок записи — ровно тот, что ждёт парсер outbox', () => {
    // Ассистент копирует заголовки из inbox в outbox. Разъедутся форматы —
    // разбор упадёт на всём файле.
    expect(formatInbox(dump())).toContain('## id123456789 @teacher');
  });

  it('без ника заголовок остаётся валидным', () => {
    const out = formatInbox(dump({ dialogs: [dialog({ username: null })] }));
    expect(out).toContain('## id123456789');
    expect(out).not.toContain('@null');
  });

  it('показывает хук, кем человек представился и вердикт эвристики', () => {
    const out = formatInbox(dump());
    expect(out).toContain('набираете учеников по английскому');
    expect(out).toContain('взрослые и подростки');
    expect(out).toContain('вопрос — нужен твой ответ');
  });

  it('переписка в хронологическом порядке, неотвеченное помечено', () => {
    const out = formatInbox(dump());
    expect(out.indexOf('наше письмо')).toBeLessThan(out.indexOf('а сколько стоит?'));
    // Пометка нужна, чтобы отвечать на новое, а не на всю переписку заново.
    expect(out).toMatch(/НЕОТВЕЧЕНО[\s\S]*а сколько стоит\?/);
  });

  it('тривиальное — отдельным блоком в конце, чтобы не тратить на него внимание', () => {
    const out = formatInbox(
      dump({
        trivial: [
          dialog({
            tgUserId: '555',
            username: null,
            heuristic: { kind: 'neutral', action: 'clear', reason: 'короткое «ок/спасибо»' },
          }),
        ],
      }),
    );
    expect(out.indexOf('## id123456789')).toBeLessThan(out.indexOf('## id555'));
    expect(out).toContain('CLOSE');
  });

  it('пустая выгрузка не превращается в пустой файл', () => {
    const out = formatInbox(dump({ dialogs: [], trivial: [] }));
    expect(out).toContain('Неотвеченного нет');
  });
});

describe('formatInboxSummary', () => {
  it('говорит, где файл и что делать дальше', () => {
    const out = formatInboxSummary(dump(), '/repo/inbox/2026-09-03-1430.md');
    expect(out).toContain('/repo/inbox/2026-09-03-1430.md');
    expect(out).toContain('yarn outbox');
  });
});
```

- [ ] **Step 2: Прогнать тест и убедиться, что он падает**

Run: `yarn test src/modules/outreach/inbox.format.spec.ts`
Expected: FAIL — модуль не найден.

- [ ] **Step 3: Реализация**

`src/modules/outreach/inbox.format.ts`:

```ts
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
```

- [ ] **Step 4: Прогнать тесты**

Run: `yarn test src/modules/outreach/inbox.format.spec.ts`
Expected: PASS, 7 тестов.

- [ ] **Step 5: Коммит**

```bash
git add src/modules/outreach/inbox.format.ts src/modules/outreach/inbox.format.spec.ts
git commit -m "feat: рендер выгрузки неотвеченного — заголовки под парсер outbox"
```

---

### Task 5: Рендер результата отправки

**Files:**
- Create: `src/modules/outreach/outbox.format.ts`
- Test: `src/modules/outreach/outbox.format.spec.ts`

**Interfaces:**
- Consumes: ничего.
- Produces: `OutboxEntryResult = 'preview' | 'sent' | 'closed' | 'asked' | 'skipped' | 'failed'`, `OutboxSendEntry { tgUserId: string; username: string | null; directive: 'send' | 'close' | 'ask'; result: OutboxEntryResult; note?: string }`, `OutboxSendResult { dryRun: boolean; file: string; sent: number; closed: number; asked: number; skipped: number; untouched: number | null; notFound: number; stoppedBecause: string; staleCheck: boolean; entries: OutboxSendEntry[] }`, `formatOutboxResult(result: OutboxSendResult): string`.

- [ ] **Step 1: Написать падающий тест**

`src/modules/outreach/outbox.format.spec.ts`:

```ts
import { OutboxSendResult, formatOutboxResult } from '@modules/outreach/outbox.format';

function result(over: Partial<OutboxSendResult> = {}): OutboxSendResult {
  return {
    dryRun: true,
    file: '2026-09-03-1430.md',
    sent: 1,
    closed: 1,
    asked: 1,
    skipped: 0,
    untouched: 0,
    notFound: 0,
    stoppedBecause: 'записи закончились',
    staleCheck: true,
    entries: [
      { tgUserId: '1', username: 'a', directive: 'send', result: 'preview' },
      { tgUserId: '2', username: null, directive: 'close', result: 'preview' },
      { tgUserId: '3', username: 'c', directive: 'ask', result: 'asked' },
    ],
    ...over,
  };
}

describe('formatOutboxResult', () => {
  it('предпросмотр честно говорит, что ничего не отправлено', () => {
    const out = formatOutboxResult(result());
    expect(out).toContain('ПРЕДПРОСМОТР');
    expect(out).toContain('yarn outbox:send');
  });

  it('боевой прогон не предлагает отправить ещё раз', () => {
    const out = formatOutboxResult(result({ dryRun: false }));
    expect(out).not.toContain('yarn outbox:send');
  });

  it('неразобранное (ASK) видно в итоге — иначе теряется молча', () => {
    expect(formatOutboxResult(result())).toMatch(/Оставлено тебе.*1/);
  });

  it('диалоги из выгрузки, которых нет в outbox, названы вслух', () => {
    // Спека обещает именно это число: «в выгрузке 23, разобрано 19,
    // не тронуто 4». Молчаливая потеря лида — то, от чего мы уходим.
    expect(formatOutboxResult(result({ untouched: 4 }))).toMatch(/не тронуто.*4/i);
  });

  it('выгрузки на диске нет — говорит, что сверить не по чему, а не пишет 0', () => {
    const out = formatOutboxResult(result({ untouched: null }));
    expect(out).not.toMatch(/не тронуто: 0/i);
    expect(out).toMatch(/не тронуто.*не по чему/i);
  });

  it('записи, до которых проход не дошёл, — отдельная цифра', () => {
    // Это не то же, что «не тронуто»: здесь ответ написан, но диалога в
    // проходе не нашлось (кончился лимит, остановка по ошибке).
    expect(formatOutboxResult(result({ notFound: 2 }))).toMatch(/не дошёл.*2/i);
  });

  it('пропуски объясняются причиной, а не просто считаются', () => {
    const out = formatOutboxResult(
      result({
        skipped: 1,
        entries: [
          {
            tgUserId: '9',
            username: 'd',
            directive: 'send',
            result: 'skipped',
            note: 'ты ответил руками',
          },
        ],
      }),
    );
    expect(out).toContain('ты ответил руками');
  });

  it('без стампа в имени файла честно сообщает, что свежесть не проверена', () => {
    const out = formatOutboxResult(result({ staleCheck: false, file: 'вторник.md' }));
    expect(out).toContain('свежест');
  });

  it('ошибка отправки видна и объясняет остановку', () => {
    const out = formatOutboxResult(
      result({
        dryRun: false,
        stoppedBecause: 'ошибка отправки: FLOOD_WAIT_420',
        entries: [
          {
            tgUserId: '9',
            username: 'd',
            directive: 'send',
            result: 'failed',
            note: 'FLOOD_WAIT_420',
          },
        ],
      }),
    );
    expect(out).toContain('FLOOD_WAIT_420');
    expect(out).toContain('Остановка');
  });
});
```

- [ ] **Step 2: Прогнать тест и убедиться, что он падает**

Run: `yarn test src/modules/outreach/outbox.format.spec.ts`
Expected: FAIL — модуль не найден.

- [ ] **Step 3: Реализация**

`src/modules/outreach/outbox.format.ts`:

```ts
import { OutboxDirective } from '@modules/outreach/outbox.parse';

/**
 * Итог прогона отправки. Печатаем текстом: это читает человек в терминале
 * сразу после команды, а не другая программа.
 */

export type OutboxEntryResult =
  | 'preview'
  | 'sent'
  | 'closed'
  | 'asked'
  | 'skipped'
  | 'failed';

export interface OutboxSendEntry {
  tgUserId: string;
  username: string | null;
  directive: OutboxDirective;
  result: OutboxEntryResult;
  /** Причина пропуска или текст ошибки. */
  note?: string;
}

export interface OutboxSendResult {
  dryRun: boolean;
  file: string;
  sent: number;
  closed: number;
  asked: number;
  skipped: number;
  /** Диалоги из выгрузки, которых в outbox нет вовсе. */
  /**
   * Диалоги из выгрузки, для которых в outbox нет записи вовсе.
   * null — самой выгрузки на диске уже нет, сверять не по чему.
   */
  untouched: number | null;
  /** Записи outbox, до которых проход по диалогам не дошёл. */
  notFound: number;
  stoppedBecause: string;
  /** Удалось ли проверить, что человек не написал после выгрузки. */
  staleCheck: boolean;
  entries: OutboxSendEntry[];
}

const LABEL: Record<OutboxEntryResult, string> = {
  preview: 'отправлю',
  sent: 'отправлено',
  closed: 'закрыто без ответа',
  asked: 'оставлено тебе',
  skipped: 'пропущено',
  failed: 'ОШИБКА',
};

export function formatOutboxResult(result: OutboxSendResult): string {
  const lines: string[] = [
    '',
    result.dryRun ? 'ПРЕДПРОСМОТР (ничего не отправлено)' : 'Отправка выполнена',
    `Файл: ${result.file}`,
    '',
  ];

  result.entries.forEach((e, i) => {
    const nick = e.username ? `@${e.username}` : `id${e.tgUserId}`;
    const note = e.note ? `  ·  ${e.note}` : '';
    lines.push(
      `${String(i + 1).padStart(2, ' ')}. ${nick}  ·  ${e.directive}  ·  ${LABEL[e.result]}${note}`,
    );
  });

  lines.push('', '—'.repeat(60));
  lines.push(`${result.dryRun ? 'Ушло бы' : 'Отправлено'}: ${result.sent}`);
  lines.push(`Закрыто без ответа: ${result.closed}`);
  lines.push(`Оставлено тебе (ASK): ${result.asked}`);
  lines.push(`Пропущено (диалог изменился): ${result.skipped}`);
  // Молчаливая потеря лида — ровно то, от чего мы уходим, поэтому цифра
  // печатается всегда, даже нулевая.
  lines.push(
    `Было в выгрузке, но не тронуто: ${
      result.untouched === null
        ? 'не по чему сверить — выгрузки нет на диске'
        : result.untouched
    }`,
  );
  lines.push(`Записи, до которых проход не дошёл: ${result.notFound}`);
  lines.push(`Остановка: ${result.stoppedBecause}`);

  if (!result.staleCheck) {
    lines.push('');
    lines.push(
      '⚠ В имени файла нет стампа выгрузки — не проверял, не написал ли человек',
    );
    lines.push('  ещё раз после неё. Проверка свежести пропущена.');
  }

  if (result.dryRun) {
    lines.push('');
    lines.push(`Если всё верно — отправить: yarn outbox:send ${result.file}`);
  }

  lines.push('');
  return lines.join('\n');
}
```

- [ ] **Step 4: Прогнать тесты**

Run: `yarn test src/modules/outreach/outbox.format.spec.ts`
Expected: PASS, 9 тестов.

- [ ] **Step 5: Коммит**

```bash
git add src/modules/outreach/outbox.format.ts src/modules/outreach/outbox.format.spec.ts
git commit -m "feat: итог отправки — пропуски с причиной и счётчик нетронутого"
```

---

### Task 6: Кандидаты диалогов в базе

**Files:**
- Modify: `src/modules/lead/lead.service.ts:530` (добавить метод рядом с `getAutoReplyCandidates`, сам метод не менять)

**Interfaces:**
- Consumes: ничего.
- Produces: `DialogCandidate { tgUserId: string; contactedAt: Date | null; sampleText: string | null }`, `LeadService.getDialogCandidates(): Promise<Map<string, DialogCandidate>>`.

- [ ] **Step 1: Реализация**

Добавить в `src/modules/lead/lead.service.ts` сразу после `getAutoReplyCandidates`:

```ts
/**
 * Кандидаты для выгрузки неотвеченного: все, кому мы писали и кого руками
 * не закрыли. `sample_text` нужен, чтобы в выгрузке было видно, кто человек
 * и что преподаёт, — без этого ответ пишется вслепую.
 *
 * Отдельный метод, а не расширение `getAutoReplyCandidates()`: у того курсор
 * стоит на `contacted_at`, и если пустить его по тем же кандидатам со
 * сдвинутым курсором, короткий позитив во ВТОРОМ ходе диалога («супер,
 * спасибо!») получит `AUTO_POSITIVE` повторно — почти дословный дубль того,
 * что мы уже сказали. Шаблонный автоответ остаётся одноходовым.
 */
public async getDialogCandidates(): Promise<Map<string, DialogCandidate>> {
  const rows: Array<{
    tg_user_id: string;
    contacted_at: Date | null;
    sample_text: string | null;
  }> = await this.repo.query(
    `SELECT tg_user_id, contacted_at, sample_text FROM tg_lead
     WHERE contacted_at IS NOT NULL
       AND status NOT IN ('skip', 'rejected')`,
  );

  return new Map(
    rows.map((r) => [
      String(r.tg_user_id),
      {
        tgUserId: String(r.tg_user_id),
        contactedAt: r.contacted_at,
        sampleText: r.sample_text,
      },
    ]),
  );
}
```

И интерфейс рядом с остальными экспортами файла (вверху, после импортов):

```ts
export interface DialogCandidate {
  tgUserId: string;
  contactedAt: Date | null;
  sampleText: string | null;
}
```

`registered` в выборке остаётся намеренно: человек дошёл до регистрации и продолжает писать — это самый ценный диалог, терять его нельзя.

- [ ] **Step 2: Проверить, что ничего не сломалось**

Run: `yarn test && yarn lint:ci`
Expected: PASS. Существующие тесты `getAutoReplyCandidates` не трогались.

- [ ] **Step 3: Коммит**

```bash
git add src/modules/lead/lead.service.ts
git commit -m "feat: getDialogCandidates — кандидаты для выгрузки, старый запрос не тронут"
```

---

### Task 7: Сбор неотвеченного из Telegram

**Files:**
- Modify: `src/modules/dialogs/dialogs.service.ts`

**Interfaces:**
- Consumes: `sliceUnanswered`, `HistoryMessage` (Task 1); `InboxDump`, `InboxDialog`, `InboxMessage` (Task 4); `LeadService.getDialogCandidates`, `DialogCandidate` (Task 6); существующие `buildHook` (`@modules/sender/outreach-message`), `autoReplyDecision` (`@modules/outreach/reply-draft`).
- Produces: `DialogsService.collectUnanswered(limit: number): Promise<InboxDump>`.

- [ ] **Step 1: Реализация**

Импорты в `src/modules/dialogs/dialogs.service.ts` дополнить:

```ts
import { sliceUnanswered } from '@modules/dialogs/unanswered';
import { InboxDialog, InboxDump, InboxMessage } from '@modules/outreach/inbox.format';
import { buildHook } from '@modules/sender/outreach-message';
```

Метод класса:

```ts
/**
 * Выгрузка всего, что осталось без нашего ответа.
 *
 * Дорогая часть — чтение истории, оно же главный источник FloodWait.
 * Поэтому дешёвый пред-фильтр: если последнее сообщение диалога наше,
 * отвечать нечего и историю читать незачем. Это отсекает почти всех.
 */
public async collectUnanswered(limit: number): Promise<InboxDump> {
  const client = this.telegram.getClient();
  const candidates = await this.leads.getDialogCandidates();

  const dump: InboxDump = {
    createdAt: formatStamp(new Date()),
    dialogsSeen: 0,
    dialogs: [],
    trivial: [],
    stoppedBecause: 'кандидаты закончились',
  };

  for await (const dialog of client.iterDialogs({ limit: this.config.limit })) {
    if (dump.dialogs.length + dump.trivial.length >= limit) {
      dump.stoppedBecause = `упёрлись в лимит выгрузки (${limit})`;
      break;
    }
    if (!dialog.isUser) continue;
    const entity = dialog.entity;
    if (!(entity instanceof Api.User)) continue;

    const candidate = candidates.get(entity.id.toString());
    if (!candidate) continue;
    dump.dialogsSeen += 1;

    // Пред-фильтр: последнее сообщение наше или пустое — читать историю не за чем.
    const last = dialog.message;
    if (!last || last.out !== false) continue;
    if ((last.message ?? '').trim().length === 0) continue;

    let messages;
    try {
      messages = await client.getMessages(entity, { limit: this.config.deepLimit });
      await sleep(this.config.deepDelayMs);
    } catch (err) {
      // Историю не прочитали — в выгрузку не кладём: писать ответ вслепую
      // хуже, чем не ответить сейчас и увидеть человека в следующий раз.
      this.logger.warn(
        `Выгрузка: id${candidate.tgUserId} — история недоступна: ${describeError(err)}`,
      );
      continue;
    }

    const contactedAtSec = candidate.contactedAt
      ? Math.floor(candidate.contactedAt.getTime() / 1000)
      : 0;
    const slice = sliceUnanswered(
      messages.map(
        (m: Api.Message): HistoryMessage => ({
          out: m.out === true,
          date: m.date,
          message: m.message ?? '',
        }),
      ),
      contactedAtSec,
    );

    if (slice.incoming.length === 0) continue;

    const newest = slice.incoming[slice.incoming.length - 1];
    const decision = autoReplyDecision(newest.message);

    const entry: InboxDialog = {
      tgUserId: candidate.tgUserId,
      username: entity.username ?? null,
      hook: buildHook(candidate.sampleText),
      about: candidate.sampleText,
      heuristic: {
        kind: decision.kind,
        action: decision.action,
        reason: decision.reason,
      },
      history: slice.history.map(
        (m): InboxMessage => ({
          out: m.out,
          at: formatStamp(new Date(m.date * 1000)),
          text: m.message,
          fresh: !m.out && m.date > slice.cursorSec,
        }),
      ),
    };

    // Эвристика уверена, что ответа не требует, — в отдельный блок, чтобы
    // не тратить внимание на пятьдесят «ок».
    if (decision.action === 'clear') dump.trivial.push(entry);
    else dump.dialogs.push(entry);
  }

  this.logger.log(
    `Выгрузка: нужен ответ ${dump.dialogs.length}, тривиальных ${dump.trivial.length}`,
  );
  return dump;
}
```

И функция рядом с `describeError` в конце файла:

```ts
function formatStamp(at: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())} ${p(at.getHours())}:${p(at.getMinutes())}`;
}
```

Импорт `HistoryMessage` добавить в тот же импорт из `@modules/dialogs/unanswered`.

- [ ] **Step 2: Проверить сборку и существующие тесты**

Run: `yarn test && yarn lint:ci && yarn build`
Expected: PASS. `noUnusedLocals: true` поймает лишние импорты.

Юнит-тестов у метода нет намеренно, как и у Task 8: он почти целиком — обход
`iterDialogs` и вызовы GramJS, мок которых проверял бы мок. Логика, где можно
ошибиться, вынесена в `sliceUnanswered` (Task 1) и покрыта там. Поведение
метода проверяется живьём в финальном чеклисте.

- [ ] **Step 3: Коммит**

```bash
git add src/modules/dialogs/dialogs.service.ts
git commit -m "feat: сбор неотвеченного по диалогам с пред-фильтром по последнему сообщению"
```

---

### Task 8: Отправка по outbox

**Files:**
- Modify: `src/modules/dialogs/dialogs.service.ts`

**Interfaces:**
- Consumes: `OutboxEntry`, `OutboxDirective` (Task 2); `OutboxSendEntry`, `OutboxSendResult` (Task 5); `sliceUnanswered` (Task 1); `LeadService.getDialogCandidates` (Task 6); существующие `sleepJitter` (`@common/utils/sleep`), `LeadService.markAnswered`.
- Produces: `DialogsService.sendPreparedReplies(entries: OutboxEntry[], options: { dryRun: boolean; limit: number; file: string; dumpedAtSec: number | null; untouched: number | null }): Promise<OutboxSendResult>`.

- [ ] **Step 1: Реализация**

Импорты дополнить:

```ts
import { sleep, sleepJitter } from '@common/utils/sleep';
import { OutboxEntry } from '@modules/outreach/outbox.parse';
import { OutboxSendEntry, OutboxSendResult } from '@modules/outreach/outbox.format';
```

Метод класса:

```ts
/**
 * Отправка ответов, подготовленных в outbox.
 *
 * Перед КАЖДОЙ отправкой история диалога перечитывается — в том числе в
 * предпросмотре. Лишние запросы того стоят: предпросмотр, который проверяет
 * не то же, что боевой прогон, показывает не то, что произойдёт.
 *
 * Отсюда бесплатная идемпотентность: повторный запуск того же файла увидит
 * наше исходящее после их входящего и пропустит всё. Таблица отправленных
 * ответов не нужна.
 */
public async sendPreparedReplies(
  entries: OutboxEntry[],
  options: {
    dryRun: boolean;
    limit: number;
    file: string;
    dumpedAtSec: number | null;
    /** Посчитано вызывающим по самой выгрузке; null — её нет на диске. */
    untouched: number | null;
  },
): Promise<OutboxSendResult> {
  const client = this.telegram.getClient();
  const candidates = await this.leads.getDialogCandidates();
  const cap = Math.min(options.limit, this.config.autoReplyMax);

  const result: OutboxSendResult = {
    dryRun: options.dryRun,
    file: options.file,
    sent: 0,
    closed: 0,
    asked: 0,
    skipped: 0,
    untouched: options.untouched,
    notFound: 0,
    stoppedBecause: 'записи закончились',
    staleCheck: options.dumpedAtSec !== null,
    entries: [],
  };

  const pending = new Map(entries.map((e) => [e.tgUserId, e]));

  // ASK ничего не трогает в Telegram — разбираем сразу, не тратя проход.
  for (const entry of entries) {
    if (entry.directive !== 'ask') continue;
    pending.delete(entry.tgUserId);
    result.asked += 1;
    result.entries.push(sendEntry(entry, 'asked'));
  }

  // Ранний выход ДО входа в цикл: `for await` дёрнул бы `iterDialogs` и
  // сходил в Telegram за первой страницей диалогов ещё до первой проверки в
  // теле. Файл из одних ASK не должен трогать сеть вовсе.
  if (pending.size === 0) {
    this.logger.log(`Outbox ${options.file}: только ASK, Telegram не трогали`);
    return result;
  }

  for await (const dialog of client.iterDialogs({ limit: this.config.limit })) {
    if (pending.size === 0) break;
    if (result.sent >= cap) {
      result.stoppedBecause = `упёрлись в лимит отправок (${cap})`;
      break;
    }
    if (!dialog.isUser) continue;
    const dialogEntity = dialog.entity;
    if (!(dialogEntity instanceof Api.User)) continue;

    const id = dialogEntity.id.toString();
    const entry = pending.get(id);
    if (!entry) continue;
    pending.delete(id);

    if (entry.directive === 'close') {
      result.closed += 1;
      if (!options.dryRun) {
        try {
          await this.leads.markAnswered(id);
        } catch (err) {
          this.logger.warn(`CLOSE id${id}: markAnswered упал: ${describeError(err)}`);
        }
      }
      result.entries.push(sendEntry(entry, options.dryRun ? 'preview' : 'closed'));
      continue;
    }

    // SEND: перечитываем историю и решаем, актуален ли ещё черновик.
    let messages;
    try {
      messages = await client.getMessages(dialogEntity, { limit: this.config.deepLimit });
      await sleep(this.config.deepDelayMs);
    } catch (err) {
      result.skipped += 1;
      result.entries.push(sendEntry(entry, 'skipped', `история недоступна: ${describeError(err)}`));
      continue;
    }

    const candidate = candidates.get(id);
    const contactedAtSec = candidate?.contactedAt
      ? Math.floor(candidate.contactedAt.getTime() / 1000)
      : 0;
    const slice = sliceUnanswered(
      messages.map(
        (m: Api.Message): HistoryMessage => ({
          out: m.out === true,
          date: m.date,
          message: m.message ?? '',
        }),
      ),
      contactedAtSec,
    );

    // Неотвеченного нет — значит после выгрузки ты ответил руками.
    if (slice.incoming.length === 0) {
      result.skipped += 1;
      result.entries.push(sendEntry(entry, 'skipped', 'ты ответил руками'));
      continue;
    }

    // Человек написал ещё раз после выгрузки: черновик отвечает на устаревшую
    // реплику, а это выглядит как невнимательность. Пусть попадёт в следующий
    // inbox уже с новым контекстом.
    const newestSec = slice.incoming[slice.incoming.length - 1].date;
    if (options.dumpedAtSec !== null && newestSec > options.dumpedAtSec) {
      result.skipped += 1;
      result.entries.push(sendEntry(entry, 'skipped', 'написал ещё раз после выгрузки'));
      continue;
    }

    if (options.dryRun) {
      result.sent += 1;
      result.entries.push(sendEntry(entry, 'preview'));
      continue;
    }

    try {
      await client.sendMessage(dialogEntity, { message: entry.body });
    } catch (err) {
      const message = describeError(err);
      result.entries.push(sendEntry(entry, 'failed', message));
      result.stoppedBecause = `ошибка отправки: ${message}`;
      break;
    }

    // Сообщение УШЛО. markAnswered отдельно: его сбой не имеет права выдать
    // отправленное за провал. Даже если пометка не пройдёт, следующая
    // выгрузка увидит наше исходящее и не предложит ответить второй раз.
    result.sent += 1;
    result.entries.push(sendEntry(entry, 'sent'));
    try {
      await this.leads.markAnswered(id);
    } catch (err) {
      this.logger.error(
        `Ответ ушёл id${id}, но markAnswered упал: ${describeError(err)}`,
      );
    }

    // Джиттер, а не ровная пауза: ровный ритм запросов — сам по себе
    // признак автоматизации.
    await sleepJitter(this.config.autoReplyDelaySec * 1000);
  }

  // Записи, до которых проход не дошёл: диалога нет в списке, кончился лимит,
  // остановились по ошибке. Это НЕ то же, что `untouched` (там — кому ответ
  // не написали вовсе); оба числа печатаются, чтобы лид не терялся молча.
  result.notFound = pending.size;

  this.logger.log(
    `Outbox ${options.file} (${options.dryRun ? 'preview' : 'боевой'}): ` +
      `отправлено ${result.sent}, закрыто ${result.closed}, тебе ${result.asked}, ` +
      `пропущено ${result.skipped}, не дошёл ${result.notFound}`,
  );
  return result;
}
```

И хелпер рядом с `formatStamp`:

```ts
function sendEntry(
  entry: OutboxEntry,
  outcome: OutboxSendEntry['result'],
  note?: string,
): OutboxSendEntry {
  return {
    tgUserId: entry.tgUserId,
    username: entry.username,
    directive: entry.directive,
    result: outcome,
    note,
  };
}
```

- [ ] **Step 2: Проверить сборку и тесты**

Run: `yarn test && yarn lint:ci && yarn build`
Expected: PASS.

Юнит-тестов у самого метода нет намеренно, и это осознанный компромисс, а не
пропуск: он почти целиком — обход `iterDialogs` и вызовы GramJS, мок которых
проверял бы мок. Вся логика, где можно ошибиться, вынесена в
`sliceUnanswered` (Task 1) и покрыта. Поведение метода проверяется живьём в
финальном чеклисте: отправка на одном диалоге, затем повторный прогон того же
файла — всё должно быть пропущено с причиной «ты ответил руками».

- [ ] **Step 3: Коммит**

```bash
git add src/modules/dialogs/dialogs.service.ts
git commit -m "feat: отправка по outbox — перечитывает историю и пропускает устаревшее"
```

---

### Task 9: Ручки, скрипты, склейка

**Files:**
- Modify: `src/modules/outreach/outreach.service.ts`
- Modify: `src/modules/outreach/outreach.controller.ts`
- Create: `scripts/outbox.sh`
- Modify: `package.json`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `DialogsService.collectUnanswered` (Task 7), `DialogsService.sendPreparedReplies` (Task 8), `formatInbox`/`formatInboxSummary` (Task 4), `formatOutboxResult` (Task 5), `parseOutbox`/`OutboxParseError` (Task 2), `reply-files` (Task 3).
- Produces: `POST /outreach/inbox?limit=`, `POST /outreach/outbox/send?file=&send=&limit=`.

- [ ] **Step 1: `OutreachService`**

Импорты дополнить:

```ts
import { formatInbox, formatInboxSummary } from '@modules/outreach/inbox.format';
import { formatOutboxResult } from '@modules/outreach/outbox.format';
import {
  OutboxEntry,
  OutboxParseError,
  extractRecordIds,
  parseOutbox,
} from '@modules/outreach/outbox.parse';
import {
  inboxFileName,
  newestOutboxName,
  parseDumpTimestamp,
  readInbox,
  readOutbox,
  writeInbox,
  UnsafeFileNameError,
} from '@modules/outreach/reply-files';
```

Методы:

```ts
/** Выгрузка неотвеченного в файл: `yarn inbox`. */
public async inbox(limit: number): Promise<string> {
  const dump = await this.dialogs.collectUnanswered(limit);
  const path = writeInbox(inboxFileName(new Date()), formatInbox(dump));
  return formatInboxSummary(dump, path);
}

/**
 * Отправка ответов из outbox: `yarn outbox` (предпросмотр) и
 * `yarn outbox:send`. Без имени файла берём самый свежий — так у команды
 * без аргументов есть осмысленное поведение.
 */
public async outboxSend(
  file: string | undefined,
  send: boolean,
  limit: number,
): Promise<string> {
  const name = file ?? newestOutboxName();
  if (!name) {
    return '\nВ outbox/ нет ни одного .md — сначала попроси ассистента написать ответы по файлу из inbox/.\n';
  }

  let raw: string;
  try {
    raw = readOutbox(name);
  } catch (err) {
    if (err instanceof UnsafeFileNameError) return `\n${err.message}\n`;
    throw err;
  }

  let entries;
  try {
    entries = parseOutbox(raw);
  } catch (err) {
    // Разбор упал — значит не отправлено ничего. Это и есть задуманное
    // поведение, поэтому текст ошибки печатаем как обычный ответ.
    if (err instanceof OutboxParseError) {
      return `\nФайл outbox/${name} не разобран, ничего не отправлено:\n${err.message}\n`;
    }
    throw err;
  }

  const result = await this.dialogs.sendPreparedReplies(entries, {
    dryRun: !send,
    limit,
    file: name,
    dumpedAtSec: parseDumpTimestamp(name),
    untouched: this.countUntouched(name, entries),
  });
  return formatOutboxResult(result);
}

/**
 * Сколько диалогов из выгрузки остались без записи в outbox.
 *
 * Считается по самому inbox-файлу, а не по результату прохода: иначе
 * человек, для которого ответ просто не написали, нигде не всплывёт —
 * ровно та молчаливая потеря лида, от которой мы уходим. Формат заголовка
 * у inbox и outbox один, поэтому хватает `extractRecordIds`.
 *
 * null — выгрузки на диске уже нет: сверять не по чему, и итог скажет это
 * прямым текстом вместо честного на вид нуля.
 */
private countUntouched(name: string, entries: OutboxEntry[]): number | null {
  const dump = readInbox(name);
  if (dump === null) return null;
  const answered = new Set(entries.map((e) => e.tgUserId));
  return extractRecordIds(dump).filter((id) => !answered.has(id)).length;
}
```

- [ ] **Step 2: Ручки в `OutreachController`**

DTO рядом с существующими:

```ts
class InboxQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  public readonly limit?: number;
}

class OutboxQueryDto {
  /** Basename внутри outbox/. Без него берётся самый свежий файл. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  public readonly file?: string;

  /** Реально слать. По умолчанию false — сначала предпросмотр. */
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string'
      ? ['true', '1', 'yes'].includes(value.toLowerCase())
      : value,
  )
  @IsBoolean()
  public readonly send?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  public readonly limit?: number;
}
```

Методы:

```ts
/**
 * Выгрузка неотвеченного в inbox/: `yarn inbox`.
 * Дальше файл читает ассистент и пишет ответы в outbox/.
 */
@Post('inbox')
@Header('Content-Type', 'text/plain; charset=utf-8')
public inbox(@Query() query: InboxQueryDto): Promise<string> {
  return this.outreach.inbox(query.limit ?? 200);
}

/**
 * Отправка ответов из outbox/. Без `send=true` — только предпросмотр
 * (`yarn outbox`). С `send=true` — реально отправляет (`yarn outbox:send`).
 */
@Post('outbox/send')
@Header('Content-Type', 'text/plain; charset=utf-8')
public outboxSend(@Query() query: OutboxQueryDto): Promise<string> {
  return this.outreach.outboxSend(query.file, query.send === true, query.limit ?? 200);
}
```

- [ ] **Step 3: `scripts/outbox.sh`**

```sh
#!/bin/sh
# Отправка ответов, подготовленных в outbox/.
#
#   yarn outbox                      — предпросмотр самого свежего файла
#   yarn outbox 2026-09-03-1430.md   — предпросмотр конкретного
#   yarn outbox:send                 — отправить самый свежий
#
# Предпросмотр тоже ходит в Telegram за историей каждого диалога: иначе он
# показывал бы не то, что сделает боевой прогон.

SEND=""
FILE=""

for arg in "$@"; do
  case "$arg" in
    --send) SEND="&send=true" ;;
    *) FILE="&file=$arg" ;;
  esac
done

HOST="${LEADGEN_HOST:-http://127.0.0.1:3010}"

curl -sS --max-time 900 -XPOST "$HOST/outreach/outbox/send?limit=200$SEND$FILE"
```

- [ ] **Step 4: `package.json` и `.gitignore`**

В `scripts` после `autoreply:send`:

```json
"inbox": "curl -sS --max-time 900 -XPOST 'http://127.0.0.1:3010/outreach/inbox?limit=200'",
"outbox": "sh scripts/outbox.sh",
"outbox:send": "sh scripts/outbox.sh --send",
```

В `.gitignore` после блока про `export/`:

```
# Обмен с ассистентом: входящие ответы живых людей и наши реплики им.
# Персональные данные третьих лиц — в git им не место, как и выгрузкам.
inbox/
outbox/
```

- [ ] **Step 5: Проверить сборку, тесты и реальный bootstrap**

```bash
yarn lint:ci && yarn test && yarn build && node dist/main.js
```

Expected: приложение поднимается, в логе видны маршруты `POST /outreach/inbox` и `POST /outreach/outbox/send`. Убить через Ctrl+C. Этот шаг обязателен: юнит-тесты собирают сервисы мимо контейнера и DI-цикл не поймают.

- [ ] **Step 6: Проверить, что ничего не уходит вслепую**

```bash
yarn outbox
```

Expected: при пустом `outbox/` — «В outbox/ нет ни одного .md». Затем создать `outbox/broken.md` с содержимым `## id1\nSEDN\nтекст` и прогнать `yarn outbox broken.md` — ожидается сообщение «не разобран, ничего не отправлено». Файл потом удалить.

Имя файла обязано быть латиницей: `assertSafeName` пропускает только
`[A-Za-z0-9._-]`, поэтому кириллическое имя отсекается guard'ом на два слоя
раньше и до разбора не доходит — такой пример проверял бы не то.

- [ ] **Step 7: Коммит**

```bash
git add src/modules/outreach/outreach.service.ts src/modules/outreach/outreach.controller.ts scripts/outbox.sh package.json .gitignore
git commit -m "feat: ручки inbox/outbox, скрипты и гитигнор обмена с ассистентом"
```

---

### Task 10: Правила ответа и документация

Без этого таска фича работает, но качество ответов держится на аккуратности одной сессии. Правила нужны, чтобы оно держалось на репозитории: их читает и ассистент, и человек, и они видны в diff'е, когда факты о продукте разъезжаются с реальностью.

**Files:**
- Create: `docs/reply-guidelines.md`
- Modify: `CLAUDE.md`
- Modify: `README.md`

- [ ] **Step 1: `docs/reply-guidelines.md`**

Содержимое ниже — готовое, кроме одного места: список фич наизусть в файле
намеренно НЕ лежит. Вместо него — указание, что прочитать в монорепозитории.
Список устареет молча, код — нет, а обещание фичи, которой нет, стоит лида.

`docs/reply-guidelines.md`:

```markdown
# Правила ответа на входящие

Ответы пишет ассистент, отправляет человек, репутация — автора. Отсюда всё
остальное: лучше не ответить сейчас, чем ответить неверно.

## Тон

Образец того, как автор пишет сам, один — `outreach-template-universal.md`:

- тепло и разговорно, короткими абзацами;
- «вы» к незнакомым; «ты» — только если человек сам перешёл;
- смайлик «)» вместо восклицательных знаков;
- 2-5 строк. Простыня в ответ на «а сколько стоит?» читается как бот.

Не дописывать никогда — это уже пробовали, вышло плохо:

- «за 10 минут пройдусь с тобой по интерфейсу в созвоне» — корпоративно;
- второй CTA («ответь „покажи"») — давит;
- канцелярит вроде «Ссылка — …, вход по почте».

## Что можно утверждать

Только то, что подтверждено кодом или лендингом **на момент ответа**. Перед
первой пачкой в новой сессии прочитать:

- `teach-track-frontend/src/pages/Landing.tsx` — что обещано публично;
- `teach-track-frontend/src/pages/Roadmap.tsx` — граница «есть» / «будет».
  Именно на ней ответ превращается в обещание, которого никто не давал;
- CHANGELOG в `teach-track-backend` — что реально уехало в прод.

Списка фич здесь нет намеренно: он устареет молча, а код — нет.

## Чего нельзя никогда

- Обещать фичу, которой нет, — даже словами «скоро будет».
- Называть срок. Любой.
- Подтверждать интеграцию, не найдя её в коде.
- Говорить о цене иначе, чем сказано на лендинге.
- Извиняться за проблему, которой не было: это выглядит как признание бага,
  которого нет.

## Когда обязан уйти в ASK

- Спрашивают про то, чего в продукте нет.
- Просят срок.
- Жалуются на баг, который надо воспроизвести.
- Предлагают сотрудничество, партнёрство или деньги.
- Тон разговора конфликтный.
- Ответ требует решения, которое принимает автор, а не ассистент.

## Правило сомнения

`ASK` стоит одну прочитанную строку. Неверный `SEND` стоит лида, который
уходит и рассказывает другим. Цены несопоставимы: при любом сомнении — `ASK`.

## Как писать ASK

Черновик плюс одна строка, что именно смущает. Не «нужен твой ответ», а так:

    ASK
    Спрашивает про интеграцию с Zoom. В роадмапе её нет — врать нельзя, но
    голое «нет» теряет тёплый лид. Черновик: «Zoom пока не подключен,
    занятия ведёте где удобно, а расписание и оплаты остаются здесь».
    Отправляем?
```

- [ ] **Step 2: `CLAUDE.md`**

В раздел «Архитектура» добавить строку про обмен файлами:

```
- `inbox/`, `outbox/` — обмен с ассистентом: выгрузка неотвеченного и ответы
  к отправке. Оба в `.gitignore`, там переписка живых людей.
```

В «Важные решения (не откатывать молча)» добавить:

```
- **Ответы пишет ассистент вне процесса, а не Claude API внутри.** Обмен
  через `inbox/`/`outbox/`: ключей, бюджета и фолбэка нет, а ответы лучше —
  ассистент читает монорепозиторий и видит, что реально в проде, а не слепок
  продукта в промпте. Дизайн: `docs/superpowers/specs/2026-09-03-ai-reply-loop-design.md`.
- **Курсор неотвеченного — последнее НАШЕ сообщение, а не `contacted_at`.**
  Иначе диалог, где мы ответили хоть раз, невидим навсегда, и тёплый лид с
  вторым вопросом теряется. Шаблонный `yarn autoreply` намеренно остался
  одноходовым: со сдвинутым курсором он повторял бы `AUTO_POSITIVE`.
- **Битый outbox роняет разбор целиком.** Половина отправленной пачки хуже,
  чем ни одной: непонятно, где встали.
```

- [ ] **Step 3: `README.md`**

Добавить раздел с потоком после описания существующих команд:

```markdown
### Ответы на входящие

    yarn inbox          # выгрузит неотвеченное в inbox/<стамп>.md
    # попроси ассистента прочитать файл и написать ответы
    # в outbox/<тот же стамп>.md — правила в docs/reply-guidelines.md
    yarn outbox         # предпросмотр: что и кому уйдёт
    yarn outbox:send    # отправка

Директивы в outbox: `SEND` + текст, `CLOSE` (пометить отвеченным, ничего не
слать), `ASK` + вопрос (оставить себе). Перед каждой отправкой история
диалога перечитывается: если человек написал ещё раз или ты ответил руками —
запись пропускается.
```

- [ ] **Step 4: Проверить**

Run: `yarn lint:ci && yarn test`
Expected: PASS (документация код не задевает, но прогон подтверждает, что дерево чистое).

- [ ] **Step 5: Коммит**

```bash
git add docs/reply-guidelines.md CLAUDE.md README.md
git commit -m "chore: правила ответа на входящие и описание потока inbox/outbox"
```

---

## Финальная проверка

- [ ] `yarn lint:ci && yarn test && yarn build` — зелено.
- [ ] `node dist/main.js` — поднимается, маршруты `POST /outreach/inbox` и `POST /outreach/outbox/send` в логе.
- [ ] `yarn inbox` на живой базе — файл появился, заголовки записей вида `## id123 @nick`, переписка читается, тривиальное отделено.
- [ ] Ассистент написал `outbox/<тот же стамп>.md`, `yarn outbox` показал разбор без ошибок.
- [ ] `yarn outbox` дважды подряд даёт одинаковый результат (предпросмотр ничего не меняет).
- [ ] `yarn outbox:send` на **одном** диалоге (`limit=1`), проверить сообщение в Telegram глазами.
- [ ] Повторный `yarn outbox:send` того же файла — всё пропущено с причиной «ты ответил руками». Идемпотентность работает.
- [ ] `git status` — `inbox/` и `outbox/` не видны.
