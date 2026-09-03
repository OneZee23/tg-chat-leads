import {
  OutboxParseError,
  extractRecordIds,
  parseOutbox,
} from '@modules/outreach/outbox.parse';

describe('parseOutbox', () => {
  it('разбирает три директивы и многострочное тело', () => {
    const raw = [
      'Преамбула, которую ассистент может дописать — она игнорируется.',
      '',
      '## id123456789 @teacher',
      '',
      'SEND',
      'Супер, рад что заинтересовало)',
      '',
      'Учеников можно завести списком.',
      '',
      '## id987654321 @another',
      'ASK',
      'Спрашивает про Zoom, его нет. Как отвечаем?',
      '',
      '## id555555555',
      'CLOSE',
      '',
    ].join('\n');

    const entries = parseOutbox(raw);

    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual({
      tgUserId: '123456789',
      username: 'teacher',
      directive: 'send',
      body: 'Супер, рад что заинтересовало)\n\nУчеников можно завести списком.',
    });
    expect(entries[1].directive).toBe('ask');
    expect(entries[2]).toEqual({
      tgUserId: '555555555',
      username: null,
      directive: 'close',
      body: '',
    });
  });

  it('директива в любом регистре — файл правят руками', () => {
    const entries = parseOutbox('## id1\nSend\nтекст\n');
    expect(entries[0].directive).toBe('send');
  });

  it('опечатка в директиве роняет разбор целиком', () => {
    // Половина отправленной пачки хуже, чем ни одной: непонятно, где встали.
    expect(() => parseOutbox('## id1\nSEDN\nтекст\n')).toThrow(OutboxParseError);
  });

  it('директивы нет вовсе — ошибка, а не «отправить тело»', () => {
    expect(() => parseOutbox('## id1\nпросто текст без директивы\n')).toThrow(
      OutboxParseError,
    );
  });

  it('пустое тело у SEND — ошибка', () => {
    expect(() => parseOutbox('## id1\nSEND\n\n')).toThrow(OutboxParseError);
  });

  it('пустое тело у ASK и CLOSE допустимо', () => {
    expect(parseOutbox('## id1\nASK\n\n## id2\nCLOSE\n')).toHaveLength(2);
  });

  it('дубль id роняет разбор — иначе человек получит два сообщения', () => {
    expect(() => parseOutbox('## id1\nSEND\nа\n\n## id1\nSEND\nб\n')).toThrow(
      OutboxParseError,
    );
  });

  it('тело длиннее лимита Telegram — ошибка', () => {
    const long = 'я'.repeat(4001);
    expect(() => parseOutbox(`## id1\nSEND\n${long}\n`)).toThrow(OutboxParseError);
  });

  it('файл без записей — ошибка: почти всегда это забытая выгрузка', () => {
    expect(() => parseOutbox('# Ответы\n\nничего не заполнил\n')).toThrow(
      OutboxParseError,
    );
  });

  it('заголовок не того уровня не считается записью', () => {
    // `# id1` — не запись. Такой диалог попадёт в «не тронуто» в итоге,
    // а не молча уедет с чужим телом.
    expect(() => parseOutbox('# id1\nSEND\nтекст\n')).toThrow(OutboxParseError);
  });

  it('извлекает id заголовков без разбора тел — этим же читается inbox-файл', () => {
    // Формат заголовка у inbox и outbox один и тот же by design, поэтому
    // «кому ответ не написали» считается той же функцией.
    expect(extractRecordIds('## id1 @a\nтело\n## id2\nтело\n')).toEqual(['1', '2']);
    expect(extractRecordIds('нет заголовков')).toEqual([]);
  });

  it('ведущие и хвостовые пустые строки в теле срезаются', () => {
    const entries = parseOutbox('## id1\nSEND\n\n\n  текст  \n\n\n');
    expect(entries[0].body).toBe('текст');
  });

  it('битый заголовок ПОСЛЕ валидной записи роняет разбор', () => {
    // Если наткнулись на ### id2 (неправильный уровень после валидной записи),
    // это либо ошибка форматирования, либо markdown в теле. Fail-closed.
    expect(() => parseOutbox('## id1\nSEND\nпривет\n### id2 @foo\nSEND\nпривет2\n')).toThrow(
      OutboxParseError,
    );
  });

  it('невалидный ник в заголовке роняет разбор', () => {
    // Ник содержит дефис, который не проходит HEADER regexp.
    // Молча вклеится в тело — ошибка.
    expect(() => parseOutbox('## id1\nSEND\nпривет\n## id2 @bad-user\nSEND\nпривет2\n')).toThrow(
      OutboxParseError,
    );
  });

  it('строка, начинающаяся с #, внутри тела роняет разбор', () => {
    // Осознанный компромисс fail-closed: markdown-заголовки в теле редки,
    // так что ложных срабатываний на реальных текстах почти нет.
    expect(() => parseOutbox('## id1\nSEND\nпривет\n#хештег\nеще текст\n')).toThrow(
      OutboxParseError,
    );
  });

  it('длинное тело у CLOSE не роняет разбор', () => {
    // Комментарий для close не уходит в Telegram, так что лимит не нужен.
    const long = 'я'.repeat(4001);
    const entries = parseOutbox(`## id1\nCLOSE\n${long}\n`);
    expect(entries[0].body).toBe(long.trim());
  });

  it('длинное тело у ASK не роняет разбор', () => {
    // Вопрос к автору не уходит в Telegram, так что лимит не нужен.
    const long = 'я'.repeat(4001);
    const entries = parseOutbox(`## id1\nASK\n${long}\n`);
    expect(entries[0].body).toBe(long.trim());
  });

  it('длинное тело у SEND по-прежнему роняет разбор', () => {
    // Только SEND уходит в Telegram, так что лимит применяется только к нему.
    const long = 'я'.repeat(4001);
    expect(() => parseOutbox(`## id1\nSEND\n${long}\n`)).toThrow(OutboxParseError);
  });

  it('extractRecordIds на тексте с посторонними markdown-заголовками не бросает', () => {
    // extractRecordIds используется и для inbox-файла, где заголовки
    // вроде «# Неотвеченное на …» легальны. Не валидируем там.
    const ids = extractRecordIds('# Заголовок\n## id1\n### Подзаголовок\n## id2\n');
    expect(ids).toEqual(['1', '2']);
  });
});
