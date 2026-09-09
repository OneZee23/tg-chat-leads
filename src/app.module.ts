import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ApiTokenGuard } from '@common/auth/api-token.guard';
import { DatabaseModule } from '@infra/database/database.module';
import { HealthController } from '@infra/webserver/health.controller';
import { LoggerModule } from '@infra/logger/logger.module';
import { AccountModule } from '@modules/account/account.module';
import { DialogsModule } from '@modules/dialogs/dialogs.module';
import { LeadModule } from '@modules/lead/lead.module';
import { OutreachModule } from '@modules/outreach/outreach.module';
import { ResearchModule } from '@modules/research/research.module';
import { ScannerModule } from '@modules/scanner/scanner.module';
import { SenderModule } from '@modules/sender/sender.module';
import { TelegramModule } from '@modules/telegram/telegram.module';

@Module({
  imports: [
    LoggerModule,
    DatabaseModule,
    TelegramModule,
    LeadModule,
    ScannerModule,
    ResearchModule,
    DialogsModule,
    OutreachModule,
    AccountModule,
    SenderModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ApiTokenGuard }],
})
export class AppModule {}
