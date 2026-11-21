// Exporta o PDF com o tema aplicado, mantendo-o vetorial:
// as cores de texto e desenhos são reescritas dentro dos fluxos de conteúdo do PDF
// usando a mesma fórmula do leitor (colormath.js). O texto continua selecionável
// e pesquisável e o tamanho do arquivo quase não muda.
//  - Fundo: um retângulo na cor do tema é pintado antes do conteúdo de cada página.
//  - Imagens: mantêm as cores (com o mesmo leve escurecimento do leitor) ou, se a
//    opção estiver desligada / for página escaneada, são invertidas com modos de mistura.
//  - Degradês (sh) são escurecidos com modos de mistura.
import {
  PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFRawStream, PDFNumber,
  PDFString, PDFHexString, decodePDFRawStream, EncryptedPDFError,
} from "../lib/pdf-lib.esm.min.js";
import { colorPipeline, mapColor } from "./colormath.js";
import { warmFactors } from "../settings.js";

const N = (s) => PDFName.of(s);
const SCAN_COVERAGE = 0.7;
const GS = { diff: "PDDarkDiff", mul: "PDDarkMul", light: "PDDarkLight", hue: "PDDarkHue", sat: "PDDarkSat" };

export class ProtectedPdfError extends Error {}

// Marca gravada no PDF salvo com o tema, para o leitor não escurecê-lo de novo
export const THEMED_KEY = "PDFDarkMode";

/**
 * @param {Uint8Array} bytes PDF original
 * @param {object} settings configurações atuais
 * @param {{ highlights?: { page: number, color: string, rects: number[][] }[] }} [extra]
 *   marcações do marca-texto (coordenadas do PDF) para gravar nas páginas
 * @returns {Promise<Uint8Array>} PDF com o tema
 */
export async function exportThemedPdf(bytes, settings, { highlights = [] } = {}) {
  const p = colorPipeline(settings);
  let recolor = p.enabled || p.warmText > 0;
  if (!recolor && !highlights.length) return bytes; // nada a mudar

  let doc;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (err) {
    if (err instanceof EncryptedPDFError || /encrypt/i.test(err?.message)) throw new ProtectedPdfError();
    throw err;
  }

  // Arquivo já salvo com o tema: não escurece de novo (só grava as marcações)
  const info = doc.getInfoDict();
  const alreadyThemed = !!info.get(N(THEMED_KEY));
  if (alreadyThemed) recolor = false;
  if (!recolor && !highlights.length) return bytes;
  if (recolor) info.set(N(THEMED_KEY), PDFString.of(p.theme?.label || "1"));

  const ctx = doc.context;
  const fg = mapColor(p, [0, 0, 0]);
  const bg = mapColor(p, [1, 1, 1]);
  const look = {
    p,
    fg,
    bg,
    preserve: p.enabled && settings.preserveImages,
    // multiplicador das imagens: escurecimento leve + luz azul (ou só luz azul no modo Original)
    imageMul: p.enabled ? p.image : warmFactors(p.warmText),
  };

  const doneForms = new Set();
  const doneShadings = new Map(); // dict de degradê → conseguiu converter?
  const oldContentRefs = new Set();

  const pagesList = doc.getPages();
  for (let pageIndex = 0; pageIndex < pagesList.length; pageIndex++) {
    const page = pagesList[pageIndex];
    const node = page.node;
    let resources = node.Resources();
    if (!resources) {
      resources = ctx.obj({});
      node.set(N("Resources"), resources);
    }
    const box = page.getMediaBox();
    const pageArea = Math.abs(box.width * box.height) || 1;

    const pageHls = highlights.filter((h) => h.page === pageIndex + 1);
    if (!recolor) {
      // só marcações: mantém o conteúdo original (isolado em q … Q) e acrescenta as marcações
      if (pageHls.length) {
        node.wrapContentStreams(ctx.register(ctx.flateStream(ascii("q\n"))), ctx.register(ctx.flateStream(ascii("\nQ\n"))));
        node.addContentStream(ctx.register(ctx.flateStream(ascii(highlightOps(pageHls, resources, ctx, alreadyThemed)))));
      }
      continue;
    }

    // Conteúdo original (pode ser um fluxo ou uma lista de fluxos)
    const contentsRaw = node.get(N("Contents"));
    const parts = [];
    const collect = (obj) => {
      if (obj instanceof PDFRef) oldContentRefs.add(obj);
      const s = ctx.lookup(obj);
      if (s instanceof PDFRawStream) parts.push(decodeStream(s));
    };
    if (contentsRaw instanceof PDFArray) contentsRaw.asArray().forEach(collect);
    else if (contentsRaw) collect(contentsRaw);
    const original = concatBytes(parts);

    const env = { ctx, look, pageArea, pageBox: box, doneForms, doneShadings };
    const rewritten = rewriteContent(original, resources, [1, 0, 0, 1, 0, 0], env);

    // Fundo da página + cor inicial (preto → cor das letras)
    const pre =
      `q ${rgb(bg)} rg ${num(box.x)} ${num(box.y)} ${num(box.width)} ${num(box.height)} re f Q\n` +
      `${rgb(fg)} rg ${rgb(fg)} RG\n`;
    // q … Q isola o conteúdo original (pode terminar com a matriz alterada)
    const post = `\nQ\n${pageHls.length ? highlightOps(pageHls, resources, ctx, p.enabled) : ""}`;
    const stream = ctx.flateStream(concatBytes([ascii(`${pre}q\n`), rewritten, ascii(post)]));
    node.set(N("Contents"), ctx.register(stream));

    // Aparência das anotações (campos de formulário, carimbos, notas…)
    const annots = node.lookup(N("Annots"));
    if (annots instanceof PDFArray) {
      for (let i = 0; i < annots.size(); i++) {
        const a = annots.lookup(i);
        if (!(a instanceof PDFDict)) continue;
        const ap = a.lookup(N("AP"));
        if (!(ap instanceof PDFDict)) continue;
        const normal = ap.get(N("N"));
        const normalObj = ctx.lookup(normal);
        if (normalObj instanceof PDFRawStream && normal instanceof PDFRef) {
          rewriteForm(normal, resources, [1, 0, 0, 1, 0, 0], env);
        } else if (normalObj instanceof PDFDict) {
          for (const [, ref] of normalObj.entries()) {
            if (ref instanceof PDFRef && ctx.lookup(ref) instanceof PDFRawStream) {
              rewriteForm(ref, resources, [1, 0, 0, 1, 0, 0], env);
            }
          }
        }
      }
    }
  }

  for (const ref of oldContentRefs) ctx.delete(ref);
  return doc.save({ useObjectStreams: true });
}

