# Moto Observador web

Aplicación web estática para observar **personas, motocicletas, ocupantes estimados, casco y pose corporal opcional** en una imagen, un video o una cámara local. La inferencia se ejecuta **íntegramente en el navegador** con ONNX Runtime Web; no hay servidor de inferencia, no se suben imágenes y no se usan cuentas ni analítica.

Esta carpeta es una reescritura web independiente del proyecto de escritorio PySide6. **El proyecto original de escritorio no se modificó** y sigue siendo la referencia funcional.

- **Ruta de este proyecto:** `C:\Users\User\Desktop\moto_observador_escritorio\Moto_Observador_Git\`
- **Nota de nombre:** se pidió `Moto_Observador_Git`; la variante con error tipográfico `Moro_Observador_Git` no existe. Se usó la carpeta existente `Moto_Observador_Git`.
- **Estado:** funcional en Chromium de escritorio con WebGPU y con WASM forzado. No se probó con cámara física, PTZ, Firefox, Safari ni móviles.

---

## 1. Qué hace y qué no hace

### Funciones ejecutables

- **Imagen local:** selección de archivo, inferencia, cajas y etiquetas, conteos y descarga de la imagen anotada en PNG.
- **Video local:** reproducción, pausa, detención, análisis por cuadros con límite de FPS, descarga del fotograma anotado y grabación opcional del canvas anotado (WebM/MP4 según el navegador).
- **Cámara local:** selección de cámara, resoluciones solicitadas 320×240, 640×480, 1280×720 o nativa; se muestra la **resolución real** entregada por el navegador. Inicio y detención explícitos.
- **Detección:** personas y motocicletas del modelo COCO, con caja y confianza.
- **Seguimiento temporal:** IDs `T#` de trayectoria, estelas y estado de movimiento (`EN MOVIMIENTO`, `SIN MOVIMIENTO OBSERVABLE`, `movimiento incierto`). Los IDs **no son identidades**.
- **Ocupantes estimados:** asociación espacial persona–moto con resultados como `1`, `2`, `más de 2`, `incierto` o `no se puede determinar`.
- **Casco:** modelo opcional; solo se declara `CON CASCO` o `SIN CASCO` cuando hay una detección explícita con confianza suficiente. La **ausencia de una detección nunca se interpreta como “sin casco”**: queda como incierto.
- **Pose corporal:** modelo opcional de 17 puntos COCO, con puntos confiables, pose parcial y `Pose: no determinada`. No reconoce acciones complejas.
- **Controles:** límite de FPS de análisis, umbral de confianza, umbral de movimiento y activación/desactivación de casco y pose.
- **Estado visible:** runtime (WebGPU o WASM), estado de cada modelo, resolución, FPS de análisis, milisegundos de inferencia, cuadros analizados y advertencias/errores.
- **Registro TXT de cámara:** se genera al iniciar la cámara y se descarga al pulsar **Detener cámara**. Contiene fecha/hora, duración, resolución, modelos y descripciones neutrales de señales. **No contiene cuadros, video, rostros, placas, identidades ni coordenadas del esqueleto.**
- **Descargas solo por acción del usuario:** imagen anotada, fotograma anotado, grabación del canvas y TXT. No hay descargas automáticas de resultados, salvo el TXT al detener la cámara, que es el comportamiento solicitado.

### Excluido por diseño

- No se suben imágenes, videos ni cuadros de cámara.
- No hay analítica, cuentas, login, rastreo entre sitios ni publicidad.
- No hay reconocimiento facial, lectura de placas, identificación de personas ni seguimiento de identidad.
- No se determina si existe una infracción; solo se muestran señales para revisión humana.

### Pendiente o no migrado

