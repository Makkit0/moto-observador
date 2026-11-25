// Dibujo de cajas, etiquetas, trayectorias y esqueleto sobre canvas.
// El HUD es deliberadamente compacto: identificador corto, confianza y, como
// máximo, una línea de indicadores. Los detalles completos van al panel de
// resultados, no encima del video.

import { clamp, estimateHeadBox, formatPercent } from "./utils.js";
import { formatAge } from "./metrics.js";

const COLORS = {
  person: "#ffb020",
  motorcycle: "#ffd200",
  helmetOk: "#22c55e",
  helmetNo: "#ef4444",
  review: "#f59e0b",
  weapon: "#fb7185",
  stale: "#b45309",
  poseLine: "rgba(170, 255, 170, 0.85)",
  posePoint: "#50ff50",
  poseLow: "#00b4ff",
  trailPerson: "rgba(255, 225, 150, 0.5)",
  trailMotorcycle: "rgba(150, 255, 255, 0.5)",
  head: "rgba(148, 197, 255, 0.85)",
};

const POSE_SKELETON = [
  [0, 1], [0, 2], [1, 3], [2, 4],
  [5, 6], [5, 7], [7, 9], [6, 8], [8, 10],
  [5, 11], [6, 12], [11, 12],
  [11, 13], [13, 15], [12, 14], [14, 16],
];

const POSE_KEYPOINT_CONF = 0.35;
const blurScratch = document.createElement("canvas");

function hudFont(width) {
  // El canvas suele ampliarse para llenar el visor. Un mínimo de 10 píxeles
  // internos hacía que las etiquetas ocuparan demasiado con fuentes 320×240.
  // Esta escala mantiene el HUD cerca de 10–12 px en pantalla, también al ampliar.
  return Math.max(3, Math.min(13, Math.round(width / 110)));
}

function labelMaxWidth(box, width, fontSize, multiplier = 1.2) {
  const objectWidth = Math.max(1, box[2] - box[0]);
  return Math.min(width, Math.max(fontSize * 7, objectWidth * multiplier));
}

function colorFor(detection) {
  if (detection.kind === "motorcycle") return COLORS.motorcycle;
  if (detection.kind === "weapon") return COLORS.weapon;
  if (detection.kind === "helmet") {
    if (detection.state === "CON CASCO") return COLORS.helmetOk;
    if (detection.state === "SIN CASCO") return COLORS.helmetNo;
    return COLORS.review;
  }
  return COLORS.person;
}

function drawChip(
  ctx,
  text,
  x,
  y,
  { fontSize, background, color, maxWidth, canvasWidth = maxWidth },
) {
  ctx.save();
  ctx.font = `600 ${fontSize}px system-ui, -apple-system, Segoe UI, sans-serif`;
  const paddingX = Math.max(1, Math.round(fontSize * 0.34));
  const paddingY = Math.max(1, Math.round(fontSize * 0.24));
  const measured = ctx.measureText(text).width;
  const width = Math.min(maxWidth, measured + paddingX * 2);
  const height = fontSize + paddingY * 2;
  const left = clamp(Math.round(x), 0, Math.max(0, canvasWidth - width));
  const top = Math.max(0, Math.round(y));
  ctx.globalAlpha = 0.82;
  ctx.fillStyle = background;
  ctx.beginPath();
  const radius = Math.max(1, Math.min(4, height / 2));
  if (ctx.roundRect) ctx.roundRect(left, top, width, height, radius);
  else ctx.rect(left, top, width, height);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = color;
  ctx.textBaseline = "top";
  ctx.save();
  ctx.beginPath();
  ctx.rect(left, top, width, height);
  ctx.clip();
  ctx.fillText(text, left + paddingX, top + paddingY);
  ctx.restore();
  ctx.restore();
  return height;
}

