import { AudioEngine } from './audio.js';
import { TypewriterScene } from './scene.js';
import { Typist, TEXTS } from './typist.js';
import { BARS, BY_CODE, BY_CHAR, fingerStrength, PITCH, LINE, MARGIN_L, TOP_LINE } from './keymap.js';

const $ = (s) => document.querySelector(s);
const root = document.documentElement;
const canvas = $('#gl');

// ---------- settings ----------
const DEFAULTS = {
  machine: 'portable', touch: 0.45, platen: 0.45, ribbon: 0.85, wear: 0.4,
  spring: 0.5, room: 0.35, volume: 0.8, red: false, jams: true, wpm: 62, text: 'ozymandias',
};
const S = { ...DEFAULTS };
try { Object.assign(S, JSON.parse(localStorage.getItem('typewriter.settings') || '{}')); } catch { /* private mode */ }
const save = () => { try { localStorage.setItem('typewriter.settings', JSON.stringify(S)); } catch { /* ignore */ } };

const engine = new AudioEngine();
const typist = new Typist(engine);
let scene = null;
try { scene = new TypewriterScene(canvas); } catch (err) { fatal(err.message); }

// ---------- per-machine mechanical character of each typebar ----------
function mulberry(a) {
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const gauss = (r) => Math.sqrt(-2 * Math.log(r() + 1e-9)) * Math.cos(2 * Math.PI * r());
let profiles = [];
function buildProfiles() {
  const r = mulberry({ portable: 11, office: 23, plastic: 37 }[S.machine] || 11);
  const closed = new Set('abdegopq@&#690ABDOPQR8%$B'.split(''));
  profiles = BARS.map((b) => ({
    dx: gauss(r) * 0.055, dy: gauss(r) * 0.075, rot: gauss(r) * 0.011,
    tx: gauss(r) * 0.32, ty: gauss(r) * 0.22,
    clog: (closed.has(b.lo) || closed.has(b.hi) ? 0.55 : 0.18) * (0.4 + 0.8 * r()),
  }));
}
buildProfiles();

// ---------- physics state stream from the worklet ----------
const states = [];
let cur = { x: MARGIN_L / 1000, y: -0.02, u: 0, lift: 0, bars: [], jam: false, at: 0 };
const pendingStrikes = [];
let lastStrike = null, lastEsc = null, strikes = 0, lastStrikeT = -1e9;
let ribbonPos = 0;

engine.on((m) => {
  if (m.t === 'st') { states.push(m); if (states.length > 240) states.shift(); }
  else if (m.t === 'strike') pendingStrikes.push(m);
  else if (m.t === 'esc') lastEsc = m.ms;
  else if (m.t === 'jam') toast('Typebars jammed. Press Esc to pull them apart.', true, 0, true);
  else if (m.t === 'unjam') toast(null);
  else if (m.t === 'locked') toast('Carriage at the right margin. Press Enter to return it.', false, 2200);
});

function stateAt(t) {
  if (!states.length) return cur;
  let i = states.length - 1;
  while (i > 0 && states[i].at > t) i--;
  const a = states[i], b = states[i + 1];
  if (!b || b.at <= a.at) return a;
  const f = Math.max(0, Math.min(1, (t - a.at) / (b.at - a.at)));
  return { ...a, x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, u: a.u + (b.u - a.u) * f };
}

function strikeToInstance(m) {
  const p = profiles[m.bar];
  const wear = S.wear;
  const ff = m.F / 300;
  const a = Math.max(0.5, Math.min(3.4, 2.2 * Math.sqrt(Math.max(ff, 0))));
  ribbonPos += 1;
  const ribbonVar = 0.88 + 0.12 * Math.sin(ribbonPos * 0.013) * Math.sin(ribbonPos * 0.0071 + 1.7);
  const ink = Math.max(0.05, (0.3 + 0.75 * S.ribbon) * ribbonVar);
  const w = 0.25 + 1.5 * wear;
  return [
    m.x * 1000, m.y * 1000, m.bar, m.u * 1000,
    p.dx * w, p.dy * w, p.rot * w, ff,
    a, p.tx * (0.4 + wear), p.ty * (0.4 + wear), ink,
    p.clog * wear * wear * 1.4, (ribbonPos * 0.618) % 50, S.red ? 1 : 0, Math.min(0.55, 0.08 + 0.3 * ff * S.ribbon),
  ];
}

// ---------- readouts ----------
const hud = $('#hud');
const traceCanvas = $('#trace'), tctx = traceCanvas.getContext('2d');
const R = {
  ch: $('#r-char'), F: $('#r-force'), v: $('#r-vel'), dur: $('#r-dur'), J: $('#r-imp'), esc: $('#r-esc'), n: $('#r-n'),
  status: $('#status'),
};
function drawTrace() {
  const r = traceCanvas.getBoundingClientRect(), d = Math.min(2, devicePixelRatio || 1);
  const w = r.width, h = r.height;
  if (!w) return;
  if (traceCanvas.width !== Math.round(w * d)) { traceCanvas.width = Math.round(w * d); traceCanvas.height = Math.round(h * d); }
  tctx.setTransform(d, 0, 0, d, 0, 0);
  tctx.clearRect(0, 0, w, h);
  tctx.strokeStyle = 'rgba(255,255,255,.07)'; tctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) { const y = Math.round(2 + (h - 14) * i / 3) + 0.5; tctx.beginPath(); tctx.moveTo(0, y); tctx.lineTo(w, y); tctx.stroke(); }
  tctx.fillStyle = '#85817a'; tctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace'; tctx.textBaseline = 'bottom';
  tctx.textAlign = 'left'; tctx.fillText('0', 0, h); tctx.textAlign = 'right'; tctx.fillText('250 µs', w, h);
  const tr = lastStrike && lastStrike.trace;
  if (!tr || !tr.length) return;
  const dtUs = 2 / ((engine.ctx ? engine.ctx.sampleRate : 48000) * 8) * 1e6;
  const maxF = 700, base = h - 12;
  tctx.beginPath();
  for (let i = 0; i < tr.length; i++) {
    const x = (i * dtUs) / 250 * w, y = 2 + (base - 2) * (1 - Math.min(1, tr[i] / maxF));
    i ? tctx.lineTo(x, y) : tctx.moveTo(x, y);
  }
  tctx.strokeStyle = '#ffb454'; tctx.lineWidth = 1.4; tctx.stroke();
  tctx.lineTo((tr.length - 1) * dtUs / 250 * w, base); tctx.lineTo(0, base); tctx.closePath();
  tctx.fillStyle = 'rgba(255,180,84,.12)'; tctx.fill();
}
function updateReadouts() {
  if (lastStrike) {
    const b = BARS[lastStrike.bar];
    R.ch.textContent = lastStrike.u * 1000 > 2.5 ? b.hi : b.lo;
    R.F.textContent = lastStrike.F.toFixed(0);
    R.v.textContent = lastStrike.v.toFixed(2);
    R.dur.textContent = (lastStrike.dur * 1e6).toFixed(0);
    R.J.textContent = (lastStrike.J * 1000).toFixed(1);
  }
  if (lastEsc != null) R.esc.textContent = lastEsc.toFixed(1);
  R.n.textContent = strikes;
}

