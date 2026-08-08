/**
 * Эвристика «это преподаватель, который рекламирует свои услуги».
 *
 * Задача не в том, чтобы поймать всех — а в том, чтобы список, который ты
 * потом читаешь глазами, состоял в основном из нужных людей. Поэтому:
 *  • баллы складываются из независимых сигналов (профессия + предложение +
 *    цена + контакт + длина), одного сигнала мало;
 *  • стоп-слова обнуляют счёт целиком — в чатах преподавателей половина
 *    сообщений это «ищу репетитора для сына», и такие люди нам не лиды;
 *  • каждый сработавший маркер сохраняется в matched_keywords, чтобы было
 *    видно, ПОЧЕМУ человек попал в выборку, и можно было крутить пороги
 *    осмысленно.
 */

export interface AdDetectionResult {
  score: number;
  isAd: boolean;
  /** Что сработало, с префиксом группы: `job:репетитор`, `price:руб`, … */
  keywords: string[];
}

export interface AdDetectorOptions {
  minScore: number;
  /** Добавки из AD_EXTRA_KEYWORDS — идут в группу job. */
  extraKeywords?: string[];
  extraStopWords?: string[];
}

/** Кем человек себя называет / что преподаёт. Самый сильный сигнал. */
const JOB_MARKERS = [
  'репетитор',
  'преподавател',
  'преподаю',
  'учител',
  'тренер',
  'наставник',
  'коуч',
  'педагог',
  // языки
  'английск',
  'немецк',
  'французск',
  'испанск',
  'итальянск',
  'китайск',
  'турецк',
  'арабск',
  'корейск',
  'японск',
  'польск',
  'русский как иностранный',
  'ielts',
  'toefl',
  // школьные предметы
  'математик',
  'физик',
  'химии',
  'химия',
  'биолог',
  'информатик',
  'обществознан',
  'огэ',
  'егэ',
  // музыка и вокал
  'вокал',
  'сольфеджио',
  'фортепиано',
  'пианино',
  'гитар',
  'скрипк',
  'барабан',
  'музыкальн',
  // тело и творчество
  'йога',
  'пилатес',
  'фитнес',
  'танц',
  'рисован',
  'живопис',
  'лепк',
  'шахмат',
  'программирован',
  'логопед',
  'дефектолог',
];

/** Предложение услуги: человек зовёт к себе, а не спрашивает. */
const OFFER_MARKERS = [
  'набираю',
  'набор ',
  'идёт набор',
  'идет набор',
  'свободные окна',
  'свободное окно',
  'свободные места',
  'есть места',
  'есть окошк',
  'приглашаю',
  'провожу',
  'обучаю',
  'занятия',
  'уроки',
  'курс',
  'мастер-класс',
  'пробное',
  'пробный',
  'первое занятие',
  'индивидуальн',
  'запишитесь',
  'записаться',
  'запись на',
  'мой опыт',
  'стаж',
];

/** Цена — почти безошибочный признак объявления, а не разговора. */
const PRICE_MARKERS = [
  'руб',
  '₽',
  'р/час',
  'руб/час',
  'за час',
  'в час',
  'стоимость',
  'цена',
  'прайс',
  'оплата',
  'сум',
  'тенге',
  'грн',
  '$',
];

/** Куда писать. Есть контакт — значит объявление адресовано читателям. */
const CONTACT_MARKERS = [
  'в лс',
  'в личку',
  'в личные',
  'личные сообщения',
  'пишите',
  'напишите',
  'обращайтесь',
  'директ',
  'whatsapp',
  'вотсап',
  'телеграм',
  'wa.me',
  't.me/',
];

const CONTACT_PATTERNS: Array<[string, RegExp]> = [
  ['contact:@nick', /(^|[^a-z0-9_])@[a-z][a-z0-9_]{3,31}\b/],
  ['contact:link', /(?:t\.me|telegram\.me|wa\.me)\//],
  // Телефон: 10-15 цифр с разделителями. Требуем ведущий + или 8/7,
  // иначе в него попадают года, цены и номера кабинетов.
  ['contact:phone', /(?:\+|\b8|\b7)[\s\-(]?\d{3}[\s\-)]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2}\b/],
];

/**
 * Обнуляют счёт. Здесь два разных класса «не наших»:
 *  • ученик/родитель ищет преподавателя;
 *  • школа/агентство ищет сотрудника (это работодатель, не самозанятый).
 */
const STOP_MARKERS = [
  'ищу репетитор',
  'ищу преподавател',
  'ищу учител',
  'ищу тренер',
  'ищу педагог',
  'ищем репетитор',
  'ищем преподавател',
  'ищем учител',
  'нужен репетитор',
  'нужен преподавател',
  'нужна репетитор',
  'нужен учител',
  'нужен тренер',
  'требуется репетитор',
  'требуется преподавател',
  'требуются преподавател',
  'посоветуйте репетитор',
  'посоветуйте преподавател',
  'подскажите репетитор',
  'порекомендуйте репетитор',
  'вакансия',
  'вакансии',
  'наша школа',
  'наш центр',
  'в нашу команду',
];

const MIN_LONG_MESSAGE = 150;

export class AdDetector {
  private readonly minScore: number;

  private readonly jobMarkers: string[];

  private readonly stopMarkers: string[];

  constructor(options: AdDetectorOptions) {
    this.minScore = options.minScore;
    this.jobMarkers = [...JOB_MARKERS, ...(options.extraKeywords ?? [])];
    this.stopMarkers = [...STOP_MARKERS, ...(options.extraStopWords ?? [])];
  }

  public detect(rawText: string): AdDetectionResult {
    const text = normalize(rawText);
    if (text.length === 0) {
      return { score: 0, isAd: false, keywords: [] };
    }

    const stopHit = this.stopMarkers.find((marker) => text.includes(normalize(marker)));
    if (stopHit) {
      return { score: 0, isAd: false, keywords: [`stop:${stopHit}`] };
    }

    const keywords: string[] = [];
    let score = 0;

    // Профессия весит два балла: без неё сообщение почти наверняка
    // не объявление преподавателя, даже если в нём есть цена и контакт.
    const job = firstHit(text, this.jobMarkers);
    if (job) {
      score += 2;
      keywords.push(`job:${job}`);
    }

    const offer = firstHit(text, OFFER_MARKERS);
    if (offer) {
      score += 1;
      keywords.push(`offer:${offer.trim()}`);
    }

    const price = firstHit(text, PRICE_MARKERS);
    if (price) {
      score += 1;
      keywords.push(`price:${price}`);
    }

    const contact = firstHit(text, CONTACT_MARKERS);
    if (contact) {
      score += 1;
      keywords.push(`contact:${contact}`);
    } else {
      const pattern = CONTACT_PATTERNS.find(([, regex]) => regex.test(text));
      if (pattern) {
        score += 1;
        keywords.push(pattern[0]);
      }
    }

    if (text.length >= MIN_LONG_MESSAGE) {
      score += 1;
      keywords.push('len:long');
    }

    return { score, isAd: score >= this.minScore, keywords };
  }
}

/**
 * ё → е, схлопнутые пробелы, нижний регистр. Без этого «Ищу Репетитора»
 * и «ищу  репетитора» проходят мимо стоп-слов.
 */
function normalize(text: string): string {
  return (text ?? '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}

function firstHit(text: string, markers: string[]): string | undefined {
  return markers.find((marker) => text.includes(normalize(marker)));
}
