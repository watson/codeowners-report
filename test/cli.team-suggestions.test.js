import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import test from 'node:test'

import {
  commitStaged,
  createRepo,
  parseReportDataFromHtml,
  runCli,
  runCliAsync,
  runGit,
} from './cli.test-helpers.js'

test('team suggestions map editors to repo teams for 0% covered directories', async (t) => {
  const repoDir = createRepo(t, {
    remoteUrl: 'git@github.com:test-org/test-repo.git',
    trackedFiles: {
      'pkg/uncovered/a.js': 'module.exports = "a1"\n',
      'pkg/uncovered/b.js': 'module.exports = "b1"\n',
    },
  })

  commitStaged(repoDir, 'initial snapshot outside window', 500, 'Bootstrap', 'bootstrap@example.com')

  writeFileSync(path.join(repoDir, 'pkg/uncovered/a.js'), 'module.exports = "a2"\n', 'utf8')
  runGit(repoDir, ['add', 'pkg/uncovered/a.js'])
  commitStaged(repoDir, 'alice update 1', 30, 'Alice', '123+alice@users.noreply.github.com')

  writeFileSync(path.join(repoDir, 'pkg/uncovered/a.js'), 'module.exports = "a3"\n', 'utf8')
  runGit(repoDir, ['add', 'pkg/uncovered/a.js'])
  commitStaged(repoDir, 'alice update 2', 20, 'Alice', '123+alice@users.noreply.github.com')

  writeFileSync(path.join(repoDir, 'pkg/uncovered/b.js'), 'module.exports = "b2"\n', 'utf8')
  runGit(repoDir, ['add', 'pkg/uncovered/b.js'])
  commitStaged(repoDir, 'bob update', 10, 'Bob', '456+bob@users.noreply.github.com')

  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    res.setHeader('content-type', 'application/json')
    if (url.pathname === '/repos/test-org/test-repo/teams') {
      res.end(JSON.stringify([
        { slug: 'alpha-team', name: 'Alpha Team' },
        { slug: 'beta-team', name: 'Beta Team' },
      ]))
      return
    }
    if (url.pathname === '/orgs/test-org/teams/alpha-team/members') {
      res.end(JSON.stringify([
        { login: 'alice' },
      ]))
      return
    }
    if (url.pathname === '/orgs/test-org/teams/beta-team/members') {
      res.end(JSON.stringify([
        { login: 'bob' },
      ]))
      return
    }
    res.statusCode = 404
    res.end(JSON.stringify({ message: 'not found' }))
  })
  await /** @type {Promise<void>} */ (
    new Promise((resolve) => {
      server.listen(0, '127.0.0.1', resolve)
    })
  )
  t.after(() => {
    server.close()
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const apiBaseUrl = `http://127.0.0.1:${address.port}`

  const result = await runCliAsync(
    [
      '--suggest-teams',
      '--github-org', 'test-org',
      '--github-token', 'test-token',
      '--github-api-base-url', apiBaseUrl,
      '--output', 'team-suggestions.html',
    ],
    {
      cwd: repoDir,
    }
  )
  assert.equal(result.status, 0, result.stderr)

  const html = readFileSync(path.join(repoDir, 'team-suggestions.html'), 'utf8')
  const reportData = parseReportDataFromHtml(html)
  assert.equal(reportData.directoryTeamSuggestionsMeta.enabled, true)
  assert.equal(reportData.directoryTeamSuggestionsMeta.org, 'test-org')
  assert.equal(reportData.directoryTeamSuggestionsMeta.source, 'repo-teams')
  assert.equal(reportData.directoryTeamSuggestionsMeta.tokenSource, 'cli')
  assert.equal(JSON.stringify(reportData).includes('test-token'), false)

  const suggestion = reportData.directoryTeamSuggestions.find(row => row.path === 'pkg/uncovered')
  assert.ok(suggestion, 'should include suggestion for the uncovered folder')
  assert.equal(suggestion.status, 'ok')
  assert.equal(suggestion.candidates[0].team, '@test-org/alpha-team')
  assert.equal(suggestion.totalEdits, 3)
  assert.equal(suggestion.mappedEdits, 3)
})

