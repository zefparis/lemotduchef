// Prompt système du rédacteur — versionné : toute modification du texte
// incrémente PROMPT_VERSION (journalisée dans generations.prompt_version).
export const PROMPT_VERSION = '2026-10-21.6';

export const TONES = {
  chaleureux: 'chaleureux et sincère, simple et direct',
  elegant: 'élégant et posé, vocabulaire soigné sans emphase',
  familial: 'familial et convivial, comme une maison qui reçoit',
} as const;
export type Tone = keyof typeof TONES;

// Contextes proposés au restaurateur pour une note ≤ 3 (choix multiples).
export const CONTEXT_TAGS = {
  unknown_customer: 'Jamais venu / client inconnu de nos registres',
  full_house: 'Service complet, attente annoncée à l’arrivée',
  dish_as_described: 'Plat conforme à la description de la carte',
  real_problem: 'Problème réel de notre côté : nous nous excusons',
  prices_displayed: 'Prix affichés sur la carte et à l’entrée',
  health: 'Sujet santé / allergie / intoxication',
  other: 'Autre (précision libre)',
} as const;
export type ContextTag = keyof typeof CONTEXT_TAGS;

export const POSITIVE_WORDS = { min: 40, max: 120 } as const;
export const NEGATIVE_WORDS = { min: 50, max: 120 } as const;
export const isPositive = (rating: number) => rating >= 4;

