import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { createSketchFrameLoop, createSketchTour } from "./destination-sketch-motion.js";

const PALETTE = { paper: 0xf9f6ed, sand: 0xe6dcc4, chalk: 0xf4eedb, stone: 0xc3c2ac, green: 0xa5b39b, leaf: 0x839b83, darkLeaf: 0x647e6b, water: 0x79bcc0, waterLight: 0xa5d6cf, roof: 0x677e77, wall: 0xefead9, wood: 0x8b7660, coral: 0xd9684c, ink: 0x424d47, hatch: 0x7c8070, cyan: 0x3e9da7, white: 0xf8f4df };
const DEFAULT_CAMERA = { position: [10, 10, 13], target: [0, 0.55, 0], zoom: 1 };
const vector = (point) => new THREE.Vector3(...point);

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => { state += 0x6d2b79f5; let n = Math.imul(state ^ state >>> 15, 1 | state); n ^= n + Math.imul(n ^ n >>> 7, 61 | n); return ((n ^ n >>> 14) >>> 0) / 4294967296; };
}

/** Original small geometries, merged by material. Sketch strokes are fixed in world space. */
export function buildDestinationSketchModel(sketch) {
  const root = new THREE.Group();
  root.name = `destination-sketch:${sketch.theme.id}`;
  const random = seededRandom(sketch.seed);
  const solids = new Map();
  const strokes = new Map();
  const transform = new THREE.Object3D();
  const resources = new Set();
  const gradient = new THREE.DataTexture(new Uint8Array([120, 185, 245]), 3, 1, THREE.RedFormat);
  gradient.minFilter = gradient.magFilter = THREE.NearestFilter;
  gradient.needsUpdate = true;
  resources.add(gradient);

  function line(points, color = "ink") {
    const positions = strokes.get(color) ?? [];
    for (let i = 1; i < points.length; i += 1) positions.push(...points[i - 1], ...points[i]);
    strokes.set(color, positions);
  }
  function solid(geometry, color, position = [0, 0, 0], rotation = [0, 0, 0], scale = [1, 1, 1], outlined = false) {
    transform.position.fromArray(position); transform.rotation.set(...rotation); transform.scale.fromArray(scale); transform.updateMatrix();
    geometry.applyMatrix4(transform.matrix);
    if (outlined) {
      const edges = new THREE.EdgesGeometry(geometry, 38);
      const a = edges.getAttribute("position").array;
      const positions = strokes.get("ink") ?? [];
      for (const n of a) positions.push(n);
      strokes.set("ink", positions); edges.dispose();
    }
    const flat = geometry.index ? geometry.toNonIndexed() : geometry;
    if (flat !== geometry) geometry.dispose();
    for (const attribute of Object.keys(flat.attributes)) if (attribute !== "position" && attribute !== "normal") flat.deleteAttribute(attribute);
    if (!flat.getAttribute("normal")) flat.computeVertexNormals();
    const batch = solids.get(color) ?? []; batch.push(flat); solids.set(color, batch);
  }
  const box = (x, y, z, w, h, d, color, outline = true) => solid(new THREE.BoxGeometry(w, h, d), color, [x, y, z], [0, 0, 0], [1, 1, 1], outline);
  const cylinder = (x, y, z, top, bottom, h, color, sides = 12) => solid(new THREE.CylinderGeometry(top, bottom, h, sides), color, [x, y, z]);

  function islandPoints(rx, rz, count = 72, phase = 0) {
    return Array.from({ length: count + 1 }, (_, i) => {
      const angle = i / count * Math.PI * 2;
      const bend = 1 + 0.045 * Math.sin(angle * 5 + phase) + 0.022 * Math.cos(angle * 9 - phase);
      return [Math.cos(angle) * rx * bend, Math.sin(angle) * rz * bend];
    });
  }
  function land(points, y, depth, color) {
    const shape = new THREE.Shape(points.map(([x, z]) => new THREE.Vector2(x, -z)));
    const geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 1 });
    solid(geometry, color, [0, y, 0], [-Math.PI / 2, 0, 0]);
    line(points.map(([x, z]) => [x, y + depth + 0.009, z]));
  }
  const outline = islandPoints(5.65, 4.1, 84, random());
  land(outline, -0.48, 0.52, "sand");
  line(outline.map(([x, z]) => [x * 1.005, -0.36, z * 1.005]), "hatch");
  line(outline.map(([x, z], i) => [x * 0.991, 0.065 + Math.sin(i) * 0.012, z * 0.991]), "hatch");
  for (let i = 0; i < outline.length - 1; i += 2) {
    const [x, z] = outline[i];
    line([[x, 0.02, z], [x * 1.003 + 0.012, -0.31 - random() * 0.12, z * 1.003]], "hatch");
  }

  function hill(x, z, radius, height, color = "green") {
    const phase = random() * 6.28;
    const rings = 12, sides = 28, positions = [], indices = [];
    const point = (t, a) => {
      const taper = Math.pow(1 - t, 0.7);
      const ripple = 1 + 0.12 * Math.sin(a * 3 + t * 2 + phase) + 0.06 * Math.sin(a * 7 - t);
      return [x + Math.cos(a) * radius * taper * ripple + t * t * radius * 0.16, 0.065 + height * Math.sin(t * Math.PI / 2), z + Math.sin(a) * radius * 0.68 * taper * ripple];
    };
    for (let row = 0; row <= rings; row++) for (let col = 0; col <= sides; col++) positions.push(...point(row / rings, col / sides * Math.PI * 2));
    for (let row = 0; row < rings; row++) for (let col = 0; col < sides; col++) {
      const a = row * (sides + 1) + col, b = a + sides + 1;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3)); geometry.setIndex(indices); geometry.computeVertexNormals();
    solid(geometry, color);
    for (let ridge = 0; ridge < 9; ridge++) {
      const angle = ridge / 9 * Math.PI * 2;
      line(Array.from({ length: 24 }, (_, i) => { const p = point(i / 25, angle + Math.sin(i * 0.6 + ridge) * 0.016); return [p[0], p[1] + 0.018, p[2]]; }), ridge % 3 ? "hatch" : "ink");
    }
    for (let band = 1; band < 4; band++) line(Array.from({ length: 37 }, (_, i) => { const p = point(band / 5, i / 36 * Math.PI * 2); return [p[0], p[1] + 0.02, p[2]]; }), "hatch");
  }

  function tree(x, z, size = 1, willow = false) {
    const ground = 0.07, height = 1.35 * size;
    cylinder(x, ground + height * 0.42, z, size * 0.032, size * 0.06, height * 0.84, "wood", 6);
    line([[x - 0.025, ground, z + 0.035], [x - 0.015, height * 0.58, z], [x + size * 0.13, height * 0.9, z]], "ink");
    for (let lobe = 0; lobe < 4; lobe++) {
      const angle = lobe * 2.1, cx = x + Math.cos(angle) * size * 0.22, cz = z + Math.sin(angle) * size * 0.19;
      const cy = ground + height * (0.71 + lobe % 2 * 0.12);
      const scale = [size * 0.4, size * (willow ? 0.43 : 0.31), size * 0.34];
      solid(new THREE.SphereGeometry(1, 10, 7), lobe % 2 ? "green" : "leaf", [cx, cy, cz], [0, 0, 0], scale);
      const ring = Array.from({ length: 25 }, (_, i) => { const a = i / 24 * Math.PI * 2; return [cx + Math.cos(a) * scale[0], cy + Math.sin(a) * scale[1], cz + Math.sin(a * 3) * 0.022]; });
      line(ring, "hatch");
      if (willow) for (let strand = 0; strand < 5; strand++) {
        const a = strand * 1.26;
        line(Array.from({ length: 10 }, (_, i) => [cx + Math.cos(a) * size * (0.18 + i * 0.025), cy + size * 0.12 - i * size * 0.085, cz + Math.sin(a) * size * (0.2 + i * 0.019)]), "darkLeaf");
      }
    }
  }

  function roof(x, y, z, w, d, height = 0.45, color = "roof") {
    // Curved eaves, ridge and sparse tile strokes; no all-triangle wireframe.
    const profile = [[-d / 2, 0.11], [-d * 0.35, 0.06], [0, height], [d * 0.35, 0.06], [d / 2, 0.11], [d / 2, 0.02], [0, height - 0.1], [-d / 2, 0.02]];
    const shape = new THREE.Shape(profile.map(([a, b]) => new THREE.Vector2(a, b)));
    const geo = new THREE.ExtrudeGeometry(shape, { depth: w, bevelEnabled: false });
    solid(geo, color, [x - w / 2, y, z], [0, Math.PI / 2, 0]);
    for (const edge of [-d / 2, d / 2, 0]) line([[x - w / 2, y + (edge ? 0.12 : height + 0.012), z + edge], [x + w / 2, y + (edge ? 0.12 : height + 0.012), z + edge]]);
    for (let at = -w / 2; at <= w / 2 + 0.001; at += 0.17) {
      line([[x + at, y + 0.12, z - d / 2], [x + at, y + height + 0.012, z], [x + at, y + 0.12, z + d / 2]], "hatch");
    }
  }

  function house(x, z, w = 1.25, h = 0.95, d = 1.08, accent = false) {
    box(x, 0.07 + h / 2, z, w, h, d, "wall");
    roof(x, h + 0.07, z, w + 0.24, d + 0.32, h * 0.4);
    // Recessed door, framed windows and a low step make the scale legible.
    box(x, 0.38, z + d / 2 + 0.006, 0.26, 0.58, 0.025, "wood");
    for (const side of [-1, 1]) {
      box(x + side * w * 0.3, h * 0.57, z + d / 2 + 0.021, w * 0.16, 0.25, 0.025, "roof");
      line([[x + side * w * 0.3, h * 0.44, z + d / 2 + 0.04], [x + side * w * 0.3, h * 0.7, z + d / 2 + 0.04]], "white");
    }
    box(x, 0.095, z + d / 2 + 0.12, 0.6, 0.12, 0.25, "stone", false);
    if (accent) {
      cylinder(x + w * 0.56, h * 0.78, z + d / 2 + 0.05, 0.08, 0.08, 0.2, "coral", 10);
      line([[x + w * 0.56, h, z + d / 2 + 0.05], [x + w * 0.56, h * 0.57, z + d / 2 + 0.05]]);
    }
  }

  function path(points, width = 0.65) {
    const curve = new THREE.CatmullRomCurve3(points.map(([x, z]) => new THREE.Vector3(x, 0.085, z)));
    const samples = curve.getPoints(52), positions = [], indices = [];
    const edges = [[], []];
    samples.forEach((p, i) => {
      const tangent = curve.getTangent(i / (samples.length - 1));
      const normal = new THREE.Vector3(-tangent.z, 0, tangent.x).multiplyScalar(width / 2);
      const a = p.clone().add(normal), b = p.clone().sub(normal);
      positions.push(...a.toArray(), ...b.toArray()); edges[0].push(a.toArray()); edges[1].push(b.toArray());
      if (i < samples.length - 1) indices.push(i * 2, i * 2 + 2, i * 2 + 1, i * 2 + 1, i * 2 + 2, i * 2 + 3);
      if (i % 3 === 0) line([[a.x, a.y + 0.01, a.z], [b.x, b.y + 0.01, b.z]], "hatch");
    });
    const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3)); geo.setIndex(indices); geo.computeVertexNormals();
    solid(geo, "chalk"); edges.forEach((edge) => line(edge, "hatch"));
  }

  function rock(x, z, size) {
    solid(new THREE.DodecahedronGeometry(size, 0), "stone", [x, size * 0.22 + 0.05, z], [random(), random(), 0], [1, 0.55, 0.75], true);
  }
  const theme = sketch.theme.id;
  let anchors;
  if (theme === "lakeshore") {
    const lake = islandPoints(3.95, 2.62, 72, 0.8).map(([x, z]) => [x - 0.25, z + 0.45]);
    land(lake, 0.054, 0.035, "water");
    line(lake.map(([x, z]) => [x * 1.023, 0.093, (z - 0.45) * 1.03 + 0.45]), "white");
    hill(-2.85, -2.45, 2.02, 2.35, "green"); hill(0.1, -2.8, 1.72, 2.85, "stone"); hill(2.65, -2.15, 1.7, 1.9, "green");
    tree(-4.3, 0.1, 0.95, true); tree(4.05, 1.3, 0.9, true); tree(3.85, -1.25, 0.7); tree(-3.9, -1.65, 0.72);
    path([[-4.15, -0.75], [-4.4, 0.55], [-3.4, 2.85], [-1.4, 3.5], [1.7, 3.4]], 0.48);
    // Small nameless pavilion: an illustrative theme prop, never a POI hotspot.
    cylinder(3.55, 0.14, 2.35, 0.62, 0.72, 0.15, "chalk", 8);
    for (const dx of [-0.34, 0.34]) for (const dz of [-0.32, 0.32]) cylinder(3.55 + dx, 0.56, 2.35 + dz, 0.035, 0.035, 0.8, "wood", 6);
    roof(3.55, 0.98, 2.35, 1.14, 1.14, 0.48);
    for (let i = 0; i < 34; i++) {
      const x = (random() - 0.5) * 6.8, z = (random() - 0.5) * 4.1 + 0.45;
      if ((x / 3.7) ** 2 + ((z - 0.45) / 2.35) ** 2 > 0.88) continue;
      line(Array.from({ length: 9 }, (_, j) => [x + j * 0.055, 0.096, z + Math.sin(j * 0.7) * 0.026]), i % 3 ? "waterLight" : "white");
    }
    for (let i = 0; i < 6; i++) rock(-4.4 + i * 1.42, 3.25 - Math.abs(i - 3) * 0.22, 0.17 + random() * 0.13);
    anchors = [[-3.9, 0.5, 1.5], [0.2, 1.7, -1.55], [3.4, 0.65, 2.25]];
  } else if (theme === "mountain") {
    hill(-2.3, -1.1, 2.55, 3.15, "green"); hill(0.6, -1.8, 2.1, 3.8, "stone"); hill(3.0, -0.7, 1.7, 2.2, "green");
    path([[-4.5, 1.9], [-2.5, 1.4], [-0.7, 2.15], [1.6, 1.6], [3.55, 1.95]], 0.48);
    for (let i = 0; i < 8; i++) tree(-4.0 + i * 1.05, 2.8 + Math.sin(i) * 0.3, 0.55 + random() * 0.35);
    rock(-0.3, 2.95, 0.48); rock(3.7, 0.7, 0.35);
    anchors = [[-2.4, 1.0, 1.5], [0.55, 3.9, -1.8], [3.4, 0.7, 2.1]];
  } else if (theme === "heritage") {
    path([[-4.8, 0.7], [-2.4, 0.2], [-0.35, 1.1], [1.9, 0.5], [4.65, 1.5]], 1.0);
    house(-3.5, -0.72, 1.3, 1.1, 1.3, true); house(-1.85, -1.2, 1.4, 1.5, 1.1);
    house(0.1, -0.83, 1.6, 1.2, 1.25, true); house(2.1, -1.25, 1.65, 1.75, 1.38, true);
    house(-2.75, 2.2, 1.2, 0.9, 1.0); house(0.9, 2.5, 1.7, 1.0, 1.0, true);
    tree(4.3, -0.85, 1.05); tree(-4.45, -1.55, 0.75); tree(3.75, 2.3, 0.8);
    box(0.05, 0.24, 2.8, 0.85, 0.09, 0.26, "wood");
    anchors = [[-2.8, 0.65, 0.6], [1.9, 2.6, -1.2], [3.4, 0.55, 1.4]];
  } else if (theme === "culture") {
    path([[-3.9, 2.1], [-1.5, 1.7], [0.5, 2.0], [3.6, 1.8]], 1.05);
    for (let step = 0; step < 3; step++) box(0, 0.12 + step * 0.13, 0.7 - step * 0.14, 3.5 - step * 0.15, 0.16, 1.3, "stone");
    box(0, 1.15, -0.5, 3.55, 1.5, 1.65, "wall");
    roof(0, 1.94, -0.5, 4.2, 2.45, 0.77);
    for (let x = -1.45; x <= 1.5; x += 0.72) {
      cylinder(x, 1.04, 0.55, 0.055, 0.07, 1.47, "wood", 8);
      box(x, 1.1, 0.342, 0.34, 0.88, 0.02, "roof");
      line([[x - 0.1, 0.69, 0.364], [x - 0.1, 1.48, 0.364]], "white");
    }
    house(-3.5, -0.7, 1.15, 0.87, 1.2); house(3.4, -0.7, 1.1, 0.87, 1.2);
    tree(-3.65, 1.6, 1.12); tree(3.7, 1.4, 1.1); tree(2.5, -2.65, 0.8);
    anchors = [[-0.45, 1.1, 1.25], [0.9, 2.6, -0.35], [3.0, 0.7, 2.5]];
  } else if (theme === "dining") {
    path([[-4.85, 1.4], [-2.5, 1.6], [0.8, 2.4], [4.7, 1.4]], 0.85);
    house(-0.7, -1.0, 3.0, 1.55, 1.55, true);
    // Striped café awning is real small geometry with thin drawn ribs.
    for (let stripe = 0; stripe < 10; stripe++) solid(new THREE.BoxGeometry(0.29, 0.055, 0.86), stripe % 2 ? "chalk" : "coral", [-2.03 + stripe * 0.296, 1.18, 0.12], [0.19, 0, 0]);
    for (const [x, z] of [[-1.8, 1.12], [0.25, 1.12], [2.5, 0.35]]) {
      cylinder(x, 0.48, z, 0.38, 0.38, 0.075, "chalk", 18); cylinder(x, 0.25, z, 0.045, 0.07, 0.46, "wood", 8);
      for (const dx of [-0.56, 0.56]) { cylinder(x + dx, 0.28, z, 0.17, 0.17, 0.075, "wood", 12); cylinder(x + dx, 0.15, z, 0.034, 0.052, 0.25, "wood", 6); }
      cylinder(x, 0.56, z, 0.07, 0.06, 0.1, "coral", 10);
    }
    cylinder(2.5, 1.01, 0.35, 0.028, 0.04, 1.88, "wood", 8);
    solid(new THREE.ConeGeometry(0.94, 0.33, 12), "chalk", [2.5, 1.92, 0.35]);
    for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2; line([[2.5, 2.09, 0.35], [2.5 + Math.cos(a) * 0.94, 1.75, 0.35 + Math.sin(a) * 0.94]], "hatch"); }
    tree(-3.95, -0.8, 1.2); tree(4.1, -1.1, 1.1); tree(3.7, 2.3, 0.65);
    anchors = [[-1.7, 0.85, 1.3], [0.05, 2.4, -1.0], [2.65, 0.65, 2.2]];
  } else {
    // A neutral folded notebook and compass: no invented landscape or building.
    box(0, 0.17, -0.2, 5.0, 0.21, 3.0, "chalk");
    box(0, 0.05, -0.2, 5.18, 0.07, 3.16, "wood");
    line([[0, 0.284, -1.7], [-0.025, 0.3, -0.2], [0, 0.284, 1.3]]);
    for (let row = 0; row < 6; row++) line([[-2.0, 0.286, -1.3 + row * 0.38], [-0.42, 0.286, -1.28 + row * 0.38]], "hatch");
    cylinder(1.22, 0.3, -0.27, 0.77, 0.77, 0.04, "sand", 40);
    line(Array.from({ length: 49 }, (_, i) => [1.22 + Math.cos(i / 48 * Math.PI * 2) * 0.73, 0.33, -0.27 + Math.sin(i / 48 * Math.PI * 2) * 0.73]));
    solid(new THREE.ConeGeometry(0.14, 0.93, 4), "coral", [1.22, 0.38, -0.27], [Math.PI / 2, 0, -0.55]);
    box(-2.2, 0.29, 2.05, 2.0, 0.1, 0.13, "coral");
    rock(3.65, -0.2, 0.42); rock(-3.9, -1.6, 0.33);
    anchors = [[-1.4, 0.6, 0.3], [1.25, 0.85, -0.55], [2.8, 0.7, 1.9]];
  }

  // A few pencil marks give the cut-paper island scale without adding claims.
  for (let i = 0; i < 20; i++) {
    const a = random() * Math.PI * 2, x = Math.cos(a) * (4.5 + random() * 0.55), z = Math.sin(a) * (3.3 + random() * 0.2);
    line([[x, 0.066, z], [x + 0.12, 0.07, z + 0.018], [x + 0.17, 0.066, z]], "hatch");
  }
  let triangles = 0;
  for (const [color, geometries] of solids) {
    const merged = mergeGeometries(geometries, false); geometries.forEach((geometry) => geometry.dispose());
    const material = new THREE.MeshToonMaterial({ color: PALETTE[color], gradientMap: gradient, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(merged, material); mesh.name = `illustration:${color}`; root.add(mesh);
    triangles += merged.getAttribute("position").count / 3;
    resources.add(merged); resources.add(material);
  }
  for (const [color, positions] of strokes) {
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    const material = new THREE.LineBasicMaterial({ color: PALETTE[color], transparent: true, opacity: color === "hatch" ? 0.52 : 0.86, depthWrite: false });
    root.add(new THREE.LineSegments(geometry, material)); resources.add(geometry); resources.add(material);
  }
  const hotspotAnchors = sketch.hotspots.map((hotspot, i) => ({ ...hotspot, position: anchors[hotspot.id === "route" ? 2 : i] }));
  root.userData = { theme: theme, triangles, drawCalls: root.children.length, generated: "original-stylized-geometry", seed: sketch.seed };
  let disposed = false;
  let pointCloud = null;
  function setPresentation(mode) {
    if (disposed || !["solid", "ink", "points"].includes(mode)) return false;
    if (mode === "points" && !pointCloud) {
      const positions = [], colors = [];
      // Deterministic samples from the actual triangle surfaces, not an image effect.
      const sample = seededRandom(sketch.seed + 17);
      const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
      for (const object of root.children.filter((child) => child.isMesh)) {
        const attribute = object.geometry.getAttribute("position");
        const color = object.material.color;
        const count = Math.max(30, Math.round(attribute.count / 3 * 0.8));
        for (let i = 0; i < count; i++) {
          const face = Math.floor(sample() * attribute.count / 3) * 3;
          a.fromBufferAttribute(attribute, face); b.fromBufferAttribute(attribute, face + 1); c.fromBufferAttribute(attribute, face + 2);
          const u = Math.sqrt(sample()), v = sample();
          a.multiplyScalar(1 - u).addScaledVector(b, u * (1 - v)).addScaledVector(c, u * v);
          positions.push(...a.toArray()); colors.push(color.r, color.g, color.b);
        }
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
      const material = new THREE.PointsMaterial({ size: 2.6, sizeAttenuation: false, vertexColors: true });
      pointCloud = new THREE.Points(geometry, material); pointCloud.name = "illustration:surface-points";
      root.add(pointCloud); resources.add(geometry); resources.add(material);
    }
    for (const child of root.children) child.visible = child.isMesh ? mode === "solid" : child.isPoints ? mode === "points" : mode !== "points";
    root.userData.presentation = mode;
    return true;
  }
  return { root, hotspots: hotspotAnchors, stats: root.userData, setPresentation, dispose() { if (disposed) return; disposed = true; resources.forEach((resource) => resource.dispose()); resources.clear(); root.clear(); } };
}

export function createDestinationSketchRenderer({ container, sketch, reducedMotion = false, onProject, onChapter, onTourChange, onError, onMetrics }) {
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" }); }
  catch { throw new Error("destination_webgl_unavailable"); }
  const scene = new THREE.Scene();
  const model = buildDestinationSketchModel(sketch);
  scene.add(model.root);
  scene.add(new THREE.HemisphereLight(0xfffaea, 0xaaa38f, 2.0));
  const sunlight = new THREE.DirectionalLight(0xfffcf2, 2.25); sunlight.position.set(-4, 9, 6); scene.add(sunlight);
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 1.5));
  renderer.setClearColor(0xf9f6ed, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.domElement.setAttribute("aria-hidden", "true");
  renderer.domElement.className = "destination-sketch-canvas";
  container.appendChild(renderer.domElement);
  const camera = new THREE.OrthographicCamera(-8, 8, 5, -5, 0.1, 100);
  camera.position.fromArray(DEFAULT_CAMERA.position);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.fromArray(DEFAULT_CAMERA.target);
  controls.enablePan = false; controls.enableDamping = false;
  controls.minPolarAngle = Math.PI * 0.12; controls.maxPolarAngle = Math.PI * 0.46;
  controls.minZoom = 0.72; controls.maxZoom = 2.15; controls.rotateSpeed = 0.65; controls.zoomSpeed = 0.8;
  controls.update();
  let width = 1, height = 1, disposed = false, renderCount = 0;
  const readCamera = () => ({ position: camera.position.toArray(), target: controls.target.toArray(), zoom: camera.zoom });
  function writeCamera(state) { camera.position.fromArray(state.position); controls.target.fromArray(state.target); camera.zoom = state.zoom; camera.updateProjectionMatrix(); controls.update(); }
  const tour = createSketchTour({ readCamera, writeCamera, reducedMotion, onChapter, onState: onTourChange });
  const project = () => model.hotspots.map((hotspot) => {
    const point = vector(hotspot.position).project(camera);
    return { id: hotspot.id, x: (point.x + 1) / 2 * width, y: (1 - point.y) / 2 * height, visible: point.z > -1 && point.z < 1 && Math.abs(point.x) < 0.96 && Math.abs(point.y) < 0.96 };
  });
  const loop = createSketchFrameLoop({
    requestFrame: (fn) => requestAnimationFrame(fn), cancelFrame: (id) => cancelAnimationFrame(id), step: (time) => tour.step(time),
    render() {
      if (disposed) return;
      try {
        renderer.render(scene, camera); renderCount++;
        onProject?.(project());
        onMetrics?.({ renderer: "webgl", calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures, renders: renderCount, dpr: renderer.getPixelRatio(), camera: readCamera() });
      } catch { tour.stop(); loop.pause(); onError?.("webgl_render_failed"); }
    },
  });
  const onChange = () => loop.invalidate();
  const interrupt = () => { tour.stop(); loop.invalidate(); };
  controls.addEventListener("change", onChange); controls.addEventListener("start", interrupt);
  // Capture catches the very first contact, before OrbitControls can move.
  renderer.domElement.addEventListener("pointerdown", interrupt, { passive: true });
  renderer.domElement.addEventListener("wheel", interrupt, { passive: true });
  const resize = () => {
    if (disposed) return;
    width = Math.max(1, container.clientWidth); height = Math.max(1, container.clientHeight);
    const aspect = width / height, viewHeight = Math.max(8.65, 13.8 / aspect);
    camera.left = -viewHeight * aspect / 2; camera.right = viewHeight * aspect / 2; camera.top = viewHeight / 2; camera.bottom = -viewHeight / 2;
    camera.updateProjectionMatrix(); renderer.setSize(width, height); loop.invalidate();
  };
  const observer = new ResizeObserver(resize); observer.observe(container); resize();
  const visibility = () => { if (document.hidden) { tour.stop(); loop.pause(); } else loop.resume(); };
  document.addEventListener("visibilitychange", visibility);
  const lost = (event) => { event.preventDefault(); tour.stop(); loop.pause(); onError?.("webgl_context_lost"); };
  renderer.domElement.addEventListener("webglcontextlost", lost);
  function focus(id) {
    interrupt();
    const index = model.hotspots.findIndex((hotspot) => hotspot.id === id);
    if (index < 0) return;
    const target = vector(model.hotspots[index].position).multiplyScalar(0.42); target.y = Math.min(target.y, 1.15);
    const delta = camera.position.clone().sub(controls.target); controls.target.copy(target); camera.position.copy(target).add(delta);
    camera.zoom = 1.12; camera.updateProjectionMatrix(); controls.update(); loop.invalidate();
  }
  function orbit(horizontal, vertical = 0) {
    interrupt(); const spherical = new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target));
    spherical.theta += horizontal; spherical.phi = THREE.MathUtils.clamp(spherical.phi + vertical, controls.minPolarAngle, controls.maxPolarAngle);
    camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(spherical)); controls.update(); loop.invalidate();
  }
  return {
    focus, orbit,
    setPresentation(mode) { interrupt(); model.setPresentation(mode); loop.invalidate(); },
    zoom(factor) { interrupt(); camera.zoom = THREE.MathUtils.clamp(camera.zoom * factor, controls.minZoom, controls.maxZoom); camera.updateProjectionMatrix(); controls.update(); loop.invalidate(); },
    reset() { interrupt(); writeCamera(DEFAULT_CAMERA); loop.invalidate(); },
    startTour() {
      const beats = model.hotspots.map((hotspot, i) => ({ id: hotspot.id, position: [[8, 8, 14], [-9, 9, 11], [11, 7, 9]][i], target: hotspot.position.map((n, index) => index === 1 ? Math.min(n * 0.4, 1.15) : n * 0.4), zoom: [1.1, 1.19, 1.07][i] }));
      const started = tour.start(beats, performance.now()); if (started) loop.invalidate(); return started;
    },
    stopTour: interrupt,
    dispose() {
      if (disposed) return; disposed = true;
      tour.dispose(); loop.dispose(); observer.disconnect();
      document.removeEventListener("visibilitychange", visibility);
      renderer.domElement.removeEventListener("pointerdown", interrupt); renderer.domElement.removeEventListener("wheel", interrupt); renderer.domElement.removeEventListener("webglcontextlost", lost);
      controls.removeEventListener("change", onChange); controls.removeEventListener("start", interrupt); controls.dispose();
      model.dispose(); renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove(); scene.clear();
    },
  };
}
