# Avisos de terceros

Este proyecto incluye o redistribuye los siguientes componentes. Las licencias se reproducen en sus propios archivos cuando corresponde; este documento es un resumen y no sustituye a los textos completos.

## 1. Moto Observador web

- **Titularidad del código de esta reescritura:** el proyecto se distribuye bajo **GNU Affero General Public License v3.0** (AGPL-3.0). El texto completo está en `LICENSE`.
- **Motivo:** los pesos de Ultralytics incluidos en `models/yolo11n.onnx` y `models/yolo11n-pose.onnx` están bajo AGPL-3.0. La distribución conjunta se hace bajo esa licencia.
- **Código fuente:** al publicar el sitio, el repositorio que contiene `index.html`, `src/`, `styles.css`, `vendor/` y `models/` es el código fuente correspondiente.

## 2. Ultralytics YOLO11n y YOLO11n-pose

- **Componente:** pesos `yolo11n.pt` y `yolo11n-pose.pt`, convertidos a ONNX para esta versión web.
- **Origen:** Ultralytics (https://github.com/ultralytics/ultralytics).
- **Licencia:** AGPL-3.0, o licencia comercial de Ultralytics si se dispone de ella.
- **Uso en este proyecto:** detección de personas/motocicletas y pose de 17 puntos COCO.
- **Nota:** los archivos `.pt` originales del proyecto de escritorio no se modificaron; la conversión se hizo desde copias temporales y el resultado se guardó en esta carpeta web.

## 3. Modelo de casco `iam-tsr/yolov8n-helmet-detection`

- **Componente:** `best.pt` convertido a `models/helmet.onnx`.
- **Origen:** Hugging Face, `iam-tsr/yolov8n-helmet-detection` (https://huggingface.co/iam-tsr/yolov8n-helmet-detection).
- **Licencia declarada:** MIT en la model card de Hugging Face.
- **Dataset enlazado por la model card:** proyecto de Roboflow `learning-evidence/helmet-detection_yolov8` (https://universe.roboflow.com/learning-evidence/helmet-detection_yolov8). **La licencia del dataset no se verificó en esta revisión.** Antes de un uso institucional o de redistribución, revisa los términos del dataset y del modelo.
- **Clases observadas:** `0 = With Helmet`, `1 = Without Helmet`.
- **Uso en este proyecto:** componente opcional y desactivable. La ausencia de una detección no se interpreta como “sin casco”.

## 4. ONNX Runtime Web 1.31.1

- **Componente:** `vendor/ort/ort.min.js`, `ort-wasm-simd-threaded.jsep.mjs` y `ort-wasm-simd-threaded.jsep.wasm`.
- **Origen:** Microsoft ONNX Runtime (https://github.com/microsoft/onnxruntime).
- **Licencia:** MIT.
- **Uso:** ejecución local de los modelos ONNX en WebGPU o WebAssembly.

## 5. Modelo de armas

El detector experimental de armas del proyecto de escritorio **no se incluye** en esta versión web. No se redistribuye su peso ni su configuración. Su inclusión futura requeriría verificar licencia, origen, exportación y comportamiento.

## 6. Marcas y responsabilidad

Los nombres de productos y proyectos pertenecen a sus titulares. Este proyecto no está afiliado a Ultralytics, Microsoft, Hugging Face ni Roboflow. Se ofrece sin garantías, para observación y revisión humana; no determina infracciones ni identifica personas.
