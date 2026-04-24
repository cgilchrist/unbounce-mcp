import { test } from 'node:test'
import assert from 'node:assert/strict'
import { slugify, evenWeights } from '../../src/tools.js'

test('slugify lowercases and replaces non-alphanumerics', () => {
  assert.equal(slugify('Summer Promo 2026!'), 'summer-promo-2026')
})

test('slugify collapses runs of non-alphanumerics to a single dash', () => {
  assert.equal(slugify('A  B  C'), 'a-b-c')
  assert.equal(slugify('A!!!B???C'), 'a-b-c')
})

test('slugify trims leading and trailing dashes', () => {
  assert.equal(slugify('---foo---'), 'foo')
  assert.equal(slugify('   foo   '), 'foo')
})

test('slugify falls back to "page" for empty-ish input', () => {
  assert.equal(slugify(''), 'page')
  assert.equal(slugify('!!!'), 'page')
})

test('evenWeights splits 100 evenly among variants', () => {
  assert.deepEqual(evenWeights(['a', 'b']), { a: 50, b: 50 })
  assert.deepEqual(evenWeights(['a', 'b', 'c', 'd']), { a: 25, b: 25, c: 25, d: 25 })
})

test('evenWeights gives champion (a) the remainder on non-divisible splits', () => {
  assert.deepEqual(evenWeights(['a', 'b', 'c']), { a: 34, b: 33, c: 33 })
  // 100 / 7 = 14 base, remainder 2 → a gets 16
  const w = evenWeights(['a', 'b', 'c', 'd', 'e', 'f', 'g'])
  assert.equal(w.a, 16)
  assert.equal(Object.values(w).reduce((s, n) => s + n, 0), 100)
})

test('evenWeights always sums to 100', () => {
  for (let n = 1; n <= 26; n++) {
    const ids = Array.from({ length: n }, (_, i) => String.fromCharCode(97 + i))
    const w = evenWeights(ids)
    const sum = Object.values(w).reduce((s, v) => s + v, 0)
    assert.equal(sum, 100, `n=${n} did not sum to 100`)
  }
})
