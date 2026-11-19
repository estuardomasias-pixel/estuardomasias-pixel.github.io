// EMBERWILD VR — an open-world WebXR RPG (runs in the Quest 3 browser or on a PC screen)
import * as THREE from 'three';

// ---------------------------------------------------------------- utilities
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function makeNoise(rnd) {
  const perm = [...Array(256).keys()];
  for (let i = 255; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
  const p = new Uint8Array(512); for (let i = 0; i < 512; i++) p[i] = perm[i & 255];
  const grad = (h, x, y) => { switch (h & 7) { case 0: return x + y; case 1: return -x + y; case 2: return x - y; case 3: return -x - y; case 4: return x; case 5: return -x; case 6: return y; default: return -y; } };
  const fade = t => t * t * t * (t * (t * 6 - 15) + 10);
  return (x, y) => {
    const fx = Math.floor(x), fy = Math.floor(y); const X = fx & 255, Y = fy & 255; x -= fx; y -= fy;
    const u = fade(x), v = fade(y); const a = p[X] + Y, b = p[X + 1] + Y;
    return lerp(lerp(grad(p[a], x, y), grad(p[b], x - 1, y), u), lerp(grad(p[a + 1], x, y - 1), grad(p[b + 1], x - 1, y - 1), u), v) * 0.7;
  };
}
const rand = mulberry32(20261118);
const noise2 = makeNoise(rand);
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
function distPointSeg(p, a, b) {
  _v4.subVectors(b, a); const t = clamp(_v3.subVectors(p, a).dot(_v4) / _v4.lengthSq(), 0, 1);
  return p.distanceTo(_v3.copy(a).addScaledVector(_v4, t));
}
function segDist2D(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az; const t = clamp(((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz), 0, 1);
  return Math.hypot(px - ax - dx * t, pz - az - dz * t);
}

// ---------------------------------------------------------------- save state
const SAVE_KEY = 'emberwild-save-v1';
const DEFAULT = { level: 1, xp: 0, hp: 100, gold: 10, potions: 2, swordLv: 0, blessed: false, stage: 0, qKills: 0, crystals: [false, false, false], chests: [], x: 0, z: 9, dayT: 0.3 };
let S = structuredClone(DEFAULT);
try { const s = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null'); if (s) S = Object.assign(structuredClone(DEFAULT), s); } catch (e) { /* no storage */ }
const maxHp = () => 100 + (S.level - 1) * 15;
const xpNeed = () => Math.round(60 * Math.pow(S.level, 1.5));
function save() { try { const h = headPos(); S.x = h.x; S.z = h.z; S.dayT = dayT; localStorage.setItem(SAVE_KEY, JSON.stringify(S)); } catch (e) { } }

// ---------------------------------------------------------------- renderer / scene
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
// Graphics: sharpness + frame rate first. Resolution is a multiple of the headset's NATIVE panel resolution.
const GFX_KEY = 'emberwild-gfx-v1';
const GFX = { res: 'native', hz: 90 };
try { Object.assign(GFX, JSON.parse(localStorage.getItem(GFX_KEY) || '{}')); } catch (e) { }
const RES_MODES = { perf: { mul: 0.85, fov: 1, label: 'Performance (85%)' }, native: { mul: 1.0, fov: 0.25, label: 'Native (full sharpness)' }, super: { mul: 1.25, fov: 0.25, label: 'Supersampled (125%)' } };
renderer.xr.setFoveation(RES_MODES[GFX.res]?.fov ?? 0.25);
const MAX_ANISO = renderer.capabilities.getMaxAnisotropy();
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x8fc3ff, 70, 230);
const camera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.05, 500);
camera.rotation.order = 'YXZ';
const dolly = new THREE.Group(); dolly.add(camera); scene.add(dolly);
camera.position.set(0, 1.6, 0);
let yaw = 0, pitch = 0;

const hemi = new THREE.HemisphereLight(0xbfdcff, 0x3a4a2a, 1.2); scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff0d0, 2.4); scene.add(sun); scene.add(sun.target);

addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

// ---------------------------------------------------------------- terrain
const WORLD = 520, HALF = WORLD / 2, PLAY_RADIUS = 226;
const SITES = {
  village: { x: 0, z: 0, r: 24, h: 4 },
  tower: { x: 150, z: -140, r: 16 },
  c0: { x: -165, z: -70, r: 6 },
  c1: { x: 70, z: 170, r: 6 },
  c2: { x: -100, z: 140, r: 6 },
};
function fbm(x, z) { let h = 0, a = 1, f = 1 / 150; for (let i = 0; i < 5; i++) { h += noise2(x * f, z * f) * a; a *= 0.5; f *= 2.03; } return h; }
function rawHeight(x, z) {
  let h = fbm(x, z) * 30 + 6;
  const r = 1 - Math.abs(noise2(x / 70 + 100, z / 70 - 50));
  h += Math.max(0, fbm(x + 500, z + 500)) * r * r * 34;
  const d = Math.hypot(x, z) / HALF;
  h += Math.pow(Math.max(0, d - 0.8), 2) * 1100;
  return h;
}
for (const [k, s] of Object.entries(SITES)) if (s.h === undefined) s.h = Math.max(rawHeight(s.x, s.z), k === 'tower' ? 10 : 6);
const SITE_LIST = Object.values(SITES);
function heightAt(x, z) {
  let h = rawHeight(x, z);
  for (const s of SITE_LIST) { const d = Math.hypot(x - s.x, z - s.z); if (d < s.r * 2.4) h = lerp(s.h, h, smoothstep(s.r, s.r * 2.4, d)); }
  return h;
}
const PATHS = ['tower', 'c0', 'c1', 'c2'].map(k => [0, 0, SITES[k].x, SITES[k].z]);
const pathDist = (x, z) => Math.min(...PATHS.map(p => segDist2D(x, z, ...p)));

{
  const SEG = 220;
  const geo = new THREE.PlaneGeometry(WORLD, WORLD, SEG, SEG); geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position; const cols = new Float32Array(pos.count * 3);
  const C = { sand: new THREE.Color(0xd8c690), grass: new THREE.Color(0x63a446), grass2: new THREE.Color(0x3d7a34), dirt: new THREE.Color(0x9a7b4f), rock: new THREE.Color(0x7a7166), snow: new THREE.Color(0xeef2f5), ash: new THREE.Color(0x4a4048) };
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i), h = heightAt(x, z); pos.setY(i, h);
    if (h < 1.3) c.copy(C.sand);
    else if (h < 28) {
      c.copy(C.grass).lerp(C.grass2, (noise2(x / 22, z / 22) + 0.7) / 1.4);
      const pd = pathDist(x, z); if (pd < 3) c.lerp(C.dirt, 1 - smoothstep(1.2, 3, pd));
      const vd = Math.hypot(x, z); if (vd < 20) c.lerp(C.dirt, 0.35 * (1 - vd / 20));
      const td = Math.hypot(x - SITES.tower.x, z - SITES.tower.z); if (td < 45) c.lerp(C.ash, 1 - smoothstep(15, 45, td));
    } else if (h < 44) c.copy(C.rock).lerp(C.grass2, 1 - smoothstep(28, 34, h));
    else c.copy(C.snow).lerp(C.rock, 1 - smoothstep(44, 50, h));
    cols[i * 3] = c.r; cols[i * 3 + 1] = c.g; cols[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  geo.computeVertexNormals();
  scene.add(new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true })));
  const water = new THREE.Mesh(new THREE.PlaneGeometry(1400, 1400), new THREE.MeshLambertMaterial({ color: 0x2f6f9f, transparent: true, opacity: 0.82 }));
  water.rotation.x = -Math.PI / 2; water.position.y = 0; scene.add(water);
}

// ---------------------------------------------------------------- colliders (spatial grid)
const CELL = 8, grid = new Map();
function addCollider(x, z, r) { const k = Math.floor(x / CELL) + ',' + Math.floor(z / CELL); if (!grid.has(k)) grid.set(k, []); grid.get(k).push({ x, z, r }); }
function collide(x, z, pr) {
  const ix = Math.floor(x / CELL), iz = Math.floor(z / CELL);
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
    const list = grid.get((ix + a) + ',' + (iz + b)); if (!list) continue;
    for (const c of list) { const dx = x - c.x, dz = z - c.z, d = Math.hypot(dx, dz), m = c.r + pr; if (d < m && d > 1e-4) { x = c.x + dx / d * m; z = c.z + dz / d * m; } }
  }
  return [x, z];
}
const nearSite = (x, z, pad) => SITE_LIST.some(s => Math.hypot(x - s.x, z - s.z) < s.r + pad);

