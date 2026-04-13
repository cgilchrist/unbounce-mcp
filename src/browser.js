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
  directPublish, directUnpublish, directDelete,
  directSetVariantWeights, directSetTrafficMode, directSetPageUrl,
} from './direct.js'

let _browser = null
let _session = null // { cookies: [{name, value, domain, ...}], csrfToken: string }

// ── Session persistence ────────────────────────────────────────────────────────

async function loadSession() {
  try {
    const raw = await fs.promises.readFile(SESSION_FILE, 'utf8')
    _session = JSON.parse(raw)
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

  // Wait for successful login — URL should contain /pages or /dashboard
  console.error('[unbounce-mcp] Please log in to Unbounce in the browser window.')
  await page.waitForURL(url => url.href.includes('/pages') || url.href.includes('/dashboard'), { timeout: 300000 })

  const cookies = await context.cookies()
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
    await doHeadedLogin()
  }
}

/**
 * Run a page action with a fresh authenticated page.
 * Handles session expiry by clearing and re-prompting login once.
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
    if (err.message?.includes('login') || err.message?.includes('401') || err.message?.includes('unauthorized')) {
      await clearSession()
      await doHeadedLogin()
      // Retry once with fresh session
      const freshPage = await newAuthPage(await getBrowser())
      try {
        return await fn(freshPage)
      } finally {
        await freshPage.context().close()
      }
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
export async function setTrafficMode(subAccountId, pageId, mode) {
  return withPage(async (page) => {
    await page.goto(`${UNBOUNCE_APP_BASE}/${subAccountId}/pages/${pageId}/overview`)
    await page.waitForLoadState('load')

    try {
      await directSetTrafficMode(page, pageId, mode)
      return
    } catch (err) {
      console.error('[direct] setTrafficMode failed, falling back to UI:', err.message)
    }

    // UI fallback
    const testId = mode === 'smart_traffic' ? 'label-smartTraffic' : 'label-abTest'
    await page.waitForSelector(`[data-testid="${testId}"]`)
    await page.click(`[data-testid="${testId}"]`)
    await page.waitForTimeout(500)
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
    await page.goto(`${UNBOUNCE_APP_BASE}/${subAccountId}/pages/${pageId}/overview`)
    await page.waitForLoadState('load')

    try {
      await directSetVariantWeights(page, pageId, weights)
      return
    } catch (err) {
      console.error('[direct] setVariantWeights failed, falling back to UI:', err.message)
    }

    // UI fallback
    const firstVariant = Object.keys(weights)[0]
    await page.waitForSelector(`[data-testid="variant-weight-${firstVariant}"]`)
    await page.click(`[data-testid="variant-weight-${firstVariant}"]`)
    await page.waitForSelector('[data-testid="button-confirm"]')
    for (const [variantId, weight] of Object.entries(weights)) {
      const input = page.locator(`[data-testid="modal-input-${variantId}"]`)
      await input.fill(String(weight))
    }
    await page.click('[data-testid="button-confirm"]')
    await page.waitForLoadState('load')
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
    await page.goto(`${UNBOUNCE_APP_BASE}/${subAccountId}/pages/${pageId}/overview`)
    await page.waitForLoadState('load')

    try {
      await directDelete(page, pageId)
      return
    } catch (err) {
      console.error('[direct] deletePage failed, falling back to UI:', err.message)
    }

    // UI fallback
    await page.click('[data-testid="flyout-page-actions"]')
    await page.waitForSelector('[data-testid="flyoutDeletePage"]')
    await page.click('[data-testid="flyoutDeletePage"]')
    await page.waitForSelector('[data-testid="confirm-delete-page"]')
    await page.click('[data-testid="confirm-delete-page"]')
    await page.waitForTimeout(1000)
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
  // Wait for at least one variant edit button to appear (React SPA must fully render)
  await page.waitForSelector('[data-testid^="button-edit-"]', { timeout: 30000 })

  const ids = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('a[data-testid^="button-edit-"]'))
    return buttons.map(a => {
      const letter = a.getAttribute('data-testid').replace('button-edit-', '')
      const m = a.getAttribute('href').match(/\/variants\/(\d+)\/edit/)
      return m ? { letter, numericId: m[1] } : null
    }).filter(Boolean)
  })

  if (!ids.length) throw new Error('Could not find variant edit buttons on page overview')

  return Object.fromEntries(ids.map(({ letter, numericId }) => [letter, numericId]))
}

/**
 * Read the current HTML and CSS of a specific variant from the Unbounce editor.
 * @returns {{ html: string, css: string, variant: string, numericId: string }}
 */
