/**
 * AI Star Radar — Host half.
 *
 * Watches GitHub for AI open-source projects and keeps a live radar that answers
 * two separate questions:
 *
 * - how big is a project (stars over `threshold`), and
 * - how fast is it moving (stars gained over the last 24 h), and
 * - what was published recently (repositories created inside `recentDays`).
 *
 * Star history is sampled on every scan and kept for three days, so growth is
 * measured rather than guessed. The radar, its history and its read flags are
 * written to `<DSH_HOME>/ai-star-radar/history.json`, so a restart does not wipe
 * the trend lines.
 *
 * - `github_ai_star_radar` — the model-facing Tool.
 * - `GET /x-github-ai-star-radar/state` — the JSON snapshot the Client half polls.
 *
 * Everything tunable comes from the row's `config` in `cordis.patch.yml`.
 */

/** Loader row name. */
export const name = 'ai-star-radar'

/** Hard dependency: the model-facing tool needs the tool registry at apply time. */
export const inject = ['tools']

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** One day in milliseconds. */
const DAY_MS = 86_400_000

/** One hour in milliseconds. */
const HOUR_MS = 3_600_000

/** Route the Client half reads; same origin as the served page. */
const STATE_PATH = '/x-github-ai-star-radar/state'

/** Shortest gap between two GitHub scans, so a refresh burst cannot burn the quota. */
const MIN_SCAN_GAP_MS = 12_000

/** Hard cap on one scan, so one slow query cannot pin the radar forever. */
const SCAN_BUDGET_MS = 90_000

/** How much star history is kept per repository. */
const HISTORY_MS = 3 * DAY_MS

/** Two samples closer together than this are merged unless the count moved. */
const SAMPLE_GAP_MS = 10 * 60_000

/** A repository unseen for this long leaves the radar. */
const STALE_MS = 7 * DAY_MS

/** Snapshot schema marker: 2 adds growth, recency and persistence. */
const SCHEMA_VERSION = 2

/** Persisted store layout version. */
const STORE_VERSION = 1

/** Defaults for every config field. */
const DEFAULTS = Object.freeze({
  threshold: 3000,
  queries: Object.freeze(['topic:ai', 'topic:llm', 'topic:agents']),
  windowDays: 0,
  recentDays: 30,
  recentMinStars: 100,
  pollMinutes: 30,
  maxItems: 40,
  starJump: 0,
  token: '',
  scanOnStart: true,
  requestTimeoutMs: 20_000,
})

/** Read a finite number out of config, clamped into range. */
function readNumber(value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.round(parsed)))
}

/** Normalize the row config into the shape this plugin actually uses. */
function resolveConfig(input) {
  const raw = input !== null && typeof input === 'object' ? input : {}
  const queries = Array.isArray(raw.queries)
    ? raw.queries
      .filter((query) => typeof query === 'string')
      .map((query) => query.trim())
      .filter((query) => query !== '')
    : []
  return {
    threshold: readNumber(raw.threshold, DEFAULTS.threshold, 1, 5_000_000),
    queries: queries.length > 0 ? queries.slice(0, 8) : [...DEFAULTS.queries],
    windowDays: readNumber(raw.windowDays, DEFAULTS.windowDays, 0, 3650),
    recentDays: readNumber(raw.recentDays, DEFAULTS.recentDays, 0, 3650),
    recentMinStars: readNumber(raw.recentMinStars, DEFAULTS.recentMinStars, 0, 5_000_000),
    pollMinutes: readNumber(raw.pollMinutes, DEFAULTS.pollMinutes, 0, 1440),
    maxItems: readNumber(raw.maxItems, DEFAULTS.maxItems, 5, 100),
    starJump: readNumber(raw.starJump, DEFAULTS.starJump, 0, 5_000_000),
    token: typeof raw.token === 'string' ? raw.token.trim() : '',
    scanOnStart: raw.scanOnStart !== false,
    requestTimeoutMs: readNumber(raw.requestTimeoutMs, DEFAULTS.requestTimeoutMs, 5_000, 120_000),
  }
}

