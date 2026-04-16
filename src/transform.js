/**
 * HTML/CSS transform utilities shared between the packager (deploy_page) and
 * the direct variant editor (edit_variant).
 *
 * Exported:
 *   prepareVariantContent(html, variantId) → { bodyHtml, cssHtml }
 *     Full-document transform: extracts + scopes CSS, transforms forms,
 *     returns body innerHTML and a <style> block ready for lp-stylesheet-1.
 *
 *   scopeRawCss(css) → string
 *     Scopes an arbitrary CSS string (no <style> wrapper needed) and returns
 *     it wrapped in <style> tags, ready for lp-stylesheet-1.
 *
 *   scopeCssToContainer(css, scope) → string
 *   transformForms($, variantId) → boolean
 *     Lower-level exports used directly by packager.js.
 */

import * as cheerio from 'cheerio'

// ── Helpers ────────────────────────────────────────────────────────────────────

function labelToName(label) {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'field'
}

const LAYOUT_OVERRIDES = `
/* ubexport layout overrides */
#lp-pom-root {
  height: auto !important;
  min-height: 0 !important;
  min-width: 0 !important;
  overflow: visible !important;
  background: transparent !important;
}
#lp-pom-root-color-overlay,
#lp-pom-block-1-color-overlay {
  display: none !important;
}
#lp-pom-root .lp-positioned-content {
  position: relative !important;
  left: auto !important;
  top: auto !important;
  width: 100% !important;
  height: auto !important;
  margin-left: 0 !important;
}
#lp-pom-block-1 {
  display: none !important;
}
#lp-code-1 {
  position: relative !important;
  left: 0 !important;
  top: 0 !important;
  width: 100% !important;
  height: auto !important;
  overflow: visible !important;
  font-size: 16px !important;
  line-height: 1.5 !important;
}
#lp-code-1 h1, #lp-code-1 h2, #lp-code-1 h3,
#lp-code-1 h4, #lp-code-1 h5, #lp-code-1 h6 {
  font-weight: revert;
}
body.lp-pom-body {
  margin: 0 !important;
  padding: 0 !important;
}
`

// ── CSS scoping ────────────────────────────────────────────────────────────────

/**
 * Prefix all CSS selectors with `scope` (e.g. '#lp-code-1') to beat
 * Unbounce's base stylesheet.
 * Handles: @keyframes/@font-face (verbatim), @media/@supports (scope inner
 * rules), :root/html → scope, body selectors → skip (handled separately).
 */
export function scopeCssToContainer(css, scope) {
  const out = []
  let i = 0
  const len = css.length

  function skipWhitespace() {
    while (i < len && /\s/.test(css[i])) i++
  }

  function readBlock() {
    const start = i
    let depth = 0
    while (i < len) {
      if (css[i] === '{') depth++
      else if (css[i] === '}') { depth--; if (depth === 0) { i++; break } }
      i++
    }
    return css.slice(start, i)
  }

  function scopeSelectors(selectorStr) {
    return selectorStr
      .split(',')
      .map(sel => {
        const s = sel.trim()
        if (!s) return s
        if (/^:root\b/.test(s)) return s.replace(/^:root\b/, scope)
        if (/^html\b/.test(s)) return s.replace(/^html\b/, scope)
        if (/^body\.lp-pom-body/.test(s)) return s
        if (/^body\b/.test(s)) return s
        return `${scope} ${s}`
      })
      .join(', ')
  }

  function scopeInnerRules(blockContent) {
    const inner = []
    let j = 0
    const src = blockContent
    const srcLen = src.length

    while (j < srcLen) {
      if (/\s/.test(src[j])) { inner.push(src[j++]); continue }
      if (src[j] === '/' && src[j + 1] === '*') {
        const end = src.indexOf('*/', j + 2)
        const commentEnd = end === -1 ? srcLen : end + 2
        inner.push(src.slice(j, commentEnd))
        j = commentEnd
        continue
      }
      const selStart = j
      while (j < srcLen && src[j] !== '{' && src[j] !== '}') j++
      if (j >= srcLen || src[j] === '}') {
        inner.push(src.slice(selStart, j))
        break
      }
      const rawSel = src.slice(selStart, j).trim()
      let depth = 0
      const blockStart = j
      while (j < srcLen) {
        if (src[j] === '{') depth++
        else if (src[j] === '}') { depth--; if (depth === 0) { j++; break } }
        j++
      }
      const declBlock = src.slice(blockStart, j)
      inner.push(`${scopeSelectors(rawSel)}${declBlock}`)
    }
    return inner.join('')
  }

  while (i < len) {
    skipWhitespace()
    if (i >= len) break

    if (css[i] === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2)
      const commentEnd = end === -1 ? len : end + 2
      out.push(css.slice(i, commentEnd))
      i = commentEnd
      continue
    }

    if (css[i] === '@') {
      const atStart = i
      while (i < len && css[i] !== '{' && css[i] !== ';') {
        if (css[i] === '"' || css[i] === "'") {
          const q = css[i++]
          while (i < len && css[i] !== q) { if (css[i] === '\\') i++; i++ }
          if (i < len) i++ // skip closing quote
        } else {
          i++
        }
      }
      const atHeader = css.slice(atStart, i).trim().toLowerCase()
      const keyword = (atHeader.match(/^@([\w-]+)/) || [])[1] || ''

      if (css[i] === ';') {
        out.push(css.slice(atStart, i + 1))
        i++
        continue
      }

      const headerText = css.slice(atStart, i)
      const block = readBlock()
      const innerContent = block.slice(1, -1)

      if (keyword === 'keyframes' || keyword === '-webkit-keyframes' ||
          keyword === '-moz-keyframes' || keyword === 'font-face' ||
          keyword === 'counter-style') {
        out.push(`${headerText}${block}`)
      } else if (keyword === 'media' || keyword === 'supports' ||
                 keyword === 'layer' || keyword === 'container') {
        out.push(`${headerText}{${scopeInnerRules(innerContent)}}`)
      } else {
        out.push(`${headerText}${block}`)
      }
      continue
    }

    const selStart = i
    while (i < len && css[i] !== '{') i++
    if (i >= len) break
    const rawSel = css.slice(selStart, i).trim()
    const block = readBlock()
    out.push(`${scopeSelectors(rawSel)}${block}`)
  }

  return out.join('\n')
}

