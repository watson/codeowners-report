import { tmpdir } from 'node:os'
import path from 'node:path'
import { normalizeTeamIgnoreToken } from './team-suggestions.js'

const DEFAULT_OUTPUT_FILE_NAME = 'codeowners-gaps-report.html'
const DEFAULT_OUTPUT_PATH = path.join(tmpdir(), 'codeowners-audit', DEFAULT_OUTPUT_FILE_NAME)
export const UPLOAD_PROVIDER = 'zenbin'
export const TEAM_SUGGESTIONS_DEFAULT_WINDOW_DAYS = 365
export const TEAM_SUGGESTIONS_DEFAULT_TOP = 3
export const GITHUB_API_BASE_URL = 'https://api.github.com'

/**
 * Parse command-line arguments.
 * @param {string[]} args
 * @returns {{
 *   repoOrPath?: string,
 *   outputPath: string,
 *   workingDir: string|null,
 *   includeUntracked: boolean,
 *   noReport: boolean,
 *   listUnowned: boolean,
 *   failOnUnowned: boolean,
 *   failOnMissingPaths: boolean,
 *   failOnLocationWarnings: boolean,
 *   checkGlobs: string[],
 *   teamSuggestions: boolean,
 *   teamSuggestionsWindowDays: number,
 *   teamSuggestionsTop: number,
 *   teamSuggestionsIgnoreTeams: string[],
 *   githubOrg: string|null,
 *   githubToken?: string,
 *   githubApiBaseUrl: string,
 *   upload: boolean,
 *   yes: boolean,
 *   open: boolean,
 *   verbose: boolean,
 *   help: boolean,
 *   version: boolean
 * }}
 */
