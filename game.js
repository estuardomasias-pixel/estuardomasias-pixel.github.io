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
const DEFAULT = { level: 1, xp: 0, hp: 100, gold: 10, potions: 2, swordLv: 0, blessed: false, stage: 0, qKills: 0, crystals: [false, false, false], chests: [], x: 0, z: 9, dayT: 0.3, arrows: 15 };
let S = structuredClone(DEFAULT);
try { const s = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null'); if (s) S = Object.assign(structuredClone(DEFAULT), s); } catch (e) { /* no storage */ }
const maxHp = () => 100 + (S.level - 1) * 15;
const xpNeed = () => Math.round(60 * Math.pow(S.level, 1.5));
function save() { try { const h = headPos(); S.x = h.x; S.z = h.z; S.dayT = dayT; const held = ['left', 'right'].filter(k => grab[k]?.kind === 'potion').length; if (Object.keys(WEAPONS).length) S.wpn = weaponSaveState(); localStorage.setItem(SAVE_KEY, JSON.stringify({ ...S, potions: S.potions + held })); } catch (e) { } }

// ---------------------------------------------------------------- renderer / scene
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
// Graphics: sharpness + frame rate first. Resolution is a multiple of the headset's NATIVE panel resolution.
const GFX_KEY = 'emberwild-gfx-v1';
const GFX = { res: 'native', hz: 90, grip: 'hold', stance: 'standing' };
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
// Heightfield of the rendered terrain mesh. Physics samples the same flat triangles the player sees (PlaneGeometry
// splits each grid cell into triangles a-b-d and b-c-d), instead of re-evaluating the analytic noise, which differs
// from the drawn surface by up to ~0.4 m and costs ~11 noise calls per lookup.
const TERRAIN_SEG = 220, HF_N = TERRAIN_SEG + 1, HF_STEP = WORLD / TERRAIN_SEG, HF = new Float32Array(HF_N * HF_N);
function terrainH(x, z) {
  const fx = clamp((x + WORLD / 2) / HF_STEP, 0, TERRAIN_SEG - 1e-4), fz = clamp((z + WORLD / 2) / HF_STEP, 0, TERRAIN_SEG - 1e-4);
  const ix = fx | 0, iz = fz | 0, u = fx - ix, v = fz - iz, i = ix + iz * HF_N;
  const ha = HF[i], hb = HF[i + HF_N], hc = HF[i + HF_N + 1], hd = HF[i + 1];
  return u + v < 1 ? ha + (hd - ha) * u + (hb - ha) * v : hc + (hb - hc) * (1 - u) + (hd - hc) * (1 - v);
}
const PATHS = ['tower', 'c0', 'c1', 'c2'].map(k => [0, 0, SITES[k].x, SITES[k].z]);
const pathDist = (x, z) => Math.min(...PATHS.map(p => segDist2D(x, z, ...p)));

{
  const SEG = TERRAIN_SEG;
  const geo = new THREE.PlaneGeometry(WORLD, WORLD, SEG, SEG); geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position; const cols = new Float32Array(pos.count * 3);
  const C = { sand: new THREE.Color(0xd8c690), grass: new THREE.Color(0x63a446), grass2: new THREE.Color(0x3d7a34), dirt: new THREE.Color(0x9a7b4f), rock: new THREE.Color(0x7a7166), snow: new THREE.Color(0xeef2f5), ash: new THREE.Color(0x4a4048) };
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i), h = heightAt(x, z); pos.setY(i, h); HF[i] = h;
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
function addCollider(x, z, r, top = 1e9, soft = false) { const k = gkey(Math.floor(x / CELL), Math.floor(z / CELL)); if (!grid.has(k)) grid.set(k, []); grid.get(k).push({ x, z, r, top, soft }); }
// first point (0..1) where segment p0->p1 enters a solid collider below its top, or -1 (exact circle test, no tunnelling)
function segHit(p0, p1) {
  const dx = p1.x - p0.x, dz = p1.z - p0.z, A = dx * dx + dz * dz || 1e-9, mx = (p0.x + p1.x) / 2, mz = (p0.z + p1.z) / 2, ix = Math.floor(mx / CELL), iz = Math.floor(mz / CELL); let best = -1;
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) { const list = grid.get(gkey(ix + a, iz + b)); if (!list) continue;
    for (const c of list) { if (c.soft) continue; const fx = p0.x - c.x, fz = p0.z - c.z, B = fx * dx + fz * dz, C = fx * fx + fz * fz - c.r * c.r; let t;
      if (C <= 0) t = 0; else { const D = B * B - A * C; if (D < 0 || B > 0) continue; t = (-B - Math.sqrt(D)) / A; if (t > 1) continue; }
      if (p0.y + (p1.y - p0.y) * t > c.top) continue; if (best < 0 || t < best) best = t; } }
  return best;
}
function hitCollider(x, z, pad = 0) { // the collider circle containing (x, z), if any
  const ix = Math.floor(x / CELL), iz = Math.floor(z / CELL);
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) { const list = grid.get(gkey(ix + a, iz + b)); if (list) for (const c of list) { const dx = x - c.x, dz = z - c.z; if (dx * dx + dz * dz < (c.r + pad) * (c.r + pad)) return c; } }
  return null;
}
function pushOut(v, r, solidOnly = false) { // moves v (x/z) out of any collider it overlaps (solidOnly: ignore soft ones like the campfire); true if it touched one
  const ix = Math.floor(v.x / CELL), iz = Math.floor(v.z / CELL); let hit = false;
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
    const list = grid.get(gkey(ix + a, iz + b)); if (!list) continue;
    for (const c of list) { if (solidOnly && c.soft) continue; const dx = v.x - c.x, dz = v.z - c.z, m = c.r + r, d2 = dx * dx + dz * dz; if (d2 < m * m && d2 > 1e-8) { const d = Math.sqrt(d2); v.x = c.x + dx / d * m; v.z = c.z + dz / d * m; hit = true; } }
  }
  return hit;
}
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
  const lowest = (x, z, r) => Math.min(terrainH(x + r, z), terrainH(x - r, z), terrainH(x, z + r), terrainH(x, z - r), terrainH(x, z));
  pts.forEach(t => { t.m = mat4(t, lowest(t.x, t.z, 0.3 * t.s) - 0.15); addCollider(t.x, t.z, 0.35 * t.s, t.h + 6 * t.s); }); // roots go into the downhill side
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
    q.setFromEuler(eul.set(rand() * 3, rand() * 3, rand() * 3)); sc.set(s, s * (0.6 + rand() * 0.5), s); p.set(x, lowest(x, z, 0.6 * s) - 0.15 * s, z);
    rockItems.push({ x, z, m: new THREE.Matrix4().compose(p, q, sc), c: new THREE.Color().setHSL(0.08, 0.06, 0.4 + rand() * 0.2) });
    if (s > 0.9) addCollider(x, z, s * 0.9, h + 0.8 * s);
  }
  addBucketed(rockGeo, new THREE.MeshLambertMaterial({ color: 0x8a8580, flatShading: true }), rockItems);

  const flowerGeo = new THREE.TetrahedronGeometry(0.14, 0), flowerItems = [];
  const fcols = [0xffe066, 0xff8fb3, 0xffffff, 0xb59cff, 0xff9f43];
  for (let i = 0; i < 12000 && flowerItems.length < 2500; i++) {
    const x = (rand() - 0.5) * WORLD * 0.85, z = (rand() - 0.5) * WORLD * 0.85; const h = heightAt(x, z);
    if (h < 1.5 || h > 24 || noise2(x / 30, z / 30) < 0.1 || Math.hypot(x, z) < 22 || pathDist(x, z) < 2.5) continue;
    p.set(x, h + 0.08, z); q.identity(); sc.setScalar(0.7 + rand() * 0.8);
    flowerItems.push({ x, z, m: new THREE.Matrix4().compose(p, q, sc), c: new THREE.Color().setHex(fcols[Math.floor(rand() * fcols.length)]) });
  }
  addBucketed(flowerGeo, new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true }), flowerItems);
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
let dayT = S.dayT ?? 0.3; const DAY_LEN = 600; let wasNight = null; let DAY_MOON = 0; const moonDir = new THREE.Vector3();
const SKY = { day: new THREE.Color(0x8fc3ff), night: new THREE.Color(0x0a0f2a), dusk: new THREE.Color(0xff8a50) };
const skyCol = new THREE.Color(), sunDir = new THREE.Vector3(), WHITE = new THREE.Color(0xffffff), LAMP_NIGHT = new THREE.Color(0xffd27a), LAMP_DAY = new THREE.Color(0x5a6470);
const sunElev = () => -Math.cos(dayT * Math.PI * 2);
// sky dome with a horizon-to-zenith gradient, and a few slow clouds (2 draw calls, no fog)
const skyDome = (() => {
  const g = new THREE.SphereGeometry(440, 16, 10); g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 3), 3));
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false })); m.renderOrder = -10; scene.add(m); return m;
})();
const CLOUD_N = 10, clouds = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, fog: false, map: (() => {
  const c = document.createElement('canvas'); c.width = 128; c.height = 64; const x = c.getContext('2d');
  for (let k = 0; k < 7; k++) { const gx = 20 + k * 14 + Math.sin(k) * 6, gy = 34 - Math.abs(3 - k) * 2, r = 16 + (k % 3) * 5, gr = x.createRadialGradient(gx, gy, 2, gx, gy, r); gr.addColorStop(0, 'rgba(255,255,255,0.85)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); x.fillStyle = gr; x.fillRect(0, 0, 128, 64); }
  return new THREE.CanvasTexture(c); })() }), CLOUD_N);
clouds.frustumCulled = false; clouds.renderOrder = -9; scene.add(clouds);
const cloudData = Array.from({ length: CLOUD_N }, (_, k) => ({ a: k / CLOUD_N * 6.283 + rand(), d: 260 + rand() * 90, y: 110 + rand() * 60, w: 90 + rand() * 80 }));
const _skyTop = new THREE.Color(), _skyHor = new THREE.Color(), _cm = new THREE.Matrix4(), _cq = new THREE.Quaternion(), _cp = new THREE.Vector3(), _cs = new THREE.Vector3();
let skyDomeT = 0;
function updateSkyDome(dt) {
  const h = headPos(); skyDome.position.copy(h);
  skyDomeT -= dt; if (skyDomeT <= 0) { // recolour twice a second: zenith a little deeper, horizon paler
    skyDomeT = 0.5; _skyTop.copy(skyCol).multiplyScalar(0.8); _skyHor.copy(skyCol).lerp(WHITE, 0.3 * smoothstep(-0.2, 0.2, sunElev()));
    const pos = skyDome.geometry.attributes.position, col = skyDome.geometry.attributes.color;
    for (let k = 0; k < pos.count; k++) { const t = clamp(pos.getY(k) / 440, 0, 1), c = _skyHor.clone().lerp(_skyTop, Math.sqrt(t)); col.setXYZ(k, c.r, c.g, c.b); }
    col.needsUpdate = true;
    const lum = 0.25 + 0.75 * smoothstep(-0.2, 0.25, sunElev()); clouds.material.color.setRGB(lum, lum * 0.97, lum * 0.95).lerp(SKY.dusk, clamp(1 - Math.abs(sunElev()) / 0.3, 0, 1) * 0.35);
  }
  for (let k = 0; k < CLOUD_N; k++) { const c = cloudData[k]; c.a += dt * 0.0025; _cp.set(h.x + Math.cos(c.a) * c.d, c.y, h.z + Math.sin(c.a) * c.d); _cq.setFromRotationMatrix(_cm.lookAt(_cp, h, THREE.Object3D.DEFAULT_UP)); _cs.set(c.w, c.w * 0.4, 1); clouds.setMatrixAt(k, _cm.compose(_cp, _cq, _cs)); }
  clouds.instanceMatrix.needsUpdate = true;
}
const isNight = () => sunElev() < -0.05;
function updateSky(dt) {
  const nd = dayT + dt / DAY_LEN; if (nd >= 1) DAY_MOON++; dayT = nd % 1;
  const ang = dayT * Math.PI * 2, elev = sunElev();
  sunDir.set(Math.sin(ang), elev, 0.35).normalize();
  const f = smoothstep(-0.15, 0.25, elev), dusk = clamp(1 - Math.abs(elev) / 0.3, 0, 1);
  skyCol.copy(SKY.night).lerp(SKY.day, f).lerp(SKY.dusk, dusk * 0.45);
  scene.background = skyCol; scene.fog.color.copy(skyCol); updateSkyDome(dt);
  if (elev > -0.05) { sun.position.copy(sunDir); sun.color.setHex(0xfff0d0).lerp(SKY.dusk, dusk * 0.5); sun.intensity = 0.3 + 2.4 * f; }
  else { sun.position.copy(sunDir).negate(); sun.color.setHex(0x8899ff); sun.intensity = 0.55; }
  M.lamp.color.lerpColors(LAMP_NIGHT, LAMP_DAY, f); // windows and lanterns glow at night, look like dark glass by day
  hemi.intensity = 0.45 + 0.9 * f; hemi.color.copy(skyCol).lerp(WHITE, 0.4);
  stars.material.opacity = 1 - f;
  const h = headPos(); stars.position.copy(h);
  sunDisc.position.copy(h).addScaledVector(sunDir, 400); sunDisc.lookAt(h);
  const mAng = ang + Math.PI + DAY_MOON * 0.21; moonDir.set(Math.sin(mAng), -Math.cos(mAng), 0.35).normalize(); // the moon drifts against the sun day by day (phases)
  moonDisc.position.copy(h).addScaledVector(moonDir, 400); moonDisc.lookAt(h); moonDisc.visible = moonDir.y > -0.1;
  stars.rotation.y = dayT * Math.PI * 2;
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
const WELL_STONE = new THREE.MeshLambertMaterial({ color: 0x5a5560, flatShading: true, side: THREE.DoubleSide });
const FM = {
  floor: new THREE.MeshLambertMaterial({ color: 0x8a6a45 }), ceil: new THREE.MeshLambertMaterial({ color: 0x8a6a48, emissive: 0x2a1c10 }), inwall: new THREE.MeshLambertMaterial({ color: 0xa89878, emissive: 0x1a1008 }),
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
  const windowAt = (px, pz, alongX) => { // pane (glows at night) with a timber frame and a stone sill
    const W = (w, h, d, mat, x, y, z) => alongX ? box(w, h, d, mat, x, y, z) : box(d, h, w, mat, x, y, z);
    const o = alongX ? 0 : 1, sgn = alongX ? Math.sign(pz) : Math.sign(px);
    W(0.8, 0.8, T + 0.07, M.lamp, px, 1.9, pz);
    for (const dy of [-0.44, 0.44]) W(0.96, 0.08, T + 0.1, M.dark, px, 1.9 + dy, pz);
    for (const dd of [-0.44, 0.44]) alongX ? box(0.08, 0.96, T + 0.1, M.dark, px + dd, 1.9, pz) : box(T + 0.1, 0.96, 0.08, M.dark, px, 1.9, pz + dd);
    W(0.06, 0.8, T + 0.09, M.dark, px, 1.9, pz); // mullion
    alongX ? box(1.0, 0.06, 0.22, M.stone, px, 1.47, pz + sgn * 0.08) : box(0.22, 0.06, 1.0, M.stone, px + sgn * 0.08, 1.47, pz); // sill
  };
  for (const sx of [-1.6, 1.6]) windowAt(sx, F, true);
  windowAt(-2.4, 0.4, false); windowAt(2.4, 0.4, false);
  box(4.58, 3.1, 0.02, FM.inwall, 0, 1.6, -1.79); box(0.02, 3.1, 3.56, FM.inwall, -2.29, 1.6, 0); box(0.02, 3.1, 3.56, FM.inwall, 2.29, 1.6, 0); // inner walls
  box(1.6, 3.1, 0.02, FM.inwall, -1.5, 1.6, 1.79); box(1.6, 3.1, 0.02, FM.inwall, 1.5, 1.6, 1.79); box(1.4, 1.0, 0.02, FM.inwall, 0, 2.65, 1.79);
  for (const sx of [-0.74, 0.74]) box(0.1, 2.12, T + 0.04, M.dark, sx, 1.06, F);              // door frame
  box(1.7, 0.16, T + 0.08, M.dark, 0, 2.18, F);                                                  // lintel over the door
  // gable roof: two slopes meeting at a ridge, triangular gable walls at the ends, eaves overhanging the walls
  const RISE = 1.5, EAVE = 2.4, pitch = Math.atan2(RISE, 2.0), slab = Math.hypot(EAVE, EAVE * RISE / 2.0) + 0.05;
  for (const sz of [-1, 1]) { const r = box(5.8, 0.12, slab, M.roof, 0, 3.2 + RISE - (EAVE / 2) * (RISE / 2.0) + 0.07, sz * EAVE / 2); r.rotation.x = sz * pitch; }
  const gable = new THREE.Shape([new THREE.Vector2(-2, 0), new THREE.Vector2(2, 0), new THREE.Vector2(0, RISE)]);
  for (const sx of [-1, 1]) { const gm = new THREE.Mesh(new THREE.ExtrudeGeometry(gable, { depth: T, bevelEnabled: false }), M.wall); gm.rotation.y = Math.PI / 2; gm.position.set(sx * 2.4 - T / 2, 3.2, 0); g.add(gm); }
  box(5.9, 0.14, 0.14, M.dark, 0, 3.2 + RISE + 0.04, 0);                                        // ridge beam
  for (const cx of [-2.5, 2.5]) for (const cz of [-2, 2]) box(0.18, 3.25, 0.18, M.dark, cx, 1.62, cz); // timber corner posts
  for (const sz of [-1, 1]) box(5.3, 0.3, 0.26, M.stone, 0, 0.0, sz * 2.02); for (const sx of [-1, 1]) box(0.26, 0.3, 4.3, M.stone, sx * 2.52, 0.0, 0); // stone foundation
  box(4.9, 0.1, 3.9, FM.ceil, 0, 3.12, 0); box(4.6, 0.1, 3.6, FM.floor, 0, 0.05, 0);       // ceiling (below the wall tops, so nothing shares its plane) and floor
  // bed (back left), hearth with chimney and pot (back right), table and stools (front right), shelf, rug
  box(1.0, 0.35, 2.0, M.wood, -1.8, 0.2, -0.8); box(0.95, 0.12, 1.45, FM.blanket[i % 3], -1.8, 0.43, -0.5); box(0.7, 0.12, 0.35, FM.linen, -1.8, 0.45, -1.52);
  box(1.1, 0.9, 0.6, M.stone, 1.6, 0.45, -1.5); box(0.6, 0.3, 0.05, M.ember, 1.6, 0.35, -1.18); box(0.5, 2.3, 0.4, M.stone, 1.6, 2.05, -1.62); box(0.5, 1.9, 0.4, M.stone, 1.6, 4.15, -1.62); // chimney continues out through the roof
  cyl(0.2, 0.25, FM.pot, 1.6, 1.03, -1.45);
  box(1.1, 0.07, 0.7, M.wood, 1.4, 0.75, 0.6); for (const lx of [0.92, 1.88]) for (const lz of [0.32, 0.88]) box(0.07, 0.72, 0.07, M.wood, lx, 0.36, lz);
  cyl(0.18, 0.45, M.wood, 1.4, 0.225, 1.25); cyl(0.18, 0.45, M.wood, 0.6, 0.225, 0.6); box(0.06, 0.12, 0.06, M.lamp, 1.55, 0.85, 0.5);
  box(1.2, 0.06, 0.3, M.wood, -0.1, 1.5, -1.73); for (const jx of [-0.5, -0.1, 0.3]) cyl(0.08, 0.2, FM.jar, jx, 1.63, -1.73, 6);
  box(1.6, 0.02, 1.2, FM.rug[i % 2], -0.2, 0.11, 0.3);
  if (i % 2) box(0.6, 0.6, 0.6, M.wood, -1.9, 0.3, 0.85); else cyl(0.3, 0.8, M.wood, -1.9, 0.4, 0.85);
  g.position.set(x, H.h, z); g.rotation.y = rot; g.scale.setScalar(s); STATIC.add(g);
  // colliders: a row of small circles along each wall (doorway left open), plus the bigger furniture
  const ring = (lx, lz, r, top = 4.6) => { const w = houseToWorld(H, lx, lz); addCollider(w.x, w.z, r * s, H.h + top * s); };
  for (let t = -2.5; t <= 2.5; t += 0.4) ring(t, -1.9, 0.28);
  for (let t = -1.9; t <= 1.9; t += 0.4) { ring(-2.4, t, 0.28); ring(2.4, t, 0.28); }
  for (let t = 0.85; t <= 2.5; t += 0.4) { ring(-t, 1.9, 0.28); ring(t, 1.9, 0.28); }
  ring(-1.8, -1.3, 0.5, 0.6); ring(-1.8, -0.35, 0.5, 0.6); ring(1.6, -1.5, 0.55, 3.2); ring(1.4, 0.6, 0.5, 0.8); ring(-1.9, 0.85, 0.35, 0.8); ring(1.4, 1.25, 0.2, 0.45); ring(0.6, 0.6, 0.2, 0.45);
}
for (let i = 0; i < 7; i++) {
  const a = i / 7 * Math.PI * 2 + 0.3; if (Math.abs(Math.sin(a - 0.0)) < 0.2 && Math.cos(a) > 0) continue;
  const r = 15 + (i % 2) * 2.5; const x = Math.sin(a) * r, z = Math.cos(a) * r;
  house(x, z, Math.atan2(-x, -z), 0.9 + (i % 3) * 0.12);
}
// ---------------------------------------------------------------- doors (hinged, with physics)
// Each house has a real door hinged on the left of the doorway that swings inward up to ~100 degrees. It has
// angular velocity and hinge friction, bounces off its stops, and can be pushed open by walking into it from
// outside, opened or closed with E, swung by grabbing a handle in VR, and is opened and closed by villagers as they
// pass. All doors are two instanced draw calls (leaf and handles).
const DOOR_W = 1.38, DOOR_H = 2.05, DOOR_T = 0.06, DOOR_MAX = 1.75, DOOR_Z = 1.9; // DOOR_Z: the front wall plane (house local)
const doors = [];
const doorIM = (() => {
  const T4 = (x, y, z) => new THREE.Matrix4().makeTranslation(x, y, z);
  const leaf = mergeGeos([{ geo: new THREE.BoxGeometry(DOOR_W, DOOR_H, DOOR_T), m: T4(DOOR_W / 2, DOOR_H / 2, 0) },
    ...[0.45, 1.6].flatMap(y => [-1, 1].map(sd => ({ geo: new THREE.BoxGeometry(DOOR_W * 0.9, 0.09, 0.025), m: T4(DOOR_W / 2, y, sd * 0.04) }))), // ledges (planks held by cross boards)
    ...[0.35, 0.7, 1.05].map(x => ({ geo: new THREE.BoxGeometry(0.012, DOOR_H * 0.98, DOOR_T + 0.004), m: T4(x, DOOR_H / 2, 0) }))]); // plank seams
  const im = new THREE.InstancedMesh(leaf, new THREE.MeshLambertMaterial({ color: 0x5a3a20 }), HOUSES.length); im.frustumCulled = false; scene.add(im); return im;
})();
const knobIM = (() => {
  const g = mergeGeos([-1, 1].map(sd => ({ geo: new THREE.SphereGeometry(0.035, 8, 6), m: new THREE.Matrix4().makeTranslation(DOOR_W - 0.12, 1.0, sd * 0.06) })));
  const im = new THREE.InstancedMesh(g, M.gold, HOUSES.length); im.frustumCulled = false; scene.add(im); return im;
})();
for (const H of HOUSES) doors.push({ H, ang: 0, vel: 0, target: null, auto: false, idle: 0, m: new THREE.Matrix4(), hm: new THREE.Matrix4().compose(new THREE.Vector3(H.x, H.h, H.z), new THREE.Quaternion().setFromAxisAngle(THREE.Object3D.DEFAULT_UP, H.rot), new THREE.Vector3(H.s, H.s, H.s)) });
const _dm = new THREE.Matrix4(), _dr = new THREE.Matrix4();
function doorMatrix(d) { return d.m.copy(d.hm).multiply(_dm.makeTranslation(-0.7, 0, DOOR_Z)).multiply(_dr.makeRotationY(d.ang)); }
function doorKnob(d, side, out) { return out.set(DOOR_W - 0.12, 1.0, side * 0.06).applyMatrix4(d.m); }
const doorLocal = (d, x, z) => houseToLocal(d.H, x, z); // [lx, lz] in house units
function nearDoorway(d, x, z, rad) { const [lx, lz] = doorLocal(d, x, z); return Math.abs(lx) < rad && Math.abs(lz - DOOR_Z) < rad; }
function updateDoors(dt) {
  const h = headPos();
  doors.forEach((d, i) => {
    // villagers open the door they walk through and close it behind them
    const vNear = villagers.some(n => n.route.length && n.route.some(q => q.house === d.H) && nearDoorway(d, n.x, n.z, 2.2));
    if (vNear) { if (d.ang < 1.3) d.target = 1.5; d.auto = true; d.idle = 0; }
    else if (d.auto) { d.idle += dt; if (d.idle > 2.5 && !nearDoorway(d, h.x, h.z, 1.8)) { d.target = 0; d.auto = false; } }
    if (d.target !== null) { d.vel += ((d.target - d.ang) * 28 - d.vel * 7) * dt; if (Math.abs(d.target - d.ang) < 0.02 && Math.abs(d.vel) < 0.15) d.target = null; } // someone swinging it by hand
    if (!d.held) {
      d.vel *= Math.exp(-2.2 * dt); d.ang += d.vel * dt; // hinge friction
      if (d.ang < 0) { if (d.vel < -1.2) { const v = Math.min(1, -d.vel / 4); hiss(0.07, 0.25 * v, 260); tone(80, 0.12, 'triangle', 0.08 * v); } d.ang = 0; d.vel = -d.vel * 0.15; if (Math.abs(d.vel) < 0.3) d.vel = 0; } // slams against the frame
      if (d.ang > DOOR_MAX) { d.ang = DOOR_MAX; if (d.vel > 1) hiss(0.05, 0.12, 300); d.vel = -d.vel * 0.3; } // hits its stop
    }
    if ((Math.abs(d.vel) > 0.15 || d.held) && Math.abs(h.x - d.H.x) < 5 && Math.abs(h.z - d.H.z) < 5) { const [nx, nz] = doorCollide(h.x, h.z, d); if (nx !== h.x || nz !== h.z) { dolly.position.x += nx - h.x; dolly.position.z += nz - h.z; } }
    doorIM.setMatrixAt(i, doorMatrix(d)); knobIM.setMatrixAt(i, d.m);
  });
  doorIM.instanceMatrix.needsUpdate = true; knobIM.instanceMatrix.needsUpdate = true;
}
// the player's body against door leaves: pushing from outside swings it open, otherwise it blocks
function doorCollide(nx, nz, only = null) { // only: a door that is moving by itself (it pushes the player, not the other way)
  for (const d of (only ? [only] : doors)) {
    if (Math.abs(nx - d.H.x) > 6 || Math.abs(nz - d.H.z) > 6) continue;
    const [lx, lz] = doorLocal(d, nx, nz), r = 0.35 / d.H.s, ca = Math.cos(d.ang), sa = Math.sin(d.ang);
    const px = lx + 0.7, pz = lz - DOOR_Z, t = clamp(px * ca - pz * sa, 0, DOOR_W), cx = t * ca, cz = -t * sa; // closest point on the leaf
    const ex = px - cx, ez = pz - cz, dist = Math.hypot(ex, ez); if (dist >= r || dist < 1e-6) continue;
    const pen = r - dist, side = Math.sign(px * sa + pz * ca) || 1; // +1: outside face
    const canSwing = side > 0 ? d.ang < DOOR_MAX : d.ang > 0;
    let k = 1; // how much of the overlap the player must give back
    if (canSwing && !d.held && !only) { // the leaf turns just enough to clear the body (pushing near the hinge needs more turn)
      const da = clamp(side * pen / Math.max(0.3, t), -0.25, 0.25), na = clamp(d.ang + da, 0, DOOR_MAX), done = na - d.ang;
      d.ang = na; d.vel = lerp(d.vel, done / Math.max(frameDt, 1e-3) * 0.7, 0.5); d.target = null; d.auto = false;
      k = Math.abs(da) > 1e-6 ? 1 - Math.abs(done / da) : 1; // whatever the door couldn't absorb blocks the player
    }
    const mx = (ex / dist) * pen * k, mz = (ez / dist) * pen * k, c = Math.cos(d.H.rot), sn = Math.sin(d.H.rot);
    nx += (mx * c + mz * sn) * d.H.s; nz += (-mx * sn + mz * c) * d.H.s; // back to world
  }
  return [nx, nz];
}
function doorAt(p, rad = 1.8) { return doors.find(d => { const w = houseToWorld(d.H, 0, DOOR_Z); return Math.hypot(p.x - w.x, p.z - w.z) < rad; }) || null; }
// village props used by the villagers' chores: well, chopping block, woodpile, vegetable garden
const PROPS = { well: { x: -2.5, z: 8 }, block: { x: -8.5, z: -6.5 }, woodpile: { x: -2.9, z: -2.4 }, garden: { x: 8, z: 6 } };
{
  const add = (geo, mat, x, y, z, ry = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, VH + y, z); m.rotation.y = ry; STATIC.add(m); return m; };
  const W = PROPS.well; add(new THREE.CylinderGeometry(0.75, 0.8, 0.8, 12, 1, true), WELL_STONE, W.x, 0.4, W.z); add(new THREE.CircleGeometry(0.72, 12).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0x1e3a50 }), W.x, 0.15, W.z);
  add(new THREE.BoxGeometry(0.04, 0.3, 0.04), M.wood, W.x + 0.9, 1.5, W.z); add(new THREE.CylinderGeometry(0.02, 0.02, 0.15, 5).rotateZ(Math.PI / 2), M.wood, W.x + 0.96, 1.36, W.z); // crank
  for (const sx of [-0.8, 0.8]) add(new THREE.BoxGeometry(0.1, 1.8, 0.1), M.wood, W.x + sx, 0.9, W.z);
  add(new THREE.ConeGeometry(1.1, 0.7, 4).rotateY(Math.PI / 4), M.roof, W.x, 2.1, W.z); add(new THREE.CylinderGeometry(0.05, 0.05, 1.7, 6).rotateZ(Math.PI / 2), M.wood, W.x, 1.6, W.z);
  add(new THREE.CylinderGeometry(0.012, 0.012, 0.75, 4), FM.linen, W.x + 0.2, 1.22, W.z); add(new THREE.CylinderGeometry(0.15, 0.12, 0.24, 8), M.wood, W.x + 0.2, 0.75, W.z); // rope and bucket on the crank
  addCollider(W.x, W.z, 0.95, VH + 2.3);
  const B = PROPS.block; add(new THREE.CylinderGeometry(0.35, 0.4, 0.5, 9), M.wood, B.x, 0.25, B.z); add(new THREE.CylinderGeometry(0.13, 0.13, 0.34, 7), FM.jar, B.x, 0.67, B.z); addCollider(B.x, B.z, 0.45, VH + 0.85); // stump with a log standing on it
  const P = PROPS.woodpile; for (let k = 0; k < 9; k++) add(new THREE.CylinderGeometry(0.11, 0.11, 0.9, 6).rotateZ(Math.PI / 2), M.wood, P.x, 0.11 + Math.floor(k / 4) * 0.2, P.z - 0.35 + (k % 4) * 0.23 + (Math.floor(k / 4) % 2) * 0.1);
  addCollider(P.x, P.z, 0.6, VH + 0.8);
  const G = PROPS.garden; add(new THREE.BoxGeometry(3, 0.12, 2), FM.soil, G.x, 0.06, G.z);
  for (let a = 0; a < 3; a++) for (let b = 0; b < 5; b++) add(new THREE.ConeGeometry(0.12, 0.3, 5), FM.leaf, G.x - 1.1 + b * 0.55, 0.27, G.z - 0.6 + a * 0.6);
}
// campfire
const fire = new THREE.Group();
for (let i = 0; i < 4; i++) { const l = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 1.3, 5), M.wood); l.rotation.z = Math.PI / 2; l.rotation.y = i * Math.PI / 4; l.position.set(0, VH + 0.1, 0); STATIC.add(l); }
const flames = []; let fireFlare = 0; // a log thrown in makes it blaze up for a few seconds
for (let i = 0; i < 3; i++) { const f = new THREE.Mesh(new THREE.ConeGeometry(0.3 - i * 0.07, 1 - i * 0.2, 6), i ? M.flame : M.ember); f.position.y = 0.5; fire.add(f); flames.push(f); }
for (let i = 0; i < 8; i++) { const s = new THREE.Mesh(new THREE.DodecahedronGeometry(0.22, 0), M.stone); s.position.set(Math.cos(i / 8 * 6.28) * 0.85, VH + 0.1, Math.sin(i / 8 * 6.28) * 0.85); STATIC.add(s); }
fire.position.set(0, VH, 0); scene.add(fire); addCollider(0, 0, 1.1, VH + 0.6, true);
const fireGlow = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 128; const x = c.getContext('2d'), gr = x.createRadialGradient(64, 64, 4, 64, 64, 63);
  gr.addColorStop(0, 'rgba(255,170,90,1)'); gr.addColorStop(0.35, 'rgba(255,120,50,0.45)'); gr.addColorStop(1, 'rgba(255,90,30,0)'); x.fillStyle = gr; x.fillRect(0, 0, 128, 128);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(10, 10).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0, fog: false }));
  m.position.set(0, VH + 0.04, 0); m.renderOrder = 2; scene.add(m); return m;
})();
let smokeT = 0;
function updateFireGlow(dt) {
  const night = 1 - smoothstep(-0.15, 0.25, sunElev()); // 0 by day, 1 at night
  fireGlow.material.opacity = 0.5 * night * (0.88 + 0.12 * Math.sin(time * 13) * Math.sin(time * 7.3)); fireGlow.visible = night > 0.02;
  smokeT -= dt; if (smokeT <= 0) { smokeT = 0.18; burst(_v2.set((Math.random() - 0.5) * 0.3, VH + 1.1, (Math.random() - 0.5) * 0.3), 0x2a2622, 1, 0.25, 0.6); } // thin smoke rising
}
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
  for (let i = 0; i < 6; i++) { const a = i / 6 * 6.28; const pil = new THREE.Mesh(new THREE.BoxGeometry(1, 2 + (i % 3) * 1.6, 1), M.stone); pil.position.set(Math.cos(a) * 11, 1, Math.sin(a) * 11); pil.rotation.set(rand() * 0.2, a, rand() * 0.2); g.add(pil); addCollider(T.x + Math.cos(a) * 11, T.z + Math.sin(a) * 11, 0.8, T.h + 2 + (i % 3) * 1.6); }
  g.position.set(T.x, T.h, T.z); g.rotation.y = Math.atan2(-T.x, -T.z); STATIC.add(g); addCollider(T.x, T.z, 4.6, T.h + 27);
  const lbl = makeLabel('The Ashen Tower', '#d9b3ff', 6); lbl.position.set(T.x, T.h + 31, T.z); scene.add(lbl);
}
// merge every static mesh above into one mesh per material (world space), then free the source geometries
function bakeGroup(G) {
  G.updateMatrixWorld(true); const byMat = new Map();
  G.traverse(o => { if (o.isMesh) { if (!byMat.has(o.material)) byMat.set(o.material, []); byMat.get(o.material).push({ geo: o.geometry, m: o.matrixWorld.clone() }); } });
  for (const [mat, list] of byMat) { const mesh = new THREE.Mesh(mergeGeos(list), mat); mesh.matrixAutoUpdate = false; scene.add(mesh); for (const it of list) it.geo.dispose(); }
}
bakeGroup(STATIC);

