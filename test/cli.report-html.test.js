import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  createRepo,
  defaultOutputFile,
  packageVersion,
  parseOutputPathFromStdout,
  parseReportDataFromHtml,
  runCli,
} from './cli.test-helpers.js'

test('running the bin creates a report in temp dir with expected shape', (t) => {
  const repoDir = createRepo(t)

  const result = runCli([], { cwd: repoDir })

  assert.equal(result.status, 0, result.stderr)
  const outputPath = parseOutputPathFromStdout(result.stdout)
  assert.ok(outputPath.startsWith(tmpdir()), 'default report should be written in a temp directory')
  assert.ok(existsSync(outputPath), 'default report should be written to disk')
  assert.equal(existsSync(path.join(repoDir, defaultOutputFile)), false, 'default report should not be written in repository root')
  assert.match(result.stdout, /Report ready at/)

  const html = readFileSync(outputPath, 'utf8')
  assert.match(html, /<title>CODEOWNERS Gap Report<\/title>/)
  assert.match(html, /alt="codeowners-audit logo"/, 'report header should include a logo image')
  assert.ok(
    html.includes(`https://raw.githubusercontent.com/watson/codeowners-audit/v${packageVersion}/assets/logo2-small.png`),
    'report logo should be loaded from the versioned raw GitHub asset path'
  )
  assert.match(html, /min-width:\s*0;/, 'panels should remain width-constrained on narrow screens')
  assert.match(html, /overflow-x:\s*auto;/, 'file list areas should use horizontal scrolling for long paths')

  const reportData = parseReportDataFromHtml(html)
  assert.equal(reportData.options.includeUntracked, false)
  assert.equal(Object.hasOwn(reportData, 'topLevel'), false)
  assert.ok(reportData.totals.files >= 3)
  assert.ok(reportData.unownedFiles.includes('src/unowned.js'))
  assert.equal(Array.isArray(reportData.teamOwnership), true)
  assert.equal(Array.isArray(reportData.directoryTeamSuggestions), true)
  assert.equal(reportData.directoryTeamSuggestions.length, 0)
  assert.equal(reportData.directoryTeamSuggestionsMeta.enabled, false)
  assert.deepEqual(reportData.directoryTeamSuggestionsMeta.ignoredTeams, [])
})

test('report includes team ownership index for @org/team owners', (t) => {
  const repoDir = createRepo(t, {
    codeowners: [
      '/src/owned.js @acme/platform @alice',
      '/src/dual.js @acme/platform @acme/security',
    ].join('\n') + '\n',
    trackedFiles: {
      'src/dual.js': 'module.exports = 3\n',
    },
  })

  const result = runCli([], { cwd: repoDir })
  assert.equal(result.status, 0, result.stderr)

  const outputPath = parseOutputPathFromStdout(result.stdout)
  const html = readFileSync(outputPath, 'utf8')
  const reportData = parseReportDataFromHtml(html)

  const platform = reportData.teamOwnership.find(row => row.team === '@acme/platform')
  assert.ok(platform, 'platform team should exist')
  assert.equal(platform.total, 2)
  assert.deepEqual(platform.files, ['src/dual.js', 'src/owned.js'])

  const security = reportData.teamOwnership.find(row => row.team === '@acme/security')
  assert.ok(security, 'security team should exist')
  assert.equal(security.total, 1)
  assert.deepEqual(security.files, ['src/dual.js'])

  assert.equal(reportData.teamOwnership.some(row => row.team === '@alice'), false)
})
