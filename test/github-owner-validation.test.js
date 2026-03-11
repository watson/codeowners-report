import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { parseCodeowners } from '../lib/codeowners-parser.js'
import { validateGithubOwners } from '../lib/github-owner-validation.js'

function runGit (cwd, args) {
  execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function createRepo (t, options = {}) {
  const repoDir = mkdtempSync(path.join(tmpdir(), 'codeowners-audit-owner-validation-'))
  t.after(() => {
    rmSync(repoDir, { recursive: true, force: true })
  })

  runGit(repoDir, ['init'])
  runGit(repoDir, ['remote', 'add', 'origin', options.remoteUrl || 'git@github.com:test-org/test-repo.git'])

  for (const [filePath, content] of Object.entries(options.files || {})) {
    const absolutePath = path.join(repoDir, filePath)
    mkdirSync(path.dirname(absolutePath), { recursive: true })
    writeFileSync(absolutePath, content, 'utf8')
  }

  return repoDir
}

function createDescriptor (content) {
  return {
    path: 'CODEOWNERS',
    rules: parseCodeowners(content),
  }
}

test('validateGithubOwners throws when GitHub auth is unavailable', async (t) => {
  const repoDir = createRepo(t)
  const descriptor = createDescriptor('/src/app.js @octocat\n')

  await assert.rejects(
    validateGithubOwners(repoDir, descriptor, {
      githubToken: '',
      githubApiBaseUrl: 'https://api.github.com',
    }),
    /requires a GitHub token/
  )
})

test('validateGithubOwners filters invalid user owners and preserves non-GitHub owners', async (t) => {
  const repoDir = createRepo(t)
  const descriptor = createDescriptor('/src/app.js @good @missing docs@example.com\n')

  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    res.setHeader('content-type', 'application/json')
    if (url.pathname === '/repos/test-org/test-repo/collaborators/good/permission') {
      res.end(JSON.stringify({ permission: 'write' }))
      return
    }
    if (url.pathname === '/repos/test-org/test-repo/collaborators/missing/permission') {
      res.statusCode = 404
      res.end(JSON.stringify({ message: 'not found' }))
      return
    }
    if (url.pathname === '/users/missing') {
      res.statusCode = 404
      res.end(JSON.stringify({ message: 'not found' }))
      return
    }
    res.statusCode = 500
    res.end(JSON.stringify({ message: `unexpected path: ${url.pathname}` }))
  })
  await /** @type {Promise<void>} */ (
    new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  )
  t.after(() => { server.close() })

  const address = server.address()
  assert.ok(address && typeof address === 'object')

  const result = await validateGithubOwners(repoDir, descriptor, {
    githubToken: 'test-token',
    githubApiBaseUrl: `http://127.0.0.1:${address.port}`,
  })

  assert.deepEqual(descriptor.rules[0].effectiveOwners, ['@good', 'docs@example.com'])
  assert.equal(result.invalidOwnerWarnings.length, 1)
  assert.deepEqual(result.invalidOwnerWarnings[0].invalidOwners, [
    {
      owner: '@missing',
      ownerType: 'user',
      reason: 'was not found on GitHub.',
    },
  ])
})

test('validateGithubOwners preserves existing users when collaborator permission checks are forbidden', async (t) => {
  const repoDir = createRepo(t)
  const descriptor = createDescriptor('/src/app.js @octocat\n')

  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    res.setHeader('content-type', 'application/json')
    if (url.pathname === '/repos/test-org/test-repo/collaborators/octocat/permission') {
      res.statusCode = 403
      res.end(JSON.stringify({ message: 'Resource not accessible by integration' }))
      return
    }
    if (url.pathname === '/users/octocat') {
      res.end(JSON.stringify({ login: 'octocat' }))
      return
    }
    res.statusCode = 500
    res.end(JSON.stringify({ message: `unexpected path: ${url.pathname}` }))
  })
  await /** @type {Promise<void>} */ (
    new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  )
  t.after(() => { server.close() })

  const address = server.address()
  assert.ok(address && typeof address === 'object')

  const result = await validateGithubOwners(repoDir, descriptor, {
    githubToken: 'test-token',
    githubApiBaseUrl: `http://127.0.0.1:${address.port}`,
  })

  assert.deepEqual(descriptor.rules[0].effectiveOwners, ['@octocat'])
  assert.equal(result.invalidOwnerWarnings.length, 0)
  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings[0], /Could not verify repository write access for @octocat/)
})

