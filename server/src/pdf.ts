import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';
import type { PDFFont, PDFPage } from 'pdf-lib';
import QRCode from 'qrcode';

// Supports de collecte d'avis imprimables (chevalet de table, encarts
// d'addition). Le QR code mène DIRECTEMENT à la page d'avis Google, pour tous
// les clients : aucun filtrage, aucune contrepartie.

export interface CollectContent {
  restaurant: string;
  title: string;
  message: string;
  reviewUrl: string;
}

const MM = 72 / 25.4;
const INK = rgb(0.11, 0.13, 0.12);
const ACCENT = rgb(0.62, 0.24, 0.13);
const MUTED = rgb(0.45, 0.45, 0.43);

// Polices standard (WinAnsi) : on retire les caractères non encodables plutôt
// que d'échouer (emoji, symboles exotiques).
function safe(s: string): string {
  return s.replace(/[^\u0020-\u007E\u00A0-\u00FF\u0152\u0153\u0160\u0161\u0178\u017D\u017E\u2013\u2014\u2018\u2019\u201C\u201D\u2022\u2026\u20AC]/g, '').trim();
}

function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const para of safe(text).split(/\n+/)) {
    let line = '';
    for (const w of para.split(/\s+/).filter(Boolean)) {
      const t = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(t, size) <= maxWidth) line = t;
      else { if (line) lines.push(line); line = w; }
    }
    if (line) lines.push(line);
  }
  return lines;
}

async function qrPng(url: string): Promise<Uint8Array> {
  return QRCode.toBuffer(url, { type: 'png', errorCorrectionLevel: 'M', margin: 1, width: 600, color: { dark: '#1c211f', light: '#ffffff' } });
}

interface Fonts { regular: PDFFont; bold: PDFFont }

// Dessine un panneau (texte + QR) centré sur la zone [x, y, w, h]. rotated=true
// → contenu retourné de 180° (moitié haute du chevalet, lisible une fois plié).
function drawPanel(page: PDFPage, fonts: Fonts, qr: any, c: CollectContent, x: number, y: number, w: number, h: number, rotated: boolean, scale = 1) {
  const rot = rotated ? degrees(180) : degrees(0);
  // Rotation 180° = symétrie centrale du panneau : chaque point (px,py) devient
  // (x+w-(px-x), y+h-(py-y)) et l'origine d'un élément devient son coin haut-droit.
  const centerText = (text: string, font: PDFFont, size: number, baselineY: number, color = INK) => {
    const tw = font.widthOfTextAtSize(text, size);
    const px = x + (w - tw) / 2;
    if (rotated) page.drawText(text, { x: x + w - (px - x), y: y + h - (baselineY - y), size, font, color, rotate: rot });
    else page.drawText(text, { x: px, y: baselineY, size, font, color });
  };

  const titleSize = 22 * scale, bodySize = 11.5 * scale, nameSize = 13 * scale, smallSize = 8 * scale;
  const qrSize = Math.min(w * 0.42, h * 0.46);
  let cursor = y + h - 14 * MM * scale;

  const title = wrap(c.title, fonts.bold, titleSize, w - 16 * MM);
  for (const l of title.slice(0, 2)) { centerText(l, fonts.bold, titleSize, cursor, ACCENT); cursor -= titleSize * 1.2; }
  cursor -= 2 * MM * scale;
  const msg = wrap(c.message, fonts.regular, bodySize, w - 18 * MM);
  for (const l of msg.slice(0, 4)) { centerText(l, fonts.regular, bodySize, cursor); cursor -= bodySize * 1.35; }
  cursor -= 4 * MM * scale;

  const qx = x + (w - qrSize) / 2, qy = cursor - qrSize;
  if (rotated) page.drawImage(qr, { x: x + w - (qx - x), y: y + h - (qy - y), width: qrSize, height: qrSize, rotate: rot });
  else page.drawImage(qr, { x: qx, y: qy, width: qrSize, height: qrSize });
  cursor = qy - 7 * MM * scale;

  centerText(safe(c.restaurant), fonts.bold, nameSize, cursor);
  cursor -= nameSize * 1.5;
  centerText('Scannez avec l’appareil photo de votre téléphone', fonts.regular, smallSize, cursor, MUTED);
  cursor -= smallSize * 1.4;
  centerText('Avis Google · tous les avis sont les bienvenus', fonts.regular, smallSize, cursor, MUTED);
}

