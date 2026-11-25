// Гэр бүлийн цомог — Cloudflare Worker (олон гэр бүлийн хувилбар)
// Хуудсууд (public/*) GitHub-аас татагдана; өгөгдөл D1-д гэр бүл (space) бүрээр тусгаарлагдана.
// Зураг тухайн гэр бүлийн эзний Google Drive-д (хуучин зургууд KV-д) хадгалагдана,
// нэвтрэх код Gmail-ээр (Apps Script) явна.

const APPS = {
  album: { read: ['family'], comment: ['family'], upload: ['family'], add: ['family'] },
  share: { read: ['coworker'], comment: [], upload: ['coworker'] }
};
const PAGES = { 'album.html': 'text/html', 'share.html': 'text/html', 'login.html': 'text/html', 'admin.html': 'text/html', 'landing.html': 'text/html', 'home.html': 'text/html', 'terms.html': 'text/html', 'shim.js': 'text/javascript' };
const MAX_DOC = 256 * 1024;
const MAX_KV_FILE = 20 * 1024 * 1024;
const MAX_FILE = 60 * 1024 * 1024;
const KV_QUOTA = 1000 * 1024 * 1024;
const KV_FILES = 5000;
const MAX_OWNED = 3;
const MAIL_PER_DAY = 90;
const FILE_TYPES = /^(image\/(jpeg|png|webp|gif|heic|heif)|video\/(mp4|webm|quicktime)|application\/pdf)$/;
const SEG = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
const SID = /^[a-z0-9]{8}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DAY = 86400e3;
const GSCOPE = 'https://www.googleapis.com/auth/drive.file openid email';

const enc = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha = async s => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const rnd = (n = 32) => hex(crypto.getRandomValues(new Uint8Array(n)));
const sidNew = () => [...crypto.getRandomValues(new Uint8Array(8))].map(b => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');
const json = (o, status = 200, headers = {}) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
const fail = (code, status = 400) => json({ error: code }, status);
const redirect = (to, headers = {}) => new Response(null, { status: 302, headers: { location: to, ...headers } });
const SEC = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'x-frame-options': 'DENY' };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cleanEmail = v => String(v || '').trim().toLowerCase().slice(0, 200);
const cleanName = (v, n = 40) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, n);

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const p = url.pathname;
    const post = req.method === 'POST';
    try {
      if (p === '/login') return page(env, ctx, 'login.html');
      if (p === '/terms') return page(env, ctx, 'terms.html');
      if (p === '/shim.js') return page(env, ctx, 'shim.js');
      if (p === '/login/setup') return setupLogin(env, url);
      if (p === '/login/link') return linkPage(url);
      if (p === '/api/login/link') return linkLogin(req, env);
      if (p === '/api/login/start' || p === '/api/login/verify') return loginApi(req, env, url, p);

      const me = await session(req, env);
      if (p === '/api/logout') return logout(req, env);
      if (!me) {
        if (p === '/' || p === '/index.html') return page(env, ctx, 'landing.html');
        if (p.startsWith('/api/') || p.startsWith('/_blob/')) return fail('signed_out', 401);
        return redirect('/login?next=' + encodeURIComponent(p + url.search));
      }
      if (p === '/api/me') return json(await meInfo(env, me, url.searchParams.get('space')));
      if (p === '/api/account' && post) return account(req, env, me);
      if (p === '/api/spaces' && post) return createSpace(req, env, me);
      if (p === '/home') return page(env, ctx, 'home.html');
      if (p === '/' || p === '/index.html' || p === '/share' || p === '/share/' || p === '/admin') return legacy(env, me, p);
      if (p === '/oauth/google/callback') return driveCallback(env, me, url);
      const sm = p.match(/^\/s\/([a-z0-9]{8})(\/.*)?$/);
      if (sm) return spaceRoute(env, ctx, me, url, sm[1], sm[2] || '');
      if (p.startsWith('/_blob/')) return blob(env, ctx, me, p.slice(7));
      if (p === '/api/db' && post) return dbApi(req, env, ctx, me, url);
      if (p === '/api/assets' && post) return upload(req, env, me, url);
      if (p.startsWith('/api/assets/') && req.method === 'DELETE') return removeAsset(env, me, p.slice(12));
      if (p.startsWith('/api/admin/')) return adminApi(req, env, url, p.slice(11), me);
      return new Response('Хуудас олдсонгүй', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    } catch (e) {
      console.error(e && e.stack || e);
      return fail('server_error', 500);
    }
  }
};

/* ---------- pages from GitHub ---------- */
const mem = new Map();
async function page(env, ctx, name) {
  const type = PAGES[name] + '; charset=utf-8';
  const m = mem.get(name);
  let body = m && Date.now() - m.at < 60e3 ? m.body : null;
  if (body === null) {
    try {
      const r = await fetch(`${env.SOURCE_URL}/${name}`, { headers: env.GITHUB_TOKEN ? { authorization: 'token ' + env.GITHUB_TOKEN } : {}, cf: { cacheTtl: 60, cacheEverything: true } });
      if (!r.ok) throw new Error('source ' + r.status);
      body = await r.text();
      mem.set(name, { body, at: Date.now() });
      ctx.waitUntil((async () => {
        const h = await sha(body);
        if ((await env.PHOTOS.get('page-hash:' + name)) !== h) {
          await env.PHOTOS.put('page:' + name, body);
          await env.PHOTOS.put('page-hash:' + name, h);
        }
      })());
    } catch (e) {
      body = m ? m.body : await env.PHOTOS.get('page:' + name);
    }
  }
  if (body === null) return new Response('Хуудсыг ачаалж чадсангүй. Түр хүлээгээд дахин оролдоорой.', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  return new Response(body, { headers: { 'content-type': type, 'cache-control': 'no-store', ...SEC } });
}
function notice(title, text, status = 403) {
  const html = `<!DOCTYPE html><html lang="mn"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#1d1322;color:#fbeee0;font:16px/1.5 system-ui,sans-serif;text-align:center;padding:20px"><div><h1 style="font-size:28px">${esc(title)}</h1><p>${text}</p><p><a style="color:#ffb45e" href="/home">Миний гэр бүлүүд</a> · <a style="color:#ffb45e" href="/login" onclick="fetch('/api/logout',{method:'POST'}).then(()=>location.href='/login');return false">Өөр хаягаар нэвтрэх</a></p></div></body></html>`;
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...SEC } });
}
const noAccess = me => notice('Энэ хэсгийг харах эрх алга', `${esc(me.email)} хаягаар нэвтэрсэн байна.`);

