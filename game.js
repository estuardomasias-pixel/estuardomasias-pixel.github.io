// EMBERWILD VR — an open-world WebXR RPG (runs in the Quest 3 browser or on a PC screen)
import * as THREE from 'three';
// Text is drawn into canvases at startup; wait (briefly) for the bundled Arimo font so labels don't render in a fallback.
try { await Promise.race([Promise.all([document.fonts.load('16px Arimo'), document.fonts.load('bold 16px Arimo')]), new Promise(r => setTimeout(r, 1500))]); } catch (e) { }

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
function save() { try { const h = headPos(); S.x = h.x; S.z = h.z; S.dayT = dayT; const held = ['left', 'right'].filter(k => grab[k]?.kind === 'potion').length; localStorage.setItem(SAVE_KEY, JSON.stringify({ ...S, potions: S.potions + held })); } catch (e) { } }

// ---------------------------------------------------------------- renderer / scene
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
// Graphics: sharpness + frame rate first. Resolution is a multiple of the headset's NATIVE panel resolution.
const GFX_KEY = 'emberwild-gfx-v1';
const GFX = { res: 'native', hz: 90, grip: 'hold' };
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
const gkey = (ix, iz) => (ix + 512) * 1024 + (iz + 512);
function addCollider(x, z, r) { const k = gkey(Math.floor(x / CELL), Math.floor(z / CELL)); if (!grid.has(k)) grid.set(k, []); grid.get(k).push({ x, z, r }); }
function collide(x, z, pr) {
  const ix = Math.floor(x / CELL), iz = Math.floor(z / CELL);
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
    const list = grid.get(gkey(ix + a, iz + b)); if (!list) continue;
    for (const c of list) { const dx = x - c.x, dz = z - c.z, d = Math.hypot(dx, dz), m = c.r + pr; if (d < m && d > 1e-4) { x = c.x + dx / d * m; z = c.z + dz / d * m; } }
  }
  return [x, z];
}
const nearSite = (x, z, pad) => SITE_LIST.some(s => Math.hypot(x - s.x, z - s.z) < s.r + pad);

// ---------------------------------------------------------------- nature (instanced)
{
  const trunkGeo = new THREE.CylinderGeometry(0.16, 0.28, 2.2, 6, 1, true); trunkGeo.translate(0, 1.1, 0); // open-ended: caps are hidden anyway
  // One InstancedMesh per type (one draw call each). Splitting into culled cells was considered, but all the nature
  // is only ~90k triangles while draw calls are the Quest's real cost, so a single batch per type is cheaper.
  const addBucketed = (geo, mat, items) => { // items: { x, z, m: Matrix4, c?: Color }
    const im = new THREE.InstancedMesh(geo, mat, items.length);
    items.forEach((it, i) => { im.setMatrixAt(i, it.m); if (it.c) im.setColorAt(i, it.c); });
    im.frustumCulled = false; im.matrixAutoUpdate = false; scene.add(im);
  };
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
  const q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3(), eul = new THREE.Euler();
  const mat4 = (t, y) => { q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, t.rot); sc.setScalar(t.s); p.set(t.x, y, t.z); return new THREE.Matrix4().compose(p, q, sc); };
  pts.forEach(t => { t.m = mat4(t, t.h - 0.2); addCollider(t.x, t.z, 0.35 * t.s); });
  pines.forEach(t => { t.c = new THREE.Color().setHSL(0.33 + rand() * 0.06, 0.45, 0.22 + rand() * 0.08); });
  oaks.forEach(t => { t.c = new THREE.Color().setHSL(0.2 + rand() * 0.1, 0.5, 0.3 + rand() * 0.1); });
  addBucketed(trunkGeo, new THREE.MeshLambertMaterial({ color: 0x6b4a2b }), pts.map(t => ({ x: t.x, z: t.z, m: t.m })));
  addBucketed(pineGeo, new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true }), pines);
  addBucketed(oakGeo, new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true }), oaks);

  const rockGeo = new THREE.DodecahedronGeometry(1, 0), rockItems = [];
  for (let i = 0; i < 4000 && rockItems.length < 380; i++) {
    const x = (rand() - 0.5) * WORLD * 0.9, z = (rand() - 0.5) * WORLD * 0.9; const h = heightAt(x, z);
    if (h < 0.5 || Math.hypot(x, z) > PLAY_RADIUS + 20 || nearSite(x, z, 3) || pathDist(x, z) < 3) continue;
    const s = 0.3 + Math.pow(rand(), 2) * 2.4;
    q.setFromEuler(eul.set(rand() * 3, rand() * 3, rand() * 3)); sc.set(s, s * (0.6 + rand() * 0.5), s); p.set(x, h, z);
    rockItems.push({ x, z, m: new THREE.Matrix4().compose(p, q, sc), c: new THREE.Color().setHSL(0.08, 0.06, 0.4 + rand() * 0.2) });
    if (s > 0.9) addCollider(x, z, s * 0.9);
  }
  addBucketed(rockGeo, new THREE.MeshLambertMaterial({ color: 0x8a8580, flatShading: true }), rockItems);

  const flowerGeo = new THREE.TetrahedronGeometry(0.14, 0), flowerItems = [];
  const fcols = [0xffe066, 0xff8fb3, 0xffffff, 0xb59cff, 0xff9f43];
  for (let i = 0; i < 12000 && flowerItems.length < 2500; i++) {
    const x = (rand() - 0.5) * WORLD * 0.85, z = (rand() - 0.5) * WORLD * 0.85; const h = heightAt(x, z);
    if (h < 1.5 || h > 24 || noise2(x / 30, z / 30) < 0.1) continue;
    p.set(x, h + 0.08, z); q.identity(); sc.setScalar(0.7 + rand() * 0.8);
    flowerItems.push({ x, z, m: new THREE.Matrix4().compose(p, q, sc), c: new THREE.Color().setHex(fcols[Math.floor(rand() * fcols.length)]) });
  }
  addBucketed(flowerGeo, new THREE.MeshBasicMaterial({ color: 0xffffff }), flowerItems);
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
  const tex = new THREE.CanvasTexture(real); tex.colorSpace = THREE.SRGBColorSpace; tex.generateMipmaps = false; tex.minFilter = THREE.LinearFilter; // re-uploaded on every refresh, so skip mipmaps
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, fog: false });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat); mesh.renderOrder = 999;
  return { mesh, ctx, canvas, mat, refresh() { tex.needsUpdate = true; } };
}
function makeLabel(text, color = '#ffe6a8', scale = 1.6) {
  const c = document.createElement('canvas'); c.width = 1024; c.height = 256; const x = c.getContext('2d'); x.scale(2, 2);
  x.font = 'bold 60px Arial,Arimo,sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
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
  pGeo.attributes.color.needsUpdate = true;
}
function updateParticles(dt) {
  for (let k = 0; k < P_MAX; k++) {
    if (pLife[k] <= 0) continue; pLife[k] -= dt;
    if (pLife[k] <= 0) { pPos[k * 3 + 1] = -9999; continue; }
    pVel[k * 3 + 1] -= 5 * dt;
    pPos[k * 3] += pVel[k * 3] * dt; pPos[k * 3 + 1] += pVel[k * 3 + 1] * dt; pPos[k * 3 + 2] += pVel[k * 3 + 2] * dt;
  }
  pGeo.attributes.position.needsUpdate = true;
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
const skyCol = new THREE.Color(), sunDir = new THREE.Vector3(), WHITE = new THREE.Color(0xffffff);
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
  hemi.intensity = 0.45 + 0.9 * f; hemi.color.copy(skyCol).lerp(WHITE, 0.4);
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
// Static village and tower meshes go into STATIC and are merged per material by bakeStatic() (a handful of draw
// calls for the whole village, interiors included).
const STATIC = new THREE.Group();
const FM = {
  floor: new THREE.MeshLambertMaterial({ color: 0x8a6a45 }), ceil: new THREE.MeshLambertMaterial({ color: 0x5a3e26 }),
  linen: new THREE.MeshLambertMaterial({ color: 0xe8e0d0 }), pot: new THREE.MeshLambertMaterial({ color: 0x2a2a2a }),
  jar: new THREE.MeshLambertMaterial({ color: 0x9a6a4a }), soil: new THREE.MeshLambertMaterial({ color: 0x5a3e24, flatShading: true }),
  leaf: new THREE.MeshLambertMaterial({ color: 0x4f8f3a, flatShading: true }), water: new THREE.MeshBasicMaterial({ color: 0x3a6f9f }),
  blanket: [0x8a3030, 0x2f5a8a, 0x5a7a30].map(c => new THREE.MeshLambertMaterial({ color: c })),
  rug: [0x7a2a2a, 0x2a4a6a].map(c => new THREE.MeshLambertMaterial({ color: c })),
};
// Houses: 5 x 4 m footprint (local units, scaled by s), door gap 1.4 m on the local +Z side, which faces the campfire.
// Local -> world: x' = H.x + (lx cos r + lz sin r) s, z' = H.z + (-lx sin r + lz cos r) s.
const HOUSES = [];
const houseToWorld = (H, lx, lz, out = new THREE.Vector3()) => { const c = Math.cos(H.rot), sn = Math.sin(H.rot); return out.set(H.x + (lx * c + lz * sn) * H.s, H.h, H.z + (-lx * sn + lz * c) * H.s); };
const houseToLocal = (H, x, z) => { const dx = (x - H.x) / H.s, dz = (z - H.z) / H.s, c = Math.cos(H.rot), sn = Math.sin(H.rot); return [dx * c - dz * sn, dx * sn + dz * c]; };
const houseAt = (x, z) => HOUSES.find(H => { const [lx, lz] = houseToLocal(H, x, z); return Math.abs(lx) < 2.5 && Math.abs(lz) < 2; }) || null;
// standing height: the house floor when inside one, the terrain everywhere else
const groundAt = (x, z) => { const H = houseAt(x, z); return H ? Math.max(heightAt(x, z), H.h + 0.1 * H.s) : heightAt(x, z); };
function house(x, z, rot, s = 1) {
  const g = new THREE.Group(), i = HOUSES.length, H = { i, x, z, rot, s, h: heightAt(x, z) }; HOUSES.push(H);
  const box = (w, h, d, mat, px, py, pz) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(px, py, pz); g.add(m); return m; };
  const cyl = (r, h, mat, px, py, pz, seg = 8) => { const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, seg), mat); m.position.set(px, py, pz); g.add(m); return m; };
  const T = 0.2, F = 2 - T / 2; // wall thickness, front wall z
  box(5, 3.2, T, M.wall, 0, 1.6, -F); box(T, 3.2, 4, M.wall, -2.5 + T / 2, 1.6, 0); box(T, 3.2, 4, M.wall, 2.5 - T / 2, 1.6, 0);
  box(1.8, 3.2, T, M.wall, -1.6, 1.6, F); box(1.8, 3.2, T, M.wall, 1.6, 1.6, F); box(1.4, 1.1, T, M.wall, 0, 2.65, F); // front, around the door
  for (const sx of [-1.6, 1.6]) box(0.8, 0.8, T + 0.02, M.lamp, sx, 1.9, F);                 // glowing windows (seen from both sides)
  for (const sx of [-0.74, 0.74]) box(0.1, 2.12, T + 0.04, M.dark, sx, 1.06, F);              // door frame
  const leaf = new THREE.Group(); leaf.position.set(-0.7, 0, F - T / 2 - 0.05); leaf.rotation.y = Math.PI - 0.12; g.add(leaf); // open door, swung back against the inside wall
  const lm = new THREE.Mesh(new THREE.BoxGeometry(1.3, 2, 0.06), M.dark); lm.position.set(0.65, 1, 0); leaf.add(lm);
  const roof = new THREE.Mesh(new THREE.ConeGeometry(4.1, 2.4, 4), M.roof); roof.position.y = 4.4; roof.rotation.y = Math.PI / 4; roof.scale.set(1, 1, 0.82); g.add(roof);
  box(4.9, 0.12, 3.9, FM.ceil, 0, 3.26, 0); box(4.6, 0.1, 3.6, FM.floor, 0, 0.05, 0);       // ceiling and floor
  // bed (back left), hearth with chimney and pot (back right), table and stools (front right), shelf, rug
  box(1.0, 0.35, 2.0, M.wood, -1.8, 0.2, -0.8); box(0.95, 0.12, 1.45, FM.blanket[i % 3], -1.8, 0.43, -0.5); box(0.7, 0.12, 0.35, FM.linen, -1.8, 0.45, -1.52);
  box(1.1, 0.9, 0.6, M.stone, 1.6, 0.45, -1.5); box(0.6, 0.3, 0.05, M.ember, 1.6, 0.35, -1.18); box(0.5, 2.3, 0.4, M.stone, 1.6, 2.05, -1.62);
  cyl(0.2, 0.25, FM.pot, 1.6, 1.03, -1.45);
  box(1.1, 0.07, 0.7, M.wood, 1.4, 0.75, 0.6); for (const lx of [0.92, 1.88]) for (const lz of [0.32, 0.88]) box(0.07, 0.72, 0.07, M.wood, lx, 0.36, lz);
  cyl(0.18, 0.45, M.wood, 1.4, 0.225, 1.25); cyl(0.18, 0.45, M.wood, 0.6, 0.225, 0.6); box(0.06, 0.12, 0.06, M.lamp, 1.55, 0.85, 0.5);
  box(1.2, 0.06, 0.3, M.wood, -0.1, 1.5, -1.73); for (const jx of [-0.5, -0.1, 0.3]) cyl(0.08, 0.2, FM.jar, jx, 1.63, -1.73, 6);
  box(1.6, 0.02, 1.2, FM.rug[i % 2], -0.2, 0.11, 0.3);
  if (i % 2) box(0.6, 0.6, 0.6, M.wood, -1.9, 0.3, 1.4); else cyl(0.3, 0.8, M.wood, -1.9, 0.4, 1.4);
  g.position.set(x, H.h, z); g.rotation.y = rot; g.scale.setScalar(s); STATIC.add(g);
  // colliders: a row of small circles along each wall (doorway left open), plus the bigger furniture
  const ring = (lx, lz, r) => { const w = houseToWorld(H, lx, lz); addCollider(w.x, w.z, r * s); };
  for (let t = -2.5; t <= 2.5; t += 0.4) ring(t, -1.9, 0.28);
  for (let t = -1.9; t <= 1.9; t += 0.4) { ring(-2.4, t, 0.28); ring(2.4, t, 0.28); }
  for (let t = 0.85; t <= 2.5; t += 0.4) { ring(-t, 1.9, 0.28); ring(t, 1.9, 0.28); }
  ring(-1.8, -1.3, 0.5); ring(-1.8, -0.35, 0.5); ring(1.6, -1.5, 0.55); ring(1.4, 0.6, 0.5); ring(-1.9, 1.4, 0.35); ring(1.4, 1.25, 0.2); ring(0.6, 0.6, 0.2);
}
for (let i = 0; i < 7; i++) {
  const a = i / 7 * Math.PI * 2 + 0.3; if (Math.abs(Math.sin(a - 0.0)) < 0.2 && Math.cos(a) > 0) continue;
  const r = 15 + (i % 2) * 2.5; const x = Math.sin(a) * r, z = Math.cos(a) * r;
  house(x, z, Math.atan2(-x, -z), 0.9 + (i % 3) * 0.12);
}
// village props used by the villagers' chores: well, chopping block, woodpile, vegetable garden
const PROPS = { well: { x: -2.5, z: 8 }, block: { x: -8.5, z: -6.5 }, woodpile: { x: -2.9, z: -2.4 }, garden: { x: 8, z: 6 } };
{
  const add = (geo, mat, x, y, z, ry = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, VH + y, z); m.rotation.y = ry; STATIC.add(m); return m; };
  const W = PROPS.well; add(new THREE.CylinderGeometry(0.75, 0.8, 0.8, 12, 1, true), M.stone, W.x, 0.4, W.z); add(new THREE.CircleGeometry(0.72, 12).rotateX(-Math.PI / 2), FM.water, W.x, 0.55, W.z);
  for (const sx of [-0.8, 0.8]) add(new THREE.BoxGeometry(0.1, 1.8, 0.1), M.wood, W.x + sx, 0.9, W.z);
  add(new THREE.ConeGeometry(1.1, 0.7, 4).rotateY(Math.PI / 4), M.roof, W.x, 2.1, W.z); add(new THREE.CylinderGeometry(0.05, 0.05, 1.7, 6).rotateZ(Math.PI / 2), M.wood, W.x, 1.6, W.z);
  addCollider(W.x, W.z, 0.95);
  const B = PROPS.block; add(new THREE.CylinderGeometry(0.35, 0.4, 0.5, 9), M.wood, B.x, 0.25, B.z); addCollider(B.x, B.z, 0.45);
  const P = PROPS.woodpile; for (let k = 0; k < 9; k++) add(new THREE.CylinderGeometry(0.11, 0.11, 0.9, 6).rotateZ(Math.PI / 2), M.wood, P.x, 0.11 + Math.floor(k / 4) * 0.2, P.z - 0.35 + (k % 4) * 0.23 + (Math.floor(k / 4) % 2) * 0.1);
  addCollider(P.x, P.z, 0.6);
  const G = PROPS.garden; add(new THREE.BoxGeometry(3, 0.12, 2), FM.soil, G.x, 0.06, G.z);
  for (let a = 0; a < 3; a++) for (let b = 0; b < 5; b++) add(new THREE.ConeGeometry(0.12, 0.3, 5), FM.leaf, G.x - 1.1 + b * 0.55, 0.27, G.z - 0.6 + a * 0.6);
}
// campfire
const fire = new THREE.Group();
for (let i = 0; i < 4; i++) { const l = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 1.3, 5), M.wood); l.rotation.z = Math.PI / 2; l.rotation.y = i * Math.PI / 4; l.position.set(0, VH + 0.1, 0); STATIC.add(l); }
const flames = [];
for (let i = 0; i < 3; i++) { const f = new THREE.Mesh(new THREE.ConeGeometry(0.3 - i * 0.07, 1 - i * 0.2, 6), i ? M.flame : M.ember); f.position.y = 0.5; fire.add(f); flames.push(f); }
for (let i = 0; i < 8; i++) { const s = new THREE.Mesh(new THREE.DodecahedronGeometry(0.22, 0), M.stone); s.position.set(Math.cos(i / 8 * 6.28) * 0.85, VH + 0.1, Math.sin(i / 8 * 6.28) * 0.85); STATIC.add(s); }
fire.position.set(0, VH, 0); scene.add(fire); addCollider(0, 0, 1.1);
// lantern posts along paths
for (const [ax, az, bx, bz] of PATHS) {
  const len = Math.hypot(bx - ax, bz - az);
  for (let d = 26; d < Math.min(len, 90); d += 16) {
    const t = d / len, x = lerp(ax, bx, t) + (bz - az) / len * 2.6, z = lerp(az, bz, t) - (bx - ax) / len * 2.6, h = heightAt(x, z);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 2.2, 5), M.wood); post.position.set(x, h + 1.1, z);
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.32, 0.28), M.lamp); lamp.position.set(x, h + 2.3, z);
    STATIC.add(post, lamp);
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
  g.position.set(T.x, T.h, T.z); g.rotation.y = Math.atan2(-T.x, -T.z); STATIC.add(g); addCollider(T.x, T.z, 4.6);
  const lbl = makeLabel('The Ashen Tower', '#d9b3ff', 6); lbl.position.set(T.x, T.h + 31, T.z); scene.add(lbl);
}
// merge every static mesh above into one mesh per material (world space), then free the source geometries
(function bakeStatic() {
  STATIC.updateMatrixWorld(true); const byMat = new Map();
  STATIC.traverse(o => { if (o.isMesh) { if (!byMat.has(o.material)) byMat.set(o.material, []); byMat.get(o.material).push({ geo: o.geometry, m: o.matrixWorld.clone() }); } });
  for (const [mat, list] of byMat) { const mesh = new THREE.Mesh(mergeGeos(list), mat); mesh.matrixAutoUpdate = false; scene.add(mesh); for (const it of list) it.geo.dispose(); }
})();

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
// ---------------------------------------------------------------- humanoid rig (one skeleton shared by NPCs and enemies)
// Metres at scale 1 (about 1.8 m tall), facing +Z. Limbs are pivots with the mesh hanging along -Y:
// upper (hips pivot) -> chest, neck, head; shoulder -> upper arm -> elbow -> forearm + hand; hip -> thigh -> knee -> shin + foot.
const HUM = { hip: 0.9, thigh: 0.43, shin: 0.42, uarm: 0.3, farm: 0.27, chestTop: 0.6, shoulderY: 0.55 };
const limbGeo = (L, r0, r1) => { const g = new THREE.CylinderGeometry(r0, r1, L, 7); g.translate(0, -L / 2, 0); return g; };
const HG = {
  thigh: limbGeo(HUM.thigh, 0.075, 0.058), shin: limbGeo(HUM.shin, 0.058, 0.044),
  uarm: limbGeo(HUM.uarm, 0.058, 0.048), farm: limbGeo(HUM.farm, 0.047, 0.038),
  joint: new THREE.SphereGeometry(1, 8, 6), foot: new THREE.BoxGeometry(0.1, 0.07, 0.22),
  chest: new THREE.CapsuleGeometry(0.15, 0.16, 3, 8), pelvis: new THREE.CapsuleGeometry(0.13, 0.04, 3, 8),
  neck: new THREE.CylinderGeometry(0.05, 0.055, 0.12, 6), head: new THREE.SphereGeometry(0.12, 12, 10),
  eye: new THREE.SphereGeometry(0.022, 6, 4), spike: new THREE.ConeGeometry(0.045, 0.2, 5),
  hair: new THREE.SphereGeometry(0.128, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), beard: new THREE.ConeGeometry(0.075, 0.2, 7),
};
const _hm = (geo, mat, parent, x = 0, y = 0, z = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); parent.add(m); return m; };
// o: { skin, top, legs, boots, eye, chestW, hunch }
function makeHumanoid(o) {
  const g = new THREE.Group(), cw = o.chestW || 1;
  const upper = new THREE.Group(); upper.position.y = HUM.hip; g.add(upper);
  const chest = _hm(HG.chest, o.top, upper, 0, 0.38); chest.scale.set(1.3 * cw, 1, 0.82);
  const pelvis = _hm(HG.pelvis, o.legs, upper, 0, 0.06); pelvis.scale.set(1.25 * cw, 1, 0.85);
  _hm(HG.neck, o.skin, upper, 0, 0.63);
  const head = new THREE.Group(); head.position.y = 0.68; upper.add(head);
  const skull = _hm(HG.head, o.skin, head, 0, 0.12);
  const skullPt = new THREE.Object3D(); skullPt.position.y = 0.12; head.add(skullPt); // survives mesh merging
  if (o.eye) for (const sx of [-1, 1]) _hm(HG.eye, o.eye, skull, sx * 0.045, 0.01, 0.105);
  const limb = (geo, mat, parent, x, y) => { const p = new THREE.Group(); p.position.set(x, y, 0); _hm(geo, mat, p); parent.add(p); return p; };
  const arms = [], fore = [], hands = [], legs = [], shins = [];
  for (const sx of [-1, 1]) {
    const ua = limb(HG.uarm, o.top, upper, sx * (0.19 * cw + 0.05), HUM.shoulderY); ua.rotation.z = sx * 0.12;
    _hm(HG.joint, o.top, ua).scale.setScalar(0.068);
    const fa = limb(HG.farm, o.skin, ua, 0, -HUM.uarm); fa.rotation.x = -0.25;
    const hand = new THREE.Group(); hand.position.y = -HUM.farm; fa.add(hand); _hm(HG.joint, o.skin, hand).scale.set(0.05, 0.065, 0.035);
    const th = limb(HG.thigh, o.legs, g, sx * 0.1, HUM.hip);
    const sn = limb(HG.shin, o.legs, th, 0, -HUM.thigh); _hm(HG.foot, o.boots || o.legs, sn, 0, -HUM.shin + 0.01, 0.05);
    arms.push(ua); fore.push(fa); hands.push(hand); legs.push(th); shins.push(sn);
  }
  const hunch = o.hunch || 0; upper.rotation.x = hunch;
  return { g, upper, chest, head, skull, skullPt, arms, fore, hands, legs, shins, hunch };
}
// Merge the meshes inside each body-part pivot that share a material into one mesh (fewer draw calls: a gloomling
// goes from ~22 meshes to ~12). Pivots stay separate so animation and ragdolls still work. Merged geometry is
// cached per enemy type, so every enemy of a type shares it (nothing to dispose per enemy).
const _mergeCache = new Map();
function mergeGeos(list) { // list: [{ geo, m: Matrix4 }] -> one non-indexed geometry with position + normal
  const parts = list.map(({ geo, m }) => { const g = (geo.index ? geo.toNonIndexed() : geo.clone()); g.applyMatrix4(m); return g; });
  let n = 0; for (const g of parts) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3); let o = 0;
  for (const g of parts) { pos.set(g.attributes.position.array, o * 3); if (g.attributes.normal) nor.set(g.attributes.normal.array, o * 3); o += g.attributes.position.count; g.dispose(); }
  const out = new THREE.BufferGeometry(); out.setAttribute('position', new THREE.BufferAttribute(pos, 3)); out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.computeBoundingSphere(); return out;
}
function mergeRig(r, cacheKey) {
  const pivots = [r.upper, r.head, ...r.arms, ...r.fore, ...r.legs, ...r.shins], into = new Set(r.hands);
  pivots.forEach((pv, pi) => {
    const recs = [];
    const walk = (obj, rel) => { for (const c of obj.children) {
      if (c.isMesh) { c.updateMatrix(); const m = rel.clone().multiply(c.matrix); recs.push({ mesh: c, m }); walk(c, m); }
      else if (into.has(c)) { c.updateMatrix(); walk(c, rel.clone().multiply(c.matrix)); } // hand groups fold into the forearm
    } };
    walk(pv, new THREE.Matrix4());
    if (recs.length < 2) return;
    const byMat = new Map(); for (const rc of recs) { if (!byMat.has(rc.mesh.material)) byMat.set(rc.mesh.material, []); byMat.get(rc.mesh.material).push(rc); }
    for (const rc of recs) rc.mesh.removeFromParent();
    let slot = 0;
    for (const [mat, list] of byMat) {
      const key = cacheKey + ':' + pi + ':' + (slot++);
      if (!_mergeCache.has(key)) _mergeCache.set(key, mergeGeos(list.map(rc => ({ geo: rc.mesh.geometry, m: rc.m }))));
      pv.add(new THREE.Mesh(_mergeCache.get(key), mat));
    }
  });
  r.chest = null; // merged away (enemies don't breathe)
}
// walk cycle: amp 0..1 stride, lf 0..1 attack lunge (both arms swing forward)
function animateHumanoid(r, walk, amp, lf = 0) {
  const sw = Math.sin(walk) * amp * 0.65, c = Math.cos(walk);
  r.legs[0].rotation.x = -sw; r.legs[1].rotation.x = sw;
  r.shins[0].rotation.x = 0.08 + Math.max(0, c) * amp * 1.1; r.shins[1].rotation.x = 0.08 + Math.max(0, -c) * amp * 1.1;
  r.arms[0].rotation.x = sw * 0.8 - lf * 2.2; r.arms[1].rotation.x = -sw * 0.8 - lf * 2.2;
  r.fore[0].rotation.x = r.fore[1].rotation.x = -0.25 - amp * 0.35 - lf * 0.5;
}
const wrapAng = a => Math.atan2(Math.sin(a), Math.cos(a));

