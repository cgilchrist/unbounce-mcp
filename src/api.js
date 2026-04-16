/**
 * Unbounce REST API calls — all authenticated via API key.
 * Docs: https://developer.unbounce.com/api_reference/
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

export async function getSubAccountPages(subAccountId) {
  const data = await apiFetch(`/sub_accounts/${subAccountId}/pages`)
  return (data.pages || []).map(p => ({
    id: p.id,
    name: p.name,
    url: p.url,
    state: p.state,
    created_at: p.created_at,
  }))
}

export async function getSubAccountPageGroups(subAccountId) {
  const data = await apiFetch(`/sub_accounts/${subAccountId}/page_groups`)
  return (data.pageGroups || data.page_groups || []).map(g => ({
    id: g.id,
    name: g.name,
    created_at: g.created_at,
  }))
}

export async function getPage(pageId) {
  const p = await apiFetch(`/pages/${pageId}`)
  return {
    id: p.id,
    name: p.name,
    url: p.url,
    state: p.state,
    created_at: p.created_at,
    last_published_at: p.last_published_at,
    variants_count: p.variants_count,
    domain: p.domain,
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
      created_at: l.created_at,
      form_data: l.form_data,
      extra_data: l.extra_data,
    })),
    total_count: data.total_count,
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
    first_name: u.first_name,
    last_name: u.last_name,
    created_at: u.created_at,
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
