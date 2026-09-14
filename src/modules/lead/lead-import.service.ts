import { Injectable, Logger } from '@nestjs/common';
import { Api } from 'telegram';
import { FloodWaitError } from 'telegram/errors';
import { sleepJitter } from '@common/utils/sleep';
import { ImportLeadItemDto, ImportLeadsDto } from '@modules/lead/dto/import-leads.dto';
import { normalizeUsername } from '@modules/lead/lead-username';
import { LeadSource } from '@modules/lead/lead.entity';
import { LeadService } from '@modules/lead/lead.service';
import { FloodWaitTracker } from '@modules/telegram/flood-wait.tracker';
import { TelegramClientService } from '@modules/telegram/telegram-client.service';

/**
 * Ручной импорт лидов из внешних источников: Google, Яндекс, Instagram.
 *
 * Смысл в измерении. Сканер чатов — единственный канал сбора, который у нас
 * есть, и понять, хуже он или лучше поиска, можно только заведя контакты
 * оттуда в ту же базу и сравнив процент ответа (`source` в `tg_lead`).
 * Писать всем всё равно в Telegram, поэтому единственное, что нужно от
 * внешнего источника, — @ник.
 *
 * Ника недостаточно: дедуп в базе идёт по `tg_user_id`, и id мы узнаём
 * только у Telegram — тем же `getEntity`, которым сканер открывает чаты.
 */

/**
 * Пауза между резолвами. contacts.ResolveUsername — обычный запрос, и
 * полсотни таких подряд ровным ритмом выглядят ровно тем, чем являются.
 * Джиттер даёт 4–8 секунд: см. решение про `sleepJitter` в CLAUDE.md.
 */
const RESOLVE_DELAY_MS = 4000;

/**
 * Score импортированного лида.
 *
 * Ноль ставить нельзя: очередь рассылки (`findForOutreach`) сортируется по
 * score, и внешние лиды осели бы на дне — сравнивать источники было бы не с
 * чем, до отправки они бы просто не дошли. Берём AD_MIN_SCORE по умолчанию:
 * человек, разместивший объявление на своей странице, — сигнал не слабее
 * объявления в чате, но и не сильнее, чтобы не лезть вперёд лучших лидов.
 */
const IMPORT_SCORE = 3;

export type ImportOutcome = 'created' | 'duplicate' | 'failed';

export interface ImportEntry {
  /** Строка ровно как её прислали — чтобы человек нашёл её в своём списке. */
  contact: string;
  username: string | null;
  result: ImportOutcome;
  tgUserId?: string;
  error?: string;
}

export interface ImportReport {
  source: LeadSource;
  requested: number;
  created: number;
  duplicates: number;
  failed: number;
  entries: ImportEntry[];
}

@Injectable()
export class LeadImportService {
  private readonly logger = new Logger(LeadImportService.name);

  constructor(
    private readonly telegram: TelegramClientService,
    private readonly leads: LeadService,
    private readonly flood: FloodWaitTracker,
  ) {}

