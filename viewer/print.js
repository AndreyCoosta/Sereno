// Impressão com a personalização: cada página é desenhada com o mesmo filtro de cores
// da tela (tema, luz azul, imagens preservadas) e com as marcações do marca-texto,
// e o resultado vai para a janela de impressão do navegador.

const PRINT_DPI = 150;
const MAX_PIXELS = 12_000_000;

/**
 * @param {{
 *   pdf: any, settings: object, pageBg: string,
 *   imageRects: (num: number, page: any) => Promise<number[][]>,
 *   highlights: (num: number) => { color: string, rects: number[][] }[],
 *   onProgress: (done: number, total: number) => void,
 *   cancelled: () => boolean,
 * }} o
 * @returns {Promise<boolean>} false se cancelado
 */
export async function printDocument(o) {
  const root = document.getElementById("printRoot");
  root.replaceChildren();
  const urls = [];
  const dark = o.settings.enabled;
  const filtered = dark || o.settings.blueLight > 0;
  const total = o.pdf.numPages;
  let printed = false;

  try {
    for (let num = 1; num <= total; num++) {
      if (o.cancelled()) return false;
      o.onProgress(num - 1, total);
      const page = await o.pdf.getPage(num);
      let scale = PRINT_DPI / 72;
      const base1 = page.getViewport({ scale: 1 });
      if (base1.width * base1.height * scale * scale > MAX_PIXELS) {
        scale = Math.sqrt(MAX_PIXELS / (base1.width * base1.height));
      }
      const vp = page.getViewport({ scale });
      const w = Math.floor(vp.width), h = Math.floor(vp.height);

      const src = document.createElement("canvas");
      src.width = w; src.height = h;
      await page.render({ canvasContext: src.getContext("2d", { alpha: true }), viewport: vp }).promise;

      const out = document.createElement("canvas");
      out.width = w; out.height = h;
      const ctx = out.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, w, h);
      ctx.filter = filtered ? "url(#pdf-page-filter)" : "none";
      ctx.drawImage(src, 0, 0);

      if (dark && o.settings.preserveImages) {
        ctx.filter = "url(#pdf-image-filter)";
        for (const [x0, y0, x1, y1] of await o.imageRects(num, page)) {
          const sx = Math.ceil(x0 * w), sy = Math.ceil(y0 * h);
          const sw = Math.min(w, Math.floor(x1 * w)) - sx, sh = Math.min(h, Math.floor(y1 * h)) - sy;
          const dx = Math.floor(x0 * w), dy = Math.floor(y0 * h);
          const dw = Math.min(w, Math.ceil(x1 * w)) - dx, dh = Math.min(h, Math.ceil(y1 * h)) - dy;
          if (sw > 0 && sh > 0) ctx.drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh);
        }
      }
      ctx.filter = "none";

      // marcações
      const hls = o.highlights(num);
      if (hls.length) {
        ctx.save();
        ctx.globalAlpha = dark ? 0.38 : 0.5;
        ctx.globalCompositeOperation = dark ? "source-over" : "multiply";
        for (const hl of hls) {
          ctx.fillStyle = hl.color;
          for (const r of hl.rects) {
            const [a, b, c, d] = vp.convertToViewportRectangle(r);
            ctx.fillRect(Math.min(a, c), Math.min(b, d), Math.abs(c - a), Math.abs(d - b));
          }
        }
        ctx.restore();
      }

      src.width = src.height = 0;
      const blob = await new Promise((res) => out.toBlob(res, "image/jpeg", 0.92));
      out.width = out.height = 0;
      const url = URL.createObjectURL(blob);
      urls.push(url);

      const sheet = document.createElement("div");
      sheet.className = "printPage";
      sheet.style.background = o.pageBg;
      const img = new Image();
      img.src = url;
      img.alt = "";
      sheet.append(img);
      root.append(sheet);
      await img.decode().catch(() => {});
      page.cleanup();
    }
    if (o.cancelled()) return false;
    o.onProgress(total, total);

    // tamanho do papel = tamanho da 1ª página (o navegador usa um só tamanho)
    const first = (await o.pdf.getPage(1)).getViewport({ scale: 1 });
    const style = document.createElement("style");
    style.id = "printPageSize";
    style.textContent = `@page { size: ${first.width}pt ${first.height}pt; margin: 0; }`;
    document.getElementById("printPageSize")?.remove();
    document.head.append(style);

    await new Promise((r) => setTimeout(r, 50));
    window.addEventListener("afterprint", cleanup, { once: true });
    window.print();
    printed = true;
    return true;
  } finally {
    if (!printed) cleanup();
  }

  function cleanup() {
    root.replaceChildren();
    urls.forEach((u) => URL.revokeObjectURL(u));
  }
}
