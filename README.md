# typewriter-gl

A typewriter simulated from the slug up. Every keystroke is a force on a simulated key. The key flings a typebar at a rubber platen. The **sound** and the **ink** both come from the contact forces of that one simulation. Nothing is a recording or a sample.

**Live:** https://typewriter-gl-sigma.vercel.app

## How it works

| Stage | What happens |
|---|---|
| **Mechanics** | The machine runs as rigid bodies inside an `AudioWorklet`, at eight substeps per audio sample (384 kHz). The parts: keys and linkages, 47 typebars, the escapement and mainspring, the carriage, the line-space ratchet and detent, the shift segment, and the margin bell. A steel dog meeting a rack tooth is over in tens of microseconds, so the step has to be this small. |
| **Contact** | Slug-on-platen and part-on-part impacts are Hunt–Crossley contacts: a nonlinear spring plus hysteretic damping. The platen hardness sets the contact time, about 75–270 µs. The HUD trace shows this force for the last strike. |
| **Sound** | Each contact point is an excitation source driving a modal bank: about 40–110 frame modes, a desk mode, four typebar bending modes and an eight-mode bell. A dipole term (p ∝ dF/dt) adds the direct crack of short hard contacts. The platen strike point moves with the carriage, so each column couples into the frame modes differently. Two pickups on the frame give stereo, followed by a small convolution room. |
| **Ink** | The contact patch grows with √force, so a light touch inks only the middle of a glyph. Ink passes through a woven ribbon into paper fibres, and overstrikes add optical density. Each typebar is slightly bent and off-square. If you strike before the shift segment settles, you print half of two letters. |
| **Rendering** | three.js and WebGL2. Strikes become instanced ink quads in a half-float paper texture. The scene renders only when something changes. |

Emergent behaviour, not scripted:

- Type faster than the carriage can travel and the letters crowd together.
- Hit two keys at once and the typebars jam at the platen. `Esc` pulls them apart.
- The bell rings seven characters before the right margin. `Enter` throws the carriage home, and the line-space lever advances the paper.

## Run it

It's a static site with no build step and no dependencies.

```sh
npm run dev        # python3 http.server on http://127.0.0.1:5178
```

You can also use any static server. Click once to start the audio, then type.

| Input | Action |
|---|---|
| Letters, digits, punctuation | Strike that typebar. Key speed and force come from your typing rhythm. |
| `Shift` / `Caps Lock` | Shift the type segment |
| `Space`, `Backspace` | Escapement forward / back |
| `Enter` | Carriage return and line feed |
| `↑` `↓` | Turn the platen knob |
| `Esc` | Free jammed typebars |
| Drag / scroll | Orbit / zoom the camera |

**Controls** lets you change the machine (1936 portable, 1952 office, 1968 plastic) and these settings:

- touch
- platen hardness
- mainspring tension
- ribbon
- type wear
- reverb
- red ribbon half
- jamming

A simulated typist can also type one of the bundled public-domain texts.

## Layout

```
index.html, styles.css
src/
  main.js                     UI, input → events, settings
  audio.js                    Web Audio graph: worklet → dry + room → limiter
  audio/typewriter-processor.js  the physics + sound (AudioWorklet; also runs in Node)
  scene.js                    three.js machine, paper and ink renderer
  typist.js                   simulated typist (timing model)
  keymap.js                   key → typebar layout
tools/
  fuzz.mjs                    physics stress test
  calibrate.mjs               per-source loudness calibration
  render-test.mjs             offline render check
```

The processor registers itself as a worklet when it runs in a browser. In Node it exposes `globalThis.__TypewriterSim`, so the tools can drive the exact same code headlessly.

## Testing

```sh
npm test           # 40 random seeds: keys, chords, returns, backspace, shift, knob, jams
node tools/fuzz.mjs 600 1   # longer run
```

The fuzz test fails in three cases:
- the integrator ever goes non-finite (the worklet's recovery guard fires)
- the carriage leaves its rails
- the audio output is not finite

## Acoustic calibration

The office machine's frame-mode parameters were fitted to a phone recording of a 1930s Underwood being typed on. The parameters are mode count, density, decay times, frequency span, radiation, spectral tilt, desk mode, click level and typebar damping. The method:

1. **Measure the reference.** Detect strike onsets in the reference, keep the isolated strikes (≥110 ms clear after each), and measure:
   - the median third-octave spectrum of the first 60 ms
   - spectral flatness in three bands, as a measure of tonality
   - the per-band 20 dB decay time
   - the spectral centroid
2. **Render the sim the same way.** Render about 8 s of realistic typing through the browser's room impulse response, and measure it identically.
3. **Search.** Run a parallel pattern search in log-parameter space to minimise the weighted spectral, flatness, decay and centroid error.

The mechanics needed no fitting. The escapement's secondary event lands 36 ms after the strike, against 37.5 ms in the recording.

Where the fit lands, sim vs recording: the spectral centroid is 1490 vs 1547 Hz, and the 2–6 kHz band is within 0.1 dB. Three gaps remain. The 600 Hz–2 kHz band is about 6 dB too loud and somewhat tonal (flatness 0.56 vs 0.76). The ring decays faster (20 dB in 12–16 ms vs 19–23 ms). Above 6 kHz is about 2.5 dB short.

The portable and plastic machines keep the same structure, with their character set by hand relative to the office machine.

## Credits

- [three.js](https://threejs.org) (MIT)
- [Courier Prime](https://quoteunquoteapps.com/courierprime/) (SIL Open Font License)
- The bundled texts are in the public domain.

## License

MIT © 2026 Jack Lau
