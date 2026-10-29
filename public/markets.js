// Configuration par marché — FICHIER UNIQUE.
// Consommé par le front (script <src="markets.js">) et par l'API
// (server/src/markets.ts extrait le JSON ci-dessous au démarrage).
// Ne mettre ici QUE des données publiques (les clés et secrets restent
// dans les variables d'environnement du serveur, cf. config.ts).
//
// ┌─ À RENSEIGNER AVANT LE LANCEMENT ZA ────────────────────────────
// │ za.company          : société éditrice sud-africaine (nom, n°
// │                       d'enregistrement, adresse, email, téléphone)
// │ za.prices           : identifiants des plans Pro (Paystack d'abord,
// │                       Stripe si le compte ZA l'ouvre) — montants
// │                       relus depuis l'API du provider, jamais en dur
// │ Passage ultérieur à un domaine .co.za : mettre à jour UNIQUEMENT
// │ za.domains, za.frontUrl, za.mailFrom, za.reviewMailAddress et
// │ za.legalRoutes ici — aucun changement de code requis.
// └─────────────────────────────────────────────────────────────────
window.LMC_MARKETS = {
  "default": "fr",
  "markets": {
    "fr": {
      "lang": "fr",
      "languages": ["fr", "en"],
      "locale": "fr-FR",
      "currency": "EUR",
      "timezone": "Europe/Paris",
      "brand": "Le Mot du Chef",
      "tagline": "réponses aux avis Google",
      "frontUrl": "https://lemotduchef.fr",
      "apiUrl": "",
      "mailFrom": "Le Mot du Chef <noreply@lemotduchef.fr>",
      "reviewMailAddress": "avis@lemotduchef.fr",
      "payment": { "provider": "stripe" },
      "company": {
        "name": "",
        "registration": "",
        "address": "",
        "email": "",
        "phone": ""
      },
      "legalRoutes": {
        "mentions": "/mentions-legales",
        "cgv": "/cgv",
        "privacy": "/confidentialite"
      },
      "domains": ["lemotduchef.fr", "www.lemotduchef.fr", "localhost", "127.0.0.1", "api.lemotduchef.fr"]
    },
    "za": {
      "lang": "en",
      "languages": ["en", "fr"],
      "locale": "en-ZA",
      "currency": "ZAR",
      "timezone": "Africa/Johannesburg",
      "brand": "Le Mot du Chef",
      "tagline": "replies to Google reviews",
      "frontUrl": "https://za.lemotduchef.fr",
      "apiUrl": "",
      "mailFrom": "Le Mot du Chef <noreply@lemotduchef.fr>",
      "reviewMailAddress": "avis@lemotduchef.fr",
      "payment": { "provider": "paystack" },
      "company": {
        "name": "",
        "registration": "",
        "address": "",
        "email": "",
        "phone": ""
      },
      "prices": { "pro_monthly": "", "pro_yearly": "" },
      "legalRoutes": {
        "mentions": "/legal-notice",
        "cgv": "/terms",
        "privacy": "/privacy"
      },
      "domains": ["za.lemotduchef.fr"]
    }
  }
};
