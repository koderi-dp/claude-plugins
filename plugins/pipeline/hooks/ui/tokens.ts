// The tokens: every colour, radius, spacing step and type size a drawing uses, and the one stylesheet built from
// them. A drawing names a role (`foreground`, `primary`, `border`), never a colour: the stylesheet gives each role
// its light value and, under `prefers-color-scheme: dark`, its dark one. Pure data, no engine.

/** A colour role: shadcn's neutral scale, the panel's purple as primary, and green, amber and red for states. */
export type Role =
  | 'background'
  | 'card'
  | 'muted'
  | 'border'
  | 'input'
  | 'foreground'
  | 'mutedForeground'
  | 'subtle'
  | 'primary'
  | 'success'
  | 'warning'
  | 'destructive'
  | 'primarySurface'
  | 'primaryBorder'

/** Each role's value per scheme. `background` is the app's own and is never painted; it is here for the preview. */
export const COLORS: Record<Role, { light: string; dark: string }> = {
  background: { light: '#ffffff', dark: '#0a0a0a' },
  card: { light: '#ffffff', dark: '#171717' },
  muted: { light: '#f5f5f5', dark: '#1f1f1f' },
  border: { light: '#e5e5e5', dark: '#2e2e2e' },
  // The track of a bar and a pending segment.
  input: { light: '#e0e0e0', dark: '#3a3a3a' },
  foreground: { light: '#0a0a0a', dark: '#fafafa' },
  mutedForeground: { light: '#636363', dark: '#a1a1a1' },
  subtle: { light: '#8a8a8a', dark: '#737373' },
  primary: { light: '#6a4bd6', dark: '#af99ff' },
  success: { light: '#178245', dark: '#78dbac' },
  warning: { light: '#b0590a', dark: '#ebba79' },
  destructive: { light: '#d42f38', dark: '#f68b91' },
  primarySurface: { light: '#f7f5ff', dark: '#1c1927' },
  primaryBorder: { light: '#ddd6fa', dark: '#3b3257' },
}

export const ROLES = Object.keys(COLORS) as Role[]

/** Every colour value of the tokens, both schemes: the only hex colours of the drawings. */
export const ALL_COLORS: string[] = ROLES.flatMap(r => [COLORS[r].light, COLORS[r].dark])

/** The tone of a badge, a dot, a bar: a state colour, or neutral. */
export type Tone = 'primary' | 'success' | 'warning' | 'destructive' | 'neutral'
export const TONES: Tone[] = ['primary', 'success', 'warning', 'destructive', 'neutral']

/** The role that paints a tone. */
export const toneRole = (tone: Tone): Role => (tone === 'neutral' ? 'mutedForeground' : tone)

// The names the non-SVG code uses (a Text's `color`): the dark values, since the app's panel is dark-first.
export const ACCENT = COLORS.primary.dark
export const DONE = COLORS.success.dark
export const BLOCKED = COLORS.warning.dark
export const MUTED = COLORS.mutedForeground.dark
export const FAILED = COLORS.destructive.dark
/** The current task's card border, and the hairline. */
export const CARD_BORDER = COLORS.primaryBorder.dark
export const LINE = COLORS.border.dark
/** A pending segment as a Text colour. */
export const TRACK = COLORS.input.dark

/** The tone a colour handed in by name (`ACCENT`, `DONE`, …) stands for; neutral for anything else. */
export const toneOf = (color: string | undefined): Tone => (color === ACCENT ? 'primary' : color === DONE ? 'success' : color === BLOCKED ? 'warning' : color === FAILED ? 'destructive' : 'neutral')

export const RADIUS = { sm: 6, md: 8, lg: 10, full: 999 } as const
/** The 4 px spacing scale: `SPACE[3]` is 12. */
export const SPACE = [0, 4, 8, 12, 16, 20, 24, 32] as const
/** `xl` is for a tile's number only. */
export const SIZE = { xs: 10, sm: 11, base: 12, md: 13, lg: 17, xl: 20 } as const
export const WEIGHT = { regular: 450, medium: 560, semibold: 640 } as const

export const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif"
export const MONO = 'ui-monospace,SFMono-Regular,Consolas,monospace'

/** The class that fills with a role, and the one that strokes with it. The three text greys keep their short names. */
export const fillClass = (role: Role): string => (role === 'foreground' ? 't' : role === 'mutedForeground' ? 's' : role === 'subtle' ? 'm' : `f-${role}`)
export const strokeClass = (role: Role): string => `k-${role}`

type Rule = { cls: string; prop: 'fill' | 'stroke'; role: Role }
const RULES: Rule[] = ROLES.flatMap(role => [
  { cls: fillClass(role), prop: 'fill' as const, role },
  { cls: strokeClass(role), prop: 'stroke' as const, role },
])

const BASE_CSS = `text{font-family:${FONT}}`
const LIVE_CSS = `.live{animation:p 2.2s ease-in-out infinite}@keyframes p{50%{opacity:.45}}@media (prefers-reduced-motion: reduce){.live{animation:none}}`

// A presentation attribute loses to the `text` rule above, so mono text takes a class.
const MONO_CSS = `.mono{font-family:${MONO}}`

const sheet = (rules: Rule[], hasLive: boolean, hasMono: boolean): string => {
  const css = (scheme: 'light' | 'dark') => rules.map(r => `.${r.cls}{${r.prop}:${COLORS[r.role][scheme]}}`).join('')
  return `<style>${BASE_CSS}${css('light')}@media (prefers-color-scheme: dark){${css('dark')}}${hasMono ? MONO_CSS : ''}${hasLive ? LIVE_CSS : ''}</style>`
}

/** The whole stylesheet: a fill and a stroke class per role, light, then dark under the media query, and the live pulse. */
export const STYLE = sheet(RULES, true, true)

/** The stylesheet cut to the classes a drawing's body uses, so a row does not carry every role. */
export const styleFor = (body: string): string => {
  const used = new Set<string>()
  for (const m of body.matchAll(/class="([^"]*)"/g)) for (const c of (m[1] ?? '').split(' ')) used.add(c)
  return sheet(
    RULES.filter(r => used.has(r.cls)),
    used.has('live'),
    used.has('mono'),
  )
}
