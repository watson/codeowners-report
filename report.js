#!/usr/bin/env node
/* eslint-disable no-console */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  parseArgs,
  printUsage,
  UPLOAD_PROVIDER,
} from './lib/cli-args.js'
import { outputUnownedReportResults } from './lib/cli-output.js'
import {
  parseCodeowners,
  parseCodeownersRuleLine,
  createPatternMatcher,
} from './lib/codeowners-parser.js'
import { runGitCommand, toPosixPath, formatCommandError } from './lib/git.js'
import { createProgressLogger } from './lib/progress.js'
import {
  isInteractiveStdin,
  promptForFullClone,
  promptForCodeownersHistoryClone,
  promptForReportOpen,
  openReportInBrowser,
} from './lib/prompts.js'
import { buildReport, FILE_ANALYSIS_PROGRESS_INTERVAL } from './lib/report-builder.js'
import { renderHtml, packageVersion } from './lib/report-renderer.js'
import {
  isRepoUrl,
  normalizeRepoUrl,
  resolveRepoWebUrl,
} from './lib/repository.js'
import { collectDirectoryTeamSuggestions } from './lib/team-suggestions.js'
import { uploadReport } from './lib/upload.js'
const SUPPORTED_CODEOWNERS_PATHS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']
const SUPPORTED_CODEOWNERS_PATHS_LABEL = SUPPORTED_CODEOWNERS_PATHS.join(', ')
const EXIT_CODE_RUNTIME_ERROR = 2

main()

/**
 * Run the report generation flow.
 * @returns {Promise<void>}
 */
