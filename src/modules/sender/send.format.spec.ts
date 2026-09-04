import {
  SendStatusView,
  formatSendReport,
  formatSendStatus,
} from '@modules/sender/send.format';

function status(over: Partial<SendStatusView> = {}): SendStatusView {
  return {
    running: false,
    dryRun: false,
    dailyBudget: { limit: 20, used: 5, remaining: 15, resetsAt: null },
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
          resetsAt: new Date('2026-09-04T15:00:00Z'),
        },
      }),
    );
    expect(out).toMatch(/бюджет.*исчерпан/i);
    expect(out).not.toContain('yarn send');
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

describe('formatSendReport', () => {
  const report = {
    dryRun: true,
    attempted: 3,
    sent: 3,
    failed: 0,
    skipped: 0,
    stoppedBecause: 'очередь закончилась',
    fatal: false,
    dailyBudget: { limit: 20, used: 5, remaining: 15 },
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

  it('боевой прогон не предлагает отправить ещё раз', () => {
    const out = formatSendReport({ ...report, dryRun: false, entries: [] });
    expect(out).not.toContain('yarn send:go');
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
