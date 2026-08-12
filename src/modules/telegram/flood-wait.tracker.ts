import { Injectable, Logger } from '@nestjs/common';
import { FloodWaitError } from 'telegram/errors';

export interface FloodLimit {
  /** Метод API, на который висит лимит: contacts.ResolveUsername и т.п. */
  method: string;
  until: Date;
  secondsLeft: number;
  human: string;
}

/**
 * Единая память о FloodWait'ах Telegram.
 *
 * Раньше лимит всплывал сырой строкой «FloodWait 29187s» в глубине лога, и
 * понять, до какого времени аккаунт зажат, было нельзя. Здесь мы ловим их в
 * одной точке (обёртка над client.invoke — через неё идут все запросы) и
 * держим по каждому методу срок окончания. Любой эндпоинт может спросить
 * трекер и показать человеку «ещё 8ч 6м, до 12:52».
 *
 * Лимиты в Telegram привязаны к методу: ResolveUsername (резолв @ника) и
 * SendMessage лимитируются отдельно, поэтому храним по методу, а не одним
 * числом.
 */
@Injectable()
export class FloodWaitTracker {
  private readonly logger = new Logger(FloodWaitTracker.name);

  private readonly limits = new Map<string, Date>();

  /** Перехват из catch: если это FloodWait — запоминаем срок. */
  public record(err: unknown): void {
    if (!(err instanceof FloodWaitError)) return;
    this.note(extractMethod(err.message), err.seconds);
  }

  /** Прямая запись (метод + секунды) — точка входа для record и тестов. */
  public note(method: string, seconds: number): void {
    const until = new Date(Date.now() + seconds * 1000);
    const prev = this.limits.get(method);
    // Держим самый поздний срок: повторный запрос во время лимита часто
    // возвращает срок меньше исходного, и затирать им нельзя.
    if (!prev || until.getTime() > prev.getTime()) {
      this.limits.set(method, until);
      this.logger.warn(
        `FloodWait на ${method}: ещё ${formatLeft(seconds * 1000)}, до ${formatClock(until)}`,
      );
    }
  }

  /** Активные лимиты, самый долгий сверху. Истёкшие вычищаются. */
  public active(): FloodLimit[] {
    const now = Date.now();
    for (const [method, until] of this.limits) {
      if (until.getTime() <= now) this.limits.delete(method);
    }
    return [...this.limits.entries()]
      .map(([method, until]) => toLimit(method, until, now))
      .sort((a, b) => b.secondsLeft - a.secondsLeft);
  }

  /** Лимит на конкретный метод, если активен. */
  public forMethod(method: string): FloodLimit | null {
    return this.active().find((l) => l.method === method) ?? null;
  }

  /** Самый долгий активный лимит. */
  public worst(): FloodLimit | null {
    return this.active()[0] ?? null;
  }

  /** Строка для человека: либо перечень лимитов, либо «ограничений нет». */
  public summary(): string {
    const active = this.active();
    if (active.length === 0) return 'ограничений на запросы нет';
    return active.map((l) => `${l.method}: ещё ${l.human}`).join('; ');
  }
}

function toLimit(method: string, until: Date, now: number): FloodLimit {
  const secondsLeft = Math.max(0, Math.round((until.getTime() - now) / 1000));
  return {
    method,
    until,
    secondsLeft,
    human: `${formatLeft(secondsLeft * 1000)} (до ${formatClock(until)})`,
  };
}

function extractMethod(message: string): string {
  const match = message.match(/caused by ([\w.]+)/i);
  return match ? match[1] : 'unknown';
}

export function formatLeft(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}ч ${m}м`;
  if (m > 0) return `${m}м ${s}с`;
  return `${s}с`;
}

export function formatClock(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
