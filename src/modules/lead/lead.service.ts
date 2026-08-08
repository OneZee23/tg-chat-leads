import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LeadEntity, LeadStatus } from '@modules/lead/lead.entity';
import { ListLeadsQueryDto } from '@modules/lead/dto/list-leads.query.dto';
import { Repository } from 'typeorm';

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
