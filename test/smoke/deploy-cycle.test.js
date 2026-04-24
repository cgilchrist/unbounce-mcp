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
    console.error(`[smoke] created page ${pageId} (will clean up in finally)`)

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
        console.error(`To delete manually: npm run clean-sandbox -- --yes`)
      }
    }
    await client.close()
  }
})
