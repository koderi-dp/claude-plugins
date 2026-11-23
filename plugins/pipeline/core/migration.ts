// Migration: a project that keeps its own queue and process moves onto the pipeline, or from a file backlog onto issues.
import { update } from './state'
import type { Host } from './host'
import type { Backlog, Config, Item, Ledger } from '../types'
import { addItem, emptyBacklog, updateItem } from './backlog'
import { DEFAULTS, draftConfig, normalizeConfig } from './config'
import { parseJson, paths, places, serialize } from './files'
import { emptyLedger } from './ledger'
import { activeFromBranches, bulkToRemove, decisionsFromBacklogMd, findSources, historicalLine, incrementsOf, itemsFromBacklogMd, itemsFromMvpQueue, renderRulesMd, rulesFromProse, specStub } from './migrate'
import type { ActiveItem, Increment, MigrateRule } from './migrate'
import { isTrusted, issueBodyOf, labelsOf, migrationOf, openQuestionOf, renderSpecComment, specCommentOf, withNeeds } from './queue'
import { QUESTION_MARK } from './tracker'
import { readItemFile, worktreePath } from './actions'
import { ensureExclude, ensureIgnore, extrasOrRefuse, ghRun, isGithub, labelOf, relOf, writeExtras } from './github'
import { hasOpenQuestion } from './readiness'
import { ACTIVE_STATUSES, BACKLOG_FILE, CONFIG_FILE, STATUSES, commitLine, config, fileError, loadBacklog, loadJson, repoUrl, self, slashes } from './shared'
import { Refused, listDir, nowIso, statusNow, writeBacklog } from './tool'
import type { ToolInput } from './tool'
import { readText } from './watchdog'
import * as tracker from './tracker'

export const SDD_DIR = '.superpowers/sdd'
export const HISTORICAL = /^Historical\./

/** Repo-relative paths under `<root>/<dir>`, files and folders (with a slash), down to `depth` levels; nothing when the folder is not there. */
export async function walk(h: Host, found: string, dir: string, depth: number): Promise<string[]> {
  const out: string[] = []
  for (const name of await listDir(h, dir ? `${found}/${dir}` : found)) {
    const rel = dir ? `${dir}/${name}` : name
    out.push(rel)
    if (name.endsWith('/') && depth > 1) out.push(...(await walk(h, found, rel.slice(0, -1), depth - 1)))
  }
  return out
}

/** The project as the migration reads it: the listing of the known places, the branches and the superpowers increments. */
export async function scanProject(h: Host, found: string): Promise<{ listing: string[]; branches: string[]; increments: Increment[] }> {
  const listing: string[] = []
  const seen = new Set<string>()
  const add = (paths: string[]) => {
    for (const p of paths) if (!seen.has(p)) { seen.add(p); listing.push(p) }
  }
  const top = await walk(h, found, '', 1)
  add(top)
  for (const dir of top.filter(p => p.endsWith('/') && !p.startsWith('.'))) if (await h.fs.exists(`${found}/${dir}CLAUDE.md`)) add([`${dir}CLAUDE.md`])
  add(await walk(h, found, 'docs', 1))
  for (const dir of ['docs/superpowers/specs', 'docs/superpowers/plans', 'docs/superpowers/ledgers', '.github/workflows']) add(await walk(h, found, dir, 1))
  add(await walk(h, found, SDD_DIR, 5))
  add(await walk(h, found, '.claude/skills', 2))

  const branches: string[] = []
  for (const p of await walk(h, found, '.git/refs/heads', 6)) if (!p.endsWith('/')) branches.push(p.slice('.git/refs/heads/'.length))
  const packed = await readText(h, `${found}/.git/packed-refs`)
  for (const m of (packed ?? '').matchAll(/^[0-9a-f]{40} refs\/heads\/(\S+)/gm)) if (!branches.includes(m[1]!)) branches.push(m[1]!)

  const increments: Increment[] = []
  for (const dir of listing.filter(p => p.startsWith(`${SDD_DIR}/`) && p.endsWith('/') && p.slice(SDD_DIR.length + 1, -1).indexOf('/') < 0)) {
    const name = dir.slice(SDD_DIR.length + 1, -1)
    const texts: string[] = []
    const pointer = await readText(h, `${found}/${dir}plan-path`)
    if (pointer) texts.push(pointer.trim())
    const progress = await readText(h, `${found}/${dir}progress.md`)
    const header = /^#\s+.*$/m.exec(progress ?? '')?.[0]
    if (header) texts.push(header)
    increments.push({ dir: name, pointer: texts.join('\n') })
  }
  return { listing, branches, increments }
}

