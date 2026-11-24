// Orquestación de la interfaz: fuentes locales, cámara, inferencia y descargas.
// Ninguna imagen, video ni cuadro de cámara sale del navegador.

// El aviso de index.html se desactiva después de enlazar la interfaz.
window.__motoObservadorModuleLoaded = false;

import { Detector, MODEL_DEFS } from "./detector.js";
import { ScenePipeline, MOVEMENT_DEFAULT_THRESHOLD } from "./scene.js";
import { blurHeadRegions, drawScene } from "./draw.js";
import { SessionLog } from "./session-log.js";
import {
  RateMeter,
  browserDescription,
  formatAge,
  formatFps,
  formatMs,
} from "./metrics.js";
import {
  canvasToBlob,
  downloadBlob,
  downloadText,
  safeFileName,
  timestampForFilename,
} from "./utils.js";

const MAX_SOURCE_SIDE = 1600;
const STATS_INTERVAL_MS = 250;
const OVERLAY_INTERVAL_MS = 200;
const STALE_AFTER_MS = 1500;
const FPS_SHORTFALL_RATIO = 0.75;
const FPS_SHORTFALL_MIN_FRAMES = 5;

const el = (id) => document.getElementById(id);

const ui = {
  imageBtn: el("imageBtn"),
  videoBtn: el("videoBtn"),
  cameraBtn: el("cameraBtn"),
  imageInput: el("imageInput"),
  videoInput: el("videoInput"),
  imagePanel: el("imagePanel"),
  imageName: el("imageName"),
  videoPanel: el("videoPanel"),
  videoName: el("videoName"),
  videoMeta: el("videoMeta"),
  cameraPanel: el("cameraPanel"),
  cameraSelect: el("cameraSelect"),
  resolutionSelect: el("resolutionSelect"),
  captureFpsSelect: el("captureFpsSelect"),
  refreshCamerasBtn: el("refreshCamerasBtn"),
  startCameraBtn: el("startCameraBtn"),
  stopCameraBtn: el("stopCameraBtn"),
  cameraStatus: el("cameraStatus"),
  fpsSelect: el("fpsSelect"),
  playbackRateSelect: el("playbackRateSelect"),
  confidenceRange: el("confidenceRange"),
  confidenceValue: el("confidenceValue"),
  movementRange: el("movementRange"),
  movementValue: el("movementValue"),
  helmetCheck: el("helmetCheck"),
  poseCheck: el("poseCheck"),
  trackCheck: el("trackCheck"),
  signalsCheck: el("signalsCheck"),
  faceBlurCheck: el("faceBlurCheck"),
  signalsNote: el("signalsNote"),
  detectorNote: el("detectorNote"),
  stage: el("stage"),
  liveVideo: el("liveVideo"),
  stillImage: el("stillImage"),
  display: el("display"),
  placeholder: el("placeholder"),
  stats: el("stats"),
  fpsWarning: el("fpsWarning"),
  downloadFrameBtn: el("downloadFrameBtn"),
  downloadImageBtn: el("downloadImageBtn"),
  playPauseBtn: el("playPauseBtn"),
  stopVideoBtn: el("stopVideoBtn"),
  recordBtn: el("recordBtn"),
  downloadVideoBtn: el("downloadVideoBtn"),
  recordingStatus: el("recordingStatus"),
  counts: el("counts"),
  motos: el("motos"),
  events: el("events"),
  modelList: el("modelList"),
  runtimeNote: el("runtimeNote"),
  warnings: el("warnings"),
  sessionStatus: el("sessionStatus"),
  sessionDownloadBtn: el("sessionDownloadBtn"),
};

const displayCtx = ui.display.getContext("2d");
const overlay = document.createElement("canvas");
const overlayCtx = overlay.getContext("2d");
// Canvas independiente para la inferencia: nunca contiene cajas dibujadas y no
// compite con el canvas visible ni con el bucle de vista previa.
const analysisCanvas = document.createElement("canvas");
const analysisCtx = analysisCanvas.getContext("2d", { willReadFrequently: true });

const detector = new Detector({
  onModelStatus: (kind, status, detail) => updateModelStatus(kind, status, detail),
});
const pipeline = new ScenePipeline();

const state = {
  mode: null,
  sourceWidth: 0,
  sourceHeight: 0,
  imageObjectUrl: null,
  imageFileName: "",
  videoObjectUrl: null,
  videoFileName: "",
  scene: null,
  counts: null,
  lastResult: null,
  analysisActive: false,
  analyzing: false,
  analysisToken: 0,
  fpsLimit: 5,
  confidence: 0.25,
  movementThreshold: MOVEMENT_DEFAULT_THRESHOLD,
  helmetEnabled: true,
  poseEnabled: false,
  trackEnabled: true,
  signalsEnabled: false,
  faceBlur: false,
  playbackRate: 1,
  cameraStream: null,
  cameraIndex: 0,
  captureRequested: 0,
  captureDeclared: 0,
  sessionLog: null,
  lastSession: null,
  recording: null,
  lastRecording: null,
  renderRunning: false,
  lastVideoTime: -1,
  analyzedFrames: 0,
  analysisStartedAt: 0,
  lastSceneAt: 0,
  lastFrameMs: 0,
  skippedBusy: 0,
  skippedRate: 0,
  nextAnalysisAt: 0,
  statsRenderedAt: 0,
  overlayRenderedAt: 0,
  frameSeq: 0,
  lastAnalyzedSeq: -1,
  analysisLoopHandle: null,
  frameWatch: { kind: null, handle: null },
  captureMeter: new RateMeter(1500),
  previewMeter: new RateMeter(1200),
  analysisMeter: new RateMeter(2500),
  lastModelErrors: {},
  warnings: new Set(),
  imageAnalysisTimer: null,
};

const MODEL_ORDER = ["base", "helmet", "pose"];
const modelRows = new Map();

function createModelRows() {
  ui.modelList.textContent = "";
  for (const kind of MODEL_ORDER) {
    const def = MODEL_DEFS[kind];
    const row = document.createElement("li");
    row.className = "model-row";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = `${def.label} · ${def.size}`;
    const status = document.createElement("span");
    status.className = "status off";
    status.textContent = kind === "base" ? "Sin cargar" : "Desactivado";
    row.append(name, status);
    ui.modelList.append(row);
    modelRows.set(kind, status);
  }
}

function setBadge(kind, text, className) {
  const badge = modelRows.get(kind);
  if (!badge) return;
  badge.textContent = text;
  badge.className = `status ${className}`;
}

function updateModelStatus(kind, status, detail) {
  if (kind === "runtime") {
    ui.runtimeNote.textContent = `Runtime: ${detail}. ONNX Runtime Web ejecuta los modelos en tu navegador.`;
    if (status === "aviso") pushWarning(detail);
    return;
  }
  if (status === "cargando") setBadge(kind, "Cargando…", "loading");
  else if (status === "listo") setBadge(kind, `Listo · ${detail}`, "ready");
  else if (status === "error") setBadge(kind, "Error", "error");
  if (status === "error" && detail) pushWarning(`${MODEL_DEFS[kind]?.label || kind}: ${detail}`);
}

function refreshOptionalModelBadges() {
  for (const [kind, enabled] of [
    ["helmet", state.helmetEnabled],
    ["pose", state.poseEnabled],
  ]) {
    const badge = modelRows.get(kind);
    if (!badge) continue;
    if (!enabled) setBadge(kind, "Desactivado", "off");
    else if (badge.classList.contains("ready") || badge.classList.contains("loading")) continue;
    else setBadge(kind, "Sin cargar", "off");
  }
}

function pushWarning(message) {
  if (!message || state.warnings.has(message)) return;
  state.warnings.add(message);
  const line = document.createElement("p");
  line.textContent = message;
  ui.warnings.append(line);
}

