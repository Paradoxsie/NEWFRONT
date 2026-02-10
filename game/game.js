const W = 128;
const H = 72;
const TILE = 8;
const TICK_RATE = 20;
const TICK = 1 / TICK_RATE;

const BUILDING = { NONE: 0, CITY: 1, DEFENSE: 2 };
const TERRAIN = { WATER: 0, PLAINS: 1, MOUNTAIN: 2 };

const canvas = document.getElementById("map");
const overlay = document.getElementById("overlay");
canvas.width = overlay.width = W * TILE;
canvas.height = overlay.height = H * TILE;
const ctx = canvas.getContext("2d");
const octx = overlay.getContext("2d");

const owner = new Uint8Array(W * H);
const terrain = new Uint8Array(W * H);
const building = new Uint8Array(W * H);
const bLevel = new Uint8Array(W * H);
const front = new Float32Array(W * H);

const factions = {
  1: makeFaction(1, "Player", "#60a5fa"),
  2: makeFaction(2, "Bot Red", "#ef4444"),
  3: makeFaction(3, "Bot Green", "#22c55e")
};

const state = {
  workerPct: 0.6,
  attackRatio: 0.2,
  selectedBuild: BUILDING.NONE,
  hoverIdx: -1,
  mouseDown: false,
  targetIdx: -1,
  accumulator: 0,
  lastMs: performance.now(),
  winner: 0,
  botClock: 0
};

function makeFaction(id, name, color) {
  return {
    id,
    name,
    color,
    gold: 200,
    popCurrent: 180,
    popCap: 600,
    workerPct: 0.6,
    attackRatio: 0.2,
    tilesOwned: 0,
    landTilesOwned: 0,
    workers: 0,
    troops: 0
  };
}

function idx(x, y) { return x + y * W; }
function inBounds(x, y) { return x >= 0 && y >= 0 && x < W && y < H; }

function setupMap() {
  const cx = W / 2;
  const cy = H / 2;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = idx(x, y);
      const dx = (x - cx) / (W * 0.45);
      const dy = (y - cy) / (H * 0.38);
      const dist = dx * dx + dy * dy;
      terrain[i] = dist < 1.0 ? TERRAIN.PLAINS : TERRAIN.WATER;
      if (terrain[i] === TERRAIN.PLAINS && Math.random() < 0.08) terrain[i] = TERRAIN.MOUNTAIN;
    }
  }
  seedFaction(1, 24, 36);
  seedFaction(2, 96, 24);
  seedFaction(3, 96, 50);
  recomputeOwnership();
}

function seedFaction(fid, sx, sy) {
  for (let y = sy - 4; y <= sy + 4; y++) {
    for (let x = sx - 4; x <= sx + 4; x++) {
      if (!inBounds(x, y)) continue;
      const i = idx(x, y);
      if (terrain[i] === TERRAIN.WATER) continue;
      owner[i] = fid;
    }
  }
}

function recomputeOwnership() {
  for (const f of Object.values(factions)) {
    f.tilesOwned = 0;
    f.landTilesOwned = 0;
  }
  for (let i = 0; i < owner.length; i++) {
    const o = owner[i];
    if (!o) continue;
    factions[o].tilesOwned++;
    if (terrain[i] !== TERRAIN.WATER) factions[o].landTilesOwned++;
  }
}

function popGrowthFactor(ratio) {
  // bell-ish peak near 0.45
  const center = 0.45;
  const width = 0.35;
  const n = (ratio - center) / width;
  return Math.max(0, 1 - n * n);
}

