# Pipeline panel preview

Renders the panel's states (idle, running, fixRound, queue, history, runningOpen with Recent activity open, runningCompact under `tasks: compact`) with dummy data through the same
`renderPanel`, `draw.ts` and `status.ts` the plugin runs, to HTML and PNG, so the panel can be reviewed from
screenshots outside the desktop app. The plugin does not load this folder: `hooks/hooks.json` names only
`register.tsx`, and the engine loads only what that module imports.

From the repository root, with the global `tsc` and `playwright` this machine has (no npm install):

```
tsc -p plugins/pipeline/preview && node plugins/pipeline/preview/out/build/preview/render.js
node plugins/pipeline/preview/shoot.mjs
```

The pages and screenshots land in `plugins/pipeline/preview/out/` (ignored by git): `<state>.html` and
`<state>.png`. Under the running and fix-round panels the band above the prompt is drawn too; under the idle
panel, the idle strip.

- `fixtures.ts`: the `PanelInput` states.
- `html.ts`: the element table (Box, Text, Button, Svg, Input, Link) as HTML, and the `h` factory the compiled JSX calls.
- `render.ts`: the script; `env.d.ts` and `tsconfig.json` let `tsc` compile the pure modules outside the engine.
- `shoot.mjs`: the Playwright screenshots, dark colour scheme, device scale 2.
