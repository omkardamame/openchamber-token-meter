# Automatic session graph recording and saved replay

## Status

Accepted by the owner on 2026-11-16: saved recording plus replay, using the
existing one-hour chart window rather than unlimited session archives.

## Context

The service previously created and sampled a collector only when a frame
requested `/state`. Its event stream could discover descendants of watched
sessions, but discarded unrelated sessions. Opening a chat late therefore
started a new live curve instead of showing the generation already underway.

OpenCode's finished steps can recover per-step rates, not the exact live
character-based estimates. Reconstructing a live curve from step totals would
misrepresent those estimates as samples that were never taken.

## Decision

- Declare `service.keepRunning` so the approved host starts the recorder
  without a panel request. OpenChamber must remain running; recording does not
  continue while its host is stopped.
- Attach session events immediately, before asynchronous record/lineage
  lookup, and sample active sessions and their subtrees on the existing
  250 ms ticker. A bounded startup/periodic scan discovers already-busy chats.
- Preserve the existing 60-second, five-minute and one-hour resolutions.
  Save up to 200 session recordings, evicting least recently updated records.
- Store only session IDs, times and rate samples in the extension's private
  data directory. Do not store messages, titles, credentials or token totals.
  Writes are atomic, batched every five seconds and flushed on graceful stop.
- Freeze a completed recording at its end time. Both frames use that time
  when viewing saved history; the rail says `ended`, not `now`. A new turn
  resumes live collection and the current clock.
- An older session without samples remains explicitly unrecorded. Its
  per-step chart still uses normal OpenCode history. Do not fabricate a live
  recording or silently label an empty graph as captured history.

## Consequences

Watching a frame is no longer necessary to collect its graph. Saved graphs
survive service restarts and extension updates, subject to bounded retention.
The manifest change may require renewed background-running approval. Sudden
process termination can lose the most recent unsaved batch; host downtime
cannot be backfilled into an exact live curve. Persisted rates are samples,
not a recording of every intermediate display-animation frame.
