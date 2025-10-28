import Phaser from 'phaser';

/**
 * Minimal chunked procedural world scaffold.
 * - deterministic chunk generation by seed
 * - simple tiles (air, grass, dirt, stone, coal, copper, wood, leaves)
 * - draws tiles to an offscreen canvas and renders them as a texture
 *
 * Expand this scene for: player, physics, mining, inventory, networking.
 */

type Tile = 'air'|'grass'|'dirt'|'stone'|'coal'|'copper'|'wood'|'leaves';

const TILE_SIZE = 12;           // pixels
const CHUNK_SIZE = 32;         // tiles per chunk (square)
const VISIBLE_RANGE = 2;       // chunks in each direction

function hashSeed(s: string) {
  // simple deterministic 32-bit hash for seed->int
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry32(a: number) {
  return function() {
    let t = (a += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function rngFor(seed: string, cx: number, cy: number) {
  const s = `${seed}:${cx}:${cy}`;
  const h = hashSeed(s);
  return mulberry32(h);
}

export default class WorldScene extends Phaser.Scene {
  private seed: string;
  private chunks: Map<string, Tile[][]>;
  private tileColors: Record<Tile,string>;

  constructor() {
    super({ key: 'WorldScene' });
    this.seed = (Date.now() % 1000000).toString();
    this.chunks = new Map();
    this.tileColors = {
      air: '#00000000',
      grass: '#6aa84f',
      dirt: '#9c7440',
      stone: '#6f6f6f',
      coal: '#2f2f2f',
      copper: '#b87333',
      wood: '#5b3520',
      leaves: '#8ad0a7'
    };
  }

  preload() {
    // no external assets for this scaffold
  }

  create() {
    this.add.text(16, 16, `Seed: ${this.seed}`, { color: '#cfeefa', fontSize: '14px' }).setScrollFactor(0);

    // simple camera/player stub — center world at 0,0 in pixels:
    const worldPxSize = CHUNK_SIZE * TILE_SIZE * 50; // just big virtual area for camera movement
    this.cameras.main.setBounds(-worldPxSize, -worldPxSize, worldPxSize * 2, worldPxSize * 2);
    this.cameras.main.centerOn(0, 0);

    // draw initial visible chunks at camera position (0,0)
    this.drawVisibleChunks(0, 0);

    // simple keyboard to move camera (simulates player)
    const cursors = this.input.keyboard.createCursorKeys();
    this.input.keyboard.on('keydown', () => {}, this);
    this.events.on('update', () => {
      if (cursors.left?.isDown) this.cameras.main.scrollX -= 6;
      if (cursors.right?.isDown) this.cameras.main.scrollX += 6;
      if (cursors.up?.isDown) this.cameras.main.scrollY -= 6;
      if (cursors.down?.isDown) this.cameras.main.scrollY += 6;
      // redraw when camera crosses chunk boundaries
      const camX = Math.floor(this.cameras.main.centerX);
      const camY = Math.floor(this.cameras.main.centerY);
      this.drawVisibleChunks(camX, camY);
    });
  }

  private drawVisibleChunks(camPixelX: number, camPixelY: number) {
    const centerTileX = Math.floor(camPixelX / TILE_SIZE);
    const centerTileY = Math.floor(camPixelY / TILE_SIZE);
    const centerChunkX = Math.floor(centerTileX / CHUNK_SIZE);
    const centerChunkY = Math.floor(centerTileY / CHUNK_SIZE);

    // for simplicity: clear previous chunk images (small projects can reuse textures)
    this.children.removeAll();

    // ui text
    this.add.text(16, 16, `Seed: ${this.seed}`, { color: '#cfeefa', fontSize: '14px' }).setScrollFactor(0);

    for (let cy = centerChunkY - VISIBLE_RANGE; cy <= centerChunkY + VISIBLE_RANGE; cy++) {
      for (let cx = centerChunkX - VISIBLE_RANGE; cx <= centerChunkX + VISIBLE_RANGE; cx++) {
        const tiles = this.ensureChunk(cx, cy);
        const canvas = document.createElement('canvas');
        canvas.width = CHUNK_SIZE * TILE_SIZE;
        canvas.height = CHUNK_SIZE * TILE_SIZE;
        const ctx = canvas.getContext('2d')!;
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        for (let y = 0; y < CHUNK_SIZE; y++) {
          for (let x = 0; x < CHUNK_SIZE; x++) {
            const t = tiles[y][x];
            if (t !== 'air') {
              ctx.fillStyle = this.tileColors[t];
              ctx.fillRect(x * TILE_SIZE, y * TILE_SIZE, TILE_SIZE, TILE_SIZE);
            }
          }
        }

        // create texture and add image to world
        const key = `chunk_${cx}_${cy}`;
        if (this.textures.exists(key)) this.textures.remove(key);
        this.textures.addCanvas(key, canvas);
        const worldX = cx * CHUNK_SIZE * TILE_SIZE;
        const worldY = cy * CHUNK_SIZE * TILE_SIZE;
        this.add.image(worldX + (CHUNK_SIZE * TILE_SIZE) / 2, worldY + (CHUNK_SIZE * TILE_SIZE) / 2, key).setOrigin(0.5, 0.5);
      }
    }
  }

  private ensureChunk(cx: number, cy: number): Tile[][] {
    const k = `${cx},${cy}`;
    if (this.chunks.has(k)) return this.chunks.get(k)!;
    const tiles = this.generateChunk(cx, cy);
    this.chunks.set(k, tiles);
    return tiles;
  }

  private generateChunk(cx: number, cy: number): Tile[][] {
    const rng = rngFor(this.seed, cx, cy);
    const tiles: Tile[][] = [];
    for (let y = 0; y < CHUNK_SIZE; y++) {
      tiles[y] = new Array(CHUNK_SIZE).fill('air');
    }

    // simple heightmap per x
    for (let x = 0; x < CHUNK_SIZE; x++) {
      const worldX = cx * CHUNK_SIZE + x;
      // deterministic "noise-ish" baseline using sin + rng
      const base = Math.floor(CHUNK_SIZE * 0.5 + Math.sin(worldX / 10 + cy / 6) * 3 + Math.floor(rng() * 3 - 1));
      const surfaceY = Math.max(4, Math.min(CHUNK_SIZE - 6, base));
      for (let y = 0; y < CHUNK_SIZE; y++) {
        if (y < surfaceY) tiles[y][x] = 'air';
        else if (y === surfaceY) tiles[y][x] = 'grass';
        else if (y < surfaceY + 4) tiles[y][x] = 'dirt';
        else tiles[y][x] = 'stone';
      }
    }

    // carve a few tunnels (caves), some reaching surface occasionally
    if (rng() < 0.7) {
      const tunnels = 1 + Math.floor(rng() * 2);
      for (let t = 0; t < tunnels; t++) {
        let tx = Math.floor(rng() * CHUNK_SIZE);
        let ty = Math.floor(CHUNK_SIZE * 0.4 + rng() * CHUNK_SIZE * 0.5);
        const length = 10 + Math.floor(rng() * 30);
        for (let i = 0; i < length; i++) {
          const r = 1 + Math.floor(rng() * 2.2);
          for (let oy = -r; oy <= r; oy++) {
            for (let ox = -r; ox <= r; ox++) {
              const nx = tx + ox, ny = ty + oy;
              if (nx >= 0 && nx < CHUNK_SIZE && ny >= 0 && ny < CHUNK_SIZE) {
                if (Math.hypot(ox, oy) <= r + 0.2) tiles[ny][nx] = 'air';
              }
            }
          }
          tx += Math.floor(rng() * 3 - 1);
          ty += Math.floor(rng() * 3 - 1);
          tx = Math.max(1, Math.min(CHUNK_SIZE - 2, tx));
          ty = Math.max(2, Math.min(CHUNK_SIZE - 3, ty));
        }
        if (rng() < 0.12) {
          // drill up to surface
          for (let y = ty; y >= 0; y--) {
            tiles[y][tx] = 'air';
            if (y === 0) break;
            if (tiles[y][tx] === 'grass') break;
          }
        }
      }
    }

    // ores
    for (let y = 0; y < CHUNK_SIZE; y++) {
      for (let x = 0; x < CHUNK_SIZE; x++) {
        if (tiles[y][x] === 'stone') {
          const r = rng();
          if (r < 0.02) tiles[y][x] = 'coal';
          else if (r < 0.007) tiles[y][x] = 'copper';
        }
      }
    }

    // trees
    for (let x = 2; x < CHUNK_SIZE - 2; x++) {
      if (rng() < 0.06) {
        for (let y = 0; y < CHUNK_SIZE - 1; y++) {
          if (tiles[y][x] === 'grass') {
            const trunk = 3 + Math.floor(rng() * 3);
            for (let t = 1; t <= trunk && (y - t) >= 0; t++) tiles[y - t][x] = 'wood';
            const top = y - trunk;
            for (let lx = -2; lx <= 2; lx++) {
              for (let ly = -2; ly <= 1; ly++) {
                const nx = x + lx, ny = top + ly;
                if (nx >= 0 && nx < CHUNK_SIZE && ny >= 0 && ny < CHUNK_SIZE) {
                  if (Math.abs(lx) + Math.abs(ly) < 4 && tiles[ny][nx] === 'air') tiles[ny][nx] = 'leaves';
                }
              }
            }
            break;
          }
        }
      }
    }

    return tiles;
  }
}
