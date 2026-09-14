#!/bin/sh
# Поиск ЛЮДЕЙ в чатах из RESEARCH_CHATS: кто нанимает, реферит, работает внутри.
# Только чтение, ничего не отправляет.
#
#   yarn leads:tg                       — фразы и порог из .env
#   yarn leads:tg "зарефералю" "ищем"   — свои фразы
#   LEADS_MIN_SCORE=8 yarn leads:tg     — разово переопределить порог
#
# Порог по умолчанию берётся из LEADS_MIN_SCORE в .env приложения.
# Здесь он НЕ подставляется, иначе перебивал бы конфиг нулём.
set -e

HOST="${LEADGEN_HOST:-http://127.0.0.1:3010}"

FIELDS=""
[ -n "$LEADS_MIN_SCORE" ] && FIELDS="\"minScore\": $LEADS_MIN_SCORE"

if [ "$#" -gt 0 ]; then
  QUERIES=$(printf '%s\n' "$@" | python3 -c 'import json,sys; print(json.dumps([l.rstrip("\n") for l in sys.stdin]))')
  [ -n "$FIELDS" ] && FIELDS="$FIELDS, "
  FIELDS="$FIELDS\"queries\": $QUERIES"
fi

BODY="{$FIELDS}"

echo "→ ищу людей: $BODY"
curl -sS -XPOST "$HOST/research/leads" -H 'Content-Type: application/json' -d "$BODY"
echo
echo "→ статус: yarn leads:tg:status (файл появится в research/)"
