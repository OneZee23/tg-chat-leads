import { parsePosts, pickAuthor, stripTags } from '@modules/lead/tme-posts';

/**
 * Фрагмент повторяет разметку t.me/s/<канал> как она есть: пост — блок
 * `tgme_widget_message`, текст внутри `tgme_widget_message_text`, контакт
 * автора — ссылкой на t.me, а внизу каждого поста канал подписывает сам
 * себя. Ники здесь выдуманные: в фикстурах живым людям не место.
 */
function page(...posts: string[]): string {
  return `<html><body><main>${posts.join('\n')}</main></body></html>`;
}

function post(id: number, inner: string, date = '2026-09-06T10:00:00+00:00'): string {
  return `<div class="tgme_widget_message text_not_supported_wrap js-widget_message" data-post="board/${id}">
    <div class="tgme_widget_message_text js-message_text" dir="auto">${inner}</div>
    <div class="tgme_widget_message_footer">
      <a class="tgme_widget_message_date" href="https://t.me/board/${id}">
        <time datetime="${date}">10:00</time>
      </a>
      <a href="https://t.me/board">@board</a>
    </div>
  </div>`;
}

describe('parsePosts', () => {
  it('достаёт текст, ник автора и дату', () => {
    const html = page(
      post(
        101,
        'Репетитор английского.<br/>Пишите: <a href="https://t.me/example_tutor">@example_tutor</a>',
      ),
    );

    expect(parsePosts(html, 'board')).toEqual([
      {
        id: 101,
        text: 'Репетитор английского.\nПишите: @example_tutor',
        username: 'example_tutor',
        date: '2026-09-06T10:00:00+00:00',
      },
    ]);
  });

  it('пропускает пост без контакта — писать некому', () => {
    const html = page(post(102, 'Репетитор математики, телефон +7 900 000-00-00'));
    expect(parsePosts(html, 'board')).toEqual([]);
  });

  it('не принимает канал за автора: он подписывает каждый пост', () => {
    const html = page(post(103, 'Объявление без ника, только подпись канала'));
    expect(parsePosts(html, 'board')).toHaveLength(0);
  });

  it('разбирает несколько постов подряд', () => {
    const html = page(
      post(104, 'Раз <a href="https://t.me/first_one">@first_one</a>'),
      post(105, 'Два <a href="https://t.me/second_one">@second_one</a>'),
    );
    expect(parsePosts(html, 'board').map((p) => p.username)).toEqual([
      'first_one',
      'second_one',
    ]);
  });
});

describe('pickAuthor', () => {
  it('бот не автор: ему писать бессмысленно', () => {
    // Живой случай: человек рекламирует своего бота, а сам подписан
    // ссылкой-автором. Нужен человек, а не бот.
    const body =
      '<a href="https://t.me/SomePlannerBot">@SomePlannerBot</a>' +
      '<a href="https://t.me/human_author">автор</a>';
    expect(pickAuthor(body, 'board')).toBe('human_author');
  });

  it('упоминание в тексте важнее ссылки-подписи', () => {
    const body =
      '<a href="https://t.me/link_only">канал</a>' +
      '<a href="https://t.me/mentioned">@mentioned</a>';
    expect(pickAuthor(body, 'board')).toBe('mentioned');
  });

  it('ссылка на сам канал автором не считается', () => {
    expect(pickAuthor('<a href="https://t.me/board">@board</a>', 'board')).toBeNull();
    expect(pickAuthor('<a href="https://t.me/BOARD">@BOARD</a>', 'board')).toBeNull();
  });
});

describe('stripTags', () => {
  it('переводы строк сохраняются, сущности разворачиваются', () => {
    expect(stripTags('<b>Цена</b> 1000&nbsp;&#8381;<br/>Пишите&amp;приходите')).toBe(
      'Цена 1000 ₽\nПишите&приходите',
    );
  });

  it('эмодзи из телеграмной разметки не теряются', () => {
    // Телеграм оборачивает эмодзи в <i class="emoji"><b>🇬🇧</b></i>.
    expect(stripTags('<i class="emoji"><b>🇬🇧</b></i> Английский')).toBe('🇬🇧 Английский');
  });
});
