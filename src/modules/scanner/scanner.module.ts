import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LeadModule } from '@modules/lead/lead.module';
import { ScanStateEntity } from '@modules/scanner/scan-state.entity';
import { ScannerConfig } from '@modules/scanner/scanner.config';
import { ScannerController } from '@modules/scanner/scanner.controller';
import { ScannerService } from '@modules/scanner/scanner.service';
import { TelegramModule } from '@modules/telegram/telegram.module';

@Module({
  imports: [TypeOrmModule.forFeature([ScanStateEntity]), TelegramModule, LeadModule],
  controllers: [ScannerController],
  providers: [ScannerConfig, ScannerService],
  exports: [ScannerService],
})
export class ScannerModule {}
