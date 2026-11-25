// Гэр бүлийн цомог — Cloudflare Worker
// Хуудсууд (public/*.html, shim.js) GitHub-аас татагдана; өгөгдөл D1-д, зураг KV-д,
// бүртгэл Google Sheets-д (Apps Script-ээр) бичигдэнэ.

const APPS = {
  album: { read: ['family'], comment: ['family'], upload: ['family'], add: ['family'] },
  share: { read: ['coworker'], comment: [], upload: ['coworker'] }
};
const PAGES = { 'album.html': 'text/html', 'share.html': 'text/html', 'login.html': 'text/html', 'admin.html': 'text/html', 'shim.js': 'text/javascript' };
const MAX_DOC = 256 * 1024;
const MAX_FILE = 20 * 1024 * 1024;
const QUOTA_BYTES = 1000 * 1024 * 1024;
const QUOTA_FILES = 5000;
const FILE_TYPES = /^(image\/(jpeg|png|webp|gif)|video\/(mp4|webm)|application\/pdf)$/;
const SEG = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
const DAY = 86400e3;

const enc = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha = async s => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const rnd = (n = 32) => hex(crypto.getRandomValues(new Uint8Array(n)));
const json = (o, status = 200, headers = {}) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
const fail = (code, status = 400) => json({ error: code }, status);
const redirect = (to, headers = {}) => new Response(null, { status: 302, headers: { location: to, ...headers } });
const SEC = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'x-frame-options': 'DENY' };

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      if (p === '/login') return page(env, ctx, 'login.html');
      if (p === '/shim.js') return page(env, ctx, 'shim.js');
      if (p === '/login/setup') return setupLogin(env, url);
      if (p === '/login/link') return linkPage(url);
      if (p === '/api/login/link') return linkLogin(req, env);
      if (p === '/api/login/start' || p === '/api/login/verify') return loginApi(req, env, url, p);

      const me = await session(req, env);
      if (p === '/api/logout') return logout(req, env);
      if (!me) {
        if (p.startsWith('/api/') || p.startsWith('/_blob/')) return fail('signed_out', 401);
        return redirect('/login?next=' + encodeURIComponent(p + url.search));
      }
      if (p === '/api/me') return json(meInfo(me));
      if (p === '/' || p === '/index.html') {
        if (can(me, 'album', 'read')) return page(env, ctx, 'album.html');
        return can(me, 'share', 'read') ? redirect('/share/') : noAccess(me);
      }
      if (p === '/share') return redirect('/share/');
      if (p === '/share/') return can(me, 'share', 'read') ? page(env, ctx, 'share.html') : noAccess(me);
      if (p === '/admin') return me.owner ? page(env, ctx, 'admin.html') : noAccess(me);
      if (p.startsWith('/_blob/')) return blob(env, me, p.slice(7));
      if (p === '/api/db' && req.method === 'POST') return dbApi(req, env, ctx, me, url);
      if (p === '/api/assets' && req.method === 'POST') return upload(req, env, me, url);
      if (p.startsWith('/api/assets/') && req.method === 'DELETE') return removeAsset(env, me, p.slice(12));
      if (p.startsWith('/api/admin/')) return me.owner ? adminApi(req, env, url, p.slice(11), me) : fail('forbidden', 403);
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
function noAccess(me) {
  const html = `<!DOCTYPE html><html lang="mn"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Хандах эрх алга</title><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#18171c;color:#f2ece0;font:16px/1.5 system-ui,sans-serif;text-align:center;padding:20px"><div><h1 style="font-size:28px">Энэ хэсгийг харах эрх алга</h1><p>${esc(me.email)} хаягаар нэвтэрсэн байна.</p><p><a style="color:#ff7a66" href="/share/">Зураг дамжуулах</a> · <a style="color:#ff7a66" href="/login" onclick="fetch('/api/logout',{method:'POST'}).then(()=>location.href='/login');return false">Өөр хаягаар нэвтрэх</a></p></div></body></html>`;
  return new Response(html, { status: 403, headers: { 'content-type': 'text/html; charset=utf-8', ...SEC } });
}
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- people & sessions ---------- */
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
const ownerEmail = env => String(env.OWNER_EMAIL || '').trim().toLowerCase();
async function who(env, email) {
  email = String(email || '').toLowerCase();
  if (!email) return null;
  const owner = email === ownerEmail(env);
  const u = await env.DB.prepare('SELECT email, name, roles FROM users WHERE email = ?').bind(email).first();
  const roles = owner ? ['owner', 'family', 'coworker'] : String((u && u.roles) || '').split(',').filter(r => r === 'family' || r === 'coworker');
  if (!roles.length) return null;
  return { email, owner, roles, name: (u && u.name) || (owner ? (await cfg(env, 'owner_name')) || email.split('@')[0] : email.split('@')[0]), uid: 'u' + (await sha('uid:' + email)).slice(0, 20) };
}
const can = (me, app, what) => me.owner || (APPS[app][what] || []).some(r => me.roles.includes(r));
function meInfo(me) {
  const c = app => ({ read: can(me, app, 'read'), comment: can(me, app, 'comment'), upload: can(me, app, 'upload'), add: can(me, app, 'add'), edit: me.owner });
  return { email: me.email, name: me.name, uid: me.uid, owner: me.owner, roles: me.roles, can: { album: c('album'), share: c('share') } };
}
async function session(req, env) {
  const m = (req.headers.get('cookie') || '').match(/(?:^|;\s*)sid=([a-f0-9]{64})/);
  if (!m) return null;
  const row = await env.DB.prepare('SELECT email, expires FROM sessions WHERE token = ?').bind(await sha(m[1])).first();
  if (!row || row.expires < Date.now()) return null;
  return who(env, row.email);
}
async function startSession(env, email, extra = {}) {
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
  if (!row || row.expires < Date.now() || !(await who(env, row.email))) return fail('expired');
  return json({ ok: true }, 200, { 'set-cookie': await startSession(env, row.email) });
}
async function loginApi(req, env, url, p) {
  if (req.method !== 'POST') return fail('method', 405);
  const b = await req.json().catch(() => ({}));
  const email = String(b.email || '').trim().toLowerCase().slice(0, 200);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('bad_email');
  const pepper = env.PEPPER || 'pepper';
  if (p === '/api/login/start') {
    if (!(await cfg(env, 'script_url'))) return fail('mail_not_ready', 503);
    const person = await who(env, email);
    if (!person) return json({ ok: true });
    const prev = await env.DB.prepare('SELECT sent FROM codes WHERE email = ?').bind(email).first();
    if (prev && Date.now() - prev.sent < 45e3) return fail('wait', 429);
    const code = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
    await env.DB.prepare('INSERT INTO codes (email, hash, expires, tries, sent) VALUES (?, ?, ?, 0, ?) ON CONFLICT(email) DO UPDATE SET hash = excluded.hash, expires = excluded.expires, tries = 0, sent = excluded.sent')
      .bind(email, await sha(pepper + email + code), Date.now() + 10 * 60e3, Date.now()).run();
    const html = `<div style="font-family:Arial,sans-serif;font-size:16px;color:#222"><p>Сайн байна уу, ${esc(person.name)}!</p><p>«Гэр бүлийн цомог»-д нэвтрэх код:</p><p style="font-size:32px;font-weight:bold;letter-spacing:6px">${code}</p><p>Код 10 минутын дотор хүчинтэй. Та өөрөө хүсээгүй бол энэ захидлыг үл тоомсорлоорой.</p><p><a href="${url.origin}/login">${url.origin}</a></p></div>`;
    const r = await callScript(env, { action: 'mail', to: email, subject: `Нэвтрэх код: ${code}`, html });
    if (!r.ok) return fail('mail_failed', 502);
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
  if (!(await who(env, email))) return fail('expired');
  return json({ ok: true }, 200, { 'set-cookie': await startSession(env, email) });
}

/* ---------- document store ---------- */
const parentOf = path => path.split('/').slice(0, -1).join('/');
function okPath(path) { const s = String(path || '').split('/'); return s.length > 0 && s.length <= 16 && path.length <= 1000 && s.every(x => SEG.test(x) && x !== '.' && x !== '..'); }
function rule(me, app, path, op, old) {
  const s = path.split('/');
  if (!can(me, app, 'read')) return false;
  if (s[0] === 'data' && s[1] === 'users') return s[2] === me.uid && (op === 'read' || me.owner || can(me, app, 'add'));
  if (op === 'read' || me.owner) return true;
  if (app === 'album' && s[0] === 'albums' && can(me, 'album', 'add')) return true;
  if (app === 'album' && s[0] === 'comments' && s.length === 2 && can(me, 'album', 'comment')) return op === 'set' && !old ? true : !!old && old.by === me.uid;
  if (app === 'share' && s[0] === 'batches' && s.length === 2 && can(me, 'share', 'upload')) return op === 'set' && !old ? true : !!old && old.by === me.uid;
  return false;
}
async function getDoc(env, app, path) {
  const row = await env.DB.prepare('SELECT data, updated FROM docs WHERE app = ? AND path = ?').bind(app, path).first();
  return row ? { data: JSON.parse(row.data), updated: row.updated } : null;
}
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
function merge(a, b) { const o = { ...a }; for (const [k, v] of Object.entries(b)) o[k] = isObj(v) && isObj(o[k]) ? merge(o[k], v) : v; return o; }
const bump = (env, app, parent) => env.DB.prepare('INSERT INTO cols (app, parent, ver) VALUES (?, ?, 1) ON CONFLICT(app, parent) DO UPDATE SET ver = ver + 1').bind(app, parent);

async function albumGuard(env, me, s, op, old, data) {
  const mine = x => !!x && x.by === me.uid;
  if (s.length === 2) {
    if (op === 'delete') return mine(old);
    if (!old || mine(old)) return { ...data, by: me.uid, byName: (old && old.byName) || me.name };
    if (!old.collab) return null;
    const o = { ...old };
    for (const k of ['np', 'nph', 'cover']) if (k in data) o[k] = data[k];
    return o;
  }
  if (s.length === 4 && s[2] === 'pages') {
    const alb = await getDoc(env, 'album', 'albums/' + s[1]);
    if (!alb) return null;
    if (mine(alb.data)) return op === 'delete' ? true : data;
    if (!alb.data.collab) return null;
    const its = x => Array.isArray(x && x.items) ? x.items.filter(isObj) : [];
    if (op === 'delete') return !!old && mine(old) && its(old).every(mine);
    if (!old) return { n: Number(data.n) || 0, bg: String(data.bg || ''), items: its(data).filter(mine), by: me.uid };
    const others = its(old).filter(i => !mine(i)), ids = new Set(others.map(i => i.id));
    return { ...old, items: [...others, ...its(data).filter(i => mine(i) && !ids.has(i.id))] };
  }
  return null;
}
async function dbApi(req, env, ctx, me, url) {
  const b = await req.json().catch(() => null);
  if (!b) return fail('invalid_argument');
  const app = b.app === 'share' ? 'share' : 'album';
  if (b.op === 'poll') return poll(env, me, app, b.subs);
  const path = String(b.path || '');
  if (!okPath(path)) return fail('invalid_argument');
  const n = path.split('/').length;
  if (b.op === 'list') {
    if (n % 2 === 0) return fail('invalid_argument');
    if (!rule(me, app, path + '/x', 'read')) return json({ docs: [] });
    const { results } = await env.DB.prepare('SELECT path, data FROM docs WHERE app = ? AND parent = ?').bind(app, path).all();
    return json({ docs: results.map(r => ({ path: r.path, data: JSON.parse(r.data) })) });
  }
  if (n % 2 !== 0) return fail('invalid_argument');
  if (b.op === 'get') {
    if (!rule(me, app, path, 'read')) return json({ exists: false });
    const d = await getDoc(env, app, path);
    return json(d ? { exists: true, data: d.data } : { exists: false });
  }
  if (!['set', 'update', 'delete'].includes(b.op)) return fail('invalid_argument');
  const old = await getDoc(env, app, path);
  if (!rule(me, app, path, b.op === 'delete' ? 'delete' : 'set', old && old.data)) return fail('invalid_argument');
  const guarded = app === 'album' && !me.owner && path.startsWith('albums/');
  if (guarded && b.op === 'delete' && !(await albumGuard(env, me, path.split('/'), 'delete', old && old.data))) return fail('invalid_argument');
  if (b.op === 'delete') {
    if (old) await env.DB.batch([env.DB.prepare('DELETE FROM docs WHERE app = ? AND path = ?').bind(app, path), bump(env, app, parentOf(path))]);
    return json({ ok: true });
  }
  let data = b.data;
  if (!isObj(data)) return fail('invalid_argument');
  if (b.op === 'update') { if (!old) return fail('invalid_argument'); data = merge(old.data, data); }
  if (guarded) { data = await albumGuard(env, me, path.split('/'), b.op, old && old.data, data); if (!data) return fail('invalid_argument'); }
  const s = path.split('/');
  if (app === 'album' && s[0] === 'comments') {
    const text = String(data.text || '').trim().slice(0, 1000);
    if (!text) return fail('invalid_argument');
    data = old ? { ...old.data, text } : { photo: String(data.photo || '').slice(0, 40), album: String(data.album || '').slice(0, 40), re: data.re ? String(data.re).slice(0, 40) : null, text, by: me.uid, name: me.name, at: Date.now() };
  }
  if (app === 'share' && s[0] === 'batches' && !old) data = { ...data, by: me.uid, byName: me.name };
  const body = JSON.stringify(data);
  if (enc.encode(body).length > MAX_DOC) return fail('invalid_argument');
  const updated = Math.max(Date.now(), old ? old.updated + 1 : 0);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO docs (app, path, parent, data, updated) VALUES (?, ?, ?, ?, ?) ON CONFLICT(app, path) DO UPDATE SET data = excluded.data, updated = excluded.updated').bind(app, path, parentOf(path), body, updated),
    bump(env, app, parentOf(path))
  ]);
  ctx.waitUntil(logChange(env, url.origin, app, path, old && old.data, data, me).catch(e => console.error('log', e)));
  return json({ ok: true });
}
async function poll(env, me, app, subs) {
  subs = (Array.isArray(subs) ? subs : []).slice(0, 64).filter(x => x && okPath(x.path));
  const plan = subs.map(x => {
    const col = x.kind === 'col';
    const n = x.path.split('/').length;
    const ok = col ? n % 2 === 1 && rule(me, app, x.path + '/x', 'read') : n % 2 === 0 && rule(me, app, x.path, 'read');
    return { x, col, ok };
  });
  const stampQ = plan.filter(q => q.ok).map(q => q.col
    ? env.DB.prepare('SELECT ver AS s FROM cols WHERE app = ? AND parent = ?').bind(app, q.x.path)
    : env.DB.prepare('SELECT updated AS s FROM docs WHERE app = ? AND path = ?').bind(app, q.x.path));
  const stamps = stampQ.length ? await env.DB.batch(stampQ) : [];
  let i = 0;
  const out = [], fetchQ = [], fetchFor = [];
  for (const q of plan) {
    const stamp = q.ok ? String((stamps[i++].results[0] || {}).s || 0) : 'x';
    if (stamp === String(q.x.stamp)) continue;
    if (!q.ok || stamp === '0') { out.push(q.col ? { k: q.x.k, stamp, docs: [] } : { k: q.x.k, stamp, exists: false }); continue; }
    fetchFor.push({ q, stamp });
    fetchQ.push(q.col
      ? env.DB.prepare('SELECT path, data FROM docs WHERE app = ? AND parent = ?').bind(app, q.x.path)
      : env.DB.prepare('SELECT path, data FROM docs WHERE app = ? AND path = ?').bind(app, q.x.path));
  }
  const rows = fetchQ.length ? await env.DB.batch(fetchQ) : [];
  fetchFor.forEach(({ q, stamp }, j) => {
    const r = rows[j].results;
    if (q.col) out.push({ k: q.x.k, stamp, docs: r.map(d => ({ path: d.path, data: JSON.parse(d.data) })) });
    else out.push(r.length ? { k: q.x.k, stamp, exists: true, data: JSON.parse(r[0].data) } : { k: q.x.k, stamp, exists: false });
  });
  return json({ results: out });
}

