import { formatWaiting } from '@modules/outreach/waiting.format';
import type { WaitingDialog } from '@modules/dialogs/dialogs.service';

function row(over: Partial<WaitingDialog> = {}): WaitingDialog {
  return {
    account: '@one',
    username: 'nick',
    tgUserId: '1',
    name: 'Аня',
    at: new Date('2026-09-13T07:12:00'),
    text: 'обязательно напишу!',
    unread: 3,
    closedAt: null,
    known: true,
    ...over,
  };
}

describe('formatWaiting', () => {
  it('пусто — говорит прямо, а не рисует пустой список', () => {
    expect(formatWaiting([])).toContain('Отвечать некому');
  });

  it('делит на незакрытые и закрытые нами', () => {
    // Закрытие — решение ассистента, и владелец имеет право его пересмотреть.
    // Поэтому закрытые не прячутся, а показываются отдельным блоком.
    const out = formatWaiting([
      row({ username: 'open_one' }),
      row({ username: 'closed_one', closedAt: new Date('2026-09-13T07:12:00') }),
    ]);

    expect(out).toContain('Не закрывали — 1');
    expect(out).toContain('Закрыты без ответа — 1');
    expect(out).toContain('@open_one');
    expect(out).toContain('@closed_one');
    expect(out).toContain('FOLLOWUP');
  });

  it('показывает непрочитанные и дату закрытия рядом с человеком', () => {
    const out = formatWaiting([
      row({ unread: 2, closedAt: new Date('2026-09-12T10:29:00') }),
    ]);
    expect(out).toContain('2 непрочит.');
    expect(out).toContain('закрыт 12.09');
  });

  it('человек не из базы лидов помечен отдельно', () => {
    // Такой написал нам сам: в лидах его нет, но ответа он ждёт так же.
    expect(formatWaiting([row({ known: false })])).toContain('нет в базе лидов');
  });

  it('вложение без текста не притворяется пустой строкой', () => {
    expect(formatWaiting([row({ text: '' })])).toContain('(без текста — вложение)');
  });

  it('длинную реплику подрезает, а не растягивает экран', () => {
    const out = formatWaiting([row({ text: 'я'.repeat(300) })]);
    expect(out).toContain('…');
    expect(out.split('\n').every((l) => l.length < 140)).toBe(true);
  });
});
