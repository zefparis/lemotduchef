import { test } from 'node:test';
import assert from 'node:assert/strict';

// Règles du rédacteur sur des cas d'avis réels (LLM mocké — aucun réseau, aucune DB).
const { checkReply, parseVariants, tooSimilar, wordCount, withSignature, cleanReply } = await import('../src/llm/rules.js');
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
  const r = checkReply(`Bonjour Paul, ${pad(33)}. Venez nous retrouver.\n${sig}`, c.profile, c.review);
  assert.equal(r.words, 38, 'signature hors décompte');
  assert.equal(r.ok, true, r.errors.join());
});

/* ---------- Longueur proportionnelle ---------- */
test('longueur : cible 45 mots (court) / 55 mots (détaillé), +10 % = avertissement', () => {
  const court = byKey('plat-froid'); // « Plat froid. » = 2 mots
  const good = variants(court)[0];
  const u = buildUserPrompt(court.profile, court.review, []);
  assert.match(u, /Longueur attendue : 35 à 55 mots \(vise ~45\)/);
  assert.match(checkReply(`${good} ${pad(45)}`, court.profile, court.review).errors.join(), /trop long/);
  // +10 % : avertissement, pas rejet (65 ≤ 66).
  const slightOver = checkReply(`Bonjour Paul, ${pad(59)}. Venez nous voir.\n${sig}`, court.profile, court.review);
  assert.equal(slightOver.ok, true, slightOver.errors.join());
  assert.match(slightOver.warnings.join(), /hors cible/);
  assert.match(checkReply(`Bonjour Paul, ${pad(20)}\n${sig}`, court.profile, court.review).errors.join(), /trop court/);

  const detaille = { ...byKey('positif').review, body: byKey('positif').review.body }; // ≥ 15 mots
  assert.ok(wordCount(detaille.body) >= 15);
  assert.match(buildUserPrompt(SAMPLE_PROFILE, detaille, []), /Longueur attendue : 35 à 65 mots \(vise ~55\)/);
  const longPos = variants({ ...byKey('positif'), review: detaille })[0];
  assert.match(checkReply(`${longPos} ${pad(100)}`, SAMPLE_PROFILE, detaille).errors.join(), /trop long/);

  const negDetaille = { ...byKey('attente').review, body: 'Attente de plus d’une heure ce soir, malgré une salle à moitié vide et trois serveurs qui discutaient entre eux au comptoir.' };
  assert.match(buildUserPrompt(SAMPLE_PROFILE, negDetaille, []), /Longueur attendue : 45 à 70 mots/);
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
test('excuses : au plus une brève sans contexte ; aucune sur « jamais venu » ; sur les prix seulement si elles les visent', () => {
  const c = byKey('commande'); // critique factuelle, aucun contexte coché
  const oneSorry = `${body(c)} Ce n’est pas notre standard, nous sommes désolés.\n${sig}`;
  assert.equal(checkReply(oneSorry, c.profile, c.review).ok, true, 'une excuse brève autorisée');
  const twoSorry = `${body(c)} Nous sommes désolés et nous vous présentons nos excuses.\n${sig}`;
  assert.match(checkReply(twoSorry, c.profile, c.review).errors.join(), /excuses répétées/);
  const real = { ...c.review, context_tags: ['real_problem'] };
  assert.equal(checkReply(twoSorry, c.profile, real).ok, true);
  const tagInconnu = byKey('inconnu');
  const sorryInconnu = `${body(tagInconnu)} Nous sommes désolés pour cette expérience.\n${sig}`;
  assert.match(checkReply(sorryInconnu, tagInconnu.profile, tagInconnu.review).errors.join(), /excuse inadaptée/);
  // « prix affichés » : s'excuser du service ou de l'attente reste permis ;
  // seule l'excuse portant sur les prix est interdite.
  const tagPrix = byKey('prix');
  const sorryService = checkReply(`${body(tagPrix)} Ce n’est pas notre standard, nous sommes désolés pour le service.\n${sig}`, tagPrix.profile, tagPrix.review);
  assert.equal(sorryService.ok, true, sorryService.errors.join());
  const sorryPrix = checkReply(`${body(tagPrix)} Nous sommes désolés pour nos prix.\n${sig}`, tagPrix.profile, tagPrix.review);
  assert.match(sorryPrix.errors.join(), /sur les prix/);
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
  const confText = `Bonjour Paul, ${pad(33)} Ce retour est surprenant, le plat était conforme. Venez nous retrouver quand vous voulez.\n${sig}`;
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
  assert.equal(checkReply(`Bonjour, votre note nous interroge et mérite réponse ${pad(24)}. Venez nous retrouver.\n${sig}`, SAMPLE_PROFILE, initiale).ok, true);
  assert.match(checkReply(`Bonjour R., votre note nous interroge ${pad(30)}\n${sig}`, SAMPLE_PROFILE, initiale).errors.join(), /« Bonjour » seul/);
  const pseudo = { ...byKey('inconnu').review }; // auteur « Anonyme »
  assert.equal(authorDisplayName(pseudo), null);
  assert.equal(checkReply(`Bonjour, vos mots appellent une réponse claire et posée ${pad(24)}. Venez quand vous voulez.\n${sig}`, SAMPLE_PROFILE, pseudo).ok, true);
  // Prénom absent de l'avis → « Bonjour » seul suffit.
  const noName = { ...c.review, author_name: '' };
  assert.equal(checkReply(`Bonjour, merci de votre visite ${pad(31)}. Revenez nous voir.\n${sig}`, c.profile, noName).ok, true);
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
    const sansPf = `Bonjour ${authorDisplayName(k.review) ?? ''}, merci pour ce retour ; ${pad(32)}. Venez nous retrouver.\n${sig}`.replace('  ', ' ');
    assert.equal(checkReply(sansPf, k.profile, k.review, { allowedStrength: 'fait maison' }).ok, true, key);
  }
});

/* ---------- Formules interdites ---------- */
test('formules interdites, « au plaisir » répété et impatience du client', () => {
  const c = byKey('attente');
  const good = variants(c)[0];
  for (const b of ['sincèrement désolés', 'nous prenons votre avis au sérieux', 'votre avis compte', 'nous sommes navrés',
    'ce ressenti', 'votre ressenti', 'nous tenons à préciser', 'en connaissance de cause', 'mérite d’être savouré', 'sans précipitation',
    'merci d’avoir pris le temps', 'votre avis me touche', 'je comprends votre déception', 'j’entends votre déception', 'en toute transparence',
    'sincèrement', 'inacceptable', 'rédhibitoire'])
    assert.match(checkReply(`${good} Finalement, ${b}.`, c.profile, c.review).errors.join(), /formule interdite/, b);
  assert.match(
    checkReply(`${good} Au plaisir de vous revoir. Et encore : au plaisir de vous accueillir.`, c.profile, c.review).errors.join(),
    /« au plaisir » répété/);
  for (const s of ['Nous comprenons votre impatience.', 'Vous êtes visiblement de mauvaise foi.', 'Vous exagérez un peu.'])
    assert.match(checkReply(`${good} ${s}`, c.profile, c.review).errors.join(), /impatience ou la mauvaise foi/, s);
});

/* ---------- Post-traitement anti-marqueurs IA ---------- */
test('cleanReply : tirets cadratin/demi-cadratin et « … » nettoyés, mots composés intacts', () => {
  assert.equal(cleanReply('votre soirée — complète — mérite réponse'), 'votre soirée, complète, mérite réponse');
  assert.equal(cleanReply('attente – 45 minutes'), 'attente, 45 minutes');
  assert.equal(cleanReply('Bonjour Paul — merci…'), 'Bonjour Paul, merci.');
  assert.equal(cleanReply('— Bonjour Paul —'), 'Bonjour Paul');
  assert.equal(cleanReply('du lundi — au vendredi.\n— À bientôt —'), 'du lundi, au vendredi.\nÀ bientôt');
  assert.equal(cleanReply('Jean-Marc vous salue'), 'Jean-Marc vous salue');
  // Plus rien à nettoyer ensuite : le contrôle n'a plus de motif de rejet.
  const c = byKey('attente');
  const signed = withSignature(cleanReply(`${body(c)} Chez nous — pas d'excuse…`), sig);
  assert.equal(checkReply(signed, c.profile, c.review).errors.some(e => /cadratin|« … »/.test(e)), false);
  // Filet de sécurité : un marqueur non nettoyé est refusé.
  assert.match(checkReply(`${body(c)} Chez nous — pas d'excuse.\n${sig}`, c.profile, c.review).errors.join(), /cadratin/);
});

/* ---------- Réglage « Mon style » ---------- */
test('style : expressions bannies par le restaurateur et tutoiement selon la forme d’adresse', () => {
  const c = byKey('attente');
  const profilBan = { ...c.profile, avoid_phrases: ['cher client', 'dans les meilleurs délais'] };
  assert.match(checkReply(`${body(c)} Cher client, nous vous entendons.\n${sig}`, profilBan, c.review).errors.join(), /expression bannie/);
  assert.equal(checkReply(`${body(c)} Nous vous entendons.\n${sig}`, profilBan, c.review).ok, true);
  // Tutoiement : refusé en « vous », accepté en « tu ».
  const tuto = `${body(c)} Tu as raison de le signaler.\n${sig}`;
  assert.match(checkReply(tuto, c.profile, c.review).errors.join(), /tutoiement/);
  const profilTu = { ...c.profile, address_form: 'tu' as const };
  assert.equal(checkReply(tuto, profilTu, c.review).ok, true);
  // « n'hésitez pas » est banni quelle que soit la forme d'adresse.
  for (const f of ['n’hésitez pas', 'n’hésite pas'])
    assert.match(checkReply(`${body(c)} Et surtout ${f} à revenir.\n${sig}`, profilTu, c.review).errors.join(), /formule interdite/, f);
  // Le prompt porte la forme d'adresse, le registre et les expressions.
  const u = buildUserPrompt(profilTu, c.review, []);
  assert.match(u, /Forme d'adresse : tutoiement/);
  assert.match(u, /Registre : « je »/);
  const uBan = buildUserPrompt(profilBan, c.review, []);
  assert.match(uBan, /Expressions bannies par le restaurateur : cher client/);
});

/* ---------- Faits affirmés non fournis ---------- */
test('faits : « prévenu », « indiqué à l’arrivée », « comme convenu » rejetés si le contexte ne les fournit pas', () => {
  const c = byKey('commande'); // aucun contexte coché
  for (const claim of ['vous aviez été prévenu à votre arrivée', 'comme convenu lors de votre venue', 'nous vous avions indiqué dès votre arrivée'])
    assert.match(checkReply(`${body(c)} Bien ${claim}.`, c.profile, c.review).errors.join(), /non fourni/, claim);
  // « Salle complète » seule ne suffit PAS : le rappel exige la case
  // « l'attente a été annoncée au client à son arrivée ».
  const att = byKey('attente'); // context_tags ['full_house'] uniquement
  const sansCase = checkReply(`${body(att)} L’attente avait été annoncée à votre arrivée.`, att.profile, att.review);
  assert.match(sansCase.errors.join(), /non fourni/);
  const okRev = { ...att.review, context_tags: ['full_house', 'wait_announced'] };
  const okCtx = checkReply(`${body(att)} L’attente avait été annoncée à votre arrivée.`, att.profile, okRev);
  assert.ok(!okCtx.errors.some(e => /non fourni|reproche/.test(e)), okCtx.errors.join());
  const blame = checkReply(`${body(att)} Vous aviez été prévenu de l’attente à votre arrivée.`, att.profile, okRev);
  assert.match(blame.errors.join(), /reproche/);
  const blame2 = checkReply(`${body(att)} Je vous avais prévenu de l’attente.`, att.profile, okRev);
  assert.match(blame2.errors.join(), /reproche/);
  // Mentionné dans l'avis lui-même : le contrôle « fait non fourni » ne se
  // déclenche pas (mais la tournure « vous aviez été prévenu » reste un reproche).
  const dit = { ...c.review, body: c.review.body + ' On nous avait prévenus de l’attente.' };
  const rd = checkReply(`${body(c)} L’attente avait été annoncée à l’accueil.`, c.profile, dit);
  assert.ok(!rd.errors.some(e => /non fourni/.test(e)), rd.errors.join());
});

/* ---------- Invitation à revenir (avis négatif) ---------- */
test('avis négatif : chute invitant à revenir ou à reprendre contact obligatoire', () => {
  const c = byKey('commande');
  assert.match(checkReply(`Bonjour Nadia, votre retour est pris en compte ${pad(35)}\n${sig}`, c.profile, c.review).errors.join(), /invitation à revenir/);
  const avec = `Bonjour Nadia, votre retour est pris en compte ${pad(31)}. Revenez nous voir en semaine.\n${sig}`;
  assert.equal(checkReply(avec, c.profile, c.review).ok, true);
  // Sujet santé : l'invitation au contact privé suffit (règle dédiée).
  const health = { ...c.review, body: 'J’ai été malade toute la nuit, intoxication évidente.', context_tags: ['health'] };
  const h = `Bonjour Nadia, cela nous touche et nous vous invitons à nous contacter directement. ${pad(28)}\n${sig}`;
  assert.equal(checkReply(h, c.profile, health).ok, true);
});

/* ---------- Ouverture : reconnaissance avant explication ---------- */
test('jamais d’explication (attente annoncée, salle complète) en première phrase', () => {
  const att = byKey('attente'); // context_tags ['full_house']
  const rev = { ...att.review, context_tags: ['full_house', 'wait_announced'] };
  const openAnnonce = `Bonjour Karim, l'attente avait été annoncée à votre arrivée, mais ${pad(25)}. Venez nous revoir.\n${sig}`;
  assert.match(checkReply(openAnnonce, att.profile, rev).errors.join(), /première phrase/);
  const openSalle = `Bonjour Karim, nous étions complets ce soir-là, mais ${pad(25)}. Venez nous revoir.\n${sig}`;
  assert.match(checkReply(openSalle, att.profile, rev).errors.join(), /première phrase/);
  // Reconnaissance d'abord, explication ensuite : permis.
  const ok = `Bonjour Karim, vous avez raison, l'attente était trop longue. ${pad(20)} La salle était complète ce soir-là. Revenez nous voir.\n${sig}`;
  const rc = checkReply(ok, att.profile, att.review);
  assert.ok(!rc.errors.some(e => /première phrase/.test(e)), rc.errors.join());
});

/* ---------- Triplette rhétorique ---------- */
test('triplette « X, Y et Z » → rejet ; énumération de clauses permise', () => {
  const c = byKey('commande');
  const triad = `Bonjour Nadia, l'attente, le plat froid et le service distant ont gâché votre soirée. Revenez nous voir quand vous voulez. ${pad(22)}\n${sig}`;
  assert.match(checkReply(triad, c.profile, c.review).errors.join(), /triplette/);
  // « venez plutôt en semaine, c'est plus calme et je passerai vous saluer » :
  // des clauses, pas des éléments — permis.
  const clauses = `Bonjour Nadia, venez plutôt en semaine, c'est plus calme et je passerai vous saluer. ${pad(28)}\n${sig}`;
  const rc = checkReply(clauses, c.profile, c.review);
  assert.ok(!rc.errors.some(e => /triplette/.test(e)), rc.errors.join());
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
  const bare = `Bonjour Karim, écrivez à contact@tabledaurore.fr si besoin d’en parler. ${pad(31)}. Revenez nous voir.\n${sig}`;
  const bareMail = `Bonjour Karim, notre adresse est contact@tabledaurore.fr en passant. ${pad(31)}. Revenez nous voir.\n${sig}`;
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

/* ---------- Liens ---------- */
test('aucune URL ni nom de domaine dans une réponse publique (anti-injection)', () => {
  const c = byKey('plat-froid');
  assert.match(
    checkReply(`${body(c)} Visitez https://exemple-restaurant.fr pour découvrir le menu.\n${sig}`, c.profile, c.review).errors.join(),
    /lien ou nom de domaine/, 'URL explicite rejetée');
  assert.match(
    checkReply(`${body(c)} Rejoignez-nous sur booking.com pour votre prochain repas.\n${sig}`, c.profile, c.review).errors.join(),
    /lien ou nom de domaine/, 'domaine nu rejeté');
  // L'email de contact déclaré du profil n'est pas un « lien ».
  const mail = checkReply(`${body(c)} Écrivez à contact@tabledaurore.fr.\n${sig}`, c.profile, c.review);
  assert.ok(!mail.errors.some(e => /lien ou nom de domaine/.test(e)), 'email du profil non rejeté');
});
