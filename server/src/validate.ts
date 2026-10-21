// Validation métier côté serveur (le frontend valide aussi, mais ne fait pas foi).
import { CONTEXT_TAGS, TONES } from './llm/prompt.js';
import type { ContextTag, Tone } from './llm/prompt.js';

export function isDate(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(s + 'T12:00:00Z').getTime());
}

export function isEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
}

const str = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max + 1);

/* ---------- Profil du restaurant ---------- */
export interface ProfileInput {
  name: string; city: string; cuisine: string;
  signature_name: string; signature_role: string; tone: Tone;
  strengths: string[]; practical_info: string;
  google_maps_url: string; google_review_url: string;
  contact_email: string; contact_phone: string; show_phone: boolean;
}

const GOOGLE_HOSTS = ['google.com', 'google.fr', 'g.page', 'maps.app.goo.gl', 'goo.gl', 'business.google.com', 'search.google.com', 'maps.google.com'];
export function validGoogleUrl(v: string): boolean {
  try {
    const u = new URL(v);
    if (u.protocol !== 'https:' || u.username || u.password) return false;
    const h = u.hostname.toLowerCase();
    return GOOGLE_HOSTS.some(g => h === g || h.endsWith('.' + g));
  } catch { return false; }
}

export function validateProfile(body: any): { value?: ProfileInput; error?: string } {
  if (!body || typeof body !== 'object') return { error: 'Corps de requête invalide.' };
  const name = str(body.name, 100);
  if (!name || name.length > 100) return { error: 'Nom du restaurant invalide (1 à 100 caractères).' };
  const city = str(body.city, 100);
  if (city.length > 100) return { error: 'Ville trop longue (100 caractères).' };
  const cuisine = str(body.cuisine, 100);
  if (cuisine.length > 100) return { error: 'Type de cuisine trop long (100 caractères).' };
  const signature_name = str(body.signature_name, 80);
  const signature_role = str(body.signature_role, 80);
  if (signature_name.length > 80 || signature_role.length > 80) return { error: 'Signature trop longue (80 caractères par champ).' };
  const tone = String(body.tone ?? 'chaleureux');
  if (!(tone in TONES)) return { error: 'Ton invalide.' };
  const rawStrengths = Array.isArray(body.strengths) ? body.strengths : [];
  const strengths = [...new Set(rawStrengths.map((s: unknown) => str(s, 60)).filter(Boolean))] as string[];
  if (strengths.length > 8 || strengths.some(s => s.length > 60)) return { error: 'Points forts : 8 maximum, 60 caractères chacun.' };
  const practical_info = str(body.practical_info, 300);
  if (practical_info.length > 300) return { error: 'Infos pratiques trop longues (300 caractères).' };
  const google_maps_url = str(body.google_maps_url, 500);
  if (google_maps_url && (google_maps_url.length > 500 || !validGoogleUrl(google_maps_url)))
    return { error: 'Lien de la fiche Google invalide : collez l’URL https de Google Maps.' };
  const google_review_url = str(body.google_review_url, 500);
  if (google_review_url && (google_review_url.length > 500 || !validGoogleUrl(google_review_url)))
    return { error: 'Lien « laisser un avis » invalide : il doit pointer vers Google (g.page, google.com…).' };
  const contact_email = str(body.contact_email, 200);
  if (contact_email && (contact_email.length > 200 || !isEmail(contact_email))) return { error: 'Email de contact invalide.' };
  const contact_phone = str(body.contact_phone, 30);
  if (contact_phone && (contact_phone.length > 30 || !/^[+\d][\d\s().-]{5,}$/.test(contact_phone))) return { error: 'Téléphone de contact invalide.' };
  const show_phone = body.show_phone === true || body.show_phone === 'true' || body.show_phone === 'on';
  return { value: { name, city, cuisine, signature_name, signature_role, tone: tone as Tone, strengths, practical_info, google_maps_url, google_review_url, contact_email, contact_phone, show_phone } };
}

/* ---------- Avis ---------- */
export interface ReviewInput {
  author_name: string; rating: number; body: string; visited_on: string | null;
  context_tags: ContextTag[]; context_note: string;
}

export function validateReview(body: any): { value?: ReviewInput; error?: string } {
  if (!body || typeof body !== 'object') return { error: 'Corps de requête invalide.' };
  const rating = Number(body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return { error: 'Note invalide (1 à 5).' };
  const author_name = str(body.author_name, 80);
  if (author_name.length > 80) return { error: 'Prénom de l’auteur trop long (80 caractères).' };
  const text = String(body.body ?? '').trim();
  if (text.length > 4000) return { error: 'Texte de l’avis trop long (4 000 caractères).' };
  const visited_on = body.visited_on ? body.visited_on : null;
  if (visited_on !== null && !isDate(visited_on)) return { error: 'Date de visite invalide (AAAA-MM-JJ).' };
  const rawTags = Array.isArray(body.context_tags) ? body.context_tags : [];
  const context_tags = [...new Set<ContextTag>(rawTags.filter((t: unknown): t is ContextTag => typeof t === 'string' && t in CONTEXT_TAGS))];
  const context_note = str(body.context_note, 300);
  if (context_note.length > 300) return { error: 'Précision trop longue (300 caractères).' };
  return { value: { author_name, rating, body: text, visited_on, context_tags: rating <= 3 ? context_tags : [], context_note: rating <= 3 ? context_note : '' } };
}

// Neutralisation des formules de tableur à l'export CSV.
export function csvCell(x: unknown): string {
  let s = String(x ?? '');
  if (/^[=+@\-\t\r\n]/.test(s)) s = "'" + s;
  return '"' + s.replaceAll('"', '""') + '"';
}
