#!/bin/sh
# Пометить лидов по никам. Используется через yarn:
#
#   yarn wrote @nick1 @nick2      — написал, больше не показывать
#   yarn skip  @nick1 @nick2      — не подошёл, убрать навсегда
#
# Отметка живёт в НАШЕЙ базе, а не в Telegram. Это принципиально: человек
# может удалить диалог «у обоих», и тогда на твоей стороне не остаётся
# никаких следов переписки — сверка с личкой такого не поймает, и лид
# вернётся в список как новый.

STATUS="$1"
shift

if [ $# -eq 0 ]; then
  echo "Укажи хотя бы один ник: yarn wrote @nick"
  exit 1
fi

NAMES=$(echo "$@" | tr ' ' ',')
HOST="${LEADGEN_HOST:-http://127.0.0.1:3010}"

curl -sS -XPOST "$HOST/outreach/mark?status=$STATUS&usernames=$NAMES"
