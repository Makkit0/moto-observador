// Lógica de escena: seguimiento temporal, asociación espacial y conteos.
// Es una adaptación directa de app.py; los IDs son de trayectoria, no identidades.

import {
  boxArea,
  boxCenter,
  boxIou,
  containment,
  expandBox,
  intersectionArea,
} from "./utils.js";

export const TRACK_IOU_THRESHOLD = 0.3;
export const TRACK_MAX_AGE = 15;
export const MOVEMENT_WINDOW = 30;
export const MOVEMENT_TRAIL_LENGTH = 24;
export const MOVEMENT_MIN_FRAMES = 6;
export const MOVEMENT_DEFAULT_THRESHOLD = 0.015;
export const OCCUPANT_MIN_SCORE = 0.3;
export const OCCUPANT_AMBIGUITY_MARGIN = 0.12;
export const DEDUPE_IOU = 0.65;
export const DEDUPE_CONTAINMENT = 0.85;
export const HELMET_CLEAR_CONF = 0.6;
export const PERSON_ASSOC_MIN_CONF = 0.3;
export const POSE_KEYPOINT_CONF = 0.35;
export const POSE_MIN_RELIABLE_POINTS = 6;
export const POSE_HISTORY_LENGTH = 8;
export const POSE_MOVEMENT_RATIO = 0.02;
export const POSE_MATCH_MIN_IOU = 0.15;
export const POSE_MATCH_MIN_CONTAINMENT = 0.5;
export const SUMMARY_MAX_ROWS = 8;

function deduplicate(detections) {
  const kept = [];
  for (const detection of [...detections].sort((a, b) => b.score - a.score)) {
    let duplicate = false;
    for (const other of kept) {
      if (detection.kind !== other.kind) continue;
      if (
        boxIou(detection.box, other.box) >= DEDUPE_IOU ||
        containment(detection.box, other.box) >= DEDUPE_CONTAINMENT
      ) {
        duplicate = true;
        break;
      }
    }
    if (!duplicate) kept.push(detection);
  }
  return kept;
}

export function movementState(centers, width, height, threshold) {
  if (centers.length < MOVEMENT_MIN_FRAMES) return "movimiento incierto";
  const recent = centers.slice(-MOVEMENT_MIN_FRAMES);
  const dx = recent[recent.length - 1][0] - recent[0][0];
  const dy = recent[recent.length - 1][1] - recent[0][1];
  const diagonal = Math.hypot(width, height);
  if (diagonal <= 0) return "movimiento incierto";
  const displacement = Math.hypot(dx, dy) / diagonal;
  return displacement >= threshold ? "EN MOVIMIENTO" : "SIN MOVIMIENTO OBSERVABLE";
}

class Tracker {
  constructor() {
    this.iouThreshold = TRACK_IOU_THRESHOLD;
    this.maxAge = TRACK_MAX_AGE;
    this.historyGapLimit = 2;
    this.nextId = 1;
    this.tracks = new Map();
  }

  reset() {
    this.nextId = 1;
    this.tracks.clear();
  }

  configure(fpsLimit) {
    const fps = Number(fpsLimit) || 0;
    this.maxAge = fps ? Math.max(3, Math.min(TRACK_MAX_AGE, Math.round(fps * 0.75))) : TRACK_MAX_AGE;
    this.historyGapLimit = fps ? Math.max(2, Math.min(6, Math.round(fps * 0.5))) : 2;
    this.iouThreshold = fps > 0 && fps <= 5 ? 0.2 : TRACK_IOU_THRESHOLD;
  }

