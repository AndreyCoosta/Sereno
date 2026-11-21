// Sumário (marcadores do PDF) no painel lateral.

import { t } from "../ui/i18n.js";

const CHEVRON = `<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>`;

/**
 * @param {import("../lib/pdf.min.mjs").PDFDocumentProxy} pdf
 * @param {HTMLElement} container
 * @param {{ goToDestination: (dest: any) => void }} nav
 * @returns {Promise<number>} quantidade de itens de primeiro nível
 */
export async function buildOutline(pdf, container, nav) {
  container.replaceChildren();
  const outline = await pdf.getOutline().catch(() => null);
  if (!outline?.length) {
    const empty = document.createElement("p");
    empty.className = "outline-empty";
    empty.textContent = t("noOutline");
    container.append(empty);
    return 0;
  }
  container.append(buildList(outline, nav, 0));
  return outline.length;
}

function buildList(items, nav, level) {
  const ul = document.createElement("ul");
  ul.className = "outline-list";
  if (level === 0) ul.setAttribute("role", "tree");
  else ul.setAttribute("role", "group");
  for (const item of items) {
    const li = document.createElement("li");
    li.setAttribute("role", "treeitem");
    const row = document.createElement("div");
    row.className = "outline-row";
    row.style.setProperty("--level", String(level));

    const hasChildren = item.items?.length > 0;
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "outline-toggle";
    toggle.tabIndex = -1;
    if (hasChildren) {
      toggle.innerHTML = CHEVRON;
      toggle.setAttribute("aria-label", t("expand"));
    } else {
      toggle.disabled = true;
      toggle.setAttribute("aria-hidden", "true");
    }

    const link = document.createElement(item.url ? "a" : "button");
    link.className = "outline-link";
    link.textContent = (item.title || "").trim() || t("untitled");
    link.title = link.textContent;
    if (item.bold) link.style.fontWeight = "600";
    if (item.italic) link.style.fontStyle = "italic";
    if (item.url) {
      link.href = item.url;
      link.target = "_top";
      link.rel = "noreferrer";
    } else {
      link.type = "button";
      link.addEventListener("click", () => {
        if (item.dest) nav.goToDestination(item.dest);
        if (window.matchMedia("(max-width: 760px)").matches) nav.close?.();
      });
    }
    row.append(toggle, link);
    li.append(row);

    if (hasChildren) {
      const children = buildList(item.items, nav, level + 1);
      // abre o primeiro nível se o PDF pedir (count > 0); senão começa recolhido
      const open = level === 0 && item.count > 0;
      children.hidden = !open;
      li.setAttribute("aria-expanded", String(open));
      toggle.addEventListener("click", () => {
        children.hidden = !children.hidden;
        li.setAttribute("aria-expanded", String(!children.hidden));
      });
      li.append(children);
    }
    ul.append(li);
  }
  return ul;
}
