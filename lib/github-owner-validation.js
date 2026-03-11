import { fetchGithubApiJson, fetchGithubApiPaginatedArray, requestGithubApi } from './github-api.js'
import { runGitCommand as defaultRunGitCommand } from './git.js'
import { resolveGithubRepoIdentity, resolveGithubToken } from './github-identity.js'

const USER_WRITE_PERMISSIONS = new Set(['admin', 'write'])
const TEAM_WRITE_PERMISSIONS = new Set(['admin', 'maintain', 'push', 'write'])

/**
 * Validate GitHub-style CODEOWNERS entries and attach effective owners to rules.
 * Non-GitHub owner forms such as email addresses are preserved unchanged.
 * @param {string} repoRoot
 * @param {import('./types.js').CodeownersDescriptor} codeownersDescriptor
 * @param {{ githubToken?: string, githubApiBaseUrl: string, progress?: (message: string, ...values: any[]) => void }} options
 * @param {{ runGitCommand?: (args: string[], cwd?: string) => string }} [context]
 * @returns {Promise<{
 *   invalidOwnerWarnings: import('./types.js').InvalidOwnerWarning[],
 *   warnings: string[]
 * }>}
 */
export async function validateGithubOwners (repoRoot, codeownersDescriptor, options, context = {}) {
  const progress = typeof options.progress === 'function' ? options.progress : () => {}
  const runGitCommand = typeof context.runGitCommand === 'function' ? context.runGitCommand : defaultRunGitCommand

  const tokenResolution = resolveGithubToken(options.githubToken)
  if (!tokenResolution.token) {
    throw new Error(
      'GitHub owner validation requires a GitHub token. ' +
      'Provide --github-token or set GITHUB_TOKEN (or GH_TOKEN).'
    )
  }

  const repoIdentity = resolveGithubRepoIdentity(repoRoot, runGitCommand)
  if (!repoIdentity) {
    throw new Error(
      'GitHub owner validation requires a repository origin remote so owner/name can be inferred.'
    )
  }

  const apiContext = {
    token: tokenResolution.token,
    baseUrl: options.githubApiBaseUrl,
  }

  const githubOwners = collectUniqueGithubOwners(codeownersDescriptor.rules)
  progress('GitHub owner validation: validating %d CODEOWNERS owner token(s)...', githubOwners.length)

  /** @type {Map<string, OwnerValidationResult>} */
  const validationByOwner = new Map()
  /** @type {Promise<Map<string, string>>|undefined} */
  let repoTeamsBySlugPromise

  const getRepoTeamsBySlug = async () => {
    if (!repoTeamsBySlugPromise) {
      repoTeamsBySlugPromise = fetchRepoTeamsBySlug(apiContext, repoIdentity)
    }
    return await repoTeamsBySlugPromise
  }

  /** @type {Set<string>} */
  const warnings = new Set()

  for (const owner of githubOwners) {
    const validation = await validateGithubOwnerToken(owner, apiContext, repoIdentity, getRepoTeamsBySlug)
    validationByOwner.set(owner.toLowerCase(), validation)
    if (validation.warning) {
      warnings.add(validation.warning)
    }
  }

  /** @type {import('./types.js').InvalidOwnerWarning[]} */
  const invalidOwnerWarnings = []
  for (const rule of codeownersDescriptor.rules) {
    /** @type {string[]} */
    const effectiveOwners = []
    /** @type {import('./types.js').InvalidOwnerEntry[]} */
    const invalidOwners = []

    for (const owner of rule.owners) {
      const normalizedOwner = normalizeOwnerToken(owner)
      if (!normalizedOwner || !normalizedOwner.startsWith('@')) {
        effectiveOwners.push(owner)
        continue
      }

      const validation = validationByOwner.get(normalizedOwner.toLowerCase())
      if (!validation || validation.valid) {
        effectiveOwners.push(owner)
        continue
      }

      invalidOwners.push({
        owner: normalizedOwner,
        ownerType: validation.ownerType,
        reason: validation.reason,
      })
    }

    rule.effectiveOwners = effectiveOwners
    if (invalidOwners.length > 0) {
      invalidOwnerWarnings.push({
        codeownersPath: codeownersDescriptor.path,
        pattern: rule.pattern,
        owners: rule.owners.slice(),
        effectiveOwners: effectiveOwners.slice(),
        invalidOwners,
      })
    }
  }

  invalidOwnerWarnings.sort((first, second) => {
    const byPath = first.codeownersPath.localeCompare(second.codeownersPath)
    if (byPath !== 0) return byPath
    return first.pattern.localeCompare(second.pattern)
  })

  progress(
    'GitHub owner validation complete: %d invalid owner warning(s).',
    invalidOwnerWarnings.length
  )

  return {
    invalidOwnerWarnings,
    warnings: Array.from(warnings.values()).sort((first, second) => first.localeCompare(second)),
  }
}

