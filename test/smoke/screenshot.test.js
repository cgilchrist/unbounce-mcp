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

// Two independent constraints the response MUST satisfy:
//   1. MCP response: 1 MB cap → ~750 KB binary after base64 + framing.
//   2. Per-image dimensions: Anthropic vision caps each image at 8000 px
//      on any side. We use 7500 in the server for headroom; the test
//      allows up to 8000 as the hard ceiling clients actually enforce.
const TOTAL_RESPONSE_BUDGET = 750 * 1024
const MAX_IMAGE_DIMENSION = 8000

function assertResponseFitsLimit(result, label) {
  const images = extractImages(result)
  assert.ok(images.length > 0, `${label} returned no image parts`)

  const totalBin = images.reduce((s, img) => s + Math.floor(img.data.length * 3 / 4), 0)
  assert.ok(
    totalBin < TOTAL_RESPONSE_BUDGET,
    `${label} total response ${totalBin} bytes exceeds ${TOTAL_RESPONSE_BUDGET} budget across ${images.length} image part(s)`
  )

  for (let i = 0; i < images.length; i++) {
    const { width, height } = readJpegDimensions(images[i].data)
    assert.ok(
      width <= MAX_IMAGE_DIMENSION && height <= MAX_IMAGE_DIMENSION,
      `${label} image ${i + 1}/${images.length} is ${width}×${height}, exceeds ${MAX_IMAGE_DIMENSION}px cap`
    )
  }
}

// Decode JPEG SOF marker to get dimensions without pulling in an image lib.
// JPEG files: FF D8 [segments] ... SOFn (FF C0-C3, C5-C7, C9-CB, CD-CF) where
// height and width appear at byte offsets 5 and 7 within the segment payload.
function readJpegDimensions(base64) {
  const buf = Buffer.from(base64, 'base64')
  let i = 2 // skip SOI
  while (i < buf.length) {
    if (buf[i] !== 0xFF) throw new Error('invalid JPEG marker')
    while (buf[i] === 0xFF) i++
    const marker = buf[i++]
    // SOFn markers that actually carry dimensions
    const isSof = (marker >= 0xC0 && marker <= 0xC3) ||
                  (marker >= 0xC5 && marker <= 0xC7) ||
                  (marker >= 0xC9 && marker <= 0xCB) ||
                  (marker >= 0xCD && marker <= 0xCF)
    const segLen = (buf[i] << 8) | buf[i + 1]
    if (isSof) {
      const height = (buf[i + 3] << 8) | buf[i + 4]
      const width = (buf[i + 5] << 8) | buf[i + 6]
      return { width, height }
    }
    i += segLen
  }
  throw new Error('no SOF marker found in JPEG')
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
    assertResponseFitsLimit(previewShot, 'preview')

    const publishedShot = await client.call('screenshot_variant', {
      sub_account_id: env.UNBOUNCE_SANDBOX_SUB_ACCOUNT_ID,
      page_id: pageId,
      variant: 'a',
      source: 'published',
    })
    assertResponseFitsLimit(publishedShot, 'published')
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
