import {
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

  it('на тёплое — онбординг со ссылкой', () => {
    const s = suggestReply('Хочу попробовать');
    expect(s.kind).toBe('positive');
    expect(s.draft).toContain('teachtrack.ru');
    expect(s.draft).toContain('Добавить ученика');
  });

  it('на отказ — вежливое закрытие и подсказка про skip', () => {
    const s = suggestReply('Спасибо, не интересует');
    expect(s.kind).toBe('decline');
    expect(s.draft).toContain('Удачи');
    expect(s.hint).toContain('skip');
  });

  it('на нейтральное — лёгкое касание со ссылкой', () => {
    const s = suggestReply('Здравствуйте');
    expect(s.draft).toContain('teachtrack.ru');
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
});
