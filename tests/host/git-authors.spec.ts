/**
 * Reading a project's committers.
 *
 * The folding is tested against synthetic log output — that is where the identity rules live — and
 * the reader is tested against a real repository, because the one thing a mock cannot tell us is
 * whether the `git log` invocation is right.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitAuthorDirectory, parseAuthorLog, withConfiguredIdentity } from '../../src/host/git-authors.ts'

/** The separator git writes between the two fields of one log line. */
const US = '\u001F'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * A throwaway git repository with one commit per author named.
 * @param commits - `[name, email]` pairs, oldest first.
 * @returns the repository's path.
 */
function repository(commits: readonly (readonly [string, string])[]): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-tasks-git-'))
  roots.push(root)
  const git = (...args: string[]): void => {
    execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' })
  }
  git('init', '--quiet')
  git('config', 'user.name', 'Config Person')
  git('config', 'user.email', 'config@example.com')
  git('config', 'commit.gpgsign', 'false')
  for (const [index, [name, email]] of commits.entries()) {
    writeFileSync(join(root, `file-${index}.txt`), String(index))
    git('add', '.')
    execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', `commit ${index}`], {
      stdio: 'ignore',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: name,
        GIT_AUTHOR_EMAIL: email,
        GIT_COMMITTER_NAME: name,
        GIT_COMMITTER_EMAIL: email,
      },
    })
  }
  return root
}

describe('parseAuthorLog', () => {
  it('ranks committers by how much of the project is theirs', () => {
    const authors = parseAuthorLog([
      `Ada${US}ada@example.com`,
      `Grace${US}grace@example.com`,
      `Ada${US}ada@example.com`,
      `Ada${US}ada@example.com`,
    ].join('\n'))

    expect(authors).toEqual([
      { name: 'Ada', email: 'ada@example.com', commits: 3 },
      { name: 'Grace', email: 'grace@example.com', commits: 1 },
    ])
  })

  it('merges two spellings of one address, keeping the most recent name', () => {
    // git log is newest-first, so the first line is how they spell it now.
    const authors = parseAuthorLog([
      `Ada Lovelace${US}ADA@example.com`,
      `ada l${US}ada@example.com`,
    ].join('\n'))

    expect(authors).toEqual([{ name: 'Ada Lovelace', email: 'ada@example.com', commits: 2 }])
  })

  it('keeps a committer who has a name but no address', () => {
    expect(parseAuthorLog(`Nameless${US}`)).toEqual([{ name: 'Nameless', email: '', commits: 1 }])
  })

  it('drops a commit object with neither field rather than offering a blank row', () => {
    expect(parseAuthorLog(`${US}\n \n`)).toEqual([])
  })

  it('reads an empty log as an empty roster, not as a failure', () => {
    expect(parseAuthorLog('')).toEqual([])
  })
})

describe('withConfiguredIdentity', () => {
  it('marks the configured identity when they have already committed', () => {
    const authors = withConfiguredIdentity(
      [{ name: 'Ada', email: 'ada@example.com', commits: 2 }],
      'Ada',
      'ADA@example.com',
    )
    expect(authors).toEqual([{ name: 'Ada', email: 'ada@example.com', commits: 2, self: true }])
  })

  it('offers the configured identity first even with no commits behind it', () => {
    const authors = withConfiguredIdentity(
      [{ name: 'Grace', email: 'grace@example.com', commits: 9 }],
      'Ada',
      'ada@example.com',
    )
    expect(authors[0]).toEqual({ name: 'Ada', email: 'ada@example.com', commits: 0, self: true })
    expect(authors).toHaveLength(2)
  })

  it('changes nothing when the repository configures no identity', () => {
    const source = [{ name: 'Ada', email: 'ada@example.com', commits: 1 }]
    expect(withConfiguredIdentity(source, undefined, undefined)).toEqual(source)
  })
})