- **Detector experimental de armas de fuego:** excluido de esta versión web. No se publicó su modelo porque no se pudo verificar de forma suficiente licencia, origen, exportación y comportamiento para un sitio público.
- **Validación con cámara física/PTZ:** no se dispone de hardware en este entorno. El flujo de cámara se probó con un `MediaStream` sintético, no con una cámara real.
- **Pruebas multi-navegador y multi-equipo:** solo se probó en Chromium de escritorio en Windows 11. No se afirma compatibilidad verificada con Firefox, Safari, Edge, móviles ni otros equipos.
- **Revisión de licencia del dataset del modelo de casco:** el modelo declara MIT, pero el dataset de origen (Roboflow) debe revisarse antes de un uso institucional.
- **Grabación de video anotado:** es una captura en tiempo real del canvas con `MediaRecorder`; no es una re-codificación del archivo original. Depende del navegador y puede perder cuadros.
- **Audio:** no se procesa ni se graba audio.
- **Persistencia:** al recargar se pierde el estado; no hay almacenamiento local de resultados.

---

## 2. Requisitos

### Navegador

- Navegador moderno con **JavaScript, ES modules, Canvas 2D y WebAssembly**.
- **WebGPU** es opcional y se intenta primero. Si no está disponible o falla, se usa **WebAssembly (CPU)**.
- Para la cámara se necesita **HTTPS** o `http://localhost`. Los navegadores no permiten `getUserMedia` en `file://` ni en HTTP no local.
- La primera carga descarga el runtime y los modelos (unos 65 MB en total). Después el navegador puede reutilizar la caché.
- No se necesita Python, Node, Flask, PySide6, Electron, instalador ni `.exe` para el usuario final.

### Para probar en local

El sitio debe servirse por HTTP; abrir `index.html` con doble clic (`file://`) no funciona porque los módulos ES y la cámara requieren un origen HTTP(S). En ese caso la página muestra un **aviso rojo** explicándolo y el botón **Usar cámara** no puede abrir el panel.

```powershell
cd "C:\Users\User\Desktop\moto_observador_escritorio\Moto_Observador_Git"
python -m http.server 8123
```

Abrir **`http://localhost:8123/`** (no `file://`). Python solo se usa como servidor estático de prueba; **no es un requisito del proyecto publicado**. Cualquier servidor estático equivalente sirve: `npx serve`, Live Server de VS Code, etc.

> **Cámara en local:** `http://localhost` y `http://127.0.0.1` son contextos seguros, así que la cámara funciona ahí. Si abres la vista local desde la IP de tu red (por ejemplo `http://192.168.1.20:8123`) el navegador **bloqueará** la cámara por no ser un contexto seguro. Para usar la cámara desde otro equipo, publica el sitio en GitHub Pages (HTTPS) o configura HTTPS local.

Para forzar CPU/WASM y comprobar el respaldo:

```text
http://localhost:8123/?runtime=wasm
```

### Si no puedes usar localhost

`localhost` es solo una comodidad para probar en tu propio equipo. **No hace falta para usar la aplicación ni para compartirla.** Tienes estas opciones:

1. **Publicar en GitHub Pages (recomendado, ya está preparado).** El sitio queda en una URL `https://…github.io/…` con HTTPS, que es un contexto seguro: los módulos cargan y la cámara funciona. Pasos en la sección 5. No necesitas Python ni instalar nada para el usuario final.
2. **Publicar en otro hosting estático con HTTPS.** Por ejemplo Netlify Drop (arrastrar la carpeta y obtener una URL), Cloudflare Pages, Vercel o Firebase Hosting. Sirve cualquier hosting que entregue los archivos por HTTPS y respete las rutas.
3. **VS Code Live Server.** Abre la carpeta en VS Code, instala la extensión *Live Server* y pulsa «Go Live». Te da una URL `http://127.0.0.1:5500/…` (equivale a localhost).
4. **`npx serve`** si tienes Node: `npx serve .` y abre la URL que indica.

Lo que **no** funciona es abrir `index.html` con doble clic (`file://`) ni compartir la carpeta o el ZIP: quien lo reciba tendrá el mismo bloqueo de módulos y de cámara. **Comparte siempre la URL publicada**, no el archivo.

### Qué necesita otra persona que abre el enlace

