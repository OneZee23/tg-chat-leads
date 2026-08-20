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

export function formatAutoReplyResult(result: {
  dryRun: boolean;
  sent: number;
  skippedManual: number;
  stoppedBecause: string;
  entries: Array<{
    username: string | null;
    kind: string;
    reply: string;
    result: string;
  }>;
}): string {
  const head = result.dryRun
    ? 'ПРЕДПРОСМОТР (ничего не отправлено)'
    : 'Авто-ответ отправлен';
  const lines: string[] = ['', head, ''];

  if (result.entries.length === 0) {
    lines.push('Некому: нет неотвеченных ответов с однозначным позитивом/отказом.');
    lines.push(`На ручной разбор (вопросы, нейтральное): ${result.skippedManual}`);
    lines.push('');
    return lines.join('\n');
  }

  result.entries.forEach((e, i) => {
    const nick = e.username ? `@${e.username}` : '(без ника)';
    const verb = result.dryRun ? 'уйдёт' : e.result === 'sent' ? 'ушло' : e.result;
    lines.push(`${String(i + 1).padStart(2, ' ')}. ${nick}  ·  ${e.kind}  ·  ${verb}`);
    lines.push(`    он: ${e.reply}`);
  });

  lines.push('');
  lines.push(`${result.dryRun ? 'Ушло бы' : 'Отправлено'}: ${result.sent}`);
  lines.push(`На ручной разбор (вопросы, нейтральное): ${result.skippedManual}`);
  lines.push(`Остановка: ${result.stoppedBecause}`);
  if (result.dryRun) {
    lines.push('');
    lines.push('Если всё верно — отправить по-настоящему: yarn autoreply:send');
  }
  lines.push('');
  return lines.join('\n');
}

function oneLine(text: string | null): string {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length === 0) return '—';
  return clean.length <= 200 ? clean : `${clean.slice(0, 200).trimEnd()}…`;
}
