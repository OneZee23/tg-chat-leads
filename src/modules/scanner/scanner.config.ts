import { ConfigFragment } from '@common/config/config-fragment';
import {
  parseBool,
  parseCsv,
  parseCsvLower,
  parseIntWithDefault,
} from '@common/config/parsers';
import { UseEnv } from '@common/config/use-env.decorator';
import { IsArray, IsBoolean, IsInt, Min } from 'class-validator';

export class ScannerConfig extends ConfigFragment {
  @IsArray()
  @UseEnv('SCAN_CHATS', parseCsv)
  public readonly chats: string[];

  @IsInt()
  @Min(1)
  @UseEnv('SCAN_INITIAL_LIMIT', parseIntWithDefault(2000))
  public readonly initialLimit: number;

  @IsInt()
  @Min(1)
  @UseEnv('SCAN_MAX_MESSAGES_PER_RUN', parseIntWithDefault(5000))
  public readonly maxMessagesPerRun: number;

  @IsInt()
  @Min(0)
  @UseEnv('SCAN_WAIT_TIME_SEC', parseIntWithDefault(2))
  public readonly waitTimeSec: number;

  @IsInt()
  @Min(0)
  @UseEnv('SCAN_DELAY_BETWEEN_CHATS_SEC', parseIntWithDefault(15))
  public readonly delayBetweenChatsSec: number;

  @IsBoolean()
  @UseEnv('SCAN_ON_START', parseBool)
  public readonly scanOnStart: boolean;

  /** 0 — периодический скан выключен, дёргаем руками через POST /scan/run. */
  @IsInt()
  @Min(0)
  @UseEnv('SCAN_INTERVAL_MINUTES', parseIntWithDefault(0))
  public readonly intervalMinutes: number;

  @IsBoolean()
  @UseEnv('LISTEN_ENABLED', parseBool)
  public readonly listenEnabled: boolean;

  @IsInt()
  @Min(0)
  @UseEnv('SAMPLE_TEXT_LIMIT', parseIntWithDefault(1000))
  public readonly sampleTextLimit: number;

  @IsInt()
  @Min(0)
  @UseEnv('AD_MIN_SCORE', parseIntWithDefault(3))
  public readonly adMinScore: number;

  @IsArray()
  @UseEnv('AD_EXTRA_KEYWORDS', parseCsvLower)
  public readonly adExtraKeywords: string[];

  @IsArray()
  @UseEnv('AD_EXTRA_STOP_WORDS', parseCsvLower)
  public readonly adExtraStopWords: string[];

  @IsBoolean()
  @UseEnv('SAVE_NON_AD_AUTHORS', parseBool)
  public readonly saveNonAdAuthors: boolean;
}