// ===========================================================================
// Reescrita de um fluxo de conteúdo
// ===========================================================================

function rewriteForm(ref, parentResources, ctm, env) {
  if (env.doneForms.has(ref)) return;
  env.doneForms.add(ref);
  const { ctx } = env;
  const stream = ctx.lookup(ref);
  if (!(stream instanceof PDFRawStream)) return;
  let data;
  try { data = decodeStream(stream); } catch { return; }

  let resources = stream.dict.lookup(N("Resources"));
  if (!(resources instanceof PDFDict)) resources = parentResources;
  const matrix = numbersOf(stream.dict.lookup(N("Matrix"))) ?? [1, 0, 0, 1, 0, 0];
  const out = rewriteContent(data, resources, matMul(matrix, ctm), env);

  const fresh = ctx.flateStream(out);
  for (const [key, value] of stream.dict.entries()) {
    const k = key.asString();
    if (k === "/Filter" || k === "/DecodeParms" || k === "/Length" || k === "/DL") continue;
    fresh.dict.set(key, value);
  }
  ctx.assign(ref, fresh);
}

function rewriteContent(bytes, resources, baseCtm, env) {
  const { look } = env;
  const out = [];
  let copied = 0;
  const replace = (start, end, text) => {
    out.push(bytes.subarray(copied, start), ascii(text));
    copied = end;
  };
  const append = (end, text) => {
    out.push(bytes.subarray(copied, end), ascii(text));
    copied = end;
  };

  const csCache = new Map();
  const resolveCS = (operand) => {
    if (!operand || operand.type !== "name") return { kind: "unknown" };
    if (!csCache.has(operand.value)) csCache.set(operand.value, colorSpaceFromName(operand.value, resources, env.ctx));
    return csCache.get(operand.value);
  };

  let state = { fill: CS_GRAY, stroke: CS_GRAY, ctm: baseCtm };
  const stack = [];
  let gsReady = false;
  const useGS = () => {
    if (!gsReady) { ensureBlendStates(resources, env.ctx); gsReady = true; }
  };

  // Depois de desenhar uma imagem: mantém as cores (escurecimento leve) ou escurece.
  // xname: nome da imagem, para redesenhá-la no modo "Matiz" e devolver o tom original.
  const imagePost = (isScanLike, xname) => {
    if (!look.p.enabled) return mulOps(look.imageMul, useGS);
    if (look.preserve && !isScanLike) return mulOps(look.imageMul, useGS);
    useGS();
    // inverter o brilho + mapear para as cores do tema
    let ops = ` q 0 0 1 1 re W n /${GS.diff} gs 1 1 1 rg 0 0 1 1 re f`;
    if (look.p.mono) ops += ` /${GS.sat} gs 0.5 0.5 0.5 rg 0 0 1 1 re f`; // tons de cinza
    ops += ` /${GS.mul} gs ${rgb(look.fg)} rg 0 0 1 1 re f` +
      ` /${GS.light} gs ${rgb(look.bg)} rg 0 0 1 1 re f Q `;
    if (!look.p.mono && xname) ops += `q /${GS.hue} gs /${escapeName(xname)} Do Q `; // tom original
    return ops;
  };
  const coverage = () => {
    const [x0, y0, x1, y1] = bboxOfUnitSquare(state.ctm);
    return ((x1 - x0) * (y1 - y0)) / env.pageArea;
  };

  for (const op of parseOperators(bytes)) {
    const { name, operands, start, end } = op;
    switch (name) {
      case "q":
        stack.push(state);
        state = { ...state };
        break;
      case "Q":
        state = stack.pop() ?? state;
        break;
      case "cm": {
        const m = operands.map((o) => o.value);
        if (m.length === 6 && m.every((v) => typeof v === "number")) state.ctm = matMul(m, state.ctm);
        break;
      }
      case "g": case "G": case "rg": case "RG": case "k": case "K": {
        const comps = operands.map((o) => o.value);
        if (!comps.every((v) => typeof v === "number")) break;
        const c = name.toLowerCase() === "g" ? [comps[0], comps[0], comps[0]]
          : name.toLowerCase() === "rg" ? comps
          : cmykToRgb(comps);
        const stroke = name === name.toUpperCase();
        if (stroke) state.stroke = name === "G" ? CS_GRAY : name === "RG" ? CS_RGB : CS_CMYK;
        else state.fill = name === "g" ? CS_GRAY : name === "rg" ? CS_RGB : CS_CMYK;
        replace(start, end, `${rgb(mapColor(look.p, c))} ${stroke ? "RG" : "rg"}`);
        break;
      }
      case "cs": case "CS": {
        const cs = resolveCS(operands[0]);
        if (name === "cs") state.fill = cs; else state.stroke = cs;
        const initial = initialColor(cs);
        if (initial) append(end, ` ${rgb(mapColor(look.p, initial))} ${name === "CS" ? "RG" : "rg"}`);
        break;
      }
      case "sc": case "scn": case "SC": case "SCN": {
        const stroke = name[0] === "S";
        const cs = stroke ? state.stroke : state.fill;
        if (operands.some((o) => o.type !== "number")) {   // padrão (pattern)
          const pname = operands.at(-1)?.type === "name" ? operands.at(-1).value : null;
          if (pname) convertPattern(pname, resources, state.ctm, env);
          break;
        }
        const c = toRgb(cs, operands.map((o) => o.value));
        if (c) replace(start, end, `${rgb(mapColor(look.p, c))} ${stroke ? "RG" : "rg"}`);
        break;
      }
      case "Do": {
        const xname = operands[0]?.type === "name" ? operands[0].value : null;
        if (!xname) break;
        const xobjects = resources.lookup(N("XObject"));
        const ref = xobjects instanceof PDFDict ? xobjects.get(N(xname)) : null;
        const xo = ref ? env.ctx.lookup(ref) : null;
        if (!(xo instanceof PDFRawStream)) break;
        const subtype = xo.dict.lookup(N("Subtype"));
        if (subtype === N("Image")) {
          if (xo.dict.lookup(N("ImageMask"))?.asBoolean?.()) break; // estêncil: usa a cor de preenchimento
          append(end, imagePost(coverage() > SCAN_COVERAGE, xname));
        } else if (subtype === N("Form") && ref instanceof PDFRef) {
          rewriteForm(ref, resources, state.ctm, env);
        }
        break;
      }
      case "EI": { // imagem embutida (BI … ID … EI)
        if (!op.imageMask) append(end, imagePost(coverage() > SCAN_COVERAGE));
        break;
      }
      case "sh": { // degradê: converte as cores do degradê; se não der, escurece a área
        const shName = operands[0]?.type === "name" ? operands[0].value : null;
        const shadings = resources.lookup(N("Shading"));
        const shading = shName && shadings instanceof PDFDict ? shadings.lookup(N(shName)) : null;
        if (shading && convertShading(shading, env)) break;
        if (!look.p.enabled) break;
        useGS();
        const inv = invert(state.ctm);
        if (!inv) break;
        const b = env.pageBox;
        const [x0, y0, x1, y1] = bboxOfRect([b.x, b.y, b.x + b.width, b.y + b.height], inv);
        const r = `${num(x0)} ${num(y0)} ${num(x1 - x0)} ${num(y1 - y0)} re f`;
        append(end, ` q /${GS.diff} gs 1 1 1 rg ${r} /${GS.mul} gs ${rgb(look.fg)} rg ${r}` +
          ` /${GS.light} gs ${rgb(look.bg)} rg ${r} Q `);
        break;
      }
    }
  }
  out.push(bytes.subarray(copied));
  return concatBytes(out);
}

