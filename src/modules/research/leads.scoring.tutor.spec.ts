import {
  buildCandidates,
  detectSignals,
  REFERRAL_PROFILE,
  TUTOR_PROFILE,
  type ScoredMessage,
} from '@modules/research/leads.scoring';

const NOW = 1_757_000_000;
const DAY = 86_400;

/**
 * Профиль репетиторов: боли из живого канала репетиторов, а не «кому написать».
 *
 * Перекалибровано 14.09 по живому прогону (137 сообщений, 48 кандидатов):
 * только 34% показанных цитат давали хоть один сигнал, package_pain нёс 68%
 * всех срабатываний ЛЕКСИКОЙ ТЕМЫ (а не боли), accounting_pain не срабатывал
 * НИКОГДА, а конкурент-вендор поднимался в топ языком чужой боли. Каждый
 * паттерн ниже проверен на РЕАЛЬНОЙ цитате из живой выдачи, а не выдуман.
 */
describe('detectSignals — профиль tutor', () => {
  it('ловит прямой вопрос про инструмент — самый сильный сигнал', () => {
    expect(detectSignals('чем вести учёт занятий, посоветуйте', TUTOR_PROFILE)).toContain(
      'tool_search',
    );
    expect(
      detectSignals('какую программу посоветуете для учёта', TUTOR_PROFILE),
    ).toContain('tool_search');
    expect(detectSignals('посоветуйте приложение, пожалуйста', TUTOR_PROFILE)).toContain(
      'tool_search',
    );
    expect(detectSignals('а в чём ведёте расписание?', TUTOR_PROFILE)).toContain(
      'tool_search',
    );
  });

  it('НЕ ловит методический вопрос с «программой» — омоним, @lead_d 34.0', () => {
    // «По каким лучше учебникам пройти программу началки?» — учебная
    // программа, не софт для учёта. tool_search требует структуры «какую
    // программу посоветуете/выберите», а не голого слова.
    expect(
      detectSignals('По каким лучше учебникам пройти программу началки?', TUTOR_PROFILE),
    ).not.toContain('tool_search');
  });

  describe('accounting_pain', () => {
    it('ловит разлёт учёта по «веду» + носитель — реальные цитаты 14.09', () => {
      // @lead_b, 47.0 в старой выдаче — «веду» и «эксель» в разных
      // предложениях одного сообщения, не смежно.
      expect(
        detectSignals(
          'Я сама веду. Скачала офиц бланк, он в эксель. Такую же табличку с оплатами я вела и раньше, чисто для себя',
          TUTOR_PROFILE,
        ),
      ).toContain('accounting_pain');
      // @lead_c, 4.8 в старой выдаче — расписание/оплаты +
      // эксель/блокнот, тоже в разных клаузах.
      expect(
        detectSignals(
          'У меня расписание а Экселе, а оплаты в блокноте. Регулярно кто-то оплачивает не сразу... в группах абонементы',
          TUTOR_PROFILE,
        ),
      ).toContain('accounting_pain');
    });

    it('ловит старые узкие идиомы без изменений', () => {
      expect(detectSignals('забыла, кто платил в этом месяце', TUTOR_PROFILE)).toContain(
        'accounting_pain',
      );
      expect(
        detectSignals('потеряла учёт кто сколько занимался', TUTOR_PROFILE),
      ).toContain('accounting_pain');
    });

    it('НЕ ловит голое «веду» без объекта учёта — омоним «преподаю», @lead_a 23.2', () => {
      expect(
        detectSignals(
          'И я веду его сразу по какой-то программе, чтоб у ученика было ощущение старта',
          TUTOR_PROFILE,
        ),
      ).not.toContain('accounting_pain');
    });

    it('НЕ ловит человека вне темы репетиторства — @lead_f', () => {
      expect(
        detectSignals(
          'Я тоже в бьюти работаю, и начала со ставки чуть ниже рынка',
          TUTOR_PROFILE,
        ),
      ).not.toContain('accounting_pain');
    });
  });

  describe('payment_pain', () => {
    it('ловит боль с деньгами', () => {
      expect(
        detectSignals('не помню, кто сколько должен за месяц', TUTOR_PROFILE),
      ).toContain('payment_pain');
      expect(detectSignals('у него долг за три занятия', TUTOR_PROFILE)).toContain(
        'payment_pain',
      );
      expect(
        detectSignals('ученик не заплатил уже второй месяц', TUTOR_PROFILE),
      ).toContain('payment_pain');
      expect(detectSignals('мама забыла оплатить занятие', TUTOR_PROFILE)).toContain(
        'payment_pain',
      );
    });

    it('ловит реальную формулировку из @lead_e — не знает, кто сколько заплатил', () => {
      expect(
        detectSignals(
          'Я знаю, сколько денег заплатили за занятия с конкретным учеником. Но не знаю, сколько заплатил конкретный родитель.',
          TUTOR_PROFILE,
        ),
      ).toContain('payment_pain');
    });

    it('НЕ ловит голое «не заплатили» без контекста — @lead_a 23.2', () => {
      // «чтоб Профи не подумал, что вы за деньги что-то сделали и ему не
      // заплатили» — совет про площадку Профи, а не жалоба на учёт оплат
      // своих учеников. Без объекта (месяц/раз/занятие) рядом это не боль.
      expect(
        detectSignals(
          'Нужно указать, чтоб Профи не подумал, что вы за деньги что-то сделали и ему не заплатили',
          TUTOR_PROFILE,
        ),
      ).not.toContain('payment_pain');
    });

    it('НЕ ловит голое упоминание «долгов» в списке фич чужого продукта — @vendor_a', () => {
      expect(
        detectSignals(
          'Учёт оплат, долгов, абонементов. Книга учёта с выгрузкой в Excel',
          TUTOR_PROFILE,
        ),
      ).not.toContain('payment_pain');
    });
  });

  describe('package_pain', () => {
    it('ловит жалобные конструкции, а не голые слова темы', () => {
      expect(
        detectSignals('беру предоплату, но путаюсь в остатках', TUTOR_PROFILE),
      ).toContain('package_pain');
      expect(
        detectSignals('никогда не помню, сколько занятий осталось', TUTOR_PROFILE),
      ).toContain('package_pain');
      expect(detectSignals('запутался с абонементами совсем', TUTOR_PROFILE)).toContain(
        'package_pain',
      );
    });

    it('ловит «оплачивает не сразу» из @lead_c', () => {
      expect(
        detectSignals(
          'Регулярно кто-то оплачивает не сразу... в группах абонементы',
          TUTOR_PROFILE,
        ),
      ).toContain('package_pain');
    });

    it('НЕ ловит нейтральное упоминание пакета/абонемента без жалобы — @lead_a', () => {
      expect(
        detectSignals(
          'Я таким ввожу абонемент, а дальше они могут и не ходить.',
          TUTOR_PROFILE,
        ),
      ).not.toContain('package_pain');
    });

    it('НЕ ловит «предоплата» как тему разговора о доходе — @lead_f 7.9', () => {
      // «чтобы это был доход именно за месяц, не за счёт предоплат» — речь
      // о структуре дохода, не о путанице в учёте.
      expect(
        detectSignals(
          'чтобы это был доход именно за месяц, не за счёт предоплат',
          TUTOR_PROFILE,
        ),
      ).not.toContain('package_pain');
    });
  });

  describe('cancellation_pain', () => {
    it('ловит отмены и переносы', () => {
      expect(
        detectSignals('клиент отменил занятие за час до начала', TUTOR_PROFILE),
      ).toContain('cancellation_pain');
      expect(
        detectSignals('ученик просто не пришёл на занятие', TUTOR_PROFILE),
      ).toContain('cancellation_pain');
      expect(detectSignals('не предупредил об отмене вообще', TUTOR_PROFILE)).toContain(
        'cancellation_pain',
      );
      expect(
        detectSignals('постоянные переносы занятий выбивают из графика', TUTOR_PROFILE),
      ).toContain('cancellation_pain');
    });

    it('НЕ ловит риторический вопрос про перенос без жалобы — @lead_d 34.0', () => {
      expect(
        detectSignals(
          'Неудобно, если вдруг перенос занятия, то все, другая стоимость?!',
          TUTOR_PROFILE,
        ),
      ).not.toContain('cancellation_pain');
    });
  });

  it('ловит забывчивость учеников', () => {
    expect(detectSignals('все постоянно забывают про занятие', TUTOR_PROFILE)).toContain(
      'reminder_pain',
    );
    expect(
      detectSignals('напоминаю каждому вручную перед уроком', TUTOR_PROFILE),
    ).toContain('reminder_pain');
    expect(
      detectSignals('приходится писать каждому за день до занятия', TUTOR_PROFILE),
    ).toContain('reminder_pain');
  });

  it('ловит масштаб как усиливающий сигнал', () => {
    expect(detectSignals('у меня 15 учеников сейчас', TUTOR_PROFILE)).toContain('scale');
    expect(detectSignals('набрала группу за неделю', TUTOR_PROFILE)).toContain('scale');
    expect(
      detectSignals('у меня полная запись на месяц вперёд', TUTOR_PROFILE),
    ).toContain('scale');
  });

  it('ловит школу как отдельный сегмент, не как штраф', () => {
    const signals = detectSignals(
      'у нас своя школа, и я веду учёт в тетради, постоянно путаюсь',
      TUTOR_PROFILE,
    );
    expect(signals).toContain('school');
    expect(signals).toContain('accounting_pain');
  });

  it('ловит языковой центр и множественных преподавателей как school', () => {
    expect(
      detectSignals('у нас языковой центр с пятью группами', TUTOR_PROFILE),
    ).toContain('school');
    expect(
      detectSignals('у нас два преподавателя на все группы', TUTOR_PROFILE),
    ).toContain('school');
  });

  it('ловит рекламу своих услуг — отрицательный сигнал', () => {
    expect(detectSignals('ищу учеников на английский с нуля', TUTOR_PROFILE)).toContain(
      'self_promo',
    );
    expect(detectSignals('есть свободные окна на этой неделе', TUTOR_PROFILE)).toContain(
      'self_promo',
    );
    expect(detectSignals('запись открыта, пишите в лс', TUTOR_PROFILE)).toContain(
      'self_promo',
    );
  });

  it('ловит клиента, а не преподавателя — отрицательный сигнал', () => {
    expect(
      detectSignals('ищу репетитора по математике для сына', TUTOR_PROFILE),
    ).toContain('student_side');
    expect(
      detectSignals('посоветуйте преподавателя английского для ребёнка', TUTOR_PROFILE),
    ).toContain('student_side');
    expect(
      detectSignals('нужен репетитор на подготовку к экзамену', TUTOR_PROFILE),
    ).toContain('student_side');
  });

  describe('vendor', () => {
    it('ловит конкурента, продающего свой продукт — реальные цитаты @vendor_a 38.8', () => {
      expect(
        detectSignals(
          'Коллеги, вот расписание, которое работает из тг. Учёт оплат, долгов, абонементов. Книга учёта с выгрузкой в Excel и квитанции об оплате.',
          TUTOR_PROFILE,
        ),
      ).toContain('vendor');
      expect(
        detectSignals(
          'Пока планирую такие функции: ставить отметку об оплате с автовнесением в книгу учёта доходов и отсылкой чека родителю.',
          TUTOR_PROFILE,
        ),
      ).toContain('vendor');
    });

    it('ловит общие маркеры продвижения своего сервиса/бота', () => {
      expect(detectSignals('сделал бота для расписания', TUTOR_PROFILE)).toContain(
        'vendor',
      );
      expect(detectSignals('мой сервис уже всё делает за вас', TUTOR_PROFILE)).toContain(
        'vendor',
      );
    });
  });

  it('фраза-приманка «я репетитор» сама по себе не даёт сигналов', () => {
    expect(
      detectSignals('я репетитор английского языка, работаю уже пять лет', TUTOR_PROFILE),
    ).toEqual([]);
  });

  it('не выдумывает сигналы на пустом трёпе', () => {
    expect(detectSignals('да, согласна, спасибо большое', TUTOR_PROFILE)).toEqual([]);
  });
});

