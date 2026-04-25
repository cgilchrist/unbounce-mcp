/**
 * Playwright session management and all UI automation for Unbounce actions
 * that have no public API equivalent.
 *
 * Auth strategy:
 * - First run: open headed browser, user logs in manually → cookies saved
 * - Subsequent runs: load saved cookies, run headlessly
 * - If 401/session expired: invalidate and re-prompt login
 */

import * as fs from 'fs'
import * as path from 'path'
import { chromium } from 'playwright'
import { SESSION_DIR, SESSION_FILE, UNBOUNCE_APP_BASE } from './config.js'
import { getPage } from './api.js'
import {
  JPEG_TIERS,
  MAX_OUTPUT_DIMENSION,
  pickTier,
  tierFitsDimensions,
  computeTiles,
} from './screenshot-quality.js'
import {
  clearJwtCache,
  directPublish, directUnpublish, directDelete,
  directSetVariantWeights, directSetTrafficMode, directSetPageUrl,
  directGetVariant, directEditVariant, directGetVariantNumericIds,
  directRenameVariant, directCreateVariantFromScratch,
  directGetJavascripts, directSetJavascripts,
  directFetchDuplicationOptions, directDuplicatePage,
  directSearchPages, directGetPageInsights, directGetPageStats,
  directGetBulkPageStats, directGetPageVariants, directGetVariantPreviewUrl,
  directActivateVariant, directDeactivateVariant, directPromoteVariant, directDeleteVariant,
  directDuplicateVariant,
} from './direct.js'

let _browser = null
let _session = null // { cookies: [{name, value, domain, ...}], csrfToken: string }

// ── Session persistence ────────────────────────────────────────────────────────

const AUTH_COOKIE_NAMES = new Set(['_lp-webapp_session', '_lp-webapp_remember_token'])

function filterAuthCookies(cookies) {
  return (cookies ?? []).filter(c => AUTH_COOKIE_NAMES.has(c.name))
}

async function loadSession() {
  try {
    const raw = await fs.promises.readFile(SESSION_FILE, 'utf8')
    _session = JSON.parse(raw)
    // Strip down to auth cookies only — handles legacy sessions with full cookie dumps
    if (_session.cookies) _session.cookies = filterAuthCookies(_session.cookies)
    return true
  } catch {
    return false
  }
}

async function saveSession(session) {
  await fs.promises.mkdir(SESSION_DIR, { recursive: true })
  await fs.promises.writeFile(SESSION_FILE, JSON.stringify(session, null, 2))
  _session = session
}

export function clearSession() {
  _session = null
  clearJwtCache()
  return fs.promises.rm(SESSION_FILE, { force: true }).catch(() => {})
}

// ── Cookie helpers ─────────────────────────────────────────────────────────────

/** Convert Playwright cookies to "name=value" strings for fetch headers */
export function cookiesToHeader(cookies) {
  return cookies.map(c => `${c.name}=${c.value}`)
}

/** Grab the CSRF token from a Playwright page */
async function grabCsrfToken(page) {
  return page.evaluate(() => {
    const meta = document.querySelector('meta[name="csrf-token"]')
    if (meta) return meta.getAttribute('content')
    // Fallback: look in page HTML for authenticity_token hidden input
    const input = document.querySelector('input[name="authenticity_token"]')
    return input ? input.value : null
  })
}

// ── Browser lifecycle ──────────────────────────────────────────────────────────

async function getBrowser() {
  if (!_browser || !_browser.isConnected()) {
    _browser = await chromium.launch({ headless: true })
  }
  return _browser
}

/** Create a new page with session cookies loaded */
async function newAuthPage(browser, contextOptions = {}) {
  const context = await browser.newContext(contextOptions)
  if (_session?.cookies) {
    await context.addCookies(_session.cookies)
  }
  return context.newPage()
}

// ── First-run headed login ─────────────────────────────────────────────────────

/**
 * Open a visible browser for the user to log in manually.
 * Watches for successful login, then saves cookies + CSRF token.
 */
