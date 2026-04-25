/**
 * Pure helpers for the upload_image tool.
 *
 * The Unbounce asset upload endpoint (POST /{sub_account_id}/assets)
 * returns an HTML page with a <script> that calls
 * window.parent.editor.activeAssetUploader.assetUploaded({...}) — the
 * editor uses this for in-builder asset library updates. We only need
 * the asset metadata, so we extract it via regex.
 *
 * Once an asset is uploaded, the publicly-readable URL takes the form
 *   https://image-service.unbounce.com/<encoded-public-publish-url>
 * where the inner URL is https://app.unbounce.com/publish/assets/{uuid}/{name}.
 * That's the URL agents should use as <img src> — not the
 * /assets/{uuid}/{name} variant that surfaces inside the builder JSON
 * (those are PRIVATE paths and 404 on published pages).
 */

/**
 * Parse the asset metadata out of the upload response HTML.
 *
 * Throws if the expected JS object literal isn't present.
 *
 * @param {string} html - body of the assets POST response
 * @returns {{ id: string, uuid: string, name: string, contentFileSize: number, contentContentType: string }}
 */
export function parseAssetUploadResponse(html) {
  if (!html || typeof html !== 'string') {
    throw new Error('Upload response was empty')
  }
  const match = html.match(/assetUploaded\s*\(\s*\{([\s\S]*?)\}\s*\)/)
  if (!match) {
    throw new Error(`Could not find assetUploaded(...) call in upload response`)
  }
  const body = match[1]

  // Tolerant of both single- and double-quoted string values — Unbounce's
  // response template uses single quotes today, but we don't want a future
  // shape change to silently break rehost (it does — the asset still uploads
  // server-side, but the parser throws, the caller catches, and the data:
  // URI is left in the deployed HTML).
  const str = (key) => {
    const m = body.match(new RegExp(`\\b${key}\\s*:\\s*(?:'([^']*)'|"((?:[^"\\\\]|\\\\.)*)")`))
    return m ? (m[1] ?? m[2]) : null
  }
  const num = (key) => {
    const m = body.match(new RegExp(`\\b${key}\\s*:\\s*(-?\\d+)`))
    return m ? Number(m[1]) : null
  }

  const uuid = str('uuid')
  const id = str('id')
  const name = str('name') ?? str('content_file_name')
  if (!uuid || !id || !name) {
    throw new Error(`Asset upload response missing required fields (uuid/id/name)`)
  }

  return {
    id,
    uuid,
    name,
    contentFileSize: num('content_file_size') ?? 0,
    contentContentType: str('content_content_type') ?? 'application/octet-stream',
  }
}

/**
 * Build the public origin URL for an uploaded asset, in the form
 *   https://app.unbounce.com/publish/assets/{uuid}/{filename}
 *
 * That URL is stable, requires no auth, and serves the image for a fresh
 * upload immediately (verified). Unbounce's published pages additionally
 * wrap this through image-service.unbounce.com for CDN caching and on-the-
 * fly transforms — but the wrapped form returns 403 for assets not yet
 * referenced in a published page, so the agent should put the bare URL
 * here in <img src> and let Unbounce's publish pipeline rewrite it if it
 * wants. Either form resolves to the same image bytes.
 *
 * @param {string} uuid - asset uuid from the upload response
 * @param {string} name - filename from the upload response (e.g. "hero.jpg")
 * @returns {string}
 */
export function buildCdnUrl(uuid, name) {
  if (!uuid) throw new Error('uuid is required')
  if (!name) throw new Error('name is required')
  // Spaces and other unsafe URL chars need encoding inside the path segment;
  // encodeURIComponent on the filename keeps the path structure intact.
  return `https://app.unbounce.com/publish/assets/${uuid}/${encodeURIComponent(name)}`
}

/**
 * Decode a data: URL into a binary Buffer + metadata.
 * Supports the "data:<mime>;base64,<payload>" form (the only form Unbounce
 * pages produce). Non-base64 data URIs are rejected.
 *
 * @param {string} dataUrl
 * @returns {{ buffer: Buffer, mimeType: string }}
 */
export function parseDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') throw new Error('image_data_url must be a string')
  const match = dataUrl.match(/^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i)
  if (!match) {
    throw new Error('image_data_url must be a base64-encoded data URL (data:<mime>;base64,<payload>)')
  }
  return {
    mimeType: match[1].toLowerCase(),
    buffer: Buffer.from(match[2], 'base64'),
  }
}

/**
 * Pick a sensible filename + mime type for the upload, given whatever shape
 * of input the caller gave us.
 *
 * @param {object} opts
 * @param {string} [opts.filename]   explicit override
 * @param {string} [opts.filePath]   used for filename + extension fallback
 * @param {string} [opts.mimeType]   sniffed earlier (data URL / Content-Type)
 * @returns {{ filename: string, mimeType: string }}
 */
export function resolveUploadFilename({ filename, filePath, mimeType } = {}) {
  if (filename) {
    return { filename, mimeType: mimeType || mimeFromExt(filename) }
  }
  if (filePath) {
    const base = filePath.split(/[\\/]/).pop() || 'image'
    return { filename: base, mimeType: mimeType || mimeFromExt(base) }
  }
  // Pure data-URL upload with no filename hint — synthesize one from mime.
  const ext = extFromMime(mimeType)
  return { filename: `image-${Date.now()}.${ext}`, mimeType: mimeType || 'application/octet-stream' }
}

const EXT_TO_MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
}

const MIME_TO_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
}

function mimeFromExt(filename) {
  const ext = (filename.match(/\.([^.]+)$/) || [])[1]?.toLowerCase()
  return EXT_TO_MIME[ext] || 'application/octet-stream'
}

function extFromMime(mime) {
  return MIME_TO_EXT[(mime || '').toLowerCase()] || 'bin'
}
