#!/usr/bin/env bash
# Заливка смонтированного ролика с ноута клиента в очередь согласования на VPS (T15).
#
# Почему так, а не через Telegram: Bot API качает файлы только до 20 МБ. Почему не через вебхук:
# диспетчер не открывает наружу ни одного порта — доставка идёт по SSH тем же ключом, которым
# клиент и так заходит на сервер.
#
# Использование:
#   ./video/upload.sh out/reels.mp4 --caption-file caption.txt --title "Тема" --job 12
#   ./video/upload.sh out/reels.mp4 --caption "Короткая подпись"
#   ./video/upload.sh out/reels.mp4 --slot "2026-09-10 10:00"    # отложить до слота календаря

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
VPS_TMP="${VPS_TMP:-/tmp}"

video="${1:-}"
if [ -z "$video" ] || [ ! -f "$video" ]; then
  echo "укажи файл ролика: ./video/upload.sh <файл.mp4> [--caption-file <файл>] [--title <тема>] [--slot <когда>] [--job <N>]" >&2
  exit 1
fi
shift

caption_file=""
remote_args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --caption-file)
      caption_file="$2"; shift 2 ;;
    --caption|--title|--slot|--job)
      remote_args+=("$1" "$2"); shift 2 ;;
    --keep)
      remote_args+=("$1"); shift ;;
    *)
      echo "неизвестный аргумент: $1" >&2; exit 1 ;;
  esac
done

stamp="$(date +%Y%m%d-%H%M%S)"
remote_video="$VPS_TMP/reels-$stamp.${video##*.}"
ssh_target="$VPS_USER@$VPS_HOST"

echo "→ заливаю $(basename "$video") на $VPS_HOST …"
scp -P "$VPS_PORT" "$video" "$ssh_target:$remote_video"
remote_args+=(--file "$remote_video")

# Подпись едет отдельным файлом: в ней бывают переводы строк, эмодзи и кавычки — через аргумент
# командной строки такое доезжает искажённым.
if [ -n "$caption_file" ]; then
  remote_caption="$VPS_TMP/caption-$stamp.txt"
  scp -P "$VPS_PORT" "$caption_file" "$ssh_target:$remote_caption"
  remote_args+=(--caption-file "$remote_caption")
fi

# Аргументы уезжают в одинарных кавычках: пробелы в теме и подписи не должны разъезжаться.
quoted=""
for a in "${remote_args[@]}"; do
  quoted+=" '${a//\'/\'\\\'\'}'"
done

echo "→ регистрирую ролик в очереди согласования …"
# shellcheck disable=SC2029
ssh -p "$VPS_PORT" "$ssh_target" "cd '$VPS_DISPATCHER_DIR' && npm run --silent ingest:video --$quoted"

echo "✓ готово: карточка ждёт решения в топике Издателя"
