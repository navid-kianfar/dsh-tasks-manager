# @achasoft/dsh-tasks-manager

Task management for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): a **project task board** kept with the project itself, a **kanban and list view** inside the Web Client, and board cards you can **hand to the agent to work in the background**.

The board is a SQLite database at `.dsh/tasks.db` in your project — so it survives across sessions, moves with the repository, and you can query it directly:

```bash
sqlite3 .dsh/tasks.db "select * from board"
```

## What it adds

**A Session panel** showing this session's checklist — the one the assistant keeps with `todo_write` — beside the durable board. That pairing is the point: the checklist is scratch, cleared at the next turn and gone when the session ends, while the board is the project's. One click promotes a step you did not finish onto the board, where it stays.

**A Tasks view** beside Chat and Trajectory, taking the whole centre column. Five columns (`backlog`, `todo`, `in progress`, `blocked`, `done`) with drag-and-drop between and within them, a dense sortable list view, filters over status, priority, labels, assignee and full-text search, and a card detail with an editable Markdown description, comments, and a complete history of every change.

**Edits that do not overwrite each other.** A field changed in the card detail is sent with the card's last-seen `updatedAt`; if the agent, another session, or `sqlite3` changed the card in the meantime, the edit is refused, the board says so, and the card reloads.

**Fields that know what they can hold.** Status and priority are pickers, the due date is a calendar, and labels are chips completed from the labels already on the board. The assignee is the one that matters most: it offers **the people who have committed to this project**, read from `git log` and ranked by how much of it each has written, with the identity `git config` names in the repository first. A board where `alex`, `Alex`, and `alex@…` are three different people is a board whose assignee filter is decorative. A value already on a card that is not in the history is kept and still selectable — the picker narrows what can be chosen, never what a card already says. In a directory that is not a repository, the picker says so.

**Tools the model can reach**, so you can just say what you want:

> *"add a task to rotate the staging API keys, urgent, label it security"*

`task_add`, `task_list`, `task_update`, `task_comment`, and (off by default) `task_delete`. Cards are addressed the way a person quotes them — `#12`, `12`, or the full id. Every model write is attributed to `agent` in the history, so you can always see who changed what.

**Assignees from the repository.** `git log` is read per project and cached for a minute, so the picker is right the moment someone's first commit lands and there is no roster to maintain. Nothing is written to git, and a project with no repository simply has no one to assign. The read runs with `-c log.showSignature=false -c core.fsmonitor=false -c core.pager=cat --no-show-signature`, so a repository's own `.git/config` cannot make opening the board run a program it names (`gpg.program` under `log.showSignature`, an fsmonitor hook).

**Archive and reopen** rather than delete: archiving hides a card from the board and keeps its comments and history intact. Deleting is a separate, confirmed action, and the model cannot do it unless you turn that on.

**A Background panel** listing every background task the session can see — shell commands, subagents, and cards dispatched from the board — with live status and a stop control. *Read output* shows a dispatched card's final report. Other jobs' output is left alone: the job registry gives each job one consuming read cursor, it belongs to the agent's `job_output`, and reading it from the board would take the output away from the agent.

**Dispatch a card to the agent.** With a subagent provider configured, a card can be handed to the agent to work detached from your current turn: the card shows a live running state, the run appears in the Background panel and the harness's own job surfaces, and the outcome is recorded on the card — its status in the card's last run, and the subagent's report (or, for a failed run, its diagnostic and whatever it produced) as a comment. The report is also what `job_output` returns for the job.

A few guarantees worth knowing:

- **The agent is not woken for it.** `@deepseek-ai/dsh-tool-jobs` normally opens a model turn on an idle owner when a job finishes. A dispatch is started by you, not by the agent, and the board records the result, so the plugin marks its own runs collected and no turn is spent on an unsolicited notice. The agent can still see the run with `job_list` and read it with `job_output`.
- **Settings saves and plugin reloads do not lose a run's outcome.** Settlement reaches the card by the board's path, whether or not that board is still open.
- **Several dsh processes can share a board.** A running card records which process and session own its run. A process only clears a marker whose owner has exited (or, for its own runs, whose job the registry no longer has), so one process never calls another's live run "interrupted", and a settlement only clears the marker of the run it belongs to. Markers written on another host are never cleared automatically — `UPDATE tasks SET running_job_id = NULL, run_owner = NULL WHERE …` clears one by hand, and the board notices.
- **Stopping and deleting work from any session.** A running card carries its own stop control, on the card and in its menu as well as in the detail. Deleting a card stops the run working it first — as the session that owns the job, so it works when you delete from a different session — and no subagent is left spending tokens on a task whose record has been thrown away. If the run belongs to another live dsh process, the delete is refused with a message saying so.

## Install

Add it to a `dsh` profile (`$DSH_HOME/profiles/<name>/package.json`):

```json
{
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@achasoft/dsh-tasks-manager"] } },
  "dependencies": { "@achasoft/dsh-tasks-manager": "^0.1.0" }
}
```

then `pnpm install` in the profile directory and run `dsh --profile <name>`.

Everything is composed by default — unlike a provider-backed capability, nothing here needs a deployment-specific answer to work.

## Configuration

Settings live in the Web Client under **Settings → Plugins → Task management**, and in your profile's `cordis.patch.yml`. A patch replaces a row's whole `config`, so restate every key the row needs.

