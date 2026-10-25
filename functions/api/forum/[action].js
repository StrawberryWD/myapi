// 2901班 论坛接口：放在 functions/api/forum/[action].js，与现有 functions/api/[action].js 共用同一个 D1（变量名 DB）。
// 第一次请求时会自动建表，不需要手动执行 SQL。纯文字，占用空间很小。
// 登录校验方式与 [action].js 完全一致：用 sessions 表里的 token 查用户名。

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...cors } });
const fail = (error, status = 400) => json({ ok: false, error }, status);

const SESSION_MS = 30 * 24 * 3600 * 1000;
const ADMINS = ['admin', 'root'];       // 管理员：可删任何帖子/回复，可强制注销别人的账号
const LIMITS = {
  TITLE: 60,           // 标题最多字数
  POST: 2000,          // 帖子正文最多字数
  REPLY: 300,          // 单条回复最多字数
  KEEP_POSTS: 2000,    // 最多保留的帖子数，超出自动删掉最久没动静的
  MAX_REPLIES: 100,    // 每个帖子最多回复条数
  POST_GAP_MS: 20000,  // 同一用户两次发帖最小间隔
  REPLY_GAP_MS: 5000,  // 同一用户两次回复最小间隔
  PAGE: 20,            // 列表每页条数
};

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS posts (
     id INTEGER PRIMARY KEY AUTOINCREMENT, author TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
     created_at INTEGER NOT NULL, last_at INTEGER NOT NULL, reply_count INTEGER NOT NULL DEFAULT 0)`,
  'CREATE INDEX IF NOT EXISTS idx_posts_last ON posts (last_at DESC, id DESC)',
  'CREATE INDEX IF NOT EXISTS idx_posts_author ON posts (author, created_at)',
  `CREATE TABLE IF NOT EXISTS replies (
     id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER NOT NULL, author TEXT NOT NULL, body TEXT NOT NULL,
     created_at INTEGER NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS idx_replies_post ON replies (post_id, id)',
  'CREATE INDEX IF NOT EXISTS idx_replies_author ON replies (author, created_at)',
  'CREATE TABLE IF NOT EXISTS avatars (username TEXT PRIMARY KEY, mime TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL)',
];
let schemaReady = false;

function clean(s, max) {
  s = String(s == null ? '' : s).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  s = s.replace(/\n{4,}/g, '\n\n\n').trim();
  return Array.from(s).length > max ? null : s;
}

export async function onRequestOptions() {
  return new Response(null, { headers: cors });
}

// 浏览器直接打开 /api/forum/ping 检查论坛是否正常
export async function onRequestGet({ env }) {
  if (!env.DB) return json({ ok: false, error: '数据库未绑定（变量名 DB）' }, 500);
  try { await ensureSchema(env.DB); return json({ ok: true, hint: 'forum alive' }); }
  catch (e) { return json({ ok: false, error: String(e && e.message || e) }, 500); }
}

async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch(SCHEMA.map((q) => db.prepare(q)));
  schemaReady = true;
}

export async function onRequestPost(ctx) {
  try { return await route(ctx); }
  catch (e) { return json({ ok: false, error: '服务器错误：' + (e && e.message ? e.message : e) }, 500); }
}

