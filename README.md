# @achasoft/dsh-tasks-manager

A project task board for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`). Each project gets a SQLite database at `<project>/.dsh/tasks.db`. The Web Client gets a **Tasks** tab with a kanban board, a list view, the session's `todo_write` checklist, and a panel of background jobs. The model gets tools to add, list, update, and comment on cards. When a subagent provider is configured, you can dispatch a card to run as a background job; the result is recorded on the card.

![The Tasks tab showing the kanban board with Backlog, To do, In progress, Blocked and Done columns, priorities, labels, due dates, and the database path in the footer](https://raw.githubusercontent.com/navid-kianfar/dsh-tasks-manager/main/docs/screenshots/tasks-board.png)

## Features

### The Tasks tab

A **Tasks** tab sits beside Chat and Trajectory in every session and shows the board of that session's project. The toolbar switches between four layouts (**Board**, **List**, **Session**, **Background**) and has a search box (titles and descriptions), a **Filters** menu (status, priority, labels, assignee, active/archived/all), **Refresh**, and **New task**. The footer shows the database path.

- **Board**: five columns (`backlog`, `todo`, `in_progress`, `blocked`, `done`) with drag and drop between and within columns, a quick-add per column, and a per-card menu (Open, Dispatch to agent, Stop the background run, Archive or Restore, Delete permanently).
- **List**: one row per card, sortable by column.

![The List layout showing ref, title, labels, status, priority, assignee, due date, and updated columns](https://raw.githubusercontent.com/navid-kianfar/dsh-tasks-manager/main/docs/screenshots/tasks-list-view.png)

The open board polls a revision counter every `pollIntervalMs` and re-reads cards only when it changes. Changes made by the agent, another session, another `dsh` process, or `sqlite3` therefore appear without a reload.

### Card detail

Opening a card shows an editable title, a Markdown description, status and priority pickers, a due-date calendar, label chips completed from labels already on the board, comments you can edit and delete, a **History** of every change, and the last run's outcome.

The **Assignee** picker lists people who have committed to the project, from `git log` (last 5,000 commits), ranked by commit count, with the identity from `git config user.email` marked *you*. A value already on a card that is not in the history stays selectable. In a directory without git history, the picker says so.

![A card detail panel with status, priority, assignee, due date, labels, and a Markdown description with a checklist](https://raw.githubusercontent.com/navid-kianfar/dsh-tasks-manager/main/docs/screenshots/tasks-card-detail.png)

Field edits made in the detail, and moves on the board (drag or keyboard), are sent with the card's `updatedAt` as it was when the change began: when you entered the title or opened the description editor, or picked the card up. Your own earlier edits to the card carry that stamp forward. If anyone else changed the card in the meantime, the change is refused, the board shows the message, and the board and card reload.

### Session checklist

The **Session** layout shows the checklist the assistant keeps with `todo_write` for this session, with progress, and an **Add to board** action that copies an unfinished step onto the board.

### Background jobs and dispatch

The **Background** layout lists every background job the session can see: shell commands, subagents, and dispatched cards, with status, elapsed time, and a **Stop** control. **Read output** shows a dispatched card's final report. For other job kinds the output is withheld, because the job registry has one consuming read cursor per job, and that cursor belongs to the agent's `job_output`.

When `subagentProvider` is set, **Dispatch to agent** starts the card as a background job on that subagent provider. The prompt includes the card's title, status, priority, labels, assignee, description, and comments. While it runs:

- the card shows **Running** with a stop control, and moves to `dispatchStatus`;
- the owning agent is not woken when the run finishes (the plugin holds the job's completion notice), but `job_list` and `job_output` still show it.

When it ends, the card's last run records the status (`completed`, `failed`, or `killed`). The subagent's output, or for a failed run its diagnostic and partial output, is added as a comment and returned by `job_output`. On `completed`, the card moves to `dispatchCompletedStatus` unless that is `none`. The outcome is recorded by database path, so it still reaches the card after a settings save or plugin reload.

Deleting a running card first stops its run, acting as the session that owns the job. If the run belongs to another live `dsh` process, the delete is refused.

### Settings card

**Settings → Plugins → Task management** edits the fields marked in [Configuration](#configuration).

![The Task management settings card expanded, showing database location, column and position for new tasks, refresh interval, subagent for dispatch, dispatch column moves, and digest size](https://raw.githubusercontent.com/navid-kianfar/dsh-tasks-manager/main/docs/screenshots/tasks-settings-card.png)

## Requirements

- **Harness:** tested with `@deepseek-ai/dsh` 0.1.5-rc.2.
- **Node.js:** `^22.19 || >=24` (`engines` in `package.json`). The board uses the built-in `node:sqlite` module (`DatabaseSync`); there is no native dependency to install. Some Node versions print an `ExperimentalWarning` for it.
- **pnpm** on `PATH`: `dsh plugin` forwards to it.
- **git** on `PATH` (optional): only needed for the assignee picker.
- **Harness services:** peer dependencies are `@deepseek-ai/cordis`, `dsh-agent`, `dsh-client-connection`, `dsh-host-apiproxy`, `dsh-jobs`, `dsh-session`, `dsh-tool-todo`, `dsh-tools`, `dsh-typert-protocol`, and `schemastery`. Every host-side service is read optionally, and features degrade when it is absent:

| Service | Provided by (standard `dsh-base` / web profile) | Without it |
| --- | --- | --- |
| `sessions` | core harness | The RPC channel resolves only sessions found through persistence. |
| `agents` | core harness | Dispatch fails. |
| `sessionPersistence` | `dsh-session-persistence-jsonl` | A tab on a session that is no longer live cannot find its board. |
| `connection`, `webServer` | web profile | No `/dsh-tasks` RPC channel (headless); tools still work. |
| `jobs` | `dsh-jobs-local` | Dispatch and the Background layout are unavailable. |
| `subagents` + a named provider | `dsh-subagent-*` (`spawn`, `fork` in `dsh-base`) | Dispatch is hidden. |
| `todos` projection | `dsh-tool-todo` | The Session layout says the checklist is unavailable. |
| `settings` | `dsh-settings-file` | No Settings card or live edits; the patch row is used. |

The browser half needs `dsh-api-remotes`, `dsh-client-locale`, `dsh-client-ui-conversation`, `dsh-client-ui-layout`, `dsh-client-ui-settings`, `dsh-client-ui-settings-plugins`, and `dsh-client-ui-sidebar`.

## Install

```bash
dsh plugin --profile web add @achasoft/dsh-tasks-manager
dsh web
```

`dsh plugin --profile <name> <args>` runs `pnpm <args>` in `$DSH_HOME/profiles/<name>` (`$DSH_HOME` defaults to `~/.dsh`) and creates the profile on first use. After a successful `add`, any dependency whose `package.json` declares `dsh.bundle` is appended to `dsh.profile.bundles`.

At boot the harness composes the profile from patch layers, in this order: each bundle's `cordis.patch.yml`, the profile's own `cordis.patch.yml`, `$DSH_HOME/cordis.patch.yml`, then `--patch <file>` overlays. This package's patch inserts three rows, all enabled:

| Row `id` | Loads |
| --- | --- |
| `tasks` | `@achasoft/dsh-tasks-manager/host`: the board, the RPC channel, settings, dispatch |
| `tasks-tools` | `@achasoft/dsh-tasks-manager/tools`: model-facing tools |
| `tasks-ui` | `@achasoft/dsh-tasks-manager`: the browser half |

To enable dispatch, set `subagentProvider` in the Settings card or in a patch (see below).

To keep the board for people but give the model no access, disable the tools row:

```yaml
- id: tasks-tools
  disabled: true
