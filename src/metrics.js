// Medidores de frecuencia y formato de métricas.
// No usan temporizadores propios: se alimentan desde el bucle de cuadros
// (requestVideoFrameCallback o requestAnimationFrame) y desde el análisis.

/**
 * Frecuencia medida en una ventana móvil de tiempo real.
 * Se descartan las muestras más antiguas para que el valor refleje el
 * comportamiento reciente y no el promedio de toda la sesión.
 */
export class RateMeter {
  constructor(windowMs = 1500) {
    this.windowMs = Math.max(200, windowMs);
    this.samples = [];
  }

  reset() {
    this.samples.length = 0;
  }

  push(now = performance.now()) {
    this.samples.push(now);
    const cutoff = now - this.windowMs;
    while (this.samples.length > 2 && this.samples[0] < cutoff) this.samples.shift();
  }

  get count() {
    return this.samples.length;
  }

  get fps() {
    const samples = this.samples;
    if (samples.length < 2) return 0;
    const span = samples[samples.length - 1] - samples[0];
    return span > 0 ? ((samples.length - 1) * 1000) / span : 0;
  }

  /** Promedio simple desde el reinicio, útil para el registro TXT. */
  averageSince(startMs, total) {
    const span = performance.now() - startMs;
    if (!total || span <= 0) return 0;
    return (total * 1000) / span;
  }
}

export function formatFps(value, digits = 1) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "—";
  return `${number.toFixed(number >= 10 ? 0 : digits)} FPS`;
}

export function formatAge(ms) {
  const number = Number(ms);
  if (!Number.isFinite(number) || number < 0) return "—";
  if (number < 1000) return `${Math.round(number)} ms`;
  return `${(number / 1000).toFixed(1)} s`;
}

export function formatMs(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return "—";
  return `${Math.round(number)} ms`;
}

/**
 * Describe el navegador y la plataforma para el registro TXT.
 * No se usa para identificar al usuario: solo diagnóstico de la sesión.
 */
export function browserDescription() {
  const nav = typeof navigator !== "undefined" ? navigator : null;
  if (!nav) return "no disponible";
  const ua = String(nav.userAgent || "");
  const platform =
    nav.userAgentData?.platform || nav.platform || "plataforma no disponible";
  const patterns = [
    [/Edg\/(\d+)/, "Edge"],
    [/OPR\/(\d+)/, "Opera"],
    [/Firefox\/(\d+)/, "Firefox"],
    [/Chrome\/(\d+)/, "Chrome"],
    [/Version\/(\d+).*Safari/, "Safari"],
  ];
  for (const [pattern, name] of patterns) {
    const match = ua.match(pattern);
    if (match) return `${name} ${match[1]} · ${platform}`;
  }
  return `navegador no identificado · ${platform}`;
}
