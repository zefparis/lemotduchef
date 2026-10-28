import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { migrate } from '../src/db.js';
import { pool } from '../src/db.js';
import { simpleParser } from 'mailparser';

const log = { info: () => {}, warn: () => {} };

// Email « nouvel avis » Google TRANSFÉRÉ automatiquement : To: garde
// l'adresse du restaurateur, le code vit dans Delivered-To / Received-for.
const RAW_FWD = `Delivered-To: avis+abcd1234@lemotduchef.fr
Received: from gmail.example by mx.ovh.net; Fri, 10 Oct 2026 09:12:00 +0200
Received: for <avis+abcd1234@lemotduchef.fr>; Fri, 10 Oct 2026 09:12:01 +0200
Authentication-Results: mx.ovh.net; spf=pass smtp.mailfrom=google.com; dkim=pass header.d=google.com
From: Google Business <notifications@google.com>
To: "Mon Resto" <contact@monresto.fr>
Subject: Vous avez un nouvel avis
Message-ID: <fwd1@google.com>
Content-Type: text/plain; charset=utf-8

Avis de Julie — 4 étoiles : « Très bon accueil, service un peu lent ce soir mais cuisine au top. »
Consultez l'avis : https://www.google.com/local/review/abcXYZ123
`;

const RAW_NO_CODE = `From: Google Business <notifications@google.com>
To: contact@monresto.fr
Authentication-Results: mx.ovh.net; spf=pass smtp.mailfrom=google.com
Subject: test
Message-ID: <nocode@x>

contenu`;

const RAW_NOT_GOOGLE = `Delivered-To: avis+abcd1234@lemotduchef.fr
From: pirate@evil.example
Authentication-Results: mx.ovh.net; spf=fail smtp.mailfrom=evil.example
Subject: faux avis
Message-ID: <fake@x>

Avis de Fake — 1 étoile : « n'importe quoi injecté »`;

let companyId = '';
const silentLog = log;
let ingestRawEmail: typeof import('../src/ingest/mail.js').ingestRawEmail;
let extractIngestCode: typeof import('../src/ingest/mail.js').extractIngestCode;
let senderIsGoogle: typeof import('../src/ingest/mail.js').senderIsGoogle;
let parseGoogleReview: typeof import('../src/ingest/mail.js').parseGoogleReview;

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate();
  ({ ingestRawEmail, extractIngestCode, senderIsGoogle, parseGoogleReview } = await import('../src/ingest/mail.js'));
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO companies (name, ingest_code) VALUES ('Test Ingest','abcd1234') RETURNING id`);
  companyId = rows[0].id;
});
after(async () => { await pool.end(); });

test('extractIngestCode : en-têtes de livraison avant To:', async () => {
  const m = await simpleParser(RAW_FWD);
  assert.equal(extractIngestCode(m.headers, 'avis@lemotduchef.fr'), 'abcd1234');
  const m2 = await simpleParser(RAW_NO_CODE);
  assert.equal(extractIngestCode(m2.headers, 'avis@lemotduchef.fr'), null);
});

test('senderIsGoogle : rejet sans Google ou sans SPF/DKIM', async () => {
  const ok = await simpleParser(RAW_FWD);
  assert.equal((await senderIsGoogle(ok)).ok, true);
  const bad = await simpleParser(RAW_NOT_GOOGLE);
  assert.equal((await senderIsGoogle(bad)).ok, false);
  // Sans Authentication-Results et sans signature DKIM valable → rejet.
  const noar = await simpleParser('From: notifications@google.com\r\nSubject: t\r\n\r\nbody');
  assert.equal((await senderIsGoogle(noar, 'From: notifications@google.com\r\nSubject: t\r\n\r\nbody')).ok, false);
});

const RAW_CONFIRM = `Delivered-To: avis+abcd1234@lemotduchef.fr
From: Gmail Forwarding <forwarding-noreply@google.com>
Subject: Confirmation de transfert Gmail
Message-ID: <fwdconf@google.com>
Content-Type: text/plain; charset=utf-8

Veuillez cliquer sur le lien ci-dessous pour valider le transfert :
https://mail.google.com/mail/fwd-confirm-xyz123?hl=fr
Code de confirmation : 123-456-789
`;

test('ingestRawEmail : confirmation Gmail enregistrée, lien jamais visité', async () => {
  const r = await ingestRawEmail(RAW_CONFIRM, silentLog);
  assert.equal(r.status, 'ok');
  assert.equal(r.detail, 'forwarding-confirmation');
  const { rows } = await pool.query('SELECT code, link FROM ingest_confirmations WHERE company_id=$1', [companyId]);
  assert.equal(rows.length, 1);
  assert.match(rows[0].link, /fwd-confirm/);
  assert.match(rows[0].code, /123/);
});

test('ingestRawEmail : avis transféré → review source email + dédoublonnage', async () => {
  const r1 = await ingestRawEmail(RAW_FWD, silentLog);
  assert.equal(r1.status, 'ok', r1.detail);
  const { rows } = await pool.query(
    'SELECT source, external_id, author_name, rating, body FROM reviews WHERE id=$1', [r1.reviewId]);
  assert.equal(rows[0].source, 'email');
  assert.equal(rows[0].author_name, 'Julie');
  assert.equal(rows[0].rating, 4);
  assert.match(rows[0].body, /Très bon accueil/);
  assert.equal(rows[0].external_id, 'https://www.google.com/local/review/abcXYZ123');
  const r2 = await ingestRawEmail(RAW_FWD, silentLog);
  assert.equal(r2.status, 'duplicate');
});

test('ingestRawEmail : faux avis rejeté (expéditeur)', async () => {
  const r = await ingestRawEmail(RAW_NOT_GOOGLE, silentLog);
  assert.equal(r.status, 'skipped');
});
