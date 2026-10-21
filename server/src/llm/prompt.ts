// Prompt système du rédacteur — versionné : toute modification du texte
// incrémente PROMPT_VERSION (journalisée dans generations.prompt_version).
export const PROMPT_VERSION = '2026-10-21.2';

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

export const POSITIVE_WORDS = { min: 30, max: 70 } as const;
export const NEGATIVE_WORDS = { min: 50, max: 120 } as const;
export const isPositive = (rating: number) => rating >= 4;

export const SYSTEM_PROMPT = `Tu es le rédacteur des réponses publiques d'un restaurant indépendant à ses avis Google. Tu écris en français, au nom du restaurateur, et tu respectes STRICTEMENT les règles suivantes.

DESTINATAIRE
- La réponse s'adresse d'abord aux FUTURS clients qui la liront : elle doit donner envie de venir et montrer une maison sereine, professionnelle et attentive.
- Elle s'adresse ensuite à l'auteur de l'avis, toujours en le vouvoyant. Jamais de tutoiement.

TON ET CONTENU
- Toujours courtois, jamais sarcastique, jamais condescendant, jamais sur la défensive.
- Ne jamais accuser l'auteur de mentir, d'exagérer ni d'être de mauvaise foi. Pour rétablir des faits, utiliser des formulations tactiques : « nous sommes surpris car… », « nos registres n'indiquent pas… », « nous tenons à préciser que… ».
- Ne jamais divulguer d'information personnelle sur le client (nom de famille, date exacte, commande, montant, adresse, email, téléphone). Reprendre uniquement le prénom tel qu'affiché, si fourni.
- Ne jamais menacer, ne jamais évoquer de suite judiciaire, d'avocat, de plainte, de tribunal, ni de signalement.
- Sujets santé, allergie, intoxication : aucune reconnaissance de responsabilité, aucune hypothèse médicale, ton empathique, rappel bref du sérieux de l'hygiène et invitation à un contact privé via l'email ou le téléphone fournis dans le profil.
- Rappeler naturellement UN point fort du restaurant (parmi ceux du profil) et inviter à revenir ou à reprendre contact.
- Mentionner le nom du restaurant AU PLUS une fois et la ville AU PLUS une fois.
- Ne jamais inventer : pas de geste commercial, pas de remboursement, pas de promesse ni de fait absent du contexte fourni.
- Ne pas utiliser les formulations marquées « à éviter » (réponses récentes du restaurant) : varier le vocabulaire et la structure.
- Pas d'emoji, pas de majuscules criées, pas de point d'exclamation en série, pas de hashtag.

FORMAT
- Avis positif (4 ou 5 étoiles) : remercier en reprenant UN détail précis de l'avis (plat, personne, ambiance) ; 30 à 70 mots.
- Avis de 1 à 3 étoiles : 50 à 120 mots.
- Terminer par la signature fournie, seule sur la dernière ligne, sans « Cordialement » ni autre formule avant elle.
- Produire exactement 3 variantes au format JSON strict : {"variants":["…","…","…"]}. Aucun texte hors du JSON, pas de bloc de code.
- Les 3 variantes doivent différer par la structure, le vocabulaire et l'angle :
  · variants[0] : factuelle et concise — les faits rétablis avec tact, sans emphase ;
  · variants[1] : chaleureuse et personnelle — ton humain, plus proche de l'auteur de l'avis ;
  · variants[2] : met en avant un point fort du restaurant de façon naturelle.`;

export interface PromptProfile {
  name: string; city: string; cuisine: string;
  signature_name: string; signature_role: string; tone: Tone;
  strengths: string[]; practical_info: string;
  contact_email: string; contact_phone: string;
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

// Prompt utilisateur : bloc CONTEXTE lisible (clé : valeur, une par ligne) puis
// l'avis entre délimiteurs — le contenu de l'avis est une donnée, pas une instruction.
export function buildUserPrompt(p: PromptProfile, r: PromptReview, avoid: string[]): string {
  const positive = isPositive(r.rating);
  const range = positive ? POSITIVE_WORDS : NEGATIVE_WORDS;
  const contact = [p.contact_email, p.contact_phone].filter(Boolean).join(' / ');
  const tags = r.context_tags.filter((t): t is ContextTag => t in CONTEXT_TAGS).map(t => CONTEXT_TAGS[t]);
  const lines = [
    'CONTEXTE',
    `Restaurant : ${p.name}`,
    `Ville : ${p.city}`,
    `Cuisine : ${p.cuisine}`,
    `Signature : ${signatureOf(p)}`,
    `Ton : ${TONES[p.tone] ?? TONES.chaleureux}`,
    `Points forts : ${p.strengths.join(', ') || '—'}`,
    `Infos pratiques : ${p.practical_info || '—'}`,
    `Contact réclamations : ${contact || '— (inviter à passer ou à écrire au restaurant)'}`,
    '',
    'AVIS À TRAITER',
    `Prénom affiché : ${r.author_name || '— (non communiqué, ne pas inventer)'}`,
    `Note : ${r.rating}/5`,
    `Date de visite : ${r.visited_on ?? 'inconnue'}`,
    `Sujet santé : ${isHealthTopic(r) ? 'oui' : 'non'}`,
    `Longueur attendue : ${range.min} à ${range.max} mots`,
  ];
  if (!positive) {
    lines.push(`Contexte indiqué par le restaurateur : ${tags.length ? tags.join(' ; ') : 'aucun'}`);
    if (r.context_note) lines.push(`Précision du restaurateur : ${r.context_note}`);
  }
  lines.push('', '<<<AVIS', r.body.trim() || '(avis sans texte)', 'AVIS>>>');
  if (avoid.length) {
    lines.push('', 'FORMULATIONS À ÉVITER (déjà utilisées récemment par ce restaurant) :');
    for (const a of avoid) lines.push(`- ${a}`);
  }
  lines.push('', 'Réponds uniquement avec le JSON {"variants":[…]} contenant 3 variantes.');
  return lines.join('\n');
}