describe('GitAuthorDirectory', () => {
  it('reads a real repository, ranked, with the configured identity marked', async () => {
    const root = repository([
      ['Ada', 'ada@example.com'],
      ['Grace', 'grace@example.com'],
      ['Ada', 'ada@example.com'],
    ])
    const result = await new GitAuthorDirectory().read(root, Date.now())

    expect(result.available).toBe(true)
    expect(result.authors.map(author => [author.name, author.commits])).toEqual([
      ['Config Person', 0],
      ['Ada', 2],
      ['Grace', 1],
    ])
    expect(result.authors[0]?.self).toBe(true)
  })

  it('reports a directory that is not a repository as unavailable rather than empty', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-tasks-nogit-'))
    roots.push(root)
    // A directory outside any repository: `git log` fails, which is the case the picker must be
    // able to tell apart from a repository with no commits.
    const result = await new GitAuthorDirectory().read(root, Date.now())

    expect(result).toEqual({ authors: [], available: false })
  })

  it('serves a second read inside the window without forking git again', async () => {
    const root = repository([['Ada', 'ada@example.com']])
    const directory = new GitAuthorDirectory(60_000)
    const first = await directory.read(root, 1_000)

    // A commit landing between the two reads is invisible until the entry expires — which is the
    // trade the cache exists to make.
    execFileSync('git', ['-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'later'], {
      stdio: 'ignore',
      env: { ...process.env, GIT_AUTHOR_NAME: 'Grace', GIT_AUTHOR_EMAIL: 'grace@example.com', GIT_COMMITTER_NAME: 'Grace', GIT_COMMITTER_EMAIL: 'grace@example.com' },
    })

    expect(await directory.read(root, 1_000)).toBe(first)
    expect((await directory.read(root, Date.now() + 120_000)).authors.map(a => a.name))
      .toContain('Grace')
  })

  it('shares one subprocess between callers that arrive together', async () => {
    const root = repository([['Ada', 'ada@example.com']])
    const directory = new GitAuthorDirectory()
    const [first, second] = await Promise.all([
      directory.read(root, Date.now()),
      directory.read(root, Date.now()),
    ])

    expect(first).toBe(second)
  })

  it('never runs an executable the repository configures, even with signature display turned on', async () => {
    const root = repository([['Ada', 'ada@example.com']])
    const marker = join(root, 'gpg-ran')
    const fakeGpg = join(root, 'fake-gpg.sh')
    writeFileSync(fakeGpg, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`)
    chmodSync(fakeGpg, 0o755)
    const git = (...args: string[]): string =>
      execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
    // A repository is untrusted input: a clone, an extracted archive, a directory a session was
    // pointed at. Its `.git/config` can name any program, and `log.showSignature` makes `git log`
    // run `gpg.program` for every signed commit whatever `--format` asks for.
    git('config', 'gpg.program', fakeGpg)
    git('config', 'log.showSignature', 'true')
    git('config', 'core.fsmonitor', fakeGpg)
    // A commit carrying a signature header, written as a raw object so the test needs no real gpg.
    const tree = git('rev-parse', 'HEAD^{tree}')
    const parent = git('rev-parse', 'HEAD')
    const object = [
      `tree ${tree}`,
      `parent ${parent}`,
      'author Mallory <mallory@example.com> 1700000000 +0000',
      'committer Mallory <mallory@example.com> 1700000000 +0000',
      'gpgsig -----BEGIN PGP SIGNATURE-----',
      ' ',
      ' iQEzBAABCAAdFiEE',
      ' -----END PGP SIGNATURE-----',
      '',
      'signed-looking commit',
      '',
    ].join('\n')
    const signed = execFileSync('git', ['-C', root, 'hash-object', '-t', 'commit', '-w', '--stdin'], {
      input: object,
      encoding: 'utf8',
    }).trim()
    git('update-ref', 'HEAD', signed)
    // Prove the trap is armed: a plain `git log` in this repository does run the program.
    execFileSync('git', ['-C', root, 'log', '-1', '--format=%an'], { stdio: 'ignore' })
    expect(existsSync(marker)).toBe(true)
    rmSync(marker)

    const result = await new GitAuthorDirectory().read(root, Date.now())

    expect(result.available).toBe(true)
    expect(result.authors.map(author => author.name)).toContain('Mallory')
    expect(existsSync(marker)).toBe(false)
  })
})
