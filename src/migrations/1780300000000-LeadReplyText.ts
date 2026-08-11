import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Текст ответа лида и момент ответа.
 *
 * Раньше факт ответа определялся только по последнему сообщению диалога, и
 * если после ответа человека ты писал ему сам, последнее сообщение
 * оказывалось твоим — ответ терялся из подсчёта. Полный пересчёт
 * (recount-replies) читает историю и складывает сюда сам текст ответа,
 * чтобы worklist показывал его без повторного похода в Telegram.
 */
export class LeadReplyText1780300000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "tg_lead"
        ADD COLUMN IF NOT EXISTS "reply_text" text,
        ADD COLUMN IF NOT EXISTS "replied_at" timestamptz
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "tg_lead"
        DROP COLUMN IF EXISTS "reply_text",
        DROP COLUMN IF EXISTS "replied_at"
    `);
  }
}