// ---------------------------------------------------------------- beacons, crystals, chests, NPCs
function beam(color) { const m = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 160, 8, 1, true), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.32, fog: false, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide })); m.visible = false; scene.add(m); return m; }
const towerBeam = beam(0xb04aff); towerBeam.position.set(SITES.tower.x, SITES.tower.h + 80, SITES.tower.z);
const STATIC2 = new THREE.Group(); // props built after the first bake
const crystals = ['c0', 'c1', 'c2'].map((k, i) => {
  const s = SITES[k]; const g = new THREE.Group();
  const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.55, 0), new THREE.MeshBasicMaterial({ color: 0xffd84a })); gem.scale.y = 1.6; gem.position.y = 1.6; g.add(gem);
  for (let j = 0; j < 7; j++) { const a = j / 7 * 6.28; const st = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1 + rand() * 1.4, 0.6), M.stone); st.position.set(Math.cos(a) * 3.2, 0.5, Math.sin(a) * 3.2); g.add(st); }
  g.position.set(s.x, s.h, s.z); scene.add(g); g.updateMatrixWorld(true); for (const st of g.children.filter(c => c !== gem)) STATIC2.attach(st); // standing stones are baked
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
    g.updateMatrixWorld(true); STATIC2.attach(base); // the box is static; only the lid moves
    chests.push({ idx, x, z, g, lid, opened });
  }
  bakeGroup(STATIC2);
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
// Faces for people: an oval head, eyes with whites and pupils (they blink), brows, nose, ears, a mouth that moves
// when talking, and hair or a hat. Eyes and mouth are separate groups so they can animate; everything else merges.
const FACE = { white: new THREE.MeshLambertMaterial({ color: 0xf2eee6 }), pupil: new THREE.MeshBasicMaterial({ color: 0x1a1410 }), lips: new THREE.MeshLambertMaterial({ color: 0x7a3a34 }) };
const FG = {
  head: new THREE.SphereGeometry(0.12, 20, 14), eyeW: new THREE.SphereGeometry(0.0175, 10, 8), pupil: new THREE.SphereGeometry(0.0095, 8, 6),
  beard: new THREE.SphereGeometry(0.118, 16, 8, -Math.PI * 0.32, Math.PI * 1.64, Math.PI * 0.6, Math.PI * 0.4), // the lower face, front and sides
  stache: new THREE.BoxGeometry(0.07, 0.016, 0.02),
  nose: new THREE.ConeGeometry(0.017, 0.05, 6), ear: new THREE.SphereGeometry(0.026, 8, 6), brow: new THREE.BoxGeometry(0.042, 0.009, 0.012),
  mouth: new THREE.BoxGeometry(0.045, 0.008, 0.01), hairCap: new THREE.SphereGeometry(0.128, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.55),
};
const EYES_W = mergeGeos([-1, 1].map(sx => ({ geo: FG.eyeW, m: new THREE.Matrix4().makeTranslation(sx * 0.04, 0, 0) }))), EYES_P = mergeGeos([-1, 1].map(sx => ({ geo: FG.pupil, m: new THREE.Matrix4().makeTranslation(sx * 0.04, 0, 0.0115) })));
function addFace(r, o) {
  const f = o.face, skin = o.skin, head = r.head, sk = r.skull;
  sk.geometry = FG.head; sk.scale.set(0.93, 1.08, 0.98); // a little taller than wide
  const eyes = new THREE.Group(); eyes.position.set(0, 0.13, 0.098); head.add(eyes); // blink by squashing this group
  eyes.add(new THREE.Mesh(EYES_W, FACE.white), new THREE.Mesh(EYES_P, FACE.pupil)); // both eyes in two meshes
  const mouth = new THREE.Group(); mouth.position.set(0, 0.062, 0.108); head.add(mouth); _hm(FG.mouth, FACE.lips, mouth);
  const hairMat = f.hair ? npcMat(f.hair) : null;
  for (const sx of [-1, 1]) { const b = _hm(FG.brow, hairMat || FACE.pupil, head, sx * 0.043, 0.165, 0.107); b.rotation.z = -sx * (f.brow ?? 0.12); }
  const nose = _hm(FG.nose, skin, head, 0, 0.1, 0.122); nose.rotation.x = Math.PI / 2 + 0.35;
  for (const sx of [-1, 1]) _hm(FG.ear, skin, head, sx * 0.112, 0.12, 0).scale.set(0.45, 1, 0.75);
  if (hairMat && f.style !== 'bald') { const cap = _hm(FG.hairCap, hairMat, head, 0, 0.13, -0.01); cap.rotation.x = -0.35; cap.scale.set(0.97, 1.05, 1.02); }
  if (f.style === 'long') _hm(new THREE.BoxGeometry(0.2, 0.2, 0.05), hairMat, head, 0, 0.05, -0.1);
  if (f.style === 'bun') _hm(new THREE.SphereGeometry(0.05, 10, 8), hairMat, head, 0, 0.19, -0.11);
  if (f.beard) { const bm = npcMat(f.beard); const bd = _hm(FG.beard, bm, head, 0, 0.115, 0.006); bd.rotation.y = Math.PI / 2; bd.scale.set(0.98, 1.1, 1.02); _hm(FG.stache, bm, head, 0, 0.074, 0.115); mouth.position.z = 0.122; } // jaw beard and moustache; lips still show
  if (f.hat === 'straw') { const hm = npcMat(0xd8c070); _hm(new THREE.CylinderGeometry(0.26, 0.26, 0.012, 18), hm, head, 0, 0.215, 0); _hm(new THREE.CylinderGeometry(0.1, 0.12, 0.09, 14), hm, head, 0, 0.26, 0); }
  if (f.hat === 'scarf') { const cap = _hm(FG.hairCap, npcMat(f.hatColor || 0xe8e0d0), head, 0, 0.135, -0.012); cap.rotation.x = -0.45; cap.scale.setScalar(1.06); }
  if (f.hat === 'knit') { const cap = _hm(FG.hairCap, npcMat(f.hatColor || 0x8a3a2a), head, 0, 0.155, -0.005); cap.rotation.x = -0.2; cap.scale.set(1.03, 0.9, 1.03); }
  // clothing details on the torso
  if (f.belt) _hm(new THREE.CylinderGeometry(0.17 * (o.chestW || 1), 0.17 * (o.chestW || 1), 0.04, 14), npcMat(0x3a2414), r.upper, 0, 0.17).scale.z = 0.8;
  if (f.skirt) _hm(new THREE.CylinderGeometry(0.17, 0.3, 0.6, 12), npcMat(f.skirt), r.upper, 0, -0.26);
  if (f.apron) _hm(new THREE.BoxGeometry(0.3, 0.55, 0.015), npcMat(f.apron), r.upper, 0, 0.05, 0.13);
  r.eyes = eyes; r.mouth = mouth;
}
// eyes blink every few seconds; the mouth moves while talking
function animateFace(n, dt, talking) {
  const r = n.r; if (!r.eyes) return; const h = headPos(), near = Math.abs(h.x - n.x) + Math.abs(h.z - n.z) < 14; r.eyes.visible = r.mouth.visible = near; if (!near) return;
  n.blinkT = (n.blinkT ?? 1 + Math.random() * 3) - dt; if (n.blinkT <= 0) n.blinkT = 2 + Math.random() * 4;
  r.eyes.scale.y = n.blinkT < 0.13 ? 0.12 : 1;
  r.mouth.scale.y = talking ? 1 + Math.abs(Math.sin(n.t * 13)) * 2.6 : 1;
}
// o: { skin, top, legs, boots, eye, chestW, hunch, face }
function makeHumanoid(o) {
  const g = new THREE.Group(), cw = o.chestW || 1;
  const upper = new THREE.Group(); upper.position.y = HUM.hip; g.add(upper);
  const chest = _hm(HG.chest, o.top, upper, 0, 0.38); chest.scale.set(1.3 * cw, 1, 0.82);
  const pelvis = _hm(HG.pelvis, o.legs, upper, 0, 0.06); pelvis.scale.set(1.25 * cw, 1, 0.85);
  _hm(HG.neck, o.skin, upper, 0, 0.63);
  const head = new THREE.Group(); head.position.y = 0.68; upper.add(head);
  const skull = _hm(HG.head, o.skin, head, 0, 0.12);
  const skullPt = new THREE.Object3D(); skullPt.position.y = 0.12; head.add(skullPt); // survives mesh merging
  if (o.eye && !o.face) for (const sx of [-1, 1]) _hm(HG.eye, o.eye, skull, sx * 0.045, 0.01, 0.105);
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
  const rig = { g, upper, chest, head, skull, skullPt, arms, fore, hands, legs, shins, hunch };
  if (o.face) addFace(rig, o);
  return rig;
}
// Merge the meshes inside each body-part pivot that share a material into one mesh (fewer draw calls: a gloomling
// goes from ~22 meshes to ~12). Pivots stay separate so animation and ragdolls still work. Merged geometry is
// cached per enemy type, so every enemy of a type shares it (nothing to dispose per enemy).
const _mergeCache = new Map();
function mergeGeos(list) { // list: [{ geo, m: Matrix4, color? }] -> one non-indexed geometry with position + normal (+ colour if parts carry one)
  const parts = list.map(({ geo, m }) => { const g = (geo.index ? geo.toNonIndexed() : geo.clone()); g.applyMatrix4(m); return g; });
  let n = 0; for (const g of parts) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), colored = list.some(l => l.color) || parts.some(g => g.attributes.color), col = colored ? new Float32Array(n * 3) : null; let o = 0;
  parts.forEach((g, k) => { const c = g.attributes.position.count; pos.set(g.attributes.position.array, o * 3); if (g.attributes.normal) nor.set(g.attributes.normal.array, o * 3);
    if (col && !list[k].color && g.attributes.color) col.set(g.attributes.color.array.subarray(0, c * 3), o * 3); // already vertex-coloured (e.g. a merged body part)
    else if (col) { const cc = list[k].color || WHITE; for (let v = 0; v < c; v++) { col[(o + v) * 3] = cc.r; col[(o + v) * 3 + 1] = cc.g; col[(o + v) * 3 + 2] = cc.b; } }
    o += c; g.dispose(); });
  const out = new THREE.BufferGeometry(); out.setAttribute('position', new THREE.BufferAttribute(pos, 3)); out.setAttribute('normal', new THREE.BufferAttribute(nor, 3)); if (col) out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.computeBoundingSphere(); return out;
}
// Every plain-coloured part of a body pivot is baked into ONE mesh with per-vertex colour (one draw call per pivot,
// whatever the hair, hat, beard or clothes). Glowing or special materials stay grouped by material. opts.mat: the
// vertex-colour material to use (enemies pass their own so hit flashes still work); opts.keepHands: don't fold hands.
const VC_SMOOTH = new THREE.MeshLambertMaterial({ vertexColors: true }), VC_FLAT = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
function mergeRig(r, cacheKey, opts = {}) {
  const pivots = [r.upper, r.head, ...r.arms, ...r.fore, ...r.legs, ...r.shins], into = new Set(opts.keepHands ? [] : r.hands);
  const vcMat = opts.mat || VC_SMOOTH;
  pivots.forEach((pv, pi) => {
    const recs = [];
    const walk = (obj, rel) => { for (const c of obj.children) {
      if (c.isMesh) { c.updateMatrix(); const m = rel.clone().multiply(c.matrix); recs.push({ mesh: c, m }); walk(c, m); }
      else if (into.has(c)) { c.updateMatrix(); walk(c, rel.clone().multiply(c.matrix)); } // hand groups fold into the forearm
    } };
    walk(pv, new THREE.Matrix4());
    if (!recs.length) return;
    const plain = recs.filter(rc => rc.mesh.material.isMeshLambertMaterial && !rc.mesh.material.vertexColors && !rc.mesh.material.transparent);
    const byMat = new Map(); for (const rc of recs) if (!plain.includes(rc)) { if (!byMat.has(rc.mesh.material)) byMat.set(rc.mesh.material, []); byMat.get(rc.mesh.material).push(rc); }
    for (const rc of recs) rc.mesh.removeFromParent();
    if (plain.length) { const key = cacheKey + ':' + pi + ':vc'; if (!_mergeCache.has(key)) _mergeCache.set(key, mergeGeos(plain.map(rc => ({ geo: rc.mesh.geometry, m: rc.m, color: rc.mesh.material.color })))); pv.add(new THREE.Mesh(_mergeCache.get(key), vcMat)); }
    let slot = 0;
    for (const [mat, list] of byMat) {
      const key = cacheKey + ':' + pi + ':' + (slot++);
      if (!_mergeCache.has(key)) _mergeCache.set(key, mergeGeos(list.map(rc => ({ geo: rc.mesh.geometry, m: rc.m }))));
      pv.add(new THREE.Mesh(_mergeCache.get(key), mat));
    }
  });
  r.chest = null; // merged away
}
// walk cycle: amp 0..1 stride, lf 0..1 attack lunge (both arms swing forward)
function animateHumanoid(r, walk, amp, lf = 0) {
  const sw = Math.sin(walk) * amp * 0.65, c = Math.cos(walk);
  r.legs[0].rotation.x = -sw; r.legs[1].rotation.x = sw;
  r.shins[0].rotation.x = 0.08 + Math.max(0, c) * amp * 1.1; r.shins[1].rotation.x = 0.08 + Math.max(0, -c) * amp * 1.1;
  r.arms[0].rotation.x = sw * 0.8 - lf * 2.2; r.arms[1].rotation.x = -sw * 0.8 - lf * 2.2;
  r.fore[0].rotation.x = r.fore[1].rotation.x = -0.25 - amp * 0.35 - lf * 0.5;
  r.upper.position.y = HUM.hip + (Math.abs(Math.cos(walk)) - 1) * 0.035 * amp; // body rises over the planted leg, dips between steps
}
const wrapAng = a => Math.atan2(Math.sin(a), Math.cos(a));