// ---------- frame loop: physics state -> scene; the scene draws only when something moved ----------
let lastStatus = '', hudOn = false;
function frame() {
  requestAnimationFrame(frame);
  if (!scene) return;
  if (audioOK) {
    const t = engine.displayTime();
    cur = stateAt(t);
    let changed = false;
    while (pendingStrikes.length && pendingStrikes[0].at <= t) {
      const m = pendingStrikes.shift();
      scene.addStrike(strikeToInstance(m));
      if (m.hit === 1 || !lastStrike || m.F > 20) { lastStrike = m; changed = true; }
      strikes++; lastStrikeT = performance.now();
    }
    if (changed) { updateReadouts(); drawTrace(); }
    else if (lastEsc != null && R.esc.textContent !== lastEsc.toFixed(1)) updateReadouts();
    scene.setState(cur);
    if (!fed && states.length && Math.abs(cur.y * 1000 - TOP_LINE) < 0.4) { fed = true; flushPre(); }
    const on = performance.now() - lastStrikeT < 7000;
    if (on !== hudOn) { hudOn = on; hud.classList.toggle('on', on); }
  }
  scene.tick();
  const col = Math.round((cur.x * 1000 - MARGIN_L) / PITCH);
  const ln = Math.round((cur.y * 1000 - TOP_LINE) / LINE) + 1;
  const st = audioOK && fed ? `col ${col} · line ${ln}` : started ? 'feeding…' : 'no paper';
  if (st !== lastStatus) { R.status.textContent = st; lastStatus = st; }
}

