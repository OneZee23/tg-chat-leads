import { clipKeepingLinks } from '@modules/outreach/clip';
import type { WaitingDialog } from '@modules/dialogs/dialogs.service';

/**
 * «Слово за нами» — экран, который отвечает на вопрос владельца буквально:
 * где человек написал последним, а мы молчим.
 *
 * Отличается от инбокса источником правды. Инбокс идёт от нашего учёта и
 * уважает прошлые решения: закрытый директивой CLOSE больше не показывается
 * никогда. Здесь наоборот — список строится по состоянию диалогов, а
 * закрытие лишь подписывается рядом. Решение о закрытии принимал ассистент,
 * и владелец имеет право его пересмотреть.
 */
export function formatWaiting(rows: WaitingDialog[]): string {
  if (rows.length === 0) {
    return '\nНи в одном диалоге последнее слово не за человеком. Отвечать некому.\n';
  }

  const open = rows.filter((r) => !r.closedAt);
  const closed = rows.filter((r) => r.closedAt);

  const lines: string[] = [
    '',
    `Слово за нами — ${rows.length} ${plural(rows.length)}.`,
    '',
  ];

  if (open.length > 0) {
    lines.push(`Не закрывали — ${open.length}:`, '');
    open.forEach((r, i) => lines.push(...row(r, i + 1)));
  }

  if (closed.length > 0) {
    lines.push('', '—'.repeat(60), '');
    lines.push(
      `Закрыты без ответа — ${closed.length}. Решение принимал ассистент:`,
      'ответить всё ещё можно, для этого в outbox директива FOLLOWUP.',
      '',
    );
    closed.forEach((r, i) => lines.push(...row(r, i + 1)));
  }

  lines.push('', '—'.repeat(60));
  lines.push('Ответить: попроси ассистента — он соберёт outbox по этому списку.');
  lines.push('');
  return lines.join('\n');
}

function row(r: WaitingDialog, index: number): string[] {
  const who = r.username ? `@${r.username}` : r.name || `id${r.tgUserId}`;
  const marks = [
    r.unread > 0 ? `${r.unread} непрочит.` : null,
    r.closedAt ? `закрыт ${date(r.closedAt)}` : null,
    r.known ? null : 'нет в базе лидов',
  ].filter(Boolean);

  return [
    `${String(index).padStart(3, ' ')}. ${who}  ·  ${date(r.at)}  ·  ${r.account}` +
      (marks.length > 0 ? `  ·  ${marks.join(', ')}` : ''),
    `     ${oneLine(r.text)}`,
    '',
  ];
}

function oneLine(text: string): string {
  const clipped = clipKeepingLinks(text, 120);
  return clipped.length === 0 ? '(без текста — вложение)' : clipped;
}

function date(at: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(at.getDate())}.${p(at.getMonth() + 1)} ${p(at.getHours())}:${p(at.getMinutes())}`;
}

function plural(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'диалог';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'диалога';
  return 'диалогов';
}
