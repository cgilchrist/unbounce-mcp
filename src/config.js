import * as os from 'os'
import * as path from 'path'

export const UNBOUNCE_API_KEY = process.env.UNBOUNCE_API_KEY
export const UNBOUNCE_API_BASE = 'https://api.unbounce.com'
export const UNBOUNCE_APP_BASE = 'https://app.unbounce.com'

export const SESSION_DIR = path.join(os.homedir(), '.unbounce-mcp')
export const SESSION_FILE = path.join(SESSION_DIR, 'session.json')

export function requireApiKey() {
  if (!UNBOUNCE_API_KEY) {
    throw new Error('UNBOUNCE_API_KEY environment variable is required. Add it to your MCP config.')
  }
  return UNBOUNCE_API_KEY
}
