// Links externos do Sereno.
// REPORT_URL: e-mail ("mailto:voce@exemplo.com") ou link de um formulário ("https://forms.gle/...").
// UNINSTALL_URL: página aberta quando alguém desinstala ("Por que você desinstalou?").
// Deixe "" para esconder o link / não abrir página nenhuma.
export const REPORT_URL = "https://forms.gle/m3dAP9PSu2BPxAVw7";
export const UNINSTALL_URL = "https://forms.gle/N2fxb9aoFqLUPAju7";

import { IS_FIREFOX, BROWSER } from "./platform.js";

// Página do Sereno em cada loja (fixa: funciona também quando a extensão é carregada sem pacote).
export const STORE_URL = "https://microsoftedge.microsoft.com/addons/detail/limkplgjplglhfbcnehmmnjnfboidjkf";
// Firefox: confirme o endereço depois que a página for criada em addons.mozilla.org.
export const STORE_URL_FIREFOX = "https://addons.mozilla.org/firefox/addon/sereno/";
// Opera: confirme o endereço depois que a página for criada em addons.opera.com.
export const STORE_URL_OPERA = "https://addons.opera.com/extensions/details/sereno/";
// Chrome: o endereço usa o código da extensão, que a Chrome Web Store mantém fixo.
export const STORE_URL_CHROME = `https://chromewebstore.google.com/detail/${chrome.runtime.id}`;
export const storeUrl = () =>
  ({ firefox: STORE_URL_FIREFOX, opera: STORE_URL_OPERA, chrome: STORE_URL_CHROME })[BROWSER] ?? STORE_URL;

// Para e-mail, já preenche assunto e versão (sem nenhum dado pessoal).
export function reportUrl() {
  if (!REPORT_URL.startsWith("mailto:")) return REPORT_URL;
  const v = chrome.runtime.getManifest().version;
  const ua = navigator.userAgent;
  const tok = { firefox: ["Firefox", /Firefox\/([\d.]+)/], edge: ["Edge", /Edg\/([\d.]+)/], opera: ["Opera", /OPR\/([\d.]+)/], chrome: ["Chrome", /Chrome\/([\d.]+)/] }[BROWSER];
  const edge = `${tok[0]} ${(ua.match(tok[1]) || [])[1] || "?"}`;
  const subject = `Sereno ${v}`;
  const body = `\n\n—\nSereno ${v} · ${edge} · ${chrome.i18n.getUILanguage()}`;
  return `${REPORT_URL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
