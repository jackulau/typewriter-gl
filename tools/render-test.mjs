// Offline render of the typewriter physics: prints contact metrics, writes a WAV.
// usage: node tools/render-test.mjs [machine] [out.wav]
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
await import(path.join(here, '../src/audio/typewriter-processor.js'));
const Sim = globalThis.__TypewriterSim;
const TW = globalThis.__TW;

const SR = 48000;
const machine = process.argv[2] || 'portable';
const out = process.argv[3] || '/tmp/tw.wav';
const sim = new Sim(SR);
sim.handle({ t: 'params', machine });
sim.handle({ t: 'feed' });

const ev = [];
let t = 0.6;
const LOWER = '1234567890-=qwertyuiop[]asdfghjkl;\'zxcvbnm,./`\\';
const UPPER = '!@#$%^&*()_+QWERTYUIOP{}ASDFGHJKL:"ZXCVBNM<>?~|';
function type(str, gap = 0.11, F = 7) {
  for (const ch of str) {
    if (ch === ' ') ev.push({ t: 'space', F, at: t });
    else if (ch === '\n') { ev.push({ t: 'return', F: 1, at: t }); t += 0.5; }
    else {
      let i = LOWER.indexOf(ch), up = false;
      if (i < 0) { i = UPPER.indexOf(ch); up = true; }
      if (up) ev.push({ t: 'shift', down: true, at: t - 0.07 });
      ev.push({ t: 'bar', i, F, at: t, id: ev.length });
      if (up) ev.push({ t: 'shift', down: false, at: t + 0.06 });
    }
    t += gap;
  }
}
type('The quick brown fox.');
t += 0.3;
type('x'.repeat(48), 0.09);   // run toward the bell / margin
t += 0.4;
ev.push({ t: 'bs', F: 7, at: t }); t += 0.3;
type('\n');
type('soft', 0.12, 3);        // light touch
t += 0.6;
ev.sort((a, b) => a.at - b.at);
sim.events = ev;

const total = Math.ceil((t + 0.5) * SR);
const L = new Float32Array(total), R = new Float32Array(total);
const B = 128;
const msgs = [];
const c0 = process.cpuUsage();
for (let i = 0; i < total; i += B) {
  const l = L.subarray(i, Math.min(total, i + B)), r = R.subarray(i, Math.min(total, i + B));
  sim.time = i / SR;
  sim.render(l, r, i / SR);
  for (const m of sim.outbox) if (m.t !== 'st') msgs.push(m);
  sim.outbox = [];
}
const cu = process.cpuUsage(c0); const cpu = (cu.user + cu.system) / 1e6;

let nan = 0, peak = 0, sq = 0;
for (let i = 0; i < total; i++) { const v = L[i]; if (!Number.isFinite(v)) nan++; peak = Math.max(peak, Math.abs(v)); sq += v * v; }
console.log(`machine=${machine} dur=${(total / SR).toFixed(2)}s cpu=${cpu.toFixed(2)}s (${(cpu / (total / SR) * 100).toFixed(0)}% realtime) peak=${peak.toFixed(3)} rms=${Math.sqrt(sq / total).toFixed(4)} nan=${nan}`);
const strikes = msgs.filter(m => m.t === 'strike');
const fmt = (m) => `bar=${m.bar} hit=${m.hit} v=${m.v.toFixed(2)}m/s F=${m.F.toFixed(0)}N J=${(m.J * 1000).toFixed(1)}mNs dur=${(m.dur * 1e6).toFixed(0)}us col=${((m.x - TW.MARGIN_L) / TW.PITCH).toFixed(2)} line=${((m.y - TW.TOP_LINE) / TW.LINE).toFixed(2)} u=${(m.u * 1000).toFixed(2)}mm`;
strikes.slice(0, 6).forEach(m => console.log('  ' + fmt(m)));
console.log('  ...');
strikes.slice(-5).forEach(m => console.log('  ' + fmt(m)));
const esc = msgs.filter(m => m.t === 'esc').map(m => m.ms);
console.log(`strikes=${strikes.length} doubles=${strikes.filter(s => s.hit > 1).length} esc n=${esc.length} mean=${(esc.reduce((a, b) => a + b, 0) / esc.length).toFixed(1)}ms min=${Math.min(...esc).toFixed(1)} max=${Math.max(...esc).toFixed(1)}`);
console.log('other:', msgs.filter(m => !['strike', 'esc'].includes(m.t)).map(m => m.t).join(','));
console.log(`final carriage col=${((sim.x - TW.MARGIN_L) / TW.PITCH).toFixed(2)} line=${((sim.yp - TW.TOP_LINE) / TW.LINE).toFixed(2)}`);

// per-window peak dB timeline (100 ms)
const win = SR / 10; let line = '';
for (let i = 0; i < total; i += win) {
  let p = 0; for (let j = i; j < Math.min(total, i + win); j++) p = Math.max(p, Math.abs(L[j]));
  const db = 20 * Math.log10(p + 1e-9);
  line += db > -12 ? '#' : db > -24 ? '+' : db > -40 ? '.' : ' ';
}
console.log('level:', line);

const buf = Buffer.alloc(44 + total * 4);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + total * 4, 4); buf.write('WAVE', 8);
buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
buf.write('data', 36); buf.writeUInt32LE(total * 4, 40);
for (let i = 0; i < total; i++) {
  buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i])) * 32767), 44 + i * 4);
  buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i])) * 32767), 46 + i * 4);
}
writeFileSync(out, buf);
console.log('wrote', out);
