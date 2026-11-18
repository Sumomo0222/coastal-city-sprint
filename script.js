/* ============================================================
   海风城市冲刺 COASTAL CITY SPRINT
   伪3D跑酷：手动透视投影 + DOM/SVG 实体池
   0-300m 海滨公路 → 300-700m 城市高架 → 700-1000m 灯牌街区
   1000m 终点拱门 · 无框架 · 无外部素材 · 可直接静态部署
   ============================================================ */
'use strict';

/* ---------------- 小工具 ---------------- */
const $ = (s) => document.querySelector(s);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const mod = (a, b) => ((a % b) + b) % b;
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const SVG_NS = 'http://www.w3.org/2000/svg';

/* ---------------- 世界常量（单位：米） ---------------- */
const LANES_X = [-2.4, 0, 2.4];
const ROAD_HALF = 4.3;
const SHOULDER_W = 0.55;
const SAND_OUT = 14;
const SEA_OUT = 200;
const CAM_H = 3.1;
const PLAYER_Z = 1.7;
const SPAWN_Z = 95;
const FAR_Z = 70;
const KILL_Z = 0.55;
const FINISH_M = 1000;
const START_SPEED = 11.5;
const MAX_SPEED = 20;
const SPEED_PER_M = 0.0075;          // 随距离轻微提速
const JUMP_V = 7.6;
const GRAVITY = 20;
const BARRIER_CLEAR_Y = 0.62;
const CURVE_A = 3.0;                 // 道路视觉弯曲幅度
const ATTRACT_SPEED = 6;

/* ---------------- DOM ---------------- */
const sceneEl = $('#scene');
const worldEnt = $('#entities');
const worldScn = $('#scenery');
const playerWrap = $('#player-wrap');
const playerEl = $('#player');
const pShadow = $('#p-shadow');
const roadSvg = $('#road-svg');
const hudEl = $('#hud');
const hudDist = $('#hud-dist');
const hudCoin = $('#hud-coin');
const hudCoinBox = $('#hud-coin-box');
const hudSpeed = $('#hud-speed');
const hudTime = $('#hud-time');
const hudStage = $('#hud-stage');
const progFill = $('#prog-fill');
const progTrack = document.querySelector('.prog-track');
const hintEl = $('#hint');
const controlsEl = $('#controls');
const overlayStart = $('#overlay-start');
const overlayFail = $('#overlay-fail');
const overlayWin = $('#overlay-win');
const bannerEl = $('#stage-banner');
const bannerText = $('#stage-banner-text');
const confettiBox = $('#confetti');
const skyASvg = $('#sky-a-svg');
const skyBSvg = $('#sky-b-svg');
const skyCSvg = $('#sky-c-svg');

/* ---------------- 音效（WebAudio 合成） ---------------- */
const AudioSys = {
  ctx: null,
  muted: false,
  ensure() {
    if (!this.ctx) {
      try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { /* 无音频环境 */ }
    }
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  },
  tone(freq, dur, type = 'sine', vol = 0.1, slide = 0, delay = 0) {
    if (this.muted || !this.ctx) return;
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.ctx.destination);
    o.start(t);
    o.stop(t + dur + 0.03);
  },
  coin()  { this.tone(880, .09, 'sine', .09); this.tone(1318, .12, 'sine', .09, 0, .05); },
  jump()  { this.tone(170, .18, 'square', .05, 260); },
  lane()  { this.tone(300, .05, 'square', .03); },
  crash() { this.tone(150, .42, 'sawtooth', .14, -110); this.tone(58, .5, 'triangle', .12, -20); },
  start() { this.tone(523, .12, 'sine', .07); this.tone(784, .2, 'sine', .07, 0, .11); },
  stage() { this.tone(659, .12, 'triangle', .08); this.tone(988, .18, 'triangle', .08, 0, .1); },
  finish() {
    [523, 659, 784, 1046].forEach((f, i) => this.tone(f, .22, 'triangle', .1, 0, i * .13));
    this.tone(1318, .5, 'sine', .08, 0, .55);
  }
};

/* ---------------- 视口与投影 ---------------- */
let W = 0, H = 0, cx = 0, horizonY = 0, FOCAL = 0, G = 0, zBot = 1;
let SLICES = [];
const polyEls = {};

function layout() {
  const r = sceneEl.getBoundingClientRect();
  W = r.width; H = r.height; cx = W / 2;
  horizonY = H * 0.40;
  FOCAL = Math.min(H * 0.155, W * 0.42);
  G = FOCAL * CAM_H;
  zBot = G / (H - horizonY);

  sceneEl.style.setProperty('--horizon', horizonY.toFixed(1) + 'px');
  sceneEl.style.setProperty('--far-h', (G / FAR_Z).toFixed(1) + 'px');

  // 采样切片（近密远疏，几何级数）
  SLICES = [];
  const N = 12;
  for (let i = 0; i <= N; i++) SLICES.push(zBot * Math.pow(FAR_Z / zBot, i / N));

  roadSvg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  buildStars();
}

// 视觉弯道：随纵深向远处偏移
function curveM(z) {
  return CURVE_A * Math.sin((dist + z) * 0.05 + 1.3) * Math.pow(z / FAR_Z, 1.4);
}
function pxAt(xM, z) { return cx + (xM + curveM(z)) * FOCAL / z; }
function pyAt(z) { return horizonY + G / z; }

// 投影放置：世界(x米, 纵深z, 离地y米) → 屏幕位置 + 缩放（实体设计尺寸 100px = 1米）
function place(el, xM, z, yM = 0, extraRot = 0) {
  const s = FOCAL / z;
  const x = pxAt(xM, z);
  const y = pyAt(z) - yM * s;
  const k = s / 100;
  el.style.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0) scale(${k.toFixed(4)})` +
    (extraRot ? ` rotate(${extraRot.toFixed(1)}deg)` : '');
}
function makeEnt(cls, wM, hM, innerHTML = '') {
  const el = document.createElement('div');
  el.className = 'ent ' + cls;
  const w = wM * 100, h = hM * 100;
  el.style.width = w + 'px';
  el.style.height = h + 'px';
  el.style.marginLeft = (-w / 2) + 'px';
  el.style.marginTop = (-h) + 'px';
  if (innerHTML) el.innerHTML = innerHTML;
  return el;
}

function bandPts(x1, x2, zLo, zHi, steps) {
  const pts = [];
  for (let j = 0; j <= steps; j++) {
    const z = zLo * Math.pow(zHi / zLo, j / steps);
    pts.push([pxAt(x1, z), pyAt(z)]);
  }
  for (let j = steps; j >= 0; j--) {
    const z = zLo * Math.pow(zHi / zLo, j / steps);
    pts.push([pxAt(x2, z), pyAt(z)]);
  }
  return pts;
}
const ptsStr = (pts) => pts.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');

function updateRoad() {
  const zb = zBot, zf = FAR_Z, ST = 12;
  polyEls.seaL.setAttribute('points', ptsStr(bandPts(-SEA_OUT, -SAND_OUT, zb, zf, ST)));
  polyEls.seaR.setAttribute('points', ptsStr(bandPts(SAND_OUT, SEA_OUT, zb, zf, ST)));
  polyEls.sandL.setAttribute('points', ptsStr(bandPts(-SAND_OUT, -(ROAD_HALF + SHOULDER_W), zb, zf, ST)));
  polyEls.sandR.setAttribute('points', ptsStr(bandPts(ROAD_HALF + SHOULDER_W, SAND_OUT, zb, zf, ST)));
  polyEls.shoulder.setAttribute('points', ptsStr(bandPts(-(ROAD_HALF + SHOULDER_W), ROAD_HALF + SHOULDER_W, zb, zf, ST)));
  polyEls.road.setAttribute('points', ptsStr(bandPts(-ROAD_HALF, ROAD_HALF, zb, zf, ST)));
  polyEls.edgeA.setAttribute('points', ptsStr(bandPts(-ROAD_HALF, -ROAD_HALF + 0.22, zb, zf, ST)));
  polyEls.edgeB.setAttribute('points', ptsStr(bandPts(ROAD_HALF - 0.22, ROAD_HALF, zb, zf, ST)));
  polyEls.glossL.setAttribute('points', ptsStr(bandPts(-2.3, -0.5, 7, zf, 5)));
  polyEls.glossR.setAttribute('points', ptsStr(bandPts(0.5, 2.3, 7, zf, 5)));
}

/* ---------------- 三阶段调色 ---------------- */
const PAL = {
  skyT:    [[64, 164, 246], [110, 147, 184], [10, 14, 38]],
  skyB:    [[207, 236, 255], [194, 211, 222], [29, 37, 71]],
  haze:    [[223, 242, 251], [201, 214, 222], [16, 22, 46]],
  sand:    [[244, 227, 189], [169, 173, 179], [23, 29, 46]],
  sea:     [[31, 143, 208], [169, 173, 179], [23, 29, 46]],
  road:    [[150, 160, 172], [141, 147, 156], [35, 42, 60]],
  shoulder:[[120, 128, 138], [108, 114, 122], [38, 44, 64]],
  edgeA:   [[255, 255, 255], [242, 242, 242], [86, 225, 255]],
  edgeB:   [[255, 255, 255], [242, 242, 242], [255, 92, 180]],
  dash:    [[255, 255, 255], [245, 245, 245], [215, 226, 255]]
};
const STAGE_NAMES = ['海滨公路', '城市高架', '灯牌街区'];
const stageIdxOf = (d) => (d < 300 ? 0 : d < 700 ? 1 : 2);

function stageFactors(d) {
  const t2 = smoothstep(270, 330, d);
  const t3 = smoothstep(670, 730, d);
  return { f1: 1 - t2, f2: t2 * (1 - t3), f3: t3 };
}
const rgbStr = (v) => `rgb(${v[0]},${v[1]},${v[2]})`;

let palTick = 0;
function applyPalette() {
  const f = stageFactors(dist);
  const S = sceneEl.style;
  for (const key of Object.keys(PAL)) {
    const cols = PAL[key]; // [阶段1色, 阶段2色, 阶段3色]，每色 [r,g,b]
    const v = [0, 1, 2].map(i =>
      Math.round(cols[0][i] * f.f1 + cols[1][i] * f.f2 + cols[2][i] * f.f3));
    S.setProperty('--' + ({ skyT: 'sky-top', skyB: 'sky-bot', road: 'road-c' }[key] || key), rgbStr(v));
  }
  S.setProperty('--day', f.f1.toFixed(3));
  S.setProperty('--night', f.f3.toFixed(3));
  S.setProperty('--sun-o', (1 - smoothstep(280, 370, dist)).toFixed(3));
  S.setProperty('--cloud-o', (1 - f.f3).toFixed(3));
  S.setProperty('--star-o', f.f3.toFixed(3));
  S.setProperty('--skya-o', f.f1.toFixed(3));
  S.setProperty('--skyb-o', f.f2.toFixed(3));
  S.setProperty('--skyc-o', f.f3.toFixed(3));
}

/* ---------------- 背景生成：星 / 天际线 ---------------- */
function buildStars() {
  const sky = $('.sky .stars');
  if (!sky) return;
  sky.innerHTML = '';
  const n = Math.round(clamp(W * H / 14000, 26, 70));
  for (let i = 0; i < n; i++) {
    const st = document.createElement('i');
    const sz = Math.random() < 0.24 ? 2 : 1;
    st.style.cssText = `position:absolute;display:block;width:${sz}px;height:${sz}px;border-radius:50%;` +
      `left:${rand(0, 100).toFixed(1)}%;top:${rand(0, 60).toFixed(1)}%;` +
      `background:#dfe9ff;opacity:${rand(0.25, 0.9).toFixed(2)};` +
      `box-shadow:0 0 ${sz * 2}px rgba(200,225,255,.8);`;
    sky.appendChild(st);
  }
}

