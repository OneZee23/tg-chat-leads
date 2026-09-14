import { Injectable, Logger } from '@nestjs/common';
import { FloodWaitError } from 'telegram/errors';

export interface FloodLimit {
  /** Метод API, на который висит лимит: contacts.ResolveUsername и т.п. */
  method: string;
  /** Чей аккаунт зажали. Лимиты Telegram выдаёт аккаунту, не программе. */
  account: string;
  until: Date;
  secondsLeft: number;
  human: string;
}

/** Аккаунт по умолчанию: до появления второго все лимиты были его. */
const DEFAULT_ACCOUNT = 'main';

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
 *
 * И к аккаунту: зажимают конкретный аккаунт, а не программу. Без разделения
 * по аккаунтам FloodWait, заработанный вторым, остановил бы отправку и с
 * первого — то есть второй аккаунт не удваивал бы ёмкость, а обнулял её.
 */
@Injectable()
export class FloodWaitTracker {
  private readonly logger = new Logger(FloodWaitTracker.name);

  /** Ключ — аккаунт + метод, см. `key()`. */
  private readonly limits = new Map<string, Date>();

  /** Перехват из catch: если это FloodWait — запоминаем срок. */
  public record(err: unknown, account: string = DEFAULT_ACCOUNT): void {
    if (!(err instanceof FloodWaitError)) return;
    this.note(extractMethod(err.message), err.seconds, account);
  }

  /** Прямая запись (метод + секунды) — точка входа для record и тестов. */
  public note(method: string, seconds: number, account: string = DEFAULT_ACCOUNT): void {
    const until = new Date(Date.now() + seconds * 1000);
    const id = key(account, method);
    const prev = this.limits.get(id);
    // Держим самый поздний срок: повторный запрос во время лимита часто
    // возвращает срок меньше исходного, и затирать им нельзя.
    if (!prev || until.getTime() > prev.getTime()) {
      this.limits.set(id, until);
      this.logger.warn(
        `FloodWait на ${method} (${account}): ещё ${formatLeft(seconds * 1000)}, ` +
          `до ${formatClock(until)}`,
      );
    }
  }

  /** Активные лимиты, самый долгий сверху. Истёкшие вычищаются. */
  public active(account?: string): FloodLimit[] {
    const now = Date.now();
    for (const [id, until] of this.limits) {
      if (until.getTime() <= now) this.limits.delete(id);
    }
    return [...this.limits.entries()]
      .map(([id, until]) => toLimit(id, until, now))
      .filter((limit) => account === undefined || limit.account === account)
      .sort((a, b) => b.secondsLeft - a.secondsLeft);
  }

  /** Лимит на конкретный метод у конкретного аккаунта, если активен. */
  public forMethod(method: string, account: string = DEFAULT_ACCOUNT): FloodLimit | null {
    return this.active(account).find((l) => l.method === method) ?? null;
  }

  /** Самый долгий активный лимит. */
  public worst(): FloodLimit | null {
    return this.active()[0] ?? null;
  }

  /**
   * Строка для человека: либо перечень лимитов, либо «ограничений нет».
   * Аккаунт называем только когда он не основной — пока он один, приписка
   * «(main)» в каждой строке была бы шумом.
   */
  public summary(): string {
    const active = this.active();
    if (active.length === 0) return 'ограничений на запросы нет';
    return active
      .map((l) => {
        const whose = l.account === DEFAULT_ACCOUNT ? '' : ` [${l.account}]`;
        return `${l.method}${whose}: ещё ${l.human}`;
      })
      .join('; ');
  }
}

/**
 * Ключ хранилища. Разделитель — \u0000: в имени метода и в имени аккаунта
 * его быть не может, а обычное двоеточие в `contacts.ResolveUsername`
 * когда-нибудь появится.
 */
function key(account: string, method: string): string {
  return `${account}\u0000${method}`;
}

function toLimit(id: string, until: Date, now: number): FloodLimit {
  const [account, method] = id.split('\u0000');
  const secondsLeft = Math.max(0, Math.round((until.getTime() - now) / 1000));
  return {
    method,
    account,
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
