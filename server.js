
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const PUB = path.join(__dirname, 'public');
const db = new DatabaseSync(path.join(__dirname, 'mare.db'));

db.exec(`
PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, pass_hash TEXT NOT NULL,
  qr_code TEXT NOT NULL UNIQUE, points INTEGER NOT NULL DEFAULT 0 CHECK(points >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')));
CREATE TABLE IF NOT EXISTS sessions(
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS qr_codes(
  id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, points INTEGER NOT NULL CHECK(points > 0), label TEXT,
  max_uses INTEGER, uses INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')));
CREATE TABLE IF NOT EXISTS scans(  -- impede o mesmo usuário de usar o mesmo QR duas vezes
  user_id INTEGER NOT NULL REFERENCES users(id), qr_id INTEGER NOT NULL REFERENCES qr_codes(id), PRIMARY KEY(user_id, qr_id));
CREATE TABLE IF NOT EXISTS transactions(
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), type TEXT NOT NULL, points INTEGER NOT NULL,
  description TEXT, balance_after INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')));
CREATE TABLE IF NOT EXISTS rewards(
  id TEXT PRIMARY KEY, name TEXT, description TEXT, points_required INTEGER, image TEXT, stock INTEGER, active INTEGER DEFAULT 1);
`);
if (!db.prepare('SELECT 1 FROM rewards').get()) {
  const ins = db.prepare('INSERT INTO rewards VALUES(?,?,?,?,?,?,1)');
  ins.run('r1', 'Desconto de R$10', 'Vale-desconto para usar em qualquer compra na loja.', 500, '🏖️', 40);
  ins.run('r2', 'Produto especial', 'Item exclusivo da coleção verão do clube Maré.', 1000, '🌊', 18);
  ins.run('r3', 'Desconto de R$25', 'Vale-desconto de maior valor para grandes compras.', 2000, '☀️', 25);
  ins.run('r4', 'Recompensa Premium', 'Kit premium da loja — edição limitada de verão.', 5000, '🏄', 6);
}

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

