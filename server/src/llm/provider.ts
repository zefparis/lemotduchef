import { config } from '../config.js';

// Fournisseur LLM : appelé côté serveur uniquement. L'interface est volontairement
// minimale (un tour système + utilisateur → texte + usage) pour rester
// interchangeable (Anthropic aujourd'hui, mock en dev/tests).

export interface LlmRequest {
  system: string;
  user: string;
  maxTokens: number;
}
export interface LlmResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
  stopReason: string;
}
export interface LlmProvider {
  readonly name: string;
  complete(req: LlmRequest, signal: AbortSignal): Promise<LlmResult>;
}

export class LlmError extends Error {
  constructor(message: string, public readonly kind: 'config' | 'timeout' | 'upstream' | 'format') {
    super(message);
  }
}

/* ---------- Anthropic (Messages API, sans SDK) ---------- */
// Réflexion interne désactivée : ~10× moins de jetons de sortie et de latence.
// Sur claude-sonnet-5.5, « disabled » est refusé (400) — « between_tools » est
// le réglage minimal équivalent.
const thinkingFor = (model: string) =>
  /sonnet-5-5|sonnet-5\.5/.test(model) ? { type: 'between_tools' } : { type: 'disabled' };

// Sortie structurée forcée par un outil : le modèle remplit input.variants,
// ce qui garantit un JSON valide quel que soit le babillage autour.
const REPLY_TOOL = {
  name: 'submit_replies',
  description: 'Soumet les variantes de réponse rédigées (3 à la première demande, ou uniquement les positions à refaire ensuite), sans signature ni formule de clôture.',
  input_schema: {
    type: 'object',
    properties: {
      variants: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string' } },
    },
    required: ['variants'],
    additionalProperties: false,
  },
} as const;

export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';
  async complete(req: LlmRequest, signal: AbortSignal): Promise<LlmResult> {
    if (!config.llm.anthropicApiKey) throw new LlmError('ANTHROPIC_API_KEY manquante.', 'config');
    let res: Response;
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': config.llm.anthropicApiKey,
          'anthropic-version': '2023-06-01',
        },
        // Aucun paramètre d'échantillonnage (temperature/top_p/top_k) : les
        // modèles récents les refusent. La diversité des variantes vient de
        // la consigne de style du prompt, pas de la température.
        body: JSON.stringify({
          model: config.llm.model,
          max_tokens: req.maxTokens,
          thinking: thinkingFor(config.llm.model),
          system: req.system,
          tools: [REPLY_TOOL],
          tool_choice: { type: 'tool', name: REPLY_TOOL.name },
          messages: [{ role: 'user', content: req.user }],
        }),
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw new LlmError('Le rédacteur met trop de temps à répondre.', 'timeout');
      throw new LlmError('Fournisseur LLM injoignable.', 'upstream');
    }
    if (!res.ok) {
      // Le détail (clé invalide, quota…) reste dans les logs serveur, jamais côté client.
      const detail = await res.text().catch(() => '');
      const e = new LlmError(`Fournisseur LLM en erreur (${res.status}).`, 'upstream');
      (e as any).detail = detail.slice(0, 500);
      throw e;
    }
    const data: any = await res.json();
    const blocks = (data?.content ?? []) as any[];
    const toolUse = blocks.find(c => c?.type === 'tool_use' && Array.isArray(c?.input?.variants));
    const text = toolUse
      ? JSON.stringify({ variants: toolUse.input.variants })
      : blocks.filter(c => c?.type === 'text').map(c => c.text).join('\n');
    return {
      text,
      inputTokens: Number(data?.usage?.input_tokens ?? 0),
      outputTokens: Number(data?.usage?.output_tokens ?? 0),
      model: String(data?.model ?? config.llm.model),
      stopReason: String(data?.stop_reason ?? ''),
    };
  }
}

/* ---------- Mock (dev / tests) ----------
   Produit 3 variantes déterministes respectant les règles à partir du bloc
   « CONTEXTE » du prompt utilisateur. Refusé en production. */
export class MockProvider implements LlmProvider {
  readonly name = 'mock';
  constructor(private readonly override?: (req: LlmRequest) => string) {}
  async complete(req: LlmRequest): Promise<LlmResult> {
    const text = this.override ? this.override(req) : mockVariants(req.user);
    return { text, inputTokens: Math.ceil((req.system.length + req.user.length) / 4), outputTokens: Math.ceil(text.length / 4), model: 'mock', stopReason: 'end_turn' };
  }
}

