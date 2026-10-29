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
      // Traduction de chaque variante dans la langue de l'interface,
      // demandée seulement quand l'avis n'est pas dans cette langue.
      translations: { type: 'array', minItems: 0, maxItems: 3, items: { type: 'string' } },
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
    const trs = (toolUse?.input?.translations ?? []).filter((t: unknown) => typeof t === 'string' && t.trim());
    const text = toolUse
      ? JSON.stringify(trs.length ? { variants: toolUse.input.variants, translations: trs } : { variants: toolUse.input.variants })
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
// Gabarits de test par langue : ~45-55 mots, angles distincts (factuel /
// chaleureux / point fort), ouverture + invitation conformes aux packs.
const MOCK_STUBS: Record<string, { greet: string; pos: string[]; neg: string[]; reach: string; healthPos: string[] }> = {
  en: {
    greet: 'Hello',
    pos: [
      'thank you for this precise and generous feedback: we are glad your moment with us pleased you. This is exactly the experience the whole team strives to offer every day, with care, at every table.',
      'what a pleasure to read you this morning. Your words made the whole house smile, and we thank you for taking the time to share them. We hope to see you again very soon around a table.',
      'your message lights up our entire day. Knowing that this moment touched you is the finest reward for our whole team. See you very soon, with pleasure.',
    ],
    neg: [
      'your feedback calls for a clear answer: what you describe is not the level of service we want to offer. Your feedback is passed on to the team, and we discuss it today to do much better at every service. We hope to welcome you back on a next visit.',
      'reading your review is not a pleasant moment, and we face it honestly. Your evening should have been beautiful; that it was not truly matters to us. Write to us at {reach} to talk about it; you are welcome whenever you wish to return.',
      'what you describe is the opposite of what we stand for every day: sincere attention brought to every table. We would be glad to prove it on a next visit, whenever you wish, simply and with a smile.',
    ],
    healthPos: [
      'your message touches us: our customers\u2019 wellbeing comes first, and we read yours with the greatest attention. Hygiene is for us a discipline of every instant, shared by the whole team. Contact us at {reach} so we can understand what happened.',
      'we hear your concern and it matters to us. With us, hygiene is not an argument but a daily requirement, upheld by the whole team. Reach us directly at {reach}: we will take all the time needed to understand together.',
      'our customers\u2019 trust is what we defend most, with a hygiene requirement of every instant at each service. To understand your experience, contact us directly at the restaurant: you will get a personal, attentive answer.',
    ],
    reach: 'the restaurant',
  },
  af: {
    greet: 'Goeiedag',
    pos: [
      'dankie vir hierdie presiese en vrygewige terugvoer: ons is bly jou oomblik by ons het jou behaag. Dis presies die ervaring wat die hele span elke dag met sorg aan elke tafel wil bied.',
      'watter plesier om jou vanoggend te lees. Jou woorde het die hele huis laat glimlag, en ons bedank jou dat jy die tyd geneem het om hulle te deel. Ons hoop om jou gou weer om \u2018n tafel te sien.',
      'jou boodskap verlig ons hele dag. Om te weet hierdie oomblik het jou geraak is die mooiste beloning vir die hele span. Tot baie gou, met plesier.',
    ],
    neg: [
      'jou terugvoer vra \u2018n duidelike antwoord: wat jy beskryf is nie die diensvlak wat ons wil bied nie. Jou terugvoer word aan die span oorgedra, en ons praat vandag daaroor om by elke diens veel beter te doen. Ons hoop om jou by \u2018n volgende besoek te verwelkom.',
      'om jou resensie te lees is nie \u2018n aangename oomblik nie, en ons kyk dit eerlik in die gesig. Jou aand mooi moes gewees het; dat dit nie was nie raak ons werklik. Skryf aan ons by {reach} om daaroor te praat; jy is welkom wanneer jy wil terugkeer.',
      'wat jy beskryf is die teenoorgestelde van waarvoor ons elke dag staan: opregte aandag aan elke tafel. Ons sal dit graag by \u2018n volgende besoek bewys, wanneer jy wil, eenvoudig en met \u2018n glimlag.',
    ],
    healthPos: [
      'jou boodskap raak ons: ons klante se welsyn kom eerste, en ons lees joune met die grootste aandag. Higiene is by ons \u2018n dissipline van elke oomblik, deur die hele span gedeel. Kontak ons by {reach} sodat ons kan verstaan wat gebeur het.',
      'ons hoor jou kommer en dit raak ons. By ons is higiene nie \u2018n argument nie maar \u2018n daaglikse vereiste, deur die hele span gehandhaaf. Bereik ons direk by {reach}: ons sal al die tyd neem om saam te verstaan.',
      'ons klante se vertroue is wat ons die meeste verdedig, met \u2018n higienevereiste van elke oomblik by elke diens. Om jou ervaring te verstaan, kontak ons direk by die restaurant: jy sal \u2018n persoonlike, aandagtige antwoord kry.',
    ],
    reach: 'die restaurant',
  },
  de: {
    greet: 'Guten Tag',
    pos: [
      'vielen Dank für diese präzise und großzügige Rückmeldung: wir freuen uns, dass Ihr Moment bei uns Ihnen gefallen hat. Genau dieses Erlebnis will das ganze Team jeden Tag mit Sorgfalt an jedem Tisch bieten.',
      'was für ein Vergnügen, Sie heute Morgen zu lesen. Ihre Worte haben das ganze Haus zum Lächeln gebracht, und wir danken Ihnen, dass Sie sich die Zeit zum Teilen genommen haben. Wir hoffen, Sie bald wieder an einem Tisch zu sehen.',
      'Ihre Nachricht erhellt unseren ganzen Tag. Zu wissen, dass dieser Moment Sie berührt hat, ist die schönste Belohnung für unser ganzes Team. Bis bald, mit Freude.',
    ],
    neg: [
      'Ihre Rückmeldung verlangt eine klare Antwort: was Sie beschreiben ist nicht das Serviceniveau, das wir bieten wollen. Ihre Rückmeldung wird an das Team weitergegeben, und wir besprechen sie heute, um bei jedem Service viel besser zu werden. Wir hoffen, Sie bei einem nächsten Besuch zu begrüßen.',
      'Ihre Bewertung zu lesen ist kein angenehmer Moment, und wir sehen ihr ehrlich ins Auge. Ihr Abend hätte schön sein sollen; dass er es nicht war, berührt uns wirklich. Schreiben Sie uns unter {reach}, um darüber zu sprechen; Sie sind willkommen, wann immer Sie wiederkommen möchten.',
      'was Sie beschreiben ist das Gegenteil dessen, wofür wir jeden Tag stehen: aufrichtige Aufmerksamkeit an jedem Tisch. Wir würden es gern bei einem nächsten Besuch beweisen, wann immer Sie möchten, schlicht und mit einem Lächeln.',
    ],
    healthPos: [
      'Ihre Nachricht berührt uns: das Wohlbefinden unserer Gäste steht an erster Stelle, und wir lesen Ihre mit größter Aufmerksamkeit. Hygiene ist bei uns eine Disziplin jedes Augenblicks, geteilt vom ganzen Team. Kontaktieren Sie uns unter {reach}, damit wir verstehen, was passiert ist.',
      'wir hören Ihre Sorge und sie bewegt uns. Bei uns ist Hygiene kein Argument, sondern eine tägliche Anforderung, die das ganze Team hochhält. Erreichen Sie uns direkt unter {reach}: wir nehmen uns alle Zeit, um gemeinsam zu verstehen.',
      'das Vertrauen unserer Gäste verteidigen wir am meisten, mit einer Hygieneanforderung jedes Augenblicks bei jedem Service. Um Ihre Erfahrung zu verstehen, kontaktieren Sie uns direkt im Restaurant: Sie bekommen eine persönliche, aufmerksame Antwort.',
    ],
    reach: 'im Restaurant',
  },
  nl: {
    greet: 'Beste',
    pos: [
      'bedankt voor deze precieze en gulle terugkoppeling: we zijn blij dat uw moment bij ons u bevallen is. Dit is precies de ervaring die het hele team elke dag met zorg aan elke tafel wil bieden.',
      'wat een plezier om u vanochtend te lezen. Uw woorden brachten het hele huis aan het glimlachen, en we danken u dat u de tijd nam ze te delen. We hopen u snel weer aan een tafel te zien.',
      'uw bericht verlicht onze hele dag. Weten dat dit moment u raakte is de mooiste beloning voor ons hele team. Tot snel, met plezier.',
    ],
    neg: [
      'uw terugkoppeling vraagt een duidelijk antwoord: wat u beschrijft is niet het serviceniveau dat we willen bieden. Uw terugkoppeling wordt aan het team doorgegeven, en we bespreken het vandaag om bij elke dienst veel beter te doen. We hopen u bij een volgend bezoek te verwelkomen.',
      'uw recensie lezen is geen aangenaam moment, en we kijken het eerlijk aan. Uw avond had mooi moeten zijn; dat hij het niet was raakt ons echt. Schrijf ons via {reach} om erover te praten; u bent welkom wanneer u wilt terugkeren.',
      'wat u beschrijft is het tegenovergestelde van waar we elke dag voor staan: oprechte aandacht aan elke tafel. We zouden het graag bij een volgend bezoek bewijzen, wanneer u wilt, eenvoudig en met een glimlach.',
    ],
    healthPos: [
      'uw bericht raakt ons: het welzijn van onze gasten staat voorop, en we lezen het uwe met de grootste aandacht. Hygiëne is bij ons een discipline van elk ogenblik, gedeeld door het hele team. Neem contact op via {reach} zodat we begrijpen wat er gebeurde.',
      'we horen uw bezorgdheid en die raakt ons. Bij ons is hygiëne geen argument maar een dagelijkse eis, hooggehouden door het hele team. Bereik ons direct via {reach}: we nemen alle tijd om samen te begrijpen.',
      'het vertrouwen van onze gasten verdedigen we het meest, met een hygiëne-eis van elk ogenblik bij elke dienst. Om uw ervaring te begrijpen, neem direct contact op met het restaurant: u krijgt een persoonlijk, attent antwoord.',
    ],
    reach: 'het restaurant',
  },
  es: {
    greet: 'Hola',
    pos: [
      'gracias por esta valoración precisa y generosa: nos alegra que su momento con nosotros le haya gustado. Esta es exactamente la experiencia que todo el equipo se esfuerza por ofrecer cada día, con cuidado, en cada mesa.',
      'qué placer leerle esta mañana. Sus palabras hicieron sonreír a toda la casa, y le agradecemos que se tomara el tiempo de compartirlas. Esperamos verle muy pronto alrededor de una mesa.',
      'su mensaje ilumina todo nuestro día. Saber que este momento le conmovió es la más bella recompensa para todo nuestro equipo. Hasta muy pronto, con gusto.',
    ],
    neg: [
      'su valoración pide una respuesta clara: lo que describe no es el nivel de servicio que queremos ofrecer. Su comentario se transmite al equipo, y lo discutimos hoy para hacerlo mucho mejor en cada servicio. Esperamos darle la bienvenida en una próxima visita.',
      'leer su reseña no es un momento agradable, y lo miramos con honestidad. Su velada debió ser bonita; que no lo fuera nos importa de verdad. Escríbanos a {reach} para hablar de ello; es bienvenido cuando desee volver.',
      'lo que describe es lo contrario de lo que defendemos cada día: atención sincera en cada mesa. Nos encantaría demostrarlo en una próxima visita, cuando lo desee, con sencillez y una sonrisa.',
    ],
    healthPos: [
      'su mensaje nos conmueve: el bienestar de nuestros clientes es lo primero, y leemos el suyo con la mayor atención. La higiene es para nosotros una disciplina de cada instante, compartida por todo el equipo. Contáctenos en {reach} para que podamos entender lo que ocurrió.',
      'escuchamos su preocupación y nos importa. Con nosotros, la higiene no es un argumento sino una exigencia diaria, sostenida por todo el equipo. Escríbanos directamente a {reach}: nos tomaremos todo el tiempo necesario para entender juntos.',
      'la confianza de nuestros clientes es lo que más defendemos, con una exigencia de higiene de cada instante en cada servicio. Para entender su experiencia, contáctenos directamente en el restaurante: tendrá una respuesta personal y atenta.',
    ],
    reach: 'el restaurante',
  },
  it: {
    greet: 'Buongiorno',
    pos: [
      'grazie per questo riscontro preciso e generoso: siamo felici che il vostro momento da noi vi sia piaciuto. Questa è esattamente l\u2019esperienza che tutta la squadra si impegna a offrire ogni giorno, con cura, a ogni tavolo.',
      'che piacere leggervi stamattina. Le vostre parole hanno fatto sorridere tutta la casa, e vi ringraziamo per aver dedicato il tempo a condividerle. Speriamo di rivedervi prestissimo attorno a un tavolo.',
      'il vostro messaggio illumina tutta la nostra giornata. Sapere che questo momento vi ha toccato è la più bella ricompensa per tutta la squadra. A prestissimo, con piacere.',
    ],
    neg: [
      'il vostro riscontro chiede una risposta chiara: ciò che descrivete non è il livello di servizio che vogliamo offrire. Il vostro commento viene trasmesso alla squadra, e ne parliamo oggi per fare molto meglio a ogni servizio. Speriamo di darvi il benvenuto a una prossima visita.',
      'leggere la vostra recensione non è un momento piacevole, e la guardiamo con onestà. La vostra serata doveva essere bella; che non lo sia stata ci importa davvero. Scriveteci a {reach} per parlarne; siete i benvenuti quando vorrete tornare.',
      'ciò che descrivete è il contrario di ciò per cui lavoriamo ogni giorno: attenzione sincera a ogni tavolo. Saremmo felici di dimostrarvelo a una prossima visita, quando vorrete, con semplicità e un sorriso.',
    ],
    healthPos: [
      'il vostro messaggio ci tocca: il benessere dei nostri clienti viene prima di tutto, e leggiamo il vostro con la massima attenzione. L\u2019igiene è per noi una disciplina di ogni istante, condivisa da tutta la squadra. Contattateci a {reach} per capire cosa è successo.',
      'sentiamo la vostra preoccupazione e ci sta a cuore. Da noi l\u2019igiene non è un argomento ma un\u2019esigenza quotidiana, sostenuta da tutta la squadra. Scriveteci direttamente a {reach}: prenderemo tutto il tempo necessario per capire insieme.',
      'la fiducia dei nostri clienti è ciò che difendiamo di più, con un\u2019esigenza di igiene di ogni istante a ogni servizio. Per capire la vostra esperienza, contattateci direttamente al ristorante: avrete una risposta personale e attenta.',
    ],
    reach: 'il ristorante',
  },
};

