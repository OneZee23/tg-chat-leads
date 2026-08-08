import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Начальная схема: таблица лидов + курсоры сканирования по чатам.
 *
 * gen_random_uuid() — встроенная функция начиная с PostgreSQL 13,
 * расширение pgcrypto ставить не нужно (в compose стоит postgres:16).
 */
export class Initial1780000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "tg_lead" (
        "id"                 uuid         NOT NULL DEFAULT gen_random_uuid(),
        "tg_user_id"         bigint       NOT NULL,
        "username"           varchar(64),
        "first_name"         varchar(128),
        "last_name"          varchar(128),
        "phone"              varchar(32),
        "is_premium"         boolean      NOT NULL DEFAULT false,
        "lang_code"          varchar(16),
        "source_chat"        varchar(128),
        "source_chat_title"  varchar(255),
        "first_message_id"   bigint,
        "first_seen_at"      timestamptz  NOT NULL,
        "last_seen_at"       timestamptz  NOT NULL,
        "messages_count"     integer      NOT NULL DEFAULT 0,
        "ad_messages_count"  integer      NOT NULL DEFAULT 0,
        "sample_text"        text,
        "matched_keywords"   text[]       NOT NULL DEFAULT '{}',
        "score"              integer      NOT NULL DEFAULT 0,
        "status"             varchar(24)  NOT NULL DEFAULT 'new',
        "note"               text,
        "contacted_at"       timestamptz,
        "created_at"         timestamptz  NOT NULL DEFAULT now(),
        "updated_at"         timestamptz  NOT NULL DEFAULT now(),
        CONSTRAINT "pk_tg_lead" PRIMARY KEY ("id")
      )
    `);

    // Тот самый «уникальный список»: дедуп гарантирует база, а не код.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_tg_lead_user_id"
        ON "tg_lead" ("tg_user_id")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_tg_lead_status_score"
        ON "tg_lead" ("status", "score")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "tg_scan_state" (
        "id"                   uuid        NOT NULL DEFAULT gen_random_uuid(),
        "chat_ref"             varchar(128) NOT NULL,
        "chat_id"              bigint,
        "chat_title"           varchar(255),
        "last_message_id"      bigint      NOT NULL DEFAULT 0,
        "last_scan_at"         timestamptz,
        "total_messages_seen"  bigint      NOT NULL DEFAULT 0,
        "last_error"           text,
        "created_at"           timestamptz NOT NULL DEFAULT now(),
        "updated_at"           timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_tg_scan_state" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_tg_scan_state_chat_ref"
        ON "tg_scan_state" ("chat_ref")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "tg_scan_state"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "tg_lead"`);
  }
}
