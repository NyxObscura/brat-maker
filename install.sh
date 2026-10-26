#!/bin/bash
# Install Apple Color Emoji font untuk Brat Generator
# Jalankan sekali saat setup server: bash scripts/install-emoji-font.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FONTS_DIR="$SCRIPT_DIR/../src/fonts"
FONT_PATH="$FONTS_DIR/AppleColorEmoji.ttf"

mkdir -p "$FONTS_DIR"

if [ -f "$FONT_PATH" ]; then
  echo "Apple Color Emoji sudah ada di $FONT_PATH"
  exit 0
fi

echo "Downloading Apple Color Emoji font..."

# Repo terbaru: samuelngs/apple-emoji-ttf (macOS 26, latest release)
curl -L --fail \
  "https://github.com/samuelngs/apple-emoji-ttf/releases/download/macos-26-20260219-2aa12422/AppleColorEmoji-Linux.ttf" \
  -o "$FONT_PATH"

if [ $? -eq 0 ] && [ -s "$FONT_PATH" ]; then
  echo "Apple Color Emoji berhasil didownload ke $FONT_PATH"
  exit 0
fi

echo "Gagal. Coba download manual:"
echo "  1. Buka: https://github.com/samuelngs/apple-emoji-ttf/releases/latest"
echo "  2. Download: AppleColorEmoji-Linux.ttf"
echo "  3. Taruh di: src/fonts/AppleColorEmoji.ttf"
echo ""
echo "Noto Color Emoji (sudah ada di Ubuntu) akan dipakai sebagai fallback."
exit 1
