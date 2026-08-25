
let DB = {
  users: [
    { id: "102938", name: "João Silva",     email: "joao@exemplo.com",   password: "123456", qrCode: "CLIENTE-102938", points: 2450, createdAt: "2025-11-02" },
    { id: "204471", name: "Maria Santos",   email: "maria@exemplo.com",  password: "123456", qrCode: "CLIENTE-204471", points: 5200, createdAt: "2025-08-14" },
    { id: "309215", name: "Lucas Oliveira", email: "lucas@exemplo.com",  password: "123456", qrCode: "CLIENTE-309215", points: 850,  createdAt: "2026-01-20" },
  ],
  transactions: [
    { id: "t1", userId: "102938", type: "compra",   points: 250,  description: "Compra #1024", createdAt: "2026-08-02T10:15:00", balanceAfter: 1900 },
    { id: "t2", userId: "102938", type: "compra",   points: 100,  description: "Compra #1028", createdAt: "2026-08-09T16:40:00", balanceAfter: 2000 },
    { id: "t3", userId: "102938", type: "resgate",  points: -500, description: "Resgate: Recompensa Premium", createdAt: "2026-08-15T12:05:00", balanceAfter: 1500 },
    { id: "t4", userId: "102938", type: "compra",   points: 300,  description: "Compra #1042", createdAt: "2026-08-20T09:30:00", balanceAfter: 1800 },
    { id: "t5", userId: "102938", type: "compra",   points: 650,  description: "Compra #1050", createdAt: "2026-08-24T18:20:00", balanceAfter: 2450 },
    { id: "t6", userId: "204471", type: "compra",   points: 1200, description: "Compra #0998", createdAt: "2026-08-11T14:00:00", balanceAfter: 5200 },
    { id: "t7", userId: "309215", type: "compra",   points: 850,  description: "Compra #1061", createdAt: "2026-08-23T11:00:00", balanceAfter: 850 },
  ],
  rewards: [
    { id: "r1", name: "Desconto de R$10",     description: "Vale-desconto para usar em qualquer compra na loja.", pointsRequired: 500,  image: "🏖️", stock: 40, active: true },
    { id: "r2", name: "Produto especial",     description: "Item exclusivo da coleção verão do clube Maré.",       pointsRequired: 1000, image: "🌊", stock: 18, active: true },
    { id: "r3", name: "Desconto de R$25",     description: "Vale-desconto de maior valor para grandes compras.",   pointsRequired: 2000, image: "☀️", stock: 25, active: true },
    { id: "r4", name: "Recompensa Premium",   description: "Kit premium da loja — edição limitada de verão.",      pointsRequired: 5000, image: "🏄", stock: 6,  active: true },
  ],
  redemptions: [
    { id: "d1", userId: "102938", rewardId: "r4", points: 500, createdAt: "2026-08-15T12:05:00", status: "concluído" },
  ],
  admins: [
    { id: "a1", name: "Ana Marés", email: "admin@mare.com", password: "admin123", role: "Administrador" },
  ],
};

let nextTxId = DB.transactions.length + 1;
let nextRedId = DB.redemptions.length + 1;

/* ---------------------------------------------------------------
   SESSION STATE
   --------------------------------------------------------------- */
let session = { user: null, admin: null };
let route = "home";
let scannerState = { stream: null, rafId: null, foundUser: null };


function fmtPts(n){ return (n < 0 ? "-" : "+") + Math.abs(n).toLocaleString("pt-BR"); }
function fmtNum(n){ return n.toLocaleString("pt-BR"); }
function fmtDate(iso){
  const d = new Date(iso);
  return d.toLocaleDateString("pt-BR", { day:"2-digit", month:"short", year:"numeric" }) + " · " +
         d.toLocaleTimeString("pt-BR", { hour:"2-digit", minute:"2-digit" });
}
function initials(name){ return name.split(" ").map(p=>p[0]).slice(0,2).join("").toUpperCase(); }
function userTx(userId){ return DB.transactions.filter(t=>t.userId===userId).sort((a,b)=> new Date(b.createdAt)-new Date(a.createdAt)); }
function nextRewardFor(points){
  const opts = DB.rewards.filter(r=>r.active && r.pointsRequired > points).sort((a,b)=>a.pointsRequired-b.pointsRequired);
  return opts[0] || null;
}
function toast(msg){
  const region = document.getElementById("toast-region");
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = msg;
  region.appendChild(el);
  setTimeout(()=> el.remove(), 2800);
}
function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }


const api = {
  async addPoints(userId, points, description){
    
    const u = DB.users.find(u=>u.id===userId);
    u.points += points;
    DB.transactions.unshift({ id:"t"+(nextTxId++), userId, type:"compra", points, description, createdAt:new Date().toISOString(), balanceAfter:u.points });
    return u;
  },
  async removePoints(userId, points, description){
    const u = DB.users.find(u=>u.id===userId);
    u.points = Math.max(0, u.points - points);
    DB.transactions.unshift({ id:"t"+(nextTxId++), userId, type:"ajuste", points:-points, description, createdAt:new Date().toISOString(), balanceAfter:u.points });
    return u;
  },
  async redeemReward(userId, rewardId){
    const u = DB.users.find(u=>u.id===userId);
    const r = DB.rewards.find(r=>r.id===rewardId);
    if (!u || !r) throw new Error("Não encontrado");
    if (u.points < r.pointsRequired) throw new Error("Pontos insuficientes");
    u.points -= r.pointsRequired;
    DB.transactions.unshift({ id:"t"+(nextTxId++), userId, type:"resgate", points:-r.pointsRequired, description:"Resgate: "+r.name, createdAt:new Date().toISOString(), balanceAfter:u.points });
    DB.redemptions.unshift({ id:"d"+(nextRedId++), userId, rewardId, points:r.pointsRequired, createdAt:new Date().toISOString(), status:"concluído" });
    if (r.stock > 0) r.stock -= 1;
    return u;
  },
};


function navigate(r, params){
  route = r;
  window._routeParams = params || {};
  render();
  window.scrollTo({top:0, behavior:"instant"});
}
function requireClient(){ if(!session.user){ navigate("login"); return false; } return true; }
function requireAdmin(){ if(!session.admin){ navigate("admin-login"); return false; } return true; }

