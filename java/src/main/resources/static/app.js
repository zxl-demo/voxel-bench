import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';

// ---- constants (SPEC v3) ----
const MATERIALS = [
  ['grass', '草'], ['dirt', '泥土'], ['stone', '石头'],
  ['wood', '木头'], ['glass', '玻璃'], ['brick', '砖块'],
  ['sand', '沙子'], ['snow', '雪'], ['metal', '金属'], ['leaves', '树叶'],
];
const COLORS = [
  ['red', '红', 0xe53935], ['orange', '橙', 0xfb8c00], ['yellow', '黄', 0xfdd835],
  ['green', '绿', 0x43a047], ['blue', '蓝', 0x1e88e5], ['purple', '紫', 0x8e24aa],
  ['white', '白', 0xf5f5f5], ['black', '黑', 0x212121],
  ['pink', '粉', 0xf06292], ['brown', '棕', 0x8d6e63], ['cyan', '青', 0x00acc1],
  ['lime', '酸橙绿', 0x9ccc65], ['gold', '金', 0xffb300], ['silver', '银灰', 0xbdbdbd],
  ['darkblue', '深蓝', 0x1565c0], ['darkred', '深红', 0xb71c1c],
];
const COLOR_HEX = Object.fromEntries(COLORS.map(([id, , hex]) => [id, hex]));
const MATERIAL_NAME = Object.fromEntries(MATERIALS.map(([id, name]) => [id, name]));
const COLOR_NAME = Object.fromEntries(COLORS.map(([id, name]) => [id, name]));
const MATERIAL_ROUGHNESS = { grass: 0.9, dirt: 1.0, stone: 0.95, wood: 0.8, glass: 0.15, brick: 0.9, sand: 1.0, snow: 0.9, metal: 0.35, leaves: 1.0 };

// ---- state ----
let ws = null;
let myId = null;
let myNickname = '';
let myState = 'watching'; // watching | queued | placing
let myDeadline = 0;
let turnSeconds = 30;
let blocksPerTurn = 5;
let deletesPerTurn = 1;
let placersMax = 3;
let queueMaxLength = 20;
let selMaterial = 'grass';
let selColor = 'green';
let queuePosition = 0;
let waitingCount = 0;
let waitingList = []; // [{clientId, nickname}]
let placingList = []; // [{clientId, nickname, deadline, pendingCount}]
let myPendingCount = 0;
let secondsLeftMap = new Map(); // clientId -> secondsLeft (from countdown)
let nicknames = new Map(); // clientId -> nickname
let selectedKey = null; // key of the selected own pending block, or null
let deleteMode = false; // delete mode: left-click a confirmed block to delete it
let reconnectTimer = null;
let gotInit = false; // current connection received init (handshake fully succeeded)
let handshakeFailed = false; // onerror fired before init: handshake refused

// ---- procedural textures (luminance patterns; color is multiplied in) ----
const textureCache = new Map();
function canvasTexture(key, draw) {
  let tex = textureCache.get(key);
  if (tex) return tex;
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  draw(c.getContext('2d'));
  tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  textureCache.set(key, tex);
  return tex;
}

// random speckles inside [x0, y0, w, h] (defaults to the whole canvas)
function speckle(ctx, colors, n, size, x0 = 0, y0 = 0, w = 128, h = 128) {
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = colors[(Math.random() * colors.length) | 0];
    const s = 1 + ((Math.random() * size) | 0);
    ctx.fillRect(x0 + ((Math.random() * w) | 0), y0 + ((Math.random() * h) | 0), s, s);
  }
}