function makeNPC(name, look, x, z, faceAng, collide = true) {
  const r = makeHumanoid(look), g = r.g;
  const label = makeLabel(name); label.position.y = 2.25; g.add(label);
  const mark = makeLabel('!', '#ffd84a', 2.4); mark.position.y = 2.75; mark.visible = false; g.add(mark);
  g.position.set(x, heightAt(x, z), z); g.rotation.y = faceAng; scene.add(g); if (collide) addCollider(x, z, 0.45);
  return { name, g, r, head: r.head, label, mark, x, z, face: faceAng, yaw: faceAng, talk: 0, t: Math.random() * 6 };
}
const npcMat = c => new THREE.MeshLambertMaterial({ color: c });
const SKIN = npcMat(0xe0b48a), BOOTS = npcMat(0x3a2a1a), NPC_EYE = new THREE.MeshBasicMaterial({ color: 0x1a1410 });
const elder = makeNPC('Elder Maren', { skin: SKIN, top: npcMat(0x3b5ba8), legs: npcMat(0x2c3f78), boots: BOOTS, eye: NPC_EYE, chestW: 0.9 }, 3.5, -4, 0.6);
{ // long robe, white hair and beard, staff in the hand
  const robeMat = elder.r.chest.material, white = npcMat(0xe8e4dc);
  const skirt = _hm(new THREE.CylinderGeometry(0.19, 0.33, 0.82, 10), robeMat, elder.r.upper, 0, -0.37);
  const hair = _hm(HG.hair, white, elder.r.skull, 0, 0.012, -0.012); hair.rotation.x = -0.45;
  const beard = _hm(HG.beard, white, elder.r.skull, 0, -0.12, 0.075); beard.rotation.x = Math.PI + 0.25;
  elder.staff = _hm(new THREE.CylinderGeometry(0.03, 0.035, 1.9, 6), M.wood, elder.r.hands[1], 0, 0.05, 0.02);
  _hm(new THREE.IcosahedronGeometry(0.07, 0), M.lamp, elder.staff, 0, 0.98, 0);
  elder.r.arms[1].rotation.x = -0.3; elder.r.fore[1].rotation.x = -0.95; elder.skirt = skirt;
}
const anvil = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.6, 0.4), M.stone); anvil.position.set(-6.2, VH + 0.3, 4.4); scene.add(anvil);
const smith = makeNPC('Smith Tovik', { skin: SKIN, top: npcMat(0x7a3b1e), legs: npcMat(0x3b3026), boots: BOOTS, eye: NPC_EYE, chestW: 1.2 }, -6.15, 3.55, Math.atan2(-6.2 + 6.15, 4.4 - 3.55));
{ // leather apron, dark beard, hammer
  const leather = npcMat(0x4a2a14), brown = npcMat(0x3a2414);
  const apron = _hm(new THREE.BoxGeometry(0.34, 0.62, 0.02), leather, smith.r.upper, 0, 0.18, 0.135); apron.rotation.x = -0.05;
  const beard = _hm(HG.beard, brown, smith.r.skull, 0, -0.11, 0.08); beard.rotation.x = Math.PI + 0.3;
  smith.hammer = new THREE.Group(); smith.hammer.position.set(0, -0.02, 0); smith.r.hands[1].add(smith.hammer);
  _hm(new THREE.CylinderGeometry(0.018, 0.018, 0.42, 5), M.wood, smith.hammer, 0, 0, 0.15).rotation.x = Math.PI / 2;
  _hm(new THREE.BoxGeometry(0.08, 0.08, 0.16), M.stone, smith.hammer, 0, 0, 0.36).rotation.y = Math.PI / 2;
}
const npcs = [elder, smith];
// ---------------------------------------------------------------- villagers with daily chores
// Each villager loops through a list of tasks: walk to a spot (through house doors when going in or out, around the
// campfire), then do a chore animation there for a while. At night everyone goes home and sleeps in their bed.
const nearestHouse = (x, z) => HOUSES.reduce((b, H) => Math.hypot(H.x - x, H.z - z) < Math.hypot(b.x - x, b.z - z) ? H : b, HOUSES[0]);
const inHouse = (H, lx, lz) => { const w = houseToWorld(H, lx, lz); return { x: w.x, z: w.z, house: H }; };
const doorOut = H => inHouse(H, 0, 3.2), doorIn = H => inHouse(H, 0, 1.0);
function propMesh(kind) { // tools and carried things, held in the right hand (hand space: -Y runs along the fingers, +Z forward)
  const g = new THREE.Group(), pole = (len, mat = M.wood) => { const m = _hm(new THREE.CylinderGeometry(0.018, 0.018, len, 5), mat, g, 0, 0, len / 2 - 0.08); m.rotation.x = Math.PI / 2; return m; };
  if (kind === 'axe') { pole(0.7); _hm(new THREE.BoxGeometry(0.03, 0.14, 0.12), M.stone, g, 0, 0.05, 0.56); }
  if (kind === 'hoe') { pole(1.2); _hm(new THREE.BoxGeometry(0.16, 0.02, 0.1), M.stone, g, 0, -0.05, 1.08); }
  if (kind === 'broom') { pole(1.1); _hm(new THREE.ConeGeometry(0.1, 0.3, 6), FM.jar, g, 0, 0, 1.08).rotation.x = -Math.PI / 2; }
  if (kind === 'spoon') { pole(0.45); }
  if (kind === 'bucket') { _hm(new THREE.CylinderGeometry(0.13, 0.1, 0.22, 8), M.wood, g, 0, -0.16, 0); }
  if (kind === 'basket') { _hm(new THREE.CylinderGeometry(0.2, 0.15, 0.16, 8), FM.jar, g, 0, -0.06, 0.18); for (let k = 0; k < 4; k++) _hm(new THREE.SphereGeometry(0.05, 6, 4), FM.leaf, g, (k - 1.5) * 0.07, 0.04, 0.18); }
  if (kind === 'log') { _hm(new THREE.CylinderGeometry(0.11, 0.11, 0.6, 6), M.wood, g, 0, -0.02, 0.15).rotation.z = Math.PI / 2; }
  g.visible = false; return g;
}
const villagers = [];
// r: preferred clearance; core: the solid part plus half a body width, never walked through
const OBSTACLES = [{ x: 0, z: 0, r: 2.2, core: 1.4 }, { x: PROPS.well.x, z: PROPS.well.z, r: 1.5, core: 1.25 }, { x: PROPS.woodpile.x, z: PROPS.woodpile.z, r: 1.2, core: 0.8 },
  { x: PROPS.block.x, z: PROPS.block.z, r: 0.9, core: 0.6 }, { x: elder.x, z: elder.z, r: 0.8, core: 0.5 }, { x: smith.x, z: smith.z, r: 0.8, core: 0.5 }, { x: anvil.position.x, z: anvil.position.z, r: 0.7, core: 0.55 }];
