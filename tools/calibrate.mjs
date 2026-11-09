import { fileURLToPath } from 'node:url'; import path from 'node:path';
await import(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/audio/typewriter-processor.js'));
// Prints per-source radiation calibration (dB) for a machine. Set cal to zeros first.
// desired peak (dB) relative to the platen strike; strike itself lands at TARGET raw
const DESIRED=[0,-16,-13,-7,-15,1,-9,-7,-9,-2];
const TARGET=150; // raw units -> ~0.45 at volume .8
const mach=process.argv[2];
function scenario(only){
  const sim = new globalThis.__TypewriterSim(48000); sim.handle({t:'params',machine:mach,volume:0.001}); sim.handle({t:'feed'});
  const n=sim.n; if(only!=null) for(let s=0;s<10;s++) if(s!==only) for(let i=0;i<n;i++) sim.G[s*n+i]=0;
  if(only!=null && only!==0){ sim.GA.fill(0); sim.GB.fill(0); }  // platen row is rebuilt from these each block
  const N=128, L=new Float32Array(N), R=new Float32Array(N); let T=0; let pk=0;
  const run=(sec,meas=true)=>{ for(let b=0;b<sec*375;b++){ sim.render(L,R,T); T+=N/48000; if(meas) for(const v of L)pk=Math.max(pk,Math.abs(v)); } };
  run(1.5,false);
  for(let i=0;i<6;i++){ sim.handle({t:'bar',i:20+i,F:4}); run(0.15); }
  for(let i=0;i<3;i++){ sim.handle({t:'space',F:4}); run(0.15); }
  sim.handle({t:'shift',down:true}); run(0.2); sim.handle({t:'shift',down:false}); run(0.2);
  sim.handle({t:'return',F:1}); run(0.8);
  sim.x=globalThis.__TW.BELL_AT-0.001; sim.w=sim.x+0.0001; sim.wake(); sim.handle({t:'space',F:4}); run(0.8);
  return pk/0.001/0.0042;
}
const cal=[];
for(let s=0;s<10;s++){ const p=scenario(s); cal.push(+(20*Math.log10(TARGET/p)+DESIRED[s]).toFixed(1)); }
console.log(JSON.stringify(cal));
