import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Момент, когда диалог закрыли без ответа.
 *
 * `CLOSE` в outbox ничего не отправляет, поэтому сообщение человека остаётся
 * последним в переписке — и следующая выгрузка честно считает его
 * неотвеченным. На живых данных это давало 28 из 37 записей в файле:
 * одни и те же люди возвращались каждый день.
 *
 * Статус `answered` тут не помогает: выгрузка смотрит на хвост истории
 * диалога, а не на статус лида. Нужна именно отметка времени, которая
 * работает как наше исходящее сообщение — двигает курсор вперёд.
 */
export class LeadClosedAt1780400000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "tg_lead"
        ADD COLUMN IF NOT EXISTS "closed_at" timestamptz
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "tg_lead" DROP COLUMN IF EXISTS "closed_at"
    `);
  }
}
