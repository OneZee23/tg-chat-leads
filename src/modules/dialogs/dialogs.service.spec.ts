import bigInt from 'big-integer';
import { Api } from 'telegram';
import { DialogsService } from '@modules/dialogs/dialogs.service';
import { OutboxEntry } from '@modules/outreach/outbox.parse';

/**
 * Отправка по outbox: проверяем ровно то, из-за чего человек получил бы
 * лишнее сообщение. Telegram и база — заглушки, сервис собирается руками:
 * здесь важна логика решения «слать / не слать», а не проводка DI.
 */

const DUMPED_AT = Math.floor(Date.parse('2026-09-03T14:30:00Z') / 1000);

function user(id: string, username: string | null = null): Api.User {
  return new Api.User({ id: bigInt(id), username: username ?? undefined });
}

function dialog(id: string, username: string | null = null) {
  return { isUser: true, entity: user(id, username) };
}

function candidate(
  id: string,
  contactedAt = new Date('2026-09-01T10:00:00Z'),
): [string, unknown] {
  return [id, { tgUserId: id, contactedAt, sampleText: 'преподаю английский' }];
}

function entry(over: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    tgUserId: '1',
    username: 'nick',
    directive: 'send',
    body: 'Всё **бесплатно**, заходите)',
    ...over,
  };
}

function options(over: Record<string, unknown> = {}) {
  return {
    dryRun: false,
    limit: 50,
    file: '2026-09-03-1430.md',
    dumpedAtSec: DUMPED_AT,
    untouched: 0,
    ...over,
  } as Parameters<DialogsService['sendPreparedReplies']>[1];
}

function makeService(
  over: {
    dialogs?: unknown[];
    // media/voice/photo/sticker — то, что GramJS кладёт рядом с пустым
    // message у вложений. Отправщик читает их через mediaLabel, поэтому в
    // фикстурах они должны быть выразимы.
    messages?: Array<{
      out: boolean;
      date: number;
      message: string;
      media?: unknown;
      voice?: unknown;
      photo?: unknown;
      sticker?: unknown;
    }>;
    candidates?: Map<string, unknown>;
  } = {},
) {
  const client = {
    // Архив — отдельный проход (`archived: true`), и в фикстуре он пуст:
    // иначе те же диалоги вернулись бы дважды.
    iterDialogs: jest.fn(async function* (params?: { archived?: boolean }) {
      if (params?.archived) return;
      for (const d of over.dialogs ?? []) yield d;
    }),
    getMessages: jest.fn(async () => over.messages ?? []),
    // Аргументы в дженерике, а не в лямбде: иначе mock.calls типизируется
    // пустым кортежем и до параметров отправки не добраться.
    sendMessage: jest.fn<Promise<void>, [unknown, Record<string, unknown>]>(
      async () => undefined,
    ),
  };
  const leads = {
    getDialogCandidates: jest.fn(async () => over.candidates ?? new Map()),
    markAnswered: jest.fn(async () => undefined),
  };
  // Паузы в ноль: ждать джиттер в юнит-тесте нечего, а на решения он не влияет.
  const config = {
    limit: 100,
    deepLimit: 50,
    deepDelayMs: 0,
    autoReplyDelaySec: 0,
    autoReplyMax: 40,
  };

  // Пул аккаунтов с одним основным: обход диалогов ходит через него.
  const accounts = {
    list: () => [{ name: 'main', client, selfId: '999', title: '@me' }],
  };

  const service = new DialogsService(
    config as never,
    {} as never,
    { getClient: () => client } as never,
    accounts as never,
    leads as never,
  );
  return { service, client, leads };
}

/** История, где мы написали, а человек ответил ДО выгрузки: черновик актуален. */
const FRESH_HISTORY = [
  { out: true, date: DUMPED_AT - 3600, message: 'наше письмо' },
  { out: false, date: DUMPED_AT - 600, message: 'а сколько стоит?' },
];

