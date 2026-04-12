/**
 * MCP tool definitions and handlers.
 * Each tool maps to one or more API / browser actions.
 */

import * as fs from 'fs'
import * as path from 'path'
import { packageToUnbounce } from './packager.js'
import {
  getAccounts, getSubAccounts, getDomains,
  getSubAccountPages, pollForNewPage, pollPageStatus,
} from './api.js'
import { uploadPage } from './upload.js'
import {
  getUploadCredentials, setPageUrl, setTrafficMode,
  setVariantWeights, publishPage, unpublishPage, deletePage, editVariantHtml,
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
async function uploadAndConfigure({ fileBuffer, fileName, pageName, subAccountId, domain, slug, trafficMode, variantWeights, variantIds, isMultiVariant, publish }) {
  // Snapshot existing pages before upload
  const existingPages = await getSubAccountPages(subAccountId)
  const existingIds = existingPages.map(p => p.id)

  // Upload
  const { cookies, csrfToken } = await getUploadCredentials(subAccountId)
  await uploadPage(subAccountId, fileBuffer, fileName, cookies, csrfToken)

  // Poll for the new page
  const newPage = await pollForNewPage(subAccountId, existingIds)
  const pageId = newPage.id

  // Set URL
  if (domain) {
    const resolvedSlug = slug !== undefined ? slug : slugify(pageName)
    await setPageUrl(subAccountId, pageId, domain, resolvedSlug)
  }

  // Traffic mode + variant weights
  if (isMultiVariant) {
    const resolvedMode = trafficMode || 'ab_test'
    await setTrafficMode(subAccountId, pageId, resolvedMode)
    if (resolvedMode === 'ab_test') {
      const weights = variantWeights || evenWeights(variantIds)
      await setVariantWeights(subAccountId, pageId, weights)
    }
  }

  // Publish
  let liveUrl = null
  if (publish) {
    await publishPage(subAccountId, pageId)
    const published = await pollPageStatus(pageId, 'published')
    liveUrl = published.url
  }

  return {
    page_id: pageId,
    page_name: pageName,
    url: liveUrl,
    variants: variantIds.length,
    traffic_mode: isMultiVariant ? (trafficMode || 'ab_test') : 'standard',
    note: "FYI — you'll get a confirmation email from Unbounce confirming the page was uploaded to your account.",
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
    description: 'Package one or more HTML files into an Unbounce page, upload it, configure the URL and traffic mode, and publish it. Returns the live URL. For pre-packaged .unbounce files, use upload_unbounce_file instead.',
    inputSchema: {
      type: 'object',
      properties: {
        html_file_paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Absolute paths to HTML files on disk. Multiple files = A/B test variants (A, B, C...).',
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
      required: ['html_file_paths', 'sub_account_id'],
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
    description: 'Permanently delete an Unbounce page and all its variants. This cannot be undone.',
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
    description: 'Switch a multi-variant page between A/B Test and Smart Traffic modes. If the page is published, it will be republished automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        sub_account_id: { type: 'string' },
        page_id: { type: 'string' },
        mode: {
          type: 'string',
          enum: ['ab_test', 'smart_traffic'],
        },
      },
      required: ['sub_account_id', 'page_id', 'mode'],
    },
  },
  {
    name: 'set_variant_weights',
    description: 'Set A/B test traffic split percentages for a multi-variant page. Weights must be integers summing to 100. Page will be republished if it was already live.',
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
    name: 'edit_variant',
    description: 'Replace the HTML of a specific variant on an Unbounce page. Use this to update copy, layout, or design of an individual variant without re-uploading the entire page. Changes are saved immediately in the Unbounce editor. You will need to publish/republish the page after editing.',
    inputSchema: {
      type: 'object',
      properties: {
        sub_account_id: { type: 'string' },
        page_id: { type: 'string', description: 'UUID of the page' },
        variant: { type: 'string', description: 'Variant letter: a, b, c, d, etc.' },
        html: { type: 'string', description: 'Full HTML content to set for this variant' },
      },
      required: ['sub_account_id', 'page_id', 'variant', 'html'],
    },
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
        html_file_paths,
        page_name,
        sub_account_id,
        domain,
        slug,
        traffic_mode,
        variant_weights,
        publish = true,
      } = args

      const htmlFiles = await Promise.all(
        html_file_paths.map(async (filePath) => {
          const html = await fs.promises.readFile(filePath, 'utf8')
          return { name: path.basename(filePath), html }
        })
      )

      const resolvedPageName = page_name || path.basename(html_file_paths[0], '.html')
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
      await setTrafficMode(args.sub_account_id, args.page_id, args.mode)
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

    case 'edit_variant': {
      const result = await editVariantHtml(args.sub_account_id, args.page_id, args.variant, args.html)
      return result
    }

    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}
