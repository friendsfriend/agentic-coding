// The accessibility snapshot (`add-agent-browser-sessions`, design decision 3).
//
// Playwright's AI snapshot with `[ref=eN]` markers is what the browser tools
// need: a bounded tree of what a user can perceive and act on, with handles the
// action tools accept. The spike (task 1.1) found the concise, actionable part
// of that surface in the *accessible* subtree, while the ref-marked variant is
// served by a private (`_snapshotForAI`) API the pool must not depend on.
//
// So the fallback the design names is the implementation: walk the DOM
// server-side, inject `data-ac-ref="eN"` on every actionable/visible element,
// and return a YAML-shaped tree naming those refs. The refs are then actionable
// for free — `[ref=e7]` resolves to `[data-ac-ref="e7"]`, no second lookup
// table and no dependence on element identity across a re-render.
//
// The walk is deliberately bounded: a fixed depth, a fixed node budget and a
// length cap, because the tree is returned to a model and a large page must not
// turn into an unbounded tool result.

/** The maximum depth the tree walks below `body`. */
export const SNAPSHOT_MAX_DEPTH = 14;
/** The maximum number of nodes the tree records. */
export const SNAPSHOT_MAX_NODES = 1200;
/** The maximum characters the snapshot text may carry. */
export const SNAPSHOT_MAX_CHARS = 40_000;
/** The attribute the walk injects and the action tools resolve. */
export const SNAPSHOT_REF_ATTRIBUTE = "data-ac-ref";

/** Every ref the text names, in order. The session uses this to accept only
 * refs a snapshot actually produced. */
export function snapshotRefs(text: string): string[] {
	// A Set, not `includes`, so the walk is linear in the refs found: the
	// snapshot is taken before every action, and the tree may hold up to
	// `SNAPSHOT_MAX_NODES` refs.
	const refs = new Set<string>();
	for (const match of text.matchAll(/\[ref=(e\d+)\]/g)) {
		const ref = match[1];
		if (ref !== undefined) refs.add(ref);
	}
	return [...refs];
}

/** The CSS selector one ref resolves to. */
export function refSelector(ref: string): string {
	return `[${SNAPSHOT_REF_ATTRIBUTE}="${ref}"]`;
}

/** Whether one string is a well-formed ref (`e` and digits). */
export function isRef(value: string): boolean {
	return /^e\d+$/.test(value);
}

/**
 * The page-side walk, as an expression for `page.evaluate`.
 *
 * It is a string on purpose: a fake driver can answer the same call, and no
 * bundler ever has to serialize a closure. It returns the tree text, and it
 * assigns `data-ac-ref` while walking, so the refs in the returned text are
 * immediately actionable through the same DOM.
 */