function makeNPC(name, look, x, z, faceAng, collide = true) {
  const r = makeHumanoid(look), g = r.g;
  const label = makeLabel(name); label.position.y = 2.25; g.add(label);
  const mark = makeLabel('!', '#ffd84a', 2.4); mark.position.y = 2.75; mark.visible = false; g.add(mark);
  g.position.set(x, heightAt(x, z), z); g.rotation.y = faceAng; scene.add(g); if (collide) addCollider(x, z, 0.45, 1e9, true); // soft: blocks walking, not arrows
  return { name, g, r, head: r.head, label, mark, x, z, face: faceAng, yaw: faceAng, talk: 0, t: Math.random() * 6 };
}
const npcMat = c => new THREE.MeshLambertMaterial({ color: c });
const SKIN = npcMat(0xe0b48a), BOOTS = npcMat(0x3a2a1a), NPC_EYE = new THREE.MeshBasicMaterial({ color: 0x1a1410 });
const elder = makeNPC('Elder Maren', { skin: SKIN, top: npcMat(0x3b5ba8), legs: npcMat(0x2c3f78), boots: BOOTS, eye: NPC_EYE, chestW: 0.9, face: { hair: 0xe8e4dc, style: 'bald', brow: 0.2, belt: true } }, 3.5, -4, 0.6);
{ // long robe, white hair and beard, staff in the hand
  const robeMat = elder.r.chest.material, white = npcMat(0xe8e4dc);
  const skirt = _hm(new THREE.CylinderGeometry(0.19, 0.33, 0.82, 10), robeMat, elder.r.upper, 0, -0.37);
  const hair = _hm(FG.hairCap, white, elder.r.head, 0, 0.125, -0.025); hair.rotation.x = -0.8; hair.scale.setScalar(1.02); // thinning white hair at the back
  const beard = _hm(FG.beard, white, elder.r.head, 0, 0.11, 0.008); beard.rotation.y = Math.PI / 2; beard.scale.set(0.98, 1.35, 1.03); _hm(FG.stache, white, elder.r.head, 0, 0.074, 0.115); elder.r.mouth.position.z = 0.122;
  elder.staff = _hm(new THREE.CylinderGeometry(0.03, 0.035, 1.9, 6), M.wood, elder.r.hands[1], 0, -0.12, 0.02); // rests on the ground
  _hm(new THREE.IcosahedronGeometry(0.07, 0), new THREE.MeshBasicMaterial({ color: 0xffd27a }), elder.staff, 0, 0.98, 0);
  elder.r.arms[1].rotation.x = -0.3; elder.r.fore[1].rotation.x = -0.95; elder.skirt = skirt;
}
const anvil = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.6, 0.4), M.stone); anvil.position.set(-6.2, VH + 0.3, 4.4); scene.add(anvil);
const smith = makeNPC('Smith Tovik', { skin: SKIN, top: npcMat(0x7a3b1e), legs: npcMat(0x3b3026), boots: BOOTS, eye: NPC_EYE, chestW: 1.2, face: { hair: 0x3a2414, style: 'bald', brow: 0.05 } }, -6.15, 3.8, Math.atan2(-6.2 + 6.15, 4.4 - 3.8));
{ const bar = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.03, 0.04), new THREE.MeshLambertMaterial({ color: 0x552200, emissive: 0xff6a1a })); bar.position.set(-6.2, VH + 0.615, 4.38); scene.add(bar); } // hot metal on the anvil
{ // leather apron, dark beard, hammer
  const leather = npcMat(0x4a2a14), brown = npcMat(0x3a2414);
  const apron = _hm(new THREE.BoxGeometry(0.34, 0.62, 0.02), leather, smith.r.upper, 0, 0.18, 0.135); apron.rotation.x = -0.05;
  const beard = _hm(FG.beard, brown, smith.r.head, 0, 0.115, 0.006); beard.rotation.y = Math.PI / 2; beard.scale.set(0.98, 1.15, 1.02); _hm(FG.stache, brown, smith.r.head, 0, 0.074, 0.115); smith.r.mouth.position.z = 0.122;
  smith.hammer = new THREE.Group(); smith.hammer.position.set(0, -0.02, 0); smith.r.hands[0].add(smith.hammer); // right hand (the rig faces +Z, so its right is -X: hands[0])
  for (const sx of [-0.012, 0.012]) _hm(new THREE.BoxGeometry(0.008, 0.008, 0.38), M.dark, smith.r.hands[1], sx, -0.02, 0.17); // tongs in the left
  _hm(new THREE.CylinderGeometry(0.018, 0.018, 0.42, 5), M.wood, smith.hammer, 0, 0, 0.15).rotation.x = Math.PI / 2;
  _hm(new THREE.BoxGeometry(0.07, 0.17, 0.07), M.stone, smith.hammer, 0, -0.02, 0.36); // head across the handle, face striking the anvil
}
mergeRig(elder.r, 'npc:elder', { keepHands: true }); mergeRig(smith.r, 'npc:smith', { keepHands: true });
const npcs = [elder, smith];
// ---------------------------------------------------------------- villagers with daily chores
// Each villager loops through a list of tasks: walk to a spot (through house doors when going in or out, around the
// campfire), then do a chore animation there for a while. At night everyone goes home and sleeps in their bed.
const nearestHouse = (x, z) => HOUSES.reduce((b, H) => Math.hypot(H.x - x, H.z - z) < Math.hypot(b.x - x, b.z - z) ? H : b, HOUSES[0]);
const inHouse = (H, lx, lz) => { const w = houseToWorld(H, lx, lz); return { x: w.x, z: w.z, house: H }; };
const doorOut = H => inHouse(H, 0, 3.2), doorIn = H => inHouse(H, 0, 1.0);
const PROP_STEEL = new THREE.MeshLambertMaterial({ color: 0xc8ccd4, emissive: 0x111111 });
function propMesh(kind) { // tools and carried things, held in the right hand (hand space: -Y runs along the fingers, +Z forward)
  const g = new THREE.Group(), pole = (len, mat = M.wood) => { const m = _hm(new THREE.CylinderGeometry(0.018, 0.018, len, 5), mat, g, 0, 0, len / 2 - 0.08); m.rotation.x = Math.PI / 2; return m; };
  if (kind === 'axe') { g.rotation.x = 0.45; pole(0.7); _hm(new THREE.BoxGeometry(0.035, 0.1, 0.1), M.stone, g, 0, -0.04, 0.56); _hm(new THREE.BoxGeometry(0.014, 0.035, 0.15), PROP_STEEL, g, 0, -0.105, 0.56); } // head forward of the handle, sharp edge leading the chop
  if (kind === 'hoe') { g.rotation.x = 1.0; pole(1.2); _hm(new THREE.BoxGeometry(0.16, 0.13, 0.015), M.stone, g, 0, -0.07, 1.08); } // blade at a right angle to the handle, biting toward the soil
  if (kind === 'broom') { g.rotation.x = 1.45; pole(1.1); _hm(new THREE.ConeGeometry(0.1, 0.3, 6), FM.jar, g, 0, 0, 1.08).rotation.x = -Math.PI / 2; }
  if (kind === 'spoon') { g.rotation.x = Math.PI; pole(0.36); _hm(new THREE.SphereGeometry(0.035, 6, 4), M.wood, g, 0, -0.01, 0.27).scale.set(1, 0.45, 1.3); }
  if (kind === 'bucket') { _hm(new THREE.CylinderGeometry(0.13, 0.1, 0.22, 8), M.wood, g, 0, -0.2, 0); _hm(new THREE.TorusGeometry(0.12, 0.008, 4, 8, Math.PI), M.dark, g, 0, -0.09, 0); }
  if (kind === 'basket') { _hm(new THREE.CylinderGeometry(0.2, 0.15, 0.16, 8), FM.jar, g, 0, -0.25, 0); for (let k = 0; k < 4; k++) _hm(new THREE.SphereGeometry(0.05, 6, 4), FM.leaf, g, (k - 1.5) * 0.07, -0.15, 0); _hm(new THREE.TorusGeometry(0.18, 0.01, 4, 8, Math.PI), FM.jar, g, 0, -0.17, 0); }
  if (kind === 'log') { _hm(new THREE.CylinderGeometry(0.11, 0.11, 0.6, 6), M.wood, g, 0, -0.02, 0.15).rotation.z = Math.PI / 2; }
  g.visible = false; return g;
}
const villagers = [];
// r: preferred clearance; core: the solid part plus half a body width, never walked through
const OBSTACLES = [...HOUSES.map(H => ({ x: H.x, z: H.z, r: 3.4 * H.s, core: 2.9 * H.s })), { x: 0, z: 0, r: 2.2, core: 1.4 }, { x: PROPS.well.x, z: PROPS.well.z, r: 1.5, core: 1.25 }, { x: PROPS.woodpile.x, z: PROPS.woodpile.z, r: 1.2, core: 0.8 },
  { x: PROPS.block.x, z: PROPS.block.z, r: 0.9, core: 0.6 }, { x: elder.x, z: elder.z, r: 0.8, core: 0.5 }, { x: smith.x, z: smith.z, r: 0.8, core: 0.5 }, { x: anvil.position.x, z: anvil.position.z, r: 0.7, core: 0.55 }];
function makeVillager(def) {
  const n = makeNPC(def.name, def.look, def.home.x, def.home.z, 0, false);
  n.g.rotation.order = 'YXZ'; if (def.scale) n.g.scale.setScalar(def.scale);
  Object.assign(n, { home: def.home, day: def.day, lines: def.lines, speed: def.speed || 1.2, baseSpeed: def.speed || 1.2, task: -1, tasks: null, route: [], timer: 0, act: 'idle', prop: null, props: {}, lineI: 0, beat: 0 });
  for (const k of ['axe', 'hoe', 'broom', 'spoon', 'bucket', 'basket', 'log']) { n.props[k] = propMesh(k); n.r.hands[0].add(n.props[k]); } // right hand
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
  // R = right arm (holds the tool), L = left arm. The rig faces +Z, so the right side is -X (index 0).
  const r = n.r, sw = Math.sin(t * 3), R = 0, L = 1;
  r.upper.rotation.set(r.hunch, 0, 0); r.upper.position.y = HUM.hip; n.g.rotation.x = 0;
  for (const s of [0, 1]) { r.arms[s].rotation.z = (s ? 1 : -1) * 0.12; r.legs[s].rotation.x = 0; r.shins[s].rotation.x = 0.08; }
  const twoHands = () => { r.arms[R].rotation.z = 0.3; r.arms[L].rotation.z = -0.42; r.arms[L].rotation.x += 0.15; }; // both hands on the handle, the left one lower
  if (act === 'chop' || act === 'hoe') { // raise slowly, strike fast
    const per = act === 'chop' ? 1.3 : 1.0, p = (t % per) / per, up = p < 0.72 ? smoothstep(0, 0.72, p) : 1 - (p - 0.72) / 0.28, big = act === 'chop' ? 2.3 : 1.4;
    for (const s of [0, 1]) { r.arms[s].rotation.x = -0.4 - up * big; r.fore[s].rotation.x = -0.35; }
    twoHands();
    r.upper.rotation.x = r.hunch + 0.15 + (1 - up) * (act === 'hoe' ? 0.45 : 0.3);
    if (n.beat > 0.9 && p < 0.1) { // the blade lands: chips or soil fly from where it hits
      const h = headPos(), d = Math.hypot(h.x - n.x, h.z - n.z);
      if (d < 14) { const tool = n.props[act === 'chop' ? 'axe' : 'hoe'], hit = tool.children[tool.children.length - 1].getWorldPosition(_v2), v = 1 - d / 14;
        burst(hit, act === 'chop' ? 0xc9a36a : 0x6a4a2a, 6, 1.5, 0.8);
        if (act === 'chop') { hiss(0.08, 0.3 * v, 900); tone(110, 0.08, 'triangle', 0.08 * v); } else hiss(0.07, 0.18 * v, 500); }
    }
    n.beat = p;
  } else if (act === 'sweep') { // broom low on the ground, swept side to side with both hands
    r.arms[R].rotation.x = -0.75; r.arms[L].rotation.x = -0.55; r.fore[R].rotation.x = r.fore[L].rotation.x = -0.3;
    r.arms[R].rotation.z = 0.3 + sw * 0.2; r.arms[L].rotation.z = -0.42 + sw * 0.2; r.upper.rotation.y = sw * 0.25; r.upper.rotation.x = r.hunch + 0.2;
  } else if (act === 'stir') { // spoon down into the pot
    r.arms[R].rotation.x = -1.0 + Math.sin(t * 4) * 0.15; r.arms[R].rotation.z = -0.12 - Math.cos(t * 4) * 0.2; r.fore[R].rotation.x = -0.8;
    r.arms[L].rotation.x = -0.1; r.fore[L].rotation.x = -0.3; r.upper.rotation.x = r.hunch + 0.15;
  } else if (act === 'pull') { // turning the well's crank with the right hand, steadying with the left
    r.arms[R].rotation.x = -1.3 + Math.sin(t * 3) * 0.35; r.fore[R].rotation.x = -0.6 + Math.cos(t * 3) * 0.35; r.arms[L].rotation.x = -0.9; r.fore[L].rotation.x = -0.7;
  } else if (act === 'tend') { // kneeling on both knees, picking
    r.upper.rotation.x = r.hunch + 0.85; for (const s of [0, 1]) { r.arms[s].rotation.x = -0.9 + Math.sin(t * 2.5 + s * 2) * 0.35; r.fore[s].rotation.x = -0.3; r.legs[s].rotation.x = -0.15; r.shins[s].rotation.x = 1.6; }
  } else if (act === 'warm') { for (const s of [0, 1]) { r.arms[s].rotation.x = -1.05 + Math.sin(t * 1.3 + s) * 0.05; r.fore[s].rotation.x = -0.35; } }
  else if (act === 'stack') { r.upper.rotation.x = r.hunch + 0.7; for (const s of [0, 1]) { r.arms[s].rotation.x = -1.1; r.fore[s].rotation.x = -0.6; } }
  else if (act === 'wave') { r.arms[L].rotation.x = -2.9; r.arms[L].rotation.z = 0.3 + Math.sin(t * 9) * 0.35; r.fore[L].rotation.x = -0.3; r.arms[R].rotation.x = 0; }
  else if (act === 'cower') { r.upper.rotation.x = r.hunch + 0.55; for (const s of [0, 1]) { r.legs[s].rotation.x = -1.1; r.shins[s].rotation.x = 1.7; r.arms[s].rotation.x = -2.5 + Math.sin(t * 7 + s) * 0.05; r.arms[s].rotation.z = (s ? 1 : -1) * 0.45; r.fore[s].rotation.x = -1.5; } }
  else if (act === 'sit') { for (const s of [0, 1]) { r.legs[s].rotation.x = -1.5; r.shins[s].rotation.x = 1.5; r.arms[s].rotation.x = -0.75; r.fore[s].rotation.x = -0.5; } }
  else if (act === 'sleep') { n.g.rotation.x = -Math.PI / 2; for (const s of [0, 1]) { r.arms[s].rotation.x = 0; r.fore[s].rotation.x = -0.1; } }
  else { for (const s of [0, 1]) { r.arms[s].rotation.x = -0.05; r.fore[s].rotation.x = -0.2; } r.upper.rotation.z = Math.sin(t * 0.7) * 0.025; } // idle, shifting weight
}
// Villagers react to the world: they run home and take cover when Gloom creatures come near the village, flinch
// (and complain) when a blade or arrow comes too close, greet you as you pass, step out of each other's way, and
// blend smoothly between poses instead of snapping.
let villageAlarm = 0, alarmScan = 0;
const FLINCH_LINES = ['Hey! Watch that blade!', 'Careful, warden!', 'Not at me!', 'Whoa - mind where you swing that!'];
function villagerFlinch(n, line) {
  if ((n.flinchCd || 0) > 0 || n.act === 'sleep') return;
  n.flinch = 0.8; n.flinchCd = 3; tone(420, 0.12, 'triangle', 0.06, 160);
  toast(`${n.name}: "${line || FLINCH_LINES[Math.floor(Math.random() * FLINCH_LINES.length)]}"`, 3, true);
}
function poseJoints(n) { // the joints that get smoothed between poses
  if (!n.jl) { const r = n.r; n.jl = [[r.upper.rotation, 'x'], [r.upper.rotation, 'y'], [n.g.rotation, 'x']]; for (const s of [0, 1]) n.jl.push([r.arms[s].rotation, 'x'], [r.arms[s].rotation, 'z'], [r.fore[s].rotation, 'x'], [r.legs[s].rotation, 'x'], [r.shins[s].rotation, 'x']); n.mem = n.jl.map(([o, a]) => o[a]); }
  return n.jl;
}
function updateVillagers(dt) {
  const night = isNight(), h = headPos();
  alarmScan -= dt; if (alarmScan <= 0) { // once a second: is anything dangerous near the village?
    alarmScan = 1; const near = enemies.some(e => !e.dead && Math.hypot(e.x, e.z) < 38);
    if (near && villageAlarm <= 0 && !night) toast('The villagers run for cover - something is prowling near the village!', 3.5);
    villageAlarm = near ? 6 : Math.max(0, villageAlarm - 1);
  }
  for (const n of villagers) {
    const mode = night ? 'night' : villageAlarm > 0 ? 'alarm' : 'day';
    if (n.tasks === null || n.mode !== mode) { // switch routine: day chores, hiding indoors, or bed
      n.mode = mode; n.task = -1;
      n.tasks = mode === 'night' ? [{ at: inHouse(n.home, -1.8, 0.15), act: 'sleep', dur: 1e9, face: 0, local: true }]
        : mode === 'alarm' ? [{ at: inHouse(n.home, 0.3, -0.5), act: 'cower', dur: 1e9, face: Math.PI, local: true }] : n.day;
      n.speed = mode === 'alarm' ? n.baseSpeed * 1.8 : n.baseSpeed; nextTask(n);
    }
    n.t += dt; n.talk = Math.max(0, n.talk - dt); n.flinch = Math.max(0, (n.flinch || 0) - dt); n.flinchCd = Math.max(0, (n.flinchCd || 0) - dt);
    n.greetCd = Math.max(0, (n.greetCd || 0) - dt); n.greet = Math.max(0, (n.greet || 0) - dt);
    const t = n.tasks[n.task], dxp = h.x - n.x, dzp = h.z - n.z, dp = Math.hypot(dxp, dzp);
    if (dp < 4.5 && n.greetCd <= 0 && mode === 'day' && n.act !== 'sleep') { n.greetCd = 180; n.greet = 1.6; tone(520, 0.08, 'sine', 0.04); tone(660, 0.1, 'sine', 0.04, 0, 0.09); }
    let yawTarget = n.yaw;
    if (n.talk > 0 && n.act !== 'sleep') { yawTarget = Math.atan2(dxp, dzp); chorePose(n, n.act === 'sit' ? 'sit' : 'idle', n.t, dt); n.r.arms[1].rotation.x = -0.6 - Math.sin(n.t * 3.1) * 0.2; n.r.fore[1].rotation.x = -0.7; }
    else if (n.route.length) { // walking
      const q = n.route[0], dx = q.x - n.x, dz = q.z - n.z, d = Math.hypot(dx, dz);
      const ahead = dp < 0.9 && (dxp * dx + dzp * dz) > 0; // someone (you) right in the way: wait a moment
      const step = ahead ? 0 : n.speed * dt;
      if (d <= step) { n.x = q.x; n.z = q.z; n.route.shift(); } else if (step > 0) { n.x += dx / d * step; n.z += dz / d * step; }
      if (d > 0.01) yawTarget = Math.atan2(dx, dz);
      for (const o of villagers) { if (o === n) continue; const ox = n.x - o.x, oz = n.z - o.z, d2 = ox * ox + oz * oz; if (d2 < 0.49 && d2 > 1e-4) { const dd = Math.sqrt(d2); n.x += ox / dd * (0.7 - dd) * 0.5; n.z += oz / dd * (0.7 - dd) * 0.5; } } // step around each other
      // stride-matched walk: legs cycle at the real speed so feet don't skate
      const sc = n.g.scale.x, amp = step > 0 ? Math.min(1, n.speed / (1.4 * sc)) : 0, stride = Math.max(0.12, 2 * 0.85 * sc * Math.sin(0.65 * Math.max(amp, 0.25)));
      n.walk = (n.walk || 0) + (step > 0 ? dt * Math.PI * n.speed / stride : 0);
      chorePose(n, 'idle', n.t, dt); animateHumanoid(n.r, n.walk, amp, 0);
      if (t.carry === 'log') for (const s of [0, 1]) { n.r.arms[s].rotation.x = -0.9; n.r.fore[s].rotation.x = -0.9; }
      else if (t.carry) { n.r.arms[0].rotation.x = -0.12; n.r.fore[0].rotation.x = -0.15; n.r.arms[0].rotation.z = -0.2; }
      if (!n.route.length) { n.act = t.act; for (const k in n.props) n.props[k].visible = k === (t.prop || t.carry); } // what was carried stays in hand
    } else { // doing the chore
      n.act = t.act; yawTarget = t.local ? t.at.house.rot + t.face : t.face; chorePose(n, n.act, n.t, dt);
      if (t.act === 'stack' && n.timer < t.dur * 0.4) n.props.log.visible = false; // the log goes onto the pile
      n.timer -= dt; if (n.timer <= 0) nextTask(n);
    }
    if (n.flinch > 0) { const r = n.r; for (const s of [0, 1]) { r.arms[s].rotation.x = -1.9; r.arms[s].rotation.z = (s ? 1 : -1) * 0.5; r.fore[s].rotation.x = -1.2; } r.upper.rotation.x = r.hunch - 0.25; yawTarget = Math.atan2(dxp, dzp); }
    else if (n.greet > 0 && n.act !== 'sit') { n.r.arms[1].rotation.x = -2.8; n.r.arms[1].rotation.z = 0.3 + Math.sin(n.t * 9) * 0.3; n.r.fore[1].rotation.x = -0.3; }
    // blend toward this frame's pose instead of snapping (the walk cycle is fast enough to survive the filter)
    const k = 1 - Math.exp(-dt * 12), jl = poseJoints(n);
    for (let j = 0; j < jl.length; j++) { const [o, a] = jl[j]; const v = n.mem[j] + (o[a] - n.mem[j]) * k; o[a] = v; n.mem[j] = v; }
    n.yaw += wrapAng(yawTarget - n.yaw) * Math.min(1, dt * 5); n.g.rotation.y = n.yaw; n.label.visible = n.act !== 'sleep';
    // head follows the player when close and awake
    const look = dp < 4 && n.act !== 'sleep' ? THREE.MathUtils.clamp(wrapAng(Math.atan2(dxp, dzp) - n.yaw), -1.1, 1.1) : 0;
    n.head.rotation.y = lerp(n.head.rotation.y, look, Math.min(1, dt * 4));
    const sc = n.g.scale.x, lift = n.act === 'sit' ? -0.45 * sc : n.act === 'tend' ? -0.4 * sc : n.act === 'sleep' ? 0.5 * n.home.s : n.act === 'cower' ? -0.35 * sc : 0;
    n.lift = lerp(n.lift ?? lift, lift, Math.min(1, dt * 6)); animateFace(n, dt, n.talk > 0 || n.greet > 0);
    if (n.act === 'sleep' && n.r.eyes) n.r.eyes.scale.y = 0.12; // asleep: eyes closed
    n.g.position.set(n.x, groundAt(n.x, n.z) + n.lift, n.z);
  }
}
const H_GARDEN = nearestHouse(PROPS.garden.x, PROPS.garden.z), H_BLOCK = nearestHouse(PROPS.block.x, PROPS.block.z);
const H_WELL = nearestHouse(PROPS.well.x, PROPS.well.z), H_KID = HOUSES.find(Hh => ![H_GARDEN, H_BLOCK, H_WELL].includes(Hh)) || HOUSES[0];
const spot = (x, z) => ({ x, z }), faceTo = (fx, fz, tx, tz) => Math.atan2(tx - fx, tz - fz);
const VG = PROPS.garden, VB = PROPS.block, VW = PROPS.well, VP = PROPS.woodpile;
makeVillager({ name: 'Farmer Odile', home: H_GARDEN, look: { skin: npcMat(0xc99a72), top: npcMat(0x5a7a3a), legs: npcMat(0x4a3a2a), boots: BOOTS, eye: NPC_EYE, chestW: 0.9, face: { hair: 0x6a4428, style: 'bun', hat: 'straw', belt: true, skirt: 0x6a5a3a } },
  day: [
    { at: spot(VG.x - 0.5, VG.z + 1.4), act: 'hoe', prop: 'hoe', dur: 14, face: Math.PI },
    { at: spot(VG.x + 0.6, VG.z + 1.3), act: 'tend', dur: 8, face: Math.PI },
    { at: inHouse(H_GARDEN, 0.55, 0.6), act: 'sit', carry: 'basket', dur: 9, face: Math.PI / 2, local: true },
  ], lines: ['The soil here is stubborn, but the turnips don\'t mind.', 'Keep the Gloom out of my garden, warden!', 'Fresh greens for Ines\'s soup - nothing better.'] });
makeVillager({ name: 'Woodcutter Bram', home: H_BLOCK, look: { skin: npcMat(0xd8a47e), top: npcMat(0x8a2f2f), legs: npcMat(0x3b3026), boots: BOOTS, eye: NPC_EYE, chestW: 1.25, face: { hair: 0x2a1c12, style: 'cap', hat: 'knit', hatColor: 0x4a5a3a, beard: 0x2a1c12, brow: 0.02, belt: true } },
  day: [
    { at: spot(VB.x + 0.72, VB.z + 0.3), act: 'chop', prop: 'axe', dur: 14, face: faceTo(VB.x + 0.72, VB.z + 0.3, VB.x, VB.z) },
    { at: spot(VP.x + 0.9, VP.z), act: 'stack', carry: 'log', dur: 3, face: -Math.PI / 2 },
    { at: spot(-1.6, -1.2), act: 'warm', dur: 7, face: faceTo(-1.6, -1.2, 0, 0) },
  ], lines: ['There\'s a spare axe by my chopping block. Take it - it bites deeper than a sword.', 'Firewood keeps the Gloom at bay. Can\'t have too much of it.', 'Mind the axe, friend.', 'That fire burns all night. Somebody has to feed it.'] });
makeVillager({ name: 'Ines the Cook', home: H_WELL, look: { skin: npcMat(0xb98a64), top: npcMat(0x8a6a2a), legs: npcMat(0x6a3a4a), boots: BOOTS, eye: NPC_EYE, chestW: 0.95, face: { hair: 0x1a1210, style: 'long', hat: 'scarf', hatColor: 0xa83a32, apron: 0xe8e0d0, skirt: 0x6a3a4a } },
  day: [
    { at: inHouse(H_WELL, 1.6, -0.75), act: 'stir', prop: 'spoon', dur: 14, face: Math.PI, local: true },
    { at: spot(VW.x + 1.05, VW.z), act: 'pull', dur: 7, face: -Math.PI / 2 },
    { at: inHouse(H_WELL, 1.6, -0.75), act: 'stir', carry: 'bucket', prop: 'spoon', dur: 10, face: Math.PI, local: true },
    { at: inHouse(H_WELL, 0.55, 0.6), act: 'sit', dur: 7, face: Math.PI / 2, local: true },
  ], lines: ['Soup\'s on soon. The well water makes all the difference.', 'You look hungry, warden. Come by later.', 'Bram eats enough for three woodcutters.'] });
