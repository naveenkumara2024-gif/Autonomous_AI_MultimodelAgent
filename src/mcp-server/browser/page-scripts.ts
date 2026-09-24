// In-page JavaScript expressions evaluated through CDP Runtime.evaluate. Every caller-supplied
// value is embedded via JSON.stringify, never string-concatenated, so a selector or text can't
// break out of the expression.

const lit = (value: unknown) => JSON.stringify(value);

export function findScript(selector: string, all: boolean): string {
  return `(() => {
    const nodes = Array.from(document.querySelectorAll(${lit(selector)}));
    const describe = (el) => {
      const rect = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(),
        text: (el.innerText || el.textContent || "").trim().slice(0, 200),
        id: el.id || null,
        class_name: typeof el.className === "string" ? el.className : null,
        attributes: Object.fromEntries(Array.from(el.attributes || []).map((a) => [a.name, a.value])),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        visible: rect.width > 0 && rect.height > 0,
      };
    };
    if (nodes.length === 0) return { found: false, count: 0 };
    if (!${lit(all)}) return { found: true, count: nodes.length, element: describe(nodes[0]) };
    return { found: true, count: nodes.length, elements: nodes.slice(0, 50).map(describe) };
  })()`;
}

export function clickScript(selector: string, index: number): string {
  return `(() => {
    const nodes = document.querySelectorAll(${lit(selector)});
    const el = nodes[${lit(index)}];
    if (!el) return { found: false, count: nodes.length };
    el.scrollIntoView({ block: "center", inline: "center" });
    el.click();
    return { found: true, count: nodes.length, tag: el.tagName.toLowerCase(), text: (el.innerText || "").trim().slice(0, 200) };
  })()`;
}

// Inputs go through the native value setter so React/Vue-controlled inputs see the change.
export function typeScript(selector: string, text: string, pressEnter: boolean, index: number): string {
  return `(() => {
    const nodes = document.querySelectorAll(${lit(selector)});
    const el = nodes[${lit(index)}];
    if (!el) return { found: false, count: nodes.length };
    el.scrollIntoView({ block: "center", inline: "center" });
    el.focus();
    const tag = el.tagName.toLowerCase();
    if (el.isContentEditable) {
      document.execCommand("selectAll", false, null);
      document.execCommand("insertText", false, ${lit(text)});
    } else if (tag === "input" || tag === "textarea") {
      const proto = tag === "input" ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(el, ${lit(text)});
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      return { found: true, typed: false, reason: "Element is not an input/textarea/contenteditable." };
    }
    let submitted = false;
    if (${lit(pressEnter)}) {
      if (el.form && typeof el.form.requestSubmit === "function") {
        el.form.requestSubmit();
        submitted = true;
      } else {
        const opts = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true };
        el.dispatchEvent(new KeyboardEvent("keydown", opts));
        el.dispatchEvent(new KeyboardEvent("keyup", opts));
      }
    }
    return { found: true, typed: true, submitted };
  })()`;
}

export function getTextScript(selector: string | undefined, maxLength: number): string {
  return `(() => {
    const el = ${selector ? `document.querySelector(${lit(selector)})` : "document.body"};
    if (!el) return { found: false };
    const text = el.innerText !== undefined ? el.innerText : (el.textContent || "");
    const maxLength = ${lit(maxLength)};
    const truncated = text.length > maxLength;
    return { found: true, text: truncated ? text.slice(0, maxLength) : text, truncated, total_length: text.length };
  })()`;
}

export function elementRectScript(selector: string): string {
  return `(() => {
    const el = document.querySelector(${lit(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  })()`;
}

export function existsScript(selector: string): string {
  return `document.querySelector(${lit(selector)}) !== null`;
}

// --- Highlight-and-extract ---
//
// Marks an element on the page (colored outline + tinted background, plus an optional label
// badge) so extracted text is visibly traceable to where it came from — a screenshot taken
// right after proves the source. Only ever touches elements carrying our own marker attribute,
// so clearing can't disturb anything else on the page. Attribute names are kept from the
// reference server so highlights left by either can be cleared by either.

const HIGHLIGHT_ATTR = "data-mcpgui-highlight";
const HIGHLIGHT_ORIG_ATTR = "data-mcpgui-highlight-orig";
const HIGHLIGHT_BADGE_CLASS = "mcpgui-highlight-badge";

// A function DECLARATION (not invoked), shared by extract (to optionally clear previous
// highlights first) and clear.
const CLEAR_HIGHLIGHTS_FN_SRC = `
function __mcpguiClearHighlights() {
  let count = 0;
  document.querySelectorAll('[${HIGHLIGHT_ATTR}]').forEach((el) => {
    const orig = el.getAttribute('${HIGHLIGHT_ORIG_ATTR}');
    if (orig) el.setAttribute('style', orig); else el.removeAttribute('style');
    el.removeAttribute('${HIGHLIGHT_ATTR}');
    el.removeAttribute('${HIGHLIGHT_ORIG_ATTR}');
    count++;
  });
  document.querySelectorAll('.${HIGHLIGHT_BADGE_CLASS}').forEach((b) => b.remove());
  return count;
}
`;

