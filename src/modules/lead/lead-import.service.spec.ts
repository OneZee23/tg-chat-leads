import bigInt from 'big-integer';
import { Api } from 'telegram';
import { FloodWaitError } from 'telegram/errors';
import * as sleepUtils from '@common/utils/sleep';
import { LeadImportService } from '@modules/lead/lead-import.service';

/**
 * Telegram здесь только мокой: в .env живая сессия владельца, и резолв
 * пачки ников вживую — это тот самый лишний параллельный процесс на ней.
 * Проверяем ровно склейку: что уже известное не идёт в сеть, что одна
 * плохая строка не роняет пачку и что между запросами есть паузы.
 */

jest.mock('@common/utils/sleep', () => ({
  sleep: jest.fn(async () => undefined),
  sleepJitter: jest.fn(async () => undefined),
}));

const sleepJitter = sleepUtils.sleepJitter as jest.Mock;

function user(id: number, over: Partial<Api.User> = {}): Api.User {
  return new Api.User({
    id: bigInt(id),
    firstName: 'Мария',
    username: 'example_tutor',
    ...over,
  } as never);
}

function makeService(
  over: {
    getEntity?: jest.Mock;
    existing?: string[];
    upsert?: jest.Mock;
    floodHuman?: string | null;
  } = {},
) {
  const getEntity = over.getEntity ?? jest.fn(async () => user(777));
  const upsert = over.upsert ?? jest.fn(async () => ({ created: true }));
  const existingUsernames = jest.fn(async () => new Set(over.existing ?? []));

  const telegram = { getClient: () => ({ getEntity }) };
  const leads = { existingUsernames, upsert };
  const flood = {
    forMethod: jest.fn(() =>
      over.floodHuman
        ? { method: 'contacts.ResolveUsername', human: over.floodHuman }
        : null,
    ),
  };

  const service = new LeadImportService(
    telegram as never,
    leads as never,
    flood as never,
  );

  return { service, getEntity, upsert, existingUsernames };
}

beforeEach(() => jest.clearAllMocks());

