/*
 * Typewriter — physical simulation, running inside an AudioWorklet.
 *
 * Nothing here is a sample. Every sound is a force between two simulated
 * bodies (slug on platen, dog on rack, hammer on bell, felt under a key...).
 * Those forces drive a modal model of the machine's frame, typebar and bell,
 * and two "pickups" on the frame give the stereo output.
 *
 * The mechanics run at OS x the audio rate (384 kHz at 48 kHz) so that
 * stiff steel-on-steel contacts lasting ~50 µs are resolved properly.
 */

const TAU = Math.PI * 2;
const OS = 8;

// ---------- geometry (SI units) ----------
const PITCH = 0.00254;          // pica, 10 characters per inch
const LINE = 0.0254 / 6;        // 6 lines per inch
const QGAP = 0.0012, QMAX = QGAP + LINE * 1.04;   // line-space lever: free play, full stroke
const ARC = 0.095;              // typebar slug travel, rest -> platen
const KEY_TRAVEL = 0.0115;
const LINK = 6.2;               // typebar drive per metre of key travel
const MARGIN_L = 0.0254;        // 1 inch (tooth 10)
const COLS = 65;
const MARGIN_R = MARGIN_L + COLS * PITCH;
const BELL_AT = MARGIN_R - 7 * PITCH;
const TOP_LINE = 0.0254 + 0.0030;
const SHIFT_H = 0.005;
const NBARS = 47;

// excitation points on the machine
const S_PLATEN = 0, S_REST = 1, S_KEY = 2, S_ESC = 3, S_RAIL = 4, S_MARGIN = 5,
  S_RATCHET = 6, S_LINE = 7, S_SEG = 8, S_BELL = 9;
const NSRC = 10;

// dipole (dF/dt) radiation per excitation point, relative: hard steel-on-steel and the slug
// crack loudest; felt-damped contacts barely click
const CLICK_SRC = [1, 0.15, 0.2, 0.8, 0, 0.8, 0.7, 0.5, 0.25, 0.4];

const MACHINES = {
  // light pressed-steel portable: bright, ringy, tinny
  portable: {
    seed: 1936, frame: { n: 38, fLo: 150, fHi: 11500, dens: 1, tauLo: 0.019, tauHi: 0.0011, ringy: 5, ringQ: 4 },
    desk: 105, deskQ: 3.2, rad: 380,
    mt: 0.0034, mk: 0.018, tbF: 245, mc: 0.8, spring: 6.0, segM: 0.28,
    bellF: 2980, bellT: 1.5, level: 1.0,
    tilt: [-0.15, -0.9, -0.6, 0.35, 0.0, 0.1, 0.35, 0.0, -0.4, 0],
    lvl: [1.0, 0.45, 0.38, 1.25, 0.5, 1.1, 1.0, 0.8, 0.75, 0.05],
    // radiation calibration per excitation point (dB), from tools/calibrate.mjs
    cal: [-22,-25.5,-36.2,-39.3,-33.3,-47.6,-46.2,-43.3,-42.3,-27.3],
  },
  // heavy cast-iron office standard: deep, thunky, short
  office: {
    // frame, desk, radiation and click fitted to a recording of a 1930s Underwood (README: Acoustic calibration)
    seed: 1952, frame: { n: 110, fLo: 120, fHi: 16000, dens: 1.6, tauLo: 0.0073, tauHi: 0.00485, ringy: 3, ringQ: 3 },
    desk: 178, deskQ: 10, deskG: 0.187, rad: 466, air: 12800, click: 2.0, tbQs: 0.73,
    mt: 0.0048, mk: 0.022, tbF: 205, mc: 1.5, spring: 8.5, segM: 0.42,
    bellF: 2350, bellT: 2.2, level: 1.15,
    tilt: [-0.116, -1.0, -0.7, 0.15, 0.0, -0.1, 0.2, -0.1, -0.5, 0],
    lvl: [1.0, 0.5, 0.45, 1.1, 0.55, 1.3, 0.9, 0.85, 0.9, 0.05],
    // radiation calibration per excitation point (dB), from tools/calibrate.mjs
    cal: [-26.6,-42.1,-42.9,-42.5,-31.8,-47.1,-41.4,-47.2,-48.3,-26.8],
  },
  // moulded-plastic portable: dry, clacky, little ring
  plastic: {
    seed: 1968, frame: { n: 34, fLo: 190, fHi: 8000, dens: 1, tauLo: 0.0084, tauHi: 0.00064, ringy: 1, ringQ: 2 },
    desk: 120, deskQ: 3.5, rad: 500,
    mt: 0.0031, mk: 0.014, tbF: 270, mc: 0.7, spring: 5.2, segM: 0.22,
    bellF: 3350, bellT: 0.9, level: 1.1,
    tilt: [0.0, -0.8, -0.3, 0.45, 0.1, 0.2, 0.45, 0.1, -0.2, 0],
    lvl: [1.0, 0.4, 0.55, 1.1, 0.45, 1.0, 1.0, 0.75, 0.7, 0.05],
    // radiation calibration per excitation point (dB), from tools/calibrate.mjs
    cal: [-23,-22.7,-37.8,-38,-30.1,-40.1,-48.5,-38.7,-43.4,-22.9],
  },
};

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(r) {
  return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(TAU * r());
}

