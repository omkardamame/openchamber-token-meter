# Token Meter

Live tokens per second for the open OpenChamber session, and what that session
has spent: input, output, thinking, cache hits, time to first token, and the
total consumed. A session's subagents are part of it: while one of them streams,
the headline moves, and their tokens count in the totals.

![The Token meter section in the Work Status panel](docs/status.png)

The chat's Work Status panel keeps the speed beside the conversation.

![The Token Meter panel](docs/panel.png)

The rail panel adds the graph, the session totals, the running subagents and the
per-step rates.

## Install

Settings → Extensions → paste this, choose **Add**, allow the two permissions
(a local service, read from OpenCode):

```
https://github.com/omkardamame/openchamber-token-meter.git
```

## What it shows

- **Live `t/s`** — the sum of the session and every streaming subagent, with the
  last finished step underneath.
- **Graph** — the last 60 seconds, with the session's average and best step marked.
- **Subagents** — each subagent still working, its own live rate, and how many
  of the tree are running.
- **Totals** — In, Out, Think, Total out, Cache, Cache hit, TTFT, Consumed.
- **Per step** — orange bars are the session's steps, blue are its subagents'.
- **Work Status** — the same numbers as a compact strip in the chat panel, so
  the speed sits next to the conversation.

## Where the numbers come from

OpenCode's own records: per-step token counts, part timings, and its event
stream. That is provider- and agent-agnostic — any model, any agent.

A task tool runs its subagent in a session of its own. The meter follows those
child sessions (`parentID`), adds their rates to the parent's headline, and
counts their tokens and cost in its totals; the per-step chart marks their
steps. OpenCode keeps each session's own record separate, so summing a tree
cannot count the same step twice.

The headline is a sum, not a pick: every member that is streaming contributes
its own estimated rate, with its own learned ratio. The rail panel lists each
running subagent separately, so the combined number can be read apart.

Totals, per-step speed and TTFT are measured. The live `N t/s` is an estimate:
streamed characters × a ratio learned from finished steps, kept per session so
two models in one tree do not share a ratio.

## Limits

- Web and desktop only — VS Code and mobile do not load extensions.
- Needs OpenChamber 2.7.0 or newer.
- A collapsed Work Status section shows only its title; OpenChamber's extension
  API has no slot for a value there, so leave it expanded.

## Changelog

Every release, with what changed, in [CHANGELOG.md](CHANGELOG.md).

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 Omkar Damame.
