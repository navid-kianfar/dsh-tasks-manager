-- The board layout at version 1, exactly as @achasoft/dsh-tasks-manager 0.2.2 (fb9a15f) created it.
-- Kept verbatim so the upgrade is tested against the real old shape, not against today's schema minus a column.
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS tasks (
    id             TEXT    PRIMARY KEY,
    ref            INTEGER NOT NULL UNIQUE,
    title          TEXT    NOT NULL,
    body           TEXT    NOT NULL DEFAULT '',
    status         TEXT    NOT NULL,
    priority       TEXT    NOT NULL,
    labels         TEXT    NOT NULL DEFAULT '[]',
    assignee       TEXT,
    rank           TEXT    NOT NULL,
    archived       INTEGER NOT NULL DEFAULT 0,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL,
    completed_at   INTEGER,
    archived_at    INTEGER,
    due_at         INTEGER,
    created_by     TEXT    NOT NULL,
    session_id     TEXT,
    running_job_id TEXT,
    last_run       TEXT
  ) STRICT;

  CREATE TABLE IF NOT EXISTS comments (
    id         TEXT    PRIMARY KEY,
    task_id    TEXT    NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    body       TEXT    NOT NULL,
    author     TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS activity (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    TEXT    NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    kind       TEXT    NOT NULL,
    actor      TEXT    NOT NULL,
    at         INTEGER NOT NULL,
    from_value TEXT,
    to_value   TEXT,
    session_id TEXT
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_tasks_board    ON tasks(archived, status, rank);
  CREATE INDEX IF NOT EXISTS idx_tasks_updated  ON tasks(updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_comments_task  ON comments(task_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_activity_task  ON activity(task_id, seq);

  -- A readable projection for people running sqlite3 against this file by hand. Timestamps are
  -- stored as epoch milliseconds because that is what both halves of the plugin speak; the view
  -- converts them so a hand query does not have to.
  CREATE VIEW IF NOT EXISTS board AS
    SELECT
      '#' || ref                                                    AS card,
      title,
      status,
      priority,
      CASE WHEN archived = 1 THEN 'archived' ELSE 'active' END      AS state,
      assignee,
      labels,
      datetime(created_at / 1000, 'unixepoch', 'localtime')         AS created,
      datetime(updated_at / 1000, 'unixepoch', 'localtime')         AS updated,
      id
    FROM tasks
    ORDER BY archived, status, rank;