// Hunt–Crossley contact: F = k δ^1.5 (1 + λ δ'), never pulling.
function hc(k, d, lam, dv) {
  const F = k * d * Math.sqrt(d) * (1 + lam * dv);
  return F > 0 ? F : 0;
}

// Felt: Hunt–Crossley plus viscous loss, so parts settle instead of chattering.
function felt(k, d, lam, dv, c) {
  const F = k * d * Math.sqrt(d) * (1 + lam * dv) + c * dv;
  return F > 0 ? F : 0;
}

function newKey(m, pre, k) {
  return { m, pre, k, y: 0, v: 0, on: false, t: 0, F: 0, bottom: -1, latch: false };
}

class TypewriterSim {
  constructor(sr) {
    this.sr = sr;
    this.dt = 1 / (sr * OS);
    this.time = 0;
    this.exc = new Float64Array(NSRC);
    this.outbox = [];
    this.events = [];
    this.jams = true;
    this.hard = 0.5;
    this.springAmt = 0.5;
    this.volume = 0.8;
    this.bars = [];
    for (let i = 0; i < NBARS; i++) {
      this.bars.push({
        i, s: 0, v: 0, y: 0, vy: 0, active: false, jammed: false, freed: false, armed: false,
        on: false, t: 0, F: 0, bottom: -1, idle: 0,
        inC: false, cT: 0, cPk: 0, cJ: 0, cV: 0, hits: 0, stroke: 0,
        trace: new Float32Array(192), tn: 0,
      });
    }
    this.active = [];
    this.space = newKey(0.045, 1.1, 160);
    this.bsKey = newKey(0.02, 0.9, 120);
    this.dcL = 0; this.dcR = 0; this.dcxL = 0; this.dcxR = 0;
    this.dcF = new Float64Array(NSRC);
    this.dPrev = new Float64Array(NSRC);   // last sample's excitation, for the dipole (dF/dt) term
    this.srcIdx = new Int32Array(NSRC); this.srcVal = new Float64Array(NSRC);
    this.cg = new Float64Array(NSRC); this.cCache = new Float64Array(NSRC);
    this.kp = 2e8; this.lp = 0.35;
    this.setMachine('portable');
    this.reset(true);
  }

  // ---------------- machine & modal model ----------------
  setMachine(key) {
    const M = MACHINES[key] || MACHINES.portable;
    this.M = M;
    this.machineKey = key;
    const r = rng(M.seed);
    const F = M.frame;
    const modes = [];
    // Modes crowd together going up (plates and shells: density grows with frequency, so
    // the top of the spectrum is a smooth overlapping wash, not separate tones); each mode
    // rings for a decay time tau rather than a fixed Q, as measured on real machines.
    for (let i = 0; i < F.n; i++) {
      const t = Math.pow(i / (F.n - 1), 1 / F.dens);
      const f = F.fLo * Math.pow(F.fHi / F.fLo, t) * (1 + 0.09 * (r() - 0.5));
      const tau = F.tauLo * Math.pow(F.tauHi / F.tauLo, t) * (0.7 + 0.6 * r());
      modes.push({ f, q: Math.max(0.7, Math.PI * f * tau), kind: 'frame' });
    }
    // a few sheet-metal panels ring a little longer than the rest
    for (let j = 0; j < F.ringy; j++) {
      const m = modes[4 + Math.floor(r() * (F.n - 8))];
      m.q *= F.ringQ;
    }
    modes.push({ f: M.desk, q: M.deskQ, kind: 'desk' });
    this.tb0 = modes.length;
    const tbRatios = [1, 6.27, 17.55, 34.39], tbQ = [22, 55, 70, 80];
    for (let j = 0; j < 4; j++) modes.push({ f: M.tbF * tbRatios[j], q: tbQ[j] * (M.tbQs ?? 1), kind: 'typebar' });
    this.bell0 = modes.length;
    const bellR = [1, 1.0036, 2.21, 2.2165, 3.61, 3.627, 5.16, 6.83];
    const bellA = [1, 0.8, 0.55, 0.5, 0.35, 0.3, 0.18, 0.1];
    for (let j = 0; j < bellR.length; j++) {
      const f = M.bellF * bellR[j];
      const tau = M.bellT / (1 + j * 0.35);
      modes.push({ f, q: Math.PI * f * tau, kind: 'bell', a: bellA[j] });
    }

    const n = modes.length;
    this.n = n;
    this.a1 = new Float64Array(n); this.a2 = new Float64Array(n); this.b = new Float64Array(n);
    this.y1 = new Float64Array(n); this.y2 = new Float64Array(n);
    this.gL = new Float64Array(n); this.gR = new Float64Array(n);
    this.G = new Float64Array(NSRC * n);
    this.clk = new Float64Array(NSRC);
    for (let s = 0; s < NSRC; s++) this.clk[s] = (M.click || 0) * (M.clickSrc || CLICK_SRC)[s];
    this.modes = modes;
    for (let i = 0; i < n; i++) this.setMode(i, modes[i].f, modes[i].q);

    // The platen strike point travels with the carriage, so each column drives the frame
    // modes with a different mix of mode shapes: two independent coupling patterns,
    // crossfaded by carriage position (see platenCoupling), keep the energy constant.
    this.nFrame = F.n;
    this.GA = new Float64Array(F.n); this.GB = new Float64Array(F.n);
    const rB = rng(M.seed + 1);
    for (let i = 0; i < n; i++) {
      const m = modes[i];
      const rad = m.f / (m.f + M.rad);                // small bodies radiate lows poorly
      const air = 1 / (1 + Math.pow(m.f / (M.air || 9000), 2));  // air & pickup roll-off
      let gl = rad * air * (0.55 + 0.45 * r()) * (r() < 0.5 ? -1 : 1);
      let gr = rad * air * (0.55 + 0.45 * r()) * (r() < 0.5 ? -1 : 1);
      if (m.kind === 'desk') { gl = gr = 0.9; }
      if (m.kind === 'bell') { gl *= 0.8; gr *= 1.15; } // bell sits on the right
      this.gL[i] = gl; this.gR[i] = gr;
      for (let s = 0; s < NSRC; s++) {
        let g = 0;
        const tilt = Math.pow(m.f / 1000, M.tilt[s]);
        if (m.kind === 'frame') g = M.lvl[s] * tilt * gauss(r) * 0.6;
        else if (m.kind === 'desk') g = M.lvl[s] * (M.deskG ?? 0.35);
        else if (m.kind === 'typebar') g = (M.tbG ?? 1) * (s === S_PLATEN ? 0.5 * (r() < 0.5 ? -1 : 1) : s === S_REST ? 0.12 : 0);
        else if (m.kind === 'bell') g = s === S_BELL ? 2.4 * m.a * (r() < 0.5 ? -1 : 1) : 0;
        this.G[s * n + i] = g * Math.pow(10, (M.cal ? M.cal[s] : 0) / 20);
      }
      if (m.kind === 'frame') {
        this.GA[i] = this.G[S_PLATEN * n + i];
        this.GB[i] = M.lvl[S_PLATEN] * Math.pow(m.f / 1000, M.tilt[S_PLATEN]) * gauss(rB) * 0.6
          * Math.pow(10, (M.cal ? M.cal[S_PLATEN] : 0) / 20);
      }
    }
    this.couplingX = NaN;
    this.y1.fill(0); this.y2.fill(0);
    this.rail = new Float32Array(6000);   // rail roughness, 0.05 mm per sample
    let a = 0, b2 = 0;
    for (let i = 0; i < this.rail.length; i++) {
      a = 0.97 * a + gauss(r) * 0.6;
      b2 = 0.6 * b2 + gauss(r);
      this.rail[i] = a * 0.4 + b2;
    }
  }