export function parseArgs (args) {
  /** @type {string|undefined} */
  let repoOrPath
  let outputPath = DEFAULT_OUTPUT_PATH
  let outputPathSetExplicitly = false
  let outputDir = null
  let outputDirSetExplicitly = false
  let workingDir = null
  let workingDirSetExplicitly = false
  let includeUntracked = false
  let noReport = false
  let listUnowned = false
  let failOnUnowned = false
  let failOnMissingPaths = false
  let failOnLocationWarnings = false
  /** @type {string[]} */
  let checkGlobs = []
  let teamSuggestions = false
  let teamSuggestionsWindowDays = TEAM_SUGGESTIONS_DEFAULT_WINDOW_DAYS
  let teamSuggestionsTop = TEAM_SUGGESTIONS_DEFAULT_TOP
  /** @type {string[]} */
  let teamSuggestionsIgnoreTeams = []
  let githubOrg = null
  let githubToken = undefined
  let githubTokenSetExplicitly = false
  let githubApiBaseUrl = GITHUB_API_BASE_URL
  let upload = false
  let yes = false
  let open = true
  let verbose = false
  let help = false
  let version = false

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--output' || arg === '-o') {
      outputPath = args[index + 1]
      outputPathSetExplicitly = true
      index++
      continue
    }

    if (arg.startsWith('--output=')) {
      outputPath = arg.slice('--output='.length)
      outputPathSetExplicitly = true
      continue
    }

    if (arg === '--output-dir') {
      outputDir = args[index + 1]
      outputDirSetExplicitly = true
      index++
      continue
    }

    if (arg.startsWith('--output-dir=')) {
      outputDir = arg.slice('--output-dir='.length)
      outputDirSetExplicitly = true
      continue
    }

    if (arg === '--cwd') {
      workingDir = args[index + 1]
      workingDirSetExplicitly = true
      index++
      continue
    }

    if (arg.startsWith('--cwd=')) {
      workingDir = arg.slice('--cwd='.length)
      workingDirSetExplicitly = true
      continue
    }

    if (arg === '--include-untracked') {
      includeUntracked = true
      continue
    }

    if (arg === '--suggest-teams') {
      teamSuggestions = true
      continue
    }

    if (arg === '--suggest-window-days') {
      teamSuggestionsWindowDays = parseNumberOption(args[index + 1], '--suggest-window-days')
      index++
      continue
    }

    if (arg.startsWith('--suggest-window-days=')) {
      teamSuggestionsWindowDays = parseNumberOption(
        arg.slice('--suggest-window-days='.length),
        '--suggest-window-days'
      )
      continue
    }

    if (arg === '--suggest-top') {
      teamSuggestionsTop = parseNumberOption(args[index + 1], '--suggest-top')
      index++
      continue
    }

    if (arg.startsWith('--suggest-top=')) {
      teamSuggestionsTop = parseNumberOption(arg.slice('--suggest-top='.length), '--suggest-top')
      continue
    }

    if (arg === '--suggest-ignore-teams') {
      teamSuggestionsIgnoreTeams = teamSuggestionsIgnoreTeams.concat(
        parseCsvListOption(args[index + 1], '--suggest-ignore-teams')
      )
      index++
      continue
    }

    if (arg.startsWith('--suggest-ignore-teams=')) {
      teamSuggestionsIgnoreTeams = teamSuggestionsIgnoreTeams.concat(
        parseCsvListOption(
          arg.slice('--suggest-ignore-teams='.length),
          '--suggest-ignore-teams'
        )
      )
      continue
    }

    if (arg === '--github-org') {
      githubOrg = args[index + 1]
      index++
      continue
    }

    if (arg.startsWith('--github-org=')) {
      githubOrg = arg.slice('--github-org='.length)
      continue
    }

    if (arg === '--github-token') {
      githubToken = args[index + 1]
      githubTokenSetExplicitly = true
      index++
      continue
    }

    if (arg.startsWith('--github-token=')) {
      githubToken = arg.slice('--github-token='.length)
      githubTokenSetExplicitly = true
      continue
    }

    if (arg === '--github-api-base-url') {
      githubApiBaseUrl = args[index + 1]
      index++
      continue
    }

    if (arg.startsWith('--github-api-base-url=')) {
      githubApiBaseUrl = arg.slice('--github-api-base-url='.length)
      continue
    }

    if (arg === '--no-report') {
      noReport = true
      continue
    }

    if (arg === '--list-unowned') {
      listUnowned = true
      continue
    }

    if (arg === '--fail-on-unowned') {
      failOnUnowned = true
      continue
    }

    if (arg === '--fail-on-missing-paths') {
      failOnMissingPaths = true
      continue
    }

    if (arg === '--fail-on-location-warnings') {
      failOnLocationWarnings = true
      continue
    }

    if (arg === '--glob' || arg === '-g') {
      checkGlobs.push(parseGlobOption(args[index + 1], '--glob'))
      index++
      continue
    }

    if (arg.startsWith('--glob=')) {
      checkGlobs.push(parseGlobOption(arg.slice('--glob='.length), '--glob'))
      continue
    }

    if (arg === '--upload') {
      upload = true
      continue
    }

    if (arg === '--yes' || arg === '-y') {
      yes = true
      continue
    }

    if (arg === '--no-open') {
      open = false
      continue
    }

    if (arg === '--verbose') {
      verbose = true
      continue
    }

    if (arg === '--help' || arg === '-h') {
      help = true
      continue
    }

    if (arg === '--version' || arg === '-v') {
      version = true
      continue
    }

    if (!arg.startsWith('-') && repoOrPath === undefined) {
      repoOrPath = arg
      continue
    }

    throw new Error(`Unknown argument: ${arg}`)
  }

  if (!help && !outputPath) {
    throw new Error('Missing value for --output.')
  }

  if (!help && outputDirSetExplicitly) {
    if (!outputDir) {
      throw new Error('Missing value for --output-dir.')
    }

    outputPath = outputPathSetExplicitly
      ? (path.isAbsolute(outputPath) ? outputPath : path.join(outputDir, outputPath))
      : path.join(outputDir, DEFAULT_OUTPUT_FILE_NAME)
  }

  if (!help && workingDirSetExplicitly && !workingDir) {
    throw new Error('Missing value for --cwd.')
  }

  if (!help && repoOrPath !== undefined && workingDirSetExplicitly) {
    throw new Error('Cannot specify both a positional <repo-or-path> argument and --cwd.')
  }

  if (!help && teamSuggestionsWindowDays < 1) {
    throw new Error('--suggest-window-days must be >= 1.')
  }

  if (!help && teamSuggestionsTop < 1) {
    throw new Error('--suggest-top must be >= 1.')
  }

  if (!help && githubOrg !== null && !githubOrg) {
    throw new Error('Missing value for --github-org.')
  }

  if (!help && githubTokenSetExplicitly && !githubToken) {
    throw new Error('Missing value for --github-token.')
  }

  if (!help && !githubApiBaseUrl) {
    throw new Error('Missing value for --github-api-base-url.')
  }

  if (!help && !isValidHttpUrl(githubApiBaseUrl)) {
    throw new Error(`Invalid value for --github-api-base-url: ${JSON.stringify(githubApiBaseUrl)}`)
  }

  teamSuggestionsIgnoreTeams = dedupeStrings(
    teamSuggestionsIgnoreTeams
      .map(normalizeTeamIgnoreToken)
      .filter(Boolean)
  )
  checkGlobs = dedupeStrings(checkGlobs)
  if (checkGlobs.length === 0) {
    checkGlobs = ['**']
  }

  return {
    repoOrPath,
    outputPath,
    workingDir,
    includeUntracked,
    noReport,
    listUnowned,
    failOnUnowned,
    failOnMissingPaths,
    failOnLocationWarnings,
    checkGlobs,
    teamSuggestions,
    teamSuggestionsWindowDays,
    teamSuggestionsTop,
    teamSuggestionsIgnoreTeams,
    githubOrg,
    githubToken,
    githubApiBaseUrl,
    upload,
    yes,
    open,
    verbose,
    help,
    version,
  }
}

