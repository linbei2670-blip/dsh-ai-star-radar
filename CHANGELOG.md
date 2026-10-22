# Changelog

All notable changes to this plugin land here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-10-21

### Added

- **Measured star growth**: every scan appends a `[timestamp, stars]` sample, three days are kept, and each
  project reports the stars it gained over the last 24 hours (`growth`) together with the actual window it
  covers (`growthHours`), so young history is never presented as a full day.
- **Newly published projects**: a second search per query (`created:>=<recentDays> stars:>=recentMinStars`)
  brings in repositories that are new rather than famous. Configurable through `recentDays` and `recentMinStars`.
- **Three panel views**: fastest growth (default), most stars, and newly published — plus the creation age of
  every project.
- **Persistence**: the radar, its three-day history and its read flags are written to
  `<DSH_HOME>/ai-star-radar/history.json`, so a restart no longer wipes the trend line.
- Tool actions `trending` and `new`.
- `schemaVersion: 2` on the snapshot; the client degrades gracefully against an older Host.

### Changed

- The default ordering is by growth instead of absolute stars; "most stars" is one click away.
- `github_ai_star_radar` results now carry `growth`, `growthHours`, `ageDays` and `isRecent`.

## [0.1.0] - 2026-10-21

### Added

- Initial release: GitHub Search polling for AI topics over a star threshold, a sidebar panel with the ranked
  list, the `github_ai_star_radar` tool, and the same-origin `GET /x-github-ai-star-radar/state` route.
