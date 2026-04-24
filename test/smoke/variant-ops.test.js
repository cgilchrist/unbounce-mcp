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