// ---------- input ----------
let started = false;     // paper was asked for
let audioOK = false;     // the worklet is running
let fed = false;         // keys wait until the sheet has wound into place
let lastKeyT = 0;
function touchForce(bar) {
  const now = performance.now();
  const gap = Math.min(400, now - lastKeyT); lastKeyT = now;
  const hurry = 0.94 + 0.06 * Math.min(1, gap / 200);         // fast bursts land a bit lighter
  const human = 1 + 0.07 * gauss(Math.random);
  return (2.7 + S.touch * 3.2) * (bar ? fingerStrength(bar.finger) : 1) * hurry * human;
}
// Keep each keystroke's real spacing (e.timeStamp is when the key went down)
// even when the main thread handles a burst late: if the mapped time has
// already passed, shift the whole mapping later instead of collapsing the
// burst into one audio block, which would fire the typebars together.
let clockOff = null, lastStampT = -1e9, minAt = 0;
function stamp(e) {
  if (!audioOK) return 0;
  const ctxNow = engine.now;
  const nominal = ctxNow - performance.now() / 1000 + 0.012;
  if (clockOff === null || e.timeStamp - lastStampT > 600) clockOff = nominal;
  clockOff = Math.max(clockOff, nominal - 0.05);
  let at = e.timeStamp / 1000 + clockOff;
  if (at < ctxNow + 0.003) { clockOff += ctxNow + 0.003 - at; at = ctxNow + 0.003; }
  // never land among keys replayed from the feed queue: queue after them instead
  if (at < minAt) { clockOff += minAt - at; at = minAt; }
  lastStampT = e.timeStamp;
  return at;
}
// keys pressed while the sheet is still winding in are kept and played after
const preq = [];
function out(ev) {
  if (fed) { engine.send(ev); return; }
  if (preq.length < 80) preq.push([performance.now(), ev]);
}
function flushPre() {
  let at = engine.now + 0.06, prev = preq.length ? preq[0][0] : 0;
  for (const [t, ev] of preq) {
    const gap = (t - prev) / 1000; prev = t;
    at += ev.t === 'shift' ? Math.max(0.01, Math.min(gap, 0.05)) : Math.max(0.085, Math.min(gap, 0.4));
    engine.send({ ...ev, at });
  }
  if (preq.length) minAt = at + 0.09;
  preq.length = 0;
}
const inControl = (el) => el && el.closest && el.closest('#ctl, dialog, #toggles, #credit, #teaser');

