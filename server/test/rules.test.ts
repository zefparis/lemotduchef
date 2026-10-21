import { test } from 'node:test';
import assert from 'node:assert/strict';

// Règles du rédacteur sur des cas d'avis réels (LLM mocké — aucun réseau, aucune DB).
const { checkReply, parseVariants, tooSimilar, wordCount, withSignature } = await import('../src/llm/rules.js');
const { mockVariants } = await import('../src/llm/provider.js');
const { buildUserPrompt, signatureOf, assignedStrengths, authorDisplayName } = await import('../src/llm/prompt.js');
const { SAMPLE_CASES, SAMPLE_PROFILE } = await import('../src/llm/sampleCases.js');

const sig = signatureOf(SAMPLE_PROFILE);
const pad = (n: number) => Array.from({ length: n }, (_, i) => `mot${i}`).join(' ');
const byKey = (k: string) => SAMPLE_CASES.find(c => c.key === k)!;
// Sortie du modèle (sans signature) → texte final assemblé, comme generate.ts.
const rawVariants = (c: ReturnType<typeof byKey>) => parseVariants(mockVariants(buildUserPrompt(c.profile, c.review, [])));
const variants = (c: ReturnType<typeof byKey>) => rawVariants(c).map(v => withSignature(v, sig));
const body = (c: ReturnType<typeof byKey>, i = 0) => rawVariants(c)[i];

/* ---------- Les cas typiques passent toutes les règles ---------- */
test('cas typiques : le mock produit 3 variantes conformes et distinctes', () => {
  for (const c of SAMPLE_CASES) {
    const vs = variants(c);
    assert.equal(vs.length, 3, c.key);
    for (const v of vs) {
      const r = checkReply(v, c.profile, c.review);
      assert.ok(r.ok, `${c.key} : ${r.errors.join(', ')}\n${v}`);
    }
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++)
      assert.ok(!tooSimilar(vs[i], vs[j]), `${c.key} : variantes ${i}/${j} trop proches`);
  }
});

/* ---------- Signature ajoutée par le code ---------- */
test('signature : ajoutée si absente, complétée si partielle, prénom en fin de corps retiré', () => {
  assert.equal(withSignature('Merci pour votre avis.', sig), `Merci pour votre avis.\n${sig}`);
  assert.equal(withSignature(`Merci pour votre avis.\nMarc`, sig), `Merci pour votre avis.\n${sig}`);
  assert.equal(withSignature(`Merci pour votre avis.\n${sig}`, sig), `Merci pour votre avis.\n${sig}`);
  assert.equal(withSignature('Merci pour votre avis.\nCordialement', sig), `Merci pour votre avis.\n${sig}`);
  // « …, Marc » en fin de corps : le prénom du signataire est retiré, pas rejeté.
  assert.equal(withSignature('Merci pour votre avis.\nMarc', sig), `Merci pour votre avis.\n${sig}`);
  assert.equal(withSignature('Nous espérons vous revoir bientôt, Marc.', sig), `Nous espérons vous revoir bientôt.\n${sig}`);
  assert.equal(withSignature('Nous espérons vous revoir bientôt.\nMarc', sig), `Nous espérons vous revoir bientôt.\n${sig}`);
  // La longueur se mesure sur le corps, pas sur la signature.
  const c = byKey('plat-froid');
  const r = checkReply(`Bonjour Paul, ${pad(36)}\n${sig}`, c.profile, c.review);
  assert.equal(r.words, 38, 'signature hors décompte');
  assert.equal(r.ok, true, r.errors.join());
});

