import { isPositive, isHealthTopic, signatureOf, replyRange, wordCount, authorDisplayName, CONTEXT_TAGS } from './prompt.js';
import type { PromptProfile, PromptReview, ContextTag } from './prompt.js';

// Vérification mécanique des réponses produites par le LLM. Une variante qui
// viole une règle « dure » est écartée ; les avertissements sont renvoyés au
// front pour information (le restaurateur relit toujours avant de publier).

export interface RuleCheck { ok: boolean; errors: string[]; warnings: string[]; words: number }

export { wordCount };
const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[’‘`]/g, "'");
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
// Marqueurs typographiques typiques des réponses générées : tirets cadratin et
// demi-cadratin, caractère « … ». Nettoyés par cleanReply ; leur présence à la
// sortie est une erreur (filet de sécurité).
const TYPO_MARKER = /[—–…]/;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const PHONE_RE = /(?:\+33\s?|0)[1-9](?:[\s.-]?\d{2}){4}/g;
const ADMISSION = /\b(notre faute|de notre fait|notre responsabilite|notre responsabilité|nous sommes responsables|nous reconnaissons|nous admettons|nous avouons|c'est de notre faute)\b/i;
const CONTACT_INVITE = /(contact|joign|joind|appel|ecri|écri|telephon|téléphon|email|e-mail|mail|échang|echang|vive voix|en privé|en direct)/i;
const COMMERCIAL_GESTURE = /(rembours|offert|offr(?:ir|ons|e)\b|gratuit|geste commercial|bon d'achat|dédommag|dedommag)/i;
// Formules trop génériques ou désinvoltes, interdites par la consigne
// (comparées normalisées : accents et apostrophes neutralisés).
const BANNED_PHRASES = [
  'sincèrement désolés', 'sincèrement désolé', 'nous prenons votre avis au sérieux',
  'nous prenons votre message au sérieux', 'votre avis compte', 'nous sommes navrés',
  'ce ressenti', 'votre ressenti', 'nous tenons à préciser', 'en connaissance de cause',
  "mérite d'être savouré", 'sans précipitation', 'n’hésitez pas', 'n’hésite pas',
  'merci d’avoir pris le temps', 'remercie d’avoir pris le temps', 'remercions d’avoir pris le temps',
  'votre avis me touche', 'je comprends votre déception',
  'j’entends votre déception', 'en toute transparence',
  'sincèrement', 'inacceptable', 'rédhibitoire',
];
// Tournures qui laissent entendre que le client est impatient ou de mauvaise foi.
const IMPATIENCE_RE = /(impatient|impatience|mauvaise foi|mauvaise intention|malhonn[eê]t|pas de bonne foi|vous exagérez|votre exagération)/i;
// Affirmations sur des procédures ou actions internes non fournies par le profil
// ou le contexte — de la pure invention (« registres de nettoyage », « nous
// vérifions régulièrement », « nous travaillons à mieux répartir »).
const INTERNAL_CLAIMS: Array<[RegExp, string]> = [
  [/\bregistres?\b/i, 'registre'],       // permis seulement si contexte « jamais venu »
  [/\bcontr[oô]les?\b/i, 'contrôle'],
  [/\bv[eé]rifi\w*\b/i, 'vérifions'],
  [/\bproc[eé]dures?\b/i, 'procédure'],
  [/\bprotocoles?\b/i, 'protocole'],
  [/\bnous travaillons\b/i, 'nous travaillons à'],
  [/\bnous revoyons\b/i, 'nous revoyons'],
  [/\bnous mettons en (place|[œo]uvre)\b/i, 'nous mettons en place'],
];
// « Nous sommes surpris / surprenant » : réservé aux contextes où le restaurateur
// conteste le fait (jamais venu, plat conforme) — ailleurs c'est de la défensive.
const SURPRISE_RE = /\bsurpris(es)?\b|\bsurpren(ant|ante|ants|antes|ons|ez)\b/i;
// Fuites de l'analyse interne et fautes de forme.
const ANALYSIS_LEAK_RE = /\b(nature|cat[ée]gorie|classification|type) de (la |votre |cette )?critique\b|votre (remarque|retour|avis|commentaire|critique|note|message) (porte sur|concerne|se concentre sur)/i;
const DE_UNE_RE = /\bde un(e)?\b/i; // « de une étoile » → « une étoile »
// Regrets / excuses : franches uniquement si le contexte « problème réel » est
// coché ; sinon au plus une occurrence.
const APOLOGY_RE = /(nous (sommes |serions |vous sommes |en sommes )?(sincèrement |vraiment )?désolé|nous (vous )?(présentons|adressons|offrons) nos (plus |sincères )?excuses|toutes nos excuses|nous nous excusons|veuillez (accepter|recevoir|croire à|agréer) nos (sincères |plus sincères )?(excuses|regrets)|nous (le |la |les |vous )?regrettons|nous sommes navrés|je (suis |en suis |vous )?(sincèrement |vraiment )?(désolée?|navrée?|regrette|m'excuse|présente mes (plus |sincères )?excuses))/gi;
// Faits affirmés non fournis : « vous aviez été prévenu », « indiqué à votre
// arrivée », « comme convenu » — permis seulement si l'avis, la note du
// restaurateur ou le contexte « attente annoncée » les mentionnent.
// (Comparés sur texte normalisé : accents et apostrophes neutralisés.)
const WARNED_RE = /(prevenu|comme (convenu|prevu|indiquee?|annoncee?)|(indiquee?|annoncee?|signalee?|informee?|precisee?)[rs]?\b[^.\n]{0,30}(a|des|avant)\s+(l'|votre|leur)\s*(arrivee|accueil|entree|commande))/;
const FACTS_HINT_RE = /(prevenu|annonce|indique|informe|averti|convenu|prevu)/;
// Explications d'attente ou de salle : jamais en première phrase — la réponse
// s'ouvre sur la reconnaissance du problème du client, l'explication suit.
const FIRST_SENT_FACT_RE = /(prevenu|annonce|indique|signale|informe|convenu|salle (complete|pleine|bondee)|complets?\b|a plein|tournait a plein|deborde)/;
// Tournures de reproche au client — interdites même si le fait est fourni :
// l'annonce peut être rappelée au neutre (« l'attente avait été annoncée »),
// jamais en « je vous l'avais dit ».
const BLAME_RE = /(vous (aviez|avez|etiez)(\s+\w+){0,3}\s+(prevenu|informe|averti)|je vous (avais|ai|l'avais|l'ai)(\s+\w+){0,2}\s+(prevenu|dit|annonce|indique|signale|explique)|comme convenu|comme (je |on )(vous )?l'(avais|a) (dit|annonce|indique))/;
const PRICE_WORDS_RE = /(prix|tarif|cher|cout|addition|facture|euro|€)/;
// Avis négatif : la chute doit inviter à revenir ou à reprendre contact
// (les sujets santé relèvent d'une invitation au contact privé, déjà exigée).
const RETURN_RE = /(reven(?:ir|ez|ons)|revoir|revienne|reviendr|retrouver|retrouv|rejoin(?:dre|dez|gnez)|seconde chance|autre chance|nouvelle chance|prochaine (visite|fois|occasion|rencontre)|a bientot|venez|venir|repasse[zr]?|accueilli[rxz]|attendons|attendre|rendez-vous|recevoir|de nouveau|une autre fois|nous reverrons|esperons vous)/i;
// Triplette rhétorique « X, Y et Z » : trois éléments courts et sans verbe
// conjugué dans une même phrase — mécanique typique des réponses générées.
// Une énumération de clauses (« venez en semaine, c'est plus calme et je
// passerai vous saluer ») n'est PAS une triplette : les segments porteurs
// d'un sujet ou d'un verbe conjugué la disqualifient.
const CLAUSE_MARK = /\b(je|j'|tu|t'|il|elle|on|nous|vous|ils|elles|ce|c'|ça|cela|que|qu'|qui|quand|comme|lorsque|puisque|parce|dont|où|si|mais|donc|ni|car|est|sont|suis|sommes|êtes|étais|était|étaient|sera|serai|serons|serez|seront|soit|soient|avais|avait|avaient|avons|avez|ont|aurai|aurait|faut|fallait|vais|va|vont|allons|allez|peux|peut|peuvent|dois|doit|doivent|veux|veut|veulent|viens|vient|venons|venez|viennent|venir|passe|passer|passez|reste|restons|restent|mérite|méritent|espère|espérons|aimerais|voudrais|souhaite|souhaitons|invite|invitons|attends|attendons|attendez)\b/i;
const TRIAD_RE = /([^,.!?;:()«»\n]{2,80}?),\s*([^,.!?;:()«»\n]{2,80}?)\s+et\s+([^,.!?;:()«»\n]{2,80})/g;
function hasTriad(text: string): boolean {
  const item = (s: string) => { const w = s.split(/\s+/).filter(Boolean).length; return w >= 1 && w <= 8; };
  for (const sent of text.split(/[.!?\n]+/))
    for (const m of sent.matchAll(TRIAD_RE)) {
      const [, a, b, c] = m;
      // Le 3e élément peut être suivi d'une clause (« … et le service était lent ») :
      // seule sa tête nominale compte ; un élément commençant par un sujet ou
      // un verbe conjugué n'est pas un élément de liste.
      const headC = c.split(CLAUSE_MARK)[0].trim();
      if (!CLAUSE_MARK.test(a) && !CLAUSE_MARK.test(b) && headC && item(a) && item(b) && item(headC)) return true;
    }
  return false;
}
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

// Post-traitement anti-marqueurs IA, appliqué au texte brut du modèle avant
// l'ajout de la signature et le contrôle des règles : les tirets cadratin et
// demi-cadratin deviennent des virgules (supprimés en début ou fin de ligne),
// le caractère « … » devient un point.
export function cleanReply(s: string): string {
  return s
    .replace(/[ \t]*[—–][ \t]*/g, ', ')
    .replace(/…/g, '.')
    .replace(/,[ \t]*([,.;:!?])/g, '$1')
    .replace(/\.{2,}/g, '.')
    .replace(/(^|\n)[ \t]*,[ \t]*/g, '$1')
    .replace(/,[ \t]*(\n|$)/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// Signature exacte ajoutée par le code : remplace une signature partielle
// (« Marc »), retire un prénom de signataire en fin de corps (« …, Marc »),
// remplace une formule de clôture écrite par le modèle, sinon l'ajoute.
export function withSignature(text: string, sig: string): string {
  const lines = text.trim().split('\n').map(s => s.trim()).filter(Boolean);
  const first = sig.split(',')[0].trim();
  const fn = first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const last = lines.at(-1) ?? '';
  const nl = norm(last), ns = norm(sig);
  if (nl === ns) return lines.join('\n');
  // Dernière ligne = prénom seul ou signature partielle → remplacée.
  if (new RegExp(`^${fn}\\.?$`, 'i').test(last) || (nl && nl.length < ns.length && ns.includes(nl)))
    { lines[lines.length - 1] = sig; return lines.join('\n'); }
  // Fin de phrase « …, Marc. » : prénom retiré puis signature ajoutée.
  let stripped = last.replace(new RegExp(`[,\\s]*${fn}\\.?\\s*$`, 'i'), '').trim();
  if (stripped !== last) {
    if (stripped && !/[.!?…]$/.test(stripped) && /[.!?…]\s*$/.test(last)) stripped += '.';
    if (stripped) lines[lines.length - 1] = stripped; else lines.pop();
    lines.push(sig);
    return lines.join('\n');
  }
  if (last && last.length < 50 && /cordialement|bien à vous|bien a vous|l'équipe|l'equipe|amicalement|très bonne journée|bonne soirée/i.test(last))
    lines[lines.length - 1] = sig;
  else lines.push(sig);
  return lines.join('\n');
}

// Aides transversales (contrôles entre variantes dans generate.ts).
export const citedStrengths = (text: string, p: PromptProfile) =>
  (p.strengths ?? []).filter(s => s && norm(text).includes(norm(s)));
export const mentionsContactEmail = (text: string, p: PromptProfile) => {
  const key = (s: string) => s.replace(/[\s.()-]/g, '').toLowerCase();
  const allowed = new Set([p.contact_email].filter(Boolean).map(key));
  return (text.match(EMAIL_RE) ?? []).some(m => allowed.has(key(m.replace(/[.,;:)]+$/, ''))));
};
export const mentionsReservation = (text: string) => /réserv|reserv/i.test(text);

export function checkReply(text: string, p: PromptProfile, r: PromptReview,
  opts?: { allowedStrength?: string | null }): RuleCheck {
  const errors: string[] = [], warnings: string[] = [];
  const t = text.trim();
  // Longueur mesurée sur le corps, hors ligne de signature.
  const sig = signatureOf(p);
  const lines = t.split('\n').map(s => s.trim()).filter(Boolean);
  const lastLine = lines.at(-1) ?? '';
  const signed = norm(lastLine) === norm(sig);
  const bodyNoSig = (signed ? lines.slice(0, -1).join('\n') : t).trim();
  const words = wordCount(bodyNoSig);
  const range = replyRange(r);
  // Longueur : dépassement jusqu'à +10 % = avertissement ; au-delà = rejet.
  if (words < Math.floor(range.min * 0.85)) errors.push(`trop court (${words} mots, minimum ${range.min})`);
  else if (words > Math.ceil(range.max * 1.30)) errors.push(`trop long (${words} mots, maximum ${range.max})`);
  else if (words < range.min || words > range.max) warnings.push(`longueur hors cible (${words} mots, cible ${range.min}–${range.max})`);

  // Ouverture : « Bonjour {prénom} » si un prénom exploitable est affiché
  // (≥ 2 lettres, pas un pseudo comme « Anonyme » ou « R. »), sinon « Bonjour ».
  const nb = norm(bodyNoSig);
  const name = authorDisplayName(r);
  if (!/^bonjour\b/.test(nb)) errors.push('ouverture différente de « Bonjour »');
  else if (name) {
    const a = norm(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Le marqueur [PRÉNOM] est accepté : il est remplacé par le vrai prénom
    // ou retiré côté génération, selon le choix du restaurateur.
    const marker = norm('PRÉNOM');
    if (!new RegExp(`^bonjour\\s+(?:${a}|\\[${marker}\\])(?![\\p{L}\\p{N}])`, 'u').test(nb)) errors.push('ouverture sans le prénom de l’auteur');
  } else if (/^bonjour\s+[a-z](?![a-z])/i.test(nb))
    errors.push('« Bonjour » seul attendu (initiale non communiquée)');
  // Le signataire ne se nomme jamais à la 3e personne dans le corps.
  const reviewAndAuthor = norm(`${r.body} ${r.author_name}`);
  for (const who of [p.signature_name, p.signature_role].filter(s => s && s.trim().length > 2)) {
    const w = norm(who).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').trim();
    if (w && new RegExp(`\\b${w}\\b`).test(nb) && !reviewAndAuthor.includes(w))
      { errors.push('signataire cité à la 3e personne'); break; }
  }

  // Signature (texte final assemblé) : présente, seule en fin de texte.
  if (!norm(t).includes(norm(sig))) errors.push('signature absente');
  else if (!signed) warnings.push('la signature n’est pas seule sur la dernière ligne');
  const nameCount = countOccurrences(bodyNoSig, p.name);
  if (p.name && nameCount > 1 && !norm(sig).includes(norm(p.name))) errors.push(`nom du restaurant répété (${nameCount} fois)`);
  if (p.city && countOccurrences(bodyNoSig, p.city) > 1) errors.push('ville répétée');

  // Interdits absolus.
  if (FORBIDDEN.test(t)) errors.push('mention juridique ou accusation de mensonge');
  if (TUTOIEMENT.test(t) && p.address_form !== 'tu') errors.push('tutoiement');
  if (EMOJI.test(t)) errors.push('emoji');
  if (TYPO_MARKER.test(t)) errors.push('tiret cadratin ou « … » résiduel');
  if (/!{2,}|\?{2,}/.test(t)) warnings.push('ponctuation en série');

  // Excuses : franches si « problème réel » est coché ; une excuse brève sinon
  // (critique plausible). Jamais quand le contexte est « jamais venu ».
  const apologies = (t.match(APOLOGY_RE) ?? []).length;
  if (r.context_tags.includes('unknown_customer') && apologies > 0)
    errors.push('excuse inadaptée au contexte « jamais venu »');
  else if (!r.context_tags.includes('real_problem') && apologies > 1)
    errors.push('excuses répétées sans contexte « problème réel »');
  // « prix affichés » : seule l'excuse PORTANT sur les prix est interdite —
  // s'excuser de l'attente, du service ou d'un plat reste permis.
  if (r.context_tags.includes('prices_displayed')) {
    const apo = new RegExp(APOLOGY_RE.source, 'i');
    for (const sent of t.split(/[.!?\n]+/))
      if (apo.test(sent) && PRICE_WORDS_RE.test(norm(sent)))
        { errors.push('excuse portant sur les prix (contexte « prix affichés »)'); break; }
  }

  // Formules génériques interdites par la consigne, puis expressions
  // bannies par le restaurateur (réglage « Mon style »).
  for (const b of BANNED_PHRASES)
    if (norm(t).includes(norm(b))) { errors.push(`formule interdite (${b})`); break; }
  for (const b of p.avoid_phrases ?? [])
    if (norm(t).includes(norm(b))) { errors.push(`expression bannie par le restaurateur (${b})`); break; }
  if (countOccurrences(t, 'au plaisir') > 1) errors.push('« au plaisir » répété dans la même réponse');
  if (IMPATIENCE_RE.test(t)) errors.push('tournure suggérant l’impatience ou la mauvaise foi du client');
  if (hasTriad(nb.replace(GREETING_RE, ''))) errors.push('énumération de trois éléments dans une même phrase (triplette)');

  // Dire « l'avis ne donne pas de détail » alors qu'il en contient : faux.
  if (r.body.trim() && NO_DETAIL_RE.test(t))
    errors.push('affirme à tort que l’avis ne donne aucun détail');

  // Faits internes inventés : aucun registre, contrôle ou procédure que le
  // profil, le contexte ou l'avis ne mentionne pas.
  const contextCorpus = norm([r.body, r.context_note, p.practical_info, ...(p.strengths ?? [])].join(' '));
  for (const [re, label] of INTERNAL_CLAIMS) {
    const m = t.match(re);
    if (!m) continue;
    if (label === 'registre' && r.context_tags.includes('unknown_customer')) continue;
    if (contextCorpus.includes(norm(m[0]))) continue;
    errors.push(`fait interne inventé (« ${label} »)`);
    break;
  }
  // Événements affirmés non fournis : « vous aviez été prévenu », « indiqué à
  // votre arrivée », « comme convenu »… — permis seulement si l'avis, la note
  // du restaurateur ou le contexte « attente annoncée » les mentionnent.
  const factsCorpus = norm([r.body, r.context_note, ...r.context_tags.map(tg => CONTEXT_TAGS[tg as ContextTag] ?? '')].join(' '));
  // « Salle complète » ne suffit pas : le rappel de l'attente annoncée exige la
  // case « l'attente a été annoncée au client à son arrivée » (ou l'avis / la note).
  if (WARNED_RE.test(nb) && !r.context_tags.includes('wait_announced') && !FACTS_HINT_RE.test(factsCorpus))
    errors.push('fait affirmé non fourni par l’avis ou le contexte (« prévenu », « indiqué à l’arrivée », « comme convenu »)');
  if (BLAME_RE.test(nb))
    errors.push('tournure de reproche envers le client (« vous aviez été prévenu », « je vous l’avais dit », « comme convenu »)');
  // On reconnaît d'abord le problème du client : aucune explication (attente
  // annoncée, salle pleine) en première phrase.
  const firstSent = nb.replace(GREETING_RE, '').split(/[.!?\n]+/)[0] ?? '';
  if (FIRST_SENT_FACT_RE.test(firstSent))
    errors.push('explication (attente annoncée, salle complète) en première phrase — commencer par reconnaître le problème du client');

  if (SURPRISE_RE.test(t) && !r.context_tags.some(tg => tg === 'unknown_customer' || tg === 'dish_as_described'))
    errors.push('« surpris / surprenant » réservé aux contextes « jamais venu » ou « plat conforme »');
  if (ANALYSIS_LEAK_RE.test(t)) errors.push('analyse interne recopiée (« nature de la critique »)');
  if (DE_UNE_RE.test(t)) errors.push('« de une étoile » — écrire « une étoile »');

  // Sobriété : au plus UN point fort du profil par variante, et seulement
  // celui suggéré à cette variante — jamais obligatoire.
  const strengths = citedStrengths(t, p);
  if (strengths.length > 1) errors.push(`plusieurs points forts cités (${strengths.slice(0, 2).join(', ')})`);
  else if (opts?.allowedStrength === null && strengths.length) errors.push('point fort non demandé dans la variante factuelle');
  else if (typeof opts?.allowedStrength === 'string' && strengths.some(s => s !== opts.allowedStrength))
    errors.push(`point fort non attribué à cette variante (« ${opts.allowedStrength} » suggéré)`);

  // Au plus une mention de l'équipe par réponse.
  if ((norm(t).match(/\bequipes?\b/g) ?? []).length > 1) errors.push('mention de l’équipe répétée');

  // Plats et aliments : tout mot culinaire cité doit venir de l'avis ou du profil.
  const known = norm([r.body, p.name, p.city, p.cuisine, p.practical_info, ...(p.strengths ?? [])].join(' '));
  const invented = foodMentions(t, known);
  if (invented.length) errors.push(`plat ou aliment inventé (${invented.slice(0, 3).join(', ')})`);

  // Données personnelles : aucun email autre que celui du profil ; le
  // téléphone n'est autorisé que si le restaurateur l'affiche (show_phone).
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
  // L'email de contact ne se justifie que dans une variante qui invite
  // explicitement à un échange privé (mot d'invitation hors l'adresse elle-même).
  if (hasContactEmail && !CONTACT_INVITE.test(t.replace(EMAIL_RE, '')))
    errors.push('email cité sans invitation à un échange privé');

  // Liens : aucune URL ni nom de domaine dans une réponse publique (anti-
  // phishing, anti-injection via le texte de l'avis). L'email du profil est
  // retiré avant le test.
  const sansEmail = t.replace(EMAIL_RE, '');
  if (/https?:\/\/|www\./i.test(sansEmail)
    || /\b[a-z0-9][a-z0-9-]*\.(?:com|fr|net|org|io|dev|co|eu|info|biz|site|online|shop|app|rest|restaurant)\b/i.test(sansEmail))
    errors.push('lien ou nom de domaine dans la réponse');

  // Santé : pas d'aveu de responsabilité, invitation au contact privé.
  if (isHealthTopic(r)) {
    if (ADMISSION.test(t)) errors.push('reconnaissance de responsabilité sur un sujet santé');
    if (!CONTACT_INVITE.test(t)) errors.push('sujet santé sans invitation à un contact privé');
  }
  // Avis négatif : la chute invite toujours à revenir ou à reprendre contact
  // (les sujets santé relèvent de l'invitation au contact privé ci-dessus).
  if (!isPositive(r.rating) && !isHealthTopic(r) && !RETURN_RE.test(t))
    errors.push('avis négatif sans invitation à revenir ou à reprendre contact');
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