window.addEventListener('keydown', (e) => {
  if (inControl(document.activeElement) || $('#more').open) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const bar = BY_CODE.get(e.code);
  const playable = bar || ['Space', 'Enter', 'NumpadEnter', 'Backspace', 'ShiftLeft', 'ShiftRight'].includes(e.code);
  if (!started) { if (playable && !e.repeat) begin(); else return; }
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') { if (!e.repeat) out({ t: 'shift', down: true, at: stamp(e) }); e.preventDefault(); return; }
  if (e.code === 'CapsLock') { engine.send({ t: 'lock', on: e.getModifierState('CapsLock') }); return; }
  if (e.code === 'Escape') { engine.send({ t: 'unjam' }); if (typist.running) stopTypist(); e.preventDefault(); return; }
  if (e.code === 'ArrowUp' || e.code === 'ArrowDown') { engine.send({ t: 'knob', dv: e.code === 'ArrowDown' ? 0.12 : -0.12 }); e.preventDefault(); return; }
  if (typist.running) return;
  if (e.repeat) { if (bar || e.code === 'Space') e.preventDefault(); return; }
  if (bar) { out({ t: 'bar', i: bar.i, F: touchForce(bar), id: Math.random(), at: stamp(e) }); e.preventDefault(); }
  else if (e.code === 'Space') { out({ t: 'space', F: touchForce(null), at: stamp(e) }); e.preventDefault(); }
  else if (e.code === 'Enter' || e.code === 'NumpadEnter') { out({ t: 'return', F: 0.9 + S.touch * 0.25, at: stamp(e) }); e.preventDefault(); }
  else if (e.code === 'Backspace') { out({ t: 'bs', F: touchForce(null), at: stamp(e) }); e.preventDefault(); }
});
window.addEventListener('keyup', (e) => {
  if (!audioOK) return;
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') out({ t: 'shift', down: e.getModifierState('Shift'), at: stamp(e) });
  if (e.code === 'CapsLock') engine.send({ t: 'lock', on: e.getModifierState('CapsLock') });
});
window.addEventListener('blur', () => { if (audioOK) engine.send({ t: 'shift', down: false }); });

// touch keyboards: no physical codes, so play the character like the typist would
const sink = $('#sink');
sink.addEventListener('beforeinput', (e) => {
  e.preventDefault();
  if (!audioOK || !fed || typist.running) return;
  const now = engine.now + 0.02;
  if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') engine.send({ t: 'return', F: 1, at: now });
  else if (e.inputType === 'deleteContentBackward') engine.send({ t: 'bs', F: touchForce(null), at: now });
  else if (e.data) {
    let t = now;
    const batch = [];
    for (const ch of e.data) {
      if (ch === ' ') { batch.push({ t: 'space', F: touchForce(null), at: t }); t += 0.09; continue; }
      const k = BY_CHAR.get(ch);
      if (!k) continue;
      if (k.shift) batch.push({ t: 'shift', down: true, at: t }), (t += 0.07);
      batch.push({ t: 'bar', i: k.bar.i, F: touchForce(k.bar), at: t });
      if (k.shift) batch.push({ t: 'shift', down: false, at: t + 0.05 });
      t += 0.09;
    }
    engine.send(batch);
  }
});
const isTouch = matchMedia('(pointer: coarse)').matches;
let downAt = null;
canvas.addEventListener('pointerdown', (e) => {
  downAt = [e.clientX, e.clientY];
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
});
canvas.addEventListener('pointerup', (e) => {
  // a tap (not a drag) on a phone brings up the keyboard
  if (downAt && isTouch && started && Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) < 8) sink.focus({ preventScroll: true });
  downAt = null;
});

// ---------- view ----------
function fit() { if (scene) scene.resize(innerWidth, innerHeight); }
addEventListener('resize', fit);
const resetBtn = $('#t-reset');
if (scene) scene.onUserView = () => { resetBtn.hidden = false; };
resetBtn.addEventListener('click', () => { scene.resetView(); resetBtn.hidden = true; });

// ---------- controls ----------
function sendParams() {
  engine.send({ t: 'params', machine: S.machine, hard: S.platen, spring: S.spring, jams: S.jams, volume: S.volume });
  engine.setRoom(S.room);
}
for (const id of ['touch', 'platen', 'spring', 'ribbon', 'wear', 'room', 'volume']) {
  const el = $('#' + id), outEl = el.parentElement.querySelector('output');
  const show = () => { outEl.textContent = Math.round(S[id] * 100); };
  el.value = S[id]; show();
  el.addEventListener('input', () => { S[id] = +el.value; show(); save(); sendParams(); });
}
for (const id of ['red', 'jams']) {
  const el = $('#' + id);
  el.checked = S[id];
  el.addEventListener('change', () => {
    S[id] = el.checked; save(); sendParams();
    if (id === 'red' && scene) scene.setRed(S.red);
  });
}
const machineBtns = [...document.querySelectorAll('[data-machine]')];
function setMachine(name) {
  S.machine = name;
  for (const o of machineBtns) o.setAttribute('aria-checked', String(o.dataset.machine === name));
  if (scene) scene.setMachine(name);
}
for (const b of machineBtns) b.addEventListener('click', () => { setMachine(b.dataset.machine); save(); buildProfiles(); sendParams(); });
setMachine(S.machine);
if (scene) scene.setRed(S.red);