function mulOps(f, useGS) {
  if (f.every((v) => Math.abs(v - 1) < 1e-3)) return "";
  useGS();
  return ` q 0 0 1 1 re W n /${GS.mul} gs ${rgb(f)} rg 0 0 1 1 re f Q `;
}

// Marcações: translúcidas sobre a página escura; em modo "multiplicar" na página clara.
function highlightOps(list, resources, ctx, dark) {
  let ext = resources.lookup(N("ExtGState"));
  if (!(ext instanceof PDFDict)) {
    ext = ctx.obj({});
    resources.set(N("ExtGState"), ext);
  }
  const gsName = dark ? "PDDarkHl" : "PDDarkHlMul";
  if (!ext.has(N(gsName))) {
    ext.set(N(gsName), ctx.obj(dark
      ? { Type: "ExtGState", ca: 0.38, BM: "Normal" }
      : { Type: "ExtGState", ca: 0.5, BM: "Multiply" }));
  }
  let ops = `q /${gsName} gs\n`;
  for (const h of list) {
    const n = parseInt(h.color.slice(1), 16);
    ops += `${num((n >> 16) / 255)} ${num(((n >> 8) & 255) / 255)} ${num((n & 255) / 255)} rg\n`;
    for (const [x0, y0, x1, y1] of h.rects) ops += `${num(x0)} ${num(y0)} ${num(x1 - x0)} ${num(y1 - y0)} re f\n`;
  }
  return ops + "Q\n";
}