const NEON_SIGNS = ['海风茶饮', '夜市烧', '星光旅社', '24H', '电玩城', 'KTV', '居酒屋', '便利店', 'BAR', '唱片行'];

function buildSkyline(svgEl, opt) {
  const PW = 1600, PH = 300;
  svgEl.setAttribute('viewBox', `0 0 ${PW * 2} ${PH}`);
  svgEl.setAttribute('preserveAspectRatio', 'none');
  let s = '';
  for (let copy = 0; copy < 2; copy++) {
    s += `<g transform="translate(${copy * PW},0)">`;
    // 远景岛丘 / 灯塔（海滨段）
    if (opt.humps) {
      s += `<path d="M120 ${PH} q150 -78 330 0 z" fill="${opt.hump}"/>`;
      s += `<path d="M700 ${PH} q200 -100 430 0 z" fill="${opt.hump}"/>`;
      s += `<path d="M1180 ${PH} q110 -54 240 0 z" fill="${opt.hump}"/>`;
      s += `<rect x="556" y="${PH - 96}" width="16" height="60" fill="${opt.hump}"/>` +
        `<polygon points="548,${PH - 96} 580,${PH - 96} 564,${PH - 128}" fill="${opt.hump}"/>` +
        `<circle class="b-flash" cx="564" cy="${PH - 118}" r="4" fill="#ffe08a"/>`;
    }
    let x = opt.humps ? -20 : -20;
    while (x < PW) {
      const bw = rand(opt.minW, opt.maxW);
      const bh = rand(opt.minH, opt.maxH);
      const by = PH - bh;
      s += `<rect x="${x.toFixed(0)}" y="${by.toFixed(0)}" width="${bw.toFixed(0)}" height="${bh.toFixed(0)}" fill="${opt.body}"/>`;
      const cols = Math.max(2, Math.floor(bw / 26));
      const rows = Math.max(2, Math.floor(bh / 30));
      for (let c = 0; c < cols; c++) {
        for (let rr = 0; rr < rows; rr++) {
          if (Math.random() < opt.winChance) {
            const wx = x + 8 + c * (bw - 12) / cols;
            const wy = by + 10 + rr * (bh - 14) / rows;
            s += `<rect x="${wx.toFixed(0)}" y="${wy.toFixed(0)}" width="5" height="7" fill="${pick(opt.winColors)}" opacity="${rand(0.35, 0.95).toFixed(2)}"/>`;
          }
        }
      }
      if (opt.neon && bh > opt.signMinH && Math.random() < opt.signChance) {
        const col = pick(opt.neon);
        const sw = rand(44, Math.min(bw - 20, 110));
        const sx = x + rand(8, Math.max(9, bw - sw - 8));
        const sy = by + rand(14, Math.min(bh - 46, 84));
        if (Math.random() < 0.62) {
          s += `<rect x="${sx.toFixed(0)}" y="${sy.toFixed(0)}" width="${sw.toFixed(0)}" height="18" rx="3" fill="none" stroke="${col}" stroke-width="2.5" opacity=".92"/>` +
            `<text x="${(sx + sw / 2).toFixed(0)}" y="${(sy + 14).toFixed(0)}" font-size="12" font-weight="700" letter-spacing="2" fill="${col}" text-anchor="middle" font-family="sans-serif">${pick(NEON_SIGNS)}</text>`;
        } else {
          const vh = rand(34, 64);
          s += `<rect x="${sx.toFixed(0)}" y="${sy.toFixed(0)}" width="13" height="${vh.toFixed(0)}" rx="3" fill="none" stroke="${col}" stroke-width="2.5" opacity=".92"/>`;
          for (let k = 0; k < 3; k++) s += `<rect x="${(sx + 4).toFixed(0)}" y="${(sy + 7 + k * (vh - 16) / 2.6).toFixed(0)}" width="5" height="7" fill="${col}" opacity=".9"/>`;
        }
      }
      if (opt.antenna && Math.random() < 0.28 && bh > opt.signMinH * 0.9) {
        const ax = x + bw / 2;
        s += `<line x1="${ax.toFixed(0)}" y1="${by.toFixed(0)}" x2="${ax.toFixed(0)}" y2="${(by - rand(16, 34)).toFixed(0)}" stroke="${opt.body}" stroke-width="2.5"/>` +
          `<circle class="b-flash" cx="${ax.toFixed(0)}" cy="${(by - 20).toFixed(0)}" r="3" fill="#ff5c6c"/>`;
      }
      x += bw + rand(2, 22);
    }
    s += '</g>';
  }
  svgEl.innerHTML = s;
}

/* ---------------- 场景 SVG 素材（全部自绘） ---------------- */
const SVG_PALM = `<svg viewBox="0 0 170 230" xmlns="${SVG_NS}">
  <path d="M84 228 C 78 170 74 120 60 62" stroke="#8a5a3b" stroke-width="13" fill="none" stroke-linecap="round"/>
  <path d="M80 190 h11 M76 158 h11 M72 126 h10" stroke="#744a2e" stroke-width="4" opacity=".7"/>
  <path d="M60 62 C 30 30 6 34 -2 52 C 22 44 44 52 60 66 Z" fill="#2f9e5f"/>
  <path d="M60 62 C 40 22 20 14 4 20 C 26 26 46 44 60 66 Z" fill="#37b06a"/>
  <path d="M60 62 C 78 24 104 16 122 24 C 98 32 76 46 62 66 Z" fill="#2f9e5f"/>
  <path d="M60 62 C 92 34 128 38 142 56 C 116 48 84 56 62 68 Z" fill="#37b06a"/>
  <path d="M60 62 C 52 26 60 4 78 -2 C 70 18 68 42 62 62 Z" fill="#2aa65c"/>
  <circle cx="56" cy="68" r="8" fill="#6b4a2e"/><circle cx="68" cy="72" r="7" fill="#7a5636"/></svg>`;

const SVG_UMB = `<svg viewBox="0 0 150 170" xmlns="${SVG_NS}">
  <path d="M75 14 L10 70 L42 70 Z" fill="#ff6b57"/>
  <path d="M75 14 L42 70 L74 70 Z" fill="#fff5ea"/>
  <path d="M75 14 L74 70 L106 70 Z" fill="#ff6b57"/>
  <path d="M75 14 L106 70 L140 70 Z" fill="#fff5ea"/>
  <rect x="71" y="6" width="8" height="10" rx="3" fill="#c8901c"/>
  <rect x="72" y="66" width="6" height="98" rx="3" fill="#b7831a"/>
  <ellipse cx="75" cy="164" rx="27" ry="6" fill="rgba(120,90,40,.28)"/></svg>`;

const SVG_RAILPOST1 = `<svg viewBox="0 0 36 110" xmlns="${SVG_NS}">
  <rect x="12" y="24" width="11" height="76" rx="3" fill="#f4f8fc" stroke="#c9d6e2" stroke-width="1.5"/>
  <rect x="10" y="14" width="15" height="11" rx="3" fill="#2fc2e0"/>
  <rect x="8" y="98" width="19" height="10" rx="2" fill="#d9e4ee"/></svg>`;
