import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  classifyRef,
  isImageRefCandidate,
  isUnbounceHostedUrl,
  slugifyHint,
  deriveFilename,
  findImageRefs,
  rehostImages,
} from '../../src/image-rehost.js'

const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

// ── classifyRef ────────────────────────────────────────────────────────────────

test('classifyRef tags data:, http, //protocol-relative, and bare paths correctly', () => {
  assert.equal(classifyRef('data:image/png;base64,xxx'), 'data-uri')
  assert.equal(classifyRef('https://example.com/x.png'), 'external')
  assert.equal(classifyRef('http://example.com/x.png'), 'external')
  assert.equal(classifyRef('//cdn.example.com/x.png'), 'external')
  assert.equal(classifyRef('logo.png'), 'relative')
  assert.equal(classifyRef('images/logo.png'), 'relative')
  assert.equal(classifyRef('../assets/logo.png'), 'relative')
  assert.equal(classifyRef('/assets/logo.png'), 'relative')
})

// ── isImageRefCandidate ────────────────────────────────────────────────────────

test('isImageRefCandidate accepts data: image URIs and image-extension paths only', () => {
  assert.equal(isImageRefCandidate(PIXEL), true)
  assert.equal(isImageRefCandidate('logo.png'), true)
  assert.equal(isImageRefCandidate('images/hero.JPG'), true)
  assert.equal(isImageRefCandidate('//cdn.example.com/x.webp?v=2'), true)
  assert.equal(isImageRefCandidate('icon.svg'), true)

  // Non-image data URIs and extension-less endpoints are skipped — we don't
  // want to fetch arbitrary URLs just because they appear in src.
  assert.equal(isImageRefCandidate('data:application/font-woff2;base64,xxx'), false)
  assert.equal(isImageRefCandidate('https://example.com/api/profile/123'), false)
  assert.equal(isImageRefCandidate(''), false)
  assert.equal(isImageRefCandidate(null), false)
})

// ── isUnbounceHostedUrl ────────────────────────────────────────────────────────

test('isUnbounceHostedUrl skips every flavor of Unbounce-hosted URL', () => {
  assert.equal(isUnbounceHostedUrl('https://app.unbounce.com/publish/assets/uuid/x.png'), true)
  assert.equal(isUnbounceHostedUrl('https://image-service.unbounce.com/encoded'), true)
  assert.equal(isUnbounceHostedUrl('//image-service.unbounce.com/encoded'), true)
  assert.equal(isUnbounceHostedUrl('http://app.unbounce.com/whatever'), true)
  assert.equal(isUnbounceHostedUrl('https://example.com/x.png'), false)
  assert.equal(isUnbounceHostedUrl('logo.png'), false)
})

// ── slugifyHint ───────────────────────────────────────────────────────────────

test('slugifyHint normalizes alt text, css selectors, etc. into safe filename slugs', () => {
  assert.equal(slugifyHint('Company Logo'), 'company-logo')
  assert.equal(slugifyHint('  Hero Image  '), 'hero-image')
  assert.equal(slugifyHint('.hero-banner'), 'hero-banner')
  assert.equal(slugifyHint('Café Owners — 2026!'), 'caf-owners-2026')
  assert.equal(slugifyHint(''), '')
  assert.equal(slugifyHint(null), '')
})

test('slugifyHint truncates very long hints to keep filenames readable', () => {
  const long = 'a'.repeat(100)
  const out = slugifyHint(long)
  assert.equal(out.length, 40)
})

// ── deriveFilename ────────────────────────────────────────────────────────────

test('deriveFilename uses slug + short-hash + ext when hint is provided', () => {
  assert.equal(
    deriveFilename({ hint: 'Company Logo', hash: 'abcdef0123456789', mimeType: 'image/png' }),
    'company-logo-abcdef01.png'
  )
  assert.equal(
    deriveFilename({ hint: '.hero-bg', hash: 'deadbeef00', mimeType: 'image/jpeg' }),
    'hero-bg-deadbeef.jpg'
  )
})

