# Changelog

Every release of Token Meter, newest first; one or two concise lines per
release — what shipped in that tag.

## [1.9.1] - 2026-11-13

### Fixed

- The live curve ends at `now` again: the series carries each sample's own time,
  not a nominal 250 ms grid, which stopped the line up to ~15 s short and
  squeezed extra history into the window. Older services keep the grid.

## [1.9.0] - 2026-11-13

### Added

- The rail panel Cost block now draws the model's published peak and off-peak rates side by side, with the tier active now marked. The card is keyed by provider and model, not by model name: OpenCode Go's `deepseek-v4.1-flash` / `deepseek-v4-pro`, and DeepSeek's own `deepseek-flash` / `deepseek-v4-pro` (plus the legacy Flash ids). Peak is 2× off-peak, 01:00–04:00 and 06:00–10:00 UTC, Monday–Friday; weekends are off-peak. DeepSeek's own API also treats Chinese public holidays as off-peak, with the 2026 calendar included.
- A provider without a known card keeps the rates recovered from its own step costs. If its costs do not fit one linear price, the panel says `multiple rates; no schedule` instead of applying another provider's card. A failed fit also says whether it ran out of steps or has no cache reads yet.
- The last turn's cost also sits at the end of the last measured step's line (`last 153 t/s · 1.6 s · 238 tok · $0.0671`).

### Changed

- The Work Status section ends at Consumed. Its footer below the stats — session cost, subagent count and first-token wait — is gone, so nothing is drawn below TTFT in that section.
- The rail panel keeps its full Cost block: total, last turn, model, effective rate and the rate table.

## [1.8.0] - 2026-11-13

### Added

- The live curve is a smooth monotone line with a labelled scale (top and half), marks at 15, 30 and 45 seconds ago, and a crosshair under the pointer that reads the rate and its age ("42 t/s · 12 s ago").
- Hovering the per-step chart highlights the bar and reads its rate, tokens, duration, clock time and cost under the chart; a subagent's step says so.
- A turn timer beside the status while a turn runs ("generating · 1m 03s").
- The Last turn cost names its steps and generated tokens on hover.
- The Work Status section ends its foot with the session cost.
- The headline number snaps instead of easing when the system asks for reduced motion.

### Fixed

- With two tools running at once, the first to finish set the session to idle while the second still ran. Tools are counted now, and the last one hands the status back to the running turn.
- A finished tool or an answered question showed "idle" in the middle of a turn.
- A first history read cut short by its 6 s deadline stayed partial for five minutes; it is read again after 15 s once the turn is quiet.
- The footer flickered "connecting to OpenCode events" every 55 s while the service recycled its own stream.
- The panel named its live window "last 5 s"; the window is 3 s.
- The per-step chart rebuilt every bar on each 250 ms poll, which also destroyed its tooltips. It redraws only when the steps, the size or the hovered bar change.

### Changed

- The service keeps the merged step list, its rates and the recovered model rates until a step list changes, instead of working them out on every poll.
- The Work Status spark draws the same smooth curve as the panel.

## [1.7.1] - 2026-11-13

### Fixed

- The dot's glow is round now. It was a `box-shadow` cast by a 7px circle, which is a blurred rounded square and read square at that size; it is a radial halo, centre to rim, in both frames. The Work Status frame also keeps the 7px the halo reaches, so the host's clipped box no longer cuts it flat on the left.
- Switching chats kept the previous session's totals, cost, step bars, live curve and subagent list under the new session's name, and an answer already in flight for the old chat painted it back over the reset headline. Both frames clear those surfaces the moment the session switches and drop an answer whose session changed underneath it.
- The Work Status section drew a blank box under its title when no chat was open; it now says "Open a chat to read its usage."
- A count between 999,500 and 999,999 printed as `1000k` instead of `1.0M`.

### Changed

- The dot's halo breathes with the core on the same clock — 2.4 s while tokens arrive, 1.1 s uneven for a tool — and fades out over 220 ms when the state drops the animation.

## [1.7.0] - 2026-11-12

### Added

- The live `t/s` colour follows its speed tier in both frames: matte red under 20, green 20–50, sky blue 50–90, golden 90–150, violet above 150, with a soft glow on the top two.
- The last measured step's rate uses the same tiers from its own step, with its duration and token tail kept muted.
- Page tests cover every tier, the exact glow, the rounded boundaries, quiet and tool states, and a session switch.

### Changed

- The rail panel's live curve scales to its smoothed peak and the per-step bars scale to the best step, so both plots use their full height instead of reserving headroom.
- The steady green is `#76AC4F`, the blazing tier golden `#D4AF37`, and the slow tier matte red `#C96A6A`.
- The average and peak reference labels no longer collide when their lines are close.

### Fixed

- Switching chats kept the previous session's headline digits, tier, last-step line and chart scale.
- A last step printed as "20 t/s" could be coloured as a slow rate; the tier now follows the rounded number shown.
- A single live sample was drawn as a zero baseline.
- A rate under 8 t/s left empty space above the live curve.

## [1.6.0] - 2026-11-12

### Changed

- The last measured step's rate is yellow in both frames, apart from the green average and the red peak.

## [1.5.0] - 2026-11-12

### Added

- The rail panel polls every 250 ms, one sample per service series point.
- History reads up to 2,000 messages; the chart draws up to 1,000 steps, and the count is the session's total.
- The panel says when a session or subagent history is still loading or partial.

### Fixed

- A subagent history beyond 400 steps was counted as 400.
- A cold start on a long session could undercount its totals; the session record is now a usage floor.
- A history cut at the page cap was reported complete; it is marked partial.
- A missed turn end after the 55 s stream cut could leave the dot breathing or a tool glowing; the session record now reconciles status.
- A tool-only step's history rate included the tool run; it now measures the input stream.
- A first history read during a turn could drop the live step from the chart; live steps are merged by id.
- A model missing from the host context left the header and Cost model blank; the recovered rates now name it.
- The per-step header could overflow a narrow rail; it wraps.

### Changed

- The README uses the owner's live rail-panel capture.

## [1.4.0] - 2026-11-11

### Added

- A **Subagents** block lists every subagent still working, with its own rate and title.
- **Per step** draws every step the meter keeps (up to 400), with its total count, orange for the session and blue for a subagent.
- The green average and red best step are labelled and drawn, with a start/now axis under the bars.
- A **Cost** block shows the total and the last turn, the model, its blended rate, and its actual input/output/cache-hit $/1M rates.
- The model rates are recovered from OpenCode's own step costs, so no price table or blocked API read is needed.

### Fixed

- The per-step average and peak now describe the bars drawn, not the whole tree.
- The step count shows the session's full total, not the 400-step drawing cap.
- The model name no longer overflows the header; it ellipsizes.
- Rates are withheld when a tiered or cache-write cost makes the step costs non-linear.

### Changed

- The step list travels only when its sequence changes; an ordinary poll stays around 1.7 KB.
- Total and last-turn costs show four decimals.
- Consumed renders at the same size as the other stats in both frames.
- The per-step header separates its count, average and peak with muted dots.

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