export const SNAPSHOT_SCRIPT = `(() => {
  const MAX_DEPTH = ${SNAPSHOT_MAX_DEPTH};
  const MAX_NODES = ${SNAPSHOT_MAX_NODES};
  const MAX_CHARS = ${SNAPSHOT_MAX_CHARS};
  const ATTR = ${JSON.stringify(SNAPSHOT_REF_ATTRIBUTE)};
  document.querySelectorAll("[" + ATTR + "]").forEach((el) => el.removeAttribute(ATTR));
  let seq = 0;
  let nodes = 0;
  let out = "";
  const lines = [];
  const indent = (depth) => "  ".repeat(depth);
  const push = (line) => {
    if (out.length + line.length + 1 > MAX_CHARS) return false;
    out += line + "\\n";
    lines.push(line);
    return true;
  };
  const roleOf = (el) => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    const map = {
      a: "link", button: "button", input: "input", select: "combobox",
      textarea: "textbox", img: "img", h1: "heading", h2: "heading",
      h3: "heading", h4: "heading", h5: "heading", h6: "heading",
      ul: "list", ol: "list", li: "listitem", table: "table",
      tr: "row", td: "cell", th: "columnheader", nav: "navigation",
      main: "main", header: "banner", footer: "contentinfo",
      form: "form", label: "label", p: "paragraph", pre: "code",
      svg: "img", video: "video", audio: "audio", iframe: "iframe",
    };
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "submit" || type === "button") return "button";
      return "textbox";
    }
    return map[tag] || "generic";
  };
  const nameOf = (el) => {
    const aria = el.getAttribute("aria-label");
    if (aria) return aria;
    const labelled = el.getAttribute("aria-labelledby");
    if (labelled) {
      const target = document.getElementById(labelled);
      if (target && target.textContent) return target.textContent;
    }
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") {
      const placeholder = el.getAttribute("placeholder");
      if (placeholder) return placeholder;
      const id = el.getAttribute("id");
      if (id) {
        const label = document.querySelector('label[for="' + id + '"]');
        if (label && label.textContent) return label.textContent;
      }
      return el.getAttribute("name") || "";
    }
    if (el.tagName === "IMG") return el.getAttribute("alt") || "";
    return "";
  };
  const ownTextOf = (el) => {
    if (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA") {
      const value = el.value;
      return typeof value === "string" && value ? value : "";
    }
    let text = "";
    for (const child of el.childNodes) {
      if (child.nodeType === 3) text += child.nodeValue || "";
    }
    return text.replace(/\\s+/g, " ").trim();
  };
  const isHidden = (el) => {
    if (el.hasAttribute("hidden")) return true;
    const aria = el.getAttribute("aria-hidden");
    if (aria === "true") return true;
    const style = el.getAttribute("style") || "";
    if (/display\\s*:\\s*none/i.test(style) || /visibility\\s*:\\s*hidden/i.test(style)) return true;
    return false;
  };
  const isActionable = (el) => {
    const tag = el.tagName.toLowerCase();
    if (["a", "button", "input", "select", "textarea", "summary", "details"].includes(tag)) return true;
    if (el.hasAttribute("onclick") || el.hasAttribute("href")) return true;
    const role = (el.getAttribute("role") || "").toLowerCase();
    if (["button", "link", "checkbox", "radio", "tab", "menuitem", "option", "combobox", "textbox", "switch"].includes(role)) return true;
    const tabindex = el.getAttribute("tabindex");
    return tabindex !== null && tabindex !== "-1";
  };
  const walk = (el, depth) => {
    if (nodes >= MAX_NODES || depth > MAX_DEPTH) return;
    if (el.nodeType !== 1) return;
    if (isHidden(el)) return;
    const tag = el.tagName.toLowerCase();
    if (["script", "style", "noscript", "template", "head", "meta", "link"].includes(tag)) return;
    nodes += 1;
    const role = roleOf(el);
    const text = ownTextOf(el);
    const actionable = isActionable(el);
    let name = nameOf(el);
    // An actionable element with no explicit label is named by its own text, so a
    // model reads a named button instead of an anonymous ref.
    if (!name && actionable)
      name = (el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 120);
    let ref = "";
    if (actionable) {
      ref = "e" + seq++;
      el.setAttribute(ATTR, ref);
    }
    const parts = [role + (name ? ' "' + name.slice(0, 120) + '"' : "")];
    if (ref) parts.push("[ref=" + ref + "]");
    if (text && text !== name) parts.push("- " + text.slice(0, 200));
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") {
      const type = el.getAttribute("type");
      if (type) parts.push("type=" + type);
      if (el.checked !== undefined && (type === "checkbox" || type === "radio")) parts.push("checked=" + (el.checked ? "true" : "false"));
      if (el.disabled) parts.push("disabled");
    }
    if (!push(indent(depth) + parts.join(" "))) {
      nodes = MAX_NODES;
      return;
    }
    const children = el.children;
    for (let index = 0; index < children.length && nodes < MAX_NODES; index += 1)
      walk(children[index], depth + 1);
  };
  const root = document.body || document.documentElement;
  if (!root) return "(no document body)";
  push("- url: " + location.href);
  push("- title: " + (document.title || ""));
  walk(root, 0);
  return out;
})()`;
