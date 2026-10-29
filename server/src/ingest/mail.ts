import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { createHash } from 'node:crypto';
import type { ParsedMail } from 'mailparser';
import { config } from '../config.js';
import { pool } from '../db.js';
import { generateReplies, QuotaExceededError } from '../llm/generate.js';
import { loadProfile } from '../routes/profile.js';
import { notifyRepliesReady } from '../push.js';
import { companyMarket, marketConfig } from '../markets.js';
import type { ReplyLang } from '../llm/langdetect.js';

// Ingestion des avis par email : le restaurateur transfère automatiquement
// les notifications « nouvel avis » de Google vers avis+<code>@lemotduchef.fr.
// Tout est dormant tant que MAIL_INGEST_ENABLED n'est pas 'true'.

export const ingestEnabled = () =>
  config.mailIngest.enabled && !!(config.mailIngest.user && config.mailIngest.pass);

type Headers = ParsedMail['headers'];
// Les en-têtes structurés de mailparser peuvent être des objets {value} ou
// des listes d'adresses {address} — on les aplatit en chaînes.
const flatten = (x: any): string[] => {
  if (x == null) return [];
  if (Array.isArray(x)) return x.flatMap(flatten);
  if (typeof x === 'object') {
    if (typeof x.address === 'string') return [x.address];
    if (x.value !== undefined) return flatten(x.value);
    return [];
  }
  return [String(x)];
};
const headerVals = (headers: Headers, name: string): string[] => flatten(headers.get(name));

