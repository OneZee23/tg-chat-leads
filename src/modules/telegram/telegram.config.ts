import { ConfigFragment } from '@common/config/config-fragment';
import { parseIntWithDefault } from '@common/config/parsers';
import { UseEnv } from '@common/config/use-env.decorator';
import { IsInt, IsNotEmpty, IsString, Min } from 'class-validator';

export class TelegramConfig extends ConfigFragment {
  // Min(1), а не просто IsInt: без этого незаполненный TG_API_ID проходит
  // валидацию нулём и падает уже на connect, невнятной MTProto-ошибкой.
  @IsInt()
  @Min(1, { message: 'TG_API_ID is required (my.telegram.org → API development tools)' })
  @UseEnv('TG_API_ID', parseIntWithDefault(0))
  public readonly apiId: number;

  @IsString()
  @IsNotEmpty({
    message: 'TG_API_HASH is required (my.telegram.org → API development tools)',
  })
  @UseEnv('TG_API_HASH')
  public readonly apiHash: string;

  @IsString()
  @IsNotEmpty({ message: 'TG_SESSION is required — run `yarn session:create` first' })
  @UseEnv('TG_SESSION')
  public readonly session: string;

  @IsInt()
  @UseEnv('TG_FLOOD_SLEEP_THRESHOLD', parseIntWithDefault(120))
  public readonly floodSleepThreshold: number;
}
