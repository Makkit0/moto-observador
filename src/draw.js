// Dibujo de cajas, etiquetas, trayectorias y esqueleto sobre canvas.

import { clamp, formatPercent } from "./utils.js";
import { formatAge } from "./metrics.js";

const COLORS = {
  person: "#ffaa00",
  motorcycle: "#ffd200",
  helmetOk: "#22c55e",
  helmetNo: "#ef4444",
  review: "#f59e0b",
  stale: "#b45309",
  poseLine: "#aaffaa",
  posePoint: "#50ff50",
  poseLow: "#00b4ff",
  trailPerson: "rgba(255, 225, 150, 0.65)",
  trailMotorcycle: "rgba(150, 255, 255, 0.65)",
};

const HEAD_KEYPOINT_CONF = 0.35;
const blurScratch = document.createElement("canvas");

const POSE_SKELETON = [
  [0, 1], [0, 2], [1, 3], [2, 4],
  [5, 6], [5, 7], [7, 9], [6, 8], [8, 10],
  [5, 11], [6, 12], [11, 12],
  [11, 13], [13, 15], [12, 14], [14, 16],
];

function colorFor(detection) {
  if (detection.kind === "motorcycle") return COLORS.motorcycle;
  if (detection.kind === "helmet") {
    if (detection.state === "CON CASCO") return COLORS.helmetOk;
    if (detection.state === "SIN CASCO") return COLORS.helmetNo;
    return COLORS.review;
  }
  return COLORS.person;
}

function drawLabel(ctx, text, x, y, color, fontSize, canvasWidth, canvasHeight) {
  const lines = String(text).split("\n");
  const lineHeight = Math.round(fontSize * 1.22);
  const padding = Math.max(3, Math.round(fontSize * 0.3));
  ctx.font = `600 ${fontSize}px system-ui, -apple-system, Segoe UI, sans-serif`;
  let textWidth = 0;
  for (const line of lines) textWidth = Math.max(textWidth, ctx.measureText(line).width);
  const blockWidth = textWidth + padding * 2;
  const blockHeight = lines.length * lineHeight + padding * 2;
  const left = Math.max(0, Math.min(Math.round(x), Math.max(0, canvasWidth - blockWidth)));
  const top = Math.max(0, Math.min(Math.round(y) - blockHeight, canvasHeight - blockHeight));

  ctx.save();
  ctx.globalAlpha = 0.88;
  ctx.fillStyle = color;
  ctx.beginPath();
  const radius = Math.min(5, blockHeight / 2);
  if (ctx.roundRect) {
    ctx.roundRect(left, top, blockWidth, blockHeight, radius);
  } else {
    ctx.rect(left, top, blockWidth, blockHeight);
  }
  ctx.fill();
  ctx.restore();

  const brightness =
    (parseInt(color.slice(1, 3), 16) * 299 +
      parseInt(color.slice(3, 5), 16) * 587 +
      parseInt(color.slice(5, 7), 16) * 114) /
    1000;
  ctx.fillStyle = brightness > 150 ? "#111827" : "#ffffff";
  ctx.textBaseline = "top";
  lines.forEach((line, index) => {
    ctx.fillText(line, left + padding, top + padding + index * lineHeight);
  });
}

function drawBox(ctx, box, color, lineWidth, dashed = false) {
  const [x1, y1, x2, y2] = box;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  if (dashed) ctx.setLineDash([7, 5]);
  ctx.strokeRect(x1, y1, Math.max(1, x2 - x1), Math.max(1, y2 - y1));
  ctx.restore();
}

/**
 * Difuminado aproximado de la zona de la cabeza a partir de los puntos de pose.
 * No es un detector facial: solo cubre la región estimada por nariz, ojos y
 * orejas. Se aplica sobre el canvas de vista/descarga, nunca sobre el cuadro
 * que se envía a los modelos.
 */
