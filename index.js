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
  { name: 'unbounce-mcp', version: '0.1.0' },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOL_DEFINITIONS,
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params
  try {
    const result = await handleTool(name, args || {})
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