export async function doHeadedLogin() {
  console.error('[unbounce-mcp] No session found. Opening browser for login...')
  const browser = await chromium.launch({ headless: false })
  const context = await browser.newContext()
  const page = await context.newPage()

  await page.goto(`${UNBOUNCE_APP_BASE}`)

  // Auto-tick "Keep me signed in" so Unbounce issues the long-lived
  // _lp-webapp_remember_token cookie. Without it, only the short-lived
  // session cookie is set and the user has to re-login every few hours.
  // If the checkbox isn't present (SSO redirect, already-authed, etc.),
  // carry on silently.
  await page.waitForSelector('#remember-checkbox', { timeout: 5000 })
    .then(() => page.check('#remember-checkbox'))
    .catch(() => {})

  console.error('[unbounce-mcp] Please log in to Unbounce in the browser window.')
  await page.waitForURL(url => url.href.includes('/pages') || url.href.includes('/dashboard'), { timeout: 300000 })

  const cookies = filterAuthCookies(await context.cookies())
  const csrfToken = await grabCsrfToken(page)

  await browser.close()
  _browser = null

  await saveSession({ cookies, csrfToken })
  console.error('[unbounce-mcp] Session saved. Future requests will run headlessly.')
}

// ── Session initialization ─────────────────────────────────────────────────────

/**
 * Ensure we have a valid session. If not, trigger headed login.
 * Call this at the start of any browser action.
 */
export async function ensureSession() {
  if (_session) return
  const loaded = await loadSession()
  if (!loaded) {
    throw new Error('No Unbounce session found. Call the reauthenticate tool to log in.')
  }
}

/**
 * Run a page action with a fresh authenticated page.
 * On session expiry, throws a clear error instead of opening a headed browser
 * mid-tool-call (which races against MCP timeouts and causes login loops).
 * Use the reauthenticate tool to log in explicitly when needed.
 */
async function withPage(fn, contextOptions = {}) {
  await ensureSession()
  const browser = await getBrowser()
  const page = await newAuthPage(browser, contextOptions)

  if (process.env.UNBOUNCE_DEBUG_NETWORK) {
    const logFile = process.env.UNBOUNCE_DEBUG_NETWORK
    const log = (line) => fs.appendFileSync(logFile, line + '\n')
    log(`[withPage] started at ${new Date().toISOString()}`)
    page.on('request', req => {
      if (req.method() !== 'GET') {
        log(`[${new Date().toISOString()}] ${req.method()} ${req.url()}`)
        const body = req.postData()
        if (body) log(`  body: ${body}`)
      }
    })
    page.on('response', res => {
      if (res.request().method() !== 'GET') {
        res.text().then(text => log(`  → ${res.status()} ${text.slice(0, 500)}`)).catch(() => {})
      }
    })
  }

  try {
    return await fn(page)
  } catch (err) {
    // Only treat as "session expired" when the JWT-fetch endpoint itself
    // returned 401 — that's the one case where the session cookies are truly
    // invalid and a re-login is required. Everything else (stale JWT, gateway
    // UNAUTHENTICATED on the first try) is handled by auto-refresh inside gql().
    if (/JWT fetch HTTP 401/.test(err.message ?? '')) {
      throw new Error('Unbounce session expired. Call the reauthenticate tool to log in again, then retry.')
    }
    throw err
  } finally {
    await page.context().close().catch(() => {})
  }
}

// ── Upload via UI ──────────────────────────────────────────────────────────────

/**
 * Navigate to the sub-account pages dashboard and grab a fresh CSRF token + cookies.
 * Used by upload.js before calling the presigned endpoint.
 */
export async function getUploadCredentials(subAccountId) {
  return withPage(async (page) => {
    await page.goto(`${UNBOUNCE_APP_BASE}/${subAccountId}/pages`)
    await page.waitForLoadState('load')

    const csrfToken = await grabCsrfToken(page)
    if (!csrfToken) throw new Error('Could not find CSRF token on Unbounce pages dashboard')

    const cookies = await page.context().cookies()
    return {
      cookies: cookiesToHeader(cookies),
      csrfToken,
    }
  })
}

// ── Set page URL (domain + slug) ───────────────────────────────────────────────

export async function setPageUrl(subAccountId, pageId, domain, slug) {
  return withPage(async (page) => {
    await directSetPageUrl(page, pageId, domain, slug)
  })
}

// ── Traffic mode ───────────────────────────────────────────────────────────────

/**
 * @param {string} mode - 'smart_traffic' | 'ab_test'
 */
export async function setTrafficMode(subAccountId, pageId, mode, variantId = null) {
  return withPage(async (page) => {
    await directSetTrafficMode(page, pageId, mode, variantId)
  })
}

// ── Variant weights ────────────────────────────────────────────────────────────

