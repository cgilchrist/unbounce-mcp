/**
 * MCP tool definitions and handlers.
 * Each tool maps to one or more API / browser actions.
 */

import * as fs from 'fs'
import * as path from 'path'
import { packageToUnbounce } from './packager.js'
import { VARIANT_CREATION_RULES } from './variant-rules.js'
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
  renameVariant, duplicateVariant, getPageVariants, getVariantPreviewUrl, screenshotVariant,
  activateVariant, deactivateVariant, promoteVariant, deleteVariant,
  getJavascripts, setJavascripts,
  uploadImage, deleteImage,
  rehostVariantImages,
  reauthenticate,
} from './browser.js'
import { VALID_PLACEMENTS } from './javascripts.js'

/** Compute even integer split weights that sum to 100. Champion (variant a) gets the +1 remainder. */
export function evenWeights(variantIds) {
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
export function slugify(name) {
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

  // Traffic mode + variant weights.
  // Single-variant pages need an explicit setTrafficMode('standard') — the
  // bare upload lands in Unbounce's default routing strategy ('weighted'),
  // which makes the Pages list display the page as "A/B Test" even though
  // there's only one variant. Always set the mode so the UI is correct.
  const resolvedMode = isMultiVariant
    ? (trafficMode || 'ab_test')
    : 'standard'
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
    name: 'reauthenticate',
    description: 'Open a browser window for the user to log in to Unbounce. Call this when any tool fails with a session expired error, then retry the original operation.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
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
        transcode_images: {
          type: 'boolean',
          description: 'When true (default), the MCP rehosts embedded images into the sub-account\'s asset library and replaces every occurrence with a CDN URL. Covers (a) data: URIs always, and (b) relative paths in HTML — resolved against the directory of html_file_paths[i] when used (so <img src="logo.png"> or <img src="images/hero.jpg"> next to your HTML file just works). Same image referenced N times uploads once via SHA-256 dedup; the asset library filename is derived from the surrounding context (img alt text, CSS selector). Set to false to keep refs verbatim (rarely useful).',
        },
        rehost_external_images: {
          type: 'boolean',
          description: 'When true (default false — opt-in), additionally fetches external http(s) image URLs in the HTML/CSS and uploads them to the asset library so the page becomes self-contained on Unbounce\'s CDN. Skips URLs already on unbounce.com so we never re-rehost our own assets. Useful when migrating a scraped page or when an external host might go down. Default OFF because most external URLs work as-is, and silently rehosting them would surprise users who deliberately use their own CDN.',
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
    description: 'Update the HTML and/or CSS of a specific variant on an Unbounce page without re-uploading. Provide html/css inline or via file paths (html_file_path/css_file_path) — use file paths for large HTML that would exceed tool parameter limits. Changes are saved immediately. You will need to publish/republish the page after editing.',
    inputSchema: {
      type: 'object',
      properties: {
        sub_account_id: { type: 'string' },
        page_id: { type: 'string', description: 'UUID of the page' },
        variant: { type: 'string', description: 'Variant letter: a, b, c, d, etc.' },
        html: { type: 'string', description: 'Full HTML content as a string. Use html_file_path instead for large files.' },
        css: { type: 'string', description: 'Full CSS content (include <style> tags). Use css_file_path instead for large files.' },
        html_file_path: { type: 'string', description: 'Absolute path to an HTML file on disk. Use instead of html for large files.' },
        css_file_path: { type: 'string', description: 'Absolute path to a CSS file on disk. Use instead of css for large files.' },
        transcode_images: {
          type: 'boolean',
          description: 'When true (default), embedded image refs in html/css (data: URIs always; relative paths when html_file_path is used so they resolve against the source file\'s directory) are auto-uploaded to the asset library and replaced with CDN URLs. Set false to keep refs verbatim.',
        },
        rehost_external_images: {
          type: 'boolean',
          description: 'When true (default false — opt-in), external http(s) image URLs are also fetched and rehosted to the asset library. Skips URLs already on unbounce.com.',
        },
      },
      required: ['sub_account_id', 'page_id', 'variant'],
    },
  },
  {
    name: 'add_variant',
    description: 'Add a new variant to an existing Unbounce page by duplicating variant A. Optionally provide html and/or css (inline or via file paths) to immediately replace the duplicate\'s content. Returns the new variant letter. After adding a variant, always call rename_variant to give it a descriptive name reflecting its content (e.g. "Outcome Headline" or "Social Proof Hero") — not just the letter. You will need to republish the page after adding a variant.',
    inputSchema: {
      type: 'object',
      properties: {
        sub_account_id: { type: 'string' },
        page_id: { type: 'string', description: 'UUID of the page' },
        html: { type: 'string', description: 'HTML to write into the new variant as a string. Use html_file_path instead for large files.' },
        css: { type: 'string', description: 'CSS to write into the new variant (include <style> tags). Use css_file_path instead for large files.' },
        html_file_path: { type: 'string', description: 'Absolute path to an HTML file on disk. Use instead of html for large files.' },
        css_file_path: { type: 'string', description: 'Absolute path to a CSS file on disk. Use instead of css for large files.' },
        transcode_images: {
          type: 'boolean',
          description: 'When true (default), embedded image refs in html/css (data: URIs always; relative paths when html_file_path is used so they resolve against the source file\'s directory) are auto-uploaded to the asset library and replaced with CDN URLs. Set false to keep refs verbatim.',
        },
        rehost_external_images: {
          type: 'boolean',
          description: 'When true (default false — opt-in), external http(s) image URLs are also fetched and rehosted to the asset library. Skips URLs already on unbounce.com.',
        },
      },
      required: ['sub_account_id', 'page_id'],
    },
  },
  {
    name: 'duplicate_variant',
    description: 'Duplicate any existing variant on an Unbounce page. Returns the new variant letter. Unlike add_variant (which only copies variant A), this lets you clone any variant. After duplicating, call rename_variant to give it a descriptive name, then edit_variant to update its content, then republish.',
    inputSchema: {
      type: 'object',
      properties: {
        sub_account_id: { type: 'string' },
        page_id: { type: 'string', description: 'UUID of the page' },
        variant: { type: 'string', description: 'Letter of the variant to duplicate: a, b, c, etc.' },
      },
      required: ['sub_account_id', 'page_id', 'variant'],
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
    description: 'Take a full-page screenshot of a specific variant and return it as an image. Use this whenever you need to visually inspect a page\'s design — especially before creating a new variant that should match the look and feel of an existing one. For published pages, prefer source="published" (faster, no auth required). Use source="preview" (default) for unpublished pages or to see the latest saved changes before publishing.',
    inputSchema: {
      type: 'object',
      properties: {
        sub_account_id: { type: 'string' },
        page_id: { type: 'string', description: 'UUID of the page' },
        variant: { type: 'string', description: 'Variant letter: a, b, c, etc.' },
        source: { type: 'string', enum: ['preview', 'published'], description: 'Screenshot source. "published" navigates directly to the live {url}/{letter}.html endpoint — faster and more reliable. "preview" (default) uses the Unbounce preview system and works for unpublished pages.' },
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
    name: 'upload_image',
    description: 'Upload an image to the sub-account\'s asset library and get back a public CDN URL you can use as <img src> in HTML. Use this BEFORE deploy_page / edit_variant / add_variant when the page needs real images — passing data: URIs in HTML works but bloats the payload (each image is ~33% larger as base64 and counts against the 1 MB tool input cap). Provide ONE of: file_path (image already on disk), image_data_url ("data:image/jpeg;base64,..."), or image_url (http/https — MCP fetches and re-uploads it). Returns { uuid, name, cdn_url, file_size, mime_type }; the cdn_url is the only thing you need in your HTML. Once uploaded, the same image can be referenced from any variant of any page in this sub-account — uploading once and reusing is preferred over uploading per page.',
    inputSchema: {
      type: 'object',
      properties: {
        sub_account_id: { type: 'string', description: 'Sub-account that will own the asset.' },
        file_path: { type: 'string', description: 'Absolute path to an image file on disk.' },
        image_data_url: { type: 'string', description: 'Base64 data URL: "data:image/<type>;base64,<payload>".' },
        image_url: { type: 'string', description: 'http(s) URL the MCP fetches and re-uploads. Useful for migrating an external CDN image into Unbounce.' },
        filename: { type: 'string', description: 'Optional override for the filename stored in Unbounce. Defaults to the source basename or a synthesized "image-<ts>.<ext>".' },
      },
      required: ['sub_account_id'],
    },
  },
  {
    name: 'delete_image',
    description: 'Permanently trash an image from the sub-account\'s asset library. Takes the NUMERIC asset id (the "id" field returned by upload_image — NOT the uuid; the uuid is the public-URL identifier and is not accepted by this endpoint). This cannot be undone — always ask the user for explicit confirmation before calling. After trashing, any <img src> in published HTML pointing at the asset will start 404\'ing.',
    inputSchema: {
      type: 'object',
      properties: {
        sub_account_id: { type: 'string' },
        asset_id: { type: 'string', description: 'Numeric asset id from upload_image\'s response.id field.' },
        confirm: { type: 'boolean', description: 'Must be true to proceed. Ask the user to confirm before setting this.' },
      },
      required: ['sub_account_id', 'asset_id', 'confirm'],
    },
  },
  {
    name: 'get_javascripts',
    description: 'Read all custom JavaScripts on a variant — the entries managed via Unbounce\'s "JavaScripts" panel (slots: Head, After Body Tag, Before Body End Tag). Returns each script\'s name, placement, and HTML content. Use this BEFORE set_javascripts to know what\'s currently there, and when modernizing a Classic Builder variant to extract custom JS verbatim. Does NOT return the variant\'s main lp-stylesheet-1 CSS (use get_variant for that).',
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
    name: 'set_javascripts',
    description: 'Replace ALL custom JavaScripts on a variant with the supplied list. Each script has a name (optional), placement ("head", "body_top", or "body_bottom"), and HTML content (must include the <script> tags themselves). Pass an empty scripts array to clear all custom scripts. The variant\'s HTML body, main CSS, and any other element types are NOT touched. Use this to add tracking pixels (GTM, GA, Meta), 3rd-party widgets, or migrate scripts from a Classic Builder source. The agent CANNOT write scripts to lp-code-1 directly — they must go through this tool. After setting, republish the page for the changes to take effect.',
    inputSchema: {
      type: 'object',
      properties: {
        sub_account_id: { type: 'string' },
        page_id: { type: 'string', description: 'UUID of the page' },
        variant: { type: 'string', description: 'Variant letter: a, b, c, etc.' },
        scripts: {
          type: 'array',
          description: 'Replacement list. Pass [] to clear all scripts.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Display name for the script (e.g. "GTM", "Meta Pixel"). Optional — defaults to "Script {N}".' },
              placement: {
                type: 'string',
                enum: VALID_PLACEMENTS,
                description: '"head" = inside <head>; "body_top" = immediately after <body>; "body_bottom" = immediately before </body>.',
              },
              html: { type: 'string', description: 'Full HTML to inject — MUST include the <script> tags themselves.' },
            },
            required: ['placement', 'html'],
          },
        },
      },
      required: ['sub_account_id', 'page_id', 'variant', 'scripts'],
    },
  },
  {
    name: 'get_landing_page_guidelines',
    description: 'Returns landing page best practices and conversion rules. MUST be called before generating any landing page HTML.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_classic_builder_modernization_guidelines',
    description: 'Returns the rules for converting an Unbounce Classic Builder variant (drag-and-drop, absolute-positioned) into a clean responsive HTML/CSS replica. MUST be called BEFORE writing any HTML when the user asks to: "modernize" or "modernise" a page, "recreate as clean HTML", "make a replica of variant X", "get rid of absolute positioning", "make this responsive", "convert from Classic Builder", or any equivalent phrasing. Pixel-faithful replica only — no creative, copy, or CRO changes; mobile-responsive layout required.',
    inputSchema: { type: 'object', properties: {} },
  },
]

export async function handleTool(name, args) {
  switch (name) {
    case 'reauthenticate': {
      return reauthenticate()
    }

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
        transcode_images = true,
        rehost_external_images = false,
      } = args

      let htmlFiles
      if (html_variants && html_variants.length > 0) {
        // Raw strings — no base directory, so relative-path resolution is a no-op for these.
        htmlFiles = html_variants.map((html, i) => ({
          name: `variant-${String.fromCharCode(97 + i)}.html`,
          html,
          baseDir: null,
        }))
      } else if (html_file_paths && html_file_paths.length > 0) {
        // File paths — capture each file's directory so relative img refs
        // (logo.png, images/hero.jpg, /assets/x.png) resolve from disk during rehost.
        htmlFiles = await Promise.all(
          html_file_paths.map(async (filePath) => {
            const html = await fs.promises.readFile(filePath, 'utf8')
            return {
              name: path.basename(filePath),
              html,
              baseDir: path.dirname(filePath),
            }
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

      // Rehost embedded image refs (data URIs always; relative paths when a
      // baseDir is available; external HTTP URLs only if explicitly opted in)
      // into uploaded CDN assets before packaging. Default ON for the first
      // two; default OFF for external rehosting.
      const filesForPackaging = transcode_images
        ? await rehostVariantImages(sub_account_id, htmlFiles, {
            resolveDataUris: true,
            resolveRelative: true,
            rehostExternal: rehost_external_images === true,
          })
        : htmlFiles

      const fileBuffer = await packageToUnbounce(filesForPackaging, [], resolvedPageName)
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
        htmlFiles: filesForPackaging,
        isMultiVariant: filesForPackaging.length > 1,
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
      const result = await setVariantWeights(args.sub_account_id, args.page_id, weights)
      const appliedWeights = {}
      const champion = result?.page?.championVariant
      const challengers = result?.page?.challengerVariants?.nodes ?? []
      if (champion) appliedWeights[champion.variantId] = champion.variantWeight
      for (const v of challengers) appliedWeights[v.variantId] = v.variantWeight
      try {
        await publishPage(args.sub_account_id, args.page_id)
      } catch {
        // non-fatal — weights were set
      }
      return { success: true, weights: Object.keys(appliedWeights).length ? appliedWeights : weights }
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
      const variantResult = await getVariantContent(args.sub_account_id, args.page_id, args.variant)
      return { ...variantResult, creation_rules: VARIANT_CREATION_RULES }
    }

    case 'edit_variant': {
      const html = args.html || (args.html_file_path ? await fs.promises.readFile(args.html_file_path, 'utf8') : null)
      const css = args.css || (args.css_file_path ? await fs.promises.readFile(args.css_file_path, 'utf8') : null)
      if (!html && !css) throw new Error('Provide at least one of: html, css, html_file_path, css_file_path')
      // baseDir for relative-image resolution: prefer html file's dir, then css file's dir.
      const baseDir = args.html_file_path ? path.dirname(args.html_file_path)
                    : args.css_file_path  ? path.dirname(args.css_file_path)
                    : null
      const result = await editVariantHtml(args.sub_account_id, args.page_id, args.variant, html, css, {
        transcodeImages: args.transcode_images !== false,
        rehostExternal: args.rehost_external_images === true,
        baseDir,
      })
      return result
    }

    case 'add_variant': {
      const html = args.html || (args.html_file_path ? await fs.promises.readFile(args.html_file_path, 'utf8') : null)
      const css = args.css || (args.css_file_path ? await fs.promises.readFile(args.css_file_path, 'utf8') : null)
      const baseDir = args.html_file_path ? path.dirname(args.html_file_path)
                    : args.css_file_path  ? path.dirname(args.css_file_path)
                    : null
      return addVariant(args.sub_account_id, args.page_id, html, css, {
        transcodeImages: args.transcode_images !== false,
        rehostExternal: args.rehost_external_images === true,
        baseDir,
      })
    }

    case 'duplicate_variant': {
      return duplicateVariant(args.sub_account_id, args.page_id, args.variant)
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
      return screenshotVariant(args.sub_account_id, args.page_id, args.variant, { source: args.source })
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

    case 'upload_image': {
      return uploadImage(args.sub_account_id, {
        filePath: args.file_path,
        imageDataUrl: args.image_data_url,
        imageUrl: args.image_url,
        filename: args.filename,
      })
    }

    case 'delete_image': {
      if (!args.confirm) throw new Error('You must set confirm: true to delete an image.')
      return deleteImage(args.sub_account_id, args.asset_id)
    }

    case 'get_javascripts': {
      return getJavascripts(args.sub_account_id, args.page_id, args.variant)
    }

    case 'set_javascripts': {
      if (!Array.isArray(args.scripts)) {
        throw new Error('scripts must be an array (pass [] to clear all scripts).')
      }
      for (let i = 0; i < args.scripts.length; i++) {
        const s = args.scripts[i]
        if (!s || typeof s !== 'object') throw new Error(`scripts[${i}] must be an object`)
        if (typeof s.placement !== 'string') throw new Error(`scripts[${i}].placement is required`)
        if (typeof s.html !== 'string' || !s.html.trim()) {
          throw new Error(`scripts[${i}].html must be a non-empty string`)
        }
      }
      return setJavascripts(args.sub_account_id, args.page_id, args.variant, args.scripts)
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
          {
            rule: 'Signature comment',
            detail: 'Every variant body the MCP writes (deploy_page / edit_variant / add_variant) is automatically prefixed with a one-line HTML comment identifying the MCP server version, the client (Claude Desktop / Codex / etc.), and the timestamp. Format: <!-- unbounce-mcp@0.1.0 · client: name@version · 2026-04-25T18:33:12Z -->. Leave it alone — it is auto-injected and auto-replaced on each write. If you read a variant via get_variant and see this comment at the top, do not interpret it as part of the page content; do not duplicate it; do not strip it (it will be re-stamped automatically on save anyway).',
          },
        ],
      }
    }

    case 'get_classic_builder_modernization_guidelines': {
      return {
        purpose: 'Convert an Unbounce Classic Builder variant (drag-and-drop, absolute-positioned) into a clean, responsive HTML/CSS replica. PIXEL-FAITHFUL REPLICATION ONLY — no creative changes, no copy edits, no CRO changes, no layout reinterpretation. The output must look identical to the source on desktop and reflow sensibly on mobile.',
        workflow: [
          'Step 1 — Visual reference: call screenshot_variant on the source variant. Save the image; you will use it as the truth source for the side-by-side comparison at the end.',
          'Step 2 — Source extraction: call get_variant on the source variant. Classic Builder pages return rendered_preview HTML (note.source === "rendered_preview"). Use that HTML and the embedded srcdoc (if any) as your read-only source CSS and content reference. NEVER pass this HTML back through edit_variant or add_variant.',
          'Step 3 — Audit (BEFORE writing any HTML): record exact values, listed in the AUDIT rule below. If you cannot find an exact value, say so before proceeding rather than guessing.',
          'Step 4 — Write clean HTML: produce a single self-contained HTML document using flexbox/grid (NOT absolute positioning). Every numeric value must come from the audit, with the one exception described in DRIFT CORRECTION below.',
          'Step 5 — Verify: take a screenshot of your replica (deploy_page with publish:false → screenshot_variant on the new page) and do a side-by-side comparison against the source screenshot. Apply the PASS CRITERIA below.',
          'Step 6 — Deliver: once the replica passes, add it as a new INACTIVE variant on the same page (add_variant). Name it "Control Replica — Clean HTML". Do not set traffic weights, do not activate, do not promote. Leave it for the user to review.',
        ],
        rules: [
          {
            rule: 'AUDIT — extract exact values before writing any HTML',
            detail: [
              'Before a single line of HTML is written, record from the source:',
              '• Every distinct text element\'s font-family, font-size, font-weight, line-height, letter-spacing, color, text-transform (headline, subhead, body, list items, form labels, placeholders, buttons, footer copy, etc.)',
              '• Every background — solid colors and gradients in their exact format (rgba/hex/gradient stops with stop positions). Distinguish section backgrounds from block backgrounds.',
              '• Every image\'s rendered width × height (computed, not the natural dimensions of the underlying file). Watch for images styled with object-fit: cover.',
              '• All padding and margin values for major sections, blocks, and the form container.',
              '• Button text, font-size, font-family, background-color, hover state, border-radius, padding.',
              '• Form field labels (verbatim), placeholder text (verbatim), field order, field types, required-state indicators.',
              '• Spacing between sections (the gap, not just per-section padding).',
              'Recording in a structured table is fine; the goal is that every numeric value in your output HTML can be traced back to a row in this audit.',
            ].join('\n'),
          },
          {
            rule: 'IMAGE ASSETS — always reuse, never substitute',
            detail: [
              'For every <img> tag in the rendered_preview HTML the real CDN URL is in the data-src-desktop-1x attribute (and data-src-mobile-1x if separately specified). The img\'s src= will be a data: URI placeholder — that is NOT the real image; do not use it.',
              'Use the data-src-desktop-1x value verbatim as the src of your replica\'s <img>. These follow the pattern //image-service.unbounce.com/https%3A%2F%2Fapp.unbounce.com%2Fpublish%2Fassets%2F{uuid}%2F{filename}?{params}.',
              'NEVER use URLs in the format app.unbounce.com/assets/{uuid}/{filename} (without /publish/) — those are private builder paths that fail on the public domain.',
              'Logos, photographs, headshots, product shots, hero imagery: all reuse, never substitute. The variant rules under VIDEO BACKGROUNDS / IMAGERY apply equally here.',
            ].join('\n'),
          },
          {
            rule: 'PRESERVE USER CUSTOMIZATIONS — never modify user-authored HTML/JS or hand-applied classes',
            detail: [
              'Classic Builder lets users drop in arbitrary HTML, custom JS, and add their own CSS classes to elements. These are code the user wrote — you have no reliable way to reason about what they do. Treat them as black boxes.',
              '',
              'CUSTOM HTML WIDGETS (<div class="lp-element lp-code" ...> blocks that sit ALONGSIDE other Classic Builder widgets like text blocks, images, and forms on the same page — the user dropped them in via the "Custom HTML" widget): copy the inner HTML verbatim into the replica, in the same position the source had it. Don\'t minify, reformat, audit values inside, or "improve" them. Common contents: 3rd-party embeds (Calendly, HubSpot, Typeform, video players, chat widgets), custom navigation/modals, tracking pixels. Any change you make can silently break the integration. Note: this is a DIFFERENT mechanism from the single lp-code element MCP-managed variants use to hold their entire body content — the latter is the variant body, not a widget, and is replaced as part of the modernization.',
              '',
              'CUSTOM <script> TAGS that aren\'t Unbounce\'s runtime (publisher.bundle.js, lp-page-builder bundles, GA/GTM that the user obviously added, etc.): preserve verbatim, AND match the source\'s placement. Classic Builder offers three placement slots — "Head", "After Body Tag" (immediately after <body>), and "Before Body End Tag" (immediately before </body>). Use the get_javascripts tool to read every custom script from the source variant; it returns each script\'s placement as "head", "body_top" (= After Body Tag), or "body_bottom" (= Before Body End Tag). Then call set_javascripts on the replica with the same list, preserving placement and order. DO NOT try to inline these scripts inside lp-code-1 / the variant body — they belong in the script slots, not in the body content. Order within a slot matters; preserve it.',
              '',
              'After placing custom scripts, scan their bodies for selectors targeting Classic Builder auto-IDs (#lp-pom-block-12, #lp-pom-image-458) or .lp-pom-* classes and INCLUDE A NOTE in your delivery summary listing each one — those selectors will not work in the modernized DOM and the user needs to update them. Do NOT try to rewrite the user\'s JS yourself.',
              '',
              'HAND-APPLIED CSS CLASSES (e.g. <div class="lp-element lp-pom-box customClassName" id="lp-pom-box-15"> — the customClassName is the user\'s, the rest is auto-generated): preserve customClassName on whichever element in your replica plays the most equivalent role. The lp-element and lp-pom-* classes do NOT carry over — they\'re meaningless in the new structure.',
              '',
              'Mapping a hand-applied class to the right element after restructuring is judgment-based. When the original element was visually distinct (a specific button, a specific image, a specific section), the mapping is usually clear. When ambiguous, place the class on your best-guess element AND log the uncertainty in your delivery summary so the user can move it. Better to preserve imperfectly than drop entirely.',
              '',
              'AUTO-GENERATED IDs (#lp-pom-{type}-{n}): drop. They were generated for a structure that no longer exists, and the same ID landing on the wrong element is worse than no ID. JS that depends on them is a known migration cost — already flagged via the script-scanning step above.',
            ].join('\n'),
          },
          {
            rule: 'WEB FONTS — load them or they will silently fall back',
            detail: 'The source page\'s fonts are declared via window.ub.page.webFonts = ["Jost:700,regular,600,300italic"] (or similar). The replica must include a <link rel="stylesheet" href="https://fonts.googleapis.com/css2?..."> tag for the same family and weight set, OR an @import in the CSS. Without it the replica falls back to system fonts and the audit values become meaningless. If the source has visible Google Fonts <link> tags already, copy them verbatim.',
          },
          {
            rule: 'VIDEO BACKGROUNDS — preserve provider, ID, embed params, and color overlay',
            detail: [
              'If the source has a section with a video background:',
              '• Reuse the EXACT same video provider (YouTube/Vimeo) and video ID. Look for <iframe id="lp-pom-block-{N}-video-background-iframe" src="//www.youtube.com/embed/{videoId}?...">.',
              '• Preserve the embed query parameters from the source iframe: mute, autoplay, loop, controls, modestbranding, rel, iv_load_policy, disablekb, fs, playsinline. Each is a design decision.',
              '• Color overlay: look for <div id="lp-pom-block-{N}-color-overlay"> in the HTML and the matching CSS rule for its background-color and opacity. Replicate verbatim. If no overlay exists, do not add one.',
              '• Layout the video as a positioned background within its section using a wrapping div with overflow:hidden and the iframe set to cover the section (similar to lp-pom-video-background\'s structure but with modern CSS — width:100%, height:100%, object-fit equivalent via aspect-ratio + padding-bottom hack or width:177.78% on a 16:9 video to preserve the original "stretch background to page edges" feel).',
            ].join('\n'),
          },
          {
            rule: 'DRIFT CORRECTION — normalize manual-placement noise, preserve intentional design',
            detail: [
              'Classic Builder requires users to drag every element into place, so visually-identical sibling elements (feature cards in a row, stat tiles, button groups, form rows, testimonials) often differ by a few pixels due to imprecise dragging. NORMALIZE these — but only when ALL of the following hold:',
              '• The elements share the same parent and clearly play the same role,',
              '• Their differences are small (typically <2% of the larger dimension AND ≤8px in absolute terms),',
              '• The values are jittery / random (e.g. 198, 201, 199, 202) rather than forming a meaningful pattern (e.g. 200, 220, 240 ascending = intentional).',
              'When you normalize a group, take the median value and LIST what you changed in your audit notes: e.g. "Normalized feature card widths from [298, 301, 300, 299] → 300px (drift correction)".',
              'If the values already sit on a design-system spacing scale (4/8/12/16/24/32/48/64/96), they were intentional — leave them alone.',
              'When in doubt, lean toward NOT normalizing: better to be true to the original than to "improve" something that was intentional.',
            ].join('\n'),
          },
          {
            rule: 'NO CREATIVE CHANGES — replication only',
            detail: 'This is a replication task, not a redesign. You have ZERO creative latitude. Do not change copy, do not "tighten" wording, do not add or remove sections, do not swap CTA verbs ("Get Started" → "Start Now" is forbidden), do not adjust color contrast for accessibility, do not change image crops, do not reorder fields. If the source has a typo, the replica has the same typo. If the user wants creative changes, that is a different task done in a separate variant after the replica is approved.',
          },
          {
            rule: 'RESPONSIVE LAYOUT — replace absolute positioning with flexbox/grid',
            detail: [
              'The source uses position:absolute everywhere — that is the entire point we are migrating away from. The replica MUST be implemented with modern flexbox and grid such that:',
              '• Desktop renders pixel-faithfully to the source (the audit values determine widths, heights, gaps, padding).',
              '• At narrower viewports, multi-column rows collapse to single columns; gaps reduce proportionally; text remains legible.',
              '• Use clamp() or media queries for font sizes that would otherwise be too large on mobile.',
              '• No element uses position:absolute except for genuinely-overlapping elements like a logo over a hero image or a video color overlay.',
              '• Do NOT use min-height tricks, magic-number margins, or absolute hacks to "fake" the layout. If you find yourself fighting the layout, the parent container\'s flex/grid setup is wrong; fix it there.',
            ].join('\n'),
          },
          {
            rule: 'AUDIT COMPLETION CHECK — every audited element must be reflected in the output',
            detail: [
              'Before screenshotting the replica for the side-by-side, walk through every row of your audit and confirm each maps to a specific element in the HTML you wrote. The audit is the source of truth. An audit row is only complete when you can name the specific element in your output that corresponds to it.',
              '',
              'Common silent bug: when one source asset plays MULTIPLE roles, the second use can be lost during generation because the audit row was "mentally checked off" after the first. Particular traps to verify deliberately:',
              '• Same-source asset, multiple roles: the same image URL used as both a section background AND a foreground inset (common in parallax sections), the same color used in 12 elements, the same copy string used as both a hero CTA and a footer CTA. Dedupe ONLY by (source + role + position) — never by source alone. If the source has the same image as both background and inset in a section, the replica needs both elements, not one.',
              '• Repeated patterns: a 4-card grid, a 3-tile feature row, multiple form fields. Count them in the audit. Count them again in the HTML. The numbers must match.',
              '• Brand tokens: a brand color isn\'t "used" because it\'s defined as a CSS variable; it\'s used because every element that should have it explicitly references it.',
              '',
              'If you find an audit row with no matching element, add the element before declaring done.',
            ].join('\n'),
          },
          {
            rule: 'PASS CRITERIA — concrete checks for the side-by-side comparison',
            detail: [
              'After deploying the replica and screenshotting it, place the source and replica side by side. The replica passes when ALL of these hold:',
              '• Every text string is byte-identical to the source (case, punctuation, whitespace).',
              '• Every font-family / font-weight matches.',
              '• Every color is within RGB delta ≤ 8 of the source.',
              '• No visible element has a position offset > 16px from where it sits in the source (at desktop width).',
              '• Every image is present and at the same approximate size (within 5%).',
              '• Every form field is present, in the same order, with the same labels and placeholders.',
              '• Every button label and CTA matches verbatim.',
              'List ANY remaining difference you can see, even small ones, before declaring done. If you find yourself writing "minor visual difference" — describe it concretely.',
            ].join('\n'),
          },
          {
            rule: 'DELIVERY — inactive variant on the same page',
            detail: 'When the replica passes, call add_variant on the SAME page (sub_account_id and page_id from get_variant), then rename_variant to "Control Replica — Clean HTML". DO NOT activate the variant, DO NOT set traffic weights, DO NOT promote it. The user reviews and decides what to do next. If the page is in standard mode, leave it that way; do not switch to A/B test mode.',
          },
        ],
      }
    }

    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}
