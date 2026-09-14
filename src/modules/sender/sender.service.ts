import { Injectable, Logger } from '@nestjs/common';
import { FloodWaitError } from 'telegram/errors';
import { sleepJitter } from '@common/utils/sleep';
import { AccountService } from '@modules/account/account.service';
import { LeadEntity } from '@modules/lead/lead.entity';
import { LeadService } from '@modules/lead/lead.service';
import {
  AccountLoad,
  describePickFailure,
  pickAccount,
} from '@modules/sender/account-pick';
import {
  captionFits,
  loadMessageContent,
  MessageContent,
} from '@modules/sender/message-content';
import { buildOutreachMessage } from '@modules/sender/outreach-message';
import { DailyBudget, SendAttemptService } from '@modules/sender/send-attempt.service';
import { SenderConfig } from '@modules/sender/sender.config';
import { FloodWaitTracker } from '@modules/telegram/flood-wait.tracker';
import {
  TelegramAccount,
  TelegramAccountsService,
} from '@modules/telegram/telegram-accounts.service';

export interface SendAccountReport {
  name: string;
  /** @ник аккаунта — «main» человеку ни о чём не говорит. */
  title: string;
  /** Отправлено этим запуском. */
  sentNow: number;
  /** Отправлено за скользящие сутки, вместе с этим запуском. */
  used: number;
  remaining: number;
  unlimited: boolean;
}

export interface SendReport {
  dryRun: boolean;
  attempted: number;
  sent: number;
  failed: number;
  skipped: number;
  stoppedBecause: string;
  /** Остановились из-за ограничения аккаунта. Планировщик обязан это учесть. */
  fatal: boolean;
  /** Суммарно по всем аккаунтам. Потолок считается на каждый отдельно. */
  dailyBudget: { limit: number; used: number; remaining: number; unlimited: boolean };
  /** Разрез по аккаунтам. С одним аккаунтом здесь ровно одна строка. */
  accounts: SendAccountReport[];
  entries: Array<{
    username: string;
    result: 'sent' | 'dry-run' | 'failed' | 'skipped';
    /** Кто отправлял (или отправил бы). */
    account?: string;
    error?: string;
  }>;
}

/** Аккаунт в рамках одного запуска: бюджет на старте плюс счётчик. */
interface AccountRun {
  account: TelegramAccount;
  budget: DailyBudget;
  sentNow: number;
}

/**
 * Ошибки, после которых продолжать нельзя ни при каких обстоятельствах.
 * PEER_FLOOD означает, что аккаунт уже ограничен за рассылку незнакомцам:
 * каждое следующее сообщение только утяжеляет ограничение.
 */
const FATAL_ERRORS = [
  'PEER_FLOOD',
  'USER_BANNED_IN_CHANNEL',
  'AUTH_KEY',
  'SESSION_REVOKED',
];

/**
 * Альбом ушёл, а текст следом — нет. Сообщение человек уже видит, поэтому
 * это НЕ провал: считать его провалом значит отправить всё заново.
 */
class PartialDeliveryError extends Error {
  constructor(public readonly cause: unknown) {
    super(`частичная доставка: картинки ушли, текст — нет (${describeError(cause)})`);
  }
}

@Injectable()
export class SenderService {
  private readonly logger = new Logger(SenderService.name);

  private running = false;

  constructor(
    private readonly config: SenderConfig,
    private readonly accounts: TelegramAccountsService,
    private readonly leads: LeadService,
    private readonly attempts: SendAttemptService,
    private readonly account: AccountService,
    private readonly flood: FloodWaitTracker,
  ) {}

  public isRunning(): boolean {
    return this.running;
  }

  /**
   * Флаг занятости ставится СРАЗУ после проверки, до любых await.
   * Раньше он выставлялся уже после обращения к @SpamBot, а тот при
   * холодном кеше опрашивается до десяти секунд — за это окно в run
   * заходил второй вызов, оба читали один и тот же остаток бюджета, и
   * суточная норма удваивалась.
   */
  /**
   * `dryRunOverride` — предпросмотр по требованию, поверх `SEND_DRY_RUN`.
   *
   * Нужен, чтобы команда «покажи, кому уйдёт» существовала независимо от
   * конфига: при боевом `SEND_DRY_RUN=false` иначе нет способа посмотреть,
   * не отправив.
   */
  public async run(
    limitOverride?: number,
    dryRunOverride?: boolean,
  ): Promise<SendReport> {
    if (this.running) throw new Error('Рассылка уже идёт');
    this.running = true;

    try {
      return await this.execute(limitOverride, dryRunOverride);
    } finally {
      this.running = false;
    }
  }

