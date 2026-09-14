/**
 * Скоринг авторов чата как потенциальных рефереров.
 *
 * Зачем отдельно от research: ResearchService ищет СООБЩЕНИЯ (что говорят про
 * визу), а здесь нужны ЛЮДИ (кому писать). Это разные единицы: одно
 * содержательное сообщение полезно само по себе, а человек интересен суммой
 * своих реплик за месяцы.
 *
 * Всё в этом файле — чистые функции без сети и без Telegram, чтобы скоринг
 * можно было чинить по тестам, а не прогоном по живому чату.
 */

/**
 * Сигнал — это признак, по которому автор попадает в список.
 *
 * Раньше здесь был один флоский union — профиль поиска рефереров (визовые
 * чаты). Профиль репетиторов (`TutorSignal`) добавлен рядом, а не внутри:
 * общий `LeadSignal` — это просто их объединение, поэтому старый код,
 * который не знает о профилях, продолжает видеть ровно тот же тип для тех же
 * значений.
 */
export type ReferralSignal =
  | 'hiring' // его команда нанимает прямо сейчас
  | 'referral' // сам говорит про рефералы
  | 'insider' // называет свою компанию, работает изнутри
  | 'relocated' // уже переехал, прошёл путь
  | 'stack' // совпадение по стеку
  | 'recruiter' // рекрутёр или HR
  | 'seeker'; // САМ ищет работу — отрицательный сигнал, см. WEIGHTS

/** Профиль репетиторов: не «кому написать», а «о чём болит». См. TUTOR_PROFILE. */
export type TutorSignal =
  | 'tool_search' // прямо спрашивает, чем вести учёт — самый сильный сигнал
  | 'accounting_pain' // учёт разваливается: тетрадь, эксель, «запуталась»
  | 'payment_pain' // не помнит, кто должен и сколько
  | 'package_pain' // путаница с пакетами/абонементами/предоплатой
  | 'cancellation_pain' // отмены и перенос в последний момент
  | 'reminder_pain' // ученики забывают про занятие, надо напоминать руками
  | 'scale' // признак масштаба практики — усиливает остальные сигналы
  | 'school' // не отрицательный: отдельный сегмент (школы, языковые центры)
  | 'self_promo' // отрицательный: реклама своих услуг, а не боль
  | 'student_side'; // отрицательный: это клиент, а не преподаватель

export type LeadSignal = ReferralSignal | TutorSignal;

/**
 * Границы слова заданы через \p{L}, а не через \b.
 *
 * \b в JavaScript определяется по \w, то есть по [A-Za-z0-9_], и с кириллицей
 * просто не работает: /\bищем\b/ не находит «ищем» никогда. Ошибка тихая —
 * regex валиден, сигналов нет, скоринг молча возвращает нули.
 */
const WORD_START = '(?<![\\p{L}\\p{N}])';
const WORD_END = '(?![\\p{L}\\p{N}])';

function phrase(body: string): RegExp {
  return new RegExp(`${WORD_START}(?:${body})${WORD_END}`, 'iu');
}