  public async import(dto: ImportLeadsDto): Promise<ImportReport> {
    const entries: ImportEntry[] = [];

    // Уже известные ники отсекаем ДО Telegram: повторный импорт того же
    // списка — норма (человек добивает выдачу по частям), и сжигать на нём
    // лимит резолва незачем. Настоящий дедуп всё равно ниже, в ON CONFLICT.
    const normalized = dto.items.map((item) => normalizeUsername(item.contact));
    const known = await this.leads.existingUsernames(
      normalized.filter((name): name is string => name !== null),
    );

    // Резолв зажат — дальше идти бессмысленно: каждая строка упрётся в тот
    // же лимит, и мы только продлим его новыми попытками.
    let floodStop = this.flood.forMethod('contacts.ResolveUsername')?.human ?? null;

    /** Сколько раз уже сходили в Telegram: нужен для паузы «между», а не «перед». */
    let resolved = 0;

    for (const [index, item] of dto.items.entries()) {
      const username = normalized[index];

      if (username === null) {
        entries.push(fail(item, null, 'не похоже на @ник или ссылку t.me'));
        continue;
      }
      if (known.has(username)) {
        entries.push({ contact: item.contact, username, result: 'duplicate' });
        continue;
      }
      if (floodStop) {
        entries.push(
          fail(item, username, `не резолвили: лимит Telegram ещё ${floodStop}`),
        );
        continue;
      }

      // Пауза только между обращениями к Telegram: строки, отсеянные выше
      // (мусор и уже известные), в сеть не ходят, и ждать из-за них нечего.
      if (resolved > 0) await sleepJitter(RESOLVE_DELAY_MS);
      resolved += 1;

      try {
        const user = await this.resolveUser(username);
        const { created } = await this.leads.upsert({
          tgUserId: user.id.toString(),
          // Ник берём тот, что вернул Telegram: в списке он мог быть записан
          // в другом регистре, а мы показываем его человеку в отчётах.
          username: user.username ?? username,
          // Имя из Telegram важнее переписанного с сайта: под ним человек
          // отвечает, и по нему его узнаёшь в диалоге. Имя из списка —
          // запасной вариант для профилей без имени.
          firstName: user.firstName ?? item.name?.trim() ?? null,
          lastName: user.lastName ?? null,
          phone: user.phone ?? null,
          isPremium: user.premium === true,
          langCode: user.langCode ?? null,
          source: dto.source,
          // Чата нет: человека нашли вне Telegram.
          sourceChat: null,
          sourceChatTitle: null,
          messageId: null,
          messageDate: new Date(),
          isAd: false,
          score: IMPORT_SCORE,
          keywords: [],
          // Текст объявления, если он есть у источника (например, пост в
          // публичном канале). По нему строится персональная первая строка
          // письма; без него уйдёт общая формулировка — врать про «ваш
          // предмет», не видя предмета, нельзя.
          sampleText: item.about?.trim() || null,
          note: item.note?.trim() || null,
        });

        // Пополняем набор известных сразу: дважды вставленная в список
        // строка — обычное дело при ручном сборе — стоит одного резолва,
        // а не двух. Ник из Telegram тоже, он мог отличаться от нашего.
        known.add(username);
        if (user.username) known.add(user.username.toLowerCase());

        entries.push({
          contact: item.contact,
          username: user.username ?? username,
          result: created ? 'created' : 'duplicate',
          tgUserId: user.id.toString(),
        });
      } catch (err) {
        if (err instanceof FloodWaitError) {
          // Лимит пришёл прямо сейчас — оставшиеся строки даже не пробуем.
          floodStop = `${err.seconds}s`;
          this.logger.warn(`Импорт остановлен: FloodWait ${err.seconds}s на резолве`);
        }
        entries.push(fail(item, username, describeResolveError(err)));
      }
    }

    const report: ImportReport = {
      source: dto.source,
      requested: dto.items.length,
      created: entries.filter((entry) => entry.result === 'created').length,
      duplicates: entries.filter((entry) => entry.result === 'duplicate').length,
      failed: entries.filter((entry) => entry.result === 'failed').length,
      entries,
    };

    this.logger.log(
      `Импорт (${dto.source}): из ${report.requested} заведено ${report.created}, ` +
        `уже было ${report.duplicates}, не вышло ${report.failed}`,
    );

    return report;
  }

  /**
   * @ник → пользователь Telegram. Резолвим тем же `getEntity`, что и сканер;
   * всё, что вернулось не человеком, — ошибка строки, а не всей пачки.
   */
  private async resolveUser(username: string): Promise<Api.User> {
    const entity = await this.telegram.getClient().getEntity(`@${username}`);

    if (!(entity instanceof Api.User)) {
      throw new Error('это канал или группа, а не человек');
    }
    if (entity.bot) throw new Error('это бот');
    if (entity.deleted) throw new Error('аккаунт удалён');
    if (entity.self) throw new Error('это твой собственный аккаунт');

    return entity;
  }
}

function fail(
  item: ImportLeadItemDto,
  username: string | null,
  error: string,
): ImportEntry {
  return { contact: item.contact, username, result: 'failed', error };
}

/**
 * Человеческий текст ошибки резолва.
 *
 * Отдельных классов под USERNAME_* в GramJS нет — это generic RPCError с
 * кодом в тексте, — поэтому разбираем по строке. Смысл в том, чтобы в
 * построчном отчёте было видно, что чинить: опечатку в нике, приватность
 * или собственный лимит.
 */
function describeResolveError(err: unknown): string {
  if (err instanceof FloodWaitError) {
    return `Telegram просит подождать ${err.seconds}s — резолв остановлен`;
  }

  const message = err instanceof Error ? err.message : String(err);

  if (message.includes('USERNAME_NOT_OCCUPIED')) return 'такого ника не существует';
  if (message.includes('USERNAME_INVALID')) return 'ник недопустим для Telegram';
  if (/cannot find any entity|no user has/i.test(message)) {
    return 'Telegram не отдал профиль по этому нику';
  }

  return message;
}
