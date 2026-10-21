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
          system: req.system,
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
    const text = (data?.content ?? []).filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n');
    return {
      text,
      inputTokens: Number(data?.usage?.input_tokens ?? 0),
      outputTokens: Number(data?.usage?.output_tokens ?? 0),
      model: String(data?.model ?? config.llm.model),
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
    return { text, inputTokens: Math.ceil((req.system.length + req.user.length) / 4), outputTokens: Math.ceil(text.length / 4), model: 'mock' };
  }
}

function field(user: string, key: string): string {
  const m = new RegExp(`^${key}\\s*:\\s*(.*)$`, 'm').exec(user);
  return m?.[1]?.trim() ?? '';
}
export function mockVariants(user: string): string {
  const restaurant = field(user, 'Restaurant') || 'notre restaurant';
  const city = field(user, 'Ville');
  const sig = field(user, 'Signature') || 'L’équipe';
  const author = field(user, 'Prénom affiché') || '';
  const rating = parseInt(field(user, 'Note') || '5', 10);
  const strength = (field(user, 'Points forts').split(',')[0] || 'notre cuisine faite maison').trim();
  const contact = field(user, 'Contact réclamations');
  const health = /oui/i.test(field(user, 'Sujet santé'));
  const hello = author ? `Bonjour ${author},` : 'Bonjour,';
  const place = city ? `${restaurant} à ${city}` : restaurant;
  const variants: string[] = [];
  if (rating >= 4) {
    variants.push(
      `${hello} merci infiniment pour ce retour chaleureux. Nous sommes ravis que votre moment chez ${place} vous ait plu, et nous transmettrons vos compliments à toute l’équipe. ${strength.charAt(0).toUpperCase() + strength.slice(1)} reste au cœur de ce que nous aimons partager. Au plaisir de vous accueillir à nouveau très bientôt.\n${sig}`,
      `${hello} quel plaisir de lire ces mots. Toute l’équipe de ${restaurant} vous remercie pour votre confiance et votre gentillesse. Nous espérons vous retrouver prochainement pour un nouveau moment gourmand autour de ${strength}. À très vite !\n${sig}`,
      `${hello} un grand merci pour votre visite et pour ce commentaire qui nous touche. Savoir que vous avez apprécié votre expérience chez ${restaurant} est notre plus belle récompense. Nous vous attendons avec plaisir pour une prochaine occasion.\n${sig}`,
    );
  } else {
    const invite = contact
      ? `Nous vous invitons à nous contacter directement (${contact}) afin d’échanger sereinement.`
      : 'Nous vous invitons à nous contacter directement afin d’échanger sereinement.';
    const facts = health
      ? 'Nous prenons votre message très au sérieux et sommes sincèrement désolés que vous vous soyez senti mal après votre visite. Nos procédures d’hygiène et de traçabilité sont rigoureuses et nous souhaitons comprendre précisément ce qui s’est passé.'
      : 'Nous sommes surpris par votre description, qui ne correspond pas à l’attention que nous portons chaque jour à nos clients, et nous souhaitons comprendre ce qui a pu vous décevoir.';
    variants.push(
      `${hello} merci d’avoir pris le temps de partager votre ressenti. ${facts} ${invite} Chez ${place}, ${strength} et l’accueil de chacun nous tiennent à cœur, et nous serions heureux de vous le prouver lors d’une prochaine visite.\n${sig}`,
      `${hello} nous vous remercions pour votre message, même s’il nous attriste. ${facts} ${invite} Nous espérons avoir l’occasion de vous faire découvrir ce qui fait la réputation de ${restaurant} : ${strength} et une équipe attentive à chaque table.\n${sig}`,
      `${hello} nous avons lu votre commentaire avec attention et regrettons que votre expérience n’ait pas été à la hauteur. ${facts} ${invite} Nous tenons à ce que chaque client reparte satisfait de ${restaurant}, et nous serions ravis de vous accueillir de nouveau pour vous faire goûter ${strength}.\n${sig}`,
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