```

To uninstall:

```bash
dsh plugin --profile web remove @achasoft/dsh-tasks-manager
```

Remove any rows in your own patch files that target the ids above. `.dsh/tasks.db` files in your projects are left in place.

## Configuration

Override a row from your profile's `cordis.patch.yml` by `id`. A patch replaces the row's whole `config`, so restate every key:

```yaml
- id: tasks
  config:
    databasePath: .dsh/tasks.db
    projectRootMarkers:
      - .git
    defaultStatus: backlog
    newTaskPlacement: top
    journalMode: wal
    busyTimeoutMs: 5000
    pollIntervalMs: 2000
    subagentProvider: spawn
    dispatchStatus: in_progress
    dispatchCompletedStatus: none
    digestSize: 25
```

The patch row is the base layer. Values saved from the Settings card go to the harness settings layer (the `tasks:` section of `$DSH_HOME/settings.yaml`) and take precedence. Saving a change closes and reopens every open board.

### `tasks` row

| Key | Default | In Settings card | What it does |
| --- | --- | --- | --- |
| `databasePath` | `.dsh/tasks.db` | yes | Relative paths resolve against the project root. An absolute path makes every project share one board. |
| `projectRootMarkers` | `['.git']` | no | Entry names looked for from the session directory upwards. The first match is the project root; with no match, the session directory is the root. |
| `defaultStatus` | `backlog` | yes | Column for a card created without one: `task_add` without `status`, **Add to board** from the checklist, and the toolbar's **New task** composer. When a status filter hides this column, the composer uses the first filtered column so the card stays in view. A column's own quick-add always uses that column. |
| `newTaskPlacement` | `top` | yes | `top` or `bottom` of the column. |
| `journalMode` | `wal` | no | `wal`, `delete`, `truncate`, or `persist`. |
| `busyTimeoutMs` | `5000` | no | How long a write waits for another writer. |
| `pollIntervalMs` | `2000` | yes | Revision poll interval for an open board; minimum 250. |
| `subagentProvider` | `''` | yes | Subagent provider name for dispatch. Empty hides dispatch. |
| `dispatchStatus` | `in_progress` | yes | Column a card moves to on dispatch; `none` leaves it. |
| `dispatchCompletedStatus` | `none` | yes | Column a card moves to when its run completes; `none` leaves it. |
| `digestSize` | `25` | yes | Cards `task_list` returns with `sort: urgency` and no `limit`; 1–200. |

### `tasks-tools` row

| Key | Default | What it does |
| --- | --- | --- |
| `allowDelete` | `false` | Registers `task_delete`. Archiving is recoverable; deleting is not. |
| `defaultListLimit` | `50` | Cards `task_list` returns with no `limit`; 1–200. |

Neither key is editable in the Settings card.

## Model-facing tools

Tools resolve the board from the calling agent's session directory. Cards can be referred to as `#12`, `12`, or the full `t_…` id. Tool writes are recorded in history as `agent`.

