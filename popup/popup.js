import { createSettingsStore } from "../settings.js";
import { mountAppearance } from "../ui/appearance.js";
import { t, localize } from "../ui/i18n.js";
import { REPORT_URL, reportUrl, storeUrl } from "../links.js";

localize();
import { applyThemeToTab, tabThemeState } from "../tabtheme.js";

const $ = (id) => document.getElementById(id);

let appearance = null;
const store = await createSettingsStore(render);
appearance = mountAppearance($("appearance"), store);

function render() {
  $("autoOpen").checked = store.settings.autoOpen;
  const on = store.settings.enabled;
  $("masterBtn").setAttribute("aria-pressed", String(on));
  $("masterBtn").title = t(on ? "darkModeOn" : "darkModeOff");
  appearance?.render();
}

$("masterBtn").addEventListener("click", () => store.update({ enabled: !store.settings.enabled }));

$("autoOpen").addEventListener("change", (e) => store.update({ autoOpen: e.target.checked }));

// ----- Aplicar tema nessa guia -----
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const applyBtn = $("applyTab");
const applyMsg = $("applyMsg");

function showTabState(state) {
  applyBtn.textContent = t(state === "applied" ? "removeTheme" : "applyTheme");
  applyBtn.disabled = state === "blocked";
  applyMsg.hidden = state !== "blocked";
  applyMsg.textContent = t("tabProtected");
}

showTabState(tab ? await tabThemeState(tab) : "blocked");
applyBtn.addEventListener("click", async () => {
  const result = await applyThemeToTab(tab).catch(() => "blocked");
  if (result === "opened" || result === "viewer") return window.close();
  showTabState(result);
});

// ----- Aviso: PDFs do computador precisam de "Permitir acesso a URLs de arquivo" -----
$("fileNotice").hidden = await chrome.extension.isAllowedFileSchemeAccess();

// ----- Relatar um problema -----
if (REPORT_URL) {
  $("foot").hidden = false;
  const report = $("report");
  report.href = reportUrl();
  if (!REPORT_URL.startsWith("mailto:")) {
    // formulário: abre numa guia nova e fecha o menu
    report.addEventListener("click", (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: report.href });
      window.close();
    });
  }
}

// ----- Convite para avaliar: aparece aqui só se a pessoa escolheu "Agora não" no leitor -----
const { rateState } = await chrome.storage.local.get("rateState");
if (rateState === "later") {
  $("rateCard").hidden = false;
  const done = () => chrome.storage.local.set({ rateState: "done" });
  $("rateCardNow").addEventListener("click", async () => {
    await done();
    chrome.tabs.create({ url: storeUrl() });
    window.close();
  });
  $("rateNever").addEventListener("click", async () => {
    await done();
    $("rateCard").hidden = true;
  });
}

render();
