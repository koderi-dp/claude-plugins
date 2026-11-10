// The preview's element table: the surface elements pane.tsx draws with (Box, Text, Button, Svg, Input, Link) as
// functions that return HTML, so the real renderPanel runs unchanged and its tree comes out as a page. Sizes are
// the desktop's: one cell is 8 px.

type Props = Record<string, unknown>
type Node = unknown

import { COLORS } from '../hooks/ui/tokens'

const CELL = 8
export const DIM = 'var(--dim)'

export const escape = (s: string): string => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

/** Children as HTML: strings escaped, numbers printed, nested elements (already HTML) passed through, nothing for null. */
const inner = (children: Node): string => {
  if (children === null || children === undefined || children === false || children === true) return ''
  if (Array.isArray(children)) return children.map(inner).join('')
  if (typeof children === 'string') return escape(children)
  if (typeof children === 'number') return String(children)
  if (typeof children === 'object' && 'html' in (children as object)) return String((children as { html: string }).html)
  return escape(String(children))
}

/** An element: the HTML it renders to, wrapped so `inner` does not escape it. */
type El = { html: string }
const el = (html: string): El => ({ html })

const style = (pairs: [string, string | number | undefined | null | false][]): string => {
  const out = pairs.filter(([, v]) => v !== undefined && v !== null && v !== false && v !== '').map(([k, v]) => `${k}:${v}`)
  return out.length ? ` style="${out.join(';')}"` : ''
}
const px = (v: unknown): string | undefined => (typeof v === 'number' ? `${v * CELL}px` : undefined)

export function Box(p: Props): El {
  const dir = (p['flexDirection'] as string | undefined) ?? 'row'
  const border = p['borderStyle'] ? `1px solid var(${p['borderDimColor'] ? '--border' : '--border-strong'})` : undefined
  return el(
    `<div class="box"${style([
      ['display', 'flex'],
      ['flex-direction', dir],
      ['justify-content', p['justifyContent'] as string | undefined],
      ['align-items', (p['alignItems'] as string | undefined) ?? (dir === 'column' ? 'stretch' : 'flex-start')],
      ['flex-wrap', p['flexWrap'] as string | undefined],
      ['gap', px(p['gap'])],
      ['margin-top', px(p['marginTop'])],
      ['margin-bottom', px(p['marginBottom'])],
      ['margin-left', px(p['marginLeft'])],
      ['padding-left', px(p['paddingLeft'] ?? p['paddingX'])],
      ['padding-right', px(p['paddingRight'] ?? p['paddingX'])],
      ['padding-top', px(p['paddingTop'] ?? p['paddingY'])],
      ['padding-bottom', px(p['paddingBottom'] ?? p['paddingY'])],
      ['width', px(p['width'])],
      ['border', border],
      ['border-radius', border ? '8px' : undefined],
      ['min-width', '0'],
    ])}>${inner(p['children'])}</div>`,
  )
}

export function Text(p: Props): El {
  const weight = (p['weight'] as string | undefined) ?? (p['bold'] ? 'bold' : undefined)
  const size = p['size'] === 'heading' ? '17px' : p['size'] === 'small' ? '11px' : undefined
  return el(
    `<span class="text"${style([
      ['color', (p['color'] as string | undefined) ?? (p['dimColor'] ? DIM : undefined)],
      ['font-weight', weight === 'semibold' ? 600 : weight === 'regular' ? 400 : weight],
      ['font-size', size],
      ['font-family', p['mono'] ? 'ui-monospace,SFMono-Regular,Consolas,monospace' : undefined],
      ['font-variant-numeric', p['tabular'] ? 'tabular-nums' : undefined],
      ['opacity', p['dimColor'] && p['color'] ? 0.7 : undefined],
    ])}>${inner(p['children'])}</span>`,
  )
}

