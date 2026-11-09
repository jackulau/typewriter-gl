// The machine in 3D, floating in a dark room under one soft key light.
// Units are millimetres: +y up, +z toward the typist, and the print point
// sits at x = 0 (the carriage slides past it).
//
// The ink is the same model as before: every strike is an instanced glyph
// quad drawn additively into a float "optical density" sheet (Beer–Lambert).
// That sheet is a texture on the paper mesh that wraps the platen. Strikes
// are added incrementally, since addition doesn't care about order. Frames are
// only drawn when something moved.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { BARS, BY_CODE, PAPER_W, PAPER_H, PLATEN_R, SHIFT_H } from './keymap.js';

// ---------- layout ----------
const R = PLATEN_R, RP = R + 0.3;          // platen, and the sheet lying on it
const AY = 100, AZ = -40;                  // platen axis
const PY = AY, PZ = AZ + R;                // print point on the front of the platen
const WRAP_TOP = 32 * Math.PI / 180;       // the printed sheet leaves the platen under the bail
const LEAN = 30 * Math.PI / 180;           // the incoming sheet climbs the paper table at this lean
const CURL = 0.0012;                       // rad/mm: the printed sheet flops back a little as it rises
const DEG = Math.PI / 180;

// where the sheet is, d mm along it from the print point (+ toward the top edge)
function sheetAt(d, out) {
  if (d >= 0) {
    const L1 = RP * WRAP_TOP;
    if (d <= L1) { const t = d / RP; out[0] = AY + RP * Math.sin(t); out[1] = AZ + RP * Math.cos(t); return out; }
    const h = WRAP_TOP + CURL * (d - L1);
    out[0] = AY + RP * Math.sin(WRAP_TOP) + (Math.sin(h) - Math.sin(WRAP_TOP)) / CURL;
    out[1] = AZ + RP * Math.cos(WRAP_TOP) + (Math.cos(h) - Math.cos(WRAP_TOP)) / CURL;
    return out;
  }
  const e = -d, L2 = RP * (Math.PI - LEAN);
  if (e <= L2) { const t = -e / RP; out[0] = AY + RP * Math.sin(t); out[1] = AZ + RP * Math.cos(t); return out; }
  const f = e - L2;
  out[0] = AY - RP * Math.sin(LEAN) + f * Math.cos(LEAN);
  out[1] = AZ - RP * Math.cos(LEAN) - f * Math.sin(LEAN);
  return out;
}

// ---------- ink (ported from the 2D renderer) ----------
const TILE_W = 3.6, TILE_H = 4.6, ATLAS_PPM = 40, ATLAS_COLS = 12, FLOATS = 16;
const INK_PPM = 8;                          // ~203 dpi: also the resolution of "Save page"

const NOISE = `
float twHash(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
float twNoise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
  float a=twHash(i), b=twHash(i+vec2(1,0)), c=twHash(i+vec2(0,1)), d=twHash(i+vec2(1,1));
  return mix(mix(a,b,f.x),mix(c,d,f.x),f.y); }
`;
const PAPER_COL = `
vec3 paperCol(vec2 p){
  float g = twNoise(p * 14.) * 0.5 + twNoise(p * 33.) * 0.3 + twNoise(p * 2.7) * 0.2;
  float fib = smoothstep(0.66, 0.95, twNoise(p * vec2(4.5, 38.) + twNoise(p * 1.7) * 4.));
  float fib2 = smoothstep(0.7, 0.97, twNoise(p * vec2(36., 5.) + 11.3 + twNoise(p * 2.1) * 4.));
  return vec3(0.957, 0.942, 0.905) * (0.972 + 0.04 * g) - (fib + fib2) * 0.014;
}`;

const INK_VS = `
precision highp float;
in vec3 position;
in vec4 a0;   // print x, print line y, bar, segment u   (mm)
in vec4 a1;   // dx, dy, rot, force factor
in vec4 a2;   // contact half-width, tilt x, tilt y, ink
in vec4 a3;   // clog, seed, colour, bleed
uniform vec2 u_paper;
out vec2 v_p;
flat out vec4 f0; flat out vec4 f1; flat out vec4 f2; flat out vec4 f3;
void main(){
  vec2 p = a0.xy + position.xy * vec2(2.7, 3.7);
  v_p = p; f0 = a0; f1 = a1; f2 = a2; f3 = a3;
  gl_Position = vec4(p.x / u_paper.x * 2. - 1., 1. - p.y / u_paper.y * 2., 0., 1.);
}`;

