/* 家園像素場景：在主檔的 map-area 裡顯示房間場景與角色。
 * 本檔不讀寫變數。主檔的轉接程式先讀好資料，再呼叫 PixelHome.render(mapArea, ctx, host)：
 *   ctx  = { location, hour, present: [角色名], joined: [已攻略角色名], seed }
 *   host = { navigate(target), openStatus(name), talk(name) }（talk 可省略）
 * 素材（房間資料、場景圖、遮罩、角色圖）放在 PixelHome.base 底下，由 publish.py 產生。
 * 介面說明見 notes.md「像素家園：接入主檔」。 */
(function () {
  'use strict';
  const VERSION = '1.0.0';
  if (window.PixelHome && window.PixelHome.version === VERSION) return;

  // 地點 → 房間資料夾
  const ROOMS = { '客厅': 'living', '浴室': 'bath', '厨房饭厅': 'kitchen', '交谊厅': 'lounge' };
  // 一個出口通往多個地點時，點擊後顯示選單
  const MULTI_EXITS = { '三楼': ['书房', '工房'] };
  // key = 角色圖檔名，也是條件家具的旗標（例如璐法加入後的豎琴 = lufa）；prefer = 偏好朝向
  const HEROES = [
    { key: 'aina', name: '爱娜', prefer: 'R' }, { key: 'lin', name: '琳', prefer: 'L' },
    { key: 'miralune', name: '米拉露恩', prefer: 'L' }, { key: 'daphne', name: '黛芬妮' },
    { key: 'freya', name: '芙蕾嘉', prefer: 'L' }, { key: 'sui', name: '穗', prefer: 'L' },
    { key: 'lydia', name: '莉迪娅' }, { key: 'lufa', name: '璐法' }, { key: 'nefti', name: '奈芙蒂', prefer: 'R' },
  ].map(h => ({ ...h, sit: h.key + '_sit' }));
  const HERO_BY_NAME = new Map(HEROES.map(h => [h.name, h]));
  // 主人在場時以這個機率坐上專屬坐位
  const OWN_SEAT_CHANCE = 0.5;
  // 坐或站：每位能坐的角色依權重抽選，坐 = SEAT_WEIGHT × 空坐位數，站 = 空站位數
  const SEAT_WEIGHT = 3;
  // 可以自由選擇朝向時，有偏好的角色朝偏好方向的機率
  const PREFER_WEIGHT = 0.7;
  // 預設鏡頭：角色在畫面上約 110 CSS px 高；最近時約 280 CSS px
  const DEFAULT_CHAR_PX = 110, MAX_CHAR_PX = 280;

  // 時段（分界與主檔 syncGameState 的晝夜遮罩相同）
  function period(hour) {
    const h = Number.isFinite(+hour) ? +hour : 12;
    if (h >= 5 && h < 7) return 'dawn';
    if (h >= 7 && h < 17) return 'day';
    if (h >= 17 && h < 19) return 'dusk';
    if (h >= 19 && h < 24) return 'night';
    return 'late';
  }
  const DAYNIGHT = {
    dawn: ['rgba(255, 220, 150, 0.3)', 'soft-light'],
    day: ['rgba(0, 0, 0, 0)', 'normal'],
    dusk: ['rgba(150, 50, 100, 0.25)', 'multiply'],
    night: ['rgba(0, 10, 40, 0.5)', 'multiply'],
    late: ['rgba(0, 5, 20, 0.65)', 'multiply'],
  };
  // 時段 → 場景圖版本（房間沒有這個版本時，用白天圖＋DAYNIGHT 的顏色遮罩）
  const TIME_SCENE = { dawn: 'dusk', day: 'day', dusk: 'dusk', night: 'night', late: 'night' };
  const TIME_EXTRA = { late: ['rgba(0, 5, 20, 0.35)', 'multiply'] };   // 深夜：夜晚圖再暗一點
  const NO_TINT = ['rgba(0, 0, 0, 0)', 'normal'];

  // ---------------- CSS（每個頁面只加一次，全部在 .ph-root 底下） ----------------
  const CSS = `
.ph-root { position: absolute; inset: 0; z-index: 20; overflow: hidden; background: #1c1916; isolation: isolate;
  user-select: none; -webkit-user-select: none; touch-action: none; cursor: grab; visibility: hidden; }
.ph-root.ph-ready { visibility: visible; }
.ph-root.ph-dragging { cursor: grabbing; }
.ph-root .ph-stage { position: absolute; left: 0; top: 0; }
.ph-root .ph-stage.ph-crisp img { image-rendering: pixelated; }
.ph-root .ph-stage img { display: block; -webkit-user-drag: none; max-width: none; }
.ph-root .ph-scene { position: absolute; left: 0; top: 0; width: 100%; height: 100%; }
.ph-root .ph-actor, .ph-root .ph-shadow, .ph-root .ph-exit { position: absolute; pointer-events: none; }
.ph-root .ph-spr { animation: ph-bob var(--dur) steps(1, end) infinite; animation-delay: var(--delay); }
@keyframes ph-bob { 0% { transform: translateY(0); } 50% { transform: translateY(calc(var(--px) * -2)); } }
.ph-root .ph-actor.ph-sit .ph-spr { animation-name: ph-bob-sit; }
@keyframes ph-bob-sit { 0% { transform: translateY(0); } 50% { transform: translateY(calc(var(--px) * -1)); } }
.ph-root .ph-clip { position: absolute; }
.ph-root .ph-fg { position: absolute; pointer-events: none; background-image: var(--scene); background-repeat: no-repeat;
  background-size: calc(var(--px) * var(--scene-w)) calc(var(--px) * var(--scene-h)); image-rendering: pixelated;
  mask-size: 100% 100%; -webkit-mask-size: 100% 100%; mask-repeat: no-repeat; -webkit-mask-repeat: no-repeat; }
.ph-root .ph-actor.ph-hover .ph-spr, .ph-root .ph-actor.ph-sel .ph-spr {
  filter: drop-shadow(calc(var(--px) * 2) 0 0 #fff3d0) drop-shadow(calc(var(--px) * -2) 0 0 #fff3d0)
          drop-shadow(0 calc(var(--px) * 2) 0 #fff3d0) drop-shadow(0 calc(var(--px) * -2) 0 #fff3d0); }
.ph-root .ph-exit { opacity: 0; transition: opacity .12s; z-index: 8; }
.ph-root .ph-exit.ph-on { opacity: .35; }
.ph-root .ph-tint { position: absolute; inset: 0; pointer-events: none; z-index: 900; }
.ph-root .ph-stage[data-t="dawn"] .ph-actor, .ph-root .ph-stage[data-t="dusk"] .ph-actor { filter: sepia(.22) saturate(1.1) brightness(.93); }
.ph-root .ph-stage[data-t="night"] .ph-actor { filter: brightness(.8) saturate(.85) sepia(.12); }
.ph-root .ph-stage[data-t="late"] .ph-actor { filter: brightness(.72) saturate(.8) sepia(.12); }
.ph-root .ph-tag { position: absolute; z-index: 960; transform: translate(-50%, -100%); padding: 1px 6px; font-size: 11px;
  line-height: 1.5; background: rgba(20, 16, 13, .88); border: 1px solid #5a4a3a; color: #fff3d0; white-space: nowrap;
  pointer-events: none; }
.ph-root .ph-tag.ph-tag-exit { color: #ffcc66; }
.ph-root .ph-menu { position: absolute; z-index: 970; min-width: 112px; background: rgba(24, 19, 15, .96);
  border: 1px solid #8a734b; box-shadow: 0 2px 8px rgba(0, 0, 0, .5); padding: 4px; cursor: default; }
.ph-root .ph-menu .ph-mt { font-size: 12px; color: #ffcc66; padding: 2px 6px 4px; border-bottom: 1px solid #5a4a3a;
  margin-bottom: 3px; }
.ph-root .ph-menu button { display: block; width: 100%; text-align: left; background: none; border: 0; color: #ebe3d6;
  padding: 5px 8px; font-size: 13px; cursor: pointer; font-family: inherit; }
.ph-root .ph-menu button:hover { background: rgba(255, 204, 102, .14); }
.ph-root .ph-zoom { position: absolute; right: 6px; bottom: 6px; z-index: 950; display: flex; flex-direction: column; gap: 3px; }
.ph-root .ph-zoom button { width: 26px; height: 26px; padding: 0; font-size: 16px; line-height: 1; cursor: pointer;
  background: rgba(20, 16, 13, .8); border: 1px solid #5a4a3a; color: #f3e6cc; font-family: inherit; }
.ph-root .ph-zoom button:hover { border-color: #ffcc66; color: #ffcc66; }
`;
  function ensureStyle() {
    if (document.getElementById('ph-style')) return;
    const st = document.createElement('style');
    st.id = 'ph-style';
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  // ---------------- 素材載入（同一個頁面只載入一次） ----------------
  const cache = new Map();
  function once(key, fn) {
    if (!cache.has(key)) cache.set(key, fn().catch(e => { cache.delete(key); throw e; }));
    return cache.get(key);
  }
  function loadImg(url) {
    return once('img:' + url, () => new Promise((res, rej) => {
      const i = new Image();
      i.crossOrigin = 'anonymous';   // 點擊判定要讀像素
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('圖片載入失敗：' + url));
      i.src = url;
    }));
  }
  async function fetchJson(url) {
    const r = await fetch(url, { mode: 'cors' });
    if (!r.ok) throw new Error(`HTTP ${r.status}：${url}`);
    return r.json();
  }

  // 取 alpha 遮罩做逐像素點擊判定（讀不到像素時改用方框判定）
  function alphaMask(img) {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    try {
      const d = g.getImageData(0, 0, c.width, c.height).data;
      const m = new Uint8Array(c.width * c.height);
      for (let i = 0; i < m.length; i++) m[i] = d[i * 4 + 3] > 127 ? 1 : 0;
      return m;
    } catch (e) { return null; }
  }

  // 角色圖：缺圖的角色不顯示；缺坐姿圖的角色只會站著
  function loadSprites() {
    const base = PixelHome.base;
    return once('sprites:' + base, async () => {
      const meta = await fetchJson(base + 'sprites.json');
      const imgs = {};
      await Promise.all(HEROES.flatMap(h => [h.key, h.sit]).map(async key => {
        try {
          const img = await loadImg(`${base}sprites/${key}.png`);
          imgs[key] = { img, mask: alphaMask(img) };
        } catch (e) { /* 沒有這張圖 */ }
      }));
      return { facing: meta.facing || {}, imgs };
    });
  }

  function loadRoom(id) {
    const dir = PixelHome.base + id + '/';
    return once('room:' + dir, async () => {
      const data = await fetchJson(dir + 'room.json');
      const exits = await Promise.all((data.exits || []).map(async e => {
        const img = await loadImg(dir + 'exits/' + e.mask);
        return { ...e, src: img.src, mask: alphaMask(img) };
      }));
      return { id, dir, data, exits };
    });
  }

  // 場景圖：開啟的旗標中第一個（旗標的組合沒有另外渲染）
  function sceneFor(room, t, flags) {
    const want = TIME_SCENE[t];
    const has = (room.data.times || ['day']).includes(want);
    const f = (room.data.variants || []).find(v => flags.has(v));
    return { url: `${room.dir}scene_${has ? want : 'day'}${f ? '_' + f : ''}.png`,
             tint: has ? (TIME_EXTRA[t] || NO_TINT) : DAYNIGHT[t] };
  }

  // ---------------- 工具 ----------------
  // 可重現的亂數：同一個種子（同一則訊息）排位不變
  function mulberry32(a) {
    a = Math.imul(a ^ (a >>> 16), 0x45d9f3b); a = Math.imul(a ^ (a >>> 16), 0x45d9f3b); a ^= a >>> 16;   // 打散相鄰的種子
    return () => {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function seedNum(seed) {
    if (Number.isFinite(+seed)) return +seed | 0;
    let h = 0;
    for (const ch of String(seed ?? '')) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193);
    return h;
  }

  // 像素橢圓影子
  const shadowCache = {};
  function shadowURL(w, h) {
    const k = w + 'x' + h;
    if (shadowCache[k]) return shadowCache[k];
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.fillStyle = 'rgba(25, 14, 8, 0.38)';
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const dx = (x + 0.5 - w / 2) / (w / 2), dy = (y + 0.5 - h / 2) / (h / 2);
      if (dx * dx + dy * dy <= 1) g.fillRect(x, y, 1, 1);
    }
    return (shadowCache[k] = c.toDataURL());
  }

  function place(el, x, y, w, h) {
    el.style.left = `calc(var(--px) * ${x})`;
    el.style.top = `calc(var(--px) * ${y})`;
    if (w != null) el.style.width = `calc(var(--px) * ${w})`;
    if (h != null) el.style.height = `calc(var(--px) * ${h})`;
  }

  // 角色適不適合某個位置：只能朝一邊時，偏好相同 > 沒有偏好 > 偏好相反；位置有角色權重時再乘上倍數
  function fitWeight(hero, slot) {
    const w = (slot.weights && slot.weights[hero.key]) || 1;
    if (slot.faces.length !== 1 || !hero.prefer) return 0.5 * w;
    return (hero.prefer === slot.faces[0] ? PREFER_WEIGHT : 1 - PREFER_WEIGHT) * w;
  }

  // 把角色分配到位置（數量相同）：先處理有角色權重的位置，再處理只能朝一邊的位置
  function assign(heroes, slots, rng) {
    const left = heroes.slice(), out = [];
    const order = slots.map((_, i) => i).sort((a, b) =>
      (!!slots[b].weights - !!slots[a].weights) || (slots[a].faces.length - slots[b].faces.length));
    for (const i of order) {
      const ws = left.map(h => fitWeight(h, slots[i]));
      let r = rng() * ws.reduce((a, b) => a + b, 0), k = 0;
      while (k < ws.length - 1 && r >= ws[k]) r -= ws[k++];
      out.push({ hero: left[k], slot: slots[i] });
      left.splice(k, 1);
    }
    return out;
  }

  function chooseFace(hero, faces, rng) {
    if (faces.length === 1) return faces[0];
    const main = hero.prefer || 'R';
    return rng() < (hero.prefer ? PREFER_WEIGHT : 0.5) ? main : (main === 'L' ? 'R' : 'L');
  }

  // ---------------- 場景（每個 map-area 一個） ----------------
  class Scene {
    constructor(mapArea) {
      this.mapArea = mapArea;
      this.host = {};
      this.token = 0;
      this.room = null;
      this.actors = []; this.exits = [];
      this.hover = null; this.sel = null;
      this.view = { scale: 1, ox: 0, oy: 0 };
      this.lastSize = null;
      this.root = document.createElement('div');
      this.root.className = 'ph-root';
      this.stage = document.createElement('div');
      this.stage.className = 'ph-stage ph-crisp';
      this.sceneEl = document.createElement('img');
      this.sceneEl.className = 'ph-scene'; this.sceneEl.alt = '';
      this.stage.appendChild(this.sceneEl);
      this.tint = document.createElement('div');
      this.tint.className = 'ph-tint';
      const zoom = document.createElement('div');
      zoom.className = 'ph-zoom';
      for (const [label, dir, title] of [['+', 1, '拉近'], ['−', -1, '拉遠']]) {
        const b = document.createElement('button');
        b.type = 'button'; b.textContent = label; b.title = title;
        b.addEventListener('pointerdown', e => e.stopPropagation());
        b.addEventListener('click', e => { e.stopPropagation(); this.zoomStep(dir); });
        zoom.appendChild(b);
      }
      this.root.append(this.stage, this.tint, zoom);
      mapArea.appendChild(this.root);
      this.bindEvents();
      this.ro = new ResizeObserver(() => this.onResize());
      this.ro.observe(this.root);
    }

    destroy() {
      this.destroyed = true;
      this.token++;
      this.ro.disconnect();
      this.root.remove();
    }

    async update(room, sprites, ctx, token) {
      const joined = new Set((ctx.joined || []).map(n => HERO_BY_NAME.get(n)?.key).filter(Boolean));
      const flags = new Set((room.data.variants || []).filter(v => joined.has(v)));
      const present = (ctx.present || []).map(n => HERO_BY_NAME.get(n)).filter(Boolean);
      const t = period(ctx.hour);
      const scene = sceneFor(room, t, flags);
      await loadImg(scene.url);   // 先載入，換圖時不會閃白
      if (token !== this.token) return;
      const roomChanged = this.room !== room;
      if (roomChanged) this.setRoom(room);
      if (this.sceneEl.getAttribute('src') !== scene.url) {
        this.sceneEl.src = scene.url;
        this.stage.style.setProperty('--scene', `url("${scene.url}")`);   // 前景遮罩用同一張場景圖
      }
      this.tint.style.backgroundColor = scene.tint[0];
      this.tint.style.mixBlendMode = scene.tint[1];
      this.stage.dataset.t = t;   // 角色依時段調色
      const actorKey = JSON.stringify([present.map(h => h.key), [...flags], ctx.seed]);
      if (roomChanged || actorKey !== this.actorKey) {
        this.actorKey = actorKey;
        this.buildActors(sprites, present, flags, seedNum(ctx.seed));
      }
      if (roomChanged) this.resetView();
      this.root.classList.add('ph-ready');
    }

    setRoom(room) {
      this.room = room;
      const [w, h] = room.data.image;
      this.imgW = w; this.imgH = h;
      this.actorH = room.data.actorPx.heightPx;
      this.stage.style.setProperty('--scene-w', w);
      this.stage.style.setProperty('--scene-h', h);
      this.closeMenu(); this.setHover(null);
      this.exits.forEach(e => e.el.remove());
      this.exits = room.exits.map(e => {
        const el = document.createElement('img');
        el.className = 'ph-exit'; el.alt = ''; el.src = e.src;
        place(el, e.x, e.y, e.w, e.h);
        this.stage.appendChild(el);
        return { ...e, el };
      });
    }

    buildActors(sprites, present, flags, seed) {
      this.actors.forEach(a => { a.el.remove(); if (a.fg) a.fg.remove(); });
      this.actors = [];
      this.hover = null;
      this.closeMenu();
      const R = this.room.data, imgs = sprites.imgs;
      const spots = R.spots.map(s => ({ pos: [s.x, s.y], faces: s.faces || ['L', 'R'], weights: s.weights || null }));
      const seats = (R.seats || []).map(s => ({ ...s, pos: [s.x, s.y], faces: s.faces || ['L', 'R'] }));
      const rng = mulberry32(seed);
      const heroes = present.filter(h => imgs[h.key]);
      const placed = [];
      const seatIdx = seats.map((_, i) => i).filter(i => !seats[i].when || flags.has(seats[i].when));
      for (const i of seatIdx.filter(i => seats[i].only)) {   // 專屬坐位：主人在場時不一定坐上去
        const hero = heroes.find(h => h.key === seats[i].only);
        if (hero && imgs[hero.sit] && rng() < OWN_SEAT_CHANCE)
          placed.push({ hero, key: hero.sit, pos: seats[i].pos, faces: seats[i].faces, sitting: true, seat: i });
      }
      const open = seatIdx.filter(i => !seats[i].only);
      const canSit = heroes.filter(h => imgs[h.sit] && !placed.some(p => p.hero === h));
      for (let k = canSit.length - 1; k > 0; k--) { const j = Math.floor(rng() * (k + 1)); [canSit[k], canSit[j]] = [canSit[j], canSit[k]]; }
      let freeSeats = open.length;
      let freeSpots = spots.length - (heroes.length - placed.length - canSit.length);   // 不能坐的角色先佔站位
      const sitters = [];
      for (const h of canSit) {
        const ws = SEAT_WEIGHT * freeSeats;
        if (freeSeats > 0 && (freeSpots <= 0 || rng() * (ws + freeSpots) < ws)) { sitters.push(h); freeSeats--; }
        else freeSpots--;
      }
      for (let k = open.length - 1; k > 0; k--) { const j = Math.floor(rng() * (k + 1)); [open[k], open[j]] = [open[j], open[k]]; }
      assign(sitters, open.slice(0, sitters.length).map(i => ({ pos: seats[i].pos, faces: seats[i].faces, seat: i })), rng)
        .forEach(({ hero, slot }) => placed.push({ hero, key: hero.sit, pos: slot.pos, faces: slot.faces, sitting: true, seat: slot.seat }));
      const standers = heroes.filter(h => !placed.some(p => p.hero === h));
      assign(standers.slice(0, spots.length), spots.slice(0, Math.min(standers.length, spots.length)), rng)
        .forEach(({ hero, slot }) => placed.push({ hero, key: hero.key, pos: slot.pos, faces: slot.faces, sitting: false }));

      for (const { hero, key, pos, faces, sitting, seat } of placed) {
        const data = imgs[key];
        const meta = seat != null ? seats[seat] : null;
        // 腳泡在水裡的坐位：角色圖下方（水面以下）裁掉
        const clip = meta ? Math.round((meta.submerge || 0) * R.pxPerMeterVertical) : 0;
        const face = chooseFace(hero, faces, rng);
        const flip = face !== (sprites.facing[key] || 'R');
        const [sx, sy] = pos;
        const w = data.img.naturalWidth, h = data.img.naturalHeight;
        const left = Math.round(sx - w / 2), top = Math.round(sy) - h;
        const el = document.createElement('div');
        el.className = 'ph-actor' + (sitting ? ' ph-sit' : '');
        el.style.zIndex = 10 + Math.round(sy);
        place(el, 0, 0);
        if (!sitting) {   // 坐著時腳懸空，不畫地面影子
          const sw = Math.round(w * 0.55), shh = Math.round(sw * 0.28);
          const sh = document.createElement('img');
          sh.src = shadowURL(sw, shh); sh.className = 'ph-shadow'; sh.alt = '';
          place(sh, Math.round(sx - sw / 2), Math.round(sy - shh / 2), sw, shh);
          el.append(sh);
        }
        const sp = document.createElement('img');
        sp.src = data.img.src; sp.className = 'ph-spr'; sp.alt = hero.name;
        sp.style.position = 'absolute';
        if (flip) sp.style.scale = '-1 1';   // 獨立的 scale 屬性：不會和晃動動畫的 transform 互相覆蓋
        sp.style.setProperty('--dur', (1.0 + Math.random() * 0.6).toFixed(2) + 's');
        sp.style.setProperty('--delay', (-Math.random() * 1.5).toFixed(2) + 's');
        if (clip) {   // 裁切放在不會晃動的外框上：水面線固定
          const box = document.createElement('div');
          box.className = 'ph-clip';
          place(box, left, top, w, h);
          box.style.clipPath = `inset(0 0 calc(var(--px) * ${clip}) 0)`;
          place(sp, 0, 0, w, h);
          box.append(sp);
          el.append(box);
        } else {
          place(sp, left, top, w, h);
          el.append(sp);
        }
        this.stage.appendChild(el);
        // 坐在桌子後方的坐位：前景遮罩疊在角色上方
        let fg = null;
        if (meta && meta.mask) {
          const m = meta.mask;
          fg = document.createElement('div');
          fg.className = 'ph-fg';
          place(fg, m.x, m.y, m.w, m.h);
          fg.style.backgroundPosition = `calc(var(--px) * ${-m.x}) calc(var(--px) * ${-m.y})`;
          const url = `url("${this.room.dir}masks/${m.file}")`;
          fg.style.maskImage = fg.style.webkitMaskImage = url;
          fg.style.zIndex = el.style.zIndex;
          this.stage.appendChild(fg);
        }
        this.actors.push({ hero, el, fg, left, top, w, h, sx, sy, mask: data.mask, flip, clip });
      }
      this.actors.sort((a, b) => b.sy - a.sy);   // 前面的先判定
    }

    // ---------------- 鏡頭 ----------------
    mapSize() { const r = this.root.getBoundingClientRect(); return [r.width, r.height]; }
    fitScale() { const [w, h] = this.mapSize(); return Math.min(w / this.imgW, h / this.imgH) || 1; }
    scaleRange() { const a = this.fitScale(); return [a, Math.max(a * 1.01, MAX_CHAR_PX / this.actorH)]; }
    snapScale(s) {
      const dpr = window.devicePixelRatio || 1, d = s * dpr;
      return d < 1 ? s : Math.round(d) / dpr;   // 小於 1 倍時不對齊（縮小顯示整個房間）
    }
    clampView() {
      const [mw, mh] = this.mapSize(), v = this.view;
      const sw = this.imgW * v.scale, sh = this.imgH * v.scale;
      v.ox = sw <= mw ? (mw - sw) / 2 : Math.min(0, Math.max(mw - sw, v.ox));
      v.oy = sh <= mh ? (mh - sh) / 2 : Math.min(0, Math.max(mh - sh, v.oy));
      const dpr = window.devicePixelRatio || 1;
      v.ox = Math.round(v.ox * dpr) / dpr;   // 對齊裝置像素，避免半格模糊
      v.oy = Math.round(v.oy * dpr) / dpr;
    }
    applyView() {
      if (!this.room) return;
      this.clampView();
      const v = this.view, st = this.stage.style;
      st.transform = `translate(${v.ox}px, ${v.oy}px)`;
      st.width = this.imgW * v.scale + 'px';
      st.height = this.imgH * v.scale + 'px';
      st.setProperty('--px', v.scale + 'px');
      this.stage.classList.toggle('ph-crisp', v.scale * (window.devicePixelRatio || 1) >= 1);
      if (this.sel) this.positionMenu();
      if (this.tagFor) this.showTag(this.tagFor);
    }
    // 鏡頭對準在場角色的中心（沒有角色時對準房間中心）
    resetView() {
      const [a, b] = this.scaleRange();
      const dpr = window.devicePixelRatio || 1;
      this.view.scale = this.snapScale(Math.max(a, Math.min(b, Math.max(DEFAULT_CHAR_PX / this.actorH, 1 / dpr))));
      let fx = this.imgW / 2, fy = this.imgH / 2;
      if (this.actors.length) {
        fx = this.actors.reduce((s, a) => s + a.sx, 0) / this.actors.length;
        fy = this.actors.reduce((s, a) => s + a.sy - a.h / 2, 0) / this.actors.length;
      }
      const [mw, mh] = this.mapSize();
      this.view.ox = mw / 2 - fx * this.view.scale;
      this.view.oy = mh / 2 - fy * this.view.scale;
      this.lastSize = [mw, mh];
      this.applyView();
    }
    // 以畫框內 (cx, cy) 為中心縮放
    zoomTo(s, cx, cy) {
      const [a, b] = this.scaleRange();
      s = this.snapScale(Math.max(a, Math.min(b, s)));
      if (cx == null) { const [mw, mh] = this.mapSize(); cx = mw / 2; cy = mh / 2; }
      const v = this.view;
      const ax = (cx - v.ox) / v.scale, ay = (cy - v.oy) / v.scale;
      v.scale = s;
      v.ox = cx - ax * s; v.oy = cy - ay * s;
      this.applyView();
    }
    // 一次一段：整數倍時加減 1 倍；小於 1 倍時直接跳到整個房間
    zoomStep(dir, cx, cy) {
      const dpr = window.devicePixelRatio || 1, d = this.view.scale * dpr;
      let s;
      if (d >= 0.999) { const n = Math.max(1, Math.round(d)) + dir; s = n < 1 ? this.fitScale() : n / dpr; }
      else s = dir > 0 ? 1 / dpr : this.fitScale();
      this.zoomTo(s, cx, cy);
    }
    onResize() {
      if (!this.room) return;
      const [mw, mh] = this.mapSize();
      if (!mw || !mh) return;
      const v = this.view;
      if (this.lastSize) {   // 保持畫框中心看到的位置不變
        const ax = (this.lastSize[0] / 2 - v.ox) / v.scale, ay = (this.lastSize[1] / 2 - v.oy) / v.scale;
        const [a, b] = this.scaleRange();
        v.scale = this.snapScale(Math.max(a, Math.min(b, v.scale)));
        v.ox = mw / 2 - ax * v.scale; v.oy = mh / 2 - ay * v.scale;
      }
      this.lastSize = [mw, mh];
      this.applyView();
    }

    // ---------------- 點擊判定 ----------------
    toArt(clientX, clientY) {
      const r = this.root.getBoundingClientRect(), v = this.view;
      return [(clientX - r.left - v.ox) / v.scale, (clientY - r.top - v.oy) / v.scale];
    }
    toMap(x, y) { return [this.view.ox + x * this.view.scale, this.view.oy + y * this.view.scale]; }
    hitTest(clientX, clientY) {
      const [ix, iy] = this.toArt(clientX, clientY);
      for (const a of this.actors) {
        let lx = Math.floor(ix - a.left);
        const ly = Math.floor(iy - a.top);
        if (lx < 0 || ly < 0 || lx >= a.w || ly >= a.h - a.clip) continue;   // 水面以下點不到
        if (a.flip) lx = a.w - 1 - lx;
        if (!a.mask || a.mask[ly * a.w + lx]) return { type: 'actor', a };
      }
      for (const e of this.exits) {
        const lx = Math.floor(ix - e.x), ly = Math.floor(iy - e.y);
        if (lx < 0 || ly < 0 || lx >= e.w || ly >= e.h) continue;
        if (!e.mask || e.mask[ly * e.w + lx]) return { type: 'exit', e };
      }
      return null;
    }

    showTag(hit) {
      if (this.tagEl) this.tagEl.remove();
      this.tagEl = null; this.tagFor = hit;
      if (!hit || (hit.type === 'actor' && this.sel === hit.a)) return;
      const el = document.createElement('div');
      let x, y;
      if (hit.type === 'actor') {
        [x, y] = this.toMap(hit.a.sx, hit.a.top - 4);
        el.className = 'ph-tag'; el.textContent = hit.a.hero.name;
      } else {
        [x, y] = this.toMap(hit.e.x + hit.e.w / 2, hit.e.y - 2);
        el.className = 'ph-tag ph-tag-exit'; el.textContent = '前往 ' + hit.e.name;
      }
      el.style.left = x + 'px'; el.style.top = Math.max(22, y) + 'px';
      this.root.appendChild(el);
      this.tagEl = el;
    }
    setHover(hit) {
      const cur = this.hover;
      const same = hit && cur && hit.type === cur.type && (hit.a || hit.e) === (cur.a || cur.e);
      if (same || (!hit && !cur)) return;
      if (cur) (cur.type === 'actor' ? cur.a.el : cur.e.el).classList.remove(cur.type === 'actor' ? 'ph-hover' : 'ph-on');
      this.hover = hit;
      if (hit) (hit.type === 'actor' ? hit.a.el : hit.e.el).classList.add(hit.type === 'actor' ? 'ph-hover' : 'ph-on');
      this.showTag(hit);
    }

    closeMenu() {
      if (this.menuEl) this.menuEl.remove();
      this.menuEl = null;
      if (this.sel && this.sel.el) this.sel.el.classList.remove('ph-sel');
      this.sel = null;
    }
    // 選單：items = [[文字, 動作], ...]；anchor = 選單旁邊的場景範圍
    openMenu(title, items, anchor) {
      this.closeMenu();
      const menu = document.createElement('div');
      menu.className = 'ph-menu';
      const mt = document.createElement('div');
      mt.className = 'ph-mt'; mt.textContent = title;
      menu.appendChild(mt);
      for (const [label, fn] of items) {
        const b = document.createElement('button');
        b.type = 'button'; b.textContent = label;
        b.onclick = e => { e.stopPropagation(); this.closeMenu(); fn(); };
        menu.appendChild(b);
      }
      menu.addEventListener('pointerdown', e => e.stopPropagation());
      menu.addEventListener('pointerup', e => e.stopPropagation());
      this.root.appendChild(menu);
      this.menuEl = menu;
      this.sel = anchor;
      if (anchor.el && anchor.type === 'actor') anchor.el.classList.add('ph-sel');
      this.positionMenu();
      this.showTag(null);
    }
    positionMenu() {
      const menu = this.menuEl, a = this.sel;
      if (!menu || !a) return;
      const [mw, mh] = this.mapSize(), w = menu.offsetWidth, h = menu.offsetHeight;
      let [x, y] = this.toMap(a.left + a.w + 2, a.top + 10);
      if (x + w > mw - 4) x = this.toMap(a.left - 2, 0)[0] - w;
      menu.style.left = Math.max(4, Math.min(mw - w - 4, x)) + 'px';
      menu.style.top = Math.max(4, Math.min(mh - h - 4, y)) + 'px';
    }

    onTap(clientX, clientY) {
      const hit = this.hitTest(clientX, clientY);
      if (!hit) { this.closeMenu(); return; }
      const host = this.host;
      if (hit.type === 'exit') {
        const e = hit.e, targets = MULTI_EXITS[e.name];
        if (!targets) { this.closeMenu(); if (host.navigate) host.navigate(e.name); return; }
        this.openMenu(e.name, targets.map(t => [t, () => host.navigate && host.navigate(t)]),
                      { type: 'exit', left: e.x, top: e.y, w: e.w });
        return;
      }
      const a = hit.a;
      if (this.sel && this.sel.a === a) { this.closeMenu(); return; }
      const items = [];
      if (host.talk) items.push(['交谈', () => host.talk(a.hero.name)]);
      if (host.openStatus) items.push(['查看状态', () => host.openStatus(a.hero.name)]);
      this.openMenu(a.hero.name, items, { type: 'actor', a, el: a.el, left: a.left, top: a.top, w: a.w });
    }

    // ---------------- 拖動與縮放手勢 ----------------
    bindEvents() {
      const root = this.root, pointers = new Map();
      let drag = null, pinch = null;
      root.addEventListener('pointerdown', e => {
        try { root.setPointerCapture(e.pointerId); } catch (err) { /* 合成事件沒有可擷取的指標 */ }
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pointers.size === 1) {
          drag = { x: e.clientX, y: e.clientY, ox: this.view.ox, oy: this.view.oy, moved: false };
        } else if (pointers.size === 2) {
          const [p, q] = [...pointers.values()];
          const r = root.getBoundingClientRect();
          pinch = { dist: Math.hypot(p.x - q.x, p.y - q.y), scale: this.view.scale,
                    cx: (p.x + q.x) / 2 - r.left, cy: (p.y + q.y) / 2 - r.top };
          if (drag) drag.moved = true;
        }
      });
      root.addEventListener('pointermove', e => {
        if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pinch && pointers.size >= 2) {
          const [p, q] = [...pointers.values()];
          this.zoomTo(pinch.scale * Math.hypot(p.x - q.x, p.y - q.y) / pinch.dist, pinch.cx, pinch.cy);
          return;
        }
        if (drag && pointers.size === 1) {
          const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
          if (!drag.moved && Math.hypot(dx, dy) > 6) {
            drag.moved = true; root.classList.add('ph-dragging'); this.closeMenu(); this.setHover(null);
          }
          if (drag.moved) { this.view.ox = drag.ox + dx; this.view.oy = drag.oy + dy; this.applyView(); }
          return;
        }
        if (e.pointerType === 'mouse') {
          const hit = this.hitTest(e.clientX, e.clientY);
          this.setHover(hit);
          root.style.cursor = hit ? 'pointer' : '';
        }
      });
      const end = e => {
        pointers.delete(e.pointerId);
        if (pinch && pointers.size === 1) {   // 雙指放開一指：以剩下那一指重設拖動起點
          const [p] = pointers.values();
          drag = { x: p.x, y: p.y, ox: this.view.ox, oy: this.view.oy, moved: true };
        }
        if (pointers.size < 2) pinch = null;
        if (drag && pointers.size === 0) {
          if (!drag.moved && e.type === 'pointerup') this.onTap(e.clientX, e.clientY);
          drag = null;
          root.classList.remove('ph-dragging');
        }
      };
      root.addEventListener('pointerup', end);
      root.addEventListener('pointercancel', end);
      root.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse' && !drag) this.setHover(null); });
      // 滾輪：只有按住 Ctrl 時縮放，一般滾動留給聊天頁面
      root.addEventListener('wheel', e => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        const r = root.getBoundingClientRect();
        this.zoomStep(e.deltaY < 0 ? 1 : -1, e.clientX - r.left, e.clientY - r.top);
      }, { passive: false });
    }
  }

  // ---------------- 對外介面 ----------------
  const instances = new WeakMap();

  function has(location) { return !!ROOMS[location]; }

  function clear(mapArea) {
    const sc = mapArea && instances.get(mapArea);
    if (!sc) return;
    sc.destroy();
    instances.delete(mapArea);
  }

  // 回傳 Promise<boolean>：false = 沒有場景或載入失敗，主檔照舊顯示背景圖與方向按鈕。
  // 連續呼叫時，較早的呼叫會等最後一次的結果。
  function render(mapArea, ctx, host) {
    const id = ctx && ROOMS[ctx.location];
    if (!mapArea || !id) { clear(mapArea); return Promise.resolve(false); }
    ensureStyle();
    let sc = instances.get(mapArea);
    if (!sc || !sc.root.isConnected) {
      if (sc) sc.destroy();
      sc = new Scene(mapArea);
      instances.set(mapArea, sc);
    }
    sc.host = host || {};
    const token = ++sc.token;
    // 被較新的呼叫取代時等它的結果；場景已清除時回傳 false
    const latest = () => (sc.destroyed || sc.current === p ? false : sc.current);
    const p = Promise.all([loadRoom(id), loadSprites()])
      .then(([room, sprites]) => token === sc.token && sc.update(room, sprites, ctx, token))
      .then(() => (token === sc.token ? true : latest()))
      .catch(err => {
        if (token !== sc.token) return latest();
        console.warn('[PixelHome] 場景載入失敗：', err);
        clear(mapArea);
        return false;
      });
    sc.current = p;
    return p;
  }

  // 背景預載：房間資料、角色圖、目前時段的場景圖
  function preload(location, hour) {
    const id = ROOMS[location];
    if (!id) return Promise.resolve(false);
    return Promise.all([loadRoom(id), loadSprites()])
      .then(([room]) => loadImg(sceneFor(room, period(hour), new Set()).url))
      .then(() => true, () => false);
  }

  const PixelHome = window.PixelHome = {
    version: VERSION,
    base: 'https://cdn.jsdelivr.net/gh/asal0120/st-rpg-chain@main/pixel-home/v1/',
    has, render, clear, preload,
  };
})();