function mockLang(user: string): string | null {
  const m = /^Reply language\s*:\s*(\S+)/m.exec(user)?.[1]?.toLowerCase() ?? '';
  return ({ anglais: 'en', afrikaans: 'af', allemand: 'de', néerlandais: 'nl', espagnol: 'es', italien: 'it' } as any)[m] ?? null;
}

export function mockVariants(user: string): string {
  const l = mockLang(user);
  if (l && MOCK_STUBS[l]) return mockVariantsLang(user, l);
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
      `${hello} la confiance de nos clients est ce que nous défendons le plus${s3 ? `, avec ${s3}` : ''} et une exigence d’hygiène de tous les instants, à chaque service : toute l’équipe y veille. Pour comprendre votre expérience, contactez-nous directement au restaurant : vous aurez une réponse personnelle et attentionnée.`,
    );
  } else {
    variants.push(
      `${hello} votre retour appelle une réponse claire : ce que vous décrivez n’est pas le niveau de service que nous voulons proposer. Votre retour est transmis à l’équipe, en salle comme en cuisine, et nous en parlons dès aujourd’hui pour bien mieux faire à chaque service. Nous espérons vous retrouver à une prochaine visite.`,
      `${hello} lire votre avis n’est pas un moment agréable, et nous le regardons en face. Votre soirée aurait dû être belle ; qu’elle ne l’ait pas été nous importe vraiment. ${s2 ? `${cap(s2)} n’en reste pas moins notre fierté quotidienne. ` : ''}Écrivez-nous${reach} pour en parler ; vous êtes le bienvenu quand vous voudrez revenir.`,
      `${hello} ce que vous décrivez est l’inverse de ce que nous défendons chaque jour${s3 ? ` : ${s3} et une attention sincère portée à chaque table` : ' : une attention sincère portée à chaque table'}. Nous serions heureux de vous le prouver lors d’une prochaine visite, quand vous le souhaiterez, en toute simplicité et avec le sourire.`,
    );
  }
  return JSON.stringify({ variants });
}