function textureFor(material, face) {
  const key = material + ':' + face;
  switch (key) {
    case 'grass:top':
      return canvasTexture(key, (ctx) => {
        ctx.fillStyle = '#e8f5e9'; ctx.fillRect(0, 0, 128, 128);
        speckle(ctx, ['#c8e6c9', '#a5d6a7', '#81c784'], 900, 4);
      });
    case 'grass:side':
      return canvasTexture(key, (ctx) => {
        ctx.fillStyle = '#d7ccc8'; ctx.fillRect(0, 0, 128, 128);
        speckle(ctx, ['#bcaaa4', '#a1887f', '#8d6e63'], 700, 4);
        // grass strip on top (canvas top maps to the top of the face)
        ctx.fillStyle = '#c8e6c9'; ctx.fillRect(0, 0, 128, 18);
        speckle(ctx, ['#a5d6a7', '#81c784'], 130, 3, 0, 0, 128, 18);
      });
    case 'dirt:flat':
      return canvasTexture(key, (ctx) => {
        ctx.fillStyle = '#d7ccc8'; ctx.fillRect(0, 0, 128, 128);
        speckle(ctx, ['#bcaaa4', '#a1887f', '#8d6e63', '#6d4c41'], 900, 5);
      });
    case 'stone:flat':
      return canvasTexture(key, (ctx) => {
        ctx.fillStyle = '#e0e0e0'; ctx.fillRect(0, 0, 128, 128);
        speckle(ctx, ['#bdbdbd', '#9e9e9e', '#eeeeee'], 800, 4);
        ctx.strokeStyle = '#757575'; ctx.lineWidth = 2;
        for (let i = 0; i < 4; i++) {
          ctx.beginPath();
          let x = Math.random() * 128, y = Math.random() * 128;
          ctx.moveTo(x, y);
          for (let j = 0; j < 4; j++) {
            x += (Math.random() - 0.5) * 60;
            y += (Math.random() - 0.5) * 60;
            ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
      });
    case 'wood:flat':
      return canvasTexture(key, (ctx) => {
        for (let p = 0; p < 4; p++) {
          ctx.fillStyle = p % 2 ? '#e3d5bd' : '#d9c9ac';
          ctx.fillRect(p * 32, 0, 32, 128);
          ctx.fillStyle = '#bcaaa4'; ctx.fillRect(p * 32, 0, 2, 128);
        }
        // grain lines + knots
        ctx.strokeStyle = '#c9b896'; ctx.lineWidth = 1;
        for (let i = 0; i < 24; i++) {
          const x = Math.random() * 128;
          ctx.beginPath(); ctx.moveTo(x, 0);
          ctx.bezierCurveTo(x + 4, 42, x - 4, 86, x + 2, 128);
          ctx.stroke();
        }
        ctx.fillStyle = '#a1887f';
        for (let i = 0; i < 3; i++) {
          ctx.beginPath();
          ctx.ellipse(Math.random() * 128, Math.random() * 128, 4, 6, 0, 0, Math.PI * 2);
          ctx.fill();
        }
      });
    case 'glass:flat':
      return canvasTexture(key, (ctx) => {
        ctx.fillStyle = '#e3f2fd'; ctx.fillRect(0, 0, 128, 128);
        ctx.strokeStyle = 'rgba(255,255,255,0.95)'; ctx.lineWidth = 6;
        ctx.strokeRect(3, 3, 122, 122);
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.save();
        ctx.translate(64, 64); ctx.rotate(-Math.PI / 4);
        ctx.fillRect(-8, -100, 16, 200);
        ctx.restore();
      });
    case 'brick:flat':
      return canvasTexture(key, (ctx) => {
        ctx.fillStyle = '#8d7d74'; ctx.fillRect(0, 0, 128, 128); // mortar (dark, survives color tint)
        const bh = 16, bw = 32;
        const tones = ['#d7a08f', '#c98d7c', '#e0b3a2', '#bd7f6e'];
        for (let row = 0; row < 8; row++) {
          const off = (row % 2) * (bw / 2);
          for (let col = -1; col < 5; col++) {
            const x = col * bw + off + 2, y = row * bh + 2;
            ctx.fillStyle = tones[(Math.random() * tones.length) | 0];
            ctx.fillRect(x, y, bw - 4, bh - 4);
            ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.fillRect(x, y, bw - 4, 2); // top highlight
            ctx.fillStyle = 'rgba(0,0,0,0.18)'; ctx.fillRect(x, y + bh - 6, bw - 4, 2); // bottom shade
          }
        }
      });
    case 'sand:flat':
      return canvasTexture(key, (ctx) => {
        ctx.fillStyle = '#f5ecd7'; ctx.fillRect(0, 0, 128, 128);
        // finer grains than dirt
        speckle(ctx, ['#e8dcc0', '#dccfa8', '#f9f3e2'], 1600, 2);
      });
    case 'snow:flat':
      return canvasTexture(key, (ctx) => {
        ctx.fillStyle = '#f7fafc'; ctx.fillRect(0, 0, 128, 128);
        // sparse pale-blue glints on a near-white base
        speckle(ctx, ['#e3f2fd', '#bbdefb', '#ffffff'], 120, 3);
      });
    case 'metal:flat':
      return canvasTexture(key, (ctx) => {
        ctx.fillStyle = '#e8e8e8'; ctx.fillRect(0, 0, 128, 128);
        // horizontal brushed lines
        for (let y = 0; y < 128; y += 2) {
          ctx.fillStyle = (y / 2) % 2 ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.25)';
          ctx.fillRect(0, y, 128, 1);
        }
        // dark seams
        ctx.fillStyle = '#616161';
        ctx.fillRect(0, 42, 128, 2);
        ctx.fillRect(0, 86, 128, 2);
      });
    case 'leaves:flat':
      return canvasTexture(key, (ctx) => {
        ctx.fillStyle = '#c8e6c9'; ctx.fillRect(0, 0, 128, 128);
        // dark-green clusters
        for (let i = 0; i < 26; i++) {
          ctx.fillStyle = ['#81c784', '#66bb6a', '#a5d6a7'][(Math.random() * 3) | 0];
          ctx.beginPath();
          ctx.ellipse(Math.random() * 128, Math.random() * 128,
            10 + Math.random() * 12, 8 + Math.random() * 10, Math.random() * Math.PI, 0, Math.PI * 2);
          ctx.fill();
        }
        speckle(ctx, ['#2e7d32', '#43a047'], 200, 3);
      });
    default:
      return canvasTexture(key, (ctx) => {
        ctx.fillStyle = '#eeeeee'; ctx.fillRect(0, 0, 128, 128);
      });
  }
}

// ---- three.js scene ----
const container = document.getElementById('scene-container');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xdfe9f2);
scene.fog = new THREE.Fog(0xdfe9f2, 90, 260);

