const thumbnailObservers = new Map();
const catalogWindows = new Map();
function thumbnailObserver(scope) {
  if (thumbnailObservers.has(scope)) return thumbnailObservers.get(scope);
  const root = scope === "overview" ? $("#overviewGrid") : $("#gallery");
  const observer = new IntersectionObserver((entries) => { for (const entry of entries) { if (!entry.isIntersecting) continue; observer.unobserve(entry.target); loadThumbnail(entry.target); } }, { root, rootMargin: "320px" });
  thumbnailObservers.set(scope, observer); return observer;
}
function thumbnailSource(record) { const version = imageAssetVersion(record); return `/api/thumbnail/${encodeURIComponent(record.id)}${version ? `?v=${encodeURIComponent(version)}` : ""}`; }
function loadThumbnail(image) { const source = image.dataset.src; if (!source || image.dataset.loaded === source) return; image.dataset.loaded = source; image.src = source; }
function observeThumbnail(image, record, scope = "gallery") {
  const source = thumbnailSource(record);
  if (image.dataset.src !== source) forgetThumbnail(image);
  image.dataset.src = source; image.loading = "lazy"; image.decoding = "async";
  if (image.dataset.loaded === source) return;
  thumbnailObserver(scope).observe(image);
}
function forgetThumbnail(image) { if (!image) return; for (const observer of thumbnailObservers.values()) observer.unobserve(image); image.removeAttribute?.("src"); image.dataset.src = ""; delete image.dataset.loaded; }

function catalogWindow(scope, container, nodes, options) {
  let windowState = catalogWindows.get(scope);
  if (windowState) return windowState;
  const spacer = document.createElement("div"); spacer.className = "catalog-window-spacer";
  container.append(spacer);
  container.classList.add?.("catalog-window");
  windowState = { scope, container, nodes, spacer, options, images: [], frame: 0 };
  const schedule = () => {
    if (windowState.frame) return;
    windowState.frame = requestAnimationFrame(() => { windowState.frame = 0; renderCatalogWindow(windowState); });
  };
  container.addEventListener("scroll", schedule, { passive: true });
  if (typeof window !== "undefined") window.addEventListener?.("resize", () => renderCatalogWindow(windowState));
  catalogWindows.set(scope, windowState); return windowState;
}

function catalogLayout(windowState) {
  const { container, options } = windowState;
  const width = Math.max(1, (Number(container.clientWidth) || options.minWidth + options.padding * 2) - options.padding * 2);
  const columns = options.columns || Math.max(1, Math.floor((width + options.gap) / (options.minWidth + options.gap)));
  const itemWidth = (width - (columns - 1) * options.gap) / columns;
  return { columns, itemWidth, rowHeight: options.rowHeight, totalHeight: Math.ceil(windowState.images.length / columns) * options.rowHeight + options.padding * 2 };
}

