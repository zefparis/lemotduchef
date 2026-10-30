import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { config } from './config.js';
import { mailFromFor, type Market } from './markets.js';
import { tr, marketLang } from './i18n.js';

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  html?: string;
  // Résolu côté serveur selon le marché du destinataire (MAIL_FROM par
  // défaut, MAIL_FROM_ZA / markets.js pour le marché ZA).
  from?: string;
  replyTo?: string;
  headers?: Record<string, string>;
}

// Driver « log » : pour dev/tests, capture les emails en mémoire sans réseau.
// Activé via SMTP_HOST=log.
export const outbox: OutgoingMail[] = [];

export type MailDriver = 'smtp' | 'log' | 'none';

export function mailDriver(): MailDriver {
  if (config.smtp.host === 'log') return 'log';
  if (config.smtp.host) return 'smtp';
  return 'none';
}

export const smtpConfigured = () => mailDriver() !== 'none';

let transporter: Transporter | undefined;
function getTransporter(): Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    });
  }
  return transporter;
}

export async function sendMail(mail: OutgoingMail, market: Market = 'fr'): Promise<void> {
  const driver = mailDriver();
  if (driver === 'none') {
    throw new Error('SMTP non configuré : impossible d\'envoyer des emails.');
  }
  const from = mail.from ?? mailFromFor(market);
  // Répondre à un humain + identifiant unique par email (évite le
  // regroupement Gmail des envois transactionnels).
  const headers = { 'X-Entity-Ref-ID': crypto.randomUUID(), ...(mail.headers ?? {}) };
  const replyTo = mail.replyTo ?? 'contact@lemotduchef.fr';
  if (driver === 'log') {
    outbox.push({ ...mail, from, replyTo, headers });
    console.log(`[mail:log] → ${mail.to} | ${mail.subject}`);
    return;
  }
  await getTransporter().sendMail({ ...mail, from, replyTo, headers });
}

/* ---------- Gabarit HTML ---------- */
// Logo en PNG uniquement (2x pour les écrans Retina) : les clients mail ne
// rendent pas les SVG. Hébergé sur le front public.
// Aucune image : le logo PNG pénalisait mail-tester (HTML_IMAGE_ONLY_24).
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

function mailHtml(text: string): string {
  const paras = text.split(/\n{2,}/).map(p =>
    `<p style="margin:0 0 14px;font:15px/1.65 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#241F1C">${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
  return `<div style="background:#FAF6F0;padding:32px 20px">`
    + `<div style="max-width:520px;margin:0 auto;background:#FFFFFF;border:1px solid #EAE2D8;border-radius:14px;padding:32px">`
    + `<p style="margin:0 0 20px;font:700 20px Georgia,serif;color:#8B3A1F">Le Mot du Chef</p>`
    + paras
    + `<p style="margin:26px 0 0;padding-top:16px;border-top:1px solid #EAE2D8;font:12px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#6F6660">Le Mot du Chef — réponses posées aux avis Google, pour restaurateurs indépendants.</p>`
    + `</div></div>`;
}

// Gabarit transactionnel : vrai bouton <a href> + lien de secours petit et
// gris (cliquable aussi — aucune URL brute en texte dans le HTML). Texte
// identique à la version HTML, pied de page traduit, aucun tiret cadratin.
function buttonMail(kind: 'verify' | 'reset' | 'change', url: string, lang: string): { text: string; html: string } {
  const intro = tr(lang, `mail.${kind}.intro`);
  const cta = tr(lang, `mail.${kind}.cta`);
  const fallback = tr(lang, 'mail.button_fallback');
  const foot = tr(lang, 'mail.footer');
  const font = `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif`;
  const html = `<div style="background:#FAF6F0;padding:32px 20px">`
    + `<div style="max-width:520px;margin:0 auto;background:#FFFFFF;border:1px solid #EAE2D8;border-radius:14px;padding:32px">`
    + `<p style="margin:0 0 20px;font:700 20px Georgia,serif;color:#8B3A1F">Le Mot du Chef</p>`
    + `<p style="margin:0 0 20px;font:15px/1.65 ${font};color:#241F1C">${esc(intro)}</p>`
    + `<p style="margin:0 0 20px"><a href="${esc(url)}" style="display:inline-block;background:#8a3b1f;color:#FFFFFF;font:600 15px/1 ${font};text-decoration:none;padding:13px 22px;border-radius:9px">${esc(cta)}</a></p>`
    + `<p style="margin:0 0 4px;font:12.5px/1.5 ${font};color:#6F6660">${esc(fallback)} <a href="${esc(url)}" style="color:#8A8A98" data-x="">${esc(url)}</a></p>`
    + `<p style="margin:26px 0 0;padding-top:16px;border-top:1px solid #EAE2D8;font:12px/1.6 ${font};color:#6F6660">${esc(foot)}</p>`
    + `</div></div>`;
  const text = `${intro}

${cta} : ${url}

${fallback} ${url}

${foot}`;
  return { text, html };
}

export const EMAIL_TEMPLATES = {
  verify: (url: string, lang = 'fr') => buttonMail('verify', url, lang),
  resetPassword: (url: string, lang = 'fr') => buttonMail('reset', url, lang),
  changeEmail: (url: string, lang = 'fr') => buttonMail('change', url, lang),
};
