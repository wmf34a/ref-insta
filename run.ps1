# One-command setup + start for Windows. From this folder in cmd:  run
# First run installs what's missing (winget), fetches whisper.cpp + model into .\tools,
# asks for the Firecrawl API key once, then starts the server and opens the browser.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # Invoke-WebRequest is very slow with the progress bar on
Set-Location $PSScriptRoot
$tools = Join-Path $PSScriptRoot 'tools'
New-Item -ItemType Directory -Force $tools | Out-Null

function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}
function Need($cmd, $id) {
  if (Get-Command $cmd -ErrorAction SilentlyContinue) { return }
  Write-Host "Installing $id ..."
  winget install -e --id $id --silent --accept-source-agreements --accept-package-agreements
  Refresh-Path
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { throw "$cmd was not found after installing. Open a new terminal and run again." }
}
Need node OpenJS.NodeJS.LTS
Need yt-dlp yt-dlp.yt-dlp
Need ffmpeg Gyan.FFmpeg

# Optional: speech-to-text for videos without captions. Failure here only disables the script column.
try {
  $whisper = Get-ChildItem $tools -Recurse -Filter whisper-cli.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $whisper) {
    Write-Host 'Downloading whisper.cpp ...'
    $zip = Join-Path $tools 'whisper.zip'
    Invoke-WebRequest 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.2/whisper-bin-x64.zip' -OutFile $zip
    Expand-Archive $zip (Join-Path $tools 'whisper') -Force
    Remove-Item $zip
    $whisper = Get-ChildItem $tools -Recurse -Filter whisper-cli.exe | Select-Object -First 1
  }
  $model = Join-Path $tools 'ggml-small-q5_1.bin'
  if (-not (Test-Path $model)) {
    Write-Host 'Downloading Whisper model (190MB) ...'
    Invoke-WebRequest 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin' -OutFile "$model.part"
    Move-Item "$model.part" $model
  }
  $env:WHISPER_CLI = $whisper.FullName
  $env:WHISPER_MODEL = $model
} catch {
  Write-Warning "Whisper setup failed, continuing without it: $_"
}

# Firecrawl key: asked once, kept in .firecrawl-key (git-ignored).
$keyFile = Join-Path $PSScriptRoot '.firecrawl-key'
if (-not $env:FIRECRAWL_API_KEY) {
  if (-not (Test-Path $keyFile)) {
    $k = Read-Host 'Firecrawl API key (https://www.firecrawl.dev/app/api-keys)'
    Set-Content $keyFile $k.Trim() -NoNewline
  }
  $env:FIRECRAWL_API_KEY = (Get-Content $keyFile -Raw).Trim()
}

Start-Job { Start-Sleep 2; Start-Process 'http://localhost:5173' } | Out-Null
node server.mjs
