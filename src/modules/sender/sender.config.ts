import { ConfigFragment } from '@common/config/config-fragment';
import { parseBool, parseIntWithDefault } from '@common/config/parsers';
import { UseEnv } from '@common/config/use-env.decorator';
import { IsBoolean, IsInt, IsString, Max, Min } from 'class-validator';

export class SenderConfig extends ConfigFragment {
  @IsString()
  @UseEnv('OUTREACH_CONTENT_DIR')
  public readonly contentDir: string;

  /**
   * Потолок сообщений за один запуск. Это не рекомендация, а стоп-кран:
   * дойдя до него, рассылка останавливается сама.
   */
  @IsInt()
  @Min(1)
  @UseEnv('SEND_MAX_PER_RUN', parseIntWithDefault(15))
  public readonly maxPerRun: number;

  /** Пауза между сообщениями, секунды. Реальная — от base до base×2. */
  @IsInt()
  @Min(5)
  @UseEnv('SEND_DELAY_SEC', parseIntWithDefault(90))
  public readonly delaySec: number;

  /**
   * Сколько подряд неудач терпим, прежде чем остановиться.
   * Череда ошибок обычно означает, что аккаунт уже прижали, и продолжать
   * — значит углублять проблему.
   */
  @IsInt()
  @Min(1)
  @UseEnv('SEND_MAX_CONSECUTIVE_ERRORS', parseIntWithDefault(3))
  public readonly maxConsecutiveErrors: number;

  /**
   * Ничего не отправлять, только показать, кому и что ушло бы.
   * Первый запуск делай только так.
   */
  @IsBoolean()
  @UseEnv('SEND_DRY_RUN', (raw) => (raw === undefined ? true : parseBool(raw)))
  public readonly dryRun: boolean;

  /**
   * Скользящий суточный бюджет. В отличие от SEND_MAX_PER_RUN его нельзя
   * обойти повторным запуском: считается по журналу отправок за последние
   * 24 часа. 08.08.2026 предохранителя не было, и пять запусков по 50
   * ничто не остановило бы.
   */
  @IsInt()
  @Min(1)
  @UseEnv('SEND_MAX_PER_DAY', parseIntWithDefault(20))
  public readonly maxPerDay: number;

  /**
   * Окно активности, часы по местному времени машины. Ночная рассылка —
   * отдельный повод пожаловаться, да и выглядит нечеловечески.
   */
  @IsInt()
  @Min(0)
  @Max(23)
  @UseEnv('SEND_WINDOW_START_HOUR', parseIntWithDefault(10))
  public readonly windowStartHour: number;

  @IsInt()
  @Min(1)
  @Max(24)
  @UseEnv('SEND_WINDOW_END_HOUR', parseIntWithDefault(21))
  public readonly windowEndHour: number;

  /** Минимальный зазор между сообщениями в режиме расписания, секунды. */
  @IsInt()
  @Min(30)
  @UseEnv('SEND_SCHEDULE_MIN_GAP_SEC', parseIntWithDefault(300))
  public readonly scheduleMinGapSec: number;

  /** Запускать планировщик сразу при старте приложения. */
  @IsBoolean()
  @UseEnv('SEND_SCHEDULE_AUTOSTART', parseBool)
  public readonly scheduleAutostart: boolean;
}
