import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

type Duration = "half-year" | "full-year"

type Day = {
  date: string
  count: number
}

/* ─── CLI ────────────────────────────────────────────── */

function parseArgs() {
  const args = process.argv.slice(2)
  const parsed: { username: string; output: string; duration: Duration } = {
    username: "",
    output: "assets/cny_metrics.svg",
    duration: "full-year",
  }
  for (let i = 0; i < args.length; i++) {
    const key = args[i]
    const val = args[i + 1]
    if (!val) continue
    if (key === "--username") {
      parsed.username = val
      i += 1
    } else if (key === "--output") {
      parsed.output = val
      i += 1
    } else if (key === "--duration" && (val === "half-year" || val === "full-year")) {
      parsed.duration = val
      i += 1
    }
  }
  if (!parsed.username) throw new Error("Missing --username")
  return parsed
}

/* ─── Date Helpers ───────────────────────────────────── */

function iso(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function toDate(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00Z`)
}

function addDays(isoDate: string, days: number): string {
  const d = toDate(isoDate)
  d.setUTCDate(d.getUTCDate() + days)
  return iso(d)
}

function dateRange(start: string, end: string): string[] {
  const out: string[] = []
  const cur = toDate(start)
  const e = toDate(end)
  while (cur <= e) {
    out.push(iso(cur))
    cur.setUTCDate(cur.getUTCDate() + 1)
  }
  return out
}

function alignSunday(isoDate: string): string {
  const d = toDate(isoDate)
  if (d.getUTCDay()) d.setUTCDate(d.getUTCDate() - d.getUTCDay())
  return iso(d)
}

function diffDays(a: string, b: string): number {
  return Math.round((toDate(a).getTime() - toDate(b).getTime()) / 86400000)
}

/* ─── GitHub Data ────────────────────────────────────── */

async function fetchContributions(username: string, from: string, to: string): Promise<Map<string, number>> {
  const url = `https://github.com/users/${encodeURIComponent(username)}/contributions?from=${from}&to=${to}`
  const resp = await fetch(url, { headers: { "User-Agent": "Chinese-Style-Metrics" } })
  if (!resp.ok) throw new Error(`GitHub request failed: ${resp.status}`)
  const html = await resp.text()

  const tdPattern = /<td\b[^>]*>/g
  const attrPattern = /([a-zA-Z0-9_-]+)="([^"]*)"/g
  const tooltipPattern = /<tool-tip[^>]*\bfor="([^"]+)"[^>]*>([\s\S]*?)<\/tool-tip>/g
  const countPattern = /(\d+)\s+contributions?/i

  const dateByCell = new Map<string, string>()
  for (const td of html.match(tdPattern) ?? []) {
    const attrs = new Map<string, string>()
    for (const m of td.matchAll(attrPattern)) attrs.set(m[1], m[2])
    const id = attrs.get("id")
    const date = attrs.get("data-date")
    if (id && date) dateByCell.set(id, date)
  }

  const result = new Map<string, number>()
  for (const m of html.matchAll(tooltipPattern)) {
    const id = m[1]
    const tip = m[2]
    const date = dateByCell.get(id)
    if (!date) continue
    if (tip.includes("No contributions")) {
      result.set(date, 0)
      continue
    }
    const c = countPattern.exec(tip)
    if (c) result.set(date, Number(c[1]))
  }

  if (result.size === 0) throw new Error("No contribution data parsed")
  return result
}

/* ─── Color / Stats ──────────────────────────────────── */

/** Spring Festival red-gold metallic palette */
function quantileLevels(days: Day[]): { max: number; levelColor: (count: number) => string } {
  // Red → rose-gold → gold metallic progression
  const colors = [
    "#5a2020",   // L0 – empty: dark burgundy (blends with brighter bg)
    "#b82e2e",   // L1 – low:  deep ruby red
    "#d94040",   // L2 – med:  bright crimson
    "#e8823a",   // L3 – high: rose-gold / amber
    "#f5c842",   // L4 – peak: rich gold 🏆
  ]
  const vals = days.map((d) => d.count).filter((v) => v > 0).sort((a, b) => a - b)
  const max = Math.max(0, ...days.map((d) => d.count))
  if (vals.length === 0) return { max, levelColor: () => colors[0] }
  const pick = (q: number) => vals[Math.floor((vals.length - 1) * q)]
  const q1 = pick(0.35)
  const q2 = pick(0.65)
  const q3 = pick(0.88)
  return {
    max,
    levelColor: (count: number) => {
      if (count <= 0) return colors[0]
      if (count <= q1) return colors[1]
      if (count <= q2) return colors[2]
      if (count <= q3) return colors[3]
      return colors[4]
    },
  }
}

/** Darken / lighten a hex colour */
function dim(hex: string, slope: number): string {
  const n = Number.parseInt(hex.slice(1), 16)
  const r = Math.max(0, Math.min(255, Math.round(((n >> 16) & 255) * slope)))
  const g = Math.max(0, Math.min(255, Math.round(((n >> 8) & 255) * slope)))
  const b = Math.max(0, Math.min(255, Math.round((n & 255) * slope)))
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`
}

/** Create a metallic highlight – blend the colour toward white */
function highlight(hex: string, amount: number): string {
  const n = Number.parseInt(hex.slice(1), 16)
  const blend = (ch: number) => Math.min(255, Math.round(ch + (255 - ch) * amount))
  const r = blend((n >> 16) & 255)
  const g = blend((n >> 8) & 255)
  const b = blend(n & 255)
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`
}

