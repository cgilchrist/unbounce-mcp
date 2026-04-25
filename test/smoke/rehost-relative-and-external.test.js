/**
 * Smoke: deploy_page rehosts relative-path images (resolved against the HTML
 * file's directory) AND external http URLs (when explicitly opted in via
 * rehost_external_images:true).
 *
 * The two paths cover the user-input shapes our auto-transcode previously
 * missed:
 *   1. <img src="logo.png">              — sibling file
 *   2. <img src="images/hero.png">       — relative subdir
 *   3. <img src="https://example/x.png"> — external URL (opt-in)
 *
 * Plus we verify that Unbounce-hosted URLs (image-service.unbounce.com,
 * app.unbounce.com/publish/assets/...) are NEVER re-rehosted, even when
 * rehost_external_images is on.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { McpClient } from '../harness/mcp-client.js'
import { loadTestEnv } from '../harness/env.js'

// 1×1 transparent PNG — same bytes used for sibling + subdir image so we
// can verify dedup also works across relative paths.
const PIXEL_PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
)

function parseToolResult(result) {
  const textPart = result.content?.find(c => c.type === 'text')
  if (!textPart) return result
  try { return JSON.parse(textPart.text) } catch { return textPart.text }
}

test('deploy_page resolves relative paths from html_file_paths and uploads them', { timeout: 240000 }, async () => {
  const env = loadTestEnv()

  // Build a temp project: page.html, sibling logo.png, images/hero.png.
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'rehost-smoke-'))
  await fs.promises.mkdir(path.join(tmp, 'images'))
  await fs.promises.writeFile(path.join(tmp, 'logo.png'), PIXEL_PNG_BYTES)
  await fs.promises.writeFile(path.join(tmp, 'images', 'hero.png'), PIXEL_PNG_BYTES)

  const html = `<!doctype html>
<html><head><style>
  .banner { background-image: url(logo.png); height: 80px; }
</style></head><body>
  <h1>Relative paths smoke</h1>
  <img src="logo.png" alt="Brand Logo" />
  <img src="images/hero.png" alt="Hero Photo" />
  <div class="banner"></div>
</body></html>`

  const htmlPath = path.join(tmp, 'page.html')
  await fs.promises.writeFile(htmlPath, html)

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
      html_file_paths: [htmlPath],
      page_name: `smoke-relative-${Date.now()}`,
      publish: false,
    }))
    pageId = deploy.page_id
    assert.ok(pageId)
    console.error(`[smoke] created page ${pageId} (will clean up in finally)`)

    const variant = parseToolResult(await client.call('get_variant', {
      sub_account_id: env.UNBOUNCE_SANDBOX_SUB_ACCOUNT_ID,
      page_id: pageId,
      variant: 'a',
    }))
    const combined = (variant.html ?? '') + '\n' + (variant.css ?? '')

    // No raw filename refs should remain — they should have been resolved.
    assert.doesNotMatch(combined, /\bsrc="logo\.png"/, 'sibling logo.png should be replaced')
    assert.doesNotMatch(combined, /\bsrc="images\/hero\.png"/, 'images/hero.png should be replaced')
    assert.doesNotMatch(combined, /url\(logo\.png\)/, 'css logo.png should be replaced')

    // CDN URLs should appear with context-derived filenames.
    const cdnUrls = combined.match(/https:\/\/app\.unbounce\.com\/publish\/assets\/[a-f0-9-]+\/[a-z0-9-]+-[a-f0-9]{8}\.png/g) ?? []
    assert.ok(cdnUrls.length >= 3, `expected ≥3 CDN URL occurrences (img logo + img hero + css logo), got ${cdnUrls.length}`)

    // Same bytes (PIXEL) used 3 times → 1 unique upload + same CDN URL.
    const unique = new Set(cdnUrls)
    assert.equal(unique.size, 1, `expected 1 unique CDN URL (all bytes identical), got ${unique.size}`)

    // Filename slug should come from context: alt="Brand Logo" / "Hero Photo"
    // or .banner-bg. Best (longest) wins → "brand-logo" or "hero-photo" most likely.
    const sample = [...unique][0]
    assert.match(sample, /\/(brand-logo|hero-photo|banner-bg)-[a-f0-9]{8}\.png$/,
      `filename should be context-derived; got ${sample}`)

    // Public URL should resolve.
    const head = await fetch(sample, { method: 'HEAD' })
    assert.ok(head.ok, `CDN URL must resolve, got HTTP ${head.status}`)
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
    await fs.promises.rm(tmp, { recursive: true, force: true })
  }
})

test('deploy_page leaves external URLs alone by default; rehosts them when opted in', { timeout: 240000 }, async () => {
  const env = loadTestEnv()
  // A small known-good public JPEG. Picsum's "/W/H.jpg" form returns a 302
  // to fastly + image bytes; fetch follows redirects by default. If picsum
  // is unreachable, the test reports the network failure clearly.
  const EXTERNAL_URL = 'https://picsum.photos/seed/unbounce-mcp-rehost-smoke/100/100.jpg'

  const html = `<!doctype html>
<html><body>
  <img src="${EXTERNAL_URL}" alt="Random Sample" />
  <img src="https://app.unbounce.com/publish/assets/some-uuid/already-hosted.png" alt="Already Hosted" />
</body></html>`

  const client = new McpClient({
    env: {
      UNBOUNCE_API_KEY: env.UNBOUNCE_API_KEY,
      UNBOUNCE_MCP_SESSION_FILE: env.UNBOUNCE_MCP_SESSION_FILE,
    },
  })
  await client.start()

  // ── Path A: default behavior — external URLs pass through verbatim. ────────
  let passthroughPageId = null
  try {
    const deploy = parseToolResult(await client.call('deploy_page', {
      sub_account_id: env.UNBOUNCE_SANDBOX_SUB_ACCOUNT_ID,
      html_variants: [html],
      page_name: `smoke-external-default-${Date.now()}`,
      publish: false,
    }))
    passthroughPageId = deploy.page_id

    const variant = parseToolResult(await client.call('get_variant', {
      sub_account_id: env.UNBOUNCE_SANDBOX_SUB_ACCOUNT_ID,
      page_id: passthroughPageId,
      variant: 'a',
    }))
    assert.match(variant.html ?? '', new RegExp(EXTERNAL_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      'external URL should pass through unchanged when rehost_external_images is omitted')
  } finally {
    if (passthroughPageId) {
      try {
        await client.call('delete_page', {
          sub_account_id: env.UNBOUNCE_SANDBOX_SUB_ACCOUNT_ID,
          page_id: passthroughPageId,
          confirm: true,
        })
      } catch {}
    }
  }

  // ── Path B: rehost_external_images:true → external URL gets uploaded,
  //   Unbounce-hosted URL is left alone. ─────────────────────────────────────
  let rehostedPageId = null
  try {
    const deploy = parseToolResult(await client.call('deploy_page', {
      sub_account_id: env.UNBOUNCE_SANDBOX_SUB_ACCOUNT_ID,
      html_variants: [html],
      page_name: `smoke-external-rehost-${Date.now()}`,
      publish: false,
      rehost_external_images: true,
    }))
    rehostedPageId = deploy.page_id

    const variant = parseToolResult(await client.call('get_variant', {
      sub_account_id: env.UNBOUNCE_SANDBOX_SUB_ACCOUNT_ID,
      page_id: rehostedPageId,
      variant: 'a',
    }))
    const body = variant.html ?? ''

    // External URL was rehosted away.
    assert.doesNotMatch(body, /picsum\.photos/, 'external URL should have been rehosted into Unbounce')

    // Unbounce-hosted URL was NOT touched (we never re-rehost our own assets).
    assert.match(body, /app\.unbounce\.com\/publish\/assets\/some-uuid\/already-hosted\.png/,
      'pre-existing Unbounce-hosted URL should be left in place')

    // The rehosted URL should be on Unbounce + carry a context-derived filename.
    // Extension comes from the upstream's Content-Type (image/jpeg for picsum).
    assert.match(
      body,
      /https:\/\/app\.unbounce\.com\/publish\/assets\/[a-f0-9-]+\/random-sample-[a-f0-9]{8}\.jpg/,
      'rehosted URL should use the alt-derived filename "random-sample-<hash>.jpg"'
    )
  } finally {
    if (rehostedPageId) {
      try {
        await client.call('delete_page', {
          sub_account_id: env.UNBOUNCE_SANDBOX_SUB_ACCOUNT_ID,
          page_id: rehostedPageId,
          confirm: true,
        })
      } catch {}
    }
    await client.close()
  }
})
