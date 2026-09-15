/**
 * Who has committed to this project, read from `git log`.
 *
 * The board's assignee is a person on the team, and the only roster a project reliably carries is
 * its own commit history. Reading it here rather than keeping a list of our own means the picker is
 * right the moment someone's first commit lands, and there is nothing to maintain.
 *
 * Forking `git` is cheap but not free, so the result is cached per project for {@link CACHE_TTL_MS}:
 * a card opened, closed, and opened again costs one subprocess, not three. Every failure — no git on
 * PATH, a directory that is not a repository, a read that times out — folds into an empty,
 * unavailable directory rather than an error, because a board must still be editable in a project
 * that is not under version control.
 *
 * @module @achasoft/dsh-tasks-manager/host/git-authors
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** How long a project's author list is reused before git is asked again. */
export const CACHE_TTL_MS = 60_000

/** How many commits back the history is read. Deep enough for any real team, bounded for speed. */
const COMMIT_SCAN_LIMIT = 5000

/** How long `git` may take before the read is abandoned. */
const GIT_TIMEOUT_MS = 5000

/** Output cap for the log read; a scan of 5000 commits is far below it. */
const GIT_MAX_BUFFER = 4 * 1024 * 1024

/**
 * The separator between the two fields of one log line.
 *
 * ASCII unit separator: the one byte that cannot appear inside a name or an email address, so a
 * person called `Ada | Lovelace` still parses as one field.
 */
const FIELD = '\u001F'

/** One person who has committed to the project. */
export interface GitAuthor {
  /** The name as they most recently spelled it in a commit. */
  name: string
  /** Their commit email, lowercased; the identity two spellings of a name merge on. */
  email: string
  /** How many of the scanned commits are theirs. */
  commits: number
  /** Whether this is the identity `git config user.email` names in this project. */
  self?: boolean
}

/** A project's committers, and whether git could be read at all. */
export interface GitAuthorDirectoryResult {
  /** The committers, most prolific first. */
  authors: GitAuthor[]
  /**
   * Whether the answer came from a readable repository. `false` means git is absent, the project is
   * not a repository, or the read failed — the picker says so rather than showing an empty team.
   */
  available: boolean
}

/** Nothing to offer, because git could not be read. */
const UNAVAILABLE: GitAuthorDirectoryResult = Object.freeze({ authors: [], available: false })

/**
 * Configuration overrides that keep a read from running anything the repository names.
 *
 * The project directory is untrusted input — a fresh clone, an extracted archive, whatever a session
 * was opened in — and its `.git/config` may name programs git will execute on an ordinary read. The
 * Tasks view reads authors automatically when it opens, so a hostile repository must not be able to
 * turn "open the board" into "run my script". `-c` on the command line outranks every config file.
 *
 * - `log.showSignature=false`: with it `true`, `git log` runs `gpg.program` (or `gpg.ssh.program`)
 *   on every signed commit, whatever `--format` asks for. Reproduced on git 2.50.1.
 * - `core.fsmonitor=false`: a path here is a hook git runs whenever it consults the index. `log`
 *   and `config` do not today, but the override costs nothing and survives a future git that does.
 * - `core.pager=cat`: belt and braces — a pager only starts on a terminal, and this read has none.
 *
 * What is left is not executable: `include.path` pulls in more config files (whose values these
 * overrides still outrank), and `mailmap.file` is read, not run. Diff drivers and textconv only run
 * when a diff is produced, which `--format` without `-p` never does.
 */
const SAFE_CONFIG = [
  '-c', 'log.showSignature=false',
  '-c', 'core.fsmonitor=false',
  '-c', 'core.pager=cat',
] as const

/**
 * Run one git command in a project, returning its stdout.
 *
 * Every invocation goes through {@link SAFE_CONFIG} and `--no-pager`, so no caller can forget them.
 * @param root - the repository's working directory.
 * @param args - arguments after the global options.
 * @returns stdout, or `undefined` when git failed for any reason.
 */
async function git(root: string, args: readonly string[]): Promise<string | undefined> {
  try {
    const { stdout } = await run('git', ['--no-pager', ...SAFE_CONFIG, '-C', root, ...args], {
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      windowsHide: true,
      encoding: 'utf8',
    })
    return stdout
  } catch {
    return undefined
  }
}

/**
 * Fold `git log` output into a de-duplicated, ranked author list.
 *
 * Identity is the lowercased email, so `Ada L.` and `Ada Lovelace` committing from one address are
 * one person. The name kept is the first one seen and the log is newest-first, so someone who has
 * since changed how they spell their name appears the way they spell it now.
 * @param stdout - the log output, one `name<US>email` line per commit.
 * @returns the authors, most prolific first, ties broken by name.
 */
