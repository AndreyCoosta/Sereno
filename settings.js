// Configurações compartilhadas entre background, popup e leitor.

import { t } from "./ui/i18n.js";

export const DEFAULTS = {
  enabled: true,        // modo escuro ligado no leitor
  theme: "dark",        // chave de THEMES ou "custom"
  preserveImages: true, // mantém as cores originais das fotos/figuras
  autoOpen: true,       // abre PDFs automaticamente no leitor escuro
  customFg: "#e6e6e6",  // cor das letras do tema personalizado
  customBg: "#1d1d1d",  // cor do papel do tema personalizado
  monoText: false,      // todo o texto na mesma cor (ignora cores originais do texto)
  blueLight: 0,         // redução de luz azul, 0–100
  presets: [null, null, null], // até 3 presets do tema personalizado
  saveWithTheme: true,  // Ctrl+S salva com o tema (sempre com as marcações)
};

export const MAX_PRESETS = 3;

// bg = cor do papel, fg = cor do texto, ui = fundo do leitor ao redor das páginas
// imageWarm = redução de luz azul aplicada às imagens preservadas (0–1)
export const THEMES = {
  dark:    { label: t("themeDark"),  bg: "#1d1d1d", fg: "#e6e6e6", ui: "#141414" },
  black:   { label: t("themeBlack"),   bg: "#000000", fg: "#d8d8d8", ui: "#1a1a1a" },
  reading: { label: t("themeReading"), bg: "#1b1510", fg: "#eec48c", ui: "#100c08", imageWarm: 0.8,
             hint: t("readingHint") },
  sepia:   { label: t("themeSepia"),   bg: "#2a241d", fg: "#eadbc4", ui: "#17130f" },
  gray:    { label: t("themeGray"),   bg: "#3a3d43", fg: "#f2f2f2", ui: "#24262a" },
};

export const TEXT_PRESETS = [
  ["#ffffff", t("cWhite")],
  ["#e6e6e6", t("cSoftWhite")],
  ["#c4c8ce", t("cLightGray")],
  ["#f3e5c8", t("cCream")],
  ["#eec48c", t("cAmber")],
  ["#ffd166", t("colorYellow")],
  ["#a6e3a1", t("colorGreen")],
];

export const BG_PRESETS = [
  ["#000000", t("cBlack")],
  ["#141414", t("cCharcoal")],
  ["#1d1d1d", t("cGraphite")],
  ["#1b1510", t("cCoffee")],
  ["#2a241d", t("themeSepia")],
  ["#0f1f17", t("cDarkGreen")],
  ["#14213d", t("cNavy")],
];

export async function getSettings() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  if (s.theme !== "custom" && !THEMES[s.theme]) s.theme = DEFAULTS.theme;
  s.presets = Array.from({ length: MAX_PRESETS }, (_, i) => normalizePreset(s.presets?.[i]));
  return s;
}

export function setSettings(patch) {
  return chrome.storage.sync.set(patch);
}

// Guarda as configurações em memória, aplica mudanças na hora e salva com
// atraso opcional (seletores de cor e controles deslizantes disparam muitos eventos;
// o chrome.storage.sync tem limite de gravações por minuto).
export async function createSettingsStore(onChange) {
  const settings = await getSettings();
  let pending = {};
  let timer = 0;

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    let changed = false;
    for (const [key, { newValue }] of Object.entries(changes)) {
      if (!(key in DEFAULTS) || key in pending) continue;
      settings[key] = key === "presets"
        ? Array.from({ length: MAX_PRESETS }, (_, i) => normalizePreset(newValue?.[i]))
        : newValue ?? DEFAULTS[key];
      changed = true;
    }
    if (changed) onChange(settings);
  });

  function flush() {
    clearTimeout(timer);
    const patch = pending;
    pending = {};
    if (Object.keys(patch).length) chrome.storage.sync.set(patch);
  }

  function update(patch, { debounce = false } = {}) {
    Object.assign(settings, patch);
    Object.assign(pending, patch);
    onChange(settings);
    clearTimeout(timer);
    if (debounce) timer = setTimeout(flush, 400);
    else flush();
  }

  addEventListener("pagehide", flush);
  return { settings, update, flush };
}

// Preset salvo: { name, fg, bg, monoText, blueLight } ou null (espaço vazio)
const HEX = /^#[0-9a-f]{6}$/i;
export function normalizePreset(p) {
  if (!p || !HEX.test(p.fg) || !HEX.test(p.bg)) return null;
  return {
    name: String(p.name || "").slice(0, 24),
    fg: p.fg.toLowerCase(),
    bg: p.bg.toLowerCase(),
    monoText: !!p.monoText,
    blueLight: Math.min(100, Math.max(0, Number(p.blueLight) || 0)),
  };
}

// ---------- Cores ----------

export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function rgbToHex(rgb) {
  return "#" + rgb.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0")).join("");
}

function mix(a, b, t) {
  const A = hexToRgb(a), B = hexToRgb(b);
  return rgbToHex(A.map((v, i) => v + (B[i] - v) * t));
}

function luminance(hex) {
  const lin = hexToRgb(hex).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

export function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// Redução de luz azul: mantém o vermelho, reduz um pouco o verde e bastante o azul.
export function warmFactors(t) {
  return [1, 1 - 0.25 * t, 1 - 0.65 * t];
}

export function warmHex(hex, t) {
  const f = warmFactors(t);
  return rgbToHex(hexToRgb(hex).map((v, i) => v * f[i]));
}

// Tema efetivo, incluindo o personalizado.
export function resolveTheme(s) {
  if (s.theme === "custom") {
    const bg = s.customBg, fg = s.customFg;
    const ui = luminance(bg) < 0.01 ? mix(bg, "#ffffff", 0.09) : mix(bg, "#000000", 0.45);
    return { label: t("themeCustom"), bg, fg, ui, imageWarm: 0 };
  }
  return THEMES[s.theme] ?? THEMES.dark;
}

// Quanto reduzir a luz azul, de 0 a 1 (controle do usuário + mínimo do tema, para imagens/interface).
export function effectiveWarmth(s, { forImages = false } = {}) {
  const user = (s.blueLight || 0) / 100;
  if (!s.enabled || !forImages) return user;
  return Math.max(user, resolveTheme(s).imageWarm || 0);
}

export const VIEWER_URL = chrome.runtime.getURL("viewer/viewer.html");

export function viewerUrlFor(fileUrl) {
  return fileUrl ? `${VIEWER_URL}?file=${encodeURIComponent(fileUrl)}` : VIEWER_URL;
}
