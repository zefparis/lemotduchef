import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

// Exigence : quand l'anglais est sélectionné, AUCUN texte français visible,
// nulle part (et réciproquement), ni dans le texte ni dans les attributs
// alt/title/placeholder/aria-label, ni en title/meta, ni tiret cadratin.
// On charge l'app dans jsdom, on applique la couche i18n RÉELLE (même bloc
// que app.js), puis on extrait écran par écran.

const ROOT = path.resolve(import.meta.dirname, '../../public');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const marketsJs = fs.readFileSync(path.join(ROOT, 'markets.js'), 'utf8');
const i18nJs = fs.readFileSync(path.join(ROOT, 'i18n.js'), 'utf8');
const appJs = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

// Bloc i18n de app.js exécuté tel quel dans jsdom (de MARKETS à mountLangSelector).
const i18nBlock = appJs.slice(appJs.indexOf('const MARKETS'), appJs.indexOf('const $ '));
const DICTS = JSON.parse(i18nJs.slice(i18nJs.indexOf('{'), i18nJs.lastIndexOf('}') + 1));

const PROPER = /Le Mot du Chef|Anthropic|Stripe|Paystack|Vercel|Cloudflare|Microsoft|Outlook|Gmail|Better Auth|Kévin|Marc|Lyon|Paris|Johannesburg|Orange|Free\b/g;

// Marqueurs forts FR : mots-outils courants + lettres accentuées.
const FR_WORDS = /\b(le|la|les|des|une|vous|votre|vos|pour|avec|avis|réponses?|merci|nous|dans|être|sont|est|sur|par|pas|plus|qui|que|cette|aux|sans|sous|toujours|jamais|après|avant|chez|notre|nos|leur|leurs|son|sa|ses|mon|ma|mes|ton|ta|tes|toutes|tous|donc|alors|comme|comment|pourquoi|quand|voici|également|aucun|aucune|chaque|toute|entre|depuis|pendant|jusqu|reste|restez|renseignez|saisissez|indiquez|choisissez|cliquez|ouvrez|fermez|revenez|écrivez|publiez|publier|copiez|supprimez|supprimer|enregistrez|enregistrer|confirmez|acceptez|connectez|déconnexion|inscription|connexion|adresse|offre|offres|historique|collecte|établissement|clients?|prénom|abonnement|facturation|appareils?|données|gratuit|mois|jours?|année|semaine|carte|bancaire|résiliable|bientôt|déjà|encore|moins|trop|assez|très|bien|mieux|aussi|seulement|même|autres?|plusieurs|certains?|tout|cela|celle|celles|ceux|ceci|elle|ils|elles|je|tu|ne|ni|où|et|ou|mais|si|car|dont|eux|de|du|au|un|en|ce|qui|il|y|à)\b|[éèêëàâçîïôùû]/i;
// Marqueurs forts EN (pour la passe FR — un seul mot n'est pas probant,
// on en exige deux distincts dans le même extrait).
const EN_WORDS = /\b(the|your|you|we|our|with|for|are|this|that|have|has|will|would|should|what|when|where|who|how|why|and|not|from|these|those|their|they|them|every|never|always|only|just|more|most|some|each|other|than|then|about|into|many|much|same|take|time|know|first|last|still|even|well|open|send|sent|terms|privacy|policy|notice|account|password|search|device|notification|publish|published|delete|cancel|save|copy|link|name|reply|customer|please|thank|thanks|sorry|hello|welcome|paid|pricing|price|month|week|out|back|new|now|all|any|can|may|must|here|there|which|while|before|after|between|through|during|under|over|again|once|also|such|own|very|too|get|got|let|us|me|my|mine|his|her|she|he|him|no|yes|but|if|so|up|do|does|did|be|been|being|is|was|were|am|it|its|or|as|at|by|an|to|of|in|on)\b/gi;

function stripProper(s: string) { return s.replace(PROPER, ' ').replace(/\((vous|tu)\)/g, ' '); }
function frenchHits(s: string) { const c = stripProper(s); return (c.match(new RegExp(FR_WORDS, 'g')) || []); }
function englishHits(s: string) {
  const c = stripProper(s).replace(/https?:\/\/\S+/g, ' ');
  return [...new Set((c.match(EN_WORDS) || []).map(w => w.toLowerCase()))];
}

interface Extracted { where: string; text: string }

function collectText(root: Element | Document, where: string, out: Extracted[], frMode = false) {
  const SKIP = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'SVG']);
  const walk = (node: Node) => {
    if (node.nodeType === 1) {
      const el = node as Element;
      if (SKIP.has(el.tagName) || el.id === 'admin' || /^admin/.test(el.id) || el.hasAttribute('data-legal-doc') || (frMode && /-za$/.test(el.id))) return;
      for (const attr of ['aria-label', 'alt', 'title', 'placeholder']) {
        const v = el.getAttribute(attr);
        if (v && v.trim().length > 1) out.push({ where: `${where}[${attr}]`, text: v });
      }
      for (const ch of el.childNodes) walk(ch);
    } else if (node.nodeType === 3) {
      const t = (node.textContent || '').trim();
      if (t.length > 2) out.push({ where, text: t });
    }
  };
  for (const ch of (root as Element).childNodes ?? []) walk(ch);
}

