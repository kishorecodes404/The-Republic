const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ADMIN_PIN = process.env.ADMIN_PIN || '1234';          // change in production
const SALT = process.env.EPIC_SALT || 'the-republic-salt';
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'election.json');
const OTP_TTL = 5 * 60 * 1000;          // OTP valid for 5 minutes
const OTP_MAX_TRIES = 3;                // wrong attempts before lockout
const LOCK_MS = 15 * 60 * 1000;         // lockout length after too many wrong OTPs
const RESEND_GAP = 30 * 1000;           // minimum gap between OTP sends
const MAX_RESENDS = 3;                  // resends allowed per verification
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
  receipts: [],                          // random reference numbers (not linked to voter or choice)
  roll: []                               // electoral roll: { epicHash, name (normalised), dob, email }
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

// electoral roll helpers
const normName = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{M}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
function normDob(s) {                                   // accepts YYYY-MM-DD or DD-MM-YYYY / DD/MM/YYYY
  s = String(s || '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/), y, mo, d;
  if (m) [, y, mo, d] = m;
  else if ((m = s.match(/^(\d{2})[-\/](\d{2})[-\/](\d{4})$/))) [, d, mo, y] = m;
  else return null;
  const iso = `${y}-${mo}-${d}`, dt = new Date(iso);
  if (isNaN(dt) || dt.toISOString().slice(0, 10) !== iso || dt > new Date()) return null;
  return iso;
}
function makeRollEntry(name, dob, epic, email, needEmail = false) {   // returns { entry } or { code, error }
  const n = normName(name), e = String(epic || '').trim().toUpperCase(), d = normDob(dob);
  const em = String(email || '').trim().toLowerCase();
  if (n.length < 3)                return { code: 'name', error: 'Enter your full name.' };
  if (!d)                          return { code: 'dob',  error: 'Enter a valid date of birth.' };
  if (!/^[A-Z]{3}[0-9]{7}$/.test(e)) return { code: 'epic', error: 'EPIC must be 3 letters followed by 7 digits.' };
  if (needEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) return { code: 'email', error: 'Enter a valid email address.' };
  return { entry: { epicHash: hashEpic(e), name: n, dob: d, email: em } };
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

/* ---------- OTP ---------- */
const otpSessions = new Map();  // sid -> { epicHash, email, otpHash, exp, tries, sentAt, resends }
const lockouts = new Map();     // epicHash -> lockout end (ms)
const makeOtp = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');
const hashOtp = (sid, otp) => crypto.createHash('sha256').update(SALT + sid + otp).digest('hex');
const maskEmail = e => {
  const [u, d] = e.split('@');
  return (u.length <= 2 ? u[0] + '*' : u[0] + '*'.repeat(u.length - 2) + u.slice(-1)) + '@' + d;
};

// Real email if SMTP_* env vars are set and nodemailer is installed (npm i nodemailer);
// otherwise demo mode: the OTP is printed in this server console (never sent to the browser).
let mailer = null;
if (process.env.SMTP_HOST) {
  try {
    const port = Number(process.env.SMTP_PORT || 587);
    mailer = require('nodemailer').createTransport({
      host: process.env.SMTP_HOST, port, secure: port === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
    });
  } catch { console.warn('[OTP] SMTP_HOST is set but nodemailer is missing. Run: npm i nodemailer. Using console mode.'); }
}
async function sendOtp(email, otp) {
  if (mailer) {
    await mailer.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER, to: email,
      subject: 'Government of Kishore: your voting OTP',
      text: `Your one-time password is ${otp}. It is valid for 5 minutes. Do not share it with anyone.`
    });
  } else {
    console.log(`[OTP console mode] ${email} -> ${otp}`);
  }
}
setInterval(() => {                                   // clear stale sessions and lockouts
  const now = Date.now();
  for (const [k, s] of otpSessions) if (s.exp < now - 10 * 60 * 1000) otpSessions.delete(k);
  for (const [k, until] of lockouts) if (until < now) lockouts.delete(k);
}, 60 * 1000);

