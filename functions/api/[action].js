const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });

const SESSION_MS = 30 * 24 * 3600 * 1000; // 登录 30 天有效
const MAX_SAVE = 20000;                   // 存档最大字符数
const HIDDEN = ['admin', 'root'];         // 不上榜、不可注销的账号

// ---------- 防积分作弊 ----------
// 积分由前端计算，所以服务器不信任客户端上报的数值，而是用“令牌桶”限制积分增长速度：
//   · 每秒最多增长 RATE 分（正常游戏理论上限约 3.6 分/秒，这里留了余量）
//   · 桶容量 CAP：允许短时间离线/网络差后补报，但一次最多补报 CAP 分
//   · 积分只允许减少（清空进度），不允许超速增加
//   · pts 一律由服务器按 spts 求和得出，学校名必须在白名单内
const SCHOOL_NAMES = [
  '辽宁省实验中学', '东北育才高中', '沈阳二中', '沈阳市第一二六中学', '沈阳市虹桥中学',
  '沈阳市43中学', '沈阳七中', '沈阳市第一三四中学', '沈阳市南昌中学', '本溪市第一高级中学',
  '鞍山一中', '大连二十四中学', '大连育明高级中学', '雨田实验中学',
];
const SCHOOL_SET = new Set(SCHOOL_NAMES);
const RATE = 4;     // 分/秒
const CAP = 120;    // 令牌桶容量（分）

function cleanSpts(o) {
  const r = {};
  if (o && typeof o === 'object') {
    for (const k of SCHOOL_NAMES) {
      const v = Number(o[k]);
      if (Number.isFinite(v) && v > 0) r[k] = Math.min(Math.floor(v), 1e7);
    }
  }
  return r;
}

// prev：数据库里已有的存档（可信）；data：客户端上传的存档（不可信）
function applyScoring(prev, data, now) {
  const out = data && typeof data === 'object' && !Array.isArray(data) ? { ...data } : {};
  const old = cleanSpts(prev && prev.spts);
  const want = cleanSpts(out.spts);
  const claimedPts = Number(out.pts) | 0;

  let budget = CAP;
  if (prev && typeof prev._b === 'number' && typeof prev._t === 'number') {
    budget = Math.min(CAP, Math.max(0, prev._b) + (RATE * Math.max(0, now - prev._t)) / 1000);
  }

  const fin = {};
  const claims = [];
  for (const s of SCHOOL_NAMES) {
    const o = old[s] || 0, w = want[s] || 0;
    const base = w <= o ? w : o;          // 减少直接接受；增加部分按额度审批
    if (base > 0) fin[s] = base;
    if (w > o) claims.push([s, w - o]);
  }
  let clamped = false;
  for (const [s, c] of claims) {
    const g = Math.min(c, Math.floor(budget));
    if (g > 0) { fin[s] = (fin[s] || 0) + g; budget -= g; }
    if (g < c) clamped = true;
  }
  const sum = Object.values(fin).reduce((a, b) => a + b, 0);
  if (claimedPts !== sum) clamped = true;

  out.spts = fin;
  out.pts = sum;
  out.school = SCHOOL_SET.has(out.school) ? out.school : null;
  out._b = budget;          // 服务器自己维护的额度，客户端传的会被覆盖
  out._t = now;
  return { out, clamped };
}

export async function onRequestOptions() {
  return new Response(null, { headers: cors });
}

// 浏览器直接打开 /api/ping：检查接口是否在跑，以及数据库绑定、表是否正常
export async function onRequestGet({ env }) {
  let db = 'ok';
  if (!env.DB) {
    db = '未绑定：到 Settings → Bindings 添加 D1，变量名必须是 DB，然后重新部署';
  } else {
    try {
      for (const t of ['users', 'sessions', 'saves']) {
        await env.DB.prepare(`SELECT 1 FROM ${t} LIMIT 1`).first();
      }
    } catch (e) {
      db = '表缺失或出错：' + (e && e.message ? e.message : e);
    }
  }
  return json({ ok: true, hint: 'api alive', db });
}

export async function onRequestPost(ctx) {
  try {
    return await route(ctx);
  } catch (e) {
    return json({ error: '服务器错误：' + (e && e.message ? e.message : e) }, 500);
  }
}

