(() => {
  const W = 192;
  const H = 108;
  const N = W * H;
  const TICK_RATE = 20;
  const DT = 1 / TICK_RATE;

  const TERRAIN = {
    WATER: 0,
    PLAINS: 1,
    MOUNTAIN: 2,
  };

  const BUILDING = {
    NONE: 0,
    CITY: 1,
    DEF_POST: 2,
  };

  const factions = [
    null,
    { id: 1, name: 'Player', color: '#57b0ff', gold: 400, popCurrent: 3200, popCap: 8000, workerPct: 0.55, attackRatio: 0.2, tilesOwned: 0, landTilesOwned: 0, workers: 0, troops: 0 },
    { id: 2, name: 'Bot Red', color: '#ff6b6b', gold: 300, popCurrent: 2900, popCap: 7600, workerPct: 0.62, attackRatio: 0.18, tilesOwned: 0, landTilesOwned: 0, workers: 0, troops: 0 },
    { id: 3, name: 'Bot Green', color: '#69db7c', gold: 300, popCurrent: 2800, popCap: 7600, workerPct: 0.62, attackRatio: 0.18, tilesOwned: 0, landTilesOwned: 0, workers: 0, troops: 0 },
    { id: 4, name: 'Bot Purple', color: '#b197fc', gold: 300, popCurrent: 2800, popCap: 7600, workerPct: 0.62, attackRatio: 0.18, tilesOwned: 0, landTilesOwned: 0, workers: 0, troops: 0 },
  ];

  const owner = new Uint8Array(N);
  const terrain = new Uint8Array(N);
  const building = new Uint8Array(N);
  const bLevel = new Uint8Array(N);
  const front = new Float32Array(N);

  const canvas = document.getElementById('gameCanvas');
  const ctx = canvas.getContext('2d');
  const off = document.createElement('canvas');
  off.width = W;
  off.height = H;
  const offCtx = off.getContext('2d', { alpha: false });
  const image = offCtx.createImageData(W, H);

  const ui = {
    gold: document.getElementById('gold'),
    pop: document.getElementById('pop'),
    cap: document.getElementById('cap'),
    land: document.getElementById('land'),
    status: document.getElementById('status'),
    workerSlider: document.getElementById('workerSlider'),
    workerPct: document.getElementById('workerPct'),
    attackSlider: document.getElementById('attackSlider'),
    attackPct: document.getElementById('attackPct'),
    buildCity: document.getElementById('buildCity'),
    buildDefense: document.getElementById('buildDefense'),
  };

  let selectedBuild = BUILDING.CITY;
  let accumulator = 0;
  let last = performance.now();
  let gameOver = false;
  let botDecisionTimer = 0;

  const seedNoise = (x, y) => {
    const n = Math.sin((x * 12.9898 + y * 78.233) * 0.15) * 43758.5453;
    return n - Math.floor(n);
  };

  const idx = (x, y) => x + y * W;
  const inBounds = (x, y) => x >= 0 && y >= 0 && x < W && y < H;

  function neighbors4(i) {
    const x = i % W;
    const y = (i / W) | 0;
    const out = [];
    if (x > 0) out.push(i - 1);
    if (x < W - 1) out.push(i + 1);
    if (y > 0) out.push(i - W);
    if (y < H - 1) out.push(i + W);
    return out;
  }

  function isBorderTile(i, attackerId, defenderId) {
    if (owner[i] !== defenderId) return false;
    for (const n of neighbors4(i)) {
      if (owner[n] === attackerId) return true;
    }
    return false;
  }

  function initMap() {
    const cx = W * 0.5;
    const cy = H * 0.52;
    const rx = W * 0.43;
    const ry = H * 0.45;

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = idx(x, y);
        const dx = (x - cx) / rx;
        const dy = (y - cy) / ry;
        const landMask = dx * dx + dy * dy < 1.0 + (seedNoise(x, y) - 0.5) * 0.2;
        if (!landMask) {
          terrain[i] = TERRAIN.WATER;
          owner[i] = 0;
          continue;
        }

        const n = seedNoise(x * 2, y * 2);
        terrain[i] = n > 0.82 ? TERRAIN.MOUNTAIN : TERRAIN.PLAINS;

        owner[i] = 0;
      }
    }

    stampFaction(1, 56, 38, 10);
    stampFaction(2, 132, 36, 9);
    stampFaction(3, 72, 74, 9);
    stampFaction(4, 140, 76, 9);

    recountOwnership();
  }

  function stampFaction(fid, sx, sy, radius) {
    for (let y = sy - radius; y <= sy + radius; y++) {
      for (let x = sx - radius; x <= sx + radius; x++) {
        if (!inBounds(x, y)) continue;
        const i = idx(x, y);
        if (terrain[i] === TERRAIN.WATER) continue;
        const d2 = (x - sx) ** 2 + (y - sy) ** 2;
        if (d2 <= radius * radius) owner[i] = fid;
      }
    }
    const c = idx(sx, sy);
    if (terrain[c] !== TERRAIN.WATER) {
      building[c] = BUILDING.CITY;
      bLevel[c] = 1;
    }
  }

  function recountOwnership() {
    for (let f = 1; f < factions.length; f++) {
      factions[f].tilesOwned = 0;
      factions[f].landTilesOwned = 0;
    }

    for (let i = 0; i < N; i++) {
      const o = owner[i];
      if (o > 0) {
        factions[o].tilesOwned++;
        if (terrain[i] !== TERRAIN.WATER) factions[o].landTilesOwned++;
      }
    }
  }

  function factionCityCount(fid) {
    let c = 0;
    for (let i = 0; i < N; i++) {
      if (owner[i] === fid && building[i] === BUILDING.CITY) c += Math.max(1, bLevel[i]);
    }
    return c;
  }

  function updateEconomy() {
    const baseCap = 3000;
    const popPerTile = 40;
    const cityCapBonus = 25000;
    const peakGrowth = 0.15;

    for (let f = 1; f < factions.length; f++) {
      const fac = factions[f];
      if (fac.landTilesOwned <= 0) continue;

      fac.workers = fac.popCurrent * fac.workerPct;
      fac.troops = Math.max(0, fac.popCurrent - fac.workers);
      fac.gold += fac.workers * 0.006 * DT;

      const cityLevels = factionCityCount(f);
      fac.popCap = baseCap + fac.landTilesOwned * popPerTile + cityLevels * cityCapBonus;

      const ratio = Math.max(0.001, Math.min(0.999, fac.popCurrent / Math.max(1, fac.popCap)));
      const shape = Math.max(0, 1 - Math.abs((ratio - 0.45) / 0.45));
      const growthRate = peakGrowth * shape;
      fac.popCurrent += fac.popCurrent * growthRate * DT;
      fac.popCurrent = Math.min(fac.popCap, fac.popCurrent);
    }
  }

  function terrainDefenseMult(i) {
    if (terrain[i] === TERRAIN.MOUNTAIN) return 1.45;
    return 1.0;
  }

  function localDefenseBonus(i, defenderId) {
    let bonus = 1.0;
    for (const n of neighbors4(i).concat(i)) {
      if (owner[n] === defenderId && building[n] === BUILDING.DEF_POST) bonus += 0.3 * Math.max(1, bLevel[n]);
    }
    return bonus;
  }

  function resolveAttack(attackerId, targetIdx) {
    if (gameOver) return;
    const defenderId = owner[targetIdx];
    if (!defenderId || defenderId === attackerId) return;
    if (!isBorderTile(targetIdx, attackerId, defenderId)) return;

    const a = factions[attackerId];
    const d = factions[defenderId];
    if (!a || !d || a.landTilesOwned <= 0 || d.landTilesOwned <= 0) return;

    const committed = a.troops * a.attackRatio * 0.04;
    if (committed < 1) return;

    const defenseDensity = d.troops / Math.max(1, d.landTilesOwned);
    const attackPower = committed;
    const defensePower = defenseDensity * 13 * terrainDefenseMult(targetIdx) * localDefenseBonus(targetIdx, defenderId);

    const net = attackPower - defensePower;
    a.popCurrent = Math.max(0, a.popCurrent - committed * 0.35 * DT);
    d.popCurrent = Math.max(0, d.popCurrent - Math.max(0, net) * 0.22 * DT);

    front[targetIdx] += net * 0.03;
    if (front[targetIdx] > 1.0) {
      owner[targetIdx] = attackerId;
      building[targetIdx] = BUILDING.NONE;
      bLevel[targetIdx] = 0;
      front[targetIdx] = 0;
      recountOwnership();
      tryAnnexFrom(attackerId, targetIdx);
      checkVictory();
    } else if (front[targetIdx] < -1.2) {
      front[targetIdx] = -0.7;
    }
  }

  function tryAnnexFrom(attackerId, changedIdx) {
    const touched = neighbors4(changedIdx).map((n) => owner[n]).filter((o) => o > 0 && o !== attackerId);
    const unique = [...new Set(touched)];
    for (const enemyId of unique) {
      const candidates = neighbors4(changedIdx).filter((n) => owner[n] === enemyId);
      for (const start of candidates) {
        const region = [];
        const q = [start];
        const visited = new Uint8Array(N);
        let head = 0;
        let touchesEdge = false;

        visited[start] = 1;
        while (head < q.length) {
          const i = q[head++];
          region.push(i);
          const x = i % W;
          const y = (i / W) | 0;
          if (x === 0 || y === 0 || x === W - 1 || y === H - 1) touchesEdge = true;

          for (const n of neighbors4(i)) {
            if (!visited[n] && owner[n] === enemyId) {
              visited[n] = 1;
              q.push(n);
            }
          }
        }

        if (!touchesEdge && region.length > 0) {
          for (const i of region) {
            owner[i] = attackerId;
            building[i] = BUILDING.NONE;
            bLevel[i] = 0;
            front[i] = 0;
          }
          recountOwnership();
          checkVictory();
          return;
        }
      }
    }
  }

  function checkVictory() {
    const landTiles = countLandTiles();
    const playerLand = factions[1].landTilesOwned;
    const pct = (playerLand / Math.max(1, landTiles)) * 100;
    if (factions[1].landTilesOwned <= 0) {
      gameOver = true;
      ui.status.textContent = 'Defeat: Eliminated';
      return;
    }
    if (pct >= 72) {
      gameOver = true;
      ui.status.textContent = 'Victory: Domination';
    }
  }

  function countLandTiles() {
    let t = 0;
    for (let i = 0; i < N; i++) if (terrain[i] !== TERRAIN.WATER) t++;
    return t;
  }

  function botThink() {
    for (let f = 2; f < factions.length; f++) {
      const bot = factions[f];
      if (bot.landTilesOwned <= 0) continue;

      bot.workerPct = bot.popCurrent > bot.popCap * 0.75 ? 0.5 : 0.63;
      bot.attackRatio = bot.popCurrent > bot.popCap * 0.6 ? 0.22 : 0.14;

      if (bot.gold >= 180) {
        const citySpot = pickOwnedInteriorTile(f);
        if (citySpot >= 0 && building[citySpot] === BUILDING.NONE) {
          building[citySpot] = BUILDING.CITY;
          bLevel[citySpot] = 1;
          bot.gold -= 180;
        }
      }

      if (Math.random() < 0.85) {
        const target = pickBestAttackTarget(f);
        if (target >= 0) resolveAttack(f, target);
      }
    }
  }

  function pickOwnedInteriorTile(fid) {
    for (let k = 0; k < 90; k++) {
      const i = (Math.random() * N) | 0;
      if (owner[i] !== fid || terrain[i] === TERRAIN.WATER) continue;
      const safe = neighbors4(i).every((n) => owner[n] === fid);
      if (safe) return i;
    }
    return -1;
  }

  function pickBestAttackTarget(fid) {
    let best = -1;
    let bestScore = -1e9;

    for (let i = 0; i < N; i++) {
      const def = owner[i];
      if (def === 0 || def === fid || terrain[i] === TERRAIN.WATER) continue;
      if (!isBorderTile(i, fid, def)) continue;

      const defender = factions[def];
      const density = defender.troops / Math.max(1, defender.landTilesOwned);
      let score = 20 - density * 5;
      if (terrain[i] === TERRAIN.MOUNTAIN) score -= 4;
      if (building[i] === BUILDING.DEF_POST) score -= 8;
      for (const n of neighbors4(i)) if (owner[n] === 0 && terrain[n] !== TERRAIN.WATER) score += 2;
      score += Math.random() * 2;

      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }

    return best;
  }

  function buildAt(fid, i, type) {
    const fac = factions[fid];
    if (owner[i] !== fid) return;
    if (terrain[i] === TERRAIN.WATER) return;

    if (type === BUILDING.CITY) {
      const cost = 200;
      if (fac.gold >= cost && building[i] === BUILDING.NONE) {
        building[i] = BUILDING.CITY;
        bLevel[i] = 1;
        fac.gold -= cost;
      }
    }

    if (type === BUILDING.DEF_POST) {
      const cost = 120;
      if (fac.gold >= cost && building[i] === BUILDING.NONE) {
        building[i] = BUILDING.DEF_POST;
        bLevel[i] = 1;
        fac.gold -= cost;
      }
    }
  }

  function update() {
    if (gameOver) return;

    updateEconomy();
    botDecisionTimer += DT;
    if (botDecisionTimer >= 0.2) {
      botDecisionTimer = 0;
      botThink();
    }

    for (let i = 0; i < N; i++) front[i] *= 0.94;
  }

  function render() {
    const p = image.data;

    for (let i = 0; i < N; i++) {
      const base = i * 4;
      const t = terrain[i];
      const o = owner[i];

      let r = 14, g = 21, b = 33;
      if (t === TERRAIN.WATER) {
        r = 20; g = 44; b = 76;
      } else {
        if (o > 0) {
          const hex = factions[o].color;
          r = parseInt(hex.slice(1, 3), 16);
          g = parseInt(hex.slice(3, 5), 16);
          b = parseInt(hex.slice(5, 7), 16);
        } else {
          r = 110; g = 118; b = 96;
        }

        if (t === TERRAIN.MOUNTAIN) {
          r = Math.min(255, r + 30);
          g = Math.min(255, g + 30);
          b = Math.min(255, b + 30);
        }

        const f = Math.max(-1, Math.min(1, front[i]));
        if (f > 0.05) {
          r = Math.min(255, r + 60 * f);
          g = Math.min(255, g + 35 * f);
          b = Math.min(255, b + 35 * f);
        }
      }

      if (building[i] === BUILDING.CITY) {
        r = Math.min(255, r + 25);
        g = Math.min(255, g + 25);
      } else if (building[i] === BUILDING.DEF_POST) {
        b = Math.min(255, b + 40);
      }

      p[base] = r;
      p[base + 1] = g;
      p[base + 2] = b;
      p[base + 3] = 255;
    }

    offCtx.putImageData(image, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(off, 0, 0, canvas.width, canvas.height);

    renderUi();
  }

  function renderUi() {
    const p = factions[1];
    const landPct = ((p.landTilesOwned / Math.max(1, countLandTiles())) * 100).toFixed(1);
    ui.gold.textContent = Math.floor(p.gold).toLocaleString();
    ui.pop.textContent = Math.floor(p.popCurrent).toLocaleString();
    ui.cap.textContent = Math.floor(p.popCap).toLocaleString();
    ui.land.textContent = landPct;
  }

  function toCell(e) {
    const rect = canvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left) / rect.width;
    const my = (e.clientY - rect.top) / rect.height;
    const x = Math.floor(mx * W);
    const y = Math.floor(my * H);
    if (!inBounds(x, y)) return -1;
    return idx(x, y);
  }

  canvas.addEventListener('click', (e) => {
    const i = toCell(e);
    if (i < 0) return;
    resolveAttack(1, i);
  });

  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const i = toCell(e);
    if (i < 0) return;
    buildAt(1, i, selectedBuild);
  });

  ui.workerSlider.addEventListener('input', () => {
    const v = Number(ui.workerSlider.value) / 100;
    factions[1].workerPct = v;
    ui.workerPct.textContent = `${Math.round(v * 100)}%`;
  });

  ui.attackSlider.addEventListener('input', () => {
    const v = Number(ui.attackSlider.value) / 100;
    factions[1].attackRatio = v;
    ui.attackPct.textContent = `${Math.round(v * 100)}%`;
  });

  ui.buildCity.addEventListener('click', () => {
    selectedBuild = BUILDING.CITY;
    ui.status.textContent = 'Build Mode: City (right click own tile)';
  });

  ui.buildDefense.addEventListener('click', () => {
    selectedBuild = BUILDING.DEF_POST;
    ui.status.textContent = 'Build Mode: Defense Post (right click own tile)';
  });

  function frame(now) {
    const delta = Math.min(0.25, (now - last) / 1000);
    last = now;
    accumulator += delta;

    while (accumulator >= DT) {
      update();
      accumulator -= DT;
    }

    render();
    requestAnimationFrame(frame);
  }

  initMap();
  render();
  requestAnimationFrame(frame);
})();
