import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  UnsafeFileNameError,
  assertSafeName,
  inboxFileName,
  newestOutboxName,
  parseDumpTimestamp,
  readInbox,
  readOutbox,
  writeInbox,
} from '@modules/outreach/reply-files';

describe('assertSafeName', () => {
  it('пропускает обычное имя выгрузки', () => {
    expect(() => assertSafeName('2026-09-03-1430.md')).not.toThrow();
  });

  it('режет выход из папки', () => {
    // Ручка висит на localhost, но читать по её просьбе произвольный файл
    // с диска всё равно нечего.
    for (const bad of ['../.env', '../../.env', 'a/b.md', '/etc/passwd', '..', 'a..b']) {
      expect(() => assertSafeName(bad)).toThrow(UnsafeFileNameError);
    }
  });

  it('режет пустое и слишком длинное имя', () => {
    expect(() => assertSafeName('')).toThrow(UnsafeFileNameError);
    expect(() => assertSafeName(`${'a'.repeat(80)}.md`)).toThrow(UnsafeFileNameError);
  });
});

describe('inboxFileName', () => {
  it('стамп до минуты — по нему видно пару inbox/outbox', () => {
    expect(inboxFileName(new Date(2026, 8, 3, 14, 30))).toBe('2026-09-03-1430.md');
  });

  it('однозначные месяц, день, час и минута дополняются нулём', () => {
    expect(inboxFileName(new Date(2026, 0, 5, 7, 9))).toBe('2026-01-05-0709.md');
  });
});

describe('parseDumpTimestamp', () => {
  it('достаёт момент выгрузки из имени файла', () => {
    const at = parseDumpTimestamp('2026-09-03-1430.md');
    expect(at).toBe(Math.floor(new Date(2026, 8, 3, 14, 30).getTime() / 1000));
  });

  it('имя переименовали руками — null, проверку свежести делать не по чему', () => {
    expect(parseDumpTimestamp('ответы-на-вторник.md')).toBeNull();
  });

  it('невалидный месяц (13) — null, дата не прошла проверку диапазонов', () => {
    expect(parseDumpTimestamp('2026-13-03-1430.md')).toBeNull();
  });

  it('невалидный месяц (0) — null, дата не прошла проверку диапазонов', () => {
    expect(parseDumpTimestamp('2026-00-00-0000.md')).toBeNull();
  });

  it('невалидный день (32) — null, дата не прошла проверку диапазонов', () => {
    expect(parseDumpTimestamp('2026-09-32-1430.md')).toBeNull();
  });

  it('невалидный час (25) — null, дата не прошла проверку диапазонов', () => {
    expect(parseDumpTimestamp('2026-09-03-2530.md')).toBeNull();
  });

  it('невалидная минута (60) — null, дата не прошла проверку диапазонов', () => {
    expect(parseDumpTimestamp('2026-09-03-1460.md')).toBeNull();
  });
});

describe('writeInbox / readOutbox / newestOutboxName', () => {
  function sandbox(): string {
    return mkdtempSync(join(tmpdir(), 'leadgen-'));
  }

  it('записывает выгрузку и возвращает путь', () => {
    const base = sandbox();
    const path = writeInbox('2026-09-03-1430.md', 'привет', base);
    expect(readFileSync(path, 'utf8')).toBe('привет');
  });

  it('читает выгрузку, чтобы сверить, кому ответ не написали', () => {
    const base = sandbox();
    writeInbox('2026-09-03-1430.md', 'выгрузка', base);
    expect(readInbox('2026-09-03-1430.md', base)).toBe('выгрузка');
  });

  it('выгрузки на диске нет — null, а не падение: сверять просто нечем', () => {
    expect(readInbox('2026-09-03-1430.md', sandbox())).toBeNull();
  });

  it('читает outbox по basename', () => {
    const base = sandbox();
    mkdirSync(join(base, 'outbox'));
    writeFileSync(join(base, 'outbox', '2026-09-03-1430.md'), 'тело', 'utf8');
    expect(readOutbox('2026-09-03-1430.md', base)).toBe('тело');
  });

  it('внятная ошибка, если файла нет', () => {
    const base = sandbox();
    expect(() => readOutbox('нет.md', base)).toThrow(UnsafeFileNameError);
  });

  it('самый свежий файл в outbox — по имени, оно же стамп', () => {
    const base = sandbox();
    mkdirSync(join(base, 'outbox'));
    for (const name of ['2026-09-01-1000.md', '2026-09-03-1430.md', '2026-09-02-0900.md']) {
      writeFileSync(join(base, 'outbox', name), 'x', 'utf8');
    }
    expect(newestOutboxName(base)).toBe('2026-09-03-1430.md');
  });

  it('папки outbox нет — null, а не падение', () => {
    expect(newestOutboxName(sandbox())).toBeNull();
  });

  it('игнорирует файл без стампа в имени, возвращает свежий стамп', () => {
    const base = sandbox();
    mkdirSync(join(base, 'outbox'));
    // Кириллическое имя сортируется после всех дат по коду символов
    for (const name of ['2026-09-01-1000.md', '2026-09-03-1430.md', 'ответы-на-вторник.md']) {
      writeFileSync(join(base, 'outbox', name), 'x', 'utf8');
    }
    expect(newestOutboxName(base)).toBe('2026-09-03-1430.md');
  });

  it('возвращает null, когда в папке только файлы без стампов', () => {
    const base = sandbox();
    mkdirSync(join(base, 'outbox'));
    for (const name of ['ответы-на-вторник.md', 'кое-что.md']) {
      writeFileSync(join(base, 'outbox', name), 'x', 'utf8');
    }
    expect(newestOutboxName(base)).toBeNull();
  });
});
