import { test } from 'node:test';
import assert from 'node:assert/strict';

// Règles du rédacteur sur des cas d'avis réels (LLM mocké — aucun réseau, aucune DB).
const { checkReply, parseVariants, tooSimilar, wordCount } = await import('../src/llm/rules.js');
const { mockVariants } = await import('../src/llm/provider.js');
const { buildUserPrompt, signatureOf } = await import('../src/llm/prompt.js');
const { SAMPLE_CASES, SAMPLE_PROFILE } = await import('../src/llm/sampleCases.js');

const sig = signatureOf(SAMPLE_PROFILE);
const pad = (n: number) => Array.from({ length: n }, (_, i) => `mot${i}`).join(' ');
const byKey = (k: string) => SAMPLE_CASES.find(c => c.key === k)!;

/* ---------- Les 6 cas typiques passent toutes les règles ---------- */
test('cas typiques : le mock produit 3 variantes conformes et distinctes', () => {
  for (const c of SAMPLE_CASES) {
    const vs = parseVariants(mockVariants(buildUserPrompt(c.profile, c.review, [])));
    assert.equal(vs.length, 3, c.key);
    for (const v of vs) {
      const r = checkReply(v, c.profile, c.review);
      assert.ok(r.ok, `${c.key} : ${r.errors.join(', ')}\n${v}`);
    }
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++)
      assert.ok(!tooSimilar(vs[i], vs[j]), `${c.key} : variantes ${i}/${j} trop proches`);
  }
});

/* ---------- Longueur proportionnelle ---------- */
test('longueur : avis court → 35-60 mots, avis détaillé → fourchette pleine', () => {
  const court = byKey('plat-froid'); // « Plat froid. » = 2 mots
  const good = parseVariants(mockVariants(buildUserPrompt(court.profile, court.review, [])))[0];
  assert.match(buildUserPrompt(court.profile, court.review, []), /Longueur attendue : 35 à 60 mots/);
  assert.match(checkReply(`${good} ${pad(30)}`, court.profile, court.review).errors.join(), /trop long/);
  assert.match(checkReply(`Bonjour Paul, ${pad(20)}\n${sig}`, court.profile, court.review).errors.join(), /trop court/);

  const detaille = { ...byKey('positif').review, body: byKey('positif').review.body }; // ≥ 15 mots
  assert.ok(wordCount(detaille.body) >= 15);
  assert.match(buildUserPrompt(SAMPLE_PROFILE, detaille, []), /Longueur attendue : 30 à 70 mots/);
  const longPos = parseVariants(mockVariants(buildUserPrompt(SAMPLE_PROFILE, detaille, [])))[0];
  assert.match(checkReply(`${longPos} ${pad(50)}`, SAMPLE_PROFILE, detaille).errors.join(), /trop long/);

  const negDetaille = { ...byKey('attente').review, body: 'Attente de plus d’une heure ce soir, malgré une salle à moitié vide et trois serveurs qui discutaient entre eux au comptoir.' };
  assert.match(buildUserPrompt(SAMPLE_PROFILE, negDetaille, []), /Longueur attendue : 50 à 120 mots/);
});

/* ---------- Chaque élément concret de l'avis est traité ---------- */
test('faux de dire « l\'avis ne donne pas de détail » quand il en contient', () => {
  const c = byKey('inconnu'); // « Ignoble et trop long. »
  const good = parseVariants(mockVariants(buildUserPrompt(c.profile, c.review, [])))[0];
  for (const claim of ['Votre avis ne donne aucun détail.', 'Ce commentaire est sans précision.', 'Votre message ne détaille pas la situation.'])
    assert.match(checkReply(`${good} ${claim}`, c.profile, c.review).errors.join(), /ne donne aucun détail/, claim);
  // Avis réellement vide : la remarque reste permise.
  const vide = byKey('sans-texte');
  const okEmpty = checkReply(`Bonjour, votre note sans commentaire nous interroge ; ${pad(35)}\n${sig}`, vide.profile, vide.review);
  assert.ok(!okEmpty.errors.some(e => /détail/.test(e)), okEmpty.errors.join());
});

