// Stress test for the physics: random keys, spaces, returns (including double throws),
// backspace, shift, knob turns and jams at random speeds, on every machine. Fails if the
// simulation ever goes non-finite (the worklet's recover() guard fires) or the carriage
// leaves the rails.
// usage: node tools/fuzz.mjs [seeds=40] [firstSeed=1]
import { fileURLToPath } from 'node:url';
import path from 'node:path';

await import(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/audio/typewriter-processor.js'));
const Sim = globalThis.__TypewriterSim;
const { MARGIN_L, MARGIN_R, PITCH } = globalThis.__TW;

const seeds = +(process.argv[2] || 40), first = +(process.argv[3] || 1);
let recovered = 0;
Sim.prototype.recover = function () { recovered++; this.reset(false); };

const failures = [];
for (let s = first; s < first + seeds; s++) {
  let seed = s * 7919;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const machine = ['portable', 'office', 'plastic'][s % 3];
  const sim = new Sim(48000);
  sim.handle({ t: 'params', machine, hard: rnd(), spring: rnd(), jams: true, volume: 0.8 });
  sim.handle({ t: 'feed' });
  const ev = [];
  let t = 1.2;
  for (let k = 0; k < 70; k++) {
    const r = rnd();
    if (r < 0.06) ev.push({ t: 'return', F: 0.9 + 0.3 * rnd(), at: t });
    else if (r < 0.1) ev.push({ t: 'shift', down: rnd() < 0.5, at: t });
    else if (r < 0.13) ev.push({ t: 'bs', F: 4, at: t });
    else if (r < 0.15) ev.push({ t: 'unjam', at: t });
    else if (r < 0.17) ev.push({ t: 'knob', dv: (rnd() - 0.5) * 0.4, at: t });
    else if (r < 0.3) ev.push({ t: 'space', F: 3 + 3 * rnd(), at: t });
    else ev.push({ t: 'bar', i: Math.floor(rnd() * 47), F: 2.5 + 4 * rnd(), at: t });
    t += rnd() < 0.2 ? rnd() * 0.01 : 0.03 + rnd() * 0.2;
  }
  ev.sort((a, b) => a.at - b.at);
  sim.events = ev;
  const L = new Float32Array(128), R = new Float32Array(128);
  let T = 0;
  recovered = 0;
  for (let b = 0; b < (t + 2) * 375; b++) {
    sim.render(L, R, T);
    T += 128 / 48000;
    const off = sim.x < MARGIN_L - 2 * PITCH || sim.x > MARGIN_R + 2 * PITCH;
    if (recovered || off || !Number.isFinite(L[0] + R[0])) {
      failures.push({ seed: s, machine, t: +T.toFixed(3), why: recovered ? 'non-finite state' : off ? 'carriage off the rails' : 'non-finite audio' });
      break;
    }
  }
  process.stdout.write(failures.length && failures.at(-1).seed === s ? 'x' : '.');
}
console.log(`\n${seeds - failures.length}/${seeds} seeds clean`);
if (failures.length) { console.log(failures); process.exit(1); }
