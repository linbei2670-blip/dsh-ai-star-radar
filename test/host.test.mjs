/**
 * Host-half tests: a fake Cordis context, a stubbed GitHub Search API, a
 * controllable clock and a temporary DSH_HOME. No dependencies, no network.
 *
 * Run with `npm test`.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../index.js'

const HOUR = 3_600_000
const DAY = 86_400_000

/** Minimum shape of one item in any tool result. */
const ITEM_KEYS = [
  'ageDays',
  'description',
  'fullName',
  'growth',
  'growthHours',
  'isNew',
  'isRecent',
  'language',
  'stars',
  'url',
]

/** A context shaped like the subset of Cordis this plugin touches. */
function createContext() {
  const tools = []
  const routes = []
  const child = {
    effect(callback) {
      callback()
      return () => {}
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
  }
  const ctx = {
    effect(callback) {
      callback()
      return () => {}
    },
    on() {
      return () => {}
    },
    inject(names, callback) {
      assert.deepEqual(names, ['webServer'])
      callback(child)
    },
    tools: {
      register(definition) {
        tools.push(definition)
        return () => {}
      },
    },
  }
  return { ctx, tools, routes }
}

/** Drive one route handler against a fake node request/response pair. */
function request(route, url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const response = {
      writeHead(status) {
        this.status = status
      },
      end(body) {
        resolve({ status: this.status, body: JSON.parse(body) })
      },
    }
    Promise.resolve(route.handler({ method, url }, response)).catch(reject)
  })
}

/** A stubbed GitHub search: two repositories, one young, one old. */
function stubGitHub({ stages, createdHot, createdOld }) {
  const issued = []
  let stage = 0
  globalThis.fetch = async (url) => {
    const target = String(url)
    assert.ok(target.startsWith('https://api.github.com/search/repositories'), `unexpected fetch ${target}`)
    const query = new URL(target).searchParams.get('q') ?? ''
    issued.push(query)
    const stars = stages[Math.min(stage, stages.length - 1)]
    const established = !query.includes('created:>=')
    const rows = established
      ? [
          { name: 'acme/hot', stars, created: createdHot },
          { name: 'acme/old', stars: 4000, created: createdOld },
        ]
      : [{ name: 'acme/hot', stars, created: createdHot }]
    return {
      ok: true,
      status: 200,
      headers: {
        get: (name) => (name === 'x-ratelimit-remaining' ? '9' : name === 'x-ratelimit-reset' ? '1800000000' : null),
      },
      async json() {
        return {
          total_count: rows.length,
          items: rows.map(({ name, stars: count, created }) => ({
            full_name: name,
            html_url: `https://github.com/${name}`,
            description: `${name} summary`,
            stargazers_count: count,
            language: 'Python',
            topics: ['ai', 'llm', 'agents', 'extra'],
            created_at: created,
            pushed_at: created,
          })),
        }
      },
      async text() {
        return ''
      },
    }
  }
  return {
    issued,
    next() {
      stage += 1
    },
  }
}

