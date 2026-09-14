import {
  buildCandidates,
  detectSignals,
  extractCompanies,
  isContactable,
  recencyFactor,
  type ScoredMessage,
} from '@modules/research/leads.scoring';

const NOW = 1_757_000_000; // фиксируем, иначе тесты на свежесть плывут во времени
const DAY = 86_400;

describe('detectSignals', () => {
  it('ловит реферал в живой формулировке', () => {
    expect(detectSignals('могу зарефералить, пишите в лс')).toContain('referral');
    expect(detectSignals('у нас есть referral бонус')).toContain('referral');
  });

  it('ловит наём', () => {
    expect(detectSignals('ищем сеньора в команду платежей')).toContain('hiring');
    expect(detectSignals('мы нанимаем бэкендеров')).toContain('hiring');
  });

  it('ловит инсайдера, который называет место работы', () => {
    expect(detectSignals('я работаю в Zalando уже два года')).toContain('insider');
    expect(detectSignals('у нас в компании такого нет')).toContain('insider');
  });

  it('ловит переехавшего', () => {
    expect(detectSignals('я переехал в Берлин в прошлом году')).toContain('relocated');
    expect(detectSignals('получил Blue Card за четыре месяца')).toContain('relocated');
  });

  it('ловит совпадение по стеку', () => {
    expect(detectSignals('пишем на NestJS и TypeScript')).toContain('stack');
  });

  it('НЕ считает наймом рассуждения о найме - иначе в визовом чате метку получает каждый', () => {
    expect(detectSignals('сейчас мало кто нанимает джунов')).not.toContain('hiring');
    expect(detectSignals('эта компания нанимает через Deel')).not.toContain('hiring');
    expect(
      detectSignals('вам стоит попробовать Schwarz IT, у них полно вакансий'),
    ).not.toContain('hiring');
  });

  it('НЕ считает рекрутёром упоминание HR в третьем лице', () => {
    expect(detectSignals('их HR ответил через неделю')).not.toContain('recruiter');
    expect(detectSignals('я рекрутер, помогаю с релокацией')).toContain('recruiter');
  });

  it('различает ПРЕДЛОЖЕНИЕ реферала и ПРОСЬБУ о нём', () => {
    expect(detectSignals('могу зарефералить к нам, пишите')).toContain('referral');
    expect(
      detectSignals('мне бы кто помог контактами рекрутёров и рефералками'),
    ).not.toContain('referral');
  });

  it('ловит просьбу о реферале, замаскированную под предложение', () => {
    const veronica =
      'Если ВДРУГ по счастливой случайности кто-то знает о наличие вакансии в Берлине ' +
      'и может быть даже готов зарефералить отличного сеньора, то дайте знать';
    expect(detectSignals(veronica)).toContain('seeker');
  });

  it('помечает соискателя: он такой же ищущий, а не реферер', () => {
    expect(detectSignals('мне бы кто помог с поиском')).toContain('seeker');
    expect(detectSignals('я от безработицы страдаю уже полгода')).toContain('seeker');
    expect(detectSignals('кто может зарефералить в свою компанию?')).toContain('seeker');
  });

  it('работает и на английском - в @англоязычного чата русских фраз нет', () => {
    expect(detectSignals('we are hiring a backend engineer')).toContain('hiring');
    expect(detectSignals('happy to refer you, send me your CV')).toContain('referral');
    expect(detectSignals('I work at Ledger on the wallet team')).toContain('insider');
    expect(detectSignals('I relocated to Berlin last year')).toContain('relocated');
  });

  it('не выдумывает сигналы на пустом трёпе', () => {
    expect(detectSignals('да, согласен, спасибо большое')).toEqual([]);
  });

  it('находит несколько сигналов в одном сообщении', () => {
    const signals = detectSignals(
      'я работаю в Delivery Hero, мы нанимаем на Node.js, могу зарефералить',
    );
    expect(signals).toEqual(
      expect.arrayContaining(['insider', 'hiring', 'stack', 'referral']),
    );
  });
});

describe('extractCompanies', () => {
  it('достаёт латинские названия', () => {
    expect(extractCompanies('работаю в Zalando, до этого был Delivery Hero')).toEqual(
      expect.arrayContaining(['Zalando', 'Delivery', 'Hero']),
    );
  });

  it('выбрасывает технологии и общие слова', () => {
    const found = extractCompanies('пишу на TypeScript и Node, есть Blue Card');
    expect(found).not.toContain('TypeScript');
    expect(found).not.toContain('Node');
    expect(found).not.toContain('Blue');
  });

  it('не считает компаниями инфраструктуру - на этом горел реальный прогон', () => {
    const found = extractCompanies('AWS EBS для бедных, проверь LUN, LVM и NFS');
    expect(found).toEqual([]);
  });

  it('не считает компаниями ИИ-инструменты из пересланной статьи', () => {
    const found = extractCompanies('аналитика от OpenAI и Anthropic, писал в Cursor');
    expect(found).toEqual([]);
  });

  it('не падает на тексте без латиницы', () => {
    expect(extractCompanies('всем привет, подскажите по визе')).toEqual([]);
  });
});

describe('isContactable', () => {
  it('пропускает только тех, у кого есть юзернейм', () => {
    expect(isContactable('@ivan')).toBe(true);
    expect(isContactable('Иван Петров')).toBe(false);
    expect(isContactable('id123456')).toBe(false);
  });
});

