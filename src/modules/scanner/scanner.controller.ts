import { Body, Controller, Get, Post } from '@nestjs/common';
import { IsString, MaxLength } from 'class-validator';
import { ScannerService } from '@modules/scanner/scanner.service';

class ScanOneChatDto {
  @IsString()
  @MaxLength(128)
  public readonly chat: string;
}

@Controller('scan')
export class ScannerController {
  constructor(private readonly scanner: ScannerService) {}

  /** curl -XPOST http://127.0.0.1:3010/scan/run */
  @Post('run')
  public run() {
    return this.scanner.startInBackground();
  }

  /** Разовый проход по одному чату — удобно, когда добавил новый в SCAN_CHATS. */
  @Post('run-one')
  public runOne(@Body() body: ScanOneChatDto) {
    return this.scanner.scanOne(body.chat);
  }

  @Get('status')
  public async status() {
    return {
      running: this.scanner.isRunning(),
      lastSummary: this.scanner.getLastSummary(),
      chats: await this.scanner.listStates(),
    };
  }
}
