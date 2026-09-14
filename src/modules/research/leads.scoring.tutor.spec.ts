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
 * Профиль репетиторов: боли из @канала репетиторов, а не «кому написать». Каждый
 * положительный сигнал проверен на реалистичной формулировке из ТЗ, оба
 * отрицательных — что уводят кандидата вниз, а `school` — что не отсеивает.
 */
describe('detectSignals — профиль tutor', () => {
  it('ловит прямой вопрос про инструмент — самый сильный сигнал', () => {
    expect(detectSignals('чем вести учёт занятий, посоветуйте', TUTOR_PROFILE)).toContain(
      'tool_search',
    );
    expect(detectSignals('какую программу посоветуете для учёта', TUTOR_PROFILE)).toContain(
      'tool_search',
    );
    expect(detectSignals('посоветуйте приложение, пожалуйста', TUTOR_PROFILE)).toContain(
      'tool_search',
    );
    expect(detectSignals('а в чём ведёте расписание?', TUTOR_PROFILE)).toContain(
      'tool_search',
    );
  });

  it('ловит развал учёта', () => {
    expect(detectSignals('веду всё в тетради, уже путаюсь', TUTOR_PROFILE)).toContain(
      'accounting_pain',
    );
    expect(detectSignals('веду в экселе, но неудобно', TUTOR_PROFILE)).toContain(
      'accounting_pain',
    );
    expect(detectSignals('совсем запуталась с расписанием', TUTOR_PROFILE)).toContain(
      'accounting_pain',
    );
    expect(detectSignals('забыла, кто платил в этом месяце', TUTOR_PROFILE)).toContain(
      'accounting_pain',
    );
    expect(detectSignals('потеряла учёт кто сколько занимался', TUTOR_PROFILE)).toContain(
      'accounting_pain',
    );
  });

  it('ловит боль с деньгами', () => {
    expect(detectSignals('не помню, кто сколько должен за месяц', TUTOR_PROFILE)).toContain(
      'payment_pain',
    );
    expect(detectSignals('у него долг за три занятия', TUTOR_PROFILE)).toContain(
      'payment_pain',
    );
    expect(detectSignals('ученик не заплатил уже второй месяц', TUTOR_PROFILE)).toContain(
      'payment_pain',
    );
    expect(detectSignals('мама забыла оплатить занятие', TUTOR_PROFILE)).toContain(
      'payment_pain',
    );
  });

  it('ловит путаницу с пакетами и предоплатой', () => {
    expect(detectSignals('продаю пакет занятий на месяц', TUTOR_PROFILE)).toContain(
      'package_pain',
    );
    expect(detectSignals('у нас абонемент на 8 занятий', TUTOR_PROFILE)).toContain(
      'package_pain',
    );
    expect(detectSignals('беру предоплату, но путаюсь в остатках', TUTOR_PROFILE)).toContain(
      'package_pain',
    );
    expect(detectSignals('никогда не помню, сколько занятий осталось', TUTOR_PROFILE)).toContain(
      'package_pain',
    );
  });

  it('ловит отмены и переносы', () => {
    expect(detectSignals('клиент отменил занятие за час до начала', TUTOR_PROFILE)).toContain(
      'cancellation_pain',
    );
    expect(detectSignals('ученик просто не пришёл на занятие', TUTOR_PROFILE)).toContain(
      'cancellation_pain',
    );
    expect(detectSignals('не предупредил об отмене вообще', TUTOR_PROFILE)).toContain(
      'cancellation_pain',
    );
    expect(detectSignals('постоянные переносы занятий выбивают из графика', TUTOR_PROFILE)).toContain(
      'cancellation_pain',
    );
  });

  it('ловит забывчивость учеников', () => {
    expect(detectSignals('все постоянно забывают про занятие', TUTOR_PROFILE)).toContain(
      'reminder_pain',
    );
    expect(detectSignals('напоминаю каждому вручную перед уроком', TUTOR_PROFILE)).toContain(
      'reminder_pain',
    );
    expect(detectSignals('приходится писать каждому за день до занятия', TUTOR_PROFILE)).toContain(
      'reminder_pain',
    );
  });

  it('ловит масштаб как усиливающий сигнал', () => {
    expect(detectSignals('у меня 15 учеников сейчас', TUTOR_PROFILE)).toContain('scale');
    expect(detectSignals('набрала группу за неделю', TUTOR_PROFILE)).toContain('scale');
    expect(detectSignals('у меня полная запись на месяц вперёд', TUTOR_PROFILE)).toContain(
      'scale',
    );
  });

  it('ловит школу как отдельный сегмент, не как штраф', () => {
    const signals = detectSignals(
      'у нас своя школа, и я запуталась в оплатах учеников',
      TUTOR_PROFILE,
    );
    expect(signals).toContain('school');
    expect(signals).toContain('accounting_pain');
  });

  it('ловит языковой центр и множественных преподавателей как school', () => {
    expect(detectSignals('у нас языковой центр с пятью группами', TUTOR_PROFILE)).toContain(
      'school',
    );
    expect(detectSignals('у нас два преподавателя на все группы', TUTOR_PROFILE)).toContain(
      'school',
    );
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
    expect(detectSignals('ищу репетитора по математике для сына', TUTOR_PROFILE)).toContain(
      'student_side',
    );
    expect(
      detectSignals('посоветуйте преподавателя английского для ребёнка', TUTOR_PROFILE),
    ).toContain('student_side');
    expect(detectSignals('нужен репетитор на подготовку к экзамену', TUTOR_PROFILE)).toContain(
      'student_side',
    );
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
        message({ author: '@pain', text: 'веду в тетради и постоянно путаюсь' }),
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
});
