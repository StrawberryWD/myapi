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

export async function onRequestOptions() {
  return new Response(null, { headers: cors });
}

// 浏览器直接打开 /api/ping 用来测试接口是否正常
export async function onRequestGet() {
  return json({ ok: true, hint: 'api alive' });
}

export async function onRequestPost({ request, env, params }) {
  const body = await request.json().catch(() => ({}));
  const db = env.DB;
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
      } catch {
        return json({ error: '用户名已存在' }, 409);
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

  return json({ error: 'not found' }, 404);
}