function makeVillager(def) {
  const n = makeNPC(def.name, def.look, def.home.x, def.home.z, 0, false);
  n.g.rotation.order = 'YXZ'; if (def.scale) n.g.scale.setScalar(def.scale);
  Object.assign(n, { home: def.home, day: def.day, lines: def.lines, speed: def.speed || 1.2, task: -1, tasks: null, route: [], timer: 0, act: 'idle', prop: null, props: {}, lineI: 0, beat: 0 });
  for (const k of ['axe', 'hoe', 'broom', 'spoon', 'bucket', 'basket', 'log']) { n.props[k] = propMesh(k); n.r.hands[1].add(n.props[k]); }
  mergeRig(n.r, 'villager:' + def.name); // fewer draw calls; tool props stay separate (they are groups in the hand)
  const start = doorIn(def.home); n.x = start.x; n.z = start.z;
  villagers.push(n); return n;
}
function routeTo(n, t) { // waypoints from where the villager is to target t ({ x, z, house })
  const from = houseAt(n.x, n.z), pts = [];
  if (from && from !== t.house) pts.push(doorIn(from), doorOut(from));
  if (t.house && t.house !== from) pts.push(doorOut(t.house), doorIn(t.house));
  pts.push(t);
  // walk around obstacles (campfire, well, woodpile, chopping block, the Elder, the smith and his anvil) instead of
  // through them; an obstacle that contains the start or the goal of a leg (e.g. working at the well) is ignored
  const out = []; let px = n.x, pz = n.z;
  for (const q of pts) {
    for (const o of OBSTACLES) {
      // keep a wide berth normally; when working right next to it, still never cut through its solid core
      const near = Math.hypot(px - o.x, pz - o.z) < o.r || Math.hypot(q.x - o.x, q.z - o.z) < o.r, R = near ? o.core : o.r;
      if (Math.hypot(px - o.x, pz - o.z) < R || Math.hypot(q.x - o.x, q.z - o.z) < R) continue;
      const dx = q.x - px, dz = q.z - pz, L2 = dx * dx + dz * dz || 1, u = clamp(((o.x - px) * dx + (o.z - pz) * dz) / L2, 0, 1);
      const cx = px + dx * u - o.x, cz = pz + dz * u - o.z, cd = Math.hypot(cx, cz);
      if (cd < R && u > 0 && u < 1) { const L = Math.sqrt(L2), ux = cd ? cx / cd : -dz / L, uz = cd ? cz / cd : dx / L, k = near ? R + 0.25 : R + 0.5; out.push({ x: o.x + ux * k, z: o.z + uz * k }); px = out[out.length - 1].x; pz = out[out.length - 1].z; }
    }
    out.push(q); px = q.x; pz = q.z;
  }
  return out;
}
function nextTask(n) {
  n.task = (n.task + 1) % n.tasks.length; const t = n.tasks[n.task];
  n.route = routeTo(n, t.at); n.timer = t.dur; n.act = 'walk';
  for (const k in n.props) n.props[k].visible = k === t.carry; // carried on the way there
}
function chorePose(n, act, t, dt) {
  const r = n.r, sw = Math.sin(t * 3);
  r.upper.rotation.set(r.hunch, 0, 0); n.g.rotation.x = 0;
  for (const s of [0, 1]) { r.arms[s].rotation.z = (s ? 1 : -1) * 0.12; r.legs[s].rotation.x = 0; r.shins[s].rotation.x = 0.08; }
  if (act === 'chop' || act === 'hoe') { // raise slowly, strike fast
    const per = act === 'chop' ? 1.3 : 1.0, p = (t % per) / per, up = p < 0.72 ? smoothstep(0, 0.72, p) : 1 - (p - 0.72) / 0.28, big = act === 'chop' ? 2.3 : 1.4;
    for (const s of [0, 1]) { r.arms[s].rotation.x = -0.4 - up * big; r.fore[s].rotation.x = -0.35; }
    r.upper.rotation.x = r.hunch + 0.15 + (1 - up) * (act === 'hoe' ? 0.45 : 0.3);
    if (n.beat > 0.9 && p < 0.1) { const h = headPos(), d = Math.hypot(h.x - n.x, h.z - n.z); if (d < 14) { const w = n.r.hands[1].getWorldPosition(_v2); burst(w, act === 'chop' ? 0xc9a36a : 0x6a4a2a, 6, 1.5, 0.8); tone(act === 'chop' ? 300 : 160, 0.06, 'triangle', 0.05 * (1 - d / 14)); } }
    n.beat = p;
  } else if (act === 'sweep') {
    r.arms[0].rotation.x = -0.75; r.arms[1].rotation.x = -0.55; r.fore[0].rotation.x = r.fore[1].rotation.x = -0.3;
    r.arms[0].rotation.z = -0.12 + sw * 0.35; r.arms[1].rotation.z = 0.12 + sw * 0.35; r.upper.rotation.y = sw * 0.25; r.upper.rotation.x = r.hunch + 0.2;
  } else if (act === 'stir') {
    r.arms[1].rotation.x = -1.0 + Math.sin(t * 4) * 0.15; r.arms[1].rotation.z = 0.12 + Math.cos(t * 4) * 0.2; r.fore[1].rotation.x = -0.8;
    r.arms[0].rotation.x = -0.1; r.fore[0].rotation.x = -0.3; r.upper.rotation.x = r.hunch + 0.15;
  } else if (act === 'pull') { // hauling the well bucket up hand over hand
    r.arms[0].rotation.x = -1.3 + sw * 0.5; r.arms[1].rotation.x = -1.3 - sw * 0.5; r.fore[0].rotation.x = r.fore[1].rotation.x = -0.6;
  } else if (act === 'tend') { // kneel and pick
    r.upper.rotation.x = r.hunch + 0.85; for (const s of [0, 1]) { r.arms[s].rotation.x = -0.9 + Math.sin(t * 2.5 + s * 2) * 0.35; r.fore[s].rotation.x = -0.3; r.legs[s].rotation.x = -0.6; r.shins[s].rotation.x = 1.2; }
  } else if (act === 'warm') { for (const s of [0, 1]) { r.arms[s].rotation.x = -1.05 + Math.sin(t * 1.3 + s) * 0.05; r.fore[s].rotation.x = -0.35; } }
  else if (act === 'stack') { r.upper.rotation.x = r.hunch + 0.7; for (const s of [0, 1]) { r.arms[s].rotation.x = -1.1; r.fore[s].rotation.x = -0.6; } }
  else if (act === 'wave') { r.arms[1].rotation.x = -2.9; r.arms[1].rotation.z = 0.3 + Math.sin(t * 9) * 0.35; r.fore[1].rotation.x = -0.3; r.arms[0].rotation.x = 0; }
  else if (act === 'sit') { for (const s of [0, 1]) { r.legs[s].rotation.x = -1.5; r.shins[s].rotation.x = 1.5; r.arms[s].rotation.x = -0.75; r.fore[s].rotation.x = -0.5; } }
  else if (act === 'sleep') { n.g.rotation.x = -Math.PI / 2; for (const s of [0, 1]) { r.arms[s].rotation.x = 0; r.fore[s].rotation.x = -0.1; } }
  else { for (const s of [0, 1]) { r.arms[s].rotation.x = -0.05; r.fore[s].rotation.x = -0.2; } } // idle
}
function updateVillagers(dt) {
  const night = isNight(), h = headPos();
  for (const n of villagers) {
    const wantNight = night;
    if (n.tasks === null || n.isNight !== wantNight) { // switch between the day routine and going to bed
      n.isNight = wantNight; n.task = -1;
      const bed = inHouse(n.home, -1.8, 0.15);
      n.tasks = wantNight ? [{ at: bed, act: 'sleep', dur: 1e9, face: 0, local: true }] : n.day; nextTask(n);
    }
    n.t += dt; n.talk = Math.max(0, n.talk - dt);
    const t = n.tasks[n.task], dxp = h.x - n.x, dzp = h.z - n.z, dp = Math.hypot(dxp, dzp);
    let yawTarget = n.yaw, moving = 0;
    if (n.talk > 0 && n.act !== 'sleep') { yawTarget = Math.atan2(dxp, dzp); chorePose(n, 'idle', n.t, dt); if (n.r.arms[1]) { n.r.arms[1].rotation.x = -0.6 - Math.sin(n.t * 3.1) * 0.2; n.r.fore[1].rotation.x = -0.7; } }
    else if (n.route.length) { // walking
      const q = n.route[0], dx = q.x - n.x, dz = q.z - n.z, d = Math.hypot(dx, dz), step = n.speed * dt;
      if (d <= step) { n.x = q.x; n.z = q.z; n.route.shift(); } else { n.x += dx / d * step; n.z += dz / d * step; yawTarget = Math.atan2(dx, dz); moving = 1; }
      n.walk = (n.walk || 0) + dt * (2 + n.speed * 3.5); chorePose(n, 'idle', n.t, dt); animateHumanoid(n.r, n.walk, moving ? Math.min(1, n.speed / 1.4) : 0, 0);
      if (t.carry) for (const s of [0, 1]) { n.r.arms[s].rotation.x = -0.9; n.r.fore[s].rotation.x = -0.9; }
      if (!n.route.length) { n.act = t.act; for (const k in n.props) n.props[k].visible = k === t.prop; }
    } else { // doing the chore
      n.act = t.act; yawTarget = t.local ? t.at.house.rot + t.face : t.face; chorePose(n, n.act, n.t, dt);
      n.timer -= dt; if (n.timer <= 0) nextTask(n);
    }
    n.yaw += wrapAng(yawTarget - n.yaw) * Math.min(1, dt * 5); n.g.rotation.y = n.yaw; n.label.visible = n.act !== 'sleep';
    // head follows the player when close and awake
    const look = dp < 4 && n.act !== 'sleep' ? THREE.MathUtils.clamp(wrapAng(Math.atan2(dxp, dzp) - n.yaw), -1.1, 1.1) : 0;
    n.head.rotation.y = lerp(n.head.rotation.y, look, Math.min(1, dt * 4));
    const sc = n.g.scale.x, lift = n.act === 'sit' ? -0.45 * sc : n.act === 'sleep' ? 0.5 * n.home.s : 0;
    n.g.position.set(n.x, groundAt(n.x, n.z) + lift, n.z);
  }
}
const H_GARDEN = nearestHouse(PROPS.garden.x, PROPS.garden.z), H_BLOCK = nearestHouse(PROPS.block.x, PROPS.block.z);
const H_WELL = nearestHouse(PROPS.well.x, PROPS.well.z), H_KID = HOUSES.find(Hh => ![H_GARDEN, H_BLOCK, H_WELL].includes(Hh)) || HOUSES[0];
const spot = (x, z) => ({ x, z }), faceTo = (fx, fz, tx, tz) => Math.atan2(tx - fx, tz - fz);
const VG = PROPS.garden, VB = PROPS.block, VW = PROPS.well, VP = PROPS.woodpile;
makeVillager({ name: 'Farmer Odile', home: H_GARDEN, look: { skin: npcMat(0xc99a72), top: npcMat(0x5a7a3a), legs: npcMat(0x4a3a2a), boots: BOOTS, eye: NPC_EYE, chestW: 0.9 },
  day: [
    { at: spot(VG.x - 0.5, VG.z + 1.4), act: 'hoe', prop: 'hoe', dur: 14, face: Math.PI },
    { at: spot(VG.x + 0.6, VG.z + 1.3), act: 'tend', dur: 8, face: Math.PI },
    { at: inHouse(H_GARDEN, 0.55, 0.6), act: 'sit', carry: 'basket', dur: 9, face: Math.PI / 2, local: true },
  ], lines: ['The soil here is stubborn, but the turnips don\'t mind.', 'Keep the Gloom out of my garden, warden!', 'Fresh greens for Ines\'s soup - nothing better.'] });