/* ---------- Extraction du code restaurant ---------- */
// Avec un transfert automatique, To: garde l'adresse du restaurateur : le
// code se lit dans les en-têtes ajoutés par le serveur de livraison (Zimbra) —
// Delivered-To, X-Original-To, Received « for <…> » — To: en dernier recours.
export function extractIngestCode(headers: Headers, address = config.mailIngest.address): string | null {
  const local = address.split('@')[0];
  const re = new RegExp(`${local}\\+([a-z0-9]{4,16})@`, 'i');
  const candidates = [
    ...headerVals(headers, 'delivered-to'),
    ...headerVals(headers, 'x-original-to'),
    ...headerVals(headers, 'x-delivered-to'),
    ...headerVals(headers, 'received').map(h => /for\s+<([^>]+)>/i.exec(h)?.[1] ?? ''),
    ...headerVals(headers, 'to'),
  ];
  for (const c of candidates) {
    const m = re.exec(c);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

/* ---------- Vérification de l'expéditeur ---------- */
// Anti-injection : l'email doit venir de Google ET passer SPF ou DKIM selon
// Authentication-Results (posé par le MX réceptionnaire, ici OVH).
const GOOGLE_FROM_RE = /@(google\.com|googleapis\.com|withgoogle\.com)$/i;
export async function senderIsGoogle(msg: ParsedMail, raw?: string): Promise<{ ok: boolean; reason?: string }> {
  const from = (msg.from?.value?.[0]?.address ?? '').toLowerCase();
  if (!GOOGLE_FROM_RE.test(from)) return { ok: false, reason: `expéditeur non-Google (${from || 'inconnu'})` };
  const ar = headerVals(msg.headers, 'authentication-results').join(' ').trim();
  if (ar) {
    const spfPass = /spf=pass/i.test(ar) && /smtp\.mailfrom=[^\s;]*google\.com/i.test(ar);
    const dkimPass = /dkim=pass/i.test(ar) && /header\.i?d=[^\s;]*google\.com|header\.d=[^\s;]*google\.com/i.test(ar);
    if (!spfPass && !dkimPass) return { ok: false, reason: 'SPF/DKIM Google non vérifiés' };
    return { ok: true };
  }
  // Pas d'en-tête Authentication-Results (selon le serveur de livraison) :
  // vérification de la signature DKIM par nos soins.
  if (!raw) return { ok: false, reason: 'SPF/DKIM non vérifiables' };
  try {
    const { dkimVerify } = await import('mailauth');
    const res = await dkimVerify(raw);
    const pass = (res?.results ?? []).some((r: any) =>
      r?.status?.result === 'pass' && /(^|\.)google\.com$/i.test(r.signingDomain ?? ''));
    return pass ? { ok: true } : { ok: false, reason: 'signature DKIM Google invalide ou absente' };
  } catch { return { ok: false, reason: 'vérification DKIM impossible' }; }
}

/* ---------- Email de confirmation de règle de transfert (Gmail) ---------- */
// Gmail écrit à l'adresse de destination pour valider la règle : on extrait
// le code et le lien pour les afficher au restaurateur — jamais visités.
export function parseForwardConfirmation(msg: ParsedMail): { code: string; link: string } | null {
  const from = (msg.from?.value?.[0]?.address ?? '').toLowerCase();
  if (!/forwarding-noreply@google\.com$/i.test(from)) return null;
  if (!/transfert|forward|redirect/i.test(msg.subject ?? '')) return null;
  const text = (msg.text || (typeof msg.html === 'string' ? msg.html.replace(/<[^>]+>/g, ' ') : '') || '').replace(/\s+/g, ' ');
  const urls = text.match(/https?:\/\/[^\s"<>]+/g) ?? [];
  // Validation : lien « vf- » (Workspace : souvent le seul lien, sans code)
  // ou URL explicite de confirmation. Jamais le lien « uf- » d'annulation.
  const link = urls.find(u => /google\.com/i.test(u) && /\/vf-/i.test(u))
    ?? urls.find(u => /google\.com/i.test(u) && /confirm|fwd|transfert|transfer/i.test(u) && !/\/uf-/i.test(u))
    ?? '';
  const code = /(?:code[^A-Za-z0-9]{0,10})([A-Z0-9-]{6,20})/i.exec(text)?.[1]
    ?? /\b(\d{3}[- ]?\d{3}[- ]?\d{3})\b/.exec(text)?.[1] ?? '';
  return { code, link };
}

/* ---------- Parsing de l'avis (heuristique, à caler sur le vrai format) ---------- */
// TODO(L2bis) : affiner dès réception d'un email « nouvel avis » Google réel.
export interface ParsedReview { rating: number; author: string; body: string; reviewUrl: string | null }
export function parseGoogleReview(msg: ParsedMail): ParsedReview | null {
  const text = (msg.text || (typeof msg.html === 'string' ? msg.html.replace(/<[^>]+>/g, ' ') : '') || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  // Note : « 5 étoiles », « 3 stars », ou étoiles pleines dans le sujet/corps.
  let rating = 0;
  const m = /([1-5])\s*(?:étoiles?|stars?)|([1-5])\/5/i.exec(text);
  if (m) rating = Number(m[1] ?? m[2]);
  else { const stars = (text.match(/★/g) ?? []).length; if (stars >= 1 && stars <= 5) rating = stars; }
  if (!rating) return null;
  // Auteur : « Avis de Karim », « Karim a publié un nouvel avis »…
  const author = /avis de ([^,.\n"<>:;—–«»]{2,60})/i.exec(text)?.[1]
    ?? /([^,.\n"<>:;—–«»]{2,60}) a (?:publié|posté|laissé)/i.exec(text)?.[1]
    ?? '';
  // Lien vers l'avis : première URL google contenant review/local.
  const links = (typeof msg.html === 'string' ? [...msg.html.matchAll(/href="([^"]+)"/g)].map((x: RegExpMatchArray) => x[1]) : text.match(/https?:\/\/[^\s"'<>]+/g) ?? []);
  const reviewUrl = links.find(u => /google\.(com|fr|co\.)/i.test(u) && /review|local|maps|contrib/i.test(u)) ?? null;
  // Corps : bloc entre l'auteur et le lien (approximation, à caler).
  let body = '';
  const qm = /«([^«»]{10,2000})»/s.exec(text);
  if (qm) body = qm[1].trim();
  return { rating, author: author.trim(), body, reviewUrl };
}

/* ---------- Ingestion d'un email brut (testable sans IMAP) ---------- */
type Log = { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void };
export interface IngestResult { status: 'ok' | 'skipped' | 'duplicate'; detail: string; reviewId?: string }

export async function ingestRawEmail(raw: string, log: Log): Promise<IngestResult> {
  const msg = await simpleParser(raw);
  const code = extractIngestCode(msg.headers);
  if (!code) return { status: 'skipped', detail: 'pas de code avis+<code> dans les en-têtes' };
  const { rows: co } = await pool.query<{ id: string }>('SELECT id FROM companies WHERE ingest_code=$1', [code]);
  const companyId = co[0]?.id;
  if (!companyId) return { status: 'skipped', detail: `code inconnu (${code})` };

  // Email de confirmation de règle de transfert Gmail : enregistré pour être
  // affiché au restaurateur (action manuelle, jamais visité par le serveur).
  const confirm = parseForwardConfirmation(msg);
  if (confirm) {
    await pool.query('INSERT INTO ingest_confirmations (company_id, code, link) VALUES ($1,$2,$3)',
      [companyId, confirm.code, confirm.link]);
    log.info({ companyId }, 'ingest: confirmation de transfert Gmail reçue');
    return { status: 'ok', detail: 'forwarding-confirmation' };
  }

  const sender = await senderIsGoogle(msg, raw);
  if (!sender.ok) {
    log.warn({ companyId, reason: sender.reason }, 'ingest: email rejeté');
    return { status: 'skipped', detail: sender.reason! };
  }

  const parsed = parseGoogleReview(msg);
  if (!parsed || !parsed.body) {
    log.warn({ companyId, subject: msg.subject }, 'ingest: avis illisible (parsing à caler)');
    return { status: 'skipped', detail: 'contenu d’avis non reconnu' };
  }

  // Dédoublonnage : URL de l'avis Google si trouvée, sinon l'empreinte du mail.
  const externalId = parsed.reviewUrl
    ?? `mid:${createHash('sha256').update(String(msg.messageId ?? raw.slice(0, 4000))).digest('hex').slice(0, 40)}`;
  const { rows: ins } = await pool.query<{ id: string }>(
    `INSERT INTO reviews (company_id, source, external_id, author_name, rating, body)
     VALUES ($1,'email',$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id`,
    [companyId, externalId, parsed.author.slice(0, 80), parsed.rating, parsed.body.slice(0, 4000)]);
  const reviewId = ins[0]?.id;
  if (!reviewId) return { status: 'duplicate', detail: externalId };

  // Même pipeline qu'un avis saisi : génération immédiate puis push.
  const review = { author_name: parsed.author, rating: parsed.rating, body: parsed.body, visited_on: null, context_tags: [] as string[], context_note: '' };
  const profile = await loadProfile(companyId);
  if (profile) {
    try {
      await generateReplies(companyId, reviewId, profile, review, log as never,
        { uiLang: marketConfig(await companyMarket(companyId)).lang as ReplyLang });
      const excerpt = parsed.body.slice(0, 90).replace(/\s+/g, ' ').trim();
      const sent = await notifyRepliesReady(companyId, { reviewId, rating: parsed.rating, author: parsed.author, excerpt }, log as never);
      log.info({ companyId, reviewId, rating: parsed.rating, pushed: sent }, 'ingest: avis + réponses prêtes');
    } catch (err) {
      if (err instanceof QuotaExceededError) log.warn({ companyId, reviewId }, 'ingest: quota épuisé, avis stocké sans variantes');
      else throw err;
    }
  } else log.warn({ companyId, reviewId }, 'ingest: pas de profil, avis stocké sans génération');
  return { status: 'ok', detail: externalId, reviewId };
}

/* ---------- Boucle IMAP ---------- */
async function pollOnce(log: Log): Promise<number> {
  const c = config.mailIngest;
  // Nouvelle connexion à chaque relève : OVH coupe les sessions inactives —
  // réutiliser une connexion morte faisait échouer le FETCH. Timeouts bornés
  // pour qu'une connexion figée ne bloque jamais les relèves suivantes.
  const client = new ImapFlow({
    host: c.host, port: c.port, secure: c.tls, auth: { user: c.user, pass: c.pass }, logger: false,
    connectionTimeout: 20_000, greetingTimeout: 15_000, socketTimeout: 60_000,
  });
  let n = 0;
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      for await (const m of client.fetch({ seen: false }, { source: true, uid: true })) {
        try {
          await ingestRawEmail(m.source?.toString('utf8') ?? '', log);
          await client.messageFlagsAdd(m.uid, ['\\Seen'], { uid: true });
          if (c.processedFolder) await client.messageMove(m.uid, c.processedFolder, { uid: true }).catch(() => {});
          n++;
        } catch (err) { log.warn({ err }, 'ingest: message non traité'); }
      }
    } finally { lock.release(); }
  } finally { await client.logout().catch(() => {}); }
  return n;
}

let timer: NodeJS.Timeout | null = null;
let running = false;
let failures = 0;
export function startIngestLoop(log: Log) {
  if (!ingestEnabled()) { log.info({}, 'ingest mail : désactivé (MAIL_INGEST_ENABLED)'); return; }
  const tick = async () => {
    if (running) return;
    running = true;
    try { const n = await pollOnce(log); failures = 0; if (n) log.info({ n }, 'ingest: emails traités'); }
    catch (err) {
      failures++;
      // Bruit de fond toléré (coupures OVH) : warn seulement si ça persiste.
      if (failures >= 3) log.warn({ err, failures }, 'ingest: relève IMAP en échec répété');
      else log.info({ err: (err as Error)?.message, failures }, 'ingest: relève en échec, nouvelle tentative à la prochaine');
    }
    finally { running = false; }
  };
  timer = setInterval(tick, Math.max(30, config.mailIngest.pollIntervalSec) * 1000);
  timer.unref();
  log.info({ host: config.mailIngest.host, every: config.mailIngest.pollIntervalSec }, 'ingest mail : relève IMAP active');
  void tick();
}
export function stopIngestLoop() { if (timer) clearInterval(timer); timer = null; }
