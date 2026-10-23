# Le Mot du Chef

Réponses intelligentes aux avis Google pour restaurateurs indépendants.
Front statique sur `lemotduchef.fr` (Vercel), API sur `api.lemotduchef.fr`
(serveur X3 derrière un tunnel Cloudflare).

- `public/` — frontend statique (HTML/CSS/JS sans framework, build `build.mjs`).
- `server/` — API Fastify : Better Auth (sessions serveur en base, révocables),
  isolation par restaurant via `memberships`, protection CSRF (en-tête
  `x-lemotduchef-client` + contrôle d'origine), rate-limit, quotas côté serveur.

## Développement local

```bash
# PostgreSQL de dev (port 5445 pour ne pas entrer en conflit)
docker run -d --name lmc-pg -e POSTGRES_USER=lemotduchef \
  -e POSTGRES_PASSWORD=lemotduchef -e POSTGRES_DB=lemotduchef \
  -p 127.0.0.1:5445:5432 postgres:17-alpine

cd server && npm install
cp .env.example .env    # ou exporter les variables
npm run dev             # http://127.0.0.1:3500 — sert aussi public/
npm test                # 35 tests d'intégration (LLM mocké, SMTP=log)
```

En dev, `LLM_PROVIDER=mock` (défaut hors production) produit trois variantes
plausibles sans clé API, et `SMTP_HOST=log` journalise les emails au lieu de
les envoyer. Le mode `mock` est refusé en production.

## Produit

**Répondre à un avis.** Le restaurateur colle l'avis (texte, note 1–5, prénom
affiché, date de visite), précise le contexte pour les notes ≤ 3 (jamais venu,
salle complète, attente annoncée au client à son arrivée, plat conforme,
problème réel, prix affichés, allergie/santé, autre). Le serveur génère **3 variantes** via un LLM
(Anthropic, `LLM_PROVIDER`/`ANTHROPIC_API_KEY`/`LLM_MODEL`, timeout, tokens
journalisés) sous un prompt système versionné (`server/src/llm/prompt.ts`) :
réponse adressée aux futurs lecteurs, toujours courtoise, jamais d'accusation
ni de menace ni de donnée personnelle, sujets santé traités sans reconnaissance
de responsabilité, un point fort rappelé, signature du profil, 50–120 mots
(30–70 pour un avis positif), formulations distinctes des 10 dernières
réponses. Chaque variante est validée avant d'être renvoyée ; l'utilisateur
peut l'éditer, la copier, ouvrir sa fiche Google et cocher « publiée ».

**Avis suspect.** Indicateurs calculés côté serveur (1 étoile sans texte, hors
sujet, autre établissement cité, propos injurieux) → badge + guide de
signalement honnête : motif Google conseillé, texte prêt à copier, lien d'aide,
et rappel que Google ne retire que les avis contraires à ses règles.

**Collecte d'avis.** À partir du lien « laisser un avis » de la fiche Google :
chevalet de table et encart d'addition en PDF avec QR code (pdf-lib + qrcode),
texte personnalisable. Le QR mène **tous** les clients à Google : aucun filtre
de satisfaction, aucune contrepartie — affirmé dans l'interface.

**Profil restaurant** (onboarding après inscription) : nom, ville, type de
cuisine, points forts, infos pratiques, URL Google Maps validée, email et
téléphone de contact réclamations — plus le réglage « Mon style » appliqué à
chaque génération : ton (sobre / chaleureux / direct), vouvoiement ou
tutoiement du client, signature (« Marc, chef et propriétaire », réponse au
« je » si un prénom est signé) et expressions à éviter.

**Offres.** Gratuit : `FREE_MONTHLY_REPLIES` générations/mois (défaut 5, sans
carte), historique `FREE_HISTORY_DAYS` jours. Pro : générations illimitées,
chevalets/encarts, historique complet. Prix relus depuis l'API Stripe
(`STRIPE_PRICE_PRO_MONTHLY`/`_YEARLY`), aucun montant en dur, quota appliqué
côté serveur, webhooks signés et idempotents comme source de vérité.

**RGPD.** Texte de l'avis, prénom d'auteur et variantes purgés après
`REVIEW_RETENTION_MONTHS` mois (défaut 12) — seules la note, le contexte et la
réponse publiée sont conservés. Le restaurateur est responsable de traitement,
le service sous-traitant (clause art. 28 dans les CGV/confidentialité). Export
compte complet et suppression en cascade avec révocation des sessions.

**Back-office exploitant** sur `/admin` : réservé aux emails de `ADMIN_EMAILS`
(vérifiés côté serveur à chaque requête). Statistiques (comptes, utilisateurs,
inscriptions 7/30 j, avis, générations du mois, abonnés payants et MRR), listes
de comptes et d'utilisateurs (métadonnées uniquement — jamais le contenu des
avis ni des réponses), suspension/réactivation avec révocation des sessions,
suppression de compte, interrupteur d'inscription stocké en base, création de
compte par invitation, journal d'audit.

**V2 préparée, non codée** : `server/src/sources/index.ts` définit
`ReviewSource` (`manual | google`) pour brancher plus tard l'API Google
Business Profile (OAuth, lecture des avis, publication des réponses).

## Déploiement

Voir `DEPLOIEMENT-X3.md`. En résumé : `docker compose build && up -d` sur X3
(API sur `127.0.0.1:3500`, tunnel Cloudflare `api.lemotduchef.fr`), front sur
Vercel (build `npm run build`, output `dist`, env `VITE_API_URL` + `LEGAL_*`).

## Vérifications

```bash
cd server && npm run typecheck && npm run build && npm test
cd .. && npm run build        # dist/ frontend
node --check public/app.js
```
