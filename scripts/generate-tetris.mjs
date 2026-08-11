#!/usr/bin/env node
/**
 * Contribution Tetris
 * -------------------
 * Reads a GitHub user's public contribution calendar, tiles the filled cells
 * with tetromino pieces, and renders an animated SVG in which the pieces fall
 * from above and stack up to rebuild the calendar.
 *
 * Usage: node scripts/generate-tetris.mjs <github-username> [outDir] [--year=2024]
 *        node scripts/generate-tetris.mjs <github-username> [outDir] [--from=…] [--to=…]
 *
 * With no date flags it uses the rolling last-12-months calendar, same as the
 * graph on your profile page.
 */

import { writeFileSync, mkdirSync } from 'node:fs';

const flags = {};
const positional = [];
for (const arg of process.argv.slice(2)) {
  const m = /^--([^=]+)=(.*)$/.exec(arg);
  if (m) flags[m[1]] = m[2];
  else positional.push(arg);
}

const login = positional[0] || process.env.GH_USER;
const outDir = positional[1] || 'assets';

if (flags.year) {
  flags.from = `${flags.year}-01-01`;
  flags.to = `${flags.year}-12-31`;
}

if (!login) {
  console.error('usage: node scripts/generate-tetris.mjs <github-username> [outDir] [--year=YYYY]');
  process.exit(1);
}

/* ── layout ─────────────────────────────────────────────────────────────── */
const CELL = 12;
const GAP = 3;
const PITCH = CELL + GAP;
const PAD_X = 14;
const TOP = 74; // empty "well" above the board, where pieces fall from
const BOTTOM = 28; // caption strip

// classic tetromino colours, tuned per theme so they stay punchy on both backdrops
const PALETTES = {
  light: { I: '#0891b2', O: '#ca8a04', T: '#9333ea', S: '#16a34a', Z: '#dc2626', J: '#2563eb', L: '#ea580c' },
  dark: { I: '#22d3ee', O: '#facc15', T: '#c084fc', S: '#4ade80', Z: '#f87171', J: '#60a5fa', L: '#fb923c' },
};

const THEMES = {
  light: { empty: '#ebedf0', line: '#d8dee4', text: '#57606a', colors: PALETTES.light },
  dark: { empty: '#161b22', line: '#30363d', text: '#7d8590', colors: PALETTES.dark },
};

// contribution level → cell opacity, so the data is still readable
const LEVEL_ALPHA = [0, 0.5, 0.7, 0.86, 1];

/* ── deterministic prng ─────────────────────────────────────────────────── */
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let seed = 0;
for (const ch of login) seed = (seed * 31 + ch.charCodeAt(0)) | 0;
const rand = mulberry32(seed);

const shuffle = (arr) => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

/* ── fetch + parse the public contribution calendar ─────────────────────── */
async function fetchCalendar(user) {
  const qs = new URLSearchParams();
  if (flags.from) qs.set('from', flags.from);
  if (flags.to) qs.set('to', flags.to);
  const url =
    `https://github.com/users/${encodeURIComponent(user)}/contributions` +
    (qs.toString() ? `?${qs}` : '');
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'contribution-tetris',
      Accept: 'text/html',
      'X-Requested-With': 'XMLHttpRequest',
    },
  });
  if (!res.ok) throw new Error(`GitHub returned ${res.status} for ${url}`);
  const html = await res.text();

  const cells = [];
  for (const m of html.matchAll(/<td\b[^>]*>/g)) {
    const tag = m[0];
    const date = /data-date="([^"]+)"/.exec(tag);
    const level = /data-level="([^"]+)"/.exec(tag);
    if (date && level) cells.push({ date: date[1], level: Number(level[1]) || 0 });
  }
  if (!cells.length) {
    throw new Error('could not parse any calendar cells — GitHub markup may have changed');
  }
  return cells;
}

function buildGrid(cells) {
  const times = cells.map((c) => Date.parse(`${c.date}T00:00:00Z`));
  const first = new Date(Math.min(...times));
  const start = new Date(first);
  start.setUTCDate(start.getUTCDate() - start.getUTCDay()); // back up to Sunday

  let weeks = 0;
  const grid = [];
  for (let y = 0; y < 7; y++) grid.push([]);

  for (const c of cells) {
    const d = new Date(`${c.date}T00:00:00Z`);
    const x = Math.floor((d - start) / 86400000 / 7);
    const y = d.getUTCDay();
    if (x < 0) continue;
    grid[y][x] = c.level;
    if (x + 1 > weeks) weeks = x + 1;
  }
  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < weeks; x++) if (grid[y][x] == null) grid[y][x] = 0;
  }
  return { grid, weeks, start };
}

