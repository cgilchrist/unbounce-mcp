#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { TOOL_DEFINITIONS, handleTool } from './src/tools.js'
import { closeBrowser } from './src/browser.js'
import { VARIANT_CREATION_RULES } from './src/variant-rules.js'

const server = new Server(
  {
    name: 'unbounce-mcp',
    version: '0.1.0',
    instructions: `
Unbounce data model — understand this before navigating the API:

The hierarchy is:
  Account → Client/Sub-account → Page → Page Variant

- Account: the billing entity (subscription, credit card). A user has one primary account but can be invited into others.
- Client (also called Sub-account or Company in older API versions — these are all the same concept): the workspace where pages live. Most accounts have one client per customer or brand. Tools that operate on pages require a sub_account_id.
- Page: a landing page. Has one or more variants (A/B test) or a single champion variant.
- Page Variant: the actual HTML/CSS content. Variants are identified by letter (a, b, c…). Variant A is the champion; others are challengers.
- Page Group: optional folder for organising pages within a client. A page can belong to multiple groups.
- Domain: a custom domain or the default unbouncepages.com subdomain, scoped to a client.

The terms "client", "sub-account", and "company" refer to the same object. The REST API uses "sub_account", older GraphQL uses "company". Treat them as identical.

When a user refers to a page by name without providing IDs, use find_page to locate it before proceeding.

When a user asks you to create, build, design, or generate a landing page, you MUST call get_landing_page_guidelines before writing any HTML.

When a user asks you to MODERNIZE, RECREATE AS CLEAN HTML, REPLICATE, get rid of ABSOLUTE POSITIONING, or make a Classic Builder page RESPONSIVE — phrasings like "modernize variant X", "make a clean HTML version", "responsive replica", "convert from Classic Builder" — you MUST call get_classic_builder_modernization_guidelines BEFORE writing any HTML. That tool returns the audit-first workflow and the fidelity rules that govern this kind of replication; skipping it will produce a redesign instead of a replica.

When a user asks you to add or create a variant on an existing page, you MUST do all of the following before writing any HTML or CSS:
1. Call get_page_variants to identify the champion variant — do not assume it is "a".
2. Call screenshot_variant on the champion to visually understand the current design.
3. Call get_variant on the champion to read its HTML and CSS.
Then ensure the new variant preserves the existing brand identity — colors, typography, spacing, imagery, and overall visual language — unless the user explicitly asks to change them. Layout structure may vary freely; it is the visual brand that must stay consistent. The user should not need to say "keep it on brand"; that is always the default.

${VARIANT_CREATION_RULES}

When reauthenticate returns status "browser_opened": stop all tool calls immediately and tell the user the browser is open and to let you know once they have signed in and the window has closed. Do NOT retry any tool until the user explicitly confirms login is complete.

When setting up an A/B test on a page that was in standard mode (single variant), follow this exact order:
1. set_traffic_mode(ab_test) — switch to A/B test routing FIRST. Do this before activate_variant, because activate_variant behaves differently per mode: in standard mode it replaces the champion (wrong); in A/B test mode it adds the variant as a challenger (correct).
2. activate_variant on the new challenger variant.
3. set_variant_weights to set the traffic split.
4. publish_page.
`.trim(),
  },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOL_DEFINITIONS,
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params
  try {
    const result = await handleTool(name, args || {})
    if (result?._type === 'image') {
      return {
        content: [
          { type: 'image', data: result.data, mimeType: result.mimeType },
          { type: 'text', text: result.caption ?? '' },
        ],
      }
    }
    if (result?._type === 'images') {
      return {
        content: result.images.flatMap(img => [
          { type: 'image', data: img.data, mimeType: img.mimeType },
          { type: 'text', text: img.caption ?? '' },
        ]),
      }
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${err.message}` }],
      isError: true,
    }
  }
})

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch(err => {
  console.error('[unbounce-mcp] Fatal error:', err)
  process.exit(1)
})

process.on('exit', () => { closeBrowser().catch(() => {}) })
process.on('SIGINT', async () => { await closeBrowser().catch(() => {}); process.exit(0) })
process.on('SIGTERM', async () => { await closeBrowser().catch(() => {}); process.exit(0) })