const PATTERNS: ReadonlyArray<readonly [ReferralSignal, RegExp]> = [
  [
    // Только ПЕРВОЕ ЛИЦО. Прежний широкий «нанима\\p{L}*» ловил рассуждения о
    // найме вообще («сейчас мало кто нанимает»), и в визовом чате, где найм
    // обсуждают все подряд, метку получал каждый второй.
    'hiring',
    phrase(
      'мы\\s+(?:ищем|нанимаем|набираем)|' +
        // «ищем сеньора в команду»: между глаголом и объектом бывает пара слов,
        // поэтому допускаем их, но не даём разъехаться на всё предложение.
        'ищем(?:\\s+\\p{L}+){0,3}\\s+(?:в\\s+команду|разработчик\\p{L}*|инженер\\p{L}*|' +
        'бэкенд\\p{L}*|backend|сеньор\\p{L}*|senior|к\\s+нам)|' +
        'у\\s+нас\\s+(?:открыт\\p{L}*|есть\\s+ваканс\\p{L}*|ищут)|вакансия\\s+у\\s+нас|' +
        "к\\s+нам\\s+(?:в\\s+команду|нужен)|we['`\u2019]?re\\s+hiring|" +
        'нам\\s+нужен\\s+(?:бэкенд\\p{L}*|backend|разработчик\\p{L}*)|' +
        'we\\s+are\\s+(?:hiring|looking\\s+for)|my\\s+team\\s+is\\s+hiring|' +
        'we\\s+have\\s+an?\\s+open(?:ing|\\s+role|\\s+position)',
    ),
  ],
  [
    // Только ПРЕДЛОЖЕНИЕ реферала. Прежний широкий «рефер\\p{L}*» ловил и просьбы
    // («мне бы кто помог рефералками»), а просящий — такой же соискатель,
    // и он в этом списке не нужен: помочь он не может.
    'referral',
    phrase(
      '(?:могу|мог\\s+бы|готов\\p{L}*)\\s+(?:за)?рефер\\p{L}*|зарефералю|зарефер\\p{L}*\\s+(?:вас|тебя|к\\s+нам)|' +
        'закину\\s+(?:тво[её]|ваше|ваш|твой)?\\s*(?:резюме|cv)|могу\\s+передать\\s+(?:cv|резюме)|' +
        'скидывайте\\s+(?:cv|резюме)|пришлите\\s+(?:cv|резюме)|' +
        'у\\s+нас\\s+есть\\s+(?:рефераль\\p{L}*|referral)|referral\\s+(?:бонус|програм\\p{L}*|program)|' +
        'бонус\\s+за\\s+рекомендац\\p{L}*|' +
        '(?:happy|glad|can)\\s+to\\s+refer|can\\s+refer\\s+you|I\\s+can\\s+refer|' +
        'send\\s+me\\s+your\\s+(?:cv|resume)|ping\\s+me\\s+your\\s+(?:cv|resume)',
    ),
  ],
  [
    // Человек в поиске работы — не реферер. Ловим явные признаки, чтобы такие
    // уходили в минус, а не поднимались за упоминание стека и рефералов.
    'seeker',
    phrase(
      'я\\s+(?:сейчас\\s+)?(?:ищу|в\\s+поиске)\\s+(?:работу|работы|вакансии)|' +
        'мне\\s+бы\\s+кто\\s+помог|помогите\\s+(?:найти|с\\s+поиском)|' +
        'ищу\\s+(?:контакты\\s+рекрутеров|рефералк\\p{L}*|реферал\\p{L}*)|' +
        'кто\\s+(?:может|сможет)\\s+зарефер\\p{L}*|нужен\\s+реферал|' +
        'безработиц\\p{L}*|я\\s+безработн\\p{L}*|сижу\\s+без\\s+работы|' +
        'не\\s+могу\\s+найти\\s+работу|откликаюсь\\s+уже|' +
        // «если кто-то знает вакансию и готов зарефералить отличного сеньора» -
        // это просьба, хотя звучит как предложение: реферят не автора, а от автора.
        'если\\s+(?:вдруг\\s+)?кто-то\\s+знает|дайте\\s+знать|' +
        'готов\\p{L}*\\s+зарефералить\\s+(?:отличн\\p{L}*|хорош\\p{L}*|сильн\\p{L}*)',
    ),
  ],
  [
    'insider',
    phrase(
      'я\\s+работаю\\s+в|работаю\\s+в\\s+\\p{Lu}\\p{L}*|у\\s+нас\\s+в\\s+(?:компании|команде)|' +
        'наша\\s+компания|наша\\s+команда|мой\\s+работодатель|' +
        'I\\s+work\\s+(?:at|for)\\s+\\p{Lu}\\p{L}*|here\\s+at\\s+\\p{Lu}\\p{L}*|' +
        'at\\s+my\\s+company|in\\s+my\\s+team',
    ),
  ],
  [
    'relocated',
    phrase(
      'я\\s+переехал\\p{L}*|мы\\s+переехали|когда\\s+я\\s+переезжал|' +
        'получил\\p{L}*\\s+(?:blue\\s*card|голубую\\s+карт\\p{L}*|внж)|' +
        'моя\\s+виза\\s+D|прош[её]л\\s+этот\\s+путь|' +
        'I\\s+relocated|I\\s+moved\\s+to\\s+(?:germany|berlin|munich)|' +
        'got\\s+my\\s+blue\\s*card',
    ),
  ],
  [
    'stack',
    phrase('node\\.?js|nest\\.?js|typescript|бэкенд\\p{L}*|backend|бекенд\\p{L}*'),
  ],
  [
    'recruiter',
    phrase(
      'я\\s+рекрутер\\p{L}*|я\\s+рекрутёр\\p{L}*|recruiter|talent\\s+acquisition|' +
        'хантю|хедхант\\p{L}*',
    ),
  ],
];