// Chevalet : A4 portrait plié en deux (deux faces A5, l'une tête-bêche).
export async function chevaletPdf(c: CollectContent): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Chevalet avis Google — ${safe(c.restaurant)}`);
  doc.setProducer('Le Mot du Chef');
  const fonts: Fonts = { regular: await doc.embedFont(StandardFonts.Helvetica), bold: await doc.embedFont(StandardFonts.HelveticaBold) };
  const qr = await doc.embedPng(await qrPng(c.reviewUrl));
  const page = doc.addPage([210 * MM, 297 * MM]);
  const W = 210 * MM, H = 297 * MM;
  // Ligne de pliage.
  page.drawLine({ start: { x: 8 * MM, y: H / 2 }, end: { x: W - 8 * MM, y: H / 2 }, thickness: 0.4, color: MUTED, dashArray: [4, 4] });
  page.drawText('plier ici', { x: W - 24 * MM, y: H / 2 + 1.5 * MM, size: 7, font: fonts.regular, color: MUTED });
  drawPanel(page, fonts, qr, c, 10 * MM, 10 * MM, W - 20 * MM, H / 2 - 20 * MM, false);
  drawPanel(page, fonts, qr, c, 10 * MM, H / 2 + 10 * MM, W - 20 * MM, H / 2 - 20 * MM, true);
  return doc.save();
}

// Encarts d'addition : 8 cartes 85 × 55 mm par page A4, traits de coupe.
export async function encartPdf(c: CollectContent): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Encarts d’addition avis Google — ${safe(c.restaurant)}`);
  doc.setProducer('Le Mot du Chef');
  const fonts: Fonts = { regular: await doc.embedFont(StandardFonts.Helvetica), bold: await doc.embedFont(StandardFonts.HelveticaBold) };
  const qr = await doc.embedPng(await qrPng(c.reviewUrl));
  const page = doc.addPage([210 * MM, 297 * MM]);
  const cw = 85 * MM, ch = 55 * MM, gap = 6 * MM;
  const x0 = (210 * MM - 2 * cw - gap) / 2, y0 = (297 * MM - 4 * ch - 3 * gap) / 2;
  for (let row = 0; row < 4; row++) for (let col = 0; col < 2; col++) {
    const x = x0 + col * (cw + gap), y = y0 + row * (ch + gap);
    page.drawRectangle({ x, y, width: cw, height: ch, borderWidth: 0.4, borderColor: MUTED, borderDashArray: [3, 3] });
    // Mise en page horizontale : QR à gauche, texte à droite.
    const qs = ch - 12 * MM;
    page.drawImage(qr, { x: x + 6 * MM, y: y + (ch - qs) / 2, width: qs, height: qs });
    const tx = x + 6 * MM + qs + 5 * MM, tw = cw - (6 * MM + qs + 5 * MM) - 5 * MM;
    let cursor = y + ch - 11 * MM;
    for (const l of wrap(c.title, fonts.bold, 11, tw).slice(0, 2)) { page.drawText(l, { x: tx, y: cursor, size: 11, font: fonts.bold, color: ACCENT }); cursor -= 13; }
    cursor -= 2;
    for (const l of wrap(c.message, fonts.regular, 7.5, tw).slice(0, 4)) { page.drawText(l, { x: tx, y: cursor, size: 7.5, font: fonts.regular, color: INK }); cursor -= 9.5; }
    cursor -= 3;
    for (const l of wrap(c.restaurant, fonts.bold, 8.5, tw).slice(0, 1)) { page.drawText(l, { x: tx, y: cursor, size: 8.5, font: fonts.bold, color: INK }); cursor -= 11; }
    page.drawText('Avis Google · scannez avec votre téléphone', { x: tx, y: y + 4 * MM, size: 6, font: fonts.regular, color: MUTED });
  }
  return doc.save();
}

export const qrPngBuffer = (url: string) => qrPng(url);
