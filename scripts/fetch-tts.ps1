# Fetches the local TTS stack bundled with the app (not committed to git):
#   - Piper neural TTS engine (rhasspy/piper, Windows x64)
#   - en_GB "Alba" medium voice model (~63 MB, runs fully offline)
# Target layout (read by src-tauri via the `resources` bundle config):
#   src-tauri/resources/tts/piper/piper.exe (+ espeak-ng-data, dlls)
#   src-tauri/resources/tts/voices/en_GB-alba-medium.onnx(.json)
$ErrorActionPreference = 'Stop'

$root = Join-Path $PSScriptRoot '..\src-tauri\resources\tts'
$piperDir = Join-Path $root 'piper'
$voiceDir = Join-Path $root 'voices'
New-Item -ItemType Directory -Force $voiceDir | Out-Null

$piperZipUrl = 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip'
$voiceBase = 'https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_GB/alba/medium'

if (-not (Test-Path (Join-Path $piperDir 'piper.exe'))) {
    $zip = Join-Path $env:TEMP 'piper_windows_amd64.zip'
    Write-Host "Downloading Piper engine..."
    Invoke-WebRequest -Uri $piperZipUrl -OutFile $zip -UseBasicParsing
    $tmp = Join-Path $env:TEMP 'piper_extract'
    if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
    Expand-Archive -Path $zip -DestinationPath $tmp
    # The zip contains a top-level 'piper' folder.
    $src = Join-Path $tmp 'piper'
    if (-not (Test-Path $src)) { $src = $tmp }
    New-Item -ItemType Directory -Force (Split-Path $piperDir) | Out-Null
    Move-Item -Force $src $piperDir
    Remove-Item -Force $zip
    if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
}

$onnx = Join-Path $voiceDir 'en_GB-alba-medium.onnx'
if (-not (Test-Path $onnx)) {
    Write-Host "Downloading Alba voice model (~63 MB)..."
    Invoke-WebRequest -Uri "$voiceBase/en_GB-alba-medium.onnx" -OutFile $onnx -UseBasicParsing
    Invoke-WebRequest -Uri "$voiceBase/en_GB-alba-medium.onnx.json" -OutFile "$onnx.json" -UseBasicParsing
}

$maleBase = 'https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_GB/northern_english_male/medium'
$male = Join-Path $voiceDir 'en_GB-northern_english_male-medium.onnx'
if (-not (Test-Path $male)) {
    Write-Host "Downloading Northern English male voice (~63 MB)..."
    Invoke-WebRequest -Uri "$maleBase/en_GB-northern_english_male-medium.onnx" -OutFile $male -UseBasicParsing
    Invoke-WebRequest -Uri "$maleBase/en_GB-northern_english_male-medium.onnx.json" -OutFile "$male.json" -UseBasicParsing
}

Write-Host "TTS resources ready under $root"
