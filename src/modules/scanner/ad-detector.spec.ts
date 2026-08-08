import { AdDetector } from '@modules/scanner/ad-detector';

const detector = new AdDetector({ minScore: 3 });

describe('AdDetector', () => {
  it('ловит классическое объявление репетитора', () => {
    const result = detector.detect(
      'Репетитор английского языка, набираю учеников на осень. 1500 руб/час, пишите в лс',
    );

    expect(result.isAd).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(4);
    expect(result.keywords).toContain('job:репетитор');
  });

  it('ловит преподавателя вокала — ниша, ради которой всё и затевалось', () => {
    const result = detector.detect(
      'Преподаватель по вокалу. Провожу индивидуальные занятия онлайн и офлайн, ' +
        'первое занятие пробное. Стоимость 2000 руб. Записаться можно в личку',
    );

    expect(result.isAd).toBe(true);
    expect(result.keywords).toContain('job:преподавател');
  });

  it('обнуляет тех, кто ИЩЕТ преподавателя, а не предлагает себя', () => {
    const result = detector.detect(
      'Ищу репетитора по английскому для дочки, 7 класс. Бюджет 1500 руб за час, пишите в лс',
    );

    expect(result.isAd).toBe(false);
    expect(result.score).toBe(0);
    expect(result.keywords).toEqual(['stop:ищу репетитор']);
  });

  it('обнуляет вакансии от школ — это работодатель, а не наш клиент', () => {
    const result = detector.detect(
      'Вакансия: требуется преподаватель английского в нашу школу. Оплата 2000 руб/час',
    );

    expect(result.isAd).toBe(false);
  });

  it('не считает рекламой обычный разговор', () => {
    expect(detector.detect('Спасибо, очень полезно!').isAd).toBe(false);
    expect(detector.detect('А кто-нибудь пробовал такое?').isAd).toBe(false);
  });

  it('одной профессии без предложения и контактов не хватает', () => {
    const result = detector.detect('Я тоже преподаватель');

    expect(result.score).toBe(2);
    expect(result.isAd).toBe(false);
  });

  it('нормализует ё и регистр, иначе стоп-слова мимо', () => {
    const result = detector.detect('ИЩУ ПЕДАГОГА по вокалу, 2000 руб, пишите');

    expect(result.isAd).toBe(false);
    expect(result.keywords[0]).toBe('stop:ищу педагог');
  });

  it('видит контакт по @нику, даже если слов «пишите» нет', () => {
    const result = detector.detect('Репетитор по математике, ОГЭ и ЕГЭ. @some_tutor');

    expect(result.keywords).toContain('contact:@nick');
    expect(result.isAd).toBe(true);
  });

  it('видит контакт по ссылке t.me', () => {
    const result = detector.detect(
      'Занятия по гитаре, подробности тут https://t.me/guitar_lessons',
    );

    expect(result.keywords.some((k) => k.startsWith('contact:'))).toBe(true);
  });

  it('не принимает год или цену за телефон', () => {
    const result = detector.detect('Занимаюсь с 2019 года, стоимость 1500');

    expect(result.keywords).not.toContain('contact:phone');
  });

  it('пустая строка не падает', () => {
    expect(detector.detect('')).toEqual({ score: 0, isAd: false, keywords: [] });
    expect(detector.detect(null as unknown as string).isAd).toBe(false);
  });

  it('учитывает дополнительные ключевые слова из конфига', () => {
    const custom = new AdDetector({ minScore: 3, extraKeywords: ['сноуборд'] });
    const result = custom.detect('Инструктор по сноуборду, набираю группу, 3000 руб');

    expect(result.keywords).toContain('job:сноуборд');
    expect(result.isAd).toBe(true);
  });

  it('учитывает дополнительные стоп-слова из конфига', () => {
    const custom = new AdDetector({
      minScore: 3,
      extraStopWords: ['партнёрская программа'],
    });
    const result = custom.detect(
      'Партнёрская программа для репетиторов, набираем, доход 50000 руб, пишите в лс',
    );

    expect(result.isAd).toBe(false);
  });

  it('порог настраивается', () => {
    const strict = new AdDetector({ minScore: 6 });

    expect(
      strict.detect('Репетитор английского, набираю, 1500 руб, пишите в лс').isAd,
    ).toBe(false);
  });
});
