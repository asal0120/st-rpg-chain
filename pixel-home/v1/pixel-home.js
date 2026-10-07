/* 家園像素場景：在主檔的 map-area 裡顯示房間場景與角色。
 * 本檔不讀寫變數。主檔的轉接程式先讀好資料，再呼叫 PixelHome.render(mapArea, ctx, host)：
 *   ctx  = { location, hour, present: [角色名], joined: [已攻略角色名], seed }
 *   host = {
 *     navigate(target),                        點門：前往該地點
 *     chooseExit({ title, options }),          點樓梯：主檔顯示選單；options = [{ dir: 'up' | 'down', target }]
 *     showCharacter(name | null),              點角色：主檔顯示立繪與選單；null = 取消選取
 *   }
 *   主檔的立繪面板自己關閉時，呼叫 PixelHome.deselect(mapArea) 取消角色的選取外框。
 *   沒有提供 chooseExit / showCharacter 時，改用場景內的小選單（host.openStatus、host.talk）。
 * 操作：滑鼠移到門上會顯示目的地，點一下就前往；觸控沒有滑鼠移入，所以第一下只顯示目的地，同一個門再點一下才前往。
 * 素材（房間資料、場景圖、遮罩、角色圖）放在 PixelHome.base 底下，由 publish.py 產生。
 * 介面說明見 notes.md「像素家園：接入主檔」。 */
