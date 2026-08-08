import { Module } from '@nestjs/common';
import { TelegramClientService } from '@modules/telegram/telegram-client.service';
import { TelegramConfig } from '@modules/telegram/telegram.config';

@Module({
  providers: [TelegramConfig, TelegramClientService],
  exports: [TelegramClientService],
})
export class TelegramModule {}
