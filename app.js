/* The-Republic frontend: talks to the Node.js API */
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

let status = 'not_started';
let options = [];
let voteToken = null;
let choice = null;
let adminToken = null;

async function api(path, method = 'GET', body, admin = false) {
  const headers = { 'Content-Type': 'application/json' };
  if (admin && adminToken) headers['x-admin-token'] = adminToken;
  try {
    const r = await fetch('/api' + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Something went wrong.');
    return data;
  } catch (e) {
    if (e instanceof TypeError) throw new Error('Cannot reach server.');
    throw e;
  }
}

/* ---------- navigation ---------- */
async function show(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  $(id).classList.add('active');
  window.scrollTo(0, 0);
  if (id === 'ballot') renderBallot();
  if (id === 'results') await renderResults();
  if (id === 'admin') await refreshAdmin();
}
document.addEventListener('click', e => {
  const go = e.target.closest('[data-go]');
  if (go) show(go.dataset.go);
});

async function loadStatus() {
  try {
    const s = await api('/status');
    status = s.status; options = s.options;
  } catch {}
  const map = { not_started: ['Polling not started', ''], open: ['Polling open', 'open'], closed: ['Polling closed', 'closed'] };
  $('statusPill').textContent = map[status][0];
  $('statusPill').className = 'pill ' + map[status][1];
}

/* ---------- voter verification ---------- */
$('verifyForm').addEventListener('submit', async e => {
  e.preventDefault();
  const msg = $('verifyMsg'); msg.textContent = '';
  try {
    const r = await api('/verify', 'POST', {
      name: $('vName').value, dob: $('vDob').value, epic: $('vEpic').value
    });
    voteToken = r.token; choice = null;
    e.target.reset();
    await loadStatus();
    show('ballot');
  } catch (err) { msg.textContent = err.message; }
});

/* ---------- ballot ---------- */
function renderBallot() {
  $('ballotList').innerHTML = options.map((c, i) => `
    <li>
      <span class="sn">${i + 1}</span>
      <span class="who"><strong>${esc(c.name)}</strong><span>${esc(c.party)}</span></span>
      <span class="sym">${esc(c.symbol)}</span>
      <button type="button" data-pick="${esc(c.id)}" aria-label="Vote for ${esc(c.name)}"></button>
    </li>`).join('');
}
$('ballotList').addEventListener('click', e => {
  const b = e.target.closest('[data-pick]');
  if (!b || !voteToken) return;
  choice = options.find(c => c.id === b.dataset.pick);
  $('slip').innerHTML = `<div class="big">${esc(choice.symbol)}</div><strong>${esc(choice.name)}</strong>${esc(choice.party)}`;
  show('confirm');
});

$('castBtn').addEventListener('click', async () => {
  if (!voteToken || !choice) return show('home');
  $('castBtn').disabled = true;
  try {
    await api('/vote', 'POST', { token: voteToken, candidateId: choice.id });
    voteToken = null; choice = null;
    show('done');
  } catch (err) {
    alert(err.message);
    voteToken = null; choice = null;
    show('home');
  } finally { $('castBtn').disabled = false; }
});

/* ---------- results ---------- */
async function renderResults() {
  const box = $('resultBox');
  try {
    const r = await api('/results');
    let banner = '<div class="banner">No votes cast</div>';
    if (r.total > 0) {
      const w = r.rows.find(x => x.id === r.winner);
      banner = r.tie
        ? '<div class="banner">Tie. Decided by draw of lots as per rules.</div>'
        : `<div class="banner">Winner: ${esc(w.name)} (${esc(w.party)})</div>`;
    }
    box.innerHTML = banner + `<p class="muted">Total votes: ${r.total}</p>` + r.rows.map(x => {
      const pct = r.total ? (x.votes / r.total * 100).toFixed(1) : '0.0';
      return `<div class="bar ${x.id === r.winner ? 'win' : ''}">
        <div class="row"><span>${esc(x.symbol)} ${esc(x.name)}</span><span>${x.votes} (${pct}%)</span></div>
        <div class="track"><div class="fill" style="width:${pct}%"></div></div></div>`;
    }).join('');
  } catch (err) {
    box.innerHTML = `<p class="muted">${esc(err.message)}</p>`;
  }
}

/* ---------- officer ---------- */
$('loginBtn').addEventListener('click', async () => {
  try {
    const r = await api('/admin/login', 'POST', { pin: $('pin').value });
    adminToken = r.token;
    $('adminMsg').textContent = '';
    await refreshAdmin();
  } catch (err) { $('adminMsg').textContent = err.message; }
  $('pin').value = '';
});

$('logoutBtn').addEventListener('click', () => {
  adminToken = null; show('home');
});

async function refreshAdmin() {
  await loadStatus();
  if (!adminToken) { $('adminLogin').hidden = false; $('adminPanel').hidden = true; return; }
  try {
    const s = await api('/admin/summary', 'GET', null, true);
    $('adminLogin').hidden = true; $('adminPanel').hidden = false;
    $('totalVotes').textContent = s.totalVotes;
    $('openBtn').disabled = s.status !== 'not_started' || s.candidates.length < 2;
    $('closeBtn').disabled = s.status !== 'open';
    const locked = s.status !== 'not_started';
    $('candList').innerHTML = s.candidates.map(c =>
      `<li><span>${esc(c.symbol)} ${esc(c.name)} <small>(${esc(c.party)})</small></span>
       ${locked ? '' : `<button data-del="${esc(c.id)}" aria-label="Remove ${esc(c.name)}">✕</button>`}</li>`).join('');
    $('candForm').hidden = locked;
  } catch (err) {
    adminToken = null;
    $('adminLogin').hidden = false; $('adminPanel').hidden = true;
    $('adminMsg').textContent = err.message;
  }
}

async function adminAction(fn) {
  try { await fn(); $('candMsg').textContent = ''; }
  catch (err) { $('candMsg').textContent = err.message; }
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
    await api('/admin/candidates', 'POST',
      { name: $('cName').value, party: $('cParty').value, symbol: $('cSym').value }, true);
    form.reset();
  });
});
$('openBtn').addEventListener('click', () => adminAction(() => api('/admin/start', 'POST', {}, true)));
$('closeBtn').addEventListener('click', () => {
  if (confirm('Close polling? This cannot be undone.')) adminAction(() => api('/admin/close', 'POST', {}, true));
});
$('resetBtn').addEventListener('click', () => {
  if (confirm('Erase all data and reset election?')) adminAction(() => api('/admin/reset', 'POST', {}, true));
});

loadStatus();
