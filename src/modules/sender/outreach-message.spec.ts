import {
  buildHook,
  buildOutreachMessage,
  detectSubject,
} from '@modules/sender/outreach-message';

describe('detectSubject', () => {
  it('достаёт предмет из реального объявления', () => {
    expect(detectSubject('Репетитор по химии 🧪 | Подготовка к ОГЭ')).toBe('химии');
    expect(detectSubject('🇬🇧 Английский язык для детей')).toBe('английскому');
    expect(detectSubject('Индивидуальные занятия по математике и физике')).toBe(
      'математике',
    );
    expect(detectSubject('Преподаватель по вокалу, распевки')).toBe('вокалу');
  });

  it('специальный предмет важнее общего: русский как иностранный', () => {
    expect(detectSubject('русский как иностранный для взрослых')).toBe(
      'русскому как иностранному',
    );
    expect(detectSubject('репетитор по русскому языку, ОГЭ')).toBe('русскому языку');
  });

  it('нормализует ё и регистр', () => {
    expect(detectSubject('ЗАНЯТИЯ ПО СОЛЬФЕДЖИО')).toBe('сольфеджио');
  });

  it('возвращает null, когда предмет не опознан', () => {
    expect(detectSubject('Набираю учеников, пишите в лс')).toBeNull();
    expect(detectSubject(null)).toBeNull();
    expect(detectSubject('')).toBeNull();
  });
});

describe('buildHook', () => {
  it('с предметом — прицельный вопрос', () => {
    expect(buildHook('Репетитор по химии')).toBe(
      'Здравствуйте! Увидел ваше объявление — набираете учеников по химии?',
    );
  });

  it('без предмета — мягкий общий вопрос', () => {
    const hook = buildHook('просто набираю, пишите');
    expect(hook).toContain('Здравствуйте!');
    expect(hook).toContain('набираете учеников?');
  });

  it('всегда заканчивается вопросом — его проще прочитать и на него легко ответить', () => {
    expect(buildHook('химия').endsWith('?')).toBe(true);
    expect(buildHook(null).endsWith('?')).toBe(true);
  });
});

describe('buildOutreachMessage', () => {
  it('склеивает хук и тело через пустую строку', () => {
    const message = buildOutreachMessage('репетитор по физике', 'Тело сообщения.');

    expect(message).toBe(
      'Здравствуйте! Увидел ваше объявление — набираете учеников по физике?\n\nТело сообщения.',
    );
  });

  it('короткое сообщение влезает в подпись к альбому', () => {
    const message = buildOutreachMessage(
      'Английский язык для детей и подростков',
      'Я сделал бесплатный сервис для преподавателей — расписание, ученики, оплаты ' +
        'и напоминания в телеграм. Не откликнется — ничего страшного)',
    );

    // Проверяем, что не превратилось в простыню на пол-экрана.
    expect(message.length).toBeLessThan(900);
  });
});