export const isMd = (p: string) => /\.md$/i.test(p)
export const isLedger = (p: string) => /^\.superpowers\/sdd\/(?:.*\/)?progress\.md$/.test(p) || /^docs\/superpowers\/ledgers\/[^/]+\.md$/.test(p)
export const isSkill = (p: string) => /^\.claude\/skills\/[^/]+\/SKILL\.md$/.test(p)
export const isWorkflow = (p: string) => /^\.github\/workflows\/[^/]+$/.test(p)
export const isClaudeMd = (p: string) => p === 'CLAUDE.md' || p.endsWith('/CLAUDE.md')

/** `migrate`: the sources read, the drafted config with its sources, the items, the rules, the active item, the bulk and the report. Writes nothing. */
export async function migrateDraft(h: Host, found: string): Promise<Record<string, unknown>> {
  const { listing, branches, increments } = await scanProject(h, found)
  const claudeMd = (await readText(h, `${found}/CLAUDE.md`)) ?? ''
  const sources = findSources(listing, claudeMd).filter(p => !p.endsWith('/'))
  const texts = new Map<string, string>()
  for (const file of sources) {
    const t = await readText(h, `${found}/${file}`)
    if (t !== null) texts.set(file, t)
  }
  const report: string[] = []
  const yielded = (file: string, what: string) => report.push(`${file}: ${what}`)

  // The config from the scripts, the make targets, the CI and the prose.
  let scripts: Record<string, string> = {}
  const pkg = texts.get('package.json')
  if (pkg !== undefined) {
    const parsed = parseJson<{ scripts?: Record<string, unknown> }>(pkg, 'package.json')
    if (parsed.ok) {
      scripts = Object.fromEntries(Object.entries(parsed.value?.scripts ?? {}).filter((kv): kv is [string, string] => typeof kv[1] === 'string'))
      yielded('package.json', `${Object.keys(scripts).length} scripts`)
    } else yielded('package.json', `not read: ${parsed.error}`)
  }
  const makeTargets = [...(texts.get('Makefile') ?? '').matchAll(/^([a-zA-Z_-]+):/gm)].map(m => m[1]!)
  if (texts.has('Makefile')) yielded('Makefile', `${makeTargets.length} targets`)
  const ci = sources.filter(isWorkflow).map(f => texts.get(f) ?? '').join('\n')
  for (const f of sources.filter(isWorkflow)) yielded(f, 'CI workflow')
  const prose = sources.filter(f => isMd(f) && texts.has(f)).map(f => texts.get(f)!)
  const dirs = listing.filter(p => /^[^/]+\/$/.test(p)).map(p => p.slice(0, -1))
  const { config: drafted, sources: sourcesOfConfig } = draftConfig({ scripts, makeTargets, ci, dirs, prose })

  // The items: the markdown queue, the MVP queue of each CLAUDE.md.
  const items: Partial<Item>[] = []
  const decisions: MigrateRule[] = []
  const backlogMd = texts.get('docs/backlog.md')
  if (backlogMd !== undefined) {
    const own = itemsFromBacklogMd(backlogMd, 'docs/backlog.md', await repoUrl(h))
    items.push(...own)
    decisions.push(...decisionsFromBacklogMd(backlogMd, 'docs/backlog.md'))
    const counts = `${own.length} items (${own.filter(i => i.status === 'merged').length} merged, ${own.filter(i => i.status === 'parked').length} parked)`
    yielded('docs/backlog.md', decisions.length ? `${counts}, ${decisions.length} open decision${decisions.length === 1 ? '' : 's'}` : counts)
  }
  for (const f of sources.filter(isClaudeMd)) {
    const own = itemsFromMvpQueue(texts.get(f) ?? '', f)
    items.push(...own)
    yielded(f, own.length ? `${own.length} queue entries` : 'no queue')
  }

  // The rules from the workflow prose.
  const ruleFiles = sources.filter(f => (isClaudeMd(f) || f === 'docs/WORKFLOW.md' || isSkill(f)) && texts.has(f))
  // The open decisions of the queue are stop rules before dispatch, not items.
  const rules = [...decisions, ...rulesFromProse(ruleFiles.map(file => ({ file, text: texts.get(file)! })))]
  for (const f of ruleFiles) {
    const n = rules.filter(r => r.source === f).length
    if (n || !isClaudeMd(f)) yielded(f, `${n} candidate rules`)
  }

  // The active item from the branches and the ledgers.
  const ledgerFiles = sources.filter(f => isLedger(f) && texts.has(f))
  const active = activeFromBranches(branches, ledgerFiles.map(file => ({ file, text: texts.get(file)! })))
  for (const f of ledgerFiles) {
    const hit = active.find(a => a.ledger === f)
    yielded(f, hit ? `ledger of ${hit.branch}, resume at task ${hit.resume.task}` : 'ledger, no open feat branch')
  }
  for (const f of sources) if (!report.some(r => r.startsWith(`${f}: `))) yielded(f, texts.has(f) ? 'read, nothing taken' : 'not readable')

  // The bulk of the merged increments.
  const { merged, unsure } = incrementsOf(increments, items)
  const bulk = bulkToRemove(listing, merged)
  if (merged.length) report.push(`merged increments: ${merged.join(', ')} (${bulk.count} files to remove)`)
  if (unsure.length) report.push(`unsure increments (a folder named like a merged item, no plan match): ${unsure.join(', ')}`)
  report.push(`branches: ${branches.length ? branches.join(', ') : 'none found under .git/refs/heads'}`)

  return { sources, config: drafted, sourcesOfConfig, items, rules, active, bulk, unsure, report: report.join('\n') }
}

