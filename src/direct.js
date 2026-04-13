/**
 * Direct HTTP/GraphQL calls for Unbounce actions, using Playwright's
 * APIRequestContext (page.context().request) so auth cookies are inherited
 * automatically without being subject to the page's CSP.
 *
 * Each exported function receives a Playwright `page` that is already
 * navigated to the target page's overview.
 */

const GATEWAY = 'https://gateway.unbounce.com/graphql'
const APP_BASE = 'https://app.unbounce.com'

/**
 * Run a GraphQL mutation/query using Playwright's request context (inherits cookies).
 */
async function gql(page, query, variables, jwt) {
  const req = page.context().request
  const res = await req.post(GATEWAY, {
    headers: {
      'Content-Type': 'application/json',
      ...(jwt ? { 'Authorization': `Bearer ${jwt}` } : {}),
    },
    data: JSON.stringify({ query, variables }),
  })
  if (!res.ok()) {
    const body = await res.text().catch(() => '')
    throw new Error(`GraphQL HTTP ${res.status()}: ${body.slice(0, 200)}`)
  }
  const result = await res.json()
  const errors = result?.errors
  if (errors?.length) throw new Error(errors.map(e => e.message).join('; '))
  return result?.data
}

/**
 * Get variant numeric IDs for a page via GraphQL — no browser navigation required.
 * Returns { a: '325998002', b: '325998003', ... }
 */
export async function directGetVariantNumericIds(page, pageUuid) {
  const jwt = await getJwt(page)
  const data = await gql(page, `
    query GetVariantPaths($pageUuid: String!) {
      page(uuid: $pageUuid) {
        pageVariants {
          nodes {
            variantId
            editPath
          }
        }
      }
    }
  `, { pageUuid }, jwt)
  const nodes = data?.page?.pageVariants?.nodes
  if (!nodes?.length) throw new Error(`No variants returned from GraphQL for page ${pageUuid}`)
  const result = {}
  for (const node of nodes) {
    const letter = node.variantId?.toLowerCase()
    const match = node.editPath?.match(/\/variants\/(\d+)\//)
    if (letter && match) result[letter] = match[1]
  }
  if (!Object.keys(result).length) throw new Error(`Could not parse numeric IDs from GraphQL editPaths`)
  return result
}

/**
 * Get the CSRF token from the page's meta tag (DOM read — still uses page.evaluate).
 */
async function getCsrf(page) {
  return page.evaluate(() =>
    document.querySelector('meta[name="csrf-token"]')?.content
  )
}

/**
 * POST a Rails-style form action using Playwright's request context.
 */
async function railsPost(page, url, body, extraHeaders = {}) {
  const req = page.context().request
  const res = await req.post(url, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...extraHeaders },
    data: body,
  })
  if (!res.ok()) throw new Error(`HTTP ${res.status()} from ${url}`)
  return { status: res.status(), ok: res.ok() }
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

// ── Variant get / edit ─────────────────────────────────────────────────────────

/**
 * Build a single <page_variant> XML block from a variant data object.
 */
function buildVariantXml(v) {
  // Ensure any value that might be a JS object is JSON-serialized before CDATA wrapping
  const toStr = s => (s == null ? '' : typeof s === 'object' ? JSON.stringify(s) : String(s))
  const cdata = s => `<![CDATA[${toStr(s)}]]>`
  return [
    `<page_variant>`,
    `<page><id>${v.page?.id ?? ''}</id><name>${v.page?.name ?? ''}</name><used_as>${v.page?.used_as ?? ''}</used_as></page>`,
    `<id>${v.id}</id>`,
    `<version>${v.version}</version>`,
    `<name>${cdata(v.name)}</name>`,
    `<last_element_id>${v.last_element_id}</last_element_id>`,
    `<has_form>${v.has_form}</has_form>`,
    `<title>${cdata(v.title)}</title>`,
    `<description>${cdata(v.description)}</description>`,
    `<keywords>${cdata(v.keywords)}</keywords>`,
    `<settings>${cdata(v.settings)}</settings>`,
    `<open_graph>${cdata(v.open_graph)}</open_graph>`,
    `<favicon>${cdata(v.favicon)}</favicon>`,
    `<autoscale>${v.autoscale}</autoscale>`,
    `<elements>${cdata(v.elements)}</elements>`,
    `</page_variant>`,
  ].join('')
}

/**
 * Build the full save.xml payload from the complete edit.json response.
 * Must include both mainPage and subPages to avoid 500 errors.
 */
