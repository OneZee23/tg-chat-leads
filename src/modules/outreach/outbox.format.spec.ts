import { OutboxSendResult, formatOutboxResult } from '@modules/outreach/outbox.format';

function result(over: Partial<OutboxSendResult> = {}): OutboxSendResult {
  return {
    dryRun: true,
    file: '2026-09-03-1430.md',
    sent: 1,
    closed: 1,
    asked: 1,
    skipped: 0,
    untouched: 0,
    notFound: 0,
    stoppedBecause: 'записи закончились',
    staleCheck: true,
    entries: [
      { tgUserId: '1', username: 'a', directive: 'send', result: 'preview' },
      { tgUserId: '2', username: null, directive: 'close', result: 'preview' },
      { tgUserId: '3', username: 'c', directive: 'ask', result: 'asked' },
    ],
    ...over,
  };
}

describe('formatOutboxResult', () => {
  it('предпросмотр честно говорит, что ничего не отправлено', () => {
    const out = formatOutboxResult(result());
    expect(out).toContain('ПРЕДПРОСМОТР');
    expect(out).toContain('yarn outbox:send');
  });

  it('боевой прогон не предлагает отправить ещё раз', () => {
    const out = formatOutboxResult(result({ dryRun: false }));
    expect(out).not.toContain('yarn outbox:send');
  });

  it('неразобранное (ASK) видно в итоге — иначе теряется молча', () => {
    expect(formatOutboxResult(result({ dryRun: false }))).toMatch(/Оставлено тебе.*1/);
    expect(formatOutboxResult(result())).toMatch(/тебе \(ASK\).*1/);
  });

  it('в предпросмотре итог целиком в будущем времени', () => {
    // «Закрыто без ответа: 1» под заголовком ПРЕДПРОСМОТР читается как уже
    // сделанное, хотя не сделано ничего.
    const out = formatOutboxResult(result({ skipped: 1 }));
    expect(out).not.toMatch(/Закрыто без ответа/);
    expect(out).not.toMatch(/Оставлено тебе/);
    expect(out).not.toMatch(/Пропущено/);
    expect(out).toContain('Закрыл бы без ответа');
    expect(out).toContain('Осталось бы тебе');
    expect(out).toContain('Пропустил бы');
  });

  it('боевой прогон отчитывается в прошедшем', () => {
    const out = formatOutboxResult(result({ dryRun: false, skipped: 1 }));
    expect(out).toContain('Закрыто без ответа');
    expect(out).toContain('Оставлено тебе');
    expect(out).toContain('Пропущено');
  });

  it('варианты ASK печатаются целиком — выбирать надо из терминала', () => {
    // Иначе ради каждого ASK приходится открывать файл, а их по пять-шесть
    // на пачку. Смысл ASK в том, чтобы автор выбрал готовое, а не сочинял.
    const out = formatOutboxResult(
      result({
        entries: [
          {
            tgUserId: '9',
            username: 'd',
            directive: 'ask',
            result: 'asked',
            body: 'Зовут в партнёрский пост.\n\n1) Если интересно: «Расскажите подробнее»\n2) Если нет: «Спасибо, что позвали)»',
          },
        ],
      }),
    );
    expect(out).toContain('партнёрский пост');
    expect(out).toContain('1) Если интересно');
    expect(out).toContain('2) Если нет');
  });

  it('у send и close тело в итог не печатается — оно уже ушло или не нужно', () => {
    const out = formatOutboxResult(
      result({
        entries: [
          {
            tgUserId: '1',
            username: 'a',
            directive: 'send',
            result: 'sent',
            body: 'текст письма',
          },
        ],
      }),
    );
    expect(out).not.toContain('текст письма');
  });

  it('диалоги из выгрузки, которых нет в outbox, названы вслух', () => {
    // Спека обещает именно это число: «в выгрузке 23, разобрано 19,
    // не тронуто 4». Молчаливая потеря лида — то, от чего мы уходим.
    expect(formatOutboxResult(result({ untouched: 4 }))).toMatch(/не тронуто.*4/i);
  });

  it('выгрузки на диске нет — говорит, что сверить не по чему, а не пишет 0', () => {
    const out = formatOutboxResult(result({ untouched: null }));
    expect(out).not.toMatch(/не тронуто: 0/i);
    expect(out).toMatch(/не тронуто.*не по чему/i);
  });

  it('записи, до которых проход не дошёл, — отдельная цифра', () => {
    // Это не то же, что «не тронуто»: здесь ответ написан, но диалога в
    // проходе не нашлось (кончился лимит, остановка по ошибке).
    expect(formatOutboxResult(result({ notFound: 2 }))).toMatch(/не дошёл.*2/i);
  });

  it('пропуски объясняются причиной, а не просто считаются', () => {
    const out = formatOutboxResult(
      result({
        skipped: 1,
        entries: [
          {
            tgUserId: '9',
            username: 'd',
            directive: 'send',
            result: 'skipped',
            note: 'ты ответил руками',
          },
        ],
      }),
    );
    expect(out).toContain('ты ответил руками');
  });

  it('без стампа в имени файла говорит, что SEND не ушёл и как это чинить', () => {
    // Не «проверка пропущена»: без стампа отправка отказывается слать вовсе,
    // и человеку нужно знать, что делать дальше.
    const out = formatOutboxResult(result({ staleCheck: false, file: 'вторник.md' }));
    expect(out).toContain('свежест');
    expect(out).toContain('ни один SEND');
    expect(out).toContain('YYYY-MM-DD-HHMM.md');
  });

  it('ошибка отправки видна и объясняет остановку', () => {
    const out = formatOutboxResult(
      result({
        dryRun: false,
        stoppedBecause: 'ошибка отправки: FLOOD_WAIT_420',
        entries: [
          {
            tgUserId: '9',
            username: 'd',
            directive: 'send',
            result: 'failed',
            note: 'FLOOD_WAIT_420',
          },
        ],
      }),
    );
    expect(out).toContain('FLOOD_WAIT_420');
    expect(out).toContain('Остановка');
  });

  it('предпросмотр записи send содержит «отправлю»', () => {
    const out = formatOutboxResult(
      result({
        entries: [{ tgUserId: '1', username: 'a', directive: 'send', result: 'preview' }],
      }),
    );
    expect(out).toContain('отправлю');
  });

  it('предпросмотр записи close НЕ содержит «отправлю» и содержит «закрою без ответа»', () => {
    const out = formatOutboxResult(
      result({
        entries: [
          { tgUserId: '2', username: 'b', directive: 'close', result: 'preview' },
        ],
      }),
    );
    expect(out).not.toContain('отправлю');
    expect(out).toContain('закрою без ответа');
  });

  it('предпросмотр записи ask НЕ содержит «отправлю» и содержит «оставлю тебе»', () => {
    const out = formatOutboxResult(
      result({
        entries: [{ tgUserId: '3', username: 'c', directive: 'ask', result: 'preview' }],
      }),
    );
    expect(out).not.toContain('отправлю');
    expect(out).toContain('оставлю тебе');
  });

  it('итоговая подпись пропущенных не утверждает конкретную причину', () => {
    const out = formatOutboxResult(
      result({
        skipped: 2,
        entries: [
          {
            tgUserId: '9',
            username: 'd',
            directive: 'send',
            result: 'skipped',
            note: 'ты ответил руками',
          },
        ],
      }),
    );
    expect(out).not.toContain('диалог изменился');
    expect(out).toContain('причина у записи');
    // Причина в строке записи остаётся
    expect(out).toContain('ты ответил руками');
  });
});