// ── Form transformation ────────────────────────────────────────────────────────

/**
 * Wraps loose inputs in <form>, adds Unbounce hidden fields + validation
 * config, and injects window.ub.form. Mutates the cheerio $ in place.
 * Returns true if the page has a form, false otherwise.
 */
export function transformForms($, variantId) {
  if ($('form').length === 0) {
    const looseInputs = $('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"])').filter((_, el) => $(el).closest('form').length === 0)
    if (looseInputs.length > 0) {
      let container = looseInputs.first().parent()
      looseInputs.each((_, el) => {
        while (container.length && !container.find(el).length && container[0].tagName !== 'body') {
          container = container.parent()
        }
      })

      const looseButtons = $('button:not([type="reset"]), input[type="submit"]')
        .filter((_, el) => $(el).closest('form, nav, header, footer').length === 0)
      if (looseButtons.length > 0) {
        let expansions = 0
        while (expansions < 4 && container.length && container[0].tagName !== 'body') {
          const uncaptured = looseButtons.filter((_, el) => !container.find(el).length)
          if (!uncaptured.length) break
          container = container.parent()
          expansions++
        }
      }

      const innerHtml = container.html() || ''
      container.html(`<form method="POST">${innerHtml}</form>`)
    }
  }

  const forms = $('form')
  if (forms.length === 0) return false

  const validationRules = {}
  const validationMessages = {}

  forms.each((formIdx, form) => {
    const $form = $(form)
    $form.attr('method', 'POST')
    $form.removeAttr('onsubmit')

    $form.find('button, input[type="button"]').each((_, btn) => {
      const $btn = $(btn)
      $btn.removeAttr('onclick')
      if (!$btn.attr('type') || $btn.attr('type') === 'button') {
        $btn.attr('type', 'submit')
      }
    })

    $form.prepend(
      `<input type="hidden" name="pageVariant" value="${variantId}">` +
      `<input type="hidden" name="pageId" value="">`
    )

    $form.find('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), select, textarea').each((_, el) => {
      const $el = $(el)
      if (!$el.attr('name')) {
        let labelText = ''
        const id = $el.attr('id')
        if (id) labelText = $(`label[for="${id}"]`).text().trim()
        if (!labelText) labelText = $el.closest('label').text().trim()
        if (!labelText) labelText = $el.closest('.form-group, .field, .input-group').find('label').first().text().trim()
        $el.attr('name', labelText ? labelToName(labelText) : `field_${Math.random().toString(36).slice(2, 7)}`)
      }

      const existingClass = $el.attr('class') || ''
      $el.attr('class', (existingClass + ' ub-input-item').trim())

      const name = $el.attr('name')
      const required = $el.attr('required') !== undefined
      const type = $el.attr('type') || 'text'
      const rule = { required }
      if (type === 'email') rule.email = true
      if (type === 'tel') rule.phone = true
      validationRules[name] = rule
      validationMessages[name] = {}
    })

    $form.wrap(`<div class="lp-element lp-pom-form" id="lp-pom-form-${formIdx + 1}"></div>`)
  })

  const ubForm = {
    action: 'modal',
    validationRules,
    validationMessages,
    customValidators: {},
    url: `${variantId}-form_confirmation.html`,
    lightboxSize: {
      desktop: { height: 240, width: 512 },
      mobile: { height: 240, width: 240 },
    },
    isConversionGoal: true,
  }
  $('body').prepend(`<script>window.ub.form=${JSON.stringify(ubForm)};window.module={lp:{form:{data:window.ub.form}}};</script>`)

  $('body').append(`<script>
(function(){
  function init(n){
    if(n>100) return;
    var ub=window.ub;
    if(!ub||!ub.page){ setTimeout(function(){ init(n+1); },50); return; }
    var id=ub.page.id, v=ub.page.variantId||'${variantId}';
    document.querySelectorAll('.lp-pom-form form').forEach(function(f){
      f.action='/fsg?pageId='+id+'&variant='+v;
      var pi=f.querySelector('input[name="pageId"]');
      var pv=f.querySelector('input[name="pageVariant"]');
      if(pi) pi.value=id;
      if(pv) pv.value=v;
    });
  }
  init(0);
})();
</script>`)

  return true
}