async function main () {
  let clonedTempDir = null
  try {
    const options = parseArgs(process.argv.slice(2))
    const interactiveStdin = isInteractiveStdin()

    if (options.version) {
      console.log(packageVersion)
      return
    }

    if (options.help) {
      printUsage()
      return
    }

    if (!interactiveStdin) {
      options.open = false
      options.listUnowned = true
      options.failOnUnowned = true
      console.log('Standard input is non-interactive; defaulting to --no-open --list-unowned --fail-on-unowned.')
    }
    if (options.noReport && options.upload) {
      throw new Error('--no-report cannot be combined with --upload because no HTML report is generated.')
    }
    if (options.noReport) {
      options.open = false
      options.listUnowned = true
    }

    let cloneUrl = null
    const remoteRepoUrl = options.repoOrPath !== undefined && isRepoUrl(options.repoOrPath)
      ? options.repoOrPath
      : undefined

    if (remoteRepoUrl !== undefined) {
      cloneUrl = normalizeRepoUrl(remoteRepoUrl)
      const shallow = !options.teamSuggestions

      if (!shallow) {
        console.log('Full repository clone required for --suggest-teams (this may take longer for large repositories).')
        if (interactiveStdin && !options.yes) {
          const confirmed = await promptForFullClone(cloneUrl)
          if (!confirmed) {
            console.log('Clone aborted.')
            return
          }
        }
      }

      clonedTempDir = mkdtempSync(path.join(tmpdir(), 'codeowners-audit-'))
      console.log('Cloning %s...', cloneUrl)
      try {
        const cloneArgs = shallow
          ? ['clone', ...(options.verbose ? [] : ['--quiet']), '--depth', '1', cloneUrl, clonedTempDir]
          : ['clone', ...(options.verbose ? [] : ['--quiet']), cloneUrl, clonedTempDir]
        execFileSync('git', cloneArgs, {
          stdio: ['ignore', 'ignore', options.verbose ? 'inherit' : 'pipe'],
        })
      } catch (cloneError) {
        rmSync(clonedTempDir, { recursive: true, force: true })
        clonedTempDir = null
        throw new Error(`Failed to clone repository: ${cloneUrl}\n${formatCommandError(cloneError)}`)
      }
    }

    let commandWorkingDir
    if (clonedTempDir) {
      commandWorkingDir = clonedTempDir
    } else if (options.repoOrPath !== undefined) {
      commandWorkingDir = path.resolve(options.repoOrPath)
    } else {
      commandWorkingDir = options.workingDir ? path.resolve(options.workingDir) : process.cwd()
    }

    const repoRoot = runGitCommand(['rev-parse', '--show-toplevel'], commandWorkingDir).trim()

    const allRepoFiles = listRepoFiles(options.includeUntracked, repoRoot)
    const discoveredCodeownersPaths = listDiscoveredCodeownersPaths(allRepoFiles)
    const codeownersPath = resolveActiveCodeownersPath(discoveredCodeownersPaths)
    if (!codeownersPath) {
      throw new Error(buildMissingSupportedCodeownersError(discoveredCodeownersPaths))
    }

    const historyProgress = createProgressLogger(options.verbose)
    const codeownersDescriptor = loadCodeownersDescriptor(repoRoot, codeownersPath)
    const discoveryWarnings = collectCodeownersDiscoveryWarnings(discoveredCodeownersPaths, codeownersPath)
    let missingPathWarnings = collectMissingCodeownersPathWarnings(codeownersDescriptor, allRepoFiles)
    if (!options.noReport && missingPathWarnings.length > 0) {
      const historyReady = await ensureCodeownersHistoryAvailability(
        repoRoot,
        {
          allowFetch: Boolean(clonedTempDir),
          interactive: interactiveStdin,
          assumeYes: options.yes,
          cloneUrl,
          progress: historyProgress,
        }
      )
      if (historyReady) {
        const repoWebUrl = resolveRepoWebUrl(repoRoot)
        const missingPathHistoryByPattern = collectCodeownersPatternHistory(
          repoRoot,
          codeownersDescriptor,
          repoWebUrl
        )
        missingPathWarnings = collectMissingCodeownersPathWarnings(
          codeownersDescriptor,
          allRepoFiles,
          missingPathHistoryByPattern
        )
      }
    }

    const scopeFilteredFiles = filterFilesByCliGlobs(allRepoFiles, options.checkGlobs)

    const outputAbsolutePath = clonedTempDir
      ? path.resolve(process.cwd(), options.outputPath)
      : path.resolve(repoRoot, options.outputPath)
    const outputRelativePath = toPosixPath(path.relative(repoRoot, outputAbsolutePath))
    const filesToAnalyze = scopeFilteredFiles.filter(filePath => filePath !== outputRelativePath)
    const progress = createProgressLogger(
      options.verbose && (options.teamSuggestions || filesToAnalyze.length >= FILE_ANALYSIS_PROGRESS_INTERVAL)
    )
    progress('Scanning %d files against CODEOWNERS rules...', filesToAnalyze.length)
    const report = buildReport(repoRoot, filesToAnalyze, codeownersDescriptor, options, progress)
    report.codeownersValidationMeta = {
      discoveryWarnings,
      discoveryWarningCount: discoveryWarnings.length,
      missingPathWarnings,
      missingPathWarningCount: missingPathWarnings.length,
    }
    progress(
      'Coverage analysis complete: %d files, %d owned, %d unowned.',
      report.totals.files,
      report.totals.owned,
      report.totals.unowned
    )
    if (options.teamSuggestions && !options.noReport) {
      progress('Starting team suggestions for uncovered 0%-coverage directories...')
      const suggestionData = await collectDirectoryTeamSuggestions(repoRoot, report, options, {
        progress,
        runGitCommand,
        toPosixPath,
        formatCommandError,
      })
      report.directoryTeamSuggestions = suggestionData.suggestions
      report.directoryTeamSuggestionsMeta = suggestionData.meta
      progress(
        'Team suggestion phase complete: %d directory suggestions generated.',
        suggestionData.suggestions.length
      )
    }
    if (!options.noReport) {
      const html = renderHtml(report)

      mkdirSync(path.dirname(outputAbsolutePath), { recursive: true })
      writeFileSync(outputAbsolutePath, html, 'utf8')
    }

    outputUnownedReportResults(report, {
      ...options,
      showCoverageSummary: options.noReport || !interactiveStdin,
    })

    if (!options.noReport) {
      /** @type {string} */
      let reportLocation = outputAbsolutePath
      if (options.upload) {
        const uploadUrl = await uploadReport(outputAbsolutePath)
        reportLocation = uploadUrl
        console.log('Uploaded report (%s): %s', UPLOAD_PROVIDER, uploadUrl)
      }

      console.log('Report ready at %s', reportLocation)

      if (options.open) {
        const shouldOpen = options.yes ? true : await promptForReportOpen(reportLocation)
        if (shouldOpen) {
          try {
            openReportInBrowser(reportLocation)
            console.log('Opened report in browser.')
          } catch (error) {
            console.warn(
              'Could not open report in browser (%s). Re-run with --no-open to disable the open prompt.',
              formatCommandError(error)
            )
          }
        }
      }
    }
    if (clonedTempDir) {
      rmSync(clonedTempDir, { recursive: true, force: true })
      clonedTempDir = null
    }
  } catch (error) {
    if (clonedTempDir) {
      rmSync(clonedTempDir, { recursive: true, force: true })
      clonedTempDir = null
    }
    console.error('Failed to generate CODEOWNERS gap report:')
    console.error(String(error && error.stack ? error.stack : error))
    process.exit(EXIT_CODE_RUNTIME_ERROR)
  }
}