  update(detections, width, height, threshold) {
    const pairs = [];
    for (const [trackId, track] of this.tracks) {
      detections.forEach((detection, index) => {
        if (track.classId !== detection.classId) return;
        const iou = boxIou(track.box, detection.box);
        if (iou >= this.iouThreshold) pairs.push({ iou, trackId, index });
      });
    }
    pairs.sort((a, b) => b.iou - a.iou);

    const usedTracks = new Set();
    const usedDetections = new Set();
    for (const { trackId, index } of pairs) {
      if (usedTracks.has(trackId) || usedDetections.has(index)) continue;
      const track = this.tracks.get(trackId);
      const detection = detections[index];
      if (track.misses > this.historyGapLimit) track.centers = [];
      track.box = detection.box;
      track.misses = 0;
      detection.trackId = trackId;
      const center = boxCenter(detection.box);
      track.centers.push(center);
      if (track.centers.length > MOVEMENT_WINDOW) track.centers.shift();
      detection.trail = track.centers.slice(-MOVEMENT_TRAIL_LENGTH);
      detection.movement = movementState(track.centers, width, height, threshold);
      usedTracks.add(trackId);
      usedDetections.add(index);
    }

    for (const trackId of [...this.tracks.keys()]) {
      if (usedTracks.has(trackId)) continue;
      const track = this.tracks.get(trackId);
      track.misses += 1;
      if (track.misses > this.maxAge) this.tracks.delete(trackId);
    }

    detections.forEach((detection, index) => {
      if (usedDetections.has(index)) return;
      const trackId = this.nextId;
      this.nextId += 1;
      const center = boxCenter(detection.box);
      this.tracks.set(trackId, {
        trackId,
        classId: detection.classId,
        box: detection.box,
        misses: 0,
        centers: [center],
      });
      detection.trackId = trackId;
      detection.trail = [center];
      detection.movement = movementState([center], width, height, threshold);
    });
  }
}

export function poseQuality(keypoints) {
  const reliable = keypoints.filter((point) => point.score >= POSE_KEYPOINT_CONF).length;
  if (reliable === 0) return { state: "Pose: no determinada", reliable: 0 };
  if (reliable < POSE_MIN_RELIABLE_POINTS) {
    return { state: `Pose: parcial (${reliable}/17)`, reliable };
  }
  return { state: `Pose: ${reliable}/17 puntos`, reliable };
}