const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 1000);
const HOME_POS = new THREE.Vector3(12, 20, 12);
const HOME_TARGET = new THREE.Vector3(0, 1, 0);
camera.position.copy(HOME_POS);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
container.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI * 0.495;
controls.target.copy(HOME_TARGET);
controls.listenToKeyEvents(window); // arrow keys pan

scene.add(new THREE.AmbientLight(0xffffff, 0.75));
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
sun.position.set(10, 24, 12);
scene.add(sun);

const grid = new THREE.GridHelper(400, 400, 0x546e7a, 0x90a4ae);
grid.position.y = 0;
scene.add(grid);

const groundMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
const ground = new THREE.Mesh(new THREE.PlaneGeometry(2000, 2000), groundMat);
ground.rotation.x = -Math.PI / 2;
ground.position.y = 0;
ground.name = 'ground';
scene.add(ground);

const boxGeo = new THREE.BoxGeometry(1, 1, 1);
const matCache = new Map();
function blockMaterial(material, color, pending = false) {
  const key = material + '|' + color + (pending ? '|p' : '');
  let m = matCache.get(key);
  if (m) return m;
  const mk = (tex) => new THREE.MeshStandardMaterial({
    map: tex,
    color: COLOR_HEX[color] ?? 0xffffff,
    roughness: MATERIAL_ROUGHNESS[material] ?? 0.9,
    metalness: 0,
    transparent: pending || material === 'glass',
    opacity: pending ? 0.85 : (material === 'glass' ? 0.45 : 1.0),
  });
  if (material === 'grass') {
    // BoxGeometry material order: +x, -x, +y, -y, +z, -z
    const top = textureFor('grass', 'top');
    const side = textureFor('grass', 'side');
    const bottom = textureFor('dirt', 'flat');
    m = [mk(side), mk(side), mk(top), mk(bottom), mk(side), mk(side)];
  } else {
    m = mk(textureFor(material, 'flat'));
  }
  matCache.set(key, m);
  return m;
}

const blocks = new Map(); // "x,y,z" -> Mesh
function keyOf(x, y, z) { return x + ',' + y + ',' + z; }

function addPendingEdge(mesh) {
  const edge = new THREE.LineSegments(
    new THREE.EdgesGeometry(boxGeo),
    new THREE.LineBasicMaterial({ color: 0xef6c00, transparent: true, opacity: 1 })
  );
  edge.scale.setScalar(1.002);
  mesh.add(edge);
  mesh.userData.edge = edge;
}

function addBlock(b) {
  const k = keyOf(b.x, b.y, b.z);
  if (blocks.has(k)) return;
  const pending = !!b.pending;
  const mesh = new THREE.Mesh(boxGeo, blockMaterial(b.material, b.color, pending));
  mesh.position.set(b.x + 0.5, b.y + 0.5, b.z + 0.5);
  mesh.userData = {
    coord: { x: b.x, y: b.y, z: b.z },
    material: b.material, color: b.color,
    by: b.by ?? '', byId: b.byId ?? null,
    placedAt: b.placedAt ?? null, pending, edge: null,
  };
  mesh.name = 'block';
  if (pending) addPendingEdge(mesh);
  scene.add(mesh);
  blocks.set(k, mesh);
}

function confirmBlock(b) {
  const k = keyOf(b.x, b.y, b.z);
  const mesh = blocks.get(k);
  if (!mesh) { addBlock(b); return; }
  mesh.material = blockMaterial(b.material, b.color, false);
  if (mesh.userData.edge) {
    mesh.remove(mesh.userData.edge);
    mesh.userData.edge = null;
  }
  Object.assign(mesh.userData, { pending: false, by: b.by, placedAt: b.placedAt });
}

function removeBlock(x, y, z) {
  const k = keyOf(x, y, z);
  const mesh = blocks.get(k);
  if (!mesh) return;
  scene.remove(mesh);
  blocks.delete(k);
  if (selectedKey === k) { selectedKey = null; renderState(); }
}

function moveBlock(from, to) {
  const fk = keyOf(from.x, from.y, from.z);
  const mesh = blocks.get(fk);
  if (!mesh) return;
  blocks.delete(fk);
  mesh.position.set(to.x + 0.5, to.y + 0.5, to.z + 0.5);
  mesh.userData.coord = { x: to.x, y: to.y, z: to.z };
  blocks.set(keyOf(to.x, to.y, to.z), mesh);
  if (selectedKey === fk) selectedKey = keyOf(to.x, to.y, to.z);
}

function clearBlocks() {
  for (const mesh of blocks.values()) scene.remove(mesh);
  blocks.clear();
  selectedKey = null;
}

// ghost preview (current material/color texture, translucent + colored edge)
function ghostMaterials() {
  const mk = (tex) => new THREE.MeshStandardMaterial({
    map: tex,
    color: COLOR_HEX[selColor] ?? 0xffffff,
    roughness: MATERIAL_ROUGHNESS[selMaterial] ?? 0.9,
    metalness: 0,
    transparent: true, opacity: 0.55, depthWrite: false,
  });
  if (selMaterial === 'grass') {
    const top = textureFor('grass', 'top');
    const side = textureFor('grass', 'side');
    const bottom = textureFor('dirt', 'flat');
    return [mk(side), mk(side), mk(top), mk(bottom), mk(side), mk(side)];
  }
  return mk(textureFor(selMaterial, 'flat'));
}
const ghost = new THREE.Mesh(boxGeo, ghostMaterials());
ghost.visible = false;
const ghostEdge = new THREE.LineSegments(
  new THREE.EdgesGeometry(boxGeo),
  new THREE.LineBasicMaterial({ color: 0x2e7d32 })
);
ghostEdge.scale.setScalar(1.002);
ghost.add(ghostEdge);
scene.add(ghost);
let ghostTarget = null; // {x,y,z} or null
let ghostValid = false;
let lastPick = null; // last pointermove pick (for instant ghost rebuild)