function clearWarnings() {
  state.warnings.clear();
  ui.warnings.textContent = "";
}

function errorText(error) {
  if (!error) return "Error desconocido.";
  const name = error.name || "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return "Permiso de cámara denegado. Permite el acceso en el icono de la barra de direcciones y vuelve a intentarlo.";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "No se encontró ninguna cámara disponible. Conecta una cámara y pulsa «Buscar cámaras».";
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return "La cámara está en uso por otra aplicación o el sistema la bloqueó. Ciérrala en otras apps e inténtalo de nuevo.";
  }
  if (name === "OverconstrainedError") {
    return "La cámara o la resolución solicitada no está disponible. Prueba otra resolución o la cámara predeterminada.";
  }
  if (name === "NotSupportedError") {
    return "Este navegador no admite la captura de cámara solicitada.";
  }
  if (name === "SecurityError") {
    return "El navegador bloqueó la cámara por seguridad. La cámara requiere HTTPS o http://localhost.";
  }
  if (name === "AbortError") return "La operación se interrumpió antes de terminar.";
  const message = String(error.message || error);
  if (/fetch|network|failed to load|404/i.test(message)) {
    return `No se pudo descargar un recurso del sitio (${message}). Comprueba que models/ y vendor/ort/ estén publicados.`;
  }
  return message;
}

function reportError(context, error) {
  console.error(context, error);
  pushWarning(`${context}: ${errorText(error)}`);
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function waitForMetadata(video) {
  if (video.readyState >= 1 && video.videoWidth > 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onLoaded = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(video.error || new Error("No se pudo leer el video."));
    };
    const cleanup = () => {
      video.removeEventListener("loadedmetadata", onLoaded);
      video.removeEventListener("error", onError);
    };
    video.addEventListener("loadedmetadata", onLoaded);
    video.addEventListener("error", onError);
  });
}

function setStageSize(width, height) {
  const largest = Math.max(width, height);
  const scale = largest > MAX_SOURCE_SIDE ? MAX_SOURCE_SIDE / largest : 1;
  state.sourceWidth = Math.max(1, Math.round(width * scale));
  state.sourceHeight = Math.max(1, Math.round(height * scale));
  ui.display.width = state.sourceWidth;
  ui.display.height = state.sourceHeight;
  overlay.width = state.sourceWidth;
  overlay.height = state.sourceHeight;
  analysisCanvas.width = state.sourceWidth;
  analysisCanvas.height = state.sourceHeight;
  ui.stage.style.aspectRatio = `${state.sourceWidth} / ${state.sourceHeight}`;
  ui.placeholder.hidden = true;
}

function resetMetrics() {
  state.captureMeter.reset();
  state.previewMeter.reset();
  state.analysisMeter.reset();
  state.lastSceneAt = 0;
  state.lastFrameMs = 0;
  state.skippedBusy = 0;
  state.skippedRate = 0;
  state.nextAnalysisAt = 0;
  state.statsRenderedAt = 0;
  state.overlayRenderedAt = 0;
  state.frameSeq = 0;
  state.lastAnalyzedSeq = -1;
  state.lastVideoTime = -1;
  state.lastModelErrors = {};
}

function resetScene() {
  state.scene = null;
  state.counts = null;
  state.lastResult = null;
  state.analyzedFrames = 0;
  state.lastVideoTime = -1;
  pipeline.reset();
  resetMetrics();
  overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
  renderCounts(null);
  renderMotos(null);
  renderEvents(null);
  updateStats(null);
}

function drawSourceIntoDisplay() {
  if (state.mode === "image" && ui.stillImage.complete && ui.stillImage.naturalWidth) {
    displayCtx.drawImage(ui.stillImage, 0, 0, state.sourceWidth, state.sourceHeight);
    return true;
  }
  if (
    (state.mode === "video" || state.mode === "camera") &&
    ui.liveVideo.readyState >= 2 &&
    ui.liveVideo.videoWidth
  ) {
    displayCtx.drawImage(ui.liveVideo, 0, 0, state.sourceWidth, state.sourceHeight);
    return true;
  }
  return false;
}

function detectionAgeMs() {
  return state.lastSceneAt ? performance.now() - state.lastSceneAt : null;
}

function detectionIsStale(age) {
  return (
    state.analysisActive &&
    (state.mode === "video" || state.mode === "camera") &&
    age !== null &&
    age > STALE_AFTER_MS
  );
}

function renderOverlay() {
  overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
  if (state.scene) {
    const age = detectionAgeMs();
    drawScene(overlayCtx, state.scene, state.sourceWidth, state.sourceHeight, {
      drawSource: false,
      ageMs: age,
      stale: detectionIsStale(age),
      showAge: state.mode === "video" || state.mode === "camera",
    });
  }
  state.overlayRenderedAt = performance.now();
}

function applyFaceBlur() {
  if (!state.faceBlur || !state.scene?.persons?.length) return;
  blurHeadRegions(displayCtx, state.scene.persons, state.sourceWidth, state.sourceHeight);
}

function renderOnce() {
  drawSourceIntoDisplay();
  applyFaceBlur();
  displayCtx.drawImage(overlay, 0, 0);
}

function renderTick() {
  if (!state.renderRunning) return;
  if (state.mode !== "video" && state.mode !== "camera") {
    state.renderRunning = false;
    return;
  }
  const now = performance.now();
  drawSourceIntoDisplay();
  applyFaceBlur();
  displayCtx.drawImage(overlay, 0, 0);
  state.previewMeter.push(now);
  if (now - state.overlayRenderedAt >= OVERLAY_INTERVAL_MS && state.scene) {
    renderOverlay();
  }
  renderStatsThrottled();
  requestAnimationFrame(renderTick);
}

function startRenderLoop() {
  if (state.renderRunning) return;
  state.renderRunning = true;
  startFrameWatch();
  requestAnimationFrame(renderTick);
}

function stopRenderLoop() {
  state.renderRunning = false;
  stopFrameWatch();
}

// requestVideoFrameCallback entrega una marca por cada cuadro realmente
// presentado por el video o la cámara. Se usa solo para medir la captura y
// saber si hay cuadro nuevo; la inferencia no depende de su ritmo.
function stopFrameWatch() {
  const watch = state.frameWatch;
  if (watch.handle !== null && watch.handle !== undefined) {
    if (watch.kind === "rvfc" && ui.liveVideo.cancelVideoFrameCallback) {
      ui.liveVideo.cancelVideoFrameCallback(watch.handle);
    } else if (watch.kind === "raf") {
      cancelAnimationFrame(watch.handle);
    }
  }
  watch.kind = null;
  watch.handle = null;
}

function startFrameWatch() {
  stopFrameWatch();
  const video = ui.liveVideo;
  if (typeof video.requestVideoFrameCallback === "function") {
    const onFrame = (now) => {
      state.frameWatch.handle = null;
      if (!state.analysisActive) return;
      state.captureMeter.push(now);
      state.frameSeq += 1;
      state.frameWatch.kind = "rvfc";
      state.frameWatch.handle = video.requestVideoFrameCallback(onFrame);
    };
    state.frameWatch.kind = "rvfc";
    state.frameWatch.handle = video.requestVideoFrameCallback(onFrame);
    return;
  }
  // Navegadores sin requestVideoFrameCallback: se aproxima contando cambios de
  // currentTime. La métrica queda marcada como aproximada en el registro.
  const onFrame = (now) => {
    state.frameWatch.handle = null;
    if (!state.analysisActive) return;
    if (video.readyState >= 2 && video.currentTime !== state.lastVideoTime) {
      state.lastVideoTime = video.currentTime;
      state.captureMeter.push(now);
      state.frameSeq += 1;
    }
    state.frameWatch.kind = "raf";
    state.frameWatch.handle = requestAnimationFrame(onFrame);
  };
  state.frameWatch.kind = "raf";
  state.frameWatch.handle = requestAnimationFrame(onFrame);
}

