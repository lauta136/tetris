/* ============================================================================
   tetris.js — Modern (Tetris Guideline) Tetris
   Vanilla JS + Canvas. No dependencies, no build step, no framework.

   Guideline features implemented:
     - 7-bag randomiser (no droughts, one of each piece per bag)
     - SRS rotation with the full JLSTZ and I wall-kick tables
     - Hold slot, ghost piece, 3-deep next queue
     - Lock delay (500 ms, 15 move resets)
     - Soft drop / hard drop
     - T-spin detection (3-corner rule, mini vs full), back-to-back,
       combos, perfect clears, Guideline scoring table
     - Guideline gravity curve: (0.8 - (level-1)*0.007) ^ (level-1)
   ========================================================================== */

'use strict';

/* ------------------------------------------------------------------ config */

const COLS = 10;
const ROWS = 20;                  // visible rows
const HIDDEN = 2;                 // buffer rows above the visible field
const TOTAL_ROWS = ROWS + HIDDEN;

const SPAWN_Y = 1;                // puts a fresh piece's bottom row on the first visible row
const NEXT_COUNT = 3;

const LOCK_DELAY_MS   = 500;
const MAX_LOCK_RESETS = 15;
const SOFT_DROP_MS    = 26;
const DAS_MS          = 165;      // delayed auto shift: pause before a held direction repeats
const ARR_MS          = 42;       // auto repeat rate once DAS kicks in
const CLEAR_MS        = 120;      // line-clear flash duration
const GESTURES        = true;     // swipe handling on the field, layered over the buttons

/* ------------------------------------------------------------------ pieces */

const TYPES = ['I', 'J', 'L', 'O', 'S', 'T', 'Z'];

const COLORS = {
  I: '#4fd1c5', J: '#5b8def', L: '#f6a96b', O: '#f2d06b',
  S: '#6bd98a', T: '#b48ce8', Z: '#f27c7c',
};

/* SRS spawn orientations. I uses a 4x4 box, O a 2x2, everything else 3x3. */
const SHAPES = {
  I: [[0,0,0,0], [1,1,1,1], [0,0,0,0], [0,0,0,0]],
  J: [[1,0,0],   [1,1,1],   [0,0,0]],
  L: [[0,0,1],   [1,1,1],   [0,0,0]],
  O: [[1,1],     [1,1]],
  S: [[0,1,1],   [1,1,0],   [0,0,0]],
  T: [[0,1,0],   [1,1,1],   [0,0,0]],
  Z: [[1,1,0],   [0,1,1],   [0,0,0]],
};

/* Wall-kick tables, straight from the Guideline. Offsets are (dx, dy) with y
   pointing UP, so they are applied as (dx, -dy) on a y-down grid. */
const KICKS_JLSTZ = {
  '0>1': [[0,0], [-1,0], [-1, 1], [0,-2], [-1,-2]],
  '1>0': [[0,0], [ 1,0], [ 1,-1], [0, 2], [ 1, 2]],
  '1>2': [[0,0], [ 1,0], [ 1,-1], [0, 2], [ 1, 2]],
  '2>1': [[0,0], [-1,0], [-1, 1], [0,-2], [-1,-2]],
  '2>3': [[0,0], [ 1,0], [ 1, 1], [0,-2], [ 1,-2]],
  '3>2': [[0,0], [-1,0], [-1,-1], [0, 2], [-1, 2]],
  '3>0': [[0,0], [-1,0], [-1,-1], [0, 2], [-1, 2]],
  '0>3': [[0,0], [ 1,0], [ 1, 1], [0,-2], [ 1,-2]],
};

const KICKS_I = {
  '0>1': [[0,0], [-2,0], [ 1,0], [-2,-1], [ 1, 2]],
  '1>0': [[0,0], [ 2,0], [-1,0], [ 2, 1], [-1,-2]],
  '1>2': [[0,0], [-1,0], [ 2,0], [-1, 2], [ 2,-1]],
  '2>1': [[0,0], [ 1,0], [-2,0], [ 1,-2], [-2, 1]],
  '2>3': [[0,0], [ 2,0], [-1,0], [ 2, 1], [-1,-2]],
  '3>2': [[0,0], [-2,0], [ 1,0], [-2,-1], [ 1, 2]],
  '3>0': [[0,0], [ 1,0], [-2,0], [ 1,-2], [-2, 1]],
  '0>3': [[0,0], [-1,0], [ 2,0], [-1, 2], [ 2,-1]],
};

/* T-spin corner rule. Corners of the 3x3 box, and which two are "front"
   (the side the nub points at) in each rotation state. */