// ---------------------------------------------------------------- nature (instanced)
{
  const trunkGeo = new THREE.CylinderGeometry(0.16, 0.28, 2.2, 6); trunkGeo.translate(0, 1.1, 0);
  const pineGeo = new THREE.ConeGeometry(1.5, 4.6, 7); pineGeo.translate(0, 4.1, 0);
  const oakGeo = new THREE.IcosahedronGeometry(1.9, 0); oakGeo.translate(0, 3.6, 0);
  const pts = [];
  for (let i = 0; i < 9000 && pts.length < 2300; i++) {
    const x = (rand() - 0.5) * WORLD * 0.9, z = (rand() - 0.5) * WORLD * 0.9;
    if (Math.hypot(x, z) > PLAY_RADIUS + 15) continue;
    const h = heightAt(x, z); if (h < 1.6 || h > 34) continue;
    if (noise2(x / 80, z / 80) < -0.12 && rand() < 0.85) continue;
    if (nearSite(x, z, 8) || pathDist(x, z) < 4) continue;
    pts.push({ x, z, h, s: 0.75 + rand() * 0.9, pine: h > 16 ? rand() < 0.85 : rand() < 0.4, rot: rand() * 6.28 });
  }
  const pines = pts.filter(p => p.pine), oaks = pts.filter(p => !p.pine);
  const trunk = new THREE.InstancedMesh(trunkGeo, new THREE.MeshLambertMaterial({ color: 0x6b4a2b }), pts.length);
  const pineM = new THREE.InstancedMesh(pineGeo, new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true }), pines.length);
  const oakM = new THREE.InstancedMesh(oakGeo, new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true }), oaks.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3(), col = new THREE.Color();
  pts.forEach((t, i) => { q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, t.rot); sc.setScalar(t.s); p.set(t.x, t.h - 0.2, t.z); m.compose(p, q, sc); trunk.setMatrixAt(i, m); addCollider(t.x, t.z, 0.35 * t.s); });
  pines.forEach((t, i) => { q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, t.rot); sc.setScalar(t.s); p.set(t.x, t.h - 0.2, t.z); m.compose(p, q, sc); pineM.setMatrixAt(i, m); pineM.setColorAt(i, col.setHSL(0.33 + rand() * 0.06, 0.45, 0.22 + rand() * 0.08)); });
  oaks.forEach((t, i) => { q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, t.rot); sc.setScalar(t.s); p.set(t.x, t.h - 0.2, t.z); m.compose(p, q, sc); oakM.setMatrixAt(i, m); oakM.setColorAt(i, col.setHSL(0.2 + rand() * 0.1, 0.5, 0.3 + rand() * 0.1)); });
  scene.add(trunk, pineM, oakM);

  const rockGeo = new THREE.DodecahedronGeometry(1, 0);
  const rocks = new THREE.InstancedMesh(rockGeo, new THREE.MeshLambertMaterial({ color: 0x8a8580, flatShading: true }), 380);
  let n = 0;
  for (let i = 0; i < 4000 && n < 380; i++) {
    const x = (rand() - 0.5) * WORLD * 0.9, z = (rand() - 0.5) * WORLD * 0.9; const h = heightAt(x, z);
    if (h < 0.5 || Math.hypot(x, z) > PLAY_RADIUS + 20 || nearSite(x, z, 3) || pathDist(x, z) < 3) continue;
    const s = 0.3 + Math.pow(rand(), 2) * 2.4;
    q.setFromEuler(new THREE.Euler(rand() * 3, rand() * 3, rand() * 3)); sc.set(s, s * (0.6 + rand() * 0.5), s); p.set(x, h, z);
    m.compose(p, q, sc); rocks.setMatrixAt(n, m); rocks.setColorAt(n, col.setHSL(0.08, 0.06, 0.4 + rand() * 0.2)); n++;
    if (s > 0.9) addCollider(x, z, s * 0.9);
  }
  rocks.count = n; scene.add(rocks);

  const flowerGeo = new THREE.TetrahedronGeometry(0.14, 0);
  const flowers = new THREE.InstancedMesh(flowerGeo, new THREE.MeshBasicMaterial({ color: 0xffffff }), 2500);
  const fcols = [0xffe066, 0xff8fb3, 0xffffff, 0xb59cff, 0xff9f43]; n = 0;
  for (let i = 0; i < 12000 && n < 2500; i++) {
    const x = (rand() - 0.5) * WORLD * 0.85, z = (rand() - 0.5) * WORLD * 0.85; const h = heightAt(x, z);
    if (h < 1.5 || h > 24 || noise2(x / 30, z / 30) < 0.1) continue;
    p.set(x, h + 0.08, z); q.identity(); sc.setScalar(0.7 + rand() * 0.8); m.compose(p, q, sc);
    flowers.setMatrixAt(n, m); flowers.setColorAt(n, col.setHex(fcols[Math.floor(rand() * fcols.length)])); n++;
  }
  flowers.count = n; scene.add(flowers);
}

// ---------------------------------------------------------------- text helpers
function rr(ctx, x, y, w, h, r) { ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h); }
function wrap(ctx, text, maxW) {
  const out = []; for (const para of text.split('\n')) { let line = ''; for (const w of para.split(' ')) { const t = line ? line + ' ' + w : w; if (ctx.measureText(t).width > maxW && line) { out.push(line); line = w; } else line = t; } out.push(line); }
  return out;
}
function makePanel(w, h, cw, ch, ss = 2) { // drawn at ss x resolution so text stays crisp at native res
  const real = document.createElement('canvas'); real.width = cw * ss; real.height = ch * ss;
  const ctx = real.getContext('2d'); ctx.scale(ss, ss); const canvas = { width: cw, height: ch };
  const tex = new THREE.CanvasTexture(real); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = MAX_ANISO;
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, fog: false });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat); mesh.renderOrder = 999;
  return { mesh, ctx, canvas, mat, refresh() { tex.needsUpdate = true; } };
}
function makeLabel(text, color = '#ffe6a8', scale = 1.6) {
  const c = document.createElement('canvas'); c.width = 1024; c.height = 256; const x = c.getContext('2d'); x.scale(2, 2);
  x.font = 'bold 60px system-ui,sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.lineWidth = 10; x.strokeStyle = 'rgba(0,0,0,.75)'; x.strokeText(text, 256, 64); x.fillStyle = color; x.fillText(text, 256, 64);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = MAX_ANISO;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthWrite: false, fog: false })); s.scale.set(scale, scale / 4, 1); return s;
}

// ---------------------------------------------------------------- audio (synthesized)
let actx = null;
function ac() { if (!actx) { try { actx = new AudioContext(); } catch (e) { return null; } } if (actx.state === 'suspended') actx.resume(); return actx; }
function tone(freq, dur, type = 'sine', vol = 0.15, slide = 0, delay = 0) {
  const a = ac(); if (!a) return; const t = a.currentTime + delay;
  const o = a.createOscillator(), g = a.createGain(); o.type = type; o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.linearRampToValueAtTime(Math.max(20, freq + slide), t + dur);
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur); o.connect(g).connect(a.destination); o.start(t); o.stop(t + dur + 0.02);
}
let noiseBuf = null;
function hiss(dur, vol, freq) {
  const a = ac(); if (!a) return;
  if (!noiseBuf) { noiseBuf = a.createBuffer(1, a.sampleRate, a.sampleRate); const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }
  const s = a.createBufferSource(); s.buffer = noiseBuf; const f = a.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = 0.8;
  const g = a.createGain(); const t = a.currentTime; g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  s.connect(f).connect(g).connect(a.destination); s.start(t); s.stop(t + dur);
}
const sfx = {
  swing: () => hiss(0.18, 0.25, 1400),
  hit: () => { tone(140, 0.14, 'square', 0.12, -70); hiss(0.1, 0.35, 500); },
  kill: () => { tone(320, 0.35, 'triangle', 0.15, -260); hiss(0.3, 0.2, 300); },
  hurt: () => tone(190, 0.25, 'sawtooth', 0.15, -110),
  block: () => { tone(900, 0.08, 'square', 0.08); hiss(0.08, 0.2, 2500); },
  pickup: () => { tone(880, 0.12, 'sine', 0.15); tone(1320, 0.18, 'sine', 0.15, 0, 0.08); },
  coin: () => { tone(1560, 0.08, 'square', 0.06); tone(2090, 0.12, 'square', 0.06, 0, 0.06); },
  level: () => [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.3, 'triangle', 0.15, 0, i * 0.11)),
  quest: () => [392, 523, 659].forEach((f, i) => tone(f, 0.4, 'sine', 0.15, 0, i * 0.15)),
  drink: () => { tone(500, 0.15, 'sine', 0.12, 300); tone(700, 0.2, 'sine', 0.1, 300, 0.12); },
};

// ---------------------------------------------------------------- particles
const P_MAX = 500, pPos = new Float32Array(P_MAX * 3).fill(-9999), pCol = new Float32Array(P_MAX * 3), pVel = new Float32Array(P_MAX * 3), pLife = new Float32Array(P_MAX);
const pGeo = new THREE.BufferGeometry(); pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3)); pGeo.setAttribute('color', new THREE.BufferAttribute(pCol, 3));
const particles = new THREE.Points(pGeo, new THREE.PointsMaterial({ size: 0.13, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
particles.frustumCulled = false; scene.add(particles);
let pCursor = 0; const _pc = new THREE.Color();
function burst(p, color, n = 14, speed = 3, up = 2) {
  _pc.set(color);
  for (let i = 0; i < n; i++) {
    const k = pCursor = (pCursor + 1) % P_MAX;
    pPos[k * 3] = p.x; pPos[k * 3 + 1] = p.y; pPos[k * 3 + 2] = p.z;
    pVel[k * 3] = (Math.random() - 0.5) * speed; pVel[k * 3 + 1] = Math.random() * speed * 0.6 + up; pVel[k * 3 + 2] = (Math.random() - 0.5) * speed;
    pCol[k * 3] = _pc.r; pCol[k * 3 + 1] = _pc.g; pCol[k * 3 + 2] = _pc.b; pLife[k] = 0.5 + Math.random() * 0.6;
  }
}
function updateParticles(dt) {
  for (let k = 0; k < P_MAX; k++) {
    if (pLife[k] <= 0) continue; pLife[k] -= dt;
    if (pLife[k] <= 0) { pPos[k * 3 + 1] = -9999; continue; }
    pVel[k * 3 + 1] -= 5 * dt;
    pPos[k * 3] += pVel[k * 3] * dt; pPos[k * 3 + 1] += pVel[k * 3 + 1] * dt; pPos[k * 3 + 2] += pVel[k * 3 + 2] * dt;
  }
  pGeo.attributes.position.needsUpdate = true; pGeo.attributes.color.needsUpdate = true;
}

// ---------------------------------------------------------------- sky
const stars = (() => {
  const n = 900, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { const u = rand() * 6.283, v = Math.acos(rand() * 0.95); a[i * 3] = Math.sin(v) * Math.cos(u) * 420; a[i * 3 + 1] = Math.cos(v) * 420; a[i * 3 + 2] = Math.sin(v) * Math.sin(u) * 420; }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(a, 3));
  const s = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: 2, sizeAttenuation: false, transparent: true, fog: false, depthWrite: false }));
  s.frustumCulled = false; scene.add(s); return s;
})();
const sunDisc = new THREE.Mesh(new THREE.CircleGeometry(14, 24), new THREE.MeshBasicMaterial({ color: 0xfff2c0, fog: false }));
const moonDisc = new THREE.Mesh(new THREE.CircleGeometry(9, 24), new THREE.MeshBasicMaterial({ color: 0xdfe8ff, fog: false }));
scene.add(sunDisc, moonDisc);
let dayT = S.dayT ?? 0.3; const DAY_LEN = 600; let wasNight = null;
const SKY = { day: new THREE.Color(0x8fc3ff), night: new THREE.Color(0x0a0f2a), dusk: new THREE.Color(0xff8a50) };
const skyCol = new THREE.Color(), sunDir = new THREE.Vector3();
const sunElev = () => -Math.cos(dayT * Math.PI * 2);
const isNight = () => sunElev() < -0.05;
function updateSky(dt) {
  dayT = (dayT + dt / DAY_LEN) % 1;
  const ang = dayT * Math.PI * 2, elev = sunElev();
  sunDir.set(Math.sin(ang), elev, 0.35).normalize();
  const f = smoothstep(-0.15, 0.25, elev), dusk = clamp(1 - Math.abs(elev) / 0.3, 0, 1);
  skyCol.copy(SKY.night).lerp(SKY.day, f).lerp(SKY.dusk, dusk * 0.45);
  scene.background = skyCol; scene.fog.color.copy(skyCol);
  if (elev > -0.05) { sun.position.copy(sunDir); sun.color.setHex(0xfff0d0).lerp(SKY.dusk, dusk * 0.5); sun.intensity = 0.3 + 2.4 * f; }
  else { sun.position.copy(sunDir).negate(); sun.color.setHex(0x8899ff); sun.intensity = 0.55; }
  hemi.intensity = 0.45 + 0.9 * f; hemi.color.copy(skyCol).lerp(new THREE.Color(0xffffff), 0.4);
  stars.material.opacity = 1 - f;
  const h = headPos(); stars.position.copy(h);
  sunDisc.position.copy(h).addScaledVector(sunDir, 400); sunDisc.lookAt(h);
  moonDisc.position.copy(h).addScaledVector(sunDir, -400); moonDisc.lookAt(h);
  const night = isNight();
  if (running && wasNight !== null && night !== wasNight) toast(night ? 'Night falls. The Gloom grows bolder...' : 'Dawn breaks over Emberwild.', 3.5);
  wasNight = night;
}