export type ApplyItem = Partial<Item> & { resume?: ActiveItem['resume'] }

export const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)

/** `migrate-apply`: the four files from the corrected drafts, the ledger of a building item, the Historical lines, the bulk list. */
export async function migrateApply(h: Host, found: string, loaded: Backlog | null, e: ToolInput): Promise<string> {
  const p = paths(found)
  const now = await nowIso(h)
  const isRefresh = Boolean(e.refresh)

  const { config: given, problems } = normalizeConfig(e.config ?? {})
  if (problems.length) throw new Refused(problems.join('; '))
  if (!Array.isArray(e.items)) throw new Refused('migrate-apply needs items')
  const items = e.items.filter(isRecord) as ApplyItem[]
  for (const it of items) {
    if (typeof it.title !== 'string' || !it.title.trim()) throw new Refused('every item needs a title')
    if (it.status !== undefined && !STATUSES.includes(it.status)) throw new Refused(`item "${it.title.trim()}": unknown status ${JSON.stringify(it.status)}`)
  }
  const rules = (Array.isArray(e.rules) ? e.rules : []).filter((r): r is MigrateRule => isRecord(r) && typeof r['line'] === 'string' && typeof r['group'] === 'string')

  // The config: on a refresh the file on disk is the user's and stays as it is (the re-draft would overwrite
  // keys they tuned); it is written only when missing.
  const onDisk = isRefresh ? await loadJson<Record<string, unknown>>(h, p.config, CONFIG_FILE) : { value: null, error: null }
  if (onDisk.error) throw new Refused(onDisk.error)
  const nextConfig = onDisk.value ?? given
  if (!onDisk.value) await h.fs.write(p.config, serialize(given))
  await update(h, config, () => normalizeConfig(nextConfig).config)
  if (!isRefresh || !(await h.fs.exists(p.rules))) await h.fs.write(p.rules, renderRulesMd(rules))
  await ensureIgnore(h, found)

  // The items: added in order with new ids; on a refresh matched by id or title and only their titles, sources and links
  // refreshed (the ledger link is the tool's own and stays).
  let next: Backlog = loaded ?? emptyBacklog()
  const ids = new Map<string, string>()
  const fresh = new Set<string>()
  const LINKS = ['title', 'source', 'spec', 'plan', 'pr'] as const
  const ledgers: { id: string; item: ApplyItem }[] = []
  for (const it of items) {
    const { id: label, needs: _n, resume: _r, status, ...rest } = it
    const title = it.title!.trim()
    const existing = isRefresh ? next.items.find(i => (label !== undefined && i.id === label) || i.title === title) : undefined
    if (existing) {
      const fields: Partial<Item> = {}
      for (const k of LINKS) if (it[k] !== undefined && it[k] !== existing[k]) fields[k] = it[k] as never
      if (Object.keys(fields).length) next = updateItem(next, existing.id, fields, now)
      if (label) ids.set(label, existing.id)
      continue
    }
    const fields: Partial<Item> & { title: string } = { ...rest, title, status: status ?? 'inbox' }
    next = addItem(next, fields, now)
    const id = next.items[next.items.length - 1]!.id
    fresh.add(id)
    if (label) ids.set(label, id)
    if (status === 'building' && it.resume) ledgers.push({ id, item: it })
  }
  // The needs of the items added now, once every id is known: a queue label becomes the id it got, an unknown one goes into the note.
  const known = new Set(next.items.map(i => i.id))
  for (const it of items) {
    const target = (it.id !== undefined ? ids.get(it.id) : undefined) ?? next.items.find(i => i.title === it.title?.trim())?.id
    if (!target || !fresh.has(target) || !Array.isArray(it.needs) || !it.needs.length) continue
    const needs: string[] = []
    const unknown: string[] = []
    for (const n of it.needs) {
      const mapped = ids.get(String(n)) ?? (known.has(String(n)) ? String(n) : undefined)
      if (mapped && mapped !== target) needs.push(mapped)
      else if (!mapped) unknown.push(String(n))
    }
    const item = next.items.find(i => i.id === target)!
    const fields: Partial<Item> = { needs }
    if (unknown.length) fields.note = [item.note, `needs ${unknown.join(', ')}, not in the import`].filter(Boolean).join('; ')
    next = updateItem(next, target, fields, now)
  }
  for (const { id, item } of ledgers) {
    const file = relOf(found, places(found, 'file').ledger(id))
    const ledger: Ledger = {
      ...emptyLedger(id),
      ...(typeof item.branch === 'string' ? { branch: item.branch } : {}),
      ...(typeof item.plan === 'string' ? { plan: item.plan } : {}),
      ...(typeof item.ledger === 'string' ? { importedFrom: item.ledger } : {}),
      resume: { ...item.resume!, at: now },
    }
    await h.fs.write(p.ledger(id), serialize(ledger))
    next = updateItem(next, id, { ledger: file }, now)
  }
  // A spec stub for every item added now that lands inbox or building without one, so settle can make the
  // needs-free ones ready; an existing file at the stub's path is left alone.
  let stubs = 0
  for (const item of next.items) {
    if (!fresh.has(item.id) || (item.status !== 'inbox' && item.status !== 'building') || item.spec) continue
    const file = places(found, 'file').specRel(item.id)
    if (!(await h.fs.exists(p.spec(item.id)))) {
      await h.fs.write(p.spec(item.id), specStub(item.id, item.title, item.note, item.source))
      stubs += 1
    }
    next = updateItem(next, item.id, { spec: file }, now)
  }
  const written = await writeBacklog(h, found, next)
  const status = await statusNow(h, found, normalizeConfig(nextConfig).config, written.backlog, null)

  // The Historical line, once, on the old queue and ledger files.
  const { listing, increments } = await scanProject(h, found)
  // The old queue, the top-level ledger and its archive, and every nested progress.md and final review.
  const old = ['docs/backlog.md', 'docs/SLICES.md', ...listing.filter(f => /^\.superpowers\/sdd\/(?:.*\/)?(?:progress\.md|progress-archive\.md|final-review[^/]*\.md)$/.test(f))]
  let added = 0
  for (const f of old) {
    const text = await readText(h, `${found}/${f}`)
    if (text === null || HISTORICAL.test(text)) continue
    await h.fs.write(`${found}/${f}`, `${historicalLine(now.slice(0, 10))}\n\n${text}`)
    added += 1
  }
  const bulk = bulkToRemove(listing, incrementsOf(increments, next.items).merged)
  const lines = [status, `spec stubs written for ${stubs} item${stubs === 1 ? '' : 's'}`, `historical line added to ${added} file${added === 1 ? '' : 's'}`]
  if (bulk.count) lines.push(`bulk: ${bulk.count} files of merged increments to remove with git rm once the user confirms (kept with retain.superpowers):`, ...bulk.files)
  lines.push(commitLine(normalizeConfig(nextConfig).config.mainBranch))
  return lines.join('\n')
}

