import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openWithAuthorMarker } from '../src/llm/generate.js';
import { LANG_PACKS } from '../src/llm/langpacks.js';
import { AUTHOR_MARKER } from '../src/llm/prompt.js';

// fixOpening : la salutation de CHAQUE langue + prénom autorisé doit
// recevoir le marqueur [PRÉNOM], exactement comme « Bonjour, » en français.

const CASES = [
  ['fr', 'Bonjour', 'Bonjour, merci pour votre visite.', `Bonjour ${AUTHOR_MARKER}, merci pour votre visite.`],
  ['en', 'Hello', 'Hello, thank you for coming.', `Hello ${AUTHOR_MARKER}, thank you for coming.`],
  ['af', 'Goeiedag', 'Goeiedag, dankie dat u kom eet het.', `Goeiedag ${AUTHOR_MARKER}, dankie dat u kom eet het.`],
  ['de', 'Guten Tag', 'Guten Tag, danke für Ihren Besuch.', `Guten Tag ${AUTHOR_MARKER}, danke für Ihren Besuch.`],
  ['nl', 'Beste', 'Beste, bedankt voor uw bezoek.', `Beste ${AUTHOR_MARKER}, bedankt voor uw bezoek.`],
  ['es', 'Hola', 'Hola, gracias por su visita.', `Hola ${AUTHOR_MARKER}, gracias por su visita.`],
  ['it', 'Buongiorno', 'Buongiorno, grazie della visita.', `Buongiorno ${AUTHOR_MARKER}, grazie della visita.`],
];

test('fixOpening insère [PRÉNOM] dans la salutation de chaque langue', () => {
  for (const [lang, greetWord, input, expected] of CASES) {
    const word = lang === 'fr' ? 'Bonjour' : LANG_PACKS[lang].greetingWord;
    assert.equal(word, greetWord, `greetingWord ${lang}`);
    assert.equal(openWithAuthorMarker(input, word), expected, `ouverture ${lang}`);
  }
});

test('fixOpening ne touche pas une ouverture déjà nommée ni sans salutation', () => {
  const already = `Hello ${AUTHOR_MARKER}, thank you.`;
  assert.equal(openWithAuthorMarker(already, 'Hello'), already);
  assert.equal(openWithAuthorMarker('Thank you for coming.', 'Hello'), 'Thank you for coming.');
  // Point-virgule et virgule couverts, nom déjà présent non dupliqué.
  assert.equal(openWithAuthorMarker('Guten Tag; danke.', 'Guten Tag'), `Guten Tag ${AUTHOR_MARKER}, danke.`);
});
