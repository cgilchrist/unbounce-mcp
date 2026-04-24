# Test Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a three-layer test harness (unit tests, smoke tests, interactive runner) so Claude Code can develop and verify unbounce-mcp changes end-to-end without restarting Claude Desktop.

**Architecture:** Subprocess MCP client for real protocol fidelity; in-process unit tests for pure logic; separate sandbox Unbounce user with isolated session file prevents blast radius on the real account.

**Tech Stack:** Node 18+, `node:test` (built-in, no deps), `node:child_process` for subprocess spawn, existing Playwright for headed login. Zero new runtime dependencies.

**Reference spec:** `docs/superpowers/specs/2026-04-23-test-harness-design.md`

---

## Task 1: Make session file path configurable

**Files:**
- Modify: `src/config.js`

- [ ] **Step 1: Update config.js to read UNBOUNCE_MCP_SESSION_FILE**

Replace the contents of `src/config.js` with:

```js
import * as os from 'os'
import * as path from 'path'

export const UNBOUNCE_API_KEY = process.env.UNBOUNCE_API_KEY
export const UNBOUNCE_API_BASE = 'https://api.unbounce.com'
export const UNBOUNCE_APP_BASE = 'https://app.unbounce.com'

export const SESSION_FILE = process.env.UNBOUNCE_MCP_SESSION_FILE
  || path.join(os.homedir(), '.unbounce-mcp', 'session.json')
export const SESSION_DIR = path.dirname(SESSION_FILE)

export function requireApiKey() {
  if (!UNBOUNCE_API_KEY) {
    throw new Error('UNBOUNCE_API_KEY environment variable is required. Add it to your MCP config.')
  }
  return UNBOUNCE_API_KEY
}
```

- [ ] **Step 2: Verify the server still boots with no env changes**

Run:
```bash
UNBOUNCE_API_KEY=dummy node -e "import('./src/config.js').then(c => console.log('SESSION_FILE=' + c.SESSION_FILE))"
```

Expected output (replace with your actual home dir):
```
SESSION_FILE=/Users/cartergilchrist/.unbounce-mcp/session.json
```

- [ ] **Step 3: Verify env override works**

Run:
```bash
UNBOUNCE_API_KEY=dummy UNBOUNCE_MCP_SESSION_FILE=/tmp/test-session.json node -e "import('./src/config.js').then(c => console.log('SESSION_FILE=' + c.SESSION_FILE))"
```

Expected output:
```
SESSION_FILE=/tmp/test-session.json
```

- [ ] **Step 4: Commit**

```bash
git add src/config.js
git commit -m "$(cat <<'EOF'
Make SESSION_FILE configurable via UNBOUNCE_MCP_SESSION_FILE env var

Enables the test harness to point the MCP server at a separate
session file without touching the user's personal session.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Add .env.test.example and update .gitignore

**Files:**
- Create: `.env.test.example`
- Modify: `.gitignore`

- [ ] **Step 1: Write .env.test.example**

Create `.env.test.example` with:

```
# Copy this file to .env.test and fill in the values.
# .env.test is gitignored — never commit real credentials.

# Unbounce API key for the sandbox client (generated in the sandbox
# client's API Access settings). Scoped so the REST API can only
# touch sandbox data.
UNBOUNCE_API_KEY=

# Path to the session file for the dedicated test user's cookies.
# Tilde (~) is expanded to the home directory.
# Kept separate from the personal ~/.unbounce-mcp/session.json so the
# harness cannot touch the user's production clients.
UNBOUNCE_MCP_SESSION_FILE=~/.unbounce-mcp/session.test.json

# Sub-account ID of the sandbox client. The interactive runner uses
# this to fill in `sub_account_id` when you omit it from the args.
UNBOUNCE_SANDBOX_SUB_ACCOUNT_ID=

# Default domain for smoke-test deploys. Must be a domain available
# in the sandbox sub-account.
UNBOUNCE_SANDBOX_DOMAIN=unbouncepages.com
```

- [ ] **Step 2: Update .gitignore**

Append to `.gitignore`:

```
.env.test
.test-runs/
```

(Leave the existing lines alone; add these at the bottom.)

- [ ] **Step 3: Verify .env.test is ignored**

Run:
```bash
touch .env.test && git status .env.test
```

Expected: `.env.test` does NOT appear in git status output. Remove the test file:
```bash
rm .env.test
```

- [ ] **Step 4: Commit**

```bash
git add .env.test.example .gitignore
git commit -m "$(cat <<'EOF'
Add test harness env template and gitignore entries

.env.test.example documents the required sandbox credentials;
.env.test and .test-runs/ are gitignored so credentials and run
logs never get committed.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Write test env loader

**Files:**
- Create: `test/harness/env.js`
- Test: inline — we'll sanity-check by running it

- [ ] **Step 1: Create the directory and write env.js**

Create `test/harness/env.js` with:

