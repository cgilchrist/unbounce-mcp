# Upstream Notes

Tracks Unbounce-side issues we work around (so future-us knows what's defensive
code vs. essential code) and API gaps we wish were closed.

When you fix a bug here, **delete the entry** and the workaround it points to.
When you find a new one, log it here with a code reference.

---

## Unbounce bugs we work around

### REST `GET /pages/{uuid}` always returns `variantsCount: 0`

The public REST API's `variantsCount` field is permanently `0` regardless of
how many variants exist on the page. Reproduced end-to-end: deployed a
sandbox page (1 variant) → REST said `0`; added 3 challengers via
`add_variant` (4 total) → REST still said `0`. GraphQL `pageVariants` returned
the correct count both times.

**Workaround:** [`src/tools.js`](src/tools.js) `case 'get_page'` runs the
GraphQL variants query alongside the REST fetch and overrides
`variants_count` with the real total. Adds `variants_active_count` for the
non-discarded count.

**Also affects:** `list_pages` `with_stats` — still REST-sourced and broken.
Fixing it means N GraphQL calls per page in the list (deferred for perf);
the tool description warns agents to use `get_page` for accurate counts.

---

### `.unbounce` import defaults routing strategy to `weighted`

Uploading a `.unbounce` file (any source — our packager OR a Classic
Builder export untouched, uploaded directly via the Unbounce UI's "Upload
Unbounce File" feature) lands the page in `weighted` routing strategy.
Single-variant pages then display as "A/B Test" in the Pages list. Almost
certainly broken upstream when Smart Traffic was introduced and the import
default was never updated.

**Workaround:** [`src/tools.js`](src/tools.js) `uploadAndConfigure` always
calls `setTrafficMode` after upload — `'standard'` for single-variant,
`trafficMode || 'ab_test'` for multi-variant. Costs one extra GraphQL call
(~300ms) per deploy.

---

### Asset upload returns rejections via JS callback in HTML

`POST /{sub_account_id}/assets` doesn't return JSON. The success response is
HTML containing
`window.parent.editor.activeAssetUploader.assetUploaded({...})`; the failure
response is the same shape but with `assetUploadFailed([...errors])`. We
parse both via regex out of the HTML body. Brittle — any template change
upstream silently breaks rehost.

**Workaround:** [`src/asset-upload.js`](src/asset-upload.js)
`parseAssetUploadResponse` handles both shapes and tolerates single- or
double-quoted string values. [`src/direct.js`](src/direct.js)
`directUploadImage` attaches a 400-char response preview when the parser
can't recognize the shape, so the next time it changes we see what we got.

---

### ImageMagick rejects spec-valid synthetic PNGs

Tiny heavily-compressed PNGs (the kind AI tools generate as placeholders —
e.g. a 64×64 grayscale+alpha encoded in 97 bytes) are valid per the PNG
spec and decode in Node, but Unbounce's server-side ImageMagick returns
`Paperclip::Errors::NotIdentifiedByImageMagickError`. Not fixable our side.

**Workaround:** [`src/asset-upload.js`](src/asset-upload.js)
`parseAssetUploadResponse` translates `assetUploadFailed([...])` into a
clear error message including the Paperclip error name. The integrity
guard in [`src/image-rehost.js`](src/image-rehost.js) `rehostImages` then
fails the deploy loudly with that reason instead of shipping a half-broken
page.

---

## API / feature requests

Things we'd ask Unbounce to add or change. Each entry is a "we worked
around it but it cost us complexity" signal.

- **Reliable variant count in REST.** Fix `variantsCount` on
  `GET /pages/{uuid}` and `GET /sub_accounts/{id}/pages?with_stats=true` so
  we don't need a second GraphQL call to count variants.
- **JSON response shape on `POST /{sub_account_id}/assets`.** Returning
  HTML with embedded JS callbacks is fragile. A simple JSON body with
  `id / uuid / name / cdn_url` (success) or `errors[]` (failure) would
  remove our regex parser entirely.
- **A documented `.unbounce` import API.** We currently reverse-engineered
  the two-step `presigned_post_fields.json` → `import_upload.json` flow.
  An official endpoint that accepts the `.unbounce` buffer, optional
  routing strategy, and slug/domain in one call would eliminate
  `uploadAndConfigure`'s post-upload patching dance.
- **Bulk variant create.** Adding 5 variants today is 5 sequential calls
  (each spawns a Playwright page navigation). A `createVariants(pageId,
  variants[])` GraphQL mutation would let multi-variant deploys finish in
  one round-trip.
- **`Routing strategy` parameter on page-create.** So we don't need a
  follow-up `setRoutingStrategy` call (and so the "import default →
  weighted" bug above stops mattering).
- **A direct REST/GraphQL way to read full page HTML+CSS** (analogous to
  what we get back via `get_variant`) without going through the editor's
  variant-state endpoints.
