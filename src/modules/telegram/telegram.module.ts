import { Module } from '@nestjs/common';
import { FloodWaitTracker } from '@modules/telegram/flood-wait.tracker';
import { TelegramClientService } from '@modules/telegram/telegram-client.service';
import { TelegramAccountsService } from '@modules/telegram/telegram-accounts.service';
import { TelegramConfig } from '@modules/telegram/telegram.config';

@Module({
  providers: [TelegramConfig, FloodWaitTracker, TelegramClientService, TelegramAccountsService],
  exports: [TelegramClientService, TelegramAccountsService, FloodWaitTracker],
})
export class TelegramModule {}
