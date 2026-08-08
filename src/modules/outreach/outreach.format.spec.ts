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
  it('показывает итоги по каждому чату и общие', () => {
    const out = formatRefreshSummary({
      messagesSeen: 120,
      newLeads: 7,
      contactedMarked: 3,
      chats: [
        { chat: '@one', messagesSeen: 100 },
        { chat: '@two', messagesSeen: 20, error: 'FloodWait 300s' },
      ],
    });

    expect(out).toContain('@one: новых сообщений 100');
    expect(out).toContain('FloodWait 300s');
    expect(out).toContain('120');
    expect(out).toContain('7');
  });
});