describe('buildCandidates — профиль tutor', () => {
  const message = (over: Partial<ScoredMessage>): ScoredMessage => ({
    author: '@someone',
    text: 'обычное сообщение о занятиях',
    date: NOW - DAY,
    link: null,
    ...over,
  });

  it('поднимает того, кто прямо спрашивает инструмент', () => {
    const result = buildCandidates(
      [
        message({ author: '@talker', text: 'да, у меня тоже так бывает иногда' }),
        message({ author: '@asker', text: 'чем вести учёт занятий, посоветуйте' }),
      ],
      NOW,
      TUTOR_PROFILE,
    );
    expect(result[0].author).toBe('@asker');
    expect(result[0].score).toBeGreaterThan(0);
  });

  it('самопромо уходит вниз, даже если человек активно пишет', () => {
    const result = buildCandidates(
      [
        message({
          author: '@promo',
          text: 'ищу учеников на английский, есть свободные окна',
        }),
        message({ author: '@pain', text: 'веду учёт в тетради и постоянно путаюсь' }),
      ],
      NOW,
      TUTOR_PROFILE,
    );
    expect(result[0].author).toBe('@pain');
    // Самопромо не даёт «сильного» сигнала боли — отсечка обнуляет раньше штрафа.
    expect(result[1].score).toBe(0);
  });

  it('клиент, ищущий репетитора, уходит вниз', () => {
    const result = buildCandidates(
      [
        message({ author: '@client', text: 'ищу репетитора по математике для сына' }),
        message({ author: '@pro', text: 'у него долг за три занятия, забыл оплатить' }),
      ],
      NOW,
      TUTOR_PROFILE,
    );
    expect(result[0].author).toBe('@pro');
    expect(result[1].score).toBe(0);
  });

  it('школа не отсеивается: с болью рядом остаётся кандидатом с меткой school', () => {
    const result = buildCandidates(
      [
        message({
          author: '@schoolowner',
          text: 'у нас своя школа, и я не помню, кто сколько должен',
        }),
      ],
      NOW,
      TUTOR_PROFILE,
    );
    expect(result).toHaveLength(1);
    expect(result[0].score).toBeGreaterThan(0);
    expect(result[0].signals).toEqual(expect.arrayContaining(['school', 'payment_pain']));
  });

  it('масштаб без боли ничего не даёт — не лид, а факт о человеке', () => {
    const result = buildCandidates(
      [message({ author: '@big', text: 'у меня 20 учеников, набрала группу' })],
      NOW,
      TUTOR_PROFILE,
    );
    expect(result[0].score).toBe(0);
  });

  it('вендор конкурента с реальным пакетом боли уходит в минус, а не в топ', () => {
    // @vendor_a, 38.8 балла в живой выдаче 13.09 — третье место, хотя
    // строит и продаёт конкурирующий продукт в том же чате.
    const result = buildCandidates(
      [
        message({
          author: '@vendor',
          text: 'Коллеги, вот расписание, которое работает из тг. Учёт оплат, долгов, абонементов. Книга учёта с выгрузкой в Excel.',
        }),
        message({
          author: '@vendor',
          text: 'Пока планирую такие функции: ставить отметку об оплате с автовнесением в книгу учёта доходов.',
        }),
        message({ author: '@real', text: 'веду учёт в тетради и постоянно путаюсь' }),
      ],
      NOW,
      TUTOR_PROFILE,
    );
    expect(result[0].author).toBe('@real');
    const vendor = result.find((c) => c.author === '@vendor');
    expect(vendor).toBeDefined();
    expect(vendor?.score).toBeLessThan(0);
  });
});

