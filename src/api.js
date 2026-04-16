/**
 * Unbounce REST API calls — all authenticated via API key.
 * Docs: https://developer.unbounce.com/api_reference/
 *
 * Note: The Unbounce API returns camelCase field names (e.g. variantsCount,
 * createdAt, lastPublishedAt). We map these to snake_case in our responses
 * for consistency.
 */

import { UNBOUNCE_API_BASE, requireApiKey } from './config.js'

async function apiFetch(path, options = {}) {
  const apiKey = requireApiKey()
  const url = `${UNBOUNCE_API_BASE}${path}`
  const res = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Unbounce API error ${res.status} on ${path}: ${text}`)
  }
  return res.json()
}

export async function getAccounts() {
  const data = await apiFetch('/accounts')
  return (data.accounts || []).map(a => ({ id: a.id, name: a.name }))
}

export async function getSubAccounts(accountId) {
  const data = await apiFetch(`/accounts/${accountId}/sub_accounts`)
  return (data.subAccounts || data.sub_accounts || []).map(s => ({ id: s.id, name: s.name }))
}

export async function getDomains(subAccountId) {
  const data = await apiFetch(`/sub_accounts/${subAccountId}/domains`)
  return (data.domains || []).map(d => ({
    id: d.id,
    name: d.name,
    url: d.url,
  }))
}

/**
 * Fetch all pages from an endpoint, paginating automatically.
 * Uses a separate count=true call (without with_stats) to get the true total,
 * then fetches all batches in parallel.
 */
async function paginatedFetch(endpoint, baseParams) {
  const limit = 1000

  // Get true total via count=true (strip with_stats — not needed for counting)
  const countParams = new URLSearchParams(baseParams)
  countParams.set('count', 'true')
  countParams.delete('with_stats')
  const countData = await apiFetch(`${endpoint}?${countParams}`)
  const total = countData.metadata?.count ?? 0

  if (total === 0) return []

  // Fetch all batches in parallel
  const offsets = Array.from({ length: Math.ceil(total / limit) }, (_, i) => i * limit)
  const results = await Promise.all(
    offsets.map(offset => {
      const p = new URLSearchParams(baseParams)
      p.set('limit', String(limit))
      p.set('offset', String(offset))
      return apiFetch(`${endpoint}?${p}`)
    })
  )

  return results.flatMap(data => data.pages || [])
}

function mapPage(p, { includeStats = false } = {}) {
  const out = {
    id: p.id,
    name: p.name,
    url: p.url,
    state: p.state,
    created_at: p.createdAt ?? null,
    last_published_at: p.lastPublishedAt ?? null,
    variants_count: p.variantsCount ?? null,
    domain: p.domain ?? null,
  }
  if (includeStats) out.tests = p.tests ?? null
  return out
}

export async function getSubAccountPages(subAccountId, { from, to, sortOrder = 'asc', countOnly = false, withStats = false } = {}) {
  const base = new URLSearchParams({ sort_order: sortOrder })
  if (from) base.set('from', from)
  if (to) base.set('to', to)

  // Count-only mode — fast single call
  if (countOnly) {
    const countParams = new URLSearchParams(base)
    countParams.set('count', 'true')
    const data = await apiFetch(`/sub_accounts/${subAccountId}/pages?${countParams}`)
    return { count: data.metadata?.count ?? 0 }
  }

  if (withStats) base.set('with_stats', 'true')

  const all = await paginatedFetch(`/sub_accounts/${subAccountId}/pages`, base)
  return all.map(p => mapPage(p, { includeStats: withStats }))
}

export async function getSubAccountPageGroups(subAccountId) {
  const data = await apiFetch(`/sub_accounts/${subAccountId}/page_groups`)
  return (data.pageGroups || data.page_groups || []).map(g => ({
    id: g.id,
    name: g.name,
    created_at: g.createdAt ?? g.created_at ?? null,
  }))
}

export async function getPage(pageId) {
  const p = await apiFetch(`/pages/${pageId}`)
  return {
    id: p.id,
    name: p.name,
    url: p.url,
    state: p.state,
    created_at: p.createdAt ?? p.created_at ?? null,
    last_published_at: p.lastPublishedAt ?? p.last_published_at ?? null,
    variants_count: p.variantsCount ?? p.variants_count ?? null,
    domain: p.domain ?? null,
    tests: p.tests ?? null,
  }
}

export async function getPageFormFields(pageId) {
  const data = await apiFetch(`/pages/${pageId}/form_fields`)
  return data.formFields || data.form_fields || []
}

export async function getPageLeads(pageId, { offset = 0, count = 50 } = {}) {
  const data = await apiFetch(`/pages/${pageId}/leads?offset=${offset}&count=${count}`)
  return {
    leads: (data.leads || []).map(l => ({
      id: l.id,
      created_at: l.createdAt ?? l.created_at,
      form_data: l.formData ?? l.form_data,
      extra_data: l.extraData ?? l.extra_data,
    })),
    total_count: data.totalCount ?? data.total_count,
    offset: data.offset,
    count: data.count,
  }
}

export async function getLead(leadId) {
  return apiFetch(`/leads/${leadId}`)
}

export async function getUsers() {
  const data = await apiFetch('/users')
  return (data.users || []).map(u => ({
    id: u.id,
    email: u.email,
    first_name: u.firstName ?? u.first_name,
    last_name: u.lastName ?? u.last_name,
    created_at: u.createdAt ?? u.created_at,
  }))
}


/**
 * Poll for a new page to appear after upload.
 * @param {string} subAccountId
 * @param {string[]} knownPageIds - page IDs that existed before upload
 * @param {number} timeoutMs
 * @returns {Promise<{id: string, name: string, url: string, state: string}>}
 */
export async function pollForNewPage(subAccountId, knownPageIds, timeoutMs = 30000) {
  const knownSet = new Set(knownPageIds)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000))
    const pages = await getSubAccountPages(subAccountId)
    const newPage = pages.find(p => !knownSet.has(p.id))
    if (newPage) return newPage
  }
  throw new Error('Timed out waiting for uploaded page to appear. It may still be processing — check your Unbounce account.')
}

/**
 * Poll until page status matches expected state.
 * @param {string} pageId
 * @param {'published'|'unpublished'} targetState
 * @param {number} timeoutMs
 */
export async function pollPageStatus(pageId, targetState, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 3000))
    const page = await getPage(pageId)
    if (page.state === targetState) return page
  }
  throw new Error(`Timed out waiting for page to reach state: ${targetState}`)
}
