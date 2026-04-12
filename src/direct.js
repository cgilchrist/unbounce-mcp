/**
 * Direct HTTP/GraphQL calls for Unbounce actions, using page.evaluate(fetch)
 * so auth (JWT + cookies) is handled automatically by the browser context.
 *
 * Each function receives a Playwright `page` that is already navigated to the
 * target page's overview. Call these before falling back to UI click flows.
 */

const GATEWAY = 'https://gateway.unbounce.com/graphql'
const APP_BASE = 'https://app.unbounce.com'

/**
 * Run a GraphQL mutation/query via the browser's fetch (inherits JWT auth).
 */
async function gql(page, query, variables) {
  const result = await page.evaluate(async ({ query, variables, url }) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ query, variables }),
    })
    return res.json()
  }, { query, variables, url: GATEWAY })

  const errors = result?.errors
  if (errors?.length) throw new Error(errors.map(e => e.message).join('; '))
  return result?.data
}

/**
 * Get the CSRF token from the page's meta tag.
 */
async function getCsrf(page) {
  return page.evaluate(() =>
    document.querySelector('meta[name="csrf-token"]')?.content
  )
}

/**
 * POST a Rails-style form action using the browser's fetch (inherits session cookies).
 */
async function railsPost(page, url, body) {
  const result = await page.evaluate(async ({ url, body }) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      credentials: 'include',
      body,
    })
    return { status: res.status, ok: res.ok }
  }, { url, body })

  if (!result.ok) throw new Error(`HTTP ${result.status} from ${url}`)
  return result
}

// ── Publish ────────────────────────────────────────────────────────────────────

export async function directPublish(page, subAccountId, pageId) {
  const csrf = await getCsrf(page)
  if (!csrf) throw new Error('No CSRF token found')
  const url = `${APP_BASE}/${subAccountId}/pages/${pageId}/publish`
  await railsPost(page, url, `authenticity_token=${encodeURIComponent(csrf)}&_method=put`)
}

// ── Unpublish ──────────────────────────────────────────────────────────────────

export async function directUnpublish(page, subAccountId, pageId) {
  const csrf = await getCsrf(page)
  if (!csrf) throw new Error('No CSRF token found')
  const url = `${APP_BASE}/${subAccountId}/pages/${pageId}/unpublish`
  await railsPost(page, url, `authenticity_token=${encodeURIComponent(csrf)}`)
}

// ── Delete ─────────────────────────────────────────────────────────────────────

const DELETE_MUTATION = `
mutation DeletePages($input: DeletePagesInput!) {
  deletePages(input: $input) {
    errors { message }
  }
}`

export async function directDelete(page, pageId) {
  const data = await gql(page, DELETE_MUTATION, { input: { pageUuids: [pageId] } })
  const errors = data?.deletePages?.errors
  if (errors?.length) throw new Error(errors.map(e => e.message).join('; '))
}

// ── Variant weights ────────────────────────────────────────────────────────────

const CHANGE_WEIGHTS_MUTATION = `
mutation ChangeVariantWeightsMutation($input: ChangeVariantWeightMutationInput!) {
  changeVariantWeights(input: $input) {
    page { id }
    errors { message path }
  }
}`

export async function directSetVariantWeights(page, pageId, weights) {
  // weights: { a: 50, b: 25, c: 25 } → [{ id: "a", weight: 50 }, ...]
  const weightArray = Object.entries(weights).map(([id, weight]) => ({ id, weight }))
  const data = await gql(page, CHANGE_WEIGHTS_MUTATION, {
    input: { pageId, weights: weightArray },
  })
  const errors = data?.changeVariantWeights?.errors
  if (errors?.length) throw new Error(errors.map(e => e.message).join('; '))
}

// ── Traffic mode ───────────────────────────────────────────────────────────────

const SET_ROUTING_MUTATION = `
mutation SetRoutingStrategy($input: SetRoutingStrategyInput!) {
  setRoutingStrategy(input: $input) {
    page { id }
    errors
  }
}`

const STRATEGY_MAP = {
  ab_test: 'weighted',
  smart_traffic: 'dta',
}

export async function directSetTrafficMode(page, pageId, mode) {
  const strategy = STRATEGY_MAP[mode]
  if (!strategy) throw new Error(`Unknown traffic mode: ${mode}`)
  const data = await gql(page, SET_ROUTING_MUTATION, {
    input: { pageId, strategy, config: null },
  })
  const errors = data?.setRoutingStrategy?.errors
  if (errors?.length) throw new Error(String(errors))
}

// ── Page URL ───────────────────────────────────────────────────────────────────

const PAGE_ID_QUERY = `
query PageUrlQuery($uuid: String!) {
  pageUrl(pageUuid: $uuid) {
    page { id }
  }
}`

const UPDATE_URL_MUTATION = `
mutation UpdateUrl($pageId: ID!, $pagePath: String!, $domain: String!) {
  updatePageUrl(input: { pageId: $pageId, pagePath: $pagePath, domain: $domain }) {
    page { uuid url }
    errors
  }
}`

export async function directSetPageUrl(page, pageId, domain, slug) {
  // Get the Relay base64 ID required by UpdateUrl
  const idData = await gql(page, PAGE_ID_QUERY, { uuid: pageId })
  const relayId = idData?.pageUrl?.page?.id
  if (!relayId) throw new Error('Could not resolve Relay page ID')

  const data = await gql(page, UPDATE_URL_MUTATION, {
    pageId: relayId,
    pagePath: slug,
    domain,
  })

  const errors = data?.updatePageUrl?.errors
  if (errors?.length) throw new Error(String(errors))

  // Check for URL-taken error in the response (returned as errors array, not top-level)
  const pageUrl = data?.updatePageUrl?.page?.url
  return pageUrl
}