/* ---------- Longueur proportionnelle ---------- */
test('longueur : cible 45 mots (court) / 80 mots (détaillé), +10 % = avertissement', () => {
  const court = byKey('plat-froid'); // « Plat froid. » = 2 mots
  const good = variants(court)[0];
  const u = buildUserPrompt(court.profile, court.review, []);
  assert.match(u, /Longueur attendue : 35 à 60 mots \(vise ~45\)/);
  assert.match(checkReply(`${good} ${pad(30)}`, court.profile, court.review).errors.join(), /trop long/);
  // +10 % : avertissement, pas rejet (62 ≤ 66).
  const slightOver = checkReply(`Bonjour Paul, ${pad(59)}\n${sig}`, court.profile, court.review);
  assert.equal(slightOver.ok, true, slightOver.errors.join());
  assert.match(slightOver.warnings.join(), /hors cible/);
  assert.match(checkReply(`Bonjour Paul, ${pad(20)}\n${sig}`, court.profile, court.review).errors.join(), /trop court/);

  const detaille = { ...byKey('positif').review, body: byKey('positif').review.body }; // ≥ 15 mots
  assert.ok(wordCount(detaille.body) >= 15);
  assert.match(buildUserPrompt(SAMPLE_PROFILE, detaille, []), /Longueur attendue : 40 à 120 mots \(vise ~80\)/);
  const longPos = variants({ ...byKey('positif'), review: detaille })[0];
  assert.match(checkReply(`${longPos} ${pad(100)}`, SAMPLE_PROFILE, detaille).errors.join(), /trop long/);

  const negDetaille = { ...byKey('attente').review, body: 'Attente de plus d’une heure ce soir, malgré une salle à moitié vide et trois serveurs qui discutaient entre eux au comptoir.' };
  assert.match(buildUserPrompt(SAMPLE_PROFILE, negDetaille, []), /Longueur attendue : 50 à 120 mots/);
  assert.match(buildUserPrompt(SAMPLE_PROFILE, negDetaille, []), /Nature de la critique : .*attente/);
});

/* ---------- Chaque élément concret de l'avis est traité ---------- */
test('faux de dire « l\'avis ne donne pas de détail » quand il en contient', () => {
  const c = byKey('inconnu'); // « Ignoble et trop long. »
  const good = variants(c)[0];
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
  const good = variants(c)[0];
  for (const frag of ['de la pâte aux garnitures', 'notre tiramisu maison', 'nos pizzas sorties du four', 'un verre de vin offert'])
    assert.match(checkReply(`${good} Parlons ${frag}.`, c.profile, c.review).errors.join(), /inventé/, frag);
  // Aliment présent dans l'avis ou le profil : autorisé.
  const risotto = { ...byKey('positif').review, body: byKey('positif').review.body + ' Le risotto était parfait.' };
  const withRisotto = `Bonjour Julie, ravis que le risotto vous ait plu ; ${pad(40)}\n${sig}`;
  assert.equal(checkReply(withRisotto, SAMPLE_PROFILE, risotto).ok, true);
  const profilFromage = { ...SAMPLE_PROFILE, strengths: ['fait maison', 'plateau de fromages affinés'] };
  const withCheese = `Bonjour Julie, notre plateau de fromages vous attend ; ${pad(40)}\n${sig}`;
  assert.equal(checkReply(withCheese, profilFromage, byKey('positif').review).ok, true);
});

/* ---------- Excuses selon le contexte ---------- */
test('excuses : au plus une brève sans contexte ; aucune sur « jamais venu » ou « prix affichés »', () => {
  const c = byKey('commande'); // critique factuelle, aucun contexte coché
  const oneSorry = `${body(c)} Ce n’est pas notre standard, nous sommes désolés.\n${sig}`;
  assert.equal(checkReply(oneSorry, c.profile, c.review).ok, true, 'une excuse brève autorisée');
  const twoSorry = `${body(c)} Nous sommes désolés et nous vous présentons nos excuses.\n${sig}`;
  assert.match(checkReply(twoSorry, c.profile, c.review).errors.join(), /excuses répétées/);
  const real = { ...c.review, context_tags: ['real_problem'] };
  assert.equal(checkReply(twoSorry, c.profile, real).ok, true);
  for (const key of ['inconnu', 'prix']) {
    const withTag = byKey(key); // unknown_customer / prices_displayed
    const sorry = `${body(withTag)} Nous sommes désolés pour cette expérience.\n${sig}`;
    assert.match(checkReply(sorry, withTag.profile, withTag.review).errors.join(), /excuse inadaptée/, key);
  }
});

/* ---------- Faits internes inventés ---------- */
test('procédures, registres et actions internes non fournis → rejet', () => {
  const c = byKey('toilettes'); // Manon, « Toilettes sales »
  const good = body(c);
  for (const frag of ['nos registres de nettoyage sont tenus chaque jour', 'nous vérifions nos sanitaires régulièrement',
    'nous travaillons à mieux répartir les tables', 'notre protocole d’hygiène est strict',
    'nous mettons en place des contrôles renforcés', 'nous revoyons notre organisation du service'])
    assert.match(checkReply(`${good} D’ailleurs, ${frag}.\n${sig}`, c.profile, c.review).errors.join(), /fait interne inventé/, frag);
  // « Registres » permis seulement avec le contexte « jamais venu ».
  const inconnu = byKey('inconnu');
  const reg = `${body(inconnu)} Nos registres n’indiquent pas votre venue.\n${sig}`;
  assert.equal(checkReply(reg, inconnu.profile, inconnu.review).ok, true);
  assert.match(checkReply(reg, c.profile, c.review).errors.join(), /fait interne inventé/);
  // Engagement générique autorisé.
  assert.equal(checkReply(`${body(c, 1)} Votre retour est transmis à l’équipe dès aujourd’hui.\n${sig}`, c.profile, c.review).ok, true);
});

