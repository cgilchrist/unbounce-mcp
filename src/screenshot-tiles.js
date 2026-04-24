/**
 * Pure helpers for splitting a tall page screenshot into vertical tiles.
 *
 * Each tile's encoded JPEG must comfortably fit under the 1 MB MCP tool
 * result limit. At deviceScaleFactor: 2 and JPEG quality 85, a 1280-wide
 * CSS tile of ~1600 px renders to ~2560×3200 physical pixels, which lands
 * around 400–600 KB for typical landing-page content.
 */

/** CSS-pixel tile height used when tiling is required. */
export const MAX_TILE_HEIGHT_CSS = 1600

/**
 * Split a page of `totalHeight` CSS pixels into contiguous vertical tiles of
 * at most `maxTileHeight` CSS pixels each. Tiles are equal-height (except
 * the last, which may be shorter) and cover the page without gaps/overlaps.
 *
 * @param {number} totalHeight
 * @param {number} [maxTileHeight=MAX_TILE_HEIGHT_CSS]
 * @returns {{ y: number, height: number }[]}
 */
export function computeTiles(totalHeight, maxTileHeight = MAX_TILE_HEIGHT_CSS) {
  if (totalHeight <= maxTileHeight) return [{ y: 0, height: totalHeight }]
  const tileCount = Math.ceil(totalHeight / maxTileHeight)
  const tileHeight = Math.ceil(totalHeight / tileCount)
  return Array.from({ length: tileCount }, (_, i) => {
    const y = i * tileHeight
    const h = Math.min(tileHeight, totalHeight - y)
    return { y, height: h }
  })
}