```js
/**
 * Loads and validates .env.test for the test harness.
 *
 * Tiny handwritten parser — no dotenv dependency. Supports KEY=VALUE lines,
 * comments (# prefix), blank lines, and surrounding quotes. Tilde expansion
 * on path-like values.
 *
 * Returns a plain object. Does not mutate process.env — callers pass the
 * object into child processes explicitly.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

const REQUIRED = [
  'UNBOUNCE_API_KEY',
  'UNBOUNCE_MCP_SESSION_FILE',
  'UNBOUNCE_SANDBOX_SUB_ACCOUNT_ID',
]

function expandHome(p) {
  if (!p) return p
  if (p === '~') return os.homedir()
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  return p
}

function parseEnvFile(text) {
  const out = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

/**
 * @param {object} [opts]
 * @param {string} [opts.envFile='.env.test'] - Path relative to repo root.
 * @param {boolean} [opts.requireSessionFile=true] - Assert the session file exists on disk.
 * @returns {Record<string, string>}
 */
export function loadTestEnv({ envFile = '.env.test', requireSessionFile = true } = {}) {
  const envPath = path.resolve(envFile)
  if (!fs.existsSync(envPath)) {
    throw new Error(
      `${envFile} not found. Copy .env.test.example to .env.test and fill in the values.`
    )
  }
  const env = parseEnvFile(fs.readFileSync(envPath, 'utf8'))

  if (env.UNBOUNCE_MCP_SESSION_FILE) {
    env.UNBOUNCE_MCP_SESSION_FILE = expandHome(env.UNBOUNCE_MCP_SESSION_FILE)
  }

  const missing = REQUIRED.filter(k => !env[k])
  if (missing.length) {
    throw new Error(
      `Missing required env vars in ${envFile}: ${missing.join(', ')}`
    )
  }

  if (requireSessionFile && !fs.existsSync(env.UNBOUNCE_MCP_SESSION_FILE)) {
    throw new Error(
      `Session file does not exist: ${env.UNBOUNCE_MCP_SESSION_FILE}\n` +
      `Run \`node test/harness/login.js\` to log in as the test user.`
    )
  }

  return env
}
```

- [ ] **Step 2: Sanity-check parsing (no .env.test required)**

Run:
```bash
node -e "
import('./test/harness/env.js').then(m => {
  // Write a temp .env.test for this check
  const fs = require('node:fs')
  fs.writeFileSync('.env.test', 'UNBOUNCE_API_KEY=dummy\nUNBOUNCE_MCP_SESSION_FILE=/tmp/absent\nUNBOUNCE_SANDBOX_SUB_ACCOUNT_ID=abc\n')
  try {
    m.loadTestEnv({ requireSessionFile: false })
    console.log('PARSE OK')
  } finally {
    fs.rmSync('.env.test')
  }
})
"
```

Expected output:
```
PARSE OK
```

- [ ] **Step 3: Sanity-check missing-file error**

Run:
```bash
node -e "
import('./test/harness/env.js').then(m => {
  try { m.loadTestEnv() } catch (e) { console.log('ERR:', e.message) }
})
"
```

Expected:
```
ERR: .env.test not found. Copy .env.test.example to .env.test and fill in the values.
```

- [ ] **Step 4: Commit**

```bash
git add test/harness/env.js
git commit -m "$(cat <<'EOF'
Add test harness env loader

Parses .env.test without a dotenv dependency, validates required
keys, expands ~ in path values, and asserts the session file
exists on disk.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Write MCP subprocess client

**Files:**
- Create: `test/harness/mcp-client.js`

- [ ] **Step 1: Write mcp-client.js**

Create `test/harness/mcp-client.js` with:

```js
/**
 * Lightweight MCP client that spawns the unbounce-mcp server as a subprocess
 * and speaks JSON-RPC over stdio.
 *
 * - Streams stderr to the current process's stderr in real time, prefixed [mcp].
 * - Optionally tees stderr to a file (for the interactive runner's .test-runs/).
 * - Parses stdout as newline-delimited JSON-RPC frames.
 * - Handles the initialize / notifications/initialized handshake automatically.
 */

import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SERVER_PATH = path.resolve(__dirname, '../../index.js')

const DEFAULT_REQUEST_TIMEOUT_MS = 5 * 60 * 1000

export class McpClient {
  constructor({ env = {}, stderrFile = null, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
    this.env = env
    this.stderrFile = stderrFile
    this.timeoutMs = timeoutMs
    this.proc = null
    this.pending = new Map()
    this.nextId = 1
    this.stdoutBuf = ''
    this.exited = false
  }

  async start() {
    this.proc = spawn('node', [SERVER_PATH], {
      env: { ...process.env, ...this.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.proc.stdout.setEncoding('utf8')
    this.proc.stdout.on('data', chunk => this._onStdout(chunk))

    this.proc.stderr.setEncoding('utf8')
    this.proc.stderr.on('data', chunk => this._onStderr(chunk))

    this.proc.on('exit', code => this._onExit(code))

    await this._request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'unbounce-mcp-harness', version: '0.0.0' },
    })

    this._notify('notifications/initialized')
  }

  _onStdout(chunk) {
    this.stdoutBuf += chunk
    let nl
    while ((nl = this.stdoutBuf.indexOf('\n')) !== -1) {
      const line = this.stdoutBuf.slice(0, nl)
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1)
      if (!line.trim()) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        clearTimeout(timer)
        if (msg.error) reject(new Error(`MCP error: ${msg.error.message}`))
        else resolve(msg.result)
      }
    }
  }

  _onStderr(chunk) {
    const prefixed = chunk
      .split('\n')
      .map((l, i, arr) => (i === arr.length - 1 && !l ? l : `[mcp] ${l}`))
      .join('\n')
    process.stderr.write(prefixed)
    if (this.stderrFile) {
      fs.appendFileSync(this.stderrFile, chunk)
    }
  }

  _onExit(code) {
    this.exited = true
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer)
      reject(new Error(`MCP server exited (code ${code}) before responding`))
    }
    this.pending.clear()
  }

  _request(method, params) {
    if (this.exited) return Promise.reject(new Error('MCP server has exited'))
    const id = this.nextId++
    const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP request timed out: ${method}`))
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.proc.stdin.write(frame)
    })
  }

  _notify(method, params) {
    const frame = JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'
    this.proc.stdin.write(frame)
  }

  async listTools() {
    return this._request('tools/list', {})
  }

  async call(name, args) {
    return this._request('tools/call', { name, arguments: args })
  }

  async close() {
    if (!this.proc || this.exited) return
    this.proc.kill('SIGTERM')
    await new Promise(resolve => {
      if (this.exited) resolve()
      else this.proc.once('exit', resolve)
    })
  }
}
```

- [ ] **Step 2: Write a quick smoke of the client (no-auth tools/list)**

Run:
```bash
node -e "
import('./test/harness/mcp-client.js').then(async ({ McpClient }) => {
  const client = new McpClient({ env: { UNBOUNCE_API_KEY: 'dummy' } })
  await client.start()
  const result = await client.listTools()
  console.log('tool_count=' + result.tools.length)
  console.log('first_tool=' + result.tools[0].name)
  await client.close()
}).catch(e => { console.error(e); process.exit(1) })
"
```

Expected output (numbers/names approximate; what matters is that both print):
```
tool_count=34
first_tool=reauthenticate
```

If the server logs appear as `[mcp] ...` lines interleaved with the result, the stderr streaming is working.

- [ ] **Step 3: Commit**

```bash
git add test/harness/mcp-client.js
git commit -m "$(cat <<'EOF'
Add MCP subprocess client for test harness

Spawns the unbounce-mcp server, handles initialize handshake,
sends tools/call requests, and streams stderr in real time with
[mcp] prefix so console.error logs from the server are visible
alongside tool results.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Export slugify and evenWeights from tools.js

**Files:**
- Modify: `src/tools.js:26-41` (the `evenWeights` and `slugify` function declarations)

- [ ] **Step 1: Add `export` keyword to both helpers**

In `src/tools.js`, change:

```js
function evenWeights(variantIds) {
```

to:

