/**
 * packageToUnbounce — converts HTML files into an Unbounce-compatible .unbounce TAR archive.
 * Extracted from CNVRT's app/api/ubexport/route.ts.
 *
 * @param {Array<{name: string, html: string}>} htmlFiles - HTML variants (up to 26)
 * @param {Array<{name: string, data: Buffer}>} [imageFiles] - Optional image files to inline
 * @param {string} [pageName] - Page name shown in Unbounce
 * @returns {Promise<Buffer>} - The .unbounce TAR file as a Buffer
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'
import * as zlib from 'zlib'
import { promisify } from 'util'
import * as cheerio from 'cheerio'
import * as tar from 'tar'
import { transformForms, extractCss } from './transform.js'
import { stampBodyHtml } from './signature.js'

const gunzip = promisify(zlib.gunzip)

const VARIANT_LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('')

// ─────────────────────────────────────────────────────────────────────────────
// UNBOUNCE PUBLISHER BUG — context for future debugging
// ─────────────────────────────────────────────────────────────────────────────
//
// Unbounce's publisher does a dumb string-replace across the entire page,
// injecting:
//
//   <META http-equiv="Content-Type" content="text/html; charset=UTF-8" >
//
// after EVERY literal occurrence of "<head>" it finds — including inside
// <script> tag bodies, JavaScript comments, and string literals.
//
// If an uploaded HTML file happens to contain a <script> tag whose text
// content is a JSON-encoded string (i.e. the raw bytes of the script body
// start with a literal `"` and encode HTML as a JSON value), the injected
// META tag lands inside that JSON string with unescaped double-quotes.
// Those unescaped quotes act as JSON string terminators, so JSON.parse()
// succeeds on the truncated value and then throws:
//
//   "Unexpected non-whitespace character after JSON at position 61 (line 2 column 61)"
//
// We reproduced this exactly:
//   raw.replace('<head>', '<head><META http-equiv="Content-Type" content="text/html; charset=UTF-8" >')
//   → JSON.parse(result) throws the above error at position 61
//
// The right fix is for Unbounce to only inject the META into the FIRST
// structural <head> element (or to use an HTML parser rather than string
// replace). Until then, we work around it below: if we detect that the
// HTML to be packaged contains this pattern (a manifest + JSON-encoded
// template in script tags), we unwrap it — extract the real HTML, inline all
// assets as data: URIs — and hand plain HTML to the packager so Unbounce's
// publisher never sees a JSON-encoded string to corrupt.
//
// Note: the specific script tag types ("__bundler/manifest", etc.) are just
// an artifact of whichever tool generated this particular HTML file. The
// underlying Unbounce bug would affect any HTML where a script tag body
// contains JSON-encoded content with a <head> string inside it.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true if the HTML contains the script-tag pattern that will be
 * corrupted by Unbounce's publisher META injection (see note above).
 */
function hasJsonEncodedTemplate(html) {
  return html.includes('type="__bundler/manifest"') || html.includes("type='__bundler/manifest'")
}

/**
 * Unwraps a JSON-encoded template from the HTML, inlines all assets, and
 * returns plain HTML safe for Unbounce's publisher.
 * Returns null if the expected script tags are missing or malformed.
 *
 * Asset inlining strategy:
 *   - JavaScript files  → inlined as <script> text content
 *     Reason: <script src="data:text/javascript;base64,..."> is blocked by
 *     Chrome and Firefox (they restrict script loading from data: URIs).
 *   - CSS files         → inlined as <style> text content (same reason as JS)
 *   - Fonts, images, SVG → kept as data: URIs inside url() or src/href
 *     Reason: data: URIs work fine in CSS url() and img src contexts.
 *
 * Blob: URLs are intentionally avoided throughout. They are origin-scoped: a
 * blob created in the Unbounce editor (app.unbounce.com) is inaccessible
 * on the published domain (unbouncepages.com).
 */