export function poseConfidence(keypoints) {
  const values = keypoints
    .filter((point) => point.score >= POSE_KEYPOINT_CONF)
    .map((point) => point.score);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function matchPoseToPerson(poseBox, persons, used) {
  let bestIndex = null;
  let bestScore = 0;
  persons.forEach((person, index) => {
    if (used.has(index)) return;
    const iou = boxIou(poseBox, person.box);
    const inside = containment(poseBox, person.box);
    if (iou < POSE_MATCH_MIN_IOU && inside < POSE_MATCH_MIN_CONTAINMENT) return;
    const score = Math.max(iou, inside * 0.8);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function poseDescriptor(keypoints, width, height, history) {
  if (!width || !height) return "";
  const diagonal = Math.hypot(width, height);
  const reliable = new Map();
  keypoints.forEach((point, index) => {
    if (point.score >= POSE_KEYPOINT_CONF) reliable.set(index, point);
  });

  const midpoint = (a, b) => {
    const first = reliable.get(a);
    const second = reliable.get(b);
    if (!first || !second) return null;
    return [(first.x + second.x) / 2, (first.y + second.y) / 2];
  };

  const notes = [];
  for (const [shoulder, wrist, side] of [
    [5, 9, "izquierdo"],
    [6, 10, "derecho"],
  ]) {
    const first = reliable.get(shoulder);
    const second = reliable.get(wrist);
    if (first && second && second.y < first.y - 0.06 * height) {
      notes.push(`brazo ${side} elevado`);
    }
  }

  const shoulders = midpoint(5, 6);
  const hips = midpoint(11, 12);
  if (shoulders && hips) {
    const dx = shoulders[0] - hips[0];
    const dy = hips[1] - shoulders[1];
    if (dy > 0 && Math.abs(dx) / dy > 0.36) notes.push("torso inclinado");
  }

  if (history && history.length >= 3) {
    const oldest = history[0];
    const newest = history[history.length - 1];
    const span = newest.t - oldest.t;
    if (span >= 0.2) {
      for (const [key, label] of [
        ["wrist", "brazo en movimiento"],
        ["ankle", "piernas en movimiento"],
      ]) {
        const first = oldest[key];
        const last = newest[key];
        if (!first || !last) continue;
        if (Math.hypot(last[0] - first[0], last[1] - first[1]) >= POSE_MOVEMENT_RATIO * diagonal) {
          notes.push(label);
          break;
        }
      }
    }
  }

  return [...new Set(notes)].slice(0, 3).join(", ");
}

function poseHistoryEntry(keypoints, time) {
  const center = (...indices) => {
    const points = indices
      .map((index) => keypoints[index])
      .filter((point) => point && point.score >= POSE_KEYPOINT_CONF);
    if (!points.length) return null;
    return [
      points.reduce((sum, point) => sum + point.x, 0) / points.length,
      points.reduce((sum, point) => sum + point.y, 0) / points.length,
    ];
  };
  return { t: time, wrist: center(9, 10), ankle: center(15, 16) };
}

function helmetPersonMatch(helmetBox, personBox) {
  const centerX = (helmetBox[0] + helmetBox[2]) / 2;
  const centerY = (helmetBox[1] + helmetBox[3]) / 2;
  const expanded = expandBox(personBox, 0.05);
  if (
    centerX < expanded[0] ||
    centerX > expanded[2] ||
    centerY < expanded[1] ||
    centerY > expanded[3]
  ) {
    return false;
  }
  if (containment(helmetBox, personBox) < 0.55) return false;
  const personHeight = Math.max(1, personBox[3] - personBox[1]);
  return centerY <= personBox[1] + 0.6 * personHeight;
}

function associateHelmets(persons, helmets, confidence) {
  const associations = persons.map(() => []);
  const minPersonConf = Math.max(confidence, PERSON_ASSOC_MIN_CONF);
  for (const helmet of helmets) {
    const candidates = [];
    persons.forEach((person, index) => {
      if (person.score < minPersonConf) return;
      if (helmetPersonMatch(helmet.box, person.box)) {
        candidates.push({ containment: containment(helmet.box, person.box), index });
      }
    });
    if (!candidates.length) continue;
    candidates.sort((a, b) => b.containment - a.containment);
    if (
      candidates.length > 1 &&
      candidates[0].containment - candidates[1].containment < 0.1
    ) {
      continue;
    }
    helmet.associated = true;
    associations[candidates[0].index].push(helmet);
  }
  return associations;
}

function personHelmetState(person, helmets, confidence) {
  if (person.score < Math.max(confidence, PERSON_ASSOC_MIN_CONF)) return "INDETERMINADO";
  const clearConf = Math.max(confidence, HELMET_CLEAR_CONF);
  const states = new Set(
    helmets
      .filter(
        (helmet) =>
          helmet.score >= clearConf && (helmet.state === "CON CASCO" || helmet.state === "SIN CASCO"),
      )
      .map((helmet) => helmet.state),
  );
  if (states.size === 1) return [...states][0];
  return "INDETERMINADO";
}

function motorcyclePersonScore(person, motorcycle) {
  const [px1, py1, px2, py2] = person.box;
  const [mx1, my1, mx2, my2] = motorcycle.box;
  const pw = Math.max(1, px2 - px1);
  const ph = Math.max(1, py2 - py1);
  const mw = Math.max(1, mx2 - mx1);
  const mh = Math.max(1, my2 - my1);
  const [pcx] = boxCenter(person.box);

  if (pcx < mx1 - 0.3 * mw || pcx > mx2 + 0.3 * mw) return 0;
  if (py2 < my1 - 0.2 * mh || py2 > my2 + 0.3 * mh) return 0;
  if (ph > 3 * mh || pw > 2.5 * mw) return 0;

  const intersection = intersectionArea(person.box, motorcycle.box);
  if (intersection <= 0) return 0;

  let score = 0;
  if (pcx >= mx1 && pcx <= mx2) score += 0.3;
  if (py2 >= my1 && py2 <= my2 + 0.1 * mh) score += 0.2;
  score += 0.3 * Math.min(1, intersection / Math.max(1, boxArea(person.box)));
  score += 0.2 * Math.min(1, intersection / Math.max(1, boxArea(motorcycle.box)));
  if (py2 < my1 + 0.05 * mh) score -= 0.15;
  return Math.max(0, Math.min(1, score));
}

function associateOccupants(persons, motorcycles) {
  const assignments = motorcycles.map(() => []);
  const uncertain = motorcycles.map(() => false);

  for (const person of persons) {
    const scores = [];
    motorcycles.forEach((motorcycle, index) => {
      const score = motorcyclePersonScore(person, motorcycle);
      if (score >= OCCUPANT_MIN_SCORE) scores.push({ score, index });
    });
    scores.sort((a, b) => b.score - a.score);
    if (!scores.length) continue;

    const best = scores[0];
    const second = scores[1]?.score ?? 0;
    if (scores.length > 1 && best.score - second < OCCUPANT_AMBIGUITY_MARGIN) {
      for (const item of scores) uncertain[item.index] = true;
      continue;
    }

    assignments[best.index].push(person);
    for (const item of scores.slice(1)) {
      if (item.score >= best.score - OCCUPANT_AMBIGUITY_MARGIN) {
        uncertain[best.index] = true;
        uncertain[item.index] = true;
      }
    }
  }
  return { assignments, uncertain };
}

function motorcycleHelmetSummary(persons) {
  if (!persons.length) return "Casco: no se puede determinar";
  const states = persons
    .map((person) => person.state)
    .filter((state) => state === "CON CASCO" || state === "SIN CASCO");
  if (!states.length || states.length < persons.length) return "Casco: incierto";
  if (new Set(states).size === 1) {
    return states[0] === "CON CASCO" ? "Casco: con casco" : "Casco: sin casco";
  }
  return "Casco: mixto (revisar)";
}

function buildEvents(persons, motorcycles) {
  const events = [];
  for (const person of persons) {
    if (person.state === "SIN CASCO") {
      events.push({
        type: "persona sin casco",
        trackId: person.trackId,
        confidence: person.score,
        detail: "",
      });
    }
    if (person.poseNote) {
      events.push({
        type: `pose: ${person.poseNote}`,
        trackId: person.trackId,
        confidence: poseConfidence(person.keypoints),
        detail: "observación de pose, no una acción compleja",
      });
    }
  }
  for (const motorcycle of motorcycles) {
    if (motorcycle.helmetSummary === "Casco: mixto (revisar)") {
      events.push({
        type: "moto con casco mixto",
        trackId: motorcycle.trackId,
        confidence: motorcycle.score,
        detail: "revisar personas asociadas",
      });
    }
    if (motorcycle.occupantCount !== null && motorcycle.occupantCount >= 3) {
      events.push({
        type: "moto con más de 2 ocupantes estimados",
        trackId: motorcycle.trackId,
        confidence: motorcycle.score,
        detail: "asociación espacial, no identifica quién conduce",
      });
    }
  }
  return events;
}

export class ScenePipeline {
  constructor() {
    this.tracker = new Tracker();
    this.poseHistory = new Map();
  }

  reset() {
    this.tracker.reset();
    this.poseHistory.clear();
  }

  configure({ fpsLimit } = {}) {
    this.tracker.configure(fpsLimit);
  }

  process({
    persons = [],
    motorcycles = [],
    helmets = [],
    poses = [],
    width,
    height,
    confidence = 0.25,
    helmetEnabled = false,
    poseEnabled = false,
    track = false,
    movementThreshold = MOVEMENT_DEFAULT_THRESHOLD,
    poseError = "",
    now = performance.now(),
  }) {
    const detections = deduplicate([...persons, ...motorcycles]).map((item) => ({
      ...item,
      trackId: null,
      state: "",
      associated: false,
      movement: "",
      occupants: "",
      helmetSummary: "",
      occupantCount: null,
      occupantsUncertain: false,
      trail: [],
      keypoints: [],
      poseState: "",
      poseNote: "",
    }));
    if (track) this.tracker.update(detections, width, height, movementThreshold);

    const personList = detections.filter((item) => item.kind === "person");
    const motorcycleList = detections.filter((item) => item.kind === "motorcycle");

    let poseAnalysed = false;
    if (poseEnabled && !poseError) {
      const used = new Set();
      for (const pose of poses) {
        const target = matchPoseToPerson(pose.box, personList, used);
        if (target === null) continue;
        used.add(target);
        const person = personList[target];
        person.keypoints = pose.keypoints;
        const quality = poseQuality(pose.keypoints);
        person.poseState = quality.state;
        const history =
          person.trackId !== null ? this.poseHistory.get(person.trackId) : undefined;
        person.poseNote = poseDescriptor(pose.keypoints, width, height, history);
        if (person.trackId !== null) {
          if (!this.poseHistory.has(person.trackId)) this.poseHistory.set(person.trackId, []);
          const entries = this.poseHistory.get(person.trackId);
          entries.push(poseHistoryEntry(pose.keypoints, now / 1000));
          while (entries.length > POSE_HISTORY_LENGTH) entries.shift();
        }
      }
      poseAnalysed = true;
      const currentIds = new Set(
        personList.filter((person) => person.trackId !== null).map((person) => person.trackId),
      );
      for (const trackId of [...this.poseHistory.keys()]) {
        if (!currentIds.has(trackId)) this.poseHistory.delete(trackId);
      }
    }
    if (poseEnabled && poseAnalysed) {
      for (const person of personList) {
        if (!person.poseState) person.poseState = "Pose: no determinada";
      }
    }

    if (helmetEnabled) {
      const associations = associateHelmets(personList, helmets, confidence);
      personList.forEach((person, index) => {
        person.state = personHelmetState(person, associations[index], confidence);
      });
    } else {
      personList.forEach((person) => {
        person.state = "Casco: no analizado";
      });
    }

    const { assignments, uncertain } = associateOccupants(personList, motorcycleList);
    motorcycleList.forEach((motorcycle, index) => {
      const assigned = assignments[index];
      const count = assigned.length;
      motorcycle.occupantCount = count > 0 ? count : null;
      motorcycle.occupantsUncertain = uncertain[index];
      motorcycle.helmetSummary = helmetEnabled
        ? motorcycleHelmetSummary(assigned)
        : "Casco: no analizado";
      if (count === 0) {
        motorcycle.occupants = uncertain[index] ? "incierto" : "no se puede determinar";
      } else if (count === 1) {
        motorcycle.occupants = uncertain[index] ? "1 (incierto)" : "1";
      } else if (count === 2) {
        motorcycle.occupants = uncertain[index] ? "2 (incierto)" : "2";
      } else {
        motorcycle.occupants = uncertain[index] ? "más de 2 (incierto)" : "más de 2";
      }
    });

    const counts = {
      personas: personList.length,
      motocicletas: motorcycleList.length,
      cascoAnalizado: helmetEnabled,
      conCasco: personList.filter((person) => person.state === "CON CASCO").length,
      sinCasco: personList.filter((person) => person.state === "SIN CASCO").length,
      indeterminado: personList.filter((person) => person.state === "INDETERMINADO").length,
      cascosNoAsociados: helmets.filter((helmet) => !helmet.associated).length,
      motos1: motorcycleList.filter((moto) => moto.occupantCount === 1).length,
      motos2: motorcycleList.filter((moto) => moto.occupantCount === 2).length,
      motosMas2: motorcycleList.filter(
        (moto) => moto.occupantCount !== null && moto.occupantCount > 2,
      ).length,
      motosIndeterminadas: motorcycleList.filter((moto) => moto.occupantCount === null).length,
      motosInciertas: motorcycleList.filter((moto) => moto.occupantsUncertain).length,
      motosCascoCon: motorcycleList.filter((moto) => moto.helmetSummary === "Casco: con casco")
        .length,
      motosCasoSin: motorcycleList.filter((moto) => moto.helmetSummary === "Casco: sin casco")
        .length,
      motosCascoMixto: motorcycleList.filter(
        (moto) => moto.helmetSummary === "Casco: mixto (revisar)",
      ).length,
      motosCascoIncierto: motorcycleList.filter(
        (moto) =>
          moto.helmetSummary === "Casco: incierto" ||
          moto.helmetSummary === "Casco: no se puede determinar",
      ).length,
      motosCascoNoAnalizado: motorcycleList.filter(
        (moto) => moto.helmetSummary === "Casco: no analizado",
      ).length,
      enMovimiento: detections.filter((item) => item.movement === "EN MOVIMIENTO").length,
      poseAnalizada: poseEnabled && poseAnalysed,
      posePersonas: personList.filter((person) => person.keypoints.length > 0).length,
      poseParcial: personList.filter((person) => person.poseState.startsWith("Pose: parcial"))
        .length,
      poseNoDeterminada: personList.filter((person) => person.poseState === "Pose: no determinada")
        .length,
      poseError: poseEnabled && !poseAnalysed ? poseError : "",
      motosResumen: motorcycleList.map((motorcycle, index) => ({
        index: index + 1,
        trackId: motorcycle.trackId,
        occupants: motorcycle.occupants || "no se puede determinar",
        occupantCount: motorcycle.occupantCount,
        occupantsUncertain: motorcycle.occupantsUncertain,
        helmet: motorcycle.helmetSummary || "Casco: no analizado",
        movement: motorcycle.movement || "",
      })),
      eventos: buildEvents(personList, motorcycleList),
    };

    return { persons: personList, motorcycles: motorcycleList, helmets, counts };
  }
}