function setCatalogNode(windowState, image, index, layout) {
  const { scope, nodes, container, options } = windowState;
  let item = nodes.get(image.id);
  if (!item) { item = document.querySelector(options.template).content.firstElementChild.cloneNode(true); nodes.set(image.id, item); }
  const row = Math.floor(index / layout.columns); const column = index % layout.columns;
  item.dataset.id = image.id; item.dataset.index = String(index); item.style.width = `${layout.itemWidth}px`; item.style.height = `${layout.rowHeight - options.gap}px`;
  item.style.transform = `translate(${options.padding + column * (layout.itemWidth + options.gap)}px, ${options.padding + row * layout.rowHeight}px)`;
  const current = image.id === state.currentId;
  const batchSelected = scope === "overview" && state.batchMode && state.selectedImageIds.has(image.id);
  item.classList.toggle("current", current); item.classList.toggle("batch-selected", batchSelected); item.classList.toggle("hidden", isHidden(image));
  if (current) item.setAttribute("aria-current", "true"); else item.removeAttribute?.("aria-current");
  if (scope === "overview" && state.batchMode) item.setAttribute("aria-pressed", String(batchSelected)); else item.removeAttribute?.("aria-pressed");
  const preview = item.querySelector("img"); observeThumbnail(preview, image, scope); preview.alt = image.relativePath;
  const reviewed = isReviewed(image);
  if (scope === "gallery") {
    item.querySelector(".gallery-name").textContent = image.relativePath.split("/").pop();
    item.querySelector(".gallery-meta").textContent = `${image.width} × ${image.height}`;
    item.querySelector(".gallery-review-badge").textContent = reviewed ? t("review.reviewedBadge") : t("review.unreviewedBadge");
    item.setAttribute("aria-label", [image.relativePath, reviewed ? t("review.reviewedBadge") : t("review.unreviewedBadge")].join(t("a11y.separator")));
    item.onclick = () => selectCatalogImage(image.id);
    item.onmouseenter = () => { schedulePrefetch(image, 2); prefetchNeighbors(image); };
  } else {
    item.querySelector(".overview-item-name").textContent = image.relativePath.split(/[\\/]/).pop();
    item.querySelector(".overview-item-dimensions").textContent = `${image.width} × ${image.height}`;
    item.querySelector(".overview-review-badge").textContent = reviewed ? t("review.reviewedBadge") : t("review.unreviewedBadge");
    item.title = image.relativePath;
    const states = [image.relativePath]; if (reviewed) states.push(t("overview.stateReviewed")); if (imageHasMask(image)) states.push(t("overview.stateMasked"));
    item.setAttribute("aria-label", states.join(t("a11y.separator")));
    item.onclick = (event) => selectOverviewImage(image.id, event);
  }
  item.oncontextmenu = (event) => openCatalogContextMenu(event, image.id);
  item.tabIndex = 0; item.setAttribute("role", "button"); item.setAttribute("aria-haspopup", "menu");
  item.onkeydown = (event) => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); scope === "gallery" ? selectCatalogImage(image.id) : selectOverviewImage(image.id, event); }
    else if (event.key === "ContextMenu" || event.key === "F10") openCatalogContextMenu(event, image.id);
  };
  container.append(item);
}

function renderCatalogWindow(windowState) {
  const { container, nodes, spacer, options } = windowState;
  const layout = catalogLayout(windowState); spacer.style.height = `${layout.totalHeight}px`;
  const viewport = Number(container.clientHeight) || Number.MAX_SAFE_INTEGER;
  const scrollTop = Number(container.scrollTop) || 0;
  const firstRow = Math.max(0, Math.floor(scrollTop / layout.rowHeight) - options.overscan);
  const lastRow = Math.ceil((scrollTop + viewport) / layout.rowHeight) + options.overscan;
  const first = firstRow * layout.columns; const last = Math.min(windowState.images.length, lastRow * layout.columns);
  const mounted = new Set(windowState.images.slice(first, last).map((image) => image.id));
  for (const [id, item] of nodes) if (!mounted.has(id)) { forgetThumbnail(item.querySelector("img")); item.remove(); nodes.delete(id); }
  for (let index = first; index < last; index += 1) setCatalogNode(windowState, windowState.images[index], index, layout);
  for (const item of nodes.values()) item.style.visibility = "";
  return layout;
}

function renderCatalog(scope, images, nodes, options) {
  if (!document.createElement) {
    const ids = new Set(images.map((image) => image.id));
    for (const [id, item] of nodes) if (!ids.has(id)) { forgetThumbnail(item.querySelector("img")); item.remove(); nodes.delete(id); }
    return null;
  }
  const windowState = catalogWindow(scope, $(options.container), nodes, options);
  windowState.images = images;
  return renderCatalogWindow(windowState);
}

function scrollCatalogImage(scope, imageId, behavior = "auto") {
  const windowState = catalogWindows.get(scope); if (!windowState) return;
  const index = windowState.images.findIndex((image) => image.id === imageId); if (index < 0) return;
  const layout = catalogLayout(windowState); const row = Math.floor(index / layout.columns);
  const target = Math.max(0, row * layout.rowHeight - Math.max(0, (windowState.container.clientHeight - layout.rowHeight) / 2));
  windowState.container.scrollTo?.({ top: target, behavior });
  if (!windowState.container.scrollTo) windowState.container.scrollTop = target;
  renderCatalogWindow(windowState);
}

