// Orquestación de la interfaz: fuentes locales, cámara, inferencia y descargas.
// Ninguna imagen, video ni cuadro de cámara sale del navegador.

// Marca que el módulo se cargó; el aviso de index.html la usa para distinguir
// «módulos bloqueados o con error» de «la app sigue inicializando».
window.__motoObservadorModuleLoaded = true;

import { Detector, MODEL_DEFS } from "./detector.js";
import { ScenePipeline, MOVEMENT_DEFAULT_THRESHOLD } from "./scene.js";
import { drawScene } from "./draw.js";
import { SessionLog } from "./session-log.js";
import {
  canvasToBlob,
  downloadBlob,
  downloadText,
  safeFileName,
  timestampForFilename,
} from "./utils.js";

const MAX_SOURCE_SIDE = 1600;
const ANALYSIS_HISTORY = 20;

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
  refreshCamerasBtn: el("refreshCamerasBtn"),
  startCameraBtn: el("startCameraBtn"),
  stopCameraBtn: el("stopCameraBtn"),
  cameraStatus: el("cameraStatus"),
  fpsSelect: el("fpsSelect"),
  confidenceRange: el("confidenceRange"),
  confidenceValue: el("confidenceValue"),
  movementRange: el("movementRange"),
  movementValue: el("movementValue"),
  helmetCheck: el("helmetCheck"),
  poseCheck: el("poseCheck"),
  detectorNote: el("detectorNote"),
  stage: el("stage"),
  liveVideo: el("liveVideo"),
  stillImage: el("stillImage"),
  display: el("display"),
  placeholder: el("placeholder"),
  stats: el("stats"),
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
  analysisTimer: null,
  analysisToken: 0,
  fpsLimit: 5,
  confidence: 0.25,
  movementThreshold: MOVEMENT_DEFAULT_THRESHOLD,
  helmetEnabled: true,
  poseEnabled: false,
  cameraStream: null,
  cameraIndex: 0,
  sessionLog: null,
  lastSession: null,
  recording: null,
  lastRecording: null,
  renderRunning: false,
  lastVideoTime: -1,
  completions: [],
  analyzedFrames: 0,
  analysisStartedAt: 0,
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
  ui.stage.style.aspectRatio = `${state.sourceWidth} / ${state.sourceHeight}`;
  ui.placeholder.hidden = true;
}

