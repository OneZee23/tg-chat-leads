#!/bin/sh
# Поиск по чатам из RESEARCH_CHATS. Только чтение, ничего не отправляет.
#
#   yarn research                       — запросы из .env
#   yarn research "Тбилиси" "6 месяцев" — свои запросы, через пробел
#
# Результат — markdown в research/. Прогресс: yarn research:status
set -e

HOST="${LEADGEN_HOST:-http://127.0.0.1:3010}"

if [ "$#" -eq 0 ]; then
  BODY='{}'
else
  QUERIES=$(printf '%s\n' "$@" | python3 -c 'import json,sys; print(json.dumps([l.rstrip("\n") for l in sys.stdin]))')
  BODY="{\"queries\": $QUERIES}"
fi

echo "→ запускаю поиск: $BODY"
curl -sS -XPOST "$HOST/research/run" -H 'Content-Type: application/json' -d "$BODY"
echo
echo "→ статус: yarn research:status (файл появится в research/ по завершении)"
