import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';

// ---- constants (SPEC v1) ----
const MATERIALS = [
  ['grass', '草'], ['dirt', '泥土'], ['stone', '石头'],
  ['wood', '木头'], ['glass', '玻璃'], ['brick', '砖块'],
];
const COLORS = [
  ['red', '红', 0xe53935], ['orange', '橙', 0xfb8c00], ['yellow', '黄', 0xfdd835],
  ['green', '绿', 0x43a047], ['blue', '蓝', 0x1e88e5], ['purple', '紫', 0x8e24aa],
  ['white', '白', 0xf5f5f5], ['black', '黑', 0x212121],
];
const COLOR_HEX = Object.fromEntries(COLORS.map(([id, , hex]) => [id, hex]));
const MATERIAL_ROUGHNESS = { grass: 0.9, dirt: 1.0, stone: 0.95, wood: 0.8, glass: 0.15, brick: 0.9 };

// ---- state ----
let ws = null;
let myId = null;
let myState = 'watching'; // watching | queued | placing
let myDeadline = 0;
let turnSeconds = 30;
let placersMax = 3;
let queueMaxLength = 20;
let selMaterial = 'grass';
let selColor = 'green';
let queuePosition = 0;
let waitingCount = 0;
let placingList = []; // [{clientId, deadline}]
let secondsLeftMap = new Map(); // clientId -> secondsLeft (from countdown)
let reconnectTimer = null;

// ---- three.js scene ----
const container = document.getElementById('scene-container');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xdfe9f2);
scene.fog = new THREE.Fog(0xdfe9f2, 90, 260);

const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 1000);
camera.position.set(14, 12, 14);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
container.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI * 0.495;
controls.target.set(0, 1, 0);

scene.add(new THREE.AmbientLight(0xffffff, 0.75));
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
sun.position.set(10, 24, 12);
scene.add(sun);

const grid = new THREE.GridHelper(400, 400, 0x90a4ae, 0xc5d3dc);
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
function blockMaterial(material, color) {
  const key = material + '|' + color;
  let m = matCache.get(key);
  if (!m) {
    const isGlass = material === 'glass';
    m = new THREE.MeshStandardMaterial({
      color: COLOR_HEX[color] ?? 0xffffff,
      roughness: MATERIAL_ROUGHNESS[material] ?? 0.9,
      metalness: 0,
      transparent: isGlass,
      opacity: isGlass ? 0.45 : 1.0,
    });
    matCache.set(key, m);
  }
  return m;
}

const blocks = new Map(); // "x,y,z" -> Mesh
function keyOf(x, y, z) { return x + ',' + y + ',' + z; }

function addBlock(x, y, z, material, color) {
  const k = keyOf(x, y, z);
  if (blocks.has(k)) return;
  const mesh = new THREE.Mesh(boxGeo, blockMaterial(material, color));
  mesh.position.set(x, y + 0.5, z);
  mesh.userData.coord = { x, y, z };
  mesh.name = 'block';
  scene.add(mesh);
  blocks.set(k, mesh);
}

function clearBlocks() {
  for (const mesh of blocks.values()) scene.remove(mesh);
  blocks.clear();
}

// ghost preview
const ghost = new THREE.Mesh(
  boxGeo,
  new THREE.MeshBasicMaterial({ color: 0x43a047, transparent: true, opacity: 0.55, depthWrite: false })
);
ghost.visible = false;
scene.add(ghost);
let ghostTarget = null; // {x,y,z} or null
let ghostValid = false;

// ---- picking ----
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

function isSupported(x, y, z) {
  if (y === 0) return true;
  return blocks.has(keyOf(x + 1, y, z)) || blocks.has(keyOf(x - 1, y, z))
    || blocks.has(keyOf(x, y + 1, z)) || blocks.has(keyOf(x, y - 1, z))
    || blocks.has(keyOf(x, y, z + 1)) || blocks.has(keyOf(x, y, z - 1));
}

function pickTarget(clientX, clientY) {
  pointer.x = (clientX / innerWidth) * 2 - 1;
  pointer.y = -(clientY / innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects([ground, ...blocks.values()], false);
  if (!hits.length) return null;
  const hit = hits[0];
  if (hit.object.name === 'block') {
    const c = hit.object.userData.coord;
    const n = hit.face.normal;
    return { x: c.x + Math.round(n.x), y: c.y + Math.round(n.y), z: c.z + Math.round(n.z) };
  }
  // ground plane
  return { x: Math.floor(hit.point.x), y: 0, z: Math.floor(hit.point.z) };
}

function updateGhost(clientX, clientY) {
  const t = pickTarget(clientX, clientY);
  ghostTarget = t;
  if (!t) { ghost.visible = false; ghostValid = false; return; }
  ghostValid = !blocks.has(keyOf(t.x, t.y, t.z)) && isSupported(t.x, t.y, t.z) && t.y >= 0;
  ghost.position.set(t.x, t.y + 0.5, t.z);
  ghost.material.color.setHex(ghostValid ? 0x43a047 : 0xe53935);
  ghost.visible = true;
}

renderer.domElement.addEventListener('pointermove', (e) => updateGhost(e.clientX, e.clientY));
renderer.domElement.addEventListener('pointerleave', () => { ghost.visible = false; ghostTarget = null; });

let downPos = null;
renderer.domElement.addEventListener('pointerdown', (e) => { downPos = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downPos) return;
  const dx = e.clientX - downPos[0], dy = e.clientY - downPos[1];
  downPos = null;
  if (dx * dx + dy * dy > 36) return; // it was a drag, not a click
  if (myState !== 'placing') return;
  updateGhost(e.clientX, e.clientY);
  if (!ghostTarget || !ghostValid) {
    if (ghostTarget) showToast('这里不能放：' + (blocks.has(keyOf(ghostTarget.x, ghostTarget.y, ghostTarget.z)) ? '已有方块' : '方块不可以放到空中'));
    return;
  }
  ws.send(JSON.stringify({
    type: 'place', x: ghostTarget.x, y: ghostTarget.y, z: ghostTarget.z,
    material: selMaterial, color: selColor,
  }));
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  updateCountdownBar();
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

let toastTimer = null;
function showToast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3000);
}

