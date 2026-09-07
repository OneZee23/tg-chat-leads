import {
  InboxDialog,
  InboxDump,
  formatInbox,
  formatInboxSummary,
} from '@modules/outreach/inbox.format';
import { extractRecordIds } from '@modules/outreach/outbox.parse';

function dialog(over: Partial<InboxDialog> = {}): InboxDialog {
  return {
    tgUserId: '123456789',
    username: 'teacher',
    hook: 'Здравствуйте! Видел, что вы набираете учеников по английскому.',
    about: 'Набираю учеников по английскому, взрослые и подростки',
    heuristic: {
      kind: 'question',
      action: 'manual',
      reason: 'вопрос — нужен твой ответ',
    },
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
    candidatesTotal: 412,
    candidatesUnseen: 0,
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
            heuristic: {
              kind: 'neutral',
              action: 'clear',
              reason: 'короткое «ок/спасибо»',
            },
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

describe('контракт с парсером outbox', () => {
  // Единственное место, где сходятся два файла: рендер выгрузки пишет
  // заголовки, регулярка парсера их читает. Разъедутся — ассистент скопирует
  // заголовки в outbox, а разбор их не увидит: тихо не уйдёт ни один ответ.
  it('id из отрендеренной выгрузки возвращаются парсером', () => {
    const rendered = formatInbox(
      dump({
        dialogs: [
          dialog(),
          // Без ника — у части людей его нет вовсе, а ключ всё равно id.
          dialog({ tgUserId: '987654321', username: null }),
        ],
        trivial: [dialog({ tgUserId: '555555555', username: 'quick' })],
      }),
    );

    expect(extractRecordIds(rendered)).toEqual(['123456789', '987654321', '555555555']);
  });
});

describe('предупреждение о неосмотренных', () => {
  it('молчит, когда осмотрены все', () => {
    const out = formatInboxSummary(dump(), 'inbox/x.md');
    expect(out).not.toContain('НЕ ОСМОТРЕНО');
    expect(out).toContain('412 из 412');
  });

  it('кричит, когда часть кандидатов не осмотрена', () => {
    // Живой случай: 912 из 1102, и сообщение двухнедельной давности
    // человек нашёл руками. Молчание тут дороже любой другой ошибки —
    // инструменту доверяют вместо того, чтобы листать телеграм.
    const out = formatInboxSummary(
      dump({ dialogsSeen: 912, candidatesTotal: 1102, candidatesUnseen: 190 }),
      'inbox/x.md',
    );
    expect(out).toContain('НЕ ОСМОТРЕНО: 190');
    expect(out).toContain('912 из 1102');
    expect(out).toContain('DIALOGS_LIMIT');
  });
});