function resetScene() {
  state.scene = null;
  state.counts = null;
  state.lastResult = null;
  state.completions = [];
  state.analyzedFrames = 0;
  state.lastVideoTime = -1;
  pipeline.reset();
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

function renderOverlay() {
  overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
  if (state.scene) {
    drawScene(overlayCtx, state.scene, state.sourceWidth, state.sourceHeight, {
      drawSource: false,
    });
  }
}

function renderOnce() {
  drawSourceIntoDisplay();
  displayCtx.drawImage(overlay, 0, 0);
}

function renderTick() {
  if (!state.renderRunning) return;
  if (state.mode !== "video" && state.mode !== "camera") {
    state.renderRunning = false;
    return;
  }
  drawSourceIntoDisplay();
  displayCtx.drawImage(overlay, 0, 0);
  requestAnimationFrame(renderTick);
}

function startRenderLoop() {
  if (state.renderRunning) return;
  state.renderRunning = true;
  requestAnimationFrame(renderTick);
}

function stopRenderLoop() {
  state.renderRunning = false;
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

function updateStats(result) {
  if (!result) {
    ui.stats.textContent = "Sin análisis todavía.";
    return;
  }
  const fps = currentFps();
  const timings = result.timings || {};
  const parts = [
    ["Resolución", `${state.sourceWidth}×${state.sourceHeight}`],
    ["Runtime", result.runtime || detector.describeRuntime()],
    ["FPS análisis", fps ? fps.toFixed(1) : "—"],
    ["Inferencia", `${Math.round(timings.base + timings.helmet + timings.pose)} ms`],
    ["Cuadros analizados", String(state.analyzedFrames)],
  ];
  if (timings.helmet) parts.push(["Casco", `${Math.round(timings.helmet)} ms`]);
  if (timings.pose) parts.push(["Pose", `${Math.round(timings.pose)} ms`]);
  ui.stats.textContent = "";
  for (const [label, value] of parts) {
    const span = document.createElement("span");
    const strong = document.createElement("strong");
    strong.textContent = `${label}: `;
    span.append(strong, document.createTextNode(value));
    ui.stats.append(span);
  }
}

function currentFps() {
  const values = state.completions;
  if (values.length < 2) return 0;
  const span = values[values.length - 1] - values[0];
  return span > 0 ? ((values.length - 1) * 1000) / span : 0;
}

function registerCompletion() {
  const now = performance.now();
  state.completions.push(now);
  while (state.completions.length > ANALYSIS_HISTORY) state.completions.shift();
  state.analyzedFrames += 1;
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

function scheduleAnalysis(delay) {
  clearTimeout(state.analysisTimer);
  if (!state.analysisActive) return;
  const interval = state.fpsLimit ? 1000 / state.fpsLimit : 0;
  const wait = Math.max(0, interval - (delay || 0));
  state.analysisTimer = setTimeout(runAnalysisTick, wait);
}

async function runAnalysisTick() {
  if (!state.analysisActive) return;
  if (state.analyzing) {
    scheduleAnalysis(30);
    return;
  }
  if (state.mode === "video" && (ui.liveVideo.paused || ui.liveVideo.ended)) {
    if (ui.liveVideo.ended) {
      finishVideo("Fin del video");
      return;
    }
    scheduleAnalysis(120);
    return;
  }
  if (state.mode === "camera" && (!state.cameraStream || ui.liveVideo.readyState < 2)) {
    scheduleAnalysis(120);
    return;
  }
  if (!drawSourceIntoDisplay()) {
    scheduleAnalysis(120);
    return;
  }

  const token = state.analysisToken;
  state.analyzing = true;
  const started = performance.now();
  try {
    const result = await detector.analyze(ui.display, state.sourceWidth, state.sourceHeight, {
      confidence: state.confidence,
      helmet: state.helmetEnabled,
      pose: state.poseEnabled,
    });
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
      track: state.mode === "video" || state.mode === "camera",
      movementThreshold: state.movementThreshold,
      poseError: result.errors?.pose || "",
    });
    if (token !== state.analysisToken || !state.analysisActive) return;
    applyScene(scene);
    registerCompletion();
    updateStats(result);
    ui.downloadFrameBtn.disabled = false;
    if (state.mode === "image") ui.downloadImageBtn.disabled = false;
    if (state.sessionLog) state.sessionLog.logFrame(scene.counts);
    for (const [kind, message] of Object.entries(result.errors || {})) {
      if (message) pushWarning(`${MODEL_DEFS[kind]?.label || kind}: ${message}`);
    }
  } catch (error) {
    if (token === state.analysisToken) reportError("Análisis", error);
  } finally {
    state.analyzing = false;
    if (token === state.analysisToken && state.analysisActive) {
      scheduleAnalysis(performance.now() - started);
    }
  }
}

async function analyzeImage() {
  if (state.mode !== "image") return;
  if (state.analyzing) return;
  state.analyzing = true;
  const token = ++state.analysisToken;
  try {
    drawSourceIntoDisplay();
    const result = await detector.analyze(ui.display, state.sourceWidth, state.sourceHeight, {
      confidence: state.confidence,
      helmet: state.helmetEnabled,
      pose: state.poseEnabled,
    });
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
      movementThreshold: state.movementThreshold,
      poseError: result.errors?.pose || "",
    });
    applyScene(scene);
    registerCompletion();
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
  clearTimeout(state.analysisTimer);
  state.analysisTimer = null;
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
  state.analysisActive = true;
  state.analysisToken += 1;
  state.analysisStartedAt = performance.now();
  state.analyzedFrames = 0;
  state.completions = [];
  try {
    await ui.liveVideo.play();
  } catch (error) {
    reportError("No se pudo reproducir el video", error);
  }
  startRenderLoop();
  scheduleAnalysis();
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
      `solicitada ${ui.resolutionSelect.selectedOptions[0]?.textContent || "nativa"}.`,
    "ok",
  );

  state.sessionLog = new SessionLog({
    cameraIndex: state.cameraIndex,
    cameraLabel: `${label} (${state.sourceWidth}×${state.sourceHeight})`,
  });
  state.sessionLog.start({
    resolution: { width: state.sourceWidth, height: state.sourceHeight },
    fpsLimit: state.fpsLimit,
    models: activeModelNames(),
  });
  ui.sessionStatus.textContent =
    "Sesión de cámara en curso. Al detenerla se descargará el registro TXT.";
  ui.sessionDownloadBtn.disabled = true;

  pipeline.reset();
  pipeline.configure({ fpsLimit: state.fpsLimit });
  state.analysisActive = true;
  state.analysisToken += 1;
  state.analysisStartedAt = performance.now();
  state.analyzedFrames = 0;
  state.completions = [];
  startRenderLoop();
  scheduleAnalysis();

  const track = stream.getVideoTracks()[0];
  if (track) {
    track.addEventListener("ended", () => {
      if (state.cameraStream === stream) {
        stopCamera("La cámara se desconectó");
      }
    });
  }
}

function stopCamera(reason = "Detener cámara") {
  if (!state.cameraStream) return;
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
    const text = state.sessionLog.finish(reason, counts);
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
    if (state.analysisActive) scheduleAnalysis();
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
    refreshOptionalModelBadges();
    scheduleImageReanalysis();
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
  state.confidence = Number(ui.confidenceRange.value) / 100;
  state.movementThreshold = Number(ui.movementRange.value) / 1000;
  ui.confidenceValue.textContent = `${ui.confidenceRange.value}%`;
  ui.movementValue.textContent = `${(Number(ui.movementRange.value) / 10).toFixed(1)}%`;
  state.helmetEnabled = ui.helmetCheck.checked;
  state.poseEnabled = ui.poseCheck.checked;
  state.fpsLimit = Number(ui.fpsSelect.value) || 0;
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
