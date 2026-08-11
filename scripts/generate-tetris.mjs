#!/usr/bin/env node
/**
 * Activity Tetris
 * ---------------
 * Builds a daily activity map by walking the commit history of every repo the
 * user owns, tiles the active days with tetromino pieces, and renders an
 * animated SVG in which the pieces fall from above and stack up to rebuild the
 * year. If the last 12 months are too quiet it renders the busiest 53-week
 * stretch instead and names the period in the caption.
 *
 * This deliberately does NOT use the profile contribution calendar — that one
 * only counts commits whose author email is verified on the account.
 *
 * Usage:
 *   node scripts/generate-tetris.mjs <github-username> [outDir]
 *   node scripts/generate-tetris.mjs <user> assets --exclude=some-repo,other
 *
 * GITHUB_TOKEN lifts the 60 req/hour unauthenticated rate limit. If it holds a
 * personal access token with the `repo` scope, private repositories are scanned
 * too; the token Actions injects by default only reaches public ones.
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
const TOKEN = process.env.GITHUB_TOKEN || '';
const EXCLUDE = new Set(
  (flags.exclude || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
);

if (!login) {
  console.error('usage: node scripts/generate-tetris.mjs <github-username> [outDir] [--exclude=a,b]');
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

/* ── real commit activity across the user's own repositories ────────────── */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path) {
  return fetch(`https://api.github.com${path}`, {
    headers: {
      'User-Agent': 'activity-tetris',
      Accept: 'application/vnd.github+json',
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
  });
}

async function paginate(pathFor) {
  const all = [];
  for (let page = 1; page <= 5; page++) {
    const res = await api(pathFor(page));
    if (!res.ok) return { ok: false, status: res.status, all };
    const batch = await res.json();
    if (!Array.isArray(batch)) return { ok: false, status: 500, all };
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return { ok: true, all };
}

async function listRepos(user) {
  let repos = null;

  // A personal access token can see private repositories; the token Actions
  // injects by default cannot, and /user/repos rejects it outright.
  if (TOKEN) {
    const owned = await paginate(
      (p) => `/user/repos?per_page=100&page=${p}&affiliation=owner&visibility=all`
    );
    if (owned.ok) {
      repos = owned.all.filter((r) => r.owner?.login?.toLowerCase() === user.toLowerCase());
    }
  }

  // an empty result means the token is not this user's — fall back rather than
  // silently rendering nothing
  if (!repos || !repos.length) {
    const pub = await paginate((p) => `/users/${encodeURIComponent(user)}/repos?per_page=100&page=${p}`);
    if (!pub.ok) throw new Error(`listing repos failed: HTTP ${pub.status}`);
    repos = pub.all;
  }

  const kept = repos.filter((r) => !r.fork && !r.archived && !EXCLUDE.has(r.name.toLowerCase()));
  const priv = kept.filter((r) => r.private).length;
  console.log(`scanning ${kept.length} repositories (${priv} private)…`);
  return kept;
}

// identities that count as "mine" when a repo has many committers.
// Seeded from the login, the account's display name and any --authors values,
// because commits made from a machine with an unlinked git email carry neither
// a GitHub login nor a recognisable address.
const IDENTS = [];

// Above this many distinct committers a repo reads as a shared/upstream
// history rather than a personal project.
const PERSONAL_AUTHORS = 8;

async function loadIdentities(user) {
  const tokens = [user, ...(flags.authors || '').split(',')];
  const res = await api(`/users/${encodeURIComponent(user)}`);
  if (res.ok) {
    const profile = await res.json();
    if (profile.name) tokens.push(...String(profile.name).split(/\s+/));
    if (profile.email) tokens.push(profile.email);
  }
  for (const t of tokens) {
    const v = t.trim().toLowerCase();
    if (v.length >= 4 && !IDENTS.includes(v)) IDENTS.push(v);
  }
  console.log(`identities: ${IDENTS.join(', ')}`);
}

const isBot = (c) =>
  /\[bot\]$/.test(c.login) || /\[bot\]|github-actions|dependabot/i.test(`${c.name} ${c.email}`);

function isMine(c) {
  if (c.login && IDENTS.includes(c.login)) return true;
  const haystack = `${c.email} ${c.name}`.toLowerCase();
  return IDENTS.some((id) => haystack.includes(id));
}

// full commit history for one repo (paginated, newest first)
async function repoCommits(user, repo) {
  const raw = [];
  const authors = new Set();

  for (let page = 1; page <= 6; page++) {
    const res = await api(`/repos/${user}/${repo}/commits?per_page=100&page=${page}`);
    if (res.status === 409) return []; // empty repo
    if (!res.ok) {
      console.warn(`  ${repo}: HTTP ${res.status}`);
      return [];
    }
    const batch = await res.json();
    if (!Array.isArray(batch) || !batch.length) break;

    for (const c of batch) {
      const entry = {
        date: (c.commit?.author?.date || c.commit?.committer?.date || '').slice(0, 10),
        login: c.author?.login?.toLowerCase() || '',
        email: c.commit?.author?.email || '',
        name: c.commit?.author?.name || '',
      };
      if (!entry.date || isBot(entry)) continue; // the nightly bot commit is not activity
      raw.push(entry);
      authors.add(entry.login || entry.email.toLowerCase());
    }

    if (batch.length < 100) break;
    // clearly a shared / upstream history — stop paging, we filter below anyway
    if (page >= 2 && authors.size > PERSONAL_AUTHORS) break;
  }

  // A personal project is the owner's work even when git was configured with a
  // different email on every machine — an unlinked email shows up as its own
  // identity, so a solo repo can still carry a handful of them. Only a
  // many-handed history (an upstream clone) is filtered down to attributable
  // commits. This must not depend on how many pages were fetched.
  const personal = authors.size <= PERSONAL_AUTHORS;
  return raw.filter((c) => personal || isMine(c)).map((c) => c.date);
}

async function fetchActivity(user) {
  await loadIdentities(user);
  const repos = await listRepos(user);

  const daily = new Map();
  let total = 0;

  for (const r of repos) {
    const dates = await repoCommits(user, r.name);
    for (const d of dates) daily.set(d, (daily.get(d) || 0) + 1);
    // Actions logs on a public repo are public — never print private repo names
    if (dates.length) console.log(`  ${r.private ? '(private repo)' : r.name}: ${dates.length}`);
    total += dates.length;
  }

  console.log(`${total} commits across ${daily.size} active days`);
  return daily;
}

const DAY_MS = 86400000;
const WINDOW_DAYS = 371; // 53 weeks
const MIN_RECENT_DAYS = 20; // below this the last year is considered too empty

// pick the window end: the last 12 months if they hold enough activity,
// otherwise the busiest 53-week stretch in the whole history
function pickWindowEnd(daily) {
  const active = [...daily.entries()]
    .filter(([, n]) => n > 0)
    .map(([d]) => Date.parse(`${d}T00:00:00Z`))
    .sort((a, b) => a - b);

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  if (!active.length) return { end: today, auto: false };

  const countUpTo = (endMs) =>
    active.filter((t) => t <= endMs && t > endMs - WINDOW_DAYS * DAY_MS).length;

  const recent = countUpTo(today.getTime());
  if (recent >= MIN_RECENT_DAYS) return { end: today, auto: false };

  let bestEnd = today.getTime();
  let bestCount = recent;
  for (const t of active) {
    const n = countUpTo(t);
    if (n > bestCount) {
      bestCount = n;
      bestEnd = t;
    }
  }
  return { end: new Date(bestEnd), auto: bestEnd !== today.getTime() };
}

// daily commit counts → one cell per day, level 0-4 by quartile
function toCells(daily, end) {
  const counts = [...daily.values()].filter((c) => c > 0).sort((a, b) => a - b);
  const at = (p) => counts[Math.min(counts.length - 1, Math.floor(counts.length * p))] || 1;
  const [t1, t2, t3] = [at(0.25), at(0.5), at(0.75)];
  const levelOf = (c) => (c <= 0 ? 0 : c <= t1 ? 1 : c <= t2 ? 2 : c <= t3 ? 3 : 4);

  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (WINDOW_DAYS - 7));
  start.setUTCDate(start.getUTCDate() - start.getUTCDay()); // back up to Sunday

  const cells = [];
  for (const d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const day = d.toISOString().slice(0, 10);
    cells.push({ date: day, level: levelOf(daily.get(day) || 0) });
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

function render({ pieces, weeks, start, theme, period }) {
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
    `<text class="cap" x="${PAD_X - 5}" y="${H - 10}">activity tetris · @${login} · ${period}</text>`,
    `<text class="cap" x="${W - PAD_X + 5}" y="${H - 10}" text-anchor="end">${N} pieces</text>`
  );

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" ` +
    `viewBox="0 0 ${W} ${H}" role="img" ` +
    `aria-label="Animated tetris built from @${login}'s GitHub commit activity">` +
    `<style>${css.join('')}</style>${body.join('')}</svg>`
  );
}

/* ── main ───────────────────────────────────────────────────────────────── */
const daily = await fetchActivity(login);
const { end, auto } = pickWindowEnd(daily);
const cells = toCells(daily, end);
const { grid, weeks, start } = buildGrid(cells);
const pieces = tile(grid, weeks);

const filled = cells.filter((c) => c.level > 0).length;
if (!filled) {
  console.error('error: no commit activity found — nothing to render');
  process.exit(1);
}

const fmt = (d) => `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
const period = `${fmt(start)} – ${fmt(end)}`;
console.log(
  auto
    ? `last 12 months were too quiet — showing the busiest window: ${period}`
    : `window: ${period}`
);

mkdirSync(outDir, { recursive: true });
for (const theme of ['light', 'dark']) {
  const svg = render({ pieces, weeks, start, theme, period });
  const file = `${outDir}/tetris${theme === 'dark' ? '-dark' : ''}.svg`;
  writeFileSync(file, svg);
  console.log(`${file}  ${(svg.length / 1024).toFixed(1)} KB`);
}
console.log(`${pieces.length} pieces from ${weeks} weeks of activity`);
