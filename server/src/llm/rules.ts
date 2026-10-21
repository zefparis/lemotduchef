import { isPositive, isHealthTopic, signatureOf, POSITIVE_WORDS, NEGATIVE_WORDS } from './prompt.js';
import type { PromptProfile, PromptReview } from './prompt.js';

// Vérification mécanique des réponses produites par le LLM. Une variante qui
// viole une règle « dure » est écartée ; les avertissements sont renvoyés au
// front pour information (le restaurateur relit toujours avant de publier).

export interface RuleCheck { ok: boolean; errors: string[]; warnings: string[]; words: number }

export const wordCount = (s: string) => (s.trim().match(/[\p{L}\p{N}’'-]+/gu) ?? []).length;
const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const countOccurrences = (hay: string, needle: string) => {
  if (!needle) return 0;
  const h = norm(hay), n = norm(needle);
  let i = 0, c = 0;
  while ((i = h.indexOf(n, i)) !== -1) { c++; i += n.length; }
  return c;
};

const FORBIDDEN = /\b(menteur|menteuse|mensonge|mensonger|vous mentez|diffamation|diffamatoire|tribunal|avocat|plainte|poursuite|poursuivre|judiciaire|justice|proces|procès|huissier|police|gendarmerie)\b/i;
const TUTOIEMENT = /\b(tu|t'as|t'es|toi)\b/i;
const EMOJI = /\p{Extended_Pictographic}/u;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const PHONE_RE = /(?:\+33\s?|0)[1-9](?:[\s.-]?\d{2}){4}/g;
const ADMISSION = /\b(notre faute|de notre fait|notre responsabilite|notre responsabilité|nous sommes responsables|nous reconnaissons|nous admettons|nous avouons|c'est de notre faute)\b/i;
const CONTACT_INVITE = /(contact|joindre|appeler|ecrire|écrire|telephon|téléphon|email|e-mail|mail|échanger|echanger)/i;
const COMMERCIAL_GESTURE = /(rembours|offert|offr(?:ir|ons|e)\b|gratuit|geste commercial|bon d'achat|dédommag|dedommag)/i;

export function checkReply(text: string, p: PromptProfile, r: PromptReview): RuleCheck {
  const errors: string[] = [], warnings: string[] = [];
  const t = text.trim();
  const words = wordCount(t);
  const range = isPositive(r.rating) ? POSITIVE_WORDS : NEGATIVE_WORDS;
  // Longueur : rejet au-delà d'une tolérance de 15 % (le LLM n'est pas un compteur exact).
  if (words < Math.floor(range.min * 0.85)) errors.push(`trop court (${words} mots, minimum ${range.min})`);
  else if (words > Math.ceil(range.max * 1.15)) errors.push(`trop long (${words} mots, maximum ${range.max})`);
  else if (words < range.min || words > range.max) warnings.push(`longueur hors cible (${words} mots, cible ${range.min}–${range.max})`);

  // Signature : présente, en fin de texte.
  const sig = signatureOf(p);
  const lastLine = t.split('\n').map(s => s.trim()).filter(Boolean).at(-1) ?? '';
  if (!norm(t).includes(norm(sig))) errors.push('signature absente');
  else if (norm(lastLine) !== norm(sig)) warnings.push('la signature n’est pas seule sur la dernière ligne');

  // Nom du restaurant et ville : au plus une fois chacun (hors signature).
  const bodyNoSig = t.slice(0, Math.max(0, norm(t).lastIndexOf(norm(sig))));
  const nameCount = countOccurrences(bodyNoSig, p.name);
  if (p.name && nameCount > 1 && !norm(sig).includes(norm(p.name))) errors.push(`nom du restaurant répété (${nameCount} fois)`);
  if (p.city && countOccurrences(bodyNoSig, p.city) > 1) errors.push('ville répétée');

  // Interdits absolus.
  if (FORBIDDEN.test(t)) errors.push('mention juridique ou accusation de mensonge');
  if (TUTOIEMENT.test(t)) errors.push('tutoiement');
  if (EMOJI.test(t)) errors.push('emoji');
  if (/!{2,}|\?{2,}/.test(t)) warnings.push('ponctuation en série');

  // Données personnelles : aucun email / téléphone autre que ceux du profil.
  const key = (s: string) => s.replace(/[\s.()-]/g, '').toLowerCase();
  const allowed = new Set([p.contact_email, p.contact_phone].filter(Boolean).map(key));
  for (const m of t.match(EMAIL_RE) ?? []) if (!allowed.has(key(m.replace(/[.,;:)]+$/, '')))) errors.push(`email étranger au profil (${m})`);
  for (const m of t.match(PHONE_RE) ?? []) if (!allowed.has(key(m))) errors.push('numéro de téléphone étranger au profil');

  // Santé : pas d'aveu de responsabilité, invitation au contact privé.
  if (isHealthTopic(r)) {
    if (ADMISSION.test(t)) errors.push('reconnaissance de responsabilité sur un sujet santé');
    if (!CONTACT_INVITE.test(t)) errors.push('sujet santé sans invitation à un contact privé');
  }
  if (!isPositive(r.rating) && COMMERCIAL_GESTURE.test(t)) warnings.push('geste commercial ou remboursement évoqué — à vérifier');

  return { ok: errors.length === 0, errors, warnings, words };
}

// Extraction tolérante du JSON {"variants":[…]} renvoyé par le modèle.
export function parseVariants(raw: string): string[] {
  const cleaned = raw.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{'), end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) return [];
  try {
    const obj = JSON.parse(cleaned.slice(start, end + 1));
    const arr = Array.isArray(obj?.variants) ? obj.variants : [];
    return arr.filter((v: unknown) => typeof v === 'string' && v.trim()).map((v: string) => v.trim());
  } catch { return []; }
}