function renderNav(){
  const links = document.getElementById("publicNavLinks");
  const actions = document.getElementById("navActions");
  const inAdmin = route.startsWith("admin") && session.admin;
  const inClientApp = ["dashboard","history","rewards-app","account"].includes(route) && session.user;

  links.style.display = (inAdmin) ? "none" : "";
  document.querySelectorAll("#publicNavLinks a").forEach(a=>{
    a.classList.toggle("active", a.dataset.route===route);
  });

  if (inAdmin){
    actions.innerHTML = `
      <span class="small" style="margin-right:4px;">👋 ${escapeHtml(session.admin.name)}</span>
      <button class="btn btn-ghost btn-sm" onclick="logoutAdmin()">Sair</button>`;
  } else if (session.user){
    actions.innerHTML = `
      <button class="btn btn-ghost btn-sm" onclick="navigate('admin-login')">Sou lojista</button>
      <button class="btn btn-primary btn-sm" onclick="navigate('dashboard')">Ver meus pontos</button>`;
  } else {
    actions.innerHTML = `
      <button class="btn btn-ghost btn-sm" onclick="navigate('login')">Entrar</button>
      <button class="btn btn-primary btn-sm" onclick="navigate('login')">Ver meus pontos</button>`;
  }
}


function render(){
  const app = document.getElementById("app");
  renderNav();

  switch(route){
    case "home": app.innerHTML = pageHome(); break;
    case "how": app.innerHTML = pageHome(true); afterHome(); return;
    case "rewards-public": app.innerHTML = pageRewardsPublic(); break;
    case "login": app.innerHTML = pageLogin(); break;
    case "admin-login": app.innerHTML = pageAdminLogin(); break;

    case "dashboard": if(!requireClient())return; app.innerHTML = shellClient(pageDashboard()); break;
    case "history": if(!requireClient())return; app.innerHTML = shellClient(pageHistory()); break;
    case "rewards-app": if(!requireClient())return; app.innerHTML = shellClient(pageRewardsApp()); break;
    case "account": if(!requireClient())return; app.innerHTML = shellClient(pageAccount()); break;

    case "admin-dashboard": if(!requireAdmin())return; app.innerHTML = shellAdmin(pageAdminDashboard()); break;
    case "admin-clientes": if(!requireAdmin())return; app.innerHTML = shellAdmin(pageAdminClientes()); break;
    case "admin-scan": if(!requireAdmin())return; app.innerHTML = shellAdmin(pageAdminScan()); afterAdminScan(); return;
    case "admin-pontos": if(!requireAdmin())return; app.innerHTML = shellAdmin(pageAdminTransacoes()); break;
    case "admin-recompensas": if(!requireAdmin())return; app.innerHTML = shellAdmin(pageAdminRecompensas()); break;
    case "admin-config": if(!requireAdmin())return; app.innerHTML = shellAdmin(pageAdminConfig()); break;

    default: app.innerHTML = pageHome();
  }
  afterRenderCommon();
}

function afterRenderCommon(){
 
  if (route !== "admin-scan") stopScanner();
}


function waveSVG(fill, opacity){
  return `<svg viewBox="0 0 1200 120" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M0,40 C150,90 350,0 600,40 C850,80 1050,10 1200,40 L1200,120 L0,120 Z" fill="${fill}" opacity="${opacity||1}"></path>
  </svg>`;
}

function pageHome(){
  return `
  <section class="hero">
    <div class="container">
      <div class="hero-grid">
        <div>
          <span class="eyebrow">🐚 Clube de fidelidade Maré</span>
          <h1>Transforme suas compras em <span class="accent">recompensas</span>.</h1>
          <p class="lead">Acumule pontos, desbloqueie benefícios e aproveite cada momento — como um dia perfeito de praia.</p>
          <div class="hero-ctas">
            <button class="btn btn-primary" onclick="navigate('login')">Entrar na minha conta</button>
            <button class="btn btn-ghost" onclick="navigate('how')">Como funciona</button>
          </div>
          <div class="stat-mini-row" style="max-width:420px; margin-top:40px;">
            <div class="card stat-mini"><div class="n">3</div><div class="l">Clientes ativos</div></div>
            <div class="card stat-mini"><div class="n">${fmtNum(DB.users.reduce((s,u)=>s+u.points,0))}</div><div class="l">Pontos em circulação</div></div>
            <div class="card stat-mini"><div class="n">${DB.rewards.length}</div><div class="l">Recompensas</div></div>
          </div>
        </div>
        <div class="hero-visual">
          <div class="hero-orbit spin-slow" style="animation-duration:40s;"></div>
          <svg class="deco-sun float-slow" viewBox="0 0 64 64"><circle cx="32" cy="32" r="14" fill="#FFB703"/><g stroke="#FFB703" stroke-width="3" stroke-linecap="round">
            <line x1="32" y1="2" x2="32" y2="12"/><line x1="32" y1="52" x2="32" y2="62"/><line x1="2" y1="32" x2="12" y2="32"/><line x1="52" y1="32" x2="62" y2="32"/>
            <line x1="11" y1="11" x2="18" y2="18"/><line x1="46" y1="46" x2="53" y2="53"/><line x1="53" y1="11" x2="46" y2="18"/><line x1="18" y1="46" x2="11" y2="53"/>
          </g></svg>
          <svg class="deco-shell float-slow-2" viewBox="0 0 54 54"><path d="M27 4 C10 4 4 24 4 36 C4 46 14 50 27 50 C40 50 50 46 50 36 C50 24 44 4 27 4 Z" fill="#F6ECD6" stroke="#E9D6A8" stroke-width="2"/><path d="M27 10 L27 46 M17 16 L20 46 M37 16 L34 46" stroke="#E9D6A8" stroke-width="2" fill="none"/></svg>
          <div class="hero-scan-card">
            <span class="scan-pill"><span class="dot-live"></span> lendo QR code</span>
            <div class="qr-fake" style="margin-top:14px;"></div>
            <p style="font-weight:700; color:var(--ocean-deep); font-size:14px;">João Silva</p>
            <p class="mono small">+250 pontos adicionados</p>
          </div>
        </div>
      </div>
    </div>
    <div class="wave-wrap mt-30">${waveSVG("#F6ECD6",1)}</div>
  </section>

  <section style="background:var(--sand); padding-top:0;" id="how">
    <div class="container">
      <div class="section-head">
        <span class="eyebrow">🌴 Simples como um dia de verão</span>
        <h2 style="margin-top:14px;">Como o Maré funciona</h2>
        <p>Quatro passos entre a sua compra e sua próxima recompensa.</p>
      </div>
      <div class="steps-row">
        <div class="card step-card"><div class="step-num">01</div><div class="step-icon">🛍️</div><h3>Compre</h3><p>Faça uma compra na loja, do jeito que você já faz.</p></div>
        <div class="card step-card"><div class="step-num">02</div><div class="step-icon">📱</div><h3>Escaneie</h3><p>Apresente seu QR Code exclusivo no caixa.</p></div>
        <div class="card step-card"><div class="step-num">03</div><div class="step-icon">🌊</div><h3>Acumule</h3><p>Os pontos entram na sua conta automaticamente.</p></div>
        <div class="card step-card"><div class="step-num">04</div><div class="step-icon">🎁</div><h3>Resgate</h3><p>Troque pontos por produtos, descontos e benefícios.</p></div>
      </div>
      <div class="tide-line mt-30">${waveSVG("#00B4D8",0.18)}</div>
    </div>
  </section>

  <section>
    <div class="container">
      <div class="section-head">
        <span class="eyebrow">🏄 Loja de recompensas</span>
        <h2 style="margin-top:14px;">Vale a pena acumular</h2>
        <p>Um preview do que você pode resgatar com seus pontos.</p>
      </div>
      <div class="rewards-grid">
        ${DB.rewards.map(r=>`
          <div class="card reward-card">
            <div class="reward-img">${r.image}</div>
            <div class="reward-title">${escapeHtml(r.name)}</div>
            <div class="reward-desc">${escapeHtml(r.description)}</div>
            <span class="reward-pts-badge mono">⚡ ${fmtNum(r.pointsRequired)} pts</span>
          </div>`).join("")}
      </div>
      <div class="text-center mt-30">
        <button class="btn btn-sun" onclick="navigate('login')">Quero começar a pontuar</button>
      </div>
    </div>
  </section>

  <footer>
    <div class="container">
      <div class="footer-inner">
        <div class="logo" style="font-size:16px;"><span class="logo-mark" style="width:26px;height:26px;font-size:13px;">🌊</span> Maré · Clube de Pontos</div>
        <div>Feito para lojas que querem transformar cada compra em uma boa lembrança. · <a onclick="navigate('admin-login')" style="cursor:pointer; text-decoration:underline;">Acesso administrativo</a></div>
      </div>
    </div>
  </footer>
  `;
}
function afterHome(){ document.getElementById("app").innerHTML = pageHome(); renderNav(); setTimeout(()=>document.getElementById("how")?.scrollIntoView({behavior:"smooth"}), 50); }

