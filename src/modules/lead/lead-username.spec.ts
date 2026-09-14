import { normalizeUsername } from '@modules/lead/lead-username';

/**
 * Строка «контакт» приходит из ручного списка, то есть из копипасты с
 * чужих сайтов. Каждый неотсеянный мусор — это лишний
 * contacts.ResolveUsername, а он лимитируется отдельно и надолго.
 */
describe('normalizeUsername', () => {
  it('принимает ник с собакой и без неё', () => {
    expect(normalizeUsername('@example_tutor')).toBe('example_tutor');
    expect(normalizeUsername('example_tutor')).toBe('example_tutor');
  });

  it('срезает пробелы по краям — их приносит копипаста', () => {
    expect(normalizeUsername('  @example_tutor \n')).toBe('example_tutor');
  });

  it('приводит к нижнему регистру: в Telegram ник регистронезависим', () => {
    expect(normalizeUsername('@ExampleTutor')).toBe('exampletutor');
  });

  it('разбирает ссылку t.me в любом написании', () => {
    expect(normalizeUsername('https://t.me/example_tutor')).toBe('example_tutor');
    expect(normalizeUsername('t.me/example_tutor')).toBe('example_tutor');
    expect(normalizeUsername('http://telegram.me/example_tutor')).toBe('example_tutor');
    expect(normalizeUsername('//t.me/Example_Tutor')).toBe('example_tutor');
  });

  it('отбрасывает хвост ссылки: параметры, якорь и номер сообщения', () => {
    expect(normalizeUsername('https://t.me/example_tutor?text=hi')).toBe('example_tutor');
    expect(normalizeUsername('https://t.me/example_tutor/42')).toBe('example_tutor');
    expect(normalizeUsername('https://t.me/example_tutor#about')).toBe('example_tutor');
  });

  it('понимает tg://resolve — так ник копируется из десктопа', () => {
    expect(normalizeUsername('tg://resolve?domain=example_tutor')).toBe('example_tutor');
  });

  it('возвращает null на мусоре', () => {
    expect(normalizeUsername('')).toBeNull();
    expect(normalizeUsername('   ')).toBeNull();
    expect(normalizeUsername('не ник вовсе')).toBeNull();
    expect(normalizeUsername('ivan@example.com')).toBeNull();
    expect(normalizeUsername('+79991234567')).toBeNull();
    expect(normalizeUsername('https://instagram.com/example_tutor')).toBeNull();
    // Кириллица ником в Telegram быть не может.
    expect(normalizeUsername('@преподаватель')).toBeNull();
  });

  it('отбивает ссылки t.me, которые ником не являются', () => {
    // Инвайт в закрытую группу, ссылка на сообщение и превью канала дают
    // похожий на ник кусок текста, а резолвятся не в того человека.
    expect(normalizeUsername('https://t.me/+AbCdEfGh123')).toBeNull();
    expect(normalizeUsername('https://t.me/joinchat/AbCdEfGh')).toBeNull();
    expect(normalizeUsername('https://t.me/c/1234567890/5')).toBeNull();
    expect(normalizeUsername('https://t.me/s/some_channel')).toBeNull();
    expect(normalizeUsername('https://t.me/')).toBeNull();
  });

  it('проверяет длину и первый символ по правилам Telegram', () => {
    expect(normalizeUsername('@abcd')).toBeNull(); // 4 символа — короче минимума
    expect(normalizeUsername('@abcde')).toBe('abcde');
    expect(normalizeUsername('@1abcde')).toBeNull(); // начинается с цифры
    expect(normalizeUsername(`@${'a'.repeat(33)}`)).toBeNull();
    expect(normalizeUsername('@has-dash')).toBeNull();
  });
});