function ensureBlendStates(resources, ctx) {
  let ext = resources.lookup(N("ExtGState"));
  if (!(ext instanceof PDFDict)) {
    ext = ctx.obj({});
    resources.set(N("ExtGState"), ext);
  }
  const add = (name, bm) => {
    if (!ext.has(N(name))) ext.set(N(name), ctx.obj({ Type: "ExtGState", BM: bm, ca: 1, CA: 1 }));
  };
  add(GS.diff, "Difference");
  add(GS.mul, "Multiply");
  add(GS.light, "Lighten");
  add(GS.hue, "Hue");
  add(GS.sat, "Saturation");
}

// ===========================================================================
// Espaços de cor
// ===========================================================================

const CS_GRAY = { kind: "gray" };
const CS_RGB = { kind: "rgb" };
const CS_CMYK = { kind: "cmyk" };

function colorSpaceFromName(name, resources, ctx) {
  switch (name) {
    case "DeviceGray": case "G": case "CalGray": return CS_GRAY;
    case "DeviceRGB": case "RGB": return CS_RGB;
    case "DeviceCMYK": case "CMYK": return CS_CMYK;
    case "Pattern": return { kind: "pattern" };
  }
  const dict = resources.lookup(N("ColorSpace"));
  if (!(dict instanceof PDFDict)) return { kind: "unknown" };
  return colorSpaceFromObject(dict.lookup(N(name)), ctx, 0);
}

function colorSpaceFromObject(obj, ctx, depth) {
  if (depth > 4 || !obj) return { kind: "unknown" };
  if (obj instanceof PDFName) return colorSpaceFromName(obj.decodeText(), { lookup: () => null }, ctx);
  if (!(obj instanceof PDFArray) || obj.size() === 0) return { kind: "unknown" };
  const family = ctx.lookup(obj.get(0));
  const fam = family instanceof PDFName ? family.decodeText() : "";
  switch (fam) {
    case "CalGray": return CS_GRAY;
    case "CalRGB": return CS_RGB;
    case "Lab": return { kind: "lab" };
    case "ICCBased": {
      const s = obj.lookup(1);
      const n = s?.dict?.lookup(N("N"));
      const comps = n instanceof PDFNumber ? n.asNumber() : 3;
      return comps === 1 ? CS_GRAY : comps === 4 ? CS_CMYK : CS_RGB;
    }
    case "Indexed": case "I": {
      const base = colorSpaceFromObject(ctx.lookup(obj.get(1)), ctx, depth + 1);
      const lookup = obj.lookup(3);
      let table = null;
      try {
        if (lookup instanceof PDFString || lookup instanceof PDFHexString) table = lookup.asBytes();
        else if (lookup instanceof PDFRawStream) table = decodeStream(lookup);
      } catch {}
      return { kind: "indexed", base, table, n: componentsOf(base) };
    }
    case "Separation": {
      const sepName = obj.lookup(1);
      const fn = obj.lookup(3);
      return { kind: "sep", none: sepName instanceof PDFName && sepName.decodeText() === "None", fn: evaluator(fn),
        alt: colorSpaceFromObject(ctx.lookup(obj.get(2)), ctx, depth + 1) };
    }
    case "DeviceN": return { kind: "devicen" };
    case "Pattern": return { kind: "pattern" };
    default: return colorSpaceFromName(fam, { lookup: () => null }, ctx);
  }
}