  /** Ровно одно сообщение — режим расписания. */
  public async sendOne(): Promise<SendReport> {
    return this.run(1);
  }

  private async execute(
    limitOverride?: number,
    dryRunOverride?: boolean,
  ): Promise<SendReport> {
    // Предпросмотр можно включить поверх конфига, но НЕ выключить им:
    // `SEND_DRY_RUN=true` остаётся жёстким запретом на отправку.
    const dryRun = this.config.dryRun || dryRunOverride === true;
    const content = loadMessageContent(this.config.contentDir);
    // Явный limit из команды главнее SEND_MAX_PER_RUN: ты набираешь это
    // число руками на каждый запуск. Суточный бюджет — другое дело,
    // он обойти не даёт, в том числе и явным числом.
    const requested = limitOverride ?? this.config.maxPerRun;

    const { runs, blocked } = await this.prepareAccounts(dryRun);
    for (const reason of blocked) this.logger.warn(reason);

    const report: SendReport = {
      dryRun,
      attempted: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
      stoppedBecause: 'очередь закончилась',
      fatal: false,
      dailyBudget: this.totals(runs),
      accounts: this.accountReports(runs),
      entries: [],
    };

    if (!dryRun) {
      if (runs.length === 0) {
        // Отправлять нечем: либо аккаунты не подняты, либо все зажаты.
        report.stoppedBecause =
          blocked.length > 0
            ? blocked.join('; ')
            : 'нет подключённых телеграм-аккаунтов';
        return report;
      }

      const stop = await this.blockReason(report.dailyBudget.remaining);
      if (stop) {
        report.stoppedBecause = stop.reason;
        report.fatal = stop.fatal;
        return report;
      }
    }

    // Бюджет режет запрошенное число, и об этом честно пишем в отчёте —
    // молча урезать значит соврать о том, сколько людей получит письмо.
    const limit = dryRun
      ? requested
      : Math.min(requested, report.dailyBudget.remaining);

    // В dry-run лидов не занимаем: статусы должны остаться нетронутыми,
    // иначе «просто посмотреть» молча выведет людей из очереди.
    const targets = dryRun
      ? (await this.leads.findForOutreach(limit)).items
      : await this.leads.claimForSending(limit);

    let consecutiveErrors = 0;

    for (const [index, lead] of targets.entries()) {
      report.attempted += 1;

      const pick = pickAccount(lead.assignedAccount, this.loads(runs, dryRun));
      if (pick.reason) {
        const why = describePickFailure(pick.reason);

        // Кончились лимиты у всех — дальше по списку будет то же самое.
        if (pick.reason === 'all_exhausted') {
          report.stoppedBecause = why;
          if (!dryRun) await this.releaseRest(targets, index);
          break;
        }

        // Причина в конкретном человеке (его ведёт аккаунт, которого
        // сейчас нет или у которого лимит исчерпан) — остальным это не
        // мешает. Возвращаем его в очередь и идём дальше.
        report.skipped += 1;
        report.entries.push({ username: lead.username, result: 'skipped', error: why });
        this.logger.warn(`Пропущен @${lead.username}: ${why}`);
        if (!dryRun) await this.leads.releaseToQueue([lead.id]);
        continue;
      }

      const run = runs.find((r) => r.account.name === pick.account);
      /* istanbul ignore next: pickAccount выбирает только из этого же списка */
      if (!run) throw new Error(`Аккаунт ${pick.account} исчез из пула`);

      if (dryRun) {
        // Считаем и в предпросмотре: иначе список покажет всех на одном
        // аккаунте, а в бою они разойдутся на два — и предпросмотр соврёт.
        run.sentNow += 1;
        report.entries.push({
          username: lead.username,
          result: 'dry-run',
          account: run.account.name,
        });
        continue;
      }

      // Между занятием пачки и очередью конкретного человека проходят
      // минуты. Сверка с личкой за это время могла перевести его в
      // contacted — значит письмо уже есть, второе не шлём.
      if (!(await this.leads.isStillClaimed(lead.id))) {
        report.skipped += 1;
        report.entries.push({ username: lead.username, result: 'skipped' });
        this.logger.warn(
          `Пропущен @${lead.username}: статус изменился, пока ждал очереди`,
        );
        continue;
      }

      let outcome: { ok: boolean; error?: string; fatal?: boolean };
      try {
        outcome = await this.deliver(lead, content, run.account);
      } catch (err) {
        // deliver ловит ошибки отправки сам, поэтому сюда попадает только
        // сбой ДО обращения к Telegram (например запись журнала). Текущему
        // не отправляли — возвращаем в очередь и его, и весь хвост.
        report.stoppedBecause = `внутренняя ошибка: ${describeError(err)}`;
        this.logger.error(report.stoppedBecause);
        await this.releaseRest(targets, index);
        return this.withFreshBudget(report, runs);
      }

      if (outcome.ok) {
        report.sent += 1;
        run.sentNow += 1;
        report.entries.push({
          username: lead.username,
          result: 'sent',
          account: run.account.name,
        });
        consecutiveErrors = 0;
        this.logger.log(
          `Отправлено @${lead.username} с ${run.account.title} ` +
            `(${report.sent}/${targets.length})`,
        );
      } else {
        report.failed += 1;
        report.entries.push({
          username: lead.username,
          result: 'failed',
          account: run.account.name,
          error: outcome.error,
        });
        consecutiveErrors += 1;
        this.logger.warn(`Не отправлено @${lead.username}: ${outcome.error}`);

        if (outcome.fatal) {
          report.stoppedBecause =
            `аккаунт ограничен (${run.account.title}): ${outcome.error}`;
          report.fatal = true;
          // Ограничение уже наступило — сбрасываем кеш статуса, чтобы
          // следующий запуск спросил @SpamBot, а не поверил старому «ок».
          await this.account.status(true).catch(() => undefined);
          await this.releaseRest(targets, index + 1);
          break;
        }
        if (consecutiveErrors >= this.config.maxConsecutiveErrors) {
          report.stoppedBecause = `${consecutiveErrors} ошибки подряд — останавливаюсь`;
          await this.releaseRest(targets, index + 1);
          break;
        }
      }

      if (index < targets.length - 1) {
        await sleepJitter(this.config.delaySec * 1000);
      }
    }

    if (report.stoppedBecause === 'очередь закончилась' && report.attempted >= limit) {
      report.stoppedBecause =
        limit < requested
          ? `суточный бюджет: осталось ${report.dailyBudget.remaining} из ${report.dailyBudget.limit}`
          : `упёрлись в лимит запуска (${limit})`;
    }

    return this.withFreshBudget(report, runs);
  }

