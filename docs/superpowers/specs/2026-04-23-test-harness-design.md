# unbounce-mcp Test Harness — Design

**Date:** 2026-04-23
**Status:** Design (pre-implementation)

## Purpose

Close the dev loop on the unbounce-mcp server so Claude Code can develop, test, and verify changes autonomously — without the user manually restarting Claude Desktop to reload the server after each code change.

**Success criteria:** The user reports a bug or requests a feature. Claude Code resolves it end-to-end — writing the change, exercising the affected tools against a real Unbounce sandbox, iterating on the code based on the observed behavior, and handing back a commit — with no manual restart in the middle.

## Non-goals

- Replacing Claude Desktop as the primary user-facing client. Claude Desktop remains the product-level interface.
- Mocking or stubbing Unbounce. The harness hits a real sandbox Unbounce client. Mocks wouldn't catch the bugs we actually get (Playwright iframe quirks, JWT expiry, session cookie behavior, Unbounce publisher edge cases).
- CI / GitHub Actions integration. Local-only for now. The harness is designed so CI could be bolted on later but that's out of scope.
- Exhaustive tool coverage. We start with a small, high-signal smoke suite and add scenarios as real bugs surface.

## Architecture

Three layers, each targeting a different failure mode:

| Layer | What it covers | How it runs | Speed |
|---|---|---|---|
| **Unit** | Pure logic: `packager.js`, `transform.js`, `slugify`, `evenWeights`, `filterAuthCookies` | In-process, `node:test` | ~100ms total |
| **Smoke** | End-to-end tool scenarios against sandbox Unbounce | Subprocess MCP roundtrip | ~60s total |
| **Runner** | Interactive: invoke any tool, see result + live logs | Subprocess, single call | Per-invocation |

The **runner** and the **smoke suite** share one piece of infrastructure: a small MCP client library (`test/harness/mcp-client.js`) that spawns the server, speaks JSON-RPC over stdio, and streams stderr in real time. Unit tests bypass the protocol entirely.

### Why three layers

- **Unit** catches regressions in packager / transform logic in under a second — the fast feedback that makes refactoring safe.
- **Smoke** catches protocol-level, Unbounce-API-level, and browser-automation-level issues that only surface in a real roundtrip (e.g. the 1 MB tool-response limit that caused commit `45cf162`).
- **Runner** is the debugger — when Claude Code needs to iterate visually (screenshots, rendered HTML) or add `console.error` logs and watch them live.

## Auth & isolation

The existing MCP server has two auth surfaces:

1. `UNBOUNCE_API_KEY` (env var) — used by `src/api.js` for REST calls.
2. `~/.unbounce-mcp/session.json` — Playwright session cookies for browser-automation calls in `src/browser.js` / `src/direct.js`. These cookies belong to the logged-in Unbounce user and carry whatever access that user has across all clients.

**Blast-radius concern:** The user's personal session has access to all their Unbounce clients. A typo in a `sub_account_id` during a test run could mutate production pages.

**Solution:** Three-layer isolation.

1. **Dedicated sandbox client** in Unbounce, with its own API key.
2. **Dedicated test user** in Unbounce, scoped to access only the sandbox client.
3. **Separate session file** (e.g. `~/.unbounce-mcp/session.test.json`) containing only the test user's cookies, kept apart from the personal `session.json`.

The harness launches the MCP server with:
- `UNBOUNCE_API_KEY=<sandbox-key>`
- `UNBOUNCE_MCP_SESSION_FILE=<path-to-session.test.json>`

Because the test user literally cannot access the user's production clients in Unbounce, Playwright cannot touch them — even on a bad arg.

### One-time setup (user does once)

1. Create sandbox client in Unbounce, generate its API key.
2. Create test user, invite to sandbox client only.
3. Run `node test/harness/login.js` once — opens a headed browser, logs in as the test user, saves cookies to `session.test.json`.
4. Fill in `.env.test` with sandbox API key, session file path, and sandbox `sub_account_id`.

After that, the harness runs headless from existing cookies. If the test session expires, the harness **fails fast with a clear message** — it does not open a browser window mid-run.

## File layout