/** What a project on issues no longer needs, for the lead to remove with git rm once migrate-github has applied. */
export const FILE_RECORDS = ['docs/pipeline/backlog.json', 'docs/pipeline/BACKLOG.md', 'docs/pipeline/facts.md', 'docs/pipeline/specs', 'docs/pipeline/plans', 'docs/pipeline/ledgers']

/**
 * `migrate-github`: a file backlog moved onto GitHub issues. Without `apply`, the draft. With it: an issue per open
 * item (its spec as the spec comment, an active one labelled building and assigned), each active item's ledger, plan
 * and briefs copied to the places of queue: github under the issue's number, the facts copied, items.json written,
 * the config set to queue: github and .pipeline/ ignored. It deletes nothing. A failure stops it with what was made;
 * an item whose title already has a labelled open issue is not made again, so a second apply finishes the move.
 */
export async function migrateGithub(h: Host, found: string, c: Config | null, loaded: Backlog | null, error: string | null, e: ToolInput): Promise<string> {
  if (isGithub(c)) throw new Refused(`${CONFIG_FILE} already has queue: github; there is no file backlog to move`)
  if (error) throw new Refused(error)
  if (!loaded) throw new Refused(`no ${BACKLOG_FILE} to move`)
  const p = paths(found)
  const F = places(found, 'file')
  const P = places(found, 'github')
  const m = migrationOf(loaded)
  const specPath = (item: Item) => (item.spec ? `${found}/${slashes(item.spec).replace(/^\//, '')}` : p.spec(item.id))
  // An inbox item whose spec still has an open question: asked on its issue, so the issue waits as the item did.
  const questionOf = (item: Item, spec: string | null) => (item.status === 'inbox' && spec !== null && hasOpenQuestion(spec) ? openQuestionOf(spec) : '')
  if (!e.apply) {
    const create = []
    const questions: string[] = []
    for (const item of m.create) {
      const spec = await readText(h, specPath(item))
      create.push({ id: item.id, title: item.title, status: item.status, spec: spec !== null ? relOf(found, specPath(item)) : null })
      if (questionOf(item, spec)) questions.push(item.id)
    }
    return JSON.stringify({ create, active: m.active.map(i => i.id), questions, skipped: { merged: m.skipped.merged, parked: m.skipped.parked.map(i => ({ id: i.id, title: i.title })) }, remove: FILE_RECORDS }, null, 2)
  }

  const run = ghRun(h, found)
  const who = await tracker.me(run)
  if (!who.ok) throw new Refused(who.error)
  const me = who.value
  self.me = me
  const label = labelOf(c)
  const L = labelsOf(label)
  const labelled = await tracker.ensureLabels(run, [L.queue, L.building, L.blocked, L.needsInfo])
  if (!labelled.ok) throw new Refused(labelled.error)
  const listed = await tracker.list(run, label)
  if (!listed.ok) throw new Refused(listed.error)
  const extras = await extrasOrRefuse(h, found)

  const ids = new Map<string, string>()
  const bodies = new Map<string, string>()
  const lines: string[] = []
  const stop = (error: string) => new Refused([`migration stopped: ${error}`, ...lines, 'the issues above stay; apply again and it skips them'].join('\n'))
  for (const item of m.create) {
    const spec = await readText(h, specPath(item))
    const isActive = (ACTIVE_STATUSES as readonly string[]).includes(item.status)
    const isBlocked = item.status === 'blocked'
    const state = isActive || isBlocked ? item.status : 'ready'
    const detail = item.status === 'review' && item.pr ? `PR ${item.pr}` : isActive || isBlocked ? (item.note ?? '') : ''
    const question = questionOf(item, spec)
    const there = listed.value.find(i => i.title === item.title)
    let n: number
    if (there) {
      n = there.number
      bodies.set(item.id, there.body)
    } else {
      const body = issueBodyOf(spec, item.note, item.id)
      const made = await tracker.create(run, { title: item.title, body, labels: [label] })
      if (!made.ok) throw stop(made.error)
      n = made.value
      bodies.set(item.id, body)
    }
    ids.set(item.id, String(n))
    lines.push(`${item.id} → #${n}`)
    // An issue an earlier apply made gets what that apply did not get to.
    if (spec !== null && !(there && specCommentOf(there, me))) {
      const posted = await tracker.comment(run, n, renderSpecComment(spec, state, detail))
      if (!posted.ok) throw stop(posted.error)
    }
    if (question && !there?.comments.some(cm => cm.body.trimStart().startsWith(QUESTION_MARK) && isTrusted(cm, me))) {
      const asked = await tracker.comment(run, n, `${QUESTION_MARK}\n${question}`)
      if (!asked.ok) throw stop(asked.error)
    }
    const add = isActive ? L.building : isBlocked ? L.blocked : question ? L.needsInfo : ''
    if (add && !there?.labels.includes(add)) {
      const labelledNow = await tracker.edit(run, n, isActive ? { add: [add], assign: me } : { add: [add] })
      if (!labelledNow.ok) throw stop(labelledNow.error)
    }
  }

  // The dependencies, once every issue has its number: a `Needs:` line on each issue whose item waited for others that
  // became issues. A merged or parked item it needed has no issue and is left out.
  for (const item of m.create) {
    const needs = (item.needs ?? []).map(n => ids.get(n)).filter((n): n is string => n !== undefined)
    const body = bodies.get(item.id) ?? ''
    const next = withNeeds(body, needs)
    if (!needs.length || next === body) continue
    const set = await tracker.setBody(run, Number(ids.get(item.id)), next)
    if (!set.ok) throw stop(set.error)
  }

  // The records of the items in flight, under the issue's number; the branch and the worktree stay what they were.
  const items: Record<string, Partial<Item>> = { ...extras.items }
  for (const item of m.active) {
    const id = ids.get(item.id)!
    const kept: Partial<Item> = { status: item.status }
    for (const k of ['branch', 'pr', 'note', 'size'] as const) if (item[k] !== undefined && item[k] !== null && item[k] !== '') (kept as Record<string, unknown>)[k] = item[k]
    const from = item.ledger ? `${found}/${slashes(item.ledger).replace(/^\//, '')}` : F.ledger(item.id)
    const old = await loadJson<Ledger>(h, from, relOf(found, from))
    if (old.error) throw stop(old.error)
    if (old.value && typeof old.value === 'object' && !Array.isArray(old.value)) {
      const briefs = F.briefDir(item.id)
      const moved = JSON.parse(JSON.stringify(old.value).split(`"${briefs}/`).join(`"${P.briefDir(id)}/`)) as Ledger
      const planFrom = typeof old.value.plan === 'string' && old.value.plan ? old.value.plan : typeof item.plan === 'string' && item.plan ? item.plan : null
      const ledger: Ledger = { ...moved, item: id, ...(planFrom ? { plan: P.planRel(id) } : {}) }
      await h.fs.write(P.ledger(id), serialize(ledger))
      kept.ledger = relOf(found, P.ledger(id))
      if (planFrom) kept.plan = P.planRel(id)
      if (typeof ledger.worktree === 'string' && ledger.worktree) {
        const wt = worktreePath(found, ledger)
        const plan = planFrom ? await readItemFile(h, found, wt, planFrom) : null
        if (plan !== null) await h.fs.write(`${wt}/${P.planRel(id)}`, plan)
        let dir = `${wt}/${briefs}`
        let names = (await listDir(h, dir)).filter(n => !n.endsWith('/'))
        if (!names.length && wt !== found) {
          dir = `${found}/${briefs}`
          names = (await listDir(h, dir)).filter(n => !n.endsWith('/'))
        }
        for (const name of names) {
          const text = await readText(h, `${dir}/${name}`)
          if (text !== null) await h.fs.write(`${wt}/${P.briefDir(id)}/${name}`, text)
        }
      }
    } else if (!(await h.fs.exists(P.ledger(id)))) {
      // No ledger to carry: a fresh one with the branch and PR, so this machine's begin knows the item as its own.
      const fresh: Ledger = { ...emptyLedger(id), ...(typeof item.branch === 'string' && item.branch ? { branch: item.branch } : {}), ...(typeof item.pr === 'string' && item.pr ? { pr: item.pr } : {}) }
      await h.fs.write(P.ledger(id), serialize(fresh))
      kept.ledger = relOf(found, P.ledger(id))
    } else {
      kept.ledger = relOf(found, P.ledger(id))
    }
    items[id] = kept
  }
  const facts = await readText(h, F.facts)
  if (facts !== null) await h.fs.write(P.facts, facts)
  await writeExtras(h, found, { ...extras, items })

  // The config on disk with queue: github, every other key as the user left it.
  const onDisk = await loadJson<Record<string, unknown>>(h, p.config, CONFIG_FILE)
  if (onDisk.error) throw stop(onDisk.error)
  const nextConfig = { ...(onDisk.value ?? structuredClone(DEFAULTS)), queue: 'github' }
  await h.fs.write(p.config, serialize(nextConfig))
  const normal = normalizeConfig(nextConfig).config
  await update(h, config, () => normal)
  await ensureExclude(h, found)
  await update(h, fileError, () => null)
  await loadBacklog(h, found)

  const parked = m.skipped.parked.map(i => i.id)
  return [
    ...lines,
    parked.length ? `parked, not moved (file them by hand when wanted): ${parked.join(', ')}` : 'parked: none',
    `remove with git rm -r --ignore-unmatch and commit with ${CONFIG_FILE} on ${normal.mainBranch}:`,
    ...FILE_RECORDS,
  ].join('\n')
}