/** Вес сигнала. Реферал и наём дороже всего: это прямой путь к интервью. */
const WEIGHTS: Readonly<Record<ReferralSignal, number>> = {
  referral: 10,
  hiring: 8,
  insider: 5,
  relocated: 3,
  stack: 3,
  recruiter: 2,
  // Отрицательный и тяжёлый: человек в поиске работы перекрывает свои плюсы.
  // Проверено на живой выдаче 13.09 — трое из топ-4 оказались соискателями,
  // поднявшимися за упоминание стека и слова «рефералка» в просьбе о помощи.
  seeker: -12,
};

/**
 * Сильные сигналы говорят о ДЕЙСТВИИ человека: он нанимает, реферит, он рекрутёр.
 * Слабые - только о его положении: работает где-то, переехал, знает мой стек.
 *
 * Без хотя бы одного сильного человек не кандидат, каким бы активным он ни был.
 * Проверено 13.09: топ занимали участники чатов с меткой «называет свою компанию»
 * за реплики вроде «у нас в компании руководитель в отпуске».
 */
const STRONG_SIGNALS: readonly ReferralSignal[] = ['referral', 'hiring', 'recruiter'];

/**
 * Профиль — это набор { queries, patterns, weights, strongSignals }, который
 * подставляют в скоринг вместо визового по умолчанию. weights объявлен как
 * Partial по ВСЕМУ LeadSignal (а не только по сигналам этого профиля), чтобы
 * профиль репетиторов не был обязан знать про visa-сигналы и наоборот —
 * exhaustive Record<LeadSignal, ...> заставил бы каждый профиль объявлять
 * веса для чужих сигналов.
 */
export interface LeadProfile {
  readonly queries: readonly string[];
  readonly patterns: ReadonlyArray<readonly [LeadSignal, RegExp]>;
  readonly weights: Readonly<Partial<Record<LeadSignal, number>>>;
  readonly strongSignals: readonly LeadSignal[];
}

/**
 * Запросы по умолчанию: не про тему чата, а про ПРИЗНАКИ ЧЕЛОВЕКА, которому
 * стоит написать. Ищем не «как получить визу», а тех, кто нанимает, реферит
 * или работает внутри компании. Живёт здесь (а не в leads.service.ts). чтобы
 * профиль был одним значением, а не собранным из двух файлов.
 *
 * Чисто стековых фраз («Node.js», «бэкенд») здесь НЕТ намеренно. В профильном
 * чате вроде @профильного чата их пишет каждый второй: запрос вернёт потолок находок,
 * съест минуту на чате и не отличит инсайдера от новичка с вопросом. Стек ловится
 * постфактум сигналом `stack` в тексте, найденном по фразам-признакам.
 */
