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

### 2. Add the MCP server

Pick your client:

<details>
<summary><strong>Claude — CLI (Claude Code)</strong></summary>

Run this command to add the server:

```bash
claude mcp add unbounce -- npx -y github:cgilchrist/unbounce-mcp
```

Then set your API key. Open `~/.claude.json`, find the `unbounce` entry under `mcpServers`, and add an `env` block:

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

</details>

<details>
<summary><strong>Claude — Desktop App</strong></summary>

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (create it if it doesn't exist):

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

Restart the Claude desktop app after saving.

</details>

<details>
<summary><strong>Codex — CLI</strong></summary>

Run this command to add the server:

```bash
codex mcp add unbounce --env UNBOUNCE_API_KEY=your-api-key-here -- npx -y github:cgilchrist/unbounce-mcp
```

Or add it manually to `~/.codex/config.toml`:

```toml
[mcp_servers.unbounce]
command = "npx"
args = ["-y", "github:cgilchrist/unbounce-mcp"]
env = { UNBOUNCE_API_KEY = "your-api-key-here" }
```

</details>

<details>
<summary><strong>Codex — Desktop App</strong></summary>

1. Open **Settings → MCP Servers → Add MCP Server**
2. Fill in the fields:
   - **Name:** `unbounce`
   - **Command:** `npx`
   - **Arguments:** `-y github:cgilchrist/unbounce-mcp`
   - **Environment variables:** `UNBOUNCE_API_KEY=your-api-key-here`
3. Save and restart if prompted.

</details>

### 3. Install the Playwright browser (one-time)

```bash
npx playwright install chromium
```

### 4. First-run login

The first time you use a browser-based tool (upload, publish, etc.), a Chrome window will open. Log in to your Unbounce account — this handles SSO, Google login, and 2FA naturally. Your session is saved to `~/.unbounce-mcp/session.json` and reused automatically from then on.

Your credentials are never stored. Only the browser session cookies are saved.

## Usage

**Generate and deploy in one step (no files needed):**
```
Create a landing page for a SaaS product called Acme — hero, features, form — and publish it to my Unbounce account on unbouncepages.com/acme
```
Claude generates the HTML and passes it directly to the MCP. No files, no download step.

**Deploy a single page from a file:**
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

**Generate 3 variants and deploy in one go:**
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

### Account & structure
| Tool | Description |
|------|-------------|
| `list_accounts` | List all Unbounce accounts |
| `list_sub_accounts` | List clients within an account |
| `list_domains` | List domains available for publishing |
| `list_page_groups` | List page groups (folders) within a sub-account |
| `list_users` | List users with access to the account |

### Pages
| Tool | Description |
|------|-------------|
| `list_pages` | List all pages in a sub-account with status and URL |
| `find_page` | Search for a page by name across sub-accounts — returns page_id and sub_account_id |
| `get_page` | Get details of a specific page |
| `find_pages_by_stats` | Filter pages by performance — find pages with no traffic, zero conversions, high conversion rate, etc. |
| `get_page_stats` | Get visitors, conversions, and conversion rate — page totals and per-variant breakdown, with optional date range |
| `get_page_insights` | Get Industry Benchmark Report insights — percentile rank, performance rating, traffic channel recommendations |
| `deploy_page` | Full pipeline: package HTML → upload → configure → publish |
| `upload_unbounce_file` | Upload a pre-packaged `.unbounce` file |
| `publish_page` | Publish or republish a page |
| `unpublish_page` | Take a page offline |
| `delete_page` | Permanently delete a page |
| `duplicate_page` | Duplicate a page including its variants and integrations |
| `set_page_url` | Change a page's domain and slug |
| `set_traffic_mode` | Switch between A/B Test and Smart Traffic |
| `set_variant_weights` | Set custom A/B split percentages |

### Variants
| Tool | Description |
|------|-------------|
| `get_variant` | Read the current HTML and CSS of a specific variant |
| `edit_variant` | Update a variant's HTML, CSS, or both. Pass a full HTML document (`<!DOCTYPE html>`) to have it automatically bundled (CSS extraction + scoping, form wrapping, body extraction) — same pipeline as `deploy_page`. Pass HTML/CSS fragments to update them directly. |
| `get_page_variants` | List all variants (champion, challengers, discarded) with names, traffic weights, states, and preview paths |
| `screenshot_variant` | Take a full-page screenshot of any variant (published or unpublished) and return it as an image — primary tool for visual design inspection before creating new variants |
| `get_variant_preview_url` | Get a live preview URL for any variant — published or unpublished. Returns an agent-inspection URL and a user-shareable link. |
| `add_variant` | Add a new variant by duplicating variant A, optionally with new HTML/CSS |
| `rename_variant` | Rename a variant to a descriptive label (e.g. "Outcome Headline") |

### Leads
| Tool | Description |
|------|-------------|
| `list_leads` | Get form submission leads for a page (supports pagination) |
| `get_lead` | Get a single lead by ID |

## Notes

- After uploading, Unbounce sends a confirmation email to your Unbounce account email — this is expected and not an error
- Variant weights must be integers summing to 100 (e.g. 3 variants → 34/33/33)
- If your session expires, a browser window will open to re-authenticate

## Development

The repo ships with a local test harness so changes can be developed and verified without restarting any MCP client. See `docs/superpowers/specs/2026-04-23-test-harness-design.md` for the full design.

### One-time sandbox setup

1. Create a **sandbox Unbounce client** with its own API key.
2. Create a **dedicated test user** in Unbounce and invite them *only* to the sandbox client.
3. Copy `.env.test.example` to `.env.test` and fill in the sandbox API key, session file path, and sub-account ID.
4. Run the one-time headed login — log in as the **test user**, not your personal account:
   ```bash
   npm run login
   ```
   Cookies save to the path configured in `UNBOUNCE_MCP_SESSION_FILE`.

### Unit tests

Pure-logic tests. No network, no browser, runs in ~1 second.

```bash
npm run test:unit
```

### Smoke tests

End-to-end scenarios against the sandbox. Each test creates a page, exercises the tools, and deletes the page in a `finally` block.

```bash
npm run test:smoke
```

### Interactive runner

Invoke any tool against the sandbox with live stderr visible:

```bash
npm run mcp -- list_pages '{}'
npm run mcp -- screenshot_variant '{"page_id":"xyz","variant":"a"}'
```

The runner fills in `sub_account_id` from `UNBOUNCE_SANDBOX_SUB_ACCOUNT_ID` when omitted from the args. Each run saves its stderr log and any returned images under `.test-runs/<timestamp>-<tool>/`.

### Full suite

```bash
npm test
```

### Cleaning up orphaned sandbox pages

If a smoke test ever fails mid-flight and its `finally` cleanup doesn't complete, the created page is left in the sandbox. Every smoke test logs `[smoke] created page <id>` right after deploy, so the id is always traceable. To clean them up in bulk:

```bash
npm run clean-sandbox           # dry-run — lists all smoke-* pages
npm run clean-sandbox -- --yes  # actually delete them
```

Only pages whose name starts with `smoke-` are touched.

### Contributing notes

- **`console.log` is forbidden** in `src/`. `stdout` is the MCP transport — a stray `console.log` corrupts JSON-RPC frames. Always use `console.error` for debug output; the harness streams stderr live with an `[mcp]` prefix.
- Unit tests use Node 18+'s built-in `node:test`. No Jest / Vitest dependency.
- See [`UPSTREAM.md`](UPSTREAM.md) for the running log of Unbounce-side bugs we work around (and where the workaround lives) plus API gaps worth raising upstream.