// ---------------------------------------------------------------- materials & village
const M = {
  wall: new THREE.MeshLambertMaterial({ color: 0xe8d9b5 }), roof: new THREE.MeshLambertMaterial({ color: 0xa8432f, flatShading: true }),
  wood: new THREE.MeshLambertMaterial({ color: 0x6b4a2b }), dark: new THREE.MeshLambertMaterial({ color: 0x3a2a1a }),
  stone: new THREE.MeshLambertMaterial({ color: 0x5a5560, flatShading: true }), gold: new THREE.MeshLambertMaterial({ color: 0xd4a017, emissive: 0x3a2800 }),
  ember: new THREE.MeshBasicMaterial({ color: 0xff7a1a }), flame: new THREE.MeshBasicMaterial({ color: 0xffc040, transparent: true, opacity: 0.9 }),
  lamp: new THREE.MeshBasicMaterial({ color: 0xffd27a }),
};
const VH = SITES.village.h;
function house(x, z, rot, s = 1) {
  const g = new THREE.Group();
  const walls = new THREE.Mesh(new THREE.BoxGeometry(5, 3.2, 4), M.wall); walls.position.y = 1.6; g.add(walls);
  const roof = new THREE.Mesh(new THREE.ConeGeometry(4.1, 2.4, 4), M.roof); roof.position.y = 4.4; roof.rotation.y = Math.PI / 4; roof.scale.set(1, 1, 0.82); g.add(roof);
  const door = new THREE.Mesh(new THREE.BoxGeometry(1.1, 2, 0.1), M.dark); door.position.set(0, 1, 2.02); g.add(door);
  for (const sx of [-1.6, 1.6]) { const w = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.8, 0.1), M.lamp); w.position.set(sx, 1.9, 2.02); g.add(w); }
  g.position.set(x, heightAt(x, z), z); g.rotation.y = rot; g.scale.setScalar(s); scene.add(g);
  addCollider(x, z, 3.1 * s);
}
for (let i = 0; i < 7; i++) {
  const a = i / 7 * Math.PI * 2 + 0.3; if (Math.abs(Math.sin(a - 0.0)) < 0.2 && Math.cos(a) > 0) continue;
  const r = 15 + (i % 2) * 2.5; const x = Math.sin(a) * r, z = Math.cos(a) * r;
  house(x, z, Math.atan2(-x, -z), 0.9 + (i % 3) * 0.12);
}
// campfire
const fire = new THREE.Group();
for (let i = 0; i < 4; i++) { const l = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 1.3, 5), M.wood); l.rotation.z = Math.PI / 2; l.rotation.y = i * Math.PI / 4; l.position.y = 0.1; fire.add(l); }
const flames = [];
for (let i = 0; i < 3; i++) { const f = new THREE.Mesh(new THREE.ConeGeometry(0.3 - i * 0.07, 1 - i * 0.2, 6), i ? M.flame : M.ember); f.position.y = 0.5; fire.add(f); flames.push(f); }
for (let i = 0; i < 8; i++) { const s = new THREE.Mesh(new THREE.DodecahedronGeometry(0.22, 0), M.stone); s.position.set(Math.cos(i / 8 * 6.28) * 0.85, 0.1, Math.sin(i / 8 * 6.28) * 0.85); fire.add(s); }
fire.position.set(0, VH, 0); scene.add(fire); addCollider(0, 0, 1.1);
// lantern posts along paths
for (const [ax, az, bx, bz] of PATHS) {
  const len = Math.hypot(bx - ax, bz - az);
  for (let d = 26; d < Math.min(len, 90); d += 16) {
    const t = d / len, x = lerp(ax, bx, t) + (bz - az) / len * 2.6, z = lerp(az, bz, t) - (bx - ax) / len * 2.6, h = heightAt(x, z);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 2.2, 5), M.wood); post.position.set(x, h + 1.1, z);
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.32, 0.28), M.lamp); lamp.position.set(x, h + 2.3, z);
    scene.add(post, lamp);
  }
}
// ashen tower
{
  const T = SITES.tower, g = new THREE.Group();
  for (let i = 0; i < 9; i++) {
    const seg = new THREE.Mesh(new THREE.CylinderGeometry(4.2 - i * 0.18, 4.4 - i * 0.18, 3, 10, 1, i > 6), M.stone);
    seg.position.y = 1.5 + i * 3; seg.rotation.y = i * 0.3; if (i > 6) seg.scale.set(1, 1, 0.55); g.add(seg);
  }
  const door = new THREE.Mesh(new THREE.BoxGeometry(2, 3.2, 0.4), new THREE.MeshBasicMaterial({ color: 0x8a1aff })); door.position.set(0, 1.6, 4.2); g.add(door);
  for (let i = 0; i < 6; i++) { const a = i / 6 * 6.28; const pil = new THREE.Mesh(new THREE.BoxGeometry(1, 2 + (i % 3) * 1.6, 1), M.stone); pil.position.set(Math.cos(a) * 11, 1, Math.sin(a) * 11); pil.rotation.set(rand() * 0.2, a, rand() * 0.2); g.add(pil); addCollider(T.x + Math.cos(a) * 11, T.z + Math.sin(a) * 11, 0.8); }
  g.position.set(T.x, T.h, T.z); g.rotation.y = Math.atan2(-T.x, -T.z); scene.add(g); addCollider(T.x, T.z, 4.6);
  const lbl = makeLabel('The Ashen Tower', '#d9b3ff', 6); lbl.position.set(T.x, T.h + 31, T.z); scene.add(lbl);
}

// ---------------------------------------------------------------- beacons, crystals, chests, NPCs
function beam(color) { const m = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 160, 8, 1, true), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.32, fog: false, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide })); m.visible = false; scene.add(m); return m; }
const towerBeam = beam(0xb04aff); towerBeam.position.set(SITES.tower.x, SITES.tower.h + 80, SITES.tower.z);
const crystals = ['c0', 'c1', 'c2'].map((k, i) => {
  const s = SITES[k]; const g = new THREE.Group();
  const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.55, 0), new THREE.MeshBasicMaterial({ color: 0xffd84a })); gem.scale.y = 1.6; gem.position.y = 1.6; g.add(gem);
  for (let j = 0; j < 7; j++) { const a = j / 7 * 6.28; const st = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1 + rand() * 1.4, 0.6), M.stone); st.position.set(Math.cos(a) * 3.2, 0.5, Math.sin(a) * 3.2); g.add(st); }
  g.position.set(s.x, s.h, s.z); scene.add(g);
  const b = beam(0xffd84a); b.position.set(s.x, s.h + 80, s.z);
  return { i, x: s.x, z: s.z, g, gem, beam: b };
});
const chests = [];
{
  let tries = 0; const crand = mulberry32(777);
  while (chests.length < 10 && tries++ < 3000) {
    const x = (crand() - 0.5) * PLAY_RADIUS * 1.8, z = (crand() - 0.5) * PLAY_RADIUS * 1.8, h = heightAt(x, z);
    if (Math.hypot(x, z) < 45 || Math.hypot(x, z) > PLAY_RADIUS - 10 || h < 1.5 || h > 30 || nearSite(x, z, 6)) continue;
    const g = new THREE.Group();
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.5, 0.6), M.wood); base.position.y = 0.25; g.add(base);
    const lid = new THREE.Group(); lid.position.set(0, 0.5, -0.3);
    const lm = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.18, 0.62), M.wood); lm.position.set(0, 0.09, 0.3); lid.add(lm);
    const band = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.2, 0.64), M.gold); band.position.set(0, 0.09, 0.3); lid.add(band); g.add(lid);
    g.position.set(x, h, z); g.rotation.y = crand() * 6.28; scene.add(g);
    const idx = chests.length; const opened = S.chests.includes(idx); if (opened) lid.rotation.x = -1.9;
    chests.push({ idx, x, z, g, lid, opened });
  }
}
function makeNPC(name, robe, x, z, faceAng) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.45, 1.3, 8), new THREE.MeshLambertMaterial({ color: robe })); body.position.y = 0.65; g.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), new THREE.MeshLambertMaterial({ color: 0xe0b48a })); head.position.y = 1.5; g.add(head);
  const label = makeLabel(name); label.position.y = 2.25; g.add(label);
  const mark = makeLabel('!', '#ffd84a', 2.4); mark.position.y = 2.75; mark.visible = false; g.add(mark);
  g.position.set(x, heightAt(x, z), z); g.rotation.y = faceAng; scene.add(g); addCollider(x, z, 0.5);
  return { name, g, head, mark, x, z };
}
const elder = makeNPC('Elder Maren', 0x3b5ba8, 3.5, -4, 0.6);
const staff = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.9, 5), M.wood); staff.position.set(0.45, 0.95, 0.1); elder.g.add(staff);
const smith = makeNPC('Smith Tovik', 0x7a3b1e, -6, 3, 2.2);
const anvil = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.6, 0.4), M.stone); anvil.position.set(-6.2, VH + 0.3, 4.4); scene.add(anvil);

