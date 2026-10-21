// Relecture manuelle : envoie les 6 cas typiques au vrai modèle et affiche les
// variantes avec le résultat des règles automatiques.
//   ANTHROPIC_API_KEY=… npm run llm:sample
// Aucune écriture en base : l'appel se fait directement au fournisseur.
import { AnthropicProvider } from '../src/llm/provider.js';
import { SYSTEM_PROMPT, PROMPT_VERSION, buildUserPrompt, replyRange } from '../src/llm/prompt.js';
import { checkReply, parseVariants, tooSimilar } from '../src/llm/rules.js';
import { SAMPLE_CASES } from '../src/llm/sampleCases.js';
import { config } from '../src/config.js';

if (!config.llm.anthropicApiKey) {
  console.error('ANTHROPIC_API_KEY manquante — ce script appelle le vrai modèle.');
  process.exit(1);
}

const provider = new AnthropicProvider();
console.log(`Modèle : ${config.llm.model} — prompt ${PROMPT_VERSION}\n`);

for (const c of SAMPLE_CASES) {
  const range = replyRange(c.review);
  console.log('═'.repeat(72));
  console.log(`CAS « ${c.label} » — note ${c.review.rating}/5 — cible ${range.min}–${range.max} mots`);
  console.log(`Avis : ${c.review.body || '(sans texte)'}${c.review.context_tags.length ? ` — contexte : ${c.review.context_tags.join(', ')}` : ''}`);
  console.log('─'.repeat(72));
  try {
    const res = await provider.complete(
      { system: SYSTEM_PROMPT, user: buildUserPrompt(c.profile, c.review, []), maxTokens: config.llm.maxOutputTokens },
      new AbortController().signal,
    );
    const vs = parseVariants(res.text);
    console.log(`(${res.inputTokens} + ${res.outputTokens} tokens — ${vs.length} variantes)\n`);
    vs.forEach((v, i) => {
      const r = checkReply(v, c.profile, c.review);
      const dup = i > 0 && vs.slice(0, i).some(a => tooSimilar(a, v));
      console.log(`── variante ${i + 1} — ${r.words} mots — ${r.ok ? 'OK' : 'REJETÉE : ' + r.errors.join(', ')}${dup ? ' — TROP PROCHE d’une autre' : ''}${r.warnings.length ? ` (avert.: ${r.warnings.join(', ')})` : ''}`);
      console.log(v + '\n');
    });
  } catch (err) {
    console.log(`ÉCHEC : ${(err as Error).message}\n`);
  }
}
