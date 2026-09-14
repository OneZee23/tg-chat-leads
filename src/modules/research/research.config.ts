import { ConfigFragment } from '@common/config/config-fragment';
import { parseBool, parseCsv, parseIntWithDefault } from '@common/config/parsers';
import { UseEnv } from '@common/config/use-env.decorator';
import { IsArray, IsBoolean, IsInt, IsString, Min } from 'class-validator';

/**
 * Запросы разделены точкой с запятой, а не запятой: поисковая фраза сама
 * часто содержит запятую («виза D, Тбилиси»). С csv-парсером такая фраза
 * молча распалась бы на два бессмысленных запроса.
 */
export function parseQueryList(raw?: string): string[] {
  return (raw ?? '')
    .split(';')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export class ResearchConfig extends ConfigFragment {
  @IsArray()
  @UseEnv('RESEARCH_CHATS', parseCsv)
  public readonly chats: string[];

  @IsArray()
  @UseEnv('RESEARCH_QUERIES', parseQueryList)
  public readonly queries: string[];

  /** Потолок находок на один запрос. Поиск отдаёт от новых к старым. */
  @IsInt()
  @Min(1)
  @UseEnv('RESEARCH_PER_QUERY_LIMIT', parseIntWithDefault(40))
  public readonly perQueryLimit: number;

  /**
   * Отсечка по возрасту сообщения. Для визовых чатов это не косметика:
   * правила консульств меняются, и совет двухлетней давности про подачу
   * читается как актуальный, хотя давно неверен. 0 — без отсечки.
   */
  @IsInt()
  @Min(0)
  @UseEnv('RESEARCH_SINCE_DAYS', parseIntWithDefault(400))
  public readonly sinceDays: number;

  /** Отсекает «+1», «да», «спасибо» — в чатах их больше, чем содержания. */
  @IsInt()
  @Min(0)
  @UseEnv('RESEARCH_MIN_TEXT_LEN', parseIntWithDefault(40))
  public readonly minTextLength: number;

  /**
   * Подтягивать сообщение, на которое отвечали. В чатах ответ сплошь и рядом
   * выглядит как «да, можно без него» — без вопроса это мусор. Стоит одного
   * дополнительного запроса на находку, поэтому выключаемо.
   */
  @IsBoolean()
  @UseEnv('RESEARCH_WITH_CONTEXT', parseBool)
  public readonly withContext: boolean;

  @IsInt()
  @Min(0)
  @UseEnv('RESEARCH_DELAY_SEC', parseIntWithDefault(4))
  public readonly delayBetweenQueriesSec: number;

  /**
   * Порог отсечки для сбора лидов. Живёт здесь, а не только в аргументе
   * скрипта: иначе LEADS_MIN_SCORE в .env молча ничего не делает - переменную
   * читал бы shell, а не приложение.
   */
  @IsInt()
  @Min(0)
  @UseEnv('LEADS_MIN_SCORE', parseIntWithDefault(0))
  public readonly leadsMinScore: number;

  @IsString()
  @UseEnv('RESEARCH_DIR', (raw?: string) => (raw ?? '').trim() || 'research')
  public readonly dir: string;
}
