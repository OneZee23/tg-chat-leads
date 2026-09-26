import { SITE_LINK, SIGNUP_TAG } from '@common/site-link';

describe('ссылка на сайт в исходящих сообщениях', () => {
  it('несёт метку канала, иначе регистрация придёт без источника', () => {
    expect(SITE_LINK).toBe(`teachtrack.ru/?from=${SIGNUP_TAG}`);
  });

  it('метка проходит проверку фронта ^[a-z0-9_-]{1,64}$', () => {
    // frontend/src/lib/signupSource.ts молча отбрасывает всё, что не подошло:
    // опечатка в метке = тихая потеря атрибуции, без единой ошибки.
    expect(SIGNUP_TAG).toMatch(/^[a-z0-9_-]{1,64}$/);
  });

  it('не содержит схемы и слеша на конце — Telegram линкует голый домен', () => {
    expect(SITE_LINK).not.toContain('://');
    expect(SITE_LINK.endsWith('/')).toBe(false);
  });
});