/** Message of a thrown value. */
function describeError(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/** `12345` -> `12.3k`; small counts stay verbatim. */
function formatStars(value) {
  if (value >= 1000) {
    const thousands = value / 1000
    return `${thousands >= 100 ? Math.round(thousands) : Math.round(thousands * 10) / 10}k`
  }
  return String(value)
}

/** ISO day (`YYYY-MM-DD`) for a point `days` back from now. */
function isoDay(days) {
  return new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10)
}

/** JSON response helper. */
function sendJson(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  response.end(body)
}

/** Message-facing arguments schema of `github_ai_star_radar`. */
const TOOL_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ['status', 'list', 'trending', 'new', 'scan', 'dismiss'],
      description:
        'status = counts and last scan only; list = the whole radar; trending = fastest star growth first; ' +
        'new = repositories created inside the recent window; scan = run a fresh GitHub scan now; ' +
        'dismiss = mark every new item as read.',
    },
    limit: {
      type: 'integer',
      description: 'How many items to return (1-50, default 10).',
    },
  },
}

/** One radar item in the tool result. */
const TOOL_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    fullName: { type: 'string' },
    url: { type: 'string' },
    stars: { type: 'integer' },
    growth: { type: 'integer' },
    growthHours: { type: 'integer' },
    language: { type: 'string' },
    description: { type: 'string' },
    isNew: { type: 'boolean' },
    isRecent: { type: 'boolean' },
    ageDays: { type: 'integer' },
  },
  required: [
    'fullName',
    'url',
    'stars',
    'growth',
    'growthHours',
    'language',
    'description',
    'isNew',
    'isRecent',
    'ageDays',
  ],
}

/** Tool result schema. */
const TOOL_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    message: { type: 'string' },
    threshold: { type: 'integer' },
    recentDays: { type: 'integer' },
    unread: { type: 'integer' },
    total: { type: 'integer' },
    scanning: { type: 'boolean' },
    lastScanAt: { type: 'string' },
    lastError: { type: 'string' },
    items: { type: 'array', items: TOOL_ITEM_SCHEMA },
  },
  required: [
    'ok',
    'message',
    'threshold',
    'recentDays',
    'unread',
    'total',
    'scanning',
    'lastScanAt',
    'lastError',
    'items',
  ],
}

