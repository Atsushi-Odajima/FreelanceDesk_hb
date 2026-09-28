#!/usr/bin/env bash
# 開発用ローカルPostgreSQLを起動します（本番では使用しません）。
set -euo pipefail
PGBIN=${PGBIN:-/usr/lib/postgresql/16/bin}
DATA=${PGDATA_DIR:-$HOME/.freelance-desk-pg}
PORT=${PGPORT:-54329}
if [ ! -d "$DATA" ]; then
  mkdir -p "$DATA"
  chown postgres "$DATA" 2>/dev/null || true
  if [ "$(id -u)" = "0" ]; then
    su postgres -c "$PGBIN/initdb -D $DATA -U postgres --auth=trust -E UTF8 --locale=C.UTF-8" >/dev/null
  else
    "$PGBIN/initdb" -D "$DATA" -U postgres --auth=trust -E UTF8 --locale=C.UTF-8 >/dev/null
  fi
fi
if [ "$(id -u)" = "0" ]; then
  su postgres -c "$PGBIN/pg_ctl -D $DATA -o '-p $PORT -k /tmp' -l $DATA/log.txt start" || true
else
  "$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$DATA/log.txt" start || true
fi
sleep 2
psql -h 127.0.0.1 -p "$PORT" -U postgres -tc "SELECT 1 FROM pg_database WHERE datname='freelance_desk'" | grep -q 1 || psql -h 127.0.0.1 -p "$PORT" -U postgres -c "CREATE DATABASE freelance_desk"
psql -h 127.0.0.1 -p "$PORT" -U postgres -tc "SELECT 1 FROM pg_database WHERE datname='freelance_desk_test'" | grep -q 1 || psql -h 127.0.0.1 -p "$PORT" -U postgres -c "CREATE DATABASE freelance_desk_test"
echo "DATABASE_URL=postgres://postgres@127.0.0.1:$PORT/freelance_desk"
