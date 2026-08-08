import { ConfigFragment } from '@common/config/config-fragment';
import { parseBool, parseIntWithDefault } from '@common/config/parsers';
import { UseEnv } from '@common/config/use-env.decorator';
import { IsBoolean, IsInt, Min } from 'class-validator';

export class AccountConfig extends ConfigFragment {
  /** Сколько минут доверять прошлому ответу @SpamBot. */
  @IsInt()
  @Min(1)
  @UseEnv('ACCOUNT_CHECK_TTL_MIN', parseIntWithDefault(30))
  public readonly checkTtlMin: number;

  /**
   * Не пускать рассылку, если ответ @SpamBot не разобрали.
   * По умолчанию включено: «не понял» — не то же самое, что «всё хорошо».
   */
  @IsBoolean()
  @UseEnv('ACCOUNT_BLOCK_ON_UNKNOWN', (raw) =>
    raw === undefined ? true : parseBool(raw),
  )
  public readonly blockOnUnknown: boolean;

  @IsInt()
  @Min(1)
  @UseEnv('ACCOUNT_REPLY_ATTEMPTS', parseIntWithDefault(10))
  public readonly replyAttempts: number;

  @IsInt()
  @Min(100)
  @UseEnv('ACCOUNT_REPLY_POLL_MS', parseIntWithDefault(1000))
  public readonly replyPollMs: number;
}