/* ---------- files ---------- */
async function upload(req, env, me, url) {
  const app = url.searchParams.get('app') === 'share' ? 'share' : 'album';
  if (!can(me, app, 'upload')) return fail('not_granted', 403);
  const type = (req.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!FILE_TYPES.test(type)) return fail('unsupported_type');
  if (+(req.headers.get('content-length') || 0) > MAX_FILE) return fail('too_large');
  const buf = await req.arrayBuffer();
  if (!buf.byteLength) return fail('invalid_request');
  if (buf.byteLength > MAX_FILE) return fail('too_large');
  const used = await env.DB.prepare('SELECT COALESCE(SUM(size), 0) AS bytes, COUNT(*) AS files FROM assets').first();
  if (used.bytes + buf.byteLength > QUOTA_BYTES || used.files >= QUOTA_FILES) return fail('quota_or_state');
  const id = rnd(16);
  await env.PHOTOS.put('blob:' + id, buf, { metadata: { app, type } });
  await env.DB.prepare('INSERT INTO assets (id, app, type, size, by, created) VALUES (?, ?, ?, ?, ?, ?)').bind(id, app, type, buf.byteLength, me.uid, Date.now()).run();
  return json({ id, url: '/_blob/' + id, sizeBytes: buf.byteLength, contentType: type });
}
async function blob(env, me, id) {
  if (!/^[a-f0-9]{32}$/.test(id)) return new Response('Not found', { status: 404 });
  const { value, metadata } = await env.PHOTOS.getWithMetadata('blob:' + id, { type: 'stream' });
  if (!value || !metadata) return new Response('Not found', { status: 404 });
  if (!can(me, metadata.app, 'read')) return new Response('Forbidden', { status: 403 });
  return new Response(value, { headers: { 'content-type': metadata.type, 'cache-control': 'private, max-age=31536000, immutable', 'content-security-policy': "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox", ...SEC } });
}
async function removeAsset(env, me, id) {
  if (!/^[a-f0-9]{32}$/.test(id)) return fail('invalid_request');
  const row = await env.DB.prepare('SELECT app, by FROM assets WHERE id = ?').bind(id).first();
  if (!row) return json({ deleted: false });
  if (!me.owner && !(row.by === me.uid && can(me, row.app, 'upload'))) return fail('not_uploader', 403);
  await env.PHOTOS.delete('blob:' + id);
  await env.DB.prepare('DELETE FROM assets WHERE id = ?').bind(id).run();
  return json({ deleted: true });
}

