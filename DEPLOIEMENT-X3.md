# Déploiement Le Mot du Chef sur X3

Guide d'installation sur le serveur X3 (`192.168.1.166`, user `unipaycongo`).
Rien de ce guide n'a été exécuté sur X3 : à lancer depuis x2 via SSH ou sur X3 directement.
Les applications existantes (UniPay :3100, CongoGaming :3001, Art50 Check :3000,
Hasanat :3200, DevisPilot :3400) ne sont pas touchées.

## Pré-requis vérifiés sur X3 (lecture seule, oct. 2026)

- Docker + Compose installés ; ~5,7 Gio RAM, ~687 Gio disque (5 % utilisé).
- `cloudflared.service` actif en systemd, tunnel `x3-unipay` géré par token
  (configuration des hostnames dans le dashboard Cloudflare Zero Trust).
- Pas de reverse proxy local ; les apps existantes écoutent sur `127.0.0.1`.
- Port choisi : **3500** (3400 est déjà pris par DevisPilot). Vérifier au
  moment du déploiement : `ssh unipaycongo@192.168.1.166 'ss -tln | grep 3500'`
  Si pris : choisir un autre port libre et ajuster `API_PORT` + le tunnel.

## 1. Installation

```bash
# Sur x2 (ou sur X3) — transférer le dépôt
git clone <url-du-depot> && cd lemotduchef
# ou rsync : rsync -a --exclude node_modules --exclude .git /home/ben/CascadeProjects/lemotduchef/ unipaycongo@192.168.1.166:lemotduchef/

cp .env.example .env
nano .env   # valeurs à renseigner (voir ci-dessous)
```

`.env` de production :

```bash
POSTGRES_PASSWORD=<généré : openssl rand -base64 24>
BETTER_AUTH_SECRET=<généré : openssl rand -base64 32>
BASE_URL=https://api.lemotduchef.fr          # origine publique de l'API
API_PORT=3500
CORS_ORIGINS=https://lemotduchef.fr,https://www.lemotduchef.fr
FRONT_URL=https://lemotduchef.fr             # liens des emails pointent ici
COOKIE_SAMESITE=lax                          # apex/www + api. = même site
COOKIE_DOMAIN=                               # vide : cookie host-only
TRUST_PROXY=true

# Rédacteur LLM — OBLIGATOIRE pour la génération de réponses
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
LLM_MODEL=claude-sonnet-4-5-20250929

# Emails transactionnels — OBLIGATOIRE pour l'inscription
# (la vérification d'email est requise : sans SMTP l'inscription est refusée 503)
SMTP_HOST=<serveur-smtp>
SMTP_PORT=587
SMTP_USER=<utilisateur-smtp>
SMTP_PASS=<mot-de-passe-smtp>
MAIL_FROM=Le Mot du Chef <noreply@lemotduchef.fr>

SIGNUP_ENABLED=true                          # inscription libre une fois SMTP
                                             # actif ; l'interrupteur du
                                             # back-office est prioritaire
ADMIN_EMAILS=votre-email@lemotduchef.fr      # accès /admin, virgules = liste

# Offres (défauts : 5 réponses/mois, historique 30 j, purge à 12 mois)
FREE_MONTHLY_REPLIES=5
FREE_HISTORY_DAYS=30
REVIEW_RETENTION_MONTHS=12

# Abonnement Stripe — sk_test_* pour la préproduction, sk_live_* en prod
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...              # signing secret du webhook (§4)
STRIPE_PORTAL_RETURN_URL=https://lemotduchef.fr
STRIPE_PRICE_PRO_MONTHLY=price_...
STRIPE_PRICE_PRO_YEARLY=price_...
```

`BASE_URL` en https active automatiquement les cookies `Secure`. `TRUST_PROXY=true`
requis : le trafic arrive via cloudflared (en-têtes `X-Forwarded-*`).

```bash
docker compose build
docker compose up -d          # migrations jouées automatiquement au démarrage de l'API
docker compose ps             # les deux services doivent être « healthy »
curl -s http://127.0.0.1:3500/api/health   # → {"ok":true}
```

## 2. Routage Cloudflare (dashboard Zero Trust)

Le tunnel `x3-unipay` est géré côté dashboard (token). Ajouter une entrée :

- **Public hostname** : `api.lemotduchef.fr` → service `http://localhost:3500`

