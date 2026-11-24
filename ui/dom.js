// Monta elementos a partir de marcação fixa do próprio código (sem dados de fora),
// sem usar innerHTML.
export function fragment(markup) {
  const doc = new DOMParser().parseFromString(`<body>${markup}</body>`, "text/html");
  const frag = document.createDocumentFragment();
  frag.append(...doc.body.childNodes);
  return frag;
}
