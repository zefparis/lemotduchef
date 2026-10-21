import { isPositive, isHealthTopic, signatureOf, replyRange, wordCount } from './prompt.js';
import type { PromptProfile, PromptReview } from './prompt.js';

// Vérification mécanique des réponses produites par le LLM. Une variante qui
// viole une règle « dure » est écartée ; les avertissements sont renvoyés au
// front pour information (le restaurateur relit toujours avant de publier).

export interface RuleCheck { ok: boolean; errors: string[]; warnings: string[]; words: number }

export { wordCount };
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
// Formules trop génériques, interdites par la consigne (comparées normalisées).
const BANNED_PHRASES = [
  'sincèrement désolés', 'sincèrement désolé', 'nous prenons votre avis au sérieux',
  'nous prenons votre message au sérieux', 'votre avis compte', 'nous sommes navrés',
];
// Regrets / excuses : franches uniquement si le contexte « problème réel » est
// coché ; sinon au plus une occurrence.
const APOLOGY_RE = /(nous (sommes |serions |vous sommes )?(sincèrement |vraiment )?désolé|nous (vous )?(présentons|adressons|offrons) nos (plus |sincères )?excuses|toutes nos excuses|nous nous excusons|veuillez (accepter|recevoir|croire à|agréer) nos (sincères |plus sincères )?(excuses|regrets)|nous (le |la |les |vous )?regrettons|nous sommes navrés|je (vous )?(regrette|m'excuse|présente mes (plus |sincères )?excuses))/gi;
// L'avis contient des mots : prétendre le contraire est un mensonge visible.
const NO_DETAIL_RE = /(ne (nous )?(donne|donnez|laisse|apporte) (aucun|pas de|guère de|que peu de) détails?|sans (aucun |le moindre )?détail|aucun détail|pas de détail|aucune précision|sans précision|peu (détaillé|de détails?)|manque de détails?|avis (vide|sans texte|sans commentaire)|commentaire (vide|absent)|ne détaille pas|sans explication|aucune explication)/i;

// Aliments et plats courants : un de ces mots dans la réponse doit figurer dans
// l'avis ou le profil — sinon c'est une invention (la plaie du « de la pâte aux
// garnitures » sur un avis qui parlait de l'attente).
const FOOD_WORDS = new Set([
  'pate', 'pizza', 'pizze', 'risotto', 'lasagne', 'ravioli', 'gnocchi', 'spaghetti', 'tagliatelle',
  'burger', 'sushi', 'maki', 'sashimi', 'tartare', 'carpaccio', 'ceviche', 'paella', 'couscous',
  'raclette', 'fondue', 'tartiflette', 'cassoulet', 'bouillabaisse', 'bourguignon', 'blanquette',
  'quiche', 'crepe', 'galette', 'nem', 'samoussa', 'kebab', 'tacos', 'bagel', 'falafel', 'houmous',
  'taboule', 'entrecote', 'steak', 'magret', 'confit', 'escargot', 'moule', 'huitre', 'homard',
  'langoustine', 'crevette', 'saumon', 'thon', 'cabillaud', 'sole', 'daurade', 'truite', 'sardine',
  'anchois', 'poulet', 'volaille', 'canard', 'agneau', 'porc', 'boeuf', 'veau', 'lapin', 'gibier',
  'boudin', 'andouillette', 'saucisse', 'merguez', 'chorizo', 'jambon', 'terrine', 'rillette',
  'fromage', 'chevre', 'camembert', 'comte', 'roquefort', 'mozzarella', 'parmesan', 'burrata',
  'oeuf', 'omelette', 'soupe', 'veloute', 'consomme', 'potage', 'salade', 'frite', 'puree',
  'gratin', 'riz', 'quinoa', 'lentille', 'legume', 'truffe', 'cepe', 'champignon', 'garniture',
  'tiramisu', 'mousse', 'moelleux', 'fondant', 'crumble', 'tarte', 'tartelette', 'clafoutis',
  'creme', 'caramel', 'chocolat', 'vanille', 'fraisier', 'eclair', 'profiterole', 'macaron',
  'gateau', 'cookie', 'brownie', 'glace', 'sorbet', 'yaourt', 'pomme', 'poire', 'fraise',
  'framboise', 'citron', 'cafe', 'expresso', 'cappuccino', 'the', 'vin', 'champagne', 'biere',
  'cocktail', 'aperitif', 'digestif', 'jus', 'pain', 'baguette', 'croissant', 'brioche',
  'viennoiserie', 'brunch', 'dessert', 'entremet', 'sorbet', 'amuse-bouche', 'bouchee',
]);
const FOOD_PHRASES = [
  'foie gras', 'creme brulee', 'riz au lait', 'fruits de mer', 'petit dejeuner', 'tarte tatin',
  'pain perdu', 'steak tartare', 'pot au feu', 'saumon fume', 'filet mignon', 'amuse bouche',
];
const foodMentions = (text: string, known: string): string[] => {
  const hits = new Set<string>();
  const nt = norm(text);
  const tokens = nt.match(/[a-z]+(?:-[a-z]+)?/g) ?? [];
  for (const tok of tokens) {
    for (const w of [tok, tok.replace(/s$/, ''), tok.replace(/x$/, '')]) {
      if (FOOD_WORDS.has(w) && !known.includes(w)) { hits.add(tok); break; }
    }
  }
  for (const ph of FOOD_PHRASES) if (nt.includes(ph) && !known.includes(ph)) hits.add(ph);
  return [...hits];
};

export function checkReply(text: string, p: PromptProfile, r: PromptReview): RuleCheck {
  const errors: string[] = [], warnings: string[] = [];
  const t = text.trim();
  const words = wordCount(t);
  const range = replyRange(r);
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

  // Posture : excuses franches seulement si « problème réel » est coché ;
  // sinon au plus une formule de regret légère.
  const apologies = (t.match(APOLOGY_RE) ?? []).length;
  if (!r.context_tags.includes('real_problem') && apologies > 1)
    errors.push('excuses répétées sans contexte « problème réel »');

  // Formules génériques interdites par la consigne.
  for (const b of BANNED_PHRASES)
    if (norm(t).includes(norm(b))) { errors.push(`formule interdite (${b})`); break; }
  if (countOccurrences(t, 'au plaisir') > 1) errors.push('« au plaisir » répété dans la même réponse');

  // Dire « l'avis ne donne pas de détail » alors qu'il en contient : faux.
  if (r.body.trim() && NO_DETAIL_RE.test(t))
    errors.push('affirme à tort que l’avis ne donne aucun détail');

  // Plats et aliments : tout mot culinaire cité doit venir de l'avis ou du profil.
  const known = norm([r.body, p.name, p.city, p.cuisine, p.practical_info, ...(p.strengths ?? [])].join(' '));
  const invented = foodMentions(t, known);
  if (invented.length) errors.push(`plat ou aliment inventé (${invented.slice(0, 3).join(', ')})`);

  // Données personnelles : aucun email autre que celui du profil ; le
  // téléphone n'est autorisé que si le restaurateur l'affiche (show_phone).
  const key = (s: string) => s.replace(/[\s.()-]/g, '').toLowerCase();
  const allowedEmails = new Set([p.contact_email].filter(Boolean).map(key));
  const allowedPhones = new Set((p.show_phone ? [p.contact_phone] : []).filter(Boolean).map(key));
  for (const m of t.match(EMAIL_RE) ?? []) if (!allowedEmails.has(key(m.replace(/[.,;:)]+$/, '')))) errors.push(`email étranger au profil (${m})`);
  for (const m of t.match(PHONE_RE) ?? []) {
    if (allowedPhones.has(key(m))) continue;
    if (key(p.contact_phone) && key(m) === key(p.contact_phone)) errors.push('téléphone affiché sans que l’option du profil soit activée');
    else errors.push('numéro de téléphone étranger au profil');
  }

  // Santé : pas d'aveu de responsabilité, invitation au contact privé.
  if (isHealthTopic(r)) {
    if (ADMISSION.test(t)) errors.push('reconnaissance de responsabilité sur un sujet santé');
    if (!CONTACT_INVITE.test(t)) errors.push('sujet santé sans invitation à un contact privé');
  }
  if (!isPositive(r.rating) && COMMERCIAL_GESTURE.test(t)) warnings.push('geste commercial ou remboursement évoqué — à vérifier');

  return { ok: errors.length === 0, errors, warnings, words };
}

// Diversité : deux variantes sont « trop proches » si elles s'ouvrent sur la
// même première phrase (salutation « Bonjour … » ignorée) ou si plus de 40 %
// de leurs mots sont communs (Jaccard sur les ensembles de mots normalisés).
const GREETING_RE = /^(bonjour|bonsoir|ch[eè]re?|madame|monsieur)\b[^,.!?\n]*[,.!?\n]\s*/i;
const firstSentence = (s: string) => {
  const bare = s.trim().replace(GREETING_RE, '');
  return norm(bare.split(/[.!?\n]/)[0] ?? '');
};
const tokenSet = (s: string) => new Set(norm(s).match(/[a-z0-9]+/g) ?? []);
export function tooSimilar(a: string, b: string): boolean {
  const fa = firstSentence(a), fb = firstSentence(b);
  if (fa && fa === fb) return true;
  const A = tokenSet(a), B = tokenSet(b);
  const inter = [...A].filter(w => B.has(w)).length;
  const union = A.size + B.size - inter;
  return union > 0 && inter / union > 0.4;
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
