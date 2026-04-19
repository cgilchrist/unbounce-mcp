#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { TOOL_DEFINITIONS, handleTool } from './src/tools.js'
import { closeBrowser } from './src/browser.js'

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
