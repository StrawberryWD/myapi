// 登录 / 访问记录（admin、root 风控用）。主接口和论坛接口共用。
// 真实 IP：直连时是 CF-Connecting-IP；经 Supabase 中转时那是中转服务器的 IP，
// 中转函数会带上 X-Client-IP + X-Relay-Key（和 Cloudflare 里的 RELAY_KEY 一致才采信，防伪造）。
const VISIT_GAP_MS = 30 * 60 * 1000;
const seen = new Map();          // 本实例内的快速去重：用户|IP → 上次记录时间
let tableReady = false;

export function clientInfo(request, env) {
  const h = request.headers;
  let ip = h.get('cf-connecting-ip') || '', via = 'direct';
  if (env.RELAY_KEY && h.get('x-relay-key') === env.RELAY_KEY && h.get('x-client-ip')) { ip = String(h.get('x-client-ip')).slice(0, 64); via = 'relay'; }
  const cf = request.cf || {};
  const country = (via === 'relay' ? h.get('x-client-country') : '') || cf.country || '';
  return { ip: String(ip).slice(0, 64), via, country: String(country).slice(0, 8), ua: String(h.get('user-agent') || '').slice(0, 160) };
}

async function ensureTable(db) {
  if (tableReady) return;
  await db.prepare('CREATE TABLE IF NOT EXISTS login_log (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, ts INTEGER NOT NULL, ip TEXT, country TEXT, ua TEXT, via TEXT, ok INTEGER NOT NULL DEFAULT 1, archived INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL DEFAULT \'login\')').run();
  for (const q of ['ALTER TABLE login_log ADD COLUMN archived INTEGER NOT NULL DEFAULT 0', "ALTER TABLE login_log ADD COLUMN kind TEXT NOT NULL DEFAULT 'login'"]) { try { await db.prepare(q).run(); } catch (e) {} }
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_login_user ON login_log (username, ts)').run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_login_ip ON login_log (ip)').run();
  tableReady = true;
}

// kind: 'login' = 点了登录按钮（成功或密码输错）；'visit' = 带着已有登录状态使用主页/论坛/网盘/游戏等任何功能
export async function recordAccess(db, request, env, username, kind, ok, waitUntil) {
  try {
    const c = clientInfo(request, env), now = Date.now();
    if (kind === 'visit') {
      const key = username + '|' + c.ip, last = seen.get(key);
      if (last && now - last < VISIT_GAP_MS) return;
      seen.set(key, now); if (seen.size > 2000) seen.clear();
    }
    await ensureTable(db);
    if (kind === 'visit') {
      const r = await db.prepare('SELECT ts FROM login_log WHERE username = ?1 AND ip = ?2 ORDER BY id DESC LIMIT 1').bind(username, c.ip).first();
      if (r && now - r.ts < VISIT_GAP_MS) return;
    }
    await db.prepare('INSERT INTO login_log (username, ts, ip, country, ua, via, ok, kind) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)')
      .bind(username, now, c.ip, c.country, c.ua, c.via, ok ? 1 : 0, kind).run();
    if (waitUntil) waitUntil(flushLoginLog(db, env, 1).catch(() => {}));
  } catch (e) {}   // 记录失败绝不影响业务
}

// 把还没归档的记录按天追加到 GitHub 仓库（和网盘同一个仓库/令牌）：loginlog/YYYY-MM-DD.jsonl，一行一条
export async function flushLoginLog(db, env, minPending) {
  if (!env.GH_TOKEN || !env.GH_OWNER) return 0;
  const repo = String(env.GH_REPOS || '').split(',').map((x) => x.trim()).filter(Boolean)[0];
  if (!repo) return 0;
  await ensureTable(db);
  const rows = (await db.prepare('SELECT id, username, ts, ip, country, ua, via, ok, kind FROM login_log WHERE archived = 0 ORDER BY id LIMIT 300').all()).results;
  if (!rows.length || rows.length < minPending) return 0;
  const bj = (ts) => new Date(ts + 8 * 3600e3);
  const byDay = {};
  for (const r of rows) { const d = bj(r.ts).toISOString().slice(0, 10); (byDay[d] = byDay[d] || []).push(r); }
  const base = `https://api.github.com/repos/${encodeURIComponent(env.GH_OWNER)}/${encodeURIComponent(repo)}/contents/`;
  const hd = { Authorization: 'Bearer ' + env.GH_TOKEN, Accept: 'application/vnd.github+json', 'User-Agent': '2901-loginlog', 'X-GitHub-Api-Version': '2022-11-28' };
  const br = env.GH_BRANCH ? `?ref=${encodeURIComponent(env.GH_BRANCH)}` : '';
  let done = 0;
  for (const [d, list] of Object.entries(byDay)) {
    const path = `loginlog/${d}.jsonl`;
    let old = '', sha;
    const g = await fetch(base + path + br, { headers: hd });
    if (g.ok) { const j = await g.json(); sha = j.sha; old = new TextDecoder().decode(Uint8Array.from(atob(String(j.content || '').replace(/\n/g, '')), (c) => c.charCodeAt(0))); }
    else if (g.status !== 404) continue;
    const add = list.map((r) => JSON.stringify({ id: r.id, user: r.username, time: bj(r.ts).toISOString().replace('Z', '+08:00'), kind: r.kind, ip: r.ip, country: r.country, ua: r.ua, via: r.via, ok: !!r.ok })).join('\n') + '\n';
    const bytes = new TextEncoder().encode(old + add); let bin = ''; for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    const put = await fetch(base + path, { method: 'PUT', headers: { ...hd, 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'loginlog ' + d, content: btoa(bin), ...(sha ? { sha } : {}), ...(env.GH_BRANCH ? { branch: env.GH_BRANCH } : {}) }) });
    if (!put.ok) continue;   // 冲突/失败：这批保持未归档，下次再来
    await db.prepare(`UPDATE login_log SET archived = 1 WHERE id IN (${list.map(() => '?').join(',')})`).bind(...list.map((r) => r.id)).run();
    done += list.length;
  }
  return done;
}