- Un navegador moderno (recomendado Chrome o Edge actualizados). No necesita instalar Python, Node, `.exe` ni nada.
- Abrir la **URL HTTPS** publicada, no un archivo descargado.
- Conceder permiso de cámara **a ese sitio** la primera vez que pulse **Iniciar cámara**. El permiso es por origen: el tuyo de `localhost` no se hereda, y el de una persona no afecta a otra.
- Conexión para la primera carga (unos 65 MB de modelos y runtime); después el navegador puede usar caché.
- Si su equipo no tiene cámara, la aplicación sigue funcionando con imagen y video; solo el botón de cámara mostrará un error claro.
- El rendimiento depende de su equipo: se intenta WebGPU y, si no está disponible, se usa CPU/WASM (más lento).

---

## 3. Cómo se usa

1. **Analizar imagen:** selecciona un archivo. El resultado aparece en el visor; el botón **Descargar imagen anotada** solo se habilita cuando hay análisis.
2. **Analizar video:** selecciona un archivo local. Se reproduce en el navegador y se analiza a la frecuencia configurada. Si la inferencia es más lenta que la reproducción, se omiten cuadros y se muestra el FPS real de análisis.
3. **Usar cámara (paso 1, solo configurar):** pulsa **Usar cámara**. Se abre y enfoca el panel **Configurar cámara**, con el selector de cámara y de resolución. Este botón **no pide permiso ni enciende la cámara**; solo muestra las opciones y deja el foco en **Iniciar cámara**.
4. **Iniciar cámara (paso 2, permiso y captura):** pulsa **Iniciar cámara**. El estado cambia de inmediato a **«Solicitando permiso…»** y el navegador muestra su aviso de permiso. Si aceptas, se abre la cámara, se actualizan los nombres de las cámaras y se muestra la **resolución real** entregada. Si rechazas o falla, el error aparece **dentro del panel** (permiso denegado, cámara no encontrada, cámara ocupada, resolución no admitida o contexto inseguro), los botones se restauran y puedes reintentar.
5. **Detener cámara:** libera **todas** las pistas del flujo, cierra la sesión de análisis y descarga el TXT de la sesión. También puedes volver a descargar el último TXT con el botón de la sección 6.
6. **Ajustes:** el límite de FPS es un máximo, no una garantía. El umbral de confianza afecta a las detecciones; el de movimiento se expresa como fracción de la diagonal del cuadro.
7. **Casco y pose:** se pueden desactivar. Si se activan, sus modelos se descargan y preparan en ese momento.
8. **Grabación de video anotado:** durante el análisis de un video, pulsa **Grabar video anotado**. La grabación empieza solo con esa acción y se descarga solo al pulsar **Descargar video anotado**. Mantén la pestaña visible.

### «Usar cámara» no es «Iniciar cámara»

| Botón | Qué hace | Qué no hace |
|---|---|---|
| **Usar cámara** | Abre, resalta y enfoca el panel de configuración; desplaza la vista hasta él y explica el paso siguiente. | No pide permiso, no abre la cámara y no inicia ninguna captura. |
| **Buscar cámaras** | Pide permiso y vuelve a enumerar las cámaras para mostrar sus nombres. | No inicia el análisis ni deja la cámara encendida (detiene la pista de prueba). |
| **Iniciar cámara** | Solicita permiso, abre la cámara elegida y comienza el análisis con la resolución solicitada. | No se ejecuta solo: siempre requiere esta pulsación. |
| **Detener cámara** | Detiene todas las pistas, cierra la sesión de análisis y descarga el TXT. | No borra los resultados ya mostrados ni el último TXT descargado. |

El permiso se concede **por origen**: si autorizaste la cámara en `http://localhost:8123`, eso no autoriza automáticamente la URL de GitHub Pages, y viceversa. Si el navegador guardó un bloqueo, usa el icono de la cámara o del candado en la barra de direcciones para permitirlo y vuelve a pulsar **Iniciar cámara**.

---

## 4. Modelos publicados