/**
 * @typedef {{
 *   owner: string,
 *   ownerType: 'user'|'team'|'github-owner',
 *   valid: boolean,
 *   reason: string,
 *   warning?: string
 * }} OwnerValidationResult
 */

/**
 * Collect unique `@...` owner tokens in insertion order.
 * @param {import('./types.js').CodeownersRule[]} rules
 * @returns {string[]}
 */
function collectUniqueGithubOwners (rules) {
  /** @type {Map<string, string>} */
  const owners = new Map()
  for (const rule of rules) {
    for (const owner of rule.owners) {
      const normalized = normalizeOwnerToken(owner)
      if (!normalized || !normalized.startsWith('@')) continue
      owners.set(normalized.toLowerCase(), normalized)
    }
  }
  return Array.from(owners.values())
}

/**
 * Normalize a raw owner token.
 * @param {unknown} owner
 * @returns {string}
 */
function normalizeOwnerToken (owner) {
  return typeof owner === 'string' ? owner.trim() : ''
}

/**
 * Validate a GitHub owner token.
 * @param {string} owner
 * @param {{ token: string, baseUrl: string }} apiContext
 * @param {{ owner: string, repo: string }} repoIdentity
 * @param {() => Promise<Map<string, string>>} getRepoTeamsBySlug
 * @returns {Promise<OwnerValidationResult>}
 */
async function validateGithubOwnerToken (owner, apiContext, repoIdentity, getRepoTeamsBySlug) {
  const parsedOwner = parseGithubOwner(owner)
  if (!parsedOwner.valid) {
    return {
      owner,
      ownerType: 'github-owner',
      valid: false,
      reason: 'is not a valid GitHub owner token; use @username or @org/team.',
    }
  }

  if (parsedOwner.ownerType === 'user') {
    return await validateUserOwner(parsedOwner, apiContext, repoIdentity)
  }

  return await validateTeamOwner(parsedOwner, apiContext, repoIdentity, getRepoTeamsBySlug)
}

/**
 * Parse a GitHub owner token into user/team components.
 * @param {string} owner
 * @returns {{
 *   valid: true,
 *   ownerType: 'user',
 *   owner: string,
 *   login: string
 * }|{
 *   valid: true,
 *   ownerType: 'team',
 *   owner: string,
 *   org: string,
 *   slug: string
 * }|{
 *   valid: false
 * }}
 */
function parseGithubOwner (owner) {
  const normalized = normalizeOwnerToken(owner)
  if (!normalized.startsWith('@')) return { valid: false }

  const body = normalized.slice(1)
  if (!body) return { valid: false }

  const parts = body.split('/')
  if (parts.some(part => !part)) return { valid: false }

  if (parts.length === 1) {
    return {
      valid: true,
      ownerType: 'user',
      owner: normalized,
      login: parts[0],
    }
  }

  if (parts.length === 2) {
    return {
      valid: true,
      ownerType: 'team',
      owner: normalized,
      org: parts[0],
      slug: parts[1],
    }
  }

  return { valid: false }
}

