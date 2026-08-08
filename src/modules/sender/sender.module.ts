import { Module } from '@nestjs/common';
import { LeadModule } from '@modules/lead/lead.module';
import { SenderConfig } from '@modules/sender/sender.config';
import { SenderController } from '@modules/sender/sender.controller';
import { SenderService } from '@modules/sender/sender.service';
import { TelegramModule } from '@modules/telegram/telegram.module';

@Module({
  imports: [TelegramModule, LeadModule],
  controllers: [SenderController],
  providers: [SenderConfig, SenderService],
})
export class SenderModule {}