function headBoxFor(person, width, height) {
  const keypoints = person.keypoints;
  if (!keypoints || keypoints.length !== 17) return null;
  const reliable = keypoints
    .map((point, index) =>
      index <= 4 && point.score >= HEAD_KEYPOINT_CONF ? point : null,
    )
    .filter(Boolean);
  if (!reliable.length) return null;
  const hasFace =
    keypoints[0]?.score >= HEAD_KEYPOINT_CONF ||
    (keypoints[1]?.score >= HEAD_KEYPOINT_CONF &&
      keypoints[2]?.score >= HEAD_KEYPOINT_CONF);
  if (!hasFace) return null;

  const xs = reliable.map((point) => point.x);
  const ys = reliable.map((point) => point.y);
  const centerX = (Math.min(...xs) + Math.max(...xs)) / 2;
  const centerY = (Math.min(...ys) + Math.max(...ys)) / 2;
  const ears =
    keypoints[3]?.score >= HEAD_KEYPOINT_CONF &&
    keypoints[4]?.score >= HEAD_KEYPOINT_CONF
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
      .map((point, index) => (point.score >= 0.35 ? index : -1))
      .filter((index) => index >= 0),
  );
  const radius = Math.max(2, Math.min(5, Math.round(fontSize / 4)));
  ctx.save();
  ctx.strokeStyle = COLORS.poseLine;
  ctx.lineWidth = Math.max(2, Math.round(radius / 2));
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

function personText(person) {
  const lines = [`Persona ${formatPercent(person.score)}`];
  if (person.state && person.state !== "Casco: no analizado") lines.push(person.state);
  if (person.poseState) lines.push(person.poseState);
  if (person.poseNote) lines.push(`Pose: ${person.poseNote}`);
  if (person.movement) lines.push(person.movement);
  return lines.join("\n");
}

function motorcycleText(motorcycle, index) {
  const id = motorcycle.trackId !== null ? `T${motorcycle.trackId}` : `M${index + 1}`;
  const lines = [`Moto ${id}`];
  if (motorcycle.occupants) lines.push(`Ocupantes: ${motorcycle.occupants}`);
  if (motorcycle.helmetSummary) lines.push(motorcycle.helmetSummary);
  if (motorcycle.movement) lines.push(motorcycle.movement);
  return lines.join("\n");
}

function helmetText(helmet) {
  const suffix = helmet.associated ? "" : " (no asociado)";
  return `${helmet.label || "Casco"} ${formatPercent(helmet.score)}${suffix}`;
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
  { drawSource = false, source = null, stale = false, ageMs = null, showAge = false } = {},
) {
  if (drawSource && source) {
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(source, 0, 0, width, height);
  } else {
    ctx.clearRect(0, 0, width, height);
  }
  if (!scene) return;

  const fontSize = Math.max(11, Math.min(22, Math.round(width / 45)));
  const lineWidth = Math.max(2, Math.round(width / 400));
  ctx.font = `600 ${fontSize}px system-ui, -apple-system, Segoe UI, sans-serif`;
  ctx.textBaseline = "top";

  ctx.save();
  if (stale) ctx.globalAlpha = 0.78;

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
    drawBox(ctx, helmet.box, colorFor(helmet), Math.max(1, lineWidth - 1), stale);
  }
  ctx.restore();

  // Etiquetas al final para que queden por encima del esqueleto.
  scene.persons.forEach((person) => {
    drawLabel(
      ctx,
      personText(person),
      person.box[0],
      person.box[1] - 4,
      COLORS.person,
      fontSize,
      width,
      height,
    );
  });
  scene.motorcycles.forEach((motorcycle, index) => {
    drawLabel(
      ctx,
      motorcycleText(motorcycle, index),
      motorcycle.box[0],
      motorcycle.box[1] - 4,
      COLORS.motorcycle,
      fontSize,
      width,
      height,
    );
  });
  scene.helmets.forEach((helmet) => {
    drawLabel(
      ctx,
      helmetText(helmet),
      helmet.box[0],
      helmet.box[1] - 4,
      colorFor(helmet),
      fontSize,
      width,
      height,
    );
  });

  if (showAge && ageMs !== null && Number.isFinite(ageMs)) {
    const text = stale
      ? `Detecciones atrasadas: hace ${formatAge(ageMs)}`
      : `Detecciones: hace ${formatAge(ageMs)}`;
    drawLabel(
      ctx,
      text,
      8,
      fontSize + 12,
      stale ? COLORS.stale : "#0f172a",
      fontSize,
      width,
      height,
    );
  }
}

export function composeAnnotatedCanvas(source, scene, width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const ctx = canvas.getContext("2d");
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  drawScene(ctx, scene, canvas.width, canvas.height, { drawSource: false });
  return canvas;
}