/* ---------- Rien d'inventé : plats ou faits absents ---------- */
test('plat ou aliment absent de l\'avis et du profil → rejeté', () => {
  const c = byKey('plat-froid');
  const good = parseVariants(mockVariants(buildUserPrompt(c.profile, c.review, [])))[0];
  for (const [frag, re] of [
    ['de la pâte aux garnitures', /inventé/], ['notre tiramisu maison', /inventé/],
    ['nos pizzas sorties du four', /inventé/], ['un verre de vin offert', /inventé/],
  ] as const)
    assert.match(checkReply(`${good} Parlons ${frag}.`, c.profile, c.review).errors.join(), re);
  // Aliment présent dans l'avis ou le profil : autorisé.
  const risotto = { ...byKey('positif').review, body: byKey('positif').review.body + ' Le risotto était parfait.' };
  const withRisotto = `Bonjour Julie, ravis que le risotto vous ait plu ; ${pad(40)}\n${sig}`;
  assert.equal(checkReply(withRisotto, SAMPLE_PROFILE, risotto).ok, true);
  const profilFromage = { ...SAMPLE_PROFILE, strengths: ['fait maison', 'plateau de fromages affinés'] };
  const withCheese = `Bonjour Julie, notre plateau de fromages vous attend ; ${pad(40)}\n${sig}`;
  assert.equal(checkReply(withCheese, profilFromage, byKey('positif').review).ok, true);
});

/* ---------- Posture : excuses seulement si « problème réel » ---------- */
test('excuses : au plus un regret léger sans contexte « problème réel »', () => {
  const c = byKey('prix');
  const good = parseVariants(mockVariants(buildUserPrompt(c.profile, c.review, [])))[0];
  const twoSorry = `${good} Nous sommes désolés et nous vous présentons nos excuses.`;
  assert.match(checkReply(twoSorry, c.profile, c.review).errors.join(), /excuses répétées/);
  const real = { ...c.review, context_tags: [...c.review.context_tags, 'real_problem'] };
  assert.equal(checkReply(twoSorry, c.profile, real).ok, true);
  const oneRegret = `${good} Nous regrettons ce ressenti.`;
  assert.equal(checkReply(oneRegret, c.profile, c.review).ok, true);
});

test('formules interdites et « au plaisir » répété', () => {
  const c = byKey('attente');
  const good = parseVariants(mockVariants(buildUserPrompt(c.profile, c.review, [])))[0];
  for (const b of ['sincèrement désolés', 'nous prenons votre avis au sérieux', 'votre avis compte', 'nous sommes navrés'])
    assert.match(checkReply(`${good} Finalement, ${b}.`, c.profile, c.review).errors.join(), /formule interdite/, b);
  assert.match(
    checkReply(`${good} Au plaisir de vous revoir. Et encore : au plaisir de vous accueillir.`, c.profile, c.review).errors.join(),
    /« au plaisir » répété/);
});

/* ---------- Coordonnées : email seul, téléphone sur option ---------- */
test('coordonnées : email du profil seul ; téléphone uniquement si l\'option est active', () => {
  const c = byKey('attente');
  const good = parseVariants(mockVariants(buildUserPrompt(c.profile, c.review, [])))[0];
  assert.ok(!/04 78/.test(buildUserPrompt(c.profile, c.review, [])), 'prompt sans le téléphone quand show_phone est faux');
  const withMail = checkReply(`${good} Écrivez à contact@tabledaurore.fr.`, c.profile, c.review);
  assert.equal(withMail.ok, true);
  const withPhone = `${good} Joignez-nous au 04 78 00 00 00.`;
  assert.match(checkReply(withPhone, c.profile, c.review).errors.join(), /téléphone/);
  const profilTel = { ...c.profile, show_phone: true };
  assert.equal(checkReply(withPhone, profilTel, c.review).ok, true);
  assert.match(buildUserPrompt(profilTel, c.review, []), /Contact réclamations : contact@tabledaurore\.fr \/ 04 78 00 00 00/);
  assert.match(checkReply(`${good} Joignez-nous au 06 12 34 56 78.`, profilTel, c.review).errors.join(), /téléphone étranger/);
});

/* ---------- Diversité des variantes ---------- */
test('tooSimilar : même ouverture ou >40 % de mots communs → rejet', () => {
  const a = `Bonjour Paul, merci pour votre retour détaillé sur le service.\n${sig}`;
  const sameOpening = `Bonsoir tout le monde, merci pour votre retour détaillé sur le service. Autre formulation ensuite vraiment.\n${sig}`;
  assert.equal(tooSimilar(a, sameOpening), true, 'même première phrase');
  const near = `Bonjour Paul, merci pour votre retour détaillé sur le service hier.\n${sig}`;
  assert.equal(tooSimilar(a, near), true, 'mots quasi identiques');
  const other = `Bonjour Paul, votre soirée n'a pas été à la hauteur et nous le regrettons sincèrement.\n${sig}`;
  assert.equal(tooSimilar(a, other), false, 'angles distincts');
});