```js
export function evenWeights(variantIds) {
```

And change:

```js
function slugify(name) {
```

to:

```js
export function slugify(name) {
```

Leave the rest of the file alone — internal callers still work.

- [ ] **Step 2: Verify server still boots**

Run:
```bash
UNBOUNCE_API_KEY=dummy node -e "
import('./src/tools.js').then(m => {
  console.log('evenWeights=' + typeof m.evenWeights)
  console.log('slugify=' + typeof m.slugify)
})
"
```

Expected:
```
evenWeights=function
slugify=function
```

- [ ] **Step 3: Commit**

```bash
git add src/tools.js
git commit -m "$(cat <<'EOF'
Export slugify and evenWeights for unit testing

Pure helpers previously kept module-private. Exporting them lets
the unit test suite exercise them directly without going through
the full tool invocation.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Unit tests for tools.js helpers

**Files:**
- Create: `test/unit/tools-helpers.test.js`

- [ ] **Step 1: Write the test file**

Create `test/unit/tools-helpers.test.js` with:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { slugify, evenWeights } from '../../src/tools.js'

test('slugify lowercases and replaces non-alphanumerics', () => {
  assert.equal(slugify('Summer Promo 2026!'), 'summer-promo-2026')
})

test('slugify collapses runs of non-alphanumerics to a single dash', () => {
  assert.equal(slugify('A  B  C'), 'a-b-c')
  assert.equal(slugify('A!!!B???C'), 'a-b-c')
})

test('slugify trims leading and trailing dashes', () => {
  assert.equal(slugify('---foo---'), 'foo')
  assert.equal(slugify('   foo   '), 'foo')
})

test('slugify falls back to "page" for empty-ish input', () => {
  assert.equal(slugify(''), 'page')
  assert.equal(slugify('!!!'), 'page')
})

test('evenWeights splits 100 evenly among variants', () => {
  assert.deepEqual(evenWeights(['a', 'b']), { a: 50, b: 50 })
  assert.deepEqual(evenWeights(['a', 'b', 'c', 'd']), { a: 25, b: 25, c: 25, d: 25 })
})

test('evenWeights gives champion (a) the remainder on non-divisible splits', () => {
  assert.deepEqual(evenWeights(['a', 'b', 'c']), { a: 34, b: 33, c: 33 })
  // 100 / 7 = 14 base, remainder 2 → a gets 16
  const w = evenWeights(['a', 'b', 'c', 'd', 'e', 'f', 'g'])
  assert.equal(w.a, 16)
  assert.equal(Object.values(w).reduce((s, n) => s + n, 0), 100)
})

test('evenWeights always sums to 100', () => {
  for (let n = 1; n <= 26; n++) {
    const ids = Array.from({ length: n }, (_, i) => String.fromCharCode(97 + i))
    const w = evenWeights(ids)
    const sum = Object.values(w).reduce((s, v) => s + v, 0)
    assert.equal(sum, 100, `n=${n} did not sum to 100`)
  }
})
```

- [ ] **Step 2: Run the test to verify it passes**

Run:
```bash
node --test test/unit/tools-helpers.test.js
```

Expected: all tests pass. Summary line shows `pass 7`.

- [ ] **Step 3: Commit**

```bash
git add test/unit/tools-helpers.test.js
git commit -m "$(cat <<'EOF'
Add unit tests for slugify and evenWeights

Covers slug normalization edge cases and the variant-weight
split invariant (always sums to 100, champion gets remainder).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Unit tests for transform.js

**Files:**
- Create: `test/unit/transform.test.js`

- [ ] **Step 1: Write the test file**

Create `test/unit/transform.test.js` with:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as cheerio from 'cheerio'
import { scopeCssToContainer, scopeRawCss, transformForms, prepareVariantContent } from '../../src/transform.js'

const SCOPE = '#lp-code-1'

test('scopeCssToContainer prefixes simple selectors', () => {
  const out = scopeCssToContainer('.hero { color: red; }', SCOPE)
  assert.match(out, /#lp-code-1 \.hero/)
})

test('scopeCssToContainer preserves @keyframes verbatim', () => {
  const css = '@keyframes slide { from { left: 0 } to { left: 100px } }'
  const out = scopeCssToContainer(css, SCOPE)
  assert.match(out, /@keyframes slide/)
  assert.doesNotMatch(out, /#lp-code-1 from/)
  assert.doesNotMatch(out, /#lp-code-1 to/)
})

test('scopeCssToContainer scopes rules inside @media', () => {
  const css = '@media (max-width: 600px) { .hero { color: blue } }'
  const out = scopeCssToContainer(css, SCOPE)
  assert.match(out, /@media/)
  assert.match(out, /#lp-code-1 \.hero/)
})

test('scopeCssToContainer skips body selectors', () => {
  const out = scopeCssToContainer('body { margin: 0; }', SCOPE)
  // body stays as body — scopeSelectors returns it unchanged
  assert.match(out, /^\s*body\b/)
})

test('scopeCssToContainer does not double-prefix already-scoped selectors', () => {
  const css = '#lp-code-1 .hero { color: red; }'
  const out = scopeCssToContainer(css, SCOPE)
  // Should remain exactly one #lp-code-1 prefix
  const count = (out.match(/#lp-code-1/g) || []).length
  assert.equal(count, 1, `expected 1 #lp-code-1 prefix, got ${count}: ${out}`)
})

test('scopeRawCss is idempotent — scoping twice matches scoping once', () => {
  const css = '.hero { color: red; } .cta { background: blue; }'
  const once = scopeRawCss(css)
  const twice = scopeRawCss(once.replace(/^<style>|<\/style>$/g, ''))
  assert.equal(once, twice, 'scopeRawCss produced different output on second pass')
})

test('transformForms wraps loose inputs in a form when none exists', () => {
  const $ = cheerio.load(`
    <!doctype html><html><body>
      <label>Email</label><input type="email" name="email"/>
      <button>Sign up</button>
    </body></html>
  `)
  const hasForm = transformForms($, 'a')
  assert.equal(hasForm, true)
  assert.equal($('form').length, 1)
})

test('transformForms returns false when no form or loose inputs exist', () => {
  const $ = cheerio.load('<!doctype html><html><body><h1>Hi</h1></body></html>')
  assert.equal(transformForms($, 'a'), false)
  assert.equal($('form').length, 0)
})

