#!/usr/bin/env node
/**
 * Switch the unbounce MCP server between local development and the published GitHub package.
 *
 * Usage:
 *   node switch-mcp.js local    — use local checkout (node /path/to/index.js)
 *   node switch-mcp.js github   — use published package (npx -y github:cgilchrist/unbounce-mcp)
 *   node switch-mcp.js          — show current mode
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const CONFIG_PATHS = [
  path.join(os.homedir(), '.claude.json'),
]

function findConfig() {
  for (const p of CONFIG_PATHS) {
    if (fs.existsSync(p)) return p
  }
  throw new Error('Could not find Claude config file (~/.claude.json)')
}

const configPath = findConfig()
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
const server = config?.mcpServers?.unbounce

if (!server) {
  console.error('No "unbounce" MCP server found in', configPath)
  process.exit(1)
}

const mode = process.argv[2]

function currentMode() {
  if (server.command === 'npx') return 'github'
  if (server.command === 'node') return 'local'
  return 'unknown'
}

if (!mode) {
  console.log(`Current mode: ${currentMode()}`)
  console.log(`  command: ${server.command} ${(server.args || []).join(' ')}`)
  process.exit(0)
}

if (mode === 'local') {
  const localPath = server._local?.args?.[0] || path.join(path.dirname(configPath), 'Checkouts/unbounce-mcp/index.js')
  server.command = 'node'
  server.args = [localPath]
  console.log(`Switched to local: node ${localPath}`)
} else if (mode === 'github') {
  const githubArgs = server._github?.args || ['-y', 'github:cgilchrist/unbounce-mcp']
  server.command = 'npx'
  server.args = githubArgs
  console.log(`Switched to GitHub: npx ${githubArgs.join(' ')}`)
} else {
  console.error(`Unknown mode "${mode}". Use: local | github`)
  process.exit(1)
}

fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
console.log('Restart Claude Code for the change to take effect.')
