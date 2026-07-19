#!/usr/bin/env bash
# Linux twin of fetch-tts.ps1 — fetches the bundled local TTS stack:
#   - Piper neural TTS engine (rhasspy/piper, Linux x86_64 ELF + .so libs)
#   - en_GB "Alba" + Northern English male medium voices (~63 MB each)
# Target layout (bundled via tauri.linux.conf.json resources):
#   src-tauri/resources/tts-linux/piper/piper (+ espeak-ng-data, libs)
#   src-tauri/resources/tts-linux/voices/*.onnx(.json)
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)/src-tauri/resources/tts-linux"
piper_dir="$root/piper"
voice_dir="$root/voices"
mkdir -p "$voice_dir"

piper_url="https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz"
voice_base="https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_GB"

if [ ! -x "$piper_dir/piper" ]; then
  echo "Downloading Piper engine (Linux x86_64)..."
  tmp="$(mktemp -d)"
  curl -sL "$piper_url" -o "$tmp/piper.tar.gz"
  tar -xzf "$tmp/piper.tar.gz" -C "$tmp"
  mkdir -p "$root"
  rm -rf "$piper_dir"
  mv "$tmp/piper" "$piper_dir"
  rm -rf "$tmp"
fi

# The standalone helper binaries aren't used at runtime, and linuxdeploy's
# AppImage dependency walk chokes on them ("Could not find dependency:
# libespeak-ng.so.1") — the piper binary itself resolves its libs via rpath.
rm -f "$piper_dir/espeak-ng" "$piper_dir/piper_phonemize"
rm -rf "$piper_dir/pkgconfig"

fetch_voice() {
  local name="$1" sub="$2"
  if [ ! -f "$voice_dir/$name.onnx" ]; then
    echo "Downloading voice $name (~63 MB)..."
    curl -sL "$voice_base/$sub/$name.onnx" -o "$voice_dir/$name.onnx"
    curl -sL "$voice_base/$sub/$name.onnx.json" -o "$voice_dir/$name.onnx.json"
  fi
}

fetch_voice "en_GB-alba-medium" "alba/medium"
fetch_voice "en_GB-northern_english_male-medium" "northern_english_male/medium"

echo "Linux TTS resources ready under $root"
