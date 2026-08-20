import { buildHook } from '@modules/sender/outreach-message';

/**
 * Разбор ответа человека и заготовка реплики.
 *
 * Задача — не написать финальный текст за тебя, а рассортировать входящие:
 * на явный отказ и тёплое «хочу попробовать» заготовка годится как есть,
 * а вопрос отдаём тебе с пометкой — на вопрос про конкретную фичу шаблон
 * ответит неверно (можно случайно пообещать то, чего нет), поэтому такие
 * пишутся руками.
 */

export type ReplyKind = 'decline' | 'question' | 'positive' | 'neutral';

export interface ReplySuggestion {
  kind: ReplyKind;
  /** Готовый черновик или null, если нужен ручной ответ. */
  draft: string | null;
  /** Что делать дальше, одной строкой. */
  hint: string;
}

const DECLINE_MARKERS = [
  'не интересует',
  'не интересно',
  'неинтересно',
  'спасибо, нет',
  'нет, спасибо',
  'не нужно',
  'не надо',
  'не актуально',
  'не подходит',
  'уже есть',
  'не пользуюсь',
];

const POSITIVE_MARKERS = [
  'хочу',
  'давайте',
  // Два стема глагола «попробовать»: «пробу» (попробую/опробую/пробую) и
  // «пробов» (попробовать/попробовала). Голый «проб» брать нельзя — заденет
  // «проблема».
  'пробу',
  'пробов',
  'отлично',
  'удобно',
  'круто',
  'прикольно',
  'интересно',
  'посмотрю',
  'гляну',
  'зарегистрир',
  'спасибо',
  'класс',
  'супер',
];

const LINK = 'teachtrack.ru, вход по почте';

const ONBOARDING = `Спасибо, приятно) Заходите — ${LINK}. «Мои ученики» → «Добавить ученика», можно вставить сразу списком из Excel или текстом, самим ученикам регистрироваться не нужно. Что-то не сойдётся — напишите, подскажу.`;

const SOFT = `Спасибо! Ссылка — ${LINK}. Будут вопросы или чего-то не хватит — пишите, помогу настроить.`;

const DECLINE = `Понял, спасибо что ответили) Если вдруг пригодится — ссылка будет тут. Удачи с учениками!`;

export function classifyReply(text: string): ReplyKind {
  const normalized = (text ?? '').toLowerCase().replace(/ё/g, 'е');
  if (normalized.trim().length === 0) return 'neutral';

  // Отказ проверяем первым: «спасибо, не интересует» содержит и «спасибо»
  // (позитивный маркер), но по сути это нет.
  if (DECLINE_MARKERS.some((m) => normalized.includes(m))) return 'decline';

  // Вопрос — раньше позитива: «выглядит удобно, а есть доска?» тёплый по
  // тону, но требует конкретного ответа, а не ссылки.
  if (normalized.includes('?')) return 'question';

  if (POSITIVE_MARKERS.some((m) => normalized.includes(m))) return 'positive';

  return 'neutral';
}

export function suggestReply(text: string): ReplySuggestion {
  const kind = classifyReply(text);

  switch (kind) {
    case 'decline':
      return {
        kind,
        draft: DECLINE,
        hint: 'вежливый отказ — ответь и пометь: yarn skip',
      };
    case 'question':
      return {
        kind,
        draft: null,
        hint: 'вопрос — ответь сам, шаблон соврёт (может пообещать несуществующее)',
      };
    case 'positive':
      return { kind, draft: ONBOARDING, hint: 'тёплый — веди в онбординг' };
    default:
      return { kind, draft: SOFT, hint: 'нейтральный — лёгкое касание' };
  }
}

// Реэкспорт, чтобы worklist мог показать, как звучал наш исходный хук —
// удобно вспомнить, на что человек отвечает.
export { buildHook };

// ─────────────────────────────────────────────────────────────────────────
//  Авто-ответ по шаблону
// ─────────────────────────────────────────────────────────────────────────
//
// Отвечаем шаблоном ТОЛЬКО на однозначные случаи:
//  • явный позитив/обещание попробовать → «рад, что заинтересовало»;
//  • явный отказ → «спасибо, что ответили».
// Вопрос и нейтральное (просто «здравствуйте», «я посредник…») отдаём
// человеку: шаблон на них либо соврёт, либо прозвучит невпопад.
//
// Тексты — ровно те, которыми OneZee отвечал руками, дословно.

const AUTO_POSITIVE =
  'Супер, рад что заинтересовало)\n\n' +
  'Если будут вопросы или возможно найдете какие-то недочеты, пишите, исправлю быстро';

const AUTO_DECLINE = 'Спасибо, что в любом случае ответили :)';

export interface AutoReply {
  kind: ReplyKind;
  /** Текст авто-ответа или null, если случай надо разобрать руками. */
  text: string | null;
}

export function autoReplyTemplate(text: string): AutoReply {
  const kind = classifyReply(text);
  switch (kind) {
    case 'positive':
      return { kind, text: AUTO_POSITIVE };
    case 'decline':
      return { kind, text: AUTO_DECLINE };
    // question и neutral — только руками.
    default:
      return { kind, text: null };
  }
}
