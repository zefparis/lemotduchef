// Sources d'avis. V1 : saisie manuelle (copier-coller). V2 : API Google
// Business Profile (OAuth, lecture des avis, publication des réponses) —
// l'interface est figée ici pour brancher Google sans toucher aux routes.

export type ReviewSourceKind = 'manual' | 'google';

export interface ExternalReview {
  externalId: string | null;     // identifiant côté source (null en manuel)
  authorName: string;            // prénom/nom tel qu'affiché publiquement
  rating: number;                // 1..5
  body: string;
  visitedOn: string | null;      // AAAA-MM-JJ si connu
  createdAt: string | null;      // ISO, date de publication côté source
}

export interface ReviewSource {
  readonly kind: ReviewSourceKind;
  // La source est-elle connectée pour ce restaurant (OAuth valide…) ?
  isConnected(companyId: string): Promise<boolean>;
  // Récupère les avis récents (vide en manuel : ils sont saisis dans l'app).
  fetchReviews(companyId: string, since?: Date): Promise<ExternalReview[]>;
  // Publie une réponse côté source. En manuel : rien à faire, le
  // restaurateur colle la réponse sur Google et coche « publiée ».
  publishReply(companyId: string, externalId: string, text: string): Promise<{ published: boolean }>;
}

export class ManualSource implements ReviewSource {
  readonly kind = 'manual' as const;
  async isConnected() { return true; }
  async fetchReviews() { return []; }
  async publishReply() { return { published: false }; }
}

// Squelette V2 — ne fait aucun appel réseau aujourd'hui.
// À implémenter : OAuth 2.0 (scope business.manage), accounts/locations,
// GET locations/{id}/reviews, PUT reviews/{id}/reply. Jetons stockés
// chiffrés par restaurant ; purge et révocation prévues côté profil.
export class GoogleSource implements ReviewSource {
  readonly kind = 'google' as const;
  async isConnected() { return false; }
  async fetchReviews(): Promise<ExternalReview[]> {
    throw new Error('Connexion Google Business Profile non disponible dans cette version.');
  }
  async publishReply(): Promise<{ published: boolean }> {
    throw new Error('Publication automatique non disponible dans cette version.');
  }
}

const SOURCES: Record<ReviewSourceKind, ReviewSource> = { manual: new ManualSource(), google: new GoogleSource() };
export const reviewSource = (kind: ReviewSourceKind): ReviewSource => SOURCES[kind];
export const availableSources = (): ReviewSourceKind[] => ['manual'];
