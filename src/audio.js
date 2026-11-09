// Audio graph: physics worklet -> (dry + small-room convolution) -> limiter -> out.
export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.node = null;
    this.listeners = new Set();
  }

  async start() {
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    await ctx.audioWorklet.addModule(new URL('./audio/typewriter-processor.js?v=7', import.meta.url));
    const node = new AudioWorkletNode(ctx, 'typewriter', {
      numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
    });
    this.node = node;
    node.port.onmessage = (e) => { for (const m of e.data) for (const fn of this.listeners) fn(m); };

    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.room = ctx.createConvolver();
    this.room.buffer = this.makeRoom(0.55);
    this.master = ctx.createGain();
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -3;
    this.limiter.knee.value = 4;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.001;
    this.limiter.release.value = 0.08;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;

    node.connect(this.dry);
    node.connect(this.room);
    this.room.connect(this.wet);
    this.dry.connect(this.master);
    this.wet.connect(this.master);
    this.master.connect(this.limiter);
    this.limiter.connect(ctx.destination);
    this.limiter.connect(this.analyser);
    this.setRoom(0.35);
    if (ctx.state !== 'running') await ctx.resume();
  }

  // a small study with a wooden desk: early reflections + short diffuse tail
  makeRoom(seconds) {
    const ctx = this.ctx;
    const len = Math.floor(seconds * ctx.sampleRate);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / ctx.sampleRate;
        const env = Math.exp(-t / 0.09) * Math.min(1, t / 0.004);
        const cut = 0.55 * Math.exp(-t / 0.12) + 0.06;    // air absorbs the highs first
        lp += cut * (rnd() - lp);
        d[i] = lp * env * 0.6;
      }
      for (const [ms, g] of [[2.1, 0.5], [4.7, 0.32], [7.9, 0.22], [11.3, 0.18], [16.4, 0.12]]) {
        const i = Math.floor((ms + ch * 0.6) / 1000 * ctx.sampleRate);
        if (i < len) d[i] += g;
      }
    }
    return buf;
  }

  setRoom(amount) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.wet.gain.setTargetAtTime(amount * 0.9, t, 0.05);
    this.dry.gain.setTargetAtTime(1 - amount * 0.35, t, 0.05);
  }

  send(msg) { if (this.node) this.node.port.postMessage(msg); }
  on(fn) { this.listeners.add(fn); }
  get now() { return this.ctx ? this.ctx.currentTime : 0; }

  // the context time of the sample reaching the speakers right now
  displayTime() {
    const ctx = this.ctx;
    if (!ctx) return 0;
    if (ctx.getOutputTimestamp) {
      const ts = ctx.getOutputTimestamp();
      if (ts.contextTime > 0) return ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
    }
    return ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0.02);
  }
}
