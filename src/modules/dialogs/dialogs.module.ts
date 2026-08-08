import { Module } from '@nestjs/common';
import { DialogsConfig } from '@modules/dialogs/dialogs.config';
import { DialogsController } from '@modules/dialogs/dialogs.controller';
import { DialogsService } from '@modules/dialogs/dialogs.service';
import { LeadModule } from '@modules/lead/lead.module';
import { ScannerConfig } from '@modules/scanner/scanner.config';
import { TelegramModule } from '@modules/telegram/telegram.module';

@Module({
  imports: [TelegramModule, LeadModule],
  controllers: [DialogsController],
  // ScannerConfig нужен только чтобы отметить, какие чаты уже в SCAN_CHATS.
  // Он читает env и не держит состояния, так что второй экземпляр безвреден.
  providers: [DialogsConfig, ScannerConfig, DialogsService],
})
export class DialogsModule {}
