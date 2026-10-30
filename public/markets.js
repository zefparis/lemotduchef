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
      "indexable": false,
      "company": {
        "name": "IA Solution",
        "registration": "Sole proprietorship (entreprise individuelle) of Benjamin Barrère — SIREN 438 055 097, RCS Nîmes 438 055 097",
        "address": "2 rue du Sabotier, 30350 Saint-Bénézet, France",
        "email": "contact@ia-solution.fr",
        "phone": "+33 7 63 49 47 78",
        "vatMention": "No VAT charged"
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
      "payment": { "provider": "stripe" },
      "indexable": false,
      "company": {
        "name": "IA Solution",
        "registration": "Sole proprietorship (entreprise individuelle) of Benjamin Barrère — SIREN 438 055 097, RCS Nîmes 438 055 097",
        "address": "2 rue du Sabotier, 30350 Saint-Bénézet, France",
        "email": "contact@ia-solution.fr",
        "phone": "+33 7 63 49 47 78",
        "vatMention": "No VAT charged"
      },
      "prices": { "pro_monthly": "", "pro_yearly": "" },
      "legalRoutes": {
        "mentions": "/legal-notice",
        "cgv": "/terms",
        "privacy": "/privacy"
      },
      "domains": ["za.lemotduchef.fr"]
    },
    "ke": {
      "lang": "en",
      "languages": ["en", "fr"],
      "locale": "en-KE",
      "currency": "KES",
      "timezone": "Africa/Nairobi",
      "brand": "Le Mot du Chef",
      "tagline": "Replies to Google reviews for restaurateurs",
      "frontUrl": "https://ke.lemotduchef.fr",
      "apiUrl": "https://api.lemotduchef.fr",
      "mailFrom": "Le Mot du Chef <avis@lemotduchef.fr>",
      "reviewMailAddress": "avis@lemotduchef.fr",
      "payment": { "provider": "stripe" },
      "indexable": false,
      "company": {
        "name": "IA Solution",
        "registration": "Sole proprietorship (entreprise individuelle) of Benjamin Barrère — SIREN 438 055 097, RCS Nîmes 438 055 097",
        "address": "2 rue du Sabotier, 30350 Saint-Bénézet, France",
        "email": "contact@ia-solution.fr",
        "phone": "+33 7 63 49 47 78",
        "vatMention": "No VAT charged"
      },
      "prices": { "pro_monthly": "", "pro_yearly": "" },
      "legalRoutes": {
        "mentions": "/legal-notice",
        "cgv": "/terms",
        "privacy": "/privacy"
      },
      "domains": ["ke.lemotduchef.fr"]
    },
    "cd": {
      "lang": "fr",
      "languages": ["fr", "en"],
      "locale": "fr-CD",
      "currency": "USD",
      "timezone": "Africa/Kinshasa",
      "brand": "Le Mot du Chef",
      "tagline": "Réponses aux avis Google pour les restaurateurs",
      "frontUrl": "https://cd.lemotduchef.fr",
      "apiUrl": "https://api.lemotduchef.fr",
      "mailFrom": "Le Mot du Chef <avis@lemotduchef.fr>",
      "reviewMailAddress": "avis@lemotduchef.fr",
      "payment": { "provider": "stripe" },
      "indexable": false,
      "company": {
        "name": "IA Solution",
        "registration": "Sole proprietorship (entreprise individuelle) de Benjamin Barrère — SIREN 438 055 097, RCS Nîmes 438 055 097",
        "address": "2 rue du Sabotier, 30350 Saint-Bénézet, France",
        "email": "contact@ia-solution.fr",
        "phone": "+33 7 63 49 47 78",
        "vatMention": "TVA non applicable"
      },
      "prices": { "pro_monthly": "", "pro_yearly": "" },
      "legalRoutes": {
        "mentions": "/mentions-legales",
        "cgv": "/cgv",
        "privacy": "/confidentialite"
      },
      "domains": ["cd.lemotduchef.fr"]
    }
  }
};