/* ---------- accounts, families & sessions ---------- */
const cfgCache = new Map();
async function cfg(env, k) {
  const c = cfgCache.get(k);
  if (c && Date.now() - c.at < 30e3) return c.v;
  const row = await env.DB.prepare('SELECT v FROM config WHERE k = ?').bind(k).first();
  const v = row ? row.v : null;
  cfgCache.set(k, { v, at: Date.now() });
  return v;
}
async function setCfg(env, k, v) {
  cfgCache.delete(k);
  if (v === null) await env.DB.prepare('DELETE FROM config WHERE k = ?').bind(k).run();
  else await env.DB.prepare('INSERT INTO config (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(k, String(v)).run();
}
const ownerEmail = env => cleanEmail(env.OWNER_EMAIL);
const uidOf = async email => 'u' + (await sha('uid:' + email)).slice(0, 20);
async function ensureAccount(env, email, name) {
  await env.DB.prepare('INSERT INTO accounts (email, name, created) VALUES (?, ?, ?) ON CONFLICT(email) DO NOTHING').bind(email, cleanName(name) || email.split('@')[0], Date.now()).run();
}
async function who(env, email) {
  email = cleanEmail(email);
  if (!email) return null;
  const a = await env.DB.prepare('SELECT name FROM accounts WHERE email = ?').bind(email).first();
  if (!a) return null;
  return { email, name: a.name || email.split('@')[0], uid: await uidOf(email), platform: email === ownerEmail(env) };
}
async function spaceCtx(env, me, sid) {
  if (!me || !SID.test(String(sid || ''))) return null;
  const row = await env.DB.prepare('SELECT s.name AS sname, s.drive AS drive, m.name AS name, m.roles AS roles FROM spaces s JOIN members m ON m.space = s.id WHERE s.id = ? AND m.email = ?').bind(sid, me.email).first();
  if (!row) return null;
  const r = String(row.roles || '').split(',');
  const owner = r.includes('owner');
  return { ...me, space: sid, spaceName: row.sname, drive: !!row.drive, owner, roles: owner ? ['owner', 'family', 'coworker'] : r.filter(x => x === 'family' || x === 'coworker'), name: row.name || me.name };
}
const can = (sp, app, what) => !!sp && (sp.owner || (APPS[app][what] || []).some(r => sp.roles.includes(r)));
async function mySpaces(env, me) {
  const { results } = await env.DB.prepare('SELECT s.id, s.name, m.roles FROM members m JOIN spaces s ON s.id = m.space WHERE m.email = ? ORDER BY m.added').bind(me.email).all();
  return results.map(r => { const roles = String(r.roles || '').split(','); return { id: r.id, name: r.name, owner: roles.includes('owner'), album: roles.includes('owner') || roles.includes('family'), share: roles.includes('owner') || roles.includes('coworker') }; });
}
async function meInfo(env, me, sid) {
  const base = { email: me.email, name: me.name, uid: me.uid, platform: me.platform, spaces: await mySpaces(env, me) };
  const sp = sid ? await spaceCtx(env, me, sid) : null;
  if (!sp) return base;
  const store = sp.drive || sid === (await cfg(env, 'kv_space'));
  const c = app => ({ read: can(sp, app, 'read'), comment: can(sp, app, 'comment'), upload: can(sp, app, 'upload'), add: can(sp, app, 'add'), edit: sp.owner });
  return { ...base, name: sp.name, owner: sp.owner, roles: sp.roles, can: { album: c('album'), share: c('share') }, space: { id: sid, name: sp.spaceName, drive: sp.drive, store, owner: sp.owner } };
}
async function session(req, env) {
  const m = (req.headers.get('cookie') || '').match(/(?:^|;\s*)sid=([a-f0-9]{64})/);
  if (!m) return null;
  const row = await env.DB.prepare('SELECT email, expires FROM sessions WHERE token = ?').bind(await sha(m[1])).first();
  if (!row || row.expires < Date.now()) return null;
  return who(env, row.email);
}
async function startSession(env, email) {
  const tok = rnd(32);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO sessions (token, email, expires) VALUES (?, ?, ?)').bind(await sha(tok), email, Date.now() + 60 * DAY),
    env.DB.prepare('DELETE FROM sessions WHERE expires < ?').bind(Date.now())
  ]);
  return `sid=${tok}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 86400}`;
}
async function logout(req, env) {
  const m = (req.headers.get('cookie') || '').match(/(?:^|;\s*)sid=([a-f0-9]{64})/);
  if (m) await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(await sha(m[1])).run();
  return json({ ok: true }, 200, { 'set-cookie': 'sid=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0' });
}
async function setupLogin(env, url) {
  const t = url.searchParams.get('t') || '';
  const want = await cfg(env, 'setup_hash');
  if (!t || !want || (await sha(t)) !== want || !ownerEmail(env)) return redirect('/login?setup=bad');
  await setCfg(env, 'setup_hash', null);
  await ensureAccount(env, ownerEmail(env));
  return redirect('/admin', { 'set-cookie': await startSession(env, ownerEmail(env)) });
}
const LINK_HTML = `<!doctype html><html lang="mn"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Гэр бүлийн цомог</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;padding:20px;box-sizing:border-box;font:17px/1.5 system-ui,-apple-system,sans-serif;color:#fbeee0;background:radial-gradient(80% 50% at 50% 112%,rgba(255,166,92,.75),rgba(255,120,150,.25) 45%,transparent 75%),linear-gradient(180deg,#22152a,#3b2341 50%,#6b3954 82%,#b5635a)}main{width:min(400px,100%);background:#2a1d30;border-radius:18px;padding:30px 24px;text-align:center;box-shadow:0 30px 60px -20px rgba(0,0,0,.6)}h1{font-size:28px;margin:0 0 8px}p{color:#c4a9b8;margin:0 0 20px}button{width:100%;min-height:54px;border:0;border-radius:999px;background:linear-gradient(135deg,#ffc36e,#ff9a7a);color:#2a1420;font:800 18px system-ui,-apple-system,sans-serif;cursor:pointer}button:disabled{opacity:.6}#m{min-height:24px;margin:14px 0 0;color:#ffb2a6;font-weight:700}</style></head><body><main><h1>Гэр бүлийн цомог</h1><p>Танд цомог үзэх урилга ирлээ. Доорх товчийг дарж нэвтэрнэ үү.</p><button id="b">Нэвтрэх</button><p id="m"></p></main><script>const b=document.getElementById('b'),m=document.getElementById('m');b.onclick=async()=>{b.disabled=true;m.textContent='';try{const r=await fetch('/api/login/link',{method:'POST',headers:{'content-type':'application/json'},credentials:'same-origin',body:JSON.stringify({t:'__T__'})});if(r.ok){location.replace('/');return}m.textContent='Линкийн хугацаа дууссан эсвэл хүчингүй байна. Цомгийн эзнээс шинэ линк аваарай.'}catch(e){m.textContent='Холбогдож чадсангүй. Дахин оролдоорой.'}b.disabled=false}</script></body></html>`;
function linkPage(url) {
  const t = (url.searchParams.get('t') || '').replace(/[^a-f0-9]/g, '').slice(0, 64);
  return new Response(LINK_HTML.replace('__T__', t), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...SEC } });
}
async function linkLogin(req, env) {
  if (req.method !== 'POST') return fail('method', 405);
  const b = await req.json().catch(() => ({}));
  const t = String(b.t || '');
  if (!/^[a-f0-9]{40}$/.test(t)) return fail('expired');
  const row = await env.DB.prepare('SELECT email, expires FROM invites WHERE hash = ?').bind(await sha('inv:' + t)).first();
  if (!row || row.expires < Date.now()) return fail('expired');
  const mem0 = await env.DB.prepare('SELECT name FROM members WHERE email = ? LIMIT 1').bind(row.email).first();
  if (!mem0 && row.email !== ownerEmail(env)) return fail('expired');
  await ensureAccount(env, row.email, mem0 && mem0.name);
  return json({ ok: true }, 200, { 'set-cookie': await startSession(env, row.email) });
}
const today = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
async function loginApi(req, env, url, p) {
  if (req.method !== 'POST') return fail('method', 405);
  const b = await req.json().catch(() => ({}));
  const email = cleanEmail(b.email);
  if (!EMAIL.test(email)) return fail('bad_email');
  const pepper = env.PEPPER || 'pepper';
  if (p === '/api/login/start') {
    if (!(await cfg(env, 'script_url'))) return fail('mail_not_ready', 503);
    const prev = await env.DB.prepare('SELECT sent FROM codes WHERE email = ?').bind(email).first();
    if (prev && Date.now() - prev.sent < 45e3) return fail('wait', 429);
    const dk = 'mail:' + today(), sent = +(await cfg(env, dk)) || 0;
    if (sent >= MAIL_PER_DAY) return fail('mail_daily_limit', 503);
    const code = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
    await env.DB.prepare('INSERT INTO codes (email, hash, expires, tries, sent) VALUES (?, ?, ?, 0, ?) ON CONFLICT(email) DO UPDATE SET hash = excluded.hash, expires = excluded.expires, tries = 0, sent = excluded.sent')
      .bind(email, await sha(pepper + email + code), Date.now() + 10 * 60e3, Date.now()).run();
    const person = await who(env, email);
    const html = `<div style="font-family:Arial,sans-serif;font-size:16px;color:#222"><p>Сайн байна уу${person ? ', ' + esc(person.name) : ''}!</p><p>«Гэр бүлийн цомог»-д нэвтрэх код:</p><p style="font-size:32px;font-weight:bold;letter-spacing:6px">${code}</p><p>Код 10 минутын дотор хүчинтэй. Та өөрөө хүсээгүй бол энэ захидлыг үл тоомсорлоорой.</p><p><a href="${url.origin}/login">${url.origin}</a></p></div>`;
    const r = await callScript(env, { action: 'mail', to: email, subject: `Нэвтрэх код: ${code}`, html });
    if (!r.ok) return fail('mail_failed', 502);
    await setCfg(env, dk, sent + 1);
    return json({ ok: true });
  }
  const code = String(b.code || '').replace(/\D/g, '');
  const row = await env.DB.prepare('SELECT hash, expires, tries FROM codes WHERE email = ?').bind(email).first();
  if (!row || row.expires < Date.now() || row.tries >= 5) return fail('expired');
  if (row.hash !== (await sha(pepper + email + code))) {
    await env.DB.prepare('UPDATE codes SET tries = tries + 1 WHERE email = ?').bind(email).run();
    return fail(row.tries + 1 >= 5 ? 'expired' : 'wrong_code');
  }
  await env.DB.prepare('DELETE FROM codes WHERE email = ?').bind(email).run();
  const mem0 = await env.DB.prepare('SELECT name FROM members WHERE email = ? LIMIT 1').bind(email).first();
  await ensureAccount(env, email, mem0 && mem0.name);
  return json({ ok: true }, 200, { 'set-cookie': await startSession(env, email) });
}
async function account(req, env, me) {
  const b = await req.json().catch(() => ({}));
  const name = cleanName(b.name);
  if (!name) return fail('bad_name');
  await env.DB.prepare('UPDATE accounts SET name = ? WHERE email = ?').bind(name, me.email).run();
  return json({ ok: true });
}
async function createSpace(req, env, me) {
  const b = await req.json().catch(() => ({}));
  const name = cleanName(b.name, 60);
  if (!name) return fail('bad_name');
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM members WHERE email = ? AND roles LIKE '%owner%'").bind(me.email).first();
  if (n.n >= MAX_OWNED && !me.platform) return fail('too_many');
  if (b.myName) await env.DB.prepare('UPDATE accounts SET name = ? WHERE email = ?').bind(cleanName(b.myName), me.email).run();
  const id = sidNew(), now = Date.now();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO spaces (id, name, owner, created) VALUES (?, ?, ?, ?)').bind(id, name, me.email, now),
    env.DB.prepare('INSERT INTO members (space, email, name, roles, added) VALUES (?, ?, ?, ?, ?)').bind(id, me.email, cleanName(b.myName) || me.name, 'owner', now)
  ]);
  return json({ ok: true, id });
}
async function legacy(env, me, p) {
  const sp = await mySpaces(env, me);
  if (sp.length !== 1) return redirect('/home');
  const s = sp[0], tail = p.startsWith('/share') ? '/share/' : p === '/admin' ? (s.owner ? '/admin' : '/') : (s.album ? '/' : '/share/');
  return redirect(`/s/${s.id}${tail}`);
}
async function spaceRoute(env, ctx, me, url, sid, rest) {
  const sp = await spaceCtx(env, me, sid);
  if (!sp) return notice('Энэ гэр бүлийн цомгийг харах эрх алга', `${esc(me.email)} хаягаар нэвтэрсэн байна. Цомгийн эзнээс урилга аваарай.`);
  if (rest === '') return redirect(`/s/${sid}/`);
  if (rest === '/' || rest === '/index.html') {
    if (can(sp, 'album', 'read')) return page(env, ctx, 'album.html');
    return can(sp, 'share', 'read') ? redirect(`/s/${sid}/share/`) : noAccess(me);
  }
  if (rest === '/share') return redirect(`/s/${sid}/share/`);
  if (rest === '/share/') return can(sp, 'share', 'read') ? page(env, ctx, 'share.html') : noAccess(me);
  if (rest === '/admin') return sp.owner ? page(env, ctx, 'admin.html') : noAccess(me);
  if (rest === '/drive/connect') return sp.owner ? driveConnect(env, sp, url) : noAccess(me);
  return new Response('Хуудас олдсонгүй', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

/* ---------- document store (per family) ---------- */
const parentOf = path => path.split('/').slice(0, -1).join('/');
function okPath(path) { const s = String(path || '').split('/'); return s.length > 0 && s.length <= 16 && path.length <= 1000 && s.every(x => SEG.test(x) && x !== '.' && x !== '..'); }
function rule(sp, app, path, op, old) {
  const s = path.split('/');
  if (!can(sp, app, 'read')) return false;
  if (s[0] === 'data' && s[1] === 'users') return s[2] === sp.uid && (op === 'read' || sp.owner || can(sp, app, 'add'));
  if (op === 'read' || sp.owner) return true;
  if (app === 'album' && s[0] === 'albums' && can(sp, 'album', 'add')) return true;
  if (app === 'album' && s[0] === 'comments' && s.length === 2 && can(sp, 'album', 'comment')) return op === 'set' && !old ? true : !!old && old.by === sp.uid;
  if (app === 'share' && s[0] === 'batches' && s.length === 2 && can(sp, 'share', 'upload')) return op === 'set' && !old ? true : !!old && old.by === sp.uid;
  return false;
}
async function getDoc(env, sid, app, path) {
  const row = await env.DB.prepare('SELECT data, updated FROM sdocs WHERE space = ? AND app = ? AND path = ?').bind(sid, app, path).first();
  return row ? { data: JSON.parse(row.data), updated: row.updated } : null;
}
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
function merge(a, b) { const o = { ...a }; for (const [k, v] of Object.entries(b)) o[k] = isObj(v) && isObj(o[k]) ? merge(o[k], v) : v; return o; }
const bump = (env, sid, app, parent) => env.DB.prepare('INSERT INTO scols (space, app, parent, ver) VALUES (?, ?, ?, 1) ON CONFLICT(space, app, parent) DO UPDATE SET ver = ver + 1').bind(sid, app, parent);

async function albumGuard(env, sp, s, op, old, data) {
  const mine = x => !!x && x.by === sp.uid;
  if (s.length === 2) {
    if (op === 'delete') return mine(old);
    if (!old || mine(old)) return { ...data, by: sp.uid, byName: (old && old.byName) || sp.name };
    if (!old.collab) return null;
    const o = { ...old };
    for (const k of ['np', 'nph', 'cover']) if (k in data) o[k] = data[k];
    return o;
  }
  if (s.length === 4 && s[2] === 'pages') {
    const alb = await getDoc(env, sp.space, 'album', 'albums/' + s[1]);
    if (!alb) return null;
    if (mine(alb.data)) return op === 'delete' ? true : data;
    if (!alb.data.collab) return null;
    const its = x => Array.isArray(x && x.items) ? x.items.filter(isObj) : [];
    if (op === 'delete') return !!old && mine(old) && its(old).every(mine);
    if (!old) return { n: Number(data.n) || 0, bg: String(data.bg || ''), items: its(data).filter(mine), by: sp.uid };
    const others = its(old).filter(i => !mine(i)), ids = new Set(others.map(i => i.id));
    return { ...old, items: [...others, ...its(data).filter(i => mine(i) && !ids.has(i.id))] };
  }
  return null;
}
async function dbApi(req, env, ctx, me, url) {
  const b = await req.json().catch(() => null);
  if (!b) return fail('invalid_argument');
  const sp = await spaceCtx(env, me, b.space);
  if (!sp) return fail('not_member', 403);
  const sid = sp.space;
  const app = b.app === 'share' ? 'share' : 'album';
  if (b.op === 'poll') return poll(env, sp, app, b.subs);
  const path = String(b.path || '');
  if (!okPath(path)) return fail('invalid_argument');
  const n = path.split('/').length;
  if (b.op === 'list') {
    if (n % 2 === 0) return fail('invalid_argument');
    if (!rule(sp, app, path + '/x', 'read')) return json({ docs: [] });
    const { results } = await env.DB.prepare('SELECT path, data FROM sdocs WHERE space = ? AND app = ? AND parent = ?').bind(sid, app, path).all();
    return json({ docs: results.map(r => ({ path: r.path, data: JSON.parse(r.data) })) });
  }
  if (n % 2 !== 0) return fail('invalid_argument');
  if (b.op === 'get') {
    if (!rule(sp, app, path, 'read')) return json({ exists: false });
    const d = await getDoc(env, sid, app, path);
    return json(d ? { exists: true, data: d.data } : { exists: false });
  }
  if (!['set', 'update', 'delete'].includes(b.op)) return fail('invalid_argument');
  const old = await getDoc(env, sid, app, path);
  if (!rule(sp, app, path, b.op === 'delete' ? 'delete' : 'set', old && old.data)) return fail('invalid_argument');
  const guarded = app === 'album' && !sp.owner && path.startsWith('albums/');
  if (guarded && b.op === 'delete' && !(await albumGuard(env, sp, path.split('/'), 'delete', old && old.data))) return fail('invalid_argument');
  if (b.op === 'delete') {
    if (old) await env.DB.batch([env.DB.prepare('DELETE FROM sdocs WHERE space = ? AND app = ? AND path = ?').bind(sid, app, path), bump(env, sid, app, parentOf(path))]);
    return json({ ok: true });
  }
  let data = b.data;
  if (!isObj(data)) return fail('invalid_argument');
  if (b.op === 'update') { if (!old) return fail('invalid_argument'); data = merge(old.data, data); }
  if (guarded) { data = await albumGuard(env, sp, path.split('/'), b.op, old && old.data, data); if (!data) return fail('invalid_argument'); }
  const s = path.split('/');
  if (app === 'album' && s[0] === 'comments') {
    const text = String(data.text || '').trim().slice(0, 1000);
    if (!text) return fail('invalid_argument');
    data = old ? { ...old.data, text } : { photo: String(data.photo || '').slice(0, 40), album: String(data.album || '').slice(0, 40), re: data.re ? String(data.re).slice(0, 40) : null, text, by: sp.uid, name: sp.name, at: Date.now() };
  }
  if (app === 'share' && s[0] === 'batches' && !old) data = { ...data, by: sp.uid, byName: sp.name };
  const body = JSON.stringify(data);
  if (enc.encode(body).length > MAX_DOC) return fail('invalid_argument');
  const updated = Math.max(Date.now(), old ? old.updated + 1 : 0);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO sdocs (space, app, path, parent, data, updated) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(space, app, path) DO UPDATE SET data = excluded.data, updated = excluded.updated').bind(sid, app, path, parentOf(path), body, updated),
    bump(env, sid, app, parentOf(path))
  ]);
  ctx.waitUntil(logChange(env, url.origin, sp, app, path, old && old.data, data).catch(e => console.error('log', e)));
  return json({ ok: true });
}
async function poll(env, sp, app, subs) {
  const sid = sp.space;
  subs = (Array.isArray(subs) ? subs : []).slice(0, 64).filter(x => x && okPath(x.path));
  const plan = subs.map(x => {
    const col = x.kind === 'col';
    const n = x.path.split('/').length;
    const ok = col ? n % 2 === 1 && rule(sp, app, x.path + '/x', 'read') : n % 2 === 0 && rule(sp, app, x.path, 'read');
    return { x, col, ok };
  });
  const stampQ = plan.filter(q => q.ok).map(q => q.col
    ? env.DB.prepare('SELECT ver AS s FROM scols WHERE space = ? AND app = ? AND parent = ?').bind(sid, app, q.x.path)
    : env.DB.prepare('SELECT updated AS s FROM sdocs WHERE space = ? AND app = ? AND path = ?').bind(sid, app, q.x.path));
  const stamps = stampQ.length ? await env.DB.batch(stampQ) : [];
  let i = 0;
  const out = [], fetchQ = [], fetchFor = [];
  for (const q of plan) {
    const stamp = q.ok ? String((stamps[i++].results[0] || {}).s || 0) : 'x';
    if (stamp === String(q.x.stamp)) continue;
    if (!q.ok || stamp === '0') { out.push(q.col ? { k: q.x.k, stamp, docs: [] } : { k: q.x.k, stamp, exists: false }); continue; }
    fetchFor.push({ q, stamp });
    fetchQ.push(q.col
      ? env.DB.prepare('SELECT path, data FROM sdocs WHERE space = ? AND app = ? AND parent = ?').bind(sid, app, q.x.path)
      : env.DB.prepare('SELECT path, data FROM sdocs WHERE space = ? AND app = ? AND path = ?').bind(sid, app, q.x.path));
  }
  const rows = fetchQ.length ? await env.DB.batch(fetchQ) : [];
  fetchFor.forEach(({ q, stamp }, j) => {
    const r = rows[j].results;
    if (q.col) out.push({ k: q.x.k, stamp, docs: r.map(d => ({ path: d.path, data: JSON.parse(d.data) })) });
    else out.push(r.length ? { k: q.x.k, stamp, exists: true, data: JSON.parse(r[0].data) } : { k: q.x.k, stamp, exists: false });
  });
  return json({ results: out });
}