function applyScene(scene) {
  state.scene = scene;
  state.counts = scene.counts;
  renderOverlay();
  if (state.mode === "image") renderOnce();
  renderCounts(scene.counts);
  renderMotos(scene.counts);
  renderEvents(scene.counts);
}

function analysisMetrics() {
  const age = detectionAgeMs();
  const live = state.mode === "video" || state.mode === "camera";
  return {
    targetFps: state.fpsLimit,
    achievedFps: state.analysisMeter.fps,
    captureFps: state.captureMeter.fps,
    previewFps: state.previewMeter.fps,
    captureRequested: state.captureRequested,
    captureDeclared: state.captureDeclared,
    captureApproximate: state.frameWatch.kind === "raf",
    skippedBusy: state.skippedBusy,
    skippedRate: live ? Math.max(0, state.frameSeq - state.analyzedFrames) : 0,
    analyzedFrames: state.analyzedFrames,
    lastFrameMs: state.lastFrameMs,
    detectionAgeMs: age,
    runtime: detector.describeRuntime(),
  };
}

function fpsShortfallMessage(metrics) {
  if (!state.analysisActive) return "";
  if (state.mode !== "video" && state.mode !== "camera") return "";
  if (!state.fpsLimit) return "";
  if (state.analyzedFrames < FPS_SHORTFALL_MIN_FRAMES) return "";
  const achieved = metrics.achievedFps;
  if (!achieved) return "";
  if (achieved >= state.fpsLimit * FPS_SHORTFALL_RATIO) return "";
  return (
    `El análisis real (${formatFps(achieved)}) está por debajo del objetivo ` +
    `(${state.fpsLimit} FPS). Baja el objetivo, reduce la resolución o desactiva casco/pose.`
  );
}

function statPart(label, value, className = "") {
  const span = document.createElement("span");
  if (className) span.className = className;
  const strong = document.createElement("strong");
  strong.textContent = `${label}: `;
  span.append(strong, document.createTextNode(value));
  return span;
}

function updateStats(result) {
  if (!result) {
    ui.stats.textContent = "Sin análisis todavía.";
    if (ui.fpsWarning) {
      ui.fpsWarning.textContent = "";
      ui.fpsWarning.hidden = true;
    }
    return;
  }
  const metrics = analysisMetrics();
  const timings = result.timings || {};
  const live = state.mode === "video" || state.mode === "camera";
  const age = metrics.detectionAgeMs;
  const stale = detectionIsStale(age);
  const parts = [];

  const requested =
    state.mode === "camera" && ui.resolutionSelect.value !== "native"
      ? ` · solicitada ${ui.resolutionSelect.selectedOptions[0]?.textContent || ""}`
      : "";
  parts.push(statPart("Resolución real", `${state.sourceWidth}×${state.sourceHeight}${requested}`));
  parts.push(statPart("Runtime", result.runtime || detector.describeRuntime()));

  if (live) {
    const capture = metrics.captureFps
      ? `${formatFps(metrics.captureFps)} medido` +
        (metrics.captureDeclared ? ` · declarado ${formatFps(metrics.captureDeclared)}` : "")
      : metrics.captureDeclared
        ? `— · declarado ${formatFps(metrics.captureDeclared)}`
        : "—";
    const requestedCapture = metrics.captureRequested
      ? ` · solicitado ${formatFps(metrics.captureRequested)}`
      : "";
    parts.push(statPart("Captura", `${capture}${requestedCapture}`));
    parts.push(statPart("Vista previa", formatFps(metrics.previewFps)));
    parts.push(
      statPart("Análisis objetivo", state.fpsLimit ? `${state.fpsLimit} FPS` : "sin límite"),
    );
    parts.push(
      statPart(
        "Análisis real",
        formatFps(metrics.achievedFps),
        metrics.achievedFps && state.fpsLimit && metrics.achievedFps < state.fpsLimit * FPS_SHORTFALL_RATIO
          ? "stat warn"
          : "",
      ),
    );
    parts.push(
      statPart(
        "Omitidos",
        `${metrics.skippedBusy} por inferencia · ${metrics.skippedRate} por límite`,
      ),
    );
    if (state.mode === "video") {
      parts.push(statPart("Velocidad", `${state.playbackRate}×`));
    }
    parts.push(
      statPart(
        "Última detección",
        age === null ? "—" : `${formatAge(age)}${stale ? " · atrasada" : ""}`,
        stale ? "stat warn" : "",
      ),
    );
  } else {
    parts.push(statPart("Análisis", "1 cuadro"));
  }

  parts.push(statPart("Cuadro completo", formatMs(timings.total ?? metrics.lastFrameMs)));
  parts.push(statPart("Preprocesado", formatMs(timings.preprocess)));
  parts.push(statPart("Base", formatMs(timings.base)));
  if (state.helmetEnabled) parts.push(statPart("Casco", formatMs(timings.helmet)));
  if (state.poseEnabled) parts.push(statPart("Pose", formatMs(timings.pose)));
  parts.push(statPart("Cuadros analizados", String(state.analyzedFrames)));

  ui.stats.textContent = "";
  ui.stats.append(...parts);

  const shortfall = fpsShortfallMessage(metrics);
  if (ui.fpsWarning) {
    ui.fpsWarning.textContent = shortfall;
    ui.fpsWarning.hidden = !shortfall;
  }
}

function renderStatsThrottled(force = false) {
  const now = performance.now();
  if (!force && now - state.statsRenderedAt < STATS_INTERVAL_MS) return;
  state.statsRenderedAt = now;
  updateStats(state.lastResult);
}

function chip(label, value, className = "") {
  const wrap = document.createElement("div");
  wrap.className = `chip ${className}`.trim();
  const labelNode = document.createElement("span");
  labelNode.className = "label";
  labelNode.textContent = label;
  const valueNode = document.createElement("span");
  valueNode.className = "value";
  valueNode.textContent = value;
  wrap.append(labelNode, valueNode);
  return wrap;
}

function renderCounts(counts) {
  ui.counts.textContent = "";
  if (!counts) {
    const empty = document.createElement("span");
    empty.className = "muted";
    empty.textContent = "Sin resultados todavía.";
    ui.counts.append(empty);
    return;
  }
  ui.counts.append(
    chip("Personas", counts.personas),
    chip("Motocicletas", counts.motocicletas),
    chip("En movimiento", counts.enMovimiento),
  );
  if (counts.cascoAnalizado) {
    ui.counts.append(
      chip("Con casco", counts.conCasco, counts.conCasco ? "ok" : ""),
      chip("Sin casco", counts.sinCasco, counts.sinCasco ? "warn" : ""),
      chip("Casco incierto", counts.indeterminado),
    );
  }
  if (counts.poseAnalizada) {
    ui.counts.append(
      chip("Pose estimada", counts.posePersonas),
      chip("Pose parcial", counts.poseParcial),
      chip("Pose no determinada", counts.poseNoDeterminada),
    );
  }
}

function renderMotos(counts) {
  ui.motos.textContent = "";
  const rows = counts?.motosResumen || [];
  if (!rows.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "Sin motocicletas detectadas en este cuadro.";
    ui.motos.append(empty);
    return;
  }
  for (const row of rows) {
    const item = document.createElement("div");
    item.className = "moto-row";
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = row.trackId !== null ? `T${row.trackId}` : `M${row.index}`;
    const detail = document.createElement("div");
    detail.className = "detail";
    const lines = [
      `Ocupantes estimados: ${row.occupants}`,
      row.helmet,
    ];
    if (row.movement) lines.push(row.movement);
    if (row.occupantsUncertain) lines.push("Asociación espacial incierta: revisar.");
    detail.textContent = lines.join(" · ");
    item.append(badge, detail);
    ui.motos.append(item);
  }
}

