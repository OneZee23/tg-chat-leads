/**
 * Разовый вход в Telegram-аккаунт. Печатает строку сессии, которую надо
 * положить в TG_SESSION в .env.
 *
 *   yarn session:create           — основной аккаунт (TG_SESSION)
 *   yarn session:create second    — второй аккаунт   (TG_SESSION_2)
 *
 * Для второго номер СПРАШИВАЕТСЯ всегда, даже если TG_PHONE заполнен:
 * в .env лежит телефон основного, и молчаливый вход по нему выдал бы
 * вторую сессию того же аккаунта — то есть два клиента на одну сессию,
 * ровно тот случай, который 07.09.2026 стоил аккаунта.
 *
 * Запускать в обычном терминале: скрипт спрашивает код из Telegram, а при
 * включённой двухфакторке — облачный пароль.
 *
 * Строка сессии равнозначна доступу к аккаунту. Её нельзя коммитить,
 * пересылать себе в избранное или показывать в стриме. Если утекла —
 * Telegram → Настройки → Устройства → завершить сеанс.
 */
import 'dotenv/config';
import readline from 'node:readline';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';

const API_ID = Number(process.env.TG_API_ID);
const API_HASH = process.env.TG_API_HASH ?? '';
const PHONE = process.env.TG_PHONE ?? '';

/** Какой слот заполняем: основной или второй аккаунт. */
const SECOND = process.argv.slice(2).includes('second');
const SLOT = SECOND ? 'TG_SESSION_2' : 'TG_SESSION';

async function ask(query: string, hidden = false): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  const answer = new Promise<string>((resolve) => {
    rl.question(query, (value) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(value.trim());
    });
  });

  if (hidden) {
    // Гасим эхо после того, как приглашение уже напечатано, — иначе
    // пароль от двухфакторки останется в скроллбеке терминала.
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () =>
      undefined;
  }

  return answer;
}

async function main(): Promise<void> {
  if (!Number.isFinite(API_ID) || API_ID <= 0 || API_HASH.length === 0) {
    throw new Error('Заполни TG_API_ID и TG_API_HASH в .env (my.telegram.org)');
  }

  if (SECOND) {
    console.log('Вход во ВТОРОЙ аккаунт. Нужен другой номер, не тот, что в TG_SESSION.\n');
  }

  const phone = (SECOND ? '' : PHONE) || (await ask('Телефон в формате +79991234567: '));
  if (!phone.startsWith('+')) {
    throw new Error('Телефон нужен в международном формате, с плюсом');
  }

  const client = new TelegramClient(new StringSession(''), API_ID, API_HASH, {
    connectionRetries: 5,
  });

  console.log('Подключаюсь...');

  await client.start({
    phoneNumber: async () => phone,
    phoneCode: async () => ask('Код из Telegram: '),
    password: async () => ask('Облачный пароль (2FA), если включён: ', true),
    onError: (err) => {
      console.error('Ошибка авторизации:', err.message ?? err);
    },
  });

  const me = await client.getMe();
  const who = me.username ? `@${me.username}` : `id${me.id.toString()}`;

  console.log(`\nВошли как ${who}`);
  console.log(`\nПоложи это в .env как ${SLOT} (одной строкой):\n`);
  console.log(client.session.save());
  console.log('\nИ никому её не показывай.\n');

  if (SECOND) {
    console.log(
      'Проверь, что это НЕ тот же аккаунт, что в TG_SESSION: приложение\n' +
        'откажется стартовать, если оба ключа ведут в одну личку.\n',
    );
  }

  await client.destroy();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Не получилось:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
