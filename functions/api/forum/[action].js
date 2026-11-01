// 2901班 论坛接口：放在 functions/api/forum/[action].js，与现有 functions/api/[action].js 共用同一个 D1（变量名 DB）。
// 包含：帖子 / 回复 / 点赞 / 帖子投票 / 问卷调查。投票和问卷对其他人匿名：数据库里存了用户名只是为了「每人限一次」，接口不会返回任何人的选择。
// 第一次请求时会自动建表，不需要手动执行 SQL。纯文字，占用空间很小。
// 登录校验方式与 [action].js 完全一致：用 sessions 表里的 token 查用户名。

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Drive',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Expose-Headers': 'Content-Disposition',
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
  MAX_REPLIES: 100,    // 每个帖子最多回复条数
  POST_GAP_MS: 20000,  // 同一用户两次发帖最小间隔
  REPLY_GAP_MS: 5000,  // 同一用户两次回复最小间隔
  PAGE: 20,            // 列表每页条数
  POLL_OPTS_MIN: 2, POLL_OPTS_MAX: 10, POLL_OPT_LEN: 40, POLL_MAX_HOURS: 24 * 30,   // 帖子投票
  SV_TITLE: 60, SV_DESC: 300, SV_Q_MAX: 20, SV_Q_LEN: 100, SV_OPTS_MAX: 12, SV_OPT_LEN: 60, SV_TEXT: 200,   // 问卷
  SV_GAP_MS: 30000,    // 同一用户两次建问卷最小间隔
  KEEP_SURVEYS: 300,   // 最多保留的问卷数
  SV_PAGE: 50,
  TOPIC_NAME: 20, TOPIC_DESC: 100, TOPICS_MAX: 200, TOPICS_PER_POST: 3, TAGS_PER_POST: 5, TAG_LEN: 20,   // 话题 / 标签
  PIN_MAX: 3,          // 每个范围（全站 / 某话题）最多同时置顶几条
  DM_LEN: 500, DM_GAP_MS: 800, DM_DAILY: 300, DM_PAGE: 50, DM_RECALL_MS: 10 * 60 * 1000, REPORT_MAX_MSGS: 20, REPORT_DAILY: 10, REASON_LEN: 200,   // 私信
  BIO: 200, PEOPLE_PAGE: 30, PROFILE_PAGE: 20,   // 个人主页
  MAX_DEPTH: 2,        // 评论嵌套：0 / 1 / 2 共 3 层，更深的回复归到第 3 层
  FOLDER_NAME: 20, FOLDERS_MAX: 20, MARK_PAGE: 20,   // 收藏夹
  TOPIC_GAP_MS: 10000, // 同一用户两次建话题最小间隔
  // 2901网盘
  DRIVE_QUOTA: 500 * 1024 * 1024, DRIVE_FILE_MAX: 25 * 1024 * 1024, IMG_QUOTA: 100 * 1024 * 1024, IMG_MAX: 2 * 1024 * 1024, IMG_DAILY: 40, UP_DAILY: 100,
  REPO_SOFT: 800 * 1024 * 1024, DRIVE_NAME: 80, DFOLDER_NAME: 30, DFOLDERS_MAX: 100, DFOLDER_DEPTH: 3, DRIVE_PAGE: 50, SHARE_USERS_MAX: 20,
  ATT_POST_IMGS: 9, ATT_POST_FILES: 5, ATT_DM: 1, ORPHAN_MS: 2 * 3600 * 1000,
};
const EMSG = {
  topics_many: '每个帖子最多选 3 个话题', tags_many: '每个帖子最多 5 个标签', tag_len: '标签最多 20 字', topic_gone: '话题不存在',
  topic_exists: '已有同名话题', topic_name: '请填写话题名称（最多 20 字）', topic_desc: '话题说明最多 100 字', topic_many: '话题数量已达上限',
  topic_forbidden: '只有话题创建者或管理员能操作', pin_forbidden: '没有置顶权限', pin_full: '置顶已满（每个范围最多 3 条）',
  pin_scope: '这个帖子不属于该话题', folder_gone: '收藏夹不存在', folder_name: '请填写收藏夹名称（最多 20 字）', folder_many: '收藏夹最多 20 个',
  post_gone: '帖子不存在或已被删除', admin_only: '需要管理员权限', reply_gone: '这条回复不存在或已被删除', edit_forbidden: '只能修改自己的内容',
  user_gone: '用户不存在', follow_self: '不能关注自己', private: '对方没有公开这部分内容', bio_len: '简介最多 200 字',
  dm_self: '不能给自己发私信', dm_blocked: '无法给对方发送私信', dm_you_blocked: '你已拉黑对方，先取消拉黑才能发私信', dm_empty: '消息不能为空', dm_len: '消息最多 500 字',
  dm_limit: '今天发的私信太多了，明天再试', dm_gone: '消息不存在', dm_recall_time: '只能撤回 10 分钟内的消息', report_none: '请选择要举报的消息', report_many: '今天举报次数太多了', report_gone: '举报不存在',
  drive_off: '网盘还没有配置存储仓库', drive_gone: '文件不存在或没有权限', drive_quota: '网盘空间不足', drive_big: '文件太大', drive_limit: '今天上传太多了，明天再试',
  drive_full: '存储仓库已满，请联系管理员', drive_name: '请填写名称', drive_dup: '已有同名文件夹', drive_depth: '文件夹最多 3 层', drive_folders_many: '文件夹数量已达上限',
  drive_folder_gone: '文件夹不存在', drive_not_empty: '文件夹不是空的', drive_bad: '文件格式不对', drive_busy: '存储繁忙，请重试', drive_upstream: '存储服务出错，请稍后再试',
  att_gone: '附件不存在', att_many: '附件数量超出限制', share_many: '最多分享给 20 个人',
};
const failc = (code, status = 400, extra) => json({ ok: false, error: EMSG[code] || code, code, ...(extra || {}) }, status);

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
  'CREATE TABLE IF NOT EXISTS reply_likes (reply_id INTEGER NOT NULL, username TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (reply_id, username))',
  // 个人主页 / 关注
  'CREATE TABLE IF NOT EXISTS profiles (username TEXT PRIMARY KEY, bio TEXT NOT NULL DEFAULT \'\', show_posts INTEGER NOT NULL DEFAULT 1, show_comments INTEGER NOT NULL DEFAULT 1, show_likes INTEGER NOT NULL DEFAULT 0, show_marks INTEGER NOT NULL DEFAULT 0, show_follows INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL DEFAULT 0)',
  'CREATE TABLE IF NOT EXISTS follows (follower TEXT NOT NULL, followee TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (follower, followee))',
  'CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows (followee)',
  // 私信 / 拉黑 / 举报：会话用 (user_a < user_b) 的字典序配对；a_read / a_clear 是 user_a 已读到哪条、清空到哪条
  'CREATE TABLE IF NOT EXISTS dm_convs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_a TEXT NOT NULL, user_b TEXT NOT NULL, last_at INTEGER NOT NULL DEFAULT 0, a_read INTEGER NOT NULL DEFAULT 0, b_read INTEGER NOT NULL DEFAULT 0, a_clear INTEGER NOT NULL DEFAULT 0, b_clear INTEGER NOT NULL DEFAULT 0, UNIQUE (user_a, user_b))',
  'CREATE INDEX IF NOT EXISTS idx_dm_b ON dm_convs (user_b)',
  'CREATE TABLE IF NOT EXISTS dm_msgs (id INTEGER PRIMARY KEY AUTOINCREMENT, conv_id INTEGER NOT NULL, sender TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL, recalled INTEGER NOT NULL DEFAULT 0)',
  'CREATE INDEX IF NOT EXISTS idx_dm_msgs_conv ON dm_msgs (conv_id, id)',
  'CREATE INDEX IF NOT EXISTS idx_dm_msgs_sender ON dm_msgs (sender, created_at)',
  // 2901网盘：文件内容在 GitHub 私有仓库里（路径随机），这里只存元数据；kind=img 是帖子 / 私信里的图片（不占网盘空间、不出现在网盘列表）
  'CREATE TABLE IF NOT EXISTS drive_folders (id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, name TEXT NOT NULL, parent INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS idx_dfolders_owner ON drive_folders (owner, parent)',
  "CREATE TABLE IF NOT EXISTS drive_files (id TEXT PRIMARY KEY, owner TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'file', name TEXT NOT NULL, folder INTEGER NOT NULL DEFAULT 0, size INTEGER NOT NULL, mime TEXT NOT NULL, repo TEXT NOT NULL, path TEXT NOT NULL, sha TEXT NOT NULL, share_all INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)",
  'CREATE INDEX IF NOT EXISTS idx_dfiles_owner ON drive_files (owner, kind, folder, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_dfiles_all ON drive_files (share_all, created_at)',
  'CREATE TABLE IF NOT EXISTS drive_shares (file_id TEXT NOT NULL, to_user TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (file_id, to_user))',
  'CREATE INDEX IF NOT EXISTS idx_dshares_to ON drive_shares (to_user, created_at)',
  'CREATE TABLE IF NOT EXISTS drive_att (file_id TEXT NOT NULL, kind TEXT NOT NULL, ref INTEGER NOT NULL, PRIMARY KEY (file_id, kind, ref))',
  'CREATE INDEX IF NOT EXISTS idx_datt_ref ON drive_att (kind, ref)',
  'CREATE TABLE IF NOT EXISTS drive_gc (id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, path TEXT NOT NULL, sha TEXT NOT NULL, tries INTEGER NOT NULL DEFAULT 0)',
  'CREATE TABLE IF NOT EXISTS blocks (blocker TEXT NOT NULL, blocked TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (blocker, blocked))',
  'CREATE INDEX IF NOT EXISTS idx_blocks_blocked ON blocks (blocked)',
  // 举报：举报时只保存被举报的那几条消息的快照，管理员只能看到这些
  'CREATE TABLE IF NOT EXISTS dm_reports (id INTEGER PRIMARY KEY AUTOINCREMENT, reporter TEXT NOT NULL, reported TEXT NOT NULL, reason TEXT NOT NULL DEFAULT \'\', msgs TEXT NOT NULL, created_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT \'open\', handled_by TEXT, handled_at INTEGER, note TEXT)',
  // 话题（板块）/ 标签 / 置顶 / 收藏
  'CREATE TABLE IF NOT EXISTS topics (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL COLLATE NOCASE UNIQUE, descr TEXT NOT NULL DEFAULT \'\', creator TEXT NOT NULL, created_at INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS post_topics (post_id INTEGER NOT NULL, topic_id INTEGER NOT NULL, PRIMARY KEY (post_id, topic_id))',
  'CREATE INDEX IF NOT EXISTS idx_pt_topic ON post_topics (topic_id, post_id)',
  'CREATE TABLE IF NOT EXISTS post_tags (post_id INTEGER NOT NULL, tag TEXT NOT NULL COLLATE NOCASE, PRIMARY KEY (post_id, tag))',
  'CREATE INDEX IF NOT EXISTS idx_ptag_tag ON post_tags (tag, post_id)',
  'CREATE TABLE IF NOT EXISTS pins (scope TEXT NOT NULL, post_id INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER, by TEXT NOT NULL, PRIMARY KEY (scope, post_id))',
  'CREATE TABLE IF NOT EXISTS bookmark_folders (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS idx_bf_user ON bookmark_folders (username)',
  'CREATE TABLE IF NOT EXISTS bookmarks (username TEXT NOT NULL, post_id INTEGER NOT NULL, folder_id INTEGER, created_at INTEGER NOT NULL, PRIMARY KEY (username, post_id))',
  'CREATE INDEX IF NOT EXISTS idx_bm_post ON bookmarks (post_id)',
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
    // V2：多层评论 / 软删除 / 编辑
    "ALTER TABLE replies ADD COLUMN parent_id INTEGER", "ALTER TABLE replies ADD COLUMN depth INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE replies ADD COLUMN reply_to TEXT", "ALTER TABLE replies ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE replies ADD COLUMN edited_at INTEGER", "ALTER TABLE posts ADD COLUMN edited_at INTEGER",
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
  if (params.action === 'drive_upload') return driveUpload(request, env);   // 上传走原始 base64 正文 + X-Drive 头，不经过 JSON 解析
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
      // 排序：active 最近活动 / new 发布时间 / likes 赞数 / replies 回复数 / marks 收藏数；dir 升降序；topic / tag / q 筛选；offset 翻页
      const SORTS = { active: 'p.last_at', new: 'p.id', likes: 'like_count', replies: 'p.reply_count', marks: 'mark_count' };
      const sort = SORTS[b.sort] ? b.sort : 'active';
      const dir = b.dir === 'asc' ? 'ASC' : 'DESC';
      const offset = Math.max(0, Math.floor(Number(b.offset)) || 0);
      const topic = Number(b.topic) > 0 ? Math.floor(Number(b.topic)) : 0;
      const tag = clean(String(b.tag || '').replace(/^#+/, ''), LIMITS.TAG_LEN) || '';
      const q = clean(String(b.q || ''), 30) || '';
      const where = [], args = [];
      const feed = b.feed === 'following';
      if (feed) { where.push('p.author IN (SELECT followee FROM follows WHERE follower = ?)'); args.push(user); }
      if (topic) { where.push('p.id IN (SELECT post_id FROM post_topics WHERE topic_id = ?)'); args.push(topic); }
      if (tag) { where.push('p.id IN (SELECT post_id FROM post_tags WHERE tag = ?)'); args.push(tag); }
      if (q) { const like = '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%'; where.push("(p.title LIKE ? ESCAPE '\\' OR p.body LIKE ? ESCAPE '\\')"); args.push(like, like); }
      // 置顶：全站置顶出现在主列表和每个话题列表里；话题置顶只出现在该话题列表里。筛选标签 / 搜索时不显示置顶
      let pinned = [];
      if (!tag && !q && !feed) {
        const scopes = topic ? ['global', 'topic:' + topic] : ['global'];
        const { results: pr } = await db.prepare(`SELECT post_id, scope, expires_at FROM pins WHERE scope IN (${scopes.map(() => '?').join(',')}) AND (expires_at IS NULL OR expires_at > ?) ORDER BY (scope = 'global') DESC, created_at DESC`).bind(...scopes, now).all();
        const seen = new Set(); const ids = [];
        for (const r of pr) if (!seen.has(r.post_id)) { seen.add(r.post_id); ids.push(r); }
        if (ids.length) {
          where.push(`p.id NOT IN (${ids.map(() => '?').join(',')})`); args.push(...ids.map((r) => r.post_id));
          if (offset === 0) {
            const rows = await listPosts(db, user, [`p.id IN (${ids.map(() => '?').join(',')})`], ids.map((r) => r.post_id), 'p.id DESC', 50, 0);
            const by = new Map(rows.map((r) => [r.id, r]));
            pinned = ids.map((r) => by.get(r.post_id) && { ...by.get(r.post_id), pin_scope: r.scope, pin_expires_at: r.expires_at }).filter(Boolean);
          }
        }
      }
      const rows = await listPosts(db, user, where, args, `${SORTS[sort]} ${dir}, p.id ${dir}`, LIMITS.PAGE + 1, offset);
      const posts = rows.slice(0, LIMITS.PAGE);
      await attachMeta(db, [...posts, ...pinned]);
      return json({ ok: true, me: user, admin: isAdmin, posts, pinned, hasMore: rows.length > LIMITS.PAGE, sort, dir: dir.toLowerCase() });
    }

    case 'post': {
      const id = Number(b.id);
      const post = await db.prepare('SELECT p.*, a.updated_at AS av FROM posts p LEFT JOIN avatars a ON a.username = p.author WHERE p.id = ?1').bind(id).first();
      if (!post) return failc('post_gone', 404);
      const { results: rrows } = await db.prepare(`SELECT r.id, r.author, r.body, r.created_at, r.parent_id, r.depth, r.reply_to, r.deleted, r.edited_at, a.updated_at AS av,
                                            (SELECT COUNT(*) FROM reply_likes x WHERE x.reply_id = r.id) AS like_count,
                                            (SELECT COUNT(*) FROM reply_likes x WHERE x.reply_id = r.id AND x.username = ?3) AS liked
                                            FROM replies r LEFT JOIN avatars a ON a.username = r.author
                                            WHERE r.post_id = ?1 ORDER BY r.id LIMIT ?2`)
        .bind(id, LIMITS.MAX_REPLIES, user).all();
      const results = rrows.map((r) => ({ ...r, deleted: !!r.deleted, liked: !!r.liked }));
      const lk = await db.prepare('SELECT COUNT(*) AS n, SUM(username = ?2) AS me FROM likes WHERE post_id = ?1').bind(id, user).first();
      post.like_count = (lk && lk.n) || 0; post.liked = !!(lk && lk.me);
      await attachMeta(db, [post]);
      const bm = await db.prepare('SELECT folder_id FROM bookmarks WHERE username = ?1 AND post_id = ?2').bind(user, id).first();
      const mc = await db.prepare('SELECT COUNT(*) AS n FROM bookmarks WHERE post_id = ?1').bind(id).first();
      post.marked = !!bm; post.folder_id = bm ? bm.folder_id : null; post.mark_count = mc.n;
      const { results: pn } = await db.prepare('SELECT scope, expires_at FROM pins WHERE post_id = ?1 AND (expires_at IS NULL OR expires_at > ?2)').bind(id, now).all();
      post.pins = pn;
      // 当前用户能在哪些范围置顶这个帖子
      const opts = [];
      if (isAdmin) opts.push({ scope: 'global' });
      for (const t of post.topics) if (isAdmin || t.creator === user) opts.push({ scope: 'topic:' + t.id, name: t.name });
      post.pin_options = opts;
      post.atts = (await loadAtts(db, 'post', [id])).get(id) || [];
      return json({ ok: true, me: user, admin: isAdmin, post, replies: results, poll: await loadPoll(db, id, user, now, isAdmin) });
    }

    case 'create': {
      const title = clean(String(b.title || '').replace(/\s+/g, ' '), LIMITS.TITLE);
      const body = clean(b.body, LIMITS.POST);
      if (title === null) return fail(`标题最多 ${LIMITS.TITLE} 字`);
      if (body === null) return fail(`正文最多 ${LIMITS.POST} 字`);
      if (!title || !body) return fail('标题和正文都不能为空');
      const meta = await parseMeta(db, b);
      if (typeof meta === 'string') return failc(meta);
      let poll = null;
      if (b.poll) { poll = parsePoll(b.poll, now); if (typeof poll === 'string') return fail(poll, 400, 'poll_invalid'); }
      let attRows = [];
      if (Array.isArray(b.att) && b.att.length) { const v = await validateAtt(db, user, b.att, 'post'); if (typeof v === 'string') return failc(v); attRows = v; }
      if (!isAdmin) {
        const last = await db.prepare('SELECT MAX(created_at) AS t FROM posts WHERE author = ?1').bind(user).first();
        if (last && last.t && now - last.t < LIMITS.POST_GAP_MS) return fail('发得太快啦，稍等几秒再发', 429);
      }
      const r = await db.prepare('INSERT INTO posts (author, title, body, created_at, last_at, reply_count) VALUES (?1, ?2, ?3, ?4, ?4, 0)')
        .bind(user, title, body, now).run();
      const id = r.meta.last_row_id;
      if (meta.topics.length || meta.tags.length) await db.batch(metaStmts(db, id, meta, false));
      if (attRows.length) await db.batch(attRows.map((f) => db.prepare("INSERT OR IGNORE INTO drive_att (file_id, kind, ref) VALUES (?1, 'post', ?2)").bind(f.id, id)));
      if (poll) await db.prepare('INSERT INTO polls (post_id, multi, closes_at, options, anon, vis) VALUES (?1, ?2, ?3, ?4, ?5, ?6)').bind(id, poll.multi, poll.closes_at, JSON.stringify(poll.options), poll.anon, poll.vis).run();
      return json({ ok: true, id });
    }

    case 'reply': {   // 可回复帖子（不传 parent_id）或回复某条评论（最多 3 层，更深的归到第 3 层，并记下回复的是谁）
      const pid = Number(b.post_id);
      const body = clean(b.body, LIMITS.REPLY);
      if (body === null) return fail(`回复最多 ${LIMITS.REPLY} 字`);
      if (!body) return fail('回复内容不能为空');
      const post = await db.prepare('SELECT id FROM posts WHERE id = ?1').bind(pid).first();
      if (!post) return failc('post_gone', 404);
      const rc = await db.prepare('SELECT COUNT(*) AS n FROM replies WHERE post_id = ?1').bind(pid).first();
      if (rc.n >= LIMITS.MAX_REPLIES) return fail(`这个帖子回复已满（${LIMITS.MAX_REPLIES} 条），请新开一个帖子`);
      if (!isAdmin) {
        const last = await db.prepare('SELECT MAX(created_at) AS t FROM replies WHERE author = ?1').bind(user).first();
        if (last && last.t && now - last.t < LIMITS.REPLY_GAP_MS) return fail('回复得太快啦，稍等几秒', 429);
      }
      let parent = null, depth = 0, replyTo = null;
      if (b.parent_id != null) {
        const par = await db.prepare('SELECT id, post_id, parent_id, depth, author, deleted FROM replies WHERE id = ?1').bind(Number(b.parent_id)).first();
        if (!par || par.post_id !== pid || par.deleted) return failc('reply_gone', 404);
        replyTo = par.author;
        if (par.depth >= LIMITS.MAX_DEPTH) { parent = par.parent_id; depth = LIMITS.MAX_DEPTH; }
        else { parent = par.id; depth = par.depth + 1; }
      }
      const res = await db.batch([
        db.prepare('INSERT INTO replies (post_id, author, body, created_at, parent_id, depth, reply_to) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)').bind(pid, user, body, now, parent, depth, replyTo),
        db.prepare('UPDATE posts SET reply_count = reply_count + 1, last_at = ?2 WHERE id = ?1').bind(pid, now),
      ]);
      return json({ ok: true, id: res[0].meta.last_row_id });
    }

    case 'reply_like': {   // 再点一次取消
      const rid = Number(b.id);
      const r = await db.prepare('SELECT deleted FROM replies WHERE id = ?1').bind(rid).first();
      if (!r || r.deleted) return failc('reply_gone', 404);
      const had = await db.prepare('SELECT 1 AS x FROM reply_likes WHERE reply_id = ?1 AND username = ?2').bind(rid, user).first();
      if (had) await db.prepare('DELETE FROM reply_likes WHERE reply_id = ?1 AND username = ?2').bind(rid, user).run();
      else await db.prepare('INSERT OR IGNORE INTO reply_likes (reply_id, username, created_at) VALUES (?1, ?2, ?3)').bind(rid, user, now).run();
      const n = await db.prepare('SELECT COUNT(*) AS n FROM reply_likes WHERE reply_id = ?1').bind(rid).first();
      return json({ ok: true, liked: !had, count: n.n });
    }

    case 'reply_edit': {   // 只有作者能改自己的评论
      const r = await db.prepare('SELECT author, deleted FROM replies WHERE id = ?1').bind(Number(b.id)).first();
      if (!r || r.deleted) return failc('reply_gone', 404);
      if (r.author !== user) return failc('edit_forbidden', 403);
      const body = clean(b.body, LIMITS.REPLY);
      if (body === null) return fail(`回复最多 ${LIMITS.REPLY} 字`);
      if (!body) return fail('回复内容不能为空');
      await db.prepare('UPDATE replies SET body = ?2, edited_at = ?3 WHERE id = ?1').bind(Number(b.id), body, now).run();
      return json({ ok: true, edited_at: now });
    }

    case 'post_edit': {   // 只有作者能改自己的帖子标题和正文
      const post = await db.prepare('SELECT author FROM posts WHERE id = ?1').bind(Number(b.id)).first();
      if (!post) return failc('post_gone', 404);
      if (post.author !== user) return failc('edit_forbidden', 403);
      const title = clean(String(b.title || '').replace(/\s+/g, ' '), LIMITS.TITLE);
      const body = clean(b.body, LIMITS.POST);
      if (title === null) return fail(`标题最多 ${LIMITS.TITLE} 字`);
      if (body === null) return fail(`正文最多 ${LIMITS.POST} 字`);
      if (!title || !body) return fail('标题和正文都不能为空');
      await db.prepare('UPDATE posts SET title = ?2, body = ?3, edited_at = ?4 WHERE id = ?1').bind(Number(b.id), title, body, now).run();
      return json({ ok: true, edited_at: now });
    }

    case 'delete': {   // 自己的帖子/回复可删；管理员可删任何人的
      const id = Number(b.id);
      if (b.type === 'post') {
        const p = await db.prepare('SELECT author FROM posts WHERE id = ?1').bind(id).first();
        if (!p) return json({ ok: true });
        if (p.author !== user && !isAdmin) return fail('只能删除自己的帖子', 403);
        await dropAtts(db, 'post', id);
        await db.batch([
          db.prepare('DELETE FROM reply_likes WHERE reply_id IN (SELECT id FROM replies WHERE post_id = ?1)').bind(id),
          db.prepare('DELETE FROM replies WHERE post_id = ?1').bind(id),
          db.prepare('DELETE FROM likes WHERE post_id = ?1').bind(id),
          db.prepare('DELETE FROM poll_votes WHERE post_id = ?1').bind(id),
          db.prepare('DELETE FROM polls WHERE post_id = ?1').bind(id),
          db.prepare('DELETE FROM post_topics WHERE post_id = ?1').bind(id),
          db.prepare('DELETE FROM post_tags WHERE post_id = ?1').bind(id),
          db.prepare('DELETE FROM pins WHERE post_id = ?1').bind(id),
          db.prepare('DELETE FROM bookmarks WHERE post_id = ?1').bind(id),
          db.prepare('DELETE FROM posts WHERE id = ?1').bind(id),
        ]);
        return json({ ok: true });
      }
      if (b.type === 'reply') {   // 有人回复过的评论：内容清空、留「已删除」占位；没人回复的直接删除
        const r = await db.prepare('SELECT author, deleted FROM replies WHERE id = ?1').bind(id).first();
        if (!r || r.deleted) return json({ ok: true });
        if (r.author !== user && !isAdmin) return fail('只能删除自己的回复', 403);
        await removeReply(db, id);
        return json({ ok: true });
      }
      return fail('参数错误');
    }

    // ---------- 点赞：再点一次取消 ----------
    case 'like': {
      const pid = Number(b.post_id);
      const post = await db.prepare('SELECT id FROM posts WHERE id = ?1').bind(pid).first();
      if (!post) return failc('post_gone', 404);
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

    // ---------- 话题（板块）：所有人可建；创建者或管理员可删；管理员可合并 ----------
    case 'topic_list': {
      const { results } = await db.prepare(`SELECT t.id, t.name, t.descr, t.creator, t.created_at,
                                                    (SELECT COUNT(*) FROM post_topics pt WHERE pt.topic_id = t.id) AS post_count
                                             FROM topics t ORDER BY post_count DESC, t.id LIMIT ?1`).bind(LIMITS.TOPICS_MAX).all();
      return json({ ok: true, me: user, admin: isAdmin, topics: results });
    }
    case 'topic_create': {
      const name = clean(String(b.name || '').replace(/\s+/g, ' ').replace(/^#+/, ''), LIMITS.TOPIC_NAME);
      const descr = clean(b.descr, LIMITS.TOPIC_DESC);
      if (!name) return failc('topic_name');
      if (descr === null) return failc('topic_desc');
      const dup = await db.prepare('SELECT id FROM topics WHERE name = ?1').bind(name).first();
      if (dup) return failc('topic_exists', 400, { id: dup.id });
      const cnt = await db.prepare('SELECT COUNT(*) AS n FROM topics').first();
      if (cnt.n >= LIMITS.TOPICS_MAX) return failc('topic_many');
      if (!isAdmin) {
        const last = await db.prepare('SELECT MAX(created_at) AS t FROM topics WHERE creator = ?1').bind(user).first();
        if (last && last.t && now - last.t < LIMITS.TOPIC_GAP_MS) return fail('操作太快啦，稍等几秒再试', 429, 'too_fast');
      }
      const r = await db.prepare('INSERT INTO topics (name, descr, creator, created_at) VALUES (?1, ?2, ?3, ?4)').bind(name, descr || '', user, now).run();
      return json({ ok: true, id: r.meta.last_row_id });
    }
    case 'topic_delete': {
      const id = Number(b.id);
      const t = await db.prepare('SELECT creator FROM topics WHERE id = ?1').bind(id).first();
      if (!t) return json({ ok: true });
      if (t.creator !== user && !isAdmin) return failc('topic_forbidden', 403);
      await db.batch([
        db.prepare('DELETE FROM post_topics WHERE topic_id = ?1').bind(id),
        db.prepare('DELETE FROM pins WHERE scope = ?1').bind('topic:' + id),
        db.prepare('DELETE FROM topics WHERE id = ?1').bind(id),
      ]);
      return json({ ok: true });
    }
    case 'topic_merge': {   // 把 from 并入 into（管理员）
      if (!isAdmin) return failc('admin_only', 403);
      const from = Number(b.from), into = Number(b.into);
      if (!from || !into || from === into) return failc('topic_gone');
      const x = await db.prepare('SELECT COUNT(*) AS n FROM topics WHERE id IN (?1, ?2)').bind(from, into).first();
      if (x.n !== 2) return failc('topic_gone', 404);
      await db.batch([
        db.prepare('INSERT OR IGNORE INTO post_topics (post_id, topic_id) SELECT post_id, ?2 FROM post_topics WHERE topic_id = ?1').bind(from, into),
        db.prepare('DELETE FROM post_topics WHERE topic_id = ?1').bind(from),
        db.prepare('UPDATE OR IGNORE pins SET scope = ?2 WHERE scope = ?1').bind('topic:' + from, 'topic:' + into),
        db.prepare('DELETE FROM pins WHERE scope = ?1').bind('topic:' + from),
        db.prepare('DELETE FROM topics WHERE id = ?1').bind(from),
      ]);
      return json({ ok: true });
    }

    // 修改帖子的话题 / 标签（作者或管理员）
    case 'post_meta': {
      const id = Number(b.id);
      const post = await db.prepare('SELECT author FROM posts WHERE id = ?1').bind(id).first();
      if (!post) return failc('post_gone', 404);
      if (post.author !== user && !isAdmin) return fail('只能修改自己的帖子', 403);
      const meta = await parseMeta(db, b);
      if (typeof meta === 'string') return failc(meta);
      await db.batch(metaStmts(db, id, meta, true));
      return json({ ok: true });
    }

    // ---------- 置顶：管理员可全站置顶；话题创建者可在自己的话题里置顶；每个范围最多 PIN_MAX 条，可设有效期 ----------
    case 'pin': {
      const pid = Number(b.post_id);
      const scope = String(b.scope || '');
      const post = await db.prepare('SELECT id FROM posts WHERE id = ?1').bind(pid).first();
      if (!post) return failc('post_gone', 404);
      if (scope === 'global') { if (!isAdmin) return failc('pin_forbidden', 403); }
      else {
        const m = /^topic:(\d+)$/.exec(scope);
        if (!m) return failc('pin_scope');
        const tp = await db.prepare('SELECT creator FROM topics WHERE id = ?1').bind(Number(m[1])).first();
        if (!tp) return failc('topic_gone', 404);
        if (!isAdmin && tp.creator !== user) return failc('pin_forbidden', 403);
        const inT = await db.prepare('SELECT 1 AS x FROM post_topics WHERE post_id = ?1 AND topic_id = ?2').bind(pid, Number(m[1])).first();
        if (!inT) return failc('pin_scope');
      }
      if (b.on === false) { await db.prepare('DELETE FROM pins WHERE scope = ?1 AND post_id = ?2').bind(scope, pid).run(); return json({ ok: true }); }
      const c = await db.prepare('SELECT COUNT(*) AS n FROM pins WHERE scope = ?1 AND post_id != ?2 AND (expires_at IS NULL OR expires_at > ?3)').bind(scope, pid, now).first();
      if (c.n >= LIMITS.PIN_MAX) return failc('pin_full');
      const hrs = Number(b.hours);
      const exp = hrs > 0 ? now + Math.min(hrs, 24 * 365) * 3600000 : null;
      await db.prepare('INSERT OR REPLACE INTO pins (scope, post_id, created_at, expires_at, by) VALUES (?1, ?2, ?3, ?4, ?5)').bind(scope, pid, now, exp, user).run();
      return json({ ok: true });
    }

    // ---------- 收藏（私人）：可放进自己的收藏夹 ----------
    case 'bookmark': {
      const pid = Number(b.post_id);
      const post = await db.prepare('SELECT id FROM posts WHERE id = ?1').bind(pid).first();
      if (!post) return failc('post_gone', 404);
      if (b.on === false) await db.prepare('DELETE FROM bookmarks WHERE username = ?1 AND post_id = ?2').bind(user, pid).run();
      else {
        let fid = null;
        if (b.folder_id != null) {
          fid = Number(b.folder_id);
          const f = await db.prepare('SELECT 1 AS x FROM bookmark_folders WHERE id = ?1 AND username = ?2').bind(fid, user).first();
          if (!f) return failc('folder_gone', 404);
        }
        await db.prepare('INSERT INTO bookmarks (username, post_id, folder_id, created_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(username, post_id) DO UPDATE SET folder_id = ?3').bind(user, pid, fid, now).run();
      }
      const bm = await db.prepare('SELECT folder_id FROM bookmarks WHERE username = ?1 AND post_id = ?2').bind(user, pid).first();
      const mc = await db.prepare('SELECT COUNT(*) AS n FROM bookmarks WHERE post_id = ?1').bind(pid).first();
      return json({ ok: true, marked: !!bm, folder_id: bm ? bm.folder_id : null, count: mc.n });
    }
    case 'folder_list': {
      const { results } = await db.prepare(`SELECT f.id, f.name, (SELECT COUNT(*) FROM bookmarks k WHERE k.username = f.username AND k.folder_id = f.id) AS n
                                             FROM bookmark_folders f WHERE f.username = ?1 ORDER BY f.id`).bind(user).all();
      const tot = await db.prepare('SELECT COUNT(*) AS n, SUM(folder_id IS NULL) AS u FROM bookmarks WHERE username = ?1').bind(user).first();
      return json({ ok: true, folders: results, total: tot.n || 0, unfiled: tot.u || 0 });
    }
    case 'folder_create': {
      const name = clean(String(b.name || '').replace(/\s+/g, ' '), LIMITS.FOLDER_NAME);
      if (!name) return failc('folder_name');
      const c = await db.prepare('SELECT COUNT(*) AS n FROM bookmark_folders WHERE username = ?1').bind(user).first();
      if (c.n >= LIMITS.FOLDERS_MAX) return failc('folder_many');
      const r = await db.prepare('INSERT INTO bookmark_folders (username, name, created_at) VALUES (?1, ?2, ?3)').bind(user, name, now).run();
      return json({ ok: true, id: r.meta.last_row_id });
    }
    case 'folder_rename': {
      const name = clean(String(b.name || '').replace(/\s+/g, ' '), LIMITS.FOLDER_NAME);
      if (!name) return failc('folder_name');
      await db.prepare('UPDATE bookmark_folders SET name = ?3 WHERE id = ?1 AND username = ?2').bind(Number(b.id), user, name).run();
      return json({ ok: true });
    }
    case 'folder_delete': {   // 夹里的收藏不会丢，回到「未分类」
      const id = Number(b.id);
      await db.batch([
        db.prepare('UPDATE bookmarks SET folder_id = NULL WHERE username = ?1 AND folder_id = ?2').bind(user, id),
        db.prepare('DELETE FROM bookmark_folders WHERE id = ?1 AND username = ?2').bind(id, user),
      ]);
      return json({ ok: true });
    }
    case 'bookmark_list': {   // folder: 不传 = 全部；'none' = 未分类；数字 = 某个收藏夹
      const offset = Math.max(0, Math.floor(Number(b.offset)) || 0);
      const where = ['p.id IN (SELECT post_id FROM bookmarks WHERE username = ?' + (b.folder === 'none' ? ' AND folder_id IS NULL' : Number(b.folder) > 0 ? ' AND folder_id = ?' : '') + ')'];
      const args = [user];
      if (b.folder !== 'none' && Number(b.folder) > 0) args.push(Number(b.folder));
      const rows = await listPosts(db, user, where, args, '(SELECT created_at FROM bookmarks k2 WHERE k2.username = ? AND k2.post_id = p.id) DESC', LIMITS.MARK_PAGE + 1, offset, [user]);
      const posts = rows.slice(0, LIMITS.MARK_PAGE);
      await attachMeta(db, posts);
      return json({ ok: true, me: user, posts, hasMore: rows.length > LIMITS.MARK_PAGE });
    }

    // ---------- 个人主页 / 关注 ----------
    case 'profile': {
      const name = String(b.name || '');
      let u = null;
      try { u = await db.prepare('SELECT username, created_at FROM users WHERE username = ?1').bind(name).first(); }
      catch (e) { u = await db.prepare('SELECT username FROM users WHERE username = ?1').bind(name).first(); }
      if (!u) return failc('user_gone', 404);
      const pf = await getProfile(db, u.username);
      const me = u.username === user;
      const av = await db.prepare('SELECT updated_at FROM avatars WHERE username = ?1').bind(u.username).first();
      const n = async (sql, ...a) => (await db.prepare(sql).bind(...a).first()).n;
      const out = {
        username: u.username, av: av ? av.updated_at : null, bio: pf.bio, joined: u.created_at || null, is_me: me, is_admin: ADMINS.includes(u.username.toLowerCase()),
        post_count: await n('SELECT COUNT(*) AS n FROM posts WHERE author = ?1', u.username),
        reply_count: await n('SELECT COUNT(*) AS n FROM replies WHERE author = ?1 AND deleted = 0', u.username),
        likes_received: (await n('SELECT COUNT(*) AS n FROM likes WHERE post_id IN (SELECT id FROM posts WHERE author = ?1)', u.username))
                      + (await n('SELECT COUNT(*) AS n FROM reply_likes WHERE reply_id IN (SELECT id FROM replies WHERE author = ?1)', u.username)),
        followers: await n('SELECT COUNT(*) AS n FROM follows WHERE followee = ?1', u.username),
        following: await n('SELECT COUNT(*) AS n FROM follows WHERE follower = ?1', u.username),
        followed_by_me: !me && !!(await n('SELECT COUNT(*) AS n FROM follows WHERE follower = ?1 AND followee = ?2', user, u.username)),
        follows_me: !me && !!(await n('SELECT COUNT(*) AS n FROM follows WHERE follower = ?2 AND followee = ?1', user, u.username)),
        i_blocked: !me && !!(await n('SELECT COUNT(*) AS n FROM blocks WHERE blocker = ?1 AND blocked = ?2', user, u.username)),
        can: { posts: me || !!pf.show_posts, comments: me || !!pf.show_comments, likes: me || !!pf.show_likes, marks: me || !!pf.show_marks, follows: me || !!pf.show_follows },
      };
      if (me) out.privacy = { show_posts: !!pf.show_posts, show_comments: !!pf.show_comments, show_likes: !!pf.show_likes, show_marks: !!pf.show_marks, show_follows: !!pf.show_follows };
      return json({ ok: true, me: user, admin: isAdmin, profile: out });
    }

    case 'profile_set': {   // 只改自己的：简介 + 哪些内容对别人可见
      const bio = clean(b.bio, LIMITS.BIO);
      if (bio === null) return failc('bio_len');
      const f = (k, d) => (b[k] === undefined ? d : (b[k] ? 1 : 0));
      const cur = await getProfile(db, user);
      await db.prepare(`INSERT INTO profiles (username, bio, show_posts, show_comments, show_likes, show_marks, show_follows, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                        ON CONFLICT(username) DO UPDATE SET bio = ?2, show_posts = ?3, show_comments = ?4, show_likes = ?5, show_marks = ?6, show_follows = ?7, updated_at = ?8`)
        .bind(user, b.bio === undefined ? cur.bio : bio, f('show_posts', cur.show_posts), f('show_comments', cur.show_comments), f('show_likes', cur.show_likes), f('show_marks', cur.show_marks), f('show_follows', cur.show_follows), now).run();
      return json({ ok: true });
    }

    case 'profile_posts': {   // tab: posts / comments / likes / marks；别人的内容要对方已公开
      const name = String(b.name || '');
      const exists = await db.prepare('SELECT 1 AS x FROM users WHERE username = ?1').bind(name).first();
      if (!exists) return failc('user_gone', 404);
      const tab = ['posts', 'comments', 'likes', 'marks'].includes(b.tab) ? b.tab : 'posts';
      const offset = Math.max(0, Math.floor(Number(b.offset)) || 0);
      const pf = await getProfile(db, name);
      const me = name === user;
      if (!me && !pf['show_' + tab]) return failc('private', 403);
      const PG = LIMITS.PROFILE_PAGE;
      if (tab === 'comments') {
        const { results } = await db.prepare(`SELECT r.id, r.post_id, r.body, r.created_at, p.title FROM replies r JOIN posts p ON p.id = r.post_id
                                              WHERE r.author = ?1 AND r.deleted = 0 ORDER BY r.id DESC LIMIT ?2 OFFSET ?3`).bind(name, PG + 1, offset).all();
        return json({ ok: true, me: user, comments: results.slice(0, PG), hasMore: results.length > PG });
      }
      let rows;
      if (tab === 'posts') rows = await listPosts(db, user, ['p.author = ?'], [name], 'p.id DESC', PG + 1, offset);
      else if (tab === 'likes') rows = await listPosts(db, user, ['p.id IN (SELECT post_id FROM likes WHERE username = ?)'], [name], '(SELECT created_at FROM likes k2 WHERE k2.username = ? AND k2.post_id = p.id) DESC', PG + 1, offset, [name]);
      else rows = await listPosts(db, user, ['p.id IN (SELECT post_id FROM bookmarks WHERE username = ?)'], [name], '(SELECT created_at FROM bookmarks k2 WHERE k2.username = ? AND k2.post_id = p.id) DESC', PG + 1, offset, [name]);
      const posts = rows.slice(0, PG);
      await attachMeta(db, posts);
      return json({ ok: true, me: user, posts, hasMore: rows.length > PG });
    }

    case 'follow': {   // on: true 关注 / false 取消；不传则切换
      const name = String(b.name || '');
      if (name === user) return failc('follow_self');
      const exists = await db.prepare('SELECT 1 AS x FROM users WHERE username = ?1').bind(name).first();
      if (!exists) return failc('user_gone', 404);
      const had = await db.prepare('SELECT 1 AS x FROM follows WHERE follower = ?1 AND followee = ?2').bind(user, name).first();
      const want = b.on === undefined ? !had : !!b.on;
      if (want && !had) await db.prepare('INSERT OR IGNORE INTO follows (follower, followee, created_at) VALUES (?1, ?2, ?3)').bind(user, name, now).run();
      if (!want && had) await db.prepare('DELETE FROM follows WHERE follower = ?1 AND followee = ?2').bind(user, name).run();
      const c = await db.prepare('SELECT COUNT(*) AS n FROM follows WHERE followee = ?1').bind(name).first();
      return json({ ok: true, following: want, followers: c.n });
    }

    case 'follow_list': {   // kind: followers / following
      const name = String(b.name || '');
      const exists = await db.prepare('SELECT 1 AS x FROM users WHERE username = ?1').bind(name).first();
      if (!exists) return failc('user_gone', 404);
      const pf = await getProfile(db, name);
      if (name !== user && !pf.show_follows) return failc('private', 403);
      const offset = Math.max(0, Math.floor(Number(b.offset)) || 0);
      const col = b.kind === 'following' ? 'followee' : 'follower', other = b.kind === 'following' ? 'follower' : 'followee';
      const { results } = await db.prepare(`SELECT f.${col} AS username, a.updated_at AS av,
                                                   (SELECT COUNT(*) FROM follows m WHERE m.follower = ?2 AND m.followee = f.${col}) AS followed_by_me
                                            FROM follows f LEFT JOIN avatars a ON a.username = f.${col}
                                            WHERE f.${other} = ?1 ORDER BY f.created_at DESC LIMIT ?3 OFFSET ?4`).bind(name, user, LIMITS.PEOPLE_PAGE + 1, offset).all();
      return json({ ok: true, me: user, users: results.slice(0, LIMITS.PEOPLE_PAGE).map((r) => ({ ...r, followed_by_me: !!r.followed_by_me })), hasMore: results.length > LIMITS.PEOPLE_PAGE });
    }

    case 'user_search': {   // 找人：用户名包含关键字
      const q = clean(String(b.q || ''), 32);
      if (!q) return json({ ok: true, users: [] });
      const like = '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
      const { results } = await db.prepare(`SELECT u.username AS username, a.updated_at AS av,
                                                   (SELECT COUNT(*) FROM follows m WHERE m.follower = ?2 AND m.followee = u.username) AS followed_by_me
                                            FROM users u LEFT JOIN avatars a ON a.username = u.username
                                            WHERE u.username LIKE ?1 ESCAPE '\\' ORDER BY u.username LIMIT 10`).bind(like, user).all();
      return json({ ok: true, users: results.map((r) => ({ ...r, followed_by_me: !!r.followed_by_me })) });
    }

    // ---------- 私信：一对一；管理员没有任何浏览私信的入口，只能看到被举报的那几条 ----------
    case 'dm_send': {
      const to = String(b.to || '');
      if (to === user) return failc('dm_self');
      const ex = await db.prepare('SELECT 1 AS x FROM users WHERE username = ?1').bind(to).first();
      if (!ex) return failc('user_gone', 404);
      const body = clean(b.body, LIMITS.DM_LEN);
      if (body === null) return failc('dm_len');
      const attIds = Array.isArray(b.att) ? b.att : [];
      if (!body && !attIds.length) return failc('dm_empty');
      let attRows = [];
      if (attIds.length) { const v = await validateAtt(db, user, attIds, 'dm'); if (typeof v === 'string') return failc(v); attRows = v; }
      if (await db.prepare('SELECT 1 AS x FROM blocks WHERE blocker = ?1 AND blocked = ?2').bind(to, user).first()) return failc('dm_blocked', 403);
      if (await db.prepare('SELECT 1 AS x FROM blocks WHERE blocker = ?1 AND blocked = ?2').bind(user, to).first()) return failc('dm_you_blocked', 403);
      const lastMsg = await db.prepare('SELECT MAX(created_at) AS t FROM dm_msgs WHERE sender = ?1').bind(user).first();
      if (lastMsg && lastMsg.t && now - lastMsg.t < LIMITS.DM_GAP_MS) return fail('操作太快啦，稍等几秒再试', 429, 'too_fast');
      const day = await db.prepare('SELECT COUNT(*) AS n FROM dm_msgs WHERE sender = ?1 AND created_at > ?2').bind(user, now - 86400000).first();
      if (day.n >= LIMITS.DM_DAILY) return failc('dm_limit', 429);
      const conv = await getConv(db, user, to, true);
      const r = await db.prepare('INSERT INTO dm_msgs (conv_id, sender, body, created_at) VALUES (?1, ?2, ?3, ?4)').bind(conv.id, user, body, now).run();
      const mid = r.meta.last_row_id;
      if (attRows.length) await db.batch(attRows.map((f) => db.prepare("INSERT OR IGNORE INTO drive_att (file_id, kind, ref) VALUES (?1, 'dm', ?2)").bind(f.id, mid)));
      await db.prepare(`UPDATE dm_convs SET last_at = ?2, ${conv.user_a === user ? 'a_read' : 'b_read'} = ?3 WHERE id = ?1`).bind(conv.id, now, mid).run();
      return json({ ok: true, id: mid, created_at: now });
    }

    case 'dm_list': {   // 我的会话列表（只含我自己的）
      const { results } = await db.prepare(`SELECT c.*, 0 AS z FROM dm_convs c WHERE c.user_a = ?1 OR c.user_b = ?1 ORDER BY c.last_at DESC LIMIT 100`).bind(user).all();
      const out = [];
      for (const c of results) {
        const meA = c.user_a === user, peer = meA ? c.user_b : c.user_a;
        const clear = meA ? c.a_clear : c.b_clear, read = meA ? c.a_read : c.b_read;
        const last = await db.prepare('SELECT id, sender, body, recalled, created_at FROM dm_msgs WHERE conv_id = ?1 AND id > ?2 ORDER BY id DESC LIMIT 1').bind(c.id, clear).first();
        if (!last) continue;
        const un = await db.prepare('SELECT COUNT(*) AS n FROM dm_msgs WHERE conv_id = ?1 AND sender != ?2 AND id > ?3 AND id > ?4 AND recalled = 0').bind(c.id, user, read, clear).first();
        const av = await db.prepare('SELECT updated_at FROM avatars WHERE username = ?1').bind(peer).first();
        out.push({ peer, av: av ? av.updated_at : null, last: { mine: last.sender === user, body: last.recalled ? '' : last.body.slice(0, 60), recalled: !!last.recalled, created_at: last.created_at }, unread: un.n });
      }
      return json({ ok: true, me: user, convs: out });
    }

    case 'dm_unread': {   // 未读总数（轮询用，很轻）
      const n = await db.prepare(`SELECT COUNT(*) AS n FROM dm_msgs m JOIN dm_convs c ON c.id = m.conv_id
                                  WHERE m.sender != ?1 AND m.recalled = 0 AND (c.user_a = ?1 OR c.user_b = ?1)
                                    AND m.id > (CASE WHEN c.user_a = ?1 THEN MAX(c.a_read, c.a_clear) ELSE MAX(c.b_read, c.b_clear) END)`).bind(user).first();
      return json({ ok: true, unread: n.n });
    }

    case 'dm_messages': {   // 我和某人的聊天记录；after 只取新消息（轮询）；读取即标记已读
      const peer = String(b.with || '');
      const conv = await getConv(db, user, peer, false);
      const peerInfo = await db.prepare('SELECT u.username AS username, a.updated_at AS av FROM users u LEFT JOIN avatars a ON a.username = u.username WHERE u.username = ?1').bind(peer).first();
      if (!peerInfo) return failc('user_gone', 404);
      const iBlocked = !!(await db.prepare('SELECT 1 AS x FROM blocks WHERE blocker = ?1 AND blocked = ?2').bind(user, peer).first());
      if (!conv) return json({ ok: true, me: user, peer: { username: peerInfo.username, av: peerInfo.av }, i_blocked: iBlocked, messages: [], peer_read: 0, hasMore: false });
      const meA = conv.user_a === user;
      const clear = meA ? conv.a_clear : conv.b_clear;
      const after = Math.max(0, Math.floor(Number(b.after)) || 0), before = Math.floor(Number(b.before)) || 0;
      let rows;
      if (after) rows = (await db.prepare('SELECT id, sender, body, recalled, created_at FROM dm_msgs WHERE conv_id = ?1 AND id > ?2 AND id > ?3 ORDER BY id LIMIT ?4').bind(conv.id, Math.max(after, clear), clear, LIMITS.DM_PAGE).all()).results;
      else if (before) rows = (await db.prepare('SELECT id, sender, body, recalled, created_at FROM dm_msgs WHERE conv_id = ?1 AND id < ?2 AND id > ?3 ORDER BY id DESC LIMIT ?4').bind(conv.id, before, clear, LIMITS.DM_PAGE + 1).all()).results.reverse();
      else rows = (await db.prepare('SELECT id, sender, body, recalled, created_at FROM dm_msgs WHERE conv_id = ?1 AND id > ?2 ORDER BY id DESC LIMIT ?3').bind(conv.id, clear, LIMITS.DM_PAGE + 1).all()).results.reverse();
      let hasMore = false;
      if (!after && rows.length > LIMITS.DM_PAGE) { hasMore = true; rows = rows.slice(1); }
      const maxId = rows.length ? rows[rows.length - 1].id : 0;
      if (maxId && !before) await db.prepare(`UPDATE dm_convs SET ${meA ? 'a_read' : 'b_read'} = MAX(${meA ? 'a_read' : 'b_read'}, ?2) WHERE id = ?1`).bind(conv.id, maxId).run();
      const atts = await loadAtts(db, 'dm', rows.map((m) => m.id));
      return json({
        ok: true, me: user, peer: { username: peerInfo.username, av: peerInfo.av }, i_blocked: iBlocked, hasMore,
        peer_read: meA ? conv.b_read : conv.a_read,
        messages: rows.map((m) => ({ id: m.id, mine: m.sender === user, body: m.recalled ? '' : m.body, recalled: !!m.recalled, created_at: m.created_at, atts: m.recalled ? [] : (atts.get(m.id) || []) })),
      });
    }

    case 'dm_recall': {   // 只能撤回自己发的、10 分钟内的消息；撤回后内容从数据库里清空
      const m = await db.prepare('SELECT id, sender, created_at, recalled FROM dm_msgs WHERE id = ?1').bind(Number(b.id)).first();
      if (!m || m.sender !== user) return failc('dm_gone', 404);
      if (m.recalled) return json({ ok: true });
      if (now - m.created_at > LIMITS.DM_RECALL_MS) return failc('dm_recall_time');
      await db.prepare("UPDATE dm_msgs SET recalled = 1, body = '' WHERE id = ?1").bind(m.id).run();
      await dropAtts(db, 'dm', m.id);
      return json({ ok: true });
    }

    case 'dm_clear': {   // 清空我这边的聊天记录（对方不受影响）；双方都清空后真正删除
      const conv = await getConv(db, user, String(b.with || ''), false);
      if (!conv) return json({ ok: true });
      const last = await db.prepare('SELECT MAX(id) AS m FROM dm_msgs WHERE conv_id = ?1').bind(conv.id).first();
      await db.prepare(`UPDATE dm_convs SET ${conv.user_a === user ? 'a_clear' : 'b_clear'} = ?2 WHERE id = ?1`).bind(conv.id, last.m || 0).run();
      await db.prepare('DELETE FROM dm_msgs WHERE conv_id = ?1 AND id <= (SELECT MIN(a_clear, b_clear) FROM dm_convs WHERE id = ?1)').bind(conv.id).run();
      return json({ ok: true });
    }

    // ---------- 拉黑：对方不能再给我发私信；互相的关注关系一并解除 ----------
    case 'block': {
      const name = String(b.name || '');
      if (name === user) return failc('dm_self');
      const ex = await db.prepare('SELECT 1 AS x FROM users WHERE username = ?1').bind(name).first();
      if (!ex) return failc('user_gone', 404);
      if (b.on === false) await db.prepare('DELETE FROM blocks WHERE blocker = ?1 AND blocked = ?2').bind(user, name).run();
      else await db.batch([
        db.prepare('INSERT OR IGNORE INTO blocks (blocker, blocked, created_at) VALUES (?1, ?2, ?3)').bind(user, name, now),
        db.prepare('DELETE FROM follows WHERE (follower = ?1 AND followee = ?2) OR (follower = ?2 AND followee = ?1)').bind(user, name),
      ]);
      return json({ ok: true, blocked: b.on !== false });
    }
    case 'block_list': {
      const { results } = await db.prepare('SELECT k.blocked AS username, a.updated_at AS av FROM blocks k LEFT JOIN avatars a ON a.username = k.blocked WHERE k.blocker = ?1 ORDER BY k.created_at DESC LIMIT 200').bind(user).all();
      return json({ ok: true, users: results });
    }

    // ---------- 举报：举报人选出若干条消息，只有这几条的快照会交给管理员 ----------
    case 'dm_report': {
      const peer = String(b.with || '');
      const conv = await getConv(db, user, peer, false);
      if (!conv) return failc('report_none');
      const ids = Array.isArray(b.ids) ? [...new Set(b.ids.map(Number).filter((x) => Number.isInteger(x) && x > 0))] : [];
      if (!ids.length || ids.length > LIMITS.REPORT_MAX_MSGS) return failc('report_none');
      const clear = conv.user_a === user ? conv.a_clear : conv.b_clear;
      const { results } = await db.prepare(`SELECT id, sender, body, created_at FROM dm_msgs WHERE conv_id = ?1 AND id > ?2 AND recalled = 0 AND id IN (${ids.map(() => '?').join(',')}) ORDER BY id`).bind(conv.id, clear, ...ids).all();
      if (!results.length) return failc('report_none');
      const day = await db.prepare('SELECT COUNT(*) AS n FROM dm_reports WHERE reporter = ?1 AND created_at > ?2').bind(user, now - 86400000).first();
      if (day.n >= LIMITS.REPORT_DAILY) return failc('report_many', 429);
      const reason = clean(b.reason, LIMITS.REASON_LEN) || '';
      await db.prepare('INSERT INTO dm_reports (reporter, reported, reason, msgs, created_at) VALUES (?1, ?2, ?3, ?4, ?5)')
        .bind(user, peer, reason, JSON.stringify(results.map((m) => ({ sender: m.sender, body: m.body, created_at: m.created_at }))), now).run();
      return json({ ok: true });
    }
    case 'report_list': {   // 管理员：只能看到举报里附带的消息快照
      if (!isAdmin) return failc('admin_only', 403);
      const st = b.status === 'done' ? 'done' : 'open';
      const { results } = await db.prepare('SELECT * FROM dm_reports WHERE status = ?1 ORDER BY id DESC LIMIT 100').bind(st).all();
      return json({ ok: true, reports: results.map((r) => ({ ...r, msgs: JSON.parse(r.msgs) })) });
    }
    case 'report_handle': {
      if (!isAdmin) return failc('admin_only', 403);
      const note = clean(b.note, LIMITS.REASON_LEN) || '';
      const r = await db.prepare('SELECT id FROM dm_reports WHERE id = ?1').bind(Number(b.id)).first();
      if (!r) return failc('report_gone', 404);
      await db.prepare("UPDATE dm_reports SET status = 'done', handled_by = ?2, handled_at = ?3, note = ?4 WHERE id = ?1").bind(r.id, user, now, note).run();
      return json({ ok: true });
    }


    // ---------- 2901网盘 ----------
    case 'drive_list': {
      const cfg = ghCfg(env);
      if (cfg) { try { await gcTick(db, cfg, 2); } catch (e) { /* 清理失败下次再试 */ } }
      if (!Number(b.offset) && !b.folder) { try { await sweepDrive(db, now); } catch (e) {} }   // 打开网盘根目录时顺手清一次没挂上的孤儿图片
      const fid = Math.max(0, Math.floor(Number(b.folder)) || 0);
      let folder = null, path = [];
      if (fid) {
        folder = await db.prepare('SELECT id, name, parent FROM drive_folders WHERE id = ?1 AND owner = ?2').bind(fid, user).first();
        if (!folder) return failc('drive_folder_gone', 404);
        let cur = folder; for (let i = 0; cur && i < 6; i++) { path.unshift({ id: cur.id, name: cur.name }); cur = cur.parent ? await db.prepare('SELECT id, name, parent FROM drive_folders WHERE id = ?1 AND owner = ?2').bind(cur.parent, user).first() : null; }
      }
      const offset = Math.max(0, Math.floor(Number(b.offset)) || 0);
      const { results: folders } = offset ? { results: [] } : await db.prepare('SELECT id, name FROM drive_folders WHERE owner = ?1 AND parent = ?2 ORDER BY name').bind(user, fid).all();
      const { results: rows } = await db.prepare("SELECT id, name, size, mime, share_all, created_at FROM drive_files WHERE owner = ?1 AND kind = 'file' AND folder = ?2 ORDER BY created_at DESC, id LIMIT ?3 OFFSET ?4").bind(user, fid, LIMITS.DRIVE_PAGE + 1, offset).all();
      const files = rows.slice(0, LIMITS.DRIVE_PAGE);
      const sh = new Map();
      if (files.length) {
        const { results: sr } = await db.prepare(`SELECT file_id, to_user FROM drive_shares WHERE file_id IN (${files.map(() => '?').join(',')})`).bind(...files.map((f) => f.id)).all();
        for (const r of sr) { if (!sh.has(r.file_id)) sh.set(r.file_id, []); sh.get(r.file_id).push(r.to_user); }
      }
      const used = await db.prepare("SELECT COALESCE(SUM(size), 0) AS n FROM drive_files WHERE owner = ?1 AND kind = 'file'").bind(user).first();
      return json({ ok: true, enabled: !!cfg, folder, path, folders, hasMore: rows.length > LIMITS.DRIVE_PAGE, used: used.n, quota: LIMITS.DRIVE_QUOTA, file_max: LIMITS.DRIVE_FILE_MAX,
        files: files.map((f) => ({ ...f, share_all: !!f.share_all, shares: sh.get(f.id) || [] })) });
    }
    case 'drive_folder_create': {
      const name = clean(String(b.name || '').replace(/\s+/g, ' '), LIMITS.DFOLDER_NAME);
      if (!name) return failc('drive_name');
      const parent = Math.max(0, Math.floor(Number(b.parent)) || 0);
      let depth = 1;
      if (parent) {
        let cur = await db.prepare('SELECT parent FROM drive_folders WHERE id = ?1 AND owner = ?2').bind(parent, user).first();
        if (!cur) return failc('drive_folder_gone', 404);
        depth = 2; for (let i = 0; cur && cur.parent && i < 8; i++) { cur = await db.prepare('SELECT parent FROM drive_folders WHERE id = ?1').bind(cur.parent).first(); depth++; }
        if (depth > LIMITS.DFOLDER_DEPTH) return failc('drive_depth');
      }
      const n = await db.prepare('SELECT COUNT(*) AS n FROM drive_folders WHERE owner = ?1').bind(user).first();
      if (n.n >= LIMITS.DFOLDERS_MAX) return failc('drive_folders_many');
      if (await db.prepare('SELECT 1 AS x FROM drive_folders WHERE owner = ?1 AND parent = ?2 AND name = ?3').bind(user, parent, name).first()) return failc('drive_dup');
      const r = await db.prepare('INSERT INTO drive_folders (owner, name, parent, created_at) VALUES (?1, ?2, ?3, ?4)').bind(user, name, parent, now).run();
      return json({ ok: true, id: r.meta.last_row_id });
    }
    case 'drive_folder_rename': {
      const name = clean(String(b.name || '').replace(/\s+/g, ' '), LIMITS.DFOLDER_NAME);
      if (!name) return failc('drive_name');
      const f = await db.prepare('SELECT id, parent FROM drive_folders WHERE id = ?1 AND owner = ?2').bind(Number(b.id), user).first();
      if (!f) return failc('drive_folder_gone', 404);
      if (await db.prepare('SELECT 1 AS x FROM drive_folders WHERE owner = ?1 AND parent = ?2 AND name = ?3 AND id != ?4').bind(user, f.parent, name, f.id).first()) return failc('drive_dup');
      await db.prepare('UPDATE drive_folders SET name = ?2 WHERE id = ?1').bind(f.id, name).run();
      return json({ ok: true });
    }
    case 'drive_folder_delete': {   // 只能删空文件夹
      const f = await db.prepare('SELECT id FROM drive_folders WHERE id = ?1 AND owner = ?2').bind(Number(b.id), user).first();
      if (!f) return json({ ok: true });
      const c1 = await db.prepare('SELECT COUNT(*) AS n FROM drive_folders WHERE owner = ?1 AND parent = ?2').bind(user, f.id).first();
      const c2 = await db.prepare("SELECT COUNT(*) AS n FROM drive_files WHERE owner = ?1 AND kind = 'file' AND folder = ?2").bind(user, f.id).first();
      if (c1.n || c2.n) return failc('drive_not_empty');
      await db.prepare('DELETE FROM drive_folders WHERE id = ?1').bind(f.id).run();
      return json({ ok: true });
    }
    case 'drive_rename': {
      const name = cleanFileName(b.name);
      if (!name) return failc('drive_name');
      const r = await db.prepare("UPDATE drive_files SET name = ?3 WHERE id = ?1 AND owner = ?2 AND kind = 'file'").bind(String(b.id || ''), user, name).run();
      return json({ ok: true });
    }
    case 'drive_move': {
      const folder = Math.max(0, Math.floor(Number(b.folder)) || 0);
      if (folder && !(await db.prepare('SELECT 1 AS x FROM drive_folders WHERE id = ?1 AND owner = ?2').bind(folder, user).first())) return failc('drive_folder_gone', 404);
      await db.prepare("UPDATE drive_files SET folder = ?3 WHERE id = ?1 AND owner = ?2 AND kind = 'file'").bind(String(b.id || ''), user, folder).run();
      return json({ ok: true });
    }
    case 'drive_delete': {   // 删除网盘文件：同时从帖子 / 私信的附件里消失；GitHub 上的内容进清理队列
      const f = await db.prepare("SELECT id, repo, path, sha FROM drive_files WHERE id = ?1 AND owner = ?2 AND kind = 'file'").bind(String(b.id || ''), user).first();
      if (!f) return json({ ok: true });
      await db.batch([
        db.prepare('INSERT INTO drive_gc (repo, path, sha) VALUES (?1, ?2, ?3)').bind(f.repo, f.path, f.sha),
        db.prepare('DELETE FROM drive_att WHERE file_id = ?1').bind(f.id),
        db.prepare('DELETE FROM drive_shares WHERE file_id = ?1').bind(f.id),
        db.prepare('DELETE FROM drive_files WHERE id = ?1').bind(f.id),
      ]);
      const cfg = ghCfg(env); if (cfg) { try { await gcTick(db, cfg, 3); } catch (e) {} }
      return json({ ok: true });
    }
    case 'drive_share': {   // all=true 所有登录用户可见；users 指定的人可见；都不选 = 仅自己。没有公开链接
      const f = await db.prepare("SELECT id FROM drive_files WHERE id = ?1 AND owner = ?2 AND kind = 'file'").bind(String(b.id || ''), user).first();
      if (!f) return failc('drive_gone', 404);
      const names = [...new Set((Array.isArray(b.users) ? b.users : []).map((x) => String(x)).filter((x) => x && x !== user))];
      if (names.length > LIMITS.SHARE_USERS_MAX) return failc('share_many');
      let valid = [];
      if (names.length) { const { results } = await db.prepare(`SELECT username FROM users WHERE username IN (${names.map(() => '?').join(',')})`).bind(...names).all(); valid = results.map((r) => r.username); }
      await db.batch([
        db.prepare('UPDATE drive_files SET share_all = ?2 WHERE id = ?1').bind(f.id, b.all ? 1 : 0),
        db.prepare('DELETE FROM drive_shares WHERE file_id = ?1').bind(f.id),
        ...valid.map((u) => db.prepare('INSERT OR IGNORE INTO drive_shares (file_id, to_user, created_at) VALUES (?1, ?2, ?3)').bind(f.id, u, now)),
      ]);
      return json({ ok: true, users: valid });
    }
    case 'drive_shared': {   // 别人分享给我的（含分享给所有人的）
      const offset = Math.max(0, Math.floor(Number(b.offset)) || 0);
      const { results } = await db.prepare(`SELECT f.id, f.owner, f.name, f.size, f.mime, f.created_at, a.updated_at AS av FROM drive_files f LEFT JOIN avatars a ON a.username = f.owner
          WHERE f.kind = 'file' AND f.owner != ?1 AND (f.share_all = 1 OR f.id IN (SELECT file_id FROM drive_shares WHERE to_user = ?1))
            AND f.owner NOT IN (SELECT blocker FROM blocks WHERE blocked = ?1) AND f.owner NOT IN (SELECT blocked FROM blocks WHERE blocker = ?1)
          ORDER BY f.created_at DESC LIMIT ?2 OFFSET ?3`).bind(user, LIMITS.DRIVE_PAGE + 1, offset).all();
      return json({ ok: true, files: results.slice(0, LIMITS.DRIVE_PAGE), hasMore: results.length > LIMITS.DRIVE_PAGE });
    }
    case 'drive_get': {   // 下载文件 / 查看图片：有权限才返回，内容从 GitHub 流式转发
      const cfg = ghCfg(env);
      if (!cfg) return failc('drive_off', 503);
      const f = await db.prepare('SELECT * FROM drive_files WHERE id = ?1').bind(String(b.id || '')).first();
      if (!f || !(await canReadFile(db, user, f))) return failc('drive_gone', 404);
      const up = await ghFetch(cfg, 'GET', f.repo, f.path, null, 'application/vnd.github.raw+json');
      if (!up.ok) return failc(up.status === 404 ? 'drive_gone' : 'drive_upstream', up.status === 404 ? 404 : 502);
      const img = f.kind === 'img';
      const ct = img ? f.mime : (DRIVE_MIMEBAD.test(f.mime) ? 'application/octet-stream' : f.mime);
      const headers = { ...cors, 'Content-Type': ct, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=3600', 'Content-Security-Policy': "sandbox; default-src 'none'" };
      if (!img) headers['Content-Disposition'] = "attachment; filename*=UTF-8''" + encodeURIComponent(f.name).replace(/['()]/g, escape);
      if (up.headers.get('content-length')) headers['Content-Length'] = up.headers.get('content-length');
      return new Response(up.body, { status: 200, headers });
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

// ---------- 辅助：私信会话 ----------
// 取（或创建）两个人之间的会话；create=false 时不存在就返回 null
async function getConv(db, u1, u2, create) {
  if (!u2 || u1 === u2) return null;
  const [a, b2] = u1 < u2 ? [u1, u2] : [u2, u1];
  let c = await db.prepare('SELECT * FROM dm_convs WHERE user_a = ?1 AND user_b = ?2').bind(a, b2).first();
  if (!c && create) {
    await db.prepare('INSERT OR IGNORE INTO dm_convs (user_a, user_b) VALUES (?1, ?2)').bind(a, b2).run();
    c = await db.prepare('SELECT * FROM dm_convs WHERE user_a = ?1 AND user_b = ?2').bind(a, b2).first();
  }
  return c;
}

// ---------- 辅助：个人主页 ----------
async function getProfile(db, name) {
  const r = await db.prepare('SELECT * FROM profiles WHERE username = ?1').bind(name).first();
  return r || { bio: '', show_posts: 1, show_comments: 1, show_likes: 0, show_marks: 0, show_follows: 1 };
}

// ---------- 辅助：评论删除 ----------
// 有子评论 → 软删除（留占位，保证下面的回复还在）；没有 → 真删；删完再顺着往上清掉已经没有子评论的占位
async function removeReply(db, id) {
  const r = await db.prepare('SELECT post_id, parent_id FROM replies WHERE id = ?1').bind(id).first();
  if (!r) return;
  const kids = await db.prepare('SELECT COUNT(*) AS n FROM replies WHERE parent_id = ?1').bind(id).first();
  if (kids.n > 0) {
    await db.batch([
      db.prepare("UPDATE replies SET deleted = 1, body = '', author = '' WHERE id = ?1").bind(id),
      db.prepare('DELETE FROM reply_likes WHERE reply_id = ?1').bind(id),
      db.prepare('UPDATE posts SET reply_count = MAX(reply_count - 1, 0) WHERE id = ?1').bind(r.post_id),
    ]);
    return;
  }
  await db.batch([
    db.prepare('DELETE FROM replies WHERE id = ?1').bind(id),
    db.prepare('DELETE FROM reply_likes WHERE reply_id = ?1').bind(id),
    db.prepare('UPDATE posts SET reply_count = MAX(reply_count - 1, 0) WHERE id = ?1').bind(r.post_id),
  ]);
  let pid = r.parent_id;
  while (pid) {
    const p = await db.prepare('SELECT parent_id, deleted FROM replies WHERE id = ?1').bind(pid).first();
    if (!p || !p.deleted) break;
    const k = await db.prepare('SELECT COUNT(*) AS n FROM replies WHERE parent_id = ?1').bind(pid).first();
    if (k.n > 0) break;
    await db.prepare('DELETE FROM replies WHERE id = ?1').bind(pid).run();
    pid = p.parent_id;
  }
}

// ---------- 辅助：话题 / 标签 / 列表 ----------
// 帖子列表的统一查询。where / args 是筛选条件；orderArgs 是 order 里用到的参数（在 limit 之前绑定）
async function listPosts(db, user, where, args, order, limit, offset, orderArgs) {
  const sql = `SELECT p.id, p.author, p.title, substr(p.body, 1, 80) AS snippet, p.created_at, p.last_at, p.reply_count, a.updated_at AS av,
                      (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS like_count,
                      (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id AND l.username = ?) AS liked,
                      (SELECT COUNT(*) FROM bookmarks k WHERE k.post_id = p.id) AS mark_count,
                      (SELECT COUNT(*) FROM bookmarks k WHERE k.post_id = p.id AND k.username = ?) AS marked,
                      (SELECT COUNT(*) FROM polls o WHERE o.post_id = p.id) AS has_poll
               FROM posts p LEFT JOIN avatars a ON a.username = p.author
               ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY ${order} LIMIT ? OFFSET ?`;
  const { results } = await db.prepare(sql).bind(user, user, ...args, ...(orderArgs || []), limit, offset).all();
  return results.map((r) => ({ ...r, liked: !!r.liked, marked: !!r.marked, has_poll: !!r.has_poll }));
}
// 给帖子数组补上 topics: [{id,name,creator}] 和 tags: [..]
async function attachMeta(db, posts) {
  if (!posts.length) return;
  const ids = posts.map((p) => p.id), ph = ids.map(() => '?').join(',');
  const { results: tr } = await db.prepare(`SELECT pt.post_id, t.id, t.name, t.creator FROM post_topics pt JOIN topics t ON t.id = pt.topic_id WHERE pt.post_id IN (${ph}) ORDER BY t.id`).bind(...ids).all();
  const { results: gr } = await db.prepare(`SELECT post_id, tag FROM post_tags WHERE post_id IN (${ph}) ORDER BY rowid`).bind(...ids).all();
  for (const p of posts) { p.topics = []; p.tags = []; }
  const by = new Map(posts.map((p) => [p.id, p]));
  for (const r of tr) by.get(r.post_id).topics.push({ id: r.id, name: r.name, creator: r.creator });
  for (const r of gr) by.get(r.post_id).tags.push(r.tag);
}
// 校验发帖 / 改帖时的话题和标签，出错返回错误码字符串
async function parseMeta(db, b) {
  const topics = Array.isArray(b.topics) ? [...new Set(b.topics.map(Number).filter((x) => Number.isInteger(x) && x > 0))] : [];
  if (topics.length > LIMITS.TOPICS_PER_POST) return 'topics_many';
  if (topics.length) {
    const { results } = await db.prepare(`SELECT id FROM topics WHERE id IN (${topics.map(() => '?').join(',')})`).bind(...topics).all();
    if (results.length !== topics.length) return 'topic_gone';
  }
  const tags = [];
  for (const raw of Array.isArray(b.tags) ? b.tags : []) {
    const t = clean(String(raw == null ? '' : raw).replace(/^#+/, '').replace(/\s+/g, ' '), LIMITS.TAG_LEN);
    if (t === null) return 'tag_len';
    if (t && !tags.some((x) => x.toLowerCase() === t.toLowerCase())) tags.push(t);
  }
  if (tags.length > LIMITS.TAGS_PER_POST) return 'tags_many';
  return { topics, tags };
}
function metaStmts(db, pid, meta, replace) {
  const out = [];
  if (replace) {
    out.push(db.prepare('DELETE FROM post_topics WHERE post_id = ?1').bind(pid), db.prepare('DELETE FROM post_tags WHERE post_id = ?1').bind(pid));
    // 帖子不再属于的话题，对应的话题置顶也撤掉
    out.push(db.prepare(`DELETE FROM pins WHERE post_id = ?1 AND scope != 'global'`).bind(pid));
  }
  for (const t of meta.topics) out.push(db.prepare('INSERT OR IGNORE INTO post_topics (post_id, topic_id) VALUES (?1, ?2)').bind(pid, t));
  for (const g of meta.tags) out.push(db.prepare('INSERT OR IGNORE INTO post_tags (post_id, tag) VALUES (?1, ?2)').bind(pid, g));
  return out;
}

// ---------- 辅助：投票 / 问卷 ----------
// 注销账号时要一起清掉的新数据：他的点赞、投票、问卷答卷、他发的问卷，以及他的帖子上的点赞 / 投票
// （同样的清理在 functions/api/[action].js 的 purgeForum 里也有一份，改这里时记得同步）
// ---------- 2901网盘：存储在 GitHub 私有仓库 ----------
// 需要在 Cloudflare Pages 的环境变量里配置：GH_TOKEN（Secret，细粒度 PAT，对存储仓库有 Contents 读写）、GH_OWNER（账号或组织名）、GH_REPOS（仓库名，逗号分隔，满了自动用下一个）、可选 GH_BRANCH
const DRIVE_MIMEBAD = /html|svg|javascript|xml/i;
function ghCfg(env) {
  if (!env.GH_TOKEN || !env.GH_OWNER) return null;
  const repos = String(env.GH_REPOS || '').split(',').map((x) => x.trim()).filter(Boolean);
  return repos.length ? { token: env.GH_TOKEN, owner: env.GH_OWNER, repos, branch: env.GH_BRANCH || '' } : null;
}
function ghUrl(cfg, repo, path, get) {
  return `https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(repo)}/contents/${path}` + (get && cfg.branch ? `?ref=${encodeURIComponent(cfg.branch)}` : '');
}
function ghHeaders(cfg, accept, json) {
  return { Authorization: 'Bearer ' + cfg.token, Accept: accept || 'application/vnd.github+json', 'User-Agent': '2901-drive', 'X-GitHub-Api-Version': '2022-11-28', ...(json ? { 'Content-Type': 'application/json' } : {}) };
}
function ghFetch(cfg, method, repo, path, body, accept) {
  return fetch(ghUrl(cfg, repo, path, method === 'GET'), { method, headers: ghHeaders(cfg, accept, !!body), body: body ? JSON.stringify(body) : undefined });
}
async function ghDelete(cfg, repo, path, sha) {
  for (let i = 0; i < 3; i++) {
    const r = await ghFetch(cfg, 'DELETE', repo, path, { message: 'rm', sha, ...(cfg.branch ? { branch: cfg.branch } : {}) });
    if (r.ok || r.status === 404) return true;
    if (r.status !== 409 && r.status < 500) return false;
    await new Promise((res) => setTimeout(res, 300 * (i + 1)));
  }
  return false;
}
// 清理队列：删文件 / 删账号只改数据库，GitHub 上的内容由这里慢慢删（每次最多 n 个）
async function gcTick(db, cfg, n) {
  const { results } = await db.prepare('SELECT id, repo, path, sha, tries FROM drive_gc ORDER BY id LIMIT ?1').bind(n).all();
  for (const g of results) {
    if (await ghDelete(cfg, g.repo, g.path, g.sha)) await db.prepare('DELETE FROM drive_gc WHERE id = ?1').bind(g.id).run();
    else if (g.tries >= 6) await db.prepare('DELETE FROM drive_gc WHERE id = ?1').bind(g.id).run();
    else await db.prepare('UPDATE drive_gc SET tries = tries + 1 WHERE id = ?1').bind(g.id).run();
  }
}
function randId() { const a = new Uint8Array(12); crypto.getRandomValues(a); return Array.from(a, (x) => x.toString(16).padStart(2, '0')).join(''); }
function cleanFileName(s) {
  const n = clean(String(s == null ? '' : s).replace(/[\\/\u0000-\u001f]/g, '_').replace(/\s+/g, ' '), LIMITS.DRIVE_NAME);
  return n && n !== '.' && n !== '..' ? n : null;
}
const IMG_MAGIC = { 'image/jpeg': [0xff, 0xd8, 0xff], 'image/png': [0x89, 0x50, 0x4e, 0x47], 'image/gif': [0x47, 0x49, 0x46, 0x38], 'image/webp': [0x52, 0x49, 0x46, 0x46] };

// 上传：正文是文件内容的 base64 文本（浏览器 btoa / FileReader 生成，已带 = 补齐），元数据在 X-Drive 头里（URL 编码的 JSON）。
// 不解析 JSON、不解码 base64，只是把它拼进 GitHub 的 PUT 请求里流式转发，所以 25MB 的文件也几乎不占 CPU。
async function driveUpload(request, env) {
  const db = env.DB;
  let meta; try { meta = JSON.parse(decodeURIComponent(request.headers.get('X-Drive') || '')); } catch (e) { return failc('drive_bad'); }
  const sess = meta && meta.token ? await db.prepare('SELECT username, created_at FROM sessions WHERE token = ?').bind(String(meta.token)).first() : null;
  if (!sess || Date.now() - sess.created_at > SESSION_MS) return fail('登录已过期', 401);
  const user = sess.username, now = Date.now();
  await ensureSchema(db);
  const cfg = ghCfg(env);
  if (!cfg) return failc('drive_off', 503);
  const img = meta.kind === 'img';
  const size = Math.floor(Number(meta.size));
  if (!(size > 0)) return failc('drive_bad');
  if (size > (img ? LIMITS.IMG_MAX : LIMITS.DRIVE_FILE_MAX)) return failc('drive_big', 413);
  const b64len = Math.ceil(size / 3) * 4;
  const cl = Number(request.headers.get('Content-Length'));
  if (cl && cl !== b64len) return failc('drive_bad');
  if (!request.body) return failc('drive_bad');
  let name, mime, folder = 0;
  if (img) {
    mime = String(meta.mime || ''); name = 'image';
    if (!IMG_MAGIC[mime]) return failc('drive_bad');
  } else {
    name = cleanFileName(meta.name); if (!name) return failc('drive_name');
    mime = clean(String(meta.mime || ''), 100) || 'application/octet-stream';
    if (!/^[\w.+-]+\/[\w.+-]+$/.test(mime)) mime = 'application/octet-stream';
    folder = Math.max(0, Math.floor(Number(meta.folder)) || 0);
    if (folder && !(await db.prepare('SELECT 1 AS x FROM drive_folders WHERE id = ?1 AND owner = ?2').bind(folder, user).first())) return failc('drive_folder_gone', 404);
  }
  const kind = img ? 'img' : 'file';
  const used = await db.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM drive_files WHERE owner = ?1 AND kind = ?2').bind(user, kind).first();
  if (used.n + size > (img ? LIMITS.IMG_QUOTA : LIMITS.DRIVE_QUOTA)) return failc('drive_quota', 413);
  const day = await db.prepare('SELECT COUNT(*) AS n FROM drive_files WHERE owner = ?1 AND kind = ?2 AND created_at > ?3').bind(user, kind, now - 86400000).first();
  if (day.n >= (img ? LIMITS.IMG_DAILY : LIMITS.UP_DAILY)) return failc('drive_limit', 429);
  const { results: usage } = await db.prepare('SELECT repo, SUM(size) AS n FROM drive_files GROUP BY repo').all();
  const by = new Map(usage.map((r) => [r.repo, r.n]));
  const repo = cfg.repos.find((r) => (by.get(r) || 0) + size <= LIMITS.REPO_SOFT);
  if (!repo) return failc('drive_full', 507);
  const id = randId();
  const path = `d/${id.slice(0, 2)}/${id}`;
  const enc = new TextEncoder();
  const pre = enc.encode(JSON.stringify({ message: 'add', ...(cfg.branch ? { branch: cfg.branch } : {}) }).slice(0, -1) + ',"content":"');
  const post = enc.encode('"}');
  let reqBody;
  if (typeof FixedLengthStream !== 'undefined') {
    const { readable, writable } = new FixedLengthStream(pre.length + b64len + post.length);
    (async () => {
      const w = writable.getWriter();
      try { await w.write(pre); const rd = request.body.getReader(); for (;;) { const { done, value } = await rd.read(); if (done) break; await w.write(value); } await w.write(post); await w.close(); }
      catch (e) { try { await w.abort(e); } catch (e2) {} }
    })();
    reqBody = readable;
  } else {   // 本地测试环境：直接拼字符串
    reqBody = new TextDecoder().decode(pre) + await request.text() + '"}';
  }
  let up;
  try { up = await fetch(ghUrl(cfg, repo, path), { method: 'PUT', headers: ghHeaders(cfg, null, true), body: reqBody, ...(typeof FixedLengthStream !== 'undefined' ? { duplex: 'half' } : {}) }); }
  catch (e) { return failc('drive_upstream', 502); }
  if (!up.ok) return up.status === 409 ? failc('drive_busy', 503) : failc('drive_upstream', 502);
  const j = await up.json().catch(() => null);
  const sha = j && j.content && j.content.sha;
  if (!sha) return failc('drive_upstream', 502);
  if (img) {   // 图片：确认文件头与声明的类型一致，不一致就丢掉（不让人用图片接口存别的东西当图床）
    const chk = await fetch(ghUrl(cfg, repo, path, true), { headers: { ...ghHeaders(cfg, 'application/vnd.github.raw+json'), Range: 'bytes=0-11' } }).then((r) => r.ok ? r.arrayBuffer() : null).catch(() => null);
    if (chk) {
      const u8 = new Uint8Array(chk).subarray(0, 12), mg = IMG_MAGIC[mime];
      if (!mg.every((x, i) => u8[i] === x)) { await ghDelete(cfg, repo, path, sha); return failc('drive_bad'); }
    }
  }
  try {
    await db.prepare('INSERT INTO drive_files (id, owner, kind, name, folder, size, mime, repo, path, sha, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)').bind(id, user, kind, name, folder, size, mime, repo, path, sha, now).run();
  } catch (e) { await db.prepare('INSERT INTO drive_gc (repo, path, sha) VALUES (?1, ?2, ?3)').bind(repo, path, sha).run(); return failc('drive_upstream', 502); }
  return json({ ok: true, id, name, size, mime, kind });
}

async function canReadFile(db, user, f) {
  if (f.owner === user) return true;
  if (f.kind === 'file') {
    if (await db.prepare('SELECT 1 AS x FROM blocks WHERE (blocker = ?1 AND blocked = ?2) OR (blocker = ?2 AND blocked = ?1)').bind(user, f.owner).first()) return false;
    if (f.share_all) return true;
    if (await db.prepare('SELECT 1 AS x FROM drive_shares WHERE file_id = ?1 AND to_user = ?2').bind(f.id, user).first()) return true;
  }
  if (await db.prepare("SELECT 1 AS x FROM drive_att a JOIN posts p ON p.id = a.ref WHERE a.file_id = ?1 AND a.kind = 'post'").bind(f.id).first()) return true;
  if (await db.prepare("SELECT 1 AS x FROM drive_att a JOIN dm_msgs m ON m.id = a.ref JOIN dm_convs c ON c.id = m.conv_id WHERE a.file_id = ?1 AND a.kind = 'dm' AND m.recalled = 0 AND (c.user_a = ?2 OR c.user_b = ?2)").bind(f.id, user).first()) return true;
  return false;
}
// 校验附件：必须是自己的文件 / 图片，数量不超限
async function validateAtt(db, user, ids, kind) {
  ids = [...new Set((Array.isArray(ids) ? ids : []).map((x) => String(x)).filter((x) => /^[0-9a-f]{24}$/.test(x)))];
  if (!ids.length) return [];
  const { results } = await db.prepare(`SELECT id, kind FROM drive_files WHERE owner = ?1 AND id IN (${ids.map(() => '?').join(',')})`).bind(user, ...ids).all();
  if (results.length !== ids.length) return 'att_gone';
  const imgs = results.filter((r) => r.kind === 'img').length, files = results.length - imgs;
  if (kind === 'post' ? (imgs > LIMITS.ATT_POST_IMGS || files > LIMITS.ATT_POST_FILES) : results.length > LIMITS.ATT_DM) return 'att_many';
  return results;
}
async function loadAtts(db, kind, refs) {
  const out = new Map();
  if (!refs.length) return out;
  const { results } = await db.prepare(`SELECT a.ref, f.id, f.kind, f.name, f.size, f.mime FROM drive_att a JOIN drive_files f ON f.id = a.file_id WHERE a.kind = ?1 AND a.ref IN (${refs.map(() => '?').join(',')}) ORDER BY f.created_at`).bind(kind, ...refs).all();
  for (const r of results) { if (!out.has(r.ref)) out.set(r.ref, []); out.get(r.ref).push({ id: r.id, kind: r.kind, name: r.name, size: r.size, mime: r.mime }); }
  return out;
}
// 帖子删除 / 私信撤回：附件关系删掉；只挂在这里的图片进清理队列（网盘文件只是不再挂着，文件本身还在网盘里）
async function dropAtts(db, kind, ref) {
  try {
    const cond = "kind = 'img' AND id IN (SELECT file_id FROM drive_att WHERE kind = ?1 AND ref = ?2) AND id NOT IN (SELECT file_id FROM drive_att WHERE NOT (kind = ?1 AND ref = ?2))";
    await db.batch([
      db.prepare(`INSERT INTO drive_gc (repo, path, sha) SELECT repo, path, sha FROM drive_files WHERE ${cond}`).bind(kind, ref),
      db.prepare(`DELETE FROM drive_files WHERE ${cond}`).bind(kind, ref),
      db.prepare('DELETE FROM drive_att WHERE kind = ?1 AND ref = ?2').bind(kind, ref),
    ]);
  } catch (e) { /* 网盘表还没建 */ }
}
// 兜底清理：帖子 / 私信已不存在的附件关系，以及超过 2 小时还没挂到任何地方的图片
async function sweepDrive(db, now) {
  const old = now - LIMITS.ORPHAN_MS;
  const cond = "kind = 'img' AND created_at < ?1 AND id NOT IN (SELECT file_id FROM drive_att)";
  await db.batch([
    db.prepare("DELETE FROM drive_att WHERE kind = 'post' AND ref NOT IN (SELECT id FROM posts)"),
    db.prepare("DELETE FROM drive_att WHERE kind = 'dm' AND ref NOT IN (SELECT id FROM dm_msgs)"),
    db.prepare(`INSERT INTO drive_gc (repo, path, sha) SELECT repo, path, sha FROM drive_files WHERE ${cond}`).bind(old),
    db.prepare(`DELETE FROM drive_files WHERE ${cond}`).bind(old),
  ]);
}

function userContentCleanup(db, u) {
  return [
    db.prepare('INSERT INTO drive_gc (repo, path, sha) SELECT repo, path, sha FROM drive_files WHERE owner = ?1').bind(u),
    db.prepare('DELETE FROM drive_att WHERE file_id IN (SELECT id FROM drive_files WHERE owner = ?1)').bind(u),
    db.prepare('DELETE FROM drive_shares WHERE to_user = ?1 OR file_id IN (SELECT id FROM drive_files WHERE owner = ?1)').bind(u),
    db.prepare('DELETE FROM drive_files WHERE owner = ?1').bind(u),
    db.prepare('DELETE FROM drive_folders WHERE owner = ?1').bind(u),
    db.prepare('DELETE FROM likes WHERE post_id IN (SELECT id FROM posts WHERE author = ?1)').bind(u),
    db.prepare('DELETE FROM poll_votes WHERE post_id IN (SELECT id FROM posts WHERE author = ?1)').bind(u),
    db.prepare('DELETE FROM polls WHERE post_id IN (SELECT id FROM posts WHERE author = ?1)').bind(u),
    db.prepare('DELETE FROM reply_likes WHERE reply_id IN (SELECT id FROM replies WHERE author = ?1 OR post_id IN (SELECT id FROM posts WHERE author = ?1))').bind(u),
    db.prepare('DELETE FROM reply_likes WHERE username = ?1').bind(u),
    db.prepare('DELETE FROM dm_msgs WHERE conv_id IN (SELECT id FROM dm_convs WHERE user_a = ?1 OR user_b = ?1)').bind(u),
    db.prepare('DELETE FROM dm_convs WHERE user_a = ?1 OR user_b = ?1').bind(u),
    db.prepare('DELETE FROM blocks WHERE blocker = ?1 OR blocked = ?1').bind(u),
    db.prepare('DELETE FROM dm_reports WHERE reporter = ?1 OR reported = ?1').bind(u),
    db.prepare('DELETE FROM follows WHERE follower = ?1 OR followee = ?1').bind(u),
    db.prepare('DELETE FROM profiles WHERE username = ?1').bind(u),
    db.prepare('DELETE FROM post_topics WHERE post_id IN (SELECT id FROM posts WHERE author = ?1)').bind(u),
    db.prepare('DELETE FROM post_tags WHERE post_id IN (SELECT id FROM posts WHERE author = ?1)').bind(u),
    db.prepare('DELETE FROM pins WHERE post_id IN (SELECT id FROM posts WHERE author = ?1)').bind(u),
    db.prepare('DELETE FROM bookmarks WHERE post_id IN (SELECT id FROM posts WHERE author = ?1)').bind(u),
    db.prepare('DELETE FROM bookmarks WHERE username = ?1').bind(u),
    db.prepare('DELETE FROM bookmark_folders WHERE username = ?1').bind(u),
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