// ---------------------------------------------------------------- player gear
const sword = new THREE.Group();
{
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.17, 8), M.dark); handle.rotation.x = Math.PI / 2; handle.position.z = 0.03;
  const pommel = new THREE.Mesh(new THREE.SphereGeometry(0.03, 8, 6), M.gold); pommel.position.z = 0.12;
  const guard = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.03, 0.035), M.gold); guard.position.z = -0.06;
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.012, 0.82), new THREE.MeshLambertMaterial({ color: 0xd8dde6, emissive: 0x111111 })); blade.position.z = -0.48;
  const edge = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.016, 0.78), M.ember); edge.position.z = -0.47;
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.025, 0.08, 4), new THREE.MeshLambertMaterial({ color: 0xd8dde6 })); tip.rotation.x = -Math.PI / 2; tip.position.z = -0.93;
  sword.add(handle, pommel, guard, blade, edge, tip);
  sword.userData.edge = edge;
}
const HILT = new THREE.Vector3(0, 0, -0.1), TIP = new THREE.Vector3(0, 0, -0.95);
const shield = new THREE.Group();
{
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.03, 16), new THREE.MeshLambertMaterial({ color: 0x7a4a22 }));
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.015, 6, 20), M.gold); rim.rotation.x = Math.PI / 2;
  const boss = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6), M.gold); boss.position.y = 0.02;
  shield.add(disc, rim, boss); shield.rotation.z = Math.PI / 2; shield.position.set(-0.07, 0, 0.05);
}
function restSword() { sword.position.set(0.3, -0.32, -0.45); sword.rotation.set(0.7, 0.15, -0.25); }
camera.add(sword); restSword();

// camera-attached panels (VR toast / prompt / hurt flash)
const toastPanel = makePanel(0.9, 0.3, 900, 300); toastPanel.mesh.position.set(0, 0.12, -1.25); toastPanel.mesh.visible = false; camera.add(toastPanel.mesh);
const promptPanel = makePanel(0.7, 0.09, 700, 90); promptPanel.mesh.position.set(0, -0.32, -1.2); promptPanel.mesh.visible = false; camera.add(promptPanel.mesh);
const hurtFlash = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ color: 0xff0000, transparent: true, opacity: 0, depthTest: false, fog: false }));
hurtFlash.position.z = -0.12; hurtFlash.renderOrder = 1000; hurtFlash.visible = false; camera.add(hurtFlash);
const wrist = makePanel(0.17, 0.12, 510, 360); wrist.mesh.position.set(0.05, 0.02, 0.1); wrist.mesh.rotation.set(0, Math.PI / 2, 0);

// ---------------------------------------------------------------- XR controllers
const hands = { left: null, right: null };
let inVR = false;
for (let i = 0; i < 2; i++) {
  const grip = renderer.xr.getControllerGrip(i); dolly.add(grip);
  grip.addEventListener('connected', e => {
    const src = e.data; if (!src || !src.handedness || src.handedness === 'none') return;
    hands[src.handedness] = { grip, src, prev: [] };
    if (src.handedness === 'right') { grip.add(sword); sword.position.set(0, 0, 0); sword.rotation.set(-0.35, 0, 0); }
    else { grip.add(shield); grip.add(wrist.mesh); }
  });
  grip.addEventListener('disconnected', () => { for (const k of ['left', 'right']) if (hands[k] && hands[k].grip === grip) hands[k] = null; });
}
renderer.xr.addEventListener('sessionstart', () => {
  inVR = true; dolly.rotation.y = yaw; camera.rotation.set(0, 0, 0); startGame();
});
renderer.xr.addEventListener('sessionend', () => {
  inVR = false; yaw = dolly.rotation.y; dolly.rotation.y = 0; pitch = 0; camera.position.set(0, 1.6, 0);
  camera.add(sword); restSword(); shield.removeFromParent(); wrist.mesh.removeFromParent();
  hands.left = hands.right = null;
});
function pulse(hand, intensity, ms) { try { hands[hand]?.src.gamepad?.hapticActuators?.[0]?.pulse(intensity, ms); } catch (e) { } }
const btnEdge = (hand, i) => { const h = hands[hand]; const gp = h?.src.gamepad; if (!gp) return false; const now = !!gp.buttons[i]?.pressed; const was = !!h.prev[i]; h.prev[i] = now; return now && !was; };

// ---------------------------------------------------------------- player helpers
const _head = new THREE.Vector3();
function headPos() { camera.getWorldPosition(_head); return _head; }
function forward2D() { camera.getWorldDirection(_v1); _v1.y = 0; if (_v1.lengthSq() < 1e-6) _v1.set(0, 0, -1); return _v1.normalize(); }
function placePlayer(x, z) {
  const h = headPos(); dolly.position.x += x - h.x; dolly.position.z += z - h.z; dolly.position.y = Math.max(heightAt(x, z), -1.3);
}
function movePlayer(dx, dz) {
  const h = headPos(); let nx = h.x + dx, nz = h.z + dz;
  if (heightAt(nx, nz) < -1.4) return;
  const r = Math.hypot(nx, nz); if (r > PLAY_RADIUS) { nx *= PLAY_RADIUS / r; nz *= PLAY_RADIUS / r; }
  [nx, nz] = collide(nx, nz, 0.35);
  dolly.position.x += nx - h.x; dolly.position.z += nz - h.z;
}

