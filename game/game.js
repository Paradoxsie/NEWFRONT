const SIM_HZ = 20;
const DT = 1 / SIM_HZ;
const DOMINATION_TARGET = 0.72;

const BUILDINGS = {
  NONE: 0,
  CITY: 1,
  DEFENSE: 2
};

const TERRAIN = {
  WATER: 0,
  PLAINS: 1,
  MOUNTAIN: 2
};

const mapCanvas = document.getElementById('mapCanvas');
const overlayCanvas = document.getElementById('overlayCanvas');
const ctx = mapCanvas.getContext('2d', { alpha: false });
const octx = overlayCanvas.getContext('2d');

const ui = {
  gold: document.getElementById('gold'),
  pop: document.getElementById('pop'),
  land: document.getElementById('land'),
  winState: document.getElementById('winState'),
  workersSlider: document.getElementById('workersSlider'),
  workersValue: document.getElementById('workersValue'),
  attackSlider: document.getElementById('attackSlider'),
  attackValue: document.getElementById('attackValue'),
  buildCity: document.getElementById('buildCity'),
  buildDefense: document.getElementById('buildDefense')
};

let mapDef;
let W;
let H;
let TILE_SIZE = 8;
let owner;
let terrain;
let building;
let bLevel;
let front;
let landIndexes = [];
let totalLandTiles = 0;
let pendingBuildType = BUILDINGS.NONE;

const factions = [
  null,
  { id: 1, name: 'Player', color: '#70c0ff', gold: 250, popCurrent: 1800, popCap: 2200, workerPct: 0.55, attackRatio: 0.25, tilesOwned: 0, landTilesOwned: 0, workers: 0, troops: 0, bot: false },
  { id: 2, name: 'Bot Ember', color: '#ff7763', gold: 180, popCurrent: 1400, popCap: 2100, workerPct: 0.58, attackRatio: 0.22, tilesOwned: 0, landTilesOwned: 0, workers: 0, troops: 0, bot: true },
  { id: 3, name: 'Bot Moss', color: '#72d28c', gold: 180, popCurrent: 1400, popCap: 2100, workerPct: 0.54, attackRatio: 0.26, tilesOwned: 0, landTilesOwned: 0, workers: 0, troops: 0, bot: true },
  { id: 4, name: 'Bot Violet', color: '#b294ff', gold: 180, popCurrent: 1400, popCap: 2100, workerPct: 0.52, attackRatio: 0.24, tilesOwned: 0, landTilesOwned: 0, workers: 0, troops: 0, bot: true }
];

const attacks = [];

function idx(x, y) {
  return x + y * W;
}

function inBounds(x, y) {
  return x >= 0 && y >= 0 && x < W && y < H;
}

function forNeighbors(x, y, cb) {
  cb(x - 1, y);
  cb(x + 1, y);
  cb(x, y - 1);
  cb(x, y + 1);
}

async function loadMap() {
  const res = await fetch('./maps/europe_384x216.json');
  mapDef = await res.json();
  W = mapDef.width;
  H = mapDef.height;
}

function generateWorld() {
  owner = new Uint8Array(W * H);
  terrain = new Uint8Array(W * H);
  building = new Uint8Array(W * H);
  bLevel = new Uint8Array(W * H);
  front = new Float32Array(W * H);
  landIndexes = [];

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = idx(x, y);
      const dx = (x - W * 0.55) / (W * 0.45);
      const dy = (y - H * 0.48) / (H * 0.52);
      const ellipse = dx * dx + dy * dy;
      const wave = 0.08 * Math.sin(x * 0.19) + 0.1 * Math.cos(y * 0.17);
      const isLand = ellipse + wave < 0.9 && x > 4 && x < W - 4 && y > 3 && y < H - 3;

      if (!isLand) {
        terrain[i] = TERRAIN.WATER;
      } else {
        terrain[i] = Math.random() < 0.14 ? TERRAIN.MOUNTAIN : TERRAIN.PLAINS;
        landIndexes.push(i);
      }
    }
  }

  totalLandTiles = landIndexes.length;

  for (const sp of mapDef.spawnPoints) {
    const center = idx(sp.x, sp.y);
    for (let oy = -3; oy <= 3; oy++) {
      for (let ox = -3; ox <= 3; ox++) {
        const x = sp.x + ox;
        const y = sp.y + oy;
        if (!inBounds(x, y)) continue;
        const i = idx(x, y);
        if (terrain[i] === TERRAIN.WATER) continue;
        if (Math.abs(ox) + Math.abs(oy) <= 4) owner[i] = sp.faction;
      }
    }
    building[center] = BUILDINGS.CITY;
    bLevel[center] = 1;
  }

  recalcFactionCaches();
}

