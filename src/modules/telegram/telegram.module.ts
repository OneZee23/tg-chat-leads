import { Module } from '@nestjs/common';
import { FloodWaitTracker } from '@modules/telegram/flood-wait.tracker';
import { TelegramClientService } from '@modules/telegram/telegram-client.service';
import { TelegramConfig } from '@modules/telegram/telegram.config';

@Module({
  providers: [TelegramConfig, FloodWaitTracker, TelegramClientService],
  exports: [TelegramClientService, FloodWaitTracker],
})
export class TelegramModule {}