/**
 * Validate an `@username` owner.
 * @param {{ owner: string, login: string }} parsedOwner
 * @param {{ token: string, baseUrl: string }} apiContext
 * @param {{ owner: string, repo: string }} repoIdentity
 * @returns {Promise<OwnerValidationResult>}
 */
async function validateUserOwner (parsedOwner, apiContext, repoIdentity) {
  try {
    const permissionInfo = await fetchGithubApiJson(
      apiContext,
      `/repos/${encodeURIComponent(repoIdentity.owner)}/${encodeURIComponent(repoIdentity.repo)}` +
      `/collaborators/${encodeURIComponent(parsedOwner.login)}/permission`
    )
    if (USER_WRITE_PERMISSIONS.has(String(permissionInfo && permissionInfo.permission))) {
      return {
        owner: parsedOwner.owner,
        ownerType: 'user',
        valid: true,
        reason: '',
      }
    }
    return {
      owner: parsedOwner.owner,
      ownerType: 'user',
      valid: false,
      reason: 'does not have write access to the repository.',
    }
  } catch (error) {
    const status = getStatusCode(error)
    if (status !== 404 && status !== 401 && status !== 403) throw error

    const userExists = await getGithubUserExistence(apiContext, parsedOwner.login)
    if (status === 401 || status === 403) {
      if (userExists === 'missing') {
        return {
          owner: parsedOwner.owner,
          ownerType: 'user',
          valid: false,
          reason: 'was not found on GitHub.',
        }
      }
      return {
        owner: parsedOwner.owner,
        ownerType: 'user',
        valid: true,
        reason: '',
        warning: buildUserAccessWarning(parsedOwner.owner, status),
      }
    }

    return {
      owner: parsedOwner.owner,
      ownerType: 'user',
      valid: false,
      reason: userExists === 'exists'
        ? 'does not have write access to the repository.'
        : 'was not found on GitHub.',
    }
  }
}

/**
 * Validate an `@org/team` owner.
 * @param {{ owner: string, org: string, slug: string }} parsedOwner
 * @param {{ token: string, baseUrl: string }} apiContext
 * @param {{ owner: string, repo: string }} repoIdentity
 * @param {() => Promise<Map<string, string>>} getRepoTeamsBySlug
 * @returns {Promise<OwnerValidationResult>}
 */
