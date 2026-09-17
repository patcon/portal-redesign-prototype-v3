#!/usr/bin/env bash
# Downloads the whisperfile model used by src/local-whisper-stt.ts for
# offline dev transcription. See README.md for details.
set -o errexit -o nounset -o pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.whisperfile"
FILE="$DIR/whisper-tiny.en.llamafile"
URL="https://huggingface.co/Mozilla/whisperfile/resolve/main/whisper-tiny.en.llamafile"

mkdir -p "$DIR"

if [ -f "$FILE" ]; then
  echo "Already downloaded: $FILE"
else
  echo "Downloading whisper-tiny.en.llamafile..."
  curl --location --fail --output "$FILE" "$URL"
fi

chmod +x "$FILE"
echo "Ready. Run 'pnpm stt:server' to start it."