  platenCoupling() {
    const u = (this.x - MARGIN_L) / (MARGIN_R - MARGIN_L);
    if (Math.abs(u - this.couplingX) < 0.002) return;
    this.couplingX = u;
    const th = 2.5 * Math.PI * u, c = Math.cos(th), s = Math.sin(th);
    const G = this.G, GA = this.GA, GB = this.GB, o = S_PLATEN * this.n;
    for (let i = 0; i < this.nFrame; i++) G[o + i] = GA[i] * c + GB[i] * s;
  }

  setMode(i, f, q) {
    const w = TAU * f / this.sr;
    const r = Math.exp(-w / (2 * q));
    this.a1[i] = 2 * r * Math.cos(w);
    this.a2[i] = r * r;
    this.b[i] = Math.sin(w);
  }

  // ---------------- state ----------------
  reset(hard) {
    for (const b of this.bars) {
      b.s = 0; b.v = 0; b.y = 0; b.vy = 0; b.active = false; b.jammed = false; b.freed = false; b.armed = false;
      b.on = false; b.inC = false;
    }
    this.active.length = 0;
    this.x = MARGIN_L; this.vx = 0; this.w = MARGIN_L;
    this.eb = { b: 0, v: 0 };        // escapement dog (bumper)
    this.mb = { b: 0, v: 0 };        // left margin stop (bumper)
    this.dog = { z: 0, v: 0, on: false };
    this.q = 0; this.vq = 0;         // carriage-return / line-space lever stroke
    this.hand = { on: false, t: 0, F: 0, rel: Infinity, hit: false };
    this.pawlBase = 0; this.pawlOn = false;
    if (hard) { this.yp = -0.02; this.vp = 0; }
    this.feed = null;
    this.det = { z: 0.0004, v: 0 };  // detent roller
    this.u = 0; this.vu = 0; this.shiftDown = false; this.shiftLock = false;
    this.hm = { h: 0, v: 0 };         // bell hammer
    this.bs = { on: false, target: 0 };
    this.escT = 0; this.escPending = false; this.locked = false;
    this.space.y = 0; this.space.v = 0; this.space.on = false; this.space.latch = false;
    this.bsKey.y = 0; this.bsKey.v = 0; this.bsKey.on = false; this.bsKey.latch = false;
    this.jamCount = 0;
    this.cSleep = false; this.cQuiet = 0; this.sSleep = false; this.sQuiet = 0; this.sCache = 0; this.sUp = false;
  }

  post(m) { this.outbox.push(m); }