/**
 * @param {string} subAccountId
 * @param {string} pageId
 * @param {Record<string, number>} weights - e.g. { a: 50, b: 50 } — must sum to 100
 */
export async function setVariantWeights(subAccountId, pageId, weights) {
  const values = Object.values(weights)
  const sum = values.reduce((a, b) => a + b, 0)
  if (sum !== 100) throw new Error(`Variant weights must sum to 100 (got ${sum})`)
  if (values.some(v => !Number.isInteger(v) || v < 0)) throw new Error('Variant weights must be non-negative integers')

  return withPage(async (page) => {
    return directSetVariantWeights(page, pageId, weights)
  })
}

// ── Variant lifecycle ─────────────────────────────────────────────────────────

export async function activateVariant(subAccountId, pageId, variantLetter) {
  return withPage(async (page) => {
    await directActivateVariant(page, pageId, variantLetter)
  })
}

export async function deactivateVariant(subAccountId, pageId, variantLetter) {
  return withPage(async (page) => {
    await directDeactivateVariant(page, pageId, variantLetter)
  })
}

export async function promoteVariant(subAccountId, pageId, variantLetter) {
  return withPage(async (page) => {
    await directPromoteVariant(page, pageId, variantLetter)
  })
}

export async function deleteVariant(subAccountId, pageId, variantLetter) {
  return withPage(async (page) => {
    await directDeleteVariant(page, pageId, variantLetter)
  })
}

// ── Publish ────────────────────────────────────────────────────────────────────

export async function publishPage(subAccountId, pageId) {
  return withPage(async (page) => {
    // directPublish needs a CSRF token from a loaded Unbounce page.
    await page.goto(`${UNBOUNCE_APP_BASE}/${subAccountId}/pages/${pageId}/overview`)
    await page.waitForLoadState('load')
    await directPublish(page, subAccountId, pageId)
  })
}

// ── Unpublish ──────────────────────────────────────────────────────────────────

export async function unpublishPage(subAccountId, pageId) {
  return withPage(async (page) => {
    // directUnpublish needs a CSRF token from a loaded Unbounce page.
    await page.goto(`${UNBOUNCE_APP_BASE}/${subAccountId}/pages/${pageId}/overview`)
    await page.waitForLoadState('load')
    await directUnpublish(page, subAccountId, pageId)
  })
}

// ── Delete ─────────────────────────────────────────────────────────────────────

export async function deletePage(subAccountId, pageId) {
  return withPage(async (page) => {
    await directDelete(page, pageId)
  })
}

// ── Find pages by stats ───────────────────────────────────────────────────────

export async function findPagesByStats(subAccountId, pages, filters) {
  return withPage(async (page) => {
    const stats = await directGetBulkPageStats(page, pages.map(p => p.id))

    const statsById = {}
    for (const s of stats) statsById[s.page_id] = s

    return pages
      .map(p => ({ ...p, ...statsById[p.id] }))
      .filter(p => {
        const s = statsById[p.id]
        if (!s) return false
        if (filters.min_visitors !== undefined && s.visitors < filters.min_visitors) return false
        if (filters.max_visitors !== undefined && s.visitors > filters.max_visitors) return false
        if (filters.min_conversions !== undefined && s.conversions < filters.min_conversions) return false
        if (filters.max_conversions !== undefined && s.conversions > filters.max_conversions) return false
        if (filters.min_conversion_rate !== undefined && s.conversion_rate < filters.min_conversion_rate) return false
        if (filters.max_conversion_rate !== undefined && s.conversion_rate > filters.max_conversion_rate) return false
        return true
      })
  })
}

// ── Page stats ────────────────────────────────────────────────────────────────

export async function getPageStats(subAccountId, pageId, { startDate, endDate } = {}) {
  return withPage(async (page) => {
    return directGetPageStats(page, pageId, { startDate, endDate })
  })
}

// ── Page insights ─────────────────────────────────────────────────────────────

export async function getPageInsights(subAccountId, pageId) {
  return withPage(async (page) => {
    return directGetPageInsights(page, pageId)
  })
}

// ── Search pages ──────────────────────────────────────────────────────────────

export async function findPages(query) {
  return withPage(async (page) => {
    return directSearchPages(page, query)
  })
}

// ── Page variants ─────────────────────────────────────────────────────────────

export async function getPageVariants(subAccountId, pageId) {
  return withPage(async (page) => {
    return directGetPageVariants(page, pageId)
  })
}