const INK_FS = `
precision highp float;
in vec2 v_p;
flat in vec4 f0; flat in vec4 f1; flat in vec4 f2; flat in vec4 f3;
uniform sampler2D u_atlas; uniform vec2 u_grid; uniform vec2 u_tile; uniform float u_shiftH;
out vec4 o;
${NOISE}
// explicit gradients: implicit ones are undefined inside the tile test and after the
// discard, and pick a coarse mip that outlines every tile in grey
vec2 gx, gy;
vec3 glyph(float idx, vec2 q){
  vec2 uv = q / u_tile + 0.5;
  vec2 cell = vec2(mod(idx, u_grid.x), floor(idx / u_grid.x));
  vec2 k = 1. / (u_tile * u_grid);
  vec3 g = textureGrad(u_atlas, (cell + clamp(uv, 0., 1.)) / u_grid, gx * k, gy * k).rgb;
  vec2 inside = step(0., uv) * step(uv, vec2(1.));
  return g * inside.x * inside.y;
}
float face(vec3 g, float clog, float bleed){
  float m = mix(g.r, smoothstep(0.12, 0.62, g.g), bleed);
  float fill = smoothstep(0.42, 0.75, g.b) * clog;     // grime packed into the counters
  return max(m, fill);
}
void main(){
  gx = dFdx(v_p); gy = dFdy(v_p);
  float yc = v_p.y - f0.y;                 // distance from the platen contact line
  float a = f2.x;
  float P = 1. - (yc * yc) / (a * a);      // Hertzian line-contact pressure
  if (P <= 0.) discard;
  P = sqrt(P);
  vec2 rel = v_p - (f0.xy + f1.xy);
  float c = cos(-f1.z), s = sin(-f1.z);
  vec2 q = vec2(c * rel.x - s * rel.y, s * rel.x + c * rel.y);
  float u = f0.w;
  float m = face(glyph(f0.z * 2., q + vec2(0., u)), f3.x, f3.w)
          + face(glyph(f0.z * 2. + 1., q - vec2(0., u_shiftH - u)), f3.x, f3.w);
  if (m < 0.002) discard;
  P *= clamp(1. + dot(f2.yz, q) * 0.38, 0.04, 2.2);     // slug not quite square to the platen
  vec2 rq = q + vec2(f3.y * 7.31, f3.y * 3.17);          // ribbon fabric under this strike
  float weave = 0.62 + 0.38 * (0.5 + 0.5 * sin(rq.x * 41.)) * (0.5 + 0.5 * sin(rq.y * 41. + 1.3))
              + 0.22 * (twNoise(rq * 11.) - 0.5);
  float fib = 0.78 + 0.44 * twNoise(v_p * 9.) * (0.6 + 0.4 * twNoise(v_p * vec2(2.5, 24.)));
  float ink = f2.w;
  float dry = smoothstep(1.05 - ink, 1.35 - ink, 0.55 * twNoise(rq * 17.) + 0.45 * twNoise(v_p * 33.) + 0.35);
  float T = m * P * pow(max(f1.w, 0.), 0.8) * ink * weave * fib * dry * 2.5;
  float dens = 1.3 * (1. - exp(-T));
  vec3 col = f3.z > 0.5 ? vec3(0.10, 1.05, 0.92) : vec3(1.0, 0.985, 0.90);
  o = vec4(col * dens, min(m, 1.) * P * f1.w * 0.5);
}`;

const FLAT_VS = `
precision highp float;
in vec3 position; in vec2 uv;
out vec2 v_uv;
void main(){ v_uv = uv; gl_Position = vec4(position.xy, 0., 1.); }`;
const FLAT_FS = `
precision highp float;
uniform sampler2D u_ink; uniform vec2 u_paper;
in vec2 v_uv; out vec4 o;
${NOISE}${PAPER_COL}
void main(){
  vec2 p = vec2(v_uv.x * u_paper.x, (1. - v_uv.y) * u_paper.y);
  o = vec4(paperCol(p) * exp(-texture(u_ink, v_uv).rgb), 1.);
}`;