Los tres modelos se exportaron a ONNX durante el desarrollo, desde copias temporales de los pesos originales. **Los pesos originales del proyecto de escritorio no se modificaron.** Configuración de exportación: Ultralytics 8.4.192, `imgsz=640`, `opset=17`, `simplify=True`, lote estático 1, CPU y sin NMS integrado. El decodificado y NMS se hacen en JavaScript.

| Archivo | Tarea y clases | Origen | Licencia declarada | Tamaño | SHA-256 |
|---|---|---|---|---|---|
| `models/yolo11n.onnx` | Detección COCO; se usan `0=person` y `3=motorcycle` de las 80 clases | Ultralytics YOLO11n (`yolo11n.pt`) | AGPL-3.0 (o licencia comercial de Ultralytics) | 10.741.397 B (10.74 MB) | `5647f842a1ce924ea076e586b4ee84932a40191124eff6998f0a8beba423d9e6` |
| `models/yolo11n-pose.onnx` | Pose de persona; 17 puntos COCO, `kpt_shape=[17,3]` | Ultralytics YOLO11n-pose (`yolo11n-pose.pt`) | AGPL-3.0 (o licencia comercial de Ultralytics) | 11.853.516 B (11.85 MB) | `b307cfe040c2b80b6783abed2eb08013bca04570f8be7c02ae606c9473a9bd59` |
| `models/helmet.onnx` | Detección de casco; `0=With Helmet`, `1=Without Helmet` | `iam-tsr/yolov8n-helmet-detection` en Hugging Face (YOLOv8n ajustado; dataset Roboflow enlazado en su model card) | MIT declarada en la model card | 12.266.518 B (12.27 MB) | `71090260920ca6a404c10284efe65dcfa99c4c0317d92a28073bb15ac12e6405` |

**Advertencia sobre el modelo de casco:** la model card declara licencia MIT, pero el dataset de origen es un proyecto de Roboflow y su licencia no se verificó en esta revisión. Antes de un uso institucional o de redistribución, revisa la licencia del dataset y del modelo. El modelo se incluye como componente opcional y desactivable.

**Runtime:** ONNX Runtime Web 1.31.1, MIT (Microsoft), autoalojado en `vendor/ort/`:

- `ort.min.js` — 371.810 B
- `ort-wasm-simd-threaded.jsep.mjs` — 47.250 B
- `ort-wasm-simd-threaded.jsep.wasm` — 29.520.971 B

El proyecto se distribuye bajo **AGPL-3.0** por los pesos de Ultralytics. El texto completo está en `LICENSE`; los avisos de terceros están en `NOTICE.md`.

---

## 5. Publicar en GitHub Pages

La publicación la decides tú. Esta carpeta no se ha subido a ningún repositorio y no se ha cambiado la visibilidad de nada.

1. Crea un repositorio vacío en GitHub (por ejemplo `moto-observador-web`). No marques “Add a README” si vas a subir esta carpeta tal cual.
2. Desde `Moto_Observador_Git`:

   ```powershell
   git init
   git add .
   git commit -m "Moto Observador web"
   git branch -M main
   git remote add origin https://github.com/TU_USUARIO/TU_REPOSITORIO.git
   git push -u origin main
   ```

3. En GitHub, entra en **Settings → Pages → Build and deployment → Source** y elige **GitHub Actions**.
4. El flujo `.github/workflows/deploy.yml` se ejecuta al hacer push a `main` o manualmente desde **Actions → Publicar sitio estático en GitHub Pages → Run workflow**.
5. Espera a que termine el job y abre la URL que muestra el entorno `github-pages`, normalmente:

   ```text
   https://TU_USUARIO.github.io/TU_REPOSITORIO/
   ```

6. No actives a la vez “Deploy from a branch” y “GitHub Actions”. Usa solo GitHub Actions.
7. Si el repositorio es privado, GitHub Pages puede requerir un plan compatible. No cambies la visibilidad del repositorio sin decidirlo tú.

