import { pool } from '../db.js';
import { config } from '../config.js';
import { llmProvider, LlmError } from './provider.js';
import { effectivePlan, FREE_MONTHLY_LIMIT } from '../stripe.js';
import { SYSTEM_PROMPT, PROMPT_VERSION, buildUserPrompt, signatureOf, assignedStrengths, authorDisplayName, AUTHOR_MARKER, isHealthTopic } from './prompt.js';
import type { PromptProfile, PromptReview } from './prompt.js';
import { checkReply, parseVariants, tooSimilar, cleanReply, withSignature, mentionsContactEmail, mentionsReservation } from './rules.js';

// Quota mensuel épuisé (réservation refusée dans la transaction atomique).
export class QuotaExceededError extends Error {}

// Erreurs jamais affichées au restaurateur : fait non fourni, divulgation de
// coordonnées, mention juridique, responsabilité santé, fuite d'analyse
// interne. Tout autre motif est un défaut de style affichable « à relire ».
const HARD_ERROR_RE = /étranger|domaine|lien|juridique|mensonge|responsabilité|affirmé non fourni|affirme à tort|inventé|analyse interne/i;

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
  let fixCalls = 0; // budget d'appels de correction par génération
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
      // Tout ce qui part au modèle (génération ET corrections) garde le
      // marqueur [PRÉNOM] ; le nom réel n'est réinséré qu'à l'affichage.
      const textM = withSignature(cleanReply(raw), sig);
      const disp = (t: string) => applyAuthor(t);
      if (slots.some(a => a && a.text === disp(textM))) continue;
      // La similarité ne se mesure que sur les variantes conformes : une
      // variante « à relire » affichée quand même ne doit pas bloquer les
      // positions suivantes.
      if (slots.some(a => a && !a.needsReview && tooSimilar(a.text, disp(textM)))) { rejected.push(`variante ${i + 1} : trop proche d’une autre`); continue; }
      const hasEmail0 = mentionsContactEmail(textM, profile);
      if (hasEmail0 && emailVariants >= 2) { rejected.push(`variante ${i + 1} : email dans trop de variantes`); continue; }
      const hasReservation0 = mentionsReservation(textM);
      if (hasReservation0 && reservationUsed) { rejected.push(`variante ${i + 1} : « réservez » déjà utilisé`); continue; }
      let cur = textM;
      let c = checkReply(cur, profile, effectiveReview, { allowedStrength: strengths[i] });
      // Réécriture ciblée : jusqu'à 2 essais pour corriger les règles enfreintes
      // (style corrigible comme erreur factuelle/divulgation), même sens et
      // même ton. L'avis est rappelé pour garder la factualité ; le marqueur
      // [PRÉNOM] est conservé — jamais le nom réel dans un appel LLM.
      for (let fix = 0; !c.ok && fix < 2 && fixCalls < 6; fix++, fixCalls++) {
        const hints = c.errors.map(e =>
          /triplette/.test(e) ? 'traite un seul point par phrase, jamais trois éléments alignés'
          : /invitation/.test(e) ? 'termine par une invitation chaleureuse à revenir ou à reprendre contact'
          : /formule interdite/.test(e) ? 'remplace la tournure bannie par une formulation naturelle et personnelle'
          : /excuse|explication/.test(e) ? 'commence par reconnaître le problème du client, pas par une excuse ou une explication'
          : /tutoiement/.test(e) ? 'vouvoie le client partout'
          : /étranger|domaine|lien/.test(e) ? 'retire toute coordonnée ou lien non autorisé'
          : /juridique|mensonge|responsabilité|affirmé|affirme à tort/.test(e) ? 'retire toute affirmation de fait non fournie par l’avis et toute mention juridique'
          : null).filter(Boolean).join(' ; ');
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), config.llm.timeoutMs);
        try {
          const r2 = await provider.complete({
            system: 'Tu corriges une réponse de restaurateur à un avis Google en respectant les règles énoncées, sans perdre le sens ni le ton. Écris « [PRÉNOM] » tel quel pour le prénom du client.',
            // Contexte complet : la correction reste ancrée dans les faits
            // autorisés, le ton et les règles du restaurant.
            user: `Contexte : ton ${profile.tone} ; ${profile.address_form === 'tu' ? 'tutoiement' : 'vouvoiement'} du client ; signature « ${sig} » ; restaurant « ${profile.name} » (${profile.city}).${review.context_note ? ` Faits autorisés : ${review.context_note}.` : ''}${profile.practical_info ? ` Infos pratiques : ${profile.practical_info}.` : ''}${profile.contact_email ? ` Contact autorisé : ${profile.contact_email}.` : ''}${isHealthTopic(review) ? ' Sujet santé : inviter à un contact privé, aucune reconnaissance de responsabilité.' : ''}${strengths[i] ? ` La réponse peut citer « ${strengths[i]} ».` : ''}\nAvis (${review.rating}/5) : «${review.body.slice(0, 400)}»\n\nCorrige cette réponse. Problèmes : ${c.errors.join(' ; ')}.${hints ? ` Corrections à appliquer : ${hints}.` : ''} Réécris-la, même sens, même ton, sans signature ni salutation finale :\n\n«${cur}»`,
            maxTokens: 400,
          }, ctrl.signal);
          inputTokens += r2.inputTokens; outputTokens += r2.outputTokens;
          const cand = withSignature(cleanReply(JSON.parse(r2.text).variants?.[0] ?? r2.text), sig);
          const c2 = checkReply(cand, profile, effectiveReview, { allowedStrength: strengths[i] });
          if (c2.ok || c2.errors.length < c.errors.length) { cur = cand; c = c2; }
        } catch { break; }
        finally { clearTimeout(timer); }
      }
      // Contrôles collectifs relancés sur le texte final (la correction peut
      // avoir introduit un doublon, un email ou « réservez » en trop).
      if (slots.some(a => a && a.text === disp(cur))) continue;
      if (slots.some(a => a && !a.needsReview && tooSimilar(a.text, disp(cur)))) { rejected.push(`variante ${i + 1} : trop proche d’une autre`); continue; }
      const hasEmail = mentionsContactEmail(cur, profile);
      if (hasEmail && emailVariants >= 2) { rejected.push(`variante ${i + 1} : email dans trop de variantes`); continue; }
      const hasReservation = mentionsReservation(cur);
      if (hasReservation && reservationUsed) { rejected.push(`variante ${i + 1} : « réservez » déjà utilisé`); continue; }
      if (!c.ok) {
        rejected.push(`variante ${i + 1} : ${c.errors.join(', ')}`);
        // Erreur factuelle, divulgation ou mention juridique : jamais
        // affichée, même « à relire ». Défaut de style seul : affichée
        // éditable avec le motif — le restaurateur décide.
        if (!HARD_ERROR_RE.test(c.errors.join(' '))) {
          slots[i] = { idx: i, text: disp(cur), warnings: [...c.warnings, ...c.errors.map(e => `à relire : ${e}`)], words: c.words, needsReview: true };
        }
        continue;
      }
      slots[i] = { idx: i, text: disp(cur), warnings: c.warnings, words: c.words };
      if (hasEmail) emailVariants++;
      if (hasReservation) reservationUsed = true;
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
        `INSERT INTO reply_variants (generation_id, review_id, company_id, idx, text, warnings, needs_review) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [generationId, reviewId, companyId, v.idx, v.text, v.warnings, v.needsReview === true]);
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