const REFERRAL_QUERIES: readonly string[] = [
  'ищем',
  'нанимаем',
  'вакансия',
  'реферал',
  'зарефералю',
  'referral',
  'закину резюме',
  'скиньте резюме',
  'я работаю в',
  'у нас в компании',
  'наша команда',
  'рекрутер',
  // Английские: в @англоязычного чата и подобных чатах русских фраз почти нет,
  // и без этих строк англоязычный чат отдаёт пустоту.
  'we are hiring',
  "we're hiring",
  'we are looking for',
  'happy to refer',
  'can refer you',
  'I work at',
  'my team',
  'DM me',
  'send me your CV',
];

/** Визовый профиль — прежнее поведение целиком, теперь как значение. */
export const REFERRAL_PROFILE: LeadProfile = {
  queries: REFERRAL_QUERIES,
  patterns: PATTERNS,
  weights: WEIGHTS,
  strongSignals: STRONG_SIGNALS,
};

// --- Профиль репетиторов -----------------------------------------------
//
// Цель другая: не «кому написать», а «о чём чаще всего болит». Источник —
// @канала репетиторов, разговор репетиторов между собой, а не доска объявлений.
// Поэтому здесь нет фраз про тему чата («репетитор») — они дают потолок
// находок и не отличают жалобу от рекламы, см. self_promo/student_side.

const TUTOR_PATTERNS: ReadonlyArray<readonly [TutorSignal, RegExp]> = [
  [
    // Самый сильный: человек сам спрашивает инструмент, а не жалуется вслух.
    'tool_search',
    phrase(
      'чем\\s+(?:вы\\s+)?вед[ёе]те(?:\\s+\\p{L}+){0,2}|' +
        'чем\\s+(?:лучше\\s+)?вести\\s+(?:учёт|занятия|расписание|записи)|' +
        'как(?:ую|ое)\\s+(?:программу|приложение|прилож\\p{L}*|сервис)\\s+' +
        '(?:посовет\\p{L}*|выбрать|использу\\p{L}*|подска\\p{L}*)|' +
        'посовет\\p{L}*\\s+(?:приложение|программу|сервис)|' +
        'в\\s+ч[её]м\\s+вед[ёе]те',
    ),
  ],
  [
    'accounting_pain',
    phrase(
      'веду\\s+(?:всё\\s+)?в\\s+тетрад\\p{L}*|' +
        'веду\\s+в\\s+(?:экселе|excel|таблиц\\p{L}*)|' +
        'запутал\\p{L}*|' +
        'забыл\\p{L}*,?\\s+кто\\s+(?:платил|оплатил|заплатил)|' +
        'потерял\\p{L}*\\s+(?:запис\\p{L}*|учёт|тетрад\\p{L}*)',
    ),
  ],
  [
    'payment_pain',
    phrase(
      'кто\\s+сколько\\s+долж\\p{L}*|' +
        'должн\\p{L}*\\s+(?:мне|денег)|' +
        'долг(?:и|ов|а|ом|у)?|' +
        'не\\s+(?:заплатил\\p{L}*|оплатил\\p{L}*)|' +
        'забыл\\p{L}*\\s+оплатить',
    ),
  ],
  [
    'package_pain',
    phrase(
      'пакет\\p{L}*\\s+(?:занят\\p{L}*|урок\\p{L}*)|' +
        'абонемент\\p{L}*|' +
        'предоплат\\p{L}*|' +
        'сколько\\s+занят\\p{L}*\\s+остал\\p{L}*|' +
        'остал\\p{L}*\\s+занят\\p{L}*',
    ),
  ],
  [
    'cancellation_pain',
    phrase(
      // Между «отменил» и «за час» бывает объект («занятие»), допускаем пару слов.
      'отмени\\p{L}*(?:\\s+\\p{L}+){0,2}\\s+за\\s+час|' +
        'не\\s+приш(?:[её]л|ла|ли)|' +
        'не\\s+предупредил\\p{L}*|' +
        'перенос(?:ы|ов|а|е)?|' +
        'перенес\\p{L}*\\s+занят\\p{L}*',
    ),
  ],
  [
    'reminder_pain',
    phrase(
      'забыва\\p{L}*\\s+про\\s+(?:занят\\p{L}*|урок\\p{L}*)|' +
        'напомина\\p{L}*\\s+кажд\\p{L}*|' +
        'приходится\\s+(?:писать|напомина\\p{L}*)',
    ),
  ],
  [
    // Усиливающий, не отсекающий сам по себе: масштаб без боли — просто факт.
    'scale',
    phrase(
      'у\\s+меня\\s+\\d+\\s+учен\\p{L}*|' +
        'набрал\\p{L}*\\s+групп\\p{L}*|' +
        'полн\\p{L}*\\s+запис\\p{L}*',
    ),
  ],
  [
    // НЕ отрицательный: школы и центры — отдельный живой сегмент продукта,
    // их нужно видеть в дайджесте отдельно, а не отсеивать как шум.
    'school',
    phrase(
      'наша\\s+школ\\p{L}*|' +
        'у\\s+нас\\s+(?:своя|собственная)?\\s*школ\\p{L}*|' +
        'языков\\p{L}*\\s+центр\\p{L}*|' +
        '(?:\\d+|два|три|несколько)\\s+преподавател\\p{L}*',
    ),
  ],
  [
    // Отрицательный: это реклама себя, а не разговор о боли.
    'self_promo',
    phrase(
      'ищу\\s+учеников|' +
        'свободн\\p{L}*\\s+окн\\p{L}*|' +
        'запис\\p{L}*\\s+открыт\\p{L}*|' +
        'стоимость\\s+занят\\p{L}*|' +
        'цена\\s+занят\\p{L}*|' +
        'беру\\s+новых\\s+учеников',
    ),
  ],
  [
    // Отрицательный: автор — клиент, а не преподаватель.
    'student_side',
    phrase(
      'ищу\\s+репетитор\\p{L}*|' +
        'посовет\\p{L}*\\s+(?:репетитор\\p{L}*|преподавател\\p{L}*)|' +
        'подскаж\\p{L}*\\s+репетитор\\p{L}*|' +
        'нужен\\s+репетитор\\p{L}*',
    ),
  ],
];

