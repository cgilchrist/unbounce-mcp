import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import * as tar from 'tar'
import { packageToUnbounce } from '../../src/packager.js'

const SIMPLE_HTML = `<!doctype html><html><head><title>T</title><style>.x{color:red}</style></head><body><div class="x">Hello</div></body></html>`

async function extractTarToDir(buf) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ubexport-test-'))
  const tarPath = path.join(dir, 'archive.tar')
  await fs.writeFile(tarPath, buf)
  await tar.extract({ file: tarPath, cwd: dir })
  await fs.rm(tarPath)
  // Top-level entry is the archive UUID directory
  const entries = await fs.readdir(dir)
  const archiveId = entries.find(e => !e.startsWith('.'))
  return path.join(dir, archiveId)
}

test('packageToUnbounce produces a non-empty buffer for single variant', async () => {
  const buf = await packageToUnbounce([{ name: 'a.html', html: SIMPLE_HTML }], [], 'Test')
  assert.ok(Buffer.isBuffer(buf), 'result should be a Buffer')
  assert.ok(buf.length > 0, 'result should be non-empty')
})

test('packageToUnbounce rejects empty html list', async () => {
  await assert.rejects(
    () => packageToUnbounce([], [], 'Test'),
    /at least one HTML file/i
  )
})

test('packageToUnbounce includes variant A directory structure', async () => {
  const buf = await packageToUnbounce([{ name: 'a.html', html: SIMPLE_HTML }], [], 'Test')
  const dir = await extractTarToDir(buf)
  try {
    const pagesDir = path.join(dir, 'pages')
    const pages = await fs.readdir(pagesDir)
    assert.equal(pages.length, 1, 'one page directory expected')
    const pageDir = path.join(pagesDir, pages[0])
    const variantDir = path.join(pageDir, 'page_variants', 'a')
    const stat = await fs.stat(variantDir)
    assert.ok(stat.isDirectory(), 'variant A directory missing')

    const metadata = JSON.parse(await fs.readFile(path.join(variantDir, 'metadata.json'), 'utf8'))
    assert.equal(metadata.variant_id, 'a')
    assert.equal(metadata.variant_weight, 100)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('packageToUnbounce creates three variant directories for three HTML files', async () => {
  const buf = await packageToUnbounce(
    [
      { name: 'a.html', html: SIMPLE_HTML },
      { name: 'b.html', html: SIMPLE_HTML },
      { name: 'c.html', html: SIMPLE_HTML },
    ],
    [],
    'Test'
  )
  const dir = await extractTarToDir(buf)
  try {
    const pagesDir = path.join(dir, 'pages')
    const [pageId] = await fs.readdir(pagesDir)
    const variantsDir = path.join(pagesDir, pageId, 'page_variants')
    const variants = await fs.readdir(variantsDir)
    variants.sort()
    assert.deepEqual(variants, ['a', 'b', 'c'])
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('packageToUnbounce preserves <ub:dynamic> tags through the cheerio round-trip', async () => {
  const dynamicHtml = `<!doctype html><html><body><h1><ub:dynamic parameter="city" method="titlecase">Vancouver</ub:dynamic></h1></body></html>`
  const buf = await packageToUnbounce([{ name: 'a.html', html: dynamicHtml }], [], 'Test')
  const dir = await extractTarToDir(buf)
  try {
    const pagesDir = path.join(dir, 'pages')
    const [pageId] = await fs.readdir(pagesDir)
    const elements = JSON.parse(
      await fs.readFile(
        path.join(pagesDir, pageId, 'page_variants', 'a', 'elements.json'),
        'utf8'
      )
    )
    const lpCode = elements.find(e => e.id === 'lp-code-1')
    assert.ok(lpCode.content.html.includes('<ub:dynamic'), 'ub:dynamic tag lost')
    assert.ok(lpCode.content.html.includes('Vancouver'), 'dynamic text lost')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