const T_CORNERS = [[0,0], [2,0], [0,2], [2,2]];
const T_FRONT = {
  0: [[0,0], [2,0]],
  1: [[2,0], [2,2]],
  2: [[0,2], [2,2]],
  3: [[0,0], [0,2]],
};

/* Precompute all four rotations of every piece. */
function rotateCW(m) {
  const n = m.length;
  const out = [];
  for (let y = 0; y < n; y++) {
    const row = new Array(n);
    for (let x = 0; x < n; x++) row[x] = m[n - 1 - x][y];
    out.push(row);
  }
  return out;
}

const ROT = {};
const SPAWN_X = {};
for (const t of TYPES) {
  ROT[t] = [SHAPES[t]];
  for (let i = 1; i < 4; i++) ROT[t].push(rotateCW(ROT[t][i - 1]));
  SPAWN_X[t] = Math.floor((COLS - SHAPES[t].length) / 2);
}

/* ------------------------------------------------------------------ state */

let board = [];
let cur = null;                 // { type, rot, x, y }
let hold = null;
let holdUsed = false;
let queue = [];
let bag = [];

let score = 0;
let level = 1;
let linesCleared = 0;
let combo = -1;
let b2b = false;

let state = 'ready';            // ready | playing | paused | over
let phase = 'playing';          // playing | clearing
let clearing = null;            // { rows: [], t: 0 }

let gravityAcc = 0;
let grounded = false;
let lockTimer = 0;
let lockResets = 0;
let softDropping = false;
let lastAction = 'spawn';       // spawn | move | rotate
let lastKick = -1;

let bestScore = 0;
let muted = false;

const L = { cell: 24, dpr: 1 };

const els = {};
const repeaters = { left: null, right: null };

/* ------------------------------------------------------------------ helpers */

const fmt = (n) => n.toLocaleString('en-US');

function setText(el, v) {
  if (el && el._v !== v) { el._v = v; el.textContent = v; }
}

function nextFromBag() {
  if (bag.length === 0) {
    bag = TYPES.slice();
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = bag[i]; bag[i] = bag[j]; bag[j] = t;
    }
  }
  return bag.pop();
}

function refillQueue() {
  while (queue.length < NEXT_COUNT) queue.push(nextFromBag());
}

/* ------------------------------------------------------------------ rules */

function collides(type, rot, px, py) {
  const m = ROT[type][rot];
  for (let y = 0; y < m.length; y++) {
    for (let x = 0; x < m.length; x++) {
      if (!m[y][x]) continue;
      const bx = px + x;
      const by = py + y;
      if (bx < 0 || bx >= COLS || by >= TOTAL_ROWS) return true;
      if (by < 0) continue;
      if (board[by][bx]) return true;
    }
  }
  return false;
}

function ghostY() {
  let y = cur.y;
  while (!collides(cur.type, cur.rot, cur.x, y + 1)) y++;
  return y;
}

/* Move by a delta, keeping lock-delay bookkeeping correct. */
function tryShift(dx, dy) {
  if (!cur || collides(cur.type, cur.rot, cur.x + dx, cur.y + dy)) return false;
  const wasGrounded = grounded;
  cur.x += dx;
  cur.y += dy;
  if (wasGrounded && lockResets < MAX_LOCK_RESETS) { lockResets++; lockTimer = 0; }
  grounded = collides(cur.type, cur.rot, cur.x, cur.y + 1);
  if (!grounded) lockTimer = 0;
  return true;
}

function tryRotate(dir) {
  if (!cur || cur.type === 'O' || phase !== 'playing') return false;

  const from = cur.rot;
  const to = (from + (dir > 0 ? 1 : 3)) % 4;
  const table = cur.type === 'I' ? KICKS_I : KICKS_JLSTZ;
  const kicks = table[from + '>' + to];

  for (let i = 0; i < kicks.length; i++) {
    const dx = kicks[i][0];
    const dy = -kicks[i][1];               // table is y-up; screen is y-down
    const nx = cur.x + dx;
    const ny = cur.y + dy;
    if (collides(cur.type, to, nx, ny)) continue;

    const wasGrounded = grounded;
    cur.rot = to;
    cur.x = nx;
    cur.y = ny;
    if (wasGrounded && lockResets < MAX_LOCK_RESETS) { lockResets++; lockTimer = 0; }
    grounded = collides(cur.type, cur.rot, cur.x, cur.y + 1);
    if (!grounded) lockTimer = 0;

    lastAction = 'rotate';
    lastKick = i;
    return true;
  }
  return false;
}

