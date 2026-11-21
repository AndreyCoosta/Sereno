import { getSettings, setSettings, VIEWER_URL, viewerUrlFor } from "./settings.js";
import { applyThemeToTab } from "./tabtheme.js";
import { UNINSTALL_URL } from "./links.js";

const REDIRECT_RULE_ID = 1;
const BYPASS_RULE_BASE = 1000;

// ---------------------------------------------------------------------------
// Redirecionamento automático de PDFs (http/https) para o leitor escuro.
// Usa declarativeNetRequest com condição no cabeçalho Content-Type, então
// funciona mesmo quando a URL não termina em ".pdf".
// ---------------------------------------------------------------------------
async function syncRedirectRule() {
  const { autoOpen } = await getSettings();
  const addRules = autoOpen
    ? [{
        id: REDIRECT_RULE_ID,
        priority: 1,
        action: {
          type: "redirect",
          redirect: { regexSubstitution: `${VIEWER_URL}?file=\\0` },
        },
        condition: {
          regexFilter: "^https?://.*",
          resourceTypes: ["main_frame", "sub_frame"],
          requestMethods: ["get"],
          responseHeaders: [
            { header: "content-type", values: ["application/pdf*", "application/x-pdf*"] },
          ],
          excludedResponseHeaders: [
            { header: "content-disposition", values: ["attachment*"] },
          ],
        },
      }]
    : [];
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [REDIRECT_RULE_ID],
      addRules,
    });
  } catch (err) {
    console.error("[Sereno] Não foi possível registrar a regra de redirecionamento:", err);
  }
}

chrome.runtime.onInstalled.addListener(syncRedirectRule);
chrome.runtime.onStartup.addListener(syncRedirectRule);

// Página aberta ao desinstalar ("Por que você desinstalou?").
if (UNINSTALL_URL) chrome.runtime.setUninstallURL(UNINSTALL_URL).catch(() => {});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && "autoOpen" in changes) syncRedirectRule();
});

// "Abrir original": deixa uma URL passar sem redirecionar (até o navegador fechar).
async function bypass(url) {
  if (url.startsWith("file:")) {
    const { bypassFiles = [] } = await chrome.storage.session.get("bypassFiles");
    if (!bypassFiles.includes(url)) bypassFiles.push(url);
    await chrome.storage.session.set({ bypassFiles });
    return;
  }
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  if (rules.some((r) => r.condition.urlFilter === `|${url}|`)) return;
  const id = rules.reduce((m, r) => Math.max(m, r.id), BYPASS_RULE_BASE) + 1;
  await chrome.declarativeNetRequest.updateSessionRules({
    addRules: [{
      id,
      priority: 2,
      action: { type: "allow" },
      condition: { urlFilter: `|${url}|`, resourceTypes: ["main_frame", "sub_frame"] },
    }],
  });
}

// ---------------------------------------------------------------------------
// PDFs locais (file://). Não passam pelo declarativeNetRequest, então
// interceptamos a navegação antes dela acontecer.
// Requer "Permitir acesso a URLs de arquivo" em edge://extensions.
// ---------------------------------------------------------------------------
chrome.webNavigation.onBeforeNavigate.addListener(
  async ({ tabId, frameId, url }) => {
    if (frameId !== 0) return;
    const { autoOpen } = await getSettings();
    if (!autoOpen) return;
    if (!(await chrome.extension.isAllowedFileSchemeAccess())) return;
    const { bypassFiles = [] } = await chrome.storage.session.get("bypassFiles");
    if (bypassFiles.includes(url)) return;
    chrome.tabs.update(tabId, { url: viewerUrlFor(url) });
  },
  { url: [{ schemes: ["file"], pathSuffix: ".pdf" }, { schemes: ["file"], pathSuffix: ".PDF" }] },
);

// ---------------------------------------------------------------------------
// Atalho de teclado (Alt+Shift+D)
// ---------------------------------------------------------------------------
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== "toggle-dark" || !tab) return;
  if (tab.url?.startsWith(VIEWER_URL)) {
    const { enabled } = await getSettings();
    await setSettings({ enabled: !enabled });
  } else {
    applyThemeToTab(tab).catch((e) => console.warn("[Sereno]", e.message));
  }
});

// ---------------------------------------------------------------------------
// Mensagens do popup e do leitor
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case "bypass":
        await bypass(msg.url);
        return { ok: true };
      default:
        return { ok: false };
    }
  })().then(sendResponse, (e) => sendResponse({ ok: false, error: e.message }));
  return true;
});
