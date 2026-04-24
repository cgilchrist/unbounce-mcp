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

function extractImages(result) {
  return (result.content ?? []).filter(c => c.type === 'image')
}

// MCP tool result limit is 1 MB. Base64 inflates 33%, so each tile's binary
// size must stay under ~750 KB to be safe in aggregate. Enforce per tile
// because the limit applies to the whole tool response, not individual parts.
const TILE_BYTE_LIMIT = 900 * 1024

function assertTilesFitLimit(images, label) {
  assert.ok(images.length > 0, `${label} returned no image parts`)
  for (let i = 0; i < images.length; i++) {
    const binBytes = Math.floor(images[i].data.length * 3 / 4)
    assert.ok(
      binBytes < TILE_BYTE_LIMIT,
      `${label} tile ${i + 1}/${images.length} is ${binBytes} bytes — above ${TILE_BYTE_LIMIT}`
    )
  }
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
    console.error(`[smoke] created page ${pageId} (will clean up in finally)`)

    const previewShot = await client.call('screenshot_variant', {
      sub_account_id: env.UNBOUNCE_SANDBOX_SUB_ACCOUNT_ID,
      page_id: pageId,
      variant: 'a',
      source: 'preview',
    })
    assertTilesFitLimit(extractImages(previewShot), 'preview')

    const publishedShot = await client.call('screenshot_variant', {
      sub_account_id: env.UNBOUNCE_SANDBOX_SUB_ACCOUNT_ID,
      page_id: pageId,
      variant: 'a',
      source: 'published',
    })
    assertTilesFitLimit(extractImages(publishedShot), 'published')
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