describe('import', () => {
  it('заводит лида с указанным источником и без следов сообщения', async () => {
    const { service, upsert } = makeService();

    const report = await service.import({
      source: 'google',
      items: [
        {
          contact: 'https://t.me/Example_Tutor',
          note: 'выдача по «репетитор английского»',
        },
      ],
    });

    expect(report).toMatchObject({ requested: 1, created: 1, duplicates: 0, failed: 0 });
    expect(report.entries[0]).toMatchObject({
      contact: 'https://t.me/Example_Tutor',
      username: 'example_tutor',
      result: 'created',
      tgUserId: '777',
    });

    const input = upsert.mock.calls[0][0];
    expect(input).toMatchObject({
      tgUserId: '777',
      source: 'google',
      sourceChat: null,
      sourceChatTitle: null,
      // Сообщения не было — по этому признаку upsert не двигает счётчики
      // и last_seen_at при повторном импорте.
      messageId: null,
      note: 'выдача по «репетитор английского»',
    });
  });

  it('имя из списка идёт в дело только если Telegram имени не дал', async () => {
    const withName = makeService();
    await withName.service.import({
      source: 'instagram',
      items: [{ contact: '@example_tutor', name: 'Мария из инстаграма' }],
    });
    expect(withName.upsert.mock.calls[0][0].firstName).toBe('Мария');

    const noName = makeService({
      getEntity: jest.fn(async () => user(777, { firstName: undefined })),
    });
    await noName.service.import({
      source: 'instagram',
      items: [{ contact: '@example_tutor', name: 'Мария из инстаграма' }],
    });
    expect(noName.upsert.mock.calls[0][0].firstName).toBe('Мария из инстаграма');
  });

  it('повторный импорт известного ника не ходит в Telegram', async () => {
    // Список добивают по частям, и вторая пачка почти целиком повторяет
    // первую. Лимит на резолв тратить на это нельзя.
    const { service, getEntity, upsert } = makeService({ existing: ['example_tutor'] });

    const report = await service.import({
      source: 'yandex',
      items: [{ contact: '@Example_Tutor' }],
    });

    expect(report).toMatchObject({ created: 0, duplicates: 1, failed: 0 });
    expect(report.entries[0].result).toBe('duplicate');
    expect(getEntity).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('дедуп по tg_user_id: ник сменился, человек тот же', async () => {
    // Настоящий дедуп — уникальный индекс в базе. Ник у человека новый,
    // поэтому предварительная отсечка его не поймала, а ON CONFLICT поймал.
    const { service } = makeService({
      upsert: jest.fn(async () => ({ created: false })),
    });

    const report = await service.import({
      source: 'google',
      items: [{ contact: '@brand_new_nick' }],
    });

    expect(report).toMatchObject({ created: 0, duplicates: 1, failed: 0 });
  });

  it('строка с мусором не ходит в Telegram и не роняет соседей', async () => {
    const { service, getEntity } = makeService();

    const report = await service.import({
      source: 'google',
      items: [{ contact: 'позвоните мне +79991234567' }, { contact: '@example_tutor' }],
    });

    expect(report).toMatchObject({ created: 1, failed: 1 });
    expect(report.entries[0]).toMatchObject({
      username: null,
      result: 'failed',
      error: 'не похоже на @ник или ссылку t.me',
    });
    expect(report.entries[1].result).toBe('created');
    expect(getEntity).toHaveBeenCalledTimes(1);
  });

  it('несуществующий ник — ошибка строки, а не пачки', async () => {
    const getEntity = jest
      .fn()
      .mockRejectedValueOnce(
        new Error('USERNAME_NOT_OCCUPIED (caused by contacts.ResolveUsername)'),
      )
      .mockResolvedValueOnce(user(778, { username: 'second_tutor' }));
    const { service, upsert } = makeService({ getEntity });

    const report = await service.import({
      source: 'google',
      items: [{ contact: '@ghost_tutor' }, { contact: '@second_tutor' }],
    });

    expect(report).toMatchObject({ requested: 2, created: 1, failed: 1 });
    expect(report.entries[0]).toMatchObject({
      contact: '@ghost_tutor',
      result: 'failed',
      error: 'такого ника не существует',
    });
    expect(report.entries[1].result).toBe('created');
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it('канал, бот и удалённый аккаунт отсеиваются построчно', async () => {
    const getEntity = jest
      .fn()
      .mockResolvedValueOnce(new Api.Channel({ id: bigInt(1), title: 'Канал' } as never))
      .mockResolvedValueOnce(user(2, { bot: true }))
      .mockResolvedValueOnce(user(3, { deleted: true }));
    const { service, upsert } = makeService({ getEntity });

    const report = await service.import({
      source: 'google',
      items: [
        { contact: '@some_channel' },
        { contact: '@some_robot' },
        { contact: '@gone_tutor' },
      ],
    });

    expect(report.failed).toBe(3);
    expect(report.entries.map((e) => e.error)).toEqual([
      'это канал или группа, а не человек',
      'это бот',
      'аккаунт удалён',
    ]);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('строка, вставленная в список дважды, стоит одного резолва', async () => {
    // Ручной сбор — это копипаста, и повтор внутри одной пачки норма.
    const { service, getEntity } = makeService();

    const report = await service.import({
      source: 'google',
      items: [{ contact: '@example_tutor' }, { contact: 'https://t.me/Example_Tutor' }],
    });

    expect(getEntity).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({ created: 1, duplicates: 1, failed: 0 });
  });

  it('между обращениями к Telegram есть пауза с джиттером', async () => {
    // Ровная очередь резолвов сама по себе выглядит как автоматизация.
    const { service } = makeService({
      getEntity: jest
        .fn()
        .mockResolvedValueOnce(user(1, { username: 'first_tutor' }))
        .mockResolvedValueOnce(user(2, { username: 'second_tutor' }))
        .mockResolvedValueOnce(user(3, { username: 'third_tutor' })),
    });

    await service.import({
      source: 'google',
      items: [
        { contact: '@first_tutor' },
        { contact: '@second_tutor' },
        { contact: '@third_tutor' },
      ],
    });

    // Три запроса — две паузы: перед первым ждать нечего.
    expect(sleepJitter).toHaveBeenCalledTimes(2);
    expect(sleepJitter.mock.calls[0][0]).toBeGreaterThan(0);
  });

  it('FloodWait на резолве останавливает остаток пачки', async () => {
    const getEntity = jest
      .fn()
      .mockRejectedValueOnce(
        new FloodWaitError({ request: {}, capture: 300, seconds: 300 } as never),
      );
    const { service } = makeService({ getEntity });

    const report = await service.import({
      source: 'google',
      items: [{ contact: '@first_tutor' }, { contact: '@second_tutor' }],
    });

    expect(getEntity).toHaveBeenCalledTimes(1);
    expect(report.entries[0].error).toContain('подождать 300s');
    expect(report.entries[1].error).toContain('лимит Telegram');
    expect(report.failed).toBe(2);
  });

  it('лимит, зажатый до начала, не даёт сжечь пачку впустую', async () => {
    const { service, getEntity } = makeService({ floodHuman: '8ч 6м' });

    const report = await service.import({
      source: 'google',
      items: [{ contact: '@first_tutor' }],
    });

    expect(getEntity).not.toHaveBeenCalled();
    expect(report.entries[0].error).toContain('8ч 6м');
  });
});