function stats(days: Day[]) {
  const total = days.reduce((a, d) => a + d.count, 0)
  const max = days.reduce((a, d) => Math.max(a, d.count), 0)
  const average = Number((total / Math.max(1, days.length)).toFixed(2))

  let current = 0
  let best = 0
  for (const d of days) {
    if (d.count > 0) {
      current += 1
      best = Math.max(best, current)
    } else {
      current = 0
    }
  }
  return { total, max, average, current, best }
}

/* ─── SVG Decorative Elements ────────────────────────── */

/** SVG path for a traditional Chinese lantern – with gentle swaying animation */
let lanternId = 0
function svgLantern(cx: number, cy: number, scale: number = 1): string {
  const s = scale
  const id = lanternId++
  const dur = `${6 + id * 1.5}s`
  const sway = 3 * s  // horizontal sway distance in px
  const parts: string[] = []
  // Wrap in animated group – pure horizontal translate sway
  parts.push(`<g>`)
  parts.push(`<animateTransform attributeName="transform" type="translate" values="0,0;${sway},0;0,0;${-sway},0;0,0" dur="${dur}" repeatCount="indefinite"/>`)
  // tassel string at top
  parts.push(`<line x1="${cx}" y1="${cy - 28 * s}" x2="${cx}" y2="${cy - 18 * s}" stroke="#ffd700" stroke-width="${1.5 * s}"/>`)
  // top cap
  parts.push(`<rect x="${cx - 6 * s}" y="${cy - 18 * s}" width="${12 * s}" height="${4 * s}" rx="${1.5 * s}" fill="#ffd700"/>`)
  // main body (ellipse) – pulsing glow
  parts.push(`<ellipse cx="${cx}" cy="${cy}" rx="${14 * s}" ry="${18 * s}" fill="#e74c3c">
    <animate attributeName="opacity" values="0.85;0.95;0.85" dur="4s" repeatCount="indefinite"/>
  </ellipse>`)
  parts.push(`<ellipse cx="${cx}" cy="${cy}" rx="${14 * s}" ry="${18 * s}" fill="none" stroke="#ffd700" stroke-width="${0.8 * s}"/>`)
  // vertical ribs
  parts.push(`<line x1="${cx}" y1="${cy - 18 * s}" x2="${cx}" y2="${cy + 18 * s}" stroke="#ffd700" stroke-width="${0.5 * s}" opacity="0.5"/>`)
  parts.push(`<line x1="${cx - 7 * s}" y1="${cy - 16 * s}" x2="${cx - 7 * s}" y2="${cy + 16 * s}" stroke="#ffd700" stroke-width="${0.4 * s}" opacity="0.3"/>`)
  parts.push(`<line x1="${cx + 7 * s}" y1="${cy - 16 * s}" x2="${cx + 7 * s}" y2="${cy + 16 * s}" stroke="#ffd700" stroke-width="${0.4 * s}" opacity="0.3"/>`)
  // horizontal band
  parts.push(`<rect x="${cx - 14 * s}" y="${cy - 3 * s}" width="${28 * s}" height="${6 * s}" rx="${2 * s}" fill="#ffd700" opacity="0.35"/>`)
  // 福 character
  parts.push(`<text x="${cx}" y="${cy + 4 * s}" font-family="serif" font-size="${11 * s}" fill="#ffd700" text-anchor="middle" font-weight="700">福</text>`)
  // bottom cap
  parts.push(`<rect x="${cx - 6 * s}" y="${cy + 14 * s}" width="${12 * s}" height="${4 * s}" rx="${1.5 * s}" fill="#ffd700"/>`)
  // tassel
  parts.push(`<line x1="${cx}" y1="${cy + 18 * s}" x2="${cx}" y2="${cy + 30 * s}" stroke="#ffd700" stroke-width="${1.2 * s}"/>`)
  parts.push(`<line x1="${cx - 3 * s}" y1="${cy + 30 * s}" x2="${cx}" y2="${cy + 26 * s}" stroke="#ffd700" stroke-width="${0.8 * s}"/>`)
  parts.push(`<line x1="${cx + 3 * s}" y1="${cy + 30 * s}" x2="${cx}" y2="${cy + 26 * s}" stroke="#ffd700" stroke-width="${0.8 * s}"/>`)
  // glow – animated pulse
  parts.push(`<ellipse cx="${cx}" cy="${cy}" rx="${18 * s}" ry="${22 * s}" fill="url(#lanternGlow)">
    <animate attributeName="opacity" values="0.2;0.35;0.2" dur="${dur}" repeatCount="indefinite"/>
  </ellipse>`)
  parts.push(`</g>`)
  return parts.join("\n")
}

/** SVG Chinese cloud motif – with gentle drifting animation */
let cloudId = 0
function svgCloud(cx: number, cy: number, scale: number = 1, opacity: number = 0.12): string {
  const s = scale
  const id = cloudId++
  const drift = 12 + id * 4    // drift distance
  const dur = `${40 + id * 12}s` // very slow, different per cloud
  return `<g opacity="${opacity}">
    <animateTransform attributeName="transform" type="translate" values="${cx},${cy};${cx + drift},${cy - 2};${cx},${cy}" dur="${dur}" repeatCount="indefinite"/>
    <g transform="scale(${s})">
      <circle cx="0" cy="0" r="12" fill="#ffd700"/>
      <circle cx="10" cy="-3" r="10" fill="#ffd700"/>
      <circle cx="20" cy="0" r="8" fill="#ffd700"/>
      <circle cx="-10" cy="-2" r="9" fill="#ffd700"/>
      <circle cx="5" cy="-10" r="7" fill="#ffd700"/>
    </g>
  </g>`
}