export async function getVariantPreviewUrl(subAccountId, pageId, variantLetter) {
  return withPage(async (page) => {
    const { variants } = await directGetPageVariants(page, pageId)
    const variant = variants.find(v => v.variant === variantLetter.toLowerCase())
    if (!variant) throw new Error(`Variant "${variantLetter}" not found on page ${pageId}`)
    if (!variant.preview_path) throw new Error(`No preview path available for variant ${variantLetter}`)
    return directGetVariantPreviewUrl(page, variant.preview_path)
  })
}

// deviceScaleFactor is set to 2 on the Playwright context; Playwright's
// screenshot `scale` option lets us choose 'device' (2x output) or 'css'
// (1x output) per call, picked dynamically by pickTier() below.
const CONTEXT_DSR = 2

// Total binary byte budget across BOTH desktop and mobile images in a
// single tool response. The MCP 1 MB cap applies to the JSON-encoded
// response, which base64-inflates binary data by 33%. Target ~700 KB
// binary ≈ ~950 KB serialized — enough headroom for JSON framing and
// captions to keep the real response under 1 MB.
const TOTAL_BUDGET = 700 * 1024

// Mobile is captured only if desktop leaves at least this much budget.
// If the predicted-or-actual mobile image exceeds remaining budget,
// it is dropped rather than returned over-budget.
const MOBILE_MIN_BUDGET = 150 * 1024

/**
 * Capture at the highest JPEG tier whose estimated output fits both the
 * byte budget and the per-image dimension cap. Falls back a tier if the
 * actual buffer exceeds budget, and skips tiers whose output would exceed
 * MAX_OUTPUT_DIMENSION (e.g. 2x on a 4000-px-tall page → 8000 output).
 */
async function captureWithBudget(page, cssWidth, cssHeight, budget) {
  const predicted = pickTier(cssWidth, cssHeight, budget)
  if (!predicted) {
    throw new Error(
      `Page ${cssWidth}×${cssHeight} exceeds ${MAX_OUTPUT_DIMENSION}px output cap even at 1x. Caller must tile before invoking captureWithBudget.`
    )
  }
  const startIdx = JPEG_TIERS.indexOf(predicted)
  for (let i = startIdx; i < JPEG_TIERS.length; i++) {
    const tier = JPEG_TIERS[i]
    if (!tierFitsDimensions(cssWidth, cssHeight, tier)) continue
    const buf = await page.screenshot({
      type: 'jpeg',
      quality: tier.quality,
      scale: tier.dsr === 2 ? 'device' : 'css',
    })
    const isLastDimFit = JPEG_TIERS.slice(i + 1).every(t => !tierFitsDimensions(cssWidth, cssHeight, t))
    if (buf.length <= budget || isLastDimFit) {
      return { buffer: buf, tier }
    }
  }
}

function imagePart({ buffer, tier }, labelBase, width, tileLabel = '') {
  const kb = Math.round(buffer.length / 1024)
  const prefix = tileLabel ? ` ${tileLabel}` : ''
  return {
    data: buffer.toString('base64'),
    mimeType: 'image/jpeg',
    caption: `${labelBase}${prefix} (${width}px wide, ${tier.dsr}x, q=${tier.quality}, ${kb} KB)`,
  }
}

/**
 * Capture one viewport as one or more tiles so every resulting image fits
 * under MAX_OUTPUT_DIMENSION on each side, and the total binary footprint
 * fits `budget` bytes. Short pages produce a single image; tall ones are
 * split into vertical slices at 1x.
 *
 * `scrollSetup(tile)` is invoked before each capture to position content
 * (e.g. iframe scroll, outer-page scroll) at that tile's y offset.
 *
 * Returns an array of { buffer, tier, tile } objects.
 */
async function captureViewportTiled(page, cssWidth, cssHeight, budget, scrollSetup) {
  const tiles = computeTiles(cssHeight)
  const perTileBudget = Math.floor(budget / tiles.length)
  const results = []
  for (const tile of tiles) {
    await scrollSetup(tile)
    await page.setViewportSize({ width: cssWidth, height: tile.height })
    await page.waitForTimeout(200)
    const shot = await captureWithBudget(page, cssWidth, tile.height, perTileBudget)
    results.push({ ...shot, tile })
  }
  return results
}