test('team suggestions return no-auth status when token is missing', (t) => {
  const repoDir = createRepo(t, {
    remoteUrl: 'git@github.com:test-org/test-repo.git',
    trackedFiles: {
      'pkg/uncovered/a.js': 'module.exports = "a1"\n',
    },
  })

  commitStaged(repoDir, 'initial snapshot', 500, 'Bootstrap', 'bootstrap@example.com')
  writeFileSync(path.join(repoDir, 'pkg/uncovered/a.js'), 'module.exports = "a2"\n', 'utf8')
  runGit(repoDir, ['add', 'pkg/uncovered/a.js'])
  commitStaged(repoDir, 'alice update', 10, 'Alice', '123+alice@users.noreply.github.com')

  const result = runCli(
    [
      '--suggest-teams',
      '--github-org', 'test-org',
      '--output', 'no-auth-suggestions.html',
    ],
    {
      cwd: repoDir,
      env: {
        GITHUB_TOKEN: '',
        GH_TOKEN: '',
      },
    }
  )
  assert.equal(result.status, 0, result.stderr)
  const html = readFileSync(path.join(repoDir, 'no-auth-suggestions.html'), 'utf8')
  const reportData = parseReportDataFromHtml(html)

  const suggestion = reportData.directoryTeamSuggestions.find(row => row.path === 'pkg/uncovered')
  assert.ok(suggestion, 'should include suggestion diagnostics for uncovered folder')
  assert.equal(suggestion.status, 'no-auth')
  assert.equal(reportData.directoryTeamSuggestionsMeta.enabled, true)
  assert.match(
    reportData.directoryTeamSuggestionsMeta.warnings.join('\n'),
    /Missing GitHub token/
  )
})

test('team suggestions fall back to GITHUB_TOKEN env when --github-token is omitted', async (t) => {
  const repoDir = createRepo(t, {
    remoteUrl: 'git@github.com:test-org/test-repo.git',
    trackedFiles: {
      'pkg/uncovered/a.js': 'module.exports = "a1"\n',
      'pkg/uncovered/b.js': 'module.exports = "b1"\n',
    },
  })

  commitStaged(repoDir, 'initial snapshot outside window', 500, 'Bootstrap', 'bootstrap@example.com')

  writeFileSync(path.join(repoDir, 'pkg/uncovered/a.js'), 'module.exports = "a2"\n', 'utf8')
  runGit(repoDir, ['add', 'pkg/uncovered/a.js'])
  commitStaged(repoDir, 'alice update 1', 30, 'Alice', '123+alice@users.noreply.github.com')

  writeFileSync(path.join(repoDir, 'pkg/uncovered/a.js'), 'module.exports = "a3"\n', 'utf8')
  runGit(repoDir, ['add', 'pkg/uncovered/a.js'])
  commitStaged(repoDir, 'alice update 2', 20, 'Alice', '123+alice@users.noreply.github.com')

  writeFileSync(path.join(repoDir, 'pkg/uncovered/b.js'), 'module.exports = "b2"\n', 'utf8')
  runGit(repoDir, ['add', 'pkg/uncovered/b.js'])
  commitStaged(repoDir, 'bob update', 10, 'Bob', '456+bob@users.noreply.github.com')

  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    res.setHeader('content-type', 'application/json')
    if (url.pathname === '/repos/test-org/test-repo/teams') {
      res.end(JSON.stringify([
        { slug: 'alpha-team', name: 'Alpha Team' },
        { slug: 'beta-team', name: 'Beta Team' },
      ]))
      return
    }
    if (url.pathname === '/orgs/test-org/teams/alpha-team/members') {
      res.end(JSON.stringify([
        { login: 'alice' },
      ]))
      return
    }
    if (url.pathname === '/orgs/test-org/teams/beta-team/members') {
      res.end(JSON.stringify([
        { login: 'bob' },
      ]))
      return
    }
    res.statusCode = 404
    res.end(JSON.stringify({ message: 'not found' }))
  })
  await /** @type {Promise<void>} */ (
    new Promise((resolve) => {
      server.listen(0, '127.0.0.1', resolve)
    })
  )
  t.after(() => {
    server.close()
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const apiBaseUrl = `http://127.0.0.1:${address.port}`

  const result = await runCliAsync(
    [
      '--suggest-teams',
      '--github-org', 'test-org',
      '--github-api-base-url', apiBaseUrl,
      '--output', 'team-suggestions-env-fallback.html',
    ],
    {
      cwd: repoDir,
      env: {
        GITHUB_TOKEN: 'test-token',
        GH_TOKEN: '',
      },
    }
  )
  assert.equal(result.status, 0, result.stderr)

  const html = readFileSync(path.join(repoDir, 'team-suggestions-env-fallback.html'), 'utf8')
  const reportData = parseReportDataFromHtml(html)
  const suggestion = reportData.directoryTeamSuggestions.find(row => row.path === 'pkg/uncovered')
  assert.ok(suggestion, 'should include suggestion for the uncovered folder')
  assert.equal(suggestion.status, 'ok')
  assert.equal(reportData.directoryTeamSuggestionsMeta.tokenSource, 'GITHUB_TOKEN')
  assert.equal(JSON.stringify(reportData).includes('test-token'), false)
})