const sha = t => crypto.createHash('sha256').update(t).digest('hex');
const hashPw = pw => { const s = crypto.randomBytes(16); return s.toString('hex') + ':' + crypto.scryptSync(pw, s, 64).toString('hex'); };
const checkPw = (pw, stored) => {
  const [s, h] = stored.split(':');
  return crypto.timingSafeEqual(crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64), Buffer.from(h, 'hex'));
};
function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex'), maxAge = 30 * 86400;
  db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(sha(token), userId, Date.now() + maxAge * 1000);
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}` + (process.env.NODE_ENV === 'production' ? '; Secure' : ''));
}
function currentUser(req) {
  const m = /(?:^|; )sid=([a-f0-9]{64})/.exec(req.headers.cookie || '');
  if (!m) return null;
  return db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?').get(sha(m[1]), Date.now()) || null;
}
function requireUser(req) { const u = currentUser(req); if (!u) throw new HttpError(401, 'Faça login para continuar'); return u; }

const fails = new Map(); // limite simples de tentativas de login: 8 erros / 15 min por IP+e-mail
const blocked = k => { const f = fails.get(k); return f && f.n >= 8 && Date.now() - f.t < 15 * 60e3; };
const registerFail = k => { const f = fails.get(k); fails.set(k, f && Date.now() - f.t < 15 * 60e3 ? { n: f.n + 1, t: f.t } : { n: 1, t: Date.now() }); };

function inTransaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
function addTransaction(userId, type, points, description) {
  db.prepare('UPDATE users SET points = points + ? WHERE id = ?').run(points, userId);
  const bal = db.prepare('SELECT points FROM users WHERE id = ?').get(userId).points;
  db.prepare('INSERT INTO transactions(user_id,type,points,description,balance_after) VALUES(?,?,?,?,?)').run(userId, type, points, description, bal);
}

function mePayload(userId) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const tx = db.prepare('SELECT id, type, points, description, created_at AS createdAt, balance_after AS balanceAfter FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 200').all(userId);
  const rewards = db.prepare('SELECT id, name, description, points_required AS pointsRequired, image, stock, active FROM rewards').all();
  return {
    user: { id: String(u.id), name: u.name, email: u.email, qrCode: u.qr_code, points: u.points, createdAt: u.created_at },
    transactions: tx.map(t => ({ ...t, id: 't' + t.id, userId: String(u.id) })),
    rewards: rewards.map(r => ({ ...r, active: !!r.active })),
  };
}

const routes = {
  'POST /api/register'({ res, body }) {
    const name = String(body.name || '').trim().slice(0, 80), email = String(body.email || '').trim().toLowerCase(), pw = String(body.password || '');
    if (name.length < 2) throw new HttpError(400, 'Informe seu nome');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'E-mail inválido');
    if (pw.length < 8) throw new HttpError(400, 'A senha precisa ter pelo menos 8 caracteres');
    let id;
    try {
      let qr; do { qr = 'CLIENTE-' + crypto.randomInt(100000, 999999); } while (db.prepare('SELECT 1 FROM users WHERE qr_code = ?').get(qr));
      id = Number(db.prepare('INSERT INTO users(name,email,pass_hash,qr_code) VALUES(?,?,?,?)').run(name, email, hashPw(pw), qr).lastInsertRowid); // pontos começam em 0
    } catch (e) {
      if (/UNIQUE/.test(String(e.message))) throw new HttpError(409, 'Este e-mail já está cadastrado');
      throw e;
    }
    startSession(res, id);
    return mePayload(id);
  },
  'POST /api/login'({ req, res, body }) {
    const email = String(body.email || '').trim().toLowerCase(), key = req.socket.remoteAddress + '|' + email;
    if (blocked(key)) throw new HttpError(429, 'Muitas tentativas. Tente de novo em alguns minutos');
    const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!u || !checkPw(String(body.password || ''), u.pass_hash)) { registerFail(key); throw new HttpError(401, 'E-mail ou senha inválidos'); }
    fails.delete(key);
    startSession(res, u.id);
    return mePayload(u.id);
  },
  'POST /api/logout'({ req, res }) {
    const m = /(?:^|; )sid=([a-f0-9]{64})/.exec(req.headers.cookie || '');
    if (m) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(m[1]));
    res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    return { ok: true };
  },
  'GET /api/me'({ req }) { return mePayload(requireUser(req).id); },

  'POST /api/scan'({ req, body }) {
    const u = requireUser(req), code = String(body.code || '').trim().toUpperCase();
    const earned = inTransaction(() => {
      const q = db.prepare('SELECT * FROM qr_codes WHERE code = ?').get(code);
      if (!q) throw new HttpError(404, 'QR Code inválido');
      if (q.max_uses != null && q.uses >= q.max_uses) throw new HttpError(410, 'Este QR Code já atingiu o limite de usos');
      try { db.prepare('INSERT INTO scans VALUES(?,?)').run(u.id, q.id); }
      catch { throw new HttpError(409, 'Você já usou este QR Code'); }
      db.prepare('UPDATE qr_codes SET uses = uses + 1 WHERE id = ?').run(q.id);
      addTransaction(u.id, 'compra', q.points, q.label || 'QR Code escaneado');
      return q.points;
    });
    return { earned, ...mePayload(u.id) };
  },
  'POST /api/redeem'({ req, body }) {
    const u = requireUser(req);
    inTransaction(() => {
      const r = db.prepare('SELECT * FROM rewards WHERE id = ? AND active = 1').get(String(body.rewardId || ''));
      if (!r) throw new HttpError(404, 'Recompensa não encontrada');
      if (r.stock <= 0) throw new HttpError(409, 'Recompensa esgotada');
      if (db.prepare('SELECT points FROM users WHERE id = ?').get(u.id).points < r.points_required) throw new HttpError(400, 'Pontos insuficientes');
      addTransaction(u.id, 'resgate', -r.points_required, 'Resgate: ' + r.name);
      db.prepare('UPDATE rewards SET stock = stock - 1 WHERE id = ?').run(r.id);
    });
    return mePayload(u.id);
  },

  'POST /api/admin/codes'({ req, body }) {
    const sent = Buffer.from(String(req.headers['x-admin-key'] || '')), real = Buffer.from(ADMIN_KEY);
    if (!ADMIN_KEY || sent.length !== real.length || !crypto.timingSafeEqual(sent, real)) throw new HttpError(403, 'Chave de administrador inválida');
    const points = Math.floor(Number(body.points)), maxUses = body.maxUses ? Math.floor(Number(body.maxUses)) : null;
    if (!(points > 0 && points <= 100000)) throw new HttpError(400, 'Pontos inválidos');
    if (maxUses !== null && !(maxUses > 0)) throw new HttpError(400, 'Limite de usos inválido');
    const code = 'PTS-' + crypto.randomBytes(6).toString('hex').toUpperCase();
    db.prepare('INSERT INTO qr_codes(code,points,label,max_uses) VALUES(?,?,?,?)').run(code, points, String(body.label || '').slice(0, 80) || null, maxUses);
    return { code, points, maxUses };
  },
};

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(data));
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return resolve({});
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 10_000) { reject(new HttpError(413, 'Requisição grande demais')); req.destroy(); } });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new HttpError(400, 'JSON inválido')); } });
  });
}
function serveStatic(res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  const file = path.join(PUB, decodeURIComponent(pathname));
  if (!file.startsWith(PUB + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end('Não encontrado'); }
  const headers = { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' };
  if (file === path.join(PUB, 'index.html')) { // o index.html original NÃO é alterado: a ligação é inserida ao enviar a página
    res.writeHead(200, headers);
    return res.end(fs.readFileSync(file, 'utf8').replace('</body>', '<script src="/backend.js"></script>\n</body>'));
  }
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}

http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (!pathname.startsWith('/api/')) return serveStatic(res, pathname);
    const handler = routes[req.method + ' ' + pathname];
    if (!handler) throw new HttpError(404, 'Rota não encontrada');
    const body = req.method === 'POST' ? await readJson(req) : {};
    send(res, 200, handler({ req, res, body }));
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) send(res, status, { error: status === 500 ? 'Erro interno do servidor' : e.message });
  }
}).listen(PORT, () => console.log(`Maré rodando em http://localhost:${PORT}` + (ADMIN_KEY ? '' : '  (defina ADMIN_KEY para criar QR Codes)')));