describe('recencyFactor', () => {
  it('свежие сообщения не штрафует', () => {
    expect(recencyFactor(NOW - 10 * DAY, NOW)).toBe(1);
  });

  it('штрафует тем сильнее, чем старее', () => {
    const month = recencyFactor(NOW - 60 * DAY, NOW);
    const halfYear = recencyFactor(NOW - 200 * DAY, NOW);
    const ancient = recencyFactor(NOW - 500 * DAY, NOW);
    expect(month).toBeGreaterThan(halfYear);
    expect(halfYear).toBeGreaterThan(ancient);
  });
});

describe('buildCandidates', () => {
  const message = (over: Partial<ScoredMessage>): ScoredMessage => ({
    author: '@someone',
    text: 'обычное сообщение про переезд и жизнь',
    date: NOW - DAY,
    link: null,
    ...over,
  });

  it('выбрасывает авторов без юзернейма: им всё равно не написать', () => {
    const result = buildCandidates(
      [message({ author: 'Иван Петров' }), message({ author: 'id999' })],
      NOW,
    );
    expect(result).toEqual([]);
  });

  it('группирует сообщения одного автора', () => {
    const result = buildCandidates(
      [
        message({ author: '@ivan', text: 'первое сообщение про бэкенд' }),
        message({ author: '@ivan', text: 'второе сообщение про NestJS' }),
      ],
      NOW,
    );
    expect(result).toHaveLength(1);
    expect(result[0].messages).toHaveLength(2);
  });

  it('ставит выше того, кто говорит про реферал, а не просто болтает', () => {
    const result = buildCandidates(
      [
        message({ author: '@talker', text: 'да я тоже думаю про переезд когда-нибудь' }),
        message({ author: '@referrer', text: 'могу зарефералить к нам, пишите' }),
      ],
      NOW,
    );
    expect(result[0].author).toBe('@referrer');
  });

  it('при равных сигналах свежий обгоняет давно замолчавшего', () => {
    const text = 'ищем бэкендера на Node.js, могу зарефералить';
    const result = buildCandidates(
      [
        message({ author: '@old', text, date: NOW - 400 * DAY }),
        message({ author: '@fresh', text, date: NOW - 5 * DAY }),
      ],
      NOW,
    );
    expect(result[0].author).toBe('@fresh');
  });

  it('сортирует реплики автора от новых к старым', () => {
    const result = buildCandidates(
      [
        message({
          author: '@ivan',
          text: 'старое сообщение про работу',
          date: NOW - 90 * DAY,
        }),
        message({
          author: '@ivan',
          text: 'свежее сообщение про работу',
          date: NOW - DAY,
        }),
      ],
      NOW,
    );
    expect(result[0].messages[0].date).toBe(NOW - DAY);
  });

  it('копит компании и сигналы по всем сообщениям автора', () => {
    const result = buildCandidates(
      [
        message({ author: '@ivan', text: 'я работаю в Zalando' }),
        message({ author: '@ivan', text: 'мы нанимаем на Node.js' }),
      ],
      NOW,
    );
    expect(result[0].companies).toContain('Zalando');
    expect(result[0].signals).toEqual(
      expect.arrayContaining(['insider', 'hiring', 'stack']),
    );
  });

  it('соискатель уходит вниз, даже если упомянул стек и рефералы', () => {
    const result = buildCandidates(
      [
        message({
          author: '@seeker',
          text: 'мне бы кто помог рефералками, пишу на Node.js, ищу работу',
        }),
        message({ author: '@insider', text: 'я работаю в Zalando, могу зарефералить' }),
      ],
      NOW,
    );
    expect(result[0].author).toBe('@insider');
    // Ноль, а не минус: отсечка «нет сильного сигнала» срабатывает раньше штрафа.
    expect(result[1].score).toBe(0);
  });

  it('обнуляет активного участника без действия: он собеседник, а не лид', () => {
    const result = buildCandidates(
      [
        message({ author: '@chatty', text: 'у нас в компании руководитель в отпуске' }),
        message({ author: '@chatty', text: 'а я работаю в Zalando уже два года' }),
        message({ author: '@chatty', text: 'пишем на NestJS и TypeScript' }),
      ],
      NOW,
    );
    expect(result[0].signals).toEqual(expect.arrayContaining(['insider', 'stack']));
    expect(result[0].score).toBe(0);
  });

  it('отбрасывает ботов', () => {
    const result = buildCandidates(
      [
        message({
          author: '@some_support_bot',
          text: 'мы ищем разработчика на Node.js',
        }),
      ],
      NOW,
    );
    expect(result).toEqual([]);
  });

  it('десятое сообщение весит меньше второго', () => {
    const one = buildCandidates(
      [message({ author: '@a', text: 'ищем бэкендера' })],
      NOW,
    )[0].score;
    const two = buildCandidates(
      [
        message({ author: '@a', text: 'ищем бэкендера' }),
        message({ author: '@a', text: 'ищем бэкендера ещё раз' }),
      ],
      NOW,
    )[0].score;
    const ten = buildCandidates(
      Array.from({ length: 10 }, () => message({ author: '@a', text: 'ищем бэкендера' })),
      NOW,
    )[0].score;
    expect(two - one).toBeGreaterThan((ten - two) / 8);
  });
});