const ctl = $('#ctl'), tCtl = $('#t-ctl');
tCtl.addEventListener('click', () => {
  ctl.hidden = !ctl.hidden;
  tCtl.setAttribute('aria-pressed', String(!ctl.hidden));
});

const textSel = $('#text'), wpm = $('#wpm'), wpmOut = $('#wpm-out');
for (const [key, t] of Object.entries(TEXTS)) {
  const o = document.createElement('option'); o.value = key; o.textContent = `${t.title} · ${t.by}`; textSel.append(o);
}
if (!TEXTS[S.text]) S.text = DEFAULTS.text;
textSel.value = S.text;
textSel.addEventListener('change', () => { S.text = textSel.value; save(); });
wpm.value = S.wpm; wpmOut.textContent = S.wpm;
wpm.addEventListener('input', () => { S.wpm = +wpm.value; wpmOut.textContent = S.wpm; save(); });

const tType = $('#t-type'), typeLabel = $('#type-label');
function setTyping(on) {
  tType.classList.toggle('playing', on);
  tType.setAttribute('aria-pressed', String(on));
  typeLabel.textContent = on ? `${TEXTS[S.text].title} · stop` : 'Type a poem';
}
function stopTypist() { typist.stop(); setTyping(false); }
typist.onProgress = () => {};
typist.onDone = () => setTyping(false);
let wantType = false;
tType.addEventListener('click', async () => {
  if (typist.running || wantType) { wantType = false; stopTypist(); return; }
  wantType = true;
  setTyping(true);
  if (!started) await begin();
  await new Promise((r) => { const c = () => (fed || !wantType ? r() : setTimeout(c, 50)); c(); });
  if (!wantType) return;
  wantType = false;
  typist.start(TEXTS[S.text].body, S.wpm, S.touch);
});

$('#b-sheet').addEventListener('click', async () => {
  if (!started) { await begin(); return; }
  if (!audioOK) return;
  wantType = false; stopTypist();
  scene.clearInk(); lastStrike = null; strikes = 0; drawTrace(); updateReadouts();
  fed = false; preq.length = 0;
  engine.send({ t: 'feed' });
});
$('#b-save').addEventListener('click', () => {
  if (!scene) return;
  const c = scene.exportPage();
  c.toBlob((blob) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'typewriter-page.png'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }, 'image/png');
});

const more = $('#more');
$('#b-more').addEventListener('click', () => more.showModal());

// ---------- start ----------
const power = $('#power');
async function begin() {
  if (started || !scene) return;
  started = true;
  power.classList.add('busy');
  $('#power-msg').textContent = 'Feeding a sheet';
  try {
    await Promise.all([engine.start(), scene.buildAtlas()]);
  } catch (err) { fatal('Could not start audio: ' + err.message); return; }
  audioOK = true;
  sendParams();
  fed = false;
  engine.send({ t: 'feed' });
  scene.showPaper(true);
  power.classList.add('gone');
  setTimeout(() => { power.hidden = true; }, 600);
  if (isTouch) sink.focus({ preventScroll: true });
}
$('#power-msg').addEventListener('click', begin);

let toastTimer = 0;
function toast(msg, sticky = false, ms = 2600, warn = false) {
  const el = $('#toast');
  clearTimeout(toastTimer);
  if (!msg) { el.hidden = true; return; }
  el.textContent = msg; el.hidden = false;
  el.classList.toggle('warn', warn);
  if (!sticky) toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}
function fatal(msg) {
  const m = $('#power-msg');
  m.textContent = msg;
  $('#power').classList.remove('busy');
  root.classList.add('ready');
}

fit();
if (new URLSearchParams(location.search).has("debug")) window.__tw = { scene, engine };
drawTrace();
requestAnimationFrame(() => root.classList.add('ready'));
requestAnimationFrame(frame);
