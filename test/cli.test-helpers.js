import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliPath = path.join(projectRoot, 'report.js')

export const packageVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
export const defaultOutputFile = 'codeowners-gaps-report.html'
export const DEFAULT_EXEC_FILE_MAX_BUFFER_BYTES = 1024 * 1024
export const GIT_BUFFER_STRESS_TARGET_BYTES = DEFAULT_EXEC_FILE_MAX_BUFFER_BYTES + (96 * 1024)
export const ZENBIN_UPLOAD_STRESS_TARGET_BYTES = 1280 * 1024

export function parseOutputPathFromStdout (stdout) {
  const match = stdout.match(/Report ready at (.+)/)
  assert.ok(match, 'stdout should include the report output path')
  return match[1].trim()
}

export function stripAnsi (value) {
  return String(value).replaceAll(/\u001b\[[0-9;]*m/g, '')
}

function buildCliEnv (options = {}) {
  return {
    ...process.env,
    CODEOWNERS_AUDIT_ASSUME_TTY: options.assumeTty === false ? '0' : '1',
    ...(options.env || {}),
  }
}

export function runCli (args, options = {}) {
  const cliArgs = options.noOpen === false ? args : ['--no-open', ...args]
  return spawnSync(process.execPath, [cliPath, ...cliArgs], {
    cwd: options.cwd,
    env: buildCliEnv(options),
    encoding: 'utf8',
    input: options.stdinData,
  })
}

export function runCliAsync (args, options = {}) {
  const cliArgs = options.noOpen === false ? args : ['--no-open', ...args]
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...cliArgs], {
      cwd: options.cwd,
      env: buildCliEnv(options),
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    child.stdin.end(options.stdinData === undefined ? '' : options.stdinData)
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', (status) => {
      resolve({
        status,
        stdout,
        stderr,
      })
    })
  })
}

export function runGit (cwd, args, options = {}) {
  execFileSync('git', args, {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      ...(options.env || {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function isoTimestampDaysAgo (daysAgo) {
  return new Date(Date.now() - (daysAgo * 24 * 60 * 60 * 1000)).toISOString()
}

export function commitStaged (repoDir, message, daysAgo, authorName, authorEmail) {
  const timestamp = isoTimestampDaysAgo(daysAgo)
  runGit(
    repoDir,
    [
      '-c', 'user.name=Codeowners Audit Tests',
      '-c', 'user.email=codeowners-audit-tests@example.com',
      'commit',
      '-m', message,
    ],
    {
      env: {
        GIT_AUTHOR_NAME: authorName,
        GIT_AUTHOR_EMAIL: authorEmail,
        GIT_AUTHOR_DATE: timestamp,
        GIT_COMMITTER_DATE: timestamp,
      },
    }
  )
}

export function createRepo (t, options = {}) {
  const repoDir = mkdtempSync(path.join(tmpdir(), 'codeowners-audit-test-'))
  t.after(() => {
    rmSync(repoDir, { recursive: true, force: true })
  })

  runGit(repoDir, ['init'])

  const files = {
    CODEOWNERS: options.codeowners || '/src/owned.js @team\n',
    'src/owned.js': 'module.exports = 1\n',
    'src/unowned.js': 'module.exports = 2\n',
    ...(options.trackedFiles || {}),
  }

  for (const [filePath, content] of Object.entries(files)) {
    const absolutePath = path.join(repoDir, filePath)
    mkdirSync(path.dirname(absolutePath), { recursive: true })
    writeFileSync(absolutePath, content, 'utf8')
  }

  runGit(repoDir, ['add', '.'])

  if (options.remoteUrl) {
    runGit(repoDir, ['remote', 'add', 'origin', options.remoteUrl])
  }

  if (options.untrackedFiles) {
    for (const [filePath, content] of Object.entries(options.untrackedFiles)) {
      const absolutePath = path.join(repoDir, filePath)
      mkdirSync(path.dirname(absolutePath), { recursive: true })
      writeFileSync(absolutePath, content, 'utf8')
    }
  }

  return repoDir
}

export function addTrackedBulkFilesForStress (repoDir, minimumGitListBytes) {
  const segmentA = 'a'.repeat(40)
  const segmentB = 'b'.repeat(40)
  const fileSuffix = 'c'.repeat(80)
  const bulkRelativeDir = path.posix.join('bulk', segmentA, segmentB)
  const bulkAbsoluteDir = path.join(repoDir, bulkRelativeDir)
  mkdirSync(bulkAbsoluteDir, { recursive: true })

  let fileCount = 0
  let estimatedGitListBytes = 0
  while (estimatedGitListBytes < minimumGitListBytes) {
    const fileName = `file-${String(fileCount).padStart(5, '0')}-${fileSuffix}.txt`
    writeFileSync(path.join(bulkAbsoluteDir, fileName), 'x\n', 'utf8')
    const relativePath = bulkRelativeDir + '/' + fileName
    estimatedGitListBytes += Buffer.byteLength(relativePath, 'utf8') + 1
    fileCount++
  }

  runGit(repoDir, ['add', 'bulk'])
  return { fileCount, estimatedGitListBytes }
}

export function parseReportDataFromHtml (html) {
  const match = html.match(/<script type="application\/json" id="report-data">([\s\S]*?)<\/script>/)
  assert.ok(match, 'report JSON should exist in report-data script tag')
  return JSON.parse(match[1])
}

export function getOpenCommandName () {
  if (process.platform === 'darwin') return 'open'
  if (process.platform === 'win32') return null
  return 'xdg-open'
}

export function writeFakeNodeScript (scriptPath, scriptLines) {
  if (process.platform === 'win32') {
    const cmdPath = scriptPath.endsWith('.cmd') ? scriptPath : scriptPath + '.cmd'
    const jsPath = scriptPath + '.js'
    writeFileSync(jsPath, scriptLines.join('\n'), 'utf8')
    writeFileSync(cmdPath, `@node "%~dp0${path.basename(jsPath)}" %*\r\n`, 'utf8')
  } else {
    writeFileSync(
      scriptPath,
      ['#!/usr/bin/env node', ...scriptLines, ''].join('\n'),
      'utf8'
    )
    chmodSync(scriptPath, 0o755)
  }
}