function buildSaveXml(fullResponse) {
  const mainPage = fullResponse.mainPage ?? fullResponse
  const subPages = fullResponse.subPages ?? []
  const subPagesXml = Array.isArray(subPages)
    ? subPages.map(buildVariantXml).join('')
    : ''
  return [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<data>`,
    `<main_page>${buildVariantXml(mainPage)}</main_page>`,
    subPagesXml ? `<sub_pages>${subPagesXml}</sub_pages>` : '',
    `</data>`,
  ].join('')
}

/**
 * Obtain a JWT token for authenticating editor API calls.
 * Uses Playwright's request context so cookies are inherited.
 */
async function getJwt(page) {
  let csrf = await getCsrf(page)
  if (!csrf) {
    // Page is at about:blank — navigate to base URL to get a CSRF token
    await page.goto(APP_BASE, { waitUntil: 'domcontentloaded', timeout: 15000 })
    csrf = await getCsrf(page)
  }
  const req = page.context().request
  const res = await req.post(`${APP_BASE}/users/token?type=jwt`, {
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
    },
  })
  if (!res.ok()) throw new Error(`JWT fetch HTTP ${res.status()}`)
  const data = await res.json()
  const token = data.token
  if (!token) throw new Error(`JWT response missing token (keys: ${JSON.stringify(Object.keys(data))})`)
  return token
}

/**
 * Fetch and parse the variant elements array from edit.json.
 * Returns { raw, elements } where elements is always an array.
 */
async function fetchVariantState(page, numericId, jwt) {
  const req = page.context().request
  const res = await req.get(`${APP_BASE}/variants/${numericId}/edit.json`, {
    headers: { 'Authorization': `Bearer ${jwt}`, 'Accept': 'application/json' },
  })
  if (!res.ok()) {
    const text = await res.text()
    throw new Error(`edit.json HTTP ${res.status()}: ${text.slice(0, 200)}`)
  }
  const fullResponse = await res.json()
  // Variant data lives under mainPage in the response
  const variantData = fullResponse.mainPage ?? fullResponse
  if (!variantData.elements) throw new Error(`edit.json missing elements`)
  const elements = typeof variantData.elements === 'string' ? JSON.parse(variantData.elements) : variantData.elements
  return { raw: variantData, elements, fullResponse }
}

/**
 * Fetch the current HTML and CSS for a variant directly via the editor JSON endpoint.
 * @returns {{ html: string, css: string }}
 */
export async function directGetVariant(page, numericId) {
  const jwt = await getJwt(page)
  const { elements } = await fetchVariantState(page, numericId, jwt)
  const codeEl = elements.find(e => e.id === 'lp-code-1') || elements.find(e => e.type === 'lp-code')
  const cssEl = elements.find(e => e.id === 'lp-stylesheet-1') || elements.find(e => e.type === 'lp-stylesheet')
  return {
    html: codeEl?.content?.html ?? '',
    css: cssEl?.content?.html ?? '',
  }
}

/**
 * Update the HTML and/or CSS of a variant directly via edit.json + save.xml.
 */
export async function directEditVariant(page, numericId, newHtml, newCss) {
  // 1. Get JWT + current state
  const jwt = await getJwt(page)
  const { raw, elements, fullResponse } = await fetchVariantState(page, numericId, jwt)

  // 2. Update HTML and/or CSS in the elements array
  if (newHtml) {
    const el = elements.find(e => e.id === 'lp-code-1') || elements.find(e => e.type === 'lp-code')
    if (!el) throw new Error(`No lp-code element found in variant`)
    el.content.html = newHtml
  }
  if (newCss) {
    const el = elements.find(e => e.id === 'lp-stylesheet-1') || elements.find(e => e.type === 'lp-stylesheet')
    if (!el) throw new Error(`No lp-stylesheet element found in variant`)
    el.content.html = newCss
  }
  raw.elements = JSON.stringify(elements)

  // 3. POST save.xml — must include both mainPage and subPages
  const csrf = await getCsrf(page)
  const xml = buildSaveXml(fullResponse)
  const req = page.context().request
  const saveRes = await req.post(`${APP_BASE}/variants/${numericId}/save.xml`, {
    headers: {
      'Content-Type': 'application/xml',
      'Authorization': `Bearer ${jwt}`,
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
    },
    data: xml,
  })
  if (!saveRes.ok()) {
    const body = await saveRes.text()
    throw new Error(`save.xml HTTP ${saveRes.status()}: ${body.slice(0, 200)}`)
  }
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

  return data?.updatePageUrl?.page?.url
}
