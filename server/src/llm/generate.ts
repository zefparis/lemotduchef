import { pool } from '../db.js';
import { config } from '../config.js';
import { llmProvider, LlmError } from './provider.js';
import { effectivePlan, FREE_MONTHLY_LIMIT } from '../stripe.js';
import { SYSTEM_PROMPT, PROMPT_VERSION, buildUserPrompt, signatureOf, assignedStrengths, authorDisplayName, AUTHOR_MARKER } from './prompt.js';
import type { PromptProfile, PromptReview } from './prompt.js';
import { checkReply, parseVariants, tooSimilar, cleanReply, withSignature, mentionsContactEmail, mentionsReservation } from './rules.js';

// Quota mensuel épuisé (réservation refusée dans la transaction atomique).
export class QuotaExceededError extends Error {}

export interface GeneratedVariant { idx: number; text: string; warnings: string[]; words: number; needsReview?: boolean }
export interface GenerationOutcome {
  generationId: string;
  variants: GeneratedVariant[];
  usage: { inputTokens: number; outputTokens: number; model: string; provider: string; durationMs: number; stopReason: string };
  rejected: string[]; // motifs des variantes écartées (debug/UI)
}

// Les 10 dernières réponses publiées (sinon générées) : premières phrases
// transmises au modèle comme « formulations à éviter ».
async function recentPhrases(companyId: string, excludeReviewId: string): Promise<string[]> {
  const { rows } = await pool.query<{ t: string }>(
    `SELECT t FROM (
       SELECT published_reply AS t, published_at AS at FROM reviews
        WHERE company_id=$1 AND published_reply IS NOT NULL AND id<>$2
       UNION ALL
       SELECT v.text, v.created_at FROM reply_variants v
        WHERE v.company_id=$1 AND v.idx=0 AND v.review_id<>$2
     ) x ORDER BY at DESC LIMIT 10`, [companyId, excludeReviewId]);
  const out = new Set<string>();
  for (const { t } of rows) {
    const first = t.split(/(?<=[.!?])\s+/)[0]?.trim();
    if (first && first.length > 15) out.add(first.slice(0, 160));
  }
  return [...out];
}

