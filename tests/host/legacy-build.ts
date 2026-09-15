/**
 * The running-marker writes of the version-1 build (0.2.2, `fb9a15f`), statement for statement.
 *
 * A process still running that build keeps its board handle across another process's upgrade, and
 * keeps issuing exactly these statements against the upgraded file. Tests that care what such a
 * process can do to a newer run use these rather than an approximation written against today's
 * schema. The meta revision bump is left out: the version-2 triggers move the revision on their own.
 */

import { DatabaseSync } from 'node:sqlite'
import type { TaskRunSummary } from '../../src/domain/types.ts'

/**
 * Run a function against a board file inside one immediate transaction, as the old build's
 * `#transaction` did, on a connection of its own.
 * @param path - the board database file.
 * @param work - the statements to run.
 */
function inOldProcess(path: string, work: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA busy_timeout = 1000')
    db.exec('BEGIN IMMEDIATE')
    try {
      work(db)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  } finally {
    db.close()
  }
}

/**
 * The version-1 `startRun`: mark the card without recording any owner.
 * @param path - the board database file.
 * @param taskId - the card.
 * @param jobId - the old process's job id.
 * @param sessionId - the session that dispatched it.
 * @param now - epoch ms stamped on the card and the history.
 */
export function legacyStartRun(path: string, taskId: string, jobId: string, sessionId: string, now: number): void {
  inOldProcess(path, (db) => {
    db.prepare('UPDATE tasks SET running_job_id = ?, updated_at = ? WHERE id = ?').run(jobId, now, taskId)
    db.prepare('INSERT INTO activity (task_id, kind, actor, at, from_value, to_value, session_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(taskId, 'run-started', 'user', now, null, jobId, sessionId)
  })
}

/**
 * The version-1 `finishRun`: clear the card's running state by card id alone.
 * @param path - the board database file.
 * @param taskId - the card.
 * @param summary - the old run's outcome.
 * @param now - epoch ms stamped on the card and the history.
 * @throws the database's error when the upgraded board refuses the write.
 */
export function legacyFinishRun(path: string, taskId: string, summary: TaskRunSummary, now: number): void {
  inOldProcess(path, (db) => {
    db.prepare('UPDATE tasks SET running_job_id = NULL, last_run = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(summary), now, taskId)
    db.prepare('INSERT INTO activity (task_id, kind, actor, at, from_value, to_value, session_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(taskId, 'run-finished', 'system', now, summary.jobId, summary.status, null)
  })
}