function tileImageParts(captures, labelBase, width) {
  const total = captures.length
  return captures.map((c, i) => {
    const tileLabel = total === 1 ? '' : `tile ${i + 1}/${total} (y ${c.tile.y}–${c.tile.y + c.tile.height})`
    return imagePart(c, labelBase, width, tileLabel)
  })
}

function totalBytes(captures) {
  return captures.reduce((s, c) => s + c.buffer.length, 0)
}


export async function screenshotVariant(subAccountId, pageId, variantLetter, { source = 'preview' } = {}) {
  const letter = variantLetter.toLowerCase()

  // ── Published mode ──────────────────────────────────────────────────────────
  // Navigate directly to the public {url}/{letter}.html endpoint. No auth or
  // iframe unwrapping needed — we scroll through the page ourselves, one tile
  // at a time, to keep each JPEG comfortably under the 1 MB MCP result limit.
  if (source === 'published') {
    const { url, name } = await getPage(pageId)
    const pageUrl = `${url.replace(/\/$/, '')}/${letter}.html`
    return withPage(async (page) => {
      await page.goto(pageUrl, { waitUntil: 'networkidle', timeout: 30000 })

      const captureAtWidth = async (width, budget) => {
        await page.setViewportSize({ width, height: 900 })
        await page.waitForTimeout(300)
        const totalHeight = await page.evaluate(() => document.documentElement.scrollHeight)
        return captureViewportTiled(page, width, totalHeight, budget, async (tile) => {
          await page.evaluate(y => window.scrollTo(0, y), tile.y)
        })
      }

      const desktopCaps = await captureAtWidth(1280, TOTAL_BUDGET)
      const labelBase = `Variant ${variantLetter.toUpperCase()} — ${name ?? ''} (published)`.trim()
      const images = [...tileImageParts(desktopCaps, `${labelBase} desktop`, 1280)]

      const remaining = TOTAL_BUDGET - totalBytes(desktopCaps)
      if (remaining >= MOBILE_MIN_BUDGET) {
        const mobileCaps = await captureAtWidth(390, remaining)
        if (totalBytes(mobileCaps) <= remaining) {
          images.push(...tileImageParts(mobileCaps, `${labelBase} mobile`, 390))
        }
      }

      return { _type: 'images', images }
    }, { deviceScaleFactor: CONTEXT_DSR })
  }

  // ── Preview mode (default) ──────────────────────────────────────────────────
  // The Unbounce preview chain wraps the real landing page inside a srcdoc iframe
  // (#page-preview-output). We stretch the iframe to its content height on the
  // outer page, then scroll the outer page between tile captures.
  return withPage(async (page) => {
    const { variants } = await directGetPageVariants(page, pageId)
    const variant = variants.find(v => v.variant === letter)
    if (!variant) throw new Error(`Variant "${variantLetter}" not found on page ${pageId}`)
    if (!variant.preview_path) throw new Error(`No preview path available for variant ${variantLetter}`)

    await page.goto(`${UNBOUNCE_APP_BASE}${variant.preview_path}`, { waitUntil: 'networkidle', timeout: 30000 })
    const iframeSrc = await page.evaluate(() => document.getElementById('page-preview')?.src)
    if (!iframeSrc) throw new Error('Preview iframe not found — page may not have loaded')

    await page.goto(iframeSrc, { waitUntil: 'networkidle', timeout: 30000 })

    const getContentHeight = async () => {
      const frame = page.frames().find(f => f.name() === 'page-preview-output')
      if (frame) {
        return await frame.evaluate(() => Math.max(
          document.documentElement.scrollHeight,
          document.getElementById('lp-pom-root')?.offsetHeight ?? 0,
          document.body?.scrollHeight ?? 0
        ))
      }
      return await page.evaluate(() => {
        let max = window.innerHeight
        document.querySelectorAll('*').forEach(el => {
          try { const b = el.getBoundingClientRect().bottom + window.pageYOffset; if (b > max) max = b } catch (_) {}
        })
        return Math.ceil(max)
      })
    }

    // Resize iframe to target width, wait for reflow, measure height, stretch
    // iframe element to that height, then capture (tiling if taller than
    // the dimension cap). Order matters: measuring before resize returns
    // the previous width's height.
    const captureAtWidth = async (width, budget) => {
      await page.setViewportSize({ width, height: 900 })
      await page.evaluate((w) => {
        const iframe = document.getElementById('page-preview-output')
        if (iframe) {
          iframe.style.setProperty('width', w + 'px', 'important')
          iframe.style.setProperty('border', 'none', 'important')
          iframe.style.setProperty('display', 'block', 'important')
        }
        document.documentElement.style.cssText = 'margin:0;padding:0;'
        document.body.style.cssText = 'margin:0;padding:0;'
      }, width)
      await page.waitForTimeout(400)
      const height = await getContentHeight()
      await page.evaluate((h) => {
        const iframe = document.getElementById('page-preview-output')
        if (iframe) iframe.style.setProperty('height', h + 'px', 'important')
      }, height)
      return captureViewportTiled(page, width, height, budget, async (tile) => {
        await page.evaluate(y => window.scrollTo(0, y), tile.y)
      })
    }

    const desktopCaps = await captureAtWidth(1280, TOTAL_BUDGET)
    const labelBase = `Variant ${variantLetter.toUpperCase()} — ${variant.name ?? ''}`.trim()
    const images = [...tileImageParts(desktopCaps, `${labelBase} desktop`, 1280)]

    const remaining = TOTAL_BUDGET - totalBytes(desktopCaps)
    if (remaining >= MOBILE_MIN_BUDGET) {
      const mobileCaps = await captureAtWidth(390, remaining)
      if (totalBytes(mobileCaps) <= remaining) {
        images.push(...tileImageParts(mobileCaps, `${labelBase} mobile`, 390))
      }
    }

    return { _type: 'images', images }
  }, { deviceScaleFactor: CONTEXT_DSR })
}

