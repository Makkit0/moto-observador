// Registro TXT de una sesión de cámara. Solo texto agregado: sin cuadros,
// sin coordenadas del esqueleto, sin rostros, placas ni identidades.
// No se escribe una línea por cuadro: las señales se agrupan con inicio,
// actualizaciones espaciadas y cierre.

import { formatPercent, localIso, timestampForFilename } from "./utils.js";
import { formatFps } from "./metrics.js";

const UPDATE_COOLDOWN = 5;
const CLOSE_AFTER = 2;
const SUMMARY_INTERVAL = 30;

export class SessionLog {
  constructor({ cameraIndex = 0, cameraLabel = "" } = {}) {
    this.cameraIndex = Number(cameraIndex) || 0;
    this.cameraLabel = cameraLabel || `índice ${this.cameraIndex}`;
    this.startedAt = new Date();
    this.started = performance.now();
    this.lines = [];
    this.active = new Map();
    this.lastCounts = null;
    this.lastMetrics = null;
    this.lastSummary = 0;
    this.eventsStarted = 0;
    this.resolution = null;
    this.cooldown = UPDATE_COOLDOWN;
    this.finished = false;
    this.unavailable = new Set();
    this.lines.push("Moto Observador — registro de sesión de cámara");
    this.lines.push(`Inicio: ${localIso(this.startedAt)}`);
    this.lines.push(`Cámara: ${this.cameraLabel}`);
    this.lines.push(
      "Alcance: señales automáticas para revisión humana; no son infracciones " +
        "confirmadas ni identifican personas.",
    );
  }

  start({
    resolution = null,
    fpsTarget = 0,
    captureRequested = 0,
    captureDeclared = 0,
    models = [],
    runtime = "",
    browser = "",
  } = {}) {
    if (resolution) this.setResolution(resolution.width, resolution.height, true);
    this.lines.push(
      `Captura solicitada: ${captureRequested ? `${captureRequested} FPS` : "sin solicitud específica"}` +
        ` · declarada por el navegador: ${captureDeclared ? `${captureDeclared} FPS` : "no disponible"}`,
    );
    this.lines.push(
      `Análisis objetivo: ${fpsTarget ? `${fpsTarget} FPS` : "sin límite"}`,
    );
    if (runtime) this.lines.push(`Runtime: ${runtime}`);
    if (browser) this.lines.push(`Navegador: ${browser}`);
    this.lines.push("Modelos:");
    for (const model of models) {
      this.lines.push(`- ${model.label}: ${model.status}`);
      if (model.status.startsWith("no disponible")) this.unavailable.add(model.label);
    }
    this.lines.push("--- Señales observables (revisión humana) ---");
  }

  setResolution(width, height, quiet = false) {
    if (!width || !height) return;
    this.resolution = [Math.round(width), Math.round(height)];
    if (!quiet) this.lines.push(`Resolución real: ${this.resolution[0]}×${this.resolution[1]}`);
  }

  setCooldown(seconds) {
    this.cooldown = Math.max(1, Number(seconds) || UPDATE_COOLDOWN);
  }

  noteModelError(label, message) {
    if (this.finished || this.unavailable.has(label)) return;
    this.unavailable.add(label);
    this.lines.push(
      `[${localIso()}] Función no disponible | ${label} | ${message || "error del modelo"}`,
    );
  }

  summaryText(counts) {
    return (
      `personas ${counts.personas}, motos ${counts.motocicletas}, ` +
      `ocupantes 1/2/>2 ${counts.motos1}/${counts.motos2}/${counts.motosMas2}, ` +
      `casco con/sin/incierto ${counts.conCasco}/${counts.sinCasco}/${counts.indeterminado}, ` +
      `movimiento ${counts.enMovimiento}, pose ${counts.posePersonas}`
    );
  }

  eventLine(state, event, duration) {
    const track =
      event.trackId !== null && event.trackId !== undefined
        ? `trayectoria T${event.trackId}`
        : "sin ID temporal";
    const confidence =
      event.confidence !== undefined && event.confidence !== null
        ? formatPercent(event.confidence)
        : "no disponible";
    let line =
      `[${localIso()}] ${state} | ${event.type || "señal"} | ${track} | ` +
      `confianza ${confidence} | duración ${Math.max(0, duration).toFixed(1)} s`;
    if (event.detail) line += ` | ${event.detail}`;
    return line;
  }

