// 2901班 论坛接口：放在 functions/api/forum/[action].js，与现有 functions/api/[action].js 共用同一个 D1（变量名 DB）。
// 包含：帖子 / 回复 / 点赞 / 帖子投票 / 问卷调查。投票和问卷对其他人匿名：数据库里存了用户名只是为了「每人限一次」，接口不会返回任何人的选择。
// 第一次请求时会自动建表，不需要手动执行 SQL。纯文字，占用空间很小。
// 登录校验方式与 [action].js 完全一致：用 sessions 表里的 token 查用户名。

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...cors } });
const fail = (error, status = 400, code) => json(code ? { ok: false, error, code } : { ok: false, error }, status);   // code 供前端按语言显示提示

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
  POLL_OPTS_MIN: 2, POLL_OPTS_MAX: 10, POLL_OPT_LEN: 40, POLL_MAX_HOURS: 24 * 30,   // 帖子投票
  SV_TITLE: 60, SV_DESC: 300, SV_Q_MAX: 20, SV_Q_LEN: 100, SV_OPTS_MAX: 12, SV_OPT_LEN: 60, SV_TEXT: 200,   // 问卷
  SV_GAP_MS: 30000,    // 同一用户两次建问卷最小间隔
  KEEP_SURVEYS: 300,   // 最多保留的问卷数
  SV_PAGE: 50,
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
  // 点赞：每人每帖一个
  'CREATE TABLE IF NOT EXISTS likes (post_id INTEGER NOT NULL, username TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (post_id, username))',
  'CREATE INDEX IF NOT EXISTS idx_likes_user ON likes (username)',
  // 帖子投票：options 是 JSON 数组；poll_votes 每个被选中的选项一行
  'CREATE TABLE IF NOT EXISTS polls (post_id INTEGER PRIMARY KEY, multi INTEGER NOT NULL DEFAULT 0, closes_at INTEGER, options TEXT NOT NULL, anon INTEGER NOT NULL DEFAULT 1, vis TEXT NOT NULL DEFAULT \'after\')',
  'CREATE TABLE IF NOT EXISTS poll_votes (post_id INTEGER NOT NULL, username TEXT NOT NULL, opt INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (post_id, username, opt))',
  // 问卷
  `CREATE TABLE IF NOT EXISTS surveys (
     id INTEGER PRIMARY KEY AUTOINCREMENT, author TEXT NOT NULL, title TEXT NOT NULL, descr TEXT NOT NULL DEFAULT '',
     questions TEXT NOT NULL, created_at INTEGER NOT NULL, closes_at INTEGER, closed INTEGER NOT NULL DEFAULT 0,
     anon INTEGER NOT NULL DEFAULT 1, vis TEXT NOT NULL DEFAULT 'after', texts_public INTEGER NOT NULL DEFAULT 0)`,
  'CREATE INDEX IF NOT EXISTS idx_surveys_author ON surveys (author, created_at)',
  `CREATE TABLE IF NOT EXISTS survey_responses (
     survey_id INTEGER NOT NULL, username TEXT NOT NULL, answers TEXT NOT NULL, created_at INTEGER NOT NULL,
     PRIMARY KEY (survey_id, username))`,
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
  // 旧版本已建好的表补上「匿名 / 公开范围」列（已有则忽略报错）：旧的投票和问卷保持原来的行为（匿名、投完 / 填完才能看结果）
  const ALTERS = [
    "ALTER TABLE polls ADD COLUMN anon INTEGER NOT NULL DEFAULT 1", "ALTER TABLE polls ADD COLUMN vis TEXT NOT NULL DEFAULT 'after'",
    "ALTER TABLE surveys ADD COLUMN anon INTEGER NOT NULL DEFAULT 1", "ALTER TABLE surveys ADD COLUMN vis TEXT NOT NULL DEFAULT 'after'",
    "ALTER TABLE surveys ADD COLUMN texts_public INTEGER NOT NULL DEFAULT 0",
  ];
  for (const q of ALTERS) { try { await db.prepare(q).run(); } catch (e) { /* 列已存在 */ } }
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
        ? db.prepare(`SELECT p.id, p.author, p.title, substr(p.body, 1, 80) AS snippet, p.created_at, p.last_at, p.reply_count, a.updated_at AS av,
                             (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS like_count,
                             (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id AND l.username = ?4) AS liked,
                             (SELECT COUNT(*) FROM polls o WHERE o.post_id = p.id) AS has_poll
                      FROM posts p LEFT JOIN avatars a ON a.username = p.author
                      WHERE p.last_at < ?1 OR (p.last_at = ?1 AND p.id < ?2)
                      ORDER BY p.last_at DESC, p.id DESC LIMIT ?3`).bind(lastAt, lastId, LIMITS.PAGE + 1, user)
        : db.prepare(`SELECT p.id, p.author, p.title, substr(p.body, 1, 80) AS snippet, p.created_at, p.last_at, p.reply_count, a.updated_at AS av,
                             (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS like_count,
                             (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id AND l.username = ?2) AS liked,
                             (SELECT COUNT(*) FROM polls o WHERE o.post_id = p.id) AS has_poll
                      FROM posts p LEFT JOIN avatars a ON a.username = p.author
                      ORDER BY p.last_at DESC, p.id DESC LIMIT ?1`).bind(LIMITS.PAGE + 1, user);
      const { results } = await stmt.all();
      return json({ ok: true, me: user, admin: isAdmin, posts: results.slice(0, LIMITS.PAGE).map((r) => ({ ...r, liked: !!r.liked, has_poll: !!r.has_poll })), hasMore: results.length > LIMITS.PAGE });
    }

    case 'post': {
      const id = Number(b.id);
      const post = await db.prepare('SELECT p.*, a.updated_at AS av FROM posts p LEFT JOIN avatars a ON a.username = p.author WHERE p.id = ?1').bind(id).first();
      if (!post) return fail('帖子不存在或已被删除', 404);
      const { results } = await db.prepare(`SELECT r.id, r.author, r.body, r.created_at, a.updated_at AS av
                                            FROM replies r LEFT JOIN avatars a ON a.username = r.author
                                            WHERE r.post_id = ?1 ORDER BY r.id LIMIT ?2`)
        .bind(id, LIMITS.MAX_REPLIES).all();
      const lk = await db.prepare('SELECT COUNT(*) AS n, SUM(username = ?2) AS me FROM likes WHERE post_id = ?1').bind(id, user).first();
      post.like_count = (lk && lk.n) || 0; post.liked = !!(lk && lk.me);
      return json({ ok: true, me: user, admin: isAdmin, post, replies: results, poll: await loadPoll(db, id, user, now, isAdmin) });
    }

    case 'create': {
      const title = clean(String(b.title || '').replace(/\s+/g, ' '), LIMITS.TITLE);
      const body = clean(b.body, LIMITS.POST);
      if (title === null) return fail(`标题最多 ${LIMITS.TITLE} 字`);
      if (body === null) return fail(`正文最多 ${LIMITS.POST} 字`);
      if (!title || !body) return fail('标题和正文都不能为空');
      let poll = null;
      if (b.poll) { poll = parsePoll(b.poll, now); if (typeof poll === 'string') return fail(poll, 400, 'poll_invalid'); }
      if (!isAdmin) {
        const last = await db.prepare('SELECT MAX(created_at) AS t FROM posts WHERE author = ?1').bind(user).first();
        if (last && last.t && now - last.t < LIMITS.POST_GAP_MS) return fail('发得太快啦，稍等几秒再发', 429);
      }
      const r = await db.prepare('INSERT INTO posts (author, title, body, created_at, last_at, reply_count) VALUES (?1, ?2, ?3, ?4, ?4, 0)')
        .bind(user, title, body, now).run();
      const id = r.meta.last_row_id;
      if (poll) await db.prepare('INSERT INTO polls (post_id, multi, closes_at, options, anon, vis) VALUES (?1, ?2, ?3, ?4, ?5, ?6)').bind(id, poll.multi, poll.closes_at, JSON.stringify(poll.options), poll.anon, poll.vis).run();
      if (id % 20 === 0) {   // 每 20 个帖子顺手清理一次，只留最近活跃的 KEEP_POSTS 个
        await db.batch([
          db.prepare('DELETE FROM posts WHERE id IN (SELECT id FROM posts ORDER BY last_at DESC, id DESC LIMIT -1 OFFSET ?1)').bind(LIMITS.KEEP_POSTS),
          db.prepare('DELETE FROM replies WHERE post_id NOT IN (SELECT id FROM posts)'),
          db.prepare('DELETE FROM likes WHERE post_id NOT IN (SELECT id FROM posts)'),
          db.prepare('DELETE FROM polls WHERE post_id NOT IN (SELECT id FROM posts)'),
          db.prepare('DELETE FROM poll_votes WHERE post_id NOT IN (SELECT id FROM posts)'),
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
          db.prepare('DELETE FROM likes WHERE post_id = ?1').bind(id),
          db.prepare('DELETE FROM poll_votes WHERE post_id = ?1').bind(id),
          db.prepare('DELETE FROM polls WHERE post_id = ?1').bind(id),
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

    // ---------- 点赞：再点一次取消 ----------
    case 'like': {
      const pid = Number(b.post_id);
      const post = await db.prepare('SELECT id FROM posts WHERE id = ?1').bind(pid).first();
      if (!post) return fail('帖子不存在或已被删除', 404);
      const had = await db.prepare('SELECT 1 AS x FROM likes WHERE post_id = ?1 AND username = ?2').bind(pid, user).first();
      if (had) await db.prepare('DELETE FROM likes WHERE post_id = ?1 AND username = ?2').bind(pid, user).run();
      else await db.prepare('INSERT OR IGNORE INTO likes (post_id, username, created_at) VALUES (?1, ?2, ?3)').bind(pid, user, now).run();
      const n = await db.prepare('SELECT COUNT(*) AS n FROM likes WHERE post_id = ?1').bind(pid).first();
      return json({ ok: true, liked: !had, count: n.n });
    }

    // ---------- 帖子投票：每人每个投票只能投一次，投完不能改 ----------
    case 'poll_vote': {
      const pid = Number(b.post_id);
      const po = await db.prepare('SELECT multi, closes_at, options FROM polls WHERE post_id = ?1').bind(pid).first();
      if (!po) return fail('这个帖子没有投票', 404, 'poll_none');
      if (po.closes_at && now > po.closes_at) return fail('投票已截止', 400, 'poll_closed');
      const opts = JSON.parse(po.options);
      let sel = Array.isArray(b.options) ? b.options.map(Number) : [];
      sel = [...new Set(sel)];
      if (!sel.length) return fail('请至少选一项', 400, 'poll_pick');
      if (sel.some((i) => !Number.isInteger(i) || i < 0 || i >= opts.length)) return fail('参数错误');
      if (!po.multi && sel.length > 1) return fail('这个投票只能单选', 400, 'poll_single');
      const done = await db.prepare('SELECT 1 AS x FROM poll_votes WHERE post_id = ?1 AND username = ?2 LIMIT 1').bind(pid, user).first();
      if (done) return fail('你已经投过票了', 400, 'poll_done');
      await db.batch(sel.map((i) => db.prepare('INSERT OR IGNORE INTO poll_votes (post_id, username, opt, created_at) VALUES (?1, ?2, ?3, ?4)').bind(pid, user, i, now)));
      return json({ ok: true, poll: await loadPoll(db, pid, user, now, isAdmin) });
    }

    // ---------- 问卷 ----------
    case 'survey_list': {
      const { results } = await db.prepare(
        `SELECT s.id, s.author, s.title, s.created_at, s.closes_at, s.closed, a.updated_at AS av,
                (SELECT COUNT(*) FROM survey_responses r WHERE r.survey_id = s.id) AS resp_count,
                (SELECT COUNT(*) FROM survey_responses r WHERE r.survey_id = s.id AND r.username = ?1) AS done
         FROM surveys s LEFT JOIN avatars a ON a.username = s.author
         ORDER BY s.id DESC LIMIT ?2`).bind(user, LIMITS.SV_PAGE).all();
      return json({ ok: true, me: user, admin: isAdmin, surveys: results.map((s) => ({ ...s, done: !!s.done, closed: svClosed(s, now) })) });
    }

    case 'survey_get': {
      const sv = await db.prepare('SELECT s.*, a.updated_at AS av FROM surveys s LEFT JOIN avatars a ON a.username = s.author WHERE s.id = ?1').bind(Number(b.id)).first();
      if (!sv) return fail('问卷不存在或已被删除', 404, 'sv_gone');
      const mine = await db.prepare('SELECT answers FROM survey_responses WHERE survey_id = ?1 AND username = ?2').bind(sv.id, user).first();
      const cnt = await db.prepare('SELECT COUNT(*) AS n FROM survey_responses WHERE survey_id = ?1').bind(sv.id).first();
      const owner = sv.author === user;
      return json({ ok: true, me: user, admin: isAdmin, survey: {
        id: sv.id, author: sv.author, av: sv.av, title: sv.title, descr: sv.descr, created_at: sv.created_at, closes_at: sv.closes_at,
        closed: svClosed(sv, now), questions: JSON.parse(sv.questions), resp_count: cnt.n,
        anon: !!sv.anon, vis: sv.vis, texts_public: !!sv.texts_public,
      }, done: !!mine, my_answers: mine ? JSON.parse(mine.answers) : null, owner, can_results: owner || isAdmin || sv.vis === 'public' || (sv.vis === 'after' && !!mine) });
    }

    case 'survey_create': {
      const title = clean(String(b.title || '').replace(/\s+/g, ' '), LIMITS.SV_TITLE);
      const descr = clean(b.descr, LIMITS.SV_DESC);
      if (title === null) return fail(`标题最多 ${LIMITS.SV_TITLE} 字`, 400, 'sv_title_len');
      if (descr === null) return fail(`说明最多 ${LIMITS.SV_DESC} 字`, 400, 'sv_desc_len');
      if (!title) return fail('请填写问卷标题', 400, 'sv_title_empty');
      const qs = parseQuestions(b.questions);
      if (typeof qs === 'string') return fail(qs, 400, 'sv_invalid');
      let closes = null;
      const hrs = Number(b.hours);
      if (hrs > 0) closes = now + Math.min(hrs, 24 * 90) * 3600000;
      if (!isAdmin) {
        const last = await db.prepare('SELECT MAX(created_at) AS t FROM surveys WHERE author = ?1').bind(user).first();
        if (last && last.t && now - last.t < LIMITS.SV_GAP_MS) return fail('创建得太快啦，稍等几秒再建', 429, 'too_fast');
      }
      const r = await db.prepare('INSERT INTO surveys (author, title, descr, questions, created_at, closes_at, closed, anon, vis, texts_public) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8, ?9)')
        .bind(user, title, descr || '', JSON.stringify(qs), now, closes, b.anon === false || b.anon === 0 ? 0 : 1, VIS.includes(b.vis) ? b.vis : 'after', b.texts_public ? 1 : 0).run();
      const id = r.meta.last_row_id;
      if (id % 20 === 0) {
        await db.batch([
          db.prepare('DELETE FROM surveys WHERE id IN (SELECT id FROM surveys ORDER BY id DESC LIMIT -1 OFFSET ?1)').bind(LIMITS.KEEP_SURVEYS),
          db.prepare('DELETE FROM survey_responses WHERE survey_id NOT IN (SELECT id FROM surveys)'),
        ]);
      }
      return json({ ok: true, id });
    }

    case 'survey_submit': {
      const sv = await db.prepare('SELECT * FROM surveys WHERE id = ?1').bind(Number(b.id)).first();
      if (!sv) return fail('问卷不存在或已被删除', 404, 'sv_gone');
      if (svClosed(sv, now)) return fail('问卷已关闭', 400, 'sv_closed');
      const done = await db.prepare('SELECT 1 AS x FROM survey_responses WHERE survey_id = ?1 AND username = ?2').bind(sv.id, user).first();
      if (done) return fail('你已经填过这份问卷了', 400, 'sv_done');
      const ans = checkAnswers(JSON.parse(sv.questions), b.answers);
      if (typeof ans === 'string') return fail(ans.split('|')[1] || ans, 400, ans.split('|')[0]);
      await db.prepare('INSERT OR IGNORE INTO survey_responses (survey_id, username, answers, created_at) VALUES (?1, ?2, ?3, ?4)').bind(sv.id, user, JSON.stringify(ans), now).run();
      return json({ ok: true });
    }

    case 'survey_results': {   // 谁能看由发起人设定（vis）；发起人和管理员永远能看。匿名问卷不返回任何人的身份
      const sv = await db.prepare('SELECT * FROM surveys WHERE id = ?1').bind(Number(b.id)).first();
      if (!sv) return fail('问卷不存在或已被删除', 404, 'sv_gone');
      const full = sv.author === user || isAdmin;
      if (!full) {
        if (sv.vis === 'owner') return fail('这份问卷的结果只有发起人能看', 403, 'sv_owner_only');
        if (sv.vis === 'after') {
          const mine = await db.prepare('SELECT 1 AS x FROM survey_responses WHERE survey_id = ?1 AND username = ?2').bind(sv.id, user).first();
          if (!mine) return fail('填写后才能查看结果', 403, 'sv_need_submit');
        }
      }
      const showTexts = full || !!sv.texts_public;
      const named = !sv.anon;
      const qs = JSON.parse(sv.questions);
      const { results } = await db.prepare('SELECT username, answers FROM survey_responses WHERE survey_id = ?1 ORDER BY created_at').bind(sv.id).all();
      const out = qs.map((q) => ({
        counts: q.t === 'text' ? undefined : q.opts.map(() => 0), answered: 0,
        names: q.t !== 'text' && named ? q.opts.map(() => []) : undefined,
        texts: q.t === 'text' && showTexts ? [] : undefined,
      }));
      for (const row of results) {
        let a; try { a = JSON.parse(row.answers); } catch { continue; }
        qs.forEach((q, i) => {
          const v = a[i];
          if (q.t === 'single') { if (Number.isInteger(v) && out[i].counts[v] != null) { out[i].counts[v]++; out[i].answered++; if (out[i].names) out[i].names[v].push(row.username); } }
          else if (q.t === 'multi') { if (Array.isArray(v) && v.length) { out[i].answered++; v.forEach((k) => { if (out[i].counts[k] != null) { out[i].counts[k]++; if (out[i].names) out[i].names[k].push(row.username); } }); } }
          else if (typeof v === 'string' && v) { out[i].answered++; if (showTexts) out[i].texts.push(named ? { u: row.username, v } : v); }
        });
      }
      // 匿名问卷的填空内容打乱顺序，避免从提交先后猜出是谁
      if (!named) out.forEach((o) => { if (o.texts) o.texts.sort(() => Math.random() - 0.5); });
      return json({ ok: true, total: results.length, full, anon: !sv.anon ? false : true, vis: sv.vis, texts_public: !!sv.texts_public, questions: out });
    }

    case 'survey_close': {   // 发起人 / 管理员：关闭或重新开放
      const sv = await db.prepare('SELECT author, closed FROM surveys WHERE id = ?1').bind(Number(b.id)).first();
      if (!sv) return fail('问卷不存在或已被删除', 404, 'sv_gone');
      if (sv.author !== user && !isAdmin) return fail('只有发起人能操作', 403, 'sv_forbidden');
      await db.prepare('UPDATE surveys SET closed = ?2, closes_at = CASE WHEN ?2 = 0 THEN NULL ELSE closes_at END WHERE id = ?1').bind(Number(b.id), sv.closed ? 0 : 1).run();
      return json({ ok: true, closed: !sv.closed });
    }

    case 'survey_delete': {
      const sv = await db.prepare('SELECT author FROM surveys WHERE id = ?1').bind(Number(b.id)).first();
      if (!sv) return json({ ok: true });
      if (sv.author !== user && !isAdmin) return fail('只能删除自己的问卷', 403, 'sv_forbidden');
      await db.batch([
        db.prepare('DELETE FROM survey_responses WHERE survey_id = ?1').bind(Number(b.id)),
        db.prepare('DELETE FROM surveys WHERE id = ?1').bind(Number(b.id)),
      ]);
      return json({ ok: true });
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
        ...userContentCleanup(db, target),
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

// ---------- 辅助：投票 / 问卷 ----------
// 注销账号时要一起清掉的新数据：他的点赞、投票、问卷答卷、他发的问卷，以及他的帖子上的点赞 / 投票
// （同样的清理在 functions/api/[action].js 的 purgeForum 里也有一份，改这里时记得同步）
function userContentCleanup(db, u) {
  return [
    db.prepare('DELETE FROM likes WHERE post_id IN (SELECT id FROM posts WHERE author = ?1)').bind(u),
    db.prepare('DELETE FROM poll_votes WHERE post_id IN (SELECT id FROM posts WHERE author = ?1)').bind(u),
    db.prepare('DELETE FROM polls WHERE post_id IN (SELECT id FROM posts WHERE author = ?1)').bind(u),
    db.prepare('DELETE FROM likes WHERE username = ?1').bind(u),
    db.prepare('DELETE FROM poll_votes WHERE username = ?1').bind(u),
    db.prepare('DELETE FROM survey_responses WHERE username = ?1').bind(u),
    db.prepare('DELETE FROM survey_responses WHERE survey_id IN (SELECT id FROM surveys WHERE author = ?1)').bind(u),
    db.prepare('DELETE FROM surveys WHERE author = ?1').bind(u),
  ];
}

// 结果公开范围：public 所有人随时可看；after 投完 / 填完（或投票已截止）才能看；owner 只有发起人和管理员能看
const VIS = ['public', 'after', 'owner'];
const svClosed = (s, now) => !!s.closed || !!(s.closes_at && now > s.closes_at);

// 帖子投票：校验发帖时附带的 poll = { options: [...], multi: bool, hours: number|null }，出错返回字符串
function parsePoll(p, now) {
  if (!p || typeof p !== 'object') return '投票参数错误';
  const raw = Array.isArray(p.options) ? p.options : [];
  const opts = [];
  for (const o of raw) {
    const t = clean(String(o == null ? '' : o).replace(/\s+/g, ' '), LIMITS.POLL_OPT_LEN);
    if (t === null) return `每个选项最多 ${LIMITS.POLL_OPT_LEN} 字`;
    if (t && !opts.includes(t)) opts.push(t);
  }
  if (opts.length < LIMITS.POLL_OPTS_MIN) return `投票至少要有 ${LIMITS.POLL_OPTS_MIN} 个不同的选项`;
  if (opts.length > LIMITS.POLL_OPTS_MAX) return `投票最多 ${LIMITS.POLL_OPTS_MAX} 个选项`;
  const hrs = Number(p.hours);
  const closes_at = hrs > 0 ? now + Math.min(hrs, LIMITS.POLL_MAX_HOURS) * 3600000 : null;
  return { options: opts, multi: p.multi ? 1 : 0, closes_at, anon: p.anon === false || p.anon === 0 ? 0 : 1, vis: VIS.includes(p.vis) ? p.vis : 'after' };
}

// 读取某个帖子的投票：选项、总人数、我投了哪些；票数 / 名单只在「有权看结果」时才返回
// 匿名投票（anon=1）永远不返回任何人的身份；实名投票（anon=0）在有权看结果时返回每个选项的投票人名单
async function loadPoll(db, pid, user, now, isAdmin) {
  const po = await db.prepare('SELECT p.multi, p.closes_at, p.options, p.anon, p.vis, s.author FROM polls p JOIN posts s ON s.id = p.post_id WHERE p.post_id = ?1').bind(pid).first();
  if (!po) return null;
  const options = JSON.parse(po.options);
  const closed = !!(po.closes_at && now > po.closes_at);
  const owner = po.author === user;
  const tv = await db.prepare('SELECT COUNT(DISTINCT username) AS n FROM poll_votes WHERE post_id = ?1').bind(pid).first();
  const mine = await db.prepare('SELECT opt FROM poll_votes WHERE post_id = ?1 AND username = ?2 ORDER BY opt').bind(pid, user).all();
  const voted = mine.results.length > 0;
  const canSee = po.vis === 'public' || owner || isAdmin || (po.vis === 'after' && (voted || closed));
  const out = {
    options, multi: !!po.multi, closes_at: po.closes_at, closed, anon: !!po.anon, vis: po.vis, owner,
    voters: tv.n, mine: mine.results.map((r) => r.opt), can_see: canSee, counts: null, names: null,
  };
  if (canSee) {
    const { results } = await db.prepare('SELECT opt, username FROM poll_votes WHERE post_id = ?1 ORDER BY created_at, username').bind(pid).all();
    out.counts = options.map(() => 0);
    if (!po.anon) out.names = options.map(() => []);
    for (const r of results) if (out.counts[r.opt] != null) { out.counts[r.opt]++; if (out.names) out.names[r.opt].push(r.username); }
  }
  return out;
}

// 问卷题目校验：[{ t: 'single'|'multi'|'text', q: '题目', opts: [...], req: bool }]
function parseQuestions(raw) {
  if (!Array.isArray(raw) || !raw.length) return '问卷至少要有 1 道题';
  if (raw.length > LIMITS.SV_Q_MAX) return `问卷最多 ${LIMITS.SV_Q_MAX} 道题`;
  const out = [];
  for (const q of raw) {
    if (!q || !['single', 'multi', 'text'].includes(q.t)) return '题型错误';
    const text = clean(String(q.q || '').replace(/\s+/g, ' '), LIMITS.SV_Q_LEN);
    if (text === null) return `题目最多 ${LIMITS.SV_Q_LEN} 字`;
    if (!text) return '题目不能为空';
    const item = { t: q.t, q: text, req: q.req ? 1 : 0 };
    if (q.t !== 'text') {
      const opts = [];
      for (const o of Array.isArray(q.opts) ? q.opts : []) {
        const t = clean(String(o == null ? '' : o).replace(/\s+/g, ' '), LIMITS.SV_OPT_LEN);
        if (t === null) return `每个选项最多 ${LIMITS.SV_OPT_LEN} 字`;
        if (t && !opts.includes(t)) opts.push(t);
      }
      if (opts.length < 2) return '选择题至少要有 2 个不同的选项';
      if (opts.length > LIMITS.SV_OPTS_MAX) return `选择题最多 ${LIMITS.SV_OPTS_MAX} 个选项`;
      item.opts = opts;
    }
    out.push(item);
  }
  return out;
}

// 校验答卷，返回规整后的答案数组；出错返回「错误码|提示」字符串
function checkAnswers(qs, a) {
  if (!Array.isArray(a) || a.length !== qs.length) return 'sv_invalid|参数错误';
  const out = [];
  for (let i = 0; i < qs.length; i++) {
    const q = qs[i], v = a[i];
    if (q.t === 'single') {
      if (v == null || v === '') { if (q.req) return `sv_required|第 ${i + 1} 题必须回答`; out.push(null); continue; }
      if (!Number.isInteger(v) || v < 0 || v >= q.opts.length) return 'sv_invalid|参数错误';
      out.push(v);
    } else if (q.t === 'multi') {
      const arr = Array.isArray(v) ? [...new Set(v)] : [];
      if (!arr.length) { if (q.req) return `sv_required|第 ${i + 1} 题必须回答`; out.push([]); continue; }
      if (arr.some((k) => !Number.isInteger(k) || k < 0 || k >= q.opts.length)) return 'sv_invalid|参数错误';
      out.push(arr.sort((x, y) => x - y));
    } else {
      const t = clean(v == null ? '' : v, LIMITS.SV_TEXT);
      if (t === null) return `sv_text_len|填空最多 ${LIMITS.SV_TEXT} 字`;
      if (!t) { if (q.req) return `sv_required|第 ${i + 1} 题必须回答`; out.push(''); continue; }
      out.push(t);
    }
  }
  return out;
}