test('validateGithubOwners marks teams without write access or visibility as invalid', async (t) => {
  const repoDir = createRepo(t)
  const descriptor = createDescriptor([
    '/src/owned.js @test-org/backend',
    '/src/read-only.js @test-org/readers',
    '/src/missing.js @test-org/missing',
  ].join('\n') + '\n')

  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    res.setHeader('content-type', 'application/json')
    if (url.pathname === '/repos/test-org/test-repo/teams') {
      res.end(JSON.stringify([
        { slug: 'backend', permission: 'push' },
        { slug: 'readers', permission: 'pull' },
      ]))
      return
    }
    if (url.pathname === '/orgs/test-org/teams/missing/repos/test-org/test-repo') {
      res.statusCode = 404
      res.end(JSON.stringify({ message: 'not found' }))
      return
    }
    if (url.pathname === '/orgs/test-org/teams/missing') {
      res.statusCode = 404
      res.end(JSON.stringify({ message: 'not found' }))
      return
    }
    res.statusCode = 500
    res.end(JSON.stringify({ message: `unexpected path: ${url.pathname}` }))
  })
  await /** @type {Promise<void>} */ (
    new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  )
  t.after(() => { server.close() })

  const address = server.address()
  assert.ok(address && typeof address === 'object')

  const result = await validateGithubOwners(repoDir, descriptor, {
    githubToken: 'test-token',
    githubApiBaseUrl: `http://127.0.0.1:${address.port}`,
  })

  assert.deepEqual(descriptor.rules[0].effectiveOwners, ['@test-org/backend'])
  assert.deepEqual(descriptor.rules[1].effectiveOwners, [])
  assert.deepEqual(descriptor.rules[2].effectiveOwners, [])
  assert.equal(result.invalidOwnerWarnings.length, 2)
  const warningByPattern = new Map(result.invalidOwnerWarnings.map(warning => [warning.pattern, warning]))
  assert.equal(
    warningByPattern.get('/src/read-only.js')?.invalidOwners[0].reason,
    'does not have write access to the repository.'
  )
  assert.equal(
    warningByPattern.get('/src/missing.js')?.invalidOwners[0].reason,
    'was not found on GitHub or is not visible.'
  )
})

test('validateGithubOwners accepts same-org teams when direct team repo access confirms write permission', async (t) => {
  const repoDir = createRepo(t)
  const descriptor = createDescriptor('/src/app.js @test-org/sdlc-security\n')

  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    res.setHeader('content-type', 'application/json')
    if (url.pathname === '/repos/test-org/test-repo/teams') {
      res.end(JSON.stringify([]))
      return
    }
    if (url.pathname === '/orgs/test-org/teams/sdlc-security/repos/test-org/test-repo') {
      res.end(JSON.stringify({
        permissions: {
          pull: true,
          push: true,
          admin: false,
          maintain: false,
          triage: false,
        },
      }))
      return
    }
    res.statusCode = 500
    res.end(JSON.stringify({ message: `unexpected path: ${url.pathname}` }))
  })
  await /** @type {Promise<void>} */ (
    new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  )
  t.after(() => { server.close() })

  const address = server.address()
  assert.ok(address && typeof address === 'object')

  const result = await validateGithubOwners(repoDir, descriptor, {
    githubToken: 'test-token',
    githubApiBaseUrl: `http://127.0.0.1:${address.port}`,
  })

  assert.deepEqual(descriptor.rules[0].effectiveOwners, ['@test-org/sdlc-security'])
  assert.equal(result.invalidOwnerWarnings.length, 0)
  assert.deepEqual(result.warnings, [])
})

test('validateGithubOwners preserves same-org teams when repository team APIs are inconclusive', async (t) => {
  const repoDir = createRepo(t)
  const descriptor = createDescriptor('/src/app.js @test-org/sdlc-security\n')

  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    res.setHeader('content-type', 'application/json')
    if (url.pathname === '/repos/test-org/test-repo/teams') {
      res.end(JSON.stringify([]))
      return
    }
    if (url.pathname === '/orgs/test-org/teams/sdlc-security/repos/test-org/test-repo') {
      res.statusCode = 404
      res.end(JSON.stringify({ message: 'not found' }))
      return
    }
    if (url.pathname === '/orgs/test-org/teams/sdlc-security') {
      res.end(JSON.stringify({ slug: 'sdlc-security' }))
      return
    }
    res.statusCode = 500
    res.end(JSON.stringify({ message: `unexpected path: ${url.pathname}` }))
  })
  await /** @type {Promise<void>} */ (
    new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  )
  t.after(() => { server.close() })

  const address = server.address()
  assert.ok(address && typeof address === 'object')

  const result = await validateGithubOwners(repoDir, descriptor, {
    githubToken: 'test-token',
    githubApiBaseUrl: `http://127.0.0.1:${address.port}`,
  })

  assert.deepEqual(descriptor.rules[0].effectiveOwners, ['@test-org/sdlc-security'])
  assert.equal(result.invalidOwnerWarnings.length, 0)
  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings[0], /Could not conclusively verify repository access for @test-org\/sdlc-security/)
})

test('validateGithubOwners still flags missing users when collaborator permission checks are forbidden', async (t) => {
  const repoDir = createRepo(t)
  const descriptor = createDescriptor('/src/app.js @ghost\n')

  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    res.setHeader('content-type', 'application/json')
    if (url.pathname === '/repos/test-org/test-repo/collaborators/ghost/permission') {
      res.statusCode = 403
      res.end(JSON.stringify({ message: 'Resource not accessible by integration' }))
      return
    }
    if (url.pathname === '/users/ghost') {
      res.statusCode = 404
      res.end(JSON.stringify({ message: 'not found' }))
      return
    }
    res.statusCode = 500
    res.end(JSON.stringify({ message: `unexpected path: ${url.pathname}` }))
  })
  await /** @type {Promise<void>} */ (
    new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  )
  t.after(() => { server.close() })

  const address = server.address()
  assert.ok(address && typeof address === 'object')

  const result = await validateGithubOwners(repoDir, descriptor, {
    githubToken: 'test-token',
    githubApiBaseUrl: `http://127.0.0.1:${address.port}`,
  })

  assert.deepEqual(descriptor.rules[0].effectiveOwners, [])
  assert.equal(result.invalidOwnerWarnings.length, 1)
  assert.equal(result.invalidOwnerWarnings[0].invalidOwners[0].reason, 'was not found on GitHub.')
  assert.equal(result.warnings.length, 0)
})