function rebuildGhost() {
  const old = ghost.material;
  if (Array.isArray(old)) old.forEach(m => m.dispose());
  else old.dispose();
  ghost.material = ghostMaterials();
  updateGhostFromPick(lastPick);
}

// ---- picking ----
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

// client-side support check (mirror of the server rule): a neighbor counts
// if it is confirmed, or is one of MY pending blocks
function isSupported(x, y, z) {
  if (y === 0) return true;
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
    const m = blocks.get(keyOf(x + dx, y + dy, z + dz));
    if (m && (!m.userData.pending || m.userData.byId === myId)) return true;
  }
  return false;
}

// one raycast: returns {target: grid cell, hitMesh: block mesh or null} or null
function doPick(clientX, clientY) {
  pointer.x = (clientX / innerWidth) * 2 - 1;
  pointer.y = -(clientY / innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects([ground, ...blocks.values()], false);
  if (!hits.length) return null;
  const hit = hits[0];
  if (hit.object.name === 'block') {
    const c = hit.object.userData.coord;
    const n = hit.face.normal;
    return {
      target: { x: c.x + Math.round(n.x), y: c.y + Math.round(n.y), z: c.z + Math.round(n.z) },
      hitMesh: hit.object,
    };
  }
  // ground plane
  return { target: { x: Math.floor(hit.point.x), y: 0, z: Math.floor(hit.point.z) }, hitMesh: null };
}

function updateGhostFromPick(pick) {
  ghostTarget = pick ? pick.target : null;
  if (myState !== 'placing' || deleteMode || !pick) {
    ghost.visible = false;
    ghostValid = false;
    updatePlaceStatus();
    return;
  }
  const t = pick.target;
  ghostValid = myPendingCount < blocksPerTurn
    && !blocks.has(keyOf(t.x, t.y, t.z)) && isSupported(t.x, t.y, t.z) && t.y >= 0;
  ghost.position.set(t.x + 0.5, t.y + 0.5, t.z + 0.5);
  ghostEdge.material.color.setHex(ghostValid ? 0x2e7d32 : 0xc62828);
  ghost.visible = true;
  updatePlaceStatus();
}

function fmtTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

function updateTooltip(e, pick) {
  const tip = $('block-tip');
  const hit = pick ? pick.hitMesh : null;
  if (!hit) { tip.classList.add('hidden'); return; }
  const u = hit.userData;
  tip.textContent = u.pending
    ? `待确认 · ${u.by || '?'}` 
    : `${u.by || '?'} · ${fmtTime(u.placedAt)} · ${MATERIAL_NAME[u.material] ?? u.material}/${COLOR_NAME[u.color] ?? u.color}`;
  tip.style.left = (e.clientX + 14) + 'px';
  tip.style.top = (e.clientY + 14) + 'px';
  tip.classList.remove('hidden');
}

renderer.domElement.addEventListener('pointermove', (e) => {
  lastPick = doPick(e.clientX, e.clientY);
  updateGhostFromPick(lastPick);
  updateTooltip(e, lastPick);
});
renderer.domElement.addEventListener('pointerleave', () => {
  ghost.visible = false;
  ghostTarget = null;
  lastPick = null;
  $('block-tip').classList.add('hidden');
  updatePlaceStatus();
});

let downPos = null;
let longPressTimer = null;
let suppressClick = false;
renderer.domElement.addEventListener('pointerdown', (e) => {
  downPos = [e.clientX, e.clientY];
  suppressClick = false;
  // touch long-press (500ms, no move) selects own pending block, like right-click
  if (e.pointerType === 'touch') {
    clearTimeout(longPressTimer);
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      if (myState === 'placing' && !deleteMode) {
        handleSelectClick(doPick(e.clientX, e.clientY));
        suppressClick = true;
      }
    }, 500);
  }
});
renderer.domElement.addEventListener('pointermove', (e) => {
  if (downPos && longPressTimer) {
    const dx = e.clientX - downPos[0], dy = e.clientY - downPos[1];
    if (dx * dx + dy * dy > 100) { clearTimeout(longPressTimer); longPressTimer = null; }
  }
});
renderer.domElement.addEventListener('pointercancel', () => {
  clearTimeout(longPressTimer);
  longPressTimer = null;
  downPos = null;
});
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
renderer.domElement.addEventListener('pointerup', (e) => {
  clearTimeout(longPressTimer);
  longPressTimer = null;
  if (!downPos) return;
  const dx = e.clientX - downPos[0], dy = e.clientY - downPos[1];
  downPos = null;
  if (dx * dx + dy * dy > 36) return; // it was a drag, not a click
  if (suppressClick) { suppressClick = false; return; } // was a long-press select
  if (e.button === 2) {
    // right-click: exit delete mode, or select/deselect own pending block (placing only)
    if (myState === 'placing') {
      if (deleteMode) exitDeleteMode();
      else handleSelectClick(doPick(e.clientX, e.clientY));
    }
    return;
  }
  if (e.button !== 0) return; // only left clicks place / delete / show info
  const pick = doPick(e.clientX, e.clientY);
  if (myState === 'placing') {
    if (deleteMode) handleDeleteClick(pick);
    else handlePlacingClick(pick);
  } else handleWatchClick(pick);
});

