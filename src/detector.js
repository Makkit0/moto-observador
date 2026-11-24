// Carga y ejecución de los modelos ONNX con ONNX Runtime Web.
// La inferencia ocurre íntegramente en el navegador: no se envía ninguna imagen.

import { clipBox, letterboxParams, nms, normalizeName } from "./utils.js";

const INPUT_SIZE = 640;
const IOU_THRESHOLD = 0.45;
const MAX_DETECTIONS = 100;

export const MODEL_DEFS = {
  base: {
    label: "Personas y motocicletas",
    url: "models/yolo11n.onnx",
    size: "10.7 MB",
    classes: [0, 3],
    task: "detect",
  },
  helmet: {
    label: "Casco",
    url: "models/helmet.onnx",
    size: "12.3 MB",
    classes: [0, 1],
    task: "detect",
  },
  pose: {
    label: "Pose corporal",
    url: "models/yolo11n-pose.onnx",
    size: "11.9 MB",
    classes: [0],
    task: "pose",
  },
};

export function helmetState(name) {
  const key = normalizeName(name);
  if (
    key.includes("no_helmet") ||
    key.includes("nohelmet") ||
    key.includes("without_helmet") ||
    key.includes("withouthelmet")
  ) {
    return "SIN CASCO";
  }
  if (key.includes("helmet")) {
    return "CON CASCO";
  }
  return "INDETERMINADO";
}

function parseNames(raw) {
  if (!raw) return null;
  try {
    const normalized = String(raw)
      .replaceAll("'", '"')
      .replace(/([{,]\s*)(\d+)\s*:/g, '$1"$2":');
    return JSON.parse(normalized);
  } catch {
    return null;
  }
}

class Preprocessor {
  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.width = INPUT_SIZE;
    this.canvas.height = INPUT_SIZE;
    this.context = this.canvas.getContext("2d", { willReadFrequently: true });
    this.buffer = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE);
  }

  prepare(source, width, height) {
    const params = letterboxParams(width, height, INPUT_SIZE);
    const ctx = this.context;
    ctx.fillStyle = "#727272";
    ctx.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, params.left, params.top, params.drawWidth, params.drawHeight);

    const pixels = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE).data;
    const area = INPUT_SIZE * INPUT_SIZE;
    const buffer = this.buffer;
    for (let i = 0, p = 0; i < area; i += 1, p += 4) {
      buffer[i] = pixels[p] / 255;
      buffer[area + i] = pixels[p + 1] / 255;
      buffer[2 * area + i] = pixels[p + 2] / 255;
    }
    return {
      params,
      tensor: new window.ort.Tensor("float32", buffer, [1, 3, INPUT_SIZE, INPUT_SIZE]),
    };
  }
}

export class Detector {
  constructor({ onModelStatus } = {}) {
    this.onModelStatus = onModelStatus || (() => {});
    this.ort = window.ort || null;
    this.sessions = {};
    this.metadata = {};
    this.failures = {};
    this.ep = null;
    this.ready = false;
    this.webgpuAvailable = false;
    this.preprocessor = new Preprocessor();
  }

  async init() {
    if (this.ready) return;
    if (!this.ort) {
      throw new Error(
        "No se cargó ONNX Runtime Web. Revisa que vendor/ort/ort.min.js exista en el sitio.",
      );
    }
    this.ort.env.wasm.wasmPaths = new URL("../vendor/ort/", import.meta.url).href;
    // GitHub Pages no permite los encabezados COOP/COEP que necesitan los
    // hilos de WebAssembly. Una sola hebra evita fallos de inicialización.
    this.ort.env.wasm.numThreads = 1;
    this.ort.env.wasm.proxy = false;
    this.ort.env.logLevel = "error";

    // Permite forzar CPU con ?runtime=wasm. Sirve para equipos con WebGPU
    // inestable y para comprobar el respaldo sin cambiar el código.
    const forcedRuntime = new URLSearchParams(window.location.search).get("runtime");
    this.webgpuAvailable = Boolean(navigator.gpu) && forcedRuntime !== "wasm";
    if (this.webgpuAvailable) {
      try {
        const adapter = await navigator.gpu.requestAdapter();
        this.webgpuAvailable = Boolean(adapter);
      } catch {
        this.webgpuAvailable = false;
      }
    }
    this.ep = this.webgpuAvailable ? "webgpu" : "wasm";
    this.ready = true;
  }

  describeRuntime() {
    return this.ep === "webgpu" ? "WebGPU" : "WASM (CPU)";
  }