test('deriveFilename falls back to inline-<hash>.<ext> when hint is empty', () => {
  assert.equal(
    deriveFilename({ hint: '', hash: 'abcdef0123', mimeType: 'image/svg+xml' }),
    'inline-abcdef01.svg'
  )
  assert.equal(
    deriveFilename({ hash: 'deadbeef0000', mimeType: 'image/webp' }),
    'inline-deadbeef.webp'  // first 8 hex chars
  )
})

// ── findImageRefs ─────────────────────────────────────────────────────────────

test('findImageRefs extracts <img> refs with alt as the hint', () => {
  const html = `<img src="logo.png" alt="Company Logo" />`
  const refs = findImageRefs(html)
  assert.equal(refs.length, 1)
  assert.equal(refs[0].raw, 'logo.png')
  assert.equal(refs[0].hint, 'Company Logo')
  assert.equal(refs[0].source, 'img')
  assert.equal(refs[0].type, 'relative')
})

test('findImageRefs prefers alt → data-name → first class for the hint', () => {
  assert.equal(
    findImageRefs(`<img src="x.png" data-name="Hero Photo" class="hero-pic" />`)[0].hint,
    'Hero Photo'
  )
  assert.equal(
    findImageRefs(`<img src="x.png" class="hero-pic accent" />`)[0].hint,
    'hero-pic'
  )
  assert.equal(
    findImageRefs(`<img src="x.png" />`)[0].hint,
    null
  )
})

test('findImageRefs skips <img> tags without an image-extension src and no data URI', () => {
  const refs = findImageRefs(`<img src="https://example.com/api/dynamic" alt="x" />`)
  assert.equal(refs.length, 0)
})

test('findImageRefs extracts CSS url() refs with a selector-derived hint', () => {
  const css = `
    .hero-banner { background-image: url("hero.jpg"); }
    #section-2, .promo { background: url(promo.png) center; }
  `
  const refs = findImageRefs(css)
  assert.equal(refs.length, 2)
  assert.equal(refs[0].raw, 'hero.jpg')
  assert.equal(refs[0].hint, 'hero-banner-bg')
  assert.equal(refs[0].source, 'css')
  // Comma-separated selectors → take the LAST one for the hint.
  assert.equal(refs[1].raw, 'promo.png')
  assert.equal(refs[1].hint, 'promo-bg')
})

test('findImageRefs treats data URIs the same as any other img src', () => {
  const html = `<img src="${PIXEL}" alt="pixel placeholder">`
  const refs = findImageRefs(html)
  assert.equal(refs.length, 1)
  assert.equal(refs[0].type, 'data-uri')
  assert.equal(refs[0].hint, 'pixel placeholder')
})

test('findImageRefs collects ALL occurrences (no dedup at this layer)', () => {
  const html = `
    <img src="logo.png" alt="Logo" />
    <img src="logo.png" alt="Logo" />
    <style>.bg { background: url(logo.png); }</style>
  `
  const refs = findImageRefs(html)
  assert.equal(refs.length, 3, 'three occurrences regardless of identical raw values')
})

// ── rehostImages (orchestrator with a mock uploader) ──────────────────────────