/**
 * Приёмка калибровки 14.09: шесть контрольных человек из живой выдачи
 * канала репетиторов (137 сообщений, 48 кандидатов), цитаты — из
 * scratchpad/real-quotes.txt. Порог — TUTOR_PROFILE.defaultMinScore, а не
 * произвольное число: это и есть проверяемая цель калибровки.
 */
describe('приёмка: шесть контрольных человек из живой выдачи 13.09', () => {
  const threshold = TUTOR_PROFILE.defaultMinScore as number;

  it('порог по умолчанию поднят выше нуля', () => {
    // Медиана скора в живой выдаче была 3.0, максимум 57, а порог был 0 —
    // пропускал в отчёт всё, включая чистый шум.
    expect(threshold).toBeGreaterThan(0);
  });

  it('@lead_c — идеальный целевой человек — попадает высоко', () => {
    const result = buildCandidates(
      [
        {
          author: '@lead_c',
          text: 'Индивидуально? Речь не о Марине Ш или об Ольге (не помню фамилии, тоже ученица Спивака)? Такую сумму могут заплатить только сумасшедшие за урок (ИМХО)',
          date: NOW - DAY,
          link: null,
        },
        {
          author: '@lead_c',
          text: 'У меня расписание а Экселе, а оплаты в блокноте. Регулярно кто-то оплачивает не сразу... в группах абонементы',
          date: NOW - DAY,
          link: null,
        },
      ],
      NOW,
      TUTOR_PROFILE,
    );
    expect(result).toHaveLength(1);
    expect(result[0].score).toBeGreaterThanOrEqual(threshold);
    expect(result[0].signals).toEqual(
      expect.arrayContaining(['accounting_pain', 'package_pain']),
    );
  });

  it('@lead_b — ведёт учёт сама в экселе — попадает высоко', () => {
    const result = buildCandidates(
      [
        {
          author: '@lead_b',
          text: 'Я сама веду. Скачала офиц бланк, он в эксель. Такую же табличку с оплатами я вела и раньше, чисто для себя',
          date: NOW - DAY,
          link: null,
        },
      ],
      NOW,
      TUTOR_PROFILE,
    );
    expect(result).toHaveLength(1);
    expect(result[0].score).toBeGreaterThanOrEqual(threshold);
    expect(result[0].signals).toContain('accounting_pain');
  });

  it('@vendor_a — конкурент — выпадает по сигналу vendor', () => {
    const result = buildCandidates(
      [
        {
          author: '@vendor_a',
          text: 'Коллеги, вот расписание, которое работает из тг. Учёт оплат, долгов, абонементов. Книга учёта с выгрузкой в Excel и квитанции об оплате.',
          date: NOW - DAY,
          link: null,
        },
        {
          author: '@vendor_a',
          text: 'Пока планирую такие функции: ставить отметку об оплате с автовнесением в книгу учёта доходов и отсылкой чека родителю.',
          date: NOW - DAY,
          link: null,
        },
      ],
      NOW,
      TUTOR_PROFILE,
    );
    expect(result).toHaveLength(1);
    expect(result[0].signals).toContain('vendor');
    expect(result[0].score).toBeLessThan(threshold);
  });

  it('@lead_a — омоним «веду» = преподаю — выпадает', () => {
    const result = buildCandidates(
      [
        {
          author: '@lead_a',
          text: 'Я таким ввожу абонемент, а дальше они могут и не ходить. Если не соглашаются, то да, идут лесом',
          date: NOW - DAY,
          link: null,
        },
        {
          author: '@lead_a',
          text: 'Нужно указать, чтоб Профи не подумал, что вы за деньги что-то сделали и ему не заплатили',
          date: NOW - DAY,
          link: null,
        },
        {
          author: '@lead_a',
          text: 'И я веду его сразу по какой-то программе, чтоб у ученика было ощущение старта. Мне кажется, что проводить необучающий первый урок неправильно.',
          date: NOW - DAY,
          link: null,
        },
      ],
      NOW,
      TUTOR_PROFILE,
    );
    expect(result).toHaveLength(1);
    expect(result[0].score).toBeLessThan(threshold);
    expect(result[0].score).toBe(0);
  });

  it('@lead_d — омоним «программа» = учебная программа — выпадает', () => {
    const result = buildCandidates(
      [
        {
          author: '@lead_d',
          text: 'Неудобно, если вдруг перенос занятия, то все, другая стоимость?!',
          date: NOW - DAY,
          link: null,
        },
        {
          author: '@lead_d',
          text: 'Добрый день! У меня впервые такое, что ученик в 8 классе 4 разделить на 2 не может. По каким лучше учебникам пройти программу началки?',
          date: NOW - DAY,
          link: null,
        },
      ],
      NOW,
      TUTOR_PROFILE,
    );
    expect(result).toHaveLength(1);
    expect(result[0].score).toBeLessThan(threshold);
    expect(result[0].score).toBe(0);
  });

  it('@lead_f — вообще не преподаватель — выпадает', () => {
    const result = buildCandidates(
      [
        {
          author: '@lead_f',
          text: 'Есть люди, у которых есть возможность заплатить, но они экономят, продавливают скидку, это как развлечение такое. Я тоже в бьюти работаю, и начала со ставки чуть ниже рынка',
          date: NOW - DAY,
          link: null,
        },
        {
          author: '@lead_f',
          text: 'Прям моя мечта получить миллион за месяц, думаю, что не обязательно на репетиторстве, и так, чтобы это был доход именно за месяц, не за счёт предоплат.',
          date: NOW - DAY,
          link: null,
        },
      ],
      NOW,
      TUTOR_PROFILE,
    );
    expect(result).toHaveLength(1);
    expect(result[0].score).toBeLessThan(threshold);
    expect(result[0].score).toBe(0);
  });
});