/**
 * Build a file matcher for CLI check globs.
 * @param {string[]} patterns
 * @returns {(filePath: string) => boolean}
 */
function createCliGlobMatcher (patterns) {
  const matchers = patterns.map(pattern => createPatternMatcher(pattern))
  return (filePath) => matchers.some(matches => matches(filePath))
}

/**
 * Filter file paths by the configured CLI glob set.
 * @param {string[]} files
 * @param {string[]} patterns
 * @returns {string[]}
 */
function filterFilesByCliGlobs (files, patterns) {
  const matcher = createCliGlobMatcher(patterns)
  return files.filter(filePath => matcher(filePath))
}


/**
 * Detect whether the repository is shallow.
 * @param {string} repoRoot
 * @returns {boolean}
 */
function isShallowRepository (repoRoot) {
  try {
    return runGitCommand(['rev-parse', '--is-shallow-repository'], repoRoot).trim() === 'true'
  } catch {
    return false
  }
}

/**
 * Ensure CODEOWNERS history can be trusted before rendering blame-style links.
 * For temp clones created from remote URLs we can safely deepen history.
 * For user repositories we avoid mutating clone depth and simply skip history.
 * @param {string} repoRoot
 * @param {{
 *   allowFetch?: boolean,
 *   interactive?: boolean,
 *   assumeYes?: boolean,
 *   cloneUrl?: string|null,
 *   progress?: (message: string, ...values: any[]) => void
 * }} options
 * @returns {Promise<boolean>}
 */
async function ensureCodeownersHistoryAvailability (repoRoot, options = {}) {
  if (!isShallowRepository(repoRoot)) {
    return true
  }

  if (!options.allowFetch) {
    return false
  }

  if (!options.assumeYes) {
    if (!options.interactive) {
      return false
    }
    const targetLabel = options.cloneUrl || 'this repository'
    console.log(
      'Full repository history required to show CODEOWNERS pattern age and commit links ' +
      '(this may take longer).'
    )
    const confirmed = await promptForCodeownersHistoryClone(targetLabel)
    if (!confirmed) {
      console.log('Skipping CODEOWNERS history links.')
      return false
    }
  }

  try {
    if (typeof options.progress === 'function') {
      options.progress('Deepening shallow clone to resolve CODEOWNERS history...')
    }
    runGitCommand(['fetch', '--quiet', '--unshallow'], repoRoot)
  } catch {
    return false
  }

  return !isShallowRepository(repoRoot)
}

/**
 * List repository files as POSIX-style relative paths.
 * @param {boolean} includeUntracked
 * @param {string} repoRoot
 * @returns {string[]}
 */
function listRepoFiles (includeUntracked, repoRoot) {
  const args = includeUntracked
    ? ['ls-files', '-z', '--cached', '--others', '--exclude-standard']
    : ['ls-files', '-z']
  const stdout = runGitCommand(args, repoRoot)
  return stdout
    .split('\u0000')
    .map(filePath => filePath.trim())
    .filter(Boolean)
    .map(toPosixPath)
}

/**
 * Determine if a path points to any CODEOWNERS file.
 * @param {string} filePath
 * @returns {boolean}
 */
function isCodeownersFile (filePath) {
  return path.posix.basename(filePath) === 'CODEOWNERS'
}

/**
 * Determine if a path points to a supported GitHub CODEOWNERS location.
 * @param {string} filePath
 * @returns {boolean}
 */
function isSupportedCodeownersFile (filePath) {
  return SUPPORTED_CODEOWNERS_PATHS.includes(filePath)
}

/**
 * List all discovered CODEOWNERS file paths in the repository.
 * @param {string[]} repoFiles
 * @returns {string[]}
 */
function listDiscoveredCodeownersPaths (repoFiles) {
  return repoFiles.filter(isCodeownersFile)
}

/**
 * Resolve the active CODEOWNERS file using GitHub's precedence rules.
 * GitHub only considers top-level CODEOWNERS files in `.github/`, the
 * repository root, and `docs/`, using the first file it finds in that order.
 * @param {string[]} discoveredCodeownersPaths
 * @returns {string|undefined}
 */