/** Диалог для collectUnanswered: у него важно последнее сообщение — по нему
 *  идёт дешёвый пред-фильтр, экономящий запрос истории. */
function dialogWithLast(
  id: string,
  username: string | null,
  last: { out: boolean; date: number; message: string },
) {
  return { isUser: true, entity: user(id, username), message: last };
}

describe('collectUnanswered', () => {
  it('сообщения без текста не попадают в отрендеренную историю', async () => {
    // Рассылка уходит скриншотами: у них message пустой, и в файле они
    // рисовались пустыми блоками по семь подряд перед каждым письмом.
    // Отвечать на них не на что, читать мешает.
    const { service } = makeService({
      dialogs: [
        dialogWithLast('1', 'nick', {
          out: false,
          date: DUMPED_AT,
          message: 'вопрос',
        }),
      ],
      messages: [
        { out: true, date: DUMPED_AT - 3600, message: '' },
        { out: true, date: DUMPED_AT - 3599, message: '' },
        { out: true, date: DUMPED_AT - 3598, message: 'наше письмо' },
        { out: false, date: DUMPED_AT, message: 'вопрос' },
      ],
      candidates: new Map([candidate('1')]),
    });

    const dump = await service.collectUnanswered(10);

    const all = [...dump.dialogs, ...dump.trivial];
    expect(all).toHaveLength(1);
    expect(all[0].history.map((m) => m.text)).toEqual(['наше письмо', 'вопрос']);
  });

  it('пустое исходящее всё равно двигает курсор — иначе диалог всплыл бы заново', async () => {
    // Фильтровать пустые можно ТОЛЬКО при рендере. Убрать их до
    // sliceUnanswered — значит потерять наше фото как «последнее наше
    // сообщение», откатить курсор назад и снова показать уже отвеченное.
    const { service } = makeService({
      dialogs: [
        dialogWithLast('1', 'nick', {
          out: false,
          date: DUMPED_AT + 150,
          message: 'новый вопрос',
        }),
      ],
      messages: [
        { out: true, date: DUMPED_AT, message: 'наше письмо' },
        { out: false, date: DUMPED_AT + 50, message: 'старый вопрос' },
        { out: true, date: DUMPED_AT + 100, message: '' },
        { out: false, date: DUMPED_AT + 150, message: 'новый вопрос' },
      ],
      candidates: new Map([candidate('1')]),
    });

    const dump = await service.collectUnanswered(10);

    const fresh = [...dump.dialogs, ...dump.trivial][0].history
      .filter((m) => m.fresh)
      .map((m) => m.text);
    expect(fresh).toEqual(['новый вопрос']);
  });
});

