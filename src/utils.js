// Utilidades geométricas y de descarga. Sin dependencias externas.

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function boxArea(box) {
  return Math.max(0, box[2] - box[0]) * Math.max(0, box[3] - box[1]);
}

export function intersectionArea(a, b) {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}

export function boxIou(a, b) {
  const intersection = intersectionArea(a, b);
  const union = boxArea(a) + boxArea(b) - intersection;
  return union > 0 ? intersection / union : 0;
}

export function containment(inner, outer) {
  const area = boxArea(inner);
  return area > 0 ? intersectionArea(inner, outer) / area : 0;
}

export function expandBox(box, ratio) {
  const width = box[2] - box[0];
  const height = box[3] - box[1];
  return [
    box[0] - width * ratio,
    box[1] - height * ratio,
    box[2] + width * ratio,
    box[3] + height * ratio,
  ];
}

export function boxCenter(box) {
  return [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
}

export function clipBox(box, width, height) {
  return [
    clamp(box[0], 0, width),
    clamp(box[1], 0, height),
    clamp(box[2], 0, width),
    clamp(box[3], 0, height),
  ];
}

/**
 * Región aproximada de la cabeza/rostro a partir de los puntos de pose
 * (nariz, ojos y orejas). No es un detector facial ni un reconocimiento:
 * solo estima una zona para difuminarla o contarla.
 */
export function estimateHeadBox(person, width, height, minConfidence = 0.35) {
  const keypoints = person?.keypoints;
  if (!Array.isArray(keypoints) || keypoints.length !== 17) return null;
  const reliable = keypoints
    .map((point, index) =>
      index <= 4 && point.score >= minConfidence ? point : null,
    )
    .filter(Boolean);
  if (!reliable.length) return null;
  const hasFace =
    keypoints[0]?.score >= minConfidence ||
    (keypoints[1]?.score >= minConfidence && keypoints[2]?.score >= minConfidence);
  if (!hasFace) return null;

  const xs = reliable.map((point) => point.x);
  const ys = reliable.map((point) => point.y);
  const centerX = (Math.min(...xs) + Math.max(...xs)) / 2;
  const centerY = (Math.min(...ys) + Math.max(...ys)) / 2;
  const ears =
    keypoints[3]?.score >= minConfidence && keypoints[4]?.score >= minConfidence
      ? Math.hypot(keypoints[3].x - keypoints[4].x, keypoints[3].y - keypoints[4].y)
      : 0;
  const personHeight = Math.max(1, person.box[3] - person.box[1]);
  const size = Math.max(ears * 1.5, personHeight * 0.2, 20);
  const box = [
    clamp(centerX - size / 2, 0, width),
    clamp(centerY - size * 0.6, 0, height),
    clamp(centerX + size / 2, 0, width),
    clamp(centerY + size * 0.75, 0, height),
  ];
  return box[2] - box[0] >= 6 && box[3] - box[1] >= 6 ? box : null;
}

/**
 * Parámetros de letterbox centrado, equivalentes a los de Ultralytics.
 * El modelo usa una entrada cuadrada fija de 640×640.
 */
export function letterboxParams(width, height, size) {
  const scale = Math.min(size / width, size / height);
  const drawWidth = Math.round(width * scale);
  const drawHeight = Math.round(height * scale);
  const padX = (size - drawWidth) / 2;
  const padY = (size - drawHeight) / 2;
  return {
    scale,
    drawWidth,
    drawHeight,
    left: Math.round(padX - 0.1),
    top: Math.round(padY - 0.1),
    padX,
    padY,
  };
}

/** NMS voraz para una sola clase. Devuelve índices del arreglo original. */
export function nms(boxes, scores, iouThreshold = 0.45) {
  const order = scores
    .map((score, index) => ({ score, index }))
    .sort((a, b) => b.score - a.score)
    .map((item) => item.index);
  const keep = [];
  while (order.length) {
    const current = order.shift();
    keep.push(current);
    const remaining = [];
    for (const index of order) {
      if (boxIou(boxes[current], boxes[index]) <= iouThreshold) {
        remaining.push(index);
      }
    }
    order.length = 0;
    order.push(...remaining);
  }
  return keep;
}

export function normalizeName(name) {
  return String(name ?? "")
    .trim()
    .toLowerCase()
    .replaceAll("-", "_")
    .replaceAll(" ", "_");
}

export function formatPercent(value) {
  return `${Math.round(Number(value || 0) * 100)}%`;
}

export function formatMs(value) {
  return `${Math.round(Number(value || 0))} ms`;
}

export function localIso(date = new Date()) {
  const pad = (value) => String(Math.abs(value)).padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const hours = Math.floor(Math.abs(offset) / 60);
  const minutes = Math.abs(offset) % 60;
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(hours)}:${pad(minutes)}`
  );
}

export function timestampForFilename(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function downloadText(text, filename) {
  downloadBlob(new Blob([text], { type: "text/plain;charset=utf-8" }), filename);
}

export function canvasToBlob(canvas, type = "image/png", quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("No se pudo generar la imagen."))),
      type,
      quality,
    );
  });
}

export function safeFileName(name, fallback = "resultado") {
  const base = String(name || "")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/^_+|_+$/g, "");
  return base || fallback;
}