**Si no quieres usar la terminal:** instala **GitHub Desktop**, elige *Add local repository* sobre esta carpeta, crea el repositorio, publica en GitHub y luego activa Pages como arriba. Evita subir los archivos con la interfaz web de GitHub: el archivo `vendor/ort/ort-wasm-simd-threaded.jsep.wasm` pesa 29,5 MB y la carga web de GitHub tiene un límite de 25 MB por archivo. Con Git o GitHub Desktop no hay ese problema (el límite del repositorio es 100 MB por archivo).

**Alternativa sin Git ni GitHub:** arrastra la carpeta completa a **Netlify Drop** (`app.netlify.com/drop`). Te da una URL HTTPS al instante y también funciona la cámara. No es GitHub Pages, pero es igualmente estático y no requiere instalar nada.

**Importante:** los archivos de `models/` y `vendor/ort/` deben estar incluidos en el repositorio. Sin ellos la página carga, pero el análisis falla con un error de descarga. Cada archivo está por debajo del límite de 100 MB de GitHub Pages; el sitio completo ronda los 65 MB, dentro del límite de 1 GB.

### Abrir la aplicación publicada y usar la cámara

1. Abre la URL **HTTPS** que muestra GitHub Pages, por ejemplo `https://TU_USUARIO.github.io/TU_REPOSITORIO/`. No uses una copia descargada ni `file://`.
2. Pulsa **Usar cámara**: se abre el panel de configuración y el foco pasa a **Iniciar cámara**.
3. Elige cámara y resolución, y pulsa **Iniciar cámara**. El navegador pedirá permiso para ese origen HTTPS.
4. Acepta el permiso. La aplicación muestra la resolución real y comienza el análisis local.
5. Para cerrar, pulsa **Detener cámara**: se liberan las pistas y se descarga el TXT de la sesión.

La primera vez que se abre la URL publicada, el permiso de cámara está en estado «preguntar». Si se denegó antes, el navegador no volverá a preguntar hasta que lo cambies en el icono de la barra de direcciones. El permiso de `localhost` no se hereda a la URL de GitHub Pages.

### Visibilidad del repositorio y de la página

- **Repositorio público:** cualquiera puede ver el código en `github.com/TU_USUARIO/TU_REPOSITORIO` y abrir la página publicada. Es lo recomendado para que el profesor u otra persona entre sin cuenta ni instalación.
- **Repositorio privado:** solo tú y los colaboradores veis el código. GitHub Pages para repositorios privados requiere un plan de pago; además, la página publicada sigue siendo accesible por su URL, salvo configuraciones empresariales de control de acceso. Un repositorio privado **no** convierte la web en privada.
- **Qué se hace público:** código, README, modelos y licencias. **No** hay datos personales, imágenes, videos, registros de sesión, credenciales ni claves de API en el repositorio; la aplicación procesa todo en el navegador.
- **Acceso restringido real:** GitHub Pages en plan gratuito no ofrece inicio de sesión por usuario. Si necesitas limitar el acceso, usa otro hosting con autenticación (por ejemplo Netlify con contraseña, o Cloudflare Access), asumiendo más fricción para quien abra el enlace.

---

## 6. Estructura

```text
Moto_Observador_Git/
├─ index.html
├─ styles.css
├─ favicon.svg
├─ .nojekyll
├─ .gitignore
├─ LICENSE
├─ NOTICE.md
├─ README.md
├─ .github/workflows/deploy.yml
├─ models/
│  ├─ yolo11n.onnx
│  ├─ yolo11n-pose.onnx
│  └─ helmet.onnx
├─ src/
│  ├─ main.js          # interfaz, fuentes, cámara, descargas
│  ├─ detector.js      # ONNX Runtime Web, preprocesado, decodificado, NMS
│  ├─ scene.js         # seguimiento, asociación, casco, pose, conteos
│  ├─ draw.js          # cajas, etiquetas, estelas y esqueleto
│  ├─ session-log.js   # registro TXT de cámara
│  └─ utils.js         # geometría, NMS, fechas, descargas
└─ vendor/ort/
   ├─ ort.min.js
   ├─ ort-wasm-simd-threaded.jsep.mjs
   └─ ort-wasm-simd-threaded.jsep.wasm
```