describe('sendPreparedReplies', () => {
  it('без стампа в имени файла ни один SEND не уходит', async () => {
    // Guard по истории закрывает только случай «человек больше не писал».
    // Ответил на наш ответ — неотвеченное снова непусто, и от дубля защищает
    // ровно сравнение со стампом. Нет стампа — не отправляем.
    const { service, client, leads } = makeService({
      dialogs: [dialog('1', 'nick')],
      messages: FRESH_HISTORY,
      candidates: new Map([candidate('1')]),
    });

    const result = await service.sendPreparedReplies(
      [entry()],
      options({ dumpedAtSec: null, file: 'ответы-вторник.md' }),
    );

    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(leads.markAnswered).not.toHaveBeenCalled();
    expect(result.sent).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.entries[0].note).toContain('стампа');
    expect(result.entries[0].note).toContain('YYYY-MM-DD-HHMM.md');
  });

  it('без стампа и без CLOSE в Telegram не ходим вовсе', async () => {
    const { service, client } = makeService({ dialogs: [dialog('1', 'nick')] });

    await service.sendPreparedReplies([entry()], options({ dumpedAtSec: null }));

    // Даже первая страница диалогов — запрос к Telegram, а слать всё равно
    // нечего.
    expect(client.iterDialogs).not.toHaveBeenCalled();
  });

  it('без стампа предпросмотр показывает то же, что сделает боевой прогон', async () => {
    const { service } = makeService({ dialogs: [dialog('1', 'nick')] });

    const preview = await service.sendPreparedReplies(
      [entry()],
      options({ dryRun: true, dumpedAtSec: null }),
    );

    expect(preview.sent).toBe(0);
    expect(preview.skipped).toBe(1);
    expect(preview.staleCheck).toBe(false);
  });

  it('CLOSE помечает answered, не дожидаясь прохода по диалогам', async () => {
    // Диалога в проходе нет вовсе: раньше такой CLOSE оседал в notFound
    // необработанным, пока проход до него не дойдёт (а мог и не дойти).
    const { service, client, leads } = makeService({
      dialogs: [],
      candidates: new Map([candidate('777')]),
    });

    const result = await service.sendPreparedReplies(
      [entry({ tgUserId: '777', directive: 'close', body: '' })],
      options(),
    );

    expect(leads.markAnswered).toHaveBeenCalledWith('777');
    expect(client.iterDialogs).not.toHaveBeenCalled();
    expect(result.closed).toBe(1);
    expect(result.notFound).toBe(0);
  });

  it('предпросмотр CLOSE ничего не помечает', async () => {
    const { service, leads } = makeService({ candidates: new Map([candidate('1')]) });

    const result = await service.sendPreparedReplies(
      [entry({ directive: 'close', body: '' })],
      options({ dryRun: true }),
    );

    expect(leads.markAnswered).not.toHaveBeenCalled();
    expect(result.closed).toBe(1);
  });

  it('CLOSE по id не из кандидатов — пропускаем, answered не ставим', async () => {
    // Тот же guard, что у SEND: id из файла непроверенный, а markAnswered —
    // безусловный UPDATE по tg_user_id. Опечатка в цифре задела бы чужого лида.
    const { service, leads } = makeService({ candidates: new Map() });

    const result = await service.sendPreparedReplies(
      [entry({ tgUserId: '999', directive: 'close', body: '' })],
      options(),
    );

    expect(leads.markAnswered).not.toHaveBeenCalled();
    expect(result.closed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.entries[0].note).toContain('кандидат');
  });

  it('без стампа: причина остановки называет реальный повод, а не общую фразу', async () => {
    // Ранний выход ДО iterDialogs — «записи закончились» подразумевала бы
    // прошедший обход, которого тут не было вовсе.
    const { service } = makeService({ dialogs: [dialog('1', 'nick')] });

    const result = await service.sendPreparedReplies(
      [entry()],
      options({ dumpedAtSec: null }),
    );

    expect(result.stoppedBecause).toContain('нет стампа');
  });

  it('в файле только CLOSE/ASK: причина остановки не врёт про обход диалогов', async () => {
    const { service } = makeService({ candidates: new Map([candidate('1')]) });

    const result = await service.sendPreparedReplies(
      [entry({ directive: 'close', body: '' })],
      options(),
    );

    expect(result.stoppedBecause).not.toBe('записи закончились');
    expect(result.stoppedBecause).toContain('CLOSE');
  });

  it('без стампа + CLOSE в одном файле: CLOSE проходит, SEND отказан, обхода нет', async () => {
    // Пересечение двух guard'ов из отдельных тестов выше: fail-closed по SEND
    // без стампа не должен блокировать CLOSE, а CLOSE не должен утягивать
    // проход в iterDialogs — как и одиночный CLOSE.
    const { service, client, leads } = makeService({
      candidates: new Map([candidate('1'), candidate('2')]),
    });

    const result = await service.sendPreparedReplies(
      [
        entry({ tgUserId: '1', directive: 'send' }),
        entry({ tgUserId: '2', directive: 'close', body: '' }),
      ],
      options({ dumpedAtSec: null }),
    );

    expect(client.iterDialogs).not.toHaveBeenCalled();
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(leads.markAnswered).toHaveBeenCalledWith('2');
    expect(leads.markAnswered).not.toHaveBeenCalledWith('1');
    expect(result.sent).toBe(0);
    expect(result.closed).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it('кому не место в кандидатах — тому не пишем', async () => {
    // Человека могли пометить skip/rejected уже после выгрузки, а опечатка в
    // цифре id уводит ответ в посторонний диалог.
    const { service, client, leads } = makeService({
      dialogs: [dialog('1', 'nick')],
      messages: FRESH_HISTORY,
      candidates: new Map(),
    });

    const result = await service.sendPreparedReplies([entry()], options());

    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(leads.markAnswered).not.toHaveBeenCalled();
    // История дорогая — до неё дело не доходит.
    expect(client.getMessages).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
    expect(result.entries[0].note).toContain('кандидат');
  });

  it('тело уходит мимо markdown-парсера', async () => {
    // Иначе непарный `**` из markdown-файла вырезается молча и человек
    // получает не те байты, которые автор вычитал.
    const { service, client } = makeService({
      dialogs: [dialog('1', 'nick')],
      messages: FRESH_HISTORY,
      candidates: new Map([candidate('1')]),
    });

    const body = 'Цена — 0 ₽ (см. **лендинг), заходите';
    const result = await service.sendPreparedReplies([entry({ body })], options());

    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    expect(client.sendMessage.mock.calls[0][1]).toEqual({
      message: body,
      parseMode: false,
    });
    expect(result.sent).toBe(1);
  });

  it('человек написал после выгрузки — черновик устарел, не отправляем', async () => {
    const { service, client } = makeService({
      dialogs: [dialog('1', 'nick')],
      messages: [
        ...FRESH_HISTORY,
        { out: false, date: DUMPED_AT + 60, message: 'и ещё вопрос' },
      ],
      candidates: new Map([candidate('1')]),
    });

    const result = await service.sendPreparedReplies([entry()], options());

    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });

  it('голосовое без подписи — это ответ, а не пустота: черновик уходит', async () => {
    // Регресс 09.09. Отправка строила историю из сырого m.message, а
    // sliceUnanswered выбрасывает сообщения с пустым текстом. У голосового и
    // фото текста нет, поэтому входящих не находилось совсем и человек
    // получал вердикт «ты ответил руками» — то есть подготовленный ответ ему
    // не уходил НИКОГДА. Выгрузка inbox при этом такие сообщения показывала:
    // два места делали одно и то же по-разному. Так три недели провисели
    // двое, приславшие голосовое и фотографию.
    const { service, client } = makeService({
      dialogs: [dialog('1', 'nick')],
      messages: [
        { out: true, date: DUMPED_AT - 3600, message: 'наше письмо' },
        // Ровно то, что отдаёт GramJS на голосовое: текста нет, есть media.
        { out: false, date: DUMPED_AT - 600, message: '', media: {}, voice: true },
      ],
      candidates: new Map([candidate('1')]),
    });

    const result = await service.sendPreparedReplies([entry()], options());

    expect(result.sent).toBe(1);
    expect(result.skipped).toBe(0);
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('фото без подписи — тоже ответ', async () => {
    const { service, client } = makeService({
      dialogs: [dialog('1', 'nick')],
      messages: [
        { out: true, date: DUMPED_AT - 3600, message: 'наше письмо' },
        { out: false, date: DUMPED_AT - 600, message: '', media: {}, photo: {} },
      ],
      candidates: new Map([candidate('1')]),
    });

    const result = await service.sendPreparedReplies([entry()], options());

    expect(result.sent).toBe(1);
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('стикер ответом не считается — на него отвечать нечем', async () => {
    // mediaLabel намеренно возвращает null для стикера: подписи у него нет,
    // и трактовать его как реплику, требующую ответа, было бы хуже молчания.
    const { service, client } = makeService({
      dialogs: [dialog('1', 'nick')],
      messages: [
        { out: true, date: DUMPED_AT - 3600, message: 'наше письмо' },
        { out: false, date: DUMPED_AT - 600, message: '', media: {}, sticker: {} },
      ],
      candidates: new Map([candidate('1')]),
    });

    const result = await service.sendPreparedReplies([entry()], options());

    expect(result.sent).toBe(0);
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it('на время прогона взводится латч и снимается после', async () => {
    // Два прогона внахлёст успевают оба прочитать историю до того, как первый
    // отправит, и guard пропускает обоих.
    const { service, leads } = makeService();
    let duringRun: boolean | null = null;
    leads.getDialogCandidates.mockImplementation(async () => {
      duringRun = service.isSending();
      return new Map();
    });

    expect(service.isSending()).toBe(false);
    await service.sendPreparedReplies([entry({ directive: 'ask' })], options());

    expect(duringRun).toBe(true);
    expect(service.isSending()).toBe(false);
  });

  it('латч снимается и когда прогон упал', async () => {
    const { service, leads } = makeService();
    leads.getDialogCandidates.mockImplementation(async () => {
      throw new Error('база недоступна');
    });

    await expect(service.sendPreparedReplies([entry()], options())).rejects.toThrow(
      'база недоступна',
    );
    expect(service.isSending()).toBe(false);
  });
});

/**
 * Два аккаунта.
 *
 * Главное здесь одно: ответ приходит тому, кто писал. Если второй аккаунт
 * отправил письмо, а инбокс читается только с первого, человек считается
 * промолчавшим — при том, что он ответил. Это условие запуска фичи, а не
 * улучшение «потом», поэтому у него свои тесты.
 */
function makeTwoAccounts(over: {
  mainDialogs?: unknown[];
  secondDialogs?: unknown[];
  mainMessages?: Array<{ out: boolean; date: number; message: string }>;
  secondMessages?: Array<{ out: boolean; date: number; message: string }>;
  candidates?: Map<string, unknown>;
}) {
  const makeClient = (
    dialogs: unknown[],
    messages: Array<{ out: boolean; date: number; message: string }>,
  ) => ({
    iterDialogs: jest.fn(async function* (params?: { archived?: boolean }) {
      if (params?.archived) return;
      for (const d of dialogs) yield d;
    }),
    getMessages: jest.fn(async () => messages),
    sendMessage: jest.fn<Promise<void>, [unknown, Record<string, unknown>]>(
      async () => undefined,
    ),
  });

  const main = makeClient(over.mainDialogs ?? [], over.mainMessages ?? []);
  const second = makeClient(over.secondDialogs ?? [], over.secondMessages ?? []);

  const leads = {
    getDialogCandidates: jest.fn(async () => over.candidates ?? new Map()),
    markAnswered: jest.fn(async () => undefined),
  };

  const accounts = {
    list: () => [
      { name: 'main', client: main, selfId: '900', title: '@one' },
      { name: 'second', client: second, selfId: '901', title: '@two' },
    ],
  };

  const service = new DialogsService(
    {
      limit: 100,
      deepLimit: 50,
      deepDelayMs: 0,
      autoReplyDelaySec: 0,
      autoReplyMax: 40,
    } as never,
    {} as never,
    { getClient: () => main } as never,
    accounts as never,
    leads as never,
  );

  return { service, main, second, leads };
}

function assignedCandidate(id: string, account: string | null): [string, unknown] {
  return [
    id,
    {
      tgUserId: id,
      contactedAt: new Date((DUMPED_AT - 7200) * 1000),
      sampleText: 'преподаю английский',
      assignedAccount: account,
    },
  ];
}

describe('обход диалогов с двумя аккаунтами', () => {
  const incoming = { out: false, date: DUMPED_AT, message: 'а сколько стоит?' };

  it('в выгрузку попадают ответы с обоих аккаунтов', async () => {
    const { service } = makeTwoAccounts({
      mainDialogs: [dialogWithLast('1', 'one', incoming)],
      secondDialogs: [dialogWithLast('2', 'two', incoming)],
      mainMessages: [
        { out: true, date: DUMPED_AT - 3600, message: 'наше письмо' },
        incoming,
      ],
      secondMessages: [
        { out: true, date: DUMPED_AT - 3600, message: 'наше письмо' },
        incoming,
      ],
      candidates: new Map([
        assignedCandidate('1', 'main'),
        assignedCandidate('2', 'second'),
      ]),
    });

    const dump = await service.collectUnanswered(50);
    expect(dump.dialogs.map((d) => d.tgUserId).sort()).toEqual(['1', '2']);
    expect(dump.dialogs.find((d) => d.tgUserId === '2')?.account).toBe('second');
  });

  it('человека из лички обоих аккаунтов разбирает тот, кто ему писал', async () => {
    // У человека есть личный чат и с нашим вторым номером. Читать надо
    // переписку того, кто вёл аутрич, — иначе «неотвеченное» окажется из
    // совсем другого разговора.
    const { service, main, second } = makeTwoAccounts({
      mainDialogs: [dialogWithLast('7', 'both', incoming)],
      secondDialogs: [dialogWithLast('7', 'both', incoming)],
      mainMessages: [{ out: false, date: DUMPED_AT, message: 'привет, как дела' }],
      secondMessages: [
        { out: true, date: DUMPED_AT - 3600, message: 'наше письмо' },
        incoming,
      ],
      candidates: new Map([assignedCandidate('7', 'second')]),
    });

    const dump = await service.collectUnanswered(50);
    expect(dump.dialogs).toHaveLength(1);
    expect(dump.dialogs[0].account).toBe('second');
    // Историю у основного даже не спрашивали: переписку ведёт не он.
    expect(main.getMessages).not.toHaveBeenCalled();
    expect(second.getMessages).toHaveBeenCalled();
  });

  it('ответ уходит с того аккаунта, который вёл переписку', async () => {
    const { service, main, second } = makeTwoAccounts({
      mainDialogs: [dialog('5', 'nick')],
      secondDialogs: [dialog('5', 'nick')],
      secondMessages: [
        { out: true, date: DUMPED_AT - 3600, message: 'наше письмо' },
        { out: false, date: DUMPED_AT - 600, message: 'а сколько стоит?' },
      ],
      candidates: new Map([assignedCandidate('5', 'second')]),
    });

    const result = await service.sendPreparedReplies(
      [entry({ tgUserId: '5', body: 'бесплатно' })],
      options(),
    );

    expect(result.sent).toBe(1);
    expect(result.notFound).toBe(0);
    expect(main.sendMessage).not.toHaveBeenCalled();
    expect(second.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('не закреплённого разбирает первый, у кого нашёлся диалог', async () => {
    // Так работают все, кому писали до появления второго аккаунта: у них
    // assigned_account пустой, и переписка лежит у основного.
    const { service, main, second } = makeTwoAccounts({
      mainDialogs: [dialog('9', 'nick')],
      secondDialogs: [dialog('9', 'nick')],
      mainMessages: [
        { out: true, date: DUMPED_AT - 3600, message: 'наше письмо' },
        { out: false, date: DUMPED_AT - 600, message: 'а сколько стоит?' },
      ],
      candidates: new Map([assignedCandidate('9', null)]),
    });

    const result = await service.sendPreparedReplies(
      [entry({ tgUserId: '9', body: 'бесплатно' })],
      options(),
    );

    expect(result.sent).toBe(1);
    expect(main.sendMessage).toHaveBeenCalledTimes(1);
    expect(second.sendMessage).not.toHaveBeenCalled();
  });
});

describe('архив', () => {
  it('обход заходит и в архив, а не только в основную папку', async () => {
    // GramJS без явного archived отдаёт архив одной псевдозаписью и молча её
    // пропускает. 15.09.2026 это стоило 200 человек, которым мы писали:
    // Telegram сам уносит в архив чаты от неконтактов, а мы пишем именно им.
    const { service, client } = makeService({ dialogs: [] });
    await service.collectUnanswered(10);

    const folders = client.iterDialogs.mock.calls.map(
      (call) => (call[0] as { archived?: boolean } | undefined)?.archived,
    );
    expect(folders).toEqual([false, true]);
  });

  it('человек из архива попадает в выгрузку', async () => {
    const archived = dialogWithLast('42', 'hidden', {
      out: false,
      date: DUMPED_AT,
      message: 'а сколько стоит?',
    });
    const { service } = makeService({
      messages: [
        { out: true, date: DUMPED_AT - 3600, message: 'наше письмо' },
        { out: false, date: DUMPED_AT, message: 'а сколько стоит?' },
      ],
      candidates: new Map([candidate('42')]),
    });
    // Мок отдаёт диалог только на проходе по архиву.
    const client = (
      service as unknown as {
        accounts: { list: () => Array<{ client: { iterDialogs: jest.Mock } }> };
      }
    ).accounts.list()[0].client;
    client.iterDialogs.mockImplementation(async function* (params?: {
      archived?: boolean;
    }) {
      if (params?.archived) yield archived;
    });

    const dump = await service.collectUnanswered(10);
    expect(dump.dialogs.map((d) => d.tgUserId)).toEqual(['42']);
  });
});

describe('узнавание по @нику', () => {
  it('человек с устаревшим id в базе всё равно опознаётся', async () => {
    // Рассылка открывает человека по НИКУ, а в базе лежит id, записанный
    // сканером раньше. Между этими моментами ник мог сменить владельца.
    // 15.09.2026 обход прошёл 1430 диалогов и узнал в них 1209 кандидатов —
    // больше двух сотен пролистали мимо, не узнав своих.
    const { service } = makeService({
      dialogs: [
        dialogWithLast('999999', 'nick', {
          out: false,
          date: DUMPED_AT,
          message: 'а сколько стоит?',
        }),
      ],
      messages: [
        { out: true, date: DUMPED_AT - 3600, message: 'наше письмо' },
        { out: false, date: DUMPED_AT, message: 'а сколько стоит?' },
      ],
      // В базе тот же человек лежит под другим id, зато с тем же ником.
      candidates: new Map([
        [
          '1',
          {
            tgUserId: '1',
            username: 'nick',
            contactedAt: new Date('2026-09-01'),
            sampleText: 'английский',
          },
        ],
      ]),
    });

    const dump = await service.collectUnanswered(10);

    expect(dump.dialogs.map((d) => d.tgUserId)).toEqual(['1']);
    expect(dump.candidatesUnseen).toBe(0);
  });

  it('регистр ника не мешает: в Telegram он регистронезависим', async () => {
    const { service } = makeService({
      dialogs: [
        dialogWithLast('42', 'ExampleTutor', {
          out: false,
          date: DUMPED_AT,
          message: 'а когда можно начать?',
        }),
      ],
      messages: [
        { out: true, date: DUMPED_AT - 3600, message: 'наше письмо' },
        { out: false, date: DUMPED_AT, message: 'а когда можно начать?' },
      ],
      candidates: new Map([
        [
          '7',
          {
            tgUserId: '7',
            username: 'exampletutor',
            contactedAt: new Date('2026-09-01'),
            sampleText: 'математика',
          },
        ],
      ]),
    });

    const dump = await service.collectUnanswered(10);
    expect(dump.dialogs.map((d) => d.tgUserId)).toEqual(['7']);
  });
});
