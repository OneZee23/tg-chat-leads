import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LeadEntity, LeadStatus } from '@modules/lead/lead.entity';
import { ListLeadsQueryDto } from '@modules/lead/dto/list-leads.query.dto';
import { In, Repository } from 'typeorm';

export interface UpsertLeadInput {
  tgUserId: string;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  isPremium: boolean;
  langCode: string | null;
  sourceChat: string;
  sourceChatTitle: string | null;
  messageId: string;
  messageDate: Date;
  isAd: boolean;
  score: number;
  keywords: string[];
  sampleText: string | null;
}

@Injectable()
export class LeadService {
  constructor(
    @InjectRepository(LeadEntity)
    private readonly repo: Repository<LeadEntity>,
  ) {}

  /**
   * Кладём лида. Дедуп делает Postgres через уникальный индекс по
   * tg_user_id — в коде нет ни read-modify-write, ни гонки между
   * историческим сканом и live-слушателем, которые вполне могут увидеть
   * одного человека одновременно.
   *
   * Правила слияния при повторной встрече:
   *  • имя/ник/телефон — обновляем, но не затираем непустое пустым
   *    (в одном сообщении сендер может прийти без части полей);
   *  • источник и первое сообщение — не трогаем, первая встреча главнее;
   *  • образец текста и ключевые слова — берём от самого «рекламного»
   *    сообщения, иначе свежее «спасибо!» затрёт полезное объявление;
   *  • score — максимум за всё время.
   *
   * `xmax = 0` — штатный способ отличить вставку от обновления в
   * INSERT … ON CONFLICT: у только что вставленной версии строки xmax нулевой.
   */
  public async upsert(input: UpsertLeadInput): Promise<{ created: boolean }> {
    const rows: Array<{ created: boolean }> = await this.repo.query(
      `
      INSERT INTO tg_lead (
        tg_user_id, username, first_name, last_name, phone, is_premium, lang_code,
        source_chat, source_chat_title, first_message_id,
        first_seen_at, last_seen_at,
        messages_count, ad_messages_count, sample_text, matched_keywords, score
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11, 1, $12, $13, $14, $15)
      ON CONFLICT (tg_user_id) DO UPDATE SET
        username          = COALESCE(EXCLUDED.username, tg_lead.username),
        first_name        = COALESCE(EXCLUDED.first_name, tg_lead.first_name),
        last_name         = COALESCE(EXCLUDED.last_name, tg_lead.last_name),
        phone             = COALESCE(EXCLUDED.phone, tg_lead.phone),
        is_premium        = EXCLUDED.is_premium,
        lang_code         = COALESCE(EXCLUDED.lang_code, tg_lead.lang_code),
        first_seen_at     = LEAST(tg_lead.first_seen_at, EXCLUDED.first_seen_at),
        last_seen_at      = GREATEST(tg_lead.last_seen_at, EXCLUDED.last_seen_at),
        messages_count    = tg_lead.messages_count + 1,
        ad_messages_count = tg_lead.ad_messages_count + EXCLUDED.ad_messages_count,
        sample_text       = CASE WHEN EXCLUDED.score > tg_lead.score
                                 THEN EXCLUDED.sample_text ELSE tg_lead.sample_text END,
        matched_keywords  = CASE WHEN EXCLUDED.score > tg_lead.score
                                 THEN EXCLUDED.matched_keywords ELSE tg_lead.matched_keywords END,
        score             = GREATEST(tg_lead.score, EXCLUDED.score),
        updated_at        = now()
      RETURNING (xmax = 0) AS created
      `,
      [
        input.tgUserId,
        input.username,
        input.firstName,
        input.lastName,
        input.phone,
        input.isPremium,
        input.langCode,
        input.sourceChat,
        input.sourceChatTitle,
        input.messageId,
        input.messageDate,
        input.isAd ? 1 : 0,
        input.sampleText,
        input.keywords,
        input.score,
      ],
    );

    return { created: rows[0]?.created === true };
  }

