import { ConfigFragment } from '@common/config/config-fragment';
import { parseBool, parseIntWithDefault } from '@common/config/parsers';
import { UseEnv } from '@common/config/use-env.decorator';
import { IsBoolean, IsInt, IsString } from 'class-validator';

export class DatabaseConfig extends ConfigFragment {
  @IsString()
  @UseEnv('DB_HOST')
  public readonly host: string;

  @IsInt()
  @UseEnv('DB_PORT', parseIntWithDefault(5434))
  public readonly port: number;

  @IsString()
  @UseEnv('DB_NAME')
  public readonly database: string;

  @IsString()
  @UseEnv('DB_USER')
  public readonly username: string;

  @IsString()
  @UseEnv('DB_PASS')
  public readonly password: string;

  @IsBoolean()
  @UseEnv('DB_LOG', parseBool)
  public readonly log: boolean;

  @IsBoolean()
  @UseEnv('DB_SYNC', parseBool)
  public readonly sync: boolean;

  @IsBoolean()
  @UseEnv('DB_MIGRATE', parseBool)
  public readonly migrate: boolean;
}
