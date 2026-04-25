/**
 * Pure helpers for the get_javascripts / set_javascripts tools.
 *
 * Unbounce stores user-injected scripts as elements in the variant's
 * `elements` array with type "lp-script". The internal `placement` field
 * uses Unbounce's body-content-relative naming (`body:before` = before the
 * body content = right after <body>); we expose API names that read more
 * intuitively ("body_top" / "body_bottom") and translate at the boundary.
 */

// API value → internal storage value
const PLACEMENT_API_TO_INTERNAL = Object.freeze({
  head: 'head',
  body_top: 'body:before',     // immediately after <body>  (UI: "After Body Tag")
  body_bottom: 'body:after',   // immediately before </body> (UI: "Before Body End Tag")
})

// Internal storage value → API value
const PLACEMENT_INTERNAL_TO_API = Object.freeze({
  head: 'head',
  'body:before': 'body_top',
  'body:after': 'body_bottom',
})

export const VALID_PLACEMENTS = Object.freeze(Object.keys(PLACEMENT_API_TO_INTERNAL))

export function placementApiToInternal(api) {
  const v = PLACEMENT_API_TO_INTERNAL[api]
  if (!v) throw new Error(`Invalid placement "${api}". Must be one of: ${VALID_PLACEMENTS.join(', ')}.`)
  return v
}

export function placementInternalToApi(internal) {
  return PLACEMENT_INTERNAL_TO_API[internal] ?? internal
}

/**
 * Translate an lp-script element from variant storage into the API shape.
 */
export function scriptElementToApi(el) {
  return {
    id: el.id,
    name: el.name ?? '',
    placement: placementInternalToApi(el.placement),
    html: el.content?.html ?? '',
  }
}

/**
 * Build a new lp-script element for storage from API-shape input.
 * Caller assigns the numeric id portion via `lastElementId + 1`.
 */
export function buildScriptElement({ name, placement, html }, numericId) {
  return {
    name: name || `Script ${numericId}`,
    containerId: null,
    placement: placementApiToInternal(placement),
    content: {
      type: null,
      html,
      valid: true,
    },
    breakpoints: {},
    id: `lp-script-${numericId}`,
    type: 'lp-script',
  }
}
