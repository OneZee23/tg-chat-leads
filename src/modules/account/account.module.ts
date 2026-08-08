import { Module } from '@nestjs/common';
import { AccountConfig } from '@modules/account/account.config';
import { AccountController } from '@modules/account/account.controller';
import { AccountService } from '@modules/account/account.service';
import { TelegramModule } from '@modules/telegram/telegram.module';

@Module({
  imports: [TelegramModule],
  controllers: [AccountController],
  providers: [AccountConfig, AccountService],
  exports: [AccountService],
})
export class AccountModule {}