  /**
   * Аккаунты, которыми можно писать в этом запуске, каждый со своим
   * суточным счётчиком.
   *
   * Зажатый FloodWait'ом аккаунт выбывает, а не останавливает работу
   * целиком: лимит выдают аккаунту, и пока второй свободен, писать с него
   * можно. Отправка каждого сообщения начинается с getEntity('@ник') —
   * это contacts.ResolveUsername, — поэтому смотрим именно на него.
   */
  private async prepareAccounts(
    dryRun: boolean,
  ): Promise<{ runs: AccountRun[]; blocked: string[] }> {
    const runs: AccountRun[] = [];
    const blocked: string[] = [];

    for (const account of this.accounts.list()) {
      const limit = this.flood.forMethod('contacts.ResolveUsername', account.name);
      if (limit && !dryRun) {
        blocked.push(
          `${account.title}: резолв @ников заблокирован ещё ${limit.human} — не отправляю`,
        );
        continue;
      }

      runs.push({
        account,
        budget: await this.attempts.budget(this.config.maxPerDay, account.name),
        sentNow: 0,
      });
    }

    return { runs, blocked };
  }

  /**
   * Остатки на момент выбора: бюджет на старте минус отправленное прямо
   * сейчас. В предпросмотре потолок не применяем — как и раньше, dry-run
   * показывает очередь целиком, а не урезанную бюджетом.
   */
  private loads(runs: AccountRun[], dryRun: boolean): AccountLoad[] {
    return runs.map((run) => ({
      name: run.account.name,
      used: run.budget.used + run.sentNow,
      remaining: dryRun
        ? Number.MAX_SAFE_INTEGER
        : Math.max(0, run.budget.remaining - run.sentNow),
    }));
  }