/** SVG firecracker string – with sparkle animation on fuses */
function svgFirecracker(x: number, y: number, scale: number = 1): string {
  const s = scale
  const parts: string[] = []
  // string
  parts.push(`<line x1="${x}" y1="${y}" x2="${x}" y2="${y + 70 * s}" stroke="#ffd700" stroke-width="${1 * s}" opacity="0.6"/>`)
  // firecrackers
  for (let i = 0; i < 5; i++) {
    const fy = y + 10 * s + i * 14 * s
    const fx = x + (i % 2 === 0 ? -4 * s : 4 * s)
    parts.push(`<rect x="${fx - 4 * s}" y="${fy}" width="${8 * s}" height="${12 * s}" rx="${2 * s}" fill="#e74c3c" stroke="#ffd700" stroke-width="${0.5 * s}"/>`)
    parts.push(`<line x1="${fx}" y1="${fy}" x2="${fx}" y2="${fy - 4 * s}" stroke="#ffd700" stroke-width="${0.5 * s}"/>`)
    // Sparkle star at fuse tip
    const sparkDelay = `${i * 0.8}s`
    parts.push(`<circle cx="${fx}" cy="${fy - 5 * s}" r="${2 * s}" fill="#ffd700">
      <animate attributeName="opacity" values="0;1;0" dur="2.5s" begin="${sparkDelay}" repeatCount="indefinite"/>
      <animate attributeName="r" values="${1 * s};${2.5 * s};${1 * s}" dur="2.5s" begin="${sparkDelay}" repeatCount="indefinite"/>
    </circle>`)
  }
  return parts.join("\n")
}

/** SVG plum blossom branch (梅花) */
function svgPlumBranch(x: number, y: number, scale: number = 1, flip: boolean = false): string {
  const s = scale
  const dir = flip ? -1 : 1
  const parts: string[] = []

  // Main branch
  parts.push(`<path d="M${x},${y} Q${x + 40 * s * dir},${y - 20 * s} ${x + 80 * s * dir},${y - 35 * s} Q${x + 100 * s * dir},${y - 42 * s} ${x + 120 * s * dir},${y - 38 * s}" stroke="#8b4513" stroke-width="${2.5 * s}" fill="none" stroke-linecap="round"/>`)
  // Secondary branch
  parts.push(`<path d="M${x + 50 * s * dir},${y - 25 * s} Q${x + 60 * s * dir},${y - 50 * s} ${x + 75 * s * dir},${y - 58 * s}" stroke="#8b4513" stroke-width="${1.8 * s}" fill="none" stroke-linecap="round"/>`)
  // Small twig
  parts.push(`<path d="M${x + 85 * s * dir},${y - 36 * s} Q${x + 95 * s * dir},${y - 55 * s} ${x + 105 * s * dir},${y - 60 * s}" stroke="#8b4513" stroke-width="${1.2 * s}" fill="none" stroke-linecap="round"/>`)

  // Plum blossom helper – 5 petals
  const blossom = (bx: number, by: number, r: number, opacity: number = 0.9) => {
    for (let i = 0; i < 5; i++) {
      const angle = (i * 72 - 90) * Math.PI / 180
      const px = bx + Math.cos(angle) * r * 0.7
      const py = by + Math.sin(angle) * r * 0.7
      parts.push(`<circle cx="${px}" cy="${py}" r="${r * 0.55}" fill="#ff8fa3" opacity="${opacity}"/>`)
    }
    // centre pistil
    parts.push(`<circle cx="${bx}" cy="${by}" r="${r * 0.25}" fill="#ffd700" opacity="0.9"/>`)
  }

  // Flowers along branches
  blossom(x + 45 * s * dir, y - 22 * s, 5 * s)
  blossom(x + 72 * s * dir, y - 55 * s, 4.5 * s)
  blossom(x + 100 * s * dir, y - 58 * s, 4 * s)
  blossom(x + 110 * s * dir, y - 36 * s, 5 * s, 0.8)
  blossom(x + 30 * s * dir, y - 12 * s, 3.5 * s, 0.6)

  // Buds (small dots)
  parts.push(`<circle cx="${x + 120 * s * dir}" cy="${y - 39 * s}" r="${2 * s}" fill="#ff6b8a" opacity="0.7"/>`)
  parts.push(`<circle cx="${x + 60 * s * dir}" cy="${y - 28 * s}" r="${1.5 * s}" fill="#ff8fa3" opacity="0.5"/>`)

  // Falling petals (CSS animated)
  const petalPositions = [
    { px: 50, py: -25, delay: 0, dur: 4 },
    { px: 80, py: -40, delay: 1.5, dur: 5 },
    { px: 105, py: -50, delay: 3, dur: 4.5 },
  ]
  for (const p of petalPositions) {
    const petalX = x + p.px * s * dir
    const petalY = y + p.py * s
    parts.push(`<circle class="falling-petal" cx="${petalX}" cy="${petalY}" r="${2 * s}" fill="#ff8fa3" style="animation-delay: ${p.delay}s; animation-duration: ${p.dur}s;"/>`)
  }

  return parts.join("\n")
}

