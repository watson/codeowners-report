# Refactoring Recommendations for codeowners-audit

## Executive Summary

The project is a well-built, zero-dependency CLI tool with solid functionality. However, nearly all logic lives in a single 2,292-line file (`report.js`), making it difficult to maintain, test individual components, or add features without risk of regressions. The recommendations below focus on breaking the monolith into focused modules while preserving the zero-dependency philosophy.

---

## 1. Break Up the `report.js` Monolith

**Problem:** `report.js` handles CLI argument parsing, CODEOWNERS parsing, pattern matching, git operations, repository cloning, report building, HTML rendering, file upload, browser opening, user prompts, ANSI coloring, and output formatting — all in one file.

**Recommendation:** Extract into focused modules under `lib/`:

| Proposed Module | Responsibility | Approx Lines |
|---|---|---|
| `lib/cli-args.js` | Argument parsing, validation, help text | ~300 |
| `lib/codeowners-parser.js` | CODEOWNERS file loading, line parsing, pattern matching | ~200 |
| `lib/pattern-matcher.js` | Glob-to-regex conversion, `createPatternMatcher()` | ~100 |
| `lib/git.js` | All git command execution, file listing, shallow detection | ~100 |
| `lib/repository.js` | Repo URL detection/normalization, cloning, display names, web URLs | ~150 |
| `lib/report-builder.js` | `buildReport()`, directory stats, owner resolution | ~200 |
| `lib/report-renderer.js` | HTML template rendering | ~30 |
| `lib/upload.js` | ZenBin upload logic | ~80 |
| `lib/cli-output.js` | Coverage summary, unowned file listing, ANSI formatting, warnings | ~200 |
| `lib/prompts.js` | Interactive stdin prompts (yes/no, open report, clone confirmation) | ~100 |

`report.js` would become a thin orchestrator (~150 lines) that imports these modules and wires the flow together.

**Benefits:**
- Each module can be tested in isolation with unit tests
- New features (e.g., a new output format, a different upload provider) only touch one module
- Easier code review — changes are scoped to the relevant domain

---

## 2. Eliminate Duplicated Utility Functions

**Problem:** Several utility functions are duplicated between `report.js` and `lib/team-suggestions.js`:

- `runGitCommand()` / `defaultRunGitCommand()` — identical implementations
- `toPosixPath()` / `defaultToPosixPath()` — identical implementations
- `formatCommandError()` / `defaultFormatCommandError()` — identical implementations
- `directoryAncestors()` — exists in `team-suggestions.js`, reimplemented inline in `report.js` (`buildReport`)
- `resolveGithubRepoIdentity()` / `parseRemoteUrlToOwnerRepo()` — repo identity parsing exists in both files
- `resolveGithubToken()` — lives in `team-suggestions.js` but is a general-purpose utility

**Recommendation:** Consolidate into shared modules:
- Move `runGitCommand`, `toPosixPath`, `formatCommandError` into `lib/git.js`
- Move `directoryAncestors` into a shared `lib/paths.js` utility
- Move `resolveGithubToken`, `resolveGithubRepoIdentity`, `parseRemoteUrlToOwnerRepo` into `lib/github-identity.js`

Then `team-suggestions.js` would import these instead of accepting them via a `context` parameter (or the context pattern is simplified to only carry truly injectable concerns like progress logging).

---

## 3. Simplify the Dependency Injection in `team-suggestions.js`

**Problem:** `collectDirectoryTeamSuggestions()` receives a `context` object with `runGitCommand`, `toPosixPath`, and `formatCommandError` — all of which have default fallback implementations that duplicate the ones in `report.js`. This pattern exists primarily for testability, but it adds complexity.

**Recommendation:** Two options:

**Option A (Preferred): Direct imports with test-time module mocking.** Since the project uses Node's built-in test runner which supports `mock.module()` (available from Node 22+), the functions can be imported directly and mocked in tests. This eliminates the context plumbing entirely.

**Option B: Keep context injection but consolidate defaults.** If supporting Node 20 test mocking is important, keep the context pattern but import the defaults from shared modules rather than duplicating them. The context parameter would only carry `progress` (the one truly per-invocation concern).

---

## 4. Replace the Hand-Rolled Argument Parser