function componentsOf(cs) {
  return cs.kind === "gray" ? 1 : cs.kind === "cmyk" ? 4 : 3;
}

// ===========================================================================
// Funções do PDF (usadas por cores especiais e degradês)
// ===========================================================================

function fnDict(fn) {
  if (fn instanceof PDFDict) return fn;
  if (fn instanceof PDFRawStream) return fn.dict;
  return null;
}

function fnType(fn) {
  return fnDict(fn)?.lookup(N("FunctionType"))?.asNumber?.();
}

// Devolve t → [componentes] para funções do tipo 2 (exponencial), 3 (por partes)
// e 4 (calculadora PostScript). Tipo 0 (amostrado) não é suportado.
function evaluator(fn, depth = 0) {
  const d = fnDict(fn);
  if (!d || depth > 4) return null;
  const domain = numbersOf(d.lookup(N("Domain"))) ?? [0, 1];
  const clampIn = (t) => Math.min(domain[1], Math.max(domain[0], t));
  switch (fnType(fn)) {
    case 2: {
      const c0 = numbersOf(d.lookup(N("C0"))) ?? [0];
      const c1 = numbersOf(d.lookup(N("C1"))) ?? [1];
      const n = d.lookup(N("N"))?.asNumber?.() ?? 1;
      return (t) => c0.map((v, i) => v + Math.pow(clampIn(t), n) * (c1[i] - v));
    }
    case 3: {
      const fns = d.lookup(N("Functions"));
      if (!(fns instanceof PDFArray)) return null;
      const subs = fns.asArray().map((_, i) => evaluator(fns.lookup(i), depth + 1));
      if (subs.some((f) => !f)) return null;
      const bounds = numbersOf(d.lookup(N("Bounds"))) ?? [];
      const encode = numbersOf(d.lookup(N("Encode"))) ?? [];
      return (t) => {
        t = clampIn(t);
        let k = 0;
        while (k < bounds.length && t >= bounds[k]) k++;
        const lo = k === 0 ? domain[0] : bounds[k - 1];
        const hi = k === bounds.length ? domain[1] : bounds[k];
        const e0 = encode[2 * k] ?? 0, e1 = encode[2 * k + 1] ?? 1;
        const u = hi === lo ? e0 : e0 + ((t - lo) * (e1 - e0)) / (hi - lo);
        return subs[k](u);
      };
    }
    case 4: {
      if (!(fn instanceof PDFRawStream)) return null;
      let program;
      try {
        const src = decodeStream(fn);
        program = parsePostScript(latin1(src, 0, src.length));
      } catch { return null; }
      const range = numbersOf(d.lookup(N("Range")));
      return (t) => {
        const out = runPostScript(program, [clampIn(t)]);
        if (!out) return [0];
        return range ? out.map((v, i) => Math.min(range[2 * i + 1] ?? v, Math.max(range[2 * i] ?? v, v))) : out;
      };
    }
    default:
      return null;
  }
}

// Calculadora PostScript (subconjunto da especificação de funções tipo 4).
function parsePostScript(src) {
  const tokens = src.match(/[{}]|[^\s{}]+/g) ?? [];
  let i = 0;
  const block = () => {
    const out = [];
    while (i < tokens.length) {
      const t = tokens[i++];
      if (t === "{") out.push(block());
      else if (t === "}") return out;
      else out.push(isNaN(+t) ? t : +t);
    }
    return out;
  };
  const root = block();
  return Array.isArray(root[0]) ? root[0] : root;
}