const SVG_RAILBEAM1 = `<svg viewBox="0 0 720 90" xmlns="${SVG_NS}">
  <rect x="0" y="18" width="720" height="14" rx="6" fill="#f4f8fc"/>
  <rect x="0" y="46" width="720" height="11" rx="5" fill="#e7eef5"/>
  <rect x="0" y="32" width="720" height="6" fill="#2fc2e0" opacity=".6"/></svg>`;
const SVG_RAILPOST2 = `<svg viewBox="0 0 36 110" xmlns="${SVG_NS}">
  <rect x="12" y="24" width="11" height="76" rx="3" fill="#9aa6b4" stroke="#6e7a88" stroke-width="1.5"/>
  <rect x="10" y="14" width="15" height="11" rx="3" fill="#ffd166"/>
  <rect x="8" y="98" width="19" height="10" rx="2" fill="#5c6874"/></svg>`;
const SVG_RAILBEAM2 = `<svg viewBox="0 0 720 90" xmlns="${SVG_NS}">
  <rect x="0" y="18" width="720" height="14" rx="6" fill="#aeb9c6"/>
  <rect x="0" y="46" width="720" height="11" rx="5" fill="#96a2b0"/>
  <rect x="0" y="32" width="720" height="6" fill="#ffd166" opacity=".8"/></svg>`;

const SVG_LAMP = `<div class="mir" style="width:100%;height:100%">` +
  `<svg viewBox="0 0 96 540" xmlns="${SVG_NS}">
    <rect x="40" y="36" width="10" height="500" rx="5" fill="#5e6a78"/>
    <rect x="36" y="524" width="18" height="14" rx="4" fill="#414c58"/>
    <path d="M45 46 C 45 16 66 12 82 16" stroke="#5e6a78" stroke-width="9" fill="none"/>
    <ellipse class="lamp-head" cx="82" cy="22" rx="13" ry="7" fill="#ffe9ad"/>
    <polygon class="lamp-cone" points="70,30 24,300 132,300" fill="rgba(255,212,121,.13)"/></svg></div>`;

function svgBoard(v) {
  const legs = `<rect x="80" y="252" width="14" height="126" fill="#2a2f45"/><rect x="426" y="252" width="14" height="126" fill="#2a2f45"/>`;
  const panel = `<rect x="10" y="12" width="500" height="246" rx="16" fill="#101430" stroke="currentColor" stroke-width="6"/>`;
  let body = '';
  if (v === 0) body = `<text x="260" y="88" text-anchor="middle" font-size="46" font-weight="800" letter-spacing="8" fill="currentColor" font-family="sans-serif">海风茶饮</text>` +
    `<text x="260" y="134" text-anchor="middle" font-size="19" letter-spacing="5" fill="rgba(240,248,255,.78)" font-family="sans-serif">SEA BREEZE · 冰鲜柠檬茶</text>` +
    `<rect x="216" y="160" width="72" height="76" rx="10" fill="none" stroke="currentColor" stroke-width="5"/>` +
    `<line x1="262" y1="160" x2="276" y2="128" stroke="currentColor" stroke-width="6" stroke-linecap="round"/>` +
    `<path d="M222 198 q14 -12 28 0 t28 0" stroke="currentColor" stroke-width="4" fill="none"/>`;
  else if (v === 1) body = `<ellipse cx="140" cy="128" rx="36" ry="46" fill="none" stroke="currentColor" stroke-width="5"/>` +
    `<rect x="126" y="72" width="28" height="13" rx="5" fill="currentColor"/>` +
    `<line x1="140" y1="174" x2="140" y2="196" stroke="currentColor" stroke-width="5"/>` +
    `<text x="330" y="108" text-anchor="middle" font-size="44" font-weight="800" letter-spacing="6" fill="currentColor" font-family="sans-serif">夜市烧鸟</text>` +
    `<text x="330" y="152" text-anchor="middle" font-size="18" letter-spacing="4" fill="rgba(240,248,255,.78)" font-family="sans-serif">NIGHT MARKET · 营业中</text>`;
  else body = `<polygon points="150,88 168,126 210,126 176,152 190,192 150,166 110,192 124,152 90,126 132,126" fill="none" stroke="currentColor" stroke-width="5" stroke-linejoin="round"/>` +
    `<text x="330" y="112" text-anchor="middle" font-size="42" font-weight="800" letter-spacing="6" fill="currentColor" font-family="sans-serif">星光旅社</text>` +
    `<text x="330" y="156" text-anchor="middle" font-size="18" letter-spacing="4" fill="rgba(240,248,255,.78)" font-family="sans-serif">HOTEL · VACANCY</text>`;
  return `<svg viewBox="0 0 520 380" xmlns="${SVG_NS}">${legs}${panel}${body}` +
    `<rect x="150" y="222" width="220" height="6" rx="3" fill="currentColor" opacity=".8"/></svg>`;
}

const gantryBraces = Array.from({ length: 9 }, (_, i) => {
  const x = i * 145;
  return `<path d="M${x} 200 L${x + 72} 120 L${x + 145} 200" stroke="#2e3846" stroke-width="7" fill="none"/>`;
}).join('');
const SVG_GANTRY = `<svg viewBox="0 0 1300 700" xmlns="${SVG_NS}">
  <rect x="30" y="200" width="46" height="500" fill="#3c4656"/>
  <rect x="1224" y="200" width="46" height="500" fill="#3c4656"/>
  <rect x="0" y="120" width="1300" height="80" fill="#46525f"/>
  ${gantryBraces}
  <rect class="gantry-under" x="60" y="198" width="1180" height="10" rx="4" fill="#ffd479" opacity=".85"/>
  <rect x="470" y="212" width="360" height="110" rx="10" fill="#1e6e46" stroke="#f2f7ff" stroke-width="4"/>
  <text x="650" y="258" font-size="36" fill="#f2f7ff" text-anchor="middle" font-weight="700" letter-spacing="8" font-family="sans-serif">滨海大道</text>
  <text x="650" y="302" font-size="20" fill="#cfe8d8" text-anchor="middle" letter-spacing="4" font-family="sans-serif">BAYSIDE AVE ↑</text></svg>`;

const stringBulbs = (() => {
  const cols = ['#ff5c8a', '#ffd166', '#4cd7ff', '#7bf1a8'];
  let s = '';
  for (let i = 0; i <= 12; i++) {
    const t = i / 12;
    const x = t * 1200;
    const y = (1 - t) * (1 - t) * 40 + 2 * (1 - t) * t * 150 + t * t * 40;
    s += `<line x1="${x.toFixed(0)}" y1="${y.toFixed(0)}" x2="${x.toFixed(0)}" y2="${(y + 14).toFixed(0)}" stroke="#262c47" stroke-width="3"/>` +
      `<circle class="bulb" cx="${x.toFixed(0)}" cy="${(y + 22).toFixed(0)}" r="10" fill="${cols[i % 4]}"/>`;
  }
  return s;
})();
const SVG_STRINGS = `<svg viewBox="0 0 1200 400" xmlns="${SVG_NS}">
  <line x1="14" y1="40" x2="14" y2="400" stroke="#262c47" stroke-width="12"/>
  <line x1="1186" y1="40" x2="1186" y2="400" stroke="#262c47" stroke-width="12"/>
  <path d="M0 40 Q 600 150 1200 40" stroke="#262c47" stroke-width="6" fill="none"/>${stringBulbs}</svg>`;

const SVG_FARCAR = `<svg viewBox="0 0 190 90" xmlns="${SVG_NS}">
  <path d="M10 70 h170 v-22 a10 10 0 0 0 -10 -10 h-46 l-16 -20 h-52 l-18 20 h-18 a10 10 0 0 0 -10 10 z" fill="#2e3949"/>
  <path d="M70 20 h36 l12 18 h-52 z" fill="#43506b"/>
  <circle cx="48" cy="72" r="13" fill="#1d2530"/><circle cx="142" cy="72" r="13" fill="#1d2530"/></svg>`;

const SVG_BOAT = `<svg viewBox="0 0 130 140" xmlns="${SVG_NS}">
  <rect x="62" y="18" width="5" height="92" fill="#5a4632"/>
  <path d="M67 20 L112 100 L67 100 Z" fill="#fdfdfd"/>
  <path d="M62 32 L28 100 L62 100 Z" fill="#e8eef5"/>
  <path d="M12 108 L118 108 L96 130 L34 130 Z" fill="#c94f42"/></svg>`;

const SVG_BARRIER = `<svg viewBox="0 0 220 110" xmlns="${SVG_NS}">
  <path d="M30 86 l-9 18 M30 86 l9 18 M190 86 l-9 18 M190 86 l9 18" stroke="#5a6470" stroke-width="5" fill="none"/>
  <rect x="14" y="62" width="192" height="24" rx="6" fill="#eef2f6" stroke="#c8d2dc" stroke-width="2"/>
  ${[26, 62, 98, 134, 170].map(x => `<path d="M${x} 86 L${x + 16} 62 h16 L${x + 15} 86 Z" fill="#ff7a42"/>`).join('')}
  <line x1="110" y1="62" x2="110" y2="48" stroke="#5a6470" stroke-width="4"/>
  <circle class="blinklight" cx="110" cy="42" r="7" fill="#ff4d5d"/></svg>`;

