/** Trusted, script-free outer document constraining the untrusted card's own navigation. */
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

export function cardSource (href) {
  const url = new URL(href)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new TypeError('Invalid card URL')
  // A filename must never inject CSP separators or quoted keywords.
  const pathname = url.pathname.replace(/[;'"\s]/gu, (c) => encodeURIComponent(c).replace(/'/g, '%27'))
  return url.origin + pathname
}

export function cardFramePolicy (rawHref) {
  return [
    "default-src 'none'", "script-src 'none'", "style-src 'unsafe-inline'",
    'frame-src ' + cardSource(rawHref), "connect-src 'none'", "form-action 'none'",
    "base-uri 'none'", "object-src 'none'", 'sandbox allow-scripts',
  ].join('; ')
}

export function cardFrameDocument (rawHref) {
  cardSource(rawHref) // reject a malformed URL before producing HTML
  return '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{position:fixed;inset:0;width:100%;height:100%;border:0}</style></head><body><iframe title="贺卡" sandbox="allow-scripts" referrerpolicy="no-referrer" src="' + esc(rawHref) + '"></iframe></body></html>'
}
