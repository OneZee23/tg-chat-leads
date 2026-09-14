import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { LEAD_SOURCES, LeadSource } from '@modules/lead/lead.entity';

/**
 * Потолок пачки.
 *
 * Каждая строка — один contacts.ResolveUsername плюс пауза с джиттером
 * (см. RESOLVE_DELAY_MS): полсотни ников это 2–5 минут работы, и столько
 * ещё разумно ждать ответа в curl. Дальше начинается другое: и таймаут
 * клиента, и — главное — ровная очередь резолвов, которая сама по себе
 * выглядит как автоматизация, а FloodWait на резолве потом блокирует
 * рассылку (SenderService проверяет его перед каждым запуском).
 * Список длиннее — режь на пачки, дедуп повторную строку всё равно отсеет.
 */
export const MAX_IMPORT_BATCH = 50;

/**
 * Руками заводить можно только ВНЕШНИЕ источники. `tg_chat` ставит один
 * сканер, и разрешить его здесь значит своими руками испортить ту самую
 * метрику, ради которой поле заведено: пачка «из гугла», помеченная чатом,
 * задерёт конверсию чата.
 */
export const IMPORTABLE_LEAD_SOURCES = LEAD_SOURCES.filter(
  (source) => source !== 'tg_chat',
);

export class ImportLeadItemDto {
  /** `@nick`, `nick` или ссылка `t.me/nick` — нормализуем всё это сами. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  public readonly contact: string;

  /** Как человек подписан на сайте. Пригодится, если Telegram имени не даст. */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  public readonly name?: string;

  /** Откуда именно контакт: ссылка на страницу, предмет, город. */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  public readonly note?: string;
}

export class ImportLeadsDto {
  @IsIn(IMPORTABLE_LEAD_SOURCES as unknown as string[])
  public readonly source: LeadSource;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_IMPORT_BATCH)
  @ValidateNested({ each: true })
  @Type(() => ImportLeadItemDto)
  public readonly items: ImportLeadItemDto[];
}
