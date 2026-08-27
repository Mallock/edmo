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

# One transient stream error should not cost a ten-minute container build.
# HuggingFace occasionally drops an HTTP/2 stream mid-file (curl exit 92) and
# `set -e` turns that into a failed build after everything else has compiled.
# -f so an error page is never mistaken for a payload; the retries cover the
# rest. Downloads land on a .part and are moved into place only when complete,
# so a truncated file can never satisfy the "already fetched" check next time.
dl() {
  curl -fsSL --retry 5 --retry-delay 3 --retry-all-errors "$1" -o "$2.part"
  mv "$2.part" "$2"
}

if [ ! -x "$piper_dir/piper" ]; then
  echo "Downloading Piper engine (Linux x86_64)..."
  tmp="$(mktemp -d)"
  dl "$piper_url" "$tmp/piper.tar.gz"
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
    dl "$voice_base/$sub/$name.onnx" "$voice_dir/$name.onnx"
    dl "$voice_base/$sub/$name.onnx.json" "$voice_dir/$name.onnx.json"
  fi
}

fetch_voice "en_GB-alba-medium" "alba/medium"
fetch_voice "en_GB-northern_english_male-medium" "northern_english_male/medium"

echo "Linux TTS resources ready under $root"
