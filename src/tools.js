/**
 * MCP tool definitions and handlers.
 * Each tool maps to one or more API / browser actions.
 */

import * as fs from 'fs'
import * as path from 'path'
import { packageToUnbounce } from './packager.js'
import {
  getAccounts, getSubAccounts, getDomains,
  getSubAccountPages, getSubAccountPageGroups,
  getPage, getPageFormFields, getPageLeads, getLead,
  getUsers, pollForNewPage, pollPageStatus, searchPagesByName,
} from './api.js'
import { uploadPage } from './upload.js'
import {
  getUploadCredentials, setPageUrl, setTrafficMode,
  setVariantWeights, publishPage, unpublishPage, deletePage, duplicatePage, findPages,
  getPageInsights, getPageStats, findPagesByStats, editVariantHtml, getVariantContent, addVariant,
  renameVariant, getPageVariants, getVariantPreviewUrl, screenshotVariant,
  activateVariant, deactivateVariant, promoteVariant, deleteVariant,
} from './browser.js'

/** Compute even integer split weights that sum to 100. Champion (variant a) gets the +1 remainder. */
function evenWeights(variantIds) {
  const n = variantIds.length
  const base = Math.floor(100 / n)
  const remainder = 100 - base * n
  const weights = {}
  variantIds.forEach((id, i) => {
    weights[id] = i === 0 ? base + remainder : base
  })
  return weights
}

/** Slugify a page name into a URL-safe path segment */
function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'page'
}

/**
 * Shared upload + configure + publish pipeline.
 * Used by both deploy_page and upload_unbounce_file.
 */
async function uploadAndConfigure({ fileBuffer, fileName, pageName, subAccountId, domain, slug, trafficMode, variantWeights, variantIds, htmlFiles, isMultiVariant, publish }) {
  // Snapshot existing pages before upload
  const existingPages = await getSubAccountPages(subAccountId)
  const existingIds = existingPages.map(p => p.id)

  // Upload
  const { cookies, csrfToken } = await getUploadCredentials(subAccountId)
  await uploadPage(subAccountId, fileBuffer, fileName, cookies, csrfToken)

  // Poll for the new page — if this times out the file was uploaded but we can't find it yet
  let newPage
  try {
    newPage = await pollForNewPage(subAccountId, existingIds)
  } catch (err) {
    throw new Error(
      `File was uploaded to Unbounce but the new page could not be found (${err.message}). ` +
      `Do NOT re-upload — call list_pages to locate the page, then use set_page_url and publish_page to complete setup.`
    )
  }
  const pageId = newPage.id

  // ── Post-upload steps: page exists now — never let errors swallow the pageId ──
  const pendingSteps = []
  let urlSet = !domain // if no domain was requested, URL step is satisfied

  // Set URL
  if (domain) {
    const resolvedSlug = slug !== undefined ? slug : slugify(pageName)
    try {
      await setPageUrl(subAccountId, pageId, domain, resolvedSlug)
      urlSet = true
    } catch (err) {
      const isTaken = err.message?.includes('already taken')
      pendingSteps.push({
        step: 'set_page_url',
        tool: 'set_page_url',
        args: { sub_account_id: subAccountId, page_id: pageId, domain, slug: resolvedSlug },
        error: isTaken
          ? `slug "${resolvedSlug}" is already taken — choose a different slug then call set_page_url, then publish_page`
          : err.message,
      })
    }
  }

  // Traffic mode + variant weights
  if (isMultiVariant) {
    const resolvedMode = trafficMode || 'ab_test'
    try {
      await setTrafficMode(subAccountId, pageId, resolvedMode)
      if (resolvedMode === 'ab_test') {
        const weights = variantWeights || evenWeights(variantIds)
        try {
          await setVariantWeights(subAccountId, pageId, weights)
        } catch (err) {
          pendingSteps.push({
            step: 'set_variant_weights',
            tool: 'set_variant_weights',
            args: { sub_account_id: subAccountId, page_id: pageId, weights },
            error: err.message,
          })
        }
      }
    } catch (err) {
      pendingSteps.push({
        step: 'set_traffic_mode',
        tool: 'set_traffic_mode',
        args: { sub_account_id: subAccountId, page_id: pageId, mode: resolvedMode },
        error: err.message,
      })
    }
  }

  // Publish — skip if URL wasn't set (would publish at wrong/UUID slug)
  let liveUrl = null
  if (publish) {
    if (!urlSet) {
      pendingSteps.push({
        step: 'publish_page',
        tool: 'publish_page',
        args: { sub_account_id: subAccountId, page_id: pageId },
        error: 'skipped — assign a URL first, then call publish_page',
      })
    } else {
      try {
        await publishPage(subAccountId, pageId)
        const published = await pollPageStatus(pageId, 'published')
        liveUrl = published.url
      } catch (err) {
        pendingSteps.push({
          step: 'publish_page',
          tool: 'publish_page',
          args: { sub_account_id: subAccountId, page_id: pageId },
          error: err.message,
        })
      }
    }
  }

  return {
    page_id: pageId,
    page_name: pageName,
    url: liveUrl,
    variants_deployed: variantIds.map((letter, i) => ({
      variant: letter,
      html_bytes: htmlFiles?.[i]?.html?.length ?? null,
    })),
    traffic_mode: isMultiVariant ? (trafficMode || 'ab_test') : 'standard',
    ...(pendingSteps.length > 0 && { pending_steps: pendingSteps }),
    note: pendingSteps.length > 0
      ? `Page was created (page_id: ${pageId}) but some steps did not complete. Do NOT re-deploy — use the tools listed in pending_steps to finish setup.`
      : "FYI — you'll get a confirmation email from Unbounce confirming the page was uploaded to your account.",
  }
}