function drawBox(ctx, box, color, lineWidth, dashed = false) {
  const [x1, y1, x2, y2] = box;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  if (dashed) ctx.setLineDash([6, 4]);
  ctx.strokeRect(x1, y1, Math.max(1, x2 - x1), Math.max(1, y2 - y1));
  ctx.restore();
}

export function headBoxFor(person, width, height) {
  return estimateHeadBox(person, width, height, POSE_KEYPOINT_CONF);
}

export function blurHeadRegions(ctx, persons, width, height) {
  if (!Array.isArray(persons) || !persons.length) return 0;
  let blurred = 0;
  for (const person of persons) {
    const box = headBoxFor(person, width, height);
    if (!box) continue;
    const [x1, y1, x2, y2] = box.map(Math.round);
    const boxWidth = Math.max(1, x2 - x1);
    const boxHeight = Math.max(1, y2 - y1);
    const pixel = Math.max(6, Math.round(Math.min(boxWidth, boxHeight) / 8));
    blurScratch.width = Math.max(1, Math.round(boxWidth / pixel));
    blurScratch.height = Math.max(1, Math.round(boxHeight / pixel));
    const scratchCtx = blurScratch.getContext("2d");
    scratchCtx.clearRect(0, 0, blurScratch.width, blurScratch.height);
    scratchCtx.imageSmoothingEnabled = true;
    scratchCtx.drawImage(
      ctx.canvas,
      x1,
      y1,
      boxWidth,
      boxHeight,
      0,
      0,
      blurScratch.width,
      blurScratch.height,
    );
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      blurScratch,
      0,
      0,
      blurScratch.width,
      blurScratch.height,
      x1,
      y1,
      boxWidth,
      boxHeight,
    );
    ctx.restore();
    blurred += 1;
  }
  return blurred;
}

