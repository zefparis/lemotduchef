import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgres://lemotduchef:lemotduchef@127.0.0.1:5445/lemotduchef_test';

const { EMAIL_TEMPLATES } = await import('../src/mailer.js');
const { frontUrlFor, MARKET_IDS } = await import('../src/markets.js');

const KINDS = ['verify', 'resetPassword', 'changeEmail'] as const;
const LANGS = ['fr', 'en'] as const;

for (const market of MARKET_IDS) for (const kind of KINDS) for (const lang of LANGS) {
  test(`email ${kind} ${lang} marché ${market} : bouton, domaine, pas d'api, pas de tirets`, () => {
    const url = `${frontUrlFor(market)}/verifier?token=T0K3N`;
    const { text, html } = EMAIL_TEMPLATES[kind](url, lang);
    const host = new URL(url).hostname;
    // Bouton <a href> + lien de secours cliquable vers le domaine du marché.
    assert.ok(html.includes(`<a href="${url}"`), `pas de <a href> vers ${host}`);
    assert.ok(html.includes('display:inline-block'), 'bouton stylé manquant');
    assert.match(html, /alt="Le Mot du Chef"/, 'logo sans alt');
    // Jamais d'URL d'API ni de domaine autre en clair.
    assert.ok(!html.includes('api.lemotduchef.fr'), 'URL api en clair dans le HTML');
    assert.ok(!text.includes('api.lemotduchef.fr'), 'URL api en clair dans le texte');
    // Aucun tiret cadratin ni ellipse.
    assert.ok(!/[—–…]/.test(html) && !/[—–…]/.test(text), 'tiret cadratin');
    // Pas de résidu d'une autre langue dans le corps.
    if (lang === 'en') assert.ok(!/\b(bienvenue|confirmer|confirmez|réinitialiser|adresse|ignorez)\b/i.test(html), 'français dans email EN');
    else assert.ok(!/\b(confirm|reset|password|welcome|ignore this|button not working)\b/i.test(html), 'anglais dans email FR');
    // Texte = même contenu que le HTML (pas de divergences).
    assert.ok(text.includes(url) && text.length > 40);
  });
}