function renderEvents(counts) {
  ui.events.textContent = "";
  const events = counts?.eventos || [];
  if (!events.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "Sin señales destacadas en este cuadro.";
    ui.events.append(empty);
    return;
  }
  for (const event of events) {
    const item = document.createElement("div");
    item.className = "event-item";
    const parts = [event.type || "señal"];
    if (event.trackId !== null && event.trackId !== undefined) parts.push(`trayectoria T${event.trackId}`);
    if (event.confidence !== undefined && event.confidence !== null) {
      parts.push(`confianza ${Math.round(event.confidence * 100)}%`);
    }
    if (event.detail) parts.push(event.detail);
    item.textContent = parts.join(" · ");
    ui.events.append(item);
  }
}

function activeModelNames() {
  const names = [MODEL_DEFS.base.label];
  if (state.helmetEnabled) names.push(MODEL_DEFS.helmet.label);
  if (state.poseEnabled) names.push(MODEL_DEFS.pose.label);
  return names;
}

// Estado declarado de cada modelo para el registro TXT. Un modelo desactivado
// o que no pudo cargarse se anota como tal; así el registro no hace pasar una
// ausencia de datos por «cero eventos».
function modelStatusList() {
  const defs = [
    ["base", MODEL_DEFS.base.label, true],
    ["helmet", MODEL_DEFS.helmet.label, state.helmetEnabled],
    ["pose", MODEL_DEFS.pose.label, state.poseEnabled],
  ];
  return defs.map(([kind, label, enabled]) => {
    if (!enabled) return { label, status: "desactivado por el usuario" };
    const failure = detector.failures?.[kind];
    if (failure) return { label, status: `no disponible: ${failure}` };
    return { label, status: "incluido; se carga en el primer análisis" };
  });
}

function analysisIntervalMs() {
  return state.fpsLimit ? 1000 / state.fpsLimit : 0;
}

// Copia el cuadro más reciente a un canvas exclusivo de inferencia. Así la
// vista previa puede seguir dibujando a 60 FPS sin arrastrar cajas al modelo.
function captureAnalysisFrame() {
  if (state.mode === "image") {
    if (!ui.stillImage.complete || !ui.stillImage.naturalWidth) return false;
    analysisCtx.drawImage(ui.stillImage, 0, 0, state.sourceWidth, state.sourceHeight);
    return true;
  }
  const video = ui.liveVideo;
  if (video.readyState < 2 || !video.videoWidth) return false;
  analysisCtx.drawImage(video, 0, 0, state.sourceWidth, state.sourceHeight);
  state.lastAnalyzedSeq = state.frameSeq;
  return true;
}

function commitAnalysisTiming(started) {
  const now = performance.now();
  state.lastSceneAt = now;
  state.lastFrameMs = now - started;
  state.analyzedFrames += 1;
  if (state.mode !== "image") state.analysisMeter.push(now);
}

async function runAnalysisTick() {
  if (!state.analysisActive || state.analyzing) return;
  if (state.mode === "video" && (ui.liveVideo.paused || ui.liveVideo.ended)) return;
  if (state.mode === "camera" && !state.cameraStream) return;
  // Sin cuadro nuevo no se repite la inferencia sobre la misma imagen.
  if (state.mode !== "image" && state.frameSeq === state.lastAnalyzedSeq) return;
  if (!captureAnalysisFrame()) return;

  const token = state.analysisToken;
  state.analyzing = true;
  const started = performance.now();
  try {
    const result = await detector.analyze(
      analysisCanvas,
      state.sourceWidth,
      state.sourceHeight,
      {
        confidence: state.confidence,
        helmet: state.helmetEnabled,
        pose: state.poseEnabled,
      },
    );
    if (token !== state.analysisToken || !state.analysisActive) return;
    state.lastResult = result;
    const scene = pipeline.process({
      persons: result.persons,
      motorcycles: result.motorcycles,
      helmets: result.helmets,
      poses: result.poses,
      width: state.sourceWidth,
      height: state.sourceHeight,
      confidence: state.confidence,
      helmetEnabled: state.helmetEnabled,
      poseEnabled: state.poseEnabled,
      track: state.trackEnabled && (state.mode === "video" || state.mode === "camera"),
      signalsEnabled: state.signalsEnabled && state.mode === "camera",
      movementThreshold: state.movementThreshold,
      poseError: result.errors?.pose || "",
    });
    if (token !== state.analysisToken || !state.analysisActive) return;
    commitAnalysisTiming(started);
    applyScene(scene);
    updateStats(result);
    ui.downloadFrameBtn.disabled = false;
    if (state.mode === "image") ui.downloadImageBtn.disabled = false;
    if (state.sessionLog) {
      state.sessionLog.setResolution(state.sourceWidth, state.sourceHeight);
      state.sessionLog.logFrame(scene.counts, performance.now(), analysisMetrics());
    }
    for (const [kind, message] of Object.entries(result.errors || {})) {
      if (!message) continue;
      const label = MODEL_DEFS[kind]?.label || kind;
      pushWarning(`${label}: ${message}`);
      if (state.sessionLog) state.sessionLog.noteModelError(label, message);
    }
  } catch (error) {
    if (token === state.analysisToken) reportError("Análisis", error);
  } finally {
    state.analyzing = false;
  }
}

// Bucle único de análisis: se ejecuta en cada cuadro de pantalla, pero solo
// lanza inferencia cuando toca y hay un cuadro nuevo. Si la inferencia sigue
// ocupada al llegar el turno, ese turno se descarta; nunca se acumula cola.
function analysisLoop() {
  if (!state.analysisActive) {
    state.analysisLoopHandle = null;
    return;
  }
  const now = performance.now();
  const interval = analysisIntervalMs();
  if (now >= state.nextAnalysisAt) {
    if (state.analyzing) {
      state.skippedBusy += 1;
      state.nextAnalysisAt = now + Math.max(interval, 33);
    } else if (state.mode === "video" && ui.liveVideo.ended) {
      finishVideo("Fin del video");
      return;
    } else if (state.mode === "video" && ui.liveVideo.paused) {
      state.nextAnalysisAt = now + 200;
    } else if (state.mode !== "image" && state.frameSeq === state.lastAnalyzedSeq) {
      state.nextAnalysisAt = now + Math.min(interval || 16, 33);
    } else {
      state.nextAnalysisAt = now + interval;
      runAnalysisTick();
    }
  }
  state.analysisLoopHandle = requestAnimationFrame(analysisLoop);
}

function startAnalysisLoop() {
  state.analysisActive = true;
  state.analyzing = false;
  state.nextAnalysisAt = performance.now();
  state.lastAnalyzedSeq = -1;
  if (state.analysisLoopHandle === null) {
    state.analysisLoopHandle = requestAnimationFrame(analysisLoop);
  }
}

