import { Module } from '@nestjs/common';
import { DialogsModule } from '@modules/dialogs/dialogs.module';
import { LeadModule } from '@modules/lead/lead.module';
import { OutreachController } from '@modules/outreach/outreach.controller';
import { OutreachService } from '@modules/outreach/outreach.service';
import { ScannerModule } from '@modules/scanner/scanner.module';

@Module({
  imports: [ScannerModule, DialogsModule, LeadModule],
  controllers: [OutreachController],
  providers: [OutreachService],
})
export class OutreachModule {}