  public async list(
    query: ListLeadsQueryDto,
  ): Promise<{ total: number; items: LeadEntity[] }> {
    const qb = this.buildQuery(query);
    const total = await qb.getCount();

    const items = await qb
      .orderBy('lead.score', 'DESC')
      .addOrderBy('lead.lastSeenAt', 'DESC')
      .limit(query.limit ?? 100)
      .offset(query.offset ?? 0)
      .getMany();

    return { total, items };
  }

  /**
   * CSV для ручной работы: открываешь в таблице, идёшь сверху вниз,
   * пишешь людям. Отдаём и ссылку на профиль, чтобы не собирать её руками.
   */
  public async exportCsv(query: ListLeadsQueryDto): Promise<string> {
    const items = await this.buildQuery(query)
      .orderBy('lead.score', 'DESC')
      .addOrderBy('lead.lastSeenAt', 'DESC')
      .limit(query.limit ?? 5000)
      .getMany();

    const header = [
      'username',
      'link',
      'name',
      'score',
      'ad_messages',
      'messages',
      'chat',
      'last_seen',
      'status',
      'keywords',
      'sample_text',
    ];

    const lines = items.map((lead) =>
      [
        lead.username ? `@${lead.username}` : '',
        profileLink(lead),
        [lead.firstName, lead.lastName].filter(Boolean).join(' '),
        String(lead.score),
        String(lead.adMessagesCount),
        String(lead.messagesCount),
        lead.sourceChat ?? '',
        lead.lastSeenAt ? lead.lastSeenAt.toISOString().slice(0, 10) : '',
        lead.status,
        (lead.matchedKeywords ?? []).join(' '),
        (lead.sampleText ?? '').replace(/\s+/g, ' ').trim(),
      ]
        .map(csvCell)
        .join(','),
    );

    // BOM в начале: без него Excel открывает кириллицу кракозябрами.
    return `﻿${[header.join(','), ...lines].join('\r\n')}\r\n`;
  }

  /**
   * Помечает как `contacted` тех, кому уже писали (список приходит из
   * разбора личных диалогов аккаунта).
   *
   * Трогаем `new` и `sending`: руками проставленные `replied`, `registered`
   * или `skip` автоматика переписывать не имеет права — она знает меньше
   * тебя. А вот `sending` — это как раз оборвавшаяся рассылка, и здесь
   * наличие переписки в личке лучшее (и единственное) доказательство того,
   * что человеку успело уйти.
   *
   * `= ANY($1::bigint[])` вместо `IN (...)`: список может быть в сотни
   * элементов, а так это один параметр и один план запроса.
   *
   * Про возвращаемое значение — грабли TypeORM. Для UPDATE и DELETE
   * `query()` отдаёт НЕ массив строк, а пару `[rows, rowCount]`
   * (PostgresQueryRunner, ветка по `raw.command`). Поэтому `.length` здесь
   * всегда 2, сколько бы строк ни обновилось, и считать надо второй элемент.
   */
  public async markContacted(tgUserIds: string[]): Promise<number> {
    if (tgUserIds.length === 0) return 0;

    const [, affected]: [unknown[], number] = await this.repo.query(
      `
      UPDATE tg_lead
      SET status       = 'contacted',
          contacted_at = COALESCE(contacted_at, now()),
          note         = COALESCE(note, 'автоопределено: в личке уже есть моё сообщение'),
          updated_at   = now()
      WHERE tg_user_id = ANY($1::bigint[])
        AND status IN ('new', 'sending')
      `,
      [tgUserIds],
    );

    return affected ?? 0;
  }

  public async updateStatus(
    id: string,
    status: LeadStatus,
    note?: string,
  ): Promise<LeadEntity> {
    const lead = await this.repo.findOneBy({ id });
    if (!lead) throw new NotFoundException('Lead not found');

    lead.status = status;
    if (note !== undefined) lead.note = note;
    // Дата первого контакта проставляется один раз: если потом переведёшь
    // в replied/registered, «когда я ему написал» должно сохраниться.
    if (status === 'contacted' && !lead.contactedAt) lead.contactedAt = new Date();

    return this.repo.save(lead);
  }

