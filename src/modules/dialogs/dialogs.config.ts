import { ConfigFragment } from '@common/config/config-fragment';
import { parseBool, parseIntWithDefault } from '@common/config/parsers';
import { UseEnv } from '@common/config/use-env.decorator';
import { IsBoolean, IsInt, Min } from 'class-validator';

export class DialogsConfig extends ConfigFragment {
  /** Сколько диалогов пройти. У живого аккаунта их обычно сотни, не тысячи. */
  @IsInt()
  @Min(1)
  @UseEnv('DIALOGS_LIMIT', parseIntWithDefault(1000))
  public readonly limit: number;

  /**
   * Глубокая проверка «писал ли я этому человеку».
   *
   * Дешёвый признак — моё сообщение последнее в диалоге. Для холодного
   * аутрича без ответа он срабатывает почти всегда. Но если человек ответил
   * (а это как раз ценные контакты), последнее сообщение уже его, и дешёвая
   * проверка даст false. Тогда идём в поиск по диалогу — один запрос,
   * зато без ложных «не писал».
   */
  @IsBoolean()
  @UseEnv('CONTACTED_DEEP_CHECK', (raw) => (raw === undefined ? true : parseBool(raw)))
  public readonly deepCheck: boolean;

  @IsInt()
  @Min(0)
  // 1.5 сек, а не 400 мс: Telegram довольно быстро отвечает FloodWait'ом
  // на частые messages.GetHistory. Глубоких проверок теперь единицы,
  // так что пауза длиннее ничего не замедляет.
  @UseEnv('CONTACTED_DEEP_DELAY_MS', parseIntWithDefault(1500))
  public readonly deepDelayMs: number;

  /** Сколько последних сообщений диалога просмотреть в глубокой проверке. */
  @IsInt()
  @Min(1)
  @UseEnv('CONTACTED_DEEP_LIMIT', parseIntWithDefault(50))
  public readonly deepLimit: number;
}
