import {
  autoReplyDecision,
  autoReplyTemplate,
  classifyReply,
  suggestReply,
} from '@modules/outreach/reply-draft';

describe('classifyReply', () => {
  it('распознаёт отказ даже с «спасибо» внутри', () => {
    expect(classifyReply('Здравствуйте! Спасибо, не интересует.')).toBe('decline');
    expect(classifyReply('Не нужно, у меня уже есть система')).toBe('decline');
  });

  it('вопрос — раньше позитива, даже когда тон тёплый', () => {
    expect(
      classifyReply('Выглядит очень удобно, есть возможность проводить занятия? Доска?'),
    ).toBe('question');
    expect(classifyReply('А это бесплатно?')).toBe('question');
  });

  it('распознаёт тёплый интерес', () => {
    expect(classifyReply('Мне кажется все отлично! Учеников набираю да')).toBe(
      'positive',
    );
    expect(classifyReply('Хорошо, я обязательно посмотрю')).toBe('positive');
    expect(classifyReply('Да хочу')).toBe('positive');
    // «Опробую» — без стема «пробу» не распознавалось.
    expect(classifyReply('Опробую')).toBe('positive');
    expect(classifyReply('я бы попробовала')).toBe('positive');
  });

  it('«не подходит» — это отказ', () => {
    expect(classifyReply('спасибо, мне не подходит')).toBe('decline');
  });

  it('отрицание позитива — отказ, а не позитив (ревью нашло на «не хочу»)', () => {
    // «не хочу» содержит «хочу», раньше сходило за позитив.
    expect(classifyReply('спасибо, не хочу')).toBe('decline');
    expect(classifyReply('не буду пробовать')).toBe('decline');
    expect(classifyReply('не очень интересно, честно')).toBe('decline');
    expect(classifyReply('мне неудобно этим пользоваться')).toBe('decline');
  });

  it('позитив без отрицания по-прежнему позитив', () => {
    expect(classifyReply('хочу попробовать')).toBe('positive');
    expect(classifyReply('интересно, гляну')).toBe('positive');
  });

  it('похвала + «не нужно» без вопроса — на ручной разбор, не отказ', () => {
    // «не нужно разбираться» — комплимент; рядом «супер, лаконично».
    // Раньше уходило в decline (холодный отказ хвалящему человеку).
    expect(
      classifyReply('платформа супер, всё удобно и лаконично, не нужно сильно разбираться'),
    ).toBe('neutral');
  });

  it('чистый отказ без похвалы остаётся отказом', () => {
    expect(classifyReply('Спасибо, не интересует данная информация')).toBe('decline');
    expect(classifyReply('мне неудобно этим пользоваться')).toBe('decline');
    expect(classifyReply('спасибо, мне это не нужно')).toBe('decline');
  });

  it('тёплый лид С ВОПРОСОМ — это вопрос, а не отказ (ревью нашло на живых)', () => {
    // Условное «не актуально» внутри интереса + вопрос: раньше уходило
    // в decline, человек получал холодный отказ на свой вопрос.
    expect(
      classifyReply('это актуально? сейчас ищу такую платформу, попробую, но если уже не актуально'),
    ).toBe('question');
    // «не нужно разбираться» — это похвала, а не отказ; плюс вопрос.
    expect(
      classifyReply('платформа супер, всё удобно, не нужно разбираться, но хотел спросить...?'),
    ).toBe('question');
  });

  it('нейтральное — когда ни отказа, ни вопроса, ни явного интереса', () => {
    expect(classifyReply('Здравствуйте')).toBe('neutral');
    expect(classifyReply('')).toBe('neutral');
  });

  it('нормализует ё', () => {
    expect(classifyReply('всё отлично, спасибо')).toBe('positive');
  });
});

