// Em qual navegador a extensão está rodando. O Firefox expõe `browser.runtime.getBrowserInfo`;
// o Edge e o Chrome não têm o objeto `browser`.
export const IS_FIREFOX = typeof browser !== "undefined" && typeof browser.runtime?.getBrowserInfo === "function";
