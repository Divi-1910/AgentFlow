// Derived from the img2threejs-generated factory (see hero-bot-workspace/object-sculpt-spec.json).
// Trimmed by hero-bot-workspace/tools/trim_factory.py: unused look-dev exports removed, per-node metadata compacted.
import * as THREE from 'three';

export type ProceduralModelOptions = {
  wireframe?: boolean;
  castShadow?: boolean;
  receiveShadow?: boolean;
  textureSize?: number;
  textureAnisotropy?: number;
  qualityPriority?: 'reference-fidelity' | 'balanced';
};

export type ProceduralModelRuntime = {
  nodes: Record<string, THREE.Object3D>;
  meshes: Record<string, THREE.Mesh>;
  sockets: Record<string, THREE.Object3D>;
  colliders: Record<string, unknown>;
  destructionGroups: Record<string, THREE.Object3D[]>;
};

type SculptMaterialSpec = Record<string, any>;

// THREE.CapsuleGeometry duplicates every UV-seam vertex (measured: 194 boundary
// edges on the default radius/segments below) -- same benign pattern as box/
// cylinder/sphere/torus, all of which weld cleanly to 0 given a CORRECT weld.
// (A naive vertex-only mergeVertices() reports 64 'non-manifold' edges here, but
// that is a counting artifact, not a real defect: it double-counts a handful of
// near-pole triangles that become degenerate once two of their three corners
// coincide -- confirmed by replicating subdivideCatmullClark's own degenerate-
// triangle-aware vertex identity, which finds a perfectly ordinary 2-manifold.)
// A capsule is the primary shape for skinned limbs/torso (PLAN_1.5), and skinning
// weight computation is O(vertices x bones), so fewer, guaranteed-simple vertices
// is worth having regardless -- authored as a deterministic, closed-by-
// construction mesh instead: shared pole vertices, and
// the radial index taken `% radialSegments` so the seam is never a duplicate
// vertex in the first place, rather than something to weld away afterward.
// Adapted from forge/stage5_rig/emit_rig.py's buildWatertightCapsule (verified
// there: 0 boundary edges, 0 non-manifold edges, deterministic across repeated
// runs) -- ported here rather than imported because this factory and the rig
// emitter are separate generated-output surfaces with no shared runtime module;
// see forge/tests/test_primitive_watertightness.py for the measured proof, and
// coordinate with the rig owner before changing either copy independently.
function buildWatertightCapsule(
  radius: number,
  cylLength: number,
  capSegments: number,
  radialSegments: number,
  heightSegments: number,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  const uvs: number[] = [];
  const halfCyl = cylLength / 2;
  const totalSpan = 2 * (Math.PI / 2 * radius) + Math.max(0, cylLength);
  const vOf = (fromBottom: number) => (totalSpan > 0 ? fromBottom / totalSpan : 0);

  const bottomPoleIndex = positions.length / 3;
  positions.push(0, -halfCyl - radius, 0);
  uvs.push(0.5, vOf(0));

  const ringStarts: number[] = [];
  const ringV: number[] = [];
  for (let ring = 1; ring <= capSegments; ring += 1) {
    const phi = (Math.PI / 2) * (ring / capSegments);
    const y = -halfCyl - radius * Math.cos(phi);
    const r = radius * Math.sin(phi);
    const start = positions.length / 3;
    ringStarts.push(start);
    ringV.push(vOf(radius * phi));
    for (let radial = 0; radial < radialSegments; radial += 1) {
      const theta = (radial / radialSegments) * Math.PI * 2;
      positions.push(r * Math.cos(theta), y, r * Math.sin(theta));
      uvs.push(radial / radialSegments, vOf(radius * phi));
    }
  }

  const cylinderRingStarts: number[] = [];
  if (cylLength > 0) {
    for (let step = 1; step <= heightSegments; step += 1) {
      const y = -halfCyl + (cylLength * step) / heightSegments;
      const start = positions.length / 3;
      cylinderRingStarts.push(start);
      const v = vOf(radius * (Math.PI / 2) + halfCyl + y);
      for (let radial = 0; radial < radialSegments; radial += 1) {
        const theta = (radial / radialSegments) * Math.PI * 2;
        positions.push(radius * Math.cos(theta), y, radius * Math.sin(theta));
        uvs.push(radial / radialSegments, v);
      }
    }
  }

  const topRingStarts: number[] = [];
  for (let ring = capSegments - 1; ring >= 1; ring -= 1) {
    const phi = (Math.PI / 2) * (ring / capSegments);
    const y = halfCyl + radius * Math.cos(phi);
    const r = radius * Math.sin(phi);
    const start = positions.length / 3;
    topRingStarts.push(start);
    const v = vOf(radius * (Math.PI / 2) + Math.max(0, cylLength) + radius * (Math.PI / 2 - phi));
    for (let radial = 0; radial < radialSegments; radial += 1) {
      const theta = (radial / radialSegments) * Math.PI * 2;
      positions.push(r * Math.cos(theta), y, r * Math.sin(theta));
      uvs.push(radial / radialSegments, v);
    }
  }

  const topPoleIndex = positions.length / 3;
  positions.push(0, halfCyl + radius, 0);
  uvs.push(0.5, vOf(totalSpan));

  const firstBottomRing = ringStarts[0];
  for (let radial = 0; radial < radialSegments; radial += 1) {
    const next = (radial + 1) % radialSegments;
    indices.push(bottomPoleIndex, firstBottomRing + radial, firstBottomRing + next);
  }

  const allRings = [...ringStarts, ...cylinderRingStarts, ...topRingStarts];
  for (let i = 0; i < allRings.length - 1; i += 1) {
    const a = allRings[i];
    const b = allRings[i + 1];
    for (let radial = 0; radial < radialSegments; radial += 1) {
      const next = (radial + 1) % radialSegments;
      indices.push(a + radial, a + next, b + next);
      indices.push(a + radial, b + next, b + radial);
    }
  }

  const lastRing = allRings[allRings.length - 1];
  for (let radial = 0; radial < radialSegments; radial += 1) {
    const next = (radial + 1) % radialSegments;
    indices.push(topPoleIndex, lastRing + next, lastRing + radial);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

// bevelEnabled defaults to true on THREE.ExtrudeGeometry and rounds every
// corner — sharp/pointed profiles (blades, fork tines, spikes) need
// bevelEnabled: false plus lineTo()-only path segments near the tip, since a
// curve command cannot produce a true converging point.
function buildExtrudeShape(points: [number, number][], holes?: [number, number][][]): THREE.Shape {
  const shape = new THREE.Shape();
  if (points.length > 0) {
    shape.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i += 1) {
      shape.lineTo(points[i][0], points[i][1]);
    }
  }
  // Cutouts (e.g. an oval wire-cutter hole) as THREE.Path added to shape.holes —
  // dep-free boolean subtraction via the tessellator, no CSG library needed.
  for (const loop of holes ?? []) {
    if (loop.length < 3) continue;
    const path = new THREE.Path();
    path.moveTo(loop[0][0], loop[0][1]);
    for (let i = 1; i < loop.length; i += 1) path.lineTo(loop[i][0], loop[i][1]);
    path.closePath();
    shape.holes.push(path);
  }
  return shape;
}

// Build an N-gon oval loop (for hole authoring from a compact {cx,cy,rx,ry} descriptor).
function ovalLoop(cx: number, cy: number, rx: number, ry: number, seg = 24): [number, number][] {
  const loop: [number, number][] = [];
  for (let i = 0; i < seg; i += 1) {
    const a = (i / seg) * Math.PI * 2;
    loop.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return loop;
}

function buildExtrudeGeometry(profile: { points: [number, number][]; depth: number; holes?: [number, number][][]; ovalHoles?: { cx: number; cy: number; rx: number; ry: number }[] }): THREE.ExtrudeGeometry {
  const holes = [...(profile.holes ?? []), ...((profile.ovalHoles ?? []).map((o) => ovalLoop(o.cx, o.cy, o.rx, o.ry)))];
  const shape = buildExtrudeShape(profile.points, holes);
  return new THREE.ExtrudeGeometry(shape, {
    depth: profile.depth,
    bevelEnabled: false,
    steps: 1,
  });
}

type TaperedStation = { position: [number, number, number]; rx: number; rz: number; twist?: number };

// Frames come from PARALLEL TRANSPORT, not from a Frenet frame. A Frenet frame is defined by
// the curve's normal, which flips sign wherever the path has an inflection or straightens out,
// and every flip twists the surface 180 degrees within one segment. Carrying the previous frame
// forward and removing only its along-path component keeps the twist continuous. THREE's own
// extrudePath and TubeGeometry do not expose this, which is why this is hand-built.
function buildTaperedSweepGeometry(
  sweep: { stations: TaperedStation[]; radialSegments?: number; capEnds?: boolean },
): THREE.BufferGeometry {
  const stations = sweep.stations;
  if (stations.length < 2) throw new Error('tapered-sweep needs at least two stations');
  const radial = Math.max(3, sweep.radialSegments ?? 10);
  const centres = stations.map((s) => new THREE.Vector3(...s.position));

  const tangents = centres.map((_, i) => {
    const prev = centres[Math.max(0, i - 1)];
    const next = centres[Math.min(centres.length - 1, i + 1)];
    const t = next.clone().sub(prev);
    // Coincident neighbours would normalise to NaN and poison every downstream vertex.
    return t.lengthSq() < 1e-12 ? new THREE.Vector3(0, 1, 0) : t.normalize();
  });

  // Seed a reference axis that is not parallel to the first tangent, or the first cross
  // product is degenerate and the whole sweep collapses to a line.
  let ref = new THREE.Vector3(0, 0, 1);
  if (Math.abs(tangents[0].dot(ref)) > 0.9) ref = new THREE.Vector3(1, 0, 0);

  const normals: THREE.Vector3[] = [];
  const binormals: THREE.Vector3[] = [];
  let carried = ref.clone().sub(tangents[0].clone().multiplyScalar(ref.dot(tangents[0]))).normalize();
  for (let i = 0; i < tangents.length; i += 1) {
    const t = tangents[i];
    // Project the carried frame back onto the plane perpendicular to this tangent.
    const n = carried.clone().sub(t.clone().multiplyScalar(carried.dot(t)));
    if (n.lengthSq() < 1e-12) {
      const fallback = Math.abs(t.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
      n.copy(fallback.sub(t.clone().multiplyScalar(fallback.dot(t))));
    }
    n.normalize();
    normals.push(n);
    binormals.push(new THREE.Vector3().crossVectors(t, n).normalize());
    carried = n;
  }

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const ringStart: number[] = [];
  const isPoint: boolean[] = [];

  for (let i = 0; i < stations.length; i += 1) {
    const st = stations[i];
    const v = i / (stations.length - 1);
    ringStart.push(positions.length / 3);
    // A station whose section has collapsed emits ONE vertex, not a ring of radius zero.
    // A degenerate ring still carries `radial` coincident vertices and `radial` zero-area
    // triangles, so the lock ends in a blunt cap the width of the floating-point noise
    // rather than at a point -- and a hair lock, a horn or a blade tip has to reach a point.
    if (st.rx <= 1e-6 && st.rz <= 1e-6) {
      isPoint.push(true);
      positions.push(centres[i].x, centres[i].y, centres[i].z);
      uvs.push(0.5, v);
      continue;
    }
    isPoint.push(false);
    const twist = ((st.twist ?? 0) * Math.PI) / 180;
    for (let j = 0; j <= radial; j += 1) {
      const theta = (j / radial) * Math.PI * 2 + twist;
      const offset = normals[i].clone().multiplyScalar(Math.cos(theta) * st.rx)
        .add(binormals[i].clone().multiplyScalar(Math.sin(theta) * st.rz));
      const p = centres[i].clone().add(offset);
      positions.push(p.x, p.y, p.z);
      uvs.push(j / radial, v);
    }
  }

  for (let i = 0; i < stations.length - 1; i += 1) {
    const a0 = ringStart[i];
    const b0 = ringStart[i + 1];
    if (isPoint[i] && isPoint[i + 1]) continue;   // two collapsed stations bound nothing
    for (let j = 0; j < radial; j += 1) {
      // Wound so the face normal points radially OUTWARD.
      //
      // Ring vertices advance from `normal` toward `binormal`, and binormal is
      // tangent x normal, so increasing theta runs counter-clockwise seen from the
      // far end of the segment. Taking the ring-to-ring edge first therefore puts
      // the cross product on the inside. Measured as signed volume on the built
      // mesh: every tapered-sweep came out negative -- a torso at -0.0674 and a
      // tail at -0.0044 against a positive ellipsoid head -- so every sweep this
      // generator has ever emitted rendered its back faces, with normals pointing
      // into the solid and every lighting judgement made on the wrong surface.
      if (isPoint[i]) indices.push(a0, b0 + j + 1, b0 + j);
      else if (isPoint[i + 1]) indices.push(a0 + j, a0 + j + 1, b0);
      else indices.push(a0 + j, a0 + j + 1, b0 + j, a0 + j + 1, b0 + j + 1, b0 + j);
    }
  }

  if (sweep.capEnds ?? true) {
    for (const end of [0, stations.length - 1]) {
      if (isPoint[end]) continue;   // a point end is already closed
      const centreIndex = positions.length / 3;
      positions.push(centres[end].x, centres[end].y, centres[end].z);
      uvs.push(0.5, end === 0 ? 0 : 1);
      const base = ringStart[end];
      for (let j = 0; j < radial; j += 1) {
        if (end === 0) indices.push(centreIndex, base + j + 1, base + j);
        else indices.push(centreIndex, base + j, base + j + 1);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function readLayerNumber(value: unknown, keys: string[], fallback: number): number {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of keys) {
      if (typeof record[key] === 'number') return record[key] as number;
    }
  }
  return fallback;
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = /^#[0-9a-f]{3}$/i.test(hex)
    ? '#' + hex.slice(1).split('').map((part) => part + part).join('')
    : hex;
  const value = /^#[0-9a-f]{6}$/i.test(normalized) ? Number.parseInt(normalized.slice(1), 16) : 0x8a7a5f;
  return [clampAlbedoChannel((value >> 16) & 255), clampAlbedoChannel((value >> 8) & 255), clampAlbedoChannel(value & 255)];
}

function materialPalette(spec: SculptMaterialSpec): string[] {
  const palette = spec.colorVariation?.palette;
  if (Array.isArray(palette) && palette.length > 0) return palette.filter((value) => typeof value === 'string');
  const secondary = spec.albedo?.secondary;
  const colors = [spec.baseColor ?? spec.color ?? spec.albedo?.dominant, ...(Array.isArray(secondary) ? secondary : [])];
  return colors.filter((value): value is string => typeof value === 'string' && value.startsWith('#'));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampAlbedoChannel(value: number): number {
  return Math.max(30, Math.min(240, Math.round(value)));
}

function clampPbrF0(value: number): number {
  return Math.max(0.02, Math.min(1, value));
}

function clampPbrIor(value: number): number {
  return Math.max(1, Math.min(2.5, value));
}

function clampPbrMetalness(value: number): number {
  return value >= 0.5 ? 1 : 0;
}

function clampedAlbedoColor(spec: SculptMaterialSpec): THREE.Color {
  const source = typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F';
  // setStyle with an explicit SRGBColorSpace, NOT the numeric constructor.
  //
  // `new THREE.Color(r, g, b)` treats its arguments as LINEAR working-space components,
  // while an authored `baseColor` hex is sRGB. Feeding one to the other skipped the
  // transfer function and lifted every dark albedo: #2e2a28, authored as a near-black
  // vinyl, rendered at roughly sRGB 0.46 — a mid grey. The error is largest exactly where
  // it matters most, because the transfer curve is steepest near black.
  return new THREE.Color().setStyle(source, THREE.SRGBColorSpace);
}

function smoothCurve(value: number): number {
  return value * value * (3 - 2 * value);
}

function periodicHash(x: number, y: number, seed: number, periodX: number, periodY: number): number {
  const wrappedX = ((x % periodX) + periodX) % periodX;
  const wrappedY = ((y % periodY) + periodY) % periodY;
  let value = Math.imul(wrappedX + seed * 17, 374761393) ^ Math.imul(wrappedY + seed * 31, 668265263);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

function periodicValueNoise(u: number, v: number, seed: number, periodX: number, periodY: number): number {
  const x = u * periodX;
  const y = v * periodY;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = smoothCurve(x - x0);
  const ty = smoothCurve(y - y0);
  const a = periodicHash(x0, y0, seed, periodX, periodY);
  const b = periodicHash(x0 + 1, y0, seed, periodX, periodY);
  const c = periodicHash(x0, y0 + 1, seed, periodX, periodY);
  const d = periodicHash(x0 + 1, y0 + 1, seed, periodX, periodY);
  return THREE.MathUtils.lerp(THREE.MathUtils.lerp(a, b, tx), THREE.MathUtils.lerp(c, d, tx), ty);
}

type SurfaceBand = {
  frequency: number;
  amplitude: number;
  stretchX: number;
  stretchY: number;
  ridge: boolean;
};

function surfaceBands(spec: SculptMaterialSpec): SurfaceBand[] {
  const source = Array.isArray(spec.surfaceFrequencyBands) ? spec.surfaceFrequencyBands : [];
  const parsed = source.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return [];
    const band = item as Record<string, unknown>;
    const frequency = typeof band.frequency === 'number' ? band.frequency : 0;
    const amplitude = typeof band.amplitude === 'number' ? band.amplitude : 0;
    if (frequency <= 0 || amplitude <= 0) return [];
    const stretch = Array.isArray(band.stretch) ? band.stretch : [1, 1];
    const description = `${String(band.pattern ?? '')} ${String(band.role ?? '')}`.toLowerCase();
    return [{
      frequency,
      amplitude,
      stretchX: typeof stretch[0] === 'number' ? Math.max(0.1, stretch[0]) : 1,
      stretchY: typeof stretch[1] === 'number' ? Math.max(0.1, stretch[1]) : 1,
      ridge: /(ridge|groove|grain|fiber|striated|crack)/.test(description),
    }];
  });
  return parsed.length > 0 ? parsed : [
    { frequency: 2, amplitude: 0.42, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 12, amplitude: 0.22, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 56, amplitude: 0.08, stretchX: 1, stretchY: 1, ridge: false },
  ];
}

function sampleSurface(u: number, v: number, bands: SurfaceBand[], seed: number): number {
  let value = 0;
  let weight = 0;
  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index];
    const periodX = Math.max(1, Math.round(band.frequency * band.stretchX));
    const periodY = Math.max(1, Math.round(band.frequency * band.stretchY));
    let sample = periodicValueNoise(u, v, seed + index * 1013, periodX, periodY);
    if (band.ridge) sample = 1 - Math.abs(sample * 2 - 1);
    value += sample * band.amplitude;
    weight += band.amplitude;
  }
  return weight > 0 ? clamp01(value / weight) : 0.5;
}

function mixPalette(colors: [number, number, number][], value: number): [number, number, number] {
  if (colors.length === 1) return colors[0];
  const scaled = clamp01(value) * (colors.length - 1);
  const index = Math.min(colors.length - 2, Math.floor(scaled));
  const mix = scaled - index;
  const a = colors[index];
  const b = colors[index + 1];
  return [
    Math.round(THREE.MathUtils.lerp(a[0], b[0], mix)),
    Math.round(THREE.MathUtils.lerp(a[1], b[1], mix)),
    Math.round(THREE.MathUtils.lerp(a[2], b[2], mix)),
  ];
}

type ColorGradientStop = { offset: number; color: string };
type ColorGradientSpec = {
  type: 'linear' | 'radial';
  axis: [number, number];
  stops: ColorGradientStop[];
};

function parseRgba(value: string): [number, number, number] {
  const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(value);
  if (!match) return [138, 122, 95];
  return [clampAlbedoChannel(Number(match[1])), clampAlbedoChannel(Number(match[2])), clampAlbedoChannel(Number(match[3]))];
}

// Analytical per-pixel gradient sample. The extraction schema's colorGradient carries
// exact rgba(...) stop colors (see extract_part_color_recipe.py), so this samples the
// same trend directly in JS math rather than round-tripping through a Canvas 2D
// createLinearGradient/createRadialGradient object — same visual result, and it composes
// directly with the existing noise/height-correlated colorVariation blend below.
function sampleColorGradient(gradient: ColorGradientSpec, u: number, v: number): [number, number, number] {
  const stops = gradient.stops.length >= 2 ? gradient.stops : [{ offset: 0, color: 'rgba(138,122,95,1)' }, { offset: 1, color: 'rgba(138,122,95,1)' }];
  let t: number;
  if (gradient.type === 'radial') {
    const [cx, cy] = gradient.axis;
    const dx = u - cx;
    const dy = v - cy;
    const maxRadius = Math.max(0.001, Math.hypot(Math.max(cx, 1 - cx), Math.max(cy, 1 - cy)));
    t = clamp01(Math.hypot(dx, dy) / maxRadius);
  } else {
    const [ax, ay] = gradient.axis;
    const projection = (u - 0.5) * ax + (v - 0.5) * ay;
    const maxProjection = 0.5 * (Math.abs(ax) + Math.abs(ay)) || 0.5;
    t = clamp01(projection / maxProjection + 0.5);
  }
  const scaled = t * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.max(0, Math.floor(scaled)));
  const mix = scaled - index;
  const a = parseRgba(stops[index].color);
  const b = parseRgba(stops[index + 1].color);
  return [
    THREE.MathUtils.lerp(a[0], b[0], mix),
    THREE.MathUtils.lerp(a[1], b[1], mix),
    THREE.MathUtils.lerp(a[2], b[2], mix),
  ];
}

function writePixel(data: Uint8ClampedArray, offset: number, red: number, green: number, blue: number): void {
  data[offset] = Math.max(0, Math.min(255, Math.round(red)));
  data[offset + 1] = Math.max(0, Math.min(255, Math.round(green)));
  data[offset + 2] = Math.max(0, Math.min(255, Math.round(blue)));
  data[offset + 3] = 255;
}

function makeCanvas(size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

function createMapTexture(
  canvas: HTMLCanvasElement,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [2, 2];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 2,
    typeof repeat[1] === 'number' ? repeat[1] : 2,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

type ProceduralTextureSet = {
  albedo: THREE.Texture;
  roughness: THREE.Texture;
  height: THREE.Texture;
  normal: THREE.Texture;
  ao: THREE.Texture;
  source: 'reference-pixel-extraction' | 'procedural';
};

function referenceMapUrl(spec: SculptMaterialSpec, channel: string): string | null {
  const reference = spec.referencePbr;
  if (!reference || typeof reference !== 'object') return null;
  if (reference.usable === false) return null;
  const confidence = typeof reference.confidence === 'number'
    ? reference.confidence
    : (typeof reference.estimatedFidelity === 'number' ? reference.estimatedFidelity : 0);
  const threshold = typeof reference.targetThreshold === 'number' ? reference.targetThreshold : 0.7;
  if (confidence < threshold) return null;
  const maps = reference.maps;
  if (!maps || typeof maps !== 'object') return null;
  const map = (maps as Record<string, unknown>)[channel];
  if (!map || typeof map !== 'object') return null;
  const record = map as Record<string, unknown>;
  const url = typeof record.url === 'string' && record.url.trim() ? record.url : record.path;
  return typeof url === 'string' && url.trim() ? url : null;
}

function createLoadedMapTexture(
  url: string,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.Texture {
  const texture = new THREE.TextureLoader().load(url);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [1, 1];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 1,
    typeof repeat[1] === 'number' ? repeat[1] : 1,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

function makeReferenceTextureSet(spec: SculptMaterialSpec, options: ProceduralModelOptions): ProceduralTextureSet | null {
  const albedo = referenceMapUrl(spec, 'albedo');
  const roughness = referenceMapUrl(spec, 'roughness');
  const height = referenceMapUrl(spec, 'height');
  const normal = referenceMapUrl(spec, 'normal');
  const ao = referenceMapUrl(spec, 'ao');
  if (!albedo || !roughness || !height || !normal || !ao) return null;
  return {
    albedo: createLoadedMapTexture(albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createLoadedMapTexture(roughness, THREE.NoColorSpace, spec, options),
    height: createLoadedMapTexture(height, THREE.NoColorSpace, spec, options),
    normal: createLoadedMapTexture(normal, THREE.NoColorSpace, spec, options),
    ao: createLoadedMapTexture(ao, THREE.NoColorSpace, spec, options),
    source: 'reference-pixel-extraction',
  };
}

function makeProceduralTextureSet(
  id: string,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): ProceduralTextureSet | null {
  if (typeof document === 'undefined') return null;
  const qualityFirst = (options.qualityPriority ?? 'reference-fidelity') === 'reference-fidelity';
  const requested = options.textureSize ?? spec.textureResolution;
  const requestedSize = typeof requested === 'number' && Number.isFinite(requested)
    ? requested
    : (qualityFirst ? 1024 : 512);
  const size = Math.max(256, Math.min(2048, 2 ** Math.round(Math.log2(requestedSize))));
  const canvases = {
    albedo: makeCanvas(size),
    roughness: makeCanvas(size),
    height: makeCanvas(size),
    normal: makeCanvas(size),
    ao: makeCanvas(size),
  };
  const contexts = {
    albedo: canvases.albedo.getContext('2d'),
    roughness: canvases.roughness.getContext('2d'),
    height: canvases.height.getContext('2d'),
    normal: canvases.normal.getContext('2d'),
    ao: canvases.ao.getContext('2d'),
  };
  if (!contexts.albedo || !contexts.roughness || !contexts.height || !contexts.normal || !contexts.ao) return null;
  const images = {
    albedo: contexts.albedo.createImageData(size, size),
    roughness: contexts.roughness.createImageData(size, size),
    height: contexts.height.createImageData(size, size),
    normal: contexts.normal.createImageData(size, size),
    ao: contexts.ao.createImageData(size, size),
  };
  const seed = hashString(id);
  const bands = surfaceBands(spec);
  const heightField = new Float32Array(size * size);
  const roughnessField = new Float32Array(size * size);
  const palette = materialPalette(spec);
  const fallback = typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F';
  const colors = (palette.length >= 2 ? palette : [fallback, '#6E614B', '#A08F70']).map(hexToRgb);
  const baseRoughness = clamp01(readLayerNumber(spec.roughness, ['base'], 0.76));
  const roughnessVariation = clamp01(readLayerNumber(spec.roughness, ['variation'], 0.18));
  const colorAmplitude = clamp01(readLayerNumber(spec.colorVariation, ['amplitude', 'variation'], 0.18));
  const heightCorrelation = clamp01(readLayerNumber(spec.colorVariation, ['heightCorrelation'], 0.3));
  const colorGradient: ColorGradientSpec | undefined = spec.colorGradient;
  for (let y = 0; y < size; y += 1) {
    const v = y / size;
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const index = y * size + x;
      const height = sampleSurface(u, v, bands, seed + 101);
      const roughNoise = sampleSurface(u, v, bands, seed + 7001);
      const colorNoise = sampleSurface(u, v, bands, seed + 15013);
      heightField[index] = height;
      roughnessField[index] = clamp01(baseRoughness + (roughNoise - 0.5) * roughnessVariation * 2);
      let color: [number, number, number];
      if (colorGradient) {
        // Evidence-derived spatial gradient (Plan 1.3 Workstream C) takes priority
        // over the noise-based palette blend below — it is a measured trend, not a guess.
        color = sampleColorGradient(colorGradient, u, v);
      } else {
        const paletteValue = clamp01(
          0.5 + (colorNoise - 0.5) * colorAmplitude * 2 + (height - 0.5) * heightCorrelation
        );
        color = mixPalette(colors, paletteValue);
      }
      writePixel(images.albedo.data, index * 4, color[0], color[1], color[2]);
    }
  }
  const normalStrength = Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35));
  const aoStrength = clamp01(readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35));
  for (let y = 0; y < size; y += 1) {
    const up = ((y - 1 + size) % size) * size;
    const down = ((y + 1) % size) * size;
    for (let x = 0; x < size; x += 1) {
      const left = (x - 1 + size) % size;
      const right = (x + 1) % size;
      const index = y * size + x;
      const center = heightField[index];
      const dx = (heightField[y * size + right] - heightField[y * size + left]) * normalStrength * 6;
      const dy = (heightField[down + x] - heightField[up + x]) * normalStrength * 6;
      const inverseLength = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const normalX = -dx * inverseLength;
      const normalY = -dy * inverseLength;
      const normalZ = inverseLength;
      const neighborAverage = (
        heightField[y * size + left] + heightField[y * size + right]
        + heightField[up + x] + heightField[down + x]
      ) * 0.25;
      const cavity = Math.max(0, neighborAverage - center);
      const ao = clamp01(1 - aoStrength * (cavity * 12 + (1 - center) * 0.16));
      const offset = index * 4;
      const heightByte = center * 255;
      const roughnessByte = roughnessField[index] * 255;
      writePixel(images.height.data, offset, heightByte, heightByte, heightByte);
      writePixel(images.roughness.data, offset, roughnessByte, roughnessByte, roughnessByte);
      writePixel(
        images.normal.data, offset,
        (normalX * 0.5 + 0.5) * 255,
        (normalY * 0.5 + 0.5) * 255,
        (normalZ * 0.5 + 0.5) * 255,
      );
      writePixel(images.ao.data, offset, ao * 255, ao * 255, ao * 255);
    }
  }
  contexts.albedo.putImageData(images.albedo, 0, 0);
  contexts.roughness.putImageData(images.roughness, 0, 0);
  contexts.height.putImageData(images.height, 0, 0);
  contexts.normal.putImageData(images.normal, 0, 0);
  contexts.ao.putImageData(images.ao, 0, 0);
  return {
    albedo: createMapTexture(canvases.albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createMapTexture(canvases.roughness, THREE.NoColorSpace, spec, options),
    height: createMapTexture(canvases.height, THREE.NoColorSpace, spec, options),
    normal: createMapTexture(canvases.normal, THREE.NoColorSpace, spec, options),
    ao: createMapTexture(canvases.ao, THREE.NoColorSpace, spec, options),
    source: 'procedural',
  };
}

function createSculptMaterial(id: string, spec: SculptMaterialSpec, options: ProceduralModelOptions, denseComponent = false): THREE.MeshPhysicalMaterial {
  // A material that declares -- with evidence -- that its subject carries no texture
  // detail gets NO texture set. Synthesising one anyway is not a harmless default: the
  // branch below then forces color to white and roughness to 1 and reads both from the
  // generated maps, so the authored albedo and the reference-derived roughness are both
  // discarded, and the model gains mottling the reference does not have. Measured on the
  // tuxedo cat, whose black fur rendered as speckled grey-and-white from a palette that
  // only ever described two flat regions.
  const textureless = (spec.textureless as { declared?: boolean } | undefined)?.declared === true;
  const textures = textureless
    ? null
    : makeReferenceTextureSet(spec, options) ?? makeProceduralTextureSet(id, spec, options);
  const material = new THREE.MeshPhysicalMaterial({
    color: textures ? 0xffffff : clampedAlbedoColor(spec),
    roughness: textures ? 1 : clamp01(readLayerNumber(spec.roughness, ['base'], 0.76)),
    metalness: clampPbrMetalness(readLayerNumber(spec.metalness, ['base'], 0.0)),
    clearcoat: clamp01(readLayerNumber(spec.clearcoat, ['base', 'amount'], 0)),
    clearcoatRoughness: clamp01(readLayerNumber(spec.clearcoatRoughness, ['base'], 0.25)),
    transmission: clamp01(readLayerNumber(spec.transmission, ['base', 'amount'], 0)),
    ior: clampPbrIor(readLayerNumber(spec.ior, ['base', 'value'], 1.5)),
    thickness: Math.max(0, readLayerNumber(spec.thickness, ['base', 'amount'], 0)),
    attenuationDistance: Math.max(0.001, readLayerNumber(spec.attenuationDistance, ['base', 'value'], Infinity)),
    attenuationColor: new THREE.Color(typeof spec.attenuationColor === 'string' ? spec.attenuationColor : '#ffffff'),
    sheen: clamp01(readLayerNumber(spec.sheen, ['base', 'amount'], 0)),
    sheenColor: new THREE.Color(typeof spec.sheenColor === 'string' ? spec.sheenColor : '#ffffff'),
    sheenRoughness: clamp01(readLayerNumber(spec.sheenRoughness, ['base'], 1.0)),
    iridescence: clamp01(readLayerNumber(spec.iridescence, ['base', 'amount'], 0)),
    iridescenceIOR: clampPbrIor(readLayerNumber(spec.iridescenceIOR, ['base', 'value'], 1.3)),
    anisotropy: clamp01(readLayerNumber(spec.anisotropy, ['base', 'amount'], 0)),
    anisotropyRotation: readLayerNumber(spec.anisotropy, ['rotation'], 0),
    specularIntensity: clampPbrF0(readLayerNumber(spec.specularF0 ?? spec.f0 ?? spec.specularIntensity, ['base', 'value'], 1.0)),
    specularColor: new THREE.Color(typeof spec.specularColor === 'string' ? spec.specularColor : '#ffffff'),
    emissive: new THREE.Color(typeof spec.emissive === 'string' ? spec.emissive : '#000000'),
    emissiveIntensity: Math.max(0, readLayerNumber(spec.emissiveIntensity, ['base'], 1.0)),
    opacity: clamp01(readLayerNumber(spec.opacity, ['base'], 1)),
    transparent: readLayerNumber(spec.transmission, ['base', 'amount'], 0) > 0 || readLayerNumber(spec.opacity, ['base'], 1) < 1,
    alphaTest: Math.max(0, readLayerNumber(spec.alpha, ['cutoff', 'alphaTest'], 0)),
    wireframe: options.wireframe ?? false,
    side: spec.doubleSided === true ? THREE.DoubleSide : THREE.FrontSide,
    flatShading: spec.flatShading === true,
  });
  if (textures) {
    material.map = textures.albedo;
    material.roughnessMap = textures.roughness;
    material.normalMap = textures.normal;
    material.normalScale.setScalar(Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35)));
    material.aoMap = textures.ao;
    material.aoMap.channel = 0;
    material.aoMapIntensity = readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35);
    const denseMesh = denseComponent || spec.denseMesh === true || spec.geometryDensity === 'dense' || spec.topologyClass === 'dense';
    const bumpScale = Math.max(0, readLayerNumber(spec.bump, ['amplitude', 'strength'], 0));
    const effectiveBumpScale = denseMesh ? Math.max(0.05, bumpScale) : bumpScale;
    if (effectiveBumpScale > 0) {
      material.bumpMap = textures.height;
      material.bumpScale = effectiveBumpScale;
    }
    const displacementScale = Math.max(0, readLayerNumber(spec.displacement, ['amplitude', 'strength'], 0));
    const effectiveDisplacementScale = denseMesh ? Math.max(0.005, displacementScale) : displacementScale;
    if (effectiveDisplacementScale > 0) {
      material.displacementMap = textures.height;
      material.displacementScale = effectiveDisplacementScale;
      material.displacementBias = -effectiveDisplacementScale * 0.5;
    }
  }
  material.envMapIntensity = readLayerNumber(spec, ['envMapIntensity'], 0.8);
  material.userData.sculptMaterial = spec;
  material.userData.proceduralMapsIndependent = true;
  material.userData.pbrConstraints = { albedoRange: [30, 240], binaryMetalness: true, f0Range: [0.02, 1], iorRange: [1, 2.5] };
  material.userData.pbrTextureSource = textures?.source ?? 'flat-fallback';
  material.userData.referencePbr = spec.referencePbr ?? null;
  material.userData.referenceMaterialId = spec.referenceMaterialId ?? spec.materialReference?.profileId ?? null;
  material.userData.materialEvidence = spec.materialEvidence ?? null;
  material.userData.validationViews = spec.materialReference?.validationViews ?? [];
  material.needsUpdate = true;
  return material;
}

type AttachmentEndpoint = {
  start: THREE.Vector3;
  midpoint: THREE.Vector3;
  quaternion: THREE.Quaternion;
  length: number;
  baseRadius: number;
  endRadius: number;
};

function readVector3(value: unknown, fallback: [number, number, number]): THREE.Vector3 {
  if (Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === 'number')) {
    return new THREE.Vector3(value[0], value[1], value[2]);
  }
  return new THREE.Vector3(fallback[0], fallback[1], fallback[2]);
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function makeAttachmentEndpoint(attachment: unknown): AttachmentEndpoint | null {
  if (!attachment || typeof attachment !== 'object') return null;
  const record = attachment as Record<string, unknown>;
  const start = readVector3(record.localStart, [0, 0, 0]);
  const end = readVector3(record.localEnd, [0, 1, 0]);
  const delta = end.clone().sub(start);
  const length = delta.length();
  if (length <= 0.0001) return null;
  const direction = delta.clone().normalize();
  const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
  const baseRadius = Math.max(0.005, readNumber(record.baseRadius, 0.06));
  const endRadius = Math.max(0.003, readNumber(record.endRadius, baseRadius * 0.55));
  return {
    start,
    midpoint: delta.multiplyScalar(0.5),
    quaternion,
    length,
    baseRadius,
    endRadius,
  };
}

// Generated from ObjectSculptSpec target: AI Armor Robot (base form)
// Sculpt build pass: blockout
// This factory is intentionally pass-gated. Finish browser screenshot review before unlocking deeper passes.
export function createBot(options: ProceduralModelOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = "AI Armor Robot (base form)";
  root.userData.reconstructionEvidence = {"itemFamily": null, "subtype": null, "componentAdapter": null, "route": null, "exactnessTier": null, "referenceCamera": {"solved": false, "fovDegrees": 40.0, "aspect": 1.0, "orientation": {"yaw": 0.0, "pitch": 0.0, "roll": 0.0}, "positionHint": [0.0, 0.0, 3.0], "note": "For likeness work, solve the reference camera (forge/stage1_intake/solve_camera_pose.py) so the review render aligns with the photo and the reference can be projected. Confirm by overlay review."}, "approximationNotes": []};
  root.userData.materialPipeline = {};
  root.userData.materialReferenceRegistry = null;

  const materialMap: Record<string, THREE.Material> = {};
  materialMap["hidden"] = createSculptMaterial(
    "hidden",
    {"id": "hidden", "name": "Base material", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#000000", "color": "#000000", "albedo": {"dominant": "#000000", "secondary": ["#000000"]}, "colorVariation": {"palette": ["#000000", "#000000"], "pattern": "flat", "amplitude": 0.05, "heightCorrelation": 0.0}, "roughness": {"base": 1.0, "variation": 0.0}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes.", "opacity": {"base": 0.0}, "textureless": {"declared": true, "evidence": ["Container node only: the root mesh has opacity 0 and no rendered surface, so there is no surface to measure or texture."]}},
    options
  );
  materialMap["armor-pearl-silver"] = createSculptMaterial(
    "armor-pearl-silver",
    {"id": "armor-pearl-silver", "name": "Pearl-silver clear-coated armor", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#9fa3b6", "color": "#9fa3b6", "albedo": {"dominant": "#9fa3b6", "secondary": ["#9496a8", "#b4b8c8"]}, "colorVariation": {"palette": ["#9fa3b6", "#9496a8", "#b4b8c8"], "pattern": "subtle-mottle", "amplitude": 0.04, "heightCorrelation": 0.0}, "roughness": {"base": 0.22, "variation": 0.04}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "clearcoat-sheen", "region": "thigh and chest plates", "change": "low roughness 0.12 + clearcoat 1.0 hotspot band following plate curvature", "strength": 0.7, "evidenceRef": "bot1-zones/zone-r1c1.png", "note": "Metadata only: the generator applies clearcoat to the whole material."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Albedo = median of flat-lit silver regions of the reference (#a7aabc thigh, #c9cdd9 chest, #9f9eb4 shin, averaged). Baked reflections are NOT copied; gloss comes from clearcoat + environment light. Dielectric because this generator snaps metalness to 0/1.", "clearcoat": {"base": 1.0}, "clearcoatRoughness": {"base": 0.03}, "textureless": {"declared": true, "evidence": ["Measured (extract_pbr_evidence.py on the silver-isolated crop, confidence 0.86): heightP90Gradient 0.044 and roughnessVariation 0.076, i.e. no relief or pattern; the remaining value range 0.49 is baked reflection/shading and must not be copied as albedo.", "Reference view: bot1-zones/zone-r1c1.png and zone-r2c2.png show clean uniform clear-coated paint without grain, scratches or wear."]}, "materialEvidence": {"extractor": "forge/stage1_intake/extract_pbr_evidence.py", "confidence": 0.86, "targetThreshold": 0.7, "report": "material-evidence/armor-pearl-silver-report.json", "usedAs": "evidence only", "why": "The extracted maps are masked crops of the whole figure, not tileable surfaces, so loading them as UV textures would smear pieces of the silhouette across every part. The measurements below justify flat albedo instead. Armor shows no relief or pattern (heightP90Gradient 0.044).", "roughnessNote": "The extractor's roughness estimate (~0.68) comes from blur radius, not from specular response; the reference clearly shows glossy clear-coat highlights, so roughness is authored from that visual evidence."}},
    options
  );
  materialMap["trim-gold"] = createSculptMaterial(
    "trim-gold",
    {"id": "trim-gold", "name": "Metallic gold trim", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#b68241", "color": "#b68241", "albedo": {"dominant": "#b68241", "secondary": ["#a8763a", "#c58f4a"]}, "colorVariation": {"palette": ["#b68241", "#a8763a", "#c58f4a"], "pattern": "subtle-mottle", "amplitude": 0.03, "heightCorrelation": 0.0}, "roughness": {"base": 0.3, "variation": 0.04}, "metalness": {"base": 1.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Median of gold-hue pixels in the reference. Metal: needs environment reflections to read as gold.", "textureless": {"declared": true, "evidence": ["Measured (extract_pbr_evidence.py on the gold-isolated crop, confidence 0.725): heightP90Gradient 0.0047 (essentially no relief) and foreground coverage 0.023 (thin seams); the tool itself warns of low high-frequency detail.", "Reference view: bot1-zones/zone-r0c1.png and zone-r1c1.png show gold as thin smooth inlay lines with no pattern."]}, "materialEvidence": {"extractor": "forge/stage1_intake/extract_pbr_evidence.py", "confidence": 0.725, "targetThreshold": 0.7, "report": "material-evidence/trim-gold-report.json", "usedAs": "evidence only", "why": "The extracted maps are masked crops of the whole figure, not tileable surfaces, so loading them as UV textures would smear pieces of the silhouette across every part. The measurements below justify flat albedo instead. Gold is thin smooth seams (heightP90Gradient 0.0047, foreground coverage 2.3%).", "roughnessNote": "The extractor's roughness estimate (~0.68) comes from blur radius, not from specular response; the reference clearly shows glossy clear-coat highlights, so roughness is authored from that visual evidence."}},
    options
  );
  materialMap["joint-black"] = createSculptMaterial(
    "joint-black",
    {"id": "joint-black", "name": "Glossy black polymer joints", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#141317", "color": "#141317", "albedo": {"dominant": "#141317", "secondary": ["#0e0d11", "#1b1a20"]}, "colorVariation": {"palette": ["#141317", "#0e0d11", "#1b1a20"], "pattern": "subtle-mottle", "amplitude": 0.02, "heightCorrelation": 0.0}, "roughness": {"base": 0.3, "variation": 0.04}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Median of the black abdomen/joint pixels (#141317; hands #150f0e).", "clearcoat": {"base": 0.5}, "clearcoatRoughness": {"base": 0.1}, "textureless": {"declared": true, "evidence": ["Measured (extract_pbr_evidence.py on the black-isolated crop, confidence 0.831): value range only 0.144 and heightP90Gradient 0.056; the tool warns that the low value range weakens height/roughness inference, i.e. there is no texture to recover.", "Reference view: bot1-zones/zone-r1c1.png (abdomen core) and zone-r1c0.png (hand) show smooth glossy black."]}, "materialEvidence": {"extractor": "forge/stage1_intake/extract_pbr_evidence.py", "confidence": 0.831, "targetThreshold": 0.7, "report": "material-evidence/joint-black-report.json", "usedAs": "evidence only", "why": "The extracted maps are masked crops of the whole figure, not tileable surfaces, so loading them as UV textures would smear pieces of the silhouette across every part. The measurements below justify flat albedo instead. Black is smooth glossy polymer (value range 0.144).", "roughnessNote": "The extractor's roughness estimate (~0.68) comes from blur radius, not from specular response; the reference clearly shows glossy clear-coat highlights, so roughness is authored from that visual evidence."}},
    options
  );
  materialMap["emissive-blue"] = createSculptMaterial(
    "emissive-blue",
    {"id": "emissive-blue", "name": "Emissive cyan-blue accents", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#1b80f3", "color": "#1b80f3", "albedo": {"dominant": "#1b80f3", "secondary": ["#1b80f3"]}, "colorVariation": {"palette": ["#1b80f3"], "pattern": "flat", "amplitude": 0.0, "heightCorrelation": 0.0}, "roughness": {"base": 0.45, "variation": 0.04}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "bloom-core", "region": "all emissive accents", "change": "emissiveIntensity 2.6, intended to bloom", "strength": 1.0, "evidenceRef": "bot1-zones/zone-r0c1.png", "note": "Metadata only."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Every glow is a dedicated small component using this material (the generator does not read localOverrides).", "emissive": "#1b80f3", "emissiveIntensity": {"base": 2.6}, "textureless": {"declared": true, "evidence": ["Measured: median of the brightest blue pixels in bot1_base.png is #1b80f3 with low spread (a single flat emissive hue).", "Reference view: bot1-zones/zone-r0c1.png (visor slit and emblem ring) shows uniform glow with no grain or pattern."]}},
    options
  );
  materialMap["emblem-dark-blue"] = createSculptMaterial(
    "emblem-dark-blue",
    {"id": "emblem-dark-blue", "name": "Dark-blue emblem disc", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#0d3582", "color": "#0d3582", "albedo": {"dominant": "#0d3582", "secondary": ["#0d3582"]}, "colorVariation": {"palette": ["#0d3582"], "pattern": "flat", "amplitude": 0.0, "heightCorrelation": 0.0}, "roughness": {"base": 0.2, "variation": 0.04}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Disc behind the AI lettering.", "clearcoat": {"base": 1.0}, "clearcoatRoughness": {"base": 0.05}, "textureless": {"declared": true, "evidence": ["Measured: median of the emblem-disc pixels in bot1_base.png is #0d3582, a flat dark blue.", "Reference view: bot1-zones/zone-r0c1.png shows a plain disc; the lettering is separate geometry."]}},
    options
  );
  materialMap["emblem-white"] = createSculptMaterial(
    "emblem-white",
    {"id": "emblem-white", "name": "Emblem white lettering", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#f3f9fc", "color": "#f3f9fc", "albedo": {"dominant": "#f3f9fc", "secondary": ["#f3f9fc"]}, "colorVariation": {"palette": ["#f3f9fc"], "pattern": "flat", "amplitude": 0.0, "heightCorrelation": 0.0}, "roughness": {"base": 0.3, "variation": 0.04}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "A and I letter plates.", "emissive": "#cfe3ff", "emissiveIntensity": {"base": 0.9}, "textureless": {"declared": true, "evidence": ["Measured: median of the lettering pixels in bot1_base.png is #f3f9fc, a flat near-white.", "Reference view: bot1-zones/zone-r0c1.png shows solid white letters; the letters are real extruded geometry."]}},
    options
  );

  const nodes: Record<string, THREE.Object3D> = { root };
  const meshes: Record<string, THREE.Mesh> = {};
  const sockets: Record<string, THREE.Object3D> = {};
  const colliders: Record<string, unknown> = {};
  const destructionGroups: Record<string, THREE.Object3D[]> = {};

  const endpoint_root_0 = makeAttachmentEndpoint(null);
  const node_root_0 = new THREE.Group();
  node_root_0.name = "AI Armor Robot (root)__pivot";
  node_root_0.scale.set(1, 1, 1);
  if (endpoint_root_0) {
    node_root_0.position.copy(endpoint_root_0.start);
    node_root_0.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_root_0.position.set(0.0, 0.0, 0.0);
    node_root_0.rotation.set(0.0, 0.0, 0.0);
  }
  node_root_0.userData.sculptComponent = { id: "root" };
  node_root_0.userData.actionProfile = {};
  (nodes["root"] ?? root).add(node_root_0);
  nodes["root"] = node_root_0;
  const mesh_root_0Geometry = endpoint_root_0
    ? new THREE.CylinderGeometry(endpoint_root_0.endRadius, endpoint_root_0.baseRadius, endpoint_root_0.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_root_0) {
    mesh_root_0Geometry.scale(0.001, 0.001, 0.001);
  }
  const mesh_root_0 = new THREE.Mesh(
    mesh_root_0Geometry,
    materialMap["hidden"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_root_0.name = "AI Armor Robot (root)";
  if (endpoint_root_0) {
    mesh_root_0.position.copy(endpoint_root_0.midpoint);
    mesh_root_0.quaternion.copy(endpoint_root_0.quaternion);
  }
  mesh_root_0.castShadow = options.castShadow ?? true;
  mesh_root_0.receiveShadow = options.receiveShadow ?? true;
  mesh_root_0.userData.sculptComponent = { id: "root" };
  node_root_0.add(mesh_root_0);
  meshes["root"] = mesh_root_0;
  colliders["root"] = {};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_root_0);

  const endpoint_pelvis_1 = makeAttachmentEndpoint(null);
  const node_pelvis_1 = new THREE.Group();
  node_pelvis_1.name = "Pelvis core__pivot";
  node_pelvis_1.scale.set(1, 1, 1);
  if (endpoint_pelvis_1) {
    node_pelvis_1.position.copy(endpoint_pelvis_1.start);
    node_pelvis_1.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_pelvis_1.position.set(0.0, 1.04567, 0.0);
    node_pelvis_1.rotation.set(0.0, 0.0, 0.0);
  }
  node_pelvis_1.userData.sculptComponent = { id: "pelvis" };
  node_pelvis_1.userData.actionProfile = {};
  (nodes["root"] ?? root).add(node_pelvis_1);
  nodes["pelvis"] = node_pelvis_1;
  const mesh_pelvis_1Geometry = endpoint_pelvis_1
    ? new THREE.CylinderGeometry(endpoint_pelvis_1.endRadius, endpoint_pelvis_1.baseRadius, endpoint_pelvis_1.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_pelvis_1) {
    mesh_pelvis_1Geometry.scale(0.32756, 0.31496, 0.20787);
  }
  const mesh_pelvis_1 = new THREE.Mesh(
    mesh_pelvis_1Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pelvis_1.name = "Pelvis core";
  if (endpoint_pelvis_1) {
    mesh_pelvis_1.position.copy(endpoint_pelvis_1.midpoint);
    mesh_pelvis_1.quaternion.copy(endpoint_pelvis_1.quaternion);
  }
  mesh_pelvis_1.castShadow = options.castShadow ?? true;
  mesh_pelvis_1.receiveShadow = options.receiveShadow ?? true;
  mesh_pelvis_1.userData.sculptComponent = { id: "pelvis" };
  node_pelvis_1.add(mesh_pelvis_1);
  meshes["pelvis"] = mesh_pelvis_1;
  colliders["pelvis"] = {};
  destructionGroups["pelvis"] ??= [];
  destructionGroups["pelvis"].push(node_pelvis_1);

  const attachment_abdomen_2 = {"parentSocket": "pelvis-abdomen", "localStart": [0.0, 0.11969, 0.0], "localEnd": [0.0, 0.25827, 0.0063], "contactType": "rigid-weld", "baseRadius": 0.09764, "endRadius": 0.10394, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_abdomen_2 = makeAttachmentEndpoint(attachment_abdomen_2);
  const node_abdomen_2 = new THREE.Group();
  node_abdomen_2.name = "Abdomen core__pivot";
  node_abdomen_2.scale.set(1, 1, 1);
  if (endpoint_abdomen_2) {
    node_abdomen_2.position.copy(endpoint_abdomen_2.start);
    node_abdomen_2.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_abdomen_2.position.set(0.0, 0.11969, 0.0);
    node_abdomen_2.rotation.set(0.0, 0.0, 0.0);
  }
  node_abdomen_2.userData.sculptComponent = { id: "abdomen" };
  node_abdomen_2.userData.actionProfile = {};
  (nodes["pelvis"] ?? root).add(node_abdomen_2);
  nodes["abdomen"] = node_abdomen_2;
  const mesh_abdomen_2Geometry = endpoint_abdomen_2
    ? new THREE.CylinderGeometry(endpoint_abdomen_2.endRadius, endpoint_abdomen_2.baseRadius, endpoint_abdomen_2.length, 16, 6)
    : buildWatertightCapsule(0.35, 0.7, 8, 16, 1);
  if (!endpoint_abdomen_2) {
    mesh_abdomen_2Geometry.scale(0.19528, 0.13873, 0.19528);
  }
  const mesh_abdomen_2 = new THREE.Mesh(
    mesh_abdomen_2Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_abdomen_2.name = "Abdomen core";
  if (endpoint_abdomen_2) {
    mesh_abdomen_2.position.copy(endpoint_abdomen_2.midpoint);
    mesh_abdomen_2.quaternion.copy(endpoint_abdomen_2.quaternion);
  }
  mesh_abdomen_2.castShadow = options.castShadow ?? true;
  mesh_abdomen_2.receiveShadow = options.receiveShadow ?? true;
  mesh_abdomen_2.userData.sculptComponent = { id: "abdomen" };
  node_abdomen_2.add(mesh_abdomen_2);
  meshes["abdomen"] = mesh_abdomen_2;
  colliders["abdomen"] = {};
  destructionGroups["torso"] ??= [];
  destructionGroups["torso"].push(node_abdomen_2);

  const attachment_chest_3 = {"parentSocket": "abdomen-chest", "localStart": [0.0, 0.13858, 0.0063], "localEnd": [0.0, 0.42205, 0.0126], "contactType": "rigid-weld", "baseRadius": 0.11339, "endRadius": 0.15118, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_chest_3 = makeAttachmentEndpoint(attachment_chest_3);
  const node_chest_3 = new THREE.Group();
  node_chest_3.name = "Chest core__pivot";
  node_chest_3.scale.set(1, 1, 1);
  if (endpoint_chest_3) {
    node_chest_3.position.copy(endpoint_chest_3.start);
    node_chest_3.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_chest_3.position.set(0.0, 0.13858, 0.0063);
    node_chest_3.rotation.set(0.0, 0.0, 0.0);
  }
  node_chest_3.userData.sculptComponent = { id: "chest" };
  node_chest_3.userData.actionProfile = {};
  (nodes["abdomen"] ?? root).add(node_chest_3);
  nodes["chest"] = node_chest_3;
  const mesh_chest_3Geometry = endpoint_chest_3
    ? new THREE.CylinderGeometry(endpoint_chest_3.endRadius, endpoint_chest_3.baseRadius, endpoint_chest_3.length, 16, 6)
    : buildWatertightCapsule(0.35, 0.7, 8, 16, 1);
  if (!endpoint_chest_3) {
    mesh_chest_3Geometry.scale(0.22677, 0.28353, 0.22677);
  }
  const mesh_chest_3 = new THREE.Mesh(
    mesh_chest_3Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_chest_3.name = "Chest core";
  if (endpoint_chest_3) {
    mesh_chest_3.position.copy(endpoint_chest_3.midpoint);
    mesh_chest_3.quaternion.copy(endpoint_chest_3.quaternion);
  }
  mesh_chest_3.castShadow = options.castShadow ?? true;
  mesh_chest_3.receiveShadow = options.receiveShadow ?? true;
  mesh_chest_3.userData.sculptComponent = { id: "chest" };
  node_chest_3.add(mesh_chest_3);
  meshes["chest"] = mesh_chest_3;
  colliders["chest"] = {};
  destructionGroups["torso"] ??= [];
  destructionGroups["torso"].push(node_chest_3);

  const attachment_neck_4 = {"parentSocket": "chest-neck", "localStart": [0.0, 0.28346, 0.0063], "localEnd": [0.0, 0.35276, 0.0063], "contactType": "rigid-weld", "baseRadius": 0.05984, "endRadius": 0.05039, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_neck_4 = makeAttachmentEndpoint(attachment_neck_4);
  const node_neck_4 = new THREE.Group();
  node_neck_4.name = "Neck__pivot";
  node_neck_4.scale.set(1, 1, 1);
  if (endpoint_neck_4) {
    node_neck_4.position.copy(endpoint_neck_4.start);
    node_neck_4.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_neck_4.position.set(0.0, 0.28346, 0.0063);
    node_neck_4.rotation.set(0.0, 0.0, 0.0);
  }
  node_neck_4.userData.sculptComponent = { id: "neck" };
  node_neck_4.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_neck_4);
  nodes["neck"] = node_neck_4;
  const mesh_neck_4Geometry = endpoint_neck_4
    ? new THREE.CylinderGeometry(endpoint_neck_4.endRadius, endpoint_neck_4.baseRadius, endpoint_neck_4.length, 16, 6)
    : buildWatertightCapsule(0.35, 0.7, 8, 16, 1);
  if (!endpoint_neck_4) {
    mesh_neck_4Geometry.scale(0.11969, 0.06929, 0.11969);
  }
  const mesh_neck_4 = new THREE.Mesh(
    mesh_neck_4Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_neck_4.name = "Neck";
  if (endpoint_neck_4) {
    mesh_neck_4.position.copy(endpoint_neck_4.midpoint);
    mesh_neck_4.quaternion.copy(endpoint_neck_4.quaternion);
  }
  mesh_neck_4.castShadow = options.castShadow ?? true;
  mesh_neck_4.receiveShadow = options.receiveShadow ?? true;
  mesh_neck_4.userData.sculptComponent = { id: "neck" };
  node_neck_4.add(mesh_neck_4);
  meshes["neck"] = mesh_neck_4;
  colliders["neck"] = {};
  destructionGroups["head"] ??= [];
  destructionGroups["head"].push(node_neck_4);

  const endpoint_head_5 = makeAttachmentEndpoint(null);
  const node_head_5 = new THREE.Group();
  node_head_5.name = "Helmet__pivot";
  node_head_5.scale.set(1, 1, 1);
  if (endpoint_head_5) {
    node_head_5.position.copy(endpoint_head_5.start);
    node_head_5.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_head_5.position.set(0.0, 0.07559, 0.0);
    node_head_5.rotation.set(0.0, 0.0, 0.0);
  }
  node_head_5.userData.sculptComponent = { id: "head" };
  node_head_5.userData.actionProfile = {};
  (nodes["neck"] ?? root).add(node_head_5);
  nodes["head"] = node_head_5;
  const mesh_head_5Geometry = endpoint_head_5
    ? new THREE.CylinderGeometry(endpoint_head_5.endRadius, endpoint_head_5.baseRadius, endpoint_head_5.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.05039, "rz": 0.04409, "twist": 0.0}, {"position": [0.0, 0.0378, 0.0], "rx": 0.08189, "rz": 0.08189, "twist": 0.0}, {"position": [0.0, 0.08819, 0.0], "rx": 0.11969, "rz": 0.11969, "twist": 0.0}, {"position": [0.0, 0.15118, 0.0], "rx": 0.13858, "rz": 0.14488, "twist": 0.0}, {"position": [0.0, 0.21417, 0.0], "rx": 0.12598, "rz": 0.13228, "twist": 0.0}, {"position": [0.0, 0.25197, 0.0], "rx": 0.09449, "rz": 0.09449, "twist": 0.0}, {"position": [0.0, 0.27402, 0.0], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 24, "capEnds": true});
  if (!endpoint_head_5) {
    mesh_head_5Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_head_5 = new THREE.Mesh(
    mesh_head_5Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_head_5.name = "Helmet";
  if (endpoint_head_5) {
    mesh_head_5.position.copy(endpoint_head_5.midpoint);
    mesh_head_5.quaternion.copy(endpoint_head_5.quaternion);
  }
  mesh_head_5.castShadow = options.castShadow ?? true;
  mesh_head_5.receiveShadow = options.receiveShadow ?? true;
  mesh_head_5.userData.sculptComponent = { id: "head" };
  node_head_5.add(mesh_head_5);
  meshes["head"] = mesh_head_5;
  colliders["head"] = {};
  destructionGroups["head"] ??= [];
  destructionGroups["head"].push(node_head_5);

  const endpoint_visor_6 = makeAttachmentEndpoint(null);
  const node_visor_6 = new THREE.Group();
  node_visor_6.name = "Visor plate__pivot";
  node_visor_6.scale.set(1, 1, 1);
  if (endpoint_visor_6) {
    node_visor_6.position.copy(endpoint_visor_6.start);
    node_visor_6.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_visor_6.position.set(0.0, 0.0315, 0.07559);
    node_visor_6.rotation.set(0.0, 0.0, 0.0);
  }
  node_visor_6.userData.sculptComponent = { id: "visor" };
  node_visor_6.userData.actionProfile = {};
  (nodes["head"] ?? root).add(node_visor_6);
  nodes["visor"] = node_visor_6;
  const mesh_visor_6Geometry = endpoint_visor_6
    ? new THREE.CylinderGeometry(endpoint_visor_6.endRadius, endpoint_visor_6.baseRadius, endpoint_visor_6.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.01575, "rz": 0.0315, "twist": 0.0}, {"position": [0.0, 0.0315, 0.02835], "rx": 0.01575, "rz": 0.06299, "twist": 0.0}, {"position": [0.0, 0.08819, 0.05354], "rx": 0.01575, "rz": 0.09449, "twist": 0.0}, {"position": [0.0, 0.13228, 0.05669], "rx": 0.01575, "rz": 0.09449, "twist": 0.0}, {"position": [0.0, 0.15118, 0.05039], "rx": 0.0126, "rz": 0.0378, "twist": 0.0}], "radialSegments": 20, "capEnds": true});
  if (!endpoint_visor_6) {
    mesh_visor_6Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_visor_6 = new THREE.Mesh(
    mesh_visor_6Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_visor_6.name = "Visor plate";
  if (endpoint_visor_6) {
    mesh_visor_6.position.copy(endpoint_visor_6.midpoint);
    mesh_visor_6.quaternion.copy(endpoint_visor_6.quaternion);
  }
  mesh_visor_6.castShadow = options.castShadow ?? true;
  mesh_visor_6.receiveShadow = options.receiveShadow ?? true;
  mesh_visor_6.userData.sculptComponent = { id: "visor" };
  node_visor_6.add(mesh_visor_6);
  meshes["visor"] = mesh_visor_6;
  colliders["visor"] = {};
  destructionGroups["head"] ??= [];
  destructionGroups["head"].push(node_visor_6);

  const endpoint_visor_slit_7 = makeAttachmentEndpoint(null);
  const node_visor_slit_7 = new THREE.Group();
  node_visor_slit_7.name = "Visor slit glow__pivot";
  node_visor_slit_7.scale.set(1, 1, 1);
  if (endpoint_visor_slit_7) {
    node_visor_slit_7.position.copy(endpoint_visor_slit_7.start);
    node_visor_slit_7.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_visor_slit_7.position.set(0.0, 0.13858, 0.14173);
    node_visor_slit_7.rotation.set(0.0, 0.0, 0.0);
  }
  node_visor_slit_7.userData.sculptComponent = { id: "visor-slit" };
  node_visor_slit_7.userData.actionProfile = {};
  (nodes["head"] ?? root).add(node_visor_slit_7);
  nodes["visor-slit"] = node_visor_slit_7;
  const mesh_visor_slit_7Geometry = endpoint_visor_slit_7
    ? new THREE.CylinderGeometry(endpoint_visor_slit_7.endRadius, endpoint_visor_slit_7.baseRadius, endpoint_visor_slit_7.length, 16, 6)
    : buildExtrudeGeometry({"points": [[-0.09449, 0.0252], [-0.06929, 0.0315], [0.0, -0.0189], [0.06929, 0.0315], [0.09449, 0.0252], [0.0, -0.05039]], "depth": 0.0126});
  if (!endpoint_visor_slit_7) {
    mesh_visor_slit_7Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_visor_slit_7 = new THREE.Mesh(
    mesh_visor_slit_7Geometry,
    materialMap["emissive-blue"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_visor_slit_7.name = "Visor slit glow";
  if (endpoint_visor_slit_7) {
    mesh_visor_slit_7.position.copy(endpoint_visor_slit_7.midpoint);
    mesh_visor_slit_7.quaternion.copy(endpoint_visor_slit_7.quaternion);
  }
  mesh_visor_slit_7.castShadow = options.castShadow ?? true;
  mesh_visor_slit_7.receiveShadow = options.receiveShadow ?? true;
  mesh_visor_slit_7.userData.sculptComponent = { id: "visor-slit" };
  node_visor_slit_7.add(mesh_visor_slit_7);
  meshes["visor-slit"] = mesh_visor_slit_7;
  colliders["visor-slit"] = {};
  destructionGroups["head"] ??= [];
  destructionGroups["head"].push(node_visor_slit_7);

  const attachment_ear_pod_l_8 = {"parentSocket": "head-ear-pod-l", "localStart": [0.10394, 0.14488, 0.0], "localEnd": [0.13543, 0.14488, 0.0], "contactType": "rigid-weld", "baseRadius": 0.02835, "endRadius": 0.02835, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_ear_pod_l_8 = makeAttachmentEndpoint(attachment_ear_pod_l_8);
  const node_ear_pod_l_8 = new THREE.Group();
  node_ear_pod_l_8.name = "Ear pod L__pivot";
  node_ear_pod_l_8.scale.set(1, 1, 1);
  if (endpoint_ear_pod_l_8) {
    node_ear_pod_l_8.position.copy(endpoint_ear_pod_l_8.start);
    node_ear_pod_l_8.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_ear_pod_l_8.position.set(0.10394, 0.14488, 0.0);
    node_ear_pod_l_8.rotation.set(0.0, 0.0, 0.0);
  }
  node_ear_pod_l_8.userData.sculptComponent = { id: "ear-pod-l" };
  node_ear_pod_l_8.userData.actionProfile = {};
  (nodes["head"] ?? root).add(node_ear_pod_l_8);
  nodes["ear-pod-l"] = node_ear_pod_l_8;
  const mesh_ear_pod_l_8Geometry = endpoint_ear_pod_l_8
    ? new THREE.CylinderGeometry(endpoint_ear_pod_l_8.endRadius, endpoint_ear_pod_l_8.baseRadius, endpoint_ear_pod_l_8.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_ear_pod_l_8) {
    mesh_ear_pod_l_8Geometry.scale(0.05669, 0.0315, 0.05669);
  }
  const mesh_ear_pod_l_8 = new THREE.Mesh(
    mesh_ear_pod_l_8Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ear_pod_l_8.name = "Ear pod L";
  if (endpoint_ear_pod_l_8) {
    mesh_ear_pod_l_8.position.copy(endpoint_ear_pod_l_8.midpoint);
    mesh_ear_pod_l_8.quaternion.copy(endpoint_ear_pod_l_8.quaternion);
  }
  mesh_ear_pod_l_8.castShadow = options.castShadow ?? true;
  mesh_ear_pod_l_8.receiveShadow = options.receiveShadow ?? true;
  mesh_ear_pod_l_8.userData.sculptComponent = { id: "ear-pod-l" };
  node_ear_pod_l_8.add(mesh_ear_pod_l_8);
  meshes["ear-pod-l"] = mesh_ear_pod_l_8;
  colliders["ear-pod-l"] = {};
  destructionGroups["head"] ??= [];
  destructionGroups["head"].push(node_ear_pod_l_8);

  const endpoint_ear_pod_ring_l_9 = makeAttachmentEndpoint(null);
  const node_ear_pod_ring_l_9 = new THREE.Group();
  node_ear_pod_ring_l_9.name = "Ear pod ring L__pivot";
  node_ear_pod_ring_l_9.scale.set(1, 1, 1);
  if (endpoint_ear_pod_ring_l_9) {
    node_ear_pod_ring_l_9.position.copy(endpoint_ear_pod_ring_l_9.start);
    node_ear_pod_ring_l_9.rotation.set(0.0, 1.5708, 0.0);
  } else {
    node_ear_pod_ring_l_9.position.set(0.13701, 0.14488, 0.0);
    node_ear_pod_ring_l_9.rotation.set(0.0, 1.5708, 0.0);
  }
  node_ear_pod_ring_l_9.userData.sculptComponent = { id: "ear-pod-ring-l" };
  node_ear_pod_ring_l_9.userData.actionProfile = {};
  (nodes["head"] ?? root).add(node_ear_pod_ring_l_9);
  nodes["ear-pod-ring-l"] = node_ear_pod_ring_l_9;
  const mesh_ear_pod_ring_l_9Geometry = endpoint_ear_pod_ring_l_9
    ? new THREE.CylinderGeometry(endpoint_ear_pod_ring_l_9.endRadius, endpoint_ear_pod_ring_l_9.baseRadius, endpoint_ear_pod_ring_l_9.length, 16, 6)
    : new THREE.TorusGeometry(0.45, 0.09, 12, 48);
  if (!endpoint_ear_pod_ring_l_9) {
    mesh_ear_pod_ring_l_9Geometry.scale(0.06299, 0.06299, 0.06299);
  }
  const mesh_ear_pod_ring_l_9 = new THREE.Mesh(
    mesh_ear_pod_ring_l_9Geometry,
    materialMap["emissive-blue"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ear_pod_ring_l_9.name = "Ear pod ring L";
  if (endpoint_ear_pod_ring_l_9) {
    mesh_ear_pod_ring_l_9.position.copy(endpoint_ear_pod_ring_l_9.midpoint);
    mesh_ear_pod_ring_l_9.quaternion.copy(endpoint_ear_pod_ring_l_9.quaternion);
  }
  mesh_ear_pod_ring_l_9.castShadow = options.castShadow ?? true;
  mesh_ear_pod_ring_l_9.receiveShadow = options.receiveShadow ?? true;
  mesh_ear_pod_ring_l_9.userData.sculptComponent = { id: "ear-pod-ring-l" };
  node_ear_pod_ring_l_9.add(mesh_ear_pod_ring_l_9);
  meshes["ear-pod-ring-l"] = mesh_ear_pod_ring_l_9;
  colliders["ear-pod-ring-l"] = {};
  destructionGroups["head"] ??= [];
  destructionGroups["head"].push(node_ear_pod_ring_l_9);

  const endpoint_horn_fin_l_10 = makeAttachmentEndpoint(null);
  const node_horn_fin_l_10 = new THREE.Group();
  node_horn_fin_l_10.name = "Horn fin L__pivot";
  node_horn_fin_l_10.scale.set(1, 1, 1);
  if (endpoint_horn_fin_l_10) {
    node_horn_fin_l_10.position.copy(endpoint_horn_fin_l_10.start);
    node_horn_fin_l_10.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_horn_fin_l_10.position.set(0.13858, 0.19528, -0.0189);
    node_horn_fin_l_10.rotation.set(0.0, 0.0, 0.0);
  }
  node_horn_fin_l_10.userData.sculptComponent = { id: "horn-fin-l" };
  node_horn_fin_l_10.userData.actionProfile = {};
  (nodes["head"] ?? root).add(node_horn_fin_l_10);
  nodes["horn-fin-l"] = node_horn_fin_l_10;
  const mesh_horn_fin_l_10Geometry = endpoint_horn_fin_l_10
    ? new THREE.CylinderGeometry(endpoint_horn_fin_l_10.endRadius, endpoint_horn_fin_l_10.baseRadius, endpoint_horn_fin_l_10.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.01575, "rz": 0.0189, "twist": 0.0}, {"position": [0.00315, 0.05354, -0.0126], "rx": 0.01197, "rz": 0.01417, "twist": 0.0}, {"position": [0.0063, 0.09764, -0.0252], "rx": 0.0063, "rz": 0.00787, "twist": 0.0}, {"position": [0.00787, 0.11969, -0.0315], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 14, "capEnds": true});
  if (!endpoint_horn_fin_l_10) {
    mesh_horn_fin_l_10Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_horn_fin_l_10 = new THREE.Mesh(
    mesh_horn_fin_l_10Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_horn_fin_l_10.name = "Horn fin L";
  if (endpoint_horn_fin_l_10) {
    mesh_horn_fin_l_10.position.copy(endpoint_horn_fin_l_10.midpoint);
    mesh_horn_fin_l_10.quaternion.copy(endpoint_horn_fin_l_10.quaternion);
  }
  mesh_horn_fin_l_10.castShadow = options.castShadow ?? true;
  mesh_horn_fin_l_10.receiveShadow = options.receiveShadow ?? true;
  mesh_horn_fin_l_10.userData.sculptComponent = { id: "horn-fin-l" };
  node_horn_fin_l_10.add(mesh_horn_fin_l_10);
  meshes["horn-fin-l"] = mesh_horn_fin_l_10;
  colliders["horn-fin-l"] = {};
  destructionGroups["head"] ??= [];
  destructionGroups["head"].push(node_horn_fin_l_10);

  const attachment_ear_pod_r_11 = {"parentSocket": "head-ear-pod-r", "localStart": [-0.10394, 0.14488, 0.0], "localEnd": [-0.13543, 0.14488, 0.0], "contactType": "rigid-weld", "baseRadius": 0.02835, "endRadius": 0.02835, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_ear_pod_r_11 = makeAttachmentEndpoint(attachment_ear_pod_r_11);
  const node_ear_pod_r_11 = new THREE.Group();
  node_ear_pod_r_11.name = "Ear pod R__pivot";
  node_ear_pod_r_11.scale.set(1, 1, 1);
  if (endpoint_ear_pod_r_11) {
    node_ear_pod_r_11.position.copy(endpoint_ear_pod_r_11.start);
    node_ear_pod_r_11.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_ear_pod_r_11.position.set(-0.10394, 0.14488, 0.0);
    node_ear_pod_r_11.rotation.set(0.0, 0.0, 0.0);
  }
  node_ear_pod_r_11.userData.sculptComponent = { id: "ear-pod-r" };
  node_ear_pod_r_11.userData.actionProfile = {};
  (nodes["head"] ?? root).add(node_ear_pod_r_11);
  nodes["ear-pod-r"] = node_ear_pod_r_11;
  const mesh_ear_pod_r_11Geometry = endpoint_ear_pod_r_11
    ? new THREE.CylinderGeometry(endpoint_ear_pod_r_11.endRadius, endpoint_ear_pod_r_11.baseRadius, endpoint_ear_pod_r_11.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_ear_pod_r_11) {
    mesh_ear_pod_r_11Geometry.scale(0.05669, 0.0315, 0.05669);
  }
  const mesh_ear_pod_r_11 = new THREE.Mesh(
    mesh_ear_pod_r_11Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ear_pod_r_11.name = "Ear pod R";
  if (endpoint_ear_pod_r_11) {
    mesh_ear_pod_r_11.position.copy(endpoint_ear_pod_r_11.midpoint);
    mesh_ear_pod_r_11.quaternion.copy(endpoint_ear_pod_r_11.quaternion);
  }
  mesh_ear_pod_r_11.castShadow = options.castShadow ?? true;
  mesh_ear_pod_r_11.receiveShadow = options.receiveShadow ?? true;
  mesh_ear_pod_r_11.userData.sculptComponent = { id: "ear-pod-r" };
  node_ear_pod_r_11.add(mesh_ear_pod_r_11);
  meshes["ear-pod-r"] = mesh_ear_pod_r_11;
  colliders["ear-pod-r"] = {};
  destructionGroups["head"] ??= [];
  destructionGroups["head"].push(node_ear_pod_r_11);

  const endpoint_ear_pod_ring_r_12 = makeAttachmentEndpoint(null);
  const node_ear_pod_ring_r_12 = new THREE.Group();
  node_ear_pod_ring_r_12.name = "Ear pod ring R__pivot";
  node_ear_pod_ring_r_12.scale.set(1, 1, 1);
  if (endpoint_ear_pod_ring_r_12) {
    node_ear_pod_ring_r_12.position.copy(endpoint_ear_pod_ring_r_12.start);
    node_ear_pod_ring_r_12.rotation.set(0.0, 1.5708, 0.0);
  } else {
    node_ear_pod_ring_r_12.position.set(-0.13701, 0.14488, 0.0);
    node_ear_pod_ring_r_12.rotation.set(0.0, 1.5708, 0.0);
  }
  node_ear_pod_ring_r_12.userData.sculptComponent = { id: "ear-pod-ring-r" };
  node_ear_pod_ring_r_12.userData.actionProfile = {};
  (nodes["head"] ?? root).add(node_ear_pod_ring_r_12);
  nodes["ear-pod-ring-r"] = node_ear_pod_ring_r_12;
  const mesh_ear_pod_ring_r_12Geometry = endpoint_ear_pod_ring_r_12
    ? new THREE.CylinderGeometry(endpoint_ear_pod_ring_r_12.endRadius, endpoint_ear_pod_ring_r_12.baseRadius, endpoint_ear_pod_ring_r_12.length, 16, 6)
    : new THREE.TorusGeometry(0.45, 0.09, 12, 48);
  if (!endpoint_ear_pod_ring_r_12) {
    mesh_ear_pod_ring_r_12Geometry.scale(0.06299, 0.06299, 0.06299);
  }
  const mesh_ear_pod_ring_r_12 = new THREE.Mesh(
    mesh_ear_pod_ring_r_12Geometry,
    materialMap["emissive-blue"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ear_pod_ring_r_12.name = "Ear pod ring R";
  if (endpoint_ear_pod_ring_r_12) {
    mesh_ear_pod_ring_r_12.position.copy(endpoint_ear_pod_ring_r_12.midpoint);
    mesh_ear_pod_ring_r_12.quaternion.copy(endpoint_ear_pod_ring_r_12.quaternion);
  }
  mesh_ear_pod_ring_r_12.castShadow = options.castShadow ?? true;
  mesh_ear_pod_ring_r_12.receiveShadow = options.receiveShadow ?? true;
  mesh_ear_pod_ring_r_12.userData.sculptComponent = { id: "ear-pod-ring-r" };
  node_ear_pod_ring_r_12.add(mesh_ear_pod_ring_r_12);
  meshes["ear-pod-ring-r"] = mesh_ear_pod_ring_r_12;
  colliders["ear-pod-ring-r"] = {};
  destructionGroups["head"] ??= [];
  destructionGroups["head"].push(node_ear_pod_ring_r_12);

  const endpoint_horn_fin_r_13 = makeAttachmentEndpoint(null);
  const node_horn_fin_r_13 = new THREE.Group();
  node_horn_fin_r_13.name = "Horn fin R__pivot";
  node_horn_fin_r_13.scale.set(1, 1, 1);
  if (endpoint_horn_fin_r_13) {
    node_horn_fin_r_13.position.copy(endpoint_horn_fin_r_13.start);
    node_horn_fin_r_13.rotation.set(0.0, -0.0, 0.0);
  } else {
    node_horn_fin_r_13.position.set(-0.13858, 0.19528, -0.0189);
    node_horn_fin_r_13.rotation.set(0.0, -0.0, 0.0);
  }
  node_horn_fin_r_13.userData.sculptComponent = { id: "horn-fin-r" };
  node_horn_fin_r_13.userData.actionProfile = {};
  (nodes["head"] ?? root).add(node_horn_fin_r_13);
  nodes["horn-fin-r"] = node_horn_fin_r_13;
  const mesh_horn_fin_r_13Geometry = endpoint_horn_fin_r_13
    ? new THREE.CylinderGeometry(endpoint_horn_fin_r_13.endRadius, endpoint_horn_fin_r_13.baseRadius, endpoint_horn_fin_r_13.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.01575, "rz": 0.0189, "twist": 0.0}, {"position": [-0.00315, 0.05354, -0.0126], "rx": 0.01197, "rz": 0.01417, "twist": 0.0}, {"position": [-0.0063, 0.09764, -0.0252], "rx": 0.0063, "rz": 0.00787, "twist": 0.0}, {"position": [-0.00787, 0.11969, -0.0315], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 14, "capEnds": true});
  if (!endpoint_horn_fin_r_13) {
    mesh_horn_fin_r_13Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_horn_fin_r_13 = new THREE.Mesh(
    mesh_horn_fin_r_13Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_horn_fin_r_13.name = "Horn fin R";
  if (endpoint_horn_fin_r_13) {
    mesh_horn_fin_r_13.position.copy(endpoint_horn_fin_r_13.midpoint);
    mesh_horn_fin_r_13.quaternion.copy(endpoint_horn_fin_r_13.quaternion);
  }
  mesh_horn_fin_r_13.castShadow = options.castShadow ?? true;
  mesh_horn_fin_r_13.receiveShadow = options.receiveShadow ?? true;
  mesh_horn_fin_r_13.userData.sculptComponent = { id: "horn-fin-r" };
  node_horn_fin_r_13.add(mesh_horn_fin_r_13);
  meshes["horn-fin-r"] = mesh_horn_fin_r_13;
  colliders["horn-fin-r"] = {};
  destructionGroups["head"] ??= [];
  destructionGroups["head"].push(node_horn_fin_r_13);

  const endpoint_chest_shell_l_14 = makeAttachmentEndpoint(null);
  const node_chest_shell_l_14 = new THREE.Group();
  node_chest_shell_l_14.name = "Chest shell L__pivot";
  node_chest_shell_l_14.scale.set(1, 1, 1);
  if (endpoint_chest_shell_l_14) {
    node_chest_shell_l_14.position.copy(endpoint_chest_shell_l_14.start);
    node_chest_shell_l_14.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_chest_shell_l_14.position.set(0.14488, 0.27717, 0.0378);
    node_chest_shell_l_14.rotation.set(0.0, 0.0, 0.0);
  }
  node_chest_shell_l_14.userData.sculptComponent = { id: "chest-shell-l" };
  node_chest_shell_l_14.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_chest_shell_l_14);
  nodes["chest-shell-l"] = node_chest_shell_l_14;
  const mesh_chest_shell_l_14Geometry = endpoint_chest_shell_l_14
    ? new THREE.CylinderGeometry(endpoint_chest_shell_l_14.endRadius, endpoint_chest_shell_l_14.baseRadius, endpoint_chest_shell_l_14.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.04409, "rz": 0.06929, "twist": 0.0}, {"position": [-0.0189, -0.06929, 0.0315], "rx": 0.06299, "rz": 0.08189, "twist": 0.0}, {"position": [-0.05039, -0.17008, 0.04409], "rx": 0.06299, "rz": 0.06929, "twist": 0.0}, {"position": [-0.07559, -0.26457, 0.0378], "rx": 0.0378, "rz": 0.0378, "twist": 0.0}], "radialSegments": 20, "capEnds": true});
  if (!endpoint_chest_shell_l_14) {
    mesh_chest_shell_l_14Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_chest_shell_l_14 = new THREE.Mesh(
    mesh_chest_shell_l_14Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_chest_shell_l_14.name = "Chest shell L";
  if (endpoint_chest_shell_l_14) {
    mesh_chest_shell_l_14.position.copy(endpoint_chest_shell_l_14.midpoint);
    mesh_chest_shell_l_14.quaternion.copy(endpoint_chest_shell_l_14.quaternion);
  }
  mesh_chest_shell_l_14.castShadow = options.castShadow ?? true;
  mesh_chest_shell_l_14.receiveShadow = options.receiveShadow ?? true;
  mesh_chest_shell_l_14.userData.sculptComponent = { id: "chest-shell-l" };
  node_chest_shell_l_14.add(mesh_chest_shell_l_14);
  meshes["chest-shell-l"] = mesh_chest_shell_l_14;
  colliders["chest-shell-l"] = {};
  destructionGroups["torso"] ??= [];
  destructionGroups["torso"].push(node_chest_shell_l_14);

  const endpoint_chest_shell_back_l_15 = makeAttachmentEndpoint(null);
  const node_chest_shell_back_l_15 = new THREE.Group();
  node_chest_shell_back_l_15.name = "Back shell L (inferred)__pivot";
  node_chest_shell_back_l_15.scale.set(1, 1, 1);
  if (endpoint_chest_shell_back_l_15) {
    node_chest_shell_back_l_15.position.copy(endpoint_chest_shell_back_l_15.start);
    node_chest_shell_back_l_15.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_chest_shell_back_l_15.position.set(0.14488, 0.27717, -0.05039);
    node_chest_shell_back_l_15.rotation.set(0.0, 0.0, 0.0);
  }
  node_chest_shell_back_l_15.userData.sculptComponent = { id: "chest-shell-back-l" };
  node_chest_shell_back_l_15.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_chest_shell_back_l_15);
  nodes["chest-shell-back-l"] = node_chest_shell_back_l_15;
  const mesh_chest_shell_back_l_15Geometry = endpoint_chest_shell_back_l_15
    ? new THREE.CylinderGeometry(endpoint_chest_shell_back_l_15.endRadius, endpoint_chest_shell_back_l_15.baseRadius, endpoint_chest_shell_back_l_15.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.04409, "rz": 0.06929, "twist": 0.0}, {"position": [-0.0189, -0.06929, -0.0315], "rx": 0.06299, "rz": 0.08189, "twist": 0.0}, {"position": [-0.05039, -0.17008, -0.04409], "rx": 0.06299, "rz": 0.06929, "twist": 0.0}, {"position": [-0.07559, -0.26457, -0.0378], "rx": 0.0378, "rz": 0.0378, "twist": 0.0}], "radialSegments": 20, "capEnds": true});
  if (!endpoint_chest_shell_back_l_15) {
    mesh_chest_shell_back_l_15Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_chest_shell_back_l_15 = new THREE.Mesh(
    mesh_chest_shell_back_l_15Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_chest_shell_back_l_15.name = "Back shell L (inferred)";
  if (endpoint_chest_shell_back_l_15) {
    mesh_chest_shell_back_l_15.position.copy(endpoint_chest_shell_back_l_15.midpoint);
    mesh_chest_shell_back_l_15.quaternion.copy(endpoint_chest_shell_back_l_15.quaternion);
  }
  mesh_chest_shell_back_l_15.castShadow = options.castShadow ?? true;
  mesh_chest_shell_back_l_15.receiveShadow = options.receiveShadow ?? true;
  mesh_chest_shell_back_l_15.userData.sculptComponent = { id: "chest-shell-back-l" };
  node_chest_shell_back_l_15.add(mesh_chest_shell_back_l_15);
  meshes["chest-shell-back-l"] = mesh_chest_shell_back_l_15;
  colliders["chest-shell-back-l"] = {};
  destructionGroups["torso"] ??= [];
  destructionGroups["torso"].push(node_chest_shell_back_l_15);

  const endpoint_chest_shell_r_16 = makeAttachmentEndpoint(null);
  const node_chest_shell_r_16 = new THREE.Group();
  node_chest_shell_r_16.name = "Chest shell R__pivot";
  node_chest_shell_r_16.scale.set(1, 1, 1);
  if (endpoint_chest_shell_r_16) {
    node_chest_shell_r_16.position.copy(endpoint_chest_shell_r_16.start);
    node_chest_shell_r_16.rotation.set(0.0, -0.0, 0.0);
  } else {
    node_chest_shell_r_16.position.set(-0.14488, 0.27717, 0.0378);
    node_chest_shell_r_16.rotation.set(0.0, -0.0, 0.0);
  }
  node_chest_shell_r_16.userData.sculptComponent = { id: "chest-shell-r" };
  node_chest_shell_r_16.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_chest_shell_r_16);
  nodes["chest-shell-r"] = node_chest_shell_r_16;
  const mesh_chest_shell_r_16Geometry = endpoint_chest_shell_r_16
    ? new THREE.CylinderGeometry(endpoint_chest_shell_r_16.endRadius, endpoint_chest_shell_r_16.baseRadius, endpoint_chest_shell_r_16.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.04409, "rz": 0.06929, "twist": 0.0}, {"position": [0.0189, -0.06929, 0.0315], "rx": 0.06299, "rz": 0.08189, "twist": 0.0}, {"position": [0.05039, -0.17008, 0.04409], "rx": 0.06299, "rz": 0.06929, "twist": 0.0}, {"position": [0.07559, -0.26457, 0.0378], "rx": 0.0378, "rz": 0.0378, "twist": 0.0}], "radialSegments": 20, "capEnds": true});
  if (!endpoint_chest_shell_r_16) {
    mesh_chest_shell_r_16Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_chest_shell_r_16 = new THREE.Mesh(
    mesh_chest_shell_r_16Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_chest_shell_r_16.name = "Chest shell R";
  if (endpoint_chest_shell_r_16) {
    mesh_chest_shell_r_16.position.copy(endpoint_chest_shell_r_16.midpoint);
    mesh_chest_shell_r_16.quaternion.copy(endpoint_chest_shell_r_16.quaternion);
  }
  mesh_chest_shell_r_16.castShadow = options.castShadow ?? true;
  mesh_chest_shell_r_16.receiveShadow = options.receiveShadow ?? true;
  mesh_chest_shell_r_16.userData.sculptComponent = { id: "chest-shell-r" };
  node_chest_shell_r_16.add(mesh_chest_shell_r_16);
  meshes["chest-shell-r"] = mesh_chest_shell_r_16;
  colliders["chest-shell-r"] = {};
  destructionGroups["torso"] ??= [];
  destructionGroups["torso"].push(node_chest_shell_r_16);

  const endpoint_chest_shell_back_r_17 = makeAttachmentEndpoint(null);
  const node_chest_shell_back_r_17 = new THREE.Group();
  node_chest_shell_back_r_17.name = "Back shell R (inferred)__pivot";
  node_chest_shell_back_r_17.scale.set(1, 1, 1);
  if (endpoint_chest_shell_back_r_17) {
    node_chest_shell_back_r_17.position.copy(endpoint_chest_shell_back_r_17.start);
    node_chest_shell_back_r_17.rotation.set(0.0, -0.0, 0.0);
  } else {
    node_chest_shell_back_r_17.position.set(-0.14488, 0.27717, -0.05039);
    node_chest_shell_back_r_17.rotation.set(0.0, -0.0, 0.0);
  }
  node_chest_shell_back_r_17.userData.sculptComponent = { id: "chest-shell-back-r" };
  node_chest_shell_back_r_17.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_chest_shell_back_r_17);
  nodes["chest-shell-back-r"] = node_chest_shell_back_r_17;
  const mesh_chest_shell_back_r_17Geometry = endpoint_chest_shell_back_r_17
    ? new THREE.CylinderGeometry(endpoint_chest_shell_back_r_17.endRadius, endpoint_chest_shell_back_r_17.baseRadius, endpoint_chest_shell_back_r_17.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.04409, "rz": 0.06929, "twist": 0.0}, {"position": [0.0189, -0.06929, -0.0315], "rx": 0.06299, "rz": 0.08189, "twist": 0.0}, {"position": [0.05039, -0.17008, -0.04409], "rx": 0.06299, "rz": 0.06929, "twist": 0.0}, {"position": [0.07559, -0.26457, -0.0378], "rx": 0.0378, "rz": 0.0378, "twist": 0.0}], "radialSegments": 20, "capEnds": true});
  if (!endpoint_chest_shell_back_r_17) {
    mesh_chest_shell_back_r_17Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_chest_shell_back_r_17 = new THREE.Mesh(
    mesh_chest_shell_back_r_17Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_chest_shell_back_r_17.name = "Back shell R (inferred)";
  if (endpoint_chest_shell_back_r_17) {
    mesh_chest_shell_back_r_17.position.copy(endpoint_chest_shell_back_r_17.midpoint);
    mesh_chest_shell_back_r_17.quaternion.copy(endpoint_chest_shell_back_r_17.quaternion);
  }
  mesh_chest_shell_back_r_17.castShadow = options.castShadow ?? true;
  mesh_chest_shell_back_r_17.receiveShadow = options.receiveShadow ?? true;
  mesh_chest_shell_back_r_17.userData.sculptComponent = { id: "chest-shell-back-r" };
  node_chest_shell_back_r_17.add(mesh_chest_shell_back_r_17);
  meshes["chest-shell-back-r"] = mesh_chest_shell_back_r_17;
  colliders["chest-shell-back-r"] = {};
  destructionGroups["torso"] ??= [];
  destructionGroups["torso"].push(node_chest_shell_back_r_17);

  const attachment_emblem_disc_18 = {"parentSocket": "chest-emblem-disc", "localStart": [0.0, 0.14488, 0.13071], "localEnd": [0.0, 0.14488, 0.14646], "contactType": "rigid-weld", "baseRadius": 0.06929, "endRadius": 0.06929, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_emblem_disc_18 = makeAttachmentEndpoint(attachment_emblem_disc_18);
  const node_emblem_disc_18 = new THREE.Group();
  node_emblem_disc_18.name = "Emblem disc__pivot";
  node_emblem_disc_18.scale.set(1, 1, 1);
  if (endpoint_emblem_disc_18) {
    node_emblem_disc_18.position.copy(endpoint_emblem_disc_18.start);
    node_emblem_disc_18.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_emblem_disc_18.position.set(0.0, 0.14488, 0.13071);
    node_emblem_disc_18.rotation.set(0.0, 0.0, 0.0);
  }
  node_emblem_disc_18.userData.sculptComponent = { id: "emblem-disc" };
  node_emblem_disc_18.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_emblem_disc_18);
  nodes["emblem-disc"] = node_emblem_disc_18;
  const mesh_emblem_disc_18Geometry = endpoint_emblem_disc_18
    ? new THREE.CylinderGeometry(endpoint_emblem_disc_18.endRadius, endpoint_emblem_disc_18.baseRadius, endpoint_emblem_disc_18.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_emblem_disc_18) {
    mesh_emblem_disc_18Geometry.scale(0.13858, 0.01575, 0.13858);
  }
  const mesh_emblem_disc_18 = new THREE.Mesh(
    mesh_emblem_disc_18Geometry,
    materialMap["emblem-dark-blue"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_emblem_disc_18.name = "Emblem disc";
  if (endpoint_emblem_disc_18) {
    mesh_emblem_disc_18.position.copy(endpoint_emblem_disc_18.midpoint);
    mesh_emblem_disc_18.quaternion.copy(endpoint_emblem_disc_18.quaternion);
  }
  mesh_emblem_disc_18.castShadow = options.castShadow ?? true;
  mesh_emblem_disc_18.receiveShadow = options.receiveShadow ?? true;
  mesh_emblem_disc_18.userData.sculptComponent = { id: "emblem-disc" };
  node_emblem_disc_18.add(mesh_emblem_disc_18);
  meshes["emblem-disc"] = mesh_emblem_disc_18;
  colliders["emblem-disc"] = {};
  destructionGroups["torso"] ??= [];
  destructionGroups["torso"].push(node_emblem_disc_18);

  const endpoint_emblem_ring_19 = makeAttachmentEndpoint(null);
  const node_emblem_ring_19 = new THREE.Group();
  node_emblem_ring_19.name = "Emblem ring__pivot";
  node_emblem_ring_19.scale.set(1, 1, 1);
  if (endpoint_emblem_ring_19) {
    node_emblem_ring_19.position.copy(endpoint_emblem_ring_19.start);
    node_emblem_ring_19.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_emblem_ring_19.position.set(0.0, 0.14488, 0.14646);
    node_emblem_ring_19.rotation.set(0.0, 0.0, 0.0);
  }
  node_emblem_ring_19.userData.sculptComponent = { id: "emblem-ring" };
  node_emblem_ring_19.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_emblem_ring_19);
  nodes["emblem-ring"] = node_emblem_ring_19;
  const mesh_emblem_ring_19Geometry = endpoint_emblem_ring_19
    ? new THREE.CylinderGeometry(endpoint_emblem_ring_19.endRadius, endpoint_emblem_ring_19.baseRadius, endpoint_emblem_ring_19.length, 16, 6)
    : new THREE.TorusGeometry(0.45, 0.0514, 12, 48);
  if (!endpoint_emblem_ring_19) {
    mesh_emblem_ring_19Geometry.scale(0.14698, 0.14698, 0.14698);
  }
  const mesh_emblem_ring_19 = new THREE.Mesh(
    mesh_emblem_ring_19Geometry,
    materialMap["emissive-blue"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_emblem_ring_19.name = "Emblem ring";
  if (endpoint_emblem_ring_19) {
    mesh_emblem_ring_19.position.copy(endpoint_emblem_ring_19.midpoint);
    mesh_emblem_ring_19.quaternion.copy(endpoint_emblem_ring_19.quaternion);
  }
  mesh_emblem_ring_19.castShadow = options.castShadow ?? true;
  mesh_emblem_ring_19.receiveShadow = options.receiveShadow ?? true;
  mesh_emblem_ring_19.userData.sculptComponent = { id: "emblem-ring" };
  node_emblem_ring_19.add(mesh_emblem_ring_19);
  meshes["emblem-ring"] = mesh_emblem_ring_19;
  colliders["emblem-ring"] = {};
  destructionGroups["torso"] ??= [];
  destructionGroups["torso"].push(node_emblem_ring_19);

  const endpoint_emblem_letter_a_20 = makeAttachmentEndpoint(null);
  const node_emblem_letter_a_20 = new THREE.Group();
  node_emblem_letter_a_20.name = "Emblem letter A__pivot";
  node_emblem_letter_a_20.scale.set(1, 1, 1);
  if (endpoint_emblem_letter_a_20) {
    node_emblem_letter_a_20.position.copy(endpoint_emblem_letter_a_20.start);
    node_emblem_letter_a_20.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_emblem_letter_a_20.position.set(-0.01575, 0.14488, 0.14961);
    node_emblem_letter_a_20.rotation.set(0.0, 0.0, 0.0);
  }
  node_emblem_letter_a_20.userData.sculptComponent = { id: "emblem-letter-a" };
  node_emblem_letter_a_20.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_emblem_letter_a_20);
  nodes["emblem-letter-a"] = node_emblem_letter_a_20;
  const mesh_emblem_letter_a_20Geometry = endpoint_emblem_letter_a_20
    ? new THREE.CylinderGeometry(endpoint_emblem_letter_a_20.endRadius, endpoint_emblem_letter_a_20.baseRadius, endpoint_emblem_letter_a_20.length, 16, 6)
    : buildExtrudeGeometry({"points": [[-0.02016, -0.0252], [-0.01008, -0.0252], [-0.00706, -0.01386], [0.00706, -0.01386], [0.01008, -0.0252], [0.02016, -0.0252], [0.00706, 0.0252], [-0.00706, 0.0252]], "holes": [[[-0.00454, 0.00126], [0.00454, 0.00126], [0.0, 0.01512]]], "depth": 0.00945});
  if (!endpoint_emblem_letter_a_20) {
    mesh_emblem_letter_a_20Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_emblem_letter_a_20 = new THREE.Mesh(
    mesh_emblem_letter_a_20Geometry,
    materialMap["emblem-white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_emblem_letter_a_20.name = "Emblem letter A";
  if (endpoint_emblem_letter_a_20) {
    mesh_emblem_letter_a_20.position.copy(endpoint_emblem_letter_a_20.midpoint);
    mesh_emblem_letter_a_20.quaternion.copy(endpoint_emblem_letter_a_20.quaternion);
  }
  mesh_emblem_letter_a_20.castShadow = options.castShadow ?? true;
  mesh_emblem_letter_a_20.receiveShadow = options.receiveShadow ?? true;
  mesh_emblem_letter_a_20.userData.sculptComponent = { id: "emblem-letter-a" };
  node_emblem_letter_a_20.add(mesh_emblem_letter_a_20);
  meshes["emblem-letter-a"] = mesh_emblem_letter_a_20;
  colliders["emblem-letter-a"] = {};
  destructionGroups["torso"] ??= [];
  destructionGroups["torso"].push(node_emblem_letter_a_20);

  const endpoint_emblem_letter_i_21 = makeAttachmentEndpoint(null);
  const node_emblem_letter_i_21 = new THREE.Group();
  node_emblem_letter_i_21.name = "Emblem letter I__pivot";
  node_emblem_letter_i_21.scale.set(1, 1, 1);
  if (endpoint_emblem_letter_i_21) {
    node_emblem_letter_i_21.position.copy(endpoint_emblem_letter_i_21.start);
    node_emblem_letter_i_21.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_emblem_letter_i_21.position.set(0.0252, 0.14488, 0.14961);
    node_emblem_letter_i_21.rotation.set(0.0, 0.0, 0.0);
  }
  node_emblem_letter_i_21.userData.sculptComponent = { id: "emblem-letter-i" };
  node_emblem_letter_i_21.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_emblem_letter_i_21);
  nodes["emblem-letter-i"] = node_emblem_letter_i_21;
  const mesh_emblem_letter_i_21Geometry = endpoint_emblem_letter_i_21
    ? new THREE.CylinderGeometry(endpoint_emblem_letter_i_21.endRadius, endpoint_emblem_letter_i_21.baseRadius, endpoint_emblem_letter_i_21.length, 16, 6)
    : buildExtrudeGeometry({"points": [[-0.00504, -0.0252], [0.00504, -0.0252], [0.00504, 0.0252], [-0.00504, 0.0252]], "depth": 0.00945});
  if (!endpoint_emblem_letter_i_21) {
    mesh_emblem_letter_i_21Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_emblem_letter_i_21 = new THREE.Mesh(
    mesh_emblem_letter_i_21Geometry,
    materialMap["emblem-white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_emblem_letter_i_21.name = "Emblem letter I";
  if (endpoint_emblem_letter_i_21) {
    mesh_emblem_letter_i_21.position.copy(endpoint_emblem_letter_i_21.midpoint);
    mesh_emblem_letter_i_21.quaternion.copy(endpoint_emblem_letter_i_21.quaternion);
  }
  mesh_emblem_letter_i_21.castShadow = options.castShadow ?? true;
  mesh_emblem_letter_i_21.receiveShadow = options.receiveShadow ?? true;
  mesh_emblem_letter_i_21.userData.sculptComponent = { id: "emblem-letter-i" };
  node_emblem_letter_i_21.add(mesh_emblem_letter_i_21);
  meshes["emblem-letter-i"] = mesh_emblem_letter_i_21;
  colliders["emblem-letter-i"] = {};
  destructionGroups["torso"] ??= [];
  destructionGroups["torso"].push(node_emblem_letter_i_21);

  const endpoint_abdomen_rib_1_22 = makeAttachmentEndpoint(null);
  const node_abdomen_rib_1_22 = new THREE.Group();
  node_abdomen_rib_1_22.name = "Abdomen segment ring 1__pivot";
  node_abdomen_rib_1_22.scale.set(1, 1, 1);
  if (endpoint_abdomen_rib_1_22) {
    node_abdomen_rib_1_22.position.copy(endpoint_abdomen_rib_1_22.start);
    node_abdomen_rib_1_22.rotation.set(1.5708, 0.0, 0.0);
  } else {
    node_abdomen_rib_1_22.position.set(0.0, 0.09449, 0.0);
    node_abdomen_rib_1_22.rotation.set(1.5708, 0.0, 0.0);
  }
  node_abdomen_rib_1_22.userData.sculptComponent = { id: "abdomen-rib-1" };
  node_abdomen_rib_1_22.userData.actionProfile = {};
  (nodes["abdomen"] ?? root).add(node_abdomen_rib_1_22);
  nodes["abdomen-rib-1"] = node_abdomen_rib_1_22;
  const mesh_abdomen_rib_1_22Geometry = endpoint_abdomen_rib_1_22
    ? new THREE.CylinderGeometry(endpoint_abdomen_rib_1_22.endRadius, endpoint_abdomen_rib_1_22.baseRadius, endpoint_abdomen_rib_1_22.length, 16, 6)
    : new THREE.TorusGeometry(0.45, 0.0596, 12, 48);
  if (!endpoint_abdomen_rib_1_22) {
    mesh_abdomen_rib_1_22Geometry.scale(0.23797, 0.19514, 0.23797);
  }
  const mesh_abdomen_rib_1_22 = new THREE.Mesh(
    mesh_abdomen_rib_1_22Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_abdomen_rib_1_22.name = "Abdomen segment ring 1";
  if (endpoint_abdomen_rib_1_22) {
    mesh_abdomen_rib_1_22.position.copy(endpoint_abdomen_rib_1_22.midpoint);
    mesh_abdomen_rib_1_22.quaternion.copy(endpoint_abdomen_rib_1_22.quaternion);
  }
  mesh_abdomen_rib_1_22.castShadow = options.castShadow ?? true;
  mesh_abdomen_rib_1_22.receiveShadow = options.receiveShadow ?? true;
  mesh_abdomen_rib_1_22.userData.sculptComponent = { id: "abdomen-rib-1" };
  node_abdomen_rib_1_22.add(mesh_abdomen_rib_1_22);
  meshes["abdomen-rib-1"] = mesh_abdomen_rib_1_22;
  colliders["abdomen-rib-1"] = {};
  destructionGroups["torso"] ??= [];
  destructionGroups["torso"].push(node_abdomen_rib_1_22);

  const endpoint_abdomen_rib_2_23 = makeAttachmentEndpoint(null);
  const node_abdomen_rib_2_23 = new THREE.Group();
  node_abdomen_rib_2_23.name = "Abdomen segment ring 2__pivot";
  node_abdomen_rib_2_23.scale.set(1, 1, 1);
  if (endpoint_abdomen_rib_2_23) {
    node_abdomen_rib_2_23.position.copy(endpoint_abdomen_rib_2_23.start);
    node_abdomen_rib_2_23.rotation.set(1.5708, 0.0, 0.0);
  } else {
    node_abdomen_rib_2_23.position.set(0.0, 0.06929, 0.0);
    node_abdomen_rib_2_23.rotation.set(1.5708, 0.0, 0.0);
  }
  node_abdomen_rib_2_23.userData.sculptComponent = { id: "abdomen-rib-2" };
  node_abdomen_rib_2_23.userData.actionProfile = {};
  (nodes["abdomen"] ?? root).add(node_abdomen_rib_2_23);
  nodes["abdomen-rib-2"] = node_abdomen_rib_2_23;
  const mesh_abdomen_rib_2_23Geometry = endpoint_abdomen_rib_2_23
    ? new THREE.CylinderGeometry(endpoint_abdomen_rib_2_23.endRadius, endpoint_abdomen_rib_2_23.baseRadius, endpoint_abdomen_rib_2_23.length, 16, 6)
    : new THREE.TorusGeometry(0.45, 0.0596, 12, 48);
  if (!endpoint_abdomen_rib_2_23) {
    mesh_abdomen_rib_2_23Geometry.scale(0.23797, 0.19514, 0.23797);
  }
  const mesh_abdomen_rib_2_23 = new THREE.Mesh(
    mesh_abdomen_rib_2_23Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_abdomen_rib_2_23.name = "Abdomen segment ring 2";
  if (endpoint_abdomen_rib_2_23) {
    mesh_abdomen_rib_2_23.position.copy(endpoint_abdomen_rib_2_23.midpoint);
    mesh_abdomen_rib_2_23.quaternion.copy(endpoint_abdomen_rib_2_23.quaternion);
  }
  mesh_abdomen_rib_2_23.castShadow = options.castShadow ?? true;
  mesh_abdomen_rib_2_23.receiveShadow = options.receiveShadow ?? true;
  mesh_abdomen_rib_2_23.userData.sculptComponent = { id: "abdomen-rib-2" };
  node_abdomen_rib_2_23.add(mesh_abdomen_rib_2_23);
  meshes["abdomen-rib-2"] = mesh_abdomen_rib_2_23;
  colliders["abdomen-rib-2"] = {};
  destructionGroups["torso"] ??= [];
  destructionGroups["torso"].push(node_abdomen_rib_2_23);

  const endpoint_abdomen_rib_3_24 = makeAttachmentEndpoint(null);
  const node_abdomen_rib_3_24 = new THREE.Group();
  node_abdomen_rib_3_24.name = "Abdomen segment ring 3__pivot";
  node_abdomen_rib_3_24.scale.set(1, 1, 1);
  if (endpoint_abdomen_rib_3_24) {
    node_abdomen_rib_3_24.position.copy(endpoint_abdomen_rib_3_24.start);
    node_abdomen_rib_3_24.rotation.set(1.5708, 0.0, 0.0);
  } else {
    node_abdomen_rib_3_24.position.set(0.0, 0.04409, 0.0);
    node_abdomen_rib_3_24.rotation.set(1.5708, 0.0, 0.0);
  }
  node_abdomen_rib_3_24.userData.sculptComponent = { id: "abdomen-rib-3" };
  node_abdomen_rib_3_24.userData.actionProfile = {};
  (nodes["abdomen"] ?? root).add(node_abdomen_rib_3_24);
  nodes["abdomen-rib-3"] = node_abdomen_rib_3_24;
  const mesh_abdomen_rib_3_24Geometry = endpoint_abdomen_rib_3_24
    ? new THREE.CylinderGeometry(endpoint_abdomen_rib_3_24.endRadius, endpoint_abdomen_rib_3_24.baseRadius, endpoint_abdomen_rib_3_24.length, 16, 6)
    : new THREE.TorusGeometry(0.45, 0.0596, 12, 48);
  if (!endpoint_abdomen_rib_3_24) {
    mesh_abdomen_rib_3_24Geometry.scale(0.23797, 0.19514, 0.23797);
  }
  const mesh_abdomen_rib_3_24 = new THREE.Mesh(
    mesh_abdomen_rib_3_24Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_abdomen_rib_3_24.name = "Abdomen segment ring 3";
  if (endpoint_abdomen_rib_3_24) {
    mesh_abdomen_rib_3_24.position.copy(endpoint_abdomen_rib_3_24.midpoint);
    mesh_abdomen_rib_3_24.quaternion.copy(endpoint_abdomen_rib_3_24.quaternion);
  }
  mesh_abdomen_rib_3_24.castShadow = options.castShadow ?? true;
  mesh_abdomen_rib_3_24.receiveShadow = options.receiveShadow ?? true;
  mesh_abdomen_rib_3_24.userData.sculptComponent = { id: "abdomen-rib-3" };
  node_abdomen_rib_3_24.add(mesh_abdomen_rib_3_24);
  meshes["abdomen-rib-3"] = mesh_abdomen_rib_3_24;
  colliders["abdomen-rib-3"] = {};
  destructionGroups["torso"] ??= [];
  destructionGroups["torso"].push(node_abdomen_rib_3_24);

  const endpoint_abdomen_rib_4_25 = makeAttachmentEndpoint(null);
  const node_abdomen_rib_4_25 = new THREE.Group();
  node_abdomen_rib_4_25.name = "Abdomen segment ring 4__pivot";
  node_abdomen_rib_4_25.scale.set(1, 1, 1);
  if (endpoint_abdomen_rib_4_25) {
    node_abdomen_rib_4_25.position.copy(endpoint_abdomen_rib_4_25.start);
    node_abdomen_rib_4_25.rotation.set(1.5708, 0.0, 0.0);
  } else {
    node_abdomen_rib_4_25.position.set(0.0, 0.0189, 0.0);
    node_abdomen_rib_4_25.rotation.set(1.5708, 0.0, 0.0);
  }
  node_abdomen_rib_4_25.userData.sculptComponent = { id: "abdomen-rib-4" };
  node_abdomen_rib_4_25.userData.actionProfile = {};
  (nodes["abdomen"] ?? root).add(node_abdomen_rib_4_25);
  nodes["abdomen-rib-4"] = node_abdomen_rib_4_25;
  const mesh_abdomen_rib_4_25Geometry = endpoint_abdomen_rib_4_25
    ? new THREE.CylinderGeometry(endpoint_abdomen_rib_4_25.endRadius, endpoint_abdomen_rib_4_25.baseRadius, endpoint_abdomen_rib_4_25.length, 16, 6)
    : new THREE.TorusGeometry(0.45, 0.0596, 12, 48);
  if (!endpoint_abdomen_rib_4_25) {
    mesh_abdomen_rib_4_25Geometry.scale(0.23797, 0.19514, 0.23797);
  }
  const mesh_abdomen_rib_4_25 = new THREE.Mesh(
    mesh_abdomen_rib_4_25Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_abdomen_rib_4_25.name = "Abdomen segment ring 4";
  if (endpoint_abdomen_rib_4_25) {
    mesh_abdomen_rib_4_25.position.copy(endpoint_abdomen_rib_4_25.midpoint);
    mesh_abdomen_rib_4_25.quaternion.copy(endpoint_abdomen_rib_4_25.quaternion);
  }
  mesh_abdomen_rib_4_25.castShadow = options.castShadow ?? true;
  mesh_abdomen_rib_4_25.receiveShadow = options.receiveShadow ?? true;
  mesh_abdomen_rib_4_25.userData.sculptComponent = { id: "abdomen-rib-4" };
  node_abdomen_rib_4_25.add(mesh_abdomen_rib_4_25);
  meshes["abdomen-rib-4"] = mesh_abdomen_rib_4_25;
  colliders["abdomen-rib-4"] = {};
  destructionGroups["torso"] ??= [];
  destructionGroups["torso"].push(node_abdomen_rib_4_25);

  const endpoint_pelvis_plate_26 = makeAttachmentEndpoint(null);
  const node_pelvis_plate_26 = new THREE.Group();
  node_pelvis_plate_26.name = "Pelvis front plate__pivot";
  node_pelvis_plate_26.scale.set(1, 1, 1);
  if (endpoint_pelvis_plate_26) {
    node_pelvis_plate_26.position.copy(endpoint_pelvis_plate_26.start);
    node_pelvis_plate_26.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_pelvis_plate_26.position.set(0.0, 0.11969, 0.06929);
    node_pelvis_plate_26.rotation.set(0.0, 0.0, 0.0);
  }
  node_pelvis_plate_26.userData.sculptComponent = { id: "pelvis-plate" };
  node_pelvis_plate_26.userData.actionProfile = {};
  (nodes["pelvis"] ?? root).add(node_pelvis_plate_26);
  nodes["pelvis-plate"] = node_pelvis_plate_26;
  const mesh_pelvis_plate_26Geometry = endpoint_pelvis_plate_26
    ? new THREE.CylinderGeometry(endpoint_pelvis_plate_26.endRadius, endpoint_pelvis_plate_26.baseRadius, endpoint_pelvis_plate_26.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.04409, "rz": 0.10709, "twist": 0.0}, {"position": [0.0, -0.11969, 0.0252], "rx": 0.05669, "rz": 0.13858, "twist": 0.0}, {"position": [0.0, -0.23937, 0.0189], "rx": 0.05039, "rz": 0.11339, "twist": 0.0}, {"position": [0.0, -0.30236, 0.0063], "rx": 0.0315, "rz": 0.04409, "twist": 0.0}], "radialSegments": 20, "capEnds": true});
  if (!endpoint_pelvis_plate_26) {
    mesh_pelvis_plate_26Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_pelvis_plate_26 = new THREE.Mesh(
    mesh_pelvis_plate_26Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pelvis_plate_26.name = "Pelvis front plate";
  if (endpoint_pelvis_plate_26) {
    mesh_pelvis_plate_26.position.copy(endpoint_pelvis_plate_26.midpoint);
    mesh_pelvis_plate_26.quaternion.copy(endpoint_pelvis_plate_26.quaternion);
  }
  mesh_pelvis_plate_26.castShadow = options.castShadow ?? true;
  mesh_pelvis_plate_26.receiveShadow = options.receiveShadow ?? true;
  mesh_pelvis_plate_26.userData.sculptComponent = { id: "pelvis-plate" };
  node_pelvis_plate_26.add(mesh_pelvis_plate_26);
  meshes["pelvis-plate"] = mesh_pelvis_plate_26;
  colliders["pelvis-plate"] = {};
  destructionGroups["pelvis"] ??= [];
  destructionGroups["pelvis"].push(node_pelvis_plate_26);

  const endpoint_pelvis_plate_back_27 = makeAttachmentEndpoint(null);
  const node_pelvis_plate_back_27 = new THREE.Group();
  node_pelvis_plate_back_27.name = "Pelvis back plate (inferred)__pivot";
  node_pelvis_plate_back_27.scale.set(1, 1, 1);
  if (endpoint_pelvis_plate_back_27) {
    node_pelvis_plate_back_27.position.copy(endpoint_pelvis_plate_back_27.start);
    node_pelvis_plate_back_27.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_pelvis_plate_back_27.position.set(0.0, 0.11969, -0.06929);
    node_pelvis_plate_back_27.rotation.set(0.0, 0.0, 0.0);
  }
  node_pelvis_plate_back_27.userData.sculptComponent = { id: "pelvis-plate-back" };
  node_pelvis_plate_back_27.userData.actionProfile = {};
  (nodes["pelvis"] ?? root).add(node_pelvis_plate_back_27);
  nodes["pelvis-plate-back"] = node_pelvis_plate_back_27;
  const mesh_pelvis_plate_back_27Geometry = endpoint_pelvis_plate_back_27
    ? new THREE.CylinderGeometry(endpoint_pelvis_plate_back_27.endRadius, endpoint_pelvis_plate_back_27.baseRadius, endpoint_pelvis_plate_back_27.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.04409, "rz": 0.10709, "twist": 0.0}, {"position": [0.0, -0.11969, -0.0252], "rx": 0.05669, "rz": 0.13858, "twist": 0.0}, {"position": [0.0, -0.23937, -0.0189], "rx": 0.05039, "rz": 0.11339, "twist": 0.0}, {"position": [0.0, -0.30236, -0.0063], "rx": 0.0315, "rz": 0.04409, "twist": 0.0}], "radialSegments": 20, "capEnds": true});
  if (!endpoint_pelvis_plate_back_27) {
    mesh_pelvis_plate_back_27Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_pelvis_plate_back_27 = new THREE.Mesh(
    mesh_pelvis_plate_back_27Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pelvis_plate_back_27.name = "Pelvis back plate (inferred)";
  if (endpoint_pelvis_plate_back_27) {
    mesh_pelvis_plate_back_27.position.copy(endpoint_pelvis_plate_back_27.midpoint);
    mesh_pelvis_plate_back_27.quaternion.copy(endpoint_pelvis_plate_back_27.quaternion);
  }
  mesh_pelvis_plate_back_27.castShadow = options.castShadow ?? true;
  mesh_pelvis_plate_back_27.receiveShadow = options.receiveShadow ?? true;
  mesh_pelvis_plate_back_27.userData.sculptComponent = { id: "pelvis-plate-back" };
  node_pelvis_plate_back_27.add(mesh_pelvis_plate_back_27);
  meshes["pelvis-plate-back"] = mesh_pelvis_plate_back_27;
  colliders["pelvis-plate-back"] = {};
  destructionGroups["pelvis"] ??= [];
  destructionGroups["pelvis"].push(node_pelvis_plate_back_27);

  const endpoint_hip_joint_l_28 = makeAttachmentEndpoint(null);
  const node_hip_joint_l_28 = new THREE.Group();
  node_hip_joint_l_28.name = "Hip joint L__pivot";
  node_hip_joint_l_28.scale.set(1, 1, 1);
  if (endpoint_hip_joint_l_28) {
    node_hip_joint_l_28.position.copy(endpoint_hip_joint_l_28.start);
    node_hip_joint_l_28.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hip_joint_l_28.position.set(0.10394, 0.07559, 0.0);
    node_hip_joint_l_28.rotation.set(0.0, 0.0, 0.0);
  }
  node_hip_joint_l_28.userData.sculptComponent = { id: "hip-joint-l" };
  node_hip_joint_l_28.userData.actionProfile = {};
  (nodes["pelvis"] ?? root).add(node_hip_joint_l_28);
  nodes["hip-joint-l"] = node_hip_joint_l_28;
  const mesh_hip_joint_l_28Geometry = endpoint_hip_joint_l_28
    ? new THREE.CylinderGeometry(endpoint_hip_joint_l_28.endRadius, endpoint_hip_joint_l_28.baseRadius, endpoint_hip_joint_l_28.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_hip_joint_l_28) {
    mesh_hip_joint_l_28Geometry.scale(0.10079, 0.10079, 0.10079);
  }
  const mesh_hip_joint_l_28 = new THREE.Mesh(
    mesh_hip_joint_l_28Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hip_joint_l_28.name = "Hip joint L";
  if (endpoint_hip_joint_l_28) {
    mesh_hip_joint_l_28.position.copy(endpoint_hip_joint_l_28.midpoint);
    mesh_hip_joint_l_28.quaternion.copy(endpoint_hip_joint_l_28.quaternion);
  }
  mesh_hip_joint_l_28.castShadow = options.castShadow ?? true;
  mesh_hip_joint_l_28.receiveShadow = options.receiveShadow ?? true;
  mesh_hip_joint_l_28.userData.sculptComponent = { id: "hip-joint-l" };
  node_hip_joint_l_28.add(mesh_hip_joint_l_28);
  meshes["hip-joint-l"] = mesh_hip_joint_l_28;
  colliders["hip-joint-l"] = {};
  destructionGroups["leg-l"] ??= [];
  destructionGroups["leg-l"].push(node_hip_joint_l_28);

  const attachment_thigh_l_29 = {"parentSocket": "pelvis-thigh-l", "localStart": [0.10394, 0.07559, 0.0], "localEnd": [0.13228, -0.4252, 0.0126], "contactType": "socket-joint", "baseRadius": 0.05354, "endRadius": 0.04724, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_thigh_l_29 = makeAttachmentEndpoint(attachment_thigh_l_29);
  const node_thigh_l_29 = new THREE.Group();
  node_thigh_l_29.name = "Thigh core L__pivot";
  node_thigh_l_29.scale.set(1, 1, 1);
  if (endpoint_thigh_l_29) {
    node_thigh_l_29.position.copy(endpoint_thigh_l_29.start);
    node_thigh_l_29.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_thigh_l_29.position.set(0.10394, 0.07559, 0.0);
    node_thigh_l_29.rotation.set(0.0, 0.0, 0.0);
  }
  node_thigh_l_29.userData.sculptComponent = { id: "thigh-l" };
  node_thigh_l_29.userData.actionProfile = {};
  (nodes["pelvis"] ?? root).add(node_thigh_l_29);
  nodes["thigh-l"] = node_thigh_l_29;
  const mesh_thigh_l_29Geometry = endpoint_thigh_l_29
    ? new THREE.CylinderGeometry(endpoint_thigh_l_29.endRadius, endpoint_thigh_l_29.baseRadius, endpoint_thigh_l_29.length, 16, 6)
    : buildWatertightCapsule(0.35, 0.7, 8, 16, 1);
  if (!endpoint_thigh_l_29) {
    mesh_thigh_l_29Geometry.scale(0.10709, 0.50175, 0.10709);
  }
  const mesh_thigh_l_29 = new THREE.Mesh(
    mesh_thigh_l_29Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_thigh_l_29.name = "Thigh core L";
  if (endpoint_thigh_l_29) {
    mesh_thigh_l_29.position.copy(endpoint_thigh_l_29.midpoint);
    mesh_thigh_l_29.quaternion.copy(endpoint_thigh_l_29.quaternion);
  }
  mesh_thigh_l_29.castShadow = options.castShadow ?? true;
  mesh_thigh_l_29.receiveShadow = options.receiveShadow ?? true;
  mesh_thigh_l_29.userData.sculptComponent = { id: "thigh-l" };
  node_thigh_l_29.add(mesh_thigh_l_29);
  meshes["thigh-l"] = mesh_thigh_l_29;
  colliders["thigh-l"] = {};
  destructionGroups["leg-l"] ??= [];
  destructionGroups["leg-l"].push(node_thigh_l_29);

  const endpoint_thigh_plate_front_l_30 = makeAttachmentEndpoint(null);
  const node_thigh_plate_front_l_30 = new THREE.Group();
  node_thigh_plate_front_l_30.name = "Thigh front plate L__pivot";
  node_thigh_plate_front_l_30.scale.set(1, 1, 1);
  if (endpoint_thigh_plate_front_l_30) {
    node_thigh_plate_front_l_30.position.copy(endpoint_thigh_plate_front_l_30.start);
    node_thigh_plate_front_l_30.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_thigh_plate_front_l_30.position.set(0.00107, -0.0189, 0.06929);
    node_thigh_plate_front_l_30.rotation.set(0.0, 0.0, 0.0);
  }
  node_thigh_plate_front_l_30.userData.sculptComponent = { id: "thigh-plate-front-l" };
  node_thigh_plate_front_l_30.userData.actionProfile = {};
  (nodes["thigh-l"] ?? root).add(node_thigh_plate_front_l_30);
  nodes["thigh-plate-front-l"] = node_thigh_plate_front_l_30;
  const mesh_thigh_plate_front_l_30Geometry = endpoint_thigh_plate_front_l_30
    ? new THREE.CylinderGeometry(endpoint_thigh_plate_front_l_30.endRadius, endpoint_thigh_plate_front_l_30.baseRadius, endpoint_thigh_plate_front_l_30.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.01814, "rz": 0.01512, "twist": 0.0}, {"position": [0.00556, -0.09827, 0.0], "rx": 0.02452, "rz": 0.05291, "twist": 0.0}, {"position": [0.0153, -0.27024, 0.0], "rx": 0.02835, "rz": 0.07559, "twist": 0.0}, {"position": [0.02364, -0.41764, 0.0], "rx": 0.02516, "rz": 0.05669, "twist": 0.0}, {"position": [0.02781, -0.49134, 0.0], "rx": 0.01814, "rz": 0.01512, "twist": 0.0}], "radialSegments": 18, "capEnds": true});
  if (!endpoint_thigh_plate_front_l_30) {
    mesh_thigh_plate_front_l_30Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_thigh_plate_front_l_30 = new THREE.Mesh(
    mesh_thigh_plate_front_l_30Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_thigh_plate_front_l_30.name = "Thigh front plate L";
  if (endpoint_thigh_plate_front_l_30) {
    mesh_thigh_plate_front_l_30.position.copy(endpoint_thigh_plate_front_l_30.midpoint);
    mesh_thigh_plate_front_l_30.quaternion.copy(endpoint_thigh_plate_front_l_30.quaternion);
  }
  mesh_thigh_plate_front_l_30.castShadow = options.castShadow ?? true;
  mesh_thigh_plate_front_l_30.receiveShadow = options.receiveShadow ?? true;
  mesh_thigh_plate_front_l_30.userData.sculptComponent = { id: "thigh-plate-front-l" };
  node_thigh_plate_front_l_30.add(mesh_thigh_plate_front_l_30);
  meshes["thigh-plate-front-l"] = mesh_thigh_plate_front_l_30;
  colliders["thigh-plate-front-l"] = {};
  destructionGroups["leg-l"] ??= [];
  destructionGroups["leg-l"].push(node_thigh_plate_front_l_30);

  const endpoint_thigh_plate_outer_l_31 = makeAttachmentEndpoint(null);
  const node_thigh_plate_outer_l_31 = new THREE.Group();
  node_thigh_plate_outer_l_31.name = "Thigh outer plate L__pivot";
  node_thigh_plate_outer_l_31.scale.set(1, 1, 1);
  if (endpoint_thigh_plate_outer_l_31) {
    node_thigh_plate_outer_l_31.position.copy(endpoint_thigh_plate_outer_l_31.start);
    node_thigh_plate_outer_l_31.rotation.set(0.0, 1.01229, 0.0);
  } else {
    node_thigh_plate_outer_l_31.position.set(0.06678, 0.0, 0.04173);
    node_thigh_plate_outer_l_31.rotation.set(0.0, 1.01229, 0.0);
  }
  node_thigh_plate_outer_l_31.userData.sculptComponent = { id: "thigh-plate-outer-l" };
  node_thigh_plate_outer_l_31.userData.actionProfile = {};
  (nodes["thigh-l"] ?? root).add(node_thigh_plate_outer_l_31);
  nodes["thigh-plate-outer-l"] = node_thigh_plate_outer_l_31;
  const mesh_thigh_plate_outer_l_31Geometry = endpoint_thigh_plate_outer_l_31
    ? new THREE.CylinderGeometry(endpoint_thigh_plate_outer_l_31.endRadius, endpoint_thigh_plate_outer_l_31.baseRadius, endpoint_thigh_plate_outer_l_31.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.01613, "rz": 0.01134, "twist": 0.0}, {"position": [0.00299, -0.09953, 0.00478], "rx": 0.0218, "rz": 0.03969, "twist": 0.0}, {"position": [0.00821, -0.2737, 0.01314], "rx": 0.0252, "rz": 0.05669, "twist": 0.0}, {"position": [0.01269, -0.42299, 0.0203], "rx": 0.02236, "rz": 0.04252, "twist": 0.0}, {"position": [0.01493, -0.49764, 0.02389], "rx": 0.01613, "rz": 0.01134, "twist": 0.0}], "radialSegments": 18, "capEnds": true});
  if (!endpoint_thigh_plate_outer_l_31) {
    mesh_thigh_plate_outer_l_31Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_thigh_plate_outer_l_31 = new THREE.Mesh(
    mesh_thigh_plate_outer_l_31Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_thigh_plate_outer_l_31.name = "Thigh outer plate L";
  if (endpoint_thigh_plate_outer_l_31) {
    mesh_thigh_plate_outer_l_31.position.copy(endpoint_thigh_plate_outer_l_31.midpoint);
    mesh_thigh_plate_outer_l_31.quaternion.copy(endpoint_thigh_plate_outer_l_31.quaternion);
  }
  mesh_thigh_plate_outer_l_31.castShadow = options.castShadow ?? true;
  mesh_thigh_plate_outer_l_31.receiveShadow = options.receiveShadow ?? true;
  mesh_thigh_plate_outer_l_31.userData.sculptComponent = { id: "thigh-plate-outer-l" };
  node_thigh_plate_outer_l_31.add(mesh_thigh_plate_outer_l_31);
  meshes["thigh-plate-outer-l"] = mesh_thigh_plate_outer_l_31;
  colliders["thigh-plate-outer-l"] = {};
  destructionGroups["leg-l"] ??= [];
  destructionGroups["leg-l"].push(node_thigh_plate_outer_l_31);

  const endpoint_thigh_plate_inner_l_32 = makeAttachmentEndpoint(null);
  const node_thigh_plate_inner_l_32 = new THREE.Group();
  node_thigh_plate_inner_l_32.name = "Thigh inner plate L__pivot";
  node_thigh_plate_inner_l_32.scale.set(1, 1, 1);
  if (endpoint_thigh_plate_inner_l_32) {
    node_thigh_plate_inner_l_32.position.copy(endpoint_thigh_plate_inner_l_32.start);
    node_thigh_plate_inner_l_32.rotation.set(0.0, -0.83776, 0.0);
  } else {
    node_thigh_plate_inner_l_32.position.set(-0.04666, -0.04409, 0.04426);
    node_thigh_plate_inner_l_32.rotation.set(0.0, -0.83776, 0.0);
  }
  node_thigh_plate_inner_l_32.userData.sculptComponent = { id: "thigh-plate-inner-l" };
  node_thigh_plate_inner_l_32.userData.actionProfile = {};
  (nodes["thigh-l"] ?? root).add(node_thigh_plate_inner_l_32);
  nodes["thigh-plate-inner-l"] = node_thigh_plate_inner_l_32;
  const mesh_thigh_plate_inner_l_32Geometry = endpoint_thigh_plate_inner_l_32
    ? new THREE.CylinderGeometry(endpoint_thigh_plate_inner_l_32.endRadius, endpoint_thigh_plate_inner_l_32.baseRadius, endpoint_thigh_plate_inner_l_32.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.01613, "rz": 0.00819, "twist": 0.0}, {"position": [0.00286, -0.07559, -0.00318], "rx": 0.0218, "rz": 0.02866, "twist": 0.0}, {"position": [0.00787, -0.20787, -0.00874], "rx": 0.0252, "rz": 0.04094, "twist": 0.0}, {"position": [0.01217, -0.32126, -0.01351], "rx": 0.02236, "rz": 0.03071, "twist": 0.0}, {"position": [0.01432, -0.37795, -0.0159], "rx": 0.01613, "rz": 0.00819, "twist": 0.0}], "radialSegments": 18, "capEnds": true});
  if (!endpoint_thigh_plate_inner_l_32) {
    mesh_thigh_plate_inner_l_32Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_thigh_plate_inner_l_32 = new THREE.Mesh(
    mesh_thigh_plate_inner_l_32Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_thigh_plate_inner_l_32.name = "Thigh inner plate L";
  if (endpoint_thigh_plate_inner_l_32) {
    mesh_thigh_plate_inner_l_32.position.copy(endpoint_thigh_plate_inner_l_32.midpoint);
    mesh_thigh_plate_inner_l_32.quaternion.copy(endpoint_thigh_plate_inner_l_32.quaternion);
  }
  mesh_thigh_plate_inner_l_32.castShadow = options.castShadow ?? true;
  mesh_thigh_plate_inner_l_32.receiveShadow = options.receiveShadow ?? true;
  mesh_thigh_plate_inner_l_32.userData.sculptComponent = { id: "thigh-plate-inner-l" };
  node_thigh_plate_inner_l_32.add(mesh_thigh_plate_inner_l_32);
  meshes["thigh-plate-inner-l"] = mesh_thigh_plate_inner_l_32;
  colliders["thigh-plate-inner-l"] = {};
  destructionGroups["leg-l"] ??= [];
  destructionGroups["leg-l"].push(node_thigh_plate_inner_l_32);

  const endpoint_thigh_plate_back_l_33 = makeAttachmentEndpoint(null);
  const node_thigh_plate_back_l_33 = new THREE.Group();
  node_thigh_plate_back_l_33.name = "Thigh back plate L__pivot";
  node_thigh_plate_back_l_33.scale.set(1, 1, 1);
  if (endpoint_thigh_plate_back_l_33) {
    node_thigh_plate_back_l_33.position.copy(endpoint_thigh_plate_back_l_33.start);
    node_thigh_plate_back_l_33.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_thigh_plate_back_l_33.position.set(0.00107, -0.0189, -0.06929);
    node_thigh_plate_back_l_33.rotation.set(0.0, 3.14159, 0.0);
  }
  node_thigh_plate_back_l_33.userData.sculptComponent = { id: "thigh-plate-back-l" };
  node_thigh_plate_back_l_33.userData.actionProfile = {};
  (nodes["thigh-l"] ?? root).add(node_thigh_plate_back_l_33);
  nodes["thigh-plate-back-l"] = node_thigh_plate_back_l_33;
  const mesh_thigh_plate_back_l_33Geometry = endpoint_thigh_plate_back_l_33
    ? new THREE.CylinderGeometry(endpoint_thigh_plate_back_l_33.endRadius, endpoint_thigh_plate_back_l_33.baseRadius, endpoint_thigh_plate_back_l_33.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.0, -0.0, 0.0], "rx": 0.01814, "rz": 0.01386, "twist": 0.0}, {"position": [-0.00542, -0.09575, 0.0], "rx": 0.02452, "rz": 0.0485, "twist": 0.0}, {"position": [-0.0149, -0.26331, 0.0], "rx": 0.02835, "rz": 0.06929, "twist": 0.0}, {"position": [-0.02303, -0.40693, 0.0], "rx": 0.02516, "rz": 0.05197, "twist": 0.0}, {"position": [-0.0271, -0.47874, 0.0], "rx": 0.01814, "rz": 0.01386, "twist": 0.0}], "radialSegments": 18, "capEnds": true});
  if (!endpoint_thigh_plate_back_l_33) {
    mesh_thigh_plate_back_l_33Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_thigh_plate_back_l_33 = new THREE.Mesh(
    mesh_thigh_plate_back_l_33Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_thigh_plate_back_l_33.name = "Thigh back plate L";
  if (endpoint_thigh_plate_back_l_33) {
    mesh_thigh_plate_back_l_33.position.copy(endpoint_thigh_plate_back_l_33.midpoint);
    mesh_thigh_plate_back_l_33.quaternion.copy(endpoint_thigh_plate_back_l_33.quaternion);
  }
  mesh_thigh_plate_back_l_33.castShadow = options.castShadow ?? true;
  mesh_thigh_plate_back_l_33.receiveShadow = options.receiveShadow ?? true;
  mesh_thigh_plate_back_l_33.userData.sculptComponent = { id: "thigh-plate-back-l" };
  node_thigh_plate_back_l_33.add(mesh_thigh_plate_back_l_33);
  meshes["thigh-plate-back-l"] = mesh_thigh_plate_back_l_33;
  colliders["thigh-plate-back-l"] = {};
  destructionGroups["leg-l"] ??= [];
  destructionGroups["leg-l"].push(node_thigh_plate_back_l_33);

  const endpoint_thigh_plate_backout_l_34 = makeAttachmentEndpoint(null);
  const node_thigh_plate_backout_l_34 = new THREE.Group();
  node_thigh_plate_backout_l_34.name = "Thigh backout plate L__pivot";
  node_thigh_plate_backout_l_34.scale.set(1, 1, 1);
  if (endpoint_thigh_plate_backout_l_34) {
    node_thigh_plate_backout_l_34.position.copy(endpoint_thigh_plate_backout_l_34.start);
    node_thigh_plate_backout_l_34.rotation.set(0.0, 2.18166, 0.0);
  } else {
    node_thigh_plate_backout_l_34.position.set(0.06184, -0.04409, -0.04155);
    node_thigh_plate_backout_l_34.rotation.set(0.0, 2.18166, 0.0);
  }
  node_thigh_plate_backout_l_34.userData.sculptComponent = { id: "thigh-plate-backout-l" };
  node_thigh_plate_backout_l_34.userData.actionProfile = {};
  (nodes["thigh-l"] ?? root).add(node_thigh_plate_backout_l_34);
  nodes["thigh-plate-backout-l"] = node_thigh_plate_backout_l_34;
  const mesh_thigh_plate_backout_l_34Geometry = endpoint_thigh_plate_backout_l_34
    ? new THREE.CylinderGeometry(endpoint_thigh_plate_backout_l_34.endRadius, endpoint_thigh_plate_backout_l_34.baseRadius, endpoint_thigh_plate_backout_l_34.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.0, -0.0, 0.0], "rx": 0.01613, "rz": 0.01008, "twist": 0.0}, {"position": [-0.00266, -0.08189, 0.0038], "rx": 0.0218, "rz": 0.03528, "twist": 0.0}, {"position": [-0.00731, -0.2252, 0.01044], "rx": 0.0252, "rz": 0.05039, "twist": 0.0}, {"position": [-0.0113, -0.34803, 0.01614], "rx": 0.02236, "rz": 0.0378, "twist": 0.0}, {"position": [-0.01329, -0.40945, 0.01898], "rx": 0.01613, "rz": 0.01008, "twist": 0.0}], "radialSegments": 18, "capEnds": true});
  if (!endpoint_thigh_plate_backout_l_34) {
    mesh_thigh_plate_backout_l_34Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_thigh_plate_backout_l_34 = new THREE.Mesh(
    mesh_thigh_plate_backout_l_34Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_thigh_plate_backout_l_34.name = "Thigh backout plate L";
  if (endpoint_thigh_plate_backout_l_34) {
    mesh_thigh_plate_backout_l_34.position.copy(endpoint_thigh_plate_backout_l_34.midpoint);
    mesh_thigh_plate_backout_l_34.quaternion.copy(endpoint_thigh_plate_backout_l_34.quaternion);
  }
  mesh_thigh_plate_backout_l_34.castShadow = options.castShadow ?? true;
  mesh_thigh_plate_backout_l_34.receiveShadow = options.receiveShadow ?? true;
  mesh_thigh_plate_backout_l_34.userData.sculptComponent = { id: "thigh-plate-backout-l" };
  node_thigh_plate_backout_l_34.add(mesh_thigh_plate_backout_l_34);
  meshes["thigh-plate-backout-l"] = mesh_thigh_plate_backout_l_34;
  colliders["thigh-plate-backout-l"] = {};
  destructionGroups["leg-l"] ??= [];
  destructionGroups["leg-l"].push(node_thigh_plate_backout_l_34);

  const endpoint_knee_l_35 = makeAttachmentEndpoint(null);
  const node_knee_l_35 = new THREE.Group();
  node_knee_l_35.name = "Knee joint L__pivot";
  node_knee_l_35.scale.set(1, 1, 1);
  if (endpoint_knee_l_35) {
    node_knee_l_35.position.copy(endpoint_knee_l_35.start);
    node_knee_l_35.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_knee_l_35.position.set(0.02835, -0.50394, 0.0189);
    node_knee_l_35.rotation.set(0.0, 0.0, 0.0);
  }
  node_knee_l_35.userData.sculptComponent = { id: "knee-l" };
  node_knee_l_35.userData.actionProfile = {};
  (nodes["thigh-l"] ?? root).add(node_knee_l_35);
  nodes["knee-l"] = node_knee_l_35;
  const mesh_knee_l_35Geometry = endpoint_knee_l_35
    ? new THREE.CylinderGeometry(endpoint_knee_l_35.endRadius, endpoint_knee_l_35.baseRadius, endpoint_knee_l_35.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_knee_l_35) {
    mesh_knee_l_35Geometry.scale(0.10709, 0.10709, 0.10709);
  }
  const mesh_knee_l_35 = new THREE.Mesh(
    mesh_knee_l_35Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_knee_l_35.name = "Knee joint L";
  if (endpoint_knee_l_35) {
    mesh_knee_l_35.position.copy(endpoint_knee_l_35.midpoint);
    mesh_knee_l_35.quaternion.copy(endpoint_knee_l_35.quaternion);
  }
  mesh_knee_l_35.castShadow = options.castShadow ?? true;
  mesh_knee_l_35.receiveShadow = options.receiveShadow ?? true;
  mesh_knee_l_35.userData.sculptComponent = { id: "knee-l" };
  node_knee_l_35.add(mesh_knee_l_35);
  meshes["knee-l"] = mesh_knee_l_35;
  colliders["knee-l"] = {};
  destructionGroups["leg-l"] ??= [];
  destructionGroups["leg-l"].push(node_knee_l_35);

  const endpoint_knee_glow_l_36 = makeAttachmentEndpoint(null);
  const node_knee_glow_l_36 = new THREE.Group();
  node_knee_glow_l_36.name = "Knee glow L__pivot";
  node_knee_glow_l_36.scale.set(1, 1, 1);
  if (endpoint_knee_glow_l_36) {
    node_knee_glow_l_36.position.copy(endpoint_knee_glow_l_36.start);
    node_knee_glow_l_36.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_knee_glow_l_36.position.set(0.02835, -0.61102, 0.06929);
    node_knee_glow_l_36.rotation.set(0.0, 0.0, 0.0);
  }
  node_knee_glow_l_36.userData.sculptComponent = { id: "knee-glow-l" };
  node_knee_glow_l_36.userData.actionProfile = {};
  (nodes["thigh-l"] ?? root).add(node_knee_glow_l_36);
  nodes["knee-glow-l"] = node_knee_glow_l_36;
  const mesh_knee_glow_l_36Geometry = endpoint_knee_glow_l_36
    ? new THREE.CylinderGeometry(endpoint_knee_glow_l_36.endRadius, endpoint_knee_glow_l_36.baseRadius, endpoint_knee_glow_l_36.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_knee_glow_l_36) {
    mesh_knee_glow_l_36Geometry.scale(0.08819, 0.02835, 0.02205);
  }
  const mesh_knee_glow_l_36 = new THREE.Mesh(
    mesh_knee_glow_l_36Geometry,
    materialMap["emissive-blue"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_knee_glow_l_36.name = "Knee glow L";
  if (endpoint_knee_glow_l_36) {
    mesh_knee_glow_l_36.position.copy(endpoint_knee_glow_l_36.midpoint);
    mesh_knee_glow_l_36.quaternion.copy(endpoint_knee_glow_l_36.quaternion);
  }
  mesh_knee_glow_l_36.castShadow = options.castShadow ?? true;
  mesh_knee_glow_l_36.receiveShadow = options.receiveShadow ?? true;
  mesh_knee_glow_l_36.userData.sculptComponent = { id: "knee-glow-l" };
  node_knee_glow_l_36.add(mesh_knee_glow_l_36);
  meshes["knee-glow-l"] = mesh_knee_glow_l_36;
  colliders["knee-glow-l"] = {};
  destructionGroups["leg-l"] ??= [];
  destructionGroups["leg-l"].push(node_knee_glow_l_36);

  const endpoint_hip_glow_l_37 = makeAttachmentEndpoint(null);
  const node_hip_glow_l_37 = new THREE.Group();
  node_hip_glow_l_37.name = "Hip glow L__pivot";
  node_hip_glow_l_37.scale.set(1, 1, 1);
  if (endpoint_hip_glow_l_37) {
    node_hip_glow_l_37.position.copy(endpoint_hip_glow_l_37.start);
    node_hip_glow_l_37.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hip_glow_l_37.position.set(0.10079, 0.08819, 0.09449);
    node_hip_glow_l_37.rotation.set(0.0, 0.0, 0.0);
  }
  node_hip_glow_l_37.userData.sculptComponent = { id: "hip-glow-l" };
  node_hip_glow_l_37.userData.actionProfile = {};
  (nodes["pelvis"] ?? root).add(node_hip_glow_l_37);
  nodes["hip-glow-l"] = node_hip_glow_l_37;
  const mesh_hip_glow_l_37Geometry = endpoint_hip_glow_l_37
    ? new THREE.CylinderGeometry(endpoint_hip_glow_l_37.endRadius, endpoint_hip_glow_l_37.baseRadius, endpoint_hip_glow_l_37.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_hip_glow_l_37) {
    mesh_hip_glow_l_37Geometry.scale(0.04409, 0.02835, 0.0189);
  }
  const mesh_hip_glow_l_37 = new THREE.Mesh(
    mesh_hip_glow_l_37Geometry,
    materialMap["emissive-blue"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hip_glow_l_37.name = "Hip glow L";
  if (endpoint_hip_glow_l_37) {
    mesh_hip_glow_l_37.position.copy(endpoint_hip_glow_l_37.midpoint);
    mesh_hip_glow_l_37.quaternion.copy(endpoint_hip_glow_l_37.quaternion);
  }
  mesh_hip_glow_l_37.castShadow = options.castShadow ?? true;
  mesh_hip_glow_l_37.receiveShadow = options.receiveShadow ?? true;
  mesh_hip_glow_l_37.userData.sculptComponent = { id: "hip-glow-l" };
  node_hip_glow_l_37.add(mesh_hip_glow_l_37);
  meshes["hip-glow-l"] = mesh_hip_glow_l_37;
  colliders["hip-glow-l"] = {};
  destructionGroups["leg-l"] ??= [];
  destructionGroups["leg-l"].push(node_hip_glow_l_37);

  const attachment_shin_l_38 = {"parentSocket": "thigh-l-shin-l", "localStart": [0.02835, -0.50394, 0.0189], "localEnd": [0.10394, -0.91339, 0.0063], "contactType": "hinge-joint", "baseRadius": 0.04409, "endRadius": 0.03465, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_shin_l_38 = makeAttachmentEndpoint(attachment_shin_l_38);
  const node_shin_l_38 = new THREE.Group();
  node_shin_l_38.name = "Shin core L__pivot";
  node_shin_l_38.scale.set(1, 1, 1);
  if (endpoint_shin_l_38) {
    node_shin_l_38.position.copy(endpoint_shin_l_38.start);
    node_shin_l_38.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_shin_l_38.position.set(0.02835, -0.50394, 0.0189);
    node_shin_l_38.rotation.set(0.0, 0.0, 0.0);
  }
  node_shin_l_38.userData.sculptComponent = { id: "shin-l" };
  node_shin_l_38.userData.actionProfile = {};
  (nodes["thigh-l"] ?? root).add(node_shin_l_38);
  nodes["shin-l"] = node_shin_l_38;
  const mesh_shin_l_38Geometry = endpoint_shin_l_38
    ? new THREE.CylinderGeometry(endpoint_shin_l_38.endRadius, endpoint_shin_l_38.baseRadius, endpoint_shin_l_38.length, 16, 6)
    : buildWatertightCapsule(0.35, 0.7, 8, 16, 1);
  if (!endpoint_shin_l_38) {
    mesh_shin_l_38Geometry.scale(0.08819, 0.41656, 0.08819);
  }
  const mesh_shin_l_38 = new THREE.Mesh(
    mesh_shin_l_38Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_shin_l_38.name = "Shin core L";
  if (endpoint_shin_l_38) {
    mesh_shin_l_38.position.copy(endpoint_shin_l_38.midpoint);
    mesh_shin_l_38.quaternion.copy(endpoint_shin_l_38.quaternion);
  }
  mesh_shin_l_38.castShadow = options.castShadow ?? true;
  mesh_shin_l_38.receiveShadow = options.receiveShadow ?? true;
  mesh_shin_l_38.userData.sculptComponent = { id: "shin-l" };
  node_shin_l_38.add(mesh_shin_l_38);
  meshes["shin-l"] = mesh_shin_l_38;
  colliders["shin-l"] = {};
  destructionGroups["leg-l"] ??= [];
  destructionGroups["leg-l"].push(node_shin_l_38);

  const endpoint_shin_spur_l_39 = makeAttachmentEndpoint(null);
  const node_shin_spur_l_39 = new THREE.Group();
  node_shin_spur_l_39.name = "Shin spur L__pivot";
  node_shin_spur_l_39.scale.set(1, 1, 1);
  if (endpoint_shin_spur_l_39) {
    node_shin_spur_l_39.position.copy(endpoint_shin_spur_l_39.start);
    node_shin_spur_l_39.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_shin_spur_l_39.position.set(0.07559, -0.18898, 0.0);
    node_shin_spur_l_39.rotation.set(0.0, 0.0, 0.0);
  }
  node_shin_spur_l_39.userData.sculptComponent = { id: "shin-spur-l" };
  node_shin_spur_l_39.userData.actionProfile = {};
  (nodes["shin-l"] ?? root).add(node_shin_spur_l_39);
  nodes["shin-spur-l"] = node_shin_spur_l_39;
  const mesh_shin_spur_l_39Geometry = endpoint_shin_spur_l_39
    ? new THREE.CylinderGeometry(endpoint_shin_spur_l_39.endRadius, endpoint_shin_spur_l_39.baseRadius, endpoint_shin_spur_l_39.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.0189, "rz": 0.02205, "twist": 0.0}, {"position": [0.0252, 0.08189, -0.00315], "rx": 0.01417, "rz": 0.01575, "twist": 0.0}, {"position": [0.05039, 0.18268, -0.0063], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 14, "capEnds": true});
  if (!endpoint_shin_spur_l_39) {
    mesh_shin_spur_l_39Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_shin_spur_l_39 = new THREE.Mesh(
    mesh_shin_spur_l_39Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_shin_spur_l_39.name = "Shin spur L";
  if (endpoint_shin_spur_l_39) {
    mesh_shin_spur_l_39.position.copy(endpoint_shin_spur_l_39.midpoint);
    mesh_shin_spur_l_39.quaternion.copy(endpoint_shin_spur_l_39.quaternion);
  }
  mesh_shin_spur_l_39.castShadow = options.castShadow ?? true;
  mesh_shin_spur_l_39.receiveShadow = options.receiveShadow ?? true;
  mesh_shin_spur_l_39.userData.sculptComponent = { id: "shin-spur-l" };
  node_shin_spur_l_39.add(mesh_shin_spur_l_39);
  meshes["shin-spur-l"] = mesh_shin_spur_l_39;
  colliders["shin-spur-l"] = {};
  destructionGroups["leg-l"] ??= [];
  destructionGroups["leg-l"].push(node_shin_spur_l_39);

  const endpoint_shin_plate_front_l_40 = makeAttachmentEndpoint(null);
  const node_shin_plate_front_l_40 = new THREE.Group();
  node_shin_plate_front_l_40.name = "Shin front plate L__pivot";
  node_shin_plate_front_l_40.scale.set(1, 1, 1);
  if (endpoint_shin_plate_front_l_40) {
    node_shin_plate_front_l_40.position.copy(endpoint_shin_plate_front_l_40.start);
    node_shin_plate_front_l_40.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_shin_plate_front_l_40.position.set(0.00233, -0.0126, 0.04094);
    node_shin_plate_front_l_40.rotation.set(0.0, 0.0, 0.0);
  }
  node_shin_plate_front_l_40.userData.sculptComponent = { id: "shin-plate-front-l" };
  node_shin_plate_front_l_40.userData.actionProfile = {};
  (nodes["shin-l"] ?? root).add(node_shin_plate_front_l_40);
  nodes["shin-plate-front-l"] = node_shin_plate_front_l_40;
  const mesh_shin_plate_front_l_40Geometry = endpoint_shin_plate_front_l_40
    ? new THREE.CylinderGeometry(endpoint_shin_plate_front_l_40.endRadius, endpoint_shin_plate_front_l_40.baseRadius, endpoint_shin_plate_front_l_40.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.01814, "rz": 0.01512, "twist": 0.0}, {"position": [0.01768, -0.09575, 0.0], "rx": 0.02452, "rz": 0.05291, "twist": 0.0}, {"position": [0.04861, -0.26331, 0.0], "rx": 0.02835, "rz": 0.07559, "twist": 0.0}, {"position": [0.07513, -0.40693, 0.0], "rx": 0.02516, "rz": 0.05669, "twist": 0.0}, {"position": [0.08838, -0.47874, 0.0], "rx": 0.01814, "rz": 0.01512, "twist": 0.0}], "radialSegments": 18, "capEnds": true});
  if (!endpoint_shin_plate_front_l_40) {
    mesh_shin_plate_front_l_40Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_shin_plate_front_l_40 = new THREE.Mesh(
    mesh_shin_plate_front_l_40Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_shin_plate_front_l_40.name = "Shin front plate L";
  if (endpoint_shin_plate_front_l_40) {
    mesh_shin_plate_front_l_40.position.copy(endpoint_shin_plate_front_l_40.midpoint);
    mesh_shin_plate_front_l_40.quaternion.copy(endpoint_shin_plate_front_l_40.quaternion);
  }
  mesh_shin_plate_front_l_40.castShadow = options.castShadow ?? true;
  mesh_shin_plate_front_l_40.receiveShadow = options.receiveShadow ?? true;
  mesh_shin_plate_front_l_40.userData.sculptComponent = { id: "shin-plate-front-l" };
  node_shin_plate_front_l_40.add(mesh_shin_plate_front_l_40);
  meshes["shin-plate-front-l"] = mesh_shin_plate_front_l_40;
  colliders["shin-plate-front-l"] = {};
  destructionGroups["leg-l"] ??= [];
  destructionGroups["leg-l"].push(node_shin_plate_front_l_40);

  const endpoint_shin_plate_outer_l_41 = makeAttachmentEndpoint(null);
  const node_shin_plate_outer_l_41 = new THREE.Group();
  node_shin_plate_outer_l_41.name = "Shin outer plate L__pivot";
  node_shin_plate_outer_l_41.scale.set(1, 1, 1);
  if (endpoint_shin_plate_outer_l_41) {
    node_shin_plate_outer_l_41.position.copy(endpoint_shin_plate_outer_l_41.start);
    node_shin_plate_outer_l_41.rotation.set(0.0, 1.0472, 0.0);
  } else {
    node_shin_plate_outer_l_41.position.set(0.06935, -0.0063, 0.02047);
    node_shin_plate_outer_l_41.rotation.set(0.0, 1.0472, 0.0);
  }
  node_shin_plate_outer_l_41.userData.sculptComponent = { id: "shin-plate-outer-l" };
  node_shin_plate_outer_l_41.userData.actionProfile = {};
  (nodes["shin-l"] ?? root).add(node_shin_plate_outer_l_41);
  nodes["shin-plate-outer-l"] = node_shin_plate_outer_l_41;
  const mesh_shin_plate_outer_l_41Geometry = endpoint_shin_plate_outer_l_41
    ? new THREE.CylinderGeometry(endpoint_shin_plate_outer_l_41.endRadius, endpoint_shin_plate_outer_l_41.baseRadius, endpoint_shin_plate_outer_l_41.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.01613, "rz": 0.01134, "twist": 0.0}, {"position": [0.00744, -0.08063, 0.01289], "rx": 0.0218, "rz": 0.03969, "twist": 0.0}, {"position": [0.02047, -0.22173, 0.03545], "rx": 0.0252, "rz": 0.05669, "twist": 0.0}, {"position": [0.03163, -0.34268, 0.05479], "rx": 0.02236, "rz": 0.04252, "twist": 0.0}, {"position": [0.03721, -0.40315, 0.06446], "rx": 0.01613, "rz": 0.01134, "twist": 0.0}], "radialSegments": 18, "capEnds": true});
  if (!endpoint_shin_plate_outer_l_41) {
    mesh_shin_plate_outer_l_41Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_shin_plate_outer_l_41 = new THREE.Mesh(
    mesh_shin_plate_outer_l_41Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_shin_plate_outer_l_41.name = "Shin outer plate L";
  if (endpoint_shin_plate_outer_l_41) {
    mesh_shin_plate_outer_l_41.position.copy(endpoint_shin_plate_outer_l_41.midpoint);
    mesh_shin_plate_outer_l_41.quaternion.copy(endpoint_shin_plate_outer_l_41.quaternion);
  }
  mesh_shin_plate_outer_l_41.castShadow = options.castShadow ?? true;
  mesh_shin_plate_outer_l_41.receiveShadow = options.receiveShadow ?? true;
  mesh_shin_plate_outer_l_41.userData.sculptComponent = { id: "shin-plate-outer-l" };
  node_shin_plate_outer_l_41.add(mesh_shin_plate_outer_l_41);
  meshes["shin-plate-outer-l"] = mesh_shin_plate_outer_l_41;
  colliders["shin-plate-outer-l"] = {};
  destructionGroups["leg-l"] ??= [];
  destructionGroups["leg-l"].push(node_shin_plate_outer_l_41);

  const endpoint_shin_plate_inner_l_42 = makeAttachmentEndpoint(null);
  const node_shin_plate_inner_l_42 = new THREE.Group();
  node_shin_plate_inner_l_42.name = "Shin inner plate L__pivot";
  node_shin_plate_inner_l_42.scale.set(1, 1, 1);
  if (endpoint_shin_plate_inner_l_42) {
    node_shin_plate_inner_l_42.position.copy(endpoint_shin_plate_inner_l_42.start);
    node_shin_plate_inner_l_42.rotation.set(0.0, -0.87266, 0.0);
  } else {
    node_shin_plate_inner_l_42.position.set(-0.03305, -0.06929, 0.01957);
    node_shin_plate_inner_l_42.rotation.set(0.0, -0.87266, 0.0);
  }
  node_shin_plate_inner_l_42.userData.sculptComponent = { id: "shin-plate-inner-l" };
  node_shin_plate_inner_l_42.userData.actionProfile = {};
  (nodes["shin-l"] ?? root).add(node_shin_plate_inner_l_42);
  nodes["shin-plate-inner-l"] = node_shin_plate_inner_l_42;
  const mesh_shin_plate_inner_l_42Geometry = endpoint_shin_plate_inner_l_42
    ? new THREE.CylinderGeometry(endpoint_shin_plate_inner_l_42.endRadius, endpoint_shin_plate_inner_l_42.baseRadius, endpoint_shin_plate_inner_l_42.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.01411, "rz": 0.00756, "twist": 0.0}, {"position": [0.00703, -0.05921, -0.00837], "rx": 0.01907, "rz": 0.02646, "twist": 0.0}, {"position": [0.01932, -0.16283, -0.02303], "rx": 0.02205, "rz": 0.0378, "twist": 0.0}, {"position": [0.02986, -0.25165, -0.03559], "rx": 0.01957, "rz": 0.02835, "twist": 0.0}, {"position": [0.03513, -0.29606, -0.04187], "rx": 0.01411, "rz": 0.00756, "twist": 0.0}], "radialSegments": 18, "capEnds": true});
  if (!endpoint_shin_plate_inner_l_42) {
    mesh_shin_plate_inner_l_42Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_shin_plate_inner_l_42 = new THREE.Mesh(
    mesh_shin_plate_inner_l_42Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_shin_plate_inner_l_42.name = "Shin inner plate L";
  if (endpoint_shin_plate_inner_l_42) {
    mesh_shin_plate_inner_l_42.position.copy(endpoint_shin_plate_inner_l_42.midpoint);
    mesh_shin_plate_inner_l_42.quaternion.copy(endpoint_shin_plate_inner_l_42.quaternion);
  }
  mesh_shin_plate_inner_l_42.castShadow = options.castShadow ?? true;
  mesh_shin_plate_inner_l_42.receiveShadow = options.receiveShadow ?? true;
  mesh_shin_plate_inner_l_42.userData.sculptComponent = { id: "shin-plate-inner-l" };
  node_shin_plate_inner_l_42.add(mesh_shin_plate_inner_l_42);
  meshes["shin-plate-inner-l"] = mesh_shin_plate_inner_l_42;
  colliders["shin-plate-inner-l"] = {};
  destructionGroups["leg-l"] ??= [];
  destructionGroups["leg-l"].push(node_shin_plate_inner_l_42);

  const endpoint_shin_plate_back_l_43 = makeAttachmentEndpoint(null);
  const node_shin_plate_back_l_43 = new THREE.Group();
  node_shin_plate_back_l_43.name = "Shin back plate L__pivot";
  node_shin_plate_back_l_43.scale.set(1, 1, 1);
  if (endpoint_shin_plate_back_l_43) {
    node_shin_plate_back_l_43.position.copy(endpoint_shin_plate_back_l_43.start);
    node_shin_plate_back_l_43.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_shin_plate_back_l_43.position.set(0.00465, -0.0252, -0.07874);
    node_shin_plate_back_l_43.rotation.set(0.0, 3.14159, 0.0);
  }
  node_shin_plate_back_l_43.userData.sculptComponent = { id: "shin-plate-back-l" };
  node_shin_plate_back_l_43.userData.actionProfile = {};
  (nodes["shin-l"] ?? root).add(node_shin_plate_back_l_43);
  nodes["shin-plate-back-l"] = node_shin_plate_back_l_43;
  const mesh_shin_plate_back_l_43Geometry = endpoint_shin_plate_back_l_43
    ? new THREE.CylinderGeometry(endpoint_shin_plate_back_l_43.endRadius, endpoint_shin_plate_back_l_43.baseRadius, endpoint_shin_plate_back_l_43.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.0, -0.0, 0.0], "rx": 0.01814, "rz": 0.01386, "twist": 0.0}, {"position": [-0.01675, -0.09071, 0.0], "rx": 0.02452, "rz": 0.0485, "twist": 0.0}, {"position": [-0.04605, -0.24945, 0.0], "rx": 0.02835, "rz": 0.06929, "twist": 0.0}, {"position": [-0.07117, -0.38551, 0.0], "rx": 0.02516, "rz": 0.05197, "twist": 0.0}, {"position": [-0.08373, -0.45354, 0.0], "rx": 0.01814, "rz": 0.01386, "twist": 0.0}], "radialSegments": 18, "capEnds": true});
  if (!endpoint_shin_plate_back_l_43) {
    mesh_shin_plate_back_l_43Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_shin_plate_back_l_43 = new THREE.Mesh(
    mesh_shin_plate_back_l_43Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_shin_plate_back_l_43.name = "Shin back plate L";
  if (endpoint_shin_plate_back_l_43) {
    mesh_shin_plate_back_l_43.position.copy(endpoint_shin_plate_back_l_43.midpoint);
    mesh_shin_plate_back_l_43.quaternion.copy(endpoint_shin_plate_back_l_43.quaternion);
  }
  mesh_shin_plate_back_l_43.castShadow = options.castShadow ?? true;
  mesh_shin_plate_back_l_43.receiveShadow = options.receiveShadow ?? true;
  mesh_shin_plate_back_l_43.userData.sculptComponent = { id: "shin-plate-back-l" };
  node_shin_plate_back_l_43.add(mesh_shin_plate_back_l_43);
  meshes["shin-plate-back-l"] = mesh_shin_plate_back_l_43;
  colliders["shin-plate-back-l"] = {};
  destructionGroups["leg-l"] ??= [];
  destructionGroups["leg-l"].push(node_shin_plate_back_l_43);

  const endpoint_ankle_l_44 = makeAttachmentEndpoint(null);
  const node_ankle_l_44 = new THREE.Group();
  node_ankle_l_44.name = "Ankle joint L__pivot";
  node_ankle_l_44.scale.set(1, 1, 1);
  if (endpoint_ankle_l_44) {
    node_ankle_l_44.position.copy(endpoint_ankle_l_44.start);
    node_ankle_l_44.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_ankle_l_44.position.set(0.07559, -0.40945, -0.0126);
    node_ankle_l_44.rotation.set(0.0, 0.0, 0.0);
  }
  node_ankle_l_44.userData.sculptComponent = { id: "ankle-l" };
  node_ankle_l_44.userData.actionProfile = {};
  (nodes["shin-l"] ?? root).add(node_ankle_l_44);
  nodes["ankle-l"] = node_ankle_l_44;
  const mesh_ankle_l_44Geometry = endpoint_ankle_l_44
    ? new THREE.CylinderGeometry(endpoint_ankle_l_44.endRadius, endpoint_ankle_l_44.baseRadius, endpoint_ankle_l_44.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_ankle_l_44) {
    mesh_ankle_l_44Geometry.scale(0.08189, 0.08189, 0.08189);
  }
  const mesh_ankle_l_44 = new THREE.Mesh(
    mesh_ankle_l_44Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ankle_l_44.name = "Ankle joint L";
  if (endpoint_ankle_l_44) {
    mesh_ankle_l_44.position.copy(endpoint_ankle_l_44.midpoint);
    mesh_ankle_l_44.quaternion.copy(endpoint_ankle_l_44.quaternion);
  }
  mesh_ankle_l_44.castShadow = options.castShadow ?? true;
  mesh_ankle_l_44.receiveShadow = options.receiveShadow ?? true;
  mesh_ankle_l_44.userData.sculptComponent = { id: "ankle-l" };
  node_ankle_l_44.add(mesh_ankle_l_44);
  meshes["ankle-l"] = mesh_ankle_l_44;
  colliders["ankle-l"] = {};
  destructionGroups["leg-l"] ??= [];
  destructionGroups["leg-l"].push(node_ankle_l_44);

  const endpoint_boot_l_45 = makeAttachmentEndpoint(null);
  const node_boot_l_45 = new THREE.Group();
  node_boot_l_45.name = "Boot L__pivot";
  node_boot_l_45.scale.set(1, 1, 1);
  if (endpoint_boot_l_45) {
    node_boot_l_45.position.copy(endpoint_boot_l_45.start);
    node_boot_l_45.rotation.set(0.0, 0.3, 0.0);
  } else {
    node_boot_l_45.position.set(0.10709, -0.56063, -0.11339);
    node_boot_l_45.rotation.set(0.0, 0.3, 0.0);
  }
  node_boot_l_45.userData.sculptComponent = { id: "boot-l" };
  node_boot_l_45.userData.actionProfile = {};
  (nodes["shin-l"] ?? root).add(node_boot_l_45);
  nodes["boot-l"] = node_boot_l_45;
  const mesh_boot_l_45Geometry = endpoint_boot_l_45
    ? new THREE.CylinderGeometry(endpoint_boot_l_45.endRadius, endpoint_boot_l_45.baseRadius, endpoint_boot_l_45.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.06299, "rz": 0.04724, "twist": 0.0}, {"position": [0.0, -0.0063, 0.07874], "rx": 0.08819, "rz": 0.05669, "twist": 0.0}, {"position": [0.0, -0.0126, 0.17323], "rx": 0.08819, "rz": 0.04094, "twist": 0.0}, {"position": [0.0, -0.0315, 0.25827], "rx": 0.06299, "rz": 0.0252, "twist": 0.0}, {"position": [0.0, -0.0378, 0.30236], "rx": 0.0315, "rz": 0.0126, "twist": 0.0}], "radialSegments": 20, "capEnds": true});
  if (!endpoint_boot_l_45) {
    mesh_boot_l_45Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_boot_l_45 = new THREE.Mesh(
    mesh_boot_l_45Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_boot_l_45.name = "Boot L";
  if (endpoint_boot_l_45) {
    mesh_boot_l_45.position.copy(endpoint_boot_l_45.midpoint);
    mesh_boot_l_45.quaternion.copy(endpoint_boot_l_45.quaternion);
  }
  mesh_boot_l_45.castShadow = options.castShadow ?? true;
  mesh_boot_l_45.receiveShadow = options.receiveShadow ?? true;
  mesh_boot_l_45.userData.sculptComponent = { id: "boot-l" };
  node_boot_l_45.add(mesh_boot_l_45);
  meshes["boot-l"] = mesh_boot_l_45;
  colliders["boot-l"] = {};
  destructionGroups["leg-l"] ??= [];
  destructionGroups["leg-l"].push(node_boot_l_45);

  const endpoint_boot_shaft_l_46 = makeAttachmentEndpoint(null);
  const node_boot_shaft_l_46 = new THREE.Group();
  node_boot_shaft_l_46.name = "Boot shaft L__pivot";
  node_boot_shaft_l_46.scale.set(1, 1, 1);
  if (endpoint_boot_shaft_l_46) {
    node_boot_shaft_l_46.position.copy(endpoint_boot_shaft_l_46.start);
    node_boot_shaft_l_46.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_boot_shaft_l_46.position.set(0.09449, -0.40945, -0.0063);
    node_boot_shaft_l_46.rotation.set(0.0, 0.0, 0.0);
  }
  node_boot_shaft_l_46.userData.sculptComponent = { id: "boot-shaft-l" };
  node_boot_shaft_l_46.userData.actionProfile = {};
  (nodes["shin-l"] ?? root).add(node_boot_shaft_l_46);
  nodes["boot-shaft-l"] = node_boot_shaft_l_46;
  const mesh_boot_shaft_l_46Geometry = endpoint_boot_shaft_l_46
    ? new THREE.CylinderGeometry(endpoint_boot_shaft_l_46.endRadius, endpoint_boot_shaft_l_46.baseRadius, endpoint_boot_shaft_l_46.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.0252, "rz": 0.0315, "twist": 0.0}, {"position": [0.0063, -0.07559, 0.0063], "rx": 0.04724, "rz": 0.08189, "twist": 0.0}, {"position": [0.0126, -0.15748, 0.0063], "rx": 0.0252, "rz": 0.0252, "twist": 0.0}], "radialSegments": 18, "capEnds": true});
  if (!endpoint_boot_shaft_l_46) {
    mesh_boot_shaft_l_46Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_boot_shaft_l_46 = new THREE.Mesh(
    mesh_boot_shaft_l_46Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_boot_shaft_l_46.name = "Boot shaft L";
  if (endpoint_boot_shaft_l_46) {
    mesh_boot_shaft_l_46.position.copy(endpoint_boot_shaft_l_46.midpoint);
    mesh_boot_shaft_l_46.quaternion.copy(endpoint_boot_shaft_l_46.quaternion);
  }
  mesh_boot_shaft_l_46.castShadow = options.castShadow ?? true;
  mesh_boot_shaft_l_46.receiveShadow = options.receiveShadow ?? true;
  mesh_boot_shaft_l_46.userData.sculptComponent = { id: "boot-shaft-l" };
  node_boot_shaft_l_46.add(mesh_boot_shaft_l_46);
  meshes["boot-shaft-l"] = mesh_boot_shaft_l_46;
  colliders["boot-shaft-l"] = {};
  destructionGroups["leg-l"] ??= [];
  destructionGroups["leg-l"].push(node_boot_shaft_l_46);

  const endpoint_boot_sole_l_47 = makeAttachmentEndpoint(null);
  const node_boot_sole_l_47 = new THREE.Group();
  node_boot_sole_l_47.name = "Boot sole L__pivot";
  node_boot_sole_l_47.scale.set(1, 1, 1);
  if (endpoint_boot_sole_l_47) {
    node_boot_sole_l_47.position.copy(endpoint_boot_sole_l_47.start);
    node_boot_sole_l_47.rotation.set(0.0, 0.3, 0.0);
  } else {
    node_boot_sole_l_47.position.set(0.10709, -0.60945, 0.0315);
    node_boot_sole_l_47.rotation.set(0.0, 0.3, 0.0);
  }
  node_boot_sole_l_47.userData.sculptComponent = { id: "boot-sole-l" };
  node_boot_sole_l_47.userData.actionProfile = {};
  (nodes["shin-l"] ?? root).add(node_boot_sole_l_47);
  nodes["boot-sole-l"] = node_boot_sole_l_47;
  const mesh_boot_sole_l_47Geometry = endpoint_boot_sole_l_47
    ? new THREE.CylinderGeometry(endpoint_boot_sole_l_47.endRadius, endpoint_boot_sole_l_47.baseRadius, endpoint_boot_sole_l_47.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_boot_sole_l_47) {
    mesh_boot_sole_l_47Geometry.scale(0.13858, 0.01575, 0.30236);
  }
  const mesh_boot_sole_l_47 = new THREE.Mesh(
    mesh_boot_sole_l_47Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_boot_sole_l_47.name = "Boot sole L";
  if (endpoint_boot_sole_l_47) {
    mesh_boot_sole_l_47.position.copy(endpoint_boot_sole_l_47.midpoint);
    mesh_boot_sole_l_47.quaternion.copy(endpoint_boot_sole_l_47.quaternion);
  }
  mesh_boot_sole_l_47.castShadow = options.castShadow ?? true;
  mesh_boot_sole_l_47.receiveShadow = options.receiveShadow ?? true;
  mesh_boot_sole_l_47.userData.sculptComponent = { id: "boot-sole-l" };
  node_boot_sole_l_47.add(mesh_boot_sole_l_47);
  meshes["boot-sole-l"] = mesh_boot_sole_l_47;
  colliders["boot-sole-l"] = {};
  destructionGroups["leg-l"] ??= [];
  destructionGroups["leg-l"].push(node_boot_sole_l_47);

  const endpoint_hip_joint_r_48 = makeAttachmentEndpoint(null);
  const node_hip_joint_r_48 = new THREE.Group();
  node_hip_joint_r_48.name = "Hip joint R__pivot";
  node_hip_joint_r_48.scale.set(1, 1, 1);
  if (endpoint_hip_joint_r_48) {
    node_hip_joint_r_48.position.copy(endpoint_hip_joint_r_48.start);
    node_hip_joint_r_48.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hip_joint_r_48.position.set(-0.10394, 0.07559, 0.0);
    node_hip_joint_r_48.rotation.set(0.0, 0.0, 0.0);
  }
  node_hip_joint_r_48.userData.sculptComponent = { id: "hip-joint-r" };
  node_hip_joint_r_48.userData.actionProfile = {};
  (nodes["pelvis"] ?? root).add(node_hip_joint_r_48);
  nodes["hip-joint-r"] = node_hip_joint_r_48;
  const mesh_hip_joint_r_48Geometry = endpoint_hip_joint_r_48
    ? new THREE.CylinderGeometry(endpoint_hip_joint_r_48.endRadius, endpoint_hip_joint_r_48.baseRadius, endpoint_hip_joint_r_48.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_hip_joint_r_48) {
    mesh_hip_joint_r_48Geometry.scale(0.10079, 0.10079, 0.10079);
  }
  const mesh_hip_joint_r_48 = new THREE.Mesh(
    mesh_hip_joint_r_48Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hip_joint_r_48.name = "Hip joint R";
  if (endpoint_hip_joint_r_48) {
    mesh_hip_joint_r_48.position.copy(endpoint_hip_joint_r_48.midpoint);
    mesh_hip_joint_r_48.quaternion.copy(endpoint_hip_joint_r_48.quaternion);
  }
  mesh_hip_joint_r_48.castShadow = options.castShadow ?? true;
  mesh_hip_joint_r_48.receiveShadow = options.receiveShadow ?? true;
  mesh_hip_joint_r_48.userData.sculptComponent = { id: "hip-joint-r" };
  node_hip_joint_r_48.add(mesh_hip_joint_r_48);
  meshes["hip-joint-r"] = mesh_hip_joint_r_48;
  colliders["hip-joint-r"] = {};
  destructionGroups["leg-r"] ??= [];
  destructionGroups["leg-r"].push(node_hip_joint_r_48);

  const attachment_thigh_r_49 = {"parentSocket": "pelvis-thigh-r", "localStart": [-0.10394, 0.07559, 0.0], "localEnd": [-0.13228, -0.4252, 0.0126], "contactType": "socket-joint", "baseRadius": 0.05354, "endRadius": 0.04724, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_thigh_r_49 = makeAttachmentEndpoint(attachment_thigh_r_49);
  const node_thigh_r_49 = new THREE.Group();
  node_thigh_r_49.name = "Thigh core R__pivot";
  node_thigh_r_49.scale.set(1, 1, 1);
  if (endpoint_thigh_r_49) {
    node_thigh_r_49.position.copy(endpoint_thigh_r_49.start);
    node_thigh_r_49.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_thigh_r_49.position.set(-0.10394, 0.07559, 0.0);
    node_thigh_r_49.rotation.set(0.0, 0.0, 0.0);
  }
  node_thigh_r_49.userData.sculptComponent = { id: "thigh-r" };
  node_thigh_r_49.userData.actionProfile = {};
  (nodes["pelvis"] ?? root).add(node_thigh_r_49);
  nodes["thigh-r"] = node_thigh_r_49;
  const mesh_thigh_r_49Geometry = endpoint_thigh_r_49
    ? new THREE.CylinderGeometry(endpoint_thigh_r_49.endRadius, endpoint_thigh_r_49.baseRadius, endpoint_thigh_r_49.length, 16, 6)
    : buildWatertightCapsule(0.35, 0.7, 8, 16, 1);
  if (!endpoint_thigh_r_49) {
    mesh_thigh_r_49Geometry.scale(0.10709, 0.50175, 0.10709);
  }
  const mesh_thigh_r_49 = new THREE.Mesh(
    mesh_thigh_r_49Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_thigh_r_49.name = "Thigh core R";
  if (endpoint_thigh_r_49) {
    mesh_thigh_r_49.position.copy(endpoint_thigh_r_49.midpoint);
    mesh_thigh_r_49.quaternion.copy(endpoint_thigh_r_49.quaternion);
  }
  mesh_thigh_r_49.castShadow = options.castShadow ?? true;
  mesh_thigh_r_49.receiveShadow = options.receiveShadow ?? true;
  mesh_thigh_r_49.userData.sculptComponent = { id: "thigh-r" };
  node_thigh_r_49.add(mesh_thigh_r_49);
  meshes["thigh-r"] = mesh_thigh_r_49;
  colliders["thigh-r"] = {};
  destructionGroups["leg-r"] ??= [];
  destructionGroups["leg-r"].push(node_thigh_r_49);

  const endpoint_thigh_plate_front_r_50 = makeAttachmentEndpoint(null);
  const node_thigh_plate_front_r_50 = new THREE.Group();
  node_thigh_plate_front_r_50.name = "Thigh front plate R__pivot";
  node_thigh_plate_front_r_50.scale.set(1, 1, 1);
  if (endpoint_thigh_plate_front_r_50) {
    node_thigh_plate_front_r_50.position.copy(endpoint_thigh_plate_front_r_50.start);
    node_thigh_plate_front_r_50.rotation.set(0.0, -0.0, 0.0);
  } else {
    node_thigh_plate_front_r_50.position.set(-0.00107, -0.0189, 0.06929);
    node_thigh_plate_front_r_50.rotation.set(0.0, -0.0, 0.0);
  }
  node_thigh_plate_front_r_50.userData.sculptComponent = { id: "thigh-plate-front-r" };
  node_thigh_plate_front_r_50.userData.actionProfile = {};
  (nodes["thigh-r"] ?? root).add(node_thigh_plate_front_r_50);
  nodes["thigh-plate-front-r"] = node_thigh_plate_front_r_50;
  const mesh_thigh_plate_front_r_50Geometry = endpoint_thigh_plate_front_r_50
    ? new THREE.CylinderGeometry(endpoint_thigh_plate_front_r_50.endRadius, endpoint_thigh_plate_front_r_50.baseRadius, endpoint_thigh_plate_front_r_50.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.01814, "rz": 0.01512, "twist": 0.0}, {"position": [-0.00556, -0.09827, 0.0], "rx": 0.02452, "rz": 0.05291, "twist": 0.0}, {"position": [-0.0153, -0.27024, 0.0], "rx": 0.02835, "rz": 0.07559, "twist": 0.0}, {"position": [-0.02364, -0.41764, 0.0], "rx": 0.02516, "rz": 0.05669, "twist": 0.0}, {"position": [-0.02781, -0.49134, 0.0], "rx": 0.01814, "rz": 0.01512, "twist": 0.0}], "radialSegments": 18, "capEnds": true});
  if (!endpoint_thigh_plate_front_r_50) {
    mesh_thigh_plate_front_r_50Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_thigh_plate_front_r_50 = new THREE.Mesh(
    mesh_thigh_plate_front_r_50Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_thigh_plate_front_r_50.name = "Thigh front plate R";
  if (endpoint_thigh_plate_front_r_50) {
    mesh_thigh_plate_front_r_50.position.copy(endpoint_thigh_plate_front_r_50.midpoint);
    mesh_thigh_plate_front_r_50.quaternion.copy(endpoint_thigh_plate_front_r_50.quaternion);
  }
  mesh_thigh_plate_front_r_50.castShadow = options.castShadow ?? true;
  mesh_thigh_plate_front_r_50.receiveShadow = options.receiveShadow ?? true;
  mesh_thigh_plate_front_r_50.userData.sculptComponent = { id: "thigh-plate-front-r" };
  node_thigh_plate_front_r_50.add(mesh_thigh_plate_front_r_50);
  meshes["thigh-plate-front-r"] = mesh_thigh_plate_front_r_50;
  colliders["thigh-plate-front-r"] = {};
  destructionGroups["leg-r"] ??= [];
  destructionGroups["leg-r"].push(node_thigh_plate_front_r_50);

  const endpoint_thigh_plate_outer_r_51 = makeAttachmentEndpoint(null);
  const node_thigh_plate_outer_r_51 = new THREE.Group();
  node_thigh_plate_outer_r_51.name = "Thigh outer plate R__pivot";
  node_thigh_plate_outer_r_51.scale.set(1, 1, 1);
  if (endpoint_thigh_plate_outer_r_51) {
    node_thigh_plate_outer_r_51.position.copy(endpoint_thigh_plate_outer_r_51.start);
    node_thigh_plate_outer_r_51.rotation.set(0.0, -1.01229, 0.0);
  } else {
    node_thigh_plate_outer_r_51.position.set(-0.06678, 0.0, 0.04173);
    node_thigh_plate_outer_r_51.rotation.set(0.0, -1.01229, 0.0);
  }
  node_thigh_plate_outer_r_51.userData.sculptComponent = { id: "thigh-plate-outer-r" };
  node_thigh_plate_outer_r_51.userData.actionProfile = {};
  (nodes["thigh-r"] ?? root).add(node_thigh_plate_outer_r_51);
  nodes["thigh-plate-outer-r"] = node_thigh_plate_outer_r_51;
  const mesh_thigh_plate_outer_r_51Geometry = endpoint_thigh_plate_outer_r_51
    ? new THREE.CylinderGeometry(endpoint_thigh_plate_outer_r_51.endRadius, endpoint_thigh_plate_outer_r_51.baseRadius, endpoint_thigh_plate_outer_r_51.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.01613, "rz": 0.01134, "twist": 0.0}, {"position": [-0.00299, -0.09953, 0.00478], "rx": 0.0218, "rz": 0.03969, "twist": 0.0}, {"position": [-0.00821, -0.2737, 0.01314], "rx": 0.0252, "rz": 0.05669, "twist": 0.0}, {"position": [-0.01269, -0.42299, 0.0203], "rx": 0.02236, "rz": 0.04252, "twist": 0.0}, {"position": [-0.01493, -0.49764, 0.02389], "rx": 0.01613, "rz": 0.01134, "twist": 0.0}], "radialSegments": 18, "capEnds": true});
  if (!endpoint_thigh_plate_outer_r_51) {
    mesh_thigh_plate_outer_r_51Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_thigh_plate_outer_r_51 = new THREE.Mesh(
    mesh_thigh_plate_outer_r_51Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_thigh_plate_outer_r_51.name = "Thigh outer plate R";
  if (endpoint_thigh_plate_outer_r_51) {
    mesh_thigh_plate_outer_r_51.position.copy(endpoint_thigh_plate_outer_r_51.midpoint);
    mesh_thigh_plate_outer_r_51.quaternion.copy(endpoint_thigh_plate_outer_r_51.quaternion);
  }
  mesh_thigh_plate_outer_r_51.castShadow = options.castShadow ?? true;
  mesh_thigh_plate_outer_r_51.receiveShadow = options.receiveShadow ?? true;
  mesh_thigh_plate_outer_r_51.userData.sculptComponent = { id: "thigh-plate-outer-r" };
  node_thigh_plate_outer_r_51.add(mesh_thigh_plate_outer_r_51);
  meshes["thigh-plate-outer-r"] = mesh_thigh_plate_outer_r_51;
  colliders["thigh-plate-outer-r"] = {};
  destructionGroups["leg-r"] ??= [];
  destructionGroups["leg-r"].push(node_thigh_plate_outer_r_51);

  const endpoint_thigh_plate_inner_r_52 = makeAttachmentEndpoint(null);
  const node_thigh_plate_inner_r_52 = new THREE.Group();
  node_thigh_plate_inner_r_52.name = "Thigh inner plate R__pivot";
  node_thigh_plate_inner_r_52.scale.set(1, 1, 1);
  if (endpoint_thigh_plate_inner_r_52) {
    node_thigh_plate_inner_r_52.position.copy(endpoint_thigh_plate_inner_r_52.start);
    node_thigh_plate_inner_r_52.rotation.set(0.0, 0.83776, 0.0);
  } else {
    node_thigh_plate_inner_r_52.position.set(0.04666, -0.04409, 0.04426);
    node_thigh_plate_inner_r_52.rotation.set(0.0, 0.83776, 0.0);
  }
  node_thigh_plate_inner_r_52.userData.sculptComponent = { id: "thigh-plate-inner-r" };
  node_thigh_plate_inner_r_52.userData.actionProfile = {};
  (nodes["thigh-r"] ?? root).add(node_thigh_plate_inner_r_52);
  nodes["thigh-plate-inner-r"] = node_thigh_plate_inner_r_52;
  const mesh_thigh_plate_inner_r_52Geometry = endpoint_thigh_plate_inner_r_52
    ? new THREE.CylinderGeometry(endpoint_thigh_plate_inner_r_52.endRadius, endpoint_thigh_plate_inner_r_52.baseRadius, endpoint_thigh_plate_inner_r_52.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.01613, "rz": 0.00819, "twist": 0.0}, {"position": [-0.00286, -0.07559, -0.00318], "rx": 0.0218, "rz": 0.02866, "twist": 0.0}, {"position": [-0.00787, -0.20787, -0.00874], "rx": 0.0252, "rz": 0.04094, "twist": 0.0}, {"position": [-0.01217, -0.32126, -0.01351], "rx": 0.02236, "rz": 0.03071, "twist": 0.0}, {"position": [-0.01432, -0.37795, -0.0159], "rx": 0.01613, "rz": 0.00819, "twist": 0.0}], "radialSegments": 18, "capEnds": true});
  if (!endpoint_thigh_plate_inner_r_52) {
    mesh_thigh_plate_inner_r_52Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_thigh_plate_inner_r_52 = new THREE.Mesh(
    mesh_thigh_plate_inner_r_52Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_thigh_plate_inner_r_52.name = "Thigh inner plate R";
  if (endpoint_thigh_plate_inner_r_52) {
    mesh_thigh_plate_inner_r_52.position.copy(endpoint_thigh_plate_inner_r_52.midpoint);
    mesh_thigh_plate_inner_r_52.quaternion.copy(endpoint_thigh_plate_inner_r_52.quaternion);
  }
  mesh_thigh_plate_inner_r_52.castShadow = options.castShadow ?? true;
  mesh_thigh_plate_inner_r_52.receiveShadow = options.receiveShadow ?? true;
  mesh_thigh_plate_inner_r_52.userData.sculptComponent = { id: "thigh-plate-inner-r" };
  node_thigh_plate_inner_r_52.add(mesh_thigh_plate_inner_r_52);
  meshes["thigh-plate-inner-r"] = mesh_thigh_plate_inner_r_52;
  colliders["thigh-plate-inner-r"] = {};
  destructionGroups["leg-r"] ??= [];
  destructionGroups["leg-r"].push(node_thigh_plate_inner_r_52);

  const endpoint_thigh_plate_back_r_53 = makeAttachmentEndpoint(null);
  const node_thigh_plate_back_r_53 = new THREE.Group();
  node_thigh_plate_back_r_53.name = "Thigh back plate R__pivot";
  node_thigh_plate_back_r_53.scale.set(1, 1, 1);
  if (endpoint_thigh_plate_back_r_53) {
    node_thigh_plate_back_r_53.position.copy(endpoint_thigh_plate_back_r_53.start);
    node_thigh_plate_back_r_53.rotation.set(0.0, -3.14159, 0.0);
  } else {
    node_thigh_plate_back_r_53.position.set(-0.00107, -0.0189, -0.06929);
    node_thigh_plate_back_r_53.rotation.set(0.0, -3.14159, 0.0);
  }
  node_thigh_plate_back_r_53.userData.sculptComponent = { id: "thigh-plate-back-r" };
  node_thigh_plate_back_r_53.userData.actionProfile = {};
  (nodes["thigh-r"] ?? root).add(node_thigh_plate_back_r_53);
  nodes["thigh-plate-back-r"] = node_thigh_plate_back_r_53;
  const mesh_thigh_plate_back_r_53Geometry = endpoint_thigh_plate_back_r_53
    ? new THREE.CylinderGeometry(endpoint_thigh_plate_back_r_53.endRadius, endpoint_thigh_plate_back_r_53.baseRadius, endpoint_thigh_plate_back_r_53.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, -0.0], "rx": 0.01814, "rz": 0.01386, "twist": 0.0}, {"position": [0.00542, -0.09575, 0.0], "rx": 0.02452, "rz": 0.0485, "twist": 0.0}, {"position": [0.0149, -0.26331, 0.0], "rx": 0.02835, "rz": 0.06929, "twist": 0.0}, {"position": [0.02303, -0.40693, 0.0], "rx": 0.02516, "rz": 0.05197, "twist": 0.0}, {"position": [0.0271, -0.47874, 0.0], "rx": 0.01814, "rz": 0.01386, "twist": 0.0}], "radialSegments": 18, "capEnds": true});
  if (!endpoint_thigh_plate_back_r_53) {
    mesh_thigh_plate_back_r_53Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_thigh_plate_back_r_53 = new THREE.Mesh(
    mesh_thigh_plate_back_r_53Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_thigh_plate_back_r_53.name = "Thigh back plate R";
  if (endpoint_thigh_plate_back_r_53) {
    mesh_thigh_plate_back_r_53.position.copy(endpoint_thigh_plate_back_r_53.midpoint);
    mesh_thigh_plate_back_r_53.quaternion.copy(endpoint_thigh_plate_back_r_53.quaternion);
  }
  mesh_thigh_plate_back_r_53.castShadow = options.castShadow ?? true;
  mesh_thigh_plate_back_r_53.receiveShadow = options.receiveShadow ?? true;
  mesh_thigh_plate_back_r_53.userData.sculptComponent = { id: "thigh-plate-back-r" };
  node_thigh_plate_back_r_53.add(mesh_thigh_plate_back_r_53);
  meshes["thigh-plate-back-r"] = mesh_thigh_plate_back_r_53;
  colliders["thigh-plate-back-r"] = {};
  destructionGroups["leg-r"] ??= [];
  destructionGroups["leg-r"].push(node_thigh_plate_back_r_53);

  const endpoint_thigh_plate_backout_r_54 = makeAttachmentEndpoint(null);
  const node_thigh_plate_backout_r_54 = new THREE.Group();
  node_thigh_plate_backout_r_54.name = "Thigh backout plate R__pivot";
  node_thigh_plate_backout_r_54.scale.set(1, 1, 1);
  if (endpoint_thigh_plate_backout_r_54) {
    node_thigh_plate_backout_r_54.position.copy(endpoint_thigh_plate_backout_r_54.start);
    node_thigh_plate_backout_r_54.rotation.set(0.0, -2.18166, 0.0);
  } else {
    node_thigh_plate_backout_r_54.position.set(-0.06184, -0.04409, -0.04155);
    node_thigh_plate_backout_r_54.rotation.set(0.0, -2.18166, 0.0);
  }
  node_thigh_plate_backout_r_54.userData.sculptComponent = { id: "thigh-plate-backout-r" };
  node_thigh_plate_backout_r_54.userData.actionProfile = {};
  (nodes["thigh-r"] ?? root).add(node_thigh_plate_backout_r_54);
  nodes["thigh-plate-backout-r"] = node_thigh_plate_backout_r_54;
  const mesh_thigh_plate_backout_r_54Geometry = endpoint_thigh_plate_backout_r_54
    ? new THREE.CylinderGeometry(endpoint_thigh_plate_backout_r_54.endRadius, endpoint_thigh_plate_backout_r_54.baseRadius, endpoint_thigh_plate_backout_r_54.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, -0.0], "rx": 0.01613, "rz": 0.01008, "twist": 0.0}, {"position": [0.00266, -0.08189, 0.0038], "rx": 0.0218, "rz": 0.03528, "twist": 0.0}, {"position": [0.00731, -0.2252, 0.01044], "rx": 0.0252, "rz": 0.05039, "twist": 0.0}, {"position": [0.0113, -0.34803, 0.01614], "rx": 0.02236, "rz": 0.0378, "twist": 0.0}, {"position": [0.01329, -0.40945, 0.01898], "rx": 0.01613, "rz": 0.01008, "twist": 0.0}], "radialSegments": 18, "capEnds": true});
  if (!endpoint_thigh_plate_backout_r_54) {
    mesh_thigh_plate_backout_r_54Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_thigh_plate_backout_r_54 = new THREE.Mesh(
    mesh_thigh_plate_backout_r_54Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_thigh_plate_backout_r_54.name = "Thigh backout plate R";
  if (endpoint_thigh_plate_backout_r_54) {
    mesh_thigh_plate_backout_r_54.position.copy(endpoint_thigh_plate_backout_r_54.midpoint);
    mesh_thigh_plate_backout_r_54.quaternion.copy(endpoint_thigh_plate_backout_r_54.quaternion);
  }
  mesh_thigh_plate_backout_r_54.castShadow = options.castShadow ?? true;
  mesh_thigh_plate_backout_r_54.receiveShadow = options.receiveShadow ?? true;
  mesh_thigh_plate_backout_r_54.userData.sculptComponent = { id: "thigh-plate-backout-r" };
  node_thigh_plate_backout_r_54.add(mesh_thigh_plate_backout_r_54);
  meshes["thigh-plate-backout-r"] = mesh_thigh_plate_backout_r_54;
  colliders["thigh-plate-backout-r"] = {};
  destructionGroups["leg-r"] ??= [];
  destructionGroups["leg-r"].push(node_thigh_plate_backout_r_54);

  const endpoint_knee_r_55 = makeAttachmentEndpoint(null);
  const node_knee_r_55 = new THREE.Group();
  node_knee_r_55.name = "Knee joint R__pivot";
  node_knee_r_55.scale.set(1, 1, 1);
  if (endpoint_knee_r_55) {
    node_knee_r_55.position.copy(endpoint_knee_r_55.start);
    node_knee_r_55.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_knee_r_55.position.set(-0.02835, -0.50394, 0.0189);
    node_knee_r_55.rotation.set(0.0, 0.0, 0.0);
  }
  node_knee_r_55.userData.sculptComponent = { id: "knee-r" };
  node_knee_r_55.userData.actionProfile = {};
  (nodes["thigh-r"] ?? root).add(node_knee_r_55);
  nodes["knee-r"] = node_knee_r_55;
  const mesh_knee_r_55Geometry = endpoint_knee_r_55
    ? new THREE.CylinderGeometry(endpoint_knee_r_55.endRadius, endpoint_knee_r_55.baseRadius, endpoint_knee_r_55.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_knee_r_55) {
    mesh_knee_r_55Geometry.scale(0.10709, 0.10709, 0.10709);
  }
  const mesh_knee_r_55 = new THREE.Mesh(
    mesh_knee_r_55Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_knee_r_55.name = "Knee joint R";
  if (endpoint_knee_r_55) {
    mesh_knee_r_55.position.copy(endpoint_knee_r_55.midpoint);
    mesh_knee_r_55.quaternion.copy(endpoint_knee_r_55.quaternion);
  }
  mesh_knee_r_55.castShadow = options.castShadow ?? true;
  mesh_knee_r_55.receiveShadow = options.receiveShadow ?? true;
  mesh_knee_r_55.userData.sculptComponent = { id: "knee-r" };
  node_knee_r_55.add(mesh_knee_r_55);
  meshes["knee-r"] = mesh_knee_r_55;
  colliders["knee-r"] = {};
  destructionGroups["leg-r"] ??= [];
  destructionGroups["leg-r"].push(node_knee_r_55);

  const endpoint_knee_glow_r_56 = makeAttachmentEndpoint(null);
  const node_knee_glow_r_56 = new THREE.Group();
  node_knee_glow_r_56.name = "Knee glow R__pivot";
  node_knee_glow_r_56.scale.set(1, 1, 1);
  if (endpoint_knee_glow_r_56) {
    node_knee_glow_r_56.position.copy(endpoint_knee_glow_r_56.start);
    node_knee_glow_r_56.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_knee_glow_r_56.position.set(-0.02835, -0.61102, 0.06929);
    node_knee_glow_r_56.rotation.set(0.0, 0.0, 0.0);
  }
  node_knee_glow_r_56.userData.sculptComponent = { id: "knee-glow-r" };
  node_knee_glow_r_56.userData.actionProfile = {};
  (nodes["thigh-r"] ?? root).add(node_knee_glow_r_56);
  nodes["knee-glow-r"] = node_knee_glow_r_56;
  const mesh_knee_glow_r_56Geometry = endpoint_knee_glow_r_56
    ? new THREE.CylinderGeometry(endpoint_knee_glow_r_56.endRadius, endpoint_knee_glow_r_56.baseRadius, endpoint_knee_glow_r_56.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_knee_glow_r_56) {
    mesh_knee_glow_r_56Geometry.scale(0.08819, 0.02835, 0.02205);
  }
  const mesh_knee_glow_r_56 = new THREE.Mesh(
    mesh_knee_glow_r_56Geometry,
    materialMap["emissive-blue"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_knee_glow_r_56.name = "Knee glow R";
  if (endpoint_knee_glow_r_56) {
    mesh_knee_glow_r_56.position.copy(endpoint_knee_glow_r_56.midpoint);
    mesh_knee_glow_r_56.quaternion.copy(endpoint_knee_glow_r_56.quaternion);
  }
  mesh_knee_glow_r_56.castShadow = options.castShadow ?? true;
  mesh_knee_glow_r_56.receiveShadow = options.receiveShadow ?? true;
  mesh_knee_glow_r_56.userData.sculptComponent = { id: "knee-glow-r" };
  node_knee_glow_r_56.add(mesh_knee_glow_r_56);
  meshes["knee-glow-r"] = mesh_knee_glow_r_56;
  colliders["knee-glow-r"] = {};
  destructionGroups["leg-r"] ??= [];
  destructionGroups["leg-r"].push(node_knee_glow_r_56);

  const endpoint_hip_glow_r_57 = makeAttachmentEndpoint(null);
  const node_hip_glow_r_57 = new THREE.Group();
  node_hip_glow_r_57.name = "Hip glow R__pivot";
  node_hip_glow_r_57.scale.set(1, 1, 1);
  if (endpoint_hip_glow_r_57) {
    node_hip_glow_r_57.position.copy(endpoint_hip_glow_r_57.start);
    node_hip_glow_r_57.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hip_glow_r_57.position.set(-0.10079, 0.08819, 0.09449);
    node_hip_glow_r_57.rotation.set(0.0, 0.0, 0.0);
  }
  node_hip_glow_r_57.userData.sculptComponent = { id: "hip-glow-r" };
  node_hip_glow_r_57.userData.actionProfile = {};
  (nodes["pelvis"] ?? root).add(node_hip_glow_r_57);
  nodes["hip-glow-r"] = node_hip_glow_r_57;
  const mesh_hip_glow_r_57Geometry = endpoint_hip_glow_r_57
    ? new THREE.CylinderGeometry(endpoint_hip_glow_r_57.endRadius, endpoint_hip_glow_r_57.baseRadius, endpoint_hip_glow_r_57.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_hip_glow_r_57) {
    mesh_hip_glow_r_57Geometry.scale(0.04409, 0.02835, 0.0189);
  }
  const mesh_hip_glow_r_57 = new THREE.Mesh(
    mesh_hip_glow_r_57Geometry,
    materialMap["emissive-blue"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hip_glow_r_57.name = "Hip glow R";
  if (endpoint_hip_glow_r_57) {
    mesh_hip_glow_r_57.position.copy(endpoint_hip_glow_r_57.midpoint);
    mesh_hip_glow_r_57.quaternion.copy(endpoint_hip_glow_r_57.quaternion);
  }
  mesh_hip_glow_r_57.castShadow = options.castShadow ?? true;
  mesh_hip_glow_r_57.receiveShadow = options.receiveShadow ?? true;
  mesh_hip_glow_r_57.userData.sculptComponent = { id: "hip-glow-r" };
  node_hip_glow_r_57.add(mesh_hip_glow_r_57);
  meshes["hip-glow-r"] = mesh_hip_glow_r_57;
  colliders["hip-glow-r"] = {};
  destructionGroups["leg-r"] ??= [];
  destructionGroups["leg-r"].push(node_hip_glow_r_57);

  const attachment_shin_r_58 = {"parentSocket": "thigh-r-shin-r", "localStart": [-0.02835, -0.50394, 0.0189], "localEnd": [-0.10394, -0.91339, 0.0063], "contactType": "hinge-joint", "baseRadius": 0.04409, "endRadius": 0.03465, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_shin_r_58 = makeAttachmentEndpoint(attachment_shin_r_58);
  const node_shin_r_58 = new THREE.Group();
  node_shin_r_58.name = "Shin core R__pivot";
  node_shin_r_58.scale.set(1, 1, 1);
  if (endpoint_shin_r_58) {
    node_shin_r_58.position.copy(endpoint_shin_r_58.start);
    node_shin_r_58.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_shin_r_58.position.set(-0.02835, -0.50394, 0.0189);
    node_shin_r_58.rotation.set(0.0, 0.0, 0.0);
  }
  node_shin_r_58.userData.sculptComponent = { id: "shin-r" };
  node_shin_r_58.userData.actionProfile = {};
  (nodes["thigh-r"] ?? root).add(node_shin_r_58);
  nodes["shin-r"] = node_shin_r_58;
  const mesh_shin_r_58Geometry = endpoint_shin_r_58
    ? new THREE.CylinderGeometry(endpoint_shin_r_58.endRadius, endpoint_shin_r_58.baseRadius, endpoint_shin_r_58.length, 16, 6)
    : buildWatertightCapsule(0.35, 0.7, 8, 16, 1);
  if (!endpoint_shin_r_58) {
    mesh_shin_r_58Geometry.scale(0.08819, 0.41656, 0.08819);
  }
  const mesh_shin_r_58 = new THREE.Mesh(
    mesh_shin_r_58Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_shin_r_58.name = "Shin core R";
  if (endpoint_shin_r_58) {
    mesh_shin_r_58.position.copy(endpoint_shin_r_58.midpoint);
    mesh_shin_r_58.quaternion.copy(endpoint_shin_r_58.quaternion);
  }
  mesh_shin_r_58.castShadow = options.castShadow ?? true;
  mesh_shin_r_58.receiveShadow = options.receiveShadow ?? true;
  mesh_shin_r_58.userData.sculptComponent = { id: "shin-r" };
  node_shin_r_58.add(mesh_shin_r_58);
  meshes["shin-r"] = mesh_shin_r_58;
  colliders["shin-r"] = {};
  destructionGroups["leg-r"] ??= [];
  destructionGroups["leg-r"].push(node_shin_r_58);

  const endpoint_shin_spur_r_59 = makeAttachmentEndpoint(null);
  const node_shin_spur_r_59 = new THREE.Group();
  node_shin_spur_r_59.name = "Shin spur R__pivot";
  node_shin_spur_r_59.scale.set(1, 1, 1);
  if (endpoint_shin_spur_r_59) {
    node_shin_spur_r_59.position.copy(endpoint_shin_spur_r_59.start);
    node_shin_spur_r_59.rotation.set(0.0, -0.0, 0.0);
  } else {
    node_shin_spur_r_59.position.set(-0.07559, -0.18898, 0.0);
    node_shin_spur_r_59.rotation.set(0.0, -0.0, 0.0);
  }
  node_shin_spur_r_59.userData.sculptComponent = { id: "shin-spur-r" };
  node_shin_spur_r_59.userData.actionProfile = {};
  (nodes["shin-r"] ?? root).add(node_shin_spur_r_59);
  nodes["shin-spur-r"] = node_shin_spur_r_59;
  const mesh_shin_spur_r_59Geometry = endpoint_shin_spur_r_59
    ? new THREE.CylinderGeometry(endpoint_shin_spur_r_59.endRadius, endpoint_shin_spur_r_59.baseRadius, endpoint_shin_spur_r_59.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.0189, "rz": 0.02205, "twist": 0.0}, {"position": [-0.0252, 0.08189, -0.00315], "rx": 0.01417, "rz": 0.01575, "twist": 0.0}, {"position": [-0.05039, 0.18268, -0.0063], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 14, "capEnds": true});
  if (!endpoint_shin_spur_r_59) {
    mesh_shin_spur_r_59Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_shin_spur_r_59 = new THREE.Mesh(
    mesh_shin_spur_r_59Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_shin_spur_r_59.name = "Shin spur R";
  if (endpoint_shin_spur_r_59) {
    mesh_shin_spur_r_59.position.copy(endpoint_shin_spur_r_59.midpoint);
    mesh_shin_spur_r_59.quaternion.copy(endpoint_shin_spur_r_59.quaternion);
  }
  mesh_shin_spur_r_59.castShadow = options.castShadow ?? true;
  mesh_shin_spur_r_59.receiveShadow = options.receiveShadow ?? true;
  mesh_shin_spur_r_59.userData.sculptComponent = { id: "shin-spur-r" };
  node_shin_spur_r_59.add(mesh_shin_spur_r_59);
  meshes["shin-spur-r"] = mesh_shin_spur_r_59;
  colliders["shin-spur-r"] = {};
  destructionGroups["leg-r"] ??= [];
  destructionGroups["leg-r"].push(node_shin_spur_r_59);

  const endpoint_shin_plate_front_r_60 = makeAttachmentEndpoint(null);
  const node_shin_plate_front_r_60 = new THREE.Group();
  node_shin_plate_front_r_60.name = "Shin front plate R__pivot";
  node_shin_plate_front_r_60.scale.set(1, 1, 1);
  if (endpoint_shin_plate_front_r_60) {
    node_shin_plate_front_r_60.position.copy(endpoint_shin_plate_front_r_60.start);
    node_shin_plate_front_r_60.rotation.set(0.0, -0.0, 0.0);
  } else {
    node_shin_plate_front_r_60.position.set(-0.00233, -0.0126, 0.04094);
    node_shin_plate_front_r_60.rotation.set(0.0, -0.0, 0.0);
  }
  node_shin_plate_front_r_60.userData.sculptComponent = { id: "shin-plate-front-r" };
  node_shin_plate_front_r_60.userData.actionProfile = {};
  (nodes["shin-r"] ?? root).add(node_shin_plate_front_r_60);
  nodes["shin-plate-front-r"] = node_shin_plate_front_r_60;
  const mesh_shin_plate_front_r_60Geometry = endpoint_shin_plate_front_r_60
    ? new THREE.CylinderGeometry(endpoint_shin_plate_front_r_60.endRadius, endpoint_shin_plate_front_r_60.baseRadius, endpoint_shin_plate_front_r_60.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.01814, "rz": 0.01512, "twist": 0.0}, {"position": [-0.01768, -0.09575, 0.0], "rx": 0.02452, "rz": 0.05291, "twist": 0.0}, {"position": [-0.04861, -0.26331, 0.0], "rx": 0.02835, "rz": 0.07559, "twist": 0.0}, {"position": [-0.07513, -0.40693, 0.0], "rx": 0.02516, "rz": 0.05669, "twist": 0.0}, {"position": [-0.08838, -0.47874, 0.0], "rx": 0.01814, "rz": 0.01512, "twist": 0.0}], "radialSegments": 18, "capEnds": true});
  if (!endpoint_shin_plate_front_r_60) {
    mesh_shin_plate_front_r_60Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_shin_plate_front_r_60 = new THREE.Mesh(
    mesh_shin_plate_front_r_60Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_shin_plate_front_r_60.name = "Shin front plate R";
  if (endpoint_shin_plate_front_r_60) {
    mesh_shin_plate_front_r_60.position.copy(endpoint_shin_plate_front_r_60.midpoint);
    mesh_shin_plate_front_r_60.quaternion.copy(endpoint_shin_plate_front_r_60.quaternion);
  }
  mesh_shin_plate_front_r_60.castShadow = options.castShadow ?? true;
  mesh_shin_plate_front_r_60.receiveShadow = options.receiveShadow ?? true;
  mesh_shin_plate_front_r_60.userData.sculptComponent = { id: "shin-plate-front-r" };
  node_shin_plate_front_r_60.add(mesh_shin_plate_front_r_60);
  meshes["shin-plate-front-r"] = mesh_shin_plate_front_r_60;
  colliders["shin-plate-front-r"] = {};
  destructionGroups["leg-r"] ??= [];
  destructionGroups["leg-r"].push(node_shin_plate_front_r_60);

  const endpoint_shin_plate_outer_r_61 = makeAttachmentEndpoint(null);
  const node_shin_plate_outer_r_61 = new THREE.Group();
  node_shin_plate_outer_r_61.name = "Shin outer plate R__pivot";
  node_shin_plate_outer_r_61.scale.set(1, 1, 1);
  if (endpoint_shin_plate_outer_r_61) {
    node_shin_plate_outer_r_61.position.copy(endpoint_shin_plate_outer_r_61.start);
    node_shin_plate_outer_r_61.rotation.set(0.0, -1.0472, 0.0);
  } else {
    node_shin_plate_outer_r_61.position.set(-0.06935, -0.0063, 0.02047);
    node_shin_plate_outer_r_61.rotation.set(0.0, -1.0472, 0.0);
  }
  node_shin_plate_outer_r_61.userData.sculptComponent = { id: "shin-plate-outer-r" };
  node_shin_plate_outer_r_61.userData.actionProfile = {};
  (nodes["shin-r"] ?? root).add(node_shin_plate_outer_r_61);
  nodes["shin-plate-outer-r"] = node_shin_plate_outer_r_61;
  const mesh_shin_plate_outer_r_61Geometry = endpoint_shin_plate_outer_r_61
    ? new THREE.CylinderGeometry(endpoint_shin_plate_outer_r_61.endRadius, endpoint_shin_plate_outer_r_61.baseRadius, endpoint_shin_plate_outer_r_61.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.01613, "rz": 0.01134, "twist": 0.0}, {"position": [-0.00744, -0.08063, 0.01289], "rx": 0.0218, "rz": 0.03969, "twist": 0.0}, {"position": [-0.02047, -0.22173, 0.03545], "rx": 0.0252, "rz": 0.05669, "twist": 0.0}, {"position": [-0.03163, -0.34268, 0.05479], "rx": 0.02236, "rz": 0.04252, "twist": 0.0}, {"position": [-0.03721, -0.40315, 0.06446], "rx": 0.01613, "rz": 0.01134, "twist": 0.0}], "radialSegments": 18, "capEnds": true});
  if (!endpoint_shin_plate_outer_r_61) {
    mesh_shin_plate_outer_r_61Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_shin_plate_outer_r_61 = new THREE.Mesh(
    mesh_shin_plate_outer_r_61Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_shin_plate_outer_r_61.name = "Shin outer plate R";
  if (endpoint_shin_plate_outer_r_61) {
    mesh_shin_plate_outer_r_61.position.copy(endpoint_shin_plate_outer_r_61.midpoint);
    mesh_shin_plate_outer_r_61.quaternion.copy(endpoint_shin_plate_outer_r_61.quaternion);
  }
  mesh_shin_plate_outer_r_61.castShadow = options.castShadow ?? true;
  mesh_shin_plate_outer_r_61.receiveShadow = options.receiveShadow ?? true;
  mesh_shin_plate_outer_r_61.userData.sculptComponent = { id: "shin-plate-outer-r" };
  node_shin_plate_outer_r_61.add(mesh_shin_plate_outer_r_61);
  meshes["shin-plate-outer-r"] = mesh_shin_plate_outer_r_61;
  colliders["shin-plate-outer-r"] = {};
  destructionGroups["leg-r"] ??= [];
  destructionGroups["leg-r"].push(node_shin_plate_outer_r_61);

  const endpoint_shin_plate_inner_r_62 = makeAttachmentEndpoint(null);
  const node_shin_plate_inner_r_62 = new THREE.Group();
  node_shin_plate_inner_r_62.name = "Shin inner plate R__pivot";
  node_shin_plate_inner_r_62.scale.set(1, 1, 1);
  if (endpoint_shin_plate_inner_r_62) {
    node_shin_plate_inner_r_62.position.copy(endpoint_shin_plate_inner_r_62.start);
    node_shin_plate_inner_r_62.rotation.set(0.0, 0.87266, 0.0);
  } else {
    node_shin_plate_inner_r_62.position.set(0.03305, -0.06929, 0.01957);
    node_shin_plate_inner_r_62.rotation.set(0.0, 0.87266, 0.0);
  }
  node_shin_plate_inner_r_62.userData.sculptComponent = { id: "shin-plate-inner-r" };
  node_shin_plate_inner_r_62.userData.actionProfile = {};
  (nodes["shin-r"] ?? root).add(node_shin_plate_inner_r_62);
  nodes["shin-plate-inner-r"] = node_shin_plate_inner_r_62;
  const mesh_shin_plate_inner_r_62Geometry = endpoint_shin_plate_inner_r_62
    ? new THREE.CylinderGeometry(endpoint_shin_plate_inner_r_62.endRadius, endpoint_shin_plate_inner_r_62.baseRadius, endpoint_shin_plate_inner_r_62.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.01411, "rz": 0.00756, "twist": 0.0}, {"position": [-0.00703, -0.05921, -0.00837], "rx": 0.01907, "rz": 0.02646, "twist": 0.0}, {"position": [-0.01932, -0.16283, -0.02303], "rx": 0.02205, "rz": 0.0378, "twist": 0.0}, {"position": [-0.02986, -0.25165, -0.03559], "rx": 0.01957, "rz": 0.02835, "twist": 0.0}, {"position": [-0.03513, -0.29606, -0.04187], "rx": 0.01411, "rz": 0.00756, "twist": 0.0}], "radialSegments": 18, "capEnds": true});
  if (!endpoint_shin_plate_inner_r_62) {
    mesh_shin_plate_inner_r_62Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_shin_plate_inner_r_62 = new THREE.Mesh(
    mesh_shin_plate_inner_r_62Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_shin_plate_inner_r_62.name = "Shin inner plate R";
  if (endpoint_shin_plate_inner_r_62) {
    mesh_shin_plate_inner_r_62.position.copy(endpoint_shin_plate_inner_r_62.midpoint);
    mesh_shin_plate_inner_r_62.quaternion.copy(endpoint_shin_plate_inner_r_62.quaternion);
  }
  mesh_shin_plate_inner_r_62.castShadow = options.castShadow ?? true;
  mesh_shin_plate_inner_r_62.receiveShadow = options.receiveShadow ?? true;
  mesh_shin_plate_inner_r_62.userData.sculptComponent = { id: "shin-plate-inner-r" };
  node_shin_plate_inner_r_62.add(mesh_shin_plate_inner_r_62);
  meshes["shin-plate-inner-r"] = mesh_shin_plate_inner_r_62;
  colliders["shin-plate-inner-r"] = {};
  destructionGroups["leg-r"] ??= [];
  destructionGroups["leg-r"].push(node_shin_plate_inner_r_62);

  const endpoint_shin_plate_back_r_63 = makeAttachmentEndpoint(null);
  const node_shin_plate_back_r_63 = new THREE.Group();
  node_shin_plate_back_r_63.name = "Shin back plate R__pivot";
  node_shin_plate_back_r_63.scale.set(1, 1, 1);
  if (endpoint_shin_plate_back_r_63) {
    node_shin_plate_back_r_63.position.copy(endpoint_shin_plate_back_r_63.start);
    node_shin_plate_back_r_63.rotation.set(0.0, -3.14159, 0.0);
  } else {
    node_shin_plate_back_r_63.position.set(-0.00465, -0.0252, -0.07874);
    node_shin_plate_back_r_63.rotation.set(0.0, -3.14159, 0.0);
  }
  node_shin_plate_back_r_63.userData.sculptComponent = { id: "shin-plate-back-r" };
  node_shin_plate_back_r_63.userData.actionProfile = {};
  (nodes["shin-r"] ?? root).add(node_shin_plate_back_r_63);
  nodes["shin-plate-back-r"] = node_shin_plate_back_r_63;
  const mesh_shin_plate_back_r_63Geometry = endpoint_shin_plate_back_r_63
    ? new THREE.CylinderGeometry(endpoint_shin_plate_back_r_63.endRadius, endpoint_shin_plate_back_r_63.baseRadius, endpoint_shin_plate_back_r_63.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, -0.0], "rx": 0.01814, "rz": 0.01386, "twist": 0.0}, {"position": [0.01675, -0.09071, 0.0], "rx": 0.02452, "rz": 0.0485, "twist": 0.0}, {"position": [0.04605, -0.24945, 0.0], "rx": 0.02835, "rz": 0.06929, "twist": 0.0}, {"position": [0.07117, -0.38551, 0.0], "rx": 0.02516, "rz": 0.05197, "twist": 0.0}, {"position": [0.08373, -0.45354, 0.0], "rx": 0.01814, "rz": 0.01386, "twist": 0.0}], "radialSegments": 18, "capEnds": true});
  if (!endpoint_shin_plate_back_r_63) {
    mesh_shin_plate_back_r_63Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_shin_plate_back_r_63 = new THREE.Mesh(
    mesh_shin_plate_back_r_63Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_shin_plate_back_r_63.name = "Shin back plate R";
  if (endpoint_shin_plate_back_r_63) {
    mesh_shin_plate_back_r_63.position.copy(endpoint_shin_plate_back_r_63.midpoint);
    mesh_shin_plate_back_r_63.quaternion.copy(endpoint_shin_plate_back_r_63.quaternion);
  }
  mesh_shin_plate_back_r_63.castShadow = options.castShadow ?? true;
  mesh_shin_plate_back_r_63.receiveShadow = options.receiveShadow ?? true;
  mesh_shin_plate_back_r_63.userData.sculptComponent = { id: "shin-plate-back-r" };
  node_shin_plate_back_r_63.add(mesh_shin_plate_back_r_63);
  meshes["shin-plate-back-r"] = mesh_shin_plate_back_r_63;
  colliders["shin-plate-back-r"] = {};
  destructionGroups["leg-r"] ??= [];
  destructionGroups["leg-r"].push(node_shin_plate_back_r_63);

  const endpoint_ankle_r_64 = makeAttachmentEndpoint(null);
  const node_ankle_r_64 = new THREE.Group();
  node_ankle_r_64.name = "Ankle joint R__pivot";
  node_ankle_r_64.scale.set(1, 1, 1);
  if (endpoint_ankle_r_64) {
    node_ankle_r_64.position.copy(endpoint_ankle_r_64.start);
    node_ankle_r_64.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_ankle_r_64.position.set(-0.07559, -0.40945, -0.0126);
    node_ankle_r_64.rotation.set(0.0, 0.0, 0.0);
  }
  node_ankle_r_64.userData.sculptComponent = { id: "ankle-r" };
  node_ankle_r_64.userData.actionProfile = {};
  (nodes["shin-r"] ?? root).add(node_ankle_r_64);
  nodes["ankle-r"] = node_ankle_r_64;
  const mesh_ankle_r_64Geometry = endpoint_ankle_r_64
    ? new THREE.CylinderGeometry(endpoint_ankle_r_64.endRadius, endpoint_ankle_r_64.baseRadius, endpoint_ankle_r_64.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_ankle_r_64) {
    mesh_ankle_r_64Geometry.scale(0.08189, 0.08189, 0.08189);
  }
  const mesh_ankle_r_64 = new THREE.Mesh(
    mesh_ankle_r_64Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ankle_r_64.name = "Ankle joint R";
  if (endpoint_ankle_r_64) {
    mesh_ankle_r_64.position.copy(endpoint_ankle_r_64.midpoint);
    mesh_ankle_r_64.quaternion.copy(endpoint_ankle_r_64.quaternion);
  }
  mesh_ankle_r_64.castShadow = options.castShadow ?? true;
  mesh_ankle_r_64.receiveShadow = options.receiveShadow ?? true;
  mesh_ankle_r_64.userData.sculptComponent = { id: "ankle-r" };
  node_ankle_r_64.add(mesh_ankle_r_64);
  meshes["ankle-r"] = mesh_ankle_r_64;
  colliders["ankle-r"] = {};
  destructionGroups["leg-r"] ??= [];
  destructionGroups["leg-r"].push(node_ankle_r_64);

  const endpoint_boot_r_65 = makeAttachmentEndpoint(null);
  const node_boot_r_65 = new THREE.Group();
  node_boot_r_65.name = "Boot R__pivot";
  node_boot_r_65.scale.set(1, 1, 1);
  if (endpoint_boot_r_65) {
    node_boot_r_65.position.copy(endpoint_boot_r_65.start);
    node_boot_r_65.rotation.set(0.0, -0.3, 0.0);
  } else {
    node_boot_r_65.position.set(-0.10709, -0.56063, -0.11339);
    node_boot_r_65.rotation.set(0.0, -0.3, 0.0);
  }
  node_boot_r_65.userData.sculptComponent = { id: "boot-r" };
  node_boot_r_65.userData.actionProfile = {};
  (nodes["shin-r"] ?? root).add(node_boot_r_65);
  nodes["boot-r"] = node_boot_r_65;
  const mesh_boot_r_65Geometry = endpoint_boot_r_65
    ? new THREE.CylinderGeometry(endpoint_boot_r_65.endRadius, endpoint_boot_r_65.baseRadius, endpoint_boot_r_65.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.06299, "rz": 0.04724, "twist": 0.0}, {"position": [0.0, -0.0063, 0.07874], "rx": 0.08819, "rz": 0.05669, "twist": 0.0}, {"position": [0.0, -0.0126, 0.17323], "rx": 0.08819, "rz": 0.04094, "twist": 0.0}, {"position": [0.0, -0.0315, 0.25827], "rx": 0.06299, "rz": 0.0252, "twist": 0.0}, {"position": [0.0, -0.0378, 0.30236], "rx": 0.0315, "rz": 0.0126, "twist": 0.0}], "radialSegments": 20, "capEnds": true});
  if (!endpoint_boot_r_65) {
    mesh_boot_r_65Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_boot_r_65 = new THREE.Mesh(
    mesh_boot_r_65Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_boot_r_65.name = "Boot R";
  if (endpoint_boot_r_65) {
    mesh_boot_r_65.position.copy(endpoint_boot_r_65.midpoint);
    mesh_boot_r_65.quaternion.copy(endpoint_boot_r_65.quaternion);
  }
  mesh_boot_r_65.castShadow = options.castShadow ?? true;
  mesh_boot_r_65.receiveShadow = options.receiveShadow ?? true;
  mesh_boot_r_65.userData.sculptComponent = { id: "boot-r" };
  node_boot_r_65.add(mesh_boot_r_65);
  meshes["boot-r"] = mesh_boot_r_65;
  colliders["boot-r"] = {};
  destructionGroups["leg-r"] ??= [];
  destructionGroups["leg-r"].push(node_boot_r_65);

  const endpoint_boot_shaft_r_66 = makeAttachmentEndpoint(null);
  const node_boot_shaft_r_66 = new THREE.Group();
  node_boot_shaft_r_66.name = "Boot shaft R__pivot";
  node_boot_shaft_r_66.scale.set(1, 1, 1);
  if (endpoint_boot_shaft_r_66) {
    node_boot_shaft_r_66.position.copy(endpoint_boot_shaft_r_66.start);
    node_boot_shaft_r_66.rotation.set(0.0, -0.0, 0.0);
  } else {
    node_boot_shaft_r_66.position.set(-0.09449, -0.40945, -0.0063);
    node_boot_shaft_r_66.rotation.set(0.0, -0.0, 0.0);
  }
  node_boot_shaft_r_66.userData.sculptComponent = { id: "boot-shaft-r" };
  node_boot_shaft_r_66.userData.actionProfile = {};
  (nodes["shin-r"] ?? root).add(node_boot_shaft_r_66);
  nodes["boot-shaft-r"] = node_boot_shaft_r_66;
  const mesh_boot_shaft_r_66Geometry = endpoint_boot_shaft_r_66
    ? new THREE.CylinderGeometry(endpoint_boot_shaft_r_66.endRadius, endpoint_boot_shaft_r_66.baseRadius, endpoint_boot_shaft_r_66.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.0252, "rz": 0.0315, "twist": 0.0}, {"position": [-0.0063, -0.07559, 0.0063], "rx": 0.04724, "rz": 0.08189, "twist": 0.0}, {"position": [-0.0126, -0.15748, 0.0063], "rx": 0.0252, "rz": 0.0252, "twist": 0.0}], "radialSegments": 18, "capEnds": true});
  if (!endpoint_boot_shaft_r_66) {
    mesh_boot_shaft_r_66Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_boot_shaft_r_66 = new THREE.Mesh(
    mesh_boot_shaft_r_66Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_boot_shaft_r_66.name = "Boot shaft R";
  if (endpoint_boot_shaft_r_66) {
    mesh_boot_shaft_r_66.position.copy(endpoint_boot_shaft_r_66.midpoint);
    mesh_boot_shaft_r_66.quaternion.copy(endpoint_boot_shaft_r_66.quaternion);
  }
  mesh_boot_shaft_r_66.castShadow = options.castShadow ?? true;
  mesh_boot_shaft_r_66.receiveShadow = options.receiveShadow ?? true;
  mesh_boot_shaft_r_66.userData.sculptComponent = { id: "boot-shaft-r" };
  node_boot_shaft_r_66.add(mesh_boot_shaft_r_66);
  meshes["boot-shaft-r"] = mesh_boot_shaft_r_66;
  colliders["boot-shaft-r"] = {};
  destructionGroups["leg-r"] ??= [];
  destructionGroups["leg-r"].push(node_boot_shaft_r_66);

  const endpoint_boot_sole_r_67 = makeAttachmentEndpoint(null);
  const node_boot_sole_r_67 = new THREE.Group();
  node_boot_sole_r_67.name = "Boot sole R__pivot";
  node_boot_sole_r_67.scale.set(1, 1, 1);
  if (endpoint_boot_sole_r_67) {
    node_boot_sole_r_67.position.copy(endpoint_boot_sole_r_67.start);
    node_boot_sole_r_67.rotation.set(0.0, -0.3, 0.0);
  } else {
    node_boot_sole_r_67.position.set(-0.10709, -0.60945, 0.0315);
    node_boot_sole_r_67.rotation.set(0.0, -0.3, 0.0);
  }
  node_boot_sole_r_67.userData.sculptComponent = { id: "boot-sole-r" };
  node_boot_sole_r_67.userData.actionProfile = {};
  (nodes["shin-r"] ?? root).add(node_boot_sole_r_67);
  nodes["boot-sole-r"] = node_boot_sole_r_67;
  const mesh_boot_sole_r_67Geometry = endpoint_boot_sole_r_67
    ? new THREE.CylinderGeometry(endpoint_boot_sole_r_67.endRadius, endpoint_boot_sole_r_67.baseRadius, endpoint_boot_sole_r_67.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_boot_sole_r_67) {
    mesh_boot_sole_r_67Geometry.scale(0.13858, 0.01575, 0.30236);
  }
  const mesh_boot_sole_r_67 = new THREE.Mesh(
    mesh_boot_sole_r_67Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_boot_sole_r_67.name = "Boot sole R";
  if (endpoint_boot_sole_r_67) {
    mesh_boot_sole_r_67.position.copy(endpoint_boot_sole_r_67.midpoint);
    mesh_boot_sole_r_67.quaternion.copy(endpoint_boot_sole_r_67.quaternion);
  }
  mesh_boot_sole_r_67.castShadow = options.castShadow ?? true;
  mesh_boot_sole_r_67.receiveShadow = options.receiveShadow ?? true;
  mesh_boot_sole_r_67.userData.sculptComponent = { id: "boot-sole-r" };
  node_boot_sole_r_67.add(mesh_boot_sole_r_67);
  meshes["boot-sole-r"] = mesh_boot_sole_r_67;
  colliders["boot-sole-r"] = {};
  destructionGroups["leg-r"] ??= [];
  destructionGroups["leg-r"].push(node_boot_sole_r_67);

  const endpoint_shoulder_joint_l_68 = makeAttachmentEndpoint(null);
  const node_shoulder_joint_l_68 = new THREE.Group();
  node_shoulder_joint_l_68.name = "Shoulder joint L__pivot";
  node_shoulder_joint_l_68.scale.set(1, 1, 1);
  if (endpoint_shoulder_joint_l_68) {
    node_shoulder_joint_l_68.position.copy(endpoint_shoulder_joint_l_68.start);
    node_shoulder_joint_l_68.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_shoulder_joint_l_68.position.set(0.21417, 0.22677, -0.0063);
    node_shoulder_joint_l_68.rotation.set(0.0, 0.0, 0.0);
  }
  node_shoulder_joint_l_68.userData.sculptComponent = { id: "shoulder-joint-l" };
  node_shoulder_joint_l_68.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_shoulder_joint_l_68);
  nodes["shoulder-joint-l"] = node_shoulder_joint_l_68;
  const mesh_shoulder_joint_l_68Geometry = endpoint_shoulder_joint_l_68
    ? new THREE.CylinderGeometry(endpoint_shoulder_joint_l_68.endRadius, endpoint_shoulder_joint_l_68.baseRadius, endpoint_shoulder_joint_l_68.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_shoulder_joint_l_68) {
    mesh_shoulder_joint_l_68Geometry.scale(0.10079, 0.10079, 0.10079);
  }
  const mesh_shoulder_joint_l_68 = new THREE.Mesh(
    mesh_shoulder_joint_l_68Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_shoulder_joint_l_68.name = "Shoulder joint L";
  if (endpoint_shoulder_joint_l_68) {
    mesh_shoulder_joint_l_68.position.copy(endpoint_shoulder_joint_l_68.midpoint);
    mesh_shoulder_joint_l_68.quaternion.copy(endpoint_shoulder_joint_l_68.quaternion);
  }
  mesh_shoulder_joint_l_68.castShadow = options.castShadow ?? true;
  mesh_shoulder_joint_l_68.receiveShadow = options.receiveShadow ?? true;
  mesh_shoulder_joint_l_68.userData.sculptComponent = { id: "shoulder-joint-l" };
  node_shoulder_joint_l_68.add(mesh_shoulder_joint_l_68);
  meshes["shoulder-joint-l"] = mesh_shoulder_joint_l_68;
  colliders["shoulder-joint-l"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_shoulder_joint_l_68);

  const endpoint_pauldron_l_69 = makeAttachmentEndpoint(null);
  const node_pauldron_l_69 = new THREE.Group();
  node_pauldron_l_69.name = "Pauldron L__pivot";
  node_pauldron_l_69.scale.set(1, 1, 1);
  if (endpoint_pauldron_l_69) {
    node_pauldron_l_69.position.copy(endpoint_pauldron_l_69.start);
    node_pauldron_l_69.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_pauldron_l_69.position.set(0.25197, 0.34016, 0.0126);
    node_pauldron_l_69.rotation.set(0.0, 0.0, 0.0);
  }
  node_pauldron_l_69.userData.sculptComponent = { id: "pauldron-l" };
  node_pauldron_l_69.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_pauldron_l_69);
  nodes["pauldron-l"] = node_pauldron_l_69;
  const mesh_pauldron_l_69Geometry = endpoint_pauldron_l_69
    ? new THREE.CylinderGeometry(endpoint_pauldron_l_69.endRadius, endpoint_pauldron_l_69.baseRadius, endpoint_pauldron_l_69.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.03465, "rz": 0.02835, "twist": 0.0}, {"position": [0.04409, -0.07559, 0.0063], "rx": 0.05984, "rz": 0.05039, "twist": 0.0}, {"position": [0.06929, -0.15748, 0.0063], "rx": 0.07244, "rz": 0.06299, "twist": 0.0}, {"position": [0.05669, -0.23307, 0.0], "rx": 0.05984, "rz": 0.05039, "twist": 0.0}, {"position": [0.0378, -0.28346, -0.0063], "rx": 0.0252, "rz": 0.0189, "twist": 0.0}], "radialSegments": 22, "capEnds": true});
  if (!endpoint_pauldron_l_69) {
    mesh_pauldron_l_69Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_pauldron_l_69 = new THREE.Mesh(
    mesh_pauldron_l_69Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pauldron_l_69.name = "Pauldron L";
  if (endpoint_pauldron_l_69) {
    mesh_pauldron_l_69.position.copy(endpoint_pauldron_l_69.midpoint);
    mesh_pauldron_l_69.quaternion.copy(endpoint_pauldron_l_69.quaternion);
  }
  mesh_pauldron_l_69.castShadow = options.castShadow ?? true;
  mesh_pauldron_l_69.receiveShadow = options.receiveShadow ?? true;
  mesh_pauldron_l_69.userData.sculptComponent = { id: "pauldron-l" };
  node_pauldron_l_69.add(mesh_pauldron_l_69);
  meshes["pauldron-l"] = mesh_pauldron_l_69;
  colliders["pauldron-l"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_pauldron_l_69);

  const endpoint_pauldron_top_l_70 = makeAttachmentEndpoint(null);
  const node_pauldron_top_l_70 = new THREE.Group();
  node_pauldron_top_l_70.name = "Pauldron top petal L__pivot";
  node_pauldron_top_l_70.scale.set(1, 1, 1);
  if (endpoint_pauldron_top_l_70) {
    node_pauldron_top_l_70.position.copy(endpoint_pauldron_top_l_70.start);
    node_pauldron_top_l_70.rotation.set(0.0, 0.5, 0.0);
  } else {
    node_pauldron_top_l_70.position.set(0.24567, 0.34646, 0.0252);
    node_pauldron_top_l_70.rotation.set(0.0, 0.5, 0.0);
  }
  node_pauldron_top_l_70.userData.sculptComponent = { id: "pauldron-top-l" };
  node_pauldron_top_l_70.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_pauldron_top_l_70);
  nodes["pauldron-top-l"] = node_pauldron_top_l_70;
  const mesh_pauldron_top_l_70Geometry = endpoint_pauldron_top_l_70
    ? new THREE.CylinderGeometry(endpoint_pauldron_top_l_70.endRadius, endpoint_pauldron_top_l_70.baseRadius, endpoint_pauldron_top_l_70.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.0189, "rz": 0.01575, "twist": 0.0}, {"position": [0.0252, -0.06299, 0.0126], "rx": 0.04724, "rz": 0.04094, "twist": 0.0}, {"position": [0.04409, -0.13228, 0.0063], "rx": 0.01575, "rz": 0.0126, "twist": 0.0}], "radialSegments": 18, "capEnds": true});
  if (!endpoint_pauldron_top_l_70) {
    mesh_pauldron_top_l_70Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_pauldron_top_l_70 = new THREE.Mesh(
    mesh_pauldron_top_l_70Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pauldron_top_l_70.name = "Pauldron top petal L";
  if (endpoint_pauldron_top_l_70) {
    mesh_pauldron_top_l_70.position.copy(endpoint_pauldron_top_l_70.midpoint);
    mesh_pauldron_top_l_70.quaternion.copy(endpoint_pauldron_top_l_70.quaternion);
  }
  mesh_pauldron_top_l_70.castShadow = options.castShadow ?? true;
  mesh_pauldron_top_l_70.receiveShadow = options.receiveShadow ?? true;
  mesh_pauldron_top_l_70.userData.sculptComponent = { id: "pauldron-top-l" };
  node_pauldron_top_l_70.add(mesh_pauldron_top_l_70);
  meshes["pauldron-top-l"] = mesh_pauldron_top_l_70;
  colliders["pauldron-top-l"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_pauldron_top_l_70);

  const endpoint_pauldron_low_l_71 = makeAttachmentEndpoint(null);
  const node_pauldron_low_l_71 = new THREE.Group();
  node_pauldron_low_l_71.name = "Pauldron lower petal L__pivot";
  node_pauldron_low_l_71.scale.set(1, 1, 1);
  if (endpoint_pauldron_low_l_71) {
    node_pauldron_low_l_71.position.copy(endpoint_pauldron_low_l_71.start);
    node_pauldron_low_l_71.rotation.set(0.0, 0.4, 0.0);
  } else {
    node_pauldron_low_l_71.position.set(0.30866, 0.15118, 0.0126);
    node_pauldron_low_l_71.rotation.set(0.0, 0.4, 0.0);
  }
  node_pauldron_low_l_71.userData.sculptComponent = { id: "pauldron-low-l" };
  node_pauldron_low_l_71.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_pauldron_low_l_71);
  nodes["pauldron-low-l"] = node_pauldron_low_l_71;
  const mesh_pauldron_low_l_71Geometry = endpoint_pauldron_low_l_71
    ? new THREE.CylinderGeometry(endpoint_pauldron_low_l_71.endRadius, endpoint_pauldron_low_l_71.baseRadius, endpoint_pauldron_low_l_71.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.03465, "rz": 0.0252, "twist": 0.0}, {"position": [0.0189, -0.06929, 0.0126], "rx": 0.04724, "rz": 0.04094, "twist": 0.0}, {"position": [0.0063, -0.13858, 0.0063], "rx": 0.0252, "rz": 0.01575, "twist": 0.0}], "radialSegments": 18, "capEnds": true});
  if (!endpoint_pauldron_low_l_71) {
    mesh_pauldron_low_l_71Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_pauldron_low_l_71 = new THREE.Mesh(
    mesh_pauldron_low_l_71Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pauldron_low_l_71.name = "Pauldron lower petal L";
  if (endpoint_pauldron_low_l_71) {
    mesh_pauldron_low_l_71.position.copy(endpoint_pauldron_low_l_71.midpoint);
    mesh_pauldron_low_l_71.quaternion.copy(endpoint_pauldron_low_l_71.quaternion);
  }
  mesh_pauldron_low_l_71.castShadow = options.castShadow ?? true;
  mesh_pauldron_low_l_71.receiveShadow = options.receiveShadow ?? true;
  mesh_pauldron_low_l_71.userData.sculptComponent = { id: "pauldron-low-l" };
  node_pauldron_low_l_71.add(mesh_pauldron_low_l_71);
  meshes["pauldron-low-l"] = mesh_pauldron_low_l_71;
  colliders["pauldron-low-l"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_pauldron_low_l_71);

  const endpoint_chest_lower_l_72 = makeAttachmentEndpoint(null);
  const node_chest_lower_l_72 = new THREE.Group();
  node_chest_lower_l_72.name = "Lower chest plate L__pivot";
  node_chest_lower_l_72.scale.set(1, 1, 1);
  if (endpoint_chest_lower_l_72) {
    node_chest_lower_l_72.position.copy(endpoint_chest_lower_l_72.start);
    node_chest_lower_l_72.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_chest_lower_l_72.position.set(0.07559, 0.06929, 0.08819);
    node_chest_lower_l_72.rotation.set(0.0, 0.0, 0.0);
  }
  node_chest_lower_l_72.userData.sculptComponent = { id: "chest-lower-l" };
  node_chest_lower_l_72.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_chest_lower_l_72);
  nodes["chest-lower-l"] = node_chest_lower_l_72;
  const mesh_chest_lower_l_72Geometry = endpoint_chest_lower_l_72
    ? new THREE.CylinderGeometry(endpoint_chest_lower_l_72.endRadius, endpoint_chest_lower_l_72.baseRadius, endpoint_chest_lower_l_72.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.0189, "rz": 0.0189, "twist": 0.0}, {"position": [-0.0189, -0.08819, 0.00315], "rx": 0.0315, "rz": 0.0378, "twist": 0.0}, {"position": [-0.04409, -0.17638, -0.00945], "rx": 0.0126, "rz": 0.00945, "twist": 0.0}], "radialSegments": 16, "capEnds": true});
  if (!endpoint_chest_lower_l_72) {
    mesh_chest_lower_l_72Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_chest_lower_l_72 = new THREE.Mesh(
    mesh_chest_lower_l_72Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_chest_lower_l_72.name = "Lower chest plate L";
  if (endpoint_chest_lower_l_72) {
    mesh_chest_lower_l_72.position.copy(endpoint_chest_lower_l_72.midpoint);
    mesh_chest_lower_l_72.quaternion.copy(endpoint_chest_lower_l_72.quaternion);
  }
  mesh_chest_lower_l_72.castShadow = options.castShadow ?? true;
  mesh_chest_lower_l_72.receiveShadow = options.receiveShadow ?? true;
  mesh_chest_lower_l_72.userData.sculptComponent = { id: "chest-lower-l" };
  node_chest_lower_l_72.add(mesh_chest_lower_l_72);
  meshes["chest-lower-l"] = mesh_chest_lower_l_72;
  colliders["chest-lower-l"] = {};
  destructionGroups["torso"] ??= [];
  destructionGroups["torso"].push(node_chest_lower_l_72);

  const endpoint_pauldron_glow_l_73 = makeAttachmentEndpoint(null);
  const node_pauldron_glow_l_73 = new THREE.Group();
  node_pauldron_glow_l_73.name = "Pauldron glow L__pivot";
  node_pauldron_glow_l_73.scale.set(1, 1, 1);
  if (endpoint_pauldron_glow_l_73) {
    node_pauldron_glow_l_73.position.copy(endpoint_pauldron_glow_l_73.start);
    node_pauldron_glow_l_73.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_pauldron_glow_l_73.position.set(0.31496, 0.08819, 0.06299);
    node_pauldron_glow_l_73.rotation.set(0.0, 0.0, 0.0);
  }
  node_pauldron_glow_l_73.userData.sculptComponent = { id: "pauldron-glow-l" };
  node_pauldron_glow_l_73.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_pauldron_glow_l_73);
  nodes["pauldron-glow-l"] = node_pauldron_glow_l_73;
  const mesh_pauldron_glow_l_73Geometry = endpoint_pauldron_glow_l_73
    ? new THREE.CylinderGeometry(endpoint_pauldron_glow_l_73.endRadius, endpoint_pauldron_glow_l_73.baseRadius, endpoint_pauldron_glow_l_73.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_pauldron_glow_l_73) {
    mesh_pauldron_glow_l_73Geometry.scale(0.0252, 0.05039, 0.01575);
  }
  const mesh_pauldron_glow_l_73 = new THREE.Mesh(
    mesh_pauldron_glow_l_73Geometry,
    materialMap["emissive-blue"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pauldron_glow_l_73.name = "Pauldron glow L";
  if (endpoint_pauldron_glow_l_73) {
    mesh_pauldron_glow_l_73.position.copy(endpoint_pauldron_glow_l_73.midpoint);
    mesh_pauldron_glow_l_73.quaternion.copy(endpoint_pauldron_glow_l_73.quaternion);
  }
  mesh_pauldron_glow_l_73.castShadow = options.castShadow ?? true;
  mesh_pauldron_glow_l_73.receiveShadow = options.receiveShadow ?? true;
  mesh_pauldron_glow_l_73.userData.sculptComponent = { id: "pauldron-glow-l" };
  node_pauldron_glow_l_73.add(mesh_pauldron_glow_l_73);
  meshes["pauldron-glow-l"] = mesh_pauldron_glow_l_73;
  colliders["pauldron-glow-l"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_pauldron_glow_l_73);

  const attachment_upper_arm_l_74 = {"parentSocket": "chest-upper-arm-l", "localStart": [0.21417, 0.22677, -0.0063], "localEnd": [0.31496, -0.10709, 0.0], "contactType": "socket-joint", "baseRadius": 0.0378, "endRadius": 0.0315, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_upper_arm_l_74 = makeAttachmentEndpoint(attachment_upper_arm_l_74);
  const node_upper_arm_l_74 = new THREE.Group();
  node_upper_arm_l_74.name = "Upper arm core L__pivot";
  node_upper_arm_l_74.scale.set(1, 1, 1);
  if (endpoint_upper_arm_l_74) {
    node_upper_arm_l_74.position.copy(endpoint_upper_arm_l_74.start);
    node_upper_arm_l_74.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_upper_arm_l_74.position.set(0.21417, 0.22677, -0.0063);
    node_upper_arm_l_74.rotation.set(0.0, 0.0, 0.0);
  }
  node_upper_arm_l_74.userData.sculptComponent = { id: "upper-arm-l" };
  node_upper_arm_l_74.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_upper_arm_l_74);
  nodes["upper-arm-l"] = node_upper_arm_l_74;
  const mesh_upper_arm_l_74Geometry = endpoint_upper_arm_l_74
    ? new THREE.CylinderGeometry(endpoint_upper_arm_l_74.endRadius, endpoint_upper_arm_l_74.baseRadius, endpoint_upper_arm_l_74.length, 16, 6)
    : buildWatertightCapsule(0.35, 0.7, 8, 16, 1);
  if (!endpoint_upper_arm_l_74) {
    mesh_upper_arm_l_74Geometry.scale(0.07559, 0.3488, 0.07559);
  }
  const mesh_upper_arm_l_74 = new THREE.Mesh(
    mesh_upper_arm_l_74Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_upper_arm_l_74.name = "Upper arm core L";
  if (endpoint_upper_arm_l_74) {
    mesh_upper_arm_l_74.position.copy(endpoint_upper_arm_l_74.midpoint);
    mesh_upper_arm_l_74.quaternion.copy(endpoint_upper_arm_l_74.quaternion);
  }
  mesh_upper_arm_l_74.castShadow = options.castShadow ?? true;
  mesh_upper_arm_l_74.receiveShadow = options.receiveShadow ?? true;
  mesh_upper_arm_l_74.userData.sculptComponent = { id: "upper-arm-l" };
  node_upper_arm_l_74.add(mesh_upper_arm_l_74);
  meshes["upper-arm-l"] = mesh_upper_arm_l_74;
  colliders["upper-arm-l"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_upper_arm_l_74);

  const endpoint_upper_arm_shell_l_75 = makeAttachmentEndpoint(null);
  const node_upper_arm_shell_l_75 = new THREE.Group();
  node_upper_arm_shell_l_75.name = "Bicep shell L__pivot";
  node_upper_arm_shell_l_75.scale.set(1, 1, 1);
  if (endpoint_upper_arm_shell_l_75) {
    node_upper_arm_shell_l_75.position.copy(endpoint_upper_arm_shell_l_75.start);
    node_upper_arm_shell_l_75.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_upper_arm_shell_l_75.position.set(0.0126, -0.05669, 0.0);
    node_upper_arm_shell_l_75.rotation.set(0.0, 0.0, 0.0);
  }
  node_upper_arm_shell_l_75.userData.sculptComponent = { id: "upper-arm-shell-l" };
  node_upper_arm_shell_l_75.userData.actionProfile = {};
  (nodes["upper-arm-l"] ?? root).add(node_upper_arm_shell_l_75);
  nodes["upper-arm-shell-l"] = node_upper_arm_shell_l_75;
  const mesh_upper_arm_shell_l_75Geometry = endpoint_upper_arm_shell_l_75
    ? new THREE.CylinderGeometry(endpoint_upper_arm_shell_l_75.endRadius, endpoint_upper_arm_shell_l_75.baseRadius, endpoint_upper_arm_shell_l_75.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.02205, "rz": 0.02205, "twist": 0.0}, {"position": [0.0252, -0.10079, 0.0], "rx": 0.05669, "rz": 0.05354, "twist": 0.0}, {"position": [0.06614, -0.23307, 0.0], "rx": 0.0252, "rz": 0.0252, "twist": 0.0}], "radialSegments": 18, "capEnds": true});
  if (!endpoint_upper_arm_shell_l_75) {
    mesh_upper_arm_shell_l_75Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_upper_arm_shell_l_75 = new THREE.Mesh(
    mesh_upper_arm_shell_l_75Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_upper_arm_shell_l_75.name = "Bicep shell L";
  if (endpoint_upper_arm_shell_l_75) {
    mesh_upper_arm_shell_l_75.position.copy(endpoint_upper_arm_shell_l_75.midpoint);
    mesh_upper_arm_shell_l_75.quaternion.copy(endpoint_upper_arm_shell_l_75.quaternion);
  }
  mesh_upper_arm_shell_l_75.castShadow = options.castShadow ?? true;
  mesh_upper_arm_shell_l_75.receiveShadow = options.receiveShadow ?? true;
  mesh_upper_arm_shell_l_75.userData.sculptComponent = { id: "upper-arm-shell-l" };
  node_upper_arm_shell_l_75.add(mesh_upper_arm_shell_l_75);
  meshes["upper-arm-shell-l"] = mesh_upper_arm_shell_l_75;
  colliders["upper-arm-shell-l"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_upper_arm_shell_l_75);

  const endpoint_elbow_l_76 = makeAttachmentEndpoint(null);
  const node_elbow_l_76 = new THREE.Group();
  node_elbow_l_76.name = "Elbow joint L__pivot";
  node_elbow_l_76.scale.set(1, 1, 1);
  if (endpoint_elbow_l_76) {
    node_elbow_l_76.position.copy(endpoint_elbow_l_76.start);
    node_elbow_l_76.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_elbow_l_76.position.set(0.10079, -0.33386, 0.0063);
    node_elbow_l_76.rotation.set(0.0, 0.0, 0.0);
  }
  node_elbow_l_76.userData.sculptComponent = { id: "elbow-l" };
  node_elbow_l_76.userData.actionProfile = {};
  (nodes["upper-arm-l"] ?? root).add(node_elbow_l_76);
  nodes["elbow-l"] = node_elbow_l_76;
  const mesh_elbow_l_76Geometry = endpoint_elbow_l_76
    ? new THREE.CylinderGeometry(endpoint_elbow_l_76.endRadius, endpoint_elbow_l_76.baseRadius, endpoint_elbow_l_76.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_elbow_l_76) {
    mesh_elbow_l_76Geometry.scale(0.08189, 0.08189, 0.08189);
  }
  const mesh_elbow_l_76 = new THREE.Mesh(
    mesh_elbow_l_76Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_elbow_l_76.name = "Elbow joint L";
  if (endpoint_elbow_l_76) {
    mesh_elbow_l_76.position.copy(endpoint_elbow_l_76.midpoint);
    mesh_elbow_l_76.quaternion.copy(endpoint_elbow_l_76.quaternion);
  }
  mesh_elbow_l_76.castShadow = options.castShadow ?? true;
  mesh_elbow_l_76.receiveShadow = options.receiveShadow ?? true;
  mesh_elbow_l_76.userData.sculptComponent = { id: "elbow-l" };
  node_elbow_l_76.add(mesh_elbow_l_76);
  meshes["elbow-l"] = mesh_elbow_l_76;
  colliders["elbow-l"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_elbow_l_76);

  const attachment_forearm_l_77 = {"parentSocket": "upper-arm-l-forearm-l", "localStart": [0.10079, -0.33386, 0.0063], "localEnd": [0.13858, -0.61102, 0.0063], "contactType": "hinge-joint", "baseRadius": 0.0315, "endRadius": 0.0252, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_forearm_l_77 = makeAttachmentEndpoint(attachment_forearm_l_77);
  const node_forearm_l_77 = new THREE.Group();
  node_forearm_l_77.name = "Forearm core L__pivot";
  node_forearm_l_77.scale.set(1, 1, 1);
  if (endpoint_forearm_l_77) {
    node_forearm_l_77.position.copy(endpoint_forearm_l_77.start);
    node_forearm_l_77.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_forearm_l_77.position.set(0.10079, -0.33386, 0.0063);
    node_forearm_l_77.rotation.set(0.0, 0.0, 0.0);
  }
  node_forearm_l_77.userData.sculptComponent = { id: "forearm-l" };
  node_forearm_l_77.userData.actionProfile = {};
  (nodes["upper-arm-l"] ?? root).add(node_forearm_l_77);
  nodes["forearm-l"] = node_forearm_l_77;
  const mesh_forearm_l_77Geometry = endpoint_forearm_l_77
    ? new THREE.CylinderGeometry(endpoint_forearm_l_77.endRadius, endpoint_forearm_l_77.baseRadius, endpoint_forearm_l_77.length, 16, 6)
    : buildWatertightCapsule(0.35, 0.7, 8, 16, 1);
  if (!endpoint_forearm_l_77) {
    mesh_forearm_l_77Geometry.scale(0.06299, 0.27973, 0.06299);
  }
  const mesh_forearm_l_77 = new THREE.Mesh(
    mesh_forearm_l_77Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_forearm_l_77.name = "Forearm core L";
  if (endpoint_forearm_l_77) {
    mesh_forearm_l_77.position.copy(endpoint_forearm_l_77.midpoint);
    mesh_forearm_l_77.quaternion.copy(endpoint_forearm_l_77.quaternion);
  }
  mesh_forearm_l_77.castShadow = options.castShadow ?? true;
  mesh_forearm_l_77.receiveShadow = options.receiveShadow ?? true;
  mesh_forearm_l_77.userData.sculptComponent = { id: "forearm-l" };
  node_forearm_l_77.add(mesh_forearm_l_77);
  meshes["forearm-l"] = mesh_forearm_l_77;
  colliders["forearm-l"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_forearm_l_77);

  const endpoint_forearm_blade_l_78 = makeAttachmentEndpoint(null);
  const node_forearm_blade_l_78 = new THREE.Group();
  node_forearm_blade_l_78.name = "Forearm fin blade L__pivot";
  node_forearm_blade_l_78.scale.set(1, 1, 1);
  if (endpoint_forearm_blade_l_78) {
    node_forearm_blade_l_78.position.copy(endpoint_forearm_blade_l_78.start);
    node_forearm_blade_l_78.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_forearm_blade_l_78.position.set(0.04409, 0.04409, 0.0126);
    node_forearm_blade_l_78.rotation.set(0.0, 0.0, 0.0);
  }
  node_forearm_blade_l_78.userData.sculptComponent = { id: "forearm-blade-l" };
  node_forearm_blade_l_78.userData.actionProfile = {};
  (nodes["forearm-l"] ?? root).add(node_forearm_blade_l_78);
  nodes["forearm-blade-l"] = node_forearm_blade_l_78;
  const mesh_forearm_blade_l_78Geometry = endpoint_forearm_blade_l_78
    ? new THREE.CylinderGeometry(endpoint_forearm_blade_l_78.endRadius, endpoint_forearm_blade_l_78.baseRadius, endpoint_forearm_blade_l_78.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.01575, "rz": 0.02835, "twist": 0.0}, {"position": [0.0252, -0.08819, 0.0], "rx": 0.01575, "rz": 0.04724, "twist": 0.0}, {"position": [0.0378, -0.18898, 0.0], "rx": 0.01575, "rz": 0.05039, "twist": 0.0}, {"position": [0.04409, -0.27087, 0.0], "rx": 0.0126, "rz": 0.0315, "twist": 0.0}, {"position": [0.05039, -0.32756, 0.0], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 20, "capEnds": true});
  if (!endpoint_forearm_blade_l_78) {
    mesh_forearm_blade_l_78Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_forearm_blade_l_78 = new THREE.Mesh(
    mesh_forearm_blade_l_78Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_forearm_blade_l_78.name = "Forearm fin blade L";
  if (endpoint_forearm_blade_l_78) {
    mesh_forearm_blade_l_78.position.copy(endpoint_forearm_blade_l_78.midpoint);
    mesh_forearm_blade_l_78.quaternion.copy(endpoint_forearm_blade_l_78.quaternion);
  }
  mesh_forearm_blade_l_78.castShadow = options.castShadow ?? true;
  mesh_forearm_blade_l_78.receiveShadow = options.receiveShadow ?? true;
  mesh_forearm_blade_l_78.userData.sculptComponent = { id: "forearm-blade-l" };
  node_forearm_blade_l_78.add(mesh_forearm_blade_l_78);
  meshes["forearm-blade-l"] = mesh_forearm_blade_l_78;
  colliders["forearm-blade-l"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_forearm_blade_l_78);

  const endpoint_forearm_shell_l_79 = makeAttachmentEndpoint(null);
  const node_forearm_shell_l_79 = new THREE.Group();
  node_forearm_shell_l_79.name = "Forearm shell L__pivot";
  node_forearm_shell_l_79.scale.set(1, 1, 1);
  if (endpoint_forearm_shell_l_79) {
    node_forearm_shell_l_79.position.copy(endpoint_forearm_shell_l_79.start);
    node_forearm_shell_l_79.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_forearm_shell_l_79.position.set(0.0063, -0.0378, -0.0063);
    node_forearm_shell_l_79.rotation.set(0.0, 0.0, 0.0);
  }
  node_forearm_shell_l_79.userData.sculptComponent = { id: "forearm-shell-l" };
  node_forearm_shell_l_79.userData.actionProfile = {};
  (nodes["forearm-l"] ?? root).add(node_forearm_shell_l_79);
  nodes["forearm-shell-l"] = node_forearm_shell_l_79;
  const mesh_forearm_shell_l_79Geometry = endpoint_forearm_shell_l_79
    ? new THREE.CylinderGeometry(endpoint_forearm_shell_l_79.endRadius, endpoint_forearm_shell_l_79.baseRadius, endpoint_forearm_shell_l_79.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.0252, "rz": 0.0252, "twist": 0.0}, {"position": [0.0126, -0.11339, 0.0], "rx": 0.04409, "rz": 0.04409, "twist": 0.0}, {"position": [0.0252, -0.22677, 0.0], "rx": 0.02205, "rz": 0.02205, "twist": 0.0}], "radialSegments": 18, "capEnds": true});
  if (!endpoint_forearm_shell_l_79) {
    mesh_forearm_shell_l_79Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_forearm_shell_l_79 = new THREE.Mesh(
    mesh_forearm_shell_l_79Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_forearm_shell_l_79.name = "Forearm shell L";
  if (endpoint_forearm_shell_l_79) {
    mesh_forearm_shell_l_79.position.copy(endpoint_forearm_shell_l_79.midpoint);
    mesh_forearm_shell_l_79.quaternion.copy(endpoint_forearm_shell_l_79.quaternion);
  }
  mesh_forearm_shell_l_79.castShadow = options.castShadow ?? true;
  mesh_forearm_shell_l_79.receiveShadow = options.receiveShadow ?? true;
  mesh_forearm_shell_l_79.userData.sculptComponent = { id: "forearm-shell-l" };
  node_forearm_shell_l_79.add(mesh_forearm_shell_l_79);
  meshes["forearm-shell-l"] = mesh_forearm_shell_l_79;
  colliders["forearm-shell-l"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_forearm_shell_l_79);

  const endpoint_hand_l_80 = makeAttachmentEndpoint(null);
  const node_hand_l_80 = new THREE.Group();
  node_hand_l_80.name = "Hand L__pivot";
  node_hand_l_80.scale.set(1, 1, 1);
  if (endpoint_hand_l_80) {
    node_hand_l_80.position.copy(endpoint_hand_l_80.start);
    node_hand_l_80.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hand_l_80.position.set(0.0378, -0.32126, 0.0);
    node_hand_l_80.rotation.set(0.0, 0.0, 0.0);
  }
  node_hand_l_80.userData.sculptComponent = { id: "hand-l" };
  node_hand_l_80.userData.actionProfile = {};
  (nodes["forearm-l"] ?? root).add(node_hand_l_80);
  nodes["hand-l"] = node_hand_l_80;
  const mesh_hand_l_80Geometry = endpoint_hand_l_80
    ? new THREE.CylinderGeometry(endpoint_hand_l_80.endRadius, endpoint_hand_l_80.baseRadius, endpoint_hand_l_80.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_hand_l_80) {
    mesh_hand_l_80Geometry.scale(0.07559, 0.08819, 0.0378);
  }
  const mesh_hand_l_80 = new THREE.Mesh(
    mesh_hand_l_80Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hand_l_80.name = "Hand L";
  if (endpoint_hand_l_80) {
    mesh_hand_l_80.position.copy(endpoint_hand_l_80.midpoint);
    mesh_hand_l_80.quaternion.copy(endpoint_hand_l_80.quaternion);
  }
  mesh_hand_l_80.castShadow = options.castShadow ?? true;
  mesh_hand_l_80.receiveShadow = options.receiveShadow ?? true;
  mesh_hand_l_80.userData.sculptComponent = { id: "hand-l" };
  node_hand_l_80.add(mesh_hand_l_80);
  meshes["hand-l"] = mesh_hand_l_80;
  colliders["hand-l"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_hand_l_80);

  const attachment_thumb_l_1_81 = {"parentSocket": "hand-l-thumb-l-1", "localStart": [-0.0315, -0.04409, 0.0189], "localEnd": [-0.03849, -0.06801, 0.02264], "contactType": "rigid-weld", "baseRadius": 0.00913, "endRadius": 0.00756, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_thumb_l_1_81 = makeAttachmentEndpoint(attachment_thumb_l_1_81);
  const node_thumb_l_1_81 = new THREE.Group();
  node_thumb_l_1_81.name = "Thumb L 1__pivot";
  node_thumb_l_1_81.scale.set(1, 1, 1);
  if (endpoint_thumb_l_1_81) {
    node_thumb_l_1_81.position.copy(endpoint_thumb_l_1_81.start);
    node_thumb_l_1_81.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_thumb_l_1_81.position.set(-0.0315, -0.04409, 0.0189);
    node_thumb_l_1_81.rotation.set(0.0, 0.0, 0.0);
  }
  node_thumb_l_1_81.userData.sculptComponent = { id: "thumb-l-1" };
  node_thumb_l_1_81.userData.actionProfile = {};
  (nodes["hand-l"] ?? root).add(node_thumb_l_1_81);
  nodes["thumb-l-1"] = node_thumb_l_1_81;
  const mesh_thumb_l_1_81Geometry = endpoint_thumb_l_1_81
    ? new THREE.CylinderGeometry(endpoint_thumb_l_1_81.endRadius, endpoint_thumb_l_1_81.baseRadius, endpoint_thumb_l_1_81.length, 16, 6)
    : buildWatertightCapsule(0.35, 0.7, 8, 16, 1);
  if (!endpoint_thumb_l_1_81) {
    mesh_thumb_l_1_81Geometry.scale(0.01827, 0.0252, 0.01827);
  }
  const mesh_thumb_l_1_81 = new THREE.Mesh(
    mesh_thumb_l_1_81Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_thumb_l_1_81.name = "Thumb L 1";
  if (endpoint_thumb_l_1_81) {
    mesh_thumb_l_1_81.position.copy(endpoint_thumb_l_1_81.midpoint);
    mesh_thumb_l_1_81.quaternion.copy(endpoint_thumb_l_1_81.quaternion);
  }
  mesh_thumb_l_1_81.castShadow = options.castShadow ?? true;
  mesh_thumb_l_1_81.receiveShadow = options.receiveShadow ?? true;
  mesh_thumb_l_1_81.userData.sculptComponent = { id: "thumb-l-1" };
  node_thumb_l_1_81.add(mesh_thumb_l_1_81);
  meshes["thumb-l-1"] = mesh_thumb_l_1_81;
  colliders["thumb-l-1"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_thumb_l_1_81);

  const attachment_thumb_l_2_82 = {"parentSocket": "thumb-l-1-thumb-l-2", "localStart": [-0.007, -0.02391, 0.00374], "localEnd": [-0.01285, -0.04391, 0.01097], "contactType": "hinge-joint", "baseRadius": 0.00756, "endRadius": 0.00598, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_thumb_l_2_82 = makeAttachmentEndpoint(attachment_thumb_l_2_82);
  const node_thumb_l_2_82 = new THREE.Group();
  node_thumb_l_2_82.name = "Thumb L 2__pivot";
  node_thumb_l_2_82.scale.set(1, 1, 1);
  if (endpoint_thumb_l_2_82) {
    node_thumb_l_2_82.position.copy(endpoint_thumb_l_2_82.start);
    node_thumb_l_2_82.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_thumb_l_2_82.position.set(-0.007, -0.02391, 0.00374);
    node_thumb_l_2_82.rotation.set(0.0, 0.0, 0.0);
  }
  node_thumb_l_2_82.userData.sculptComponent = { id: "thumb-l-2" };
  node_thumb_l_2_82.userData.actionProfile = {};
  (nodes["thumb-l-1"] ?? root).add(node_thumb_l_2_82);
  nodes["thumb-l-2"] = node_thumb_l_2_82;
  const mesh_thumb_l_2_82Geometry = endpoint_thumb_l_2_82
    ? new THREE.CylinderGeometry(endpoint_thumb_l_2_82.endRadius, endpoint_thumb_l_2_82.baseRadius, endpoint_thumb_l_2_82.length, 16, 6)
    : buildWatertightCapsule(0.35, 0.7, 8, 16, 1);
  if (!endpoint_thumb_l_2_82) {
    mesh_thumb_l_2_82Geometry.scale(0.01512, 0.02205, 0.01512);
  }
  const mesh_thumb_l_2_82 = new THREE.Mesh(
    mesh_thumb_l_2_82Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_thumb_l_2_82.name = "Thumb L 2";
  if (endpoint_thumb_l_2_82) {
    mesh_thumb_l_2_82.position.copy(endpoint_thumb_l_2_82.midpoint);
    mesh_thumb_l_2_82.quaternion.copy(endpoint_thumb_l_2_82.quaternion);
  }
  mesh_thumb_l_2_82.castShadow = options.castShadow ?? true;
  mesh_thumb_l_2_82.receiveShadow = options.receiveShadow ?? true;
  mesh_thumb_l_2_82.userData.sculptComponent = { id: "thumb-l-2" };
  node_thumb_l_2_82.add(mesh_thumb_l_2_82);
  meshes["thumb-l-2"] = mesh_thumb_l_2_82;
  colliders["thumb-l-2"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_thumb_l_2_82);

  const attachment_thumb_l_3_83 = {"parentSocket": "thumb-l-2-thumb-l-3", "localStart": [-0.00585, -0.01999, 0.00723], "localEnd": [-0.01047, -0.03576, 0.01656], "contactType": "hinge-joint", "baseRadius": 0.00598, "endRadius": 0.00441, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_thumb_l_3_83 = makeAttachmentEndpoint(attachment_thumb_l_3_83);
  const node_thumb_l_3_83 = new THREE.Group();
  node_thumb_l_3_83.name = "Thumb L 3__pivot";
  node_thumb_l_3_83.scale.set(1, 1, 1);
  if (endpoint_thumb_l_3_83) {
    node_thumb_l_3_83.position.copy(endpoint_thumb_l_3_83.start);
    node_thumb_l_3_83.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_thumb_l_3_83.position.set(-0.00585, -0.01999, 0.00723);
    node_thumb_l_3_83.rotation.set(0.0, 0.0, 0.0);
  }
  node_thumb_l_3_83.userData.sculptComponent = { id: "thumb-l-3" };
  node_thumb_l_3_83.userData.actionProfile = {};
  (nodes["thumb-l-2"] ?? root).add(node_thumb_l_3_83);
  nodes["thumb-l-3"] = node_thumb_l_3_83;
  const mesh_thumb_l_3_83Geometry = endpoint_thumb_l_3_83
    ? new THREE.CylinderGeometry(endpoint_thumb_l_3_83.endRadius, endpoint_thumb_l_3_83.baseRadius, endpoint_thumb_l_3_83.length, 16, 6)
    : buildWatertightCapsule(0.35, 0.7, 8, 16, 1);
  if (!endpoint_thumb_l_3_83) {
    mesh_thumb_l_3_83Geometry.scale(0.01197, 0.0189, 0.01197);
  }
  const mesh_thumb_l_3_83 = new THREE.Mesh(
    mesh_thumb_l_3_83Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_thumb_l_3_83.name = "Thumb L 3";
  if (endpoint_thumb_l_3_83) {
    mesh_thumb_l_3_83.position.copy(endpoint_thumb_l_3_83.midpoint);
    mesh_thumb_l_3_83.quaternion.copy(endpoint_thumb_l_3_83.quaternion);
  }
  mesh_thumb_l_3_83.castShadow = options.castShadow ?? true;
  mesh_thumb_l_3_83.receiveShadow = options.receiveShadow ?? true;
  mesh_thumb_l_3_83.userData.sculptComponent = { id: "thumb-l-3" };
  node_thumb_l_3_83.add(mesh_thumb_l_3_83);
  meshes["thumb-l-3"] = mesh_thumb_l_3_83;
  colliders["thumb-l-3"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_thumb_l_3_83);

  const attachment_index_l_1_84 = {"parentSocket": "hand-l-index-l-1", "localStart": [-0.02205, -0.04409, 0.0126], "localEnd": [-0.025, -0.072, 0.01658], "contactType": "rigid-weld", "baseRadius": 0.00913, "endRadius": 0.00756, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_index_l_1_84 = makeAttachmentEndpoint(attachment_index_l_1_84);
  const node_index_l_1_84 = new THREE.Group();
  node_index_l_1_84.name = "Index L 1__pivot";
  node_index_l_1_84.scale.set(1, 1, 1);
  if (endpoint_index_l_1_84) {
    node_index_l_1_84.position.copy(endpoint_index_l_1_84.start);
    node_index_l_1_84.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_index_l_1_84.position.set(-0.02205, -0.04409, 0.0126);
    node_index_l_1_84.rotation.set(0.0, 0.0, 0.0);
  }
  node_index_l_1_84.userData.sculptComponent = { id: "index-l-1" };
  node_index_l_1_84.userData.actionProfile = {};
  (nodes["hand-l"] ?? root).add(node_index_l_1_84);
  nodes["index-l-1"] = node_index_l_1_84;
  const mesh_index_l_1_84Geometry = endpoint_index_l_1_84
    ? new THREE.CylinderGeometry(endpoint_index_l_1_84.endRadius, endpoint_index_l_1_84.baseRadius, endpoint_index_l_1_84.length, 16, 6)
    : buildWatertightCapsule(0.35, 0.7, 8, 16, 1);
  if (!endpoint_index_l_1_84) {
    mesh_index_l_1_84Geometry.scale(0.01827, 0.02835, 0.01827);
  }
  const mesh_index_l_1_84 = new THREE.Mesh(
    mesh_index_l_1_84Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_index_l_1_84.name = "Index L 1";
  if (endpoint_index_l_1_84) {
    mesh_index_l_1_84.position.copy(endpoint_index_l_1_84.midpoint);
    mesh_index_l_1_84.quaternion.copy(endpoint_index_l_1_84.quaternion);
  }
  mesh_index_l_1_84.castShadow = options.castShadow ?? true;
  mesh_index_l_1_84.receiveShadow = options.receiveShadow ?? true;
  mesh_index_l_1_84.userData.sculptComponent = { id: "index-l-1" };
  node_index_l_1_84.add(mesh_index_l_1_84);
  meshes["index-l-1"] = mesh_index_l_1_84;
  colliders["index-l-1"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_index_l_1_84);

  const attachment_index_l_2_85 = {"parentSocket": "index-l-1-index-l-2", "localStart": [-0.00295, -0.02791, 0.00398], "localEnd": [-0.00516, -0.04874, 0.01086], "contactType": "hinge-joint", "baseRadius": 0.00756, "endRadius": 0.00598, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_index_l_2_85 = makeAttachmentEndpoint(attachment_index_l_2_85);
  const node_index_l_2_85 = new THREE.Group();
  node_index_l_2_85.name = "Index L 2__pivot";
  node_index_l_2_85.scale.set(1, 1, 1);
  if (endpoint_index_l_2_85) {
    node_index_l_2_85.position.copy(endpoint_index_l_2_85.start);
    node_index_l_2_85.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_index_l_2_85.position.set(-0.00295, -0.02791, 0.00398);
    node_index_l_2_85.rotation.set(0.0, 0.0, 0.0);
  }
  node_index_l_2_85.userData.sculptComponent = { id: "index-l-2" };
  node_index_l_2_85.userData.actionProfile = {};
  (nodes["index-l-1"] ?? root).add(node_index_l_2_85);
  nodes["index-l-2"] = node_index_l_2_85;
  const mesh_index_l_2_85Geometry = endpoint_index_l_2_85
    ? new THREE.CylinderGeometry(endpoint_index_l_2_85.endRadius, endpoint_index_l_2_85.baseRadius, endpoint_index_l_2_85.length, 16, 6)
    : buildWatertightCapsule(0.35, 0.7, 8, 16, 1);
  if (!endpoint_index_l_2_85) {
    mesh_index_l_2_85Geometry.scale(0.01512, 0.02205, 0.01512);
  }
  const mesh_index_l_2_85 = new THREE.Mesh(
    mesh_index_l_2_85Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_index_l_2_85.name = "Index L 2";
  if (endpoint_index_l_2_85) {
    mesh_index_l_2_85.position.copy(endpoint_index_l_2_85.midpoint);
    mesh_index_l_2_85.quaternion.copy(endpoint_index_l_2_85.quaternion);
  }
  mesh_index_l_2_85.castShadow = options.castShadow ?? true;
  mesh_index_l_2_85.receiveShadow = options.receiveShadow ?? true;
  mesh_index_l_2_85.userData.sculptComponent = { id: "index-l-2" };
  node_index_l_2_85.add(mesh_index_l_2_85);
  meshes["index-l-2"] = mesh_index_l_2_85;
  colliders["index-l-2"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_index_l_2_85);

  const attachment_index_l_3_86 = {"parentSocket": "index-l-2-index-l-3", "localStart": [-0.0022, -0.02083, 0.00687], "localEnd": [-0.00396, -0.03739, 0.01581], "contactType": "hinge-joint", "baseRadius": 0.00598, "endRadius": 0.00441, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_index_l_3_86 = makeAttachmentEndpoint(attachment_index_l_3_86);
  const node_index_l_3_86 = new THREE.Group();
  node_index_l_3_86.name = "Index L 3__pivot";
  node_index_l_3_86.scale.set(1, 1, 1);
  if (endpoint_index_l_3_86) {
    node_index_l_3_86.position.copy(endpoint_index_l_3_86.start);
    node_index_l_3_86.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_index_l_3_86.position.set(-0.0022, -0.02083, 0.00687);
    node_index_l_3_86.rotation.set(0.0, 0.0, 0.0);
  }
  node_index_l_3_86.userData.sculptComponent = { id: "index-l-3" };
  node_index_l_3_86.userData.actionProfile = {};
  (nodes["index-l-2"] ?? root).add(node_index_l_3_86);
  nodes["index-l-3"] = node_index_l_3_86;
  const mesh_index_l_3_86Geometry = endpoint_index_l_3_86
    ? new THREE.CylinderGeometry(endpoint_index_l_3_86.endRadius, endpoint_index_l_3_86.baseRadius, endpoint_index_l_3_86.length, 16, 6)
    : buildWatertightCapsule(0.35, 0.7, 8, 16, 1);
  if (!endpoint_index_l_3_86) {
    mesh_index_l_3_86Geometry.scale(0.01197, 0.0189, 0.01197);
  }
  const mesh_index_l_3_86 = new THREE.Mesh(
    mesh_index_l_3_86Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_index_l_3_86.name = "Index L 3";
  if (endpoint_index_l_3_86) {
    mesh_index_l_3_86.position.copy(endpoint_index_l_3_86.midpoint);
    mesh_index_l_3_86.quaternion.copy(endpoint_index_l_3_86.quaternion);
  }
  mesh_index_l_3_86.castShadow = options.castShadow ?? true;
  mesh_index_l_3_86.receiveShadow = options.receiveShadow ?? true;
  mesh_index_l_3_86.userData.sculptComponent = { id: "index-l-3" };
  node_index_l_3_86.add(mesh_index_l_3_86);
  meshes["index-l-3"] = mesh_index_l_3_86;
  colliders["index-l-3"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_index_l_3_86);

  const attachment_middle_l_1_87 = {"parentSocket": "hand-l-middle-l-1", "localStart": [-0.00315, -0.04409, 0.0126], "localEnd": [-0.00315, -0.07528, 0.01698], "contactType": "rigid-weld", "baseRadius": 0.00913, "endRadius": 0.00756, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_middle_l_1_87 = makeAttachmentEndpoint(attachment_middle_l_1_87);
  const node_middle_l_1_87 = new THREE.Group();
  node_middle_l_1_87.name = "Middle L 1__pivot";
  node_middle_l_1_87.scale.set(1, 1, 1);
  if (endpoint_middle_l_1_87) {
    node_middle_l_1_87.position.copy(endpoint_middle_l_1_87.start);
    node_middle_l_1_87.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_middle_l_1_87.position.set(-0.00315, -0.04409, 0.0126);
    node_middle_l_1_87.rotation.set(0.0, 0.0, 0.0);
  }
  node_middle_l_1_87.userData.sculptComponent = { id: "middle-l-1" };
  node_middle_l_1_87.userData.actionProfile = {};
  (nodes["hand-l"] ?? root).add(node_middle_l_1_87);
  nodes["middle-l-1"] = node_middle_l_1_87;
  const mesh_middle_l_1_87Geometry = endpoint_middle_l_1_87
    ? new THREE.CylinderGeometry(endpoint_middle_l_1_87.endRadius, endpoint_middle_l_1_87.baseRadius, endpoint_middle_l_1_87.length, 16, 6)
    : buildWatertightCapsule(0.35, 0.7, 8, 16, 1);
  if (!endpoint_middle_l_1_87) {
    mesh_middle_l_1_87Geometry.scale(0.01827, 0.0315, 0.01827);
  }
  const mesh_middle_l_1_87 = new THREE.Mesh(
    mesh_middle_l_1_87Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_middle_l_1_87.name = "Middle L 1";
  if (endpoint_middle_l_1_87) {
    mesh_middle_l_1_87.position.copy(endpoint_middle_l_1_87.midpoint);
    mesh_middle_l_1_87.quaternion.copy(endpoint_middle_l_1_87.quaternion);
  }
  mesh_middle_l_1_87.castShadow = options.castShadow ?? true;
  mesh_middle_l_1_87.receiveShadow = options.receiveShadow ?? true;
  mesh_middle_l_1_87.userData.sculptComponent = { id: "middle-l-1" };
  node_middle_l_1_87.add(mesh_middle_l_1_87);
  meshes["middle-l-1"] = mesh_middle_l_1_87;
  colliders["middle-l-1"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_middle_l_1_87);

  const attachment_middle_l_2_88 = {"parentSocket": "middle-l-1-middle-l-2", "localStart": [0.0, -0.03119, 0.00438], "localEnd": [0.0, -0.05515, 0.01217], "contactType": "hinge-joint", "baseRadius": 0.00756, "endRadius": 0.00598, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_middle_l_2_88 = makeAttachmentEndpoint(attachment_middle_l_2_88);
  const node_middle_l_2_88 = new THREE.Group();
  node_middle_l_2_88.name = "Middle L 2__pivot";
  node_middle_l_2_88.scale.set(1, 1, 1);
  if (endpoint_middle_l_2_88) {
    node_middle_l_2_88.position.copy(endpoint_middle_l_2_88.start);
    node_middle_l_2_88.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_middle_l_2_88.position.set(0.0, -0.03119, 0.00438);
    node_middle_l_2_88.rotation.set(0.0, 0.0, 0.0);
  }
  node_middle_l_2_88.userData.sculptComponent = { id: "middle-l-2" };
  node_middle_l_2_88.userData.actionProfile = {};
  (nodes["middle-l-1"] ?? root).add(node_middle_l_2_88);
  nodes["middle-l-2"] = node_middle_l_2_88;
  const mesh_middle_l_2_88Geometry = endpoint_middle_l_2_88
    ? new THREE.CylinderGeometry(endpoint_middle_l_2_88.endRadius, endpoint_middle_l_2_88.baseRadius, endpoint_middle_l_2_88.length, 16, 6)
    : buildWatertightCapsule(0.35, 0.7, 8, 16, 1);
  if (!endpoint_middle_l_2_88) {
    mesh_middle_l_2_88Geometry.scale(0.01512, 0.0252, 0.01512);
  }
  const mesh_middle_l_2_88 = new THREE.Mesh(
    mesh_middle_l_2_88Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_middle_l_2_88.name = "Middle L 2";
  if (endpoint_middle_l_2_88) {
    mesh_middle_l_2_88.position.copy(endpoint_middle_l_2_88.midpoint);
    mesh_middle_l_2_88.quaternion.copy(endpoint_middle_l_2_88.quaternion);
  }
  mesh_middle_l_2_88.castShadow = options.castShadow ?? true;
  mesh_middle_l_2_88.receiveShadow = options.receiveShadow ?? true;
  mesh_middle_l_2_88.userData.sculptComponent = { id: "middle-l-2" };
  node_middle_l_2_88.add(mesh_middle_l_2_88);
  meshes["middle-l-2"] = mesh_middle_l_2_88;
  colliders["middle-l-2"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_middle_l_2_88);

  const attachment_middle_l_3_89 = {"parentSocket": "middle-l-2-middle-l-3", "localStart": [0.0, -0.02396, 0.00779], "localEnd": [0.0, -0.04065, 0.01666], "contactType": "hinge-joint", "baseRadius": 0.00598, "endRadius": 0.00441, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_middle_l_3_89 = makeAttachmentEndpoint(attachment_middle_l_3_89);
  const node_middle_l_3_89 = new THREE.Group();
  node_middle_l_3_89.name = "Middle L 3__pivot";
  node_middle_l_3_89.scale.set(1, 1, 1);
  if (endpoint_middle_l_3_89) {
    node_middle_l_3_89.position.copy(endpoint_middle_l_3_89.start);
    node_middle_l_3_89.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_middle_l_3_89.position.set(0.0, -0.02396, 0.00779);
    node_middle_l_3_89.rotation.set(0.0, 0.0, 0.0);
  }
  node_middle_l_3_89.userData.sculptComponent = { id: "middle-l-3" };
  node_middle_l_3_89.userData.actionProfile = {};
  (nodes["middle-l-2"] ?? root).add(node_middle_l_3_89);
  nodes["middle-l-3"] = node_middle_l_3_89;
  const mesh_middle_l_3_89Geometry = endpoint_middle_l_3_89
    ? new THREE.CylinderGeometry(endpoint_middle_l_3_89.endRadius, endpoint_middle_l_3_89.baseRadius, endpoint_middle_l_3_89.length, 16, 6)
    : buildWatertightCapsule(0.35, 0.7, 8, 16, 1);
  if (!endpoint_middle_l_3_89) {
    mesh_middle_l_3_89Geometry.scale(0.01197, 0.0189, 0.01197);
  }
  const mesh_middle_l_3_89 = new THREE.Mesh(
    mesh_middle_l_3_89Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_middle_l_3_89.name = "Middle L 3";
  if (endpoint_middle_l_3_89) {
    mesh_middle_l_3_89.position.copy(endpoint_middle_l_3_89.midpoint);
    mesh_middle_l_3_89.quaternion.copy(endpoint_middle_l_3_89.quaternion);
  }
  mesh_middle_l_3_89.castShadow = options.castShadow ?? true;
  mesh_middle_l_3_89.receiveShadow = options.receiveShadow ?? true;
  mesh_middle_l_3_89.userData.sculptComponent = { id: "middle-l-3" };
  node_middle_l_3_89.add(mesh_middle_l_3_89);
  meshes["middle-l-3"] = mesh_middle_l_3_89;
  colliders["middle-l-3"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_middle_l_3_89);

  const attachment_ring_l_1_90 = {"parentSocket": "hand-l-ring-l-1", "localStart": [0.01575, -0.04409, 0.0126], "localEnd": [0.01811, -0.07206, 0.01657], "contactType": "rigid-weld", "baseRadius": 0.00913, "endRadius": 0.00756, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_ring_l_1_90 = makeAttachmentEndpoint(attachment_ring_l_1_90);
  const node_ring_l_1_90 = new THREE.Group();
  node_ring_l_1_90.name = "Ring L 1__pivot";
  node_ring_l_1_90.scale.set(1, 1, 1);
  if (endpoint_ring_l_1_90) {
    node_ring_l_1_90.position.copy(endpoint_ring_l_1_90.start);
    node_ring_l_1_90.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_ring_l_1_90.position.set(0.01575, -0.04409, 0.0126);
    node_ring_l_1_90.rotation.set(0.0, 0.0, 0.0);
  }
  node_ring_l_1_90.userData.sculptComponent = { id: "ring-l-1" };
  node_ring_l_1_90.userData.actionProfile = {};
  (nodes["hand-l"] ?? root).add(node_ring_l_1_90);
  nodes["ring-l-1"] = node_ring_l_1_90;
  const mesh_ring_l_1_90Geometry = endpoint_ring_l_1_90
    ? new THREE.CylinderGeometry(endpoint_ring_l_1_90.endRadius, endpoint_ring_l_1_90.baseRadius, endpoint_ring_l_1_90.length, 16, 6)
    : buildWatertightCapsule(0.35, 0.7, 8, 16, 1);
  if (!endpoint_ring_l_1_90) {
    mesh_ring_l_1_90Geometry.scale(0.01827, 0.02835, 0.01827);
  }
  const mesh_ring_l_1_90 = new THREE.Mesh(
    mesh_ring_l_1_90Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ring_l_1_90.name = "Ring L 1";
  if (endpoint_ring_l_1_90) {
    mesh_ring_l_1_90.position.copy(endpoint_ring_l_1_90.midpoint);
    mesh_ring_l_1_90.quaternion.copy(endpoint_ring_l_1_90.quaternion);
  }
  mesh_ring_l_1_90.castShadow = options.castShadow ?? true;
  mesh_ring_l_1_90.receiveShadow = options.receiveShadow ?? true;
  mesh_ring_l_1_90.userData.sculptComponent = { id: "ring-l-1" };
  node_ring_l_1_90.add(mesh_ring_l_1_90);
  meshes["ring-l-1"] = mesh_ring_l_1_90;
  colliders["ring-l-1"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_ring_l_1_90);

  const attachment_ring_l_2_91 = {"parentSocket": "ring-l-1-ring-l-2", "localStart": [0.00236, -0.02797, 0.00397], "localEnd": [0.00412, -0.04885, 0.01082], "contactType": "hinge-joint", "baseRadius": 0.00756, "endRadius": 0.00598, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_ring_l_2_91 = makeAttachmentEndpoint(attachment_ring_l_2_91);
  const node_ring_l_2_91 = new THREE.Group();
  node_ring_l_2_91.name = "Ring L 2__pivot";
  node_ring_l_2_91.scale.set(1, 1, 1);
  if (endpoint_ring_l_2_91) {
    node_ring_l_2_91.position.copy(endpoint_ring_l_2_91.start);
    node_ring_l_2_91.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_ring_l_2_91.position.set(0.00236, -0.02797, 0.00397);
    node_ring_l_2_91.rotation.set(0.0, 0.0, 0.0);
  }
  node_ring_l_2_91.userData.sculptComponent = { id: "ring-l-2" };
  node_ring_l_2_91.userData.actionProfile = {};
  (nodes["ring-l-1"] ?? root).add(node_ring_l_2_91);
  nodes["ring-l-2"] = node_ring_l_2_91;
  const mesh_ring_l_2_91Geometry = endpoint_ring_l_2_91
    ? new THREE.CylinderGeometry(endpoint_ring_l_2_91.endRadius, endpoint_ring_l_2_91.baseRadius, endpoint_ring_l_2_91.length, 16, 6)
    : buildWatertightCapsule(0.35, 0.7, 8, 16, 1);
  if (!endpoint_ring_l_2_91) {
    mesh_ring_l_2_91Geometry.scale(0.01512, 0.02205, 0.01512);
  }
  const mesh_ring_l_2_91 = new THREE.Mesh(
    mesh_ring_l_2_91Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ring_l_2_91.name = "Ring L 2";
  if (endpoint_ring_l_2_91) {
    mesh_ring_l_2_91.position.copy(endpoint_ring_l_2_91.midpoint);
    mesh_ring_l_2_91.quaternion.copy(endpoint_ring_l_2_91.quaternion);
  }
  mesh_ring_l_2_91.castShadow = options.castShadow ?? true;
  mesh_ring_l_2_91.receiveShadow = options.receiveShadow ?? true;
  mesh_ring_l_2_91.userData.sculptComponent = { id: "ring-l-2" };
  node_ring_l_2_91.add(mesh_ring_l_2_91);
  meshes["ring-l-2"] = mesh_ring_l_2_91;
  colliders["ring-l-2"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_ring_l_2_91);

  const attachment_ring_l_3_92 = {"parentSocket": "ring-l-2-ring-l-3", "localStart": [0.00176, -0.02088, 0.00685], "localEnd": [0.00316, -0.03749, 0.01577], "contactType": "hinge-joint", "baseRadius": 0.00598, "endRadius": 0.00441, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_ring_l_3_92 = makeAttachmentEndpoint(attachment_ring_l_3_92);
  const node_ring_l_3_92 = new THREE.Group();
  node_ring_l_3_92.name = "Ring L 3__pivot";
  node_ring_l_3_92.scale.set(1, 1, 1);
  if (endpoint_ring_l_3_92) {
    node_ring_l_3_92.position.copy(endpoint_ring_l_3_92.start);
    node_ring_l_3_92.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_ring_l_3_92.position.set(0.00176, -0.02088, 0.00685);
    node_ring_l_3_92.rotation.set(0.0, 0.0, 0.0);
  }
  node_ring_l_3_92.userData.sculptComponent = { id: "ring-l-3" };
  node_ring_l_3_92.userData.actionProfile = {};
  (nodes["ring-l-2"] ?? root).add(node_ring_l_3_92);
  nodes["ring-l-3"] = node_ring_l_3_92;
  const mesh_ring_l_3_92Geometry = endpoint_ring_l_3_92
    ? new THREE.CylinderGeometry(endpoint_ring_l_3_92.endRadius, endpoint_ring_l_3_92.baseRadius, endpoint_ring_l_3_92.length, 16, 6)
    : buildWatertightCapsule(0.35, 0.7, 8, 16, 1);
  if (!endpoint_ring_l_3_92) {
    mesh_ring_l_3_92Geometry.scale(0.01197, 0.0189, 0.01197);
  }
  const mesh_ring_l_3_92 = new THREE.Mesh(
    mesh_ring_l_3_92Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ring_l_3_92.name = "Ring L 3";
  if (endpoint_ring_l_3_92) {
    mesh_ring_l_3_92.position.copy(endpoint_ring_l_3_92.midpoint);
    mesh_ring_l_3_92.quaternion.copy(endpoint_ring_l_3_92.quaternion);
  }
  mesh_ring_l_3_92.castShadow = options.castShadow ?? true;
  mesh_ring_l_3_92.receiveShadow = options.receiveShadow ?? true;
  mesh_ring_l_3_92.userData.sculptComponent = { id: "ring-l-3" };
  node_ring_l_3_92.add(mesh_ring_l_3_92);
  meshes["ring-l-3"] = mesh_ring_l_3_92;
  colliders["ring-l-3"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_ring_l_3_92);

  const attachment_little_l_1_93 = {"parentSocket": "hand-l-little-l-1", "localStart": [0.0315, -0.04409, 0.00945], "localEnd": [0.0352, -0.0656, 0.01259], "contactType": "rigid-weld", "baseRadius": 0.00913, "endRadius": 0.00756, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_little_l_1_93 = makeAttachmentEndpoint(attachment_little_l_1_93);
  const node_little_l_1_93 = new THREE.Group();
  node_little_l_1_93.name = "Little L 1__pivot";
  node_little_l_1_93.scale.set(1, 1, 1);
  if (endpoint_little_l_1_93) {
    node_little_l_1_93.position.copy(endpoint_little_l_1_93.start);
    node_little_l_1_93.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_little_l_1_93.position.set(0.0315, -0.04409, 0.00945);
    node_little_l_1_93.rotation.set(0.0, 0.0, 0.0);
  }
  node_little_l_1_93.userData.sculptComponent = { id: "little-l-1" };
  node_little_l_1_93.userData.actionProfile = {};
  (nodes["hand-l"] ?? root).add(node_little_l_1_93);
  nodes["little-l-1"] = node_little_l_1_93;
  const mesh_little_l_1_93Geometry = endpoint_little_l_1_93
    ? new THREE.CylinderGeometry(endpoint_little_l_1_93.endRadius, endpoint_little_l_1_93.baseRadius, endpoint_little_l_1_93.length, 16, 6)
    : buildWatertightCapsule(0.35, 0.7, 8, 16, 1);
  if (!endpoint_little_l_1_93) {
    mesh_little_l_1_93Geometry.scale(0.01827, 0.02205, 0.01827);
  }
  const mesh_little_l_1_93 = new THREE.Mesh(
    mesh_little_l_1_93Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_little_l_1_93.name = "Little L 1";
  if (endpoint_little_l_1_93) {
    mesh_little_l_1_93.position.copy(endpoint_little_l_1_93.midpoint);
    mesh_little_l_1_93.quaternion.copy(endpoint_little_l_1_93.quaternion);
  }
  mesh_little_l_1_93.castShadow = options.castShadow ?? true;
  mesh_little_l_1_93.receiveShadow = options.receiveShadow ?? true;
  mesh_little_l_1_93.userData.sculptComponent = { id: "little-l-1" };
  node_little_l_1_93.add(mesh_little_l_1_93);
  meshes["little-l-1"] = mesh_little_l_1_93;
  colliders["little-l-1"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_little_l_1_93);

  const attachment_little_l_2_94 = {"parentSocket": "little-l-1-little-l-2", "localStart": [0.0037, -0.02151, 0.00314], "localEnd": [0.00623, -0.03623, 0.00812], "contactType": "hinge-joint", "baseRadius": 0.00756, "endRadius": 0.00598, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_little_l_2_94 = makeAttachmentEndpoint(attachment_little_l_2_94);
  const node_little_l_2_94 = new THREE.Group();
  node_little_l_2_94.name = "Little L 2__pivot";
  node_little_l_2_94.scale.set(1, 1, 1);
  if (endpoint_little_l_2_94) {
    node_little_l_2_94.position.copy(endpoint_little_l_2_94.start);
    node_little_l_2_94.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_little_l_2_94.position.set(0.0037, -0.02151, 0.00314);
    node_little_l_2_94.rotation.set(0.0, 0.0, 0.0);
  }
  node_little_l_2_94.userData.sculptComponent = { id: "little-l-2" };
  node_little_l_2_94.userData.actionProfile = {};
  (nodes["little-l-1"] ?? root).add(node_little_l_2_94);
  nodes["little-l-2"] = node_little_l_2_94;
  const mesh_little_l_2_94Geometry = endpoint_little_l_2_94
    ? new THREE.CylinderGeometry(endpoint_little_l_2_94.endRadius, endpoint_little_l_2_94.baseRadius, endpoint_little_l_2_94.length, 16, 6)
    : buildWatertightCapsule(0.35, 0.7, 8, 16, 1);
  if (!endpoint_little_l_2_94) {
    mesh_little_l_2_94Geometry.scale(0.01512, 0.01575, 0.01512);
  }
  const mesh_little_l_2_94 = new THREE.Mesh(
    mesh_little_l_2_94Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_little_l_2_94.name = "Little L 2";
  if (endpoint_little_l_2_94) {
    mesh_little_l_2_94.position.copy(endpoint_little_l_2_94.midpoint);
    mesh_little_l_2_94.quaternion.copy(endpoint_little_l_2_94.quaternion);
  }
  mesh_little_l_2_94.castShadow = options.castShadow ?? true;
  mesh_little_l_2_94.receiveShadow = options.receiveShadow ?? true;
  mesh_little_l_2_94.userData.sculptComponent = { id: "little-l-2" };
  node_little_l_2_94.add(mesh_little_l_2_94);
  meshes["little-l-2"] = mesh_little_l_2_94;
  colliders["little-l-2"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_little_l_2_94);

  const attachment_little_l_3_95 = {"parentSocket": "little-l-2-little-l-3", "localStart": [0.00253, -0.01472, 0.00498], "localEnd": [0.00488, -0.02835, 0.01251], "contactType": "hinge-joint", "baseRadius": 0.00598, "endRadius": 0.00441, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_little_l_3_95 = makeAttachmentEndpoint(attachment_little_l_3_95);
  const node_little_l_3_95 = new THREE.Group();
  node_little_l_3_95.name = "Little L 3__pivot";
  node_little_l_3_95.scale.set(1, 1, 1);
  if (endpoint_little_l_3_95) {
    node_little_l_3_95.position.copy(endpoint_little_l_3_95.start);
    node_little_l_3_95.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_little_l_3_95.position.set(0.00253, -0.01472, 0.00498);
    node_little_l_3_95.rotation.set(0.0, 0.0, 0.0);
  }
  node_little_l_3_95.userData.sculptComponent = { id: "little-l-3" };
  node_little_l_3_95.userData.actionProfile = {};
  (nodes["little-l-2"] ?? root).add(node_little_l_3_95);
  nodes["little-l-3"] = node_little_l_3_95;
  const mesh_little_l_3_95Geometry = endpoint_little_l_3_95
    ? new THREE.CylinderGeometry(endpoint_little_l_3_95.endRadius, endpoint_little_l_3_95.baseRadius, endpoint_little_l_3_95.length, 16, 6)
    : buildWatertightCapsule(0.35, 0.7, 8, 16, 1);
  if (!endpoint_little_l_3_95) {
    mesh_little_l_3_95Geometry.scale(0.01197, 0.01575, 0.01197);
  }
  const mesh_little_l_3_95 = new THREE.Mesh(
    mesh_little_l_3_95Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_little_l_3_95.name = "Little L 3";
  if (endpoint_little_l_3_95) {
    mesh_little_l_3_95.position.copy(endpoint_little_l_3_95.midpoint);
    mesh_little_l_3_95.quaternion.copy(endpoint_little_l_3_95.quaternion);
  }
  mesh_little_l_3_95.castShadow = options.castShadow ?? true;
  mesh_little_l_3_95.receiveShadow = options.receiveShadow ?? true;
  mesh_little_l_3_95.userData.sculptComponent = { id: "little-l-3" };
  node_little_l_3_95.add(mesh_little_l_3_95);
  meshes["little-l-3"] = mesh_little_l_3_95;
  colliders["little-l-3"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_little_l_3_95);

  const endpoint_shoulder_joint_r_96 = makeAttachmentEndpoint(null);
  const node_shoulder_joint_r_96 = new THREE.Group();
  node_shoulder_joint_r_96.name = "Shoulder joint R__pivot";
  node_shoulder_joint_r_96.scale.set(1, 1, 1);
  if (endpoint_shoulder_joint_r_96) {
    node_shoulder_joint_r_96.position.copy(endpoint_shoulder_joint_r_96.start);
    node_shoulder_joint_r_96.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_shoulder_joint_r_96.position.set(-0.21417, 0.22677, -0.0063);
    node_shoulder_joint_r_96.rotation.set(0.0, 0.0, 0.0);
  }
  node_shoulder_joint_r_96.userData.sculptComponent = { id: "shoulder-joint-r" };
  node_shoulder_joint_r_96.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_shoulder_joint_r_96);
  nodes["shoulder-joint-r"] = node_shoulder_joint_r_96;
  const mesh_shoulder_joint_r_96Geometry = endpoint_shoulder_joint_r_96
    ? new THREE.CylinderGeometry(endpoint_shoulder_joint_r_96.endRadius, endpoint_shoulder_joint_r_96.baseRadius, endpoint_shoulder_joint_r_96.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_shoulder_joint_r_96) {
    mesh_shoulder_joint_r_96Geometry.scale(0.10079, 0.10079, 0.10079);
  }
  const mesh_shoulder_joint_r_96 = new THREE.Mesh(
    mesh_shoulder_joint_r_96Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_shoulder_joint_r_96.name = "Shoulder joint R";
  if (endpoint_shoulder_joint_r_96) {
    mesh_shoulder_joint_r_96.position.copy(endpoint_shoulder_joint_r_96.midpoint);
    mesh_shoulder_joint_r_96.quaternion.copy(endpoint_shoulder_joint_r_96.quaternion);
  }
  mesh_shoulder_joint_r_96.castShadow = options.castShadow ?? true;
  mesh_shoulder_joint_r_96.receiveShadow = options.receiveShadow ?? true;
  mesh_shoulder_joint_r_96.userData.sculptComponent = { id: "shoulder-joint-r" };
  node_shoulder_joint_r_96.add(mesh_shoulder_joint_r_96);
  meshes["shoulder-joint-r"] = mesh_shoulder_joint_r_96;
  colliders["shoulder-joint-r"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_shoulder_joint_r_96);

  const endpoint_pauldron_r_97 = makeAttachmentEndpoint(null);
  const node_pauldron_r_97 = new THREE.Group();
  node_pauldron_r_97.name = "Pauldron R__pivot";
  node_pauldron_r_97.scale.set(1, 1, 1);
  if (endpoint_pauldron_r_97) {
    node_pauldron_r_97.position.copy(endpoint_pauldron_r_97.start);
    node_pauldron_r_97.rotation.set(0.0, -0.0, 0.0);
  } else {
    node_pauldron_r_97.position.set(-0.25197, 0.34016, 0.0126);
    node_pauldron_r_97.rotation.set(0.0, -0.0, 0.0);
  }
  node_pauldron_r_97.userData.sculptComponent = { id: "pauldron-r" };
  node_pauldron_r_97.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_pauldron_r_97);
  nodes["pauldron-r"] = node_pauldron_r_97;
  const mesh_pauldron_r_97Geometry = endpoint_pauldron_r_97
    ? new THREE.CylinderGeometry(endpoint_pauldron_r_97.endRadius, endpoint_pauldron_r_97.baseRadius, endpoint_pauldron_r_97.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.03465, "rz": 0.02835, "twist": 0.0}, {"position": [-0.04409, -0.07559, 0.0063], "rx": 0.05984, "rz": 0.05039, "twist": 0.0}, {"position": [-0.06929, -0.15748, 0.0063], "rx": 0.07244, "rz": 0.06299, "twist": 0.0}, {"position": [-0.05669, -0.23307, 0.0], "rx": 0.05984, "rz": 0.05039, "twist": 0.0}, {"position": [-0.0378, -0.28346, -0.0063], "rx": 0.0252, "rz": 0.0189, "twist": 0.0}], "radialSegments": 22, "capEnds": true});
  if (!endpoint_pauldron_r_97) {
    mesh_pauldron_r_97Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_pauldron_r_97 = new THREE.Mesh(
    mesh_pauldron_r_97Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pauldron_r_97.name = "Pauldron R";
  if (endpoint_pauldron_r_97) {
    mesh_pauldron_r_97.position.copy(endpoint_pauldron_r_97.midpoint);
    mesh_pauldron_r_97.quaternion.copy(endpoint_pauldron_r_97.quaternion);
  }
  mesh_pauldron_r_97.castShadow = options.castShadow ?? true;
  mesh_pauldron_r_97.receiveShadow = options.receiveShadow ?? true;
  mesh_pauldron_r_97.userData.sculptComponent = { id: "pauldron-r" };
  node_pauldron_r_97.add(mesh_pauldron_r_97);
  meshes["pauldron-r"] = mesh_pauldron_r_97;
  colliders["pauldron-r"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_pauldron_r_97);

  const endpoint_pauldron_top_r_98 = makeAttachmentEndpoint(null);
  const node_pauldron_top_r_98 = new THREE.Group();
  node_pauldron_top_r_98.name = "Pauldron top petal R__pivot";
  node_pauldron_top_r_98.scale.set(1, 1, 1);
  if (endpoint_pauldron_top_r_98) {
    node_pauldron_top_r_98.position.copy(endpoint_pauldron_top_r_98.start);
    node_pauldron_top_r_98.rotation.set(0.0, -0.5, 0.0);
  } else {
    node_pauldron_top_r_98.position.set(-0.24567, 0.34646, 0.0252);
    node_pauldron_top_r_98.rotation.set(0.0, -0.5, 0.0);
  }
  node_pauldron_top_r_98.userData.sculptComponent = { id: "pauldron-top-r" };
  node_pauldron_top_r_98.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_pauldron_top_r_98);
  nodes["pauldron-top-r"] = node_pauldron_top_r_98;
  const mesh_pauldron_top_r_98Geometry = endpoint_pauldron_top_r_98
    ? new THREE.CylinderGeometry(endpoint_pauldron_top_r_98.endRadius, endpoint_pauldron_top_r_98.baseRadius, endpoint_pauldron_top_r_98.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.0189, "rz": 0.01575, "twist": 0.0}, {"position": [-0.0252, -0.06299, 0.0126], "rx": 0.04724, "rz": 0.04094, "twist": 0.0}, {"position": [-0.04409, -0.13228, 0.0063], "rx": 0.01575, "rz": 0.0126, "twist": 0.0}], "radialSegments": 18, "capEnds": true});
  if (!endpoint_pauldron_top_r_98) {
    mesh_pauldron_top_r_98Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_pauldron_top_r_98 = new THREE.Mesh(
    mesh_pauldron_top_r_98Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pauldron_top_r_98.name = "Pauldron top petal R";
  if (endpoint_pauldron_top_r_98) {
    mesh_pauldron_top_r_98.position.copy(endpoint_pauldron_top_r_98.midpoint);
    mesh_pauldron_top_r_98.quaternion.copy(endpoint_pauldron_top_r_98.quaternion);
  }
  mesh_pauldron_top_r_98.castShadow = options.castShadow ?? true;
  mesh_pauldron_top_r_98.receiveShadow = options.receiveShadow ?? true;
  mesh_pauldron_top_r_98.userData.sculptComponent = { id: "pauldron-top-r" };
  node_pauldron_top_r_98.add(mesh_pauldron_top_r_98);
  meshes["pauldron-top-r"] = mesh_pauldron_top_r_98;
  colliders["pauldron-top-r"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_pauldron_top_r_98);

  const endpoint_pauldron_low_r_99 = makeAttachmentEndpoint(null);
  const node_pauldron_low_r_99 = new THREE.Group();
  node_pauldron_low_r_99.name = "Pauldron lower petal R__pivot";
  node_pauldron_low_r_99.scale.set(1, 1, 1);
  if (endpoint_pauldron_low_r_99) {
    node_pauldron_low_r_99.position.copy(endpoint_pauldron_low_r_99.start);
    node_pauldron_low_r_99.rotation.set(0.0, -0.4, 0.0);
  } else {
    node_pauldron_low_r_99.position.set(-0.30866, 0.15118, 0.0126);
    node_pauldron_low_r_99.rotation.set(0.0, -0.4, 0.0);
  }
  node_pauldron_low_r_99.userData.sculptComponent = { id: "pauldron-low-r" };
  node_pauldron_low_r_99.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_pauldron_low_r_99);
  nodes["pauldron-low-r"] = node_pauldron_low_r_99;
  const mesh_pauldron_low_r_99Geometry = endpoint_pauldron_low_r_99
    ? new THREE.CylinderGeometry(endpoint_pauldron_low_r_99.endRadius, endpoint_pauldron_low_r_99.baseRadius, endpoint_pauldron_low_r_99.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.03465, "rz": 0.0252, "twist": 0.0}, {"position": [-0.0189, -0.06929, 0.0126], "rx": 0.04724, "rz": 0.04094, "twist": 0.0}, {"position": [-0.0063, -0.13858, 0.0063], "rx": 0.0252, "rz": 0.01575, "twist": 0.0}], "radialSegments": 18, "capEnds": true});
  if (!endpoint_pauldron_low_r_99) {
    mesh_pauldron_low_r_99Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_pauldron_low_r_99 = new THREE.Mesh(
    mesh_pauldron_low_r_99Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pauldron_low_r_99.name = "Pauldron lower petal R";
  if (endpoint_pauldron_low_r_99) {
    mesh_pauldron_low_r_99.position.copy(endpoint_pauldron_low_r_99.midpoint);
    mesh_pauldron_low_r_99.quaternion.copy(endpoint_pauldron_low_r_99.quaternion);
  }
  mesh_pauldron_low_r_99.castShadow = options.castShadow ?? true;
  mesh_pauldron_low_r_99.receiveShadow = options.receiveShadow ?? true;
  mesh_pauldron_low_r_99.userData.sculptComponent = { id: "pauldron-low-r" };
  node_pauldron_low_r_99.add(mesh_pauldron_low_r_99);
  meshes["pauldron-low-r"] = mesh_pauldron_low_r_99;
  colliders["pauldron-low-r"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_pauldron_low_r_99);

  const endpoint_chest_lower_r_100 = makeAttachmentEndpoint(null);
  const node_chest_lower_r_100 = new THREE.Group();
  node_chest_lower_r_100.name = "Lower chest plate R__pivot";
  node_chest_lower_r_100.scale.set(1, 1, 1);
  if (endpoint_chest_lower_r_100) {
    node_chest_lower_r_100.position.copy(endpoint_chest_lower_r_100.start);
    node_chest_lower_r_100.rotation.set(0.0, -0.0, 0.0);
  } else {
    node_chest_lower_r_100.position.set(-0.07559, 0.06929, 0.08819);
    node_chest_lower_r_100.rotation.set(0.0, -0.0, 0.0);
  }
  node_chest_lower_r_100.userData.sculptComponent = { id: "chest-lower-r" };
  node_chest_lower_r_100.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_chest_lower_r_100);
  nodes["chest-lower-r"] = node_chest_lower_r_100;
  const mesh_chest_lower_r_100Geometry = endpoint_chest_lower_r_100
    ? new THREE.CylinderGeometry(endpoint_chest_lower_r_100.endRadius, endpoint_chest_lower_r_100.baseRadius, endpoint_chest_lower_r_100.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.0189, "rz": 0.0189, "twist": 0.0}, {"position": [0.0189, -0.08819, 0.00315], "rx": 0.0315, "rz": 0.0378, "twist": 0.0}, {"position": [0.04409, -0.17638, -0.00945], "rx": 0.0126, "rz": 0.00945, "twist": 0.0}], "radialSegments": 16, "capEnds": true});
  if (!endpoint_chest_lower_r_100) {
    mesh_chest_lower_r_100Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_chest_lower_r_100 = new THREE.Mesh(
    mesh_chest_lower_r_100Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_chest_lower_r_100.name = "Lower chest plate R";
  if (endpoint_chest_lower_r_100) {
    mesh_chest_lower_r_100.position.copy(endpoint_chest_lower_r_100.midpoint);
    mesh_chest_lower_r_100.quaternion.copy(endpoint_chest_lower_r_100.quaternion);
  }
  mesh_chest_lower_r_100.castShadow = options.castShadow ?? true;
  mesh_chest_lower_r_100.receiveShadow = options.receiveShadow ?? true;
  mesh_chest_lower_r_100.userData.sculptComponent = { id: "chest-lower-r" };
  node_chest_lower_r_100.add(mesh_chest_lower_r_100);
  meshes["chest-lower-r"] = mesh_chest_lower_r_100;
  colliders["chest-lower-r"] = {};
  destructionGroups["torso"] ??= [];
  destructionGroups["torso"].push(node_chest_lower_r_100);

  const endpoint_pauldron_glow_r_101 = makeAttachmentEndpoint(null);
  const node_pauldron_glow_r_101 = new THREE.Group();
  node_pauldron_glow_r_101.name = "Pauldron glow R__pivot";
  node_pauldron_glow_r_101.scale.set(1, 1, 1);
  if (endpoint_pauldron_glow_r_101) {
    node_pauldron_glow_r_101.position.copy(endpoint_pauldron_glow_r_101.start);
    node_pauldron_glow_r_101.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_pauldron_glow_r_101.position.set(-0.31496, 0.08819, 0.06299);
    node_pauldron_glow_r_101.rotation.set(0.0, 0.0, 0.0);
  }
  node_pauldron_glow_r_101.userData.sculptComponent = { id: "pauldron-glow-r" };
  node_pauldron_glow_r_101.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_pauldron_glow_r_101);
  nodes["pauldron-glow-r"] = node_pauldron_glow_r_101;
  const mesh_pauldron_glow_r_101Geometry = endpoint_pauldron_glow_r_101
    ? new THREE.CylinderGeometry(endpoint_pauldron_glow_r_101.endRadius, endpoint_pauldron_glow_r_101.baseRadius, endpoint_pauldron_glow_r_101.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_pauldron_glow_r_101) {
    mesh_pauldron_glow_r_101Geometry.scale(0.0252, 0.05039, 0.01575);
  }
  const mesh_pauldron_glow_r_101 = new THREE.Mesh(
    mesh_pauldron_glow_r_101Geometry,
    materialMap["emissive-blue"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pauldron_glow_r_101.name = "Pauldron glow R";
  if (endpoint_pauldron_glow_r_101) {
    mesh_pauldron_glow_r_101.position.copy(endpoint_pauldron_glow_r_101.midpoint);
    mesh_pauldron_glow_r_101.quaternion.copy(endpoint_pauldron_glow_r_101.quaternion);
  }
  mesh_pauldron_glow_r_101.castShadow = options.castShadow ?? true;
  mesh_pauldron_glow_r_101.receiveShadow = options.receiveShadow ?? true;
  mesh_pauldron_glow_r_101.userData.sculptComponent = { id: "pauldron-glow-r" };
  node_pauldron_glow_r_101.add(mesh_pauldron_glow_r_101);
  meshes["pauldron-glow-r"] = mesh_pauldron_glow_r_101;
  colliders["pauldron-glow-r"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_pauldron_glow_r_101);

  const attachment_upper_arm_r_102 = {"parentSocket": "chest-upper-arm-r", "localStart": [-0.21417, 0.22677, -0.0063], "localEnd": [-0.31496, -0.10709, 0.0], "contactType": "socket-joint", "baseRadius": 0.0378, "endRadius": 0.0315, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_upper_arm_r_102 = makeAttachmentEndpoint(attachment_upper_arm_r_102);
  const node_upper_arm_r_102 = new THREE.Group();
  node_upper_arm_r_102.name = "Upper arm core R__pivot";
  node_upper_arm_r_102.scale.set(1, 1, 1);
  if (endpoint_upper_arm_r_102) {
    node_upper_arm_r_102.position.copy(endpoint_upper_arm_r_102.start);
    node_upper_arm_r_102.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_upper_arm_r_102.position.set(-0.21417, 0.22677, -0.0063);
    node_upper_arm_r_102.rotation.set(0.0, 0.0, 0.0);
  }
  node_upper_arm_r_102.userData.sculptComponent = { id: "upper-arm-r" };
  node_upper_arm_r_102.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_upper_arm_r_102);
  nodes["upper-arm-r"] = node_upper_arm_r_102;
  const mesh_upper_arm_r_102Geometry = endpoint_upper_arm_r_102
    ? new THREE.CylinderGeometry(endpoint_upper_arm_r_102.endRadius, endpoint_upper_arm_r_102.baseRadius, endpoint_upper_arm_r_102.length, 16, 6)
    : buildWatertightCapsule(0.35, 0.7, 8, 16, 1);
  if (!endpoint_upper_arm_r_102) {
    mesh_upper_arm_r_102Geometry.scale(0.07559, 0.3488, 0.07559);
  }
  const mesh_upper_arm_r_102 = new THREE.Mesh(
    mesh_upper_arm_r_102Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_upper_arm_r_102.name = "Upper arm core R";
  if (endpoint_upper_arm_r_102) {
    mesh_upper_arm_r_102.position.copy(endpoint_upper_arm_r_102.midpoint);
    mesh_upper_arm_r_102.quaternion.copy(endpoint_upper_arm_r_102.quaternion);
  }
  mesh_upper_arm_r_102.castShadow = options.castShadow ?? true;
  mesh_upper_arm_r_102.receiveShadow = options.receiveShadow ?? true;
  mesh_upper_arm_r_102.userData.sculptComponent = { id: "upper-arm-r" };
  node_upper_arm_r_102.add(mesh_upper_arm_r_102);
  meshes["upper-arm-r"] = mesh_upper_arm_r_102;
  colliders["upper-arm-r"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_upper_arm_r_102);

  const endpoint_upper_arm_shell_r_103 = makeAttachmentEndpoint(null);
  const node_upper_arm_shell_r_103 = new THREE.Group();
  node_upper_arm_shell_r_103.name = "Bicep shell R__pivot";
  node_upper_arm_shell_r_103.scale.set(1, 1, 1);
  if (endpoint_upper_arm_shell_r_103) {
    node_upper_arm_shell_r_103.position.copy(endpoint_upper_arm_shell_r_103.start);
    node_upper_arm_shell_r_103.rotation.set(0.0, -0.0, 0.0);
  } else {
    node_upper_arm_shell_r_103.position.set(-0.0126, -0.05669, 0.0);
    node_upper_arm_shell_r_103.rotation.set(0.0, -0.0, 0.0);
  }
  node_upper_arm_shell_r_103.userData.sculptComponent = { id: "upper-arm-shell-r" };
  node_upper_arm_shell_r_103.userData.actionProfile = {};
  (nodes["upper-arm-r"] ?? root).add(node_upper_arm_shell_r_103);
  nodes["upper-arm-shell-r"] = node_upper_arm_shell_r_103;
  const mesh_upper_arm_shell_r_103Geometry = endpoint_upper_arm_shell_r_103
    ? new THREE.CylinderGeometry(endpoint_upper_arm_shell_r_103.endRadius, endpoint_upper_arm_shell_r_103.baseRadius, endpoint_upper_arm_shell_r_103.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.02205, "rz": 0.02205, "twist": 0.0}, {"position": [-0.0252, -0.10079, 0.0], "rx": 0.05669, "rz": 0.05354, "twist": 0.0}, {"position": [-0.06614, -0.23307, 0.0], "rx": 0.0252, "rz": 0.0252, "twist": 0.0}], "radialSegments": 18, "capEnds": true});
  if (!endpoint_upper_arm_shell_r_103) {
    mesh_upper_arm_shell_r_103Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_upper_arm_shell_r_103 = new THREE.Mesh(
    mesh_upper_arm_shell_r_103Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_upper_arm_shell_r_103.name = "Bicep shell R";
  if (endpoint_upper_arm_shell_r_103) {
    mesh_upper_arm_shell_r_103.position.copy(endpoint_upper_arm_shell_r_103.midpoint);
    mesh_upper_arm_shell_r_103.quaternion.copy(endpoint_upper_arm_shell_r_103.quaternion);
  }
  mesh_upper_arm_shell_r_103.castShadow = options.castShadow ?? true;
  mesh_upper_arm_shell_r_103.receiveShadow = options.receiveShadow ?? true;
  mesh_upper_arm_shell_r_103.userData.sculptComponent = { id: "upper-arm-shell-r" };
  node_upper_arm_shell_r_103.add(mesh_upper_arm_shell_r_103);
  meshes["upper-arm-shell-r"] = mesh_upper_arm_shell_r_103;
  colliders["upper-arm-shell-r"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_upper_arm_shell_r_103);

  const endpoint_elbow_r_104 = makeAttachmentEndpoint(null);
  const node_elbow_r_104 = new THREE.Group();
  node_elbow_r_104.name = "Elbow joint R__pivot";
  node_elbow_r_104.scale.set(1, 1, 1);
  if (endpoint_elbow_r_104) {
    node_elbow_r_104.position.copy(endpoint_elbow_r_104.start);
    node_elbow_r_104.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_elbow_r_104.position.set(-0.10079, -0.33386, 0.0063);
    node_elbow_r_104.rotation.set(0.0, 0.0, 0.0);
  }
  node_elbow_r_104.userData.sculptComponent = { id: "elbow-r" };
  node_elbow_r_104.userData.actionProfile = {};
  (nodes["upper-arm-r"] ?? root).add(node_elbow_r_104);
  nodes["elbow-r"] = node_elbow_r_104;
  const mesh_elbow_r_104Geometry = endpoint_elbow_r_104
    ? new THREE.CylinderGeometry(endpoint_elbow_r_104.endRadius, endpoint_elbow_r_104.baseRadius, endpoint_elbow_r_104.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_elbow_r_104) {
    mesh_elbow_r_104Geometry.scale(0.08189, 0.08189, 0.08189);
  }
  const mesh_elbow_r_104 = new THREE.Mesh(
    mesh_elbow_r_104Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_elbow_r_104.name = "Elbow joint R";
  if (endpoint_elbow_r_104) {
    mesh_elbow_r_104.position.copy(endpoint_elbow_r_104.midpoint);
    mesh_elbow_r_104.quaternion.copy(endpoint_elbow_r_104.quaternion);
  }
  mesh_elbow_r_104.castShadow = options.castShadow ?? true;
  mesh_elbow_r_104.receiveShadow = options.receiveShadow ?? true;
  mesh_elbow_r_104.userData.sculptComponent = { id: "elbow-r" };
  node_elbow_r_104.add(mesh_elbow_r_104);
  meshes["elbow-r"] = mesh_elbow_r_104;
  colliders["elbow-r"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_elbow_r_104);

  const attachment_forearm_r_105 = {"parentSocket": "upper-arm-r-forearm-r", "localStart": [-0.10079, -0.33386, 0.0063], "localEnd": [-0.13858, -0.61102, 0.0063], "contactType": "hinge-joint", "baseRadius": 0.0315, "endRadius": 0.0252, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_forearm_r_105 = makeAttachmentEndpoint(attachment_forearm_r_105);
  const node_forearm_r_105 = new THREE.Group();
  node_forearm_r_105.name = "Forearm core R__pivot";
  node_forearm_r_105.scale.set(1, 1, 1);
  if (endpoint_forearm_r_105) {
    node_forearm_r_105.position.copy(endpoint_forearm_r_105.start);
    node_forearm_r_105.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_forearm_r_105.position.set(-0.10079, -0.33386, 0.0063);
    node_forearm_r_105.rotation.set(0.0, 0.0, 0.0);
  }
  node_forearm_r_105.userData.sculptComponent = { id: "forearm-r" };
  node_forearm_r_105.userData.actionProfile = {};
  (nodes["upper-arm-r"] ?? root).add(node_forearm_r_105);
  nodes["forearm-r"] = node_forearm_r_105;
  const mesh_forearm_r_105Geometry = endpoint_forearm_r_105
    ? new THREE.CylinderGeometry(endpoint_forearm_r_105.endRadius, endpoint_forearm_r_105.baseRadius, endpoint_forearm_r_105.length, 16, 6)
    : buildWatertightCapsule(0.35, 0.7, 8, 16, 1);
  if (!endpoint_forearm_r_105) {
    mesh_forearm_r_105Geometry.scale(0.06299, 0.27973, 0.06299);
  }
  const mesh_forearm_r_105 = new THREE.Mesh(
    mesh_forearm_r_105Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_forearm_r_105.name = "Forearm core R";
  if (endpoint_forearm_r_105) {
    mesh_forearm_r_105.position.copy(endpoint_forearm_r_105.midpoint);
    mesh_forearm_r_105.quaternion.copy(endpoint_forearm_r_105.quaternion);
  }
  mesh_forearm_r_105.castShadow = options.castShadow ?? true;
  mesh_forearm_r_105.receiveShadow = options.receiveShadow ?? true;
  mesh_forearm_r_105.userData.sculptComponent = { id: "forearm-r" };
  node_forearm_r_105.add(mesh_forearm_r_105);
  meshes["forearm-r"] = mesh_forearm_r_105;
  colliders["forearm-r"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_forearm_r_105);

  const endpoint_forearm_blade_r_106 = makeAttachmentEndpoint(null);
  const node_forearm_blade_r_106 = new THREE.Group();
  node_forearm_blade_r_106.name = "Forearm fin blade R__pivot";
  node_forearm_blade_r_106.scale.set(1, 1, 1);
  if (endpoint_forearm_blade_r_106) {
    node_forearm_blade_r_106.position.copy(endpoint_forearm_blade_r_106.start);
    node_forearm_blade_r_106.rotation.set(0.0, -0.0, 0.0);
  } else {
    node_forearm_blade_r_106.position.set(-0.04409, 0.04409, 0.0126);
    node_forearm_blade_r_106.rotation.set(0.0, -0.0, 0.0);
  }
  node_forearm_blade_r_106.userData.sculptComponent = { id: "forearm-blade-r" };
  node_forearm_blade_r_106.userData.actionProfile = {};
  (nodes["forearm-r"] ?? root).add(node_forearm_blade_r_106);
  nodes["forearm-blade-r"] = node_forearm_blade_r_106;
  const mesh_forearm_blade_r_106Geometry = endpoint_forearm_blade_r_106
    ? new THREE.CylinderGeometry(endpoint_forearm_blade_r_106.endRadius, endpoint_forearm_blade_r_106.baseRadius, endpoint_forearm_blade_r_106.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.01575, "rz": 0.02835, "twist": 0.0}, {"position": [-0.0252, -0.08819, 0.0], "rx": 0.01575, "rz": 0.04724, "twist": 0.0}, {"position": [-0.0378, -0.18898, 0.0], "rx": 0.01575, "rz": 0.05039, "twist": 0.0}, {"position": [-0.04409, -0.27087, 0.0], "rx": 0.0126, "rz": 0.0315, "twist": 0.0}, {"position": [-0.05039, -0.32756, 0.0], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 20, "capEnds": true});
  if (!endpoint_forearm_blade_r_106) {
    mesh_forearm_blade_r_106Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_forearm_blade_r_106 = new THREE.Mesh(
    mesh_forearm_blade_r_106Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_forearm_blade_r_106.name = "Forearm fin blade R";
  if (endpoint_forearm_blade_r_106) {
    mesh_forearm_blade_r_106.position.copy(endpoint_forearm_blade_r_106.midpoint);
    mesh_forearm_blade_r_106.quaternion.copy(endpoint_forearm_blade_r_106.quaternion);
  }
  mesh_forearm_blade_r_106.castShadow = options.castShadow ?? true;
  mesh_forearm_blade_r_106.receiveShadow = options.receiveShadow ?? true;
  mesh_forearm_blade_r_106.userData.sculptComponent = { id: "forearm-blade-r" };
  node_forearm_blade_r_106.add(mesh_forearm_blade_r_106);
  meshes["forearm-blade-r"] = mesh_forearm_blade_r_106;
  colliders["forearm-blade-r"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_forearm_blade_r_106);

  const endpoint_forearm_shell_r_107 = makeAttachmentEndpoint(null);
  const node_forearm_shell_r_107 = new THREE.Group();
  node_forearm_shell_r_107.name = "Forearm shell R__pivot";
  node_forearm_shell_r_107.scale.set(1, 1, 1);
  if (endpoint_forearm_shell_r_107) {
    node_forearm_shell_r_107.position.copy(endpoint_forearm_shell_r_107.start);
    node_forearm_shell_r_107.rotation.set(0.0, -0.0, 0.0);
  } else {
    node_forearm_shell_r_107.position.set(-0.0063, -0.0378, -0.0063);
    node_forearm_shell_r_107.rotation.set(0.0, -0.0, 0.0);
  }
  node_forearm_shell_r_107.userData.sculptComponent = { id: "forearm-shell-r" };
  node_forearm_shell_r_107.userData.actionProfile = {};
  (nodes["forearm-r"] ?? root).add(node_forearm_shell_r_107);
  nodes["forearm-shell-r"] = node_forearm_shell_r_107;
  const mesh_forearm_shell_r_107Geometry = endpoint_forearm_shell_r_107
    ? new THREE.CylinderGeometry(endpoint_forearm_shell_r_107.endRadius, endpoint_forearm_shell_r_107.baseRadius, endpoint_forearm_shell_r_107.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.0252, "rz": 0.0252, "twist": 0.0}, {"position": [-0.0126, -0.11339, 0.0], "rx": 0.04409, "rz": 0.04409, "twist": 0.0}, {"position": [-0.0252, -0.22677, 0.0], "rx": 0.02205, "rz": 0.02205, "twist": 0.0}], "radialSegments": 18, "capEnds": true});
  if (!endpoint_forearm_shell_r_107) {
    mesh_forearm_shell_r_107Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_forearm_shell_r_107 = new THREE.Mesh(
    mesh_forearm_shell_r_107Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_forearm_shell_r_107.name = "Forearm shell R";
  if (endpoint_forearm_shell_r_107) {
    mesh_forearm_shell_r_107.position.copy(endpoint_forearm_shell_r_107.midpoint);
    mesh_forearm_shell_r_107.quaternion.copy(endpoint_forearm_shell_r_107.quaternion);
  }
  mesh_forearm_shell_r_107.castShadow = options.castShadow ?? true;
  mesh_forearm_shell_r_107.receiveShadow = options.receiveShadow ?? true;
  mesh_forearm_shell_r_107.userData.sculptComponent = { id: "forearm-shell-r" };
  node_forearm_shell_r_107.add(mesh_forearm_shell_r_107);
  meshes["forearm-shell-r"] = mesh_forearm_shell_r_107;
  colliders["forearm-shell-r"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_forearm_shell_r_107);

  const endpoint_hand_r_108 = makeAttachmentEndpoint(null);
  const node_hand_r_108 = new THREE.Group();
  node_hand_r_108.name = "Hand R__pivot";
  node_hand_r_108.scale.set(1, 1, 1);
  if (endpoint_hand_r_108) {
    node_hand_r_108.position.copy(endpoint_hand_r_108.start);
    node_hand_r_108.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hand_r_108.position.set(-0.0378, -0.32126, 0.0);
    node_hand_r_108.rotation.set(0.0, 0.0, 0.0);
  }
  node_hand_r_108.userData.sculptComponent = { id: "hand-r" };
  node_hand_r_108.userData.actionProfile = {};
  (nodes["forearm-r"] ?? root).add(node_hand_r_108);
  nodes["hand-r"] = node_hand_r_108;
  const mesh_hand_r_108Geometry = endpoint_hand_r_108
    ? new THREE.CylinderGeometry(endpoint_hand_r_108.endRadius, endpoint_hand_r_108.baseRadius, endpoint_hand_r_108.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_hand_r_108) {
    mesh_hand_r_108Geometry.scale(0.07559, 0.08819, 0.0378);
  }
  const mesh_hand_r_108 = new THREE.Mesh(
    mesh_hand_r_108Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hand_r_108.name = "Hand R";
  if (endpoint_hand_r_108) {
    mesh_hand_r_108.position.copy(endpoint_hand_r_108.midpoint);
    mesh_hand_r_108.quaternion.copy(endpoint_hand_r_108.quaternion);
  }
  mesh_hand_r_108.castShadow = options.castShadow ?? true;
  mesh_hand_r_108.receiveShadow = options.receiveShadow ?? true;
  mesh_hand_r_108.userData.sculptComponent = { id: "hand-r" };
  node_hand_r_108.add(mesh_hand_r_108);
  meshes["hand-r"] = mesh_hand_r_108;
  colliders["hand-r"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_hand_r_108);

  const attachment_thumb_r_1_109 = {"parentSocket": "hand-r-thumb-r-1", "localStart": [0.0315, -0.04409, 0.0189], "localEnd": [0.03849, -0.06801, 0.02264], "contactType": "rigid-weld", "baseRadius": 0.00913, "endRadius": 0.00756, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_thumb_r_1_109 = makeAttachmentEndpoint(attachment_thumb_r_1_109);
  const node_thumb_r_1_109 = new THREE.Group();
  node_thumb_r_1_109.name = "Thumb R 1__pivot";
  node_thumb_r_1_109.scale.set(1, 1, 1);
  if (endpoint_thumb_r_1_109) {
    node_thumb_r_1_109.position.copy(endpoint_thumb_r_1_109.start);
    node_thumb_r_1_109.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_thumb_r_1_109.position.set(0.0315, -0.04409, 0.0189);
    node_thumb_r_1_109.rotation.set(0.0, 0.0, 0.0);
  }
  node_thumb_r_1_109.userData.sculptComponent = { id: "thumb-r-1" };
  node_thumb_r_1_109.userData.actionProfile = {};
  (nodes["hand-r"] ?? root).add(node_thumb_r_1_109);
  nodes["thumb-r-1"] = node_thumb_r_1_109;
  const mesh_thumb_r_1_109Geometry = endpoint_thumb_r_1_109
    ? new THREE.CylinderGeometry(endpoint_thumb_r_1_109.endRadius, endpoint_thumb_r_1_109.baseRadius, endpoint_thumb_r_1_109.length, 16, 6)
    : buildWatertightCapsule(0.35, 0.7, 8, 16, 1);
  if (!endpoint_thumb_r_1_109) {
    mesh_thumb_r_1_109Geometry.scale(0.01827, 0.0252, 0.01827);
  }
  const mesh_thumb_r_1_109 = new THREE.Mesh(
    mesh_thumb_r_1_109Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_thumb_r_1_109.name = "Thumb R 1";
  if (endpoint_thumb_r_1_109) {
    mesh_thumb_r_1_109.position.copy(endpoint_thumb_r_1_109.midpoint);
    mesh_thumb_r_1_109.quaternion.copy(endpoint_thumb_r_1_109.quaternion);
  }
  mesh_thumb_r_1_109.castShadow = options.castShadow ?? true;
  mesh_thumb_r_1_109.receiveShadow = options.receiveShadow ?? true;
  mesh_thumb_r_1_109.userData.sculptComponent = { id: "thumb-r-1" };
  node_thumb_r_1_109.add(mesh_thumb_r_1_109);
  meshes["thumb-r-1"] = mesh_thumb_r_1_109;
  colliders["thumb-r-1"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_thumb_r_1_109);

  const attachment_thumb_r_2_110 = {"parentSocket": "thumb-r-1-thumb-r-2", "localStart": [0.007, -0.02391, 0.00374], "localEnd": [0.01285, -0.04391, 0.01097], "contactType": "hinge-joint", "baseRadius": 0.00756, "endRadius": 0.00598, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_thumb_r_2_110 = makeAttachmentEndpoint(attachment_thumb_r_2_110);
  const node_thumb_r_2_110 = new THREE.Group();
  node_thumb_r_2_110.name = "Thumb R 2__pivot";
  node_thumb_r_2_110.scale.set(1, 1, 1);
  if (endpoint_thumb_r_2_110) {
    node_thumb_r_2_110.position.copy(endpoint_thumb_r_2_110.start);
    node_thumb_r_2_110.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_thumb_r_2_110.position.set(0.007, -0.02391, 0.00374);
    node_thumb_r_2_110.rotation.set(0.0, 0.0, 0.0);
  }
  node_thumb_r_2_110.userData.sculptComponent = { id: "thumb-r-2" };
  node_thumb_r_2_110.userData.actionProfile = {};
  (nodes["thumb-r-1"] ?? root).add(node_thumb_r_2_110);
  nodes["thumb-r-2"] = node_thumb_r_2_110;
  const mesh_thumb_r_2_110Geometry = endpoint_thumb_r_2_110
    ? new THREE.CylinderGeometry(endpoint_thumb_r_2_110.endRadius, endpoint_thumb_r_2_110.baseRadius, endpoint_thumb_r_2_110.length, 16, 6)
    : buildWatertightCapsule(0.35, 0.7, 8, 16, 1);
  if (!endpoint_thumb_r_2_110) {
    mesh_thumb_r_2_110Geometry.scale(0.01512, 0.02205, 0.01512);
  }
  const mesh_thumb_r_2_110 = new THREE.Mesh(
    mesh_thumb_r_2_110Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_thumb_r_2_110.name = "Thumb R 2";
  if (endpoint_thumb_r_2_110) {
    mesh_thumb_r_2_110.position.copy(endpoint_thumb_r_2_110.midpoint);
    mesh_thumb_r_2_110.quaternion.copy(endpoint_thumb_r_2_110.quaternion);
  }
  mesh_thumb_r_2_110.castShadow = options.castShadow ?? true;
  mesh_thumb_r_2_110.receiveShadow = options.receiveShadow ?? true;
  mesh_thumb_r_2_110.userData.sculptComponent = { id: "thumb-r-2" };
  node_thumb_r_2_110.add(mesh_thumb_r_2_110);
  meshes["thumb-r-2"] = mesh_thumb_r_2_110;
  colliders["thumb-r-2"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_thumb_r_2_110);

  const attachment_thumb_r_3_111 = {"parentSocket": "thumb-r-2-thumb-r-3", "localStart": [0.00585, -0.01999, 0.00723], "localEnd": [0.01047, -0.03576, 0.01656], "contactType": "hinge-joint", "baseRadius": 0.00598, "endRadius": 0.00441, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_thumb_r_3_111 = makeAttachmentEndpoint(attachment_thumb_r_3_111);
  const node_thumb_r_3_111 = new THREE.Group();
  node_thumb_r_3_111.name = "Thumb R 3__pivot";
  node_thumb_r_3_111.scale.set(1, 1, 1);
  if (endpoint_thumb_r_3_111) {
    node_thumb_r_3_111.position.copy(endpoint_thumb_r_3_111.start);
    node_thumb_r_3_111.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_thumb_r_3_111.position.set(0.00585, -0.01999, 0.00723);
    node_thumb_r_3_111.rotation.set(0.0, 0.0, 0.0);
  }
  node_thumb_r_3_111.userData.sculptComponent = { id: "thumb-r-3" };
  node_thumb_r_3_111.userData.actionProfile = {};
  (nodes["thumb-r-2"] ?? root).add(node_thumb_r_3_111);
  nodes["thumb-r-3"] = node_thumb_r_3_111;
  const mesh_thumb_r_3_111Geometry = endpoint_thumb_r_3_111
    ? new THREE.CylinderGeometry(endpoint_thumb_r_3_111.endRadius, endpoint_thumb_r_3_111.baseRadius, endpoint_thumb_r_3_111.length, 16, 6)
    : buildWatertightCapsule(0.35, 0.7, 8, 16, 1);
  if (!endpoint_thumb_r_3_111) {
    mesh_thumb_r_3_111Geometry.scale(0.01197, 0.0189, 0.01197);
  }
  const mesh_thumb_r_3_111 = new THREE.Mesh(
    mesh_thumb_r_3_111Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_thumb_r_3_111.name = "Thumb R 3";
  if (endpoint_thumb_r_3_111) {
    mesh_thumb_r_3_111.position.copy(endpoint_thumb_r_3_111.midpoint);
    mesh_thumb_r_3_111.quaternion.copy(endpoint_thumb_r_3_111.quaternion);
  }
  mesh_thumb_r_3_111.castShadow = options.castShadow ?? true;
  mesh_thumb_r_3_111.receiveShadow = options.receiveShadow ?? true;
  mesh_thumb_r_3_111.userData.sculptComponent = { id: "thumb-r-3" };
  node_thumb_r_3_111.add(mesh_thumb_r_3_111);
  meshes["thumb-r-3"] = mesh_thumb_r_3_111;
  colliders["thumb-r-3"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_thumb_r_3_111);

  const attachment_index_r_1_112 = {"parentSocket": "hand-r-index-r-1", "localStart": [0.02205, -0.04409, 0.0126], "localEnd": [0.025, -0.072, 0.01658], "contactType": "rigid-weld", "baseRadius": 0.00913, "endRadius": 0.00756, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_index_r_1_112 = makeAttachmentEndpoint(attachment_index_r_1_112);
  const node_index_r_1_112 = new THREE.Group();
  node_index_r_1_112.name = "Index R 1__pivot";
  node_index_r_1_112.scale.set(1, 1, 1);
  if (endpoint_index_r_1_112) {
    node_index_r_1_112.position.copy(endpoint_index_r_1_112.start);
    node_index_r_1_112.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_index_r_1_112.position.set(0.02205, -0.04409, 0.0126);
    node_index_r_1_112.rotation.set(0.0, 0.0, 0.0);
  }
  node_index_r_1_112.userData.sculptComponent = { id: "index-r-1" };
  node_index_r_1_112.userData.actionProfile = {};
  (nodes["hand-r"] ?? root).add(node_index_r_1_112);
  nodes["index-r-1"] = node_index_r_1_112;
  const mesh_index_r_1_112Geometry = endpoint_index_r_1_112
    ? new THREE.CylinderGeometry(endpoint_index_r_1_112.endRadius, endpoint_index_r_1_112.baseRadius, endpoint_index_r_1_112.length, 16, 6)
    : buildWatertightCapsule(0.35, 0.7, 8, 16, 1);
  if (!endpoint_index_r_1_112) {
    mesh_index_r_1_112Geometry.scale(0.01827, 0.02835, 0.01827);
  }
  const mesh_index_r_1_112 = new THREE.Mesh(
    mesh_index_r_1_112Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_index_r_1_112.name = "Index R 1";
  if (endpoint_index_r_1_112) {
    mesh_index_r_1_112.position.copy(endpoint_index_r_1_112.midpoint);
    mesh_index_r_1_112.quaternion.copy(endpoint_index_r_1_112.quaternion);
  }
  mesh_index_r_1_112.castShadow = options.castShadow ?? true;
  mesh_index_r_1_112.receiveShadow = options.receiveShadow ?? true;
  mesh_index_r_1_112.userData.sculptComponent = { id: "index-r-1" };
  node_index_r_1_112.add(mesh_index_r_1_112);
  meshes["index-r-1"] = mesh_index_r_1_112;
  colliders["index-r-1"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_index_r_1_112);

  const attachment_index_r_2_113 = {"parentSocket": "index-r-1-index-r-2", "localStart": [0.00295, -0.02791, 0.00398], "localEnd": [0.00516, -0.04874, 0.01086], "contactType": "hinge-joint", "baseRadius": 0.00756, "endRadius": 0.00598, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_index_r_2_113 = makeAttachmentEndpoint(attachment_index_r_2_113);
  const node_index_r_2_113 = new THREE.Group();
  node_index_r_2_113.name = "Index R 2__pivot";
  node_index_r_2_113.scale.set(1, 1, 1);
  if (endpoint_index_r_2_113) {
    node_index_r_2_113.position.copy(endpoint_index_r_2_113.start);
    node_index_r_2_113.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_index_r_2_113.position.set(0.00295, -0.02791, 0.00398);
    node_index_r_2_113.rotation.set(0.0, 0.0, 0.0);
  }
  node_index_r_2_113.userData.sculptComponent = { id: "index-r-2" };
  node_index_r_2_113.userData.actionProfile = {};
  (nodes["index-r-1"] ?? root).add(node_index_r_2_113);
  nodes["index-r-2"] = node_index_r_2_113;
  const mesh_index_r_2_113Geometry = endpoint_index_r_2_113
    ? new THREE.CylinderGeometry(endpoint_index_r_2_113.endRadius, endpoint_index_r_2_113.baseRadius, endpoint_index_r_2_113.length, 16, 6)
    : buildWatertightCapsule(0.35, 0.7, 8, 16, 1);
  if (!endpoint_index_r_2_113) {
    mesh_index_r_2_113Geometry.scale(0.01512, 0.02205, 0.01512);
  }
  const mesh_index_r_2_113 = new THREE.Mesh(
    mesh_index_r_2_113Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_index_r_2_113.name = "Index R 2";
  if (endpoint_index_r_2_113) {
    mesh_index_r_2_113.position.copy(endpoint_index_r_2_113.midpoint);
    mesh_index_r_2_113.quaternion.copy(endpoint_index_r_2_113.quaternion);
  }
  mesh_index_r_2_113.castShadow = options.castShadow ?? true;
  mesh_index_r_2_113.receiveShadow = options.receiveShadow ?? true;
  mesh_index_r_2_113.userData.sculptComponent = { id: "index-r-2" };
  node_index_r_2_113.add(mesh_index_r_2_113);
  meshes["index-r-2"] = mesh_index_r_2_113;
  colliders["index-r-2"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_index_r_2_113);

  const attachment_index_r_3_114 = {"parentSocket": "index-r-2-index-r-3", "localStart": [0.0022, -0.02083, 0.00687], "localEnd": [0.00396, -0.03739, 0.01581], "contactType": "hinge-joint", "baseRadius": 0.00598, "endRadius": 0.00441, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_index_r_3_114 = makeAttachmentEndpoint(attachment_index_r_3_114);
  const node_index_r_3_114 = new THREE.Group();
  node_index_r_3_114.name = "Index R 3__pivot";
  node_index_r_3_114.scale.set(1, 1, 1);
  if (endpoint_index_r_3_114) {
    node_index_r_3_114.position.copy(endpoint_index_r_3_114.start);
    node_index_r_3_114.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_index_r_3_114.position.set(0.0022, -0.02083, 0.00687);
    node_index_r_3_114.rotation.set(0.0, 0.0, 0.0);
  }
  node_index_r_3_114.userData.sculptComponent = { id: "index-r-3" };
  node_index_r_3_114.userData.actionProfile = {};
  (nodes["index-r-2"] ?? root).add(node_index_r_3_114);
  nodes["index-r-3"] = node_index_r_3_114;
  const mesh_index_r_3_114Geometry = endpoint_index_r_3_114
    ? new THREE.CylinderGeometry(endpoint_index_r_3_114.endRadius, endpoint_index_r_3_114.baseRadius, endpoint_index_r_3_114.length, 16, 6)
    : buildWatertightCapsule(0.35, 0.7, 8, 16, 1);
  if (!endpoint_index_r_3_114) {
    mesh_index_r_3_114Geometry.scale(0.01197, 0.0189, 0.01197);
  }
  const mesh_index_r_3_114 = new THREE.Mesh(
    mesh_index_r_3_114Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_index_r_3_114.name = "Index R 3";
  if (endpoint_index_r_3_114) {
    mesh_index_r_3_114.position.copy(endpoint_index_r_3_114.midpoint);
    mesh_index_r_3_114.quaternion.copy(endpoint_index_r_3_114.quaternion);
  }
  mesh_index_r_3_114.castShadow = options.castShadow ?? true;
  mesh_index_r_3_114.receiveShadow = options.receiveShadow ?? true;
  mesh_index_r_3_114.userData.sculptComponent = { id: "index-r-3" };
  node_index_r_3_114.add(mesh_index_r_3_114);
  meshes["index-r-3"] = mesh_index_r_3_114;
  colliders["index-r-3"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_index_r_3_114);

  const attachment_middle_r_1_115 = {"parentSocket": "hand-r-middle-r-1", "localStart": [0.00315, -0.04409, 0.0126], "localEnd": [0.00315, -0.07528, 0.01698], "contactType": "rigid-weld", "baseRadius": 0.00913, "endRadius": 0.00756, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_middle_r_1_115 = makeAttachmentEndpoint(attachment_middle_r_1_115);
  const node_middle_r_1_115 = new THREE.Group();
  node_middle_r_1_115.name = "Middle R 1__pivot";
  node_middle_r_1_115.scale.set(1, 1, 1);
  if (endpoint_middle_r_1_115) {
    node_middle_r_1_115.position.copy(endpoint_middle_r_1_115.start);
    node_middle_r_1_115.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_middle_r_1_115.position.set(0.00315, -0.04409, 0.0126);
    node_middle_r_1_115.rotation.set(0.0, 0.0, 0.0);
  }
  node_middle_r_1_115.userData.sculptComponent = { id: "middle-r-1" };
  node_middle_r_1_115.userData.actionProfile = {};
  (nodes["hand-r"] ?? root).add(node_middle_r_1_115);
  nodes["middle-r-1"] = node_middle_r_1_115;
  const mesh_middle_r_1_115Geometry = endpoint_middle_r_1_115
    ? new THREE.CylinderGeometry(endpoint_middle_r_1_115.endRadius, endpoint_middle_r_1_115.baseRadius, endpoint_middle_r_1_115.length, 16, 6)
    : buildWatertightCapsule(0.35, 0.7, 8, 16, 1);
  if (!endpoint_middle_r_1_115) {
    mesh_middle_r_1_115Geometry.scale(0.01827, 0.0315, 0.01827);
  }
  const mesh_middle_r_1_115 = new THREE.Mesh(
    mesh_middle_r_1_115Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_middle_r_1_115.name = "Middle R 1";
  if (endpoint_middle_r_1_115) {
    mesh_middle_r_1_115.position.copy(endpoint_middle_r_1_115.midpoint);
    mesh_middle_r_1_115.quaternion.copy(endpoint_middle_r_1_115.quaternion);
  }
  mesh_middle_r_1_115.castShadow = options.castShadow ?? true;
  mesh_middle_r_1_115.receiveShadow = options.receiveShadow ?? true;
  mesh_middle_r_1_115.userData.sculptComponent = { id: "middle-r-1" };
  node_middle_r_1_115.add(mesh_middle_r_1_115);
  meshes["middle-r-1"] = mesh_middle_r_1_115;
  colliders["middle-r-1"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_middle_r_1_115);

  const attachment_middle_r_2_116 = {"parentSocket": "middle-r-1-middle-r-2", "localStart": [0.0, -0.03119, 0.00438], "localEnd": [0.0, -0.05515, 0.01217], "contactType": "hinge-joint", "baseRadius": 0.00756, "endRadius": 0.00598, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_middle_r_2_116 = makeAttachmentEndpoint(attachment_middle_r_2_116);
  const node_middle_r_2_116 = new THREE.Group();
  node_middle_r_2_116.name = "Middle R 2__pivot";
  node_middle_r_2_116.scale.set(1, 1, 1);
  if (endpoint_middle_r_2_116) {
    node_middle_r_2_116.position.copy(endpoint_middle_r_2_116.start);
    node_middle_r_2_116.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_middle_r_2_116.position.set(0.0, -0.03119, 0.00438);
    node_middle_r_2_116.rotation.set(0.0, 0.0, 0.0);
  }
  node_middle_r_2_116.userData.sculptComponent = { id: "middle-r-2" };
  node_middle_r_2_116.userData.actionProfile = {};
  (nodes["middle-r-1"] ?? root).add(node_middle_r_2_116);
  nodes["middle-r-2"] = node_middle_r_2_116;
  const mesh_middle_r_2_116Geometry = endpoint_middle_r_2_116
    ? new THREE.CylinderGeometry(endpoint_middle_r_2_116.endRadius, endpoint_middle_r_2_116.baseRadius, endpoint_middle_r_2_116.length, 16, 6)
    : buildWatertightCapsule(0.35, 0.7, 8, 16, 1);
  if (!endpoint_middle_r_2_116) {
    mesh_middle_r_2_116Geometry.scale(0.01512, 0.0252, 0.01512);
  }
  const mesh_middle_r_2_116 = new THREE.Mesh(
    mesh_middle_r_2_116Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_middle_r_2_116.name = "Middle R 2";
  if (endpoint_middle_r_2_116) {
    mesh_middle_r_2_116.position.copy(endpoint_middle_r_2_116.midpoint);
    mesh_middle_r_2_116.quaternion.copy(endpoint_middle_r_2_116.quaternion);
  }
  mesh_middle_r_2_116.castShadow = options.castShadow ?? true;
  mesh_middle_r_2_116.receiveShadow = options.receiveShadow ?? true;
  mesh_middle_r_2_116.userData.sculptComponent = { id: "middle-r-2" };
  node_middle_r_2_116.add(mesh_middle_r_2_116);
  meshes["middle-r-2"] = mesh_middle_r_2_116;
  colliders["middle-r-2"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_middle_r_2_116);

  const attachment_middle_r_3_117 = {"parentSocket": "middle-r-2-middle-r-3", "localStart": [0.0, -0.02396, 0.00779], "localEnd": [0.0, -0.04065, 0.01666], "contactType": "hinge-joint", "baseRadius": 0.00598, "endRadius": 0.00441, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_middle_r_3_117 = makeAttachmentEndpoint(attachment_middle_r_3_117);
  const node_middle_r_3_117 = new THREE.Group();
  node_middle_r_3_117.name = "Middle R 3__pivot";
  node_middle_r_3_117.scale.set(1, 1, 1);
  if (endpoint_middle_r_3_117) {
    node_middle_r_3_117.position.copy(endpoint_middle_r_3_117.start);
    node_middle_r_3_117.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_middle_r_3_117.position.set(0.0, -0.02396, 0.00779);
    node_middle_r_3_117.rotation.set(0.0, 0.0, 0.0);
  }
  node_middle_r_3_117.userData.sculptComponent = { id: "middle-r-3" };
  node_middle_r_3_117.userData.actionProfile = {};
  (nodes["middle-r-2"] ?? root).add(node_middle_r_3_117);
  nodes["middle-r-3"] = node_middle_r_3_117;
  const mesh_middle_r_3_117Geometry = endpoint_middle_r_3_117
    ? new THREE.CylinderGeometry(endpoint_middle_r_3_117.endRadius, endpoint_middle_r_3_117.baseRadius, endpoint_middle_r_3_117.length, 16, 6)
    : buildWatertightCapsule(0.35, 0.7, 8, 16, 1);
  if (!endpoint_middle_r_3_117) {
    mesh_middle_r_3_117Geometry.scale(0.01197, 0.0189, 0.01197);
  }
  const mesh_middle_r_3_117 = new THREE.Mesh(
    mesh_middle_r_3_117Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_middle_r_3_117.name = "Middle R 3";
  if (endpoint_middle_r_3_117) {
    mesh_middle_r_3_117.position.copy(endpoint_middle_r_3_117.midpoint);
    mesh_middle_r_3_117.quaternion.copy(endpoint_middle_r_3_117.quaternion);
  }
  mesh_middle_r_3_117.castShadow = options.castShadow ?? true;
  mesh_middle_r_3_117.receiveShadow = options.receiveShadow ?? true;
  mesh_middle_r_3_117.userData.sculptComponent = { id: "middle-r-3" };
  node_middle_r_3_117.add(mesh_middle_r_3_117);
  meshes["middle-r-3"] = mesh_middle_r_3_117;
  colliders["middle-r-3"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_middle_r_3_117);

  const attachment_ring_r_1_118 = {"parentSocket": "hand-r-ring-r-1", "localStart": [-0.01575, -0.04409, 0.0126], "localEnd": [-0.01811, -0.07206, 0.01657], "contactType": "rigid-weld", "baseRadius": 0.00913, "endRadius": 0.00756, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_ring_r_1_118 = makeAttachmentEndpoint(attachment_ring_r_1_118);
  const node_ring_r_1_118 = new THREE.Group();
  node_ring_r_1_118.name = "Ring R 1__pivot";
  node_ring_r_1_118.scale.set(1, 1, 1);
  if (endpoint_ring_r_1_118) {
    node_ring_r_1_118.position.copy(endpoint_ring_r_1_118.start);
    node_ring_r_1_118.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_ring_r_1_118.position.set(-0.01575, -0.04409, 0.0126);
    node_ring_r_1_118.rotation.set(0.0, 0.0, 0.0);
  }
  node_ring_r_1_118.userData.sculptComponent = { id: "ring-r-1" };
  node_ring_r_1_118.userData.actionProfile = {};
  (nodes["hand-r"] ?? root).add(node_ring_r_1_118);
  nodes["ring-r-1"] = node_ring_r_1_118;
  const mesh_ring_r_1_118Geometry = endpoint_ring_r_1_118
    ? new THREE.CylinderGeometry(endpoint_ring_r_1_118.endRadius, endpoint_ring_r_1_118.baseRadius, endpoint_ring_r_1_118.length, 16, 6)
    : buildWatertightCapsule(0.35, 0.7, 8, 16, 1);
  if (!endpoint_ring_r_1_118) {
    mesh_ring_r_1_118Geometry.scale(0.01827, 0.02835, 0.01827);
  }
  const mesh_ring_r_1_118 = new THREE.Mesh(
    mesh_ring_r_1_118Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ring_r_1_118.name = "Ring R 1";
  if (endpoint_ring_r_1_118) {
    mesh_ring_r_1_118.position.copy(endpoint_ring_r_1_118.midpoint);
    mesh_ring_r_1_118.quaternion.copy(endpoint_ring_r_1_118.quaternion);
  }
  mesh_ring_r_1_118.castShadow = options.castShadow ?? true;
  mesh_ring_r_1_118.receiveShadow = options.receiveShadow ?? true;
  mesh_ring_r_1_118.userData.sculptComponent = { id: "ring-r-1" };
  node_ring_r_1_118.add(mesh_ring_r_1_118);
  meshes["ring-r-1"] = mesh_ring_r_1_118;
  colliders["ring-r-1"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_ring_r_1_118);

  const attachment_ring_r_2_119 = {"parentSocket": "ring-r-1-ring-r-2", "localStart": [-0.00236, -0.02797, 0.00397], "localEnd": [-0.00412, -0.04885, 0.01082], "contactType": "hinge-joint", "baseRadius": 0.00756, "endRadius": 0.00598, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_ring_r_2_119 = makeAttachmentEndpoint(attachment_ring_r_2_119);
  const node_ring_r_2_119 = new THREE.Group();
  node_ring_r_2_119.name = "Ring R 2__pivot";
  node_ring_r_2_119.scale.set(1, 1, 1);
  if (endpoint_ring_r_2_119) {
    node_ring_r_2_119.position.copy(endpoint_ring_r_2_119.start);
    node_ring_r_2_119.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_ring_r_2_119.position.set(-0.00236, -0.02797, 0.00397);
    node_ring_r_2_119.rotation.set(0.0, 0.0, 0.0);
  }
  node_ring_r_2_119.userData.sculptComponent = { id: "ring-r-2" };
  node_ring_r_2_119.userData.actionProfile = {};
  (nodes["ring-r-1"] ?? root).add(node_ring_r_2_119);
  nodes["ring-r-2"] = node_ring_r_2_119;
  const mesh_ring_r_2_119Geometry = endpoint_ring_r_2_119
    ? new THREE.CylinderGeometry(endpoint_ring_r_2_119.endRadius, endpoint_ring_r_2_119.baseRadius, endpoint_ring_r_2_119.length, 16, 6)
    : buildWatertightCapsule(0.35, 0.7, 8, 16, 1);
  if (!endpoint_ring_r_2_119) {
    mesh_ring_r_2_119Geometry.scale(0.01512, 0.02205, 0.01512);
  }
  const mesh_ring_r_2_119 = new THREE.Mesh(
    mesh_ring_r_2_119Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ring_r_2_119.name = "Ring R 2";
  if (endpoint_ring_r_2_119) {
    mesh_ring_r_2_119.position.copy(endpoint_ring_r_2_119.midpoint);
    mesh_ring_r_2_119.quaternion.copy(endpoint_ring_r_2_119.quaternion);
  }
  mesh_ring_r_2_119.castShadow = options.castShadow ?? true;
  mesh_ring_r_2_119.receiveShadow = options.receiveShadow ?? true;
  mesh_ring_r_2_119.userData.sculptComponent = { id: "ring-r-2" };
  node_ring_r_2_119.add(mesh_ring_r_2_119);
  meshes["ring-r-2"] = mesh_ring_r_2_119;
  colliders["ring-r-2"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_ring_r_2_119);

  const attachment_ring_r_3_120 = {"parentSocket": "ring-r-2-ring-r-3", "localStart": [-0.00176, -0.02088, 0.00685], "localEnd": [-0.00316, -0.03749, 0.01577], "contactType": "hinge-joint", "baseRadius": 0.00598, "endRadius": 0.00441, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_ring_r_3_120 = makeAttachmentEndpoint(attachment_ring_r_3_120);
  const node_ring_r_3_120 = new THREE.Group();
  node_ring_r_3_120.name = "Ring R 3__pivot";
  node_ring_r_3_120.scale.set(1, 1, 1);
  if (endpoint_ring_r_3_120) {
    node_ring_r_3_120.position.copy(endpoint_ring_r_3_120.start);
    node_ring_r_3_120.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_ring_r_3_120.position.set(-0.00176, -0.02088, 0.00685);
    node_ring_r_3_120.rotation.set(0.0, 0.0, 0.0);
  }
  node_ring_r_3_120.userData.sculptComponent = { id: "ring-r-3" };
  node_ring_r_3_120.userData.actionProfile = {};
  (nodes["ring-r-2"] ?? root).add(node_ring_r_3_120);
  nodes["ring-r-3"] = node_ring_r_3_120;
  const mesh_ring_r_3_120Geometry = endpoint_ring_r_3_120
    ? new THREE.CylinderGeometry(endpoint_ring_r_3_120.endRadius, endpoint_ring_r_3_120.baseRadius, endpoint_ring_r_3_120.length, 16, 6)
    : buildWatertightCapsule(0.35, 0.7, 8, 16, 1);
  if (!endpoint_ring_r_3_120) {
    mesh_ring_r_3_120Geometry.scale(0.01197, 0.0189, 0.01197);
  }
  const mesh_ring_r_3_120 = new THREE.Mesh(
    mesh_ring_r_3_120Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ring_r_3_120.name = "Ring R 3";
  if (endpoint_ring_r_3_120) {
    mesh_ring_r_3_120.position.copy(endpoint_ring_r_3_120.midpoint);
    mesh_ring_r_3_120.quaternion.copy(endpoint_ring_r_3_120.quaternion);
  }
  mesh_ring_r_3_120.castShadow = options.castShadow ?? true;
  mesh_ring_r_3_120.receiveShadow = options.receiveShadow ?? true;
  mesh_ring_r_3_120.userData.sculptComponent = { id: "ring-r-3" };
  node_ring_r_3_120.add(mesh_ring_r_3_120);
  meshes["ring-r-3"] = mesh_ring_r_3_120;
  colliders["ring-r-3"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_ring_r_3_120);

  const attachment_little_r_1_121 = {"parentSocket": "hand-r-little-r-1", "localStart": [-0.0315, -0.04409, 0.00945], "localEnd": [-0.0352, -0.0656, 0.01259], "contactType": "rigid-weld", "baseRadius": 0.00913, "endRadius": 0.00756, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_little_r_1_121 = makeAttachmentEndpoint(attachment_little_r_1_121);
  const node_little_r_1_121 = new THREE.Group();
  node_little_r_1_121.name = "Little R 1__pivot";
  node_little_r_1_121.scale.set(1, 1, 1);
  if (endpoint_little_r_1_121) {
    node_little_r_1_121.position.copy(endpoint_little_r_1_121.start);
    node_little_r_1_121.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_little_r_1_121.position.set(-0.0315, -0.04409, 0.00945);
    node_little_r_1_121.rotation.set(0.0, 0.0, 0.0);
  }
  node_little_r_1_121.userData.sculptComponent = { id: "little-r-1" };
  node_little_r_1_121.userData.actionProfile = {};
  (nodes["hand-r"] ?? root).add(node_little_r_1_121);
  nodes["little-r-1"] = node_little_r_1_121;
  const mesh_little_r_1_121Geometry = endpoint_little_r_1_121
    ? new THREE.CylinderGeometry(endpoint_little_r_1_121.endRadius, endpoint_little_r_1_121.baseRadius, endpoint_little_r_1_121.length, 16, 6)
    : buildWatertightCapsule(0.35, 0.7, 8, 16, 1);
  if (!endpoint_little_r_1_121) {
    mesh_little_r_1_121Geometry.scale(0.01827, 0.02205, 0.01827);
  }
  const mesh_little_r_1_121 = new THREE.Mesh(
    mesh_little_r_1_121Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_little_r_1_121.name = "Little R 1";
  if (endpoint_little_r_1_121) {
    mesh_little_r_1_121.position.copy(endpoint_little_r_1_121.midpoint);
    mesh_little_r_1_121.quaternion.copy(endpoint_little_r_1_121.quaternion);
  }
  mesh_little_r_1_121.castShadow = options.castShadow ?? true;
  mesh_little_r_1_121.receiveShadow = options.receiveShadow ?? true;
  mesh_little_r_1_121.userData.sculptComponent = { id: "little-r-1" };
  node_little_r_1_121.add(mesh_little_r_1_121);
  meshes["little-r-1"] = mesh_little_r_1_121;
  colliders["little-r-1"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_little_r_1_121);

  const attachment_little_r_2_122 = {"parentSocket": "little-r-1-little-r-2", "localStart": [-0.0037, -0.02151, 0.00314], "localEnd": [-0.00623, -0.03623, 0.00812], "contactType": "hinge-joint", "baseRadius": 0.00756, "endRadius": 0.00598, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_little_r_2_122 = makeAttachmentEndpoint(attachment_little_r_2_122);
  const node_little_r_2_122 = new THREE.Group();
  node_little_r_2_122.name = "Little R 2__pivot";
  node_little_r_2_122.scale.set(1, 1, 1);
  if (endpoint_little_r_2_122) {
    node_little_r_2_122.position.copy(endpoint_little_r_2_122.start);
    node_little_r_2_122.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_little_r_2_122.position.set(-0.0037, -0.02151, 0.00314);
    node_little_r_2_122.rotation.set(0.0, 0.0, 0.0);
  }
  node_little_r_2_122.userData.sculptComponent = { id: "little-r-2" };
  node_little_r_2_122.userData.actionProfile = {};
  (nodes["little-r-1"] ?? root).add(node_little_r_2_122);
  nodes["little-r-2"] = node_little_r_2_122;
  const mesh_little_r_2_122Geometry = endpoint_little_r_2_122
    ? new THREE.CylinderGeometry(endpoint_little_r_2_122.endRadius, endpoint_little_r_2_122.baseRadius, endpoint_little_r_2_122.length, 16, 6)
    : buildWatertightCapsule(0.35, 0.7, 8, 16, 1);
  if (!endpoint_little_r_2_122) {
    mesh_little_r_2_122Geometry.scale(0.01512, 0.01575, 0.01512);
  }
  const mesh_little_r_2_122 = new THREE.Mesh(
    mesh_little_r_2_122Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_little_r_2_122.name = "Little R 2";
  if (endpoint_little_r_2_122) {
    mesh_little_r_2_122.position.copy(endpoint_little_r_2_122.midpoint);
    mesh_little_r_2_122.quaternion.copy(endpoint_little_r_2_122.quaternion);
  }
  mesh_little_r_2_122.castShadow = options.castShadow ?? true;
  mesh_little_r_2_122.receiveShadow = options.receiveShadow ?? true;
  mesh_little_r_2_122.userData.sculptComponent = { id: "little-r-2" };
  node_little_r_2_122.add(mesh_little_r_2_122);
  meshes["little-r-2"] = mesh_little_r_2_122;
  colliders["little-r-2"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_little_r_2_122);

  const attachment_little_r_3_123 = {"parentSocket": "little-r-2-little-r-3", "localStart": [-0.00253, -0.01472, 0.00498], "localEnd": [-0.00488, -0.02835, 0.01251], "contactType": "hinge-joint", "baseRadius": 0.00598, "endRadius": 0.00441, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_little_r_3_123 = makeAttachmentEndpoint(attachment_little_r_3_123);
  const node_little_r_3_123 = new THREE.Group();
  node_little_r_3_123.name = "Little R 3__pivot";
  node_little_r_3_123.scale.set(1, 1, 1);
  if (endpoint_little_r_3_123) {
    node_little_r_3_123.position.copy(endpoint_little_r_3_123.start);
    node_little_r_3_123.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_little_r_3_123.position.set(-0.00253, -0.01472, 0.00498);
    node_little_r_3_123.rotation.set(0.0, 0.0, 0.0);
  }
  node_little_r_3_123.userData.sculptComponent = { id: "little-r-3" };
  node_little_r_3_123.userData.actionProfile = {};
  (nodes["little-r-2"] ?? root).add(node_little_r_3_123);
  nodes["little-r-3"] = node_little_r_3_123;
  const mesh_little_r_3_123Geometry = endpoint_little_r_3_123
    ? new THREE.CylinderGeometry(endpoint_little_r_3_123.endRadius, endpoint_little_r_3_123.baseRadius, endpoint_little_r_3_123.length, 16, 6)
    : buildWatertightCapsule(0.35, 0.7, 8, 16, 1);
  if (!endpoint_little_r_3_123) {
    mesh_little_r_3_123Geometry.scale(0.01197, 0.01575, 0.01197);
  }
  const mesh_little_r_3_123 = new THREE.Mesh(
    mesh_little_r_3_123Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_little_r_3_123.name = "Little R 3";
  if (endpoint_little_r_3_123) {
    mesh_little_r_3_123.position.copy(endpoint_little_r_3_123.midpoint);
    mesh_little_r_3_123.quaternion.copy(endpoint_little_r_3_123.quaternion);
  }
  mesh_little_r_3_123.castShadow = options.castShadow ?? true;
  mesh_little_r_3_123.receiveShadow = options.receiveShadow ?? true;
  mesh_little_r_3_123.userData.sculptComponent = { id: "little-r-3" };
  node_little_r_3_123.add(mesh_little_r_3_123);
  meshes["little-r-3"] = mesh_little_r_3_123;
  colliders["little-r-3"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_little_r_3_123);

  const endpoint_seam_chest_l_124 = makeAttachmentEndpoint(null);
  const node_seam_chest_l_124 = new THREE.Group();
  node_seam_chest_l_124.name = "Gold seam seam-chest-l__pivot";
  node_seam_chest_l_124.scale.set(1, 1, 1);
  if (endpoint_seam_chest_l_124) {
    node_seam_chest_l_124.position.copy(endpoint_seam_chest_l_124.start);
    node_seam_chest_l_124.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seam_chest_l_124.position.set(0.0, 0.0, 0.0);
    node_seam_chest_l_124.rotation.set(0.0, 0.0, 0.0);
  }
  node_seam_chest_l_124.userData.sculptComponent = { id: "seam-chest-l" };
  node_seam_chest_l_124.userData.actionProfile = {};
  (nodes["chest-shell-l"] ?? root).add(node_seam_chest_l_124);
  nodes["seam-chest-l"] = node_seam_chest_l_124;
  const mesh_seam_chest_l_124Geometry = endpoint_seam_chest_l_124
    ? new THREE.CylinderGeometry(endpoint_seam_chest_l_124.endRadius, endpoint_seam_chest_l_124.baseRadius, endpoint_seam_chest_l_124.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.06721, 0.0, 0.04057], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [-0.09833, -0.06929, 0.08945], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [-0.11761, -0.17008, 0.10205], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [-0.11225, -0.26457, 0.07257], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_seam_chest_l_124) {
    mesh_seam_chest_l_124Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seam_chest_l_124 = new THREE.Mesh(
    mesh_seam_chest_l_124Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seam_chest_l_124.name = "Gold seam seam-chest-l";
  if (endpoint_seam_chest_l_124) {
    mesh_seam_chest_l_124.position.copy(endpoint_seam_chest_l_124.midpoint);
    mesh_seam_chest_l_124.quaternion.copy(endpoint_seam_chest_l_124.quaternion);
  }
  mesh_seam_chest_l_124.castShadow = options.castShadow ?? true;
  mesh_seam_chest_l_124.receiveShadow = options.receiveShadow ?? true;
  mesh_seam_chest_l_124.userData.sculptComponent = { id: "seam-chest-l" };
  node_seam_chest_l_124.add(mesh_seam_chest_l_124);
  meshes["seam-chest-l"] = mesh_seam_chest_l_124;
  colliders["seam-chest-l"] = {};
  destructionGroups["chest-shell-l"] ??= [];
  destructionGroups["chest-shell-l"].push(node_seam_chest_l_124);

  const endpoint_seam_pauldron_l_125 = makeAttachmentEndpoint(null);
  const node_seam_pauldron_l_125 = new THREE.Group();
  node_seam_pauldron_l_125.name = "Gold seam seam-pauldron-l__pivot";
  node_seam_pauldron_l_125.scale.set(1, 1, 1);
  if (endpoint_seam_pauldron_l_125) {
    node_seam_pauldron_l_125.position.copy(endpoint_seam_pauldron_l_125.start);
    node_seam_pauldron_l_125.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seam_pauldron_l_125.position.set(0.0, 0.0, 0.0);
    node_seam_pauldron_l_125.rotation.set(0.0, 0.0, 0.0);
  }
  node_seam_pauldron_l_125.userData.sculptComponent = { id: "seam-pauldron-l" };
  node_seam_pauldron_l_125.userData.actionProfile = {};
  (nodes["pauldron-l"] ?? root).add(node_seam_pauldron_l_125);
  nodes["seam-pauldron-l"] = node_seam_pauldron_l_125;
  const mesh_seam_pauldron_l_125Geometry = endpoint_seam_pauldron_l_125
    ? new THREE.CylinderGeometry(endpoint_seam_pauldron_l_125.endRadius, endpoint_seam_pauldron_l_125.baseRadius, endpoint_seam_pauldron_l_125.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0275, 0.0, 0.01039], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [0.09298, -0.07559, 0.02425], "rx": 0.0063, "rz": 0.0063, "twist": 0.0}, {"position": [0.13039, -0.15748, 0.02803], "rx": 0.0063, "rz": 0.0063, "twist": 0.0}, {"position": [0.10557, -0.23307, 0.01795], "rx": 0.0063, "rz": 0.0063, "twist": 0.0}, {"position": [0.05613, -0.28346, 0.00126], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_seam_pauldron_l_125) {
    mesh_seam_pauldron_l_125Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seam_pauldron_l_125 = new THREE.Mesh(
    mesh_seam_pauldron_l_125Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seam_pauldron_l_125.name = "Gold seam seam-pauldron-l";
  if (endpoint_seam_pauldron_l_125) {
    mesh_seam_pauldron_l_125.position.copy(endpoint_seam_pauldron_l_125.midpoint);
    mesh_seam_pauldron_l_125.quaternion.copy(endpoint_seam_pauldron_l_125.quaternion);
  }
  mesh_seam_pauldron_l_125.castShadow = options.castShadow ?? true;
  mesh_seam_pauldron_l_125.receiveShadow = options.receiveShadow ?? true;
  mesh_seam_pauldron_l_125.userData.sculptComponent = { id: "seam-pauldron-l" };
  node_seam_pauldron_l_125.add(mesh_seam_pauldron_l_125);
  meshes["seam-pauldron-l"] = mesh_seam_pauldron_l_125;
  colliders["seam-pauldron-l"] = {};
  destructionGroups["pauldron-l"] ??= [];
  destructionGroups["pauldron-l"].push(node_seam_pauldron_l_125);

  const endpoint_seam_thigh_l_126 = makeAttachmentEndpoint(null);
  const node_seam_thigh_l_126 = new THREE.Group();
  node_seam_thigh_l_126.name = "Gold seam seam-thigh-l__pivot";
  node_seam_thigh_l_126.scale.set(1, 1, 1);
  if (endpoint_seam_thigh_l_126) {
    node_seam_thigh_l_126.position.copy(endpoint_seam_thigh_l_126.start);
    node_seam_thigh_l_126.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seam_thigh_l_126.position.set(0.0, 0.0, 0.0);
    node_seam_thigh_l_126.rotation.set(0.0, 0.0, 0.0);
  }
  node_seam_thigh_l_126.userData.sculptComponent = { id: "seam-thigh-l" };
  node_seam_thigh_l_126.userData.actionProfile = {};
  (nodes["thigh-plate-front-l"] ?? root).add(node_seam_thigh_l_126);
  nodes["seam-thigh-l"] = node_seam_thigh_l_126;
  const mesh_seam_thigh_l_126Geometry = endpoint_seam_thigh_l_126
    ? new THREE.CylinderGeometry(endpoint_seam_thigh_l_126.endRadius, endpoint_seam_thigh_l_126.baseRadius, endpoint_seam_thigh_l_126.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.01466, -0.0, 0.01669], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [-0.04576, -0.09827, 0.02256], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [-0.05803, -0.27024, 0.02608], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [-0.03135, -0.41764, 0.02314], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [0.01315, -0.49134, 0.01669], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_seam_thigh_l_126) {
    mesh_seam_thigh_l_126Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seam_thigh_l_126 = new THREE.Mesh(
    mesh_seam_thigh_l_126Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seam_thigh_l_126.name = "Gold seam seam-thigh-l";
  if (endpoint_seam_thigh_l_126) {
    mesh_seam_thigh_l_126.position.copy(endpoint_seam_thigh_l_126.midpoint);
    mesh_seam_thigh_l_126.quaternion.copy(endpoint_seam_thigh_l_126.quaternion);
  }
  mesh_seam_thigh_l_126.castShadow = options.castShadow ?? true;
  mesh_seam_thigh_l_126.receiveShadow = options.receiveShadow ?? true;
  mesh_seam_thigh_l_126.userData.sculptComponent = { id: "seam-thigh-l" };
  node_seam_thigh_l_126.add(mesh_seam_thigh_l_126);
  meshes["seam-thigh-l"] = mesh_seam_thigh_l_126;
  colliders["seam-thigh-l"] = {};
  destructionGroups["thigh-plate-front-l"] ??= [];
  destructionGroups["thigh-plate-front-l"].push(node_seam_thigh_l_126);

  const endpoint_seam_shin_l_127 = makeAttachmentEndpoint(null);
  const node_seam_shin_l_127 = new THREE.Group();
  node_seam_shin_l_127.name = "Gold seam seam-shin-l__pivot";
  node_seam_shin_l_127.scale.set(1, 1, 1);
  if (endpoint_seam_shin_l_127) {
    node_seam_shin_l_127.position.copy(endpoint_seam_shin_l_127.start);
    node_seam_shin_l_127.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seam_shin_l_127.position.set(0.0, 0.0, 0.0);
    node_seam_shin_l_127.rotation.set(0.0, 0.0, 0.0);
  }
  node_seam_shin_l_127.userData.sculptComponent = { id: "seam-shin-l" };
  node_seam_shin_l_127.userData.actionProfile = {};
  (nodes["shin-plate-front-l"] ?? root).add(node_seam_shin_l_127);
  nodes["seam-shin-l"] = node_seam_shin_l_127;
  const mesh_seam_shin_l_127Geometry = endpoint_seam_shin_l_127
    ? new THREE.CylinderGeometry(endpoint_seam_shin_l_127.endRadius, endpoint_seam_shin_l_127.baseRadius, endpoint_seam_shin_l_127.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.01466, -0.0, 0.01669], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [0.069, -0.09575, 0.02256], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [0.12193, -0.26331, 0.02608], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [0.13012, -0.40693, 0.02314], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [0.10305, -0.47874, 0.01669], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_seam_shin_l_127) {
    mesh_seam_shin_l_127Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seam_shin_l_127 = new THREE.Mesh(
    mesh_seam_shin_l_127Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seam_shin_l_127.name = "Gold seam seam-shin-l";
  if (endpoint_seam_shin_l_127) {
    mesh_seam_shin_l_127.position.copy(endpoint_seam_shin_l_127.midpoint);
    mesh_seam_shin_l_127.quaternion.copy(endpoint_seam_shin_l_127.quaternion);
  }
  mesh_seam_shin_l_127.castShadow = options.castShadow ?? true;
  mesh_seam_shin_l_127.receiveShadow = options.receiveShadow ?? true;
  mesh_seam_shin_l_127.userData.sculptComponent = { id: "seam-shin-l" };
  node_seam_shin_l_127.add(mesh_seam_shin_l_127);
  meshes["seam-shin-l"] = mesh_seam_shin_l_127;
  colliders["seam-shin-l"] = {};
  destructionGroups["shin-plate-front-l"] ??= [];
  destructionGroups["shin-plate-front-l"].push(node_seam_shin_l_127);

  const endpoint_seam_boot_l_128 = makeAttachmentEndpoint(null);
  const node_seam_boot_l_128 = new THREE.Group();
  node_seam_boot_l_128.name = "Gold seam seam-boot-l__pivot";
  node_seam_boot_l_128.scale.set(1, 1, 1);
  if (endpoint_seam_boot_l_128) {
    node_seam_boot_l_128.position.copy(endpoint_seam_boot_l_128.start);
    node_seam_boot_l_128.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seam_boot_l_128.position.set(0.0, 0.0, 0.0);
    node_seam_boot_l_128.rotation.set(0.0, 0.0, 0.0);
  }
  node_seam_boot_l_128.userData.sculptComponent = { id: "seam-boot-l" };
  node_seam_boot_l_128.userData.actionProfile = {};
  (nodes["boot-l"] ?? root).add(node_seam_boot_l_128);
  nodes["seam-boot-l"] = node_seam_boot_l_128;
  const mesh_seam_boot_l_128Geometry = endpoint_seam_boot_l_128
    ? new THREE.CylinderGeometry(endpoint_seam_boot_l_128.endRadius, endpoint_seam_boot_l_128.baseRadius, endpoint_seam_boot_l_128.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0611, 0.01654, 0.0], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [0.08554, 0.01354, 0.07874], "rx": 0.00567, "rz": 0.00567, "twist": 0.0}, {"position": [0.08554, 0.00173, 0.17323], "rx": 0.00567, "rz": 0.00567, "twist": 0.0}, {"position": [0.0611, -0.02268, 0.25827], "rx": 0.00567, "rz": 0.00567, "twist": 0.0}, {"position": [0.03055, -0.03339, 0.30236], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_seam_boot_l_128) {
    mesh_seam_boot_l_128Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seam_boot_l_128 = new THREE.Mesh(
    mesh_seam_boot_l_128Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seam_boot_l_128.name = "Gold seam seam-boot-l";
  if (endpoint_seam_boot_l_128) {
    mesh_seam_boot_l_128.position.copy(endpoint_seam_boot_l_128.midpoint);
    mesh_seam_boot_l_128.quaternion.copy(endpoint_seam_boot_l_128.quaternion);
  }
  mesh_seam_boot_l_128.castShadow = options.castShadow ?? true;
  mesh_seam_boot_l_128.receiveShadow = options.receiveShadow ?? true;
  mesh_seam_boot_l_128.userData.sculptComponent = { id: "seam-boot-l" };
  node_seam_boot_l_128.add(mesh_seam_boot_l_128);
  meshes["seam-boot-l"] = mesh_seam_boot_l_128;
  colliders["seam-boot-l"] = {};
  destructionGroups["boot-l"] ??= [];
  destructionGroups["boot-l"].push(node_seam_boot_l_128);

  const endpoint_seam_chest_out_l_129 = makeAttachmentEndpoint(null);
  const node_seam_chest_out_l_129 = new THREE.Group();
  node_seam_chest_out_l_129.name = "Gold seam seam-chest-out-l__pivot";
  node_seam_chest_out_l_129.scale.set(1, 1, 1);
  if (endpoint_seam_chest_out_l_129) {
    node_seam_chest_out_l_129.position.copy(endpoint_seam_chest_out_l_129.start);
    node_seam_chest_out_l_129.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seam_chest_out_l_129.position.set(0.0, 0.0, 0.0);
    node_seam_chest_out_l_129.rotation.set(0.0, 0.0, 0.0);
  }
  node_seam_chest_out_l_129.userData.sculptComponent = { id: "seam-chest-out-l" };
  node_seam_chest_out_l_129.userData.actionProfile = {};
  (nodes["chest-shell-l"] ?? root).add(node_seam_chest_out_l_129);
  nodes["seam-chest-out-l"] = node_seam_chest_out_l_129;
  const mesh_seam_chest_out_l_129Geometry = endpoint_seam_chest_out_l_129
    ? new THREE.CylinderGeometry(endpoint_seam_chest_out_l_129.endRadius, endpoint_seam_chest_out_l_129.baseRadius, endpoint_seam_chest_out_l_129.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.06721, 0.0, 0.04057], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [0.06054, -0.06929, 0.08945], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [0.01682, -0.17008, 0.10205], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [-0.03893, -0.26457, 0.07257], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_seam_chest_out_l_129) {
    mesh_seam_chest_out_l_129Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seam_chest_out_l_129 = new THREE.Mesh(
    mesh_seam_chest_out_l_129Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seam_chest_out_l_129.name = "Gold seam seam-chest-out-l";
  if (endpoint_seam_chest_out_l_129) {
    mesh_seam_chest_out_l_129.position.copy(endpoint_seam_chest_out_l_129.midpoint);
    mesh_seam_chest_out_l_129.quaternion.copy(endpoint_seam_chest_out_l_129.quaternion);
  }
  mesh_seam_chest_out_l_129.castShadow = options.castShadow ?? true;
  mesh_seam_chest_out_l_129.receiveShadow = options.receiveShadow ?? true;
  mesh_seam_chest_out_l_129.userData.sculptComponent = { id: "seam-chest-out-l" };
  node_seam_chest_out_l_129.add(mesh_seam_chest_out_l_129);
  meshes["seam-chest-out-l"] = mesh_seam_chest_out_l_129;
  colliders["seam-chest-out-l"] = {};
  destructionGroups["chest-shell-l"] ??= [];
  destructionGroups["chest-shell-l"].push(node_seam_chest_out_l_129);

  const endpoint_seam_pauldron_in_l_130 = makeAttachmentEndpoint(null);
  const node_seam_pauldron_in_l_130 = new THREE.Group();
  node_seam_pauldron_in_l_130.name = "Gold seam seam-pauldron-in-l__pivot";
  node_seam_pauldron_in_l_130.scale.set(1, 1, 1);
  if (endpoint_seam_pauldron_in_l_130) {
    node_seam_pauldron_in_l_130.position.copy(endpoint_seam_pauldron_in_l_130.start);
    node_seam_pauldron_in_l_130.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seam_pauldron_in_l_130.position.set(0.0, 0.0, 0.0);
    node_seam_pauldron_in_l_130.rotation.set(0.0, 0.0, 0.0);
  }
  node_seam_pauldron_in_l_130.userData.sculptComponent = { id: "seam-pauldron-in-l" };
  node_seam_pauldron_in_l_130.userData.actionProfile = {};
  (nodes["pauldron-l"] ?? root).add(node_seam_pauldron_in_l_130);
  nodes["seam-pauldron-in-l"] = node_seam_pauldron_in_l_130;
  const mesh_seam_pauldron_in_l_130Geometry = endpoint_seam_pauldron_in_l_130
    ? new THREE.CylinderGeometry(endpoint_seam_pauldron_in_l_130.endRadius, endpoint_seam_pauldron_in_l_130.baseRadius, endpoint_seam_pauldron_in_l_130.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.0275, 0.0, 0.01039], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [-0.00479, -0.07559, 0.02425], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [0.00819, -0.15748, 0.02803], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [0.00781, -0.23307, 0.01795], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [0.01946, -0.28346, 0.00126], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_seam_pauldron_in_l_130) {
    mesh_seam_pauldron_in_l_130Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seam_pauldron_in_l_130 = new THREE.Mesh(
    mesh_seam_pauldron_in_l_130Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seam_pauldron_in_l_130.name = "Gold seam seam-pauldron-in-l";
  if (endpoint_seam_pauldron_in_l_130) {
    mesh_seam_pauldron_in_l_130.position.copy(endpoint_seam_pauldron_in_l_130.midpoint);
    mesh_seam_pauldron_in_l_130.quaternion.copy(endpoint_seam_pauldron_in_l_130.quaternion);
  }
  mesh_seam_pauldron_in_l_130.castShadow = options.castShadow ?? true;
  mesh_seam_pauldron_in_l_130.receiveShadow = options.receiveShadow ?? true;
  mesh_seam_pauldron_in_l_130.userData.sculptComponent = { id: "seam-pauldron-in-l" };
  node_seam_pauldron_in_l_130.add(mesh_seam_pauldron_in_l_130);
  meshes["seam-pauldron-in-l"] = mesh_seam_pauldron_in_l_130;
  colliders["seam-pauldron-in-l"] = {};
  destructionGroups["pauldron-l"] ??= [];
  destructionGroups["pauldron-l"].push(node_seam_pauldron_in_l_130);

  const endpoint_seam_thigh_out_l_131 = makeAttachmentEndpoint(null);
  const node_seam_thigh_out_l_131 = new THREE.Group();
  node_seam_thigh_out_l_131.name = "Gold seam seam-thigh-out-l__pivot";
  node_seam_thigh_out_l_131.scale.set(1, 1, 1);
  if (endpoint_seam_thigh_out_l_131) {
    node_seam_thigh_out_l_131.position.copy(endpoint_seam_thigh_out_l_131.start);
    node_seam_thigh_out_l_131.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seam_thigh_out_l_131.position.set(0.0, 0.0, 0.0);
    node_seam_thigh_out_l_131.rotation.set(0.0, 0.0, 0.0);
  }
  node_seam_thigh_out_l_131.userData.sculptComponent = { id: "seam-thigh-out-l" };
  node_seam_thigh_out_l_131.userData.actionProfile = {};
  (nodes["thigh-plate-front-l"] ?? root).add(node_seam_thigh_out_l_131);
  nodes["seam-thigh-out-l"] = node_seam_thigh_out_l_131;
  const mesh_seam_thigh_out_l_131Geometry = endpoint_seam_thigh_out_l_131
    ? new THREE.CylinderGeometry(endpoint_seam_thigh_out_l_131.endRadius, endpoint_seam_thigh_out_l_131.baseRadius, endpoint_seam_thigh_out_l_131.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.01466, -0.0, 0.01669], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [0.05689, -0.09827, 0.02256], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [0.08862, -0.27024, 0.02608], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [0.07863, -0.41764, 0.02314], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [0.04248, -0.49134, 0.01669], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_seam_thigh_out_l_131) {
    mesh_seam_thigh_out_l_131Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seam_thigh_out_l_131 = new THREE.Mesh(
    mesh_seam_thigh_out_l_131Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seam_thigh_out_l_131.name = "Gold seam seam-thigh-out-l";
  if (endpoint_seam_thigh_out_l_131) {
    mesh_seam_thigh_out_l_131.position.copy(endpoint_seam_thigh_out_l_131.midpoint);
    mesh_seam_thigh_out_l_131.quaternion.copy(endpoint_seam_thigh_out_l_131.quaternion);
  }
  mesh_seam_thigh_out_l_131.castShadow = options.castShadow ?? true;
  mesh_seam_thigh_out_l_131.receiveShadow = options.receiveShadow ?? true;
  mesh_seam_thigh_out_l_131.userData.sculptComponent = { id: "seam-thigh-out-l" };
  node_seam_thigh_out_l_131.add(mesh_seam_thigh_out_l_131);
  meshes["seam-thigh-out-l"] = mesh_seam_thigh_out_l_131;
  colliders["seam-thigh-out-l"] = {};
  destructionGroups["thigh-plate-front-l"] ??= [];
  destructionGroups["thigh-plate-front-l"].push(node_seam_thigh_out_l_131);

  const endpoint_seam_shin_in_l_132 = makeAttachmentEndpoint(null);
  const node_seam_shin_in_l_132 = new THREE.Group();
  node_seam_shin_in_l_132.name = "Gold seam seam-shin-in-l__pivot";
  node_seam_shin_in_l_132.scale.set(1, 1, 1);
  if (endpoint_seam_shin_in_l_132) {
    node_seam_shin_in_l_132.position.copy(endpoint_seam_shin_in_l_132.start);
    node_seam_shin_in_l_132.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seam_shin_in_l_132.position.set(0.0, 0.0, 0.0);
    node_seam_shin_in_l_132.rotation.set(0.0, 0.0, 0.0);
  }
  node_seam_shin_in_l_132.userData.sculptComponent = { id: "seam-shin-in-l" };
  node_seam_shin_in_l_132.userData.actionProfile = {};
  (nodes["shin-plate-front-l"] ?? root).add(node_seam_shin_in_l_132);
  nodes["seam-shin-in-l"] = node_seam_shin_in_l_132;
  const mesh_seam_shin_in_l_132Geometry = endpoint_seam_shin_in_l_132
    ? new THREE.CylinderGeometry(endpoint_seam_shin_in_l_132.endRadius, endpoint_seam_shin_in_l_132.baseRadius, endpoint_seam_shin_in_l_132.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.01466, -0.0, 0.01669], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [-0.03365, -0.09575, 0.02256], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [-0.02471, -0.26331, 0.02608], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [0.02013, -0.40693, 0.02314], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [0.07372, -0.47874, 0.01669], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_seam_shin_in_l_132) {
    mesh_seam_shin_in_l_132Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seam_shin_in_l_132 = new THREE.Mesh(
    mesh_seam_shin_in_l_132Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seam_shin_in_l_132.name = "Gold seam seam-shin-in-l";
  if (endpoint_seam_shin_in_l_132) {
    mesh_seam_shin_in_l_132.position.copy(endpoint_seam_shin_in_l_132.midpoint);
    mesh_seam_shin_in_l_132.quaternion.copy(endpoint_seam_shin_in_l_132.quaternion);
  }
  mesh_seam_shin_in_l_132.castShadow = options.castShadow ?? true;
  mesh_seam_shin_in_l_132.receiveShadow = options.receiveShadow ?? true;
  mesh_seam_shin_in_l_132.userData.sculptComponent = { id: "seam-shin-in-l" };
  node_seam_shin_in_l_132.add(mesh_seam_shin_in_l_132);
  meshes["seam-shin-in-l"] = mesh_seam_shin_in_l_132;
  colliders["seam-shin-in-l"] = {};
  destructionGroups["shin-plate-front-l"] ??= [];
  destructionGroups["shin-plate-front-l"].push(node_seam_shin_in_l_132);

  const endpoint_seam_blade_l_133 = makeAttachmentEndpoint(null);
  const node_seam_blade_l_133 = new THREE.Group();
  node_seam_blade_l_133.name = "Gold seam seam-blade-l__pivot";
  node_seam_blade_l_133.scale.set(1, 1, 1);
  if (endpoint_seam_blade_l_133) {
    node_seam_blade_l_133.position.copy(endpoint_seam_blade_l_133.start);
    node_seam_blade_l_133.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seam_blade_l_133.position.set(0.0, 0.0, 0.0);
    node_seam_blade_l_133.rotation.set(0.0, 0.0, 0.0);
  }
  node_seam_blade_l_133.userData.sculptComponent = { id: "seam-blade-l" };
  node_seam_blade_l_133.userData.actionProfile = {};
  (nodes["forearm-blade-l"] ?? root).add(node_seam_blade_l_133);
  nodes["seam-blade-l"] = node_seam_blade_l_133;
  const mesh_seam_blade_l_133Geometry = endpoint_seam_blade_l_133
    ? new THREE.CylinderGeometry(endpoint_seam_blade_l_133.endRadius, endpoint_seam_blade_l_133.baseRadius, endpoint_seam_blade_l_133.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0275, 0.0, 0.01417], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [0.07102, -0.08819, 0.01417], "rx": 0.00567, "rz": 0.00567, "twist": 0.0}, {"position": [0.08668, -0.18898, 0.01417], "rx": 0.00567, "rz": 0.00567, "twist": 0.0}, {"position": [0.07465, -0.27087, 0.01134], "rx": 0.00567, "rz": 0.00567, "twist": 0.0}, {"position": [0.05039, -0.32756, 0.0], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_seam_blade_l_133) {
    mesh_seam_blade_l_133Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seam_blade_l_133 = new THREE.Mesh(
    mesh_seam_blade_l_133Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seam_blade_l_133.name = "Gold seam seam-blade-l";
  if (endpoint_seam_blade_l_133) {
    mesh_seam_blade_l_133.position.copy(endpoint_seam_blade_l_133.midpoint);
    mesh_seam_blade_l_133.quaternion.copy(endpoint_seam_blade_l_133.quaternion);
  }
  mesh_seam_blade_l_133.castShadow = options.castShadow ?? true;
  mesh_seam_blade_l_133.receiveShadow = options.receiveShadow ?? true;
  mesh_seam_blade_l_133.userData.sculptComponent = { id: "seam-blade-l" };
  node_seam_blade_l_133.add(mesh_seam_blade_l_133);
  meshes["seam-blade-l"] = mesh_seam_blade_l_133;
  colliders["seam-blade-l"] = {};
  destructionGroups["forearm-blade-l"] ??= [];
  destructionGroups["forearm-blade-l"].push(node_seam_blade_l_133);

  const endpoint_seam_bicep_l_134 = makeAttachmentEndpoint(null);
  const node_seam_bicep_l_134 = new THREE.Group();
  node_seam_bicep_l_134.name = "Gold seam seam-bicep-l__pivot";
  node_seam_bicep_l_134.scale.set(1, 1, 1);
  if (endpoint_seam_bicep_l_134) {
    node_seam_bicep_l_134.position.copy(endpoint_seam_bicep_l_134.start);
    node_seam_bicep_l_134.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seam_bicep_l_134.position.set(0.0, 0.0, 0.0);
    node_seam_bicep_l_134.rotation.set(0.0, 0.0, 0.0);
  }
  node_seam_bicep_l_134.userData.sculptComponent = { id: "seam-bicep-l" };
  node_seam_bicep_l_134.userData.actionProfile = {};
  (nodes["upper-arm-shell-l"] ?? root).add(node_seam_bicep_l_134);
  nodes["seam-bicep-l"] = node_seam_bicep_l_134;
  const mesh_seam_bicep_l_134Geometry = endpoint_seam_bicep_l_134
    ? new THREE.CylinderGeometry(endpoint_seam_bicep_l_134.endRadius, endpoint_seam_bicep_l_134.baseRadius, endpoint_seam_bicep_l_134.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.02139, 0.0, 0.01984], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [0.07713, -0.10079, 0.05102], "rx": 0.00441, "rz": 0.00441, "twist": 0.0}, {"position": [0.09058, -0.23307, 0.02268], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_seam_bicep_l_134) {
    mesh_seam_bicep_l_134Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seam_bicep_l_134 = new THREE.Mesh(
    mesh_seam_bicep_l_134Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seam_bicep_l_134.name = "Gold seam seam-bicep-l";
  if (endpoint_seam_bicep_l_134) {
    mesh_seam_bicep_l_134.position.copy(endpoint_seam_bicep_l_134.midpoint);
    mesh_seam_bicep_l_134.quaternion.copy(endpoint_seam_bicep_l_134.quaternion);
  }
  mesh_seam_bicep_l_134.castShadow = options.castShadow ?? true;
  mesh_seam_bicep_l_134.receiveShadow = options.receiveShadow ?? true;
  mesh_seam_bicep_l_134.userData.sculptComponent = { id: "seam-bicep-l" };
  node_seam_bicep_l_134.add(mesh_seam_bicep_l_134);
  meshes["seam-bicep-l"] = mesh_seam_bicep_l_134;
  colliders["seam-bicep-l"] = {};
  destructionGroups["upper-arm-shell-l"] ??= [];
  destructionGroups["upper-arm-shell-l"].push(node_seam_bicep_l_134);

  const endpoint_seam_chest_r_135 = makeAttachmentEndpoint(null);
  const node_seam_chest_r_135 = new THREE.Group();
  node_seam_chest_r_135.name = "Gold seam seam-chest-r__pivot";
  node_seam_chest_r_135.scale.set(1, 1, 1);
  if (endpoint_seam_chest_r_135) {
    node_seam_chest_r_135.position.copy(endpoint_seam_chest_r_135.start);
    node_seam_chest_r_135.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seam_chest_r_135.position.set(0.0, 0.0, 0.0);
    node_seam_chest_r_135.rotation.set(0.0, 0.0, 0.0);
  }
  node_seam_chest_r_135.userData.sculptComponent = { id: "seam-chest-r" };
  node_seam_chest_r_135.userData.actionProfile = {};
  (nodes["chest-shell-r"] ?? root).add(node_seam_chest_r_135);
  nodes["seam-chest-r"] = node_seam_chest_r_135;
  const mesh_seam_chest_r_135Geometry = endpoint_seam_chest_r_135
    ? new THREE.CylinderGeometry(endpoint_seam_chest_r_135.endRadius, endpoint_seam_chest_r_135.baseRadius, endpoint_seam_chest_r_135.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.06721, 0.0, 0.04057], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [0.09833, -0.06929, 0.08945], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [0.11761, -0.17008, 0.10205], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [0.11225, -0.26457, 0.07257], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_seam_chest_r_135) {
    mesh_seam_chest_r_135Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seam_chest_r_135 = new THREE.Mesh(
    mesh_seam_chest_r_135Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seam_chest_r_135.name = "Gold seam seam-chest-r";
  if (endpoint_seam_chest_r_135) {
    mesh_seam_chest_r_135.position.copy(endpoint_seam_chest_r_135.midpoint);
    mesh_seam_chest_r_135.quaternion.copy(endpoint_seam_chest_r_135.quaternion);
  }
  mesh_seam_chest_r_135.castShadow = options.castShadow ?? true;
  mesh_seam_chest_r_135.receiveShadow = options.receiveShadow ?? true;
  mesh_seam_chest_r_135.userData.sculptComponent = { id: "seam-chest-r" };
  node_seam_chest_r_135.add(mesh_seam_chest_r_135);
  meshes["seam-chest-r"] = mesh_seam_chest_r_135;
  colliders["seam-chest-r"] = {};
  destructionGroups["chest-shell-r"] ??= [];
  destructionGroups["chest-shell-r"].push(node_seam_chest_r_135);

  const endpoint_seam_pauldron_r_136 = makeAttachmentEndpoint(null);
  const node_seam_pauldron_r_136 = new THREE.Group();
  node_seam_pauldron_r_136.name = "Gold seam seam-pauldron-r__pivot";
  node_seam_pauldron_r_136.scale.set(1, 1, 1);
  if (endpoint_seam_pauldron_r_136) {
    node_seam_pauldron_r_136.position.copy(endpoint_seam_pauldron_r_136.start);
    node_seam_pauldron_r_136.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seam_pauldron_r_136.position.set(0.0, 0.0, 0.0);
    node_seam_pauldron_r_136.rotation.set(0.0, 0.0, 0.0);
  }
  node_seam_pauldron_r_136.userData.sculptComponent = { id: "seam-pauldron-r" };
  node_seam_pauldron_r_136.userData.actionProfile = {};
  (nodes["pauldron-r"] ?? root).add(node_seam_pauldron_r_136);
  nodes["seam-pauldron-r"] = node_seam_pauldron_r_136;
  const mesh_seam_pauldron_r_136Geometry = endpoint_seam_pauldron_r_136
    ? new THREE.CylinderGeometry(endpoint_seam_pauldron_r_136.endRadius, endpoint_seam_pauldron_r_136.baseRadius, endpoint_seam_pauldron_r_136.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.0275, 0.0, 0.01039], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [-0.09298, -0.07559, 0.02425], "rx": 0.0063, "rz": 0.0063, "twist": 0.0}, {"position": [-0.13039, -0.15748, 0.02803], "rx": 0.0063, "rz": 0.0063, "twist": 0.0}, {"position": [-0.10557, -0.23307, 0.01795], "rx": 0.0063, "rz": 0.0063, "twist": 0.0}, {"position": [-0.05613, -0.28346, 0.00126], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_seam_pauldron_r_136) {
    mesh_seam_pauldron_r_136Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seam_pauldron_r_136 = new THREE.Mesh(
    mesh_seam_pauldron_r_136Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seam_pauldron_r_136.name = "Gold seam seam-pauldron-r";
  if (endpoint_seam_pauldron_r_136) {
    mesh_seam_pauldron_r_136.position.copy(endpoint_seam_pauldron_r_136.midpoint);
    mesh_seam_pauldron_r_136.quaternion.copy(endpoint_seam_pauldron_r_136.quaternion);
  }
  mesh_seam_pauldron_r_136.castShadow = options.castShadow ?? true;
  mesh_seam_pauldron_r_136.receiveShadow = options.receiveShadow ?? true;
  mesh_seam_pauldron_r_136.userData.sculptComponent = { id: "seam-pauldron-r" };
  node_seam_pauldron_r_136.add(mesh_seam_pauldron_r_136);
  meshes["seam-pauldron-r"] = mesh_seam_pauldron_r_136;
  colliders["seam-pauldron-r"] = {};
  destructionGroups["pauldron-r"] ??= [];
  destructionGroups["pauldron-r"].push(node_seam_pauldron_r_136);

  const endpoint_seam_thigh_r_137 = makeAttachmentEndpoint(null);
  const node_seam_thigh_r_137 = new THREE.Group();
  node_seam_thigh_r_137.name = "Gold seam seam-thigh-r__pivot";
  node_seam_thigh_r_137.scale.set(1, 1, 1);
  if (endpoint_seam_thigh_r_137) {
    node_seam_thigh_r_137.position.copy(endpoint_seam_thigh_r_137.start);
    node_seam_thigh_r_137.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seam_thigh_r_137.position.set(0.0, 0.0, 0.0);
    node_seam_thigh_r_137.rotation.set(0.0, 0.0, 0.0);
  }
  node_seam_thigh_r_137.userData.sculptComponent = { id: "seam-thigh-r" };
  node_seam_thigh_r_137.userData.actionProfile = {};
  (nodes["thigh-plate-front-r"] ?? root).add(node_seam_thigh_r_137);
  nodes["seam-thigh-r"] = node_seam_thigh_r_137;
  const mesh_seam_thigh_r_137Geometry = endpoint_seam_thigh_r_137
    ? new THREE.CylinderGeometry(endpoint_seam_thigh_r_137.endRadius, endpoint_seam_thigh_r_137.baseRadius, endpoint_seam_thigh_r_137.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.01466, -0.0, 0.01669], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [0.04576, -0.09827, 0.02256], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [0.05803, -0.27024, 0.02608], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [0.03135, -0.41764, 0.02314], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [-0.01315, -0.49134, 0.01669], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_seam_thigh_r_137) {
    mesh_seam_thigh_r_137Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seam_thigh_r_137 = new THREE.Mesh(
    mesh_seam_thigh_r_137Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seam_thigh_r_137.name = "Gold seam seam-thigh-r";
  if (endpoint_seam_thigh_r_137) {
    mesh_seam_thigh_r_137.position.copy(endpoint_seam_thigh_r_137.midpoint);
    mesh_seam_thigh_r_137.quaternion.copy(endpoint_seam_thigh_r_137.quaternion);
  }
  mesh_seam_thigh_r_137.castShadow = options.castShadow ?? true;
  mesh_seam_thigh_r_137.receiveShadow = options.receiveShadow ?? true;
  mesh_seam_thigh_r_137.userData.sculptComponent = { id: "seam-thigh-r" };
  node_seam_thigh_r_137.add(mesh_seam_thigh_r_137);
  meshes["seam-thigh-r"] = mesh_seam_thigh_r_137;
  colliders["seam-thigh-r"] = {};
  destructionGroups["thigh-plate-front-r"] ??= [];
  destructionGroups["thigh-plate-front-r"].push(node_seam_thigh_r_137);

  const endpoint_seam_shin_r_138 = makeAttachmentEndpoint(null);
  const node_seam_shin_r_138 = new THREE.Group();
  node_seam_shin_r_138.name = "Gold seam seam-shin-r__pivot";
  node_seam_shin_r_138.scale.set(1, 1, 1);
  if (endpoint_seam_shin_r_138) {
    node_seam_shin_r_138.position.copy(endpoint_seam_shin_r_138.start);
    node_seam_shin_r_138.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seam_shin_r_138.position.set(0.0, 0.0, 0.0);
    node_seam_shin_r_138.rotation.set(0.0, 0.0, 0.0);
  }
  node_seam_shin_r_138.userData.sculptComponent = { id: "seam-shin-r" };
  node_seam_shin_r_138.userData.actionProfile = {};
  (nodes["shin-plate-front-r"] ?? root).add(node_seam_shin_r_138);
  nodes["seam-shin-r"] = node_seam_shin_r_138;
  const mesh_seam_shin_r_138Geometry = endpoint_seam_shin_r_138
    ? new THREE.CylinderGeometry(endpoint_seam_shin_r_138.endRadius, endpoint_seam_shin_r_138.baseRadius, endpoint_seam_shin_r_138.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.01466, -0.0, 0.01669], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [-0.069, -0.09575, 0.02256], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [-0.12193, -0.26331, 0.02608], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [-0.13012, -0.40693, 0.02314], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [-0.10305, -0.47874, 0.01669], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_seam_shin_r_138) {
    mesh_seam_shin_r_138Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seam_shin_r_138 = new THREE.Mesh(
    mesh_seam_shin_r_138Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seam_shin_r_138.name = "Gold seam seam-shin-r";
  if (endpoint_seam_shin_r_138) {
    mesh_seam_shin_r_138.position.copy(endpoint_seam_shin_r_138.midpoint);
    mesh_seam_shin_r_138.quaternion.copy(endpoint_seam_shin_r_138.quaternion);
  }
  mesh_seam_shin_r_138.castShadow = options.castShadow ?? true;
  mesh_seam_shin_r_138.receiveShadow = options.receiveShadow ?? true;
  mesh_seam_shin_r_138.userData.sculptComponent = { id: "seam-shin-r" };
  node_seam_shin_r_138.add(mesh_seam_shin_r_138);
  meshes["seam-shin-r"] = mesh_seam_shin_r_138;
  colliders["seam-shin-r"] = {};
  destructionGroups["shin-plate-front-r"] ??= [];
  destructionGroups["shin-plate-front-r"].push(node_seam_shin_r_138);

  const endpoint_seam_boot_r_139 = makeAttachmentEndpoint(null);
  const node_seam_boot_r_139 = new THREE.Group();
  node_seam_boot_r_139.name = "Gold seam seam-boot-r__pivot";
  node_seam_boot_r_139.scale.set(1, 1, 1);
  if (endpoint_seam_boot_r_139) {
    node_seam_boot_r_139.position.copy(endpoint_seam_boot_r_139.start);
    node_seam_boot_r_139.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seam_boot_r_139.position.set(0.0, 0.0, 0.0);
    node_seam_boot_r_139.rotation.set(0.0, 0.0, 0.0);
  }
  node_seam_boot_r_139.userData.sculptComponent = { id: "seam-boot-r" };
  node_seam_boot_r_139.userData.actionProfile = {};
  (nodes["boot-r"] ?? root).add(node_seam_boot_r_139);
  nodes["seam-boot-r"] = node_seam_boot_r_139;
  const mesh_seam_boot_r_139Geometry = endpoint_seam_boot_r_139
    ? new THREE.CylinderGeometry(endpoint_seam_boot_r_139.endRadius, endpoint_seam_boot_r_139.baseRadius, endpoint_seam_boot_r_139.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.0611, 0.01654, 0.0], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [-0.08554, 0.01354, 0.07874], "rx": 0.00567, "rz": 0.00567, "twist": 0.0}, {"position": [-0.08554, 0.00173, 0.17323], "rx": 0.00567, "rz": 0.00567, "twist": 0.0}, {"position": [-0.0611, -0.02268, 0.25827], "rx": 0.00567, "rz": 0.00567, "twist": 0.0}, {"position": [-0.03055, -0.03339, 0.30236], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_seam_boot_r_139) {
    mesh_seam_boot_r_139Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seam_boot_r_139 = new THREE.Mesh(
    mesh_seam_boot_r_139Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seam_boot_r_139.name = "Gold seam seam-boot-r";
  if (endpoint_seam_boot_r_139) {
    mesh_seam_boot_r_139.position.copy(endpoint_seam_boot_r_139.midpoint);
    mesh_seam_boot_r_139.quaternion.copy(endpoint_seam_boot_r_139.quaternion);
  }
  mesh_seam_boot_r_139.castShadow = options.castShadow ?? true;
  mesh_seam_boot_r_139.receiveShadow = options.receiveShadow ?? true;
  mesh_seam_boot_r_139.userData.sculptComponent = { id: "seam-boot-r" };
  node_seam_boot_r_139.add(mesh_seam_boot_r_139);
  meshes["seam-boot-r"] = mesh_seam_boot_r_139;
  colliders["seam-boot-r"] = {};
  destructionGroups["boot-r"] ??= [];
  destructionGroups["boot-r"].push(node_seam_boot_r_139);

  const endpoint_seam_chest_out_r_140 = makeAttachmentEndpoint(null);
  const node_seam_chest_out_r_140 = new THREE.Group();
  node_seam_chest_out_r_140.name = "Gold seam seam-chest-out-r__pivot";
  node_seam_chest_out_r_140.scale.set(1, 1, 1);
  if (endpoint_seam_chest_out_r_140) {
    node_seam_chest_out_r_140.position.copy(endpoint_seam_chest_out_r_140.start);
    node_seam_chest_out_r_140.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seam_chest_out_r_140.position.set(0.0, 0.0, 0.0);
    node_seam_chest_out_r_140.rotation.set(0.0, 0.0, 0.0);
  }
  node_seam_chest_out_r_140.userData.sculptComponent = { id: "seam-chest-out-r" };
  node_seam_chest_out_r_140.userData.actionProfile = {};
  (nodes["chest-shell-r"] ?? root).add(node_seam_chest_out_r_140);
  nodes["seam-chest-out-r"] = node_seam_chest_out_r_140;
  const mesh_seam_chest_out_r_140Geometry = endpoint_seam_chest_out_r_140
    ? new THREE.CylinderGeometry(endpoint_seam_chest_out_r_140.endRadius, endpoint_seam_chest_out_r_140.baseRadius, endpoint_seam_chest_out_r_140.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.06721, 0.0, 0.04057], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [-0.06054, -0.06929, 0.08945], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [-0.01682, -0.17008, 0.10205], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [0.03893, -0.26457, 0.07257], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_seam_chest_out_r_140) {
    mesh_seam_chest_out_r_140Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seam_chest_out_r_140 = new THREE.Mesh(
    mesh_seam_chest_out_r_140Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seam_chest_out_r_140.name = "Gold seam seam-chest-out-r";
  if (endpoint_seam_chest_out_r_140) {
    mesh_seam_chest_out_r_140.position.copy(endpoint_seam_chest_out_r_140.midpoint);
    mesh_seam_chest_out_r_140.quaternion.copy(endpoint_seam_chest_out_r_140.quaternion);
  }
  mesh_seam_chest_out_r_140.castShadow = options.castShadow ?? true;
  mesh_seam_chest_out_r_140.receiveShadow = options.receiveShadow ?? true;
  mesh_seam_chest_out_r_140.userData.sculptComponent = { id: "seam-chest-out-r" };
  node_seam_chest_out_r_140.add(mesh_seam_chest_out_r_140);
  meshes["seam-chest-out-r"] = mesh_seam_chest_out_r_140;
  colliders["seam-chest-out-r"] = {};
  destructionGroups["chest-shell-r"] ??= [];
  destructionGroups["chest-shell-r"].push(node_seam_chest_out_r_140);

  const endpoint_seam_pauldron_in_r_141 = makeAttachmentEndpoint(null);
  const node_seam_pauldron_in_r_141 = new THREE.Group();
  node_seam_pauldron_in_r_141.name = "Gold seam seam-pauldron-in-r__pivot";
  node_seam_pauldron_in_r_141.scale.set(1, 1, 1);
  if (endpoint_seam_pauldron_in_r_141) {
    node_seam_pauldron_in_r_141.position.copy(endpoint_seam_pauldron_in_r_141.start);
    node_seam_pauldron_in_r_141.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seam_pauldron_in_r_141.position.set(0.0, 0.0, 0.0);
    node_seam_pauldron_in_r_141.rotation.set(0.0, 0.0, 0.0);
  }
  node_seam_pauldron_in_r_141.userData.sculptComponent = { id: "seam-pauldron-in-r" };
  node_seam_pauldron_in_r_141.userData.actionProfile = {};
  (nodes["pauldron-r"] ?? root).add(node_seam_pauldron_in_r_141);
  nodes["seam-pauldron-in-r"] = node_seam_pauldron_in_r_141;
  const mesh_seam_pauldron_in_r_141Geometry = endpoint_seam_pauldron_in_r_141
    ? new THREE.CylinderGeometry(endpoint_seam_pauldron_in_r_141.endRadius, endpoint_seam_pauldron_in_r_141.baseRadius, endpoint_seam_pauldron_in_r_141.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0275, 0.0, 0.01039], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [0.00479, -0.07559, 0.02425], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [-0.00819, -0.15748, 0.02803], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [-0.00781, -0.23307, 0.01795], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [-0.01946, -0.28346, 0.00126], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_seam_pauldron_in_r_141) {
    mesh_seam_pauldron_in_r_141Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seam_pauldron_in_r_141 = new THREE.Mesh(
    mesh_seam_pauldron_in_r_141Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seam_pauldron_in_r_141.name = "Gold seam seam-pauldron-in-r";
  if (endpoint_seam_pauldron_in_r_141) {
    mesh_seam_pauldron_in_r_141.position.copy(endpoint_seam_pauldron_in_r_141.midpoint);
    mesh_seam_pauldron_in_r_141.quaternion.copy(endpoint_seam_pauldron_in_r_141.quaternion);
  }
  mesh_seam_pauldron_in_r_141.castShadow = options.castShadow ?? true;
  mesh_seam_pauldron_in_r_141.receiveShadow = options.receiveShadow ?? true;
  mesh_seam_pauldron_in_r_141.userData.sculptComponent = { id: "seam-pauldron-in-r" };
  node_seam_pauldron_in_r_141.add(mesh_seam_pauldron_in_r_141);
  meshes["seam-pauldron-in-r"] = mesh_seam_pauldron_in_r_141;
  colliders["seam-pauldron-in-r"] = {};
  destructionGroups["pauldron-r"] ??= [];
  destructionGroups["pauldron-r"].push(node_seam_pauldron_in_r_141);

  const endpoint_seam_thigh_out_r_142 = makeAttachmentEndpoint(null);
  const node_seam_thigh_out_r_142 = new THREE.Group();
  node_seam_thigh_out_r_142.name = "Gold seam seam-thigh-out-r__pivot";
  node_seam_thigh_out_r_142.scale.set(1, 1, 1);
  if (endpoint_seam_thigh_out_r_142) {
    node_seam_thigh_out_r_142.position.copy(endpoint_seam_thigh_out_r_142.start);
    node_seam_thigh_out_r_142.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seam_thigh_out_r_142.position.set(0.0, 0.0, 0.0);
    node_seam_thigh_out_r_142.rotation.set(0.0, 0.0, 0.0);
  }
  node_seam_thigh_out_r_142.userData.sculptComponent = { id: "seam-thigh-out-r" };
  node_seam_thigh_out_r_142.userData.actionProfile = {};
  (nodes["thigh-plate-front-r"] ?? root).add(node_seam_thigh_out_r_142);
  nodes["seam-thigh-out-r"] = node_seam_thigh_out_r_142;
  const mesh_seam_thigh_out_r_142Geometry = endpoint_seam_thigh_out_r_142
    ? new THREE.CylinderGeometry(endpoint_seam_thigh_out_r_142.endRadius, endpoint_seam_thigh_out_r_142.baseRadius, endpoint_seam_thigh_out_r_142.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.01466, -0.0, 0.01669], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [-0.05689, -0.09827, 0.02256], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [-0.08862, -0.27024, 0.02608], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [-0.07863, -0.41764, 0.02314], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [-0.04248, -0.49134, 0.01669], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_seam_thigh_out_r_142) {
    mesh_seam_thigh_out_r_142Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seam_thigh_out_r_142 = new THREE.Mesh(
    mesh_seam_thigh_out_r_142Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seam_thigh_out_r_142.name = "Gold seam seam-thigh-out-r";
  if (endpoint_seam_thigh_out_r_142) {
    mesh_seam_thigh_out_r_142.position.copy(endpoint_seam_thigh_out_r_142.midpoint);
    mesh_seam_thigh_out_r_142.quaternion.copy(endpoint_seam_thigh_out_r_142.quaternion);
  }
  mesh_seam_thigh_out_r_142.castShadow = options.castShadow ?? true;
  mesh_seam_thigh_out_r_142.receiveShadow = options.receiveShadow ?? true;
  mesh_seam_thigh_out_r_142.userData.sculptComponent = { id: "seam-thigh-out-r" };
  node_seam_thigh_out_r_142.add(mesh_seam_thigh_out_r_142);
  meshes["seam-thigh-out-r"] = mesh_seam_thigh_out_r_142;
  colliders["seam-thigh-out-r"] = {};
  destructionGroups["thigh-plate-front-r"] ??= [];
  destructionGroups["thigh-plate-front-r"].push(node_seam_thigh_out_r_142);

  const endpoint_seam_shin_in_r_143 = makeAttachmentEndpoint(null);
  const node_seam_shin_in_r_143 = new THREE.Group();
  node_seam_shin_in_r_143.name = "Gold seam seam-shin-in-r__pivot";
  node_seam_shin_in_r_143.scale.set(1, 1, 1);
  if (endpoint_seam_shin_in_r_143) {
    node_seam_shin_in_r_143.position.copy(endpoint_seam_shin_in_r_143.start);
    node_seam_shin_in_r_143.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seam_shin_in_r_143.position.set(0.0, 0.0, 0.0);
    node_seam_shin_in_r_143.rotation.set(0.0, 0.0, 0.0);
  }
  node_seam_shin_in_r_143.userData.sculptComponent = { id: "seam-shin-in-r" };
  node_seam_shin_in_r_143.userData.actionProfile = {};
  (nodes["shin-plate-front-r"] ?? root).add(node_seam_shin_in_r_143);
  nodes["seam-shin-in-r"] = node_seam_shin_in_r_143;
  const mesh_seam_shin_in_r_143Geometry = endpoint_seam_shin_in_r_143
    ? new THREE.CylinderGeometry(endpoint_seam_shin_in_r_143.endRadius, endpoint_seam_shin_in_r_143.baseRadius, endpoint_seam_shin_in_r_143.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.01466, -0.0, 0.01669], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [0.03365, -0.09575, 0.02256], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [0.02471, -0.26331, 0.02608], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [-0.02013, -0.40693, 0.02314], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [-0.07372, -0.47874, 0.01669], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_seam_shin_in_r_143) {
    mesh_seam_shin_in_r_143Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seam_shin_in_r_143 = new THREE.Mesh(
    mesh_seam_shin_in_r_143Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seam_shin_in_r_143.name = "Gold seam seam-shin-in-r";
  if (endpoint_seam_shin_in_r_143) {
    mesh_seam_shin_in_r_143.position.copy(endpoint_seam_shin_in_r_143.midpoint);
    mesh_seam_shin_in_r_143.quaternion.copy(endpoint_seam_shin_in_r_143.quaternion);
  }
  mesh_seam_shin_in_r_143.castShadow = options.castShadow ?? true;
  mesh_seam_shin_in_r_143.receiveShadow = options.receiveShadow ?? true;
  mesh_seam_shin_in_r_143.userData.sculptComponent = { id: "seam-shin-in-r" };
  node_seam_shin_in_r_143.add(mesh_seam_shin_in_r_143);
  meshes["seam-shin-in-r"] = mesh_seam_shin_in_r_143;
  colliders["seam-shin-in-r"] = {};
  destructionGroups["shin-plate-front-r"] ??= [];
  destructionGroups["shin-plate-front-r"].push(node_seam_shin_in_r_143);

  const endpoint_seam_blade_r_144 = makeAttachmentEndpoint(null);
  const node_seam_blade_r_144 = new THREE.Group();
  node_seam_blade_r_144.name = "Gold seam seam-blade-r__pivot";
  node_seam_blade_r_144.scale.set(1, 1, 1);
  if (endpoint_seam_blade_r_144) {
    node_seam_blade_r_144.position.copy(endpoint_seam_blade_r_144.start);
    node_seam_blade_r_144.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seam_blade_r_144.position.set(0.0, 0.0, 0.0);
    node_seam_blade_r_144.rotation.set(0.0, 0.0, 0.0);
  }
  node_seam_blade_r_144.userData.sculptComponent = { id: "seam-blade-r" };
  node_seam_blade_r_144.userData.actionProfile = {};
  (nodes["forearm-blade-r"] ?? root).add(node_seam_blade_r_144);
  nodes["seam-blade-r"] = node_seam_blade_r_144;
  const mesh_seam_blade_r_144Geometry = endpoint_seam_blade_r_144
    ? new THREE.CylinderGeometry(endpoint_seam_blade_r_144.endRadius, endpoint_seam_blade_r_144.baseRadius, endpoint_seam_blade_r_144.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.0275, 0.0, 0.01417], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [-0.07102, -0.08819, 0.01417], "rx": 0.00567, "rz": 0.00567, "twist": 0.0}, {"position": [-0.08668, -0.18898, 0.01417], "rx": 0.00567, "rz": 0.00567, "twist": 0.0}, {"position": [-0.07465, -0.27087, 0.01134], "rx": 0.00567, "rz": 0.00567, "twist": 0.0}, {"position": [-0.05039, -0.32756, 0.0], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_seam_blade_r_144) {
    mesh_seam_blade_r_144Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seam_blade_r_144 = new THREE.Mesh(
    mesh_seam_blade_r_144Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seam_blade_r_144.name = "Gold seam seam-blade-r";
  if (endpoint_seam_blade_r_144) {
    mesh_seam_blade_r_144.position.copy(endpoint_seam_blade_r_144.midpoint);
    mesh_seam_blade_r_144.quaternion.copy(endpoint_seam_blade_r_144.quaternion);
  }
  mesh_seam_blade_r_144.castShadow = options.castShadow ?? true;
  mesh_seam_blade_r_144.receiveShadow = options.receiveShadow ?? true;
  mesh_seam_blade_r_144.userData.sculptComponent = { id: "seam-blade-r" };
  node_seam_blade_r_144.add(mesh_seam_blade_r_144);
  meshes["seam-blade-r"] = mesh_seam_blade_r_144;
  colliders["seam-blade-r"] = {};
  destructionGroups["forearm-blade-r"] ??= [];
  destructionGroups["forearm-blade-r"].push(node_seam_blade_r_144);

  const endpoint_seam_bicep_r_145 = makeAttachmentEndpoint(null);
  const node_seam_bicep_r_145 = new THREE.Group();
  node_seam_bicep_r_145.name = "Gold seam seam-bicep-r__pivot";
  node_seam_bicep_r_145.scale.set(1, 1, 1);
  if (endpoint_seam_bicep_r_145) {
    node_seam_bicep_r_145.position.copy(endpoint_seam_bicep_r_145.start);
    node_seam_bicep_r_145.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seam_bicep_r_145.position.set(0.0, 0.0, 0.0);
    node_seam_bicep_r_145.rotation.set(0.0, 0.0, 0.0);
  }
  node_seam_bicep_r_145.userData.sculptComponent = { id: "seam-bicep-r" };
  node_seam_bicep_r_145.userData.actionProfile = {};
  (nodes["upper-arm-shell-r"] ?? root).add(node_seam_bicep_r_145);
  nodes["seam-bicep-r"] = node_seam_bicep_r_145;
  const mesh_seam_bicep_r_145Geometry = endpoint_seam_bicep_r_145
    ? new THREE.CylinderGeometry(endpoint_seam_bicep_r_145.endRadius, endpoint_seam_bicep_r_145.baseRadius, endpoint_seam_bicep_r_145.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.02139, 0.0, 0.01984], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [-0.07713, -0.10079, 0.05102], "rx": 0.00441, "rz": 0.00441, "twist": 0.0}, {"position": [-0.09058, -0.23307, 0.02268], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_seam_bicep_r_145) {
    mesh_seam_bicep_r_145Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seam_bicep_r_145 = new THREE.Mesh(
    mesh_seam_bicep_r_145Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seam_bicep_r_145.name = "Gold seam seam-bicep-r";
  if (endpoint_seam_bicep_r_145) {
    mesh_seam_bicep_r_145.position.copy(endpoint_seam_bicep_r_145.midpoint);
    mesh_seam_bicep_r_145.quaternion.copy(endpoint_seam_bicep_r_145.quaternion);
  }
  mesh_seam_bicep_r_145.castShadow = options.castShadow ?? true;
  mesh_seam_bicep_r_145.receiveShadow = options.receiveShadow ?? true;
  mesh_seam_bicep_r_145.userData.sculptComponent = { id: "seam-bicep-r" };
  node_seam_bicep_r_145.add(mesh_seam_bicep_r_145);
  meshes["seam-bicep-r"] = mesh_seam_bicep_r_145;
  colliders["seam-bicep-r"] = {};
  destructionGroups["upper-arm-shell-r"] ??= [];
  destructionGroups["upper-arm-shell-r"].push(node_seam_bicep_r_145);

  const endpoint_seam_helmet_146 = makeAttachmentEndpoint(null);
  const node_seam_helmet_146 = new THREE.Group();
  node_seam_helmet_146.name = "Gold seam seam-helmet__pivot";
  node_seam_helmet_146.scale.set(1, 1, 1);
  if (endpoint_seam_helmet_146) {
    node_seam_helmet_146.position.copy(endpoint_seam_helmet_146.start);
    node_seam_helmet_146.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seam_helmet_146.position.set(0.0, 0.0, 0.0);
    node_seam_helmet_146.rotation.set(0.0, 0.0, 0.0);
  }
  node_seam_helmet_146.userData.sculptComponent = { id: "seam-helmet" };
  node_seam_helmet_146.userData.actionProfile = {};
  (nodes["head"] ?? root).add(node_seam_helmet_146);
  nodes["seam-helmet"] = node_seam_helmet_146;
  const mesh_seam_helmet_146Geometry = endpoint_seam_helmet_146
    ? new THREE.CylinderGeometry(endpoint_seam_helmet_146.endRadius, endpoint_seam_helmet_146.baseRadius, endpoint_seam_helmet_146.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.15118, 0.1365], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [0.0, 0.21417, 0.12409], "rx": 0.0063, "rz": 0.0063, "twist": 0.0}, {"position": [0.0, 0.25197, 0.09307], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_seam_helmet_146) {
    mesh_seam_helmet_146Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seam_helmet_146 = new THREE.Mesh(
    mesh_seam_helmet_146Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seam_helmet_146.name = "Gold seam seam-helmet";
  if (endpoint_seam_helmet_146) {
    mesh_seam_helmet_146.position.copy(endpoint_seam_helmet_146.midpoint);
    mesh_seam_helmet_146.quaternion.copy(endpoint_seam_helmet_146.quaternion);
  }
  mesh_seam_helmet_146.castShadow = options.castShadow ?? true;
  mesh_seam_helmet_146.receiveShadow = options.receiveShadow ?? true;
  mesh_seam_helmet_146.userData.sculptComponent = { id: "seam-helmet" };
  node_seam_helmet_146.add(mesh_seam_helmet_146);
  meshes["seam-helmet"] = mesh_seam_helmet_146;
  colliders["seam-helmet"] = {};
  destructionGroups["head"] ??= [];
  destructionGroups["head"].push(node_seam_helmet_146);
  // repetition system "gold-seam-strips" describes 23 parts that are already built individually; not instanced.
  // repetition system "glow-pads" describes 10 parts that are already built individually; not instanced.
  // repetition system "finger-phalanges" describes 30 parts that are already built individually; not instanced.

  root.userData.sculptRuntime = { nodes, meshes, sockets, colliders, destructionGroups } satisfies ProceduralModelRuntime;
  root.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  root.userData.actionReadiness = {
    note: 'Use root.userData.sculptRuntime.nodes for transforms, sockets for attachments, colliders for physics proxies, and destructionGroups for breakable sets.',
  };
  return root;
}
