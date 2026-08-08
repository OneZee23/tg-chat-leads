import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Чинит разметку обратной засыпки журнала отправок.
 *
 * Что произошло 08.08.2026: миграция SendAttempt1780100000000 применилась
 * автоматически при старте приложения (DB_MIGRATE=true) из ранее собранного
 * dist/, где ещё не было разделения на 'sent' и 'legacy'. В итоге все 157
 * восстановленных контактов легли как 'sent', и суточный бюджет посчитал,
 * что за сутки ушло 157 сообщений вместо 26 реальных — то есть заблокировал
 * отправку на сутки вперёд по несуществующим данным.
 *
 * Ту миграцию не трогаем: она применена, а отредактированную TypeORM просто
 * пропустит на любой базе, где она уже отмечена выполненной.
 *
 * Признак настоящей отправки — заметка, которую ставит отправщик
 * ('отправлено рассылкой'). Всё остальное восстановлено из истории диалогов
 * и ручных писем: контакт был, но не через рассылку, и в скользящем окне
 * суточного лимита ему не место.
 *
 * Идемпотентно и безопасно на свежей базе: там строки уже помечены верно,
 * и UPDATE не заденет ни одной.
 */
export class FixLegacyBackfill1780200000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "tg_send_attempt" a
      SET "result" = 'legacy', "updated_at" = now()
      FROM "tg_lead" l
      WHERE l."id" = a."lead_id"
        AND a."result" = 'sent'
        AND a."error" = 'восстановлено миграцией из tg_lead.contacted_at'
        AND (l."note" IS NULL OR l."note" NOT ILIKE '%рассылкой%')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Возвращаем ровно то, что пометили: только строки обратной засыпки.
    await queryRunner.query(`
      UPDATE "tg_send_attempt"
      SET "result" = 'sent', "updated_at" = now()
      WHERE "result" = 'legacy'
        AND "error" = 'восстановлено миграцией из tg_lead.contacted_at'
    `);
  }
}
