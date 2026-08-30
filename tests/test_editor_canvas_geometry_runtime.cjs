const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function canvas(width = 100, height = 80) {
  const target = { width, height, alpha: 0 };
  target.ctx = {
    calls: [], alpha: 0,
    clearRect(...args) { this.calls.push(["clear", ...args]); this.alpha = 0; },
    drawImage(image, ...args) { this.calls.push(["image", image, ...args]); if (image?.alpha || image?.ctx?.alpha) this.alpha = 255; },
    getImageData() { return { data: new Uint8ClampedArray([0, 0, 0, this.alpha]) }; },
    save() { this.calls.push(["save"]); }, restore() { this.calls.push(["restore"]); },
    setTransform(...args) { this.calls.push(["transform", ...args]); }, translate(...args) { this.calls.push(["translate", ...args]); }, scale(...args) { this.calls.push(["scale", ...args]); },
    beginPath() { this.calls.push(["begin"]); }, moveTo(...args) { this.calls.push(["move", ...args]); }, lineTo(...args) { this.calls.push(["line", ...args]); },
    rect(...args) { this.calls.push(["rect", ...args]); }, closePath() { this.calls.push(["close"]); }, arc(...args) { this.calls.push(["arc", ...args]); },
    stroke() { this.calls.push(["stroke"]); }, fill() { this.calls.push(["fill"]); }, fillRect(...args) { this.calls.push(["fillRect", ...args]); }, clip() { this.calls.push(["clip"]); },
    setLineDash(args) { this.calls.push(["dash", ...args]); },
  };
  target.getContext = () => target.ctx;
  return target;
}

const elements = new Map();
function element(id) {
  if (!elements.has(id)) elements.set(id, { value: "10", hidden: false, disabled: false, style: {}, offsetWidth: 142, offsetHeight: 38 });
  return elements.get(id);
}

const displayCanvas = canvas();
const overlayCanvas = canvas();
const state = {
  currentId: "image", currentImage: { width: 100, height: 80, alpha: 255 }, candidates: [], candidateImages: new Map(), removedCandidateIds: new Set(),
  maskStatus: new Map(),
  boundaryDrafts: [], boundaryActiveId: null, boundaryDragging: false, boundaryStart: null, boundaryPoint: null, boundaryRoi: null, boundaryPromptPoint: null,
  polygonPoints: [], boundaryBrushStroke: null, boundaryDraftSequence: 0, boundaryPending: false, pendingImageId: null, importing: false,
  view: { x: 5, y: 7, scale: 2 }, hover: null, tool: "brush", blinkCandidateIds: new Set(), blinkModes: new Map(), blinkPhase: false,
  settings: { display: { apply_color: "#f00", exclude_color: "#0ff", overlay_opacity: 0.5 } },
};
let focused = 0;
const context = {
  state, Math, Map, Set, Array, Object, Number, Boolean, Uint8ClampedArray,
  window: { devicePixelRatio: 1 }, document: { activeElement: null }, stage: { clientWidth: 120, clientHeight: 90 },
  requestAnimationFrame(callback) { callback(); return 1; }, cancelAnimationFrame() {},
  canvas: displayCanvas, ctx: displayCanvas.ctx, boundaryOverlayCanvas: overlayCanvas, boundaryOverlayCtx: overlayCanvas.ctx,
  blinkCanvas: canvas(), blinkCtx: canvas().ctx, combinedCanvas: canvas(), addCanvas: canvas(), exclusionCanvas: canvas(), exclusionEraseCanvas: canvas(),
  $: (id) => element(id), isBusy: () => false, focusCanvas: () => { focused += 1; }, updateActionButtons() {}, renderCatalogViews() {},
  currentRecord: () => ({ enabledCandidateCount: 0 }),
  setCssTransform(target) { target.setTransform(1, 0, 0, 1, 0, 0); },
};
context.blinkCtx = context.blinkCanvas.getContext("2d");
context.combinedCtx = context.combinedCanvas.getContext("2d");

const canvasPath = path.join(__dirname, "..", "static", "js", "editor-canvas.js");
const source = fs.readFileSync(canvasPath, "utf8");
vm.runInNewContext(`${source}
globalThis.geometryRuntime = { drawBrushCursor, roiFromPoints, boundaryDraftRoi, boundaryDraftId, pointForRoi, polygonRoi, boundaryDraftBounds, addBoundaryDraft, activeBoundaryShape, boundaryShapes, strokeRoi, appendBoundaryBrushPoint, beginBoundaryBrushStroke, completeBoundaryBrushStroke, rectsTouch, joinRois, boundaryRequests, boundaryPath, drawBoundaryScrim, drawBoundaryShape, drawBoundaryRoi, polygonArea, polygonSegmentsIntersect, polygonPointsValid, polygonIsValid, canDetectBoundary, hasBoundaryDraft, boundaryActionAnchor, updateBoundaryActions, drawCandidateBlinkOverlay, refreshMaskStatus, renderNow, render, flushRender };`, context, { filename: canvasPath });
const test = context.geometryRuntime;

function rectangle(left, top, right, bottom) { return { type: "rectangle", roi: { left, top, right, bottom } }; }

