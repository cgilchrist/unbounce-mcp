/**
 * Scan raw HTML / CSS for embedded data: URIs, upload each unique payload
 * to Unbounce's asset library, and replace every occurrence with the
 * resulting CDN URL.
 *
 * The data URI grammar is unambiguous on its own (data:<mime>;base64,...),
 * so we match against the raw string instead of parsing HTML — this catches
 * URIs in <img src>, <source src>, srcset, CSS background-image: url(...),
 * inline style="...", external <link href> with embedded data URIs, etc.
 *
 * Dedupes via SHA-256 of the decoded payload: the same image embedded in
 * multiple <img> tags uploads exactly once. Per-image upload failures
 * leave that data URI in place rather than failing the whole transcode —
 * caller gets a list of errors back so they can surface them.
 */

import { createHash } from 'node:crypto'
import { parseDataUrl } from './asset-upload.js'

// Anchored on the unambiguous "data:<mime>;base64," prefix. Captures everything
// up to the next character that can't appear in base64. Image MIMEs only —
// we deliberately don't transcode font/woff/etc data URIs.
export const DATA_URI_RE = /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi

/**
 * Find every data URI occurrence in `text`. Returns matches in source order
 * INCLUDING duplicates — the same data URI appearing 5 times yields 5 entries.
 * Dedup is groupByHash's job; this lets callers count actual occurrences.
 */
export function findDataUris(text) {
  if (typeof text !== 'string' || !text) return []
  return Array.from(text.matchAll(DATA_URI_RE), m => m[0])
}

/**
 * Group data URIs by SHA-256 of their decoded payload. Multiple textually-
 * different URIs with the same decoded bytes (rare but possible — different
 * MIME aliases like image/jpg vs image/jpeg) collapse into one group.
 *
 * @param {string[]} uris
 * @returns {Map<string, { hash: string, uris: string[], buffer: Buffer, mimeType: string }>}
 */
export function groupByHash(uris) {
  const groups = new Map()
  for (const uri of uris) {
    let decoded
    try { decoded = parseDataUrl(uri) } catch { continue }
    const hash = createHash('sha256').update(decoded.buffer).digest('hex')
    if (groups.has(hash)) {
      groups.get(hash).uris.push(uri)
    } else {
      groups.set(hash, { hash, uris: [uri], buffer: decoded.buffer, mimeType: decoded.mimeType })
    }
  }
  return groups
}

/**
 * Transcode every data URI in `text` to its uploaded CDN URL.
 *
 * @param {string} text
 * @param {(arg: { buffer: Buffer, mimeType: string, hash: string }) => Promise<{ cdn_url: string }>} uploadFn
 *   Caller-provided uploader. Receives buffer + mime + hash; should return
 *   the upload result (we only read .cdn_url). Errors are caught and logged
 *   per-image; the failing data URI stays in place.
 * @returns {Promise<{ text: string, uploaded: Array<object>, errors: Array<{ hash: string, message: string }> }>}
 */
export async function transcodeDataUris(text, uploadFn) {
  const uris = findDataUris(text)
  if (uris.length === 0) return { text, uploaded: [], errors: [] }

  const groups = groupByHash(uris)
  if (groups.size === 0) return { text, uploaded: [], errors: [] }

  const uploaded = []
  const errors = []
  // Sequential uploads — keeps Unbounce happy and ordering deterministic for
  // tests. Most pages have <= 5 images; speed of a parallel pool isn't worth
  // the rate-limit risk against /assets at this scale.
  for (const group of groups.values()) {
    try {
      const result = await uploadFn({ buffer: group.buffer, mimeType: group.mimeType, hash: group.hash })
      group.cdn_url = result.cdn_url
      uploaded.push({ ...result, hash: group.hash, occurrences: group.uris.length })
    } catch (err) {
      errors.push({ hash: group.hash, message: err.message ?? String(err) })
    }
  }

  let outText = text
  for (const group of groups.values()) {
    if (!group.cdn_url) continue
    for (const uri of group.uris) {
      outText = outText.split(uri).join(group.cdn_url)
    }
  }

  return { text: outText, uploaded, errors }
}
