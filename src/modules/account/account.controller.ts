import { Controller, Get, Query } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';
import { AccountService } from '@modules/account/account.service';

class StatusQueryDto {
  /** Спросить @SpamBot заново, игнорируя кеш. */
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string'
      ? ['true', '1', 'yes'].includes(value.toLowerCase())
      : value,
  )
  @IsBoolean()
  public readonly force?: boolean;
}

@Controller('account')
export class AccountController {
  constructor(private readonly account: AccountService) {}

  /** curl -sS 'http://127.0.0.1:3010/account/status?force=true' | jq */
  @Get('status')
  public status(@Query() query: StatusQueryDto) {
    return this.account.status(query.force === true);
  }
}
