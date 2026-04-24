/**
 * Pure helpers for picking screenshot DSR + JPEG quality dynamically so
 * each image stays under both a byte budget (MCP response limit) and a
 * pixel dimension cap (vision model input limit).
 *
 * Two constraints apply:
 * - MCP response: 1 MB total across all image parts → ~700 KB binary.
 * - Per-image pixel dimensions: 8000 px on any side (Anthropic vision cap).
 *
 * bytesPerCssPx values are conservative (skewed toward photo-heavy landing
 * pages to avoid under-estimating). pickTier() uses them to PREDICT fit;
 * callers should still verify actual buffer size and fall back a tier.
 */

// Conservative cap below Anthropic's hard 8000-px limit on any image side.
export const MAX_OUTPUT_DIMENSION = 7500

export const JPEG_TIERS = [
  { dsr: 2, quality: 85, bytesPerCssPx: 0.80 },  // retina, best
  { dsr: 2, quality: 75, bytesPerCssPx: 0.60 },
  { dsr: 2, quality: 65, bytesPerCssPx: 0.40 },
  { dsr: 1, quality: 85, bytesPerCssPx: 0.20 },  // 1x, best
  { dsr: 1, quality: 75, bytesPerCssPx: 0.15 },
  { dsr: 1, quality: 65, bytesPerCssPx: 0.10 },
  { dsr: 1, quality: 55, bytesPerCssPx: 0.075 },
  { dsr: 1, quality: 45, bytesPerCssPx: 0.055 },
  { dsr: 1, quality: 35, bytesPerCssPx: 0.040 },
  { dsr: 1, quality: 25, bytesPerCssPx: 0.030 },  // 1x, ugly-but-fits
]

/**
 * True if capturing at `tier`'s scale would produce an image with a side
 * longer than MAX_OUTPUT_DIMENSION. 2x doubles output dimensions, so this
 * rules out retina for tall pages.
 */
export function tierFitsDimensions(cssWidth, cssHeight, tier) {
  const outW = cssWidth * tier.dsr
  const outH = cssHeight * tier.dsr
  return outW <= MAX_OUTPUT_DIMENSION && outH <= MAX_OUTPUT_DIMENSION
}

/**
 * Estimated encoded JPEG bytes for a viewport at a given tier.
 *
 * @param {number} cssWidth
 * @param {number} cssHeight
 * @param {{ bytesPerCssPx: number }} tier
 * @returns {number}
 */
export function estimateBytes(cssWidth, cssHeight, tier) {
  return cssWidth * cssHeight * tier.bytesPerCssPx
}

/**
 * Pick the highest-quality tier whose estimate fits `budget` bytes AND
 * whose output dimensions fit MAX_OUTPUT_DIMENSION. Returns the lowest
 * tier that at least satisfies the dimension cap when no tier fits both;
 * returns null when even the lowest tier can't satisfy the dimension cap
 * (page too tall for any single image — caller must tile).
 *
 * @param {number} cssWidth
 * @param {number} cssHeight
 * @param {number} budget  Target binary bytes for this single screenshot.
 * @returns {typeof JPEG_TIERS[number] | null}
 */
export function pickTier(cssWidth, cssHeight, budget) {
  for (const tier of JPEG_TIERS) {
    if (!tierFitsDimensions(cssWidth, cssHeight, tier)) continue
    if (estimateBytes(cssWidth, cssHeight, tier) <= budget) return tier
  }
  // Nothing fits the byte budget; return the lowest tier that at least
  // fits the dimension cap (caller accepts over-budget or retries at a
  // lower tier). Null means the page is too tall for any single image.
  for (let i = JPEG_TIERS.length - 1; i >= 0; i--) {
    if (tierFitsDimensions(cssWidth, cssHeight, JPEG_TIERS[i])) {
      return JPEG_TIERS[i]
    }
  }
  return null
}

/**
 * Split a page taller than MAX_OUTPUT_DIMENSION into contiguous vertical
 * CSS-pixel slices such that EACH slice, at 1x DSR, produces an output
 * image whose height fits the dimension cap. Returns one slice when the
 * page already fits.
 *
 * @param {number} cssHeight
 * @returns {{ y: number, height: number }[]}
 */
export function computeTiles(cssHeight) {
  if (cssHeight <= MAX_OUTPUT_DIMENSION) return [{ y: 0, height: cssHeight }]
  const tileCount = Math.ceil(cssHeight / MAX_OUTPUT_DIMENSION)
  const tileHeight = Math.ceil(cssHeight / tileCount)
  return Array.from({ length: tileCount }, (_, i) => {
    const y = i * tileHeight
    const h = Math.min(tileHeight, cssHeight - y)
    return { y, height: h }
  })
}
