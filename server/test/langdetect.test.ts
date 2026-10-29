import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectLang } from '../src/llm/langdetect.js';

const cases: [string, string][] = [
  ['The food was excellent and the staff were very friendly, but we waited 40 minutes for our table. Highly recommended though!', 'en'],
  ['Great service, delicious food and a lovely atmosphere. The waiter was attentive and the bill was reasonable.', 'en'],
  ['Disappointed — the waiter was rude and our food arrived cold. We will not come back.', 'en'],
  ['Die kos was heerlik en die personeel baie vriendelik, maar ons het lank gewag vir ons tafel. Ek sal definitief terugkom.', 'af'],
  ['Baie teleurgesteld — die diens was stadig en die ete was koud toe dit uiteindelik aankom. Ek sal nie weer hier eet nie.', 'af'],
  ['Das Essen war ausgezeichnet und das Personal sehr freundlich, aber wir mussten lange auf unseren Tisch warten. Sehr zu empfehlen!', 'de'],
  ['Enttäuscht — der Kellner war unfreundlich und unser Essen kam kalt an. Wir kommen nicht wieder.', 'de'],
  ['Het eten was heerlijk en het personeel erg vriendelijk, maar we moesten lang wachten op onze tafel. Zeker een aanrader!', 'nl'],
  ['Teleurgesteld — de bediening was onvriendelijk en ons eten kwam koud aan. We komen niet meer terug.', 'nl'],
  ['La comida estaba deliciosa y el personal muy amable, pero esperamos mucho tiempo por nuestra mesa. ¡Muy recomendable!', 'es'],
  ['Decepcionado — el camarero fue desagradable y nuestra comida llegó fría. No volveremos.', 'es'],
  ['Il cibo era delizioso e il personale molto gentile, ma abbiamo aspettato a lungo per il nostro tavolo. Consigliatissimo!', 'it'],
  ['Deluso — il cameriere era scortese e il nostro cibo è arrivato freddo. Non torneremo.', 'it'],
];

test('detectLang : langues couvertes reconnues sur avis réalistes', () => {
  for (const [body, want] of cases)
    assert.equal(detectLang(body).lang, want, `langue attendue ${want} pour « ${body.slice(0, 60)}… »`);
});

test('detectLang : repli sur la langue du marché si court, vide ou ambigu', () => {
  assert.equal(detectLang('').lang, 'fr');
  assert.equal(detectLang('').lang, 'fr');
  assert.equal(detectLang('   ').lang, 'fr');
  assert.equal(detectLang('Super !', 'en').lang, 'en');          // ambigu → marché
  assert.equal(detectLang('top', 'en').lang, 'en');
  assert.equal(detectLang('😊👍').lang, 'fr');                    // pas de tokens
  assert.equal(detectLang('Sehr gut!').lang, 'de');              // signal net
});

test('detectLang : bonus caractères (ß, ñ, œ)', () => {
  assert.equal(detectLang('Die Küche ist großartig und die Bedienung sehr freundlich').lang, 'de');
  assert.equal(detectLang('¡Excelente! ¿Volverán? El camarero muy amable, la comida muy buena').lang, 'es');
});