  logFrame(counts, nowMs = performance.now(), metrics = null) {
    if (this.finished) return;
    const now = nowMs / 1000;
    const present = new Set();
    if (metrics) this.lastMetrics = metrics;

    for (const event of counts.eventos || []) {
      const key = `${event.type || "señal"}|${event.trackId ?? "sin"}`;
      present.add(key);
      let active = this.active.get(key);
      if (!active) {
        active = {
          type: event.type || "señal",
          trackId: event.trackId,
          detail: event.detail || "",
          confidence: event.confidence,
          first: now,
          last: now,
          lastLog: now,
        };
        this.active.set(key, active);
        this.eventsStarted += 1;
        this.lines.push(this.eventLine("INICIO", active, 0));
      } else {
        active.last = now;
        if (event.detail) active.detail = event.detail;
        if (event.confidence !== undefined) active.confidence = event.confidence;
        if (now - active.lastLog >= this.cooldown) {
          this.lines.push(this.eventLine("ACTUALIZACIÓN", active, now - active.first));
          active.lastLog = now;
        }
      }
    }

    for (const [key, active] of [...this.active]) {
      if (present.has(key)) continue;
      if (now - active.last >= CLOSE_AFTER) {
        this.lines.push(this.eventLine("CIERRE", active, now - active.first));
        this.active.delete(key);
      }
    }

    this.lastCounts = counts;
    if (now - this.lastSummary >= SUMMARY_INTERVAL) {
      const rate = metrics
        ? ` (${formatFps(metrics.achievedFps)} reales de análisis, objetivo ${
            metrics.targetFps ? `${metrics.targetFps} FPS` : "sin límite"
          })`
        : "";
      this.lines.push(`Resumen periódico${rate}: ${this.summaryText(counts)}`);
      this.lastSummary = now;
    }
  }

  finish(reason, counts = null, metrics = null) {
    if (this.finished) return this.lines.join("\n");
    if (counts) this.lastCounts = counts;
    if (metrics) this.lastMetrics = metrics;
    const now = performance.now() / 1000;
    for (const active of this.active.values()) {
      this.lines.push(
        this.eventLine("ACTIVO AL FINALIZAR LA SESIÓN", active, now - active.first),
      );
    }
    this.active.clear();
    this.lines.push(`Fin de sesión: ${reason}`);
    this.lines.push(
      `Duración de la sesión: ${Math.max(0, (performance.now() - this.started) / 1000).toFixed(1)} s`,
    );
    if (this.resolution) {
      this.lines.push(`Resolución real al cerrar: ${this.resolution[0]}×${this.resolution[1]}`);
    }
    if (this.lastMetrics) {
      const metrics = this.lastMetrics;
      this.lines.push(
        `Análisis: objetivo ${metrics.targetFps ? `${metrics.targetFps} FPS` : "sin límite"}` +
          ` · real ${formatFps(metrics.achievedFps)}` +
          ` · cuadros analizados ${metrics.analyzedFrames}` +
          ` · omitidos por inferencia ${metrics.skippedBusy}` +
          ` · omitidos por límite ${metrics.skippedRate}`,
      );
      if (metrics.captureDeclared) {
        this.lines.push(
          `Captura declarada por el navegador: ${metrics.captureDeclared} FPS` +
            (metrics.captureFps
              ? ` · medida al final: ${formatFps(metrics.captureFps)}`
              : ""),
        );
      }
      if (metrics.detectionAgeMs !== null && metrics.detectionAgeMs !== undefined) {
        this.lines.push(
          `Antigüedad de la última detección al cerrar: ${Math.round(metrics.detectionAgeMs)} ms`,
        );
      }
    }
    if (this.lastCounts) {
      this.lines.push(`Resumen final: ${this.summaryText(this.lastCounts)}`);
    }
    this.lines.push(`Eventos iniciados: ${this.eventsStarted}`);
    if (!this.eventsStarted) {
      this.lines.push(
        "No se registraron señales destacadas durante la sesión. " +
          "La ausencia de señales no demuestra que no ocurriera nada.",
      );
    }
    if (this.unavailable.size) {
      this.lines.push(
        `Funciones no disponibles en esta sesión: ${[...this.unavailable].join(", ")}.`,
      );
    }
    this.lines.push("Registro cerrado.");
    this.finished = true;
    return this.lines.join("\n");
  }

  filename() {
    return `sesion_camara${this.cameraIndex}_${timestampForFilename(this.startedAt)}.txt`;
  }
}