test('team suggestions support ignored team list', async (t) => {
  const repoDir = createRepo(t, {
    remoteUrl: 'git@github.com:test-org/test-repo.git',
    trackedFiles: {
      'pkg/uncovered/a.js': 'module.exports = "a1"\n',
      'pkg/uncovered/b.js': 'module.exports = "b1"\n',
    },
  })

  commitStaged(repoDir, 'initial snapshot outside window', 500, 'Bootstrap', 'bootstrap@example.com')

  writeFileSync(path.join(repoDir, 'pkg/uncovered/a.js'), 'module.exports = "a2"\n', 'utf8')
  runGit(repoDir, ['add', 'pkg/uncovered/a.js'])
  commitStaged(repoDir, 'alice update 1', 30, 'Alice', '123+alice@users.noreply.github.com')

  writeFileSync(path.join(repoDir, 'pkg/uncovered/a.js'), 'module.exports = "a3"\n', 'utf8')
  runGit(repoDir, ['add', 'pkg/uncovered/a.js'])
  commitStaged(repoDir, 'alice update 2', 20, 'Alice', '123+alice@users.noreply.github.com')

  writeFileSync(path.join(repoDir, 'pkg/uncovered/b.js'), 'module.exports = "b2"\n', 'utf8')
  runGit(repoDir, ['add', 'pkg/uncovered/b.js'])
  commitStaged(repoDir, 'bob update', 10, 'Bob', '456+bob@users.noreply.github.com')

  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    res.setHeader('content-type', 'application/json')
    if (url.pathname === '/repos/test-org/test-repo/teams') {
      res.end(JSON.stringify([
        { slug: 'alpha-team', name: 'Alpha Team' },
        { slug: 'beta-team', name: 'Beta Team' },
      ]))
      return
    }
    if (url.pathname === '/orgs/test-org/teams/alpha-team/members') {
      res.end(JSON.stringify([{ login: 'alice' }]))
      return
    }
    if (url.pathname === '/orgs/test-org/teams/beta-team/members') {
      res.end(JSON.stringify([{ login: 'bob' }]))
      return
    }
    res.statusCode = 404
    res.end(JSON.stringify({ message: 'not found' }))
  })
  await /** @type {Promise<void>} */ (
    new Promise((resolve) => {
      server.listen(0, '127.0.0.1', resolve)
    })
  )
  t.after(() => {
    server.close()
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const apiBaseUrl = `http://127.0.0.1:${address.port}`

  const result = await runCliAsync(
    [
      '--suggest-teams',
      '--github-org', 'test-org',
      '--github-token', 'test-token',
      '--github-api-base-url', apiBaseUrl,
      '--suggest-ignore-teams', 'alpha-team',
      '--output', 'ignore-team-suggestions.html',
    ],
    {
      cwd: repoDir,
    }
  )
  assert.equal(result.status, 0, result.stderr)

  const html = readFileSync(path.join(repoDir, 'ignore-team-suggestions.html'), 'utf8')
  const reportData = parseReportDataFromHtml(html)
  const suggestion = reportData.directoryTeamSuggestions.find(row => row.path === 'pkg/uncovered')
  assert.ok(suggestion)
  assert.equal(suggestion.status, 'ok')
  assert.equal(suggestion.candidates[0].team, '@test-org/beta-team')
  assert.deepEqual(reportData.directoryTeamSuggestionsMeta.ignoredTeams, ['alpha-team'])
})
