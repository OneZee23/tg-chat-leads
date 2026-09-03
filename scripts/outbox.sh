#!/bin/sh
# Отправка ответов, подготовленных в outbox/.
#
#   yarn outbox                      — предпросмотр самого свежего файла
#   yarn outbox 2026-09-03-1430.md   — предпросмотр конкретного
#   yarn outbox:send                 — отправить самый свежий
#
# Предпросмотр тоже ходит в Telegram за историей каждого диалога: иначе он
# показывал бы не то, что сделает боевой прогон.

SEND=""
FILE=""

for arg in "$@"; do
  case "$arg" in
    --send) SEND="yes" ;;
    *) FILE="$arg" ;;
  esac
done

HOST="${LEADGEN_HOST:-http://127.0.0.1:3010}"

# Значения кодируем, а не склеиваем в строку URL: имя файла приходит
# снаружи, и склейка позволяла бы дописать к предпросмотру `&send=true` —
# то есть отправить по-настоящему там, где человек ждал показа.
set -- -sS --max-time 900 -X POST -G --data-urlencode "limit=200"
if [ -n "$SEND" ]; then
  set -- "$@" --data-urlencode "send=true"
fi
if [ -n "$FILE" ]; then
  set -- "$@" --data-urlencode "file=$FILE"
fi

curl "$@" "$HOST/outreach/outbox/send"
