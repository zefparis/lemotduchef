// Détection de la langue d'un avis — déterministe, aucun appel réseau.
// Pondération par mots-outils distinctifs + bonus de caractères propres
// (ß, ñ, ¿). Langue minimale couverte : en, af, fr, de, nl, es, it.
// En cas d'ambiguïté ou d'avis trop court/vide : repli sur la langue du
// marché (fr ou en), jamais une langue inventée.

export type ReplyLang = 'fr' | 'en' | 'af' | 'de' | 'nl' | 'es' | 'it' | 'sw' | 'ln';
export const REPLY_LANGS: ReplyLang[] = ['fr', 'en', 'af', 'de', 'nl', 'es', 'it', 'sw', 'ln'];

export const LANG_NAMES: Record<ReplyLang, string> = {
  fr: 'français', en: 'anglais', af: 'afrikaans', de: 'allemand',
  nl: 'néerlandais', es: 'espagnol', it: 'italien', sw: 'swahili', ln: 'lingala',
};

// Listes pondérées : mots très distinctifs ×3, distinctifs ×2, communs ×1.
// (accents neutralisés avant comparaison, frontières de mots exactes)
// Le français a aussi son dictionnaire : mots partagés avec l'anglais
// (service, long, table…) ne doivent pas dévier un avis français.
const WORDS: Record<ReplyLang, Record<string, number>> = {
  fr: {
    le: 3, la: 3, les: 2, des: 2, un: 1, une: 2, et: 2, est: 1, était: 2,
    étaient: 2, très: 2, mais: 1, avec: 1, pour: 1, nous: 2, pas: 1, tout: 1,
    bien: 1, bon: 1, mauvais: 2, service: 1, plat: 2, plats: 2, attente: 2,
    froid: 2, froide: 2, addition: 2, cher: 1, chère: 1, accueil: 2,
    cuisine: 2, serveur: 2, serveuse: 3, équipe: 2, repas: 2, soir: 1,
    délicieux: 2, excellent: 1, jamais: 1, toujours: 1, trop: 1,
    vraiment: 2, recommande: 2, déçu: 3, déçue: 3, décevant: 2,
    déception: 2, retour: 1, table: 1, carte: 1, menu: 1, personnel: 1,
    propre: 1, lent: 1, lente: 1, notre: 1, votre: 1, dans: 1, sur: 1,
    ce: 1, cette: 1, qui: 1, que: 1, au: 1, aux: 1, ont: 1, été: 2,
    je: 1, il: 1, elle: 1, vous: 1, on: 1, là: 1, ici: 1, par: 1,
    déjà: 2, encore: 1, aussi: 1, donc: 1, car: 1, quand: 1, où: 1,
    mal: 1, merci: 1, bonjour: 2, cadre: 1, terrasse: 1, salle: 1,
    rapport: 1, qualité: 1, avons: 1, sommes: 1,
  },
  en: {
    the: 3, and: 2, was: 2, were: 2, is: 1, very: 1, but: 1, with: 1, for: 1,
    food: 2, service: 2, staff: 2, waiter: 3, waitress: 3, wait: 1, waited: 1,
    time: 1, delicious: 2, excellent: 2, however: 2, never: 1, always: 1,
    expensive: 2, price: 2, friendly: 2, rude: 2, had: 1, have: 1, we: 1,
    our: 1, my: 1, really: 2, too: 1, slow: 2, cold: 2, long: 1, great: 1,
    terrible: 2, good: 1, bad: 1, lovely: 2, table: 1, meal: 2, ordered: 2,
    minutes: 2, would: 1, not: 1, this: 1, that: 1, they: 1, you: 1, it: 1,
    are: 1, us: 1, out: 1, again: 2, back: 1, recommend: 2, worst: 2, best: 1,
    amazing: 2, disappointed: 3, disappointing: 3, overpriced: 3, bill: 2,
  },
  af: {
    die: 2, en: 1, is: 1, vir: 3, nie: 3, het: 2, ek: 3, jy: 3, ons: 2,
    was: 1, baie: 3, ook: 2, maar: 1, met: 1, sy: 2, haar: 2, hom: 2,
    dankie: 3, asseblief: 3, gehad: 3, sal: 2, sou: 2, kan: 1, moet: 2,
    wanneer: 3, waar: 1, wat: 2, hoe: 2, nog: 2, reeds: 3, heerlik: 2,
    kos: 2, ete: 2, etes: 2, diens: 2, personeel: 2, wag: 2, lank: 2,
    tyd: 2, koue: 2, beste: 2, ooit: 2, uitstekend: 3, werklik: 2,
    verskriklik: 3, gister: 3, geen: 2, prys: 2, duur: 2, vriendelik: 2,
    onvriendelik: 2, so: 1, te: 1, 'n': 1,
  },
  de: {
    der: 3, die: 2, das: 3, und: 2, ich: 2, wir: 2, nicht: 3, war: 2,
    waren: 2, sehr: 2, auch: 1, aber: 1, mit: 1, für: 3, auf: 1, dem: 1,
    den: 1, einen: 1, eine: 1, ist: 1, gut: 1, schlecht: 2, essen: 2,
    personal: 2, bedienung: 3, warten: 2, lange: 2, zeit: 1, lecker: 3,
    ausgezeichnet: 3, wirklich: 2, trotzdem: 2, schon: 1, wieder: 1,
    nie: 1, immer: 1, viel: 1, zu: 1, teuer: 3, preis: 1, freundlich: 2,
    unfreundlich: 2, kellner: 3, kellnerin: 3, karte: 1, küche: 2,
    gemütlich: 3, sauber: 2, dreckig: 2, minute: 1, minuten: 2,
  },
  nl: {
    de: 2, het: 2, een: 3, en: 1, is: 1, was: 1, waren: 2, niet: 3,
    wel: 2, heel: 2, erg: 2, echt: 3, ook: 1, maar: 1, met: 1, voor: 1,
    van: 1, zijn: 2, had: 1, goed: 1, slecht: 2, eten: 2, personeel: 2,
    bediening: 3, wachten: 2, lang: 1, tijd: 1, heerlijk: 3,
    uitstekend: 2, echter: 2, niets: 2, iets: 2, deze: 2, dit: 1, dat: 1,
    toch: 3, hoor: 2, duur: 2, prijs: 2, vriendelijk: 2, onvriendelijk: 2,
    ober: 3, serveerster: 3, kaart: 1, keuken: 2, gezellig: 3, schoon: 2,
    vies: 2, minuten: 2, nooit: 2, altijd: 1, weer: 1, terug: 1, je: 1,
    jouw: 1, jou: 1,
  },
  ln: {
    na: 3, ya: 3, mpe: 3, te: 2, mbote: 3, botika: 2, misala: 2,
    biloko: 2, boko: 1, oyo: 3, wana: 2, wapi: 3, soki: 3, lisusu: 3,
    ndako: 1, mesa: 3, bato: 2, bango: 2, ngai: 3, yo: 2, biso: 2,
    mingi: 3, mabe: 2, malamu: 3, kitoko: 2, ezali: 3, ezalaki: 2,
    nakotala: 1, nalati: 2, bolingo: 1, mbongo: 2, ntalo: 2, matali: 2,
    libulu: 2, lili: 1, ponga: 1, sali: 1, sala: 1, loba: 1, mpo: 2,
  },
  sw: {
    na: 3, ya: 3, kwa: 3, sana: 3, ni: 1, kwenye: 2, ili: 2, ndio: 2,
    chakula: 3, huduma: 3, meza: 3, mhudumu: 3, wafanyakazi: 3,
    lakini: 2, nzuri: 2, mbaya: 2, pole: 2, asante: 3, karibu: 3,
    tena: 2, ninyi: 2, bila: 2, kama: 1, wakati: 1, bei: 2, malipo: 2,
    nilikuwa: 3, tulikuwa: 3, kusubiri: 2, muda: 1, haraka: 2,
    polepole: 2, habari: 3, mimi: 2, wewe: 2, sisi: 2, kweli: 2,
    pesa: 2, nafuu: 2, ghali: 2, vizuri: 2, vibaya: 2, hivyo: 2,
    siku: 1, jambo: 2, mazuri: 2, mazima: 1, kipindi: 1, nilipata: 2,
    wakatiu: 1, tu: 1, kila: 1, hapa: 1, huko: 1, ndani: 1, nje: 1,
  },
  es: {
    el: 3, la: 3, los: 2, las: 2, y: 1, en: 1, de: 1, que: 2, un: 2,
    una: 2, es: 1, estaba: 2, muy: 2, también: 3, pero: 2, con: 1,
    para: 1, por: 1, fue: 2, comida: 2, servicio: 2, personal: 1,
    esperar: 2, tiempo: 1, delicioso: 3, excelente: 2, embargo: 3,
    nunca: 2, siempre: 2, caro: 2, precio: 2, amable: 2, mal: 1,
    bueno: 1, me: 1, mi: 1, está: 2, son: 1, fueron: 2, camarero: 3,
    camarera: 3, mesa: 2, carta: 1, cocina: 1, minutos: 2, sabor: 2,
    horrible: 2, fatal: 2, volver: 1, recomiendo: 3, frío: 2, fría: 2,
  },
  it: {
    il: 3, la: 3, i: 1, le: 2, e: 1, di: 1, che: 2, un: 2, una: 2,
    è: 2, era: 2, molto: 2, anche: 1, ma: 1, con: 1, per: 1, cibo: 2,
    servizio: 2, personale: 2, aspettare: 2, tempo: 1, buono: 1,
    cattivo: 2, delizioso: 3, eccellente: 2, tuttavia: 2, mai: 2,
    sempre: 1, caro: 1, prezzo: 2, gentile: 2, siamo: 2, non: 1,
    sono: 1, hanno: 1, avevano: 1, questo: 1, questa: 1, davvero: 2,
    troppo: 2, cameriere: 3, cameriera: 3, tavolo: 2, cucina: 1,
    minuti: 2, sapore: 2, orribile: 2, pessimo: 2, tornerò: 3,
    consiglio: 2, freddo: 2, fredda: 2, conto: 2,
  },
};