function requireAdmin(req, res, next) {
  const t = req.get('x-admin-token');
  const exp = adminTokens.get(t);
  if (!exp || exp < Date.now()) return fail(res, 401, 'login_required', 'Officer login required.');
  tick(); next();
}

/* ---------- app ---------- */
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ----- public ----- */
app.get('/api/status', (req, res) => {
  tick();
  res.json({ status: db.status, options: options(), closesAt: db.status === 'open' ? db.closesAt : null, serverTime: Date.now() });
});

app.post('/api/verify', limit('verify'), async (req, res) => {
  tick();
  if (db.status === 'not_started') return fail(res, 400, 'not_started', 'Polling has not started yet.');
  if (db.status === 'closed')      return fail(res, 400, 'closed', 'Polling is closed.');

  const made = makeRollEntry(req.body.name, req.body.dob, req.body.epic);
  if (!made.entry) return fail(res, 400, made.code, made.error);
  const { epicHash, name, dob } = made.entry;

  // must match the electoral roll exactly (EPIC + name + date of birth)
  const onRoll = db.roll.find(v => v.epicHash === epicHash);
  if (!onRoll || onRoll.name !== name || onRoll.dob !== dob)
    return fail(res, 400, 'mismatch', 'Your details do not match the electoral roll.');
  if (ageOn(onRoll.dob) < 18)      return fail(res, 400, 'age', 'You must be 18 or older to vote.');
  if (db.voted.includes(epicHash)) return fail(res, 409, 'voted', 'This EPIC number has already voted.');

  if ((lockouts.get(epicHash) || 0) > Date.now())
    return fail(res, 429, 'otp_locked', 'Too many wrong OTP attempts. Try again later.');
  if (!onRoll.email) return fail(res, 400, 'no_contact', 'No email is registered for this voter. Contact the election officer.');

  // second factor: one-time password sent to the email registered on the roll
  for (const [k, s] of otpSessions) if (s.epicHash === epicHash) otpSessions.delete(k);   // one live session per voter
  const sid = newToken(), otp = makeOtp();
  try { await sendOtp(onRoll.email, otp); }
  catch (e) { console.error('[OTP] send failed:', e.message); return fail(res, 502, 'send_failed', 'Could not send the OTP. Try again.'); }
  otpSessions.set(sid, { epicHash, email: onRoll.email, otpHash: hashOtp(sid, otp), exp: Date.now() + OTP_TTL, tries: 0, sentAt: Date.now(), resends: 0 });
  res.json({ otpRequired: true, sid, email: maskEmail(onRoll.email), resendIn: RESEND_GAP / 1000 });
});

app.post('/api/verify/otp', limit('otp'), (req, res) => {
  tick();
  if (db.status === 'not_started') return fail(res, 400, 'not_started', 'Polling has not started yet.');
  if (db.status === 'closed')      return fail(res, 400, 'closed', 'Polling is closed.');
  const { sid, otp } = req.body || {};
  const s = otpSessions.get(sid);
  if (!s) return fail(res, 401, 'session', 'Session expired. Verify again.');
  if ((lockouts.get(s.epicHash) || 0) > Date.now()) { otpSessions.delete(sid); return fail(res, 429, 'otp_locked', 'Too many wrong OTP attempts. Try again later.'); }
  if (db.voted.includes(s.epicHash)) { otpSessions.delete(sid); return fail(res, 409, 'voted', 'This EPIC number has already voted.'); }
  if (s.exp < Date.now()) return fail(res, 400, 'otp_expired', 'OTP expired. Request a new one.');

  const given = Buffer.from(hashOtp(sid, String(otp || '').trim()));
  const ok = crypto.timingSafeEqual(given, Buffer.from(s.otpHash));
  if (!ok) {
    s.tries++;
    if (s.tries >= OTP_MAX_TRIES) {
      otpSessions.delete(sid);
      lockouts.set(s.epicHash, Date.now() + LOCK_MS);
      return fail(res, 429, 'otp_locked', 'Too many wrong OTP attempts. Try again later.');
    }
    return res.status(400).json({ error: 'Incorrect OTP.', code: 'otp_invalid', left: OTP_MAX_TRIES - s.tries });
  }
  otpSessions.delete(sid);                                     // single use
  const token = newToken();
  voteTokens.set(token, { epicHash: s.epicHash, exp: Date.now() + 5 * 60 * 1000 });   // 5 min, single use
  res.json({ token });
});