async function unwrapJsonEncodedTemplate(html) {
  const $ = cheerio.load(html)
  const manifestEl = $('script[type="__bundler/manifest"]')
  const templateEl = $('script[type="__bundler/template"]')

  if (!manifestEl.length || !templateEl.length) return null

  let manifest, template
  try {
    manifest = JSON.parse(manifestEl.text())
    template = JSON.parse(templateEl.text())
  } catch (err) {
    throw new Error(`JSON-encoded template detected but could not be parsed: ${err.message}`)
  }

  // Decode every asset (base64, optionally gzip-compressed).
  // Classify as JS, CSS, or binary so we can inline each appropriately.
  const jsAssets = {}   // uuid → decoded JS text
  const cssAssets = {}  // uuid → decoded CSS text
  const dataUris = {}   // uuid → data: URI (for fonts, images, SVG, etc.)

  await Promise.all(Object.entries(manifest).map(async ([uuid, entry]) => {
    const bytes = Buffer.from(entry.data, 'base64')
    const finalBytes = entry.compressed ? await gunzip(bytes) : bytes
    const mime = entry.mime
    if (mime === 'text/javascript' || mime === 'application/javascript') {
      jsAssets[uuid] = finalBytes.toString('utf8')
    } else if (mime === 'text/css') {
      cssAssets[uuid] = finalBytes.toString('utf8')
    } else {
      dataUris[uuid] = `data:${mime};base64,${finalBytes.toString('base64')}`
    }
  }))

  // Step 1: Replace binary asset UUIDs with data: URIs everywhere in the
  // template (handles font url() in CSS, img src, SVG references, etc.).
  for (const [uuid, uri] of Object.entries(dataUris)) {
    template = template.split(uuid).join(uri)
  }

  // Step 2: Replace <script src="UUID"> with inline <script> content.
  // Also replace any UUID that appears in a src attribute not as a script tag
  // (catch-all for remaining JS references).
  for (const [uuid, jsText] of Object.entries(jsAssets)) {
    // Escape </script> inside the JS text to prevent premature tag closure.
    const safeJs = jsText.replace(/<\/script/gi, '<\\/script')
    // Replace <script ... src="UUID" ...> with inline <script ...>content
    template = template.replace(
      new RegExp(`<script([^>]*)\\s+src="${uuid}"([^>]*)>`, 'gi'),
      (_, before, after) => `<script${before}${after}>${safeJs}`
    )
    template = template.replace(
      new RegExp(`<script([^>]*)\\s+src='${uuid}'([^>]*)>`, 'gi'),
      (_, before, after) => `<script${before}${after}>${safeJs}`
    )
    // Fallback: bare UUID reference not inside a src attribute
    template = template.split(uuid).join(`data:text/javascript;base64,${Buffer.from(jsText).toString('base64')}`)
  }

  // Step 3: Replace <link rel="stylesheet" href="UUID"> with inline <style>.
  // Also replace any CSS UUID that appears in url() or other contexts.
  for (const [uuid, cssText] of Object.entries(cssAssets)) {
    template = template.replace(
      new RegExp(`<link([^>]*)\\s+href="${uuid}"([^>]*)/?>`, 'gi'),
      (_, before, after) => `<style>${cssText}</style>`
    )
    template = template.replace(
      new RegExp(`<link([^>]*)\\s+href='${uuid}'([^>]*)/?>`, 'gi'),
      (_, before, after) => `<style>${cssText}</style>`
    )
    template = template.split(uuid).join(`data:text/css;base64,${Buffer.from(cssText).toString('base64')}`)
  }

  // Strip integrity/crossorigin attributes — they reference hashes of the
  // original external resources and would reject our inlined content.
  template = template
    .replace(/\s+integrity="[^"]*"/gi, '')
    .replace(/\s+crossorigin="[^"]*"/gi, '')

  return template
}

function newId() {
  return crypto.randomBytes(8).toString('hex')
}

function mimeForExt(ext) {
  switch (ext.toLowerCase()) {
    case '.svg': return 'image/svg+xml'
    case '.png': return 'image/png'
    case '.gif': return 'image/gif'
    case '.webp': return 'image/webp'
    default: return 'image/jpeg'
  }
}