function renderGallery(force = false) {
  if (!force && state.viewMode === "overview") return;
  const visibleImages = state.images.filter(imageMatchesGalleryFilter);
  const imageCount = t("gallery.count", { count: visibleImages.length });
  for (const element of document.querySelectorAll(".gallery-local-count")) element.textContent = imageCount;
  $("#galleryFilter").value = state.galleryFilter;
  $("#galleryEmptyState").hidden = state.images.length !== 0;
  $("#galleryFilteredEmptyState").hidden = !(state.images.length && !visibleImages.length);
  renderCatalog("gallery", visibleImages, state.galleryNodes, { container: "#gallery", template: "#galleryItemTemplate", padding: 8, gap: 8, minWidth: 108, rowHeight: 152, overscan: 3 });
  updateActionButtons();
}

function imageMatchesGalleryFilter(image) {
  if (state.galleryFilter === "hidden") return isHidden(image);
  if (state.galleryFilter !== "all" && isHidden(image)) return false;
  if (state.galleryFilter === "masked") return imageHasMask(image);
  if (state.galleryFilter === "unmasked") return !imageHasMask(image);
  if (state.galleryFilter === "reviewed") return isReviewed(image);
  if (state.galleryFilter === "unreviewed") return !isReviewed(image);
  return true;
}

function updateGalleryCurrent() {
  for (const item of state.galleryNodes.values()) {
    const current = item.dataset.id === state.currentId;
    item.classList.toggle("current", current);
    item.classList.toggle("batch-selected", false);
    if (current) item.setAttribute("aria-current", "true"); else item.removeAttribute?.("aria-current");
    item.removeAttribute?.("aria-pressed");
  }
  scrollCatalogImage("gallery", state.currentId);
  updateActionButtons();
}

