import { sliceUnanswered } from '@modules/dialogs/unanswered';

/** Хелпер: GramJS отдаёт историю от НОВЫХ к старым — так и передаём. */
function msg(out: boolean, date: number, message: string) {
  return { out, date, message };
}

describe('sliceUnanswered', () => {
  it('курсор — последнее НАШЕ исходящее, а не первое письмо', () => {
    // Мы написали (100), он ответил (200), мы ответили (300), он спросил ещё (400).
    const history = [
      msg(false, 400, 'а как завести учеников?'),
      msg(true, 300, 'рад что заинтересовало'),
      msg(false, 200, 'выглядит интересно'),
      msg(true, 100, 'здравствуйте!'),
    ];

    const slice = sliceUnanswered(history, 100);

    expect(slice.cursorSec).toBe(300);
    expect(slice.incoming.map((m) => m.message)).toEqual(['а как завести учеников?']);
  });

  it('мы ответили последними — отвечать нечего', () => {
    const history = [
      msg(true, 300, 'ответ'),
      msg(false, 200, 'вопрос'),
      msg(true, 100, 'письмо'),
    ];
    expect(sliceUnanswered(history, 100).incoming).toEqual([]);
  });

  it('нашего исходящего в окне нет — курсор падает на дату письма', () => {
    // Человек написал больше, чем мы читаем: наше письмо уже за границей окна.
    const history = [
      msg(false, 400, 'третье'),
      msg(false, 300, 'второе'),
      msg(false, 200, 'первое'),
    ];

    const slice = sliceUnanswered(history, 150);

    expect(slice.cursorSec).toBe(150);
    expect(slice.incoming.map((m) => m.message)).toEqual(['первое', 'второе', 'третье']);
  });

  it('история отдаётся от старых к новым — это контекст для ответа', () => {
    const history = [msg(false, 200, 'новое'), msg(true, 100, 'старое')];
    expect(sliceUnanswered(history, 100).history.map((m) => m.message)).toEqual([
      'старое',
      'новое',
    ]);
  });

  it('пустые и служебные сообщения не считаются ответом', () => {
    // Стикер/фото приходят с пустым message. Отвечать на них шаблоном не на что,
    // и попадание такого диалога в выгрузку — просто шум.
    const history = [msg(false, 200, '   '), msg(true, 100, 'письмо')];
    expect(sliceUnanswered(history, 100).incoming).toEqual([]);
  });

  it('несколько входящих подряд отдаются все — человек дописывал мысль', () => {
    const history = [
      msg(false, 320, 'и ещё сколько стоит?'),
      msg(false, 310, 'а расписание есть?'),
      msg(true, 300, 'наш ответ'),
    ];
    expect(sliceUnanswered(history, 100).incoming.map((m) => m.message)).toEqual([
      'а расписание есть?',
      'и ещё сколько стоит?',
    ]);
  });

  it('отметка закрытия двигает курсор вперёд, как наше сообщение', () => {
    // CLOSE ничего не отправляет, поэтому сообщение человека остаётся
    // последним, и без этой границы он возвращался в КАЖДУЮ выгрузку.
    const history = [msg(false, 200, 'спасибо!'), msg(true, 100, 'наше письмо')];

    // Закрыли в 300 — после его «спасибо».
    expect(sliceUnanswered(history, 300).incoming).toEqual([]);
    // Без закрытия он бы вернулся.
    expect(sliceUnanswered(history, 100).incoming).toHaveLength(1);
  });

  it('но написал ПОСЛЕ закрытия — снова ждёт ответа', () => {
    // Закрытие гасит прошлое, а не человека: тёплый лид, вернувшийся с
    // вопросом, обязан всплыть.
    const history = [msg(false, 400, 'а как завести учеников?'), msg(true, 100, 'наше письмо')];
    expect(sliceUnanswered(history, 300).incoming.map((m) => m.message)).toEqual([
      'а как завести учеников?',
    ]);
  });

  it('наше исходящее позже закрытия — курсор берёт максимум', () => {
    // Закрыли в 200, потом всё-таки написали руками в 300. Курсор — 300.
    const history = [
      msg(false, 350, 'новое сообщение'),
      msg(true, 300, 'ответ руками'),
      msg(false, 150, 'старое'),
      msg(true, 100, 'письмо'),
    ];
    const slice = sliceUnanswered(history, 200);
    expect(slice.cursorSec).toBe(300);
    expect(slice.incoming.map((m) => m.message)).toEqual(['новое сообщение']);
  });

  it('пустая история — пустой результат, без падения', () => {
    const slice = sliceUnanswered([], 100);
    expect(slice.cursorSec).toBe(100);
    expect(slice.incoming).toEqual([]);
    expect(slice.history).toEqual([]);
  });
});
