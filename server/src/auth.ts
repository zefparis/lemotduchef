import { betterAuth } from 'better-auth';
import { createAuthMiddleware, APIError } from 'better-auth/api';
import { pool } from './db.js';
import { config } from './config.js';
import { sendMail, EMAIL_TEMPLATES } from './mailer.js';
import { CGV_VERSION, recordCgvAcceptance, isPublicAuthCall } from './legal.js';

// Anti-bombardement par e-mail : les envois transactionnels (réinitialisation,
// vérification) sont plafonnés par ADRESSE, en plus du rate-limit par IP de
// Better Auth — sinon une rotation d'IP peut inonder une boîte cible.
const MAIL_LIMIT_PATHS = new Set(['/request-password-reset', '/forget-password', '/send-verification-email']);
const MAIL_LIMIT_MAX = 3;
const MAIL_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const mailBuckets = new Map<string, number[]>();
function emailThrottle(key: string): boolean {
  const now = Date.now();
  if (mailBuckets.size > 5000) {
    for (const [k, hits] of mailBuckets) if (!hits.some(t => now - t < MAIL_LIMIT_WINDOW_MS)) mailBuckets.delete(k);
  }
  const hits = (mailBuckets.get(key) ?? []).filter(t => now - t < MAIL_LIMIT_WINDOW_MS);
  if (hits.length >= MAIL_LIMIT_MAX) { mailBuckets.set(key, hits); return false; }
  hits.push(now); mailBuckets.set(key, hits); return true;
}

