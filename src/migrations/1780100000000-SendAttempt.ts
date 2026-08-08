import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Журнал попыток отправки + суточный бюджет, который по нему считается.
 *
 * ON DELETE CASCADE: журнал не должен мешать удалить лида (например по
 * просьбе человека — это персональные данные). История отправок без
 * самого лида смысла не имеет.
 */
export class SendAttempt1780100000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "tg_send_attempt" (
        "id"          uuid        NOT NULL DEFAULT gen_random_uuid(),
        "lead_id"     uuid        NOT NULL,
        "tg_user_id"  bigint      NOT NULL,
        "username"    varchar(64),
        "started_at"  timestamptz NOT NULL,
        "finished_at" timestamptz,
        "result"      varchar(16) NOT NULL DEFAULT 'started',
        "error"       text,
        "created_at"  timestamptz NOT NULL DEFAULT now(),
        "updated_at"  timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_tg_send_attempt" PRIMARY KEY ("id"),
        CONSTRAINT "fk_tg_send_attempt_lead" FOREIGN KEY ("lead_id")
          REFERENCES "tg_lead" ("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_tg_send_attempt_started_at"
        ON "tg_send_attempt" ("started_at")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_tg_send_attempt_lead_id"
        ON "tg_send_attempt" ("lead_id")
    `);

    // Восстанавливаем историю контактов, чтобы журнал не начинался с нуля.
    //
    // Но не всё подряд: реальные отправки рассылкой идут как 'sent' и
    // считаются в суточном бюджете, а контакты, восстановленные из истории
    // диалогов и ручных писем, — как 'legacy'. Разница принципиальная:
    // 08.08.2026 полторы сотни старых контактов были помечены за один
    // вечер, и если бы они попали в бюджет как сегодняшние отправки,
    // рассылка сочла бы суточную норму исчерпанной на сутки вперёд.
    //
    // Признак — заметка, которую ставит сам отправщик.
    await queryRunner.query(`
      INSERT INTO "tg_send_attempt"
        ("lead_id", "tg_user_id", "username", "started_at", "finished_at", "result", "error")
      SELECT
        id, tg_user_id, username, contacted_at, contacted_at,
        CASE WHEN note ILIKE '%рассылкой%' THEN 'sent' ELSE 'legacy' END,
        'восстановлено миграцией из tg_lead.contacted_at'
      FROM "tg_lead"
      WHERE contacted_at IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "tg_send_attempt"`);
  }
}
