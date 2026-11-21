// "Aplicar tema nessa guia": usado pelo botão do popup e pelo atalho Alt+Shift+D.
//  - PDF no leitor nativo do Edge → reabre no leitor escuro, na mesma guia.
//  - Leitor escuro → liga o modo escuro.
//  - Qualquer outra página → aplica (ou remove) o tema na própria página com um filtro de cor.
import { getSettings, setSettings, VIEWER_URL, viewerUrlFor } from "./settings.js";
import { colorPipeline, toSvgValues, MONO_CURVE_SLOPE } from "./viewer/colormath.js";

const PDF_URL = /\.pdf($|[?#])/i;

/** @returns {Promise<"viewer"|"pdf"|"applied"|"none"|"blocked">} */
export async function tabThemeState(tab) {
  const url = tab?.url || "";
  if (url.startsWith(VIEWER_URL)) return "viewer";
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({
        contentType: document.contentType,
        applied: !!document.getElementById("pdf-dark-theme"),
      }),
    });
    const info = res?.result;
    if (info?.contentType === "application/pdf") return "pdf";
    return info?.applied ? "applied" : "none";
  } catch {
    return PDF_URL.test(url) && /^(https?|file):/i.test(url) ? "pdf" : "blocked";
  }
}

/** Aplica o tema (ou remove, se já estiver aplicado). Devolve o novo estado. */
export async function applyThemeToTab(tab) {
  const state = await tabThemeState(tab);
  switch (state) {
    case "viewer": {
      const { enabled } = await getSettings();
      if (!enabled) await setSettings({ enabled: true });
      return "viewer";
    }
    case "pdf":
      await chrome.tabs.update(tab.id, { url: viewerUrlFor(tab.url) });
      return "opened";
    case "applied":
      await inject(tab.id, null);
      return "none";
    case "none":
      await inject(tab.id, buildPageTheme(await getSettings()));
      return "applied";
    default:
      return "blocked";
  }
}

function buildPageTheme(settings) {
  // Mesmo se o modo escuro estiver desligado, "aplicar tema" quer dizer escurecer.
  const p = colorPipeline({ ...settings, enabled: true });
  return {
    pre: toSvgValues(p.pre),
    curve: p.mono ? MONO_CURVE_SLOPE : null,
    matrix: toSvgValues(p.matrix),
    // Imagens: desfazem a inversão (ficam com as cores e tons naturais dentro da faixa do tema)
    keepImages: settings.preserveImages && !p.mono,
  };
}

function inject(tabId, theme) {
  return chrome.scripting.executeScript({ target: { tabId }, func: pageTheme, args: [theme] });
}

// Roda dentro da página.
function pageTheme(theme) {
  const ID = "pdf-dark-theme";
  document.getElementById(ID)?.remove();
  document.getElementById(`${ID}-svg`)?.remove();
  if (!theme) return;

  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.id = `${ID}-svg`;
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("style", "position:absolute;width:0;height:0;overflow:hidden");
  const filter = document.createElementNS(NS, "filter");
  filter.id = `${ID}-filter`;
  filter.setAttribute("color-interpolation-filters", "sRGB");
  const pre = document.createElementNS(NS, "feColorMatrix");
  pre.setAttribute("type", "matrix");
  pre.setAttribute("values", theme.pre);
  filter.append(pre);
  if (theme.curve) {
    const ct = document.createElementNS(NS, "feComponentTransfer");
    for (const c of ["R", "G", "B"]) {
      const fn = document.createElementNS(NS, `feFunc${c}`);
      fn.setAttribute("type", "linear");
      fn.setAttribute("slope", String(theme.curve));
      fn.setAttribute("intercept", "0");
      ct.append(fn);
    }
    filter.append(ct);
  }
  const main = document.createElementNS(NS, "feColorMatrix");
  main.setAttribute("type", "matrix");
  main.setAttribute("values", theme.matrix);
  filter.append(main);
  svg.append(filter);
  document.documentElement.append(svg);

  const style = document.createElement("style");
  style.id = ID;
  style.textContent =
    `html { filter: url(#${ID}-filter) !important; background-color: #fff !important; min-height: 100% !important; }` +
    (theme.keepImages
      ? `img, picture, video, canvas, svg image, [style*="background-image"] { filter: invert(1) hue-rotate(180deg) !important; }`
      : "");
  (document.head || document.documentElement).append(style);
}
