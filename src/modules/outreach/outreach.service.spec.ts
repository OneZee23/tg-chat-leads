import * as files from '@modules/outreach/reply-files';
import { OutreachService } from '@modules/outreach/outreach.service';

/**
 * Склейка вокруг файлов обмена: имя выгрузки, отказ от параллельного прогона
 * и честный текст, когда отправлять не из чего. Telegram и база — заглушки.
 */

jest.mock('@modules/outreach/reply-files', () => {
  const actual = jest.requireActual('@modules/outreach/reply-files');
  return {
    ...actual,
    writeInbox: jest.fn((name: string) => `/repo/inbox/${name}`),
    listOutboxNames: jest.fn(() => []),
    newestOutboxName: jest.fn(() => null),
  };
});

const writeInbox = files.writeInbox as jest.Mock;
const listOutboxNames = files.listOutboxNames as jest.Mock;

const EMPTY_DUMP = {
  createdAt: '2026-09-03 14:00',
  dialogsSeen: 0,
  dialogs: [],
  trivial: [],
  stoppedBecause: 'кандидаты закончились',
};

function makeService(over: { dialogs?: Record<string, unknown> } = {}) {
  const dialogs = {
    collectUnanswered: jest.fn(async () => EMPTY_DUMP),
    isSending: jest.fn(() => false),
    sendPreparedReplies: jest.fn(),
    ...(over.dialogs ?? {}),
  };
  const service = new OutreachService(
    {} as never,
    dialogs as never,
    {} as never,
    {} as never,
  );
  return { service, dialogs };
}

describe('inbox', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('стамп в имени файла снимается ДО обхода диалогов', async () => {
    // Обход идёт минутами. Стамп с его конца оказывается позже сообщений,
    // пришедших уже во время обхода, — и guard перед отправкой не считает их
    // свежими: мы отвечаем на устаревшую реплику, ровно то, чего нельзя.
    jest.useFakeTimers().setSystemTime(new Date(2026, 8, 3, 14, 0));
    const { service } = makeService({
      dialogs: {
        collectUnanswered: jest.fn(async () => {
          jest.setSystemTime(new Date(2026, 8, 3, 14, 30));
          return EMPTY_DUMP;
        }),
      },
    });

    await service.inbox(10);

    expect(writeInbox).toHaveBeenCalledWith('2026-09-03-1400.md', expect.any(String));
  });
});

describe('outboxSend', () => {
  afterEach(() => jest.clearAllMocks());

  it('второй прогон внахлёст не запускается', async () => {
    // Оба успели бы прочитать историю до того, как первый отправит, и guard
    // по свежести пропустил бы обоих: человек получает дубль.
    const { service, dialogs } = makeService({
      dialogs: { isSending: jest.fn(() => true) },
    });

    const out = await service.outboxSend(undefined, true, 50);

    expect(out).toContain('уже идёт');
    expect(dialogs.sendPreparedReplies).not.toHaveBeenCalled();
  });

  it('файлы без стампа не выдаются за пустую папку', async () => {
    // «Нет ни одного .md» читалось бы как «ассистент ничего не написал».
    listOutboxNames.mockReturnValue(['ответы-вторник.md']);
    const { service } = makeService();

    const out = await service.outboxSend(undefined, false, 50);

    expect(out).not.toContain('нет ни одного .md');
    expect(out).toContain('ответы-вторник.md');
    expect(out).toContain('YYYY-MM-DD-HHMM.md');
  });

  it('пустая папка так и называется', async () => {
    listOutboxNames.mockReturnValue([]);
    const { service } = makeService();

    expect(await service.outboxSend(undefined, false, 50)).toContain('нет ни одного .md');
  });
});
