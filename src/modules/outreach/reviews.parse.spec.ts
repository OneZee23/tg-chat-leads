import { ReviewsParseError, parseReviews, selectPublishable } from './reviews.parse';

const FILE = `# Отзывы на 2026-09-05 14:42

Найдено: 2.

---

# Разрешение есть — 1

## id111 @vera

- имя: Вера
- ссылка: https://t.me/vera
- согласие: разрешение есть

  разговор о согласии:
    мы:  Можно я приведу вашу цитату?
    он: Да, конечно

  2026-09-04 08:55
    Всё интуитивно понятно и дизайн не отвлекает

PUBLISH

---

# Разрешения нет — 1

## id222 @petr

- имя: Пётр
- ссылка: https://t.me/petr
- согласие: разрешение не спрашивали

  2026-09-01 10:00
    Очень удобное расписание

SKIP
`;

describe('parseReviews', () => {
  it('разбирает записи с секциями, именами и цитатами', () => {
    const rows = parseReviews(FILE);
    expect(rows).toHaveLength(2);

    expect(rows[0]).toMatchObject({
      tgUserId: '111',
      username: 'vera',
      displayName: 'Вера',
      section: 'given',
      publish: true,
    });
    expect(rows[0].quote).toBe('Всё интуитивно понятно и дизайн не отвлекает');

    expect(rows[1]).toMatchObject({
      tgUserId: '222',
      section: 'pending',
      publish: false,
    });
  });

  it('не тащит в цитату строки разговора о согласии', () => {
    expect(parseReviews(FILE)[0].quote).not.toContain('Можно я приведу');
  });

  it('берёт только первую цитату', () => {
    const two = FILE.replace(
      '    Всё интуитивно понятно и дизайн не отвлекает\n',
      '    Всё интуитивно понятно и дизайн не отвлекает\n\n  2026-09-05 10:00\n    А вот вторая цитата про сервис\n',
    );
    const q = parseReviews(two)[0].quote;
    expect(q).toContain('интуитивно');
    expect(q).not.toContain('вторая цитата');
  });

  it('падает, если у записи нет директивы', () => {
    expect(() => parseReviews(FILE.replace('PUBLISH\n', ''))).toThrow(ReviewsParseError);
  });

  it('падает, если запись оказалась вне секции', () => {
    const broken = FILE.replace('# Разрешение есть — 1\n', '');
    expect(() => parseReviews(broken)).toThrow(ReviewsParseError);
  });
});

describe('selectPublishable — fail-closed по согласию', () => {
  it('публикует только записи из секции с разрешением', () => {
    const rows = parseReviews(FILE);
    const { publish, blocked } = selectPublishable(rows);
    expect(publish.map((r) => r.tgUserId)).toEqual(['111']);
    expect(blocked).toHaveLength(0);
  });

  it('PUBLISH без разрешения не публикуется, а попадает в отказ', () => {
    const rows = parseReviews(FILE.replace('SKIP\n', 'PUBLISH\n'));
    const { publish, blocked } = selectPublishable(rows);
    expect(publish.map((r) => r.tgUserId)).toEqual(['111']);
    expect(blocked.map((r) => r.tgUserId)).toEqual(['222']);
  });

  it('пустая цитата не публикуется', () => {
    const rows = parseReviews(
      FILE.replace('    Всё интуитивно понятно и дизайн не отвлекает\n', ''),
    );
    expect(selectPublishable(rows).publish).toHaveLength(0);
  });
});