/* ---------- Google Sheets / Gmail through Apps Script ---------- */
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
async function logChange(env, origin, app, path, old, data, me) {
  if (!(await cfg(env, 'script_url'))) return;
  const s = path.split('/'), when = stamp(Date.now());
  const log = (sheet, row) => callScript(env, { action: 'log', sheet, row });
  if (app === 'share') {
    if (s[0] === 'batches' && s.length === 2 && !old) {
      const files = Array.isArray(data.files) ? data.files : [];
      const mb = files.reduce((t, f) => t + (+f.size || 0), 0) / 1048576;
      await log('Илгээмж', [when, data.byName || me.name, data.note || '', files.length, Math.round(mb * 10) / 10, origin + '/share/']);
    }
    return;
  }
  const priv = s[0] === 'data';
  const albumId = priv ? s[3] : s[1];
  if (((!priv && s[0] === 'albums' && s.length === 2) || (priv && s.length === 4 && data.kind === 'album')) && !old) {
    await log('Цомог', [when, data.title || '', priv ? 'Зөвхөн би' : 'Гэр бүл', origin + '/#a-' + albumId]);
    return;
  }
  if (s[s.length - 2] === 'pages') {
    const before = new Set(((old && old.items) || []).filter(i => i && i.t === 'p').map(i => i.asset));
    const added = ((data && data.items) || []).filter(i => i && i.t === 'p' && !before.has(i.asset));
    if (!added.length) return;
    const alb = await getDoc(env, 'album', s.slice(0, -2).join('/'));
    const title = ((alb && alb.data.title) || '') + (priv ? ' (зөвхөн би)' : '');
    for (const it of added) await log('Зураг', [when, title, String(it.cap || ''), String(it.taken || ''), origin + '/_blob/' + it.asset, origin + '/#a-' + albumId]);
    return;
  }
  if (s[0] === 'comments' && s.length === 2 && !old) {
    const a = data.album ? (await getDoc(env, 'album', 'albums/' + data.album)) : null;
    await log('Сэтгэгдэл', [when, data.name, data.text, (a && a.data.title) || '', origin + '/#a-' + (data.album || '')]);
  }
}

