import { Body, Controller, Post } from '@nestjs/common';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { LeadService } from '@modules/lead/lead.service';
import { SenderService } from '@modules/sender/sender.service';

class RunSendDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  public readonly limit?: number;
}

@Controller('send')
export class SenderController {
  constructor(
    private readonly sender: SenderService,
    private readonly leads: LeadService,
  ) {}

  /**
   * curl -sS -XPOST http://127.0.0.1:3010/send/run -H 'content-type: application/json' -d '{"limit":5}'
   *
   * Что реально произойдёт, зависит от SEND_DRY_RUN. По умолчанию true —
   * то есть первый запуск ничего не отправит и ничьи статусы не тронет.
   */
  @Post('run')
  public run(@Body() body: RunSendDto) {
    return this.sender.run(body.limit);
  }

  /**
   * Вернуть в очередь тех, кто застрял в `sending` после аварийной
   * остановки процесса. Проверь перед этим, что им реально не ушло.
   */
  @Post('release-stuck')
  public async releaseStuck() {
    const released = await this.leads.releaseStuckSending();
    return { released };
  }
}
