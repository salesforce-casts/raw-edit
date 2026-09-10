#!/usr/bin/env bash
#
# Start the local backing services RawEdit needs for development and for the
# end-to-end tests: Postgres, Redis and an S3-compatible endpoint (MinIO).
#
# Prefers `docker compose` when a Docker daemon is available, because that is what
# most developers will use. Falls back to native binaries otherwise, which is what
# makes the end-to-end suite runnable in a container that has no nested Docker.
#
#   ./scripts/dev-services.sh start     # bring everything up and migrate
#   ./scripts/dev-services.sh stop
#   ./scripts/dev-services.sh status
#
# Then:  source .env.test && npm test
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${RAWEDIT_STATE_DIR:-${TMPDIR:-/tmp}/rawedit-dev}"
MINIO_DATA="$STATE_DIR/minio"
MINIO_BIN="$STATE_DIR/minio"
LOG_DIR="$STATE_DIR/logs"

PG_USER="${PG_USER:-rawedit}"
PG_PASSWORD="${PG_PASSWORD:-rawedit}"
PG_DB="${PG_DB:-rawedit}"
BUCKET="${R2_BUCKET:-rawedit-dev}"
MINIO_USER="${MINIO_ROOT_USER:-rawedit}"
MINIO_PASSWORD="${MINIO_ROOT_PASSWORD:-rawedit123}"

have() { command -v "$1" >/dev/null 2>&1; }
docker_up() { have docker && docker info >/dev/null 2>&1; }

log() { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!!\033[0m %s\n' "$*" >&2; }

# ---------------------------------------------------------------- Postgres --
start_postgres() {
  if pg_isready -h localhost -p 5432 >/dev/null 2>&1; then
    log "Postgres already running"
  else
    log "Starting Postgres"
    if have pg_ctlcluster; then
      # Debian/Ubuntu packaging.
      pg_ctlcluster "$(ls /etc/postgresql | head -1)" main start 2>/dev/null || true
    elif have brew; then
      brew services start postgresql@16 2>/dev/null || true
    else
      service postgresql start 2>/dev/null || true
    fi
    for _ in $(seq 1 30); do
      pg_isready -h localhost -p 5432 >/dev/null 2>&1 && break
      sleep 1
    done
  fi

  # Idempotent role and database creation.
  local as_postgres="psql -v ON_ERROR_STOP=0 -q -c"
  if have su && id postgres >/dev/null 2>&1; then
    su postgres -c "$as_postgres \"CREATE USER $PG_USER WITH PASSWORD '$PG_PASSWORD' SUPERUSER;\"" >/dev/null 2>&1 || true
    su postgres -c "$as_postgres 'CREATE DATABASE $PG_DB OWNER $PG_USER;'" >/dev/null 2>&1 || true
  else
    psql -h localhost -U "${USER:-postgres}" -d postgres -c \
      "CREATE USER $PG_USER WITH PASSWORD '$PG_PASSWORD' SUPERUSER;" >/dev/null 2>&1 || true
    psql -h localhost -U "${USER:-postgres}" -d postgres -c \
      "CREATE DATABASE $PG_DB OWNER $PG_USER;" >/dev/null 2>&1 || true
  fi
  log "Postgres ready at postgres://$PG_USER@localhost:5432/$PG_DB"
}

# ------------------------------------------------------------------- Redis --
start_redis() {
  if redis-cli ping >/dev/null 2>&1; then
    log "Redis already running"
    return
  fi
  log "Starting Redis"
  redis-server --daemonize yes --port 6379 --save '' --appendonly no >/dev/null 2>&1
  for _ in $(seq 1 20); do
    redis-cli ping >/dev/null 2>&1 && break
    sleep 0.5
  done
  log "Redis ready at redis://localhost:6379"
}

# ------------------------------------------------------------------- MinIO --
start_minio() {
  if curl -fsS --max-time 2 http://127.0.0.1:9000/minio/health/live >/dev/null 2>&1; then
    log "MinIO already running"
  else
    mkdir -p "$MINIO_DATA" "$LOG_DIR"
    if [ ! -x "$MINIO_BIN" ]; then
      log "Downloading MinIO"
      local arch="amd64"
      [ "$(uname -m)" = "aarch64" ] || [ "$(uname -m)" = "arm64" ] && arch="arm64"
      local os="linux"
      [ "$(uname -s)" = "Darwin" ] && os="darwin"
      curl -fsSL -o "$MINIO_BIN" "https://dl.min.io/server/minio/release/${os}-${arch}/minio"
      chmod +x "$MINIO_BIN"
    fi
    log "Starting MinIO"
    MINIO_ROOT_USER="$MINIO_USER" MINIO_ROOT_PASSWORD="$MINIO_PASSWORD" \
      "$MINIO_BIN" server "$MINIO_DATA" --address :9000 --console-address :9001 \
      >"$LOG_DIR/minio.log" 2>&1 &
    for _ in $(seq 1 40); do
      curl -fsS --max-time 2 http://127.0.0.1:9000/minio/health/live >/dev/null 2>&1 && break
      sleep 0.5
    done
  fi

  log "Ensuring bucket '$BUCKET' exists"
  R2_BUCKET="$BUCKET" \
  R2_ENDPOINT="http://127.0.0.1:9000" \
  R2_ACCESS_KEY_ID="$MINIO_USER" \
  R2_SECRET_ACCESS_KEY="$MINIO_PASSWORD" \
    node "$ROOT/scripts/ensure-bucket.mjs"
}

# ------------------------------------------------------------------ Compose --
start_compose() {
  log "Docker detected; using docker compose"
  (cd "$ROOT" && docker compose up -d)
  log "Waiting for services"
  for _ in $(seq 1 60); do
    if pg_isready -h localhost -p 5432 >/dev/null 2>&1 \
      && redis-cli ping >/dev/null 2>&1 \
      && curl -fsS --max-time 2 http://127.0.0.1:9000/minio/health/live >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
}

migrate() {
  log "Running migrations"
  (cd "$ROOT" && DATABASE_URL="postgres://$PG_USER:$PG_PASSWORD@localhost:5432/$PG_DB" \
    npm run --silent db:migrate)
}

case "${1:-start}" in
  start)
    if docker_up; then
      start_compose
    else
      warn "No Docker daemon; starting native services instead"
      start_postgres
      start_redis
      start_minio
    fi
    migrate
    echo
    log "All services up. Next:"
    echo "    source .env.test && npm test"
    ;;
  stop)
    if docker_up; then
      (cd "$ROOT" && docker compose down)
    fi
    pkill -f "minio server" 2>/dev/null || true
    redis-cli shutdown nosave 2>/dev/null || true
    log "Stopped"
    ;;
  status)
    pg_isready -h localhost -p 5432 >/dev/null 2>&1 && echo "postgres  up" || echo "postgres  down"
    redis-cli ping >/dev/null 2>&1 && echo "redis     up" || echo "redis     down"
    curl -fsS --max-time 2 http://127.0.0.1:9000/minio/health/live >/dev/null 2>&1 \
      && echo "minio     up" || echo "minio     down"
    ;;
  *)
    echo "usage: $0 {start|stop|status}" >&2
    exit 1
    ;;
esac
