/**
 * packageToUnbounce — converts HTML files into an Unbounce-compatible .unbounce TAR archive.
 * Extracted from CNVRT's app/api/ubexport/route.ts.
 *
 * @param {Array<{name: string, html: string}>} htmlFiles - HTML variants (up to 26)
 * @param {Array<{name: string, data: Buffer}>} [imageFiles] - Optional image files to inline
 * @param {string} [pageName] - Page name shown in Unbounce
 * @returns {Promise<Buffer>} - The .unbounce TAR file as a Buffer
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'
import * as cheerio from 'cheerio'
import * as tar from 'tar'

const VARIANT_LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('')

function newId() {
  return crypto.randomBytes(8).toString('hex')
}

function mimeForExt(ext) {
  switch (ext.toLowerCase()) {
    case '.svg': return 'image/svg+xml'
    case '.png': return 'image/png'
    case '.gif': return 'image/gif'
    case '.webp': return 'image/webp'
    default: return 'image/jpeg'
  }
}

function labelToName(label) {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'field'
}

function transformForms($, variantId) {
  if ($('form').length === 0) {
    const looseInputs = $('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"])').filter((_, el) => $(el).closest('form').length === 0)
    if (looseInputs.length > 0) {
      let container = looseInputs.first().parent()
      looseInputs.each((_, el) => {
        while (container.length && !container.find(el).length && container[0].tagName !== 'body') {
          container = container.parent()
        }
      })
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

function inlineImages(html, images) {
  for (const [filename, dataUri] of images) {
    const escaped = filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    html = html.replace(
      new RegExp(`(src=["'])${escaped}(["'])`, 'g'),
      `$1${dataUri}$2`
    )
  }
  return html
}

function pageMetadata(name) {
  return { name, champion_variant_id: 'a' }
}

function variantMetadata(name, hasForm, variantId, weight) {
  return {
    name,
    title: '',
    description: '',
    keywords: '',
    variant_id: variantId,
    variant_weight: weight,
    type: 'PageVariant',
    last_element_id: 4,
    has_form: hasForm,
    version: '4.2',
    template_id: 0,
  }
}

function variantSettings(width, hasForm, mainPageRef) {
  const base = {
    defaultWidth: width,
    showPageTransformBox: true,
    showSectionBoundaries: true,
    showPageSectionProtrusionWarnings: false,
    multipleBreakpointsEnabled: false,
    multipleBreakpointsVisibility: true,
    tabletBreakpointDisabled: true,
    contentType: 'pageVariant',
    activeGoals: hasForm ? [{ type: 'form', url: '/fs', sortOrder: 1 }] : [],
    fonts: [],
    noRobots: false,
    builderVersion: 'v6.24.285',
    globalImageQuality: { value: 60, compressPng: true },
    refId: 1,
    hasLightbox: false,
    webFontsInUse: {},
    webFontsExternalInUse: {},
  }
  if (mainPageRef) base.mainPage = mainPageRef
  return base
}

function mainElements(bodyHtml, cssHtml) {
  return [
    {
      id: 'lp-pom-root',
      type: 'lp-pom-root',
      name: 'Page Root',
      containerId: null,
      style: {
        background: { backgroundColor: 'ffffff' },
        defaults: { linkDecoration: 'none', color: '000', linkColor: '0000ff' },
        newBackground: {
          type: 'solidColor',
          solidColor: { bgColor: 'ffffff' },
          gradient: { baseColor: 'ffffff' },
        },
      },
      geometry: {
        position: 'relative',
        margin: 'auto',
        contentWidth: 1440,
        visible: true,
        scale: 1,
        padding: { top: 0 },
      },
      breakpoints: {
        mobile: { geometry: { visible: true, contentWidth: 320 } },
      },
    },
    {
      id: 'lp-pom-block-1',
      type: 'lp-pom-block',
      name: 'Content',
      containerId: 'lp-pom-root',
      style: {
        background: { fillType: 'solid', backgroundColor: 'ffffff', opacity: 100 },
        newBackground: { type: 'solidColor', solidColor: { bgColor: 'ffffff' } },
      },
      geometry: {
        position: 'relative',
        margin: { left: 'auto', right: 'auto', bottom: 0 },
        offset: { left: 0, top: 0 },
        borderLocation: 'outside',
        borderApply: { top: true, right: true, bottom: true, left: true },
        backgroundImageApply: false,
        savedBorderState: { left: true, right: true },
        fitWidthToPage: true,
        size: { width: 1440, height: 10000 },
        visible: true,
        scale: 1,
      },
      breakpoints: {
        mobile: {
          geometry: {
            visible: true,
            size: { width: 320, height: 10000 },
            fitWidthToPage: true,
          },
        },
      },
    },
    {
      id: 'lp-code-1',
      type: 'lp-code',
      name: 'CNVRT Page',
      containerId: 'lp-pom-block-1',
      geometry: {
        position: 'absolute',
        offset: { left: 0, top: 0 },
        size: { width: 1440, height: 10000 },
        visible: true,
        scale: 1,
        zIndex: 1,
      },
      style: { background: { backgroundColor: 'ffffff', opacity: 0 } },
      content: { type: null, html: bodyHtml, valid: true },
      breakpoints: {
        mobile: {
          geometry: { visible: true, size: { width: 320, height: 10000 } },
          style: { background: { imageFixed: false } },
        },
      },
    },
    {
      id: 'lp-stylesheet-1',
      type: 'lp-stylesheet',
      name: 'CNVRT Styles',
      containerId: null,
      placement: 'body:after',
      content: { type: null, html: cssHtml, valid: true },
      breakpoints: {},
    },
  ]
}

function confirmationElements() {
  return [
    {
      id: 'lp-pom-root',
      type: 'lp-pom-root',
      name: 'Page Root',
      containerId: null,
      style: {
        background: { backgroundColor: 'ffffff' },
        defaults: { linkDecoration: 'none', color: '000', linkColor: '0000ff' },
        newBackground: { type: 'solidColor', solidColor: { bgColor: 'ffffff' }, gradient: { baseColor: 'ffffff' } },
      },
      geometry: { position: 'relative', margin: 'auto', contentWidth: 760, visible: true, scale: 1, padding: { top: 0 } },
      breakpoints: { mobile: { geometry: { visible: true, contentWidth: 320 } } },
    },
    {
      id: 'lp-pom-block-1',
      type: 'lp-pom-block',
      name: 'Confirmation',
      containerId: 'lp-pom-root',
      style: { background: { fillType: 'solid', backgroundColor: 'ffffff', opacity: 100 } },
      geometry: {
        position: 'relative',
        margin: { left: 'auto', right: 'auto', bottom: 0 },
        offset: { left: 0, top: 0 },
        fitWidthToPage: true,
        size: { width: 760, height: 240 },
        visible: true,
        scale: 1,
      },
      breakpoints: { mobile: { geometry: { visible: true, size: { width: 320, height: 240 }, fitWidthToPage: true } } },
    },
    {
      id: 'lp-code-1',
      type: 'lp-code',
      name: 'Confirmation Content',
      containerId: 'lp-pom-block-1',
      geometry: { position: 'absolute', offset: { left: 0, top: 0 }, size: { width: 512, height: 240 }, visible: true, scale: 1, zIndex: 1 },
      style: { background: { backgroundColor: 'ffffff', opacity: 0 } },
      content: {
        type: null,
        html: `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:240px;padding:0 32px;box-sizing:border-box;font-family:system-ui,-apple-system,sans-serif;text-align:center;background:#fff;"><div style="width:40px;height:40px;border-radius:50%;background:#22c55e;display:flex;align-items:center;justify-content:center;margin-bottom:12px;"><svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M4 10l4.5 4.5L16 6" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div><p style="margin:0 0 6px;font-size:18px;font-weight:600;color:#111;">You're all set!</p><p style="margin:0;font-size:13px;color:#666;line-height:1.4;">Thanks for reaching out. We'll be in touch shortly.</p></div>`,
        valid: true,
      },
      breakpoints: { mobile: { geometry: { visible: true, size: { width: 240, height: 240 } } } },
    },
  ]
}

function extractCss($) {
  const cssChunks = []
  $('head style').each((_, el) => {
    const css = $(el).text().replace(/\bbody\b(?!\.lp-pom-body)/g, 'body.lp-pom-body:not(.lp-convertable-page)')
    cssChunks.push(css)
  })
  cssChunks.push(`
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
}
`)
  return `<style>\n${cssChunks.join('\n')}\n</style>`
}

async function writeJson(filePath, data) {
  await fs.promises.writeFile(filePath, JSON.stringify(data))
}

async function writeVariantFiles(dir, elements, width, hasForm, name, variantId, weight, mainPageRef) {
  await fs.promises.mkdir(dir, { recursive: true })
  await writeJson(path.join(dir, 'metadata.json'), variantMetadata(name, hasForm, variantId, weight))
  await writeJson(path.join(dir, 'settings.json'), variantSettings(width, hasForm, mainPageRef))
  await writeJson(path.join(dir, 'elements.json'), elements)
  await fs.promises.writeFile(path.join(dir, 'styles.json'), '')
  await writeJson(path.join(dir, 'javascripts.json'), { uuids: [] })
  await writeJson(path.join(dir, 'attachments.json'), {})
  await writeJson(path.join(dir, 'keywords.json'), {})
}

export async function packageToUnbounce(htmlFiles, imageFiles = [], pageName = 'CNVRT Page') {
  if (!htmlFiles || htmlFiles.length === 0) throw new Error('At least one HTML file is required')

  // Build image map: filename → data URI
  const imageMap = new Map()
  for (const { name, data } of imageFiles) {
    const ext = path.extname(name)
    const mime = mimeForExt(ext)
    const b64 = data.toString('base64')
    imageMap.set(name, `data:${mime};base64,${b64}`)
    if (ext) imageMap.set(path.basename(name, ext), `data:${mime};base64,${b64}`)
  }

  const tmpId = crypto.randomUUID()
  const workDir = path.join(os.tmpdir(), `ubexport-${tmpId}`)
  const tarPath = path.join(os.tmpdir(), `ubexport-${tmpId}.unbounce`)

  const archiveId = newId()
  const pageId = newId()
  const pageRootDir = path.join(workDir, archiveId, 'pages', pageId)
  const sourceUuid = crypto.randomUUID()

  try {
    await fs.promises.mkdir(path.join(workDir, archiveId, 'assets'), { recursive: true })
    await fs.promises.mkdir(pageRootDir, { recursive: true })

    await writeJson(path.join(pageRootDir, 'metadata.json'), pageMetadata(pageName))
    await writeJson(path.join(pageRootDir, 'source.json'), { source_uuid: sourceUuid })

    for (let i = 0; i < Math.min(htmlFiles.length, 26); i++) {
      const variantId = VARIANT_LETTERS[i]
      const weight = i === 0 ? 100 : 0

      const subPageId = newId()
      const variantDir = path.join(pageRootDir, 'page_variants', variantId)
      const subPageRootDir = path.join(variantDir, 'sub_pages', subPageId)
      const subVariantDir = path.join(subPageRootDir, 'page_variants', variantId)

      let variantHtml = htmlFiles[i].html
      if (imageMap.size > 0) variantHtml = inlineImages(variantHtml, imageMap)

      const $ = cheerio.load(variantHtml)
      const hasForm = transformForms($, variantId)
      const combinedCss = extractCss($)
      const bodyHtml = $('body').html() ?? variantHtml

      await fs.promises.mkdir(subVariantDir, { recursive: true })

      const variantName = htmlFiles.length === 1 ? 'Variant A' : `Variant ${variantId.toUpperCase()}`
      await writeVariantFiles(variantDir, mainElements(bodyHtml, combinedCss), 1440, hasForm, variantName, variantId, weight)

      await writeJson(path.join(subPageRootDir, 'metadata.json'), {
        name: 'Form Confirmation Page',
        used_as: 'form_confirmation',
        path_name: `${variantId}-form_confirmation.html`,
        champion_variant_id: variantId,
      })
      await writeVariantFiles(
        subVariantDir,
        confirmationElements(),
        512,
        false,
        'Confirmation',
        variantId,
        100,
        { uuid: sourceUuid, variant_id: variantId }
      )
    }

    await tar.create({ file: tarPath, cwd: workDir }, [archiveId])
    return await fs.promises.readFile(tarPath)
  } finally {
    await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {})
    await fs.promises.rm(tarPath, { force: true }).catch(() => {})
  }
}
