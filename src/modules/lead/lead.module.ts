import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LeadImportService } from '@modules/lead/lead-import.service';
import { LeadController } from '@modules/lead/lead.controller';
import { LeadEntity } from '@modules/lead/lead.entity';
import { LeadService } from '@modules/lead/lead.service';
import { TelegramModule } from '@modules/telegram/telegram.module';

/**
 * TelegramModule здесь появился вместе с ручным импортом: @ник сам по себе
 * не годится для дедупа, а `tg_user_id` знает только Telegram. Цикла нет —
 * TelegramModule ни от кого не зависит.
 */
@Module({
  imports: [TypeOrmModule.forFeature([LeadEntity]), TelegramModule],
  controllers: [LeadController],
  providers: [LeadService, LeadImportService],
  exports: [LeadService],
})
export class LeadModule {}
