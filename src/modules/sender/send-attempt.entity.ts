import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export const SEND_RESULTS = [
  'started', // отправка началась, исход неизвестен
  'sent', // ушло
  'failed', // не ушло
  // Контакт был, но не через рассылку: восстановлено миграцией из
  // tg_lead.contacted_at (ручные письма и сверка с личкой). В суточный
  // бюджет НЕ идёт — иначе разовая пометка полутора сотен старых
  // контактов съедала бы норму отправок на сутки вперёд.
  'legacy',
] as const;
export type SendResult = (typeof SEND_RESULTS)[number];

/**
 * Журнал попыток отправки.
 *
 * Зачем отдельная таблица, когда есть `tg_lead.contacted_at`: одно поле
 * отвечает только на «писали или нет». Оно не скажет, сколько раз пытались,
 * что именно сломалось и когда. А главное — строка сюда пишется ДО вызова
 * Telegram, и именно она закрывает вопрос «дошло или нет» при падении
 * процесса: `started` без `finished_at` означает «отправка началась, исход
 * неизвестен, руками проверь диалог». 08.08.2026 этот вопрос пришлось
 * решать, открывая Telegram глазами.
 *
 * Она же считает суточный бюджет: сколько сообщений реально ушло за
 * последние 24 часа, независимо от того, сколько раз перезапускали процесс.
 */
@Entity('tg_send_attempt')
// Основной запрос — «сколько ушло за последние сутки», по времени старта.
@Index('idx_tg_send_attempt_started_at', ['startedAt'])
@Index('idx_tg_send_attempt_lead_id', ['leadId'])
export class SendAttemptEntity {
  @PrimaryGeneratedColumn('uuid')
  public readonly id: string;

  @Column({ name: 'lead_id', type: 'uuid' })
  public leadId: string;

  // Дублируем ник и telegram-id из лида намеренно: журнал должен остаться
  // читаемым, даже если лида потом удалят или он сменит ник.
  @Column({ name: 'tg_user_id', type: 'bigint' })
  public tgUserId: string;

  @Column({ name: 'username', type: 'varchar', length: 64, nullable: true })
  public username: string | null;

  @Column({ name: 'started_at', type: 'timestamptz' })
  public startedAt: Date;

  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true })
  public finishedAt: Date | null;

  @Column({ name: 'result', type: 'varchar', length: 16, default: 'started' })
  public result: SendResult;

  @Column({ name: 'error', type: 'text', nullable: true })
  public error: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  public readonly createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  public updatedAt: Date;
}
