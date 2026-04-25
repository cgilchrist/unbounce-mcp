/**
 * Smoke: get_javascripts / set_javascripts round-trip on a fresh variant.
 *
 * Deploys a clean page (no scripts), confirms get_javascripts returns [],
 * sets three scripts (one per placement slot), reads them back, then
 * clears with [] and verifies clear succeeded. Cleans up via delete_page.
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

test('get_javascripts → set_javascripts → get_javascripts → clear', { timeout: 240000 }, async () => {
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
      page_name: `smoke-js-${Date.now()}`,
      publish: false,
    }))
    pageId = deploy.page_id
    assert.ok(pageId, 'deploy should return page_id')
    console.error(`[smoke] created page ${pageId} (will clean up in finally)`)

    // Fresh page: no custom scripts.
    const empty = parseToolResult(await client.call('get_javascripts', {
      sub_account_id: env.UNBOUNCE_SANDBOX_SUB_ACCOUNT_ID,
      page_id: pageId,
      variant: 'a',
    }))
    assert.deepEqual(empty.scripts, [], 'fresh variant should have zero custom scripts')

    // Set three — one per placement slot.
    const SCRIPTS = [
      { name: 'Smoke Head', placement: 'head', html: '<script>/* smoke head */</script>' },
      { name: 'Smoke Body Top', placement: 'body_top', html: '<script>/* smoke body_top */</script>' },
      { name: 'Smoke Body Bottom', placement: 'body_bottom', html: '<script>/* smoke body_bottom */</script>' },
    ]
    const setResult = parseToolResult(await client.call('set_javascripts', {
      sub_account_id: env.UNBOUNCE_SANDBOX_SUB_ACCOUNT_ID,
      page_id: pageId,
      variant: 'a',
      scripts: SCRIPTS,
    }))
    assert.equal(setResult.count, 3)
    assert.equal(setResult.ids.length, 3)
    for (const id of setResult.ids) assert.match(id, /^lp-script-\d+$/)

    // Read back and verify.
    const readBack = parseToolResult(await client.call('get_javascripts', {
      sub_account_id: env.UNBOUNCE_SANDBOX_SUB_ACCOUNT_ID,
      page_id: pageId,
      variant: 'a',
    }))
    assert.equal(readBack.scripts.length, 3, 'should read back exactly the 3 we wrote')
    const byPlacement = Object.fromEntries(readBack.scripts.map(s => [s.placement, s]))
    assert.equal(byPlacement.head?.name, 'Smoke Head')
    assert.equal(byPlacement.head?.html, '<script>/* smoke head */</script>')
    assert.equal(byPlacement.body_top?.name, 'Smoke Body Top')
    assert.equal(byPlacement.body_top?.html, '<script>/* smoke body_top */</script>')
    assert.equal(byPlacement.body_bottom?.name, 'Smoke Body Bottom')
    assert.equal(byPlacement.body_bottom?.html, '<script>/* smoke body_bottom */</script>')

    // Clear with empty array.
    const cleared = parseToolResult(await client.call('set_javascripts', {
      sub_account_id: env.UNBOUNCE_SANDBOX_SUB_ACCOUNT_ID,
      page_id: pageId,
      variant: 'a',
      scripts: [],
    }))
    assert.equal(cleared.count, 0)
    const afterClear = parseToolResult(await client.call('get_javascripts', {
      sub_account_id: env.UNBOUNCE_SANDBOX_SUB_ACCOUNT_ID,
      page_id: pageId,
      variant: 'a',
    }))
    assert.deepEqual(afterClear.scripts, [], 'after clearing, no scripts should remain')
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