// ── Duplicate page ─────────────────────────────────────────────────────────────

export async function duplicatePage(subAccountId, pageId, { includeInactiveVariants = false, integrationIds = 'all' } = {}) {
  return withPage(async (page) => {
    const { integrations, active, inactive } = await directFetchDuplicationOptions(page, pageId)

    const variantIds = includeInactiveVariants
      ? [...active, ...inactive].map(v => v.pageVariantId)
      : active.map(v => v.pageVariantId)

    const integrationDuplicationIds = integrationIds === 'all'
      ? integrations.map(i => i.duplicationId)
      : integrationIds === 'none'
        ? []
        : integrations
            .filter(i => integrationIds.includes(i.label) || integrationIds.includes(i.duplicationId))
            .map(i => i.duplicationId)

    const result = await directDuplicatePage(page, pageId, variantIds, integrationDuplicationIds)
    return {
      page_id: result.uuid,
      name: result.name,
      url: result.url,
      state: result.state,
    }
  })
}

// ── Edit variant HTML ──────────────────────────────────────────────────────────

/**
 * Read the current HTML and CSS of a specific variant.
 * Direct path: reads edit.json via API (lp-code-1 + lp-stylesheet-1 elements).
 * Fallback: navigates to the preview iframe for Classic Builder pages.
 * @returns {{ html: string, css: string, variant: string, numericId: string }}
 */