/** Activate the radar: history, polling, the state route, and the tool. */
export function apply(ctx, config) {
  const settings = resolveConfig(config)

  /** fullName -> radar item. */
  const items = new Map()
  /** fullName -> ascending [timestamp, stars] samples. */
  const history = new Map()
  /** Runtime facts about the scanner itself. */
  const status = {
    scanning: false,
    lastScanAt: null,
    lastError: null,
    scans: 0,
    rate: null,
    currentQuery: null,
    generation: 0,
  }

  // ── persistence ──────────────────────────────────────────────────────────
  const store = createStore()

  function createStore() {
    try {
      // The Host process owns DSH_HOME; a missing path just disables persistence.
      const home = typeof process !== 'undefined' ? process.env?.DSH_HOME : undefined
      if (typeof home === 'string' && home !== '') {
        return { target: join(home, 'ai-star-radar', 'history.json') }
      }
    } catch {
      // fall through: persistence disabled
    }
    return { target: null }
  }

  /** Restore the radar, its history and its read flags from disk. */
  function restore() {
    if (store.target === null) return
    let parsed
    try {
      parsed = JSON.parse(readFileSync(store.target, 'utf8'))
    } catch {
      return
    }
    if (parsed === null || typeof parsed !== 'object') return
    if (parsed.version !== STORE_VERSION) return
    const now = Date.now()
    if (Array.isArray(parsed.items)) {
      for (const raw of parsed.items) {
        if (raw === null || typeof raw !== 'object') continue
        if (typeof raw.fullName !== 'string' || typeof raw.url !== 'string') continue
        if (!Number.isFinite(raw.stars)) continue
        const item = {
          fullName: raw.fullName,
          url: raw.url,
          description: typeof raw.description === 'string' ? raw.description : '',
          stars: Math.round(raw.stars),
          language: typeof raw.language === 'string' ? raw.language : '',
          topics: Array.isArray(raw.topics) ? raw.topics.filter((topic) => typeof topic === 'string').slice(0, 4) : [],
          createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
          pushedAt: typeof raw.pushedAt === 'string' ? raw.pushedAt : '',
          firstSeenAt: Number.isFinite(raw.firstSeenAt) ? raw.firstSeenAt : now,
          lastSeenAt: Number.isFinite(raw.lastSeenAt) ? raw.lastSeenAt : now,
          previousStars: Number.isFinite(raw.previousStars) ? raw.previousStars : null,
          alertedAt: Number.isFinite(raw.alertedAt) ? raw.alertedAt : null,
          unread: raw.unread === true,
          generation: 0,
        }
        if (now - item.lastSeenAt > STALE_MS) continue
        items.set(item.fullName, item)
      }
    }
    if (parsed.history !== null && typeof parsed.history === 'object') {
      for (const [fullName, samples] of Object.entries(parsed.history)) {
        if (!Array.isArray(samples)) continue
        const clean = samples
          .filter((sample) => Array.isArray(sample) && sample.length === 2 && Number.isFinite(sample[0]) && Number.isFinite(sample[1]))
          .map(([time, stars]) => [Math.round(time), Math.round(stars)])
          .filter(([time]) => now - time <= HISTORY_MS)
          .sort((left, right) => left[0] - right[0])
        if (clean.length > 0) history.set(fullName, clean)
      }
    }
    if (Number.isFinite(parsed.lastScanAt)) status.lastScanAt = parsed.lastScanAt
  }

  /** Write the radar, its history and its read flags back to disk. */
  function persist() {
    if (store.target === null) return
    try {
      const payload = {
        version: STORE_VERSION,
        savedAt: Date.now(),
        lastScanAt: status.lastScanAt,
        items: [...items.values()].map((item) => ({
          fullName: item.fullName,
          url: item.url,
          description: item.description,
          stars: item.stars,
          language: item.language,
          topics: item.topics,
          createdAt: item.createdAt,
          pushedAt: item.pushedAt,
          firstSeenAt: item.firstSeenAt,
          lastSeenAt: item.lastSeenAt,
          previousStars: item.previousStars,
          alertedAt: item.alertedAt,
          unread: item.unread,
        })),
        history: Object.fromEntries(history),
      }
      const temporary = `${store.target}.tmp`
      mkdirSync(dirname(store.target), { recursive: true })
      writeFileSync(temporary, JSON.stringify(payload))
      renameSync(temporary, store.target)
    } catch (error) {
      status.lastError = `保存历史失败：${describeError(error)}`
    }
  }

  restore()
  ctx.effect(() => () => persist(), 'ai-radar: persist on unload')

  // ── GitHub ───────────────────────────────────────────────────────────────
  /** Call the GitHub search API once and return its raw repositories. */
  async function searchGitHub(terms) {
    const url = new URL('https://api.github.com/search/repositories')
    url.searchParams.set('q', terms)
    url.searchParams.set('sort', 'stars')
    url.searchParams.set('order', 'desc')
    url.searchParams.set('per_page', String(Math.min(100, Math.max(20, settings.maxItems))))
    const headers = {
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-ai-star-radar',
      'x-github-api-version': '2022-11-28',
    }
    if (settings.token !== '') headers.authorization = `Bearer ${settings.token}`
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(settings.requestTimeoutMs),
    })
    const remaining = Number(response.headers.get('x-ratelimit-remaining'))
    const reset = Number(response.headers.get('x-ratelimit-reset'))
    if (Number.isFinite(remaining) && Number.isFinite(reset)) {
      status.rate = { remaining, resetAt: reset * 1000 }
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      const tail = detail === '' ? '' : `: ${detail.slice(0, 180)}`
      throw new Error(`GitHub search ${response.status}${tail}`)
    }
    const body = await response.json()
    return Array.isArray(body?.items) ? body.items : []
  }

  /** The searches one scan runs: the established list plus the recent-arrivals list. */
  function planSearches() {
    const plan = []
    for (const query of settings.queries) {
      const established = [query, `stars:>=${settings.threshold}`]
      if (settings.windowDays > 0) established.push(`pushed:>=${isoDay(settings.windowDays)}`)
      plan.push({ label: query, terms: established.join(' '), floor: settings.threshold })
      if (settings.recentDays > 0) {
        plan.push({
          label: `${query} (new)`,
          terms: `${query} created:>=${isoDay(settings.recentDays)} stars:>=${settings.recentMinStars}`,
          floor: settings.recentMinStars,
        })
      }
    }
    return plan
  }

  // ── radar state ──────────────────────────────────────────────────────────
  /** Build a radar item out of one search hit. */
  function toItem(repo, now, floor) {
    return {
      fullName: typeof repo.full_name === 'string' ? repo.full_name : '',
      url: typeof repo.html_url === 'string' ? repo.html_url : '',
      description: typeof repo.description === 'string' ? repo.description : '',
      stars: Number(repo.stargazers_count) || 0,
      language: typeof repo.language === 'string' ? repo.language : '',
      topics: Array.isArray(repo.topics) ? repo.topics.slice(0, 4).map(String) : [],
      createdAt: typeof repo.created_at === 'string' ? repo.created_at : '',
      pushedAt: typeof repo.pushed_at === 'string' ? repo.pushed_at : '',
      firstSeenAt: now,
      lastSeenAt: now,
      previousStars: null,
      alertedAt: null,
      unread: false,
      floor,
      generation: 0,
    }
  }

  /** Append one star sample, keeping the window bounded. */
  function recordSample(fullName, now, stars) {
    let samples = history.get(fullName)
    if (samples === undefined) {
      samples = []
      history.set(fullName, samples)
    }
    const last = samples[samples.length - 1]
    if (last !== undefined && now - last[0] < SAMPLE_GAP_MS && last[1] === stars) return
    samples.push([now, stars])
    while (samples.length > 2 && now - samples[0][0] > HISTORY_MS) samples.shift()
    if (samples.length > 400) samples.splice(0, samples.length - 400)
  }

  /** Merge one search hit into the radar, flagging new arrivals and star jumps. */
  function merge(repo, now, generation, floor) {
    const next = toItem(repo, now, floor)
    if (next.fullName === '' || next.url === '') return 0
    if (next.stars < floor) return 0
    next.generation = generation
    const previous = items.get(next.fullName)
    if (previous === undefined) {
      next.unread = true
      next.alertedAt = now
      items.set(next.fullName, next)
      recordSample(next.fullName, now, next.stars)
      return 1
    }
    next.firstSeenAt = previous.firstSeenAt
    next.unread = previous.unread
    next.alertedAt = previous.alertedAt
    next.lastSeenAt = now
    if (previous.generation === generation) {
      // A later query of the same scan: keep the largest count and the original baseline.
      next.stars = Math.max(previous.stars, next.stars)
      next.previousStars = previous.previousStars
      items.set(next.fullName, next)
      recordSample(next.fullName, now, next.stars)
      return 0
    }
    next.previousStars = previous.stars
    const gained = next.stars - previous.stars
    recordSample(next.fullName, now, next.stars)
    if (settings.starJump > 0 && gained >= settings.starJump) {
      next.unread = true
      next.alertedAt = now
      items.set(next.fullName, next)
      return 1
    }
    items.set(next.fullName, next)
    return 0
  }

  /** Growth over the last day, or over the whole history while it is younger. */
  function growthOf(fullName, now, stars) {
    const samples = history.get(fullName)
    if (samples === undefined || samples.length < 2) return { delta: 0, hours: 0 }
    const cutoff = now - DAY_MS
    let baseline = samples[0]
    for (const sample of samples) {
      if (sample[0] <= cutoff) baseline = sample
      else break
    }
    const newest = samples[samples.length - 1]
    if (newest === undefined || baseline === newest) return { delta: 0, hours: 0 }
    const hours = Math.round((now - baseline[0]) / HOUR_MS)
    if (hours < 1) return { delta: 0, hours: 0 }
    return { delta: stars - baseline[1], hours }
  }

  /** Age in days of a repository, or -1 when GitHub returned no date. */
  function ageDaysOf(item, now) {
    const created = Date.parse(item.createdAt)
    if (!Number.isFinite(created)) return -1
    return Math.max(0, Math.floor((now - created) / DAY_MS))
  }

  /** Whether the repository was published inside the recent window. */
  function isRecentItem(item, now) {
    if (settings.recentDays <= 0) return false
    const age = ageDaysOf(item, now)
    return age >= 0 && age <= settings.recentDays
  }

  /** Copy of an item with the derived fields the UI and the tool read. */
  function viewOf(item, now) {
    const growth = growthOf(item.fullName, now, item.stars)
    return {
      fullName: item.fullName,
      url: item.url,
      description: item.description,
      stars: item.stars,
      language: item.language,
      topics: item.topics,
      createdAt: item.createdAt,
      pushedAt: item.pushedAt,
      firstSeenAt: item.firstSeenAt,
      lastSeenAt: item.lastSeenAt,
      alertedAt: item.alertedAt,
      unread: item.unread,
      growth: growth.delta,
      growthHours: growth.hours,
      ageDays: ageDaysOf(item, now),
      isRecent: isRecentItem(item, now),
    }
  }

  /** Drop stale and surplus rows, keeping recent arrivals first. */
  function trim(now) {
    for (const [fullName, item] of items) {
      if (now - item.lastSeenAt > STALE_MS) {
        items.delete(fullName)
        history.delete(fullName)
      }
    }
    const ceiling = Math.max(settings.maxItems * 4, 40)
    if (items.size <= ceiling) return
    const ranked = [...items.values()].sort((left, right) => {
      const leftRecent = isRecentItem(left, now) ? 1 : 0
      const rightRecent = isRecentItem(right, now) ? 1 : 0
      if (leftRecent !== rightRecent) return rightRecent - leftRecent
      return right.stars - left.stars
    })
    for (const item of ranked.slice(ceiling)) {
      items.delete(item.fullName)
      history.delete(item.fullName)
    }
  }

  /** Run one scan across every configured search. */
  async function scan() {
    if (status.scanning) return snapshot()
    status.scanning = true
    const startedAt = Date.now()
    const errors = []
    const generation = status.generation + 1
    status.generation = generation
    try {
      for (const search of planSearches()) {
        if (Date.now() - startedAt > SCAN_BUDGET_MS) {
          errors.push('scan budget exhausted')
          break
        }
        status.currentQuery = search.label
        try {
          const repos = await searchGitHub(search.terms)
          for (const repo of repos) merge(repo, Date.now(), generation, search.floor)
        } catch (error) {
          errors.push(describeError(error))
        }
      }
      trim(Date.now())
    } finally {
      status.currentQuery = null
      status.scanning = false
      status.lastScanAt = Date.now()
      status.scans += 1
      status.lastError = errors.length === 0 ? null : errors.join('; ')
      persist()
    }
    return snapshot()
  }

  /** A scan is skipped while one already runs, or right after a manual one. */
  function requestScan() {
    if (status.scanning) return Promise.resolve(snapshot())
    if (status.lastScanAt !== null && Date.now() - status.lastScanAt < MIN_SCAN_GAP_MS) {
      return Promise.resolve(snapshot())
    }
    return scan()
  }

  /** Mark every flagged item as read. */
  function markAllRead() {
    let changed = false
    for (const item of items.values()) {
      if (item.unread) {
        item.unread = false
        changed = true
      }
    }
    if (changed) persist()
  }

  /** Every item as a sorted view: fastest growth first, then absolute stars. */
  function sortedViews() {
    const now = Date.now()
    const views = [...items.values()].map((item) => viewOf(item, now))
    views.sort((left, right) => {
      if (right.growth !== left.growth) return right.growth - left.growth
      if (right.stars !== left.stars) return right.stars - left.stars
      return left.fullName.localeCompare(right.fullName)
    })
    return views
  }

  /** Immutable view of the radar, shared by the route and the tool. */
  function snapshot() {
    const views = sortedViews()
    const unread = views.reduce((sum, item) => (item.unread ? sum + 1 : sum), 0)
    const recent = views.reduce((sum, item) => (item.isRecent ? sum + 1 : sum), 0)
    const gaining = views.reduce((sum, item) => (item.growth > 0 ? sum + 1 : sum), 0)
    const recentViews = views
      .filter((item) => item.isRecent)
      .sort((left, right) => right.stars - left.stars || right.growth - left.growth)
      .slice(0, settings.maxItems)
    return {
      schemaVersion: SCHEMA_VERSION,
      threshold: settings.threshold,
      queries: [...settings.queries],
      windowDays: settings.windowDays,
      recentDays: settings.recentDays,
      recentMinStars: settings.recentMinStars,
      pollMinutes: settings.pollMinutes,
      starJump: settings.starJump,
      scanning: status.scanning,
      currentQuery: status.currentQuery,
      lastScanAt: status.lastScanAt,
      lastError: status.lastError,
      scans: status.scans,
      rate: status.rate,
      unread,
      total: views.length,
      recent,
      gaining,
      historySince: oldestSample(),
      updatedAt: Date.now(),
      items: views.slice(0, settings.maxItems),
      recentItems: recentViews,
    }
  }

  /** Oldest sample timestamp across the radar, for "trend since" copy. */
  function oldestSample() {
    let oldest = null
    for (const samples of history.values()) {
      const first = samples[0]
      if (first === undefined) continue
      if (oldest === null || first[0] < oldest) oldest = first[0]
    }
    return oldest
  }

  /** Build the schema-valid tool result for one action. */
  function toolResult(action, limit, message) {
    const view = snapshot()
    const all = action === 'status' ? [] : sortedViews()
    let rows = all
    if (action === 'trending') rows = all.filter((item) => item.growth > 0)
    if (action === 'new') rows = all.filter((item) => item.isRecent)
    return {
      ok: true,
      message,
      threshold: view.threshold,
      recentDays: view.recentDays,
      unread: view.unread,
      total: view.total,
      scanning: view.scanning,
      lastScanAt: view.lastScanAt === null ? '' : new Date(view.lastScanAt).toISOString(),
      lastError: view.lastError === null ? '' : view.lastError,
      items: rows.slice(0, limit).map((item) => ({
        fullName: item.fullName,
        url: item.url,
        stars: item.stars,
        growth: item.growth,
        growthHours: item.growthHours,
        language: item.language,
        description: item.description,
        isNew: item.unread,
        isRecent: item.isRecent,
        ageDays: item.ageDays < 0 ? 0 : item.ageDays,
      })),
    }
  }

  /** Render the tool result as the text the model reads back. */
  function renderToolResult(_args, value) {
    const lines = [value.message]
    if (value.lastError !== '') lines.push(`最近一次错误：${value.lastError}`)
    if (value.items.length === 0) lines.push('（暂时没有符合条件的项目）')
    for (const item of value.items) {
      const growth = item.growth > 0
        ? `，${item.growthHours >= 20 ? '24 小时' : `${item.growthHours} 小时`} +${formatStars(item.growth)}`
        : ''
      const fresh = item.isRecent ? `，${item.ageDays} 天前创建` : ''
      const mark = item.isNew ? '【新】' : ''
      lines.push(`- ${mark}${item.fullName} — ★${formatStars(item.stars)}${growth}${fresh}`)
      if (item.description !== '') lines.push(`  ${item.description}`)
      lines.push(`  ${item.url}`)
    }
    return [{ type: 'text', text: lines.join('\n') }]
  }

  // ── the model-facing tool ────────────────────────────────────────────────
  ctx.effect(() => ctx.tools.register({
    name: 'github_ai_star_radar',
    description:
      'Read the GitHub AI star radar: open-source AI projects over the configured star threshold ' +
      `(${settings.threshold} stars), plus repositories created in the last ${settings.recentDays} days ` +
      `(at least ${settings.recentMinStars} stars). Every project carries a measured star-growth figure for the ` +
      'last 24 hours, so this answers "what is rising now?" and "what was published recently?" without a web search. ' +
      'Actions: status (counts only), list (whole radar), trending (fastest growth first), new (recently created), ' +
      'scan (refresh from GitHub now), dismiss (mark everything read).',
    parameters: TOOL_PARAMETERS,
    output: { schema: TOOL_OUTPUT_SCHEMA, render: renderToolResult },
    presentCall: (args) => ({
      card: 'generic',
      title: 'AI 星标雷达',
      kind: 'other',
      rawInput: args,
    }),
    async execute(args) {
      const action = typeof args?.action === 'string' ? args.action : 'list'
      const limit = Math.min(50, Math.max(1, Number(args?.limit) || 10))
      if (action === 'scan') {
        const before = status.lastScanAt
        const view = await requestScan()
        const scanned = status.lastScanAt !== before
        const head = scanned
          ? `已扫描 GitHub：共 ${view.total} 个项目，其中 ${view.recent} 个是最近 ${view.recentDays} 天内创建的，${view.gaining} 个在涨，${view.unread} 个新项目。`
          : `刚刚扫描过，没有重复请求 GitHub：共 ${view.total} 个项目，${view.unread} 个新项目。`
        return toolResult('scan', limit, head)
      }
      if (action === 'dismiss') {
        markAllRead()
        return toolResult('status', limit, '已把雷达里的新项目全部标为已读。')
      }
      if (action === 'status') {
        const view = snapshot()
        const when = view.lastScanAt === null ? '尚未扫描' : new Date(view.lastScanAt).toLocaleString()
        return toolResult(
          'status',
          limit,
          `雷达共 ${view.total} 个项目（阈值 ${view.threshold} 星标，最近 ${view.recentDays} 天新项目下限 ${view.recentMinStars} 星标）：` +
            `${view.recent} 个新上线、${view.gaining} 个在涨、${view.unread} 个未读；上次扫描 ${when}。`,
        )
      }
      if (action === 'trending') {
        const view = snapshot()
        return toolResult(
          'trending',
          limit,
          `按最近 24 小时星标增量排序（统计窗口最长 24 小时，越早开始监控越准）：共 ${view.gaining} 个在涨。`,
        )
      }
      if (action === 'new') {
        const view = snapshot()
        return toolResult(
          'new',
          limit,
          `最近 ${view.recentDays} 天内创建、且至少 ${view.recentMinStars} 星标的项目：共 ${view.recent} 个。`,
        )
      }
      const view = snapshot()
      return toolResult(
        'list',
        limit,
        `雷达共 ${view.total} 个项目，${view.recent} 个新上线，${view.gaining} 个在涨，${view.unread} 个新项目。`,
      )
    },
  }), 'ai-radar: tool')

  // ── the Client half's data route ─────────────────────────────────────────
  ctx.inject(['webServer'], (child) => {
    child.effect(() => child.webServer.register({
      kind: 'exact',
      path: STATE_PATH,
      async handler(request, response) {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          sendJson(response, 405, { error: 'GET only' })
          return
        }
        let search
        try {
          search = new URL(request.url ?? STATE_PATH, 'http://127.0.0.1').searchParams
        } catch {
          search = new URLSearchParams()
        }
        try {
          if (search.get('scan') === '1') await requestScan()
          if (search.get('read') === '1') markAllRead()
          sendJson(response, 200, snapshot())
        } catch (error) {
          sendJson(response, 200, { ...snapshot(), lastError: describeError(error) })
        }
      },
    }), 'ai-radar: state route')
  })

  // ── timers (plain timers owned by this context's effects) ────────────────
  const runScan = () => {
    scan().catch((error) => {
      status.lastError = describeError(error)
    })
  }
  if (settings.scanOnStart) {
    ctx.effect(() => {
      const timer = setTimeout(runScan, 2_000)
      return () => clearTimeout(timer)
    }, 'ai-radar: first scan')
  }
  if (settings.pollMinutes > 0) {
    ctx.effect(() => {
      const timer = setInterval(runScan, settings.pollMinutes * 60_000)
      return () => clearInterval(timer)
    }, 'ai-radar: poll')
  }
}