  /** Суммарный бюджет по всем аккаунтам — для отчёта и для лимита пачки. */
  private totals(runs: AccountRun[]): SendReport['dailyBudget'] {
    const unlimited = this.config.maxPerDay <= 0;
    const used = runs.reduce((sum, run) => sum + run.budget.used + run.sentNow, 0);

    return {
      // Потолок у каждого аккаунта свой, суммарная ёмкость — их сумма.
      limit: unlimited ? 0 : this.config.maxPerDay * runs.length,
      used,
      remaining: unlimited
        ? Number.MAX_SAFE_INTEGER
        : runs.reduce(
            (sum, run) => sum + Math.max(0, run.budget.remaining - run.sentNow),
            0,
          ),
      unlimited,
    };
  }

  private accountReports(runs: AccountRun[]): SendAccountReport[] {
    return runs.map((run) => ({
      name: run.account.name,
      title: run.account.title,
      sentNow: run.sentNow,
      used: run.budget.used + run.sentNow,
      remaining: run.budget.unlimited
        ? Number.MAX_SAFE_INTEGER
        : Math.max(0, run.budget.remaining - run.sentNow),
      unlimited: run.budget.unlimited,
    }));
  }

  /**
   * Пересчёт бюджета из базы после работы: локальные счётчики не знают о
   * попытках, записанных другими способами.
   */
  private async withFreshBudget(
    report: SendReport,
    runs: AccountRun[],
  ): Promise<SendReport> {
    for (const run of runs) {
      run.budget = await this.attempts.budget(this.config.maxPerDay, run.account.name);
    }
    // budget уже включает отправленное этим запуском — обнуляем локальный
    // счётчик суток, оставив в отчёте только «сколько ушло сейчас».
    const sentNow = new Map<string, number>(
      runs.map((run) => [run.account.name as string, run.sentNow]),
    );
    for (const run of runs) run.sentNow = 0;

    report.dailyBudget = this.totals(runs);
    report.accounts = this.accountReports(runs).map((a) => ({
      ...a,
      sentNow: sentNow.get(a.name) ?? 0,
    }));
    return report;
  }

  /** Почему отправлять нельзя прямо сейчас. null — можно. */
  private async blockReason(
    remaining: number,
  ): Promise<{ reason: string; fatal: boolean } | null> {
    if (remaining <= 0) {
      return {
        reason: `суточный бюджет исчерпан (${this.config.maxPerDay} за 24 часа)`,
        fatal: false,
      };
    }

    // FloodWait на contacts.ResolveUsername проверяется по каждому
    // аккаунту отдельно, в prepareAccounts: зажатый выбывает, остальные
    // работают.
    try {
      // @SpamBot спрашиваем только про основной аккаунт: другой сессией он
      // не опрашивается. Ограничение основного останавливает запуск целиком
      // и осознанно — автоматической ротации при бане здесь нет, такое
      // разбирает человек.
      const status = await this.account.status();
      if (!status.canSend) return { reason: status.reason, fatal: true };
    } catch (err) {
      // Не смогли спросить @SpamBot — это не повод останавливать работу,
      // но и молчать нельзя: человек должен видеть, что предохранитель
      // в этот раз не сработал.
      this.logger.warn(`Не удалось проверить статус аккаунта: ${describeError(err)}`);
    }

    return null;
  }

