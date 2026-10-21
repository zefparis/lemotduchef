'use strict';

/* ============================================================
   Le Mot du Chef — frontend
   Toutes les données passent par l'API (session cookie HttpOnly).
   Sans session valide : seules la page commerciale, les écrans
   d'authentification et les pages légales sont accessibles.
   ============================================================ */

// URL de base de l'API : injectée par config.js (déploiement front séparé).
// Chaîne vide = même origine (auto-hébergement, dev local).
const API_BASE = (window.LMC_API_URL || '').replace(/\/+$/, '');

const $  = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = s => s ? new Date(String(s).slice(0, 10) + 'T12:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
const fmtDateTime = s => new Date(s).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const icon = (id, cls = 'icon') => `<svg class="${cls}" aria-hidden="true"><use href="#${id}"/></svg>`;
const stars = n => `<span class="stars" aria-label="${n} sur 5">${[1, 2, 3, 4, 5].map(i => `<span${i <= n ? ' class="on"' : ''}>★</span>`).join('')}</span>`;
const words = s => (String(s).trim().match(/[\p{L}\p{N}’'-]+/gu) || []).length;

/* ---------- État global ---------- */
let mode = 'landing';            // 'landing' | 'live'
let session = null;              // { user, restaurant, admin, cgv_current }
let appConfig = {};              // /api/config
let signupEnabled = false;
let cgvVersion = '';
let profile = null;              // /api/restaurant
let usage = null;                // /api/usage
let currentReview = null;        // avis en cours dans l'écran Répondre { id, flags, report, variants }

/* ---------- Toast ---------- */
let toastTimer;
function toast(text, type = 'success') {
  const t = $('#toast');
  const ic = { success: 'i-check', error: 'i-alert', info: 'i-info' }[type] || 'i-info';
  t.innerHTML = icon(ic) + esc(text);
  t.className = `show t-${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 4500);
}
function busy(el) {
  el.disabled = true; el.classList.add('is-busy');
  return () => { el.disabled = false; el.classList.remove('is-busy'); };
}
function setErr(el, msg) { el.hidden = !msg; el.textContent = msg || ''; }

/* ---------- Dialogue de confirmation ---------- */
let confirmResolve = null;
const confirmDlg = $('#confirm');
function askConfirm(title, text, okLabel = 'Confirmer') {
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  $('#confirm-ok').textContent = okLabel;
  confirmDlg.showModal();
  return new Promise(res => { confirmResolve = res; });
}
$('#confirm-ok').onclick = () => { confirmDlg.close(); confirmResolve?.(true); confirmResolve = null; };
$('#confirm-cancel').onclick = () => { confirmDlg.close(); confirmResolve?.(false); confirmResolve = null; };
confirmDlg.addEventListener('close', () => { confirmResolve?.(false); confirmResolve = null; });
$$('dialog').forEach(d => d.addEventListener('click', e => {
  if (e.target !== d) return;
  const r = d.getBoundingClientRect();
  if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close();
}));

/* ---------- Couche API ---------- */
async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch(API_BASE + '/api' + path, {
    method, credentials: 'include',
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), 'x-lemotduchef-client': '1' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await r.json(); } catch { /* réponse vide */ }
  if (!r.ok) {
    const err = Object.assign(new Error(data?.error || 'Erreur serveur.'), { status: r.status, code: data?.code });
    if (r.status === 401 && mode === 'live') { session = null; mode = 'landing'; showAuth('login', 'Votre session a expiré. Reconnectez-vous.'); }
    throw err;
  }
  return data;
}
async function apiBlob(path) {
  const r = await fetch(API_BASE + '/api' + path, { credentials: 'include', headers: { 'x-lemotduchef-client': '1' } });
  if (!r.ok) {
    let data = null; try { data = await r.json(); } catch { /* vide */ }
    throw Object.assign(new Error(data?.error || 'Téléchargement impossible.'), { status: r.status, code: data?.code });
  }
  return r.blob();
}
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------- Navigation entre vues ---------- */
function show(view) {
  $('.site-header').hidden = view !== 'landing';
  $('#landing').hidden = view !== 'landing';
  $('#auth').hidden = view !== 'auth';
  $('#onboard').hidden = view !== 'onboard';
  $('#app').hidden = view !== 'app';
  $('#admin').hidden = view !== 'admin';
  $('#legal').hidden = view !== 'legal';
  window.scrollTo(0, 0);
}
async function refresh() {
  [profile, usage] = await Promise.all([api('/restaurant'), api('/usage')]);
}
async function enterLive() {
  try { await refresh(); } catch (e) { return toast(e.message, 'error'); }
  show('app');
  render();
}
$$('[data-open]').forEach(b => b.onclick = () => mode === 'live' ? enterLive() : showAuth('signup'));
$$('[data-auth]').forEach(b => b.onclick = () => mode === 'live' ? enterLive() : showAuth('login'));
$$('[data-landing]').forEach(b => b.onclick = () => show('landing'));
$('#auth-home').onclick = e => { e.preventDefault(); show('landing'); };
$('#brand-home').onclick = e => { e.preventDefault(); show('landing'); };

async function logout() {
  try { await api('/auth/sign-out', { method: 'POST', body: {} }); } catch { /* déjà close */ }
  session = null; mode = 'landing'; profile = null; usage = null; currentReview = null;
  show('landing');
  toast('Vous êtes déconnecté.', 'info');
}
$('#logout').onclick = logout;
$('#menu-logout').onclick = () => { hideMenu(); logout(); };
$('#menu-admin').onclick = () => { hideMenu(); enterAdmin(); };
$('#admin-back').onclick = () => { history.replaceState(null, '', '/'); enterLive(); };

const menuPop = $('#user-menu');
function hideMenu() { menuPop.hidden = true; $('#top-avatar').setAttribute('aria-expanded', 'false'); }
$('#top-avatar').onclick = e => { e.stopPropagation(); menuPop.hidden = !menuPop.hidden; $('#top-avatar').setAttribute('aria-expanded', String(!menuPop.hidden)); };
document.addEventListener('click', e => { if (!e.target.closest('.user-menu')) hideMenu(); });

const tabNames = { reply: 'Répondre à un avis', history: 'Historique', collect: "Collecte d'avis", restaurant: 'Mon restaurant', account: 'Compte' };
function tab(id) {
  $$('.tab').forEach(el => { el.hidden = el.id !== id; });
  $$('.nav-item[data-tab], .mobile-item[data-tab], .user-menu-item[data-tab]').forEach(el => el.classList.toggle('active', el.dataset.tab === id));
  $('#breadcrumb').textContent = tabNames[id];
  if (id === 'account') loadAccount();
  if (id === 'restaurant') { loadBilling(); fillProfileForm($('#restaurant-form'), profile); }
  if (id === 'history') loadHistory();
  if (id === 'collect') loadCollect();
  window.scrollTo(0, 0);
}

/* ---------- Pages légales (publiques) ---------- */
const LEGAL_PATHS = { '/mentions-legales': 'legal-mentions', '/cgv': 'legal-cgv', '/confidentialite': 'legal-privacy' };
function showLegal(path) {
  const article = LEGAL_PATHS[path];
  if (!article) return false;
  show('legal');
  for (const id of Object.values(LEGAL_PATHS)) $('#' + id).hidden = id !== article;
  $$('.legal-nav a').forEach(a => a.classList.toggle('active', a.getAttribute('href') === path));
  if (location.pathname !== path) history.pushState(null, '', path);
  document.title = 'Le Mot du Chef — ' + ({ '/mentions-legales': 'Mentions légales', '/cgv': 'CGV', '/confidentialite': 'Confidentialité' })[path];
  return true;
}
function fillLegal() {
  const L = window.LMC_LEGAL || {};
  $$('[data-legal]').forEach(el => { el.textContent = L[el.dataset.legal] || '—'; });
  $$('[data-legal-email]').forEach(el => { el.href = `mailto:${L.email || ''}`; });
  $$('[data-legal-version]').forEach(el => { el.textContent = cgvVersion || '—'; });
  $('#legal-warn').hidden = !(window.LMC_LEGAL_MISSING?.length);
}
function fillConfig() {
  $$('[data-free-replies]').forEach(el => { el.textContent = appConfig.freeMonthlyReplies ?? '—'; });
  $$('[data-free-history]').forEach(el => { el.textContent = appConfig.freeHistoryDays ?? '—'; });
  $$('[data-retention-months]').forEach(el => { el.textContent = appConfig.reviewRetentionMonths ?? '12'; });
}
$('[data-legal-back]').onclick = () => { location.href = '/'; };

/* ---------- Authentification ---------- */
const authForms = ['login-form', 'signup-form', 'forgot-form', 'reset-form', 'verify-note'];
function showAuthForm(id) { authForms.forEach(f => { $('#' + f).hidden = f !== id; }); }
function showAuth(which = 'login', msg) {
  show('auth');
  if (which === 'signup' && signupEnabled) $('#tab-signup').click();
  else if (which === 'reset') showAuthForm('reset-form');
  else if (which === 'verify') showAuthForm('verify-note');
  else $('#tab-login').click();
  if (msg) toast(msg, 'info');
}
$('#tab-login').onclick = () => { $('#tab-login').classList.add('active'); $('#tab-signup').classList.remove('active'); showAuthForm('login-form'); };
$('#tab-signup').onclick = () => { $('#tab-signup').classList.add('active'); $('#tab-login').classList.remove('active'); showAuthForm('signup-form'); };
$('#forgot-link').onclick = () => showAuthForm('forgot-form');
$('#forgot-back').onclick = () => showAuthForm('login-form');
$('#verify-back').onclick = () => showAuthForm('login-form');

async function afterAuth() {
  const me = await api('/me');
  session = me;
  if (!me?.restaurant) { startOnboarding(); return; }
  mode = 'live';
  await enterLive();
}

$('#login-form').onsubmit = async e => {
  e.preventDefault();
  const f = e.target, unbusy = busy($('#login-btn')), err = $('#err-login');
  err.hidden = true;
  const email = f.elements.email.value.trim();
  try {
    await api('/auth/sign-in/email', { method: 'POST', body: { email, password: f.elements.password.value } });
    f.reset();
    await afterAuth();
  } catch (err2) {
    err.hidden = false;
    if (err2.status === 403 || /vérifi|verif/i.test(err2.message || '')) {
      err.textContent = 'Email non confirmé. Cliquez sur le lien reçu par email, ou ';
      const a = document.createElement('button');
      a.className = 'btn btn-quiet btn-sm'; a.type = 'button'; a.textContent = 'renvoyez-le';
      a.onclick = async () => {
        try { await api('/auth/send-verification-email', { method: 'POST', body: { email, callbackURL: location.origin + '/?verifie=1' } }); toast('Email de confirmation renvoyé.', 'info'); }
        catch (e3) { toast(e3.message, 'error'); }
      };
      err.appendChild(a);
    } else err.textContent = err2.status === 401 ? 'Email ou mot de passe incorrect.' : (err2.message || 'Connexion impossible.');
  } finally { unbusy(); }
};

$('#signup-form').onsubmit = async e => {
  e.preventDefault();
  const f = e.target, unbusy = busy($('#signup-btn')), err = $('#err-signup');
  err.hidden = true;
  const payload = { name: f.elements.name.value.trim(), email: f.elements.email.value.trim(), password: f.elements.password.value, cgvAccepted: true, cgvVersion };
  const cgvErr = $('#err-cgv'); cgvErr.hidden = true;
  if (!$('#s-cgv').checked) { setErr(cgvErr, 'Acceptez les CGV pour créer votre compte.'); unbusy(); return; }
  if (payload.password.length < 12) { setErr(err, 'Mot de passe : 12 caractères minimum.'); unbusy(); return; }
  try {
    await api('/auth/sign-up/email', { method: 'POST', body: payload });
    sessionStorage.setItem('lmc-pending-restaurant', f.elements.company.value.trim());
    $('#verify-email-addr').textContent = payload.email;
    f.reset();
    showAuthForm('verify-note');
  } catch (err2) {
    setErr(err, err2.status === 422 ? 'Cet email est déjà utilisé.' : (err2.message || 'Inscription impossible.'));
  } finally { unbusy(); }
};

$('#forgot-form').onsubmit = async e => {
  e.preventDefault();
  const f = e.target, unbusy = busy($('#forgot-btn')), err = $('#err-forgot'), ok = $('#ok-forgot');
  err.hidden = ok.hidden = true;
  try {
    await api('/auth/request-password-reset', { method: 'POST', body: { email: f.elements.email.value.trim(), redirectTo: location.origin + '/reinitialiser' } });
    ok.hidden = false; ok.textContent = 'Si un compte correspond à cet email, un lien de réinitialisation vient de partir (valable 1 h).';
    f.reset();
  } catch (err2) { setErr(err, err2.message || 'Demande impossible.'); }
  finally { unbusy(); }
};

$('#reset-form').onsubmit = async e => {
  e.preventDefault();
  const f = e.target, unbusy = busy($('#reset-btn')), err = $('#err-reset');
  err.hidden = true;
  const p1 = f.elements.password.value, p2 = f.elements.password2.value;
  if (p1.length < 12) { setErr(err, 'Mot de passe : 12 caractères minimum.'); unbusy(); return; }
  if (p1 !== p2) { setErr(err, 'Les deux mots de passe ne correspondent pas.'); unbusy(); return; }
  const token = new URLSearchParams(location.search).get('token') || '';
  try {
    await api('/auth/reset-password', { method: 'POST', body: { newPassword: p1, token } });
    history.replaceState(null, '', '/');
    f.reset(); $('#tab-login').click();
    toast('Mot de passe mis à jour. Connectez-vous.', 'success');
  } catch { setErr(err, 'Lien expiré ou déjà utilisé. Redemandez un lien de réinitialisation.'); }
  finally { unbusy(); }
};

/* ---------- Profil du restaurant : gabarit partagé ---------- */
function mountProfileFields(container, prefix) {
  const html = $('#profile-template').innerHTML.replaceAll('{p}', prefix);
  container.innerHTML = html;
}
function readProfileForm(f) {
  const el = f.elements;
  const strengths = [...f.querySelectorAll('input[name=strengths]:checked')].map(i => i.value);
  for (const s of (el.strengths_custom.value || '').split(',').map(s => s.trim()).filter(Boolean)) if (!strengths.includes(s)) strengths.push(s);
  return {
    name: el.name.value.trim(), city: el.city.value.trim(), cuisine: el.cuisine.value.trim(),
    signature_name: el.signature_name.value.trim(), signature_role: el.signature_role.value.trim(),
    tone: el.tone.value, strengths: strengths.slice(0, 8), practical_info: el.practical_info.value.trim(),
    google_maps_url: el.google_maps_url.value.trim(), google_review_url: profile?.google_review_url || '',
    contact_email: el.contact_email.value.trim(), contact_phone: el.contact_phone.value.trim(),
    show_phone: !!(el.show_phone && el.show_phone.checked),
  };
}
function fillProfileForm(f, p) {
  if (!p || document.activeElement?.form === f) return;
  const el = f.elements;
  for (const k of ['name', 'city', 'cuisine', 'signature_name', 'signature_role', 'tone', 'practical_info', 'google_maps_url', 'contact_email', 'contact_phone'])
    if (el[k]) el[k].value = p[k] ?? '';
  if (el.show_phone) el.show_phone.checked = !!p.show_phone;
  const known = [...f.querySelectorAll('input[name=strengths]')];
  known.forEach(i => { i.checked = (p.strengths || []).includes(i.value); });
  el.strengths_custom.value = (p.strengths || []).filter(s => !known.some(i => i.value === s)).join(', ');
}
mountProfileFields($('#onboard-form'), 'ob');
mountProfileFields($('#restaurant-form [data-profile-fields]'), 'rs');

function startOnboarding() {
  const pending = sessionStorage.getItem('lmc-pending-restaurant');
  if (pending) $('#onboard-form').elements.name.value = pending;
  if (session?.user?.name) {
    const first = session.user.name.split(/\s+/)[0];
    const f = $('#onboard-form').elements;
    if (!f.signature_name.value) f.signature_name.value = first;
  }
  show('onboard');
}
$('#onboard-form').onsubmit = async e => {
  e.preventDefault();
  const f = e.target, unbusy = busy($('#onboard-btn')), err = $('#err-onboard');
  err.hidden = true;
  const p = readProfileForm(f);
  if (!p.name) { setErr(err, 'Indiquez le nom de votre restaurant.'); unbusy(); return; }
  try {
    const r = await api('/restaurants', { method: 'POST', body: p });
    session.restaurant = r;
    sessionStorage.removeItem('lmc-pending-restaurant');
    mode = 'live';
    await enterLive();
    toast('Votre espace est prêt. Collez votre premier avis !');
  } catch (err2) { setErr(err, err2.message); }
  finally { unbusy(); }
};

$('#restaurant-form').onsubmit = async e => {
  e.preventDefault();
  const f = e.target, unbusy = busy($('#restaurant-btn')), err = $('#err-restaurant');
  err.hidden = true;
  const p = readProfileForm(f);
  if (!p.name) { setErr(err, 'Indiquez le nom de votre restaurant.'); unbusy(); return; }
  try {
    await api('/restaurant', { method: 'PATCH', body: p });
    await refresh(); render();
    toast('Profil enregistré.');
  } catch (err2) { setErr(err, err2.message); }
  finally { unbusy(); }
};

/* ---------- Rendu général ---------- */
function initials(name) {
  return String(name || 'MC').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || 'MC';
}
function render() {
  $('#today').textContent = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }).toUpperCase();
  $('#ws-name').textContent = profile?.name || session?.restaurant?.name || '';
  $('#ws-plan').textContent = usage?.plan === 'pro' ? 'Offre Pro' : 'Offre Gratuit';
  $('#ws-avatar').textContent = initials(profile?.name);
  $('#top-avatar').textContent = initials(session?.user?.name || profile?.name);
  $('#user-menu-email').textContent = session?.user?.email || '';
  $('#menu-admin').hidden = !session?.admin;
  renderQuota();
  renderContextChips();
  if (session?.user && session.cgv_current === false) showCgvBanner();
}
function renderQuota() {
  const pill = $('#quota-pill');
  if (!usage) { pill.hidden = true; return; }
  pill.hidden = false;
  if (usage.plan === 'pro') { pill.textContent = 'Pro · réponses illimitées'; pill.className = 'quota-pill pro'; }
  else {
    pill.textContent = `${usage.remaining} / ${usage.limit} réponses restantes ce mois`;
    pill.className = 'quota-pill' + (usage.remaining === 0 ? ' empty' : '');
  }
  $('#generate-hint').textContent = !usage.llmReady ? 'Le rédacteur n’est pas configuré sur ce serveur.'
    : usage.plan === 'pro' ? '' : `${usage.remaining} génération(s) restante(s) ce mois-ci.`;
}

/* ---------- Écran Répondre ---------- */
const form = $('#review-form');
function renderContextChips() {
  const box = $('#context-chips');
  if (box.dataset.ready) return;
  const tags = appConfig.contextTags || {};
  box.innerHTML = Object.entries(tags).map(([k, label]) =>
    `<label class="chip"><input type="checkbox" name="context_tags" value="${esc(k)}"><span>${esc(label)}</span></label>`).join('');
  box.dataset.ready = '1';
}
function updateContextVisibility() {
  const rating = Number(form.elements.rating.value || 5);
  $('#star-label').textContent = `${rating} / 5`;
  $('#context-block').hidden = rating > 3;
  const other = form.querySelector('input[name=context_tags][value=other]');
  $('#rv-note').hidden = !(other?.checked);
}
form.addEventListener('change', e => { if (e.target.name === 'rating' || e.target.name === 'context_tags') updateContextVisibility(); });
updateContextVisibility();

function readReviewForm() {
  const el = form.elements;
  return {
    author_name: el.author_name.value.trim(), rating: Number(el.rating.value),
    body: el.body.value.trim(), visited_on: el.visited_on.value || null,
    context_tags: [...form.querySelectorAll('input[name=context_tags]:checked')].map(i => i.value),
    context_note: el.context_note.value.trim(),
  };
}
function resetReply() {
  form.reset();
  form.elements.id.value = '';
  $('#st5').checked = true;
  currentReview = null;
  $('#variants-block').hidden = true;
  $('#suspect-panel').hidden = true;
  $('#plan-limit-note').hidden = true;
  $('#reply-new').hidden = true;
  $('#published-note').hidden = true;
  $('#generate-btn').innerHTML = icon('i-sparkle') + 'Rédiger 3 réponses';
  updateContextVisibility();
}
$('#reply-new').onclick = resetReply;

form.onsubmit = async e => {
  e.preventDefault();
  const unbusy = busy($('#generate-btn')), err = $('#err-review');
  err.hidden = true; $('#plan-limit-note').hidden = true;
  const r = readReviewForm();
  if (!r.rating) { setErr(err, 'Choisissez la note de l’avis.'); unbusy(); return; }
  if (!profile?.signature_name && !profile?.name) { setErr(err, 'Complétez d’abord le profil de votre restaurant.'); unbusy(); return; }
  $('#generate-btn').innerHTML = icon('i-sparkle') + 'Rédaction en cours…';
  try {
    let id = form.elements.id.value;
    let created;
    if (id) created = await api(`/reviews/${id}`, { method: 'PATCH', body: r });
    else { created = await api('/reviews', { method: 'POST', body: r }); id = created.id; form.elements.id.value = id; }
    currentReview = { id, flags: created.flags, report: created.report, variants: [] };
    renderSuspicion(created.report);
    const g = await api(`/reviews/${id}/generate`, { method: 'POST', body: {} });
    currentReview.variants = g.variants;
    if (g.quota.remaining != null) usage = { ...usage, remaining: g.quota.remaining, limit: g.quota.limit };
    renderVariants(g);
    renderQuota();
    $('#reply-new').hidden = false;
    $('#generate-btn').innerHTML = icon('i-sparkle') + 'Rédiger à nouveau';
  } catch (err2) {
    $('#generate-btn').innerHTML = icon('i-sparkle') + 'Rédiger 3 réponses';
    if (err2.code === 'PLAN_LIMIT') { $('#plan-limit-text').textContent = err2.message; $('#plan-limit-note').hidden = false; }
    else setErr(err, err2.message || 'Génération impossible.');
    if (form.elements.id.value) $('#reply-new').hidden = false;
  } finally { unbusy(); }
};
$('#plan-limit-upgrade').onclick = () => tab('restaurant');
$('#regenerate').onclick = () => form.requestSubmit();

function renderSuspicion(report) {
  const panel = $('#suspect-panel');
  if (!report?.suspicious) { panel.hidden = true; return; }
  panel.hidden = false;
  $('#suspect-flags').innerHTML = report.flagLabels.map(l => `<li>${icon('i-alert')}${esc(l)}</li>`).join('');
  $('#report-notice').textContent = report.notice;
  $('#report-reason').textContent = report.reasonLabel || '—';
  $('#report-text').value = report.text || '';
  $('#report-help').href = report.helpUrl;
}
$('#report-copy').onclick = async () => {
  try { await navigator.clipboard.writeText($('#report-text').value); toast('Texte de signalement copié.'); }
  catch { $('#report-text').select(); toast('Sélectionnez puis copiez le texte.', 'info'); }
};

function renderVariants(g) {
  const block = $('#variants-block');
  block.hidden = false;
  const u = g.usage || {};
  const validCount = g.variants.filter(v => !v.needsReview).length;
  $('#variants-meta').textContent = `${validCount} proposition(s) · relisez et ajustez avant de publier` + (g.rejected?.length ? ` · ${g.rejected.length} écartée(s) par les règles` : '');
  const maps = profile?.google_maps_url;
  const og = $('#open-google');
  og.hidden = !maps; if (maps) og.href = maps;
  $('#variants').innerHTML = g.variants.map((v, i) => `
    <article class="variant" data-idx="${i}">
      <div class="variant-head">
        <strong>Proposition ${i + 1}</strong>
        <small><span data-words>${words(v.text)}</span> mots${v.needsReview ? ' · <span class="warn">à revoir — écartée par les règles, rédigez ou régénérez</span>' : v.warnings?.length ? ` · <span class="warn" title="${esc(v.warnings.join(' · '))}">à vérifier</span>` : ''}</small>
      </div>
      <textarea rows="8" data-variant${v.needsReview ? ' placeholder="Variante non conforme — écrivez votre réponse ou régénérez."' : ''}>${esc(v.text)}</textarea>
      <div class="variant-actions">
        <button class="btn btn-primary btn-sm" data-copy="${i}">${icon('i-copy')}Copier</button>
        <button class="btn btn-outline btn-sm" data-publish="${i}">${icon('i-check')}Marquer comme publiée</button>
      </div>
    </article>`).join('');
  block.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
$('#variants').addEventListener('input', e => {
  if (!e.target.matches('[data-variant]')) return;
  e.target.closest('.variant').querySelector('[data-words]').textContent = words(e.target.value);
});

async function copyVariant(i) {
  const text = $$('#variants [data-variant]')[i].value;
  try { await navigator.clipboard.writeText(text); toast('Réponse copiée. Collez-la sur votre fiche Google.'); }
  catch { $$('#variants [data-variant]')[i].select(); toast('Sélectionnez puis copiez la réponse.', 'info'); }
}
async function publishVariant(i, btn) {
  const text = $$('#variants [data-variant]')[i].value.trim();
  if (!text || !currentReview) return;
  const unbusy = busy(btn);
  try {
    await api(`/reviews/${currentReview.id}/publish`, { method: 'POST', body: { text } });
    $$('#variants [data-publish]').forEach(b => { b.innerHTML = icon('i-check') + 'Marquer comme publiée'; b.classList.remove('is-published'); });
    btn.innerHTML = icon('i-check') + 'Publiée sur Google'; btn.classList.add('is-published');
    const note = $('#published-note');
    note.hidden = false; note.textContent = 'Réponse enregistrée comme publiée. Retrouvez-la dans l’historique.';
    toast('Réponse marquée comme publiée.');
  } catch (err) { toast(err.message, 'error'); }
  finally { unbusy(); }
}

/* ---------- Historique ---------- */
let historyTimer;
async function loadHistory() {
  if (mode !== 'live') return;
  const q = new URLSearchParams({ search: $('#h-search').value.trim(), rating: $('#h-rating').value, status: $('#h-status').value });
  try {
    const { reviews, total, historyLimitedDays } = await api('/reviews?' + q);
    const lim = $('#history-limit');
    if (historyLimitedDays != null) {
      lim.hidden = false;
      lim.innerHTML = `Offre Gratuit : les ${historyLimitedDays} derniers jours sont affichés${total > reviews.length ? ` (${total} avis au total, tous conservés)` : ''}. L’historique complet est inclus dans l’offre Pro.`;
    } else lim.hidden = true;
    $('#history-empty').hidden = !!reviews.length || !!q.get('search') || !!q.get('rating') || !!q.get('status');
    $('#review-list').innerHTML = reviews.map(r => `
      <article class="review-card${r.published_reply ? ' is-published' : ''}">
        <div class="review-card-head">
          <div>${stars(r.rating)} <strong>${esc(r.author_name || 'Anonyme')}</strong> <small>· saisi le ${fmtDate(r.created_at)}${r.visited_on ? ` · visite du ${fmtDate(r.visited_on)}` : ''}</small></div>
          <div class="review-badges">
            ${r.flags?.length ? `<span class="badge badge-flag">${icon('i-flag')}Suspect</span>` : ''}
            ${r.published_reply ? `<span class="badge badge-won">${icon('i-check')}Publiée</span>` : `<span class="badge badge-sent">${r.generation_count ? 'Réponses prêtes' : 'À rédiger'}</span>`}
          </div>
        </div>
        <p class="review-body">${r.body_purged_at ? '<em>Texte effacé (durée de conservation atteinte).</em>' : esc(r.body || '(avis sans texte)')}</p>
        ${r.published_reply ? `<div class="review-reply"><span class="label">Votre réponse publiée</span><p>${esc(r.published_reply).replace(/\n/g, '<br>')}</p></div>` : ''}
        <div class="row-actions">
          <button class="btn btn-outline btn-sm" data-reopen="${r.id}">${icon('i-pen')}${r.published_reply ? 'Revoir' : 'Reprendre'}</button>
          ${r.published_reply ? `<button class="btn btn-quiet btn-sm" data-unpublish="${r.id}">Annuler « publiée »</button>` : ''}
          <button class="btn btn-quiet btn-sm" data-delete-review="${r.id}">${icon('i-trash')}Supprimer</button>
        </div>
      </article>`).join('');
  } catch (e) { toast(e.message, 'error'); }
}
$('#h-search').oninput = () => { clearTimeout(historyTimer); historyTimer = setTimeout(loadHistory, 300); };
$('#h-rating').onchange = loadHistory;
$('#h-status').onchange = loadHistory;

async function reopenReview(id) {
  try {
    const { review, variants, report } = await api(`/reviews/${id}`);
    resetReply();
    const el = form.elements;
    el.id.value = review.id; el.body.value = review.body || ''; el.author_name.value = review.author_name || '';
    el.visited_on.value = review.visited_on || '';
    form.querySelector(`input[name=rating][value="${review.rating}"]`).checked = true;
    form.querySelectorAll('input[name=context_tags]').forEach(i => { i.checked = (review.context_tags || []).includes(i.value); });
    el.context_note.value = review.context_note || '';
    updateContextVisibility();
    currentReview = { id: review.id, flags: review.flags, report, variants };
    renderSuspicion(report);
    $('#reply-new').hidden = false;
    if (variants.length) {
      // Dernière génération uniquement (les variantes arrivent triées par date décroissante).
      const latest = variants.filter(v => v.generation_id === variants[0].generation_id).sort((a, b) => a.idx - b.idx);
      renderVariants({ variants: latest, usage: {}, rejected: [] });
      if (review.published_reply) {
        const note = $('#published-note');
        note.hidden = false; note.textContent = 'Une réponse a déjà été marquée comme publiée pour cet avis.';
      }
    }
    $('#generate-btn').innerHTML = icon('i-sparkle') + (variants.length ? 'Rédiger à nouveau' : 'Rédiger 3 réponses');
    tab('reply');
  } catch (e) { toast(e.message, 'error'); }
}

/* ---------- Collecte d'avis ---------- */
async function loadCollect() {
  if (mode !== 'live') return;
  try {
    const c = await api('/collect');
    $('#collect-pledge p').textContent = c.pledge;
    $('#collect-help').innerHTML = c.helpSteps.map(s => `<li>${esc(s)}</li>`).join('');
    const uf = $('#review-url-form');
    if (document.activeElement?.form !== uf) uf.elements.google_review_url.value = c.google_review_url || '';
    const test = $('#test-review-url');
    test.hidden = !c.google_review_url; if (c.google_review_url) test.href = c.google_review_url;
    const cf = $('#collect-form');
    if (document.activeElement?.form !== cf) { cf.elements.title.value = c.title; cf.elements.message.value = c.message; }
    $('#pdf-pro-note').hidden = c.pro;
    $$('[data-pdf]').forEach(b => { b.disabled = !c.pro || !c.google_review_url; });
    const prev = $('#qr-preview');
    if (c.google_review_url) {
      try {
        const blob = await apiBlob('/collect/qr.png');
        prev.innerHTML = `<img alt="QR code vers votre page d'avis Google" src="${URL.createObjectURL(blob)}"><p class="subtle">Scannez pour vérifier que le lien ouvre bien votre page d'avis.</p>`;
      } catch (e) { prev.innerHTML = `<p class="subtle">${esc(e.message)}</p>`; }
    } else prev.innerHTML = '<p class="subtle">Renseignez votre lien « laisser un avis » pour voir le QR code.</p>';
  } catch (e) { toast(e.message, 'error'); }
}
$('#review-url-form').onsubmit = async e => {
  e.preventDefault();
  const f = e.target, unbusy = busy($('#review-url-btn')), err = $('#err-review-url');
  err.hidden = true;
  try {
    await api('/restaurant', { method: 'PATCH', body: { ...profile, google_review_url: f.elements.google_review_url.value.trim() } });
    await refresh();
    await loadCollect();
    toast('Lien enregistré.');
  } catch (err2) { setErr(err, err2.message); }
  finally { unbusy(); }
};
$('#collect-form').onsubmit = async e => {
  e.preventDefault();
  const f = e.target, unbusy = busy($('#collect-btn')), err = $('#err-collect');
  err.hidden = true;
  try {
    await api('/collect', { method: 'PATCH', body: { title: f.elements.title.value.trim(), message: f.elements.message.value.trim() } });
    toast('Texte enregistré.');
  } catch (err2) { setErr(err, err2.message); }
  finally { unbusy(); }
};
async function downloadPdf(kind, btn) {
  const unbusy = busy(btn);
  try {
    downloadBlob(await apiBlob(`/collect/${kind}.pdf`), `lemotduchef-${kind}.pdf`);
    toast('PDF téléchargé.');
  } catch (e) {
    if (e.code === 'PLAN_LIMIT') { $('#pdf-pro-note').hidden = false; }
    toast(e.message, 'error');
  } finally { unbusy(); }
}

/* ---------- Actions déléguées ---------- */
document.addEventListener('click', e => {
  const close = e.target.closest('[data-close]');
  const tabBtn = e.target.closest('[data-tab]');
  const revoke = e.target.closest('[data-revoke]');
  const adminAct = e.target.closest('[data-admin-act]');
  const subscribe = e.target.closest('[data-subscribe]');
  const portalBtn = e.target.closest('[data-portal]');
  const copy = e.target.closest('[data-copy]');
  const publish = e.target.closest('[data-publish]');
  const reopen = e.target.closest('[data-reopen]');
  const unpublish = e.target.closest('[data-unpublish]');
  const delReview = e.target.closest('[data-delete-review]');
  const pdf = e.target.closest('[data-pdf]');
  const legalLink = e.target.closest('a[href^="/"]');
  if (close) close.closest('dialog')?.close();
  if (tabBtn) { hideMenu(); tab(tabBtn.dataset.tab); }
  if (revoke) revokeSession(revoke.dataset.revoke);
  if (adminAct) adminAction(adminAct.dataset.adminAct, adminAct.dataset.id, adminAct.dataset.email);
  if (subscribe) billingSubscribe(subscribe.dataset.subscribe, subscribe);
  if (portalBtn) billingPortal(portalBtn);
  if (copy) copyVariant(Number(copy.dataset.copy));
  if (publish) publishVariant(Number(publish.dataset.publish), publish);
  if (reopen) reopenReview(reopen.dataset.reopen);
  if (unpublish) api(`/reviews/${unpublish.dataset.unpublish}/publish`, { method: 'POST', body: { published: false } }).then(loadHistory).catch(err => toast(err.message, 'error'));
  if (delReview) deleteReview(delReview.dataset.deleteReview);
  if (pdf) downloadPdf(pdf.dataset.pdf, pdf);
  if (legalLink && LEGAL_PATHS[new URL(legalLink.href).pathname]) { e.preventDefault(); showLegal(new URL(legalLink.href).pathname); }
});
async function deleteReview(id) {
  if (!await askConfirm('Supprimer cet avis ?', 'L’avis et toutes les réponses associées seront supprimés de votre historique.', 'Supprimer')) return;
  try {
    await api(`/reviews/${id}`, { method: 'DELETE' });
    if (currentReview?.id === id) resetReply();
    loadHistory();
    toast('Avis supprimé.', 'info');
  } catch (err) { toast(err.message, 'error'); }
}

/* ---------- Abonnement ---------- */
const PLAN_NAMES = { free: 'Gratuit', pro: 'Pro' };
const STATUS_TXT = { active: 'Abonnement actif', trialing: 'Période d\'essai', past_due: 'Paiement en échec — Stripe retente le prélèvement', canceled: 'Abonnement résilié', unpaid: 'Impayé' };
const fmtPrice = c => c == null ? '—' : (c / 100).toLocaleString('fr-FR', { maximumFractionDigits: 2 }) + ' €';

async function loadBilling() {
  const panel = $('#sub-panel'), body = $('#sub-body');
  if (mode !== 'live') return;
  panel.hidden = false;
  body.innerHTML = '<p class="form-intro">Chargement…</p>';
  try {
    const b = await api('/billing');
    if (!b.enabled) { body.innerHTML = '<p class="form-intro">La facturation n\'est pas encore activée.</p>'; return; }
    const paid = b.plan !== 'free';
    let html = `<div class="sub-line"><span class="plan-badge${paid ? '' : ' free'}">${PLAN_NAMES[b.plan] ?? b.plan}</span><strong>${STATUS_TXT[b.status] ?? (paid ? 'Abonnement actif' : 'Offre gratuite')}</strong></div>`;
    if (b.usage.limit != null) {
      const pct = Math.min(100, Math.round(b.usage.used / b.usage.limit * 100));
      html += `<div class="usage"><div class="usage-bar${b.usage.used >= b.usage.limit ? ' full' : ''}"><i style="width:${pct}%"></i></div><p class="usage-text">${b.usage.used} / ${b.usage.limit} réponses générées ce mois-ci</p></div>`;
    }
    if (paid && b.currentPeriodEnd) {
      html += `<p class="sub-meta">${b.cancelAtPeriodEnd ? `Résiliation programmée — accès jusqu'au ${new Date(b.currentPeriodEnd).toLocaleDateString('fr-FR')}.` : `Prochain renouvellement le ${new Date(b.currentPeriodEnd).toLocaleDateString('fr-FR')}.`}</p>`;
    }
    html += '<div class="sub-actions">';
    if (!paid) {
      const labels = { pro_monthly: 'Pro mensuel', pro_yearly: 'Pro annuel' };
      html += (b.prices || []).map(p => `<button class="btn btn-primary btn-sm" data-subscribe="${p.id}">${labels[p.key] ?? p.key} — ${fmtPrice(p.amount_cents)}${p.interval === 'year' ? '/an' : '/mois'}</button>`).join('')
        || '<p class="form-intro">Aucune offre configurée.</p>';
      const vat = window.LMC_LEGAL?.vatMention;
      html += `<p class="sub-meta">Pro : réponses illimitées, chevalets et encarts PDF, historique complet. Prix sans TVA${vat ? ` · ${esc(vat)}` : ''}. Paiement sécurisé par Stripe.</p>`;
    }
    if (b.hasCustomer) html += `<button class="btn btn-quiet btn-sm" data-portal>${paid ? 'Gérer mon abonnement' : 'Portail de facturation'}${icon('i-arrow')}</button>`;
    html += '</div>';
    body.innerHTML = html;
  } catch (e) { body.innerHTML = `<p class="form-intro">${esc(e.message || 'Abonnement indisponible.')}</p>`; }
}
async function billingSubscribe(priceId, btn) {
  const unbusy = busy(btn);
  try { const { url } = await api('/billing/checkout', { method: 'POST', body: { priceId } }); window.location.href = url; }
  catch (e) { if (e.code === 'CGV_REQUIRED') showCgvBanner(); toast(e.message, 'error'); unbusy(); }
}
async function billingPortal(btn) {
  const unbusy = busy(btn);
  try { const { url } = await api('/billing/portal', { method: 'POST', body: {} }); window.location.href = url; }
  catch (e) { toast(e.message, 'error'); unbusy(); }
}
function showCgvBanner() { $('#cgv-version-label').textContent = cgvVersion; $('#cgv-banner').hidden = false; }
$('#cgv-accept').onclick = async e => {
  const unbusy = busy(e.target);
  try { await api('/legal/accept', { method: 'POST', body: { version: cgvVersion } }); $('#cgv-banner').hidden = true; session.cgv_current = true; toast('CGV acceptées, merci.'); }
  catch (err) { toast(err.message, 'error'); }
  finally { unbusy(); }
};

/* ---------- Compte ---------- */
async function loadAccount() {
  if (mode !== 'live') return;
  try {
    const [me, sessions] = await Promise.all([api('/me'), api('/auth/list-sessions')]);
    session = { ...session, user: me.user, session_id: me.session_id };
    $('#p-name').value = me.user?.name || '';
    $('#p-email').value = me.user?.email || '';
    renderSessions(sessions || []);
  } catch (err) { toast(err.message, 'error'); }
}
function renderSessions(list) {
  const mine = session?.session_id || '';
  $('#session-list').innerHTML = list.length ? list.map(s => `
    <li>
      <div>
        <strong>${esc((s.userAgent || 'Appareil inconnu').split(')')[0].replace(/^Mozilla\/[\d.]+ \(/, '').slice(0, 60) || 'Appareil')}</strong>
        ${mine && s.id === mine ? ' <span class="session-here">Cette session</span>' : ''}
        <small>Connecté le ${fmtDateTime(s.createdAt)} · expire le ${fmtDateTime(s.expiresAt)}${s.ipAddress ? ' · ' + esc(s.ipAddress) : ''}</small>
      </div>
      ${mine && s.id === mine ? '' : `<button class="btn btn-quiet btn-sm" data-revoke="${esc(s.token)}">Révoquer</button>`}
    </li>`).join('') : '<li class="subtle">Aucune autre session.</li>';
}
async function revokeSession(token) {
  if (!await askConfirm('Révoquer cette session ?', 'L\'appareil correspondant sera déconnecté immédiatement.', 'Révoquer')) return;
  try { await api('/auth/revoke-session', { method: 'POST', body: { token } }); renderSessions(await api('/auth/list-sessions')); toast('Session révoquée.', 'info'); }
  catch (err) { toast(err.message, 'error'); }
}
$('#revoke-others').onclick = async () => {
  if (!await askConfirm('Déconnecter les autres appareils ?', 'Toutes les sessions sauf celle-ci seront révoquées.', 'Tout déconnecter')) return;
  try { await api('/auth/revoke-other-sessions', { method: 'POST', body: {} }); renderSessions(await api('/auth/list-sessions')); toast('Autres sessions révoquées.', 'info'); }
  catch (err) { toast(err.message, 'error'); }
};
$('#profile-form').onsubmit = async e => {
  e.preventDefault();
  const f = e.target, unbusy = busy($('#profile-btn')), errN = $('#err-pname'), errE = $('#err-pemail');
  errN.hidden = errE.hidden = true;
  const name = f.elements.name.value.trim(), newEmail = f.elements.newemail.value.trim();
  if (!name) { setErr(errN, 'Indiquez votre nom.'); unbusy(); return; }
  try {
    await api('/profile', { method: 'PATCH', body: { name } });
    if (newEmail) {
      await api('/auth/change-email', { method: 'POST', body: { newEmail, callbackURL: location.origin + '/?verifie=1' } });
      f.elements.newemail.value = '';
      toast('Nom enregistré. Confirmez la nouvelle adresse via l\'email reçu.', 'info');
    } else { session.user.name = name; toast('Profil enregistré.'); }
    render();
  } catch (err) {
    const msg = err.message || 'Enregistrement impossible.';
    if (/email/i.test(msg)) setErr(errE, msg); else toast(msg, 'error');
  } finally { unbusy(); }
};
$('#password-form').onsubmit = async e => {
  e.preventDefault();
  const f = e.target, unbusy = busy($('#password-btn')), err = $('#err-password');
  err.hidden = true;
  if (f.elements.next.value.length < 12) { setErr(err, 'Nouveau mot de passe : 12 caractères minimum.'); unbusy(); return; }
  try {
    await api('/auth/change-password', { method: 'POST', body: { currentPassword: f.elements.current.value, newPassword: f.elements.next.value, revokeOtherSessions: true } });
    f.reset(); renderSessions(await api('/auth/list-sessions'));
    toast('Mot de passe changé. Les autres appareils ont été déconnectés.');
  } catch (err2) { setErr(err, /invalid|password|credential/i.test(err2.message || '') ? 'Mot de passe actuel incorrect.' : (err2.message || 'Changement impossible.')); }
  finally { unbusy(); }
};
$('#export-data').onclick = async () => {
  try { downloadBlob(await apiBlob('/export-data'), `lemotduchef-export-${new Date().toISOString().slice(0, 10)}.json`); toast('Export JSON téléchargé.'); }
  catch (err) { toast(err.message, 'error'); }
};
$('#delete-account').onclick = () => { $('#del-password').value = ''; $('#err-delete-account').hidden = true; $('#delete-account-dlg').showModal(); };
$('#delete-account-confirm').onclick = async () => {
  const err = $('#err-delete-account'), unbusy = busy($('#delete-account-confirm'));
  err.hidden = true;
  try {
    await api('/auth/delete-user', { method: 'POST', body: { password: $('#del-password').value } });
    $('#delete-account-dlg').close();
    session = null; mode = 'landing'; profile = null; usage = null;
    show('landing');
    toast('Compte supprimé. Vos données ont été effacées.', 'info');
  } catch { setErr(err, 'Mot de passe incorrect, ou session trop ancienne — reconnectez-vous puis réessayez.'); }
  finally { unbusy(); }
};

/* ---------- Back-office administration ---------- */
const adminApi = (path, opts) => api('/admin' + path, opts);
async function enterAdmin() {
  if (!session?.admin) { history.replaceState(null, '', '/'); return; }
  history.replaceState(null, '', '/admin');
  show('admin');
  try { await Promise.all([loadAdminStats(), loadAdminCompanies(), loadAdminUsers(), loadAdminSettings(), loadAdminAudit()]); }
  catch (e) { toast(e.message, 'error'); }
}
async function loadAdminStats() {
  const s = await adminApi('/stats');
  const cards = [
    { label: 'Restaurants', value: s.companies }, { label: 'Utilisateurs', value: s.users },
    { label: 'Inscriptions 7 j', value: s.signups7 }, { label: 'Inscriptions 30 j', value: s.signups30 },
    { label: 'Emails non vérifiés', value: s.unverified }, { label: 'Comptes suspendus', value: s.suspended },
    { label: 'Avis saisis', value: s.reviews }, { label: 'Générations (total / mois)', value: `${s.generations} / ${s.generationsMonth}` },
    { label: 'Tokens entrée / sortie', value: `${(s.inputTokens / 1000).toFixed(1)}k / ${(s.outputTokens / 1000).toFixed(1)}k` },
    { label: 'Abonnés payants', value: s.paying ?? 0 }, { label: 'Revenu mensuel récurrent', value: s.mrrCents != null ? fmtPrice(s.mrrCents) : '—' },
  ];
  $('#admin-stats').innerHTML = cards.map(c => `<article class="stat"><div class="stat-head">${icon('i-info')}<p>${c.label}</p></div><strong>${c.value}</strong></article>`).join('');
}
async function loadAdminCompanies() {
  const search = $('#admin-co-search').value.trim(), sort = $('#admin-co-sort').value;
  const { companies } = await adminApi(`/companies?search=${encodeURIComponent(search)}&sort=${sort}`);
  $('#admin-companies-count').textContent = `${companies.length} restaurant(s)`;
  $('#admin-companies').innerHTML = companies.map(c => {
    const paidPlan = ['active', 'trialing', 'past_due'].includes(c.subscription_status) && c.plan !== 'free';
    const sub = paidPlan && c.subscription_status !== 'active' ? ` · ${STATUS_TXT[c.subscription_status] ?? c.subscription_status}` : '';
    return `<tr><td><strong>${esc(c.name)}</strong></td><td>${esc(c.city || '—')}</td>
      <td><span class="plan-badge${paidPlan ? '' : ' free'}">${paidPlan ? 'Pro' : 'Gratuit'}</span>${esc(sub)}</td>
      <td>${new Date(c.created_at).toLocaleDateString('fr-FR')}</td><td>${c.reviews_count}</td><td>${c.generations_month}</td>
      <td>${c.last_activity ? fmtDateTime(c.last_activity) : '—'}</td></tr>`;
  }).join('') || '<tr><td colspan="7" class="subtle">Aucun restaurant.</td></tr>';
}
let adminSearchTimer;
$('#admin-co-search').oninput = () => { clearTimeout(adminSearchTimer); adminSearchTimer = setTimeout(loadAdminCompanies, 300); };
$('#admin-co-sort').onchange = loadAdminCompanies;
async function loadAdminUsers() {
  const search = $('#admin-u-search').value.trim();
  const { users } = await adminApi(`/users?search=${encodeURIComponent(search)}`);
  $('#admin-users-count').textContent = `${users.length} utilisateur(s)`;
  $('#admin-users').innerHTML = users.map(u => `<tr${u.suspended_at ? ' class="row-suspended"' : ''}>
    <td><strong>${esc(u.name)}</strong><span class="cell-sub">${esc(u.email)}${u.suspended_at ? ' <span class="badge-suspended">Suspendu</span>' : ''}</span></td>
    <td>${esc(u.company_name || '—')}</td>
    <td>${u.email_verified ? '<span class="badge-verified">Vérifié</span>' : '<span class="badge-unverified">Non vérifié</span>'}</td>
    <td>${new Date(u.created_at).toLocaleDateString('fr-FR')}</td>
    <td>${u.last_seen ? fmtDateTime(u.last_seen) : '—'}</td>
    <td><div class="admin-actions">
      ${!u.email_verified ? `<button class="btn btn-quiet btn-sm" data-admin-act="verify" data-id="${u.id}" data-email="${esc(u.email)}">Forcer vérif.</button>
      <button class="btn btn-quiet btn-sm" data-admin-act="resend" data-id="${u.id}" data-email="${esc(u.email)}">Renvoyer l'email</button>` : ''}
      <button class="btn btn-quiet btn-sm" data-admin-act="${u.suspended_at ? 'reactivate' : 'suspend'}" data-id="${u.id}" data-email="${esc(u.email)}">${u.suspended_at ? 'Réactiver' : 'Suspendre'}</button>
      <button class="btn btn-quiet btn-sm" data-admin-act="revoke" data-id="${u.id}" data-email="${esc(u.email)}">Révoquer sessions</button>
      <button class="btn btn-quiet btn-sm" data-admin-act="delete" data-id="${u.id}" data-email="${esc(u.email)}">Supprimer</button>
    </div></td></tr>`).join('') || '<tr><td colspan="6" class="subtle">Aucun utilisateur.</td></tr>';
}
let adminUSearchTimer;
$('#admin-u-search').oninput = () => { clearTimeout(adminUSearchTimer); adminUSearchTimer = setTimeout(loadAdminUsers, 300); };
async function loadAdminSettings() { const s = await adminApi('/settings'); $('#admin-signup-toggle').checked = !!s.signupEnabled; }
$('#admin-signup-toggle').onchange = async e => {
  try { await adminApi('/settings', { method: 'PUT', body: { signupEnabled: e.target.checked } }); toast(`Inscription publique ${e.target.checked ? 'ouverte' : 'fermée'}.`, 'info'); }
  catch (err) { e.target.checked = !e.target.checked; toast(err.message, 'error'); }
};
$('#admin-invite-form').onsubmit = async e => {
  e.preventDefault();
  const f = e.target, unbusy = busy($('#invite-btn')), err = $('#err-invite');
  err.hidden = true;
  try {
    await adminApi('/accounts', { method: 'POST', body: { email: f.elements.email.value.trim(), name: f.elements.name.value.trim() } });
    f.reset(); toast('Compte créé. Email d\'invitation envoyé.'); loadAdminUsers();
  } catch (err2) { setErr(err, err2.message || 'Création impossible.'); }
  finally { unbusy(); }
};
async function loadAdminAudit() {
  const { entries } = await adminApi('/audit');
  $('#admin-audit').innerHTML = entries.map(en => `<tr><td>${fmtDateTime(en.created_at)}</td><td>${esc(en.admin_email)}</td><td><strong>${esc(en.action)}</strong></td>
    <td>${esc([en.target_type, en.target_id].filter(Boolean).join(' · ') || '—')}</td><td>${esc(en.ip || '—')}</td></tr>`).join('')
    || '<tr><td colspan="5" class="subtle">Aucune action enregistrée.</td></tr>';
}
let adminDeleteTarget = null;
async function adminAction(act, id, email) {
  const done = msg => { toast(msg, 'info'); Promise.all([loadAdminUsers(), loadAdminAudit(), loadAdminStats()]).catch(() => {}); };
  try {
    switch (act) {
      case 'verify':
        if (!await askConfirm('Forcer la vérification ?', `L'email de ${email} sera marqué vérifié.`, 'Forcer')) return;
        await adminApi(`/users/${id}/verify`, { method: 'POST', body: {} }); return done('Email marqué vérifié.');
      case 'resend':
        await adminApi(`/users/${id}/resend-verification`, { method: 'POST', body: {} }); return done('Email de vérification renvoyé.');
      case 'suspend':
        if (!await askConfirm('Suspendre ce compte ?', `${email} ne pourra plus se connecter et toutes ses sessions seront révoquées.`, 'Suspendre')) return;
        await adminApi(`/users/${id}/suspend`, { method: 'POST', body: { suspended: true } }); return done('Compte suspendu.');
      case 'reactivate':
        await adminApi(`/users/${id}/suspend`, { method: 'POST', body: { suspended: false } }); return done('Compte réactivé.');
      case 'revoke':
        if (!await askConfirm('Révoquer les sessions ?', `Toutes les sessions de ${email} seront fermées.`, 'Révoquer')) return;
        await adminApi(`/users/${id}/revoke-sessions`, { method: 'POST', body: {} }); return done('Sessions révoquées.');
      case 'delete':
        adminDeleteTarget = { id, email };
        $('#admin-delete-email').textContent = email; $('#admin-delete-confirm-email').value = ''; $('#err-admin-delete').hidden = true;
        $('#admin-delete-dlg').showModal(); return;
    }
  } catch (err) { toast(err.message, 'error'); }
}
$('#admin-delete-confirm').onclick = async () => {
  const err = $('#err-admin-delete'), unbusy = busy($('#admin-delete-confirm'));
  err.hidden = true;
  if ($('#admin-delete-confirm-email').value.trim().toLowerCase() !== adminDeleteTarget?.email?.toLowerCase()) { setErr(err, 'L\'email saisi ne correspond pas.'); unbusy(); return; }
  try {
    await adminApi(`/users/${adminDeleteTarget.id}`, { method: 'DELETE' });
    $('#admin-delete-dlg').close(); toast('Compte supprimé.', 'info');
    Promise.all([loadAdminUsers(), loadAdminAudit(), loadAdminStats()]).catch(() => {});
  } catch (err2) { setErr(err, err2.message || 'Suppression impossible.'); }
  finally { unbusy(); }
};