function resolveActiveCodeownersPath (discoveredCodeownersPaths) {
  return SUPPORTED_CODEOWNERS_PATHS.find(codeownersPath => discoveredCodeownersPaths.includes(codeownersPath))
}

/**
 * Build a clear error when no supported CODEOWNERS file is available.
 * @param {string[]} discoveredCodeownersPaths
 * @returns {string}
 */
function buildMissingSupportedCodeownersError (discoveredCodeownersPaths) {
  if (discoveredCodeownersPaths.length === 0) {
    return 'No CODEOWNERS files found in this repository.'
  }

  const unsupportedPaths = discoveredCodeownersPaths.filter((filePath) => !isSupportedCodeownersFile(filePath))
  if (unsupportedPaths.length === discoveredCodeownersPaths.length) {
    return [
      'No supported CODEOWNERS files found in this repository.',
      `GitHub only supports ${SUPPORTED_CODEOWNERS_PATHS_LABEL}.`,
      `Unsupported CODEOWNERS files were found at: ${unsupportedPaths.join(', ')}.`,
    ].join(' ')
  }

  return 'No CODEOWNERS files found in this repository.'
}

/**
 * Load a CODEOWNERS descriptor with parsed rules.
 * @param {string} repoRoot
 * @param {string} codeownersPath
 * @returns {{
 *   path: string,
 *   rules: {
 *     pattern: string,
 *     owners: string[],
 *     matches: (repoPath: string) => boolean
 *   }[]
 * }}
 */
function loadCodeownersDescriptor (repoRoot, codeownersPath) {
  const fileContent = readFileSync(path.join(repoRoot, codeownersPath), 'utf8')
  const rules = parseCodeowners(fileContent)

  return {
    path: codeownersPath,
    rules,
  }
}

/**
 * Build missing-path warnings for CODEOWNERS rules that match no repository files.
 * @param {{
 *   path: string,
 *   rules: {
 *     pattern: string,
 *     owners: string[],
 *     matches: (repoPath: string) => boolean
 *   }[]
 * }} codeownersDescriptor
 * @param {string[]} repoFiles
 * @param {Map<string, {
 *   addedAt: string,
 *   commitSha: string,
 *   commitUrl?: string
 * }>} [historyByPattern]
 * @returns {{
 *   codeownersPath: string,
 *   pattern: string,
 *   owners: string[],
 *   history?: {
 *     addedAt: string,
 *     commitSha: string,
 *     commitUrl?: string
 *   }
 * }[]}
 */
function collectMissingCodeownersPathWarnings (codeownersDescriptor, repoFiles, historyByPattern = new Map()) {
  /** @type {{
   *   codeownersPath: string,
   *   pattern: string,
   *   owners: string[],
   *   history?: {
   *     addedAt: string,
   *     commitSha: string,
   *     commitUrl?: string
   *   }
   * }[]} */
  const warnings = []

  for (const rule of codeownersDescriptor.rules) {
    const hasMatch = repoFiles.some((filePath) => rule.matches(filePath))
    if (!hasMatch) {
      const warning = {
        codeownersPath: codeownersDescriptor.path,
        pattern: rule.pattern,
        owners: rule.owners,
      }
      const history = historyByPattern.get(rule.pattern)
      if (history) {
        warning.history = history
      }
      warnings.push(warning)
    }
  }

  warnings.sort((first, second) => {
    const byPath = first.codeownersPath.localeCompare(second.codeownersPath)
    if (byPath !== 0) return byPath
    return first.pattern.localeCompare(second.pattern)
  })
  return warnings
}

/**
 * Replay CODEOWNERS file history to determine when each current pattern first
 * appeared in its current continuous lifetime.
 * @param {string} repoRoot
 * @param {{
 *   path: string,
 *   rules: {
 *     pattern: string,
 *     owners: string[],
 *     matches: (repoPath: string) => boolean
 *   }[]
 * }} codeownersDescriptor
 * @param {string|null} repoWebUrl
 * @returns {Map<string, {
 *   addedAt: string,
 *   commitSha: string,
 *   commitUrl?: string
 * }>}
 */
