// A simulated touch typist. Turns text into timed physical events: finger
// forces (little fingers strike lighter), shift held ahead of capitals, a
// glance at the margin bell, and a hand on the return lever.
import { BY_CHAR, fingerStrength, handOf, COLS } from './keymap.js';

export const TEXTS = {
  ozymandias: {
    title: 'Ozymandias',
    by: 'Percy Bysshe Shelley, 1818',
    body: `OZYMANDIAS

I met a traveller from an antique land,
Who said--"Two vast and trunkless legs of stone
Stand in the desert. . . . Near them, on the sand,
Half sunk a shattered visage lies, whose frown,
And wrinkled lip, and sneer of cold command,
Tell that its sculptor well those passions read
Which yet survive, stamped on these lifeless things,
The hand that mocked them, and the heart that fed;
And on the pedestal, these words appear:
My name is Ozymandias, King of Kings;
Look on my Works, ye Mighty, and despair!
Nothing beside remains. Round the decay
Of that colossal Wreck, boundless and bare
The lone and level sands stretch far away."

                              -- P. B. Shelley`,
  },
  dickens: {
    title: 'A Tale of Two Cities',
    by: 'Charles Dickens, 1859',
    body: `     It was the best of times, it was the worst of times, it was the age of wisdom, it was the age of foolishness, it was the epoch of belief, it was the epoch of incredulity, it was the season of Light, it was the season of Darkness, it was the spring of hope, it was the winter of despair, we had everything before us, we had nothing before us, we were all going direct to Heaven, we were all going direct the other way--in short, the period was so far like the present period, that some of its noisiest authorities insisted on its being received, for good or for evil, in the superlative degree of comparison only.`,
  },
  gettysburg: {
    title: 'The Gettysburg Address',
    by: 'Abraham Lincoln, 1863',
    body: `     Four score and seven years ago our fathers brought forth on this continent, a new nation, conceived in Liberty, and dedicated to the proposition that all men are created equal.

     Now we are engaged in a great civil war, testing whether that nation, or any nation so conceived and so dedicated, can long endure. We are met on a great battle-field of that war. We have come to dedicate a portion of that field, as a final resting place for those who here gave their lives that that nation might live. It is altogether fitting and proper that we should do this.

     But, in a larger sense, we can not dedicate--we can not consecrate--we can not hallow--this ground. The brave men, living and dead, who struggled here, have consecrated it, far above our poor power to add or detract. The world will little note, nor long remember what we say here, but it can never forget what they did here. It is for us the living, rather, to be dedicated here to the unfinished work which they who fought here have thus far so nobly advanced. It is rather for us to be here dedicated to the great task remaining before us--that from these honored dead we take increased devotion to that cause for which they gave the last full measure of devotion--that we here highly resolve that these dead shall not have died in vain--that this nation, under God, shall have a new birth of freedom--and that government of the people, by the people, for the people, shall not perish from the earth.`,
  },
  pangram: {
    title: 'Test line',
    by: 'traditional',
    body: `the quick brown fox jumps over the lazy dog. 1234567890
THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG! "$%&'()*"
Pack my box with five dozen liquor jugs; how vexing.`,
  },
};

// fold the text into typewriter lines the way a typist would after the bell
export function layout(text, width = COLS) {
  const out = [];
  for (const para of text.replace(/\r/g, '').split('\n')) {
    if (para.trim() === '') { out.push(''); continue; }
    const lead = para.match(/^ */)[0];
    const words = para.trim().split(/ +/);
    let line = lead;
    for (const w of words) {
      const sep = line.trim() === '' ? '' : ' ';
      if ((line + sep + w).length > width && line.trim() !== '') { out.push(line); line = w; }
      else line += sep + w;
    }
    out.push(line);
  }
  return out;
}

const gaussian = (rnd) => Math.sqrt(-2 * Math.log(rnd() + 1e-9)) * Math.cos(2 * Math.PI * rnd());

export class Typist {
  constructor(engine) {
    this.engine = engine;
    this.queue = [];
    this.timer = null;
    this.onDone = null;
    this.onProgress = null;
  }

  // events: {t:'bar'|'space'|'return'|'shift', ...} with absolute .at
  plan(text, wpm, touch, t0) {
    let seed = 1234567;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const lines = layout(text);
    const base = 60 / (wpm * 5);
    const ev = [];
    let t = t0;
    let prevHand = null, prevFinger = null, shiftHeld = false;
    const force = (strength) => (2.7 + touch * 3.2) * strength * (1 + 0.07 * gaussian(rnd));
    let chars = 0;
    lines.forEach((line, li) => {
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        let dt = base * Math.exp(0.22 * gaussian(rnd));
        if (ch === ' ') {
          ev.push({ t: 'space', F: force(1.0), at: t, n: chars });
          prevHand = null;
          t += dt * 1.05;
        } else {
          const k = BY_CHAR.get(ch);
          if (!k) { t += dt; continue; }
          const hand = handOf(k.bar.finger);
          if (prevHand === hand) dt *= prevFinger === k.bar.finger ? 1.35 : 1.0;
          else dt *= 0.85;
          if (i > 0 && line[i - 1] === ' ') dt *= 1.12;
          if (/[^a-z ]/.test(ch)) dt *= 1.3;
          t += dt * 0.5;
          if (k.shift && !shiftHeld) { ev.push({ t: 'shift', down: true, at: t - 0.075 }); shiftHeld = true; }
          if (!k.shift && shiftHeld) { ev.push({ t: 'shift', down: false, at: t - 0.07 }); shiftHeld = false; }
          ev.push({ t: 'bar', i: k.bar.i, F: force(fingerStrength(k.bar.finger)), at: t, n: chars });
          const nx = line[i + 1];
          const nk = nx && BY_CHAR.get(nx);
          if (shiftHeld && !(nk && nk.shift)) { ev.push({ t: 'shift', down: false, at: t + 0.05 }); shiftHeld = false; }
          t += dt * 0.5;
          prevHand = hand; prevFinger = k.bar.finger;
        }
        chars++;
      }
      if (li < lines.length - 1) {
        t += 0.12 + 0.08 * rnd();                       // reach for the lever
        ev.push({ t: 'return', F: 0.95 + 0.1 * rnd(), at: t, n: chars });
        t += 0.42 + 0.1 * rnd();                        // hand back to home row
        chars++;
      }
    });
    if (shiftHeld) ev.push({ t: 'shift', down: false, at: t });
    return { ev: ev.sort((a, b) => a.at - b.at), total: chars, end: t };
  }

  start(text, wpm, touch) {
    this.stop();
    const t0 = this.engine.now + 0.25;
    const { ev, total } = this.plan(text, wpm, touch, t0);
    this.queue = ev;
    this.total = total;
    // feed the worklet a short window ahead so Stop is responsive
    this.timer = setInterval(() => this.pump(), 50);
    this.pump();
  }

  pump() {
    const horizon = this.engine.now + 0.3;
    const batch = [];
    while (this.queue.length && this.queue[0].at <= horizon) batch.push(this.queue.shift());
    if (batch.length) {
      this.engine.send(batch);
      const last = batch[batch.length - 1];
      if (this.onProgress && last.n != null) this.onProgress(last.n / this.total);
    }
    if (!this.queue.length) {
      clearInterval(this.timer); this.timer = null;
      if (this.onDone) setTimeout(this.onDone, 600);
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.queue = [];
    this.engine.send({ t: 'shift', down: false });
  }

  get running() { return !!this.timer; }
}
