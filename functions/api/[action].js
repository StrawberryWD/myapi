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
    if (body.data) {
      const text = JSON.stringify(body.data);
      if (text.length > MAX_SAVE) return json({ error: '存档过大' }, 413);
      await db.prepare(
        'INSERT INTO saves (username, data, updated_at) VALUES (?, ?, ?) ' +
        'ON CONFLICT(username) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at'
      ).bind(sess.username, text, Date.now()).run();
    }
    if (action === 'logout') {
      await db.prepare('DELETE FROM sessions WHERE token = ?').bind(String(body.token)).run();
    }
    return json({ ok: true });
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
      const pts = Math.max(0, Number(d.pts) | 0);
      players.push({ username: r.username, pts, school: typeof d.school === 'string' ? d.school : null });
      if (d.spts && typeof d.spts === 'object') {
        for (const [name, v] of Object.entries(d.spts)) {
          const n = Math.max(0, Number(v) | 0);
          if (n) schools[name] = (schools[name] || 0) + n;
        }
      }
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