---

## 7. Validación realizada

- **Exportación:** los tres ONNX se abrieron con `onnxruntime` 1.32.0 (CPU) y se comprobó la entrada `[1,3,640,640]` y las salidas `[1,84,8400]`, `[1,56,8400]` y `[1,6,8400]`, además de los metadatos `names`, `imgsz` y `kpt_shape`.
- **Muestras de imagen:** con `resultado_casco.jpg` el flujo web encontró 3 personas y 2 motos; con `resultado_casco1.jpg`, 2 personas y 1 moto. La pose encontró 3 y 2 personas respectivamente. El modelo de casco encontró 1 caja por muestra. Los conteos coinciden con la validación de referencia en CPU para esas muestras.
- **Video:** se generó un WebM local de prueba con `MediaRecorder`, se analizó, se comprobó el seguimiento `T#`, el estado de movimiento, el fin de video y la grabación del canvas anotado.
- **Cámara:** se probó el flujo completo con `MediaStream` sintéticos de 640×480 y 1280×720 (no una cámara física): inicio, resolución real mostrada, análisis, detención, descarga automática del TXT y nueva descarga manual. También se probaron los errores de permiso denegado, cámara no encontrada, cámara ocupada, restricciones no admitidas y contexto inseguro, además del reintento sin restricciones.
- **Flujo de la interfaz de cámara:** se comprobó que **Usar cámara** solo abre y enfoca el panel (sin llamar a `getUserMedia`), que **Iniciar cámara** muestra de inmediato «Solicitando permiso…», que los errores aparecen dentro del panel, que los botones se restauran al fallar y que **Detener cámara** deja las pistas en estado `ended`, vacía `srcObject` y descarga el TXT. Se verificó también que al cargar una imagen o un video el panel se cierra y `aria-expanded` vuelve a `false`.
- **Runtime:** se probó WebGPU y el respaldo forzado con `?runtime=wasm`. Con WASM la muestra de imagen produjo los mismos conteos (3 personas, 2 motos, 1 con casco) y la etiqueta visible fue `WASM (CPU)`.
- **Descargas:** se comprobaron PNG de imagen anotada, PNG de fotograma, WebM anotado y TXT de sesión.
- **No probado:** cámara física, PTZ, Firefox, Safari, Edge, móviles, otros equipos, grabación larga, videos grandes y condiciones de poca luz reales.

---

## 8. Limitaciones y advertencias

- **Los FPS son un máximo configurable, no una promesa.** El tiempo real depende de la GPU/CPU, del tamaño del modelo, de la resolución de la fuente y de si casco y pose están activos.
- **Los cuadros anotados pueden ir por detrás del video** cuando la inferencia es más lenta que la reproducción. El visor sigue mostrando el video, pero las cajas corresponden al último cuadro analizado.
- **Los IDs `T#` no identifican personas.** Cambian con oclusiones, cortes de escena, entradas/salidas y fallos de detección. Los conteos son del cuadro o intervalo actual, no personas únicas del video.
- **La asociación de ocupantes es geométrica y aproximada.** Puede producir `incierto` o `no se puede determinar`; no determina quién conduce.
- **El casco no se infiere por ausencia.** Si el modelo no detecta casco, el estado es incierto, no “sin casco”. La iluminación, el ángulo, la distancia y la calidad del modelo afectan al resultado.
- **La pose es una estimación.** Puede ser parcial o no determinada; no reconoce acciones complejas ni intenciones.
- **WebGPU varía por equipo.** Si falla, se usa WASM. GitHub Pages no permite los encabezados COOP/COEP, por lo que el runtime WASM se configura con **una sola hebra**; esto puede ser más lento que un servidor con hilos.
- **La primera carga es pesada** (unos 65 MB). La primera compilación de un modelo en WebGPU puede tardar varios segundos; en algunos equipos la primera inferencia de pose puede tardar decenas de segundos. Después suele estabilizarse.
- **La cámara requiere HTTPS o localhost** y permiso explícito. La resolución solicitada es una preferencia; el navegador puede entregar otra. La captura de la cámara y el FPS de análisis son métricas distintas.
- **«Usar cámara» solo configura; no enciende la cámara.** El permiso y la captura comienzan únicamente al pulsar **Iniciar cámara**, y el permiso se concede por origen (localhost y GitHub Pages son orígenes distintos).
- **La grabación del canvas no es el video original anotado cuadro por cuadro.** Es una captura en tiempo real, sin audio, dependiente de `MediaRecorder`; puede perder cuadros y no está disponible en todos los navegadores.
- **El TXT es un registro neutral de sesión, no una prueba pericial.** No contiene imágenes, coordenadas del esqueleto, rostros, placas ni identidades. Si cierras la pestaña antes de detener la cámara, el TXT puede no descargarse.
- **Las imágenes grandes se reducen** a un lado máximo de 1600 px para visualización y análisis; el modelo siempre usa 640×640 con letterbox.
- **No hay persistencia.** Al recargar se pierden resultados, grabaciones y estado de la sesión.
- **No es un sistema de fiscalización automática.** Las señales requieren revisión humana y no demuestran infracciones.