function moveHorizontal(dir) {
  if (!cur || state !== 'playing' || phase !== 'playing') return;
  if (tryShift(dir, 0)) {
    lastAction = 'move';
    beep('move');
  }
}

function hardDrop() {
  if (!cur || state !== 'playing' || phase !== 'playing') return;
  const target = ghostY();
  const n = target - cur.y;
  if (n > 0) { cur.y = target; score += n * 2; }
  lockPiece();
}

function doHold() {
  if (!cur || holdUsed || state !== 'playing' || phase !== 'playing') return;

  const incoming = hold;
  hold = cur.type;
  holdUsed = true;

  if (incoming) {
    cur = { type: incoming, rot: 0, x: SPAWN_X[incoming], y: SPAWN_Y };
    gravityAcc = 0;
    grounded = false;
    lockTimer = 0;
    lockResets = 0;
    lastAction = 'spawn';
    lastKick = -1;
    if (collides(cur.type, cur.rot, cur.x, cur.y)) { gameOver(); return; }
  } else {
    spawn();
    if (state !== 'playing') return;
    holdUsed = true;                        // spawn() cleared it
  }

  beep('hold');
  drawPreviews();
}

function detectTSpin() {
  if (!cur || cur.type !== 'T' || lastAction !== 'rotate') return 0;

  const occ = T_CORNERS.map(function (c) {
    const bx = cur.x + c[0];
    const by = cur.y + c[1];
    if (bx < 0 || bx >= COLS || by >= TOTAL_ROWS) return true;   // walls and floor count as filled
    if (by < 0) return false;
    return board[by][bx] !== 0;
  });

  let filled = 0;
  for (let i = 0; i < 4; i++) if (occ[i]) filled++;
  if (filled < 3) return 0;
  if (lastKick === 4) return 2;             // the final kick test promotes to a full T-spin

  let frontFilled = 0;
  for (const f of T_FRONT[cur.rot]) {
    const idx = T_CORNERS.findIndex((c) => c[0] === f[0] && c[1] === f[1]);
    if (idx !== -1 && occ[idx]) frontFilled++;
  }
  return frontFilled === 2 ? 2 : 1;
}

function spawn() {
  refillQueue();
  const type = queue.shift();
  refillQueue();

  cur = { type: type, rot: 0, x: SPAWN_X[type], y: SPAWN_Y };
  gravityAcc = 0;
  grounded = false;
  lockTimer = 0;
  lockResets = 0;
  holdUsed = false;
  lastAction = 'spawn';
  lastKick = -1;

  if (collides(cur.type, cur.rot, cur.x, cur.y)) { gameOver(); return; }
  phase = 'playing';
  drawPreviews();
}

function lockPiece() {
  const tspin = detectTSpin();          // must read the board BEFORE the piece lands
  const m = ROT[cur.type][cur.rot];

  let anyVisible = false;
  for (let y = 0; y < m.length; y++) {
    for (let x = 0; x < m.length; x++) {
      if (!m[y][x]) continue;
      const bx = cur.x + x;
      const by = cur.y + y;
      if (by < 0 || by >= TOTAL_ROWS) continue;
      board[by][bx] = cur.type;
      if (by >= HIDDEN) anyVisible = true;
    }
  }
  cur = null;
  beep('lock');

  const full = [];
  for (let r = 0; r < TOTAL_ROWS; r++) {
    let complete = true;
    for (let c = 0; c < COLS; c++) if (!board[r][c]) { complete = false; break; }
    if (complete) full.push(r);
  }

  applyScore(full.length, tspin, full);
  drawPreviews();

  if (!anyVisible) { gameOver(); return; }        // lock out

  if (full.length) {
    phase = 'clearing';
    clearing = { rows: full, t: 0 };
  } else {
    spawn();
  }
}