function inlineImages(html, images) {
  for (const [filename, dataUri] of images) {
    const escaped = filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    html = html.replace(
      new RegExp(`(src=["'])${escaped}(["'])`, 'g'),
      `$1${dataUri}$2`
    )
  }
  return html
}

function pageMetadata(name) {
  return { name, champion_variant_id: 'a' }
}

function variantMetadata(name, hasForm, variantId, weight, { title = '', description = '', keywords = '' } = {}) {
  return {
    name,
    title,
    description,
    keywords,
    variant_id: variantId,
    variant_weight: weight,
    type: 'PageVariant',
    last_element_id: 4,
    has_form: hasForm,
    version: '4.2',
    template_id: 0,
  }
}

function variantSettings(width, hasForm, mainPageRef) {
  const base = {
    defaultWidth: width,
    showPageTransformBox: true,
    showSectionBoundaries: true,
    showPageSectionProtrusionWarnings: false,
    multipleBreakpointsEnabled: false,
    multipleBreakpointsVisibility: true,
    tabletBreakpointDisabled: true,
    contentType: 'pageVariant',
    activeGoals: hasForm ? [{ type: 'form', url: '/fs', sortOrder: 1 }] : [],
    fonts: [],
    noRobots: false,
    builderVersion: 'v6.24.285',
    globalImageQuality: { value: 60, compressPng: true },
    refId: 1,
    hasLightbox: false,
    webFontsInUse: {},
    webFontsExternalInUse: {},
  }
  if (mainPageRef) base.mainPage = mainPageRef
  return base
}

function mainElements(bodyHtml, cssHtml) {
  return [
    {
      id: 'lp-pom-root',
      type: 'lp-pom-root',
      name: 'Page Root',
      containerId: null,
      style: {
        background: { backgroundColor: 'ffffff' },
        defaults: { linkDecoration: 'none', color: '000', linkColor: '0000ff' },
        newBackground: {
          type: 'solidColor',
          solidColor: { bgColor: 'ffffff' },
          gradient: { baseColor: 'ffffff' },
        },
      },
      geometry: {
        position: 'relative',
        margin: 'auto',
        contentWidth: 1440,
        visible: true,
        scale: 1,
        padding: { top: 0 },
      },
      breakpoints: {
        mobile: { geometry: { visible: true, contentWidth: 320 } },
      },
    },
    {
      id: 'lp-pom-block-1',
      type: 'lp-pom-block',
      name: 'Content',
      containerId: 'lp-pom-root',
      style: {
        background: { fillType: 'solid', backgroundColor: 'ffffff', opacity: 100 },
        newBackground: { type: 'solidColor', solidColor: { bgColor: 'ffffff' } },
      },
      geometry: {
        position: 'relative',
        margin: { left: 'auto', right: 'auto', bottom: 0 },
        offset: { left: 0, top: 0 },
        borderLocation: 'outside',
        borderApply: { top: true, right: true, bottom: true, left: true },
        backgroundImageApply: false,
        savedBorderState: { left: true, right: true },
        fitWidthToPage: true,
        size: { width: 1440, height: 10000 },
        visible: true,
        scale: 1,
      },
      breakpoints: {
        mobile: {
          geometry: {
            visible: true,
            size: { width: 320, height: 10000 },
            fitWidthToPage: true,
          },
        },
      },
    },
    {
      id: 'lp-code-1',
      type: 'lp-code',
      name: 'Custom HTML',
      containerId: 'lp-pom-block-1',
      geometry: {
        position: 'absolute',
        offset: { left: 0, top: 0 },
        size: { width: 1440, height: 10000 },
        visible: true,
        scale: 1,
        zIndex: 1,
      },
      style: { background: { backgroundColor: 'ffffff', opacity: 0 } },
      content: { type: null, html: bodyHtml, valid: true },
      breakpoints: {
        mobile: {
          geometry: { visible: true, size: { width: 320, height: 10000 } },
          style: { background: { imageFixed: false } },
        },
      },
    },
    {
      id: 'lp-stylesheet-1',
      type: 'lp-stylesheet',
      name: 'Page Styles',
      containerId: null,
      placement: 'body:after',
      content: { type: null, html: cssHtml, valid: true },
      breakpoints: {},
    },
  ]
}

