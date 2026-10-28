import Fastify from 'fastify';
import pino from 'pino';
import type { FastifyError } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import cors from '@fastify/cors';
import { config } from './config.js';
import { auth } from './auth.js';
import { nodeHeaders, clientIp, CLIENT_HEADER } from './guards.js';
import { smtpConfigured, mailDriver } from './mailer.js';
import profileRoutes from './routes/profile.js';
import adminRoutes from './routes/admin.js';
import { signupEnabledNow } from './settings.js';
import miscRoutes from './routes/misc.js';
import billingRoutes from './routes/billing.js';
import legalRoutes from './routes/legal.js';
import reviewRoutes from './routes/reviews.js';
import collectRoutes from './routes/collect.js';
import { llmConfigured } from './llm/provider.js';
import { scheduleRetention } from './retention.js';

export async function buildApp(opts: { retention?: boolean; logStream?: NodeJS.WritableStream } = {}) {
  // Journalisation sans secrets : cookies, en-têtes d'auth et set-cookie
  // masqués ; URL journalisée SANS la query string — les liens
  // d'authentification (vérification, réinitialisation) portent des jetons.
  const logConfig = {
    level: process.env.LOG_LEVEL ?? 'info',
    serializers: {
      req: (req: any) => ({
        method: req.method,
        url: String(req.url ?? '').split('?')[0],
        hostname: req.hostname,
        remoteAddress: clientIp(req),
        remotePort: req.socket?.remotePort,
      }),
    },
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
      censor: '[redacted]',
    },
  };
  const app = Fastify({
    ...(opts.logStream
      ? { loggerInstance: pino(logConfig, opts.logStream as any) }
      : { logger: logConfig }),
    trustProxy: config.trustProxy,
  });
  (app as any).signupEnabled = config.signupEnabled;

  // Rate-limit clé = IP cliente fiable (cf-connecting-ip via le tunnel, sinon
  // socket) — X-Forwarded-For client n'est jamais une clé de confiance.
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute', keyGenerator: clientIp });

  // En-têtes de sécurité sur toutes les réponses. CSP stricte sur /api
  // (JSON), complète quand le front est servi par cette origine.
  const CSP_API = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";
  // Le sha256 autorise le script inline « data-theme » du <head> (anti-flash
  // de thème) ; build.mjs vérifie qu'il correspond au contenu d'index.html.
  const CSP_FRONT = [
    "default-src 'self'", "script-src 'self' 'sha256-INvJATyzdDWfk2hI44VBZvfLcUkppxFRtDscxJ/HZRk='", "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:", `connect-src 'self' ${config.baseUrl}`,
    "object-src 'none'", "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'",
  ].join('; ');
  app.addHook('onSend', async (req, reply) => {
    reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('X-Frame-Options', 'DENY')
      .header('Referrer-Policy', 'strict-origin-when-cross-origin')
      .header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains')
      .header('Content-Security-Policy',
        req.url.startsWith('/api/') || req.url === '/health' ? CSP_API : CSP_FRONT);
  });

  // CORS : origines frontend autorisées (CORS_ORIGINS). Cookies inclus
  // (sessions cross-site). Aucune origine configurée = même origine seule.
  if (config.corsOrigins.length) {
    await app.register(cors, {
      origin: (origin, cb) => cb(null, !origin || config.corsOrigins.includes(origin)),
      credentials: true,
    });
  }

  // Gestionnaire d'erreurs : jamais de propagation des en-têtes ni du statut
  // d'un service externe (Stripe pose headers dont access-control-allow-origin:*
  // sur ses erreurs → fausse erreur CORS côté navigateur). CORS reste géré
  // par @fastify/cors ; le détail reste dans les logs serveur.
  app.setErrorHandler((err: FastifyError, req, reply) => {
    if ((err as any).headers) {
      req.log.warn({ err }, 'erreur d\'un service externe (statut et en-têtes non propagés)');
      return reply.code(502).send({ error: 'Un service externe est momentanément indisponible.' });
    }
    const status = typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500
      ? err.statusCode : 500;
    if (status === 500) req.log.error({ err }, 'erreur non gérée');
    return reply.code(status).send({ error: status === 500 ? 'Erreur interne.' : err.message });
  });

  // CSRF : toute mutation /api exige l'en-tête applicatif, et l'Origin,
  // quand elle est présente, doit correspondre à l'hôte servi.
  app.addHook('onRequest', async (req, reply) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
    if (!req.url.startsWith('/api/')) return;
    // Le webhook Stripe vient de serveurs tiers : pas d'en-tête applicatif
    // ni d'Origin — l'authentification est la signature du payload.
    if (req.url.startsWith('/api/stripe/webhook')) return;
    const origin = req.headers.origin;
    if (origin) {
      const allowed = config.corsOrigins.includes(origin)
        || (() => { try { return new URL(origin).host === req.headers.host; } catch { return false; } })();
      if (!allowed) return reply.code(403).send({ error: 'Origine refusée.' });
    }
    if (req.headers[CLIENT_HEADER] !== '1')
      return reply.code(403).send({ error: 'Requête bloquée (protection CSRF).' });
  });

  // Better Auth sur /api/auth/* — débit resserré contre le force brute.
  app.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    config: { rateLimit: { max: config.rateLimitAuth, timeWindow: '1 minute', keyGenerator: clientIp } },
    handler: async (req, reply) => {
      const pathname = new URL(req.raw.url ?? '/', 'http://x').pathname;
      if (pathname === '/api/auth/sign-up/email') {
        // L'interrupteur en base (back-office) est prioritaire sur l'env.
        if (!(await signupEnabledNow()))
          return reply.code(403).send({ error: 'Les inscriptions sont fermées pour le moment.' });
        // La vérification d'email est obligatoire : sans SMTP, l'inscription
        // créerait un compte inutilisable → on la refuse explicitement.
        if (!smtpConfigured())
          return reply.code(503).send({ error: 'Inscription indisponible : envoi d’emails non configuré (SMTP).' });
      }
      const url = new URL(req.raw.url ?? '/', `${req.protocol}://${req.headers.host}`);
      const headers = nodeHeaders(req);
      const init: RequestInit & { duplex?: 'half' } = { method: req.method, headers };
      // Le flux brut est déjà consommé par le parseur Fastify : on re-sérialise le JSON.
      if (!['GET', 'HEAD'].includes(req.method)) {
        init.body = JSON.stringify(req.body ?? {});
        headers.set('content-type', 'application/json');
      }
      const res = await auth.handler(new Request(url, init as RequestInit));
      reply.status(res.status);
      // Ni set-cookie (posé à part) ni access-control-* : CORS est fixé
      // par @fastify/cors, jamais par une réponse amont recopiée.
      res.headers.forEach((v, k) => {
        const n = k.toLowerCase();
        if (n !== 'set-cookie' && !n.startsWith('access-control-')) reply.header(k, v);
      });
      const cookies = res.headers.getSetCookie?.() ?? [];
      if (cookies.length) reply.header('set-cookie', cookies);
      reply.send(res.body ? Buffer.from(await res.arrayBuffer()) : undefined);
    },
  });

  if (!smtpConfigured())
    app.log.warn('SMTP non configuré (SMTP_HOST) : aucun email transactionnel ne pourra être envoyé. L\'inscription publique sera refusée tant que SMTP n\'est pas défini.');
  else if (mailDriver() === 'log')
    app.log.warn('SMTP_HOST=log : les emails sont journalisés, aucun envoi réel (mode test).');
  if (!llmConfigured())
    app.log.warn(`LLM non configuré (LLM_PROVIDER=${config.llm.provider}${config.llm.provider === 'anthropic' ? ', ANTHROPIC_API_KEY absente' : ' interdit en production'}) : la génération de réponses répondra 503.`);
  else if (config.llm.provider === 'mock')
    app.log.warn('LLM_PROVIDER=mock : réponses générées localement, sans appel réseau (dev/test uniquement).');

  await app.register(miscRoutes);
  await app.register(profileRoutes);
  await app.register(reviewRoutes);
  await app.register(collectRoutes);
  await app.register(adminRoutes);
  await app.register(billingRoutes);
  await app.register(legalRoutes);

  // Purge RGPD planifiée (désactivable pour les tests).
  if (opts.retention !== false) {
    const stop = scheduleRetention(app.log);
    app.addHook('onClose', async () => stop());
  }

  // Frontend statique : servi par l'API uniquement en auto-hébergement
  // (front et API sur la même origine). En production le front est sur Vercel
  // (FRONT_URL ≠ BASE_URL) : toute page hors /api redirige vers le site public
  // au lieu de servir une copie potentiellement obsolète.
  const frontSameOrigin = (() => {
    try { return new URL(config.frontUrl).origin === new URL(config.baseUrl).origin; }
    catch { return true; }
  })();
  if (frontSameOrigin) await app.register(fastifyStatic, { root: config.staticRoot });
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api/')) {
      if (frontSameOrigin) return reply.sendFile('index.html');
      return reply.code(302).redirect(`${config.frontUrl}${req.raw.url ?? '/'}`);
    }
    reply.code(404).send({ error: 'Introuvable.' });
  });

  return app;
}
