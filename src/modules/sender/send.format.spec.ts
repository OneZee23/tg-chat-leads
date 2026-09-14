import {
  SendStatusView,
  formatSendReport,
  formatSendStatus,
} from '@modules/sender/send.format';

function status(over: Partial<SendStatusView> = {}): SendStatusView {
  return {
    running: false,
    dryRun: false,
    dailyBudget: { limit: 20, used: 5, remaining: 15, unlimited: false, resetsAt: null },
    accounts: [{ name: 'main', title: '@me', used: 5, remaining: 15 }],
    scheduler: { active: false, window: '10:00–21:00', nextSendAt: null },
    floodSummary: '',
    floodActive: 0,
    unfinishedCount: 0,
    outreach: { contacted: 747, replied: 112 },
    awaitingReply: 0,
    queued: 300,
    ...over,
  };
}

describe('formatSendStatus', () => {
  it('показывает бюджет и остаток одной строкой', () => {
    expect(formatSendStatus(status())).toMatch(/5\s*из\s*20/);
  });

  it('следующий шаг — разобрать ответы, а не слать новым', () => {
    // Ответить тому, кто уже написал, ценнее, чем написать незнакомцу:
    // это тёплый контакт, и он ждёт.
    const out = formatSendStatus(status({ awaitingReply: 12 }));
    expect(out).toContain('yarn inbox');
    expect(out).not.toContain('yarn send');
  });

  it('очередь есть, ответов нет — предлагает предпросмотр отправки', () => {
    const out = formatSendStatus(status({ awaitingReply: 0, queued: 300 }));
    expect(out).toContain('yarn send');
  });

  it('активный лимит Telegram перебивает любой другой совет', () => {
    // Пока аккаунт зажат, любое действие только утяжеляет ограничение.
    const out = formatSendStatus(
      status({ awaitingReply: 12, floodActive: 1, floodSummary: 'sendMessage до 14:30' }),
    );
    expect(out).toContain('14:30');
    expect(out).not.toContain('yarn inbox');
    expect(out).not.toContain('yarn send');
  });

  it('застрявшие в отправке важнее новой рассылки', () => {
    const out = formatSendStatus(status({ unfinishedCount: 3, queued: 300 }));
    expect(out).toContain('yarn send:release');
    expect(out).not.toContain('yarn send\n');
  });

  it('исчерпанный бюджет говорит, когда освободится', () => {
    const out = formatSendStatus(
      status({
        dailyBudget: {
          limit: 20,
          used: 20,
          remaining: 0,
          unlimited: false,
          resetsAt: new Date('2026-09-04T15:00:00Z'),
        },
      }),
    );
    expect(out).toMatch(/бюджет.*исчерпан/i);
    expect(out).not.toContain('yarn send');
  });

  it('без потолка показывает счётчик за сутки, а не «бюджет»', () => {
    // 11.09.2026 суточный потолок убран: он останавливал отправку сам по
    // себе, хотя Telegram аккаунт не ограничивал. Строка про бюджет в этом
    // режиме — вымысел, её быть не должно.
    const out = formatSendStatus(
      status({
        dailyBudget: {
          limit: 0,
          used: 37,
          remaining: Number.MAX_SAFE_INTEGER,
          unlimited: true,
          resetsAt: null,
        },
      }),
    );
    expect(out).toContain('Отправлено за 24 часа: 37');
    expect(out).not.toMatch(/Суточный бюджет/);
  });

  it('без потолка совет не упирается в исчерпанный бюджет', () => {
    const out = formatSendStatus(
      status({
        dailyBudget: {
          limit: 0,
          used: 500,
          remaining: Number.MAX_SAFE_INTEGER,
          unlimited: true,
          resetsAt: null,
        },
      }),
    );
    expect(out).not.toMatch(/бюджет.*исчерпан/i);
    expect(out).toContain('yarn send');
  });

  it('говорит, что рассылка сейчас идёт, чтобы не запускать вторую', () => {
    expect(formatSendStatus(status({ running: true }))).toMatch(/идёт/i);
  });

  it('число ждущих подписано как оценка по базе, а не как факт', () => {
    // Статус `replied` устаревает: на тех, кому автор ответил руками, он
    // остаётся висеть. Настоящее число знает только обход диалогов, поэтому
    // экран обязан признавать, что это оценка.
    const out = formatSendStatus(status({ awaitingReply: 45 }));
    expect(out).toMatch(/по базе/i);
  });

  it('внизу всегда есть, где посмотреть остальные команды', () => {
    // Иначе шпаргалку надо помнить, а yarn help занят самим yarn.
    expect(formatSendStatus(status())).toContain('yarn commands');
  });
});

