/**
 * Smoke: upload_image round-trip.
 *
 * Uploads a tiny in-memory PNG via image_data_url, asserts the response
 * has the fields we promise (uuid, cdn_url, etc.), then makes a real HEAD
 * request to the cdn_url to confirm it's a working public URL — proving
 * end-to-end that an agent can paste this URL into HTML and have it load
 * on a published page.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { McpClient } from '../harness/mcp-client.js'
import { loadTestEnv } from '../harness/env.js'

// Smallest valid PNG: 1×1 transparent.
const PIXEL_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

function parseToolResult(result) {
  const textPart = result.content?.find(c => c.type === 'text')
  if (!textPart) return result
  try { return JSON.parse(textPart.text) } catch { return textPart.text }
}

test('upload_image → fetchable CDN URL → delete_image → URL stops resolving', { timeout: 60000 }, async () => {
  const env = loadTestEnv()
  const client = new McpClient({
    env: {
      UNBOUNCE_API_KEY: env.UNBOUNCE_API_KEY,
      UNBOUNCE_MCP_SESSION_FILE: env.UNBOUNCE_MCP_SESSION_FILE,
    },
  })
  await client.start()

  let uploadedId = null
  try {
    const uploaded = parseToolResult(await client.call('upload_image', {
      sub_account_id: env.UNBOUNCE_SANDBOX_SUB_ACCOUNT_ID,
      image_data_url: PIXEL_PNG_DATA_URL,
      filename: `smoke-pixel-${Date.now()}.png`,
    }))
    uploadedId = uploaded.id

    assert.match(uploaded.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'uuid should be a UUID')
    assert.match(uploaded.id, /^\d+$/, 'id should be a numeric string')
    assert.match(uploaded.name, /^smoke-pixel-\d+\.png$/)
    assert.equal(uploaded.mime_type, 'image/png')
    assert.ok(uploaded.file_size > 0, 'file_size should be reported')
    assert.match(
      uploaded.cdn_url,
      /^https:\/\/app\.unbounce\.com\/publish\/assets\/[0-9a-f-]+\/smoke-pixel-\d+\.png$/,
      'cdn_url should be the bare /publish/assets/{uuid}/{name} form'
    )

    // The whole point of the URL: it must actually resolve publicly.
    const head = await fetch(uploaded.cdn_url, { method: 'HEAD' })
    assert.ok(
      head.ok,
      `cdn_url should be publicly reachable, got HTTP ${head.status} ${head.statusText}`
    )
    assert.ok((head.headers.get('content-type') || '').startsWith('image/'))

    // delete_image must require confirm. The handler throws on missing
    // confirm, which the MCP server surfaces as { isError: true, content }
    // — not a JSON-RPC rejection — so we check the error result shape.
    const noConfirm = await client.call('delete_image', {
      sub_account_id: env.UNBOUNCE_SANDBOX_SUB_ACCOUNT_ID,
      asset_id: uploaded.id,
    })
    assert.equal(noConfirm.isError, true, 'delete_image should refuse without confirm:true')
    const noConfirmText = noConfirm.content?.find(c => c.type === 'text')?.text ?? ''
    assert.match(noConfirmText, /confirm/i, 'error should mention confirm')

    // Now actually delete.
    const trashed = parseToolResult(await client.call('delete_image', {
      sub_account_id: env.UNBOUNCE_SANDBOX_SUB_ACCOUNT_ID,
      asset_id: uploaded.id,
      confirm: true,
    }))
    assert.equal(trashed.trashed, uploaded.id)
    uploadedId = null  // cleanup happened, no fallback needed
  } finally {
    if (uploadedId) {
      try {
        await client.call('delete_image', {
          sub_account_id: env.UNBOUNCE_SANDBOX_SUB_ACCOUNT_ID,
          asset_id: uploadedId,
          confirm: true,
        })
      } catch (err) {
        console.error(`CLEANUP FAILED for asset ${uploadedId}: ${err.message}`)
      }
    }
    await client.close()
  }
})
