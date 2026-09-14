/**
 * Каким аккаунтом писать конкретному человеку.
 *
 * Правило вынесено из сервиса отдельно, потому что оно про репутацию
 * аккаунтов, а не про Telegram: его надо проверять тестами, не поднимая
 * ни одной сессии.
 */

export interface AccountLoad {
  name: string;
  /** Отправлено за скользящие сутки. */
  used: number;
  /** Сколько ещё можно отправить. Без потолка — заведомо большое число. */
  remaining: number;
}

export type PickFailure = 'assigned_exhausted' | 'assigned_missing' | 'all_exhausted';

/**
 * Либо аккаунт, либо причина отказа — ровно одно из двух заполнено.
 *
 * Не размеченное объединение (`{ok: true} | {ok: false}`) намеренно:
 * в проекте `strictNullChecks` выключен, и TypeScript такие союзы не
 * сужает — в каждой ветке пришлось бы приводить тип руками.
 */
export interface PickResult {
  account: string | null;
  reason: PickFailure | null;
}

function ok(account: string): PickResult {
  return { account, reason: null };
}

function no(reason: PickFailure): PickResult {
  return { account: null, reason };
}

/**
 * @param assigned  аккаунт, уже закреплённый за лидом (null — пишем впервые)
 * @param loads     аккаунты, которыми можно писать прямо сейчас
 */
export function pickAccount(assigned: string | null, loads: AccountLoad[]): PickResult {
  if (loads.length === 0) return no('all_exhausted');

  if (assigned) {
    const own = loads.find((a) => a.name === assigned);
    // Закреплённого аккаунта нет среди поднятых: например, человеку писали
    // со второго, а сегодня TG_SESSION_2 не задан. Это не повод писать с
    // другого — для получателя это сообщение от постороннего с тем же
    // текстом.
    if (!own) return no('assigned_missing');
    // И не повод обойти потолок: лид просто ждёт до завтра.
    if (own.remaining <= 0) return no('assigned_exhausted');
    return ok(own.name);
  }

  // Новому человеку пишет тот, кто сегодня написал меньше.
  //
  // Именно по отправленному, а не по остатку: SEND_MAX_PER_DAY по умолчанию
  // 0 («потолка нет»), и тогда остаток у всех одинаково огромный — выбор по
  // остатку молча свёлся бы к «всегда первый», и второй аккаунт не отправил
  // бы ни одного сообщения. Нагрузку надо разложить в обоих случаях: при
  // равном потолке «меньше отправил» и «больше осталось» — одно и то же.
  //
  // При равенстве побеждает первый в списке, а первый всегда основной:
  // пока второй аккаунт прогревается, лишнее лучше отдать обжитому.
  let best: AccountLoad | null = null;
  for (const account of loads) {
    if (account.remaining <= 0) continue;
    if (!best || account.used < best.used) best = account;
  }

  return best ? ok(best.name) : no('all_exhausted');
}

/** Человекочитаемая причина отказа — уходит в отчёт запуска. */
export function describePickFailure(reason: PickFailure): string {
  switch (reason) {
    case 'assigned_exhausted':
      return 'суточный лимит аккаунта, который ведёт переписку, исчерпан';
    case 'assigned_missing':
      return 'аккаунт, который вёл переписку, сейчас не подключён';
    case 'all_exhausted':
      return 'суточные лимиты всех аккаунтов исчерпаны';
  }
}
