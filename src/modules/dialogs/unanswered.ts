/**
 * Что в диалоге осталось без нашего ответа.
 *
 * Курсор — дата ПОСЛЕДНЕГО нашего исходящего, а не первого письма. Так было
 * не всегда: `autoReplyUnanswered` считает от `contacted_at`, и поэтому
 * диалог, где мы ответили хотя бы раз, становится невидимым навсегда —
 * человек, написавший «а как завести учеников?» после нашего ответа,
 * терялся. А это самые тёплые лиды из всех.
 */

export interface HistoryMessage {
  /** true — наше исходящее, false — его. */
  out: boolean;
  /** Unix-секунды, как отдаёт GramJS. */
  date: number;
  message: string;
}

export interface UnansweredSlice {
  /** Дата, после которой всё входящее считается неотвеченным. */
  cursorSec: number;
  /** Непустые входящие после курсора, от старых к новым. Пусто — отвечать нечего. */
  incoming: HistoryMessage[];
  /** Вся переписка от старых к новым — контекст для ответа. */
  history: HistoryMessage[];
}

export function sliceUnanswered(
  messages: HistoryMessage[],
  contactedAtSec: number,
): UnansweredSlice {
  // GramJS отдаёт от новых к старым; и читать, и рендерить удобнее наоборот.
  const history = [...(messages ?? [])].sort((a, b) => a.date - b.date);

  const outgoing = history.filter((m) => m.out);
  // Нашего исходящего в окне нет вовсе (человек написал больше сообщений, чем
  // мы читаем) — падаем назад на дату письма. Иначе курсора не будет совсем
  // и в выгрузку уедет вся переписка.
  const cursorSec =
    outgoing.length > 0 ? outgoing[outgoing.length - 1].date : contactedAtSec;

  const incoming = history.filter(
    (m) => !m.out && m.date > cursorSec && (m.message ?? '').trim().length > 0,
  );

  return { cursorSec, incoming, history };
}