function runPostScript(program, input) {
  const st = [...input];
  let steps = 0;
  const pop = () => st.pop();
  const exec = (code) => {
    for (let k = 0; k < code.length; k++) {
      if (++steps > 10000) throw new Error("ps");
      const t = code[k];
      if (typeof t === "number" || typeof t === "boolean") { st.push(t); continue; }
      if (Array.isArray(t)) {
        const next = code[k + 1];
        if (next === "if") { const c = pop(); if (c) exec(t); k++; }
        else if (Array.isArray(next) && code[k + 2] === "ifelse") { const c = pop(); exec(c ? t : next); k += 2; }
        continue;
      }
      let a, b;
      switch (t) {
        case "add": b = pop(); a = pop(); st.push(a + b); break;
        case "sub": b = pop(); a = pop(); st.push(a - b); break;
        case "mul": b = pop(); a = pop(); st.push(a * b); break;
        case "div": b = pop(); a = pop(); st.push(b === 0 ? 0 : a / b); break;
        case "idiv": b = pop(); a = pop(); st.push(b === 0 ? 0 : Math.trunc(a / b)); break;
        case "mod": b = pop(); a = pop(); st.push(b === 0 ? 0 : a % b); break;
        case "neg": st.push(-pop()); break;
        case "abs": st.push(Math.abs(pop())); break;
        case "ceiling": st.push(Math.ceil(pop())); break;
        case "floor": st.push(Math.floor(pop())); break;
        case "round": st.push(Math.round(pop())); break;
        case "truncate": case "cvi": st.push(Math.trunc(pop())); break;
        case "cvr": break;
        case "sqrt": st.push(Math.sqrt(pop())); break;
        case "sin": st.push(Math.sin((pop() * Math.PI) / 180)); break;
        case "cos": st.push(Math.cos((pop() * Math.PI) / 180)); break;
        case "atan": b = pop(); a = pop(); st.push(((Math.atan2(a, b) * 180) / Math.PI + 360) % 360); break;
        case "exp": b = pop(); a = pop(); st.push(Math.pow(a, b)); break;
        case "ln": st.push(Math.log(pop())); break;
        case "log": st.push(Math.log10(pop())); break;
        case "eq": b = pop(); a = pop(); st.push(a === b); break;
        case "ne": b = pop(); a = pop(); st.push(a !== b); break;
        case "gt": b = pop(); a = pop(); st.push(a > b); break;
        case "ge": b = pop(); a = pop(); st.push(a >= b); break;
        case "lt": b = pop(); a = pop(); st.push(a < b); break;
        case "le": b = pop(); a = pop(); st.push(a <= b); break;
        case "and": b = pop(); a = pop(); st.push(typeof a === "boolean" ? a && b : a & b); break;
        case "or": b = pop(); a = pop(); st.push(typeof a === "boolean" ? a || b : a | b); break;
        case "xor": b = pop(); a = pop(); st.push(typeof a === "boolean" ? a !== b : a ^ b); break;
        case "not": a = pop(); st.push(typeof a === "boolean" ? !a : ~a); break;
        case "bitshift": b = pop(); a = pop(); st.push(b >= 0 ? a << b : a >> -b); break;
        case "true": st.push(true); break;
        case "false": st.push(false); break;
        case "dup": st.push(st.at(-1)); break;
        case "exch": b = pop(); a = pop(); st.push(b, a); break;
        case "pop": pop(); break;
        case "copy": { const n = pop(); st.push(...st.slice(st.length - n)); break; }
        case "index": { const n = pop(); st.push(st[st.length - 1 - n]); break; }
        case "roll": {
          const j = pop(), n = pop();
          if (n > 0) {
            const part = st.splice(st.length - n, n);
            const shift = ((j % n) + n) % n;
            st.push(...part.slice(n - shift), ...part.slice(0, n - shift));
          }
          break;
        }
        default: throw new Error(`ps: ${t}`);
      }
    }
  };
  try { exec(program); } catch { return null; }
  return st.map(Number);
}

// ===========================================================================
// Degradês e padrões
// ===========================================================================

// Converte as cores de um degradê (tipos 1–3, definidos por função) no próprio dicionário.
// Amostra a função original, mapeia cada cor pelo tema e grava uma função por partes em RGB.
function convertShading(shading, env) {
  const dict = shading instanceof PDFRawStream ? shading.dict : shading;
  if (!(dict instanceof PDFDict)) return false;
  if (env.doneShadings.has(dict)) return env.doneShadings.get(dict);
  let ok = false;
  try {
    const type = dict.lookup(N("ShadingType"))?.asNumber?.();
    const fnObj = dict.lookup(N("Function"));
    const cs = colorSpaceFromObject(dict.lookup(N("ColorSpace")), env.ctx, 0);
    if (type >= 1 && type <= 3 && fnObj && !(fnObj instanceof PDFArray) && cs.kind !== "unknown") {
      const f = evaluator(fnObj);
      const domain = type === 1 ? null : numbersOf(dict.lookup(N("Domain"))) ?? [0, 1];
      if (f && domain) {
        const SAMPLES = 16;
        const pts = [];
        for (let k = 0; k <= SAMPLES; k++) {
          const t = domain[0] + ((domain[1] - domain[0]) * k) / SAMPLES;
          const c = toRgb(cs, f(t));
          if (!c) throw new Error("cor");
          pts.push(mapColor(env.look.p, c));
        }
        const ctx = env.ctx;
        const segs = [];
        const bounds = [];
        const encode = [];
        for (let k = 0; k < SAMPLES; k++) {
          segs.push(ctx.obj({ FunctionType: 2, Domain: [0, 1], C0: pts[k], C1: pts[k + 1], N: 1 }));
          if (k > 0) bounds.push(domain[0] + ((domain[1] - domain[0]) * k) / SAMPLES);
          encode.push(0, 1);
        }
        dict.set(N("Function"), ctx.obj({ FunctionType: 3, Domain: domain, Functions: segs, Bounds: bounds, Encode: encode }));
        dict.set(N("ColorSpace"), N("DeviceRGB"));
        dict.delete(N("Background"));
        ok = true;
      }
    }
  } catch { ok = false; }
  env.doneShadings.set(dict, ok);
  return ok;
}