function overviewFolderOptions() {
  const folders = new Set();
  for (const image of state.images) {
    const parts = image.relativePath.replaceAll("\\", "/").split("/").slice(0, -1);
    for (let depth = 1; depth <= parts.length; depth += 1) folders.add(parts.slice(0, depth).join("/"));
  }
  return [...folders].sort((left, right) => left.localeCompare(right));
}
function overviewImages() {
  const query = state.overviewQuery.trim().toLowerCase();
  const folder = state.overviewFolder;
  return state.images.filter((image) => {
    if (state.overviewFilter === "hidden" && !isHidden(image)) return false;
    if (state.overviewFilter !== "all" && state.overviewFilter !== "hidden" && isHidden(image)) return false;
    if (state.overviewFilter === "unreviewed" && isReviewed(image)) return false;
    if (state.overviewFilter === "reviewed" && !isReviewed(image)) return false;
    if (state.overviewFilter === "masked" && !imageHasMask(image)) return false;
    if (state.overviewFilter === "unmasked" && imageHasMask(image)) return false;
    const path = image.relativePath.replaceAll("\\", "/");
    if (folder && path !== folder && !path.startsWith(`${folder}/`)) return false;
    return !query || path.toLowerCase().includes(query);
  });
}
function syncOverviewFolders() {
  const select = $("#overviewFolder");
  const options = overviewFolderOptions();
  if (state.overviewFolder && !options.includes(state.overviewFolder)) state.overviewFolder = "";
  select.textContent = "";
  const all = document.createElement("option"); all.value = ""; all.textContent = t("overview.folder"); select.append(all);
  for (const folder of options) {
    const option = document.createElement("option"); option.value = folder; option.textContent = folder; select.append(option);
  }
  select.value = state.overviewFolder;
}
function selectOverviewImage(imageId, event = null) {
  const visibleImages = overviewImages();
  const index = visibleImages.findIndex((image) => image.id === imageId);
  if (index < 0) return;
  if (!state.batchMode) {
    setViewMode("edit");
    selectCatalogImage(imageId);
    return;
  }
  const additive = event?.ctrlKey || event?.metaKey;
  const anchor = event?.shiftKey ? visibleImages.findIndex((image) => image.id === state.selectionAnchorId) : -1;
  if (event?.shiftKey && anchor >= 0) {
    const ids = visibleImages.slice(Math.min(anchor, index), Math.max(anchor, index) + 1).map((image) => image.id);
    if (additive) ids.forEach((id) => state.selectedImageIds.add(id)); else state.selectedImageIds = new Set(ids);
  } else {
    if (state.selectedImageIds.has(imageId)) state.selectedImageIds.delete(imageId); else state.selectedImageIds.add(imageId);
    state.selectionAnchorId = imageId;
  }
  updateSelectionActionBar();
  renderOverview();
}
function renderOverview(force = false) {
  if (!force && state.viewMode !== "overview") return;
  const grid = $("#overviewGrid");
  if (!grid) return;
  syncOverviewFolders();
  const visibleImages = overviewImages();
  $("#overviewCount").textContent = t("overview.count", { visible: visibleImages.length, total: state.images.length });
  document.querySelectorAll(".overview-filter").forEach((button) => {
    const active = button.dataset.overviewFilter === state.overviewFilter;
    button.classList.toggle("active", active); button.setAttribute("aria-pressed", String(active));
  });
  $("#overviewEmptyState").hidden = visibleImages.length !== 0;
  renderCatalog("overview", visibleImages, state.overviewNodes, { container: "#overviewGrid", template: "#overviewItemTemplate", padding: 14, gap: 10, minWidth: 1, columns: 8, rowHeight: 182, overscan: 3 });
}
function renderCatalogViews() { renderGallery(); renderOverview(); }
function setViewMode(mode, refreshGallery = true) {
  if (state.viewMode !== mode) {
    closeBatchMoreMenus();
    state.batchMode = false;
    clearBatchSelection();
    updateSelectionActionBar();
  }
  const viewGeneration = ++state.viewGeneration;
  state.viewMode = mode;
  const active = mode === "overview";
  $(".studio-grid").classList.toggle("overview-active", active);
  $("#overviewPane").hidden = !active;
  if (!active) {
    discardCatalogNodes(state.overviewNodes, $("#overviewGrid"));
    if (refreshGallery) renderGallery(true);
    resizeRenderCanvas(); focusCanvas(); return;
  }
  discardCatalogNodes(state.galleryNodes, $("#gallery"));
  renderOverview(true);
  scrollCatalogImage("overview", state.currentId);
  requestAnimationFrame(() => {
    if (state.viewMode !== "overview" || state.viewGeneration !== viewGeneration) return;
    const current = state.overviewNodes.get(state.currentId);
    current?.scrollIntoView({ block: "center", behavior: "smooth" });
    focusElement($("#overviewPane"));
  });
}
function moveCurrentBy(offset) {
  if (isGestureActive()) return;
  const visible = state.images.filter((image) => !isHidden(image)); const index = visible.findIndex((image) => image.id === state.currentId);
  const target = visible[index + offset];
  if (target) void selectImage(target.id);
}
async function reviewAndMoveNext() {
  if (isGestureActive()) return null;
  const current = currentRecord();
  if (!current) return null;
  const target = state.images.slice(imageIndex(current.id) + 1).find((image) => !isHidden(image)) || null;
  if (!await setReviewed(current, true)) return null;
  if (target) void selectImage(target.id);
  return target;
}
async function hideAndMoveNext() {
  if (isGestureActive()) return;
  const current = currentRecord();
  if (!current) return;
  const target = state.images.slice(imageIndex(current.id) + 1).find((image) => !isHidden(image)) || null;
  if (!await setHidden(current, true)) return;
  if (target) await selectImage(target.id);
}
async function runNavigationAction(action) {
  await action();
  focusCanvas();
}
function updateNavigationControls() {
  const index = imageIndex();
  const position = index < 0 ? "- / -" : `${index + 1} / ${state.images.length}`;
  $("#imagePosition").textContent = position;
  const status = $("#reviewStatus");
  const record = currentRecord();
  const reviewed = isReviewed(record);
  status.textContent = record ? t(reviewed ? "review.reviewed" : "review.unreviewed") : "-";
  status.classList.toggle("reviewed", Boolean(record) && reviewed);
}