// ── HTML entity decode ─────────────────────────────────────────────────────────

/**
 * Decode numeric HTML entities in CSS strings (e.g. &#10003; → ✓).
 * CSS content properties don't support HTML entities — only literal chars
 * or \XXXX unicode escapes are valid.
 */
function decodeHtmlEntities(css) {
  return css
    .replace(/&#x([0-9a-fA-F]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
}

// ── High-level transforms ──────────────────────────────────────────────────────

/**
 * Extract and scope all <style> blocks from a cheerio-loaded document.
 * Returns a complete <style> block string including layout overrides.
 */
export function extractCss($) {
  const linkTags = $('head link[rel="stylesheet"]').map((_, el) => $.html(el)).get().join('\n')

  const cssChunks = []
  $('head style').each((_, el) => {
    const raw = decodeHtmlEntities($(el).text())
    const bodyScoped = raw.replace(/(?<![a-zA-Z0-9_-])body\b(?!\.lp-pom-body)/g, 'body.lp-pom-body:not(.lp-convertable-page)')
    const css = scopeCssToContainer(bodyScoped, '#lp-code-1')
    cssChunks.push(css)
  })
  cssChunks.push(LAYOUT_OVERRIDES)
  const styleBlock = `<style>\n${cssChunks.join('\n')}\n</style>`
  return linkTags ? `${linkTags}\n${styleBlock}` : styleBlock
}

/**
 * Scope a raw CSS string (no <style> wrapper) and return it as a <style>
 * block with layout overrides appended. Ready for lp-stylesheet-1.content.html.
 */
export function scopeRawCss(css) {
  // Strip any existing <style> wrapper the caller may have included
  const raw = decodeHtmlEntities(css.replace(/^\s*<style[^>]*>/i, '').replace(/<\/style>\s*$/i, ''))
  const bodyScoped = raw.replace(/(?<![a-zA-Z0-9_-])body\b(?!\.lp-pom-body)/g, 'body.lp-pom-body:not(.lp-convertable-page)')
  const scoped = scopeCssToContainer(bodyScoped, '#lp-code-1')
  return `<style>\n${scoped}\n${LAYOUT_OVERRIDES}\n</style>`
}

/**
 * Transform a complete HTML document for use as an Unbounce custom variant.
 *
 * - Transforms forms (wrapping, Unbounce fields, validation config)
 * - Extracts and scopes all <style> blocks → cssHtml
 * - Extracts <body> innerHTML → bodyHtml
 *
 * @param {string} html      Full HTML document string
 * @param {string} variantId Variant letter, e.g. 'a'
 * @returns {{ bodyHtml: string, cssHtml: string }}
 */
export function prepareVariantContent(html, variantId = 'a') {
  const $ = cheerio.load(html)
  transformForms($, variantId)
  const cssHtml = extractCss($)
  const bodyHtml = $('body').html() ?? ''
  return { bodyHtml, cssHtml }
}
