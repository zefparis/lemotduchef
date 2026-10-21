import type { PromptProfile, PromptReview } from './prompt.js';

// Cas d'avis réels typiques, partagés entre les tests de règles
// (test/rules.test.ts, LLM mocké) et le script de relecture manuelle
// (npm run llm:sample, vrai modèle).

export const SAMPLE_PROFILE: PromptProfile = {
  name: 'La Table d’Aurore', city: 'Lyon', cuisine: 'bistronomie',
  signature_name: 'Marc', signature_role: 'chef et propriétaire', tone: 'chaleureux',
  strengths: ['fait maison', 'produits locaux', 'terrasse ombragée'],
  practical_info: 'Réservation conseillée le week-end',
  contact_email: 'contact@tabledaurore.fr', contact_phone: '04 78 00 00 00',
  show_phone: false,
};

export interface SampleCase {
  key: string;
  label: string;
  profile: PromptProfile;
  review: PromptReview;
}

export const SAMPLE_CASES: SampleCase[] = [
  {
    key: 'attente',
    label: 'Attente longue',
    profile: SAMPLE_PROFILE,
    review: {
      author_name: 'Karim', rating: 2,
      body: 'Attente interminable : 45 minutes avant même de pouvoir commander.',
      visited_on: null, context_tags: ['full_house'], context_note: '',
    },
  },
  {
    key: 'commande',
    label: 'Attente avant commande (service)',
    profile: SAMPLE_PROFILE,
    review: {
      author_name: 'Nadia', rating: 2,
      body: '45 minutes avant de commander, sans un regard du personnel.',
      visited_on: null, context_tags: [], context_note: '',
    },
  },
  {
    key: 'serveur',
    label: 'Serveur désagréable',
    profile: SAMPLE_PROFILE,
    review: {
      author_name: 'Thomas', rating: 2,
      body: 'Serveur désagréable du début à la fin du repas.',
      visited_on: null, context_tags: [], context_note: '',
    },
  },
  {
    key: 'toilettes',
    label: 'Toilettes sales (propreté)',
    profile: SAMPLE_PROFILE,
    review: {
      author_name: 'Manon', rating: 2,
      body: 'Toilettes sales, vraiment pas à la hauteur.',
      visited_on: null, context_tags: [], context_note: '',
    },
  },
  {
    key: 'prix',
    label: 'Prix jugé trop élevé',
    profile: SAMPLE_PROFILE,
    review: {
      author_name: 'Claire', rating: 2,
      body: 'Beaucoup trop cher pour ce qui est servi, on n’y retournera pas.',
      visited_on: null, context_tags: ['prices_displayed'], context_note: '',
    },
  },
  {
    key: 'plat-froid',
    label: 'Plat servi froid',
    profile: SAMPLE_PROFILE,
    review: {
      author_name: 'Paul', rating: 2,
      body: 'Plat froid.',
      visited_on: null, context_tags: [], context_note: '',
    },
  },
  {
    key: 'inconnu',
    label: 'Client jamais venu (avis agressif)',
    profile: SAMPLE_PROFILE,
    review: {
      author_name: 'Anonyme', rating: 1,
      body: 'Ignoble et trop long.',
      visited_on: null, context_tags: ['unknown_customer'], context_note: 'Aucune trace de cette personne dans nos réservations.',
    },
  },
  {
    key: 'sans-texte',
    label: '1 étoile sans texte',
    profile: SAMPLE_PROFILE,
    review: {
      author_name: 'R.', rating: 1,
      body: '',
      visited_on: null, context_tags: [], context_note: '',
    },
  },
  {
    key: 'positif',
    label: 'Avis positif détaillé',
    profile: SAMPLE_PROFILE,
    review: {
      author_name: 'Julie', rating: 5,
      body: 'Cadre magnifique en terrasse, service aux petits soins du début à la fin et une cuisine d’une finesse rare. Le meilleur moment de notre week-end à Lyon, merci à toute l’équipe.',
      visited_on: null, context_tags: [], context_note: '',
    },
  },
];