const SVG_CART = `<svg viewBox="0 0 230 210" xmlns="${SVG_NS}">
  <path d="M28 34 h174 l10 26 h-194 Z" fill="#ff7a42"/>
  <rect x="40" y="34" width="16" height="26" fill="#fff5ea" opacity=".85"/>
  <rect x="76" y="34" width="16" height="26" fill="#fff5ea" opacity=".85"/>
  <rect x="112" y="34" width="16" height="26" fill="#fff5ea" opacity=".85"/>
  <rect x="148" y="34" width="16" height="26" fill="#fff5ea" opacity=".85"/>
  <rect x="184" y="34" width="16" height="26" fill="#fff5ea" opacity=".85"/>
  <circle cx="70" cy="76" r="12" fill="#ffb347" stroke="#e08a2e" stroke-width="2"/>
  <circle cx="100" cy="74" r="12" fill="#ff8a5c" stroke="#e06a3e" stroke-width="2"/>
  <circle cx="130" cy="76" r="12" fill="#ffd166" stroke="#e0a82e" stroke-width="2"/>
  <rect x="34" y="86" width="162" height="76" rx="10" fill="#f2f7ff" stroke="#c8d2dc" stroke-width="3"/>
  <rect x="34" y="86" width="162" height="14" rx="7" fill="#2f9e8f"/>
  <text x="115" y="134" font-size="21" fill="#2f6e8f" text-anchor="middle" font-weight="700" font-family="sans-serif">海冰 · 刨冰</text>
  <circle cx="70" cy="180" r="20" fill="#2e3949"/><circle cx="70" cy="180" r="7" fill="#e8eef5"/>
  <circle cx="160" cy="180" r="20" fill="#2e3949"/><circle cx="160" cy="180" r="7" fill="#e8eef5"/>
  <path d="M196 100 h26" stroke="#5a6470" stroke-width="7" stroke-linecap="round"/></svg>`;

const SVG_TRUCK = `<svg viewBox="0 0 230 270" xmlns="${SVG_NS}">
  <rect class="blinklight" x="98" y="12" width="26" height="12" rx="4" fill="#ff9f43"/>
  <rect x="10" y="30" width="196" height="180" rx="12" fill="#3f7fc4" stroke="#2c5d94" stroke-width="3"/>
  <path d="M10 132 q30 -22 60 0 t60 0 t60 0 v42 h-180 z" fill="rgba(255,255,255,.4)"/>
  <text x="108" y="92" font-size="24" fill="#eaf6ff" text-anchor="middle" font-weight="800" letter-spacing="4" font-family="sans-serif">海岸货运</text>
  <rect x="150" y="212" width="56" height="42" rx="8" fill="#2c5d94"/>
  <rect x="160" y="218" width="30" height="18" rx="5" fill="#bfe3ff"/>
  <rect x="10" y="212" width="130" height="12" rx="6" fill="#2c5d94"/>
  <circle cx="44" cy="240" r="21" fill="#1d2530"/><circle cx="44" cy="240" r="7" fill="#8892a4"/>
  <circle cx="100" cy="240" r="21" fill="#1d2530"/><circle cx="100" cy="240" r="7" fill="#8892a4"/>
  <circle cx="178" cy="242" r="19" fill="#1d2530"/><circle cx="178" cy="242" r="6" fill="#8892a4"/></svg>`;

const SVG_COIN = `<svg viewBox="0 0 100 100" xmlns="${SVG_NS}">
  <circle cx="50" cy="50" r="44" fill="#ffd166" stroke="#c8901c" stroke-width="6"/>
  <circle cx="50" cy="50" r="31" fill="none" stroke="#e8b23c" stroke-width="3" stroke-dasharray="6 5"/>
  <path d="M56 24 L38 54 h12 L44 78 L64 46 h-13 Z" fill="#fff7d6" stroke="#e8b23c" stroke-width="2"/></svg>`;

const SVG_ARCH = `<svg viewBox="0 0 1100 720" xmlns="${SVG_NS}">
  <defs><pattern id="pat-chk" width="56" height="56" patternUnits="userSpaceOnUse">
    <rect width="56" height="56" fill="#f2f7ff"/><rect width="28" height="28" fill="#16233c"/>
    <rect x="28" y="28" width="28" height="28" fill="#16233c"/></pattern></defs>
  <rect x="30" y="90" width="62" height="630" rx="8" fill="#1d3354" stroke="#4cd7ff" stroke-width="4"/>
  <rect x="1008" y="90" width="62" height="630" rx="8" fill="#1d3354" stroke="#ff5c9e" stroke-width="4"/>
  <rect x="30" y="30" width="1040" height="150" rx="14" fill="url(#pat-chk)" stroke="#16233c" stroke-width="6"/>
  <rect x="270" y="52" width="560" height="106" rx="12" fill="#10203c" opacity=".92"/>
  <text x="550" y="118" font-size="52" font-weight="900" fill="#ffd166" stroke="#ffffff" stroke-width="1.5" text-anchor="middle" letter-spacing="10" font-family="sans-serif">FINISH · 1000m</text>
  <circle cx="61" cy="80" r="10" fill="#ff5c8a"/><circle cx="52" cy="62" r="8" fill="#ffd166"/><circle cx="72" cy="58" r="7" fill="#4cd7ff"/>
  <circle cx="1039" cy="80" r="10" fill="#7bf1a8"/><circle cx="1048" cy="62" r="8" fill="#ff5c9e"/><circle cx="1028" cy="58" r="7" fill="#ffd166"/></svg>`;

const SVG_FINBAND = `<svg viewBox="0 0 900 60" xmlns="${SVG_NS}">
  <defs><pattern id="pat-fb" width="60" height="60" patternUnits="userSpaceOnUse">
    <rect width="60" height="60" fill="#f2f7ff"/><rect width="30" height="30" fill="#16233c"/>
    <rect x="30" y="30" width="30" height="30" fill="#16233c"/></pattern></defs>
  <rect x="0" y="4" width="900" height="52" fill="url(#pat-fb)" opacity=".92"/></svg>`;

const OB_TYPES = {
  barrier: { w: 2.2, h: 1.05, jumpable: true,  cls: 'obs-barrier', svg: SVG_BARRIER },
  cart:    { w: 2.3, h: 2.0,  jumpable: false, cls: 'obs-cart',    svg: SVG_CART },
  truck:   { w: 2.4, h: 2.55, jumpable: false, cls: 'obs-truck',   svg: SVG_TRUCK }
};

/* ---------------- 场景实体池 ---------------- */
const dashes = [], glints = [], specks = [], palms = [], umbs = [];
const posts1 = [], beams1 = [], posts2 = [], beams2 = [];
const lamps = [], boards = [], farcars = [];
let gantries = [], stringsets = [];
let archEl = null, finbandEl = null;

const DASH_N = 24, DASH_SP = 4;
const GLINT_N = 13, GLINT_SP = 6.6, GLINT_LOOP = 90;
const SPECK_N = 8, SPECK_SP = 8, SPECK_LOOP = 64;
const PALM_N = 6, PALM_SP = 34, PALM_LOOP = PALM_N * PALM_SP;
const UMB_N = 2, UMB_SP = 67, UMB_LOOP = UMB_N * UMB_SP;
const RAIL_N = 12, RAIL_SP = 7, RAIL_LOOP = RAIL_N * RAIL_SP;
const LAMP_N = 7, LAMP_SP = 24, LAMP_LOOP = LAMP_N * LAMP_SP;
const BOARD_N = 3, BOARD_SP = 40, BOARD_LOOP = BOARD_N * BOARD_SP;