function updateEconomy(dt) {
  for (const f of Object.values(factions)) {
    let cityBonus = 0;
    for (let i = 0; i < building.length; i++) {
      if (owner[i] === f.id && building[i] === BUILDING.CITY) cityBonus += 25000 * Math.max(1, bLevel[i]);
    }

    f.popCap = 400 + f.landTilesOwned * 8 + cityBonus;
    const ratio = Math.max(0, Math.min(1, f.popCurrent / Math.max(1, f.popCap)));
    const peak = 0.7;
    const growth = peak * popGrowthFactor(ratio);
    f.popCurrent += f.popCurrent * growth * dt;
    f.popCurrent = Math.min(f.popCap, f.popCurrent);

    f.workers = f.popCurrent * f.workerPct;
    f.troops = f.popCurrent * (1 - f.workerPct);
    f.gold += f.workers * 0.012 * dt;
  }
}

function isBorderAgainst(fid, i, enemy) {
  const x = i % W;
  const y = (i / W) | 0;
  const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
  for (const [dx, dy] of dirs) {
    const nx = x + dx;
    const ny = y + dy;
    if (!inBounds(nx, ny)) continue;
    const ni = idx(nx, ny);
    if (owner[ni] === fid && owner[i] === enemy) return true;
  }
  return false;
}

function applyAttack(attackerId, targetIndex, commitment = null) {
  const defId = owner[targetIndex];
  if (!defId || defId === attackerId || terrain[targetIndex] === TERRAIN.WATER) return;
  if (!isBorderAgainst(attackerId, targetIndex, defId)) return;

  const atk = factions[attackerId];
  const def = factions[defId];
  const attackRatio = commitment ?? atk.attackRatio;

  const committed = atk.troops * attackRatio * 0.08;
  if (committed < 1) return;

  const density = def.troops / Math.max(1, def.landTilesOwned);
  let defense = density * 2.2;
  if (terrain[targetIndex] === TERRAIN.MOUNTAIN) defense *= 1.4;
  if (building[targetIndex] === BUILDING.DEFENSE) defense *= 1.6;

  const pressure = committed - defense;
  front[targetIndex] += pressure * 0.02;

  atk.popCurrent = Math.max(1, atk.popCurrent - committed * 0.35);
  def.popCurrent = Math.max(1, def.popCurrent - Math.max(0, committed * 0.12));

  if (front[targetIndex] >= 1) {
    owner[targetIndex] = attackerId;
    front[targetIndex] = 0;
    checkEnclosure(defId, attackerId);
    recomputeOwnership();
  }
}

function checkEnclosure(defenderId, enclosingId) {
  const seen = new Uint8Array(W * H);
  const stack = [];
  const alive = new Uint8Array(W * H);

  for (let x = 0; x < W; x++) {
    const top = idx(x, 0);
    const bot = idx(x, H - 1);
    if (owner[top] === defenderId) stack.push(top);
    if (owner[bot] === defenderId) stack.push(bot);
  }
  for (let y = 0; y < H; y++) {
    const left = idx(0, y);
    const right = idx(W - 1, y);
    if (owner[left] === defenderId) stack.push(left);
    if (owner[right] === defenderId) stack.push(right);
  }

  while (stack.length) {
    const cur = stack.pop();
    if (seen[cur]) continue;
    seen[cur] = 1;
    alive[cur] = 1;
    const x = cur % W;
    const y = (cur / W) | 0;
    const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
    for (const [dx, dy] of dirs) {
      const nx = x + dx;
      const ny = y + dy;
      if (!inBounds(nx, ny)) continue;
      const ni = idx(nx, ny);
      if (!seen[ni] && owner[ni] === defenderId) stack.push(ni);
    }
  }

  for (let i = 0; i < owner.length; i++) {
    if (owner[i] === defenderId && !alive[i]) {
      owner[i] = enclosingId;
      building[i] = BUILDING.NONE;
      bLevel[i] = 0;
      front[i] = 0;
    }
  }
}