function pageRewardsPublic(){
  return `
  <section style="padding-top:40px;">
    <div class="container">
      <div class="section-head">
        <span class="eyebrow">🏝️ Loja de Recompensas</span>
        <h2 style="margin-top:14px;">Troque pontos por experiências</h2>
        <p>Entre na sua conta para resgatar. Aqui está uma prévia do catálogo.</p>
      </div>
      <div class="rewards-grid">
        ${DB.rewards.map(r=>`
          <div class="card reward-card">
            <div class="reward-img">${r.image}</div>
            <div class="reward-title">${escapeHtml(r.name)}</div>
            <div class="reward-desc">${escapeHtml(r.description)}</div>
            <span class="reward-pts-badge mono">⚡ ${fmtNum(r.pointsRequired)} pts</span>
            <button class="btn btn-ghost btn-sm btn-block mt-8" onclick="navigate('login')">Entrar para resgatar</button>
          </div>`).join("")}
      </div>
    </div>
  </section>`;
}

function pageLogin(){
  return `
  <div class="auth-wrap">
    <div class="card auth-card">
      <div class="text-center mt-8" style="margin-bottom:18px;">
        <span style="font-size:34px;">🐚</span>
        <h2 style="margin-top:8px;">Entrar no Maré</h2>
        <p class="small mt-8">Acesse seus pontos e seu QR Code exclusivo.</p>
      </div>
      <form onsubmit="return doLogin(event)">
        <div class="field">
          <label for="loginEmail">E-mail</label>
          <input id="loginEmail" type="email" placeholder="voce@exemplo.com" required>
        </div>
        <div class="field">
          <label for="loginPass">Senha</label>
          <input id="loginPass" type="password" placeholder="••••••••" required>
        </div>
        <button class="btn btn-primary btn-block" type="submit">Entrar na minha conta</button>
      </form>
      <p class="small mt-14 text-center">Contas de demonstração (senha <code class="mono">123456</code>):</p>
      <div class="text-center mt-8">
        ${DB.users.map(u=>`<button class="demo-chip" onclick="fillLogin('${u.email}')">${escapeHtml(u.name.split(" ")[0])}</button>`).join("")}
      </div>
    </div>
  </div>`;
}
function fillLogin(email){ document.getElementById("loginEmail").value = email; document.getElementById("loginPass").value = "123456"; }
function doLogin(ev){
  ev.preventDefault();
  const email = document.getElementById("loginEmail").value.trim().toLowerCase();
  const pass = document.getElementById("loginPass").value;
  const u = DB.users.find(u=>u.email.toLowerCase()===email && u.password===pass);
  if (!u){ toast("❌ E-mail ou senha inválidos"); return false; }
  session.user = u;
  toast(`🌊 Bem-vindo(a) de volta, ${u.name.split(" ")[0]}!`);
  navigate("dashboard");
  return false;
}

function pageAdminLogin(){
  return `
  <div class="auth-wrap">
    <div class="card auth-card">
      <div class="text-center" style="margin-bottom:18px;">
        <span style="font-size:34px;">🏪</span>
        <h2 style="margin-top:8px;">Painel administrativo</h2>
        <p class="small mt-8">Acesso restrito à equipe da loja.</p>
      </div>
      <form onsubmit="return doAdminLogin(event)">
        <div class="field">
          <label for="adminEmail">E-mail</label>
          <input id="adminEmail" type="email" placeholder="admin@mare.com" required>
        </div>
        <div class="field">
          <label for="adminPass">Senha</label>
          <input id="adminPass" type="password" placeholder="••••••••" required>
        </div>
        <button class="btn btn-primary btn-block" type="submit">Entrar no painel</button>
      </form>
      <p class="small mt-14 text-center">Demo: <span class="mono">admin@mare.com</span> · senha <span class="mono">admin123</span></p>
      <button class="demo-chip" style="display:block; margin:10px auto 0;" onclick="fillAdminLogin()">Preencher automaticamente</button>
    </div>
  </div>`;
}
function fillAdminLogin(){ document.getElementById("adminEmail").value="admin@mare.com"; document.getElementById("adminPass").value="admin123"; }
function doAdminLogin(ev){
  ev.preventDefault();
  const email = document.getElementById("adminEmail").value.trim().toLowerCase();
  const pass = document.getElementById("adminPass").value;
  const a = DB.admins.find(a=>a.email.toLowerCase()===email && a.password===pass);
  if (!a){ toast("❌ Credenciais administrativas inválidas"); return false; }
  session.admin = a;
  toast(`☀️ Painel liberado, ${a.name.split(" ")[0]}`);
  navigate("admin-dashboard");
  return false;
}
function logoutAdmin(){ session.admin=null; navigate("admin-login"); }
function logoutClient(){ session.user=null; navigate("home"); }

