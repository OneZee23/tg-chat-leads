import {
  FloodWaitTracker,
  formatLeft,
  formatClock,
} from '@modules/telegram/flood-wait.tracker';

describe('formatLeft', () => {
  it('часы и минуты для долгих', () => {
    expect(formatLeft(29194 * 1000)).toBe('8ч 6м');
  });

  it('минуты и секунды для средних', () => {
    expect(formatLeft(125 * 1000)).toBe('2м 5с');
  });

  it('секунды для коротких', () => {
    expect(formatLeft(4 * 1000)).toBe('4с');
  });

  it('не уходит в минус', () => {
    expect(formatLeft(-500)).toBe('0с');
  });
});

describe('formatClock', () => {
  it('местное HH:MM с ведущими нулями', () => {
    const d = new Date(2026, 7, 12, 9, 5);
    expect(formatClock(d)).toBe('09:05');
  });
});

describe('FloodWaitTracker', () => {
  it('запоминает лимит по методу и отдаёт остаток', () => {
    const t = new FloodWaitTracker();
    t.note('contacts.ResolveUsername', 3600);

    const limit = t.forMethod('contacts.ResolveUsername');
    expect(limit).not.toBeNull();
    expect(limit!.secondsLeft).toBeGreaterThan(3500);
    expect(limit!.secondsLeft).toBeLessThanOrEqual(3600);
    expect(limit!.human).toContain('до ');
  });

  it('держит самый поздний срок, не затирая меньшим', () => {
    const t = new FloodWaitTracker();
    t.note('X', 3600);
    t.note('X', 60); // повторный запрос вернул меньший срок
    expect(t.forMethod('X')!.secondsLeft).toBeGreaterThan(3500);
  });

  it('разные методы — разные лимиты, worst отдаёт самый долгий', () => {
    const t = new FloodWaitTracker();
    t.note('short', 100);
    t.note('long', 5000);
    expect(t.worst()!.method).toBe('long');
    expect(t.active()).toHaveLength(2);
  });

  it('истёкший лимит вычищается', () => {
    const t = new FloodWaitTracker();
    t.note('gone', 0);
    expect(t.active()).toHaveLength(0);
    expect(t.summary()).toBe('ограничений на запросы нет');
  });

  it('summary перечисляет активные', () => {
    const t = new FloodWaitTracker();
    t.note('contacts.ResolveUsername', 3600);
    expect(t.summary()).toContain('contacts.ResolveUsername');
    expect(t.summary()).toContain('ещё');
  });
});
