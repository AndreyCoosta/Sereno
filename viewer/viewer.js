import * as pdfjsLib from "../lib/pdf.min.mjs";
import { createSettingsStore, warmHex } from "../settings.js";
import { colorPipeline, scaleMatrix, toSvgValues, MONO_CURVE_SLOPE } from "./colormath.js";
import { mountAppearance } from "../ui/appearance.js";
import { t, localize } from "../ui/i18n.js";
import { buildOutline } from "./outline.js";
import { Highlights, HL_COLORS } from "./highlights.js";
import { Search } from "./search.js";
import { getSaveHandle, setSaveHandle, ensureWritable } from "./savehandles.js";
import { storeUrl } from "../links.js";

const { OPS, Util } = pdfjsLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("lib/pdf.worker.min.mjs");

const CSS_UNITS = 96 / 72;          // 100% = tamanho real na tela, como no Edge
const MIN_SCALE = 0.25;
const MAX_SCALE = 5;
const MAX_AUTO_SCALE = 1.25;
const MAX_CANVAS_PIXELS = 16_777_216;
const SCAN_COVERAGE = 0.7;          // imagem que cobre >70% da página = página escaneada: escurece
const MIN_IMAGE_SIDE = 4;           // em pontos; imagens mais finas (linhas) também escurecem
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

const $ = (id) => document.getElementById(id);
const els = {
  viewer: $("viewer"), pages: $("pages"), title: $("title"),
  pageNum: $("pageNum"), pageCount: $("pageCount"), prev: $("prev"), next: $("next"),
  pageSlider: $("pageSlider"), pagePercent: $("pagePercent"),
  zoom: $("zoom"), zoomBtn: $("zoomBtn"), zoomLabel: $("zoomLabel"), zoomMenu: $("zoomMenu"), zoomIn: $("zoomIn"), zoomOut: $("zoomOut"),
  appearanceBtn: $("appearanceBtn"), appearancePanel: $("appearancePanel"),
  pickFile: $("pickFile"), fileInput: $("fileInput"),
  download: $("download"), printBtn: $("printBtn"),
  savePanel: $("savePanel"), toast: $("toast"), quickSave: $("quickSave"),
  saveWithTheme: $("saveWithTheme"),
  sidebarBtn: $("sidebarBtn"), sidebar: $("sidebar"), outline: $("outline"),
  searchBtn: $("searchBtn"), searchBar: $("searchBar"), searchInput: $("searchInput"),
  searchCount: $("searchCount"), searchPrev: $("searchPrev"), searchNext: $("searchNext"),
  searchClose: $("searchClose"),
  highlightBtn: $("highlightBtn"), eraseBtn: $("eraseBtn"), hlPalette: $("hlPalette"),
  empty: $("empty"), dropzone: $("dropzone"),
  status: $("status"), statusText: $("statusText"), progressFill: $("progressFill"),
  statusActions: $("statusActions"),
  pagePre: $("pdf-page-pre"), pageMatrix: $("pdf-page-matrix"),
  pageCurve: ["r", "g", "b"].map((c) => $(`pdf-page-curve-${c}`)), imageMatrix: $("pdf-image-matrix"), uiMatrix: $("pdf-ui-matrix"),
};

let store = null;       // configurações (ver settings.js)
const highlights = new Highlights({ pages: () => state.pages, onModeChange: (m) => onModeChange(m) });
const search = new Search({
  pdf: () => state.pdf,
  pages: () => state.pages,
  goToPage: (n) => goToPage(n),
  currentPage: () => state.currentPage,
  viewer: document.getElementById("viewer"),
  onUpdate: ({ current, total, busy }) => {
    els.searchCount.textContent = busy ? t("searching")
      : !search.query ? "" : total ? t("searchCount", [current, total]) : t("noResults");
    els.searchPrev.disabled = els.searchNext.disabled = !total;
  },
});
let appearance = null;  // painel de aparência
const state = {
  pdf: null,
  loadingTask: null,
  pages: [],
  zoom: "auto",
  scale: 1,
  gen: 0,            // incrementa a cada mudança de zoom (invalida renderizações antigas)
  fileUrl: null,
  filename: "documento.pdf",
  currentPage: 1,
};

// ===========================================================================
// Tema / cores
// ===========================================================================

// As cores são aplicadas como filtros SVG (feColorMatrix) sobre os pixels originais,
// então trocar tema, cor das letras ou luz azul é instantâneo, sem renderizar de novo.
// A matemática fica em colormath.js (compartilhada com a exportação do PDF).

// PDF que já foi salvo com o tema: aparece como está (sem escurecer de novo)
function effectiveSettings() {
  const s = store.settings;
  return state.alreadyThemed ? { ...s, enabled: false, blueLight: 0 } : s;
}

function applySettings() {
  const settings = effectiveSettings();
  const p = colorPipeline(settings);
  const { theme, warmText, warmImages } = p;

  els.pagePre.setAttribute("values", toSvgValues(p.pre));
  for (const fn of els.pageCurve) {
    fn.setAttribute("type", p.mono ? "linear" : "identity");
    fn.setAttribute("slope", String(MONO_CURVE_SLOPE));
    fn.setAttribute("intercept", "0");
  }
  els.pageMatrix.setAttribute("values", toSvgValues(p.matrix));
  els.imageMatrix.setAttribute("values", toSvgValues(scaleMatrix(p.image)));
  els.uiMatrix.setAttribute("values", toSvgValues(scaleMatrix(p.ui)));

  const body = document.body;
  body.classList.toggle("dark", settings.enabled);
  body.classList.toggle("preserve", settings.preserveImages);
  body.classList.toggle("warm", warmImages > 0);
  const root = document.documentElement.style;
  root.setProperty("--ui-bg", warmHex(settings.enabled ? theme.ui : state.alreadyThemed ? "#141414" : "#2b2d32", warmText));
  root.setProperty("--paper-bg", warmHex(theme.bg, warmText));

  appearance?.render();
  els.saveWithTheme.checked = store.settings.saveWithTheme !== false;
  els.quickSave.title = t(els.saveWithTheme.checked ? "quickSaveWith" : "quickSaveWithout");
}

function toggleAppearancePanel(open = els.appearancePanel.hidden) {
  els.appearancePanel.hidden = !open;
  els.appearanceBtn.setAttribute("aria-expanded", String(open));
  if (open) els.appearancePanel.querySelector(".ap-view:not([hidden]) :is([aria-checked='true'], button, input)")?.focus();
  if (open) refreshRateCard();
}

// ===========================================================================
// Detecção das imagens de cada página
// Percorre a lista de operações do PDF acompanhando a matriz de transformação
// para saber onde cada imagem é desenhada. Essas áreas são copiadas sem filtro
// para uma camada por cima, preservando as cores originais das fotos.
// ===========================================================================

