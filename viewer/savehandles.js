// Lembra em qual arquivo cada PDF foi salvo, para o "Salvar" gravar sempre no mesmo arquivo,
// inclusive depois de fechar e abrir o PDF de novo. Guarda o "atalho" do arquivo
// (FileSystemFileHandle) no IndexedDB da extensão — nada sai do computador.

const DB = "pdfdark-save";
const STORE = "handles";

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req?.result);
      t.onerror = () => reject(t.error);
    });
  } finally {
    db.close();
  }
}

export async function getSaveHandle(key) {
  if (!key) return null;
  try { return (await tx("readonly", (s) => s.get(key))) ?? null; } catch { return null; }
}

export async function setSaveHandle(key, handle) {
  if (!key || !handle) return;
  try { await tx("readwrite", (s) => s.put(handle, key)); } catch {}
}

/** Garante permissão de escrita (o Edge pode perguntar uma vez). */
export async function ensureWritable(handle) {
  try {
    const opts = { mode: "readwrite" };
    if ((await handle.queryPermission?.(opts)) === "granted") return true;
    return (await handle.requestPermission?.(opts)) === "granted";
  } catch {
    return false;
  }
}