function initSceneryPools() {
  for (const lx of [-1.2, 1.2])
    for (let i = 0; i < DASH_N; i++) {
      const el = makeEnt('dash', 0.22, 1.7);
      worldScn.appendChild(el);
      dashes.push({ el, lx });
    }
  for (const side of [-1, 1])
    for (let i = 0; i < GLINT_N; i++) {
      const el = makeEnt('glint', 1.0, 0.1);
      el.style.animationDelay = (-rand(0, 2)).toFixed(2) + 's';
      worldScn.appendChild(el);
      glints.push({ el, side, base: i * GLINT_SP + side * 2.7, x: side * rand(16, 33) });
    }
  for (const side of [-1, 1])
    for (let i = 0; i < SPECK_N; i++) {
      const el = makeEnt('speck', 0.22, 0.22);
      worldScn.appendChild(el);
      specks.push({ el, base: i * SPECK_SP + side, x: side * rand(5.6, 13) });
    }
  for (let i = 0; i < PALM_N; i++) {
    const el = makeEnt('palm', 2.4, 3.3, SVG_PALM);
    const inner = document.createElement('div');
    inner.className = 'mir';
    inner.style.cssText = 'width:100%;height:100%';
    while (el.firstChild) inner.appendChild(el.firstChild);
    el.appendChild(inner);
    worldScn.appendChild(el);
    palms.push({ el, mir: inner, idx: i });
  }
  for (let i = 0; i < UMB_N; i++) {
    const el = makeEnt('umb', 1.6, 1.85, SVG_UMB);
    worldScn.appendChild(el);
    umbs.push({ el, idx: i });
  }
  for (const side of [-1, 1])
    for (let i = 0; i < RAIL_N; i++) {
      const p = makeEnt('railpost', 0.36, 1.1, SVG_RAILPOST1);
      const b = makeEnt('railbeam', 7.2, 0.9, SVG_RAILBEAM1);
      worldScn.append(p, b);
      posts1.push({ el: p, side, idx: i });
      beams1.push({ el: b, side, idx: i });
    }
  for (const side of [-1, 1])
    for (let i = 0; i < RAIL_N; i++) {
      const p = makeEnt('railpost', 0.36, 1.1, SVG_RAILPOST2);
      const b = makeEnt('railbeam', 7.2, 0.9, SVG_RAILBEAM2);
      worldScn.append(p, b);
      posts2.push({ el: p, side, idx: i });
      beams2.push({ el: b, side, idx: i });
    }
  for (let i = 0; i < LAMP_N; i++) {
    const el = makeEnt('lamp', 0.96, 5.4, SVG_LAMP);
    worldScn.appendChild(el);
    lamps.push({ el, mir: el.querySelector('.mir'), side: 0, idx: i });
  }
  for (let i = 0; i < BOARD_N; i++) {
    const el = makeEnt('board bd' + (i + 1), 5.2, 3.8, svgBoard(i));
    if (i === 1) el.classList.add('board-flicker');
    worldScn.appendChild(el);
    boards.push({ el, idx: i });
  }
  for (let i = 0; i < 5; i++) {
    const el = makeEnt('farcar', 1.9, 0.9, SVG_FARCAR);
    worldScn.appendChild(el);
    farcars.push({ el, x: (i % 2 === 0 ? -1 : 1) * 7.8, z: rand(24, 94) });
  }
  gantries = [380, 560].map((wz) => {
    const el = makeEnt('gantry', 13, 7, SVG_GANTRY);
    worldScn.appendChild(el);
    return { el, wz };
  });
  stringsets = [760, 900].map((wz) => {
    const el = makeEnt('strings', 12, 2.4, SVG_STRINGS);
    worldScn.appendChild(el);
    return { el, wz };
  });
  // 终点拱门 + 冲线带
  archEl = makeEnt('arch', 11, 7.2, SVG_ARCH);
  finbandEl = makeEnt('finband', 8.6, 0.55, SVG_FINBAND);
  worldEnt.append(archEl, finbandEl);
}

const wzWin1 = (wz) => 1 - smoothstep(280, 330, wz);
const wzWin23 = (wz) => smoothstep(280, 330, wz);
const wzWin3 = (wz) => smoothstep(680, 730, wz);
const wzWin2Only = (wz) => smoothstep(280, 330, wz) * (1 - smoothstep(660, 720, wz));

function showEnt(el, z, op) {
  if (op < 0.03) { el.style.display = 'none'; return; }
  el.style.display = '';
  el.style.opacity = op.toFixed(2);
  place(el, 0, z);
  el.style.zIndex = Math.max(1, Math.round(2000 - z * 10));
}

function updScenery() {
  const d = dist;
  const seaOp = 1 - smoothstep(270, 330, d);

  // 车道虚线
  const dLoop = DASH_N * DASH_SP;
  let di = 0;
  for (const lx of [-1.2, 1.2])
    for (let i = 0; i < DASH_N; i++) {
      const z = mod(i * DASH_SP - d, dLoop) + 0.65;
      place(dashes[di++].el, lx, z);
    }
  // 海面波光
  for (const g of glints) {
    const z = mod(g.base - d, GLINT_LOOP) + 3;
    place(g.el, g.x + Math.sin((d + z) * 0.11 + g.side) * 0.8, z);
    g.el.style.opacity = (seaOp * 0.85).toFixed(2);
    g.el.style.display = seaOp < 0.04 ? 'none' : '';
  }
  // 沙滩斑点
  for (const sp of specks) {
    const z = mod(sp.base - d, SPECK_LOOP) + 2;
    place(sp.el, sp.x, z);
    sp.el.style.opacity = (seaOp * 0.7).toFixed(2);
    sp.el.style.display = seaOp < 0.04 ? 'none' : '';
  }
  // 棕榈树
  for (const P of palms) {
    const z = mod(P.idx * PALM_SP - d, PALM_LOOP) + 3;
    const wz = d + z;
    const op = wzWin1(wz);
    const worldIdx = Math.round((wz - 3) / PALM_SP);
    const side = worldIdx % 2 === 0 ? -1 : 1;
    P.mir.style.transform = side === -1 ? '' : 'scaleX(-1)';
    P.el.style.opacity = op.toFixed(2);
    P.el.style.display = op < 0.03 ? 'none' : '';
    if (op >= 0.03) { place(P.el, side * (9 + (P.idx % 3) * 1.3), z); P.el.style.zIndex = Math.max(1, Math.round(2000 - z * 10)); }
  }
  // 遮阳伞
  for (const U of umbs) {
    const z = mod(U.idx * UMB_SP - d, UMB_LOOP) + 6;
    const wz = d + z;
    const op = wzWin1(wz);
    U.el.style.opacity = op.toFixed(2);
    U.el.style.display = op < 0.03 ? 'none' : '';
    if (op >= 0.03) { place(U.el, (U.idx % 2 === 0 ? -1 : 1) * 10.6, z); U.el.style.zIndex = Math.max(1, Math.round(2000 - z * 10)); }
  }
  // 两套护栏（海滨白 / 高架金属）+ 横杆
  const updRail = (arr, op2fn) => {
    for (const R of arr) {
      const z = mod(R.idx * RAIL_SP - d, RAIL_LOOP) + 0.4;
      const wz = d + z;
      const op = op2fn(wz);
      R.el.style.opacity = op.toFixed(2);
      R.el.style.display = op < 0.03 ? 'none' : '';
      if (op >= 0.03) {
        const isBeam = R.el.classList.contains('railbeam');
        place(R.el, R.side * (ROAD_HALF + 0.62), z, isBeam ? 0.5 : 0);
        R.el.style.zIndex = Math.max(1, Math.round(2000 - z * 10));
      }
    }
  };
  updRail(posts1, wzWin1);
  updRail(beams1, wzWin1);
  updRail(posts2, wzWin23);
  updRail(beams2, wzWin23);
  // 路灯
  for (const L of lamps) {
    const z = mod(L.idx * LAMP_SP - d, LAMP_LOOP) + 0.8;
    const wz = d + z;
    const op = wzWin23(wz);
    L.el.style.opacity = op.toFixed(2);
    L.el.style.display = op < 0.03 ? 'none' : '';
    if (op >= 0.03) {
      const worldIdx = Math.round((wz - 0.8) / LAMP_SP);
      const side = worldIdx % 2 === 0 ? -1 : 1;
      L.mir.style.transform = side === -1 ? 'scaleX(-1)' : '';
      place(L.el, side * (ROAD_HALF + 1.6), z);
      L.el.style.zIndex = Math.max(1, Math.round(2000 - z * 10));
    }
  }
  // 霓虹广告牌（街区段）
  for (const B of boards) {
    const z = mod(B.idx * BOARD_SP - d, BOARD_LOOP) + 2;
    const wz = d + z;
    const op = wzWin3(wz);
    B.el.style.opacity = op.toFixed(2);
    B.el.style.display = op < 0.03 ? 'none' : '';
    if (op >= 0.03) {
      const worldIdx = Math.round((wz - 2) / BOARD_SP);
      const side = worldIdx % 2 === 0 ? -1 : 1;
      place(B.el, side * (ROAD_HALF + 3.1), z);
      B.el.style.zIndex = Math.max(1, Math.round(2000 - z * 10));
    }
  }
  // 高架天桥（固定世界位置）
  for (const G2 of gantries) {
    const z = G2.wz - d;
    const op = (z > 0.4 && z < 96) ? wzWin2Only(G2.wz) : 0;
    G2.el.style.opacity = op.toFixed(2);
    G2.el.style.display = op < 0.03 ? 'none' : '';
    if (op >= 0.03) {
      place(G2.el, 0, z);
      G2.el.style.zIndex = Math.max(1, Math.round(2000 - z * 10));
    }
  }
  // 夜段灯串
  for (const ST of stringsets) {
    const z = ST.wz - d;
    const op = (z > 0.4 && z < 96) ? wzWin3(ST.wz) : 0;
    ST.el.style.opacity = op.toFixed(2);
    ST.el.style.display = op < 0.03 ? 'none' : '';
    if (op >= 0.03) {
      place(ST.el, 0, z);
      ST.el.style.zIndex = Math.max(1, Math.round(2000 - z * 10));
    }
  }
  // 对向车流剪影（高架段）
  for (const F of farcars) {
    F.z -= (speed + 13) * lastDt;
    if (F.z < 3) { F.z = rand(88, 100); F.x = (Math.random() < 0.5 ? -1 : 1) * 7.8; }
    const op = wzWin2Only(d + F.z) * 0.9;
    F.el.style.opacity = op.toFixed(2);
    F.el.style.display = op < 0.04 ? 'none' : '';
    if (op >= 0.04) {
      place(F.el, F.x, F.z);
      F.el.style.zIndex = Math.max(1, Math.round(2000 - F.z * 10) - 12);
    }
  }
  // 帆船
  const bz = mod(26 - d * 0.9, 150) + 8;
  const bwz = d * 0.9 + bz;
  const bop = wzWin1(bwz);
  archBoat.el.style.opacity = bop.toFixed(2);
  archBoat.el.style.display = bop < 0.04 ? 'none' : '';
  if (bop >= 0.04) {
    const side = Math.round((bwz - 8) / 150) % 2 === 0 ? -1 : 1;
    place(archBoat.el, side * 20, bz);
    archBoat.el.style.zIndex = Math.max(1, Math.round(2000 - bz * 10));
  }
}