  // ---------------- input events ----------------
  handle(e) {
    switch (e.t) {
      case 'bar': {
        const b = this.bars[e.i];
        if (!b) return;
        b.on = true; b.t = 0; b.F = e.F; b.bottom = -1; b.stroke = e.id || 0; b.hits = 0;
        if (!b.active) { b.active = true; b.idle = 0; this.active.push(b); }
        break;
      }
      case 'space': this.pressKey(this.space, e.F * 1.3); break;
      case 'bs': this.pressKey(this.bsKey, e.F); break;
      case 'return':
        this.hand.on = true; this.hand.t = 0; this.hand.F = 15 * (e.F || 1);
        this.hand.rel = Infinity; this.hand.hit = false;
        { // the pawl seats on the ratchet where the lever has it now, and only ever moves forward:
          // rebasing it under a still-stroked lever would hand the pawl spring a phantom tooth
          const seat = this.yp - Math.max(0, this.q - QGAP);
          this.pawlBase = this.pawlOn ? Math.max(this.pawlBase, seat) : seat; this.pawlOn = true;
        }
        this.startDog(); this.wake();
        break;
      case 'shift': this.shiftDown = !!e.down; break;
      case 'lock': this.shiftLock = !!e.on; break;
      case 'unjam':
        // freed bars fall back through the type guide; they can't re-lock on the way out
        for (const b of this.bars) if (b.jammed) { b.jammed = false; b.freed = true; b.v = -0.3; }
        this.jamCount = 0;
        this.post({ t: 'unjam' });
        break;
      case 'knob': this.vp += e.dv; this.wake(); break;
      case 'feed': this.reset(true); this.feed = { target: TOP_LINE }; this.wake(); break;
      case 'params':
        if (e.machine && e.machine !== this.machineKey) this.setMachine(e.machine);
        if (e.hard != null) this.hard = e.hard;
        if (e.spring != null) this.springAmt = e.spring;
        if (e.jams != null) this.jams = e.jams;
        if (e.volume != null) this.volume = e.volume;
        break;
    }
  }

  pressKey(k, F) { k.on = true; k.t = 0; k.F = F; k.bottom = -1; }

  startDog() {
    const ph = this.x / PITCH - Math.floor(this.x / PITCH);
    this.dog.on = true; this.dog.z = 0.0006 * (1 - ph); this.dog.v = 0;
  }

  escRelease() {
    if (this.w + PITCH > MARGIN_R + 1e-7) {
      if (!this.locked) { this.locked = true; this.post({ t: 'locked' }); }
      return;
    }
    this.w += PITCH;
    this.escT = this.time; this.escPending = true;
    this.wake();
  }

  // ---------------- generic finger-driven key ----------------
  stepKey(k, dt, exc, travel) {
    let Ff = 0;
    if (k.on) {
      k.t += dt;
      Ff = k.F * (1 - Math.exp(-k.t / 0.004));
      if (k.t > 0.05 || (k.bottom >= 0 && k.t > k.bottom + 0.008)) k.on = false;
    }
    let F = Ff - (k.pre + k.k * k.y);
    if (k.y > travel) {
      const Fs = felt(3e6, k.y - travel, 1.2, k.v, 10);
      F -= Fs; exc[S_KEY] += 1.4 * Fs;
      if (k.on && k.bottom < 0) k.bottom = k.t;
    } else if (k.y < 0) {
      const Fs = felt(3e6, -k.y, 1.2, -k.v, 10);
      F += Fs; exc[S_KEY] += 0.5 * Fs;
    }
    k.v += F / k.m * dt;
    k.y += k.v * dt;
  }

