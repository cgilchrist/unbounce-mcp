import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JPEG_TIERS, estimateBytes, pickTier } from '../../src/screenshot-quality.js'

test('JPEG_TIERS are ordered best-to-worst by bytesPerCssPx', () => {
  for (let i = 1; i < JPEG_TIERS.length; i++) {
    assert.ok(
      JPEG_TIERS[i - 1].bytesPerCssPx >= JPEG_TIERS[i].bytesPerCssPx,
      `tier ${i} should weigh <= tier ${i - 1}`
    )
  }
})

test('JPEG_TIERS cover both 2x and 1x, starting with retina', () => {
  assert.equal(JPEG_TIERS[0].dsr, 2, 'best tier is retina')
  assert.ok(JPEG_TIERS.some(t => t.dsr === 1), 'must include 1x tiers')
  assert.ok(JPEG_TIERS.some(t => t.quality <= 35), 'must include a low-quality floor for huge pages')
})

test('pickTier picks 2x q=85 for a short hero-only page', () => {
  // 1280 × 800 = 1.02M px. At 2x q=85 bpcp=0.80 → 820 KB. Over 500 KB.
  // 2x q=75 → 614 KB. Over 500. 2x q=65 → 410 KB. Fits 500 KB budget.
  // For a GENEROUS budget (1 MB), 2x q=85 fits.
  const tier = pickTier(1280, 800, 1024 * 1024)
  assert.equal(tier.dsr, 2)
  assert.equal(tier.quality, 85)
})

test('pickTier picks 1x for a typical landing page under budget', () => {
  // 1280 × 3500 = 4.48M px. All 2x tiers over 500 KB. 1x q=85 → 896 KB (over). 1x q=75 → 672 KB (over). 1x q=65 → 448 KB (fits).
  const tier = pickTier(1280, 3500, 500 * 1024)
  assert.equal(tier.dsr, 1)
  assert.equal(tier.quality, 65)
})

test('pickTier steps to very low quality for a photo-heavy tall page', () => {
  // 1280 × 9230 = 11.81M px at 500 KB budget.
  // 1x q=35 estimate: 11.81M × 0.040 = 472 KB → fits.
  const tier = pickTier(1280, 9230, 500 * 1024)
  assert.equal(tier.dsr, 1)
  assert.equal(tier.quality, 35)
})

test('pickTier returns the lowest tier when nothing fits', () => {
  // Absurdly tall — nothing fits, expect the floor.
  const tier = pickTier(1280, 999999, 400 * 1024)
  assert.equal(tier, JPEG_TIERS[JPEG_TIERS.length - 1])
})

test('pickTier picks a high tier on narrow mobile viewports', () => {
  // 390 × 3000 = 1.17M px at 300 KB budget.
  // 2x q=65 → 468 KB (over). 1x q=85 → 234 KB → fits.
  const tier = pickTier(390, 3000, 300 * 1024)
  assert.equal(tier.dsr, 1)
  assert.equal(tier.quality, 85)
})

test('estimateBytes reflects bytesPerCssPx times area', () => {
  const tier = { bytesPerCssPx: 0.1 }
  assert.equal(estimateBytes(100, 200, tier), 2000)
})
