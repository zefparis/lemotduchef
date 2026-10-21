import { pool } from '../db.js';
import { config } from '../config.js';
import { llmProvider, LlmError } from './provider.js';
import { SYSTEM_PROMPT, PROMPT_VERSION, buildUserPrompt } from './prompt.js';
import type { PromptProfile, PromptReview } from './prompt.js';
import { checkReply, parseVariants } from './rules.js';

export interface GeneratedVariant { idx: number; text: string; warnings: string[]; words: number }
export interface GenerationOutcome {
  generationId: string;
  variants: GeneratedVariant[];
  usage: { inputTokens: number; outputTokens: number; model: string; provider: string; durationMs: number };
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
  const user = buildUserPrompt(profile, review, avoid);
  const started = Date.now();
  let inputTokens = 0, outputTokens = 0, model = config.llm.model;
  const accepted: GeneratedVariant[] = [];
  const rejected: string[] = [];

  // Deux tentatives maximum : la seconde ne se produit que si moins de 3
  // variantes valides sont obtenues (format ou règles).
  for (let attempt = 0; attempt < 2 && accepted.length < 3; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), config.llm.timeoutMs);
    let res;
    try {
      res = await provider.complete({
        system: SYSTEM_PROMPT,
        user: attempt === 0 ? user : user + '\n\nRAPPEL : respecte la longueur, la signature seule en dernière ligne et le JSON strict.',
        maxTokens: config.llm.maxOutputTokens,
        temperature: attempt === 0 ? 0.8 : 0.6,
      }, ctrl.signal);
    } catch (err) {
      clearTimeout(timer);
      if (accepted.length) break; // on garde ce qu'on a
      if (err instanceof LlmError) { log.warn({ kind: err.kind, detail: (err as any).detail }, 'llm: échec'); throw err; }
      throw new LlmError('Génération impossible pour le moment.', 'upstream');
    }
    clearTimeout(timer);
    inputTokens += res.inputTokens; outputTokens += res.outputTokens; model = res.model;
    const texts = parseVariants(res.text);
    if (!texts.length) { rejected.push('réponse du modèle illisible (JSON attendu)'); continue; }
    for (const text of texts) {
      if (accepted.length >= 3) break;
      if (accepted.some(a => a.text === text)) continue;
      const c = checkReply(text, profile, review);
      if (c.ok) accepted.push({ idx: accepted.length, text, warnings: c.warnings, words: c.words });
      else rejected.push(c.errors.join(', '));
    }
  }
  const durationMs = Date.now() - started;
  if (!accepted.length) {
    log.warn({ rejected, inputTokens, outputTokens }, 'llm: aucune variante conforme');
    // Le coût est journalisé même sans résultat exploitable.
    await pool.query(
      `INSERT INTO generations (review_id, company_id, provider, model, prompt_version, input_tokens, output_tokens, duration_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [reviewId, companyId, provider.name, model, PROMPT_VERSION, inputTokens, outputTokens, durationMs]);
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

  // Journal du coût par réponse (tokens) — jamais le contenu de l'avis.
  log.info({ generationId, companyId, provider: provider.name, model, inputTokens, outputTokens, durationMs, variants: accepted.length, rejected: rejected.length }, 'llm: génération');
  return { generationId, variants: accepted, usage: { inputTokens, outputTokens, model, provider: provider.name, durationMs }, rejected };
}