// ---------------------------------------------------------------- UI: toast, prompt, wrist, desktop HUD
const $ = id => document.getElementById(id);
let toastT = 0;
function toast(msg, secs = 4) {
  toastT = secs; $('toast').textContent = msg; $('toast').style.opacity = 1;
  const { ctx, canvas } = toastPanel; ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'rgba(20,10,5,0.78)'; rr(ctx, 4, 4, canvas.width - 8, canvas.height - 8, 26); ctx.fill();
  ctx.strokeStyle = 'rgba(255,180,90,0.6)'; ctx.lineWidth = 4; ctx.stroke();
  ctx.fillStyle = '#ffe9c4'; ctx.font = '38px system-ui,sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const lines = wrap(ctx, msg, canvas.width - 70).slice(0, 5); const lh = 46;
  lines.forEach((l, i) => ctx.fillText(l, canvas.width / 2, canvas.height / 2 + (i - (lines.length - 1) / 2) * lh));
  toastPanel.refresh(); toastPanel.mesh.visible = inVR; toastPanel.mat.opacity = 1;
}
let promptText = '';
function setPrompt(text) {
  if (text === promptText) return; promptText = text;
  $('prompt').style.display = text && !inVR ? 'block' : 'none'; $('prompt').textContent = text ? '[E] ' + text : '';
  const { ctx, canvas } = promptPanel; ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (text) { ctx.fillStyle = 'rgba(0,0,0,0.6)'; rr(ctx, 0, 0, canvas.width, canvas.height, 20); ctx.fill(); ctx.fillStyle = '#fff'; ctx.font = 'bold 40px system-ui,sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('(A) ' + text, canvas.width / 2, canvas.height / 2); }
  promptPanel.refresh(); promptPanel.mesh.visible = !!text && inVR;
}
function questInfo() {
  const c = S.crystals.filter(Boolean).length;
  switch (S.stage) {
    case 0: return ['A Village in Shadow', 'Speak with Elder Maren by the campfire.'];
    case 1: return ['Cull the Gloom', `Defeat gloomlings in the wilds (${S.qKills}/5).`];
    case 2: return ['Cull the Gloom', 'Return to Elder Maren.'];
    case 3: return ['The Sun Crystals', `Follow the golden beams and find the Sun Crystals (${c}/3).`];
    case 4: return ['The Sun Crystals', 'Return to Elder Maren.'];
    case 5: return ['The Hollow King', 'Defeat the Hollow King at the Ashen Tower (purple beam, northeast).'];
    case 6: return ['The Hollow King', 'Return to Elder Maren.'];
    default: return ['Free Roam', 'Emberwild is saved. Explore, find chests, hunt the remaining Gloom.'];
  }
}
function objective() {
  if ([0, 2, 4, 6].includes(S.stage)) return { name: 'Elder Maren', x: elder.x, z: elder.z };
  if (S.stage === 3) { const h = headPos(); let best = null, bd = 1e9; for (const c of crystals) if (!S.crystals[c.i]) { const d = Math.hypot(c.x - h.x, c.z - h.z); if (d < bd) { bd = d; best = c; } } return best && { name: 'Sun Crystal', x: best.x, z: best.z }; }
  if (S.stage === 5) return { name: 'Ashen Tower', x: SITES.tower.x, z: SITES.tower.z };
  return null;
}
function objectiveDir() {
  const o = objective(); if (!o) return null; const h = headPos(), f = forward2D();
  const tx = o.x - h.x, tz = o.z - h.z, d = Math.hypot(tx, tz);
  return { name: o.name, dist: Math.round(d), ang: Math.atan2(f.x * tz - f.z * tx, f.x * tx + f.z * tz) };
}
function drawWrist() {
  const { ctx, canvas } = wrist, W = canvas.width, H = canvas.height; ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(14,10,24,0.88)'; rr(ctx, 0, 0, W, H, 30); ctx.fill(); ctx.strokeStyle = 'rgba(255,180,90,.6)'; ctx.lineWidth = 4; ctx.stroke();
  ctx.fillStyle = '#ffcf8a'; ctx.font = 'bold 30px system-ui'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.fillText(`Lv ${S.level}`, 22, 16); ctx.fillStyle = '#fff'; ctx.font = '26px system-ui'; ctx.fillText(`Gold ${S.gold}   Potions ${S.potions}`, 140, 20);
  ctx.fillStyle = '#300'; rr(ctx, 22, 60, W - 44, 30, 15); ctx.fill(); ctx.fillStyle = '#e53935'; rr(ctx, 22, 60, (W - 44) * clamp(S.hp / maxHp(), 0, 1), 30, 15); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.font = 'bold 22px system-ui'; ctx.textAlign = 'center'; ctx.fillText(`${Math.ceil(S.hp)} / ${maxHp()}`, W / 2, 63);
  ctx.fillStyle = '#332200'; rr(ctx, 22, 98, W - 44, 10, 5); ctx.fill(); ctx.fillStyle = '#ffd54f'; rr(ctx, 22, 98, (W - 44) * clamp(S.xp / xpNeed(), 0, 1), 10, 5); ctx.fill();
  const [title, desc] = questInfo(); ctx.textAlign = 'left'; ctx.fillStyle = '#ffcf8a'; ctx.font = 'bold 26px system-ui'; ctx.fillText(title, 22, 122);
  ctx.fillStyle = '#eee'; ctx.font = '23px system-ui'; wrap(ctx, desc, W - 44).slice(0, 3).forEach((l, i) => ctx.fillText(l, 22, 156 + i * 28));
  const od = objectiveDir();
  if (od) {
    ctx.save(); ctx.translate(60, 300); ctx.rotate(od.ang); ctx.fillStyle = '#ffd54f'; ctx.beginPath(); ctx.moveTo(0, -30); ctx.lineTo(20, 22); ctx.lineTo(0, 10); ctx.lineTo(-20, 22); ctx.closePath(); ctx.fill(); ctx.restore();
    ctx.fillStyle = '#fff'; ctx.font = '25px system-ui'; ctx.fillText(`${od.name}  ${od.dist} m`, 100, 287);
  }
  ctx.textAlign = 'right'; ctx.fillStyle = '#9fdcaa'; ctx.font = '19px system-ui'; ctx.fillText(`${Math.round(fpsNow)} fps`, W - 20, 332);
  wrist.refresh();
}
function updateHUD() {
  $('hpFill').style.width = clamp(S.hp / maxHp(), 0, 1) * 100 + '%'; $('hpText').textContent = `${Math.ceil(S.hp)} / ${maxHp()}`;
  $('xpFill').style.width = clamp(S.xp / xpNeed(), 0, 1) * 100 + '%';
  $('stats').innerHTML = `Level ${S.level} &nbsp; Gold ${S.gold} &nbsp; Potions ${S.potions} &nbsp; Sword +${S.swordLv}${S.blessed ? ' (blessed)' : ''} &nbsp; ${isNight() ? 'Night' : 'Day'}`;
  const [title, desc] = questInfo(); const od = objectiveDir();
  $('questBox').innerHTML = `<b>${title}</b><br>${desc}` + (od ? `<br><span id="arrow" style="transform:rotate(${od.ang}rad)"></span>${od.name} &mdash; ${od.dist} m` : '');
}

// ---------------------------------------------------------------- progression
function gainXP(n) {
  S.xp += n;
  while (S.xp >= xpNeed()) { S.xp -= xpNeed(); S.level++; S.hp = maxHp(); sfx.level(); toast(`Level up! You are now level ${S.level}. Health and strength increased.`, 4); burst(headPos().clone().add(_v2.set(0, -0.5, 0)), 0xffd54f, 40, 3, 3); save(); }
}
function swordDamage() { return 10 + S.swordLv * 6 + (S.level - 1) * 3 + (S.blessed ? 8 : 0); }
let lastHurt = -99, time = 0;
function damagePlayer(d) {
  S.hp -= d; lastHurt = time; sfx.hurt(); pulse('left', 0.6, 120); pulse('right', 0.6, 120);
  $('hurt').style.opacity = 1; setTimeout(() => $('hurt').style.opacity = 0, 180); hurtFlash.material.opacity = 0.35; hurtFlash.visible = inVR;
  if (S.hp <= 0) {
    const lost = Math.floor(S.gold * 0.25); S.gold -= lost; S.hp = maxHp();
    for (const e of enemies) if (!e.T.boss) e.remove = true; else { e.hp = e.maxHp; }
    placePlayer(0, 9); toast(`You were overwhelmed... You wake by the village fire. (Lost ${lost} gold)`, 5); save();
  }
}
function drinkPotion() {
  if (S.potions <= 0) { toast('No potions left. Buy... or find them on fallen foes and in chests.', 2.5); return; }
  if (S.hp >= maxHp()) { toast('You are already at full health.', 2); return; }
  S.potions--; S.hp = Math.min(maxHp(), S.hp + 55); sfx.drink(); burst(headPos().clone().add(_v2.set(0, -0.6, 0)), 0xff5577, 20, 1.5, 1.5);
}

// ---------------------------------------------------------------- enemies
const ENEMY_TYPES = {
  gloom: { name: 'Gloomling', hp: 30, dmg: 7, speed: 2.3, xp: 14, gold: [2, 6], color: 0x4b2a6b, scale: 1 },
  thorn: { name: 'Thornback', hp: 80, dmg: 13, speed: 1.9, xp: 32, gold: [6, 14], color: 0x56502a, scale: 1.55 },
  king: { name: 'Hollow King', hp: 520, dmg: 22, speed: 2.7, xp: 300, gold: [150, 150], color: 0x1c1028, scale: 2.8, boss: true },
};
const geoBlob = new THREE.IcosahedronGeometry(0.42, 1), geoEye = new THREE.SphereGeometry(0.07, 6, 4), geoSpike = new THREE.ConeGeometry(0.09, 0.32, 5);
const LIMB = 0.42;
const geoLimb = new THREE.CylinderGeometry(0.075, 0.06, LIMB, 6); geoLimb.translate(0, -LIMB / 2, 0);
const geoNub = new THREE.SphereGeometry(0.1, 6, 4);
const matEye = new THREE.MeshBasicMaterial({ color: 0xffd23a }), matEyeBoss = new THREE.MeshBasicMaterial({ color: 0xff3020 });
const barGeo = new THREE.PlaneGeometry(1, 0.09); barGeo.translate(0.5, 0, 0);
const barBg = new THREE.MeshBasicMaterial({ color: 0x220000, fog: false }), barFg = new THREE.MeshBasicMaterial({ color: 0xff4040, fog: false });
const enemies = [];
function makeLimb(mat, x, y, parent) {
  const pivot = new THREE.Group(); pivot.position.set(x, y, 0);
  pivot.add(new THREE.Mesh(geoLimb, mat));
  const nub = new THREE.Mesh(geoNub, mat); nub.position.y = -LIMB; pivot.add(nub);
  parent.add(pivot); return pivot;
}
function spawnEnemy(key, x, z) {
  const T = ENEMY_TYPES[key], g = new THREE.Group();
  const mat = new THREE.MeshLambertMaterial({ color: T.color, flatShading: true, emissive: 0x000000 });
  const upper = new THREE.Group(); upper.position.y = 0.44; g.add(upper); // pivots at the hips (for flinching)
  const body = new THREE.Mesh(geoBlob, mat); body.position.y = 0.34; upper.add(body);
  for (const sx of [-1, 1]) { const e = new THREE.Mesh(geoEye, T.boss ? matEyeBoss : matEye); e.position.set(sx * 0.15, 0.1, 0.36); body.add(e); }
  if (key !== 'gloom') for (let i = 0; i < (T.boss ? 7 : 5); i++) { const s = new THREE.Mesh(geoSpike, T.boss ? M.gold : M.wood); const a = i / (T.boss ? 7 : 5) * 6.28; s.position.set(Math.cos(a) * 0.2, 0.36, Math.sin(a) * 0.2); s.rotation.set(Math.sin(a) * 0.4, 0, -Math.cos(a) * 0.4); body.add(s); }
  const arms = [makeLimb(mat, -0.38, 0.44, upper), makeLimb(mat, 0.38, 0.44, upper)];
  const legs = [makeLimb(mat, -0.17, 0.44, g), makeLimb(mat, 0.17, 0.44, g)];
  arms[0].rotation.z = -0.25; arms[1].rotation.z = 0.25;
  const bar = new THREE.Group(), bg = new THREE.Mesh(barGeo, barBg), fg = new THREE.Mesh(barGeo, barFg);
  bg.position.x = -0.5; fg.position.set(-0.5, 0, 0.002); bar.add(bg, fg); bar.position.y = 1.45; bar.visible = false; g.add(bar);
  g.scale.setScalar(T.scale);
  const lv = 1 + 0.14 * (S.level - 1), nightMul = isNight() ? 1.2 : 1;
  const e = { key, T, g, upper, body, arms, legs, mat, bar, fg, hp: T.hp * lv * nightMul, maxHp: T.hp * lv * nightMul, dmg: T.dmg * lv, x, z, vx: 0, vz: 0, atkCd: 1.2, hitCd: 0, flash: 0, lunge: 0, walk: Math.random() * 6, tilt: 0, tiltV: 0, phase: Math.random() * 6, wAng: Math.random() * 6.28, wT: 0, aggro: false, dead: false, rad: 0.45 * T.scale };
  g.position.set(x, heightAt(x, z), z); scene.add(g); enemies.push(e); return e;
}
function enemyCenter(e, out) { return out.set(e.x, e.g.position.y + 0.78 * e.T.scale, e.z); }
// impulse: world-space velocity (m/s) of the blow, used for knockback, flinch and the death ragdoll
function hitEnemy(e, mult, fromX, fromZ, impulse) {
  if (e.dead || e.hitCd > 0) return false;
  let dmg = swordDamage() * mult; const crit = Math.random() < 0.12; if (crit) dmg *= 1.8;
  e.hp -= dmg; e.hitCd = 0.32; e.flash = 0.15; e.aggro = true;
  const dx = e.x - fromX, dz = e.z - fromZ, d = Math.hypot(dx, dz) || 1;
  const imp = impulse ? impulse.clone() : new THREE.Vector3(dx / d * 6 * mult, 1, dz / d * 6 * mult);
  const kb = (e.T.boss ? 1.5 : 4) * mult; e.vx += dx / d * kb; e.vz += dz / d * kb;
  e.tiltV -= (e.T.boss ? 3 : 9) * mult * (crit ? 1.5 : 1);
  const c = enemyCenter(e, new THREE.Vector3()); burst(c, crit ? 0xffffff : 0xff9a2a, crit ? 26 : 14, 4, 1.5);
  sfx.hit(); pulse('right', crit ? 1 : 0.7, crit ? 90 : 50);
  if (e.hp <= 0) killEnemy(e, imp.multiplyScalar(crit ? 1.4 : 1));
  return true;
}
function killEnemy(e, imp) {
  if (e.dead) return;
  e.dead = true; e.bar.visible = false; sfx.kill();
  const c = enemyCenter(e, new THREE.Vector3()); burst(c, 0x9b59ff, e.T.boss ? 120 : 24, e.T.boss ? 8 : 3, 2);
  makeRagdoll(e, imp || new THREE.Vector3()); e.ragdolled = true; e.remove = true;
  const g = Math.round(lerp(e.T.gold[0], e.T.gold[1], Math.random())); S.gold += g; sfx.coin();
  gainXP(Math.round(e.T.xp * (1 + 0.1 * (S.level - 1))));
  if (Math.random() < (e.T.boss ? 1 : e.key === 'thorn' ? 0.35 : 0.18)) spawnPickup('potion', e.x, e.z);
  if (S.stage === 1 && !e.T.boss) { S.qKills++; if (S.qKills >= 5) { S.stage = 2; sfx.quest(); toast('Quest updated: The gloomlings scatter! Return to Elder Maren.', 4); save(); } }
  if (e.T.boss && S.stage === 5) { S.stage = 6; sfx.quest(); toast('The Hollow King is no more! The Gloom recedes... Return to Elder Maren.', 6); save(); }
}

// ---------------------------------------------------------------- ragdolls (Verlet points + distance constraints)
// Points: 0 T (top of torso), 1 B (bottom), 2 F (front), 3/4 shoulders, 5/6 hips, 7/8 hands, 9/10 feet.
// Points 0-6 are tied together rigidly (the torso); arms and legs hang from them on single links.
const ragdolls = []; const RAG_MAX = 8, RAG_LIFE = 7, RAG_STEP = 1 / 60;
const _rx = new THREE.Vector3(), _ry = new THREE.Vector3(), _rz = new THREE.Vector3(), _rm = new THREE.Matrix4(), DOWN = new THREE.Vector3(0, -1, 0);
function makeRagdoll(e, imp) {
  e.g.updateMatrixWorld(true);
  const s = e.T.scale, P = [];
  const add = (v, r) => P.push({ p: v, o: v.clone(), r: r * s, gy: 0 });
  add(e.body.localToWorld(new THREE.Vector3(0, 0.3, 0)), 0.14);
  add(e.body.localToWorld(new THREE.Vector3(0, -0.3, 0)), 0.14);
  add(e.body.localToWorld(new THREE.Vector3(0, 0, 0.3)), 0.14);
  for (const a of e.arms) add(a.getWorldPosition(new THREE.Vector3()), 0.08);
  for (const l of e.legs) add(l.getWorldPosition(new THREE.Vector3()), 0.08);
  for (const a of e.arms) add(a.localToWorld(new THREE.Vector3(0, -LIMB, 0)), 0.1);
  for (const l of e.legs) add(l.localToWorld(new THREE.Vector3(0, -LIMB, 0)), 0.1);
  const C = [], link = (a, b, k = 1) => C.push([a, b, P[a].p.distanceTo(P[b].p) * k]);
  for (let a = 0; a < 7; a++) for (let b = a + 1; b < 7; b++) link(a, b);
  link(3, 7); link(4, 8); link(5, 9); link(6, 10);
  const soft = []; // minimum distances so limbs can't fold through the torso
  for (const [a, b] of [[7, 1], [8, 1], [7, 2], [8, 2], [9, 0], [10, 0], [9, 10], [7, 8]]) soft.push([a, b, P[a].p.distanceTo(P[b].p) * 0.55]);
  const k = e.T.boss ? 0.35 : 1;
  for (const pt of P) {
    _rx.copy(imp).multiplyScalar(0.6 * k); _rx.x += (Math.random() - 0.5) * 0.8; _rx.y += 1.8 * k + Math.random() * 0.6; _rx.z += (Math.random() - 0.5) * 0.8;
    pt.o.addScaledVector(_rx, -RAG_STEP);
  }
  P[0].o.addScaledVector(imp, -RAG_STEP * 0.6 * k); // the top gets extra so the body tumbles
  const limbs = [...e.arms, ...e.legs];
  for (const m of [e.body, ...limbs]) { m.removeFromParent(); m.scale.setScalar(s); scene.add(m); }
  e.mat.emissive.setScalar(0);
  const rd = { P, C, soft, body: e.body, limbs, limbIdx: [[3, 7], [4, 8], [5, 9], [6, 10]], mat: e.mat, life: 0, acc: 0, s, pushCd: 0 };
  ragdolls.push(rd);
  while (ragdolls.length > RAG_MAX) removeRagdoll(ragdolls[0]);
  poseRagdoll(rd);
  return rd;
}
function removeRagdoll(rd) { scene.remove(rd.body, ...rd.limbs); rd.mat.dispose(); const i = ragdolls.indexOf(rd); if (i >= 0) ragdolls.splice(i, 1); }
function satisfy(a, b, rest, minOnly) {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (d < 1e-6 || (minOnly && d >= rest)) return;
  const f = (d - rest) / d * 0.5;
  a.x += dx * f; a.y += dy * f; a.z += dz * f; b.x -= dx * f; b.y -= dy * f; b.z -= dz * f;
}
function stepRagdoll(rd, h) {
  const g = -9.8 * h * h;
  for (const pt of rd.P) {
    const vx = (pt.p.x - pt.o.x) * 0.996, vy = (pt.p.y - pt.o.y) * 0.996, vz = (pt.p.z - pt.o.z) * 0.996;
    pt.o.copy(pt.p); pt.p.x += vx; pt.p.y += vy + g; pt.p.z += vz;
    pt.gy = heightAt(pt.p.x, pt.p.z) + pt.r;
  }
  for (let it = 0; it < 6; it++) {
    for (const c of rd.C) satisfy(rd.P[c[0]].p, rd.P[c[1]].p, c[2], false);
    for (const c of rd.soft) satisfy(rd.P[c[0]].p, rd.P[c[1]].p, c[2], true);
    for (const pt of rd.P) if (pt.p.y < pt.gy) pt.p.y = pt.gy;
  }
  for (const pt of rd.P) if (pt.p.y <= pt.gy + 0.002) { // ground friction
    pt.o.x = lerp(pt.o.x, pt.p.x, 0.25); pt.o.z = lerp(pt.o.z, pt.p.z, 0.25); if (pt.o.y < pt.p.y) pt.o.y = lerp(pt.o.y, pt.p.y, 0.6);
  }
}
function poseRagdoll(rd) {
  const P = rd.P, T = P[0].p, B = P[1].p, F = P[2].p;
  rd.body.position.addVectors(T, B).multiplyScalar(0.5);
  _ry.subVectors(T, B).normalize();
  _rz.subVectors(F, rd.body.position); _rz.addScaledVector(_ry, -_rz.dot(_ry)).normalize();
  _rx.crossVectors(_ry, _rz);
  _rm.makeBasis(_rx, _ry, _rz); rd.body.quaternion.setFromRotationMatrix(_rm);
  rd.limbs.forEach((l, i) => { const [a, b] = rd.limbIdx[i]; l.position.copy(P[a].p); _rx.subVectors(P[b].p, P[a].p).normalize(); l.quaternion.setFromUnitVectors(DOWN, _rx); });
}
function nudgeRagdoll(rd, vel, scale) { for (const pt of rd.P) pt.o.addScaledVector(vel, -RAG_STEP * scale); rd.life = Math.min(rd.life, RAG_LIFE - 2); }
// sword segment a-b moving with world velocity vel pushes any limb it touches
function pushRagdollsWithBlade(a, b, vel) {
  const sp = vel.length(); if (sp < 1) return;
  for (const rd of ragdolls) {
    if (rd.pushCd > 0) continue; let touched = false;
    for (const pt of rd.P) if (distPointSeg(pt.p, a, b) < pt.r + 0.08) { pt.o.addScaledVector(vel, -RAG_STEP * 0.9); touched = true; }
    if (touched) { rd.pushCd = 0.08; nudgeRagdoll(rd, vel, 0.25); pulse('right', 0.3, 25); if (sp > 3) tone(110, 0.08, 'triangle', 0.08); }
  }
}
function updateRagdolls(dt) {
  for (let i = ragdolls.length - 1; i >= 0; i--) {
    const rd = ragdolls[i]; rd.life += dt; rd.pushCd -= dt;
    if (rd.life > RAG_LIFE) { removeRagdoll(rd); continue; }
    if (rd.life > RAG_LIFE - 1.2) { for (const pt of rd.P) pt.p.y -= dt * 0.7 * rd.s; } // sink into the ground
    else { rd.acc += dt; let n = 0; while (rd.acc >= RAG_STEP && n < 3) { stepRagdoll(rd, RAG_STEP); rd.acc -= RAG_STEP; n++; } if (n === 3) rd.acc = 0; }
    poseRagdoll(rd);
  }
}

let spawnT = 0;
function updateSpawns(dt) {
  spawnT -= dt; if (spawnT > 0) return; spawnT = 1.0;
  const night = isNight(), h = headPos();
  const cap = S.stage >= 7 ? (night ? 12 : 7) : (night ? 22 : 13);
  if (enemies.filter(e => !e.dead && !e.T.boss).length < cap) for (let t = 0; t < 8; t++) {
    const a = Math.random() * 6.283, d = 36 + Math.random() * 40, x = h.x + Math.cos(a) * d, z = h.z + Math.sin(a) * d;
    if (Math.hypot(x, z) > PLAY_RADIUS - 5 || Math.hypot(x, z) < 50 || heightAt(x, z) < 0.8) continue;
    spawnEnemy(Math.hypot(x, z) > 105 && Math.random() < (night ? 0.5 : 0.3) ? 'thorn' : 'gloom', x, z); break;
  }
  // boss
  if (S.stage === 5 && !enemies.some(e => e.T.boss && !e.dead) && Math.hypot(h.x - SITES.tower.x, h.z - SITES.tower.z) < 48) {
    const T = SITES.tower, a = Math.atan2(-T.x, -T.z); const b = spawnEnemy('king', T.x + Math.sin(a) * 9, T.z + Math.cos(a) * 9); b.aggro = true;
    toast('The Hollow King awakens!', 4); tone(80, 1.5, 'sawtooth', 0.2, -30);
  }
}
const _ec = new THREE.Vector3();
function updateEnemies(dt) {
  const h = headPos(); const sh = hands.left ? shield.getWorldPosition(_v2) : null;
  for (let i = enemies.length - 1; i >= 0; i--) {
    const e = enemies[i];
    if (e.remove) { scene.remove(e.g); if (!e.ragdolled) e.mat.dispose(); enemies.splice(i, 1); continue; }
    if (e.dead) continue;
    const dx = h.x - e.x, dz = h.z - e.z, dist = Math.hypot(dx, dz);
    if (dist > 130 && !e.T.boss) { e.remove = true; continue; }
    e.hitCd -= dt; e.atkCd -= dt;
    const range = isNight() ? 24 : 17;
    if (dist < range) e.aggro = true; else if (dist > range * 1.8 && !e.T.boss) e.aggro = false;
    if (e.T.boss && dist > 80) { e.hp = e.maxHp; e.bar.visible = false; }
    let mx = 0, mz = 0; const reach = e.rad + 0.75;
    if (e.aggro) {
      if (dist > reach) { mx = dx / dist * e.T.speed; mz = dz / dist * e.T.speed; }
      else if (e.atkCd <= 0) {
        e.atkCd = e.T.boss ? 1.6 : 1.35; e.lunge = 0.3;
        let d = e.dmg; enemyCenter(e, _ec);
        if (sh && sh.distanceTo(_ec) < e.rad + 0.55) { d *= 0.2; sfx.block(); pulse('left', 1, 80); burst(sh, 0xffffff, 10, 2, 1); e.tiltV -= 6; }
        damagePlayer(d);
      }
      e.g.rotation.y = Math.atan2(dx, dz);
    } else {
      e.wT -= dt; if (e.wT <= 0) { e.wT = 2 + Math.random() * 3; e.wAng = Math.random() * 6.28; }
      mx = Math.sin(e.wAng) * e.T.speed * 0.3; mz = Math.cos(e.wAng) * e.T.speed * 0.3; e.g.rotation.y = e.wAng;
    }
    e.vx *= Math.exp(-dt * 6); e.vz *= Math.exp(-dt * 6);
    const nx = e.x + (mx + e.vx) * dt, nz = e.z + (mz + e.vz) * dt;
    if (heightAt(nx, nz) > 0 && Math.hypot(nx, nz) > 30) { e.x = nx; e.z = nz; } else if (Math.hypot(nx, nz) <= 30) e.aggro = false;
    e.g.position.set(e.x, heightAt(e.x, e.z), e.z);
    // walk cycle, attack swing, and a springy flinch when hit
    const moving = Math.hypot(mx, mz) / e.T.scale; e.walk += dt * (2 + moving * 3.5);
    const sw = Math.sin(e.walk) * Math.min(1, moving / 1.2) * 0.7;
    e.lunge = Math.max(0, e.lunge - dt); const lf = Math.sin(e.lunge / 0.3 * Math.PI);
    e.legs[0].rotation.x = sw; e.legs[1].rotation.x = -sw;
    e.arms[0].rotation.x = -sw * 0.8 - lf * 2.2; e.arms[1].rotation.x = sw * 0.8 - lf * 2.2;
    e.tiltV += (-70 * e.tilt - 9 * e.tiltV) * dt; e.tilt += e.tiltV * dt;
    e.upper.rotation.x = e.tilt + lf * 0.35;
    e.body.scale.set(1, 1 + Math.sin(time * 8 + e.phase) * 0.06, 1);
    e.flash = Math.max(0, e.flash - dt); e.mat.emissive.setScalar(e.flash > 0 ? 0.8 : 0);
    if (e.hp < e.maxHp) { e.bar.visible = true; e.fg.scale.x = Math.max(0.001, e.hp / e.maxHp); e.bar.lookAt(h); }
  }
}

// ---------------------------------------------------------------- pickups
const pickups = [];
const potionGeo = new THREE.SphereGeometry(0.16, 10, 8), potionMat = new THREE.MeshBasicMaterial({ color: 0xff3355 });
function spawnPickup(type, x, z) { const m = new THREE.Mesh(potionGeo, potionMat); const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.14, 6), M.lamp); neck.position.y = 0.18; m.add(neck); m.position.set(x, heightAt(x, z) + 0.6, z); scene.add(m); pickups.push({ type, m, x, z, t: 0 }); }
function updatePickups(dt) {
  const h = headPos();
  for (let i = pickups.length - 1; i >= 0; i--) {
    const p = pickups[i]; p.t += dt; p.m.position.y = heightAt(p.x, p.z) + 0.6 + Math.sin(p.t * 3) * 0.12; p.m.rotation.y += dt * 2;
    if (Math.hypot(h.x - p.x, h.z - p.z) < 1.6) { S.potions++; sfx.pickup(); toast('Picked up a healing potion.', 2); scene.remove(p.m); pickups.splice(i, 1); }
    else if (p.t > 120) { scene.remove(p.m); pickups.splice(i, 1); }
  }
  for (const c of crystals) {
    const active = S.stage === 3 && !S.crystals[c.i]; c.beam.visible = active; c.gem.visible = !S.crystals[c.i];
    c.gem.rotation.y += dt; c.gem.position.y = 1.6 + Math.sin(time * 2 + c.i) * 0.15;
    if (active && Math.hypot(h.x - c.x, h.z - c.z) < 3.2) {
      S.crystals[c.i] = true; const n = S.crystals.filter(Boolean).length; sfx.quest(); burst(c.gem.getWorldPosition(new THREE.Vector3()), 0xffd84a, 50, 4, 3);
      gainXP(40);
      if (n >= 3) { S.stage = 4; toast('All three Sun Crystals recovered! Return to Elder Maren.', 5); } else toast(`Sun Crystal recovered (${n}/3).`, 3);
      save();
    }
  }
  towerBeam.visible = S.stage === 5;
  elder.mark.visible = [0, 2, 4, 6].includes(S.stage); elder.mark.position.y = 2.75 + Math.sin(time * 3) * 0.08;
}