// right-click (or touch long-press): toggle selection of own pending block.
// Left-click stays pure place/move so a block can always be stacked on top
// of your own pending block by clicking its top face.
function handleSelectClick(pick) {
  const hit = pick ? pick.hitMesh : null;
  if (hit && hit.userData.pending && hit.userData.byId === myId) {
    const k = keyOf(hit.userData.coord.x, hit.userData.coord.y, hit.userData.coord.z);
    if (selectedKey === k) clearSelection();
    else selectPending(k);
  } else {
    clearSelection();
  }
}

function handlePlacingClick(pick) {
  if (selectedKey) {
    const selMesh = blocks.get(selectedKey);
    if (!selMesh) { clearSelection(); return; }
    if (pick && pick.target) {
      ws.send(JSON.stringify({ type: 'move', from: selMesh.userData.coord, to: pick.target }));
    } else {
      clearSelection();
    }
    return;
  }
  updateGhostFromPick(pick);
  if (!ghostTarget || !ghostValid) {
    if (ghostTarget) {
      if (myPendingCount >= blocksPerTurn) showToast(`本轮已放满 ${blocksPerTurn} 个，请先确认放置`);
      else showToast('这里不能放：' + (blocks.has(keyOf(ghostTarget.x, ghostTarget.y, ghostTarget.z)) ? '已有方块' : '方块不可以放到空中'));
    }
    return;
  }
  ws.send(JSON.stringify({
    type: 'place', x: ghostTarget.x, y: ghostTarget.y, z: ghostTarget.z,
    material: selMaterial, color: selColor,
  }));
}

function handleWatchClick(pick) {
  const hit = pick ? pick.hitMesh : null;
  if (hit && !hit.userData.pending) showBlockInfo(hit.userData);
  else hideBlockInfo();
}

// delete mode: left-click a confirmed block to delete it (with a confirm
// dialog). Clicking empty space / ground / a pending block does nothing.
function handleDeleteClick(pick) {
  const hit = pick ? pick.hitMesh : null;
  if (!hit || hit.userData.pending) return;
  const c = hit.userData.coord;
  const who = hit.userData.by ? `（放置人：${hit.userData.by}）` : '';
  const warn = myPendingCount > 0
    ? `\n删除后本回合立即结束，你本轮的 ${myPendingCount} 个待确认方块会被清除。`
    : '\n删除后本回合立即结束。';
  if (!confirm(`确认删除 (${c.x}, ${c.y}, ${c.z}) 的方块吗？${who}${warn}`)) return;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'delete', x: c.x, y: c.y, z: c.z }));
  }
}

// ---- keyboard roaming (WASD + Q/E, Shift = 3x) ----
const keys = new Set();
addEventListener('keydown', (e) => {
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
  const k = e.key.toLowerCase();
  if (['w', 'a', 's', 'd', 'q', 'e', 'shift'].includes(k)) keys.add(k);
  if (e.key === 'Escape') { clearSelection(); exitDeleteMode(); }
});
addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _move = new THREE.Vector3();
function updateKeys(dt) {
  if (!keys.size) return;
  camera.getWorldDirection(_fwd);
  _fwd.y = 0;
  if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, -1);
  _fwd.normalize();
  _right.crossVectors(_fwd, _up).normalize();
  _move.set(0, 0, 0);
  if (keys.has('w')) _move.add(_fwd);
  if (keys.has('s')) _move.sub(_fwd);
  if (keys.has('d')) _move.add(_right);
  if (keys.has('a')) _move.sub(_right);
  if (keys.has('e')) _move.y += 1;
  if (keys.has('q')) _move.y -= 1;
  if (_move.lengthSq() === 0) return;
  _move.normalize().multiplyScalar((keys.has('shift') ? 72 : 24) * dt);
  camera.position.add(_move);
  controls.target.add(_move);
}

function pulseEdges() {
  const op = 0.75 + 0.25 * Math.sin(performance.now() / 250); // 0.5 ~ 1.0
  for (const mesh of blocks.values()) {
    const u = mesh.userData;
    if (u.pending && u.byId === myId && u.edge) {
      if (keyOf(u.coord.x, u.coord.y, u.coord.z) !== selectedKey) {
        u.edge.material.opacity = op;
      }
    }
  }
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.1);
  updateKeys(dt);
  controls.update();
  updateCountdownBar();
  pulseEdges();
  renderer.render(scene, camera);
}
animate();

// ---- UI ----
const $ = (id) => document.getElementById(id);
const statusText = $('status-text');
const queueBtn = $('queue-btn');
const queueInfo = $('queue-info');
const countdownWrap = $('countdown-wrap');
const countdownBar = $('countdown-bar');
const countdownText = $('countdown-text');

