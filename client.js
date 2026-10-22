/**
 * AI Star Radar — Client half.
 *
 * One sidebar panel entry (`sidebar.panellist`) plus the page it opens
 * (`main` keyed by the same id). Data comes from the Host half's exact
 * same-origin route, so no Harness Client package is imported: React comes
 * from the browser module table and styling uses host theme tokens only.
 */
window.__ModuleLoader__.load({
  id: 'dsh-ai-star-radar',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace owned by this plugin. */
    const NS = 'aiStarRadar'
    /** Shared by the sidebar row and the main panel it opens. */
    const PANEL_ID = 'ai-star-radar'
    /** Host route carrying the radar snapshot. */
    const STATE_URL = '/x-github-ai-star-radar/state'
    /** How often the panel refreshes while the app runs. */
    const POLL_MS = 60_000

    const zh = {
      panel: 'AI 星标雷达',
      title: 'AI 星标雷达',
      intro: '星标越过 {threshold} 的项目，加上最近 {days} 天内创建、至少 {floor} 星标的新项目；每个项目都带最近 24 小时的星标增量。',
      refresh: '立即扫描',
      scanning: '扫描中…',
      loading: '加载中…',
      empty: '还没有越过阈值的项目。雷达会按计划继续扫描。',
      emptyRecent: '最近 {days} 天内还没有新项目上榜，等下一轮扫描。',
      error: '读取雷达数据失败',
      newTag: '新',
      lastScan: '上次扫描 {time}',
      never: '尚未扫描',
      total: '{count} 个项目',
      unread: '{count} 个新项目',
      rate: 'API 剩余 {remaining}',
      added: '收录于 {time}',
      viewTrend: '涨得最快',
      viewStars: '星标最高',
      viewRecent: '新上线',
      growthDay: '+{delta} / 24 小时',
      growthWindow: '+{delta} / {hours} 小时',
      createdDays: '{value} 天前创建',
      createdMonths: '{value} 个月前创建',
      createdYears: '{value} 年前创建',
      minutes: '{value} 分钟前',
      hours: '{value} 小时前',
      days: '{value} 天前',
      justNow: '刚刚',
      github: 'GitHub',
    }

    const en = {
      panel: 'AI Star Radar',
      title: 'AI Star Radar',
      intro: 'Projects over {threshold} stars, plus repositories created in the last {days} days with at least {floor} stars; every row carries its star growth over the last 24 hours.',
      refresh: 'Scan now',
      scanning: 'Scanning…',
      loading: 'Loading…',
      empty: 'Nothing over the threshold yet. The radar keeps scanning on its schedule.',
      emptyRecent: 'No new repositories in the last {days} days yet; the next scan may find some.',
      error: 'Could not read the radar',
      newTag: 'new',
      lastScan: 'Last scan {time}',
      never: 'not scanned yet',
      total: '{count} projects',
      unread: '{count} new',
      rate: 'API left {remaining}',
      added: 'added {time}',
      viewTrend: 'Fastest growth',
      viewStars: 'Most stars',
      viewRecent: 'Newly published',
      growthDay: '+{delta} / 24 h',
      growthWindow: '+{delta} / {hours} h',
      createdDays: 'created {value} d ago',
      createdMonths: 'created {value} mo ago',
      createdYears: 'created {value} y ago',
      minutes: '{value} min ago',
      hours: '{value} h ago',
      days: '{value} d ago',
      justNow: 'just now',
      github: 'GitHub',
    }

    const CSS = `
.asr-page{box-sizing:border-box;height:100%;display:flex;flex-direction:column;align-items:center;gap:20px;padding:0 clamp(24px,4vw,48px) 48px;overflow:auto;color:var(--dsw-alias-label-primary)}
.asr-page>*{width:100%;max-width:960px}
.asr-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;padding-top:28px}
.asr-title{margin:0;font-size:20px;font-weight:500;line-height:28px}
.asr-intro{margin:4px 0 0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.asr-toolbar{display:flex;align-items:center;gap:12px;flex:none}
.asr-button{height:32px;padding:0 14px;border-radius:var(--dsw-radius-md,8px);border:0;font:inherit;font-size:13px;line-height:20px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12))}
.asr-button:hover:not(:disabled){background:var(--dsw-alias-border-l1,rgba(127,127,127,.2))}
.asr-button.primary{background:var(--dsw-alias-brand-primary,#247bbf);color:#fff}
.asr-button.primary:hover:not(:disabled){opacity:.9}
.asr-button:disabled{opacity:.55;cursor:default}
.asr-button:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary,#247bbf));outline-offset:2px}
.asr-status{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.asr-pill{display:inline-flex;align-items:center;gap:6px;padding:2px 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.08));font-variant-numeric:tabular-nums}
.asr-pill.alert{background:color-mix(in srgb, var(--dsw-alias-state-success-primary,#2f9e44) 16%, transparent);color:var(--dsw-alias-label-primary)}
.asr-pill.failure{background:color-mix(in srgb, var(--dsw-alias-state-error-primary,#c92a2a) 14%, transparent)}
.asr-dot{width:7px;height:7px;border-radius:999px;background:var(--dsw-alias-state-idle-primary,#adb5bd);flex:none}
.asr-dot.live{background:var(--dsw-alias-state-success-primary,#2f9e44)}
.asr-dot.bad{background:var(--dsw-alias-state-error-primary,#c92a2a)}
.asr-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.asr-row{display:flex;gap:14px;align-items:flex-start;padding:12px 8px;margin:0 -8px;border-radius:var(--dsw-radius-lg,10px)}
.asr-row:hover{background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.07))}
.asr-rank{width:28px;flex:none;padding-top:1px;font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;text-align:right}
.asr-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
.asr-rowhead{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap}
.asr-name{font-size:14px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-primary);text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.asr-name:hover{text-decoration:underline}
.asr-tag{font-size:10px;line-height:16px;padding:0 6px;border-radius:999px;font-weight:500;background:color-mix(in srgb, var(--dsw-alias-state-success-primary,#2f9e44) 18%, transparent);color:var(--dsw-alias-label-primary)}
.asr-desc{margin:0;font-size:13px;line-height:18px;color:var(--dsw-alias-label-secondary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.asr-meta{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.asr-stars{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.asr-topic{font-size:11px;line-height:16px;padding:0 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.09));color:var(--dsw-alias-label-secondary)}
.asr-note{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.asr-views{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.asr-chip{height:26px;padding:0 10px;border-radius:999px;border:0;font:inherit;font-size:12px;line-height:18px;cursor:pointer;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.08))}
.asr-chip:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14))}
.asr-chip[aria-pressed=true]{background:color-mix(in srgb, var(--dsw-alias-brand-primary,#247bbf) 16%, transparent);color:var(--dsw-alias-label-primary)}
.asr-chip:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary,#247bbf));outline-offset:2px}
.asr-count{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.asr-grow{color:var(--dsw-alias-state-success-primary,#2f9e44);font-variant-numeric:tabular-nums}
.asr-icon{display:block;overflow:visible}
`

    // ── a tiny module-local store shared by the icon and the page ──────────
    let state = { phase: 'idle', snapshot: null, error: null }
    const listeners = new Set()

    function publish(next) {
      state = next
      for (const listener of [...listeners]) {
        try {
          listener()
        } catch (error) {
          console.error('ai-star-radar: subscriber failed', error)
        }
      }
    }

    /** Subscribe a component to the radar store. */
    function useRadar() {
      const [value, setValue] = React.useState(state)
      React.useEffect(() => {
        const listener = () => setValue(state)
        listeners.add(listener)
        listener()
        return () => {
          listeners.delete(listener)
        }
      }, [])
      return value
    }

    /** Fetch the snapshot, optionally asking the Host to scan or mark read. */
    async function load(query) {
      const suffix = query === undefined ? '' : `?${query}`
      try {
        const response = await fetch(`${STATE_URL}${suffix}`, { headers: { accept: 'application/json' } })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        publish({ phase: 'ready', snapshot: await response.json(), error: null })
      } catch (error) {
        publish({
          phase: 'error',
          snapshot: state.snapshot,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    /** `12345` -> `12.3k`. */
    function formatStars(value) {
      if (!Number.isFinite(value)) return '0'
      if (value >= 1000) {
        const thousands = value / 1000
        return `${thousands >= 100 ? Math.round(thousands) : Math.round(thousands * 10) / 10}k`
      }
      return String(value)
    }

    /** Locale-aware relative time out of a timestamp. */
    function relativeTime(t, timestamp) {
      if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return t('never')
      const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000))
      if (seconds < 45) return t('justNow')
      const minutes = Math.max(1, Math.round(seconds / 60))
      if (minutes < 60) return t('minutes', { value: minutes })
      const hours = Math.round(minutes / 60)
      if (hours < 36) return t('hours', { value: hours })
      return t('days', { value: Math.round(hours / 24) })
    }

    /** `21` -> `21 天前创建` / `7` -> `7 个月前创建`. */
    function createdLabel(t, item) {
      const days = typeof item.ageDays === 'number' ? item.ageDays : -1
      if (days < 0) return ''
      if (days <= 90) return t('createdDays', { value: days })
      if (days <= 730) return t('createdMonths', { value: Math.round(days / 30) })
      return t('createdYears', { value: Math.round(days / 365) })
    }

    /** Star growth chip text for one item, or '' when there is nothing to show. */
    function growthLabel(t, item) {
      const delta = typeof item.growth === 'number' ? item.growth : 0
      const hours = typeof item.growthHours === 'number' ? item.growthHours : 0
      if (delta <= 0 || hours < 1) return ''
      if (hours >= 20) return t('growthDay', { delta: formatStars(delta) })
      return t('growthWindow', { delta: formatStars(delta), hours })
    }

    /** One row of the radar list. */
    function RadarRow({ item, index, t }) {
      const growth = growthLabel(t, item)
      const created = createdLabel(t, item)
      const topics = Array.isArray(item.topics) ? item.topics.slice(0, 3) : []
      return h(
        'li',
        { className: 'asr-row' },
        h('span', { className: 'asr-rank', 'aria-hidden': true }, String(index + 1).padStart(2, '0')),
        h(
          'div',
          { className: 'asr-main' },
          h(
            'div',
            { className: 'asr-rowhead' },
            h('a', { className: 'asr-name', href: item.url, target: '_blank', rel: 'noreferrer' }, item.fullName),
            item.unread ? h('span', { className: 'asr-tag' }, t('newTag')) : null,
          ),
          item.description ? h('p', { className: 'asr-desc' }, item.description) : null,
          h(
            'div',
            { className: 'asr-meta' },
            h('span', { className: 'asr-stars' }, `★ ${formatStars(item.stars)}`),
            growth ? h('span', { className: 'asr-grow' }, growth) : null,
            item.language ? h('span', null, item.language) : null,
            created ? h('span', null, created) : null,
            ...topics.map((topic) => h('span', { key: topic, className: 'asr-topic' }, topic)),
          ),
        ),
      )
    }

    /** The full-page radar panel. */
    function RadarPage(props) {
      const { t } = props
      const { phase, snapshot, error } = useRadar()
      const [view, setView] = React.useState('trend')
      const snapshotRef = React.useRef(snapshot)
      snapshotRef.current = snapshot

      React.useEffect(() => {
        const current = snapshotRef.current
        if (current !== null && current.unread > 0) void load('read=1')
      }, [])

      const scanning = snapshot !== null && snapshot.scanning === true
      const all = snapshot !== null && Array.isArray(snapshot.items) ? snapshot.items : []
      const recentItems = snapshot !== null && Array.isArray(snapshot.recentItems)
        ? snapshot.recentItems
        : all.filter((item) => item.isRecent === true)
      let rows = all
      if (view === 'recent') rows = recentItems
      if (view === 'stars') rows = [...all].sort((left, right) => right.stars - left.stars)
      if (view === 'trend') {
        rows = [...all].sort((left, right) => (right.growth || 0) - (left.growth || 0) || right.stars - left.stars)
      }
      const threshold = snapshot !== null ? snapshot.threshold : 0
      const recentDays = snapshot !== null && Number.isFinite(snapshot.recentDays) ? snapshot.recentDays : 30
      const recentFloor = snapshot !== null && Number.isFinite(snapshot.recentMinStars) ? snapshot.recentMinStars : 100
      const recentCount = snapshot !== null && Number.isFinite(snapshot.recent) ? snapshot.recent : recentItems.length
      const statusLine = []

      if (phase === 'idle') statusLine.push(t('loading'))
      if (snapshot !== null) {
        statusLine.push(
          snapshot.lastScanAt === null ? t('never') : t('lastScan', { time: relativeTime(t, snapshot.lastScanAt) }),
        )
        statusLine.push(t('total', { count: snapshot.total }))
        if (snapshot.rate !== null && snapshot.rate !== undefined && Number.isFinite(snapshot.rate.remaining)) {
          statusLine.push(t('rate', { remaining: snapshot.rate.remaining }))
        }
      }

      const viewChip = (id, label, extra) => h(
        'button',
        {
          key: id,
          type: 'button',
          className: 'asr-chip',
          'aria-pressed': view === id ? 'true' : 'false',
          onClick: () => setView(id),
        },
        label,
        extra !== undefined && extra > 0 ? h('span', { className: 'asr-count' }, ` · ${extra}`) : null,
      )

      return h(
        'section',
        { className: 'asr-page', 'data-asr-panel': '', 'aria-busy': scanning ? 'true' : 'false' },
        h(
          'header',
          { className: 'asr-head', 'data-window-drag': true },
          h(
            'div',
            null,
            h('h1', { className: 'asr-title' }, t('title')),
            h('p', { className: 'asr-intro' }, t('intro', {
              threshold,
              days: recentDays,
              floor: recentFloor,
            })),
          ),
          h(
            'div',
            { className: 'asr-toolbar' },
            h(
              'button',
              {
                type: 'button',
                className: 'asr-button primary',
                disabled: scanning,
                onClick: () => {
                  void load('scan=1')
                },
              },
              scanning ? t('scanning') : t('refresh'),
            ),
          ),
        ),
        h(
          'p',
          { className: 'asr-status', role: 'status' },
          h('span', {
            className: `asr-dot${scanning ? ' live' : phase === 'error' ? ' bad' : ''}`,
            'aria-hidden': true,
          }),
          statusLine.map((line, index) => h('span', { key: `${index}-${line}` }, index === 0 ? line : ` · ${line}`)),
          snapshot !== null && snapshot.unread > 0
            ? h('span', { className: 'asr-pill alert' }, t('unread', { count: snapshot.unread }))
            : null,
          phase === 'error' && error !== null
            ? h('span', { className: 'asr-pill failure' }, `${t('error')}：${error}`)
            : null,
        ),
        h(
          'div',
          { className: 'asr-views', role: 'group' },
          viewChip('trend', t('viewTrend')),
          viewChip('stars', t('viewStars')),
          viewChip('recent', t('viewRecent'), recentCount),
        ),
        rows.length === 0
          ? h(
            'p',
            { className: 'asr-note' },
            phase === 'idle'
              ? t('loading')
              : view === 'recent' ? t('emptyRecent', { days: recentDays }) : t('empty'),
          )
          : h(
            'ul',
            { className: 'asr-list' },
            rows.map((item, index) => h(RadarRow, { key: item.fullName, item, index, t })),
          ),
        snapshot !== null && snapshot.lastError
          ? h('p', { className: 'asr-note' }, `${t('github')}：${snapshot.lastError}`)
          : null,
      )
    }

    /** Sidebar glyph: a radar star that carries a dot while new items wait. */
    function RadarIcon({ size = 16, active = false }) {
      const { snapshot } = useRadar()
      const unread = snapshot !== null ? snapshot.unread : 0
      const glyph = size >= 18 ? 18 : 16
      return h(
        'svg',
        {
          className: 'asr-icon',
          viewBox: '0 0 16 16',
          width: glyph,
          height: glyph,
          'aria-hidden': true,
          style: { color: active ? 'var(--dsw-alias-brand-primary, #247bbf)' : 'currentColor' },
        },
        h('path', {
          fill: 'currentColor',
          opacity: active ? 1 : 0.9,
          d: 'M8 1.6l1.87 4.1 4.43.52-3.28 3.05.87 4.38L8 11.5l-3.89 2.15.87-4.38L1.7 6.22l4.43-.52L8 1.6z',
        }),
        unread > 0
          ? h('circle', {
            cx: 12.4,
            cy: 3.4,
            r: 2.6,
            fill: 'var(--dsw-alias-state-success-primary, #2f9e44)',
            stroke: 'var(--dsw-alias-bg-base, #fff)',
            strokeWidth: 1.2,
          })
          : null,
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)

        ctx.effect(
          () => ctx.locale.register(NS, { zh, en }),
          'ai-star-radar: dictionaries',
        )

        ctx.effect(() => {
          const tag = document.createElement('style')
          tag.dataset.plugin = PANEL_ID
          tag.textContent = CSS
          document.head.appendChild(tag)
          return () => {
            tag.remove()
          }
        }, 'ai-star-radar: styles')

        ctx.effect(() => {
          void load()
          const timer = setInterval(() => {
            void load()
          }, POLL_MS)
          return () => {
            clearInterval(timer)
          }
        }, 'ai-star-radar: polling')

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
        }, RadarPage))

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 10,
          label: () => t('panel'),
          locale: NS,
        }, RadarIcon))
      },
    }
  },
})
