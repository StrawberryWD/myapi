// GET /api/avatar/用户名?v=版本号  → 返回该用户的头像图片（没有头像返回 404，前端会显示首字母）
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};
export async function onRequestGet({ env, params }) {
  if (!env.DB) return new Response('no db', { status: 500, headers: cors });
  let name = params.name;
  try { name = decodeURIComponent(name); } catch (e) {}
  let row = null;
  try {
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS avatars (username TEXT PRIMARY KEY, mime TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL)').run();
    row = await env.DB.prepare('SELECT mime, data FROM avatars WHERE username = ?').bind(name).first();
  } catch (e) {}
  if (!row) return new Response('', { status: 404, headers: { ...cors, 'Cache-Control': 'public, max-age=60' } });
  const bytes = Uint8Array.from(atob(row.data), (c) => c.charCodeAt(0));
  return new Response(bytes, {
    headers: {
      ...cors,
      'Content-Type': row.mime,
      'X-Content-Type-Options': 'nosniff',
      // 前端 URL 带 ?v=更新时间，换头像后地址就变了，所以可以放心长缓存（省 D1 读取）
      'Cache-Control': 'public, max-age=86400',
    },
  });
}
