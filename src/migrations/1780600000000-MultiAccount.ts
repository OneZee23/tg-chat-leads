import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Второй телеграм-аккаунт для рассылки.
 *
 * Telegram пускает примерно 40–50 сообщений в сутки новым людям — это
 * потолок платформы, а не наш. Единственный способ писать больше, не
 * разгоняя темп одного аккаунта (а значит и не повышая риск), — добавить
 * второй. В очереди 636 лидов: при 45 в сутки это две недели, при 90 —
 * одна.
 *
 * `tg_send_attempt.account` — кто отправлял. Без него дневной бюджет
 * считался бы на всех сразу, а банят не инструмент, а конкретный
 * аккаунт: потолок обязан быть у каждого свой.
 *
 * `tg_lead.assigned_account` — кто ведёт этого человека. Закрепляется при
 * первой отправке и дальше не меняется: иначе фоллоу-ап пришёл бы с
 * другого аккаунта, и для получателя это два незнакомца с одинаковым
 * текстом.
 *
 * Существующим отправкам проставляется 'main' — они все и правда с
 * основного аккаунта, другого до сих пор не было.
 */
export class MultiAccount1780600000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "tg_send_attempt"
        ADD COLUMN IF NOT EXISTS "account" varchar(32) NOT NULL DEFAULT 'main'
    `);

    await queryRunner.query(`
      ALTER TABLE "tg_lead"
        ADD COLUMN IF NOT EXISTS "assigned_account" varchar(32)
    `);

    // Лидам, которым уже писали, проставляем основной аккаунт: иначе
    // первый же фоллоу-ап ушёл бы со второго и выглядел как письмо от
    // постороннего.
    await queryRunner.query(`
      UPDATE "tg_lead"
         SET "assigned_account" = 'main'
       WHERE "assigned_account" IS NULL
         AND "contacted_at" IS NOT NULL
    `);

    // Дневной бюджет считается по этой паре на каждом тике планировщика.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_tg_send_attempt_account_started"
        ON "tg_send_attempt" ("account", "started_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_tg_send_attempt_account_started"`);
    await queryRunner.query(`ALTER TABLE "tg_lead" DROP COLUMN IF EXISTS "assigned_account"`);
    await queryRunner.query(`ALTER TABLE "tg_send_attempt" DROP COLUMN IF EXISTS "account"`);
  }
}
