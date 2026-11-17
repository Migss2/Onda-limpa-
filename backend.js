/* Maré · ligação do site com o servidor (carregar DEPOIS de app.js) */
async function http(method, url, body){
  const r = await fetch(url, { method, credentials:"same-origin",
    headers: body ? {"Content-Type":"application/json"} : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(()=>({}));
  if (!r.ok) throw new Error(data.error || "Erro no servidor");
  return data;
}

let myTx = [];
function applyMe(d){
  session.user = d.user;
  myTx = d.transactions;
  DB.users = [d.user];
  DB.rewards = d.rewards;
  DB.redemptions = d.transactions.filter(t=>t.type==="resgate").map(t=>({ id:t.id, userId:d.user.id, points:-t.points, createdAt:t.createdAt }));
}
userTx = () => myTx;

/* ---------- login e cadastro ---------- */
let authMode = "login";
function setAuthMode(m){ authMode = m; render(); }
pageLogin = function(){
  const reg = authMode === "register";
  return `
  <div class="auth-wrap"><div class="card auth-card">
    <div class="text-center mt-8" style="margin-bottom:18px;">
      <span style="font-size:34px;">🐚</span>
      <h2 style="margin-top:8px;">${reg ? "Criar conta no Maré" : "Entrar no Maré"}</h2>
      <p class="small mt-8">${reg ? "Comece com 0 pontos e ganhe escaneando QR Codes." : "Acesse seus pontos e suas recompensas."}</p>
    </div>
    <form onsubmit="return ${reg ? "doRegister" : "doLogin"}(event)">
      ${reg ? `<div class="field"><label for="regName">Nome</label><input id="regName" placeholder="Seu nome" required></div>` : ""}
      <div class="field"><label for="authEmail">E-mail</label><input id="authEmail" type="email" placeholder="voce@exemplo.com" required></div>
      <div class="field"><label for="authPass">Senha</label><input id="authPass" type="password" placeholder="${reg ? "mínimo 8 caracteres" : "••••••••"}" minlength="${reg ? 8 : 1}" required></div>
      <button class="btn btn-primary btn-block" type="submit">${reg ? "Criar minha conta" : "Entrar na minha conta"}</button>
    </form>
    <p class="small mt-14 text-center">${reg ? "Já tem conta?" : "Ainda não tem conta?"}
      <a style="cursor:pointer;color:var(--ocean);font-weight:700;" onclick="setAuthMode('${reg ? "login" : "register"}')">${reg ? "Entrar" : "Cadastre-se"}</a></p>
  </div></div>`;
};
async function doLogin(ev){
  ev.preventDefault();
  try{
    applyMe(await http("POST","/api/login",{ email:document.getElementById("authEmail").value, password:document.getElementById("authPass").value }));
    toast(`🌊 Bem-vindo(a) de volta, ${escapeHtml(session.user.name.split(" ")[0])}!`);
    navigate("dashboard"); await claimPendingCode();
  }catch(e){ toast("❌ "+e.message); }
  return false;
}
async function doRegister(ev){
  ev.preventDefault();
  try{
    applyMe(await http("POST","/api/register",{ name:document.getElementById("regName").value, email:document.getElementById("authEmail").value, password:document.getElementById("authPass").value }));
    toast("🎉 Conta criada! Você começa com 0 pontos.");
    navigate("dashboard"); await claimPendingCode();
  }catch(e){ toast("❌ "+e.message); }
  return false;
}
logoutClient = async function(){
  await http("POST","/api/logout").catch(()=>{});
  session.user = null; myTx = [];
  navigate("home");
};

/* resgate de recompensas agora passa pelo servidor */
api.redeemReward = async (userId, rewardId) => { applyMe(await http("POST","/api/redeem",{ rewardId })); };

/* ---------- página "Escanear QR Code" (cliente) ---------- */
const _render = render;
render = function(){
  if (route === "scan"){
    if (!requireClient()) return;
    renderNav();
    document.getElementById("app").innerHTML = shellClient(pageScan());
    return;
  }
  stopUserScan();
  _render();
};
const _shellClient = shellClient;
shellClient = inner => _shellClient(inner).replace(
  '<a class="side-link" style="margin-top:auto',
  `<a class="side-link ${route==="scan"?"active":""}" onclick="navigate('scan')"><span class="ic">📷</span>Escanear QR</a><a class="side-link" style="margin-top:auto`
);

function pageScan(){
  return `
  <h1 class="page-title">Escanear QR Code</h1>
  <p class="page-sub">Aponte a câmera para um QR Code do Maré e ganhe pontos. Você tem <strong class="mono">${fmtNum(session.user.points)}</strong> pontos.</p>
  <div class="card card-pad" style="max-width:460px;">
    <video id="scanVideo" playsinline muted style="display:none;width:100%;border-radius:14px;margin-bottom:12px;background:#073B4C;"></video>
    <canvas id="scanCanvas" style="display:none;"></canvas>
    <button class="btn btn-primary btn-block" onclick="startUserScan()">📷 Abrir câmera</button>
    <p class="small mt-14 text-center">Ou digite o código do QR:</p>
    <div class="field mt-8"><input id="manualCode" placeholder="PTS-XXXXXXXXXXXX"></div>
    <button class="btn btn-ghost btn-block" onclick="redeemCode(document.getElementById('manualCode').value)">Resgatar código</button>
  </div>`;
}

let scan = { stream:null, raf:0, busy:false };
async function startUserScan(){
  if (scan.stream) return;
  try{ scan.stream = await navigator.mediaDevices.getUserMedia({ video:{ facingMode:"environment" } }); }
  catch{ toast("❌ Não foi possível acessar a câmera (precisa de HTTPS ou localhost)"); return; }
  const v = document.getElementById("scanVideo"), c = document.getElementById("scanCanvas"), ctx = c.getContext("2d", { willReadFrequently:true });
  v.srcObject = scan.stream; v.style.display = "block"; await v.play();
  const tick = async () => {
    if (!scan.stream) return;
    if (v.readyState === v.HAVE_ENOUGH_DATA && !scan.busy){
      c.width = v.videoWidth; c.height = v.videoHeight; ctx.drawImage(v,0,0);
      const img = ctx.getImageData(0,0,c.width,c.height), res = jsQR(img.data, img.width, img.height);
      if (res && res.data){ scan.busy = true; await redeemCode(res.data); setTimeout(()=>{ scan.busy = false; }, 2500); }
    }
    scan.raf = requestAnimationFrame(tick);
  };
  tick();
}
function stopUserScan(){
  cancelAnimationFrame(scan.raf);
  if (scan.stream){ scan.stream.getTracks().forEach(t=>t.stop()); scan.stream = null; }
}
async function redeemCode(code){
  code = (code||"").trim();
  if (!code) return;
  try{
    const r = await http("POST","/api/scan",{ code });
    applyMe(r);
    toast(`🌊 +${fmtNum(r.earned)} pontos! Saldo: ${fmtNum(r.user.points)}`);
    const p = document.querySelector(".page-sub strong"); if (p) p.textContent = fmtNum(r.user.points);
  }catch(e){ toast("❌ "+e.message); }
}

/* mantém o login ao recarregar a página */

/* ---------- QR Code como link: o celular abre o site com ?c=CODIGO ---------- */
const urlCode = new URLSearchParams(location.search).get("c");
if (urlCode){
  sessionStorage.setItem("pendingCode", urlCode);
  history.replaceState(null, "", location.pathname);   // limpa o código da barra de endereço
}
async function claimPendingCode(){
  const code = sessionStorage.getItem("pendingCode");
  if (!code || !session.user) return;
  sessionStorage.removeItem("pendingCode");
  await redeemCode(code);   // o servidor soma os pontos (ou avisa se o QR é inválido/já usado)
  render();
}

/* mantém o login ao recarregar; se veio de um QR e não está logado, manda para o login */
http("GET","/api/me")
  .then(async d => { applyMe(d); render(); await claimPendingCode(); })
  .catch(() => {
    if (sessionStorage.getItem("pendingCode")){
      toast("🔑 Entre ou crie sua conta para receber seus pontos");
      navigate("login");
    }
  });

/* ---------- caixinha "Mostrar senha" em todo campo de senha ---------- */
function addPasswordToggles(){
  document.querySelectorAll('input[type="password"]:not([data-toggle])').forEach(input => {
    input.dataset.toggle = "1";
    const label = document.createElement("label");
    label.style.cssText = "display:flex;align-items:center;gap:8px;margin:8px 0 0;font-size:13px;font-weight:600;cursor:pointer;";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.style.cssText = "width:18px;height:18px;padding:0;margin:0;";
    box.onchange = () => { input.type = box.checked ? "text" : "password"; };
    label.append(box, "Mostrar senha");
    input.insertAdjacentElement("afterend", label);
  });
}
new MutationObserver(addPasswordToggles).observe(document.getElementById("app"), { childList: true, subtree: true });
addPasswordToggles();