test('measures 24h growth, tracks new arrivals, and survives a restart', async (t) => {
  const previousHome = process.env.DSH_HOME
  const home = mkdtempSync(join(tmpdir(), 'ai-star-radar-test-'))
  process.env.DSH_HOME = home

  const realNow = Date.now
  const start = realNow()
  let clock = start
  Date.now = () => clock

  const createdHot = new Date(start - DAY).toISOString()
  const createdOld = new Date(start - 400 * DAY).toISOString()
  const github = stubGitHub({ stages: [1000, 1300, 1800], createdHot, createdOld })

  t.after(() => {
    Date.now = realNow
    rmSync(home, { recursive: true, force: true })
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })

  const config = {
    threshold: 100,
    queries: ['topic:ai'],
    recentDays: 30,
    recentMinStars: 10,
    pollMinutes: 0,
    maxItems: 10,
    scanOnStart: false,
  }

  // ── activation ─────────────────────────────────────────────────────────
  const first = createContext()
  apply(first.ctx, config)

  assert.equal(first.tools.length, 1, 'exactly one tool is registered')
  const tool = first.tools[0]
  assert.equal(tool.name, 'github_ai_star_radar')
  assert.equal(typeof tool.execute, 'function')
  assert.equal(typeof tool.output.render, 'function')
  assert.equal(tool.parameters.type, 'object')
  assert.equal(first.routes.length, 1, 'exactly one HTTP route is registered')
  const route = first.routes[0]
  assert.equal(route.path, '/x-github-ai-star-radar/state')

  // ── first scan establishes the radar ──────────────────────────────────
  const scan1 = await request(route, '/x-github-ai-star-radar/state?scan=1')
  assert.equal(scan1.status, 200)
  assert.equal(scan1.body.schemaVersion, 2)
  assert.equal(scan1.body.total, 2)
  assert.equal(scan1.body.unread, 2)
  assert.ok(github.issued.some((q) => /created:>=\d{4}-\d{2}-\d{2}/.test(q)), 'recent-arrivals search was issued')
  assert.ok(github.issued.every((q) => q.includes('topic:ai')), 'every search carries the configured query')

  // ── growth over a window younger than a day ───────────────────────────
  clock += 2 * HOUR
  github.next()
  const scan2 = await request(route, '/x-github-ai-star-radar/state?scan=1')
  const hot2 = scan2.body.items.find((item) => item.fullName === 'acme/hot')
  assert.equal(hot2.growth, 300)
  assert.equal(hot2.growthHours, 2)
  assert.equal(scan2.body.unread, 2, 'a rescan does not re-flag known projects')

  // ── the 24-hour window must bind, not the whole history ───────────────
  clock += 24 * HOUR
  github.next()
  const scan3 = await request(route, '/x-github-ai-star-radar/state?scan=1')
  const hot3 = scan3.body.items.find((item) => item.fullName === 'acme/hot')
  assert.equal(hot3.growth, 500, 'growth = 1800 - 1300, not 1800 - 1000')
  assert.equal(hot3.growthHours, 24)
  assert.equal(scan3.body.items[0].fullName, 'acme/hot', 'sorted by growth first')
  assert.equal(scan3.body.items.find((item) => item.fullName === 'acme/old').isRecent, false)
  assert.equal(hot3.ageDays, 2, 'age is derived from created_at')
  assert.deepEqual(
    scan3.body.recentItems.map((item) => item.fullName),
    ['acme/hot'],
    'the recent list holds only newly created projects',
  )

  // ── tool actions ──────────────────────────────────────────────────────
  for (const action of ['status', 'list', 'trending', 'new', 'scan', 'dismiss']) {
    const value = await tool.execute({ action, limit: 5 }, {})
    assert.equal(value.ok, true, `${action} reports ok`)
    assert.equal(typeof value.message, 'string')
    assert.equal(value.threshold, 100)
    assert.equal(value.recentDays, 30)
    assert.ok(Array.isArray(value.items), `${action} returns items`)
    for (const item of value.items) assert.deepEqual(Object.keys(item).sort(), ITEM_KEYS, `${action} item shape`)
  }

  const trending = await tool.execute({ action: 'trending', limit: 5 }, {})
  assert.equal(trending.items[0].fullName, 'acme/hot')
  assert.equal(trending.items[0].growth, 500)
  const fresh = await tool.execute({ action: 'new', limit: 5 }, {})
  assert.equal(fresh.items.length, 1)
  assert.ok(fresh.items.every((item) => item.isRecent))
  const dismissed = await tool.execute({ action: 'dismiss' }, {})
  assert.equal(dismissed.unread, 0)

  // ── persistence and restart ───────────────────────────────────────────
  const store = JSON.parse(readFileSync(join(home, 'ai-star-radar', 'history.json'), 'utf8'))
  assert.equal(store.items.length, 2)
  assert.ok(Array.isArray(store.history['acme/hot']), 'star history is stored')
  assert.ok(store.history['acme/hot'].length >= 3, 'every scan left a sample')
  assert.equal(store.items.every((item) => item.unread === false), true, 'read flags are stored')

  const second = createContext()
  apply(second.ctx, config)
  const restored = await request(second.routes[0], '/x-github-ai-star-radar/state')
  const hotRestored = restored.body.items.find((item) => item.fullName === 'acme/hot')
  assert.equal(restored.body.total, 2, 'items are restored')
  assert.equal(hotRestored.growth, 500, 'growth is restored from history')
  assert.equal(hotRestored.growthHours, 24)
  assert.equal(restored.body.unread, 0, 'read flags are restored')
  assert.equal(typeof restored.body.lastScanAt, 'number', 'the last scan time is restored')
})

test('skips the recent-arrivals search when recentDays is 0', async (t) => {
  const previousHome = process.env.DSH_HOME
  const home = mkdtempSync(join(tmpdir(), 'ai-star-radar-test-'))
  process.env.DSH_HOME = home
  t.after(() => {
    rmSync(home, { recursive: true, force: true })
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })

  const created = new Date(Date.now() - 5 * DAY).toISOString()
  const github = stubGitHub({ stages: [500], createdHot: created, createdOld: created })

  const { ctx, routes } = createContext()
  apply(ctx, {
    threshold: 100,
    queries: ['topic:ai'],
    recentDays: 0,
    pollMinutes: 0,
    maxItems: 10,
    scanOnStart: false,
  })

  const snapshot = await request(routes[0], '/x-github-ai-star-radar/state?scan=1')
  assert.equal(github.issued.length, 1, 'one search per query when recentDays is 0')
  assert.ok(!github.issued.some((q) => q.includes('created:>=')))
  assert.equal(snapshot.body.recent, 0)
})

test('debounces back-to-back manual scans', async (t) => {
  const previousHome = process.env.DSH_HOME
  const home = mkdtempSync(join(tmpdir(), 'ai-star-radar-test-'))
  process.env.DSH_HOME = home
  t.after(() => {
    rmSync(home, { recursive: true, force: true })
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })

  const created = new Date(Date.now() - 5 * DAY).toISOString()
  const github = stubGitHub({ stages: [500], createdHot: created, createdOld: created })
  const { ctx, routes } = createContext()
  apply(ctx, {
    threshold: 100,
    queries: ['topic:ai'],
    recentDays: 0,
    pollMinutes: 0,
    maxItems: 10,
    scanOnStart: false,
  })

  await request(routes[0], '/x-github-ai-star-radar/state?scan=1')
  const after = github.issued.length
  await request(routes[0], '/x-github-ai-star-radar/state?scan=1')
  assert.equal(github.issued.length, after, 'a second scan inside the gap does not call GitHub again')
})
