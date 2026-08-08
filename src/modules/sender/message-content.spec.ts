import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMessageContent } from '@modules/sender/message-content';

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), 'leadgen-content-'));
}

describe('loadMessageContent', () => {
  it('читает текст и картинки, порядок альбома — по имени файла', () => {
    const dir = makeDir();
    writeFileSync(join(dir, 'text.md'), '  Привет!  \n');
    mkdirSync(join(dir, 'images'));
    ['02-b.png', '01-a.jpg', 'readme.txt'].forEach((name) =>
      writeFileSync(join(dir, 'images', name), 'x'),
    );

    const content = loadMessageContent(dir);

    expect(content.text).toBe('Привет!');
    expect(content.images.map((p) => p.split('/').pop())).toEqual([
      '01-a.jpg',
      '02-b.png',
    ]);
    expect(content.captionFits).toBe(true);
  });

  it('работает без папки images — тогда рассылка текстовая', () => {
    const dir = makeDir();
    writeFileSync(join(dir, 'text.md'), 'Только текст');

    expect(loadMessageContent(dir).images).toEqual([]);
  });

  it('отмечает, что длинный текст не влезет в подпись к альбому', () => {
    const dir = makeDir();
    writeFileSync(join(dir, 'text.md'), 'я'.repeat(1500));

    expect(loadMessageContent(dir).captionFits).toBe(false);
  });

  it('падает на пустом тексте, а не отправляет пустоту', () => {
    const dir = makeDir();
    writeFileSync(join(dir, 'text.md'), '   \n  ');

    expect(() => loadMessageContent(dir)).toThrow(/пуст/);
  });

  it('падает, если text.md вообще нет', () => {
    expect(() => loadMessageContent(makeDir())).toThrow();
  });
});