export async function getVariantContent(subAccountId, pageId, variantLetter) {
  return withPage(async (page) => {
    let directNumericId = null
    let html = null
    let css = null

    // Direct path: GraphQL for numeric ID + fetch edit.json (no UI clicking).
    // If lp-code-1 / lp-stylesheet-1 have any content, return it directly —
    // that's the authoritative source for MCP-created variants, which store
    // body content WITHOUT a <!DOCTYPE> wrapper (prepareVariantContent
    // extracts the body innerHTML). The preview fallback below is only for
    // true Classic Builder pages whose lp-code-1 element is empty.
    try {
      const variantIds = await directGetVariantNumericIds(page, pageId)
      directNumericId = variantIds[variantLetter.toLowerCase()]
      if (!directNumericId) throw new Error(`Variant "${variantLetter}" not found. Available: ${Object.keys(variantIds).join(', ')}`)
      const result = await directGetVariant(page, directNumericId)
      html = result.html
      css = result.css
      const hasContent = html && html.trim().length > 0
      if (hasContent) return { variant: variantLetter, numericId: directNumericId, html, css }
    } catch (err) {
      console.error('[getVariantContent] Direct path failed:', err.message)
    }

    // Classic Builder page — content in edit.json is empty; fall back to rendered preview.
    // Partial custom code (tracking snippets etc.) is preserved alongside the preview HTML.
    try {
      const { variants } = await directGetPageVariants(page, pageId)
      const variantInfo = variants.find(v => v.variant === variantLetter.toLowerCase())
      if (variantInfo?.preview_path) {
        await page.goto(`${UNBOUNCE_APP_BASE}${variantInfo.preview_path}`, { waitUntil: 'networkidle', timeout: 30000 })
        const iframeSrc = await page.evaluate(() => document.getElementById('page-preview')?.src)
        if (iframeSrc) {
          await page.goto(iframeSrc, { waitUntil: 'networkidle', timeout: 30000 })
          // Swap lazy-loaded img srcs before capture (preview sets src to /assets/ path).
          await page.evaluate(() => {
            document.querySelectorAll('img[data-src-desktop-1x], img[data-src-mobile-1x]').forEach(img => {
              const cdn = img.getAttribute('data-src-desktop-1x') || img.getAttribute('data-src-mobile-1x')
              if (cdn) img.src = cdn.startsWith('//') ? 'https:' + cdn : cdn
            })
          })
          // Replace app.unbouncepreview.com with app.unbounce.com throughout — this
          // normalises all image-service URLs (src, data-src-*, srcset, CSS background-image)
          // so Unbounce's publish pipeline remaps them to CDN identically to builder pages.
          const renderedHtml = (await page.evaluate(() => document.documentElement.outerHTML))
            .replace(/app\.unbouncepreview\.com/g, 'app.unbounce.com')
          return {
            variant: variantLetter,
            numericId: directNumericId,
            html: renderedHtml,
            css: null,
            custom_code: html || null,
            custom_css: css || null,
            source: 'rendered_preview',
            note: [
              'CLASSIC BUILDER PAGE — READ-ONLY REFERENCE.',
              '',
              'This HTML is the fully rendered output of an Unbounce Classic Builder page. It is',
              'extremely large and contains internal builder JSON, iframe srcdoc, lightbox sub-pages,',
              'and other structures that cannot be meaningfully edited via edit_variant.',
              '',
              'DO NOT attempt to:',
              '  - Pass this HTML back through edit_variant or add_variant',
              '  - Make string replacements inside the builder JSON or srcdoc',
              '  - Decode or modify the iframe srcdoc content',
              '  - Use this HTML as the basis for a new variant',
              '',
              'CORRECT APPROACH for creating a new variant:',
              '  Use the screenshot and this HTML purely as visual/content reference.',
              '  Write fresh, clean custom HTML/CSS for the new variant from scratch.',
              '  Extract text content, colors, fonts, and image URLs from this HTML as inputs,',
              '  then compose a new document — do not copy the builder structure.',
              '',
              'If the user is asking you to MODERNIZE this Classic Builder page (replicate it as',
              'clean responsive HTML, get rid of absolute positioning, etc.), call the',
              'get_classic_builder_modernization_guidelines tool BEFORE writing any HTML —',
              'it returns the full set of fidelity rules and the workflow to follow.',
              '',
              'custom_code/custom_css: any existing custom code snippets from the original (may be empty).',
              '',
              'IMAGE REUSE — CRITICAL:',
              '',
              'All <img> tags in this HTML have src="data:image/gif;base64,..." (lazy-load placeholder).',
              'The real image URLs are in data-src-desktop-1x and data-src-mobile-1x attributes.',
              'They always follow this format (image-service.unbounce.com proxy):',
              '  //image-service.unbounce.com/https%3A%2F%2Fapp.unbounce.com%2Fpublish%2Fassets%2F{uuid}%2F{filename}?{params}',
              '',
              'When creating a new variant, for each image find the data-src-desktop-1x value on',
              'the original <img> element and use that image-service.unbounce.com URL directly in',
              'the src attribute of your new <img> tag. These URLs are publicly accessible.',
              '',
              'NEVER use URLs in the format app.unbounce.com/assets/{uuid}/{filename} (without',
              '/publish/ in the path). Those are authenticated internal storage paths that appear',
              'in the embedded builder JSON blobs in this document — they will fail on any',
              'publicly-served page. If you see a URL with /assets/ but no /publish/, discard it.',
            ].join('\n'),
          }
        }
      }
    } catch (previewErr) {
      console.error('[getVariantContent] Preview fallback failed:', previewErr.message)
    }

    return { variant: variantLetter, numericId: directNumericId, html, css }
  })
}

/**
 * Edit the HTML and/or CSS of a specific variant in the Unbounce visual editor.
 * @param {string} subAccountId
 * @param {string} pageId - UUID of the page
 * @param {string} variantLetter - 'a', 'b', 'c', 'd', etc.
 * @param {string|null} newHtml - Full HTML content, or null to skip
 * @param {string|null} newCss - Full CSS content (with <style> tags), or null to skip
 */