/**
 * Print CLI usage text to stdout.
 */
export function printUsage () {
  /** @type {Array<[string, string]>} */
  const optionRows = [
    ['-o, --output <path>', 'Output HTML file path'],
    ['--output-dir <dir>', 'Output directory for the generated HTML report'],
    ['--cwd <dir>', 'Run git commands from this directory'],
    ['--include-untracked', 'Include untracked files in the analysis'],
    ['--no-report', 'Skip HTML report generation (implies --list-unowned)'],
    ['--list-unowned', 'Print unowned file paths to stdout'],
    ['--fail-on-unowned', 'Exit non-zero when one or more files are unowned'],
    ['--fail-on-missing-paths', 'Exit non-zero when CODEOWNERS paths match no files'],
    ['--fail-on-location-warnings', 'Exit non-zero when extra or ignored CODEOWNERS files are found'],
    ['-g, --glob <pattern>', 'Repeatable file filter for report/check scope (default: **)'],
    ['--suggest-teams', 'Suggest @org/team for uncovered directories'],
    ['--suggest-window-days <days>', `Git history lookback window for suggestions (default: ${TEAM_SUGGESTIONS_DEFAULT_WINDOW_DAYS})`],
    ['--suggest-top <n>', `Top team suggestions to keep per directory (default: ${TEAM_SUGGESTIONS_DEFAULT_TOP})`],
    ['--suggest-ignore-teams <list>', 'Comma-separated team slugs or @org/slug entries to exclude from suggestions'],
    ['--github-org <org>', 'Override GitHub org for team lookups'],
    ['--github-token <token>', 'GitHub token for team lookups (falls back to GITHUB_TOKEN, then GH_TOKEN)'],
    ['--github-api-base-url <url>', `GitHub API base URL (default: ${GITHUB_API_BASE_URL})`],
    ['--upload', `Upload to ${UPLOAD_PROVIDER} and print a public URL`],
    ['-y, --yes', 'Automatically answer yes to interactive prompts'],
    ['--no-open', 'Do not prompt to open the report in your browser'],
    ['--verbose', 'Enable verbose progress output'],
    ['-h, --help', 'Show this help'],
    ['-v, --version', 'Show version'],
  ]

  console.log(
    [
      'Usage: codeowners-audit [repo-or-path] [options]',
      '',
      'Arguments:',
      '  [repo-or-path]           Repository URL, GitHub shorthand (owner/repo), or path to a local directory (default: cwd)',
      '',
      'Options:',
      ...formatUsageOptions(optionRows),
    ].join('\n')
  )
}

/**
 * Render CLI options into aligned help text rows.
 * @param {Array<[string, string]>} optionRows
 * @returns {string[]}
 */
function formatUsageOptions (optionRows) {
  const leftPadding = '  '
  const descriptionColumn = 28
  const descriptionPaddingWidth = descriptionColumn - 1
  const lines = []

  for (const [option, description] of optionRows) {
    const optionLine = leftPadding + option

    if (optionLine.length >= descriptionPaddingWidth) {
      lines.push(optionLine)
      lines.push(' '.repeat(descriptionPaddingWidth) + description)
      continue
    }

    lines.push(optionLine + ' '.repeat(descriptionPaddingWidth - optionLine.length) + description)
  }

  return lines
}

/**
 * Parse and validate an integer option.
 * @param {string|undefined} value
 * @param {string} optionName
 * @returns {number}
 */
function parseNumberOption (value, optionName) {
  if (!value) {
    throw new Error(`Missing value for ${optionName}.`)
  }
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric value for ${optionName}: ${JSON.stringify(value)}`)
  }
  return parsed
}

/**
 * Parse and validate a glob option.
 * @param {string|undefined} value
 * @param {string} optionName
 * @returns {string}
 */
function parseGlobOption (value, optionName) {
  if (!value) {
    throw new Error(`Missing value for ${optionName}.`)
  }
  const normalized = String(value).trim()
  if (!normalized) {
    throw new Error(`Missing value for ${optionName}.`)
  }
  return normalized
}

/**
 * Parse a comma-separated option into non-empty entries.
 * @param {string|undefined} value
 * @param {string} optionName
 * @returns {string[]}
 */
function parseCsvListOption (value, optionName) {
  if (!value) {
    throw new Error(`Missing value for ${optionName}.`)
  }
  const items = String(value)
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
  if (items.length === 0) {
    throw new Error(`Missing value for ${optionName}.`)
  }
  return items
}

/**
 * Return unique strings preserving insertion order.
 * @param {string[]} items
 * @returns {string[]}
 */
function dedupeStrings (items) {
  return Array.from(new Set(items))
}

/**
 * Check whether a value is a valid HTTP(S) URL.
 * @param {string} value
 * @returns {boolean}
 */
function isValidHttpUrl (value) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}