/** Вес сигнала для профиля репетиторов. Расставлен по смыслу, не измерен на живой выдаче. */
const TUTOR_WEIGHTS: Readonly<Record<TutorSignal, number>> = {
  tool_search: 12, // прямой вопрос про инструмент — сильнее любой боли
  accounting_pain: 5,
  payment_pain: 5,
  package_pain: 5,
  cancellation_pain: 5,
  reminder_pain: 5,
  scale: 2, // усилитель: сам по себе ничего не значит
  school: 3, // отдельный сегмент, не штраф — но и не боль сама по себе
  self_promo: -10,
  student_side: -10,
};

/**
 * Сильные — прямой вопрос про инструмент и любая конкретная боль: это то, что
 * реально идёт в дайджест как формулировка. `scale` и `school` — только метки,
 * без боли рядом это не тема для статьи, а факт о человеке.
 */
const TUTOR_STRONG_SIGNALS: readonly TutorSignal[] = [
  'tool_search',
  'accounting_pain',
  'payment_pain',
  'package_pain',
  'cancellation_pain',
  'reminder_pain',
];

/**
 * Поисковые фразы для @канала репетиторов и подобных: признак человека, а не темы
 * чата. «Репетитор» здесь нет намеренно — в чате репетиторов это слово почти
 * в каждом сообщении, запрос вернёт потолок находок и не отличит жалобу от
 * рекламы.
 */