async function computeImageRects(page) {
  const { fnArray, argsArray } = await page.getOperatorList();
  const vp = page.getViewport({ scale: 1 });
  const rects = [];
  const stack = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  let inAnnotation = 0;

  const addUnitSquare = (m) => {
    if (inAnnotation) return;
    const full = Util.transform(vp.transform, m);
    const xs = [], ys = [];
    for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const [px, py] = Util.applyTransform([x, y], full);
      xs.push(px); ys.push(py);
    }
    const x0 = Math.max(0, Math.min(...xs)), x1 = Math.min(vp.width, Math.max(...xs));
    const y0 = Math.max(0, Math.min(...ys)), y1 = Math.min(vp.height, Math.max(...ys));
    if (x1 - x0 < MIN_IMAGE_SIDE || y1 - y0 < MIN_IMAGE_SIDE) return;
    rects.push([x0 / vp.width, y0 / vp.height, x1 / vp.width, y1 / vp.height]);
  };

  for (let i = 0; i < fnArray.length; i++) {
    const args = argsArray[i];
    switch (fnArray[i]) {
      case OPS.save:
      case OPS.beginGroup:
        stack.push(ctm);
        break;
      case OPS.restore:
      case OPS.endGroup:
      case OPS.paintFormXObjectEnd:
        ctm = stack.pop() ?? ctm;
        break;
      case OPS.transform:
        ctm = Util.transform(ctm, args);
        break;
      case OPS.paintFormXObjectBegin:
        stack.push(ctm);
        if (args[0]) ctm = Util.transform(ctm, args[0]);
        break;
      case OPS.beginAnnotation:
        inAnnotation++;
        stack.push(ctm);
        break;
      case OPS.endAnnotation:
        inAnnotation = Math.max(0, inAnnotation - 1);
        ctm = stack.pop() ?? ctm;
        break;
      case OPS.paintImageXObject:
      case OPS.paintInlineImageXObject:
        addUnitSquare(ctm);
        break;
      case OPS.paintImageXObjectRepeat: {
        const [, sx, sy, pos] = args;
        for (let j = 0; j < pos.length; j += 2) {
          addUnitSquare(Util.transform(ctm, [sx, 0, 0, sy, pos[j], pos[j + 1]]));
        }
        break;
      }
      case OPS.paintInlineImageXObjectGroup:
        for (const entry of args[1]) addUnitSquare(Util.transform(ctm, entry.transform));
        break;
    }
  }

  // Página escaneada (uma imagem cobrindo quase tudo): melhor escurecer do que preservar.
  return rects.filter(([x0, y0, x1, y1]) => (x1 - x0) * (y1 - y0) < SCAN_COVERAGE);
}

// ===========================================================================
// Páginas: layout, renderização sob demanda, texto e links
// ===========================================================================

function createPageRecord(num, w, h) {
  const div = document.createElement("div");
  div.className = "page";
  div.dataset.page = String(num);
  const spinner = document.createElement("div");
  spinner.className = "spinner";
  div.append(spinner);
  const p = { num, div, w, h, page: null, renderedGen: -1, renderingGen: -1, task: null, layersBuilt: false, near: false };
  p.textReady = new Promise((resolve) => { p.resolveText = resolve; });
  div._rec = p;
  return p;
}

function sizePage(p) {
  const f = state.scale * CSS_UNITS;
  p.div.style.width = `${Math.floor(p.w * f)}px`;
  p.div.style.height = `${Math.floor(p.h * f)}px`;
  p.div.style.setProperty("--scale-factor", String(f));
}

async function ensurePage(p) {
  if (!p.page) {
    p.page = await state.pdf.getPage(p.num);
    const vp = p.page.getViewport({ scale: 1 });
    if (vp.width !== p.w || vp.height !== p.h) {
      p.w = vp.width;
      p.h = vp.height;
      sizePage(p);
    }
  }
  return p.page;
}

async function renderPage(p) {
  const gen = state.gen;
  if (p.renderedGen === gen || p.renderingGen === gen) return;
  p.renderingGen = gen;
  p.task?.cancel();

  try {
    const page = await ensurePage(p);
    if (gen !== state.gen || !p.near) return;

    const viewport = page.getViewport({ scale: state.scale * CSS_UNITS });
    let ratio = window.devicePixelRatio || 1;
    const area = viewport.width * viewport.height;
    if (area * ratio * ratio > MAX_CANVAS_PIXELS) ratio = Math.sqrt(MAX_CANVAS_PIXELS / area);

    const canvas = document.createElement("canvas");
    canvas.className = "base";
    canvas.width = Math.max(1, Math.floor(viewport.width * ratio));
    canvas.height = Math.max(1, Math.floor(viewport.height * ratio));
    // alpha: true de propósito. Num canvas opaco o Edge/Chrome desenha o texto com
    // antialiasing subpixel (ClearType), que deixa franjas coloridas nas bordas das letras;
    // invertidas pelo modo escuro, elas aparecem como um contorno azulado/alaranjado.
    // Com alpha o navegador usa antialiasing em tons de cinza. O pdf.js pinta o fundo branco.
    const ctx = canvas.getContext("2d", { alpha: true });

    p.task = page.render({
      canvasContext: ctx,
      viewport,
      transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : null,
    });
    await p.task.promise;
    p.task = null;
    if (gen !== state.gen) return;

    const overlay = await buildImageOverlay(p, canvas);
    if (gen !== state.gen) return;

    p.div.querySelectorAll("canvas, .spinner").forEach((el) => el.remove());
    p.div.prepend(canvas);
    if (overlay) canvas.after(overlay);
    p.renderedGen = gen;

    if (!p.layersBuilt) {
      p.layersBuilt = true;
      buildTextLayer(p).catch((e) => console.warn("Camada de texto:", e));
      buildLinkLayer(p).catch((e) => console.warn("Links:", e));
      highlights.renderPage(p);
    }
  } catch (err) {
    if (err?.name !== "RenderingCancelledException") console.error(`Página ${p.num}:`, err);
  } finally {
    if (p.renderingGen === gen) p.renderingGen = -1;
  }
}

async function buildImageOverlay(p, base) {
  p.imageRects ??= computeImageRects(p.page).catch(() => []);
  const rects = await p.imageRects;
  if (!rects.length) return null;
  const overlay = document.createElement("canvas");
  overlay.className = "images";
  overlay.width = base.width;
  overlay.height = base.height;
  const octx = overlay.getContext("2d");
  const W = base.width, H = base.height;
  for (const [x0, y0, x1, y1] of rects) {
    // Copia o miolo da imagem (sem a borda suavizada) esticado até cobrir a borda,
    // para não sobrar uma linha de 1px clara/invertida em volta.
    const sx = Math.ceil(x0 * W), sy = Math.ceil(y0 * H);
    const sw = Math.min(W, Math.floor(x1 * W)) - sx, sh = Math.min(H, Math.floor(y1 * H)) - sy;
    const dx = Math.floor(x0 * W), dy = Math.floor(y0 * H);
    const dw = Math.min(W, Math.ceil(x1 * W)) - dx, dh = Math.min(H, Math.ceil(y1 * H)) - dy;
    if (sw > 0 && sh > 0) octx.drawImage(base, sx, sy, sw, sh, dx, dy, dw, dh);
  }
  return overlay;
}

