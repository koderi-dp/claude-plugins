#!/usr/bin/env node
/**
 * Set up a project the way the "Give Fable a team" guide describes, so it
 * works without the fable-team plugin:
 *
 *   .claude/agents/builder.md, research.md, reviewer.md   (copied from this plugin)
 *   CLAUDE.md                                              (## Subagent routing section added)
 *
 * Usage: node init.mjs [project-dir] [--force]
 *   project-dir  defaults to the current working directory
 *   --force      overwrite agent files that differ, and replace an existing
 *                "## Subagent routing" section
 *
 * Idempotent: a second run with no changes reports "unchanged" everywhere.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const force = args.includes('--force')
const projectDir = resolve(args.find((a) => !a.startsWith('--')) ?? process.cwd())

const ROUTING_HEADING = '## Subagent routing'
const ROUTING_BODY = `Keep Fable as the lead: plan, assign work and accept the result.
Use built-in Explore on Sonnet for local file discovery.
Use research for outside docs and facts.
Use builder once the files, approach and done criteria are clear.
Use reviewer to check the finished change against the original brief.
Keep the custom agents on their configured models and effort.
Do not use Fable for workers.

Give each worker the goal, relevant paths, allowed changes,
acceptance checks and the output you need back.
Send concrete review findings back to builder, then recheck.
Handle tiny changes directly. Do not spawn every role for every task.`

const report = []

function note(status, path, extra = '') {
  report.push(`${status.padEnd(10)} ${path}${extra ? `  (${extra})` : ''}`)
}

function copyAgents() {
  const srcDir = join(pluginRoot, 'agents')
  const dstDir = join(projectDir, '.claude', 'agents')
  mkdirSync(dstDir, { recursive: true })
  for (const file of readdirSync(srcDir).filter((f) => f.endsWith('.md')).sort()) {
    const src = join(srcDir, file)
    const dst = join(dstDir, file)
    const rel = `.claude/agents/${file}`
    const content = readFileSync(src, 'utf8')
    if (!existsSync(dst)) {
      writeFileSync(dst, content)
      note('created', rel)
      continue
    }
    const existing = readFileSync(dst, 'utf8')
    if (normalize(existing) === normalize(content)) {
      note('unchanged', rel)
    } else if (force) {
      writeFileSync(dst, matchEol(content, existing))
      note('replaced', rel)
    } else {
      note('kept', rel, 'differs from the plugin copy; rerun with --force to replace')
    }
  }
}

function normalize(text) {
  return text.replace(/\r\n/g, '\n').trimEnd()
}

/** Write `text` with the line endings `like` uses, so an existing CRLF file stays CRLF. */
function matchEol(text, like) {
  const crlf = like.includes('\r\n')
  const lf = text.replace(/\r\n/g, '\n')
  return crlf ? lf.replace(/\n/g, '\r\n') : lf
}

function updateClaudeMd() {
  const path = join(projectDir, 'CLAUDE.md')
  const rel = 'CLAUDE.md'
  const section = `${ROUTING_HEADING}\n\n${ROUTING_BODY}\n`

  if (!existsSync(path)) {
    const header =
      '# CLAUDE.md\n\nThis file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.\n\n'
    writeFileSync(path, header + section)
    note('created', rel, 'with the Subagent routing section')
    return
  }

  const existing = readFileSync(path, 'utf8')
  const lf = existing.replace(/\r\n/g, '\n')
  const start = lf.indexOf(`\n${ROUTING_HEADING}`) === -1 && !lf.startsWith(ROUTING_HEADING)
    ? -1
    : lf.startsWith(ROUTING_HEADING) ? 0 : lf.indexOf(`\n${ROUTING_HEADING}`) + 1

  if (start === -1) {
    const sep = lf.endsWith('\n') ? (lf.endsWith('\n\n') ? '' : '\n') : '\n\n'
    writeFileSync(path, matchEol(lf + sep + section, existing))
    note('updated', rel, 'Subagent routing section appended')
    return
  }

  // Section runs to the next "## " heading or end of file.
  const afterHeading = start + ROUTING_HEADING.length
  const nextHeading = lf.indexOf('\n## ', afterHeading)
  const end = nextHeading === -1 ? lf.length : nextHeading + 1
  const current = lf.slice(start, end)
  if (normalize(current) === normalize(section)) {
    note('unchanged', rel, 'Subagent routing section already current')
    return
  }
  if (!force) {
    note('kept', rel, 'has a different Subagent routing section; rerun with --force to replace')
    return
  }
  const replaced = lf.slice(0, start) + section + (nextHeading === -1 ? '' : '\n') + lf.slice(end)
  writeFileSync(path, matchEol(replaced, existing))
  note('replaced', rel, 'Subagent routing section')
}

if (!existsSync(projectDir)) {
  console.error(`project folder does not exist: ${projectDir}`)
  process.exit(2)
}

copyAgents()
updateClaudeMd()

console.log(`fable-team init in ${projectDir}`)
for (const line of report) console.log(`  ${line}`)
console.log('')
console.log('Start a fresh Claude Code session in this project so the agents are detected.')
console.log('The project now works without the fable-team plugin; disable it to avoid duplicate agents.')
