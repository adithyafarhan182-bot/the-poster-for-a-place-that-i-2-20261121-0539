// SOLMARA — Where the Sun Sets Twice.
// A travel poster for a place that does not exist.
// Pure Node 22 stdlib: the poster is drawn pixel by pixel into an RGB
// buffer and encoded to PNG with the built-in zlib. No network, no assets.

import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const W = 768;
const H = 1024;
const OUT = "/output/entry.png";

// ---------- tiny colour helpers ----------
type RGB = [number, number, number];

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function mix(c1: RGB, c2: RGB, t: number): RGB {
  return [
    Math.round(lerp(c1[0], c2[0], t)),
    Math.round(lerp(c1[1], c2[1], t)),
    Math.round(lerp(c1[2], c2[2], t)),
  ];
}

// Deterministic PRNG so the poster is identical on every run.
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- canvas ----------
class Canvas {
  readonly w: number;
  readonly h: number;
  readonly px: Uint8Array; // RGB, row-major

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.px = new Uint8Array(w * h * 3);
  }

  set(x: number, y: number, c: RGB): void {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    if (ix < 0 || iy < 0 || ix >= this.w || iy >= this.h) return;
    const o = (iy * this.w + ix) * 3;
    this.px[o] = c[0];
    this.px[o + 1] = c[1];
    this.px[o + 2] = c[2];
  }

  // Blend colour over the existing pixel with opacity 0..1.
  blend(x: number, y: number, c: RGB, a: number): void {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    if (ix < 0 || iy < 0 || ix >= this.w || iy >= this.h) return;
    if (a <= 0) return;
    if (a >= 1) {
      this.set(ix, iy, c);
      return;
    }
    const o = (iy * this.w + ix) * 3;
    this.px[o] = Math.round(this.px[o] * (1 - a) + c[0] * a);
    this.px[o + 1] = Math.round(this.px[o + 1] * (1 - a) + c[1] * a);
    this.px[o + 2] = Math.round(this.px[o + 2] * (1 - a) + c[2] * a);
  }

  get(x: number, y: number): RGB {
    const ix = Math.max(0, Math.min(this.w - 1, Math.floor(x)));
    const iy = Math.max(0, Math.min(this.h - 1, Math.floor(y)));
    const o = (iy * this.w + ix) * 3;
    return [this.px[o], this.px[o + 1], this.px[o + 2]];
  }

  fillRect(x0: number, y0: number, x1: number, y1: number, c: RGB): void {
    for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
      for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
        this.set(x, y, c);
      }
    }
  }

  // Vertical gradient band from y0 (colour cTop) to y1 (colour cBot).
  vgrad(y0: number, y1: number, cTop: RGB, cBot: RGB): void {
    for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
      const t = (y - y0) / Math.max(1, y1 - y0);
      const c = mix(cTop, cBot, Math.min(1, Math.max(0, t)));
      for (let x = 0; x < this.w; x++) this.set(x, y, c);
    }
  }

  disc(cx: number, cy: number, r: number, c: RGB): void {
    const r2 = r * r;
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy <= r2) this.set(x, y, c);
      }
    }
  }

  // Soft radial glow: colour fades out over radius r.
  glow(cx: number, cy: number, r: number, c: RGB, peak: number): void {
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const dx = x - cx;
        const dy = y - cy;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d >= r) continue;
        const a = peak * (1 - d / r) * (1 - d / r);
        this.blend(x, y, c, a);
      }
    }
  }
}