  /**
   * Кому можно писать прямо сейчас: ещё не трогали и есть @ник.
   * Без ника писать некуда — `tg://user?id=` открывается только если у вас
   * есть общий чат, так что такие лиды в рабочий список не попадают.
   *
   * Сортировка: сначала самые «рекламные», при равном score — те, кто
   * публиковался недавно. Человек, разместивший объявление вчера, ищет
   * учеников сейчас; тот, кто писал в марте, скорее всего уже нет.
   */
  public async findForOutreach(
    limit: number,
  ): Promise<{ total: number; items: LeadEntity[] }> {
    const qb = this.repo
      .createQueryBuilder('lead')
      .where('lead.status = :status', { status: 'new' })
      .andWhere('lead.username IS NOT NULL');

    const total = await qb.getCount();
    const items = await qb
      .orderBy('lead.score', 'DESC')
      .addOrderBy('lead.lastSeenAt', 'DESC')
      .limit(limit)
      .getMany();

    return { total, items };
  }

  /**
   * Ручная пометка по никам — чтобы не выковыривать uuid из выдачи.
   * Ник сравниваем в нижнем регистре: в Telegram он регистронезависим,
   * и «@example_tutor» из списка должен находиться как «@konstantsiia».
   */
  public async markByUsernames(usernames: string[], status: LeadStatus): Promise<number> {
    const normalized = usernames
      .map((name) => name.trim().replace(/^@/, '').toLowerCase())
      .filter((name) => name.length > 0);

    if (normalized.length === 0) return 0;

    // См. комментарий в markContacted: на UPDATE typeorm отдаёт [rows, count].
    const [, affected]: [unknown[], number] = await this.repo.query(
      `
      UPDATE tg_lead
      SET status       = $2::text,
          contacted_at = CASE WHEN $2::text = 'contacted'
                              THEN COALESCE(contacted_at, now()) ELSE contacted_at END,
          updated_at   = now()
      WHERE lower(username) = ANY($1::text[])
      `,
      [normalized, status],
    );

    return affected ?? 0;
  }

  /**
   * Забирает лида в работу рассылки: `new` → `sending`, атомарно.
   *
   * Статус меняется ДО отправки намеренно. Если процесс умрёт между
   * отправкой и отметкой, человек получит сообщение и останется `new` —
   * то есть при следующем запуске получит его второй раз. Лучше наоборот:
   * при падении лид застрянет в `sending`, и это видно глазами, а
   * повторного сообщения человек не получит.
   *
   * `FOR UPDATE SKIP LOCKED` — на случай, если рассылку случайно запустят
   * дважды: второй процесс возьмёт других людей, а не тех же самых.
   */
  public async claimForSending(limit: number): Promise<LeadEntity[]> {
    return this.repo.manager.transaction(async (em) => {
      const rows: Array<{ id: string }> = await em.query(
        `
        SELECT id FROM tg_lead
        WHERE status = 'new' AND username IS NOT NULL
        ORDER BY score DESC, last_seen_at DESC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
        `,
        [limit],
      );
      if (rows.length === 0) return [];

      const ids = rows.map((row) => row.id);
      await em.query(
        `UPDATE tg_lead SET status = 'sending', updated_at = now() WHERE id = ANY($1::uuid[])`,
        [ids],
      );

      // Порядок обязан совпадать с порядком выборки. find() его не
      // гарантирует, а он тут не косметика: если рассылка упадёт на
      // середине, только по порядку можно понять, кому уже ушло.
      const loaded = await em.getRepository(LeadEntity).find({ where: { id: In(ids) } });
      const byId = new Map(loaded.map((lead) => [lead.id, lead]));

      return ids.map((id) => byId.get(id)).filter((lead): lead is LeadEntity => !!lead);
    });
  }

  public async finishSending(
    id: string,
    outcome: 'contacted' | 'failed',
    note: string,
  ): Promise<void> {
    await this.repo.query(
      `
      UPDATE tg_lead
      SET status       = $2::text,
          contacted_at = CASE WHEN $2::text = 'contacted'
                              THEN COALESCE(contacted_at, now()) ELSE contacted_at END,
          note         = $3,
          updated_at   = now()
      WHERE id = $1
      `,
      [id, outcome, note],
    );
  }