async function analyzeImage() {
  if (state.mode !== "image") return;
  if (state.analyzing) return;
  state.analyzing = true;
  const token = ++state.analysisToken;
  const started = performance.now();
  try {
    if (!captureAnalysisFrame()) return;
    const result = await detector.analyze(
      analysisCanvas,
      state.sourceWidth,
      state.sourceHeight,
      {
        confidence: state.confidence,
        helmet: state.helmetEnabled,
        pose: state.poseEnabled,
      },
    );
    if (token !== state.analysisToken || state.mode !== "image") return;
    state.lastResult = result;
    const scene = pipeline.process({
      persons: result.persons,
      motorcycles: result.motorcycles,
      helmets: result.helmets,
      poses: result.poses,
      width: state.sourceWidth,
      height: state.sourceHeight,
      confidence: state.confidence,
      helmetEnabled: state.helmetEnabled,
      poseEnabled: state.poseEnabled,
      track: false,
      signalsEnabled: false,
      movementThreshold: state.movementThreshold,
      poseError: result.errors?.pose || "",
    });
    commitAnalysisTiming(started);
    applyScene(scene);
    updateStats(result);
    ui.downloadFrameBtn.disabled = false;
    ui.downloadImageBtn.disabled = false;
    for (const [kind, message] of Object.entries(result.errors || {})) {
      if (message) pushWarning(`${MODEL_DEFS[kind]?.label || kind}: ${message}`);
    }
  } catch (error) {
    reportError("Análisis de imagen", error);
  } finally {
    state.analyzing = false;
  }
}

function scheduleImageReanalysis() {
  if (state.mode !== "image") return;
  clearTimeout(state.imageAnalysisTimer);
  state.imageAnalysisTimer = setTimeout(() => {
    if (state.analyzing) {
      scheduleImageReanalysis();
      return;
    }
    analyzeImage();
  }, 220);
}

async function analyzeImageWhenIdle() {
  // Una imagen nueva puede seleccionarse mientras la anterior aún se está
  // analizando. Se espera a que la inferencia en curso termine para no
  // compartir el búfer de preprocesado entre dos ejecuciones.
  while (state.analyzing) {
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  if (state.mode === "image") await analyzeImage();
}

function stopAnalysisLoop() {
  state.analysisActive = false;
  state.analysisToken += 1;
  if (state.analysisLoopHandle !== null) {
    cancelAnimationFrame(state.analysisLoopHandle);
    state.analysisLoopHandle = null;
  }
  stopFrameWatch();
}

function resetVideoElement() {
  ui.liveVideo.pause();
  ui.liveVideo.removeAttribute("src");
  ui.liveVideo.srcObject = null;
  ui.liveVideo.load();
  if (state.videoObjectUrl) {
    URL.revokeObjectURL(state.videoObjectUrl);
    state.videoObjectUrl = null;
  }
}

function stopVideoAnalysis(reason) {
  if (state.mode !== "video") return;
  stopRecording();
  stopAnalysisLoop();
  ui.liveVideo.pause();
  ui.playPauseBtn.textContent = "Reproducir";
  ui.playPauseBtn.disabled = true;
  ui.stopVideoBtn.disabled = true;
  ui.recordBtn.disabled = true;
  ui.videoMeta.textContent = reason || "Análisis detenido.";
  state.mode = null;
  stopRenderLoop();
  renderOnce();
}

function finishVideo(reason) {
  stopVideoAnalysis(reason);
  ui.videoMeta.textContent = reason;
}

async function loadImageFile(file) {
  stopCamera("Cambio de fuente");
  stopVideoAnalysis("Cambio de fuente");
  stopAnalysisLoop();
  clearWarnings();
  state.mode = null;
  resetScene();
  state.analysisToken += 1;

  if (state.imageObjectUrl) URL.revokeObjectURL(state.imageObjectUrl);
  state.imageObjectUrl = URL.createObjectURL(file);
  ui.stillImage.src = state.imageObjectUrl;
  try {
    await ui.stillImage.decode();
  } catch (error) {
    reportError("No se pudo abrir la imagen", error);
    return;
  }
  state.imageFileName = file.name || "imagen";
  state.mode = "image";
  setStageSize(ui.stillImage.naturalWidth, ui.stillImage.naturalHeight);
  ui.imagePanel.hidden = false;
  ui.imageName.textContent = `${state.imageFileName} · ${state.sourceWidth}×${state.sourceHeight}`;
  ui.videoPanel.hidden = true;
  closeCameraPanel();
  ui.playPauseBtn.disabled = true;
  ui.stopVideoBtn.disabled = true;
  ui.recordBtn.disabled = true;
  ui.downloadImageBtn.disabled = true;
  ui.downloadFrameBtn.disabled = true;
  renderOnce();
  await analyzeImageWhenIdle();
}

async function loadVideoFile(file) {
  stopCamera("Cambio de fuente");
  stopVideoAnalysis("Cambio de fuente");
  stopAnalysisLoop();
  clearWarnings();
  state.mode = null;
  resetScene();
  state.analysisToken += 1;
  resetVideoElement();

  state.videoObjectUrl = URL.createObjectURL(file);
  state.videoFileName = file.name || "video";
  ui.liveVideo.src = state.videoObjectUrl;
  ui.liveVideo.load();
  try {
    await waitForMetadata(ui.liveVideo);
  } catch (error) {
    reportError("No se pudo abrir el video", error);
    return;
  }
  state.mode = "video";
  state.playbackRate = Number(ui.playbackRateSelect?.value) || 1;
  ui.liveVideo.playbackRate = state.playbackRate;
  setStageSize(ui.liveVideo.videoWidth, ui.liveVideo.videoHeight);
  ui.videoPanel.hidden = false;
  ui.imagePanel.hidden = true;
  closeCameraPanel();
  ui.videoName.textContent = `${state.videoFileName} · ${ui.liveVideo.videoWidth}×${ui.liveVideo.videoHeight}`;
  ui.videoMeta.textContent = `Duración: ${formatDuration(ui.liveVideo.duration)} · análisis local`;
  ui.playPauseBtn.disabled = false;
  ui.playPauseBtn.textContent = "Pausar";
  ui.stopVideoBtn.disabled = false;
  ui.recordBtn.disabled = !canRecord();
  state.lastRecording = null;
  ui.downloadVideoBtn.disabled = true;
  ui.downloadFrameBtn.disabled = true;
  ui.downloadImageBtn.disabled = true;
  updateRecordingStatus("");

  pipeline.reset();
  pipeline.configure({ fpsLimit: state.fpsLimit });
  state.analysisToken += 1;
  state.analysisStartedAt = performance.now();
  state.analyzedFrames = 0;
  state.captureRequested = 0;
  state.captureDeclared = 0;
  resetMetrics();
  try {
    await ui.liveVideo.play();
  } catch (error) {
    reportError("No se pudo reproducir el video", error);
  }
  startRenderLoop();
  startAnalysisLoop();
}

function setCameraStatus(message, kind = "") {
  ui.cameraStatus.textContent = message;
  ui.cameraStatus.className = `camera-status${kind ? ` status-${kind}` : ""}`;
}

function setCameraControls({ busy = false, active = Boolean(state.cameraStream) } = {}) {
  ui.startCameraBtn.disabled = busy || active;
  ui.stopCameraBtn.disabled = busy || !active;
  ui.refreshCamerasBtn.disabled = busy;
  ui.cameraSelect.disabled = busy || active;
  ui.resolutionSelect.disabled = busy || active;
  if (ui.captureFpsSelect) ui.captureFpsSelect.disabled = busy || active;
}

function scrollToCameraPanel() {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  ui.cameraPanel.scrollIntoView({
    behavior: reduceMotion ? "auto" : "smooth",
    block: "center",
  });
}

// «Usar cámara» solo muestra y enfoca el panel de configuración. No pide permiso
// ni abre la cámara: eso ocurre únicamente al pulsar «Iniciar cámara».
function openCameraPanel({ focus = true } = {}) {
  ui.cameraPanel.hidden = false;
  ui.cameraPanel.classList.add("is-open");
  ui.cameraBtn.setAttribute("aria-expanded", "true");
  scrollToCameraPanel();

  if (state.cameraStream) {
    setCameraStatus(
      "La cámara ya está activa. Pulsa «Detener cámara» para cerrar la sesión y descargar el registro TXT.",
      "ok",
    );
    if (focus) ui.stopCameraBtn.focus({ preventScroll: true });
    return;
  }
  if (!window.isSecureContext) {
    setCameraStatus(
      "La cámara requiere un contexto seguro (HTTPS o http://localhost). Esta página no lo es.",
      "error",
    );
  } else if (!navigator.mediaDevices?.getUserMedia) {
    setCameraStatus("Este navegador no permite usar la cámara desde la web.", "error");
  } else {
    setCameraStatus(
      "Paso 2: pulsa «Iniciar cámara» para solicitar permiso. La captura no empieza sola.",
    );
  }
  if (focus && !ui.startCameraBtn.disabled) {
    ui.startCameraBtn.focus({ preventScroll: true });
  }
  listCameras({ announce: true });
}

function closeCameraPanel() {
  ui.cameraPanel.hidden = true;
  ui.cameraPanel.classList.remove("is-open");
  ui.cameraBtn.setAttribute("aria-expanded", "false");
}

async function listCameras({ requestPermission = false, announce = false } = {}) {
  if (!navigator.mediaDevices?.enumerateDevices) {
    if (announce) setCameraStatus("Este navegador no permite enumerar cámaras.", "error");
    return;
  }
  if (requestPermission && !state.cameraStream) {
    setCameraControls({ busy: true, active: false });
    setCameraStatus("Solicitando permiso para enumerar cámaras…", "busy");
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      probe.getTracks().forEach((track) => track.stop());
      setCameraStatus("Permiso concedido. Elige la cámara y pulsa «Iniciar cámara».", "");
    } catch (error) {
      setCameraStatus(errorText(error), "error");
      reportError("Permiso de cámara", error);
    } finally {
      setCameraControls({ busy: false, active: false });
    }
  }
  const selected = ui.cameraSelect.value;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter((device) => device.kind === "videoinput");
    ui.cameraSelect.textContent = "";
    const fallback = document.createElement("option");
    fallback.value = "";
    fallback.textContent = "Cámara predeterminada";
    ui.cameraSelect.append(fallback);
    cameras.forEach((camera, index) => {
      const option = document.createElement("option");
      option.value = camera.deviceId;
      option.textContent = camera.label || `Cámara ${index + 1}`;
      ui.cameraSelect.append(option);
    });
    if ([...ui.cameraSelect.options].some((option) => option.value === selected)) {
      ui.cameraSelect.value = selected;
    }
    if (!cameras.length && announce) {
      setCameraStatus(
        "No se detectaron cámaras. Conecta una y pulsa «Buscar cámaras».",
        "error",
      );
    }
  } catch (error) {
    if (announce) setCameraStatus(errorText(error), "error");
    reportError("Búsqueda de cámaras", error);
  }
}

