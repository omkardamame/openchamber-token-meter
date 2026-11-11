# Changelog

Every release of Token Meter, newest first. A release is a tag; nothing here is
dated by guesswork — each entry is what shipped in that tag.

## [1.3.0] - 2026-11-11

### Added

- A session's meter follows its subagents: their rates join the headline, their steps join the chart, and their tokens and cost count in the totals.
- A subagent step is marked in the chart and the last-step line, and the totals say how many subagents they include.

### Fixed

- A parent read 0 t/s while its subagents streamed, because their events carry the child's session id and the collector dropped them.
- Subagent tokens spent before the meter opened were missing from the totals; they now come from OpenCode's own session records.
- A streamed part was counted twice in the live rate when its full text arrived at the end; the ended text now counts only when no deltas streamed it.
- A subagent's first-token wait was hidden behind the parent's older step; the streaming member's own wait now wins.
- A failed lineage read retried on every tick; it now waits a minute.
- Eviction could drop a watched session while its subagent was still streaming; it no longer does.

### Changed

- A subagent's history is read for its step chart only, so its exact usage record cannot be replaced by a partial sum.
- The totals merge lives in one helper, and the README and cell hints say that totals include subagents.

## [1.2.2] - 2026-11-11

### Changed

- The README is six sections now, led by two live captures: the Work Status
  strip and the rail panel.

### Fixed

- The secret scan pipes each blob into `grep` instead of capturing it, so the
  new screenshots no longer make bash warn about null bytes on every run.

## [1.2.1] - 2026-11-11

### Changed

- A poll is **0.96 KB instead of 10.7 KB**. The live series travels as values
  against its fixed cadence, and the step list is only sent when the client's
  sequence is stale.
- The event stream subscribes with its own types instead of every event the
  machine produces.

### Added

- Page tests: both frames run in a real browser against a fake host, 19 checks.

### Fixed

- An accepted event filter could 400 the whole stream when one type was not
  subscribable; it now falls back to the unfiltered stream and says so.
- The frames rebuilt the 240-point series on every redraw; it is expanded once
  per answer.
- The work status section kept a step list it never draws.
- A service route could take the process down writing to a closed socket.

## [1.2.0] - 2026-11-11

### Fixed

- A burst above the chart's ceiling is squeezed into the top of the plot instead
  of being cut off, so a spike keeps its height.

## [1.1.9] - 2026-11-11

### Changed

- One grid, one dot map and one element helper for both frames; the service
  answers `500` and logs when a route throws, and collector eviction never drops
  a streaming session.

## [1.1.8] - 2026-11-11

### Added

- The chart draws the session's average and its best step as labelled lines.

### Fixed

- A step the user stopped no longer drags the average or sets the peak: it keeps
  its tokens in the totals and leaves the rates.

## [1.1.7] - 2026-11-11

### Changed

- The headline eases towards each reading over 160 ms; the panel polls every
  300 ms, the section every 500 ms.

## [1.1.6] - 2026-11-11

### Changed

- The live graph scales to the session's 92nd percentile, smooths the curve and
  fills it with a fading gradient; the reference line is labelled.

## [1.1.5] - 2026-11-11

### Fixed

- A step's speed is measured over its text and reasoning parts, not from the
  request time: 25 tok/s became the 138 the app itself measured.
- Time to first token is measured from the request, not from the event's own
  timestamp: 4 ms became 17.9 s where that was the truth.

## [1.1.4] - 2026-11-11

### Added

- Time to first token joins the totals grid.

## [1.1.3] - 2026-11-11

### Added

- The status dot breathes green while tokens arrive, glows orange while a tool
  or a question holds the turn, and sits dim at rest.

## [1.1.2] - 2026-11-11

### Fixed

- An audit pass: the event stream reopens 300 ms after a clean close, reads time
  out after 8 s, history reconciles only while a session is idle, one poll chain
  survives a session switch, the dot compares nothing in variable time, and the
  service refuses to send its token anywhere but loopback.

## [1.1.1] - 2026-11-11

### Fixed

- The work status section no longer grows taller on every render: it measured a
  root that was sized by the frame it was measuring.

## [1.1.0] - 2026-11-11

### Added

- MIT licence with the owner's copyright.
- A "running a tool" state, a sliding curve, and a secret-free install from the
  public repository URL.

## [1.0.0] - 2026-11-11

### Added

- First release: a rail panel and a Work Status section over a local service that
  reads OpenCode's own records through the extension's OpenCode access.
- Live tokens per second, a rolling graph, and the session's input, output,
  thinking, cache-hit and consumed totals.