function shellClient(inner){
  const links = [
    {r:"dashboard", ic:"📊", label:"Meus pontos"},
    {r:"history", ic:"🧾", label:"Histórico"},
    {r:"rewards-app", ic:"🎁", label:"Recompensas"},
    {r:"account", ic:"👤", label:"Minha conta"},
  ];
  return `
  <div class="app-shell">
    <aside class="sidebar">
      ${links.map(l=>`<a class="side-link ${route===l.r?'active':''}" onclick="navigate('${l.r}')"><span class="ic">${l.ic}</span>${l.label}</a>`).join("")}
      <a class="side-link" style="margin-top:auto; color:var(--coral);" onclick="logoutClient()"><span class="ic">↩️</span>Sair</a>
    </aside>
    <main class="main-area">${inner}</main>
  </div>`;
}

function pageDashboard(){
  const u = session.user;
  const nr = nextRewardFor(u.points);
  const pct = nr ? Math.min(100, Math.round((u.points / nr.pointsRequired) * 100)) : 100;
  const tx = userTx(u.id);
  return `
  <h1 class="page-title">Olá, ${escapeHtml(u.name.split(" ")[0])} 👋</h1>
  <p class="page-sub">Aqui está o resumo da sua conta no Maré.</p>
  <div class="dash-grid">
    <div class="card balance-card">
      <svg class="wave-bg" viewBox="0 0 1200 120" preserveAspectRatio="none"><path d="M0,60 C200,110 400,10 600,55 C800,100 1000,20 1200,60 L1200,120 L0,120 Z" fill="rgba(255,255,255,0.18)"></path></svg>
      <div class="balance-label">Saldo de pontos</div>
      <div class="balance-value">${fmtNum(u.points)} <span style="font-size:16px; font-weight:600; opacity:.8;">pts</span></div>
      ${nr ? `
        <div class="progress-track"><div class="progress-fill" style="width:${pct}%;"></div></div>
        <div class="progress-note mono">${fmtNum(u.points)} / ${fmtNum(nr.pointsRequired)} pontos</div>
        <div class="progress-note">🎁 Faltam apenas <strong>${fmtNum(nr.pointsRequired-u.points)}</strong> pontos para "${escapeHtml(nr.name)}"!</div>
      ` : `<div class="progress-note">🏆 Você já pode resgatar qualquer recompensa disponível!</div>`}
      <div class="stat-mini-row" style="margin-top:24px;">
        <div class="stat-mini" style="background:rgba(255,255,255,0.14); box-shadow:none; border:1px solid rgba(255,255,255,0.25);">
          <div class="n" style="color:#fff;">${tx.length}</div><div class="l" style="color:rgba(255,255,255,0.75);">Movimentações</div>
        </div>
        <div class="stat-mini" style="background:rgba(255,255,255,0.14); box-shadow:none; border:1px solid rgba(255,255,255,0.25);">
          <div class="n" style="color:#fff;">${DB.redemptions.filter(r=>r.userId===u.id).length}</div><div class="l" style="color:rgba(255,255,255,0.75);">Resgates</div>
        </div>
        <div class="stat-mini" style="background:rgba(255,255,255,0.14); box-shadow:none; border:1px solid rgba(255,255,255,0.25);">
          <div class="n" style="color:#fff;">${new Date(u.createdAt).getFullYear()}</div><div class="l" style="color:rgba(255,255,255,0.75);">Cliente desde</div>
        </div>
      </div>
    </div>

    <div class="card qr-card">
      <h3>Seu QR Code</h3>
      <p class="small mt-8">Apresente no caixa para pontuar</p>
      <div class="qr-box"><div id="qrcodeDash"></div></div>
      <div class="qr-id">${u.qrCode}</div>
      <div class="qr-actions">
        <button class="btn btn-ghost btn-sm" onclick="navigate('account')">🔍 Ampliar</button>
        <button class="btn btn-ghost btn-sm" onclick="downloadQR('qrcodeDash','${u.qrCode}')">⬇️ Baixar</button>
        <button class="btn btn-ghost btn-sm" onclick="shareQR('${u.qrCode}')">📤 Compartilhar</button>
      </div>
    </div>
  </div>

  <div class="flex items-center justify-between" style="margin-top:34px;">
    <h3>Últimas movimentações</h3>
    <a onclick="navigate('history')" style="cursor:pointer; color:var(--ocean); font-weight:700; font-size:13.5px;">Ver histórico completo →</a>
  </div>
  <div class="hist-list mt-14">
    ${tx.slice(0,3).map(t=>historyRow(t)).join("") || emptyState("🌊","Nenhuma movimentação ainda")}
  </div>
  `;
}
function renderDashQR(){
  const el = document.getElementById("qrcodeDash");
  if (el) makeQR(el, session.user.qrCode, 150);
  const el2 = document.getElementById("qrcodeAccount");
  if (el2) makeQR(el2, session.user.qrCode, 220);
}

function historyRow(t){
  const isPlus = t.points > 0;
  return `
  <div class="card hist-row">
    <div class="hist-ic ${isPlus?'plus':'minus'}">${isPlus?'＋':'－'}</div>
    <div class="hist-main">
      <div class="hist-desc">${escapeHtml(t.description)}</div>
      <div class="hist-date">${fmtDate(t.createdAt)} · <span class="badge ${isPlus?'badge-green':'badge-red'}">${t.type}</span></div>
    </div>
    <div>
      <div class="hist-pts ${isPlus?'plus':'minus'} mono">${fmtPts(t.points)}</div>
      <div class="hist-bal mono">saldo: ${fmtNum(t.balanceAfter)}</div>
    </div>
  </div>`;
}
function emptyState(ic, msg){ return `<div class="card empty-state"><div class="ic">${ic}</div><p>${msg}</p></div>`; }

function pageHistory(){
  const tx = userTx(session.user.id);
  return `
  <h1 class="page-title">Histórico de pontos</h1>
  <p class="page-sub">Todas as movimentações da sua conta, mais recentes primeiro.</p>
  <div class="hist-list">${tx.map(t=>historyRow(t)).join("") || emptyState("🧾","Nenhuma movimentação ainda")}</div>
  `;
}

function pageRewardsApp(){
  const u = session.user;
  return `
  <h1 class="page-title">Loja de Recompensas</h1>
  <p class="page-sub">Você tem <strong class="mono">${fmtNum(u.points)}</strong> pontos disponíveis.</p>
  <div class="rewards-grid">
    ${DB.rewards.map(r=>{
      const can = u.points >= r.pointsRequired && r.active && r.stock>0;
      return `
      <div class="card reward-card">
        <div class="reward-img">${r.image}</div>
        <div class="reward-title">${escapeHtml(r.name)}</div>
        <div class="reward-desc">${escapeHtml(r.description)}</div>
        <span class="reward-pts-badge mono">⚡ ${fmtNum(r.pointsRequired)} pts</span>
        <button class="btn ${can?'btn-primary':'btn-ghost'} btn-sm btn-block mt-8" ${can?"":"disabled"} onclick="confirmRedeem('${r.id}')">
          ${r.stock<=0 ? 'Esgotado' : (can ? 'Resgatar' : 'Pontos insuficientes')}
        </button>
      </div>`;
    }).join("")}
  </div>
  `;
}
function confirmRedeem(rewardId){
  const r = DB.rewards.find(r=>r.id===rewardId);
  openModal({
    title: "Confirmar resgate",
    body: `Trocar <strong>${fmtNum(r.pointsRequired)} pontos</strong> por "${escapeHtml(r.name)}"? Essa ação não pode ser desfeita.`,
    confirmLabel: "Confirmar resgate",
    confirmClass: "btn-primary",
    onConfirm: async ()=>{
      try{
        await api.redeemReward(session.user.id, rewardId);
        session.user = DB.users.find(u=>u.id===session.user.id);
        toast(`🎉 "${escapeHtml(r.name)}" resgatado com sucesso!`);
        navigate("rewards-app");
      }catch(e){ toast("❌ "+e.message); }
    }
  });
}