function convertPattern(name, resources, ctm, env) {
  const patterns = resources.lookup(N("Pattern"));
  if (!(patterns instanceof PDFDict)) return;
  const ref = patterns.get(N(name));
  const pat = env.ctx.lookup(ref);
  const dict = pat instanceof PDFRawStream ? pat.dict : pat;
  if (!(dict instanceof PDFDict)) return;
  const type = dict.lookup(N("PatternType"))?.asNumber?.();
  if (type === 2) {
    const shading = dict.lookup(N("Shading"));
    if (shading) convertShading(shading, env);
  } else if (type === 1 && ref instanceof PDFRef && dict.lookup(N("PaintType"))?.asNumber?.() === 1) {
    rewriteForm(ref, resources, ctm, env); // ladrilho colorido: tem conteúdo próprio
  }
}

function initialColor(cs) {
  switch (cs.kind) {
    case "gray": case "rgb": case "cmyk": case "lab": return [0, 0, 0];
    case "indexed": return toRgb(cs, [0]);
    case "sep": return toRgb(cs, [1]);
    case "devicen": return [0, 0, 0];
    default: return null;
  }
}

function toRgb(cs, comps) {
  switch (cs.kind) {
    case "gray": return [comps[0], comps[0], comps[0]];
    case "rgb": return comps.length >= 3 ? comps.slice(0, 3) : null;
    case "cmyk": return comps.length >= 4 ? cmykToRgb(comps) : null;
    case "lab": { const l = (comps[0] ?? 0) / 100; return [l, l, l]; }
    case "indexed": {
      if (!cs.table) return null;
      const i = Math.round(comps[0] ?? 0) * cs.n;
      const v = Array.from(cs.table.subarray(i, i + cs.n), (b) => b / 255);
      return v.length === cs.n ? toRgb(cs.base, v) : null;
    }
    case "sep": {
      if (cs.none) return null;
      const t = comps[0] ?? 1;
      if (cs.fn && cs.alt.kind !== "unknown") {
        const alt = toRgb(cs.alt, cs.fn(t));
        if (alt) return alt;
      }
      return [1 - t, 1 - t, 1 - t]; // aproximação: tinta escura
    }
    case "devicen": {
      const t = Math.min(1, comps.reduce((a, b) => a + b, 0));
      return [1 - t, 1 - t, 1 - t];
    }
    default: return null;
  }
}

function cmykToRgb([c, m, y, k]) {
  return [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)];
}

// ===========================================================================
// Leitor de operadores do fluxo de conteúdo
// ===========================================================================

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]); // ( ) < > [ ] { } / %
const NUM_RE = /^[+-]?(\d+\.?\d*|\.\d+)$/;

/**
 * Gera { name, operands, start, end } para cada operador.
 * operands: { type: "number" | "name" | "other", value, start }
 * start = início do primeiro operando (ou do operador), end = fim do operador.
 */