function requestedCaptureFps() {
  const value = Number(ui.captureFpsSelect?.value) || 0;
  return value > 0 ? value : 0;
}

function cameraConstraints({ relaxed = false } = {}) {
  const video = {};
  const selectedId = ui.cameraSelect.value;
  if (!relaxed && selectedId) video.deviceId = { exact: selectedId };
  else video.facingMode = { ideal: "environment" };
  if (!relaxed) {
    const value = ui.resolutionSelect.value;
    if (value !== "native") {
      const [width, height] = value.split("x").map(Number);
      video.width = { ideal: width };
      video.height = { ideal: height };
    }
    // La frecuencia de captura es una preferencia del navegador y no cambia el
    // FPS de análisis. Se pide como «ideal», nunca «exact», y la resolución no
    // se reduce para conseguirla.
    const fps = requestedCaptureFps();
    if (fps) video.frameRate = { ideal: fps };
  }
  return { audio: false, video };
}

function releaseCameraStream() {
  const stream = state.cameraStream;
  state.cameraStream = null;
  if (stream) stream.getTracks().forEach((track) => track.stop());
  ui.liveVideo.srcObject = null;
}

function failCameraStart(error) {
  setCameraControls({ busy: false, active: false });
  const message = errorText(error);
  setCameraStatus(message, "error");
  pushWarning(`No se pudo iniciar la cámara: ${message}`);
  if (!ui.startCameraBtn.disabled) {
    ui.startCameraBtn.focus({ preventScroll: true });
  }
}

async function startCamera() {
  if (state.cameraStream) {
    setCameraStatus(
      "La cámara ya está activa. Pulsa «Detener cámara» para cerrar la sesión.",
      "ok",
    );
    return;
  }
  if (!window.isSecureContext) {
    const message =
      "No se puede abrir la cámara: la página no está en un contexto seguro. Usa HTTPS o http://localhost.";
    setCameraStatus(message, "error");
    pushWarning(message);
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    const message =
      "Este navegador no ofrece acceso a la cámara (getUserMedia). Prueba otro navegador o abre el sitio por HTTPS.";
    setCameraStatus(message, "error");
    pushWarning(message);
    return;
  }

  stopVideoAnalysis("Cambio de fuente");
  resetVideoElement();
  stopAnalysisLoop();
  clearWarnings();
  resetScene();
  state.analysisToken += 1;
  setCameraControls({ busy: true, active: false });
  setCameraStatus("Solicitando permiso…", "busy");

  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia(cameraConstraints());
  } catch (error) {
    if (error?.name === "OverconstrainedError") {
      setCameraStatus(
        "La cámara o la resolución elegida no está disponible; se reintenta con la cámara predeterminada…",
        "busy",
      );
      try {
        stream = await navigator.mediaDevices.getUserMedia(
          cameraConstraints({ relaxed: true }),
        );
      } catch (second) {
        failCameraStart(second);
        return;
      }
    } else {
      failCameraStart(error);
      return;
    }
  }

  state.cameraStream = stream;
  ui.liveVideo.srcObject = stream;
  setCameraStatus("Permiso concedido. Abriendo la cámara…", "busy");

  try {
    await ui.liveVideo.play();
    await waitForMetadata(ui.liveVideo);
  } catch (error) {
    releaseCameraStream();
    failCameraStart(error);
    return;
  }
  if (!ui.liveVideo.videoWidth) {
    releaseCameraStream();
    failCameraStart(new Error("La cámara no entregó un tamaño de cuadro válido."));
    return;
  }

  const videoTrack = stream.getVideoTracks()[0];
  const settings = videoTrack?.getSettings?.() || {};
  state.captureRequested = requestedCaptureFps();
  state.captureDeclared = Number(settings.frameRate) || 0;

  state.mode = "camera";
  setStageSize(ui.liveVideo.videoWidth, ui.liveVideo.videoHeight);
  ui.cameraPanel.hidden = false;
  ui.cameraPanel.classList.add("is-open");
  ui.cameraBtn.setAttribute("aria-expanded", "true");
  ui.imagePanel.hidden = true;
  ui.videoPanel.hidden = true;
  setCameraControls({ busy: false, active: true });
  ui.downloadFrameBtn.disabled = true;
  ui.downloadImageBtn.disabled = true;

  // Se actualizan las etiquetas de las cámaras antes de fijar el estado
  // activo, para que el mensaje de la sesión no sea sobrescrito.
  await listCameras();

  const selectedIndex = [...ui.cameraSelect.options].findIndex(
    (option) => option.value === ui.cameraSelect.value,
  );
  state.cameraIndex = Math.max(0, selectedIndex);
  const label =
    ui.cameraSelect.selectedOptions[0]?.textContent || `índice ${state.cameraIndex}`;
  setCameraStatus(
    `Cámara activa · resolución real ${state.sourceWidth}×${state.sourceHeight} · ` +
      `solicitada ${ui.resolutionSelect.selectedOptions[0]?.textContent || "nativa"} · ` +
      `captura ${state.captureDeclared ? `${state.captureDeclared} FPS declarados` : "sin dato"} · ` +
      `análisis objetivo ${state.fpsLimit ? `${state.fpsLimit} FPS` : "sin límite"}.`,
    "ok",
  );

  state.sessionLog = new SessionLog({
    cameraIndex: state.cameraIndex,
    cameraLabel: `${label} (${state.sourceWidth}×${state.sourceHeight})`,
  });
  state.sessionLog.start({
    resolution: { width: state.sourceWidth, height: state.sourceHeight },
    fpsTarget: state.fpsLimit,
    captureRequested: state.captureRequested,
    captureDeclared: state.captureDeclared,
    models: modelStatusList(),
    runtime: detector.describeRuntime(),
    browser: browserDescription(),
  });
  ui.sessionStatus.textContent =
    "Sesión de cámara en curso. Al detenerla se descargará el registro TXT.";
  ui.sessionDownloadBtn.disabled = true;

  pipeline.reset();
  pipeline.configure({ fpsLimit: state.fpsLimit });
  state.analysisToken += 1;
  state.analysisStartedAt = performance.now();
  state.analyzedFrames = 0;
  resetMetrics();
  startRenderLoop();
  startAnalysisLoop();

  if (videoTrack) {
    videoTrack.addEventListener("ended", () => {
      if (state.cameraStream === stream) {
        stopCamera("La cámara se desconectó");
      }
    });
  }
}

