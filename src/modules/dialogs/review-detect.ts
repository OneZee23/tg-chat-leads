import type { HistoryMessage } from './unanswered';

/**
 * Поиск отзывов о продукте в переписке и — отдельно — согласия на публикацию.
 *
 * Две вещи держатся врозь намеренно. Хорошая цитата и право её напечатать —
 * разные факты: человек может искренне похвалить сервис и при этом никогда
 * не разрешать вешать своё имя и лицо на лендинг. Смешать их в один флаг
 * значит однажды опубликовать чужие персональные данные без спроса, а
 * оператор ПДн тут — живой человек с ИНН, а не абстрактный «проект».
 *
 * Поэтому согласие по умолчанию `not-asked`, и распознаётся только явное
 * «да» в ответ на явный вопрос. Всё, что непонятно, остаётся неразрешённым.
 */

/**
 * Граница слова, понимающая кириллицу.
 *
 * В JavaScript `\b` считает буквой только ASCII, поэтому /\bда\b/ НИКОГДА не
 * совпадёт с «Да, конечно» — проверка молча не работает и всегда возвращает
 * false. Поймали тестом: согласие не распознавалось вообще, а одиннадцать
 * тестов из двенадцати при этом были зелёными за счёт соседних шаблонов.
 */
function word(w: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])${w}(?![\\p{L}\\p{N}])`, 'iu');
}

/** То же, но граница только слева: ловим «отличный», «отлично», «отличная». */
function starts(w: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])${w}`, 'iu');
}

/** Похвала продукту. */
const PRAISE = [
  /удобн/i,
  /понрав/i,
  /нравится/i,
  word('класс'),
  /круто/i,
  starts('отличн'),
  word('супер'),
  /интуитивн/i,
  /приятн/i,
  starts('красив'),
  /полезн/i,
  word('пользуюсь'),
  /всё работает|все работает/i,
  word('легко'),
  /разобра(?:лся|лась|ться)/i,
];

/**
 * О чём речь. Похвалы мало: «мне больше бек нравится» — тоже похвала, только
 * человек хвалит не нас. На живой выгрузке без этого фильтра в отзывы уехали
 * рассуждения репетитора о своих предпочтениях в разработке и вежливое
 * «было бы отлично попробовать».
 *
 * Цитата обязана содержать И признак похвалы, И упоминание предмета
 * разговора. Обобщённое «очень удобно!» отсеется — и правильно: на карточке
 * лендинга от него всё равно нет пользы.
 */
const TOPIC = [
  /сервис/i,
  starts('сайт'),
  /платформ/i,
  /приложени/i,
  /teachtrack/i,
  /тичтрек|тич-трек/i,
  /интерфейс/i,
  /дизайн/i,
  /расписани/i,
  /ученик/i,
  /оплат/i,
  /напоминани/i,
  /таблиц/i,
  /добавлени|добавлять|завести/i,
  /функци/i,
  /пользоваться|пользуюсь/i,
  /регистрац|зарегистр/i,
  /оформлени/i,
];

/**
 * Отказы и вежливые «нет». Ловим до похвалы: «спасибо, но пока не надо»
 * содержит «спасибо», и без этого фильтра уехало бы в отзывы.
 */
const DECLINE = [
  /не интересует/i,
  /пока не надо/i,
  /не нужно/i,
  /не актуальн/i,
  word('спам'),
  /не пишите/i,
  /отпиши/i,
];

/**
 * Вопрос автора о публикации цитаты. Своё сообщение, поэтому формулировка наша.
 *
 * Знак вопроса обязателен, и это не придирка. Без него под правило попадало
 * наше же «Спасибо огромное, поставлю цитату)» — сказанное ПОСЛЕ полученного
 * разрешения. Правило «берём последний вопрос» видело его как свежий вопрос,
 * ответа на него не находило, и живое «Да, конечно, используйте цитату»
 * терялось: согласие превращалось в «спрашивали, ответа нет».
 */
/**
 * Спросили ли мы разрешение на публикацию.
 *
 * Вопросительный знак обязателен и держит всю конструкцию: в холодном письме
 * есть строка «с вашего согласия размещу цитату на главной», и без этого
 * требования каждое первое письмо считалось бы просьбой о разрешении.
 *
 * Слова «цитата» одного мало. 09.09 просьбы были сформулированы по-разному —
 * «можно поставить вашу фразу», «ваши слова уже стоят на главной», — и пять
 * из девяти не засчитались как заданные. Такой человек выглядит
 * неспрошенным и легко получает вторую просьбу о том же.
 */
function isConsentQuestion(text: string): boolean {
  if (!text.includes('?')) return false;
  // Слово «цитата» в вопросе — само по себе просьба, как и было.
  if (/цитат/i.test(text)) return true;
  // Остальные формулировки берём только вместе с признаком публикации:
  // «отзыв» без него встречается в обычной переписке слишком часто.
  const mentionsWords = /отзыв|ваши слова|вашу фразу/i.test(text);
  const mentionsPublishing =
    /на главной|с вашим именем|с именем|ссылк\w* на вас|фото из телеграм/i.test(text);
  return mentionsWords && mentionsPublishing;
}

const CONSENT_YES = [
  word('да'),
  word('конечно'),
  word('можно'),
  /использу(?:йте|й)/i,
  /разрешаю/i,
  /не против/i,
  word('ок'),
  /без проблем/i,
  /не возражаю/i,
  /пожалуйста/i,
];