/* ---------------- 游戏实体：障碍 / 能量币 ---------------- */
const obstacles = [];
const coins = [];
let spawnCoins = 0, spawnObs = 0;

function addObstacle(type, lane, z) {
  const t = OB_TYPES[type];
  const el = makeEnt(t.cls, t.w, t.h, t.svg);
  worldEnt.appendChild(el);
  obstacles.push({ type, lane, z, w: t.w, h: t.h, jumpable: t.jumpable, el });
  spawnObs++;
}
function addCoin(lane, z, y) {
  const el = makeEnt('coin', 0.85, 0.85, `<span class="coin-spin">${SVG_COIN}</span>`);
  worldEnt.appendChild(el);
  coins.push({ lane, z, y, bob: Math.random() * Math.PI * 2, el });
  spawnCoins++;
}
function addCoinLine(lane, zStart, n, spacing) {
  for (let i = 0; i < n; i++) addCoin(lane, zStart - i * spacing, 0.8);
  return n * spacing;
}
function addCoinArc(lane, zc, peak, n, halfSpan) {
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * 2 - 1;
    addCoin(lane, zc + t * halfSpan, 0.4 + (peak - 0.4) * (1 - t * t));
  }
  return halfSpan * 2;
}
function pickObType(diff) {
  const r = Math.random();
  if (diff === 0) return r < 0.5 ? 'barrier' : 'cart';
  if (diff === 1) return r < 0.4 ? 'barrier' : r < 0.72 ? 'cart' : 'truck';
  return r < 0.35 ? 'barrier' : r < 0.65 ? 'cart' : 'truck';
}

function removeEnt(arr, i) { arr[i].el.remove(); arr.splice(i, 1); }
function clearEntities() {
  for (const o of obstacles) o.el.remove();
  for (const c of coins) c.el.remove();
  obstacles.length = 0;
  coins.length = 0;
  confettiBox.innerHTML = '';
}

/* ---------------- 关卡模式：保证永远有路可走 ---------------- */
let nextPatternAt = Infinity;

function spawnPattern() {
  if (dist > 940) { nextPatternAt = Infinity; return; }
  const d = dist;
  const allLanes = [0, 1, 2];
  const diff = d < 300 ? 0 : d < 700 ? 1 : 2;
  const z0 = Math.min(SPAWN_Z, 930 - d);
  const roll = Math.random();
  let len = 4;

  if (roll < 0.30) {
    const ol = randInt(0, 2);
    addObstacle(pickObType(diff), ol, z0);
    const cl = pick(allLanes.filter(l => l !== ol));
    len = Math.max(len, addCoinLine(cl, z0 - 3, 6, 3));
  } else if (roll < 0.55 && diff >= 1) {
    const free = randInt(0, 2);
    const others = allLanes.filter(l => l !== free);
    addObstacle(pickObType(diff), others[0], z0);
    addObstacle(pickObType(diff), others[1], z0 + rand(-1.5, 1.5));
    len = Math.max(len, addCoinLine(free, z0 - 5, 7, 3));
  } else if (roll < 0.68 && diff >= 1) {
    for (const l of allLanes) addObstacle('barrier', l, z0);
    len = Math.max(len, addCoinArc(1, z0, 1.65, 5, 2.2));
  } else if (roll < 0.85) {
    const l = randInt(0, 2);
    addObstacle('barrier', l, z0);
    len = Math.max(len, addCoinArc(l, z0, 1.55, 5, 2.0));
    if (diff >= 1 && Math.random() < 0.5 && z0 + 10 < 925) {
      const l2 = pick(allLanes.filter(x => x !== l));
      addObstacle(pickObType(diff), l2, z0 + 10);
      len = Math.max(len, 12);
    }
  } else if (diff >= 2) {
    let l = randInt(0, 2);
    let zc = z0;
    for (let i = 0; i < 3 && zc < 900; i++) {
      addObstacle(pickObType(2), l, zc);
      const free = pick(allLanes.filter(x => x !== l));
      addCoinLine(free, zc + 1.5, 3, 1.7);
      l = free;
      zc += 13;
    }
    len = zc + 2 - z0;
  } else {
    let l = randInt(0, 2);
    let zc = z0;
    for (let i = 0; i < 4; i++) {
      zc = Math.max(zc + addCoinLine(l, zc, 3, 1.8), zc + 5);
      l = clamp(l + pick([-1, 1]), 0, 2);
    }
    len = zc - z0;
  }

  const gap = clamp(30 - d / 110, 21, 30) + rand(-2, 3);
  nextPatternAt = d + gap + len;
}

/* ---------------- 玩家与状态 ---------------- */
let state = 'start';           // start | running | crash | finish | over
let dist = 0, speed = ATTRACT_SPEED, coinCt = 0, dodged = 0;
let runTime = 0, finishT = 0, crashT = 0;
let targetLane = 1, playerX = 0, tilt = 0;
let jumping = false, jumpT = 0, jumpY = 0, jumpQueued = false;
let prevStageIdx = 0, lastDt = 0.016;
let bestMs = 0;
try { bestMs = parseInt(localStorage.getItem('ccs_best_ms') || '0', 10) || 0; } catch (e) { bestMs = 0; }

const isTouch = matchMedia('(pointer: coarse)').matches ||
  (('ontouchstart' in window) && Math.min(screen.width, screen.height) < 820);

let boatElRef = null;
const archBoat = {
  get el() { return boatElRef; }
};

function resetRun() {
  clearEntities();
  dist = 0;
  speed = START_SPEED;
  coinCt = 0;
  dodged = 0;
  runTime = 0;
  finishT = 0;
  crashT = 0;
  spawnCoins = 0;
  spawnObs = 0;
  targetLane = 1;
  playerX = 0;
  tilt = 0;
  jumping = false;
  jumpT = 0;
  jumpY = 0;
  jumpQueued = false;
  prevStageIdx = 0;
  finishTriggered = false;
  nextPatternAt = Infinity;
  sceneEl.classList.remove('crash');
  playerEl.classList.remove('crashed', 'jumping');
  hudCoinBox.classList.remove('pulse');
  bannerEl.classList.add('hidden');
  bannerEl.classList.remove('show');
  hintEl.classList.remove('fade');
}

function startGame() {
  AudioSys.ensure();
  resetRun();
  // 预热：引导币线 + 第一个跳障
  addCoinLine(1, 30, 6, 3);
  addObstacle('barrier', 1, 58);
  nextPatternAt = 70;
  state = 'running';
  overlayStart.classList.add('hidden');
  overlayFail.classList.add('hidden');
  overlayWin.classList.add('hidden');
  hudEl.classList.remove('hidden');
  hintEl.classList.remove('hidden');
  hintEl.textContent = isTouch ? '◀ ▶ 移动 · ▲ 跳跃' : '← → 切换轨道 · 空格 跳跃';
  if (isTouch) controlsEl.classList.add('on');
  AudioSys.start();
  showStageBanner(0);
  updateHUD(true);
  setTimeout(() => hintEl.classList.add('fade'), 4200);
}

function goHome() {
  resetRun();
  state = 'start';
  overlayFail.classList.add('hidden');
  overlayWin.classList.add('hidden');
  overlayStart.classList.remove('hidden');
  hudEl.classList.add('hidden');
  hintEl.classList.add('hidden');
  controlsEl.classList.remove('on');
  refreshBestLine();
}

function crash() {
  state = 'crash';
  crashT = 0;
  AudioSys.crash();
  sceneEl.classList.add('crash');
  playerEl.classList.add('crashed');
  playerEl.classList.remove('jumping');
}

