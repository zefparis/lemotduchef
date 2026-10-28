#!/usr/bin/env bash
# Génère les déclinaisons PNG du logo depuis design/logo-mark*.svg.
# Aucune retouche de forme : seuls les couleurs, fonds et échelles changent.
# Usage : bash design/render-assets.sh   (ImageMagick requis)
set -euo pipefail
cd "$(dirname "$0")/.."

TERRA='#8B3A1F'; CREAM='#F7F2EA'; BROWN='#1A1512'; PAPER='#FAF6F0'
MARK_SMALL=/tmp/lmc-mark-small.svg
sed "s/fill=\"currentColor\"/fill=\"$TERRA\"/" design/logo-mark-small.svg > "$MARK_SMALL"

# ---------- favicon.ico : 16 / 32 / 48 px, terre cuite sur transparent ------
for s in 16 32 48; do
  convert -background none -density 600 "$MARK_SMALL" -resize "${s}x${s}" "/tmp/fav-$s.png"
done
convert /tmp/fav-16.png /tmp/fav-32.png /tmp/fav-48.png public/favicon.ico

# ---------- icône d'appli : crème sur carré arrondi terre cuite -------------
icon() { # $1 taille px, $2 sortie, $3 rayon coins, $4 largeur symbole px
  local size=$1 out=$2 rad=$3 mw=$4
  convert -background none -density 600 -size "${size}x${size}" \
    /tmp/lmc-mark-cream.svg -resize "${mw}x" /tmp/lmc-icon-mark.png
  convert -size "${size}x${size}" xc:none \
    -fill "$TERRA" -draw "roundrectangle 0,0 $((size-1)),$((size-1)) $rad,$rad" \
    /tmp/lmc-icon-mark.png -gravity center -composite "$out"
}
sed "s/fill=\"currentColor\"/fill=\"$CREAM\"/" design/logo-mark.svg > /tmp/lmc-mark-cream.svg
icon 180 public/apple-touch-icon.png 40 118
icon 192 public/icon-192.png 42 126
icon 512 public/icon-512.png 116 336

# ---------- maskable 512 : fond plein, symbole dans le cercle 80 % ----------
# Zone sûre Android : tout le symbole dans Ø410 px → demi-diagonale ≤ 205 px.
convert -background none -density 600 -size 512x512 /tmp/lmc-mark-cream.svg \
  -resize 310x /tmp/lmc-maskable-mark.png
convert -size 512x512 xc:"$TERRA" /tmp/lmc-maskable-mark.png \
  -gravity center -composite public/icon-maskable-512.png

# ---------- Open Graph 1200×630 : symbole + nom sur fond crème --------------
sed "s/fill=\"currentColor\"/fill=\"$TERRA\"/" design/logo-mark.svg > /tmp/lmc-mark-terra.svg
convert -background "$PAPER" -density 600 /tmp/lmc-mark-terra.svg \
  -resize 190x152 /tmp/lmc-og-mark.png
convert -size 1200x630 xc:"$PAPER" \
  /tmp/lmc-og-mark.png -geometry +150+239 -composite \
  -font DejaVu-Sans-Bold -pointsize 78 -fill '#241F1C' \
  -annotate +380+330 'Le Mot du Chef' \
  -font DejaVu-Sans -pointsize 34 -fill '#8B3A1F' \
  -annotate +382+390 'réponses aux avis Google' \
  public/og.png

# ---------- Email : PNG 2x (affiché ~64 px), terre cuite sur transparent ----
convert -background none -density 600 /tmp/lmc-mark-terra.svg \
  -resize 128x128 public/logo-email.png

echo "Généré : favicon.ico apple-touch-icon.png icon-{192,512}.png icon-maskable-512.png og.png logo-email.png"
