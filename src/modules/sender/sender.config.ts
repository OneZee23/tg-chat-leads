import { ConfigFragment } from '@common/config/config-fragment';
import { parseBool, parseIntWithDefault } from '@common/config/parsers';
import { UseEnv } from '@common/config/use-env.decorator';
import { IsBoolean, IsInt, IsString, Min } from 'class-validator';

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
}