function stopCamera(reason = "Detener cámara") {
  if (!state.cameraStream) return;
  const metrics = analysisMetrics();
  stopAnalysisLoop();
  const counts = state.counts;
  const stream = state.cameraStream;
  state.cameraStream = null;
  stream.getTracks().forEach((track) => track.stop());
  ui.liveVideo.srcObject = null;
  state.mode = null;
  stopRenderLoop();
  renderOnce();

  setCameraControls({ busy: false, active: false });
  ui.downloadFrameBtn.disabled = !state.lastResult;
  setCameraStatus(
    `Cámara detenida · última resolución ${state.sourceWidth}×${state.sourceHeight}.`,
    "ok",
  );
  if (!ui.startCameraBtn.disabled) {
    ui.startCameraBtn.focus({ preventScroll: true });
  }

  if (state.sessionLog) {
    const text = state.sessionLog.finish(reason, counts, metrics);
    const filename = state.sessionLog.filename();
    state.lastSession = { text, filename };
    state.sessionLog = null;
    downloadText(text, filename);
    ui.sessionDownloadBtn.disabled = false;
    ui.sessionStatus.textContent =
      `Registro descargado: ${filename}. Puedes volver a descargarlo con el botón.`;
  }
}

function canRecord() {
  return Boolean(ui.display.captureStream && window.MediaRecorder);
}

function pickMimeType() {
  const candidates = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
    "video/mp4;codecs=avc1.42E01E",
    "video/mp4",
  ];
  for (const type of candidates) {
    if (window.MediaRecorder?.isTypeSupported?.(type)) {
      return type;
    }
  }
  return "";
}

function updateRecordingStatus(text) {
  if (!ui.recordingStatus) return;
  ui.recordingStatus.textContent = text;
  ui.recordingStatus.classList.toggle("active", Boolean(text));
}

function startRecording() {
  if (!canRecord()) {
    pushWarning("Este navegador no permite grabar el canvas. Usa «Descargar fotograma anotado».");
    return;
  }
  if (state.recording) return;
  if (state.mode !== "video") {
    pushWarning("La grabación del canvas está disponible durante el análisis de un video.");
    return;
  }
  const mimeType = pickMimeType();
  if (!mimeType) {
    pushWarning("El navegador no ofrece un formato de grabación compatible.");
    return;
  }
  let stream;
  try {
    stream = ui.display.captureStream(30);
  } catch (error) {
    reportError("No se pudo capturar el canvas", error);
    return;
  }
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: 5_000_000,
  });
  const chunks = [];
  const extension = mimeType.includes("mp4") ? "mp4" : "webm";
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data && event.data.size) chunks.push(event.data);
  });
  recorder.addEventListener("stop", () => {
    stream.getTracks().forEach((track) => track.stop());
    if (chunks.length) {
      const blob = new Blob(chunks, { type: mimeType });
      state.lastRecording = {
        blob,
        filename: `video_anotado_${timestampForFilename()}.${extension}`,
      };
      ui.downloadVideoBtn.disabled = false;
      updateRecordingStatus(
        `Grabación lista (${(blob.size / (1024 * 1024)).toFixed(1)} MB). Pulsa «Descargar video anotado».`,
      );
    } else {
      updateRecordingStatus("La grabación no produjo datos.");
    }
    state.recording = null;
    ui.recordBtn.textContent = "Grabar video anotado";
  });
  recorder.addEventListener("error", (event) => {
    reportError("Grabación", event.error || new Error("MediaRecorder falló."));
    state.recording = null;
    ui.recordBtn.textContent = "Grabar video anotado";
  });
  recorder.start(1000);
  state.recording = { recorder, mimeType, extension };
  ui.recordBtn.textContent = "Detener grabación";
  ui.downloadVideoBtn.disabled = true;
  updateRecordingStatus(
    "Grabando el canvas anotado en tiempo real. Mantén esta pestaña visible.",
  );
}

function stopRecording() {
  if (!state.recording) return;
  const recorder = state.recording.recorder;
  if (recorder.state !== "inactive") recorder.stop();
}

async function downloadAnnotatedFrame(prefix = "fotograma_anotado") {
  if (!state.lastResult) {
    pushWarning("Todavía no hay un cuadro analizado para descargar.");
    return;
  }
  try {
    const blob = await canvasToBlob(ui.display, "image/png");
    downloadBlob(blob, `${prefix}_${timestampForFilename()}.png`);
  } catch (error) {
    reportError("Descarga del cuadro", error);
  }
}

async function downloadAnnotatedImage() {
  if (state.mode !== "image" || !state.lastResult) return;
  try {
    const blob = await canvasToBlob(ui.display, "image/png");
    const base = safeFileName(state.imageFileName.replace(/\.[^.]+$/, ""), "imagen");
    downloadBlob(blob, `${base}_anotada.png`);
  } catch (error) {
    reportError("Descarga de la imagen", error);
  }
}