function renderState() {
  statusText.classList.remove('placing', 'queued');
  if (myState === 'placing') {
    statusText.textContent = '轮到你放置！';
    statusText.classList.add('placing');
    countdownWrap.classList.remove('hidden');
    queueBtn.disabled = true;
    queueBtn.textContent = '放置中…';
    queueBtn.classList.remove('leave');
    queueInfo.textContent = '点击地面或方块表面放下一个方块';
  } else if (myState === 'queued') {
    statusText.textContent = '排队中';
    statusText.classList.add('queued');
    countdownWrap.classList.add('hidden');
    queueBtn.disabled = false;
    queueBtn.textContent = '离开队列';
    queueBtn.classList.add('leave');
    queueInfo.textContent = `第 ${queuePosition} 位（共 ${waitingCount} 人排队）`;
  } else {
    statusText.textContent = '观看中';
    countdownWrap.classList.add('hidden');
    queueBtn.disabled = false;
    queueBtn.textContent = '抢占放置权';
    queueBtn.classList.remove('leave');
    queueInfo.textContent = waitingCount > 0 ? `当前 ${waitingCount} 人排队` : '队列为空，点按钮立即获得放置权';
  }
  $('placer-max').textContent = placersMax;
  $('waiting-count').textContent = waitingCount;
  $('placer-count').textContent = placingList.length;
  const pWrap = $('placers');
  pWrap.innerHTML = placingList.length ? '' : '<div class="empty">暂无</div>';
  for (const p of placingList) {
    const d = document.createElement('div');
    const left = secondsLeftMap.get(p.clientId) ?? Math.max(0, Math.ceil((p.deadline - Date.now()) / 1000));
    d.textContent = `${p.clientId === myId ? '你' : p.clientId} · ${left}s`;
    if (p.clientId === myId) d.className = 'me';
    pWrap.appendChild(d);
  }
}

function updateCountdownBar() {
  if (myState !== 'placing' || !myDeadline) return;
  const left = Math.max(0, myDeadline - Date.now());
  const pct = Math.min(100, (left / (turnSeconds * 1000)) * 100);
  countdownBar.style.setProperty('--w', pct.toFixed(1) + '%');
  countdownText.textContent = `剩余 ${Math.ceil(left / 1000)} 秒`;
}

// ---- websocket ----
function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let base = location.pathname.replace(/[^/]*$/, '');
  if (!base.endsWith('/')) base += '/';
  return proto + '//' + location.host + base + 'ws';
}

function connect() {
  ws = new WebSocket(wsUrl());
  ws.onopen = () => {
    $('reconnect').classList.add('hidden');
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    switch (msg.type) {
      case 'init': {
        myId = msg.me.clientId;
        turnSeconds = msg.config.turnSeconds;
        placersMax = msg.config.placersMax;
        queueMaxLength = msg.config.queueMaxLength;
        myState = msg.me.state;
        clearBlocks();
        for (const b of msg.blocks) addBlock(b.x, b.y, b.z, b.material, b.color);
        $('online-count').textContent = msg.online ?? 0;
        renderState();
        break;
      }
      case 'block_placed':
        addBlock(msg.x, msg.y, msg.z, msg.material, msg.color);
        break;
      case 'queue_state': {
        waitingCount = msg.waiting.length;
        placingList = msg.placing;
        $('online-count').textContent = msg.online ?? 0;
        if (msg.placing.some(p => p.clientId === myId)) {
          myState = 'placing';
          const mine = msg.placing.find(p => p.clientId === myId);
          if (mine) myDeadline = mine.deadline;
        } else if (msg.waiting.includes(myId)) {
          myState = 'queued';
          queuePosition = msg.waiting.indexOf(myId) + 1;
        } else {
          myState = 'watching';
        }
        renderState();
        break;
      }
      case 'turn_granted':
        myState = 'placing';
        myDeadline = msg.deadline;
        renderState();
        break;
      case 'turn_released':
        myState = 'watching';
        myDeadline = 0;
        if (msg.reason === 'timeout') showToast('放置超时，放置权已释放');
        renderState();
        break;
      case 'countdown':
        secondsLeftMap = new Map(msg.placing.map(p => [p.clientId, p.secondsLeft]));
        renderState();
        break;
      case 'error':
        showToast(msg.message || msg.code);
        break;
    }
  };
  ws.onclose = () => {
    myState = 'watching';
    myDeadline = 0;
    placingList = [];
    renderState();
    $('reconnect').classList.remove('hidden');
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 2000);
  };
  ws.onerror = () => { try { ws.close(); } catch {} };
}

connect();
renderState();
