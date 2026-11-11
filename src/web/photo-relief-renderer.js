import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { buildPhotoReliefData, createInkPixels } from "./photo-relief-data.js";
import { createSketchFrameLoop, createSketchTour } from "./destination-sketch-motion.js";

export async function readReliefPixels(src, signal) {
  // Private journal blobs or locally prepared JPEGs only. No third-party image
  // requests, CORS proxy, credentials, or remote inference hidden in the viewer.
  if (!/^(blob:|data:image\/jpeg;base64,)/.test(src)) throw new Error("relief_source_not_local");
  const image = new Image();
  await new Promise((resolve, reject) => {
    const cleanup = () => { image.onload = null; image.onerror = null; signal?.removeEventListener("abort", abort); };
    const abort = () => { cleanup(); image.src = ""; reject(new DOMException("Aborted", "AbortError")); };
    image.onload = () => { cleanup(); resolve(); };
    image.onerror = () => { cleanup(); reject(new Error("relief_photo_decode_failed")); };
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener("abort", abort, { once: true }); image.src = src;
  });
  try {
    const scale = Math.min(1, 960 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(2, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(2, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("relief_photo_decode_failed");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    canvas.width = canvas.height = 0;
    return pixels;
  } finally { image.src = ""; }
}

export function buildPhotoReliefGeometry(pixels, subject, recipe) {
  const data = buildPhotoReliefData(pixels, subject, recipe);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(data.positions, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(data.uv, 2));
  geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
  geometry.computeVertexNormals(); geometry.computeBoundingBox();
  return { geometry, width: data.modelWidth, height: data.modelHeight };
}

export function createPhotoReliefRenderer({ container, pixels, subject, recipe, reducedMotion, onError, onTourChange }) {
  const built = buildPhotoReliefGeometry(pixels, subject, recipe);
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "low-power" }); }
  catch (error) { built.geometry.dispose(); throw error; }
  const makeTexture = (data) => {
    const texture = new THREE.DataTexture(data, pixels.width, pixels.height, THREE.RGBAFormat);
    texture.colorSpace = THREE.SRGBColorSpace; texture.flipY = true;
    texture.minFilter = texture.magFilter = THREE.LinearFilter; texture.needsUpdate = true;
    return texture;
  };
  const textures = { photo: makeTexture(new Uint8Array(pixels.data)), ink: makeTexture(createInkPixels(pixels)) };
  const material = new THREE.MeshBasicMaterial({ map: textures[recipe.style], side: THREE.FrontSide });
  const mesh = new THREE.Mesh(built.geometry, material), scene = new THREE.Scene(); scene.add(mesh);
  const camera = new THREE.OrthographicCamera(-3, 3, 2, -2, 0.1, 30);
  camera.position.set(0, 0, 6);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.setClearColor(0xf6f3ea); renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.domElement.setAttribute("aria-hidden", "true"); container.appendChild(renderer.domElement);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enablePan = false; controls.enableDamping = false; controls.rotateSpeed = 0.4;
  controls.minAzimuthAngle = -0.38; controls.maxAzimuthAngle = 0.38;
  controls.minPolarAngle = Math.PI / 2 - 0.19; controls.maxPolarAngle = Math.PI / 2 + 0.19;
  controls.minZoom = 0.85; controls.maxZoom = 1.65;
  let disposed = false;
  const initial = { position: [0, 0, 6], target: [0, 0, 0], zoom: 1 };
  const readCamera = () => ({ position: camera.position.toArray(), target: controls.target.toArray(), zoom: camera.zoom });
  const writeCamera = (value) => { camera.position.fromArray(value.position); controls.target.fromArray(value.target); camera.zoom = value.zoom; camera.updateProjectionMatrix(); controls.update(); };
  const tour = createSketchTour({ readCamera, writeCamera, reducedMotion, duration: 8000, onState: onTourChange });
  const loop = createSketchFrameLoop({ requestFrame: requestAnimationFrame, cancelFrame: cancelAnimationFrame, step: (time) => tour.step(time), render: () => {
    if (disposed) return;
    try { renderer.render(scene, camera); }
    catch { tour.stop(); loop.pause(); onError?.(); }
  } });
  const change = () => loop.invalidate(), interrupt = () => { tour.stop(); loop.invalidate(); };
  controls.addEventListener("change", change); controls.addEventListener("start", interrupt);
  const resize = () => {
    if (disposed) return;
    const width = Math.max(1, container.clientWidth), height = Math.max(1, container.clientHeight), aspect = width / height;
    const viewHeight = Math.max(built.height * 1.1, built.width * 1.1 / aspect);
    camera.left = -viewHeight * aspect / 2; camera.right = -camera.left; camera.top = viewHeight / 2; camera.bottom = -camera.top;
    camera.updateProjectionMatrix(); renderer.setSize(width, height); loop.invalidate();
  };
  const observer = new ResizeObserver(resize); observer.observe(container); resize();
  const visibility = () => { if (document.hidden) { tour.stop(); loop.pause(); } else loop.resume(); };
  const lost = (event) => { event.preventDefault(); tour.stop(); loop.pause(); onError?.(); };
  document.addEventListener("visibilitychange", visibility); renderer.domElement.addEventListener("webglcontextlost", lost);
  if (document.hidden) loop.pause();
  return {
    setRecipe(next) {
      interrupt(); const updated = buildPhotoReliefGeometry(pixels, subject, next);
      const previous = mesh.geometry; mesh.geometry = updated.geometry; previous.dispose();
      material.map = textures[next.style]; material.needsUpdate = true; loop.invalidate();
    },
    orbit(delta, vertical = 0) {
      interrupt(); const spherical = new THREE.Spherical().setFromVector3(camera.position);
      spherical.theta = THREE.MathUtils.clamp(spherical.theta + delta, controls.minAzimuthAngle, controls.maxAzimuthAngle);
      spherical.phi = THREE.MathUtils.clamp(spherical.phi + vertical, controls.minPolarAngle, controls.maxPolarAngle);
      camera.position.setFromSpherical(spherical); controls.update(); loop.invalidate();
    },
    zoom(factor) { interrupt(); camera.zoom = THREE.MathUtils.clamp(camera.zoom * factor, controls.minZoom, controls.maxZoom); camera.updateProjectionMatrix(); loop.invalidate(); },
    reset() { interrupt(); writeCamera(initial); loop.invalidate(); },
    tour() {
      if (tour.playing) { interrupt(); return; }
      tour.start([{ position: [-1.7, 0.3, 5.8], target: [0, 0, 0], zoom: 1.06 }, { position: [1.7, 0, 5.8], target: [0, 0, 0], zoom: 1.1 }, initial], performance.now()); loop.invalidate();
    },
    stop: interrupt,
    dispose() {
      if (disposed) return; disposed = true;
      tour.dispose(); loop.dispose(); observer.disconnect(); controls.dispose();
      controls.removeEventListener("change", change); controls.removeEventListener("start", interrupt);
      document.removeEventListener("visibilitychange", visibility); renderer.domElement.removeEventListener("webglcontextlost", lost);
      mesh.geometry.dispose(); material.dispose(); Object.values(textures).forEach((texture) => texture.dispose());
      renderer.dispose(); renderer.domElement.remove();
    },
  };
}
