#!/bin/bash
# Genera electron/icon.icns dall'SVG electron/icon.svg (da lanciare su macOS)
#
# Dipendenze macOS (tutte preinstallate su un Mac recente):
#   - sips       (conversione/resize immagini — nativo macOS)
#   - iconutil   (creazione .icns — nativo macOS)
#   - rsvg-convert  (brew install librsvg)   OPPURE   qlmanage (nativo macOS, qualità inferiore)
#
# Uso: ./scripts/make-mac-icon.sh

set -euo pipefail
cd "$(dirname "$0")/.."

SVG="electron/icon.svg"
PNG="electron/icon.png"
ICONSET="electron/icon.iconset"
ICNS="electron/icon.icns"

if [ ! -f "$SVG" ]; then
  echo "❌ Non trovo $SVG"
  exit 1
fi

# 1. SVG → PNG 1024x1024
if command -v rsvg-convert >/dev/null 2>&1; then
  echo "[icon] rsvg-convert disponibile — qualità ottima."
  rsvg-convert -w 1024 -h 1024 "$SVG" -o "$PNG"
elif command -v qlmanage >/dev/null 2>&1; then
  echo "[icon] rsvg-convert non disponibile, uso qlmanage (nativo macOS)."
  qlmanage -t -s 1024 -o /tmp "$SVG" >/dev/null
  mv "/tmp/$(basename "$SVG").png" "$PNG"
else
  echo "❌ Installa rsvg-convert con:  brew install librsvg"
  exit 1
fi

# 2. PNG → iconset multi-resolution
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z $size $size "$PNG" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z $double $double "$PNG" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done

# 3. iconset → .icns
iconutil -c icns "$ICONSET" -o "$ICNS"

# Cleanup
rm -rf "$ICONSET"

echo "✓ Generato $ICNS"
ls -lh "$ICNS"