/* ── polyomino shapes ───────────────────────────────────────────────────── */
const norm = (cs) => {
  const mx = Math.min(...cs.map((c) => c[0]));
  const my = Math.min(...cs.map((c) => c[1]));
  return cs
    .map(([x, y]) => [x - mx, y - my])
    .sort((a, b) => a[1] - b[1] || a[0] - b[0]);
};
const rotate = (cs) => norm(cs.map(([x, y]) => [-y, x]));
const key = (cs) => cs.map((c) => c.join(',')).join(' ');

function rotations(cs) {
  const out = [];
  const seen = new Set();
  let cur = norm(cs);
  for (let i = 0; i < 4; i++) {
    const k = key(cur);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(cur);
    }
    cur = rotate(cur);
  }
  return out;
}

const TETROMINOES = {
  I: [[0, 0], [1, 0], [2, 0], [3, 0]],
  O: [[0, 0], [1, 0], [0, 1], [1, 1]],
  T: [[0, 0], [1, 0], [2, 0], [1, 1]],
  S: [[1, 0], [2, 0], [0, 1], [1, 1]],
  Z: [[0, 0], [1, 0], [1, 1], [2, 1]],
  J: [[0, 0], [0, 1], [1, 1], [2, 1]],
  L: [[2, 0], [0, 1], [1, 1], [2, 1]],
};

// variants ordered by size: 4 → 3 → 2 → 1, so the tiler prefers real tetrominoes
function buildVariants() {
  const tiers = [[], [], [], []];
  for (const [name, cs] of Object.entries(TETROMINOES)) {
    for (const r of rotations(cs)) tiers[0].push({ name, cells: r });
  }
  for (const r of rotations([[0, 0], [1, 0], [0, 1]])) tiers[1].push({ name: 'T3', cells: r });
  tiers[1].push({ name: 'I3', cells: [[0, 0], [1, 0], [2, 0]] });
  tiers[1].push({ name: 'I3', cells: [[0, 0], [0, 1], [0, 2]] });
  tiers[2].push({ name: 'D', cells: [[0, 0], [1, 0]] });
  tiers[2].push({ name: 'D', cells: [[0, 0], [0, 1]] });
  tiers[3].push({ name: 'S1', cells: [[0, 0]] });
  return tiers;
}
const TIERS = buildVariants();

/* ── tile the filled cells with pieces ──────────────────────────────────── */
function tile(grid, weeks) {
  const taken = grid.map((row) => row.map(() => false));
  const pieces = [];

  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < weeks; x++) {
      if (!grid[y][x] || taken[y][x]) continue;

      let placed = null;
      for (const tier of TIERS) {
        for (const variant of shuffle(tier)) {
          for (const anchor of variant.cells) {
            const ox = x - anchor[0];
            const oy = y - anchor[1];
            const mapped = variant.cells.map(([dx, dy]) => [ox + dx, oy + dy]);
            const ok = mapped.every(
              ([cx, cy]) =>
                cy >= 0 && cy < 7 && cx >= 0 && cx < weeks && grid[cy][cx] > 0 && !taken[cy][cx]
            );
            if (ok) {
              placed = { name: variant.name, cells: mapped };
              break;
            }
          }
          if (placed) break;
        }
        if (placed) break;
      }

      if (!placed) placed = { name: 'S1', cells: [[x, y]] };
      for (const [cx, cy] of placed.cells) taken[cy][cx] = true;
      pieces.push({
        name: placed.name,
        cells: placed.cells.map(([cx, cy]) => ({ x: cx, y: cy, level: grid[cy][cx] })),
        minX: Math.min(...placed.cells.map((c) => c[0])),
        minY: Math.min(...placed.cells.map((c) => c[1])),
        maxY: Math.max(...placed.cells.map((c) => c[1])),
      });
    }
  }

  // left-to-right sweep; within a column, the lower rows land first
  pieces.sort((a, b) => a.minX - b.minX || b.maxY - a.maxY);
  return pieces;
}

/* ── render ─────────────────────────────────────────────────────────────── */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function monthLabels(start, weeks) {
  const out = [];
  let prev = -1;
  for (let x = 0; x < weeks; x++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + x * 7);
    const m = d.getUTCMonth();
    if (m !== prev && d.getUTCDate() <= 7 && x < weeks - 2) {
      out.push({ x, label: MONTHS[m] });
      prev = m;
    }
  }
  return out;
}

