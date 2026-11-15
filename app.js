/* The-Republic frontend: talks to the Node.js API */
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

let status = 'not_started';
let options = [];
let closesAt = null;
let clockOffset = 0;            // serverTime - clientTime
let voteToken = null;
let choice = null;
let adminToken = null;
let currentView = 'home';
let lang = 'en';
try { lang = localStorage.getItem('lang') || 'en'; } catch {}
if (!I18N[lang]) lang = 'en';

/* ---------- i18n ---------- */
const t = k => (I18N[lang] && I18N[lang][k]) || I18N.en[k] || k;
const errText = e => e.code && (I18N[lang]['e.' + e.code] || I18N.en['e.' + e.code]) || e.message || t('e.generic');
const nameOf = c => (lang !== 'en' && NAMES[c.id] && NAMES[c.id][lang]) || c.name;
const partyOf = c => c.id === 'nota' ? NOTA_SUB[lang] : c.party;

function applyLang() {
  document.documentElement.lang = lang;
  $('lang').value = lang;
  document.querySelectorAll('[data-i18n]').forEach(el => el.textContent = t(el.dataset.i18n));
  document.querySelectorAll('[data-ph]').forEach(el => el.placeholder = t(el.dataset.ph));
  ['verifyMsg', 'adminMsg', 'candMsg', 'refMsg'].forEach(id => $(id).textContent = '');
  renderStatus(); renderTimer();
  if (currentView === 'ballot') renderBallot();
  if (currentView === 'confirm') renderSlip();
  if (currentView === 'results') renderResults();
  if (currentView === 'admin') refreshAdmin();
}
$('lang').addEventListener('change', e => {
  lang = e.target.value;
  try { localStorage.setItem('lang', lang); } catch {}
  applyLang();
});

/* ---------- api ---------- */
async function api(path, method = 'GET', body, admin = false) {
  const headers = { 'Content-Type': 'application/json' };
  if (admin && adminToken) headers['x-admin-token'] = adminToken;
  let r;
  try {
    r = await fetch('/api' + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch {
    const e = new Error('Cannot reach server.'); e.code = 'network'; throw e;
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(data.error || 'Error'); e.code = data.code; throw e; }
  return data;
}

/* ---------- navigation ---------- */
async function show(id) {
  currentView = id;
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  $(id).classList.add('active');
  window.scrollTo(0, 0);
  if (id === 'ballot') renderBallot();
  if (id === 'results') { await loadStatus(); await renderResults(); }
  if (id === 'admin') await refreshAdmin();
  if (id === 'receipt') { $('refMsg').textContent = ''; $('refMsg').className = 'msg'; }
}
document.addEventListener('click', e => {
  const go = e.target.closest('[data-go]');
  if (go) show(go.dataset.go);
});

/* ---------- status + countdown ---------- */
async function loadStatus() {
  try {
    const s = await api('/status');
    status = s.status; options = s.options; closesAt = s.closesAt;
    clockOffset = s.serverTime - Date.now();
  } catch {}
  renderStatus(); renderTimer();
}
function renderStatus() {
  $('statusPill').textContent = t('status.' + status);
  $('statusPill').className = 'pill ' + (status === 'open' ? 'open' : status === 'closed' ? 'closed' : '');
}
const pad = n => String(n).padStart(2, '0');
function renderTimer() {
  const el = $('timer');
  if (status !== 'open' || !closesAt) { el.hidden = true; return; }
  const left = Math.max(0, Math.floor((closesAt - (Date.now() + clockOffset)) / 1000));
  el.hidden = false;
  el.textContent = `${t('timer.label')} ${pad(Math.floor(left / 3600))}:${pad(Math.floor(left % 3600 / 60))}:${pad(left % 60)}`;
  el.classList.toggle('warn', left <= 60);
}
let refreshing = false;
setInterval(async () => {
  renderTimer();
  if (status === 'open' && closesAt && Date.now() + clockOffset >= closesAt && !refreshing) {
    refreshing = true;
    await loadStatus();                      // server has auto-closed polling
    if (currentView === 'admin') refreshAdmin();
    refreshing = false;
  }
}, 1000);

/* ---------- voter verification ---------- */
$('verifyForm').addEventListener('submit', async e => {
  e.preventDefault();
  const msg = $('verifyMsg'); msg.textContent = '';
  try {
    const r = await api('/verify', 'POST', { name: $('vName').value, dob: $('vDob').value, epic: $('vEpic').value });
    voteToken = r.token; choice = null;
    e.target.reset();
    await loadStatus();
    show('ballot');
  } catch (err) { msg.textContent = errText(err); await loadStatus(); }
});

/* ---------- ballot ---------- */
function renderBallot() {
  $('ballotList').innerHTML = options.map((c, i) => `
    <li>
      <span class="sn">${i + 1}</span>
      <span class="who"><strong>${esc(nameOf(c))}</strong><span>${esc(partyOf(c))}</span></span>
      <span class="sym">${esc(c.symbol)}</span>
      <button type="button" data-pick="${esc(c.id)}" aria-label="${esc(t('ballot.vote_for') + ' ' + nameOf(c))}"></button>
    </li>`).join('');
}
function renderSlip() {
  if (!choice) return;
  $('slip').innerHTML = `<div class="big">${esc(choice.symbol)}</div><strong>${esc(nameOf(choice))}</strong>${esc(partyOf(choice))}`;
}
$('ballotList').addEventListener('click', e => {
  const b = e.target.closest('[data-pick]');
  if (!b || !voteToken) return;
  choice = options.find(c => c.id === b.dataset.pick);
  renderSlip();
  show('confirm');
});

$('castBtn').addEventListener('click', async () => {
  if (!voteToken || !choice) return show('home');
  $('castBtn').disabled = true;
  try {
    const r = await api('/vote', 'POST', { token: voteToken, candidateId: choice.id });
    voteToken = null; choice = null;
    $('refNo').textContent = r.ref;
    $('copyBtn').textContent = t('done.copy');
    show('done');
  } catch (err) {
    alert(errText(err));
    voteToken = null; choice = null;
    await loadStatus();
    show('home');
  } finally { $('castBtn').disabled = false; }
});

$('copyBtn').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('refNo').textContent); $('copyBtn').textContent = t('done.copied'); } catch {}
});

