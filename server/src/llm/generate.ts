import { pool } from '../db.js';
import { config } from '../config.js';
import { llmProvider, LlmError } from './provider.js';
import { SYSTEM_PROMPT, PROMPT_VERSION, buildUserPrompt, signatureOf, assignedStrengths, strengthOptional } from './prompt.js';
import type { PromptProfile, PromptReview } from './prompt.js';
import { checkReply, parseVariants, tooSimilar, withSignature, mentionsContactEmail, mentionsReservation } from './rules.js';

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
): Promise<GenerationOutcome> {
  const provider = llmProvider();
  const avoid = await recentPhrases(companyId, reviewId);
  // Point fort imposé par variante, décidé par le code (rotation historique) :
  // variante 1 factuelle → aucun ; variantes 2 et 3 → chacune le sien.
  const strengths = assignedStrengths(profile, avoid.length);
  const optionalStrength = strengthOptional(review);
  const sig = signatureOf(profile);
  const started = Date.now();
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
        user: attempt === 0 ? user : user + '\n\nRAPPEL : respecte la longueur cible, les formules interdites, les faits fournis uniquement, l’ouverture « Bonjour {prénom} » et les points forts imposés par variante.',
        maxTokens: config.llm.maxOutputTokens,
      }, ctrl.signal);
    } catch (err) {
      clearTimeout(timer);
      if (slots.some(Boolean)) break; // on garde ce qu'on a
      if (err instanceof LlmError) { log.warn({ kind: err.kind, detail: (err as any).detail }, 'llm: échec'); throw err; }
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
      const text = withSignature(raw, sig);
      if (slots.some(a => a && a.text === text)) continue;
      if (slots.some(a => a && tooSimilar(a.text, text))) { rejected.push(`variante ${i + 1} : trop proche d’une autre`); continue; }
      const hasEmail = mentionsContactEmail(text, profile);
      if (hasEmail && emailVariants >= 2) { rejected.push(`variante ${i + 1} : email dans trop de variantes`); continue; }
      const hasReservation = mentionsReservation(text);
      if (hasReservation && reservationUsed) { rejected.push(`variante ${i + 1} : « réservez » déjà utilisé`); continue; }
      const c = checkReply(text, profile, review, { allowedStrength: strengths[i], strengthOptional: optionalStrength });
      if (c.ok) {
        slots[i] = { idx: i, text, warnings: c.warnings, words: c.words };
        if (hasEmail) emailVariants++;
        if (hasReservation) reservationUsed = true;
      } else rejected.push(`variante ${i + 1} : ${c.errors.join(', ')}`);
    }
  }
  const durationMs = Date.now() - started;
  const accepted = slots.filter((s): s is GeneratedVariant => !!s);
  if (!accepted.length) {
    // Aucun quota consommé : pas de ligne `generations` sur un échec total.
    log.warn({ rejected, inputTokens, outputTokens }, 'llm: aucune variante conforme');
    throw new LlmError('Le rédacteur n’a pas produit de réponse conforme aux règles. Réessayez dans un instant.', 'format');
  }

  const client = await pool.connect();
  let generationId = '';
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO generations (review_id, company_id, provider, model, prompt_version, input_tokens, output_tokens, duration_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [reviewId, companyId, provider.name, model, PROMPT_VERSION, inputTokens, outputTokens, durationMs]);
    generationId = rows[0].id;
    for (const v of accepted) {
      await client.query(
        `INSERT INTO reply_variants (generation_id, review_id, company_id, idx, text, warnings) VALUES ($1,$2,$3,$4,$5,$6)`,
        [generationId, reviewId, companyId, v.idx, v.text, v.warnings]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }

  // Les positions restées non conformes reviennent marquées « à revoir ».
  const variants: GeneratedVariant[] = slots.map((s, i) => s ?? { idx: i, text: '', warnings: [], words: 0, needsReview: true });
  // Journal du coût par réponse (tokens, stop_reason) — jamais le contenu de l'avis.
  log.info({ generationId, companyId, provider: provider.name, model, inputTokens, outputTokens, stopReason, durationMs, variants: accepted.length, rejected: rejected.length }, 'llm: génération');
  return { generationId, variants, usage: { inputTokens, outputTokens, model, provider: provider.name, durationMs, stopReason }, rejected };
}