function confirmationElements() {
  return [
    {
      id: 'lp-pom-root',
      type: 'lp-pom-root',
      name: 'Page Root',
      containerId: null,
      style: {
        background: { backgroundColor: 'ffffff' },
        defaults: { linkDecoration: 'none', color: '000', linkColor: '0000ff' },
        newBackground: { type: 'solidColor', solidColor: { bgColor: 'ffffff' }, gradient: { baseColor: 'ffffff' } },
      },
      geometry: { position: 'relative', margin: 'auto', contentWidth: 760, visible: true, scale: 1, padding: { top: 0 } },
      breakpoints: { mobile: { geometry: { visible: true, contentWidth: 320 } } },
    },
    {
      id: 'lp-pom-block-1',
      type: 'lp-pom-block',
      name: 'Confirmation',
      containerId: 'lp-pom-root',
      style: { background: { fillType: 'solid', backgroundColor: 'ffffff', opacity: 100 } },
      geometry: {
        position: 'relative',
        margin: { left: 'auto', right: 'auto', bottom: 0 },
        offset: { left: 0, top: 0 },
        fitWidthToPage: true,
        size: { width: 760, height: 240 },
        visible: true,
        scale: 1,
      },
      breakpoints: { mobile: { geometry: { visible: true, size: { width: 320, height: 240 }, fitWidthToPage: true } } },
    },
    {
      id: 'lp-code-1',
      type: 'lp-code',
      name: 'Confirmation Content',
      containerId: 'lp-pom-block-1',
      geometry: { position: 'absolute', offset: { left: 0, top: 0 }, size: { width: 512, height: 240 }, visible: true, scale: 1, zIndex: 1 },
      style: { background: { backgroundColor: 'ffffff', opacity: 0 } },
      content: {
        type: null,
        html: `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:240px;padding:0 32px;box-sizing:border-box;font-family:system-ui,-apple-system,sans-serif;text-align:center;background:#fff;"><div style="width:40px;height:40px;border-radius:50%;background:#22c55e;display:flex;align-items:center;justify-content:center;margin-bottom:12px;"><svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M4 10l4.5 4.5L16 6" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div><p style="margin:0 0 6px;font-size:18px;font-weight:600;color:#111;">You're all set!</p><p style="margin:0;font-size:13px;color:#666;line-height:1.4;">Thanks for reaching out. We'll be in touch shortly.</p></div>`,
        valid: true,
      },
      breakpoints: { mobile: { geometry: { visible: true, size: { width: 240, height: 240 } } } },
    },
  ]
}

async function writeJson(filePath, data) {
  await fs.promises.writeFile(filePath, JSON.stringify(data))
}

async function writeVariantFiles(dir, elements, width, hasForm, name, variantId, weight, mainPageRef, pageMeta = {}) {
  await fs.promises.mkdir(dir, { recursive: true })
  await writeJson(path.join(dir, 'metadata.json'), variantMetadata(name, hasForm, variantId, weight, pageMeta))
  await writeJson(path.join(dir, 'settings.json'), variantSettings(width, hasForm, mainPageRef))
  await writeJson(path.join(dir, 'elements.json'), elements)
  await fs.promises.writeFile(path.join(dir, 'styles.json'), '')
  await writeJson(path.join(dir, 'javascripts.json'), { uuids: [] })
  await writeJson(path.join(dir, 'attachments.json'), {})
  await writeJson(path.join(dir, 'keywords.json'), {})
}