export async function generateReplies(
  companyId: string, reviewId: string, profile: PromptProfile, review: PromptReview, log: { warn: (o: any, m?: string) => void; info: (o: any, m?: string) => void },
  opts: { unlimited?: boolean; includeAuthorName?: boolean } = {},
): Promise<GenerationOutcome> {
  const provider = llmProvider();
  const avoid = await recentPhrases(companyId, reviewId);
  // Minimisation RGPD : le modèle reçoit le marqueur [PRÉNOM], jamais le nom.
  // Réinséré ici uniquement si le restaurateur l'a demandé ; sinon retiré.
  const author = authorDisplayName(review);
  const includeName = opts.includeAuthorName !== false && !!author;
  const applyAuthor = (text: string): string => {
    if (includeName && author) return text.replaceAll(AUTHOR_MARKER, author.charAt(0).toUpperCase() + author.slice(1));
    // Marqueur retiré : « Bonjour [PRÉNOM], » → « Bonjour, » (et ailleurs).
    return text.replace(new RegExp(`\\s*${AUTHOR_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'g'),
      (m, off, s: string) => (off === 0 || /[,;.!?»]$/.test(s.slice(0, off)) ? ' ' : ''))
      .replace(/\bBonjour\s*,/g, 'Bonjour,').replace(/,\s*,/g, ',');
  };
  // Référentiel des règles : sans le nom quand il n'est pas réinséré.
  const effectiveReview: PromptReview = includeName ? review : { ...review, author_name: '' };
  // Point fort imposé par variante, décidé par le code (rotation historique) :
  // variante 1 factuelle → aucun ; variantes 2 et 3 → chacune le sien.
  const strengths = assignedStrengths(profile, avoid.length);
  const sig = signatureOf(profile);
  const started = Date.now();

  // Réservation atomique du quota : une ligne `generations` = un appel LLM,
  // insérée AVANT la requête fournisseur (chaque appel coûte, y compris les
  // échecs — ils comptent donc aussi). FOR UPDATE sur la ligne companies
  // sérialise les appels concurrents du même restaurant : pas de dépassement
  // de quota par course.
  const client = await pool.connect();
  let generationId = '';
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM companies WHERE id=$1 FOR UPDATE', [companyId]);
    if (!opts.unlimited) {
      const { rows: co } = await client.query<{ plan: string; subscription_status: string }>(
        'SELECT plan, subscription_status FROM companies WHERE id=$1', [companyId]);
      if (effectivePlan(co[0] ?? { plan: 'free', subscription_status: 'none' }) === 'free') {
        const { rows: n } = await client.query<{ n: string }>(
          `SELECT count(*) AS n FROM generations
            WHERE company_id=$1 AND status <> 'unbilled' AND created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
          [companyId]);
        if (Number(n[0].n) >= FREE_MONTHLY_LIMIT) {
          await client.query('ROLLBACK');
          throw new QuotaExceededError('quota mensuel épuisé');
        }
      }
    }
    const { rows: g } = await client.query<{ id: string }>(
      `INSERT INTO generations (review_id, company_id, provider, model, prompt_version, status)
       VALUES ($1,$2,$3,$4,$5,'running') RETURNING id`,
      [reviewId, companyId, provider.name, config.llm.model, PROMPT_VERSION]);
    generationId = g[0].id;
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  let inputTokens = 0, outputTokens = 0, model = config.llm.model, stopReason = '';
  const slots: (GeneratedVariant | null)[] = [null, null, null];
  const rejected: string[] = [];
  // Sobriété entre variantes : l'email de contact dans au plus 2 réponses,
  // « réservez » dans une seule.
  let emailVariants = 0, reservationUsed = false;
  const missing = () => slots.map((s, i) => (s ? -1 : i)).filter(i => i >= 0);

  // Deux tentatives maximum : la seconde ne régénère que les positions restées
  // non conformes (format ou règles), signalées dans le prompt.
  for (let attempt = 0; attempt < 2 && missing().length; attempt++) {
    const todo = missing();
    const user = buildUserPrompt(profile, review, avoid,
      { strengths, missing: attempt === 0 ? undefined : todo });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), config.llm.timeoutMs);
    let res;
    try {
      res = await provider.complete({
        system: SYSTEM_PROMPT,
        user: attempt === 0 ? user : user + '\n\nRAPPEL : respecte la longueur cible, les formules interdites, les faits fournis uniquement, l’ouverture et les points forts imposés par variante.',
        maxTokens: config.llm.maxOutputTokens,
      }, ctrl.signal);
    } catch (err) {
      clearTimeout(timer);
      if (slots.some(Boolean)) break; // on garde ce qu'on a
      if (err instanceof LlmError) {
        // Échec fournisseur : la réservation est consommée quand même (coût réel).
        await pool.query(`UPDATE generations SET status='failed', duration_ms=$2 WHERE id=$1`,
          [generationId, Date.now() - started]).catch(() => {});
        log.warn({ kind: err.kind, detail: (err as any).detail }, 'llm: échec');
        throw err;
      }
      throw new LlmError('Génération impossible pour le moment.', 'upstream');
    }
    clearTimeout(timer);
    inputTokens += res.inputTokens; outputTokens += res.outputTokens; model = res.model; stopReason = res.stopReason;
    const texts = parseVariants(res.text);
    if (!texts.length) { rejected.push('réponse du modèle illisible (JSON attendu)'); continue; }
    // Correspondance texte → position : 3 entrées = positions d'origine ;
    // sinon, dans l'ordre des positions demandées.
    const queue: Array<[number, string]> = texts.length === 3
      ? texts.map((t, i): [number, string] => [i, t]).filter(([i]) => todo.includes(i))
      : texts.map((t, j): [number, string] => [todo[j], t]).filter(([i]) => i !== undefined);
    for (const [i, raw] of queue) {
      // La signature exacte du profil est ajoutée ici : les règles contrôlent
      // le texte final assemblé, la longueur se mesure sur le corps seul.
      const text = withSignature(applyAuthor(cleanReply(raw)), sig);
      if (slots.some(a => a && a.text === text)) continue;
      if (slots.some(a => a && tooSimilar(a.text, text))) { rejected.push(`variante ${i + 1} : trop proche d’une autre`); continue; }
      const hasEmail = mentionsContactEmail(text, profile);
      if (hasEmail && emailVariants >= 2) { rejected.push(`variante ${i + 1} : email dans trop de variantes`); continue; }
      const hasReservation = mentionsReservation(text);
      if (hasReservation && reservationUsed) { rejected.push(`variante ${i + 1} : « réservez » déjà utilisé`); continue; }
      const c = checkReply(text, profile, effectiveReview, { allowedStrength: strengths[i] });
      if (c.ok) {
        slots[i] = { idx: i, text, warnings: c.warnings, words: c.words };
        if (hasEmail) emailVariants++;
        if (hasReservation) reservationUsed = true;
      } else rejected.push(`variante ${i + 1} : ${c.errors.join(', ')}`);
    }
  }
  const durationMs = Date.now() - started;
  const accepted = slots.filter((s): s is GeneratedVariant => !!s);
  // Quota : une génération qui produit moins de 2 propositions utilisables
  // n'est pas décomptée (status 'unbilled', ignoré du décompte mensuel).
  if (accepted.length < 2) {
    await pool.query(
      `UPDATE generations SET status='unbilled', model=$2, input_tokens=$3, output_tokens=$4, duration_ms=$5 WHERE id=$1`,
      [generationId, model, inputTokens, outputTokens, durationMs]);
    log.warn({ rejected, accepted: accepted.length }, 'llm: moins de 2 variantes utilisables — génération non décomptée');
    if (accepted.length === 1) {
      const variants: GeneratedVariant[] = [accepted[0], { idx: 1, text: '', warnings: [], words: 0, needsReview: true }, { idx: 2, text: '', warnings: [], words: 0, needsReview: true }];
      return { generationId, variants, usage: { inputTokens, outputTokens, model, provider: provider.name, durationMs, stopReason }, rejected };
    }
    throw new LlmError('Le rédacteur n’a pas produit de réponse conforme aux règles. Réessayez dans un instant.', 'format');
  }

  const done = await pool.connect();
  try {
    await done.query('BEGIN');
    await done.query(
      `UPDATE generations SET status='ok', model=$2, input_tokens=$3, output_tokens=$4, duration_ms=$5 WHERE id=$1`,
      [generationId, model, inputTokens, outputTokens, durationMs]);
    for (const v of accepted) {
      await done.query(
        `INSERT INTO reply_variants (generation_id, review_id, company_id, idx, text, warnings) VALUES ($1,$2,$3,$4,$5,$6)`,
        [generationId, reviewId, companyId, v.idx, v.text, v.warnings]);
    }
    await done.query('COMMIT');
  } catch (err) {
    await done.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { done.release(); }

  // Les positions restées non conformes reviennent marquées « à revoir ».
  const variants: GeneratedVariant[] = slots.map((s, i) => s ?? { idx: i, text: '', warnings: [], words: 0, needsReview: true });
  // Journal du coût par réponse (tokens, stop_reason) — jamais le contenu de l'avis.
  log.info({ generationId, companyId, provider: provider.name, model, inputTokens, outputTokens, stopReason, durationMs, variants: accepted.length, rejected: rejected.length, rejectedReasons: rejected }, 'llm: génération');
  return { generationId, variants, usage: { inputTokens, outputTokens, model, provider: provider.name, durationMs, stopReason }, rejected };
}
