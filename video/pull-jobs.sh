#!/usr/bin/env bash
# Заявки на монтаж, ждущие ноутбука (T16, автомонтаж).
#
# Заявку создаёт сам диспетчер, когда владелец одобряет сценарий Reels от Сценариста. Ноут её
# ЗАБИРАЕТ (pull), а не получает: наружу VPS не открывает портов, поэтому инициатива всегда
# на стороне ноутбука.
#
# Использование:
#   ./video/pull-jobs.sh            # человекочитаемый список
#   ./video/pull-jobs.sh --json     # JSON — его читает локальный Claude Code

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
env_file="$here/vps.env"

if [ ! -f "$env_file" ]; then
  echo "нет $env_file — скопируй vps.env.example и заполни (адрес VPS и пользователь)" >&2
  exit 1
fi
# shellcheck disable=SC1090
set -a; . "$env_file"; set +a

VPS_PORT="${VPS_PORT:-22}"
args=""
[ "${1:-}" = "--json" ] && args=" '--json'"

# shellcheck disable=SC2029
ssh -p "$VPS_PORT" "$VPS_USER@$VPS_HOST" "cd '$VPS_DISPATCHER_DIR' && npm run --silent video:jobs --$args"