/* ---------- « Surpris » selon le contexte ---------- */
test('« surpris / surprenant » seulement avec « jamais venu » ou « plat conforme »', () => {
  const c = byKey('commande'); // aucun contexte coché
  const surprised = `${body(c)} Nous sommes surpris par votre description.\n${sig}`;
  assert.match(checkReply(surprised, c.profile, c.review).errors.join(), /surpris/);
  const inconnu = byKey('inconnu');
  assert.equal(checkReply(`${body(inconnu)} Nous sommes surpris par votre description.\n${sig}`,
    inconnu.profile, inconnu.review).ok, true);
  const conf = { ...byKey('plat-froid').review, context_tags: ['dish_as_described'] };
  const confText = `Bonjour Paul, ${pad(38)} Ce retour est surprenant, le plat était conforme.\n${sig}`;
  assert.equal(checkReply(confText, SAMPLE_PROFILE, conf).ok, true);
});

/* ---------- Style : analyse recopiée, « de une », signataire, ouverture ---------- */
test('style : analyse interne, « de une », signataire 3e personne, « Bonjour {prénom} »', () => {
  const c = byKey('serveur'); // Thomas
  const good = variants(c)[0];
  assert.match(checkReply(`${good} Au sujet de la nature de la critique évoquée…`, c.profile, c.review).errors.join(), /analyse interne/);
  for (const leak of ['votre remarque porte sur', 'votre retour concerne', 'votre avis porte sur'])
    assert.match(checkReply(`${good} À vrai dire, ${leak} le service.`, c.profile, c.review).errors.join(), /analyse interne/, leak);
  assert.match(checkReply(`${good} Votre note de une étoile nous attriste.`, c.profile, c.review).errors.join(), /de une/);
  assert.match(checkReply(`${good} Marc, le chef, vous répondra personnellement.`, c.profile, c.review).errors.join(), /3e personne/);
  assert.match(checkReply(`Bonsoir Thomas, merci de votre visite ${pad(30)}\n${sig}`, c.profile, c.review).errors.join(), /« Bonjour »/);
  assert.match(checkReply(`Bonjour, merci de votre visite ${pad(35)}\n${sig}`, c.profile, c.review).errors.join(), /prénom/);
  // Initiale seule ou pseudo → « Bonjour » seul, sans nom ni initiale.
  const initiale = { ...byKey('sans-texte').review }; // auteur « R. »
  assert.equal(authorDisplayName(initiale), null);
  assert.equal(checkReply(`Bonjour, votre note nous interroge et mérite réponse ${pad(28)}\n${sig}`, SAMPLE_PROFILE, initiale).ok, true);
  assert.match(checkReply(`Bonjour R., votre note nous interroge ${pad(30)}\n${sig}`, SAMPLE_PROFILE, initiale).errors.join(), /« Bonjour » seul/);
  const pseudo = { ...byKey('inconnu').review }; // auteur « Anonyme »
  assert.equal(authorDisplayName(pseudo), null);
  assert.equal(checkReply(`Bonjour, vos mots appellent une réponse claire et posée ${pad(28)}\n${sig}`, SAMPLE_PROFILE, pseudo).ok, true);
  // Prénom absent de l'avis → « Bonjour » seul suffit.
  const noName = { ...c.review, author_name: '' };
  assert.equal(checkReply(`Bonjour, merci de votre visite ${pad(35)}\n${sig}`, c.profile, noName).ok, true);
  // Une seule mention de l'équipe par réponse.
  assert.match(checkReply(`${body(c, 1)} Votre retour est transmis à l’équipe, et nous en parlons avec l’équipe.\n${sig}`, c.profile, c.review).errors.join(), /équipe répétée/);
  assert.equal(checkReply(`${body(c, 1)} Votre retour est transmis à l’équipe dès aujourd’hui.\n${sig}`, c.profile, c.review).ok, true);
});

