# unbounce-mcp

MCP server for deploying and editing Unbounce landing pages — no UI required. Give Claude or any MCP-compatible client an HTML file and a prompt; get a live URL back. Edit existing pages with nothing but a plain-English instruction.

## What it does

- Packages HTML files into Unbounce's `.unbounce` format (supports multi-variant A/B tests and Smart Traffic if you give it multiple HTML files)
- Uploads to your Unbounce account
- Sets the page URL (domain + slug)
- Configures traffic mode (A/B test with custom weights, or Smart Traffic)
- Publishes the page and returns the live URL
- **Reads and edits any variant's HTML and CSS with a plain prompt** — change a heading, add a section, update copy, tweak styles — without touching the Unbounce editor

You never touch the Unbounce UI or see the `.unbounce` format.

## Setup

### 1. Get your Unbounce API key

In Unbounce: **Account Overview (top right) → API Access (lefthand menu) → Create New API Key (top right)**

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
Deploy /path/to/page1.html, /path/to/page2.html and /path/to/page3.html to Unbounce with Smart Traffic enabled
```

**Do it all in one go:**
```
I want you to create me a landing page with 3 variants. I want the page be html and to to look and feel like it's an airbnb page. I want the page to be a giveaway
contest for a trip to a unique destination. Include standard landing page sections. Have a form that collects email and name to register for the contest. For the different variants
 I want you to come up with your own testing strategy for how the 3 variants should differ. I dont need to preview it when youre done just upload it to Unbounce and publish it to unbouncepages.com/vacation-giveaway
```

**Edit an existing page with a prompt:**
```
Change the heading on variant B to "Only 72 hours left to enter"
```
```
Add a testimonials section to variant A right below the hero
```
```
Update the CTA button color on all variants to match the brand's orange
```

The client reads the current HTML and CSS first, makes the targeted change, and writes it back — without touching anything else on the page.

Your MCP-compatible client will ask for anything it needs (account, domain, slug) if you don't provide it upfront.

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
| `get_variant` | Read the current HTML and CSS of a specific variant |
| `edit_variant` | Update a variant's HTML, CSS, or both with a prompt |

## Notes

- After uploading, Unbounce sends a confirmation email to your Unbounce account email — this is expected and not an error
- Variant weights must be integers summing to 100 (e.g. 3 variants → 34/33/33)
- If your session expires, a browser window will open to re-authenticate