function render({ pieces, weeks, start, theme }) {
  const t = THEMES[theme];
  const W = PAD_X * 2 + weeks * PITCH - GAP;
  const H = TOP + 7 * PITCH - GAP + BOTTOM;
  const boardBottom = TOP + 7 * PITCH - GAP;

  const N = pieces.length;
  const total = Math.min(40, Math.max(14, N * 0.13 + 6)); // seconds
  const DROP_END = 86; // % of the loop by which every piece has landed
  const stagger = N > 1 ? DROP_END / N : 0;
  const fall = Math.min(9, Math.max(1.6, stagger * 5));

  const css = [];
  const body = [];

  css.push(
    `.p{animation-duration:${total.toFixed(2)}s;animation-iteration-count:infinite;` +
      `animation-fill-mode:both;animation-timing-function:cubic-bezier(.55,.06,.68,.19)}`,
    `.c{rx:2.5;ry:2.5}`,
    `.lbl{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;` +
      `font-size:9px;fill:${t.text}}`,
    `.cap{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;` +
      `font-size:10px;fill:${t.text}}`,
    `@media (prefers-reduced-motion:reduce){.p{animation:none!important;opacity:1!important}}`
  );

  // faint board underneath
  const bg = [];
  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < weeks; x++) {
      bg.push(
        `<rect class="c" x="${PAD_X + x * PITCH}" y="${TOP + y * PITCH}" ` +
          `width="${CELL}" height="${CELL}" fill="${t.empty}"/>`
      );
    }
  }
  body.push(`<g>${bg.join('')}</g>`);

  // well guides
  body.push(
    `<g stroke="${t.line}" stroke-width="1" opacity="0.9" fill="none">` +
      `<path d="M${PAD_X - 5} ${TOP - 46} V${boardBottom + 4} H${W - PAD_X + 5} V${TOP - 46}"/>` +
      `</g>`
  );

  // month labels
  for (const m of monthLabels(start, weeks)) {
    body.push(
      `<text class="lbl" x="${PAD_X + m.x * PITCH}" y="${TOP - 8}">${m.label}</text>`
    );
  }

  // pieces
  pieces.forEach((p, i) => {
    const a = +(i * stagger).toFixed(3);
    const b = +Math.min(DROP_END + 2, a + fall).toFixed(3);
    const b2 = +Math.min(90, b + 0.7).toFixed(3);
    const pieceTop = TOP + p.minY * PITCH;
    const pieceH = (p.maxY - p.minY + 1) * PITCH;
    const from = -(pieceTop + pieceH + 10);
    const shades = Object.values(t.colors);
    const color = t.colors[p.name] || shades[i % shades.length];

    const rects = p.cells
      .map(
        (c) =>
          `<rect class="c" x="${PAD_X + c.x * PITCH}" y="${TOP + c.y * PITCH}" ` +
          `width="${CELL}" height="${CELL}" fill="${color}" ` +
          `opacity="${LEVEL_ALPHA[Math.min(4, c.level)]}"/>`
      )
      .join('');

    const head = a <= 0 ? '0%' : `0%,${a}%`;
    css.push(
      `@keyframes k${i}{` +
        `${head}{transform:translateY(${from}px);opacity:0}` +
        `${(a + 0.01).toFixed(3)}%{opacity:1}` +
        `${b}%{transform:translateY(3px);opacity:1}` +
        `${b2}%,92%{transform:translateY(0);opacity:1}` +
        `97%,100%{transform:translateY(0);opacity:0}` +
        `}`
    );
    body.push(`<g class="p" style="animation-name:k${i}">${rects}</g>`);
  });

  body.push(
    `<text class="cap" x="${PAD_X - 5}" y="${H - 10}">contribution tetris · @${login}</text>`,
    `<text class="cap" x="${W - PAD_X + 5}" y="${H - 10}" text-anchor="end">${N} pieces</text>`
  );

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" ` +
    `viewBox="0 0 ${W} ${H}" role="img" ` +
    `aria-label="Animated tetris built from @${login}'s GitHub contribution graph">` +
    `<style>${css.join('')}</style>${body.join('')}</svg>`
  );
}

/* ── main ───────────────────────────────────────────────────────────────── */
const cells = await fetchCalendar(login);
const { grid, weeks, start } = buildGrid(cells);
const pieces = tile(grid, weeks);

const filled = cells.filter((c) => c.level > 0).length;
if (filled < cells.length * 0.05) {
  console.warn(
    `warning: only ${filled}/${cells.length} days have public contributions, so the ` +
      `animation will look sparse.\n` +
      `  · add every email you commit with at github.com/settings/emails\n` +
      `  · enable "Include private contributions on my profile" at github.com/settings/profile`
  );
}

mkdirSync(outDir, { recursive: true });
for (const theme of ['light', 'dark']) {
  const svg = render({ pieces, weeks, start, theme });
  const file = `${outDir}/tetris${theme === 'dark' ? '-dark' : ''}.svg`;
  writeFileSync(file, svg);
  console.log(`${file}  ${(svg.length / 1024).toFixed(1)} KB`);
}
console.log(`${pieces.length} pieces from ${weeks} weeks of contributions`);
