// Démo réponses multilingues : envoie 4 avis réels (en, af, de, fr) au vrai
// modèle avec la consigne de leur langue, affiche les variantes, leurs
// traductions (interface fr) et le verdict des règles par langue.
//   ANTHROPIC_API_KEY=… npx tsx scripts/llm-i18n-demo.ts
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Charge ../.env (clé dev) — jamais affichée.
try {
  const env = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* .env absent → variables déjà dans l'environnement */ }

const { AnthropicProvider } = await import('../src/llm/provider.js');
const { systemPromptFor, buildUserPromptLang, signatureOf, replyRange } = await import('../src/llm/prompt.js');
const { parseVariantsFull, cleanReply, withSignature } = await import('../src/llm/rules.js');
const { checkReplyLang } = await import('../src/llm/rulesI18n.js');
const { detectLang, LANG_NAMES } = await import('../src/llm/langdetect.js');
const { config } = await import('../src/config.js');

if (!config.llm.anthropicApiKey) { console.error('ANTHROPIC_API_KEY manquante.'); process.exit(1); }

const profile = {
  name: 'Chez Marcel', city: 'Lyon', cuisine: 'bistronomie',
  signature_name: 'Marcel', signature_role: 'patron', tone: 'chaleureux' as const,
  address_form: 'vous' as const, avoid_phrases: [],
  strengths: ['la terrasse ombragée', 'le fait maison'], practical_info: 'fermé le dimanche',
  contact_email: 'contact@chez-marcel.fr', contact_phone: '', show_phone: false,
};

const cases = [
  { label: 'anglais', body: 'The food was excellent but we waited 45 minutes for our table despite having a reservation. The waiter was very friendly though.', rating: 3 },
  { label: 'afrikaans', body: 'Die kos was heerlik maar ons het baie lank gewag vir ons etes. Die diens was vriendelik maar stadig. Ek sal nie gou terugkeer nie.', rating: 2 },
  { label: 'allemand', body: 'Das Essen war ausgezeichnet, aber die Bedienung war sehr langsam und unfreundlich. Wir mussten 40 Minuten auf unseren Tisch warten. Schade!', rating: 2 },
  { label: 'français', body: 'Cuisine excellente mais service très lent ce soir : 45 minutes d\u2019attente pour les plats malgré une réservation. Personnel souriant cela dit.', rating: 3 },
];

const provider = new AnthropicProvider();
const sig = signatureOf(profile);

for (const c of cases) {
  const detected = detectLang(c.body, 'fr').lang;
  console.log('═'.repeat(76));
  console.log(`AVIS ${c.label.toUpperCase()} (détecté : ${LANG_NAMES[detected]}) — note ${c.rating}/5`);
  console.log('─'.repeat(76));
  const review = { author_name: 'Alex', rating: c.rating, body: c.body, visited_on: null, context_tags: [], context_note: '' };
  const user = buildUserPromptLang(profile, review, [], detected)
    + '\nAlso fill translations[] with each variant translated into French for the restaurateur\u2019s internal display — same order, same count; never alter the reply text itself.';
  const t0 = Date.now();
  try {
    const res = await provider.complete(
      { system: systemPromptFor(detected), user, maxTokens: config.llm.maxOutputTokens }, new AbortController().signal);
    const { texts, translations } = parseVariantsFull(res.text);
    console.log(`(${res.inputTokens}+${res.outputTokens} jetons — ${(Date.now() - t0) / 1000 | 0}.${(Date.now() - t0) % 1000 | 0}s — ${texts.length} variantes)\n`);
    texts.forEach((raw, i) => {
      const v = withSignature(cleanReply(raw), sig);
      const r = checkReplyLang(v, profile, review, detected);
      console.log(`── variante ${i + 1} — ${r.words} mots — ${r.ok ? 'OK' : 'REJETÉE : ' + r.errors.join(' ; ')}`);
      console.log(v);
      if (translations[i]) console.log(`\n   ↳ Traduction : ${translations[i]}`);
      console.log();
    });
  } catch (e) { console.log(`ÉCHEC : ${(e as Error).message}\n`); }
}