function applyScore(n, tspin, full) {
  let base = 0;
  let label = '';

  if (tspin === 2) {
    base = n === 1 ? 800 : n === 2 ? 1200 : n === 3 ? 1600 : 0;
    label = n === 3 ? 'T-Spin Triple' : n === 2 ? 'T-Spin Double' : n === 1 ? 'T-Spin Single' : 'T-Spin';
  } else if (tspin === 1) {
    base = n === 1 ? 200 : n === 2 ? 400 : 0;
    label = 'T-Spin Mini';
  } else {
    base = n === 1 ? 100 : n === 2 ? 300 : n === 3 ? 500 : n === 4 ? 800 : 0;
    label = n === 4 ? 'Tetris' : n === 3 ? 'Triple' : n === 2 ? 'Double' : 'Single';
  }

  if (n > 0) {
    const difficult = n === 4 || tspin > 0;
    if (difficult && b2b) { base = Math.floor(base * 1.5); label = 'B2B ' + label; }
    b2b = difficult;

    combo++;
    if (combo > 0) base += 50 * combo;

    /* perfect clear: nothing survives outside the rows being cleared */
    let leftover = false;
    for (let r = 0; r < TOTAL_ROWS && !leftover; r++) {
      if (full.indexOf(r) !== -1) continue;
      for (let c = 0; c < COLS; c++) if (board[r][c]) { leftover = true; break; }
    }
    if (!leftover) { base += [0, 800, 1200, 1800, 2000][n] || 0; label = 'Perfect Clear'; }
  } else {
    combo = -1;
    if (tspin > 0) label = tspin === 2 ? 'T-Spin' : 'T-Spin Mini';
  }

  score += base * level;
  linesCleared += n;
  level = Math.min(99, Math.floor(linesCleared / 10) + 1);

  if (label && n > 0) toast(label);
  updateHUD();
}

function finishClear() {
  const rows = clearing.rows;
  clearing = null;
  rows.sort((a, b) => a - b);
  for (let i = rows.length - 1; i >= 0; i--) {
    board.splice(rows[i], 1);
    board.unshift(new Array(COLS).fill(0));
  }
  beep(rows.length === 4 ? 'tetris' : 'clear');
  phase = 'playing';
  spawn();
}

/* ------------------------------------------------------------------ loop */

function gravityMs() {
  const l = Math.min(level, 20);
  const sec = Math.pow(0.8 - (l - 1) * 0.007, l - 1);
  return Math.max(sec * 1000, 16);
}

function step(dt) {
  if (state !== 'playing') return;

  if (phase === 'clearing') {
    clearing.t += dt;
    if (clearing.t >= CLEAR_MS) finishClear();
    return;
  }
  if (!cur) return;

  const stepMs = softDropping ? Math.min(gravityMs(), SOFT_DROP_MS) : gravityMs();
  gravityAcc += dt;
  if (gravityAcc > stepMs * 4) gravityAcc = stepMs * 4;      // no bursts after a stall

  while (gravityAcc >= stepMs) {
    gravityAcc -= stepMs;
    if (tryShift(0, 1)) {
      if (softDropping) score += 1;
    } else {
      if (!grounded) { grounded = true; lockTimer = 0; }
      break;
    }
  }

  if (grounded) {
    lockTimer += dt;
    if (lockTimer >= LOCK_DELAY_MS) lockPiece();
  }
}

let lastFrame = 0;
function frame(now) {
  requestAnimationFrame(frame);
  if (!lastFrame) { lastFrame = now; return; }
  let dt = now - lastFrame;
  lastFrame = now;
  if (dt > 100) dt = 100;

  step(dt);
  updateHUD();
  render();
}

/* ------------------------------------------------------------------ drawing */

function roundRect(g, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + rr, y);
  g.lineTo(x + w - rr, y);
  g.arcTo(x + w, y, x + w, y + rr, rr);
  g.lineTo(x + w, y + h - rr);
  g.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  g.lineTo(x + rr, y + h);
  g.arcTo(x, y + h, x, y + h - rr, rr);
  g.lineTo(x, y + rr);
  g.arcTo(x, y, x + rr, y, rr);
  g.closePath();
}

function block(g, px, py, size, color, ghost) {
  const inset = Math.max(1, size * 0.055);
  const x = px + inset;
  const y = py + inset;
  const w = size - inset * 2;
  const h = size - inset * 2;
  const r = Math.max(2, size * 0.17);

  if (ghost) {
    g.save();
    g.globalAlpha = 0.30;
    g.strokeStyle = color;
    g.lineWidth = Math.max(1.25, size * 0.08);
    roundRect(g, x, y, w, h, r);
    g.stroke();
    g.restore();
    return;
  }

  g.save();
  g.fillStyle = color;
  roundRect(g, x, y, w, h, r);
  g.fill();

  const grad = g.createLinearGradient(x, y, x, y + h);
  grad.addColorStop(0, 'rgba(255,255,255,0.26)');
  grad.addColorStop(0.45, 'rgba(255,255,255,0.02)');
  grad.addColorStop(1, 'rgba(0,0,0,0.20)');
  g.fillStyle = grad;
  roundRect(g, x, y, w, h, r);
  g.fill();
  g.restore();
}

