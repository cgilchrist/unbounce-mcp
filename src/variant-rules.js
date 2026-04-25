/**
 * Brand consistency rules enforced when creating a new variant from an existing one.
 * Imported by both index.js (server instructions) and the get_variant tool handler.
 */

export const VARIANT_CREATION_RULES = `\
If you are about to create a new variant based on this one, the following rules are ALWAYS enforced:

LOGO: If the original variant has a logo, the new variant MUST use the exact same logo image at the same size. Never substitute text, a placeholder, or a different logo.

IMAGERY: If the original variant has real photos or images (headshots, product shots, backgrounds, etc.), reuse those same images in the new variant unless the explicit purpose of the test is to try different imagery. Never replace real photos with placeholder avatars, initials, icons, or generated alternatives.

FONTS: Identify the brand fonts using two signals in this HTML: (1) any script tag containing window.ub.page.webFonts — e.g. window.ub.page.webFonts = ['Jost:700,regular,600,300italic'] — this is Unbounce's mechanism for loading Google Fonts, and the font names listed there are the brand fonts; (2) font-family declarations throughout inline styles, <style> blocks, or linked stylesheets. Whatever font-family names appear — e.g. "Jost", "Montserrat", "Playfair Display" — you MUST use those same fonts in the new variant for the same text roles (headings, body, CTAs, labels). If the original has visible @import or <link> tags for those fonts, copy them verbatim. If the font is declared via window.ub.page.webFonts or has no visible load tag, add a standard Google Fonts <link> tag for the same font and weights yourself. Do not substitute system fonts or invent different typefaces.

VIDEO BACKGROUNDS: If the original has a section with a video background, treat the video as a reusable brand asset just like a logo or photo. Two signals to look for: (1) an iframe matching the pattern <iframe ... id="lp-pom-block-{N}-video-background-iframe" src="//www.youtube.com/embed/{videoId}?..."> or the equivalent for Vimeo; (2) the wrapping <div class="lp-pom-video-background"> with data-ratio. Reuse the SAME video provider (YouTube/Vimeo) and the SAME video ID — never substitute a different video, a stock loop, or a static image. Preserve the original embed parameters that control playback behavior (mute=1, autoplay=0/1, loop=0/1, controls=0, modestbranding=1, rel=0, iv_load_policy=3, disablekb=1, fs=0) — these encode design intent and changing them changes how the page feels. Also extract the color overlay: look for <div id="lp-pom-block-{N}-color-overlay"> and the corresponding rule in the page CSS — copy its background-color (rgba including alpha, or hex + opacity) verbatim into the replica's overlay. If the original has no color overlay, do not add one.`
