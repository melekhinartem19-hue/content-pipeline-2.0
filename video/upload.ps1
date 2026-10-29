# Заливка смонтированного ролика с ноута клиента в очередь согласования на VPS (T15) — Windows.
# То же, что upload.sh: scp кладёт файл, ssh регистрирует его в очереди. В Windows 10/11 ssh и scp
# уже встроены (OpenSSH), ставить ничего не нужно.
#
# Использование:
#   ./video/upload.ps1 out/reels.mp4 -CaptionFile caption.txt -Title "Тема" -Job 12
#   ./video/upload.ps1 out/reels.mp4 -Caption "Короткая подпись"

param(
  [Parameter(Mandatory = $true, Position = 0)][string]$Video,
  [string]$Caption,
  [string]$CaptionFile,
  [string]$Title,
  [string]$Slot,
  [string]$Job,
  [switch]$Keep
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$envFile = Join-Path $here 'vps.env'

if (-not (Test-Path $envFile)) { throw "нет $envFile — скопируй vps.env.example и заполни (адрес VPS и пользователь)" }
if (-not (Test-Path $Video)) { throw "нет файла: $Video" }

# vps.env — простые пары КЛЮЧ=значение, читаем без внешних модулей.
$cfg = @{}
foreach ($line in Get-Content $envFile) {
  if ($line -match '^\s*([A-Z_]+)\s*=\s*(.*)$') { $cfg[$Matches[1]] = $Matches[2].Trim() }
}
$port = if ($cfg.VPS_PORT) { $cfg.VPS_PORT } else { '22' }
$tmp = if ($cfg.VPS_TMP) { $cfg.VPS_TMP } else { '/tmp' }
$target = "$($cfg.VPS_USER)@$($cfg.VPS_HOST)"

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$ext = [System.IO.Path]::GetExtension($Video).TrimStart('.')
$remoteVideo = "$tmp/reels-$stamp.$ext"

Write-Host "→ заливаю $(Split-Path -Leaf $Video) на $($cfg.VPS_HOST) …"
& scp -P $port $Video "${target}:$remoteVideo"
if ($LASTEXITCODE -ne 0) { throw 'scp не смог положить файл на VPS' }

$remoteArgs = @('--file', $remoteVideo)

# Подпись едет файлом: переводы строк и эмодзи через аргумент командной строки доезжают искажёнными.
if ($CaptionFile) {
  $remoteCaption = "$tmp/caption-$stamp.txt"
  & scp -P $port $CaptionFile "${target}:$remoteCaption"
  if ($LASTEXITCODE -ne 0) { throw 'scp не смог положить подпись на VPS' }
  $remoteArgs += @('--caption-file', $remoteCaption)
}
if ($Caption) { $remoteArgs += @('--caption', $Caption) }
if ($Title) { $remoteArgs += @('--title', $Title) }
if ($Slot) { $remoteArgs += @('--slot', $Slot) }
if ($Job) { $remoteArgs += @('--job', $Job) }
if ($Keep) { $remoteArgs += '--keep' }

# Аргументы уходят в одинарных кавычках: пробелы в теме и подписи не должны разъезжаться на той стороне.
$quoted = ($remoteArgs | ForEach-Object { "'" + ($_ -replace "'", "'\''") + "'" }) -join ' '

Write-Host '→ регистрирую ролик в очереди согласования …'
& ssh -p $port $target "cd '$($cfg.VPS_DISPATCHER_DIR)' && npm run --silent ingest:video -- $quoted"
if ($LASTEXITCODE -ne 0) { throw 'VPS не принял ролик — причина выше' }

Write-Host '✓ готово: карточка ждёт решения в топике Издателя'