```
test/
  harness/
    mcp-client.js         # spawn server, send JSON-RPC, stream stderr, cleanup
    env.js                # load + validate .env.test; assert session file exists
    login.js              # one-time headed login flow for the test user
  unit/
    packager.test.js
    transform.test.js
    tools-helpers.test.js # slugify, evenWeights, filterAuthCookies
  smoke/
    deploy-cycle.test.js  # deploy → get_variant → edit_variant → delete_page
    screenshot.test.js    # screenshot_variant (preview + published sources)
    variant-ops.test.js   # add_variant, rename_variant, activate/deactivate
  fixtures/
    hello.html            # tiny known-good HTML for deploy tests
  run.js                  # interactive: `node test/run.js <tool> '<json-args>'`

docs/superpowers/specs/
  2026-04-23-test-harness-design.md   # this file

.env.test.example         # committed; documents required env vars
.env.test                 # gitignored; contains real sandbox credentials
```

## Configuration changes to existing code

**Only one source change:** `src/config.js` reads an optional `UNBOUNCE_MCP_SESSION_FILE` env var, falls back to the current path.

```js
// src/config.js
export const SESSION_FILE = process.env.UNBOUNCE_MCP_SESSION_FILE
  || path.join(os.homedir(), '.unbounce-mcp', 'session.json')
```

The `SESSION_DIR` constant derives from `SESSION_FILE` so directory creation still works.

**No other `src/` changes.** The harness adapts to the existing code, not the reverse.

## Interactive runner — UX

Invocation:

```bash
node test/run.js <tool_name> '<json-args>'
```

Example:

```bash
node test/run.js screenshot_variant '{"sub_account_id":"abc","page_id":"def","variant":"a"}'
```

Behavior:

1. Spawn `node index.js` with test env vars loaded from `.env.test`.
2. Send `initialize` → `tools/call` with given name + args.
3. Stream stderr to terminal in real time, prefixed `[mcp]`.
4. Print tool result (decoded JSON / caption / saved-image-path) on completion.
5. Save full stderr to `.test-runs/<timestamp>-<tool>/stderr.log` for later diffing.
6. Cleanly shut down the subprocess.

Output example:

```
[mcp] fetching variant preview URL…
[mcp] measured page height: 2400
[mcp] taking screenshot at viewport 375x2400
→ image saved to /tmp/screenshot-abc.png (312 KB)
```

The image saved from `screenshot_variant` is a real PNG on disk that Claude Code can `Read` to see visually and iterate on.

### Convenience: preset args

`.env.test` may define a default `sub_account_id`, so for repeated calls against the sandbox, args collapse:

```bash
node test/run.js list_pages '{}'
# equivalent to:
node test/run.js list_pages '{"sub_account_id":"<sandbox-id-from-.env.test>"}'
```

The runner fills in `sub_account_id` from env when the arg object omits it. Any other arg is passed through as-is. This is a quality-of-life shortcut; any explicit value the caller passes wins.

## Smoke suite — shape

Each smoke file tests one user-facing scenario end-to-end, creates its own page, asserts on results, and cleans up after itself. Pattern (pseudocode):

```js
test('deploy cycle', async () => {
  const client = await startMcp()
  try {
    const { page_id, url } = await client.call('deploy_page', { html_variants: [HELLO], ... })
    assert.match(url, /^https?:\/\//)

    const v = await client.call('get_variant', { page_id, variant: 'a', ... })
    assert.ok(v.html.includes('Hello'))

    await client.call('edit_variant', { page_id, variant: 'a', html: HELLO_V2, ... })
    const v2 = await client.call('get_variant', { ... })
    assert.ok(v2.html.includes('Hello v2'))

    await client.call('delete_page', { page_id, confirm: true, ... })
  } finally {
    await client.close()
  }
})
```

**Initial smoke scenarios (kept intentionally small):**

1. **deploy-cycle**: deploy_page → get_variant → edit_variant → get_variant → delete_page
2. **screenshot**: deploy_page → screenshot_variant (preview) → publish_page → screenshot_variant (published) → delete_page
3. **variant-ops**: deploy_page → add_variant → rename_variant → activate_variant → deactivate_variant → delete_page

Three scenarios totals ~60s and covers the tools that break most often. We add scenarios when real bugs show us a gap.