  async createSession(url, ep, warmup) {
    const session = await this.ort.InferenceSession.create(url, {
      executionProviders: [ep],
      graphOptimizationLevel: "all",
    });
    if (warmup) {
      const inputName = session.inputNames[0];
      const zeros = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE);
      await session.run({
        [inputName]: new this.ort.Tensor("float32", zeros, [1, 3, INPUT_SIZE, INPUT_SIZE]),
      });
    }
    return session;
  }

  async loadModel(kind) {
    await this.init();
    if (this.sessions[kind]) return this.sessions[kind];
    if (this.failures[kind]) throw new Error(this.failures[kind]);
    const def = MODEL_DEFS[kind];
    if (!def) throw new Error(`Modelo desconocido: ${kind}`);
    const url = new URL(def.url, document.baseURI).href;
    this.onModelStatus(kind, "cargando", "Descargando y preparando…");

    let session = null;
    if (this.ep === "webgpu") {
      try {
        session = await this.createSession(url, "webgpu", true);
      } catch (error) {
        console.warn("WebGPU no pudo ejecutar el modelo; se intenta WASM.", error);
        if (session?.release) session.release();
        session = null;
        this.ep = "wasm";
        this.onModelStatus(
          "runtime",
          "aviso",
          "WebGPU no pudo ejecutar el modelo; se usa WASM (CPU).",
        );
      }
    }
    if (!session) {
      try {
        session = await this.createSession(url, "wasm", true);
      } catch (error) {
        const message = error.message || String(error);
        this.failures[kind] = `No se pudo cargar ${def.label}: ${message}`;
        this.onModelStatus(kind, "error", message);
        throw new Error(this.failures[kind]);
      }
    }

    try {
      this.verifyMetadata(kind, session);
    } catch (error) {
      if (session.release) session.release();
      this.failures[kind] = error.message || String(error);
      this.onModelStatus(kind, "error", error.message);
      throw error;
    }

    this.sessions[kind] = session;
    this.onModelStatus(kind, "listo", this.describeRuntime());
    return session;
  }

  verifyMetadata(kind, session) {
    let custom = {};
    try {
      const map = session.modelMetadata?.customMetadataMap;
      if (map instanceof Map) {
        custom = Object.fromEntries(map.entries());
      } else if (map && typeof map === "object") {
        custom = map;
      }
    } catch {
      custom = {};
    }
    const rawNames = typeof custom.names === "string" ? custom.names : "";
    const names = parseNames(rawNames);
    this.metadata[kind] = { names, raw: rawNames };
    if (!names) {
      // El export fue verificado durante el desarrollo. Si el navegador no
      // expone metadatos, se usan los IDs comprobados y se documenta.
      return;
    }
    if (kind === "base") {
      if (
        normalizeName(names[0]) !== "person" ||
        normalizeName(names[3]) !== "motorcycle"
      ) {
        throw new Error(
          "El modelo base no declara 0=person y 3=motorcycle. Se evita usar IDs a ciegas.",
        );
      }
    }
    if (kind === "pose" && normalizeName(names[0]) !== "person") {
      throw new Error("El modelo de pose no declara 0=person.");
    }
    if (kind === "helmet") {
      const values = Object.values(names).map(normalizeName);
      if (!values.some((value) => value.includes("helmet"))) {
        throw new Error("El modelo de casco no declara clases de casco reconocibles.");
      }
    }
  }

  async runSession(kind, tensor) {
    const session = await this.loadModel(kind);
    const inputName = session.inputNames[0];
    try {
      return await session.run({ [inputName]: tensor });
    } catch (error) {
      if (this.ep !== "webgpu") throw error;
      console.warn(`Fallo de WebGPU en ${kind}; se reintenta con WASM.`, error);
      if (session.release) session.release();
      delete this.sessions[kind];
      this.ep = "wasm";
      this.onModelStatus(
        "runtime",
        "aviso",
        "WebGPU falló durante la inferencia; se usa WASM (CPU).",
      );
      const fallback = await this.loadModel(kind);
      return fallback.run({ [fallback.inputNames[0]]: tensor });
    }
  }

  decodeDetect(output, prep, sourceWidth, sourceHeight, confidence, classIds) {
    const [batch, channels, count] = output.dims;
    if (batch !== 1 || !count) return [];
    const data = output.data;
    const candidates = [];
    for (let i = 0; i < count; i += 1) {
      let bestClass = -1;
      let bestScore = 0;
      for (const classId of classIds) {
        const score = data[(4 + classId) * count + i];
        if (score > bestScore) {
          bestScore = score;
          bestClass = classId;
        }
      }
      if (bestClass < 0 || bestScore < confidence) continue;
      const cx = data[i];
      const cy = data[count + i];
      const width = data[2 * count + i];
      const height = data[3 * count + i];
      const box = clipBox(
        [
          (cx - width / 2 - prep.left) / prep.scale,
          (cy - height / 2 - prep.top) / prep.scale,
          (cx + width / 2 - prep.left) / prep.scale,
          (cy + height / 2 - prep.top) / prep.scale,
        ],
        sourceWidth,
        sourceHeight,
      );
      candidates.push({ classId: bestClass, score: bestScore, box });
    }

    const byClass = new Map();
    for (const candidate of candidates) {
      if (!byClass.has(candidate.classId)) byClass.set(candidate.classId, []);
      byClass.get(candidate.classId).push(candidate);
    }
    const kept = [];
    for (const list of byClass.values()) {
      const boxes = list.map((item) => item.box);
      const scores = list.map((item) => item.score);
      for (const index of nms(boxes, scores, IOU_THRESHOLD)) {
        kept.push(list[index]);
      }
    }
    kept.sort((a, b) => b.score - a.score);
    return kept.slice(0, MAX_DETECTIONS);
  }

  decodePose(output, prep, sourceWidth, sourceHeight, confidence) {
    const [, channels, count] = output.dims;
    if (!count) return [];
    const data = output.data;
    const candidates = [];
    for (let i = 0; i < count; i += 1) {
      const score = data[4 * count + i];
      if (score < confidence) continue;
      const cx = data[i];
      const cy = data[count + i];
      const width = data[2 * count + i];
      const height = data[3 * count + i];
      const box = clipBox(
        [
          (cx - width / 2 - prep.left) / prep.scale,
          (cy - height / 2 - prep.top) / prep.scale,
          (cx + width / 2 - prep.left) / prep.scale,
          (cy + height / 2 - prep.top) / prep.scale,
        ],
        sourceWidth,
        sourceHeight,
      );
      const keypoints = [];
      for (let k = 0; k < 17; k += 1) {
        const x = data[(5 + 3 * k) * count + i];
        const y = data[(6 + 3 * k) * count + i];
        const c = data[(7 + 3 * k) * count + i];
        keypoints.push({
          x: (x - prep.left) / prep.scale,
          y: (y - prep.top) / prep.scale,
          score: c,
        });
      }
      candidates.push({ score, box, keypoints });
    }
    const boxes = candidates.map((item) => item.box);
    const scores = candidates.map((item) => item.score);
    return nms(boxes, scores, IOU_THRESHOLD)
      .map((index) => candidates[index])
      .slice(0, MAX_DETECTIONS);
  }

  /**
   * Ejecuta el modelo base y, opcionalmente, casco y pose sobre el mismo
   * cuadro. Devuelve detecciones en coordenadas de la fuente original.
   */
  async analyze(source, width, height, { confidence = 0.25, helmet = false, pose = false } = {}) {
    await this.loadModel("base");
    const prep = this.preprocessor.prepare(source, width, height);
    const timings = { base: 0, helmet: 0, pose: 0 };

    let started = performance.now();
    const baseOutput = await this.runSession("base", prep.tensor);
    timings.base = performance.now() - started;
    const baseItems = this.decodeDetect(
      baseOutput[Object.keys(baseOutput)[0]],
      prep.params,
      width,
      height,
      confidence,
      MODEL_DEFS.base.classes,
    );

    let helmets = [];
    const errors = {};
    if (helmet) {
      started = performance.now();
      try {
        const helmetOutput = await this.runSession("helmet", prep.tensor);
        timings.helmet = performance.now() - started;
        helmets = this.decodeDetect(
          helmetOutput[Object.keys(helmetOutput)[0]],
          prep.params,
          width,
          height,
          confidence,
          MODEL_DEFS.helmet.classes,
        ).map((item) => {
          const names = this.metadata.helmet?.names || {};
          const name = names[item.classId] || (item.classId === 0 ? "With Helmet" : "Without Helmet");
          return { ...item, label: name, state: helmetState(name) };
        });
      } catch (error) {
        errors.helmet = error.message || String(error);
        this.onModelStatus("helmet", "error", errors.helmet);
      }
    }

    let poses = [];
    if (pose) {
      started = performance.now();
      try {
        const poseOutput = await this.runSession("pose", prep.tensor);
        timings.pose = performance.now() - started;
        poses = this.decodePose(
          poseOutput[Object.keys(poseOutput)[0]],
          prep.params,
          width,
          height,
          confidence,
        );
      } catch (error) {
        errors.pose = error.message || String(error);
        this.onModelStatus("pose", "error", errors.pose);
      }
    }

    return {
      persons: baseItems
        .filter((item) => item.classId === 0)
        .map((item) => ({ ...item, kind: "person", label: "Persona" })),
      motorcycles: baseItems
        .filter((item) => item.classId === 3)
        .map((item) => ({ ...item, kind: "motorcycle", label: "Motocicleta" })),
      helmets,
      poses,
      timings,
      errors,
      runtime: this.describeRuntime(),
    };
  }
}