function runBotLogic(dt) {
  state.botClock += dt;
  if (state.botClock < 0.6) return;
  state.botClock = 0;
  for (const id of [2, 3]) {
    const f = factions[id];
    f.workerPct = f.popCurrent < f.popCap * 0.5 ? 0.5 : 0.6;
    f.attackRatio = f.popCurrent > f.popCap * 0.6 ? 0.3 : 0.15;

    let bestNeutral = -1;
    let bestEnemy = -1;
    for (let i = 0; i < owner.length; i++) {
      if (terrain[i] === TERRAIN.WATER) continue;
      const x = i % W;
      const y = (i / W) | 0;
      const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
      for (const [dx, dy] of dirs) {
        const nx = x + dx;
        const ny = y + dy;
        if (!inBounds(nx, ny)) continue;
        const ni = idx(nx, ny);
        if (owner[ni] !== id) continue;
        if (owner[i] === 0 && bestNeutral === -1) bestNeutral = i;
        if (owner[i] && owner[i] !== id) {
          if (building[i] !== BUILDING.DEFENSE || Math.random() < 0.25) bestEnemy = i;
        }
      }
    }

    if (bestNeutral !== -1) owner[bestNeutral] = id;
    if (bestEnemy !== -1) applyAttack(id, bestEnemy, f.attackRatio);

    if (f.gold > 130 && f.popCap < 2000) {
      const tile = randomOwnedTile(id);
      if (tile !== -1 && !building[tile]) {
        building[tile] = BUILDING.CITY;
        bLevel[tile] = 1;
        f.gold -= 120;
      }
    }
    recomputeOwnership();
  }
}

function randomOwnedTile(fid) {
  for (let tries = 0; tries < 400; tries++) {
    const i = (Math.random() * owner.length) | 0;
    if (owner[i] === fid && terrain[i] !== TERRAIN.WATER) return i;
  }
  return -1;
}

function update(dt) {
  factions[1].workerPct = state.workerPct;
  factions[1].attackRatio = state.attackRatio;

  updateEconomy(dt);
  if (state.mouseDown && state.targetIdx >= 0) applyAttack(1, state.targetIdx);
  runBotLogic(dt);
  decayFront(dt);
  checkWinLose();
}

function decayFront(dt) {
  for (let i = 0; i < front.length; i++) front[i] *= Math.max(0, 1 - dt * 5);
}

function checkWinLose() {
  const landTotal = countLand();
  const playerLand = factions[1].landTilesOwned;
  if (playerLand <= 0) state.winner = -1;
  if (playerLand / Math.max(1, landTotal) >= 0.72) state.winner = 1;
}

function countLand() {
  let total = 0;
  for (let i = 0; i < terrain.length; i++) if (terrain[i] !== TERRAIN.WATER) total++;
  return total;
}

function render() {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = idx(x, y);
      let color = "#0b2e13";
      if (terrain[i] === TERRAIN.WATER) color = "#1e3a8a";
      if (terrain[i] === TERRAIN.MOUNTAIN) color = "#4b5563";
      const o = owner[i];
      if (o) color = shadeColor(factions[o].color, terrain[i] === TERRAIN.MOUNTAIN ? -18 : 0);
      ctx.fillStyle = color;
      ctx.fillRect(x * TILE, y * TILE, TILE, TILE);

      if (building[i] === BUILDING.CITY) {
        ctx.fillStyle = "#f59e0b";
        ctx.fillRect(x * TILE + 2, y * TILE + 2, TILE - 4, TILE - 4);
      } else if (building[i] === BUILDING.DEFENSE) {
        ctx.fillStyle = "#e5e7eb";
        ctx.fillRect(x * TILE + 1, y * TILE + 1, TILE - 2, TILE - 2);
      }
    }
  }

  octx.clearRect(0, 0, overlay.width, overlay.height);
  for (let i = 0; i < front.length; i++) {
    if (front[i] <= 0.04) continue;
    const x = i % W;
    const y = (i / W) | 0;
    octx.fillStyle = `rgba(255,255,255,${Math.min(0.7, front[i])})`;
    octx.fillRect(x * TILE, y * TILE, TILE, TILE);
  }

  if (state.hoverIdx >= 0) {
    const x = state.hoverIdx % W;
    const y = (state.hoverIdx / W) | 0;
    octx.strokeStyle = "#fde047";
    octx.lineWidth = 2;
    octx.strokeRect(x * TILE + 1, y * TILE + 1, TILE - 2, TILE - 2);
  }

  if (state.winner !== 0) {
    octx.fillStyle = "rgba(0,0,0,0.6)";
    octx.fillRect(0, 0, overlay.width, overlay.height);
    octx.fillStyle = "white";
    octx.font = "bold 42px sans-serif";
    octx.fillText(state.winner === 1 ? "Victory" : "Defeat", overlay.width / 2 - 70, overlay.height / 2);
  }

  updateHud();
}