makeVillager({ name: 'Woodcutter Bram', home: H_BLOCK, look: { skin: npcMat(0xd8a47e), top: npcMat(0x8a2f2f), legs: npcMat(0x3b3026), boots: BOOTS, eye: NPC_EYE, chestW: 1.25 },
  day: [
    { at: spot(VB.x + 0.95, VB.z + 0.3), act: 'chop', prop: 'axe', dur: 14, face: faceTo(VB.x + 0.95, VB.z + 0.3, VB.x, VB.z) },
    { at: spot(VP.x + 0.9, VP.z), act: 'stack', carry: 'log', dur: 3, face: -Math.PI / 2 },
    { at: spot(-1.6, -1.2), act: 'warm', dur: 7, face: faceTo(-1.6, -1.2, 0, 0) },
  ], lines: ['Firewood keeps the Gloom at bay. Can\'t have too much of it.', 'Mind the axe, friend.', 'That fire burns all night. Somebody has to feed it.'] });
makeVillager({ name: 'Ines the Cook', home: H_WELL, look: { skin: npcMat(0xb98a64), top: npcMat(0x8a6a2a), legs: npcMat(0x6a3a4a), boots: BOOTS, eye: NPC_EYE, chestW: 0.95 },
  day: [
    { at: inHouse(H_WELL, 1.6, -0.75), act: 'stir', prop: 'spoon', dur: 14, face: Math.PI, local: true },
    { at: spot(VW.x + 1.15, VW.z), act: 'pull', dur: 7, face: -Math.PI / 2 },
    { at: inHouse(H_WELL, 1.6, -0.75), act: 'stir', carry: 'bucket', prop: 'spoon', dur: 10, face: Math.PI, local: true },
    { at: inHouse(H_WELL, 0.55, 0.6), act: 'sit', dur: 7, face: Math.PI / 2, local: true },
  ], lines: ['Soup\'s on soon. The well water makes all the difference.', 'You look hungry, warden. Come by later.', 'Bram eats enough for three woodcutters.'] });
makeVillager({ name: 'Young Pip', home: H_KID, scale: 0.68, speed: 1.7, look: { skin: npcMat(0xe0b48a), top: npcMat(0x3a6aa8), legs: npcMat(0x5a4a3a), boots: BOOTS, eye: NPC_EYE, chestW: 0.9 },
  day: [
    { at: spot(5.6, -0.6), act: 'sweep', prop: 'broom', dur: 10, face: 0.6 },
    { at: spot(VW.x - 0.6, VW.z - 1.4), act: 'wave', dur: 3, face: Math.PI },
    { at: spot(-1.6, 5.2), act: 'sweep', prop: 'broom', dur: 9, face: -2.2 },
    { at: spot(1.4, 2.2), act: 'warm', dur: 5, face: faceTo(1.4, 2.2, 0, 0) },
  ], lines: ['When I grow up I\'ll fight the Hollow King too!', 'Elder Maren says I sweep the best in the whole village.', 'Have you seen the golden beams? I want to touch one!'] });
// NPCs turn to face you up close, look at you with their heads, gesture while talking; the smith hammers at his anvil.
function updateNPCs(dt) {
  const h = headPos();
  for (const n of npcs) {
    n.t += dt; n.talk = Math.max(0, n.talk - dt);
    const dx = h.x - n.x, dz = h.z - n.z, d = Math.hypot(dx, dz), toYou = Math.atan2(dx, dz);
    const busy = n === smith && d > 3.2;
    n.yaw += wrapAng((d < 3.2 || n.talk > 0 ? toYou : n.face) - n.yaw) * Math.min(1, dt * 3); n.g.rotation.y = n.yaw;
    const look = d < 9 ? THREE.MathUtils.clamp(wrapAng(toYou - n.yaw), -1.1, 1.1) : 0;
    n.head.rotation.y = lerp(n.head.rotation.y, busy ? 0 : look, Math.min(1, dt * 4));
    n.head.rotation.x = lerp(n.head.rotation.x, busy ? 0.35 : n.talk > 0 ? Math.sin(n.t * 5) * 0.08 : -0.05, Math.min(1, dt * 4));
    n.r.chest.scale.y = 1 + Math.sin(n.t * 1.7) * 0.025; // breathing
    const r = n.r, gest = n.talk > 0 ? Math.sin(n.t * 3.1) : 0;
    r.arms[0].rotation.x = -0.05 - (n.talk > 0 ? 0.6 + gest * 0.25 : 0); r.fore[0].rotation.x = -0.2 - (n.talk > 0 ? 0.7 : 0);
    if (n === elder) { elder.staff.rotation.x = -(r.arms[1].rotation.x + r.fore[1].rotation.x); elder.staff.rotation.z = -r.arms[1].rotation.z; }
    if (n === smith) {
      if (busy) { // raise slowly, strike fast
        const p = (n.t % 1.15) / 1.15, up = p < 0.78 ? smoothstep(0, 0.78, p) : 1 - (p - 0.78) / 0.22;
        r.arms[1].rotation.x = -0.5 - up * 1.9; r.fore[1].rotation.x = -0.5 - up * 0.5; smith.hammer.rotation.x = 0.4 - up * 0.6;
        if (n.lastP > 0.9 && p < 0.1 && d < 20) { burst(anvil.position.clone().add(_v2.set(0, 0.32, 0)), 0xffb040, 10, 2.5, 0.6); tone(900 + Math.random() * 200, 0.07, 'square', 0.04 * (1 - d / 20)); }
        n.lastP = p;
      } else { r.arms[1].rotation.x = lerp(r.arms[1].rotation.x, -0.15, dt * 4); r.fore[1].rotation.x = lerp(r.fore[1].rotation.x, -0.9, dt * 4); smith.hammer.rotation.x = 0.9; }
    }
  }
}

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
function restSword() { sword.position.set(0.24, -0.24, -0.42); sword.rotation.set(0.7, 0.15, -0.25); } // low enough to stay out of the way, high enough that the glove shows
camera.add(sword); restSword();

// camera-attached panels (VR toast / prompt / hurt flash)
const toastPanel = makePanel(0.9, 0.3, 900, 300); toastPanel.mesh.position.set(0, 0.12, -1.25); toastPanel.mesh.visible = false; camera.add(toastPanel.mesh);
const promptPanel = makePanel(0.7, 0.09, 700, 90); promptPanel.mesh.position.set(0, -0.32, -1.2); promptPanel.mesh.visible = false; camera.add(promptPanel.mesh);
const hurtFlash = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ color: 0xff0000, transparent: true, opacity: 0, depthTest: false, fog: false }));
hurtFlash.position.z = -0.12; hurtFlash.renderOrder = 1000; hurtFlash.visible = false; camera.add(hurtFlash);
const wrist = makePanel(0.17, 0.12, 510, 360); wrist.mesh.position.set(0.055, 0.13, 0.02); wrist.mesh.rotation.set(0, Math.PI / 2, 0); // inside of the left wrist (+Y runs toward the arm)

// ---------------------------------------------------------------- XR controllers
const hands = { left: null, right: null };
let inVR = false;
for (let i = 0; i < 2; i++) {
  const grip = renderer.xr.getControllerGrip(i); dolly.add(grip);
  grip.addEventListener('connected', e => {
    const src = e.data; if (!src || !src.handedness || src.handedness === 'none') return;
    const side = src.handedness, isHand = !!src.hand;
    hands[side] = { grip, src, prev: [], isHand };
    const model = playerHands[side]; grip.add(model.g); model.g.position.set(0, 0, 0); model.g.rotation.set(0, 0, 0); model.g.visible = !isHand; // tracked hands draw their own joints
    if (side === 'right') { if (swordInHand) holdSword(); }
    else { grip.add(shield); grip.add(wrist.mesh); }
  });
  grip.addEventListener('disconnected', () => { for (const k of ['left', 'right']) if (hands[k] && hands[k].grip === grip) { resetHandState(k); hands[k] = null; } });
}
renderer.xr.addEventListener('sessionstart', () => {
  inVR = true; dolly.rotation.y = yaw; camera.rotation.set(0, 0, 0); promptText = null; startGame();
});
renderer.xr.addEventListener('sessionend', () => {
  // keep the player where their head was (room-scale offset), not where the dolly origin is
  _v1.set(camera.position.x, 0, camera.position.z).applyQuaternion(dolly.quaternion); dolly.position.x += _v1.x; dolly.position.z += _v1.z;
  inVR = false; yaw = dolly.rotation.y; dolly.rotation.y = 0; pitch = 0; camera.position.set(0, 1.6, 0);
  // WebXR overwrote the camera projection with the headset's; restore the flat-screen one
  camera.fov = 72; camera.zoom = 1; camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  $('hud').style.display = running ? 'block' : 'none'; promptText = null;
  for (const side of ['left', 'right']) resetHandState(side);
  swordInHand = true; scabbard.visible = false;
  camera.add(sword); restSword(); attachDesktopHand(); shield.removeFromParent(); wrist.mesh.removeFromParent();
  hands.left = hands.right = null;
});
function pulse(hand, intensity, ms) { try { hands[hand]?.src.gamepad?.hapticActuators?.[0]?.pulse(intensity, ms); } catch (e) { } }
const btnEdge = (hand, i) => { const h = hands[hand]; const gp = h?.src.gamepad; if (!gp) return false; const now = !!gp.buttons[i]?.pressed; const was = !!h.prev[i]; h.prev[i] = now; return now && !was; };

// ---------------------------------------------------------------- player hands
// WebXR grip space: origin in the curled fingers, -Z along a held rod toward the thumb, the back of the right
// hand faces +X (left hand -X), +Y runs toward the arm. Fingers are 3-segment chains that curl around the rod.
// With controllers, finger curl comes from the analog grip/trigger and the capacitive touch sensors.
const HAND_MAT = new THREE.MeshLambertMaterial({ color: 0x8a6646 }); // leather glove
const FINGER_DEF = [ // index nearest the thumb
  { z: -0.027, len: [0.042, 0.026, 0.02] }, { z: -0.008, len: [0.046, 0.029, 0.022] },
  { z: 0.011, len: [0.043, 0.027, 0.021] }, { z: 0.028, len: [0.034, 0.021, 0.018] },
];
const _segGeo = {};
const segGeo = (L, w = 0.019) => { const k = L + ':' + w; if (!_segGeo[k]) { const g = new THREE.BoxGeometry(w, L, w * 0.9); g.translate(0, -L / 2, 0); _segGeo[k] = g; } return _segGeo[k]; };
function makePlayerHand(side) {
  const ps = side === 'left' ? 1 : -1; // the palm faces +ps X
  const g = new THREE.Group();
  _hm(new THREE.BoxGeometry(0.026, 0.088, 0.08), HAND_MAT, g, -ps * 0.036, 0.044, 0);   // back of the hand / palm
  _hm(new THREE.CylinderGeometry(0.036, 0.04, 0.06, 8), HAND_MAT, g, -ps * 0.03, 0.115, 0.004); // glove cuff
  const chain = (root, lens, w) => { const segs = []; let parent = root; for (const L of lens) { const p = new THREE.Group(); _hm(segGeo(L, w), HAND_MAT, p); parent.add(p); segs.push(p); p.userData.next = L; parent = p; } segs.forEach((s, i) => { if (i) s.position.y = -lens[i - 1]; }); return segs; };
  const fingers = FINGER_DEF.map(f => { const root = new THREE.Group(); root.position.set(-ps * 0.036, 0.002, f.z); g.add(root); return chain(root, f.len, 0.019); });
  const thumbRoot = new THREE.Group(); thumbRoot.position.set(-ps * 0.024, 0.04, -0.038); thumbRoot.rotation.set(1.25, 0, ps * 0.35); g.add(thumbRoot);
  const thumb = chain(thumbRoot, [0.04, 0.03, 0.024], 0.021);
  return { g, ps, fingers, thumb, curl: [0.2, 0.2, 0.2, 0.2, 0.2] };
}
const playerHands = { left: makePlayerHand('left'), right: makePlayerHand('right') };
// curls: [thumb, index, middle, ring, pinky], 0 = open, 1 = fist
function poseHand(model, target, dt) {
  const k = 1 - Math.exp(-dt * 22);
  for (let i = 0; i < 5; i++) model.curl[i] = lerp(model.curl[i], target[i], k);
  model.fingers.forEach((segs, f) => { const c = model.curl[f + 1]; segs[0].rotation.z = model.ps * c * 1.35; segs[1].rotation.z = model.ps * c * 1.55; segs[2].rotation.z = model.ps * c * 1.1; });
  const t = model.curl[0]; model.thumb[0].rotation.z = model.ps * t * 0.55; model.thumb[1].rotation.z = model.ps * t * 0.7; model.thumb[2].rotation.z = model.ps * t * 0.5;
}

