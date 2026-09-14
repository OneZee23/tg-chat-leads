import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Откуда взялся лид: телеграм-чат, поисковик, инстаграм или руки.
 *
 * До сих пор источник был ровно один — сканер чатов, — и о нём говорили
 * `source_chat`/`source_chat_title`. Теперь контакты приходят ещё и снаружи
 * Telegram (Google, Яндекс, Instagram), а писать им всё равно в Telegram.
 * Чтобы сравнить, какой канал сбора даёт более отзывчивых людей, нужна
 * отдельная колонка: по `source_chat` этого не понять — у внешнего контакта
 * чата нет вовсе, и все они схлопнулись бы в один безымянный NULL.
 *
 * Всем существующим строкам ставим `tg_chat`: другого пути в базу до этой
 * миграции не было.
 *
 * Три шага вместо одного `ADD COLUMN ... NOT NULL DEFAULT` — ради
 * идемпотентности: миграцию катают и на свежую базу, и на базу, где колонка
 * уже появилась из `DB_SYNC`/ручного ALTER, а `ADD COLUMN IF NOT EXISTS`
 * молча не проставит ни DEFAULT, ни NOT NULL на уже существующей колонке.
 */
export class LeadSource1780500000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "tg_lead"
        ADD COLUMN IF NOT EXISTS "source" varchar(16)
    `);

    await queryRunner.query(`
      UPDATE "tg_lead" SET "source" = 'tg_chat' WHERE "source" IS NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "tg_lead"
        ALTER COLUMN "source" SET DEFAULT 'tg_chat',
        ALTER COLUMN "source" SET NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "tg_lead" DROP COLUMN IF EXISTS "source"
    `);
  }
}
