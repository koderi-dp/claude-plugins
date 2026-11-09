// The preview's stand-in for the engine's declarations: pane.tsx imports two types from 'claude-code' and compiles
// its JSX against the globals `h` and `Fragment`. The preview defines them at run time (html.ts); this file only
// lets tsc read the pure modules outside the engine. Nothing here is loaded by the plugin.
declare module 'claude-code' {
  export type RenderElement = unknown
  export type EngineInterface = { ui: { resolve: (e: unknown) => Record<string, (props: Record<string, unknown>) => RenderElement> } }
}
declare const h: (tag: unknown, props: Record<string, unknown> | null | undefined, ...children: unknown[]) => unknown
declare const Fragment: (props: { children?: unknown[] }) => unknown
declare namespace JSX {
  type Element = unknown
  interface IntrinsicElements {}
  interface ElementChildrenAttribute {
    children: unknown
  }
  interface IntrinsicAttributes {
    key?: string
  }
}

// The bits of Node the render script and the pure modules use, so no @types/node install is needed.
declare function structuredClone<T>(value: T): T
declare const console: { log: (...args: unknown[]) => void; error: (...args: unknown[]) => void }
declare const __dirname: string
declare module 'node:fs' {
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void
  export function writeFileSync(path: string, text: string): void
}
declare module 'node:path' {
  export function join(...parts: string[]): string
}