makeVillager({ name: 'Young Pip', home: H_KID, scale: 0.68, speed: 1.7, look: { skin: npcMat(0xe0b48a), top: npcMat(0x3a6aa8), legs: npcMat(0x5a4a3a), boots: BOOTS, eye: NPC_EYE, chestW: 0.9, face: { hair: 0xc0602a, style: 'cap', brow: 0.18 } },
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
    const busy = n === smith && d > 3.2 && n.talk <= 0 && !isNight(); // no hammering at night next to sleeping neighbours
    n.yaw += wrapAng((d < 3.2 || n.talk > 0 ? toYou : n.face) - n.yaw) * Math.min(1, dt * 3); n.g.rotation.y = n.yaw;
    const look = d < 9 ? THREE.MathUtils.clamp(wrapAng(toYou - n.yaw), -1.1, 1.1) : 0;
    n.head.rotation.y = lerp(n.head.rotation.y, busy ? 0 : look, Math.min(1, dt * 4));
    n.head.rotation.x = lerp(n.head.rotation.x, busy ? 0.35 : n.talk > 0 ? Math.sin(n.t * 5) * 0.08 : isNight() ? 0.2 : -0.05, Math.min(1, dt * 4));
    n.r.upper.scale.set(1, 1 + Math.sin(n.t * 1.7) * 0.012, 1 + Math.sin(n.t * 1.7) * 0.015); // breathing
    animateFace(n, dt, n.talk > 0);
    const r = n.r, gest = n.talk > 0 ? Math.sin(n.t * 3.1) : 0;
    const ga = n === smith ? 1 : 0; // gesture with the free hand
    r.arms[ga].rotation.x = -0.05 - (n.talk > 0 ? 0.6 + gest * 0.25 : 0); r.fore[ga].rotation.x = -0.2 - (n.talk > 0 ? 0.7 : 0);
    if (n === elder) { elder.staff.rotation.x = -(r.arms[1].rotation.x + r.fore[1].rotation.x); elder.staff.rotation.z = -r.arms[1].rotation.z; }
    if (n === smith) {
      if (busy) { // raise slowly, strike fast
        const p = (n.t % 1.15) / 1.15, up = p < 0.78 ? smoothstep(0, 0.78, p) : 1 - (p - 0.78) / 0.22;
        r.arms[0].rotation.x = -0.6 - up * 1.8; r.fore[0].rotation.x = -0.15 - up * 0.8; smith.hammer.rotation.x = 1.36 - up * 1.3; r.upper.rotation.x = 0.25 * (1 - up); // the head lands on the bar
        r.arms[1].rotation.x = -0.7; r.fore[1].rotation.x = -0.9; // the left holds the bar with the tongs
        if (n.lastP > 0.9 && p < 0.1 && d < 20) { const hh = smith.hammer.children[1].getWorldPosition(_v2); burst(hh, 0xffb040, 12, 2.5, 0.6); const v = 0.05 * (1 - d / 20); for (const f of [1800, 2400, 3100]) tone(f * (0.98 + Math.random() * 0.04), 0.4, 'square', v * 0.35); hiss(0.05, v * 2, 3000); }
        n.lastP = p;
      } else { r.arms[0].rotation.x = lerp(r.arms[0].rotation.x, -0.15, dt * 4); r.fore[0].rotation.x = lerp(r.fore[0].rotation.x, -0.9, dt * 4); smith.hammer.rotation.x = 0.9; r.upper.rotation.x = lerp(r.upper.rotation.x, 0, dt * 4); }
    }
  }
}

// ---------------------------------------------------------------- grabbable items (food, dishes, logs)
// Small rigid objects with simple physics: gravity, bounces that turn into spin, sliding friction, landing on
// tables/shelves/beds/floors, and settling into a stable pose. Apples hang on a tree and turnips are planted:
// grab and pull to free them. Food is eaten by bringing it to your mouth; logs tossed on the campfire burn.
// Each item type is one instanced draw call.
const ITEM_TYPES = {
  apple: { r: 0.04, e: 0.35, heal: 10, sound: 'soft', name: 'apple' },
  turnip: { r: 0.045, e: 0.3, heal: 8, sound: 'soft', name: 'turnip' },
  bread: { r: 0.06, e: 0.15, heal: 20, sound: 'soft', name: 'bread', flat: true },
  mug: { r: 0.05, e: 0.3, sound: 'clink', upright: true },
  plate: { r: 0.08, e: 0.25, sound: 'plate', flat: true },
  log: { r: 0.09, e: 0.12, sound: 'thud', fuel: true, side: true },
};
const ITEM_GEO = {
  apple: mergeGeos([{ geo: new THREE.SphereGeometry(0.04, 10, 8), m: new THREE.Matrix4() }, { geo: new THREE.CylinderGeometry(0.004, 0.004, 0.025, 4), m: new THREE.Matrix4().makeTranslation(0, 0.045, 0) }]),
  turnip: mergeGeos([{ geo: new THREE.SphereGeometry(0.045, 10, 8), m: new THREE.Matrix4().makeScale(1, 0.85, 1) }, { geo: new THREE.ConeGeometry(0.025, 0.12, 5), m: new THREE.Matrix4().makeTranslation(0, 0.09, 0) }]),
  bread: new THREE.CapsuleGeometry(0.045, 0.1, 4, 8).rotateZ(Math.PI / 2).scale(1, 0.75, 1),
  mug: mergeGeos([{ geo: new THREE.CylinderGeometry(0.042, 0.038, 0.1, 10), m: new THREE.Matrix4() }, { geo: new THREE.TorusGeometry(0.028, 0.007, 4, 8, Math.PI), m: new THREE.Matrix4().makeRotationZ(-Math.PI / 2).setPosition(0.042, 0, 0) }]),
  plate: new THREE.CylinderGeometry(0.11, 0.09, 0.016, 14),
  log: new THREE.CylinderGeometry(0.09, 0.09, 0.5, 8).rotateZ(Math.PI / 2),
};
const ITEM_MAT = { apple: npcMat(0xb8241c), turnip: npcMat(0xd8c8d8), bread: npcMat(0xb07a3a), mug: npcMat(0x8a6a4a), plate: npcMat(0xe8e2d4), log: M.wood };
const items = [];
function addItem(type, x, y, z, stuck = null, home = null) {
  const it = { type, T: ITEM_TYPES[type], p: new THREE.Vector3(x, y, z), v: new THREE.Vector3(), q: new THREE.Quaternion(), w: new THREE.Vector3(), rest: true, stuck, held: null, gone: 0, home: home || { x, y, z, stuck } };
  if (type === 'log') it.q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, Math.random() * 6.28);
  items.push(it); return it;
}
// surfaces inside houses things can rest on (house-local rectangles and their top heights)
const SURFACES = [{ x0: 0.85, x1: 1.95, z0: 0.25, z1: 0.95, y: 0.785 }, { x0: 1.05, x1: 2.15, z0: -1.8, z1: -1.2, y: 0.9 }, { x0: -2.3, x1: -1.3, z0: -1.8, z1: 0.2, y: 0.49 }, { x0: -0.7, x1: 0.5, z0: -1.88, z1: -1.58, y: 1.53 }];
function surfaceBelow(x, y, z) {
  let g = groundAt(x, z); const H = houseAt(x, z); if (!H) return g;
  const [lx, lz] = houseToLocal(H, x, z);
  for (const s of SURFACES) { const top = H.h + s.y * H.s; if (lx > s.x0 && lx < s.x1 && lz > s.z0 && lz < s.z1 && y >= top - 0.06 && top > g) g = top; }
  return g;
}
const STATIC3 = new THREE.Group();
{ // place everything: dishes and bread on every table, turnips in the garden, an apple tree by the garden, logs by the woodpile
  for (const H of HOUSES) {
    const at = (lx, lz, ly) => { const w = houseToWorld(H, lx, lz); return [w.x, H.h + ly * H.s, w.z]; };
    const [ax, ay, az] = at(1.15, 0.5, 0.785); addItem('plate', ax, ay + 0.008, az);
    const [bx, by, bz] = at(1.15, 0.5, 0.785); addItem('bread', bx, by + 0.05, bz);
    const [cx, cy, cz] = at(1.7, 0.75, 0.785); addItem('mug', cx, cy + 0.05, cz);
  }
  const G = PROPS.garden; for (let a = 0; a < 2; a++) for (let b = 0; b < 4; b++) addItem('turnip', G.x - 0.85 + b * 0.55, VH + 0.1, G.z - 0.3 + a * 0.6, 'planted');
  const AT = { x: PROPS.garden.x + 3.2, z: PROPS.garden.z - 2.2 }; // a small apple tree
  const trunkM = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.16, 2, 7), M.wood); trunkM.position.set(AT.x, VH + 1, AT.z); STATIC3.add(trunkM);
  const crownM = new THREE.Mesh(new THREE.IcosahedronGeometry(1.2, 1), new THREE.MeshLambertMaterial({ color: 0x3f7a30, flatShading: true })); crownM.position.set(AT.x, VH + 2.6, AT.z); STATIC3.add(crownM);
  addCollider(AT.x, AT.z, 0.2, VH + 3.6);
  for (let k = 0; k < 7; k++) { const a = k / 7 * 6.283, rr = 0.95 + (k % 2) * 0.2; addItem('apple', AT.x + Math.cos(a) * rr, VH + 2.05 + (k % 3) * 0.25, AT.z + Math.sin(a) * rr, 'hanging'); }
  for (let k = 0; k < 3; k++) addItem('log', PROPS.woodpile.x + 0.2 + k * 0.25, VH + 0.09, PROPS.woodpile.z + 0.75);
  bakeGroup(STATIC3);
}
const itemMeshes = {};
for (const t in ITEM_TYPES) { const n = items.filter(i => i.type === t).length; const im = new THREE.InstancedMesh(ITEM_GEO[t], ITEM_MAT[t], Math.max(1, n)); im.frustumCulled = false; scene.add(im); itemMeshes[t] = im; }
function itemSound(it, sp) {
  const v = Math.min(1, sp / 5), h = headPos(), d = h.distanceTo(it.p); if (d > 15 || v < 0.1) return; const k = v * (1 - d / 15);
  if (it.T.sound === 'clink') { tone(1700 + Math.random() * 500, 0.08, 'square', 0.03 * k); hiss(0.03, 0.08 * k, 3000); }
  else if (it.T.sound === 'plate') { tone(2400 + Math.random() * 600, 0.12, 'square', 0.025 * k); tone(3100, 0.1, 'square', 0.015 * k); }
  else if (it.T.sound === 'thud') { tone(85, 0.1, 'triangle', 0.08 * k); hiss(0.06, 0.15 * k, 300); }
  else hiss(0.04, 0.1 * k, 260);
}
const _iq = new THREE.Quaternion(), _iv = new THREE.Vector3(), _iu = new THREE.Vector3(), _im = new THREE.Matrix4(), _ione = new THREE.Vector3(1, 1, 1);
function updateItems(dt) {
  const h = headPos(), counts = {};
  for (const t in itemMeshes) counts[t] = 0;
  for (const it of items) {
    if (it.gone > 0) { it.gone -= dt; if (it.gone <= 0) { const o = it.home; it.p.set(o.x, o.y, o.z); it.stuck = o.stuck; it.rest = true; it.v.set(0, 0, 0); it.w.set(0, 0, 0); it.q.identity(); } else continue; } // grows back / is replaced
    if (!it.held && !it.rest && !it.stuck && !it.flying) {
      it.v.y -= 9.81 * dt; it.p.addScaledVector(it.v, dt);
      const om = it.w.length(); if (om > 1e-4) { _iq.setFromAxisAngle(_iu.copy(it.w).divideScalar(om), om * dt); it.q.premultiply(_iq); it.w.multiplyScalar(Math.exp(-0.6 * dt)); }
      if (it.p.y < groundAt(it.p.x, it.p.z) + 3) { _v4.copy(it.p); if (pushOut(it.p, it.T.r, true)) { const nx = it.p.x - _v4.x, nz = it.p.z - _v4.z, nl = Math.hypot(nx, nz) || 1, vn = (it.v.x * nx + it.v.z * nz) / nl; if (vn < 0) { it.v.x -= (1 + it.T.e) * vn * nx / nl; it.v.z -= (1 + it.T.e) * vn * nz / nl; itemSound(it, -vn); } } } // walls
      const floor = surfaceBelow(it.p.x, it.p.y + it.T.r, it.p.z) + it.T.r * (it.T.flat ? 0.3 : it.T.upright ? 1 : 0.85);
      if (it.p.y < floor) {
        it.p.y = floor; const vy = -it.v.y; if (vy > 0.4) itemSound(it, vy);
        it.v.y = vy > 0.6 ? vy * it.T.e : 0; it.w.x += it.v.z * 4; it.w.z -= it.v.x * 4; // the bounce turns into tumbling
        it.v.x *= 0.7; it.v.z *= 0.7; it.w.multiplyScalar(0.7);
        if (it.v.length() < 0.25) { it.rest = true; it.v.set(0, 0, 0); it.w.set(0, 0, 0); } // settled
      }
      // thrown things sting a little
      const sp = it.v.length();
      if (sp > 6) for (const e of enemies) if (!e.dead && e.hitCd <= 0 && Math.hypot(it.p.x - e.x, it.p.z - e.z) < e.rad + it.T.r && it.p.y - e.g.position.y < 1.9 * e.T.scale) { hitEnemy(e, clamp(sp / 12, 0.3, 1), h.x, h.z, it.v.clone().multiplyScalar(0.4), 4 + S.level); it.v.multiplyScalar(-0.3); break; }
      if (sp > 4) for (const n of villagers) if (Math.hypot(it.p.x - n.x, it.p.z - n.z) < 0.35 && it.p.y - n.g.position.y < 1.8) { villagerFlinch(n, 'Hey! Who threw that?'); it.v.multiplyScalar(-0.3); break; }
      // a log landing in the campfire burns
      if (it.T.fuel && Math.hypot(it.p.x, it.p.z) < 1.0 && it.p.y < VH + 1.2) { it.gone = 60; fireFlare = 3; burst(_iv.set(0, VH + 0.6, 0), 0xffb040, 40, 3, 3); hiss(0.6, 0.3, 1400); continue; }
    }
    if (it.rest && !it.held && !it.stuck) { // settle into a stable pose
      if (it.T.flat || it.T.upright) it.q.slerp(_iq.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, 2 * Math.atan2(it.q.y, it.q.w)), Math.min(1, dt * 8));
      else if (it.T.side) { const ax = _iv.set(1, 0, 0).applyQuaternion(it.q); ax.y = 0; if (ax.lengthSq() > 1e-4) { ax.normalize(); it.q.slerp(_iq.setFromUnitVectors(_iu.set(1, 0, 0), ax), Math.min(1, dt * 8)); } }
    }
    const t = it.type; itemMeshes[t].setMatrixAt(counts[t]++, _im.compose(it.p, it.q, _ione));
  }
  for (const t in itemMeshes) { itemMeshes[t].count = counts[t]; itemMeshes[t].instanceMatrix.needsUpdate = true; }
}
// hand support
function itemGrabCandidates(p, consider) { for (const it of items) { if (it.gone > 0 || it.held || it.flying) continue; const d = it.p.distanceTo(p) - it.T.r; if (d < 0.1) consider(d, { kind: 'item', it }); } }
function itemPullCandidates(test) { for (const it of items) if (!(it.gone > 0) && !it.held && !it.stuck && !it.flying) test(it.p, { kind: 'item', it }); }
function eatItem(it) { S.hp = Math.min(maxHp(), S.hp + it.T.heal); it.gone = it.type === 'apple' ? 120 : 180; it.held = null; hiss(0.12, 0.2, 900); tone(220, 0.05, 'triangle', 0.04); tone(180, 0.05, 'triangle', 0.04, 0, 0.12); toast(`You eat the ${it.T.name}. (+${it.T.heal} health)`, 2, true); }

// ---------------------------------------------------------------- player gear
const shield = new THREE.Group();
{
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.03, 16), new THREE.MeshLambertMaterial({ color: 0x7a4a22 }));
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.015, 6, 20), M.gold); rim.rotation.x = Math.PI / 2;
  const boss = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6), M.gold); boss.position.y = 0.02;
  shield.add(disc, rim, boss); shield.rotation.z = Math.PI / 2; shield.position.set(-0.07, 0, 0.05);
}

// camera-attached panels (VR toast / prompt / hurt flash)
const toastPanel = makePanel(0.9, 0.3, 900, 300, 1.25); toastPanel.mesh.position.set(0, 0.12, -1.25); toastPanel.mesh.visible = false; camera.add(toastPanel.mesh);
const promptPanel = makePanel(0.7, 0.09, 700, 90); promptPanel.mesh.position.set(0, -0.32, -1.2); promptPanel.mesh.visible = false; camera.add(promptPanel.mesh);
const hurtFlash = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ color: 0xff0000, transparent: true, opacity: 0, depthTest: false, fog: false }));
hurtFlash.position.z = -0.12; hurtFlash.renderOrder = 1000; hurtFlash.visible = false; camera.add(hurtFlash);
const wrist = makePanel(0.17, 0.12, 510, 360, 1.5); // ~765 px across: crisp at arm's length on Quest 3 wrist.mesh.position.set(0.055, 0.13, 0.02); wrist.mesh.rotation.set(0, Math.PI / 2, 0); // inside of the left wrist (+Y runs toward the arm)

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
    if (side === 'right') weaponsToVR(); // the weapon you held on screen goes into your right hand
    else { grip.add(shield); grip.add(wrist.mesh); }
  });
  grip.addEventListener('disconnected', () => { for (const k of ['left', 'right']) if (hands[k] && hands[k].grip === grip) { resetHandState(k); hands[k] = null; } });
  const ray = renderer.xr.getController(i); dolly.add(ray); // pointing direction, used to aim the gravity pull
  ray.addEventListener('connected', e => { const sd = e.data?.handedness; if (sd === 'left' || sd === 'right') { rays[sd] = ray; ray.userData.side = sd; } });
  ray.addEventListener('disconnected', () => { const sd = ray.userData.side; if (sd && rays[sd] === ray) rays[sd] = null; });
}
// Seated mode: the Quest reports your real head height above the real floor (local-floor). Seated, that is ~1.2 m,
// so the world is lifted by the difference to a 1.65 m standing eye height. X re-measures it (e.g. after sitting down).
const STAND_EYE = 1.65; let heightOffset = 0;
function recenterHeight(announce) {
  if (!inVR) { heightOffset = 0; return; }
  if (GFX.stance !== 'seated') { heightOffset = 0; if (announce) toast('Standing mode uses your real height. Choose Seated on the title screen to play sitting down.', 4, true); return; }
  heightOffset = clamp(STAND_EYE - camera.position.y, 0, 1.3);
  if (announce) toast(`Seated mode: eye height set to ${STAND_EYE} m (raised ${heightOffset.toFixed(2)} m). Press X to re-measure.`, 3.5, true);
}
renderer.xr.addEventListener('sessionstart', () => {
  setTimeout(() => recenterHeight(GFX.stance === 'seated'), 1500); // wait for head tracking to settle
  inVR = true; dolly.rotation.y = yaw; camera.rotation.set(0, 0, 0); promptText = null; startGame();
});
renderer.xr.addEventListener('sessionend', () => {
  // keep the player where their head was (room-scale offset), not where the dolly origin is
  _v1.set(camera.position.x, 0, camera.position.z).applyQuaternion(dolly.quaternion); dolly.position.x += _v1.x; dolly.position.z += _v1.z;
  weaponsToDesktop(); inVR = false; heightOffset = 0; yaw = dolly.rotation.y; dolly.rotation.y = 0; pitch = 0; camera.position.set(0, 1.6, 0);
  // WebXR overwrote the camera projection with the headset's; restore the flat-screen one
  camera.fov = 72; camera.zoom = 1; camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  $('hud').style.display = running ? 'block' : 'none'; promptText = null;
  for (const side of ['left', 'right']) resetHandState(side);
  scabbard.visible = false; shield.removeFromParent(); wrist.mesh.removeFromParent();
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
  // palm and cuff merged into one mesh; the 15 finger segments are drawn by one instanced mesh (2 draw calls per hand)
  g.add(new THREE.Mesh(mergeGeos([{ geo: new THREE.BoxGeometry(0.026, 0.088, 0.08), m: new THREE.Matrix4().makeTranslation(-ps * 0.036, 0.044, 0) },
    { geo: new THREE.CylinderGeometry(0.036, 0.04, 0.06, 8), m: new THREE.Matrix4().makeTranslation(-ps * 0.03, 0.115, 0.004) }]), HAND_MAT));
  const allSegs = [];
  const chain = (root, lens, w) => { const segs = []; let parent = root; for (const L of lens) { const p = new THREE.Group(); parent.add(p); segs.push(p); p.userData.L = L; p.userData.w = w; allSegs.push(p); parent = p; } segs.forEach((s, i) => { if (i) s.position.y = -lens[i - 1]; }); return segs; };
  const fingers = FINGER_DEF.map(f => { const root = new THREE.Group(); root.position.set(-ps * 0.036, 0.002, f.z); g.add(root); return chain(root, f.len, 0.019); });
  const thumbRoot = new THREE.Group(); thumbRoot.position.set(-ps * 0.024, 0.04, -0.038); thumbRoot.rotation.set(1.25, 0, ps * 0.35); g.add(thumbRoot);
  const thumb = chain(thumbRoot, [0.04, 0.03, 0.024], 0.021);
  const im = new THREE.InstancedMesh(SEG_UNIT, HAND_MAT, allSegs.length); im.frustumCulled = false; im.visible = false; scene.add(im);
  return { g, ps, fingers, thumb, segs: allSegs, im, curl: [0.2, 0.2, 0.2, 0.2, 0.2] };
}
const SEG_UNIT = new THREE.BoxGeometry(1, 1, 0.9).translate(0, -0.5, 0), _hsm = new THREE.Matrix4(), _hss = new THREE.Matrix4();
function drawHandFingers(model) { // copy each finger segment's world transform into the instanced mesh
  const on = model.g.visible && inScene(model.g); model.im.visible = on; if (!on) return;
  model.g.updateWorldMatrix(true, true); // parents first: the weapon (or grip) has moved this frame
  model.segs.forEach((sg, i) => { const { L, w } = sg.userData; model.im.setMatrixAt(i, _hsm.multiplyMatrices(sg.matrixWorld, _hss.makeScale(w, L, w))); });
  model.im.instanceMatrix.needsUpdate = true;
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

// ---------------------------------------------------------------- hip slot (left hip, holds one weapon) and grabbing
const scabbard = new THREE.Group(); scene.add(scabbard); scabbard.visible = false;
{
  _hm(new THREE.BoxGeometry(0.075, 0.03, 0.86), M.dark, scabbard, 0, 0, -0.5); // sheath
  _hm(new THREE.BoxGeometry(0.09, 0.04, 0.05), M.gold, scabbard, 0, 0, -0.08); _hm(new THREE.BoxGeometry(0.08, 0.035, 0.04), M.gold, scabbard, 0, 0, -0.92);
}
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
    if (s.held || s.rest || s.flying) continue;
    s.v.y -= 9.81 * dt; s.p.addScaledVector(s.v, dt);
    if (s.p.y < heightAt(s.p.x, s.p.z) + 3.5) { _v4.copy(s.p); if (pushOut(s.p, s.r)) { const nx = s.p.x - _v4.x, nz = s.p.z - _v4.z, nl = Math.hypot(nx, nz) || 1, vn = (s.v.x * nx + s.v.z * nz) / nl; if (vn < 0) { s.v.x -= 1.5 * vn * nx / nl; s.v.z -= 1.5 * vn * nz / nl; } tone(240, 0.05, 'triangle', 0.04); } } // bounce off trees and walls
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
function makePotionMesh() { const m = new THREE.Mesh(potionGeo, potionMat); const neck = new THREE.Mesh(potionNeckGeo, M.wood); neck.position.y = 0.18; m.add(neck); m.scale.setScalar(0.7); return m; }

// ---------------------------------------------------------------- gravity pull
// Point a free hand at a stone or a dropped potion (within 8 m) and squeeze grip: it flies to your hand. This makes
// things on the ground reachable when playing seated.
const rays = { left: null, right: null }, pulling = { left: null, right: null }, pullAim = { left: null, right: null };
const _ro = new THREE.Vector3(), _rdir = new THREE.Vector3(), _rq = new THREE.Quaternion(), _pv = new THREE.Vector3();
const aimLines = {};
for (const side of ['left', 'right']) {
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
  const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0.55, fog: false })); l.frustumCulled = false; l.visible = false; scene.add(l); aimLines[side] = l;
}
function pullCandidate(side) {
  const ray = rays[side]; if (!ray) return null;
  ray.getWorldPosition(_ro); _rdir.set(0, 0, -1).applyQuaternion(ray.getWorldQuaternion(_rq));
  let best = null, bc = 0.985; // within about 10 degrees of where you point
  const test = (pos, c) => { _pv.subVectors(pos, _ro); const d = _pv.length(); if (d < 0.5 || d > 8) return; const cos = _pv.dot(_rdir) / d; if (cos > bc) { bc = cos; best = c; } };
  for (const st of stones) if (!st.held && !st.flying) test(st.p, { kind: 'stone', s: st });
  for (const pk of pickups) if (!pk.flying) test(pk.m.position, { kind: 'pickup', pk });
  weaponPullCandidates(test); itemPullCandidates(test);
  return best;
}
function startPull(side, c) { pulling[side] = c; if (c.it) { c.it.flying = side; c.it.rest = false; } else if (c.s) { c.s.flying = side; c.s.rest = false; } else if (c.w) { c.w.flying = side; c.w.rest = false; } else c.pk.flying = side; pulse(side, 0.4, 60); tone(520, 0.12, 'sine', 0.06, 300); }
function cancelPull(side) { const c = pulling[side]; if (!c) return; pulling[side] = null; if (c.it) { c.it.flying = null; c.it.rest = false; return; } if (c.s) { c.s.flying = null; c.s.rest = false; } else if (c.w) { c.w.flying = null; c.w.v.set(0, 0, 0); } else c.pk.flying = null; }
function updatePull(side, p, dt) {
  const c = pulling[side]; if (!c) return;
  const pos = c.it ? c.it.p : c.s ? c.s.p : c.w ? c.w.p : c.pk.m.position, d = pos.distanceTo(p);
  pos.lerp(p, Math.min(1, dt * 7)); pos.y += Math.min(d, 2) * dt * 1.5; // flies to the hand in a slight arc
  if (c.s) syncStone(c.s); else if (c.w) c.w.g.position.copy(c.w.p);
  if (d < 0.18) { // arrived
    pulling[side] = null;
    if (c.it) { c.it.flying = null; c.it.held = side; grab[side] = { kind: 'item', it: c.it, start: p.clone() }; }
    else if (c.s) { c.s.flying = null; c.s.held = side; c.s.v.set(0, 0, 0); grab[side] = { kind: 'stone', s: c.s }; }
    else if (c.w) { c.w.flying = null; holdInHand(c.w, side); }
    else { const i = pickups.indexOf(c.pk); if (i >= 0) pickups.splice(i, 1); scene.remove(c.pk.m); const m = makePotionMesh(); scene.add(m); grab[side] = { kind: 'potion', m }; sfx.pickup(); }
    pulse(side, 0.6, 50);
    if (!gripHeld[side] && GFX.grip !== 'toggle') releaseGrab(side, true); // let go mid-flight: it drops at your hand
  }
}

