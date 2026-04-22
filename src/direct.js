/**
 * Direct HTTP/GraphQL calls for Unbounce actions, using Playwright's
 * APIRequestContext (page.context().request) so auth cookies are inherited
 * automatically without being subject to the page's CSP.
 *
 * Each exported function receives a Playwright `page` that is already
 * navigated to the target page's overview.
 */

import { prepareVariantContent, scopeRawCss } from './transform.js'

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
    query PageVariantGoalsQuery($pageUuid: String!) {
      page(uuid: $pageUuid) {
        pageVariants {
          nodes {
            id
            variantId
            hasConversionGoal
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
    // id is a base64-encoded Relay global ID: "PageVariant-{numericId}"
    const decoded = Buffer.from(node.id, 'base64').toString('utf8')
    const match = decoded.match(/PageVariant-(\d+)/)
    if (letter && match) result[letter] = match[1]
  }
  if (!Object.keys(result).length) throw new Error(`Could not parse numeric IDs from GraphQL variant IDs`)
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
  const jwt = await getJwt(page)
  const data = await gql(page, DELETE_MUTATION, { input: { pageUuids: [pageId] } }, jwt)
  const errors = data?.deletePages?.errors
  if (errors?.length) throw new Error(errors.map(e => e.message).join('; '))
}

// ── Traffic mode + variant weights ────────────────────────────────────────────

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
  standard: 'single',
}

export async function directSetTrafficMode(page, pageId, mode, variantId = null) {
  const strategy = STRATEGY_MAP[mode]
  if (!strategy) throw new Error(`Unknown traffic mode: ${mode}`)

  const jwt = await getJwt(page)
  let config = null
  if (mode === 'standard') {
    let champion = variantId
    if (!champion) {
      const data = await gql(page, `
        query PageVariantsStateQuery($pageUuid: String!) {
          page(uuid: $pageUuid) {
            pageVariants { nodes { variantId state } }
          }
        }
      `, { pageUuid: pageId }, jwt)
      const nodes = data?.page?.pageVariants?.nodes ?? []
      const active = nodes
        .filter(n => n.state !== 'discarded')
        .map(n => n.variantId)
        .sort()
      if (!active.length) throw new Error('No active variants found to set as standard champion')
      champion = active[0]
    }
    config = { single: { variantId: champion } }
  }

  const data = await gql(page, SET_ROUTING_MUTATION, { input: { pageId, strategy, config } }, jwt)
  const errors = data?.setRoutingStrategy?.errors
  if (errors?.length) throw new Error(String(errors))
}

const CHANGE_VARIANT_WEIGHTS_MUTATION = `
mutation ChangeVariantWeightsMutation($input: ChangeVariantWeightMutationInput!) {
  changeVariantWeights(input: $input) {
    page {
      id
      championVariant { variantId variantWeight }
      challengerVariants { nodes { variantId variantWeight } }
    }
    errors { message path }
  }
}`

export async function directSetVariantWeights(page, pageId, weights) {
  const jwt = await getJwt(page)
  const weightArray = Object.entries(weights).map(([id, weight]) => ({ id, weight }))
  const data = await gql(page, CHANGE_VARIANT_WEIGHTS_MUTATION, {
    input: { pageId, weights: weightArray },
  }, jwt)
  const errors = data?.changeVariantWeights?.errors
  if (errors?.length) throw new Error(errors.map(e => e.message).join('; '))
  return data?.changeVariantWeights
}

// ── Variant lifecycle ─────────────────────────────────────────────────────────

/**
 * Resolve a variant letter to its Relay global ID via GraphQL.
 */
async function getVariantRelayId(page, pageUuid, variantLetter) {
  const jwt = await getJwt(page)
  const data = await gql(page, `
    query PageVariantIdsQuery($pageUuid: String!) {
      page(uuid: $pageUuid) {
        pageVariants { nodes { id variantId } }
      }
    }
  `, { pageUuid: pageUuid }, jwt)
  const nodes = data?.page?.pageVariants?.nodes ?? []
  const node = nodes.find(n => n.variantId?.toLowerCase() === variantLetter.toLowerCase())
  if (!node) throw new Error(`Variant "${variantLetter}" not found on page ${pageUuid}`)
  return node.id
}

const ACTIVATE_VARIANT_MUTATION = `
mutation UpdateVariantToChallengerMutation($input: UpdateVariantToChallengerInput!) {
  updateVariantToChallenger(input: $input) {
    page { id }
    errors
  }
}`

const DEACTIVATE_VARIANT_MUTATION = `
mutation DiscardVariantMutation($input: DiscardVariantInput!) {
  discardVariant(input: $input) {
    page { id }
    errors
  }
}`

const PROMOTE_VARIANT_MUTATION = `
mutation PromoteVariantMutation($input: PromoteVariantInput!) {
  promoteVariant(input: $input) {
    page { id }
    errors
  }
}`

const DELETE_VARIANT_MUTATION = `
mutation DeleteVariant($input: DeleteVariantInput!) {
  deleteVariant(input: $input) {
    errors
  }
}`

const DUPLICATE_VARIANT_MUTATION = `
mutation DuplicateVariant($input: DuplicateVariantInput!) {
  duplicateVariant(input: $input) {
    page {
      pageVariants {
        nodes { id variantId name state }
      }
    }
    errors
  }
}`

export async function directActivateVariant(page, pageUuid, variantLetter) {
  const jwt = await getJwt(page)
  const variantId = await getVariantRelayId(page, pageUuid, variantLetter)
  const data = await gql(page, ACTIVATE_VARIANT_MUTATION, { input: { variantId } }, jwt)
  const errors = data?.updateVariantToChallenger?.errors
  if (errors?.length) throw new Error(String(errors))
}

export async function directDeactivateVariant(page, pageUuid, variantLetter) {
  const jwt = await getJwt(page)
  const variantId = await getVariantRelayId(page, pageUuid, variantLetter)
  const data = await gql(page, DEACTIVATE_VARIANT_MUTATION, { input: { variantId } }, jwt)
  const errors = data?.discardVariant?.errors
  if (errors?.length) throw new Error(String(errors))
}

export async function directPromoteVariant(page, pageUuid, variantLetter) {
  const jwt = await getJwt(page)
  const variantId = await getVariantRelayId(page, pageUuid, variantLetter)
  const data = await gql(page, PROMOTE_VARIANT_MUTATION, { input: { variantId } }, jwt)
  const errors = data?.promoteVariant?.errors
  if (errors?.length) throw new Error(String(errors))
}

export async function directDeleteVariant(page, pageUuid, variantLetter) {
  const jwt = await getJwt(page)
  const variantId = await getVariantRelayId(page, pageUuid, variantLetter)
  const data = await gql(page, DELETE_VARIANT_MUTATION, { input: { variantId } }, jwt)
  const errors = data?.deleteVariant?.errors
  if (errors?.length) throw new Error(String(errors))
}

export async function directDuplicateVariant(page, pageUuid, variantLetter) {
  const jwt = await getJwt(page)

  // Fetch all variants in one query: relay ID for the source + existing letters to identify the new one
  const beforeData = await gql(page, `
    query PageVariantIdsQuery($pageUuid: String!) {
      page(uuid: $pageUuid) {
        pageVariants { nodes { id variantId } }
      }
    }
  `, { pageUuid }, jwt)
  const nodes = beforeData?.page?.pageVariants?.nodes ?? []
  const existingLetters = new Set(nodes.map(n => n.variantId?.toLowerCase()))
  const sourceNode = nodes.find(n => n.variantId?.toLowerCase() === variantLetter.toLowerCase())
  if (!sourceNode) throw new Error(`Variant "${variantLetter}" not found on page ${pageUuid}`)

  const data = await gql(page, DUPLICATE_VARIANT_MUTATION, { input: { variantId: sourceNode.id } }, jwt)
  const errors = data?.duplicateVariant?.errors
  if (errors?.length) throw new Error(String(errors))

  const allVariants = data?.duplicateVariant?.page?.pageVariants?.nodes ?? []
  const newVariant = allVariants.find(n => !existingLetters.has(n.variantId?.toLowerCase()))
  if (!newVariant) throw new Error('Could not identify the newly duplicated variant from response')

  return { variant: newVariant.variantId.toLowerCase(), name: newVariant.name, state: newVariant.state }
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

let _jwtCache = null // { token: string, expiresAt: number }

/**
 * Obtain a JWT token for authenticating editor API calls.
 * Cached in memory for 50 minutes to avoid a page navigation on every call.
 */
async function getJwt(page) {
  if (_jwtCache && Date.now() < _jwtCache.expiresAt) {
    return _jwtCache.token
  }
  let csrf = await getCsrf(page)
  if (!csrf) {
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
  _jwtCache = { token, expiresAt: Date.now() + 50 * 60 * 1000 }
  return token
}

export function clearJwtCache() {
  _jwtCache = null
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
 *
 * If newHtml is a full HTML document (starts with <!DOCTYPE or <html), the
 * bundler transforms are applied automatically: CSS is extracted and scoped,
 * forms are wrapped for Unbounce, and only the <body> content is injected.
 * An explicit newCss always takes precedence over CSS extracted from a full doc.
 *
 * If newCss is provided without a full-doc newHtml (fragment edit), it is stored
 * exactly as given — the caller is responsible for correct scoping. This is the
 * normal case when passing CSS back from get_variant (already scoped). CSS is
 * only auto-scoped when extracted from a full HTML document.
 */
export async function directEditVariant(page, numericId, newHtml, newCss, variantLetter = 'a') {
  // 1. Get JWT + current state
  const jwt = await getJwt(page)
  const { raw, elements, fullResponse } = await fetchVariantState(page, numericId, jwt)

  // 2. Detect full-doc HTML and apply bundler transforms if needed
  const isFullDoc = newHtml && /^\s*(<!DOCTYPE|<html)/i.test(newHtml)
  let resolvedHtml = newHtml || null
  let resolvedCss = newCss || null

  if (isFullDoc) {
    const { bodyHtml, cssHtml } = prepareVariantContent(newHtml, variantLetter)
    resolvedHtml = bodyHtml
    // Explicit newCss wins; fall back to CSS extracted from the full doc
    if (!resolvedCss) resolvedCss = cssHtml
  }

  // 3. Update HTML and/or CSS in the elements array
  if (resolvedHtml) {
    const el = elements.find(e => e.id === 'lp-code-1') || elements.find(e => e.type === 'lp-code')
    if (!el) throw new Error(`No lp-code element found in variant`)
    el.content.html = resolvedHtml
  }
  if (resolvedCss) {
    const el = elements.find(e => e.id === 'lp-stylesheet-1') || elements.find(e => e.type === 'lp-stylesheet')
    if (!el) throw new Error(`No lp-stylesheet element found in variant`)
    el.content.html = resolvedCss
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

// ── Rename variant ─────────────────────────────────────────────────────────────

const VARIANT_RELAY_IDS_QUERY = `
query GetVariantRelayIds($pageUuid: String!) {
  page(uuid: $pageUuid) {
    pageVariants {
      nodes { id variantId }
    }
  }
}`

const RENAME_VARIANT_MUTATION = `
mutation RenameVariant($input: RenameVariantInput!) {
  renameVariant(input: $input) {
    variant { id name }
    errors
  }
}`

export async function directRenameVariant(page, pageUuid, variantLetter, name) {
  // Get numeric ID via the existing working path, then derive the relay ID
  const jwt = await getJwt(page)
  const variantIds = await directGetVariantNumericIds(page, pageUuid)
  const numericId = variantIds[variantLetter.toLowerCase()]
  if (!numericId) throw new Error(`Variant "${variantLetter}" not found on page ${pageUuid}`)
  const relayId = Buffer.from(`PageVariant-${numericId}`).toString('base64')

  // Make the mutation via page.evaluate so browser cookies + JWT both flow correctly
  const payload = JSON.stringify({
    query: RENAME_VARIANT_MUTATION,
    variables: { input: { variantId: relayId, name } },
  })
  const result = await page.evaluate(async ([url, body, token]) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body,
    })
    return res.json()
  }, [GATEWAY, payload, jwt])

  const errors = result?.data?.renameVariant?.errors
  if (errors?.length) throw new Error(String(errors))
  if (result?.errors?.length) throw new Error(result.errors.map(e => e.message).join('; '))
  return result?.data?.renameVariant?.variant?.name
}

// ── Create variant from scratch ────────────────────────────────────────────────

/**
 * Blank template ID used by the Unbounce UI for "Start from scratch".
 * base64("PageTemplate-12359") — Unbounce's internal blank page template.
 */
const BLANK_TEMPLATE_ID = 'UGFnZVRlbXBsYXRlLTEyMzU5'

const CREATE_VARIANT_MUTATION = `
mutation CreateVariant($input: CreateVariantInput!) {
  createVariant(input: $input) {
    page {
      challengerVariants { nodes { variantId editPath } }
    }
    errors { message }
  }
}`

/**
 * The standard 4-element blank slate used for all MCP-managed variants.
 * Mirrors mainElements() in packager.js.
 */
function blankElements(bodyHtml = '', cssHtml = '') {
  return [
    {
      id: 'lp-pom-root',
      type: 'lp-pom-root',
      name: 'Page Root',
      containerId: null,
      style: {
        background: { backgroundColor: 'ffffff' },
        defaults: { linkDecoration: 'none', color: '000', linkColor: '0000ff' },
        newBackground: { type: 'solidColor', solidColor: { bgColor: 'ffffff' }, gradient: { baseColor: 'ffffff' } },
      },
      geometry: { position: 'relative', margin: 'auto', contentWidth: 1440, visible: true, scale: 1, padding: { top: 0 } },
      breakpoints: { mobile: { geometry: { visible: true, contentWidth: 320 } } },
    },
    {
      id: 'lp-pom-block-1',
      type: 'lp-pom-block',
      name: 'Content',
      containerId: 'lp-pom-root',
      style: {
        background: { fillType: 'solid', backgroundColor: 'ffffff', opacity: 100 },
        newBackground: { type: 'solidColor', solidColor: { bgColor: 'ffffff' } },
      },
      geometry: {
        position: 'relative',
        margin: { left: 'auto', right: 'auto', bottom: 0 },
        offset: { left: 0, top: 0 },
        borderLocation: 'outside',
        borderApply: { top: true, right: true, bottom: true, left: true },
        backgroundImageApply: false,
        savedBorderState: { left: true, right: true },
        fitWidthToPage: true,
        size: { width: 1440, height: 10000 },
        visible: true,
        scale: 1,
      },
      breakpoints: {
        mobile: { geometry: { visible: true, size: { width: 320, height: 10000 }, fitWidthToPage: true } },
      },
    },
    {
      id: 'lp-code-1',
      type: 'lp-code',
      name: 'Custom HTML',
      containerId: 'lp-pom-block-1',
      geometry: {
        position: 'absolute',
        offset: { left: 0, top: 0 },
        size: { width: 1440, height: 10000 },
        visible: true,
        scale: 1,
        zIndex: 1,
      },
      style: { background: { backgroundColor: 'ffffff', opacity: 0 } },
      content: { type: null, html: bodyHtml, valid: true },
      breakpoints: {
        mobile: {
          geometry: { visible: true, size: { width: 320, height: 10000 } },
          style: { background: { imageFixed: false } },
        },
      },
    },
    {
      id: 'lp-stylesheet-1',
      type: 'lp-stylesheet',
      name: 'Page Styles',
      containerId: null,
      placement: 'body:after',
      content: { type: null, html: cssHtml, valid: true },
      breakpoints: {},
    },
  ]
}

/**
 * Resolve HTML/CSS content: apply full-doc transforms if needed, scope CSS.
 */
function resolveContent(html, css, variantLetter) {
  let resolvedHtml = ''
  let resolvedCss = ''
  if (html) {
    const isFullDoc = /^\s*(<!DOCTYPE|<html)/i.test(html)
    if (isFullDoc) {
      const { bodyHtml, cssHtml } = prepareVariantContent(html, variantLetter)
      resolvedHtml = bodyHtml
      resolvedCss = css ? scopeRawCss(css) : cssHtml
    } else {
      resolvedHtml = html
      resolvedCss = css ? scopeRawCss(css) : ''
    }
  } else if (css) {
    resolvedCss = scopeRawCss(css)
  }
  return { resolvedHtml, resolvedCss }
}

/**
 * Write the blank slate elements (lp-pom-root/block/code/stylesheet) to an
 * existing variant via edit.json + save.xml. Optionally populate with content.
 * Called by both the direct and UI-fallback paths of createVariantFromScratch.
 */
export async function directInitBlankSlate(page, numericId, html, css, variantLetter) {
  const jwt = await getJwt(page)
  const { resolvedHtml, resolvedCss } = resolveContent(html, css, variantLetter)
  const { raw, fullResponse } = await fetchVariantState(page, numericId, jwt)

  raw.elements = JSON.stringify(blankElements(resolvedHtml, resolvedCss))

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

/**
 * Create a new variant via the GraphQL CreateVariant mutation using the blank
 * template ("Start from scratch"), then immediately initialize it with the
 * standard MCP blank slate elements.
 *
 * @returns {{ variant: string, numericId: string }}
 */
export async function directCreateVariantFromScratch(page, pageId, html, css) {
  const jwt = await getJwt(page)

  // 1. Create blank variant via GraphQL
  const data = await gql(page, CREATE_VARIANT_MUTATION, {
    input: { pageId, templateId: BLANK_TEMPLATE_ID, variantName: 'Variant' },
  }, jwt)

  const errors = data?.createVariant?.errors
  if (errors?.length) throw new Error(errors.map(e => e.message).join('; '))

  // 2. Find the new variant from challengerVariants (highest letter = most recently added)
  const challengers = data?.createVariant?.page?.challengerVariants?.nodes ?? []
  if (!challengers.length) throw new Error('createVariant returned no challenger variants')
  const newest = challengers.sort((a, b) => b.variantId.localeCompare(a.variantId))[0]

  const variantLetter = newest.variantId
  const numericMatch = newest.editPath?.match(/\/variants\/(\d+)\//)
  if (!numericMatch) throw new Error(`Could not parse numeric ID from editPath: ${newest.editPath}`)
  const numericId = numericMatch[1]

  // 3. Initialize with blank slate (replaces template default elements)
  await directInitBlankSlate(page, numericId, html, css, variantLetter)

  return { variant: variantLetter, numericId }
}

// ── Page stats (bulk, simple) ─────────────────────────────────────────────────

const PAGE_STATS_SIMPLE_QUERY = `
query PageStatsQuery($pageUuid: String!) {
  statsProxy(pageUuid: $pageUuid) {
    pageStats {
      visitors
      conversions
      conversionRate
    }
  }
}`

async function batchedParallel(items, fn, batchSize = 25) {
  const results = []
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize)
    results.push(...await Promise.all(batch.map(fn)))
  }
  return results
}

export async function directGetBulkPageStats(page, pageIds) {
  const jwt = await getJwt(page)
  return batchedParallel(pageIds, async (pageId) => {
    const data = await gql(page, PAGE_STATS_SIMPLE_QUERY, { pageUuid: pageId }, jwt)
    const stats = data?.statsProxy?.pageStats ?? {}
    return {
      page_id: pageId,
      visitors: parseInt(stats.visitors ?? '0', 10),
      conversions: parseInt(stats.conversions ?? '0', 10),
      conversion_rate: parseFloat(stats.conversionRate ?? '0'),
    }
  })
}

// ── Page stats ────────────────────────────────────────────────────────────────

const PAGE_STATS_QUERY = `
query PageStatsProxy($pageUuid: String!, $includeConfidence: Boolean!, $startDate: String, $endDate: String) {
  statsProxy(pageUuid: $pageUuid, startDate: $startDate, endDate: $endDate) {
    pageVariantStats {
      nodes {
        ...pageVariantStatsFragment
      }
    }
    pageStats {
      conversions
      conversionRate
      visits
      visitors
    }
    lastResetAt
  }
}
fragment pageVariantStatsFragment on PageVariantStats {
  id
  confidence @include(if: $includeConfidence)
  conversions
  conversionRate
  conversionRateDelta
  visits
  visitors
  variantId
}`

export async function directGetPageStats(page, pageId, { startDate, endDate } = {}) {
  const jwt = await getJwt(page)
  const data = await gql(page, PAGE_STATS_QUERY, {
    pageUuid: pageId,
    includeConfidence: true,
    ...(startDate ? { startDate } : {}),
    ...(endDate ? { endDate } : {}),
  }, jwt)
  return data?.statsProxy ?? null
}

// ── Page insights (IBR / traffic recommendations) ─────────────────────────────

const ALL_INSIGHTS_QUERY = `
query AllInsightsQuery($keys: [String!]) {
  allInsights(keys: $keys, tags: ["page-overview", "panel-widget"]) {
    id
    name
    key
    lifecycle
    payload
    uxState
    updatedAt
  }
}`

const INSIGHTS_QUERY = `
query InsightsQuery($identifiers: [InsightIdentifier!]!) {
  insights(identifiers: $identifiers) {
    id
    name
    key
    lifecycle
    payload
    uxState
    updatedAt
  }
}`

// Additional named insights not returned by AllInsightsQuery
const EXTRA_INSIGHT_NAMES = ['readability-insights']

function parseInsights(nodes) {
  return (nodes ?? [])
    .filter(i => i.lifecycle === 'available')
    .map(i => {
      let payload = {}
      try { payload = JSON.parse(i.payload) } catch {}
      return { name: i.name, payload, updatedAt: i.updatedAt }
    })
}

export async function directGetPageInsights(page, pageId) {
  const pageKey = `page:${pageId}`
  const jwt = await getJwt(page)
  const [allData, extraData] = await Promise.all([
    gql(page, ALL_INSIGHTS_QUERY, { keys: [pageKey] }, jwt),
    gql(page, INSIGHTS_QUERY, {
      identifiers: EXTRA_INSIGHT_NAMES.map(name => ({ name, key: pageKey })),
    }, jwt),
  ])

  const seen = new Set()
  const merged = []
  for (const insight of [
    ...parseInsights(allData?.allInsights),
    ...parseInsights(extraData?.insights),
  ]) {
    if (!seen.has(insight.name)) {
      seen.add(insight.name)
      merged.push(insight)
    }
  }
  return merged
}

// ── Search pages ──────────────────────────────────────────────────────────────

const VIEWER_QUERY = `
query ViewerQuery {
  viewer {
    account { uuid }
  }
}`

const PAGES_SEARCH_QUERY = `
query PagesQuery($uuid: String!, $first: Int!, $after: Int, $wherePage: PageFilterInput) {
  company(uuid: $uuid) {
    pages(first: $first, after: $after, wherePage: $wherePage) {
      nodes {
        uuid
        name
        url
        fullUrl
        state
        lastPublishedAt
        updatedAt
      }
      totalCount
    }
  }
}`

export async function directSearchPages(page, query, { limit = 20, offset = 0 } = {}) {
  const jwt = await getJwt(page)
  const viewerData = await gql(page, VIEWER_QUERY, {}, jwt)
  const companyUuid = viewerData?.viewer?.account?.uuid
  if (!companyUuid) throw new Error('Could not resolve company UUID from viewer query')

  const data = await gql(page, PAGES_SEARCH_QUERY, {
    uuid: companyUuid,
    first: limit,
    after: offset,
    wherePage: { nameContains: query },
  }, jwt)

  const nodes = data?.company?.pages?.nodes ?? []
  const totalCount = data?.company?.pages?.totalCount ?? 0
  return {
    pages: nodes.map(p => ({
      page_id: p.uuid,
      name: p.name,
      url: p.url ?? p.fullUrl,
      state: p.state,
      last_published_at: p.lastPublishedAt ?? null,
    })),
    total: totalCount,
  }
}

// ── Duplicate page ─────────────────────────────────────────────────────────────

const PAGE_INTEGRATIONS_QUERY = `
query PageIntegrationsQuery($uuid: String!) {
  page(uuid: $uuid) {
    integrations { nodes { label duplicationId } }
  }
}`

const PAGE_VARIANTS_QUERY = `
query VariantsQuery($uuid: String!) {
  page(uuid: $uuid) {
    championVariant { pageVariantId variantId }
    challengerVariants { nodes { pageVariantId variantId } }
    discardedVariants { nodes { pageVariantId variantId } }
  }
}`

const DUPLICATE_PAGE_MUTATION = `
mutation DuplicatePage($input: DuplicatePageInput!) {
  duplicatePage(input: $input) {
    page { uuid name url fullUrl state }
    errors
  }
}`

export async function directFetchDuplicationOptions(page, pageUuid) {
  const jwt = await getJwt(page)
  const [intData, varData] = await Promise.all([
    gql(page, PAGE_INTEGRATIONS_QUERY, { uuid: pageUuid }, jwt),
    gql(page, PAGE_VARIANTS_QUERY, { uuid: pageUuid }, jwt),
  ])
  const integrations = intData?.page?.integrations?.nodes ?? []
  const p = varData?.page ?? {}
  const active = [p.championVariant, ...(p.challengerVariants?.nodes ?? [])].filter(Boolean)
  const inactive = p.discardedVariants?.nodes ?? []
  return { integrations, active, inactive }
}

export async function directDuplicatePage(page, pageUuid, variantIds, integrationDuplicationIds) {
  const jwt = await getJwt(page)
  const data = await gql(page, DUPLICATE_PAGE_MUTATION, {
    input: { pageUuid, variantIds, integrationDuplicationIds },
  }, jwt)
  const errors = data?.duplicatePage?.errors
  if (errors?.length) throw new Error(Array.isArray(errors) ? errors.join('; ') : String(errors))
  return data?.duplicatePage?.page
}

// ── Page variants (champion + all) ────────────────────────────────────────────

const PAGE_VARIANTS_DETAILED_QUERY = `
query PageVariantsDetailed($uuid: String!) {
  page(uuid: $uuid) {
    state
    previewPath
    championVariant {
      variantId
      name
      variantWeight
      state
      previewPath
      updatedAt
    }
    challengerVariants {
      nodes {
        variantId
        name
        variantWeight
        state
        previewPath
        updatedAt
      }
    }
    discardedVariants {
      nodes {
        variantId
        name
        variantWeight
        state
        previewPath
        updatedAt
      }
    }
  }
}`

function mapVariant(v, role) {
  return {
    variant: v.variantId,
    name: v.name,
    weight: v.variantWeight,
    state: v.state,
    role,
    preview_path: v.previewPath ?? null,
    updated_at: v.updatedAt ?? null,
  }
}

export async function directGetPageVariants(page, pageUuid) {
  const jwt = await getJwt(page)
  const data = await gql(page, PAGE_VARIANTS_DETAILED_QUERY, { uuid: pageUuid }, jwt)
  const p = data?.page
  if (!p) throw new Error(`No page data returned for UUID ${pageUuid}`)
  const champion = p.championVariant ? mapVariant(p.championVariant, 'champion') : null
  const challengers = (p.challengerVariants?.nodes ?? []).map(v => mapVariant(v, 'challenger'))
  const discarded = (p.discardedVariants?.nodes ?? []).map(v => mapVariant(v, 'discarded'))
  return {
    page_state: p.state,
    champion,
    variants: [champion, ...challengers, ...discarded].filter(Boolean),
  }
}

/**
 * Navigate to a variant's preview page and extract the live iframe URL (with auth token).
 * The iframe URL is for agent inspection only — it expires and should not be shared with users.
 * For sharing with users, use the previewPath returned by directGetPageVariants prefixed with APP_BASE.
 */
export async function directGetVariantPreviewUrl(page, previewPath) {
  await page.goto(`${APP_BASE}${previewPath}`, { waitUntil: 'networkidle', timeout: 30000 })
  const iframeSrc = await page.evaluate(() => document.getElementById('page-preview')?.src)
  if (!iframeSrc) throw new Error('Preview iframe not found — the page may not have loaded correctly')
  return {
    preview_url: iframeSrc,
    share_url: `${APP_BASE}${previewPath}`,
  }
}