/* ---------- Point fort suggéré par variante ---------- */
test('point fort : suggéré par le code, jamais obligatoire, autre point fort interdit', () => {
  assert.deepEqual(assignedStrengths(SAMPLE_PROFILE, 0), [null, 'fait maison', 'produits locaux']);
  assert.deepEqual(assignedStrengths(SAMPLE_PROFILE, 1), [null, 'produits locaux', 'terrasse ombragée']);
  const u = buildUserPrompt(SAMPLE_PROFILE, byKey('positif').review, []);
  assert.match(u, /variante 2 peut citer « fait maison »/);
  assert.match(u, /variante 3 peut citer « produits locaux »/);
  assert.ok(!/Points forts :/.test(u), 'la liste complète n’est plus transmise');
  const c = byKey('positif');
  const wrong = `Bonjour Julie, la terrasse ombragée vous attend ; ${pad(35)}\n${sig}`;
  assert.match(checkReply(wrong, c.profile, c.review, { allowedStrength: 'fait maison' }).errors.join(), /non attribué/);
  const factuelle = `Bonjour Julie, le fait maison fait notre fierté chaque jour ; ${pad(35)}\n${sig}`;
  assert.match(checkReply(factuelle, c.profile, c.review, { allowedStrength: null }).errors.join(), /non demandé/);
  assert.equal(checkReply(factuelle, c.profile, c.review, { allowedStrength: 'fait maison' }).ok, true);
  // Suggestion seulement : omettre le point fort suggéré est toujours accepté.
  for (const key of ['positif', 'commande', 'plat-froid']) {
    const k = byKey(key);
    const sansPf = `Bonjour ${authorDisplayName(k.review) ?? ''}, merci pour ce retour ; ${pad(35)}\n${sig}`.replace('  ', ' ');
    assert.equal(checkReply(sansPf, k.profile, k.review, { allowedStrength: 'fait maison' }).ok, true, key);
  }
});

/* ---------- Formules interdites ---------- */
test('formules interdites, « au plaisir » répété et impatience du client', () => {
  const c = byKey('attente');
  const good = variants(c)[0];
  for (const b of ['sincèrement désolés', 'nous prenons votre avis au sérieux', 'votre avis compte', 'nous sommes navrés',
    'ce ressenti', 'votre ressenti', 'nous tenons à préciser', 'en connaissance de cause', 'mérite d’être savouré', 'sans précipitation'])
    assert.match(checkReply(`${good} Finalement, ${b}.`, c.profile, c.review).errors.join(), /formule interdite/, b);
  assert.match(
    checkReply(`${good} Au plaisir de vous revoir. Et encore : au plaisir de vous accueillir.`, c.profile, c.review).errors.join(),
    /« au plaisir » répété/);
  for (const s of ['Nous comprenons votre impatience.', 'Vous êtes visiblement de mauvaise foi.', 'Vous exagérez un peu.'])
    assert.match(checkReply(`${good} ${s}`, c.profile, c.review).errors.join(), /impatience ou la mauvaise foi/, s);
});

/* ---------- Sobriété : points forts et email ---------- */
test('sobriété : un seul point fort par variante ; email seulement avec invitation', () => {
  const c = byKey('positif');
  const twoStrengths = `Bonjour Julie, le fait maison et les produits locaux font notre fierté ; ${pad(35)}\n${sig}`;
  assert.match(checkReply(twoStrengths, c.profile, c.review).errors.join(), /plusieurs points forts/);
  const oneStrength = `Bonjour Julie, le fait maison fait notre fierté chaque jour ; ${pad(35)}\n${sig}`;
  assert.equal(checkReply(oneStrength, c.profile, c.review).ok, true);
  // Email seul en passant → rejeté ; email avec invitation → accepté.
  const n = byKey('attente');
  const bare = `Bonjour Karim, écrivez à contact@tabledaurore.fr si besoin d’en parler. ${pad(35)}\n${sig}`;
  const bareMail = `Bonjour Karim, notre adresse est contact@tabledaurore.fr en passant. ${pad(35)}\n${sig}`;
  assert.equal(checkReply(bare, n.profile, n.review).ok, true);
  assert.match(checkReply(bareMail, n.profile, n.review).errors.join(), /email cité sans invitation/);
});

/* ---------- Coordonnées : email seul, téléphone sur option ---------- */
test('coordonnées : email du profil seul ; téléphone uniquement si l\'option est active', () => {
  const c = byKey('attente');
  const good = body(c);
  assert.ok(!/04 78/.test(buildUserPrompt(c.profile, c.review, [])), 'prompt sans le téléphone quand show_phone est faux');
  const withMail = checkReply(`${good} Écrivez à contact@tabledaurore.fr.\n${sig}`, c.profile, c.review);
  assert.equal(withMail.ok, true);
  const withPhone = `${good} Joignez-nous au 04 78 00 00 00.\n${sig}`;
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
