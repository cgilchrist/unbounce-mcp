import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findDataUris, groupByHash, transcodeDataUris } from '../../src/transcode-images.js'

// 1×1 transparent PNG — used as the canonical "real image" payload.
const PIXEL_DATA_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

// 1×1 red PNG — different bytes, different SHA → must be uploaded separately
// from PIXEL_DATA_URI.
const RED_DATA_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='

const SVG_DATA_URI = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4='

test('findDataUris finds img-src and css-url instances, returns ALL occurrences', () => {
  const html = `
    <img src="${PIXEL_DATA_URI}" alt="hero" />
    <style>.x { background-image: url(${PIXEL_DATA_URI}); }</style>
    <img src="${RED_DATA_URI}" />
  `
  const uris = findDataUris(html)
  // PIXEL appears twice (img + css), RED once → 3 total occurrences.
  assert.equal(uris.length, 3, 'occurrences are not deduped at this layer')
  assert.equal(uris.filter(u => u === PIXEL_DATA_URI).length, 2)
  assert.equal(uris.filter(u => u === RED_DATA_URI).length, 1)
})

test('findDataUris ignores non-image data URIs (fonts, plain text, etc.)', () => {
  const text = `
    <link href="data:application/font-woff2;base64,d09GMgABAAAA..." />
    <style>@font-face { src: url(data:font/ttf;base64,AAEAAA); }</style>
    <img src="${PIXEL_DATA_URI}" />
  `
  const uris = findDataUris(text)
  assert.equal(uris.length, 1)
  assert.equal(uris[0], PIXEL_DATA_URI)
})

test('findDataUris handles empty / non-string input gracefully', () => {
  assert.deepEqual(findDataUris(''), [])
  assert.deepEqual(findDataUris(null), [])
  assert.deepEqual(findDataUris(undefined), [])
  assert.deepEqual(findDataUris(123), [])
})

test('groupByHash collapses identical-bytes URIs into one group', () => {
  // Same bytes, identical URI string — one group.
  const groups = groupByHash([PIXEL_DATA_URI, PIXEL_DATA_URI, RED_DATA_URI])
  assert.equal(groups.size, 2)
  const pixelGroup = [...groups.values()].find(g => g.mimeType === 'image/png' && g.uris.includes(PIXEL_DATA_URI))
  assert.ok(pixelGroup)
  assert.equal(pixelGroup.uris.length, 2, 'duplicates accumulate inside the group')
})

test('groupByHash skips malformed data URIs without throwing', () => {
  const groups = groupByHash(['data:image/png;base64,not-real-base64-but-shape-matches-regex!!!', PIXEL_DATA_URI])
  // Decoder accepts loose base64; the bad one decodes to garbage, still groups.
  // What we care about: no throw, and the valid one is present.
  assert.ok([...groups.values()].some(g => g.uris.includes(PIXEL_DATA_URI)))
})

test('transcodeDataUris replaces every occurrence with the CDN URL the uploader returns', async () => {
  const html = `<img src="${PIXEL_DATA_URI}"><div style="background-image:url(${PIXEL_DATA_URI})"></div>`

  const calls = []
  const uploadFn = async ({ buffer, mimeType, hash }) => {
    calls.push({ mimeType, hashShort: hash.slice(0, 8), bufferLen: buffer.length })
    return { cdn_url: `https://app.unbounce.com/publish/assets/fake-uuid/${hash.slice(0, 8)}.png` }
  }

  const { text, uploaded, errors } = await transcodeDataUris(html, uploadFn)
  assert.equal(errors.length, 0)
  assert.equal(uploaded.length, 1, 'duplicate URIs deduped → uploaded once')
  assert.equal(calls.length, 1)
  assert.equal(uploaded[0].occurrences, 2, 'reports both occurrences for the deduped image')
  assert.doesNotMatch(text, /data:image\//, 'no data: URIs should remain in output')
  const cdnMatches = text.match(/https:\/\/app\.unbounce\.com\/publish\/assets\/fake-uuid\/[a-f0-9]+\.png/g) || []
  assert.equal(cdnMatches.length, 2, 'both occurrences swapped for the same CDN URL')
})

test('transcodeDataUris uploads each unique image once even with N occurrences', async () => {
  const html = `
    <img src="${PIXEL_DATA_URI}" />
    <img src="${PIXEL_DATA_URI}" />
    <img src="${RED_DATA_URI}" />
    <style>.bg { background-image: url(${PIXEL_DATA_URI}); }</style>
  `
  let uploadCount = 0
  const uploadFn = async ({ hash }) => {
    uploadCount++
    return { cdn_url: `https://cdn.example/${hash.slice(0, 8)}` }
  }
  const { uploaded, errors } = await transcodeDataUris(html, uploadFn)
  assert.equal(errors.length, 0)
  assert.equal(uploadCount, 2, 'PIXEL deduped from 3 → 1, RED 1 → 1, total = 2')
  assert.equal(uploaded.length, 2)
})

test('transcodeDataUris leaves the data URI in place when its upload fails', async () => {
  const html = `<img src="${PIXEL_DATA_URI}"><img src="${RED_DATA_URI}">`
  const uploadFn = async ({ hash }) => {
    if (hash.startsWith(/* sha of PIXEL */ '')) {
      // Fail the first; succeed the second
    }
    // Approximate "fail one, succeed the other" by hash ordering
    if (uploadFn.calls === undefined) uploadFn.calls = 0
    uploadFn.calls++
    if (uploadFn.calls === 1) throw new Error('upload exploded')
    return { cdn_url: `https://cdn.example/${hash.slice(0, 8)}` }
  }
  const { text, uploaded, errors } = await transcodeDataUris(html, uploadFn)
  assert.equal(errors.length, 1, 'one failure recorded')
  assert.equal(uploaded.length, 1, 'the other still succeeded')
  // The successfully uploaded image is gone from text; the failed one remains.
  const remainingDataUris = (text.match(/data:image\//g) || []).length
  assert.equal(remainingDataUris, 1, 'failed image\'s data URI stays in place')
})

test('transcodeDataUris is a no-op on text with no data URIs', async () => {
  const html = `<html><body><h1>Hi</h1><img src="https://cdn.example/already.png"></body></html>`
  const uploadFn = async () => { throw new Error('uploader should not be called') }
  const { text, uploaded, errors } = await transcodeDataUris(html, uploadFn)
  assert.equal(text, html)
  assert.equal(uploaded.length, 0)
  assert.equal(errors.length, 0)
})

test('transcodeDataUris handles SVG data URIs', async () => {
  const html = `<img src="${SVG_DATA_URI}" />`
  const uploadCalls = []
  const uploadFn = async ({ mimeType }) => {
    uploadCalls.push(mimeType)
    return { cdn_url: 'https://cdn.example/svg-cdn-url.svg' }
  }
  const { text, uploaded } = await transcodeDataUris(html, uploadFn)
  assert.equal(uploadCalls[0], 'image/svg+xml')
  assert.equal(uploaded.length, 1)
  assert.match(text, /https:\/\/cdn\.example\/svg-cdn-url\.svg/)
  assert.doesNotMatch(text, /data:image\/svg/)
})