async function route({ request, env, params }) {
  const db = env.DB;
  if (!db) return json({ error: '数据库未绑定（Settings → Bindings，变量名 DB）' }, 500);

  const body = await request.json().catch(() => ({}));
  const action = params.action;

  if (action === 'register' || action === 'login') {
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    if (!username || !password) return json({ error: '请填写用户名和密码' }, 400);
    if (username.length > 32) return json({ error: '用户名太长' }, 400);

    if (action === 'register') {
      try {
        await db.prepare('INSERT INTO users (username, password) VALUES (?, ?)')
          .bind(username, password).run();
        return json({ ok: true });
      } catch (e) {
        if (/UNIQUE|constraint/i.test(String(e && e.message))) {
          return json({ error: '用户名已存在' }, 409);
        }
        throw e; // 其它错误（比如没建表）交给外层，返回真实原因
      }
    }

    const row = await db.prepare('SELECT password FROM users WHERE username = ?')
      .bind(username).first();
    if (!row || row.password !== password) return json({ error: '用户名或密码错误' }, 401);

    const token = crypto.randomUUID();
    await db.prepare('INSERT INTO sessions (token, username, created_at) VALUES (?, ?, ?)')
      .bind(token, username, Date.now()).run();
    return json({ ok: true, username, token });
  }

  // 下面的接口都需要登录令牌
  const sess = body.token
    ? await db.prepare('SELECT username, created_at FROM sessions WHERE token = ?')
        .bind(String(body.token)).first()
    : null;
  if (!sess || Date.now() - sess.created_at > SESSION_MS) {
    return json({ error: '登录已过期' }, 401);
  }

  if (action === 'load') {
    const row = await db.prepare('SELECT data FROM saves WHERE username = ?')
      .bind(sess.username).first();
    let data = null;
    if (row) { try { data = JSON.parse(row.data); } catch {} }
    return json({ ok: true, data });
  }

  if (action === 'save' || action === 'logout') {
    let fix;
    if (body.data) {
      const prevRow = await db.prepare('SELECT data FROM saves WHERE username = ?')
        .bind(sess.username).first();
      let prev = null;
      if (prevRow) { try { prev = JSON.parse(prevRow.data); } catch {} }

      const { out, clamped } = applyScoring(prev, body.data, Date.now());
      const text = JSON.stringify(out);
      if (text.length > MAX_SAVE) return json({ error: '存档过大' }, 413);
      await db.prepare(
        'INSERT INTO saves (username, data, updated_at) VALUES (?, ?, ?) ' +
        'ON CONFLICT(username) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at'
      ).bind(sess.username, text, Date.now()).run();
      if (clamped) fix = { pts: out.pts, spts: out.spts };   // 通知前端：积分已被服务器校正
    }
    if (action === 'logout') {
      await db.prepare('DELETE FROM sessions WHERE token = ?').bind(String(body.token)).run();
    }
    return json(fix ? { ok: true, fix } : { ok: true });
  }

  // ---------- 排行榜：学校总积分 + 个人总积分（不含 admin / root） ----------
  if (action === 'rank') {
    const { results } = await db.prepare(
      `SELECT username, data FROM saves WHERE lower(username) NOT IN (${HIDDEN.map(() => '?').join(',')})`
    ).bind(...HIDDEN).all();

    const schools = {};
    const players = [];
    for (const r of results || []) {
      let d;
      try { d = JSON.parse(r.data); } catch { continue; }
      if (!d || typeof d !== 'object') continue;
      // 只信 spts（白名单学校、取整），个人积分由它求和得出
      const sp = cleanSpts(d.spts);
      let pts = 0;
      for (const [name, n] of Object.entries(sp)) {
        pts += n;
        schools[name] = (schools[name] || 0) + n;
      }
      players.push({ username: r.username, pts, school: SCHOOL_SET.has(d.school) ? d.school : null });
    }
    players.sort((a, b) => b.pts - a.pts);
    return json({
      ok: true,
      schools: Object.entries(schools).map(([name, pts]) => ({ name, pts })),
      players: players.slice(0, 100),
    });
  }

  // ---------- 注销账户：删除用户、存档、所有登录会话 ----------
  if (action === 'delete') {
    if (HIDDEN.includes(sess.username.toLowerCase())) {
      return json({ error: '该账户不允许注销' }, 403);
    }
    await db.batch([
      db.prepare('DELETE FROM saves WHERE username = ?').bind(sess.username),
      db.prepare('DELETE FROM sessions WHERE username = ?').bind(sess.username),
      db.prepare('DELETE FROM users WHERE username = ?').bind(sess.username),
    ]);
    return json({ ok: true });
  }

  return json({ error: 'not found' }, 404);
}
