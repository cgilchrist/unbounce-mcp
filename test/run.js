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
