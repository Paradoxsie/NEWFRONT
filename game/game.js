const MAP_W = 192;
const MAP_H = 108;
const TILE_SIZE = 6;
const TICK_RATE = 20;
const FIXED_DT = 1 / TICK_RATE;
const LAND_WIN = 0.72;

const Terrain = {
  WATER: 0,
  PLAINS: 1,
  MOUNTAIN: 2,
};

const Building = {
  NONE: 0,
  CITY: 1,
  DEFENSE: 2,
};

const costs = {
  city: 1200,
  defense: 700,
};

const factionColors = ['#5a647b', '#4a9eff', '#ff6f61', '#8fdf6a', '#d885ff'];

const W = MAP_W;
const H = MAP_H;
const SIZE = W * H;

const owner = new Uint8Array(SIZE);
const terrain = new Uint8Array(SIZE);
const building = new Uint8Array(SIZE);
const bLevel = new Uint8Array(SIZE);
const front = new Float32Array(SIZE);

const factions = [
  null,
  makeFaction(1, 'Player', factionColors[1]),
  makeFaction(2, 'Bot A', factionColors[2]),
  makeFaction(3, 'Bot B', factionColors[3]),
];

const bots = [2, 3];
let playerSelectedTile = -1;
let attackTarget = -1;
let tickAccumulator = 0;
let lastTs = performance.now();
let gameOver = false;
let winner = '';

const gameCanvas = document.getElementById('gameCanvas');
gameCanvas.width = W * TILE_SIZE;
gameCanvas.height = H * TILE_SIZE;
const ctx = gameCanvas.getContext('2d', { alpha: false });

const overlayCanvas = document.getElementById('overlayCanvas');
overlayCanvas.width = gameCanvas.width;
overlayCanvas.height = gameCanvas.height;
const octx = overlayCanvas.getContext('2d');

const workerSlider = document.getElementById('workerSlider');
const workerValue = document.getElementById('workerValue');
const attackSlider = document.getElementById('attackSlider');
const attackValue = document.getElementById('attackValue');
const goldText = document.getElementById('gold');
const popText = document.getElementById('pop');
const landText = document.getElementById('land');
const buildCityBtn = document.getElementById('buildCity');
const buildDefenseBtn = document.getElementById('buildDefense');

function makeFaction(id, name, color) {
  return {
    id,
    name,
    color,
    gold: 800,
    popCurrent: 1500,
    popCap: 3000,
    workerPct: 0.55,
    attackRatio: 0.25,
    tilesOwned: 0,
    landTilesOwned: 0,
    workers: 0,
    troops: 0,
  };
}

function idx(x, y) {
  return x + y * W;
}

function inBounds(x, y) {
  return x >= 0 && y >= 0 && x < W && y < H;
}

function forNeighbors(i, cb) {
  const x = i % W;
  const y = (i / W) | 0;
  if (x > 0) cb(i - 1);
  if (x < W - 1) cb(i + 1);
  if (y > 0) cb(i - W);
  if (y < H - 1) cb(i + W);
}

function initMap() {
  const cx = W / 2;
  const cy = H / 2;
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = idx(x, y);
      const nx = (x - cx) / cx;
      const ny = (y - cy) / cy;
      const island = 1 - (nx * nx + ny * ny);
      const noise = Math.sin(x * 0.12) * Math.cos(y * 0.08) * 0.18;
      const v = island + noise;
      terrain[i] = v > 0.08 ? Terrain.PLAINS : Terrain.WATER;
      if (terrain[i] === Terrain.PLAINS && Math.random() < 0.08) {
        terrain[i] = Terrain.MOUNTAIN;
      }
      owner[i] = 0;
      building[i] = 0;
      bLevel[i] = 0;
      front[i] = 0;
    }
  }

  placeStart(1, (W * 0.36) | 0, (H * 0.58) | 0);
  placeStart(2, (W * 0.58) | 0, (H * 0.42) | 0);
  placeStart(3, (W * 0.66) | 0, (H * 0.66) | 0);
}

function placeStart(fid, sx, sy) {
  for (let r = 0; r <= 4; r += 1) {
    for (let dy = -r; dy <= r; dy += 1) {
      for (let dx = -r; dx <= r; dx += 1) {
        const x = sx + dx;
        const y = sy + dy;
        if (!inBounds(x, y)) continue;
        const i = idx(x, y);
        if (terrain[i] === Terrain.WATER) continue;
        owner[i] = fid;
      }
    }
  }
  const center = idx(sx, sy);
  building[center] = Building.CITY;
  bLevel[center] = 1;
}