class Ink {
  constructor(renderer) {
    this.r = renderer;
    const w = Math.round(PAPER_W * INK_PPM), h = Math.round(PAPER_H * INK_PPM);
    this.rt = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
      generateMipmaps: true, depthBuffer: false,
    });
    this.rt.texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    this.cap = 256;
    this.buf = new THREE.InstancedInterleavedBuffer(new Float32Array(this.cap * FLOATS), FLOATS, 1);
    this.buf.setUsage(THREE.DynamicDrawUsage);
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0], 3));
    g.setIndex([0, 1, 2, 2, 1, 3]);
    for (let i = 0; i < 4; i++) g.setAttribute('a' + i, new THREE.InterleavedBufferAttribute(this.buf, 4, i * 4));
    g.instanceCount = 0;
    this.mat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: INK_VS, fragmentShader: INK_FS,
      uniforms: {
        u_paper: { value: new THREE.Vector2(PAPER_W, PAPER_H) }, u_atlas: { value: null },
        u_grid: { value: new THREE.Vector2(1, 1) }, u_tile: { value: new THREE.Vector2(TILE_W, TILE_H) },
        u_shiftH: { value: SHIFT_H },
      },
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor,
      // the vertex shader flips y (paper rows run down), which turns the quads clockwise
      depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.mesh);
    this.cam = new THREE.Camera();
    this.pending = [];
    this.wipe = true;
    this.atlas = null;
  }

  get busy() { return this.wipe || (this.pending.length > 0 && this.atlas); }

  flush() {
    const r = this.r, prevRT = r.getRenderTarget(), prevAuto = r.autoClear;
    const cc = r.getClearColor(new THREE.Color()), ca = r.getClearAlpha();
    r.setRenderTarget(this.rt);
    if (this.wipe) { r.setClearColor(0x000000, 0); r.clear(true, false, false); this.wipe = false; }
    r.autoClear = false;
    while (this.atlas && this.pending.length) {
      const n = Math.min(this.cap, this.pending.length);
      for (let i = 0; i < n; i++) this.buf.array.set(this.pending[i], i * FLOATS);
      this.buf.needsUpdate = true;
      this.mesh.geometry.instanceCount = n;
      r.render(this.scene, this.cam);
      this.pending.splice(0, n);
    }
    r.autoClear = prevAuto;
    r.setRenderTarget(prevRT);
    r.setClearColor(cc, ca);
  }

  async buildAtlas() {
    // the webfont stylesheet loads without blocking; give it a few seconds, then fall back
    const wait = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(r, ms))]);
    const link = document.getElementById('webfonts');
    if (link && link.media !== 'all') await wait(new Promise((r) => link.addEventListener('load', r, { once: true })), 4000);
    await wait(document.fonts.load(`64px "Courier Prime"`).catch(() => null), 3000);
    const tw = Math.round(TILE_W * ATLAS_PPM), th = Math.round(TILE_H * ATLAS_PPM);
    const n = BARS.length * 2, rows = Math.ceil(n / ATLAS_COLS);
    const W = tw * ATLAS_COLS, H = th * rows;
    const layer = (blurPx) => {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const x = c.getContext('2d', { willReadFrequently: true });
      x.fillStyle = '#000'; x.fillRect(0, 0, W, H);
      x.fillStyle = '#fff';
      x.font = `${(25.4 / 6) * ATLAS_PPM}px "Courier Prime", "Courier New", monospace`;
      x.textAlign = 'center'; x.textBaseline = 'alphabetic';
      if (blurPx) x.filter = `blur(${blurPx}px)`;
      for (let k = 0; k < n; k++) {
        const b = BARS[k >> 1];
        const col = k % ATLAS_COLS, row = Math.floor(k / ATLAS_COLS);
        x.fillText((k & 1) ? b.hi : b.lo, col * tw + tw / 2, row * th + (TILE_H / 2 + 0.9) * ATLAS_PPM);
      }
      return x.getImageData(0, 0, W, H).data;
    };
    const sharp = layer(0), soft = layer(0.06 * ATLAS_PPM), wide = layer(0.22 * ATLAS_PPM);
    const px = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      px[i * 4] = sharp[i * 4]; px[i * 4 + 1] = soft[i * 4]; px[i * 4 + 2] = wide[i * 4]; px[i * 4 + 3] = 255;
    }
    const t = new THREE.DataTexture(px, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.needsUpdate = true;
    this.mat.uniforms.u_atlas.value = t;
    this.mat.uniforms.u_grid.value.set(ATLAS_COLS, rows);
    this.atlas = t;
  }

  // the whole sheet, flat -> HTMLCanvasElement (~203 dpi)
  exportPage() {
    const r = this.r, w = this.rt.width, h = this.rt.height;
    const out = new THREE.WebGLRenderTarget(w, h, { depthBuffer: false });
    const mat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: FLAT_VS, fragmentShader: FLAT_FS, depthTest: false,
      uniforms: { u_ink: { value: this.rt.texture }, u_paper: { value: new THREE.Vector2(PAPER_W, PAPER_H) } },
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    quad.frustumCulled = false;
    const sc = new THREE.Scene(); sc.add(quad);
    const prev = r.getRenderTarget();
    r.setRenderTarget(out); r.render(sc, this.cam); r.setRenderTarget(prev);
    const px = new Uint8Array(w * h * 4);
    r.readRenderTargetPixels(out, 0, 0, w, h, px);
    out.dispose(); mat.dispose(); quad.geometry.dispose();
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const x = c.getContext('2d');
    const img = x.createImageData(w, h);
    for (let row = 0; row < h; row++) img.data.set(px.subarray((h - 1 - row) * w * 4, (h - row) * w * 4), row * w * 4);
    x.putImageData(img, 0, 0);
    return c;
  }
}

// ---------- the machine ----------
const PAINTS = {
  portable: { body: 0x0d0d0e, rough: 0.26, coat: 1, well: 0x060607, caps: 'black' },
  office:   { body: 0x353c35, rough: 0.68, coat: 0, well: 0x0b0c0b, caps: 'black' },
  plastic:  { body: 0xa9c1b2, rough: 0.4, coat: 0.35, well: 0x1c2420, caps: 'cream' },
};
const ROWS = [
  ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0', 'Minus', 'Equal'],
  ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI', 'KeyO', 'KeyP', 'BracketLeft', 'BracketRight'],
  ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon', 'Quote'],
  ['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM', 'Comma', 'Period', 'Slash'],
];
// body side profile (z, y): front lip, keyboard slope, flat top over the basket and under the carriage
const DECK = (z) => (z <= 50 ? 52 : 52 - (z - 50) * (34 / 125));
// typebar basket: pivots on an arc around the print point
const N_BARS = BARS.length;
const SEG_R = 38, SEG_Y = 60;
const BAR_L = Math.hypot(SEG_R, PY - SEG_Y) - 1.8;
const A_REST = -1 * DEG, A_HIT = Math.PI - Math.atan2(PY - SEG_Y, SEG_R);

const std = (o) => new THREE.MeshStandardMaterial(o);
const phys = (o) => new THREE.MeshPhysicalMaterial(o);

