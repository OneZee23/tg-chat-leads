import { LeadEntity } from '@modules/lead/lead.entity';
import { detectSubject } from '@modules/sender/outreach-message';
import { suggestReply } from '@modules/outreach/reply-draft';

/**
 * Worklist ответивших: для каждого — что он написал и готовый черновик
 * (или пометка «ответь сам» на вопросах). Печатаем текстом: это читается
 * в терминале и из него копируется ответ.
 */
export function formatRepliesWorklist(leads: LeadEntity[]): string {
  if (leads.length === 0) {
    return [
      '',
      'Ответивших в работе нет.',
      '',
      'Если ждёшь больше — прогони полный пересчёт: yarn recount',
      '(быстрая сверка в refresh пропускает тех, кому ты уже ответил сам)',
      '',
    ].join('\n');
  }

  const lines: string[] = ['', `Ответили — в работе ${leads.length} чел.`, ''];

  leads.forEach((lead, index) => {
    const nick = lead.username ? `@${lead.username}` : `id${lead.tgUserId}`;
    const subject = detectSubject(lead.sampleText);
    const s = suggestReply(lead.replyText ?? '');

    lines.push(
      `${String(index + 1).padStart(2, ' ')}. ${nick}` +
        (subject ? `  ·  ${subject}` : ''),
    );
    lines.push(`    он: ${oneLine(lead.replyText)}`);
    lines.push(`    → ${s.hint}`);
    if (s.draft) {
      lines.push(`    ты: ${s.draft}`);
    }
    lines.push('');
  });

  lines.push('—'.repeat(60));
  lines.push('Ответил — пометь: yarn wrote @nick  (или yarn skip @nick, если отказ)');
  lines.push(
    'Черновик — заготовка, правь под человека. На вопросах черновика нет намеренно.',
  );
  lines.push('');

  return lines.join('\n');
}

function oneLine(text: string | null): string {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length === 0) return '—';
  return clean.length <= 200 ? clean : `${clean.slice(0, 200).trimEnd()}…`;
}
