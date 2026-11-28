// Em qual navegador a extensão está rodando. O Firefox expõe `browser.runtime.getBrowserInfo`;
// o Edge e o Chrome não têm o objeto `browser`.
export const IS_FIREFOX = typeof browser !== "undefined" && typeof browser.runtime?.getBrowserInfo === "function";

// Celular Android (Firefox para Android): sem "salvar no mesmo arquivo" e sem atalhos de teclado.
export const IS_ANDROID = /Android/i.test(navigator.userAgent);

// Navegador: "firefox", "edge", "opera" ou "chrome" (usado para o link da loja).
const UA = navigator.userAgent;
export const BROWSER = IS_FIREFOX ? "firefox" : /\bEdgA?\//.test(UA) ? "edge" : /\bOPR\//.test(UA) ? "opera" : "chrome";