async function route({ request, env, params }) {
  const db = env.DB;
  if (!db) return fail('数据库未绑定（Settings → Bindings，变量名 DB）', 500);
  const b = await request.json().catch(() => ({}));

  const sess = b.token
    ? await db.prepare('SELECT username, created_at FROM sessions WHERE token = ?').bind(String(b.token)).first()
    : null;
  if (!sess || Date.now() - sess.created_at > SESSION_MS) return fail('登录已过期', 401);
  const user = sess.username;
  const isAdmin = ADMINS.includes(user.toLowerCase());
  const now = Date.now();
  await ensureSchema(db);

  switch (params.action) {
    case 'list': {
      const lastAt = Number(b.last_at), lastId = Number(b.last_id);
      const cursor = b.last_at != null && Number.isFinite(lastAt) && Number.isFinite(lastId);
      const stmt = cursor
        ? db.prepare(`SELECT p.id, p.author, p.title, substr(p.body, 1, 80) AS snippet, p.created_at, p.last_at, p.reply_count, a.updated_at AS av
                      FROM posts p LEFT JOIN avatars a ON a.username = p.author
                      WHERE p.last_at < ?1 OR (p.last_at = ?1 AND p.id < ?2)
                      ORDER BY p.last_at DESC, p.id DESC LIMIT ?3`).bind(lastAt, lastId, LIMITS.PAGE + 1)
        : db.prepare(`SELECT p.id, p.author, p.title, substr(p.body, 1, 80) AS snippet, p.created_at, p.last_at, p.reply_count, a.updated_at AS av
                      FROM posts p LEFT JOIN avatars a ON a.username = p.author
                      ORDER BY p.last_at DESC, p.id DESC LIMIT ?1`).bind(LIMITS.PAGE + 1);
      const { results } = await stmt.all();
      return json({ ok: true, me: user, admin: isAdmin, posts: results.slice(0, LIMITS.PAGE), hasMore: results.length > LIMITS.PAGE });
    }

    case 'post': {
      const id = Number(b.id);
      const post = await db.prepare('SELECT p.*, a.updated_at AS av FROM posts p LEFT JOIN avatars a ON a.username = p.author WHERE p.id = ?1').bind(id).first();
      if (!post) return fail('帖子不存在或已被删除', 404);
      const { results } = await db.prepare(`SELECT r.id, r.author, r.body, r.created_at, a.updated_at AS av
                                            FROM replies r LEFT JOIN avatars a ON a.username = r.author
                                            WHERE r.post_id = ?1 ORDER BY r.id LIMIT ?2`)
        .bind(id, LIMITS.MAX_REPLIES).all();
      return json({ ok: true, me: user, admin: isAdmin, post, replies: results });
    }

    case 'create': {
      const title = clean(String(b.title || '').replace(/\s+/g, ' '), LIMITS.TITLE);
      const body = clean(b.body, LIMITS.POST);
      if (title === null) return fail(`标题最多 ${LIMITS.TITLE} 字`);
      if (body === null) return fail(`正文最多 ${LIMITS.POST} 字`);
      if (!title || !body) return fail('标题和正文都不能为空');
      if (!isAdmin) {
        const last = await db.prepare('SELECT MAX(created_at) AS t FROM posts WHERE author = ?1').bind(user).first();
        if (last && last.t && now - last.t < LIMITS.POST_GAP_MS) return fail('发得太快啦，稍等几秒再发', 429);
      }
      const r = await db.prepare('INSERT INTO posts (author, title, body, created_at, last_at, reply_count) VALUES (?1, ?2, ?3, ?4, ?4, 0)')
        .bind(user, title, body, now).run();
      const id = r.meta.last_row_id;
      if (id % 20 === 0) {   // 每 20 个帖子顺手清理一次，只留最近活跃的 KEEP_POSTS 个
        await db.batch([
          db.prepare('DELETE FROM posts WHERE id IN (SELECT id FROM posts ORDER BY last_at DESC, id DESC LIMIT -1 OFFSET ?1)').bind(LIMITS.KEEP_POSTS),
          db.prepare('DELETE FROM replies WHERE post_id NOT IN (SELECT id FROM posts)'),
        ]);
      }
      return json({ ok: true, id });
    }

    case 'reply': {
      const pid = Number(b.post_id);
      const body = clean(b.body, LIMITS.REPLY);
      if (body === null) return fail(`回复最多 ${LIMITS.REPLY} 字`);
      if (!body) return fail('回复内容不能为空');
      const post = await db.prepare('SELECT id, reply_count FROM posts WHERE id = ?1').bind(pid).first();
      if (!post) return fail('帖子不存在或已被删除', 404);
      if (post.reply_count >= LIMITS.MAX_REPLIES) return fail(`这个帖子回复已满（${LIMITS.MAX_REPLIES} 条），请新开一个帖子`);
      if (!isAdmin) {
        const last = await db.prepare('SELECT MAX(created_at) AS t FROM replies WHERE author = ?1').bind(user).first();
        if (last && last.t && now - last.t < LIMITS.REPLY_GAP_MS) return fail('回复得太快啦，稍等几秒', 429);
      }
      const res = await db.batch([
        db.prepare('INSERT INTO replies (post_id, author, body, created_at) VALUES (?1, ?2, ?3, ?4)').bind(pid, user, body, now),
        db.prepare('UPDATE posts SET reply_count = reply_count + 1, last_at = ?2 WHERE id = ?1').bind(pid, now),
      ]);
      return json({ ok: true, id: res[0].meta.last_row_id });
    }

    case 'delete': {   // 自己的帖子/回复可删；管理员可删任何人的
      const id = Number(b.id);
      if (b.type === 'post') {
        const p = await db.prepare('SELECT author FROM posts WHERE id = ?1').bind(id).first();
        if (!p) return json({ ok: true });
        if (p.author !== user && !isAdmin) return fail('只能删除自己的帖子', 403);
        await db.batch([
          db.prepare('DELETE FROM replies WHERE post_id = ?1').bind(id),
          db.prepare('DELETE FROM posts WHERE id = ?1').bind(id),
        ]);
        return json({ ok: true });
      }
      if (b.type === 'reply') {
        const r = await db.prepare('SELECT author, post_id FROM replies WHERE id = ?1').bind(id).first();
        if (!r) return json({ ok: true });
        if (r.author !== user && !isAdmin) return fail('只能删除自己的回复', 403);
        await db.batch([
          db.prepare('DELETE FROM replies WHERE id = ?1').bind(id),
          db.prepare('UPDATE posts SET reply_count = MAX(reply_count - 1, 0) WHERE id = ?1').bind(r.post_id),
        ]);
        return json({ ok: true });
      }
      return fail('参数错误');
    }

    // ---------- 管理员专用 ----------
    case 'admin_users': {
      if (!isAdmin) return fail('需要管理员权限', 403);
      const { results } = await db.prepare(
        `SELECT u.username AS username,
                (SELECT COUNT(*) FROM posts p WHERE p.author = u.username) AS posts,
                (SELECT COUNT(*) FROM replies r WHERE r.author = u.username) AS replies,
                (SELECT updated_at FROM avatars a WHERE a.username = u.username) AS av
         FROM users u ORDER BY u.username LIMIT 500`).all();
      return json({ ok: true, users: results.map((u) => ({ ...u, protected: ADMINS.includes(u.username.toLowerCase()) })) });
    }

    case 'admin_delete_user': {   // 强制注销账号：账号、存档、登录状态、论坛帖子和回复全部删除
      if (!isAdmin) return fail('需要管理员权限', 403);
      const target = String(b.target || '').trim();
      if (!target) return fail('参数错误');
      if (ADMINS.includes(target.toLowerCase())) return fail('不能删除管理员账号', 403);
      await db.batch([
        db.prepare('DELETE FROM replies WHERE post_id IN (SELECT id FROM posts WHERE author = ?1)').bind(target),
        db.prepare('DELETE FROM posts WHERE author = ?1').bind(target),
        db.prepare(`UPDATE posts SET reply_count = MAX(reply_count - (SELECT COUNT(*) FROM replies r WHERE r.post_id = posts.id AND r.author = ?1), 0)
                    WHERE id IN (SELECT post_id FROM replies WHERE author = ?1)`).bind(target),
        db.prepare('DELETE FROM replies WHERE author = ?1').bind(target),
        db.prepare('DELETE FROM avatars WHERE username = ?1').bind(target),
        db.prepare('DELETE FROM saves WHERE username = ?1').bind(target),
        db.prepare('DELETE FROM sessions WHERE username = ?1').bind(target),
        db.prepare('DELETE FROM users WHERE username = ?1').bind(target),
      ]);
      return json({ ok: true });
    }

    default:
      return fail('not found', 404);
  }
}
