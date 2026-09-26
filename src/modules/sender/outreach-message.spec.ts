import {
  DEFAULT_BODY,
  buildHook,
  buildOutreachMessage,
  detectSubject,
} from '@modules/sender/outreach-message';
import { SITE_LINK } from '@common/site-link';

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
  it('с предметом — персональная строка с предметом в нижнем регистре', () => {
    expect(buildHook('РЕПЕТИТОР ПО ХИМИИ')).toBe(
      'Здравствуйте! Видел, что вы набираете учеников по химии.',
    );
  });

  it('предмет НЕ капслоком, даже если в объявлении он капсом — иначе палевно', () => {
    expect(buildHook('🇬🇧 АНГЛИЙСКИЙ ЯЗЫК ДЛЯ ДЕТЕЙ')).toContain('по английскому.');
    expect(buildHook('🇬🇧 АНГЛИЙСКИЙ ЯЗЫК ДЛЯ ДЕТЕЙ')).not.toContain('АНГЛИЙСК');
  });

  it('без предмета — просто приветствие, тело всё объяснит', () => {
    expect(buildHook('просто набираю, пишите')).toBe('Здравствуйте!');
    expect(buildHook(null)).toBe('Здравствуйте!');
  });
});

describe('buildOutreachMessage', () => {
  it('склеивает хук и тело через пустую строку', () => {
    const message = buildOutreachMessage('репетитор по физике', 'Тело сообщения.');

    expect(message).toBe(
      'Здравствуйте! Видел, что вы набираете учеников по физике.\n\nТело сообщения.',
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

describe('ссылка в теле по умолчанию', () => {
  it('размечена меткой канала', () => {
    // Без метки регистрация из аутрича придёт с пустым signup_source и
    // канал будет выглядеть мёртвым.
    expect(DEFAULT_BODY).toContain(SITE_LINK);
  });
});
