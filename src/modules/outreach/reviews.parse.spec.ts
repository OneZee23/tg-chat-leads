import {
  ReviewsParseError,
  cleanName,
  parseReviews,
  selectPublishable,
} from './reviews.parse';

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
      directive: 'PUBLISH',
    });
    expect(rows[0].quote).toBe('Всё интуитивно понятно и дизайн не отвлекает');

    expect(rows[1]).toMatchObject({
      tgUserId: '222',
      section: 'pending',
      directive: 'SKIP',
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

describe('selectPublishable — что можно публиковать', () => {
  it('именная карточка — только из секции с разрешением', () => {
    const { named, anon, blocked } = selectPublishable(parseReviews(FILE));
    expect(named.map((r) => r.tgUserId)).toEqual(['111']);
    expect(anon).toHaveLength(0);
    expect(blocked).toHaveLength(0);
  });

  it('PUBLISH без разрешения не публикуется, а попадает в blocked', () => {
    const { named, blocked } = selectPublishable(
      parseReviews(FILE.replace('SKIP\n', 'PUBLISH\n')),
    );
    expect(named.map((r) => r.tgUserId)).toEqual(['111']);
    expect(blocked.map((r) => r.tgUserId)).toEqual(['222']);
  });

  it('ANON публикуется без разрешения: персональных данных в карточке нет', () => {
    const { anon, blocked } = selectPublishable(
      parseReviews(FILE.replace('SKIP\n', 'ANON\n')),
    );
    expect(anon.map((r) => r.tgUserId)).toEqual(['222']);
    expect(blocked).toHaveLength(0);
  });

  it('ANON НЕ обходит прямой отказ', () => {
    // Человек, сказавший «не публикуйте», имел в виду свои слова, а не только
    // своё имя. Анонимность тут не лазейка.
    const refused = FILE.replace('# Разрешения нет — 1', '# Отказались — 1').replace(
      'SKIP\n',
      'ANON\n',
    );
    const { anon, blocked } = selectPublishable(parseReviews(refused));
    expect(anon).toHaveLength(0);
    expect(blocked.map((r) => r.tgUserId)).toEqual(['222']);
  });

  it('пустая цитата не публикуется', () => {
    const rows = parseReviews(
      FILE.replace('    Всё интуитивно понятно и дизайн не отвлекает\n', ''),
    );
    expect(selectPublishable(rows).named).toHaveLength(0);
  });
});

describe('cleanName — имя для витрины', () => {
  it('снимает эмодзи', () => {
    expect(cleanName('🐾Viki🐈‍⬛')).toBe('Viki');
  });

  it('берёт имя до разделителя', () => {
    expect(cleanName('Фарида | педагог по вокалу')).toBe('Фарида');
  });

  it('поднимает первую букву', () => {
    expect(cleanName('руся')).toBe('Руся');
  });

  it('не трогает нормальное имя', () => {
    expect(cleanName('Даниил Непряхин')).toBe('Даниил Непряхин');
  });

  it('из одних эмодзи получается пусто — карточка станет анонимной', () => {
    expect(cleanName('🐈‍⬛✨')).toBe('');
  });
});
