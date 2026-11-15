const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ADMIN_PIN = process.env.ADMIN_PIN || '1234';          // change in production
const SALT = process.env.EPIC_SALT || 'the-republic-salt';
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'election.json');
const NOTA = { id: 'nota', name: 'NOTA', party: 'None of the Above', symbol: '✖' };

/* ---------- storage (JSON file) ---------- */
const defaults = () => ({
  status: 'not_started',                 // not_started | open | closed
  closesAt: null,                        // ms timestamp, null = manual close
  candidates: [
    { id: 'kjp', name: 'Kishore Janatha Party',               party: 'KJP',    symbol: '🌸' },
    { id: 'kcp', name: 'Kishore Communist Party (Marxist)',   party: 'KCP(M)', symbol: '⚒️' },
    { id: 'knc', name: 'Kishore National Congress',           party: 'KNC',    symbol: '✋' }
  ],
  tally: {},                             // candidateId -> count (anonymous)
  voted: [],                             // hashed EPIC numbers (who voted, never what)
  receipts: []                           // random reference numbers (not linked to voter or choice)
});

function load() {
  try { return { ...defaults(), ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) }; }
  catch { return defaults(); }
}
function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DATA_FILE);          // atomic write
}
let db = load();
save();

/* ---------- helpers ---------- */
const hashEpic = epic => crypto.createHash('sha256').update(SALT + epic).digest('hex');
const options = () => [...db.candidates, NOTA];                 // NOTA always last (ECI)
const newToken = () => crypto.randomBytes(24).toString('hex');
const fail = (res, status, code, error) => res.status(status).json({ error, code });

function newReference() {
  const h = crypto.randomBytes(6).toString('hex').toUpperCase();   // 12 hex chars
  return `REP-${h.slice(0, 4)}-${h.slice(4, 8)}-${h.slice(8, 12)}`;
}

// auto-close polling when the timer runs out
function tick() {
  if (db.status === 'open' && db.closesAt && Date.now() >= db.closesAt) {
    db.status = 'closed'; save();
  }
}
setInterval(tick, 1000);

function ageOn(dob) {
  const d = new Date(dob), t = new Date();
  let a = t.getFullYear() - d.getFullYear();
  const m = t.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && t.getDate() < d.getDate())) a--;
  return a;
}

// tiny in-memory rate limiter: max 10 tries / 5 min per IP per bucket
const hits = new Map();
const limit = bucket => (req, res, next) => {
  const k = bucket + req.ip, now = Date.now();
  const arr = (hits.get(k) || []).filter(t => now - t < 300000);
  if (arr.length >= 10) return fail(res, 429, 'rate', 'Too many attempts. Try again in 5 minutes.');
  arr.push(now); hits.set(k, arr); next();
};

const voteTokens = new Map();   // token -> { epicHash, exp }
const adminTokens = new Map();  // token -> exp

function requireAdmin(req, res, next) {
  const t = req.get('x-admin-token');
  const exp = adminTokens.get(t);
  if (!exp || exp < Date.now()) return fail(res, 401, 'login_required', 'Officer login required.');
  tick(); next();
}

/* ---------- app ---------- */
const app = express();
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ----- public ----- */
app.get('/api/status', (req, res) => {
  tick();
  res.json({ status: db.status, options: options(), closesAt: db.status === 'open' ? db.closesAt : null, serverTime: Date.now() });
});