/* ---------- files: Google Drive per family, old ones in KV ---------- */
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic', 'image/heif': 'heif', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'application/pdf': 'pdf' };
async function upload(req, env, me, url) {
  const app = url.searchParams.get('app') === 'share' ? 'share' : 'album';
  const sp = await spaceCtx(env, me, url.searchParams.get('space'));
  if (!can(sp, app, 'upload')) return fail('not_granted', 403);
  const type = (req.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!FILE_TYPES.test(type)) return fail('unsupported_type');
  const len = +(req.headers.get('content-length') || 0);
  const kvSpace = !sp.drive && sp.space === (await cfg(env, 'kv_space'));
  if (!sp.drive && !kvSpace) return fail('drive_needed', 409);
  if (len > (kvSpace ? MAX_KV_FILE : MAX_FILE)) return fail('too_large');
  const buf = await req.arrayBuffer();
  if (!buf.byteLength) return fail('invalid_request');
  if (buf.byteLength > (kvSpace ? MAX_KV_FILE : MAX_FILE)) return fail('too_large');
  const id = rnd(16);
  if (kvSpace) {
    const used = await env.DB.prepare("SELECT COALESCE(SUM(size), 0) AS bytes, COUNT(*) AS files FROM assets WHERE store = 'kv'").first();
    if (used.bytes + buf.byteLength > KV_QUOTA || used.files >= KV_FILES) return fail('quota_or_state');
    await env.PHOTOS.put('blob:' + id, buf, { metadata: { app, type } });
    await env.DB.prepare('INSERT INTO assets (id, app, type, size, by, created, space, store, ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(id, app, type, buf.byteLength, sp.uid, Date.now(), sp.space, 'kv', null).run();
  } else {
    let ref;
    try { ref = await driveUpload(env, sp.space, buf, type, `${app}-${id}.${EXT[type] || 'bin'}`); }
    catch (e) { console.error('drive upload', e && e.message); return fail(String(e && e.message).startsWith('drive_') ? e.message : 'drive_failed', 502); }
    await env.DB.prepare('INSERT INTO assets (id, app, type, size, by, created, space, store, ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(id, app, type, buf.byteLength, sp.uid, Date.now(), sp.space, 'drive', ref).run();
  }
  return json({ id, url: '/_blob/' + id, sizeBytes: buf.byteLength, contentType: type });
}
const BLOB_HEAD = type => ({ 'content-type': type, 'cache-control': 'private, max-age=31536000, immutable', 'content-security-policy': "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox", ...SEC });
async function blob(env, ctx, me, id) {
  if (!/^[a-f0-9]{32}$/.test(id)) return new Response('Not found', { status: 404 });
  const row = await env.DB.prepare('SELECT app, type, space, store, ref FROM assets WHERE id = ?').bind(id).first();
  if (!row) return new Response('Not found', { status: 404 });
  const sp = await spaceCtx(env, me, row.space);
  if (!can(sp, row.app, 'read')) return new Response('Forbidden', { status: 403 });
  if (row.store !== 'drive') {
    const { value } = await env.PHOTOS.getWithMetadata('blob:' + id, { type: 'stream' });
    if (!value) return new Response('Not found', { status: 404 });
    return new Response(value, { headers: BLOB_HEAD(row.type) });
  }
  const key = new Request('https://blob-cache.invalid/' + id);
  let hit = null;
  try { hit = await caches.default.match(key); } catch (e) {}
  if (hit) return new Response(hit.body, { headers: BLOB_HEAD(row.type) });
  let r;
  try { r = await driveFetch(env, row.space, `/drive/v3/files/${encodeURIComponent(row.ref)}?alt=media`); }
  catch (e) { return new Response('Drive unavailable', { status: 502 }); }
  if (!r.ok) return new Response('Not found', { status: r.status === 404 ? 404 : 502 });
  const [a, b] = r.body.tee();
  try { ctx.waitUntil(caches.default.put(key, new Response(b, { headers: { 'content-type': row.type, 'cache-control': 'public, max-age=604800' } })).catch(() => {})); } catch (e) {}
  return new Response(a, { headers: BLOB_HEAD(row.type) });
}
async function removeAsset(env, me, id) {
  if (!/^[a-f0-9]{32}$/.test(id)) return fail('invalid_request');
  const row = await env.DB.prepare('SELECT app, by, space, store, ref FROM assets WHERE id = ?').bind(id).first();
  if (!row) return json({ deleted: false });
  const sp = await spaceCtx(env, me, row.space);
  if (!sp || !(sp.owner || (row.by === sp.uid && can(sp, row.app, 'upload')))) return fail('not_uploader', 403);
  if (row.store === 'drive') { try { await driveFetch(env, row.space, `/drive/v3/files/${encodeURIComponent(row.ref)}`, { method: 'DELETE' }); } catch (e) {} }
  else await env.PHOTOS.delete('blob:' + id);
  await env.DB.prepare('DELETE FROM assets WHERE id = ?').bind(id).run();
  try { await caches.default.delete(new Request('https://blob-cache.invalid/' + id)); } catch (e) {}
  return json({ deleted: true });
}

/* ---------- Google Drive ---------- */
const G_AUTH = env => env.G_AUTH || 'https://accounts.google.com/o/oauth2/v2/auth';
const G_TOKEN = env => env.G_TOKEN || 'https://oauth2.googleapis.com/token';
const G_API = env => env.G_API || 'https://www.googleapis.com';
const b64 = u => { let s = ''; const a = new Uint8Array(u); for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s); };
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function aesKey(env) { return crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', enc.encode('seal:' + (env.PEPPER || 'pepper'))), 'AES-GCM', false, ['encrypt', 'decrypt']); }
async function seal(env, s) { const iv = crypto.getRandomValues(new Uint8Array(12)); return b64(iv) + '.' + b64(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(env), enc.encode(s))); }
async function unseal(env, t) { const [a, b] = String(t || '').split('.'); return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(a) }, await aesKey(env), unb64(b))); }
async function gClient(env) {
  const id = await cfg(env, 'g_client_id'), s = await cfg(env, 'g_client_secret');
  return id && s ? { id, secret: await unseal(env, s) } : null;
}
async function driveConnect(env, sp, url) {
  const c = await gClient(env);
  if (!c) return notice('Google Drive холбох боломжгүй байна', 'Сайтын Google тохиргоо хараахан хийгдээгүй байна. Түр хүлээгээд дахин оролдоорой.', 503);
  const state = rnd(16);
  await setCfg(env, 'oauth:' + state, JSON.stringify({ sid: sp.space, email: sp.email, exp: Date.now() + 15 * 60e3 }));
  const q = new URLSearchParams({ client_id: c.id, redirect_uri: url.origin + '/oauth/google/callback', response_type: 'code', scope: GSCOPE, access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state });
  return redirect(`${G_AUTH(env)}?${q}`);
}
async function driveCallback(env, me, url) {
  const state = (url.searchParams.get('state') || '').replace(/[^a-f0-9]/g, '');
  const raw = state ? await cfg(env, 'oauth:' + state) : null;
  if (state) await setCfg(env, 'oauth:' + state, null);
  let st = null; try { st = JSON.parse(raw); } catch (e) {}
  if (!st || st.exp < Date.now() || st.email !== me.email) return notice('Холбогдсонгүй', 'Хугацаа дууссан байна. Удирдлага хуудаснаас дахин оролдоорой.', 400);
  const back = `/s/${st.sid}/admin`;
  const sp = await spaceCtx(env, me, st.sid);
  if (!sp || !sp.owner) return noAccess(me);
  if (url.searchParams.get('error') || !url.searchParams.get('code')) return redirect(back + '?drive=denied');
  const c = await gClient(env);
  if (!c) return redirect(back + '?drive=failed');
  const tr = await fetch(G_TOKEN(env), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code: url.searchParams.get('code'), client_id: c.id, client_secret: c.secret, redirect_uri: url.origin + '/oauth/google/callback', grant_type: 'authorization_code' }) });
  const t = await tr.json().catch(() => ({}));
  if (!tr.ok || !t.refresh_token || !t.access_token) return redirect(back + '?drive=failed');
  if (!String(t.scope || '').includes('drive.file')) return redirect(back + '?drive=scope');
  let gmail = '';
  try { gmail = JSON.parse(new TextDecoder().decode(unb64(String(t.id_token || '').split('.')[1].replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(String(t.id_token).split('.')[1].length / 4) * 4, '=')))).email || ''; } catch (e) {}
  const fr = await fetch(`${G_API(env)}/drive/v3/files?fields=id`, { method: 'POST', headers: { authorization: 'Bearer ' + t.access_token, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Гэр бүлийн цомог — ' + sp.spaceName, mimeType: 'application/vnd.google-apps.folder' }) });
  const f = await fr.json().catch(() => ({}));
  if (!fr.ok || !f.id) return redirect(back + '?drive=failed');
  const drive = { r: await seal(env, t.refresh_token), email: gmail, folder: f.id, at: Date.now() };
  await env.DB.prepare('UPDATE spaces SET drive = ? WHERE id = ?').bind(JSON.stringify(drive), sp.space).run();
  tokens.set(sp.space, { t: t.access_token, exp: Date.now() + (Number(t.expires_in) || 3000) * 1000 - 120e3 });
  return redirect(back + '?drive=ok');
}
const tokens = new Map();
async function driveInfo(env, sid) {
  const row = await env.DB.prepare('SELECT drive FROM spaces WHERE id = ?').bind(sid).first();
  try { return row && row.drive ? JSON.parse(row.drive) : null; } catch (e) { return null; }
}
async function driveToken(env, sid) {
  const c0 = tokens.get(sid);
  if (c0 && c0.exp > Date.now()) return c0.t;
  const d = await driveInfo(env, sid);
  if (!d) throw new Error('drive_needed');
  const c = await gClient(env);
  if (!c) throw new Error('drive_failed');
  const r = await fetch(G_TOKEN(env), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: c.id, client_secret: c.secret, refresh_token: await unseal(env, d.r), grant_type: 'refresh_token' }) });
  const t = await r.json().catch(() => ({}));
  if (!r.ok || !t.access_token) {
    if (t.error === 'invalid_grant') { d.err = 'revoked'; await env.DB.prepare('UPDATE spaces SET drive = ? WHERE id = ?').bind(JSON.stringify(d), sid).run(); throw new Error('drive_revoked'); }
    throw new Error('drive_failed');
  }
  tokens.set(sid, { t: t.access_token, exp: Date.now() + (Number(t.expires_in) || 3000) * 1000 - 120e3 });
  return t.access_token;
}
async function driveFetch(env, sid, path, init = {}) {
  const go = async () => fetch(G_API(env) + path, { ...init, headers: { ...(init.headers || {}), authorization: 'Bearer ' + await driveToken(env, sid) } });
  let r = await go();
  if (r.status === 401) { tokens.delete(sid); r = await go(); }
  return r;
}
async function driveUpload(env, sid, buf, type, name) {
  const d = await driveInfo(env, sid);
  if (!d) throw new Error('drive_needed');
  const init = await driveFetch(env, sid, '/upload/drive/v3/files?uploadType=resumable&fields=id', { method: 'POST', headers: { 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-type': type, 'x-upload-content-length': String(buf.byteLength) }, body: JSON.stringify({ name, parents: [d.folder] }) });
  if (init.status === 404) throw new Error('drive_folder');
  if (init.status === 403) { const e = await init.json().catch(() => ({})); throw new Error(JSON.stringify(e).includes('storageQuotaExceeded') ? 'drive_full' : 'drive_failed'); }
  const loc = init.headers.get('location');
  if (!init.ok || !loc) throw new Error('drive_failed');
  const put = await fetch(loc, { method: 'PUT', headers: { 'content-type': type, 'content-length': String(buf.byteLength) }, body: buf });
  const j = await put.json().catch(() => ({}));
  if (put.status === 403) throw new Error(JSON.stringify(j).includes('storageQuotaExceeded') ? 'drive_full' : 'drive_failed');
  if (!put.ok || !j.id) throw new Error('drive_failed');
  return j.id;
}

/* ---------- Gmail / Google Sheets through Apps Script (site owner's) ---------- */
async function callScript(env, body) {
  const url = await cfg(env, 'script_url');
  if (!url) return { ok: false, error: 'not_configured' };
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'text/plain; charset=utf-8' }, body: JSON.stringify({ ...body, token: await cfg(env, 'script_token') }), redirect: 'follow' });
    const t = await r.text();
    try { return JSON.parse(t); } catch (e) { return { ok: false, error: 'bad_response', status: r.status }; }
  } catch (e) { return { ok: false, error: 'unreachable' }; }
}
const stamp = ms => new Date(ms).toLocaleString('sv-SE', { timeZone: 'Asia/Ulaanbaatar' }).slice(0, 16);
async function logChange(env, origin, sp, app, path, old, data) {
  if (sp.space !== (await cfg(env, 'log_space')) || !(await cfg(env, 'script_url'))) return;
  const base = `${origin}/s/${sp.space}`;
  const s = path.split('/'), when = stamp(Date.now());
  const log = (sheet, row) => callScript(env, { action: 'log', sheet, row });
  if (app === 'share') {
    if (s[0] === 'batches' && s.length === 2 && !old) {
      const files = Array.isArray(data.files) ? data.files : [];
      const mb = files.reduce((t, f) => t + (+f.size || 0), 0) / 1048576;
      await log('Илгээмж', [when, data.byName || sp.name, data.note || '', files.length, Math.round(mb * 10) / 10, base + '/share/']);
    }
    return;
  }
  const priv = s[0] === 'data';
  const albumId = priv ? s[3] : s[1];
  if (((!priv && s[0] === 'albums' && s.length === 2) || (priv && s.length === 4 && data.kind === 'album')) && !old) {
    await log('Цомог', [when, data.title || '', priv ? 'Зөвхөн би' : 'Гэр бүл', base + '/#a-' + albumId]);
    return;
  }
  if (s[s.length - 2] === 'pages') {
    const before = new Set(((old && old.items) || []).filter(i => i && i.t === 'p').map(i => i.asset));
    const added = ((data && data.items) || []).filter(i => i && i.t === 'p' && !before.has(i.asset));
    if (!added.length) return;
    const alb = await getDoc(env, sp.space, 'album', s.slice(0, -2).join('/'));
    const title = ((alb && alb.data.title) || '') + (priv ? ' (зөвхөн би)' : '');
    for (const it of added) await log('Зураг', [when, title, String(it.cap || ''), String(it.taken || ''), origin + '/_blob/' + it.asset, base + '/#a-' + albumId]);
    return;
  }
  if (s[0] === 'comments' && s.length === 2 && !old) {
    const a = data.album ? (await getDoc(env, sp.space, 'album', 'albums/' + data.album)) : null;
    await log('Сэтгэгдэл', [when, data.name, data.text, (a && a.data.title) || '', base + '/#a-' + (data.album || '')]);
  }
}