| Tool | What it does |
| --- | --- |
| `task_add` | Add one or more cards in one transaction (title, body, status, priority, labels, assignee, due date `YYYY-MM-DD`). |
| `task_list` | Read the board with filters (`status`, `priority`, `labels`, `assignee`, `search`, `archived`, `limit`). `sort: urgency` returns only unfinished, unarchived cards, most pressing first. |
| `task_update` | Change title, body, status, priority, labels (replaces the set), assignee, due date, or `archived`. |
| `task_comment` | Add a Markdown comment. |
| `task_delete` | Permanently delete a card, its comments, and history, stopping any run first. Registered only with `allowDelete: true`. |

Limits: title 200 characters, body and comment 20,000, up to 20 labels of 40 characters, assignee 80.

## RPC

The browser half talks to the host over the harness's unary RPC channel at `/dsh-tasks`. The route is mounted on the web server behind the connection's request gate (Host/Origin check and browser token). Every request carries a `sessionId`; the host resolves the board from that session's working directory, and the browser never sends a filesystem path. Validation errors, unknown cards, and stale edits and moves come back as `bad-request`.

Endpoints: `board.read`, `board.revision`, `task.detail`, `task.create`, `task.update` (optional `expectedUpdatedAt`), `task.move` (optional `expectedUpdatedAt`), `task.archive`, `task.restore`, `task.delete`, `comment.add`, `comment.edit`, `comment.remove`, `task.dispatch`, `jobs.list`, `jobs.read`, `jobs.kill`, `git.authors`.

## Data and storage

- **Location:** `<project root>/.dsh/tasks.db`. The directory is created `0700` and the file `0600`; an existing file keeps its mode.
- **Tables:** `tasks`, `comments`, `activity` (per-change history), `meta` (`revision`, `next_ref`), and a `board` view for reading by hand:

```bash
sqlite3 .dsh/tasks.db "select card, title, status, assignee from board where state = 'active'"
```

