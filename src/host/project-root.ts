/**
 * Deciding which project a session's board belongs to.
 *
 * The harness has no project-scoped storage seam and no `ctx.project`: the only project-shaped fact
 * a session carries is its `cwd`. A board keyed on the raw `cwd` would split in two the moment
 * someone opened a session in a subdirectory, so the root is the nearest ancestor carrying one of
 * the configured markers — `.git` by default, matching how the harness's own agent-instructions
 * package finds a project root.
 *
 * @module @achasoft/dsh-tasks-manager/host/project-root
 */

import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/**
 * Walk up from a directory to the nearest ancestor holding one of the markers.
 *
 * Falls back to the starting directory when no ancestor matches, so a session opened outside any
 * repository still gets a board of its own rather than none. The walk stops at the filesystem root.
 * @param from - absolute directory to start at.
 * @param markers - entry names that mark a project root, checked in order at each level.
 * @returns the resolved project root.
 */
export function findProjectRoot(from: string, markers: readonly string[]): string {
  const start = resolve(from)
  let current = start
  for (;;) {
    for (const marker of markers) {
      if (existsSync(join(current, marker))) return current
    }
    const parent = dirname(current)
    if (parent === current) return start
    current = parent
  }
}

/**
 * The project root a session's board belongs to.
 * @param cwd - the session's working directory, absent for a session created without one.
 * @param markers - entry names that mark a project root.
 * @returns the project root, or `undefined` when the session names no directory at all.
 */
export function projectRootFor(cwd: string | undefined, markers: readonly string[]): string | undefined {
  // A session header's cwd is validated absolute at creation, but a session restored from a log
  // written elsewhere is a file boundary, so the check is worth its one line.
  if (cwd === undefined || !isAbsolute(cwd)) return undefined
  return findProjectRoot(cwd, markers)
}