function shadeColor(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, Math.max(0, (n >> 16) + amt));
  const g = Math.min(255, Math.max(0, ((n >> 8) & 255) + amt));
  const b = Math.min(255, Math.max(0, (n & 255) + amt));
  return `rgb(${r},${g},${b})`;
}

function updateHud() {
  const p = factions[1];
  const landPct = ((p.landTilesOwned / Math.max(1, countLand())) * 100).toFixed(1);
  document.getElementById("gold").textContent = `Gold: ${Math.floor(p.gold)}`;
  document.getElementById("pop").textContent = `Pop: ${Math.floor(p.popCurrent)} / ${Math.floor(p.popCap)}`;
  document.getElementById("land").textContent = `Land: ${landPct}%`;
}

function tileFromMouse(ev) {
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor((ev.clientX - rect.left) / TILE);
  const y = Math.floor((ev.clientY - rect.top) / TILE);
  if (!inBounds(x, y)) return -1;
  return idx(x, y);
}

canvas.addEventListener("mousemove", (ev) => {
  state.hoverIdx = tileFromMouse(ev);
});
canvas.addEventListener("mousedown", (ev) => {
  if (state.winner !== 0) return;
  const i = tileFromMouse(ev);
  if (i < 0) return;

  if (ev.button === 2) {
    const own = owner[i] === 1;
    if (own && state.selectedBuild !== BUILDING.NONE) tryBuild(i, state.selectedBuild);
    return;
  }

  if (ev.button === 0) {
    state.mouseDown = true;
    state.targetIdx = i;
  }
});
canvas.addEventListener("mouseup", () => { state.mouseDown = false; state.targetIdx = -1; });
canvas.addEventListener("mouseleave", () => { state.mouseDown = false; state.targetIdx = -1; state.hoverIdx = -1; });
canvas.addEventListener("contextmenu", (ev) => ev.preventDefault());

function tryBuild(i, type) {
  const p = factions[1];
  if (owner[i] !== 1 || building[i] !== BUILDING.NONE || terrain[i] === TERRAIN.WATER) return;
  if (type === BUILDING.CITY && p.gold >= 120) {
    building[i] = BUILDING.CITY;
    bLevel[i] = 1;
    p.gold -= 120;
  }
  if (type === BUILDING.DEFENSE && p.gold >= 80) {
    building[i] = BUILDING.DEFENSE;
    bLevel[i] = 1;
    p.gold -= 80;
  }
}

document.getElementById("workers").addEventListener("input", (ev) => {
  const v = Number(ev.target.value);
  state.workerPct = v / 100;
  document.getElementById("workersValue").textContent = `${v}%`;
});
document.getElementById("attack").addEventListener("input", (ev) => {
  const v = Number(ev.target.value);
  state.attackRatio = v / 100;
  document.getElementById("attackValue").textContent = `${v}%`;
});
document.getElementById("buildCity").addEventListener("click", () => {
  state.selectedBuild = BUILDING.CITY;
});
document.getElementById("buildDefense").addEventListener("click", () => {
  state.selectedBuild = BUILDING.DEFENSE;
});

function frame(ms) {
  const dt = Math.min(0.1, (ms - state.lastMs) / 1000);
  state.lastMs = ms;
  state.accumulator += dt;
  while (state.accumulator >= TICK) {
    update(TICK);
    state.accumulator -= TICK;
  }
  render();
  requestAnimationFrame(frame);
}

setupMap();
requestAnimationFrame(frame);
