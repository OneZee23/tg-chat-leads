#!/bin/sh
# Обёртка над typeorm CLI — как в teach-track-backend.
#
#   yarn typeorm migration:run
#   yarn typeorm migration:revert
#   yarn typeorm mg SomeName      => migration:generate src/migrations/SomeName

COMMAND="$1"
SRC="$2"
all_args=$@

echo "command: $COMMAND"

if [ "$COMMAND" = "mg" ] && [ -z "$SRC" ]; then
  echo "No migration name given"
  exit 1
fi

if [ "$COMMAND" = "mg" ]; then
  SRC=src/migrations/$SRC
  echo "generate migration src: $SRC"
  all_args="migration:generate $SRC -p"
fi

node ./node_modules/ts-node/dist/bin.js \
  -r tsconfig-paths/register \
  -r dotenv/config \
  --project ./tsconfig.json \
  ./node_modules/typeorm/cli.js \
  -d typeorm-cli-datasource.ts $all_args
