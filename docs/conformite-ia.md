# Registre de conformité IA — Le Mot du Chef

*Document interne, non public. Date : 2026-10-28.*

## Classification (règlement (UE) 2024/1689 « AI Act »)

Le service est un **système d'IA générative de texte** (rédaction de réponses
aux avis Google). Il est :

- **non interdit** (pas de pratique visée à l'art. 5 : aucune manipulation
  subliminale, aucune exploitation de vulnérabilité, aucun filtrage des avis
  selon la satisfaction — interdit par le produit lui-même) ;
- **non haut risque** (pas de domaine de l'annexe III) ;
- **soumis à l'article 50** (transparence des contenus générés) applicable
  depuis le 2 août 2026 — le service est entré sur le marché en octobre 2026.

## Mesures art. 50 — contenus générés

- **Exception « très courts textes »** : le code de bonnes pratiques européen
  (juin 2026) exempte du filigrane lisible par machine les textes de moins de
  200 jetons. Le service **plafonne chaque réponse à < 180 jetons** (marge de
  sécurité de 10 %).
- **Relecture humaine** : chaque proposition est un brouillon présenté comme
  tel, jamais publié automatiquement ; le restaurateur relit, édite et publie
  en son nom (exception de responsabilité éditoriale, art. 50(4)).
- **Mention en interface** : chaque variante affiche « Réponse proposée par
  une IA — relisez-la avant de la publier ».

### Plafond de longueur — implémentation et tests

- Consigne dans le prompt système : 45–55 mots visés, 55–70 mots maximum
  selon l'avis (`prompt.ts`, fourchettes `*_WORDS`).
- `max_tokens` de sortie : 700 (`LLM_MAX_OUTPUT_TOKENS`).
- Contrôle après génération par le tokenizer du fournisseur
  (`provider.countTokens` — endpoint `count_tokens` d'Anthropic ; estimation
  hors-ligne calibrée en dev/tests). Une variante ≥ 180 jetons est écartée et
  régénérée plus courte (seconde tentative déjà prévue).
- Test d'intégration : variante trop longue écartée puis régénérée.
- Mesure initiale (2026-10-28, 5 variantes en production) : 199,6 jetons en
  moyenne, médiane 231, p95 233, max 244 — soit ~2,5 jetons/mot en français
  signature comprise ; 70 mots ≈ 175 jetons.

## Minimisation des données (RGPD)

- Le **prénom de l'auteur** de l'avis n'est jamais envoyé au modèle : le
  prompt reçoit le marqueur `[PRÉNOM]` (`AUTHOR_MARKER`). Il n'est réinséré
  dans la réponse, côté serveur après génération, que si le restaurateur
  coche « Inclure ce prénom » (`include_author_name`, défaut : inclus).
- Données transmises au modèle : texte de l'avis, note, contexte restaurateur,
  profil du restaurant (nom, ville, cuisine, points forts, ton, signature,
  contacts publics). Aucune donnée du compte utilisateur.
- Conservation : texte de l'avis, prénom, contexte et variantes purgés après
  `REVIEW_RETENTION_MONTHS` (12 mois par défaut) ; note, date et réponse
  publiée conservées dans l'historique jusqu'à clôture du compte.

## Fournisseur du modèle

- **Anthropic PBC** — API Messages (modèle : `LLM_MODEL`, production :
  claude-haiku-5-5), États-Unis. Rôle : sous-traitant (art. 28 RGPD, clauses
  contractuelles types — voir politique de confidentialité).
- **Entraînement** : les données envoyées via l'API commerciale Anthropic ne
  sont pas utilisées pour l'entraînement des modèles (politique de
  confidentialité Anthropic API, vérifiée à la mise en production).
- **Rétention côté fournisseur** : conservation courte des entrées/sorties à
  des fins de sécurité avant suppression automatique.
- Aucun autre fournisseur configuré (`LLM_PROVIDER=anthropic` ; le mode
  `mock`, refusé en production, n'appelle aucun service externe).

## Journalisation

- `generations` : tokens d'entrée/sortie, modèle, durée, statut — jamais le
  contenu de l'avis ni des réponses.
- Aucune donnée personnelle dans les journaux applicatifs (cookies et
  en-têtes d'authentification masqués).