// tracked hands (Quest hand tracking): 25 joints per hand, drawn as knuckles + bones; fist = grab, pinch = talk / open
const JOINTS = ['wrist', 'thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip'];
for (const f of ['index', 'middle', 'ring', 'pinky']) JOINTS.push(`${f}-finger-metacarpal`, `${f}-finger-phalanx-proximal`, `${f}-finger-phalanx-intermediate`, `${f}-finger-phalanx-distal`, `${f}-finger-tip`);
const BONES = []; // consecutive joints in each finger, plus the wrist to every metacarpal
{ const chains = [[0, 1, 2, 3, 4]]; let i = 5; for (let f = 0; f < 4; f++) { chains.push([0, i, i + 1, i + 2, i + 3, i + 4]); i += 5; } for (const ch of chains) for (let j = 0; j < ch.length - 1; j++) BONES.push([ch[j], ch[j + 1]]); }
const trackedHands = [];
const geoBone = new THREE.CylinderGeometry(1, 1, 1, 6), geoKnuckle = new THREE.SphereGeometry(1, 8, 6);
for (let i = 0; i < 2; i++) {
  const hand = renderer.xr.getHand(i); dolly.add(hand);
  const th = { hand, side: null, knuckles: null, bones: null, fist: false, pinch: false };
  hand.addEventListener('connected', e => { th.side = e.data?.handedness || null; });
  hand.addEventListener('disconnected', () => { th.side = null; });
  trackedHands.push(th);
}
const _ja = new THREE.Vector3(), _jb = new THREE.Vector3(), _UP = new THREE.Vector3(0, 1, 0), _hs = new THREE.Vector3(), _hq = new THREE.Quaternion(), _hm4 = new THREE.Matrix4();
const TIPS = ['index-finger-tip', 'middle-finger-tip', 'ring-finger-tip', 'pinky-finger-tip'];
function updateTrackedHands() {
  for (const th of trackedHands) {
    const J = th.hand.joints; if (!th.side || !J || !J['wrist']) { th.hand.visible = false; continue; }
    th.hand.visible = true;
    if (!th.knuckles) { // two instanced meshes per hand (joints + bones) instead of 49 separate meshes
      th.knuckles = new THREE.InstancedMesh(geoKnuckle, HAND_MAT, JOINTS.length); th.bones = new THREE.InstancedMesh(geoBone, HAND_MAT, BONES.length);
      th.knuckles.frustumCulled = th.bones.frustumCulled = false; th.hand.add(th.knuckles, th.bones);
    }
    for (let i = 0; i < JOINTS.length; i++) {
      const j = J[JOINTS[i]]; const r = j ? Math.max(0.006, (j.jointRadius || 0.008) * 1.05) : 0;
      _hs.set(r, r, r); _hm4.compose(j ? j.position : _ja.set(0, 0, 0), _hq.identity(), _hs); th.knuckles.setMatrixAt(i, _hm4);
    }
    for (let i = 0; i < BONES.length; i++) {
      const ja = J[JOINTS[BONES[i][0]]], jb = J[JOINTS[BONES[i][1]]];
      if (!ja || !jb) { _hm4.makeScale(0, 0, 0); th.bones.setMatrixAt(i, _hm4); continue; }
      _ja.copy(ja.position); _jb.copy(jb.position); const L = _ja.distanceTo(_jb);
      const r = L > 1e-4 ? Math.max(0.005, Math.min(ja.jointRadius || 0.008, jb.jointRadius || 0.008) * 0.85) : 0;
      _hq.setFromUnitVectors(_UP, _jb.sub(_ja).normalize()); _ja.add(jb.position).multiplyScalar(0.5); _hs.set(r, L, r);
      th.bones.setMatrixAt(i, _hm4.compose(_ja, _hq, _hs));
    }
    th.knuckles.instanceMatrix.needsUpdate = true; th.bones.instanceMatrix.needsUpdate = true;
    // open/closed hand from fingertip-to-wrist distance, pinch from thumb tip to index tip (with hysteresis)
    const w = J['wrist'].position; let avg = 0;
    for (const t of TIPS) avg += J[t].position.distanceTo(w) / 4;
    th.fist = th.fist ? avg < 0.13 : avg < 0.1;
    const pd = J['thumb-tip'].position.distanceTo(J['index-finger-tip'].position);
    th.pinch = th.pinch ? pd < 0.035 : pd < 0.018;
  }
}
const trackedHand = side => trackedHands.find(t => t.side === side && t.hand.visible);

// ---------------------------------------------------------------- sword scabbard (left hip) and grabbing
let swordInHand = true;
const scabbard = new THREE.Group(); scene.add(scabbard); scabbard.visible = false;
{
  _hm(new THREE.BoxGeometry(0.075, 0.03, 0.86), M.dark, scabbard, 0, 0, -0.5); // sheath
  _hm(new THREE.BoxGeometry(0.09, 0.04, 0.05), M.gold, scabbard, 0, 0, -0.08); _hm(new THREE.BoxGeometry(0.08, 0.035, 0.04), M.gold, scabbard, 0, 0, -0.92);
}
function holdSword() { const r = hands.right; if (!r) return; r.grip.add(sword); sword.position.set(0, 0, 0); sword.rotation.set(-0.35, 0, 0); swordInHand = true; }
function sheatheSword() { scabbard.add(sword); sword.position.set(0, 0, 0.02); sword.rotation.set(0, 0, 0); swordInHand = false; sfx.block(); }
const bodyPoint = (down, fwd, side, out) => { const h = headPos(), f = forward2D(); return out.set(h.x + f.x * fwd - f.z * side, h.y - down, h.z + f.z * fwd + f.x * side); };
const _sheathPt = new THREE.Vector3(), _pocketPt = new THREE.Vector3(), _mouthPt = new THREE.Vector3();
function updateScabbard() {
  scabbard.visible = inVR; if (!inVR) return;
  bodyPoint(0.78, 0.02, -0.2, _sheathPt); scabbard.position.copy(_sheathPt);
  const f = forward2D(); scabbard.rotation.set(0, Math.atan2(-f.x, -f.z), 0, 'YXZ'); scabbard.rotateX(-1.25); // hilt up, blade down and back
}

// throwable stones scattered around the valley
// All stones are one InstancedMesh (one draw call). Each stone keeps a detached Object3D (s.m) for its transform.
const stones = [];
const STONE_BASE = new THREE.Color(0x5a5560), STONE_HI = new THREE.Color(0xb0a68c);
let stoneMesh = null;
{
  const rnd = mulberry32(4242), geo = new THREE.IcosahedronGeometry(0.06, 0);
  for (let i = 0; i < 46; i++) {
    const a = rnd() * 6.283, d = i < 18 ? 6 + rnd() * 20 : 30 + rnd() * 160, x = Math.cos(a) * d, z = Math.sin(a) * d;
    if (heightAt(x, z) < 0.5) continue;
    const m = new THREE.Object3D(); m.scale.set(0.8 + rnd() * 0.5, 0.7 + rnd() * 0.4, 0.8 + rnd() * 0.5); m.rotation.set(rnd() * 6, rnd() * 6, 0);
    stones.push({ m, idx: stones.length, p: new THREE.Vector3(x, heightAt(x, z) + 0.05, z), v: new THREE.Vector3(), r: 0.06, rest: true, held: null, hitCd: 0 });
  }
  stoneMesh = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true }), stones.length);
  stoneMesh.frustumCulled = false; scene.add(stoneMesh);
  for (const st of stones) { syncStone(st); stoneMesh.setColorAt(st.idx, STONE_BASE); }
}
function syncStone(st) { st.m.position.copy(st.p); st.m.updateMatrix(); stoneMesh.setMatrixAt(st.idx, st.m.matrix); stoneMesh.instanceMatrix.needsUpdate = true; }
function highlightStone(st, on) { stoneMesh.setColorAt(st.idx, on ? STONE_HI : STONE_BASE); stoneMesh.instanceColor.needsUpdate = true; }
function updateStones(dt) {
  for (const s of stones) {
    s.hitCd -= dt;
    if (s.held || s.rest) continue;
    s.v.y -= 9.8 * dt; s.p.addScaledVector(s.v, dt);
    const gy = heightAt(s.p.x, s.p.z) + s.r * 0.8;
    if (s.p.y < gy) { s.p.y = gy; if (s.v.y < -1.5) tone(180 + Math.random() * 60, 0.05, 'triangle', 0.05); s.v.y = -s.v.y * 0.3; s.v.x *= 0.55; s.v.z *= 0.55; if (s.v.length() < 0.35) { s.rest = true; s.v.set(0, 0, 0); } }
    const sp = s.v.length();
    if (sp > 4 && s.hitCd <= 0) for (const e of enemies) {
      if (e.dead) continue; const by = e.g.position.y;
      if (Math.hypot(s.p.x - e.x, s.p.z - e.z) < e.rad + 0.08 && s.p.y > by && s.p.y < by + 1.85 * e.T.scale) {
        const h = headPos(); hitEnemy(e, clamp(sp / 12, 0.3, 1), h.x, h.z, s.v.clone().multiplyScalar(0.6), 8 + 2 * S.level); s.v.multiplyScalar(-0.25); s.hitCd = 0.3; break;
      }
    }
    if (sp > 3) for (const rd of ragdolls) for (const pt of rd.P) if (pt.p.distanceTo(s.p) < pt.r + 0.08) { nudgeRagdoll(rd, s.v, 0.3); s.v.multiplyScalar(0.5); break; }
    s.m.rotation.x += sp * dt * 2; syncStone(s);
  }
}
function makePotionMesh() { const m = new THREE.Mesh(potionGeo, potionMat); const neck = new THREE.Mesh(potionNeckGeo, M.lamp); neck.position.y = 0.18; m.add(neck); m.scale.setScalar(0.7); return m; }

// grab state per hand: null or { kind: 'stone'|'rag'|'potion', ... }
const grab = { left: null, right: null }, gripHeld = { left: false, right: false }, gripToggle = { left: false, right: false }, hover = { left: null, right: null };
const handHist = { left: [], right: [] };
const _hv = new THREE.Vector3(), _q1 = new THREE.Quaternion();
function handVel(side, out) { // average over the last ~80 ms, with a little throw assist
  const H = handHist[side]; out.set(0, 0, 0); if (H.length < 2) return out;
  const a = H[H.length - 1]; let b = H[0]; for (let i = H.length - 2; i >= 0; i--) { b = H[i]; if (a.t - b.t > 0.08) break; }
  const dtt = a.t - b.t; if (dtt > 1e-3) out.subVectors(a.p, b.p).divideScalar(dtt).multiplyScalar(1.25);
  return out.clampLength(0, 25);
}
// what this hand could grab right now (nearest first)
function grabCandidate(side, p) {
  let best = null, bd = 1e9; const consider = (d, c) => { if (d < bd) { bd = d; best = c; } };
  for (const s of stones) if (!s.held && s.p.distanceToSquared(p) < 0.04) { const d = s.p.distanceTo(p) - s.r; if (d < 0.12) consider(d, { kind: 'stone', s }); }
  for (const pk of pickups) { const d = pk.m.position.distanceTo(p) - 0.12; if (d < 0.12) consider(d, { kind: 'pickup', pk }); }
  for (const rd of ragdolls) {
    if (rd.life >= RAG_LIFE - 1.3 || rd.P[2].p.distanceToSquared(p) > 2.5 * rd.s * rd.s) continue; // whole body out of reach
    for (let i = 0; i < rd.P.length; i++) { const pt = rd.P[i], d = pt.p.distanceTo(p) - pt.r; if (d < 0.1 && d + 0.02 < bd) consider(d + 0.02, { kind: 'rag', rd, i }); }
  }
  for (const c of chests) if (!c.opened) { const d = _v3.set(c.x, c.g.position.y + 0.55, c.z).distanceTo(p) - 0.35; if (d < 0.12) consider(d + 0.03, { kind: 'chest', c }); }
  if (S.potions > 0 && bodyPoint(0.36, 0.12, 0, _pocketPt).distanceTo(p) < 0.2) consider(0.15, { kind: 'pocket' });
  return best;
}
function tryGrab(side, p) {
  const c = grabCandidate(side, p); if (!c) return false;
  const other = side === 'left' ? 'right' : 'left';
  if (c.kind === 'stone') { if (grab[other]?.s === c.s) releaseGrab(other, true); c.s.held = side; c.s.rest = false; grab[side] = { kind: 'stone', s: c.s }; }
  else if (c.kind === 'rag') { if (grab[other]?.rd === c.rd && grab[other].i === c.i) releaseGrab(other, true); c.rd.pins = c.rd.pins || {}; c.rd.pins[side] = { i: c.i, t: c.rd.P[c.i].p.clone() }; grab[side] = { kind: 'rag', rd: c.rd, i: c.i }; }
  else if (c.kind === 'chest') { openChest(c.c); pulse(side, 0.6, 60); return true; }
  else if (c.kind === 'pocket') { S.potions--; const m = makePotionMesh(); scene.add(m); grab[side] = { kind: 'potion', m }; sfx.pickup(); }
  else if (c.kind === 'pickup') { scene.remove(c.pk.m); pickups.splice(pickups.indexOf(c.pk), 1); const m = makePotionMesh(); scene.add(m); grab[side] = { kind: 'potion', m }; sfx.pickup(); }
  pulse(side, 0.5, 40); return true;
}
function resetHandState(side) { // drop whatever the hand holds and forget its hover/grip/velocity history
  releaseGrab(side, true);
  if (stones.includes(hover[side])) highlightStone(hover[side], false);
  hover[side] = null; gripHeld[side] = false; gripToggle[side] = false; handHist[side].length = 0;
}
function releaseGrab(side, quiet) {
  const gb = grab[side]; if (!gb) return; grab[side] = null;
  const v = handVel(side, _hv);
  if (gb.kind === 'stone') { gb.s.held = null; gb.s.rest = false; gb.s.v.copy(quiet ? _v3.set(0, 0, 0) : v); }
  else if (gb.kind === 'rag') {
    const rd = gb.rd; if (rd.pins) delete rd.pins[side];
    if (!quiet && ragdolls.includes(rd)) { for (const pt of rd.P) pt.o.addScaledVector(v, -RAG_STEP * 0.35); rd.P[gb.i].o.copy(rd.P[gb.i].p).addScaledVector(v, -RAG_STEP); }
  }
  else if (gb.kind === 'potion') { scene.remove(gb.m); S.potions++; if (!quiet) { sfx.coin(); toast('Potion stowed.', 1.2); } } // let go anywhere: it goes back in your pack
}
function updateHands(dt) {
  updateTrackedHands();
  if (!inVR) return;
  updateScabbard();
  const now = performance.now() / 1000;
  for (const side of ['left', 'right']) {
    const h = hands[side]; if (!h) continue;
    const H = handHist[side]; const ent = H.length >= 10 ? H.shift() : { p: new THREE.Vector3(), t: 0 };
    h.grip.getWorldPosition(ent.p); ent.t = now; H.push(ent); const p = ent.p;
    // grip input: analog squeeze on controllers, a closed fist with tracked hands
    const th = h.isHand ? trackedHand(side) : null, gp = h.src.gamepad;
    const squeeze = th ? (th.fist ? 1 : 0) : (gp?.buttons[1]?.value ?? 0);
    const was = gripHeld[side]; gripHeld[side] = was ? squeeze > 0.35 : squeeze > 0.6;
    const pressEdge = gripHeld[side] && !was, releaseEdge = !gripHeld[side] && was;
    if (th) { if (th.pinch && !th.pinchWas && side === 'right') interactQueued = true; th.pinchWas = th.pinch; }
    const toggleMode = GFX.grip === 'toggle';
    if (side === 'right' && swordInHand) { // sword is sticky: grip near the left hip puts it away
      if (pressEdge && p.distanceTo(_sheathPt) < 0.3) { sheatheSword(); pulse('right', 0.7, 50); }
    } else if (grab[side]) {
      if ((toggleMode && pressEdge) || (!toggleMode && releaseEdge)) releaseGrab(side, false);
    } else if (pressEdge) {
      if (!tryGrab(side, p) && side === 'right') { holdSword(); sfx.swing(); pulse('right', 0.7, 50); } // nothing to grab: draw the sword
    }
    // hover feedback
    const cand = (!grab[side] && !(side === 'right' && swordInHand)) ? grabCandidate(side, p) : null;
    const key = cand ? (cand.s || cand.pk || cand.c || (cand.rd ? cand.rd.P[cand.i] : 'pocket')) : null;
    if (key !== hover[side]) { if (stones.includes(hover[side])) highlightStone(hover[side], false); if (key) pulse(side, 0.15, 15); hover[side] = key; if (cand?.kind === 'stone') highlightStone(cand.s, true); }
    // carry the held thing
    const gb = grab[side];
    if (gb?.kind === 'stone') { gb.s.p.copy(p); syncStone(gb.s); }
    else if (gb?.kind === 'rag') { if (!ragdolls.includes(gb.rd)) grab[side] = null; else { gb.rd.pins[side].t.copy(p); gb.rd.life = Math.min(gb.rd.life, 1); } }
    else if (gb?.kind === 'potion') {
      gb.m.position.copy(p); gb.m.quaternion.copy(h.grip.getWorldQuaternion(_q1)); gb.m.rotateX(-Math.PI / 2);
      if (p.distanceTo(bodyPoint(0.08, 0.07, 0, _mouthPt)) < 0.15) { // drink by bringing it to your mouth
        if (S.hp >= maxHp()) { if (!gb.warned) { toast('You are already at full health.', 1.5); gb.warned = true; } }
        else { scene.remove(gb.m); grab[side] = null; S.hp = Math.min(maxHp(), S.hp + 55); sfx.drink(); burst(p, 0xff5577, 16, 1.2, 1); pulse(side, 0.8, 120); }
      }
    }
    // finger pose
    if (!h.isHand) {
      const trig = gp?.buttons[0]?.value ?? 0, trigTouch = gp?.buttons[0]?.touched ? 0.25 : 0;
      const thumbTouch = [3, 4, 5, 6].some(i => gp?.buttons[i]?.touched) ? 0.85 : 0.15;
      const holding = !!grab[side] || (side === 'right' && swordInHand);
      const sq = holding ? Math.max(0.85, squeeze) : squeeze, ix = holding ? Math.max(0.75, trig) : Math.max(trig, trigTouch);
      poseHand(playerHands[side], [holding ? 0.8 : thumbTouch, ix, sq, sq, sq], dt);
    }
  }
}