**Problem:** `parseArgs()` is ~240 lines of manual `if/else` chains with duplicated patterns for `--flag value` and `--flag=value` forms. Every new CLI option requires adding 6-10 lines in two places (space-separated and `=` forms), plus validation at the bottom.

**Recommendation:** Use Node's built-in `util.parseArgs()` (stable since Node 18.11). It handles both `--flag value` and `--flag=value` forms, boolean flags, short aliases, and unknown-argument errors automatically.

Example migration:

```js
import { parseArgs } from 'node:util'

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    output:                { type: 'string', short: 'o', default: DEFAULT_OUTPUT_PATH },
    'output-dir':          { type: 'string' },
    cwd:                   { type: 'string' },
    'include-untracked':   { type: 'boolean', default: false },
    'no-report':           { type: 'boolean', default: false },
    'list-unowned':        { type: 'boolean', default: false },
    'fail-on-unowned':     { type: 'boolean', default: false },
    'suggest-teams':       { type: 'boolean', default: false },
    'suggest-window-days': { type: 'string' },
    'suggest-top':         { type: 'string' },
    glob:                  { type: 'string', short: 'g', multiple: true },
    upload:                { type: 'boolean', default: false },
    yes:                   { type: 'boolean', short: 'y', default: false },
    'no-open':             { type: 'boolean', default: false },
    verbose:               { type: 'boolean', default: false },
    help:                  { type: 'boolean', short: 'h', default: false },
    version:               { type: 'boolean', short: 'v', default: false },
    // ... etc
  },
})
```

This would reduce `parseArgs()` from ~240 lines to ~60 lines (option spec + post-validation).

---

## 5. Reduce JSDoc Type Annotation Duplication

**Problem:** The same complex type shapes (report structure, suggestion rows, warning objects) are duplicated across 10+ JSDoc blocks. For example, the full report type is written out verbatim in `buildReport()`, `renderHtml()`, and `outputUnownedReportResults()`. The suggestion row type appears in `buildNoAuthSuggestions()`, `buildErrorSuggestions()`, `rankDirectoryTeamSuggestions()`, and `collectDirectoryTeamSuggestions()`.

**Recommendation:** Define shared `@typedef` types at the top of each module (or in a dedicated `lib/types.js` that only contains `@typedef` exports). Then reference them with `@type {import('./types.js').ReportData}`.

Example:

```js
// lib/types.js

/**
 * @typedef {{
 *   repoName: string,
 *   generatedAt: string,
 *   totals: ReportTotals,
 *   directories: DirectoryRow[],
 *   unownedFiles: string[],
 *   teamOwnership: TeamOwnershipRow[],
 *   codeownersValidationMeta: ValidationMeta,
 *   directoryTeamSuggestions: TeamSuggestionRow[],
 *   directoryTeamSuggestionsMeta: TeamSuggestionMeta,
 * }} ReportData
 */

/**
 * @typedef {{
 *   path: string,
 *   status: 'ok'|'no-history'|'no-auth'|'insufficient-mapping'|'no-team-match'|'error',
 *   totalEdits: number,
 *   resolvedLoginEdits: number,
 *   mappedEdits: number,
 *   coverageRatio: number,
 *   candidates: TeamCandidate[],
 *   reason?: string
 * }} TeamSuggestionRow
 */
```

This cuts hundreds of lines of duplicated type annotations and makes type changes a single-point edit.

---

## 6. Extract CODEOWNERS Parsing into a Standalone Module

**Problem:** The CODEOWNERS parsing logic (pattern matching, line tokenization, comment stripping, glob-to-regex conversion) is interleaved with CLI-specific code in `report.js`. This makes it impossible to reuse as a library or test the parser independently.

**Recommendation:** Create `lib/codeowners-parser.js` exporting:
- `parseCodeowners(fileContent)` → rule array
- `parseCodeownersRuleLine(line)` → single rule or null
- `createPatternMatcher(pattern, options)` → matcher function

These are pure functions with no side effects — ideal for unit testing. The glob-to-regex engine (`globToRegexSource`, `escapeRegexChar`) would be internal to this module.

**Benefit:** If you ever want to add features like CODEOWNERS linting, auto-fix suggestions, or pattern validation, having a clean parser module is essential.

---

## 7. Separate CLI Orchestration from Business Logic

**Problem:** The `main()` function in `report.js` mixes high-level flow control with low-level operations (temp directory management, `try/catch` cleanup, `process.exit` calls). This makes it hard to use the tool programmatically (e.g., as an imported library in another project).

