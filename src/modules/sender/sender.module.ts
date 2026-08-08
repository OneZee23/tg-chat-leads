import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AccountModule } from '@modules/account/account.module';
import { LeadModule } from '@modules/lead/lead.module';
import { SendAttemptEntity } from '@modules/sender/send-attempt.entity';
import { SendAttemptService } from '@modules/sender/send-attempt.service';
import { SendSchedulerService } from '@modules/sender/send-scheduler.service';
import { SenderConfig } from '@modules/sender/sender.config';
import { SenderController } from '@modules/sender/sender.controller';
import { SenderService } from '@modules/sender/sender.service';
import { TelegramModule } from '@modules/telegram/telegram.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([SendAttemptEntity]),
    TelegramModule,
    LeadModule,
    AccountModule,
  ],
  controllers: [SenderController],
  providers: [SenderConfig, SendAttemptService, SenderService, SendSchedulerService],
})
export class SenderModule {}