// ---------------------------------------------------------------- player helpers
const _head = new THREE.Vector3();
function headPos() { camera.getWorldPosition(_head); return _head; }
function forward2D() { camera.getWorldDirection(_v1); _v1.y = 0; if (_v1.lengthSq() < 1e-6) _v1.set(0, 0, -1); return _v1.normalize(); }
function placePlayer(x, z) {
  handHist.left.length = handHist.right.length = 0; airborne = false; jumpVy = 0; // a teleport is not a throw (or a jump)
  const h = headPos(); dolly.position.x += x - h.x; dolly.position.z += z - h.z; dolly.position.y = Math.max(heightAt(x, z), -1.3);
}
function movePlayer(dx, dz) {
  const h = headPos(); let nx = h.x + dx, nz = h.z + dz;
  if (heightAt(nx, nz) < -0.6) { // too deep: try sliding along the shore on one axis
    if (heightAt(nx, h.z) >= -0.6) nz = h.z; else if (heightAt(h.x, nz) >= -0.6) nx = h.x; else return;
  }
  const r = Math.hypot(nx, nz); if (r > PLAY_RADIUS) { nx *= PLAY_RADIUS / r; nz *= PLAY_RADIUS / r; }
  [nx, nz] = collide(nx, nz, 0.35);
  dolly.position.x += nx - h.x; dolly.position.z += nz - h.z;
}

// ---------------------------------------------------------------- UI: toast, prompt, wrist, desktop HUD
const $ = id => document.getElementById(id);
let toastT = 0;
// Messages queue up instead of overwriting each other; each stays up for a minimum time before the next replaces it.
let toastQ = [], toastShownAt = -99, toastMin = 0, toastMsg = '';
function toast(msg, secs = 4, now = false) { // now: a direct reply to the player's action shows at once
  if (toastT > 0 && !now) {
    if (msg === toastMsg || toastQ.some(q => q[0] === msg)) return;
    const same = toastQ.findIndex(q => q[0].slice(0, 14) === msg.slice(0, 14)); // e.g. several level-ups: keep only the latest
    if (same >= 0) toastQ[same] = [msg, secs]; else { if (toastQ.length >= 4) toastQ.shift(); toastQ.push([msg, secs]); }
    const shown = time - toastShownAt; toastT = Math.min(toastT, Math.max(0, toastMin - shown) + 0.35); return;
  }
  showToast(msg, secs);
}
function showToast(msg, secs) {
  toastMsg = msg; toastShownAt = time; toastMin = clamp(secs * 0.6, 2, 5);
  toastT = secs; $('toast').textContent = msg; $('toast').style.opacity = 1;
  const { ctx, canvas } = toastPanel; ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'rgba(20,10,5,0.78)'; rr(ctx, 4, 4, canvas.width - 8, canvas.height - 8, 26); ctx.fill();
  ctx.strokeStyle = 'rgba(255,180,90,0.6)'; ctx.lineWidth = 4; ctx.stroke();
  ctx.fillStyle = '#ffe9c4'; ctx.font = '38px Arial,Arimo,sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const lines = wrap(ctx, msg, canvas.width - 70).slice(0, 5); const lh = 46;
  lines.forEach((l, i) => ctx.fillText(l, canvas.width / 2, canvas.height / 2 + (i - (lines.length - 1) / 2) * lh));
  toastPanel.refresh(); toastPanel.mesh.visible = inVR; toastPanel.mat.opacity = 1;
}
let promptText = '';
function setPrompt(text) {
  if (text === promptText) return; promptText = text;
  $('prompt').style.display = text && !inVR ? 'block' : 'none'; $('prompt').textContent = text ? '[E] ' + text : '';
  const { ctx, canvas } = promptPanel; ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (text) { ctx.fillStyle = 'rgba(0,0,0,0.6)'; rr(ctx, 0, 0, canvas.width, canvas.height, 20); ctx.fill(); ctx.fillStyle = '#fff'; ctx.font = 'bold 40px Arial,Arimo,sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText((hands.right?.isHand ? 'Pinch: ' : '(A) ') + text, canvas.width / 2, canvas.height / 2); }
  promptPanel.refresh(); promptPanel.mesh.visible = !!text && inVR;
}
function questInfo() {
  const c = S.crystals.filter(Boolean).length;
  switch (S.stage) {
    case 0: return ['A Village in Shadow', 'Speak with Elder Maren by the campfire.'];
    case 1: return ['Cull the Gloom', `Defeat creatures of the Gloom in the wilds (${S.qKills}/5).`];
    case 2: return ['Cull the Gloom', 'Return to Elder Maren.'];
    case 3: return ['The Sun Crystals', `Follow the golden beams and find the Sun Crystals (${c}/3).`];
    case 4: return ['The Sun Crystals', 'Return to Elder Maren.'];
    case 5: return ['The Hollow King', 'Defeat the Hollow King at the Ashen Tower (purple beam, northeast).'];
    case 6: return ['The Hollow King', 'Return to Elder Maren.'];
    default: return ['Free Roam', S.chests.length >= chests.length ? 'Emberwild is saved and every treasure found. Hunt the remaining Gloom.' : `Emberwild is saved. Explore, find chests (${S.chests.length}/${chests.length}), hunt the remaining Gloom.`];
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
let wristKey = '';
function drawWrist() {
  // repaint + re-upload only when something shown actually changed (fps is shown in steps of 5)
  const od = objectiveDir(), [title, desc] = questInfo();
  const key = [S.level, S.gold, S.potions, Math.ceil(S.hp), maxHp(), Math.round(S.xp / xpNeed() * 100), title, desc, od ? od.name + od.dist + Math.round(od.ang * 8) : '', Math.round(fpsNow / 5)].join('|');
  if (key === wristKey) return; wristKey = key;
  const { ctx, canvas } = wrist, W = canvas.width, H = canvas.height; ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(14,10,24,0.88)'; rr(ctx, 0, 0, W, H, 30); ctx.fill(); ctx.strokeStyle = 'rgba(255,180,90,.6)'; ctx.lineWidth = 4; ctx.stroke();
  ctx.fillStyle = '#ffcf8a'; ctx.font = 'bold 30px Arial,Arimo,sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.fillText(`Lv ${S.level}`, 22, 16); ctx.fillStyle = '#fff'; ctx.font = '26px Arial,Arimo,sans-serif'; ctx.fillText(`Gold ${S.gold}   Potions ${S.potions}`, 140, 20);
  ctx.fillStyle = '#300'; rr(ctx, 22, 60, W - 44, 30, 15); ctx.fill(); ctx.fillStyle = '#e53935'; rr(ctx, 22, 60, (W - 44) * clamp(S.hp / maxHp(), 0, 1), 30, 15); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.font = 'bold 22px Arial,Arimo,sans-serif'; ctx.textAlign = 'center'; ctx.fillText(`${Math.ceil(S.hp)} / ${maxHp()}`, W / 2, 63);
  ctx.fillStyle = '#332200'; rr(ctx, 22, 98, W - 44, 10, 5); ctx.fill(); ctx.fillStyle = '#ffd54f'; rr(ctx, 22, 98, (W - 44) * clamp(S.xp / xpNeed(), 0, 1), 10, 5); ctx.fill();
  ctx.textAlign = 'left'; ctx.fillStyle = '#ffcf8a'; ctx.font = 'bold 26px Arial,Arimo,sans-serif'; ctx.fillText(title, 22, 122);
  ctx.fillStyle = '#eee'; ctx.font = '23px Arial,Arimo,sans-serif'; wrap(ctx, desc, W - 44).slice(0, 3).forEach((l, i) => ctx.fillText(l, 22, 156 + i * 28));
  if (od) {
    ctx.save(); ctx.translate(60, 300); ctx.rotate(od.ang); ctx.fillStyle = '#ffd54f'; ctx.beginPath(); ctx.moveTo(0, -30); ctx.lineTo(20, 22); ctx.lineTo(0, 10); ctx.lineTo(-20, 22); ctx.closePath(); ctx.fill(); ctx.restore();
    ctx.fillStyle = '#fff'; ctx.font = '25px Arial,Arimo,sans-serif'; ctx.fillText(`${od.name}  ${od.dist} m`, 100, 287);
  }
  ctx.textAlign = 'right'; ctx.fillStyle = '#9fdcaa'; ctx.font = '19px Arial,Arimo,sans-serif'; ctx.fillText(`${Math.round(fpsNow / 5) * 5} fps`, W - 20, 332);
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
  if (S.potions <= 0) { toast('No potions left. Find them on fallen foes and in chests.', 2.5); return; }
  if (S.hp >= maxHp()) { toast('You are already at full health.', 2); return; }
  S.potions--; S.hp = Math.min(maxHp(), S.hp + 55); sfx.drink(); burst(headPos().clone().add(_v2.set(0, -0.6, 0)), 0xff5577, 20, 1.5, 1.5);
}

// ---------------------------------------------------------------- enemies
const ENEMY_TYPES = {
  gloom: { name: 'Gloomling', hp: 30, dmg: 7, speed: 2.3, xp: 14, gold: [2, 6], color: 0x4b2a6b, scale: 0.8, chestW: 0.85, hunch: 0.45 },
  thorn: { name: 'Thornback', hp: 80, dmg: 13, speed: 1.9, xp: 32, gold: [6, 14], color: 0x56502a, scale: 1.2, chestW: 1.4, hunch: 0.25 },
  king: { name: 'Hollow King', hp: 520, dmg: 22, speed: 2.7, xp: 300, gold: [150, 150], color: 0x1c1028, scale: 1.75, chestW: 1.2, hunch: 0.08, boss: true },
};
const matEye = new THREE.MeshBasicMaterial({ color: 0xffd23a }), matEyeBoss = new THREE.MeshBasicMaterial({ color: 0xff3020 });
const ENEMY_LEGS = { gloom: new THREE.MeshLambertMaterial({ color: 0x241a28, flatShading: true }), thorn: new THREE.MeshLambertMaterial({ color: 0x3d3320, flatShading: true }), king: new THREE.MeshLambertMaterial({ color: 0x15101c, flatShading: true }) };
const barGeo = new THREE.PlaneGeometry(1, 0.09); barGeo.translate(0.5, 0, 0);
const barBg = new THREE.MeshBasicMaterial({ color: 0x220000, fog: false }), barFg = new THREE.MeshBasicMaterial({ color: 0xff4040, fog: false });
const enemies = []; const LOD_FAR = 30;
function spawnEnemy(key, x, z) {
  const T = ENEMY_TYPES[key];
  const mat = new THREE.MeshLambertMaterial({ color: T.color, flatShading: true, emissive: 0x000000 });
  const r = makeHumanoid({ skin: mat, top: mat, legs: ENEMY_LEGS[key], eye: T.boss ? matEyeBoss : matEye, chestW: T.chestW, hunch: T.hunch });
  const g = r.g;
  if (key === 'gloom') for (const sx of [-1, 1]) { const ear = _hm(HG.spike, mat, r.skull, sx * 0.11, 0.04, -0.01); ear.rotation.z = -sx * 1.2; ear.scale.set(0.8, 0.9, 0.8); }
  if (key === 'thorn') { // bark spikes down the back and on the shoulders
    for (let i = 0; i < 6; i++) { const s = _hm(HG.spike, M.wood, r.upper, ((i % 3) - 1) * 0.12, 0.22 + Math.floor(i / 3) * 0.24, -0.11); s.rotation.x = -Math.PI / 2 - 0.3; }
    for (const a of r.arms) _hm(HG.spike, M.wood, a, 0, 0.08, 0);
  }
  if (key === 'king') { // spiked crown and gold pauldrons
    for (let i = 0; i < 7; i++) { const a = i / 7 * 6.283, s = _hm(HG.spike, M.gold, r.skull, Math.cos(a) * 0.09, 0.1, Math.sin(a) * 0.09); s.rotation.set(Math.sin(a) * 0.3, 0, -Math.cos(a) * 0.3); s.scale.setScalar(0.9); }
    for (const a of r.arms) _hm(HG.joint, M.gold, a, 0, 0.02, 0).scale.set(0.11, 0.08, 0.12);
  }
  const bar = new THREE.Group(), bg = new THREE.Mesh(barGeo, barBg), fg = new THREE.Mesh(barGeo, barFg);
  bg.position.x = -0.5; fg.position.set(-0.5, 0, 0.002); bar.add(bg, fg); bar.position.y = 2.1; bar.visible = false; g.add(bar);
  mergeRig(r, key);
  // far-away version: the whole body in its rest pose baked into one mesh per material (about 3 draw calls instead
  // of 12), shown beyond LOD_FAR where nobody can see the limbs move anyway
  g.updateMatrixWorld(true); const lod = new THREE.Group(); lod.visible = false;
  const byMat = new Map(); for (const pv of [r.upper, ...r.legs]) pv.traverse(o => { if (o.isMesh) { if (!byMat.has(o.material)) byMat.set(o.material, []); byMat.get(o.material).push({ geo: o.geometry, m: o.matrixWorld.clone() }); } });
  let slot = 0; for (const [m, list] of byMat) { const k = 'lod:' + key + ':' + (slot++); if (!_mergeCache.has(k)) _mergeCache.set(k, mergeGeos(list)); lod.add(new THREE.Mesh(_mergeCache.get(k), m)); }
  g.add(lod);
  g.scale.setScalar(T.scale);
  const lv = 1 + 0.14 * (S.level - 1), nightMul = isNight() ? 1.2 : 1;
  const e = { key, T, g, rig: r, lod, far: false, upper: r.upper, mat, bar, fg, hp: T.hp * lv * nightMul, maxHp: T.hp * lv * nightMul, dmg: T.dmg * lv, x, z, vx: 0, vz: 0, atkCd: 1.2, hitCd: 0, flash: 0, lunge: 0, walk: Math.random() * 6, tilt: 0, tiltV: 0, wAng: Math.random() * 6.28, wT: 0, aggro: false, dead: false, rad: 0.4 * T.scale * T.chestW };
  g.position.set(x, heightAt(x, z), z); scene.add(g); enemies.push(e); return e;
}
function enemyCenter(e, out) { return out.set(e.x, e.g.position.y + 1.1 * e.T.scale, e.z); }
// closest distance from a blade segment to the enemy's body (sampled at legs, chest and head height)
function enemyBladeDist(e, a, b) { let m = 1e9; for (const f of [0.5, 1.05, 1.55]) m = Math.min(m, distPointSeg(_ebd.set(e.x, e.g.position.y + f * e.T.scale, e.z), a, b)); return m; }
const _ebd = new THREE.Vector3();
// impulse: world-space velocity (m/s) of the blow, used for knockback, flinch and the death ragdoll
function hitEnemy(e, mult, fromX, fromZ, impulse, base) { // base: damage before mult (defaults to the sword's)
  if (e.dead || e.hitCd > 0) return false;
  let dmg = (base ?? swordDamage()) * mult; const crit = Math.random() < 0.12; if (crit) dmg *= 1.8;
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
  if (S.stage === 1 && !e.T.boss) { S.qKills++; if (S.qKills >= 5) { S.stage = 2; sfx.quest(); toast('Quest updated: The Gloom creatures scatter! Return to Elder Maren.', 4); save(); } }
  if (e.T.boss && S.stage === 5) { S.stage = 6; sfx.quest(); toast('The Hollow King is no more! The Gloom recedes... Return to Elder Maren.', 6); save(); }
}

// ---------------------------------------------------------------- ragdolls (Verlet points + distance constraints)
// Humanoid skeleton points: 0 head, 1 T (chest top), 2 B (pelvis), 3 F (chest front), 4/5 shoulders, 6/7 hips,
// 8/9 elbows, 10/11 hands, 12/13 knees, 14/15 feet. Points 0-7 are tied rigidly (head + torso);
// upper arm, forearm, thigh and shin are single links, with minimum distances acting as joint limits.
const ragdolls = []; const RAG_MAX = 8, RAG_LIFE = 7, RAG_STEP = 1 / 60;
const _rx = new THREE.Vector3(), _ry = new THREE.Vector3(), _rz = new THREE.Vector3(), _rm = new THREE.Matrix4(), DOWN = new THREE.Vector3(0, -1, 0);
function makeRagdoll(e, imp) {
  const r = e.rig; e.g.updateMatrixWorld(true);
  const s = e.T.scale, P = [];
  const W = (o, x = 0, y = 0, z = 0) => o.localToWorld(new THREE.Vector3(x, y, z));
  const add = (v, rad) => P.push({ p: v, o: v.clone(), r: rad * s, gy: 0 });
  add(W(r.skullPt), 0.12); add(W(r.upper, 0, HUM.chestTop, 0), 0.11); add(W(r.upper), 0.12); add(W(r.upper, 0, 0.35, 0.1), 0.05);
  for (const a of r.arms) add(W(a), 0.07);
  for (const l of r.legs) add(W(l), 0.08);
  for (const f of r.fore) add(W(f), 0.055);
  for (const f of r.fore) add(W(f, 0, -HUM.farm, 0), 0.05);
  for (const n of r.shins) add(W(n), 0.065);
  for (const n of r.shins) add(W(n, 0, -HUM.shin, 0), 0.055);
  const C = [], link = (a, b) => C.push([a, b, P[a].p.distanceTo(P[b].p)]);
  for (let a = 0; a < 8; a++) for (let b = a + 1; b < 8; b++) link(a, b);
  const limbIdx = [[4, 8], [5, 9], [8, 10], [9, 11], [6, 12], [7, 13], [12, 14], [13, 15]];
  for (const [a, b] of limbIdx) link(a, b);
  const soft = [], lim = (a, b, f) => soft.push([a, b, P[a].p.distanceTo(P[b].p) * f]);
  lim(4, 10, 0.5); lim(5, 11, 0.5); lim(6, 14, 0.6); lim(7, 15, 0.6);       // elbows and knees can't fold flat
  for (const hnd of [10, 11]) { lim(hnd, 2, 0.5); lim(hnd, 3, 0.4); }        // hands stay outside the torso
  for (const ft of [14, 15]) { lim(ft, 1, 0.6); lim(ft, 3, 0.55); }          // feet stay below the chest
  lim(8, 3, 0.5); lim(9, 3, 0.5); lim(12, 13, 0.6); lim(14, 15, 0.45); lim(10, 11, 0.3); lim(0, 10, 0.4); lim(0, 11, 0.4);
  const k = e.T.boss ? 0.35 : 1;
  for (const pt of P) {
    _rx.copy(imp).multiplyScalar(0.6 * k); _rx.x += (Math.random() - 0.5) * 0.8; _rx.y += 1.8 * k + Math.random() * 0.6; _rx.z += (Math.random() - 0.5) * 0.8;
    pt.o.addScaledVector(_rx, -RAG_STEP);
  }
  P[0].o.addScaledVector(imp, -RAG_STEP * 0.6 * k); P[1].o.addScaledVector(imp, -RAG_STEP * 0.3 * k); // the top gets extra so the body tumbles
  const limbs = [r.arms[0], r.arms[1], r.fore[0], r.fore[1], r.legs[0], r.legs[1], r.shins[0], r.shins[1]];
  for (const m of [...r.fore, ...r.shins, ...r.arms, ...r.legs, r.upper]) { m.removeFromParent(); m.scale.setScalar(s); m.rotation.set(0, 0, 0); m.visible = true; scene.add(m); }
  e.mat.emissive.setScalar(0);
  const rd = { P, C, soft, body: r.upper, limbs, limbIdx, mat: e.mat, life: 0, acc: 0, s, pushCd: 0 };
  ragdolls.push(rd);
  while (ragdolls.length > RAG_MAX) { const old = ragdolls.find(r => !r.pins || !Object.keys(r.pins).length); if (!old) break; removeRagdoll(old); }
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
  const pl = rd.pins && rd.pins.left, pr = rd.pins && rd.pins.right; // points held in a hand follow it exactly
  const pin = (pl || pr) ? () => { if (pl) rd.P[pl.i].p.copy(pl.t); if (pr) rd.P[pr.i].p.copy(pr.t); } : null;
  if (pin) pin();
  for (let it = 0; it < 6; it++) {
    for (const c of rd.C) satisfy(rd.P[c[0]].p, rd.P[c[1]].p, c[2], false);
    for (const c of rd.soft) satisfy(rd.P[c[0]].p, rd.P[c[1]].p, c[2], true);
    for (const pt of rd.P) if (pt.p.y < pt.gy) pt.p.y = pt.gy;
    if (pin) pin();
  }
  for (const pt of rd.P) if (pt.p.y <= pt.gy + 0.002) { // ground friction
    pt.o.x = lerp(pt.o.x, pt.p.x, 0.25); pt.o.z = lerp(pt.o.z, pt.p.z, 0.25); if (pt.o.y < pt.p.y) pt.o.y = lerp(pt.o.y, pt.p.y, 0.6);
  }
}
function poseRagdoll(rd) {
  const P = rd.P, T = P[1].p, B = P[2].p, F = P[3].p;
  rd.body.position.copy(B); // the torso group's origin is the pelvis point; its +Y runs to the chest top
  _ry.subVectors(T, B).normalize();
  _rz.subVectors(F, B); _rz.addScaledVector(_ry, -_rz.dot(_ry)).normalize();
  _rx.crossVectors(_ry, _rz);
  _rm.makeBasis(_rx, _ry, _rz); rd.body.quaternion.setFromRotationMatrix(_rm);
  rd.limbs.forEach((l, i) => { const [a, b] = rd.limbIdx[i]; l.position.copy(P[a].p); _rx.subVectors(P[b].p, P[a].p).normalize(); l.quaternion.setFromUnitVectors(DOWN, _rx); });
}
function nudgeRagdoll(rd, vel, scale) { if (rd.life > RAG_LIFE - 1.2) return; for (const pt of rd.P) pt.o.addScaledVector(vel, -RAG_STEP * scale); rd.life = Math.min(rd.life, RAG_LIFE - 2); }
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
    const T = SITES.tower, a = Math.atan2(-T.x, -T.z); const b = spawnEnemy('king', T.x + Math.sin(a) * 9, T.z + Math.cos(a) * 9); b.aggro = true; b.home = { x: b.x, z: b.z };
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
    const homeD = e.home ? Math.hypot(e.x - e.home.x, e.z - e.home.z) : 0;
    if (e.home && (homeD > 40 || dist > 60)) e.leash = true; else if (e.home && homeD < 3) e.leash = false; // the boss never strays far from its tower
    if (e.leash) e.aggro = false;
    else if (dist < range) e.aggro = true; else if (dist > range * 1.8 && !e.T.boss) e.aggro = false;
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
      if (e.leash) e.wAng = Math.atan2(e.home.x - e.x, e.home.z - e.z); // walk back home
      const ws = e.leash ? e.T.speed * 0.8 : e.T.speed * 0.3;
      mx = Math.sin(e.wAng) * ws; mz = Math.cos(e.wAng) * ws; e.g.rotation.y = e.wAng;
    }
    e.vx *= Math.exp(-dt * 6); e.vz *= Math.exp(-dt * 6);
    const nx = e.x + (mx + e.vx) * dt, nz = e.z + (mz + e.vz) * dt;
    if (heightAt(nx, nz) > -0.6 && Math.hypot(nx, nz) > 30) { e.x = nx; e.z = nz; } else if (Math.hypot(nx, nz) <= 30) e.aggro = false;
    e.g.position.set(e.x, heightAt(e.x, e.z), e.z);
    // walk cycle, attack swing, and a springy flinch when hit
    const moving = Math.hypot(mx, mz) / e.T.scale; e.walk += dt * (2 + moving * 3.5);
    e.lunge = Math.max(0, e.lunge - dt); const lf = Math.sin(e.lunge / 0.3 * Math.PI);
    const far = dist > LOD_FAR && e.hp >= e.maxHp; // a hurt enemy keeps its full body (flinches, health bar)
    if (far !== e.far) { e.far = far; e.lod.visible = far; e.rig.upper.visible = !far; for (const l of e.rig.legs) l.visible = !far; }
    if (far) continue;
    animateHumanoid(e.rig, e.walk, Math.min(1, moving / 1.2), lf);
    e.tiltV += (-70 * e.tilt - 9 * e.tiltV) * dt; e.tilt += e.tiltV * dt;
    e.upper.rotation.x = e.rig.hunch + e.tilt + lf * 0.35;
    e.flash = Math.max(0, e.flash - dt); e.mat.emissive.setScalar(e.flash > 0 ? 0.8 : 0);
    if (e.hp < e.maxHp) { e.bar.visible = true; e.fg.scale.x = Math.max(0.001, e.hp / e.maxHp); e.bar.lookAt(h); }
  }
}