export const TOOL_DEFINITIONS = [
  {
    name: 'list_accounts',
    description: 'List all Unbounce accounts accessible via the configured API key.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'list_sub_accounts',
    description: 'List sub-accounts (clients) within an Unbounce account.',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: { type: 'string', description: 'The account ID from list_accounts' },
      },
      required: ['account_id'],
    },
  },
  {
    name: 'list_domains',
    description: 'List domains available in a sub-account for publishing pages.',
    inputSchema: {
      type: 'object',
      properties: {
        sub_account_id: { type: 'string', description: 'The sub-account ID from list_sub_accounts' },
      },
      required: ['sub_account_id'],
    },
  },
  {
    name: 'list_pages',
    description: 'List all landing pages in a sub-account. Handles pagination automatically. Use count_only=true to quickly get the total number of pages without fetching the full list. Use with_stats=true when the user asks about traffic, visitors, conversions, or wants to filter/compare pages by performance (e.g. "pages with more than 10,000 visitors") — this is slower but returns stats in a single operation instead of requiring individual get_page calls.',
    inputSchema: {
      type: 'object',
      properties: {
        sub_account_id: { type: 'string' },
        with_stats: { type: 'boolean', description: 'Include traffic and A/B test stats (visitors, conversions, conversion rate, variants_count, etc.) for each page. Use when filtering or comparing pages by performance. Slower than a plain list. NOTE: variants_count is the number of additional variants beyond the champion — it is always 1 less than the actual total. A page with variants_count: 0 has exactly 1 variant (no A/B test). A page with variants_count: 1 has 2 variants total, etc.' },
        count_only: { type: 'boolean', description: 'Return only the total count of pages, not the list. Fast — use before fetching all pages or when the user just wants to know how many pages exist.' },
        from: { type: 'string', description: 'ISO 8601 datetime — only return pages created after this date.' },
        to: { type: 'string', description: 'ISO 8601 datetime — only return pages created before this date.' },
        sort_order: { type: 'string', enum: ['asc', 'desc'], description: 'Sort by creation date. Default: asc.' },
      },
      required: ['sub_account_id'],
    },
  },
  {
    name: 'get_page',
    description: 'Get details of a specific Unbounce page including state, URL, variant count, and publish date. NOTE: variants_count is the number of additional variants beyond the champion — always 1 less than the actual total. variants_count: 0 means exactly 1 variant (no A/B test running).',
    inputSchema: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'The page UUID' },
      },
      required: ['page_id'],
    },
  },
  {
    name: 'list_page_groups',
    description: 'List page groups (folders) within a sub-account.',
    inputSchema: {
      type: 'object',
      properties: {
        sub_account_id: { type: 'string' },
      },
      required: ['sub_account_id'],
    },
  },
  {
    name: 'list_leads',
    description: 'Retrieve form submission leads for a specific page. Supports pagination.',
    inputSchema: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'The page UUID' },
        offset: { type: 'number', description: 'Pagination offset (default 0)' },
        count: { type: 'number', description: 'Number of leads to return (default 50, max 1000)' },
      },
      required: ['page_id'],
    },
  },
  {
    name: 'get_lead',
    description: 'Get a single lead by ID.',
    inputSchema: {
      type: 'object',
      properties: {
        lead_id: { type: 'string' },
      },
      required: ['lead_id'],
    },
  },
  {
    name: 'list_users',
    description: 'List all users with access to the Unbounce account.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'upload_unbounce_file',
    description: 'Upload a pre-packaged .unbounce file to Unbounce, optionally configure the URL and traffic mode, and publish it. Use this when you already have a .unbounce file. For raw HTML files, use deploy_page instead.',
    inputSchema: {
      type: 'object',
      properties: {
        unbounce_file_path: {
          type: 'string',
          description: 'Absolute path to the .unbounce file on disk.',
        },
        sub_account_id: { type: 'string' },
        page_name: {
          type: 'string',
          description: 'Name for the page in Unbounce. Defaults to the filename.',
        },
        domain: {
          type: 'string',
          description: 'Domain to publish on (e.g. "unbouncepages.com"). Get options from list_domains.',
        },
        slug: {
          type: 'string',
          description: 'URL path segment (e.g. "summer-promo"). Defaults to a slugified page name.',
        },
        traffic_mode: {
          type: 'string',
          enum: ['ab_test', 'smart_traffic'],
          description: 'Traffic routing mode for multi-variant pages. Defaults to "ab_test" with even split.',
        },
        variant_weights: {
          type: 'object',
          description: 'Custom A/B weights per variant letter (e.g. {"a": 70, "b": 30}). Must sum to 100.',
          additionalProperties: { type: 'number' },
        },
        publish: {
          type: 'boolean',
          description: 'Whether to publish immediately after setup. Defaults to true.',
        },
      },
      required: ['unbounce_file_path', 'sub_account_id'],
    },
  },
  {
    name: 'deploy_page',
    description: 'Package one or more HTML variants into an Unbounce page, upload it, configure the URL and traffic mode, and publish it. Returns the live URL. Accepts raw HTML strings (html_variants) or file paths (html_file_paths) — provide one or the other. Multiple variants create an A/B test (A, B, C...). For pre-packaged .unbounce files, use upload_unbounce_file instead.',
    inputSchema: {
      type: 'object',
      properties: {
        html_variants: {
          type: 'array',
          items: { type: 'string' },
          description: 'Raw HTML strings for each variant. Use this when you have generated HTML in memory. Multiple items = A/B test variants (A, B, C...).',
        },
        html_file_paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Absolute paths to HTML files on disk. Use this when HTML files already exist locally. Multiple files = A/B test variants (A, B, C...).',
        },
        page_name: {
          type: 'string',
          description: 'Name for the page in Unbounce (shown in the dashboard).',
        },
        sub_account_id: {
          type: 'string',
          description: 'The sub-account/client ID to upload to.',
        },
        domain: {
          type: 'string',
          description: 'Domain name to publish on (e.g. "unbouncepages.com" or a custom domain). Get options from list_domains.',
        },
        slug: {
          type: 'string',
          description: 'URL path segment (e.g. "summer-promo"). Leave empty for homepage. Defaults to a slugified page name.',
        },
        traffic_mode: {
          type: 'string',
          enum: ['ab_test', 'smart_traffic'],
          description: 'Traffic routing mode. Defaults to "ab_test" for multi-variant pages with even split, "smart_traffic" for AI-based routing.',
        },
        variant_weights: {
          type: 'object',
          description: 'Custom A/B weight per variant letter (e.g. {"a": 70, "b": 30}). Must sum to 100. Only used when traffic_mode is "ab_test". Defaults to even split.',
          additionalProperties: { type: 'number' },
        },
        publish: {
          type: 'boolean',
          description: 'Whether to publish immediately after setup. Defaults to true.',
        },
      },
      required: ['sub_account_id'],
    },
  },
  {
    name: 'publish_page',
    description: 'Publish (or republish) an existing Unbounce page. Returns the live URL.',
    inputSchema: {
      type: 'object',
      properties: {
        sub_account_id: { type: 'string' },
        page_id: { type: 'string', description: 'The page UUID from Unbounce' },
      },
      required: ['sub_account_id', 'page_id'],
    },
  },
  {
    name: 'unpublish_page',
    description: 'Unpublish an Unbounce page, taking it offline.',
    inputSchema: {
      type: 'object',
      properties: {
        sub_account_id: { type: 'string' },
        page_id: { type: 'string' },
      },
      required: ['sub_account_id', 'page_id'],
    },
  },
  {
    name: 'delete_page',
    description: 'Permanently delete an Unbounce page and all its variants. This cannot be undone. Always ask the user for explicit confirmation before calling this tool.',
    inputSchema: {
      type: 'object',
      properties: {
        sub_account_id: { type: 'string' },
        page_id: { type: 'string' },
        confirm: {
          type: 'boolean',
          description: 'Must be true to proceed. Ask the user to confirm before setting this.',
        },
      },
      required: ['sub_account_id', 'page_id', 'confirm'],
    },
  },
  {
    name: 'set_page_url',
    description: 'Change the domain and/or URL slug of an existing Unbounce page.',
    inputSchema: {
      type: 'object',
      properties: {
        sub_account_id: { type: 'string' },
        page_id: { type: 'string' },
        domain: { type: 'string', description: 'Domain to publish on' },
        slug: { type: 'string', description: 'URL path segment. Empty string = homepage.' },
      },
      required: ['sub_account_id', 'page_id', 'domain', 'slug'],
    },
  },
  {
    name: 'set_traffic_mode',
    description: 'Switch a page traffic mode. Modes: standard (all traffic to one variant), ab_test (manual split), smart_traffic (AI-optimised). If the page is published, it will be republished automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        sub_account_id: { type: 'string' },
        page_id: { type: 'string' },
        mode: {
          type: 'string',
          enum: ['standard', 'ab_test', 'smart_traffic'],
        },
        variant_id: {
          type: 'string',
          description: 'For standard mode: which variant letter (a, b, c…) receives all traffic. Defaults to "a".',
        },
      },
      required: ['sub_account_id', 'page_id', 'mode'],
    },
  },
  {
    name: 'set_variant_weights',
    description: 'Set A/B test traffic split percentages for a multi-variant page. Weights must be integers summing to 100. Automatically switches the page to A/B test routing mode if it is in standard or smart traffic mode. IMPORTANT: all variants included in the weights must be active (not discarded) — if a variant was just added to a standard-mode page, call activate_variant on it first or it will remain inactive and receive no traffic. Page will be republished if it was already live.',
    inputSchema: {
      type: 'object',
      properties: {
        sub_account_id: { type: 'string' },
        page_id: { type: 'string' },
        weights: {
          type: 'object',
          description: 'Variant weights by letter, e.g. {"a": 50, "b": 25, "c": 25}. Must sum to 100, integers only.',
          additionalProperties: { type: 'number' },
        },
      },
      required: ['sub_account_id', 'page_id', 'weights'],
    },
  },
  {
    name: 'find_page',
    description: 'Search for pages by name. Use this whenever the user refers to a page by name and you need its page_id and sub_account_id. Returns matching pages including sub_account_id required by other tools. If you already know the sub_account_id, pass it to skip the broad search. Otherwise pass account_id to scope to one account, or omit both to search everything.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Page name or partial name to search for (case-insensitive).' },
        sub_account_id: { type: 'string', description: 'Search only within this sub-account. Fastest option if already known.' },
        account_id: { type: 'string', description: 'Search all sub-accounts within this account. Used when sub_account_id is unknown.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'duplicate_page',
    description: 'Duplicate an existing Unbounce page, including its variants and integrations. The new page is created unpublished in the same sub-account. Use set_page_url and publish_page afterwards if needed.',
    inputSchema: {
      type: 'object',
      properties: {
        sub_account_id: { type: 'string' },
        page_id: { type: 'string', description: 'UUID of the page to duplicate.' },
        include_inactive_variants: {
          type: 'boolean',
          description: 'Also copy inactive/discarded variants. Default false.',
        },
        copy_integrations: {
          description: '"all" (default) copies all integrations. "none" copies none. Or pass an array of integration labels to copy selectively, e.g. ["MailChimp"].',
          oneOf: [
            { type: 'string', enum: ['all', 'none'] },
            { type: 'array', items: { type: 'string' } },
          ],
        },
      },
      required: ['sub_account_id', 'page_id'],
    },
  },
  {
    name: 'find_pages_by_stats',
    description: 'Filter pages in a sub-account by their performance stats — visitors, conversions, and conversion rate. Fetches all pages then queries stats in batches of 25. Useful for audits: find pages with no traffic, zero conversions, high performers, etc. Returns matching pages with their stats.',
    inputSchema: {
      type: 'object',
      properties: {
        sub_account_id: { type: 'string' },
        min_visitors: { type: 'number', description: 'Minimum total visitors.' },
        max_visitors: { type: 'number', description: 'Maximum total visitors.' },
        min_conversions: { type: 'number', description: 'Minimum total conversions.' },
        max_conversions: { type: 'number', description: 'Maximum total conversions.' },
        min_conversion_rate: { type: 'number', description: 'Minimum conversion rate (percentage, e.g. 5 = 5%).' },
        max_conversion_rate: { type: 'number', description: 'Maximum conversion rate (percentage, e.g. 5 = 5%).' },
      },
      required: ['sub_account_id'],
    },
  },
  {
    name: 'get_page_stats',
    description: 'Get visitors, visits, conversions, and conversion rate for a page — both page-level totals and broken down by variant. Optionally filter by date range. Use this to understand page performance before making optimization decisions.',
    inputSchema: {
      type: 'object',
      properties: {
        sub_account_id: { type: 'string' },
        page_id: { type: 'string', description: 'UUID of the page.' },
        start_date: { type: 'string', description: 'Start of date range (ISO 8601, e.g. 2026-01-01). Omit for all-time stats.' },
        end_date: { type: 'string', description: 'End of date range (ISO 8601, e.g. 2026-04-01). Omit for all-time stats.' },
      },
      required: ['sub_account_id', 'page_id'],
    },
  },
  {
    name: 'get_page_insights',
    description: 'Get Unbounce Industry Benchmark Report (IBR) insights for a page. Returns available insights only — excluded insights (criteria not met) are omitted. Insights include: industry percentile rank and performance rating (ibr-insights), recommended traffic channels (traffic/trafficChannel), and Smart Traffic recommendations (traffic/estimatedLiftInsight, traffic/deactivateVariant). Use this to understand how a page is performing relative to its industry and what Unbounce recommends to improve it.',
    inputSchema: {
      type: 'object',
      properties: {
        sub_account_id: { type: 'string' },
        page_id: { type: 'string', description: 'UUID of the page.' },
      },
      required: ['sub_account_id', 'page_id'],
    },
  },
  {
    name: 'get_variant',
    description: 'Read the current HTML and CSS of a specific variant on an Unbounce page. Use this before making edits so you can make targeted changes rather than rewriting from scratch.',
    inputSchema: {
      type: 'object',
      properties: {
        sub_account_id: { type: 'string' },
        page_id: { type: 'string', description: 'UUID of the page' },
        variant: { type: 'string', description: 'Variant letter: a, b, c, d, etc.' },
      },
      required: ['sub_account_id', 'page_id', 'variant'],
    },
  },
  {
    name: 'edit_variant',
    description: 'Update the HTML and/or CSS of a specific variant on an Unbounce page without re-uploading. Provide html, css, or both. Changes are saved immediately. You will need to publish/republish the page after editing.',
    inputSchema: {
      type: 'object',
      properties: {
        sub_account_id: { type: 'string' },
        page_id: { type: 'string', description: 'UUID of the page' },
        variant: { type: 'string', description: 'Variant letter: a, b, c, d, etc.' },
        html: { type: 'string', description: 'Full HTML content. Omit to leave unchanged.' },
        css: { type: 'string', description: 'Full CSS content (include <style> tags). Omit to leave unchanged.' },
      },
      required: ['sub_account_id', 'page_id', 'variant'],
    },
  },
  {
    name: 'add_variant',
    description: 'Add a new variant to an existing Unbounce page by duplicating variant A. Optionally provide html and/or css to immediately replace the duplicate\'s content. Returns the new variant letter. After adding a variant, always call rename_variant to give it a descriptive name reflecting its content (e.g. "Outcome Headline" or "Social Proof Hero") — not just the letter. You will need to republish the page after adding a variant.',
    inputSchema: {
      type: 'object',
      properties: {
        sub_account_id: { type: 'string' },
        page_id: { type: 'string', description: 'UUID of the page' },
        html: { type: 'string', description: 'HTML to write into the new variant. Omit to keep the duplicate of variant A.' },
        css: { type: 'string', description: 'CSS to write into the new variant (include <style> tags). Omit to keep the duplicate.' },
      },
      required: ['sub_account_id', 'page_id'],
    },
  },
  {
    name: 'rename_variant',
    description: 'Rename a variant on an Unbounce page.',
    inputSchema: {
      type: 'object',
      properties: {
        sub_account_id: { type: 'string' },
        page_id: { type: 'string', description: 'UUID of the page' },
        variant: { type: 'string', description: 'Variant letter: a, b, c, etc.' },
        name: { type: 'string', description: 'New display name for the variant.' },
      },
      required: ['sub_account_id', 'page_id', 'variant', 'name'],
    },
  },
  {
    name: 'activate_variant',
    description: 'Activate a discarded/inactive variant so it can receive traffic. In A/B test mode this is "Add to test"; in Smart Traffic mode it is "Add to active variants"; in Standard mode it is "Make this the active variant". Call this after add_variant when the page is in standard mode, since new variants are created in discarded state and will not receive traffic until activated.',
    inputSchema: {
      type: 'object',
      properties: {
        sub_account_id: { type: 'string' },
        page_id: { type: 'string', description: 'UUID of the page' },
        variant: { type: 'string', description: 'Variant letter to activate: a, b, c, etc.' },
      },
      required: ['sub_account_id', 'page_id', 'variant'],
    },
  },
  {
    name: 'deactivate_variant',
    description: 'Deactivate an active variant, moving it to discarded/inactive state. It will no longer receive traffic but its content is preserved. Requires user confirmation — ask before calling.',
    inputSchema: {
      type: 'object',
      properties: {
        sub_account_id: { type: 'string' },
        page_id: { type: 'string', description: 'UUID of the page' },
        variant: { type: 'string', description: 'Variant letter to deactivate: a, b, c, etc.' },
        confirm: { type: 'boolean', description: 'Must be true to proceed.' },
      },
      required: ['sub_account_id', 'page_id', 'variant', 'confirm'],
    },
  },
  {
    name: 'promote_variant',
    description: 'Promote a challenger variant to champion. The current champion is discarded. This is the standard action when a challenger wins an A/B test. Requires explicit user confirmation — always ask before calling.',
    inputSchema: {
      type: 'object',
      properties: {
        sub_account_id: { type: 'string' },
        page_id: { type: 'string', description: 'UUID of the page' },
        variant: { type: 'string', description: 'Challenger variant letter to promote: b, c, d, etc.' },
        confirm: { type: 'boolean', description: 'Must be true to proceed. The current champion will be discarded.' },
      },
      required: ['sub_account_id', 'page_id', 'variant', 'confirm'],
    },
  },
  {
    name: 'delete_variant',
    description: 'Permanently delete a variant. This cannot be undone. Requires explicit user confirmation — always ask before calling.',
    inputSchema: {
      type: 'object',
      properties: {
        sub_account_id: { type: 'string' },
        page_id: { type: 'string', description: 'UUID of the page' },
        variant: { type: 'string', description: 'Variant letter to delete: a, b, c, etc.' },
        confirm: { type: 'boolean', description: 'Must be true to proceed.' },
      },
      required: ['sub_account_id', 'page_id', 'variant', 'confirm'],
    },
  },
  {
    name: 'get_page_variants',
    description: 'Get all variants for an Unbounce page — champion, challengers, and discarded — with their names, traffic weights, states, and preview paths. The champion variant is the primary/control variant (highest weight or designated control). Use this before adding a new variant to identify which variant to read as the design reference, or to understand the current A/B test structure.',
    inputSchema: {
      type: 'object',
      properties: {
        sub_account_id: { type: 'string' },
        page_id: { type: 'string', description: 'UUID of the page' },
      },
      required: ['sub_account_id', 'page_id'],
    },
  },
  {
    name: 'screenshot_variant',
    description: 'Take a full-page screenshot of a specific variant and return it as an image. Works for both published and unpublished pages. Use this whenever you need to visually inspect a page\'s design — especially before creating a new variant that should match the look and feel of an existing one. This is the right tool for legacy builder pages where you cannot easily read the design from HTML/CSS alone. Call get_page_variants first to identify the correct variant letter (usually the champion), then call this tool.',
    inputSchema: {
      type: 'object',
      properties: {
        sub_account_id: { type: 'string' },
        page_id: { type: 'string', description: 'UUID of the page' },
        variant: { type: 'string', description: 'Variant letter: a, b, c, etc.' },
      },
      required: ['sub_account_id', 'page_id', 'variant'],
    },
  },
  {
    name: 'get_variant_preview_url',
    description: 'Get a live preview URL for a specific variant — works for both published and unpublished pages. Returns two URLs: (1) preview_url — the authenticated iframe URL for agent inspection of the rendered page; (2) share_url — the app.unbounce.com link suitable for sharing with the user. Use this when you need to visually inspect a variant without publishing it, or when a user asks for a preview link.',
    inputSchema: {
      type: 'object',
      properties: {
        sub_account_id: { type: 'string' },
        page_id: { type: 'string', description: 'UUID of the page' },
        variant: { type: 'string', description: 'Variant letter: a, b, c, etc.' },
      },
      required: ['sub_account_id', 'page_id', 'variant'],
    },
  },
  {
    name: 'set_dynamic_text',
    description: 'Replace a specific text string on a variant with an Unbounce Dynamic Text Replacement (DTR) tag. The tag lets visitors see personalized text based on a URL query parameter — e.g. passing ?city=Portland swaps "Vancouver" for "Portland". Call get_variant first to confirm the exact text as it appears in the HTML, then call this tool. All occurrences of the text are replaced. After saving, republish the page. Use your best judgement on parameter name (e.g. "Vancouver" → parameter "city") and method ("titlecase" for display text is almost always correct). Tell the user what URL parameter was used so they know how to test it.',
    inputSchema: {
      type: 'object',
      properties: {
        sub_account_id: { type: 'string' },
        page_id: { type: 'string', description: 'UUID of the page' },
        variant: { type: 'string', description: 'Variant letter: a, b, c, etc.' },
        text: { type: 'string', description: 'The exact text string to make dynamic (case-sensitive).' },
        parameter: { type: 'string', description: 'URL query parameter name (e.g. "city", "keyword", "industry"). Infer from context if not specified.' },
        method: {
          type: 'string',
          enum: ['titlecase', 'uppercase', 'lowercase', ''],
          description: 'Text casing applied to the URL param value. "titlecase" for display text (default). "" to use the value as-is.',
        },
      },
      required: ['sub_account_id', 'page_id', 'variant', 'text', 'parameter'],
    },
  },
  {
    name: 'get_landing_page_guidelines',
    description: 'Returns landing page best practices and conversion rules. MUST be called before generating any landing page HTML.',
    inputSchema: { type: 'object', properties: {} },
  },
]