describe('formatSendStatus: несколько аккаунтов', () => {
  it('разрез по аккаунтам появляется только со второго', () => {
    const one = formatSendStatus(status());
    expect(one).not.toContain('По аккаунтам');

    const two = formatSendStatus(
      status({
        accounts: [
          { name: 'main', title: '@one', used: 12, remaining: 8 },
          { name: 'second', title: '@two', used: 3, remaining: 17 },
        ],
      }),
    );
    expect(two).toContain('По аккаунтам за 24 часа');
    expect(two).toMatch(/@two: 3, осталось 17/);
  });
});

describe('formatSendReport', () => {
  const report = {
    dryRun: true,
    attempted: 3,
    sent: 3,
    failed: 0,
    skipped: 0,
    stoppedBecause: 'очередь закончилась',
    fatal: false,
    dailyBudget: { limit: 20, used: 5, remaining: 15, unlimited: false },
    accounts: [
      { name: 'main', title: '@me', sentNow: 3, used: 5, remaining: 15, unlimited: false },
    ],
    entries: [
      { username: 'a', result: 'dry-run' as const },
      { username: 'b', result: 'dry-run' as const },
      { username: 'c', result: 'dry-run' as const },
    ],
  };

  it('предпросмотр честно говорит, что ничего не ушло, и как отправить', () => {
    const out = formatSendReport(report);
    expect(out).toContain('ПРЕДПРОСМОТР');
    expect(out).toContain('yarn send:go');
  });

  it('в предпросмотре «ушло бы» совпадает с длиной списка', () => {
    // Сервис не трогает report.sent в dry-run: «отправлено» там честно ноль.
    // Но для человека строка «Ушло бы: 0» под списком из трёх имён — ложь.
    const out = formatSendReport({ ...report, sent: 0 });
    expect(out).toMatch(/Ушло бы: 3/);
  });

  it('итог рассылки без потолка не выдумывает бюджет', () => {
    const out = formatSendReport({
      ...report,
      dryRun: false,
      dailyBudget: {
        limit: 0,
        used: 37,
        remaining: Number.MAX_SAFE_INTEGER,
        unlimited: true,
      },
    });
    expect(out).toContain('Отправлено за 24 часа: 37');
    expect(out).not.toMatch(/Суточный бюджет/);
  });

  it('боевой прогон не предлагает отправить ещё раз', () => {
    const out = formatSendReport({ ...report, dryRun: false, entries: [] });
    expect(out).not.toContain('yarn send:go');
  });

  it('с двумя аккаунтами показывает, кто кому написал', () => {
    // Ответ придёт тому, кто писал. Без этой пометки непонятно, в чьей
    // личке искать диалог.
    const out = formatSendReport({
      ...report,
      dryRun: false,
      accounts: [
        { name: 'main', title: '@one', sentNow: 2, used: 12, remaining: 8, unlimited: false },
        { name: 'second', title: '@two', sentNow: 1, used: 3, remaining: 17, unlimited: false },
      ],
      entries: [
        { username: 'a', result: 'sent' as const, account: 'main' },
        { username: 'b', result: 'sent' as const, account: 'second' },
      ],
    });
    expect(out).toMatch(/@a.*@one/);
    expect(out).toMatch(/@b.*@two/);
    expect(out).toMatch(/@two: 1 сейчас, 3 за 24 часа/);
  });

  it('с одним аккаунтом не приписывает его имя к каждой строке', () => {
    const out = formatSendReport({ ...report, dryRun: false });
    expect(out).not.toContain('@me');
  });

  it('пропуск объясняет причину, а не молчит', () => {
    const out = formatSendReport({
      ...report,
      dryRun: false,
      entries: [
        {
          username: 'a',
          result: 'skipped' as const,
          error: 'аккаунт, который вёл переписку, сейчас не подключён',
        },
      ],
    });
    expect(out).toContain('не подключён');
  });

  it('фатальная остановка выделяется, а не теряется в счётчиках', () => {
    // PEER_FLOOD означает, что аккаунт уже ограничен за рассылку незнакомцам.
    const out = formatSendReport({
      ...report,
      dryRun: false,
      fatal: true,
      stoppedBecause: 'PEER_FLOOD',
      entries: [{ username: 'a', result: 'failed', error: 'PEER_FLOOD' }],
    });
    expect(out).toMatch(/ОСТАНОВЛЕНО/);
    expect(out).toContain('PEER_FLOOD');
  });
});
