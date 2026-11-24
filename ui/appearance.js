// Painel "Aparência" (usado pelo leitor e pelo popup).
// Tela principal: modo escuro, tema, texto na mesma cor, luz azul, imagens.
// Tela "Personalizado": cor das letras, cor do fundo e até 3 presets salvos.
import {
  THEMES, TEXT_PRESETS, BG_PRESETS, MAX_PRESETS,
  resolveTheme, contrastRatio, normalizePreset,
} from "../settings.js";
import { fragment } from "./dom.js";
import { t, localize } from "./i18n.js";

const ICON_SAVE = `<svg viewBox="0 0 24 24"><path d="M5 4.5h11l3.5 3.5v10A1.5 1.5 0 0 1 18 19.5H6A1.5 1.5 0 0 1 4.5 18V6A1.5 1.5 0 0 1 6 4.5z"/><path d="M8 4.5v4.5h7V4.5M7.5 19.5v-6h9v6"/></svg>`;
const ICON_TRASH = `<svg viewBox="0 0 24 24"><path d="M4.5 7h15M9.5 7V5h5v2M6.5 7l1 12.5h9l1-12.5M10 10.5v6M14 10.5v6"/></svg>`;
const ICON_BACK = `<svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>`;

const TEMPLATE = `
  <div class="ap-view" data-view="main">
    <label class="ap-toggle ap-master" data-ref="master" hidden>
      <span><strong data-i18n="darkMode">Modo escuro</strong></span>
      <span class="switch"><input type="checkbox" data-key="enabled"><span></span></span>
    </label>

    <div class="ap-section">
      <div class="ap-label" data-i18n="theme">Tema</div>
      <div class="ap-themes" role="radiogroup" data-i18n-aria="theme" aria-label="Tema"></div>
    </div>

    <div class="ap-section">
      <div class="ap-row">
        <label class="ap-label" data-ref="blueLabel" data-i18n="blueLight">Filtro de luz azul</label>
        <output data-ref="blueOut" data-i18n="off">Desligado</output>
      </div>
      <input type="range" class="k-range" min="0" max="100" step="5" data-ref="blue">
    </div>

    <label class="ap-toggle">
      <span><strong data-i18n="monoText">Texto em uma só cor</strong></span>
      <span class="switch"><input type="checkbox" data-key="monoText"><span></span></span>
    </label>

    <label class="ap-toggle">
      <span><strong data-i18n="keepImages">Manter cores das imagens</strong></span>
      <span class="switch"><input type="checkbox" data-key="preserveImages"><span></span></span>
    </label>
  </div>

  <div class="ap-view" data-view="custom" hidden>
    <div class="ap-head">
      <button type="button" class="ap-icon" data-ref="back" data-i18n-title="back" data-i18n-aria="back" title="Voltar" aria-label="Voltar">${ICON_BACK}</button>
      <span class="ap-title" data-i18n="themeCustom">Personalizado</span>
    </div>

    <div class="ap-preview" data-ref="preview">
      <span class="ap-preview-big">Aa</span>
      <span>Bb Cc 123</span>
    </div>

    <div class="ap-section">
      <div class="ap-row">
        <span class="ap-label" data-i18n="textColor">Cor das letras</span>
        <span class="ap-contrast" data-ref="contrast"></span>
      </div>
      <div class="ap-colors" data-kind="fg" role="radiogroup" data-i18n-aria="textColor" aria-label="Cor das letras"></div>
    </div>

    <div class="ap-section">
      <div class="ap-label" data-i18n="bgColor">Cor do fundo</div>
      <div class="ap-colors" data-kind="bg" role="radiogroup" data-i18n-aria="bgColor" aria-label="Cor do fundo"></div>
    </div>

    <div class="ap-section">
      <div class="ap-row">
        <span class="ap-label" data-i18n="myPresets">Meus presets</span>
        <span class="ap-count" data-ref="count"></span>
      </div>
      <div class="ap-presets" data-ref="presets"></div>
    </div>
  </div>
`;

let uid = 0;

/**
 * @param {HTMLElement} root
 * @param {{ settings: object, update: (patch: object, opts?: {debounce?: boolean}) => void }} store
 * @param {{ masterToggle?: boolean }} [options] mostra o liga/desliga do modo escuro no topo
 * @returns {{ render: () => void, back: () => boolean }}
 */
