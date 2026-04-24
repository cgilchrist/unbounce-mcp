import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as cheerio from 'cheerio'
import { scopeCssToContainer, scopeRawCss, transformForms, prepareVariantContent } from '../../src/transform.js'

const SCOPE = '#lp-code-1'

test('scopeCssToContainer prefixes simple selectors', () => {
  const out = scopeCssToContainer('.hero { color: red; }', SCOPE)
  assert.match(out, /#lp-code-1 \.hero/)
})

test('scopeCssToContainer preserves @keyframes verbatim', () => {
  const css = '@keyframes slide { from { left: 0 } to { left: 100px } }'
  const out = scopeCssToContainer(css, SCOPE)
  assert.match(out, /@keyframes slide/)
  assert.doesNotMatch(out, /#lp-code-1 from/)
  assert.doesNotMatch(out, /#lp-code-1 to/)
})

test('scopeCssToContainer scopes rules inside @media', () => {
  const css = '@media (max-width: 600px) { .hero { color: blue } }'
  const out = scopeCssToContainer(css, SCOPE)
  assert.match(out, /@media/)
  assert.match(out, /#lp-code-1 \.hero/)
})

test('scopeCssToContainer skips body selectors', () => {
  const out = scopeCssToContainer('body { margin: 0; }', SCOPE)
  // body stays as body — scopeSelectors returns it unchanged
  assert.match(out, /^\s*body\b/)
})

test('scopeCssToContainer does not double-prefix already-scoped selectors', () => {
  const css = '#lp-code-1 .hero { color: red; }'
  const out = scopeCssToContainer(css, SCOPE)
  // Should remain exactly one #lp-code-1 prefix
  const count = (out.match(/#lp-code-1/g) || []).length
  assert.equal(count, 1, `expected 1 #lp-code-1 prefix, got ${count}: ${out}`)
})

test('scopeRawCss is idempotent — scoping twice matches scoping once', () => {
  const css = '.hero { color: red; } .cta { background: blue; }'
  const once = scopeRawCss(css)
  const twice = scopeRawCss(once)
  assert.equal(once, twice, 'scopeRawCss produced different output on second pass')
})

test('scopeRawCss does not double-scope CSS an agent copy-pasted from another variant', () => {
  // Real-world scenario: an agent creates a blank variant, then copies the
  // CSS field from variant A (already processed by scopeRawCss, contains
  // both #lp-code-1-prefixed user rules and the LAYOUT_OVERRIDES block) and
  // pastes it as the new variant's CSS. The MCP must NOT add a second
  // #lp-code-1 prefix — that would turn "#lp-code-1 .hero" into
  // "#lp-code-1 #lp-code-1 .hero" and break the rule entirely.
  const variantACss = scopeRawCss('.hero { color: red; } .cta { background: blue; }')
  const processed = scopeRawCss(variantACss)

  // User selectors keep exactly one #lp-code-1 prefix
  assert.doesNotMatch(processed, /#lp-code-1 #lp-code-1 \.hero/, 'user CSS got double-scoped')
  assert.doesNotMatch(processed, /#lp-code-1 #lp-code-1 \.cta/, 'user CSS got double-scoped')
  assert.match(processed, /#lp-code-1 \.hero/, 'user CSS should still be scoped')
  assert.match(processed, /#lp-code-1 \.cta/, 'user CSS should still be scoped')

  // Layout overrides remain untouched — #lp-pom-root must not get prefixed
  assert.doesNotMatch(processed, /#lp-code-1 #lp-pom-root/, 'layout override got re-scoped')

  // Marker comment appears exactly once
  const markerCount = (processed.match(/ubexport layout overrides/g) || []).length
  assert.equal(markerCount, 1, 'layout overrides block should be present exactly once')
})

test('scopeRawCss scopes user selectors and appends layout overrides once', () => {
  const out = scopeRawCss('.hero { color: red; }')
  assert.match(out, /<style>/)
  assert.match(out, /#lp-code-1 \.hero/)
  const overrideCount = (out.match(/ubexport layout overrides/g) || []).length
  assert.equal(overrideCount, 1, 'layout overrides should be appended exactly once')
})

test('transformForms wraps loose inputs in a form when none exists', () => {
  const $ = cheerio.load(`
    <!doctype html><html><body>
      <label>Email</label><input type="email" name="email"/>
      <button>Sign up</button>
    </body></html>
  `)
  const hasForm = transformForms($, 'a')
  assert.equal(hasForm, true)
  assert.equal($('form').length, 1)
})

test('transformForms returns false when no form or loose inputs exist', () => {
  const $ = cheerio.load('<!doctype html><html><body><h1>Hi</h1></body></html>')
  assert.equal(transformForms($, 'a'), false)
  assert.equal($('form').length, 0)
})

test('transformForms is idempotent — running twice does not double-wrap', () => {
  const html = `
    <!doctype html><html><body>
      <label>Email</label><input type="email" name="email"/>
      <button>Sign up</button>
    </body></html>
  `
  const $ = cheerio.load(html)
  transformForms($, 'a')
  const afterFirst = $.html()
  transformForms($, 'a')
  const afterSecond = $.html()
  assert.equal($('form').length, 1, 'should still have exactly one form')
  assert.equal(afterFirst, afterSecond, 'transformForms should be idempotent')
})

test('prepareVariantContent returns bodyHtml and cssHtml', () => {
  const html = `
    <!doctype html><html>
      <head><style>.x { color: red; }</style></head>
      <body><div class="x">Hello</div></body>
    </html>
  `
  const { bodyHtml, cssHtml } = prepareVariantContent(html, 'a')
  assert.match(bodyHtml, /<div[^>]*class="x"[^>]*>Hello<\/div>/)
  assert.match(cssHtml, /<style>/)
  assert.match(cssHtml, /#lp-code-1/)
})