function render() {
  const g = els.field.getContext('2d');
  const cell = L.cell;
  const W = COLS * cell;
  const H = ROWS * cell;

  g.setTransform(L.dpr, 0, 0, L.dpr, 0, 0);
  g.clearRect(0, 0, W, H);

  g.strokeStyle = 'rgba(255,255,255,0.035)';
  g.lineWidth = 1;
  g.beginPath();
  for (let c = 1; c < COLS; c++) { g.moveTo(c * cell + 0.5, 0); g.lineTo(c * cell + 0.5, H); }
  for (let r = 1; r < ROWS; r++) { g.moveTo(0, r * cell + 0.5); g.lineTo(W, r * cell + 0.5); }
  g.stroke();

  for (let r = HIDDEN; r < TOTAL_ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const t = board[r][c];
      if (t) block(g, c * cell, (r - HIDDEN) * cell, cell, COLORS[t]);
    }
  }

  if (phase === 'clearing' && clearing) {
    const p = Math.min(1, clearing.t / CLEAR_MS);
    g.save();
    g.globalAlpha = (1 - p) * 0.9;
    g.fillStyle = '#ffffff';
    for (const r of clearing.rows) {
      if (r >= HIDDEN) g.fillRect(0, (r - HIDDEN) * cell, W, cell);
    }
    g.restore();
  }

  if (cur) {
    const m = ROT[cur.type][cur.rot];
    const gy = ghostY();

    if (gy !== cur.y) {
      for (let y = 0; y < m.length; y++) {
        for (let x = 0; x < m.length; x++) {
          if (!m[y][x]) continue;
          const by = gy + y;
          if (by < HIDDEN) continue;
          block(g, (cur.x + x) * cell, (by - HIDDEN) * cell, cell, COLORS[cur.type], true);
        }
      }
    }

    for (let y = 0; y < m.length; y++) {
      for (let x = 0; x < m.length; x++) {
        if (!m[y][x]) continue;
        const by = cur.y + y;
        if (by < HIDDEN) continue;
        block(g, (cur.x + x) * cell, (by - HIDDEN) * cell, cell, COLORS[cur.type]);
      }
    }
  }
}

function fitCanvas(cvs) {
  const w = cvs.clientWidth;
  const h = cvs.clientHeight;
  if (!w || !h) return null;
  const dpr = L.dpr;
  const bw = Math.round(w * dpr);
  const bh = Math.round(h * dpr);
  if (cvs.width !== bw || cvs.height !== bh) { cvs.width = bw; cvs.height = bh; }
  const g = cvs.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  return { g: g, w: w, h: h };
}

function drawPreviewList(cvs, types) {
  const fit = fitCanvas(cvs);
  if (!fit) return;
  const g = fit.g;
  const n = Math.max(types.length, 1);
  const slotH = fit.h / n;

  for (let i = 0; i < types.length; i++) {
    const type = types[i];
    if (!type) continue;
    const m = ROT[type][0];

    let minX = 9, maxX = -1, minY = 9, maxY = -1;
    for (let y = 0; y < m.length; y++) {
      for (let x = 0; x < m.length; x++) {
        if (!m[y][x]) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    const pad = 5;
    const cell = Math.floor(Math.min((fit.w - pad * 2) / bw, (slotH - pad * 2) / bh));
    if (cell < 3) continue;

    const ox = (fit.w - bw * cell) / 2 - minX * cell;
    const oy = i * slotH + (slotH - bh * cell) / 2 - minY * cell;

    for (let y = 0; y < m.length; y++) {
      for (let x = 0; x < m.length; x++) {
        if (m[y][x]) block(g, ox + x * cell, oy + y * cell, cell, COLORS[type]);
      }
    }
  }
}

function drawPreviews() {
  drawPreviewList(els.hold, hold ? [hold] : []);
  drawPreviewList(els.next, queue.slice(0, NEXT_COUNT));
}

function updateHUD() {
  setText(els.statScore, fmt(score));
  setText(els.statLevel, String(level));
  setText(els.statLines, String(linesCleared));
}

let toastTimer = 0;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { els.toast.classList.remove('show'); }, 950);
}

/* ------------------------------------------------------------------ layout */

let layoutQueued = false;
function queueLayout() {
  if (layoutQueued) return;
  layoutQueued = true;
  requestAnimationFrame(function () { layoutQueued = false; layout(); });
}

