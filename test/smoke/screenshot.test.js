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

function extractImage(result) {
  return result.content?.find(c => c.type === 'image')
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
    const previewImg = extractImage(previewShot)
    assert.ok(previewImg, 'preview screenshot should return an image part')
    assert.ok(previewImg.data.length > 1000, 'preview screenshot should be more than 1KB')

    const publishedShot = await client.call('screenshot_variant', {
      sub_account_id: env.UNBOUNCE_SANDBOX_SUB_ACCOUNT_ID,
      page_id: pageId,
      variant: 'a',
      source: 'published',
    })
    const publishedImg = extractImage(publishedShot)
    assert.ok(publishedImg, 'published screenshot should return an image part')
    assert.ok(publishedImg.data.length > 1000, 'published screenshot should be more than 1KB')
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