function releasePage(p) {
  p.task?.cancel();
  p.task = null;
  p.renderedGen = -1;
  p.renderingGen = -1;
  const canvases = p.div.querySelectorAll("canvas");
  if (!canvases.length) return;
  canvases.forEach((c) => { c.width = 0; c.height = 0; c.remove(); });
  if (!p.div.querySelector(".spinner")) {
    const s = document.createElement("div");
    s.className = "spinner";
    p.div.prepend(s);
  }
}

async function buildTextLayer(p) {
  const container = document.createElement("div");
  container.className = "textLayer";
  p.div.append(container);
  const textLayer = new pdfjsLib.TextLayer({
    textContentSource: p.page.streamTextContent(),
    container,
    viewport: p.page.getViewport({ scale: 1 }),
  });
  await textLayer.render();
  p.textLayer = textLayer;
  p.resolveText(textLayer);
  search.renderPage(p);
  const end = document.createElement("div");
  end.className = "endOfContent";
  container.append(end);
  container.addEventListener("mousedown", () => container.classList.add("selecting"));
  document.addEventListener("mouseup", () => container.classList.remove("selecting"));
}

async function buildLinkLayer(p) {
  const annotations = await p.page.getAnnotations({ intent: "display" });
  const links = annotations.filter((a) => a.subtype === "Link" && (a.url || a.dest || a.action));
  if (!links.length) return;
  const vp = p.page.getViewport({ scale: 1 });
  const layer = document.createElement("div");
  layer.className = "linkLayer";
  for (const a of links) {
    const [x1, y1, x2, y2] = vp.convertToViewportRectangle(a.rect);
    const el = document.createElement("a");
    Object.assign(el.style, {
      left: `${(Math.min(x1, x2) / vp.width) * 100}%`,
      top: `${(Math.min(y1, y2) / vp.height) * 100}%`,
      width: `${(Math.abs(x2 - x1) / vp.width) * 100}%`,
      height: `${(Math.abs(y2 - y1) / vp.height) * 100}%`,
    });
    if (a.url) {
      el.href = a.url;
      el.target = "_top"; // abre na mesma guia
      el.rel = "noreferrer";
      el.title = a.url;
    } else {
      el.href = "#";
      el.addEventListener("click", (e) => {
        e.preventDefault();
        if (a.dest) goToDestination(a.dest);
        else namedAction(a.action);
      });
    }
    layer.append(el);
  }
  p.div.append(layer);
}

function namedAction(action) {
  const n = state.pages.length;
  const map = { NextPage: state.currentPage + 1, PrevPage: state.currentPage - 1, FirstPage: 1, LastPage: n };
  if (map[action]) goToPage(map[action]);
}

async function goToDestination(dest) {
  const explicit = typeof dest === "string" ? await state.pdf.getDestination(dest) : dest;
  if (!Array.isArray(explicit)) return;
  const ref = explicit[0];
  let index = null;
  if (ref && typeof ref === "object") index = await state.pdf.getPageIndex(ref).catch(() => null);
  else if (Number.isInteger(ref)) index = ref;
  if (index === null) return;
  const p = state.pages[index];
  let frac = 0;
  const kind = explicit[1]?.name;
  const y = kind === "XYZ" ? explicit[3] : kind === "FitH" || kind === "FitBH" ? explicit[2] : null;
  if (typeof y === "number") {
    const page = await ensurePage(p);
    const vp = page.getViewport({ scale: 1 });
    frac = Math.min(1, Math.max(0, vp.convertToViewportPoint(0, y)[1] / vp.height));
  }
  goToPage(index + 1, frac);
}

// ===========================================================================
// Observadores: renderiza o que está perto da tela, libera o que está longe
// ===========================================================================

const renderObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const p = e.target._rec;
    p.near = e.isIntersecting;
    if (p.near) renderPage(p);
  }
}, { root: els.viewer, rootMargin: "120% 0px" });

const releaseObserver = new IntersectionObserver((entries) => {
  for (const e of entries) if (!e.isIntersecting) releasePage(e.target._rec);
}, { root: els.viewer, rootMargin: "400% 0px" });

function rerenderNear() {
  for (const p of state.pages) if (p.near) renderPage(p);
}

// ===========================================================================
// Zoom e navegação
// ===========================================================================

function resolveScale(zoom) {
  const p = state.pages[state.currentPage - 1] ?? state.pages[0];
  if (!p) return 1;
  const availW = els.viewer.clientWidth - 2 * 14 - 4;
  const availH = els.viewer.clientHeight - 2 * 14;
  const widthScale = availW / (p.w * CSS_UNITS);
  const fitScale = Math.min(widthScale, availH / (p.h * CSS_UNITS));
  let s;
  if (zoom === "page-width") s = widthScale;
  else if (zoom === "page-fit") s = fitScale;
  else if (zoom === "auto") s = Math.min(MAX_AUTO_SCALE, p.w > p.h ? fitScale : widthScale);
  else s = Number(zoom);
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s || 1));
}

function setZoom(zoom) {
  const newScale = resolveScale(zoom);
  state.zoom = zoom;
  updateZoomSelect(newScale);
  if (Math.abs(newScale - state.scale) < 1e-4 && state.pages[0]?.div.style.width) return;

  // mantém a mesma posição relativa do documento
  const v = els.viewer;
  const anchor = state.pages[state.currentPage - 1];
  const frac = anchor ? (v.scrollTop - anchor.div.offsetTop) / anchor.div.offsetHeight : 0;
  const xFrac = v.scrollWidth > v.clientWidth ? (v.scrollLeft + v.clientWidth / 2) / v.scrollWidth : 0.5;

  state.scale = newScale;
  state.gen++;
  for (const p of state.pages) sizePage(p);

  if (anchor) v.scrollTop = anchor.div.offsetTop + frac * anchor.div.offsetHeight;
  v.scrollLeft = xFrac * v.scrollWidth - v.clientWidth / 2;
  rerenderNear();
}

function updateZoomSelect(scale) {
  const sel = els.zoom;
  const custom = sel.querySelector('option[value="custom"]');
  const match = [...sel.options].find((o) => o.value === String(state.zoom));
  if (match && state.zoom !== "custom") {
    sel.value = String(state.zoom);
    custom.hidden = true;
  } else {
    custom.textContent = `${Math.round(scale * 100)}%`;
    custom.hidden = false;
    sel.value = "custom";
  }
  const autoOpt = sel.querySelector('option[value="auto"]');
  if (autoOpt) autoOpt.textContent = t("zoomAutoPct", Math.round(resolveScale("auto") * 100));
  syncZoomButton();
}

// ----- Menu de zoom no estilo do leitor (espelha o <select> escondido) -----
const CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

function syncZoomButton() {
  const opt = els.zoom.selectedOptions[0];
  els.zoomLabel.textContent = opt ? opt.textContent : "";
}