function layout() {
  const stage = els.stage;
  const sw = stage.clientWidth;
  const sh = stage.clientHeight;
  if (!sw || !sh) return;

  const gap = 8;
  const targetGutter = 58;
  let cell = Math.floor(Math.min((sw - (targetGutter + gap) * 2) / COLS, sh / ROWS));
  cell = Math.max(6, cell);

  const fw = cell * COLS;
  const fh = cell * ROWS;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  L.cell = cell;
  L.dpr = dpr;

  const f = els.field;
  const bw = Math.round(fw * dpr);
  const bh = Math.round(fh * dpr);
  if (f.width !== bw || f.height !== bh) { f.width = bw; f.height = bh; }
  f.style.width = fw + 'px';
  f.style.height = fh + 'px';

  let gutter = Math.floor((sw - fw - gap * 2) / 2);
  gutter = Math.max(38, Math.min(gutter, 92));
  els.gutterLeft.style.width = gutter + 'px';
  els.gutterRight.style.width = gutter + 'px';

  drawPreviews();
  render();
}

/* ------------------------------------------------------------------ prefs */

const LS_BEST = 'tetris.best';
const LS_MUTE = 'tetris.muted';

function loadPrefs() {
  try {
    bestScore = parseInt(localStorage.getItem(LS_BEST), 10) || 0;
    muted = localStorage.getItem(LS_MUTE) === '1';
  } catch (e) { /* private mode, storage disabled */ }
}

function saveBest() {
  try { localStorage.setItem(LS_BEST, String(bestScore)); } catch (e) {}
}

function saveMute() {
  try { localStorage.setItem(LS_MUTE, muted ? '1' : '0'); } catch (e) {}
}

/* ------------------------------------------------------------------ audio */

let actx = null;

function audioUnlock() {
  if (actx) { if (actx.state === 'suspended') actx.resume(); return; }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  try { actx = new AC(); } catch (e) { actx = null; }
}

const TONES = {
  move:   [220, 0.030, 'square',   0.040],
  rotate: [340, 0.035, 'square',   0.045],
  lock:   [150, 0.050, 'triangle', 0.055],
  clear:  [660, 0.110, 'sine',     0.065],
  tetris: [880, 0.190, 'sine',     0.080],
  hold:   [440, 0.050, 'sine',     0.045],
  over:   [90,  0.480, 'sawtooth', 0.080],
};

function beep(name) {
  if (muted || !actx || actx.state !== 'running') return;
  const t = TONES[name];
  if (!t) return;
  try {
    const o = actx.createOscillator();
    const g = actx.createGain();
    const now = actx.currentTime;
    o.type = t[2];
    o.frequency.value = t[0];
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(t[3], now + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, now + t[1]);
    o.connect(g);
    g.connect(actx.destination);
    o.start(now);
    o.stop(now + t[1] + 0.02);
  } catch (e) {}
}

/* ------------------------------------------------------------------ lifecycle */

function resetGame() {
  board = [];
  for (let r = 0; r < TOTAL_ROWS; r++) board.push(new Array(COLS).fill(0));

  cur = null;
  hold = null;
  holdUsed = false;
  queue = [];
  bag = [];

  score = 0;
  level = 1;
  linesCleared = 0;
  combo = -1;
  b2b = false;

  gravityAcc = 0;
  grounded = false;
  lockTimer = 0;
  lockResets = 0;
  softDropping = false;
  lastAction = 'spawn';
  lastKick = -1;

  clearing = null;
  phase = 'playing';

  refillQueue();
  updateHUD();
  drawPreviews();
}

function showOverlay(title, sub, best) {
  els.overlayTitle.textContent = title;
  els.overlaySub.textContent = sub;
  els.overlayBest.textContent = best || '';
  els.overlay.classList.remove('hidden');
}

function hideOverlay() {
  els.overlay.classList.add('hidden');
}

function start() {
  stopRepeat('left');
  stopRepeat('right');
  resetGame();
  state = 'playing';
  hideOverlay();
  audioUnlock();
  spawn();
  updateHUD();
}

function pause() {
  if (state !== 'playing') return;
  state = 'paused';
  softDropping = false;
  stopRepeat('left');
  stopRepeat('right');
  showOverlay('Paused', 'Tap to resume');
}

function resume() {
  if (state !== 'paused') return;
  state = 'playing';
  hideOverlay();
}

function gameOver() {
  state = 'over';
  phase = 'playing';
  cur = null;
  clearing = null;
  softDropping = false;
  stopRepeat('left');
  stopRepeat('right');

  const isBest = score > bestScore;
  if (isBest) bestScore = score;
  saveBest();
  beep('over');

  showOverlay(
    'Game Over',
    'Tap to play again',
    'Score ' + fmt(score) + (isBest ? '  ·  New best' : '  ·  Best ' + fmt(bestScore))
  );
  drawPreviews();
}