function buildChoices() {
  const mWrap = $('materials');
  for (const [id, name] of MATERIALS) {
    const b = document.createElement('button');
    b.className = 'choice' + (id === selMaterial ? ' selected' : '');
    b.textContent = name;
    b.onclick = () => {
      selMaterial = id;
      mWrap.querySelectorAll('.choice').forEach(el => el.classList.remove('selected'));
      b.classList.add('selected');
      rebuildGhost();
    };
    mWrap.appendChild(b);
  }
  const cWrap = $('colors');
  for (const [id, name, hex] of COLORS) {
    const b = document.createElement('button');
    b.className = 'swatch' + (id === selColor ? ' selected' : '');
    b.title = name;
    b.style.background = '#' + hex.toString(16).padStart(6, '0');
    b.onclick = () => {
      selColor = id;
      cWrap.querySelectorAll('.swatch').forEach(el => el.classList.remove('selected'));
      b.classList.add('selected');
      rebuildGhost();
    };
    cWrap.appendChild(b);
  }
}
buildChoices();

queueBtn.onclick = () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (myState === 'queued') ws.send(JSON.stringify({ type: 'leave' }));
  else if (myState === 'watching') ws.send(JSON.stringify({ type: 'join' }));
};

$('confirm-btn').onclick = () => {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'confirm' }));
};
$('cancel-btn').onclick = () => {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'cancel' }));
};
$('remove-selected-btn').onclick = () => {
  if (!selectedKey || !ws || ws.readyState !== WebSocket.OPEN) return;
  const mesh = blocks.get(selectedKey);
  if (!mesh) { clearSelection(); return; }
  const c = mesh.userData.coord;
  ws.send(JSON.stringify({ type: 'remove', x: c.x, y: c.y, z: c.z }));
};
const deleteBtn = $('delete-btn');
deleteBtn.onclick = () => {
  if (myState !== 'placing') return;
  if (deleteMode) exitDeleteMode();
  else enterDeleteMode();
};
$('reset-view-btn').onclick = () => {
  camera.position.copy(HOME_POS);
  controls.target.copy(HOME_TARGET);
  controls.update();
};

// nickname editing
const nickSpan = $('my-nickname');
const nickInput = $('nickname-input');
function openNicknameEditor() {
  nickInput.value = myNickname;
  nickSpan.classList.add('hidden');
  $('rename-btn').classList.add('hidden');
  nickInput.classList.remove('hidden');
  nickInput.focus();
  nickInput.select();
}
function closeNicknameEditor() {
  nickInput.classList.add('hidden');
  nickSpan.classList.remove('hidden');
  $('rename-btn').classList.remove('hidden');
}
nickSpan.onclick = openNicknameEditor;
$('rename-btn').onclick = openNicknameEditor;
nickInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const name = nickInput.value.trim();
    closeNicknameEditor();
    if (name && name !== myNickname && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'rename', nickname: name }));
    }
  } else if (e.key === 'Escape') {
    closeNicknameEditor();
  }
  e.stopPropagation();
});
nickInput.addEventListener('blur', closeNicknameEditor);

function selectPending(key) {
  clearSelection();
  selectedKey = key;
  const mesh = blocks.get(key);
  if (mesh && mesh.userData.edge) {
    mesh.userData.edge.material.color.setHex(0xfdd835);
    mesh.userData.edge.material.opacity = 1;
  }
  renderState();
}

function clearSelection() {
  if (selectedKey) {
    const mesh = blocks.get(selectedKey);
    if (mesh && mesh.userData.edge) {
      mesh.userData.edge.material.color.setHex(0xef6c00);
    }
  }
  if (selectedKey !== null) {
    selectedKey = null;
    renderState();
  }
}

function enterDeleteMode() {
  deleteMode = true;
  clearSelection();
  ghost.visible = false;
  ghostTarget = null;
  deleteBtn.textContent = '退出删除模式';
  deleteBtn.style.background = '#ffcdd2';
  updatePlaceStatus();
}

function exitDeleteMode() {
  if (!deleteMode) return;
  deleteMode = false;
  deleteBtn.textContent = '删除方块';
  deleteBtn.style.background = '';
  updatePlaceStatus();
}

function showBlockInfo(u) {
  $('block-info').innerHTML =
    `<div><span>放置人</span>${u.by || '?'}</div>` +
    `<div><span>放置时间</span>${fmtTime(u.placedAt)}</div>` +
    `<div><span>材质</span>${MATERIAL_NAME[u.material] ?? u.material}</div>` +
    `<div><span>颜色</span>${COLOR_NAME[u.color] ?? u.color}</div>` +
    `<div><span>坐标</span>(${u.coord.x}, ${u.coord.y}, ${u.coord.z})</div>`;
  $('block-info-section').classList.remove('hidden');
}
function hideBlockInfo() {
  $('block-info-section').classList.add('hidden');
}

let toastTimer = null;
function showToast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3000);
}

