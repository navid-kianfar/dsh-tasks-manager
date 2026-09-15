-- The board layout at version 2, exactly as @achasoft/dsh-tasks-manager at 56e7f03 (unreleased) created it,
-- dumped from sqlite_master. Kept verbatim so the 2 -> 3 upgrade runs against a real version-2 file.
CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT;

CREATE TABLE tasks (
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
    last_run       TEXT,
    run_owner      TEXT
  ) STRICT;

CREATE TABLE comments (
    id         TEXT    PRIMARY KEY,
    task_id    TEXT    NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    body       TEXT    NOT NULL,
    author     TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;

CREATE TABLE activity (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    TEXT    NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    kind       TEXT    NOT NULL,
    actor      TEXT    NOT NULL,
    at         INTEGER NOT NULL,
    from_value TEXT,
    to_value   TEXT,
    session_id TEXT
  ) STRICT;

CREATE INDEX idx_tasks_board    ON tasks(archived, status, rank);

CREATE INDEX idx_tasks_updated  ON tasks(updated_at DESC);

CREATE INDEX idx_comments_task  ON comments(task_id, created_at);

CREATE INDEX idx_activity_task  ON activity(task_id, seq);

CREATE INDEX idx_tasks_running  ON tasks(running_job_id) WHERE running_job_id IS NOT NULL;

CREATE TRIGGER tasks_insert_revision AFTER INSERT ON tasks
  BEGIN
    UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'revision';
  END;

CREATE TRIGGER tasks_update_revision AFTER UPDATE ON tasks
  BEGIN
    UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'revision';
  END;

CREATE TRIGGER tasks_delete_revision AFTER DELETE ON tasks
  BEGIN
    UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'revision';
  END;

CREATE TRIGGER comments_insert_revision AFTER INSERT ON comments
  BEGIN
    UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'revision';
  END;

CREATE TRIGGER comments_update_revision AFTER UPDATE ON comments
  BEGIN
    UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'revision';
  END;

CREATE TRIGGER comments_delete_revision AFTER DELETE ON comments
  BEGIN
    UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'revision';
  END;

CREATE VIEW board AS
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
    ORDER BY archived, CASE status WHEN 'backlog' THEN 0 WHEN 'todo' THEN 1 WHEN 'in_progress' THEN 2 WHEN 'blocked' THEN 3 WHEN 'done' THEN 4 ELSE 5 END, rank;