test('transformForms is idempotent — running twice does not double-wrap', () => {
  const html = `
    <!doctype html><html><body>
      <label>Email</label><input type="email" name="email"/>
      <button>Sign up</button>
    </body></html>
  `
  const $ = cheerio.load(html)
  transformForms($, 'a')
  const afterFirst = $.html()
  transformForms($, 'a')
  const afterSecond = $.html()
  assert.equal($('form').length, 1, 'should still have exactly one form')
  assert.equal(afterFirst, afterSecond, 'transformForms should be idempotent')
})

test('prepareVariantContent returns bodyHtml and cssHtml', () => {
  const html = `
    <!doctype html><html>
      <head><style>.x { color: red; }</style></head>
      <body><div class="x">Hello</div></body>
    </html>
  `
  const { bodyHtml, cssHtml } = prepareVariantContent(html, 'a')
  assert.match(bodyHtml, /<div[^>]*class="x"[^>]*>Hello<\/div>/)
  assert.match(cssHtml, /<style>/)
  assert.match(cssHtml, /#lp-code-1/)
})
```

- [ ] **Step 2: Run the test**

Run:
```bash
node --test test/unit/transform.test.js
```

Expected: all tests pass. Summary line shows `pass 10`.

If any test fails, look at the transform function being tested. Idempotency failures (the scopeRawCss and transformForms cases) are real bugs — don't "fix" the test to match the broken behavior. Fix the function.

- [ ] **Step 3: Commit**

```bash
git add test/unit/transform.test.js
git commit -m "$(cat <<'EOF'
Add unit tests for CSS scoping and form transformation

Covers scopeCssToContainer edge cases (@keyframes preservation,
@media inner scoping, body/root selector handling, no-double-prefix)
and transformForms idempotency — the exact guarantees commit
301fb05 claimed.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Unit tests for packager.js

**Files:**
- Create: `test/unit/packager.test.js`

- [ ] **Step 1: Write the test file**

Create `test/unit/packager.test.js` with:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import * as tar from 'tar'
import { packageToUnbounce } from '../../src/packager.js'

const SIMPLE_HTML = `<!doctype html><html><head><title>T</title><style>.x{color:red}</style></head><body><div class="x">Hello</div></body></html>`

async function extractTarToDir(buf) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ubexport-test-'))
  const tarPath = path.join(dir, 'archive.tar')
  await fs.writeFile(tarPath, buf)
  await tar.extract({ file: tarPath, cwd: dir })
  await fs.rm(tarPath)
  // Top-level entry is the archive UUID directory
  const entries = await fs.readdir(dir)
  const archiveId = entries.find(e => !e.startsWith('.'))
  return path.join(dir, archiveId)
}

test('packageToUnbounce produces a non-empty buffer for single variant', async () => {
  const buf = await packageToUnbounce([{ name: 'a.html', html: SIMPLE_HTML }], [], 'Test')
  assert.ok(Buffer.isBuffer(buf), 'result should be a Buffer')
  assert.ok(buf.length > 0, 'result should be non-empty')
})

test('packageToUnbounce rejects empty html list', async () => {
  await assert.rejects(
    () => packageToUnbounce([], [], 'Test'),
    /at least one HTML file/i
  )
})

