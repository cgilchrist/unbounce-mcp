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

export async function getPage(pageId) {
  return apiFetch(`/pages/${pageId}`)
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