// grab state per hand: null or { kind: 'stone'|'rag'|'potion', ... }
const grab = { left: null, right: null }, gripHeld = { left: false, right: false }, gripToggle = { left: false, right: false }, hover = { left: null, right: null };
const handHist = { left: [], right: [] };
const _hv = new THREE.Vector3(), _q1 = new THREE.Quaternion();
const _hq1 = new THREE.Quaternion();
function handAngVel(side, out) { // from the change in grip orientation over the last ~60 ms
  const H = handHist[side]; out.set(0, 0, 0); if (H.length < 2 || !H[0].q) return out;
  const a = H[H.length - 1]; let b = H[0]; for (let i = H.length - 2; i >= 0; i--) { b = H[i]; if (a.t - b.t > 0.06) break; }
  const dtt = a.t - b.t; if (dtt < 1e-3) return out;
  _hq1.copy(b.q).invert().premultiply(a.q); if (_hq1.w < 0) { _hq1.x = -_hq1.x; _hq1.y = -_hq1.y; _hq1.z = -_hq1.z; _hq1.w = -_hq1.w; }
  const ang = 2 * Math.acos(Math.min(1, _hq1.w)), sn = Math.sqrt(Math.max(1e-9, 1 - _hq1.w * _hq1.w));
  return out.set(_hq1.x / sn, _hq1.y / sn, _hq1.z / sn).multiplyScalar(ang / dtt);
}
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
  weaponGrabCandidates(side, p, consider); itemGrabCandidates(p, consider);
  for (const d of doors) { if (Math.abs(p.x - d.H.x) > 5 || Math.abs(p.z - d.H.z) > 5) continue; for (const sd of [-1, 1]) { const k = doorKnob(d, sd, _wb); const dd = k.distanceTo(p); if (dd < 0.14) consider(dd, { kind: 'door', d }); } }
  return best;
}
function tryGrab(side, p) {
  const c = grabCandidate(side, p); if (!c) return false;
  const other = side === 'left' ? 'right' : 'left';
  if (c.kind === 'stone') { if (grab[other]?.s === c.s) releaseGrab(other, true); c.s.held = side; c.s.rest = false; grab[side] = { kind: 'stone', s: c.s }; }
  else if (c.kind === 'rag') { if (grab[other]?.rd === c.rd && grab[other].i === c.i) releaseGrab(other, true); c.rd.pins = c.rd.pins || {}; c.rd.pins[side] = { i: c.i, t: c.rd.P[c.i].p.clone() }; grab[side] = { kind: 'rag', rd: c.rd, i: c.i }; }
  else if (c.kind === 'chest') { openChest(c.c); pulse(side, 0.6, 60); return true; }
  else if (c.kind === 'weapon') { holdInHand(c.w, side); return true; }
  else if (c.kind === 'item') { grab[side] = { kind: 'item', it: c.it, start: p.clone() }; c.it.held = side; c.it.rest = false; }
  else if (c.kind === 'door') { grab[side] = { kind: 'door', d: c.d }; c.d.held = true; c.d.target = null; c.d.auto = false; }
  else if (c.kind === 'hip') { holdInHand(hipW, side); sfx.swing(); return true; }
  else if (c.kind === 'nock') { if (!arrowsAvailable()) return true; S.arrows--; grab[side] = { kind: 'arrow', w: c.w }; c.w.nockSide = side; tone(620, 0.05, 'triangle', 0.05); }
  else if (c.kind === 'quiver') { if (!arrowsAvailable()) return true; S.arrows--; grab[side] = { kind: 'arrowHand' }; tone(700, 0.05, 'triangle', 0.05); } // drew an arrow from the quiver
  else if (c.kind === 'pocket') { S.potions--; const m = makePotionMesh(); scene.add(m); grab[side] = { kind: 'potion', m }; sfx.pickup(); }
  else if (c.kind === 'pickup') { scene.remove(c.pk.m); pickups.splice(pickups.indexOf(c.pk), 1); const m = makePotionMesh(); scene.add(m); grab[side] = { kind: 'potion', m }; sfx.pickup(); }
  pulse(side, 0.5, 40); return true;
}
function resetHandState(side) { // drop whatever the hand holds and forget its hover/grip/velocity history
  releaseGrab(side, true); cancelPull(side); pullAim[side] = null; aimLines[side].visible = false;
  if (pickups.includes(hover[side])) hover[side].m.scale.setScalar(1);
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
  else if (gb.kind === 'door') { gb.d.held = false; } // let go: it keeps swinging
  else if (gb.kind === 'item') { const it = gb.it; it.held = null; if (!it.stuck) { it.rest = false; it.v.copy(quiet ? _v3.set(0, 0, 0) : v); it.w.copy(quiet ? _v3.set(0, 0, 0) : handAngVel(side, new THREE.Vector3())).clampLength(0, 20); } }
  else if (gb.kind === 'arrowHand') { S.arrows++; handArrow.visible = false; }
  else if (gb.kind === 'arrow') { // let go of the string: shoot if drawn far enough
    const w = gb.w, d = bowDraw(w), hp = hands[side] ? hands[side].grip.getWorldPosition(new THREE.Vector3()) : null;
    if (!quiet && hp && d > 0.05) { w.g.getWorldPosition(_bc); const dir = _bc.clone().sub(hp).normalize(); S.arrows++; fireArrow(hp.clone().addScaledVector(dir, 0.36), dir, ARROW_VMAX * d); w.snapT = 0.09; w.snapD = d; w.q.multiply(_q1.setFromAxisAngle(_wb.set(1, 0, 0), -0.12 * d)); pulse(side, 0.4 + 0.6 * d, 40); if (w.side) pulse(w.side, 0.3 + 0.6 * d, 60); } // fired from the nock; the string snaps and the bow kicks
    else S.arrows++; // barely drawn: the arrow goes back in the quiver
    w.nockSide = null; nockArrow.visible = false;
  }
  else if (gb.kind === 'weapon') { const w = gb.w; if (w.def.bow && w.nockSide) releaseGrab(w.nockSide, true); placeInWorld(w, w.g.position, w.q, quiet ? null : v.clone().multiplyScalar(0.5)); }
  else if (gb.kind === 'potion') { scene.remove(gb.m); S.potions++; if (!quiet) { sfx.coin(); toast('Potion stowed.', 1.2); } } // let go anywhere: it goes back in your pack
}
function updateHands(dt) {
  updateTrackedHands();
  if (!inVR) return;
  updateScabbard();
  const now = performance.now() / 1000;
  for (const side of ['left', 'right']) {
    const h = hands[side]; if (!h) continue;
    const H = handHist[side]; const ent = H.length >= 10 ? H.shift() : { p: new THREE.Vector3(), q: new THREE.Quaternion(), t: 0 };
    h.grip.getWorldPosition(ent.p); h.grip.getWorldQuaternion(ent.q); ent.t = now; H.push(ent); const p = ent.p;
    // grip input: analog squeeze on controllers, a closed fist with tracked hands
    const th = h.isHand ? trackedHand(side) : null, gp = h.src.gamepad;
    const squeeze = th ? (th.fist ? 1 : 0) : (gp?.buttons[1]?.value ?? 0);
    const was = gripHeld[side]; gripHeld[side] = was ? squeeze > 0.35 : squeeze > 0.6;
    const pressEdge = gripHeld[side] && !was, releaseEdge = !gripHeld[side] && was;
    if (th) { if (th.pinch && !th.pinchWas && side === 'right') interactQueued = true; th.pinchWas = th.pinch; }
    const toggleMode = GFX.grip === 'toggle';
    const gw = grab[side]?.kind === 'weapon' ? grab[side] : null;
    if (gw) { // weapons are sticky: squeeze at the left hip to put it away; squeeze and let go to drop it (let go mid-swing to throw it)
      if (pressEdge) { if (!hipW && p.distanceTo(_sheathPt) < 0.3) { toHip(gw.w); pulse(side, 0.7, 50); } else gw.armDrop = true; }
      else if (releaseEdge && gw.armDrop) { const v = handVel(side, _hv).clone(), w = gw.w; if (w.def.bow && w.nockSide) releaseGrab(w.nockSide, true); if (v.length() > 2.5) throwWeapon(w, w.g.position, w.q, v, handAngVel(side, new THREE.Vector3())); else placeInWorld(w, w.g.position, w.q, v.multiplyScalar(0.5)); }
    } else if (grab[side]) {
      if ((toggleMode && pressEdge) || (!toggleMode && releaseEdge)) releaseGrab(side, false);
    } else if (pulling[side]) {
      if (!toggleMode && releaseEdge) cancelPull(side); // let go before it arrives: it drops
    } else if (pressEdge) {
      if (!tryGrab(side, p)) {
        if (pullAim[side]) startPull(side, pullAim[side]); // pointing at something: pull it
        else if (side === 'right' && hipW) { holdInHand(hipW, 'right'); sfx.swing(); } // nothing to grab: draw the weapon from the hip
      }
    }
    updatePull(side, p, dt);
    // hover feedback
    const free = !grab[side] && !pulling[side];
    const cand = free ? grabCandidate(side, p) : null, aim = free && !cand ? pullCandidate(side) : null; pullAim[side] = aim;
    const key = cand ? (cand.s || cand.pk || cand.c || cand.w || cand.it || (cand.rd ? cand.rd.P[cand.i] : cand.kind)) : aim ? (aim.s || aim.pk || aim.w || aim.it) : null;
    if (key !== hover[side]) {
      if (stones.includes(hover[side])) highlightStone(hover[side], false); else if (pickups.includes(hover[side])) hover[side].m.scale.setScalar(1);
      if (key) pulse(side, 0.15, 15); hover[side] = key;
      if (key && stones.includes(key)) highlightStone(key, true); else if (key && pickups.includes(key)) key.m.scale.setScalar(1.35);
    }
    const al = aimLines[side]; al.visible = !!aim; // faint line to what a squeeze would pull
    if (aim) { const a = al.geometry.attributes.position, t = aim.s ? aim.s.p : aim.w ? aim.w.p : aim.it ? aim.it.p : aim.pk.m.position; a.setXYZ(0, _ro.x, _ro.y, _ro.z); a.setXYZ(1, t.x, t.y, t.z); a.needsUpdate = true; }
    // carry the held thing
    const gb = grab[side];
    if (gb?.kind === 'stone') { gb.s.p.copy(p); syncStone(gb.s); }
    else if (gb?.kind === 'rag') { if (!ragdolls.includes(gb.rd)) grab[side] = null; else { gb.rd.pins[side].t.copy(p); gb.rd.life = Math.min(gb.rd.life, 1); } }
    else if (gb?.kind === 'item') { const it = gb.it;
      if (it.stuck) { // planted or hanging: it gives way once you pull hard enough
        if (p.distanceTo(gb.start) > 0.1) { it.stuck = null; tone(it.type === 'turnip' ? 160 : 520, 0.06, 'triangle', 0.06); hiss(0.05, 0.12, it.type === 'turnip' ? 300 : 1200); pulse(side, 0.7, 40); if (it.type === 'turnip') burst(it.p, 0x5a3e24, 6, 1, 0.6); }
        else if (Math.random() < dt * 30) pulse(side, 0.15, 10);
      }
      if (!it.stuck) { it.p.copy(p); it.q.copy(h.grip.getWorldQuaternion(_q1)); }
      if (it.T.heal && !it.stuck && p.distanceTo(bodyPoint(0.08, 0.07, 0, _mouthPt)) < 0.15) { eatItem(it); grab[side] = null; pulse(side, 0.6, 60); } // a bite
    }
    else if (gb?.kind === 'door') { // the door follows the hand around its hinge
      const d = gb.d, [lx, lz] = doorLocal(d, p.x, p.z), a = clamp(Math.atan2(-(lz - DOOR_Z), lx + 0.7), 0, DOOR_MAX);
      d.vel = lerp(d.vel, (a - d.ang) / Math.max(dt, 1e-3), 0.5); d.ang = a;
      if (Math.hypot(p.x - doorKnob(d, 1, _wb).x, p.z - _wb.z) > 0.6 && Math.hypot(p.x - doorKnob(d, -1, _wb).x, p.z - _wb.z) > 0.6) releaseGrab(side, false); // pulled too far: the hand slips off
    }
    else if (gb?.kind === 'arrowHand') { // an arrow from the quiver: show it in the hand; touch it to the bow string to nock it
      handArrow.visible = true; handArrow.quaternion.copy(h.grip.getWorldQuaternion(_q1)); handArrow.position.copy(p).addScaledVector(_wb.set(0, 0, -1).applyQuaternion(_q1), 0.28); // held near the nock end, along the fist
      const ob = grab[side === 'left' ? 'right' : 'left']?.w;
      if (ob && ob.def.bow && !ob.nockSide && p.distanceTo(ob.g.localToWorld(_wb.set(0, 0.12, 0))) < 0.16) { grab[side] = { kind: 'arrow', w: ob }; ob.nockSide = side; handArrow.visible = false; tone(620, 0.05, 'triangle', 0.05); pulse(side, 0.5, 30); }
    }
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
      const holding = !!grab[side];
      const sq = holding ? Math.max(0.85, squeeze) : squeeze, ix = holding ? Math.max(0.75, trig) : Math.max(trig, trigTouch);
      poseHand(playerHands[side], [holding ? 0.8 : thumbTouch, ix, sq, sq, sq], dt);
    }
  }
}

// ---------------------------------------------------------------- weapons
// Every weapon is a physical object that is always in exactly one place: in a VR hand ('hand'), on the flat-screen
// camera ('desk'), hanging at the hip ('hip'), or lying / flying in the world ('world'). Melee damage comes from how
// fast the tip moves; heavier weapons turn a little behind your hand (weight), and each hit has a short impact pause.
// Weapon local space matches the VR grip: the blade runs along -Z from the grip, -Y points away from the wrist.
const WDEF = {
  sword: { name: 'Ember Sword', dmg: () => swordDamage(), com: -0.22, butt: 0.15, hilt: -0.1, tip: -0.95, rotStiff: 90, minSpeed: 1.8, ref: 4.5, maxMult: 1.6, reach: 2.9, swing: 0.36, throwMult: 0.9 },
  axe: { restSide: true, impale: true, name: "Woodsman's Axe", dmg: () => 18 + 3 * S.level, com: -0.5, butt: 0.12, hilt: -0.35, tip: -0.7, rotStiff: 40, minSpeed: 2.2, ref: 5, maxMult: 2.0, reach: 2.6, swing: 0.5, throwMult: 1.5 },
  spear: { impale: true, name: 'Hunting Spear', dmg: () => 14 + 2.5 * S.level, com: -0.55, butt: 0.5, hilt: -0.6, tip: -1.62, rotStiff: 55, minSpeed: 1.6, ref: 4.5, maxMult: 1.5, reach: 3.7, swing: 0.42, throwMult: 2.4, thrust: true },
  mace: { name: 'Iron Mace', dmg: () => 16 + 3 * S.level, com: -0.5, butt: 0.1, hilt: -0.35, tip: -0.66, rotStiff: 35, minSpeed: 2.2, ref: 5, maxMult: 1.8, reach: 2.6, swing: 0.52, throwMult: 1.1, stun: 1.3 },
  great: { name: 'Hollow Greatsword', dmg: () => 30 + 4 * S.level, com: -0.42, butt: 0.3, hilt: -0.25, tip: -1.38, rotStiff: 26, minSpeed: 2.0, ref: 5.5, maxMult: 1.8, reach: 3.3, swing: 0.66, throwMult: 0.7 },
  bow: { restSide: true, name: "Hunter's Bow", bow: true, dmg: () => 12 + 3 * S.level, com: 0.0, butt: 0.6, hilt: 0.6, tip: -0.6, rotStiff: 90, throwMult: 0.3 },
};
// where the found-in-the-world weapons first lie (the greatsword is dropped by the Hollow King)
const WSPAWN = { axe: () => [PROPS.block.x - 0.9, PROPS.block.z + 0.8], spear: () => [SITES.c1.x + 3, SITES.c1.z + 1.5], mace: () => [SITES.c2.x - 3, SITES.c2.z + 1.5], bow: () => [SITES.c0.x + 2.5, SITES.c0.z - 2] };
const WMAT = { steel: new THREE.MeshLambertMaterial({ color: 0xd8dde6, emissive: 0x111111 }), iron: new THREE.MeshLambertMaterial({ color: 0x6a6a72, flatShading: true }), dark: new THREE.MeshLambertMaterial({ color: 0x2a1c26, emissive: 0x1a0820 }) };
function buildWeapon(id) {
  const g = new THREE.Group();
  const part = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.set(rx, ry, rz); g.add(m); return m; };
  const rod = (r, len, mat, z) => part(new THREE.CylinderGeometry(r, r, len, 7), mat, 0, 0, z, Math.PI / 2);
  if (id === 'sword') {
    rod(0.02, 0.17, M.dark, 0.03); part(new THREE.SphereGeometry(0.03, 8, 6), M.gold, 0, 0, 0.12); part(new THREE.BoxGeometry(0.2, 0.03, 0.035), M.gold, 0, 0, -0.06);
    part(new THREE.BoxGeometry(0.05, 0.012, 0.82), WMAT.steel, 0, 0, -0.48); g.userData.edge = part(new THREE.BoxGeometry(0.012, 0.016, 0.78), M.ember, 0, 0, -0.47);
    part(new THREE.ConeGeometry(0.025, 0.08, 4), WMAT.steel, 0, 0, -0.93, -Math.PI / 2);
  } else if (id === 'axe') {
    rod(0.02, 0.82, M.wood, -0.29); part(new THREE.BoxGeometry(0.03, 0.12, 0.13), WMAT.iron, 0, -0.04, -0.62); part(new THREE.BoxGeometry(0.02, 0.06, 0.19), WMAT.steel, 0, -0.12, -0.62);
  } else if (id === 'spear') {
    rod(0.017, 2.0, M.wood, -0.5); part(new THREE.ConeGeometry(0.035, 0.22, 4), WMAT.steel, 0, 0, -1.6, -Math.PI / 2); part(new THREE.CylinderGeometry(0.025, 0.025, 0.05, 6), M.gold, 0, 0, -1.48, Math.PI / 2);
  } else if (id === 'mace') {
    rod(0.022, 0.62, M.wood, -0.2); part(new THREE.IcosahedronGeometry(0.085, 0), WMAT.iron, 0, 0, -0.58);
    for (let k = 0; k < 6; k++) { const a = k / 6 * Math.PI * 2; part(new THREE.ConeGeometry(0.025, 0.08, 4), WMAT.iron, Math.cos(a) * 0.09, Math.sin(a) * 0.09, -0.58, 0, 0, a - Math.PI / 2); }
  } else if (id === 'great') {
    rod(0.025, 0.3, M.dark, 0.1); part(new THREE.SphereGeometry(0.04, 8, 6), M.gold, 0, 0, 0.27); part(new THREE.BoxGeometry(0.34, 0.04, 0.05), M.gold, 0, 0, -0.06);
    part(new THREE.BoxGeometry(0.085, 0.016, 1.22), WMAT.dark, 0, 0, -0.7); g.userData.edge = part(new THREE.BoxGeometry(0.014, 0.02, 1.16), new THREE.MeshBasicMaterial({ color: 0xa040ff }), 0, 0, -0.69);
    part(new THREE.ConeGeometry(0.042, 0.12, 4), WMAT.dark, 0, 0, -1.37, -Math.PI / 2);
  } else if (id === 'bow') { // riser along Z in the hand, limbs bend back toward the archer (+Y), string at y = 0.12
    rod(0.022, 0.2, M.dark, 0);
    for (const sz of [-1, 1]) { const limb = part(new THREE.CylinderGeometry(0.012, 0.018, 0.52, 6), M.wood, 0, 0.06, sz * 0.35, Math.PI / 2 + sz * 0.25); limb.userData.limb = true; }
    const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
    const str = new THREE.Line(sg, new THREE.LineBasicMaterial({ color: 0xeeeeee })); str.frustumCulled = false; g.add(str); g.userData.string = str;
  }
  if (id !== 'bow') mergeWeaponParts(g, id); // one mesh per material (the glowing edge stays separate: its colour changes)
  return g;
}
function mergeWeaponParts(g, id) {
  const byMat = new Map(); for (const c of g.children) if (c.isMesh && c !== g.userData.edge) { c.updateMatrix(); if (!byMat.has(c.material)) byMat.set(c.material, []); byMat.get(c.material).push(c); }
  let k = 0; for (const [mat, list] of byMat) { if (list.length < 2) continue; const key = 'wpn:' + id + ':' + (k++); if (!_mergeCache.has(key)) _mergeCache.set(key, mergeGeos(list.map(c => ({ geo: c.geometry, m: c.matrix })))); for (const c of list) g.remove(c); g.add(new THREE.Mesh(_mergeCache.get(key), mat)); }
}
// arrows: one instanced mesh for all of them
const ARROW_MAX = 40, arrows = [];
const arrowMesh = (() => {
  const parts = [{ geo: new THREE.CylinderGeometry(0.008, 0.008, 0.72, 5).rotateX(Math.PI / 2), m: new THREE.Matrix4() },
    { geo: new THREE.ConeGeometry(0.018, 0.07, 4).rotateX(-Math.PI / 2), m: new THREE.Matrix4().makeTranslation(0, 0, -0.39) },
    { geo: new THREE.BoxGeometry(0.004, 0.05, 0.1), m: new THREE.Matrix4().makeTranslation(0, 0, 0.3) }];
  const im = new THREE.InstancedMesh(mergeGeos(parts), new THREE.MeshLambertMaterial({ color: 0xcfb38a }), ARROW_MAX);
  im.frustumCulled = false; im.count = 0; scene.add(im); return im;
})();
const nockArrow = new THREE.Mesh(arrowMesh.geometry, arrowMesh.material); nockArrow.visible = false; scene.add(nockArrow);
const handArrow = new THREE.Mesh(arrowMesh.geometry, arrowMesh.material); handArrow.visible = false; scene.add(handArrow); // held, not yet nocked