// ---------- PNG encoder (pure stdlib) ----------
const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(cv: Canvas): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(cv.w, 0);
  ihdr.writeUInt32BE(cv.h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const raw = Buffer.alloc((cv.w * 3 + 1) * cv.h);
  for (let y = 0; y < cv.h; y++) {
    raw[y * (cv.w * 3 + 1)] = 0; // filter: none
    Buffer.from(cv.px.buffer, y * cv.w * 3, cv.w * 3).copy(
      raw,
      y * (cv.w * 3 + 1) + 1,
    );
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------- 5x7 bitmap font ----------
// Each glyph is 7 rows of 5 cells; '#' is ink, '.' is empty.
const FONT: Record<string, string[]> = {
  A: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  B: ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."],
  C: [".####", "#....", "#....", "#....", "#....", "#....", ".####"],
  D: ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."],
  E: ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
  F: ["#####", "#....", "#....", "####.", "#....", "#....", "#...."],
  G: [".####", "#....", "#....", "#.###", "#...#", "#...#", ".###."],
  H: ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  I: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "#####"],
  J: ["..###", "...#.", "...#.", "...#.", "...#.", "#..#.", ".##.."],
  K: ["#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"],
  L: ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
  M: ["#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#"],
  N: ["#...#", "##..#", "##..#", "#.#.#", "#..##", "#..##", "#...#"],
  O: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  P: ["####.", "#...#", "#...#", "####.", "#....", "#....", "#...."],
  Q: [".###.", "#...#", "#...#", "#...#", "#.#.#", "#..#.", ".##.#"],
  R: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
  S: [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
  T: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
  U: ["#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  V: ["#...#", "#...#", "#...#", "#...#", "#...#", ".#.#.", "..#.."],
  W: ["#...#", "#...#", "#...#", "#.#.#", "#.#.#", "##.##", "#...#"],
  X: ["#...#", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "#...#"],
  Y: ["#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."],
  Z: ["#####", "....#", "...#.", "..#..", ".#...", "#....", "#####"],
  " ": [".....", ".....", ".....", ".....", ".....", ".....", "....."],
  "-": [".....", ".....", ".....", "#####", ".....", ".....", "....."],
  ".": [".....", ".....", ".....", ".....", ".....", ".....", "..#.."],
  "'": ["..#..", "..#..", ".....", ".....", ".....", ".....", "....."],
  "·": [".....", ".....", ".....", "..#..", ".....", ".....", "....."],
};

function textWidth(text: string, scale: number): number {
  // 6 units per glyph (5 + 1 gap), minus the trailing gap.
  return text.length * 6 * scale - scale;
}

function drawText(
  cv: Canvas,
  text: string,
  cx: number,
  y: number,
  scale: number,
  colour: RGB,
): void {
  const w = textWidth(text, scale);
  let x = Math.round(cx - w / 2);
  const upper = text.toUpperCase();
  for (const ch of upper) {
    const glyph = FONT[ch] ?? FONT[" "];
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if (glyph[row][col] === "#") {
          cv.fillRect(
            x + col * scale,
            y + row * scale,
            x + (col + 1) * scale,
            y + (row + 1) * scale,
            colour,
          );
        }
      }
    }
    x += 6 * scale;
  }
}

// A soft shadow copy behind the text, for legibility over the sky.
function drawTextShadow(
  cv: Canvas,
  text: string,
  cx: number,
  y: number,
  scale: number,
  colour: RGB,
  dx: number,
  dy: number,
): void {
  const w = textWidth(text, scale);
  let x = Math.round(cx - w / 2) + dx;
  const upper = text.toUpperCase();
  for (const ch of upper) {
    const glyph = FONT[ch] ?? FONT[" "];
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if (glyph[row][col] === "#") {
          cv.fillRect(
            x + col * scale,
            y + dy + row * scale,
            x + (col + 1) * scale,
            y + dy + (row + 1) * scale,
            colour,
          );
        }
      }
    }
    x += 6 * scale;
  }
}

// ---------- the poster scene ----------
// Solmara: a lagoon town on a cliff coast where the sun sets twice.
// One landmark — the Sunspire tower — one horizon, one promise.

const HORIZON = 640; // y where sky meets the lagoon
const CREAM: RGB = [247, 232, 200];
const INK: RGB = [22, 26, 48];

function drawSky(cv: Canvas): void {
  // Deep indigo dusk at the top, warming to rose and amber at the horizon.
  const stops: [number, RGB][] = [
    [0, [18, 24, 54]],
    [0.35, [52, 48, 96]],
    [0.62, [122, 74, 110]],
    [0.85, [214, 122, 82]],
    [1, [246, 178, 96]],
  ];
  for (let y = 0; y < HORIZON; y++) {
    const t = y / HORIZON;
    let i = 0;
    while (i < stops.length - 2 && t > stops[i + 1][0]) i++;
    const [t0, c0] = stops[i];
    const [t1, c1] = stops[i + 1];
    const f = Math.min(1, Math.max(0, (t - t0) / (t1 - t0)));
    const c = mix(c0, c1, f);
    for (let x = 0; x < W; x++) cv.set(x, y, c);
  }
}

