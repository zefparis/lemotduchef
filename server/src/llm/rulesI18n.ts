// Validation des réponses non françaises : mêmes règles que checkReply
// (rules.ts), portées sur les référentiels de langpacks.ts. Le chemin
// français n'est jamais touché — aucune régression sur le marché FR.

import { isPositive, isHealthTopic, signatureOf, replyRange, wordCount, authorDisplayName } from './prompt.js';
import type { PromptProfile, PromptReview } from './prompt.js';
import { checkReply, type RuleCheck } from './rules.js';
import { LANG_PACKS, type LangPack } from './langpacks.js';
import type { ReplyLang } from './langdetect.js';

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’‘`]/g, "'");
const countOccurrences = (hay: string, needle: string) => {
  const h = norm(hay), n = norm(needle);
  if (!n) return 0;
  return h.split(n).length - 1;
};
const EMOJI = /\p{Extended_Pictographic}/u;
const TYPO_MARKER = /[—–…]/;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const PHONE_RE = /(?<!\d)(?:\+?\d[\d\s().-]{7,14}\d)/g;

// Sujet santé en dehors du français : la case contexte prime, le texte de
// l'avis complète avec des motifs propres à chaque langue.
const HEALTH_I18N: Record<Exclude<ReplyLang, 'fr'>, RegExp> = {
  en: /allerg|food poisoning|sick|vomit|hospital|emergency|nausea|salmonella|listeria|ill after|made (me|us) (sick|ill)/i,
  af: /allerg|voedselvergiftiging|siek|naar|hospitaal|noodgeval|salmonella|gastro/i,
  de: /allerg|lebensmittelvergiftung|krank|erbrochen|übelkeit|krankenhaus|notaufnahme|salmonellen|gastro/i,
  nl: /allerg|voedselvergiftiging|ziek|overgegeven|misselijk|ziekenhuis|spoedeisend|salmonella|gastro/i,
  es: /alerg|intoxicación|enferm|vomit|náusea|hospital|urgencias|salmonella|gastroenteritis/i,
  it: /allerg|intossicazione|malat|vomit|nausea|ospedale|pronto soccorso|salmonella|gastroenterite/i,
};

// Retrait de la salutation pour les contrôles de première phrase.
function stripGreeting(nb: string, pack: LangPack): string {
  const g = pack.greeting.source;
  const re = new RegExp(`^(?:${g})[^,.!?\n]*[,.!?\n]\\s*`, 'i');
  return nb.replace(re, '');
}

function hasTriadI18n(nb: string, pack: LangPack): boolean {
  const and = pack.triadAnd;
  const re = new RegExp(`([^,.!?;:()\\n]{2,80}?),\\s*([^,.!?;:()\\n]{2,80}?)${and.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^,.!?;:()\\n]{2,80})`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(' ' + nb + ' '))) {
    const item = (s: string) => { const w = s.trim().split(/\s+/).filter(Boolean).length; return w >= 1 && w <= 8; };
    if (item(m[1]) && item(m[2]) && item(m[3]) && !pack.clauseMark.test(m[1] + ' ' + m[3])) return true;
  }
  return false;
}

export function isHealthTopicLang(r: Pick<PromptReview, 'body' | 'context_tags'>, lang: ReplyLang): boolean {
  if (lang === 'fr') return isHealthTopic(r);
  return r.context_tags.includes('health') || HEALTH_I18N[lang].test(r.body);
}

export function checkReplyLang(text: string, p: PromptProfile, r: PromptReview,
  lang: ReplyLang, opts?: { allowedStrength?: string | null }): RuleCheck {
  if (lang === 'fr') return checkReply(text, p, r, opts);
  const pack = LANG_PACKS[lang];
  const errors: string[] = [], warnings: string[] = [];
  const t = text.trim();
  const sig = signatureOf(p);
  const lines = t.split('\n').map(s => s.trim()).filter(Boolean);
  const lastLine = lines.at(-1) ?? '';
  const signed = norm(lastLine) === norm(sig);
  const bodyNoSig = (signed ? lines.slice(0, -1).join('\n') : t).trim();
  const words = wordCount(bodyNoSig);
  const range = replyRange(r);
  if (words < Math.floor(range.min * 0.85)) errors.push(`trop court (${words} mots, minimum ${range.min})`);
  else if (words > Math.ceil(range.max * 1.10)) errors.push(`trop long (${words} mots, maximum ${range.max})`);
  else if (words < range.min || words > range.max) warnings.push(`longueur hors cible (${words} mots, cible ${range.min}–${range.max})`);

  // Ouverture : salutation de la langue + prénom/marqueur si exploitable.
  const nb = norm(bodyNoSig);
  const name = authorDisplayName(r);
  const gRe = new RegExp(`^(?:${pack.greeting.source})`, 'i');
  if (!gRe.test(nb)) errors.push('ouverture différente de la salutation attendue');
  else if (name) {
    const a = norm(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const g = norm(pack.greetingWord);
    if (!new RegExp(`^${g}\\s+(?:${a}|\\[prenom\\])(?![\\p{L}\\p{N}])`, 'u').test(nb)
        && !new RegExp(`^${g}\\s+${a}(?![\\p{L}\\p{N}])`, 'u').test(nb))
      errors.push('ouverture sans le prénom de l’auteur');
  }
  // Signataire jamais cité à la 3e personne dans le corps. Un nom ou rôle
  // CONTENU dans le nom du restaurant (« Marcel » dans « Chez Marcel »)
  // n'est pas contrôlable — on le retire du contrôle.
  const reviewAndAuthor = norm(`${r.body} ${r.author_name}`);
  const pName = norm(p.name);
  for (const who of [p.signature_name, p.signature_role]
    .filter(s => s && s.trim().length > 2 && !pName.includes(norm(s).trim()))) {
    const w = norm(who).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').trim();
    if (w && new RegExp(`\\b${w}\\b`).test(nb) && !reviewAndAuthor.includes(w))
      { errors.push('signataire cité à la 3e personne'); break; }
  }
  if (!norm(t).includes(norm(sig))) errors.push('signature absente');
  else if (!signed) warnings.push('la signature n’est pas seule sur la dernière ligne');
  const nameCount = countOccurrences(bodyNoSig, p.name);
  if (p.name && nameCount > 1 && !norm(sig).includes(norm(p.name))) errors.push(`nom du restaurant répété (${nameCount} fois)`);
  if (p.city && countOccurrences(bodyNoSig, p.city) > 1) errors.push('ville répétée');

  // Interdits absolus.
  if (pack.forbidden.test(t)) errors.push('mention juridique ou accusation de mensonge');
  if (pack.informal && pack.informal.test(t) && p.address_form !== 'tu') errors.push('forme d’adresse informelle');
  if (EMOJI.test(t)) errors.push('emoji');
  if (TYPO_MARKER.test(t)) errors.push('tiret cadratin ou « … » résiduel');
  if (/!{2,}|\?{2,}/.test(t)) warnings.push('ponctuation en série');

  // Excuses : mêmes contextes qu'en français.
  const apologies = (t.match(pack.apology) ?? []).length;
  if (r.context_tags.includes('unknown_customer') && apologies > 0)
    errors.push('excuse inadaptée au contexte « jamais venu »');
  else if (!r.context_tags.includes('real_problem') && apologies > 1)
    errors.push('excuses répétées sans contexte « problème réel »');
  if (r.context_tags.includes('prices_displayed')) {
    const apo = new RegExp(pack.apology.source, 'i');
    for (const sent of t.split(/[.!?\n]+/))
      if (apo.test(sent) && pack.priceWords.test(norm(sent)))
        { errors.push('excuse portant sur les prix (contexte « prix affichés »)'); break; }
  }

  // Formules interdites (langue) puis expressions bannies du restaurateur.
  for (const b of pack.banned)
    if (norm(t).includes(norm(b))) { errors.push(`formule interdite (${b})`); break; }
  for (const b of p.avoid_phrases ?? [])
    if (norm(t).includes(norm(b))) { errors.push(`expression bannie par le restaurateur (${b})`); break; }
  if (pack.impatience.test(t)) errors.push('tournure suggérant l’impatience ou la mauvaise foi du client');
  const noGreet = stripGreeting(nb, pack);
  if (hasTriadI18n(noGreet, pack)) errors.push('énumération de trois éléments dans une même phrase (triplette)');

  if (r.body.trim() && pack.noDetail.test(t))
    errors.push('affirme à tort que l’avis ne donne aucun détail');

  const contextCorpus = norm([r.body, r.context_note, p.practical_info, ...(p.strengths ?? [])].join(' '));
  for (const [re, label] of pack.internalClaims) {
    const m = t.match(re);
    if (!m) continue;
    if (label === 'registre' && r.context_tags.includes('unknown_customer')) continue;
    if (contextCorpus.includes(norm(m[0]))) continue;
    errors.push(`fait interne inventé (« ${label} »)`);
    break;
  }
  const factsCorpus = norm([r.body, r.context_note, ...r.context_tags].join(' '));
  if (pack.warned.test(nb) && !r.context_tags.includes('wait_announced') && !pack.factsHint.test(factsCorpus))
    errors.push('fait affirmé non fourni par l’avis ou le contexte');
  if (pack.blame.test(nb))
    errors.push('tournure de reproche envers le client');
  const firstSent = noGreet.split(/[.!?\n]+/)[0] ?? '';
  if (pack.firstSentFact.test(firstSent))
    errors.push('explication (attente annoncée, salle complète) en première phrase');

  if (pack.surprise.test(t) && !r.context_tags.some(tg => tg === 'unknown_customer' || tg === 'dish_as_described'))
    errors.push('« surpris » réservé aux contextes « jamais venu » ou « plat conforme »');
  if (pack.analysisLeak.test(t)) errors.push('analyse interne recopiée');

  // Points forts : au plus un, celui suggéré à cette variante.
  const strengths = (p.strengths ?? []).filter(s => s && countOccurrences(t, s) > 0);
  if (strengths.length > 1) errors.push(`plusieurs points forts cités (${strengths.slice(0, 2).join(', ')})`);
  else if (opts?.allowedStrength === null && strengths.length) errors.push('point fort non demandé dans la variante factuelle');
  else if (typeof opts?.allowedStrength === 'string' && strengths.some(s => s !== opts.allowedStrength))
    errors.push(`point fort non attribué à cette variante (« ${opts.allowedStrength} » suggéré)`);

  // Données personnelles : email du profil seul ; téléphone seulement si
  // l'option du profil l'autorise.
  const key = (s: string) => s.replace(/[\s.()-]/g, '').toLowerCase();
  const allowedEmails = new Set([p.contact_email].filter(Boolean).map(key));
  const allowedPhones = new Set((p.show_phone ? [p.contact_phone] : []).filter(Boolean).map(key));
  let hasContactEmail = false;
  for (const m of t.match(EMAIL_RE) ?? []) {
    if (allowedEmails.has(key(m.replace(/[.,;:)]+$/, '')))) hasContactEmail = true;
    else errors.push(`email étranger au profil (${m})`);
  }
  for (const m of t.match(PHONE_RE) ?? []) {
    if (allowedPhones.has(key(m))) continue;
    if (key(p.contact_phone) && key(m) === key(p.contact_phone)) errors.push('téléphone affiché sans que l’option du profil soit activée');
    else errors.push('numéro de téléphone étranger au profil');
  }
  if (hasContactEmail && !pack.contactInvite.test(t.replace(EMAIL_RE, '')))
    errors.push('email cité sans invitation à un échange privé');

  // Liens : aucune URL ni nom de domaine dans une réponse publique.
  const sansEmail = t.replace(EMAIL_RE, '');
  if (/https?:\/\/|www\./i.test(sansEmail)
    || /\b[a-z0-9][a-z0-9-]*\.(?:com|fr|net|org|io|dev|co|eu|info|biz|site|online|shop|app|rest|restaurant)\b/i.test(sansEmail))
    errors.push('lien ou nom de domaine dans la réponse');

  // Santé : pas d'aveu de responsabilité, contact privé obligatoire, jamais
  // d'invitation à revenir ou à réserver.
  const health = isHealthTopicLang(r, lang);
  if (health) {
    if (pack.admission.test(t)) errors.push('reconnaissance de responsabilité sur un sujet santé');
    if (pack.returnInvite.test(t) || /r[ée]serv|reserv|book|booked|booking|boek|reserviert/i.test(t))
      errors.push('sujet santé : jamais d’invitation à revenir ou à réserver');
    if (!pack.contactInvite.test(t)) errors.push('sujet santé sans invitation à un contact privé');
  }
  if (!isPositive(r.rating) && !health && !pack.returnInvite.test(t))
    errors.push('avis négatif sans invitation à revenir ou à reprendre contact');
  if (!isPositive(r.rating) && pack.commercialGesture.test(t)) warnings.push('geste commercial ou remboursement évoqué — à vérifier');

  return { ok: errors.length === 0, errors, warnings, words };
}
