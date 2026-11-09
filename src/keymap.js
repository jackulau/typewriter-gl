// The machine's 47 typebars, each carrying a lower- and upper-case slug face.
// Indexed by physical key (KeyboardEvent.code) so the shift segment, not the
// OS, decides which face prints.
export const BARS = [
  ['Digit1', '1', '!', 'L5'], ['Digit2', '2', '@', 'L4'], ['Digit3', '3', '#', 'L3'],
  ['Digit4', '4', '$', 'L2'], ['Digit5', '5', '%', 'L2'], ['Digit6', '6', '^', 'R2'],
  ['Digit7', '7', '&', 'R2'], ['Digit8', '8', '*', 'R3'], ['Digit9', '9', '(', 'R4'],
  ['Digit0', '0', ')', 'R5'], ['Minus', '-', '_', 'R5'], ['Equal', '=', '+', 'R5'],
  ['KeyQ', 'q', 'Q', 'L5'], ['KeyW', 'w', 'W', 'L4'], ['KeyE', 'e', 'E', 'L3'],
  ['KeyR', 'r', 'R', 'L2'], ['KeyT', 't', 'T', 'L2'], ['KeyY', 'y', 'Y', 'R2'],
  ['KeyU', 'u', 'U', 'R2'], ['KeyI', 'i', 'I', 'R3'], ['KeyO', 'o', 'O', 'R4'],
  ['KeyP', 'p', 'P', 'R5'], ['BracketLeft', '[', '{', 'R5'], ['BracketRight', ']', '}', 'R5'],
  ['KeyA', 'a', 'A', 'L5'], ['KeyS', 's', 'S', 'L4'], ['KeyD', 'd', 'D', 'L3'],
  ['KeyF', 'f', 'F', 'L2'], ['KeyG', 'g', 'G', 'L2'], ['KeyH', 'h', 'H', 'R2'],
  ['KeyJ', 'j', 'J', 'R2'], ['KeyK', 'k', 'K', 'R3'], ['KeyL', 'l', 'L', 'R4'],
  ['Semicolon', ';', ':', 'R5'], ['Quote', "'", '"', 'R5'],
  ['KeyZ', 'z', 'Z', 'L5'], ['KeyX', 'x', 'X', 'L4'], ['KeyC', 'c', 'C', 'L3'],
  ['KeyV', 'v', 'V', 'L2'], ['KeyB', 'b', 'B', 'L2'], ['KeyN', 'n', 'N', 'R2'],
  ['KeyM', 'm', 'M', 'R2'], ['Comma', ',', '<', 'R3'], ['Period', '.', '>', 'R4'],
  ['Slash', '/', '?', 'R5'], ['Backquote', '`', '~', 'L5'], ['Backslash', '\\', '|', 'R5'],
].map(([code, lo, hi, finger], i) => ({ i, code, lo, hi, finger }));

export const BY_CODE = new Map(BARS.map(b => [b.code, b]));
export const BY_CHAR = new Map();
for (const b of BARS) {
  BY_CHAR.set(b.lo, { bar: b, shift: false });
  BY_CHAR.set(b.hi, { bar: b, shift: true });
}

// finger strength: index fingers strike hardest, little fingers lightest
const STRENGTH = { 2: 1.0, 3: 0.95, 4: 0.85, 5: 0.74 };
export const fingerStrength = (finger) => STRENGTH[finger[1]] || 1;
export const handOf = (finger) => finger[0];

// geometry shared with the worklet (mm)
export const PITCH = 2.54;
export const LINE = 25.4 / 6;
export const MARGIN_L = 25.4;
export const COLS = 65;
export const TOP_LINE = 25.4 + 3.0;
export const SHIFT_H = 5.0;
export const PAPER_W = 215.9;
export const PAPER_H = 279.4;
export const PLATEN_R = 19;