function drawTrail(ctx, trail, color, lineWidth) {
  if (!trail || trail.length < 2) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, lineWidth - 1);
  ctx.beginPath();
  trail.forEach(([x, y], index) => {
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.restore();
}

function drawPose(ctx, keypoints, fontSize) {
  if (!keypoints || keypoints.length !== 17) return;
  const reliable = new Set(
    keypoints
      .map((point, index) => (point.score >= POSE_KEYPOINT_CONF ? index : -1))
      .filter((index) => index >= 0),
  );
  const radius = Math.max(1, Math.min(3, Math.round(fontSize / 4)));
  ctx.save();
  ctx.strokeStyle = COLORS.poseLine;
  ctx.lineWidth = Math.max(0.75, Math.round(radius / 2));
  for (const [start, end] of POSE_SKELETON) {
    if (!reliable.has(start) || !reliable.has(end)) continue;
    ctx.beginPath();
    ctx.moveTo(keypoints[start].x, keypoints[start].y);
    ctx.lineTo(keypoints[end].x, keypoints[end].y);
    ctx.stroke();
  }
  for (const index of reliable) {
    const point = keypoints[index];
    ctx.fillStyle = point.score >= 0.6 ? COLORS.posePoint : COLORS.poseLow;
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function poseConfidence(keypoints) {
  const values = (keypoints || [])
    .filter((point) => point.score >= POSE_KEYPOINT_CONF)
    .map((point) => point.score);
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function shortNote(note) {
  const map = [
    ["manos elevadas", "manos↑"],
    ["brazo izquierdo elevado", "brazo izq.↑"],
    ["brazo derecho elevado", "brazo der.↑"],
    ["postura horizontal", "horizontal"],
    ["torso inclinado", "torso↗"],
    ["brazo en movimiento", "brazo mov."],
    ["piernas en movimiento", "piernas mov."],
  ];
  for (const [needle, label] of map) {
    if (note.includes(needle)) return label;
  }
  return note.length > 18 ? `${note.slice(0, 17)}…` : note;
}

function personChips(person) {
  const chips = [];
  if (person.state === "CON CASCO") chips.push("casco");
  if (person.state === "SIN CASCO") chips.push("sin casco");
  const pose = poseConfidence(person.keypoints);
  if (person.weapons?.length) chips.push("arma? revisar");
  if (pose > 0) {
    const poseText = person.poseNote
      ? `pose ${Math.round(pose * 100)}% · ${shortNote(person.poseNote)}`
      : `pose ${Math.round(pose * 100)}%`;
    chips.push(poseText);
  }
  if (person.movement === "EN MOVIMIENTO") chips.push("mov.");
  return chips.slice(0, 4);
}

function drawPersonLabel(ctx, person, index, fontSize, width, height) {
  const id = person.trackId !== null && person.trackId !== undefined
    ? `P${person.trackId}`
    : `P${index + 1}`;
  const top = person.box[1] - (fontSize + 8);
  const text = `${id} ${formatPercent(person.score)}`;
  const textHeight = drawChip(ctx, text, person.box[0], top, {
    fontSize,
    background: "rgba(120, 72, 0, 0.82)",
    color: "#fff7e6",
    maxWidth: labelMaxWidth(person.box, width, fontSize),
    canvasWidth: width,
  });
  const chips = personChips(person);
  if (chips.length) {
    drawChip(ctx, chips.join(" · "), person.box[0], top + textHeight + 2, {
      fontSize: Math.max(3, fontSize - 1),
      background: "rgba(15, 23, 42, 0.72)",
      color: "#e2e8f0",
      maxWidth: labelMaxWidth(person.box, width, fontSize, 1.35),
      canvasWidth: width,
    });
  }
}

function drawMotorcycleLabel(ctx, motorcycle, index, fontSize, width) {
  const id = motorcycle.trackId !== null && motorcycle.trackId !== undefined
    ? `M${motorcycle.trackId}`
    : `M${index + 1}`;
  const chips = [];
  if (motorcycle.occupants) chips.push(`ocup. ${motorcycle.occupants}`);
  if (motorcycle.helmetSummary === "Casco: sin casco") chips.push("sin casco");
  if (motorcycle.helmetSummary === "Casco: mixto (revisar)") chips.push("casco mixto");
  if (motorcycle.movement === "EN MOVIMIENTO") chips.push("mov.");
  const text = chips.length ? `${id} · ${chips.join(" · ")}` : id;
  drawChip(ctx, text, motorcycle.box[0], motorcycle.box[1] - (fontSize + 8), {
    fontSize,
    background: "rgba(92, 72, 0, 0.82)",
    color: "#fffbe6",
    maxWidth: labelMaxWidth(motorcycle.box, width, fontSize),
    canvasWidth: width,
  });
}

function drawHelmetLabel(ctx, helmet, fontSize, width) {
  const state =
    helmet.state === "CON CASCO"
      ? "casco"
      : helmet.state === "SIN CASCO"
        ? "sin casco"
        : "casco?";
  const suffix = helmet.associated ? "" : " · no asoc.";
  drawChip(
    ctx,
    `${state} ${formatPercent(helmet.score)}${suffix}`,
    helmet.box[0],
    helmet.box[1] - (fontSize + 8),
    {
      fontSize: Math.max(3, fontSize - 1),
      background: helmet.state === "SIN CASCO"
        ? "rgba(127, 29, 29, 0.85)"
        : "rgba(20, 83, 45, 0.82)",
      color: "#f8fafc",
      maxWidth: labelMaxWidth(helmet.box, width, fontSize, 1.5),
      canvasWidth: width,
    },
  );
}

function drawWeaponLabel(ctx, weapon, fontSize, width) {
  drawChip(
    ctx,
    `arma? ${formatPercent(weapon.score)} · revisar`,
    weapon.box[0],
    weapon.box[1] - (fontSize + 8),
    {
      fontSize: Math.max(3, fontSize - 1),
      background: "rgba(88, 28, 40, 0.88)",
      color: "#ffe4e6",
      maxWidth: labelMaxWidth(weapon.box, width, fontSize, 1.4),
      canvasWidth: width,
    },
  );
}

/**
 * Dibuja la escena. Si drawSource es true, primero pinta el cuadro de origen;
 * si no, se usa sobre un canvas transparente que ya muestra el video.
 */
export function drawScene(
  ctx,
  scene,
  width,
  height,
  {
    drawSource = false,
    source = null,
    stale = false,
    ageMs = null,
    showAge = false,
    showFaces = false,
  } = {},
) {
  if (drawSource && source) {
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(source, 0, 0, width, height);
  } else {
    ctx.clearRect(0, 0, width, height);
  }
  if (!scene) return;

  const fontSize = hudFont(width);
  const lineWidth = Math.max(0.75, Math.round(width / 520));
  ctx.font = `600 ${fontSize}px system-ui, -apple-system, Segoe UI, sans-serif`;
  ctx.textBaseline = "top";

  ctx.save();
  if (stale) ctx.globalAlpha = 0.72;

  for (const detection of [...scene.persons, ...scene.motorcycles]) {
    if (!detection.trail || detection.trail.length < 2) continue;
    drawTrail(
      ctx,
      detection.trail,
      detection.kind === "motorcycle" ? COLORS.trailMotorcycle : COLORS.trailPerson,
      lineWidth,
    );
  }

  for (const person of scene.persons) {
    drawBox(ctx, person.box, COLORS.person, lineWidth, stale);
    drawPose(ctx, person.keypoints, fontSize);
  }
  for (const motorcycle of scene.motorcycles) {
    drawBox(ctx, motorcycle.box, COLORS.motorcycle, lineWidth, stale);
  }
  for (const helmet of scene.helmets) {
    drawBox(ctx, helmet.box, colorFor(helmet), Math.max(1, lineWidth - 0.5), stale);
  }
  for (const weapon of scene.weapons || []) {
    drawBox(ctx, weapon.box, COLORS.weapon, Math.max(1.5, lineWidth + 0.5), true);
  }
  if (showFaces) {
    for (const person of scene.persons) {
      const box = headBoxFor(person, width, height);
      if (box) drawBox(ctx, box, COLORS.head, 1, true);
    }
  }
  ctx.restore();

  // Etiquetas al final para que queden por encima del esqueleto.
  scene.persons.forEach((person, index) => {
    drawPersonLabel(ctx, person, index, fontSize, width, height);
  });
  scene.motorcycles.forEach((motorcycle, index) => {
    drawMotorcycleLabel(ctx, motorcycle, index, fontSize, width);
  });
  scene.helmets.forEach((helmet) => {
    // La etiqueta del casco se omite cuando ya está asociada a una persona:
    // su chip de persona muestra el estado y así se evita duplicar texto.
    if (helmet.associated) return;
    drawHelmetLabel(ctx, helmet, fontSize, width);
  });
  (scene.weapons || []).forEach((weapon) => {
    drawWeaponLabel(ctx, weapon, fontSize, width);
  });

  if (showAge && ageMs !== null && Number.isFinite(ageMs)) {
    // Chip pequeño en la esquina: solo aparece cuando la detección ya tiene
    // cierta antigüedad o está atrasada, para no tapar la escena.
    if (stale || ageMs > 600) {
      const text = stale
        ? `detecciones atrasadas ${formatAge(ageMs)}`
        : `detecciones ${formatAge(ageMs)}`;
      drawChip(ctx, text, 6, height - (fontSize + 12), {
        fontSize: Math.max(9, fontSize - 1),
        background: stale ? "rgba(120, 53, 15, 0.85)" : "rgba(15, 23, 42, 0.6)",
        color: "#f8fafc",
        maxWidth: width,
      });
    }
  }
}

export function composeAnnotatedCanvas(source, scene, width, height, options = {}) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const ctx = canvas.getContext("2d");
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  drawScene(ctx, scene, canvas.width, canvas.height, { drawSource: false, ...options });
  return canvas;
}