export class TypewriterScene {
  constructor(canvas) {
    const r = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    if (!r.capabilities.isWebGL2) throw new Error('WebGL2 is not available in this browser.');
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.05;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.shadowMap.autoUpdate = false;
    this.r = r;
    this.ink = new Ink(r);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x030304);
    scene.fog = new THREE.Fog(0x030304, 1800, 4200);
    const pm = new THREE.PMREMGenerator(r);
    scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.42;
    pm.dispose();
    this.scene = scene;

    const cam = new THREE.PerspectiveCamera(28, 1, 10, 9000);
    this.cam = cam;
    this.controls = new OrbitControls(cam, canvas);
    Object.assign(this.controls, {
      enableDamping: true, dampingFactor: 0.08, enablePan: false, minDistance: 170, maxDistance: 2600,
      maxPolarAngle: 84 * DEG, rotateSpeed: 0.7, zoomSpeed: 0.9,
    });
    this.controls.target.set(0, 92, 18);
    this.userMoved = false;
    this.controls.addEventListener('start', () => { this.userMoved = true; this.onUserView && this.onUserView(); });

    this.lights();
    this.mat = {
      chrome: std({ color: 0xdedbd5, metalness: 1, roughness: 0.14 }),
      steel: std({ color: 0x9a968f, metalness: 1, roughness: 0.34 }),
      dark: std({ color: 0x1a1a1b, metalness: 0.6, roughness: 0.4 }),
      rubber: std({ color: 0x111111, roughness: 0.6 }),
      bakelite: phys({ color: 0x0b0a09, roughness: 0.3, clearcoat: 0.7, clearcoatRoughness: 0.18 }),
      felt: std({ color: 0x2a2421, roughness: 1 }),
      body: phys({ color: 0x0d0d0e, roughness: 0.26, clearcoat: 1, clearcoatRoughness: 0.06 }),
      well: std({ color: 0x060607, roughness: 0.85 }),
      cap: phys({ color: 0x0a0a0a, roughness: 0.2, clearcoat: 1, clearcoatRoughness: 0.05 }),
      ribbonA: std({ color: 0x141414, roughness: 0.95, side: THREE.DoubleSide }),
      ribbonB: std({ color: 0x7a1d16, roughness: 0.95, side: THREE.DoubleSide }),
    };
    this.buildBody();
    this.buildBasket();
    this.buildKeys();
    this.buildRibbon();
    this.buildCarriage();

