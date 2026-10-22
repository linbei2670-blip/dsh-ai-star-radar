# AI 星标雷达 · dsh-ai-star-radar

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：盯着 GitHub 上 AI 方向的开源项目，
**实测**它们最近 24 小时的星标增速，并把「最近新建但已经起量」的仓库一起收进一张实时面板。

不是又一个「按总星标排序的排行榜」——它回答的是「**现在**谁在涨」。

![panel](icon.svg)

## 它给出三样东西

| 视图 | 排序 / 筛选 |
| --- | --- |
| **涨得最快**（默认） | 按最近 24 小时星标增量降序 |
| **星标最高** | 按总星标降序 |
| **新上线 · N** | 只看最近 `recentDays` 天内**创建**的仓库，按星标降序 |

每行显示：`★ 总星标` → `+增量 / 24 小时`（历史不满一天时显示真实覆盖窗口，如 `+320 / 6 小时`）→ 语言 →
`N 天前创建` → topics。新上榜项目带「新」标记，侧栏图标同时亮一个小圆点；打开面板即清空未读。

同一份数据也通过工具暴露给模型：`github_ai_star_radar`，动作 `status` / `list` / `trending` / `new` /
`scan` / `dismiss`，所以任何会话里都可以直接问「最近有哪些 AI 项目在涨」。

## 安装

三种方式，装完重启一次应用：

```bash
# 1) 已发布到 npm 后
dsh plugin --profile web add dsh-ai-star-radar

# 2) 从这个仓库的本地目录（推荐先 clone）
git clone https://github.com/linbei2670-blip/dsh-ai-star-radar.git
dsh plugin --profile web add ./dsh-ai-star-radar

# 3) 应用内：设置 → 插件 → 添加，选择本仓库目录
```

`--profile` 填你实际使用的 profile（桌面端通常是 `web`）。

## 配置

插件是 bundle，配置写在它自带的 `cordis.patch.yml` 里，或在你 profile 的 patch 层用同 id 覆盖：

```yaml
# <DSH_HOME>/profiles/<profile>/cordis.patch.yml
- id: ai-star-radar
  config:
    threshold: 5000      # 只覆盖想改的字段，其余走默认值
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `threshold` | `3000` | 星标阈值，达到才算「大」 |
| `queries` | `topic:ai` `topic:llm` `topic:agents` | GitHub 搜索词，每条都会与 `stars:>=threshold` 组合 |
| `windowDays` | `0` | `0` = 不限时间；`>0` 只留最近 N 天有 push 的仓库 |
| `recentDays` | `30` | 额外追踪最近 N 天内**创建**的仓库；`0` 关闭这条查询 |
| `recentMinStars` | `100` | 这些新仓库的星标下限 |
| `pollMinutes` | `30` | 自动扫描间隔；`0` = 只手动扫描 |
| `maxItems` | `40` | 雷达保留并展示的项目数 |
| `starJump` | `0` | `>0` 时，两轮之间涨了这么多星也提醒（追突发） |
| `token` | `''` | 可选 GitHub token，把搜索限额从 10 次/分钟提到 30 次/分钟 |
| `scanOnStart` | `true` | 启用约 2 秒后先扫一次 |

**限额**：每轮扫描的查询数 = `queries.length × (1 + (recentDays > 0 ? 1 : 0))`。默认 3 个 topic → 6 条/轮，
30 分钟一轮对未登录限额（10 次/分钟、60 次/小时）非常宽松。想更频繁就填 `token`。

## 增速是怎么算的

- 每轮扫描给每个仓库记一个 `[时间, 星标]` 样本，保留 **3 天**，每次扫描落盘。
- 增量 = 当前星标 − **不晚于「现在 − 24 小时」的最新样本**；如果历史还不满 24 小时，就用最早的那个样本，
  并把真实覆盖时长（`growthHours`）一起报出来——所以前期不会假装自己有 24 小时数据。
- 同一轮里多个查询命中同一仓库时取最大星标数；两次扫描间隔不足 10 分钟且星标没变的样本会合并，
  避免把抖动当增长。

## 数据与隐私

- 只访问 `https://api.github.com/search/repositories`；不登录、不上报遥测。
- 填了 `token` 只会随请求发往 GitHub，且只存在你的 profile 配置里。
- 本地状态：`<DSH_HOME>/ai-star-radar/history.json`（名单、3 天星标曲线、已读标记）。删掉即彻底重置。
- 面板用同源只读接口 `GET /x-github-ai-star-radar/state` 取数（同源、无鉴权、仅本机回环）。
  面板打开时带 `?read=1` 标记已读，「立即扫描」带 `?scan=1`。

## 开发

```bash
npm test        # node --test，零依赖：假 context + 桩 GitHub API + 可控时钟
```

仓库结构：

```
index.js            Host 半边：扫描、采样、持久化、工具、HTTP 路由
client.js           Client 半边：侧栏图标 + 整页面板（React 自浏览器模块表取）
cordis.patch.yml    bundle 的加载器 patch（一行 insert）
locale/{zh,en}.json 插件管理器里显示的标题/描述
test/host.test.mjs  Host 逻辑测试
```

测试覆盖：24 小时窗口绑定（`1800−1300=500`）、年轻窗口（`+300/2h`）、新上线查询、按增速排序、
持久化与重启恢复、`recentDays: 0` 关闭查询、手动扫描去抖。

## 局限

- 增速需要历史：刚装/刚重启的第一天只有部分窗口，满 24 小时后才是标准 24 小时值。
- 状态只在 Host 进程与那个 JSON 文件里；多开 DSH 实例会各自维护一份。
- 「推送」目前是侧栏圆点 + 面板计数，没有系统通知。
- 只覆盖 GitHub 上打了 `topic:*` 标签的仓库；没打标签的项目搜不到。

## English

**dsh-ai-star-radar** is a DeepSeek Harness plugin that watches GitHub for AI open-source projects,
measures their **real star growth over the last 24 hours** (sampled every scan, kept for 3 days), and also
tracks repositories **created recently** that already gained traction.

- Sidebar panel with three views: fastest growth (default), most stars, newly published.
- Tool `github_ai_star_radar` (`status` / `list` / `trending` / `new` / `scan` / `dismiss`) for any session.
- Zero runtime dependencies: the Host half imports only `node:fs` / `node:path`; the Client half takes
  React from the browser module table and styles with host theme tokens.
- Install: `dsh plugin --profile web add ./dsh-ai-star-radar` (or the package name once published), then restart.
- Growth = current stars − the newest sample at or before `now − 24h`; on young history the actual window
  (`growthHours`) is reported instead of pretending to be a full day.
- State lives in `<DSH_HOME>/ai-star-radar/history.json`; the panel reads `GET /x-github-ai-star-radar/state`.

MIT licensed.

## License

[MIT](LICENSE) © 2026 linbei2670-blip
