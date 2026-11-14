// Admin page shell. Single file, no build step, no external assets.
// Auth state is decided client-side by probing /admin/api/overview; the server
// still enforces the session cookie on every /admin/api/* call.

export function renderAdmin(initialized) {
  const boot = JSON.stringify({ initialized: !!initialized });
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>后台管理 · iot-ai-proxy</title>
<style>
  :root { --bg:#0f1115; --panel:#171a21; --border:#262b36; --text:#e6e8ee; --dim:#8b93a7; --green:#3ddc84; --amber:#ffb020; --red:#ff5c5c; --blue:#4aa8ff; --input:#0c0e12; --btn:#232936; --btn-hover:#2b3242; }
  html[data-theme="light"] {
    --bg:#f5f6f8; --panel:#ffffff; --border:#e2e5ec; --text:#1a1d24; --dim:#6b7280;
    --green:#0f9d58; --amber:#c77700; --red:#d93025; --blue:#1a73e8;
    --input:#f7f8fa; --btn:#eef0f4; --btn-hover:#e3e6ec;
  }
  html[data-theme="light"] body { background:var(--bg); color:var(--text); }
  html[data-theme="light"] input, html[data-theme="light"] select, html[data-theme="light"] textarea { background:var(--input); color:var(--text); }
  html[data-theme="light"] button { background:var(--btn); color:var(--text); }
  html[data-theme="light"] button:hover { background:var(--btn-hover); }
  html[data-theme="light"] .sidebar-backdrop, html[data-theme="light"] .backdrop { background:rgba(15,20,30,.35); }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { background:var(--bg); color:var(--text); font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif; font-size:14px; }
  .wrap { max-width:1100px; margin:0 auto; padding:24px 18px 60px; }
  h1 { font-size:20px; font-weight:600; margin-bottom:4px; }
  h2 { font-size:15px; font-weight:600; margin:22px 0 10px; color:var(--dim); text-transform:uppercase; letter-spacing:.06em; }
  .sub { color:var(--dim); font-size:13px; margin-bottom:20px; }
  .card { background:var(--panel); border:1px solid var(--border); border-radius:10px; padding:16px; }
  .row { display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
  input, select, textarea { background:var(--input); border:1px solid var(--border); color:var(--text); border-radius:8px; padding:9px 11px; font-size:13px; font-family:inherit; outline:none; }
  input:focus, textarea:focus, select:focus { border-color:var(--blue); }
  textarea { width:100%; min-height:120px; resize:vertical; font-family:ui-monospace,monospace; }
  button { background:var(--btn); border:1px solid var(--border); color:var(--text); border-radius:8px; padding:9px 14px; font-size:13px; cursor:pointer; }
  button:hover { background:var(--btn-hover); }
  button.primary { background:var(--blue); border-color:var(--blue); color:#06121f; font-weight:600; }
  button.danger { color:var(--red); border-color:#3a2226; }
  button.ok { background:var(--green); border-color:var(--green); color:#04150b; font-weight:600; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { text-align:left; padding:9px 8px; border-bottom:1px solid var(--border); vertical-align:middle; }
  th { color:var(--dim); font-weight:500; font-size:12px; }
  code, .mono { font-family:ui-monospace,monospace; font-size:12px; }
  .pill { display:inline-block; padding:2px 8px; border-radius:999px; font-size:11px; border:1px solid var(--border); }
  .p-active { color:var(--green); border-color:#1f4432; }
  .p-dead { color:var(--red); border-color:#4a2429; }
  .p-disabled { color:var(--dim); }
  .p-cool { color:var(--amber); border-color:#4a3a1a; }
  .p-flaky { color:#ff8c42; border-color:#4a2f1a; }
  .p-quota { color:#c56cf0; border-color:#3a2450; }
  .p-unbound { color:#ff8c42; border-color:#4a2f1a; }
  .p-halted { color:var(--red); border-color:#4a2429; }
  .p-ok { color:var(--green); border-color:#1f4432; }
  .p-unknown { color:var(--dim); }
  .health-detail { font-size:11px; color:var(--dim); margin-top:2px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; }
  .stat { background:var(--panel); border:1px solid var(--border); border-radius:10px; padding:12px; }
  .stat b { display:block; font-size:20px; margin-top:4px; }
  .stat span { color:var(--dim); font-size:12px; }
  .hide { display:none !important; }
  .msg { margin-top:10px; font-size:13px; }
  .msg.err { color:var(--red); } .msg.ok { color:var(--green); }
  .tabs { display:flex; gap:8px; margin-bottom:14px; }
  .tabs button.on { background:var(--blue); border-color:var(--blue); color:#06121f; font-weight:600; }
  .muted { color:var(--dim); font-size:12px; }
  .secret { font-family:ui-monospace,monospace; font-size:12px; color:var(--amber); }
  .nowrap { white-space:nowrap; }
  .topbar { display:flex; align-items:center; gap:10px; margin-bottom:14px; flex-wrap:wrap; }
  .topbar .spacer { flex:1; }
  .icon-btn { background:var(--btn); border:1px solid var(--border); color:var(--text); border-radius:8px; padding:7px 11px; font-size:13px; cursor:pointer; }
  .icon-btn:hover { background:var(--btn-hover); }
  .endpoint-box { display:flex; align-items:center; gap:8px; background:var(--panel); border:1px solid var(--border); border-radius:10px; padding:10px 12px; margin-bottom:14px; flex-wrap:wrap; }
  .endpoint-box code { background:var(--input); padding:6px 9px; border-radius:6px; color:var(--amber); word-break:break-all; }
  .phone-only { display:none; }
  @media (max-width: 720px) {
    .wrap { padding:16px 12px 48px; }
    h1 { font-size:17px; }
    table { font-size:12px; }
    th, td { padding:7px 5px; }
    .tabs { flex-wrap:wrap; }
    .tabs button { padding:7px 10px; font-size:12px; }
    .endpoint-box { flex-direction:column; align-items:stretch; }
    .endpoint-box .row { width:100%; }
    .card { padding:12px; }
  }
</style>
</head>
<body>
<div class="wrap">
  <div class="topbar">
    <div>
      <h1>iot-ai-proxy 后台</h1>
      <div class="sub" id="sub" style="margin:2px 0 0;">正在加载…</div>
    </div>
    <div class="spacer"></div>
    <button class="icon-btn" id="theme-btn" onclick="toggleTheme()">🌙 深色</button>
    <a class="icon-btn" href="/" style="text-decoration:none;">聊天页 ↗</a>
  </div>

  <div class="endpoint-box">
    <span class="muted">API 端点</span>
    <code id="ep-base"></code>
    <button onclick="copyEndpoint('/v1')">复制 base</button>
    <button onclick="copyEndpoint('/v1/chat/completions')">复制完整 URL</button>
  </div>

  <!-- 首次设置 -->
  <div id="view-setup" class="card hide">
    <h2>首次使用 · 设置管理密码</h2>
    <p class="muted" style="margin-bottom:12px;">密码只保存 PBKDF2-SHA256 指纹，无法找回。设置后所有 /admin 操作都需要登录。</p>
    <div class="row">
      <input id="setup-pass" type="password" placeholder="至少 6 位" style="width:240px;">
      <input id="setup-pass2" type="password" placeholder="再输一次" style="width:240px;">
      <button class="primary" onclick="doSetup()">设置密码</button>
    </div>
    <div class="msg" id="setup-msg"></div>
  </div>

  <!-- 登录 -->
  <div id="view-login" class="card hide">
    <h2>登录</h2>
    <div class="row">
      <input id="login-pass" type="password" placeholder="管理密码" style="width:240px;" onkeydown="if(event.key==='Enter')doLogin()">
      <button class="primary" onclick="doLogin()">登录</button>
    </div>
    <div class="msg" id="login-msg"></div>
  </div>

  <!-- 面板 -->
  <div id="view-app" class="hide">
    <div class="tabs">
      <button id="tab-dash" class="on" onclick="switchTab('dash')">总览</button>
      <button id="tab-tokens" onclick="switchTab('tokens')">API 令牌</button>
      <button id="tab-sns" onclick="switchTab('sns')">SN 池</button>
      <button id="tab-logs" onclick="switchTab('logs')">日志</button>
      <button onclick="doLogout()" style="margin-left:auto;">退出登录</button>
    </div>

    <!-- 总览 -->
    <div id="pane-dash">
      <div class="grid" id="stats"></div>
      <h2>今日与累计</h2>
      <div class="card"><table><tbody id="usage-table"></tbody></table></div>
      <h2>修改密码</h2>
      <div class="card">
        <div class="row">
          <input id="pw-old" type="password" placeholder="当前密码" style="width:200px;">
          <input id="pw-new" type="password" placeholder="新密码（≥6位）" style="width:200px;">
          <button onclick="doChangePassword()">更新</button>
        </div>
        <div class="msg" id="pw-msg"></div>
      </div>
    </div>

    <!-- 令牌 -->
    <div id="pane-tokens" class="hide">
      <h2>新建令牌</h2>
      <div class="card">
        <div class="row">
          <input id="tk-note" placeholder="备注，例如：小王测试" style="width:220px;">
          <input id="tk-exp" type="datetime-local" title="定时过期">
          <input id="tk-max" type="number" min="0" placeholder="可用次数，0=不限" style="width:170px;">
          <button class="primary" onclick="createToken()">生成 sk- 令牌</button>
        </div>
        <div class="msg" id="tk-msg"></div>
        <div id="tk-new" class="hide" style="margin-top:12px;padding:12px;border:1px dashed #2f5a3f;border-radius:8px;">
          <div class="muted">新令牌（只显示一次，请立即保存）</div>
          <div class="secret" id="tk-new-val" style="margin-top:6px;font-size:14px;"></div>
        </div>
      </div>

      <h2>令牌列表</h2>
      <div class="card">
        <div class="row" style="margin-bottom:10px;">
          <input id="tk-q" placeholder="搜索备注 / 前缀" style="width:260px;" oninput="renderTokens()">
          <button onclick="loadAll()">刷新</button>
          <button class="danger" onclick="deleteSelectedTokens()">删除选中</button>
        </div>
        <table>
          <thead><tr><th style="width:32px;"><input type="checkbox" id="tk-all" onchange="toggleAllTokens(this)"></th><th style="min-width:280px;">令牌（完整）</th><th>备注</th><th>用量</th><th>到期</th><th>次数</th><th>状态</th><th></th></tr></thead>
          <tbody id="tk-body"></tbody>
        </table>
      </div>
    </div>

    <!-- 日志 -->
    <div id="pane-logs" class="hide">
      <h2>请求日志（最近 100 条）</h2>
      <div class="card">
        <div class="row" style="margin-bottom:10px;">
          <input id="log-q" placeholder="按 requestId / token / 状态过滤" style="width:280px;" oninput="renderLogs()">
          <label class="muted"><input type="checkbox" id="log-err-only" onchange="renderLogs()"> 只看失败</label>
          <button onclick="loadLogs()">刷新</button>
          <button class="danger" onclick="clearLogs()">清空</button>
        </div>
        <div id="log-list"></div>
      </div>
    </div>

    <!-- SN 池 -->
    <div id="pane-sns" class="hide">
      <h2>添加 / 批量导入</h2>
      <div class="card">
        <div class="row" style="margin-bottom:10px;">
          <input id="sn-in-sn" placeholder="SN" style="width:200px;">
          <input id="sn-in-secret" placeholder="secret" style="width:300px;">
          <input id="sn-in-note" placeholder="备注" style="width:180px;">
          <button class="primary" onclick="addSn()">添加</button>
        </div>
        <textarea id="sn-import" placeholder="批量导入：一行一对，sn secret（空格分隔），可加备注&#10;768000000000000000 abcdef0123456789abcdef0123456789 设备A"></textarea>
        <div class="row" style="margin-top:10px;">
          <input type="file" id="sn-file" accept=".txt,.csv,text/plain" style="display:none;" onchange="onSnFilePicked(this)">
          <button onclick="document.getElementById('sn-file').click()">从文件导入</button>
          <button onclick="exportSn('txt')">导出 .txt</button>
          <button onclick="exportSn('json')">导出 .json</button>
        </div>
        <div class="row" style="margin-top:10px;">
          <button onclick="importSn()">粘贴内容导入</button>
          <button onclick="checkAllSn()">检测全部可用性</button>
          <button onclick="disableUnbound()">禁用未绑定设备</button>
          <button onclick="bulkStatus('active')">批量启用</button>
          <button onclick="clearCooldown()">清除冷却/失败记录</button>
          <button onclick="bulkStatus('disabled')">批量禁用</button>
          <button class="danger" onclick="deleteSelected()">删除选中</button>
        </div>
        <div class="msg" id="sn-msg"></div>
      </div>

      <h2>SN 池</h2>
      <div class="card">
        <div class="row" style="margin-bottom:10px;">
          <input id="sn-q" placeholder="搜索 SN / 备注" style="width:260px;" oninput="renderSns()">
          <button onclick="loadAll()">刷新</button>
        </div>
        <table>
          <thead><tr><th><input type="checkbox" id="sn-all" onchange="toggleAll(this)"></th><th>SN</th><th>Secret</th><th>备注</th><th>绑定</th><th>可用性</th><th>用量</th><th>最近错误</th><th></th></tr></thead>
          <tbody id="sn-body"></tbody>
        </table>
      </div>
    </div>
  </div>
</div>

<script>
const BOOT = ${boot};
const $ = (id) => document.getElementById(id);
let STATE = { tokens: [], sns: [] };

// ---- theme ----
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('iot-admin-theme', t);
  var b = document.getElementById('theme-btn');
  if (b) b.textContent = t === 'light' ? '☀ 浅色' : '🌙 深色';
}
function toggleTheme() {
  applyTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light');
}
(function initTheme() {
  applyTheme(localStorage.getItem('iot-admin-theme') || 'light');
})();

// ---- endpoint ----
document.getElementById('ep-base').textContent = location.origin + '/v1';
async function copyEndpoint(path) {
  var full = location.origin + path;
  const el = document.getElementById('sub');
  try {
    await navigator.clipboard.writeText(full);
    el.textContent = '已复制：' + full;
  } catch (_) {
    el.textContent = '复制失败，请手动复制：' + full;
  }
  setTimeout(function () { el.textContent = '已登录'; }, 2500);
}

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function fmtTime(ms) { return ms ? new Date(ms).toLocaleString('zh-CN') : '—'; }
function fmtNum(n) { return (n || 0).toLocaleString('zh-CN'); }
function setMsg(id, text, ok) { const el = $(id); el.textContent = text; el.className = 'msg ' + (ok ? 'ok' : 'err'); }

function show(view) {
  ['view-setup','view-login','view-app'].forEach(v => $(v).classList.toggle('hide', v !== view));
}

async function api(path, opts) {
  const res = await fetch('/admin' + path, Object.assign({ credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } }, opts || {}));
  let data = null; try { data = await res.json(); } catch (_) {}
  if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
  return data;
}

async function boot() {
  if (!BOOT.initialized) { $('sub').textContent = '首次使用，请先设置管理密码'; show('view-setup'); return; }
  try { await api('/api/overview'); $('sub').textContent = '已登录'; show('view-app'); loadAll(); }
  catch (e) { $('sub').textContent = '请登录后台'; show('view-login'); }
}

async function doSetup() {
  const a = $('setup-pass').value, b = $('setup-pass2').value;
  if (a.length < 6) return setMsg('setup-msg', '密码至少 6 位', false);
  if (a !== b) return setMsg('setup-msg', '两次输入不一致', false);
  try { await api('/api/setup', { method: 'POST', body: JSON.stringify({ password: a }) }); $('sub').textContent = '已登录'; show('view-app'); loadAll(); }
  catch (e) { setMsg('setup-msg', '设置失败：' + e.message, false); }
}

async function doLogin() {
  try { await api('/api/login', { method: 'POST', body: JSON.stringify({ password: $('login-pass').value }) }); $('sub').textContent = '已登录'; show('view-app'); loadAll(); }
  catch (e) { setMsg('login-msg', '登录失败：' + e.message, false); }
}

async function doLogout() { try { await api('/api/logout', { method: 'POST' }); } catch (_) {} location.reload(); }

async function doChangePassword() {
  try { await api('/api/password', { method: 'POST', body: JSON.stringify({ oldPassword: $('pw-old').value, newPassword: $('pw-new').value }) }); setMsg('pw-msg', '已更新', true); $('pw-old').value = ''; $('pw-new').value = ''; }
  catch (e) { setMsg('pw-msg', '失败：' + e.message, false); }
}

function switchTab(name) {
  ['dash','tokens','sns','logs'].forEach(n => { $('pane-' + n).classList.toggle('hide', n !== name); $('tab-' + n).classList.toggle('on', n === name); });
  if (name === 'logs') loadLogs();
}

let LOGS = [];
async function loadLogs() {
  try {
    const d = await api('/api/logs?limit=100');
    LOGS = d.logs || [];
    renderLogs();
  } catch (e) { setMsg('sn-msg', '日志加载失败：' + e.message, false); }
}

function fmtMs(ms) { return ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms'; }

function renderLogs() {
  const q = ($('log-q').value || '').toLowerCase();
  const errOnly = $('log-err-only').checked;
  const rows = LOGS.filter(l => {
    if (errOnly && l.status !== 'error') return false;
    if (!q) return true;
    return (l.id || '').toLowerCase().includes(q) || (l.token || '').toLowerCase().includes(q) || (l.status || '').includes(q);
  });
  if (!rows.length) { $('log-list').innerHTML = '<div class="muted">暂无日志</div>'; return; }
  $('log-list').innerHTML = rows.map(l => {
    const bad = l.status === 'error';
    const slow = (l.totalMs || 0) > 20000;
    const color = bad ? 'var(--red)' : slow ? 'var(--amber)' : 'var(--green)';
    const steps = (l.steps || []).map(s => s.name + ':' + fmtMs(s.ms)).join(' → ');
    const retries = (l.retries || []).length ? ' <span class="muted">重试 ' + l.retries.length + ' 次</span>' : '';
    return '<div style="padding:9px 0;border-bottom:1px solid var(--border);">' +
      '<div class="mono" style="color:' + color + ';">' + esc(l.id) + ' · ' + esc(l.status) + ' · ' + fmtMs(l.totalMs || 0) + retries + '</div>' +
      '<div class="muted" style="font-size:12px;margin-top:3px;">' + esc(l.model || '-') + ' · ' + esc(l.token || '-') + ' · ' + esc(l.sn || '-') + ' · ' + fmtTime(l.startedAt) + '</div>' +
      '<div class="muted" style="font-size:12px;margin-top:2px;">' + esc(steps) + '</div>' +
      (l.error ? '<div style="font-size:12px;color:var(--red);margin-top:2px;">' + esc(String(l.error).slice(0, 200)) + '</div>' : '') +
      '</div>';
  }).join('');
}

async function clearLogs() {
  if (!confirm('清空全部日志？')) return;
  await api('/api/logs', { method: 'DELETE' });
  LOGS = []; renderLogs();
}

async function loadAll() {
  try {
    const d = await api('/api/overview');
    STATE.tokens = d.tokens; STATE.sns = d.sns;
    renderStats(d); renderTokens(); renderSns();
  } catch (e) { $('sub').textContent = '加载失败：' + e.message; }
}

function renderStats(d) {
  const c = d.counts || {};
  $('stats').innerHTML = [
    ['API 令牌', fmtNum(c.tokens), (c.tokensActive || 0) + ' 启用'],
    ['SN 设备', fmtNum(c.sns), (c.snsHealthy || 0) + ' 健康 · ' + (c.snsUnbound || 0) + ' 未绑定'],
    ['令牌请求', fmtNum(d.tokenUsage.requests), '累计'],
    ['设备请求', fmtNum(d.snUsage.requests), '累计'],
    ['输入 tokens', fmtNum(d.tokenUsage.prompt_tokens), '令牌维度'],
    ['输出 tokens', fmtNum(d.tokenUsage.completion_tokens), '令牌维度'],
  ].map(([label, val, note]) => '<div class="stat"><span>' + label + '</span><b>' + val + '</b><span>' + esc(note) + '</span></div>').join('');
  $('usage-table').innerHTML =
    '<tr><th>维度</th><th>请求数</th><th>输入</th><th>输出</th></tr>' +
    '<tr><td>按令牌汇总</td><td>' + fmtNum(d.tokenUsage.requests) + '</td><td>' + fmtNum(d.tokenUsage.prompt_tokens) + '</td><td>' + fmtNum(d.tokenUsage.completion_tokens) + '</td></tr>' +
    '<tr><td>按设备汇总</td><td>' + fmtNum(d.snUsage.requests) + '</td><td>' + fmtNum(d.snUsage.prompt_tokens) + '</td><td>' + fmtNum(d.snUsage.completion_tokens) + '</td></tr>';
}

function renderTokens() {
  const q = ($('tk-q').value || '').toLowerCase();
  const rows = STATE.tokens.filter(t => !q || (t.note || '').toLowerCase().includes(q) || t.prefix.includes(q));
  $('tk-body').innerHTML = rows.map(t => {
    const expired = t.expiresAt && Date.now() >= t.expiresAt;
    const exhausted = t.maxUses && (t.uses || 0) >= t.maxUses;
    const st = t.enabled === false ? '已禁用' : expired ? '已过期' : exhausted ? '次数用尽' : '正常';
    const cls = t.enabled === false ? 'p-disabled' : (expired || exhausted) ? 'p-dead' : 'p-active';
    const u = t.usage || {};
    return '<tr>' +
      '<td><input type="checkbox" class="tk-pick" value="' + esc(t.hash) + '"></td>' +
      '<td class="mono"><span class="secret">' + (t.token ? esc(t.token) : '<span class="muted">（旧版令牌，明文未保存，请点「重置」生成新 key）</span>') + '</span></td>' +
      '<td>' + esc(t.note || '—') + '</td>' +
      '<td class="nowrap">' + fmtNum(u.requests) + ' 次 / ' + fmtNum((u.prompt_tokens||0)+(u.completion_tokens||0)) + ' tok</td>' +
      '<td class="nowrap">' + (t.expiresAt ? fmtTime(t.expiresAt) : '不限') + '</td>' +
      '<td class="nowrap">' + (t.maxUses ? (t.uses || 0) + ' / ' + t.maxUses : '不限') + '</td>' +
      '<td><span class="pill ' + cls + '">' + st + '</span></td>' +
      '<td class="nowrap"><button onclick="toggleToken(\\'' + t.hash + '\\',' + (t.enabled === false) + ')">' + (t.enabled === false ? '启用' : '禁用') + '</button> ' +
      '<button class="danger" onclick="delToken(\\'' + t.hash + '\\')">删除</button></td>' +
      '</tr>';
  }).join('') || '<tr><td colspan="8" class="muted">暂无令牌</td></tr>';
}

function renderSns() {
  const q = ($('sn-q').value || '').toLowerCase();
  const rows = STATE.sns.filter(s => !q || s.sn.includes(q) || (s.note || '').toLowerCase().includes(q));
  const now = Date.now();
  $('sn-body').innerHTML = rows.map(s => {
    const h = s.health || { key: 'unknown', label: '未知', detail: '' };
    const cls = { ok:'p-ok', cooling:'p-cool', flaky:'p-flaky', quota:'p-quota', unbound:'p-unbound', halted:'p-halted', dead:'p-dead', disabled:'p-disabled', unknown:'p-unknown' }[h.key] || 'p-unknown';
    const txt = h.label;
    const detail = h.detail || '';
    const u = s.usage || {};
    return '<tr>' +
      '<td><input type="checkbox" class="sn-pick" value="' + esc(s.sn) + '"></td>' +
      '<td class="mono">' + esc(s.sn) + '</td>' +
      '<td class="secret" style="max-width:340px;word-break:break-all;">' + esc(s.secret) + '</td>' +
      '<td>' + esc(s.note || '—') + '</td>' +
      '<td>' + (s.binded === 1 ? '<span class="pill p-ok">已绑定</span>' : s.binded === 0 ? '<span class="pill p-unbound">未绑定</span>' : '<span class="muted">未检测</span>') + '</td>' +
      '<td><span class="pill ' + cls + '">' + esc(txt) + '</span><div class="health-detail">' + esc(detail.slice(0, 46)) + '</div></td>' +
      '<td class="nowrap">' + fmtNum(u.requests) + ' 次<br><span class="muted">ok ' + fmtNum(s.okCount) + ' / fail ' + fmtNum(s.failCount) + '</span></td>' +
      '<td class="muted">' + esc((s.lastError || '—').slice(0, 26)) + '<br><span class="health-detail">' + (s.lastErrorAt ? fmtTime(s.lastErrorAt) : '—') + '</span></td>' +
      '<td class="nowrap"><button onclick="checkSn(\\'' + s.sn + '\\')">检测</button> ' +
      '<button onclick="toggleSn(\\'' + s.sn + '\\',\\'' + (s.status === 'disabled' ? 'active' : 'disabled') + '\\')">' + (s.status === 'disabled' ? '启用' : '禁用') + '</button> ' +
      '<button class="danger" onclick="delSn(\\'' + s.sn + '\\')">删除</button></td>' +
      '</tr>';
  }).join('') || '<tr><td colspan="9" class="muted">SN 池为空，请先添加或批量导入</td></tr>';
}

async function createToken() {
  const expEl = $('tk-exp').value;
  const body = { note: $('tk-note').value, maxUses: Number($('tk-max').value) || 0, expiresAt: expEl ? new Date(expEl).getTime() : 0 };
  try {
    const d = await api('/api/tokens', { method: 'POST', body: JSON.stringify(body) });
    $('tk-new').classList.remove('hide'); $('tk-new-val').textContent = d.token;
    setMsg('tk-msg', '已生成', true);
    const ov = await api('/api/overview'); STATE.tokens = ov.tokens; renderTokens(); renderStats(ov);
  } catch (e) { setMsg('tk-msg', '失败：' + e.message, false); }
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); setMsg('tk-msg', '已复制', true); }
  catch (_) { prompt('手动复制：', text); }
}

async function rotateToken(hash) {
  if (!confirm('重置后会生成新 key，旧 key 立即失效，继续？')) return;
  const d = await api('/api/tokens/rotate', { method: 'POST', body: JSON.stringify({ hash }) });
  await loadAll();
  setMsg('tk-msg', '已重置：' + d.record.token, true);
}

async function toggleToken(hash, enable) { await api('/api/tokens', { method: 'PATCH', body: JSON.stringify({ hash, enabled: enable }) }); loadAll(); }
async function delToken(hash, note) {
  if (!confirm('删除令牌 ' + (note || hash.slice(0, 12)) + '？删除后该 key 立即失效，且用量记录一并清除。')) return;
  const d = await api('/api/tokens', { method: 'DELETE', body: JSON.stringify({ hash }) });
  await loadAll();
  setMsg('tk-msg', '已删除 ' + (d.deleted || 1) + ' 个令牌', true);
}

function toggleAllTokens(el) {
  document.querySelectorAll('.tk-pick').forEach(c => { c.checked = el.checked; });
}

async function deleteSelectedTokens() {
  const hashes = Array.from(document.querySelectorAll('.tk-pick:checked')).map(c => c.value);
  if (!hashes.length) return setMsg('tk-msg', '未选中任何令牌', false);
  if (!confirm('删除选中的 ' + hashes.length + ' 个令牌？此操作不可撤销。')) return;
  const d = await api('/api/tokens', { method: 'DELETE', body: JSON.stringify({ hashes }) });
  await loadAll();
  setMsg('tk-msg', '已删除 ' + d.deleted + ' 个令牌', true);
}

async function addSn() {
  try {
    await api('/api/sns', { method: 'POST', body: JSON.stringify({ sn: $('sn-in-sn').value, secret: $('sn-in-secret').value, note: $('sn-in-note').value }) });
    $('sn-in-sn').value = ''; $('sn-in-secret').value = ''; $('sn-in-note').value = '';
    setMsg('sn-msg', '已添加', true); loadAll();
  } catch (e) {
    setMsg('sn-msg', e.message === 'duplicate_sn' ? '该 SN 已存在，请勿重复添加' : '失败：' + e.message, false);
  }
}

// 选择文件后读入文本框并直接导入
function onSnFilePicked(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  if (file.size > 15 * 1024 * 1024) {
    setMsg('sn-msg', '文件超过 15 MB，请拆分后再导入', false);
    input.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = async () => {
    $('sn-import').value = String(reader.result || '');
    setMsg('sn-msg', '已读取「' + file.name + '」，开始导入…', true);
    await importSn();
    input.value = '';
  };
  reader.onerror = () => setMsg('sn-msg', '读取文件失败', false);
  reader.readAsText(file, 'utf-8');
}

async function importSn() {
  try {
    const d = await api('/api/sns/import', { method: 'POST', body: JSON.stringify({ text: $('sn-import').value }) });
    setMsg('sn-msg', '导入 ' + d.added.length + ' 条，重复忽略 ' + (d.duplicates || []).length + ' 条，无效 ' + d.skipped.length + ' 条', true);
    $('sn-import').value = ''; loadAll();
  } catch (e) { setMsg('sn-msg', '失败：' + e.message, false); }
}

// 导出：直接下载文件（带 cookie 走同源请求）
async function exportSn(format) {
  try {
    const res = await fetch('/admin/api/sns/export?format=' + format, { credentials: 'same-origin' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();
    const d = new Date();
    const stamp = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'sn-secret-' + stamp + (format === 'json' ? '.json' : '.txt');
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    setMsg('sn-msg', '已导出 ' + format.toUpperCase(), true);
  } catch (e) {
    setMsg('sn-msg', '导出失败：' + e.message, false);
  }
}

async function checkSn(sn) {
  try { const d = await api('/api/sns/check', { method: 'POST', body: JSON.stringify({ sn }) }); setMsg('sn-msg', sn + (d.ok ? ' 可用' : ' 不可用：' + (d.result.error || '')), d.ok); loadAll(); }
  catch (e) { setMsg('sn-msg', '检测失败：' + e.message, false); }
}

async function checkAllSn() {
  setMsg('sn-msg', '检测中…', true);
  try { const d = await api('/api/sns/check', { method: 'POST', body: JSON.stringify({ all: true }) });
    const ok = d.results.filter(r => r.ok).length;
    setMsg('sn-msg', '检测完成：' + ok + '/' + d.results.length + ' 可用', true); loadAll();
  } catch (e) { setMsg('sn-msg', '检测失败：' + e.message, false); }
}

async function disableUnbound() {
  if (!confirm('把所有 binded=0（未绑定账号）的设备批量禁用？')) return;
  const d = await api('/api/sns/disable-unbound', { method: 'POST' });
  setMsg('sn-msg', '已禁用 ' + d.disabled + ' 台未绑定设备', true);
  loadAll();
}

async function toggleSn(sn, status) { await api('/api/sns', { method: 'PATCH', body: JSON.stringify({ sn, status }) }); loadAll(); }
async function delSn(sn) { if (!confirm('删除 ' + sn + '？')) return; await api('/api/sns', { method: 'DELETE', body: JSON.stringify({ sn }) }); loadAll(); }

function toggleAll(el) { document.querySelectorAll('.sn-pick').forEach(c => c.checked = el.checked); }
async function clearCooldown() {
  const sns = Array.from(document.querySelectorAll('.sn-pick:checked')).map(c => c.value);
  if (!sns.length) return setMsg('sn-msg', '请先勾选设备（或点「检测全部」刷新状态）', false);
  for (const sn of sns) {
    await api('/api/sns', { method: 'PATCH', body: JSON.stringify({ sn, clearCooldown: true }) });
  }
  setMsg('sn-msg', '已清除 ' + sns.length + ' 台设备的冷却与失败记录', true);
  loadAll();
}

async function bulkStatus(status) {
  const sns = Array.from(document.querySelectorAll('.sn-pick:checked')).map(c => c.value);
  if (!sns.length) return setMsg('sn-msg', '未选中任何设备', false);
  await api('/api/sns/bulk', { method: 'POST', body: JSON.stringify({ sns, status }) });
  setMsg('sn-msg', '已更新 ' + sns.length + ' 条', true); loadAll();
}

async function deleteSelected() {
  const sns = Array.from(document.querySelectorAll('.sn-pick:checked')).map(c => c.value);
  if (!sns.length) return setMsg('sn-msg', '未选中任何设备', false);
  if (!confirm('删除选中的 ' + sns.length + ' 条？')) return;
  await api('/api/sns', { method: 'DELETE', body: JSON.stringify({ sns }) });
  setMsg('sn-msg', '已删除 ' + sns.length + ' 条', true); loadAll();
}

boot();
</script>
</body>
</html>`;
}