// Authentification gérée par Better Auth (sessions serveur révocables,
// hachage des mots de passe, cookies HttpOnly). Aucune crypto maison.
export const auth = betterAuth({
  database: pool,
  secret: config.authSecret,
  baseURL: `${config.baseUrl}/api/auth`,
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 12,
    maxPasswordLength: 128,
    autoSignIn: true,
    // Connexion bloquée tant que l'email n'est pas vérifié.
    requireEmailVerification: true,
    sendResetPassword: async ({ user, token }: { user: { email: string }; token: string }) => {
      // Le lien pointe vers le FRONT (SPA), qui poste ensuite le nouveau mot de passe.
      const url = `${config.frontUrl}/reinitialiser?token=${encodeURIComponent(token)}`;
      await sendMail({ to: user.email, subject: 'Le Mot du Chef — réinitialisation du mot de passe', ...EMAIL_TEMPLATES.resetPassword(url) });
    },
    resetPasswordTokenExpiresIn: 60 * 60, // 1 h, usage unique géré par Better Auth
  },
  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    expiresIn: 60 * 60 * 24, // lien de vérification valable 24 h
    sendVerificationEmail: async ({ user, url }: { user: { email: string }; url: string }) => {
      // url pointe sur l'API (vérification serveur) ; la redirection finale
      // renvoie vers le front après succès.
      const u = new URL(url);
      u.searchParams.set('callbackURL', config.frontUrl + '/?verifie=1');
      await sendMail({ to: user.email, subject: 'Le Mot du Chef — confirmez votre email', ...EMAIL_TEMPLATES.verify(u.toString()) });
    },
  },
  user: {
    changeEmail: {
      enabled: true,
      sendChangeEmailVerification: async ({ newEmail, url }: { newEmail: string; url: string }) => {
        const u = new URL(url);
        u.searchParams.set('callbackURL', config.frontUrl + '/?verifie=1');
        await sendMail({ to: newEmail, subject: 'Le Mot du Chef — confirmez votre nouvelle adresse', ...EMAIL_TEMPLATES.changeEmail(u.toString()) });
      },
    },
    deleteUser: {
      enabled: true,
      // Avant de supprimer l'utilisateur : supprimer les restaurants dont il
      // est le seul membre (avis, variantes, profil partent en CASCADE).
      beforeDelete: async (user: { id: string }) => {
        await pool.query(
          `DELETE FROM companies c
            WHERE EXISTS (SELECT 1 FROM memberships m WHERE m.company_id = c.id AND m.user_id = $1)
              AND NOT EXISTS (SELECT 1 FROM memberships m2 WHERE m2.company_id = c.id AND m2.user_id <> $1)`,
          [user.id],
        );
        // Jetons en attente (reset, confirmation de suppression) : les lignes
        // `verification` stockent l'id utilisateur dans `value` — aucune ne
        // doit survivre au compte (les jetons d'e-mail sont des JWT, sans ligne).
        await pool.query(`DELETE FROM verification WHERE value=$1`, [user.id]);
      },
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 14,      // 14 jours
    updateAge: 60 * 60 * 24,           // glissement quotidien
  },
  advanced: {
    useSecureCookies: config.cookieSecure || config.cookieSameSite === 'none',
    cookiePrefix: 'lmc',
    // Lax en prod (même site, sous-domaines), None seulement via COOKIE_SAMESITE.
    // Aucun Domain sans COOKIE_DOMAIN : cookie host-only sur l'API.
    defaultCookieAttributes: {
      sameSite: config.cookieSameSite,
      secure: config.cookieSecure || config.cookieSameSite === 'none',
      httpOnly: true,
      ...(config.cookieDomain ? { domain: config.cookieDomain } : {}),
    },
    // IP réelle du client : cf-connecting-ip (posé par Cloudflare, non
    // falsifiable via le tunnel) en priorité — jamais l'entrée contrôlée par
    // le client de X-Forwarded-For (rate-limit et session.ipAddress).
    ipAddress: { ipAddressHeaders: ['cf-connecting-ip', 'x-forwarded-for'] },
    // Inscription publique bloquée aussi côté route (voir routes/auth.ts).
    disableCSRFCheck: false,
    database: {
      // Le schéma est garanti par server/migrations (jouées au démarrage) :
      // le contrôle runtime de Better Auth s'exécute avant migrate() et
      // met en cache un faux « schéma manquant » sur base fraîche.
      validateSchema: false,
    },
  },
  trustedOrigins: [config.baseUrl, ...config.corsOrigins],
  // Un compte suspendu ne peut plus se connecter ; l'inscription publique
  // exige l'acceptation de la version courante des CGV.
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path === '/sign-up/email') {
        // Voie publique uniquement (en-tête CSRF) : les créations internes
        // (invitation admin) n'ont pas d'acceptation interactive — le client
        // acceptera les CGV à sa première connexion.
        if (!isPublicAuthCall(ctx.request?.headers)) return;
        if (ctx.body?.cgvAccepted !== true || ctx.body?.cgvVersion !== CGV_VERSION)
          throw new APIError('BAD_REQUEST', {
            message: 'Vous devez accepter les conditions générales de vente pour créer un compte.',
            code: 'CGV_REQUIRED',
          });
        return;
      }
      // Plafond par e-mail sur les envois transactionnels (reset, vérification).
      if (MAIL_LIMIT_PATHS.has(ctx.path)) {
        const email = String(ctx.body?.email ?? '').toLowerCase();
        if (email && !emailThrottle(`${ctx.path}|${email}`))
          throw new APIError('TOO_MANY_REQUESTS', { message: 'Trop de demandes sur cette adresse. Réessayez dans une heure.' });
      }
    }),
    after: createAuthMiddleware(async (ctx) => {
      // Suspension vérifiée APRÈS le mot de passe : répondre avant la
      // vérification révélerait l'existence du compte à quiconque tente un mot
      // de passe quelconque. La session créée est supprimée immédiatement.
      if (ctx.path === '/sign-in/email') {
        const user = (ctx.context as any)?.returned?.user;
        if (user?.id) {
          const { rows } = await pool.query<{ suspended_at: string | null }>(
            'SELECT suspended_at FROM "user" WHERE id=$1', [user.id]);
          if (rows[0]?.suspended_at) {
            await pool.query('DELETE FROM session WHERE "userId"=$1', [user.id]);
            throw new APIError('FORBIDDEN', { message: 'Compte suspendu. Contactez le support.' });
          }
        }
        return;
      }
      // Enregistre l'acceptation des CGV de la voie publique (version + IP).
      if (ctx.path !== '/sign-up/email' || !isPublicAuthCall(ctx.request?.headers)) return;
      const user = (ctx.context as any)?.returned?.user;
      if (!user?.id) return;
      const ip = ctx.request?.headers.get('cf-connecting-ip')
        ?? ctx.request?.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '';
      await recordCgvAcceptance(user.id, ip).catch(() => {});
    }),
  },
  logger: { level: 'warn' },
});

export type Session = Awaited<ReturnType<typeof auth.api.getSession>>;