// Bonus de caractères propres à une langue (avant normalisation).
const CHAR_BONUS: Array<[RegExp, ReplyLang, number]> = [
  [/ß/, 'de', 5],
  [/[äöü]/, 'de', 2],
  [/ñ/, 'es', 5],
  [/[¿¡]/, 'es', 5],
  [/œ/, 'fr', 4],
  [/ç/, 'fr', 2],
];

const norm = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’‘`]/g, "'");

export function detectLang(body: string, fallback: ReplyLang = 'fr'): { lang: ReplyLang; score: number } {
  const text = body.trim();
  if (!text) return { lang: fallback, score: 0 };
  const scores = new Map<ReplyLang, number>();
  for (const [re, lang, w] of CHAR_BONUS) if (w && re.test(text)) scores.set(lang, (scores.get(lang) ?? 0) + w);
  const n = norm(text);
  const tokens = n.match(/[a-z]+(?:['-][a-z]+)*/g) ?? [];
  for (const [lang, dict] of Object.entries(WORDS) as [ReplyLang, Record<string, number>][]) {
    let score = scores.get(lang) ?? 0;
    for (const t of tokens) score += dict[t] ?? 0;
    scores.set(lang, score);
  }
  // Le max l'emporte avec un seuil : 4 points OU couverture ≥ 12 % des
  // tokens — les faux positifs sur textes courts retombent sur le repli.
  let best: ReplyLang = fallback, bestScore = 0;
  for (const [lang, s] of scores) if (s > bestScore) { best = lang; bestScore = s; }
  const hits = tokens.reduce((acc, t) => {
    for (const dict of Object.values(WORDS)) if (dict[t]) return acc + 1;
    return acc;
  }, 0);
  if (bestScore >= 4 || (bestScore >= 2 && hits / Math.max(1, tokens.length) >= 0.12))
    return { lang: best, score: bestScore };
  return { lang: fallback, score: bestScore };
}
