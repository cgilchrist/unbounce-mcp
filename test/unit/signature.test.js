import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { stampBodyHtml, registerServer, SIGNATURE_RE } from '../../src/signature.js'

beforeEach(() => {
  // Default: simulate a connected client.
  registerServer({
    getClientVersion: () => ({ name: 'test-client', version: '1.2.3' }),
  })
})

test('stampBodyHtml prepends a single-line comment with server + client + iso date', () => {
  const out = stampBodyHtml('<h1>Hello</h1>')
  assert.match(out, /^<!-- unbounce-mcp@\d+\.\d+\.\d+ · client: test-client@1\.2\.3 · \d{4}-\d{2}-\d{2}T[\d:.]+Z -->\n<h1>Hello<\/h1>$/)
})

test('stampBodyHtml on already-stamped html replaces (does not stack) the stamp', () => {
  const once = stampBodyHtml('<h1>Hello</h1>')
  const twice = stampBodyHtml(once)
  // Exactly one stamp comment in the output.
  const matches = twice.match(/<!-- unbounce-mcp@/g) || []
  assert.equal(matches.length, 1, `expected 1 stamp, got ${matches.length}: ${twice}`)
  // Body content survives intact.
  assert.match(twice, /<h1>Hello<\/h1>$/)
})

test('stampBodyHtml on stamped-with-extra-whitespace input still replaces cleanly', () => {
  // Old stamps may have varying whitespace; the regex must catch them.
  const stale = '<!--   unbounce-mcp@0.0.1 · client: foo@1.0.0 · 2020-01-01T00:00:00.000Z   -->\n\n<h1>Hi</h1>'
  const out = stampBodyHtml(stale)
  const matches = out.match(/<!-- unbounce-mcp@/g) || []
  assert.equal(matches.length, 1)
  assert.doesNotMatch(out, /2020-01-01/)
})

test('stampBodyHtml returns empty input unchanged (no stamp on null/empty)', () => {
  assert.equal(stampBodyHtml(''), '')
  assert.equal(stampBodyHtml(null), null)
  assert.equal(stampBodyHtml(undefined), undefined)
})

test('stampBodyHtml falls back to "client: unknown" if the server is not registered', () => {
  registerServer(null)
  const out = stampBodyHtml('<p>hi</p>')
  assert.match(out, /client: unknown/)
  assert.match(out, /<p>hi<\/p>$/)
})

test('SIGNATURE_RE matches a fresh stamp it produced', () => {
  const out = stampBodyHtml('<p>x</p>')
  assert.ok(SIGNATURE_RE.test(out))
})

test('stampBodyHtml does not strip a stamp-like string inside a script/style block', () => {
  // Defensive: stamps live only at position 0. A stamp-shaped comment buried
  // inside a script (e.g. as a string literal or developer note) must NOT be
  // touched, otherwise we'd mangle user-authored content.
  const input = '<p>before</p>\n<script>// <!-- unbounce-mcp@9.9.9 · client: imposter@0.0.0 · 2099-01-01T00:00:00Z -->\nconsole.log("ok")</script>\n<p>after</p>'
  const out = stampBodyHtml(input)
  // Original deeper "stamp" survives unchanged in the script body.
  assert.ok(out.includes('imposter@0.0.0'), 'inner stamp-like string was incorrectly stripped')
  // Real stamp prepended exactly once at the front.
  const realStamps = out.match(/^<!-- unbounce-mcp@/g)?.length ?? 0
  assert.equal(realStamps, 1, 'real stamp should appear exactly once at start')
})