// The tools users can actually manipulate all produce image-space geometry.
assert.equal(test.roiFromPoints({ x: 1.2, y: 3.4 }, { x: 1.9, y: 4.1 }), null, "a sub-two-pixel drag does not create a detector ROI");
assert.deepEqual(JSON.parse(JSON.stringify(test.roiFromPoints({ x: 9.8, y: 6.1 }, { x: 2.2, y: 12.9 }))), { left: 2, top: 6, right: 10, bottom: 13 });
assert.equal(test.polygonRoi([]), null);
assert.deepEqual(JSON.parse(JSON.stringify(test.polygonRoi([{ x: 8.2, y: 9.1 }, { x: 2.1, y: 4.9 }]))), { left: 2, right: 9, top: 4, bottom: 10 });
assert.deepEqual(JSON.parse(JSON.stringify(test.pointForRoi({ left: 2, top: 4, right: 9, bottom: 10 }))), { x: 6, y: 7 });
assert.equal(test.boundaryDraftBounds(null), null);

state.boundaryDragging = true; state.boundaryStart = { x: 10, y: 10 }; state.boundaryPoint = { x: 30, y: 24 };
assert.deepEqual(JSON.parse(JSON.stringify(test.boundaryDraftRoi())), { left: 10, top: 10, right: 30, bottom: 24 });
state.boundaryDragging = false; state.boundaryRoi = { left: 1, top: 2, right: 8, bottom: 9 };
assert.equal(test.boundaryDraftRoi().left, 1, "stored rectangle drafts are available after a pointer release");
state.boundaryRoi = null;

const validPolygon = [{ x: 2, y: 2 }, { x: 12, y: 2 }, { x: 12, y: 12 }, { x: 2, y: 12 }];
assert.equal(test.polygonArea(validPolygon), 100);
assert.equal(test.polygonSegmentsIntersect(validPolygon[0], validPolygon[1], validPolygon[2], validPolygon[3]), false);
assert.equal(test.polygonPointsValid(validPolygon), true);
assert.equal(test.polygonPointsValid([{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }]), false, "detectors reject tiny polygons");
assert.equal(test.polygonPointsValid([{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 }]), false, "self-crossing polygons are not sent to the detector");
state.polygonPoints = validPolygon; assert.equal(test.polygonIsValid(), true);

const first = test.addBoundaryDraft(rectangle(2, 2, 12, 12));
assert.equal(first.id, "boundary-1"); assert.equal(state.boundaryActiveId, first.id);
assert.equal(test.activeBoundaryShape().type, "polygon", "in-progress polygon takes precedence over saved shapes");
state.polygonPoints = [];
assert.equal(test.activeBoundaryShape(), null);
assert.equal(test.hasBoundaryDraft(), true);
assert.equal(test.boundaryShapes().length, 1);
state.boundaryBrushStroke = { type: "brush", points: [{ x: 1, y: 1 }], radius: 4, roi: { left: 0, top: 0, right: 4, bottom: 4 } };
assert.equal(test.activeBoundaryShape().type, "brush", "an in-progress brush has a live preview shape");
state.boundaryBrushStroke = null;

assert.equal(test.strokeRoi([], 10), null);
assert.deepEqual(JSON.parse(JSON.stringify(test.strokeRoi([{ x: -5, y: 2 }, { x: 104, y: 90 }], 10))), { left: 0, top: 0, right: 100, bottom: 80 }, "brush ROI is clamped to the image");
test.beginBoundaryBrushStroke({ x: 30, y: 30 });
test.appendBoundaryBrushPoint({ x: 30.2, y: 30.2 });
assert.equal(state.boundaryBrushStroke.points.length, 1, "near-identical brush samples are coalesced");
test.appendBoundaryBrushPoint({ x: 33, y: 32 });
assert.equal(state.boundaryBrushStroke.points.length, 2);
test.completeBoundaryBrushStroke();
assert.equal(state.boundaryBrushStroke, null); assert.equal(state.boundaryDrafts.at(-1).type, "brush");
test.appendBoundaryBrushPoint({ x: 1, y: 1 });
test.completeBoundaryBrushStroke();

assert.equal(test.rectsTouch({ left: 0, top: 0, right: 4, bottom: 4 }, { left: 6, top: 0, right: 8, bottom: 4 }), false);
assert.equal(test.rectsTouch({ left: 0, top: 0, right: 4, bottom: 4 }, { left: 5, top: 5, right: 8, bottom: 8 }), true);
assert.deepEqual(JSON.parse(JSON.stringify(test.joinRois([{ left: 2, top: 3, right: 4, bottom: 5 }, { left: 1, top: 4, right: 8, bottom: 9 }]))), { left: 1, right: 8, top: 3, bottom: 9 });

