import { LeadEntity } from '@modules/lead/lead.entity';

/**
 * Список рисуем текстом, а не JSON'ом: его читают глазами в терминале и
 * из него копируют ник, чтобы пойти написать человеку. jq в этом месте —
 * лишний шаг между тобой и работой.
 */

const SNIPPET_LENGTH = 110;

export interface OutreachListInput {
  leads: LeadEntity[];
  total: number;
}

export function formatOutreachList({ leads, total }: OutreachListInput): string {
  if (total === 0) {
    return [
      'Писать некому — свободных лидов нет.',
      '',
      'Либо всем уже написал, либо чаты не сканировались. Проверь: yarn refresh',
      '',
    ].join('\n');
  }

  const lines: string[] = [
    '',
    `Кому писать сейчас: ${total} чел.${leads.length < total ? ` (показываю ${leads.length})` : ''}`,
    '',
  ];

  leads.forEach((lead, index) => {
    const num = String(index + 1).padStart(3, ' ');
    const nick = lead.username ? `@${lead.username}` : `id${lead.tgUserId}`;
    const when = formatDate(lead.lastSeenAt);
    const link = lead.username ? `t.me/${lead.username}` : '—';

    lines.push(`${num}  ${nick}  ·  score ${lead.score}  ·  ${when}  ·  ${link}`);
    lines.push(`     ${snippet(lead.sampleText)}`);
    lines.push('');
  });

  lines.push('—'.repeat(60));
  lines.push('Написал — сразу отметь, это важно:');
  lines.push('  yarn wrote @nick1 @nick2');
  lines.push('');
  lines.push('Не полагайся на то, что сверка с личкой поймает переписку сама:');
  lines.push('человек может удалить диалог «у обоих», и следов не останется.');
  lines.push('');
  lines.push('Кто не подошёл — убрать навсегда:');
  lines.push('  yarn skip @nick1 @nick2');
  lines.push('');

  return lines.join('\n');
}

export function formatRefreshSummary(summary: {
  messagesSeen: number;
  newLeads: number;
  contactedMarked: number;
  chats: Array<{ chat: string; messagesSeen: number; error?: string }>;
}): string {
  const lines: string[] = ['', 'Обновление закончено.', ''];

  summary.chats.forEach((chat) => {
    const tail = chat.error ? `  ⚠ ${chat.error}` : '';
    lines.push(`  ${chat.chat}: новых сообщений ${chat.messagesSeen}${tail}`);
  });

  lines.push('');
  lines.push(`  Прочитано сообщений:      ${summary.messagesSeen}`);
  lines.push(`  Новых людей в базе:       ${summary.newLeads}`);
  lines.push(`  Отсеяно (уже писал):      ${summary.contactedMarked}`);

  return lines.join('\n');
}

function snippet(text: string | null): string {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length === 0) return '—';
  if (clean.length <= SNIPPET_LENGTH) return clean;
  return `${clean.slice(0, SNIPPET_LENGTH).trimEnd()}…`;
}

function formatDate(date: Date | null): string {
  if (!date) return '—';
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}`;
}