(function () {
  'use strict';
  const VERSION = '1.2.0';
  if (window.PixelHome && window.PixelHome.version === VERSION) return;

  // 地點 → 房間資料夾
  const ROOMS = { '客厅': 'living', '浴室': 'bath', '厨房饭厅': 'kitchen', '交谊厅': 'lounge' };
  // 樓梯：同一座樓梯的上樓與下樓出口（渲染腳本的 exit、exitDown）合併成一個點擊範圍，點擊後顯示選單。
  // options 的 target 可以是主檔的選單節點（例如 地下室），由主檔展開成該樓層的房間
  const STAIRS = {
    living: { exits: ['交谊厅', '地下室'], options: [{ dir: 'up', target: '交谊厅' }, { dir: 'down', target: '地下室' }] },
    lounge: { exits: ['三楼', '客厅'],
              options: [{ dir: 'up', target: '书房' }, { dir: 'up', target: '工房' }, { dir: 'down', target: '客厅' }] },
  };
  // 角色圖的副檔名（publish.py 轉成無損 WebP）
  const SPRITE_EXT = 'webp';
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
/* 顯示出口範圍：白色半透明＋金色外框（外框讓範圍邊界清楚，觸控時特別需要） */
.ph-root .ph-exit.ph-on { opacity: .55;
  filter: drop-shadow(var(--px) 0 0 #ffcc66) drop-shadow(calc(var(--px) * -1) 0 0 #ffcc66)
          drop-shadow(0 var(--px) 0 #ffcc66) drop-shadow(0 calc(var(--px) * -1) 0 #ffcc66); }
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
      const imgs = {};
      // sprites.json 和角色圖同時下載
      const [meta] = await Promise.all([fetchJson(base + 'sprites.json'), ...HEROES.flatMap(h => [h.key, h.sit]).map(async key => {
        try {
          const img = await loadImg(`${base}sprites/${key}.${SPRITE_EXT}`);
          imgs[key] = { img, mask: alphaMask(img) };
        } catch (e) { /* 沒有這張圖 */ }
      })]);
      return { facing: meta.facing || {}, imgs };
    });
  }

  // 房間資料（只有 room.json）：拿到後就可以開始下載場景圖
  function loadRoomData(id) {
    const dir = PixelHome.base + id + '/';
    return once('roomdata:' + dir, async () => ({ id, dir, data: await fetchJson(dir + 'room.json') }));
  }

  // 房間資料＋出口遮罩（點擊判定用）
  function loadRoom(id) {
    return once('room:' + PixelHome.base + id, async () => {
      const room = await loadRoomData(id);
      const exits = await Promise.all((room.data.exits || []).map(async e => {
        const img = await loadImg(room.dir + 'exits/' + e.mask);
        return { ...e, src: img.src, mask: alphaMask(img) };
      }));
      return { ...room, exits };
    });
  }

  // 條件家具的旗標：已攻略角色的 key 中，房間有差分的那些
  function flagsFor(room, joinedNames) {
    const joined = new Set((joinedNames || []).map(n => HERO_BY_NAME.get(n)?.key).filter(Boolean));
    return new Set((room.data.variants || []).filter(v => joined.has(v)));
  }

  // 場景圖：開啟的旗標中第一個（旗標的組合沒有另外渲染）
  function sceneFor(room, t, flags) {
    const want = TIME_SCENE[t];
    const has = (room.data.times || ['day']).includes(want);
    const f = (room.data.variants || []).find(v => flags.has(v));
    return { url: `${room.dir}scene_${has ? want : 'day'}${f ? '_' + f : ''}.${room.data.sceneExt || 'png'}`,
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

  // 觸控放開後，瀏覽器還會在同一個位置送出一次 click。這時選單或立繪面板已經打開，
  // click 會落在選項上造成誤觸（例如直接選了樓梯選單的第一個房間），所以吃掉這一次 click。
  function swallowNextClick() {
    const eat = e => { e.stopPropagation(); e.preventDefault(); done(); };
    const done = () => { document.removeEventListener('click', eat, true); clearTimeout(timer); };
    const timer = setTimeout(done, 600);
    document.addEventListener('click', eat, true);
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
      this.sceneEl.crossOrigin = 'anonymous';   // 畫面上的圖片和 loadImg 用同一個模式，才會共用已下載的檔案
      this.stage.appendChild(this.sceneEl);
      this.tint = document.createElement('div');
      this.tint.className = 'ph-tint';
      this.root.append(this.stage, this.tint);
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
      const flags = flagsFor(room, ctx.joined);
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
      this.closeMenu(); this.setHover(null); this.armed = null;
      this.exits.forEach(e => e.parts.forEach(p => p.el.remove()));
      // 每個出口 = 一個或多個遮罩（parts）；樓梯的上下樓出口合併成一個
      const stair = STAIRS[room.id];
      const groups = [];
      for (const e of room.exits) {
        const el = document.createElement('img');
        el.className = 'ph-exit'; el.alt = ''; el.crossOrigin = 'anonymous'; el.src = e.src;
        place(el, e.x, e.y, e.w, e.h);
        this.stage.appendChild(el);
        const part = { x: e.x, y: e.y, w: e.w, h: e.h, mask: e.mask, el };
        if (stair && stair.exits.includes(e.name)) {
          let g = groups.find(g => g.stair);
          if (!g) groups.push(g = { name: '楼梯', stair: true, options: stair.options, parts: [] });
          g.parts.push(part);
        } else {
          groups.push({ name: e.name, parts: [part] });
        }
      }
      for (const g of groups) {   // 外框範圍（標籤與選單的位置）
        g.x = Math.min(...g.parts.map(p => p.x)); g.y = Math.min(...g.parts.map(p => p.y));
        g.w = Math.max(...g.parts.map(p => p.x + p.w)) - g.x; g.h = Math.max(...g.parts.map(p => p.y + p.h)) - g.y;
      }
      this.exits = groups;
    }

    buildActors(sprites, present, flags, seed) {
      this.deselect();   // 角色重新排位：取消選取（主檔的立繪面板也會關閉）
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
        sp.crossOrigin = 'anonymous'; sp.src = data.img.src; sp.className = 'ph-spr'; sp.alt = hero.name;
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
        for (const p of e.parts) {
          const lx = Math.floor(ix - p.x), ly = Math.floor(iy - p.y);
          if (lx < 0 || ly < 0 || lx >= p.w || ly >= p.h) continue;
          if (!p.mask || p.mask[ly * p.w + lx]) return { type: 'exit', e };
        }
      }
      return null;
    }

    showTag(hit) {
      if (this.tagEl) this.tagEl.remove();
      this.tagEl = null; this.tagFor = hit;
      if (!hit || (hit.type === 'actor' && (this.picked === hit.a || (this.sel && this.sel.a === hit.a)))) return;
      const el = document.createElement('div');
      let x, y;
      if (hit.type === 'actor') {
        [x, y] = this.toMap(hit.a.sx, hit.a.top - 4);
        el.className = 'ph-tag'; el.textContent = hit.a.hero.name;
      } else {
        const e = hit.e;
        [x, y] = this.toMap(e.x + e.w / 2, e.y - 2);
        el.className = 'ph-tag ph-tag-exit';
        el.textContent = (e.stair ? e.name : '前往 ' + e.name) + (this.armed === e ? '（再点一次）' : '');
      }
      el.style.left = x + 'px'; el.style.top = Math.max(22, y) + 'px';
      this.root.appendChild(el);
      this.tagEl = el;
    }
    setHover(hit) {
      const cur = this.hover;
      const same = hit && cur && hit.type === cur.type && (hit.a || hit.e) === (cur.a || cur.e);
      if (same || (!hit && !cur)) return;
      if (cur) {
        if (cur.type === 'actor') cur.a.el.classList.remove('ph-hover');
        else cur.e.parts.forEach(p => p.el.classList.remove('ph-on'));
      }
      this.hover = hit;
      if (hit) {
        if (hit.type === 'actor') hit.a.el.classList.add('ph-hover');
        else hit.e.parts.forEach(p => p.el.classList.add('ph-on'));
      }
      this.showTag(hit);
    }
    // 觸控第一下點到的出口（再點一次才前往）
    disarm() {
      if (!this.armed) return;
      this.armed = null;
      if (this.hover && this.hover.type === 'exit') this.setHover(null);
    }

    // 角色選取（主檔顯示立繪面板）：選取外框保留到取消選取為止
    selectActor(a) {
      this.deselect(true);
      this.picked = a;
      a.el.classList.add('ph-sel');
      this.showTag(null);
      this.host.showCharacter(a.hero.name);
    }
    // silent = 不通知主檔（主檔自己關閉面板時用）
    deselect(silent) {
      if (!this.picked) return;
      this.picked.el.classList.remove('ph-sel');
      this.picked = null;
      if (!silent && this.host.showCharacter) this.host.showCharacter(null);
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

    onTap(clientX, clientY, pointerType) {
      const hit = this.hitTest(clientX, clientY);
      const host = this.host;
      if (!hit || hit.type !== 'exit') this.disarm();
      if (!hit) { this.closeMenu(); this.deselect(); return; }
      if (hit.type === 'exit') {
        const e = hit.e;
        // 觸控沒有滑鼠移入：第一下只顯示目的地與範圍，同一個出口再點一下才前往
        if (pointerType !== 'mouse' && this.armed !== e) {
          this.closeMenu();
          this.armed = e;
          this.setHover(hit);
          this.showTag(hit);
          return;
        }
        this.disarm(); this.closeMenu();
        if (!e.stair) { if (host.navigate) host.navigate(e.name); return; }
        if (host.chooseExit) { host.chooseExit({ title: e.name, options: e.options }); return; }
        this.openMenu(e.name, e.options.map(o => [(o.dir === 'up' ? '▲ ' : '▼ ') + o.target,
                                                  () => host.navigate && host.navigate(o.target)]),
                      { type: 'exit', left: e.x, top: e.y, w: e.w });
        return;
      }
      const a = hit.a;
      if (host.showCharacter) {   // 主檔顯示立繪與選單；再點同一個角色 = 取消選取
        this.closeMenu();
        if (this.picked === a) this.deselect(); else this.selectActor(a);
        return;
      }
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
            drag.moved = true; root.classList.add('ph-dragging'); this.closeMenu(); this.armed = null; this.setHover(null);
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
          if (!drag.moved && e.type === 'pointerup') {
            if (e.pointerType !== 'mouse') swallowNextClick();
            this.onTap(e.clientX, e.clientY, e.pointerType);
          }
          drag = null;
          root.classList.remove('ph-dragging');
        }
      };
      root.addEventListener('pointerup', end);
      root.addEventListener('pointercancel', end);
      root.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse' && !drag) this.setHover(null); });
      // 滾輪：滑鼠在場景上時直接縮放（這時聊天頁面不會跟著捲動）
      root.addEventListener('wheel', e => {
        e.preventDefault();
        const r = root.getBoundingClientRect();
        this.zoomStep(e.deltaY < 0 ? 1 : -1, e.clientX - r.left, e.clientY - r.top);
      }, { passive: false });
    }
  }

  // ---------------- 對外介面 ----------------
  const instances = new WeakMap();

  function has(location) { return !!ROOMS[location]; }

  // 取消角色選取（主檔的立繪面板自己關閉時呼叫；不會再通知主檔）
  function deselect(mapArea) {
    const sc = mapArea && instances.get(mapArea);
    if (sc) sc.deselect(true);
  }

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
    // 拿到 room.json 就開始下載場景圖，和出口遮罩、角色圖同時進行
    const sceneEarly = loadRoomData(id)
      .then(room => loadImg(sceneFor(room, period(ctx.hour), flagsFor(room, ctx.joined)).url))
      .catch(() => {});   // 失敗時由 update() 回報
    const p = Promise.all([loadRoom(id), loadSprites(), sceneEarly])
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

  // 背景預載：房間資料、出口遮罩、角色圖、目前時段的場景圖、坐位的前景遮罩。
  // 下載後存在瀏覽器快取，之後每則訊息的 iframe 都能直接使用。joined = 已攻略角色名（決定條件家具的版本）
  function preload(location, hour, joined) {
    const id = ROOMS[location];
    if (!id) return Promise.resolve(false);
    return Promise.all([loadRoom(id), loadSprites()])
      .then(([room]) => Promise.all([
        loadImg(sceneFor(room, period(hour), flagsFor(room, joined)).url),
        ...(room.data.seats || []).filter(s => s.mask).map(s => loadImg(room.dir + 'masks/' + s.mask.file)),
      ]))
      .then(() => true, () => false);
  }

  const PixelHome = window.PixelHome = {
    version: VERSION,
    base: 'https://cdn.jsdelivr.net/gh/asal0120/st-rpg-chain@main/pixel-home/v1/',
    locations: Object.keys(ROOMS),   // 有像素場景的地點
    has, render, clear, preload, deselect,
  };
})();