const CONSENT_NO = [
  word('нет'),
  /не надо/i,
  /не хочу/i,
  // «не против» — это СОГЛАСИЕ, а слово «против» внутри него. Отказы
  // проверяются раньше согласий (иначе «да нет, не надо» читалось бы как
  // «да»), поэтому без этой оговорки живое «хорошо, я не против» уезжало
  // в отказавшиеся и отзыв терялся молча.
  new RegExp('(?<!не\\s)(?<![\\p{L}\\p{N}])против(?![\\p{L}\\p{N}])', 'iu'),
  /не стоит/i,
  /воздержусь/i,
  /лучше без/i,
];

/** Короче — не цитата, а реплика. «Класс!» на лендинге не работает. */
const MIN_QUOTE_LEN = 25;

/** Длиннее — человек рассказывает историю, на карточку не влезет. */
const MAX_QUOTE_LEN = 400;

export type ConsentState = 'given' | 'refused' | 'asked-no-answer' | 'not-asked';

export interface ReviewQuote {
  /** Unix-секунды: по ним автор находит сообщение в телеграме глазами. */
  at: number;
  text: string;
  /** Сколько признаков похвалы сработало — для сортировки, не для решения. */
  score: number;
}

export interface ReviewCandidate {
  quotes: ReviewQuote[];
  consent: ConsentState;
  /** Момент, когда согласие спросили. null — не спрашивали. */
  consentAskedAt: number | null;
  /**
   * Та самая пара реплик, из которой сделан вывод о согласии.
   *
   * Вердикт без доказательства нечем проверить, а цена ошибки здесь —
   * опубликованные без спроса персональные данные живого человека. Поэтому
   * файл показывает автору не «разрешение есть», а сам разговор, и решение
   * остаётся за человеком.
   */
  consentAsk: string | null;
  consentAnswer: string | null;
}

function matchCount(text: string, patterns: RegExp[]): number {
  return patterns.reduce((n, re) => (re.test(text) ? n + 1 : n), 0);
}

function looksLikeDecline(text: string): boolean {
  return DECLINE.some((re) => re.test(text));
}

/**
 * Согласие: ищем ПОСЛЕДНИЙ наш вопрос про цитату и первый входящий ответ
 * после него. Последний, а не первый: спросить могли дважды, и значение
 * имеет свежий ответ.
 */
function detectConsent(history: HistoryMessage[]): {
  consent: ConsentState;
  consentAskedAt: number | null;
  consentAsk: string | null;
  consentAnswer: string | null;
} {
  let askedIndex = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.out && isConsentQuestion(m.message)) {
      askedIndex = i;
      break;
    }
  }
  if (askedIndex < 0) {
    return {
      consent: 'not-asked',
      consentAskedAt: null,
      consentAsk: null,
      consentAnswer: null,
    };
  }

  const askedAt = history[askedIndex].date;
  const ask = history[askedIndex].message;

  for (let i = askedIndex + 1; i < history.length; i++) {
    const m = history[i];
    if (m.out) continue;
    const text = m.message;
    // Отказ проверяем первым: «да нет, не надо» содержит и «да», и «нет».
    if (CONSENT_NO.some((re) => re.test(text))) {
      return {
        consent: 'refused',
        consentAskedAt: askedAt,
        consentAsk: ask,
        consentAnswer: text,
      };
    }
    if (CONSENT_YES.some((re) => re.test(text))) {
      return {
        consent: 'given',
        consentAskedAt: askedAt,
        consentAsk: ask,
        consentAnswer: text,
      };
    }
    // Ответил, но не про то — молчанием это не считаем и дальше не идём:
    // разговор ушёл в сторону, согласия нет.
    return {
      consent: 'asked-no-answer',
      consentAskedAt: askedAt,
      consentAsk: ask,
      consentAnswer: text,
    };
  }

  return {
    consent: 'asked-no-answer',
    consentAskedAt: askedAt,
    consentAsk: ask,
    consentAnswer: null,
  };
}

export function detectReview(input: HistoryMessage[]): ReviewCandidate | null {
  // GramJS отдаёт от новых к старым, а согласие читается строго по порядку:
  // «спросили → ответили». Сортируем здесь, а не на стороне вызова, — тогда
  // функция верна при любом входе и её нельзя сломать чужим рефакторингом.
  const history = [...(input ?? [])].sort((a, b) => a.date - b.date);
  const quotes: ReviewQuote[] = [];

  for (const m of history) {
    if (m.out) continue;
    const text = m.message.trim();
    if (text.length < MIN_QUOTE_LEN || text.length > MAX_QUOTE_LEN) continue;
    if (looksLikeDecline(text)) continue;

    const score = matchCount(text, PRAISE);
    if (score === 0) continue;
    // Хвалит, но не нас — мимо.
    if (matchCount(text, TOPIC) === 0) continue;

    quotes.push({ at: m.date, text, score });
  }

  if (quotes.length === 0) return null;

  // Сильные вперёд, при равном счёте — свежие: продукт меняется, и отзыв
  // полугодовой давности может описывать то, чего уже нет.
  quotes.sort((a, b) => b.score - a.score || b.at - a.at);

  return { quotes, ...detectConsent(history) };
}
