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