/** SVG Chinese knot (中国结) */
function svgChineseKnot(cx: number, cy: number, scale: number = 1): string {
  const s = scale
  const parts: string[] = []
  const knotColor = "#c0392b"
  const goldTrim = "#ffd700"

  // Hanging string
  parts.push(`<line x1="${cx}" y1="${cy - 40 * s}" x2="${cx}" y2="${cy - 25 * s}" stroke="${goldTrim}" stroke-width="${1.5 * s}"/>`)

  // Main diamond frame
  const d = 22 * s
  parts.push(`<polygon points="${cx},${cy - d} ${cx + d},${cy} ${cx},${cy + d} ${cx - d},${cy}" fill="${knotColor}" stroke="${goldTrim}" stroke-width="${1.2 * s}"/>`)
  // Inner diamond
  const d2 = 14 * s
  parts.push(`<polygon points="${cx},${cy - d2} ${cx + d2},${cy} ${cx},${cy + d2} ${cx - d2},${cy}" fill="none" stroke="${goldTrim}" stroke-width="${0.8 * s}"/>`)
  // Cross lines inside
  parts.push(`<line x1="${cx - d2 * 0.6}" y1="${cy}" x2="${cx + d2 * 0.6}" y2="${cy}" stroke="${goldTrim}" stroke-width="${0.6 * s}" opacity="0.6"/>`)
  parts.push(`<line x1="${cx}" y1="${cy - d2 * 0.6}" x2="${cx}" y2="${cy + d2 * 0.6}" stroke="${goldTrim}" stroke-width="${0.6 * s}" opacity="0.6"/>`)
  // 春 character
  parts.push(`<text x="${cx}" y="${cy + 5 * s}" font-family="serif" font-size="${14 * s}" fill="${goldTrim}" text-anchor="middle" font-weight="700">春</text>`)

  // Side loops (simple arcs)
  for (const side of [-1, 1]) {
    parts.push(`<path d="M${cx + d * side},${cy} Q${cx + (d + 12) * side},${cy - 10 * s} ${cx + d * side},${cy - 12 * s}" stroke="${knotColor}" stroke-width="${2 * s}" fill="none"/>`)
    parts.push(`<path d="M${cx + d * side},${cy} Q${cx + (d + 12) * side},${cy + 10 * s} ${cx + d * side},${cy + 12 * s}" stroke="${knotColor}" stroke-width="${2 * s}" fill="none"/>`)
  }

  // Bottom tassels
  for (const dx of [-8, 0, 8]) {
    parts.push(`<line x1="${cx + dx * s}" y1="${cy + d}" x2="${cx + dx * s}" y2="${cy + d + 25 * s}" stroke="${knotColor}" stroke-width="${1.5 * s}"/>`)
    parts.push(`<line x1="${cx + dx * s - 3 * s}" y1="${cy + d + 25 * s}" x2="${cx + dx * s}" y2="${cy + d + 20 * s}" stroke="${knotColor}" stroke-width="${0.8 * s}"/>`)
    parts.push(`<line x1="${cx + dx * s + 3 * s}" y1="${cy + d + 25 * s}" x2="${cx + dx * s}" y2="${cy + d + 20 * s}" stroke="${knotColor}" stroke-width="${0.8 * s}"/>`)
  }

  return parts.join("\n")
}

/** SVG decorative Spring Festival banner (横幅) */
function svgFestiveBanner(cx: number, cy: number, text: string, scale: number = 1): string {
  const s = scale
  const parts: string[] = []
  const bw = 180 * s  // banner half-width
  const bh = 22 * s   // banner half-height

  // Scroll shape – main body
  parts.push(`<rect x="${cx - bw}" y="${cy - bh}" width="${bw * 2}" height="${bh * 2}" rx="${4 * s}" fill="#c0392b" opacity="0.85" stroke="#ffd700" stroke-width="${1.2 * s}"/>`)
  // Inner border
  parts.push(`<rect x="${cx - bw + 6 * s}" y="${cy - bh + 4 * s}" width="${(bw - 6 * s) * 2}" height="${(bh - 4 * s) * 2}" rx="${2 * s}" fill="none" stroke="#ffd700" stroke-width="${0.5 * s}" opacity="0.5"/>`)
  // Scroll end caps
  for (const side of [-1, 1]) {
    parts.push(`<ellipse cx="${cx + bw * side}" cy="${cy}" rx="${4 * s}" ry="${bh + 3 * s}" fill="#a83228" stroke="#ffd700" stroke-width="${0.8 * s}"/>`)
  }
  // Text
  parts.push(`<text x="${cx}" y="${cy + 6 * s}" font-family="'Noto Serif SC', 'Source Han Serif CN', serif" font-size="${18 * s}" fill="#ffd700" text-anchor="middle" font-weight="700" letter-spacing="${6 * s}">${text}</text>`)

  return parts.join("\n")
}

/* ─── SVG Render ─────────────────────────────────────── */