/* ---------- family settings (family owner) and site settings (site owner) ---------- */
async function adminApi(req, env, url, what, me) {
  const b = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
  const sp = await spaceCtx(env, me, url.searchParams.get('space') || b.space);
  const site = SITE_OPS.includes(what);
  if (site ? !me.platform : !(sp && sp.owner)) return fail('forbidden', 403);
  if (what === 'state' && req.method === 'GET') {
    const sid = sp.space;
    const { results: users } = await env.DB.prepare("SELECT email, name, roles, added FROM members WHERE space = ? AND roles NOT LIKE '%owner%' ORDER BY added").bind(sid).all();
    const usage = await env.DB.prepare("SELECT COALESCE(SUM(size), 0) AS bytes, COUNT(*) AS files, COALESCE(SUM(CASE WHEN app = 'album' THEN size END), 0) AS album, COALESCE(SUM(CASE WHEN app = 'share' THEN size END), 0) AS share FROM assets WHERE space = ?").bind(sid).first();
    const d = await driveInfo(env, sid);
    const kv = sid === (await cfg(env, 'kv_space'));
    const out = { owner: { email: me.email, name: sp.name }, space: { id: sid, name: sp.spaceName }, users, usage: { ...usage, kv, quota: kv && !d ? KV_QUOTA : 0 }, drive: d ? { connected: true, email: d.email || '', err: d.err || '' } : { connected: false, ready: !!(await cfg(env, 'g_client_id')) }, site: null };
    if (me.platform) {
      let token = await cfg(env, 'script_token');
      if (!token) { token = rnd(12); await setCfg(env, 'script_token', token); }
      const st = await env.DB.prepare('SELECT (SELECT COUNT(*) FROM spaces) AS spaces, (SELECT COUNT(*) FROM accounts) AS accounts').first();
      out.site = { script: { url: await cfg(env, 'script_url'), token, sheet: await cfg(env, 'sheet_url') }, google: { clientId: (await cfg(env, 'g_client_id')) || '', hasSecret: !!(await cfg(env, 'g_client_secret')), redirect: url.origin + '/oauth/google/callback', origin: url.origin }, stats: st, mailToday: +(await cfg(env, 'mail:' + today())) || 0, mailLimit: MAIL_PER_DAY, logHere: sid === (await cfg(env, 'log_space')) };
    }
    return json(out);
  }
  if (req.method !== 'POST') return fail('method', 405);
  if (what === 'user') {
    const email = cleanEmail(b.email);
    if (!EMAIL.test(email)) return fail('bad_email');
    if (email === me.email) return fail('is_owner');
    const roles = (Array.isArray(b.roles) ? b.roles : []).filter(r => r === 'family' || r === 'coworker');
    if (!roles.length) return fail('no_roles');
    const name = cleanName(b.name) || email.split('@')[0];
    const cnt = await env.DB.prepare('SELECT COUNT(*) AS n FROM members WHERE space = ?').bind(sp.space).first();
    if (cnt.n >= 60) return fail('too_many');
    await env.DB.prepare("INSERT INTO members (space, email, name, roles, added) VALUES (?, ?, ?, ?, ?) ON CONFLICT(space, email) DO UPDATE SET name = excluded.name, roles = CASE WHEN members.roles LIKE '%owner%' THEN members.roles ELSE excluded.roles END").bind(sp.space, email, name, roles.join(','), Date.now()).run();
    return json({ ok: true });
  }
  if (what === 'user-delete') {
    const email = cleanEmail(b.email);
    if (email === me.email) return fail('is_owner');
    await env.DB.prepare("DELETE FROM members WHERE space = ? AND email = ? AND roles NOT LIKE '%owner%'").bind(sp.space, email).run();
    return json({ ok: true });
  }
  if (what === 'invite') {
    const email = cleanEmail(b.email);
    const m = await env.DB.prepare('SELECT 1 FROM members WHERE space = ? AND email = ?').bind(sp.space, email).first();
    if (!m) return fail('no_user');
    const t = rnd(20);
    await env.DB.prepare('INSERT INTO invites (email, hash, expires) VALUES (?, ?, ?) ON CONFLICT(email) DO UPDATE SET hash = excluded.hash, expires = excluded.expires').bind(email, await sha('inv:' + t), Date.now() + 14 * DAY).run();
    return json({ ok: true, url: `${url.origin}/login/link?t=${t}`, days: 14 });
  }
  if (what === 'owner-name') {
    const name = cleanName(b.name);
    if (!name) return fail('bad_name');
    await env.DB.batch([env.DB.prepare('UPDATE members SET name = ? WHERE space = ? AND email = ?').bind(name, sp.space, me.email), env.DB.prepare('UPDATE accounts SET name = ? WHERE email = ?').bind(name, me.email)]);
    return json({ ok: true });
  }
  if (what === 'space-name') {
    const name = cleanName(b.name, 60);
    if (!name) return fail('bad_name');
    await env.DB.prepare('UPDATE spaces SET name = ? WHERE id = ?').bind(name, sp.space).run();
    return json({ ok: true });
  }
  if (what === 'drive-disconnect') {
    const d = await driveInfo(env, sp.space);
    if (d) {
      try { await fetch(`${G_TOKEN(env).replace(/\/token$/, '/revoke')}?token=${encodeURIComponent(await unseal(env, d.r))}`, { method: 'POST' }); } catch (e) {}
      await env.DB.prepare('UPDATE spaces SET drive = NULL WHERE id = ?').bind(sp.space).run();
      tokens.delete(sp.space);
    }
    return json({ ok: true });
  }
  if (what === 'script') {
    const u = String(b.url || '').trim();
    if (u && !/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(u)) return fail('bad_url');
    await setCfg(env, 'script_url', u || null);
    if (!u) return json({ ok: true });
    const r = await callScript(env, { action: 'ping' });
    if (r.ok && r.sheet) await setCfg(env, 'sheet_url', r.sheet);
    return json({ ok: !!r.ok, test: r });
  }
  if (what === 'test') {
    const r = await callScript(env, { action: 'ping' });
    if (r.ok && r.sheet) await setCfg(env, 'sheet_url', r.sheet);
    return json({ ok: !!r.ok, test: r });
  }
  if (what === 'token') { const t = rnd(12); await setCfg(env, 'script_token', t); return json({ ok: true, token: t }); }
  if (what === 'google') {
    const id = String(b.clientId || '').trim(), secret = String(b.clientSecret || '').trim();
    if (!/^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(id)) return fail('bad_client_id');
    if (secret && !/^[A-Za-z0-9_-]{10,100}$/.test(secret)) return fail('bad_secret');
    if (!secret && !(await cfg(env, 'g_client_secret'))) return fail('bad_secret');
    await setCfg(env, 'g_client_id', id);
    if (secret) await setCfg(env, 'g_client_secret', await seal(env, secret));
    return json({ ok: true });
  }
  return fail('unknown', 404);
}
const SITE_OPS = ['script', 'test', 'token', 'google'];
