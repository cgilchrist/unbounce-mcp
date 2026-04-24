#!/usr/bin/env node
/**
 * Delete orphaned smoke-test pages in the sandbox sub-account.
 *
 * Targets only pages whose name starts with "smoke-" (the naming convention
 * used by every smoke test in test/smoke/). Pages created by hand with any
 * other name are untouched.
 *
 * Usage:
 *   node test/harness/clean-sandbox.js          # dry-run: list targets
 *   node test/harness/clean-sandbox.js --yes    # actually delete them
 */

import { McpClient } from './mcp-client.js'
import { loadTestEnv } from './env.js'

const env = loadTestEnv()
const args = new Set(process.argv.slice(2))
const apply = args.has('--yes') || args.has('-y')

const client = new McpClient({
  env: {
    UNBOUNCE_API_KEY: env.UNBOUNCE_API_KEY,
    UNBOUNCE_MCP_SESSION_FILE: env.UNBOUNCE_MCP_SESSION_FILE,
  },
})

function parseResult(res) {
  const text = res.content?.find(c => c.type === 'text')?.text
  return text ? JSON.parse(text) : res
}

try {
  await client.start()

  const parsed = parseResult(await client.call('list_pages', {
    sub_account_id: env.UNBOUNCE_SANDBOX_SUB_ACCOUNT_ID,
  }))
  const smokePages = (parsed.pages || []).filter(p => p.name?.startsWith('smoke-'))

  if (smokePages.length === 0) {
    console.log('No smoke-* pages in sandbox. Clean.')
    process.exit(0)
  }

  console.log(`Found ${smokePages.length} smoke-* page(s):`)
  for (const p of smokePages) console.log(`  ${p.id}  ${p.name}  (${p.state})`)

  if (!apply) {
    console.log('\nDry-run. Re-run with --yes to delete these pages.')
    process.exit(0)
  }

  console.log('\nDeleting...')
  let deleted = 0
  let failed = 0
  for (const p of smokePages) {
    try {
      await client.call('delete_page', {
        sub_account_id: env.UNBOUNCE_SANDBOX_SUB_ACCOUNT_ID,
        page_id: p.id,
        confirm: true,
      })
      console.log(`  ✓ ${p.id}  ${p.name}`)
      deleted++
    } catch (err) {
      console.error(`  ✗ ${p.id}  ${p.name}: ${err.message}`)
      failed++
    }
  }
  console.log(`\nDeleted ${deleted} · Failed ${failed}`)
  process.exit(failed ? 1 : 0)
} finally {
  await client.close()
}
