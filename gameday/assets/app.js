/* Corbeau catalog app. Reads data/<id>.json (built by tools/build.py) and renders a page-flip book.
   URL options:  ?c=<catalog id>  (default gameday)   ?booth=1  (start in booth mode)   ?debug  (log dataLayer)  */
(() => {
  'use strict';

  const params = new URLSearchParams(location.search);
  const CATALOG_ID = /^[a-z0-9-]+$/.test(params.get('c') || '') ? params.get('c') : 'gameday';
  const DEBUG = params.has('debug');

  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const book = $('#book');

  let data, cfg, pageFlip;
  let pageMeta = [];               // per page index: { type, handle, label, media }
  let pageEls = [];                // per page index: the page element
  const byHandle = {};             // handle -> product
  const state = {};                // handle -> { sel: [option values], qty, variant, view }
  let shownSet = new Set();
  let booth = false, idleTimer = null, wakeLock = null;
  let bag = [];                    // [{ id: variant id, qty }]
  const gal = { handle: null, variantId: null, view: 0 };
  let filmUnmuted = false, filmTracked = false;

  /* ---------------- analytics (Google Tag Manager) ---------------- */
  window.dataLayer = window.dataLayer || [];
  function track(event, extra = {}) {
    if (extra.ecommerce) window.dataLayer.push({ ecommerce: null });   // GA4 convention: clear the previous ecommerce object
    const payload = { event, catalog_id: CATALOG_ID, ...extra };
    window.dataLayer.push(payload);
    if (DEBUG) console.log('[dataLayer]', payload);
  }
  function loadGTM(id) {
    if (!/^GTM-[A-Z0-9]{4,}$/.test(id || '') || /^GTM-X+$/.test(id)) {
      if (DEBUG) console.log('[gtm] placeholder id, container not loaded; events still go to window.dataLayer');
      return false;
    }
    window.dataLayer.push({ 'gtm.start': Date.now(), event: 'gtm.js' });
    const s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtm.js?id=' + encodeURIComponent(id);
    document.head.appendChild(s);
    return true;
  }
  const gaItem = (p, v, qty = 1) => ({
    item_id: v.sku || String(v.id), item_name: p.title, item_variant: v.title, item_brand: 'Corbeau',
    item_category: p.type, price: v.price, quantity: qty,
  });

  /* ---------------- formatting helpers ---------------- */
  const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  const money = (n) => (n == null ? '' : usd.format(n).replace(/\.00$/, ''));
  const sized = (src, w) => (src || '').replace(/([?&])width=\d+/, `$1width=${w}`);
  const shortTitle = (t) => t.replace(/\s+(ergonomic\s+)?(office\s+)?chair$/i, '') || t;
  const two = (n) => String(n).padStart(2, '0');
  const dur = (s) => `${Math.floor(s / 60)}:${two(Math.round(s % 60))}`;
  const maxQty = () => cfg.checkout?.maxQty || 50;
  const minPrice = () => Math.min(...data.products.map((p) => p.priceMin ?? Infinity));
  // every photo of a variant: the rendered angle set when there is one, else the store's own photo
  const photosFor = (v) => (v.photos && v.photos.length ? v.photos
    : [{ src: v.image.src, thumb: sized(v.image.src, 320), label: 'Store photo', view: 'store' }]);

  const COLOR_WORDS = [
    ['light grey', '#C9C9C9'], ['light gray', '#C9C9C9'], ['black', '#111111'], ['blue', '#0A3A82'],
    ['red', '#C8102E'], ['grey', '#8A8D8F'], ['gray', '#8A8D8F'], ['white', '#F5F5F5'], ['pink', '#F2A7C3'],
    ['green', '#3E6B48'], ['yellow', '#EAFF02'], ['orange', '#F26B21'], ['tan', '#C8A27A'], ['brown', '#6B4423'],
  ];
  function colorFor(value) {
    const v = value.toLowerCase();
    let best = null, at = Infinity;
    for (const [word, hex] of COLOR_WORDS) {
      const i = v.indexOf(word);
      if (i >= 0 && i < at) { at = i; best = hex; }
    }
    return best;
  }
  const swatchHtml = (label, attrs, pressed, na = false) => {
    const c = colorFor(label);
    return `<button class="swatch${na ? ' na' : ''}" ${attrs} aria-pressed="${pressed}">${c ? `<span class="dot" style="background:${c}"></span>` : ''}${esc(label)}</button>`;
  };

  function findVariantById(id) {
    for (const p of data.products) {
      const v = p.variants.find((x) => x.id === id);
      if (v) return { p, v };
    }
    return null;
  }
  function cartUrl(lines) {
    const ref = cfg.checkout?.ref;
    return `${cfg.store.replace(/\/$/, '')}/cart/${lines.map((l) => `${l.id}:${l.qty}`).join(',')}` + (ref ? `?ref=${encodeURIComponent(ref)}` : '');
  }
  function shareUrl() {
    if (cfg.catalogUrl) return cfg.catalogUrl;
    const u = new URL(location.href);
    ['booth', 'debug'].forEach((k) => u.searchParams.delete(k));
    u.hash = '';
    return u.href;
  }
  const isLocalUrl = (href) => {
    try { const u = new URL(href); return u.protocol === 'file:' || /^(localhost|127\.|\[::1\]|192\.168\.|10\.)/.test(u.hostname); }
    catch { return true; }
  };
  function qrSvg(text) {
    const q = qrcode(0, 'M');
    q.addData(text);
    q.make();
    return q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  }

  /* ---------------- theme ---------------- */
  function applyTheme(t = {}) {
    const map = { primary: '--primary', onPrimary: '--on-primary', ink: '--ink', paper: '--paper', muted: '--muted',
      line: '--line', coverBg: '--cover-bg', coverInk: '--cover-ink', desk: '--desk', night: '--night' };
    for (const [k, v] of Object.entries(map)) if (t[k]) document.documentElement.style.setProperty(v, t[k]);
  }

  /* ---------------- pages ---------------- */
  const ICON = {
    expand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/></svg>',
    left: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 5l-7 7 7 7"/></svg>',
    right: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 5l7 7-7 7"/></svg>',
    drag: '<svg viewBox="0 0 48 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M8 12h32M14 6l-6 6 6 6M34 6l6 6-6 6"/></svg>',
  };
  const page = (cls, inner, attrs = '') => `<div class="page ${cls}" ${attrs}><div class="page-inner">${inner}</div></div>`;
  const folio = (n) => `<div class="folio"><span class="logo"></span><span>${esc(cfg.cover?.headline || '')} &middot; ${n}</span></div>`;
  const specs = (rows) => (rows && rows.length
    ? `<dl class="specs" style="--n:${rows.length}">${rows.map(([k, v]) => `<div class="spec"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>` : '');
  const fill = (s) => String(s).replace('{count}', data.products.length).replace('{minPrice}', money(minPrice()));

  // Cover in the style of the GameDay "Your Starting Roster" insert: its stadium background, framed
  // chairs and headline (set in Joyride EXT by tools/make_media.py), and a black open-the-catalog bar.
  function rosterCover(c, m) {
    const chairs = m.chairs.map((ch, i) => `<img class="acc d${i + 1}" src="${esc(ch.src)}" alt="${esc(ch.name)} Office Chair">`).join('');
    return page('hard cover roster', `
      <div class="roster-bg" style="background-image:url('${esc(m.bg)}')"></div>
      <div class="roster-shade"></div>
      <span class="logo roster-logo" role="img" aria-label="Corbeau"></span>
      <div class="roster-title"><img class="roster-head" src="${esc(m.headline.src)}" alt="${esc(m.headline.alt)}" style="width:${m.headline.widthPct}cqw">
        <div class="roster-tag acc">${esc(c.tagline || '')}</div></div>
      <div class="roster-row">${chairs}</div>
      <div class="roster-cta acc wipe d4"><span>${esc(c.cta || '')}</span></div>`, 'data-density="hard"');
  }

  function coverPage() {
    const c = cfg.cover || {};
    const rm = c.style === 'roster' ? data.media[c.media] : null;
    if (rm && rm.chairs && rm.headline) return rosterCover(c, rm);
    const order = (c.lineup && c.lineup.length ? c.lineup : data.products.map((p) => p.handle)).filter((h) => byHandle[h]).slice(0, 7);
    // Chairs sit on a white floor and blend with multiply, so the photos' white backgrounds disappear.
    // Sizes step down from the middle; spacing keeps chair bodies (about 55% of each square) apart.
    const mid = (order.length - 1) / 2, maxA = Math.ceil(mid);
    const size = (a) => 56 * (1 - 0.15 * a);
    const offs = [0];
    for (let a = 1; a <= maxA; a++) offs[a] = offs[a - 1] + 0.55 * (size(a - 1) + size(a)) / 2 + 2;
    const extent = (offs[maxA] || 0) + 0.55 * size(maxA) / 2;
    const k = Math.min(1, 46 / Math.max(extent, 1));
    const lineupH = size(0) * k;
    const chairs = order.map((h, i) => {
      const p = byHandle[h], v = p.variants[0], d = i - mid, a = Math.abs(d);
      const x = 50 + Math.sign(d) * (offs[Math.round(a)] ?? 0) * k;
      const style = `left:${x.toFixed(2)}cqw;width:${(size(a) * k).toFixed(2)}cqw;z-index:${10 - Math.round(a)}`;
      return `<span class="chair" style="${style}"><img src="${esc(sized(v.image.src, 700))}" alt="${esc(p.title)}" style="animation-delay:${(0.1 + a * 0.12).toFixed(2)}s"></span>`;
    }).join('');
    return page('hard cover', `
      <span class="logo big" role="img" aria-label="Corbeau"></span>
      <div class="eyebrow acc">${esc(c.eyebrow || '')}</div>
      <h1 class="headline">${esc(c.headline || cfg.title)}</h1>
      <p class="subhead acc d1">${esc(c.subhead || '')}</p>
      <div class="floor" style="height:${(lineupH + 12).toFixed(2)}cqw"></div>
      <div class="lineup" style="height:${lineupH.toFixed(2)}cqw">${chairs}</div>
      <div class="stripe acc wipe d2"></div>
      <div class="cta acc d3">${esc(c.cta || '')}</div>`, 'data-density="hard"');
  }

  function manifestoPage(n) {
    const i = cfg.intro || {};
    const rows = (i.specs || [['Schools', '{count}'], ['From', '{minPrice}']]).map(([k, v]) => [k, fill(v)]);
    return page('dark manifesto', `
      <div class="eyebrow">${esc(cfg.cover?.eyebrow || '')}</div>
      <h2 class="h1">${esc(i.heading || '')}</h2>
      <p class="lede acc d1">${esc(i.body || '')}</p>
      <ul class="ticks acc d2">${(i.highlights || []).map((h) => `<li>${esc(h)}</li>`).join('')}</ul>
      <div class="acc d3" style="margin-top:auto">${specs(rows)}</div>
      ${folio(n)}`);
  }

  function lineupPage(n) {
    const built = new Date(data.generatedAt);
    const cols = data.products.map((p, i) => {
      const v = p.variants[0], ph = photosFor(v)[0];
      return `<button class="lu acc d${Math.min(i + 1, 5)}" data-action="goto" data-handle="${esc(p.handle)}">
        <img src="${esc(ph.thumb)}" alt=""><span class="n">${two(i + 1)}</span><span class="t">${esc(shortTitle(p.title))}</span>
        <span class="s">${esc(p.options[0] ? p.options[0].values.join(', ') : '')}</span><span class="p">${money(p.priceMin)}</span></button>`;
    }).join('');
    return page('light lineup-page', `
      <div class="eyebrow">Contents</div>
      <h2 class="h2">${esc(cfg.toc?.heading || 'The lineup')}</h2>
      <div class="lineup-row" style="--n:${data.products.length}">${cols}</div>
      <div class="small source">Prices and stock from corbeau.com, ${built.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}. Tap a chair to jump to it.</div>
      ${folio(n)}`);
  }

  function filmPages(sec) {
    const m = data.media[sec.media];
    if (!m) return null;
    const attrs = `style="background-image:url('${esc(m.poster)}')" data-film="${esc(sec.media)}"`;
    const label = sec.eyebrow || 'Film';
    return [
      [() => page('dark film l', `<div class="eyebrow">${esc(label)}</div><h2 class="h2">${esc(sec.heading || '')}</h2>`, attrs), { type: 'film', label, media: sec.media }],
      [() => page('dark film r', `<div class="play-hint"><i>&#9654;</i>${esc(sec.caption || 'Play')} &middot; ${dur(m.duration)}</div>`, attrs), { type: 'film', label, media: sec.media }],
    ];
  }

  function featurePages(sec) {
    const m = data.media[sec.media];
    if (!m) return null;
    const side = sec.side === 'right' ? 'r' : 'l';
    const label = sec.eyebrow || 'Feature';
    const media = [() => page(`dark feature-media ${side}`, `
      <video class="page-video" muted loop playsinline preload="none" poster="${esc(m.poster)}" data-src="${esc(m.video)}"></video>
      <div class="fade"></div><div class="big-num">${esc(sec.number || '')}</div>`, `style="--fit:${sec.fit === 'contain' ? 'contain' : 'cover'}"`),
    { type: 'feature', label }];
    const text = [(n) => page('dark feature-text', `
      <div class="lead-in"></div>
      <div class="eyebrow"><span class="num-tag">${esc(sec.number || '')}</span>${esc(label)}</div>
      <h2 class="h1">${esc(sec.heading || '')}</h2>
      <p class="body acc d1">${esc(sec.body || '')}</p>
      <div class="acc d2">${specs(sec.specs)}</div>
      ${folio(n)}`), { type: 'feature', label }];
    return side === 'l' ? [media, text] : [text, media];
  }

  function shotPage(p, i) {
    const s = state[p.handle], v = s.variant, ph = photosFor(v)[s.view] || photosFor(v)[0];
    return page('light shot', `
      <div class="shot-head"><div><div class="school">${esc(shortTitle(p.title))}</div>${p.badge ? `<span class="badge acc d1">${esc(p.badge)}</span>` : ''}</div>
        <div class="num">${two(i + 1)}</div></div>
      <div class="frame"><img src="${esc(ph.src)}" alt="${esc(`${p.title}, ${v.title}`)}" data-key="${esc(`${v.sku}|${ph.view}`)}">
        <button class="expand" data-action="photos" data-handle="${esc(p.handle)}" aria-label="See every photo full screen">${ICON.expand}</button></div>
      <div class="thumbs acc d2" data-bind="thumbs"></div>
      <div class="caption"><span class="v" data-bind="variant"></span><span class="sku" data-bind="sku"></span></div>`, `data-handle="${esc(p.handle)}"`);
  }

  function detailPage(p, n) {
    const h = esc(p.handle);
    const opts = p.options.map((o, k) => `
      <div class="opt"><div class="opt-label">${esc(o.name)}: <b data-bind="opt${k}"></b></div>
      <div class="swatches acc d2">${o.values.map((val) => swatchHtml(val, `data-action="opt" data-handle="${h}" data-k="${k}" data-val="${esc(val)}"`, false)).join('')}</div></div>`).join('');
    return page('light detail', `
      <div class="eyebrow">${esc(cfg.cover?.headline || '')} &middot; ${esc(p.type)}</div>
      <h2 class="h2">${esc(p.title)}</h2>
      <div class="price-row acc d1"><span class="price" data-bind="price"></span><span class="was" data-bind="was"></span></div>
      <div class="acc d1" data-bind="specs"></div>
      ${opts}
      <div class="buy-row acc d3">
        <div class="qty"><button data-action="qty" data-handle="${h}" data-d="-1" aria-label="Fewer">&minus;</button>
          <span class="n" data-bind="qty">1</span>
          <button data-action="qty" data-handle="${h}" data-d="1" aria-label="More">+</button></div>
        <button class="btn block" data-action="add" data-handle="${h}" data-bind="add">Add to bag</button>
      </div>
      <div class="more"><a class="link" data-action="buy" data-handle="${h}" href="#" target="_blank" rel="noopener">Buy now</a>
        <a class="link" href="${esc(p.url)}" target="_blank" rel="noopener" data-action="details" data-handle="${h}">Full details on corbeau.com</a></div>
      <p class="desc">${esc(p.description)}</p>
      ${folio(n)}`, `data-handle="${h}"`);
  }

  function galleryPages(sec) {
    const label = sec.eyebrow || 'Every angle';
    return [
      [() => page('light gal-viewer', `
        <div class="eyebrow">${esc(label)}</div>
        <div class="frame"><img src="" alt="">
          <button class="expand" data-action="gal-open" aria-label="Full screen">${ICON.expand}</button></div>
        <div class="caption"><span data-bind="gal-cap"></span><span class="small" data-bind="gal-count"></span></div>`), { type: 'gallery', label }],
      [(n) => page('light gal-picker', `
        <div class="eyebrow">${esc(label)}</div>
        <h2 class="h2">${esc(sec.heading || '')}</h2>
        <p class="body">${esc(sec.body || '')}</p>
        <div class="label">School</div>
        <div class="school-tabs" style="--n:${data.products.length}">${data.products.map((p) => `<button class="school-tab" data-action="gal-school" data-handle="${esc(p.handle)}" aria-pressed="false">${esc(shortTitle(p.title))}</button>`).join('')}</div>
        <div class="label">Color</div>
        <div class="swatches" data-bind="gal-colors"></div>
        <div class="label">Views</div>
        <div class="view-grid" data-bind="gal-views"></div>
        <div class="actions"><button class="btn" data-action="gal-open">Full screen</button><button class="btn ghost" data-action="gal-shop">Shop this chair</button></div>
        ${folio(n)}`), { type: 'gallery', label }],
    ];
  }

  function spinPages(sec) {
    const m = data.media[sec.media], p = byHandle[sec.handle];
    if (!m || !p) return null;
    const v = p.variants.find((x) => x.sku === sec.sku) || p.variants[0];
    const label = sec.eyebrow || '360 view';
    return [
      [() => page('light spin-page', `
        <div class="eyebrow">${esc(label)}</div>
        <div class="spin" data-spin="${esc(sec.media)}"><img src="${esc(m.frames[0])}" alt="${esc(`${p.title}, ${v.title}, 360 view`)}" draggable="false"></div>
        <div class="spin-dial"><i data-bind="spin-dot" style="left:0%"></i></div>
        <div class="spin-bar"><span class="spin-hint">${ICON.drag}Drag to rotate</span>
          <span class="spin-steps"><button data-action="spin-step" data-d="-1" aria-label="Rotate left">${ICON.left}</button><button data-action="spin-step" data-d="1" aria-label="Rotate right">${ICON.right}</button></span></div>`), { type: 'spin', label }],
      [(n) => page('dark spin-text', `
        <div class="lead-in"></div>
        <div class="eyebrow">${esc(label)}</div>
        <h2 class="h1">${esc(sec.heading || '')}</h2>
        <p class="body acc d1">${esc(sec.body || '')}</p>
        <div class="acc d2">${specs([['Chair', shortTitle(p.title)], ['Color', v.title], ['Price', money(v.price)]])}</div>
        <div class="acc d3" style="display:flex;gap:3cqw;align-items:center;margin-bottom:3cqw">
          <button class="btn" data-action="add-variant" data-variant="${v.id}">Add to bag</button>
          <button class="btn ghost" data-action="goto" data-handle="${esc(p.handle)}">See all colors</button></div>
        ${folio(n)}`), { type: 'spin', label }],
    ];
  }

  function closingPages() {
    const c = cfg.contact || {}, s = cfg.share || {};
    const tel = (c.phone || '').replace(/[^\d+]/g, '');
    const url = shareUrl();
    return [
      [(n) => page('dark contact', `
        <div class="eyebrow">Contact</div>
        <h2 class="h2">${esc(c.heading || 'Talk to us')}</h2>
        <p class="lede">${esc(c.body || '')}</p>
        <div class="contact-rows acc d1">
          ${c.phone ? `<div><div class="k">Call</div><a class="v" href="tel:${esc(tel)}" data-action="contact" data-method="phone">${esc(c.phone)}</a></div>` : ''}
          ${c.email ? `<div><div class="k">Email</div><a class="v" href="mailto:${esc(c.email)}" data-action="contact" data-method="email">${esc(c.email)}</a></div>` : ''}
          ${c.hours ? `<div><div class="k">Hours</div><div class="v plain">${esc(c.hours)}</div></div>` : ''}
          ${c.address ? `<div><div class="k">Corbeau</div><div class="v plain">${esc(c.address)}</div></div>` : ''}
        </div>
        ${c.shopUrl ? `<a class="btn acc d2" href="${esc(c.shopUrl)}" target="_blank" rel="noopener" data-action="contact" data-method="shop">${esc(c.shopLabel || 'Shop corbeau.com')}</a>` : ''}
        ${folio(n)}`), { type: 'contact', label: 'Contact' }],
      [(n) => page('dark share', `
        <div class="eyebrow">Share</div>
        <h2 class="h2">${esc(s.heading || 'Take this catalog with you')}</h2>
        <div class="qr-box acc scale d1">${qrSvg(url)}</div>
        <p class="body">${esc(s.body || 'Scan to open it on your phone.')}</p>
        <div class="url">${esc(url)}</div>
        ${isLocalUrl(url) ? '<div class="small local-note">Local preview: this code points at this computer. It becomes a real link once catalogUrl is set in the catalog file.</div>' : ''}
        ${folio(n)}`), { type: 'contact', label: 'Contact' }],
    ];
  }

  function backPage() {
    return page('hard back', `
      <span class="logo" role="img" aria-label="Corbeau"></span>
      <div class="tag acc d1">${esc(cfg.backCover?.tagline || '')}</div>
      <div class="site acc d2">${esc(cfg.store.replace(/^https?:\/\//, ''))}</div>`, 'data-density="hard"');
  }

  function buildPages() {
    const parts = [];
    const pair = (pp) => { if (pp && pp.length === 2) parts.push(...pp); };
    parts.push([() => coverPage(), { type: 'cover', label: 'Cover' }]);
    for (const sec of cfg.sections || [{ type: 'intro' }, { type: 'products' }, { type: 'closing' }]) {
      if (sec.type === 'intro') pair([[(n) => manifestoPage(n), { type: 'intro', label: 'Contents' }], [(n) => lineupPage(n), { type: 'intro', label: 'Contents' }]]);
      else if (sec.type === 'film') pair(filmPages(sec));
      else if (sec.type === 'feature') pair(featurePages(sec));
      else if (sec.type === 'products') data.products.forEach((p, i) => pair([[() => shotPage(p, i), { type: 'shot', handle: p.handle }], [(n) => detailPage(p, n), { type: 'detail', handle: p.handle }]]));
      else if (sec.type === 'gallery') pair(galleryPages(sec));
      else if (sec.type === 'spin') pair(spinPages(sec));
      else if (sec.type === 'closing') pair(closingPages());
    }
    parts.push([() => backPage(), { type: 'back', label: 'Back cover' }]);
    book.innerHTML = parts.map(([fn], n) => fn(n)).join('');
    pageMeta = parts.map(([, meta]) => meta);
    pageEls = $$('.page', book);
  }

  /* ---------------- product state ---------------- */
  const pageEl = (type, handle) => pageEls.find((el, i) => pageMeta[i].type === type && pageMeta[i].handle === handle);
  function findVariant(p, sel) {
    return p.variants.find((v) => v.options.every((o, k) => o === sel[k]));
  }
  function selectOption(handle, k, val) {
    const p = byHandle[handle], s = state[handle];
    const next = s.sel.slice();
    next[k] = val;
    let v = findVariant(p, next);
    if (!v) v = p.variants.find((x) => x.options[k] === val && x.available) || p.variants.find((x) => x.options[k] === val);
    if (!v) return;
    s.sel = v.options.slice();
    s.variant = v;
    s.view = 0;
    render(handle);
    track('select_variant', { product: p.handle, variant_id: v.id, sku: v.sku, variant: v.title });
  }
  function setQty(handle, d) {
    const s = state[handle];
    s.qty = Math.max(1, Math.min(maxQty(), s.qty + d));
    render(handle);
  }

  function swapImage(frame, src, key, alt) {
    // Change photo without the two ever overlapping: the photos blend into the page (multiply), so
    // an overlap reads as a ghost. Wait until the new photo is decoded, fade the old one out (short,
    // linear), then fade the new one in. A token makes the newest swap win on fast taps.
    const imgs = $$('img', frame), latest = imgs[imgs.length - 1];
    if (latest && latest.dataset.key === key && latest.getAttribute('src') && !latest.classList.contains('outgoing')) return;
    const token = (frame._swap = (frame._swap || 0) + 1);
    const pre = new Image();
    pre.decoding = 'async';
    pre.src = src;
    const go = () => {
      if (frame._swap !== token) return;
      const old = $$('img', frame);
      old.forEach((o) => o.classList.add('outgoing'));
      setTimeout(() => {
        if (frame._swap !== token) return;
        old.forEach((o) => o.remove());
        const im = new Image();
        im.className = 'incoming';
        im.alt = alt;
        im.dataset.key = key;
        im.src = src;
        frame.insertBefore(im, $('.expand', frame));
        requestAnimationFrame(() => requestAnimationFrame(() => im.classList.add('on')));
        setTimeout(() => { if (frame._swap === token) im.classList.remove('incoming', 'on'); }, 600);
      }, old.length && old.some((o) => o.getAttribute('src')) ? 130 : 0);
    };
    (pre.decode ? pre.decode() : Promise.reject()).then(go, () => { if (pre.complete) go(); else { pre.onload = go; pre.onerror = go; } });
  }
  // Fetch a chair's photos ahead of time so a color or angle change does not wait on the disk.
  const warmed = new Set();
  function warmPhotos(handle) {
    if (warmed.has(handle)) return;
    warmed.add(handle);
    byHandle[handle].variants.forEach((v) => photosFor(v).forEach((ph) => { const i = new Image(); i.src = ph.src; }));
  }

  function render(handle) {
    const p = byHandle[handle], s = state[handle], v = s.variant;
    const photos = photosFor(v);
    if (s.view >= photos.length) s.view = 0;
    const ph = photos[s.view];
    const shot = pageEl('shot', handle), detail = pageEl('detail', handle);
    if (shot) {
      swapImage($('.frame', shot), ph.src, `${v.sku}|${ph.view}`, `${p.title}, ${v.title}, ${ph.label}`);
      $('[data-bind="thumbs"]', shot).innerHTML = photos.length > 1 ? photos.map((x, k) =>
        `<button class="thumb" data-action="view" data-handle="${esc(handle)}" data-k="${k}" aria-pressed="${k === s.view}" aria-label="${esc(x.label)}"><img src="${esc(x.thumb)}" alt=""></button>`).join('') : '';
      $('[data-bind="variant"]', shot).textContent = v.title;
      $('[data-bind="sku"]', shot).textContent = `SKU ${v.sku} · ${ph.label}`;
    }
    if (!detail) return;
    $('[data-bind="price"]', detail).textContent = money(v.price);
    $('[data-bind="was"]', detail).textContent = v.compareAt && v.compareAt > v.price ? money(v.compareAt) : '';
    const extra = cfg.productDefaults?.specs || [];
    $('[data-bind="specs"]', detail).innerHTML = specs([['SKU', v.sku], [p.options[0] ? 'Color' : 'Option', v.title], ...extra]);
    p.options.forEach((o, k) => {
      $(`[data-bind="opt${k}"]`, detail).textContent = s.sel[k];
      $$(`.swatch[data-k="${k}"]`, detail).forEach((b) => {
        const val = b.dataset.val;
        b.setAttribute('aria-pressed', String(val === s.sel[k]));
        const trial = s.sel.slice(); trial[k] = val;
        const tv = findVariant(p, trial);
        b.classList.toggle('na', !tv || !tv.available);
      });
    });
    $('[data-bind="qty"]', detail).textContent = s.qty;
    const add = $('[data-bind="add"]', detail), buy = $('[data-action="buy"]', detail);
    if (v.available) {
      add.textContent = `Add to bag · ${money(v.price * s.qty)}`;
      add.disabled = false;
      buy.href = cartUrl([{ id: v.id, qty: s.qty }]);
      buy.textContent = 'Buy now';
    } else {
      add.textContent = 'Sold out';
      add.disabled = true;
      buy.href = p.url;
      buy.textContent = 'See details';
    }
  }

  /* ---------------- bag (one Shopify cart link for everything in it) ---------------- */
  const BAG_KEY = `corbeau-catalog-bag-${CATALOG_ID}`;
  function loadBag() {
    try {
      const arr = JSON.parse(localStorage.getItem(BAG_KEY) || '[]');
      bag = arr.filter((l) => l && findVariantById(l.id)).map((l) => ({ id: l.id, qty: Math.max(1, Math.min(maxQty(), l.qty | 0)) }));
    } catch { bag = []; }
  }
  function saveBag() {
    if (booth) return;   // a booth iPad keeps nothing between visitors
    try { localStorage.setItem(BAG_KEY, JSON.stringify(bag)); } catch { /* private window */ }
  }
  const bagCount = () => bag.reduce((n, l) => n + l.qty, 0);
  const bagTotal = () => bag.reduce((t, l) => t + (findVariantById(l.id)?.v.price || 0) * l.qty, 0);
  const bagItems = () => bag.map((l) => { const f = findVariantById(l.id); return gaItem(f.p, f.v, l.qty); });

  function addToBag(v, qty) {
    const f = findVariantById(v.id);
    if (!f || !v.available) return;
    const line = bag.find((l) => l.id === v.id);
    if (line) line.qty = Math.min(maxQty(), line.qty + qty); else bag.push({ id: v.id, qty });
    saveBag();
    renderBag();
    const btn = $('#btn-bag');
    btn.classList.remove('bump'); void btn.offsetWidth; btn.classList.add('bump');
    track('add_to_cart', { ecommerce: { currency: 'USD', value: v.price * qty, items: [gaItem(f.p, v, qty)] } });
    toast(`Added ${shortTitle(f.p.title)}, ${v.title}`, { action: 'View bag', onAction: openBag });
  }
  function renderBag() {
    const count = bagCount();
    $('#bag-count').textContent = count;
    $('#bag-count').hidden = count === 0;
    if ($('#bag').hidden) return;
    $('#bag-lines').innerHTML = bag.length ? bag.map((l) => {
      const { p, v } = findVariantById(l.id), ph = photosFor(v)[0];
      return `<div class="bag-line"><img src="${esc(ph.thumb)}" alt="">
        <div><b>${esc(p.title)}</b><div class="sub">${esc(v.title)} &middot; ${esc(v.sku)}</div>
          <div class="qty"><button data-bag="dec" data-id="${l.id}" aria-label="Fewer">&minus;</button><span class="n">${l.qty}</span><button data-bag="inc" data-id="${l.id}" aria-label="More">+</button></div></div>
        <div class="right">${money(v.price * l.qty)}<br><button class="remove" data-bag="remove" data-id="${l.id}">Remove</button></div></div>`;
    }).join('') : '<div class="bag-empty">Your bag is empty.<br>Add chairs from any page, then check out once.</div>';
    $('#bag-foot').innerHTML = bag.length ? `
      <div class="total"><span>Subtotal</span><b>${money(bagTotal())}</b></div>
      <a class="btn block" data-bag="checkout" href="${esc(cartUrl(bag))}" target="_blank" rel="noopener">${booth && cfg.booth?.buyOnPhone !== false ? 'Check out on your phone' : 'Check out on corbeau.com'}</a>
      <p class="note">Checkout opens on corbeau.com with everything in your bag. Shipping and tax are added there.</p>` : '';
  }
  function openBag() {
    $('#bag').classList.remove('closing');
    $('#bag').hidden = false;
    renderBag();
    track('view_cart', { ecommerce: { currency: 'USD', value: bagTotal(), items: bagItems() } });
  }
  function closeBag() {
    const d = $('#bag');
    if (d.hidden) return;
    d.classList.add('closing');
    setTimeout(() => { d.hidden = true; d.classList.remove('closing'); }, 140);
  }
  function onBagClick(e) {
    const t = e.target.closest('[data-bag]');
    if (e.target.id === 'bag' || (t && t.dataset.bag === 'close')) { closeBag(); return; }
    if (!t) return;
    const id = Number(t.dataset.id), line = bag.find((l) => l.id === id);
    if (t.dataset.bag === 'inc' && line) line.qty = Math.min(maxQty(), line.qty + 1);
    if (t.dataset.bag === 'dec' && line) line.qty = Math.max(1, line.qty - 1);
    if (t.dataset.bag === 'remove' && line) {
      bag = bag.filter((l) => l !== line);
      const f = findVariantById(id);
      track('remove_from_cart', { ecommerce: { currency: 'USD', value: f.v.price * line.qty, items: [gaItem(f.p, f.v, line.qty)] } });
    }
    if (t.dataset.bag === 'checkout') {
      track('begin_checkout', { ecommerce: { currency: 'USD', value: bagTotal(), items: bagItems() }, cart_url: cartUrl(bag), booth });
      if (booth && cfg.booth?.buyOnPhone !== false) { e.preventDefault(); showCheckoutQR(bag.slice()); }
      return;   // otherwise the link opens the cart permalink in a new tab
    }
    saveBag();
    renderBag();
  }
  function showCheckoutQR(lines) {
    const url = cartUrl(lines);
    openModal(`
      <h3>Scan to buy on your phone</h3>
      <div class="items">${lines.map((l) => { const { p, v } = findVariantById(l.id); return `<div class="item"><img src="${esc(photosFor(v)[0].thumb)}" alt=""><div><b>${esc(p.title)}</b><span>${esc(v.title)} &middot; Qty ${l.qty} &middot; ${esc(money(v.price * l.qty))}</span></div></div>`; }).join('')}</div>
      <div class="qr-box">${qrSvg(url)}</div>
      <p class="note">Opens checkout on corbeau.com with ${lines.length > 1 ? 'these chairs' : 'this chair'} already in the cart.</p>
      <div class="row"><button class="btn" data-modal="close">Done</button></div>`);
  }

  /* ---------------- lightbox (every photo of a chair, full screen) ---------------- */
  const lb = { photos: [], k: 0, title: '' };
  function openLightbox(photos, k, title) {
    Object.assign(lb, { photos, k, title });
    renderLightbox();
    $('#lightbox').classList.remove('closing');
    $('#lightbox').hidden = false;
    track('gallery_open', { title, photos: photos.length });
  }
  function renderLightbox() {
    const ph = lb.photos[lb.k], img = $('#lb-img');
    img.classList.remove('swap'); void img.offsetWidth; img.classList.add('swap');
    img.src = ph.src;
    img.alt = `${lb.title}, ${ph.label}`;
    $('#lb-cap').textContent = `${lb.title} · ${ph.label} · ${lb.k + 1} / ${lb.photos.length}`;
    $('#lb-thumbs').innerHTML = lb.photos.map((x, k) => `<button class="thumb" data-lb="go" data-k="${k}" aria-pressed="${k === lb.k}" aria-label="${esc(x.label)}"><img src="${esc(x.thumb)}" alt=""></button>`).join('');
  }
  const lbStep = (d) => { lb.k = (lb.k + d + lb.photos.length) % lb.photos.length; renderLightbox(); };
  function closeLightbox() {
    const l = $('#lightbox');
    if (l.hidden) return;
    l.classList.add('closing');
    setTimeout(() => { l.hidden = true; l.classList.remove('closing'); }, 140);
  }

  /* ---------------- gallery spread ---------------- */
  const galVariant = () => { const p = byHandle[gal.handle]; return p.variants.find((v) => v.id === gal.variantId) || p.variants[0]; };
  function renderGallery() {
    const viewer = pageEls.find((el) => el.classList.contains('gal-viewer'));
    const picker = pageEls.find((el) => el.classList.contains('gal-picker'));
    if (!viewer || !picker) return;
    const p = byHandle[gal.handle], v = galVariant(), photos = photosFor(v);
    if (gal.view >= photos.length) gal.view = 0;
    const ph = photos[gal.view];
    swapImage($('.frame', viewer), ph.src, `${v.sku}|${ph.view}`, `${p.title}, ${v.title}, ${ph.label}`);
    $('[data-bind="gal-cap"]', viewer).innerHTML = `<b>${esc(p.title)}</b> &middot; ${esc(v.title)} &middot; ${esc(ph.label)}`;
    $('[data-bind="gal-count"]', viewer).textContent = `${gal.view + 1} / ${photos.length}`;
    $$('.school-tab', picker).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.handle === gal.handle)));
    $('[data-bind="gal-colors"]', picker).innerHTML = p.variants.map((x) => swatchHtml(x.title, `data-action="gal-color" data-id="${x.id}"`, x.id === v.id)).join('');
    $('[data-bind="gal-views"]', picker).innerHTML = photos.map((x, k) =>
      `<button class="thumb" data-action="gal-view" data-k="${k}" aria-pressed="${k === gal.view}" aria-label="${esc(x.label)}"><img src="${esc(x.thumb)}" alt=""></button>`).join('');
  }

  /* ---------------- 360 spin ---------------- */
  function spinController(el) {
    if (el._spin) return el._spin;
    const key = el.dataset.spin, frames = data.media[key].frames, n = frames.length;
    const img = $('img', el), dot = $('[data-bind="spin-dot"]', el.closest('.page'));
    let idx = 0, auto = null, dragging = false, x0 = 0, i0 = 0, interacted = false, loaded = false;
    const cache = [];
    const show = (i) => {
      idx = ((i % n) + n) % n;
      img.src = frames[idx];
      if (dot) dot.style.left = `${(idx / (n - 1)) * 100}%`;
    };
    const stopAuto = () => { clearInterval(auto); auto = null; };
    const markInteracted = () => { if (!interacted) { interacted = true; track('spin_interact', { media: key }); } };
    // StPageFlip starts a page fold on mousedown/touchstart; keep those from reaching it
    const block = (e) => e.stopPropagation();
    el.addEventListener('mousedown', block);
    el.addEventListener('touchstart', block, { passive: true });
    el.addEventListener('pointerdown', (e) => {
      dragging = true; x0 = e.clientX; i0 = idx;
      el.classList.add('dragging');
      try { el.setPointerCapture(e.pointerId); } catch { /* not supported */ }
      stopAuto(); markInteracted();
    });
    el.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const per = el.clientWidth / n;   // dragging the full width turns it once
      show(i0 + Math.round((e.clientX - x0) / per));
    });
    const end = () => { dragging = false; el.classList.remove('dragging'); };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el._spin = {
      preload() { if (loaded) return; loaded = true; frames.forEach((f, i) => { cache[i] = new Image(); cache[i].src = f; }); },
      startAuto() { if (!auto && !interacted) auto = setInterval(() => show(idx + 1), 110); },
      stopAuto,
      step(d) { stopAuto(); markInteracted(); show(idx + d); },
      get index() { return idx; },
    };
    return el._spin;
  }

  /* ---------------- film overlay (one video across a whole spread) ---------------- */
  function showFilm(key) {
    const m = data.media[key], wrap = $('#spread-media'), video = $('#film');
    const sec = (cfg.sections || []).find((s) => s.media === key) || {};
    wrap.classList.toggle('portrait', pageFlip.getOrientation() === 'portrait');
    if (video.dataset.key !== key) { video.dataset.key = key; video.poster = m.poster; video.src = m.video; }
    $('#film-caption').textContent = `${sec.caption || sec.eyebrow || 'Film'} · ${dur(m.duration)}`;
    if (wrap.hidden) {
      wrap.hidden = false;
      wrap.classList.remove('show'); void wrap.offsetWidth; wrap.classList.add('show');
    }
    video.muted = !filmUnmuted;
    $('#btn-sound').hidden = filmUnmuted;
    const pr = video.play();
    if (pr && pr.catch) pr.catch(() => {});
    if (!filmTracked) { filmTracked = true; track('film_play', { media: key }); }
  }
  function hideFilm() {
    const wrap = $('#spread-media');
    if (wrap.hidden) return;
    $('#film').pause();
    wrap.hidden = true;
  }

  /* ---------------- navigation and page events ---------------- */
  function visiblePages(i) {
    const n = pageMeta.length;
    if (pageFlip.getOrientation() === 'portrait') return [i];
    if (i <= 0) return [0];
    const s = i % 2 === 1 ? i : i - 1;
    return [s, s + 1].filter((x) => x < n);
  }

  // `flipState` comes from the changeState event: StPageFlip fires that event before it updates its
  // own state, so pageFlip.getState() still says "flipping" when the turn has just finished.
  function syncMedia(vis, flipState = pageFlip.getState()) {
    pageEls.forEach((el, idx) => {
      const on = vis.includes(idx);
      const v = $('video.page-video', el);
      if (v) {
        if (on) {
          if (!v.getAttribute('src') && v.dataset.src) v.src = v.dataset.src;
          const pr = v.play();
          if (pr && pr.catch) pr.catch(() => {});
        } else if (!v.paused) v.pause();
      }
      const sp = $('.spin', el);
      if (sp) { const c = spinController(sp); if (on) { c.preload(); c.startAuto(); } else c.stopAuto(); }
      if (on && pageMeta[idx] && pageMeta[idx].handle) warmPhotos(pageMeta[idx].handle);
    });
    if (vis.some((idx) => pageMeta[idx] && pageMeta[idx].type === 'gallery')) data.products.forEach((p) => warmPhotos(p.handle));
    const filmIdx = vis.find((idx) => pageEls[idx] && pageEls[idx].dataset.film);
    if (filmIdx !== undefined && flipState === 'read') showFilm(pageEls[filmIdx].dataset.film);
    else hideFilm();
  }

  function onPage(i) {
    const vis = visiblePages(i);
    centerClosedBook(i);
    pageEls.forEach((el, idx) => {
      if (vis.includes(idx)) { if (!shownSet.has(idx)) el.classList.add('is-shown'); }
      else el.classList.remove('is-shown');
    });
    shownSet = new Set(vis);

    const meta = pageMeta[vis[0]] || {}, n = pageMeta.length;
    const range = vis.length > 1 ? `${vis[0] + 1}-${vis[1] + 1}` : `${vis[0] + 1}`;
    let label = meta.label || '';
    if (meta.handle) {
      const k = data.products.findIndex((p) => p.handle === meta.handle);
      label = `${byHandle[meta.handle].title} · ${k + 1} of ${data.products.length}`;
    }
    $('#page-status').innerHTML = `<b>${esc(label)}</b> &nbsp; ${range} / ${n}`;
    $('#track-fill').style.width = `${((vis[vis.length - 1] + 1) / n) * 100}%`;
    $('#btn-prev').disabled = vis[0] === 0;
    $('#btn-next').disabled = vis[vis.length - 1] >= n - 1;
    syncMedia(vis);

    track('catalog_page_view', { page_index: vis[0], page_type: meta.type, product: meta.handle || undefined });
    if (meta.handle) {
      const p = byHandle[meta.handle], v = state[meta.handle].variant;
      track('view_item', { ecommerce: { currency: 'USD', value: v.price, items: [gaItem(p, v)] } });
    }
  }

  function centerClosedBook(i) {
    const landscape = pageFlip.getOrientation() === 'landscape';
    const pw = pageFlip.getBoundsRect().pageWidth;
    let shift = 0;
    if (landscape && i === 0) shift = -pw / 2;
    else if (landscape && i >= pageMeta.length - 1) shift = pw / 2;
    book.style.transform = shift ? `translateX(${shift.toFixed(1)}px)` : '';
  }

  /* StPageFlip draws hard pages and aims its own arrow "clicks" as if the book touched the top-left
     of its box, so the box is sized to exactly the pages and centered by us. */
  const PAGE_RATIO = 550 / 733;
  function layoutBook() {
    const stage = $('.stage');
    const W = stage.clientWidth - 24, H = stage.clientHeight - 16;
    const pwL = Math.min(W / 2, H * PAGE_RATIO), pwP = Math.min(W, H * PAGE_RATIO);
    const landscape = pwL >= 450 || pwL >= 0.6 * pwP;
    const pw = Math.max(120, Math.floor(landscape ? pwL : pwP));
    const ph = Math.ceil(pw / PAGE_RATIO);
    const bw = landscape ? pw * 2 : pw;
    const box = { width: `${bw}px`, height: `${ph}px`, left: `${Math.round((stage.clientWidth - bw) / 2)}px`, top: `${Math.round((stage.clientHeight - ph) / 2)}px` };
    Object.assign(book.style, box);
    Object.assign($('#spread-media').style, box);   // the film overlay sits exactly over the open spread
    if (pageFlip) {
      const s = pageFlip.getSettings();
      s.minWidth = pw * 0.9;   // landscape when the box holds two pages, portrait when it holds one
      s.maxWidth = 5000;
    }
    return { landscape, pw };
  }
  function relayout() {
    layoutBook();
    if (!pageFlip) return;
    pageFlip.update();
    onPage(pageFlip.getCurrentPageIndex());
  }
  // The library's arrow helpers only fire when its synthetic click lands on a page corner, which
  // fails in portrait; lift the click guard just for our own buttons and keys.
  function withFlipGuardOff(fn) {
    const s = pageFlip.getSettings(), keep = s.disableFlipByClick;
    s.disableFlipByClick = false;
    try { fn(); } finally { s.disableFlipByClick = keep; }
  }
  const turn = (dir) => withFlipGuardOff(() => (dir > 0 ? pageFlip.flipNext() : pageFlip.flipPrev()));
  const goPage = (n) => withFlipGuardOff(() => pageFlip.flip(n));

  function gotoProduct(handle) {
    const idx = pageMeta.findIndex((m) => m.type === 'shot' && m.handle === handle);
    if (idx >= 0) goPage(idx);
  }

  function onBookClick(e) {
    const t = e.target.closest('[data-action]');
    if (!t || !book.contains(t)) return;
    const { action, handle } = t.dataset;
    const s = handle ? state[handle] : null;
    switch (action) {
      case 'goto': e.preventDefault(); gotoProduct(handle); break;
      case 'opt': e.preventDefault(); selectOption(handle, Number(t.dataset.k), t.dataset.val); break;
      case 'qty': e.preventDefault(); setQty(handle, Number(t.dataset.d)); break;
      case 'view': s.view = Number(t.dataset.k); render(handle); break;
      case 'photos': {
        const v = s.variant;
        openLightbox(photosFor(v), s.view, `${byHandle[handle].title}, ${v.title}`);
        break;
      }
      case 'add': addToBag(s.variant, s.qty); break;
      case 'add-variant': { const f = findVariantById(Number(t.dataset.variant)); if (f) addToBag(f.v, 1); break; }
      case 'buy': {
        const v = s.variant;
        if (!v.available) break;
        t.href = cartUrl([{ id: v.id, qty: s.qty }]);
        track('begin_checkout', { ecommerce: { currency: 'USD', value: v.price * s.qty, items: [gaItem(byHandle[handle], v, s.qty)] }, cart_url: t.href, booth });
        if (booth && cfg.booth?.buyOnPhone !== false) { e.preventDefault(); showCheckoutQR([{ id: v.id, qty: s.qty }]); }
        break;
      }
      case 'gal-school': gal.handle = handle; gal.variantId = byHandle[handle].variants[0].id; gal.view = 0; renderGallery(); break;
      case 'gal-color': gal.variantId = Number(t.dataset.id); gal.view = 0; renderGallery(); break;
      case 'gal-view': gal.view = Number(t.dataset.k); renderGallery(); break;
      case 'gal-open': { const v = galVariant(); openLightbox(photosFor(v), gal.view, `${byHandle[gal.handle].title}, ${v.title}`); break; }
      case 'gal-shop': {
        const v = galVariant(), st = state[gal.handle];
        st.sel = v.options.slice(); st.variant = v; st.view = 0;
        render(gal.handle);
        gotoProduct(gal.handle);
        break;
      }
      case 'spin-step': { const sp = $('.spin', t.closest('.page')); if (sp) spinController(sp).step(Number(t.dataset.d)); break; }
      case 'details': track('view_details', { product: handle }); break;
      case 'contact': track('catalog_contact_click', { method: t.dataset.method }); break;
      default: break;
    }
  }

  /* ---------------- modal, toast ---------------- */
  function openModal(html) {
    const m = $('#modal');
    $('#modal-body').innerHTML = html;
    m.classList.remove('closing');
    m.hidden = false;
  }
  function closeModal() {
    const m = $('#modal');
    if (m.hidden) return;
    m.classList.add('closing');
    setTimeout(() => { m.hidden = true; m.classList.remove('closing'); }, 140);
  }
  let toastTimer;
  function toast(msg, opts = {}) {
    const t = $('#toast'), b = $('#toast-action');
    $('#toast-text').textContent = msg;
    if (opts.action) {
      b.textContent = opts.action;
      b.hidden = false;
      b.onclick = () => { t.hidden = true; opts.onAction(); };
    } else b.hidden = true;
    t.hidden = true; void t.offsetWidth; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, opts.ms || 3600);
  }
  function showShare() {
    const url = shareUrl();
    track('catalog_qr_open', { url });
    openModal(`
      <h3>${esc(cfg.share?.heading || 'Take this catalog with you')}</h3>
      <p>${esc(cfg.share?.body || 'Scan to open it on your phone.')}</p>
      <div class="qr-box">${qrSvg(url)}</div>
      <div class="mono">${esc(url)}</div>
      ${isLocalUrl(url) ? '<p class="note">Local preview: this code points at this computer. Set catalogUrl in the catalog file once it is hosted.</p>' : ''}
      <div class="row"><button class="btn ghost" data-modal="copy">Copy link</button><button class="btn" data-modal="close">Done</button></div>`);
  }

  /* ---------------- full screen, booth mode ---------------- */
  const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement;
  function requestFs() {
    const el = document.documentElement;
    const fn = el.requestFullscreen || el.webkitRequestFullscreen;
    if (!fn) return;
    try { const r = fn.call(el); if (r && r.catch) r.catch(() => {}); } catch { /* not allowed here */ }
  }
  function exitFs() {
    const fn = document.exitFullscreen || document.webkitExitFullscreen;
    if (fsElement() && fn) { try { const r = fn.call(document); if (r && r.catch) r.catch(() => {}); } catch { /* ignore */ } }
  }
  async function keepAwake() {
    try { if ('wakeLock' in navigator && booth) wakeLock = await navigator.wakeLock.request('screen'); } catch { /* unsupported */ }
  }

  let boothFs = false;   // booth mode went full screen, so leaving full screen (Esc) leaves booth mode
  function enterBooth(fromGesture) {
    booth = true;
    document.body.classList.add('booth');
    if (fromGesture) {
      requestFs();
      setTimeout(() => { boothFs = booth && !!fsElement(); }, 800);
    }
    keepAwake();
    resetIdle();
    relayout();
    renderBag();
    track('booth_mode', { on: true });
    toast('Booth mode on. Checkout shows a QR code. Press and hold "Hold to exit" to leave.', { ms: 4500 });
  }
  function exitBooth() {
    booth = false;
    boothFs = false;
    document.body.classList.remove('booth');
    $('#start-overlay').hidden = true;
    clearTimeout(idleTimer);
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
    exitFs();
    relayout();
    saveBag();
    renderBag();
    track('booth_mode', { on: false });
    toast('Booth mode off');
  }
  function resetIdle() {
    clearTimeout(idleTimer);
    if (!booth) return;
    const secs = Math.max(15, cfg.booth?.idleSeconds || 90);
    idleTimer = setTimeout(() => {
      closeModal(); closeLightbox(); closeBag();
      bag = []; renderBag();                       // the next visitor starts with an empty bag
      const film = $('#film'); film.pause(); try { film.currentTime = 0; } catch { /* not loaded */ }
      filmUnmuted = false;
      $('#start-overlay').hidden = false;
      if (pageFlip.getCurrentPageIndex() !== 0) pageFlip.turnToPage(0);   // instant; the attract screen covers it
      track('booth_idle_reset');
    }, secs * 1000);
  }

  function wireChrome() {
    $('#btn-prev').addEventListener('click', () => turn(-1));
    $('#btn-next').addEventListener('click', () => turn(1));
    $('#btn-contents').addEventListener('click', () => goPage(2));
    $('#btn-share').addEventListener('click', showShare);
    $('#btn-fullscreen').addEventListener('click', () => (fsElement() ? exitFs() : requestFs()));
    $('#btn-booth').addEventListener('click', () => enterBooth(true));
    $('#btn-bag').addEventListener('click', openBag);
    $('#bag').addEventListener('click', onBagClick);
    $('#track').addEventListener('click', (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      const target = Math.round(((e.clientX - r.left) / r.width) * (pageMeta.length - 1));
      goPage(Math.max(0, Math.min(pageMeta.length - 1, target)));
    });

    const hold = $('#btn-exit-booth');
    let holdTimer;
    const startHold = (e) => { e.preventDefault(); hold.classList.add('holding'); holdTimer = setTimeout(() => { hold.classList.remove('holding'); exitBooth(); }, 1500); };
    const stopHold = () => { hold.classList.remove('holding'); clearTimeout(holdTimer); };
    hold.addEventListener('pointerdown', startHold);
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => hold.addEventListener(ev, stopHold));

    $('#start-overlay').addEventListener('click', () => {
      $('#start-overlay').hidden = true;
      if (!booth) enterBooth(true); else { requestFs(); resetIdle(); }
    });

    $('#modal').addEventListener('click', (e) => {
      const m = e.target.closest('[data-modal]');
      if (e.target.id === 'modal' || e.target.id === 'modal-close' || (m && m.dataset.modal === 'close')) closeModal();
      else if (m && m.dataset.modal === 'copy') {
        navigator.clipboard?.writeText(shareUrl()).then(() => toast('Link copied'), () => toast('Copy not allowed here'));
      }
    });

    $('#lightbox').addEventListener('click', (e) => {
      const t = e.target.closest('[data-lb]');
      if (!t) return;
      if (t.dataset.lb === 'close') closeLightbox();
      if (t.dataset.lb === 'prev') lbStep(-1);
      if (t.dataset.lb === 'next') lbStep(1);
      if (t.dataset.lb === 'go') { lb.k = Number(t.dataset.k); renderLightbox(); }
    });
    let lbX = null;
    $('#lb-figure').addEventListener('pointerdown', (e) => { lbX = e.clientX; });
    $('#lb-figure').addEventListener('pointerup', (e) => { if (lbX !== null && Math.abs(e.clientX - lbX) > 50) lbStep(e.clientX < lbX ? 1 : -1); lbX = null; });

    // the film overlay covers the spread, so a sideways swipe on it turns the page
    const sm = $('#spread-media');
    let smX = null, smY = null;
    sm.addEventListener('pointerdown', (e) => { smX = e.clientX; smY = e.clientY; });
    sm.addEventListener('pointerup', (e) => {
      if (smX !== null && Math.abs(e.clientX - smX) > 70 && Math.abs(e.clientY - smY) < 60) turn(e.clientX < smX ? 1 : -1);
      smX = null;
    });
    $('#btn-sound').addEventListener('click', () => {
      const v = $('#film');
      filmUnmuted = true; v.muted = false;
      const pr = v.play(); if (pr && pr.catch) pr.catch(() => {});
      $('#btn-sound').hidden = true;
      track('film_unmute');
    });
    $('#film').addEventListener('volumechange', (e) => { if (!e.target.muted) { filmUnmuted = true; $('#btn-sound').hidden = true; } });

    document.addEventListener('keydown', (e) => {
      if (!$('#lightbox').hidden) {
        if (e.key === 'Escape') closeLightbox();
        if (e.key === 'ArrowRight') lbStep(1);
        if (e.key === 'ArrowLeft') lbStep(-1);
        return;
      }
      if (e.key === 'Escape') { closeModal(); closeBag(); }
      if (!$('#modal').hidden || !$('#bag').hidden) return;
      if (e.key === 'ArrowRight') turn(1);
      if (e.key === 'ArrowLeft') turn(-1);
    });
    ['pointerdown', 'keydown', 'touchstart', 'wheel'].forEach((ev) => document.addEventListener(ev, resetIdle, { capture: true, passive: true }));
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') keepAwake(); });
    const onFsChange = () => { if (booth && boothFs && !fsElement()) exitBooth(); };
    document.addEventListener('fullscreenchange', onFsChange);
    document.addEventListener('webkitfullscreenchange', onFsChange);
    book.addEventListener('click', onBookClick);
  }

  /* ---------------- live refresh (only when served from the store's own domain) ---------------- */
  async function liveRefresh() {
    let storeOrigin;
    try { storeOrigin = new URL(cfg.store).origin; } catch { return; }
    if (location.origin !== storeOrigin) return;    // corbeau.com sends no CORS headers, so only same-origin works
    for (const p of data.products) {
      try {
        const j = await (await fetch(`/products/${p.handle}.js`)).json();
        for (const v of p.variants) {
          const lv = j.variants.find((x) => x.id === v.id);
          if (lv) { v.price = lv.price / 100; v.available = !!lv.available; }
        }
        render(p.handle);
      } catch { /* keep the snapshot */ }
    }
  }

  /* ---------------- start ---------------- */
  async function start() {
    try {
      const r = await fetch(`data/${CATALOG_ID}.json`, { cache: 'no-cache' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      data = await r.json();
    } catch (err) {
      $('#loading').innerHTML = `Could not load data/${esc(CATALOG_ID)}.json (${esc(err.message)}).<br>Serve this folder over http, for example: python tools/serve.py`;
      return;
    }
    cfg = data.config;
    data.media = data.media || {};
    applyTheme(cfg.theme);
    document.title = cfg.title;
    $('#catalog-name').textContent = cfg.title;
    loadGTM(cfg.analytics?.gtmId);

    for (const p of data.products) {
      byHandle[p.handle] = p;
      const v = p.variants.find((x) => x.available) || p.variants[0];
      state[p.handle] = { sel: v.options.slice(), qty: 1, variant: v, view: 0 };
    }
    gal.handle = data.products[0].handle;
    gal.variantId = data.products[0].variants[0].id;
    buildPages();
    data.products.forEach((p) => render(p.handle));
    renderGallery();
    loadBag();
    renderBag();

    const first = layoutBook();
    pageFlip = new St.PageFlip(book, {
      width: 550, height: 733, size: 'stretch',
      minWidth: first.pw * 0.9, maxWidth: 5000, minHeight: 100, maxHeight: 5000,
      showCover: true, usePortrait: true, autoSize: false,
      maxShadowOpacity: 0.45, flippingTime: 750, drawShadow: true,
      mobileScrollSupport: false, clickEventForward: true, disableFlipByClick: true,
      showPageCorners: true, swipeDistance: 30,
    });
    pageFlip.loadFromHTML(pageEls);
    pageFlip.on('flip', (e) => onPage(e.data));
    pageFlip.on('changeOrientation', () => onPage(pageFlip.getCurrentPageIndex()));
    pageFlip.on('changeState', (e) => {
      if (e.data === 'flipping' || e.data === 'user_fold') { book.style.transform = ''; hideFilm(); }
      if (e.data === 'read') syncMedia(visiblePages(pageFlip.getCurrentPageIndex()), 'read');
    });
    window.addEventListener('resize', () => requestAnimationFrame(relayout));
    wireChrome();
    $('#loading').remove();
    track('catalog_view', { products: data.products.length, built: data.generatedAt });
    onPage(0);

    if (params.get('booth') === '1') $('#start-overlay').hidden = false;
    liveRefresh();

    // for checks from the console or a test harness
    window.corbeauCatalog = { data, state, pageFlip, pageMeta, pageEls, gotoProduct, selectOption, cartUrl, enterBooth, exitBooth,
      turn, goPage, addToBag, openBag, openLightbox, getBag: () => bag.slice(), gal, renderGallery };
  }

  start();
})();
