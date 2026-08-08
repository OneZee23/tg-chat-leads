import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Стадии ручной работы с лидом. Меняются из UI/curl, приложение их само
 * не двигает — рассылку делаем руками.
 */
export const LEAD_STATUSES = [
  'new', // только что найден скриптом
  'to_contact', // отобран, писать
  'sending', // рассылка взяла в работу; ставится ДО отправки
  'contacted', // написал
  'failed', // отправка не удалась, можно вернуть в работу руками
  'replied', // ответил
  'registered', // дошёл до регистрации в TeachTrack
  'rejected', // отказался
  'skip', // не наш (не преподаватель, спам, агентство)
] as const;

export type LeadStatus = (typeof LEAD_STATUSES)[number];

@Entity('tg_lead')
// Дедуп живёт здесь, а не в коде: уникальность по telegram user_id.
// Именно по id, а не по @username — username человек меняет когда захочет,
// а у части людей его нет вовсе. id постоянен на всю жизнь аккаунта.
@Index('uq_tg_lead_user_id', ['tgUserId'], { unique: true })
// Рабочая выборка «кому писать»: статус + score по убыванию.
@Index('idx_tg_lead_status_score', ['status', 'score'])
export class LeadEntity {
  @PrimaryGeneratedColumn('uuid')
  public readonly id: string;

  // bigint: telegram id уже перевалил за 2^31 и вплотную подходит к 2^32.
  // TypeORM отдаёт bigint строкой — это осознанно, точность важнее удобства.
  @Column({ name: 'tg_user_id', type: 'bigint' })
  public tgUserId: string;

  @Column({ name: 'username', type: 'varchar', length: 64, nullable: true })
  public username: string | null;

  @Column({ name: 'first_name', type: 'varchar', length: 128, nullable: true })
  public firstName: string | null;

  @Column({ name: 'last_name', type: 'varchar', length: 128, nullable: true })
  public lastName: string | null;

  // Телефон Telegram отдаёт только если человек открыл его всем или он
  // в контактах. Почти всегда null — не рассчитывай на него.
  @Column({ name: 'phone', type: 'varchar', length: 32, nullable: true })
  public phone: string | null;

  @Column({ name: 'is_premium', type: 'boolean', default: false })
  public isPremium: boolean;

  @Column({ name: 'lang_code', type: 'varchar', length: 16, nullable: true })
  public langCode: string | null;

  // Чат, в котором человека увидели первым (как он записан в SCAN_CHATS).
  @Column({ name: 'source_chat', type: 'varchar', length: 128, nullable: true })
  public sourceChat: string | null;

  @Column({ name: 'source_chat_title', type: 'varchar', length: 255, nullable: true })
  public sourceChatTitle: string | null;

  @Column({ name: 'first_message_id', type: 'bigint', nullable: true })
  public firstMessageId: string | null;

  @Column({ name: 'first_seen_at', type: 'timestamptz' })
  public firstSeenAt: Date;

  // Дата САМОГО СВЕЖЕГО сообщения человека, а не момента скана: по ней
  // видно, кто ещё активен в чате, а кто написал одно объявление в 2023-м.
  @Column({ name: 'last_seen_at', type: 'timestamptz' })
  public lastSeenAt: Date;

  @Column({ name: 'messages_count', type: 'int', default: 0 })
  public messagesCount: number;

  @Column({ name: 'ad_messages_count', type: 'int', default: 0 })
  public adMessagesCount: number;

  // Текст самого «рекламного» сообщения — по нему решаешь, писать или нет.
  @Column({ name: 'sample_text', type: 'text', nullable: true })
  public sampleText: string | null;

  // Какие маркеры сработали. Нужно, чтобы видеть, почему человек попал
  // в выборку, и подкручивать эвристику осмысленно, а не наугад.
  @Column({ name: 'matched_keywords', type: 'text', array: true, default: () => "'{}'" })
  public matchedKeywords: string[];

  @Column({ name: 'score', type: 'int', default: 0 })
  public score: number;

  @Column({ name: 'status', type: 'varchar', length: 24, default: 'new' })
  public status: LeadStatus;

  @Column({ name: 'note', type: 'text', nullable: true })
  public note: string | null;

  @Column({ name: 'contacted_at', type: 'timestamptz', nullable: true })
  public contactedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  public readonly createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  public updatedAt: Date;
}