/* ---------- check vote reference ---------- */
$('refCheck').addEventListener('click', async () => {
  const msg = $('refMsg');
  const ref = $('refInput').value.trim().toUpperCase();
  if (!ref) return;
  try {
    const r = await api('/receipt/' + encodeURIComponent(ref));
    msg.textContent = r.valid ? t('receipt.valid') : t('receipt.invalid');
    msg.className = 'msg' + (r.valid ? ' ok' : '');
  } catch (err) { msg.textContent = errText(err); msg.className = 'msg'; }
});

/* ---------- results ---------- */
async function renderResults() {
  const box = $('resultBox');
  try {
    const r = await api('/results');
    let banner = `<div class="banner">${esc(t('results.none'))}</div>`;
    if (r.total > 0) {
      const w = r.rows.find(x => x.id === r.winner);
      banner = r.tie
        ? `<div class="banner">${esc(t('results.tie'))}</div>`
        : `<div class="banner">${esc(t('results.winner'))}: ${esc(nameOf(w))} (${esc(partyOf(w))})</div>`;
    }
    box.innerHTML = banner + `<p class="muted">${esc(t('results.total'))}: ${r.total}</p>` + r.rows.map(x => {
      const pct = r.total ? (x.votes / r.total * 100).toFixed(1) : '0.0';
      return `<div class="bar ${x.id === r.winner ? 'win' : ''}">
        <div class="row"><span>${esc(x.symbol)} ${esc(nameOf(x))}</span><span>${x.votes} (${pct}%)</span></div>
        <div class="track"><div class="fill" style="width:${pct}%"></div></div></div>`;
    }).join('');
  } catch (err) {
    box.innerHTML = `<p class="muted">${esc(errText(err))}</p>`;
  }
}

/* ---------- officer ---------- */
$('loginBtn').addEventListener('click', async () => {
  try {
    const r = await api('/admin/login', 'POST', { pin: $('pin').value });
    adminToken = r.token;
    $('adminMsg').textContent = '';
    await refreshAdmin();
  } catch (err) { $('adminMsg').textContent = errText(err); }
  $('pin').value = '';
});
$('logoutBtn').addEventListener('click', () => { adminToken = null; show('home'); });

async function refreshAdmin() {
  await loadStatus();
  if (!adminToken) { $('adminLogin').hidden = false; $('adminPanel').hidden = true; return; }
  try {
    const s = await api('/admin/summary', 'GET', null, true);
    $('adminLogin').hidden = true; $('adminPanel').hidden = false;
    $('totalVotes').textContent = s.totalVotes;
    const notStarted = s.status === 'not_started';
    $('openBtn').disabled = !notStarted || s.candidates.length < 2;
    $('durationBox').hidden = !notStarted;
    $('closeBtn').disabled = s.status !== 'open';
    $('candList').innerHTML = s.candidates.map(c =>
      `<li><span>${esc(c.symbol)} ${esc(nameOf(c))} <small>(${esc(c.party)})</small></span>
       ${notStarted ? `<button data-del="${esc(c.id)}" aria-label="Remove">✕</button>` : ''}</li>`).join('');
    $('candForm').hidden = !notStarted;
  } catch (err) {
    adminToken = null;
    $('adminLogin').hidden = false; $('adminPanel').hidden = true;
    $('adminMsg').textContent = errText(err);
  }
}
async function adminAction(fn) {
  try { await fn(); $('candMsg').textContent = ''; }
  catch (err) { $('candMsg').textContent = errText(err); }
  await refreshAdmin();
}
$('candList').addEventListener('click', e => {
  const b = e.target.closest('[data-del]');
  if (b) adminAction(() => api('/admin/candidates/' + encodeURIComponent(b.dataset.del), 'DELETE', null, true));
});
$('candForm').addEventListener('submit', e => {
  e.preventDefault();
  const form = e.target;
  adminAction(async () => {
    await api('/admin/candidates', 'POST', { name: $('cName').value, party: $('cParty').value, symbol: $('cSym').value }, true);
    form.reset();
  });
});
$('openBtn').addEventListener('click', () =>
  adminAction(() => api('/admin/start', 'POST', { minutes: $('duration').value }, true)));
$('closeBtn').addEventListener('click', () => {
  if (confirm(t('confirm_close'))) adminAction(() => api('/admin/close', 'POST', {}, true));
});
$('resetBtn').addEventListener('click', () => {
  if (confirm(t('confirm_reset'))) adminAction(() => api('/admin/reset', 'POST', {}, true));
});

applyLang();
loadStatus();