---

## 9. Solución de problemas

| Síntoma | Causa probable | Solución |
|---|---|---|
| Página en blanco o módulos no cargan | Se abrió `index.html` con `file://` | Sirve el sitio por HTTP o usa GitHub Pages. |
| **Abro `index.html` y no aparece nada de la configuración de cámara** | Se abrió con doble clic (`file://`): el navegador bloquea los módulos ES y la cámara | Sirve la carpeta con `python -m http.server 8123` y abre `http://localhost:8123/`, o publica en GitHub Pages. La propia página muestra un aviso rojo cuando detecta `file://`. |
| La página no muestra el panel de cámara al pulsar «Usar cámara» | Copia antigua en caché o módulos bloqueados | Recarga con **Ctrl+F5**, comprueba que no haya un aviso rojo de `file://` y revisa la consola. |
| “No se pudo descargar un recurso del sitio” | Faltan `models/` o `vendor/ort/`, o hay un 404 | Verifica que los archivos estén en el repositorio y que las rutas respeten mayúsculas/minúsculas. |
| “WebGPU no está disponible” | Navegador o equipo sin WebGPU | Es normal; se usa WASM. Puedes forzar `?runtime=wasm`. |
| WebGPU falla durante la inferencia | Driver/GPU inestable | La app reintenta con WASM. Si persiste, abre `?runtime=wasm`. |
| La primera carga tarda mucho | Descarga de runtime y modelos (unos 65 MB) y compilación inicial | Espera; revisa la red; las siguientes cargas usan caché. |
| **«Usar cámara» parece no hacer nada** | Ese botón solo abre el panel de configuración; no enciende la cámara | Tras pulsarlo, revisa el panel **Configurar cámara** y pulsa **Iniciar cámara**. El foco debería estar ya en ese botón. |
| **«Iniciar cámara» no muestra el aviso de permiso** | Permiso bloqueado antes para ese origen, o el navegador recuerda la denegación | Usa el icono de cámara/candado de la barra de direcciones, permite el acceso y vuelve a pulsar **Iniciar cámara**. |
| La cámara no aparece en la lista | Permiso no concedido o etiquetas ocultas | Pulsa **Buscar cámaras**, concede permiso y vuelve a intentarlo. |
| «No se encontró ninguna cámara disponible» | No hay cámara conectada o el sistema no la expone | Conecta una cámara, revisa la privacidad del sistema y pulsa **Buscar cámaras**. |
| «Permiso de cámara denegado» | Bloqueo del navegador | Permite la cámara desde el icono de la barra de direcciones y reintenta. |
| «La cámara está en uso por otra aplicación» | Otra aplicación la está usando | Ciérrala en la otra aplicación y reintenta. |
| «La cámara o la resolución solicitada no está disponible» | La cámara no admite esa combinación | Elige otra resolución o **Cámara predeterminada**; la app reintenta sin ese límite. |
| «La cámara requiere HTTPS o localhost» | Contexto no seguro | Usa GitHub Pages (HTTPS) o `http://localhost`; no uses la IP de la red por HTTP. |
| El video no se reproduce | Códec no soportado por el navegador | Prueba MP4/H.264 o WebM. |
| No se puede grabar el canvas | `MediaRecorder` o `captureStream` no disponibles | Usa **Descargar fotograma anotado**. |
| El TXT no se descarga | Descargas bloqueadas o pestaña cerrada antes de detener | Permite descargas y pulsa **Detener cámara** antes de cerrar. |
| El navegador se queda sin memoria | Video muy largo o resolución muy alta | Usa un video más corto, baja la resolución de la cámara o recarga. |
| Las cajas van retrasadas | Inferencia más lenta que el video | Baja el FPS de análisis, desactiva pose/casco o usa un equipo más rápido. |