export const clearHighlightsScript = `(() => {${CLEAR_HIGHLIGHTS_FN_SRC}\nreturn __mcpguiClearHighlights();})()`;

export function extractHighlightedScript(params: {
  selector?: string;
  query?: string;
  index: number;
  label?: string;
  color: string;
  clearPrevious: boolean;
  maxLength: number;
}): string {
  return `(() => {
    ${CLEAR_HIGHLIGHTS_FN_SRC}
    if (${lit(params.clearPrevious)}) __mcpguiClearHighlights();

    function hexToRgba(hex, alpha) {
      const h = hex.replace('#', '');
      const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
      const n = parseInt(full, 16);
      return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')';
    }

    const selector = ${lit(params.selector ?? null)};
    const query = ${lit(params.query ?? null)};
    const index = ${lit(params.index)};

    let target = null;
    if (selector) {
      target = document.querySelectorAll(selector)[index] || null;
    } else if (query) {
      const needle = query.toLowerCase();
      const blockSelector = 'p, li, td, th, blockquote, h1, h2, h3, h4, h5, h6, article, section, dd, dt, figcaption';
      let best = null;
      let bestLen = Infinity;
      for (const el of document.body.querySelectorAll('*')) {
        if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.tagName === 'NOSCRIPT' || el.classList.contains('${HIGHLIGHT_BADGE_CLASS}')) continue;
        const t = el.innerText || el.textContent || '';
        if (t.length < bestLen && t.toLowerCase().includes(needle)) {
          best = el;
          bestLen = t.length;
        }
      }
      if (best) {
        let el = best;
        while (el && el.parentElement && el.parentElement !== document.body && !el.matches(blockSelector)) {
          el = el.parentElement;
        }
        target = el;
      }
    }

    if (!target) return { found: false };

    target.scrollIntoView({ block: 'center', inline: 'nearest' });
    if (!target.hasAttribute('${HIGHLIGHT_ATTR}')) {
      target.setAttribute('${HIGHLIGHT_ORIG_ATTR}', target.getAttribute('style') || '');
    }
    target.setAttribute('${HIGHLIGHT_ATTR}', '1');

    const color = ${lit(params.color)};
    target.style.outline = '3px solid ' + color;
    target.style.outlineOffset = '2px';
    target.style.backgroundColor = hexToRgba(color, 0.35);
    target.style.borderRadius = '3px';
    target.style.scrollMarginTop = '80px';

    const rect = target.getBoundingClientRect();
    const label = ${lit(params.label ?? null)};
    if (label) {
      const badge = document.createElement('div');
      badge.className = '${HIGHLIGHT_BADGE_CLASS}';
      badge.textContent = label;
      Object.assign(badge.style, {
        position: 'fixed',
        left: Math.max(0, rect.left) + 'px',
        top: Math.max(0, rect.top - 22) + 'px',
        background: color,
        color: '#111',
        font: 'bold 12px sans-serif',
        padding: '1px 6px',
        borderRadius: '3px',
        zIndex: '2147483647',
        pointerEvents: 'none',
      });
      document.body.appendChild(badge);
    }

    const text = target.innerText !== undefined ? target.innerText : (target.textContent || '');
    const maxLength = ${lit(params.maxLength)};
    const truncated = text.length > maxLength;
    return {
      found: true,
      matched_via: selector ? 'selector' : 'query',
      tag: target.tagName.toLowerCase(),
      text: truncated ? text.slice(0, maxLength) : text,
      truncated,
      total_length: text.length,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
  })()`;
}

// --- Screenshot redaction (browser) ---
//
// Before browser_screenshot captures, password inputs are painted solid black by a temporary
// stylesheet, then the stylesheet is removed. Styling rather than pixel-editing means no PNG
// decode is needed, and the mask moves with the element even on full-page captures.

const MASK_STYLE_ID = "__mcp_desktop_redaction";

export const maskPasswordsScript = `(() => {
  const fields = document.querySelectorAll('input[type="password"], input[autocomplete*="password" i]');
  if (!document.getElementById('${MASK_STYLE_ID}')) {
    const style = document.createElement('style');
    style.id = '${MASK_STYLE_ID}';
    style.textContent = 'input[type="password"], input[autocomplete*="password" i] { background: #000 !important; color: #000 !important; -webkit-text-fill-color: #000 !important; caret-color: #000 !important; }';
    document.documentElement.appendChild(style);
  }
  return fields.length;
})()`;

export const unmaskPasswordsScript = `(() => { document.getElementById('${MASK_STYLE_ID}')?.remove(); return true; })()`;
