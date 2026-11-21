// Tradução: usa os arquivos _locales/<idioma>/messages.json
// (inglês por padrão; português, espanhol, francês, italiano e alemão).
//
// Correção para idiomas com região: com o navegador em "es-MX", "fr-CA", "pt-PT",
// "de-AT"… o navegador não usa a tradução do idioma base e cai no inglês. Nesse caso
// carregamos nós mesmos o arquivo do idioma base (es, fr, pt, de, it).

let bundle = null;

(function pickRegionalFallback() {
  if (typeof XMLHttpRequest === "undefined") return; // service worker: usa o do navegador
  const ui = chrome.i18n.getUILanguage().replace("-", "_");
  const base = ui.split("_")[0].toLowerCase();
  if (base === "en" || chrome.i18n.getMessage("localeCode") === base) return; // já está certo
  for (const folder of [ui, base]) {
    try {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", chrome.runtime.getURL(`_locales/${folder}/messages.json`), false); // síncrono: o texto é pedido na hora
      xhr.send();
      if (xhr.status === 200 || (xhr.status === 0 && xhr.responseText)) {
        bundle = JSON.parse(xhr.responseText);
        return;
      }
    } catch {
      // idioma sem tradução: fica com o do navegador (inglês)
    }
  }
})();

function format(message, list) {
  return message.replace(/\$(\d)/g, (m, n) => (list && list[n - 1] !== undefined ? list[n - 1] : m));
}

/** Texto traduzido. `subs` substitui $1, $2… na mensagem. */
export function t(key, subs) {
  const list = subs === undefined ? undefined : (Array.isArray(subs) ? subs : [subs]).map(String);
  if (bundle?.[key]) return format(bundle[key].message, list);
  return chrome.i18n.getMessage(key, list) || key;
}

/** Idioma em uso pela interface (ex.: "es", "pt", "en"). */
export function uiLang() {
  return bundle?.localeCode?.message || chrome.i18n.getMessage("localeCode") || "en";
}

/**
 * Traduz o HTML: data-i18n (texto), data-i18n-title, data-i18n-aria (aria-label)
 * e data-i18n-placeholder.
 */
export function localize(root = document) {
  for (const el of root.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll("[data-i18n-title]")) el.title = t(el.dataset.i18nTitle);
  for (const el of root.querySelectorAll("[data-i18n-aria]")) el.setAttribute("aria-label", t(el.dataset.i18nAria));
  for (const el of root.querySelectorAll("[data-i18n-placeholder]")) el.placeholder = t(el.dataset.i18nPlaceholder);
  if (root === document) document.documentElement.lang = uiLang();
}