/* ------------------------------------------------------------------ input */

function startRepeat(dir, key) {
  stopRepeat(key);
  moveHorizontal(dir);
  const r = { das: 0, arr: 0 };
  r.das = setTimeout(function () {
    r.arr = setInterval(function () { moveHorizontal(dir); }, ARR_MS);
  }, DAS_MS);
  repeaters[key] = r;
}

function stopRepeat(key) {
  const r = repeaters[key];
  if (!r) return;
  clearTimeout(r.das);
  clearInterval(r.arr);
  repeaters[key] = null;
}

function press(act) {
  if (state === 'ready' || state === 'over') { start(); return; }
  if (state === 'paused') { resume(); return; }
  if (state !== 'playing' || phase !== 'playing') return;

  switch (act) {
    case 'left':
      stopRepeat('right');
      startRepeat(-1, 'left');
      break;
    case 'right':
      stopRepeat('left');
      startRepeat(1, 'right');
      break;
    case 'softdrop':
      softDropping = true;
      gravityAcc = 0;
      break;
    case 'rotcw':
      if (tryRotate(1)) beep('rotate');
      break;
    case 'rotccw':
      if (tryRotate(-1)) beep('rotate');
      break;
    case 'harddrop':
      hardDrop();
      break;
    case 'hold':
      doHold();
      break;
  }
}

function release(act) {
  if (act === 'left') stopRepeat('left');
  else if (act === 'right') stopRepeat('right');
  else if (act === 'softdrop') { softDropping = false; gravityAcc = 0; }
}

function bindButtons() {
  const buttons = document.querySelectorAll('.btn');
  for (let i = 0; i < buttons.length; i++) {
    const b = buttons[i];
    const act = b.dataset.act;

    b.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      b.classList.add('pressed');
      try { b.setPointerCapture(e.pointerId); } catch (err) {}
      press(act);
    });

    const up = function () {
      b.classList.remove('pressed');
      release(act);
    };
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
    b.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  }
}

function bindGestures() {
  if (!GESTURES) return;
  const el = els.fieldWrap;
  let drag = null;

  el.addEventListener('pointerdown', function (e) {
    if (state === 'ready' || state === 'over') { start(); return; }
    if (state === 'paused') { resume(); return; }
    if (state !== 'playing' || phase !== 'playing') return;
    e.preventDefault();
    drag = { x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, t: performance.now(), dropped: false };
    try { el.setPointerCapture(e.pointerId); } catch (err) {}
  });

  el.addEventListener('pointermove', function (e) {
    if (!drag || !cur || phase !== 'playing') return;
    const cell = L.cell || 24;

    const dx = e.clientX - drag.lx;
    if (Math.abs(dx) >= cell) {
      const steps = Math.trunc(dx / cell);
      for (let i = 0; i < Math.abs(steps); i++) moveHorizontal(steps > 0 ? 1 : -1);
      drag.lx += steps * cell;
    }

    const dy = e.clientY - drag.ly;
    if (dy >= cell) {
      const steps = Math.trunc(dy / cell);
      for (let i = 0; i < steps; i++) if (tryShift(0, 1)) score += 1;
      drag.ly += steps * cell;
      drag.dropped = true;
    }
  });

  const end = function (e) {
    if (!drag) return;
    const dt = performance.now() - drag.t;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (!drag.dropped && dist < 12 && dt < 280) {
      if (tryRotate(1)) beep('rotate');
    } else if (dy > 46 && dt < 240 && Math.abs(dx) < 46) {
      hardDrop();
    } else if (dy < -46 && Math.abs(dx) < 46) {
      doHold();
    }
    drag = null;
  };

  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', function () { drag = null; });
}

function bindKeys() {
  const down = function (e) {
    switch (e.key) {
      case 'ArrowLeft':  press('left'); break;
      case 'ArrowRight': press('right'); break;
      case 'ArrowDown':  press('softdrop'); break;
      case 'ArrowUp':
      case 'x': case 'X': press('rotcw'); break;
      case 'z': case 'Z': press('rotccw'); break;
      case ' ':          press('harddrop'); break;
      case 'c': case 'C': press('hold'); break;
      case 'p': case 'P': case 'Escape': state === 'paused' ? resume() : pause(); break;
      case 'Enter': if (state !== 'playing') start(); break;
      default: return;
    }
    if (e.key !== 'p' && e.key !== 'P' && e.key !== 'Escape') e.preventDefault();
  };
  const up = function (e) {
    switch (e.key) {
      case 'ArrowLeft':  release('left'); break;
      case 'ArrowRight': release('right'); break;
      case 'ArrowDown':  release('softdrop'); break;
    }
  };
  window.addEventListener('keydown', down);
  window.addEventListener('keyup', up);
}

