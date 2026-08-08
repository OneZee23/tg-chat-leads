/**
 * Разовый вход в Telegram-аккаунт. Печатает строку сессии, которую надо
 * положить в TG_SESSION в .env.
 *
 *   yarn session:create
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

  const phone = PHONE || (await ask('Телефон в формате +79991234567: '));
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
  console.log('\nПоложи это в .env как TG_SESSION (одной строкой):\n');
  console.log(client.session.save());
  console.log('\nИ никому её не показывай.\n');

  await client.destroy();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Не получилось:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
