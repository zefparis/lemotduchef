// Relecture manuelle : envoie les cas typiques au vrai modèle et affiche les
// variantes (signature ajoutée par le code, comme en production) avec le
// résultat des règles automatiques, le stop_reason et le coût.
//   ANTHROPIC_API_KEY=… npm run llm:sample
// Aucune écriture en base : l'appel se fait directement au fournisseur.
import { AnthropicProvider } from '../src/llm/provider.js';
import { SYSTEM_PROMPT, PROMPT_VERSION, buildUserPrompt, replyRange, signatureOf, reviewCategories } from '../src/llm/prompt.js';
import { checkReply, parseVariants, tooSimilar, withSignature, citedStrengths, mentionsContactEmail, mentionsReservation } from '../src/llm/rules.js';
import { SAMPLE_CASES } from '../src/llm/sampleCases.js';
import { config } from '../src/config.js';

if (!config.llm.anthropicApiKey) {
  console.error('ANTHROPIC_API_KEY manquante — ce script appelle le vrai modèle.');
  process.exit(1);
}

const provider = new AnthropicProvider();
const sig = signatureOf(SAMPLE_CASES[0].profile);
console.log(`Modèle : ${config.llm.model} — prompt ${PROMPT_VERSION}\n`);

for (const c of SAMPLE_CASES) {
  const range = replyRange(c.review);
  console.log('═'.repeat(72));
  console.log(`CAS « ${c.label} » — note ${c.review.rating}/5 — cible ${range.min}–${range.max} mots — nature : ${reviewCategories(c.review.body).join(' + ') || '—'}`);
  console.log(`Avis : ${c.review.body || '(sans texte)'}${c.review.context_tags.length ? ` — contexte : ${c.review.context_tags.join(', ')}` : ''}`);
  console.log('─'.repeat(72));
  const started = Date.now();
  try {
    const res = await provider.complete(
      { system: SYSTEM_PROMPT, user: buildUserPrompt(c.profile, c.review, []), maxTokens: config.llm.maxOutputTokens },
      new AbortController().signal,
    );
    const ms = Date.now() - started;
    const raw = parseVariants(res.text);
    const vs = raw.map(v => withSignature(v, sig));
    console.log(`(${res.inputTokens} + ${res.outputTokens} jetons — stop_reason=${res.stopReason || '—'} — ${(ms / 1000).toFixed(1)} s — ${vs.length} variantes)\n`);
    const usedStrengths = new Set<string>(); let emails = 0; let reserved = false;
    vs.forEach((v, i) => {
      const r = checkReply(v, c.profile, c.review);
      const dup = i > 0 && vs.slice(0, i).some(a => tooSimilar(a, v));
      const str = citedStrengths(v, c.profile);
      const repeatedStrength = str.some(s => usedStrengths.has(s));
      const hasEmail = mentionsContactEmail(v, c.profile);
      const hasResa = mentionsReservation(v);
      const notes = [
        r.ok ? 'OK' : 'REJETÉE : ' + r.errors.join(', '),
        dup ? 'TROP PROCHE d’une autre' : '',
        repeatedStrength ? `point fort déjà utilisé (${str.join(', ')})` : '',
        hasEmail && emails >= 2 ? 'email dans trop de variantes' : '',
        hasResa && reserved ? '« réservez » répété' : '',
        r.warnings.length ? `avert.: ${r.warnings.join(', ')}` : '',
      ].filter(Boolean).join(' — ');
      str.forEach(s => usedStrengths.add(s)); if (hasEmail) emails++; if (hasResa) reserved = true;
      console.log(`── variante ${i + 1} — ${r.words} mots — ${notes}`);
      console.log(v + '\n');
    });
  } catch (err) {
    console.log(`ÉCHEC : ${(err as Error).message}\n`);
  }
}
