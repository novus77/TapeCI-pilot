#!/usr/bin/env bash
# TapeCI backup/restore drill for Postgres + local object store.
#
#   scripts/ops/backup-restore.sh backup  --database-url "$DATABASE_URL" --out /backups
#   scripts/ops/backup-restore.sh verify  --database-url "$DATABASE_URL" --dump /backups/tapeci-...dump
#   scripts/ops/backup-restore.sh restore --database-url "$DATABASE_URL" --dump ... --yes
#
# S3/R2 objects are NOT downloaded here; use bucket versioning/replication or
# `aws s3 sync`/`rclone` in the operator runbook. The local object store is tarred.
set -euo pipefail

usage() {
  sed -n '2,12p' "$0"
  exit "${1:-0}"
}

command="${1:-}"
[ -z "$command" ] && usage 1
shift || true

database_url="${DATABASE_URL:-}"
dump=""
out="./backups"
object_dir="${TAPECI_OBJECT_STORE_DIR:-}"
confirmed=0

while [ $# -gt 0 ]; do
  case "$1" in
    --database-url) database_url="${2:-}"; shift 2 ;;
    --dump) dump="${2:-}"; shift 2 ;;
    --out) out="${2:-}"; shift 2 ;;
    --object-dir) object_dir="${2:-}"; shift 2 ;;
    --yes) confirmed=1; shift ;;
    -h|--help) usage 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

case "$command" in
  backup)
    [ -n "$database_url" ] || { echo "--database-url or DATABASE_URL is required" >&2; exit 2; }
    mkdir -p "$out"
    ts="$(date -u +%Y%m%dT%H%M%SZ)"
    file="$out/tapeci-$ts.dump"
    pg_dump --format=custom --no-owner --no-privileges --file "$file" "$database_url"
    echo "postgres dump: $file ($(du -h "$file" | cut -f1))"
    if [ -n "$object_dir" ] && [ -d "$object_dir" ]; then
      tar -czf "$out/tapeci-objects-$ts.tar.gz" -C "$object_dir" .
      echo "object store: $out/tapeci-objects-$ts.tar.gz"
    else
      echo "object store: skipped (set --object-dir or TAPECI_OBJECT_STORE_DIR)"
    fi
    ;;
  verify)
    [ -n "$database_url" ] || { echo "--database-url is required" >&2; exit 2; }
    [ -n "$dump" ] || { echo "--dump is required" >&2; exit 2; }
    admin="${database_url%/*}/postgres"
    temp="tapeci_restore_$(date -u +%s)"
    psql "$admin" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$temp\""
    trap 'psql "$admin" -c "DROP DATABASE IF EXISTS \"$temp\" WITH (FORCE)" >/dev/null 2>&1 || true' EXIT
    pg_restore --no-owner --no-privileges --dbname "${database_url%/*}/$temp" "$dump"
    psql "${database_url%/*}/$temp" -v ON_ERROR_STOP=1 -c \
      "select (select count(*) from users) users, (select count(*) from projects) projects, (select count(*) from deployments) deployments, (select count(*) from audit_events) audit_events"
    echo "restore verify: OK"
    ;;
  restore)
    [ -n "$database_url" ] || { echo "--database-url is required" >&2; exit 2; }
    [ -n "$dump" ] || { echo "--dump is required" >&2; exit 2; }
    [ "$confirmed" = "1" ] || { echo "refusing to overwrite a database without --yes" >&2; exit 2; }
    pg_restore --clean --if-exists --no-owner --no-privileges --dbname "$database_url" "$dump"
    echo "restore: OK"
    ;;
  *) usage 1 ;;
esac