    this.state = { x: 25.4, y: -20, u: 0, lift: 0, bars: new Float32Array(N_BARS) };
    this.red = false;
    this.applyCarriage(true);
    this.applyBars(new Float32Array(N_BARS), true);
    this.applyRibbon(0, true);
    this.dirty = true;
    this.shadowDirty = true;
  }

  lights() {
    const s = this.scene;
    const key = new THREE.SpotLight(0xfff3e4, 3.6, 0, 0.42, 0.85, 0);
    key.position.set(-180, 1250, 620);
    key.target.position.set(0, 40, 20);
    key.castShadow = true;
    key.shadow.mapSize.set(1536, 1536);
    key.shadow.camera.near = 600; key.shadow.camera.far = 2400;
    key.shadow.bias = -0.0002; key.shadow.normalBias = 0.5;
    s.add(key, key.target);
    const rim = new THREE.DirectionalLight(0xa8b8d8, 1.6);
    rim.position.set(380, 420, -900);
    s.add(rim);
    s.add(new THREE.HemisphereLight(0xd8dce6, 0x080808, 0.12));
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(9000, 9000), std({ color: 0x08080a, roughness: 1, envMapIntensity: 0.15 }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    s.add(floor);
  }

  add(parent, geo, mat, x = 0, y = 0, z = 0, cast = true) {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = cast; m.receiveShadow = true;
    parent.add(m);
    return m;
  }

  buildBody() {
    const s = this.scene, M = this.mat;
    // lower body: an extruded side profile, slope up from the front lip to the basket
    const sh = new THREE.Shape();
    sh.moveTo(172, 3); sh.lineTo(172, 15); sh.lineTo(50, 49); sh.lineTo(-125, 49); sh.lineTo(-125, 3); sh.closePath();
    const base = new THREE.ExtrudeGeometry(sh, { depth: 294, bevelEnabled: true, bevelThickness: 3, bevelSize: 3, bevelSegments: 3, curveSegments: 4 });
    base.rotateY(-Math.PI / 2); base.translate(147, 0, 0);
    this.add(s, base, M.body);
    // side towers carrying the ribbon spools, and the block the carriage rides on
    for (const sx of [-1, 1]) {
      this.add(s, new RoundedBoxGeometry(56, 30, 176, 3, 5), M.body, sx * 122, 61, -37);
      this.add(s, new THREE.CylinderGeometry(16, 14.5, 4, 48), M.chrome, sx * 125, 78, -14);
      this.add(s, new THREE.CylinderGeometry(13, 13, 14, 48), M.ribbonA, sx * 125, 86.5, -14);
      this.add(s, new THREE.CylinderGeometry(3, 3, 17, 16), M.chrome, sx * 125, 86, -14);
    }
    this.add(s, new RoundedBoxGeometry(192, 26, 96, 3, 4), M.body, 0, 59, -79);
    // carriage rail on top of that block
    this.add(s, new THREE.BoxGeometry(296, 4, 10), M.steel, 0, 73, -40);
    // the basket well, its felt pad and the type segment
    const well = new THREE.Mesh(new THREE.CircleGeometry(96, 64, Math.PI, Math.PI), M.well);
    well.rotation.x = -Math.PI / 2; well.position.set(0, 52.2, PZ); well.receiveShadow = true;
    s.add(well);
    const felt = new THREE.Mesh(new THREE.RingGeometry(SEG_R + BAR_L - 9, SEG_R + BAR_L + 4, 64, 1, Math.PI + 0.12, Math.PI - 0.24), M.felt);
    felt.rotation.x = -Math.PI / 2; felt.position.set(0, 55.6, PZ); felt.receiveShadow = true;
    // the felt sits on a low ledge
    const ledge = new THREE.Mesh(new THREE.CylinderGeometry(SEG_R + BAR_L - 2, SEG_R + BAR_L - 2, 3.4, 64, 1, true, -Math.PI / 2 + 0.12, Math.PI - 0.24), M.dark);
    ledge.position.set(0, 53.9, PZ);
    this.basket = new THREE.Group();
    this.basket.add(felt);
    s.add(ledge, this.basket);
    const seg = new THREE.Mesh(new THREE.CylinderGeometry(SEG_R + 3, SEG_R + 3, 12, 64, 1, true, -88 * DEG, 176 * DEG), M.steel);
    seg.material = M.steel; seg.position.set(0, SEG_Y, PZ); seg.castShadow = true;
    const segTop = new THREE.Mesh(new THREE.RingGeometry(SEG_R - 3, SEG_R + 3, 64, 1, Math.PI + 2 * DEG, 176 * DEG), M.steel);
    segTop.rotation.x = -Math.PI / 2; segTop.position.set(0, SEG_Y + 6, PZ);
    this.basket.add(seg, segTop);
    // card guide, fixed to the frame right under the print line
    this.add(s, new RoundedBoxGeometry(44, 6, 1, 2, 0.4), M.chrome, 0, PY - 4.6, PZ + 1.0, false);
    // space bar on two arms
    this.add(s, new RoundedBoxGeometry(150, 7, 10, 3, 2.5), M.body, 0, 31, 162);
    for (const sx of [-1, 1]) this.add(s, new THREE.BoxGeometry(3, 3, 26), M.chrome, sx * 60, 28, 150);
    // a chrome trim line along the front lip
    this.add(s, new THREE.BoxGeometry(296, 2.2, 1.2), M.chrome, 0, 9, 175.6, false);
  }

  buildBasket() {
    const arm = new THREE.BoxGeometry(1.5, 2.6, BAR_L).translate(0, 0, BAR_L / 2);
    const slug = new THREE.BoxGeometry(3, 5, 3).translate(0, 0, BAR_L);
    this.arms = new THREE.InstancedMesh(arm, this.mat.steel, N_BARS);
    this.slugs = new THREE.InstancedMesh(slug, this.mat.chrome, N_BARS);
    for (const m of [this.arms, this.slugs]) { m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false; this.basket.add(m); }
    this.barPhi = BARS.map((_, i) => (i / (N_BARS - 1) - 0.5) * 2 * 80 * DEG);
    this._o = new THREE.Object3D();
  }

  buildKeys() {
    const C = 8, RW = 6, S = 128;
    const c = document.createElement('canvas'); c.width = C * S; c.height = RW * S;
    const x = c.getContext('2d');
    const font = (px) => `600 ${px}px ui-sans-serif, system-ui, -apple-system, "Helvetica Neue", sans-serif`;
    x.fillStyle = '#fff'; x.textAlign = 'center'; x.textBaseline = 'middle';
    BARS.forEach((b, i) => {
      const cx = (i % C + 0.5) * S, cy = (Math.floor(i / C) + 0.5) * S;
      if (/^[a-z]$/.test(b.lo)) { x.font = font(S * 0.44); x.fillText(b.hi, cx, cy + 3); }
      else { x.font = font(S * 0.3); x.fillText(b.hi, cx, cy - S * 0.17); x.fillText(b.lo, cx, cy + S * 0.19); }
    });
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    this.legendMat = std({ map: tex, transparent: true, roughness: 0.4, depthWrite: false, color: 0xeee8dc });

    this.capRound = new THREE.CylinderGeometry(7.4, 7.4, 3.2, 40).translate(0, -1.6, 0);
    this.capSquare = new RoundedBoxGeometry(15, 5, 14, 2, 1.8).translate(0, -2.5, 0);
    const rim = new THREE.TorusGeometry(7.6, 0.9, 10, 40).rotateX(Math.PI / 2).translate(0, -1.6, 0);
    const stem = new THREE.CylinderGeometry(1.1, 1.1, 1, 8).translate(0, -0.5, 0);
    this.keys = [];
    ROWS.forEach((row, r) => {
      const z = 100 + 16 * r, top = 62 - 7 * r;
      row.forEach((code, i) => {
        const bar = BY_CODE.get(code);
        const kx = (i - (row.length - 1) / 2) * 19 + (r - 1.5) * 4.5;
        const g = new THREE.PlaneGeometry(11, 11).rotateX(-Math.PI / 2);
        const uv = g.attributes.uv;
        const col = bar.i % C, rr = Math.floor(bar.i / C);
        for (let k = 0; k < uv.count; k++) uv.setXY(k, (col + uv.getX(k)) / C, 1 - (rr + 1 - uv.getY(k)) / RW);
        const legend = new THREE.Mesh(g, this.legendMat);
        legend.renderOrder = 1;
        this.scene.add(legend);
        this.keys.push({ bar: bar.i, x: kx, z, top, deck: DECK(z), legend, press: -1 });
      });
    });
    const n = this.keys.length;
    this.caps = new THREE.InstancedMesh(this.capRound, this.mat.cap, n);
    this.rims = new THREE.InstancedMesh(rim, this.mat.chrome, n);
    this.stems = new THREE.InstancedMesh(stem, this.mat.steel, n);
    for (const m of [this.caps, this.rims, this.stems]) { m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false; this.scene.add(m); }
    this.keyOf = new Map(this.keys.map((k, j) => [k.bar, j]));
  }

  buildRibbon() {
    const NC = 57;
    const mk = (mat) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(NC * 2 * 3), 3));
      const idx = [];
      for (let i = 0; i < NC - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3); }
      g.setIndex(idx);
      const m = new THREE.Mesh(g, mat);
      m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false;
      this.scene.add(m);
      return m;
    };
    this.ribbon = [mk(this.mat.ribbonA), mk(this.mat.ribbonB)];
    this.ribbonNC = NC;
    // vibrator: the little fork that lifts the ribbon in front of the slug
    this.vib = new THREE.Group();
    for (const sx of [-1, 1]) this.add(this.vib, new THREE.BoxGeometry(1.2, 15, 1.2), this.mat.chrome, sx * 8, 0, PZ + 3.4);
    this.scene.add(this.vib);
  }

  buildCarriage() {
    const M = this.mat;
    const car = new THREE.Group();
    this.carriage = car;
    this.scene.add(car);
    const mid = PAPER_W / 2;
    // rotating assembly: rubber platen and its two fluted knobs
    const rot = new THREE.Group();
    rot.position.set(mid, AY, AZ);
    car.add(rot);
    this.platen = rot;
    this.add(rot, new THREE.CylinderGeometry(R, R, PAPER_W + 34, 72, 1).rotateZ(Math.PI / 2), M.rubber);
    const knob = new THREE.CylinderGeometry(16, 16, 19, 144, 1);
    const p = knob.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const vx = p.getX(i), vz = p.getZ(i), rr = Math.hypot(vx, vz);
      if (rr < 1) continue;
      const a = Math.atan2(vx, vz);
      const k = (16 - 0.75 * (0.5 + 0.5 * Math.cos(24 * a))) / rr;
      p.setX(i, vx * k); p.setZ(i, vz * k);
    }
    knob.computeVertexNormals();
    knob.rotateZ(Math.PI / 2);
    for (const sx of [-1, 1]) {
      this.add(rot, knob, M.bakelite, sx * (mid + 33), 0, 0);
      this.add(rot, new THREE.CylinderGeometry(6, 6, 6, 32).rotateZ(Math.PI / 2), M.chrome, sx * (mid + 21.5), 0, 0);
    }
    // carriage end plates and the frame bar underneath
    for (const ex of [-19.5, PAPER_W + 19.5]) this.add(car, new RoundedBoxGeometry(4, 46, 56, 2, 1.5), M.dark, ex, AY + 2, AZ - 4);
    this.add(car, new RoundedBoxGeometry(PAPER_W + 44, 5, 26, 2, 1.5), M.dark, mid, 77, AZ - 2);
    // paper bail with its rubber rollers, resting on the sheet
    const bA = WRAP_TOP - 5 * DEG, bR = RP + 2.4;
    const by = AY + bR * Math.sin(bA), bz = AZ + bR * Math.cos(bA);
    this.add(car, new THREE.CylinderGeometry(2.1, 2.1, PAPER_W + 38, 20).rotateZ(Math.PI / 2), M.chrome, mid, by, bz);
    for (const rx of [44, 172]) this.add(car, new THREE.CylinderGeometry(4.2, 4.2, 13, 24).rotateZ(Math.PI / 2), M.rubber, rx, AY + (RP + 4.4) * Math.sin(bA), AZ + (RP + 4.4) * Math.cos(bA));
    // paper table behind, at the lean of the incoming sheet
    const t0 = [AY - RP * Math.sin(LEAN), AZ - RP * Math.cos(LEAN)];
    const along = new THREE.Vector3(0, Math.cos(LEAN), -Math.sin(LEAN));
    const outN = new THREE.Vector3(0, -Math.sin(LEAN), -Math.cos(LEAN));
    const table = this.add(car, new RoundedBoxGeometry(PAPER_W + 20, 1.6, 64, 2, 0.7), M.dark);
    table.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), along);
    table.position.set(mid, t0[0], t0[1]).addScaledVector(along, 40).addScaledVector(outN, 2.2);
    // carriage return lever on the left
    const lever = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-20, AY + 10, AZ + 8), new THREE.Vector3(-23, AY + 26, AZ + 26),
      new THREE.Vector3(-30, AY + 32, AZ + 52), new THREE.Vector3(-44, AY + 33, AZ + 70),
    ]);
    this.add(car, new THREE.TubeGeometry(lever, 32, 2.2, 10), M.chrome);
    this.add(car, new THREE.SphereGeometry(5, 24, 16), M.bakelite, -46, AY + 33, AZ + 72);

    // the sheet
    const NR = 220;
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array((NR + 1) * 2 * 3), uv = new Float32Array((NR + 1) * 2 * 2);
    for (let i = 0; i <= NR; i++) {
      for (let j = 0; j < 2; j++) {
        const k = i * 2 + j;
        pos[k * 3] = j * PAPER_W;
        uv[k * 2] = j; uv[k * 2 + 1] = 1 - i / NR;
      }
    }
    const idx = [];
    for (let i = 0; i < NR; i++) { const a = i * 2, b = a + 1, c = a + 2, d = a + 3; idx.push(a, c, b, b, c, d); }
    g.setIndex(idx);
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(pos.length), 3));
    const pm = std({ color: 0xffffff, roughness: 0.86, side: THREE.DoubleSide });
    const inkTex = this.ink.rt.texture;
    pm.onBeforeCompile = (sh) => {
      sh.uniforms.uInk = { value: inkTex };
      sh.uniforms.uPaper = { value: new THREE.Vector2(PAPER_W, PAPER_H) };
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vPaperUv;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\nvPaperUv = uv;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>\nvarying vec2 vPaperUv;\nuniform sampler2D uInk;\nuniform vec2 uPaper;\n${NOISE}${PAPER_COL}`)
        .replace('#include <map_fragment>', `{
          vec2 pmm = vec2(vPaperUv.x * uPaper.x, (1. - vPaperUv.y) * uPaper.y);
          vec3 ink = texture2D(uInk, vPaperUv).rgb * (gl_FrontFacing ? 1. : 0.1);
          float edge = min(min(pmm.x, uPaper.x - pmm.x), min(pmm.y, uPaper.y - pmm.y));
          vec3 base = pow(paperCol(pmm), vec3(2.2)) * (0.9 + 0.1 * smoothstep(0., 1.2, edge));
          diffuseColor.rgb *= base * exp(-2.2 * ink);
        }`);
    };
    this.paper = new THREE.Mesh(g, pm);
    this.paper.receiveShadow = true;
    this.paper.frustumCulled = false;
    this.paper.visible = false;
    this.paperRows = NR;
    car.add(this.paper);
  }

  // ---------- state -> pose ----------
  setMachine(name) {
    const P = PAINTS[name] || PAINTS.portable;
    const b = this.mat.body;
    b.color.setHex(P.body); b.roughness = P.rough; b.clearcoat = P.coat; b.clearcoatRoughness = 0.08;
    this.mat.well.color.setHex(P.well);
    const cream = P.caps === 'cream';
    this.caps.geometry = cream ? this.capSquare : this.capRound;
    this.mat.cap.color.setHex(cream ? 0xefe8d6 : 0x0a0a0a);
    this.mat.cap.roughness = cream ? 0.42 : 0.2;
    this.mat.cap.clearcoat = cream ? 0.15 : 1;
    this.legendMat.color.setHex(cream ? 0x2a2622 : 0xeee8dc);
    this.rims.visible = !cream;
    this.keyTopShift = cream ? 1.4 : 0;
    for (const k of this.keys) k.press = -1;
    this.applyBars(this.state.bars, true);
    this.dirty = this.shadowDirty = true;
  }

  setRed(on) { this.red = on; this.applyRibbon(this.state.lift, true); }
  showPaper(on) { this.paper.visible = on; this.dirty = true; }
  addStrike(inst) { this.ink.pending.push(inst); }
  clearInk() { this.ink.pending.length = 0; this.ink.wipe = true; }
  buildAtlas() { return this.ink.buildAtlas(); }
  exportPage() { return this.ink.exportPage(); }

  setState(st) {
    const s = this.state;
    const x = st.x * 1000, y = st.y * 1000, u = st.u * 1000;
    if (Math.abs(x - s.x) > 1e-3 || Math.abs(y - s.y) > 1e-3) { s.x = x; s.y = y; this.applyCarriage(); }
    if (Math.abs(u - s.u) > 1e-3) { s.u = u; this.basket.position.y = -u; this.applyBars(s.bars, true); }
    if (Math.abs((st.lift || 0) - s.lift) > 1e-3) this.applyRibbon(st.lift || 0);
    const nb = new Float32Array(N_BARS);
    const bars = st.bars || [];
    for (let j = 0; j < bars.length; j += 3) nb[bars[j]] = bars[j + 1];
    this.applyBars(nb);
  }

  applyCarriage() {
    const s = this.state;
    this.carriage.position.x = -s.x;
    this.platen.rotation.x = -s.y / RP;
    const pos = this.paper.geometry.attributes.position.array, nor = this.paper.geometry.attributes.normal.array;
    const NR = this.paperRows, o = [0, 0], o2 = [0, 0];
    for (let i = 0; i <= NR; i++) {
      const d = s.y - (i / NR) * PAPER_H;
      sheetAt(d, o); sheetAt(d + 0.5, o2);
      // the outward normal is the tangent turned a quarter
      const ty = o2[0] - o[0], tz = o2[1] - o[1], l = Math.hypot(ty, tz) || 1;
      for (let j = 0; j < 2; j++) {
        const k = (i * 2 + j) * 3;
        pos[k + 1] = o[0]; pos[k + 2] = o[1];
        nor[k] = 0; nor[k + 1] = -tz / l; nor[k + 2] = ty / l;
      }
    }
    this.paper.geometry.attributes.position.needsUpdate = true;
    this.paper.geometry.attributes.normal.needsUpdate = true;
    this.dirty = this.shadowDirty = true;
  }

  applyBars(nb, force = false) {
    const s = this.state, o = this._o;
    let any = false;
    for (let i = 0; i < N_BARS; i++) {
      if (!force && nb[i] === s.bars[i]) continue;
      s.bars[i] = nb[i];
      any = true;
      const phi = this.barPhi[i];
      const p = Math.max(-0.08, Math.min(1.04, nb[i]));
      const a = A_REST + (A_HIT - A_REST) * p;
      o.position.set(SEG_R * Math.sin(phi), SEG_Y, PZ + SEG_R * Math.cos(phi));
      o.rotation.set(-a, phi, 0, 'YXZ');
      o.updateMatrix();
      this.arms.setMatrixAt(i, o.matrix);
      this.slugs.setMatrixAt(i, o.matrix);
      const kj = this.keyOf.get(i);
      if (kj !== undefined) this.poseKey(kj, Math.min(1, Math.max(0, nb[i]) * 1.8));
    }
    if (!any) return;
    this.arms.instanceMatrix.needsUpdate = true;
    this.slugs.instanceMatrix.needsUpdate = true;
    this.caps.instanceMatrix.needsUpdate = true;
    this.rims.instanceMatrix.needsUpdate = true;
    this.stems.instanceMatrix.needsUpdate = true;
    this.dirty = this.shadowDirty = true;
  }

  poseKey(j, press) {
    const k = this.keys[j], o = this._o;
    k.press = press;
    const top = k.top + (this.keyTopShift || 0) - press * 4;
    o.rotation.set(0, 0, 0);
    o.position.set(k.x, top, k.z); o.scale.set(1, 1, 1); o.updateMatrix();
    this.caps.setMatrixAt(j, o.matrix);
    this.rims.setMatrixAt(j, o.matrix);
    k.legend.position.set(k.x, top + 0.12, k.z);
    const stemTop = top - 3;
    o.position.set(k.x, stemTop, k.z); o.scale.set(1, Math.max(1, stemTop - k.deck), 1); o.updateMatrix();
    this.stems.setMatrixAt(j, o.matrix);
    o.scale.set(1, 1, 1);
  }

  applyRibbon(lift, force = false) {
    if (!force && Math.abs(lift - this.state.lift) < 1e-3) return;
    this.state.lift = lift;
    const l = Math.max(0, Math.min(1, (lift - 0.12) / 0.7));
    const e = l * l * (3 - 2 * l);
    const rest = PY - 7.2, up = this.red ? PY + 3.2 + 6.35 : PY + 3.2;
    const mid = rest + (up - rest) * e;
    const NC = this.ribbonNC, H = 6.35;
    const [A, B] = this.ribbon.map((m) => m.geometry.attributes.position.array);
    for (let i = 0; i < NC; i++) {
      const x = -111 + (222 * i) / (NC - 1), ax = Math.abs(x);
      const t = Math.max(0, Math.min(1, (ax - 9) / 26));
      const top = mid + (rest - mid) * (t * t * (3 - 2 * t));
      const q = Math.max(0, Math.min(1, (ax - 9) / 102));
      const z = PZ + 2.4 + 5.2 * q * q * (3 - 2 * q);
      for (let j = 0; j < 2; j++) {
        const k = (i * 2 + j) * 3;
        A[k] = B[k] = x; A[k + 2] = B[k + 2] = z;
        A[k + 1] = top - j * H;
        B[k + 1] = top - H - j * H;
      }
    }
    for (const m of this.ribbon) { m.geometry.attributes.position.needsUpdate = true; m.geometry.computeVertexNormals(); }
    this.vib.position.set(0, mid - 6, 0);
    this.dirty = this.shadowDirty = true;
  }

  // ---------- view ----------
  resize(w, h) {
    this.r.setSize(w, h, false);
    this.cam.aspect = w / h;
    this.cam.updateProjectionMatrix();
    if (!this.userMoved) this.resetView();
    this.dirty = true;
  }

  resetView() {
    const fit = 1.08 * Math.max(980, 470 / (2 * Math.tan(14 * DEG) * this.cam.aspect));
    const pol = 57 * DEG, az = 24 * DEG;
    const t = this.controls.target.set(0, 92, 18);
    this.cam.position.set(t.x + fit * Math.sin(pol) * Math.sin(az), t.y + fit * Math.cos(pol), t.z + fit * Math.sin(pol) * Math.cos(az));
    this.cam.lookAt(t);
    this.controls.update();
    this.userMoved = false;
    this.dirty = true;
  }

  tick() {
    let need = this.dirty;
    if (this.controls.update()) need = true;
    if (this.ink.busy) { this.ink.flush(); need = true; }
    if (!need) return;
    this.dirty = false;
    if (this.shadowDirty) { this.r.shadowMap.needsUpdate = true; this.shadowDirty = false; }
    this.r.render(this.scene, this.cam);
  }
}
