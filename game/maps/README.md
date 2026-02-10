# Map assets note

This repository intentionally avoids committing binary map images in `game/maps/` so PR tooling that only supports text diffs can open successfully.

For now, the MVP uses procedural terrain generation in `game/game.js`.

If you want a raster seed/mask later, add it locally (example filename: `europe_384x216.png`) and wire it into a loader step.