function updatePlaceStatus() {
  const el = $('place-status');
  if (myState !== 'placing') { el.textContent = '不在放置回合'; el.className = ''; return; }
  if (deleteMode) { el.textContent = '删除模式：点击一个已确认方块删除，删除后本回合立即结束'; el.className = 'bad'; return; }
  if (selectedKey) { el.textContent = '已选中：左键点目标格移动它（Esc 或右键取消）'; el.className = 'good'; return; }
  if (myPendingCount >= blocksPerTurn) { el.textContent = '本轮已放满'; el.className = 'bad'; return; }
  if (!ghostTarget) { el.textContent = '将鼠标移到地面或方块上'; el.className = ''; return; }
  if (blocks.has(keyOf(ghostTarget.x, ghostTarget.y, ghostTarget.z))) {
    el.textContent = '不可放置：已有方块'; el.className = 'bad'; return;
  }
  if (ghostTarget.y < 0 || !isSupported(ghostTarget.x, ghostTarget.y, ghostTarget.z)) {
    el.textContent = '不可放置：不能悬空'; el.className = 'bad'; return;
  }
  el.textContent = '可放置'; el.className = 'good';
}

function renderState() {
  // the ghost only exists while placing: hide it the moment the turn ends
  // (renderState runs on every state change, pointermove never touches it)
  if (myState !== 'placing') {
    ghost.visible = false;
    ghostTarget = null;
    exitDeleteMode();
  }
  statusText.classList.remove('placing', 'queued');
  if (myState === 'placing') {
    statusText.textContent = '轮到你放置！';
    statusText.classList.add('placing');
    countdownWrap.classList.remove('hidden');
    queueBtn.disabled = true;
    queueBtn.textContent = '放置中…';
    queueBtn.classList.remove('leave');
    queueInfo.textContent = myPendingCount >= blocksPerTurn
      ? `已放满 ${blocksPerTurn} 个，请确认放置`
      : `点击地面或方块表面放置（${myPendingCount}/${blocksPerTurn}）`;
    $('turn-actions').classList.remove('hidden');
    $('confirm-btn').textContent = `确认放置（${myPendingCount}/${blocksPerTurn}）`;
    $('remove-selected-btn').classList.toggle('hidden', !selectedKey);
    hideBlockInfo();
  } else if (myState === 'queued') {
    statusText.textContent = '排队中';
    statusText.classList.add('queued');
    countdownWrap.classList.add('hidden');
    countdownWrap.classList.remove('urgent');
    queueBtn.disabled = false;
    queueBtn.textContent = '离开队列';
    queueBtn.classList.add('leave');
    queueInfo.textContent = `第 ${queuePosition} 位（共 ${waitingCount} 人排队）`;
    $('turn-actions').classList.add('hidden');
  } else {
    statusText.textContent = '观看中';
    countdownWrap.classList.add('hidden');
    countdownWrap.classList.remove('urgent');
    queueBtn.disabled = false;
    queueBtn.textContent = '抢占放置权';
    queueBtn.classList.remove('leave');
    queueInfo.textContent = waitingCount > 0 ? `当前 ${waitingCount} 人排队` : '队列为空，点按钮立即获得放置权';
    $('turn-actions').classList.add('hidden');
  }
  $('placer-max').textContent = placersMax;
  $('waiting-count').textContent = waitingCount;
  $('placer-count').textContent = placingList.length;
  const pWrap = $('placers');
  pWrap.innerHTML = placingList.length ? '' : '<div class="empty">暂无</div>';
  for (const p of placingList) {
    const d = document.createElement('div');
    const left = secondsLeftMap.get(p.clientId) ?? Math.max(0, Math.ceil((p.deadline - Date.now()) / 1000));
    const name = p.clientId === myId ? `你（${p.nickname}）` : p.nickname;
    d.textContent = `${name} · ${left}s · ${p.pendingCount ?? 0}/${blocksPerTurn}`;
    if (p.clientId === myId) d.className = 'me';
    pWrap.appendChild(d);
  }
  const wWrap = $('waiting');
  wWrap.innerHTML = waitingList.length ? '' : '<div class="empty">暂无</div>';
  for (const w of waitingList) {
    const d = document.createElement('div');
    d.textContent = w.clientId === myId ? `你（${w.nickname}）` : w.nickname;
    if (w.clientId === myId) d.className = 'me';
    wWrap.appendChild(d);
  }
  updatePlaceStatus();
}

function updateCountdownBar() {
  if (myState !== 'placing' || !myDeadline) return;
  const left = Math.max(0, myDeadline - Date.now());
  const secs = Math.ceil(left / 1000);
  const pct = Math.min(100, (left / (turnSeconds * 1000)) * 100);
  countdownBar.style.setProperty('--w', pct.toFixed(1) + '%');
  if (secs <= 10) {
    countdownWrap.classList.add('urgent');
    countdownText.textContent = myPendingCount > 0
      ? `还剩 ${secs} 秒，超时未确认将清除本次放置的 ${myPendingCount} 个方块`
      : `剩余 ${secs} 秒`;
  } else {
    countdownWrap.classList.remove('urgent');
    countdownText.textContent = `剩余 ${secs} 秒`;
  }
}

// ---- websocket ----
function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let base = location.pathname.replace(/[^/]*$/, '');
  if (!base.endsWith('/')) base += '/';
  return proto + '//' + location.host + base + 'ws';
}

function apiUrl(path) {
  let base = location.pathname.replace(/[^/]*$/, '');
  if (!base.endsWith('/')) base += '/';
  return base + path;
}