export function parseAuthorLog(stdout: string): GitAuthor[] {
  const byIdentity = new Map<string, GitAuthor>()
  for (const line of stdout.split('\n')) {
    const at = line.indexOf(FIELD)
    if (at < 0) continue
    const name = line.slice(0, at).trim()
    const email = line.slice(at + 1).trim().toLowerCase()
    // An identity with neither field is a broken commit object, not a teammate.
    const key = email !== '' ? email : name.toLowerCase()
    if (key === '') continue
    const existing = byIdentity.get(key)
    if (existing === undefined) byIdentity.set(key, { name: name === '' ? email : name, email, commits: 1 })
    else existing.commits++
  }
  return [...byIdentity.values()].sort((a, b) => b.commits - a.commits || a.name.localeCompare(b.name))
}

/**
 * Merge the identity `git config` names into a list read from the history.
 *
 * Someone who has configured this repository but not yet committed to it still belongs in the
 * picker — they are the likeliest assignee of all, being the person at the keyboard.
 * @param authors - the authors read from the log.
 * @param name - `git config user.name`, when set.
 * @param email - `git config user.email`, when set.
 * @returns the list with the configured identity marked, and added when it was absent.
 */
export function withConfiguredIdentity(
  authors: readonly GitAuthor[],
  name: string | undefined,
  email: string | undefined,
): GitAuthor[] {
  const self = (email ?? '').trim().toLowerCase()
  const selfName = (name ?? '').trim()
  if (self === '' && selfName === '') return [...authors]
  const key = self !== '' ? self : selfName.toLowerCase()
  const found = authors.find(author => (author.email !== '' ? author.email : author.name.toLowerCase()) === key)
  if (found !== undefined) {
    return authors.map(author => (author === found ? { ...author, self: true } : author))
  }
  // Unshifted rather than appended: with no commits it would otherwise sort last, which is exactly
  // backwards for the one identity we know is present.
  return [{ name: selfName === '' ? self : selfName, email: self, commits: 0, self: true }, ...authors]
}

/**
 * A per-project cache over `git log`.
 *
 * One instance lives on the service, so every session sharing a project shares one subprocess
 * budget. Entries expire on read; nothing is evicted in the background, because the map holds one
 * small record per project a board was opened in.
 */
export class GitAuthorDirectory {
  /** Cached answers by project root, with the epoch ms they were read at. */
  private readonly cache = new Map<string, { at: number; value: GitAuthorDirectoryResult }>()
  /** Reads already running, by project root, so a burst of callers shares one subprocess. */
  private readonly inFlight = new Map<string, Promise<GitAuthorDirectoryResult>>()

  /**
   * @param ttlMs - how long an answer is reused before git is asked again.
   */
  constructor(private readonly ttlMs = CACHE_TTL_MS) {}

  /**
   * The committers of one project.
   * @param root - the project root, as the board resolved it.
   * @param now - epoch ms, for the cache's age check.
   * @returns the authors, or an unavailable result when git could not be read.
   */
  async read(root: string, now: number): Promise<GitAuthorDirectoryResult> {
    const cached = this.cache.get(root)
    if (cached !== undefined && now - cached.at < this.ttlMs) return cached.value

    const pending = this.inFlight.get(root)
    if (pending !== undefined) return pending

    const work = this.load(root)
      .then((value) => {
        this.cache.set(root, { at: Date.now(), value })
        return value
      })
      .finally(() => { this.inFlight.delete(root) })
    this.inFlight.set(root, work)
    return work
  }

  /** Drop every cached answer, so the next read forks git again. */
  clear(): void {
    this.cache.clear()
  }

  /**
   * Read one project's authors from git, without consulting the cache.
   * @param root - the project root.
   * @returns the authors, or an unavailable result.
   */
  private async load(root: string): Promise<GitAuthorDirectoryResult> {
    // `--no-show-signature` as well as the config override: the flag states the intent at the call
    // site, and the override covers the config-file route the flag was added alongside.
    const log = await git(root, [
      'log',
      '--no-show-signature',
      `--max-count=${COMMIT_SCAN_LIMIT}`,
      `--format=%an${FIELD}%ae`,
    ])
    // A repository with no commits yet answers with empty output rather than failing, so `undefined`
    // is the only signal that git itself could not be reached.
    if (log === undefined) return UNAVAILABLE

    const [name, email] = await Promise.all([
      git(root, ['config', '--get', 'user.name']),
      git(root, ['config', '--get', 'user.email']),
    ])
    return {
      authors: withConfiguredIdentity(parseAuthorLog(log), name?.trim(), email?.trim()),
      available: true,
    }
  }
}