  // ---------------- one physics substep ----------------
  step(dt, exc) {
    const M = this.M;
    const kp = this.kp, lp = this.lp;

    // ---- typebars ----
    const act = this.active;
    let nearPlaten = 0;
    let lift = 0;
    for (let a = act.length - 1; a >= 0; a--) {
      const b = act[a];
      if (b.jammed) { nearPlaten++; continue; }
      let Ff = 0;
      if (b.on) {
        b.t += dt;
        Ff = b.F * (1 - Math.exp(-b.t / 0.004));
        if (b.t > 0.05 || (b.bottom >= 0 && b.t > b.bottom + 0.008)) b.on = false;
      }
      let Fk = Ff - (0.5 + 60 * b.y);
      if (b.y > KEY_TRAVEL) {
        const F = felt(2.5e6, b.y - KEY_TRAVEL, 1.2, b.vy, 6);
        Fk -= F; exc[S_KEY] += F;
        if (b.on && b.bottom < 0) b.bottom = b.t;
      } else if (b.y < 0) {
        const F = felt(2.5e6, -b.y, 1.2, -b.vy, 6);
        Fk += F; exc[S_KEY] += 0.4 * F;
      }
      let Fb = -(0.08 + 0.8 * b.s);
      const dl = LINK * b.y - b.s;
      if (dl > 0) {
        const F = 3e4 * dl + 3 * (LINK * b.vy - b.v);
        if (F > 0) { Fb += F; Fk -= LINK * F; }
      }
      if (b.s > 0.6 * ARC) Fb -= 4 * (b.s - 0.6 * ARC);    // universal bar
      const dp = b.s - ARC;
      if (dp > 0) {
        const F = hc(kp, dp, lp, b.v);
        Fb -= F; exc[S_PLATEN] += F;
        if (!b.inC) {
          b.inC = true; b.cT = 0; b.cPk = 0; b.cJ = 0; b.cV = b.v; b.tn = 0;
          this.retuneTypebar(b.i);
        }
        b.cT += dt; b.cJ += F * dt; if (F > b.cPk) b.cPk = F;
        if ((this.sub & 1) === 0 && b.tn < b.trace.length) b.trace[b.tn++] = F;
      } else if (b.inC) {
        b.inC = false; b.hits++;
        this.post({
          t: 'strike', bar: b.i, id: b.stroke, hit: b.hits,
          x: this.x, y: this.yp, u: this.u, F: b.cPk, J: b.cJ, dur: b.cT, v: b.cV,
          trace: b.trace.slice(0, b.tn), at: this.time,
        });
      }
      if (b.s < 0) {
        const F = felt(4e6, -b.s, 1.5, -b.v, 2.5);
        Fb += F; exc[S_REST] += F;
      }
      b.vy += Fk / M.mk * dt; b.y += b.vy * dt;
      b.v += Fb / M.mt * dt; b.s += b.v * dt;

      if (!b.armed && b.s > 0.82 * ARC) b.armed = true;
      if (b.armed && b.s < 0.45 * ARC) { b.armed = false; this.escRelease(); }
      if (b.freed && b.s < 0.5 * ARC) b.freed = false;
      if (b.s > 0.93 * ARC && !b.freed) nearPlaten++;
      const l = b.y / KEY_TRAVEL; if (l > lift) lift = l;

      if (!b.on && b.s < 2e-4 && Math.abs(b.v) < 0.02 && b.y < 2e-5 && Math.abs(b.vy) < 0.01) {
        b.idle += dt;
        if (b.idle > 0.01) { b.active = false; b.s = 0; b.v = 0; b.y = 0; b.vy = 0; b.idle = 0; act.splice(a, 1); }
      } else b.idle = 0;
    }
    this.lift = lift;

    // jams: two slugs arriving at the type guide together lock up
    if (nearPlaten >= 2 && this.jams) {
      let fresh = false;
      for (const b of act) {
        if (b.s > 0.93 * ARC && !b.jammed && !b.freed) {
          if (this.jamCount > 0 || act.some(o => o !== b && !o.freed && o.s > 0.93 * ARC)) {
            exc[S_PLATEN] += M.mt * Math.abs(b.v) / dt * 0.6;
            b.jammed = true; b.v = 0; b.on = false; b.inC = false;
            this.jamCount++; fresh = true;
          }
        }
      }
      if (fresh) this.post({ t: 'jam' });
    }

    // ---- space bar & backspace ----
    const sp = this.space;
    if (sp.on || sp.y > 1e-6 || Math.abs(sp.v) > 1e-4) {
      this.stepKey(sp, dt, exc, 0.010);
      if (!sp.latch && sp.y > 0.007) sp.latch = true;
      if (sp.latch && sp.y < 0.0035) { sp.latch = false; this.escRelease(); }
    } else if (sp.y !== 0) { sp.y = 0; sp.v = 0; }
    const bk = this.bsKey;
    if (bk.on || bk.y > 1e-6 || Math.abs(bk.v) > 1e-4) {
      this.stepKey(bk, dt, exc, 0.010);
      if (!bk.latch && bk.y > 0.006) {
        bk.latch = true;
        if (this.w - PITCH >= MARGIN_L - 1e-7) {
          this.bs.on = true; this.bs.target = this.w - PITCH; this.locked = false; this.startDog(); this.wake();
        }
      }
      if (bk.latch && bk.y < 0.002) bk.latch = false;
    } else if (bk.y !== 0) { bk.y = 0; bk.v = 0; }

    // ---- carriage group (lever, platen, carriage, dogs, stops) ----
    if (this.cSleep) {
      for (let k = 0; k < NSRC; k++) exc[k] += this.cCache[k];
    } else {
      const cg = this.cg; cg.fill(0);
      this.stepCarriage(dt, cg);
      for (let k = 0; k < NSRC; k++) exc[k] += cg[k];
      const quiet = !this.hand.on && !this.bs.on && !this.dog.on && !this.feed && !this.pawlOn &&
        Math.abs(this.vx) < 1e-5 && Math.abs(this.eb.v) < 1e-4 && Math.abs(this.mb.v) < 1e-4 &&
        Math.abs(this.mb.b) < 1e-8 && Math.abs(this.vq) < 1e-4 && Math.abs(this.vp) < 4e-5 &&
        Math.abs(this.det.v) < 1e-4 && Math.abs(this.hm.v) < 1e-5 && Math.abs(this.hm.h) < 1e-7;
      if (quiet) {
        this.cQuiet += dt;
        if (this.cQuiet > 0.006) {
          this.cSleep = true; this.cCache.set(cg);
          this.vx = 0; this.eb.v = 0; this.mb.v = 0; this.vq = 0; this.vp = 0; this.det.v = 0;
          this.hm.v = 0; this.hm.h = 0;
        }
      } else this.cQuiet = 0;
    }

    // ---- shift: the whole type segment rides up and down ----
    const up = this.shiftDown || this.shiftLock;
    if (this.sSleep && up !== this.sUp) this.sSleep = false;
    if (this.sSleep) {
      exc[S_SEG] += this.sCache;
    } else {
      this.sUp = up;
      let Fu = (up ? 9 : 0) - 3.6 * (1 + 0.1 * this.u / SHIFT_H);
      let e = 0;
      if (this.u < 0) {
        const F = felt(3e7, -this.u, 6, -this.vu, 60);
        Fu += F; e += F;
      } else if (this.u > SHIFT_H) {
        const F = felt(3e7, this.u - SHIFT_H, 6, this.vu, 60);
        Fu -= F; e += F;
      }
      exc[S_SEG] += e;
      this.vu += Fu / M.segM * dt; this.u += this.vu * dt;
      if (Math.abs(this.vu) < 1e-5) {
        this.sQuiet += dt;
        if (this.sQuiet > 0.006) { this.sSleep = true; this.sCache = e; this.vu = 0; }
      } else this.sQuiet = 0;
    }

    this.time += dt;
  }