describe('визовый профиль не изменился', () => {
  const VISA_EXAMPLES = [
    'могу зарефералить, пишите в лс',
    'у нас есть referral бонус',
    'ищем сеньора в команду платежей',
    'мы нанимаем бэкендеров',
    'я работаю в Zalando уже два года',
    'у нас в компании такого нет',
    'я переехал в Берлин в прошлом году',
    'получил Blue Card за четыре месяца',
    'пишем на NestJS и TypeScript',
    'сейчас мало кто нанимает джунов',
    'их HR ответил через неделю',
    'я рекрутер, помогаю с релокацией',
    'мне бы кто помог контактами рекрутёров и рефералками',
    'мне бы кто помог с поиском',
    'я от безработицы страдаю уже полгода',
    'we are hiring a backend engineer',
    'happy to refer you, send me your CV',
    'да, согласен, спасибо большое',
  ];

  it('detectSignals без профиля даёт ровно то же, что и с явным REFERRAL_PROFILE', () => {
    for (const text of VISA_EXAMPLES) {
      expect(detectSignals(text)).toEqual(detectSignals(text, REFERRAL_PROFILE));
    }
  });

  it('buildCandidates без профиля даёт тот же скор, что и с явным REFERRAL_PROFILE', () => {
    const messages: ScoredMessage[] = VISA_EXAMPLES.map((text, i) => ({
      author: `@visa${i}`,
      text,
      date: NOW - DAY,
      link: null,
    }));
    const withoutProfile = buildCandidates(messages, NOW);
    const withProfile = buildCandidates(messages, NOW, REFERRAL_PROFILE);
    expect(withoutProfile).toEqual(withProfile);
  });

  it('REFERRAL_PROFILE.defaultMinScore не задан — общий порог не трогали', () => {
    expect(REFERRAL_PROFILE.defaultMinScore).toBeUndefined();
  });
});