test('rehostImages: data URIs only by default — relative refs untouched without baseDir', async () => {
  const html = `<img src="${PIXEL}" alt="hero"><img src="logo.png" alt="logo">`
  const { text, uploaded } = await rehostImages(html, {
    uploadFn: async ({ filename }) => ({ cdn_url: `https://cdn.example/${filename}` }),
  })
  assert.equal(uploaded.length, 1, 'only the data URI got uploaded')
  assert.match(text, /logo\.png/, 'relative ref is preserved as-is')
  assert.doesNotMatch(text, /data:image\//, 'data URI was rehosted away')
})

test('rehostImages: relative refs resolve against baseDir and replace cleanly', async () => {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'rehost-test-'))
  try {
    await fs.promises.mkdir(path.join(tmp, 'images'))
    const logoBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')
    await fs.promises.writeFile(path.join(tmp, 'logo.png'), logoBytes)
    await fs.promises.writeFile(path.join(tmp, 'images', 'hero.png'), logoBytes)

    const html = `<img src="logo.png" alt="Brand Logo"><img src="images/hero.png" alt="Hero">`
    const calls = []
    const { text, uploaded, errors } = await rehostImages(html, {
      baseDir: tmp,
      uploadFn: async (payload) => {
        calls.push(payload.filename)
        return { cdn_url: `https://cdn.example/${payload.filename}` }
      },
    })
    assert.equal(errors.length, 0)
    // Same bytes deduped → one upload.
    assert.equal(uploaded.length, 1)
    // Filename uses the alt text from one of the two img tags.
    assert.match(calls[0], /^(brand-logo|hero)-[a-f0-9]{8}\.png$/)
    // Both img refs swapped for the same CDN URL.
    assert.doesNotMatch(text, /logo\.png|images\/hero\.png/)
    const cdnRefs = text.match(/https:\/\/cdn\.example\/[a-z-]+-[a-f0-9]{8}\.png/g) || []
    assert.equal(cdnRefs.length, 2)
    assert.equal(new Set(cdnRefs).size, 1, 'both refs swap to the SAME url since bytes match')
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true })
  }
})

test('rehostImages: external URLs are passed through unless rehostExternal:true', async () => {
  const html = `<img src="https://example.com/x.png" alt="External">`
  const noOp = await rehostImages(html, {
    uploadFn: async () => { throw new Error('uploader should not be called') },
  })
  assert.equal(noOp.text, html, 'external URLs are not touched by default')
  assert.equal(noOp.uploaded.length, 0)
})

test('rehostImages: rehostExternal:true fetches and uploads, skipping unbounce.com URLs', async () => {
  const fetched = []
  const fakeFetch = async (url) => {
    fetched.push(url)
    return {
      ok: true,
      headers: new Map([['content-type', 'image/png']]),
      arrayBuffer: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer,
    }
  }
  // Patch the Map.get for `headers` since real fetch returns Headers; our
  // helper does headers.get('content-type'). Map already supports .get.

  const html = `
    <img src="https://example.com/x.png" alt="External A">
    <img src="https://app.unbounce.com/publish/assets/uuid/y.png" alt="Already Hosted">
  `
  const { text, uploaded, errors } = await rehostImages(html, {
    fetchFn: fakeFetch,
    rehostExternal: true,
    uploadFn: async ({ filename }) => ({ cdn_url: `https://cdn.example/${filename}` }),
  })
  assert.equal(errors.length, 0)
  assert.equal(fetched.length, 1, 'only the non-unbounce URL was fetched')
  assert.equal(fetched[0], 'https://example.com/x.png')
  assert.equal(uploaded.length, 1)
  // Unbounce-hosted URL untouched, external URL replaced.
  assert.match(text, /https:\/\/app\.unbounce\.com\/publish\/assets\/uuid\/y\.png/)
  assert.doesNotMatch(text, /https:\/\/example\.com/)
})

test('rehostImages: per-ref errors stay in place; other refs still succeed', async () => {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'rehost-test-'))
  try {
    await fs.promises.writeFile(path.join(tmp, 'real.png'), Buffer.from('fake-png-bytes'))

    const html = `<img src="real.png" alt="Real"><img src="missing.png" alt="Missing">`
    const { text, uploaded, errors } = await rehostImages(html, {
      baseDir: tmp,
      uploadFn: async ({ filename }) => ({ cdn_url: `https://cdn.example/${filename}` }),
    })
    assert.equal(uploaded.length, 1, 'real.png succeeded')
    assert.equal(errors.length, 1, 'missing.png failed')
    assert.match(errors[0].ref, /missing\.png/)
    assert.match(text, /https:\/\/cdn\.example\//, 'real.png replaced')
    assert.match(text, /missing\.png/, 'missing.png left in place')
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true })
  }
})