export function Button(p: Props): El {
  const plain = !!p['plain']
  return el(
    `<button type="button" class="${plain ? 'plain' : 'button'}"${style([['color', p['dimColor'] ? DIM : plain ? 'var(--accent)' : undefined]])}>${escape(String(p['label'] ?? ''))}${p['hotkey'] ? `<kbd>${escape(String(p['hotkey']))}</kbd>` : ''}</button>`,
  )
}

export function Svg(p: Props): El {
  return el(`<div class="svg" role="img" aria-label="${escape(String(p['alt'] ?? ''))}"${style([['width', `${p['width']}px`], ['height', `${p['height']}px`]])}>${String(p['source'] ?? '')}</div>`)
}

export function Input(p: Props): El {
  return el(`<span class="input"><input type="text" value="${escape(String(p['value'] ?? ''))}" placeholder="${escape(String(p['placeholder'] ?? ''))}" readonly />${p['submitLabel'] ? `<span class="submit">${escape(String(p['submitLabel']))}</span>` : ''}</span>`)
}

export function Link(p: Props): El {
  return el(`<a href="${escape(String(p['href'] ?? '#'))}">${inner(p['children'])}</a>`)
}

export function Fragment(p: Props): El {
  return el(`<div class="box" style="display:flex;flex-direction:column">${inner(p['children'])}</div>`)
}

/** The JSX factory pane.tsx compiles against: calls the element function with its props and children. */
export function h(tag: unknown, props: Props | null | undefined, ...children: unknown[]): El {
  const flat = children.flat(Infinity)
  const all = { ...(props ?? {}), children: flat.length === 1 ? flat[0] : flat }
  if (typeof tag === 'function') return (tag as (p: Props) => El)(all)
  return el(`<${String(tag)}>${inner(all['children'])}</${String(tag)}>`)
}

/** The table `renderPanel` takes as the surface's `ui`. */
export const ui = { Box, Text, Button, Svg, Input, Link }

/** The HTML text of a rendered tree. */
export const htmlOf = (tree: unknown): string => inner(tree)

const vars = (scheme: 'light' | 'dark'): string =>
  `--page:${scheme === 'dark' ? COLORS.background.dark : COLORS.muted.light};--pane:${COLORS.background[scheme]};--border:${COLORS.border[scheme]};--border-strong:${COLORS.input[scheme]};--fg:${COLORS.foreground[scheme]};--dim:${COLORS.mutedForeground[scheme]};--accent:${COLORS.primary[scheme]};--control:${COLORS.muted[scheme]}`

/** The page's own styles: the app around the drawings, in the tokens' neutrals, light or dark with the browser's scheme. */
export const PAGE_CSS = `
:root{color-scheme:light dark;${vars('light')}}
@media (prefers-color-scheme: dark){:root{${vars('dark')}}}
body{margin:0;padding:24px;background:var(--page);color:var(--fg);font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',Inter,sans-serif;font-size:13px;line-height:20px}
.pane{width:520px;padding:12px 16px;background:var(--pane);border:1px solid var(--border);border-radius:12px}
.pane + .pane{margin-top:24px}
.text{white-space:pre-wrap;min-width:0;overflow-wrap:anywhere}
.svg{display:block;line-height:0;flex:none}
.svg svg{display:block}
button{font:inherit;cursor:default;color:inherit;background:var(--control);border:1px solid var(--border);border-radius:6px;padding:0 8px;line-height:20px}
button.plain{background:transparent;border:0;padding:0}
kbd{margin-left:6px;font-size:10px;color:var(--dim)}
.input{display:flex;flex:1;gap:8px;align-items:center}
.input input{flex:1;font:inherit;color:var(--fg);background:var(--control);border:1px solid var(--border);border-radius:6px;padding:2px 8px;line-height:20px}
.submit{font-size:11px;color:var(--dim)}
a{color:var(--accent);text-decoration:none}
.label{margin:0 0 8px;font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:1px}
.caption{margin-top:32px}
.sheet .label{margin-top:20px}
.sheet .label:first-child{margin-top:0}
.sheet .svg{margin-bottom:8px}
`