function drawStars(cv: Canvas, rnd: () => number): void {
  // Only in the upper, darker sky; brighter and denser near the top.
  for (let i = 0; i < 170; i++) {
    const x = rnd() * W;
    const y = rnd() * 380;
    const depth = 1 - y / 420;
    if (rnd() > 0.25 + depth * 0.6) continue;
    const size = rnd() < 0.12 ? 2 : 1;
    const bright = 200 + Math.floor(rnd() * 55);
    cv.fillRect(x, y, x + size, y + size, [bright, bright, 235]);
  }
}

function drawSuns(cv: Canvas): void {
  // The second sun: smaller, higher, paler — Solmara's double sunset.
  cv.glow(288, 512, 150, [255, 214, 150], 0.55);
  cv.glow(288, 512, 70, [255, 226, 170], 0.8);
  cv.disc(288, 512, 40, [255, 232, 178]);

  // The first sun: big and low, kissing the horizon.
  cv.glow(492, 596, 230, [255, 178, 92], 0.6);
  cv.glow(492, 596, 120, [255, 196, 120], 0.75);
  cv.disc(492, 596, 66, [255, 214, 138]);
  // A warm core inside the big sun.
  cv.disc(492, 596, 44, [255, 228, 168]);
}

function drawSea(cv: Canvas, rnd: () => number): void {
  // Mirror lagoon: deep teal at the horizon, darker toward the viewer.
  for (let y = HORIZON; y < H; y++) {
    const t = (y - HORIZON) / (H - HORIZON);
    const c = mix([38, 92, 96], [10, 30, 46], t);
    for (let x = 0; x < W; x++) cv.set(x, y, c);
  }
  // Sun roads: shimmering columns of light under each sun.
  for (const [sx, width, strength] of [
    [492, 150, 0.85],
    [288, 90, 0.5],
  ] as const) {
    for (let y = HORIZON + 6; y < H - 30; y++) {
      const t = (y - HORIZON) / (H - HORIZON);
      const wob = Math.sin(y * 0.09 + sx) * 14 * t;
      const half = (width / 2) * (0.35 + 0.65 * t);
      for (let x = Math.floor(sx - half + wob); x <= sx + half + wob; x++) {
        if (rnd() < 0.35) continue;
        const a = strength * (1 - t * 0.55) * (1 - Math.abs(x - sx - wob) / half);
        cv.blend(x, y, [255, 205, 130], Math.max(0, a));
      }
    }
  }
  // Gentle horizontal swell lines.
  for (let i = 0; i < 60; i++) {
    const y = HORIZON + 20 + rnd() * (H - HORIZON - 60);
    const x0 = rnd() * W * 0.8;
    const len = 30 + rnd() * 130;
    const a = 0.08 + rnd() * 0.14;
    for (let x = x0; x < x0 + len; x++) {
      cv.blend(x, y, [190, 225, 220], a);
    }
  }
}

function drawHeadland(cv: Canvas): void {
  // Dark cliff headland on the right, rising out of the lagoon.
  // Its seaward edge curves gently inward, like a real cliff face.
  const pts: [number, number][] = [
    [768, 1024], [768, 700], [742, 668], [700, 660], [668, 640],
    [652, 660], [640, 700], [632, 760], [618, 830], [592, 900],
    [556, 960], [520, 1024],
  ];
  for (let y = 640; y < H; y++) {
    // Left edge of the headland at this height: walk the polyline.
    let left = W;
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[i + 1];
      if ((y0 <= y && y < y1) || (y1 <= y && y < y0)) {
        const f = (y - y0) / (y1 - y0);
        left = Math.min(left, x0 + (x1 - x0) * f);
      }
    }
    if (left < W) {
      for (let x = Math.floor(left); x < W; x++) {
        const shade = 0.85 + 0.15 * Math.sin(x * 0.05 + y * 0.02);
        cv.blend(x, y, [16, 22, 40], 1);
        void shade;
      }
    }
  }
  // A small distant islet on the left, a low dome on the horizon.
  for (let y = 614; y < HORIZON; y++) {
    const dy = (y - HORIZON) / 26;
    const half = Math.floor(26 * Math.sqrt(Math.max(0, 1 - dy * dy)));
    for (let x = 96 - half; x <= 96 + half; x++) cv.set(x, y, [20, 28, 52]);
  }
}