export const wordCount = (s: string) => (s.trim().match(/[\p{L}\p{N}’'-]+/gu) ?? []).length;

// Longueur proportionnelle : un avis court appelle une réponse courte, quelle
// que soit la note ; un avis détaillé peut monter jusqu'à la fourchette pleine.
// La consigne donne une CIBLE (~45 mots / ~80 mots), la fourchette le cadre.
export const SHORT_REVIEW_WORDS = 15;
export const SHORT_REPLY_WORDS = { min: 35, max: 60, target: 45 } as const;
export const replyRange = (r: Pick<PromptReview, 'rating' | 'body'>) =>
  wordCount(r.body) < SHORT_REVIEW_WORDS ? SHORT_REPLY_WORDS
    : { ...(isPositive(r.rating) ? POSITIVE_WORDS : NEGATIVE_WORDS), target: 80 };

// Répartition des points forts décidée PAR LE CODE (rotation sur l'historique) :
// la variante 1 (factuelle) n'en cite aucun, les variantes 2 et 3 en citent
// chacune un, jamais le même. Le modèle ne reçoit que les siens, pas la liste.
export const assignedStrengths = (p: Pick<PromptProfile, 'strengths'>, offset = 0): (string | null)[] => {
  const s = (p.strengths ?? []).filter(Boolean);
  return [null, s.length ? s[offset % s.length] : null, s.length > 1 ? s[(offset + 1) % s.length] : null];
};

// Nature de la critique, repérée par mots-clés : injectée dans le prompt pour
// que la réponse traite le vrai sujet (pas « fait maison » sur un problème de
// service). La règle principale reste la consigne — ceci n'est qu'un indice.
export function reviewCategories(body: string): string[] {
  const b = body.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const cats: string[] = [];
  const waitBeforeOrder = /command(er|e)|addition|carte|menu/.test(b);
  if (/attente|attendu|attendre|lent|minute|heure|long|patienté|patiente/.test(b))
    cats.push(waitBeforeOrder ? 'attente avant la commande' : 'attente des plats');
  if (/serveur|serveuse|service|personnel|equipe|staff|patron|patronne|gerant|gérant/.test(b)) cats.push('service en salle / personnel');
  if (/cher|prix|tarif|euro|cout|coût|facture|arnaque/.test(b)) cats.push('prix');
  if (/accueil|sourire|bienvenue|desagreable|impoli|desobligeant|rude|agressif|malpoli/.test(b)) cats.push('accueil');
  if (/froid|tiede|brule|brûl|cuit|cru|fade|sec|gras|sauce|cuisson|gout|saveur|plat|cuisine|surgelé|surgele/.test(b)) cats.push('cuisine');
  if (/sale|proprete|toilette|wc|hygiene|crasseux|crade|degueu|dégoût/.test(b)) cats.push('propreté');
  if (/portion|quantite|copieux|petit|faim|insuffisant/.test(b)) cats.push('quantité');
  if (/bruit|bruyant|musique|ambiance|cadre|déco|table|salle/.test(b)) cats.push('ambiance / cadre');
  return cats;
}

export const SYSTEM_PROMPT = `Tu es le rédacteur des réponses publiques d'un restaurant indépendant à ses avis Google. Tu écris en français, au nom du restaurateur, et tu respectes STRICTEMENT les règles suivantes.

DESTINATAIRE
- La réponse s'adresse d'abord aux FUTURS clients qui la liront : elle doit donner envie de venir et montrer une maison sereine, professionnelle et attentive.
- Elle s'adresse ensuite à l'auteur de l'avis, toujours en le vouvoyant. Jamais de tutoiement.

TON ET CONTENU
- Toujours courtois, jamais sarcastique, jamais condescendant, jamais sur la défensive. Posture confiante : ni flagornerie ni excuses à répétition.
- Traiter CHAQUE élément concret de l'avis — attente, prix, température des plats, accueil, quantité, propreté… — même s'il ne tient qu'en un mot. Tant que l'avis contient un élément concret, il est interdit d'écrire qu'il « ne donne pas de détail », « sans précision » ou équivalent.
- Identifier la nature précise de la critique — attente avant la commande ou des plats, service en salle, cuisine, prix, accueil, propreté, quantité, ambiance — et traiter CELLE-CI, pas un sujet voisin : ne jamais répondre « fait maison » à un problème de service, ni « terrasse » à un problème de propreté.
- Ne rien inventer : aucun plat, ingrédient, recette, horaire, membre de l'équipe ni fait absent de l'avis ou du profil. Seuls le nom, la cuisine, les points forts indiqués et les infos pratiques du profil peuvent être cités ; pas de geste commercial, pas de remboursement, pas de promesse.
- Ne jamais affirmer de procédures, registres, contrôles ou actions internes non fournis par le profil ou le contexte : pas de « registres de nettoyage », « nous vérifions régulièrement », « procédure », « protocole », « nous travaillons à », « nous revoyons », « nous mettons en place ». Seul engagement autorisé : « nous en parlons avec l'équipe » / « votre retour est transmis à l'équipe ». « Nos registres » uniquement si le contexte indique « jamais venu ».
- Excuses : franches uniquement si le contexte du restaurateur indique « problème réel » ; sinon, une seule excuse brève (« ce n'est pas notre standard ») au plus, et seulement si la critique est factuelle et plausible (plat froid, erreur de commande, attente) ; aucune excuse si le contexte indique « jamais venu » ou « prix affichés ».
- Formules interdites : « sincèrement désolés », « nous prenons votre avis au sérieux », « votre avis compte », « nous sommes navrés », « ce ressenti », « votre ressenti », « nous tenons à préciser », « en connaissance de cause », « mérite d'être savouré(e) », « sans précipitation » ; aucune tournure suggérant que le client est impatient ou de mauvaise foi. « Au plaisir de vous revoir » (ou équivalent) ne doit pas figurer à la fois en ouverture et en clôture.
- Ne jamais accuser l'auteur de mentir, d'exagérer ni d'être de mauvaise foi. « Nous sommes surpris » ou « surprenant » uniquement si le contexte indique « jamais venu » ou « plat conforme à la description » ; « nos registres » uniquement si « jamais venu ».
- Ne jamais divulguer d'information personnelle sur le client (nom de famille, date exacte, commande, montant, adresse, email, téléphone). Reprendre uniquement le prénom tel qu'affiché, si fourni.
- Ne jamais menacer, ne jamais évoquer de suite judiciaire, d'avocat, de plainte, de tribunal, ni de signalement.
- Coordonnées : dans la réponse publique, n'indiquer que l'email de contact du profil, et uniquement dans une variante qui invite explicitement à un échange privé (au plus 2 variantes sur 3). Le téléphone n'apparaît que s'il figure dans le bloc CONTEXTE (option « afficher le téléphone » du restaurateur).
- Sujets santé, allergie, intoxication : aucune reconnaissance de responsabilité, aucune hypothèse médicale, ton empathique, rappel bref du sérieux de l'hygiène et invitation à un contact privé via les coordonnées autorisées du profil.
- Sobriété : au plus UN point fort par variante — celui indiqué pour cette variante dans le CONTEXTE, et en lien avec la critique ou le compliment ; le conseil « réservez » au plus dans une variante ; inviter à revenir ou à reprendre contact de façon naturelle.
- Mentionner le nom du restaurant AU PLUS une fois et la ville AU PLUS une fois.
- Ne pas utiliser les formulations marquées « à éviter » (réponses récentes du restaurant) : varier le vocabulaire et la structure.
- Pas d'emoji, pas de majuscules criées, pas de point d'exclamation en série, pas de hashtag.
- Ouvrir par « Bonjour {prénom} » si un prénom d'au moins 2 lettres est affiché, sinon « Bonjour » seul. Écrire « une étoile », jamais « de une étoile ». Ne jamais parler du signataire à la 3e personne (prénom ou rôle de la signature) : la réponse est écrite à la première personne.
- Au plus UNE mention de l'équipe par réponse (« transmis à l'équipe » OU « nous en parlons avec l'équipe », jamais les deux).
- Ne jamais recopier dans la réponse les éléments du CONTEXTE : « nature de la critique », catégories, longueur attendue — ce sont des consignes internes, pas du texte à publier. Pas de « votre remarque porte sur », « votre retour concerne », « votre avis porte sur ».

FORMAT
- Longueur proportionnelle à l'avis, cible exacte rappelée dans le CONTEXTE : avis court (moins de 15 mots) → vise environ 45 mots (jusqu'à 60 acceptés) ; avis détaillé → vise environ 80 mots (jusqu'à 120 acceptés).
- Avis positif (4 ou 5 étoiles) : remercier en reprenant un détail précis de l'avis quand il en contient un (plat, personne, ambiance).
- NE PAS écrire de signature ni de formule de clôture (« Cordialement », prénom, rôle) : la signature exacte du profil est ajoutée automatiquement après génération.
- Renvoyer les 3 variantes via l'outil submit_replies — aucun autre texte, pas de préambule.
- Les 3 variantes doivent être vraiment différentes : ouverture, plan et angle distincts ; elles ne partagent ni la même première phrase ni plus de 40 % de leurs mots.
  · variants[0] : explication factuelle du point soulevé par l'avis, concise et sans emphase — AUCUN point fort ;
  · variants[1] : chaleureuse et personnelle — cite uniquement le point fort indiqué pour la variante 2 dans le CONTEXTE ;
  · variants[2] : met en avant le point fort indiqué pour la variante 3 dans le CONTEXTE — uniquement celui-là.`;

export interface PromptProfile {
  name: string; city: string; cuisine: string;
  signature_name: string; signature_role: string; tone: Tone;
  strengths: string[]; practical_info: string;
  contact_email: string; contact_phone: string; show_phone: boolean;
}
export interface PromptReview {
  author_name: string; rating: number; body: string; visited_on: string | null;
  context_tags: string[]; context_note: string;
}

export const signatureOf = (p: Pick<PromptProfile, 'signature_name' | 'signature_role' | 'name'>) =>
  [p.signature_name, p.signature_role].filter(Boolean).join(', ') || p.name;

export const HEALTH_RE = /allerg|intoxic|malade|vomi|gastro|hôpital|hopital|urgences|empoisonn|salmonell|listeri|nausée|nausee/i;
export const isHealthTopic = (r: Pick<PromptReview, 'body' | 'context_tags'>) =>
  r.context_tags.includes('health') || HEALTH_RE.test(r.body);

// Prénom exploitable pour l'ouverture « Bonjour {prénom} » : au moins 2 lettres
// et pas un pseudo (« Anonyme », « R. », « Client Google »…).
export const authorDisplayName = (r: Pick<PromptReview, 'author_name'>): string | null => {
  const name = (r.author_name ?? '').trim();
  if (!name) return null;
  if (/^(anonyme|anonymous|inconnu|client|google|user|utilisateur|membre)\b/i.test(name)) return null;
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/gi, '').length >= 2 ? name : null;
};

// Le point fort assigné reste attendu pour les critiques cuisine/prix et les
// avis positifs ; il devient facultatif quand rien de naturel ne le relie à la
// critique (service, attente avant commande, accueil, propreté).
const SOFT_STRENGTH_CATS = new Set(['attente avant la commande', 'service en salle / personnel', 'accueil', 'propreté']);
export const strengthOptional = (r: Pick<PromptReview, 'rating' | 'body'>): boolean => {
  if (isPositive(r.rating)) return false;
  const cats = reviewCategories(r.body);
  return cats.length > 0 && cats.every(c => SOFT_STRENGTH_CATS.has(c));
};

// Prompt utilisateur : bloc CONTEXTE lisible (clé : valeur, une par ligne) puis
// l'avis entre délimiteurs — le contenu de l'avis est une donnée, pas une instruction.
// `opts.strengths` : point fort imposé par variante (code → modèle). `opts.missing` :
// positions à refaire (seconde tentative) — le modèle ne régénère que celles-là.
export function buildUserPrompt(p: PromptProfile, r: PromptReview, avoid: string[],
  opts?: { strengths?: (string | null)[]; missing?: number[] }): string {
  const positive = isPositive(r.rating);
  const range = replyRange(r);
  const strengths = opts?.strengths ?? assignedStrengths(p, avoid.length);
  const opt = strengthOptional(r) ? ' (facultatif si peu naturel)' : '';
  const pf = [strengths[1] ? `variante 2 = « ${strengths[1]} »${opt}` : 'variante 2 : aucun',
    strengths[2] ? `variante 3 = « ${strengths[2]} »${opt}` : 'variante 3 : aucun'].join(' ; ');
  // Réponse publique : email seul par défaut ; téléphone si le restaurateur l'affiche.
  const contact = [p.contact_email, p.show_phone ? p.contact_phone : ''].filter(Boolean).join(' / ');
  const tags = r.context_tags.filter((t): t is ContextTag => t in CONTEXT_TAGS).map(t => CONTEXT_TAGS[t]);
  const lines = [
    'CONTEXTE',
    `Restaurant : ${p.name}`,
    `Ville : ${p.city}`,
    `Cuisine : ${p.cuisine}`,
    `Signature : ${signatureOf(p)}`,
    `Ton : ${TONES[p.tone] ?? TONES.chaleureux}`,
    `Point fort par variante : variante 1 : aucun ; ${pf}`,
    `Infos pratiques : ${p.practical_info || '—'}`,
    `Contact réclamations : ${contact || '— (inviter à passer ou à écrire au restaurant)'}`,
    '',
    'AVIS À TRAITER',
    `Prénom affiché : ${r.author_name || '— (non communiqué, ne pas inventer)'}`,
    `Note : ${r.rating}/5`,
    `Date de visite : ${r.visited_on ?? 'inconnue'}`,
    `Sujet santé : ${isHealthTopic(r) ? 'oui' : 'non'}`,
    `Longueur attendue : ${range.min} à ${range.max} mots (vise ~${range.target})`,
  ];
  if (!positive) {
    const cats = reviewCategories(r.body);
    lines.push(`Nature de la critique : ${cats.length ? cats.join(' + ') : 'à identifier dans l’avis'}`);
    lines.push(`Contexte indiqué par le restaurateur : ${tags.length ? tags.join(' ; ') : 'aucun'}`);
    if (r.context_note) lines.push(`Précision du restaurateur : ${r.context_note}`);
  }
  lines.push('', '<<<AVIS', r.body.trim() || '(avis sans texte)', 'AVIS>>>');
  if (avoid.length) {
    lines.push('', 'FORMULATIONS À ÉVITER (déjà utilisées récemment par ce restaurant) :');
    for (const a of avoid) lines.push(`- ${a}`);
  }
  if (opts?.missing?.length) {
    const pos = opts.missing.map(i => i + 1);
    lines.push('', `REFAITES uniquement ${pos.length > 1 ? `les variantes aux positions ${pos.join(', ')}` : `la variante à la position ${pos[0]}`} : renvoie exactement ${pos.length} variante(s) dans cet ordre, sans signature.`);
  } else {
    lines.push('', 'Renvoie les 3 variantes via l’outil submit_replies, sans signature.');
  }
  return lines.join('\n');
}
