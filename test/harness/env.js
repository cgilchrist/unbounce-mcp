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
