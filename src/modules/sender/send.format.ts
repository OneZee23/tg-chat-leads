import { SendReport } from '@modules/sender/sender.service';

/**
 * Человекочитаемый вывод рассылки.
 *
 * Ручки сендера раньше отдавали сырой JSON: в терминале это нечитаемо, а
 * рассылка — единственное место, где цена невнимательности измеряется
 * доверием живых людей к аккаунту. Поэтому текст, как у outreach-ручек.
 *
 * Каждый экран заканчивается ОДНОЙ подсказкой, что делать дальше: держать
 * порядок команд в голове не нужно.
 */

export interface SendStatusView {
  running: boolean;
  dryRun: boolean;
  dailyBudget: { limit: number; used: number; remaining: number; resetsAt: Date | null };
  scheduler: { active: boolean; window: string; nextSendAt: string | null };
  floodSummary: string;
  floodActive: number;
  /** Отправка началась, исход неизвестен — разбирать руками. */
  unfinishedCount: number;
  outreach: { contacted: number; replied: number };
  /** Ответили и ждут нашего ответа (по базе). */
  awaitingReply: number;
  /** Отобраны, но ещё не написаны. */
  queued: number;
}

export function formatSendStatus(s: SendStatusView): string {
  const b = s.dailyBudget;
  const lines: string[] = [
    '',
    'Состояние',
    '',
    `  Написано всего: ${s.outreach.contacted}   ответили: ${s.outreach.replied}` +
      (s.outreach.contacted > 0
        ? `   (${Math.round((s.outreach.replied / s.outreach.contacted) * 100)}%)`
        : ''),
    `  Ждут нашего ответа: ${s.awaitingReply}`,
    `  В очереди на отправку: ${s.queued}`,
    '',
    `  Суточный бюджет: ${b.used} из ${b.limit}, осталось ${b.remaining}` +
      (b.remaining === 0 && b.resetsAt ? `, освободится в ${hhmm(b.resetsAt)}` : ''),
    `  Режим отправки: ${s.dryRun ? 'предпросмотр (SEND_DRY_RUN=true)' : 'боевой'}`,
    `  Планировщик: ${s.scheduler.active ? `включён, окно ${s.scheduler.window}` : 'выключен'}`,
  ];

  if (s.floodActive > 0) lines.push(`  ⚠ Лимиты Telegram: ${s.floodSummary}`);
  if (s.unfinishedCount > 0) {
    lines.push(`  ⚠ Застряли в отправке: ${s.unfinishedCount} — исход неизвестен`);
  }
  if (s.running) lines.push('  ⚠ Рассылка идёт прямо сейчас');

  lines.push('', '—'.repeat(60), nextStep(s), '');
  return lines.join('\n');
}

/**
 * Один совет, а не список. Порядок не произвольный:
 *
 *  1. Зажатый аккаунт перебивает всё — любое действие утяжеляет ограничение.
 *  2. Застрявшие отправки: пока не разобрано, неизвестно, получил человек
 *     сообщение или нет, и повтор рискует стать дублем.
 *  3. Ответить тому, кто уже написал, ценнее, чем написать незнакомцу:
 *     это тёплый контакт, и он ждёт.
 *  4. Только потом новая рассылка.
 */
function nextStep(s: SendStatusView): string {
  if (s.running) return 'Дальше: дождись конца текущей рассылки.';
  if (s.floodActive > 0) {
    return `Дальше: переждать. Telegram зажал аккаунт — ${s.floodSummary}.`;
  }
  if (s.unfinishedCount > 0) {
    return 'Дальше: разобрать застрявшие — yarn send:release';
  }
  if (s.awaitingReply > 0) {
    return `Дальше: ${s.awaitingReply} чел. ждут ответа — yarn inbox`;
  }
  if (s.dailyBudget.remaining === 0) {
    const when = s.dailyBudget.resetsAt
      ? ` Освободится в ${hhmm(s.dailyBudget.resetsAt)}.`
      : '';
    return `Дальше: суточный бюджет исчерпан, на сегодня всё.${when}`;
  }
  if (s.queued > 0) return 'Дальше: посмотреть, кому уйдёт — yarn send';
  return 'Дальше: очередь пуста, добрать новых — yarn refresh';
}

export function formatSendReport(report: SendReport): string {
  const head = report.dryRun
    ? 'ПРЕДПРОСМОТР (ничего не отправлено)'
    : 'Рассылка выполнена';
  const lines: string[] = ['', head, ''];

  report.entries.forEach((e, i) => {
    const what = e.result === 'failed' ? `ОШИБКА: ${e.error ?? ''}` : LABEL[e.result];
    lines.push(`${String(i + 1).padStart(3, ' ')}. @${e.username}  ·  ${what}`);
  });

  const b = report.dailyBudget;
  lines.push('', '—'.repeat(60));
  lines.push(`${report.dryRun ? 'Ушло бы' : 'Отправлено'}: ${report.sent}`);
  if (report.failed > 0) lines.push(`Ошибок: ${report.failed}`);
  if (report.skipped > 0) lines.push(`Пропущено: ${report.skipped}`);
  lines.push(`Суточный бюджет: ${b.used} из ${b.limit}, осталось ${b.remaining}`);

  // Фатальную остановку нельзя оставлять строкой среди счётчиков: PEER_FLOOD
  // означает, что аккаунт уже ограничен за рассылку незнакомцам, и каждая
  // следующая попытка только утяжеляет ограничение.
  if (report.fatal) {
    lines.push('');
    lines.push(`⛔ ОСТАНОВЛЕНО: ${report.stoppedBecause}`);
    lines.push(
      '   Не запускай повторно — переждать. Подробности: docs/postmortem-spam-ban.md',
    );
  } else {
    lines.push(`Остановка: ${report.stoppedBecause}`);
  }

  if (report.dryRun && !report.fatal) {
    lines.push('');
    lines.push('Если всё верно — отправить: yarn send:go');
  }

  lines.push('');
  return lines.join('\n');
}

const LABEL: Record<string, string> = {
  sent: 'отправлено',
  'dry-run': 'уйдёт',
  skipped: 'пропущено',
  failed: 'ОШИБКА',
};

function hhmm(at: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(at.getHours())}:${p(at.getMinutes())}`;
}