// ---------------------------------------------------------------- interaction & dialogue
const ELDER_LINES = {
  0: () => { S.stage = 1; S.qKills = 0; sfx.quest(); return 'Elder Maren: "Traveler, thank the embers you came. Gloomlings creep out of the woods each night. Thin their numbers - defeat 5 of them beyond the village."'; },
  1: () => `Elder Maren: "Still ${5 - S.qKills} gloomling${5 - S.qKills === 1 ? '' : 's'} to go. They lurk out past the lantern posts."`,
  2: () => { S.stage = 3; S.gold += 60; S.potions += 2; gainXP(80); sfx.quest(); return 'Elder Maren: "You fight like the old ember-wardens! Take 60 gold and 2 potions. Three Sun Crystals once shielded this valley. Follow the golden beams and bring back their light."'; },
  3: () => `Elder Maren: "${3 - S.crystals.filter(Boolean).length} Sun Crystal(s) still out there. Look for the golden pillars of light."`,
  4: () => { S.stage = 5; S.blessed = true; gainXP(120); sfx.quest(); return 'Elder Maren: "The crystals sing! I bless your blade with their light (+8 damage). The source of the Gloom is the Hollow King, in the Ashen Tower to the northeast. End him."'; },
  5: () => 'Elder Maren: "The Hollow King waits beneath the purple beam. Rest by the fire to heal, then go."',
  6: () => { S.stage = 7; S.gold += 300; gainXP(300); sfx.level(); return 'Elder Maren: "The Gloom lifts! Emberwild is free, warden. Take 300 gold - and know that this valley is yours to roam."'; },
  7: () => 'Elder Maren: "The nights are quieter now. A few gloomlings still stray - stay sharp, warden."',
};
function interactables() {
  const list = [
    { x: elder.x, z: elder.z, r: 3.2, label: 'Talk to Elder Maren', act: () => { toast(ELDER_LINES[S.stage](), 9); save(); } },
    { x: smith.x, z: smith.z, r: 3.2, label: 'Talk to Smith Tovik', act: smithTalk },
  ];
  for (const c of chests) if (!c.opened) list.push({ x: c.x, z: c.z, r: 2.4, label: 'Open chest', act: () => openChest(c) });
  return list;
}
function smithTalk() {
  if (S.swordLv >= 5) { toast('Smith Tovik: "That blade is as fine as I can forge it. Go cut some Gloom!"', 4); return; }
  const cost = 40 * (S.swordLv + 1);
  if (S.gold >= cost) { S.gold -= cost; S.swordLv++; sfx.level(); burst(anvil.position.clone().add(_v2.set(0, 0.6, 0)), 0xff9a2a, 30, 3, 2); toast(`Smith Tovik: "There - sharper than ever!" Sword upgraded to +${S.swordLv} (${swordDamage()} damage).`, 5); save(); }
  else toast(`Smith Tovik: "I can sharpen that blade to +${S.swordLv + 1} for ${cost} gold." (You have ${S.gold}.)`, 4.5);
}
function openChest(c) {
  c.opened = true; S.chests.push(c.idx); const g = 15 + Math.floor(Math.random() * 30); S.gold += g;
  const pot = Math.random() < 0.6; if (pot) S.potions++;
  sfx.coin(); sfx.pickup(); burst(c.g.position.clone().add(_v2.set(0, 0.8, 0)), 0xffd54f, 30, 2.5, 2.5);
  toast(`Chest: ${g} gold${pot ? ' and a healing potion' : ''}!  (${S.chests.length}/${chests.length} chests found)`, 3.5); save();
}