state.boundaryDrafts = [
  { id: "rect", ...rectangle(2, 2, 12, 12) },
  { id: "invalid", type: "polygon", points: [{ x: 1, y: 1 }] },
  { id: "brush-one", type: "brush", roi: { left: 20, top: 20, right: 30, bottom: 30 }, points: [{ x: 20, y: 20 }], radius: 6 },
  { id: "brush-two", type: "brush", roi: { left: 30, top: 25, right: 40, bottom: 35 }, points: [{ x: 40, y: 35 }], radius: 6 },
  { id: "empty-brush", type: "brush", roi: null, points: [], radius: 6 },
];
const requests = test.boundaryRequests();
assert.deepEqual(JSON.parse(JSON.stringify(requests.map((request) => request.draftIds))), [["rect"], ["brush-one", "brush-two"]], "touching brush drafts are combined into one detector request in drawing order");
state.boundaryDrafts = [
  { id: "left", type: "brush", roi: { left: 0, top: 0, right: 8, bottom: 8 }, points: [{ x: 1, y: 1 }], radius: 4 },
  { id: "right", type: "brush", roi: { left: 20, top: 0, right: 28, bottom: 8 }, points: [{ x: 25, y: 1 }], radius: 4 },
  { id: "bridge", type: "brush", roi: { left: 9, top: 0, right: 19, bottom: 8 }, points: [{ x: 14, y: 1 }], radius: 4 },
];
assert.deepEqual(JSON.parse(JSON.stringify(test.boundaryRequests()[0].draftIds)), ["left", "bridge", "right"], "a bridge stroke merges previously separate brush request groups");

const draw = displayCanvas.ctx;
test.boundaryPath({ type: "polygon", points: validPolygon }, draw);
test.boundaryPath({ type: "brush", points: [{ x: 4, y: 4 }], radius: 4 }, draw);
test.boundaryPath(rectangle(2, 2, 12, 12), draw);
assert.ok(draw.calls.some(([name]) => name === "close"));
assert.ok(draw.calls.some(([name]) => name === "rect"));
test.drawBoundaryScrim([rectangle(2, 2, 12, 12), { type: "brush", points: [{ x: 4, y: 4 }, { x: 8, y: 8 }], radius: 4 }]);
assert.ok(overlayCanvas.ctx.calls.some(([name]) => name === "clip"), "scrim restricts darkening to the image bounds");
test.drawBoundaryShape({ type: "polygon", points: validPolygon });
test.drawBoundaryShape({ type: "polygon", points: [{ x: 1, y: 1 }] });
test.drawBoundaryShape({ type: "brush", points: [{ x: 4, y: 4 }], radius: 4 });
assert.ok(draw.calls.some(([name]) => name === "arc"), "polygon handles are visible for correction");
test.drawBoundaryRoi();

state.boundaryDrafts = [{ id: "draft", ...rectangle(2, 2, 12, 12) }]; state.boundaryActiveId = "draft";
assert.equal(test.canDetectBoundary(), true);
state.boundaryPending = true; assert.equal(test.canDetectBoundary(), false); state.boundaryPending = false;
state.importing = true; assert.equal(test.canDetectBoundary(), false); state.importing = false;
assert.deepEqual(JSON.parse(JSON.stringify(test.boundaryActionAnchor())), { left: 9, right: 29, top: 11, bottom: 31 });
test.updateBoundaryActions();
assert.equal(element("#boundaryActions").hidden, false);
assert.match(element("#boundaryActions").style.left, /px$/);
state.boundaryDrafts = []; state.boundaryActiveId = null; context.document.activeElement = element("#boundaryDetectButton");
test.updateBoundaryActions(); assert.equal(focused, 1, "closing the action menu returns keyboard focus to the canvas");

state.candidates = []; state.removedCandidateIds = new Set(); state.currentId = "image"; state.currentImage = { width: 100, height: 80, alpha: 255 };
context.combinedCanvas.ctx.alpha = 255; state.maskStatus.set("image", true);
assert.equal(test.refreshMaskStatus(false), false, "unchanged mask status updates controls without redrawing the catalogue");

state.hover = { x: 3, y: 4 }; state.tool = "mosaic_eraser"; test.drawBrushCursor();
state.tool = "brush"; test.drawBrushCursor();
state.hover = null; test.drawBrushCursor();
assert.ok(draw.calls.some(([name]) => name === "dash"), "eraser cursors use a dashed ring");

state.blinkCandidateIds = new Set(["manual:apply", "manual:exclude", "manual:excludeErase", "apply", "exclude"]);
state.blinkModes = new Map([["manual:apply", "effective"], ["apply", "effective"]]); state.blinkPhase = true;
state.candidates = [{ id: "apply", role: "apply" }, { id: "exclude", role: "exclude" }, { id: "removed", role: "apply" }, { id: "missing", role: "apply" }];
state.removedCandidateIds = new Set(["removed"]); state.candidateImages = new Map([["apply", { alpha: 255 }], ["exclude", { alpha: 255 }]]);
context.addCanvas.alpha = 255; context.exclusionCanvas.alpha = 255; context.exclusionEraseCanvas.alpha = 255;
test.drawCandidateBlinkOverlay();
assert.ok(context.blinkCtx.calls.some(([name]) => name === "fillRect"), "candidate blinking paints actual mask pixels with each role color");
test.renderNow();
test.render(); test.flushRender();

console.log("test_editor_canvas_geometry_runtime: passed");
