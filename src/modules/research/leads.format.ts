import type { LeadCandidate, LeadSignal } from '@modules/research/leads.scoring';

export interface LeadsResult {
  chats: string[];
  queries: string[];
  scanned: number;
  candidates: LeadCandidate[];
  startedAt: string;
  finishedAt: string;
  sinceDays: number;
}

const SIGNAL_LABEL: Readonly<Record<LeadSignal, string>> = {
  referral: '🎯 говорит про рефералы',
  hiring: '💼 его команда нанимает',
  insider: '🏢 называет свою компанию',
  relocated: '✈️ уже переехал',
  stack: '⚙️ мой стек',
  recruiter: '🧑‍💼 рекрутёр',
  seeker: '🔻 сам ищет работу',
  tool_search: '🔍 спрашивает, чем вести учёт',
  accounting_pain: '📒 учёт разваливается',
  payment_pain: '💸 путается, кто сколько должен',
  package_pain: '🎫 путаница с пакетами/абонементами',
  cancellation_pain: '🚫 отмены и перенос в последний момент',
  reminder_pain: '⏰ приходится напоминать ученикам вручную',
  scale: '📈 масштаб практики',
  school: '🏫 школа / языковой центр',
  self_promo: '🔻 рекламирует свои услуги',
  student_side: '🔻 сам ищет репетитора',
  vendor: '🔻 продаёт конкурирующий продукт',
};

export function leadsFileName(startedAt: Date): string {
  const iso = startedAt.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `leads-${iso}.md`;
}

function formatDate(unix: number): string {
  if (!unix) return '—';
  return new Date(unix * 1000).toISOString().slice(0, 10);
}

/** Одна реплика в отчёте: обрезаем, потому что решение принимается по сути. */
function quote(text: string, limit = 300): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

export function formatLeads(result: LeadsResult, topQuotes = 3): string {
  const lines: string[] = [];

  lines.push(`# Лиды из чатов: ${result.chats.join(', ')}`);
  lines.push('');
  lines.push(`Прогон: ${result.startedAt} → ${result.finishedAt}`);
  lines.push(
    `Окно: последние ${result.sinceDays} дней · просмотрено сообщений: ${result.scanned}`,
  );
  lines.push(`Кандидатов с юзернеймом: **${result.candidates.length}**`);
  lines.push('');
  lines.push('> Это ЧТЕНИЕ публичного чата. Ничего не отправлено.');
  lines.push('> Перед первым сообщением человека открыть глазами: скоринг ошибается.');
  lines.push('> Первое сообщение — БЕЗ просьбы. Всегда.');
  lines.push('');
  lines.push(`Запросы: ${result.queries.join(' · ')}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  if (result.candidates.length === 0) {
    lines.push('Ничего не найдено. Стоит расширить запросы или окно.');
    return lines.join('\n');
  }

  for (const [index, candidate] of result.candidates.entries()) {
    const labels = candidate.signals.map((s) => SIGNAL_LABEL[s]).join(' · ');
    lines.push(`## ${index + 1}. ${candidate.author} — ${candidate.score}`);
    lines.push('');
    lines.push(`${labels || '— сигналов нет'}`);
    lines.push(
      `Сообщений: ${candidate.messages.length} · последнее: ${formatDate(candidate.lastSeen)}`,
    );
    if (candidate.companies.length > 0) {
      lines.push(`Упоминает: ${candidate.companies.slice(0, 8).join(', ')}`);
    }
    lines.push('');
    for (const message of candidate.messages.slice(0, topQuotes)) {
      lines.push(`> ${quote(message.text)}`);
      const link = message.link ? ` — ${message.link}` : '';
      lines.push(`> <sub>${formatDate(message.date)}${link}</sub>`);
      lines.push('');
    }
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}