function mockVariantsLang(user: string, lang: string): string {
  const S = MOCK_STUBS[lang];
  const restaurant = field(user, 'Restaurant') || 'our restaurant';
  const rawAuthor = field(user, 'Author') || '';
  const author = /^(—|not provided|non communiqué)/i.test(rawAuthor)
    || rawAuthor.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/gi, '').length < 2
    ? '' : rawAuthor;
  const rating = parseInt(field(user, 'Rating') || '5', 10);
  const s2 = /variant 2 may cite « ([^»]+) »/.exec(user)?.[1] ?? '';
  const s3 = /variant 3 may cite « ([^»]+) »/.exec(user)?.[1] ?? '';
  const rawContact = field(user, 'Complaints contact');
  const contact = rawContact.startsWith('—') ? S.reach : rawContact;
  const health = /yes/i.test(field(user, 'Health topic'));
  const hello = author ? `${S.greet} ${author},` : `${S.greet},`;
  const fill = (s: string) => hello + ' ' + s.replaceAll('{reach}', contact).replaceAll('{name}', restaurant);
  const variants = rating >= 4 ? S.pos.map(fill)
    : health ? S.healthPos.map(fill)
    : S.neg.map((v, i) => fill(i === 1 && s2 ? v.replace('Write to us', `we value ${s2}; write to us`) : v));
  if (lang === 'en' && s3) variants[2] = variants[2].replace('sincere attention', `${s3}, with sincere attention`);
  return JSON.stringify({ variants, translations: variants.map(v => `[translation:${lang}] ` + v) });
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