const WEAPONS = {};
let deskW = null, hipW = null;
const HOLD_Q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.35, 0, 0)), HOLD_Q_BOW = new THREE.Quaternion();
const holdQ = w => (w.def.bow ? HOLD_Q_BOW : HOLD_Q);
function makeWeapon(id) {
  const w = { id, def: WDEF[id], g: buildWeapon(id), state: 'world', side: null, p: new THREE.Vector3(), v: new THREE.Vector3(), q: new THREE.Quaternion(), spin: new THREE.Vector3(),
    rest: true, tipPrev: new THREE.Vector3(), havePrev: false, tipSpeed: 0, whoosh: 0, hitStop: 0, nockSide: null, sparkle: Math.random() * 2 };
  WEAPONS[id] = w; return w;
}
const _wa = new THREE.Vector3(), _wb = new THREE.Vector3(), _wq = new THREE.Quaternion(), _wm = new THREE.Matrix4(), _wv = new THREE.Vector3();
const wPoint = (w, z, out) => out.set(0, 0, z).applyQuaternion(w.state === 'world' ? w.q : w.g.getWorldQuaternion(_wq)).add(w.state === 'world' ? w.p : w.g.getWorldPosition(_wv));
function detach(w) {
  if (w.state === 'hand' && grab[w.side]?.w === w) grab[w.side] = null;
  if (deskW === w) { deskW = null; if (playerHands.right.g.parent === w.g) playerHands.right.g.removeFromParent(); }
  if (hipW === w) hipW = null;
  w.g.removeFromParent(); w.side = null;
}
function placeInWorld(w, pos, q, vel) {
  detach(w); w.state = 'world'; w.p.copy(pos); w.q.copy(q); w.v.copy(vel || _wa.set(0, 0, 0)); w.rest = false; w.spin.set(0, 0, 0);
  w.g.position.copy(w.p); w.g.quaternion.copy(w.q); w.g.scale.setScalar(1); scene.add(w.g);
}
function holdInHand(w, side) {
  const cur = grab[side]; if (cur) releaseGrab(side, true);
  detach(w); w.state = 'hand'; w.side = side; w.havePrev = false; grab[side] = { kind: 'weapon', w };
  hands[side].grip.getWorldQuaternion(w.q).multiply(holdQ(w)); scene.add(w.g); pulse(side, 0.5, 40);
}
function equipDesk(w) {
  detach(w); w.state = 'desk'; deskW = w; camera.add(w.g); w.g.visible = true; deskRest(w);
  const m = playerHands.right; w.g.add(m.g); m.g.position.set(0, 0, 0); m.g.quaternion.copy(holdQ(w)).invert(); m.g.visible = true; poseHand(m, [0.8, 0.9, 1, 1, 1], 1);
}
function toHip(w, quiet) {
  detach(w); w.state = 'hip'; hipW = w; scabbard.add(w.g); w.g.position.set(0, 0, 0.02); w.g.quaternion.identity(); w.g.visible = true; if (!quiet) sfx.block();
}
function deskRest(w) {
  const g = w.g;
  if (w.def.bow) { g.position.set(-0.13, -0.17, -0.55); g.rotation.set(Math.PI / 2, 0, 0.12); }
  else if (w.def.thrust) { g.position.set(0.22, -0.3, -0.25); g.rotation.set(0.25, 0.05, -0.1); }
  else { g.position.set(0.24, -0.24, -0.42); g.rotation.set(0.7, 0.15, -0.25); }
}
// throwing: spears fly point-first, everything else tumbles
function throwWeapon(w, pos, q, vel, angW) { // angW: the hand's angular velocity (world, rad/s)
  placeInWorld(w, pos, q, vel); const sp = vel.length();
  if (!w.def.thrust) {
    if (angW && angW.lengthSq() > 4) { // the wrist flick decides the spin; the centre of mass also gets the rim speed (w x r)
      w.spin.copy(angW).applyQuaternion(_wq.copy(w.q).invert()).clampLength(0, 25);
      w.v.add(_wb.crossVectors(angW, _wa.set(0, 0, w.def.com).applyQuaternion(w.q)));
    } else w.spin.set(-sp * 2.2, 0, 0); // tumble end over end
  }
  tone(220, 0.15, 'triangle', 0.06, -80);
}

// --- VR: held weapons follow the hand with a little rotational lag (weight); melee hits from tip speed
function updateHeldWeapons(dt) {
  for (const side of ['left', 'right']) {
    const gb = grab[side]; if (!gb || gb.kind !== 'weapon' || !hands[side]) continue;
    const w = gb.w, def = w.def, grip = hands[side].grip;
    grip.getWorldPosition(w.g.position); grip.getWorldQuaternion(_wq).multiply(holdQ(w));
    w.hitStop -= dt; if (w.hitStop <= 0) w.q.slerp(_wq, 1 - Math.exp(-def.rotStiff * dt)); // during an impact pause the blade holds still
    w.g.quaternion.copy(w.q);
    if (def.bow) { w.g.updateMatrixWorld(true); updateBowString(w, dt); continue; }
    w.g.updateMatrixWorld(true);
    const tipW = w.g.localToWorld(_swTip.set(0, 0, def.tip)), hiltW = w.g.localToWorld(_swHilt.set(0, 0, def.hilt));
    const tipL = dolly.worldToLocal(_swTipL.copy(tipW)), velW = _swVel.set(0, 0, 0);
    if (w.havePrev) velW.subVectors(tipL, w.tipPrev).divideScalar(Math.max(dt, 1e-3)).applyQuaternion(dolly.quaternion);
    w.tipPrev.copy(tipL); w.havePrev = true; const sp = velW.length();
    pushRagdollsWithBlade(hiltW, tipW, velW);
    if (w.tipSpeed > 2) for (const n of villagers) if (Math.hypot(tipW.x - n.x, tipW.z - n.z) < 0.8 && tipW.y - n.g.position.y < 1.9) villagerFlinch(n);
    w.tipSpeed = lerp(w.tipSpeed, sp, 0.5); w.whoosh -= dt;
    if (w.tipSpeed > def.minSpeed + 2.2 && w.whoosh <= 0) { sfx.swing(); w.whoosh = 0.4; }
    if (w.g.userData.edge) w.g.userData.edge.material.color.setHex(w.tipSpeed > def.minSpeed ? (w.id === 'great' ? 0xd28aff : 0xffd27a) : (w.id === 'great' ? 0xa040ff : 0xff7a1a));
    if (w.tipSpeed < def.minSpeed) continue;
    const h = headPos(), mult = clamp(w.tipSpeed / def.ref, 0.6, def.maxMult);
    for (const e of enemies) {
      if (e.dead || e.hitCd > 0 || enemyBladeDist(e, hiltW, tipW) >= e.rad + 0.1) continue;
      if (hitEnemy(e, mult, h.x, h.z, _swImp.copy(velW).clampLength(0, 12), def.dmg(), def.stun)) { w.hitStop = 0.06; e.freeze = 0.06; pulse(side, 1, 70); }
    }
  }
}
// --- bow: the other hand squeezes near the bow to nock an arrow, pulls back, and lets go to shoot
const _bc = new THREE.Vector3(), _bs = new THREE.Vector3(), _bt = new THREE.Vector3(), _bb = new THREE.Vector3();
function bowDraw(w) { // 0..1, how far the nocking hand has pulled the string back
  if (!w.nockSide || !hands[w.nockSide]) return 0;
  const hp = hands[w.nockSide].grip.getWorldPosition(_bt); w.g.localToWorld(_bs.set(0, 0.12, 0)); w.g.getWorldPosition(_bc);
  _bb.set(0, 1, 0).applyQuaternion(w.g.getWorldQuaternion(_wq)); // toward the archer
  return clamp(_wa.subVectors(hp, _bs).dot(_bb) / 0.62, 0, 1);
}
function bendBow(w, d) { for (const m of w.g.children) if (m.userData.limb) { const sz = Math.sign(m.position.z); m.rotation.x = Math.PI / 2 + sz * (0.25 + 0.28 * d); } }
function updateBowString(w, dt = 1 / 72) {
  const str = w.g.userData.string, a = str.geometry.attributes.position, d = bowDraw(w);
  bendBow(w, d); const tz = 0.6 - 0.05 * d, ty = 0.12 + 0.07 * d; a.setXYZ(0, 0, ty, tz); a.setXYZ(2, 0, ty, -tz);
  w.snapT = Math.max(0, (w.snapT || 0) - dt);
  if (d > 0 && w.nockSide) { const loc = w.g.worldToLocal(hands[w.nockSide].grip.getWorldPosition(_bt)); a.setXYZ(1, clamp(loc.x, -0.04, 0.04), loc.y, clamp(loc.z, -0.08, 0.08)); }
  else if (w.snapT > 0) { const tt = 0.09 - w.snapT; a.setXYZ(1, 0, 0.12 - 0.06 * w.snapD * Math.exp(-tt / 0.025) * Math.cos(2 * Math.PI * 25 * tt), 0); } // string snaps forward and settles
  else a.setXYZ(1, 0, 0.12, 0);
  a.needsUpdate = true;
  nockArrow.visible = !!w.nockSide && w.state === 'hand';
  if (nockArrow.visible) { // the arrow lies from the drawing hand through the bow
    const hp = hands[w.nockSide].grip.getWorldPosition(_bt); w.g.getWorldPosition(_bc);
    nockArrow.position.copy(hp).lerp(_bc, 0.5); nockArrow.quaternion.setFromUnitVectors(_wa.set(0, 0, -1), _wb.subVectors(_bc, hp).normalize());
    if (d > 0.05 && Math.random() < d * 20 * dt) pulse(w.nockSide, 0.05 + d * 0.15, 10); // string tension
    if (d > 0.97 && !w.fullDraw) { w.fullDraw = true; pulse(w.nockSide, 0.8, 25); tone(95, 0.12, 'sawtooth', 0.03, 15); } else if (d < 0.9) w.fullDraw = false; // full draw: the bow creaks
  }
}
// Arrow physics. A bow stores energy ~ draw^2, so launch speed grows linearly with draw (up to ~58 m/s, a hunting
// bow). In flight: gravity plus quadratic air drag (a = -k|v|v), nose along the velocity. Damage follows kinetic
// energy. Arrows stick where they hit: in enemies (riding along on the body and its ragdoll), in trees and walls,
// or in the ground; the stuck ones can be picked up again.
const ARROW_VMAX = 58, ARROW_DRAG = 0.0022, _am = new THREE.Matrix4(), _ai = new THREE.Matrix4();
function arrowsAvailable() { if (S.arrows > 0) return true; toast('Your quiver is empty. Pick up arrows you have shot, or look in chests.', 3); return false; }
function fireArrow(origin, dir, speed) {
  if (S.arrows <= 0) return; S.arrows--;
  let a = arrows.find(x => !x.alive); if (!a) { if (arrows.length < ARROW_MAX) { a = { p: new THREE.Vector3(), v: new THREE.Vector3(), q: new THREE.Quaternion(), prev: new THREE.Vector3(), local: new THREE.Matrix4() }; arrows.push(a); } else a = arrows.reduce((o, x) => (x.t > o.t ? x : o), arrows[0]); }
  a.alive = true; a.stuck = false; a.on = null; a.t = 0; a.p.copy(origin); a.v.copy(dir).multiplyScalar(speed); a.q.setFromUnitVectors(_wa.set(0, 0, -1), dir);
  hiss(0.1 + speed / 500, 0.12 + speed / 300, 1600 + speed * 20); tone(140 + speed * 2, 0.07, 'triangle', 0.07, 90); // string twang, louder for a full draw
}
const inScene = o => { while (o) { if (o === scene) return true; o = o.parent; } return false; };
function stickArrow(a, obj) { // ride along with obj (an enemy's torso, which becomes its ragdoll body)
  a.stuck = true; a.on = obj; obj.updateMatrixWorld(true); _am.compose(a.p, a.q, _wb.set(1, 1, 1)); a.local.copy(_ai.copy(obj.matrixWorld).invert()).multiply(_am);
}
const _ta = new THREE.Vector3(), _tb = new THREE.Vector3(), _td = new THREE.Vector3(), ARROW_HALF = 0.39;
// embed the arrow so its tip sits `depth` past the hit point, along its flight direction
function embedArrow(a, hit, dir, sp) { const depth = clamp(0.02 + 0.004 * sp, 0.03, 0.25); a.p.copy(hit).addScaledVector(dir, depth - ARROW_HALF); a.stuck = true; a.on = null; }
function updateArrows(dt) { // simulation only; syncArrows() draws them after bodies have moved this frame
  const h = headPos();
  for (const a of arrows) {
    if (!a.alive || a.stuck) { if (a.alive) a.t += dt; continue; }
    a.t += dt; a.prev.copy(a.p); const sp0 = a.v.length();
    a.v.addScaledVector(a.v, -ARROW_DRAG * sp0 * dt); a.v.y -= 9.81 * dt; a.p.addScaledVector(a.v, dt);
    const sp = a.v.length(); _td.copy(a.v).divideScalar(sp || 1); a.q.setFromUnitVectors(_wa.set(0, 0, -1), _td);
    _ta.copy(a.prev).addScaledVector(_td, ARROW_HALF); _tb.copy(a.p).addScaledVector(_td, ARROW_HALF); // the tip's path this frame
    const energy = (sp / 45) * (sp / 45);
    for (const e of enemies) if (!e.dead && enemyBladeDist(e, _ta, _tb) < e.rad + 0.04) {
      hitEnemy(e, clamp(energy, 0.15, 1.5), h.x, h.z, _wv.copy(a.v).multiplyScalar(0.25), WDEF.bow.dmg());
      a.p.lerp(a.prev, 0.35); e.rig.upper.updateWorldMatrix(true, false); stickArrow(a, e.rig.upper); break; // lodges in the body
    }
    if (a.stuck) continue;
    for (const n of villagers) { const vy = _tb.y - n.g.position.y; if (vy > 0 && vy < 1.8 * n.g.scale.x && Math.hypot(_tb.x - n.x, _tb.z - n.z) < 0.3) { a.v.multiplyScalar(-0.12); villagerFlinch(n, 'Ow! Watch where you shoot!'); break; } }
    for (const rd of ragdolls) { if (rd.P[2].p.distanceToSquared(a.p) > 9) continue; for (const pt of rd.P) if (distPointSeg(pt.p, _ta, _tb) < pt.r + 0.04) { nudgeRagdoll(rd, a.v, 0.12); stickArrow(a, rd.body); break; } if (a.stuck) break; }
    if (a.stuck) continue;
    const t = segHit(_ta, _tb); // trees, walls, rocks: exact test along the path, so fast arrows can't skip through thin walls
    if (t >= 0) { embedArrow(a, _wa.lerpVectors(_ta, _tb, t), _td, sp); tone(170, 0.06, 'square', 0.05); continue; }
    const f0 = _ta.y - groundAt(_ta.x, _ta.z), f1 = _tb.y - groundAt(_tb.x, _tb.z);
    if (f1 < 0) { embedArrow(a, _wa.lerpVectors(_ta, _tb, f0 > 0 ? f0 / (f0 - f1) : 0), _td, sp); tone(140, 0.05, 'square', 0.04); continue; } // the tip goes into the ground at its real angle
    if (a.t > 8) a.alive = false;
  }
}
function syncArrows() {
  let n = 0; const h = headPos();
  for (const a of arrows) {
    if (!a.alive) continue;
    if (a.on) {
      if (!inScene(a.on)) { _am.multiplyMatrices(a.on.matrixWorld, a.local).decompose(a.p, a.q, _wb); a.on = null; a.stuck = false; a.v.set(0, -0.5, 0); a.t = 0; } // the body is gone: the arrow falls and can be picked up
      else { a.on.updateWorldMatrix(true, false); arrowMesh.setMatrixAt(n++, _am.multiplyMatrices(a.on.matrixWorld, a.local)); continue; }
    }
    if (a.stuck) { // in the world: walk close to pick it back up
      if (Math.hypot(h.x - a.p.x, h.z - a.p.z) < 1.1 && Math.abs(h.y - 1.2 - a.p.y) < 1.8 && a.t > 0.6) { a.alive = false; S.arrows++; tone(900, 0.05, 'sine', 0.05); continue; }
      if (a.t > 90) { a.alive = false; continue; }
    }
    _wm.compose(a.p, a.q, _wb.set(1, 1, 1)); arrowMesh.setMatrixAt(n++, _wm);
  }
  arrowMesh.count = n; arrowMesh.instanceMatrix.needsUpdate = true;
}
// --- weapons lying in or flying through the world
const _lyQ = new THREE.Quaternion(), _lyM = new THREE.Matrix4(), _dq = new THREE.Quaternion(), _ey = new THREE.Euler();
function updateWorldWeapons(dt) {
  const h = headPos();
  for (const id in WEAPONS) {
    const w = WEAPONS[id]; if (w.state !== 'world' || w.flying) continue;
    if (w.rest) { // gentle golden sparkle so weapons in the world can be spotted
      w.sparkle -= dt; if (w.sparkle <= 0 && w.p.distanceTo(h) < 45) { w.sparkle = 1.4; burst(_wa.copy(w.p).add(_wb.set(0, 0.15, 0)), 0xffd27a, 2, 0.4, 0.8); }
      continue;
    }
    w.v.y -= 9.8 * dt; w.p.addScaledVector(w.v, dt);
    if (w.p.y < groundAt(w.p.x, w.p.z) + 2.5) { _v4.copy(w.p); if (pushOut(w.p, 0.1)) { const nx = w.p.x - _v4.x, nz = w.p.z - _v4.z, nl = Math.hypot(nx, nz) || 1, vn = (w.v.x * nx + w.v.z * nz) / nl; if (vn < 0) { w.v.x -= 1.3 * vn * nx / nl; w.v.z -= 1.3 * vn * nz / nl; } w.spin.multiplyScalar(0.6); } } // reflect off walls
    const sp = w.v.length();
    if (w.def.thrust && sp > 4) w.q.setFromUnitVectors(_wa.set(0, 0, -1), _wb.copy(w.v).normalize()); // spears fly point-first
    else if (w.spin.lengthSq() > 1e-4) { // rotate about the centre of mass, not the grip
      const com = w.def.com; _wa.set(0, 0, com).applyQuaternion(w.q).add(w.p);
      const om = w.spin.length(); _dq.setFromAxisAngle(_wb.copy(w.spin).divideScalar(om), om * dt); w.q.multiply(_dq); // exact rotation about the spin axis
      w.p.copy(_wa).sub(_wb.set(0, 0, com).applyQuaternion(w.q)); w.spin.multiplyScalar(Math.exp(-0.25 * dt));
    }
    // spears and axes thrown point-first stick in trees, walls and the ground
    if (w.def.impale && sp > 8) {
      const tip = wPoint(w, w.def.tip, _wa), tdir = _wb.set(0, 0, -1).applyQuaternion(w.q);
      if (tdir.dot(_v4.copy(w.v).divideScalar(sp)) > 0.6 && (tip.y < groundAt(tip.x, tip.z) || (tip.y < groundAt(tip.x, tip.z) + 4 && hitCollider(tip.x, tip.z)))) {
        w.p.addScaledVector(tdir, -0.06); w.v.set(0, 0, 0); w.spin.set(0, 0, 0); w.rest = true; w.stuck = true; tone(150, 0.12, 'square', 0.07); burst(tip, 0xc9a36a, 8, 1.5, 0.5);
        w.g.position.copy(w.p); w.g.quaternion.copy(w.q); continue;
      }
    }
    // thrown weapons hurt
    if (sp > 5) {
      const a = wPoint(w, w.def.hilt, _wa), b = wPoint(w, w.def.tip, _wb);
      for (const e of enemies) if (!e.dead && e.hitCd <= 0 && enemyBladeDist(e, a, b) < e.rad + 0.05) {
        hitEnemy(e, clamp(sp / 12, 0.4, 1.3), h.x, h.z, _wv.copy(w.v).multiplyScalar(0.4), w.def.dmg() * w.def.throwMult, w.def.stun); w.v.multiplyScalar(-0.25); w.spin.multiplyScalar(0.5); break;
      }
      for (const rd of ragdolls) for (const pt of rd.P) if (distPointSeg(pt.p, a, b) < pt.r + 0.05) { nudgeRagdoll(rd, w.v, 0.3); break; }
    }
    // ground: the lower end of the weapon can't go under; bounce, then settle lying flat
    const a = wPoint(w, w.def.butt, _wa), b = wPoint(w, w.def.tip, _wb); // back end and tip
    const low = Math.min(a.y - groundAt(a.x, a.z), b.y - groundAt(b.x, b.z));
    if (low < 0.02) {
      w.p.y += 0.02 - low;
      if (w.v.y < -1.5) tone(260 + Math.random() * 80, 0.06, 'square', 0.05);
      if (w.v.y < 0) w.v.y = -w.v.y * 0.25; w.v.x *= 0.6; w.v.z *= 0.6; w.spin.multiplyScalar(0.5);
      if (sp < 0.6) { // lie flat: blade horizontal, flat side down
        const dir = _wa.set(0, 0, -1).applyQuaternion(w.q); dir.y = 0; if (dir.lengthSq() < 1e-4) dir.set(0, 0, -1); dir.normalize();
        if (w.def.restSide) { const z = dir.clone().negate(); _lyM.makeBasis(_v4.set(0, 1, 0), z.clone().cross(_v4).normalize(), z); } // lying on its side (head / limbs flat)
        else _lyM.makeBasis(_wb.set(0, 1, 0).cross(dir.clone().negate()).normalize(), _v4.set(0, 1, 0), dir.clone().negate());
        _lyQ.setFromRotationMatrix(_lyM);
        w.q.slerp(_lyQ, Math.min(1, dt * 8)); w.spin.set(0, 0, 0);
        if (sp < 0.15 && w.q.angleTo(_lyQ) < 0.05) { w.rest = true; w.v.set(0, 0, 0); w.p.y = groundAt(w.p.x, w.p.z) + 0.04; }
      }
    }
    w.g.position.copy(w.p); w.g.quaternion.copy(w.q);
  }
}
// grabbing support used by the hand code
function weaponGrabCandidates(side, p, consider) {
  for (const id in WEAPONS) {
    const w = WEAPONS[id]; if (w.state !== 'world') continue;
    const d = distPointSeg(p, wPoint(w, w.def.butt, _wa), wPoint(w, w.def.tip, _wb)); if (d < 0.15) consider(d - 0.02, { kind: 'weapon', w });
  }
  if (hipW && p.distanceTo(_sheathPt) < 0.3) consider(0.05, { kind: 'hip' });
  const other = side === 'left' ? 'right' : 'left', ob = grab[other]?.w; // nock an arrow on a bow held in the other hand
  if (ob && ob.def.bow && !ob.nockSide && p.distanceTo(ob.g.getWorldPosition(_wa)) < 0.3) consider(0.01, { kind: 'nock', w: ob });
  if (WEAPONS.bow && WEAPONS.bow.state !== 'world' && p.distanceTo(bodyPoint(0.05, -0.15, 0, _wb)) < 0.25) consider(0.02, { kind: 'quiver' }); // reach behind your head
}
function weaponPullCandidates(test) { for (const id in WEAPONS) { const w = WEAPONS[id]; if (w.state === 'world' && !w.flying) test(w.p, { kind: 'weapon', w }); } }
// flat screen: one weapon in hand; F swaps it with the hip, G drops it, E picks one up, click attacks (or draws the bow)
function deskSwap() {
  if (deskW && hipW) { const a = deskW, b = hipW; toHip(a); equipDesk(b); }
  else if (deskW) toHip(deskW);
  else if (hipW) { equipDesk(hipW); sfx.swing(); }
}
function deskDrop() {
  if (!deskW || inVR) return; const f = forward2D(), h = headPos();
  placeInWorld(deskW, _wa.set(h.x + f.x * 0.7, h.y - 0.6, h.z + f.z * 0.7), _wq.setFromEuler(_ey.set(0, Math.atan2(-f.x, -f.z), 0)), _wb.set(f.x * 1.2, 0.8, f.z * 1.2));
}
function pickUpWeapon(w) {
  if (inVR) { const side = grab.right ? (grab.left ? 'right' : 'left') : 'right'; if (grab[side]?.kind === 'weapon') { const cur = grab[side].w; if (!hipW) toHip(cur); else releaseGrab(side, true); } holdInHand(w, side); }
  else { if (deskW) { if (!hipW) toHip(deskW); else deskDrop(); } equipDesk(w); }
  sfx.pickup(); toast(`Picked up the ${w.def.name}.`, 2.5, true);
}
// VR <-> flat screen hand-over
function weaponsToVR() { if (deskW && hands.right) { const w = deskW; holdInHand(w, 'right'); } }
function weaponsToDesktop() {
  let main = null;
  for (const side of ['right', 'left']) {
    const gb = grab[side]; if (gb?.kind === 'arrow' || gb?.kind === 'arrowHand') { grab[side] = null; if (gb.w) gb.w.nockSide = null; S.arrows++; handArrow.visible = false; continue; }
    if (gb?.kind !== 'weapon') continue; const w = gb.w; grab[side] = null; w.nockSide = null;
    if (!main) main = w; else if (!hipW) toHip(w); else { const h = headPos(); placeInWorld(w, _wa.set(h.x, groundAt(h.x, h.z) + 0.3, h.z), w.q); }
  }
  nockArrow.visible = false;
  if (main) equipDesk(main); else if (!deskW && hipW) equipDesk(hipW);
}
// save / load
function weaponSaveState() {
  const out = {};
  for (const id in WEAPONS) { const w = WEAPONS[id]; out[id] = w.state === 'desk' || w.state === 'hand' ? 'hand' : w.state === 'hip' ? 'hip' : [+w.p.x.toFixed(2), +w.p.y.toFixed(2), +w.p.z.toFixed(2)]; }
  return out;
}
function initWeapons() {
  const st = S.wpn || { sword: 'hand' };
  for (const id of Object.keys(WSPAWN)) if (!(id in st)) st[id] = WSPAWN[id]();
  if (S.stage >= 6 && !('great' in st)) st.great = [SITES.tower.x - 6, 0, SITES.tower.z - 6];
  let handed = false;
  for (const id in st) {
    if (!WDEF[id]) continue; const w = makeWeapon(id), v = st[id];
    if (v === 'hand' && !handed) { equipDesk(w); handed = true; }
    else if ((v === 'hip' || v === 'hand') && !hipW) toHip(w, true);
    else { const a = Array.isArray(v) ? v : [0, 9], x = a[0], z = a.length === 2 ? a[1] : a[2], y = a.length === 2 ? 0 : a[1]; placeInWorld(w, _wa.set(x, Math.max(y, groundAt(x, z) + 0.3), z), _wq.setFromEuler(_ey.set(0, Math.random() * 6.28, 0))); }
  }
}