/* ---------- owner settings ---------- */
async function adminApi(req, env, url, what, me) {
  if (what === 'state' && req.method === 'GET') {
    const { results: users } = await env.DB.prepare('SELECT email, name, roles, added FROM users ORDER BY added').all();
    const usage = await env.DB.prepare("SELECT COALESCE(SUM(size), 0) AS bytes, COUNT(*) AS files, COALESCE(SUM(CASE WHEN app = 'album' THEN size END), 0) AS album, COALESCE(SUM(CASE WHEN app = 'share' THEN size END), 0) AS share FROM assets").first();
    const docs = await env.DB.prepare('SELECT COUNT(*) AS n FROM docs').first();
    let token = await cfg(env, 'script_token');
    if (!token) { token = rnd(12); await setCfg(env, 'script_token', token); }
    return json({ owner: { email: me.email, name: me.name }, users, usage: { ...usage, quota: QUOTA_BYTES, quotaFiles: QUOTA_FILES }, docs: docs.n, script: { url: await cfg(env, 'script_url'), token, sheet: await cfg(env, 'sheet_url') } });
  }
  if (req.method !== 'POST') return fail('method', 405);
  const b = await req.json().catch(() => ({}));
  if (what === 'user') {
    const email = String(b.email || '').trim().toLowerCase().slice(0, 200);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('bad_email');
    if (email === ownerEmail(env)) return fail('is_owner');
    const roles = (Array.isArray(b.roles) ? b.roles : []).filter(r => r === 'family' || r === 'coworker');
    if (!roles.length) return fail('no_roles');
    const name = String(b.name || '').trim().slice(0, 40) || email.split('@')[0];
    await env.DB.prepare('INSERT INTO users (email, name, roles, added) VALUES (?, ?, ?, ?) ON CONFLICT(email) DO UPDATE SET name = excluded.name, roles = excluded.roles').bind(email, name, roles.join(','), Date.now()).run();
    return json({ ok: true });
  }
  if (what === 'user-delete') {
    const email = String(b.email || '').trim().toLowerCase();
    await env.DB.batch([env.DB.prepare('DELETE FROM users WHERE email = ?').bind(email), env.DB.prepare('DELETE FROM sessions WHERE email = ?').bind(email), env.DB.prepare('DELETE FROM codes WHERE email = ?').bind(email), env.DB.prepare('DELETE FROM invites WHERE email = ?').bind(email)]);
    return json({ ok: true });
  }
  if (what === 'invite') {
    const email = String(b.email || '').trim().toLowerCase().slice(0, 200);
    if (!(await who(env, email))) return fail('no_user');
    const t = rnd(20);
    await env.DB.prepare('INSERT INTO invites (email, hash, expires) VALUES (?, ?, ?) ON CONFLICT(email) DO UPDATE SET hash = excluded.hash, expires = excluded.expires').bind(email, await sha('inv:' + t), Date.now() + 14 * DAY).run();
    return json({ ok: true, url: `${url.origin}/login/link?t=${t}`, days: 14 });
  }
  if (what === 'owner-name') { await setCfg(env, 'owner_name', String(b.name || '').trim().slice(0, 40) || null); return json({ ok: true }); }
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
  return fail('unknown', 404);
}
