import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Курсор по чату. Без него каждый запуск заново перечитывал бы историю:
 * лишние запросы к Telegram (то есть риск FloodWait) и задвоенные счётчики
 * сообщений у лидов.
 */
@Entity('tg_scan_state')
@Index('uq_tg_scan_state_chat_ref', ['chatRef'], { unique: true })
export class ScanStateEntity {
  @PrimaryGeneratedColumn('uuid')
  public readonly id: string;

  // Ровно та строка, что стоит в SCAN_CHATS (@username / ссылка / id).
  @Column({ name: 'chat_ref', type: 'varchar', length: 128 })
  public chatRef: string;

  @Column({ name: 'chat_id', type: 'bigint', nullable: true })
  public chatId: string | null;

  @Column({ name: 'chat_title', type: 'varchar', length: 255, nullable: true })
  public chatTitle: string | null;

  // id последнего обработанного сообщения. 0 = чат ещё не сканировали,
  // значит первый проход берёт последние SCAN_INITIAL_LIMIT сообщений.
  @Column({ name: 'last_message_id', type: 'bigint', default: 0 })
  public lastMessageId: string;

  @Column({ name: 'last_scan_at', type: 'timestamptz', nullable: true })
  public lastScanAt: Date | null;

  @Column({ name: 'total_messages_seen', type: 'bigint', default: 0 })
  public totalMessagesSeen: string;

  // Текст последней ошибки скана (FloodWait, нет доступа к чату и т.п.).
  // Обнуляется при успешном проходе.
  @Column({ name: 'last_error', type: 'text', nullable: true })
  public lastError: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  public readonly createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  public updatedAt: Date;
}