function pageAccount(){
  const u = session.user;
  return `
  <h1 class="page-title">Minha conta</h1>
  <p class="page-sub">Seus dados e QR Code em detalhe.</p>
  <div class="dash-grid">
    <div class="card card-pad">
      <div class="flex items-center gap-10">
        <div class="avatar-sm" style="width:52px;height:52px;font-size:18px;">${initials(u.name)}</div>
        <div><h3>${escapeHtml(u.name)}</h3><p class="small">${escapeHtml(u.email)}</p></div>
      </div>
      <div class="mt-22" style="display:grid; grid-template-columns:1fr 1fr; gap:16px;">
        <div><p class="small">ID do cliente</p><p class="mono" style="font-weight:700;">#${u.id}</p></div>
        <div><p class="small">Cliente desde</p><p style="font-weight:700;">${new Date(u.createdAt).toLocaleDateString("pt-BR")}</p></div>
        <div><p class="small">Saldo atual</p><p class="mono" style="font-weight:700; color:var(--ocean);">${fmtNum(u.points)} pts</p></div>
        <div><p class="small">Código QR</p><p class="mono" style="font-weight:700;">${u.qrCode}</p></div>
      </div>
    </div>
    <div class="card qr-card">
      <h3>QR Code ampliado</h3>
      <div class="qr-box"><div id="qrcodeAccount"></div></div>
      <div class="qr-id">${u.qrCode}</div>
      <div class="qr-actions">
        <button class="btn btn-ghost btn-sm" onclick="downloadQR('qrcodeAccount','${u.qrCode}')">⬇️ Baixar</button>
        <button class="btn btn-ghost btn-sm" onclick="shareQR('${u.qrCode}')">📤 Compartilhar</button>
      </div>
    </div>
  </div>
  `;
}

function makeQR(el, text, size){
  el.innerHTML = "";
  if (window.QRCode){
    new QRCode(el, { text, width:size, height:size, colorDark:"#073B4C", colorLight:"#ffffff", correctLevel: QRCode.CorrectLevel.M });
  } else {
    el.innerHTML = `<div style="width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;background:#eee;border-radius:8px;font-size:12px;color:#888;">QR indisponível</div>`;
  }
}
function downloadQR(elId, code){
  const canvas = document.querySelector(`#${elId} canvas`);
  if (!canvas){ toast("QR ainda carregando, tente novamente"); return; }
  const link = document.createElement("a");
  link.download = `mare-${code}.png`;
  link.href = canvas.toDataURL("image/png");
  link.click();
  toast("⬇️ QR Code baixado");
}
function shareQR(code){
  const text = `Meu QR Code do clube Maré: ${code}`;
  if (navigator.share){ navigator.share({ title:"Meu QR Code Maré", text }).catch(()=>{}); }
  else { navigator.clipboard?.writeText(text); toast("📋 Código copiado para compartilhar"); }
}


function shellAdmin(inner){
  const links = [
    {r:"admin-dashboard", ic:"📈", label:"Dashboard"},
    {r:"admin-clientes", ic:"🧑‍🤝‍🧑", label:"Clientes"},
    {r:"admin-scan", ic:"📷", label:"QR Code"},
    {r:"admin-pontos", ic:"💠", label:"Transações"},
    {r:"admin-recompensas", ic:"🎁", label:"Recompensas"},
    {r:"admin-config", ic:"⚙️", label:"Configurações"},
  ];
  return `
  <div class="app-shell">
    <aside class="sidebar">
      ${links.map(l=>`<a class="side-link ${route===l.r?'active':''}" onclick="navigate('${l.r}')"><span class="ic">${l.ic}</span>${l.label}</a>`).join("")}
      <a class="side-link" style="margin-top:auto; color:var(--coral);" onclick="logoutAdmin()"><span class="ic">↩️</span>Sair</a>
    </aside>
    <main class="main-area">${inner}</main>
  </div>
  <button class="mobile-fab ${route!=='admin-scan'?'enabled':''}" onclick="navigate('admin-scan')" title="Escanear QR Code">📷</button>
  `;
}

function pageAdminDashboard(){
  const totalClientes = DB.users.length;
  const pontosDistribuidos = DB.transactions.filter(t=>t.points>0).reduce((s,t)=>s+t.points,0);
  const pontosResgatados = Math.abs(DB.transactions.filter(t=>t.type==="resgate").reduce((s,t)=>s+t.points,0));
  const comprasRealizadas = DB.transactions.filter(t=>t.type==="compra").length;
  const recompensasResgatadas = DB.redemptions.length;

  // gráfico simples: pontos distribuídos por cliente
  const maxPts = Math.max(...DB.users.map(u=>u.points), 1);

  return `
  <h1 class="page-title">Dashboard</h1>
  <p class="page-sub">Visão geral do clube de pontos Maré.</p>
  <div class="metrics-grid">
    <div class="card metric-card"><div class="metric-ic">🧑‍🤝‍🧑</div><div class="metric-n">${totalClientes}</div><div class="metric-l">Total de clientes</div></div>
    <div class="card metric-card"><div class="metric-ic">✨</div><div class="metric-n mono">${fmtNum(pontosDistribuidos)}</div><div class="metric-l">Pontos distribuídos</div></div>
    <div class="card metric-card"><div class="metric-ic">🎁</div><div class="metric-n mono">${fmtNum(pontosResgatados)}</div><div class="metric-l">Pontos resgatados</div></div>
    <div class="card metric-card"><div class="metric-ic">🛍️</div><div class="metric-n">${comprasRealizadas}</div><div class="metric-l">Compras realizadas</div></div>
    <div class="card metric-card"><div class="metric-ic">🏆</div><div class="metric-n">${recompensasResgatadas}</div><div class="metric-l">Recompensas resgatadas</div></div>
  </div>

  <div class="card chart-card">
    <div class="flex items-center justify-between">
      <h3>Saldo de pontos por cliente</h3>
      <span class="badge badge-blue">em tempo real</span>
    </div>
    <div class="bar-chart">
      ${DB.users.map(u=>`
        <div class="bar-col">
          <span class="mono small" style="font-weight:700; color:var(--ocean-deep);">${fmtNum(u.points)}</span>
          <div class="bar-fill" style="height:${Math.max(6,(u.points/maxPts)*130)}px;"></div>
          <span class="bar-label">${escapeHtml(u.name.split(" ")[0])}</span>
        </div>`).join("")}
    </div>
  </div>

  <div class="flex items-center justify-between" style="margin-top:30px;">
    <h3>Transações recentes</h3>
    <a onclick="navigate('admin-pontos')" style="cursor:pointer; color:var(--ocean); font-weight:700; font-size:13.5px;">Ver todas →</a>
  </div>
  <div class="card mt-14" style="padding:8px 0;">
    <div class="table-wrap"><table>
      <thead><tr><th>Cliente</th><th>Descrição</th><th>Tipo</th><th>Pontos</th><th>Data</th></tr></thead>
      <tbody>
        ${DB.transactions.slice(0,6).map(t=>{
          const u = DB.users.find(u=>u.id===t.userId);
          return `<tr>
            <td><div class="name-cell"><div class="avatar-sm">${initials(u.name)}</div>${escapeHtml(u.name)}</div></td>
            <td>${escapeHtml(t.description)}</td>
            <td><span class="badge ${t.points>0?'badge-green':'badge-red'}">${t.type}</span></td>
            <td class="mono" style="font-weight:700; color:${t.points>0?'#16A34A':'var(--coral)'};">${fmtPts(t.points)}</td>
            <td class="small">${fmtDate(t.createdAt)}</td>
          </tr>`;
        }).join("")}
      </tbody>
    </table></div>
  </div>
  `;
}

