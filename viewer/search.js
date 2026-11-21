// Pesquisa no documento inteiro (não só nas páginas já carregadas).
// Ignora maiúsculas/minúsculas e acentos ("acao" encontra "Ação").

export class Search {
  /**
   * @param {{
   *   pdf: () => any, pages: () => any[],
   *   goToPage: (n: number) => void, viewer: HTMLElement,
   *   onUpdate: (info: { current: number, total: number, busy: boolean }) => void
   * }} ctx
   */
  constructor(ctx) {
    this.ctx = ctx;
    this.texts = new Map();   // página → { norm, map, itemStart, items }
    this.query = "";
    this.matches = [];        // { page, index (n-ésimo resultado da página) }
    this.current = -1;
    this.runId = 0;
  }

  reset() {
    this.texts.clear();
    this.query = "";
    this.matches = [];
    this.current = -1;
    this.runId++;
    this.clearAll();
  }

  async pageText(num) {
    if (this.texts.has(num)) return this.texts.get(num);
    const page = await this.ctx.pdf().getPage(num);
    const tc = await page.getTextContent();
    // Mesma ordem dos elementos da camada de texto: só itens com "str"
    const items = tc.items.filter((it) => it.str !== undefined);
    let raw = "";
    const itemStart = [];
    for (const it of items) {
      itemStart.push(raw.length);
      raw += it.str;
      if (it.hasEOL) raw += " ";
    }
    const { norm, map } = normalize(raw);
    const entry = { norm, map, itemStart, items };
    this.texts.set(num, entry);
    return entry;
  }

  async find(query) {
    const run = ++this.runId;
    this.rawQuery = query;
    this.query = normalize(query.trim()).norm;
    this.matches = [];
    this.current = -1;
    this.clearAll();
    if (!this.query) return this.update(false);
    this.update(true);

    const n = this.ctx.pages().length;
    const startPage = this.ctx.currentPage?.() ?? 1;
    for (let num = 1; num <= n; num++) {
      const t = await this.pageText(num);
      if (run !== this.runId) return;
      let k = 0;
      for (let i = t.norm.indexOf(this.query); i >= 0; i = t.norm.indexOf(this.query, i + this.query.length)) {
        this.matches.push({ page: num, index: k++, start: i });
      }
      if (num % 20 === 0) this.update(true);
    }
    if (run !== this.runId) return;
    // começa pelo primeiro resultado a partir da página atual
    const first = this.matches.findIndex((m) => m.page >= startPage);
    this.current = this.matches.length ? (first >= 0 ? first : 0) : -1;
    for (const p of this.ctx.pages()) if (p.textLayer) this.renderPage(p);
    this.update(false);
    if (this.current >= 0) await this.show(this.current);
  }

  async step(dir) {
    if (!this.matches.length) return;
    this.current = (this.current + dir + this.matches.length) % this.matches.length;
    this.update(false);
    await this.show(this.current);
  }

  async show(i) {
    const m = this.matches[i];
    if (!m) return;
    const p = this.ctx.pages()[m.page - 1];
    const box = p.div.getBoundingClientRect();
    const vbox = this.ctx.viewer.getBoundingClientRect();
    if (box.bottom < vbox.top || box.top > vbox.bottom) this.ctx.goToPage(m.page);
    await p.textReady;
    if (this.matches[i] !== m) return;
    this.renderPage(p);
    const el = p.div.querySelector(".searchHit.current");
    el?.scrollIntoView({ block: "center", inline: "nearest" });
  }

  update(busy) {
    this.ctx.onUpdate({ current: this.current + 1, total: this.matches.length, busy });
  }

  clearAll() {
    for (const p of this.ctx.pages()) p.div.querySelector(".searchLayer")?.remove();
  }

  // Desenha os resultados de uma página (precisa da camada de texto pronta).
  renderPage(p) {
    p.div.querySelector(".searchLayer")?.remove();
    if (!this.query || !p.textLayer) return;
    const pageMatches = this.matches.filter((m) => m.page === p.num);
    if (!pageMatches.length) return;
    const t = this.texts.get(p.num);
    if (!t) return;
    const divs = p.textLayer.textDivs;
    const box = p.div.getBoundingClientRect();
    if (!box.width || !box.height) return;

    const layer = document.createElement("div");
    layer.className = "searchLayer";
    const cur = this.matches[this.current];
    for (const m of pageMatches) {
      const rawStart = t.map[m.start];
      const rawEnd = t.map[m.start + this.query.length - 1] + 1;
      const a = locate(t, rawStart), b = locate(t, rawEnd - 1);
      if (!a || !b) continue;
      const nodeA = divs[a.item]?.firstChild, nodeB = divs[b.item]?.firstChild;
      if (!nodeA || !nodeB) continue;
      const range = document.createRange();
      try {
        range.setStart(nodeA, Math.min(a.offset, nodeA.length));
        range.setEnd(nodeB, Math.min(b.offset + 1, nodeB.length));
      } catch { continue; }
      const isCurrent = cur === m;
      for (const r of range.getClientRects()) {
        if (r.width < 0.5 || r.height < 0.5) continue;
        const el = document.createElement("div");
        el.className = isCurrent ? "searchHit current" : "searchHit";
        Object.assign(el.style, {
          left: `${((r.left - box.left) / box.width) * 100}%`,
          top: `${((r.top - box.top) / box.height) * 100}%`,
          width: `${(r.width / box.width) * 100}%`,
          height: `${(r.height / box.height) * 100}%`,
        });
        layer.append(el);
      }
    }
    p.div.append(layer);
  }
}

// posição no texto bruto → { item, offset }
function locate(t, rawIndex) {
  let lo = 0, hi = t.itemStart.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (t.itemStart[mid] <= rawIndex) lo = mid; else hi = mid - 1;
  }
  const offset = rawIndex - t.itemStart[lo];
  if (offset >= t.items[lo].str.length) return null; // caiu no espaço de fim de linha
  return { item: lo, offset };
}

// minúsculas, sem acentos e com espaços simplificados; map[i] = índice no texto original
function normalize(raw) {
  let norm = "";
  const map = [];
  let lastSpace = false;
  for (let i = 0; i < raw.length; i++) {
    let c = raw[i].normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    if (/\s/.test(c)) {
      if (lastSpace) continue;
      c = " ";
      lastSpace = true;
    } else {
      lastSpace = false;
    }
    for (const ch of c) { norm += ch; map.push(i); }
  }
  return { norm, map };
}