test('packageToUnbounce includes variant A directory structure', async () => {
  const buf = await packageToUnbounce([{ name: 'a.html', html: SIMPLE_HTML }], [], 'Test')
  const dir = await extractTarToDir(buf)
  try {
    const pagesDir = path.join(dir, 'pages')
    const pages = await fs.readdir(pagesDir)
    assert.equal(pages.length, 1, 'one page directory expected')
    const pageDir = path.join(pagesDir, pages[0])
    const variantDir = path.join(pageDir, 'page_variants', 'a')
    const stat = await fs.stat(variantDir)
    assert.ok(stat.isDirectory(), 'variant A directory missing')

    const metadata = JSON.parse(await fs.readFile(path.join(variantDir, 'metadata.json'), 'utf8'))
    assert.equal(metadata.variant_id, 'a')
    assert.equal(metadata.variant_weight, 100)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('packageToUnbounce creates three variant directories for three HTML files', async () => {
  const buf = await packageToUnbounce(
    [
      { name: 'a.html', html: SIMPLE_HTML },
      { name: 'b.html', html: SIMPLE_HTML },
      { name: 'c.html', html: SIMPLE_HTML },
    ],
    [],
    'Test'
  )
  const dir = await extractTarToDir(buf)
  try {
    const pagesDir = path.join(dir, 'pages')
    const [pageId] = await fs.readdir(pagesDir)
    const variantsDir = path.join(pagesDir, pageId, 'page_variants')
    const variants = await fs.readdir(variantsDir)
    variants.sort()
    assert.deepEqual(variants, ['a', 'b', 'c'])
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('packageToUnbounce preserves <ub:dynamic> tags through the cheerio round-trip', async () => {
  const dynamicHtml = `<!doctype html><html><body><h1><ub:dynamic parameter="city" method="titlecase">Vancouver</ub:dynamic></h1></body></html>`
  const buf = await packageToUnbounce([{ name: 'a.html', html: dynamicHtml }], [], 'Test')
  const dir = await extractTarToDir(buf)
  try {
    const pagesDir = path.join(dir, 'pages')
    const [pageId] = await fs.readdir(pagesDir)
    const elements = JSON.parse(
      await fs.readFile(
        path.join(pagesDir, pageId, 'page_variants', 'a', 'elements.json'),
        'utf8'
      )
    )
    const lpCode = elements.find(e => e.id === 'lp-code-1')
    assert.ok(lpCode.content.html.includes('<ub:dynamic'), 'ub:dynamic tag lost')
    assert.ok(lpCode.content.html.includes('Vancouver'), 'dynamic text lost')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
```

- [ ] **Step 2: Run the test**

Run:
```bash
node --test test/unit/packager.test.js
```

Expected: all tests pass. Summary line shows `pass 5`.

- [ ] **Step 3: Commit**

```bash
git add test/unit/packager.test.js
git commit -m "$(cat <<'EOF'
Add unit tests for packageToUnbounce

Verifies archive structure (single + multi-variant), rejects
empty input, and protects ub:dynamic tag preservation through
the cheerio round-trip.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Write interactive runner

**Files:**
- Create: `test/run.js`

- [ ] **Step 1: Write run.js**

Create `test/run.js` with:

```js
#!/usr/bin/env node
/**
 * Interactive harness runner.
 *
 * Usage:
 *   node test/run.js <tool_name> '<json-args>'
 *
 * Example:
 *   node test/run.js list_pages '{}'
 *   node test/run.js screenshot_variant '{"page_id":"xyz","variant":"a"}'
 *
 * Fills in `sub_account_id` from UNBOUNCE_SANDBOX_SUB_ACCOUNT_ID in .env.test
 * when omitted from the args object (caller-provided values always win).
 *
 * Saves stderr to .test-runs/<timestamp>-<tool>/stderr.log and writes any
 * returned images as PNG/JPEG files in the same directory.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { McpClient } from './harness/mcp-client.js'
import { loadTestEnv } from './harness/env.js'

const [, , toolName, argsJsonRaw] = process.argv

if (!toolName) {
  console.error('Usage: node test/run.js <tool_name> \'<json-args>\'')
  console.error('Example: node test/run.js list_pages \'{}\'')
  process.exit(1)
}

let args
try {
  args = argsJsonRaw ? JSON.parse(argsJsonRaw) : {}
} catch (err) {
  console.error(`Invalid JSON args: ${err.message}`)
  process.exit(1)
}

const env = loadTestEnv()

if (args.sub_account_id === undefined && env.UNBOUNCE_SANDBOX_SUB_ACCOUNT_ID) {
  args.sub_account_id = env.UNBOUNCE_SANDBOX_SUB_ACCOUNT_ID
}

const ts = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '')
const runDir = path.resolve(`.test-runs/${ts}-${toolName}`)
fs.mkdirSync(runDir, { recursive: true })
const stderrLog = path.join(runDir, 'stderr.log')

const client = new McpClient({
  env: {
    UNBOUNCE_API_KEY: env.UNBOUNCE_API_KEY,
    UNBOUNCE_MCP_SESSION_FILE: env.UNBOUNCE_MCP_SESSION_FILE,
  },
  stderrFile: stderrLog,
})

function printResult(result) {
  console.log('\n→ Result:')
  if (!result?.content) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  for (let i = 0; i < result.content.length; i++) {
    const c = result.content[i]
    if (c.type === 'text') {
      console.log(c.text)
    } else if (c.type === 'image') {
      const ext = (c.mimeType || 'image/png').split('/')[1] || 'png'
      const imgPath = path.join(runDir, `image-${i}.${ext}`)
      fs.writeFileSync(imgPath, Buffer.from(c.data, 'base64'))
      console.log(`[image ${i}] ${imgPath}`)
    } else {
      console.log(JSON.stringify(c, null, 2))
    }
  }
}

let exitCode = 0
try {
  await client.start()
  const result = await client.call(toolName, args)
  printResult(result)
  console.log(`\n→ Logs: ${stderrLog}`)
  if (result?.isError) exitCode = 1
} catch (err) {
  console.error(`\n✗ Runner error: ${err.message}`)
  exitCode = 1
} finally {
  await client.close()
  process.exit(exitCode)
}
```

- [ ] **Step 2: Guard — cannot be run without .env.test**

Run:
```bash
node test/run.js list_accounts '{}'
```

Expected: fails with a clear message like `.env.test not found. Copy .env.test.example to .env.test and fill in the values.`

(This proves the env loader is wired up. We'll verify real usage after the user finishes the sandbox setup — see Task 16.)

- [ ] **Step 3: Commit**

```bash
git add test/run.js
git commit -m "$(cat <<'EOF'
Add interactive harness runner

node test/run.js <tool> '<json-args>' spawns the MCP server with
sandbox env, invokes the tool, streams stderr with [mcp] prefix,
and saves any returned images + the full stderr log to
.test-runs/<timestamp>-<tool>/.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Write headed login helper

**Files:**
- Create: `test/harness/login.js`

- [ ] **Step 1: Write login.js**

Create `test/harness/login.js` with:

```js
#!/usr/bin/env node
/**
 * One-time headed login for the dedicated test user.
 *
 * Reads UNBOUNCE_MCP_SESSION_FILE from .env.test, sets it into
 * process.env BEFORE importing src/browser.js (so config.js picks up
 * the override), then delegates to doHeadedLogin — the same function
 * the MCP server uses for reauthenticate. This keeps the login flow
 * DRY with the real server behavior (remember-me auto-tick, cookie
 * filtering, CSRF grab).
 *
 * Opens a Chromium window. User logs in as the test user. Cookies
 * save to the configured session file path.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { loadTestEnv } from './env.js'

const env = loadTestEnv({ requireSessionFile: false })

// Make sure the session directory exists so saveSession can write
fs.mkdirSync(path.dirname(env.UNBOUNCE_MCP_SESSION_FILE), { recursive: true })

// Propagate to process.env before the dynamic import so config.js
// reads the override value at module-load time.
process.env.UNBOUNCE_API_KEY = env.UNBOUNCE_API_KEY
process.env.UNBOUNCE_MCP_SESSION_FILE = env.UNBOUNCE_MCP_SESSION_FILE

const { doHeadedLogin, closeBrowser } = await import('../../src/browser.js')

console.log(`Opening browser to log in as the sandbox test user.`)
console.log(`Session will save to: ${env.UNBOUNCE_MCP_SESSION_FILE}`)
console.log(`DO NOT log in as your personal account. Log in as the dedicated test user.`)

try {
  await doHeadedLogin()
  console.log(`\n✓ Session saved to ${env.UNBOUNCE_MCP_SESSION_FILE}`)
} finally {
  await closeBrowser()
}
```

- [ ] **Step 2: Sanity-check the script at least parses and errors on missing .env.test**

Run:
```bash
node test/harness/login.js
```

Expected output (assuming .env.test does not yet exist):
```
<error from loadTestEnv>: .env.test not found. Copy .env.test.example to .env.test and fill in the values.
```

(If you already have a `.env.test` and want to fully run login, do it at Task 16 when the user completes sandbox setup.)

- [ ] **Step 3: Commit**

```bash
git add test/harness/login.js
git commit -m "$(cat <<'EOF'
Add headed login helper for the test user

Wraps doHeadedLogin from src/browser.js with the sandbox session
file path plumbed through UNBOUNCE_MCP_SESSION_FILE. Reuses the
real server's login flow so the test session behaves identically
(remember-me auto-tick, CSRF grab, cookie filtering).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Smoke test — deploy cycle

**Files:**
- Create: `test/fixtures/hello.html`
- Create: `test/smoke/deploy-cycle.test.js`

- [ ] **Step 1: Write the fixture**

Create `test/fixtures/hello.html` with:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>Smoke Test Hello</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; padding: 40px; }
    h1 { color: #111; }
  </style>
</head>
<body>
  <h1>Hello from the unbounce-mcp smoke test</h1>
  <p>This page was deployed by the test harness and should be deleted immediately.</p>
</body>
</html>
```

- [ ] **Step 2: Write the smoke test**

Create `test/smoke/deploy-cycle.test.js` with:

```js
/**
 * Smoke: full deploy → read → edit → verify → delete cycle.
 *
 * Requires a working sandbox — .env.test and a valid session.test.json.
 * Creates a fresh page, deletes it in a finally block regardless of outcome.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpClient } from '../harness/mcp-client.js'
import { loadTestEnv } from '../harness/env.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const HELLO = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'hello.html'), 'utf8')
const HELLO_V2 = HELLO.replace('Hello from the unbounce-mcp smoke test', 'Hello v2 from the smoke test')

function parseToolResult(result) {
  const textPart = result.content?.find(c => c.type === 'text')
  if (!textPart) return result
  try { return JSON.parse(textPart.text) } catch { return textPart.text }
}

test('deploy → get_variant → edit_variant → get_variant → delete_page', { timeout: 180000 }, async () => {
  const env = loadTestEnv()
  const client = new McpClient({
    env: {
      UNBOUNCE_API_KEY: env.UNBOUNCE_API_KEY,
      UNBOUNCE_MCP_SESSION_FILE: env.UNBOUNCE_MCP_SESSION_FILE,
    },
  })
  await client.start()

  let pageId = null
  try {
    const deployRaw = await client.call('deploy_page', {
      sub_account_id: env.UNBOUNCE_SANDBOX_SUB_ACCOUNT_ID,
      html_variants: [HELLO],
      page_name: `smoke-${Date.now()}`,
      publish: false,
    })
    const deploy = parseToolResult(deployRaw)
    assert.equal(typeof deploy.page_id, 'string', 'deploy should return page_id')
    pageId = deploy.page_id

    const variantRaw = await client.call('get_variant', {
      sub_account_id: env.UNBOUNCE_SANDBOX_SUB_ACCOUNT_ID,
      page_id: pageId,
      variant: 'a',
    })
    const variant = parseToolResult(variantRaw)
    assert.match(variant.html ?? '', /Hello from the unbounce-mcp smoke test/)

    await client.call('edit_variant', {
      sub_account_id: env.UNBOUNCE_SANDBOX_SUB_ACCOUNT_ID,
      page_id: pageId,
      variant: 'a',
      html: HELLO_V2,
    })

    const variantV2Raw = await client.call('get_variant', {
      sub_account_id: env.UNBOUNCE_SANDBOX_SUB_ACCOUNT_ID,
      page_id: pageId,
      variant: 'a',
    })
    const variantV2 = parseToolResult(variantV2Raw)
    assert.match(variantV2.html ?? '', /Hello v2 from the smoke test/)
  } finally {
    if (pageId) {
      try {
        await client.call('delete_page', {
          sub_account_id: env.UNBOUNCE_SANDBOX_SUB_ACCOUNT_ID,
          page_id: pageId,
          confirm: true,
        })
      } catch (err) {
        console.error(`CLEANUP FAILED for page ${pageId}: ${err.message}`)
      }
    }
    await client.close()
  }
})
```

- [ ] **Step 3: Verify it fails fast without .env.test**

Run:
```bash
node --test test/smoke/deploy-cycle.test.js
```

Expected: test fails immediately with `.env.test not found` error. This is the correct pre-setup behavior — tests should not silently skip.

- [ ] **Step 4: Commit**

```bash
git add test/fixtures/hello.html test/smoke/deploy-cycle.test.js
git commit -m "$(cat <<'EOF'
Add smoke test: deploy → edit → delete cycle

Single end-to-end scenario covering the hot path: deploy_page,
get_variant, edit_variant, get_variant (verify edit), and
delete_page (cleanup via finally).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Smoke test — screenshot

**Files:**
- Create: `test/smoke/screenshot.test.js`

- [ ] **Step 1: Write the test**

Create `test/smoke/screenshot.test.js` with:

```js
/**
 * Smoke: screenshot_variant in both preview and published modes.
 *
 * Verifies the tool returns an image response (non-zero PNG bytes),
 * not an error. Does not assert on visual content — visual verification
 * remains a human task (via the interactive runner).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpClient } from '../harness/mcp-client.js'
import { loadTestEnv } from '../harness/env.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const HELLO = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'hello.html'), 'utf8')

function parseToolResult(result) {
  const textPart = result.content?.find(c => c.type === 'text')
  if (!textPart) return result
  try { return JSON.parse(textPart.text) } catch { return textPart.text }
}

function extractImage(result) {
  return result.content?.find(c => c.type === 'image')
}

test('screenshot_variant returns an image for preview and published', { timeout: 240000 }, async () => {
  const env = loadTestEnv()
  const client = new McpClient({
    env: {
      UNBOUNCE_API_KEY: env.UNBOUNCE_API_KEY,
      UNBOUNCE_MCP_SESSION_FILE: env.UNBOUNCE_MCP_SESSION_FILE,
    },
  })
  await client.start()

  let pageId = null
  try {
    const deploy = parseToolResult(await client.call('deploy_page', {
      sub_account_id: env.UNBOUNCE_SANDBOX_SUB_ACCOUNT_ID,
      html_variants: [HELLO],
      page_name: `smoke-shot-${Date.now()}`,
      domain: env.UNBOUNCE_SANDBOX_DOMAIN || 'unbouncepages.com',
      publish: true,
    }))
    pageId = deploy.page_id
    assert.ok(pageId, 'deploy should return page_id')
    assert.ok(deploy.url, 'publish should return live url')

    const previewShot = await client.call('screenshot_variant', {
      sub_account_id: env.UNBOUNCE_SANDBOX_SUB_ACCOUNT_ID,
      page_id: pageId,
      variant: 'a',
      source: 'preview',
    })
    const previewImg = extractImage(previewShot)
    assert.ok(previewImg, 'preview screenshot should return an image part')
    assert.ok(previewImg.data.length > 1000, 'preview screenshot should be more than 1KB')

    const publishedShot = await client.call('screenshot_variant', {
      sub_account_id: env.UNBOUNCE_SANDBOX_SUB_ACCOUNT_ID,
      page_id: pageId,
      variant: 'a',
      source: 'published',
    })
    const publishedImg = extractImage(publishedShot)
    assert.ok(publishedImg, 'published screenshot should return an image part')
    assert.ok(publishedImg.data.length > 1000, 'published screenshot should be more than 1KB')
  } finally {
    if (pageId) {
      try {
        await client.call('delete_page', {
          sub_account_id: env.UNBOUNCE_SANDBOX_SUB_ACCOUNT_ID,
          page_id: pageId,
          confirm: true,
        })
      } catch (err) {
        console.error(`CLEANUP FAILED for page ${pageId}: ${err.message}`)
      }
    }
    await client.close()
  }
})
```

- [ ] **Step 2: Verify the file parses**

Run:
```bash
node --check test/smoke/screenshot.test.js && echo OK
```

Expected output:
```
OK
```

- [ ] **Step 3: Commit**

```bash
git add test/smoke/screenshot.test.js
git commit -m "$(cat <<'EOF'
Add smoke test: screenshot_variant (preview + published)

Deploys a page, publishes it, captures screenshots in both modes,
asserts the response contains a non-trivial image payload. Cleans
up the page in a finally block.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Smoke test — variant ops

**Files:**
- Create: `test/smoke/variant-ops.test.js`

- [ ] **Step 1: Write the test**

Create `test/smoke/variant-ops.test.js` with:

```js
/**
 * Smoke: variant lifecycle — add, rename, activate, deactivate.
 *
 * Deploys a single-variant page, adds a variant, renames it, activates
 * it (switches to A/B test mode implicitly), then deactivates it.
 * Cleans up with delete_page in finally.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpClient } from '../harness/mcp-client.js'
import { loadTestEnv } from '../harness/env.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const HELLO = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'hello.html'), 'utf8')

function parseToolResult(result) {
  const textPart = result.content?.find(c => c.type === 'text')
  if (!textPart) return result
  try { return JSON.parse(textPart.text) } catch { return textPart.text }
}

test('add_variant → rename_variant → get_page_variants → activate → deactivate', { timeout: 240000 }, async () => {
  const env = loadTestEnv()
  const client = new McpClient({
    env: {
      UNBOUNCE_API_KEY: env.UNBOUNCE_API_KEY,
      UNBOUNCE_MCP_SESSION_FILE: env.UNBOUNCE_MCP_SESSION_FILE,
    },
  })
  await client.start()

  let pageId = null
  try {
    const deploy = parseToolResult(await client.call('deploy_page', {
      sub_account_id: env.UNBOUNCE_SANDBOX_SUB_ACCOUNT_ID,
      html_variants: [HELLO],
      page_name: `smoke-variants-${Date.now()}`,
      publish: false,
    }))
    pageId = deploy.page_id
    assert.ok(pageId, 'deploy should return page_id')

    const added = parseToolResult(await client.call('add_variant', {
      sub_account_id: env.UNBOUNCE_SANDBOX_SUB_ACCOUNT_ID,
      page_id: pageId,
    }))
    const newLetter = added.variant || added.new_variant || added.variantId
    assert.ok(newLetter, `add_variant should return the new variant letter, got: ${JSON.stringify(added)}`)
    assert.notEqual(newLetter, 'a', 'new variant should not be letter a')

    await client.call('rename_variant', {
      sub_account_id: env.UNBOUNCE_SANDBOX_SUB_ACCOUNT_ID,
      page_id: pageId,
      variant: newLetter,
      name: 'Smoke Test Challenger',
    })

    const variants = parseToolResult(await client.call('get_page_variants', {
      sub_account_id: env.UNBOUNCE_SANDBOX_SUB_ACCOUNT_ID,
      page_id: pageId,
    }))
    const found = (variants.variants || []).find(v => v.variant === newLetter || v.variantId === newLetter)
    assert.ok(found, `renamed variant ${newLetter} should appear in get_page_variants`)
    const name = found.name || found.variantName
    assert.equal(name, 'Smoke Test Challenger', 'rename should persist')

    await client.call('activate_variant', {
      sub_account_id: env.UNBOUNCE_SANDBOX_SUB_ACCOUNT_ID,
      page_id: pageId,
      variant: newLetter,
    })

    await client.call('deactivate_variant', {
      sub_account_id: env.UNBOUNCE_SANDBOX_SUB_ACCOUNT_ID,
      page_id: pageId,
      variant: newLetter,
      confirm: true,
    })
  } finally {
    if (pageId) {
      try {
        await client.call('delete_page', {
          sub_account_id: env.UNBOUNCE_SANDBOX_SUB_ACCOUNT_ID,
          page_id: pageId,
          confirm: true,
        })
      } catch (err) {
        console.error(`CLEANUP FAILED for page ${pageId}: ${err.message}`)
      }
    }
    await client.close()
  }
})
```

- [ ] **Step 2: Verify the file parses**

Run:
```bash
node --check test/smoke/variant-ops.test.js && echo OK
```

Expected:
```
OK
```

- [ ] **Step 3: Commit**

```bash
git add test/smoke/variant-ops.test.js
git commit -m "$(cat <<'EOF'
Add smoke test: variant lifecycle ops

add_variant → rename_variant → get_page_variants (verify rename) →
activate_variant → deactivate_variant. Covers the challenger
creation + toggle path that breaks most often when direct.js GQL
mutations change.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: package.json scripts and files allowlist

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Update package.json**

Replace `package.json` with:

```json
{
  "name": "unbounce-mcp",
  "version": "0.1.0",
  "description": "MCP server for publishing landing pages to Unbounce — no UI required",
  "type": "module",
  "bin": {
    "unbounce-mcp": "./index.js"
  },
  "scripts": {
    "start": "node index.js",
    "test": "npm run test:unit && npm run test:smoke",
    "test:unit": "node --test test/unit",
    "test:smoke": "node --test test/smoke",
    "mcp": "node test/run.js",
    "login": "node test/harness/login.js"
  },
  "files": [
    "index.js",
    "src/",
    "switch-mcp.js",
    "README.md"
  ],
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "cheerio": "^1.0.0",
    "form-data": "^4.0.1",
    "playwright": "^1.40.0",
    "tar": "^7.0.0"
  },
  "engines": {
    "node": ">=18"
  }
}
```

- [ ] **Step 2: Verify unit tests still run via npm**

Run:
```bash
npm run test:unit
```

Expected: unit tests pass (the three files from Tasks 6, 7, 8). Summary shows all tests passed.

- [ ] **Step 3: Verify the files allowlist excludes test/ and docs/**

Run:
```bash
npm pack --dry-run 2>&1 | grep -E "(test/|docs/)" || echo "EXCLUDED OK"
```

Expected:
```
EXCLUDED OK
```

(If either appears in the pack output, the `files` allowlist is wrong.)

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "$(cat <<'EOF'
Add test/harness npm scripts and files allowlist

test, test:unit, test:smoke, mcp (interactive runner), login
(one-time sandbox login). files: allowlist ensures test/ and
docs/ are excluded from any npm publish.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 15: README — Development section

**Files:**
- Modify: `README.md` — append a new section at the end.

- [ ] **Step 1: Append Development section to README**

Add to the end of `README.md`:

```markdown

## Development

The repo ships with a local test harness so changes can be developed and verified without restarting any MCP client. See `docs/superpowers/specs/2026-04-23-test-harness-design.md` for the full design.

### One-time sandbox setup

1. Create a **sandbox Unbounce client** with its own API key.
2. Create a **dedicated test user** in Unbounce and invite them *only* to the sandbox client.
3. Copy `.env.test.example` to `.env.test` and fill in the sandbox API key, session file path, and sub-account ID.
4. Run the one-time headed login — log in as the **test user**, not your personal account:
   ```bash
   npm run login
   ```
   Cookies save to the path configured in `UNBOUNCE_MCP_SESSION_FILE`.

### Unit tests

Pure-logic tests. No network, no browser, runs in ~1 second.

```bash
npm run test:unit
```

### Smoke tests

End-to-end scenarios against the sandbox. Each test creates a page, exercises the tools, and deletes the page in a `finally` block.

```bash
npm run test:smoke
```

### Interactive runner

Invoke any tool against the sandbox with live stderr visible:

```bash
npm run mcp -- list_pages '{}'
npm run mcp -- screenshot_variant '{"page_id":"xyz","variant":"a"}'
```

The runner fills in `sub_account_id` from `UNBOUNCE_SANDBOX_SUB_ACCOUNT_ID` when omitted from the args. Each run saves its stderr log and any returned images under `.test-runs/<timestamp>-<tool>/`.

### Full suite

```bash
npm test
```

### Contributing notes

- **`console.log` is forbidden** in `src/`. `stdout` is the MCP transport — a stray `console.log` corrupts JSON-RPC frames. Always use `console.error` for debug output; the harness streams stderr live with an `[mcp]` prefix.
- Unit tests use Node 18+'s built-in `node:test`. No Jest / Vitest dependency.
```

- [ ] **Step 2: Verify the rendered README includes the section**

Run:
```bash
grep -c "^## Development" README.md
```

Expected: `1`

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "$(cat <<'EOF'
Add Development section documenting the test harness

One-time sandbox setup, unit/smoke/runner workflows, and the
console.log-vs-console.error gotcha for stdio MCP servers.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 16: User sandbox setup + first real verification

**Files:** none — this is a user action, not a code change.

This task is the handshake: the user completes the one-time Unbounce sandbox setup, then the harness is exercised end-to-end for the first time to prove it works.

- [ ] **Step 1: User creates sandbox client + test user**

User performs:
1. Creates a new Unbounce client named something like "MCP Sandbox".
2. Generates an API key for that client.
3. Invites a new Unbounce user (e.g. `mcp-sandbox@<domain>`) with access *only* to the sandbox client.

- [ ] **Step 2: User populates .env.test**

```bash
cp .env.test.example .env.test
# edit .env.test with the values from step 1
```

Populate:
- `UNBOUNCE_API_KEY` → the sandbox client's API key
- `UNBOUNCE_MCP_SESSION_FILE` → `~/.unbounce-mcp/session.test.json` (default is fine)
- `UNBOUNCE_SANDBOX_SUB_ACCOUNT_ID` → the sandbox sub-account ID (visible in the Unbounce URL)
- `UNBOUNCE_SANDBOX_DOMAIN` → `unbouncepages.com` (default is fine)

- [ ] **Step 3: User runs headed login as the test user**

```bash
npm run login
```

Chrome opens. User logs in as the **test user** (not their personal account). Once redirected to `/pages` or `/dashboard`, the browser closes automatically and the session saves.

- [ ] **Step 4: Verify interactive runner works end-to-end**

Run:
```bash
npm run mcp -- list_pages '{}'
```

Expected:
- `[mcp] ...` lines stream to stderr showing the server booting up.
- The result shows pages in the sandbox sub-account (likely empty or a short list).
- A `.test-runs/<timestamp>-list_pages/stderr.log` file exists.

If this works, the harness is functional.

- [ ] **Step 5: Run the smoke suite**

```bash
npm run test:smoke
```

Expected: all three smoke tests pass. Each creates a page in the sandbox, exercises tools, and deletes it. Total runtime roughly 60-180 seconds depending on Unbounce latency.

- [ ] **Step 6: Final commit (nothing to add — just confirm clean tree)**

Run:
```bash
git status
```

Expected: "nothing to commit, working tree clean". The harness is complete.

---

## Self-review

Performed against spec `docs/superpowers/specs/2026-04-23-test-harness-design.md`.

**Spec coverage:**

| Spec item | Task(s) |
|---|---|
| Three-layer architecture (unit / smoke / runner) | Tasks 6, 7, 8 (unit); 11, 12, 13 (smoke); 9 (runner) |
| Sandbox client + test user + separate session file | Tasks 1, 2, 10, 16 |
| `UNBOUNCE_MCP_SESSION_FILE` env var for session override | Task 1 |
| `.env.test.example` committed, `.env.test` gitignored | Task 2 |
| `test/harness/mcp-client.js` — subprocess client, stderr streaming | Task 4 |
| `test/harness/env.js` — loader, validation, `~` expansion, no dotenv dep | Task 3 |
| `test/harness/login.js` — one-time headed login for test user | Task 10 |
| Interactive runner with `sub_account_id` auto-fill + stderr log + image save | Task 9 |
| Three smoke scenarios (deploy-cycle / screenshot / variant-ops) | Tasks 11, 12, 13 |
| Try/finally cleanup | Every smoke task |
| `package.json` scripts + files allowlist | Task 14 |
| README Development section w/ `console.log` warning | Task 15 |
| No new runtime dependencies | Confirmed — only `node:test` and `child_process` added, both stdlib |

**Placeholder scan:** no TODOs, no "similar to Task N" references, no "add appropriate error handling." Every step either shows complete code or an exact command with expected output.

**Type consistency:** `McpClient.call(name, args)` is used identically across `test/run.js` and every smoke test. `loadTestEnv({ requireSessionFile })` signature matches both call sites. `parseToolResult` helper duplicated across smoke files intentionally (per no-DRY-between-tests convention) — same shape everywhere.
