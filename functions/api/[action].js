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
const HIDDEN = ['admin', 'root'];         // 不上榜、不可注销的账号；也是管理员（可看密码，密码可用中文）
const MAX_AVATAR = 150000;                // 头像 base64 最大字符数（约 110KB）；前端会把图片压到远小于此

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
  return json({ ok: true, hint: 'api alive', db, password: env.PW_KEY ? '加密存储已启用' : '未设置 PW_KEY，密码仍是明文' });
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
      const pe = pwError(username, password);
      if (pe) return json({ error: pe }, 400);
      try {
        await db.prepare('INSERT INTO users (username, password) VALUES (?, ?)')
          .bind(username, await encPw(env, password)).run();
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
    if (!row || !(await pwMatch(env, row.password, password))) return json({ error: '用户名或密码错误' }, 401);
    // 旧的明文密码：登录成功时顺手升级为加密存储
    if (env.PW_KEY && !String(row.password).startsWith(ENC_PREFIX)) {
      try { await db.prepare('UPDATE users SET password = ? WHERE username = ?').bind(await encPw(env, password), username).run(); } catch (e) {}
    }

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

  // ---------- 修改密码 ----------
  if (action === 'change_password') {
    const oldPw = String(body.old || ''), newPw = String(body.new || '');
    const row = await db.prepare('SELECT password FROM users WHERE username = ?').bind(sess.username).first();
    if (!row || !(await pwMatch(env, row.password, oldPw))) return json({ error: '当前密码不正确' }, 403);
    const pe = pwError(sess.username, newPw);
    if (pe) return json({ error: pe }, 400);
    await db.batch([
      db.prepare('UPDATE users SET password = ? WHERE username = ?').bind(await encPw(env, newPw), sess.username),
      // 改密码后，其它设备上的登录状态失效，只保留当前这个
      db.prepare('DELETE FROM sessions WHERE username = ? AND token <> ?').bind(sess.username, String(body.token)),
    ]);
    return json({ ok: true });
  }

  // ---------- 头像（前端已压缩成 256×256，约 20~60KB；服务器只接受 ≤ 150KB） ----------
  if (action === 'avatar_set') {
    const m = /^data:(image\/(?:jpeg|webp|png));base64,([A-Za-z0-9+/=]+)$/.exec(String(body.data || ''));
    if (!m || m[2].length > MAX_AVATAR) return json({ error: '头像格式不对或太大' }, 413);
    let head;
    try { head = atob(m[2].slice(0, 24)); } catch (e) { return json({ error: '头像数据损坏' }, 400); }
    const okMagic = (m[1] === 'image/jpeg' && head.startsWith('\xFF\xD8\xFF')) ||
      (m[1] === 'image/png' && head.startsWith('\x89PNG')) ||
      (m[1] === 'image/webp' && head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP');
    if (!okMagic) return json({ error: '头像不是有效的图片' }, 400);
    await ensureAvatars(db);
    const now = Date.now();
    await db.prepare(
      'INSERT INTO avatars (username, mime, data, updated_at) VALUES (?1, ?2, ?3, ?4) ' +
      'ON CONFLICT(username) DO UPDATE SET mime = excluded.mime, data = excluded.data, updated_at = excluded.updated_at'
    ).bind(sess.username, m[1], m[2], now).run();
    return json({ ok: true, v: now });
  }
  if (action === 'avatar_remove') {
    await ensureAvatars(db);
    await db.prepare('DELETE FROM avatars WHERE username = ?').bind(sess.username).run();
    return json({ ok: true });
  }

  // ---------- 管理员：查看密码 / 一键加密旧的明文密码 ----------
  if (action === 'admin_get_password' || action === 'admin_encrypt_all') {
    if (!HIDDEN.includes(sess.username.toLowerCase())) return json({ error: '需要管理员权限' }, 403);
    if (action === 'admin_get_password') {
      const row = await db.prepare('SELECT password FROM users WHERE username = ?').bind(String(body.target || '')).first();
      if (!row) return json({ error: '用户不存在' }, 404);
      const pw = await decPw(env, row.password);
      return json(pw === null ? { error: '无法解密（PW_KEY 与加密时不一致？）' } : { ok: true, password: pw }, pw === null ? 500 : 200);
    }
    if (!env.PW_KEY) return json({ error: '还没有设置 PW_KEY 密钥' }, 500);
    const { results } = await db.prepare("SELECT username, password FROM users WHERE password NOT LIKE 'enc1:%'").all();
    let n = 0;
    for (const u of results || []) {
      await db.prepare('UPDATE users SET password = ? WHERE username = ?').bind(await encPw(env, u.password), u.username).run();
      n++;
    }
    return json({ ok: true, count: n });
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
    // 同时清掉他在论坛的帖子和回复（论坛表还没建时忽略错误，不影响注销）
    try { await purgeForum(db, sess.username); } catch (e) {}
    try { await db.prepare('DELETE FROM avatars WHERE username = ?').bind(sess.username).run(); } catch (e) {}
    return json({ ok: true });
  }

  return json({ error: 'not found' }, 404);
}

// 删除某用户在论坛的全部内容（帖子连同帖子下的回复，以及他在别人帖子下的回复）
async function purgeForum(db, username) {
  // 新功能的表（点赞 / 投票 / 问卷）可能还没建，单独执行并忽略错误，不影响下面老的清理
  try {
    await db.batch([
      db.prepare('DELETE FROM likes WHERE post_id IN (SELECT id FROM posts WHERE author = ?1)').bind(username),
      db.prepare('DELETE FROM poll_votes WHERE post_id IN (SELECT id FROM posts WHERE author = ?1)').bind(username),
      db.prepare('DELETE FROM polls WHERE post_id IN (SELECT id FROM posts WHERE author = ?1)').bind(username),
      db.prepare('DELETE FROM reply_likes WHERE reply_id IN (SELECT id FROM replies WHERE author = ?1 OR post_id IN (SELECT id FROM posts WHERE author = ?1))').bind(username),
      db.prepare('DELETE FROM reply_likes WHERE username = ?1').bind(username),
      db.prepare('DELETE FROM post_topics WHERE post_id IN (SELECT id FROM posts WHERE author = ?1)').bind(username),
      db.prepare('DELETE FROM post_tags WHERE post_id IN (SELECT id FROM posts WHERE author = ?1)').bind(username),
      db.prepare('DELETE FROM pins WHERE post_id IN (SELECT id FROM posts WHERE author = ?1)').bind(username),
      db.prepare('DELETE FROM bookmarks WHERE post_id IN (SELECT id FROM posts WHERE author = ?1)').bind(username),
      db.prepare('DELETE FROM bookmarks WHERE username = ?1').bind(username),
      db.prepare('DELETE FROM bookmark_folders WHERE username = ?1').bind(username),
      db.prepare('DELETE FROM likes WHERE username = ?1').bind(username),
      db.prepare('DELETE FROM poll_votes WHERE username = ?1').bind(username),
      db.prepare('DELETE FROM survey_responses WHERE username = ?1').bind(username),
      db.prepare('DELETE FROM survey_responses WHERE survey_id IN (SELECT id FROM surveys WHERE author = ?1)').bind(username),
      db.prepare('DELETE FROM surveys WHERE author = ?1').bind(username),
    ]);
  } catch (e) {}
  await db.batch([
    db.prepare('DELETE FROM replies WHERE post_id IN (SELECT id FROM posts WHERE author = ?1)').bind(username),
    db.prepare('DELETE FROM posts WHERE author = ?1').bind(username),
    db.prepare(`UPDATE posts SET reply_count = MAX(reply_count - (SELECT COUNT(*) FROM replies r WHERE r.post_id = posts.id AND r.author = ?1), 0)
                WHERE id IN (SELECT post_id FROM replies WHERE author = ?1)`).bind(username),
    db.prepare('DELETE FROM replies WHERE author = ?1').bind(username),
  ]);
}

// ---------- 密码：AES-GCM 加密存储（可还原，管理员才能查看），密钥放在 Secret「PW_KEY」 ----------
// 没设置 PW_KEY 时仍按明文存储（旧行为），登录不受影响；设置后新密码/旧账号登录时都会变成密文。
const ENC_PREFIX = 'enc1:';
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function pwKey(env) {
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(env.PW_KEY)));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function encPw(env, plain) {
  if (!env.PW_KEY) return plain;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await pwKey(env), new TextEncoder().encode(plain)));
  const all = new Uint8Array(12 + ct.length); all.set(iv); all.set(ct, 12);
  return ENC_PREFIX + b64(all);
}
async function decPw(env, stored) {            // 解不开返回 null
  stored = String(stored);
  if (!stored.startsWith(ENC_PREFIX)) return stored;   // 旧的明文
  if (!env.PW_KEY) return null;
  try {
    const all = unb64(stored.slice(ENC_PREFIX.length));
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.slice(0, 12) }, await pwKey(env), all.slice(12));
    return new TextDecoder().decode(pt);
  } catch (e) { return null; }
}
async function pwMatch(env, stored, given) {
  const p = await decPw(env, stored);
  return p !== null && p === given;
}
// 密码规则：admin / root 可以用中文等任意字符；其他账号只能是英文字母、数字、符号（不含空格和中文），至少 6 位
function pwError(username, pw) {
  const len = Array.from(pw).length;
  if (len > 64) return '密码太长（最多 64 位）';
  if (len < 6) return '密码至少 6 位';
  if (!HIDDEN.includes(String(username).toLowerCase()) && !/^[\x21-\x7E]+$/.test(pw)) {
    return '密码只能包含英文字母、数字和符号，不能有中文或空格';
  }
  return null;
}
async function ensureAvatars(db) {
  await db.prepare('CREATE TABLE IF NOT EXISTS avatars (username TEXT PRIMARY KEY, mime TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL)').run();
}