function recalcFactionStats() {
  for (let id = 1; id < factions.length; id += 1) {
    const f = factions[id];
    f.tilesOwned = 0;
    f.landTilesOwned = 0;
    let cityBonus = 0;
    for (let i = 0; i < SIZE; i += 1) {
      if (owner[i] !== id) continue;
      f.tilesOwned += 1;
      if (terrain[i] !== Terrain.WATER) f.landTilesOwned += 1;
      if (building[i] === Building.CITY) {
        cityBonus += 25000 * Math.max(1, bLevel[i]);
      }
    }
    const baseCap = 1200;
    const capFromTiles = f.landTilesOwned * 20;
    f.popCap = Math.max(baseCap + capFromTiles + cityBonus, 1000);
    f.popCurrent = Math.min(f.popCurrent, f.popCap);
    f.workers = f.popCurrent * f.workerPct;
    f.troops = Math.max(0, f.popCurrent - f.workers);
  }
}

function popGrowthFactor(r) {
  const center = 0.45;
  const width = 0.42;
  const norm = Math.max(0, 1 - ((r - center) * (r - center)) / (width * width));
  return norm;
}

function updateEconomy(dt) {
  for (let id = 1; id < factions.length; id += 1) {
    const f = factions[id];
    if (f.landTilesOwned <= 0) continue;
    const ratio = Math.max(0, Math.min(1, f.popCurrent / Math.max(f.popCap, 1)));
    const peakGrowth = 0.18;
    const growth = peakGrowth * popGrowthFactor(ratio);
    f.popCurrent = Math.min(f.popCap, f.popCurrent + f.popCurrent * growth * dt);
    f.workers = f.popCurrent * f.workerPct;
    f.troops = Math.max(0, f.popCurrent - f.workers);

    let portBonus = 0;
    for (let i = 0; i < SIZE; i += 1) {
      if (owner[i] === id && building[i] === Building.CITY) {
        portBonus += 0.6;
      }
    }

    const goldPerWorker = 0.018;
    f.gold += (f.workers * goldPerWorker + portBonus) * dt;
  }
}

function isBorderAttackValid(attacker, targetI) {
  if (targetI < 0 || targetI >= SIZE) return false;
  const defendId = owner[targetI];
  if (defendId === attacker || defendId === 0) return false;
  let adjacentOwned = false;
  forNeighbors(targetI, (n) => {
    if (owner[n] === attacker) adjacentOwned = true;
  });
  return adjacentOwned;
}

function localDefenseModifier(i) {
  let mod = 1;
  if (terrain[i] === Terrain.MOUNTAIN) mod += 0.7;
  if (building[i] === Building.DEFENSE) mod += 0.9;
  forNeighbors(i, (n) => {
    if (building[n] === Building.DEFENSE && owner[n] === owner[i]) mod += 0.15;
  });
  return mod;
}

function applyAttack(attackerId, targetI, dt) {
  if (!isBorderAttackValid(attackerId, targetI)) return;

  const attacker = factions[attackerId];
  const defenderId = owner[targetI];
  const defender = factions[defenderId];
  if (!defender) return;

  const attackPower = attacker.troops * attacker.attackRatio * 0.012;
  const density = defender.troops / Math.max(1, defender.landTilesOwned);
  const defensePower = density * localDefenseModifier(targetI) * 7.5;

  const combatDelta = (attackPower - defensePower) * dt;
  front[targetI] = Math.max(0, Math.min(100, front[targetI] + combatDelta));

  const attackerLoss = Math.max(0.5, defensePower * 0.03) * dt;
  const defenderLoss = Math.max(0.4, attackPower * 0.025) * dt;
  attacker.popCurrent = Math.max(0, attacker.popCurrent - attackerLoss);
  defender.popCurrent = Math.max(0, defender.popCurrent - defenderLoss);

  if (front[targetI] >= 100) {
    owner[targetI] = attackerId;
    front[targetI] = 0;
    if (building[targetI] !== Building.NONE && Math.random() < 0.2) {
      building[targetI] = Building.NONE;
      bLevel[targetI] = 0;
    }
    checkEnclosureAround(targetI, attackerId);
  }
}