function recalcFactionCaches() {
  for (const f of factions) {
    if (!f) continue;
    f.tilesOwned = 0;
    f.landTilesOwned = 0;
    f.cityCount = 0;
  }

  for (const i of landIndexes) {
    const o = owner[i];
    if (!o) continue;
    factions[o].tilesOwned++;
    factions[o].landTilesOwned++;
    if (building[i] === BUILDINGS.CITY) factions[o].cityCount++;
  }

  for (const f of factions) {
    if (!f) continue;
    f.popCap = 600 + f.landTilesOwned * 11 + f.cityCount * 25000;
    if (f.popCurrent > f.popCap) f.popCurrent = f.popCap;
    f.workers = f.popCurrent * f.workerPct;
    f.troops = f.popCurrent - f.workers;
  }
}

function doEconomyTick() {
  for (const f of factions) {
    if (!f || f.landTilesOwned <= 0) continue;
    const ratio = f.popCurrent / Math.max(1, f.popCap);
    const shape = Math.max(0, 1 - ((ratio - 0.45) / 0.45) ** 2);
    const growth = 0.052 * shape;
    f.popCurrent += f.popCurrent * growth * DT;
    if (f.popCurrent > f.popCap) f.popCurrent = f.popCap;

    f.workers = f.popCurrent * f.workerPct;
    f.troops = f.popCurrent - f.workers;
    f.gold += f.workers * 0.018 * DT;
  }
}

function queueAttack(attackerId, targetIndex, pressure = 1) {
  if (terrain[targetIndex] === TERRAIN.WATER) return;
  const defender = owner[targetIndex];
  if (!defender || defender === attackerId) return;
  attacks.push({ attackerId, defenderId: defender, targetIndex, pressure });
}

function doCombatTick() {
  while (attacks.length) {
    const a = attacks.pop();
    const atk = factions[a.attackerId];
    const def = factions[a.defenderId];
    if (!atk || !def || atk.landTilesOwned <= 0 || def.landTilesOwned <= 0) continue;
    if (owner[a.targetIndex] !== a.defenderId) continue;

    const commit = atk.troops * atk.attackRatio * 0.06 * a.pressure;
    if (commit < 1) continue;
    const density = def.troops / Math.max(1, def.landTilesOwned);
    let defense = density * 4.4;
    if (terrain[a.targetIndex] === TERRAIN.MOUNTAIN) defense *= 1.55;
    if (building[a.targetIndex] === BUILDINGS.DEFENSE) defense *= 1.45 + bLevel[a.targetIndex] * 0.1;

    const delta = (commit - defense) * 0.015;
    front[a.targetIndex] += delta;

    const atkLoss = Math.max(0.4, defense * 0.018);
    const defLoss = Math.max(0.25, commit * 0.012);
    atk.popCurrent = Math.max(1, atk.popCurrent - atkLoss);
    def.popCurrent = Math.max(1, def.popCurrent - defLoss);

    if (front[a.targetIndex] > 1) {
      flipTile(a.targetIndex, a.attackerId, a.defenderId);
      front[a.targetIndex] = 0;
    }
  }

  for (let i = 0; i < front.length; i++) front[i] *= 0.84;
}

function flipTile(tileIndex, newOwner, oldOwner) {
  owner[tileIndex] = newOwner;
  if (building[tileIndex] && Math.random() < 0.35) {
    building[tileIndex] = BUILDINGS.NONE;
    bLevel[tileIndex] = 0;
  }
  recalcFactionCaches();
  detectEnclosureAround(tileIndex, oldOwner, newOwner);
}