| Key | Default | What it decides |
| --- | --- | --- |
| `databasePath` | `.dsh/tasks.db` | Relative resolves against each project's root, so every project gets its own board. Absolute pins every project to one shared board. |
| `projectRootMarkers` | `['.git']` | Walked upwards from the session's directory; the first match is the project root. |
| `defaultStatus` | `backlog` | Column a card lands in when its creator names none. |
| `newTaskPlacement` | `top` | Whether a new card goes to the start or end of its column. |
| `journalMode` | `wal` | SQLite journal pragma; change it only on a filesystem without WAL. |
| `busyTimeoutMs` | `5000` | How long a write waits behind another writer. |
| `pollIntervalMs` | `2000` | How stale the open board may be when a change came from elsewhere. Only a revision counter is polled. |
| `subagentProvider` | `''` | Which subagent provider a dispatched card runs on. Blank disables dispatch. |
| `dispatchStatus` | `in_progress` | Column a card moves to when dispatched; `none` leaves it. |
| `dispatchCompletedStatus` | `none` | Column a dispatched card moves to when its run completes. |
| `digestSize` | `25` | How many tasks `task_list` returns when sorting by urgency. |

The tools row (`tasks-tools`) carries its own two:

| Key | Default | What it decides |
| --- | --- | --- |
| `allowDelete` | `false` | Whether the model may permanently delete a card. Archiving is recoverable; deleting is not. |
| `defaultListLimit` | `50` | How many tasks `task_list` returns when the model names no limit. |

Disable the `tasks-tools` row alone to serve the board to people without giving the model write access to it.

## The database

One table per concern, plus a `board` view for reading by hand:

```
tasks     id, ref, title, body, status, priority, labels, assignee, rank,
          archived, created_at, updated_at, completed_at, archived_at,
          due_at, created_by, session_id, running_job_id, last_run,
          run_owner
comments  id, task_id, body, author, created_at, updated_at
activity  seq, task_id, kind, actor, at, from_value, to_value, session_id
meta      revision, next_ref
board     a readable projection of `tasks` with local-time dates, in board order
```

Some things worth knowing about it:

- **`ref` is never reused**, including after a delete, so `#12` in a commit message keeps pointing at the same card forever.
- **`rank` is a fractional index**, not a position. Dropping a card between two others mints a key between theirs, so a drag writes exactly one row and two people dragging at once cannot scramble a column.
- **`activity` is a real table**, not a diff reconstructed from timestamps — it answers "when did this move, and who moved it".
- **`run_owner`** is JSON — `{host, pid, instance, sessionId}` — naming the process and session that own a running card's job. It is set only while `running_job_id` is.
- **`meta.revision` is advanced by triggers** on `tasks` and `comments`, not by the plugin, so every writer moves it: this plugin, another dsh process, a script, `sqlite3`. Compare it for equality; the size of a step means nothing.
- Timestamps are epoch milliseconds; the `board` view converts them.
- The file is created `0600`. The layout version is stamped in `PRAGMA user_version` (currently **2**). A version-1 board, written by 0.2.2 and earlier, is upgraded automatically the first time this build opens it: in one transaction it gains the `run_owner` column, the revision triggers, and a `board` view in board order, and nothing is dropped or rewritten, so every card, comment and history entry reads as before. A running marker left by the old build has no owner and is cleared as interrupted. A database stamped with a version newer than this build knows is refused rather than altered. Copy `tasks.db` aside first if you want to be able to go back: an older build refuses an upgraded file.

Editing the database with `sqlite3` while the board is open is fine — the triggers move the revision, and the next poll picks the change up.

## How the two halves talk

The browser drives the board over `ctx.connection.rpc`, the harness's generic unary RPC channel, on `/dsh-tasks`. There is no Typert contract and no generated artifact, so this package builds and installs without a deepseek-harness checkout. It owns its own payload validation instead, in `src/domain/validate.ts` — the same code that validates the model's tool arguments, so the two callers cannot drift apart.

The board state is deliberately **not** in the session log. An out-of-tree plugin cannot append its own session event types: the persistence coordinator refuses to reload a log carrying a type absent from the harness's generated `KNOWN_SESSION_EVENT_TYPES`, and `Session.append` has no way to mark one ignorable. Freshness comes from polling one integer (`board.revision`) instead — which also covers what a session log never could: another session's writes, and your own `sqlite3` edits.

## Development

```bash
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
```

`pnpm run build` runs `tsc` for declarations, then `tsdown` for the two artifacts the harness's client module system expects: a plain-ESM node half that keeps every `@deepseek-ai/*` specifier as an import (so it shares the running installation's service singletons), and a browser half wrapped in the loader's `window.__ModuleLoader__.load` handoff with its CSS Modules inlined.

The `devDependencies` link a sibling `deepseek-harness` checkout for types. To develop against a different location, adjust the `link:` paths in `package.json`.

## Layout

```
src/domain/     the task vocabulary, fractional indexing, and validation — no node or browser imports
src/host/       the SQLite store, the RPC router, the settings section, and the job producer
src/tools/      the five model-facing tools
src/client/     the browser half: the Tasks view, the board components, and the settings card
```

## Licence

MIT
