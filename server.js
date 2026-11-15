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
  candidates: [
    { id: 'kjp', name: 'Kishore Janatha Party',               party: 'KJP',    symbol: '🌸' },
    { id: 'kcp', name: 'Kishore Communist Party (Marxist)',   party: 'KCP(M)', symbol: '⚒️' },
    { id: 'knc', name: 'Kishore National Congress',           party: 'KNC',    symbol: '✋' }
  ],
  tally: {},                             // candidateId -> count (anonymous)
  voted: []                              // hashed EPIC numbers (who voted, never what)
});

function load() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
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
  if (arr.length >= 10) return res.status(429).json({ error: 'Too many attempts. Try again in 5 minutes.' });
  arr.push(now); hits.set(k, arr); next();
};

const voteTokens = new Map();   // token -> { epicHash, exp }
const adminTokens = new Map();  // token -> exp

function requireAdmin(req, res, next) {
  const t = req.get('x-admin-token');
  const exp = adminTokens.get(t);
  if (!exp || exp < Date.now()) return res.status(401).json({ error: 'Officer login required.' });
  next();
}

/* ---------- app ---------- */
const app = express();
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ----- public ----- */
app.get('/api/status', (req, res) => {
  res.json({ status: db.status, options: options() });
});

app.post('/api/verify', limit('verify'), (req, res) => {
  const name = String(req.body.name || '').trim();
  const dob = String(req.body.dob || '');
  const epic = String(req.body.epic || '').trim().toUpperCase();

  if (db.status === 'not_started') return res.status(400).json({ error: 'Polling has not started yet.' });
  if (db.status === 'closed')      return res.status(400).json({ error: 'Polling is closed.' });
  if (name.length < 3)             return res.status(400).json({ error: 'Enter your full name.' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob) || isNaN(new Date(dob)) || new Date(dob) > new Date())
    return res.status(400).json({ error: 'Enter a valid date of birth.' });
  if (ageOn(dob) < 18)             return res.status(400).json({ error: 'You must be 18 or older to vote.' });
  if (!/^[A-Z]{3}[0-9]{7}$/.test(epic)) return res.status(400).json({ error: 'EPIC must be 3 letters followed by 7 digits.' });

  const epicHash = hashEpic(epic);
  if (db.voted.includes(epicHash)) return res.status(409).json({ error: 'This EPIC number has already voted.' });

  const token = newToken();
  voteTokens.set(token, { epicHash, exp: Date.now() + 5 * 60 * 1000 });   // 5 min, single use
  res.json({ token });
});

app.post('/api/vote', (req, res) => {
  const { token, candidateId } = req.body || {};
  const sess = voteTokens.get(token);
  voteTokens.delete(token);                                   // single use
  if (!sess || sess.exp < Date.now()) return res.status(401).json({ error: 'Session expired. Verify again.' });
  if (db.status !== 'open')           return res.status(400).json({ error: 'Polling is not open.' });
  if (db.voted.includes(sess.epicHash)) return res.status(409).json({ error: 'Already voted.' });
  if (!options().some(o => o.id === candidateId)) return res.status(400).json({ error: 'Invalid choice.' });

  db.voted.push(sess.epicHash);
  db.tally[candidateId] = (db.tally[candidateId] || 0) + 1;
  save();
  res.json({ ok: true });
});

app.get('/api/results', (req, res) => {
  if (db.status !== 'closed') return res.status(403).json({ error: 'Results are shown only after polling closes.' });
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
  if (!ok) return res.status(401).json({ error: 'Wrong PIN.' });
  const t = newToken();
  adminTokens.set(t, Date.now() + 2 * 60 * 60 * 1000);
  res.json({ token: t });
});

app.get('/api/admin/summary', requireAdmin, (req, res) => {
  res.json({ status: db.status, candidates: db.candidates, totalVotes: db.voted.length });
});

app.post('/api/admin/start', requireAdmin, (req, res) => {
  if (db.status !== 'not_started') return res.status(400).json({ error: 'Polling already started.' });
  if (db.candidates.length < 2)    return res.status(400).json({ error: 'Add at least 2 candidates.' });
  db.status = 'open'; save(); res.json({ ok: true });
});

app.post('/api/admin/close', requireAdmin, (req, res) => {
  if (db.status !== 'open') return res.status(400).json({ error: 'Polling is not open.' });
  db.status = 'closed'; save(); res.json({ ok: true });
});

app.post('/api/admin/candidates', requireAdmin, (req, res) => {
  if (db.status !== 'not_started') return res.status(400).json({ error: 'Candidate list is locked.' });
  const name = String(req.body.name || '').trim().slice(0, 60);
  const party = String(req.body.party || '').trim().slice(0, 40);
  const symbol = String(req.body.symbol || '').trim().slice(0, 4);
  if (!name || !party || !symbol) return res.status(400).json({ error: 'Fill all fields.' });
  if (db.candidates.length >= 15)  return res.status(400).json({ error: 'Maximum 15 candidates (EVM limit).' });
  if (db.candidates.some(c => c.symbol === symbol)) return res.status(400).json({ error: 'Symbol already taken.' });
  db.candidates.push({ id: 'c' + Date.now(), name, party, symbol });
  save(); res.json({ ok: true });
});

app.delete('/api/admin/candidates/:id', requireAdmin, (req, res) => {
  if (db.status !== 'not_started') return res.status(400).json({ error: 'Candidate list is locked.' });
  db.candidates = db.candidates.filter(c => c.id !== req.params.id);
  save(); res.json({ ok: true });
});

app.post('/api/admin/reset', requireAdmin, (req, res) => {
  db = defaults(); voteTokens.clear(); save(); res.json({ ok: true });
});

app.listen(PORT, () => console.log(`The-Republic running at http://localhost:${PORT}`));
