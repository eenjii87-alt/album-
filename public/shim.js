/* Гэр бүлийн цомог — Cloudflare дээрх хуудсуудад window.claude-ийн оронд ажиллана.
   db (D1), assets (KV), user, downloads, comments-ийг сайтын API-тай холбоно. */
(() => {
  const APP = location.pathname.startsWith('/share') ? 'share' : 'album';
  const POLL = 6000;
  const SEG = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rid = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), b => (b % 36).toString(36)).join('');
  const clone = o => o == null ? o : JSON.parse(JSON.stringify(o));
  const goLogin = () => { location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search + location.hash); };
  function segs(path, parity, kind) {
    const s = String(path).split('/');
    if (s.some(x => !SEG.test(x) || x === '.' || x === '..')) throw new TypeError(`Invalid ${kind} path: ${path}`);
    if (s.length % 2 !== parity) throw new TypeError(`A ${kind} path needs an ${parity ? 'odd' : 'even'} number of segments: ${path}`);
    return s;
  }
  async function api(body) {
    let r;
    try { r = await fetch('/api/db', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ app: APP, ...body }), credentials: 'same-origin' }); }
    catch (e) { throw { code: 'unavailable', message: 'network' }; }
    if (r.status === 401) { goLogin(); throw { code: 'revoked', message: 'signed out' }; }
    const j = await r.json().catch(() => ({ error: 'unavailable' }));
    if (!r.ok || j.error) throw { code: j.error || 'unavailable', message: j.error || String(r.status) };
    return j;
  }

  /* ---- realtime-ish listeners by polling ---- */
  const meta = Object.freeze({ fromCache: false, hasPendingWrites: false });
  const snapDoc = (path, exists, data) => { const d = exists ? clone(data) : undefined; return Object.freeze({ id: path.split('/').pop(), exists, data: () => d, metadata: meta }); };
  const snapCol = docs => { const ds = docs.map(x => snapDoc(x.path, true, x.data)); return Object.freeze({ docs: ds, size: ds.length, empty: !ds.length, docChanges: () => [], metadata: meta }); };
  const subs = new Map();
  let seq = 0, timer = 0, busy = false, again = false;
  function listen(kind, path, next, error) {
    const k = 's' + (++seq);
    subs.set(k, { kind, path, next, error, stamp: null });
    soon(20);
    return () => { subs.delete(k); };
  }
  function schedule(ms) { clearTimeout(timer); timer = setTimeout(poll, ms); }
  function soon(ms) { if (busy) again = true; else schedule(ms); }
  async function poll() {
    if (busy) { again = true; return; }
    if (!subs.size) { schedule(POLL); return; }
    busy = true;
    try {
      const j = await api({ op: 'poll', subs: [...subs].map(([k, s]) => ({ k, kind: s.kind, path: s.path, stamp: s.stamp })) });
      for (const r of j.results || []) {
        const s = subs.get(r.k);
        if (!s) continue;
        s.stamp = r.stamp;
        try { s.next(s.kind === 'col' ? snapCol(r.docs || []) : snapDoc(s.path, !!r.exists, r.data)); } catch (e) { console.error(e); }
      }
    } catch (e) {
      if (e && e.code === 'revoked') { busy = false; return; }
    }
    busy = false;
    if (again) { again = false; schedule(30); } else schedule(document.hidden ? POLL * 5 : POLL);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) soon(60); });
  const kick = () => soon(40);

  function docRef(path) {
    segs(path, 0, 'document');
    return {
      id: path.split('/').pop(), path,
      async get() { const j = await api({ op: 'get', path }); return snapDoc(path, !!j.exists, j.data); },
      async set(data) { await api({ op: 'set', path, data: clone(data) }); kick(); },
      async update(data) { await api({ op: 'update', path, data: clone(data) }); kick(); },
      async delete() { await api({ op: 'delete', path }); kick(); },
      async acquire() { return { acquired: true }; },
      onSnapshot(next, error) { return listen('doc', path, next, error); },
      collection(sub) { return colRef(path + '/' + sub); }
    };
  }
  function colRef(path) {
    segs(path, 1, 'collection');
    const q = {
      path,
      where() { return q; }, orderBy() { return q; }, limit() { return q; },
      async get() { const j = await api({ op: 'list', path }); return snapCol(j.docs || []); },
      onSnapshot(next, error) { return listen('col', path, next, error); },
      doc(id) { return docRef(path + '/' + (id || rid())); },
      async add(data) { const r = q.doc(); await r.set(data); return r; }
    };
    return q;
  }
  const db = Object.freeze({ doc: docRef, collection: colRef });

  /* ---- who is here ---- */
  const meP = fetch('/api/me', { credentials: 'same-origin' }).then(r => {
    if (r.status === 401) { goLogin(); return null; }
    return r.ok ? r.json() : null;
  }).catch(() => null);

  const assets = Object.freeze({
    async upload(blob, opt) {
      const type = (opt && opt.type) || blob.type;
      let r;
      try { r = await fetch('/api/assets?app=' + APP, { method: 'POST', headers: { 'content-type': type }, body: blob, credentials: 'same-origin' }); }
      catch (e) { throw { code: 'store_unavailable' }; }
      const j = await r.json().catch(() => ({ error: 'upstream_error' }));
      if (!r.ok || j.error) throw { code: j.error || 'upstream_error', message: j.error };
      return j;
    },
    async delete(ref) {
      const id = String(ref).split('/').pop();
      const r = await fetch('/api/assets/' + encodeURIComponent(id), { method: 'DELETE', credentials: 'same-origin' });
      const j = await r.json().catch(() => ({ error: 'upstream_error' }));
      if (!r.ok || j.error) throw { code: j.error || 'upstream_error' };
      return j;
    },
    async list() { return { assets: [], usage: {} }; }
  });
  const downloads = Object.freeze({
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data]);
      const u = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = u; a.download = filename || 'file'; a.rel = 'noopener';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(u), 60e3);
      return { status: 'saved' };
    }
  });

  /* ---- comments: own panel, threads with dates ---- */
  let me = null, panel = null, pSub = null, pPhoto = '', pAlbum = '', replyTo = null, all = [];
  const fmt = ms => { const d = new Date(ms); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
  function ensurePanel() {
    if (panel) return panel;
    const css = document.createElement('style');
    css.textContent = `.cmx{position:fixed;inset:0;z-index:95;background:rgba(10,9,12,.55);display:flex;justify-content:flex-end}
.cmx[hidden]{display:none}
.cmx .cmx-box{width:min(420px,100%);height:100%;background:#24232a;color:#f2ece0;display:grid;grid-template-rows:auto auto minmax(0,1fr) auto;box-shadow:-20px 0 50px rgba(0,0,0,.5);font:16px/1.5 'Nunito',system-ui,sans-serif}
.cmx .cmx-hd{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid #3d3b44}
.cmx h3{margin:0;font:700 30px/1 'Caveat',cursive}
.cmx .cmx-x{all:unset;cursor:pointer;width:44px;height:44px;border-radius:50%;display:grid;place-items:center;background:rgba(255,255,255,.08);font-size:22px}
.cmx .cmx-x:focus-visible,.cmx button:focus-visible,.cmx textarea:focus-visible{outline:3px solid #ff7a66;outline-offset:2px}
.cmx .cmx-ph{display:flex;gap:12px;align-items:center;padding:12px 16px;border-bottom:1px solid #3d3b44}
.cmx .cmx-ph img{width:64px;height:64px;object-fit:cover;border:3px solid #f4f2ee}
.cmx .cmx-ph span{color:#aaa398;font-size:14px}
.cmx .cmx-list{overflow:auto;padding:12px 16px}
.cmx .cmx-c{background:#2f2e36;border-radius:12px;padding:10px 12px;margin-bottom:10px}
.cmx .cmx-c.cmx-re{margin-left:26px;background:#2a2930}
.cmx .cmx-c b{font-weight:800}.cmx .cmx-c time{color:#aaa398;font-size:13px;margin-left:8px;font-variant-numeric:tabular-nums}
.cmx .cmx-c p{margin:4px 0 6px;white-space:pre-wrap;overflow-wrap:anywhere}
.cmx .cmx-c .cmx-a{display:flex;gap:12px}
.cmx .cmx-c .cmx-a button{all:unset;cursor:pointer;color:#ff9b8a;font-size:14px;font-weight:700;padding:4px 0}
.cmx .cmx-empty{color:#aaa398;text-align:center;padding:30px 10px}
.cmx form{border-top:1px solid #3d3b44;padding:12px 16px calc(12px + env(safe-area-inset-bottom))}
.cmx .cmx-to{display:flex;justify-content:space-between;align-items:center;font-size:14px;color:#aaa398;margin-bottom:6px}
.cmx .cmx-to button{all:unset;cursor:pointer;color:#ff9b8a;font-weight:700}
.cmx textarea{width:100%;box-sizing:border-box;min-height:70px;resize:vertical;border-radius:12px;border:1.5px solid #3d3b44;background:#18171c;color:#f2ece0;padding:10px 12px;font:16px/1.4 'Nunito',system-ui,sans-serif}
.cmx .cmx-send{margin-top:8px;width:100%;min-height:46px;border:0;border-radius:999px;background:#ff7a66;color:#2b0f0a;font:800 16px 'Nunito',system-ui,sans-serif;cursor:pointer}
.cmx .cmx-send:disabled{opacity:.5}
@media(max-width:600px){.cmx{align-items:flex-end}.cmx .cmx-box{height:86vh;border-radius:18px 18px 0 0;width:100%}}
.mechip{position:fixed;left:12px;bottom:calc(12px + env(safe-area-inset-bottom));z-index:20;display:flex;gap:4px;align-items:center;background:rgba(24,23,28,.88);color:#f2ece0;border:1px solid #3d3b44;border-radius:999px;padding:4px 6px 4px 12px;font:600 13px 'Nunito',system-ui,sans-serif;box-shadow:0 6px 18px rgba(0,0,0,.3)}
.mechip a,.mechip button{all:unset;cursor:pointer;color:#ff9b8a;font-weight:800;padding:6px 8px;border-radius:999px}
.mechip a:focus-visible,.mechip button:focus-visible{outline:2px solid #ff7a66}
body.traying .mechip{display:none}`;
    document.head.appendChild(css);
    panel = document.createElement('div');
    panel.className = 'cmx'; panel.hidden = true;
    panel.innerHTML = `<div class="cmx-box" role="dialog" aria-modal="true" aria-labelledby="cmxH"><div class="cmx-hd"><h3 id="cmxH">Сэтгэгдэл</h3><button class="cmx-x" data-x aria-label="Хаах">✕</button></div><div class="cmx-ph"><img alt=""><span></span></div><div class="cmx-list" aria-live="polite"></div><form><div class="cmx-to" hidden><span></span><button type="button" data-cancel>Болих</button></div><textarea maxlength="1000" placeholder="Сэтгэгдлээ бичээрэй…" aria-label="Сэтгэгдэл"></textarea><button class="cmx-send" type="submit">Илгээх</button></form></div>`;
    document.body.appendChild(panel);
    const form = panel.querySelector('form'), ta = panel.querySelector('textarea'), send = panel.querySelector('.cmx-send');
    panel.addEventListener('click', e => {
      if (e.target === panel || e.target.closest('[data-x]')) { closePanel(); return; }
      if (e.target.closest('[data-cancel]')) { replyTo = null; drawTo(); return; }
      const re = e.target.closest('[data-re]');
      if (re) { replyTo = re.dataset.re; drawTo(); ta.focus(); return; }
      const del = e.target.closest('[data-del]');
      if (del && confirmDel(del)) db.collection('comments').doc(del.dataset.del).delete().catch(() => alertBox('Устгаж чадсангүй'));
    });
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const text = ta.value.trim();
      if (!text) return;
      send.disabled = true;
      try { await db.collection('comments').doc(rid()).set({ photo: pPhoto, album: pAlbum, text, re: replyTo }); ta.value = ''; replyTo = null; drawTo(); }
      catch (err) { alertBox('Илгээж чадсангүй, дахин оролдоорой'); }
      send.disabled = false;
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !panel.hidden) { e.stopImmediatePropagation(); closePanel(); } }, true);
    return panel;
  }
  const confirmDel = btn => { if (btn.dataset.sure) return true; btn.dataset.sure = '1'; btn.textContent = 'Устгах уу? Дахин дар'; setTimeout(() => { delete btn.dataset.sure; btn.textContent = 'Устгах'; }, 3000); return false; };
  function alertBox(m) { const l = panel.querySelector('.cmx-list'); const n = document.createElement('p'); n.className = 'cmx-empty'; n.textContent = m; l.prepend(n); setTimeout(() => n.remove(), 3000); }
  function drawTo() {
    const to = panel.querySelector('.cmx-to'), c = all.find(x => x.id === replyTo);
    to.hidden = !c;
    if (c) to.firstChild.textContent = `${c.name}-д хариулж байна`;
  }
  function drawList() {
    if (!panel || panel.hidden) return;
    const list = all.filter(c => c.photo === pPhoto).sort((a, b) => a.at - b.at);
    const ids = new Set(list.map(c => c.id));
    const top = list.filter(c => !c.re || !ids.has(c.re));
    const item = (c, re) => `<div class="cmx-c${re ? ' cmx-re' : ''}"><div><b>${esc(c.name)}</b><time>${esc(fmt(c.at))}</time></div><p>${esc(c.text)}</p><div class="cmx-a">${re ? '' : `<button data-re="${esc(c.id)}">Хариулах</button>`}${me && (c.by === me.uid || me.owner) ? `<button data-del="${esc(c.id)}">Устгах</button>` : ''}</div></div>`;
    panel.querySelector('.cmx-list').innerHTML = top.length ? top.map(c => item(c) + list.filter(r => r.re === c.id).map(r => item(r, true)).join('')).join('') : '<p class="cmx-empty">Одоохондоо сэтгэгдэл алга. Эхнийх нь та болоорой!</p>';
    panel.querySelector('.cmx-ph span').textContent = list.length ? `${list.length} сэтгэгдэл` : 'Энэ зурагт сэтгэгдэл бичих';
  }
  function openPanel(el) {
    const it = el && el.closest ? el.closest('[data-id]') : null;
    if (!it) return false;
    ensurePanel();
    pPhoto = it.dataset.id;
    pAlbum = (location.hash.match(/^#a-([a-z0-9]+)/i) || [])[1] || '';
    replyTo = null; drawTo();
    const img = it.querySelector('img');
    panel.querySelector('.cmx-ph img').src = img ? img.getAttribute('src') : '';
    panel.hidden = false;
    drawList();
    if (!pSub) pSub = colRef('comments').onSnapshot(s => { all = s.docs.map(d => ({ id: d.id, ...d.data() })); drawList(); });
    setTimeout(() => panel.querySelector('textarea').focus(), 50);
    return true;
  }
  function closePanel() { if (!panel) return; panel.hidden = true; if (pSub) { pSub(); pSub = null; } }
  const comments = Object.freeze({
    async openComposer({ element } = {}) { return { opened: openPanel(element) }; },
    async anchorFor() { return { path: '', x: 0, y: 0 }; }
  });

  /* ---- signed-in chip ---- */
  function chip() {
    ensurePanel();
    const c = document.createElement('div');
    c.className = 'mechip';
    c.innerHTML = `<span>${esc(me.name)}</span>${me.owner ? '<a href="/admin">Удирдлага</a>' : ''}${me.can.album.read && APP === 'share' ? '<a href="/">Цомог</a>' : ''}${me.can.share.read && APP === 'album' ? '<a href="/share/">Дамжуулах</a>' : ''}<button type="button">Гарах</button>`;
    c.querySelector('button').addEventListener('click', async () => { await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {}); location.href = '/login'; });
    document.body.appendChild(c);
  }

  async function use(name) {
    me = me || await meP;
    if (!me) return null;
    const c = me.can[APP];
    if (name === 'db') return c.read ? db : null;
    if (name === 'user') return Object.freeze({
      async isOwner() { return me.owner; },
      async canEdit() { return !!c.edit; },
      async can(n) { return n === 'data.write' ? !!c.edit : n === 'assets.write' ? !!c.upload : null; },
      async id() { return me.uid; },
      async me() { return { id: me.uid, name: me.name }; },
      async profiles(ids) { return Object.fromEntries((ids || []).map(i => [i, { name: i === me.uid ? me.name : '' }])); }
    });
    if (name === 'assets') return c.upload ? assets : null;
    if (name === 'downloads') return downloads;
    if (name === 'comments') return APP === 'album' && c.comment ? comments : null;
    return null;
  }
  window.claude = Object.freeze({ use });
  meP.then(m => { me = m; if (m) { if (document.body) chip(); else document.addEventListener('DOMContentLoaded', chip); } });
})();
