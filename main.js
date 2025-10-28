/* main.js
   Chunked sandbox with:
   - deterministic per-chunk generation (seeded)
   - chunk streaming when player approaches edges
   - mining, inventory, crafting, armor, physics
   - multiplayer: sync player list with mockapi players endpoint
   - world save: POST/PUT to mockapi world endpoint
   - graceful fallback to localStorage if network unavailable
*/

/* ------------- CONFIG ------------- */
const CONFIG = {
  TILE_SIZE: 12,         // pixels per tile
  CHUNK_SIZE: 32,        // tiles per chunk (square)
  VISIBLE_RANGE: 2,      // number of chunks to load around player
  SEED: (Date.now() % 1000000) | 0,
  PLAYER_ID_KEY: 'sandbox_player_id',
  WORLD_LOCAL_KEY: 'sandbox_world_local',
  API_PLAYERS: 'https://68eeed86b06cc802829ba196.mockapi.io/players',
  API_WORLD: 'https://68f3dd3efd14a9fcc42a1184.mockapi.io/world',
  SYNC_INTERVAL: 4000,   // ms between player syncs
  WORLD_SAVE_DEBOUNCE: 2000,
};

/* ------------- UTIL: seeded RNG per-chunk ------------- */
function xmur3(str) {
  for (var i = 0, h = 1779033703 ^ str.length; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function() {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}
function mulberry32(a) {
  return function() {
    var t = (a += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// make rng from seed + chunk coords
function rngFor(seed, cx, cy) {
  const s = `${seed}_${cx}_${cy}`;
  const h = xmur3(s)();
  return mulberry32(h);
}

/* ------------- TILE TYPES ------------- */
const TILES = {
  AIR: 'air',
  GRASS: 'grass',
  DIRT: 'dirt',
  STONE: 'stone',
  COAL: 'coal',
  COPPER: 'copper',
  WOOD: 'wood',
  LEAVES: 'leaves'
};

/* ------------- WORLD: chunk map ------------- */
// chunks indexed by "cx,cy" -> {tiles: 2D array CHUNK_SIZE x CHUNK_SIZE, modified: bool}
const chunks = new Map();

/* helper key */
function ck(cx, cy){ return `${cx},${cy}`; }

/* Generate a deterministic chunk given coords and seed */
function generateChunk(cx, cy) {
  const rng = rngFor(CONFIG.SEED, cx, cy);
  const size = CONFIG.CHUNK_SIZE;
  const tiles = new Array(size).fill(0).map(()=>new Array(size).fill(TILES.AIR));

  // Surface height: use per-column height that varies smoothly with cx,cy
  // We compute a global surface baseline by sampling multiple nearby 'noise' values
  for(let x=0;x<size;x++){
    // worldX tile
    const worldX = cx * size + x;
    // make height using a simple combination of sines + rng
    const base = Math.floor(size * 0.5 + (Math.sin((worldX/10) + (cy/6)) * 4) + Math.floor(rng()*3 - 1));
    const surfaceY = Math.max(4, Math.min(size-6, base));

    for(let y=0;y<size;y++){
      if(y < surfaceY) tiles[y][x] = TILES.AIR;
      else if(y === surfaceY) tiles[y][x] = TILES.GRASS;
      else if(y > surfaceY && y < surfaceY + 4) tiles[y][x] = TILES.DIRT;
      else tiles[y][x] = TILES.STONE;
    }
  }

  // Occasional caves: create tunnels that sometimes reach surface
  if(rng() < 0.65){ // many chunks have some cave structure
    const tunnels = 1 + Math.floor(rng()*2);
    for(let t=0;t<tunnels;t++){
      let tx = Math.floor(rng()*size);
      let ty = Math.floor(size*0.4 + rng()*size*0.5);
      const length = 10 + Math.floor(rng()*30);
      for(let i=0;i<length;i++){
        const r = 1 + Math.floor(rng()*2.2);
        for(let ox=-r;ox<=r;ox++){
          for(let oy=-r;oy<=r;oy++){
            const nx=tx+ox, ny=ty+oy;
            if(nx>=0 && nx<size && ny>=0 && ny<size){
              if(Math.hypot(ox,oy) <= r+0.2) tiles[ny][nx] = TILES.AIR;
            }
          }
        }
        tx += Math.floor(rng()*3 - 1);
        ty += Math.floor(rng()*3 - 1);
        tx = Math.max(1, Math.min(size-2, tx));
        ty = Math.max(2, Math.min(size-3, ty));
      }
      // sometimes the tunnel goes up to surface: with small chance propagate upwards
      if(rng() < 0.12){
        for(let y=ty;y>=0;y--){
          if(tiles[y][tx] === TILES.GRASS){
            tiles[y][tx] = TILES.AIR; // cave mouth to surface
            break;
          } else {
            tiles[y][tx] = TILES.AIR;
          }
        }
      }
    }
  }

  // Ores: scatter coal and copper inside stone
  for(let x=0;x<size;x++){
    for(let y=0;y<size;y++){
      if(tiles[y][x] === TILES.STONE) {
        const r = rng();
        if(r < 0.02) tiles[y][x] = TILES.COAL;
        else if(r < 0.007) tiles[y][x] = TILES.COPPER;
      }
    }
  }

  // Trees: spawn trees near top surface
  for(let x=2;x<size-2;x++){
    if(rng() < 0.06){
      // find surface Y at this x
      for(let y=0;y<size-1;y++){
        if(tiles[y][x] === TILES.GRASS){
          // place trunk up (1..3)
          const trunk = 3 + Math.floor(rng()*3);
          for(let t=1;t<=trunk && (y-t)>=0;t++){
            tiles[y-t][x] = TILES.WOOD;
          }
          // leaves blob
          const top = y - trunk;
          for(let lx=-2; lx<=2; lx++){
            for(let ly=-2; ly<=1; ly++){
              const nx = x + lx, ny = top + ly;
              if(nx>=0 && nx<size && ny>=0 && ny<size){
                if(Math.abs(lx)+Math.abs(ly) < 4 && tiles[ny][nx] === TILES.AIR){
                  tiles[ny][nx] = TILES.LEAVES;
                }
              }
            }
          }
          break;
        }
      }
    }
  }

  return { tiles, modified: false };
}

/* ------------- CHUNK LOADING / GET TILE / SET TILE ------------- */
function ensureChunk(cx, cy) {
  const key = ck(cx, cy);
  if(!chunks.has(key)){
    const c = generateChunk(cx, cy);
    chunks.set(key, c);
  }
  return chunks.get(key);
}
function getTile(worldX, worldY) {
  const s = CONFIG.CHUNK_SIZE;
  const cx = Math.floor(Math.floor(worldX) / s);
  const cy = Math.floor(Math.floor(worldY) / s);
  const chunk = ensureChunk(cx, cy);
  const lx = ((Math.floor(worldX) % s) + s) % s;
  const ly = ((Math.floor(worldY) % s) + s) % s;
  return chunk.tiles[ly][lx];
}
function setTile(worldX, worldY, tile) {
  const s = CONFIG.CHUNK_SIZE;
  const cx = Math.floor(Math.floor(worldX) / s);
  const cy = Math.floor(Math.floor(worldY) / s);
  const chunk = ensureChunk(cx, cy);
  const lx = ((Math.floor(worldX) % s) + s) % s;
  const ly = ((Math.floor(worldY) % s) + s) % s;
  chunk.tiles[ly][lx] = tile;
  chunk.modified = true;
  scheduleWorldSave();
}

/* ------------- RENDER ------------- */
const canvas = document.getElementById('worldCanvas');
const ctx = canvas.getContext('2d');

function resizeCanvasToFit() {
  // full available space inside canvas-wrap
  const wrap = document.querySelector('.canvas-wrap');
  const rect = wrap.getBoundingClientRect();
  canvas.width = Math.max(320, Math.floor(rect.width));
  canvas.height = Math.max(240, Math.floor(rect.height));
}
window.addEventListener('resize', resizeCanvasToFit);

/* tile -> color */
const COLORS = {
  [TILES.GRASS]: '#6aa84f',
  [TILES.DIRT]: '#9c7440',
  [TILES.STONE]: '#6f6f6f',
  [TILES.COAL]: '#2f2f2f',
  [TILES.COPPER]: '#b87333',
  [TILES.WOOD]: '#5b3520',
  [TILES.LEAVES]: '#8ad0a7'
};

/* ------------- PLAYER ------------- */
const player = {
  id: null,
  x: 60, // tile coordinates (float)
  y: 10,
  vx: 0,
  vy: 0,
  w: 0.9,
  h: 1.8,
  grounded: false,
  inventory: {}, // map item->count
  hotbar: [null,null,null,null,null],
  armor: { head:null, body:null, legs:null }
};
document.getElementById('seedLabel').textContent = CONFIG.SEED;

/* ------------- INPUT ------------- */
const keys = {};
window.addEventListener('keydown', e => { keys[e.key.toLowerCase()] = true; });
window.addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; });

/* ------------- SIMPLE INVENTORY / CRAFTING ------------- */
const RECIPES = [
  { id:'copper_ingot', name:'Copper Ingot', requires:{ copper:3 }, craft: (inv)=>{ consume(inv,{copper:3}); add(inv,'copper_ingot',1); } },
  { id:'copper_helmet', name:'Copper Helmet', requires:{ copper_ingot:5 }, craft: (inv)=>{ consume(inv,{copper_ingot:5}); add(inv,'copper_helmet',1);} },
  { id:'lead_plate', name:'Lead Plate', requires:{ lead:6 }, craft: (inv)=>{ consume(inv,{lead:6}); add(inv,'lead_plate',1);} },
  { id:'lead_armor', name:'Lead Armor', requires:{ lead:12 }, craft: (inv)=>{ consume(inv,{lead:12}); add(inv,'lead_armor',1);} },
  { id:'wood_plank', name:'Wood Plank', requires:{ wood:2 }, craft: (inv)=>{ consume(inv,{wood:2}); add(inv,'wood_plank',1);} }
];

function add(inv,item,count=1){ inv[item] = (inv[item]||0)+count; refreshUI(); }
function consume(inv,req){
  for(const k of Object.keys(req)) inv[k] = (inv[k]||0)-req[k];
  for(const k of Object.keys(req)) if(inv[k] <= 0) delete inv[k];
  refreshUI();
}
function canCraft(inv,requires){
  for(const k of Object.keys(requires)) if((inv[k]||0) < requires[k]) return false;
  return true;
}

/* ------------- UI RENDER ------------- */
function refreshUI(){
  // inv grid
  const invGrid = document.getElementById('invGrid');
  invGrid.innerHTML = '';
  const inv = player.inventory;
  const items = Object.keys(inv);
  if(items.length === 0){
    invGrid.innerHTML = '<div class="inv-item">(empty)</div>';
  } else {
    for(const i of items){
      const el = document.createElement('div');
      el.className = 'inv-item';
      el.textContent = `${i} × ${inv[i]}`;
      invGrid.appendChild(el);
    }
  }
  // craft list
  const craftList = document.getElementById('craftList');
  craftList.innerHTML = '';
  for(const r of RECIPES){
    const entry = document.createElement('div');
    entry.className = 'craft-entry';
    const left = document.createElement('div'); left.textContent = r.name;
    const right = document.createElement('div');
    const btn = document.createElement('button');
    btn.textContent = 'Craft';
    btn.disabled = !canCraft(inv, r.requires);
    btn.onclick = ()=>{ r.craft(player.inventory); };
    right.appendChild(btn);
    entry.appendChild(left); entry.appendChild(right);
    craftList.appendChild(entry);
  }
  // hotbar
  const hotbar = document.getElementById('hotbar');
  hotbar.innerHTML = '';
  for(let i=0;i<player.hotbar.length;i++){
    const slot = document.createElement('div');
    slot.className = 'slot';
    slot.textContent = player.hotbar[i] ? `${player.hotbar[i]} (${player.inventory[player.hotbar[i]]||0})` : '';
    hotbar.appendChild(slot);
  }
}
refreshUI();

/* ------------- PHYSICS & WORLD COLLISIONS ------------- */
function tileSolid(t){
  return t && t !== TILES.AIR && t !== TILES.LEAVES;
}
function rectCollidesWithTiles(x, y, w, h) {
  // returns whether rectangle in tile coords collides with any solid tile
  const startX = Math.floor(x-0.01), endX = Math.floor(x + w - 0.01);
  const startY = Math.floor(y-0.01), endY = Math.floor(y + h - 0.01);
  for(let ty=startY; ty<=endY; ty++){
    for(let tx=startX; tx<=endX; tx++){
      if(tileSolid(getTile(tx, ty))) return true;
    }
  }
  return false;
}

/* ------------- GAME LOOP ------------- */
let lastTime = performance.now(), accumulator = 0;
const STEP = 1/60;

function gameStep(dt) {
  // input
  const speed = 6;
  if(keys['a'] || keys['arrowleft']) player.vx = -speed;
  else if(keys['d'] || keys['arrowright']) player.vx = speed;
  else player.vx = 0;
  if((keys['w'] || keys[' ']) && player.grounded){
    player.vy = -10; player.grounded = false;
  }

  // gravity
  player.vy += 30 * dt;

  // simple integrator with collision
  let nx = player.x + player.vx * dt;
  let ny = player.y + player.vy * dt;

  // horizontal collision
  if(!rectCollidesWithTiles(nx, player.y, player.w, player.h)){
    player.x = nx;
  } else {
    // move toward collision until just before
    const sign = Math.sign(player.vx);
    while(sign !== 0 && !rectCollidesWithTiles(player.x + sign*0.01, player.y, player.w, player.h)){
      player.x += sign*0.01;
    }
    player.vx = 0;
  }

  // vertical collision
  if(!rectCollidesWithTiles(player.x, ny, player.w, player.h)){
    player.y = ny; player.grounded = false;
  } else {
    if(player.vy > 0){
      // landing
      player.grounded = true;
    }
    player.vy = 0;
    // snap to nearest tile
    if(player.vy >= 0){
      player.y = Math.floor(player.y + player.h) - player.h;
    }
  }

  // chunk streaming when near edges
  streamChunksAroundPlayer();

  // render
  render();
}

function loop(now){
  const dt = (now - lastTime) / 1000;
  lastTime = now;
  accumulator += dt;
  while(accumulator > STEP){
    gameStep(STEP);
    accumulator -= STEP;
  }
  requestAnimationFrame(loop);
}

/* ------------- RENDERING WORLD TILEMAP AROUND PLAYER ------------- */
function render() {
  // clear
  ctx.clearRect(0,0,canvas.width,canvas.height);
  const tw = CONFIG.TILE_SIZE;
  // compute camera so player is centered
  const screenW = canvas.width, screenH = canvas.height;
  const camX = player.x * tw - screenW/2 + (player.w*tw)/2;
  const camY = player.y * tw - screenH/2 + (player.h*tw)/2;

  const startX = Math.floor((camX)/tw);
  const startY = Math.floor((camY)/tw);
  const cols = Math.ceil(screenW / tw) + 2;
  const rows = Math.ceil(screenH / tw) + 2;

  // draw tiles
  for(let cy=0; cy<rows; cy++){
    for(let cx=0; cx<cols; cx++){
      const wx = startX + cx;
      const wy = startY + cy;
      const t = getTile(wx, wy);
      if(t && t !== TILES.AIR){
        ctx.fillStyle = COLORS[t] || '#444';
        ctx.fillRect((wx*tw)-camX, (wy*tw)-camY, tw, tw);
      }
    }
  }

  // draw animals (simple)
  // omitted for brevity — could sample spawned animals per chunk

  // draw player as rectangle
  ctx.fillStyle = '#ffe19a';
  ctx.fillRect((player.x*tw)-camX, (player.y*tw)-camY, player.w*tw, player.h*tw);
}

/* ------------- MINING / MOUSE INTERACTION ------------- */
let mouse = { x:0, y:0, down:false };
canvas.addEventListener('mousemove', e=>{
  const rect = canvas.getBoundingClientRect();
  mouse.x = (e.clientX - rect.left) / rect.width * canvas.width;
  mouse.y = (e.clientY - rect.top) / rect.height * canvas.height;
});
canvas.addEventListener('mousedown', e=>{ mouse.down = true; });
canvas.addEventListener('mouseup', e=>{ mouse.down = false; });

function tickMining() {
  if(mouse.down){
    // compute tile under mouse
    const tw = CONFIG.TILE_SIZE;
    const screenW = canvas.width, screenH = canvas.height;
    const camX = player.x * tw - screenW/2 + (player.w*tw)/2;
    const camY = player.y * tw - screenH/2 + (player.h*tw)/2;
    const wx = Math.floor((mouse.x + camX) / tw);
    const wy = Math.floor((mouse.y + camY) / tw);
    const tile = getTile(wx, wy);
    if(tile && tile !== TILES.AIR){
      // simple break: remove tile and drop resource
      setTile(wx, wy, TILES.AIR);
      // drop mapping
      if(tile === TILES.WOOD){
        add(player.inventory, 'wood', 1);
      } else if(tile === TILES.COAL){
        add(player.inventory, 'coal', 1);
      } else if(tile === TILES.COPPER){
        add(player.inventory, 'copper', 1);
      } else if(tile === TILES.DIRT || tile === TILES.GRASS){
        add(player.inventory, 'dirt', 1);
      } else if(tile === TILES.STONE){
        add(player.inventory, 'stone', 1);
      }
    }
  }
}

/* ------------- CHUNK STREAMING ------------- */
function streamChunksAroundPlayer() {
  const s = CONFIG.CHUNK_SIZE;
  const pcx = Math.floor(player.x / s);
  const pcy = Math.floor(player.y / s);
  const range = CONFIG.VISIBLE_RANGE;
  for(let oy=-range; oy<=range; oy++){
    for(let ox=-range; ox<=range; ox++){
      ensureChunk(pcx+ox, pcy+oy);
    }
  }
}

/* ------------- SAVE / LOAD WORLD (with API) ------------- */
let saveTimeout = null;
let lastSave = 0;
function scheduleWorldSave(){
  if(saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(()=>{ saveWorldToServer(); }, CONFIG.WORLD_SAVE_DEBOUNCE);
}

async function saveWorldToServer(){
  document.getElementById('syncStatus').textContent = 'saving...';
  // serialize only modified chunks to reduce data
  const data = {};
  for(const [k,c] of chunks.entries()){
    if(c.modified) data[k] = c.tiles;
  }
  if(Object.keys(data).length === 0){
    document.getElementById('syncStatus').textContent = 'idle';
    return;
  }

  const payload = {
    seed: CONFIG.SEED,
    timestamp: Date.now(),
    chunks: data
  };

  try {
    const res = await fetch(CONFIG.API_WORLD, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify(payload)
    });
    if(!res.ok) throw new Error('save failed');
    document.getElementById('syncStatus').textContent = 'world saved';
    lastSave = Date.now();
  } catch(err){
    // fallback: store local
    localStorage.setItem(CONFIG.WORLD_LOCAL_KEY, JSON.stringify(payload));
    document.getElementById('syncStatus').textContent = 'saved locally (API failed)';
  }
}

/* ------------- MULTIPLAYER: players sync ------------- */
async function syncPlayers() {
  document.getElementById('syncStatus').textContent = 'syncing players...';
  try {
    const res = await fetch(CONFIG.API_PLAYERS);
    if(!res.ok) throw new Error('players fetch failed');
    const players = await res.json();
    // store other players for rendering
    window.remotePlayers = players;
    document.getElementById('syncStatus').textContent = 'players synced';
  } catch(e){
    // if API unreachable, try local fallback
    document.getElementById('syncStatus').textContent = 'player sync failed (API)';
  }
}

/* register / update own player record */
async function upsertPlayerRecord() {
  const payload = {
    id: player.id,
    x: player.x,
    y: player.y,
    inventory: player.inventory,
    lastSeen: Date.now()
  };
  try {
    // If player.id exists, try PUT, else POST
    const method = player.id ? 'PUT' : 'POST';
    const url = player.id ? `${CONFIG.API_PLAYERS}/${player.id}` : CONFIG.API_PLAYERS;
    const res = await fetch(url, {
      method,
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify(payload)
    });
    if(!res.ok) throw new Error('upsert failed');
    const data = await res.json();
    player.id = data.id;
    localStorage.setItem(CONFIG.PLAYER_ID_KEY, player.id);
  } catch(err){
    // ignore; offline mode
  }
}

/* ------------- INIT ------------- */
function init() {
  resizeCanvasToFit();
  // load local player id if any
  player.id = localStorage.getItem(CONFIG.PLAYER_ID_KEY) || null;
  // seed label
  document.getElementById('seedLabel').textContent = CONFIG.SEED;

  // initial chunks around spawn
  streamChunksAroundPlayer();

  // start loops
  setInterval(tickMining, 120);
  setInterval(()=>{ tickMining(); }, 150);
  setInterval(syncPlayers, CONFIG.SYNC_INTERVAL);
  setInterval(upsertPlayerRecord, CONFIG.SYNC_INTERVAL);
  setInterval(()=>{ scheduleWorldSave(); }, 60000); // auto periodic save

  // initial UI binding
  document.getElementById('btnSaveWorld').onclick = ()=>saveWorldToServer();
  document.getElementById('btnSyncPlayers').onclick = ()=>syncPlayers();

  // populate sample crafting recipes in UI
  refreshUI();

  requestAnimationFrame(loop);
}
init();

/* ------------- NOTES: design choices & fallback -------------
 - Chunks are generated deterministically from SEED + chunk coords.
 - The code saves only modified chunks to the API; if the API fails the world is stored to localStorage.
 - Player syncing uses the players endpoint: GET /players to list others; POST/PUT to create/update your player.
 - Mining is immediate (break -> drop item into inventory). You can expand to require tools / progress bars.
 - Caves sometimes reach the surface by deliberate small probability in generator.
 - Multiplayer is simplified; secure/auth not included because mockapi is public. You may add identifiers & auth later.
 - This file intentionally keeps all client logic in a single file for easier editing — we can refactor to modules next.
------------------------------------------- */

