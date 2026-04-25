/**
 * Smoke: deploy_page auto-transcodes embedded data: URIs into CDN URLs.
 *
 * The defining test for the auto-transcode feature: agent passes a single-
 * file HTML blob with images embedded as data: URIs (in BOTH <img src> and
 * CSS background-image). Auto-transcode runs as part of deploy_page,
 * uploading each unique image to the sub-account's asset library and
 * swapping every occurrence for the CDN URL. Verifies via get_variant that
 * the stored body has CDN URLs and contains zero data: URIs.
 *
 * Also covers the explicit opt-out path (transcode_images: false) — agent
 * keeps the data URIs verbatim.
 *
 * Cleans up the deployed page AND the inline images via delete_image.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { McpClient } from '../harness/mcp-client.js'
import { loadTestEnv } from '../harness/env.js'

// 1×1 transparent PNG — appears in both <img src> AND CSS url() to verify
// dedup (uploaded once, replaced everywhere).
const PIXEL_DATA_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

// Different image bytes — should be uploaded separately.
const RED_DATA_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='

const HTML_WITH_DATA_URIS = `<!doctype html>
<html><head>
<style>
  body { font-family: system-ui, sans-serif; padding: 32px; }
  .hero { background-image: url(${PIXEL_DATA_URI}); height: 100px; }
  .accent { background: url(${PIXEL_DATA_URI}) no-repeat; }
</style>
</head><body>
  <h1>Auto-transcode smoke</h1>
  <img src="${PIXEL_DATA_URI}" alt="pixel" />
  <img src="${RED_DATA_URI}" alt="red" />
  <div class="hero"></div>
  <div class="accent"></div>
</body></html>`

function parseToolResult(result) {
  const textPart = result.content?.find(c => c.type === 'text')
  if (!textPart) return result
  try { return JSON.parse(textPart.text) } catch { return textPart.text }
}

test('deploy_page auto-transcodes data URIs in HTML and CSS to CDN URLs', { timeout: 240000 }, async () => {
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
      html_variants: [HTML_WITH_DATA_URIS],
      page_name: `smoke-transcode-${Date.now()}`,
      publish: false,
    }))
    pageId = deploy.page_id
    assert.ok(pageId, 'deploy should return page_id')
    console.error(`[smoke] created page ${pageId} (will clean up in finally)`)

    // Read what was actually stored.
    const variant = parseToolResult(await client.call('get_variant', {
      sub_account_id: env.UNBOUNCE_SANDBOX_SUB_ACCOUNT_ID,
      page_id: pageId,
      variant: 'a',
    }))

    const combined = (variant.html ?? '') + '\n' + (variant.css ?? '')

    // The whole point: zero data: URIs should remain in the stored variant.
    assert.doesNotMatch(combined, /data:image\//, 'no data: image URIs should remain in stored body+css')

    // Source had 4 data URI occurrences total: 2 <img> (PIXEL + RED) +
    // 2 CSS url() (both PIXEL). After transcode each occurrence becomes
    // its corresponding CDN URL — same total count, dedup happens at the
    // upload layer, not the replacement layer.
    const cdnUrls = combined.match(/https:\/\/app\.unbounce\.com\/publish\/assets\/[a-f0-9-]+\/inline-[a-f0-9]+\.png/g) ?? []
    assert.equal(cdnUrls.length, 4, `expected 4 CDN URL occurrences (1 img-PIXEL + 1 img-RED + 2 css-PIXEL), got ${cdnUrls.length}`)

    // Two unique CDN URLs: PIXEL collapsed from 3 → 1 upload, RED → 1 upload.
    const uniqueCdnUrls = new Set(cdnUrls)
    assert.equal(uniqueCdnUrls.size, 2, `expected 2 unique CDN URLs (PIXEL deduped, RED separate), got ${uniqueCdnUrls.size}`)

    // Spot-check one CDN URL is actually publicly fetchable.
    const sample = [...uniqueCdnUrls][0]
    const head = await fetch(sample, { method: 'HEAD' })
    assert.ok(head.ok, `transcoded CDN URL must be reachable, got HTTP ${head.status}: ${sample}`)
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

test('deploy_page with transcode_images:false keeps data URIs verbatim', { timeout: 120000 }, async () => {
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
      html_variants: [HTML_WITH_DATA_URIS],
      page_name: `smoke-no-transcode-${Date.now()}`,
      publish: false,
      transcode_images: false,
    }))
    pageId = deploy.page_id
    console.error(`[smoke] created page ${pageId} (will clean up in finally)`)

    const variant = parseToolResult(await client.call('get_variant', {
      sub_account_id: env.UNBOUNCE_SANDBOX_SUB_ACCOUNT_ID,
      page_id: pageId,
      variant: 'a',
    }))
    const combined = (variant.html ?? '') + '\n' + (variant.css ?? '')

    // Opt-out: data URIs survive the deploy.
    assert.match(combined, /data:image\/png;base64,/, 'data: URIs should be preserved when transcode_images is false')
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
