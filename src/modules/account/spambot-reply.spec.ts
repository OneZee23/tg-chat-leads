import { parseSpamBotReply } from '@modules/account/spambot-reply';

describe('parseSpamBotReply', () => {
  it('распознаёт снятое ограничение', () => {
    const status = parseSpamBotReply(
      "Good news, no limits are currently applied to your account. You're free as a bird!",
    );

    expect(status.limited).toBe(false);
    expect(status.until).toBeNull();
  });

  it('распознаёт ограничение и дату снятия — реальный ответ от 08.08.2026', () => {
    const status = parseSpamBotReply(
      "Dear OneZee, I'm afraid some Telegram users found your messages annoying and " +
        'forwarded them to our team of moderators for inspection. The moderators have ' +
        'confirmed the report and your account is now limited until 8 Aug 2026, 15:59 UTC.',
    );

    expect(status.limited).toBe(true);
    expect(status.until?.toISOString()).toBe('2026-08-08T15:59:00.000Z');
  });

  it('берёт дату именно как UTC, а не как местное время', () => {
    const status = parseSpamBotReply(
      'your account is now limited until 1 Jan 2027, 09:05 UTC',
    );

    expect(status.until?.getUTCHours()).toBe(9);
    expect(status.until?.getUTCMinutes()).toBe(5);
  });

  it('понимает формулировку про снятие ограничений', () => {
    const status = parseSpamBotReply(
      'Please wait, the limitations will be lifted from your account on 12 Dec 2026, 03:00 UTC.',
    );

    expect(status.limited).toBe(true);
    expect(status.until?.toISOString()).toBe('2026-12-12T03:00:00.000Z');
  });

  it('считает ограничением сообщение без даты', () => {
    const status = parseSpamBotReply('Your account is limited.');

    expect(status.limited).toBe(true);
    expect(status.until).toBeNull();
  });

  it('понимает русскую локализацию', () => {
    expect(
      parseSpamBotReply('Ваш аккаунт ограничен до особого распоряжения').limited,
    ).toBe(true);
    expect(parseSpamBotReply('Хорошие новости, нет никаких ограничений!').limited).toBe(
      false,
    );
  });

  it('распознаёт реальный русский ответ «свободен» от 09.08.2026', () => {
    // Этой формулировки в списке не было, и проверка блокировала отправку
    // на ровном месте, отвечая «не разобрал».
    const status = parseSpamBotReply('Ваш аккаунт свободен от каких-либо ограничений.');

    expect(status.limited).toBe(false);
    expect(status.until).toBeNull();
  });

  it('русское «свободен» не путается с русским «ограничен»', () => {
    expect(parseSpamBotReply('Ваш аккаунт свободен от ограничений').limited).toBe(false);
    expect(
      parseSpamBotReply('Ваш аккаунт ограничен до 10 Aug 2026, 12:00 UTC').limited,
    ).toBe(true);
  });

  it('на непонятный ответ отдаёт null, а не «всё хорошо»', () => {
    // Различать «не ограничен» и «не понял» критично: во втором случае
    // отправлять нельзя, пока человек не посмотрит сам.
    expect(parseSpamBotReply('Send /start if you need me again.').limited).toBeNull();
    expect(parseSpamBotReply('').limited).toBeNull();
    expect(parseSpamBotReply(null as unknown as string).limited).toBeNull();
  });

  it('не путается, когда в тексте про ограничение мелькает слово limits', () => {
    const status = parseSpamBotReply(
      'While the account is limited, you will not be able to do certain things. ' +
        'Your account will be automatically released on 9 Aug 2026, 10:00 UTC.',
    );

    expect(status.limited).toBe(true);
  });
});

describe('живые ответы @SpamBot, на которых разбор ломался', () => {
  // Дословный текст от 10.09.2026. Подстрочные маркеры промахивались на
  // одно вставленное слово: «временно» и «автоматически». Разбор возвращал
  // «не понял», хотя аккаунт был реально ограничен.
  const RU_LIMITED = [
    'Здравствуйте, OneZee. К сожалению, кто-то из пользователей Телеграма посчитал',
    'Ваши сообщения нежелательными и переслал их на проверку команде модераторов.',
    'Модераторы подтвердили, что жалоба была обоснованной.',
    '',
    'Ваш аккаунт временно ограничен: Вы не можете писать тем, кто не сохранил Ваш',
    'номер в список контактов, а также приглашать таких пользователей в группы или каналы.',
    '',
    'Ограничения будут автоматически сняты 11 Sep 2026, 04:28 UTC (по московскому',
    'времени — на три часа позже).',
  ].join('\n');

  it('русское «временно ограничен» распознаётся как ограничение', () => {
    const r = parseSpamBotReply(RU_LIMITED);
    expect(r.limited).toBe(true);
  });

  it('из него же вынимается дата снятия', () => {
    const r = parseSpamBotReply(RU_LIMITED);
    expect(r.until?.toISOString()).toBe('2026-09-11T04:28:00.000Z');
  });

  it('английское «free as a bird» по-прежнему читается как свобода', () => {
    const r = parseSpamBotReply(
      'Good news, no limits are currently applied to your account. You\u2019re free as a bird!',
    );
    expect(r.limited).toBe(false);
  });

  it('пустой ответ (бот не успел ответить) — это «не понял», а не «свободен»', () => {
    expect(parseSpamBotReply('').limited).toBeNull();
  });
});