function bindMisc() {
  els.btnPause.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    if (state === 'playing') pause();
    else if (state === 'paused') resume();
  });

  els.btnSound.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    muted = !muted;
    saveMute();
    updateSoundButton();
    audioUnlock();
    if (!muted) beep('hold');
  });

  els.overlay.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    if (state === 'ready' || state === 'over') start();
    else if (state === 'paused') resume();
  });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden && state === 'playing') pause();
  });
}

function updateSoundButton() {
  els.btnSound.classList.toggle('off', muted);
}

/* ------------------------------------------------------------------ boot */

function cacheEls() {
  const byId = function (id) { return document.getElementById(id); };
  els.app = byId('app');
  els.stage = byId('stage');
  els.gutterLeft = byId('gutter-left');
  els.gutterRight = byId('gutter-right');
  els.fieldWrap = byId('field-wrap');
  els.field = byId('field');
  els.hold = byId('hold');
  els.next = byId('next');
  els.overlay = byId('overlay');
  els.overlayTitle = byId('overlay-title');
  els.overlaySub = byId('overlay-sub');
  els.overlayBest = byId('overlay-best');
  els.toast = byId('toast');
  els.statScore = byId('stat-score');
  els.statLevel = byId('stat-level');
  els.statLines = byId('stat-lines');
  els.btnPause = byId('btn-pause');
  els.btnSound = byId('btn-sound');
  els.soundGlyph = byId('sound-glyph');
}

function init() {
  cacheEls();
  loadPrefs();

  bindButtons();
  bindGestures();
  bindKeys();
  bindMisc();
  updateSoundButton();

  resetGame();
  state = 'ready';
  showOverlay('Tetris', 'Tap to start', bestScore ? 'Best ' + fmt(bestScore) : '');

  layout();
  queueLayout();

  if (window.ResizeObserver) new ResizeObserver(queueLayout).observe(els.stage);
  window.addEventListener('resize', queueLayout);
  window.addEventListener('orientationchange', function () { setTimeout(queueLayout, 120); });

  const secure = location.protocol === 'https:' ||
                 location.hostname === 'localhost' ||
                 location.hostname === '127.0.0.1';
  if ('serviceWorker' in navigator && secure) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    });
  }

  requestAnimationFrame(frame);
}

init();

/* ------------------------------------------------------------------ debug

   Exposed only when the page is loaded with ?debug=1, so it costs nothing in
   production. Used by tools/selftest.html to exercise the engine directly. */

if (new URLSearchParams(location.search).has('debug')) {
  window.__tetris = {
    COLS: COLS, ROWS: ROWS, HIDDEN: HIDDEN, TOTAL_ROWS: TOTAL_ROWS,
    SPAWN_X: SPAWN_X, SPAWN_Y: SPAWN_Y, TYPES: TYPES, TONES: TONES,

    ROT: ROT, COLORS: COLORS, SHAPES: SHAPES,
    KICKS_JLSTZ: KICKS_JLSTZ, KICKS_I: KICKS_I,

    press: press, release: release, start: start, pause: pause, resume: resume,
    spawn: spawn, hardDrop: hardDrop, doHold: doHold,
    tryShift: tryShift, tryRotate: tryRotate, ghostY: ghostY,
    lockPiece: lockPiece, detectTSpin: detectTSpin, step: step,
    render: render, drawPreviews: drawPreviews, layout: layout,
    resetGame: resetGame, nextFromBag: nextFromBag,

    get board() { return board; },
    get cur() { return cur; },
    get state() { return state; },
    get phase() { return phase; },
    get score() { return score; },
    get level() { return level; },
    get lines() { return linesCleared; },
    get combo() { return combo; },
    get b2b() { return b2b; },
    get queue() { return queue.slice(); },
    get bag() { return bag.slice(); },
    get hold() { return hold; },
    get holdUsed() { return holdUsed; },
    get lockResets() { return lockResets; },
    get grounded() { return grounded; },
    get lockTimer() { return lockTimer; },

    setBoard: function (b) { board = b; },
    setCur: function (c) { cur = c; },
    setLastAction: function (a) { lastAction = a; },
    setLastKick: function (k) { lastKick = k; },
    setPhase: function (p) { phase = p; },
    setScore: function (n) { score = n; },
  };
}