function render(days: Day[], username: string, duration: Duration): string {
  const { max, levelColor } = quantileLevels(days)
  const s = stats(days)
  const gridStart = alignSunday(days[0].date)
  const endD = days[days.length - 1].date

  // ── Canvas dimensions
  const width = 950
  const height = 440

  // ── Isometric parameters  (tuned for ~52-week full-year grid)
  const cellW = 13       // horizontal spacing per cell (iso x-axis)
  const cellH = 6.5      // vertical spacing per cell  (iso y-axis)
  const maxBarH = 40     // max bar height in px
  // Place origin so grid is roughly centred in left ⅔ of canvas
  const gridCX = width * 0.25  // horizontal centre of iso plane
  const gridTopY = 50          // top of iso plane

  const totalWeeks = Math.floor(diffDays(endD, gridStart) / 7)

  const parts: string[] = []

  // ── SVG open + defs
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`)
  parts.push(`<defs>
  <linearGradient id="bgGrad" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#6b2a2a"/>
    <stop offset="40%" stop-color="#7a3535"/>
    <stop offset="100%" stop-color="#5c1f1f"/>
  </linearGradient>
  <radialGradient id="lanternGlow">
    <stop offset="0%" stop-color="#ff6b3b" stop-opacity="0.6"/>
    <stop offset="100%" stop-color="#ff6b3b" stop-opacity="0"/>
  </radialGradient>
  <linearGradient id="floorGrad" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="#3d1515" stop-opacity="0.5"/>
    <stop offset="100%" stop-color="#2a0e0e" stop-opacity="0.3"/>
  </linearGradient>
  <filter id="glow">
    <feGaussianBlur stdDeviation="3" result="coloredBlur"/>
    <feMerge>
      <feMergeNode in="coloredBlur"/>
      <feMergeNode in="SourceGraphic"/>
    </feMerge>
  </filter>
  <style>
    .falling-petal {
      animation-name: petalFall;
      animation-timing-function: ease-in-out;
      animation-iteration-count: infinite;
    }
    @keyframes petalFall {
      0%   { opacity: 0.8; transform: translate(0, 0) rotate(0deg); }
      50%  { opacity: 0.5; transform: translate(8px, 30px) rotate(180deg); }
      100% { opacity: 0; transform: translate(15px, 60px) rotate(360deg); }
    }
    .border-glow {
      animation: borderPulse 8s ease-in-out infinite;
    }
    @keyframes borderPulse {
      0%   { stroke-opacity: 0.15; }
      50%  { stroke-opacity: 0.35; }
      100% { stroke-opacity: 0.15; }
    }
    .corner-sparkle {
      animation: sparkle 4s ease-in-out infinite;
    }
    @keyframes sparkle {
      0%   { opacity: 0.2; }
      50%  { opacity: 0.6; }
      100% { opacity: 0.2; }
    }
  </style>
</defs>`)

  // ── Background
  parts.push(`<rect width="100%" height="100%" fill="url(#bgGrad)"/>`)

  // ── Decorative border frame (animated glow)
  parts.push(`<rect class="border-glow" x="8" y="8" width="${width - 16}" height="${height - 16}" rx="12" fill="none" stroke="#ffd700" stroke-width="1.5" opacity="0.2"/>`)
  parts.push(`<rect x="14" y="14" width="${width - 28}" height="${height - 28}" rx="8" fill="none" stroke="#ffd700" stroke-width="0.5" opacity="0.12"/>`)

  // ── Corner ornaments (animated sparkle)
  for (const [i, [ox, oy]] of ([[24, 24], [width - 24, 24], [24, height - 24], [width - 24, height - 24]] as [number, number][]).entries()) {
    parts.push(`<polygon class="corner-sparkle" points="${ox},${oy - 6} ${ox + 6},${oy} ${ox},${oy + 6} ${ox - 6},${oy}" fill="#ffd700" style="animation-delay: ${i * 0.5}s;"/>`)
  }

  // ── Decorative clouds (top area)
  parts.push(svgCloud(60, 20, 0.45, 0.08))
  parts.push(svgCloud(880, 18, 0.4, 0.06))
  parts.push(svgCloud(420, 22, 0.3, 0.05))

  // ── Lanterns (top corners) – reset counter so both sway identically
  lanternId = 0
  parts.push(svgLantern(40, 48, 0.75))
  lanternId = 0  // reset so right lantern gets the exact same animation
  parts.push(svgLantern(910, 48, 0.75))

  // ── Firecrackers
  parts.push(svgFirecracker(82, 30, 0.4))
  parts.push(svgFirecracker(868, 30, 0.4))

  // Helper: convert grid (week, dow) → isometric screen coords
  // In iso: week axis goes to the right+down, dow axis goes to the left+down
  // This ensures oldest data is far-left and newest is far-right
  const isoX = (week: number, dow: number) => gridCX + (week - dow) * cellW
  const isoY = (week: number, dow: number) => gridTopY + (week + dow) * cellH

  // ── Floor plane (isometric ground tiles)
  const hw = cellW   // half-width of diamond along x-iso
  const hh = cellH   // half-height of diamond along y-iso
  for (const d of days) {
    const dow = toDate(d.date).getUTCDay()
    const week = totalWeeks - Math.floor(diffDays(d.date, gridStart) / 7)
    const cx = isoX(week, dow)
    const cy = isoY(week, dow)
    // diamond (top face at floor level)
    const floor = `${cx},${cy - hh} ${cx + hw},${cy} ${cx},${cy + hh} ${cx - hw},${cy}`
    parts.push(`<polygon points="${floor}" fill="#4d1c1c" stroke="#6b2a2a" stroke-width="0.4" opacity="0.65"/>`)
  }



  // ── 3D Bars (render back-to-front so near bars overlap far bars)
  // Sort: higher week first, then higher dow first so front bars paint last
  const sorted = [...days].sort((a, b) => {
    const wa = totalWeeks - Math.floor(diffDays(a.date, gridStart) / 7)
    const wb = totalWeeks - Math.floor(diffDays(b.date, gridStart) / 7)
    if (wa !== wb) return wa - wb   // render far (small week) first
    const da = toDate(a.date).getUTCDay()
    const db = toDate(b.date).getUTCDay()
    return da - db   // render top-of-column first
  })

  for (const d of sorted) {
    if (d.count <= 0) continue   // skip empty – floor tile is enough

    const dow = toDate(d.date).getUTCDay()
    const week = totalWeeks - Math.floor(diffDays(d.date, gridStart) / 7)
    const ratio = max > 0 ? d.count / max : 0
    const h = ratio * maxBarH

    const cx = isoX(week, dow)
    const cy = isoY(week, dow)

    const c = levelColor(d.count)
    // Metallic colours: left = lit side, right = shadow side, top = bright highlight
    const cTop = highlight(c, 0.25)     // bright specular highlight
    const cLeft = dim(c, 0.7)           // lit side – slightly darker
    const cRight = dim(c, 0.4)          // shadow side
    const cTopEdge = highlight(c, 0.45) // very bright specular edge

    // Top face (diamond shifted up by bar height)
    const top = `${cx},${cy - hh - h} ${cx + hw},${cy - h} ${cx},${cy + hh - h} ${cx - hw},${cy - h}`
    // Left face (lit side)
    const left = `${cx - hw},${cy - h} ${cx},${cy + hh - h} ${cx},${cy + hh} ${cx - hw},${cy}`
    // Right face (shadow side)
    const right = `${cx},${cy + hh - h} ${cx + hw},${cy - h} ${cx + hw},${cy} ${cx},${cy + hh}`

    // Shadow side
    parts.push(`<polygon points="${right}" fill="${cRight}" stroke="${dim(c, 0.25)}" stroke-width="0.3"/>`)
    // Lit side with subtle metallic edge highlight
    parts.push(`<polygon points="${left}" fill="${cLeft}" stroke="${dim(c, 0.5)}" stroke-width="0.3"/>`)
    // Metallic edge highlight on left face top edge
    parts.push(`<line x1="${cx - hw}" y1="${cy - h}" x2="${cx}" y2="${cy + hh - h}" stroke="${cTopEdge}" stroke-width="0.8" opacity="0.5"/>`)
    // Top face – brightest, metallic sheen
    parts.push(`<polygon points="${top}" fill="${cTop}" stroke="${cTopEdge}" stroke-width="0.5"/>`)
    // Specular highlight line across top face centre – animated shimmer
    const shimmerDelay = `${(week * 7 + dow) * 0.08}s`
    parts.push(`<line x1="${cx - hw * 0.5}" y1="${cy - h - hh * 0.5}" x2="${cx + hw * 0.5}" y2="${cy - h - hh * 0.5}" stroke="white" stroke-width="0.6">
      <animate attributeName="opacity" values="0.08;0.25;0.08" dur="6s" begin="${shimmerDelay}" repeatCount="indefinite"/>
    </line>`)
  }

  // ── Dragon Dance (舞龙) Animation ──────────────────────
  // Build a path that winds through the grid AND climbs over contribution bars
  {
    // Build a lookup for bar heights: key = "week,dow" → height
    const barHeightMap = new Map<string, number>()
    for (const d of days) {
      if (d.count <= 0) continue
      const dow = toDate(d.date).getUTCDay()
      const week = totalWeeks - Math.floor(diffDays(d.date, gridStart) / 7)
      const ratio = max > 0 ? d.count / max : 0
      barHeightMap.set(`${week},${dow}`, ratio * maxBarH)
    }

    // Build waypoints: Random walk that prefers the "bar zone" (weeks 0-7)
    // but occasionally wanders out.
    const waypoints: { x: number; y: number }[] = []

    // Start in the middle of the 'action' (bar zone) -> NO, User wants "Open Ground" below.
    let currW = 20
    let currD = 5
    
    // Add initial point
    // Helper to get coords with height
    const getPt = (w: number, d: number) => {
      const cx = isoX(w, d)
      const cy = isoY(w, d)
      const h = barHeightMap.get(`${w},${d}`) ?? 0
      return { x: cx, y: cy - h, w, d }
    }
    
    waypoints.push(getPt(currW, currD))

    const recentHistory: string[] = []
    
    // Dragon length INCREASED to ~55 segments.
    // Need a history buffer larger than that (in steps) to avoid running into own tail.
    // 5.5s length / 24s total * 80 steps ~= 18 steps.
    // 32 is a safe buffer.
    const historyLen = 32
    
    // Number of steps for the dragon path
    const steps = 80

    // Track previous move for momentum
    let lastDw = 0
    let lastDd = 0

    for (let i = 0; i < steps; i++) {
        // Potential moves: up, down, left, right (in grid coords)
        const moves = [
            { dw: 1, dd: 0 }, { dw: -1, dd: 0 },
            { dw: 0, dd: 1 }, { dw: 0, dd: -1 },
            { dw: 1, dd: 1 }, { dw: 1, dd: -1 },
            { dw: -1, dd: 1 }, { dw: -1, dd: -1 }
        ]

        const candidates: { w: number, d: number, score: number, move: {dw:number, dd:number} }[] = []
        
        for (const m of moves) {
            const nw = currW + m.dw
            const nd = currD + m.dd
            
            // Bounds check
            if (nw < 0 || nw >= totalWeeks || nd < 0 || nd > 6) continue

            // 1. Base Score
            let score = Math.random() * 5 

            const isFlat = !barHeightMap.has(`${nw},${nd}`);
            const wasFlat = !barHeightMap.has(`${currW},${currD}`);

            // 2. Bar Attraction (minimal)
            if (nw <= 8) score += 2 
            if (nw <= 4) score += 1 
            
            if (barHeightMap.has(`${nw},${nd}`)) score += 15

            // 3. Collision Avoidance (Strict)
            if (recentHistory.includes(`${nw},${nd}`)) score -= 1000

            // 4. Momentum / Flow (HIGHWAY MODE)
            if (m.dw === lastDw && m.dd === lastDd) {
                score += 50; 
                if (isFlat && wasFlat) score += 30; 
            }
            else if (m.dw === lastDw || m.dd === lastDd) {
                score += 5;
            }

            // 5. NO BACKWARD MOVEMENT (Fix Inverted Head)
            if ((m.dw - m.dd) < 0) {
                score -= 5000; 
            }

            candidates.push({ w: nw, d: nd, score, move: m })
        }

        // Sort by score
        candidates.sort((a, b) => b.score - a.score)
        
        // Pick one of the top valid candidates
        const valid = candidates.filter(c => c.score > -500)
        
        if (valid.length > 0) {
            const topK = valid.slice(0, 3)
            const choice = topK[Math.floor(Math.random() * topK.length)]
            
            currW = choice.w
            currD = choice.d
            lastDw = choice.move.dw
            lastDd = choice.move.dd
            
            const key = `${currW},${currD}`
            recentHistory.push(key)
            if (recentHistory.length > historyLen) recentHistory.shift()

            waypoints.push(getPt(currW, currD))
        } else {
            break
        }
    }

    // Ensure we have enough points for a smooth spline
    // (The cubic bezier loop below handles it)

    if (waypoints.length >= 4) {
      // Build a smooth SVG path with cubic bezier curves
      let pathD = `M${waypoints[0].x},${waypoints[0].y}`
      for (let i = 1; i < waypoints.length; i++) {
        const curr = waypoints[i]
        const prev = waypoints[i - 1]
        // Use smooth curves between waypoints
        const cpx1 = prev.x + (curr.x - prev.x) * 0.4
        const cpy1 = prev.y
        const cpx2 = prev.x + (curr.x - prev.x) * 0.6
        const cpy2 = curr.y
        pathD += ` C${cpx1},${cpy1} ${cpx2},${cpy2} ${curr.x},${curr.y}`
      }

      const dragonPathId = "dragonPath"
      parts.push(`<path id="${dragonPathId}" d="${pathD}" fill="none" stroke="none"/>`)

      const animDur = "24s"
      const segCount = 24
      const segDelay = 0.25

      // ─ Dragon tail – tapered fin
      const tailDelay = `${(segCount + 1) * segDelay}s`
      parts.push(`<g opacity="0.6">
        <animateMotion dur="${animDur}" begin="${tailDelay}" repeatCount="indefinite" rotate="auto">
          <mpath href="#${dragonPathId}"/>
        </animateMotion>
        <path d="M-2,0 L-10,-4 Q-14,0 -10,4 Z" fill="#c0392b" stroke="#ffd700" stroke-width="0.5"/>
        <path d="M-6,0 L-16,-2.5 Q-18,0 -16,2.5 Z" fill="#e74c3c" stroke="#ffd700" stroke-width="0.3" opacity="0.5"/>
      </g>`)

      // ─ Dragon body segments – alternating red/gold with spine crests
      for (let i = 0; i < segCount; i++) {
        const beginDelay = `${(i + 1) * segDelay}s`
        const isGold = i % 3 === 1  // pattern: red, gold, red, gold...
        const segColor = isGold ? "#f5c842" : "#c0392b"
        const segStroke = isGold ? "#d4a020" : "#ffd700"
        // Taper: larger at front, smaller toward tail
        const t = i / segCount
        const rx = 6 - t * 2.5
        const ry = 4.5 - t * 1.5
        const opacity = 0.88 - t * 0.3

        parts.push(`<g opacity="${opacity}">
          <animateMotion dur="${animDur}" begin="${beginDelay}" repeatCount="indefinite" rotate="auto">
            <mpath href="#${dragonPathId}"/>
          </animateMotion>
          <ellipse cx="0" cy="0" rx="${rx.toFixed(1)}" ry="${ry.toFixed(1)}" fill="${segColor}" stroke="${segStroke}" stroke-width="0.6"/>
          <ellipse cx="0" cy="${(-ry * 0.85).toFixed(1)}" rx="${(rx * 0.35).toFixed(1)}" ry="${(ry * 0.3).toFixed(1)}" fill="${isGold ? '#e8823a' : '#ffd700'}" opacity="0.45"/>
        </g>`)
      }

      // ─ Dragon Head – detailed Chinese dragon face (v2 design)
      parts.push(`<g opacity="0.9">
        <animateMotion dur="${animDur}" repeatCount="indefinite" rotate="auto">
          <mpath href="#${dragonPathId}"/>
        </animateMotion>
        <!-- Main head shape – wide, rectangular face -->
        <rect x="-10" y="-8" width="20" height="16" rx="4" fill="#c0392b" stroke="#ffd700" stroke-width="1"/>
        <!-- Forehead crest -->
        <path d="M-6,-8 Q0,-14 6,-8" fill="#e74c3c" stroke="#ffd700" stroke-width="0.8"/>
        <!-- Left deer-antler horn -->
        <path d="M-5,-8 L-7,-16 L-9,-13 M-7,-16 L-5,-19" stroke="#ffd700" stroke-width="1.3" fill="none" stroke-linecap="round"/>
        <!-- Right deer-antler horn -->
        <path d="M5,-8 L7,-16 L9,-13 M7,-16 L5,-19" stroke="#ffd700" stroke-width="1.3" fill="none" stroke-linecap="round"/>
        <!-- Left eye – large and expressive -->
        <ellipse cx="-4" cy="-2" rx="2.5" ry="2" fill="#fff" opacity="0.9"/>
        <circle cx="-4" cy="-2" r="1.3" fill="#ffd700"/>
        <circle cx="-4.3" cy="-2.2" r="0.6" fill="#1a0505"/>
        <!-- Right eye -->
        <ellipse cx="4" cy="-2" rx="2.5" ry="2" fill="#fff" opacity="0.9"/>
        <circle cx="4" cy="-2" r="1.3" fill="#ffd700"/>
        <circle cx="3.7" cy="-2.2" r="0.6" fill="#1a0505"/>
        <!-- Nose -->
        <ellipse cx="0" cy="1" rx="3" ry="1.5" fill="#e74c3c" stroke="#ffd700" stroke-width="0.5"/>
        <circle cx="-1.2" cy="0.8" r="0.6" fill="#8b1a12"/>
        <circle cx="1.2" cy="0.8" r="0.6" fill="#8b1a12"/>
        <!-- Open mouth with fangs -->
        <path d="M-6,4 Q0,10 6,4" fill="#8b1a12" stroke="#ffd700" stroke-width="0.6"/>
        <line x1="-3" y1="4.5" x2="-2.5" y2="6.5" stroke="#fff" stroke-width="0.8" stroke-linecap="round"/>
        <line x1="3" y1="4.5" x2="2.5" y2="6.5" stroke="#fff" stroke-width="0.8" stroke-linecap="round"/>
        <!-- Beard / tendrils -->
        <path d="M-8,2 Q-14,5 -12,10" stroke="#ffd700" stroke-width="0.8" fill="none" opacity="0.7"/>
        <path d="M-7,4 Q-12,8 -10,13" stroke="#ffd700" stroke-width="0.6" fill="none" opacity="0.5"/>
        <path d="M8,2 Q14,5 12,10" stroke="#ffd700" stroke-width="0.8" fill="none" opacity="0.7"/>
        <path d="M7,4 Q12,8 10,13" stroke="#ffd700" stroke-width="0.6" fill="none" opacity="0.5"/>
        <!-- Mane tufts -->
        <circle cx="-9" cy="-4" r="2.5" fill="#e8823a" opacity="0.6"/>
        <circle cx="9" cy="-4" r="2.5" fill="#e8823a" opacity="0.6"/>
        <circle cx="-10" cy="0" r="2" fill="#e8823a" opacity="0.5"/>
        <circle cx="10" cy="0" r="2" fill="#e8823a" opacity="0.5"/>
      </g>`)
    }
  }

  // ── Stats panel (compact, bottom-right)
  const px = 680
  const py = 200

  // Panel background (smaller)
  parts.push(`<rect x="${px - 14}" y="${py - 28}" width="280" height="220" rx="10" fill="#3a1212" opacity="0.55" stroke="#f5c842" stroke-width="0.5" stroke-opacity="0.25"/>`)

  // Commits streaks
  parts.push(`<text x="${px}" y="${py}" font-family="system-ui, -apple-system, sans-serif" font-size="14" fill="#ffd700" font-weight="600">🔥 连续贡献</text>`)
  parts.push(`<text x="${px}" y="${py + 20}" font-family="system-ui, -apple-system, sans-serif" font-size="12" fill="#d4a574">最长连续 ${s.best} 天 ∙ 当前 ${s.current} 天</text>`)

  // Divider
  parts.push(`<line x1="${px}" y1="${py + 34}" x2="${px + 240}" y2="${py + 34}" stroke="#ffd700" stroke-width="0.5" opacity="0.2"/>`)

  // Commits per day
  parts.push(`<text x="${px}" y="${py + 54}" font-family="system-ui, -apple-system, sans-serif" font-size="14" fill="#ffd700" font-weight="600">📊 每日贡献</text>`)
  parts.push(`<text x="${px}" y="${py + 74}" font-family="system-ui, -apple-system, sans-serif" font-size="12" fill="#d4a574">单日最高 ${s.max} 次 ∙ 日均 ~${s.average} 次</text>`)

  // Divider
  parts.push(`<line x1="${px}" y1="${py + 88}" x2="${px + 240}" y2="${py + 88}" stroke="#ffd700" stroke-width="0.5" opacity="0.2"/>`)

  // Total
  parts.push(`<text x="${px}" y="${py + 110}" font-family="system-ui, -apple-system, sans-serif" font-size="14" fill="#ffd700" font-weight="600">🏮 年度总计</text>`)
  parts.push(`<text x="${px}" y="${py + 142}" font-family="'Noto Serif SC', serif" font-size="30" fill="#ffd700" font-weight="700" filter="url(#glow)">${s.total}</text>`)
  parts.push(`<text x="${px + 90}" y="${py + 142}" font-family="system-ui, -apple-system, sans-serif" font-size="12" fill="#d4a574">次贡献</text>`)

  // ── Color legend
  const lx = px
  const ly = py + 172
  parts.push(`<text x="${lx}" y="${ly}" font-family="system-ui, -apple-system, sans-serif" font-size="10" fill="#d4a574" opacity="0.7">少</text>`)
  const legendColors = ["#5a2020", "#b82e2e", "#d94040", "#e8823a", "#f5c842"]
  for (let li = 0; li < legendColors.length; li++) {
    parts.push(`<rect x="${lx + 16 + li * 16}" y="${ly - 9}" width="12" height="12" rx="2" fill="${legendColors[li]}" stroke="#ffd700" stroke-width="0.3" stroke-opacity="0.3"/>`)
  }
  parts.push(`<text x="${lx + 16 + legendColors.length * 16 + 5}" y="${ly}" font-family="system-ui, -apple-system, sans-serif" font-size="10" fill="#d4a574" opacity="0.7">多</text>`)

  // ── Decorative plum blossoms (near the grid)
  parts.push(svgPlumBranch(340, 100, 0.7))
  parts.push(svgPlumBranch(460, 90, 0.5, true))

  // ── Bottom decorative text
  parts.push(`<text x="${width / 2}" y="${height - 16}" font-family="'Noto Serif SC', serif" font-size="12" fill="#ffd700" text-anchor="middle" opacity="0.3">新春快乐 · 万事如意 · ${new Date().getFullYear()}</text>`)

  // ── Subtle clouds at bottom
  parts.push(svgCloud(80, height - 30, 0.4, 0.04))
  parts.push(svgCloud(550, height - 25, 0.5, 0.04))
  parts.push(svgCloud(950, height - 35, 0.35, 0.03))

  parts.push(`</svg>`)
  return parts.join("\n")
}

/* ─── Main ───────────────────────────────────────────── */

async function main() {
  const { username, output, duration } = parseArgs()
  const end = iso(new Date())
  const lookback = duration === "full-year" ? 365 : 180
  let start = addDays(end, -lookback)
  start = alignSunday(start)

  const map = await fetchContributions(username, start, end)
  const days = dateRange(start, end).map((date) => ({ date, count: map.get(date) ?? 0 }))

  const svg = render(days, username, duration)
  const outPath = path.resolve(output)
  await mkdir(path.dirname(outPath), { recursive: true })
  await writeFile(outPath, svg, "utf8")
  console.log(`Generated: ${output}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
