/**
 * Unified image-reference scanner + rehoster.
 *
 * Scans raw HTML / CSS for every kind of image reference we care about:
 *   1. data: URIs                       — always rehosted (default on)
 *   2. relative paths (logo.png,        — resolved against a base directory,
 *      images/x.jpg, ../assets/y.png)     read from disk, uploaded
 *   3. external http(s) URLs            — fetched + uploaded (opt-in)
 * And SKIPS Unbounce-hosted URLs so we never re-rehost our own assets.
 *
 * Each reference's surrounding context (img alt / class / data-name, or the
 * CSS selector wrapping a url(...)) is extracted and used to derive a nicer
 * filename when uploading — no more inline-{hash}.png in your asset library.
 *
 * Dedupe is by SHA-256 of the decoded payload: the same image referenced N
 * times anywhere in the text uploads exactly once.
 */

import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { parseDataUrl } from './asset-upload.js'

// Image extensions we'll consider for non-data-URI refs. Conservative on
// purpose: an <img src="/profile/123"> with no extension is left alone, since
// fetching opaque endpoints could surprise users.
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|avif)(?:[?#]|$)/i

const MIME_EXT = Object.freeze({
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/avif': 'avif',
})

// Catches every <img ...> tag (open or self-closing). We then pull src/alt/etc.
// out of the tag string with sub-regexes — robust enough for ordinary HTML
// and avoids the edge cases of "everything in one giant regex".
const IMG_TAG_RE = /<img\b[^>]*?>/gi
// Matches CSS url(...) — supports unquoted, single-quoted, double-quoted.
const CSS_URL_RE = /url\(\s*(?:["']([^"']+)["']|([^"'\s)]+))\s*\)/gi
// Matches a <style ...>...</style> block with its inner contents in group 1.
const STYLE_BLOCK_RE = /<style\b[^>]*>([\s\S]*?)<\/style>/gi

/**
 * Classify a raw image reference string.
 * @param {string} ref
 * @returns {'data-uri' | 'external' | 'relative'}
 */
export function classifyRef(ref) {
  if (typeof ref !== 'string' || !ref) return 'relative'
  if (ref.startsWith('data:')) return 'data-uri'
  if (/^https?:\/\//i.test(ref) || ref.startsWith('//')) return 'external'
  return 'relative'
}

/**
 * True if this ref looks like an image we'd want to rehost. Data URIs always
 * count; non-data refs need an image-y extension to be considered.
 */
export function isImageRefCandidate(ref) {
  if (typeof ref !== 'string' || !ref) return false
  if (ref.startsWith('data:image/')) return true
  return IMAGE_EXT_RE.test(ref)
}

/**
 * Detect URLs that are already hosted on Unbounce so we never re-rehost our
 * own assets. Conservative: any *.unbounce.com host counts.
 */
export function isUnbounceHostedUrl(url) {
  if (typeof url !== 'string' || !url) return false
  return /^(?:https?:)?\/\/[^/]*\bunbounce\.com\//i.test(url)
}

/**
 * Slugify an arbitrary hint (alt text, CSS selector, etc.) into a filename-
 * safe lowercase chunk. Limited to 40 chars to keep filenames readable.
 */
export function slugifyHint(hint) {
  if (!hint || typeof hint !== 'string') return ''
  return hint
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

/**
 * Build a filename for the asset library. Format: <slug>-<hashShort>.<ext>
 * Falls back to <fallbackBase>-<hashShort>.<ext> when no useful hint exists.
 *
 * The hash suffix keeps deterministic dedup-equivalent files in sync across
 * deploys; the slug prefix is what humans see when scanning the asset UI.
 */
export function deriveFilename({ hint, hash, mimeType, fallbackBase = 'inline' }) {
  const ext = MIME_EXT[mimeType?.toLowerCase()] || 'bin'
  const shortHash = String(hash || '').slice(0, 8) || 'x'.repeat(8)
  const slug = slugifyHint(hint)
  return slug
    ? `${slug}-${shortHash}.${ext}`
    : `${fallbackBase}-${shortHash}.${ext}`
}

/**
 * Best-effort hint extractor for an <img> tag. Tries alt → data-name →
 * first class. Returns null when nothing useful is present.
 */
function hintFromImgTag(tag) {
  const alt = tag.match(/\salt=["']([^"']*)["']/i)?.[1]?.trim()
  if (alt) return alt
  const dataName = tag.match(/\sdata-name=["']([^"']*)["']/i)?.[1]?.trim()
  if (dataName) return dataName
  const cls = tag.match(/\sclass=["']([^"']*)["']/i)?.[1]?.trim()
  if (cls) return cls.split(/\s+/)[0]  // first class only — usually the most specific
  return null
}

/**
 * Find the CSS selector that owns the rule containing `position` in CSS text.
 *
 * IMPORTANT: pass *just the CSS text* — not whole HTML. When CSS lives inside
 * <style> blocks, callers should slice out the block contents first, otherwise
 * the selector scan will walk back past the `<style>` opening into HTML text
 * and emit nonsense slugs like "doctype-html-html-head-style-banner".
 *
 * Walks backwards from position to find the matching open brace (respecting
 * nested at-rule braces), then back past whitespace to the selector itself,
 * stopping at the previous rule terminator (`}` or `;`).
 */
function selectorForCssPosition(cssText, position) {
  // Walk back to the open brace that contains `position`, accounting for
  // nested rules (e.g. @media wraps).
  let depth = 0
  let openBrace = -1
  for (let i = Math.min(position, cssText.length - 1); i >= 0; i--) {
    const c = cssText[i]
    if (c === '}') depth++
    else if (c === '{') {
      if (depth === 0) { openBrace = i; break }
      depth--
    }
  }
  if (openBrace === -1) return null

  // Walk back past whitespace before the brace, then back to the selector start.
  let selEnd = openBrace
  while (selEnd > 0 && /\s/.test(cssText[selEnd - 1])) selEnd--
  let selStart = selEnd
  while (selStart > 0) {
    const c = cssText[selStart - 1]
    // Selector ends at the previous rule's `}`, an at-rule `;`, or text start.
    if (c === '}' || c === ';') break
    selStart--
  }
  const chunk = cssText.slice(selStart, selEnd).trim()
  if (!chunk || chunk.startsWith('@')) return null
  return chunk.split(',').pop().trim()
}

/**
 * Convert a CSS selector chunk into a filename hint: drop the leading `.`
 * or `#`, append `-bg` to differentiate from <img> refs that might share
 * the same class name.
 */
function hintFromCssSelector(selector) {
  if (!selector) return null
  const base = selector.replace(/^\./, '').replace(/^#/, '').trim()
  return base ? `${base}-bg` : null
}

/**
 * Scan text for every image reference and return one entry per occurrence
 * (no dedup here — caller's responsibility). Each entry carries its raw ref
 * string, classified type, and a context-derived hint for filename naming.
 *
 * Handles three input shapes:
 *   - HTML containing <style> blocks: scan each block independently for
 *     CSS url() so selector derivation works correctly. <img> tags scanned
 *     across the whole document.
 *   - Raw CSS (no <style> blocks): scan the entire input as CSS.
 *   - HTML with no <style> blocks: <img> tags only; inline style="" CSS
 *     url()s are caught but get null hints (no selector available).
 *
 * @returns {Array<{ raw: string, type: ReturnType<typeof classifyRef>, hint: string|null, source: 'img' | 'css' }>}
 */
export function findImageRefs(text) {
  if (typeof text !== 'string' || !text) return []
  const refs = []
  const isHtml = /<\w+/.test(text)

  // <img> tags (HTML only)
  if (isHtml) {
    for (const m of text.matchAll(IMG_TAG_RE)) {
      const tag = m[0]
      const src = tag.match(/\ssrc=["']([^"']+)["']/i)?.[1]
      if (!src || !isImageRefCandidate(src)) continue
      refs.push({
        raw: src,
        type: classifyRef(src),
        hint: hintFromImgTag(tag),
        source: 'img',
      })
    }
  }

  // CSS url() — scan inside <style> blocks (so selector derivation has the
  // right context), then catch any url()s outside style blocks (inline
  // style="..." attributes, etc.) without selector context.
  if (isHtml) {
    const styleRanges = []
    for (const sm of text.matchAll(STYLE_BLOCK_RE)) {
      const cssText = sm[1]
      const blockStart = sm.index
      const blockEnd = sm.index + sm[0].length
      styleRanges.push([blockStart, blockEnd])
      for (const um of cssText.matchAll(CSS_URL_RE)) {
        const ref = um[1] ?? um[2]
        if (!ref || !isImageRefCandidate(ref)) continue
        const selector = selectorForCssPosition(cssText, um.index ?? 0)
        refs.push({
          raw: ref,
          type: classifyRef(ref),
          hint: hintFromCssSelector(selector),
          source: 'css',
        })
      }
    }
    // url()s OUTSIDE any <style> block — likely inline style="..." attrs.
    // No reliable selector, so no hint; the URL still gets rehosted.
    for (const um of text.matchAll(CSS_URL_RE)) {
      const inStyle = styleRanges.some(([s, e]) => um.index >= s && um.index < e)
      if (inStyle) continue
      const ref = um[1] ?? um[2]
      if (!ref || !isImageRefCandidate(ref)) continue
      refs.push({ raw: ref, type: classifyRef(ref), hint: null, source: 'css' })
    }
  } else {
    // Raw CSS — treat the whole input as CSS.
    for (const um of text.matchAll(CSS_URL_RE)) {
      const ref = um[1] ?? um[2]
      if (!ref || !isImageRefCandidate(ref)) continue
      const selector = selectorForCssPosition(text, um.index ?? 0)
      refs.push({
        raw: ref,
        type: classifyRef(ref),
        hint: hintFromCssSelector(selector),
        source: 'css',
      })
    }
  }

  return refs
}

/**
 * Resolve a single ref to its bytes + MIME type.
 *
 * @param {{ raw: string, type: string }} ref
 * @param {{ baseDir?: string, fetchFn?: typeof fetch }} opts
 * @returns {Promise<{ buffer: Buffer, mimeType: string }>}
 */
async function resolveRefToBytes(ref, { baseDir, fetchFn = globalThis.fetch }) {
  if (ref.type === 'data-uri') {
    return parseDataUrl(ref.raw)
  }
  if (ref.type === 'relative') {
    if (!baseDir) throw new Error(`No baseDir for relative ref "${ref.raw}"`)
    // Strip leading "/" so root-relative refs ("/assets/x.png") resolve against
    // baseDir the same way "assets/x.png" does — the Unbounce-served page has
    // no notion of a project root.
    const rel = ref.raw.replace(/^\//, '')
    const abs = path.resolve(baseDir, rel)
    const buffer = await fs.promises.readFile(abs)
    const mimeType = mimeFromExt(abs)
    return { buffer, mimeType }
  }
  if (ref.type === 'external') {
    const url = ref.raw.startsWith('//') ? `https:${ref.raw}` : ref.raw
    const res = await fetchFn(url)
    if (!res.ok) throw new Error(`fetch ${url} → HTTP ${res.status}`)
    const buffer = Buffer.from(await res.arrayBuffer())
    const mimeType = res.headers.get('content-type')?.split(';')[0]?.trim() || mimeFromExt(url)
    return { buffer, mimeType }
  }
  throw new Error(`Unknown ref type: ${ref.type}`)
}

function mimeFromExt(filename) {
  const ext = (filename.match(/\.([^.?#]+)(?:[?#]|$)/i) || [])[1]?.toLowerCase()
  for (const [mime, mappedExt] of Object.entries(MIME_EXT)) {
    if (mappedExt === ext) return mime
  }
  return 'application/octet-stream'
}

/**
 * Main orchestrator. Scans text for image refs of enabled types, resolves
 * each to bytes, dedupes by SHA-256, uploads each unique payload via
 * uploadFn (which receives a derived filename), and replaces every
 * occurrence of every contributing ref with the resulting CDN URL.
 *
 * Per-ref errors don't fail the whole call — the failing ref is left in
 * place and recorded in the returned `errors` list.
 *
 * @param {string} text
 * @param {object} opts
 * @param {string} [opts.baseDir]              required for resolveRelative
 * @param {(arg: { buffer: Buffer, mimeType: string, filename: string, hash: string }) => Promise<{ cdn_url: string }>} opts.uploadFn
 * @param {typeof fetch} [opts.fetchFn]
 * @param {boolean} [opts.resolveDataUris=true]
 * @param {boolean} [opts.resolveRelative=true]
 * @param {boolean} [opts.rehostExternal=false]
 * @returns {Promise<{ text: string, uploaded: Array<object>, errors: Array<{ ref?: string, hash?: string, message: string }> }>}
 */
export async function rehostImages(text, {
  baseDir = null,
  uploadFn,
  fetchFn = globalThis.fetch,
  resolveDataUris = true,
  resolveRelative = true,
  rehostExternal = false,
} = {}) {
  if (!text) return { text, uploaded: [], errors: [] }
  if (typeof uploadFn !== 'function') throw new Error('rehostImages: uploadFn is required')

  const refs = findImageRefs(text)
  if (refs.length === 0) return { text, uploaded: [], errors: [] }

  const errors = []

  // Pick the refs we'll actually try to handle this call.
  const selected = refs.filter(ref => {
    if (ref.type === 'data-uri') return resolveDataUris
    if (ref.type === 'relative') return resolveRelative && !!baseDir
    if (ref.type === 'external') return rehostExternal && !isUnbounceHostedUrl(ref.raw)
    return false
  })
  if (selected.length === 0) return { text, uploaded: [], errors: [] }

  // Resolve each to bytes (in parallel — fetches and disk reads dominate).
  const resolved = await Promise.all(selected.map(async (ref) => {
    try {
      const data = await resolveRefToBytes(ref, { baseDir, fetchFn })
      return { ref, data }
    } catch (err) {
      errors.push({ ref: ref.raw, type: ref.type, message: err.message ?? String(err) })
      return null
    }
  }))

  // Group by SHA-256 — multiple refs to the same bytes upload once.
  const groups = new Map()
  for (const item of resolved) {
    if (!item) continue
    const { ref, data } = item
    const hash = createHash('sha256').update(data.buffer).digest('hex')
    if (!groups.has(hash)) {
      groups.set(hash, {
        hash,
        buffer: data.buffer,
        mimeType: data.mimeType,
        bestHint: ref.hint,
        refs: [ref],
      })
    } else {
      const g = groups.get(hash)
      g.refs.push(ref)
      // Prefer longer hints (more descriptive), but never drop a hint we have for nothing.
      if (ref.hint && (!g.bestHint || ref.hint.length > g.bestHint.length)) {
        g.bestHint = ref.hint
      }
    }
  }

  // Upload each unique payload.
  const uploaded = []
  for (const group of groups.values()) {
    try {
      const filename = deriveFilename({ hint: group.bestHint, hash: group.hash, mimeType: group.mimeType })
      const result = await uploadFn({ buffer: group.buffer, mimeType: group.mimeType, filename, hash: group.hash })
      group.cdn_url = result.cdn_url
      uploaded.push({
        ...result,
        hash: group.hash,
        filename,
        occurrences: group.refs.length,
        sources: group.refs.map(r => r.type),
      })
    } catch (err) {
      errors.push({ hash: group.hash, message: err.message ?? String(err) })
    }
  }

  // Replace every contributing raw ref with its CDN URL.
  let outText = text
  for (const group of groups.values()) {
    if (!group.cdn_url) continue
    const distinctRaw = new Set(group.refs.map(r => r.raw))
    for (const raw of distinctRaw) {
      outText = outText.split(raw).join(group.cdn_url)
    }
  }

  // Integrity guard: data: URIs are the always-rehosted category. If any
  // survived the swap when we were asked to handle them, something between
  // upload and substitution dropped the CDN URL — most likely the upload
  // response parser threw, the catch above recorded an error, and the
  // group's cdn_url was never set. Without this guard the deploy "succeeds"
  // with broken images embedded in the published HTML. Fail loudly so the
  // agent retries instead.
  if (resolveDataUris && /data:image\/[a-z0-9.+-]+;base64,/i.test(outText)) {
    const summary = errors.length
      ? errors.map(e => `${e.ref ? `ref ${String(e.ref).slice(0, 60)}` : `hash ${e.hash}`}: ${e.message}`).join('; ')
      : '(no errors captured)'
    throw new Error(
      `Image rehost left data: URI(s) in the output (${errors.length} upload/parse error(s)). ` +
      `Asset(s) may have uploaded but their CDN URLs were not substituted. ` +
      `Errors: ${summary}`
    )
  }

  return { text: outText, uploaded, errors }
}