function wireEvents() {
  ui.imageBtn.addEventListener("click", () => ui.imageInput.click());
  ui.videoBtn.addEventListener("click", () => ui.videoInput.click());
  ui.cameraBtn.addEventListener("click", () => {
    if (!ui.cameraPanel.hidden) {
      // Ya estaba abierto: no se reinicia el estado para no borrar un error o
      // una instrucción en curso; solo se vuelve a enfocar el panel.
      scrollToCameraPanel();
      if (state.cameraStream) ui.stopCameraBtn.focus({ preventScroll: true });
      else if (!ui.startCameraBtn.disabled) {
        ui.startCameraBtn.focus({ preventScroll: true });
      }
      return;
    }
    openCameraPanel();
  });

  ui.imageInput.addEventListener("change", () => {
    const file = ui.imageInput.files?.[0];
    if (file) loadImageFile(file);
    ui.imageInput.value = "";
  });
  ui.videoInput.addEventListener("change", () => {
    const file = ui.videoInput.files?.[0];
    if (file) loadVideoFile(file);
    ui.videoInput.value = "";
  });

  ui.playPauseBtn.addEventListener("click", async () => {
    if (state.mode !== "video") return;
    if (ui.liveVideo.paused) {
      if (ui.liveVideo.ended) {
        ui.liveVideo.currentTime = 0;
        pipeline.reset();
        resetScene();
      }
      try {
        await ui.liveVideo.play();
        ui.playPauseBtn.textContent = "Pausar";
      } catch (error) {
        reportError("Reproducción", error);
      }
    } else {
      ui.liveVideo.pause();
      ui.playPauseBtn.textContent = "Reproducir";
    }
  });

  ui.stopVideoBtn.addEventListener("click", () => {
    if (state.mode === "video") {
      stopVideoAnalysis("Análisis detenido por el usuario");
    }
  });

  ui.recordBtn.addEventListener("click", () => {
    if (state.recording) stopRecording();
    else startRecording();
  });

  ui.downloadVideoBtn.addEventListener("click", () => {
    if (state.lastRecording) {
      downloadBlob(state.lastRecording.blob, state.lastRecording.filename);
    }
  });

  ui.downloadFrameBtn.addEventListener("click", () => downloadAnnotatedFrame());
  ui.downloadImageBtn.addEventListener("click", downloadAnnotatedImage);

  ui.sessionDownloadBtn.addEventListener("click", () => {
    if (state.lastSession) {
      downloadText(state.lastSession.text, state.lastSession.filename);
    }
  });

  ui.refreshCamerasBtn.addEventListener("click", () =>
    listCameras({ requestPermission: true, announce: true }),
  );
  ui.startCameraBtn.addEventListener("click", startCamera);
  ui.stopCameraBtn.addEventListener("click", () => stopCamera("Detener cámara"));

  ui.fpsSelect.addEventListener("change", () => {
    state.fpsLimit = Number(ui.fpsSelect.value) || 0;
    pipeline.configure({ fpsLimit: state.fpsLimit });
    state.nextAnalysisAt = performance.now();
  });

  ui.playbackRateSelect?.addEventListener("change", () => {
    state.playbackRate = Number(ui.playbackRateSelect.value) || 1;
    if (state.mode === "video") ui.liveVideo.playbackRate = state.playbackRate;
    renderStatsThrottled(true);
  });

  ui.captureFpsSelect?.addEventListener("change", () => {
    if (state.cameraStream) {
      setCameraStatus(
        "La frecuencia de captura se fija al iniciar la cámara. Detén y vuelve a iniciar para aplicarla.",
        "",
      );
    }
  });

  ui.confidenceRange.addEventListener("input", () => {
    state.confidence = Number(ui.confidenceRange.value) / 100;
    ui.confidenceValue.textContent = `${ui.confidenceRange.value}%`;
    scheduleImageReanalysis();
  });

  ui.movementRange.addEventListener("input", () => {
    state.movementThreshold = Number(ui.movementRange.value) / 1000;
    ui.movementValue.textContent = `${(Number(ui.movementRange.value) / 10).toFixed(1)}%`;
  });

  ui.helmetCheck.addEventListener("change", () => {
    state.helmetEnabled = ui.helmetCheck.checked;
    refreshOptionalModelBadges();
    scheduleImageReanalysis();
  });

  ui.poseCheck.addEventListener("change", () => {
    state.poseEnabled = ui.poseCheck.checked;
    if (!state.poseEnabled) {
      state.faceBlur = false;
      if (ui.faceBlurCheck) ui.faceBlurCheck.checked = false;
      state.signalsEnabled = false;
      if (ui.signalsCheck) ui.signalsCheck.checked = false;
      if (ui.signalsNote) {
        ui.signalsNote.textContent = "Señales temporales desactivadas. No detectan peleas, armas, intención, asaltos ni intervenciones policiales.";
      }
    }
    refreshOptionalModelBadges();
    scheduleImageReanalysis();
    if (state.mode === "image") renderOnce();
  });

  ui.trackCheck?.addEventListener("change", () => {
    state.trackEnabled = ui.trackCheck.checked;
    if (!state.trackEnabled) pipeline.reset();
    scheduleImageReanalysis();
  });

  ui.signalsCheck?.addEventListener("change", () => {
    state.signalsEnabled = ui.signalsCheck.checked;
    if (state.signalsEnabled) {
      state.poseEnabled = true;
      state.trackEnabled = true;
      ui.poseCheck.checked = true;
      if (ui.trackCheck) ui.trackCheck.checked = true;
      refreshOptionalModelBadges();
    }
    if (!state.signalsEnabled) pipeline.reset();
    if (ui.signalsNote) {
      ui.signalsNote.textContent = state.signalsEnabled
        ? "Señales activas: se habilitaron pose y seguimiento. Solo funcionan en cámara y requieren persistencia; son observaciones geométricas para revisión humana."
        : "Señales temporales desactivadas.";
    }
    scheduleImageReanalysis();
  });

  ui.faceBlurCheck?.addEventListener("change", () => {
    state.faceBlur = ui.faceBlurCheck.checked;
    if (state.faceBlur && !state.poseEnabled) {
      state.poseEnabled = true;
      ui.poseCheck.checked = true;
      refreshOptionalModelBadges();
    }
    if (ui.detectorNote && state.faceBlur) {
      ui.detectorNote.textContent = "La pixelación usa puntos de pose para estimar la región de la cabeza. No detecta rostros ni garantiza cubrirlos por completo; activa pose implica descargar su modelo.";
    } else if (ui.detectorNote) {
      ui.detectorNote.textContent = "La pose está desactivada por defecto y su modelo solo se descarga al activarla. La primera preparación puede tardar en algunos equipos. El casco se asocia geométricamente a cada persona; la ausencia de detección no demuestra que no haya casco.";
    }
    scheduleImageReanalysis();
    if (state.mode === "image") renderOnce();
  });

  ui.liveVideo.addEventListener("ended", () => {
    if (state.mode === "video") finishVideo("Fin del video");
  });

  window.addEventListener("beforeunload", () => {
    if (state.cameraStream) {
      state.cameraStream.getTracks().forEach((track) => track.stop());
    }
    if (state.recording) stopRecording();
  });
}

async function init() {
  createModelRows();
  wireEvents();
  window.__motoObservadorModuleLoaded = true;
  state.confidence = Number(ui.confidenceRange.value) / 100;
  state.movementThreshold = Number(ui.movementRange.value) / 1000;
  ui.confidenceValue.textContent = `${ui.confidenceRange.value}%`;
  ui.movementValue.textContent = `${(Number(ui.movementRange.value) / 10).toFixed(1)}%`;
  state.helmetEnabled = ui.helmetCheck.checked;
  state.poseEnabled = ui.poseCheck.checked;
  state.trackEnabled = ui.trackCheck ? ui.trackCheck.checked : true;
  state.signalsEnabled = ui.signalsCheck ? ui.signalsCheck.checked : false;
  state.faceBlur = ui.faceBlurCheck ? ui.faceBlurCheck.checked : false;
  state.fpsLimit = Number(ui.fpsSelect.value) || 0;
  state.playbackRate = Number(ui.playbackRateSelect?.value) || 1;
  refreshOptionalModelBadges();

  if (!window.ort) {
    pushWarning(
      "No se cargó ONNX Runtime Web. Comprueba que vendor/ort/ort.min.js exista y que el sitio se sirva por HTTP(S).",
    );
    ui.runtimeNote.textContent = "Runtime no disponible.";
    return;
  }
  try {
    await detector.init();
    ui.runtimeNote.textContent =
      `Runtime: ${detector.describeRuntime()}. ONNX Runtime Web ejecuta los modelos en tu navegador; ` +
      "las imágenes no se envían a ningún servidor.";
    if (detector.ep === "wasm") {
      pushWarning(
        "WebGPU no está disponible en este navegador; se usará WebAssembly (CPU). El análisis puede ser más lento.",
      );
    }
  } catch (error) {
    reportError("Inicialización del runtime", error);
  }

  if (!window.isSecureContext) {
    pushWarning(
      "La página no está en un contexto seguro. La cámara solo funciona con HTTPS o http://localhost; " +
        "las imágenes y los videos locales sí pueden analizarse.",
    );
  }
  setCameraControls({ busy: false, active: false });
  await listCameras();
}

init();