Le frontend est déployé séparément sur Vercel (`https://lemotduchef.fr` +
`https://www.lemotduchef.fr`, build `npm run build`, output `dist`, env
`VITE_API_URL=https://api.lemotduchef.fr`). L'API seule passe par le tunnel ;
les requêtes sont cross-origin avec credentials — `CORS_ORIGINS` doit lister
les deux origines frontend exactes.

DNS (dashboard Cloudflare, zone `lemotduchef.fr`) : le hostname public du
tunnel crée l'enregistrement `api` automatiquement ; `lemotduchef.fr` et `www`
sont gérés par Vercel (enregistrements indiqués par Vercel à l'ajout du
domaine — proxy Cloudflare désactivé sur ces entrées pour laisser Vercel
émettre le certificat).

### Variables Vercel (pages légales)

Les pages `/mentions-legales`, `/cgv` et `/confidentialite` lisent leurs
valeurs depuis `config.js`, généré au build. Renseigner dans Vercel →
Settings → Environment Variables (toutes obligatoires — le build échoue sinon) :

```
VITE_API_URL=https://api.lemotduchef.fr
LEGAL_NAME=…
LEGAL_SIREN=…
LEGAL_RCS=…
LEGAL_ADDRESS=…
LEGAL_EMAIL=…
LEGAL_VAT_MENTION=TVA non applicable, art. 293 B du CGI
LEGAL_PUBLISHER=…
```

La version des CGV (`CGV_VERSION` dans `server/src/legal.ts`) est diffusée au
front via `/api/config` — incrémenter la constante et redéployer l'API pour
exiger une ré-acceptation.

Vérifier ensuite : `curl -s https://api.lemotduchef.fr/api/health`.

## 3. Clé Anthropic (console.anthropic.com)

1. Créer une clé API dédiée au produit, la copier dans `ANTHROPIC_API_KEY`.
2. `LLM_MODEL` : modèle de génération (défaut `claude-sonnet-4-5-20250929`).
3. Les appels partent du serveur uniquement ; la clé n'apparaît jamais au
   front ni dans `/api/config`. Timeout `LLM_TIMEOUT_MS` (défaut 40 s) ;
   en cas d'erreur fournisseur l'utilisateur reçoit un message propre (502)
   sans détail technique. Chaque génération journalise les tokens consommés
   (suivi de coût) — surveiller via `docker logs lemotduchef-api`.

## 4. Configuration Stripe (dashboard)

1. **Produit** : créer « Le Mot du Chef Pro » avec 2 prix récurrents EUR —
   mensuel et annuel. Copier les 2 `price_…` dans `.env`.