export async function getVariantContent(subAccountId, pageId, variantLetter) {
  return withPage(async (page) => {
    const variantIds = await getVariantNumericIds(page, subAccountId, pageId)
    const numericId = variantIds[variantLetter.toLowerCase()]
    if (!numericId) {
      throw new Error(`Variant "${variantLetter}" not found. Available: ${Object.keys(variantIds).join(', ')}`)
    }

    const editorUrl = `${UNBOUNCE_APP_BASE}/${subAccountId}/variants/${numericId}/edit`
    await page.goto(editorUrl)
    await page.waitForLoadState('load')
    await page.waitForSelector('#treeToggle', { timeout: 30000 })
    await page.waitForTimeout(1000)

    // ── Read HTML ──────────────────────────────────────────────────────────────
    await page.click('#treeToggle')
    await page.waitForTimeout(500)
    await page.click('li.lp-code.editor-content-tree-group-list-item a.content-tree-node-wrapper')
    await page.waitForTimeout(500)
    await page.waitForSelector('.panel-content a.full-width-button', { timeout: 10000 })
    await page.click('.panel-content a.full-width-button')
    await page.waitForSelector('.CodeMirror', { timeout: 10000 })

    const html = await page.evaluate(() =>
      document.querySelector('.CodeMirror').CodeMirror.getValue()
    )

    // Close HTML modal
    await page.click('a.save-code-button')
    await page.waitForTimeout(500)

    // ── Read CSS ───────────────────────────────────────────────────────────────
    await page.click('span.lp-stylesheet.shelf-button')
    await page.waitForTimeout(300)
    await page.waitForSelector('div.menu .menu-item.popup-menu-item', { timeout: 5000 })
    await page.locator('div.menu .menu-item.popup-menu-item').first().click()
    await page.waitForTimeout(500)
    await page.waitForSelector('.CodeMirror', { timeout: 10000 })

    const css = await page.evaluate(() =>
      document.querySelector('.CodeMirror').CodeMirror.getValue()
    )

    // Close CSS modal
    await page.click('a.save-code-button.modal-button')
    await page.waitForTimeout(300)

    return { variant: variantLetter, numericId, html, css }
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
    // Get numeric variant IDs from the overview page (waits for React to render)
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

    // ── HTML edit ──────────────────────────────────────────────────────────────
    if (newHtml) {
      // Open the contents tree panel
      await page.click('#treeToggle')
      await page.waitForTimeout(500)

      // Click the code element in the contents tree
      await page.click('li.lp-code.editor-content-tree-group-list-item a.content-tree-node-wrapper')
      await page.waitForTimeout(500)

      // Click "Edit Code" in the properties panel
      await page.waitForSelector('.panel-content a.full-width-button', { timeout: 10000 })
      await page.click('.panel-content a.full-width-button')

      // Set HTML via CodeMirror
      await page.waitForSelector('.CodeMirror', { timeout: 10000 })
      await page.evaluate((html) => {
        document.querySelector('.CodeMirror').CodeMirror.setValue(html)
      }, newHtml)

      // Click "Save Code" (Done) to close the HTML modal
      await page.click('a.save-code-button')
      await page.waitForTimeout(500)
    }

    // ── CSS edit ───────────────────────────────────────────────────────────────
    if (newCss) {
      // Click the Stylesheets button in the footer
      await page.click('span.lp-stylesheet.shelf-button')
      await page.waitForTimeout(300)

      // Click the first existing stylesheet in the menu (not "+ Add New Stylesheet")
      await page.waitForSelector('div.menu .menu-item.popup-menu-item', { timeout: 5000 })
      await page.locator('div.menu .menu-item.popup-menu-item').first().click()
      await page.waitForTimeout(500)

      // Set CSS via CodeMirror in the modal
      await page.waitForSelector('.CodeMirror', { timeout: 10000 })
      await page.evaluate((css) => {
        document.querySelector('.CodeMirror').CodeMirror.setValue(css)
      }, newCss)

      // Click "Done" to close the stylesheet modal
      await page.click('a.save-code-button.modal-button')
      await page.waitForTimeout(500)
    }

    // ── Save the variant ───────────────────────────────────────────────────────
    await page.click('a.save-button-container a.save, .save-button-container .save')
    await page.waitForTimeout(1000)

    return { variant: variantLetter, numericId, status: 'saved' }
  })
}

// ── Cleanup ────────────────────────────────────────────────────────────────────

export async function closeBrowser() {
  if (_browser) {
    await _browser.close().catch(() => {})
    _browser = null
  }
}
