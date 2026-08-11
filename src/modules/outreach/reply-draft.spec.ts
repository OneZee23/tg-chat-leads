import { classifyReply, suggestReply } from '@modules/outreach/reply-draft';

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