  private async deliver(
    lead: LeadEntity,
    content: MessageContent,
    account: TelegramAccount,
  ): Promise<{ ok: boolean; error?: string; fatal?: boolean }> {
    // Журнал пишем ДО обращения к Telegram: если процесс умрёт в этот
    // момент, останется строка `started` без исхода — прямое указание
    // проверить диалог руками, а не гадать. Аккаунт пишем туда же: без
    // него потом не понять, в чьей личке искать этот диалог.
    const attemptId = await this.attempts.start(lead, account.name);

    // Персонализированный режим: своя первая строка про предмет человека +
    // тело из body.md, картинки по флагу. Иначе — общий text.md как есть.
    const message = this.config.personalized
      ? buildOutreachMessage(lead.sampleText, content.body)
      : content.text;
    const images =
      this.config.personalized && !this.config.personalizedImages ? [] : content.images;

    try {
      await this.sendTo(account, lead, message, images);
    } catch (err) {
      if (err instanceof PartialDeliveryError) {
        // Картинки человек уже видит. Помечаем отправленным, чтобы не
        // прислать всё заново, но оставляем след в журнале.
        const note = err.message;
        this.logger.warn(`@${lead.username}: ${note}`);
        await this.safeFinishAttempt(attemptId, 'sent', note);
        await this.safeFinishLead(lead, 'contacted', note, account.name);
        return { ok: true };
      }

      const error = describeError(err);
      await this.safeFinishAttempt(attemptId, 'failed', error);
      await this.safeFinishLead(lead, 'failed', `ошибка отправки: ${error}`);
      return { ok: false, error, fatal: isFatal(err) };
    }

    // Отправка удалась. Дальше только запись в базу, и её сбой не имеет
    // права выдать отправленное за неотправленное.
    await this.safeFinishAttempt(attemptId, 'sent');
    // Аккаунт закрепляется за человеком здесь и больше не меняется:
    // фоллоу-ап с другого аккаунта выглядит как второй незнакомец с тем же
    // текстом.
    await this.safeFinishLead(
      lead,
      'contacted',
      `отправлено рассылкой (${account.title})`,
      account.name,
    );
    return { ok: true };
  }

  private async safeFinishAttempt(
    id: string,
    result: 'sent' | 'failed',
    error?: string,
  ): Promise<void> {
    try {
      await this.attempts.finish(id, result, error);
    } catch (err) {
      this.logger.error(`Не удалось закрыть попытку ${id}: ${describeError(err)}`);
    }
  }

  private async safeFinishLead(
    lead: LeadEntity,
    outcome: 'contacted' | 'failed',
    note: string,
    account?: string,
  ): Promise<void> {
    try {
      await this.leads.finishSending(lead.id, outcome, note, account);
    } catch (err) {
      this.logger.error(
        `НЕ УДАЛОСЬ ОТМЕТИТЬ @${lead.username} как ${outcome}: ${describeError(err)}. ` +
          `Отметь вручную: yarn wrote @${lead.username}`,
      );
    }
  }

  private async sendTo(
    account: TelegramAccount,
    lead: LeadEntity,
    text: string,
    images: string[],
  ): Promise<void> {
    const client = account.client;
    const peer = await client.getEntity(`@${lead.username}`);

    if (images.length === 0) {
      await client.sendMessage(peer, { message: text });
      return;
    }

    if (captionFits(text)) {
      await client.sendFile(peer, { file: images, caption: text });
      return;
    }

    // Текст не влезает в подпись — шлём альбом, следом текст. Порядок
    // такой, чтобы человек сначала увидел скриншоты: без них длинная
    // простыня читается как реклама.
    await client.sendFile(peer, { file: images });
    try {
      await client.sendMessage(peer, { message: text });
    } catch (err) {
      throw new PartialDeliveryError(err);
    }
  }

  /**
   * Вернуть в очередь тех, до кого не дошли. Им ничего не отправлялось,
   * поэтому `new`, а не `failed` — иначе при первом же PEER_FLOOD хвост
   * пачки молча выпадет из работы.
   */
  private async releaseRest(targets: LeadEntity[], from: number): Promise<number> {
    return this.leads.releaseToQueue(targets.slice(from).map((lead) => lead.id));
  }
}

function isFatal(err: unknown): boolean {
  if (err instanceof FloodWaitError) return err.seconds > 300;
  const message = describeError(err).toUpperCase();
  return FATAL_ERRORS.some((code) => message.includes(code));
}

function describeError(err: unknown): string {
  if (err instanceof FloodWaitError) return `FloodWait ${err.seconds}s`;
  if (err instanceof Error) return err.message;
  return String(err);
}
