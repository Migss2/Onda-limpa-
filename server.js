// Maré · servidor com banco de dados SQLite (sem dependências; requer Node 22.13+)
// Rodar:  ADMIN_KEY=uma-senha-forte node server.js
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const PUB = path.join(__dirname, 'public');
// Em hospedagem, aponte DB_PATH para o disco permanente (ex.: /data/mare.db). Local: usa mare.db ao lado do server.js
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'mare.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
// Atrás do proxy da hospedagem, o IP real do cliente vem no cabeçalho X-Forwarded-For (ative com TRUST_PROXY=1)
const clientIp = req => (process.env.TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress;

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

/* ---------- backup automático ----------
   Faz uma cópia completa e consistente do banco ao ligar e a cada 6 horas, na pasta "backups"
   (um arquivo por dia: mare-AAAA-MM-DD.db; guarda os 14 mais recentes). */
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(path.dirname(DB_PATH), 'backups');
function backupNow() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const file = path.join(BACKUP_DIR, `mare-${new Date().toISOString().slice(0, 10)}.db`), tmp = file + '.tmp';
  fs.rmSync(tmp, { force: true });
  db.prepare('VACUUM INTO ?').run(tmp);
  fs.renameSync(tmp, file);
  const all = fs.readdirSync(BACKUP_DIR).filter(f => /^mare-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
  all.slice(0, Math.max(0, all.length - 14)).forEach(f => fs.rmSync(path.join(BACKUP_DIR, f)));
}
const tryBackup = () => { try { backupNow(); } catch (e) { console.error('Backup falhou:', e.message); } };
tryBackup();
setInterval(tryBackup, 6 * 3600e3).unref();

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

/* ---------- segurança: senha, sessão, limite de tentativas ---------- */
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

/* ---------- administrador (chave ADMIN_KEY): cookie assinado ou cabeçalho x-admin-key ---------- */
const safeEq = (a, b) => { a = Buffer.from(String(a)); b = Buffer.from(String(b)); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const adminSig = exp => crypto.createHmac('sha256', ADMIN_KEY).update('admin:' + exp).digest('hex');
const secureFlag = process.env.NODE_ENV === 'production' ? '; Secure' : '';
function requireAdmin(req) {
  if (!ADMIN_KEY) throw new HttpError(403, 'Defina ADMIN_KEY ao ligar o servidor para usar o painel');
  if (safeEq(req.headers['x-admin-key'] || '', ADMIN_KEY)) return;
  const m = /(?:^|; )aid=(\d+)\.([a-f0-9]{64})/.exec(req.headers.cookie || '');
  if (m && Number(m[1]) > Date.now() && safeEq(m[2], adminSig(m[1]))) return;
  throw new HttpError(403, 'Acesso de administrador necessário');
}

const fails = new Map(); // limite simples de tentativas de login: 8 erros / 15 min por IP+e-mail
const blocked = k => { const f = fails.get(k); return f && f.n >= 8 && Date.now() - f.t < 15 * 60e3; };
const registerFail = k => { const f = fails.get(k); fails.set(k, f && Date.now() - f.t < 15 * 60e3 ? { n: f.n + 1, t: f.t } : { n: 1, t: Date.now() }); };

/* ---------- pontos (sempre dentro de transação) ---------- */
function inTransaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
function addTransaction(userId, type, points, description) {
  db.prepare('UPDATE users SET points = points + ? WHERE id = ?').run(points, userId);
  const bal = db.prepare('SELECT points FROM users WHERE id = ?').get(userId).points;
  db.prepare('INSERT INTO transactions(user_id,type,points,description,balance_after) VALUES(?,?,?,?,?)').run(userId, type, points, description, bal);
}

/* ---------- formato enviado ao site ---------- */
function redeemFor(userId, rewardId) {
  inTransaction(() => {
    const u = db.prepare('SELECT points FROM users WHERE id = ?').get(userId);
    if (!u) throw new HttpError(404, 'Cliente não encontrado');
    const r = db.prepare('SELECT * FROM rewards WHERE id = ? AND active = 1').get(rewardId);
    if (!r) throw new HttpError(404, 'Recompensa não encontrada');
    if (r.stock <= 0) throw new HttpError(409, 'Recompensa esgotada');
    if (u.points < r.points_required) throw new HttpError(400, 'Pontos insuficientes');
    addTransaction(userId, 'resgate', -r.points_required, 'Resgate: ' + r.name);
    db.prepare('UPDATE rewards SET stock = stock - 1 WHERE id = ?').run(r.id);
  });
}
const rewardsList = () => db.prepare('SELECT id, name, description, points_required AS pointsRequired, image, stock, active FROM rewards').all().map(r => ({ ...r, active: !!r.active }));

function mePayload(userId) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const tx = db.prepare('SELECT id, type, points, description, created_at AS createdAt, balance_after AS balanceAfter FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 200').all(userId);
  const rewards = rewardsList();
  return {
    user: { id: String(u.id), name: u.name, email: u.email, qrCode: u.qr_code, points: u.points, createdAt: u.created_at },
    transactions: tx.map(t => ({ ...t, id: 't' + t.id, userId: String(u.id) })),
    rewards,
  };
}

/* ---------- rotas da API ---------- */
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
    const email = String(body.email || '').trim().toLowerCase(), key = clientIp(req) + '|' + email;
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

  // O usuário escaneou um QR Code de pontos
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
    redeemFor(u.id, String(body.rewardId || ''));
    return mePayload(u.id);
  },

  // Números públicos da página inicial e catálogo da loja de pontos
  'GET /api/stats'() {
    return {
      clients: db.prepare('SELECT COUNT(*) n FROM users').get().n,
      points: db.prepare('SELECT COALESCE(SUM(points), 0) n FROM users').get().n,
      rewards: db.prepare('SELECT COUNT(*) n FROM rewards WHERE active = 1').get().n,
      rewardsList: rewardsList().filter(r => r.active),
    };
  },

  // Painel do lojista
  'POST /api/admin/login'({ req, res, body }) {
    if (!ADMIN_KEY) throw new HttpError(403, 'Defina ADMIN_KEY ao ligar o servidor');
    const k = clientIp(req) + '|admin';
    if (blocked(k)) throw new HttpError(429, 'Muitas tentativas. Tente de novo em alguns minutos');
    if (!safeEq(body.key || '', ADMIN_KEY)) { registerFail(k); throw new HttpError(401, 'Chave de administrador inválida'); }
    fails.delete(k);
    const exp = Date.now() + 12 * 3600e3;
    res.setHeader('Set-Cookie', `aid=${exp}.${adminSig(exp)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200` + secureFlag);
    return { ok: true };
  },
  'POST /api/admin/logout'({ res }) {
    res.setHeader('Set-Cookie', 'aid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    return { ok: true };
  },
  'GET /api/admin/data'({ req }) {
    requireAdmin(req);
    const users = db.prepare('SELECT id, name, email, qr_code AS qrCode, points, created_at AS createdAt FROM users ORDER BY id').all().map(u => ({ ...u, id: String(u.id) }));
    const transactions = db.prepare('SELECT id, user_id AS userId, type, points, description, balance_after AS balanceAfter, created_at AS createdAt FROM transactions ORDER BY id DESC LIMIT 500')
      .all().map(t => ({ ...t, id: 't' + t.id, userId: String(t.userId) }));
    const redemptions = transactions.filter(t => t.type === 'resgate').map(t => ({ id: 'd' + t.id, userId: t.userId, points: -t.points, createdAt: t.createdAt, status: 'concluído' }));
    return { users, transactions, redemptions, rewards: rewardsList() };
  },
  'POST /api/admin/adjust'({ req, body }) {   // points > 0 adiciona; points < 0 remove (nunca deixa o saldo negativo)
    requireAdmin(req);
    const id = Number(body.userId), pts = Math.trunc(Number(body.points)), desc = String(body.description || '').slice(0, 120);
    if (!Number.isInteger(id) || !pts || Math.abs(pts) > 100000) throw new HttpError(400, 'Dados inválidos');
    inTransaction(() => {
      const u = db.prepare('SELECT points FROM users WHERE id = ?').get(id);
      if (!u) throw new HttpError(404, 'Cliente não encontrado');
      const delta = pts < 0 ? -Math.min(-pts, u.points) : pts;
      if (delta !== 0) addTransaction(id, delta > 0 ? 'compra' : 'ajuste', delta, desc || (delta > 0 ? 'Pontos adicionados pela loja' : 'Ajuste de pontos'));
    });
    return { ok: true };
  },
  'POST /api/admin/redeem'({ req, body }) {
    requireAdmin(req);
    redeemFor(Number(body.userId), String(body.rewardId || ''));
    return { ok: true };
  },

  // Lojista cria um QR de pontos (protegido por ADMIN_KEY)
  'POST /api/admin/codes'({ req, body }) {
    requireAdmin(req);
    const points = Math.floor(Number(body.points)), maxUses = body.maxUses ? Math.floor(Number(body.maxUses)) : null;
    if (!(points > 0 && points <= 100000)) throw new HttpError(400, 'Pontos inválidos');
    if (maxUses !== null && !(maxUses > 0)) throw new HttpError(400, 'Limite de usos inválido');
    const code = 'PTS-' + crypto.randomBytes(6).toString('hex').toUpperCase();
    db.prepare('INSERT INTO qr_codes(code,points,label,max_uses) VALUES(?,?,?,?)').run(code, points, String(body.label || '').slice(0, 80) || null, maxUses);
    return { code, points, maxUses };
  },
};

/* ---------- servidor HTTP + arquivos estáticos (pasta public/) ---------- */
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