app.post('/api/verify', limit('verify'), (req, res) => {
  tick();
  const name = String(req.body.name || '').trim();
  const dob = String(req.body.dob || '');
  const epic = String(req.body.epic || '').trim().toUpperCase();

  if (db.status === 'not_started') return fail(res, 400, 'not_started', 'Polling has not started yet.');
  if (db.status === 'closed')      return fail(res, 400, 'closed', 'Polling is closed.');
  if (name.length < 3)             return fail(res, 400, 'name', 'Enter your full name.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob) || isNaN(new Date(dob)) || new Date(dob) > new Date())
    return fail(res, 400, 'dob', 'Enter a valid date of birth.');
  if (ageOn(dob) < 18)             return fail(res, 400, 'age', 'You must be 18 or older to vote.');
  if (!/^[A-Z]{3}[0-9]{7}$/.test(epic)) return fail(res, 400, 'epic', 'EPIC must be 3 letters followed by 7 digits.');

  const epicHash = hashEpic(epic);
  if (db.voted.includes(epicHash)) return fail(res, 409, 'voted', 'This EPIC number has already voted.');

  const token = newToken();
  voteTokens.set(token, { epicHash, exp: Date.now() + 5 * 60 * 1000 });   // 5 min, single use
  res.json({ token });
});

app.post('/api/vote', (req, res) => {
  tick();
  const { token, candidateId } = req.body || {};
  const sess = voteTokens.get(token);
  voteTokens.delete(token);                                   // single use
  if (!sess || sess.exp < Date.now()) return fail(res, 401, 'session', 'Session expired. Verify again.');
  if (db.status !== 'open')           return fail(res, 400, 'not_open', 'Polling is not open.');
  if (db.voted.includes(sess.epicHash)) return fail(res, 409, 'voted', 'Already voted.');
  if (!options().some(o => o.id === candidateId)) return fail(res, 400, 'choice', 'Invalid choice.');

  let ref;
  do { ref = newReference(); } while (db.receipts.includes(ref));
  db.voted.push(sess.epicHash);
  db.tally[candidateId] = (db.tally[candidateId] || 0) + 1;
  db.receipts.push(ref);                                      // ref is random: no link to voter or choice
  save();
  res.json({ ok: true, ref });
});

app.get('/api/receipt/:ref', limit('receipt'), (req, res) => {
  res.json({ valid: db.receipts.includes(String(req.params.ref).trim().toUpperCase()) });
});

app.get('/api/results', (req, res) => {
  tick();
  if (db.status !== 'closed') return fail(res, 403, 'results_locked', 'Results are shown only after polling closes.');
  const rows = options().map(o => ({ ...o, votes: db.tally[o.id] || 0 }));
  const total = rows.reduce((s, r) => s + r.votes, 0);
  const contenders = rows.filter(r => r.id !== 'nota');
  const top = Math.max(0, ...contenders.map(r => r.votes));
  const leaders = contenders.filter(r => r.votes === top && top > 0);
  res.json({ rows, total, winner: leaders.length === 1 ? leaders[0].id : null, tie: leaders.length > 1 });
});

/* ----- officer ----- */
app.post('/api/admin/login', limit('login'), (req, res) => {
  const given = Buffer.from(String(req.body.pin || ''));
  const real = Buffer.from(ADMIN_PIN);
  const ok = given.length === real.length && crypto.timingSafeEqual(given, real);
  if (!ok) return fail(res, 401, 'pin', 'Wrong PIN.');
  const t = newToken();
  adminTokens.set(t, Date.now() + 2 * 60 * 60 * 1000);
  res.json({ token: t });
});

app.get('/api/admin/summary', requireAdmin, (req, res) => {
  res.json({ status: db.status, candidates: db.candidates, totalVotes: db.voted.length });
});

app.post('/api/admin/start', requireAdmin, (req, res) => {
  if (db.status !== 'not_started') return fail(res, 400, 'already_started', 'Polling already started.');
  if (db.candidates.length < 2)    return fail(res, 400, 'min2', 'Add at least 2 candidates.');
  let closesAt = null;
  const m = req.body.minutes;
  if (m !== null && m !== undefined && m !== '') {
    const mins = Number(m);
    if (!Number.isFinite(mins) || mins < 1 || mins > 1440) return fail(res, 400, 'duration', 'Enter a duration between 1 and 1440 minutes.');
    closesAt = Date.now() + Math.round(mins * 60 * 1000);
  }
  db.status = 'open'; db.closesAt = closesAt; save(); res.json({ ok: true, closesAt });
});

app.post('/api/admin/close', requireAdmin, (req, res) => {
  if (db.status !== 'open') return fail(res, 400, 'not_open', 'Polling is not open.');
  db.status = 'closed'; save(); res.json({ ok: true });
});

app.post('/api/admin/candidates', requireAdmin, (req, res) => {
  if (db.status !== 'not_started') return fail(res, 400, 'locked', 'Candidate list is locked.');
  const name = String(req.body.name || '').trim().slice(0, 60);
  const party = String(req.body.party || '').trim().slice(0, 40);
  const symbol = String(req.body.symbol || '').trim().slice(0, 4);
  if (!name || !party || !symbol) return fail(res, 400, 'fields', 'Fill all fields.');
  if (db.candidates.length >= 15)  return fail(res, 400, 'max15', 'Maximum 15 candidates (EVM limit).');
  if (db.candidates.some(c => c.symbol === symbol)) return fail(res, 400, 'symbol', 'Symbol already taken.');
  db.candidates.push({ id: 'c' + Date.now(), name, party, symbol });
  save(); res.json({ ok: true });
});

app.delete('/api/admin/candidates/:id', requireAdmin, (req, res) => {
  if (db.status !== 'not_started') return fail(res, 400, 'locked', 'Candidate list is locked.');
  db.candidates = db.candidates.filter(c => c.id !== req.params.id);
  save(); res.json({ ok: true });
});

app.post('/api/admin/reset', requireAdmin, (req, res) => {
  db = defaults(); voteTokens.clear(); save(); res.json({ ok: true });
});

app.listen(PORT, () => console.log(`The-Republic running at http://localhost:${PORT}`));