function detectEnclosureAround(tileIndex, displacedFaction, enclosingFaction) {
  if (!displacedFaction || displacedFaction === enclosingFaction) return;

  const tx = tileIndex % W;
  const ty = Math.floor(tileIndex / W);
  const visited = new Uint8Array(W * H);

  forNeighbors(tx, ty, (nx, ny) => {
    if (!inBounds(nx, ny)) return;
    const start = idx(nx, ny);
    if (visited[start] || owner[start] !== displacedFaction) return;

    const q = [start];
    visited[start] = 1;
    const pocket = [start];
    let touchesEdge = false;

    for (let qi = 0; qi < q.length; qi++) {
      const cur = q[qi];
      const x = cur % W;
      const y = (cur / W) | 0;
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) touchesEdge = true;

      forNeighbors(x, y, (ax, ay) => {
        if (!inBounds(ax, ay)) return;
        const ni = idx(ax, ay);
        if (visited[ni] || owner[ni] !== displacedFaction) return;
        visited[ni] = 1;
        q.push(ni);
        pocket.push(ni);
      });
    }

    if (!touchesEdge) {
      for (const p of pocket) owner[p] = enclosingFaction;
    }
  });

  recalcFactionCaches();
}

function doBotsTick(elapsedTicks) {
  if (elapsedTicks % SIM_HZ !== 0) return;

  for (const f of factions) {
    if (!f?.bot || f.landTilesOwned <= 0) continue;

    if (f.popCap - f.popCurrent < 240 && f.gold > 130) botBuild(f, BUILDINGS.CITY);
    else if (f.gold > 95) botBuild(f, BUILDINGS.DEFENSE);

    const candidates = [];
    for (const i of landIndexes) {
      if (owner[i] !== f.id) continue;
      const x = i % W;
      const y = (i / W) | 0;
      forNeighbors(x, y, (nx, ny) => {
        if (!inBounds(nx, ny)) return;
        const ni = idx(nx, ny);
        if (terrain[ni] === TERRAIN.WATER) return;
        const o = owner[ni];
        if (o === f.id) return;

        let score = o === 0 ? 10 : 18;
        if (terrain[ni] === TERRAIN.MOUNTAIN) score -= 8;
        if (o !== 0) {
          const enemyDensity = factions[o].troops / Math.max(1, factions[o].landTilesOwned);
          score += Math.max(0, 10 - enemyDensity * 3);
        }
        candidates.push([ni, score]);
      });
    }

    candidates.sort((a, b) => b[1] - a[1]);
    const bursts = Math.min(5, candidates.length);
    for (let j = 0; j < bursts; j++) {
      queueAttack(f.id, candidates[j][0], 0.7 + Math.random() * 0.7);
    }
  }
}

function botBuild(f, kind) {
  const cost = kind === BUILDINGS.CITY ? 120 : 90;
  if (f.gold < cost) return;
  const owned = [];
  for (const i of landIndexes) if (owner[i] === f.id && building[i] === BUILDINGS.NONE) owned.push(i);
  if (!owned.length) return;

  const chosen = owned[(Math.random() * owned.length) | 0];
  building[chosen] = kind;
  bLevel[chosen] = 1;
  f.gold -= cost;
  recalcFactionCaches();
}

function isBorderEnemyTile(tileIndex, attackerId) {
  const x = tileIndex % W;
  const y = (tileIndex / W) | 0;
  let adjacentOwned = false;
  forNeighbors(x, y, (nx, ny) => {
    if (!inBounds(nx, ny)) return;
    if (owner[idx(nx, ny)] === attackerId) adjacentOwned = true;
  });
  return adjacentOwned;
}

function buildAtPlayerTile(tileIndex, type) {
  const player = factions[1];
  const cost = type === BUILDINGS.CITY ? 120 : 90;
  if (owner[tileIndex] !== 1 || building[tileIndex] !== BUILDINGS.NONE || player.gold < cost) return;
  building[tileIndex] = type;
  bLevel[tileIndex] = 1;
  player.gold -= cost;
  recalcFactionCaches();
}

