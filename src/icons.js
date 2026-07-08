// id=434 §九: one shared set of inline-SVG line icons, replacing the emoji
// that rendered inconsistently across operating systems (👤🔗📎🗑️). Built
// via the SVG DOM API (createElementNS), never innerHTML/HTML strings.
// Every call site keeps a visible text label or a tooltip/aria-label next to
// the icon — icons are a visual aid here, never the sole way to identify an
// action (spec's explicit a11y requirement).
const SVG_NS = 'http://www.w3.org/2000/svg'

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
  return node
}

function icon(paths, { viewBox = '0 0 24 24' } = {}) {
  const svg = svgEl('svg', {
    viewBox,
    width: '16',
    height: '16',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    class: 'icon',
    'aria-hidden': 'true',
    focusable: 'false',
  })
  for (const p of paths) {
    if (p.circle) svg.appendChild(svgEl('circle', p.circle))
    else svg.appendChild(svgEl('path', { d: p.d }))
  }
  return svg
}

export function iconUser() {
  return icon([{ circle: { cx: '12', cy: '8', r: '4' } }, { d: 'M4 20c0-4.5 3.6-7 8-7s8 2.5 8 7' }])
}

export function iconLink() {
  return icon([
    { d: 'M10 14a4 4 0 006 0l3-3a4 4 0 00-6-6l-1 1' },
    { d: 'M14 10a4 4 0 00-6 0l-3 3a4 4 0 006 6l1-1' },
  ])
}

export function iconPaperclip() {
  return icon([{ d: 'M17.5 8.5l-7 7a3 3 0 004.2 4.2l7-7a5 5 0 00-7-7l-7 7a7 7 0 0010 10' }])
}

export function iconTrash() {
  return icon([{ d: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6' }])
}

export function iconChevron() {
  return icon([{ d: 'M6 9l6 6 6-6' }])
}
