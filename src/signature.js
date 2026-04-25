/**
 * Stamp every variant body the MCP writes with a one-line HTML comment
 * identifying the server version, the client (Claude Desktop / Codex / etc.),
 * and the timestamp. Useful for triage when a variant misbehaves: search
 * variant HTML for "unbounce-mcp@" and you can tell which integration
 * produced it and when.
 *
 * The MCP cannot know the underlying language model the user picked inside
 * their client (Sonnet / Opus / etc.) — model selection is internal to the
 * client and never crosses the JSON-RPC boundary. Client name + version is
 * the most stable triage signal we can capture.
 */

import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PKG = JSON.parse(readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'))
const SERVER_VERSION = PKG.version

let _server = null

/** Called once at startup so the signature can read clientInfo from the SDK. */
export function registerServer(server) {
  _server = server
}

// Matches an existing signature comment at the START of the body so re-edits
// replace rather than stack. Anchored to ^ because stamps are always written at
// position 0 — anchoring guards against false positives if a stamp-like string
// ever appears inside a <script> or <style> block elsewhere in the body.
export const SIGNATURE_RE = /^<!--\s*unbounce-mcp@[^\n]*?-->\s*\n?/

/**
 * Prepend (or replace) a one-line signature comment at the start of body HTML.
 * Safe to call repeatedly — re-edits replace the previous stamp.
 *
 * Returns the input unchanged if it's empty/falsy (e.g. CSS-only edits).
 */
export function stampBodyHtml(html) {
  if (!html) return html
  const stripped = html.replace(SIGNATURE_RE, '')
  const client = _server?.getClientVersion?.()
  const clientPart = client ? `client: ${client.name}@${client.version}` : 'client: unknown'
  const stamp = `<!-- unbounce-mcp@${SERVER_VERSION} · ${clientPart} · ${new Date().toISOString()} -->\n`
  return stamp + stripped
}
