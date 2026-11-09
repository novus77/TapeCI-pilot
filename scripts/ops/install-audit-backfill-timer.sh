#!/usr/bin/env bash
# Install/uninstall the hourly audit-backfill systemd timer.
#   sudo scripts/ops/install-audit-backfill-timer.sh
#   sudo scripts/ops/install-audit-backfill-timer.sh --uninstall
# The service expects /opt/tapeci and /etc/tapeci/tapeci.env (see P2_OPERATIONS.md).
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
if [ "${EUID:-$(id -u)}" -ne 0 ]; then
  echo "run as root (or inspect the commands below)" >&2
  echo "install -m 644 $root/ops/systemd/tapeci-audit-backfill.service /etc/systemd/system/" >&2
  echo "install -m 644 $root/ops/systemd/tapeci-audit-backfill.timer /etc/systemd/system/" >&2
  echo "install -d -o tapeci -g tapeci /var/lib/tapeout/textfile" >&2
  echo "systemctl daemon-reload && systemctl enable --now tapeci-audit-backfill.timer" >&2
  exit 2
fi
if [ "${1:-}" = "--uninstall" ]; then
  systemctl disable --now tapeci-audit-backfill.timer || true
  rm -f /etc/systemd/system/tapeci-audit-backfill.service /etc/systemd/system/tapeci-audit-backfill.timer
  systemctl daemon-reload
  echo "uninstalled"
  exit 0
fi
install -m 644 "$root/ops/systemd/tapeci-audit-backfill.service" /etc/systemd/system/
install -m 644 "$root/ops/systemd/tapeci-audit-backfill.timer" /etc/systemd/system/
install -d -o tapeci -g tapeci /var/lib/tapeout/textfile
systemctl daemon-reload
systemctl enable --now tapeci-audit-backfill.timer
systemctl list-timers --no-pager tapeci-audit-backfill.timer