2. **Portail client** : Paramètres → Billing → Customer portal → activer
   (changement d'offre, moyen de paiement, factures, résiliation).
3. **Webhook** : Développeurs → Webhooks → ajouter un endpoint
   `https://api.lemotduchef.fr/api/stripe/webhook` avec les événements :
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
   `checkout.session.async_payment_failed`, `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted`,
   `invoice.paid`, `invoice.payment_failed`. Copier le *signing secret*
   (`whsec_…`) dans `STRIPE_WEBHOOK_SECRET`, puis `docker compose up -d api`.
4. Vérifier : `POST /api/billing/checkout` depuis l'espace client renvoie une
   URL `checkout.stripe.com` ; l'événement test du dashboard apparaît traité
   (200) côté API.
5. **Conformité factures** (micro-entreprise, franchise de TVA) — Paramètres :
   - *Business* : nom légal, adresse et SIREN de l'entrepreneur.
   - *Customer portal → Factures* ou *Billing* : pied de facture avec
     « TVA non applicable, art. 293 B du CGI ».
   - *Public details* : descripteur de relevé `LEMOTDUCHEF`, URL des CGV
     `https://lemotduchef.fr/cgv` et politique de confidentialité
     `https://lemotduchef.fr/confidentialite`.
   - Stripe Tax : ne pas activer (aucune TVA collectée ; `automatic_tax`
     n'est pas activé dans Checkout).

## 5. Emails transactionnels

Vérification d'email (obligatoire, lien 24 h), mot de passe oublié (lien 1 h,
usage unique) et changement d'email passent par le SMTP configuré
(`SMTP_HOST/PORT/USER/PASS`, `MAIL_FROM`). N'importe quel relais SMTP convient
(Brevo, Mailjet, Resend en mode SMTP, OVH…) — relever host/user/pass chez le
fournisseur et configurer SPF/DKIM sur `lemotduchef.fr` selon sa documentation.
Les liens pointent vers `FRONT_URL`, pas vers l'API. Au démarrage, un warning
est loggé si SMTP est absent ; l'inscription publique est alors refusée (503).
`SMTP_HOST=log` = mode test : emails journalisés, aucun envoi réel.

## 6. Création des premiers comptes

- `SIGNUP_ENABLED=true` : inscription libre (email de vérification 24 h,
  mot de passe ≥ 12 caractères, CGV à accepter ; le profil restaurant est
  demandé à la première connexion).
- `SIGNUP_ENABLED=false` : création depuis le back-office `/admin`
  (« Créer un compte client » — email d'invitation). L'interrupteur
  d'inscription du back-office, stocké en base, est prioritaire sur
  `SIGNUP_ENABLED`.

## Back-office administrateur

Accessible sur `https://lemotduchef.fr/admin` pour les comptes dont l'email
figure dans `ADMIN_EMAILS` (email vérifié requis). Fonctions : tableau de bord
(comptes, utilisateurs, inscriptions 7/30 j, avis saisis, générations du mois,
abonnés payants, MRR), listes de comptes (offre, statut d'abonnement, nombre
d'avis) et d'utilisateurs (recherche/tri, métadonnées uniquement — jamais le
contenu des avis ni des réponses), suspension/réactivation, révocation de
sessions, suppression de compte, interrupteur d'inscription, création de
compte par invitation et journal d'audit.

## 7. Sauvegardes

```bash
./scripts/backup.sh                    # → dumps/lemotduchef-<date>.dump
```

Le script fait la rotation lui-même : dumps de plus de 14 jours supprimés
(`BACKUP_KEEP_DAYS` pour changer), sans jamais effacer le dernier dump ; il
échoue bruyamment si `pg_dump` tombe ou si le fichier produit est vide.

Copie hors X3 (manuel, non planifié) :

```bash
rsync -a unipaycongo@192.168.1.166:lemotduchef/dumps/ ~/sauvegardes/lemotduchef/
```

Planification : le cron n'est pas installé par le script — à ajouter sur X3
(les autres apps du serveur ont déjà les leurs) :

```bash
(crontab -l; echo '15 3 * * * /home/unipaycongo/lemotduchef/scripts/backup.sh >> /home/unipaycongo/lemotduchef/dumps/backup.log 2>&1') | crontab -
```

## 8. Restauration (testée localement)

```bash
./scripts/restore.sh dumps/lemotduchef-<date>.dump
# confirmation « restaure » demandée ; arrête l'API, restaure, redémarre.
curl -s http://127.0.0.1:3500/api/health
```

La restauration remplace toutes les données (`pg_restore --clean --if-exists`).

## 9. Mises à jour et rollback

```bash
git pull                      # ou rsync de la nouvelle version
docker compose build api
./scripts/backup.sh           # toujours sauvegarder avant migration de schéma
docker compose up -d api      # les migrations SQL s'appliquent au démarrage
docker logs lemotduchef-api --tail 50
```

**Rollback** : revenir au commit précédent, `docker compose build api && up -d api`.
Si une migration future est incompatible : restaurer la sauvegarde d'avant
mise à jour (§8) puis redéployer l'ancienne image.
`docker image ls | grep lemotduchef` — garder le tag de l'image précédente.

## 10. Logs et exploitation

```bash
docker logs -f lemotduchef-api        # cookies, tokens et secrets masqués (pino redact)
docker logs -f lemotduchef-db
docker compose ps
```

La purge RGPD tourne dans le processus API (toutes les 24 h + au démarrage) :
les avis de plus de `REVIEW_RETENTION_MONTHS` mois voient texte, prénom
d'auteur et variantes effacés (note, contexte et réponse publiée conservés).

## Limites connues

- Sessions en base PostgreSQL, 14 jours, révocables (onglet Compte, ou admin).
- Rate-limit en mémoire (par processus) — suffisant pour un conteneur unique.
- Un seul utilisateur par restaurant aujourd'hui ; rôles `owner`/`member`
  prêts pour la suite.
- Pas de multi-instance : une API = une base.
- Le domaine `api.lemotduchef.fr` ne sert pas le front : toute page hors `/api`
  redirige (302) vers `FRONT_URL` ; le front n'est servi que si front et API
  partagent la même origine (auto-hébergement).
- La synchronisation Google Business Profile (lecture des avis, publication
  automatique) n'est pas implémentée : le restaurateur colle les avis et
  publie ses réponses lui-même ; l'interface `ReviewSource` est prête.
- Changement d'email : le lien de confirmation part vers la nouvelle adresse ;
  l'ancienne reste l'identifiant jusqu'à validation.
