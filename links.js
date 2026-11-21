// Links externos do Sereno.
// REPORT_URL: e-mail ("mailto:voce@exemplo.com") ou link de um formulário ("https://forms.gle/...").
// UNINSTALL_URL: página aberta quando alguém desinstala ("Por que você desinstalou?").
// Deixe "" para esconder o link / não abrir página nenhuma.
export const REPORT_URL = "https://forms.gle/m3dAP9PSu2BPxAVw7";
export const UNINSTALL_URL = "https://forms.gle/N2fxb9aoFqLUPAju7";

// Página da extensão na loja do Edge (o ID instalado pela loja é o mesmo da página).
// Página do Sereno na loja do Edge (fixa: funciona também quando a extensão é carregada sem pacote).
export const STORE_URL = "https://microsoftedge.microsoft.com/addons/detail/limkplgjplglhfbcnehmmnjnfboidjkf";
export const storeUrl = () => STORE_URL;

// Para e-mail, já preenche assunto e versão (sem nenhum dado pessoal).
export function reportUrl() {
  if (!REPORT_URL.startsWith("mailto:")) return REPORT_URL;
  const v = chrome.runtime.getManifest().version;
  const edge = (navigator.userAgent.match(/Edg\/([\d.]+)/) || [])[1] || "?";
  const subject = `Sereno ${v}`;
  const body = `\n\n—\nSereno ${v} · Edge ${edge} · ${chrome.i18n.getUILanguage()}`;
  return `${REPORT_URL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