async function connect() {
  gotInit = false;
  handshakeFailed = false;
  // SPEC v3: fetch a one-time session token first, then connect with it.
  // Reconnects fetch a fresh token (each token is single-use).
  let token;
  try {
    const res = await fetch(apiUrl('api/session'));
    if (!res.ok) throw new Error('session ' + res.status);
    token = (await res.json()).token;
  } catch {
    // session endpoint unreachable (server down?): retry like a normal reconnect
    $('reconnect').classList.remove('hidden');
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 2000);
    return;
  }
  ws = new WebSocket(wsUrl() + '?token=' + encodeURIComponent(token));
  ws.onopen = () => {
    $('reconnect').classList.add('hidden');
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    switch (msg.type) {
      case 'init': {
        gotInit = true;
        myId = msg.me.clientId;
        myNickname = msg.me.nickname;
        nickSpan.textContent = myNickname;
        turnSeconds = msg.config.turnSeconds;
        blocksPerTurn = msg.config.blocksPerTurn ?? 5;
        deletesPerTurn = msg.config.deletesPerTurn ?? 1;
        placersMax = msg.config.placersMax;
        queueMaxLength = msg.config.queueMaxLength;
        myState = msg.me.state;
        clearBlocks();
        for (const b of msg.blocks) addBlock(b);
        $('online-count').textContent = msg.online ?? 0;
        renderState();
        break;
      }
      case 'block_placed':
        addBlock(msg);
        break;
      case 'block_moved':
        moveBlock(msg.from, msg.to);
        break;
      case 'block_removed':
        removeBlock(msg.x, msg.y, msg.z);
        break;
      case 'block_deleted':
        removeBlock(msg.x, msg.y, msg.z);
        if (msg.byId === myId) exitDeleteMode(); // only my own delete ends delete mode
        break;
      case 'blocks_confirmed':
        for (const b of msg.blocks) confirmBlock(b);
        break;
      case 'queue_state': {
        waitingList = msg.waiting;
        waitingCount = msg.waiting.length;
        placingList = msg.placing;
        for (const w of msg.waiting) nicknames.set(w.clientId, w.nickname);
        for (const p of msg.placing) nicknames.set(p.clientId, p.nickname);
        $('online-count').textContent = msg.online ?? 0;
        const mine = msg.placing.find(p => p.clientId === myId);
        if (mine) {
          myState = 'placing';
          myDeadline = mine.deadline;
          myPendingCount = mine.pendingCount ?? 0;
        } else if (msg.waiting.some(w => w.clientId === myId)) {
          myState = 'queued';
          queuePosition = msg.waiting.findIndex(w => w.clientId === myId) + 1;
          myPendingCount = 0;
        } else {
          myState = 'watching';
          myPendingCount = 0;
        }
        renderState();
        break;
      }
      case 'turn_granted':
        myState = 'placing';
        myDeadline = msg.deadline;
        blocksPerTurn = msg.blocksPerTurn ?? blocksPerTurn;
        deletesPerTurn = msg.deletesPerTurn ?? deletesPerTurn;
        myPendingCount = 0;
        clearSelection();
        exitDeleteMode();
        renderState();
        break;
      case 'turn_released': {
        myState = 'watching';
        myDeadline = 0;
        myPendingCount = 0;
        clearSelection();
        exitDeleteMode();
        if (msg.reason === 'timeout') {
          showToast(msg.cleared > 0
            ? `放置超时，本次放置的 ${msg.cleared} 个方块已清除`
            : '放置超时，放置权已释放');
        } else if (msg.reason === 'deleted') {
          showToast(msg.cleared > 0
            ? `已删除 1 个方块，本回合结束（另清除了 ${msg.cleared} 个待确认方块）`
            : '已删除 1 个方块，本回合结束');
        }
        renderState();
        break;
      }
      case 'renamed': {
        nicknames.set(msg.clientId, msg.nickname);
        if (msg.clientId === myId) {
          myNickname = msg.nickname;
          nickSpan.textContent = myNickname;
        }
        for (const mesh of blocks.values()) {
          if (mesh.userData.pending && mesh.userData.byId === msg.clientId) {
            mesh.userData.by = msg.nickname;
          }
        }
        renderState();
        break;
      }
      case 'countdown': {
        secondsLeftMap = new Map(msg.placing.map(p => [p.clientId, p.secondsLeft]));
        for (const p of msg.placing) nicknames.set(p.clientId, p.nickname);
        const mine = msg.placing.find(p => p.clientId === myId);
        if (mine) myPendingCount = mine.pendingCount ?? myPendingCount;
        renderState();
        break;
      }
      case 'error':
        showToast(msg.message || msg.code);
        break;
    }
  };
  ws.onclose = () => {
    myState = 'watching';
    myDeadline = 0;
    placingList = [];
    waitingList = [];
    myPendingCount = 0;
    selectedKey = null;
    renderState();
    if (!gotInit || handshakeFailed) {
      // handshake refused (bad token / Origin): tell the user, no silent reconnect
      showToast('连接被拒绝，请刷新页面重试');
      $('reconnect').classList.add('hidden');
      return;
    }
    $('reconnect').classList.remove('hidden');
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 2000);
  };
  ws.onerror = () => {
    if (!gotInit) handshakeFailed = true;
    try { ws.close(); } catch {}
  };
}

connect();
renderState();
