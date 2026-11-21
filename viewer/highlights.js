// Marca-texto e apagador.
// As marcações ficam guardadas em coordenadas do PDF (pontos, origem embaixo à esquerda),
// então valem em qualquer zoom e podem ser gravadas no PDF baixado e na impressão.
// São salvas por documento (impressão digital do PDF) no armazenamento local da extensão.

import { t } from "../ui/i18n.js";

export const HL_COLORS = [
  { id: "yellow", label: t("colorYellow"), color: "#ffd43b" },
  { id: "green", label: t("colorGreen"), color: "#69db7c" },
  { id: "pink", label: t("colorPink"), color: "#f783ac" },
  { id: "blue", label: t("colorBlue"), color: "#4dabf7" },
];

export class Highlights {
  /** @param {{ pages: () => any[], onModeChange?: (mode: string|null) => void }} opts */
  constructor(opts) {
    this.opts = opts;
    this.items = [];      // { id, page, color, rects: [[x0,y0,x1,y1], …] }
    this.key = null;
    this.mode = null;     // "highlight" | "erase" | null
    this.color = HL_COLORS[0].color;
    try { this.color = localStorage.getItem("pdfdark-hl-color") || this.color; } catch {}

    document.addEventListener("pointerup", (e) => {
      if (this.mode === "highlight" && e.button === 0) setTimeout(() => this.captureSelection(), 0);
    });
  }

  async load(fingerprint) {
    this.key = fingerprint ? `hl:${fingerprint}` : null;
    this.items = [];
    if (!this.key) return;
    try {
      const data = await chrome.storage.local.get(this.key);
      this.items = Array.isArray(data[this.key]) ? data[this.key] : [];
    } catch {}
  }

  save() {
    if (!this.key) return;
    const value = this.items.length ? { [this.key]: this.items } : null;
    (value ? chrome.storage.local.set(value) : chrome.storage.local.remove(this.key)).catch(() => {});
  }

  reset() {
    this.items = [];
    this.key = null;
  }

  setColor(color) {
    this.color = color;
    try { localStorage.setItem("pdfdark-hl-color", color); } catch {}
  }

  setMode(mode) {
    this.mode = this.mode === mode ? null : mode;
    document.body.classList.toggle("mode-highlight", this.mode === "highlight");
    document.body.classList.toggle("mode-erase", this.mode === "erase");
    document.body.style.setProperty("--hl-color", this.color);
    this.opts.onModeChange?.(this.mode);
    if (this.mode === "highlight") this.captureSelection(); // texto já selecionado vira marcação
  }

  forPage(num) {
    return this.items.filter((h) => h.page === num);
  }

  // ----- criação a partir da seleção de texto -----
  captureSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const clientRects = textRects(range);
    if (!clientRects.length) return;

    let created = false;
    for (const p of this.opts.pages()) {
      if (!p.page) continue;
      const box = p.div.getBoundingClientRect();
      const inPage = clientRects.filter((r) =>
        r.right > box.left && r.left < box.right && r.bottom > box.top && r.top < box.bottom);
      if (!inPage.length) continue;
      const vp = p.page.getViewport({ scale: 1 });
      const sx = vp.width / box.width, sy = vp.height / box.height;
      const rects = mergeLines(inPage).map((r) => {
        const [x0, y0] = vp.convertToPdfPoint((r.left - box.left) * sx, (r.top - box.top) * sy);
        const [x1, y1] = vp.convertToPdfPoint((r.right - box.left) * sx, (r.bottom - box.top) * sy);
        return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)].map((v) => +v.toFixed(2));
      });
      this.items.push({ id: crypto.randomUUID(), page: p.num, color: this.color, rects });
      this.renderPage(p);
      created = true;
    }
    if (created) {
      sel.removeAllRanges();
      this.save();
    }
  }

  remove(id) {
    const h = this.items.find((x) => x.id === id);
    if (!h) return;
    this.items = this.items.filter((x) => x.id !== id);
    const p = this.opts.pages()[h.page - 1];
    if (p) this.renderPage(p);
    this.save();
  }

  // ----- desenho -----
  renderPage(p) {
    if (!p.page) return;
    let layer = p.div.querySelector(".hlLayer");
    const list = this.forPage(p.num);
    if (!list.length) { layer?.remove(); return; }
    if (!layer) {
      layer = document.createElement("div");
      layer.className = "hlLayer";
      const after = p.div.querySelector("canvas.images") || p.div.querySelector("canvas.base");
      if (after) after.after(layer); else p.div.prepend(layer);
    }
    layer.replaceChildren();
    const vp = p.page.getViewport({ scale: 1 });
    for (const h of list) {
      for (const [x0, y0, x1, y1] of h.rects) {
        const [a, b, c, d] = vp.convertToViewportRectangle([x0, y0, x1, y1]);
        const el = document.createElement("div");
        el.className = "hl";
        el.dataset.id = h.id;
        el.title = t("highlightMark");
        Object.assign(el.style, {
          left: `${(Math.min(a, c) / vp.width) * 100}%`,
          top: `${(Math.min(b, d) / vp.height) * 100}%`,
          width: `${(Math.abs(c - a) / vp.width) * 100}%`,
          height: `${(Math.abs(d - b) / vp.height) * 100}%`,
          background: h.color,
        });
        // apagador: clicar ou arrastar por cima
        el.addEventListener("pointerdown", (e) => {
          if (this.mode !== "erase") return;
          e.preventDefault();
          this.remove(h.id);
        });
        el.addEventListener("pointerenter", (e) => {
          if (this.mode === "erase" && e.buttons & 1) this.remove(h.id);
        });
        layer.append(el);
      }
    }
  }
}

// Retângulos só dos trechos de texto da seleção (sem as caixas dos elementos).
function textRects(range) {
  const root = range.commonAncestorContainer;
  const rects = [];
  const walker = document.createTreeWalker(
    root.nodeType === Node.TEXT_NODE ? root.parentNode : root,
    NodeFilter.SHOW_TEXT,
  );
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!range.intersectsNode(node) || !node.parentElement?.closest(".textLayer")) continue;
    const r = document.createRange();
    r.selectNodeContents(node);
    if (node === range.startContainer) r.setStart(node, range.startOffset);
    if (node === range.endContainer) r.setEnd(node, range.endOffset);
    for (const cr of r.getClientRects()) if (cr.width > 0.5 && cr.height > 0.5) rects.push(cr);
  }
  return rects;
}

// Junta pedaços da mesma linha que se tocam.
function mergeLines(rects) {
  const sorted = [...rects]
    .map((r) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom }))
    .sort((a, b) => a.top - b.top || a.left - b.left);
  const out = [];
  for (const r of sorted) {
    const last = out.at(-1);
    const h = r.bottom - r.top;
    if (last && Math.abs(last.top - r.top) < h * 0.5 && Math.abs(last.bottom - r.bottom) < h * 0.5
        && r.left <= last.right + h * 0.6) {
      last.left = Math.min(last.left, r.left);
      last.right = Math.max(last.right, r.right);
      last.top = Math.min(last.top, r.top);
      last.bottom = Math.max(last.bottom, r.bottom);
    } else {
      out.push({ ...r });
    }
  }
  return out;
}