const TUTOR_QUERIES: readonly string[] = [
  'чем ведёте',
  'чем вести',
  'какую программу',
  'посоветуйте приложение',
  'в чём ведёте',
  'веду в тетради',
  'веду в экселе',
  'запуталась',
  'запутался',
  'забыла кто платил',
  'кто сколько должен',
  'забыл оплатить',
  'не заплатил',
  'пакет занятий',
  'абонемент',
  'предоплата',
  'сколько занятий осталось',
  'отменил за час',
  'не пришёл на занятие',
  'не предупредил',
  'перенос занятия',
  'забывают про занятие',
  'напоминаю каждому',
  'приходится писать',
  'наша школа',
  'языковой центр',
];

export const TUTOR_PROFILE: LeadProfile = {
  queries: TUTOR_QUERIES,
  patterns: TUTOR_PATTERNS,
  weights: TUTOR_WEIGHTS,
  strongSignals: TUTOR_STRONG_SIGNALS,
};

export type LeadProfileName = 'referral' | 'tutor';

const LEAD_PROFILES: Readonly<Record<LeadProfileName, LeadProfile>> = {
  referral: REFERRAL_PROFILE,
  tutor: TUTOR_PROFILE,
};

/** Без имени — визовый профиль, как и раньше. */
export function getLeadProfile(name?: LeadProfileName): LeadProfile {
  return LEAD_PROFILES[name ?? 'referral'];
}

export function hasStrongSignal(
  signals: readonly LeadSignal[],
  profile: LeadProfile = REFERRAL_PROFILE,
): boolean {
  return signals.some((s) => profile.strongSignals.includes(s));
}

export function detectSignals(
  text: string,
  profile: LeadProfile = REFERRAL_PROFILE,
): LeadSignal[] {
  const found = new Set<LeadSignal>();
  for (const [signal, pattern] of profile.patterns) {
    if (pattern.test(text)) found.add(signal);
  }
  return [...found];
}

/**
 * Названия компаний из текста. Ловим латинские имена с заглавной буквы,
 * потому что в русскоязычном чате работодателя почти всегда пишут латиницей
 * («работаю в Zalando»), а кириллические слова с заглавной — это чаще начало
 * предложения, и они дают сплошной шум.
 */
// Технологии и общие слова. Без этого в «компаниях» инженера оказываются
// AWS, EBS, LUN, LVM и NFS - проверено 13.09 на реальной выдаче.
const COMPANY_STOPWORDS = new Set([
  'I',
  'A',
  'The',
  'Blue',
  'Card',
  'Германия',
  'Berlin',
  // языки и рантаймы
  'Node',
  'JS',
  'TypeScript',
  'JavaScript',
  'React',
  'Vue',
  'Angular',
  'Python',
  'Java',
  'Kotlin',
  'Go',
  'Golang',
  'Rust',
  'Scala',
  'Ruby',
  'Rails',
  'PHP',
  'NestJS',
  'Next',
  'Express',
  'Django',
  'Spring',
  'Quarkus',
  // инфраструктура и облака
  'AWS',
  'GCP',
  'Azure',
  'EBS',
  'LUN',
  'LVM',
  'NFS',
  'S3',
  'EC2',
  'RDS',
  'Kubernetes',
  'Docker',
  'Helm',
  'Terraform',
  'Linux',
  'Nginx',
  'Redis',
  'Postgres',
  'PostgreSQL',
  'MongoDB',
  'MySQL',
  'Kafka',
  'RabbitMQ',
  'Apache',
  'REST',
  'GraphQL',
  'gRPC',
  'OCI',
  'CI',
  'CD',
  'DevOps',
  'SRE',
  // роли и общие аббревиатуры
  'CV',
  'HR',
  'IT',
  'EU',
  'AI',
  'ML',
  'API',
  'SDK',
  'CTO',
  'CEO',
  'CIO',
  'CPO',
  'FTE',
  'PM',
  'QA',
  'UX',
  'UI',
  'MVP',
  'SaaS',
  'B2B',
  'B2C',
  // ИИ-инструменты: мелькают в разговорах, работодателями почти никогда
  'OpenAI',
  'Anthropic',
  'ChatGPT',
  'Copilot',
  'Cursor',
  'Claude',
  'Gemini',
]);