// ---------------------------------------------------------------- pickups
const pickups = [];
const potionGeo = new THREE.SphereGeometry(0.16, 10, 8), potionMat = new THREE.MeshBasicMaterial({ color: 0xff3355 }), potionNeckGeo = new THREE.CylinderGeometry(0.05, 0.05, 0.14, 6);
function spawnPickup(type, x, z) { const m = new THREE.Mesh(potionGeo, potionMat); const neck = new THREE.Mesh(potionNeckGeo, M.lamp); neck.position.y = 0.18; m.add(neck); m.position.set(x, heightAt(x, z) + 0.6, z); scene.add(m); pickups.push({ type, m, x, z, t: 0 }); }
function updatePickups(dt) {
  const h = headPos();
  for (let i = pickups.length - 1; i >= 0; i--) {
    const p = pickups[i]; p.t += dt; p.m.position.y = heightAt(p.x, p.z) + 0.6 + Math.sin(p.t * 3) * 0.12; p.m.rotation.y += dt * 2;
    if (Math.hypot(h.x - p.x, h.z - p.z) < (inVR ? 0.45 : 1.6)) { S.potions++; sfx.pickup(); toast('Picked up a healing potion.', 2); scene.remove(p.m); pickups.splice(i, 1); }
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
  1: () => `Elder Maren: "Still ${5 - S.qKills} creature${5 - S.qKills === 1 ? '' : 's'} of the Gloom to go. They lurk out past the lantern posts."`,
  2: () => { S.stage = 3; S.gold += 60; S.potions += 2; gainXP(80); sfx.quest(); return 'Elder Maren: "You fight like the old ember-wardens! Take 60 gold and 2 potions. Three Sun Crystals once shielded this valley. Follow the golden beams and bring back their light."'; },
  3: () => `Elder Maren: "${3 - S.crystals.filter(Boolean).length} Sun Crystal(s) still out there. Look for the golden pillars of light."`,
  4: () => { S.stage = 5; S.blessed = true; gainXP(120); sfx.quest(); return 'Elder Maren: "The crystals sing! I bless your blade with their light (+8 damage). The source of the Gloom is the Hollow King, in the Ashen Tower to the northeast. End him."'; },
  5: () => 'Elder Maren: "The Hollow King waits beneath the purple beam. Rest by the fire to heal, then go."',
  6: () => { S.stage = 7; S.gold += 300; gainXP(300); sfx.level(); return 'Elder Maren: "The Gloom lifts! Emberwild is free, warden. Take 300 gold - and know that this valley is yours to roam."'; },
  7: () => 'Elder Maren: "The nights are quieter now. A few gloomlings still stray - stay sharp, warden."',
};
function villagerTalk(n) {
  if (n.act === 'sleep') { toast(`${n.name} is fast asleep.`, 2.5, true); return; }
  n.talk = 4; toast(`${n.name}: "${n.lines[n.lineI++ % n.lines.length]}"`, 5, true);
}
let INTERACT = null; // built once; opened chests are skipped at lookup time
function interactableAt(h) {
  if (!INTERACT) {
    INTERACT = [
      { x: elder.x, z: elder.z, r: 3.2, label: 'Talk to Elder Maren', act: () => { elder.talk = 5; toast(ELDER_LINES[S.stage](), 9, true); save(); } },
      { x: smith.x, z: smith.z, r: 3.2, label: 'Talk to Smith Tovik', act: () => { smith.talk = 4; smithTalk(); } },
    ];
    for (const c of chests) INTERACT.push({ x: c.x, z: c.z, r: 2.4, chest: c, label: 'Open chest', act: () => openChest(c) });
  }
  let best = null, bd = 1e9;
  for (const it of INTERACT) { if (it.chest && it.chest.opened) continue; const d = Math.hypot(h.x - it.x, h.z - it.z); if (d < it.r && d < bd) { bd = d; best = it; } }
  for (const n of villagers) { const d = Math.hypot(h.x - n.x, h.z - n.z) + 0.5; if (d - 0.5 < 2.4 && d < bd) { bd = d; best = n.talkItem || (n.talkItem = { act: () => villagerTalk(n) }); best.label = n.act === 'sleep' ? n.name + ' is asleep' : 'Talk to ' + n.name; } }
  return best;
}
let smithOfferT = -99;
function smithTalk() {
  if (S.swordLv >= 5) { toast('Smith Tovik: "That blade is as fine as I can forge it. Go cut some Gloom!"', 4, true); return; }
  const cost = 40 * (S.swordLv + 1);
  if (S.gold >= cost && time - smithOfferT > 6) { smithOfferT = time; toast(`Smith Tovik: "I can sharpen that blade to +${S.swordLv + 1} for ${cost} gold." Talk to him again to pay. (You have ${S.gold}.)`, 5, true); return; }
  if (S.gold >= cost) { smithOfferT = -99; S.gold -= cost; S.swordLv++; sfx.level(); burst(anvil.position.clone().add(_v2.set(0, 0.6, 0)), 0xff9a2a, 30, 3, 2); toast(`Smith Tovik: "There - sharper than ever!" Sword upgraded to +${S.swordLv} (${swordDamage()} damage).`, 5, true); save(); }
  else toast(`Smith Tovik: "I can sharpen that blade to +${S.swordLv + 1} for ${cost} gold." (You have ${S.gold}.)`, 4.5, true);
}
function openChest(c) {
  c.opened = true; S.chests.push(c.idx); const g = 15 + Math.floor(Math.random() * 30); S.gold += g;
  const pot = Math.random() < 0.6; if (pot) S.potions++;
  sfx.coin(); sfx.pickup(); burst(c.g.position.clone().add(_v2.set(0, 0.8, 0)), 0xffd54f, 30, 2.5, 2.5);
  toast(`Chest: ${g} gold${pot ? ' and a healing potion' : ''}!  (${S.chests.length}/${chests.length} chests found)`, 3.5, true);
  if (S.chests.length === chests.length) { S.gold += 100; sfx.level(); toast(`Every treasure chest in Emberwild found! A bonus of 100 gold.`, 5); }
  save();
}

// ---------------------------------------------------------------- input
function lockPointer() { try { const p = renderer.domElement.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch (e) { } }
const keys = {}; let interactQueued = false, potionQueued = false, locked = false, running = false;
addEventListener('keydown', e => { keys[e.code] = true; if (!running) return; if (e.code === 'KeyE') interactQueued = true; if (e.code === 'KeyQ') potionQueued = true; if (e.code === 'Space') { e.preventDefault(); jump(); } });
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
    sword.position.set(lerp(0.3, -0.1, e), -0.24 + s * 0.08, -0.45 - s * 0.15);
    sword.rotation.set(0.7 - s * 0.9, lerp(-0.9, 1.0, e), lerp(-0.9, 0.6, e));
    if (!swingHit && p > 0.35) {
      swingHit = true; const h = headPos(), f = forward2D();
      const imp = new THREE.Vector3(f.x * 6 + f.z * 2.5, 1.5, f.z * 6 - f.x * 2.5); // forward + right-to-left sweep
      const inArc = enemies.filter(en => { if (en.dead) return false; const dx = en.x - h.x, dz = en.z - h.z, d = Math.hypot(dx, dz); en._d = d; return d < 2.9 + en.rad && (dx * f.x + dz * f.z) / (d || 1) > 0.4; });
      inArc.sort((a, b) => a._d - b._d).slice(0, 2).forEach(en => hitEnemy(en, 1, h.x, h.z, imp)); // a swing connects with the 2 nearest at most
      for (const rd of [...ragdolls]) { const c = rd.P[0].p, dx = c.x - h.x, dz = c.z - h.z, d = Math.hypot(dx, dz); if (d < 3 && (dx * f.x + dz * f.z) / (d || 1) > 0.3) nudgeRagdoll(rd, imp, 0.8); }
    }
    if (swingT <= 0) restSword();
  }
}
const prevTip = new THREE.Vector3(), _swTip = new THREE.Vector3(), _swHilt = new THREE.Vector3(), _swTipL = new THREE.Vector3(), _swVel = new THREE.Vector3(), _swImp = new THREE.Vector3(); let havePrev = false, tipSpeed = 0, whooshCd = 0;
function updateVRSword(dt) {
  if (!inVR || !hands.right || !swordInHand) { havePrev = false; return; }
  sword.updateWorldMatrix(true, false);
  const tipW = sword.localToWorld(_swTip.copy(TIP)), hiltW = sword.localToWorld(_swHilt.copy(HILT));
  const tipL = dolly.worldToLocal(_swTipL.copy(tipW));
  const velW = _swVel.set(0, 0, 0); if (havePrev) velW.subVectors(tipL, prevTip).divideScalar(Math.max(dt, 1e-3)).applyQuaternion(dolly.quaternion);
  const sp = velW.length(); prevTip.copy(tipL); havePrev = true;
  pushRagdollsWithBlade(hiltW, tipW, velW);
  tipSpeed = lerp(tipSpeed, sp, 0.5); whooshCd -= dt;
  if (tipSpeed > 4 && whooshCd <= 0) { sfx.swing(); whooshCd = 0.4; }
  sword.userData.edge.material.color.setHex(tipSpeed > 1.8 ? 0xffd27a : 0xff7a1a);
  if (tipSpeed < 1.8) return;
  const h = headPos(), mult = clamp(tipSpeed / 4.5, 0.6, 1.6);
  for (const e of enemies) { if (e.dead || e.hitCd > 0) continue; if (enemyBladeDist(e, hiltW, tipW) < e.rad + 0.1) hitEnemy(e, mult, h.x, h.z, _swImp.copy(velW).clampLength(0, 12)); }
}
let snapReady = true, runLatch = false;
let airborne = false, jumpVy = 0; const JUMP_V = 5.2, JUMP_G = 12; // about 1.1 m high, 0.9 s in the air
function jump() { if (airborne || !running) return; airborne = true; jumpVy = JUMP_V; tone(260, 0.1, 'triangle', 0.08, 140); }
function updateMovement(dt) {
  let mx = 0, mz = 0, run = false, turn = 0;
  if (inVR) {
    const L = hands.left?.src.gamepad, R = hands.right?.src.gamepad;
    if (L) { const ax = L.axes.length >= 4 ? 2 : 0; mx = L.axes[ax] || 0; mz = L.axes[ax + 1] || 0; if (btnEdge('left', 3)) runLatch = true; if (Math.hypot(mx, mz) < 0.2) runLatch = false; run = runLatch; } // click the left stick to sprint
    if (R) { const ax = R.axes.length >= 4 ? 2 : 0; turn = R.axes[ax] || 0; }
    if (btnEdge('right', 4)) { if (interactableAt(headPos())) interactQueued = true; else jump(); } // A: talk/open when something is in reach, otherwise jump
    const qB = btnEdge('right', 5), qY = btnEdge('left', 5); if (qB || qY) potionQueued = true; // B or Y: quick-drink
    if (Math.abs(turn) > 0.7 && snapReady) {
      snapReady = false; handHist.left.length = handHist.right.length = 0; const ang = -Math.sign(turn) * Math.PI / 6, h = headPos().clone();
      _v2.subVectors(dolly.position, h).applyAxisAngle(THREE.Object3D.DEFAULT_UP, ang); dolly.position.copy(h).add(_v2); dolly.rotation.y += ang;
    } else if (Math.abs(turn) < 0.3) snapReady = true;
  } else {
    camera.rotation.set(pitch, yaw, 0);
    mx = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0); mz = (keys.KeyS ? 1 : 0) - (keys.KeyW ? 1 : 0); run = keys.ShiftLeft || keys.ShiftRight;
  }
  const mag = Math.hypot(mx, mz);
  if (mag > 0.15) {
    const f = forward2D(), wade = heightAt(headPos().x, headPos().z) < 0 ? 0.55 : 1, speed = (run ? 7.5 : 4.2) * wade * Math.min(1, mag) / mag;
    const rx = -f.z, rz = f.x; // right vector
    movePlayer((f.x * -mz + rx * mx) * speed * dt, (f.z * -mz + rz * mx) * speed * dt);
  }
  const h = headPos(); const target = Math.max(groundAt(h.x, h.z), -1.3);
  if (airborne) { // ballistic jump, then land on whatever height the ground has where you come down
    jumpVy -= JUMP_G * dt; dolly.position.y += jumpVy * dt;
    if (dolly.position.y < target) { // never below the ground: land when falling, ride the slope up while still rising
      dolly.position.y = target;
      if (jumpVy <= 0) { airborne = false; jumpVy = 0; tone(90, 0.12, 'triangle', 0.1); pulse('left', 0.3, 40); pulse('right', 0.3, 40); }
    }
  } else dolly.position.y = Math.max(lerp(dolly.position.y, target, 1 - Math.exp(-dt * 12)), target - 0.04); // smooth, but never more than 4 cm below the ground going uphill
  const inside = houseAt(h.x, h.z); // the ceiling stops jumps (and tall players) indoors
  if (inside) { const ceil = inside.h + 3.2 * inside.s - 0.15, eye = camera.position.y; if (dolly.position.y + eye > ceil) { dolly.position.y = Math.max(target, ceil - eye); if (jumpVy > 0) jumpVy = 0; } }
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
vrBtn.style.cssText = 'position:fixed;bottom:18px;right:18px;z-index:20;padding:12px 22px;font:bold 15px Arial,Arimo,sans-serif;border-radius:6px;border:1px solid #fff;background:rgba(0,0,0,.4);color:#fff;cursor:pointer';
document.body.appendChild(vrBtn);
if (navigator.xr) navigator.xr.isSessionSupported('immersive-vr').then(ok => { if (ok) { vrBtn.disabled = false; vrBtn.textContent = 'ENTER VR'; } }).catch(() => { });
vrBtn.onclick = () => { const s = renderer.xr.getSession(); if (s) s.end(); else enterVR(); };
// settings selectors on the title screen
const resSel = $('gfxRes'), hzSel = $('gfxHz');
if (resSel && hzSel) {
  resSel.value = GFX.res; hzSel.value = String(GFX.hz);
  const gripSel = $('gfxGrip'); if (gripSel) { gripSel.value = GFX.grip; gripSel.onchange = () => { GFX.grip = gripSel.value; try { localStorage.setItem(GFX_KEY, JSON.stringify(GFX)); } catch (e) { } }; }
  const store = () => { GFX.res = resSel.value; GFX.hz = +hzSel.value; try { localStorage.setItem(GFX_KEY, JSON.stringify(GFX)); } catch (e) { } };
  resSel.onchange = store; hzSel.onchange = store;
}

