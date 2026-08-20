function renderGallery(force = false) {
  if (!force && state.viewMode === "overview") return;
  const gallery = $("#gallery");
  const scrollTop = gallery.scrollTop;
  const visibleImages = state.images.filter(imageMatchesGalleryFilter);
  const imageCount = t("gallery.count", { count: visibleImages.length });
  for (const element of document.querySelectorAll(".gallery-local-count")) element.textContent = imageCount;
  $("#galleryFilter").value = state.galleryFilter;
  $("#galleryEmptyState").hidden = state.images.length !== 0;
  $("#galleryFilteredEmptyState").hidden = !(state.images.length && !visibleImages.length);
  const template = $("#galleryItemTemplate");
  const visibleIds = new Set(visibleImages.map((image) => image.id));
  for (const [imageId, item] of state.galleryNodes) {
    if (!visibleIds.has(imageId)) { item.remove?.(); state.galleryNodes.delete(imageId); }
  }
  for (const image of visibleImages) {
    let item = state.galleryNodes.get(image.id);
    if (!item) {
      item = template.content.firstElementChild.cloneNode(true);
      state.galleryNodes.set(image.id, item);
    }
    item.dataset.id = image.id;
    item.classList.toggle("selected", state.selectedImageIds.has(image.id) || image.id === state.currentId);
    item.classList.toggle("hidden", isHidden(image));
    item.classList.toggle("reviewed", isReviewed(image));
    const preview = item.querySelector("img");
    const previewSource = `/api/thumbnail/${encodeURIComponent(image.id)}?v=${encodeURIComponent(`${image.mtimeNs || ""}-${image.contentVersion || 0}`)}`;
    if (!String(preview.src || "").endsWith(previewSource)) preview.src = previewSource;
    preview.alt = image.relativePath;
    item.querySelector(".gallery-name").textContent = image.relativePath.split("/").pop();
    item.querySelector(".gallery-meta").textContent = `${image.width} x ${image.height}${image.candidateCount ? ` / ${t("gallery.candidates", { count: image.candidateCount })}` : ""}`;
    const reviewBadge = item.querySelector(".gallery-review-badge");
    reviewBadge.textContent = isReviewed(image) ? t("review.reviewedBadge") : t("review.unreviewedBadge");
    item.onclick = (event) => selectCatalogImage(image.id, event);
    item.onmouseenter = () => { void cachedImage(image).catch(() => {}); void loadCandidateBundle(image.id, state.imageGeneration).catch(() => {}); prefetchNeighbors(image); };
    item.oncontextmenu = (event) => openCatalogContextMenu(event, image.id);
    item.tabIndex = 0;
    item.setAttribute("role", "button");
    item.setAttribute("aria-label", `${image.relativePath}、${isReviewed(image) ? t("review.reviewedBadge") : t("review.unreviewedBadge")}`);
    item.onkeydown = (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); void selectImage(image.id); }
      else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) openCatalogContextMenu(event, image.id);
    };
    gallery.append(item);
  }
  gallery.scrollTop = scrollTop;
  updateActionButtons();
}

function imageMatchesGalleryFilter(image) {
  if (state.galleryFilter !== "hidden" && isHidden(image)) return false;
  if (state.galleryFilter === "masked") return imageHasMask(image);
  if (state.galleryFilter === "unmasked") return !imageHasMask(image);
  if (state.galleryFilter === "hidden") return isHidden(image);
  if (state.galleryFilter === "reviewed") return isReviewed(image);
  if (state.galleryFilter === "unreviewed") return !isReviewed(image);
  return true;
}

function updateGallerySelection() {
  for (const item of $("#gallery").children) item.classList.toggle("selected", item.dataset.id === state.currentId);
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
    if (state.overviewFilter !== "hidden" && isHidden(image)) return false;
    if (state.overviewFilter === "hidden" && !isHidden(image)) return false;
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
  const template = $("#overviewItemTemplate");
  const visibleIds = new Set(visibleImages.map((image) => image.id));
  $("#overviewEmptyState").hidden = visibleImages.length !== 0;
  for (const [imageId, item] of state.overviewNodes) {
    if (!visibleIds.has(imageId)) { item.remove?.(); state.overviewNodes.delete(imageId); }
  }
  for (const image of visibleImages) {
    let item = state.overviewNodes.get(image.id);
    if (!item) {
      item = template.content.firstElementChild.cloneNode(true);
      state.overviewNodes.set(image.id, item);
    }
    item.dataset.id = image.id;
    item.classList.toggle("selected", state.selectedImageIds.has(image.id) || image.id === state.currentId);
    const preview = item.querySelector("img");
    const previewSource = `/api/thumbnail/${encodeURIComponent(image.id)}?v=${encodeURIComponent(`${image.mtimeNs || ""}-${image.contentVersion || 0}`)}`;
    if (!String(preview.src || "").endsWith(previewSource)) preview.src = previewSource;
    preview.alt = image.relativePath;
    item.querySelector(".overview-item-name").textContent = image.relativePath.split(/[\\/]/).pop();
    item.querySelector(".overview-item-path").textContent = image.relativePath;
    const statuses = [];
    statuses.push(isReviewed(image) ? t("overview.stateReviewed") : t("overview.stateUnreviewed"));
    if (imageHasMask(image)) statuses.push(t("overview.stateMasked"));
    const stateLabel = item.querySelector(".overview-item-state");
    stateLabel.textContent = statuses.join(" / ");
    stateLabel.classList.toggle("reviewed", isReviewed(image));
    stateLabel.classList.toggle("masked", imageHasMask(image));
    item.onclick = (event) => { setViewMode("edit"); selectCatalogImage(image.id, event); };
    item.oncontextmenu = (event) => openCatalogContextMenu(event, image.id);
    grid.append(item);
  }
}
function renderCatalogViews() { renderGallery(); renderOverview(); }
function setViewMode(mode, refreshGallery = true) {
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
  requestAnimationFrame(() => {
    if (state.viewMode !== "overview" || state.viewGeneration !== viewGeneration) return;
    const current = [...$("#overviewGrid").children].find((item) => item.dataset.id === state.currentId);
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
function nextUnreviewedImage() {
  const current = imageIndex();
  for (let index = Math.max(0, current + 1); index < state.images.length; index += 1) if (!isHidden(state.images[index]) && !isReviewed(state.images[index])) return state.images[index];
  return null;
}
function moveToNextUnreviewed() { if (isGestureActive()) return; const target = nextUnreviewedImage(); if (target) void selectImage(target.id); }
function reviewAndMoveNext() {
  if (isGestureActive()) return null;
  const current = currentRecord();
  if (!current) return null;
  const target = state.images.slice(imageIndex(current.id) + 1).find((image) => !isHidden(image)) || null;
  setReviewed(current, true);
  if (target) void selectImage(target.id);
  return target;
}
async function hideAndMoveNext() {
  if (isGestureActive()) return;
  const current = currentRecord();
  if (!current) return;
  const target = state.images.slice(imageIndex(current.id) + 1).find((image) => !isHidden(image)) || null;
  setHidden(current, true);
  if (target) await selectImage(target.id);
}
function runNavigationAction(action) {
  action();
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