function drawSunspire(cv: Canvas): void {
  // The Sunspire: one slender tower on the headland, catching the
  // second sunset — Solmara's single landmark.
  const bx = 690; // base centre x — set back on the headland
  const base = 668;
  const top = 452;
  // Tower body: tapered column, warm stone lit by the suns.
  for (let y = top; y <= base; y++) {
    const t = (y - top) / (base - top);
    const half = 7 + 13 * t;
    const c = mix([232, 196, 138], [120, 92, 84], t);
    for (let x = Math.floor(bx - half); x <= bx + half; x++) {
      cv.set(x, y, c);
    }
  }
  // Lit edge on the sun side.
  for (let y = top; y <= base; y++) {
    const t = (y - top) / (base - top);
    const half = 7 + 13 * t;
    cv.set(Math.floor(bx - half), y, [255, 224, 170]);
  }
  // Ringed crown and the glowing beacon tip.
  cv.fillRect(bx - 16, top - 8, bx + 16, top - 2, [232, 196, 138]);
  cv.fillRect(bx - 11, top - 16, bx + 11, top - 8, [196, 150, 104]);
  cv.glow(bx, top - 26, 34, [255, 214, 140], 0.9);
  cv.disc(bx, top - 26, 9, [255, 236, 180]);
  // A few lit windows down the tower.
  for (let i = 0; i < 5; i++) {
    const wy = top + 34 + i * 36;
    cv.fillRect(bx - 2, wy, bx + 3, wy + 7, [255, 220, 150]);
  }
}

function drawBirds(cv: Canvas): void {
  // Three small birds crossing the dusk sky.
  const birds: [number, number, number][] = [
    [150, 300, 9],
    [196, 272, 7],
    [238, 306, 6],
  ];
  for (const [bx, by, s] of birds) {
    for (let i = 0; i <= s; i++) {
      cv.set(bx - i, by + Math.floor(i * 0.45), INK);
      cv.set(bx + i, by + Math.floor(i * 0.45), INK);
    }
  }
}

// ---------- type, frame, main ----------
function drawType(cv: Canvas): void {
  // The name leads the eye: big, cream, high in the sky.
  drawTextShadow(cv, "SOLMARA", W / 2, 108, 14, [12, 16, 38], 4, 6);
  drawText(cv, "SOLMARA", W / 2, 104, 14, CREAM);

  // The promise, one line, under the name.
  drawText(cv, "WHERE THE SUN SETS TWICE", W / 2, 232, 4, [255, 226, 180]);

  // Thin rules flanking the tagline.
  cv.fillRect(96, 244, 168, 247, CREAM);
  cv.fillRect(600, 244, 672, 247, CREAM);

  // The footer: what a stay feels like, small and quiet over the water.
  drawText(cv, "TWO SUNSETS A DAY · SAIL AT DUSK", W / 2, 952, 3, CREAM);
}

function drawFrame(cv: Canvas): void {
  // A thin cream frame, inset from the edge, like a printed poster.
  const m = 22;
  const t = 3;
  cv.fillRect(m, m, W - m, m + t, CREAM);
  cv.fillRect(m, H - m - t, W - m, H - m, CREAM);
  cv.fillRect(m, m, m + t, H - m, CREAM);
  cv.fillRect(W - m - t, m, W - m, H - m, CREAM);
}

function main(): void {
  const rnd = mulberry32(20261121);
  const cv = new Canvas(W, H);
  drawSky(cv);
  drawStars(cv, rnd);
  drawSuns(cv);
  drawSea(cv, rnd);
  drawHeadland(cv);
  drawSunspire(cv);
  drawBirds(cv);
  drawType(cv);
  drawFrame(cv);

  mkdirSync("/output", { recursive: true });
  const png = encodePNG(cv);
  writeFileSync(OUT, png);
  console.log(`wrote ${OUT} (${png.length} bytes, ${W}x${H})`);
}

main();
