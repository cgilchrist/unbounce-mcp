import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  placementApiToInternal,
  placementInternalToApi,
  scriptElementToApi,
  buildScriptElement,
  VALID_PLACEMENTS,
} from '../../src/javascripts.js'

test('placementApiToInternal round-trips through placementInternalToApi', () => {
  for (const api of VALID_PLACEMENTS) {
    const internal = placementApiToInternal(api)
    assert.equal(placementInternalToApi(internal), api)
  }
})

test('placementApiToInternal rejects unknown values with a helpful message', () => {
  assert.throws(
    () => placementApiToInternal('footer'),
    /Invalid placement "footer"/
  )
})

test('placement names match Unbounce UI semantics', () => {
  // "After Body Tag" in the UI = right after <body> opens = body content's "before"
  assert.equal(placementApiToInternal('body_top'), 'body:before')
  // "Before Body End Tag" in the UI = right before </body> closes = body content's "after"
  assert.equal(placementApiToInternal('body_bottom'), 'body:after')
  assert.equal(placementApiToInternal('head'), 'head')
})

test('scriptElementToApi extracts the fields agents care about, drops Unbounce internals', () => {
  const stored = {
    name: 'GTM',
    containerId: null,
    placement: 'head',
    content: { type: null, html: '<script>/* gtm */</script>', valid: true },
    breakpoints: {},
    id: 'lp-script-474',
    type: 'lp-script',
  }
  assert.deepEqual(scriptElementToApi(stored), {
    id: 'lp-script-474',
    name: 'GTM',
    placement: 'head',
    html: '<script>/* gtm */</script>',
  })
})

test('scriptElementToApi tolerates missing name / content fields', () => {
  const stored = { id: 'lp-script-1', placement: 'body:after', type: 'lp-script' }
  const out = scriptElementToApi(stored)
  assert.equal(out.name, '')
  assert.equal(out.html, '')
  assert.equal(out.placement, 'body_bottom')
})

test('buildScriptElement produces the exact storage shape Unbounce expects', () => {
  const out = buildScriptElement(
    { name: 'Pixel', placement: 'body_bottom', html: '<script>fb()</script>' },
    475
  )
  assert.deepEqual(out, {
    name: 'Pixel',
    containerId: null,
    placement: 'body:after',
    content: { type: null, html: '<script>fb()</script>', valid: true },
    breakpoints: {},
    id: 'lp-script-475',
    type: 'lp-script',
  })
})

test('buildScriptElement falls back to "Script {id}" when name is omitted', () => {
  const out = buildScriptElement({ placement: 'head', html: '<script>x</script>' }, 478)
  assert.equal(out.name, 'Script 478')
})