async function validateTeamOwner (parsedOwner, apiContext, repoIdentity, getRepoTeamsBySlug) {
  /** @type {number} */
  let repoTeamLookupStatus = 0
  if (parsedOwner.org.toLowerCase() === repoIdentity.owner.toLowerCase()) {
    try {
      const repoTeamsBySlug = await getRepoTeamsBySlug()
      const repoPermission = repoTeamsBySlug.get(parsedOwner.slug.toLowerCase())
      if (repoPermission) {
        return {
          owner: parsedOwner.owner,
          ownerType: 'team',
          valid: TEAM_WRITE_PERMISSIONS.has(repoPermission),
          reason: TEAM_WRITE_PERMISSIONS.has(repoPermission)
            ? ''
            : 'does not have write access to the repository.',
        }
      }
    } catch (error) {
      repoTeamLookupStatus = getStatusCode(error)
      if (repoTeamLookupStatus !== 401 && repoTeamLookupStatus !== 403) throw error
    }
  }

  const directRepoAccess = await getGithubTeamRepositoryAccess(apiContext, parsedOwner, repoIdentity)
  if (directRepoAccess.status === 'permission') {
    return {
      owner: parsedOwner.owner,
      ownerType: 'team',
      valid: TEAM_WRITE_PERMISSIONS.has(directRepoAccess.permission),
      reason: TEAM_WRITE_PERMISSIONS.has(directRepoAccess.permission)
        ? ''
        : 'does not have write access to the repository.',
    }
  }

  const teamExists = await getGithubTeamExistence(apiContext, parsedOwner.org, parsedOwner.slug)
  if (repoTeamLookupStatus === 401 || repoTeamLookupStatus === 403) {
    if (teamExists === 'missing') {
      return {
        owner: parsedOwner.owner,
        ownerType: 'team',
        valid: false,
        reason: 'was not found on GitHub or is not visible.',
      }
    }
    return {
      owner: parsedOwner.owner,
      ownerType: 'team',
      valid: true,
      reason: '',
      warning: buildTeamAccessWarning(parsedOwner.owner, repoTeamLookupStatus),
    }
  }

  if (directRepoAccess.status === 'unknown-access') {
    if (teamExists === 'missing') {
      return {
        owner: parsedOwner.owner,
        ownerType: 'team',
        valid: false,
        reason: 'was not found on GitHub or is not visible.',
      }
    }
    return {
      owner: parsedOwner.owner,
      ownerType: 'team',
      valid: true,
      reason: '',
      warning: buildTeamInconclusiveAccessWarning(parsedOwner.owner),
    }
  }

  if (directRepoAccess.status === 'unknown-permission') {
    if (teamExists === 'missing') {
      return {
        owner: parsedOwner.owner,
        ownerType: 'team',
        valid: false,
        reason: 'was not found on GitHub or is not visible.',
      }
    }
    return {
      owner: parsedOwner.owner,
      ownerType: 'team',
      valid: true,
      reason: '',
      warning: buildTeamPermissionUnknownWarning(parsedOwner.owner),
    }
  }

  return {
    owner: parsedOwner.owner,
    ownerType: 'team',
    valid: false,
    reason: teamExists === 'exists'
      ? 'does not have write access to the repository.'
      : 'was not found on GitHub or is not visible.',
  }
}

/**
 * Fetch repository teams keyed by slug.
 * @param {{ token: string, baseUrl: string }} apiContext
 * @param {{ owner: string, repo: string }} repoIdentity
 * @returns {Promise<Map<string, string>>}
 */
async function fetchRepoTeamsBySlug (apiContext, repoIdentity) {
  const teams = await fetchGithubApiPaginatedArray(
    apiContext,
    `/repos/${encodeURIComponent(repoIdentity.owner)}/${encodeURIComponent(repoIdentity.repo)}/teams`
  )
  /** @type {Map<string, string>} */
  const teamsBySlug = new Map()
  for (const team of teams) {
    if (!team || typeof team.slug !== 'string') continue
    const permission = normalizeTeamPermission(team.permission)
    teamsBySlug.set(team.slug.toLowerCase(), permission)
  }
  return teamsBySlug
}

/**
 * @param {{ token: string, baseUrl: string }} apiContext
 * @param {string} username
 * @returns {Promise<'exists'|'missing'|'unknown'>}
 */
async function getGithubUserExistence (apiContext, username) {
  try {
    await fetchGithubApiJson(apiContext, `/users/${encodeURIComponent(username)}`)
    return 'exists'
  } catch (error) {
    const status = getStatusCode(error)
    if (status === 404) return 'missing'
    if (status === 401 || status === 403) return 'unknown'
    throw error
  }
}

/**
 * @param {{ token: string, baseUrl: string }} apiContext
 * @param {string} org
 * @param {string} teamSlug
 * @returns {Promise<'exists'|'missing'|'unknown'>}
 */
async function getGithubTeamExistence (apiContext, org, teamSlug) {
  try {
    await fetchGithubApiJson(
      apiContext,
      `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(teamSlug)}`
    )
    return 'exists'
  } catch (error) {
    const status = getStatusCode(error)
    if (status === 404) return 'missing'
    if (status === 401 || status === 403) return 'unknown'
    throw error
  }
}