function pageAdminClientes(){
  return `
  <h1 class="page-title">Clientes</h1>
  <p class="page-sub">${DB.users.length} clientes cadastrados no clube Maré.</p>
  <div class="card" style="padding:8px 0;">
    <div class="table-wrap"><table>
      <thead><tr><th>Cliente</th><th>ID</th><th>QR Code</th><th>Pontos</th><th>Cliente desde</th><th></th></tr></thead>
      <tbody>
        ${DB.users.map(u=>`
          <tr>
            <td><div class="name-cell"><div class="avatar-sm">${initials(u.name)}</div>${escapeHtml(u.name)}<div class="small" style="font-weight:400; margin-left:4px;">${escapeHtml(u.email)}</div></div></td>
            <td class="mono">#${u.id}</td>
            <td class="mono small">${u.qrCode}</td>
            <td class="mono" style="font-weight:700; color:var(--ocean);">${fmtNum(u.points)}</td>
            <td class="small">${new Date(u.createdAt).toLocaleDateString("pt-BR")}</td>
            <td><button class="btn btn-ghost btn-sm" onclick="openClientFromAdmin('${u.id}')">Gerenciar</button></td>
          </tr>`).join("")}
      </tbody>
    </table></div>
  </div>
  `;
}
function openClientFromAdmin(userId){
  scannerState.foundUser = DB.users.find(u=>u.id===userId);
  navigate("admin-scan");
}

function pageAdminTransacoes(){
  return `
  <h1 class="page-title">Transações</h1>
  <p class="page-sub">Histórico completo de movimentações de todos os clientes.</p>
  <div class="card" style="padding:8px 0;">
    <div class="table-wrap"><table>
      <thead><tr><th>Cliente</th><th>Descrição</th><th>Tipo</th><th>Pontos</th><th>Saldo após</th><th>Data</th></tr></thead>
      <tbody>
        ${DB.transactions.map(t=>{
          const u = DB.users.find(u=>u.id===t.userId);
          return `<tr>
            <td><div class="name-cell"><div class="avatar-sm">${initials(u.name)}</div>${escapeHtml(u.name)}</div></td>
            <td>${escapeHtml(t.description)}</td>
            <td><span class="badge ${t.points>0?'badge-green':'badge-red'}">${t.type}</span></td>
            <td class="mono" style="font-weight:700; color:${t.points>0?'#16A34A':'var(--coral)'};">${fmtPts(t.points)}</td>
            <td class="mono small">${fmtNum(t.balanceAfter)}</td>
            <td class="small">${fmtDate(t.createdAt)}</td>
          </tr>`;
        }).join("")}
      </tbody>
    </table></div>
  </div>
  `;
}

function pageAdminRecompensas(){
  return `
  <h1 class="page-title">Recompensas</h1>
  <p class="page-sub">Catálogo de recompensas disponíveis para resgate.</p>
  <div class="rewards-grid">
    ${DB.rewards.map(r=>`
      <div class="card reward-card">
        <div class="reward-img">${r.image}</div>
        <div class="reward-title">${escapeHtml(r.name)}</div>
        <div class="reward-desc">${escapeHtml(r.description)}</div>
        <div class="flex items-center justify-between">
          <span class="reward-pts-badge mono">⚡ ${fmtNum(r.pointsRequired)} pts</span>
          <span class="badge ${r.active?'badge-green':'badge-red'}">${r.active?'ativa':'inativa'}</span>
        </div>
        <div class="small mt-8">Estoque: <strong class="mono">${r.stock}</strong> unidades</div>
      </div>`).join("")}
  </div>
  <div class="info-note mt-22">ℹ️ A criação e edição completa de recompensas (upload de imagem, edição de estoque) se conecta à tabela <span class="mono">rewards</span> do banco de dados — ver Configurações para os campos da API.</div>
  `;
}

function pageAdminConfig(){
  return `
  <h1 class="page-title">Configurações</h1>
  <p class="page-sub">Integrações e informações técnicas do sistema.</p>

  <div class="card card-pad config-block">
    <h3>🔌 Conectar backend real</h3>
    <p class="small mt-8" style="margin-bottom:14px;">Este protótipo roda inteiramente no navegador com dados de demonstração. Para produção, plugue uma API real substituindo as funções do objeto <span class="mono">api</span> no código-fonte por chamadas <span class="mono">fetch()</span>, e defina as credenciais abaixo:</p>
    <div class="code-box">const API_BASE_URL = "https://sua-api.com/v1";
const API_KEY      = "SUA_CHAVE_AQUI";        // nunca exponha no front-end em produção
const DB_CONN_STR  = "postgres://user:pass@host:5432/mare"; // apenas no servidor

// Endpoints esperados pelo front-end:
// POST /users/:id/points        { points, description }
// POST /users/:id/points/remove { points, description }
// POST /redemptions             { userId, rewardId }
// GET  /users/:id/transactions
// GET  /rewards
// POST /auth/login              { email, password }
// POST /auth/admin/login        { email, password }</div>
  </div>

  <div class="card card-pad config-block">
    <h3>🗄️ Schema do banco de dados</h3>
    <p class="small mt-8" style="margin-bottom:14px;">Estrutura relacional recomendada (PostgreSQL/MySQL):</p>
    <div class="code-box">users         (id, name, email, password_hash, qr_code, points, created_at)
transactions  (id, user_id, type, points, description, created_at, balance_after)
rewards       (id, name, description, points_required, image, stock, active)
redemptions   (id, user_id, reward_id, points, created_at, status)
admins        (id, name, email, password_hash, role)</div>
  </div>

  <div class="card card-pad config-block">
    <h3>🔐 Segurança</h3>
    <div class="info-note">✅ Senhas devem ser armazenadas com hash (bcrypt/argon2) no backend real — aqui ficam em texto puro apenas para fins de demonstração.<br>✅ Toda alteração de pontos exige confirmação explícita (já implementado nas telas de escaneamento e resgate).<br>✅ O cliente nunca altera o próprio saldo — apenas o painel administrativo tem essa permissão.<br>✅ Toda operação gera um registro em <span class="mono">transactions</span>, preservando o histórico completo.</div>
  </div>
  `;
}