function checkEnclosureAround(tileI, enclosingFaction) {
  const checked = new Uint8Array(SIZE);

  forNeighbors(tileI, (start) => {
    const rid = owner[start];
    if (rid === 0 || rid === enclosingFaction || checked[start]) return;

    const stack = [start];
    const region = [];
    checked[start] = 1;
    let reachesEdge = false;

    while (stack.length > 0) {
      const cur = stack.pop();
      region.push(cur);
      const x = cur % W;
      const y = (cur / W) | 0;
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) reachesEdge = true;

      forNeighbors(cur, (n) => {
        if (checked[n] || owner[n] !== rid) return;
        checked[n] = 1;
        stack.push(n);
      });
    }

    if (!reachesEdge) {
      for (let j = 0; j < region.length; j += 1) {
        owner[region[j]] = enclosingFaction;
        front[region[j]] = 0;
      }
    }
  });
}

function expandNeutral(fid) {
  const candidates = [];
  for (let i = 0; i < SIZE; i += 1) {
    if (owner[i] !== 0 || terrain[i] === Terrain.WATER) continue;
    let near = false;
    forNeighbors(i, (n) => {
      if (owner[n] === fid) near = true;
    });
    if (near) candidates.push(i);
  }

  if (candidates.length === 0) return;
  const pick = candidates[(Math.random() * candidates.length) | 0];
  owner[pick] = fid;
}

function botThink(id) {
  const bot = factions[id];
  if (bot.landTilesOwned <= 0) return;

  const workerTarget = bot.popCurrent > bot.popCap * 0.5 ? 0.42 : 0.55;
  bot.workerPct += (workerTarget - bot.workerPct) * 0.2;
  bot.attackRatio = bot.landTilesOwned > 1200 ? 0.18 : 0.28;

  if (Math.random() < 0.45) expandNeutral(id);

  let bestTarget = -1;
  let bestScore = -1e9;
  for (let i = 0; i < SIZE; i += 1) {
    if (owner[i] === id || owner[i] === 0) continue;
    let border = false;
    forNeighbors(i, (n) => {
      if (owner[n] === id) border = true;
    });
    if (!border) continue;

    const enemyId = owner[i];
    const enemy = factions[enemyId];
    const density = enemy.troops / Math.max(1, enemy.landTilesOwned);
    const terrainPenalty = terrain[i] === Terrain.MOUNTAIN ? 3 : 0;
    const defensePenalty = building[i] === Building.DEFENSE ? 6 : 0;
    const score = 20 - density * 8 - terrainPenalty - defensePenalty + Math.random() * 2;
    if (score > bestScore) {
      bestScore = score;
      bestTarget = i;
    }
  }

  if (bestTarget >= 0 && Math.random() < 0.7) {
    applyAttack(id, bestTarget, FIXED_DT * 2);
  }

  if (bot.gold > costs.city * 1.3 && bot.popCurrent > bot.popCap * 0.88) {
    const tile = randomOwnedTile(id, true);
    if (tile >= 0 && building[tile] === Building.NONE) {
      building[tile] = Building.CITY;
      bLevel[tile] = 1;
      bot.gold -= costs.city;
    }
  } else if (bot.gold > costs.defense && Math.random() < 0.2) {
    const borderTile = randomBorderTile(id);
    if (borderTile >= 0 && building[borderTile] === Building.NONE) {
      building[borderTile] = Building.DEFENSE;
      bLevel[borderTile] = 1;
      bot.gold -= costs.defense;
    }
  }
}

function randomOwnedTile(fid, innerOnly = false) {
  const picks = [];
  for (let i = 0; i < SIZE; i += 1) {
    if (owner[i] !== fid || terrain[i] === Terrain.WATER) continue;
    if (innerOnly) {
      let border = false;
      forNeighbors(i, (n) => {
        if (owner[n] !== fid) border = true;
      });
      if (border) continue;
    }
    picks.push(i);
  }
  if (picks.length === 0) return -1;
  return picks[(Math.random() * picks.length) | 0];
}

function randomBorderTile(fid) {
  const picks = [];
  for (let i = 0; i < SIZE; i += 1) {
    if (owner[i] !== fid || terrain[i] === Terrain.WATER) continue;
    let border = false;
    forNeighbors(i, (n) => {
      if (owner[n] !== fid) border = true;
    });
    if (border) picks.push(i);
  }
  if (picks.length === 0) return -1;
  return picks[(Math.random() * picks.length) | 0];
}