// ---------------------------------------------------------------- player helpers
const _head = new THREE.Vector3();
function headPos() { camera.getWorldPosition(_head); return _head; }
function forward2D() { camera.getWorldDirection(_v1); _v1.y = 0; if (_v1.lengthSq() < 1e-6) _v1.set(0, 0, -1); return _v1.normalize(); }
function placePlayer(x, z) {
  handHist.left.length = handHist.right.length = 0; airborne = false; jumpVy = 0; // a teleport is not a throw (or a jump)
  for (const sd of ['left', 'right']) { const gb = grab[sd]; if (gb?.kind === 'weapon') { gb.w.havePrev = false; gb.w.tipSpeed = 0; } }
  const h = headPos(); dolly.position.x += x - h.x; dolly.position.z += z - h.z; dolly.position.y = Math.max(heightAt(x, z), -1.3);
}
function movePlayer(dx, dz) {
  const h = headPos(); let nx = h.x + dx, nz = h.z + dz;
  if (heightAt(nx, nz) < -0.6) { // too deep: try sliding along the shore on one axis
    if (heightAt(nx, h.z) >= -0.6) nz = h.z; else if (heightAt(h.x, nz) >= -0.6) nx = h.x; else return;
  }
  const r = Math.hypot(nx, nz); if (r > PLAY_RADIUS) { nx *= PLAY_RADIUS / r; nz *= PLAY_RADIUS / r; }
  [nx, nz] = collide(nx, nz, 0.35);
  [nx, nz] = doorCollide(nx, nz);
  for (const n of villagers) { const ox = nx - n.x, oz = nz - n.z, m = 0.3 * n.g.scale.x + 0.35, d2 = ox * ox + oz * oz; if (d2 < m * m && d2 > 1e-6) { const d = Math.sqrt(d2); nx = n.x + ox / d * m; nz = n.z + oz / d * m; } }
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
  const key = [S.level, S.gold, S.potions, Math.ceil(S.hp), maxHp(), Math.round(S.xp / xpNeed() * 100), title, desc, od ? od.name + od.dist + Math.round(od.ang * 4) : '', Math.floor(time / 3)].join('|');
  if (key === wristKey) return; wristKey = key;
  const { ctx, canvas } = wrist, W = canvas.width, H = canvas.height; ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(14,10,24,0.88)'; rr(ctx, 0, 0, W, H, 30); ctx.fill(); ctx.strokeStyle = 'rgba(255,180,90,.6)'; ctx.lineWidth = 4; ctx.stroke();
  ctx.fillStyle = '#ffcf8a'; ctx.font = 'bold 30px Arial,Arimo,sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.fillText(`Lv ${S.level}`, 22, 16); ctx.fillStyle = '#fff'; ctx.font = '26px Arial,Arimo,sans-serif'; ctx.fillText(`Gold ${S.gold}   Potions ${S.potions}${WEAPONS.bow && WEAPONS.bow.state !== 'world' ? `   Arrows ${S.arrows}` : ''}`, 140, 20);
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
  $('stats').innerHTML = `Level ${S.level} &nbsp; Gold ${S.gold} &nbsp; Potions ${S.potions}${WEAPONS.bow && WEAPONS.bow.state !== 'world' ? ` &nbsp; Arrows ${S.arrows}` : ''} &nbsp; Sword +${S.swordLv}${S.blessed ? ' (blessed)' : ''} &nbsp; ${isNight() ? 'Night' : 'Day'}`;
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
  gloom: { name: 'Gloomling', hp: 30, dmg: 7, speed: 2.3, wind: 0.45, cd: 1.35, xp: 14, gold: [2, 6], color: 0x4b2a6b, scale: 0.8, chestW: 0.85, hunch: 0.45 },
  thorn: { name: 'Thornback', hp: 80, dmg: 13, speed: 1.9, wind: 0.6, cd: 1.5, xp: 32, gold: [6, 14], color: 0x56502a, scale: 1.2, chestW: 1.4, hunch: 0.25 },
  king: { name: 'Hollow King', hp: 520, dmg: 22, speed: 2.0, wind: 0.8, cd: 1.6, xp: 300, gold: [150, 150], color: 0x1c1028, scale: 1.75, chestW: 1.2, hunch: 0.08, boss: true },
};
const matEye = new THREE.MeshBasicMaterial({ color: 0xffd23a }), matEyeBoss = new THREE.MeshBasicMaterial({ color: 0xff3020 });
const ENEMY_LEGS = { gloom: new THREE.MeshLambertMaterial({ color: 0x241a28, flatShading: true }), thorn: new THREE.MeshLambertMaterial({ color: 0x3d3320, flatShading: true }), king: new THREE.MeshLambertMaterial({ color: 0x15101c, flatShading: true }) };
const barGeo = new THREE.PlaneGeometry(1, 0.09); barGeo.translate(0.5, 0, 0);
const barBg = new THREE.MeshBasicMaterial({ color: 0x220000, fog: false }), barFg = new THREE.MeshBasicMaterial({ color: 0xff4040, fog: false });
const enemies = []; const LOD_FAR = 24;
function spawnEnemy(key, x, z) {
  const T = ENEMY_TYPES[key];
  let mat = new THREE.MeshLambertMaterial({ color: T.color, flatShading: true, emissive: 0x000000 });
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
  const vc = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, emissive: 0x000000 }); mergeRig(r, key, { mat: vc }); mat.dispose(); mat = vc; // the merged body flashes when hit
  // far-away version: the whole body in its rest pose baked into one mesh per material (about 3 draw calls instead
  // of 12), shown beyond LOD_FAR where nobody can see the limbs move anyway
  g.updateMatrixWorld(true); const lod = new THREE.Group(); lod.visible = false;
  const byMat = new Map(); for (const pv of [r.upper, ...r.legs]) pv.traverse(o => { if (o.isMesh) { if (!byMat.has(o.material)) byMat.set(o.material, []); byMat.get(o.material).push({ geo: o.geometry, m: o.matrixWorld.clone() }); } });
  let slot = 0; for (const [m, list] of byMat) { const k = 'lod:' + key + ':' + (slot++); if (!_mergeCache.has(k)) _mergeCache.set(k, mergeGeos(list)); lod.add(new THREE.Mesh(_mergeCache.get(k), m)); }
  g.add(lod);
  g.scale.setScalar(T.scale);
  const lv = 1 + 0.14 * (S.level - 1), nightMul = isNight() ? 1.2 : 1;
  const e = { key, T, g, rig: r, lod, far: false, upper: r.upper, mat, bar, fg, hp: T.hp * lv * nightMul, maxHp: T.hp * lv * nightMul, dmg: T.dmg * lv, x, z, vx: 0, vz: 0, atkCd: 1.2, hitCd: 0, flash: 0, lunge: 0, walk: Math.random() * 6, tilt: 0, tiltV: 0, wAng: Math.random() * 6.28, wT: 0, aggro: false, dead: false, rad: 0.4 * T.scale * T.chestW };
  e.yaw = Math.random() * 6.283; e.st = 0; e.side = Math.random() < 0.5 ? -1 : 1; e.nightborn = isNight(); g.rotation.y = e.yaw;
  if (T.boss) matEyeBoss.color.setHex(0xff3020);
  g.position.set(x, heightAt(x, z), z); scene.add(g); enemies.push(e); return e;
}
function enemyCenter(e, out) { return out.set(e.x, e.g.position.y + 1.1 * e.T.scale, e.z); }
// closest distance from a blade segment to the enemy's body (sampled at legs, chest and head height)
function enemyBladeDist(e, a, b) { let m = 1e9; for (const f of [0.5, 1.05, 1.55]) m = Math.min(m, distPointSeg(_ebd.set(e.x, e.g.position.y + f * e.T.scale, e.z), a, b)); return m; }
const _ebd = new THREE.Vector3();
// impulse: world-space velocity (m/s) of the blow, used for knockback, flinch and the death ragdoll
function hitEnemy(e, mult, fromX, fromZ, impulse, base, stun) { // base: damage before mult (defaults to the sword's); stun: seconds
  if (e.dead || e.hitCd > 0) return false;
  let dmg = (base ?? swordDamage()) * mult; const crit = Math.random() < 0.12; if (crit) dmg *= 1.8; if (e.leash) dmg *= 0.25;
  if (stun) { e.stun = Math.max(e.stun || 0, stun * (e.T.boss ? 0.4 : 1)); burst(enemyCenter(e, new THREE.Vector3()).add(_v2.set(0, 0.6 * e.T.scale, 0)), 0xffee55, 10, 1.2, 1); }
  e.hp -= dmg; e.hitCd = 0.32; e.flash = 0.15; e.aggro = true; alertNoise(e.x, e.z, 1.5);
  e.stagger = Math.max(e.stagger || 0, (e.T.boss ? 0.08 : 0.3) * Math.min(1.5, mult)); if (e.st === 1) { e.st = 3; e.stT = 0.5; } // interrupted
  if (!e.T.boss && !e.fled && e.hp > 0 && e.hp < e.maxHp * 0.25 && Math.random() < 0.4) { e.flee = 2.5; e.fled = true; }
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
  for (const o of enemies) if (o !== e && !o.dead && Math.hypot(o.x - e.x, o.z - e.z) < 6) o.stagger = Math.max(o.stagger || 0, 0.4); // pack hesitates
  const g = Math.round(lerp(e.T.gold[0], e.T.gold[1], Math.random())); S.gold += g; sfx.coin();
  gainXP(Math.round(e.T.xp * (1 + 0.1 * (S.level - 1))));
  if (Math.random() < (e.T.boss ? 1 : e.key === 'thorn' ? 0.35 : 0.18)) spawnPickup('potion', e.x, e.z);
  if (S.stage === 1 && !e.T.boss) { S.qKills++; if (S.qKills >= 5) { S.stage = 2; sfx.quest(); toast('Quest updated: The Gloom creatures scatter! Return to Elder Maren.', 4); save(); } }
  if (e.T.boss && !WEAPONS.great) { const w = makeWeapon('great'); placeInWorld(w, new THREE.Vector3(e.x, groundAt(e.x, e.z) + 1.6, e.z), new THREE.Quaternion(), new THREE.Vector3(0, 3, 0)); toast("The Hollow King's greatsword clatters to the ground!", 5); }
  if (e.T.boss && S.stage === 5) { S.stage = 6; sfx.quest(); toast('The Hollow King is no more! The Gloom recedes... Return to Elder Maren.', 6); save(); }
}

// ---------------------------------------------------------------- ragdolls (Verlet points + distance constraints)
// Humanoid skeleton points: 0 head, 1 T (chest top), 2 B (pelvis), 3 F (chest front), 4/5 shoulders, 6/7 hips,
// 8/9 elbows, 10/11 hands, 12/13 knees, 14/15 feet. Points 0-7 are tied rigidly (head + torso);
// upper arm, forearm, thigh and shin are single links, with minimum distances acting as joint limits.
const ragdolls = []; const RAG_MAX = 5, RAG_LIFE = 7, RAG_STEP = 1 / 60;
const _rx = new THREE.Vector3(), _ry = new THREE.Vector3(), _rz = new THREE.Vector3(), _rm = new THREE.Matrix4(), DOWN = new THREE.Vector3(0, -1, 0);
function makeRagdoll(e, imp) {
  const r = e.rig; e.g.updateMatrixWorld(true);
  const s = e.T.scale, P = [];
  const W = (o, x = 0, y = 0, z = 0) => o.localToWorld(new THREE.Vector3(x, y, z));
  const add = (v, rad) => P.push({ p: v, o: v.clone(), r0: v.clone(), r: rad * s, gy: 0 });
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
    pt.r0.copy(pt.p);
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
    if (it === 5) for (const pt of rd.P) if (pt.p.y < pt.gy + 3) pushOut(pt.p, pt.r); // trees and walls
  }
  for (const pt of rd.P) if (pt.p.y <= pt.gy + 0.002) { // ground friction
    pt.o.x = lerp(pt.o.x, pt.p.x, 0.25); pt.o.z = lerp(pt.o.z, pt.p.z, 0.25); if (pt.o.y < pt.p.y) pt.o.y = lerp(pt.o.y, pt.p.y, 0.6);
  }
}
function poseRagdoll(rd, alpha = 1) {
  if (!rd.I) rd.I = rd.P.map(() => new THREE.Vector3());
  const pins = rd.pins || {}, pinned = i => (pins.left && pins.left.i === i) || (pins.right && pins.right.i === i);
  rd.P.forEach((pt, i) => rd.I[i].copy(pt.p)); if (alpha < 1) rd.P.forEach((pt, i) => { if (!pinned(i)) rd.I[i].lerpVectors(pt.r0, pt.p, alpha); });
  const P = rd.I, T = P[1], B = P[2], F = P[3];
  rd.body.position.copy(B); // the torso group's origin is the pelvis point; its +Y runs to the chest top
  _ry.subVectors(T, B).normalize();
  _rz.subVectors(F, B); _rz.addScaledVector(_ry, -_rz.dot(_ry)).normalize();
  _rx.crossVectors(_ry, _rz);
  _rm.makeBasis(_rx, _ry, _rz); rd.body.quaternion.setFromRotationMatrix(_rm);
  rd.limbs.forEach((l, i) => { const [a, b] = rd.limbIdx[i]; l.position.copy(P[a]); _rx.subVectors(P[b], P[a]).normalize(); l.quaternion.setFromUnitVectors(DOWN, _rx); });
  rd.body.updateMatrix(); rd.body.matrixWorld.copy(rd.body.matrix); // fresh world matrix for arrows riding on the body
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
    poseRagdoll(rd, rd.life > RAG_LIFE - 1.2 ? 1 : rd.acc / RAG_STEP);
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
// Enemy behaviour:
// - Senses: notices the player up close, in a forward cone, or when the player makes noise (sprinting, fighting).
// - Attacks: approach -> wind-up (a readable telegraph: arms rise, eyes glow) -> strike (damage lands now, if you are
//   still in reach and not blocking) -> recover. At most 3 enemies attack at once; the rest circle at a distance.
// - Reactions: hits stagger and can interrupt a wind-up; badly hurt enemies may flee; gloomlings born at night
//   burn away after dawn.
// - The Hollow King: slam, sweep and charge attacks, and a second phase below half health.
let noiseT = 0, noiseX = 0, noiseZ = 0; // the last loud thing the player did
function alertNoise(x, z, secs = 1) { noiseT = Math.max(noiseT, secs); noiseX = x; noiseZ = z; }
const ATTACKERS_MAX = 3;
function updateEnemies(dt) {
  const h = headPos(); const sh = hands.left ? shield.getWorldPosition(_v2) : null;
  noiseT = Math.max(0, noiseT - dt);
  let attackers = 0; for (const o of enemies) if (!o.dead && o.st > 0) attackers++;
  for (let i = enemies.length - 1; i >= 0; i--) {
    const e = enemies[i];
    if (e.remove) { scene.remove(e.g); if (!e.ragdolled) e.mat.dispose(); enemies.splice(i, 1); continue; }
    if (e.dead) continue;
    const dx = h.x - e.x, dz = h.z - e.z, dist = Math.hypot(dx, dz) || 1e-3;
    if (dist > 130 && !e.T.boss) { e.remove = true; continue; }
    e.hitCd -= dt; e.atkCd -= dt; e.stagger = Math.max(0, (e.stagger || 0) - dt); e.flee = Math.max(0, (e.flee || 0) - dt);
    if (e.freeze > 0) { e.freeze -= dt; continue; } // impact pause
    // gloomlings born at night burn away in daylight
    if (e.nightborn && !isNight() && !e.T.boss) { e.burn = (e.burn ?? 2 + Math.random() * 13) - dt; if (e.burn <= 0) { burst(enemyCenter(e, new THREE.Vector3()), 0xffa040, 30, 2.5, 2); tone(300, 0.4, 'sawtooth', 0.04, -200); e.remove = true; continue; } }
    const stunned = e.stun > 0; if (stunned) e.stun -= dt;
    const range = isNight() ? 24 : 17;
    const homeD = e.home ? Math.hypot(e.x - e.home.x, e.z - e.home.z) : 0;
    if (e.home && (homeD > 40 || dist > 60)) e.leash = true; else if (e.home && homeD < 3) e.leash = false; // the boss never strays far from its tower
    // senses
    if (e.leash) e.aggro = false;
    else if (!e.aggro) {
      const fwdDot = (Math.sin(e.yaw) * dx + Math.cos(e.yaw) * dz) / dist;
      const heard = noiseT > 0 && Math.hypot(noiseX - e.x, noiseZ - e.z) < 22;
      if (dist < 6 || (dist < range && fwdDot > 0.34) || heard || e.hp < e.maxHp) e.aggro = true;
    } else if (dist > range * 1.8 && !e.T.boss) e.aggro = false;
    if (e.T.boss && dist > 80) { e.hp = e.maxHp; e.bar.visible = false; }
    if (e.leash) e.hp = Math.min(e.maxHp, e.hp + e.maxHp * 0.1 * dt);
    if (e.T.boss && !e.phase2 && e.hp < e.maxHp * 0.5) { // second phase: angrier, calls for help
      e.phase2 = true; toast('The Hollow King roars and calls the Gloom to his side!', 4); tone(70, 1.2, 'sawtooth', 0.2, -20);
      matEyeBoss.color.setHex(0xff8040); for (let k = 0; k < 3; k++) { const a = k / 3 * 6.283, m = spawnEnemy('gloom', e.x + Math.cos(a) * 4, e.z + Math.sin(a) * 4); m.aggro = true; }
    }
    let mx = 0, mz = 0, yawT = e.yaw, turnRate = 8; const reach = e.rad + 0.75, sp = e.T.speed * (e.phase2 ? 1.15 : 1);
    if (stunned || e.stagger > 0) { if (stunned) e.tiltV += Math.sin(time * 18) * 0.6; if (e.st === 1) { e.st = 3; e.stT = 0.5; } } // dazed or staggered: no moving or attacking
    else if (e.flee > 0) { mx = -dx / dist * sp * 1.1; mz = -dz / dist * sp * 1.1; yawT = Math.atan2(-dx, -dz); }
    else if (e.aggro) {
      yawT = Math.atan2(dx, dz);
      if (e.st === 0) { // approach
        const busy = attackers >= ATTACKERS_MAX;
        const want = busy ? 3.5 : (e.T.boss && dist > 7 && e.atkCd <= 0 ? 0 : reach * 0.9);
        if (e.T.boss && dist > 7 && e.atkCd <= 0) { e.st = 1; e.atk = 'charge'; e.stT = e.wind = 0.8; attackers++; }
        else if (!busy && dist <= reach && e.atkCd <= 0) { e.st = 1; e.atk = e.T.boss ? (dist < 2.2 ? 'slam' : 'sweep') : 'strike'; e.stT = e.wind = e.atk === 'slam' ? 1.0 : e.atk === 'sweep' ? 0.7 : e.T.wind; attackers++; }
        else if (dist > want) { mx = dx / dist * sp; mz = dz / dist * sp; }
        if (busy || dist < reach * 1.6) { mx += -dz / dist * sp * 0.35 * e.side; mz += dx / dist * sp * 0.35 * e.side; } // circle around you
      } else if (e.st === 1) { // wind-up: plant feet, raise arms, eyes glow
        e.stT -= dt; turnRate = 2;
        if (e.stT <= 0) {
          e.st = 2; e.stT = e.atk === 'charge' ? 1.2 : 0.18; e.lunge = 0.3;
          if (e.atk !== 'charge') enemyStrike(e, dist, reach, sh, h);
        }
      } else if (e.st === 2) { // strike (the boss's charge keeps rushing until it reaches you)
        e.stT -= dt;
        if (e.atk === 'charge') { mx = Math.sin(e.yaw) * 6; mz = Math.cos(e.yaw) * 6; turnRate = 0.5; if (dist < reach + 0.4) { enemyStrike(e, dist, reach + 0.5, sh, h); e.stT = 0; } }
        if (e.stT <= 0) { e.st = 3; e.stT = e.atk === 'charge' ? 1.5 : 0.4; }
      } else { e.stT -= dt; if (e.stT <= 0) { e.st = 0; e.atkCd = e.T.cd * (e.phase2 ? 0.7 : 1) + Math.random() * 0.5; } } // recover: an opening to hit back
    } else {
      e.wT -= dt; if (e.wT <= 0) { e.wT = 2 + Math.random() * 3; e.wAng = e.yaw + (Math.random() - 0.5) * 2; } // wander, turning gradually
      if (e.leash) e.wAng = Math.atan2(e.home.x - e.x, e.home.z - e.z); // walk back home
      const ws = e.leash ? sp * 0.8 : sp * 0.3;
      mx = Math.sin(e.wAng) * ws; mz = Math.cos(e.wAng) * ws; yawT = e.wAng;
    }
    if (!e.aggro && e.st) e.st = 0;
    e.yaw += wrapAng(yawT - e.yaw) * Math.min(1, dt * turnRate); e.g.rotation.y = e.yaw;
    e.vx *= Math.exp(-dt * 6); e.vz *= Math.exp(-dt * 6);
    const ox = e.x, oz = e.z;
    _ec.set(e.x + (mx + e.vx) * dt, 0, e.z + (mz + e.vz) * dt);
    if (dist < LOD_FAR || (i + Math.floor(time * 60)) % 4 === 0) pushOut(_ec, e.rad * 0.7); // trees, rocks, walls (far ones every 4th frame)
    for (const o of enemies) { if (o === e || o.dead) continue; const ddx = _ec.x - o.x, ddz = _ec.z - o.z, m = (e.rad + o.rad) * 0.8, d2 = ddx * ddx + ddz * ddz; if (d2 < m * m && d2 > 1e-6) { const d = Math.sqrt(d2), push = (m - d) * 0.5; _ec.x += ddx / d * push; _ec.z += ddz / d * push; } } // keep apart
    const vr = Math.hypot(_ec.x, _ec.z); if (vr < 30) { _ec.x *= 30 / vr; _ec.z *= 30 / vr; } // slide along the village edge instead of freezing
    if (heightAt(_ec.x, _ec.z) > -0.6) { e.x = _ec.x; e.z = _ec.z; }
    e.g.position.set(e.x, heightAt(e.x, e.z), e.z);
    // stride-matched walk: the legs cycle at the speed the body actually moves, so feet don't skate
    const moved = Math.hypot(e.x - ox, e.z - oz) / Math.max(dt, 1e-3), amp = Math.min(1, moved / (1.4 * e.T.scale));
    const step = Math.max(0.15, 2 * 0.85 * e.T.scale * Math.sin(0.65 * Math.max(amp, 0.25)));
    e.walk += dt * (moved > 0.05 ? Math.PI * moved / step : 0);
    e.lunge = Math.max(0, e.lunge - dt); const lf = Math.sin(e.lunge / 0.3 * Math.PI);
    const far = dist > LOD_FAR && e.hp >= e.maxHp; // a hurt enemy keeps its full body (flinches, health bar)
    if (far !== e.far) { e.far = far; e.lod.visible = far; e.rig.upper.visible = !far; for (const l of e.rig.legs) l.visible = !far; }
    if (far) continue;
    animateHumanoid(e.rig, e.walk, amp, lf);
    const wind = e.st === 1 ? 1 - e.stT / e.wind : 0;
    if (wind > 0) for (const a of e.rig.arms) a.rotation.x = -0.3 - wind * (e.atk === 'sweep' ? 1.3 : 2.5); // telegraph: arms rise before the blow
    if (wind > 0 && e.atk === 'sweep') { e.rig.arms[0].rotation.z = -0.12 - wind * 1.2; e.rig.arms[1].rotation.z = 0.12 + wind * 1.2; }
    e.tiltV += (-70 * e.tilt - 9 * e.tiltV) * dt; e.tilt += e.tiltV * dt;
    e.upper.rotation.x = e.rig.hunch + e.tilt + lf * 0.35 - wind * 0.25;
    e.flash = Math.max(0, e.flash - dt);
    if (e.flash > 0) e.mat.emissive.setScalar(0.8); else e.mat.emissive.setRGB(wind * 0.5, wind * 0.12, 0); // eyes and body glow during the wind-up
    if (e.hp < e.maxHp) { e.bar.visible = true; e.fg.scale.x = Math.max(0.001, e.hp / e.maxHp); e.bar.lookAt(h); }
  }
}
// the moment a blow lands: hits only if you're still in reach; a raised shield facing the attacker blocks most of it
function enemyStrike(e, dist, reach, sh, h) {
  const area = e.atk === 'slam' ? 2.8 : e.atk === 'sweep' ? 3.0 : reach + 0.35;
  if (e.atk === 'slam') { burst(_wa.set(e.x + Math.sin(e.yaw) * 1.5, heightAt(e.x, e.z) + 0.1, e.z + Math.cos(e.yaw) * 1.5), 0x9b59ff, 40, 4, 1.5); tone(60, 0.5, 'sawtooth', 0.15, -20); }
  if (dist > area) { tone(180, 0.08, 'triangle', 0.04); return; } // missed: you stepped back
  let d = e.dmg * (e.atk === 'slam' ? 1.4 : e.atk === 'charge' ? 1.6 : 1); enemyCenter(e, _ec);
  if (sh && sh.distanceTo(_ec) < e.rad + 0.75) { // the shield must be between you and the attacker
    const tx = _ec.x - h.x, tz = _ec.z - h.z, sx = sh.x - h.x, sz = sh.z - h.z, tl = Math.hypot(tx, tz) || 1, sl = Math.hypot(sx, sz) || 1;
    if ((tx * sx + tz * sz) / (tl * sl) > 0.3) { d *= e.atk === 'slam' ? 0.4 : 0.2; sfx.block(); pulse('left', 1, 80); burst(sh, 0xffffff, 10, 2, 1); e.tiltV -= 6; e.stagger = 0.35; }
  }
  damagePlayer(d);
}

// ---------------------------------------------------------------- ambient sound (all synthesized: no audio files)
// A soft wind bed, birds by day, crickets at night, crackling near the campfire, and footsteps (yours and the
// villagers'), which sound different on grass and on wooden floors.
let windGain = null, windFilter = null, birdT = 2, cricketT = 1, crackleT = 0, stepDist = 0;
const lastStep = { x: 0, z: 0 };
function startWind() {
  const a = ac(); if (!a || windGain) return;
  if (!noiseBuf) { noiseBuf = a.createBuffer(1, a.sampleRate, a.sampleRate); const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }
  const src = a.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
  windFilter = a.createBiquadFilter(); windFilter.type = 'lowpass'; windFilter.frequency.value = 380; windGain = a.createGain(); windGain.gain.value = 0.025;
  src.connect(windFilter).connect(windGain).connect(a.destination); src.start();
}
function updateAmbience(dt) {
  if (!actx || actx.state !== 'running') return; startWind();
  const h = headPos(), night = isNight(), fireD = Math.hypot(h.x, h.z);
  windFilter.frequency.value = 300 + 160 * Math.sin(time * 0.13) + 80 * Math.sin(time * 0.41); windGain.gain.value = 0.018 + 0.012 * (0.5 + 0.5 * Math.sin(time * 0.07)); // gusts
  if (!night) { birdT -= dt; if (birdT <= 0) { birdT = 2 + Math.random() * 4; const f = 2500 + Math.random() * 1500, sl = (Math.random() - 0.5) * 1200; tone(f, 0.05, 'sine', 0.015, sl); tone(f * 1.1, 0.06, 'sine', 0.012, -sl, 0.09); } }
  else { cricketT -= dt; if (cricketT <= 0) { cricketT = 0.9 + Math.random() * 0.4; for (let k = 0; k < 3; k++) tone(4500 + Math.random() * 200, 0.03, 'square', 0.006, 0, k * 0.06); } }
  if (fireD < 7) { crackleT -= dt; if (crackleT <= 0) { crackleT = 0.05 + Math.random() * 0.25; hiss(0.03, 0.05 * (1 - fireD / 7), 1800 + Math.random() * 800); } }
  // your footsteps: one per ~0.7 m walked on the ground
  const moved = Math.hypot(h.x - lastStep.x, h.z - lastStep.z); lastStep.x = h.x; lastStep.z = h.z;
  if (!airborne && moved < 1) { stepDist += moved; if (stepDist > 0.7) { stepDist = 0; const indoors = houseAt(h.x, h.z); hiss(0.05, indoors ? 0.05 : 0.06, indoors ? 900 : 350); if (indoors) tone(140, 0.04, 'triangle', 0.02); } }
  for (const n of villagers) { // villagers' steps nearby, on each foot plant
    if (!n.route.length) continue; const d = Math.hypot(h.x - n.x, h.z - n.z); if (d > 8) continue;
    const ph = Math.floor(((n.walk || 0) + Math.PI / 2) / Math.PI); if (ph !== n.stepPh) { n.stepPh = ph; hiss(0.04, 0.035 * (1 - d / 8), houseAt(n.x, n.z) ? 900 : 380); }
  }
}

// ---------------------------------------------------------------- contact shadows
// A soft dark disc under every character (one instanced draw call) so people and creatures sit on the ground
// instead of floating; real shadow maps would cost far too much on a Quest.
const SHADOW_MAX = 48;
const shadowMesh = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d'), gr = x.createRadialGradient(32, 32, 2, 32, 32, 31);
  gr.addColorStop(0, 'rgba(0,0,0,0.55)'); gr.addColorStop(0.6, 'rgba(0,0,0,0.3)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = gr; x.fillRect(0, 0, 64, 64);
  const m = new THREE.InstancedMesh(new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }), SHADOW_MAX);
  m.frustumCulled = false; m.count = 0; m.renderOrder = 1; scene.add(m); return m;
})();
const _sm = new THREE.Matrix4(), _sp = new THREE.Vector3(), _ss = new THREE.Vector3(), _sq = new THREE.Quaternion();
function updateShadows() {
  const h = headPos(); let n = 0;
  const put = (x, z, r) => { if (n >= SHADOW_MAX || Math.abs(x - h.x) + Math.abs(z - h.z) > 70) return; _sp.set(x, groundAt(x, z) + 0.03, z); _ss.set(r, 1, r); shadowMesh.setMatrixAt(n++, _sm.compose(_sp, _sq, _ss)); };
  for (const e of enemies) if (!e.dead) put(e.x, e.z, 0.42 * e.T.scale * e.T.chestW);
  for (const v of villagers) if (v.act !== 'sleep') put(v.x, v.z, 0.38 * v.g.scale.x);
  for (const id in WEAPONS) { const w = WEAPONS[id]; if (w.state === 'world' && w.rest) put(w.p.x, w.p.z, 0.3); }
  shadowMesh.material.opacity = 0.35 + 0.65 * smoothstep(-0.15, 0.25, sunElev()); // soft at night
  for (const npc of npcs) put(npc.x, npc.z, 0.4);
  shadowMesh.count = n; shadowMesh.instanceMatrix.needsUpdate = true;
}