function field(user: string, key: string): string {
  const m = new RegExp(`^${key}\\s*:\\s*(.*)$`, 'm').exec(user);
  return m?.[1]?.trim() ?? '';
}
// Variant ~50-58 mots (négatif) / ~40-52 mots (positif) : dans le recouvrement
// des fourchettes court/long, donc conformes quel que soit l'avis. Trois angles
// distincts (factuel / chaleureux / point fort), vocabulaire volontairement
// disjoint pour passer le contrôle de similarité.
// Variantes sans signature (ajoutée par le code, comme en production) :
// ~48-56 mots en négatif, ~40-52 en positif — dans le recouvrement des
// fourchettes court/long. Angles distincts (factuel / chaleureux / point
// fort imposé), un seul point fort cité par variante (celui du CONTEXTE),
// email dans 2 variantes max, aucun fait interne inventé.
export function mockVariants(user: string): string {
  const restaurant = field(user, 'Restaurant') || 'notre restaurant';
  const rawAuthor = field(user, 'Auteur') || field(user, 'Prénom affiché') || '';
  const author = /^(—|non communiqué)/i.test(rawAuthor)
    || /^(anonyme|anonymous|inconnu|client|google|user|utilisateur|membre)\b/i.test(rawAuthor)
    || rawAuthor.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/gi, '').length < 2
    ? '' : rawAuthor;
  const rating = parseInt(field(user, 'Note') || '5', 10);
  const s2 = /variante 2 (?:= |peut citer )?« ([^»]+) »/.exec(user)?.[1] ?? '';
  const s3 = /variante 3 (?:= |peut citer )?« ([^»]+) »/.exec(user)?.[1] ?? '';
  const rawContact = field(user, 'Contact réclamations');
  const contact = rawContact.startsWith('—') ? '' : rawContact;
  const health = /oui/i.test(field(user, 'Sujet santé'));
  const hello = author ? `Bonjour ${author},` : 'Bonjour,';
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const reach = contact ? ` à ${contact}` : ' au restaurant';
  const variants: string[] = [];
  if (rating >= 4) {
    variants.push(
      `${hello} merci pour ce retour précis et généreux : ravis que votre moment chez ${restaurant} vous ait plu. C’est exactement l’expérience que toute l’équipe s’attache à offrir chaque jour, avec attention, à chaque table.`,
      s2
        ? `${hello} quel plaisir de vous lire ce matin. Vos mots ont fait sourire toute la maison, et ${s2} est précisément ce que nous aimons partager à chaque service. On espère vous retrouver très vite autour d’une table.`
        : `${hello} quel plaisir de vous lire ce matin. Vos mots ont fait sourire toute la maison, et nous vous remercions d’avoir pris le temps de les partager. On espère vous retrouver très vite autour d’une table.`,
      s3
        ? `${hello} votre message illumine notre journée entière. ${cap(s3)} est au cœur de ce que nous aimons partager chez ${restaurant} ; savoir que cela vous a touché est la plus belle des récompenses. À très bientôt.`
        : `${hello} votre message illumine notre journée entière. Savoir que ce moment vous a touché est la plus belle des récompenses pour toute l’équipe de ${restaurant}. À très bientôt, avec plaisir.`,
    );
  } else if (health) {
    variants.push(
      `${hello} votre message nous touche : le bien-être de nos clients passe avant tout, et nous lisons le vôtre avec la plus grande attention. L’hygiène est chez nous une discipline de tous les instants, partagée par toute l’équipe. Contactez-nous${reach} pour que nous comprenions ce qui s’est passé.`,
      `${hello} nous entendons votre inquiétude et elle nous tient à cœur. Chez nous, l’hygiène n’est pas un argument mais une exigence quotidienne, tenue par toute l’équipe sans relâche. Joignez-nous directement${reach} : nous prendrons tout le temps nécessaire pour comprendre ensemble ce qui s’est passé.`,
      `${hello} la confiance de nos clients est ce que nous défendons le plus${s3 ? `, avec ${s3}` : ''} et une exigence d’hygiène de tous les instants, à chaque service — toute l’équipe y veille. Pour comprendre votre expérience, contactez-nous directement au restaurant : vous aurez une réponse personnelle et attentionnée.`,
    );
  } else {
    variants.push(
      `${hello} votre retour appelle une réponse claire : ce que vous décrivez n’est pas le niveau de service que nous voulons proposer. Votre retour est transmis à l’équipe, en salle comme en cuisine, et nous en parlons dès aujourd’hui pour bien mieux faire à chaque service.`,
      `${hello} lire votre avis n’est pas un moment agréable, et nous le regardons en face. Votre soirée aurait dû être belle ; qu’elle ne l’ait pas été nous importe vraiment. ${s2 ? `${cap(s2)} n’en reste pas moins notre fierté quotidienne. ` : ''}Écrivez-nous${reach} si vous souhaitez en parler de vive voix.`,
      `${hello} ce que vous décrivez est l’inverse de ce que nous défendons chaque jour${s3 ? ` : ${s3} et une attention sincère portée à chaque table` : ' : une attention sincère portée à chaque table'}. Nous serions heureux de vous le prouver lors d’une prochaine visite, quand vous le souhaiterez, en toute simplicité et avec le sourire.`,
    );
  }
  return JSON.stringify({ variants });
}

/* ---------- Sélection ---------- */
let current: LlmProvider | null = null;
export function llmProvider(): LlmProvider {
  if (current) return current;
  if (config.llm.provider === 'mock') {
    if (config.isProd) throw new LlmError('LLM_PROVIDER=mock est interdit en production.', 'config');
    current = new MockProvider();
  } else current = new AnthropicProvider();
  return current;
}
// Injection pour les tests (sortie contrôlée, aucun réseau).
export function setLlmProvider(p: LlmProvider | null) { current = p; }
export const llmConfigured = () =>
  config.llm.provider === 'mock' ? !config.isProd : !!config.llm.anthropicApiKey;
