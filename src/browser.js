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
import {
  clearJwtCache,
  directPublish, directUnpublish, directDelete,
  directSetVariantWeights, directSetTrafficMode, directSetPageUrl,
  directGetVariant, directEditVariant, directGetVariantNumericIds,
  directRenameVariant, directCreateVariantFromScratch, directInitBlankSlate,
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
async function newAuthPage(browser) {
  const context = await browser.newContext()
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
async function withPage(fn) {
  await ensureSession()
  const browser = await getBrowser()
  const page = await newAuthPage(browser)

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
    const msg = err.message?.toLowerCase() ?? ''
    if (msg.includes('login') || msg.includes('401') || msg.includes('unauthorized') || msg.includes('unauthenticated')) {
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
    await page.goto(`${UNBOUNCE_APP_BASE}/${subAccountId}/pages/${pageId}/overview`)
    await page.waitForLoadState('load')

    try {
      await directSetPageUrl(page, pageId, domain, slug)
      return
    } catch (err) {
      // URL-taken error should surface directly, not fall back to UI
      if (err.message?.includes('already taken')) throw err
      console.error('[direct] setPageUrl failed, falling back to UI:', err.message)
    }

    // UI fallback
    await page.click('[data-testid="flyout-page-actions"]')
    await page.waitForSelector('[data-testid="flyoutPageURL"]')
    await page.click('[data-testid="flyoutPageURL"]')
    await page.waitForSelector('[data-testid="speedy_domain_path_input"]')

    await page.click('.select__control')
    await page.waitForSelector('.select__menu')
    await page.fill('.select__input', domain)
    await page.waitForSelector(`.select__option:has-text("${domain}")`)
    await page.click(`.select__option:has-text("${domain}")`)

    const pathInput = page.locator('[data-testid="speedy_domain_path_input"]')
    await pathInput.fill('')
    await pathInput.type(slug)
    await page.click('[data-testid="submit_speedy_domain_url_modal"]')

    const result = await Promise.race([
      page.waitForSelector('[data-testid="speedy_domain_path_input"]', { state: 'detached' }).then(() => 'success'),
      page.waitForSelector('.ChangeUrlModal__error--ZCDTu', { state: 'visible' }).then(() => 'error'),
    ])

    if (result === 'error') {
      const errorText = await page.locator('.ChangeUrlModal__error--ZCDTu').textContent()
      throw new Error(errorText.trim())
    }
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
    await page.goto(`${UNBOUNCE_APP_BASE}/${subAccountId}/pages/${pageId}/overview`)
    await page.waitForLoadState('load')

    try {
      await directPublish(page, subAccountId, pageId)
      return
    } catch (err) {
      console.error('[direct] publishPage failed, falling back to UI:', err.message)
    }

    // UI fallback
    await page.waitForSelector('[data-testid="republish-button"], [data-testid="publish-flyout"]', { timeout: 30000 })
    const republishBtn = page.locator('[data-testid="republish-button"]')
    const isRepublish = await republishBtn.isVisible().catch(() => false)

    if (isRepublish) {
      await republishBtn.click()
    } else {
      await page.click('[data-testid="publish-flyout"]')
      await page.waitForSelector('[data-testid="publish-flyoutitem"]')
      await page.click('[data-testid="publish-flyoutitem"]')
    }

    await page.waitForSelector('[data-testid="publishModalBtn"]')
    await page.click('[data-testid="publishModalBtn"]')
    await page.waitForLoadState('load')
    await page.waitForTimeout(2000)
  })
}

// ── Unpublish ──────────────────────────────────────────────────────────────────

export async function unpublishPage(subAccountId, pageId) {
  return withPage(async (page) => {
    await page.goto(`${UNBOUNCE_APP_BASE}/${subAccountId}/pages/${pageId}/overview`)
    await page.waitForLoadState('load')

    try {
      await directUnpublish(page, subAccountId, pageId)
      return
    } catch (err) {
      console.error('[direct] unpublishPage failed, falling back to UI:', err.message)
    }

    // UI fallback
    await page.waitForSelector('[data-testid="unpublish-button"]')
    await page.click('[data-testid="unpublish-button"]')
    await page.waitForSelector('[data-testid="unpublishModalBtn"]')
    await page.click('[data-testid="unpublishModalBtn"]')
    await page.waitForLoadState('load')
  })
}

// ── Delete ─────────────────────────────────────────────────────────────────────

export async function deletePage(subAccountId, pageId) {
  return withPage(async (page) => {
    try {
      await directDelete(page, pageId)
      return
    } catch (err) {
      console.error('[direct] deletePage failed, falling back to UI:', err.message)
    }

    // UI fallback
    await page.goto(`${UNBOUNCE_APP_BASE}/${subAccountId}/pages/${pageId}/overview`)
    await page.waitForLoadState('load')
    await page.click('[data-testid="flyout-page-actions"]')
    await page.waitForSelector('[data-testid="flyoutDeletePage"]')
    await page.click('[data-testid="flyoutDeletePage"]')
    await page.waitForSelector('[data-testid="confirm-delete-page"]')
    await page.click('[data-testid="confirm-delete-page"]')
    await page.waitForTimeout(1000)
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

export async function screenshotVariant(subAccountId, pageId, variantLetter) {
  return withPage(async (page) => {
    const { variants } = await directGetPageVariants(page, pageId)
    const variant = variants.find(v => v.variant === variantLetter.toLowerCase())
    if (!variant) throw new Error(`Variant "${variantLetter}" not found on page ${pageId}`)
    if (!variant.preview_path) throw new Error(`No preview path available for variant ${variantLetter}`)

    // Navigate to the preview wrapper page to obtain the authenticated iframe URL
    await page.goto(`${UNBOUNCE_APP_BASE}${variant.preview_path}`, { waitUntil: 'networkidle', timeout: 30000 })
    const iframeSrc = await page.evaluate(() => document.getElementById('page-preview')?.src)
    if (!iframeSrc) throw new Error('Preview iframe not found — page may not have loaded')

    await page.goto(iframeSrc, { waitUntil: 'networkidle', timeout: 30000 })
    const innerSrc = await page.evaluate(() => document.getElementById('page-preview-output')?.src)
    if (innerSrc) {
      await page.goto(innerSrc, { waitUntil: 'networkidle', timeout: 30000 })
    }

    // DIAGNOSTIC — gather every piece of dimension data we can, then return it
    await page.setViewportSize({ width: 1280, height: 900 })
    const diag = await page.evaluate(() => {
      const lpPom = document.getElementById('lp-pom-root')
      const body = document.body
      // find the 10 elements with the largest BCR bottom
      const entries = []
      document.querySelectorAll('*').forEach(el => {
        try {
          const r = el.getBoundingClientRect()
          entries.push({ tag: el.tagName, id: el.id || undefined, bottom: Math.round(r.bottom + window.pageYOffset), height: Math.round(r.height) })
        } catch(_) {}
      })
      entries.sort((a,b) => b.bottom - a.bottom)
      return {
        url: location.href,
        innerH: window.innerHeight,
        pageYOffset: window.pageYOffset,
        docScrollH: document.documentElement.scrollHeight,
        bodyScrollH: body?.scrollHeight,
        bodyOffsetH: body?.offsetHeight,
        lpPomOffsetH: lpPom?.offsetHeight,
        lpPomBCR: lpPom ? (() => { const r = lpPom.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom) } })() : null,
        deepest10: entries.slice(0, 10),
        innerSrcWas: document.getElementById('page-preview-output')?.src || null,
      }
    })
    // Also dump all Playwright frame URLs — src attr may be null if set dynamically
    const playwrightFrames = page.frames().map(f => ({ name: f.name(), url: f.url() }))
    return { _type: 'text', text: '```json\n' + JSON.stringify({ diag, playwrightFrames }, null, 2) + '\n```' }

    // eslint-disable-next-line no-unreachable
    await page.setViewportSize({ width: 1280, height: 900 })
    const desktopBuffer = await page.screenshot({ type: 'jpeg', quality: 80 })

    await page.setViewportSize({ width: 390, height: 844 })
    await page.waitForTimeout(500)
    const mobileHeight = await getFullHeight()
    await page.setViewportSize({ width: 390, height: mobileHeight })
    const mobileBuffer = await page.screenshot({ type: 'jpeg', quality: 80 })

    const label = `Variant ${variantLetter.toUpperCase()} — ${variant.name ?? ''}`.trim()
    return {
      _type: 'images',
      images: [
        { data: desktopBuffer.toString('base64'), mimeType: 'image/jpeg', caption: `${label} (desktop 1280px)` },
        { data: mobileBuffer.toString('base64'), mimeType: 'image/jpeg', caption: `${label} (mobile 390px)` },
      ],
    }
  })
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
 * Get variant numeric IDs by navigating to the page overview and extracting
 * the edit button hrefs. data-testid="button-edit-{letter}" is reliable.
 * Returns { a: '325994188', b: '325994189', ... }
 */
async function getVariantNumericIds(page, subAccountId, pageId) {
  await page.goto(`${UNBOUNCE_APP_BASE}/${subAccountId}/pages/${pageId}/overview`)
  // Wait for either multi-variant edit buttons or the single-variant edit button
  await page.waitForSelector('[data-testid^="button-edit-"], [data-testid="edit-single-variant"]', { timeout: 30000 })

  const ids = await page.evaluate(() => {
    // Multi-variant: data-testid="button-edit-a", "button-edit-b", etc.
    const multiButtons = Array.from(document.querySelectorAll('a[data-testid^="button-edit-"]'))
    if (multiButtons.length > 0) {
      return multiButtons.map(a => {
        const letter = a.getAttribute('data-testid').replace('button-edit-', '')
        const m = a.getAttribute('href').match(/\/variants\/(\d+)\/edit/)
        return m ? { letter, numericId: m[1] } : null
      }).filter(Boolean)
    }
    // Single variant: no letter in testid, always variant "a"
    const singleBtn = document.querySelector('a[data-testid="edit-single-variant"]')
    if (singleBtn) {
      const m = singleBtn.getAttribute('href').match(/\/variants\/(\d+)\/edit/)
      if (m) return [{ letter: 'a', numericId: m[1] }]
    }
    return []
  })

  if (!ids.length) throw new Error('Could not find variant edit buttons on page overview')

  return Object.fromEntries(ids.map(({ letter, numericId }) => [letter, numericId]))
}

/**
 * Read the current HTML and CSS of a specific variant.
 * Direct path: reads edit.json via API (lp-code-1 + lp-stylesheet-1 elements).
 * Fallback: navigates to the preview iframe for legacy builder pages.
 * @returns {{ html: string, css: string, variant: string, numericId: string }}
 */
export async function getVariantContent(subAccountId, pageId, variantLetter) {
  return withPage(async (page) => {
    let directNumericId = null
    let html = null
    let css = null

    // Direct path: GraphQL for numeric ID + fetch edit.json (no UI clicking)
    try {
      const variantIds = await directGetVariantNumericIds(page, pageId)
      directNumericId = variantIds[variantLetter.toLowerCase()]
      if (!directNumericId) throw new Error(`Variant "${variantLetter}" not found. Available: ${Object.keys(variantIds).join(', ')}`)
      const result = await directGetVariant(page, directNumericId)
      html = result.html
      css = result.css
      const isFullPage = html && (html.includes('<!DOCTYPE') || html.includes('<html'))
      if (isFullPage) return { variant: variantLetter, numericId: directNumericId, html, css }
    } catch (err) {
      console.error('[getVariantContent] Direct path failed:', err.message)
    }

    // Legacy builder page — content in edit.json is empty; fall back to rendered preview.
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
              'LEGACY BUILDER PAGE — READ-ONLY REFERENCE.',
              '',
              'This HTML is the fully rendered output of an Unbounce visual builder page. It is',
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
    // Try fully-direct path: GraphQL for IDs + direct API save (no Playwright navigation)
    try {
      const variantIds = await directGetVariantNumericIds(page, pageId)
      const numericId = variantIds[variantLetter.toLowerCase()]
      if (!numericId) throw new Error(`Variant "${variantLetter}" not found via GraphQL. Available: ${Object.keys(variantIds).join(', ')}`)
      await directEditVariant(page, numericId, newHtml || null, newCss || null, variantLetter)
      return {
        variant: variantLetter,
        numericId,
        status: 'saved',
        method: 'direct',
        html_bytes_written: newHtml ? newHtml.length : null,
        css_bytes_written: newCss ? newCss.length : null,
      }
    } catch (err) {
    }

    // Playwright UI fallback: navigate to overview to get IDs
    const variantIds = await getVariantNumericIds(page, subAccountId, pageId)
    const numericId = variantIds[variantLetter.toLowerCase()]
    if (!numericId) {
      throw new Error(`Variant "${variantLetter}" not found. Available: ${Object.keys(variantIds).join(', ')}`)
    }

    // Navigate to the variant editor
    const editorUrl = `${UNBOUNCE_APP_BASE}/${subAccountId}/variants/${numericId}/edit`
    await page.goto(editorUrl)
    await page.waitForLoadState('load')

    // Wait for the editor to finish loading
    await page.waitForSelector('#treeToggle', { timeout: 30000 })
    await page.waitForTimeout(1000)

    let htmlBytesWritten = null
    let cssBytesWritten = null

    // ── HTML edit ──────────────────────────────────────────────────────────────
    if (newHtml) {
      await page.click('#treeToggle')
      await page.waitForTimeout(500)

      await page.click('li.lp-code.editor-content-tree-group-list-item a.content-tree-node-wrapper')
      await page.waitForTimeout(500)

      await page.waitForSelector('.panel-content a.full-width-button', { timeout: 10000 })
      await page.click('.panel-content a.full-width-button')

      await page.waitForSelector('.CodeMirror', { timeout: 10000 })
      await page.evaluate((html) => {
        document.querySelector('.CodeMirror').CodeMirror.setValue(html)
      }, newHtml)

      // Read back length before closing (CodeMirror is gone after close)
      htmlBytesWritten = await page.evaluate(() =>
        document.querySelector('.CodeMirror')?.CodeMirror?.getValue()?.length ?? 0
      )

      await page.click('a.save-code-button')
      await page.waitForTimeout(500)
    }

    // ── CSS edit ───────────────────────────────────────────────────────────────
    if (newCss) {
      await page.click('span.lp-stylesheet.shelf-button')
      await page.waitForTimeout(300)

      await page.waitForSelector('div.menu .menu-item.popup-menu-item', { timeout: 5000 })
      await page.locator('div.menu .menu-item.popup-menu-item').first().click()
      await page.waitForTimeout(500)

      await page.waitForSelector('.CodeMirror', { timeout: 10000 })
      await page.evaluate((css) => {
        document.querySelector('.CodeMirror').CodeMirror.setValue(css)
      }, newCss)

      // Read back length before closing
      cssBytesWritten = await page.evaluate(() =>
        document.querySelector('.CodeMirror')?.CodeMirror?.getValue()?.length ?? 0
      )

      await page.click('a.save-code-button.modal-button')
      await page.waitForTimeout(500)
    }

    // ── Save the variant ───────────────────────────────────────────────────────
    try {
      await page.click('a.save-button-container a.save, .save-button-container .save')
      await page.waitForTimeout(1000)
    } catch (err) {
      // Content was written to the editor but the save click failed.
      // Do NOT re-edit from scratch — retry by calling edit_variant again.
      return {
        variant: variantLetter,
        numericId,
        status: 'save_failed',
        html_bytes_written: htmlBytesWritten,
        css_bytes_written: cssBytesWritten,
        error: `Content was written to the editor (html_bytes_written: ${htmlBytesWritten}) but the save failed: ${err.message}. Call edit_variant again to retry the save.`,
      }
    }

    return { variant: variantLetter, numericId, status: 'saved', html_bytes_written: htmlBytesWritten, css_bytes_written: cssBytesWritten }
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
    // --- Direct path (preferred): GraphQL createVariant with blank template ---
    try {
      const { variant, numericId } = await directCreateVariantFromScratch(page, pageId, html, css)
      return { variant, numericId, status: html || css ? 'created_and_edited' : 'created' }
    } catch (err) {
      console.error('[direct] createVariantFromScratch failed, falling back to UI:', err.message)
    }

    // --- Playwright UI fallback ---
    await page.goto(`${UNBOUNCE_APP_BASE}/${subAccountId}/pages/${pageId}/overview`)
    await page.waitForLoadState('load')

    const existingIds = await getVariantNumericIds(page, subAccountId, pageId)
    const existingLetters = new Set(Object.keys(existingIds))

    // Open the flyout and click Add Variant
    await page.click('[data-testid="flyout-page-actions"]')
    await page.waitForSelector('[data-testid="flyoutAddVariant"]')
    await page.click('[data-testid="flyoutAddVariant"]')

    // Select "Start from scratch" (data-testid="scratch-radiobutton")
    await page.waitForSelector('[data-testid="button-create-variant"]', { timeout: 15000 })
    const scratchRadio = page.locator('[data-testid="scratch-radiobutton"]')
    if (await scratchRadio.isVisible()) await scratchRadio.click()

    await page.click('[data-testid="button-create-variant"]')

    // Wait for new variant to appear in the overview
    await page.waitForFunction(
      (existing) => {
        const buttons = Array.from(document.querySelectorAll('a[data-testid^="button-edit-"]'))
        const letters = buttons.map(a => a.getAttribute('data-testid').replace('button-edit-', ''))
        return letters.some(l => !existing.includes(l))
      },
      [...existingLetters],
      { timeout: 30000 }
    )

    const updatedIds = await getVariantNumericIds(page, subAccountId, pageId)
    const newLetter = Object.keys(updatedIds).filter(l => !existingLetters.has(l)).sort().pop()
    if (!newLetter) throw new Error('Could not identify the newly created variant')
    const newNumericId = updatedIds[newLetter]

    // Initialize with blank slate (replaces the blank template's default elements)
    try {
      await directInitBlankSlate(page, newNumericId, html, css, newLetter)
    } catch (initErr) {
      return {
        variant: newLetter,
        numericId: newNumericId,
        status: 'created',
        edit_error: `Variant ${newLetter.toUpperCase()} created but blank slate init failed: ${initErr.message}. Call edit_variant with variant: "${newLetter}" to set the HTML/CSS, then republish.`,
      }
    }

    return { variant: newLetter, numericId: newNumericId, status: html || css ? 'created_and_edited' : 'created' }
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

// ── Reauthenticate ─────────────────────────────────────────────────────────────

export async function reauthenticate() {
  // Clear JWT cache immediately so the next tool call fetches a fresh token.
  // Do NOT delete the session file — keep existing cookies alive during login
  // so in-flight tool calls don't race against a missing session.
  // doHeadedLogin will overwrite the session file when login completes.
  clearJwtCache()
  _session = null
  doHeadedLogin().catch(err => console.error('[unbounce-mcp] Login error:', err.message))
  return { status: 'browser_opened', message: 'Login browser is open. Complete sign-in in the browser window. Tell me when the window has closed and I will retry.' }
}

// ── Cleanup ────────────────────────────────────────────────────────────────────

export async function closeBrowser() {
  if (_browser) {
    await _browser.close().catch(() => {})
    _browser = null
  }
}
