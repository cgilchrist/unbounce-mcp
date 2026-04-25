import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseAssetUploadResponse,
  buildCdnUrl,
  parseDataUrl,
  resolveUploadFilename,
} from '../../src/asset-upload.js'

const SAMPLE_RESPONSE = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN"
    "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en" lang="en">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=utf-8"/>

  <title>untitled</title>
  <script>
//<![CDATA[
    window.parent.editor.activeAssetUploader.assetUploaded({
      id: '267686322',
      uuid: 'adc47776-bc0f-4713-8195-4d8c409a8285',
      name: '661-e-windsor-rd-55s.jpg',
      content_file_name: '661-e-windsor-rd-55s.jpg',
      content_file_size: 654339,
      content_updated_at: '2026-04-25 03:25:14 UTC',
      content_content_type: 'image/jpeg',
      content_url: '/assets/adc47776-bc0f-4713-8195-4d8c409a8285/661-e-windsor-rd-55s.original.jpg?1777087514',
      content_url_small: '/assets/adc47776-bc0f-4713-8195-4d8c409a8285/661-e-windsor-rd-55s.small.jpg?1777087514',
      unique_url: '/assets/adc47776-bc0f-4713-8195-4d8c409a8285/9736c499-661-e-windsor-rd-55s.jpg'
    });
//]]>
</script></head>
<body>
hello
</body>
</html>`

test('parseAssetUploadResponse extracts id / uuid / name / size / mime from the JS callback', () => {
  const out = parseAssetUploadResponse(SAMPLE_RESPONSE)
  assert.equal(out.id, '267686322')
  assert.equal(out.uuid, 'adc47776-bc0f-4713-8195-4d8c409a8285')
  assert.equal(out.name, '661-e-windsor-rd-55s.jpg')
  assert.equal(out.contentFileSize, 654339)
  assert.equal(out.contentContentType, 'image/jpeg')
})

test('parseAssetUploadResponse parses double-quoted string values too', () => {
  // Defensive: Unbounce templates use single quotes today, but if the response
  // shape ever flips to double quotes, the asset still uploaded server-side
  // and we must NOT silently throw — losing the cdn_url leaves data: URIs
  // in the deployed HTML.
  const html = `<script>assetUploaded({
    id: "42",
    uuid: "abcd1234-5678-90ab-cdef-1234567890ab",
    name: "double-quoted.png",
    content_file_size: 100,
    content_content_type: "image/png"
  });</script>`
  const out = parseAssetUploadResponse(html)
  assert.equal(out.id, '42')
  assert.equal(out.uuid, 'abcd1234-5678-90ab-cdef-1234567890ab')
  assert.equal(out.name, 'double-quoted.png')
  assert.equal(out.contentFileSize, 100)
  assert.equal(out.contentContentType, 'image/png')
})

test('parseAssetUploadResponse throws on missing assetUploaded call', () => {
  assert.throws(
    () => parseAssetUploadResponse('<html><body>nope</body></html>'),
    /assetUploaded/
  )
})

test('parseAssetUploadResponse throws on missing required fields', () => {
  // assetUploaded present, but no uuid
  const html = `<script>assetUploaded({ id: '1', name: 'x.jpg' });</script>`
  assert.throws(() => parseAssetUploadResponse(html), /uuid\/id\/name/)
})

test('buildCdnUrl produces the bare app.unbounce.com /publish/assets URL', () => {
  const url = buildCdnUrl('adc47776-bc0f-4713-8195-4d8c409a8285', '661-e-windsor-rd-55s.jpg')
  assert.equal(
    url,
    'https://app.unbounce.com/publish/assets/adc47776-bc0f-4713-8195-4d8c409a8285/661-e-windsor-rd-55s.jpg'
  )
})

test('buildCdnUrl encodes spaces in the filename without mangling the path', () => {
  const url = buildCdnUrl('uuid-here', 'My Hero Image.png')
  // Spaces in the filename become %20; the path structure (slashes) is preserved.
  assert.equal(url, 'https://app.unbounce.com/publish/assets/uuid-here/My%20Hero%20Image.png')
})

test('buildCdnUrl rejects missing inputs', () => {
  assert.throws(() => buildCdnUrl(null, 'x.jpg'), /uuid/)
  assert.throws(() => buildCdnUrl('uuid', ''), /name/)
})

test('parseDataUrl decodes a base64 data URL into a Buffer + mime', () => {
  // 1x1 transparent PNG, the canonical "smallest valid PNG"
  const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
  const { buffer, mimeType } = parseDataUrl(dataUrl)
  assert.equal(mimeType, 'image/png')
  assert.ok(Buffer.isBuffer(buffer))
  assert.ok(buffer.length > 0)
  // PNG files start with the 8-byte signature 89 50 4E 47 0D 0A 1A 0A
  assert.equal(buffer[0], 0x89)
  assert.equal(buffer[1], 0x50)
  assert.equal(buffer[2], 0x4e)
  assert.equal(buffer[3], 0x47)
})

test('parseDataUrl rejects malformed inputs with a useful error', () => {
  assert.throws(() => parseDataUrl('http://not-a-data-url.example/img.png'), /base64-encoded data URL/)
  assert.throws(() => parseDataUrl(''), /base64-encoded data URL/)
  assert.throws(() => parseDataUrl('data:image/png,raw-not-base64'), /base64-encoded data URL/)
})

test('resolveUploadFilename prefers explicit filename, falls back to filePath, then synthesizes', () => {
  assert.deepEqual(
    resolveUploadFilename({ filename: 'logo.png' }),
    { filename: 'logo.png', mimeType: 'image/png' }
  )
  assert.deepEqual(
    resolveUploadFilename({ filePath: '/tmp/uploads/HERO.JPG' }),
    { filename: 'HERO.JPG', mimeType: 'image/jpeg' }
  )
  // Pure data-URL with no filename hint — synthesizes one based on mime
  const out = resolveUploadFilename({ mimeType: 'image/webp' })
  assert.match(out.filename, /^image-\d+\.webp$/)
  assert.equal(out.mimeType, 'image/webp')
})