// On a flat screen the right glove holds the sword. The sword sits on the VR grip rotated -0.35 rad about X,
// so the hand goes on the sword with the inverse rotation, and its fingers are posed as a closed fist.
function attachDesktopHand() {
  const m = playerHands.right; sword.add(m.g); m.g.position.set(0, 0, 0); m.g.rotation.set(0.35, 0, 0); m.g.visible = true;
  poseHand(m, [0.8, 0.9, 1, 1, 1], 1);
}
attachDesktopHand();
placePlayer(S.x, S.z); camera.rotation.set(0, yaw, 0);
// Compile every shader up front (renderer.compile skips hidden objects), so the first hit flash, message or
// enemy doesn't stall a frame mid-fight while its program compiles.
{
  const hidden = [toastPanel.mesh, promptPanel.mesh, hurtFlash]; hidden.forEach(m => { m.visible = true; });
  const dummy = spawnEnemy('gloom', 0, -9999); scene.add(playerHands.left.g);
  try { renderer.compile(scene, camera); } catch (e) { }
  hidden.forEach(m => { m.visible = false; }); playerHands.left.g.removeFromParent();
  enemies.splice(enemies.indexOf(dummy), 1); scene.remove(dummy.g); dummy.mat.dispose();
}
const clock = new THREE.Clock(); let uiT = 0, saveT = 0;
renderer.setAnimationLoop(() => {
  const rawDt = clock.getDelta(); const dt = Math.min(rawDt, 0.05); time += dt; if (rawDt > 0) fpsNow = lerp(fpsNow, 1 / rawDt, 0.05);
  if (running) {
    updateMovement(dt); updateDesktopSword(dt); updateVRSword(dt); updateSpawns(dt); updateEnemies(dt); updateHands(dt); updateRagdolls(dt); updateStones(dt); updatePickups(dt); updateNPCs(dt); updateVillagers(dt);
    if (interactQueued) { interactQueued = false; const it = interactableAt(headPos()); if (it) it.act(); }
    if (potionQueued) { potionQueued = false; drinkPotion(); }
    const h = headPos(); const it = interactableAt(h); setPrompt(it ? it.label : '');
    // campfire heal + slow regen
    if (Math.hypot(h.x, h.z) < 5) S.hp = Math.min(maxHp(), S.hp + 12 * dt); else if (time - lastHurt > 6) S.hp = Math.min(maxHp(), S.hp + 1 * dt);
    toastT -= dt; if (toastT <= 0 && toastQ.length) { const [m, sc] = toastQ.shift(); showToast(m, sc); }
    if (toastT <= 0) { toastMsg = ''; $('toast').style.opacity = 0; toastPanel.mat.opacity = Math.max(0, toastPanel.mat.opacity - dt * 3); if (toastPanel.mat.opacity <= 0) toastPanel.mesh.visible = false; }
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
if (['localhost', '127.0.0.1'].includes(location.hostname)) { // debug hooks for local testing only
window.__emberwild = { setDay: v => { dayT = v; }, getDay: () => dayT, SITES, chests, crystals, pickups, villagers, HOUSES, groundAt, houseToWorld, interactableAt, renderer, S, enemies, ragdolls, hitEnemy, playerHands, poseHand, stones, camera, npcs, makeRagdoll, stepRagdoll, heightAt, headPos, dolly, spawnEnemy, startSwing, placePlayer, setYaw: v => { yaw = v; } }; // debug hook
// debug: fake VR controllers for testing grab logic on a desktop browser (no headset needed)
window.__emberwild.simVR = () => {
  const mk = side => { const grip = new THREE.Group(); dolly.add(grip); const btn = () => ({ value: 0, pressed: false, touched: false }); const gamepad = { buttons: [btn(), btn(), btn(), btn(), btn(), btn(), btn()], axes: [0, 0, 0, 0], hapticActuators: [] }; hands[side] = { grip, src: { handedness: side, gamepad }, prev: [], isHand: false }; grip.add(playerHands[side].g); playerHands[side].g.rotation.set(0, 0, 0); return hands[side]; };
  inVR = true; const L = mk('left'), R = mk('right'); holdSword(); L.grip.add(shield);
  return { hands, grab, stones, scabbard, swordInHand: () => swordInHand, S, pickups, bodyPoint };
};
}
