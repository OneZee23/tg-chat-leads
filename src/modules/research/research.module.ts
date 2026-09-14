import { Module } from '@nestjs/common';
import { LeadsService } from '@modules/research/leads.service';
import { ResearchConfig } from '@modules/research/research.config';
import { ResearchController } from '@modules/research/research.controller';
import { ResearchService } from '@modules/research/research.service';
import { TelegramModule } from '@modules/telegram/telegram.module';

@Module({
  imports: [TelegramModule],
  controllers: [ResearchController],
  providers: [ResearchConfig, ResearchService, LeadsService],
  exports: [ResearchService, LeadsService],
})
export class ResearchModule {}
