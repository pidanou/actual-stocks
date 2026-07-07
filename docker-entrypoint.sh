#!/bin/sh
set -eu

CRON_SCHEDULE="${CRON_SCHEDULE:-0 18 * * *}"

# crond runs jobs with a clean environment, so persist the current one
# (ACTUAL_* credentials, ticker map path, timezone) for the job to source.
printenv | grep -e '^ACTUAL_' -e '^TICKER_MAP_PATH=' -e '^TZ=' \
  | sed 's/^\([^=]*\)=\(.*\)$/\1="\2"/' > /app/.env.cron

echo "$CRON_SCHEDULE cd /app && . /app/.env.cron && node src/index.js >> /proc/1/fd/1 2>> /proc/1/fd/2" \
  > /etc/crontabs/root

echo "Scheduled update-prices job: $CRON_SCHEDULE"

if [ "${RUN_ON_START:-false}" = "true" ]; then
  echo "RUN_ON_START=true, running once now..."
  node src/index.js || true
fi

exec crond -f -d 8