function update() {
  if (gameOver) return;

  factions[1].workerPct = Number(workerSlider.value) / 100;
  factions[1].attackRatio = Number(attackSlider.value) / 100;

  recalcFactionStats();
  updateEconomy(FIXED_DT);

  if (Math.random() < 0.65) expandNeutral(1);
  if (attackTarget >= 0) applyAttack(1, attackTarget, FIXED_DT * 2);

  if (Math.random() < 0.6) {
    for (const b of bots) botThink(b);
  }

  recalcFactionStats();
  checkWinLose();
}

function checkWinLose() {
  const totalLand = countLandTiles();
  const pLand = factions[1].landTilesOwned;
  const pct = pLand / Math.max(1, totalLand);
  if (pct >= LAND_WIN) {
    gameOver = true;
    winner = 'Domination victory!';
  }
  if (factions[1].landTilesOwned <= 0) {
    gameOver = true;
    winner = 'Defeat.';
  }

  let activeEnemies = 0;
  for (const bid of bots) {
    if (factions[bid].landTilesOwned > 0) activeEnemies += 1;
  }
  if (activeEnemies === 0) {
    gameOver = true;
    winner = 'Total victory!';
  }
}

function countLandTiles() {
  let c = 0;
  for (let i = 0; i < SIZE; i += 1) {
    if (terrain[i] !== Terrain.WATER) c += 1;
  }
  return c;
}

function render() {
  const image = ctx.createImageData(gameCanvas.width, gameCanvas.height);
  const data = image.data;

  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = idx(x, y);
      const col = tileColor(i);

      for (let py = 0; py < TILE_SIZE; py += 1) {
        const sy = y * TILE_SIZE + py;
        for (let px = 0; px < TILE_SIZE; px += 1) {
          const sx = x * TILE_SIZE + px;
          const p = (sx + sy * gameCanvas.width) * 4;
          data[p] = col[0];
          data[p + 1] = col[1];
          data[p + 2] = col[2];
          data[p + 3] = 255;
        }
      }
    }
  }
  ctx.putImageData(image, 0, 0);

  octx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  drawBorders();
  drawSelection();
  drawGameOver();
  updateHud();
}

function hexToRgb(hex) {
  const v = hex.replace('#', '');
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}

function tileColor(i) {
  if (terrain[i] === Terrain.WATER) return [25, 45, 82];
  const own = owner[i];
  let base;
  if (own === 0) {
    base = terrain[i] === Terrain.MOUNTAIN ? [110, 104, 92] : [90, 105, 87];
  } else {
    base = hexToRgb(factions[own].color);
    if (terrain[i] === Terrain.MOUNTAIN) {
      base = [Math.max(30, base[0] - 32), Math.max(30, base[1] - 32), Math.max(30, base[2] - 32)];
    }
  }
  if (building[i] === Building.CITY) return [Math.min(255, base[0] + 35), Math.min(255, base[1] + 35), Math.min(255, base[2] + 25)];
  if (building[i] === Building.DEFENSE) return [Math.min(255, base[0] + 25), Math.min(255, base[1] + 10), Math.min(255, base[2] + 35)];
  return base;
}

function drawBorders() {
  octx.strokeStyle = 'rgba(255,255,255,0.28)';
  octx.lineWidth = 1;
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = idx(x, y);
      if (terrain[i] === Terrain.WATER) continue;
      const own = owner[i];
      if (own === 0) continue;

      const sx = x * TILE_SIZE;
      const sy = y * TILE_SIZE;
      if (x < W - 1 && owner[i + 1] !== own) {
        octx.beginPath();
        octx.moveTo(sx + TILE_SIZE, sy);
        octx.lineTo(sx + TILE_SIZE, sy + TILE_SIZE);
        octx.stroke();
      }
      if (y < H - 1 && owner[i + W] !== own) {
        octx.beginPath();
        octx.moveTo(sx, sy + TILE_SIZE);
        octx.lineTo(sx + TILE_SIZE, sy + TILE_SIZE);
        octx.stroke();
      }

      if (front[i] > 0) {
        const alpha = Math.min(0.85, 0.15 + front[i] / 120);
        octx.fillStyle = `rgba(255,74,74,${alpha})`;
        octx.fillRect(sx, sy, TILE_SIZE, TILE_SIZE);
      }
    }
  }
}

