/**
 * Pure helpers for picking screenshot DSR + JPEG quality dynamically based
 * on page dimensions so the final image stays under a size budget.
 *
 * The MCP tool response limit is 1 MB — base64 inflation (33%) plus JSON
 * framing leaves ~750 KB of binary across all image parts in a response.
 *
 * bytesPerCssPx values below are conservative (skewed toward photo-heavy
 * landing pages to avoid under-estimating). Callers should treat them as
 * ESTIMATES and fall back to the next tier if the actual encoded buffer
 * exceeds the budget.
 */

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
 * Pick the highest-quality tier whose estimate fits under `budget`. Returns
 * the lowest tier when nothing fits (capture at lowest and accept potential
 * over-budget — better than no screenshot at all).
 *
 * @param {number} cssWidth
 * @param {number} cssHeight
 * @param {number} budget  Target binary bytes for this single screenshot.
 * @returns {typeof JPEG_TIERS[number]}
 */
export function pickTier(cssWidth, cssHeight, budget) {
  for (const tier of JPEG_TIERS) {
    if (estimateBytes(cssWidth, cssHeight, tier) <= budget) return tier
  }
  return JPEG_TIERS[JPEG_TIERS.length - 1]
}