  wake() { this.cSleep = false; this.cQuiet = 0; }

  stepCarriage(dt, exc) {
    const M = this.M;
    // hand on the carriage-return lever
    const hand = this.hand;
    let Fhand = 0;
    if (hand.on) {
      hand.t += dt;
      const ramp = Math.min(1, hand.t / 0.015);
      const rel = hand.t > hand.rel ? Math.max(0, 1 - (hand.t - hand.rel) / 0.02) : 1;
      Fhand = hand.F * ramp * rel;
      if (rel === 0 || hand.t > 1.4) { hand.on = false; Fhand = 0; }
    }

    // lever (stroke q, relative to the carriage)
    let Fq = Fhand - (1.0 + 300 * this.q) - 3 * this.vq;
    let Fx = 0;
    if (this.q > QMAX) {
      const F = hc(4e8, this.q - QMAX, 0.6, this.vq);
      Fq -= F; Fx -= F; exc[S_LINE] += F;
    } else if (this.q < 0) {
      const F = felt(4e8, -this.q, 0.6, -this.vq, 20);
      Fq += F; exc[S_LINE] += 0.5 * F;
    }

    // platen: pawl, detent roller, knob, paper feed
    let Fp = -1.2 * this.vp - 0.15 * Math.tanh(this.vp / 0.002);
    if (this.pawlOn) {
      const d = (this.q - QGAP) - (this.yp - this.pawlBase);
      if (d > 0) {
        const F = 3e4 * d + 3 * (this.vq - this.vp);
        if (F > 0) { Fp += F; Fq -= F; exc[S_LINE] += 0.15 * F; }
      }
      // at full stroke the pawl wedges into the ratchet: positive line lock
      const over = (this.yp - this.pawlBase) - (this.q - QGAP);
      // only a seated pawl wedges: if the knob has run the platen ahead, the pawl sits in a gap
      if (over > 0 && over < 0.0005 && this.q > QMAX - 0.0003) {
        const F = hc(5e8, over, 0.5, this.vp - this.vq);
        Fp -= F; Fq += F; exc[S_LINE] += 0.3 * F;
      }
      if (!hand.on && this.q < 2e-4) this.pawlOn = false;
    }
    {
      const ph = (this.yp - TOP_LINE) / LINE;
      const fr = ph - Math.floor(ph);
      const tri = fr < 0.5 ? fr : 1 - fr;             // distance to the notch, in lines
      const rr = Math.sqrt(tri * tri + 0.0036);         // notch bottom rounded by the roller
      const g = 0.0009 * (rr - 0.06);
      const dg = (fr < 0.5 ? 1 : -1) * 0.0009 * (tri / rr) / LINE;
      const det = this.det;
      let Fz = -(2.5 + 800 * det.z);
      const d = g - det.z;
      if (d > 0) {
        const F = hc(5e8, d, 0.5, dg * this.vp - det.v);
        Fz += F; Fp -= F * dg; exc[S_LINE] += 0.25 * F;
      }
      det.v += Fz / 0.003 * dt; det.z += det.v * dt;
    }
    if (this.feed) {
      // a hand rolling the platen knob toward the first line
      const err = this.feed.target - this.yp;
      const vdes = Math.max(-0.12, Math.min(0.12, err * 25));
      Fp += Math.max(-4, Math.min(4, 60 * (vdes - this.vp)));
      if (Math.abs(err) < 0.0003 && Math.abs(this.vp) < 0.01) this.feed = null;
    }
    this.vq += Fq / 0.05 * dt; this.q += this.vq * dt;
    this.vp += Fp / 0.12 * dt; this.yp += this.vp * dt;

    // carriage
    const frac = (this.x - MARGIN_L) / (MARGIN_R - MARGIN_L);
    const spring = M.spring * (0.45 + this.springAmt * 1.1) * (1.15 - 0.3 * frac);
    Fx += spring - 0.6 * Math.tanh(this.vx / 0.003) - 1.5 * this.vx;
    if (this.bs.on) Fx -= 9;

    { // escapement dog
      const eb = this.eb;
      const d = this.x - this.w - eb.b;
      let Fc = 0;
      if (d > 0) {
        Fc = hc(4e9, d, 0.05, this.vx - eb.v);
        Fx -= Fc; exc[S_ESC] += Fc;
        if (this.escPending && Fc > 0) {
          this.escPending = false;
          this.post({ t: 'esc', ms: (this.time - this.escT) * 1000 });
        }
      }
      const Fs = 6e5 * eb.b + 300 * eb.v;
      exc[S_ESC] += 0.4 * Fs;
      eb.v += (Fc - Fs) / 0.008 * dt; eb.b += eb.v * dt;
      if (eb.v < 1e-15 && eb.v > -1e-15) eb.v = 0;
    }
    { // left margin stop
      const mb = this.mb;
      const stop = MARGIN_L - 0.35 * PITCH;
      const d = (stop - this.x) - mb.b;
      let Fc = 0;
      if (d > 0) {
        Fc = hc(5e9, d, 0.1, -this.vx - mb.v);
        Fx += Fc; exc[S_MARGIN] += Fc;
        if (hand.on && !hand.hit) { hand.hit = true; hand.rel = hand.t + 0.03; }
      }
      const Fs = 1.5e6 * mb.b + 600 * mb.v;
      exc[S_MARGIN] += 0.3 * Fs;
      mb.v += (Fc - Fs) / 0.03 * dt; mb.b += mb.v * dt;
      if (Fc === 0 && mb.b < 1e-12 && mb.b > -1e-12 && mb.v < 1e-9 && mb.v > -1e-9) { mb.b = 0; mb.v = 0; }
    }
    if (this.dog.on) { // ratchet dog riding the rack while the carriage goes backwards
      // sawtooth rack: a long ramp the dog rides up going left, and a steep (not
      // vertical) face that holds it going right; an instant step would hand the
      // stiff contact a 0.6 mm penetration in one substep and blow it up
      const H = 0.0006, FACE = 0.02;
      const ph = this.x / PITCH - Math.floor(this.x / PITCH);
      const onFace = ph < FACE * (1 - ph);
      const h = onFace ? H * ph / FACE : H * (1 - ph);
      const dhdx = onFace ? H / (FACE * PITCH) : -H / PITCH;
      const dog = this.dog;
      let Fz = -(1.6 + 400 * dog.z);
      const d = h - dog.z;
      if (d > 0) {
        const F = hc(2e9, d, 0.1, dhdx * this.vx - dog.v);
        Fz += F; Fx -= F * dhdx; exc[S_RATCHET] += F;
      }
      dog.v += Fz / 0.0015 * dt; dog.z += dog.v * dt;
    }
    { // rail roughness under the carriage bearings
      const ri = this.x / 0.00005;
      const i0 = Math.max(0, Math.min(this.rail.length - 2, ri | 0));
      exc[S_RAIL] += (this.rail[i0 + 1] - this.rail[i0]) * this.vx * 40;
    }

    const xPrev = this.x;
    this.vx += Fx / M.mc * dt;
    this.x += this.vx * dt;

    if (this.dog.on) {
      const k0 = Math.floor(xPrev / PITCH + 1e-9), k1 = Math.floor(this.x / PITCH + 1e-9);
      if (k1 < k0) {
        this.w = Math.min(this.w, k0 * PITCH);
        this.locked = false;
        if (this.bs.on && this.w <= this.bs.target + 1e-7) this.bs.on = false;
      }
      if (!hand.on && !this.bs.on && Math.abs(this.vx) < 2e-3 && this.x > this.w - 0.0002) this.dog.on = false;
    }

    // bell: a lug on the carriage flicks the hammer
    if (!this.dog.on && xPrev < BELL_AT && this.x >= BELL_AT && this.vx > 0) {
      this.hm.v = Math.max(0.5, Math.min(1.8, 0.5 + 9 * this.vx));
    }
    {
      const hm = this.hm;
      const GAP = 0.0015;
      let Fh = -60 * hm.h - 0.02 * hm.v;
      if (hm.h > GAP) {
        const F = hc(3e9, hm.h - GAP, 0.02, hm.v);
        Fh -= F; exc[S_BELL] += F;
      } else if (hm.h < 0) {
        Fh += felt(2e6, -hm.h, 2, -hm.v, 3);
      }
      hm.v += Fh / 0.006 * dt; hm.h += hm.v * dt;
      if (hm.h < 1e-12 && hm.h > -1e-12 && hm.v < 1e-9 && hm.v > -1e-9) { hm.h = 0; hm.v = 0; }
    }
  }