function toggleZoomMenu(open = els.zoomMenu.hidden) {
  const menu = els.zoomMenu;
  if (open) {
    menu.replaceChildren();
    for (const o of els.zoom.options) {
      if (o.hidden) continue;
      if (o.value === "0.5") menu.append(document.createElement("hr"));
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "menuitemradio");
      b.setAttribute("aria-checked", String(o.value === els.zoom.value));
      b.innerHTML = `<span></span>${CHECK}`;
      b.firstChild.textContent = o.textContent;
      b.addEventListener("click", () => {
        toggleZoomMenu(false);
        if (els.zoom.value !== o.value) {
          els.zoom.value = o.value;
          els.zoom.dispatchEvent(new Event("change"));
        }
        syncZoomButton();
        els.zoomBtn.focus();
      });
      menu.append(b);
    }
    menu.hidden = false;
    const r = els.zoomBtn.getBoundingClientRect();
    const w = menu.offsetWidth;
    menu.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2))}px`;
    menu.style.bottom = `${innerHeight - r.top + 10}px`;
    (menu.querySelector('[aria-checked="true"]') || menu.querySelector("button"))?.focus();
  } else {
    menu.hidden = true;
  }
  els.zoomBtn.setAttribute("aria-expanded", String(open));
}

function stepZoom(dir) {
  const cur = state.scale;
  const next = dir > 0
    ? ZOOM_STEPS.find((s) => s > cur + 0.001) ?? MAX_SCALE
    : [...ZOOM_STEPS].reverse().find((s) => s < cur - 0.001) ?? MIN_SCALE;
  setZoom(String(next));
}

function goToPage(n, frac = 0) {
  const p = state.pages[Math.min(state.pages.length, Math.max(1, n)) - 1];
  if (!p) return;
  els.viewer.scrollTop = p.div.offsetTop - (frac ? 0 : 8) + frac * p.div.offsetHeight;
}

// Barra inferior: "Página X de Y · Z%" e o controle deslizante (como no Kindle)
function updateProgress() {
  const total = state.pages.length || 1;
  const v = els.viewer;
  const max = v.scrollHeight - v.clientHeight;
  const pct = max > 0 ? Math.round((v.scrollTop / max) * 100) : 100;
  els.pagePercent.textContent = `${pct}%`;
  if (!els.pageSlider.matches(":active")) els.pageSlider.value = String(state.currentPage);
  els.pageSlider.style.setProperty("--fill", `${total > 1 ? ((els.pageSlider.value - 1) / (total - 1)) * 100 : 100}%`);
}

function updateCurrentPage() {
  const pages = state.pages;
  if (!pages.length) return;
  const y = els.viewer.scrollTop + els.viewer.clientHeight * 0.33;
  let lo = 0, hi = pages.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (pages[mid].div.offsetTop <= y) lo = mid; else hi = mid - 1;
  }
  const n = lo + 1;
  if (n !== state.currentPage) {
    state.currentPage = n;
    if (document.activeElement !== els.pageNum) els.pageNum.value = String(n);
  }
  updateProgress();
  els.prev.disabled = n <= 1;
  els.next.disabled = n >= pages.length;
}

// ===========================================================================
// Carregamento do documento
// ===========================================================================

function showStatus(text, { progress = null, error = false, actions = [] } = {}) {
  els.status.hidden = false;
  els.status.classList.toggle("error", error);
  els.status.classList.toggle("indeterminate", !error && progress === null);
  if (progress !== null) els.progressFill.style.width = `${Math.round(progress * 100)}%`;
  els.statusText.textContent = text;
  els.statusActions.replaceChildren(...actions.map(([label, fn, primary]) => {
    const b = document.createElement("button");
    b.textContent = label;
    if (primary) b.className = "primary";
    b.addEventListener("click", fn);
    return b;
  }));
}

function hideStatus() { els.status.hidden = true; }

function filenameFromUrl(url) {
  try {
    const u = new URL(url);
    const last = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() || "");
    if (last) return /\.pdf$/i.test(last) ? last : `${last}.pdf`;
  } catch {}
  return "documento.pdf";
}

function getFileParam() {
  const s = location.search;
  if (!s.startsWith("?file=")) return null;
  let v = s.slice(6);
  if (/^[a-z][a-z0-9+.-]*%3A/i.test(v)) {
    try { v = decodeURIComponent(v); } catch {}
  }
  return v || null;
}

async function resetDocument() {
  for (const p of state.pages) {
    renderObserver.unobserve(p.div);
    releaseObserver.unobserve(p.div);
    releasePage(p);
  }
  state.pages = [];
  els.pages.replaceChildren();
  search.reset();
  highlights.reset();
  els.outline.replaceChildren();
  els.printBtn.disabled = true;
  if (state.loadingTask) await state.loadingTask.destroy().catch(() => {});
  state.pdf = null;
  state.loadingTask = null;
  state.currentPage = 1;
  state.gen++;
}

async function openDocument(source, { filename, fileUrl = null, handle = null } = {}) {
  await resetDocument();
  els.empty.hidden = true;
  state.fileUrl = fileUrl;
  state.filename = filename || "documento.pdf";
  els.download.disabled = els.quickSave.disabled = true;
  // aberto do computador com permissão: o "Salvar" grava no próprio arquivo
  state.saveTarget = handle ? { handle, kind: null } : null;
  state.alreadyThemed = false;
  state.docKey = fileUrl;
  setTitle(state.filename);
  showStatus(t("loadingPdf"));

  const task = pdfjsLib.getDocument({
    ...source,
    cMapUrl: chrome.runtime.getURL("lib/cmaps/"),
    cMapPacked: true,
    standardFontDataUrl: chrome.runtime.getURL("lib/standard_fonts/"),
    isEvalSupported: false,
    enableXfa: false,
  });
  state.loadingTask = task;

  task.onProgress = ({ loaded, total }) => {
    if (total > 0) showStatus(t("loadingPdfPct", Math.round((loaded / total) * 100)), { progress: loaded / total });
  };
  task.onPassword = (update, reason) => {
    const msg = reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD
      ? t("wrongPassword")
      : t("needPassword");
    const pw = window.prompt(msg);
    if (pw === null) {
      task.destroy();
      showError(t("passwordCancelled"));
    } else {
      update(pw);
    }
  };

  let pdf;
  try {
    pdf = await task.promise;
  } catch (err) {
    if (task !== state.loadingTask) return;
    console.error(err);
    showError(describeError(err, fileUrl));
    return;
  }
  if (task !== state.loadingTask) return;
  state.pdf = pdf;

  pdf.getMetadata().then(({ info, contentDispositionFilename }) => {
    if (contentDispositionFilename && !filename) state.filename = contentDispositionFilename;
    if (info?.Custom?.PDFDarkMode) {
      state.alreadyThemed = true;
      applySettings();
      showToast(t("alreadyThemed"));
    }
    const t = typeof info?.Title === "string" ? info.Title.trim() : "";
    setTitle(t && !/^(untitled|sem título|document\d*)$/i.test(t) ? t : state.filename);
  }).catch(() => {});

  state.docKey ??= pdf.fingerprints?.[0] ? `fp:${pdf.fingerprints[0]}` : null;
  if (!state.saveTarget) {
    const remembered = await getSaveHandle(state.docKey);
    if (remembered) state.saveTarget = { handle: remembered, kind: null };
  }
  await highlights.load(pdf.fingerprints?.[0]);
  await buildPages(pdf);
  hideStatus();
  els.download.disabled = els.quickSave.disabled = false;
  els.printBtn.disabled = false;
  buildOutline(pdf, els.outline, { goToDestination, close: () => toggleSidebar(false) }).catch(() => {});
  els.viewer.focus({ preventScroll: true });
  countReading();
}

// ===========================================================================
// Convite para avaliar: na barra inferior, assim que a pessoa abre o 3º PDF (conta toda
// abertura, mesmo que seja o mesmo arquivo). Aparece uma única vez no leitor.
// "Agora não" passa o convite para o menu da extensão (popup), com "Avaliar" e "Não quero".
// Nada é oferecido em troca.
// rateState: undefined (ainda não perguntou) | "later" (escolheu "Agora não") | "done"
// ===========================================================================

const RATE_AFTER = 3;

async function countReading() {
  try {
    const { readCount = 0, rateState } = await chrome.storage.local.get(["readCount", "rateState"]);
    if (rateState) return;
    const n = readCount + 1;
    await chrome.storage.local.set({ readCount: n });
    if (n >= RATE_AFTER) showRatePrompt();
  } catch {
    // sem armazenamento: não pergunta
  }
}

async function showRatePrompt() {
  const { rateState } = await chrome.storage.local.get("rateState");
  if (rateState) return;                       // outra guia já perguntou
  const nav = $("navGroup");
  const box = $("ratePrompt");
  const close = () => { box.hidden = true; nav.classList.remove("asking"); };
  $("rateNow").onclick = async () => {
    close();
    await chrome.storage.local.set({ rateState: "done" });
    chrome.tabs.create({ url: storeUrl() });
  };
  $("rateLater").onclick = async () => {
    close();
    await chrome.storage.local.set({ rateState: "later" });
  };
  nav.classList.add("asking");
  box.hidden = false;
}

// Depois de "Agora não", o convite também aparece como uma caixinha no fim do painel "Aa"
// (como no menu da extensão), com "Avaliar" e "Não quero".
function mountRateCard() {
  const main = els.appearancePanel.querySelector('.ap-view[data-view="main"]') || els.appearancePanel;
  const card = document.createElement("div");
  card.className = "ap-rate";
  card.id = "rateCard";
  card.hidden = true;
  card.innerHTML = `
    <p></p>
    <div class="ap-rate-actions">
      <button type="button" class="rate-btn" data-r="never"></button>
      <button type="button" class="rate-btn rate-yes" data-r="now"></button>
    </div>`;
  card.querySelector("p").textContent = t("rateAsk");
  card.querySelector('[data-r="never"]').textContent = t("rateNever");
  card.querySelector('[data-r="now"]').textContent = t("rateNow");
  const done = () => chrome.storage.local.set({ rateState: "done" });
  card.querySelector('[data-r="now"]').onclick = async () => {
    card.hidden = true;
    await done();
    chrome.tabs.create({ url: storeUrl() });
  };
  card.querySelector('[data-r="never"]').onclick = async () => {
    card.hidden = true;
    await done();
  };
  main.append(card);
  refreshRateCard();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.rateState) refreshRateCard();
  });
}

async function refreshRateCard() {
  const card = $("rateCard");
  if (!card) return;
  try {
    const { rateState } = await chrome.storage.local.get("rateState");
    card.hidden = rateState !== "later";
  } catch {
    card.hidden = true;
  }
}

function describeError(err, fileUrl) {
  if (fileUrl?.startsWith("file:")) {
    return t("errLocalFile");
  }
  if (err?.name === "InvalidPDFException") return t("errInvalid");
  if (err?.name === "MissingPDFException") return t("errMissing");
  if (err?.name === "UnexpectedResponseException") return t("errServer", err.status || t("unknown"));
  return t("errOpen", err?.message || String(err));
}

function showError(text) {
  const actions = [];
  if (state.fileUrl) actions.push([t("openInOriginal"), openOriginal, true]);
  actions.push([t("openAnother"), openFromComputer]);
  showStatus(text, { error: true, actions });
}

function setTitle(t) {
  els.title.textContent = t;
  els.title.title = t;
  document.title = t;
}

async function buildPages(pdf) {
  const n = pdf.numPages;
  const first = await pdf.getPage(1);
  const vp1 = first.getViewport({ scale: 1 });

  // Para documentos menores, já descobre o tamanho real de cada página.
  let sizes = null;
  if (n <= 300) {
    sizes = await Promise.all(Array.from({ length: n }, (_, i) =>
      (i === 0 ? Promise.resolve(first) : pdf.getPage(i + 1)).then((pg) => {
        const vp = pg.getViewport({ scale: 1 });
        return [vp.width, vp.height, pg];
      })));
  }

  const frag = document.createDocumentFragment();
  for (let i = 0; i < n; i++) {
    const [w, h, pg] = sizes ? sizes[i] : [vp1.width, vp1.height, i === 0 ? first : null];
    const p = createPageRecord(i + 1, w, h);
    p.page = pg;
    state.pages.push(p);
    frag.append(p.div);
  }
  els.pages.append(frag);
  els.pageCount.textContent = String(n);
  els.pageNum.value = "1";
  els.pageSlider.max = String(n);
  els.pageSlider.disabled = n < 2;
  els.pageSlider.hidden = n < 2; // documento de uma página: só "Página 1 de 1"

  state.scale = 0; // força o layout
  setZoom(state.zoom);
  for (const p of state.pages) {
    renderObserver.observe(p.div);
    releaseObserver.observe(p.div);
  }
  updateCurrentPage();
}

async function openOriginal() {
  const url = state.fileUrl;
  if (!url) return;
  await chrome.runtime.sendMessage({ type: "bypass", url }).catch(() => {});
  if (window.top === window) {
    const tab = await chrome.tabs.getCurrent();
    if (tab) return chrome.tabs.update(tab.id, { url });
  }
  location.href = url;
}

// ===========================================================================
// Salvar: com o tema, original com marcações, ou original
// Abre a janela "Salvar como" do navegador (escolher pasta e nome); se ela não
// existir, o arquivo vai para Downloads.
// ===========================================================================

function toggleSavePanel(open = els.savePanel.hidden) {
  if (open && (!state.pdf || els.download.disabled)) return;
  els.savePanel.hidden = !open;
  els.download.setAttribute("aria-expanded", String(open));
  if (open) {
    els.savePanel.querySelector("button:not([hidden])")?.focus();
  }
}

function saveName(kind) {
  const base = state.filename.replace(/\.pdf$/i, "");
  if (kind === "themed") return `${base} (${t("themedSuffix")}).pdf`;
  return `${base}.pdf`; // sem o tema: mesmo nome do original
}

// Pasta onde a janela "Salvar como" abre: a mesma de onde o PDF veio, quando dá para saber.
function guessStartFolder() {
  const url = decodeURIComponent(state.fileUrl || "").toLowerCase();
  if (!url.startsWith("file:")) return "downloads";
  if (/\/(desktop|área de trabalho|area de trabalho)\//.test(url)) return "desktop";
  if (/\/(documents|documentos|meus documentos)\//.test(url)) return "documents";
  if (/\/(downloads|transferências)\//.test(url)) return "downloads";
  return "documents";
}

async function pickSaveTarget(name) {
  if (!("showSaveFilePicker" in window)) return null;
  try {
    return await window.showSaveFilePicker({
      suggestedName: name,
      startIn: guessStartFolder(),
      types: [{ description: t("pdfDocument"), accept: { "application/pdf": [".pdf"] } }],
    });
  } catch (err) {
    if (err?.name === "AbortError") throw err; // a pessoa cancelou
    return null;                               // sem janela: usa Downloads
  }
}

// ---------------------------------------------------------------------------
// Gravar pela pasta Downloads, substituindo o arquivo, sem janela nem pop-up.
// Usa o sistema de downloads do navegador ("substituir se já existir") e esconde
// o aviso de download enquanto grava. Depois confere se o arquivo foi parar
// exatamente onde devia; se não, apaga a cópia e avisa.
// ---------------------------------------------------------------------------
class WrongPlaceError extends Error {}

function filePathFromUrl(url) {
  let path = decodeURIComponent(new URL(url).pathname);
  if (/^\/[a-z]:/i.test(path)) path = path.slice(1); // /C:/... → C:/...
  return path;
}

function samePath(a, b) {
  const n = (x) => x.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
  return n(a) === n(b);
}

function safeFileName(name) {
  return (name || "documento.pdf").replace(/[\\/:*?"<>|]+/g, "_").replace(/^\.+/, "") || "documento.pdf";
}

// Onde o "Salvar" grava sem perguntar: o próprio arquivo, se ele estiver em Downloads;
// ou, para PDFs da internet, um arquivo com o mesmo nome em Downloads.
function downloadsTarget() {
  if (!chrome.downloads?.download) return null;
  const url = state.fileUrl || "";
  if (url.startsWith("file:")) {
    const abs = filePathFromUrl(url);
    const m = abs.match(/^.*?[\\/]downloads[\\/](.+)$/i);
    return m ? { type: "downloads", rel: m[1].replace(/\\/g, "/"), abs } : null;
  }
  return { type: "downloads", rel: safeFileName(state.filename), abs: null };
}

function waitForDownload(id) {
  return new Promise((resolve) => {
    const finish = async () => {
      const [item] = await chrome.downloads.search({ id });
      if (item && item.state !== "in_progress") {
        chrome.downloads.onChanged.removeListener(onChanged);
        resolve(item);
      }
    };
    const onChanged = (delta) => { if (delta.id === id && delta.state) finish(); };
    chrome.downloads.onChanged.addListener(onChanged);
    finish();
  });
}

async function saveViaDownloads(bytes, target) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  let uiHidden = false;
  try {
    try { await chrome.downloads.setUiOptions({ enabled: false }); uiHidden = true; } catch {}
    const id = await chrome.downloads.download({
      url, filename: target.rel, conflictAction: "overwrite", saveAs: false,
    });
    const item = await waitForDownload(id);
    if (item.state !== "complete") throw new Error(item.error || t("writeInterrupted"));
    if (target.abs && !samePath(item.filename, target.abs)) {
      // o Edge baixa em outra pasta: não deixa cópia para trás
      await chrome.downloads.removeFile(id).catch(() => {});
      await chrome.downloads.erase({ id }).catch(() => {});
      throw new WrongPlaceError();
    }
    await chrome.downloads.erase({ id }).catch(() => {}); // tira só da lista de downloads
    target.abs = item.filename;
    return item.filename;
  } finally {
    if (uiHidden) chrome.downloads.setUiOptions({ enabled: true }).catch(() => {});
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

async function writeTarget(handle, bytes, name) {
  if (handle?.type === "downloads") {
    const abs = await saveViaDownloads(bytes, handle);
    showToast(t("savedName", abs.split(/[\\/]/).pop()));
  } else if (handle) {
    const w = await handle.createWritable();
    await w.write(bytes);
    await w.close();
    showToast(t("savedName", handle.name));
  } else {
    saveFile(bytes, name);
    showToast(t("savedDownloads", name));
  }
}

// "Salvar como": pergunta onde salvar e lembra o arquivo para o "Salvar" rápido.
async function savePdf(kind) {
  toggleSavePanel(false);
  if (!state.pdf || state.exporting) return;
  const name = saveName(kind);
  let handle;
  try {
    handle = await pickSaveTarget(name); // precisa vir logo depois do clique
  } catch {
    return;
  }
  if (handle) {
    state.saveTarget = { handle, kind: null }; // depois, o Ctrl+S segue a chave
    setSaveHandle(state.docKey, handle);
  }
  await writePdf(kind, handle, name);
}

// "Salvar" (como o do leitor do Edge): grava sempre no MESMO arquivo, sem criar outro.
//  - PDF aberto do computador → grava no próprio arquivo.
//  - Já salvo antes (agora ou em outro dia) → grava por cima daquele arquivo.
//  - Primeira vez de um PDF da internet / aberto por duplo clique → pergunta onde salvar
//    uma única vez (pode escolher o próprio arquivo) e depois lembra.
// Ctrl+S: com o tema ou sem o tema (chave no menu "Salvar como"); marcações sempre incluídas.
function defaultKind() {
  const s = store.settings;
  return s.saveWithTheme && (s.enabled || s.blueLight) ? "themed" : "marks";
}

async function quickSave() {
  if (!state.pdf || state.exporting) return;
  toggleSavePanel(false);
  const kind = defaultKind();
  let target = state.saveTarget?.handle ?? null;
  if (target && target.type !== "downloads" && !(await ensureWritable(target))) target = null;

  // Sem janela: o próprio arquivo em Downloads (ou o PDF da internet salvo em Downloads)
  if (!target) target = downloadsTarget();
  if (target) {
    const ok = await writePdf(kind, target, target.rel ?? target.name);
    if (ok) {
      state.saveTarget = { handle: target, kind: state.saveTarget?.kind ?? null };
      setSaveHandle(state.docKey, target);
    }
    return;
  }

  // Arquivo fora de Downloads: a janela aparece uma única vez
  await chooseSaveFile(kind);
}

async function chooseSaveFile(kind) {
  let handle;
  try {
    handle = await pickSaveTarget(state.filename);
  } catch {
    return; // cancelou
  }
  if (!handle) return writePdf(kind, null, saveName(kind)); // navegador sem a janela
  state.saveTarget = { handle, kind: state.saveTarget?.kind ?? null };
  setSaveHandle(state.docKey, handle);
  return writePdf(kind, handle, handle.name);
}

async function writePdf(kind, handle, name) {
  state.exporting = true;
  els.download.disabled = els.quickSave.disabled = true;
  let data = null;
  try {
    data = await state.pdf.getData();
    let out = data;
    const marks = structuredClone(highlights.items);
    if (kind === "themed" || (kind === "marks" && marks.length)) {
      const settings = kind === "themed"
        ? structuredClone(store.settings)
        : { ...structuredClone(store.settings), enabled: false, blueLight: 0 };
      showStatus(kind === "themed" ? t("generatingThemed") : t("savingHighlights"));
      const { exportThemedPdf } = await import("./export.js");
      out = await exportThemedPdf(data.slice(), settings, { highlights: marks });
      hideStatus();
    }
    await writeTarget(handle, out, name);
    return true;
  } catch (err) {
    if (err instanceof WrongPlaceError) {
      // a pasta de downloads do Edge não é a do arquivo: escolher o arquivo uma vez
      state.saveTarget = null;
      hideStatus();
      showStatus(t("pickFileOnce"), {
        error: true,
        actions: [[t("chooseTheFile"), () => { hideStatus(); chooseSaveFile(kind); }, true], [t("cancel"), hideStatus]],
      });
      return false;
    }
    console.error("Salvar:", err);
    const original = data;
    const actions = [[t("close"), hideStatus]];
    if (original) {
      actions.unshift([t("saveOriginal"), async () => {
        hideStatus();
        await writeTarget(handle, original, state.filename).catch(() => saveFile(original, state.filename));
      }, true]);
    }
    showStatus(err?.constructor?.name === "ProtectedPdfError"
      ? t("errProtected")
      : t("errSave"), { error: true, actions });
  } finally {
    state.exporting = false;
    els.download.disabled = els.quickSave.disabled = false;
  }
}

let toastTimer = 0;
function showToast(text) {
  els.toast.textContent = text;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, 2600);
}

function saveFile(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

// ===========================================================================
// Impressão com a personalização
// ===========================================================================

async function printWithTheme() {
  if (!state.pdf || state.printing) return;
  state.printing = true;
  let cancelled = false;
  const cancel = () => { cancelled = true; hideStatus(); };
  try {
    const { printDocument } = await import("./print.js");
    const s = structuredClone(effectiveSettings());
    const bg = getComputedStyle(document.documentElement).getPropertyValue("--paper-bg").trim();
    await printDocument({
      pdf: state.pdf,
      settings: s,
      pageBg: s.enabled ? bg : "#fff",
      imageRects: (num, page) => {
        const p = state.pages[num - 1];
        p.imageRects ??= computeImageRects(page).catch(() => []);
        return p.imageRects;
      },
      highlights: (num) => highlights.forPage(num),
      onProgress: (done, total) => {
        if (!cancelled) {
          showStatus(t("preparingPrint", [done, total]), {
            progress: done / total, actions: [[t("cancel"), cancel]],
          });
        }
      },
      cancelled: () => cancelled,
    });
    if (!cancelled) hideStatus();
  } catch (err) {
    console.error("Impressão:", err);
    showStatus(t("errPrint"), { error: true, actions: [[t("close"), hideStatus]] });
  } finally {
    state.printing = false;
  }
}

// ===========================================================================
// Sumário, pesquisa e marca-texto
// ===========================================================================

function toggleSidebar(open = els.sidebar.hidden) {
  els.sidebar.hidden = !open;
  document.body.classList.toggle("sidebar-open", open);
  els.sidebarBtn.setAttribute("aria-expanded", String(open));
  if (["auto", "page-width", "page-fit"].includes(state.zoom)) setZoom(state.zoom);
}

function toggleSearch(open = els.searchBar.hidden) {
  els.searchBar.hidden = !open;
  els.searchBtn.setAttribute("aria-expanded", String(open));
  if (open) {
    if (highlights.mode) highlights.setMode(highlights.mode); // sai do marca-texto/apagador
    els.searchInput.focus();
    els.searchInput.select();
  } else {
    search.find("");
    els.searchInput.value = "";
    els.searchCount.textContent = "";
    els.viewer.focus({ preventScroll: true });
  }
}

function onModeChange(mode) {
  els.highlightBtn.setAttribute("aria-pressed", String(mode === "highlight"));
  els.eraseBtn.setAttribute("aria-pressed", String(mode === "erase"));
  els.hlPalette.hidden = mode !== "highlight";
  if (mode === "highlight") {
    const b = els.highlightBtn.getBoundingClientRect();
    els.hlPalette.style.left = `${Math.max(8, b.left + b.width / 2 - els.hlPalette.offsetWidth / 2)}px`;
  }
}

function buildHighlightPalette() {
  for (const c of HL_COLORS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "hl-swatch";
    b.style.background = c.color;
    b.title = c.label;
    b.setAttribute("aria-label", c.label);
    b.setAttribute("role", "radio");
    b.addEventListener("click", () => {
      highlights.setColor(c.color);
      document.body.style.setProperty("--hl-color", c.color);
      renderPalette();
    });
    els.hlPalette.append(b);
  }
  renderPalette();
}

function renderPalette() {
  for (const b of els.hlPalette.children) {
    b.setAttribute("aria-checked", String(b.style.background === toRgbString(highlights.color)));
  }
  document.body.style.setProperty("--hl-color", highlights.color);
}

function toRgbString(hex) {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`;
}