function drawSelection() {
  if (playerSelectedTile >= 0) {
    const x = playerSelectedTile % W;
    const y = (playerSelectedTile / W) | 0;
    octx.strokeStyle = 'rgba(255,255,128,0.95)';
    octx.lineWidth = 2;
    octx.strokeRect(x * TILE_SIZE + 0.5, y * TILE_SIZE + 0.5, TILE_SIZE - 1, TILE_SIZE - 1);
  }
}

function drawGameOver() {
  if (!gameOver) return;
  octx.fillStyle = 'rgba(0,0,0,0.55)';
  octx.fillRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  octx.fillStyle = 'white';
  octx.font = 'bold 42px sans-serif';
  octx.textAlign = 'center';
  octx.fillText(winner, overlayCanvas.width / 2, overlayCanvas.height / 2);
}

function updateHud() {
  const p = factions[1];
  const totalLand = countLandTiles();
  workerValue.textContent = `${Math.round(p.workerPct * 100)}%`;
  attackValue.textContent = `${Math.round(p.attackRatio * 100)}%`;
  goldText.textContent = `Gold: ${Math.floor(p.gold)}`;
  popText.textContent = `Pop: ${Math.floor(p.popCurrent)} / ${Math.floor(p.popCap)}`;
  landText.textContent = `Land: ${((p.landTilesOwned / Math.max(1, totalLand)) * 100).toFixed(1)}%`;
}

function getTileFromEvent(ev) {
  const rect = gameCanvas.getBoundingClientRect();
  const rx = (ev.clientX - rect.left) / rect.width;
  const ry = (ev.clientY - rect.top) / rect.height;
  const x = Math.floor(rx * W);
  const y = Math.floor(ry * H);
  if (!inBounds(x, y)) return -1;
  return idx(x, y);
}

gameCanvas.addEventListener('mousedown', (ev) => {
  if (gameOver) return;
  const i = getTileFromEvent(ev);
  if (i < 0 || terrain[i] === Terrain.WATER) return;

  if (owner[i] === 1) {
    playerSelectedTile = i;
    attackTarget = -1;
    return;
  }

  if (isBorderAttackValid(1, i)) {
    attackTarget = i;
  }
});

window.addEventListener('mouseup', () => {
  attackTarget = -1;
});

buildCityBtn.addEventListener('click', () => {
  const p = factions[1];
  if (playerSelectedTile < 0 || owner[playerSelectedTile] !== 1) return;
  if (building[playerSelectedTile] !== Building.NONE) return;
  if (p.gold < costs.city) return;
  building[playerSelectedTile] = Building.CITY;
  bLevel[playerSelectedTile] = 1;
  p.gold -= costs.city;
});

buildDefenseBtn.addEventListener('click', () => {
  const p = factions[1];
  if (playerSelectedTile < 0 || owner[playerSelectedTile] !== 1) return;
  if (building[playerSelectedTile] !== Building.NONE) return;
  if (p.gold < costs.defense) return;
  building[playerSelectedTile] = Building.DEFENSE;
  bLevel[playerSelectedTile] = 1;
  p.gold -= costs.defense;
});

function frame(ts) {
  const dt = Math.min(0.25, (ts - lastTs) / 1000);
  lastTs = ts;
  tickAccumulator += dt;

  while (tickAccumulator >= FIXED_DT) {
    update();
    tickAccumulator -= FIXED_DT;
  }

  render();
  requestAnimationFrame(frame);
}

function saveMapJson() {
  const land = [];
  const mountains = [];
  for (let i = 0; i < SIZE; i += 1) {
    if (terrain[i] !== Terrain.WATER) land.push(i);
    if (terrain[i] === Terrain.MOUNTAIN) mountains.push(i);
  }
  return {
    width: W,
    height: H,
    spawnPoints: [
      { faction: 1, x: (W * 0.36) | 0, y: (H * 0.58) | 0 },
      { faction: 2, x: (W * 0.58) | 0, y: (H * 0.42) | 0 },
      { faction: 3, x: (W * 0.66) | 0, y: (H * 0.66) | 0 },
    ],
    terrainCounts: {
      land: land.length,
      mountain: mountains.length,
      water: SIZE - land.length,
    },
  };
}

function boot() {
  initMap();
  recalcFactionStats();
  const mapMeta = saveMapJson();
  window.__NEWFRONT_MAP_META__ = mapMeta;
  requestAnimationFrame(frame);
}

boot();
