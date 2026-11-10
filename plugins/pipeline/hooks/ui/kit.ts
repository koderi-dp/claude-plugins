// The kit: the drawn primitives every drawing of the panel and the band is composed from. Each is a pure function
// that returns an SVG fragment (a string) at the position it is given; there is no layout engine. Colours come from
// the tokens as classes, so one stylesheet serves light and dark. Pure: strings in, strings out, no engine.

import type { Role, Tone } from './tokens'
import { RADIUS, SIZE, WEIGHT, fillClass, strokeClass, styleFor, toneRole } from './tokens'

export const xml = (s: string): string => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

// CJK, fullwidth forms and emoji advance about 1em; at 0.56em a wide title was sized at half its width.
const WIDE =
  /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꥠ-꥿가-힣豈-﫿︰-﹏！-｠￠-￦\u{1F300}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u

// Rough advance of system UI text, in em; good enough to size a text's slot.
const charEm = (ch: string): number => (WIDE.test(ch) ? 1 : /[\s.,:;'|!il1()[\]]/.test(ch) ? 0.3 : /[A-ZА-ЯЁmwшщжюМШЩЖЮ@%]/.test(ch) ? 0.72 : 0.56)

export const textWidth = (s: string, size: number): number => [...s].reduce((w, ch) => w + charEm(ch) * size, 0)

/** Cuts `s` to fit `maxW` pixels, with an ellipsis when it had to cut. */
export const fitText = (s: string, size: number, maxW: number): string => {
  if (textWidth(s, size) <= maxW) return s
  let out = ''
  for (const ch of s) {
    if (textWidth(out + ch + '…', size) > maxW) break
    out += ch
  }
  return out + '…'
}

/** Breaks a sentence into lines of at most `maxW` pixels, at most `max` of them, the last cut with an ellipsis. */
export const wrapText = (s: string, size: number, maxW: number, max = 3): string[] => {
  const lines: string[] = []
  let current = ''
  for (const word of s.split(/\s+/).filter(Boolean)) {
    const next = current ? `${current} ${word}` : word
    if (textWidth(next, size) <= maxW || !current) current = next
    else {
      lines.push(current)
      current = word
    }
  }
  if (current) lines.push(current)
  if (lines.length <= max) return lines.map(l => fitText(l, size, maxW))
  const kept = lines.slice(0, max)
  kept[max - 1] = fitText(lines.slice(max - 1).join(' '), size, maxW)
  return kept
}

/** A coordinate as the SVG carries it: at most two decimals. */
const n = (v: number): string => String(Math.round(v * 100) / 100)

/** A measured fragment: what a row puts at its start or its end. */
export type Piece = { svg: string; width: number }

// ---------- the frame ----------

/** The `<svg>` wrapper, with the stylesheet cut to the classes the body uses. */
export const frame = (W: number, H: number, body: string): string => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${styleFor(body)}${body}</svg>`

// ---------- text ----------

export type TextOptions = {
  size?: number
  weight?: number
  /** The colour: a role, or a tone. Foreground when left out. */
  role?: Role | Tone
  anchor?: 'start' | 'middle' | 'end'
  /** Cut with an ellipsis past this width. */
  maxW?: number
  /** Digits of one width, for a clock or a count. */
  isTabular?: boolean
  tracking?: number
  isMono?: boolean
}

const roleOf = (r: Role | Tone | undefined): Role => (r === undefined ? 'foreground' : r === 'neutral' ? toneRole(r) : r)

/** One line of text at a baseline: escaped, and cut to `maxW` when given. */
export const text = (x: number, y: number, s: string, o: TextOptions = {}): string => {
  const size = o.size ?? SIZE.base
  const shown = o.maxW === undefined ? s : fitText(s, size, Math.max(0, o.maxW))
  const extra = `${o.anchor && o.anchor !== 'start' ? ` text-anchor="${o.anchor}"` : ''}${o.tracking ? ` letter-spacing="${o.tracking}"` : ''}${o.isTabular ? ' font-variant-numeric="tabular-nums"' : ''}`
  return `<text class="${fillClass(roleOf(o.role))}${o.isMono ? ' mono' : ''}" x="${n(x)}" y="${n(y)}" font-size="${size}" font-weight="${o.weight ?? WEIGHT.regular}"${extra}>${xml(shown)}</text>`
}

// ---------- surfaces and lines ----------

export type SurfaceVariant = 'card' | 'muted' | 'primary'
const SURFACE: Record<SurfaceVariant, { fill: Role; stroke: Role }> = {
  card: { fill: 'card', stroke: 'border' },
  muted: { fill: 'muted', stroke: 'border' },
  primary: { fill: 'primarySurface', stroke: 'primaryBorder' },
}

/** The bordered rounded rectangle: a card, a muted tile, or the purple-tinted card of what runs. The border sits inside the box. */
export const surface = (x: number, y: number, w: number, h: number, o: { variant?: SurfaceVariant; radius?: number } = {}): string => {
  const v = SURFACE[o.variant ?? 'card']
  return `<rect x="${n(x + 0.5)}" y="${n(y + 0.5)}" width="${n(Math.max(0, w - 1))}" height="${n(Math.max(0, h - 1))}" rx="${o.radius ?? RADIUS.lg}" class="${fillClass(v.fill)} ${strokeClass(v.stroke)}"/>`
}

/** A horizontal hairline in the border colour. */
export const separator = (x: number, y: number, w: number): string => `<rect x="${n(x)}" y="${n(y)}" width="${n(Math.max(0, w))}" height="1" class="${fillClass('border')}"/>`

/** The same hairline, upright: between two things on one line. */
export const divider = (x: number, y: number, h: number): string => `<rect x="${n(x)}" y="${n(y)}" width="1" height="${n(h)}" class="${fillClass('border')}"/>`

/** A faint fill of a tone: the avatar's square, any soft block. */
export const soft = (x: number, y: number, w: number, h: number, tone: Tone, radius: number = RADIUS.md): string => `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${radius}" fill-opacity="0.14" class="${fillClass(toneRole(tone))}"/>`

/** A ringed disc centred on `x`, `y`: a tone as a faint fill with its ring (strong: the ring at full strength), or plain, the card with the border. */
export const disc = (x: number, y: number, r: number, tone: Tone | 'plain', isStrong = false): string => {
  if (tone === 'plain') return `<circle cx="${n(x)}" cy="${n(y)}" r="${n(r)}" class="${fillClass('card')} ${strokeClass('border')}"/>`
  const role = toneRole(tone)
  return `<circle cx="${n(x)}" cy="${n(y)}" r="${n(r)}" fill-opacity="0.14" stroke-opacity="${isStrong ? 1 : 0.5}" class="${fillClass(role)} ${strokeClass(role)}"/>`
}

// ---------- the dot ----------

/** A disc in a tone at its centre, pulsing when live; hollow for what is idle. */
export const dot = (x: number, y: number, tone: Tone, isLive = false, o: { r?: number; isHollow?: boolean } = {}): string => {
  const r = o.r ?? 3.5
  const role = toneRole(tone)
  const circle = o.isHollow ? `<circle cx="${n(x)}" cy="${n(y)}" r="${n(r - 0.75)}" fill="none" stroke-width="1.5" class="${strokeClass(role)}"/>` : `<circle cx="${n(x)}" cy="${n(y)}" r="${n(r)}" class="${fillClass(role)}"/>`
  return isLive ? `<g class="live">${circle}</g>` : circle
}

// ---------- the badge ----------

export const BADGE_H = 18
const BADGE_PAD = 7

export type BadgeOptions = {
  tone?: Tone
  /** Soft: the tone as a faint fill. Outline: a bordered chip on the surface. */
  variant?: 'soft' | 'outline'
  /** `x` is the badge's right edge. */
  anchor?: 'start' | 'end'
  minW?: number
  /** A dot before the label; live pulses. */
  dot?: 'still' | 'live'
  tracking?: number
}

const badgeWidth = (label: string, o: BadgeOptions): number => Math.max(o.minW ?? 0, Math.round(textWidth(label, SIZE.xs) + [...label].length * (o.tracking ?? 0) + BADGE_PAD * 2 + (o.dot ? 9 : 0)))

/** The one badge: a status tag, a state tag, an id chip. `y` is its top; it is BADGE_H tall. Returns its measured width. */
export const badge = (x: number, y: number, label: string, o: BadgeOptions = {}): Piece => {
  const tone = o.tone ?? 'neutral'
  const role = toneRole(tone)
  const width = badgeWidth(label, o)
  const left = o.anchor === 'end' ? x - width : x
  const box =
    o.variant === 'outline'
      ? `<rect x="${n(left + 0.5)}" y="${n(y + 0.5)}" width="${n(width - 1)}" height="${BADGE_H - 1}" rx="${RADIUS.sm}" class="${fillClass('card')} ${strokeClass('border')}"/>`
      : `<rect x="${n(left)}" y="${n(y)}" width="${n(width)}" height="${BADGE_H}" rx="${RADIUS.sm}" fill-opacity="0.14" class="${fillClass(role)}"/>`
  const mark = o.dot ? dot(left + BADGE_PAD + 2.5, y + BADGE_H / 2, tone, o.dot === 'live', { r: 2.5 }) : ''
  const style = { size: SIZE.xs, weight: WEIGHT.semibold, role: tone, ...(o.tracking ? { tracking: o.tracking } : {}) }
  // With a dot the label starts beside it, so the gap between the two is the same in every badge; alone it is centred.
  const label_ = o.dot ? text(left + BADGE_PAD + 9, y + 12.5, label, style) : text(left + width / 2, y + 12.5, label, { ...style, anchor: 'middle' })
  return { svg: box + mark + label_, width }
}

// ---------- bars ----------

export const BAR_H = 6

/** A progress bar: the track, and the tone over `value` (0 to 1) of it. */
export const progress = (x: number, y: number, w: number, value: number, tone: Tone, o: { h?: number } = {}): string => {
  const h = o.h ?? BAR_H
  const fillW = Math.round(w * Math.min(1, Math.max(0, value)))
  const track = `<rect x="${n(x)}" y="${n(y)}" width="${n(Math.max(0, w))}" height="${h}" rx="${h / 2}" class="${fillClass('input')}"/>`
  return fillW > 0 ? `${track}<rect x="${n(x)}" y="${n(y)}" width="${n(Math.max(h, fillW))}" height="${h}" rx="${h / 2}" class="${fillClass(toneRole(tone))}"/>` : track
}

/** One segment of a segmented bar: a tone, or the empty track; striped for the one in progress. */
export type Seg = { tone: Tone | 'track'; isStriped?: boolean }

/** The pattern a striped segment fills with: the tone faint, with solid bars of it. */
export const stripeId = (tone: Tone): string => `stripe-${tone}`
const stripe = (tone: Tone, h: number): string => {
  const cls = fillClass(toneRole(tone))
  return `<pattern id="${stripeId(tone)}" width="12" height="${h}" patternUnits="userSpaceOnUse"><rect width="12" height="${h}" fill-opacity="0.35" class="${cls}"/><rect width="4" height="${h}" class="${cls}"/></pattern>`
}

/** A segmented bar: one rounded segment per entry, over the width; an empty list draws one empty segment. */
export const segments = (x: number, y: number, w: number, list: Seg[], o: { h?: number; gap?: number } = {}): string => {
  const h = o.h ?? BAR_H
  const gap = o.gap ?? 4
  const all: Seg[] = list.length ? list : [{ tone: 'track' }]
  const each = (w - gap * (all.length - 1)) / all.length
  const striped = [...new Set(all.filter(s => s.isStriped && s.tone !== 'track').map(s => s.tone as Tone))]
  const defs = striped.length ? `<defs>${striped.map(t => stripe(t, h)).join('')}</defs>` : ''
  const rects = all
    .map((s, i) => {
      const at = `x="${n(x + i * (each + gap))}" y="${n(y)}" width="${n(Math.max(0, each))}" height="${h}" rx="${h / 2}"`
      if (s.tone === 'track') return `<rect ${at} class="${fillClass('input')}"/>`
      return s.isStriped ? `<rect ${at} fill="url(#${stripeId(s.tone)})"/>` : `<rect ${at} class="${fillClass(toneRole(s.tone))}"/>`
    })
    .join('')
  return defs + rects
}

// ---------- icons ----------

// Lucide path data (ISC licence), 24 by 24, drawn as strokes.
const ICONS = {
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  circle: '<circle cx="12" cy="12" r="10"/>',
  'circle-dot': '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="1"/>',
  'circle-check': '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  terminal: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
  'chevron-right': '<path d="m9 18 6-6-6-6"/>',
  'git-pull-request': '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><path d="M6 9v12"/>',
  'alert-triangle': '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  bot: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
} as const

export type IconName = keyof typeof ICONS
export const ICON_NAMES = Object.keys(ICONS) as IconName[]

/** An icon with its top-left corner at `x`, `y`, `size` pixels square, stroked in a role or a tone; the stroke stays about 1.5 px when small. */
export const icon = (name: IconName, x: number, y: number, size: number, role: Role | Tone = 'foreground', isLive = false): string => {
  const drawn = `<g transform="translate(${n(x)} ${n(y)}) scale(${n(size / 24)})" fill="none" stroke-width="${n(Math.max(2, 36 / size))}" stroke-linecap="round" stroke-linejoin="round" class="${strokeClass(roleOf(role))}">${ICONS[name]}</g>`
  return isLive ? `<g class="live">${drawn}</g>` : drawn
}

/** The ringed check of what is done, 16 px, centred on `x`, `y`. */
export const check = (x: number, y: number, tone: Tone = 'success'): string => icon('circle-check', x - 8, y - 8, 16, tone)