// Abre um PDF do computador já com o "atalho" do arquivo, para o Salvar gravar nele
async function openFromComputer() {
  if (!("showOpenFilePicker" in window)) return els.fileInput.click();
  let handle;
  try {
    [handle] = await window.showOpenFilePicker({
      types: [{ description: t("pdfDocument"), accept: { "application/pdf": [".pdf"] } }],
    });
  } catch {
    return; // cancelou
  }
  openLocalFile(await handle.getFile(), handle);
}

async function openLocalFile(file, handle = null) {
  if (!file) return;
  if (file.type && file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) {
    showStatus(t("notPdf"), { error: true, actions: [[t("chooseAnother"), () => els.fileInput.click(), true]] });
    return;
  }
  const data = new Uint8Array(await file.arrayBuffer());
  history.replaceState(null, "", location.pathname);
  openDocument({ data }, { filename: file.name, handle });
}

// ===========================================================================
// Eventos
// ===========================================================================

function bindEvents() {
  let scrollRaf = 0;
  els.viewer.addEventListener("scroll", () => {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; updateCurrentPage(); });
  }, { passive: true });

  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (["auto", "page-width", "page-fit"].includes(state.zoom)) setZoom(state.zoom);
      else updateZoomSelect(state.scale);
    }, 120);
  });

  els.prev.addEventListener("click", () => goToPage(state.currentPage - 1));
  els.pageSlider.addEventListener("input", () => {
    goToPage(Number(els.pageSlider.value));
    updateProgress();
  });
  els.next.addEventListener("click", () => goToPage(state.currentPage + 1));
  els.pageNum.addEventListener("focus", () => els.pageNum.select());
  els.pageNum.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const n = parseInt(els.pageNum.value, 10);
      if (n) goToPage(n);
      els.viewer.focus({ preventScroll: true });
    } else if (e.key === "Escape") {
      els.viewer.focus({ preventScroll: true });
    }
  });
  els.pageNum.addEventListener("blur", () => { els.pageNum.value = String(state.currentPage); });

  els.zoom.addEventListener("change", () => {
    if (els.zoom.value !== "custom") setZoom(els.zoom.value);
    els.viewer.focus({ preventScroll: true });
  });
  els.zoomBtn.addEventListener("click", () => toggleZoomMenu());
  document.addEventListener("pointerdown", (e) => {
    if (!els.zoomMenu.hidden && !els.zoomMenu.contains(e.target) && !els.zoomBtn.contains(e.target)) toggleZoomMenu(false);
  });
  els.zoomMenu.addEventListener("keydown", (e) => {
    const items = [...els.zoomMenu.querySelectorAll("button")];
    const i = items.indexOf(document.activeElement);
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); toggleZoomMenu(false); els.zoomBtn.focus(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
  });
  els.zoomIn.addEventListener("click", () => stepZoom(1));
  els.zoomOut.addEventListener("click", () => stepZoom(-1));

  els.appearanceBtn.addEventListener("click", () => toggleAppearancePanel());
  document.addEventListener("pointerdown", (e) => {
    if (els.appearancePanel.hidden) return;
    if (!els.appearancePanel.contains(e.target) && !els.appearanceBtn.contains(e.target)) toggleAppearancePanel(false);
  });

  els.pickFile.addEventListener("click", openFromComputer);
  els.fileInput.addEventListener("change", () => {
    openLocalFile(els.fileInput.files[0]);
    els.fileInput.value = "";
  });
  els.download.addEventListener("click", () => toggleSavePanel());
  els.quickSave.addEventListener("click", quickSave);
  els.saveWithTheme.addEventListener("change", () => store.update({ saveWithTheme: els.saveWithTheme.checked }));
  for (const b of els.savePanel.querySelectorAll("[data-save]")) {
    b.addEventListener("click", () => savePdf(b.dataset.save));
  }
  document.addEventListener("pointerdown", (e) => {
    if (!els.savePanel.hidden && !els.savePanel.contains(e.target) && !els.download.contains(e.target)) toggleSavePanel(false);
  });
  els.printBtn.addEventListener("click", printWithTheme);
  els.sidebarBtn.addEventListener("click", () => toggleSidebar());
  els.searchBtn.addEventListener("click", () => toggleSearch());
  els.searchClose.addEventListener("click", () => toggleSearch(false));
  els.searchPrev.addEventListener("click", () => search.step(-1));
  els.searchNext.addEventListener("click", () => search.step(1));
  let searchTimer = 0;
  els.searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => search.find(els.searchInput.value), 250);
  });
  els.searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      clearTimeout(searchTimer);
      const q = els.searchInput.value;
      if (search.rawQuery !== q) search.find(q);
      else search.step(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      toggleSearch(false);
    }
  });
  els.highlightBtn.addEventListener("click", () => highlights.setMode("highlight"));
  els.eraseBtn.addEventListener("click", () => highlights.setMode("erase"));

  // Arrastar e soltar em qualquer lugar da janela
  let dragDepth = 0;
  window.addEventListener("dragenter", (e) => {
    if (!e.dataTransfer?.types.includes("Files")) return;
    dragDepth++;
    els.dropzone.classList.add("over");
  });
  window.addEventListener("dragleave", () => {
    if (--dragDepth <= 0) { dragDepth = 0; els.dropzone.classList.remove("over"); }
  });
  window.addEventListener("dragover", (e) => {
    if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
  });
  window.addEventListener("drop", (e) => {
    const file = e.dataTransfer?.files?.[0];
    // o "atalho" do arquivo precisa ser pedido durante o próprio evento de soltar
    const handlePromise = e.dataTransfer?.items?.[0]?.getAsFileSystemHandle?.();
    dragDepth = 0;
    els.dropzone.classList.remove("over");
    if (file) {
      e.preventDefault();
      Promise.resolve(handlePromise).catch(() => null)
        .then((h) => openLocalFile(file, h?.kind === "file" ? h : null));
    }
  });

  // Ctrl + roda do mouse = zoom
  els.viewer.addEventListener("wheel", (e) => {
    if (!e.ctrlKey || !state.pdf) return;
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.0025);
    setZoom(String(Math.min(MAX_SCALE, Math.max(MIN_SCALE, state.scale * factor))));
  }, { passive: false });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && highlights.mode && els.appearancePanel.hidden) {
      highlights.setMode(highlights.mode); // sai do marca-texto / apagador
      return;
    }
    if (e.key === "Escape" && !els.searchBar.hidden && els.appearancePanel.hidden) {
      toggleSearch(false);
      return;
    }
    if (e.key === "Escape" && !els.appearancePanel.hidden) {
      if (!appearance.back()) {   // na tela "Personalizado", Esc volta; senão fecha
        toggleAppearancePanel(false);
        els.appearanceBtn.focus();
      }
      return;
    }
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === "=" || e.key === "+")) { e.preventDefault(); stepZoom(1); return; }
    if (mod && e.key === "-") { e.preventDefault(); stepZoom(-1); return; }
    if (mod && e.key === "0") { e.preventDefault(); setZoom("auto"); return; }
    if (mod && e.key.toLowerCase() === "o") { e.preventDefault(); openFromComputer(); return; }
    if (e.key === "Escape" && !els.savePanel.hidden) { toggleSavePanel(false); els.download.focus(); return; }
    if (mod && e.key.toLowerCase() === "p") { e.preventDefault(); printWithTheme(); return; }
    if ((mod && e.key.toLowerCase() === "f") || e.key === "F3") {
      e.preventDefault();
      if (e.key === "F3" && !els.searchBar.hidden) search.step(e.shiftKey ? -1 : 1);
      else toggleSearch(true);
      return;
    }
    if (typing || mod || e.altKey) return;
    switch (e.key) {
      case "ArrowLeft":
        if (els.viewer.scrollWidth <= els.viewer.clientWidth) { e.preventDefault(); goToPage(state.currentPage - 1); }
        break;
      case "ArrowRight":
        if (els.viewer.scrollWidth <= els.viewer.clientWidth) { e.preventDefault(); goToPage(state.currentPage + 1); }
        break;
      case "d":
      case "D":
        store.update({ enabled: !store.settings.enabled });
        break;
      case "a":
      case "A":
        toggleAppearancePanel();
        break;
      case "h":
      case "H":
        highlights.setMode("highlight");
        break;
      case "e":
      case "E":
        highlights.setMode("erase");
        break;
    }
  });
}

// ===========================================================================
// Início
// ===========================================================================

async function init() {
  localize();
  els.zoom.insertBefore(new Option(t("zoomAuto"), "auto"), els.zoom.firstChild);
  els.zoom.value = "auto";
  syncZoomButton();
  store = await createSettingsStore(applySettings);
  appearance = mountAppearance(els.appearancePanel, store, { masterToggle: true });
  mountRateCard();
  buildHighlightPalette();
  applySettings();
  bindEvents();

  const fileUrl = getFileParam();
  if (fileUrl) {
    openDocument({ url: fileUrl, withCredentials: true }, { fileUrl, filename: filenameFromUrl(fileUrl) });
  } else {
    els.empty.hidden = false;
  }
}

// Ctrl+S / Ctrl+Shift+S: capturados antes de qualquer outro tratamento (inclusive dentro de
// campos de texto e enquanto o PDF ainda carrega), para o Edge nunca abrir o "salvar página".
window.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== "s") return;
  e.preventDefault();
  e.stopPropagation();
  if (e.repeat || !store) return;
  if (e.shiftKey) toggleSavePanel(true);
  else quickSave();
}, true);

init();