- **`ref`** comes from `meta.next_ref` and is never reused, including after a delete.
- **`rank`** is a fractional-index string, so a drag writes one row.
- **`meta.revision`** is advanced by triggers on `tasks` and `comments`, so every writer moves it, including `sqlite3`.
- **Sharing:** several `dsh` processes on one host can use the same board. Each process keeps one handle per database file. Do not run two `dsh` servers against the same `$DSH_HOME`.
- **Backups:** SQLite's online backup works while `dsh` is running:

```bash
sqlite3 .dsh/tasks.db ".backup tasks-backup.db"
```

### Upgrading from layout version 1

The layout version is stored in `PRAGMA user_version`; this build writes version **2**. Boards created by the published 0.2.2 and earlier are version 1. The first time this build opens one, it upgrades the file in place, in one transaction: it adds the `tasks.run_owner` column, installs the revision triggers, and recreates the `board` view. No rows are dropped or rewritten.

Copy the file aside before the first start, because the upgrade is one-way:

```bash
cp .dsh/tasks.db .dsh/tasks.v1-backup.db
```

After the upgrade:

- An older build process that already had the board open keeps working and its writes still move the revision. An older build that opens the file afterwards refuses it, because it only reads version 1. A file stamped with a version newer than this build is refused in the same way.
- A running marker without an owner (written by an older build) is cleared as interrupted the next time this build opens the board. Do not dispatch from an older and a newer build against the same board at the same time.

### Run ownership and stale markers

A running card stores `running_job_id` and `run_owner`, a JSON object `{host, pid, instance, sessionId}`. A process clears a marker only when:

- the marker has no owner or an unreadable one;
- its owner process on the same host has exited; or
- the marker is this process's own run, and the job registry reports the job settled or no longer knows it.

Markers from another live process are left alone. **Markers owned on another host are never cleared automatically.** To clear one by hand (the board picks it up on the next poll):

```bash
sqlite3 .dsh/tasks.db "UPDATE tasks SET running_job_id = NULL, run_owner = NULL WHERE ref = 12"
```

## Security and trust model

- **Git reads are hardened.** The assignee picker runs `git --no-pager -c log.showSignature=false -c core.fsmonitor=false -c core.pager=cat -C <root> log --no-show-signature …`, plus two `git config --get` calls, with a 5-second timeout and a 4 MB output cap. A repository's own `.git/config` cannot make opening the board run `gpg.program` or an fsmonitor hook. Nothing is written to git. Results are cached per project for 60 seconds.
- **Runs are stopped as their owner.** **Stop** on a job the session can see acts as that session, the same as `job_kill`. A card's run started by another session in this process is stopped as its owning session, and only if the job's kind is `task`. A hand-edited `running_job_id` that points at someone's shell job cannot be used to stop that job.
- **Deletes respect other processes.** A card whose run belongs to another live process cannot be deleted from this one.
- **The model cannot delete by default.** `task_delete` is only registered with `allowDelete: true`.
- **Job output is not taken from the agent.** The board reads output only for its own `task` jobs, which return final output without consuming the agent's read cursor.

## Known limitations

- **Markers owned on another host are never auto-cleared.** See [Run ownership](#run-ownership-and-stale-markers).
- **Dispatch needs a live session.** A tab on a session that is no longer live can read and edit the board but cannot dispatch.
- **Board state is not in the session log.** An out-of-tree plugin cannot add session event types, so history lives only in `tasks.db`.

## Development

The `devDependencies` link a `deepseek-harness` checkout at `../../deepseek-harness`, relative to this repository, for types and tests. `pnpm install` expects it there.

```bash
pnpm install
pnpm run typecheck
pnpm test
pnpm run build        # tsc for declarations, then tsdown for the node and browser bundles
```

There is no Typert contract to regenerate: the channel's payloads are validated in `src/domain/validate.ts` and `src/host/index.ts`.

To run a checkout in a local profile, add it by path and restart the web server:

```bash
dsh plugin --profile web add link:/absolute/path/to/dsh-tasks-manager
dsh web
```

A linked package resolves its imports from its own directory, so the harness packages it imports must resolve there to the same copies the running harness uses. The maintainers' workspace does this with `publish-plugins.sh` and `.dsh-compat/install-plugins.sh` in the parent `dsh-plugins` directory, not in this repository. After a rebuild, restart `dsh web`.

## License

MIT
