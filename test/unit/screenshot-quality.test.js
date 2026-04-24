import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  JPEG_TIERS,
  MAX_OUTPUT_DIMENSION,
  estimateBytes,
  pickTier,
  tierFitsDimensions,
  computeTiles,
} from '../../src/screenshot-quality.js'

test('JPEG_TIERS are ordered best-to-worst by bytesPerCssPx', () => {
  for (let i = 1; i < JPEG_TIERS.length; i++) {
    assert.ok(
      JPEG_TIERS[i - 1].bytesPerCssPx >= JPEG_TIERS[i].bytesPerCssPx,
      `tier ${i} should weigh <= tier ${i - 1}`
    )
  }
})

test('tierFitsDimensions rejects 2x when height would exceed MAX_OUTPUT_DIMENSION', () => {
  const tier2x = JPEG_TIERS[0] // dsr: 2
  // cssHeight 4000 × 2 = 8000 output — above 7500 cap
  assert.equal(tierFitsDimensions(1280, 4000, tier2x), false)
  // cssHeight 3000 × 2 = 6000 output — under 7500
  assert.equal(tierFitsDimensions(1280, 3000, tier2x), true)
})

test('tierFitsDimensions accepts 1x for pages up to MAX_OUTPUT_DIMENSION', () => {
  const tier1x = JPEG_TIERS.find(t => t.dsr === 1)
  assert.equal(tierFitsDimensions(1280, MAX_OUTPUT_DIMENSION, tier1x), true)
  assert.equal(tierFitsDimensions(1280, MAX_OUTPUT_DIMENSION + 1, tier1x), false)
})

test('pickTier picks 2x q=85 for a short hero-only page', () => {
  const tier = pickTier(1280, 800, 1024 * 1024)
  assert.equal(tier.dsr, 2)
  assert.equal(tier.quality, 85)
})

test('pickTier rejects 2x when page is too tall for 2x output', () => {
  // 1280 × 5000 at 2x would be 10000 tall — over 7500 cap
  const tier = pickTier(1280, 5000, 1024 * 1024)
  assert.equal(tier.dsr, 1)
})

test('pickTier steps to lower quality for a photo-heavy tall page that still fits 1x', () => {
  // 1280 × 7000 = 8.96M px at 500 KB budget.
  // 1x q=45 estimate: 8.96M × 0.055 = 493 KB → fits.
  const tier = pickTier(1280, 7000, 500 * 1024)
  assert.equal(tier.dsr, 1)
  assert.equal(tier.quality, 45)
})

test('pickTier returns null when page exceeds MAX_OUTPUT_DIMENSION even at 1x', () => {
  // 9230 CSS tall — 1x output is 9230 → over 7500 cap. Needs tiling.
  const tier = pickTier(1280, 9230, 500 * 1024)
  assert.equal(tier, null)
})

test('computeTiles returns a single tile when content already fits', () => {
  assert.deepEqual(computeTiles(1500), [{ y: 0, height: 1500 }])
  assert.deepEqual(computeTiles(MAX_OUTPUT_DIMENSION), [{ y: 0, height: MAX_OUTPUT_DIMENSION }])
})

test('computeTiles splits a 9230-px page into 2 tiles under the cap', () => {
  const tiles = computeTiles(9230)
  assert.equal(tiles.length, 2)
  for (const t of tiles) assert.ok(t.height <= MAX_OUTPUT_DIMENSION)
  // Tiles exactly cover the page with no gap / overlap
  assert.equal(tiles[0].y, 0)
  assert.equal(tiles[0].y + tiles[0].height, tiles[1].y)
  assert.equal(tiles[1].y + tiles[1].height, 9230)
})

test('estimateBytes reflects bytesPerCssPx times area', () => {
  const tier = { bytesPerCssPx: 0.1 }
  assert.equal(estimateBytes(100, 200, tier), 2000)
})
