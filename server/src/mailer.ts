import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { config } from './config.js';

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  html?: string;
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

export async function sendMail(mail: OutgoingMail): Promise<void> {
  const driver = mailDriver();
  if (driver === 'none') {
    throw new Error('SMTP non configuré : impossible d\'envoyer des emails.');
  }
  if (driver === 'log') {
    outbox.push(mail);
    console.log(`[mail:log] → ${mail.to} | ${mail.subject}`);
    return;
  }
  await getTransporter().sendMail({ from: config.smtp.from, ...mail });
}

/* ---------- Gabarit HTML ---------- */
// Logo en PNG uniquement (2x pour les écrans Retina) : les clients mail ne
// rendent pas les SVG. Hébergé sur le front public.
const LOGO_URL = `${config.frontUrl}/logo-email.png`;
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

function mailHtml(text: string): string {
  const paras = text.split(/\n{2,}/).map(p =>
    `<p style="margin:0 0 14px;font:15px/1.65 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#241F1C">${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
  return `<div style="background:#FAF6F0;padding:32px 20px">`
    + `<div style="max-width:520px;margin:0 auto;background:#FFFFFF;border:1px solid #EAE2D8;border-radius:14px;padding:32px">`
    + `<img src="${LOGO_URL}" alt="Le Mot du Chef" width="48" height="48" style="display:block;margin:0 0 20px">`
    + paras
    + `<p style="margin:26px 0 0;padding-top:16px;border-top:1px solid #EAE2D8;font:12px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#6F6660">Le Mot du Chef — réponses posées aux avis Google, pour restaurateurs indépendants.</p>`
    + `</div></div>`;
}

function mail(text: string): { text: string; html: string } {
  return { text, html: mailHtml(text) };
}

export const EMAIL_TEMPLATES = {
  verify: (url: string) => mail(
    `Bonjour,\n\nBienvenue sur Le Mot du Chef. Confirmez votre adresse email en cliquant sur ce lien (valable 24 h) :\n\n${url}\n\nSi vous n'êtes pas à l'origine de cette inscription, ignorez ce message.\n\n— L'équipe Le Mot du Chef`),
  resetPassword: (url: string) => mail(
    `Bonjour,\n\nCliquez sur ce lien pour définir ou réinitialiser votre mot de passe Le Mot du Chef (valable 1 h, usage unique) :\n\n${url}\n\nSi vous n'êtes pas à l'origine de cette demande, ignorez ce message : votre mot de passe reste inchangé.\n\n— L'équipe Le Mot du Chef`),
  changeEmail: (url: string) => mail(
    `Bonjour,\n\nConfirmez votre nouvelle adresse email Le Mot du Chef en cliquant sur ce lien :\n\n${url}\n\nSi vous n'êtes pas à l'origine de cette demande, ignorez ce message.\n\n— L'équipe Le Mot du Chef`),
};