  retuneTypebar(i) {
    const k = 0.93 + 0.14 * ((i * 0.618034) % 1);
    const R = [1, 6.27, 17.55, 34.39], Q = [22, 55, 70, 80];
    for (let j = 0; j < 4; j++) this.setMode(this.tb0 + j, this.M.tbF * R[j] * k, Q[j] * (this.M.tbQs ?? 1));
  }

  // ---------------- audio block ----------------
  render(L, R, t0) {
    const N = L.length;
    const exc = this.exc, dcF = this.dcF;
    const n = this.n, a1 = this.a1, a2 = this.a2, b = this.b, y1 = this.y1, y2 = this.y2;
    const gL = this.gL, gR = this.gR, G = this.G;
    const clk = this.clk, dPrev = this.dPrev;
    const lvl = 0.0042 * this.M.level * this.volume;
    const ev = this.events;
    const srcs = this.srcIdx, vals = this.srcVal;
    this.platenCoupling();
    this.kp = 6e7 * Math.pow(10, this.hard * 1.1);
    this.lp = 0.55 - 0.4 * this.hard;
    for (let s = 0; s < N; s++) {
      const tNow = t0 + s / this.sr;
      while (ev.length && ev[0].at <= tNow) this.handle(ev.shift());
      exc.fill(0);
      for (let k = 0; k < OS; k++) { this.sub = k; this.step(this.dt, exc); }
      // per-source DC tracking: static loads (springs, gravity) are inaudible
      // A force on a small body radiates directly as a dipole, p ~ dF/dt: the crack of a
      // short hard contact, broadband up to ~1/(contact time). The frame modes below add the ring.
      let ns = 0, click = 0;
      for (let k = 0; k < NSRC; k++) {
        const e = exc[k] / OS;
        dcF[k] += 0.0015 * (e - dcF[k]);
        const d = e - dcF[k];
        click += clk[k] * (d - dPrev[k]); dPrev[k] = d;
        if (d > 1e-7 || d < -1e-7) { srcs[ns] = k * n; vals[ns] = d; ns++; }
      }
      let l = click, r = click;
      for (let i = 0; i < n; i++) {
        let x = 0;
        for (let j = 0; j < ns; j++) x += G[srcs[j] + i] * vals[j];
        let y = a1[i] * y1[i] - a2[i] * y2[i] + b[i] * x;
        if (y < 1e-18 && y > -1e-18) y = 0;   // no denormals
        y2[i] = y1[i]; y1[i] = y;
        l += gL[i] * y; r += gR[i] * y;
      }
      const ol = l - this.dcxL + 0.9995 * this.dcL; this.dcxL = l; this.dcL = ol;
      const or = r - this.dcxR + 0.9995 * this.dcR; this.dcxR = r; this.dcR = or;
      L[s] = Math.tanh(ol * lvl);
      R[s] = Math.tanh(or * lvl);
    }
    if (this.dcL < 1e-20 && this.dcL > -1e-20) this.dcL = 0;
    if (this.dcR < 1e-20 && this.dcR > -1e-20) this.dcR = 0;
    // last line of defence: an explicit integrator that ever goes non-finite would
    // otherwise leave the machine silent and frozen until reload
    if (!Number.isFinite(this.x + this.vx + this.yp + this.vp + this.u + this.dcL + this.dcR)) this.recover(L, R);
  }

