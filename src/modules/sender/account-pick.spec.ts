import { AccountLoad, describePickFailure, pickAccount } from '@modules/sender/account-pick';

const UNLIMITED = Number.MAX_SAFE_INTEGER;

function load(name: string, used: number, remaining = UNLIMITED): AccountLoad {
  return { name, used, remaining };
}

describe('pickAccount: закреплённый аккаунт', () => {
  it('пишет тот же, кто писал, даже если он загружен сильнее', () => {
    const result = pickAccount('second', [load('main', 0), load('second', 40)]);
    expect(result).toEqual({ account: 'second', reason: null });
  });

  it('исчерпанный лимит закреплённого не передаёт лида другому', () => {
    // Иначе фоллоу-ап придёт с другого аккаунта, и для человека это два
    // незнакомца с одинаковым текстом.
    const result = pickAccount('main', [load('main', 45, 0), load('second', 0, 45)]);
    expect(result).toEqual({ account: null, reason: 'assigned_exhausted' });
  });

  it('отключённый закреплённый аккаунт — отказ, а не подмена', () => {
    const result = pickAccount('second', [load('main', 0)]);
    expect(result).toEqual({ account: null, reason: 'assigned_missing' });
  });
});

describe('pickAccount: новый лид', () => {
  it('без потолка раскладывает по числу отправленного, а не всегда на первый', () => {
    // SEND_MAX_PER_DAY=0 по умолчанию: остаток у всех одинаково огромный.
    // Выбор по остатку молча свёлся бы к «всегда main».
    expect(pickAccount(null, [load('main', 12), load('second', 3)])).toEqual({ account: 'second', reason: null });
  });

  it('при равной загрузке — основной: он прогрет, второй ещё нет', () => {
    expect(pickAccount(null, [load('main', 7), load('second', 7)])).toEqual({ account: 'main', reason: null });
  });

  it('с потолком выбирает того, у кого больше осталось', () => {
    expect(
      pickAccount(null, [load('main', 40, 5), load('second', 10, 35)]),
    ).toEqual({ account: 'second', reason: null });
  });

  it('аккаунт без остатка пропускается, даже если написал меньше всех', () => {
    expect(
      pickAccount(null, [load('main', 44, 1), load('second', 0, 0)]),
    ).toEqual({ account: 'main', reason: null });
  });

  it('все исчерпаны — не отправляем', () => {
    expect(pickAccount(null, [load('main', 45, 0), load('second', 45, 0)])).toEqual({ account: null, reason: 'all_exhausted' });
  });

  it('ни одного аккаунта — не отправляем', () => {
    expect(pickAccount(null, [])).toEqual({ account: null, reason: 'all_exhausted' });
    expect(pickAccount('main', [])).toEqual({ account: null, reason: 'all_exhausted' });
  });
});

describe('describePickFailure', () => {
  it('объясняет каждую причину по-русски', () => {
    for (const reason of ['assigned_exhausted', 'assigned_missing', 'all_exhausted'] as const) {
      expect(describePickFailure(reason)).toMatch(/[а-я]/);
    }
  });
});
