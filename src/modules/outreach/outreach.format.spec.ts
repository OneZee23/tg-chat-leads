import { LeadEntity } from '@modules/lead/lead.entity';
import {
  formatOutreachList,
  formatRefreshSummary,
} from '@modules/outreach/outreach.format';

function lead(partial: Partial<LeadEntity>): LeadEntity {
  return {
    username: 'someone',
    tgUserId: '123',
    score: 5,
    lastSeenAt: new Date('2026-08-07T10:00:00Z'),
    sampleText: 'текст объявления',
    ...partial,
  } as LeadEntity;
}

describe('formatOutreachList', () => {
  it('печатает ник, ссылку и обрезанный текст объявления', () => {
    const out = formatOutreachList({
      leads: [
        lead({
          username: 'example_tutor',
          score: 6,
          sampleText: 'Репетитор по английскому   (подготовка к ОГЭ/ЕГЭ)\n\nДобрый день!',
        }),
      ],
      total: 1,
    });

    expect(out).toContain('@example_tutor');
    expect(out).toContain('score 6');
    expect(out).toContain('t.me/example_tutor');
    expect(out).toContain('07.08');
    // Переносы и двойные пробелы схлопываются, иначе список разъезжается.
    expect(out).toContain('Репетитор по английскому (подготовка к ОГЭ/ЕГЭ) Добрый день!');
  });

  it('обрезает длинный текст многоточием', () => {
    const out = formatOutreachList({
      leads: [lead({ sampleText: 'а'.repeat(400) })],
      total: 1,
    });

    expect(out).toContain('…');
    out.split('\n').forEach((line) => expect(line.length).toBeLessThan(200));
  });

  it('показывает, что список урезан', () => {
    const out = formatOutreachList({ leads: [lead({})], total: 138 });

    expect(out).toContain('138');
    expect(out).toContain('показываю 1');
  });

  it('требует отметить написанных и объясняет почему', () => {
    const out = formatOutreachList({ leads: [lead({})], total: 1 });

    expect(out).toContain('yarn wrote');
    // Без объяснения инструкцию проигнорируют — а цена промаха тут высокая.
    expect(out).toContain('удалить диалог');
  });

  it('не пишет «показываю», когда влезли все', () => {
    const out = formatOutreachList({ leads: [lead({})], total: 1 });

    expect(out).not.toContain('показываю');
  });

  it('на пустом списке объясняет что делать, а не молчит', () => {
    const out = formatOutreachList({ leads: [], total: 0 });

    expect(out).toContain('Писать некому');
    expect(out).toContain('yarn refresh');
  });

  it('переживает лид без ника и без текста', () => {
    const out = formatOutreachList({
      leads: [lead({ username: null, sampleText: null, lastSeenAt: null })],
      total: 1,
    });

    expect(out).toContain('id123');
    expect(out).toContain('—');
  });
});

describe('formatRefreshSummary', () => {
  const base = {
    messagesSeen: 120,
    newLeads: 7,
    contactedMarked: 3,
    repliedMarked: 1,
    outreach: { contacted: 157, replied: 4 },
    chats: [
      { chat: '@one', messagesSeen: 100 },
      { chat: '@two', messagesSeen: 20, error: 'FloodWait 300s' },
    ],
  };

  it('показывает итоги по каждому чату и общие', () => {
    const out = formatRefreshSummary(base);

    expect(out).toContain('@one: новых сообщений 100');
    expect(out).toContain('FloodWait 300s');
    expect(out).toContain('120');
    expect(out).toContain('7');
  });

  it('выводит главную цифру — конверсию в ответы', () => {
    const out = formatRefreshSummary(base);

    expect(out).toContain('ОТВЕТИЛИ: 4 из 157');
    expect(out).toContain('2.5%');
  });

  it('не делит на ноль, когда никому ещё не писали', () => {
    const out = formatRefreshSummary({
      ...base,
      outreach: { contacted: 0, replied: 0 },
    });

    expect(out).toContain('ОТВЕТИЛИ: 0 из 0');
    expect(out).not.toContain('NaN');
  });
});