app.post('/api/verify/resend', limit('otp'), async (req, res) => {
  tick();
  if (db.status !== 'open') return fail(res, 400, 'not_open', 'Polling is not open.');
  const s = otpSessions.get((req.body || {}).sid);
  if (!s) return fail(res, 401, 'session', 'Session expired. Verify again.');
  if (Date.now() - s.sentAt < RESEND_GAP) return fail(res, 429, 'otp_wait', 'Please wait before requesting another OTP.');
  if (s.resends >= MAX_RESENDS) return fail(res, 429, 'otp_limit', 'Resend limit reached. Verify again later.');
  const sid = req.body.sid, otp = makeOtp();
  try { await sendOtp(s.email, otp); }
  catch (e) { console.error('[OTP] send failed:', e.message); return fail(res, 502, 'send_failed', 'Could not send the OTP. Try again.'); }
  s.otpHash = hashOtp(sid, otp); s.exp = Date.now() + OTP_TTL; s.sentAt = Date.now(); s.resends++;   // tries are NOT reset
  res.json({ ok: true, resendIn: RESEND_GAP / 1000 });
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
  res.json({ status: db.status, candidates: db.candidates, totalVotes: db.voted.length, rollCount: db.roll.length });
});

app.post('/api/admin/start', requireAdmin, (req, res) => {
  if (db.status !== 'not_started') return fail(res, 400, 'already_started', 'Polling already started.');
  if (db.candidates.length < 2)    return fail(res, 400, 'min2', 'Add at least 2 candidates.');
  if (db.roll.length < 1)          return fail(res, 400, 'roll_empty', 'Add voters to the electoral roll first.');
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

app.post('/api/admin/voters', requireAdmin, (req, res) => {
  if (db.status !== 'not_started') return fail(res, 400, 'roll_locked', 'Electoral roll is locked.');
  const made = makeRollEntry(req.body.name, req.body.dob, req.body.epic, req.body.email, true);
  if (!made.entry) return fail(res, 400, made.code, made.error);
  if (db.roll.some(v => v.epicHash === made.entry.epicHash)) return fail(res, 400, 'dup_epic', 'This EPIC is already on the roll.');
  db.roll.push(made.entry); save();
  res.json({ ok: true, rollCount: db.roll.length });
});

app.post('/api/admin/voters/bulk', requireAdmin, (req, res) => {
  if (db.status !== 'not_started') return fail(res, 400, 'roll_locked', 'Electoral roll is locked.');
  const lines = String(req.body.csv || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean).slice(0, 5000);
  if (!lines.length) return fail(res, 400, 'csv', 'Choose a valid CSV file.');
  if (/^"?name"?\s*,/i.test(lines[0])) lines.shift();                  // skip header row
  let added = 0, skipped = 0;
  for (const line of lines) {
    const c = line.split(',').map(x => x.trim().replace(/^"|"$/g, ''));
    const made = c.length >= 4 ? makeRollEntry(c[0], c[1], c[2], c[3], true) : {};   // name,dob,epic,email
    if (!made.entry || db.roll.some(v => v.epicHash === made.entry.epicHash)) { skipped++; continue; }
    db.roll.push(made.entry); added++;
  }
  save();
  res.json({ ok: true, added, skipped, rollCount: db.roll.length });
});

app.delete('/api/admin/voters', requireAdmin, (req, res) => {
  if (db.status !== 'not_started') return fail(res, 400, 'roll_locked', 'Electoral roll is locked.');
  db.roll = []; save(); res.json({ ok: true });
});

app.post('/api/admin/reset', requireAdmin, (req, res) => {
  db = defaults(); voteTokens.clear(); otpSessions.clear(); lockouts.clear(); save(); res.json({ ok: true });
});

app.listen(PORT, () => console.log(`The-Republic running at http://localhost:${PORT}`));
