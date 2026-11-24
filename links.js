// Links externos do Sereno.
// REPORT_URL: e-mail ("mailto:voce@exemplo.com") ou link de um formulário ("https://forms.gle/...").
// UNINSTALL_URL: página aberta quando alguém desinstala ("Por que você desinstalou?").
// Deixe "" para esconder o link / não abrir página nenhuma.
export const REPORT_URL = "https://forms.gle/m3dAP9PSu2BPxAVw7";
export const UNINSTALL_URL = "https://forms.gle/N2fxb9aoFqLUPAju7";

import { IS_FIREFOX } from "./platform.js";

// Página do Sereno em cada loja (fixa: funciona também quando a extensão é carregada sem pacote).
export const STORE_URL = "https://microsoftedge.microsoft.com/addons/detail/limkplgjplglhfbcnehmmnjnfboidjkf";
// Firefox: confirme o endereço depois que a página for criada em addons.mozilla.org.
export const STORE_URL_FIREFOX = "https://addons.mozilla.org/firefox/addon/sereno/";
export const storeUrl = () => (IS_FIREFOX ? STORE_URL_FIREFOX : STORE_URL);

// Para e-mail, já preenche assunto e versão (sem nenhum dado pessoal).
export function reportUrl() {
  if (!REPORT_URL.startsWith("mailto:")) return REPORT_URL;
  const v = chrome.runtime.getManifest().version;
  const ua = navigator.userAgent;
  const edge = IS_FIREFOX ? `Firefox ${(ua.match(/Firefox\/([\d.]+)/) || [])[1] || "?"}` : `Edge ${(ua.match(/Edg\/([\d.]+)/) || [])[1] || "?"}`;
  const subject = `Sereno ${v}`;
  const body = `\n\n—\nSereno ${v} · ${edge} · ${chrome.i18n.getUILanguage()}`;
  return `${REPORT_URL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