// ---------------------------------------------------------------- input
function lockPointer() { try { const p = renderer.domElement.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch (e) { } }
const keys = {}; let interactQueued = false, potionQueued = false, locked = false, running = false;
addEventListener('keydown', e => { keys[e.code] = true; if (!running) return; if (e.code === 'KeyE') interactQueued = true; if (e.code === 'KeyQ') potionQueued = true; });
addEventListener('keyup', e => { keys[e.code] = false; });
document.addEventListener('pointerlockchange', () => { locked = document.pointerLockElement === renderer.domElement; });
renderer.domElement.addEventListener('mousedown', e => { if (!running || inVR) return; if (!locked) lockPointer(); if (e.button === 0) startSwing(); });
addEventListener('mousemove', e => { if (!locked || inVR) return; yaw -= e.movementX * 0.0022; pitch = clamp(pitch - e.movementY * 0.0022, -1.4, 1.4); });

let swingT = 0, swingHit = false; const SWING = 0.36;
function startSwing() { if (swingT > 0) return; swingT = SWING; swingHit = false; sfx.swing(); }
function updateDesktopSword(dt) {
  if (inVR) return;
  if (swingT > 0) {
    swingT -= dt; const p = 1 - Math.max(0, swingT) / SWING, s = Math.sin(p * Math.PI), e = p * p * (3 - 2 * p);
    sword.position.set(lerp(0.38, -0.12, e), -0.3 + s * 0.08, -0.5 - s * 0.15);
    sword.rotation.set(0.7 - s * 0.9, lerp(-0.9, 1.0, e), lerp(-0.9, 0.6, e));
    if (!swingHit && p > 0.35) {
      swingHit = true; const h = headPos(), f = forward2D();
      const imp = new THREE.Vector3(f.x * 6 + f.z * 2.5, 1.5, f.z * 6 - f.x * 2.5); // forward + right-to-left sweep
      for (const en of enemies) { if (en.dead) continue; const dx = en.x - h.x, dz = en.z - h.z, d = Math.hypot(dx, dz); if (d < 2.9 + en.rad && (dx * f.x + dz * f.z) / (d || 1) > 0.4) hitEnemy(en, 1, h.x, h.z, imp); }
      for (const rd of [...ragdolls]) { const c = rd.P[0].p, dx = c.x - h.x, dz = c.z - h.z, d = Math.hypot(dx, dz); if (d < 3 && (dx * f.x + dz * f.z) / (d || 1) > 0.3) nudgeRagdoll(rd, imp, 0.8); }
    }
    if (swingT <= 0) restSword();
  }
}
const prevTip = new THREE.Vector3(); let havePrev = false, tipSpeed = 0, whooshCd = 0;
function updateVRSword(dt) {
  if (!inVR || !hands.right) { havePrev = false; return; }
  sword.updateWorldMatrix(true, false);
  const tipW = sword.localToWorld(_v1.copy(TIP)).clone(), hiltW = sword.localToWorld(_v2.copy(HILT)).clone();
  const tipL = dolly.worldToLocal(tipW.clone());
  const velW = new THREE.Vector3(); if (havePrev) velW.subVectors(tipL, prevTip).divideScalar(Math.max(dt, 1e-3)).applyQuaternion(dolly.quaternion);
  const sp = velW.length(); prevTip.copy(tipL); havePrev = true;
  pushRagdollsWithBlade(hiltW, tipW, velW);
  tipSpeed = lerp(tipSpeed, sp, 0.5); whooshCd -= dt;
  if (tipSpeed > 4 && whooshCd <= 0) { sfx.swing(); whooshCd = 0.4; }
  sword.userData.edge.material.color.setHex(tipSpeed > 1.8 ? 0xffd27a : 0xff7a1a);
  if (tipSpeed < 1.8) return;
  const h = headPos(), mult = clamp(tipSpeed / 4.5, 0.6, 1.6);
  for (const e of enemies) { if (e.dead || e.hitCd > 0) continue; if (distPointSeg(enemyCenter(e, _ec), hiltW, tipW) < e.rad + 0.1) hitEnemy(e, mult, h.x, h.z, velW.clone().clampLength(0, 12)); }
}
let snapReady = true;
function updateMovement(dt) {
  let mx = 0, mz = 0, run = false, turn = 0;
  if (inVR) {
    const L = hands.left?.src.gamepad, R = hands.right?.src.gamepad;
    if (L) { const ax = L.axes.length >= 4 ? 2 : 0; mx = L.axes[ax] || 0; mz = L.axes[ax + 1] || 0; run = !!L.buttons[1]?.pressed; }
    if (R) { const ax = R.axes.length >= 4 ? 2 : 0; turn = R.axes[ax] || 0; }
    if (btnEdge('right', 4)) interactQueued = true;
    if (btnEdge('right', 5) || btnEdge('left', 4)) potionQueued = true;
    if (Math.abs(turn) > 0.7 && snapReady) {
      snapReady = false; const ang = -Math.sign(turn) * Math.PI / 6, h = headPos().clone();
      _v2.subVectors(dolly.position, h).applyAxisAngle(THREE.Object3D.DEFAULT_UP, ang); dolly.position.copy(h).add(_v2); dolly.rotation.y += ang;
    } else if (Math.abs(turn) < 0.3) snapReady = true;
  } else {
    camera.rotation.set(pitch, yaw, 0);
    mx = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0); mz = (keys.KeyS ? 1 : 0) - (keys.KeyW ? 1 : 0); run = keys.ShiftLeft || keys.ShiftRight;
  }
  const mag = Math.hypot(mx, mz);
  if (mag > 0.15) {
    const f = forward2D(), speed = (run ? 7.5 : 4.2) * Math.min(1, mag) / mag;
    const rx = -f.z, rz = f.x; // right vector
    movePlayer((f.x * -mz + rx * mx) * speed * dt, (f.z * -mz + rz * mx) * speed * dt);
  }
  const h = headPos(); const target = Math.max(heightAt(h.x, h.z), -1.3);
  dolly.position.y = lerp(dolly.position.y, target, 1 - Math.exp(-dt * 12));
}