export function mountAppearance(root, store, { masterToggle = false } = {}) {
  root.classList.add("ap");
  root.replaceChildren(fragment(TEMPLATE));
  localize(root);
  const ref = (name) => root.querySelector(`[data-ref="${name}"]`);
  const views = {
    main: root.querySelector('[data-view="main"]'),
    custom: root.querySelector('[data-view="custom"]'),
  };
  const s = () => store.settings;
  ref("master").hidden = !masterToggle;

  const blueId = `ap-blue-${++uid}`;
  ref("blue").id = blueId;
  ref("blueLabel").htmlFor = blueId;

  function showView(name) {
    for (const [key, el] of Object.entries(views)) el.hidden = key !== name;
    const focusEl = name === "custom" ? ref("back") : root.querySelector('.ap-theme[data-theme="custom"]');
    focusEl?.focus({ preventScroll: true });
    root.scrollTop = 0;
  }

  // ----- Temas -----
  const themesEl = root.querySelector(".ap-themes");
  const themeEntries = [...Object.entries(THEMES), ["custom", { label: t("themeCustom") }]];
  for (const [key, t] of themeEntries) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ap-theme k-pill";
    b.dataset.theme = key;
    b.setAttribute("role", "radio");

    const sw = document.createElement("span");
    sw.className = "ap-swatch";
    sw.textContent = "Aa";
    const label = document.createElement("span");
    label.className = "ap-theme-label";
    label.textContent = t.label;
    b.append(sw, label);
    b.addEventListener("click", () => {
      if (key === "custom") {
        if (s().theme !== "custom" || !s().enabled) {
          const cur = resolveTheme(s());
          store.update({ theme: "custom", enabled: true, customFg: cur.fg, customBg: cur.bg });
        }
        showView("custom");
      } else {
        store.update({ theme: key, enabled: true });
      }
    });
    themesEl.append(b);
  }
  ref("back").addEventListener("click", () => showView("main"));

  // ----- Cores (letras / fundo) -----
  for (const row of root.querySelectorAll(".ap-colors")) {
    const kind = row.dataset.kind;
    const presets = kind === "fg" ? TEXT_PRESETS : BG_PRESETS;
    for (const [hex, name] of presets) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ap-color";
      b.dataset.color = hex;
      b.style.background = hex;
      b.title = name;
      b.setAttribute("aria-label", name);
      b.setAttribute("role", "radio");
      b.addEventListener("click", () => setColor(kind, hex));
      row.append(b);
    }
    const picker = document.createElement("label");
    picker.className = "ap-color ap-picker";
    picker.title = t("pickOtherColor");
    const input = document.createElement("input");
    input.type = "color";
    input.setAttribute("aria-label", t(kind === "fg" ? "pickTextColor" : "pickBgColor"));
    input.addEventListener("input", () => setColor(kind, input.value, true));
    input.addEventListener("change", () => setColor(kind, input.value));
    picker.append(input);
    row.append(picker);
  }

  function setColor(kind, hex, debounce = false) {
    const cur = resolveTheme(s());
    const patch = { theme: "custom", enabled: true, customFg: cur.fg, customBg: cur.bg };
    patch[kind === "fg" ? "customFg" : "customBg"] = hex.toLowerCase();
    store.update(patch, { debounce });
  }

  // ----- Presets -----
  const presetsEl = ref("presets");
  const slots = [];
  for (let i = 0; i < MAX_PRESETS; i++) {
    const slot = document.createElement("div");
    slot.className = "ap-slot";
    slot.replaceChildren(fragment(`
      <button type="button" class="ap-slot-apply" data-r="apply"><span class="ap-swatch">Aa</span></button>
      <input type="text" class="ap-slot-name" data-r="name" maxlength="24" spellcheck="false">
      <button type="button" class="ap-icon" data-r="save" >${ICON_SAVE}</button>
      <button type="button" class="ap-icon" data-r="del" >${ICON_TRASH}</button>
      <button type="button" class="ap-slot-new" data-r="new"></button>`));
    const r = (n) => slot.querySelector(`[data-r="${n}"]`);
    r("new").textContent = t("savePreset");
    const defaultName = t("presetN", i + 1);
    r("apply").setAttribute("aria-label", t("usePreset", defaultName));
    r("name").setAttribute("aria-label", t("presetNameN", i + 1));
    r("new").setAttribute("aria-label", t("saveInSlot", i + 1));

    r("apply").addEventListener("click", () => applyPreset(i));
    r("new").addEventListener("click", () => savePreset(i));
    r("save").title = t("updateWithCurrent");
    r("del").title = t("deleteLabel");
    r("save").addEventListener("click", () => {
      savePreset(i);
      flash(slot, t("savedShort"));
    });
    let confirmTimer = 0;
    r("del").addEventListener("click", () => {
      if (!slot.classList.contains("confirm")) {
        slot.classList.add("confirm");
        r("del").title = t("clickAgainDelete");
        confirmTimer = setTimeout(() => {
          slot.classList.remove("confirm");
          r("del").title = t("deleteLabel");
        }, 3000);
        return;
      }
      clearTimeout(confirmTimer);
      slot.classList.remove("confirm");
      r("del").title = t("deleteLabel");
      setPreset(i, null);
    });
    r("name").addEventListener("input", () => renamePreset(i, r("name").value, true));
    r("name").addEventListener("change", () => renamePreset(i, r("name").value.trim() || defaultName));
    r("name").addEventListener("keydown", (e) => {
      if (e.key === "Enter") r("name").blur();
      e.stopPropagation(); // não dispara atalhos do leitor enquanto digita
    });

    presetsEl.append(slot);
    slots.push({ slot, r, defaultName });
  }

  function setPreset(i, value, opts) {
    const presets = s().presets.slice();
    presets[i] = value;
    store.update({ presets }, opts);
  }

  function savePreset(i) {
    const st = s();
    const theme = resolveTheme(st);
    const old = st.presets[i];
    setPreset(i, normalizePreset({
      name: old?.name || slots[i].defaultName,
      fg: theme.fg, bg: theme.bg, monoText: st.monoText, blueLight: st.blueLight,
    }));
  }

  function renamePreset(i, name, debounce = false) {
    const p = s().presets[i];
    if (p) setPreset(i, { ...p, name: name.slice(0, 24) }, { debounce });
  }

  function applyPreset(i) {
    const p = s().presets[i];
    if (!p) return;
    store.update({
      theme: "custom", enabled: true,
      customFg: p.fg, customBg: p.bg, monoText: p.monoText, blueLight: p.blueLight,
    });
  }

  function flash(slot, text) {
    slot.dataset.flash = text;
    slot.classList.add("flash");
    setTimeout(() => slot.classList.remove("flash"), 1200);
  }

  // ----- Interruptores e luz azul -----
  for (const input of root.querySelectorAll("input[data-key]")) {
    input.addEventListener("change", () => store.update({ [input.dataset.key]: input.checked }));
  }
  const blue = ref("blue");
  blue.addEventListener("input", () => store.update({ blueLight: Number(blue.value) }, { debounce: true }));
  blue.addEventListener("change", () => store.update({ blueLight: Number(blue.value) }));

  // ----- Atualização visual -----
  function render() {
    const st = s();
    const theme = resolveTheme(st);
    const isCustom = st.enabled && st.theme === "custom";

    for (const b of themesEl.children) {
      const key = b.dataset.theme;
      const t = key === "custom" ? { bg: st.customBg, fg: st.customFg } : THEMES[key];
      const sw = b.firstChild;
      sw.style.setProperty("--sw-bg", t.bg);
      sw.style.setProperty("--sw-fg", t.fg);
      b.setAttribute("aria-checked", String(st.enabled && st.theme === key));
    }

    // tela personalizada
    const preview = ref("preview");
    preview.style.background = theme.bg;
    preview.style.color = theme.fg;
    for (const row of root.querySelectorAll(".ap-colors")) {
      const current = (row.dataset.kind === "fg" ? theme.fg : theme.bg).toLowerCase();
      let matched = false;
      for (const b of row.querySelectorAll("button.ap-color")) {
        const on = b.dataset.color === current;
        matched ||= on;
        b.setAttribute("aria-checked", String(on));
      }
      const picker = row.querySelector(".ap-picker");
      const input = picker.querySelector("input");
      if (document.activeElement !== input) input.value = current;
      picker.classList.toggle("custom", !matched);
      picker.style.setProperty("--picked", current);
    }
    const ratio = contrastRatio(theme.fg, theme.bg);
    const c = ref("contrast");
    c.textContent = ratio < 4.5 ? t("lowContrast") : "";
    c.title = t("contrastRatio", ratio.toFixed(1));
    c.classList.toggle("low", ratio < 4.5);

    let used = 0;
    st.presets.forEach((p, i) => {
      const { slot, r, defaultName } = slots[i];
      slot.classList.toggle("empty", !p);
      for (const n of ["apply", "name", "save", "del"]) r(n).hidden = !p;
      r("new").hidden = !!p;
      if (!p) { slot.removeAttribute("aria-current"); return; }
      used++;
      const sw = r("apply").firstChild;
      sw.style.background = p.bg;
      sw.style.color = p.fg;
      r("apply").title = t("usePresetQuoted", p.name || defaultName);
      if (document.activeElement !== r("name")) r("name").value = p.name || defaultName;
      const active = isCustom && p.fg === st.customFg.toLowerCase() && p.bg === st.customBg.toLowerCase()
        && p.monoText === !!st.monoText;
      slot.toggleAttribute("aria-current", active);
    });
    ref("count").textContent = `${used}/${MAX_PRESETS}`;

    for (const input of root.querySelectorAll("input[data-key]")) input.checked = !!st[input.dataset.key];
    if (document.activeElement !== blue) blue.value = String(st.blueLight);
    ref("blueOut").textContent = st.blueLight ? `${st.blueLight}%` : t("off");
    blue.style.setProperty("--fill", `${st.blueLight}%`);
    root.classList.toggle("ap-off", !st.enabled);
  }

  // Volta para a tela principal; retorna false se já estava nela.
  function back() {
    if (views.custom.hidden) return false;
    showView("main");
    return true;
  }

  render();
  return { render, back };
}