function boot(url: string, lang: string) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
  const { window } = dom;
  window.eval(marketsJs); window.eval(i18nJs);
  window.eval('var $$ = s => [...document.querySelectorAll(s)];' + i18nBlock.replace(/\bconst (LANG)\b/, 'var $1'));
  // Valeurs réelles de /api/config, injectées comme en production.
  window.eval('var appConfig = { freeMonthlyReplies: 5, freeHistoryDays: 30, reviewRetentionMonths: 12 };');
  window.eval(`LANG = ${JSON.stringify(lang)}; applyI18n();`);
  return window;
}

function screenExtracts(w: any): Extracted[] {
  const d = w.document;
  const frMode = d.documentElement.lang === 'fr';
  const out: Extracted[] = [];
  out.push({ where: 'title', text: d.title });
  const md = d.querySelector('meta[name="description"]');
  if (md) out.push({ where: 'meta.description', text: md.content });
  const regions: [string, string][] = [
    ['header', '.site-header'], ['landing', '#landing'], ['footer', '.site-footer'],
    ['auth', '#auth'], ['onboard', '#onboard'], ['app', '#app'],
    ['legal', '#legal'], ['dialogs', 'dialog, [role="dialog"]'],
  ];
  for (const [name, sel] of regions) {
    for (const el of d.querySelectorAll(sel)) { if (/^admin/.test(el.id)) continue; collectText(el, name, out, frMode); }
  }
  // Footer de l'espace app + nav mobile.
  for (const el of d.querySelectorAll('.app-footer, .mobile-nav')) collectText(el, 'app-footer', out, frMode);
  return out;
}

function enChecks(url: string) {
  const w = boot(url, 'en');
  const bad: string[] = [];
  for (const { where, text } of screenExtracts(w)) {
    if (/[—–…]/.test(text)) bad.push(`${where} : tiret cadratin/ellipse dans « ${text.slice(0, 70)} »`);
    const hits = frenchHits(text);
    if (hits.length) bad.push(`${where} : FR « ${text.slice(0, 80)} » → ${hits.slice(0, 5).join(', ')}`);
  }
  // Dict EN : aucune valeur ne doit ressembler à du français.
  for (const [k, v] of Object.entries(DICTS.en as Record<string, string>)) {
    if (/[—–…]/.test(v)) bad.push(`dict.en.${k} : tiret cadratin/ellipse`);
    const hits = frenchHits(v.replace(/<[^>]+>/g, ' '));
    if (hits.length) bad.push(`dict.en.${k} : FR « ${v.slice(0, 70)} » → ${hits.slice(0, 5).join(', ')}`);
  }
  return bad;
}

test('EN : aucun texte français ni tiret cadratin sur aucun écran', () => {
  assert.deepEqual(enChecks('https://za.lemotduchef.fr/'), []);
});

test('EN : marché KE — aucun français, aucun € ni rand, aucune variable', () => {
  assert.deepEqual(enChecks('https://ke.lemotduchef.fr/'), []);
});

test('FR : aucun texte anglais oublié, aucun tiret cadratin', () => {
  const w = boot('https://lemotduchef.fr/', 'fr');
  const bad: string[] = [];
  for (const { where, text } of screenExtracts(w)) {
    if (/[—–…]/.test(text)) bad.push(`${where} : tiret cadratin/ellipse dans « ${text.slice(0, 70)} »`);
    const hits = englishHits(text);
    if (hits.length >= 2) bad.push(`${where} : EN « ${text.slice(0, 80)} » → ${hits.slice(0, 6).join(', ')}`);
    if (/\bR\s?\d/.test(text)) bad.push(`${where} : symbole rand sur le marché FR « ${text.slice(0, 60)} »`);
    if (/\{[a-zA-Z]+\}/.test(text)) bad.push(`${where} : variable non remplacée « ${text.slice(0, 60)} »`);
    const dup = text.match(/\b([A-Za-zÀ-ÿ]{2,}|[0-9]+)\s+\1\b/i);
    if (dup) bad.push(`${where} : doublon « ${text.slice(0, 60)} » (« ${dup[1]} »)`);
  }
  for (const [k, v] of Object.entries(DICTS.fr as Record<string, string>)) {
    if (/[—–…]/.test(v)) bad.push(`dict.fr.${k} : tiret cadratin/ellipse`);
    const hits = englishHits(v.replace(/<[^>]+>/g, ' '));
    if (hits.length >= 3) bad.push(`dict.fr.${k} : EN « ${v.slice(0, 70)} » → ${hits.slice(0, 6).join(', ')}`);
  }
  assert.deepEqual(bad, [], bad.join('\n'));
});