**Recommendation:** Split into two layers:

1. **`report.js` (CLI entry point):** Handles `process.argv`, `process.exit`, temp directory lifecycle, and console output. Thin wrapper.
2. **`lib/audit.js` (core logic):** A pure `async function audit(options)` that accepts a structured options object and returns a report object. No `process.exit`, no `console.log`, no temp directory management — those are the caller's responsibility.

This enables:
- Programmatic usage: `import { audit } from 'codeowners-audit/lib/audit.js'`
- Easier testing: test the audit function directly without spawning a child process
- Future API surfaces: GitHub Action wrapper, VS Code extension, etc.

---

## 8. Improve Test Granularity

**Problem:** The test suite (`test/cli.test.js`) tests everything through the CLI interface by spawning child processes. While this provides excellent end-to-end coverage, it makes tests slow and makes it hard to test edge cases in individual functions (e.g., pattern matching corner cases, URL parsing).

**Recommendation:** After extracting modules, add unit tests per module:

| Test File | Tests |
|---|---|
| `test/codeowners-parser.test.js` | Pattern matching, line parsing, comment handling, glob edge cases |
| `test/pattern-matcher.test.js` | Glob-to-regex conversion, anchored vs unanchored, directory patterns |
| `test/repository.test.js` | URL detection, normalization, display name derivation |
| `test/cli-args.test.js` | Argument parsing, validation, defaults |
| `test/report-builder.test.js` | Coverage calculation, directory stats, owner resolution |

Keep `test/cli.test.js` as the integration/E2E suite but move fine-grained assertions to unit tests. This makes the test suite faster and more precise about failure locations.

---

## 9. Consider TypeScript (or JSDoc Strict Mode)

**Problem:** The project uses extensive JSDoc for type hints, but without enforcement. Type errors can slip through unnoticed. The duplicated type annotations (see point 5) are a symptom of lacking a proper type system.

**Recommendation (low priority):** Two options:

**Option A: TypeScript with `--declaration` for type checking only.** Rename `.js` → `.ts`, get compiler checking, and emit `.js` for publishing. Zero runtime cost.

**Option B: JSDoc with `tsconfig.json` checking.** Keep `.js` files but add `tsconfig.json` with `"checkJs": true, "allowJs": true`. This gives type checking without changing the file format. This is the lower-friction option.

Either approach catches type bugs at development time and enables IDE autocompletion for consumers.

---

## 10. Minor Code Quality Items

### 10a. `resolveOwners` is a trivial wrapper
`resolveOwners()` (line 2150) just calls `findMatchingOwners()`. Remove the indirection — use `findMatchingOwners` directly or rename it to `resolveOwners`.

### 10b. `uploadReport` is a trivial wrapper
`uploadReport()` (line 1203) just calls `uploadToZenbin()`. If there's no plan to support multiple upload providers, collapse these into one function.

### 10c. Inconsistent error handling patterns
Some functions throw errors, some return null, some return empty strings. Standardize: throwing for unexpected failures, returning `null`/`undefined` for "not found" cases.

### 10d. Magic numbers
Constants like `5` (max sample SHAs in team-suggestions.js:534), `200` (max pagination pages in github-api.js:16), and `40` (max page ID length in report.js:1288) should be named constants.

### 10e. `buildNoAuthSuggestions` and `buildErrorSuggestions` are nearly identical
These two functions differ only in the `status` field value and whether `reason` is optional. Consolidate into a single `buildStatusSuggestions(directories, stats, loginMap, status, reason)` function.

---

## Suggested Implementation Order

1. **Extract shared utilities** (git, paths, github-identity) — low risk, eliminates duplication
2. **Extract CODEOWNERS parser** — clean boundary, enables unit tests
3. **Extract CLI arg parsing** (switch to `util.parseArgs`) — self-contained change
4. **Extract report builder and renderer** — moderate refactor
5. **Extract CLI output and prompts** — moderate refactor
6. **Extract upload and repository modules** — straightforward
7. **Introduce `lib/audit.js` orchestration layer** — requires steps 1-6
8. **Add unit tests for each new module** — parallel with extraction
9. **Consolidate JSDoc types** — can happen anytime
10. **Optional: Add TypeScript/JSDoc strict checking** — after stabilization

Each step is independently shippable and backward-compatible.
