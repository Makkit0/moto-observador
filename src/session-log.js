// Registro TXT de una sesión de cámara. Solo texto agregado: sin cuadros,
// sin coordenadas del esqueleto, sin rostros, placas ni identidades.

import { formatPercent, localIso, timestampForFilename } from "./utils.js";

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
    this.lastSummary = 0;
    this.eventsStarted = 0;
    this.resolution = null;
    this.cooldown = UPDATE_COOLDOWN;
    this.finished = false;
    this.lines.push("Moto Observador — registro de sesión de cámara");
    this.lines.push(`Inicio: ${localIso(this.startedAt)}`);
    this.lines.push(`Cámara: ${this.cameraLabel}`);
    this.lines.push(
      "Alcance: señales automáticas para revisión humana; no son infracciones " +
        "confirmadas ni identifican personas.",
    );
  }

  start({ resolution = null, fpsLimit = 0, models = [] } = {}) {
    if (resolution) this.setResolution(resolution.width, resolution.height, true);
    this.lines.push(
      `Límite de FPS de análisis: ${fpsLimit ? `${fpsLimit} FPS` : "sin límite"}`,
    );
    this.lines.push(`Modelos: ${models.join(", ") || "no disponibles"}`);
    this.lines.push("--- Señales destacadas ---");
  }

  setResolution(width, height, quiet = false) {
    if (!width || !height) return;
    this.resolution = [Math.round(width), Math.round(height)];
    if (!quiet) this.lines.push(`Resolución real: ${this.resolution[0]}×${this.resolution[1]}`);
  }

  setCooldown(seconds) {
    this.cooldown = Math.max(1, Number(seconds) || UPDATE_COOLDOWN);
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
    const track = event.trackId !== null && event.trackId !== undefined
      ? `T${event.trackId}`
      : "sin ID temporal";
    const confidence = event.confidence !== undefined && event.confidence !== null
      ? formatPercent(event.confidence)
      : "no disponible";
    let line =
      `[${localIso()}] ${state} | ${event.type || "señal"} | trayectoria ${track} | ` +
      `confianza ${confidence} | duración ${Math.max(0, duration).toFixed(1)} s`;
    if (event.detail) line += ` | ${event.detail}`;
    return line;
  }

  logFrame(counts, nowMs = performance.now()) {
    if (this.finished) return;
    const now = nowMs / 1000;
    const present = new Set();

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
      this.lines.push(`Resumen periódico: ${this.summaryText(counts)}`);
      this.lastSummary = now;
    }
  }

  finish(reason, counts = null) {
    if (this.finished) return this.lines.join("\n");
    if (counts) this.lastCounts = counts;
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
    if (this.lastCounts) {
      this.lines.push(`Resumen final: ${this.summaryText(this.lastCounts)}`);
    }
    this.lines.push(`Eventos iniciados: ${this.eventsStarted}`);
    this.lines.push("Registro cerrado.");
    this.finished = true;
    return this.lines.join("\n");
  }

  filename() {
    return `sesion_camara${this.cameraIndex}_${timestampForFilename(this.startedAt)}.txt`;
  }
}