/**
 * Query GitHub for a team's repository access using the direct team-repository endpoint.
 * @param {{ token: string, baseUrl: string }} apiContext
 * @param {{ org: string, slug: string }} parsedOwner
 * @param {{ owner: string, repo: string }} repoIdentity
 * @returns {Promise<
 *   { status: 'permission', permission: string } |
 *   { status: 'unknown-access' } |
 *   { status: 'unknown-permission' }
 * >}
 */
async function getGithubTeamRepositoryAccess (apiContext, parsedOwner, repoIdentity) {
  try {
    const response = await requestGithubApi(
      apiContext,
      `/orgs/${encodeURIComponent(parsedOwner.org)}/teams/${encodeURIComponent(parsedOwner.slug)}` +
      `/repos/${encodeURIComponent(repoIdentity.owner)}/${encodeURIComponent(repoIdentity.repo)}`
    )
    const permission = extractTeamRepositoryPermission(response.body)
    if (permission) {
      return {
        status: 'permission',
        permission,
      }
    }
    return { status: 'unknown-permission' }
  } catch (error) {
    const status = getStatusCode(error)
    if (status === 401 || status === 403 || status === 404) {
      return { status: 'unknown-access' }
    }
    throw error
  }
}

/**
 * Extract an effective permission string from a direct team-repository response.
 * @param {any} body
 * @returns {string}
 */
function extractTeamRepositoryPermission (body) {
  if (!body || typeof body !== 'object') return ''

  if (typeof body.permission === 'string') {
    return String(body.permission).toLowerCase()
  }

  if (!body.permissions || typeof body.permissions !== 'object') {
    return ''
  }

  if (body.permissions.admin) return 'admin'
  if (body.permissions.maintain) return 'maintain'
  if (body.permissions.push || body.permissions.write) return 'push'
  if (body.permissions.triage) return 'triage'
  if (body.permissions.pull || body.permissions.read) return 'pull'
  return ''
}

/**
 * Build a warning when repo-level user access checks are unavailable.
 * @param {string} owner
 * @param {number} status
 * @returns {string}
 */
function buildUserAccessWarning (owner, status) {
  return (
    `Could not verify repository write access for ${owner} because the current GitHub token ` +
    `could not access collaborator permission checks (HTTP ${status}). ` +
    'Only GitHub account existence was checked, so this owner was preserved.'
  )
}

/**
 * Build a warning when repo-level team access checks are unavailable.
 * @param {string} owner
 * @param {number} status
 * @returns {string}
 */
function buildTeamAccessWarning (owner, status) {
  return (
    `Could not verify repository write access for ${owner} because the current GitHub token ` +
    `could not access repository team checks (HTTP ${status}). ` +
    'Only team existence was checked when possible, so this owner was preserved.'
  )
}

/**
 * Build a warning when GitHub does not expose enough team access information.
 * @param {string} owner
 * @returns {string}
 */
function buildTeamInconclusiveAccessWarning (owner) {
  return (
    `Could not conclusively verify repository access for ${owner} because GitHub did not expose ` +
    'team access through the repository team APIs for the current token or team visibility. ' +
    'The team exists, so this owner was preserved.'
  )
}

/**
 * Build a warning when GitHub confirms repository access but omits permission details.
 * @param {string} owner
 * @returns {string}
 */
function buildTeamPermissionUnknownWarning (owner) {
  return (
    `GitHub confirmed repository access for ${owner} without returning enough permission detail ` +
    'to distinguish pull from write access. This owner was preserved.'
  )
}

/**
 * Normalize a repository team permission string.
 * @param {unknown} permission
 * @returns {string}
 */
function normalizeTeamPermission (permission) {
  return typeof permission === 'string' ? permission.toLowerCase() : 'none'
}

/**
 * Extract an HTTP-ish status code from an error object.
 * @param {unknown} error
 * @returns {number}
 */
function getStatusCode (error) {
  if (!error || typeof error !== 'object' || !('status' in error)) return 0
  return Number(error.status) || 0
}