export async function packageToUnbounce(htmlFiles, imageFiles = [], pageName = 'Page') {
  if (!htmlFiles || htmlFiles.length === 0) throw new Error('At least one HTML file is required')

  // Build image map: filename → data URI
  const imageMap = new Map()
  for (const { name, data } of imageFiles) {
    const ext = path.extname(name)
    const mime = mimeForExt(ext)
    const b64 = data.toString('base64')
    imageMap.set(name, `data:${mime};base64,${b64}`)
    if (ext) imageMap.set(path.basename(name, ext), `data:${mime};base64,${b64}`)
  }

  const tmpId = crypto.randomUUID()
  const workDir = path.join(os.tmpdir(), `ubexport-${tmpId}`)
  const tarPath = path.join(os.tmpdir(), `ubexport-${tmpId}.unbounce`)

  const archiveId = newId()
  const pageId = newId()
  const pageRootDir = path.join(workDir, archiveId, 'pages', pageId)
  const sourceUuid = crypto.randomUUID()

  try {
    await fs.promises.mkdir(path.join(workDir, archiveId, 'assets'), { recursive: true })
    await fs.promises.mkdir(pageRootDir, { recursive: true })

    await writeJson(path.join(pageRootDir, 'metadata.json'), pageMetadata(pageName))
    await writeJson(path.join(pageRootDir, 'source.json'), { source_uuid: sourceUuid })

    for (let i = 0; i < Math.min(htmlFiles.length, 26); i++) {
      const variantId = VARIANT_LETTERS[i]
      const weight = i === 0 ? 100 : 0

      const subPageId = newId()
      const variantDir = path.join(pageRootDir, 'page_variants', variantId)
      const subPageRootDir = path.join(variantDir, 'sub_pages', subPageId)
      const subVariantDir = path.join(subPageRootDir, 'page_variants', variantId)

      let variantHtml = htmlFiles[i].html

      // Unwrap JSON-encoded templates before packaging — see note at top of file.
      if (hasJsonEncodedTemplate(variantHtml)) {
        variantHtml = (await unwrapJsonEncodedTemplate(variantHtml)) ?? variantHtml
      }

      if (imageMap.size > 0) variantHtml = inlineImages(variantHtml, imageMap)

      // Stash <ub:dynamic> tags before cheerio so they survive the parse/serialize cycle
      const ubDynamicStash = []
      const protectedHtml = variantHtml.replace(/<ub:dynamic\b[^>]*>[\s\S]*?<\/ub:dynamic>/g, (match) => {
        ubDynamicStash.push(match)
        return `UB_DYNAMIC_STASH_${ubDynamicStash.length - 1}_END`
      })

      const $ = cheerio.load(protectedHtml)
      const hasForm = transformForms($, variantId)
      const combinedCss = extractCss($)
      let bodyHtml = $('body').html() ?? protectedHtml

      // Restore stashed tags
      if (ubDynamicStash.length > 0) {
        bodyHtml = bodyHtml.replace(/UB_DYNAMIC_STASH_(\d+)_END/g, (_, idx) => ubDynamicStash[parseInt(idx)])
      }

      bodyHtml = stampBodyHtml(bodyHtml)

      const pageMeta = {
        title: $('title').first().text().trim(),
        description: $('meta[name="description"]').attr('content')?.trim() ?? '',
        keywords: $('meta[name="keywords"]').attr('content')?.trim() ?? '',
      }

      await fs.promises.mkdir(subVariantDir, { recursive: true })

      const variantName = htmlFiles.length === 1 ? 'Variant A' : `Variant ${variantId.toUpperCase()}`
      await writeVariantFiles(variantDir, mainElements(bodyHtml, combinedCss), 1440, hasForm, variantName, variantId, weight, undefined, pageMeta)

      await writeJson(path.join(subPageRootDir, 'metadata.json'), {
        name: 'Form Confirmation Page',
        used_as: 'form_confirmation',
        path_name: `${variantId}-form_confirmation.html`,
        champion_variant_id: variantId,
      })
      await writeVariantFiles(
        subVariantDir,
        confirmationElements(),
        512,
        false,
        'Confirmation',
        variantId,
        100,
        { uuid: sourceUuid, variant_id: variantId }
      )
    }

    await tar.create({ file: tarPath, cwd: workDir }, [archiveId])
    return await fs.promises.readFile(tarPath)
  } finally {
    await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {})
    await fs.promises.rm(tarPath, { force: true }).catch(() => {})
  }
}