---

## 10. Lista de estado

### Hecho

- [x] Proyecto estático separado en `Moto_Observador_Git`.
- [x] ONNX Runtime Web autoalojado, WebGPU con respaldo WASM.
- [x] Modelos ONNX de personas/motos, pose y casco, con metadatos y tamaños documentados.
- [x] Preprocesado letterbox, decodificado YOLO y NMS en JavaScript.
- [x] Imagen, video y cámara local; selección de cámara y resolución; resolución real visible.
- [x] Límite de FPS, confianza, movimiento y detectores opcionales.
- [x] Seguimiento, trayectorias, movimiento y asociación de ocupantes con estados inciertos.
- [x] Casco sin inferencia por ausencia; pose con estados parciales/no determinados.
- [x] Visor con cajas, etiquetas, estelas y esqueleto.
- [x] Descargas por acción del usuario: PNG de imagen, PNG de fotograma, grabación de canvas y TXT de cámara.
- [x] Registro TXT neutral, sin cuadros, video, rostros, placas, identidades ni coordenadas del esqueleto.
- [x] Interfaz en español, responsive, con estados de runtime/modelos/resolución/FPS y errores.
- [x] Flujo de cámara en dos pasos: **Usar cámara** abre y enfoca el panel; **Iniciar cámara** pide permiso y captura; **Detener cámara** libera las pistas y cierra la sesión. Errores claros dentro del panel.
- [x] README, `.gitignore`, `LICENSE` AGPL-3.0, `NOTICE.md`, favicon, `.nojekyll` y workflow de GitHub Pages.
- [x] Pruebas en Chromium de escritorio con WebGPU y WASM forzado; imagen, video, cámara sintética y descargas.

### Pendiente

- [ ] Validar con cámara física y, si aplica, PTZ.
- [ ] Probar en Firefox, Safari, Edge y móviles.
- [ ] Revisar la licencia del dataset del modelo de casco antes de uso institucional.
- [ ] Medir rendimiento en varios equipos y documentar FPS reales.
- [ ] Decidir si se habilita en el futuro un detector de armas, solo con licencia, origen y comportamiento verificados.
- [ ] Añadir pruebas automatizadas de navegador si se incorpora Node/Playwright al proyecto.

---

## 11. Créditos y licencias

- **Ultralytics YOLO11n / YOLO11n-pose:** pesos AGPL-3.0. Si necesitas otra licencia, Ultralytics ofrece licencias comerciales.
- **iam-tsr/yolov8n-helmet-detection:** modelo con licencia MIT declarada; dataset de origen Roboflow, licencia no verificada en esta revisión.
- **ONNX Runtime Web 1.31.1:** MIT, Microsoft.
- **Este proyecto:** AGPL-3.0. Consulta `LICENSE` y `NOTICE.md`.

Moto Observador es una herramienta de observación para revisión humana. No identifica personas, no lee placas, no transmite video y no determina infracciones.