function pageAdminScan(){
  const u = scannerState.foundUser;
  return `
  <h1 class="page-title">Escanear QR Code</h1>
  <p class="page-sub">Aponte a câmera para o QR Code do cliente ou digite o ID manualmente.</p>

  <div class="scanner-wrap">
    <div class="scan-viewport" id="scanViewport">
      <video id="scanVideo" autoplay muted playsinline></video>
      <div class="scan-frame"></div>
    </div>
    <div class="flex" style="gap:10px; margin-top:14px;">
      <button class="btn btn-primary btn-block" id="btnStartScan" onclick="startScanner()">📷 Ativar câmera</button>
      <button class="btn btn-ghost btn-block hidden" id="btnStopScan" onclick="stopScanner(true)">⏹ Parar</button>
    </div>

    <div class="card card-pad mt-22" style="text-align:left;">
      <label for="manualId" style="font-size:13px; font-weight:700; color:var(--ocean-deep);">Ou digite o código do cliente</label>
      <div class="flex gap-10 mt-8">
        <input id="manualId" placeholder="CLIENTE-102938" style="flex:1; padding:12px 14px; border-radius:12px; border:1.5px solid var(--line);">
        <button class="btn btn-primary" onclick="lookupManual()">Buscar</button>
      </div>
      <div class="text-center mt-8">
        ${DB.users.map(u=>`<button class="demo-chip" onclick="lookupCode('${u.qrCode}')">${escapeHtml(u.name.split(" ")[0])}</button>`).join("")}
      </div>
    </div>

    ${u ? clientFoundCard(u) : ""}
  </div>
  `;
}
function clientFoundCard(u){
  const nr = nextRewardFor(u.points);
  return `
  <div class="card client-found-card">
    <span class="badge badge-green">✅ Cliente encontrado</span>
    <div class="client-found-avatar mt-14">${initials(u.name)}</div>
    <h3>${escapeHtml(u.name)}</h3>
    <p class="small">ID: #${u.id} · ${escapeHtml(u.qrCode)}</p>
    <p class="mono" style="font-size:26px; font-weight:700; color:var(--ocean); margin-top:10px;">${fmtNum(u.points)} pts</p>
    ${nr ? `<p class="small">Faltam ${fmtNum(nr.pointsRequired-u.points)} pts para "${escapeHtml(nr.name)}"</p>`: ""}

    <div class="action-grid">
      <button class="btn btn-primary btn-block" onclick="openPointsModal('${u.id}','add')">➕ Adicionar pontos</button>
      <button class="btn btn-danger btn-block" onclick="openPointsModal('${u.id}','remove')">➖ Remover pontos</button>
      <button class="btn btn-sun btn-block" onclick="openPurchaseModal('${u.id}')">🛍️ Registrar compra</button>
      <button class="btn btn-ghost btn-block" onclick="openRedeemAdminModal('${u.id}')">🎁 Resgatar recompensa</button>
      <button class="btn btn-ghost btn-block full" onclick="clearFoundUser()">Limpar / escanear outro cliente</button>
    </div>
  </div>`;
}
function clearFoundUser(){ scannerState.foundUser = null; navigate("admin-scan"); }
function lookupCode(code){
  const u = DB.users.find(u=>u.qrCode.toUpperCase()===code.toUpperCase());
  if (!u){ toast("❌ QR Code não reconhecido"); return; }
  scannerState.foundUser = u;
  stopScanner();
  toast(`✅ Cliente encontrado: ${u.name.split(" ")[0]}`);
  navigate("admin-scan");
}
function lookupManual(){
  const val = document.getElementById("manualId").value.trim();
  if (!val){ toast("Digite um código"); return; }
  lookupCode(val);
}

function afterAdminScan(){

}
async function startScanner(){
  try{
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    scannerState.stream = stream;
    const video = document.getElementById("scanVideo");
    video.srcObject = stream;
    document.getElementById("btnStartScan").classList.add("hidden");
    document.getElementById("btnStopScan").classList.remove("hidden");
    scanLoop(video);
  }catch(e){
    toast("⚠️ Não foi possível acessar a câmera. Use a busca manual abaixo.");
  }
}
function scanLoop(video){
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  function tick(){
    if (!scannerState.stream) return;
    if (video.readyState === video.HAVE_ENOUGH_DATA && window.jsQR){
      canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(imgData.data, imgData.width, imgData.height);
      if (code && code.data){
        lookupCode(code.data.trim());
        return; // stopScanner é chamado dentro do lookup em caso de sucesso
      }
    }
    scannerState.rafId = requestAnimationFrame(tick);
  }
  scannerState.rafId = requestAnimationFrame(tick);
}
function stopScanner(userStopped){
  if (scannerState.rafId) cancelAnimationFrame(scannerState.rafId);
  scannerState.rafId = null;
  if (scannerState.stream){ scannerState.stream.getTracks().forEach(t=>t.stop()); scannerState.stream = null; }
  const btnStart = document.getElementById("btnStartScan");
  const btnStop = document.getElementById("btnStopScan");
  if (btnStart) btnStart.classList.remove("hidden");
  if (btnStop) btnStop.classList.add("hidden");
}


