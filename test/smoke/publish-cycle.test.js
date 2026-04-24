/**
 * Smoke: publish → unpublish lifecycle.
 *
 * Exercises the publish and unpublish tools end-to-end against the sandbox.
 * Deploys a page (publish:true), verifies a live URL was returned, unpublishes
 * it, confirms get_page reports state: unpublished, then deletes the page.
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

test('deploy (publish:true) → unpublish_page → verify state', { timeout: 240000 }, async () => {
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
      page_name: `smoke-publish-${Date.now()}`,
      domain: env.UNBOUNCE_SANDBOX_DOMAIN || 'unbouncepages.com',
      publish: true,
    }))
    pageId = deploy.page_id
    assert.ok(pageId, 'deploy should return page_id')
    assert.ok(deploy.url, 'publish should return live url')
    console.error(`[smoke] created page ${pageId} (will clean up in finally)`)

    await client.call('unpublish_page', {
      sub_account_id: env.UNBOUNCE_SANDBOX_SUB_ACCOUNT_ID,
      page_id: pageId,
    })

    const pageDetails = parseToolResult(await client.call('get_page', { page_id: pageId }))
    assert.equal(pageDetails.state, 'unpublished', `expected state 'unpublished', got '${pageDetails.state}'`)
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
        console.error(`To delete manually: npm run clean-sandbox -- --yes`)
      }
    }
    await client.close()
  }
})