  recover(L, R) {
    const w = Number.isFinite(this.w) ? Math.max(MARGIN_L, Math.min(MARGIN_R, this.w)) : MARGIN_L;
    const y = Number.isFinite(this.yp) ? this.yp : TOP_LINE;
    this.reset(false);
    this.x = this.w = w; this.yp = y; this.vp = 0;
    this.y1.fill(0); this.y2.fill(0); this.dcF.fill(0);
    this.dcL = this.dcR = this.dcxL = this.dcxR = 0;
    L.fill(0); R.fill(0);
    this.post({ t: 'unjam' });
  }

  snapshot() {
    const bars = [];
    for (const b of this.active) bars.push(b.i, b.s / ARC, b.jammed ? 1 : 0);
    return {
      t: 'st', at: this.time, x: this.x, y: this.yp, u: this.u, lift: this.lift || 0,
      bell: this.hm.h, bars, jam: this.jamCount > 0,
    };
  }
}

// ---------------- AudioWorklet glue ----------------
if (typeof AudioWorkletProcessor !== 'undefined') {
  class TypewriterProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this.sim = new TypewriterSim(sampleRate);
      this.blocks = 0;
      this.port.onmessage = (e) => {
        const m = e.data;
        const list = Array.isArray(m) ? m : [m];
        for (const ev of list) {
          if (ev.at == null || ev.at <= currentTime) this.sim.handle(ev);
          else {
            const q = this.sim.events;
            let i = q.length;
            while (i > 0 && q[i - 1].at > ev.at) i--;
            q.splice(i, 0, ev);
          }
        }
      };
    }
    process(inputs, outputs) {
      const out = outputs[0];
      const L = out[0], R = out[1] || out[0];
      this.sim.time = currentTime;
      this.sim.render(L, R, currentTime);
      if (out[1] === undefined) { /* mono fallback */ }
      if ((++this.blocks & 1) === 0) this.sim.outbox.push(this.sim.snapshot());
      if (this.sim.outbox.length) {
        this.port.postMessage(this.sim.outbox);
        this.sim.outbox = [];
      }
      return true;
    }
  }
  registerProcessor('typewriter', TypewriterProcessor);
}

if (typeof globalThis !== 'undefined') {
  globalThis.__TypewriterSim = TypewriterSim;
  globalThis.__TW = { MACHINES, CLICK_SRC, PITCH, LINE, ARC, MARGIN_L, MARGIN_R, TOP_LINE, SHIFT_H, NBARS, COLS, BELL_AT };
}