function setupInput() {
  ui.workersSlider.addEventListener('input', () => {
    factions[1].workerPct = Number(ui.workersSlider.value) / 100;
    ui.workersValue.textContent = `${ui.workersSlider.value}%`;
  });

  ui.attackSlider.addEventListener('input', () => {
    factions[1].attackRatio = Number(ui.attackSlider.value) / 100;
    ui.attackValue.textContent = `${ui.attackSlider.value}%`;
  });

  ui.buildCity.addEventListener('click', () => {
    pendingBuildType = BUILDINGS.CITY;
  });

  ui.buildDefense.addEventListener('click', () => {
    pendingBuildType = BUILDINGS.DEFENSE;
  });

  let scale = 1;
  mapCanvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    scale += e.deltaY < 0 ? 0.1 : -0.1;
    scale = Math.min(2.3, Math.max(0.7, scale));
    TILE_SIZE = Math.round(8 * scale);
    resizeCanvas();
  });

  mapCanvas.addEventListener('contextmenu', (e) => e.preventDefault());
  mapCanvas.addEventListener('mousedown', (e) => {
    const r = mapCanvas.getBoundingClientRect();
    const x = ((e.clientX - r.left) / TILE_SIZE) | 0;
    const y = ((e.clientY - r.top) / TILE_SIZE) | 0;
    if (!inBounds(x, y)) return;
    const i = idx(x, y);

    if (e.button === 2) {
      if (pendingBuildType !== BUILDINGS.NONE) {
        buildAtPlayerTile(i, pendingBuildType);
        pendingBuildType = BUILDINGS.NONE;
      }
      return;
    }

    if (owner[i] && owner[i] !== 1 && isBorderEnemyTile(i, 1)) {
      queueAttack(1, i, 1);
    }
  });
}

function resizeCanvas() {
  mapCanvas.width = W * TILE_SIZE;
  mapCanvas.height = H * TILE_SIZE;
  overlayCanvas.width = mapCanvas.width;
  overlayCanvas.height = mapCanvas.height;
}

function render() {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = idx(x, y);
      let color = '#25415c';
      if (terrain[i] !== TERRAIN.WATER) {
        const o = owner[i];
        color = o ? factions[o].color : '#7f8e76';
        if (terrain[i] === TERRAIN.MOUNTAIN) color = shade(color, -30);
      }
      ctx.fillStyle = color;
      ctx.fillRect(x * TILE_SIZE, y * TILE_SIZE, TILE_SIZE, TILE_SIZE);

      if (building[i]) {
        ctx.fillStyle = building[i] === BUILDINGS.CITY ? '#f5de8f' : '#ffd7b7';
        ctx.fillRect(x * TILE_SIZE + TILE_SIZE * 0.25, y * TILE_SIZE + TILE_SIZE * 0.25, TILE_SIZE * 0.5, TILE_SIZE * 0.5);
      }
    }
  }

  octx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  octx.globalAlpha = 0.7;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = idx(x, y);
      if (front[i] <= 0.08) continue;
      octx.fillStyle = '#ffffff';
      octx.fillRect(x * TILE_SIZE, y * TILE_SIZE, TILE_SIZE, TILE_SIZE);
    }
  }
  octx.globalAlpha = 1;

  updateHud();
}

function updateHud() {
  const p = factions[1];
  ui.gold.textContent = `Gold: ${p.gold.toFixed(0)}`;
  ui.pop.textContent = `Pop: ${p.popCurrent.toFixed(0)} / ${p.popCap.toFixed(0)}`;
  const ratio = p.landTilesOwned / Math.max(1, totalLandTiles);
  ui.land.textContent = `Land: ${(ratio * 100).toFixed(1)}%`;

  if (ratio >= DOMINATION_TARGET) ui.winState.textContent = 'Victory: Domination achieved!';
  else if (p.landTilesOwned <= 0) ui.winState.textContent = 'Defeat: You were eliminated.';
  else ui.winState.textContent = 'Objective: 72% domination';
}

function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, Math.max(0, (n >> 16) + amt));
  const g = Math.min(255, Math.max(0, ((n >> 8) & 0xff) + amt));
  const b = Math.min(255, Math.max(0, (n & 0xff) + amt));
  return `rgb(${r},${g},${b})`;
}

let prev = 0;
let acc = 0;
let ticks = 0;

function frame(ts) {
  if (!prev) prev = ts;
  const delta = Math.min(0.05, (ts - prev) / 1000);
  prev = ts;
  acc += delta;

  while (acc >= DT) {
    doEconomyTick();
    doCombatTick();
    doBotsTick(ticks);
    ticks++;
    acc -= DT;
  }

  render();
  requestAnimationFrame(frame);
}

async function boot() {
  await loadMap();
  generateWorld();
  resizeCanvas();
  setupInput();
  requestAnimationFrame(frame);
}

boot();
