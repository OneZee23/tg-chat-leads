import { OutboxDirective } from '@modules/outreach/outbox.parse';

/**
 * Итог прогона отправки. Печатаем текстом: это читает человек в терминале
 * сразу после команды, а не другая программа.
 */

export type OutboxEntryResult =
  | 'preview'
  | 'sent'
  | 'closed'
  | 'asked'
  | 'skipped'
  | 'failed';

export interface OutboxSendEntry {
  tgUserId: string;
  username: string | null;
  directive: OutboxDirective;
  result: OutboxEntryResult;
  /** Причина пропуска или текст ошибки. */
  note?: string;
}

export interface OutboxSendResult {
  dryRun: boolean;
  file: string;
  sent: number;
  closed: number;
  asked: number;
  skipped: number;
  /**
   * Диалоги из выгрузки, для которых в outbox нет записи вовсе.
   * null — самой выгрузки на диске уже нет, сверять не по чему.
   */
  untouched: number | null;
  /** Записи outbox, до которых проход по диалогам не дошёл. */
  notFound: number;
  stoppedBecause: string;
  /** Удалось ли проверить, что человек не написал после выгрузки. */
  staleCheck: boolean;
  entries: OutboxSendEntry[];
}

const LABEL: Record<OutboxEntryResult, string> = {
  preview: 'отправлю',
  sent: 'отправлено',
  closed: 'закрыто без ответа',
  asked: 'оставлено тебе',
  skipped: 'пропущено',
  failed: 'ОШИБКА',
};

export function formatOutboxResult(result: OutboxSendResult): string {
  const lines: string[] = [
    '',
    result.dryRun ? 'ПРЕДПРОСМОТР (ничего не отправлено)' : 'Отправка выполнена',
    `Файл: ${result.file}`,
    '',
  ];

  result.entries.forEach((e, i) => {
    const nick = e.username ? `@${e.username}` : `id${e.tgUserId}`;
    const note = e.note ? `  ·  ${e.note}` : '';
    lines.push(
      `${String(i + 1).padStart(2, ' ')}. ${nick}  ·  ${e.directive}  ·  ${LABEL[e.result]}${note}`,
    );
  });

  lines.push('', '—'.repeat(60));
  lines.push(`${result.dryRun ? 'Ушло бы' : 'Отправлено'}: ${result.sent}`);
  lines.push(`Закрыто без ответа: ${result.closed}`);
  lines.push(`Оставлено тебе (ASK): ${result.asked}`);
  lines.push(`Пропущено (диалог изменился): ${result.skipped}`);
  // Молчаливая потеря лида — ровно то, от чего мы уходим, поэтому цифра
  // печатается всегда, даже нулевая.
  lines.push(
    `Было в выгрузке, но не тронуто: ${
      result.untouched === null
        ? 'не по чему сверить — выгрузки нет на диске'
        : result.untouched
    }`,
  );
  lines.push(`Записи, до которых проход не дошёл: ${result.notFound}`);
  lines.push(`Остановка: ${result.stoppedBecause}`);

  if (!result.staleCheck) {
    lines.push('');
    lines.push(
      '⚠ В имени файла нет стампа выгрузки — не проверял, не написал ли человек',
    );
    lines.push('  ещё раз после неё. Проверка свежести пропущена.');
  }

  if (result.dryRun) {
    lines.push('');
    lines.push(`Если всё верно — отправить: yarn outbox:send ${result.file}`);
  }

  lines.push('');
  return lines.join('\n');
}
