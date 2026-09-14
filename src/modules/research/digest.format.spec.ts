import {
  flattenText,
  formatDate,
  formatDigest,
  formatHit,
  type ResearchHit,
  type ResearchResult,
} from '@modules/research/digest.format';

const AT = Math.floor(new Date('2026-07-31T12:00:00Z').getTime() / 1000);

function hit(over: Partial<ResearchHit> = {}): ResearchHit {
  return {
    chatRef: '@some_channel',
    chatTitle: 'Карта шансов',
    messageId: 42,
    date: AT,
    author: '@vlad',
    text: 'В Грузии можно без ВНЖ, но надо доказать 6 месяцев проживания',
    link: 'https://t.me/some_channel/42',
    matchedQueries: ['Грузия'],
    replyToText: null,
    ...over,
  };
}

function result(over: Partial<ResearchResult> = {}): ResearchResult {
  return {
    chats: ['@some_channel'],
    queries: [{ query: 'Грузия', found: 1 }],
    hits: [hit()],
    startedAt: '2026-09-09T13:00:00.000Z',
    finishedAt: '2026-09-09T13:02:00.000Z',
    sinceDays: 400,
    ...over,
  };
}

describe('flattenText', () => {
  it('схлопывает переводы строк в разделитель', () => {
    expect(flattenText('первая\n\nвторая\nтретья')).toBe('первая / вторая / третья');
  });

  it('обрезает длинный текст многоточием', () => {
    expect(flattenText('а'.repeat(50), 10)).toBe(`${'а'.repeat(10)}…`);
  });

  it('короткий текст не трогает', () => {
    expect(flattenText('коротко', 100)).toBe('коротко');
  });
});

describe('formatDate', () => {
  it('печатает дату сообщения', () => {
    expect(formatDate(AT)).toMatch(/^2026-07-3[01]$/);
  });
});

describe('formatHit', () => {
  it('дата и автор идут перед текстом', () => {
    const lines = formatHit(hit()).split('\n');
    expect(lines[0]).toContain('2026-07-3');
    expect(lines[0]).toContain('@vlad');
    expect(lines[1]).toContain('В Грузии можно без ВНЖ');
  });

  it('показывает сообщение, на которое отвечали', () => {
    const out = formatHit(hit({ replyToText: 'А нужен ли ВНЖ Грузии?' }));
    expect(out).toContain('в ответ на: А нужен ли ВНЖ Грузии?');
  });

  it('дополнительные запросы уходят в подпись, а не дублируют находку', () => {
    const out = formatHit(hit({ matchedQueries: ['Грузия', 'ВНЖ', 'Тбилиси'] }));
    expect(out).toContain('также по запросам: ВНЖ, Тбилиси');
  });

  it('без ссылки не ломается', () => {
    expect(formatHit(hit({ link: null }))).not.toContain('[→]');
  });
});

describe('formatDigest', () => {
  it('печатает шапку с окном по дате и предупреждением о доверии', () => {
    const out = formatDigest(result());
    expect(out).toContain('последние 400 дн.');
    expect(out).toContain('не источник истины');
  });

  it('сообщение печатается один раз, под своим первым запросом', () => {
    const shared = hit({ matchedQueries: ['Грузия', 'Тбилиси'] });
    const out = formatDigest(
      result({
        queries: [
          { query: 'Грузия', found: 1 },
          { query: 'Тбилиси', found: 1 },
        ],
        hits: [shared],
      }),
    );
    const occurrences = out.split('В Грузии можно без ВНЖ').length - 1;
    expect(occurrences).toBe(1);
  });

  it('ошибку запроса показывает в сводке', () => {
    const out = formatDigest(
      result({
        queries: [{ query: 'Грузия', found: 0, error: 'FloodWait 30s' }],
        hits: [],
      }),
    );
    expect(out).toContain('FloodWait 30s');
  });

  it('пустой результат говорит об этом прямо', () => {
    expect(formatDigest(result({ hits: [], queries: [] }))).toContain(
      'Ничего не нашлось',
    );
  });
});
