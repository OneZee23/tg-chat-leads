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
    --send) SEND="&send=true" ;;
    *) FILE="&file=$arg" ;;
  esac
done

HOST="${LEADGEN_HOST:-http://127.0.0.1:3010}"

curl -sS --max-time 900 -XPOST "$HOST/outreach/outbox/send?limit=200$SEND$FILE"
