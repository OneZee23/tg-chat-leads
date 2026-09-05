#!/bin/sh
# Выгрузка одобренных отзывов в статику лендинга.
#
#   yarn reviews                       — собрать отзывы в reviews/<стамп>.md
#   yarn reviews:build 2026-09-05-1442.md  — выгрузить помеченные PUBLISH
#
# Публикуются только записи из секции «Разрешение есть». PUBLISH под записью
# без разрешения не выполняется: это чужие персональные данные.

FILE="$1"

if [ -z "$FILE" ]; then
  echo ""
  echo "Нужно имя файла: yarn reviews:build 2026-09-05-1442.md"
  echo "Список: ls reviews/"
  echo ""
  exit 1
fi

HOST="${LEADGEN_HOST:-http://127.0.0.1:3010}"

# Имя файла кодируем, а не склеиваем в URL — как в outbox.sh.
curl -sS --max-time 900 -X POST -G --data-urlencode "file=$FILE" "$HOST/outreach/reviews/build"
