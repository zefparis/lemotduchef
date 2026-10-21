// Indicateurs simples « avis potentiellement contraire aux règles Google »,
// calculés à partir des seules informations saisies. Ce sont des indices,
// pas des preuves : Google ne retire que les avis contraires à SES règles
// (contenu), jamais les avis simplement injustes ou sévères.

export type Flag = 'no_text_low_rating' | 'off_topic' | 'other_business' | 'insults' | 'conflict_of_interest' | 'spam' | 'unknown_customer' | 'defamatory';

const RESTAURANT_WORDS = /\b(plat|plats|service|serveur|serveuse|serveurs|repas|menu|carte|cuisine|dessert|entr[ée]e|table|r[ée]serv|addition|prix|attente|attendu|pizza|burger|vin|terrasse|chef|mang[ée]|d[iî]ner|d[ée]jeuner|go[uû]t|portion|accueil|ambiance|d[ée]licieux|froid|chaud|sauce|viande|poisson|frites|salade|caf[ée]|boisson|cuit|cuisson|commande|commandé|assiette|personnel|patron|propri[ée]taire|restaurant|resto|brasserie|bistrot|p[âa]tes|fromage|pain|tarif|cher|rapport qualit[ée]|bon|bonne|excellent|moyen|d[ée]cevant|sale|propre|bruyant|calme|livraison|emporter)\b/i;
const OTHER_BUSINESS = /(pas le bon (restaurant|établissement|etablissement)|mauvais (restaurant|établissement|etablissement)|je me suis tromp|confondu|autre adresse|autre restaurant|homonyme|ce n'est pas (ici|chez vous)|jamais mis les pieds)/i;
const INSULTS = /\b(connard|connasse|conne|con|salaud|salope|enculé|encule|pute|pd|bâtard|batard|abruti|débile|debile|crétin|cretin|pourriture|ordure|fdp|ntm|nique|niquer|merdeux|merdique|dégueulasse de merde|sale (arabe|noir|juif|chinois|blanc)|bougnoule|négro|negro|youpin)\b/i;
const DEFAMATORY = /\b(escroc|escrocs|escroquerie|arnaque|arnaqueur|arnaqueurs|voleur|voleurs|vol manifeste|mafia|blanchiment|travail au noir|clandestin|rats?\b.*cuisine|cafards partout)\b/i;
const CONFLICT = /\b(mon restaurant|notre restaurant|je travaille (ici|chez)|ancien employ|ex-employ|ancien salari|concurrent|en face|mon établissement|mon etablissement)\b/i;
const SPAM = /(https?:\/\/|www\.|\.com\b|\.fr\b|whatsapp|code promo|promo code|telegram|crypto|bitcoin|\+?\d[\d\s.-]{8,}\d)/i;

export function computeFlags(input: { rating: number; body: string; context_tags: string[] }): Flag[] {
  const flags = new Set<Flag>();
  const body = input.body.trim();
  if (input.rating <= 2 && body.length < 10) flags.add('no_text_low_rating');
  if (body.length > 60 && !RESTAURANT_WORDS.test(body)) flags.add('off_topic');
  if (OTHER_BUSINESS.test(body)) flags.add('other_business');
  if (INSULTS.test(body)) flags.add('insults');
  if (DEFAMATORY.test(body)) flags.add('defamatory');
  if (CONFLICT.test(body)) flags.add('conflict_of_interest');
  if (SPAM.test(body)) flags.add('spam');
  if (input.context_tags.includes('unknown_customer') && input.rating <= 3) flags.add('unknown_customer');
  return [...flags];
}

export const FLAG_LABELS: Record<Flag, string> = {
  no_text_low_rating: 'Note très basse sans aucun texte',
  off_topic: 'Contenu sans rapport avec une expérience au restaurant',
  other_business: 'Semble viser un autre établissement',
  insults: 'Propos injurieux ou haineux',
  defamatory: 'Accusations graves non étayées (escroquerie, vol…)',
  conflict_of_interest: 'Conflit d’intérêts possible (concurrent, ancien employé)',
  spam: 'Lien, numéro ou contenu promotionnel',
  unknown_customer: 'Client inconnu de vos registres (déclaré par vous)',
};

// Catégories du formulaire de signalement Google (« Signaler un avis »).
export type GoogleReason = 'off_topic' | 'spam' | 'conflict_of_interest' | 'profanity' | 'bullying_harassment' | 'discrimination_hate' | 'personal_information';
const REASON_LABELS: Record<GoogleReason, string> = {
  off_topic: 'Hors sujet',
  spam: 'Spam',
  conflict_of_interest: 'Conflit d’intérêts',
  profanity: 'Vulgarité',
  bullying_harassment: 'Harcèlement ou intimidation',
  discrimination_hate: 'Discrimination ou incitation à la haine',
  personal_information: 'Informations personnelles',
};

export const GOOGLE_HELP_URL = 'https://support.google.com/business/answer/4596773';
export const GOOGLE_POLICY_URL = 'https://support.google.com/contributionpolicy/answer/7400114';

export interface ReportGuide {
  suspicious: boolean;
  flags: Flag[];
  flagLabels: string[];
  reason: GoogleReason | null;
  reasonLabel: string | null;
  text: string | null;
  helpUrl: string;
  policyUrl: string;
  notice: string;
}

export function reportGuide(flags: Flag[], restaurantName: string): ReportGuide {
  const notice = 'Google ne retire que les avis contraires à ses règles de contenu (hors sujet, spam, conflit d’intérêts, injures, informations personnelles…). Un avis sévère, injuste ou que vous contestez n’est pas supprimé pour autant : la meilleure réponse reste une réponse publique posée.';
  if (!flags.length) return { suspicious: false, flags, flagLabels: [], reason: null, reasonLabel: null, text: null, helpUrl: GOOGLE_HELP_URL, policyUrl: GOOGLE_POLICY_URL, notice };
  let reason: GoogleReason;
  if (flags.includes('insults')) reason = 'discrimination_hate';
  else if (flags.includes('spam')) reason = 'spam';
  else if (flags.includes('conflict_of_interest')) reason = 'conflict_of_interest';
  else if (flags.includes('other_business') || flags.includes('off_topic')) reason = 'off_topic';
  else if (flags.includes('defamatory')) reason = 'bullying_harassment';
  else reason = 'spam'; // note sans texte / client inconnu : faux avis présumé
  const detail = flags.map(f => FLAG_LABELS[f].toLowerCase()).join(' ; ');
  const text = `Bonjour, je suis le gérant de ${restaurantName}. Je signale cet avis car il me semble contraire aux règles de contenu de Google : ${detail}. ${flags.includes('unknown_customer') || flags.includes('no_text_low_rating') ? 'Aucune visite correspondant à cet avis ne figure dans nos registres (réservations, tickets), et l’avis ne décrit aucune expérience concrète.' : 'Il ne reflète pas une expérience réelle de client dans notre établissement.'} Merci de bien vouloir l’examiner.`;
  return { suspicious: true, flags, flagLabels: flags.map(f => FLAG_LABELS[f]), reason, reasonLabel: REASON_LABELS[reason], text, helpUrl: GOOGLE_HELP_URL, policyUrl: GOOGLE_POLICY_URL, notice };
}
