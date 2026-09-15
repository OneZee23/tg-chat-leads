import { clipKeepingLinks } from '@modules/outreach/clip';

describe('clipKeepingLinks', () => {
  it('короткую строку не трогает', () => {
    expect(clipKeepingLinks('да, можно', 120)).toBe('да, можно');
  });

  it('длинную режет с многоточием', () => {
    expect(clipKeepingLinks('я'.repeat(200), 10)).toBe(`${'я'.repeat(10)}…`);
  });

  it('ссылку из хвоста дописывает, а не съедает', () => {
    // Живой случай 15.09.2026: человек прислал адрес профиля в конце длинной
    // фразы, список показал первые 120 символов, и ассистент переспросил
    // ссылку, которая уже была написана.
    const text =
      'Можно подписать Дарья, ссылку на профи можно оставить, так как там ' +
      'аккаунт с отзывами, видно, что действительно репетитор: ' +
      'https://profi.ru/profile/IvannikovaDA3';

    const out = clipKeepingLinks(text, 120);

    expect(out).toContain('https://profi.ru/profile/IvannikovaDA3');
    expect(out).toContain('…');
  });

  it('ссылку, попавшую в видимую часть, не дублирует', () => {
    const text = `https://t.me/nick ${'я'.repeat(200)}`;
    const out = clipKeepingLinks(text, 120);
    expect(out.match(/https:\/\/t\.me\/nick/g)).toHaveLength(1);
  });

  it('несколько потерянных ссылок сохраняются все', () => {
    const text = `${'я'.repeat(130)} https://a.example https://b.example`;
    const out = clipKeepingLinks(text, 120);
    expect(out).toContain('https://a.example');
    expect(out).toContain('https://b.example');
  });

  it('пустое остаётся пустым', () => {
    expect(clipKeepingLinks(null, 120)).toBe('');
  });
});