  /**
   * Вернуть в очередь тех, кому НИЧЕГО не отправлялось (рассылка
   * остановилась раньше, чем дошла до них). Именно `new`, а не `failed`:
   * `failed` означает «пытались и не вышло», и такие люди выпадают из
   * работы, хотя ни одного сообщения не получили.
   */
  public async releaseToQueue(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;

    const [, affected]: [unknown[], number] = await this.repo.query(
      `UPDATE tg_lead SET status = 'new', updated_at = now() WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    return affected ?? 0;
  }

  /**
   * Вернуть застрявших в `sending` обратно в очередь после падения.
   *
   * Слепо возвращать всех нельзя, и это главная опасность этой ручки.
   * Лид законно оказывается в `sending` с уже УШЕДШИМ сообщением: в
   * SenderService.deliver попытка закрывается как `sent` раньше, чем
   * проставляется статус лида, а сбой второй записи проглатывается
   * (safeFinishLead только логирует). Такой человек уже получил письмо —
   * вернуть его в очередь значит отправить второе.
   *
   * Поэтому решение принимает журнал: возвращаем только тех, у кого НЕТ
   * попытки со следом отправки. Остальных отдаём списком, чтобы человек
   * разобрал их руками — глядя в диалог, а не в статус.
   */
  public async releaseStuckSending(): Promise<{
    released: number;
    keptForReview: Array<{
      username: string | null;
      tgUserId: string;
      lastResult: string;
    }>;
  }> {
    const risky: Array<{ username: string | null; tg_user_id: string; result: string }> =
      await this.repo.query(
        `
        SELECT l.username, l.tg_user_id, a.result
        FROM tg_lead l
        JOIN LATERAL (
          SELECT result FROM tg_send_attempt
          WHERE lead_id = l.id
          ORDER BY started_at DESC
          LIMIT 1
        ) a ON true
        WHERE l.status = 'sending'
          AND a.result IN ('sent', 'started')
        `,
      );

    const [, affected]: [unknown[], number] = await this.repo.query(
      `
      UPDATE tg_lead SET status = 'new', updated_at = now()
      WHERE status = 'sending'
        AND NOT EXISTS (
          SELECT 1 FROM tg_send_attempt a
          WHERE a.lead_id = tg_lead.id
            AND a.result IN ('sent', 'started')
            AND a.started_at > now() - interval '7 days'
        )
      `,
    );

    return {
      released: affected ?? 0,
      keptForReview: risky.map((row) => ({
        username: row.username,
        tgUserId: String(row.tg_user_id),
        lastResult: row.result,
      })),
    };
  }

  /**
   * Всё ещё ли лид занят нашей рассылкой.
   *
   * Между тем как пачка занята и тем как до конкретного человека дойдёт
   * очередь, проходят минуты. За это время сверка с личкой (она трогает и
   * `sending`) могла перевести его в `contacted` — значит письмо уже есть,
   * и отправлять второе нельзя.
   */
  public async isStillClaimed(id: string): Promise<boolean> {
    const rows: Array<{ status: string }> = await this.repo.query(
      `SELECT status FROM tg_lead WHERE id = $1`,
      [id],
    );
    return rows[0]?.status === 'sending';
  }

  /**
   * telegram-id всех, кто ещё в работе. Нужен сверке с личкой: глубокая
   * проверка стоит запрос к Telegram на диалог, и гонять её по всем 300
   * личным чатам бессмысленно — 9 из 10 это друзья и родня, которых в
   * базе лидов нет и пометить некого.
   */
  public async getPendingTgIds(): Promise<Set<string>> {
    const rows: Array<{ tg_user_id: string }> = await this.repo.query(
      `SELECT tg_user_id FROM tg_lead WHERE status IN ('new', 'sending')`,
    );
    return new Set(rows.map((row) => String(row.tg_user_id)));
  }

  /**
   * telegram-id → момент отправки, для тех кому уже написали.
   * Нужен для распознавания ответов: входящее сообщение считается ответом
   * только если оно ПОЗЖЕ нашего письма. Иначе в «ответившие» попадут те,
   * кто когда-то писал тебе по совсем другому поводу.
   */
  public async getContactedAtMap(): Promise<Map<string, Date | null>> {
    const rows: Array<{ tg_user_id: string; contacted_at: Date | null }> =
      await this.repo.query(
        `SELECT tg_user_id, contacted_at FROM tg_lead WHERE status = 'contacted'`,
      );

    return new Map(rows.map((row) => [String(row.tg_user_id), row.contacted_at]));
  }

  /** Перевод в `replied`. Трогаем только `contacted` — остальное руками. */
  public async markReplied(tgUserIds: string[]): Promise<number> {
    if (tgUserIds.length === 0) return 0;

    // См. markContacted: на UPDATE typeorm отдаёт [rows, count].
    const [, affected]: [unknown[], number] = await this.repo.query(
      `
      UPDATE tg_lead
      SET status = 'replied', updated_at = now()
      WHERE tg_user_id = ANY($1::bigint[])
        AND status = 'contacted'
      `,
      [tgUserIds],
    );

    return affected ?? 0;
  }

  /**
   * Сводка по аутричу: написано / ответили.
   *
   * Знаменатель считаем по `contacted_at`, а не по набору статусов: человек,
   * которому написали и которого потом пометили `skip`, из статусов выпадает,
   * и конверсия задирается вверх. Факт отправки не отменяется тем, что мы
   * потом передумали с ним работать.
   */
  public async outreachSummary(): Promise<{ contacted: number; replied: number }> {
    const rows: Array<{ contacted: string; replied: string }> = await this.repo.query(
      `
      SELECT
        count(*) FILTER (WHERE contacted_at IS NOT NULL)::text AS contacted,
        count(*) FILTER (
          WHERE contacted_at IS NOT NULL
            AND status IN ('replied', 'registered', 'rejected')
        )::text AS replied
      FROM tg_lead
      `,
    );

    return {
      contacted: Number(rows[0]?.contacted ?? 0),
      replied: Number(rows[0]?.replied ?? 0),
    };
  }

  public async stats(): Promise<Record<string, number>> {
    const rows: Array<{ status: string; count: string }> = await this.repo
      .createQueryBuilder('lead')
      .select('lead.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .groupBy('lead.status')
      .getRawMany();

    const byStatus = Object.fromEntries(rows.map((r) => [r.status, Number(r.count)]));
    const total = Object.values(byStatus).reduce((sum, n) => sum + n, 0);

    return { total, ...byStatus };
  }

  private buildQuery(query: ListLeadsQueryDto) {
    const qb = this.repo.createQueryBuilder('lead');

    if (query.status) {
      qb.andWhere('lead.status = :status', { status: query.status });
    }
    if (query.minScore !== undefined) {
      qb.andWhere('lead.score >= :minScore', { minScore: query.minScore });
    }
    if (query.chat) {
      qb.andWhere('lead.sourceChat = :chat', { chat: query.chat });
    }
    if (query.hasUsername === true) {
      qb.andWhere('lead.username IS NOT NULL');
    } else if (query.hasUsername === false) {
      qb.andWhere('lead.username IS NULL');
    }
    if (query.search) {
      // ILIKE по нику, имени и тексту образца. Экранируем % и _, иначе
      // поиск по «100%» превращается в маску.
      const needle = `%${query.search.replace(/[%_\\]/g, (ch) => `\\${ch}`)}%`;
      qb.andWhere(
        `(lead.username ILIKE :needle ESCAPE '\\'
          OR lead.firstName ILIKE :needle ESCAPE '\\'
          OR lead.lastName ILIKE :needle ESCAPE '\\'
          OR lead.sampleText ILIKE :needle ESCAPE '\\')`,
        { needle },
      );
    }

    return qb;
  }
}

function profileLink(lead: LeadEntity): string {
  return lead.username
    ? `https://t.me/${lead.username}`
    : `tg://user?id=${lead.tgUserId}`;
}

/**
 * Экранирование по RFC 4180 + защита от CSV-инъекции: ячейка, начинающаяся
 * с = + - @, в Excel исполняется как формула. Префиксуем апострофом.
 */
function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}
