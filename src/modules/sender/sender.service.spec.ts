import { SenderService } from '@modules/sender/sender.service';

/**
 * Рассылка с двумя аккаунтами: кто кому пишет.
 *
 * Проверяем ровно то, что стоит живых людей: письмо ушло не с того номера,
 * с которого начата переписка, или второй аккаунт не получил своей доли
 * работы и очередь идёт вдвое дольше. Telegram и база — заглушки.
 */

jest.mock('@modules/sender/message-content', () => ({
  ...jest.requireActual('@modules/sender/message-content'),
  loadMessageContent: () => ({ text: 'письмо', body: 'тело', images: [] }),
}));

const UNLIMITED = Number.MAX_SAFE_INTEGER;

function lead(id: string, username: string, assignedAccount: string | null = null) {
  return { id, username, tgUserId: `10${id}`, sampleText: 'английский', assignedAccount };
}

function makeSender(
  over: {
    leads?: ReturnType<typeof lead>[];
    accounts?: string[];
    /** Отправлено каждым за сутки — база для выбора аккаунта. */
    used?: Record<string, number>;
    maxPerDay?: number;
  } = {},
) {
  const names = over.accounts ?? ['main', 'second'];
  const used = over.used ?? {};
  const maxPerDay = over.maxPerDay ?? 0;

  const clients = new Map(
    names.map((name) => [
      name,
      {
        getEntity: jest.fn(async () => ({ id: name })),
        sendMessage: jest.fn(async () => undefined),
        sendFile: jest.fn(async () => undefined),
      },
    ]),
  );

  const accounts = {
    list: () =>
      names.map((name) => ({
        name,
        client: clients.get(name),
        selfId: name,
        title: `@${name}`,
      })),
  };

  const queue = over.leads ?? [];
  const leads = {
    claimForSending: jest.fn(async (limit: number) => queue.slice(0, limit)),
    findForOutreach: jest.fn(async (limit: number) => ({
      total: queue.length,
      items: queue.slice(0, limit),
    })),
    isStillClaimed: jest.fn(async () => true),
    finishSending: jest.fn(async () => undefined),
    releaseToQueue: jest.fn(async () => 1),
  };

  const attempts = {
    start: jest.fn(async () => 'attempt-id'),
    finish: jest.fn(async () => undefined),
    budget: jest.fn(async (limit: number, account?: string) => {
      const spent = account ? (used[account] ?? 0) : 0;
      return {
        limit,
        used: spent,
        remaining: limit <= 0 ? UNLIMITED : Math.max(0, limit - spent),
        unlimited: limit <= 0,
        resetsAt: null,
        account: account ?? 'all',
      };
    }),
  };

  const service = new SenderService(
    {
      dryRun: false,
      contentDir: '/nowhere',
      maxPerRun: 10,
      delaySec: 0,
      maxConsecutiveErrors: 3,
      maxPerDay,
      personalized: false,
      personalizedImages: false,
    } as never,
    accounts as never,
    leads as never,
    attempts as never,
    { status: async () => ({ canSend: true, reason: '' }) } as never,
    { forMethod: () => null } as never,
  );

  return { service, clients, leads, attempts };
}

/** Кому что ушло: аккаунт → список ников. */
function sentBy(
  clients: Map<string, { sendMessage: jest.Mock }>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, client] of clients) out[name] = client.sendMessage.mock.calls.length;
  return out;
}

describe('SenderService: выбор аккаунта', () => {
  it('новых раскладывает поровну, а не сваливает на основной', async () => {
    // Без потолка (SEND_MAX_PER_DAY=0) остаток у обоих одинаково огромный.
    // Если бы выбор шёл по остатку, второй аккаунт не написал бы никому.
    const { service, clients } = makeSender({
      leads: [lead('1', 'a'), lead('2', 'b'), lead('3', 'c'), lead('4', 'd')],
    });

    const report = await service.run();

    expect(report.sent).toBe(4);
    expect(sentBy(clients)).toEqual({ main: 2, second: 2 });
  });

  it('закреплённому пишет его аккаунт, даже когда тот загружен сильнее', async () => {
    const { service, clients } = makeSender({
      leads: [lead('1', 'a', 'second')],
      used: { main: 0, second: 30 },
    });

    await service.run();
    expect(sentBy(clients)).toEqual({ main: 0, second: 1 });
  });

  it('аккаунт уходит в журнал попыток и закрепляется за лидом', async () => {
    const { service, attempts, leads } = makeSender({
      leads: [lead('1', 'a')],
      accounts: ['main'],
    });

    await service.run();

    expect(attempts.start).toHaveBeenCalledWith(
      expect.objectContaining({ id: '1' }),
      'main',
    );
    expect(leads.finishSending).toHaveBeenCalledWith(
      '1',
      'contacted',
      expect.stringContaining('@main'),
      'main',
    );
  });

  it('лид ждёт, если его аккаунт не подключён, а остальные едут дальше', async () => {
    // Переписку начал второй аккаунт, а сегодня TG_SESSION_2 пуст. Писать
    // такому человеку с основного нельзя: для него это чужой номер.
    const { service, clients, leads } = makeSender({
      leads: [lead('1', 'a', 'second'), lead('2', 'b')],
      accounts: ['main'],
    });

    const report = await service.run();

    expect(report.skipped).toBe(1);
    expect(report.sent).toBe(1);
    expect(sentBy(clients)).toEqual({ main: 1 });
    // Пропущенный вернулся в очередь, а не осел в `sending` навсегда.
    expect(leads.releaseToQueue).toHaveBeenCalledWith(['1']);
  });

  it('исчерпанный лимит одного аккаунта не мешает второму', async () => {
    const { service, clients } = makeSender({
      leads: [lead('1', 'a'), lead('2', 'b')],
      maxPerDay: 20,
      used: { main: 20, second: 0 },
    });

    const report = await service.run();

    expect(report.sent).toBe(2);
    expect(sentBy(clients)).toEqual({ main: 0, second: 2 });
  });

  it('в отчёте видно, сколько ушло с каждого аккаунта', async () => {
    const { service } = makeSender({ leads: [lead('1', 'a'), lead('2', 'b')] });

    const report = await service.run();

    expect(report.accounts.map((a) => [a.name, a.sentNow])).toEqual([
      ['main', 1],
      ['second', 1],
    ]);
  });

  it('предпросмотр показывает очередь и без единого поднятого аккаунта', async () => {
    // Telegram лежит или сессия не задана — посмотреть, кому уйдёт, всё
    // равно надо: раньше dry-run в Telegram не ходил вовсе.
    const { service, leads } = makeSender({
      leads: [lead('1', 'a'), lead('2', 'b')],
      accounts: [],
    });

    const report = await service.run(undefined, true);

    expect(report.entries.map((e) => e.result)).toEqual(['dry-run', 'dry-run']);
    expect(leads.claimForSending).not.toHaveBeenCalled();
  });
});