describe('suggestReply', () => {
  it('на вопрос НЕ даёт готовый черновик — только флаг', () => {
    // Ключевое: шаблон на вопрос про фичу может пообещать несуществующее.
    const s = suggestReply('А доска и звонок есть?');
    expect(s.kind).toBe('question');
    expect(s.draft).toBeNull();
    expect(s.hint).toContain('сам');
  });

  it('на тёплое — онбординг со ссылкой, в тёплом тоне', () => {
    const s = suggestReply('Хочу попробовать');
    expect(s.kind).toBe('positive');
    expect(s.draft).toContain('teachtrack.ru');
    expect(s.draft).toContain('списком');
  });

  it('на отказ — вежливое закрытие и подсказка про skip', () => {
    const s = suggestReply('Спасибо, не интересует');
    expect(s.kind).toBe('decline');
    expect(s.draft).toContain('Удачи');
    expect(s.hint).toContain('skip');
  });

  it('на нейтральное — лёгкое касание со ссылкой, без канцелярита', () => {
    const s = suggestReply('Здравствуйте');
    expect(s.draft).toContain('teachtrack.ru');
    // Больше не «Ссылка — …, вход по почте».
    expect(s.draft).not.toContain('вход по почте');
  });
});

describe('autoReplyTemplate', () => {
  it('позитив → «рад что заинтересовало»', () => {
    const r = autoReplyTemplate('Опробую, спасибо');
    expect(r.kind).toBe('positive');
    expect(r.text).toContain('рад что заинтересовало');
  });

  it('отказ → «спасибо, что в любом случае ответили»', () => {
    const r = autoReplyTemplate('Спасибо, не интересует данная информация');
    expect(r.kind).toBe('decline');
    expect(r.text).toContain('в любом случае ответили');
  });

  it('вопрос → авто-ответа НЕТ (руками)', () => {
    // Критично: на вопрос про фичу шаблон соврёт.
    expect(autoReplyTemplate('А как туда зайти?').text).toBeNull();
    expect(autoReplyTemplate('это актуально ещё?').text).toBeNull();
  });

  it('нейтральное → авто-ответа НЕТ (руками)', () => {
    expect(autoReplyTemplate('Здравствуйте, я посредник, передам').text).toBeNull();
    expect(autoReplyTemplate('но я только начал').text).toBeNull();
  });

  it('голое «спасибо» — уже не позитив', () => {
    expect(classifyReply('Спасибо большое')).toBe('neutral');
    expect(classifyReply('Спасибо💜')).toBe('neutral');
    // Но «спасибо, попробую» остаётся позитивом.
    expect(classifyReply('спасибо, попробую')).toBe('positive');
  });
});

describe('autoReplyDecision', () => {
  it('позитив → отправить шаблон', () => {
    const d = autoReplyDecision('Здравствуйте, можно попробовать)');
    expect(d.action).toBe('send');
    expect(d.text).toContain('рад что заинтересовало');
  });

  it('отказ → отправить шаблон', () => {
    const d = autoReplyDecision('Спасибо, не интересует.');
    expect(d.action).toBe('send');
    expect(d.text).toContain('в любом случае ответили');
  });

  it('короткое нейтральное → закрыть без ответа', () => {
    expect(autoReplyDecision('Хорошо').action).toBe('clear');
    expect(autoReplyDecision('Спасибо большое').action).toBe('clear');
    expect(autoReplyDecision('Да набираю').action).toBe('clear');
  });

  it('вопрос → тебе', () => {
    expect(autoReplyDecision('а группы можно добавлять?').action).toBe('manual');
  });

  it('просьба дать ссылку/гайд → тебе', () => {
    const d = autoReplyDecision('Киньте ссылку и краткий гайд как учеников туда регать');
    expect(d.action).toBe('manual');
    expect(d.reason).toContain('ссылку');
  });

  it('развёрнутый фидбек → тебе, не шаблон', () => {
    const d = autoReplyDecision(
      'Прикольно, но лично мне не полезно. Что вижу докрутить: демо без регистрации, '
        + 'импорт из Excel, финансовая часть — вот тут главная дыра, нужны подписки и ставки',
    );
    expect(d.action).toBe('manual');
  });

  it('фидбек про фичу (вкладку домашки) → тебе', () => {
    const d = autoReplyDecision('я бы сделала вкладку за домашнюю работу, часто забываю задания');
    expect(d.action).toBe('manual');
  });
});