function collectCodeownersPatternHistory (repoRoot, codeownersDescriptor, repoWebUrl) {
  const currentPatterns = new Set(codeownersDescriptor.rules.map(rule => rule.pattern))
  /** @type {Map<string, {
   *   addedAt: string,
   *   commitSha: string,
   *   commitUrl?: string
   * }>} */
  const activeHistory = new Map()

  if (currentPatterns.size === 0) {
    return activeHistory
  }

  /** @type {string} */
  let stdout
  try {
    stdout = runGitCommand(
      ['log', '--follow', '--format=%x1e%H%x00%ct', '-p', '--unified=0', '--no-ext-diff', '--', codeownersDescriptor.path],
      repoRoot
    )
  } catch {
    return activeHistory
  }

  const logEntries = stdout
    .split('\u001e')
    .filter(Boolean)
    .reverse()

  for (const entry of logEntries) {
    if (!entry) continue
    const normalizedEntry = entry.replace(/^\n+/, '')
    if (!normalizedEntry) continue

    const firstNewlineIndex = normalizedEntry.indexOf('\n')
    const metadataLine = firstNewlineIndex === -1
      ? normalizedEntry
      : normalizedEntry.slice(0, firstNewlineIndex)
    const patch = firstNewlineIndex === -1
      ? ''
      : normalizedEntry.slice(firstNewlineIndex + 1)
    const [commitSha, commitTimestamp] = metadataLine.split('\u0000')
    const commitSeconds = Number.parseInt(commitTimestamp, 10)
    if (!commitSha || !Number.isFinite(commitSeconds)) continue

    const commitInfo = {
      addedAt: new Date(commitSeconds * 1000).toISOString(),
      commitSha,
      ...(repoWebUrl ? { commitUrl: `${repoWebUrl}/commit/${encodeURIComponent(commitSha)}` } : {}),
    }
    const changeSet = collectCodeownersPatternDiffChangeSet(patch)

    for (const pattern of changeSet.deleted) {
      if (!changeSet.added.has(pattern)) {
        activeHistory.delete(pattern)
      }
    }
    for (const pattern of changeSet.added) {
      if (!activeHistory.has(pattern)) {
        activeHistory.set(pattern, commitInfo)
      }
    }
  }

  const historyByPattern = new Map()
  for (const pattern of currentPatterns) {
    const history = activeHistory.get(pattern)
    if (history) {
      historyByPattern.set(pattern, history)
    }
  }
  return historyByPattern
}

/**
 * Collect added and deleted CODEOWNERS patterns from a unified diff.
 * Pattern-level tracking preserves age across owner-only edits to the same path.
 * @param {string} patch
 * @returns {{ added: Set<string>, deleted: Set<string> }}
 */
function collectCodeownersPatternDiffChangeSet (patch) {
  /** @type {Set<string>} */
  const added = new Set()
  /** @type {Set<string>} */
  const deleted = new Set()

  for (const line of patch.split('\n')) {
    if (!line) continue
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line[0] !== '+' && line[0] !== '-') continue

    const parsedRule = parseCodeownersRuleLine(line.slice(1))
    if (!parsedRule) continue

    if (line[0] === '+') {
      added.add(parsedRule.pattern)
    } else {
      deleted.add(parsedRule.pattern)
    }
  }

  return { added, deleted }
}

/**
 * Build discovery warnings for extra or unsupported CODEOWNERS files.
 * @param {string[]} discoveredCodeownersPaths
 * @param {string} activeCodeownersPath
 * @returns {{
 *   path: string,
 *   type: 'unused-supported-location'|'unsupported-location',
 *   referencePath?: string,
 *   message: string
 * }[]}
 */
function collectCodeownersDiscoveryWarnings (discoveredCodeownersPaths, activeCodeownersPath) {
  /** @type {{
   *   path: string,
   *   type: 'unused-supported-location'|'unsupported-location',
   *   referencePath?: string,
   *   message: string
   * }[]} */
  const warnings = []

  for (const codeownersPath of discoveredCodeownersPaths) {
    if (codeownersPath === activeCodeownersPath) continue

    if (isSupportedCodeownersFile(codeownersPath)) {
      warnings.push({
        path: codeownersPath,
        type: 'unused-supported-location',
        referencePath: activeCodeownersPath,
        message: `${codeownersPath} is unused because GitHub selects ${activeCodeownersPath} first.`,
      })
      continue
    }

    warnings.push({
      path: codeownersPath,
      type: 'unsupported-location',
      message: `${codeownersPath} is in an unsupported location and is ignored by GitHub.`,
    })
  }

  warnings.sort((first, second) => first.path.localeCompare(second.path))
  return warnings
}

