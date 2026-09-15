#!/bin/sh
# Разовая пачка холодного аутрича.
#
#   yarn send              — предпросмотр: кому уйдёт, ничего не отправляется
#   yarn send 5            — предпросмотр первых пяти
#   yarn send:go           — отправить, спросит подтверждение
#   yarn send:go 5 --yes   — отправить пять без вопроса
#   yarn send:go 40 --both — слать сразу обоими аккаунтами, каждым по своей
#                            очереди и в своём темпе
#
# Почему спрашиваем подтверждение, хотя больше нигде не спрашиваем: рассылка
# незнакомым людям — единственное действие в инструменте, которое нельзя
# отменить и последствия которого несёт аккаунт. Получатели жалуются
# модераторам, и аккаунт зажимают. См. docs/postmortem-spam-ban.md

GO=""
YES=""
BOTH=""
LIMIT=""

for arg in "$@"; do
  case "$arg" in
    --go) GO="yes" ;;
    --yes) YES="yes" ;;
    --both) BOTH="yes" ;;
    *) LIMIT="$arg" ;;
  esac
done

# Лимит уходит в тело JSON, поэтому пускаем только цифры: подставить туда
# произвольную строку значило бы дать собрать чужой запрос.
if [ -n "$LIMIT" ]; then
  case "$LIMIT" in
    '' | *[!0-9]*)
      echo "Лимит должен быть числом: yarn send 5"
      exit 1
      ;;
  esac
fi

if [ -n "$GO" ] && [ -z "$YES" ]; then
  if [ ! -t 0 ]; then
    echo "Нет терминала для подтверждения. Если точно уверен: yarn send:go ${LIMIT:-} --yes"
    exit 1
  fi
  echo "Рассылка живым людям, отменить нельзя."
  printf "Введите send для подтверждения: "
  read -r ANSWER
  if [ "$ANSWER" != "send" ]; then
    echo "Отменено, ничего не отправлено."
    exit 1
  fi
fi

if [ -n "$GO" ]; then
  SEND_FIELD='"send":true'
else
  SEND_FIELD='"send":false'
fi

if [ -n "$BOTH" ]; then
  PARALLEL_FIELD=',"parallel":true'
else
  PARALLEL_FIELD=""
fi

if [ -n "$LIMIT" ]; then
  BODY="{\"limit\":$LIMIT,$SEND_FIELD$PARALLEL_FIELD}"
else
  BODY="{$SEND_FIELD$PARALLEL_FIELD}"
fi

HOST="${LEADGEN_HOST:-http://127.0.0.1:3010}"

# Ждём до часа: при человеческой паузе (SEND_DELAY_SEC=60 и выше) пачка из
# сорока сообщений идёт дольше получаса, а оборванный по таймауту curl
# отнимает отчёт — рассылка при этом продолжается на сервере.
curl -sS --max-time 3600 -XPOST "$HOST/send/run" \
  -H 'content-type: application/json' \
  -d "$BODY"