function fmtTime(s) {
  if (s < 60) return s.toFixed(1) + 's';
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r.toFixed(1).padStart(4, '0')}`;
}

function showFail() {
  state = 'over';
  $('#fl-dist').textContent = Math.floor(dist) + ' m';
  $('#fl-coin').textContent = coinCt;
  $('#fl-dodge').textContent = dodged;
  $('#fl-stage').textContent = STAGE_NAMES[stageIdxOf(dist)];
  overlayFail.classList.remove('hidden');
  hintEl.classList.add('hidden');
  controlsEl.classList.remove('on');
}

function computeGrade() {
  const coinPct = spawnCoins > 0 ? coinCt / spawnCoins : 0;
  const timeScore = clamp((90 - runTime) / 15, 0, 1);
  const overall = coinPct * 0.6 + timeScore * 0.4;
  if (overall >= 0.78) return { g: 'S', line: '完美海岸冲刺！币与时间都无可挑剔' };
  if (overall >= 0.58) return { g: 'A', line: '漂亮的一跑，海风都在为你欢呼' };
  if (overall >= 0.38) return { g: 'B', line: '顺利冲线，下次试试收集更多能量币' };
  return { g: 'C', line: '完成 1000m！再跑一次刷新成绩吧' };
}

function showWin() {
  state = 'over';
  const { g, line } = computeGrade();
  const gradeEl = $('#grade');
  gradeEl.textContent = g;
  gradeEl.dataset.grade = g;
  $('#grade-line').textContent = line;
  $('#wn-time').textContent = fmtTime(runTime);
  $('#wn-coin').textContent = coinCt + ' / ' + spawnCoins;
  $('#wn-dodge').textContent = dodged;
  const ms = Math.round(runTime * 1000);
  let isRecord = false;
  if (!bestMs || ms < bestMs) {
    isRecord = true;
    bestMs = ms;
    try { localStorage.setItem('ccs_best_ms', String(bestMs)); } catch (e) { /* 隐私模式 */ }
  }
  $('#wn-best').textContent = fmtTime(bestMs / 1000);
  $('#new-record').classList.toggle('hidden', !isRecord);
  overlayWin.classList.remove('hidden');
  hintEl.classList.add('hidden');
  controlsEl.classList.remove('on');
}

function refreshBestLine() {
  $('#best-line-start').textContent = bestMs > 0 ? `最佳冲线用时 · ${fmtTime(bestMs / 1000)}` : '';
}

let bannerTO = 0;
function showStageBanner(idx) {
  const labels = ['第 1 段 · 海滨公路 🌊', '第 2 段 · 城市高架 🌆', '第 3 段 · 灯牌街区 🏮'];
  bannerText.textContent = labels[idx];
  bannerEl.classList.remove('hidden');
  bannerEl.classList.remove('show');
  void bannerEl.offsetWidth;
  bannerEl.classList.add('show');
  clearTimeout(bannerTO);
  bannerTO = setTimeout(() => bannerEl.classList.add('hidden'), 2400);
  if (idx > 0) AudioSys.stage();
}

/* ---------------- 输入 ---------------- */
function move(dir) {
  if (state !== 'running') return;
  const next = clamp(targetLane + dir, 0, 2);
  if (next !== targetLane) {
    targetLane = next;
    AudioSys.lane();
  }
}
function doJump() {
  if (state !== 'running') return;
  if (!jumping) {
    jumping = true;
    jumpT = 0;
    playerEl.classList.add('jumping');
    AudioSys.jump();
  } else {
    jumpQueued = true;
  }
}

function bindEvents() {
  document.addEventListener('keydown', (e) => {
    const k = e.key;
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', ' ', 'a', 'd', 'w', 'A', 'D', 'W'].includes(k)) e.preventDefault();
    if (state === 'running') {
      if (k === 'ArrowLeft' || k === 'a' || k === 'A') move(-1);
      else if (k === 'ArrowRight' || k === 'd' || k === 'D') move(1);
      else if (k === ' ' || k === 'ArrowUp' || k === 'w' || k === 'W') { if (!e.repeat) doJump(); }
    } else if (k === ' ' || k === 'Enter') {
      if (!e.repeat) startGame();
    }
  });

  $('#btn-start').addEventListener('click', startGame);
  $('#btn-retry').addEventListener('click', startGame);
  $('#btn-again').addEventListener('click', startGame);
  $('#btn-home-1').addEventListener('click', goHome);
  $('#btn-home-2').addEventListener('click', goHome);

  const bl = $('#btn-left'), br = $('#btn-right'), bj = $('#btn-jump');
  bl.addEventListener('pointerdown', (e) => { e.preventDefault(); move(-1); });
  br.addEventListener('pointerdown', (e) => { e.preventDefault(); move(1); });
  bj.addEventListener('pointerdown', (e) => { e.preventDefault(); doJump(); });
  for (const b of [bl, br, bj]) b.addEventListener('contextmenu', (e) => e.preventDefault());

  // 场景内滑动手势：左右滑换道，上滑/点按跳跃
  let tx = 0, ty = 0, tt = 0;
  sceneEl.addEventListener('touchstart', (e) => {
    tx = e.touches[0].clientX; ty = e.touches[0].clientY; tt = performance.now();
  }, { passive: true });
  sceneEl.addEventListener('touchend', (e) => {
    if (state !== 'running') return;
    const dx = e.changedTouches[0].clientX - tx;
    const dy = e.changedTouches[0].clientY - ty;
    const dtms = performance.now() - tt;
    if (Math.abs(dx) > 42 && Math.abs(dx) > Math.abs(dy)) move(dx > 0 ? 1 : -1);
    else if (dy < -42) doJump();
    else if (Math.abs(dx) < 12 && Math.abs(dy) < 12 && dtms < 260) doJump();
  }, { passive: true });

  const muteBtn = $('#btn-mute');
  try { AudioSys.muted = localStorage.getItem('ccs_mute') === '1'; } catch (e) { /* ignore */ }
  const renderMute = () => {
    muteBtn.textContent = AudioSys.muted ? '🔇' : '🔊';
    muteBtn.setAttribute('aria-pressed', String(!AudioSys.muted));
  };
  renderMute();
  muteBtn.addEventListener('click', () => {
    AudioSys.muted = !AudioSys.muted;
    try { localStorage.setItem('ccs_mute', AudioSys.muted ? '1' : '0'); } catch (e) { /* ignore */ }
    if (!AudioSys.muted) AudioSys.ensure();
    renderMute();
  });

  document.addEventListener('touchmove', (e) => {
    if (!(e.target && e.target.closest && e.target.closest('.card'))) e.preventDefault();
  }, { passive: false });

  document.addEventListener('visibilitychange', () => { if (!document.hidden) last = performance.now(); });
  window.addEventListener('resize', layout);
  window.addEventListener('orientationchange', () => setTimeout(layout, 120));
}

/* ---------------- 特效 ---------------- */
function coinBurst(x, y) {
  const colors = ['#ffd166', '#fff3c4', '#ffb84d', '#4cd7ff'];
  for (let i = 0; i < 7; i++) {
    const sp = document.createElement('i');
    sp.className = 'spark';
    const ang = rand(0, Math.PI * 2);
    const r = rand(18, 44);
    sp.style.cssText = `position:absolute;left:${x.toFixed(0)}px;top:${y.toFixed(0)}px;width:7px;height:7px;border-radius:50%;` +
      `background:${colors[i % colors.length]};pointer-events:none;z-index:60;` +
      `transition:transform .42s ease-out,opacity .42s;`;
    worldEnt.appendChild(sp);
    requestAnimationFrame(() => {
      sp.style.transform = `translate(${(Math.cos(ang) * r).toFixed(0)}px,${(Math.sin(ang) * r - 12).toFixed(0)}px) scale(.2)`;
      sp.style.opacity = '0';
    });
    setTimeout(() => sp.remove(), 480);
  }
}

function confettiBurst() {
  const px = cx + playerX * FOCAL / PLAYER_Z;
  const py = horizonY + G / PLAYER_Z - 1.1 * FOCAL / PLAYER_Z;
  const colors = ['#ffd166', '#ff6b57', '#4cd7ff', '#7bf1a8', '#ff5c9e', '#fff5ea'];
  for (let i = 0; i < 40; i++) {
    const cf = document.createElement('i');
    cf.style.cssText = `left:${(px + rand(-30, 30)).toFixed(0)}px;top:${py.toFixed(0)}px;` +
      `background:${colors[i % colors.length]};` +
      `--dx:${rand(-190, 190).toFixed(0)}px;--rot:${rand(360, 900).toFixed(0)}deg;` +
      `--cdur:${rand(1.1, 2).toFixed(2)}s;`;
    confettiBox.appendChild(cf);
  }
  setTimeout(() => { confettiBox.innerHTML = ''; }, 2400);
}

/* ---------------- HUD ---------------- */
let hudAcc = 0;
function updateHUD(force) {
  hudDist.textContent = Math.floor(dist);
  hudSpeed.textContent = Math.round(speed * 3.6);
  hudTime.textContent = fmtTime(runTime);
  hudCoin.textContent = coinCt;
  const si = stageIdxOf(dist);
  hudStage.textContent = STAGE_NAMES[si];
  hudStage.className = 'hud-stage s' + (si + 1);
  progFill.style.width = clamp(dist / FINISH_M * 100, 0, 100).toFixed(1) + '%';
  progTrack.className = 'prog-track s' + (si + 1);
}

/* ---------------- 主循环 ---------------- */
let last = performance.now();
let fxAcc = 0;
let finishTriggered = false;

function finishRun() {
  state = 'finish';
  finishT = 0;
  finishTriggered = true;
  AudioSys.finish();
  bannerText.textContent = '🏁 冲过终点！';
  bannerEl.classList.remove('hidden');
  bannerEl.classList.remove('show');
  void bannerEl.offsetWidth;
  bannerEl.classList.add('show');
  clearTimeout(bannerTO);
  bannerTO = setTimeout(() => bannerEl.classList.add('hidden'), 2200);
  confettiBurst();
  hintEl.classList.add('hidden');
  controlsEl.classList.remove('on');
}

function update(dt) {
  lastDt = dt;
  if (state === 'start') {
    dist = mod(dist + ATTRACT_SPEED * dt, 280);
    return;
  }
  if (state === 'running') {
    speed = Math.min(MAX_SPEED, START_SPEED + dist * SPEED_PER_M);
    runTime += dt;
    if (dist >= nextPatternAt) spawnPattern();
  } else if (state === 'crash') {
    speed = Math.max(0, speed - 30 * dt);
    crashT += dt;
    if (crashT > 0.95) showFail();
  } else if (state === 'finish') {
    speed = Math.max(0, speed - 13 * dt);
    finishT += dt;
    if (finishT > 1.6) { showWin(); return; }
  }

  dist += speed * dt;

  // 玩家横向移动
  const targetX = LANES_X[targetLane];
  const prevX = playerX;
  playerX += (targetX - playerX) * Math.min(1, dt * 13);
  if (Math.abs(targetX - playerX) < 0.01) playerX = targetX;
  tilt = clamp((playerX - prevX) / Math.max(dt, 0.001) * 0.9, -14, 14) * (state === 'running' ? 1 : 0);

  // 跳跃物理
  if (jumping) {
    jumpT += dt;
    jumpY = JUMP_V * jumpT - 0.5 * GRAVITY * jumpT * jumpT;
    if (jumpY <= 0) {
      jumpY = 0;
      jumping = false;
      jumpT = 0;
      playerEl.classList.remove('jumping');
      if (jumpQueued) { jumpQueued = false; doJump(); }
    }
  }

  // 障碍推进 / 碰撞 / 躲避计数
  for (let i = obstacles.length - 1; i >= 0; i--) {
    const o = obstacles[i];
    o.z -= speed * dt;
    if (o.z < KILL_Z) {
      if (state === 'running' || state === 'finish') dodged++;
      removeEnt(obstacles, i);
      continue;
    }
    if (state === 'running' &&
      Math.abs(o.z - PLAYER_Z) < 0.8 &&
      Math.abs(playerX - LANES_X[o.lane]) < 1.15) {
      if (!(o.jumpable && jumpY > BARRIER_CLEAR_Y)) { crash(); break; }
    }
  }
  // 能量币推进 / 收集
  const nowS = performance.now() / 1000;
  for (let i = coins.length - 1; i >= 0; i--) {
    const c = coins[i];
    c.z -= speed * dt;
    if (c.z < KILL_Z) { removeEnt(coins, i); continue; }
    if (state === 'running' &&
      Math.abs(c.z - PLAYER_Z) < 0.95 &&
      Math.abs(playerX - LANES_X[c.lane]) < 1.05 &&
      Math.abs(c.y - (jumpY + 0.85)) < 0.55) {
      const s = FOCAL / c.z;
      coinBurst(pxAt(LANES_X[c.lane], c.z), pyAt(c.z) - c.y * s);
      removeEnt(coins, i);
      coinCt++;
      AudioSys.coin();
      hudCoinBox.classList.remove('pulse');
      void hudCoinBox.offsetWidth;
      hudCoinBox.classList.add('pulse');
    }
  }
  // 阶段切换
  const si = stageIdxOf(dist);
  if (si !== prevStageIdx && state === 'running') {
    prevStageIdx = si;
    showStageBanner(si);
  }
  // 冲线判定
  if (state === 'running' && !finishTriggered && dist >= FINISH_M) finishRun();
}

function render() {
  updateRoad();
  updScenery();

  // 视差天际线
  const wA = skyASvg.parentElement.clientWidth / 2 || 1;
  const wB = skyBSvg.parentElement.clientWidth / 2 || 1;
  const wC = skyCSvg.parentElement.clientWidth / 2 || 1;
  skyASvg.style.transform = `translate3d(${(-mod(dist * 0.08, wA)).toFixed(1)}px,0,0)`;
  skyBSvg.style.transform = `translate3d(${(-mod(dist * 0.18, wB)).toFixed(1)}px,0,0)`;
  skyCSvg.style.transform = `translate3d(${(-mod(dist * 0.30, wC)).toFixed(1)}px,0,0)`;

  palTick++;
  if (palTick % 3 === 0) applyPalette();

  // 障碍
  for (const o of obstacles) {
    place(o.el, LANES_X[o.lane], o.z);
    o.el.style.zIndex = Math.max(1, Math.round(2000 - o.z * 10));
  }
  // 能量币（轻微浮动）
  const nowS = performance.now() / 1000;
  for (const c of coins) {
    place(c.el, LANES_X[c.lane], c.z, c.y + Math.sin(nowS * 3 + c.bob) * 0.07);
    c.el.style.zIndex = Math.max(1, Math.round(2000 - c.z * 10));
  }
  // 终点拱门 + 冲线带
  const zA = FINISH_M - dist;
  if (zA > 0.4 && zA < 96) {
    place(archEl, 0, zA);
    archEl.style.display = '';
    archEl.style.zIndex = Math.max(1, Math.round(2000 - zA * 10));
    place(finbandEl, 0, zA + 0.4);
    finbandEl.style.display = '';
    finbandEl.style.opacity = '.95';
    finbandEl.style.zIndex = Math.max(1, Math.round(2000 - (zA + 0.4) * 10));
  } else {
    archEl.style.display = 'none';
    finbandEl.style.display = 'none';
  }

  // 玩家
  const pScale = FOCAL / PLAYER_Z / 100;
  const px = pxAt(playerX, PLAYER_Z);
  const pyGround = pyAt(PLAYER_Z);
  const py = pyGround - jumpY * FOCAL / PLAYER_Z;
  playerEl.style.transform = `translate3d(${px.toFixed(1)}px,${py.toFixed(1)}px,0) scale(${pScale.toFixed(4)}) rotate(${tilt.toFixed(1)}deg)`;
  playerEl.style.zIndex = '1983';
  pShadow.style.transform = `translate3d(${px.toFixed(1)}px,${pyGround.toFixed(1)}px,0) scale(${(1 / (1 + jumpY * 0.9)).toFixed(3)})`;
  pShadow.style.opacity = String(clamp(0.75 - jumpY * 0.28, 0.25, 0.75));
  pShadow.style.zIndex = '1980';

  hudAcc++;
  if (hudAcc % 6 === 0 || state !== 'running') updateHUD();

  fxAcc++;
  if (fxAcc % 20 === 0) {
    const boost = clamp((speed - START_SPEED + 4) / (MAX_SPEED - START_SPEED), 0, 1);
    sceneEl.style.setProperty('--boost', boost.toFixed(2));
    sceneEl.style.setProperty('--cadence', clamp(0.52 - speed * 0.012, 0.28, 0.52).toFixed(2) + 's');
    sceneEl.style.setProperty('--streak-dur', clamp(0.9 - speed * 0.02, 0.34, 0.9).toFixed(2) + 's');
  }
}

function frame(now) {
  requestAnimationFrame(frame);
  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.05) dt = 0.05;
  if (state === 'start' || state === 'running' || state === 'crash' || state === 'finish') update(dt);
  render();
}

/* ---------------- 启动 ---------------- */
function init() {
  // 夜间路面反光渐变
  const defs = document.createElementNS(SVG_NS, 'defs');
  defs.innerHTML = `<linearGradient id="glossG" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#ff5c9e" stop-opacity=".5"/>
    <stop offset=".5" stop-color="#4cd7ff" stop-opacity=".26"/>
    <stop offset="1" stop-color="#4cd7ff" stop-opacity="0"/></linearGradient>`;
  roadSvg.appendChild(defs);
  polyEls.seaL = $('#pg-seaL');
  polyEls.seaR = $('#pg-seaR');
  polyEls.sandL = $('#pg-sandL');
  polyEls.sandR = $('#pg-sandR');
  polyEls.shoulder = $('#pg-shoulder');
  polyEls.road = $('#pg-road');
  polyEls.edgeA = $('#pg-edgeA');
  polyEls.edgeB = $('#pg-edgeB');
  polyEls.glossL = $('#pg-glossL');
  polyEls.glossR = $('#pg-glossR');
  for (const k of ['glossL', 'glossR']) polyEls[k].setAttribute('fill', 'url(#glossG)');

  buildSkyline(skyASvg, {
    humps: true, hump: '#7fb6dc', body: '#8fb9d9',
    minW: 40, maxW: 90, minH: 30, maxH: 80,
    winChance: 0.05, winColors: ['#e6f4ff'], neon: null, signChance: 0, signMinH: 999, antenna: false
  });
  buildSkyline(skyBSvg, {
    humps: false, body: '#8296aa',
    minW: 70, maxW: 150, minH: 80, maxH: 200,
    winChance: 0.16, winColors: ['#6a7f92', '#556879', '#7d92a5'],
    neon: null, signChance: 0, signMinH: 999, antenna: true
  });
  buildSkyline(skyCSvg, {
    humps: false, body: '#10162e',
    minW: 70, maxW: 150, minH: 90, maxH: 210,
    winChance: 0.2, winColors: ['#ffd9a0', '#8fb4ff', '#bfe9ff', '#ff9fc7'],
    neon: ['#4cd7ff', '#ff5c9e', '#ffd166', '#9d7bff'], signChance: 0.42, signMinH: 100, antenna: true
  });
  initSceneryPools();
  boatElRef = makeEnt('boat', 1.4, 1.5, SVG_BOAT);
  worldScn.appendChild(boatElRef);
  layout();
  worldEnt.appendChild(playerWrap);
  playerWrap.style.zIndex = 'auto';
  bindEvents();
  if (isTouch) document.body.classList.add('touch');
  refreshBestLine();
  applyPalette();
  updateHUD(true);
  requestAnimationFrame((t) => { last = t; requestAnimationFrame(frame); });
}

/* 调试钩子（自动化验证用，无 UI 入口） */
window.CCS_DEBUG = {
  skipTo(d) {
    d = clamp(Number(d) || 0, 0, 999);
    clearEntities();
    dist = d;
    prevStageIdx = stageIdxOf(d);
    nextPatternAt = d + 6;
  },
  hit() { if (state === 'running') crash(); },
  info() { return { state, dist: Math.round(dist), lane: targetLane, coins: coinCt, dodged, speed, runTime, spawnCoins, spawnObs }; }
};

init();
