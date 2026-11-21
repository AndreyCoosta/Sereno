// Matemática de cores do modo escuro, usada:
//  - pelo leitor, como filtros SVG (feColorMatrix) sobre a página renderizada;
//  - pela exportação, para reescrever as cores dentro do próprio PDF.
// Matrizes 3×4: [r, g, b, deslocamento] por canal de saída.
import { resolveTheme, effectiveWarmth, warmFactors, hexToRgb } from "../settings.js";

export const IDENTITY = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]];

// Rotação de matiz de 180° (mesma matriz do CSS hue-rotate): depois de inverter,
// devolve a cada cor o seu tom original (vermelho continua avermelhado etc.).
const HUE_180 = [
  [-0.574, 1.43, 0.144],
  [0.426, 0.43, 0.144],
  [0.426, 1.43, -0.856],
];
const LUMA = [0.2126, 0.7152, 0.0722];

// Inverter → girar matiz → mapear branco para `bg` e preto para `fg`.
function darkMatrix(bgHex, fgHex) {
  const bg = hexToRgb(bgHex), fg = hexToRgb(fgHex);
  return [0, 1, 2].map((i) => {
    const d = fg[i] - bg[i];
    return [-d * HUE_180[i][0], -d * HUE_180[i][1], -d * HUE_180[i][2], fg[i]];
  });
}

// "Texto em uma só cor": 1º passo vira "tinta" (1 − luminância) nos 3 canais;
// a curva reforça a tinta (texto vermelho/azul fica tão forte quanto o preto);
// o último passo pinta a tinta com a cor das letras sobre a cor do fundo.
export const MONO_PRE = [0, 1, 2].map(() => [-LUMA[0], -LUMA[1], -LUMA[2], 1]);
export const MONO_CURVE_SLOPE = 1.7;
function toneMatrix(bgHex, fgHex) {
  const bg = hexToRgb(bgHex), fg = hexToRgb(fgHex);
  return [0, 1, 2].map((i) => [fg[i] - bg[i], 0, 0, bg[i]]);
}

export function scaleMatrix(f) {
  return [[f[0], 0, 0, 0], [0, f[1], 0, 0], [0, 0, f[2], 0]];
}

// A ∘ B (aplica B, depois A)
export function compose(A, B) {
  return A.map((row) => [0, 1, 2, 3].map((j) =>
    row[0] * B[0][j] + row[1] * B[1][j] + row[2] * B[2][j] + (j === 3 ? row[3] : 0)));
}

export function toSvgValues(M) {
  return M.map((r) => [r[0], r[1], r[2], 0, r[3]].map((v) => +v.toFixed(4)).join(" ")).join("  ") + "  0 0 0 1 0";
}

function applyMatrix(M, rgb) {
  return M.map((r) => r[0] * rgb[0] + r[1] * rgb[1] + r[2] * rgb[2] + r[3]);
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/**
 * Tudo o que define as cores para as configurações atuais.
 * pre → curva (só no modo "uma só cor") → matrix: cores do conteúdo (texto, desenhos, fundo)
 * image: multiplicador das imagens preservadas · ui: luz azul da interface
 */
export function colorPipeline(settings) {
  const theme = resolveTheme(settings);
  const warmText = effectiveWarmth(settings);
  const warmImages = effectiveWarmth(settings, { forImages: true });
  const mono = settings.enabled && settings.monoText;
  const page = !settings.enabled ? IDENTITY : mono ? toneMatrix(theme.bg, theme.fg) : darkMatrix(theme.bg, theme.fg);
  return {
    theme,
    enabled: settings.enabled,
    mono,
    warmText,
    warmImages,
    pre: mono ? MONO_PRE : IDENTITY,
    matrix: compose(scaleMatrix(warmFactors(warmText)), page),
    image: warmFactors(warmImages).map((f) => f * 0.88),
    ui: warmFactors(warmImages),
  };
}

// Aplica o pipeline a uma cor RGB (0–1), exatamente como o filtro SVG faz na tela.
export function mapColor(p, rgb) {
  let c = applyMatrix(p.pre, rgb).map(clamp01);
  if (p.mono) c = c.map((v) => clamp01(v * MONO_CURVE_SLOPE));
  return applyMatrix(p.matrix, c).map(clamp01);
}
