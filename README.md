# unbounce-mcp

MCP server for publishing landing pages to Unbounce — no UI required. Give Claude an HTML file and a prompt; get a live URL back.

## What it does

- Packages HTML files into Unbounce's `.unbounce` format (supports multi-variant A/B tests)
- Uploads to your Unbounce account
- Sets the page URL (domain + slug)
- Configures traffic mode (A/B test with custom weights, or Smart Traffic)
- Publishes the page and returns the live URL

You never touch the Unbounce UI or see the `.unbounce` format.

## Setup

### 1. Get your Unbounce API key

In Unbounce: **Account Settings → API → Generate New API Key**

### 2. Add to your Claude MCP config

```json
{
  "mcpServers": {
    "unbounce": {
      "command": "npx",
      "args": ["-y", "github:cgilchrist/unbounce-mcp"],
      "env": {
        "UNBOUNCE_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

### 3. Install the Playwright browser (one-time)

```bash
npx playwright install chromium
```

### 4. First-run login

The first time you use a browser-based tool (upload, publish, etc.), a Chrome window will open. Log in to your Unbounce account — this handles SSO, Google login, and 2FA naturally. Your session is saved to `~/.unbounce-mcp/session.json` and reused automatically from then on.

Your credentials are never stored. Only the browser session cookies are saved.

## Usage

**Deploy a single page:**
```
Publish my landing page at /path/to/page.html to my Unbounce account on unbouncepages.com/summer-promo
```

**Deploy an A/B test:**
```
Upload these three variants to Unbounce with an even traffic split:
- /path/to/variant-a.html
- /path/to/variant-b.html
- /path/to/variant-c.html
Publish on leads.mycompany.com/campaign
```

**Use Smart Traffic:**
```
Deploy /path/to/page.html to Unbounce with Smart Traffic enabled
```

Claude will ask for anything it needs (account, domain, slug) if you don't provide it upfront.

## Tools

| Tool | Description |
|------|-------------|
| `list_accounts` | List Unbounce accounts |
| `list_sub_accounts` | List clients within an account |
| `list_domains` | List domains for a sub-account |
| `deploy_page` | Full pipeline: package → upload → configure → publish |
| `publish_page` | Publish an existing page |
| `unpublish_page` | Take a page offline |
| `delete_page` | Permanently delete a page |
| `set_page_url` | Change a page's domain/slug |
| `set_traffic_mode` | Switch between A/B Test and Smart Traffic |
| `set_variant_weights` | Set custom A/B split percentages |

## Notes

- After uploading, Unbounce sends a confirmation email — this is expected and not an error
- Variant weights must be integers summing to 100 (e.g. 3 variants → 34/33/33)
- If your session expires, a browser window will open to re-authenticate
