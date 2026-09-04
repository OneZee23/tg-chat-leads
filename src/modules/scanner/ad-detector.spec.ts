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

describe('AdDetector: стоп-паттерны, измеренные на корпусе', () => {
  // Измерение: docs/2026-09-04-lead-scoring-measurement.md
  // Литеральные стоп-слова пропускали эти формы, а все они — не частные
  // преподаватели: работодатели, школы, конкуренты и биржи заявок.

  it('работодатель со вставленными словами: «ищу двух репетиторов»', () => {
    // Литеральное «ищу репетитор» такое не ловит — между словами вставка.
    expect(detector.detect('Ищу двух репетиторов по математике. Ставка от 700 руб').isAd).toBe(
      false,
    );
    expect(detector.detect('Ищу крутого преподавателя английского в команду').isAd).toBe(false);
  });

  it('школа рассказывает о себе, а не преподаватель о себе', () => {
    // Текст длинный, с ценой и контактом — без стоп-паттерна он наберёт
    // проходной балл, как настоящее объявление.
    expect(
      detector.detect(
        'Мы — онлайн-школа INTELLECTICA. Набираем учеников на курсы по математике ' +
          'и английскому языку, занятия с опытными преподавателями, подготовка к ЕГЭ. ' +
          'Стоимость занятия от 1200 руб. Записаться: @intellectica_school',
      ).isAd,
    ).toBe(false);
    expect(
      detector.detect(
        'Здравствуйте! Я менеджер онлайн-школы OsviTech. Приглашаем на занятия по ' +
          'программированию и математике для школьников, первый урок бесплатно, ' +
          'дальше 1500 руб за урок. Пишите @osvitech_manager',
      ).isAd,
    ).toBe(false);
  });

  it('но «работала в онлайн-школе» — это живой репетитор, его не трогаем', () => {
    // Голое «онлайн-школ» матчило бы 43 объявления корпуса, из них
    // большинство — обычные репетиторы. Потеря ~40 живых лидов ради двух.
    const r = detector.detect(
      'Репетитор по химии, 5 лет работала в онлайн-школе, теперь веду сама. 1500 руб, @nick',
    );
    expect(r.isAd).toBe(true);
  });

  it('продают репетиторам, а не преподают — включая прямых конкурентов', () => {
    // Реальная находка разбора: в этих же чатах рекламируется конкурент.
    expect(
      detector.detect(
        'RepDesk — сервис для репетиторов: ученики, расписание, оплаты и долги ' +
          'в одном месте, напоминания в телеграм. 14 дней бесплатно, дальше 790 руб ' +
          'в месяц. Попробовать: repdesk.ru или пишите @repdesk_support',
      ).isAd,
    ).toBe(false);
    expect(
      detector.detect(
        'Запустил приложение-планировщик для репетиторов: все ученики, расписание, ' +
          'оплаты. Делал сам, для преподавателей английского и математики. ' +
          'Бесплатно на старте, потом 500 руб. Пишите @planner_dev',
      ).isAd,
    ).toBe(false);
  });

  it('спрос-пост биржи заявок', () => {
    expect(
      detector.detect('#Актуальная заявка. Пол ученика: девушка. Предмет: химия. Цена 1500').isAd,
    ).toBe(false);
  });
});
