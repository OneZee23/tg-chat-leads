import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LeadEntity } from '@modules/lead/lead.entity';
import { SendAttemptEntity } from '@modules/sender/send-attempt.entity';

export interface DailyBudget {
  /** 0 = потолка нет. */
  limit: number;
  used: number;
  remaining: number;
  /** Потолок снят: remaining в этом случае смысла не имеет. */
  unlimited: boolean;
  /** Когда освободится место, если бюджет исчерпан. */
  resetsAt: Date | null;
}

@Injectable()
export class SendAttemptService {
  constructor(
    @InjectRepository(SendAttemptEntity)
    private readonly repo: Repository<SendAttemptEntity>,
  ) {}

  /** Пишется ДО вызова Telegram. Возвращает id, чтобы потом закрыть исход. */
  public async start(lead: LeadEntity): Promise<string> {
    const rows: Array<{ id: string }> = await this.repo.query(
      `
      INSERT INTO tg_send_attempt (lead_id, tg_user_id, username, started_at, result)
      VALUES ($1, $2, $3, now(), 'started')
      RETURNING id
      `,
      [lead.id, lead.tgUserId, lead.username],
    );
    return rows[0].id;
  }

  public async finish(
    id: string,
    result: 'sent' | 'failed',
    error?: string,
  ): Promise<void> {
    await this.repo.query(
      `
      UPDATE tg_send_attempt
      SET result = $2::text, finished_at = now(), error = $3, updated_at = now()
      WHERE id = $1
      `,
      [id, result, error ?? null],
    );
  }

  /**
   * Сколько сообщений ушло за последние 24 часа.
   *
   * `started` считаем наравне с `sent`: если исход неизвестен, сообщение
   * могло уйти, и в бюджете безопаснее считать что ушло. Недосчитать
   * дешевле, чем перебрать — перебор стоит бана.
   *
   * Окно скользящее, а не «с полуночи»: Telegram смотрит на активность
   * за последние часы, а не на календарные сутки.
   */
  public async budget(limit: number): Promise<DailyBudget> {
    const rows: Array<{ used: string; oldest: Date | null }> = await this.repo.query(
      `
      SELECT count(*)::text AS used, min(started_at) AS oldest
      FROM tg_send_attempt
      WHERE result IN ('sent', 'started')
        AND started_at > now() - interval '24 hours'
      `,
    );

    const used = Number(rows[0]?.used ?? 0);
    // limit = 0 значит «потолка нет». Возвращаем заведомо недостижимый
    // остаток, чтобы вызывающий код не пришлось переписывать под особый
    // случай: он просто никогда не упрётся.
    const unlimited = limit <= 0;
    const remaining = unlimited ? Number.MAX_SAFE_INTEGER : Math.max(0, limit - used);
    const oldest = rows[0]?.oldest ? new Date(rows[0].oldest) : null;

    return {
      limit,
      used,
      remaining,
      unlimited,
      // Место освободится, когда самая старая отправка выпадет из окна.
      resetsAt:
        !unlimited && remaining === 0 && oldest
          ? new Date(oldest.getTime() + 24 * 3_600_000)
          : null,
    };
  }

  /** Незакрытые попытки: отправка началась, исход неизвестен. */
  public async listUnfinished(): Promise<SendAttemptEntity[]> {
    return this.repo.find({
      where: { result: 'started' },
      order: { startedAt: 'DESC' },
    });
  }

  public async recent(limit: number): Promise<SendAttemptEntity[]> {
    return this.repo.find({ order: { startedAt: 'DESC' }, take: limit });
  }
}