// ---------------------------------------------------------------- pickups
const pickups = [];
const potionGeo = new THREE.SphereGeometry(0.16, 10, 8), potionMat = new THREE.MeshBasicMaterial({ color: 0xff3355 }), potionNeckGeo = new THREE.CylinderGeometry(0.05, 0.05, 0.14, 6);
function spawnPickup(type, x, z) { const m = new THREE.Mesh(potionGeo, potionMat); const neck = new THREE.Mesh(potionNeckGeo, M.wood); neck.position.y = 0.18; m.add(neck); m.position.set(x, heightAt(x, z) + 0.6, z); scene.add(m); pickups.push({ type, m, x, z, t: 0 }); }
function updatePickups(dt) {
  const h = headPos();
  for (let i = pickups.length - 1; i >= 0; i--) {
    const p = pickups[i]; if (p.flying) continue; p.t += dt; p.gy = p.gy ?? groundAt(p.x, p.z); p.m.scale.setScalar(0.55); p.m.position.y = p.gy + 0.09; // stands on the ground
    if ((p.t % 1.4) < dt) burst(_v2.set(p.x, p.gy + 0.25, p.z), 0xff6688, 2, 0.4, 0.8);
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
  for (const it of items) { if (!it.T.heal || it.gone > 0 || it.held) continue; const dd = Math.hypot(h.x - it.p.x, h.z - it.p.z); if (dd < 1.4 && Math.abs(h.y - it.p.y) < 2.2 && dd < bd) { bd = dd; best = it.eatItem || (it.eatItem = { label: 'Eat the ' + it.T.name, act: () => eatItem(it) }); } }
  { const d = doorAt(h, 1.9); const dw = d && houseToWorld(d.H, 0, DOOR_Z), dd = d ? Math.hypot(h.x - dw.x, h.z - dw.z) + 0.6 : 1e9; if (d && dd < bd) { bd = dd; best = d.item || (d.item = { act: () => { d.target = d.ang > 0.4 ? 0 : 1.5; d.auto = false; } }); best.label = d.ang > 0.4 ? 'Close the door' : 'Open the door'; } }
  for (const id in WEAPONS) { const w = WEAPONS[id]; if (w.state !== 'world' || w.flying) continue; const d = Math.hypot(h.x - w.p.x, h.z - w.p.z); if (d < 2.2 && d < bd) { bd = d; best = w.pickItem || (w.pickItem = { label: 'Pick up the ' + w.def.name, act: () => pickUpWeapon(w) }); } }
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
  const arr = WEAPONS.bow && WEAPONS.bow.state !== 'world' ? 3 + Math.floor(Math.random() * 4) : 0; S.arrows += arr;
  sfx.coin(); sfx.pickup(); burst(c.g.position.clone().add(_v2.set(0, 0.8, 0)), 0xffd54f, 30, 2.5, 2.5);
  toast(`Chest: ${g} gold${pot ? ' and a healing potion' : ''}${arr ? ` and ${arr} arrows` : ''}!  (${S.chests.length}/${chests.length} chests found)`, 3.5, true);
  if (S.chests.length === chests.length) { S.gold += 100; sfx.level(); toast(`Every treasure chest in Emberwild found! A bonus of 100 gold.`, 5); }
  save();
}

// ---------------------------------------------------------------- input
function lockPointer() { try { const p = renderer.domElement.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch (e) { } }
const keys = {}; let interactQueued = false, potionQueued = false, locked = false, running = false;
addEventListener('keydown', e => { keys[e.code] = true; if (!running || paused) return; if (e.code === 'KeyE') interactQueued = true; if (e.code === 'KeyQ') potionQueued = true; if (e.code === 'Space') { e.preventDefault(); jump(); } if (e.code === 'KeyF') startSwap(); if (e.code === 'KeyG') deskDrop(); });
addEventListener('keyup', e => { keys[e.code] = false; });
document.addEventListener('pointerlockchange', () => { locked = document.pointerLockElement === renderer.domElement; if (!locked && running && !inVR && !paused) setPaused(true); });
renderer.domElement.addEventListener('mousedown', e => { if (!running || inVR || paused) return; if (!locked) lockPointer(); if (e.button === 0) startSwing(); });
addEventListener('mouseup', e => { if (e.button === 0) releaseClick(); });
addEventListener('mousemove', e => { if (!locked || inVR) return; yaw -= e.movementX * 0.0022; pitch = clamp(pitch - e.movementY * 0.0022, -1.4, 1.4); });

let swingT = 0, swingHit = false, swingDur = 0.36, bowCharge = -1, swapT = 0, swapped = false;
// Flat screen: click attacks with the weapon in hand (hold and release to shoot the bow); F swaps it with the hip
// (it slides out of view and back), G drops it, E picks up a weapon you stand next to.
function startSwing() {
  if (!deskW) { if (hipW) startSwap(); return; }
  if (swapT > 0 || swingT > 0) return;
  if (deskW.def.bow) { if (arrowsAvailable()) bowCharge = 0; return; }
  swingDur = deskW.def.swing; swingT = swingDur; swingHit = false; sfx.swing();
}
function releaseClick() {
  if (bowCharge >= 0 && deskW?.def.bow && !inVR && bowCharge > 0.08) { const f = camera.getWorldDirection(_wa).clone(); fireArrow(camera.getWorldPosition(_wb).clone().addScaledVector(f, 0.5), f, ARROW_VMAX * Math.min(1, bowCharge)); }
  bowCharge = -1; nockArrow.visible = false;
}
function startSwap() { if (inVR || swapT > 0 || swingT > 0 || (!deskW && !hipW)) return; swapT = 0.4; swapped = false; bowCharge = -1; }
function updateDesktopWeapon(dt) {
  if (inVR) return;
  if (swapT > 0) {
    swapT -= dt; const pr = 1 - Math.max(0, swapT) / 0.4; if (!swapped && pr >= 0.5) { swapped = true; deskSwap(); }
    if (deskW) { deskRest(deskW); deskW.g.position.y -= Math.sin(pr * Math.PI) * 0.6; } return;
  }
  if (!deskW) return;
  const w = deskW, g = w.g, def = w.def;
  if (def.bow) { // string pulls back while the button is held
    deskRest(w); const c = bowCharge >= 0 ? Math.min(1, (bowCharge += dt / 0.8)) : 0;
    bendBow(w, c); const tz = 0.6 - 0.05 * c, ty = 0.12 + 0.07 * c; const a = g.userData.string.geometry.attributes.position; a.setXYZ(0, 0, ty, tz); a.setXYZ(1, 0, 0.12 + c * 0.35, 0); a.setXYZ(2, 0, ty, -tz); a.needsUpdate = true;
    nockArrow.visible = bowCharge >= 0;
    if (nockArrow.visible) { g.updateMatrixWorld(true); g.localToWorld(nockArrow.position.set(0, 0.12 + c * 0.35 - 0.36, 0)); nockArrow.quaternion.setFromUnitVectors(_wa.set(0, 0, -1), _wb.set(0, -1, 0).applyQuaternion(g.getWorldQuaternion(_wq))); }
    return;
  }
  if (swingT > 0) {
    swingT -= dt; const p = 1 - Math.max(0, swingT) / swingDur, s = Math.sin(p * Math.PI), e = p * p * (3 - 2 * p);
    if (def.thrust) { g.position.set(0.22 - e * 0.12, -0.3 + s * 0.06, -0.25 - s * 0.55); g.rotation.set(0.25 - s * 0.1, 0.05, -0.1); }
    else { g.position.set(lerp(0.3, -0.1, e), -0.24 + s * 0.08, -0.45 - s * 0.15); g.rotation.set(0.7 - s * 0.9, lerp(-0.9, 1.0, e), lerp(-0.9, 0.6, e)); }
    if (!swingHit && p > 0.35) {
      swingHit = true; const h = headPos(), f = forward2D(), cone = def.thrust ? 0.8 : 0.4;
      const imp = new THREE.Vector3(f.x * 6 + f.z * 2.5, 1.5, f.z * 6 - f.x * 2.5); // forward + right-to-left sweep
      const inArc = enemies.filter(en => { if (en.dead) return false; const dx = en.x - h.x, dz = en.z - h.z, d = Math.hypot(dx, dz); en._d = d; return d < def.reach + en.rad && (dx * f.x + dz * f.z) / (d || 1) > cone; });
      inArc.sort((a, b) => a._d - b._d).slice(0, def.thrust ? 1 : 2).forEach(en => hitEnemy(en, 1, h.x, h.z, imp, def.dmg(), def.stun)); // a swing connects with the 2 nearest at most
      for (const rd of [...ragdolls]) { const c = rd.P[0].p, dx = c.x - h.x, dz = c.z - h.z, d = Math.hypot(dx, dz); if (d < def.reach && (dx * f.x + dz * f.z) / (d || 1) > 0.3) nudgeRagdoll(rd, imp, 0.8); }
      for (const n of villagers) { const dx = n.x - h.x, dz = n.z - h.z, d = Math.hypot(dx, dz); if (d < def.reach && (dx * f.x + dz * f.z) / (d || 1) > 0.4) villagerFlinch(n); }
    }
    if (swingT <= 0) deskRest(w);
  } else deskRest(w);
}
const _swTip = new THREE.Vector3(), _swHilt = new THREE.Vector3(), _swTipL = new THREE.Vector3(), _swVel = new THREE.Vector3(), _swImp = new THREE.Vector3();
let snapReady = true, runLatch = false;
let airborne = false, jumpVy = 0; const JUMP_V = 3.6, JUMP_G = 9.81; // real gravity; about 0.66 m high, 0.73 s in the air
function jump() { if (airborne || !running) return; airborne = true; jumpVy = JUMP_V; hiss(0.06, 0.05, 300); }
function updateMovement(dt) {
  let mx = 0, mz = 0, run = false, turn = 0;
  if (inVR) {
    const L = hands.left?.src.gamepad, R = hands.right?.src.gamepad;
    if (L) { const ax = L.axes.length >= 4 ? 2 : 0; mx = L.axes[ax] || 0; mz = L.axes[ax + 1] || 0; if (btnEdge('left', 3)) runLatch = true; if (Math.hypot(mx, mz) < 0.2) runLatch = false; run = runLatch; } // click the left stick to sprint
    if (R) { const ax = R.axes.length >= 4 ? 2 : 0; turn = R.axes[ax] || 0; }
    if (btnEdge('right', 4)) { if (interactableAt(headPos())) interactQueued = true; else jump(); } // A: talk/open when something is in reach, otherwise jump
    const qB = btnEdge('right', 5), qY = btnEdge('left', 5); if (qB || qY) potionQueued = true; // B or Y: quick-drink
    if (btnEdge('left', 4)) recenterHeight(true); // X: re-measure seated height
    if (Math.abs(turn) > 0.7 && snapReady) {
      snapReady = false; handHist.left.length = handHist.right.length = 0; const ang = -Math.sign(turn) * Math.PI / 6, h = headPos().clone();
      _v2.subVectors(dolly.position, h).applyAxisAngle(THREE.Object3D.DEFAULT_UP, ang); dolly.position.copy(h).add(_v2); dolly.rotation.y += ang;
      _q1.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, ang); for (const sd of ['left', 'right']) { const gb = grab[sd]; if (gb?.kind === 'weapon') { gb.w.q.premultiply(_q1); gb.w.havePrev = false; gb.w.tipSpeed = 0; } }
    } else if (Math.abs(turn) < 0.3) snapReady = true;
  } else {
    camera.rotation.set(pitch, yaw, 0);
    mx = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0); mz = (keys.KeyS ? 1 : 0) - (keys.KeyW ? 1 : 0); run = keys.ShiftLeft || keys.ShiftRight;
  }
  const mag = Math.hypot(mx, mz);
  if (mag > 0.15) {
    const f = forward2D(), wade = heightAt(headPos().x, headPos().z) < 0 ? 0.55 : 1, speed = (run ? 6.2 : 3.4) * wade * Math.min(1, mag) / mag;
    const rx = -f.z, rz = f.x; // right vector
    movePlayer((f.x * -mz + rx * mx) * speed * dt, (f.z * -mz + rz * mx) * speed * dt);
    if (run) { const hp = headPos(); alertNoise(hp.x, hp.z, 0.4); }
  }
  const h = headPos(); const target = Math.max(groundAt(h.x, h.z), -1.3) + (inVR ? heightOffset : 0); // seated mode lifts the player
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
  const stanceSel = $('gfxStance'); if (stanceSel) { stanceSel.value = GFX.stance; stanceSel.onchange = () => { GFX.stance = stanceSel.value; try { localStorage.setItem(GFX_KEY, JSON.stringify(GFX)); } catch (e) { } }; }
  const gripSel = $('gfxGrip'); if (gripSel) { gripSel.value = GFX.grip; gripSel.onchange = () => { GFX.grip = gripSel.value; try { localStorage.setItem(GFX_KEY, JSON.stringify(GFX)); } catch (e) { } }; }
  const store = () => { GFX.res = resSel.value; GFX.hz = +hzSel.value; try { localStorage.setItem(GFX_KEY, JSON.stringify(GFX)); } catch (e) { } };
  resSel.onchange = store; hzSel.onchange = store;
}

heightAt = terrainH; // from now on everything stands on the exact rendered triangles (world generation used the analytic height)
initWeapons(); // weapons in hand, at the hip and around the world (from the save)
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
const clock = new THREE.Clock(); let uiT = 0, saveT = 0; var frameDt = 1 / 72; const perf = { upd: 0, ren: 0 };
renderer.setAnimationLoop(() => {
  const rawDt = clock.getDelta(); const dt = Math.min(rawDt, 0.05); frameDt = dt; time += dt; if (rawDt > 0) fpsNow = lerp(fpsNow, 1 / rawDt, 0.05);
  pollPause(); const tU0 = performance.now();
  if (running && !paused) {
    updateMovement(dt); updateDesktopWeapon(dt); updateHeldWeapons(dt); updateWorldWeapons(dt); updateArrows(dt); updateSpawns(dt); updateEnemies(dt); updateHands(dt); updateRagdolls(dt); syncArrows(); updateStones(dt); updateItems(dt); updatePickups(dt); updateNPCs(dt); updateVillagers(dt); updateDoors(dt); updateShadows(); updateAmbience(dt);
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
  } else if (!running) {
    yaw += dt * 0.05; camera.rotation.set(-0.05, yaw, 0);
  }
  updateFireGlow(dt);
  fireFlare = Math.max(0, fireFlare - dt); const fl = 1 + fireFlare * 0.4;
  for (let i = 0; i < flames.length; i++) { const f = flames[i]; f.scale.set((1 + Math.sin(time * 13 + i) * 0.12) * fl, (1 + Math.sin(time * 17 + i * 2) * 0.2) * fl, (1 + Math.cos(time * 11 + i) * 0.12) * fl); }
  if (Math.random() < dt * 8) burst(_v3.set((Math.random() - 0.5) * 0.4, VH + 0.9, (Math.random() - 0.5) * 0.4), 0xff8a2a, 1, 0.4, 1.4);
  if (!paused) { updateSky(dt); updateParticles(dt); }
  drawHandFingers(playerHands.left); drawHandFingers(playerHands.right);
  const tR0 = performance.now(); renderer.render(scene, camera); const tR1 = performance.now();
  perf.upd = lerp(perf.upd, tR0 - tU0, 0.05); perf.ren = lerp(perf.ren, tR1 - tR0, 0.05); // CPU ms: game update, and draw submission
});
addEventListener('beforeunload', () => { if (running) save(); });
// ---------------------------------------------------------------- pause and save
// P or Esc (losing the mouse) pauses on a PC; the left controller's menu button pauses in VR, and taking the
// headset off or opening the Quest menu pauses automatically. Pausing always saves.
let paused = false, pauseBtnWas = false, resumeWas = false;
const pausePanel = makePanel(0.8, 0.36, 800, 360, 1.25); pausePanel.mesh.position.set(0, 0, -1.1); pausePanel.mesh.visible = false; camera.add(pausePanel.mesh);
function stamp() { const d = new Date(); return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
function drawPausePanel() {
  const { ctx, canvas } = pausePanel; ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'rgba(20,10,5,0.88)'; rr(ctx, 4, 4, canvas.width - 8, canvas.height - 8, 26); ctx.fill(); ctx.strokeStyle = 'rgba(255,180,90,0.7)'; ctx.lineWidth = 4; ctx.stroke();
  ctx.textAlign = 'center'; ctx.fillStyle = '#ffb347'; ctx.font = 'bold 64px Arial,Arimo,sans-serif'; ctx.fillText('PAUSED', canvas.width / 2, 110);
  ctx.fillStyle = '#ffe9c4'; ctx.font = '34px Arial,Arimo,sans-serif'; ctx.fillText(`Progress saved at ${stamp()}`, canvas.width / 2, 190);
  ctx.font = '30px Arial,Arimo,sans-serif'; ctx.fillText('A: resume     B: save again', canvas.width / 2, 270); pausePanel.refresh();
}
function setPaused(on) {
  if (!running || on === paused) return;
  paused = on;
  if (on) { save(); $('pauseSaved').textContent = `Progress saved at ${stamp()}`; bowCharge = -1; for (const k in keys) keys[k] = false; }
  $('pause').style.display = on && !inVR ? 'flex' : 'none';
  pausePanel.mesh.visible = on && inVR; if (on && inVR) drawPausePanel();
  if (!on && !inVR) lockPointer();
  if (!on && hands.right) hands.right.prev[4] = hands.right.prev[5] = true; // the A that resumed must not also jump or talk
}
function pollPause() { // VR: the left menu button toggles; A resumes; B saves again
  if (!inVR || !running) return;
  const L = hands.left?.src.gamepad, R = hands.right?.src.gamepad;
  const menu = !!(L && L.buttons[7] && L.buttons[7].pressed); if (menu && !pauseBtnWas) setPaused(!paused); pauseBtnWas = menu;
  if (paused && R) { const a = !!R.buttons[4]?.pressed, b = !!R.buttons[5]?.pressed; if (a && !resumeWas) setPaused(false); if (b && !resumeWas) { save(); drawPausePanel(); } resumeWas = a || b; }
}
$('resumeBtn').onclick = () => setPaused(false);
$('saveBtn').onclick = () => { save(); $('pauseSaved').textContent = `Progress saved at ${stamp()}`; };
addEventListener('keydown', e => { if (e.code === 'KeyP' && running && !inVR) setPaused(!paused); });
document.addEventListener('visibilitychange', () => { if (document.hidden && running) { save(); if (!inVR) setPaused(true); } }); // switching away saves (and pauses on a PC)
renderer.xr.addEventListener('sessionstart', () => { const s = renderer.xr.getSession(); if (s) s.addEventListener('visibilitychange', () => { if (s.visibilityState !== 'visible') setPaused(true); }); }); // Quest menu or headset off
if (['localhost', '127.0.0.1'].includes(location.hostname)) { // debug hooks for local testing only
window.__emberwild = { items, perf, doors, setPaused, isPaused: () => paused, weapons: WEAPONS, arrows, deskW: () => deskW, hipW: () => hipW, setDay: v => { dayT = v; }, getDay: () => dayT, SITES, chests, crystals, pickups, villagers, HOUSES, groundAt, houseToWorld, interactableAt, renderer, S, enemies, ragdolls, hitEnemy, playerHands, poseHand, stones, camera, npcs, makeRagdoll, stepRagdoll, heightAt, headPos, dolly, spawnEnemy, startSwing, placePlayer, setYaw: v => { yaw = v; } }; // debug hook
// debug: fake VR controllers for testing grab logic on a desktop browser (no headset needed)
window.__emberwild.simVR = () => {
  const mk = side => { const grip = new THREE.Group(); dolly.add(grip); const btn = () => ({ value: 0, pressed: false, touched: false }); const gamepad = { buttons: [btn(), btn(), btn(), btn(), btn(), btn(), btn()], axes: [0, 0, 0, 0], hapticActuators: [] }; hands[side] = { grip, src: { handedness: side, gamepad }, prev: [], isHand: false }; const ray = new THREE.Group(); grip.add(ray); rays[side] = ray; grip.add(playerHands[side].g); playerHands[side].g.rotation.set(0, 0, 0); return hands[side]; };
  inVR = true; const L = mk('left'), R = mk('right'); weaponsToVR(); L.grip.add(shield);
  return { hands, grab, stones, scabbard, weapons: WEAPONS, hipW: () => hipW, deskW: () => deskW, holdInHand, toHip, bowDraw, handVel: s => handVel(s, new THREE.Vector3()), handHist, S, pickups, bodyPoint, rays, pulling, pullAim, recenter: () => recenterHeight(true), heightOffset: () => heightOffset };
};
}
