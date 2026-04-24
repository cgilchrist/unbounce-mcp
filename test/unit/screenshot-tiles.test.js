import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeTiles } from '../../src/screenshot-tiles.js'

test('computeTiles returns a single tile when content fits', () => {
  assert.deepEqual(computeTiles(1500, 2000), [{ y: 0, height: 1500 }])
  assert.deepEqual(computeTiles(2000, 2000), [{ y: 0, height: 2000 }])
})

test('computeTiles splits an oversized page into equal-ish tiles', () => {
  const tiles = computeTiles(5000, 2000)
  assert.equal(tiles.length, 3, '5000 / 2000 rounds up to 3 tiles')
  const sum = tiles.reduce((s, t) => s + t.height, 0)
  assert.equal(sum, 5000, 'tiles should exactly cover the page')
  for (const t of tiles) assert.ok(t.height <= 2000, 'no tile should exceed max')
})

test('computeTiles produces tiles in ascending y-order with no gaps or overlaps', () => {
  const tiles = computeTiles(9230, 1800)
  let expectedY = 0
  for (const t of tiles) {
    assert.equal(t.y, expectedY, `tile y should continue from previous`)
    expectedY += t.height
  }
  assert.equal(expectedY, 9230, 'final y should equal totalHeight')
})

test('computeTiles last tile may be shorter when totalHeight is not evenly divisible', () => {
  const tiles = computeTiles(4500, 2000)
  // 4500 / 2000 → 3 tiles, 4500/3 = 1500 each
  assert.equal(tiles.length, 3)
  assert.equal(tiles[0].height, 1500)
  assert.equal(tiles[tiles.length - 1].y + tiles[tiles.length - 1].height, 4500)
})

test('computeTiles handles zero and tiny pages', () => {
  assert.deepEqual(computeTiles(0, 2000), [{ y: 0, height: 0 }])
  assert.deepEqual(computeTiles(100, 2000), [{ y: 0, height: 100 }])
})