// ---------------------------------------------------------------- game flow
function startGame() {
  ac(); $('intro').style.display = 'none'; $('hud').style.display = inVR ? 'none' : 'block';
  if (!running) {
    running = true; placePlayer(S.x, S.z);
    toast(S.stage === 0 ? 'Welcome to Emberwild. Elder Maren waits by the campfire - go speak with her.' : 'Welcome back, warden. ' + questInfo()[1], 6);
  } else toast(questInfo()[1], 4);
}
$('play').onclick = () => { startGame(); lockPointer(); };
$('reset').onclick = () => { if (confirm('Erase your saved progress and start over?')) { try { localStorage.removeItem(SAVE_KEY); } catch (e) { } location.reload(); } };
document.addEventListener('pointerlockchange', () => { if (!locked && running && !inVR) { /* paused look; click to resume */ } });
// ---------------------------------------------------------------- VR entry (native resolution + refresh rate)
let fpsNow = 0, actualScale = 0;
async function enterVR() {
  try {
    const session = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking', 'layers'] });
    const mode = RES_MODES[GFX.res] || RES_MODES.native;
    const native = (window.XRWebGLLayer && XRWebGLLayer.getNativeFramebufferScaleFactor) ? XRWebGLLayer.getNativeFramebufferScaleFactor(session) : 1;
    actualScale = native * mode.mul;
    renderer.xr.setFramebufferScaleFactor(actualScale);
    renderer.xr.setFoveation(mode.fov);
    session.addEventListener('end', () => { vrBtn.textContent = 'ENTER VR'; });
    await renderer.xr.setSession(session);
    if (session.updateTargetFrameRate && session.supportedFrameRates) {
      const rates = [...session.supportedFrameRates]; const want = rates.includes(GFX.hz) ? GFX.hz : Math.max(...rates.filter(r => r <= GFX.hz), ...rates.slice(0, 1));
      session.updateTargetFrameRate(want).catch(() => { });
    }
    vrBtn.textContent = 'EXIT VR';
  } catch (e) { toast('Could not start VR: ' + e.message, 5); }
}
const vrBtn = document.createElement('button'); vrBtn.id = 'VRButton'; vrBtn.textContent = 'VR NOT SUPPORTED'; vrBtn.disabled = true;
vrBtn.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:20;padding:12px 22px;font:bold 15px system-ui;border-radius:6px;border:1px solid #fff;background:rgba(0,0,0,.4);color:#fff;cursor:pointer';
document.body.appendChild(vrBtn);
if (navigator.xr) navigator.xr.isSessionSupported('immersive-vr').then(ok => { if (ok) { vrBtn.disabled = false; vrBtn.textContent = 'ENTER VR'; } }).catch(() => { });
vrBtn.onclick = () => { const s = renderer.xr.getSession(); if (s) s.end(); else enterVR(); };
// settings selectors on the title screen
const resSel = $('gfxRes'), hzSel = $('gfxHz');
if (resSel && hzSel) {
  resSel.value = GFX.res; hzSel.value = String(GFX.hz);
  const store = () => { GFX.res = resSel.value; GFX.hz = +hzSel.value; try { localStorage.setItem(GFX_KEY, JSON.stringify(GFX)); } catch (e) { } };
  resSel.onchange = store; hzSel.onchange = store;
}

placePlayer(S.x, S.z); camera.rotation.set(0, yaw, 0);
const clock = new THREE.Clock(); let uiT = 0, saveT = 0;
renderer.setAnimationLoop(() => {
  const rawDt = clock.getDelta(); const dt = Math.min(rawDt, 0.05); time += dt; if (rawDt > 0) fpsNow = lerp(fpsNow, 1 / rawDt, 0.05);
  if (running) {
    updateMovement(dt); updateDesktopSword(dt); updateVRSword(dt); updateSpawns(dt); updateEnemies(dt); updateRagdolls(dt); updatePickups(dt);
    if (interactQueued) { interactQueued = false; const h = headPos(); const it = interactables().find(i => Math.hypot(h.x - i.x, h.z - i.z) < i.r); if (it) it.act(); }
    if (potionQueued) { potionQueued = false; drinkPotion(); }
    const h = headPos(); const it = interactables().find(i => Math.hypot(h.x - i.x, h.z - i.z) < i.r); setPrompt(it ? it.label : '');
    // campfire heal + slow regen
    if (Math.hypot(h.x, h.z) < 5) S.hp = Math.min(maxHp(), S.hp + 12 * dt); else if (time - lastHurt > 6) S.hp = Math.min(maxHp(), S.hp + 1 * dt);
    toastT -= dt; if (toastT <= 0) { $('toast').style.opacity = 0; toastPanel.mat.opacity = Math.max(0, toastPanel.mat.opacity - dt * 3); if (toastPanel.mat.opacity <= 0) toastPanel.mesh.visible = false; }
    hurtFlash.material.opacity = Math.max(0, hurtFlash.material.opacity - dt * 1.5); if (hurtFlash.material.opacity <= 0) hurtFlash.visible = false;
    uiT -= dt; if (uiT <= 0) { uiT = 0.25; if (inVR) drawWrist(); else updateHUD(); }
    saveT += dt; if (saveT > 15) { saveT = 0; save(); }
  } else {
    yaw += dt * 0.05; camera.rotation.set(-0.05, yaw, 0);
  }
  for (let i = 0; i < flames.length; i++) { const f = flames[i]; f.scale.set(1 + Math.sin(time * 13 + i) * 0.12, 1 + Math.sin(time * 17 + i * 2) * 0.2, 1 + Math.cos(time * 11 + i) * 0.12); }
  if (Math.random() < dt * 8) burst(_v3.set((Math.random() - 0.5) * 0.4, VH + 0.9, (Math.random() - 0.5) * 0.4), 0xff8a2a, 1, 0.4, 1.4);
  updateSky(dt); updateParticles(dt);
  renderer.render(scene, camera);
});
addEventListener('beforeunload', () => { if (running) save(); });
window.__emberwild = { renderer, S, enemies, ragdolls, hitEnemy, heightAt, headPos, dolly, spawnEnemy, startSwing, placePlayer, setYaw: v => { yaw = v; } }; // debug hook
