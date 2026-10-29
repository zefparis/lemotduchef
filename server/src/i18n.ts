import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { marketConfig, type Market } from './markets.js';

// Chaînes serveur par langue — source unique : public/i18n.js, extrait
// comme JSON au démarrage (même schéma que markets.ts). Une langue absente
// retombe sur le français, une clé absente sur la clé elle-même.
type Lang = 'fr' | 'en';

function loadDicts(): Record<Lang, Record<string, string>> {
  const file = path.join(config.staticRoot, 'i18n.js');
  const json = fs.readFileSync(file, 'utf8').slice(
    fs.readFileSync(file, 'utf8').indexOf('{'),
    fs.readFileSync(file, 'utf8').lastIndexOf('}') + 1);
  const d = JSON.parse(json) as Record<Lang, Record<string, string>>;
  if (!d.fr || !d.en) throw new Error('public/i18n.js : dicts fr/en manquants');
  return d;
}
const DICTS = loadDicts();

export function tr(lang: string, key: string, vars?: Record<string, string | number>): string {
  let s = (DICTS[lang as Lang] ?? DICTS.fr)[key] ?? DICTS.fr[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

// Langue serveur = langue du marché (ZA → en) — point d'entrée unique pour
// emails, notifications push et PDF tant que user.lang n'est pas exposé ici.
export const marketLang = (market: Market): Lang =>
  (marketConfig(market).lang === 'en' ? 'en' : 'fr');