function openPointsModal(userId, mode){
  const u = DB.users.find(u=>u.id===userId);
  const isAdd = mode === "add";
  openCustomModal(`
    <h3>${isAdd?'➕ Adicionar':'➖ Remover'} pontos</h3>
    <p>Cliente: <strong>${escapeHtml(u.name)}</strong> · saldo atual <span class="mono">${fmtNum(u.points)}</span> pts</p>
    <div class="field mt-14">
      <label>Quantidade de pontos</label>
      <input id="modalPoints" type="number" min="1" placeholder="Ex: 250">
    </div>
    <div class="field">
      <label>Descrição</label>
      <input id="modalDesc" type="text" placeholder="${isAdd?'Ex: Compra #1055':'Ex: Ajuste manual'}">
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost btn-block" onclick="closeModal()">Cancelar</button>
      <button class="btn ${isAdd?'btn-primary':'btn-danger'} btn-block" onclick="submitPointsModal('${userId}','${mode}')">Confirmar</button>
    </div>
  `);
}
function submitPointsModal(userId, mode){
  const pts = parseInt(document.getElementById("modalPoints").value, 10);
  const desc = document.getElementById("modalDesc").value.trim() || (mode==="add" ? "Ajuste de pontos" : "Remoção de pontos");
  if (!pts || pts <= 0){ toast("Informe uma quantidade válida"); return; }
  closeModal();
  const u = DB.users.find(u=>u.id===userId);
  openModal({
    title: "Confirmar operação",
    body: `${mode==="add"?"Adicionar":"Remover"} <strong>${fmtNum(pts)} pontos</strong> de <strong>${escapeHtml(u.name)}</strong>?`,
    confirmLabel: "Sim, confirmar",
    confirmClass: mode==="add"?"btn-primary":"btn-danger",
    onConfirm: async ()=>{
      if (mode==="add") await api.addPoints(userId, pts, desc);
      else await api.removePoints(userId, pts, desc);
      scannerState.foundUser = DB.users.find(u=>u.id===userId);
      toast(`🌊 ${fmtNum(pts)} pontos ${mode==="add"?"adicionados":"removidos"} com sucesso!`);
      navigate("admin-scan");
    }
  });
}

function openPurchaseModal(userId){
  const u = DB.users.find(u=>u.id===userId);
  openCustomModal(`
    <h3>🛍️ Registrar compra</h3>
    <p>Cliente: <strong>${escapeHtml(u.name)}</strong></p>
    <div class="field mt-14">
      <label>Valor da compra (R$)</label>
      <input id="modalValor" type="number" min="1" step="0.01" placeholder="Ex: 150.00">
    </div>
    <div class="field">
      <label>Número do pedido</label>
      <input id="modalPedido" type="text" placeholder="Ex: #1055">
    </div>
    <p class="small">Regra padrão: 1 ponto por R$1 gasto.</p>
    <div class="modal-actions">
      <button class="btn btn-ghost btn-block" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-sun btn-block" onclick="submitPurchaseModal('${userId}')">Confirmar</button>
    </div>
  `);
}
function submitPurchaseModal(userId){
  const valor = parseFloat(document.getElementById("modalValor").value);
  const pedido = document.getElementById("modalPedido").value.trim() || "sem número";
  if (!valor || valor <= 0){ toast("Informe um valor válido"); return; }
  const pts = Math.round(valor);
  closeModal();
  const u = DB.users.find(u=>u.id===userId);
  openModal({
    title: "Confirmar compra",
    body: `Registrar compra de <strong>R$ ${valor.toFixed(2)}</strong> (${pts} pts) para <strong>${escapeHtml(u.name)}</strong>?`,
    confirmLabel: "Registrar compra",
    confirmClass: "btn-sun",
    onConfirm: async ()=>{
      await api.addPoints(userId, pts, `Compra ${pedido}`);
      scannerState.foundUser = DB.users.find(u=>u.id===userId);
      toast(`🌊 ${pts} pontos adicionados com sucesso!`);
      navigate("admin-scan");
    }
  });
}

function openRedeemAdminModal(userId){
  const u = DB.users.find(u=>u.id===userId);
  const opts = DB.rewards.filter(r=>r.active);
  openCustomModal(`
    <h3>🎁 Resgatar recompensa</h3>
    <p>Cliente: <strong>${escapeHtml(u.name)}</strong> · saldo <span class="mono">${fmtNum(u.points)}</span> pts</p>
    <div class="field mt-14">
      <label>Escolha a recompensa</label>
      <select id="modalReward">
        ${opts.map(r=>`<option value="${r.id}" ${u.points<r.pointsRequired?"disabled":""}>${r.image} ${escapeHtml(r.name)} — ${fmtNum(r.pointsRequired)} pts ${u.points<r.pointsRequired?"(insuficiente)":""}</option>`).join("")}
      </select>
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost btn-block" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-primary btn-block" onclick="submitRedeemAdmin('${userId}')">Confirmar resgate</button>
    </div>
  `);
}
function submitRedeemAdmin(userId){
  const rewardId = document.getElementById("modalReward").value;
  const r = DB.rewards.find(r=>r.id===rewardId);
  const u = DB.users.find(u=>u.id===userId);
  if (u.points < r.pointsRequired){ toast("❌ Pontos insuficientes"); return; }
  closeModal();
  openModal({
    title: "Confirmar resgate",
    body: `Resgatar "<strong>${escapeHtml(r.name)}</strong>" (${fmtNum(r.pointsRequired)} pts) para <strong>${escapeHtml(u.name)}</strong>?`,
    confirmLabel: "Confirmar resgate",
    confirmClass: "btn-primary",
    onConfirm: async ()=>{
      try{
        await api.redeemReward(userId, rewardId);
        scannerState.foundUser = DB.users.find(u=>u.id===userId);
        toast(`🎉 Recompensa resgatada com sucesso!`);
        navigate("admin-scan");
      }catch(e){ toast("❌ "+e.message); }
    }
  });
}

let modalState = { onConfirm: null };
function openModal({title, body, confirmLabel, confirmClass, onConfirm}){
  modalState.onConfirm = onConfirm;
  openCustomModal(`
    <h3>${title}</h3>
    <p>${body}</p>
    <div class="modal-actions">
      <button class="btn btn-ghost btn-block" onclick="closeModal()">Cancelar</button>
      <button class="btn ${confirmClass||'btn-primary'} btn-block" onclick="runModalConfirm()">${confirmLabel||'Confirmar'}</button>
    </div>
  `);
}
function runModalConfirm(){
  const fn = modalState.onConfirm;
  closeModal();
  if (fn) fn();
}
function openCustomModal(innerHTML){
  let overlay = document.getElementById("modalOverlay");
  if (!overlay){
    overlay = document.createElement("div");
    overlay.id = "modalOverlay";
    overlay.className = "modal-overlay";
    overlay.onclick = (e)=>{ if(e.target===overlay) closeModal(); };
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = `<div class="modal-box">${innerHTML}</div>`;
  requestAnimationFrame(()=> overlay.classList.add("show"));
}
function closeModal(){
  const overlay = document.getElementById("modalOverlay");
  if (overlay) overlay.classList.remove("show");
}

const _origRender = render;
render = function(){
  _origRender();
  setTimeout(()=>{
    if (route==="dashboard" || route==="account") renderDashQR();
  }, 0);
};


render();