export function extractCompanies(text: string): string[] {
  const matches = text.match(/\b[A-Z][A-Za-z0-9][A-Za-z0-9.&-]{1,24}\b/g) ?? [];
  const seen = new Set<string>();
  for (const raw of matches) {
    if (COMPANY_STOPWORDS.has(raw)) continue;
    if (raw.length < 3) continue;
    seen.add(raw);
  }
  return [...seen];
}

export interface LeadMessage {
  text: string;
  date: number;
  link: string | null;
}

export interface LeadCandidate {
  author: string;
  messages: LeadMessage[];
  signals: LeadSignal[];
  companies: string[];
  score: number;
  lastSeen: number;
}

/**
 * Автор без юзернейма бесполезен: написать ему всё равно нельзя.
 * Боты тоже: @some_support_bot набрал баллов за упоминания стека.
 */
export function isContactable(author: string): boolean {
  return author.startsWith('@') && !/bot$/i.test(author);
}

export interface ScoredMessage {
  author: string;
  text: string;
  date: number;
  link: string | null;
}

/**
 * Свежесть важнее объёма: человек, писавший вчера, ответит, а тот, кто
 * пропал год назад, скорее всего сменил чат. Полгода — половина веса.
 */
export function recencyFactor(lastSeen: number, now: number): number {
  if (lastSeen <= 0) return 0.5;
  const days = (now - lastSeen) / 86_400;
  if (days <= 30) return 1;
  if (days <= 90) return 0.8;
  if (days <= 180) return 0.6;
  if (days <= 365) return 0.4;
  return 0.2;
}

export function buildCandidates(
  messages: ScoredMessage[],
  now = Math.floor(Date.now() / 1000),
  profile: LeadProfile = REFERRAL_PROFILE,
): LeadCandidate[] {
  const byAuthor = new Map<string, LeadCandidate>();

  for (const message of messages) {
    if (!isContactable(message.author)) continue;

    const existing = byAuthor.get(message.author) ?? {
      author: message.author,
      messages: [],
      signals: [],
      companies: [],
      score: 0,
      lastSeen: 0,
    };

    existing.messages.push({
      text: message.text,
      date: message.date,
      link: message.link,
    });

    for (const signal of detectSignals(message.text, profile)) {
      if (!existing.signals.includes(signal)) existing.signals.push(signal);
    }
    for (const company of extractCompanies(message.text)) {
      if (!existing.companies.includes(company)) existing.companies.push(company);
    }
    if (message.date > existing.lastSeen) existing.lastSeen = message.date;

    byAuthor.set(message.author, existing);
  }

  for (const candidate of byAuthor.values()) {
    const base = candidate.signals.reduce(
      (sum, s) => sum + (profile.weights[s] ?? 0),
      0,
    );
    // Активность без действия ничего не стоит: человек, который много пишет и
    // где-то работает, но не нанимает и не реферит, - собеседник, а не лид.
    if (!hasStrongSignal(candidate.signals, profile)) {
      candidate.score = 0;
      candidate.messages.sort((a, b) => b.date - a.date);
      continue;
    }
    // Второе и третье сообщение подтверждают, что человек живой, но десятое
    // уже ничего не добавляет — поэтому логарифм, а не линейный рост.
    const volume = Math.log2(candidate.messages.length + 1);
    candidate.score =
      Math.round(base * volume * recencyFactor(candidate.lastSeen, now) * 10) / 10;
    candidate.messages.sort((a, b) => b.date - a.date);
  }

  return [...byAuthor.values()].sort((a, b) => b.score - a.score);
}