export async function editVariantHtml(subAccountId, pageId, variantLetter, newHtml, newCss) {
  return withPage(async (page) => {
    const variantIds = await directGetVariantNumericIds(page, pageId)
    const numericId = variantIds[variantLetter.toLowerCase()]
    if (!numericId) {
      throw new Error(`Variant "${variantLetter}" not found via GraphQL. Available: ${Object.keys(variantIds).join(', ')}`)
    }
    await directEditVariant(page, numericId, newHtml || null, newCss || null, variantLetter)
    return {
      variant: variantLetter,
      numericId,
      status: 'saved',
      html_bytes_written: newHtml ? newHtml.length : null,
      css_bytes_written: newCss ? newCss.length : null,
    }
  })
}

// ── Add variant ────────────────────────────────────────────────────────────────

/**
 * Add a new variant to an existing page by duplicating variant A via the UI,
 * then optionally replacing its HTML and/or CSS in the editor.
 *
 * @param {string} subAccountId
 * @param {string} pageId - UUID of the page
 * @param {string|null} html - HTML to write into the new variant, or null to keep the duplicate
 * @param {string|null} css  - CSS to write into the new variant, or null to keep the duplicate
 * @returns {{ variant: string, numericId: string, status: string }}
 */
export async function addVariant(subAccountId, pageId, html, css) {
  return withPage(async (page) => {
    const { variant, numericId } = await directCreateVariantFromScratch(page, pageId, html, css)
    return { variant, numericId, status: html || css ? 'created_and_edited' : 'created' }
  })
}

// ── Duplicate variant ──────────────────────────────────────────────────────────

export async function duplicateVariant(subAccountId, pageId, variantLetter) {
  return withPage(async (page) => {
    return directDuplicateVariant(page, pageId, variantLetter)
  })
}

// ── Rename variant ─────────────────────────────────────────────────────────────

export async function renameVariant(subAccountId, pageId, variantLetter, name) {
  return withPage(async (page) => {
    const newName = await directRenameVariant(page, pageId, variantLetter, name)
    return { variant: variantLetter, name: newName }
  })
}

// ── Custom JavaScripts (Head / After Body Tag / Before Body End Tag) ──────────

export async function getJavascripts(subAccountId, pageId, variantLetter) {
  return withPage(async (page) => {
    const variantIds = await directGetVariantNumericIds(page, pageId)
    const numericId = variantIds[variantLetter.toLowerCase()]
    if (!numericId) {
      throw new Error(`Variant "${variantLetter}" not found via GraphQL. Available: ${Object.keys(variantIds).join(', ')}`)
    }
    const scripts = await directGetJavascripts(page, numericId)
    return { variant: variantLetter, numericId, scripts }
  })
}

export async function setJavascripts(subAccountId, pageId, variantLetter, scripts) {
  return withPage(async (page) => {
    const variantIds = await directGetVariantNumericIds(page, pageId)
    const numericId = variantIds[variantLetter.toLowerCase()]
    if (!numericId) {
      throw new Error(`Variant "${variantLetter}" not found via GraphQL. Available: ${Object.keys(variantIds).join(', ')}`)
    }
    const result = await directSetJavascripts(page, numericId, scripts)
    return { variant: variantLetter, numericId, ...result }
  })
}

// ── Reauthenticate ─────────────────────────────────────────────────────────────

export async function reauthenticate() {
  // Clear JWT cache immediately so the next tool call fetches a fresh token.
  // Do NOT delete the session file — keep existing cookies alive during login
  // so in-flight tool calls don't race against a missing session.
  // doHeadedLogin will overwrite the session file when login completes.
  clearJwtCache()
  _session = null
  try {
    // Block until login finishes so the agent can auto-retry the original
    // operation as soon as this tool call returns. doHeadedLogin has a 5-min
    // waitForURL timeout, so abandoned logins fail cleanly rather than hang.
    await doHeadedLogin()
    return { status: 'authenticated', message: 'Login complete. Retry the original operation.' }
  } catch (err) {
    return { status: 'login_failed', message: `Login did not complete: ${err.message}` }
  }
}

// ── Cleanup ────────────────────────────────────────────────────────────────────

export async function closeBrowser() {
  if (_browser) {
    await _browser.close().catch(() => {})
    _browser = null
  }
}