export async function handleTool(name, args) {
  switch (name) {
    case 'list_accounts': {
      const accounts = await getAccounts()
      return { accounts }
    }

    case 'list_sub_accounts': {
      const subAccounts = await getSubAccounts(args.account_id)
      return { sub_accounts: subAccounts }
    }

    case 'list_pages': {
      const result = await getSubAccountPages(args.sub_account_id, {
        withStats: args.with_stats,
        countOnly: args.count_only,
        from: args.from,
        to: args.to,
        sortOrder: args.sort_order,
      })
      if (args.count_only) return result
      return { pages: result, total: result.length }
    }

    case 'get_page': {
      return getPage(args.page_id)
    }

    case 'list_page_groups': {
      const groups = await getSubAccountPageGroups(args.sub_account_id)
      return { page_groups: groups, total: groups.length }
    }

    case 'list_leads': {
      return getPageLeads(args.page_id, { offset: args.offset, count: args.count })
    }

    case 'get_lead': {
      return getLead(args.lead_id)
    }

    case 'list_users': {
      const users = await getUsers()
      return { users, total: users.length }
    }

    case 'list_domains': {
      const domains = await getDomains(args.sub_account_id)
      const hasDefault = domains.some(d => d.name === 'unbouncepages.com')
      if (!hasDefault) {
        domains.unshift({ id: null, name: 'unbouncepages.com', url: 'https://unbouncepages.com' })
      }
      return { domains }
    }

    case 'upload_unbounce_file': {
      const {
        unbounce_file_path,
        sub_account_id,
        page_name,
        domain,
        slug,
        traffic_mode,
        variant_weights,
        publish = true,
      } = args

      const fileBuffer = await fs.promises.readFile(unbounce_file_path)
      const fileName = path.basename(unbounce_file_path)
      const resolvedPageName = page_name || path.basename(unbounce_file_path, '.unbounce')

      return uploadAndConfigure({
        fileBuffer,
        fileName,
        pageName: resolvedPageName,
        subAccountId: sub_account_id,
        domain,
        slug,
        trafficMode: traffic_mode,
        variantWeights: variant_weights,
        variantIds: ['a'],
        isMultiVariant: false,
        publish,
      })
    }

    case 'deploy_page': {
      const {
        html_variants,
        html_file_paths,
        page_name,
        sub_account_id,
        domain,
        slug,
        traffic_mode,
        variant_weights,
        publish = true,
      } = args

      let htmlFiles
      if (html_variants && html_variants.length > 0) {
        htmlFiles = html_variants.map((html, i) => ({
          name: `variant-${String.fromCharCode(97 + i)}.html`,
          html,
        }))
      } else if (html_file_paths && html_file_paths.length > 0) {
        htmlFiles = await Promise.all(
          html_file_paths.map(async (filePath) => {
            const html = await fs.promises.readFile(filePath, 'utf8')
            return { name: path.basename(filePath), html }
          })
        )
      } else {
        throw new Error('Provide either html_variants (raw HTML strings) or html_file_paths (paths to files on disk).')
      }

      // Fix 1: reject empty HTML entries before anything is packaged or uploaded
      const emptyVariants = htmlFiles.filter(f => !f.html || !f.html.trim())
      if (emptyVariants.length) {
        throw new Error(
          `HTML content is empty for: ${emptyVariants.map(f => f.name).join(', ')}. Pass the full HTML string, not a placeholder.`
        )
      }

      const resolvedPageName = page_name || (html_file_paths?.[0] ? path.basename(html_file_paths[0], '.html') : 'Page')
      const variantIds = htmlFiles.map((_, i) => 'abcdefghijklmnopqrstuvwxyz'[i])

      const fileBuffer = await packageToUnbounce(htmlFiles, [], resolvedPageName)
      const fileName = `${slugify(resolvedPageName)}.unbounce`

      return uploadAndConfigure({
        fileBuffer,
        fileName,
        pageName: resolvedPageName,
        subAccountId: sub_account_id,
        domain,
        slug,
        trafficMode: traffic_mode,
        variantWeights: variant_weights,
        variantIds,
        htmlFiles,
        isMultiVariant: htmlFiles.length > 1,
        publish,
      })
    }

    case 'publish_page': {
      await publishPage(args.sub_account_id, args.page_id)
      const published = await pollPageStatus(args.page_id, 'published')
      return { url: published.url, state: 'published' }
    }

    case 'unpublish_page': {
      await unpublishPage(args.sub_account_id, args.page_id)
      await pollPageStatus(args.page_id, 'unpublished')
      return { state: 'unpublished' }
    }

    case 'delete_page': {
      if (!args.confirm) throw new Error('You must set confirm: true to delete a page.')
      await deletePage(args.sub_account_id, args.page_id)
      return { deleted: true, page_id: args.page_id }
    }

    case 'set_page_url': {
      await setPageUrl(args.sub_account_id, args.page_id, args.domain, args.slug)
      return { success: true }
    }

    case 'set_traffic_mode': {
      await setTrafficMode(args.sub_account_id, args.page_id, args.mode, args.variant_id ?? null)
      // Republish if page was published
      try {
        await publishPage(args.sub_account_id, args.page_id)
        await pollPageStatus(args.page_id, 'published')
      } catch {
        // Page may not have been published yet — that's fine
      }
      return { success: true, mode: args.mode }
    }

    case 'set_variant_weights': {
      const weights = typeof args.weights === 'string' ? JSON.parse(args.weights) : args.weights
      await setVariantWeights(args.sub_account_id, args.page_id, weights)
      // Republish
      try {
        await publishPage(args.sub_account_id, args.page_id)
        await pollPageStatus(args.page_id, 'published')
      } catch {
        // Page may not have been published yet
      }
      return { success: true, weights }
    }

    case 'find_page': {
      const pages = await searchPagesByName(args.name, {
        subAccountId: args.sub_account_id,
        accountId: args.account_id,
      })
      return { pages, total: pages.length }
    }

    case 'duplicate_page': {
      const { sub_account_id, page_id, include_inactive_variants = false, copy_integrations = 'all' } = args
      return duplicatePage(sub_account_id, page_id, {
        includeInactiveVariants: include_inactive_variants,
        integrationIds: copy_integrations,
      })
    }

    case 'find_pages_by_stats': {
      const { sub_account_id, min_visitors, max_visitors, min_conversions, max_conversions, min_conversion_rate, max_conversion_rate } = args
      const pages = await getSubAccountPages(sub_account_id)
      const filters = { min_visitors, max_visitors, min_conversions, max_conversions, min_conversion_rate, max_conversion_rate }
      const results = await findPagesByStats(sub_account_id, pages, filters)
      return { pages: results, total: results.length }
    }

    case 'get_page_stats': {
      const stats = await getPageStats(args.sub_account_id, args.page_id, {
        startDate: args.start_date,
        endDate: args.end_date,
      })
      return stats
    }

    case 'get_page_insights': {
      const insights = await getPageInsights(args.sub_account_id, args.page_id)
      return { insights, total: insights.length }
    }

    case 'get_variant': {
      return getVariantContent(args.sub_account_id, args.page_id, args.variant)
    }

    case 'edit_variant': {
      if (!args.html && !args.css) throw new Error('Provide at least one of: html, css')
      const result = await editVariantHtml(args.sub_account_id, args.page_id, args.variant, args.html || null, args.css || null)
      return result
    }

    case 'add_variant': {
      return addVariant(args.sub_account_id, args.page_id, args.html || null, args.css || null)
    }

    case 'rename_variant': {
      return renameVariant(args.sub_account_id, args.page_id, args.variant, args.name)
    }

    case 'activate_variant': {
      await activateVariant(args.sub_account_id, args.page_id, args.variant)
      return { success: true, variant: args.variant, state: 'active' }
    }

    case 'deactivate_variant': {
      if (!args.confirm) throw new Error('You must set confirm: true to deactivate a variant.')
      await deactivateVariant(args.sub_account_id, args.page_id, args.variant)
      return { success: true, variant: args.variant, state: 'discarded' }
    }

    case 'promote_variant': {
      if (!args.confirm) throw new Error('You must set confirm: true to promote a variant. The current champion will be discarded.')
      await promoteVariant(args.sub_account_id, args.page_id, args.variant)
      return { success: true, promoted: args.variant }
    }

    case 'delete_variant': {
      if (!args.confirm) throw new Error('You must set confirm: true to delete a variant.')
      await deleteVariant(args.sub_account_id, args.page_id, args.variant)
      return { success: true, deleted: args.variant }
    }

    case 'get_page_variants': {
      return getPageVariants(args.sub_account_id, args.page_id)
    }

    case 'screenshot_variant': {
      return screenshotVariant(args.sub_account_id, args.page_id, args.variant)
    }

    case 'get_variant_preview_url': {
      return getVariantPreviewUrl(args.sub_account_id, args.page_id, args.variant)
    }

    case 'set_dynamic_text': {
      const { sub_account_id, page_id, variant, text, parameter, method = 'titlecase' } = args
      const content = await getVariantContent(sub_account_id, page_id, variant)
      const html = content.html
      if (!html) throw new Error('No HTML found for this variant.')
      const tag = `<ub:dynamic method="${method}" parameter="${parameter}" title="Parameter: ${parameter}">${text}</ub:dynamic>`
      const count = (html.split(text).length - 1)
      if (count === 0) throw new Error(`Text "${text}" not found in variant ${variant}. Use get_variant to check the exact text.`)
      const updatedHtml = html.split(text).join(tag)
      await editVariantHtml(sub_account_id, page_id, variant, updatedHtml, null)
      return {
        success: true,
        replacements: count,
        parameter,
        method: method || 'none',
        preview_tip: `Test by appending ?${parameter}=YourValue to the page URL.`,
      }
    }

    case 'get_landing_page_guidelines': {
      return {
        rules: [
          {
            rule: 'Single form (lead gen pages only)',
            detail: 'If the landing page is a lead gen page (i.e. it contains a form), there must be exactly one <form> element. Never render two or more forms. CTA buttons in sections where the form is not visible should be anchor links (<a href="#main-form">) that scroll the user to the single form — not separate forms. Pages without a form (e.g. click-through pages) are not subject to this rule.',
          },
          {
            rule: 'No navigation',
            detail: 'Landing pages must not include navigation menus, header nav bars, or footer link lists. Every outbound link is an exit opportunity that reduces conversion. Omit <nav> elements entirely. The only acceptable links are the primary CTA anchor links and legally required links (privacy policy, terms of service) placed inconspicuously in the footer.',
          },
          {
            rule: 'Variant preview URLs and visual inspection',
            detail: 'To visually inspect a variant (published or unpublished), use screenshot_variant — it returns a full-page rendered image you can see directly. This is the preferred method for understanding a page\'s design before creating a new variant. For a PUBLISHED page, you can also link directly to a variant without triggering stats by appending the variant letter and ".html" to the page URL (e.g. https://unbouncepages.com/my-page/a.html) — construct this from page.url returned by get_page, never ask the user. If a user asks for a shareable preview link, use get_variant_preview_url and give them the share_url.',
          },
        ],
      }
    }

    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}