function* parseOperators(b) {
  const len = b.length;
  let i = 0;
  let operands = [];
  let depth = 0;          // dentro de [ ] ou << >>
  let compositeStart = -1;

  const pushOperand = (o) => { if (depth === 0) operands.push(o); };

  while (i < len) {
    const c = b[i];
    if (WS.has(c)) { i++; continue; }
    if (c === 37) { // % comentário
      while (i < len && b[i] !== 10 && b[i] !== 13) i++;
      continue;
    }
    const tokStart = i;
    if (c === 40) { // ( string )
      let level = 0;
      for (; i < len; i++) {
        if (b[i] === 92) { i++; continue; }
        if (b[i] === 40) level++;
        else if (b[i] === 41 && --level === 0) { i++; break; }
      }
      pushOperand({ type: "other", start: tokStart });
      continue;
    }
    if (c === 60) {
      if (b[i + 1] === 60) { // <<
        if (depth++ === 0) compositeStart = tokStart;
        i += 2;
        continue;
      }
      while (i < len && b[i] !== 62) i++; // <hex>
      i++;
      pushOperand({ type: "other", start: tokStart });
      continue;
    }
    if (c === 62) { // >>
      i += b[i + 1] === 62 ? 2 : 1;
      if (depth > 0 && --depth === 0) operands.push({ type: "other", start: compositeStart });
      continue;
    }
    if (c === 91 || c === 123) { if (depth++ === 0) compositeStart = tokStart; i++; continue; }
    if (c === 93 || c === 125) {
      i++;
      if (depth > 0 && --depth === 0) operands.push({ type: "other", start: compositeStart });
      continue;
    }
    if (c === 47) { // /Nome
      i++;
      while (i < len && !WS.has(b[i]) && !DELIM.has(b[i])) i++;
      pushOperand({ type: "name", value: decodeName(b, tokStart + 1, i), start: tokStart });
      continue;
    }
    // número ou palavra-chave
    while (i < len && !WS.has(b[i]) && !DELIM.has(b[i])) i++;
    if (i === tokStart) { i++; continue; } // caractere solto inválido
    const word = latin1(b, tokStart, i);
    if (NUM_RE.test(word)) { pushOperand({ type: "number", value: parseFloat(word), start: tokStart }); continue; }
    if (depth > 0 || word === "true" || word === "false" || word === "null") {
      pushOperand({ type: "other", start: tokStart });
      continue;
    }

    if (word === "BI") {
      // imagem embutida: BI <pares chave/valor> ID <dados> EI
      const opStart = operands[0]?.start ?? tokStart;
      let imageMask = false;
      let j = i;
      // procura "ID" como palavra isolada e registra /IM true ou /ImageMask true
      const dictEnd = findInlineID(b, j);
      if (dictEnd < 0) { i = len; break; }
      const dictText = latin1(b, j, dictEnd);
      imageMask = /\/(IM|ImageMask)\s+true/.test(dictText);
      j = dictEnd + 2; // depois de "ID"
      j++;             // um espaço em branco depois de ID
      const ei = findInlineEI(b, j);
      i = ei < 0 ? len : ei + 2;
      yield { name: "EI", operands: [], start: opStart, end: i, imageMask };
      operands = [];
      continue;
    }

    yield { name: word, operands, start: operands[0]?.start ?? tokStart, end: i };
    operands = [];
  }
}

function findInlineID(b, from) {
  for (let i = from; i < b.length - 1; i++) {
    if (b[i] === 73 && b[i + 1] === 68 && (i === 0 || WS.has(b[i - 1]) || DELIM.has(b[i - 1]))
        && (i + 2 >= b.length || WS.has(b[i + 2]))) return i;
  }
  return -1;
}

function findInlineEI(b, from) {
  for (let i = from; i < b.length - 1; i++) {
    if (b[i] === 69 && b[i + 1] === 73 && i > 0 && WS.has(b[i - 1])
        && (i + 2 >= b.length || WS.has(b[i + 2]) || DELIM.has(b[i + 2]))) return i;
  }
  return -1;
}

function escapeName(name) {
  return name.replace(/[^!-~]|[#()<>\[\]{}\/%]/g, (ch) => "#" + ch.charCodeAt(0).toString(16).padStart(2, "0"));
}

function decodeName(b, s, e) {
  return latin1(b, s, e).replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

// ===========================================================================
// Utilitários
// ===========================================================================

function decodeStream(stream) {
  return decodePDFRawStream(stream).decode();
}

function numbersOf(arr) {
  if (!(arr instanceof PDFArray)) return null;
  const v = arr.asArray().map((x) => (x instanceof PDFNumber ? x.asNumber() : NaN));
  return v.every(Number.isFinite) ? v : null;
}

function latin1(b, s, e) {
  let str = "";
  for (let i = s; i < e; i++) str += String.fromCharCode(b[i]);
  return str;
}

const encoder = new TextEncoder();
function ascii(s) { return encoder.encode(s); }

function concatBytes(parts) {
  let total = 0;
  for (const p of parts) total += p.length + 1;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; out[o++] = 10; }
  return out;
}

function num(v) {
  const s = (+v.toFixed(4)).toString();
  return s === "-0" ? "0" : s;
}
function rgb(c) { return c.map(num).join(" "); }

// [a b c d e f] — convenção do PDF (vetor linha): p' = p · m1 · m2
function matMul(m1, m2) {
  return [
    m1[0] * m2[0] + m1[1] * m2[2], m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2], m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4], m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}

function invert(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) return null;
  return [
    m[3] / det, -m[1] / det, -m[2] / det, m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det,
  ];
}

function bboxOfRect([x0, y0, x1, y1], m) {
  const pts = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(([x, y]) => [
    x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5],
  ]);
  const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function bboxOfUnitSquare(m) {
  return bboxOfRect([0, 0, 1, 1], m);
}
