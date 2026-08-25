// Durable edits live on the local server.  Keep this queue per image so a
// quick image switch never lets an earlier canvas snapshot overwrite a later one.
state.workspaceDraftChains = new Map();
state.workspaceDraftTimers = new Map();

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
    const previous = state.workspaceDraftChains.get(imageId) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => api(`/api/workspace/manual/${encodeURIComponent(imageId)}`, { method: "POST", body: JSON.stringify(payload) }));
    state.workspaceDraftChains.set(imageId, next);
    return next.catch((error) => { setStatus(error.message, "error"); });
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

async function loadWorkspaceDraft(imageId) {
  const data = await api(`/api/workspace/manual/${encodeURIComponent(imageId)}`);
  // Older test fixtures and a mismatched running server do not implement this
  // endpoint; never erase a live draft from an unrelated response.
  if (!data || !Object.hasOwn(data, "draft")) return;
  if (data.draft) state.drafts.set(imageId, data.draft); else state.drafts.delete(imageId);
}

function scheduleManualWorkspaceSave() { setTimeout(() => saveDraft(), 0); }