**Cleanup guarantee:** Every test wraps its flow in `try/finally` and deletes the page it created. If a test crashes mid-way, the next run logs orphaned sandbox pages and offers to clean them up.

## Unit tests — shape

Pure logic only. No network, no browser, no subprocess. Uses Node's built-in `node:test`:

```js
import { test } from 'node:test'
import assert from 'node:assert'
import { packageToUnbounce } from '../../src/packager.js'

test('packager produces valid tar', async () => {
  const buf = await packageToUnbounce([{ name: 'a.html', html: '<!doctype html>...' }], [], 'Test')
  assert.ok(buf.length > 0)
  // ...inspect tar contents
})
```

Initial targets:
- `packager.js` — package shape, HTML/CSS extraction, form transformation
- `transform.js` — CSS scoping idempotency, form transformation idempotency
- `tools.js` helpers — `slugify`, `evenWeights`
- `browser.js` helpers — `filterAuthCookies`, `cookiesToHeader` (the pure-function bits)

## Environment configuration

`.env.test.example` (committed):

```
# Unbounce sandbox client — safe to create/edit/delete pages
UNBOUNCE_API_KEY=

# Session file for the test user (NOT your personal session)
UNBOUNCE_MCP_SESSION_FILE=~/.unbounce-mcp/session.test.json

# Sandbox sub-account ID (fills in `sub_account_id` for the interactive runner)
UNBOUNCE_SANDBOX_SUB_ACCOUNT_ID=

# Optional: default domain for deploy-cycle smoke test
UNBOUNCE_SANDBOX_DOMAIN=unbouncepages.com
```

`.env.test` (gitignored): the real values.

`test/harness/env.js` loads `.env.test`, validates all required vars are set, and asserts the session file exists on disk with a helpful error if not ("run `node test/harness/login.js` first").

**Loader is ~30 lines, no dotenv dependency:** splits on `\n`, ignores comments and blanks, `KEY=VALUE` pairs, strips surrounding quotes, expands leading `~` in path values against `os.homedir()`. The harness then sets these into the child process's `env` when spawning `node index.js` — they're never merged into `process.env` of the harness itself, keeping test env isolated from any ambient shell state.

## package.json additions

```json
{
  "scripts": {
    "start": "node index.js",
    "test": "npm run test:unit && npm run test:smoke",
    "test:unit": "node --test test/unit",
    "test:smoke": "node --test test/smoke",
    "mcp": "node test/run.js"
  },
  "files": ["index.js", "src/", "switch-mcp.js", "README.md"]
}
```

The `files` allowlist explicitly excludes `test/` and `docs/` from any npm publish, as belt-and-suspenders isolation from the customer-facing surface.

**No new runtime dependencies.** `node:test` is built into Node 18+. The subprocess client is ~100 lines of spawn/parse code using only `child_process` and stdlib.

## Customer impact

Zero. A customer installing via `npx -y github:cgilchrist/unbounce-mcp`:

- Gets the `test/` dir cloned along with the rest (a few KB of source). Never loaded, never executed — entry is `index.js` per `package.json` `bin`.
- Gets no new dependencies in `node_modules`.
- Sees no new env vars take effect. `UNBOUNCE_MCP_SESSION_FILE` is unset → `SESSION_FILE` falls back to `~/.unbounce-mcp/session.json` exactly as today.
- Never runs `npm test` — MCP clients only invoke the server, not its scripts.

Nothing about the installed product changes.

## Removal

To undo the entire harness:

```bash
rm -rf test/ .env.test.example docs/superpowers/specs/2026-04-23-test-harness-design.md
# revert test-related scripts in package.json
# (optional) revert src/config.js SESSION_FILE env lookup
```

The `SESSION_FILE` env-var change is harmless to leave in place — when the env var is unset, behavior is identical to the current code. Removing it is purity, not correctness.

## Open questions deliberately deferred

- **CI integration** — defer. The local harness is prerequisite; CI is a later step.
- **Golden-image diffing for screenshots** — defer. First, see whether the 3 smoke scenarios surface enough regressions to warrant it. Until then, runner + visual inspection is enough.
- **Performance tests** — defer. Not a current pain point.
- **Orphaned-page cleanup tool** — included informally (next run detects orphans); promote to a dedicated script only if it proves necessary.