/* ---------- Démarrage ---------- */
(async function boot() {
  const params = new URLSearchParams(location.search);
  const resetToken = location.pathname === '/reinitialiser' && params.get('token');
  const justVerified = params.get('verifie') === '1';
  const billingResult = params.get('billing');

  try {
    appConfig = await api('/config');
    signupEnabled = !!appConfig.signupEnabled;
    cgvVersion = appConfig.cgvVersion ?? '';
  } catch { signupEnabled = false; }
  fillLegal(); fillConfig();
  $('#auth-tabs').hidden = !signupEnabled;
  $('#tab-signup').hidden = !signupEnabled;

  // Montants des offres relus depuis Stripe (endpoint public, cache serveur).
  try {
    const { prices } = await api('/billing/prices');
    $$('[data-price]').forEach(el => {
      const p = (prices || []).find(x => x.key === el.dataset.price);
      if (p?.amount_cents != null) el.textContent = fmtPrice(p.amount_cents);
    });
  } catch { /* prix non disponibles : « — » affiché */ }

  if (resetToken) { showAuth('reset'); return; }
  if (showLegal(location.pathname)) return;

  try {
    const me = await api('/me');
    if (me?.user) {
      session = me;
      if (me.restaurant) {
        mode = 'live'; await refresh(); show('app'); render();
        if (location.pathname === '/admin' && me.admin) { enterAdmin(); return; }
        if (location.pathname === '/admin') history.replaceState(null, '', '/');
        if (billingResult === 'success') { history.replaceState(null, '', '/'); toast('Abonnement activé, merci !'); await refresh(); render(); }
        else if (billingResult === 'cancel') { history.replaceState(null, '', '/'); toast('Souscription annulée — rien n\'a été débité.', 'info'); }
        return;
      }
      startOnboarding();
      return;
    }
  } catch { /* pas de session : page commerciale */ }
  if (justVerified) { history.replaceState(null, '', '/'); showAuth('login', 'Email confirmé. Connectez-vous pour accéder à votre espace.'); }
})();
