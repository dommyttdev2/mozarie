// Durable edits live on the local server.  Keep this queue per image so a
// quick image switch never lets an earlier canvas snapshot overwrite a later one.
state.workspaceDraftChains = new Map();
state.workspaceDraftTimers = new Map();
state.workspaceMutationErrors = new Map();

function queueWorkspaceMutation(imageId, send) {
  const previous = state.workspaceDraftChains.get(imageId) || Promise.resolve();
  const next = previous.catch(() => {}).then(send);
  state.workspaceDraftChains.set(imageId, next);
  next.then(
    () => { if (state.workspaceDraftChains.get(imageId) === next) state.workspaceMutationErrors.delete(imageId); },
    (error) => { state.workspaceMutationErrors.set(imageId, error); },
  );
  return next;
}
function queueWorkspaceFlags(imageId, payload) {
  if (!imageId || !state.workspacePersistence) return Promise.resolve();
  return queueWorkspaceMutation(imageId, () => api(`/api/workspace/image/${encodeURIComponent(imageId)}`, {
    method: "POST", body: JSON.stringify(payload),
  })).catch((error) => { setStatus(error.message, "error"); });
}

const DIRECTORY_DB = "mozarie-directory-catalogs";
async function directoryCatalogStore() {
  if (!window.indexedDB) return null;
  return new Promise((resolve) => {
    const request = indexedDB.open(DIRECTORY_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("directories", { keyPath: "catalogId" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}
async function catalogForDirectoryHandle(handle) {
  if (!state.workspaceApiAvailable) return null;
  const db = await directoryCatalogStore();
  if (db) {
    const rows = await new Promise((resolve) => { const request = db.transaction("directories").objectStore("directories").getAll(); request.onsuccess = () => resolve(request.result || []); request.onerror = () => resolve([]); });
    for (const row of rows) {
      try {
        if (await row.handle?.isSameEntry?.(handle)) {
          db.close();
          // Validate the opaque ID on the server before uploads. A database
          // reset leaves the handle usable and simply falls back to a new ID.
          const activated = await api("/api/workspace/catalog", { method: "POST", body: JSON.stringify({ catalogId: row.catalogId }) });
          return activated.catalogId || null;
        }
      } catch { /* revoked handles and stale server IDs fall back below */ }
    }
    db.close();
  }
  const created = await api("/api/workspace/catalog", { method: "POST", body: JSON.stringify({}) });
  if (!db || !created.catalogId) return created.catalogId || null;
  const writeDb = await directoryCatalogStore();
  if (writeDb) { try { writeDb.transaction("directories", "readwrite").objectStore("directories").put({ catalogId: created.catalogId, handle }); } catch { /* persistence remains optional */ } writeDb.close(); }
  return created.catalogId;
}

function workspaceDraftPayload(draft) {
  if (!draft) return { add: "", exclusion: "", exclusionErase: "", removedCandidateIds: [], candidateRevision: 0 };
  return {
    add: draft.add || "", exclusion: draft.exclusion || "", exclusionErase: draft.exclusionErase || "",
    manualEnabled: draft.manualEnabled !== false, manualExclusionEnabled: draft.manualExclusionEnabled !== false,
    manualExclusionEraseEnabled: draft.manualExclusionEraseEnabled !== false, manualExclusionForced: draft.manualExclusionForced !== false,
    removedCandidateIds: draft.removedCandidateIds || [], candidateRevision: Number(draft.candidateRevision || 0),
  };
}

function queueWorkspaceDraft(imageId, immediate = false) {
  if (!imageId || !state.images.some((image) => image.id === imageId)) return Promise.resolve();
  const previousTimer = state.workspaceDraftTimers.get(imageId);
  if (previousTimer) clearTimeout(previousTimer);
  const write = () => {
    state.workspaceDraftTimers.delete(imageId);
    const payload = workspaceDraftPayload(state.drafts.get(imageId));
    return queueWorkspaceMutation(imageId, () => api(`/api/workspace/manual/${encodeURIComponent(imageId)}`, { method: "POST", body: JSON.stringify(payload) }))
      .catch((error) => { setStatus(error.message, "error"); });
  };
  if (immediate) return write();
  const promise = new Promise((resolve) => state.workspaceDraftTimers.set(imageId, setTimeout(() => resolve(write()), 250)));
  return promise;
}

async function flushWorkspaceDraft(imageId) {
  const timer = state.workspaceDraftTimers.get(imageId);
  if (timer) { clearTimeout(timer); state.workspaceDraftTimers.delete(imageId); await queueWorkspaceDraft(imageId, true); }
  await (state.workspaceDraftChains.get(imageId) || Promise.resolve());
}

async function flushAllWorkspaceMutations() {
  const pendingIds = new Set([...state.workspaceDraftTimers.keys(), ...state.workspaceDraftChains.keys()]);
  for (const imageId of pendingIds) {
    if (!state.workspaceDraftTimers.has(imageId)) continue;
    clearTimeout(state.workspaceDraftTimers.get(imageId));
    state.workspaceDraftTimers.delete(imageId);
    await queueWorkspaceDraft(imageId, true);
  }
  const results = await Promise.allSettled([...state.workspaceDraftChains.values()]);
  const failed = results.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
  const storedFailure = [...pendingIds].map((imageId) => state.workspaceMutationErrors.get(imageId)).find(Boolean);
  if (storedFailure) throw storedFailure;
}

async function loadWorkspaceDraft(imageId) {
  const data = await api(`/api/workspace/manual/${encodeURIComponent(imageId)}`);
  // Older test fixtures and a mismatched running server do not implement this
  // endpoint; never erase a live draft from an unrelated response.
  if (!data || !Object.hasOwn(data, "draft")) return;
  if (data.draft) state.drafts.set(imageId, data.draft); else state.drafts.delete(imageId);
}

function scheduleManualWorkspaceSave() { setTimeout(() => saveDraft(), 0); }
