import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ApiTokenGuard } from '@common/auth/api-token.guard';
import { DatabaseModule } from '@infra/database/database.module';
import { HealthController } from '@infra/webserver/health.controller';
import { LoggerModule } from '@infra/logger/logger.module';
import { LeadModule } from '@modules/lead/lead.module';
import { ScannerModule } from '@modules/scanner/scanner.module';
import { TelegramModule } from '@modules/telegram/telegram.module';

@Module({
  imports: [LoggerModule, DatabaseModule, TelegramModule, LeadModule, ScannerModule],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ApiTokenGuard }],
})
export class AppModule {}
