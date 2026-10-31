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

function buildLatheGeometry(profile: { points: [number, number][]; segments?: number }): THREE.LatheGeometry {
  const points = profile.points.map(([x, y]) => new THREE.Vector2(Math.max(0.0001, x), y));
  return new THREE.LatheGeometry(points, profile.segments ?? 24);
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

// Generated from ObjectSculptSpec target: AI Assistant Bot
// Sculpt build pass: blockout
// This factory is intentionally pass-gated. Finish browser screenshot review before unlocking deeper passes.
export function createBot(options: ProceduralModelOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = "AI Assistant Bot";
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
    {"id": "armor-pearl-silver", "name": "Pearl-silver clear-coated armor", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#9fa3b6", "color": "#9fa3b6", "albedo": {"dominant": "#9fa3b6", "secondary": ["#9496a8", "#b4b8c8"]}, "colorVariation": {"palette": ["#9fa3b6", "#9496a8", "#b4b8c8"], "pattern": "flat", "amplitude": 0.02, "heightCorrelation": 0.0}, "roughness": {"base": 0.22, "variation": 0.04}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "clearcoat-sheen", "region": "armor plates", "change": "low roughness + clearcoat hotspot band following plate curvature", "strength": 0.7, "evidenceRef": "/home/divyansh-muley/Divyansh/Projects/Divi/hero-bot-workspace/refs/bot6.png", "note": "Metadata only: the generator applies clearcoat to the whole material."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Albedo from sampled flat-lit silver regions; gloss from clearcoat + environment light.", "clearcoat": {"base": 1.0}, "clearcoatRoughness": {"base": 0.03}, "textureless": {"declared": true, "evidence": ["Reference view: /home/divyansh-muley/Divyansh/Projects/Divi/hero-bot-workspace/refs/bot6.png shows clean uniform clear-coated pearl paint without grain or wear."]}},
    options
  );
  materialMap["trim-gold"] = createSculptMaterial(
    "trim-gold",
    {"id": "trim-gold", "name": "Metallic gold trim", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#b68241", "color": "#b68241", "albedo": {"dominant": "#b68241", "secondary": ["#a8763a", "#c58f4a"]}, "colorVariation": {"palette": ["#b68241", "#a8763a", "#c58f4a"], "pattern": "flat", "amplitude": 0.02, "heightCorrelation": 0.0}, "roughness": {"base": 0.3, "variation": 0.04}, "metalness": {"base": 1.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Metal: needs environment reflections.", "textureless": {"declared": true, "evidence": ["Reference view: /home/divyansh-muley/Divyansh/Projects/Divi/hero-bot-workspace/refs/bot6.png shows gold as thin smooth inlay lines with no pattern."]}},
    options
  );
  materialMap["joint-black"] = createSculptMaterial(
    "joint-black",
    {"id": "joint-black", "name": "Glossy black polymer", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#141317", "color": "#141317", "albedo": {"dominant": "#141317", "secondary": ["#0e0d11", "#1b1a20"]}, "colorVariation": {"palette": ["#141317", "#0e0d11", "#1b1a20"], "pattern": "flat", "amplitude": 0.02, "heightCorrelation": 0.0}, "roughness": {"base": 0.3, "variation": 0.04}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "", "clearcoat": {"base": 0.5}, "clearcoatRoughness": {"base": 0.1}, "textureless": {"declared": true, "evidence": ["Reference view: /home/divyansh-muley/Divyansh/Projects/Divi/hero-bot-workspace/refs/bot6.png shows smooth glossy black joints and cores."]}},
    options
  );
  materialMap["emissive-accent"] = createSculptMaterial(
    "emissive-accent",
    {"id": "emissive-accent", "name": "Emissive accent", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#29d3ff", "color": "#29d3ff", "albedo": {"dominant": "#29d3ff", "secondary": ["#29d3ff"]}, "colorVariation": {"palette": ["#29d3ff"], "pattern": "flat", "amplitude": 0.02, "heightCorrelation": 0.0}, "roughness": {"base": 0.45, "variation": 0.04}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "bloom-core", "region": "all emissive accents", "change": "emissive intensity intended to bloom", "strength": 1.0, "evidenceRef": "/home/divyansh-muley/Divyansh/Projects/Divi/hero-bot-workspace/refs/bot6.png", "note": "Metadata only."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Every glow is a dedicated component using this material.", "emissive": "#29d3ff", "emissiveIntensity": {"base": 2.6}, "textureless": {"declared": true, "evidence": ["Reference view: /home/divyansh-muley/Divyansh/Projects/Divi/hero-bot-workspace/refs/bot6.png shows uniform glow with no grain or pattern."]}},
    options
  );
  materialMap["emblem-disc-dark"] = createSculptMaterial(
    "emblem-disc-dark",
    {"id": "emblem-disc-dark", "name": "Dark emblem disc", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#08435a", "color": "#08435a", "albedo": {"dominant": "#08435a", "secondary": ["#08435a"]}, "colorVariation": {"palette": ["#08435a"], "pattern": "flat", "amplitude": 0.02, "heightCorrelation": 0.0}, "roughness": {"base": 0.2, "variation": 0.04}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "", "clearcoat": {"base": 1.0}, "clearcoatRoughness": {"base": 0.05}, "textureless": {"declared": true, "evidence": ["Reference view: /home/divyansh-muley/Divyansh/Projects/Divi/hero-bot-workspace/refs/bot6.png shows a plain dark disc behind the AI lettering."]}},
    options
  );
  materialMap["emblem-white"] = createSculptMaterial(
    "emblem-white",
    {"id": "emblem-white", "name": "Emblem white lettering", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#f3f9fc", "color": "#f3f9fc", "albedo": {"dominant": "#f3f9fc", "secondary": ["#f3f9fc"]}, "colorVariation": {"palette": ["#f3f9fc"], "pattern": "flat", "amplitude": 0.02, "heightCorrelation": 0.0}, "roughness": {"base": 0.3, "variation": 0.04}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "", "emissive": "#cfe3ff", "emissiveIntensity": {"base": 0.9}, "textureless": {"declared": true, "evidence": ["Reference view: /home/divyansh-muley/Divyansh/Projects/Divi/hero-bot-workspace/refs/bot6.png shows solid white AI letters."]}},
    options
  );
  materialMap["holo-panel"] = createSculptMaterial(
    "holo-panel",
    {"id": "holo-panel", "name": "Translucent holographic panel", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#49d9ff", "color": "#49d9ff", "albedo": {"dominant": "#49d9ff", "secondary": ["#49d9ff"]}, "colorVariation": {"palette": ["#49d9ff"], "pattern": "flat", "amplitude": 0.02, "heightCorrelation": 0.0}, "roughness": {"base": 0.2, "variation": 0.04}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "", "emissive": "#29d3ff", "emissiveIntensity": {"base": 0.9}, "opacity": {"base": 0.3}, "textureless": {"declared": true, "evidence": ["Reference view: /home/divyansh-muley/Divyansh/Projects/Divi/hero-bot-workspace/refs/bot6.png shows flat translucent coloured panels whose detail is thin lines and bars, which are separate parts."]}},
    options
  );
  materialMap["leaf-green"] = createSculptMaterial(
    "leaf-green",
    {"id": "leaf-green", "name": "Plant leaf green", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#4cc95a", "color": "#4cc95a", "albedo": {"dominant": "#4cc95a", "secondary": ["#4cc95a"]}, "colorVariation": {"palette": ["#4cc95a"], "pattern": "flat", "amplitude": 0.02, "heightCorrelation": 0.0}, "roughness": {"base": 0.5, "variation": 0.04}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "", "textureless": {"declared": true, "evidence": ["Reference view: /home/divyansh-muley/Divyansh/Projects/Divi/hero-bot-workspace/refs/bot6.png shows a small plant with flat green leaves."]}},
    options
  );
  materialMap["pot-brown"] = createSculptMaterial(
    "pot-brown",
    {"id": "pot-brown", "name": "Plant pot brown", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#6b4a2b", "color": "#6b4a2b", "albedo": {"dominant": "#6b4a2b", "secondary": ["#6b4a2b"]}, "colorVariation": {"palette": ["#6b4a2b"], "pattern": "flat", "amplitude": 0.02, "heightCorrelation": 0.0}, "roughness": {"base": 0.6, "variation": 0.04}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "", "textureless": {"declared": true, "evidence": ["Reference view: /home/divyansh-muley/Divyansh/Projects/Divi/hero-bot-workspace/refs/bot6.png shows a small brown pot."]}},
    options
  );

  const nodes: Record<string, THREE.Object3D> = { root };
  const meshes: Record<string, THREE.Mesh> = {};
  const sockets: Record<string, THREE.Object3D> = {};
  const colliders: Record<string, unknown> = {};
  const destructionGroups: Record<string, THREE.Object3D[]> = {};

  const endpoint_root_0 = makeAttachmentEndpoint(null);
  const node_root_0 = new THREE.Group();
  node_root_0.name = "AI Assistant Bot (root)__pivot";
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
    ? new THREE.CylinderGeometry(endpoint_root_0.endRadius, endpoint_root_0.baseRadius, endpoint_root_0.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_root_0) {
    mesh_root_0Geometry.scale(0.001, 0.001, 0.001);
  }
  const mesh_root_0 = new THREE.Mesh(
    mesh_root_0Geometry,
    materialMap["hidden"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_root_0.name = "AI Assistant Bot (root)";
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
    ? new THREE.CylinderGeometry(endpoint_pelvis_1.endRadius, endpoint_pelvis_1.baseRadius, endpoint_pelvis_1.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_pelvis_1) {
    mesh_pelvis_1Geometry.scale(0.31118, 0.31496, 0.20787);
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

  const attachment_abdomen_2 = {"parentSocket": "pelvis-abdomen", "localStart": [0.0, 0.11969, 0.0], "localEnd": [0.0, 0.25827, 0.0063], "contactType": "rigid-weld", "baseRadius": 0.09276, "endRadius": 0.09874, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
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
    ? new THREE.CylinderGeometry(endpoint_abdomen_2.endRadius, endpoint_abdomen_2.baseRadius, endpoint_abdomen_2.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_abdomen_2) {
    mesh_abdomen_2Geometry.scale(0.18551, 0.13873, 0.18551);
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

  const attachment_chest_3 = {"parentSocket": "abdomen-chest", "localStart": [0.0, 0.13858, 0.0063], "localEnd": [0.0, 0.42205, 0.0126], "contactType": "rigid-weld", "baseRadius": 0.10772, "endRadius": 0.14362, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
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
    ? new THREE.CylinderGeometry(endpoint_chest_3.endRadius, endpoint_chest_3.baseRadius, endpoint_chest_3.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_chest_3) {
    mesh_chest_3Geometry.scale(0.21543, 0.28353, 0.21543);
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
    ? new THREE.CylinderGeometry(endpoint_neck_4.endRadius, endpoint_neck_4.baseRadius, endpoint_neck_4.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
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
    ? new THREE.CylinderGeometry(endpoint_head_5.endRadius, endpoint_head_5.baseRadius, endpoint_head_5.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.05039, "rz": 0.04409, "twist": 0.0}, {"position": [0.0, 0.0378, 0.0], "rx": 0.08189, "rz": 0.08189, "twist": 0.0}, {"position": [0.0, 0.08819, 0.0], "rx": 0.11969, "rz": 0.11969, "twist": 0.0}, {"position": [0.0, 0.15118, 0.0], "rx": 0.13858, "rz": 0.14488, "twist": 0.0}, {"position": [0.0, 0.21417, 0.0], "rx": 0.12598, "rz": 0.13228, "twist": 0.0}, {"position": [0.0, 0.25197, 0.0], "rx": 0.09449, "rz": 0.09449, "twist": 0.0}, {"position": [0.0, 0.27402, 0.0], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 24, "capEnds": true});
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
    ? new THREE.CylinderGeometry(endpoint_visor_6.endRadius, endpoint_visor_6.baseRadius, endpoint_visor_6.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.01575, "rz": 0.0315, "twist": 0.0}, {"position": [0.0, 0.0315, 0.02835], "rx": 0.01575, "rz": 0.06299, "twist": 0.0}, {"position": [0.0, 0.08819, 0.05354], "rx": 0.01575, "rz": 0.09449, "twist": 0.0}, {"position": [0.0, 0.13228, 0.05669], "rx": 0.01575, "rz": 0.09449, "twist": 0.0}, {"position": [0.0, 0.15118, 0.05039], "rx": 0.0126, "rz": 0.0378, "twist": 0.0}], "radialSegments": 20, "capEnds": true});
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

  const endpoint_visor_eye_0_7 = makeAttachmentEndpoint(null);
  const node_visor_eye_0_7 = new THREE.Group();
  node_visor_eye_0_7.name = "Visor eye 0__pivot";
  node_visor_eye_0_7.scale.set(1, 1, 1);
  if (endpoint_visor_eye_0_7) {
    node_visor_eye_0_7.position.copy(endpoint_visor_eye_0_7.start);
    node_visor_eye_0_7.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_visor_eye_0_7.position.set(-0.05354, 0.13228, 0.14173);
    node_visor_eye_0_7.rotation.set(0.0, 0.0, 0.0);
  }
  node_visor_eye_0_7.userData.sculptComponent = { id: "visor-eye-0" };
  node_visor_eye_0_7.userData.actionProfile = {};
  (nodes["head"] ?? root).add(node_visor_eye_0_7);
  nodes["visor-eye-0"] = node_visor_eye_0_7;
  const mesh_visor_eye_0_7Geometry = endpoint_visor_eye_0_7
    ? new THREE.CylinderGeometry(endpoint_visor_eye_0_7.endRadius, endpoint_visor_eye_0_7.baseRadius, endpoint_visor_eye_0_7.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_visor_eye_0_7) {
    mesh_visor_eye_0_7Geometry.scale(0.04724, 0.05354, 0.0189);
  }
  const mesh_visor_eye_0_7 = new THREE.Mesh(
    mesh_visor_eye_0_7Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_visor_eye_0_7.name = "Visor eye 0";
  if (endpoint_visor_eye_0_7) {
    mesh_visor_eye_0_7.position.copy(endpoint_visor_eye_0_7.midpoint);
    mesh_visor_eye_0_7.quaternion.copy(endpoint_visor_eye_0_7.quaternion);
  }
  mesh_visor_eye_0_7.castShadow = options.castShadow ?? true;
  mesh_visor_eye_0_7.receiveShadow = options.receiveShadow ?? true;
  mesh_visor_eye_0_7.userData.sculptComponent = { id: "visor-eye-0" };
  node_visor_eye_0_7.add(mesh_visor_eye_0_7);
  meshes["visor-eye-0"] = mesh_visor_eye_0_7;
  colliders["visor-eye-0"] = {};
  destructionGroups["head"] ??= [];
  destructionGroups["head"].push(node_visor_eye_0_7);

  const endpoint_visor_eye_1_8 = makeAttachmentEndpoint(null);
  const node_visor_eye_1_8 = new THREE.Group();
  node_visor_eye_1_8.name = "Visor eye 1__pivot";
  node_visor_eye_1_8.scale.set(1, 1, 1);
  if (endpoint_visor_eye_1_8) {
    node_visor_eye_1_8.position.copy(endpoint_visor_eye_1_8.start);
    node_visor_eye_1_8.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_visor_eye_1_8.position.set(0.05354, 0.13228, 0.14173);
    node_visor_eye_1_8.rotation.set(0.0, 0.0, 0.0);
  }
  node_visor_eye_1_8.userData.sculptComponent = { id: "visor-eye-1" };
  node_visor_eye_1_8.userData.actionProfile = {};
  (nodes["head"] ?? root).add(node_visor_eye_1_8);
  nodes["visor-eye-1"] = node_visor_eye_1_8;
  const mesh_visor_eye_1_8Geometry = endpoint_visor_eye_1_8
    ? new THREE.CylinderGeometry(endpoint_visor_eye_1_8.endRadius, endpoint_visor_eye_1_8.baseRadius, endpoint_visor_eye_1_8.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_visor_eye_1_8) {
    mesh_visor_eye_1_8Geometry.scale(0.04724, 0.05354, 0.0189);
  }
  const mesh_visor_eye_1_8 = new THREE.Mesh(
    mesh_visor_eye_1_8Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_visor_eye_1_8.name = "Visor eye 1";
  if (endpoint_visor_eye_1_8) {
    mesh_visor_eye_1_8.position.copy(endpoint_visor_eye_1_8.midpoint);
    mesh_visor_eye_1_8.quaternion.copy(endpoint_visor_eye_1_8.quaternion);
  }
  mesh_visor_eye_1_8.castShadow = options.castShadow ?? true;
  mesh_visor_eye_1_8.receiveShadow = options.receiveShadow ?? true;
  mesh_visor_eye_1_8.userData.sculptComponent = { id: "visor-eye-1" };
  node_visor_eye_1_8.add(mesh_visor_eye_1_8);
  meshes["visor-eye-1"] = mesh_visor_eye_1_8;
  colliders["visor-eye-1"] = {};
  destructionGroups["head"] ??= [];
  destructionGroups["head"].push(node_visor_eye_1_8);

  const endpoint_visor_slit_9 = makeAttachmentEndpoint(null);
  const node_visor_slit_9 = new THREE.Group();
  node_visor_slit_9.name = "Visor brow glow__pivot";
  node_visor_slit_9.scale.set(1, 1, 1);
  if (endpoint_visor_slit_9) {
    node_visor_slit_9.position.copy(endpoint_visor_slit_9.start);
    node_visor_slit_9.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_visor_slit_9.position.set(0.0, 0.18268, 0.13543);
    node_visor_slit_9.rotation.set(0.0, 0.0, 0.0);
  }
  node_visor_slit_9.userData.sculptComponent = { id: "visor-slit" };
  node_visor_slit_9.userData.actionProfile = {};
  (nodes["head"] ?? root).add(node_visor_slit_9);
  nodes["visor-slit"] = node_visor_slit_9;
  const mesh_visor_slit_9Geometry = endpoint_visor_slit_9
    ? new THREE.CylinderGeometry(endpoint_visor_slit_9.endRadius, endpoint_visor_slit_9.baseRadius, endpoint_visor_slit_9.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_visor_slit_9) {
    mesh_visor_slit_9Geometry.scale(0.10709, 0.0126, 0.0126);
  }
  const mesh_visor_slit_9 = new THREE.Mesh(
    mesh_visor_slit_9Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_visor_slit_9.name = "Visor brow glow";
  if (endpoint_visor_slit_9) {
    mesh_visor_slit_9.position.copy(endpoint_visor_slit_9.midpoint);
    mesh_visor_slit_9.quaternion.copy(endpoint_visor_slit_9.quaternion);
  }
  mesh_visor_slit_9.castShadow = options.castShadow ?? true;
  mesh_visor_slit_9.receiveShadow = options.receiveShadow ?? true;
  mesh_visor_slit_9.userData.sculptComponent = { id: "visor-slit" };
  node_visor_slit_9.add(mesh_visor_slit_9);
  meshes["visor-slit"] = mesh_visor_slit_9;
  colliders["visor-slit"] = {};
  destructionGroups["head"] ??= [];
  destructionGroups["head"].push(node_visor_slit_9);

  const attachment_ear_pod_l_10 = {"parentSocket": "head-ear-pod-l", "localStart": [0.10394, 0.14488, 0.0], "localEnd": [0.13543, 0.14488, 0.0], "contactType": "rigid-weld", "baseRadius": 0.02835, "endRadius": 0.02835, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_ear_pod_l_10 = makeAttachmentEndpoint(attachment_ear_pod_l_10);
  const node_ear_pod_l_10 = new THREE.Group();
  node_ear_pod_l_10.name = "Ear pod L__pivot";
  node_ear_pod_l_10.scale.set(1, 1, 1);
  if (endpoint_ear_pod_l_10) {
    node_ear_pod_l_10.position.copy(endpoint_ear_pod_l_10.start);
    node_ear_pod_l_10.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_ear_pod_l_10.position.set(0.10394, 0.14488, 0.0);
    node_ear_pod_l_10.rotation.set(0.0, 0.0, 0.0);
  }
  node_ear_pod_l_10.userData.sculptComponent = { id: "ear-pod-l" };
  node_ear_pod_l_10.userData.actionProfile = {};
  (nodes["head"] ?? root).add(node_ear_pod_l_10);
  nodes["ear-pod-l"] = node_ear_pod_l_10;
  const mesh_ear_pod_l_10Geometry = endpoint_ear_pod_l_10
    ? new THREE.CylinderGeometry(endpoint_ear_pod_l_10.endRadius, endpoint_ear_pod_l_10.baseRadius, endpoint_ear_pod_l_10.length, 8, 4)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 10, 4);
  if (!endpoint_ear_pod_l_10) {
    mesh_ear_pod_l_10Geometry.scale(0.05669, 0.0315, 0.05669);
  }
  const mesh_ear_pod_l_10 = new THREE.Mesh(
    mesh_ear_pod_l_10Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ear_pod_l_10.name = "Ear pod L";
  if (endpoint_ear_pod_l_10) {
    mesh_ear_pod_l_10.position.copy(endpoint_ear_pod_l_10.midpoint);
    mesh_ear_pod_l_10.quaternion.copy(endpoint_ear_pod_l_10.quaternion);
  }
  mesh_ear_pod_l_10.castShadow = options.castShadow ?? true;
  mesh_ear_pod_l_10.receiveShadow = options.receiveShadow ?? true;
  mesh_ear_pod_l_10.userData.sculptComponent = { id: "ear-pod-l" };
  node_ear_pod_l_10.add(mesh_ear_pod_l_10);
  meshes["ear-pod-l"] = mesh_ear_pod_l_10;
  colliders["ear-pod-l"] = {};
  destructionGroups["head"] ??= [];
  destructionGroups["head"].push(node_ear_pod_l_10);

  const endpoint_ear_pod_ring_l_11 = makeAttachmentEndpoint(null);
  const node_ear_pod_ring_l_11 = new THREE.Group();
  node_ear_pod_ring_l_11.name = "Ear pod ring L__pivot";
  node_ear_pod_ring_l_11.scale.set(1, 1, 1);
  if (endpoint_ear_pod_ring_l_11) {
    node_ear_pod_ring_l_11.position.copy(endpoint_ear_pod_ring_l_11.start);
    node_ear_pod_ring_l_11.rotation.set(0.0, 1.5708, 0.0);
  } else {
    node_ear_pod_ring_l_11.position.set(0.13701, 0.14488, 0.0);
    node_ear_pod_ring_l_11.rotation.set(0.0, 1.5708, 0.0);
  }
  node_ear_pod_ring_l_11.userData.sculptComponent = { id: "ear-pod-ring-l" };
  node_ear_pod_ring_l_11.userData.actionProfile = {};
  (nodes["head"] ?? root).add(node_ear_pod_ring_l_11);
  nodes["ear-pod-ring-l"] = node_ear_pod_ring_l_11;
  const mesh_ear_pod_ring_l_11Geometry = endpoint_ear_pod_ring_l_11
    ? new THREE.CylinderGeometry(endpoint_ear_pod_ring_l_11.endRadius, endpoint_ear_pod_ring_l_11.baseRadius, endpoint_ear_pod_ring_l_11.length, 8, 4)
    : new THREE.TorusGeometry(0.45, 0.09, 8, 16);
  if (!endpoint_ear_pod_ring_l_11) {
    mesh_ear_pod_ring_l_11Geometry.scale(0.06299, 0.06299, 0.06299);
  }
  const mesh_ear_pod_ring_l_11 = new THREE.Mesh(
    mesh_ear_pod_ring_l_11Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ear_pod_ring_l_11.name = "Ear pod ring L";
  if (endpoint_ear_pod_ring_l_11) {
    mesh_ear_pod_ring_l_11.position.copy(endpoint_ear_pod_ring_l_11.midpoint);
    mesh_ear_pod_ring_l_11.quaternion.copy(endpoint_ear_pod_ring_l_11.quaternion);
  }
  mesh_ear_pod_ring_l_11.castShadow = options.castShadow ?? true;
  mesh_ear_pod_ring_l_11.receiveShadow = options.receiveShadow ?? true;
  mesh_ear_pod_ring_l_11.userData.sculptComponent = { id: "ear-pod-ring-l" };
  node_ear_pod_ring_l_11.add(mesh_ear_pod_ring_l_11);
  meshes["ear-pod-ring-l"] = mesh_ear_pod_ring_l_11;
  colliders["ear-pod-ring-l"] = {};
  destructionGroups["head"] ??= [];
  destructionGroups["head"].push(node_ear_pod_ring_l_11);

  const attachment_ear_pod_r_12 = {"parentSocket": "head-ear-pod-r", "localStart": [-0.10394, 0.14488, 0.0], "localEnd": [-0.13543, 0.14488, 0.0], "contactType": "rigid-weld", "baseRadius": 0.02835, "endRadius": 0.02835, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_ear_pod_r_12 = makeAttachmentEndpoint(attachment_ear_pod_r_12);
  const node_ear_pod_r_12 = new THREE.Group();
  node_ear_pod_r_12.name = "Ear pod R__pivot";
  node_ear_pod_r_12.scale.set(1, 1, 1);
  if (endpoint_ear_pod_r_12) {
    node_ear_pod_r_12.position.copy(endpoint_ear_pod_r_12.start);
    node_ear_pod_r_12.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_ear_pod_r_12.position.set(-0.10394, 0.14488, 0.0);
    node_ear_pod_r_12.rotation.set(0.0, 0.0, 0.0);
  }
  node_ear_pod_r_12.userData.sculptComponent = { id: "ear-pod-r" };
  node_ear_pod_r_12.userData.actionProfile = {};
  (nodes["head"] ?? root).add(node_ear_pod_r_12);
  nodes["ear-pod-r"] = node_ear_pod_r_12;
  const mesh_ear_pod_r_12Geometry = endpoint_ear_pod_r_12
    ? new THREE.CylinderGeometry(endpoint_ear_pod_r_12.endRadius, endpoint_ear_pod_r_12.baseRadius, endpoint_ear_pod_r_12.length, 8, 4)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 10, 4);
  if (!endpoint_ear_pod_r_12) {
    mesh_ear_pod_r_12Geometry.scale(0.05669, 0.0315, 0.05669);
  }
  const mesh_ear_pod_r_12 = new THREE.Mesh(
    mesh_ear_pod_r_12Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ear_pod_r_12.name = "Ear pod R";
  if (endpoint_ear_pod_r_12) {
    mesh_ear_pod_r_12.position.copy(endpoint_ear_pod_r_12.midpoint);
    mesh_ear_pod_r_12.quaternion.copy(endpoint_ear_pod_r_12.quaternion);
  }
  mesh_ear_pod_r_12.castShadow = options.castShadow ?? true;
  mesh_ear_pod_r_12.receiveShadow = options.receiveShadow ?? true;
  mesh_ear_pod_r_12.userData.sculptComponent = { id: "ear-pod-r" };
  node_ear_pod_r_12.add(mesh_ear_pod_r_12);
  meshes["ear-pod-r"] = mesh_ear_pod_r_12;
  colliders["ear-pod-r"] = {};
  destructionGroups["head"] ??= [];
  destructionGroups["head"].push(node_ear_pod_r_12);

  const endpoint_ear_pod_ring_r_13 = makeAttachmentEndpoint(null);
  const node_ear_pod_ring_r_13 = new THREE.Group();
  node_ear_pod_ring_r_13.name = "Ear pod ring R__pivot";
  node_ear_pod_ring_r_13.scale.set(1, 1, 1);
  if (endpoint_ear_pod_ring_r_13) {
    node_ear_pod_ring_r_13.position.copy(endpoint_ear_pod_ring_r_13.start);
    node_ear_pod_ring_r_13.rotation.set(0.0, 1.5708, 0.0);
  } else {
    node_ear_pod_ring_r_13.position.set(-0.13701, 0.14488, 0.0);
    node_ear_pod_ring_r_13.rotation.set(0.0, 1.5708, 0.0);
  }
  node_ear_pod_ring_r_13.userData.sculptComponent = { id: "ear-pod-ring-r" };
  node_ear_pod_ring_r_13.userData.actionProfile = {};
  (nodes["head"] ?? root).add(node_ear_pod_ring_r_13);
  nodes["ear-pod-ring-r"] = node_ear_pod_ring_r_13;
  const mesh_ear_pod_ring_r_13Geometry = endpoint_ear_pod_ring_r_13
    ? new THREE.CylinderGeometry(endpoint_ear_pod_ring_r_13.endRadius, endpoint_ear_pod_ring_r_13.baseRadius, endpoint_ear_pod_ring_r_13.length, 8, 4)
    : new THREE.TorusGeometry(0.45, 0.09, 8, 16);
  if (!endpoint_ear_pod_ring_r_13) {
    mesh_ear_pod_ring_r_13Geometry.scale(0.06299, 0.06299, 0.06299);
  }
  const mesh_ear_pod_ring_r_13 = new THREE.Mesh(
    mesh_ear_pod_ring_r_13Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ear_pod_ring_r_13.name = "Ear pod ring R";
  if (endpoint_ear_pod_ring_r_13) {
    mesh_ear_pod_ring_r_13.position.copy(endpoint_ear_pod_ring_r_13.midpoint);
    mesh_ear_pod_ring_r_13.quaternion.copy(endpoint_ear_pod_ring_r_13.quaternion);
  }
  mesh_ear_pod_ring_r_13.castShadow = options.castShadow ?? true;
  mesh_ear_pod_ring_r_13.receiveShadow = options.receiveShadow ?? true;
  mesh_ear_pod_ring_r_13.userData.sculptComponent = { id: "ear-pod-ring-r" };
  node_ear_pod_ring_r_13.add(mesh_ear_pod_ring_r_13);
  meshes["ear-pod-ring-r"] = mesh_ear_pod_ring_r_13;
  colliders["ear-pod-ring-r"] = {};
  destructionGroups["head"] ??= [];
  destructionGroups["head"].push(node_ear_pod_ring_r_13);

  const endpoint_head_band_14 = makeAttachmentEndpoint(null);
  const node_head_band_14 = new THREE.Group();
  node_head_band_14.name = "Helmet band__pivot";
  node_head_band_14.scale.set(1, 1, 1);
  if (endpoint_head_band_14) {
    node_head_band_14.position.copy(endpoint_head_band_14.start);
    node_head_band_14.rotation.set(1.5708, 0.0, 0.0);
  } else {
    node_head_band_14.position.set(0.0, 0.18268, 0.0);
    node_head_band_14.rotation.set(1.5708, 0.0, 0.0);
  }
  node_head_band_14.userData.sculptComponent = { id: "head-band" };
  node_head_band_14.userData.actionProfile = {};
  (nodes["head"] ?? root).add(node_head_band_14);
  nodes["head-band"] = node_head_band_14;
  const mesh_head_band_14Geometry = endpoint_head_band_14
    ? new THREE.CylinderGeometry(endpoint_head_band_14.endRadius, endpoint_head_band_14.baseRadius, endpoint_head_band_14.length, 8, 4)
    : new THREE.TorusGeometry(0.45, 0.0198, 8, 16);
  if (!endpoint_head_band_14) {
    mesh_head_band_14Geometry.scale(0.28696, 0.28696, 0.28696);
  }
  const mesh_head_band_14 = new THREE.Mesh(
    mesh_head_band_14Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_head_band_14.name = "Helmet band";
  if (endpoint_head_band_14) {
    mesh_head_band_14.position.copy(endpoint_head_band_14.midpoint);
    mesh_head_band_14.quaternion.copy(endpoint_head_band_14.quaternion);
  }
  mesh_head_band_14.castShadow = options.castShadow ?? true;
  mesh_head_band_14.receiveShadow = options.receiveShadow ?? true;
  mesh_head_band_14.userData.sculptComponent = { id: "head-band" };
  node_head_band_14.add(mesh_head_band_14);
  meshes["head-band"] = mesh_head_band_14;
  colliders["head-band"] = {};
  destructionGroups["head"] ??= [];
  destructionGroups["head"].push(node_head_band_14);

  const endpoint_chest_shell_l_15 = makeAttachmentEndpoint(null);
  const node_chest_shell_l_15 = new THREE.Group();
  node_chest_shell_l_15.name = "Chest shell L__pivot";
  node_chest_shell_l_15.scale.set(1, 1, 1);
  if (endpoint_chest_shell_l_15) {
    node_chest_shell_l_15.position.copy(endpoint_chest_shell_l_15.start);
    node_chest_shell_l_15.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_chest_shell_l_15.position.set(0.13764, 0.27717, 0.0378);
    node_chest_shell_l_15.rotation.set(0.0, 0.0, 0.0);
  }
  node_chest_shell_l_15.userData.sculptComponent = { id: "chest-shell-l" };
  node_chest_shell_l_15.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_chest_shell_l_15);
  nodes["chest-shell-l"] = node_chest_shell_l_15;
  const mesh_chest_shell_l_15Geometry = endpoint_chest_shell_l_15
    ? new THREE.CylinderGeometry(endpoint_chest_shell_l_15.endRadius, endpoint_chest_shell_l_15.baseRadius, endpoint_chest_shell_l_15.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.04409, "rz": 0.06583, "twist": 0.0}, {"position": [-0.01795, -0.06929, 0.0315], "rx": 0.06299, "rz": 0.0778, "twist": 0.0}, {"position": [-0.04787, -0.17008, 0.04409], "rx": 0.06299, "rz": 0.06583, "twist": 0.0}, {"position": [-0.07181, -0.26457, 0.0378], "rx": 0.0378, "rz": 0.03591, "twist": 0.0}], "radialSegments": 20, "capEnds": true});
  if (!endpoint_chest_shell_l_15) {
    mesh_chest_shell_l_15Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_chest_shell_l_15 = new THREE.Mesh(
    mesh_chest_shell_l_15Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_chest_shell_l_15.name = "Chest shell L";
  if (endpoint_chest_shell_l_15) {
    mesh_chest_shell_l_15.position.copy(endpoint_chest_shell_l_15.midpoint);
    mesh_chest_shell_l_15.quaternion.copy(endpoint_chest_shell_l_15.quaternion);
  }
  mesh_chest_shell_l_15.castShadow = options.castShadow ?? true;
  mesh_chest_shell_l_15.receiveShadow = options.receiveShadow ?? true;
  mesh_chest_shell_l_15.userData.sculptComponent = { id: "chest-shell-l" };
  node_chest_shell_l_15.add(mesh_chest_shell_l_15);
  meshes["chest-shell-l"] = mesh_chest_shell_l_15;
  colliders["chest-shell-l"] = {};
  destructionGroups["torso"] ??= [];
  destructionGroups["torso"].push(node_chest_shell_l_15);

  const endpoint_chest_shell_back_l_16 = makeAttachmentEndpoint(null);
  const node_chest_shell_back_l_16 = new THREE.Group();
  node_chest_shell_back_l_16.name = "Back shell L (inferred)__pivot";
  node_chest_shell_back_l_16.scale.set(1, 1, 1);
  if (endpoint_chest_shell_back_l_16) {
    node_chest_shell_back_l_16.position.copy(endpoint_chest_shell_back_l_16.start);
    node_chest_shell_back_l_16.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_chest_shell_back_l_16.position.set(0.13764, 0.27717, -0.05039);
    node_chest_shell_back_l_16.rotation.set(0.0, 0.0, 0.0);
  }
  node_chest_shell_back_l_16.userData.sculptComponent = { id: "chest-shell-back-l" };
  node_chest_shell_back_l_16.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_chest_shell_back_l_16);
  nodes["chest-shell-back-l"] = node_chest_shell_back_l_16;
  const mesh_chest_shell_back_l_16Geometry = endpoint_chest_shell_back_l_16
    ? new THREE.CylinderGeometry(endpoint_chest_shell_back_l_16.endRadius, endpoint_chest_shell_back_l_16.baseRadius, endpoint_chest_shell_back_l_16.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.04409, "rz": 0.06583, "twist": 0.0}, {"position": [-0.01795, -0.06929, -0.0315], "rx": 0.06299, "rz": 0.0778, "twist": 0.0}, {"position": [-0.04787, -0.17008, -0.04409], "rx": 0.06299, "rz": 0.06583, "twist": 0.0}, {"position": [-0.07181, -0.26457, -0.0378], "rx": 0.0378, "rz": 0.03591, "twist": 0.0}], "radialSegments": 20, "capEnds": true});
  if (!endpoint_chest_shell_back_l_16) {
    mesh_chest_shell_back_l_16Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_chest_shell_back_l_16 = new THREE.Mesh(
    mesh_chest_shell_back_l_16Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_chest_shell_back_l_16.name = "Back shell L (inferred)";
  if (endpoint_chest_shell_back_l_16) {
    mesh_chest_shell_back_l_16.position.copy(endpoint_chest_shell_back_l_16.midpoint);
    mesh_chest_shell_back_l_16.quaternion.copy(endpoint_chest_shell_back_l_16.quaternion);
  }
  mesh_chest_shell_back_l_16.castShadow = options.castShadow ?? true;
  mesh_chest_shell_back_l_16.receiveShadow = options.receiveShadow ?? true;
  mesh_chest_shell_back_l_16.userData.sculptComponent = { id: "chest-shell-back-l" };
  node_chest_shell_back_l_16.add(mesh_chest_shell_back_l_16);
  meshes["chest-shell-back-l"] = mesh_chest_shell_back_l_16;
  colliders["chest-shell-back-l"] = {};
  destructionGroups["torso"] ??= [];
  destructionGroups["torso"].push(node_chest_shell_back_l_16);

  const endpoint_chest_lower_l_17 = makeAttachmentEndpoint(null);
  const node_chest_lower_l_17 = new THREE.Group();
  node_chest_lower_l_17.name = "Lower chest plate L__pivot";
  node_chest_lower_l_17.scale.set(1, 1, 1);
  if (endpoint_chest_lower_l_17) {
    node_chest_lower_l_17.position.copy(endpoint_chest_lower_l_17.start);
    node_chest_lower_l_17.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_chest_lower_l_17.position.set(0.07181, 0.06929, 0.08819);
    node_chest_lower_l_17.rotation.set(0.0, 0.0, 0.0);
  }
  node_chest_lower_l_17.userData.sculptComponent = { id: "chest-lower-l" };
  node_chest_lower_l_17.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_chest_lower_l_17);
  nodes["chest-lower-l"] = node_chest_lower_l_17;
  const mesh_chest_lower_l_17Geometry = endpoint_chest_lower_l_17
    ? new THREE.CylinderGeometry(endpoint_chest_lower_l_17.endRadius, endpoint_chest_lower_l_17.baseRadius, endpoint_chest_lower_l_17.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.0189, "rz": 0.0189, "twist": 0.0}, {"position": [-0.01795, -0.08819, 0.00315], "rx": 0.0315, "rz": 0.0378, "twist": 0.0}, {"position": [-0.04189, -0.17638, -0.00945], "rx": 0.0126, "rz": 0.00945, "twist": 0.0}], "radialSegments": 16, "capEnds": true});
  if (!endpoint_chest_lower_l_17) {
    mesh_chest_lower_l_17Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_chest_lower_l_17 = new THREE.Mesh(
    mesh_chest_lower_l_17Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_chest_lower_l_17.name = "Lower chest plate L";
  if (endpoint_chest_lower_l_17) {
    mesh_chest_lower_l_17.position.copy(endpoint_chest_lower_l_17.midpoint);
    mesh_chest_lower_l_17.quaternion.copy(endpoint_chest_lower_l_17.quaternion);
  }
  mesh_chest_lower_l_17.castShadow = options.castShadow ?? true;
  mesh_chest_lower_l_17.receiveShadow = options.receiveShadow ?? true;
  mesh_chest_lower_l_17.userData.sculptComponent = { id: "chest-lower-l" };
  node_chest_lower_l_17.add(mesh_chest_lower_l_17);
  meshes["chest-lower-l"] = mesh_chest_lower_l_17;
  colliders["chest-lower-l"] = {};
  destructionGroups["torso"] ??= [];
  destructionGroups["torso"].push(node_chest_lower_l_17);

  const endpoint_chest_shell_r_18 = makeAttachmentEndpoint(null);
  const node_chest_shell_r_18 = new THREE.Group();
  node_chest_shell_r_18.name = "Chest shell R__pivot";
  node_chest_shell_r_18.scale.set(1, 1, 1);
  if (endpoint_chest_shell_r_18) {
    node_chest_shell_r_18.position.copy(endpoint_chest_shell_r_18.start);
    node_chest_shell_r_18.rotation.set(0.0, -0.0, 0.0);
  } else {
    node_chest_shell_r_18.position.set(-0.13764, 0.27717, 0.0378);
    node_chest_shell_r_18.rotation.set(0.0, -0.0, 0.0);
  }
  node_chest_shell_r_18.userData.sculptComponent = { id: "chest-shell-r" };
  node_chest_shell_r_18.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_chest_shell_r_18);
  nodes["chest-shell-r"] = node_chest_shell_r_18;
  const mesh_chest_shell_r_18Geometry = endpoint_chest_shell_r_18
    ? new THREE.CylinderGeometry(endpoint_chest_shell_r_18.endRadius, endpoint_chest_shell_r_18.baseRadius, endpoint_chest_shell_r_18.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.04409, "rz": 0.06583, "twist": 0.0}, {"position": [0.01795, -0.06929, 0.0315], "rx": 0.06299, "rz": 0.0778, "twist": 0.0}, {"position": [0.04787, -0.17008, 0.04409], "rx": 0.06299, "rz": 0.06583, "twist": 0.0}, {"position": [0.07181, -0.26457, 0.0378], "rx": 0.0378, "rz": 0.03591, "twist": 0.0}], "radialSegments": 20, "capEnds": true});
  if (!endpoint_chest_shell_r_18) {
    mesh_chest_shell_r_18Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_chest_shell_r_18 = new THREE.Mesh(
    mesh_chest_shell_r_18Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_chest_shell_r_18.name = "Chest shell R";
  if (endpoint_chest_shell_r_18) {
    mesh_chest_shell_r_18.position.copy(endpoint_chest_shell_r_18.midpoint);
    mesh_chest_shell_r_18.quaternion.copy(endpoint_chest_shell_r_18.quaternion);
  }
  mesh_chest_shell_r_18.castShadow = options.castShadow ?? true;
  mesh_chest_shell_r_18.receiveShadow = options.receiveShadow ?? true;
  mesh_chest_shell_r_18.userData.sculptComponent = { id: "chest-shell-r" };
  node_chest_shell_r_18.add(mesh_chest_shell_r_18);
  meshes["chest-shell-r"] = mesh_chest_shell_r_18;
  colliders["chest-shell-r"] = {};
  destructionGroups["torso"] ??= [];
  destructionGroups["torso"].push(node_chest_shell_r_18);

  const endpoint_chest_shell_back_r_19 = makeAttachmentEndpoint(null);
  const node_chest_shell_back_r_19 = new THREE.Group();
  node_chest_shell_back_r_19.name = "Back shell R (inferred)__pivot";
  node_chest_shell_back_r_19.scale.set(1, 1, 1);
  if (endpoint_chest_shell_back_r_19) {
    node_chest_shell_back_r_19.position.copy(endpoint_chest_shell_back_r_19.start);
    node_chest_shell_back_r_19.rotation.set(0.0, -0.0, 0.0);
  } else {
    node_chest_shell_back_r_19.position.set(-0.13764, 0.27717, -0.05039);
    node_chest_shell_back_r_19.rotation.set(0.0, -0.0, 0.0);
  }
  node_chest_shell_back_r_19.userData.sculptComponent = { id: "chest-shell-back-r" };
  node_chest_shell_back_r_19.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_chest_shell_back_r_19);
  nodes["chest-shell-back-r"] = node_chest_shell_back_r_19;
  const mesh_chest_shell_back_r_19Geometry = endpoint_chest_shell_back_r_19
    ? new THREE.CylinderGeometry(endpoint_chest_shell_back_r_19.endRadius, endpoint_chest_shell_back_r_19.baseRadius, endpoint_chest_shell_back_r_19.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.04409, "rz": 0.06583, "twist": 0.0}, {"position": [0.01795, -0.06929, -0.0315], "rx": 0.06299, "rz": 0.0778, "twist": 0.0}, {"position": [0.04787, -0.17008, -0.04409], "rx": 0.06299, "rz": 0.06583, "twist": 0.0}, {"position": [0.07181, -0.26457, -0.0378], "rx": 0.0378, "rz": 0.03591, "twist": 0.0}], "radialSegments": 20, "capEnds": true});
  if (!endpoint_chest_shell_back_r_19) {
    mesh_chest_shell_back_r_19Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_chest_shell_back_r_19 = new THREE.Mesh(
    mesh_chest_shell_back_r_19Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_chest_shell_back_r_19.name = "Back shell R (inferred)";
  if (endpoint_chest_shell_back_r_19) {
    mesh_chest_shell_back_r_19.position.copy(endpoint_chest_shell_back_r_19.midpoint);
    mesh_chest_shell_back_r_19.quaternion.copy(endpoint_chest_shell_back_r_19.quaternion);
  }
  mesh_chest_shell_back_r_19.castShadow = options.castShadow ?? true;
  mesh_chest_shell_back_r_19.receiveShadow = options.receiveShadow ?? true;
  mesh_chest_shell_back_r_19.userData.sculptComponent = { id: "chest-shell-back-r" };
  node_chest_shell_back_r_19.add(mesh_chest_shell_back_r_19);
  meshes["chest-shell-back-r"] = mesh_chest_shell_back_r_19;
  colliders["chest-shell-back-r"] = {};
  destructionGroups["torso"] ??= [];
  destructionGroups["torso"].push(node_chest_shell_back_r_19);

  const endpoint_chest_lower_r_20 = makeAttachmentEndpoint(null);
  const node_chest_lower_r_20 = new THREE.Group();
  node_chest_lower_r_20.name = "Lower chest plate R__pivot";
  node_chest_lower_r_20.scale.set(1, 1, 1);
  if (endpoint_chest_lower_r_20) {
    node_chest_lower_r_20.position.copy(endpoint_chest_lower_r_20.start);
    node_chest_lower_r_20.rotation.set(0.0, -0.0, 0.0);
  } else {
    node_chest_lower_r_20.position.set(-0.07181, 0.06929, 0.08819);
    node_chest_lower_r_20.rotation.set(0.0, -0.0, 0.0);
  }
  node_chest_lower_r_20.userData.sculptComponent = { id: "chest-lower-r" };
  node_chest_lower_r_20.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_chest_lower_r_20);
  nodes["chest-lower-r"] = node_chest_lower_r_20;
  const mesh_chest_lower_r_20Geometry = endpoint_chest_lower_r_20
    ? new THREE.CylinderGeometry(endpoint_chest_lower_r_20.endRadius, endpoint_chest_lower_r_20.baseRadius, endpoint_chest_lower_r_20.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.0189, "rz": 0.0189, "twist": 0.0}, {"position": [0.01795, -0.08819, 0.00315], "rx": 0.0315, "rz": 0.0378, "twist": 0.0}, {"position": [0.04189, -0.17638, -0.00945], "rx": 0.0126, "rz": 0.00945, "twist": 0.0}], "radialSegments": 16, "capEnds": true});
  if (!endpoint_chest_lower_r_20) {
    mesh_chest_lower_r_20Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_chest_lower_r_20 = new THREE.Mesh(
    mesh_chest_lower_r_20Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_chest_lower_r_20.name = "Lower chest plate R";
  if (endpoint_chest_lower_r_20) {
    mesh_chest_lower_r_20.position.copy(endpoint_chest_lower_r_20.midpoint);
    mesh_chest_lower_r_20.quaternion.copy(endpoint_chest_lower_r_20.quaternion);
  }
  mesh_chest_lower_r_20.castShadow = options.castShadow ?? true;
  mesh_chest_lower_r_20.receiveShadow = options.receiveShadow ?? true;
  mesh_chest_lower_r_20.userData.sculptComponent = { id: "chest-lower-r" };
  node_chest_lower_r_20.add(mesh_chest_lower_r_20);
  meshes["chest-lower-r"] = mesh_chest_lower_r_20;
  colliders["chest-lower-r"] = {};
  destructionGroups["torso"] ??= [];
  destructionGroups["torso"].push(node_chest_lower_r_20);

  const attachment_emblem_disc_21 = {"parentSocket": "chest-emblem-disc", "localStart": [0.0, 0.14488, 0.13071], "localEnd": [0.0, 0.14488, 0.14646], "contactType": "rigid-weld", "baseRadius": 0.06929, "endRadius": 0.06929, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_emblem_disc_21 = makeAttachmentEndpoint(attachment_emblem_disc_21);
  const node_emblem_disc_21 = new THREE.Group();
  node_emblem_disc_21.name = "Emblem disc__pivot";
  node_emblem_disc_21.scale.set(1, 1, 1);
  if (endpoint_emblem_disc_21) {
    node_emblem_disc_21.position.copy(endpoint_emblem_disc_21.start);
    node_emblem_disc_21.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_emblem_disc_21.position.set(0.0, 0.14488, 0.13071);
    node_emblem_disc_21.rotation.set(0.0, 0.0, 0.0);
  }
  node_emblem_disc_21.userData.sculptComponent = { id: "emblem-disc" };
  node_emblem_disc_21.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_emblem_disc_21);
  nodes["emblem-disc"] = node_emblem_disc_21;
  const mesh_emblem_disc_21Geometry = endpoint_emblem_disc_21
    ? new THREE.CylinderGeometry(endpoint_emblem_disc_21.endRadius, endpoint_emblem_disc_21.baseRadius, endpoint_emblem_disc_21.length, 8, 4)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 10, 4);
  if (!endpoint_emblem_disc_21) {
    mesh_emblem_disc_21Geometry.scale(0.13858, 0.01575, 0.13858);
  }
  const mesh_emblem_disc_21 = new THREE.Mesh(
    mesh_emblem_disc_21Geometry,
    materialMap["emblem-disc-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_emblem_disc_21.name = "Emblem disc";
  if (endpoint_emblem_disc_21) {
    mesh_emblem_disc_21.position.copy(endpoint_emblem_disc_21.midpoint);
    mesh_emblem_disc_21.quaternion.copy(endpoint_emblem_disc_21.quaternion);
  }
  mesh_emblem_disc_21.castShadow = options.castShadow ?? true;
  mesh_emblem_disc_21.receiveShadow = options.receiveShadow ?? true;
  mesh_emblem_disc_21.userData.sculptComponent = { id: "emblem-disc" };
  node_emblem_disc_21.add(mesh_emblem_disc_21);
  meshes["emblem-disc"] = mesh_emblem_disc_21;
  colliders["emblem-disc"] = {};
  destructionGroups["torso"] ??= [];
  destructionGroups["torso"].push(node_emblem_disc_21);

  const endpoint_emblem_ring_22 = makeAttachmentEndpoint(null);
  const node_emblem_ring_22 = new THREE.Group();
  node_emblem_ring_22.name = "Emblem ring__pivot";
  node_emblem_ring_22.scale.set(1, 1, 1);
  if (endpoint_emblem_ring_22) {
    node_emblem_ring_22.position.copy(endpoint_emblem_ring_22.start);
    node_emblem_ring_22.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_emblem_ring_22.position.set(0.0, 0.14488, 0.14646);
    node_emblem_ring_22.rotation.set(0.0, 0.0, 0.0);
  }
  node_emblem_ring_22.userData.sculptComponent = { id: "emblem-ring" };
  node_emblem_ring_22.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_emblem_ring_22);
  nodes["emblem-ring"] = node_emblem_ring_22;
  const mesh_emblem_ring_22Geometry = endpoint_emblem_ring_22
    ? new THREE.CylinderGeometry(endpoint_emblem_ring_22.endRadius, endpoint_emblem_ring_22.baseRadius, endpoint_emblem_ring_22.length, 8, 4)
    : new THREE.TorusGeometry(0.45, 0.0514, 8, 16);
  if (!endpoint_emblem_ring_22) {
    mesh_emblem_ring_22Geometry.scale(0.14698, 0.14698, 0.14698);
  }
  const mesh_emblem_ring_22 = new THREE.Mesh(
    mesh_emblem_ring_22Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_emblem_ring_22.name = "Emblem ring";
  if (endpoint_emblem_ring_22) {
    mesh_emblem_ring_22.position.copy(endpoint_emblem_ring_22.midpoint);
    mesh_emblem_ring_22.quaternion.copy(endpoint_emblem_ring_22.quaternion);
  }
  mesh_emblem_ring_22.castShadow = options.castShadow ?? true;
  mesh_emblem_ring_22.receiveShadow = options.receiveShadow ?? true;
  mesh_emblem_ring_22.userData.sculptComponent = { id: "emblem-ring" };
  node_emblem_ring_22.add(mesh_emblem_ring_22);
  meshes["emblem-ring"] = mesh_emblem_ring_22;
  colliders["emblem-ring"] = {};
  destructionGroups["torso"] ??= [];
  destructionGroups["torso"].push(node_emblem_ring_22);

  const endpoint_emblem_letter_a_23 = makeAttachmentEndpoint(null);
  const node_emblem_letter_a_23 = new THREE.Group();
  node_emblem_letter_a_23.name = "Emblem letter A__pivot";
  node_emblem_letter_a_23.scale.set(1, 1, 1);
  if (endpoint_emblem_letter_a_23) {
    node_emblem_letter_a_23.position.copy(endpoint_emblem_letter_a_23.start);
    node_emblem_letter_a_23.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_emblem_letter_a_23.position.set(-0.01575, 0.14488, 0.14961);
    node_emblem_letter_a_23.rotation.set(0.0, 0.0, 0.0);
  }
  node_emblem_letter_a_23.userData.sculptComponent = { id: "emblem-letter-a" };
  node_emblem_letter_a_23.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_emblem_letter_a_23);
  nodes["emblem-letter-a"] = node_emblem_letter_a_23;
  const mesh_emblem_letter_a_23Geometry = endpoint_emblem_letter_a_23
    ? new THREE.CylinderGeometry(endpoint_emblem_letter_a_23.endRadius, endpoint_emblem_letter_a_23.baseRadius, endpoint_emblem_letter_a_23.length, 8, 4)
    : buildExtrudeGeometry({"points": [[-0.02016, -0.0252], [-0.01008, -0.0252], [-0.00706, -0.01386], [0.00706, -0.01386], [0.01008, -0.0252], [0.02016, -0.0252], [0.00706, 0.0252], [-0.00706, 0.0252]], "holes": [[[-0.00454, 0.00126], [0.00454, 0.00126], [0.0, 0.01512]]], "depth": 0.00945});
  if (!endpoint_emblem_letter_a_23) {
    mesh_emblem_letter_a_23Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_emblem_letter_a_23 = new THREE.Mesh(
    mesh_emblem_letter_a_23Geometry,
    materialMap["emblem-white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_emblem_letter_a_23.name = "Emblem letter A";
  if (endpoint_emblem_letter_a_23) {
    mesh_emblem_letter_a_23.position.copy(endpoint_emblem_letter_a_23.midpoint);
    mesh_emblem_letter_a_23.quaternion.copy(endpoint_emblem_letter_a_23.quaternion);
  }
  mesh_emblem_letter_a_23.castShadow = options.castShadow ?? true;
  mesh_emblem_letter_a_23.receiveShadow = options.receiveShadow ?? true;
  mesh_emblem_letter_a_23.userData.sculptComponent = { id: "emblem-letter-a" };
  node_emblem_letter_a_23.add(mesh_emblem_letter_a_23);
  meshes["emblem-letter-a"] = mesh_emblem_letter_a_23;
  colliders["emblem-letter-a"] = {};
  destructionGroups["torso"] ??= [];
  destructionGroups["torso"].push(node_emblem_letter_a_23);

  const endpoint_emblem_letter_i_24 = makeAttachmentEndpoint(null);
  const node_emblem_letter_i_24 = new THREE.Group();
  node_emblem_letter_i_24.name = "Emblem letter I__pivot";
  node_emblem_letter_i_24.scale.set(1, 1, 1);
  if (endpoint_emblem_letter_i_24) {
    node_emblem_letter_i_24.position.copy(endpoint_emblem_letter_i_24.start);
    node_emblem_letter_i_24.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_emblem_letter_i_24.position.set(0.0252, 0.14488, 0.14961);
    node_emblem_letter_i_24.rotation.set(0.0, 0.0, 0.0);
  }
  node_emblem_letter_i_24.userData.sculptComponent = { id: "emblem-letter-i" };
  node_emblem_letter_i_24.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_emblem_letter_i_24);
  nodes["emblem-letter-i"] = node_emblem_letter_i_24;
  const mesh_emblem_letter_i_24Geometry = endpoint_emblem_letter_i_24
    ? new THREE.CylinderGeometry(endpoint_emblem_letter_i_24.endRadius, endpoint_emblem_letter_i_24.baseRadius, endpoint_emblem_letter_i_24.length, 8, 4)
    : buildExtrudeGeometry({"points": [[-0.00504, -0.0252], [0.00504, -0.0252], [0.00504, 0.0252], [-0.00504, 0.0252]], "depth": 0.00945});
  if (!endpoint_emblem_letter_i_24) {
    mesh_emblem_letter_i_24Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_emblem_letter_i_24 = new THREE.Mesh(
    mesh_emblem_letter_i_24Geometry,
    materialMap["emblem-white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_emblem_letter_i_24.name = "Emblem letter I";
  if (endpoint_emblem_letter_i_24) {
    mesh_emblem_letter_i_24.position.copy(endpoint_emblem_letter_i_24.midpoint);
    mesh_emblem_letter_i_24.quaternion.copy(endpoint_emblem_letter_i_24.quaternion);
  }
  mesh_emblem_letter_i_24.castShadow = options.castShadow ?? true;
  mesh_emblem_letter_i_24.receiveShadow = options.receiveShadow ?? true;
  mesh_emblem_letter_i_24.userData.sculptComponent = { id: "emblem-letter-i" };
  node_emblem_letter_i_24.add(mesh_emblem_letter_i_24);
  meshes["emblem-letter-i"] = mesh_emblem_letter_i_24;
  colliders["emblem-letter-i"] = {};
  destructionGroups["torso"] ??= [];
  destructionGroups["torso"].push(node_emblem_letter_i_24);

  const endpoint_abdomen_rib_1_25 = makeAttachmentEndpoint(null);
  const node_abdomen_rib_1_25 = new THREE.Group();
  node_abdomen_rib_1_25.name = "Abdomen segment ring 1__pivot";
  node_abdomen_rib_1_25.scale.set(1, 1, 1);
  if (endpoint_abdomen_rib_1_25) {
    node_abdomen_rib_1_25.position.copy(endpoint_abdomen_rib_1_25.start);
    node_abdomen_rib_1_25.rotation.set(1.5708, 0.0, 0.0);
  } else {
    node_abdomen_rib_1_25.position.set(0.0, 0.09449, 0.0);
    node_abdomen_rib_1_25.rotation.set(1.5708, 0.0, 0.0);
  }
  node_abdomen_rib_1_25.userData.sculptComponent = { id: "abdomen-rib-1" };
  node_abdomen_rib_1_25.userData.actionProfile = {};
  (nodes["abdomen"] ?? root).add(node_abdomen_rib_1_25);
  nodes["abdomen-rib-1"] = node_abdomen_rib_1_25;
  const mesh_abdomen_rib_1_25Geometry = endpoint_abdomen_rib_1_25
    ? new THREE.CylinderGeometry(endpoint_abdomen_rib_1_25.endRadius, endpoint_abdomen_rib_1_25.baseRadius, endpoint_abdomen_rib_1_25.length, 8, 4)
    : new THREE.TorusGeometry(0.45, 0.0627, 8, 16);
  if (!endpoint_abdomen_rib_1_25) {
    mesh_abdomen_rib_1_25Geometry.scale(0.22607, 0.18538, 0.22607);
  }
  const mesh_abdomen_rib_1_25 = new THREE.Mesh(
    mesh_abdomen_rib_1_25Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_abdomen_rib_1_25.name = "Abdomen segment ring 1";
  if (endpoint_abdomen_rib_1_25) {
    mesh_abdomen_rib_1_25.position.copy(endpoint_abdomen_rib_1_25.midpoint);
    mesh_abdomen_rib_1_25.quaternion.copy(endpoint_abdomen_rib_1_25.quaternion);
  }
  mesh_abdomen_rib_1_25.castShadow = options.castShadow ?? true;
  mesh_abdomen_rib_1_25.receiveShadow = options.receiveShadow ?? true;
  mesh_abdomen_rib_1_25.userData.sculptComponent = { id: "abdomen-rib-1" };
  node_abdomen_rib_1_25.add(mesh_abdomen_rib_1_25);
  meshes["abdomen-rib-1"] = mesh_abdomen_rib_1_25;
  colliders["abdomen-rib-1"] = {};
  destructionGroups["torso"] ??= [];
  destructionGroups["torso"].push(node_abdomen_rib_1_25);

  const endpoint_abdomen_rib_2_26 = makeAttachmentEndpoint(null);
  const node_abdomen_rib_2_26 = new THREE.Group();
  node_abdomen_rib_2_26.name = "Abdomen segment ring 2__pivot";
  node_abdomen_rib_2_26.scale.set(1, 1, 1);
  if (endpoint_abdomen_rib_2_26) {
    node_abdomen_rib_2_26.position.copy(endpoint_abdomen_rib_2_26.start);
    node_abdomen_rib_2_26.rotation.set(1.5708, 0.0, 0.0);
  } else {
    node_abdomen_rib_2_26.position.set(0.0, 0.06929, 0.0);
    node_abdomen_rib_2_26.rotation.set(1.5708, 0.0, 0.0);
  }
  node_abdomen_rib_2_26.userData.sculptComponent = { id: "abdomen-rib-2" };
  node_abdomen_rib_2_26.userData.actionProfile = {};
  (nodes["abdomen"] ?? root).add(node_abdomen_rib_2_26);
  nodes["abdomen-rib-2"] = node_abdomen_rib_2_26;
  const mesh_abdomen_rib_2_26Geometry = endpoint_abdomen_rib_2_26
    ? new THREE.CylinderGeometry(endpoint_abdomen_rib_2_26.endRadius, endpoint_abdomen_rib_2_26.baseRadius, endpoint_abdomen_rib_2_26.length, 8, 4)
    : new THREE.TorusGeometry(0.45, 0.0627, 8, 16);
  if (!endpoint_abdomen_rib_2_26) {
    mesh_abdomen_rib_2_26Geometry.scale(0.22607, 0.18538, 0.22607);
  }
  const mesh_abdomen_rib_2_26 = new THREE.Mesh(
    mesh_abdomen_rib_2_26Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_abdomen_rib_2_26.name = "Abdomen segment ring 2";
  if (endpoint_abdomen_rib_2_26) {
    mesh_abdomen_rib_2_26.position.copy(endpoint_abdomen_rib_2_26.midpoint);
    mesh_abdomen_rib_2_26.quaternion.copy(endpoint_abdomen_rib_2_26.quaternion);
  }
  mesh_abdomen_rib_2_26.castShadow = options.castShadow ?? true;
  mesh_abdomen_rib_2_26.receiveShadow = options.receiveShadow ?? true;
  mesh_abdomen_rib_2_26.userData.sculptComponent = { id: "abdomen-rib-2" };
  node_abdomen_rib_2_26.add(mesh_abdomen_rib_2_26);
  meshes["abdomen-rib-2"] = mesh_abdomen_rib_2_26;
  colliders["abdomen-rib-2"] = {};
  destructionGroups["torso"] ??= [];
  destructionGroups["torso"].push(node_abdomen_rib_2_26);

  const endpoint_abdomen_rib_3_27 = makeAttachmentEndpoint(null);
  const node_abdomen_rib_3_27 = new THREE.Group();
  node_abdomen_rib_3_27.name = "Abdomen segment ring 3__pivot";
  node_abdomen_rib_3_27.scale.set(1, 1, 1);
  if (endpoint_abdomen_rib_3_27) {
    node_abdomen_rib_3_27.position.copy(endpoint_abdomen_rib_3_27.start);
    node_abdomen_rib_3_27.rotation.set(1.5708, 0.0, 0.0);
  } else {
    node_abdomen_rib_3_27.position.set(0.0, 0.04409, 0.0);
    node_abdomen_rib_3_27.rotation.set(1.5708, 0.0, 0.0);
  }
  node_abdomen_rib_3_27.userData.sculptComponent = { id: "abdomen-rib-3" };
  node_abdomen_rib_3_27.userData.actionProfile = {};
  (nodes["abdomen"] ?? root).add(node_abdomen_rib_3_27);
  nodes["abdomen-rib-3"] = node_abdomen_rib_3_27;
  const mesh_abdomen_rib_3_27Geometry = endpoint_abdomen_rib_3_27
    ? new THREE.CylinderGeometry(endpoint_abdomen_rib_3_27.endRadius, endpoint_abdomen_rib_3_27.baseRadius, endpoint_abdomen_rib_3_27.length, 8, 4)
    : new THREE.TorusGeometry(0.45, 0.0627, 8, 16);
  if (!endpoint_abdomen_rib_3_27) {
    mesh_abdomen_rib_3_27Geometry.scale(0.22607, 0.18538, 0.22607);
  }
  const mesh_abdomen_rib_3_27 = new THREE.Mesh(
    mesh_abdomen_rib_3_27Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_abdomen_rib_3_27.name = "Abdomen segment ring 3";
  if (endpoint_abdomen_rib_3_27) {
    mesh_abdomen_rib_3_27.position.copy(endpoint_abdomen_rib_3_27.midpoint);
    mesh_abdomen_rib_3_27.quaternion.copy(endpoint_abdomen_rib_3_27.quaternion);
  }
  mesh_abdomen_rib_3_27.castShadow = options.castShadow ?? true;
  mesh_abdomen_rib_3_27.receiveShadow = options.receiveShadow ?? true;
  mesh_abdomen_rib_3_27.userData.sculptComponent = { id: "abdomen-rib-3" };
  node_abdomen_rib_3_27.add(mesh_abdomen_rib_3_27);
  meshes["abdomen-rib-3"] = mesh_abdomen_rib_3_27;
  colliders["abdomen-rib-3"] = {};
  destructionGroups["torso"] ??= [];
  destructionGroups["torso"].push(node_abdomen_rib_3_27);

  const endpoint_abdomen_rib_4_28 = makeAttachmentEndpoint(null);
  const node_abdomen_rib_4_28 = new THREE.Group();
  node_abdomen_rib_4_28.name = "Abdomen segment ring 4__pivot";
  node_abdomen_rib_4_28.scale.set(1, 1, 1);
  if (endpoint_abdomen_rib_4_28) {
    node_abdomen_rib_4_28.position.copy(endpoint_abdomen_rib_4_28.start);
    node_abdomen_rib_4_28.rotation.set(1.5708, 0.0, 0.0);
  } else {
    node_abdomen_rib_4_28.position.set(0.0, 0.0189, 0.0);
    node_abdomen_rib_4_28.rotation.set(1.5708, 0.0, 0.0);
  }
  node_abdomen_rib_4_28.userData.sculptComponent = { id: "abdomen-rib-4" };
  node_abdomen_rib_4_28.userData.actionProfile = {};
  (nodes["abdomen"] ?? root).add(node_abdomen_rib_4_28);
  nodes["abdomen-rib-4"] = node_abdomen_rib_4_28;
  const mesh_abdomen_rib_4_28Geometry = endpoint_abdomen_rib_4_28
    ? new THREE.CylinderGeometry(endpoint_abdomen_rib_4_28.endRadius, endpoint_abdomen_rib_4_28.baseRadius, endpoint_abdomen_rib_4_28.length, 8, 4)
    : new THREE.TorusGeometry(0.45, 0.0627, 8, 16);
  if (!endpoint_abdomen_rib_4_28) {
    mesh_abdomen_rib_4_28Geometry.scale(0.22607, 0.18538, 0.22607);
  }
  const mesh_abdomen_rib_4_28 = new THREE.Mesh(
    mesh_abdomen_rib_4_28Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_abdomen_rib_4_28.name = "Abdomen segment ring 4";
  if (endpoint_abdomen_rib_4_28) {
    mesh_abdomen_rib_4_28.position.copy(endpoint_abdomen_rib_4_28.midpoint);
    mesh_abdomen_rib_4_28.quaternion.copy(endpoint_abdomen_rib_4_28.quaternion);
  }
  mesh_abdomen_rib_4_28.castShadow = options.castShadow ?? true;
  mesh_abdomen_rib_4_28.receiveShadow = options.receiveShadow ?? true;
  mesh_abdomen_rib_4_28.userData.sculptComponent = { id: "abdomen-rib-4" };
  node_abdomen_rib_4_28.add(mesh_abdomen_rib_4_28);
  meshes["abdomen-rib-4"] = mesh_abdomen_rib_4_28;
  colliders["abdomen-rib-4"] = {};
  destructionGroups["torso"] ??= [];
  destructionGroups["torso"].push(node_abdomen_rib_4_28);

  const endpoint_pelvis_plate_29 = makeAttachmentEndpoint(null);
  const node_pelvis_plate_29 = new THREE.Group();
  node_pelvis_plate_29.name = "Pelvis front plate__pivot";
  node_pelvis_plate_29.scale.set(1, 1, 1);
  if (endpoint_pelvis_plate_29) {
    node_pelvis_plate_29.position.copy(endpoint_pelvis_plate_29.start);
    node_pelvis_plate_29.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_pelvis_plate_29.position.set(0.0, 0.11969, 0.06929);
    node_pelvis_plate_29.rotation.set(0.0, 0.0, 0.0);
  }
  node_pelvis_plate_29.userData.sculptComponent = { id: "pelvis-plate" };
  node_pelvis_plate_29.userData.actionProfile = {};
  (nodes["pelvis"] ?? root).add(node_pelvis_plate_29);
  nodes["pelvis-plate"] = node_pelvis_plate_29;
  const mesh_pelvis_plate_29Geometry = endpoint_pelvis_plate_29
    ? new THREE.CylinderGeometry(endpoint_pelvis_plate_29.endRadius, endpoint_pelvis_plate_29.baseRadius, endpoint_pelvis_plate_29.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.04409, "rz": 0.10173, "twist": 0.0}, {"position": [0.0, -0.11969, 0.0252], "rx": 0.05669, "rz": 0.13165, "twist": 0.0}, {"position": [0.0, -0.23937, 0.0189], "rx": 0.05039, "rz": 0.10772, "twist": 0.0}, {"position": [0.0, -0.30236, 0.0063], "rx": 0.0315, "rz": 0.04189, "twist": 0.0}], "radialSegments": 20, "capEnds": true});
  if (!endpoint_pelvis_plate_29) {
    mesh_pelvis_plate_29Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_pelvis_plate_29 = new THREE.Mesh(
    mesh_pelvis_plate_29Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pelvis_plate_29.name = "Pelvis front plate";
  if (endpoint_pelvis_plate_29) {
    mesh_pelvis_plate_29.position.copy(endpoint_pelvis_plate_29.midpoint);
    mesh_pelvis_plate_29.quaternion.copy(endpoint_pelvis_plate_29.quaternion);
  }
  mesh_pelvis_plate_29.castShadow = options.castShadow ?? true;
  mesh_pelvis_plate_29.receiveShadow = options.receiveShadow ?? true;
  mesh_pelvis_plate_29.userData.sculptComponent = { id: "pelvis-plate" };
  node_pelvis_plate_29.add(mesh_pelvis_plate_29);
  meshes["pelvis-plate"] = mesh_pelvis_plate_29;
  colliders["pelvis-plate"] = {};
  destructionGroups["pelvis"] ??= [];
  destructionGroups["pelvis"].push(node_pelvis_plate_29);

  const endpoint_pelvis_plate_back_30 = makeAttachmentEndpoint(null);
  const node_pelvis_plate_back_30 = new THREE.Group();
  node_pelvis_plate_back_30.name = "Pelvis back plate (inferred)__pivot";
  node_pelvis_plate_back_30.scale.set(1, 1, 1);
  if (endpoint_pelvis_plate_back_30) {
    node_pelvis_plate_back_30.position.copy(endpoint_pelvis_plate_back_30.start);
    node_pelvis_plate_back_30.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_pelvis_plate_back_30.position.set(0.0, 0.11969, -0.06929);
    node_pelvis_plate_back_30.rotation.set(0.0, 0.0, 0.0);
  }
  node_pelvis_plate_back_30.userData.sculptComponent = { id: "pelvis-plate-back" };
  node_pelvis_plate_back_30.userData.actionProfile = {};
  (nodes["pelvis"] ?? root).add(node_pelvis_plate_back_30);
  nodes["pelvis-plate-back"] = node_pelvis_plate_back_30;
  const mesh_pelvis_plate_back_30Geometry = endpoint_pelvis_plate_back_30
    ? new THREE.CylinderGeometry(endpoint_pelvis_plate_back_30.endRadius, endpoint_pelvis_plate_back_30.baseRadius, endpoint_pelvis_plate_back_30.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.04409, "rz": 0.10173, "twist": 0.0}, {"position": [0.0, -0.11969, -0.0252], "rx": 0.05669, "rz": 0.13165, "twist": 0.0}, {"position": [0.0, -0.23937, -0.0189], "rx": 0.05039, "rz": 0.10772, "twist": 0.0}, {"position": [0.0, -0.30236, -0.0063], "rx": 0.0315, "rz": 0.04189, "twist": 0.0}], "radialSegments": 20, "capEnds": true});
  if (!endpoint_pelvis_plate_back_30) {
    mesh_pelvis_plate_back_30Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_pelvis_plate_back_30 = new THREE.Mesh(
    mesh_pelvis_plate_back_30Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pelvis_plate_back_30.name = "Pelvis back plate (inferred)";
  if (endpoint_pelvis_plate_back_30) {
    mesh_pelvis_plate_back_30.position.copy(endpoint_pelvis_plate_back_30.midpoint);
    mesh_pelvis_plate_back_30.quaternion.copy(endpoint_pelvis_plate_back_30.quaternion);
  }
  mesh_pelvis_plate_back_30.castShadow = options.castShadow ?? true;
  mesh_pelvis_plate_back_30.receiveShadow = options.receiveShadow ?? true;
  mesh_pelvis_plate_back_30.userData.sculptComponent = { id: "pelvis-plate-back" };
  node_pelvis_plate_back_30.add(mesh_pelvis_plate_back_30);
  meshes["pelvis-plate-back"] = mesh_pelvis_plate_back_30;
  colliders["pelvis-plate-back"] = {};
  destructionGroups["pelvis"] ??= [];
  destructionGroups["pelvis"].push(node_pelvis_plate_back_30);

  const endpoint_shoulder_joint_l_31 = makeAttachmentEndpoint(null);
  const node_shoulder_joint_l_31 = new THREE.Group();
  node_shoulder_joint_l_31.name = "Shoulder joint L__pivot";
  node_shoulder_joint_l_31.scale.set(1, 1, 1);
  if (endpoint_shoulder_joint_l_31) {
    node_shoulder_joint_l_31.position.copy(endpoint_shoulder_joint_l_31.start);
    node_shoulder_joint_l_31.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_shoulder_joint_l_31.position.set(0.19748, 0.22677, -0.0063);
    node_shoulder_joint_l_31.rotation.set(0.0, 0.0, 0.0);
  }
  node_shoulder_joint_l_31.userData.sculptComponent = { id: "shoulder-joint-l" };
  node_shoulder_joint_l_31.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_shoulder_joint_l_31);
  nodes["shoulder-joint-l"] = node_shoulder_joint_l_31;
  const mesh_shoulder_joint_l_31Geometry = endpoint_shoulder_joint_l_31
    ? new THREE.CylinderGeometry(endpoint_shoulder_joint_l_31.endRadius, endpoint_shoulder_joint_l_31.baseRadius, endpoint_shoulder_joint_l_31.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_shoulder_joint_l_31) {
    mesh_shoulder_joint_l_31Geometry.scale(0.10079, 0.10079, 0.10079);
  }
  const mesh_shoulder_joint_l_31 = new THREE.Mesh(
    mesh_shoulder_joint_l_31Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_shoulder_joint_l_31.name = "Shoulder joint L";
  if (endpoint_shoulder_joint_l_31) {
    mesh_shoulder_joint_l_31.position.copy(endpoint_shoulder_joint_l_31.midpoint);
    mesh_shoulder_joint_l_31.quaternion.copy(endpoint_shoulder_joint_l_31.quaternion);
  }
  mesh_shoulder_joint_l_31.castShadow = options.castShadow ?? true;
  mesh_shoulder_joint_l_31.receiveShadow = options.receiveShadow ?? true;
  mesh_shoulder_joint_l_31.userData.sculptComponent = { id: "shoulder-joint-l" };
  node_shoulder_joint_l_31.add(mesh_shoulder_joint_l_31);
  meshes["shoulder-joint-l"] = mesh_shoulder_joint_l_31;
  colliders["shoulder-joint-l"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_shoulder_joint_l_31);

  const endpoint_pauldron_l_32 = makeAttachmentEndpoint(null);
  const node_pauldron_l_32 = new THREE.Group();
  node_pauldron_l_32.name = "Pauldron L__pivot";
  node_pauldron_l_32.scale.set(1, 1, 1);
  if (endpoint_pauldron_l_32) {
    node_pauldron_l_32.position.copy(endpoint_pauldron_l_32.start);
    node_pauldron_l_32.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_pauldron_l_32.position.set(0.23937, 0.34016, 0.0126);
    node_pauldron_l_32.rotation.set(0.0, 0.0, 0.0);
  }
  node_pauldron_l_32.userData.sculptComponent = { id: "pauldron-l" };
  node_pauldron_l_32.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_pauldron_l_32);
  nodes["pauldron-l"] = node_pauldron_l_32;
  const mesh_pauldron_l_32Geometry = endpoint_pauldron_l_32
    ? new THREE.CylinderGeometry(endpoint_pauldron_l_32.endRadius, endpoint_pauldron_l_32.baseRadius, endpoint_pauldron_l_32.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.03465, "rz": 0.02835, "twist": 0.0}, {"position": [0.04189, -0.07559, 0.0063], "rx": 0.05984, "rz": 0.05039, "twist": 0.0}, {"position": [0.06583, -0.15748, 0.0063], "rx": 0.07244, "rz": 0.06299, "twist": 0.0}, {"position": [0.05386, -0.23307, 0.0], "rx": 0.05984, "rz": 0.05039, "twist": 0.0}, {"position": [0.03591, -0.28346, -0.0063], "rx": 0.0252, "rz": 0.0189, "twist": 0.0}], "radialSegments": 22, "capEnds": true});
  if (!endpoint_pauldron_l_32) {
    mesh_pauldron_l_32Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_pauldron_l_32 = new THREE.Mesh(
    mesh_pauldron_l_32Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pauldron_l_32.name = "Pauldron L";
  if (endpoint_pauldron_l_32) {
    mesh_pauldron_l_32.position.copy(endpoint_pauldron_l_32.midpoint);
    mesh_pauldron_l_32.quaternion.copy(endpoint_pauldron_l_32.quaternion);
  }
  mesh_pauldron_l_32.castShadow = options.castShadow ?? true;
  mesh_pauldron_l_32.receiveShadow = options.receiveShadow ?? true;
  mesh_pauldron_l_32.userData.sculptComponent = { id: "pauldron-l" };
  node_pauldron_l_32.add(mesh_pauldron_l_32);
  meshes["pauldron-l"] = mesh_pauldron_l_32;
  colliders["pauldron-l"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_pauldron_l_32);

  const endpoint_pauldron_top_l_33 = makeAttachmentEndpoint(null);
  const node_pauldron_top_l_33 = new THREE.Group();
  node_pauldron_top_l_33.name = "Pauldron top petal L__pivot";
  node_pauldron_top_l_33.scale.set(1, 1, 1);
  if (endpoint_pauldron_top_l_33) {
    node_pauldron_top_l_33.position.copy(endpoint_pauldron_top_l_33.start);
    node_pauldron_top_l_33.rotation.set(0.0, 0.5, 0.0);
  } else {
    node_pauldron_top_l_33.position.set(0.23339, 0.34646, 0.0252);
    node_pauldron_top_l_33.rotation.set(0.0, 0.5, 0.0);
  }
  node_pauldron_top_l_33.userData.sculptComponent = { id: "pauldron-top-l" };
  node_pauldron_top_l_33.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_pauldron_top_l_33);
  nodes["pauldron-top-l"] = node_pauldron_top_l_33;
  const mesh_pauldron_top_l_33Geometry = endpoint_pauldron_top_l_33
    ? new THREE.CylinderGeometry(endpoint_pauldron_top_l_33.endRadius, endpoint_pauldron_top_l_33.baseRadius, endpoint_pauldron_top_l_33.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.0189, "rz": 0.01575, "twist": 0.0}, {"position": [0.02394, -0.06299, 0.0126], "rx": 0.04724, "rz": 0.04094, "twist": 0.0}, {"position": [0.04189, -0.13228, 0.0063], "rx": 0.01575, "rz": 0.0126, "twist": 0.0}], "radialSegments": 18, "capEnds": true});
  if (!endpoint_pauldron_top_l_33) {
    mesh_pauldron_top_l_33Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_pauldron_top_l_33 = new THREE.Mesh(
    mesh_pauldron_top_l_33Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pauldron_top_l_33.name = "Pauldron top petal L";
  if (endpoint_pauldron_top_l_33) {
    mesh_pauldron_top_l_33.position.copy(endpoint_pauldron_top_l_33.midpoint);
    mesh_pauldron_top_l_33.quaternion.copy(endpoint_pauldron_top_l_33.quaternion);
  }
  mesh_pauldron_top_l_33.castShadow = options.castShadow ?? true;
  mesh_pauldron_top_l_33.receiveShadow = options.receiveShadow ?? true;
  mesh_pauldron_top_l_33.userData.sculptComponent = { id: "pauldron-top-l" };
  node_pauldron_top_l_33.add(mesh_pauldron_top_l_33);
  meshes["pauldron-top-l"] = mesh_pauldron_top_l_33;
  colliders["pauldron-top-l"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_pauldron_top_l_33);

  const endpoint_pauldron_low_l_34 = makeAttachmentEndpoint(null);
  const node_pauldron_low_l_34 = new THREE.Group();
  node_pauldron_low_l_34.name = "Pauldron lower petal L__pivot";
  node_pauldron_low_l_34.scale.set(1, 1, 1);
  if (endpoint_pauldron_low_l_34) {
    node_pauldron_low_l_34.position.copy(endpoint_pauldron_low_l_34.start);
    node_pauldron_low_l_34.rotation.set(0.0, 0.4, 0.0);
  } else {
    node_pauldron_low_l_34.position.set(0.29323, 0.15118, 0.0126);
    node_pauldron_low_l_34.rotation.set(0.0, 0.4, 0.0);
  }
  node_pauldron_low_l_34.userData.sculptComponent = { id: "pauldron-low-l" };
  node_pauldron_low_l_34.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_pauldron_low_l_34);
  nodes["pauldron-low-l"] = node_pauldron_low_l_34;
  const mesh_pauldron_low_l_34Geometry = endpoint_pauldron_low_l_34
    ? new THREE.CylinderGeometry(endpoint_pauldron_low_l_34.endRadius, endpoint_pauldron_low_l_34.baseRadius, endpoint_pauldron_low_l_34.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.03465, "rz": 0.0252, "twist": 0.0}, {"position": [0.01795, -0.06929, 0.0126], "rx": 0.04724, "rz": 0.04094, "twist": 0.0}, {"position": [0.00598, -0.13858, 0.0063], "rx": 0.0252, "rz": 0.01575, "twist": 0.0}], "radialSegments": 18, "capEnds": true});
  if (!endpoint_pauldron_low_l_34) {
    mesh_pauldron_low_l_34Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_pauldron_low_l_34 = new THREE.Mesh(
    mesh_pauldron_low_l_34Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pauldron_low_l_34.name = "Pauldron lower petal L";
  if (endpoint_pauldron_low_l_34) {
    mesh_pauldron_low_l_34.position.copy(endpoint_pauldron_low_l_34.midpoint);
    mesh_pauldron_low_l_34.quaternion.copy(endpoint_pauldron_low_l_34.quaternion);
  }
  mesh_pauldron_low_l_34.castShadow = options.castShadow ?? true;
  mesh_pauldron_low_l_34.receiveShadow = options.receiveShadow ?? true;
  mesh_pauldron_low_l_34.userData.sculptComponent = { id: "pauldron-low-l" };
  node_pauldron_low_l_34.add(mesh_pauldron_low_l_34);
  meshes["pauldron-low-l"] = mesh_pauldron_low_l_34;
  colliders["pauldron-low-l"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_pauldron_low_l_34);

  const endpoint_pauldron_glow_l_35 = makeAttachmentEndpoint(null);
  const node_pauldron_glow_l_35 = new THREE.Group();
  node_pauldron_glow_l_35.name = "Pauldron glow L__pivot";
  node_pauldron_glow_l_35.scale.set(1, 1, 1);
  if (endpoint_pauldron_glow_l_35) {
    node_pauldron_glow_l_35.position.copy(endpoint_pauldron_glow_l_35.start);
    node_pauldron_glow_l_35.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_pauldron_glow_l_35.position.set(0.29921, 0.08819, 0.06299);
    node_pauldron_glow_l_35.rotation.set(0.0, 0.0, 0.0);
  }
  node_pauldron_glow_l_35.userData.sculptComponent = { id: "pauldron-glow-l" };
  node_pauldron_glow_l_35.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_pauldron_glow_l_35);
  nodes["pauldron-glow-l"] = node_pauldron_glow_l_35;
  const mesh_pauldron_glow_l_35Geometry = endpoint_pauldron_glow_l_35
    ? new THREE.CylinderGeometry(endpoint_pauldron_glow_l_35.endRadius, endpoint_pauldron_glow_l_35.baseRadius, endpoint_pauldron_glow_l_35.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_pauldron_glow_l_35) {
    mesh_pauldron_glow_l_35Geometry.scale(0.0252, 0.05039, 0.01575);
  }
  const mesh_pauldron_glow_l_35 = new THREE.Mesh(
    mesh_pauldron_glow_l_35Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pauldron_glow_l_35.name = "Pauldron glow L";
  if (endpoint_pauldron_glow_l_35) {
    mesh_pauldron_glow_l_35.position.copy(endpoint_pauldron_glow_l_35.midpoint);
    mesh_pauldron_glow_l_35.quaternion.copy(endpoint_pauldron_glow_l_35.quaternion);
  }
  mesh_pauldron_glow_l_35.castShadow = options.castShadow ?? true;
  mesh_pauldron_glow_l_35.receiveShadow = options.receiveShadow ?? true;
  mesh_pauldron_glow_l_35.userData.sculptComponent = { id: "pauldron-glow-l" };
  node_pauldron_glow_l_35.add(mesh_pauldron_glow_l_35);
  meshes["pauldron-glow-l"] = mesh_pauldron_glow_l_35;
  colliders["pauldron-glow-l"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_pauldron_glow_l_35);

  const attachment_upper_arm_l_36 = {"parentSocket": "chest-upper-arm-l", "localStart": [0.19748, 0.22677, -0.0063], "localEnd": [0.37165, 0.06929, 0.06299], "contactType": "socket-joint", "baseRadius": 0.0378, "endRadius": 0.0315, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_upper_arm_l_36 = makeAttachmentEndpoint(attachment_upper_arm_l_36);
  const node_upper_arm_l_36 = new THREE.Group();
  node_upper_arm_l_36.name = "Upper arm core L__pivot";
  node_upper_arm_l_36.scale.set(1, 1, 1);
  if (endpoint_upper_arm_l_36) {
    node_upper_arm_l_36.position.copy(endpoint_upper_arm_l_36.start);
    node_upper_arm_l_36.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_upper_arm_l_36.position.set(0.19748, 0.22677, -0.0063);
    node_upper_arm_l_36.rotation.set(0.0, 0.0, 0.0);
  }
  node_upper_arm_l_36.userData.sculptComponent = { id: "upper-arm-l" };
  node_upper_arm_l_36.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_upper_arm_l_36);
  nodes["upper-arm-l"] = node_upper_arm_l_36;
  const mesh_upper_arm_l_36Geometry = endpoint_upper_arm_l_36
    ? new THREE.CylinderGeometry(endpoint_upper_arm_l_36.endRadius, endpoint_upper_arm_l_36.baseRadius, endpoint_upper_arm_l_36.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_upper_arm_l_36) {
    mesh_upper_arm_l_36Geometry.scale(0.07559, 0.24482, 0.07559);
  }
  const mesh_upper_arm_l_36 = new THREE.Mesh(
    mesh_upper_arm_l_36Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_upper_arm_l_36.name = "Upper arm core L";
  if (endpoint_upper_arm_l_36) {
    mesh_upper_arm_l_36.position.copy(endpoint_upper_arm_l_36.midpoint);
    mesh_upper_arm_l_36.quaternion.copy(endpoint_upper_arm_l_36.quaternion);
  }
  mesh_upper_arm_l_36.castShadow = options.castShadow ?? true;
  mesh_upper_arm_l_36.receiveShadow = options.receiveShadow ?? true;
  mesh_upper_arm_l_36.userData.sculptComponent = { id: "upper-arm-l" };
  node_upper_arm_l_36.add(mesh_upper_arm_l_36);
  meshes["upper-arm-l"] = mesh_upper_arm_l_36;
  colliders["upper-arm-l"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_upper_arm_l_36);

  const endpoint_upper_arm_shell_l_37 = makeAttachmentEndpoint(null);
  const node_upper_arm_shell_l_37 = new THREE.Group();
  node_upper_arm_shell_l_37.name = "Bicep shell L__pivot";
  node_upper_arm_shell_l_37.scale.set(1, 1, 1);
  if (endpoint_upper_arm_shell_l_37) {
    node_upper_arm_shell_l_37.position.copy(endpoint_upper_arm_shell_l_37.start);
    node_upper_arm_shell_l_37.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_upper_arm_shell_l_37.position.set(0.0, 0.0, 0.0);
    node_upper_arm_shell_l_37.rotation.set(0.0, 0.0, 0.0);
  }
  node_upper_arm_shell_l_37.userData.sculptComponent = { id: "upper-arm-shell-l" };
  node_upper_arm_shell_l_37.userData.actionProfile = {};
  (nodes["upper-arm-l"] ?? root).add(node_upper_arm_shell_l_37);
  nodes["upper-arm-shell-l"] = node_upper_arm_shell_l_37;
  const mesh_upper_arm_shell_l_37Geometry = endpoint_upper_arm_shell_l_37
    ? new THREE.CylinderGeometry(endpoint_upper_arm_shell_l_37.endRadius, endpoint_upper_arm_shell_l_37.baseRadius, endpoint_upper_arm_shell_l_37.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.02041, "rz": 0.01071, "twist": 0.0}, {"position": [0.04354, -0.03937, 0.01732], "rx": 0.04535, "rz": 0.04016, "twist": 0.0}, {"position": [0.08709, -0.07874, 0.03465], "rx": 0.05669, "rz": 0.05354, "twist": 0.0}, {"position": [0.13063, -0.11811, 0.05197], "rx": 0.04762, "rz": 0.04283, "twist": 0.0}, {"position": [0.17417, -0.15748, 0.06929], "rx": 0.02041, "rz": 0.01071, "twist": 0.0}], "radialSegments": 16, "capEnds": true});
  if (!endpoint_upper_arm_shell_l_37) {
    mesh_upper_arm_shell_l_37Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_upper_arm_shell_l_37 = new THREE.Mesh(
    mesh_upper_arm_shell_l_37Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_upper_arm_shell_l_37.name = "Bicep shell L";
  if (endpoint_upper_arm_shell_l_37) {
    mesh_upper_arm_shell_l_37.position.copy(endpoint_upper_arm_shell_l_37.midpoint);
    mesh_upper_arm_shell_l_37.quaternion.copy(endpoint_upper_arm_shell_l_37.quaternion);
  }
  mesh_upper_arm_shell_l_37.castShadow = options.castShadow ?? true;
  mesh_upper_arm_shell_l_37.receiveShadow = options.receiveShadow ?? true;
  mesh_upper_arm_shell_l_37.userData.sculptComponent = { id: "upper-arm-shell-l" };
  node_upper_arm_shell_l_37.add(mesh_upper_arm_shell_l_37);
  meshes["upper-arm-shell-l"] = mesh_upper_arm_shell_l_37;
  colliders["upper-arm-shell-l"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_upper_arm_shell_l_37);

  const endpoint_elbow_l_38 = makeAttachmentEndpoint(null);
  const node_elbow_l_38 = new THREE.Group();
  node_elbow_l_38.name = "Elbow joint L__pivot";
  node_elbow_l_38.scale.set(1, 1, 1);
  if (endpoint_elbow_l_38) {
    node_elbow_l_38.position.copy(endpoint_elbow_l_38.start);
    node_elbow_l_38.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_elbow_l_38.position.set(0.17417, -0.15748, 0.06929);
    node_elbow_l_38.rotation.set(0.0, 0.0, 0.0);
  }
  node_elbow_l_38.userData.sculptComponent = { id: "elbow-l" };
  node_elbow_l_38.userData.actionProfile = {};
  (nodes["upper-arm-l"] ?? root).add(node_elbow_l_38);
  nodes["elbow-l"] = node_elbow_l_38;
  const mesh_elbow_l_38Geometry = endpoint_elbow_l_38
    ? new THREE.CylinderGeometry(endpoint_elbow_l_38.endRadius, endpoint_elbow_l_38.baseRadius, endpoint_elbow_l_38.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_elbow_l_38) {
    mesh_elbow_l_38Geometry.scale(0.08189, 0.08189, 0.08189);
  }
  const mesh_elbow_l_38 = new THREE.Mesh(
    mesh_elbow_l_38Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_elbow_l_38.name = "Elbow joint L";
  if (endpoint_elbow_l_38) {
    mesh_elbow_l_38.position.copy(endpoint_elbow_l_38.midpoint);
    mesh_elbow_l_38.quaternion.copy(endpoint_elbow_l_38.quaternion);
  }
  mesh_elbow_l_38.castShadow = options.castShadow ?? true;
  mesh_elbow_l_38.receiveShadow = options.receiveShadow ?? true;
  mesh_elbow_l_38.userData.sculptComponent = { id: "elbow-l" };
  node_elbow_l_38.add(mesh_elbow_l_38);
  meshes["elbow-l"] = mesh_elbow_l_38;
  colliders["elbow-l"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_elbow_l_38);

  const attachment_forearm_l_39 = {"parentSocket": "upper-arm-l-forearm-l", "localStart": [0.17417, -0.15748, 0.06929], "localEnd": [0.28126, -0.06929, 0.11339], "contactType": "hinge-joint", "baseRadius": 0.0315, "endRadius": 0.0252, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_forearm_l_39 = makeAttachmentEndpoint(attachment_forearm_l_39);
  const node_forearm_l_39 = new THREE.Group();
  node_forearm_l_39.name = "Forearm core L__pivot";
  node_forearm_l_39.scale.set(1, 1, 1);
  if (endpoint_forearm_l_39) {
    node_forearm_l_39.position.copy(endpoint_forearm_l_39.start);
    node_forearm_l_39.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_forearm_l_39.position.set(0.17417, -0.15748, 0.06929);
    node_forearm_l_39.rotation.set(0.0, 0.0, 0.0);
  }
  node_forearm_l_39.userData.sculptComponent = { id: "forearm-l" };
  node_forearm_l_39.userData.actionProfile = {};
  (nodes["upper-arm-l"] ?? root).add(node_forearm_l_39);
  nodes["forearm-l"] = node_forearm_l_39;
  const mesh_forearm_l_39Geometry = endpoint_forearm_l_39
    ? new THREE.CylinderGeometry(endpoint_forearm_l_39.endRadius, endpoint_forearm_l_39.baseRadius, endpoint_forearm_l_39.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_forearm_l_39) {
    mesh_forearm_l_39Geometry.scale(0.06299, 0.14557, 0.06299);
  }
  const mesh_forearm_l_39 = new THREE.Mesh(
    mesh_forearm_l_39Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_forearm_l_39.name = "Forearm core L";
  if (endpoint_forearm_l_39) {
    mesh_forearm_l_39.position.copy(endpoint_forearm_l_39.midpoint);
    mesh_forearm_l_39.quaternion.copy(endpoint_forearm_l_39.quaternion);
  }
  mesh_forearm_l_39.castShadow = options.castShadow ?? true;
  mesh_forearm_l_39.receiveShadow = options.receiveShadow ?? true;
  mesh_forearm_l_39.userData.sculptComponent = { id: "forearm-l" };
  node_forearm_l_39.add(mesh_forearm_l_39);
  meshes["forearm-l"] = mesh_forearm_l_39;
  colliders["forearm-l"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_forearm_l_39);

  const endpoint_forearm_shell_l_40 = makeAttachmentEndpoint(null);
  const node_forearm_shell_l_40 = new THREE.Group();
  node_forearm_shell_l_40.name = "Forearm shell L__pivot";
  node_forearm_shell_l_40.scale.set(1, 1, 1);
  if (endpoint_forearm_shell_l_40) {
    node_forearm_shell_l_40.position.copy(endpoint_forearm_shell_l_40.start);
    node_forearm_shell_l_40.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_forearm_shell_l_40.position.set(0.0, 0.0, 0.0);
    node_forearm_shell_l_40.rotation.set(0.0, 0.0, 0.0);
  }
  node_forearm_shell_l_40.userData.sculptComponent = { id: "forearm-shell-l" };
  node_forearm_shell_l_40.userData.actionProfile = {};
  (nodes["forearm-l"] ?? root).add(node_forearm_shell_l_40);
  nodes["forearm-shell-l"] = node_forearm_shell_l_40;
  const mesh_forearm_shell_l_40Geometry = endpoint_forearm_shell_l_40
    ? new THREE.CylinderGeometry(endpoint_forearm_shell_l_40.endRadius, endpoint_forearm_shell_l_40.baseRadius, endpoint_forearm_shell_l_40.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.01587, "rz": 0.00882, "twist": 0.0}, {"position": [0.02677, 0.02205, 0.01102], "rx": 0.03528, "rz": 0.03307, "twist": 0.0}, {"position": [0.05354, 0.04409, 0.02205], "rx": 0.04409, "rz": 0.04409, "twist": 0.0}, {"position": [0.08032, 0.06614, 0.03307], "rx": 0.03704, "rz": 0.03528, "twist": 0.0}, {"position": [0.10709, 0.08819, 0.04409], "rx": 0.01587, "rz": 0.00882, "twist": 0.0}], "radialSegments": 16, "capEnds": true});
  if (!endpoint_forearm_shell_l_40) {
    mesh_forearm_shell_l_40Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_forearm_shell_l_40 = new THREE.Mesh(
    mesh_forearm_shell_l_40Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_forearm_shell_l_40.name = "Forearm shell L";
  if (endpoint_forearm_shell_l_40) {
    mesh_forearm_shell_l_40.position.copy(endpoint_forearm_shell_l_40.midpoint);
    mesh_forearm_shell_l_40.quaternion.copy(endpoint_forearm_shell_l_40.quaternion);
  }
  mesh_forearm_shell_l_40.castShadow = options.castShadow ?? true;
  mesh_forearm_shell_l_40.receiveShadow = options.receiveShadow ?? true;
  mesh_forearm_shell_l_40.userData.sculptComponent = { id: "forearm-shell-l" };
  node_forearm_shell_l_40.add(mesh_forearm_shell_l_40);
  meshes["forearm-shell-l"] = mesh_forearm_shell_l_40;
  colliders["forearm-shell-l"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_forearm_shell_l_40);

  const endpoint_hand_l_41 = makeAttachmentEndpoint(null);
  const node_hand_l_41 = new THREE.Group();
  node_hand_l_41.name = "Hand L__pivot";
  node_hand_l_41.scale.set(1, 1, 1);
  if (endpoint_hand_l_41) {
    node_hand_l_41.position.copy(endpoint_hand_l_41.start);
    node_hand_l_41.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hand_l_41.position.set(0.10709, 0.04409, 0.04409);
    node_hand_l_41.rotation.set(0.0, 0.0, 0.0);
  }
  node_hand_l_41.userData.sculptComponent = { id: "hand-l" };
  node_hand_l_41.userData.actionProfile = {};
  (nodes["forearm-l"] ?? root).add(node_hand_l_41);
  nodes["hand-l"] = node_hand_l_41;
  const mesh_hand_l_41Geometry = endpoint_hand_l_41
    ? new THREE.CylinderGeometry(endpoint_hand_l_41.endRadius, endpoint_hand_l_41.baseRadius, endpoint_hand_l_41.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_hand_l_41) {
    mesh_hand_l_41Geometry.scale(0.07559, 0.08819, 0.0378);
  }
  const mesh_hand_l_41 = new THREE.Mesh(
    mesh_hand_l_41Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hand_l_41.name = "Hand L";
  if (endpoint_hand_l_41) {
    mesh_hand_l_41.position.copy(endpoint_hand_l_41.midpoint);
    mesh_hand_l_41.quaternion.copy(endpoint_hand_l_41.quaternion);
  }
  mesh_hand_l_41.castShadow = options.castShadow ?? true;
  mesh_hand_l_41.receiveShadow = options.receiveShadow ?? true;
  mesh_hand_l_41.userData.sculptComponent = { id: "hand-l" };
  node_hand_l_41.add(mesh_hand_l_41);
  meshes["hand-l"] = mesh_hand_l_41;
  colliders["hand-l"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_hand_l_41);

  const attachment_thumb_l_1_42 = {"parentSocket": "hand-l-thumb-l-1", "localStart": [-0.0315, -0.04409, 0.0189], "localEnd": [-0.03849, -0.06801, 0.02264], "contactType": "rigid-weld", "baseRadius": 0.00913, "endRadius": 0.00756, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_thumb_l_1_42 = makeAttachmentEndpoint(attachment_thumb_l_1_42);
  const node_thumb_l_1_42 = new THREE.Group();
  node_thumb_l_1_42.name = "Thumb L 1__pivot";
  node_thumb_l_1_42.scale.set(1, 1, 1);
  if (endpoint_thumb_l_1_42) {
    node_thumb_l_1_42.position.copy(endpoint_thumb_l_1_42.start);
    node_thumb_l_1_42.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_thumb_l_1_42.position.set(-0.0315, -0.04409, 0.0189);
    node_thumb_l_1_42.rotation.set(0.0, 0.0, 0.0);
  }
  node_thumb_l_1_42.userData.sculptComponent = { id: "thumb-l-1" };
  node_thumb_l_1_42.userData.actionProfile = {};
  (nodes["hand-l"] ?? root).add(node_thumb_l_1_42);
  nodes["thumb-l-1"] = node_thumb_l_1_42;
  const mesh_thumb_l_1_42Geometry = endpoint_thumb_l_1_42
    ? new THREE.CylinderGeometry(endpoint_thumb_l_1_42.endRadius, endpoint_thumb_l_1_42.baseRadius, endpoint_thumb_l_1_42.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_thumb_l_1_42) {
    mesh_thumb_l_1_42Geometry.scale(0.01827, 0.0252, 0.01827);
  }
  const mesh_thumb_l_1_42 = new THREE.Mesh(
    mesh_thumb_l_1_42Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_thumb_l_1_42.name = "Thumb L 1";
  if (endpoint_thumb_l_1_42) {
    mesh_thumb_l_1_42.position.copy(endpoint_thumb_l_1_42.midpoint);
    mesh_thumb_l_1_42.quaternion.copy(endpoint_thumb_l_1_42.quaternion);
  }
  mesh_thumb_l_1_42.castShadow = options.castShadow ?? true;
  mesh_thumb_l_1_42.receiveShadow = options.receiveShadow ?? true;
  mesh_thumb_l_1_42.userData.sculptComponent = { id: "thumb-l-1" };
  node_thumb_l_1_42.add(mesh_thumb_l_1_42);
  meshes["thumb-l-1"] = mesh_thumb_l_1_42;
  colliders["thumb-l-1"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_thumb_l_1_42);

  const attachment_thumb_l_2_43 = {"parentSocket": "thumb-l-1-thumb-l-2", "localStart": [-0.007, -0.02391, 0.00374], "localEnd": [-0.01285, -0.04391, 0.01097], "contactType": "hinge-joint", "baseRadius": 0.00756, "endRadius": 0.00598, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_thumb_l_2_43 = makeAttachmentEndpoint(attachment_thumb_l_2_43);
  const node_thumb_l_2_43 = new THREE.Group();
  node_thumb_l_2_43.name = "Thumb L 2__pivot";
  node_thumb_l_2_43.scale.set(1, 1, 1);
  if (endpoint_thumb_l_2_43) {
    node_thumb_l_2_43.position.copy(endpoint_thumb_l_2_43.start);
    node_thumb_l_2_43.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_thumb_l_2_43.position.set(-0.007, -0.02391, 0.00374);
    node_thumb_l_2_43.rotation.set(0.0, 0.0, 0.0);
  }
  node_thumb_l_2_43.userData.sculptComponent = { id: "thumb-l-2" };
  node_thumb_l_2_43.userData.actionProfile = {};
  (nodes["thumb-l-1"] ?? root).add(node_thumb_l_2_43);
  nodes["thumb-l-2"] = node_thumb_l_2_43;
  const mesh_thumb_l_2_43Geometry = endpoint_thumb_l_2_43
    ? new THREE.CylinderGeometry(endpoint_thumb_l_2_43.endRadius, endpoint_thumb_l_2_43.baseRadius, endpoint_thumb_l_2_43.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_thumb_l_2_43) {
    mesh_thumb_l_2_43Geometry.scale(0.01512, 0.02205, 0.01512);
  }
  const mesh_thumb_l_2_43 = new THREE.Mesh(
    mesh_thumb_l_2_43Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_thumb_l_2_43.name = "Thumb L 2";
  if (endpoint_thumb_l_2_43) {
    mesh_thumb_l_2_43.position.copy(endpoint_thumb_l_2_43.midpoint);
    mesh_thumb_l_2_43.quaternion.copy(endpoint_thumb_l_2_43.quaternion);
  }
  mesh_thumb_l_2_43.castShadow = options.castShadow ?? true;
  mesh_thumb_l_2_43.receiveShadow = options.receiveShadow ?? true;
  mesh_thumb_l_2_43.userData.sculptComponent = { id: "thumb-l-2" };
  node_thumb_l_2_43.add(mesh_thumb_l_2_43);
  meshes["thumb-l-2"] = mesh_thumb_l_2_43;
  colliders["thumb-l-2"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_thumb_l_2_43);

  const attachment_thumb_l_3_44 = {"parentSocket": "thumb-l-2-thumb-l-3", "localStart": [-0.00585, -0.01999, 0.00723], "localEnd": [-0.01047, -0.03576, 0.01656], "contactType": "hinge-joint", "baseRadius": 0.00598, "endRadius": 0.00441, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_thumb_l_3_44 = makeAttachmentEndpoint(attachment_thumb_l_3_44);
  const node_thumb_l_3_44 = new THREE.Group();
  node_thumb_l_3_44.name = "Thumb L 3__pivot";
  node_thumb_l_3_44.scale.set(1, 1, 1);
  if (endpoint_thumb_l_3_44) {
    node_thumb_l_3_44.position.copy(endpoint_thumb_l_3_44.start);
    node_thumb_l_3_44.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_thumb_l_3_44.position.set(-0.00585, -0.01999, 0.00723);
    node_thumb_l_3_44.rotation.set(0.0, 0.0, 0.0);
  }
  node_thumb_l_3_44.userData.sculptComponent = { id: "thumb-l-3" };
  node_thumb_l_3_44.userData.actionProfile = {};
  (nodes["thumb-l-2"] ?? root).add(node_thumb_l_3_44);
  nodes["thumb-l-3"] = node_thumb_l_3_44;
  const mesh_thumb_l_3_44Geometry = endpoint_thumb_l_3_44
    ? new THREE.CylinderGeometry(endpoint_thumb_l_3_44.endRadius, endpoint_thumb_l_3_44.baseRadius, endpoint_thumb_l_3_44.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_thumb_l_3_44) {
    mesh_thumb_l_3_44Geometry.scale(0.01197, 0.0189, 0.01197);
  }
  const mesh_thumb_l_3_44 = new THREE.Mesh(
    mesh_thumb_l_3_44Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_thumb_l_3_44.name = "Thumb L 3";
  if (endpoint_thumb_l_3_44) {
    mesh_thumb_l_3_44.position.copy(endpoint_thumb_l_3_44.midpoint);
    mesh_thumb_l_3_44.quaternion.copy(endpoint_thumb_l_3_44.quaternion);
  }
  mesh_thumb_l_3_44.castShadow = options.castShadow ?? true;
  mesh_thumb_l_3_44.receiveShadow = options.receiveShadow ?? true;
  mesh_thumb_l_3_44.userData.sculptComponent = { id: "thumb-l-3" };
  node_thumb_l_3_44.add(mesh_thumb_l_3_44);
  meshes["thumb-l-3"] = mesh_thumb_l_3_44;
  colliders["thumb-l-3"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_thumb_l_3_44);

  const attachment_index_l_1_45 = {"parentSocket": "hand-l-index-l-1", "localStart": [-0.02205, -0.04409, 0.0126], "localEnd": [-0.025, -0.072, 0.01658], "contactType": "rigid-weld", "baseRadius": 0.00913, "endRadius": 0.00756, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_index_l_1_45 = makeAttachmentEndpoint(attachment_index_l_1_45);
  const node_index_l_1_45 = new THREE.Group();
  node_index_l_1_45.name = "Index L 1__pivot";
  node_index_l_1_45.scale.set(1, 1, 1);
  if (endpoint_index_l_1_45) {
    node_index_l_1_45.position.copy(endpoint_index_l_1_45.start);
    node_index_l_1_45.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_index_l_1_45.position.set(-0.02205, -0.04409, 0.0126);
    node_index_l_1_45.rotation.set(0.0, 0.0, 0.0);
  }
  node_index_l_1_45.userData.sculptComponent = { id: "index-l-1" };
  node_index_l_1_45.userData.actionProfile = {};
  (nodes["hand-l"] ?? root).add(node_index_l_1_45);
  nodes["index-l-1"] = node_index_l_1_45;
  const mesh_index_l_1_45Geometry = endpoint_index_l_1_45
    ? new THREE.CylinderGeometry(endpoint_index_l_1_45.endRadius, endpoint_index_l_1_45.baseRadius, endpoint_index_l_1_45.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_index_l_1_45) {
    mesh_index_l_1_45Geometry.scale(0.01827, 0.02835, 0.01827);
  }
  const mesh_index_l_1_45 = new THREE.Mesh(
    mesh_index_l_1_45Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_index_l_1_45.name = "Index L 1";
  if (endpoint_index_l_1_45) {
    mesh_index_l_1_45.position.copy(endpoint_index_l_1_45.midpoint);
    mesh_index_l_1_45.quaternion.copy(endpoint_index_l_1_45.quaternion);
  }
  mesh_index_l_1_45.castShadow = options.castShadow ?? true;
  mesh_index_l_1_45.receiveShadow = options.receiveShadow ?? true;
  mesh_index_l_1_45.userData.sculptComponent = { id: "index-l-1" };
  node_index_l_1_45.add(mesh_index_l_1_45);
  meshes["index-l-1"] = mesh_index_l_1_45;
  colliders["index-l-1"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_index_l_1_45);

  const attachment_index_l_2_46 = {"parentSocket": "index-l-1-index-l-2", "localStart": [-0.00295, -0.02791, 0.00398], "localEnd": [-0.00516, -0.04874, 0.01086], "contactType": "hinge-joint", "baseRadius": 0.00756, "endRadius": 0.00598, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_index_l_2_46 = makeAttachmentEndpoint(attachment_index_l_2_46);
  const node_index_l_2_46 = new THREE.Group();
  node_index_l_2_46.name = "Index L 2__pivot";
  node_index_l_2_46.scale.set(1, 1, 1);
  if (endpoint_index_l_2_46) {
    node_index_l_2_46.position.copy(endpoint_index_l_2_46.start);
    node_index_l_2_46.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_index_l_2_46.position.set(-0.00295, -0.02791, 0.00398);
    node_index_l_2_46.rotation.set(0.0, 0.0, 0.0);
  }
  node_index_l_2_46.userData.sculptComponent = { id: "index-l-2" };
  node_index_l_2_46.userData.actionProfile = {};
  (nodes["index-l-1"] ?? root).add(node_index_l_2_46);
  nodes["index-l-2"] = node_index_l_2_46;
  const mesh_index_l_2_46Geometry = endpoint_index_l_2_46
    ? new THREE.CylinderGeometry(endpoint_index_l_2_46.endRadius, endpoint_index_l_2_46.baseRadius, endpoint_index_l_2_46.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_index_l_2_46) {
    mesh_index_l_2_46Geometry.scale(0.01512, 0.02205, 0.01512);
  }
  const mesh_index_l_2_46 = new THREE.Mesh(
    mesh_index_l_2_46Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_index_l_2_46.name = "Index L 2";
  if (endpoint_index_l_2_46) {
    mesh_index_l_2_46.position.copy(endpoint_index_l_2_46.midpoint);
    mesh_index_l_2_46.quaternion.copy(endpoint_index_l_2_46.quaternion);
  }
  mesh_index_l_2_46.castShadow = options.castShadow ?? true;
  mesh_index_l_2_46.receiveShadow = options.receiveShadow ?? true;
  mesh_index_l_2_46.userData.sculptComponent = { id: "index-l-2" };
  node_index_l_2_46.add(mesh_index_l_2_46);
  meshes["index-l-2"] = mesh_index_l_2_46;
  colliders["index-l-2"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_index_l_2_46);

  const attachment_index_l_3_47 = {"parentSocket": "index-l-2-index-l-3", "localStart": [-0.0022, -0.02083, 0.00687], "localEnd": [-0.00396, -0.03739, 0.01581], "contactType": "hinge-joint", "baseRadius": 0.00598, "endRadius": 0.00441, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_index_l_3_47 = makeAttachmentEndpoint(attachment_index_l_3_47);
  const node_index_l_3_47 = new THREE.Group();
  node_index_l_3_47.name = "Index L 3__pivot";
  node_index_l_3_47.scale.set(1, 1, 1);
  if (endpoint_index_l_3_47) {
    node_index_l_3_47.position.copy(endpoint_index_l_3_47.start);
    node_index_l_3_47.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_index_l_3_47.position.set(-0.0022, -0.02083, 0.00687);
    node_index_l_3_47.rotation.set(0.0, 0.0, 0.0);
  }
  node_index_l_3_47.userData.sculptComponent = { id: "index-l-3" };
  node_index_l_3_47.userData.actionProfile = {};
  (nodes["index-l-2"] ?? root).add(node_index_l_3_47);
  nodes["index-l-3"] = node_index_l_3_47;
  const mesh_index_l_3_47Geometry = endpoint_index_l_3_47
    ? new THREE.CylinderGeometry(endpoint_index_l_3_47.endRadius, endpoint_index_l_3_47.baseRadius, endpoint_index_l_3_47.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_index_l_3_47) {
    mesh_index_l_3_47Geometry.scale(0.01197, 0.0189, 0.01197);
  }
  const mesh_index_l_3_47 = new THREE.Mesh(
    mesh_index_l_3_47Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_index_l_3_47.name = "Index L 3";
  if (endpoint_index_l_3_47) {
    mesh_index_l_3_47.position.copy(endpoint_index_l_3_47.midpoint);
    mesh_index_l_3_47.quaternion.copy(endpoint_index_l_3_47.quaternion);
  }
  mesh_index_l_3_47.castShadow = options.castShadow ?? true;
  mesh_index_l_3_47.receiveShadow = options.receiveShadow ?? true;
  mesh_index_l_3_47.userData.sculptComponent = { id: "index-l-3" };
  node_index_l_3_47.add(mesh_index_l_3_47);
  meshes["index-l-3"] = mesh_index_l_3_47;
  colliders["index-l-3"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_index_l_3_47);

  const attachment_middle_l_1_48 = {"parentSocket": "hand-l-middle-l-1", "localStart": [-0.00315, -0.04409, 0.0126], "localEnd": [-0.00315, -0.07528, 0.01698], "contactType": "rigid-weld", "baseRadius": 0.00913, "endRadius": 0.00756, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_middle_l_1_48 = makeAttachmentEndpoint(attachment_middle_l_1_48);
  const node_middle_l_1_48 = new THREE.Group();
  node_middle_l_1_48.name = "Middle L 1__pivot";
  node_middle_l_1_48.scale.set(1, 1, 1);
  if (endpoint_middle_l_1_48) {
    node_middle_l_1_48.position.copy(endpoint_middle_l_1_48.start);
    node_middle_l_1_48.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_middle_l_1_48.position.set(-0.00315, -0.04409, 0.0126);
    node_middle_l_1_48.rotation.set(0.0, 0.0, 0.0);
  }
  node_middle_l_1_48.userData.sculptComponent = { id: "middle-l-1" };
  node_middle_l_1_48.userData.actionProfile = {};
  (nodes["hand-l"] ?? root).add(node_middle_l_1_48);
  nodes["middle-l-1"] = node_middle_l_1_48;
  const mesh_middle_l_1_48Geometry = endpoint_middle_l_1_48
    ? new THREE.CylinderGeometry(endpoint_middle_l_1_48.endRadius, endpoint_middle_l_1_48.baseRadius, endpoint_middle_l_1_48.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_middle_l_1_48) {
    mesh_middle_l_1_48Geometry.scale(0.01827, 0.0315, 0.01827);
  }
  const mesh_middle_l_1_48 = new THREE.Mesh(
    mesh_middle_l_1_48Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_middle_l_1_48.name = "Middle L 1";
  if (endpoint_middle_l_1_48) {
    mesh_middle_l_1_48.position.copy(endpoint_middle_l_1_48.midpoint);
    mesh_middle_l_1_48.quaternion.copy(endpoint_middle_l_1_48.quaternion);
  }
  mesh_middle_l_1_48.castShadow = options.castShadow ?? true;
  mesh_middle_l_1_48.receiveShadow = options.receiveShadow ?? true;
  mesh_middle_l_1_48.userData.sculptComponent = { id: "middle-l-1" };
  node_middle_l_1_48.add(mesh_middle_l_1_48);
  meshes["middle-l-1"] = mesh_middle_l_1_48;
  colliders["middle-l-1"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_middle_l_1_48);

  const attachment_middle_l_2_49 = {"parentSocket": "middle-l-1-middle-l-2", "localStart": [0.0, -0.03119, 0.00438], "localEnd": [0.0, -0.05515, 0.01217], "contactType": "hinge-joint", "baseRadius": 0.00756, "endRadius": 0.00598, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_middle_l_2_49 = makeAttachmentEndpoint(attachment_middle_l_2_49);
  const node_middle_l_2_49 = new THREE.Group();
  node_middle_l_2_49.name = "Middle L 2__pivot";
  node_middle_l_2_49.scale.set(1, 1, 1);
  if (endpoint_middle_l_2_49) {
    node_middle_l_2_49.position.copy(endpoint_middle_l_2_49.start);
    node_middle_l_2_49.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_middle_l_2_49.position.set(0.0, -0.03119, 0.00438);
    node_middle_l_2_49.rotation.set(0.0, 0.0, 0.0);
  }
  node_middle_l_2_49.userData.sculptComponent = { id: "middle-l-2" };
  node_middle_l_2_49.userData.actionProfile = {};
  (nodes["middle-l-1"] ?? root).add(node_middle_l_2_49);
  nodes["middle-l-2"] = node_middle_l_2_49;
  const mesh_middle_l_2_49Geometry = endpoint_middle_l_2_49
    ? new THREE.CylinderGeometry(endpoint_middle_l_2_49.endRadius, endpoint_middle_l_2_49.baseRadius, endpoint_middle_l_2_49.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_middle_l_2_49) {
    mesh_middle_l_2_49Geometry.scale(0.01512, 0.0252, 0.01512);
  }
  const mesh_middle_l_2_49 = new THREE.Mesh(
    mesh_middle_l_2_49Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_middle_l_2_49.name = "Middle L 2";
  if (endpoint_middle_l_2_49) {
    mesh_middle_l_2_49.position.copy(endpoint_middle_l_2_49.midpoint);
    mesh_middle_l_2_49.quaternion.copy(endpoint_middle_l_2_49.quaternion);
  }
  mesh_middle_l_2_49.castShadow = options.castShadow ?? true;
  mesh_middle_l_2_49.receiveShadow = options.receiveShadow ?? true;
  mesh_middle_l_2_49.userData.sculptComponent = { id: "middle-l-2" };
  node_middle_l_2_49.add(mesh_middle_l_2_49);
  meshes["middle-l-2"] = mesh_middle_l_2_49;
  colliders["middle-l-2"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_middle_l_2_49);

  const attachment_middle_l_3_50 = {"parentSocket": "middle-l-2-middle-l-3", "localStart": [0.0, -0.02396, 0.00779], "localEnd": [0.0, -0.04065, 0.01666], "contactType": "hinge-joint", "baseRadius": 0.00598, "endRadius": 0.00441, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_middle_l_3_50 = makeAttachmentEndpoint(attachment_middle_l_3_50);
  const node_middle_l_3_50 = new THREE.Group();
  node_middle_l_3_50.name = "Middle L 3__pivot";
  node_middle_l_3_50.scale.set(1, 1, 1);
  if (endpoint_middle_l_3_50) {
    node_middle_l_3_50.position.copy(endpoint_middle_l_3_50.start);
    node_middle_l_3_50.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_middle_l_3_50.position.set(0.0, -0.02396, 0.00779);
    node_middle_l_3_50.rotation.set(0.0, 0.0, 0.0);
  }
  node_middle_l_3_50.userData.sculptComponent = { id: "middle-l-3" };
  node_middle_l_3_50.userData.actionProfile = {};
  (nodes["middle-l-2"] ?? root).add(node_middle_l_3_50);
  nodes["middle-l-3"] = node_middle_l_3_50;
  const mesh_middle_l_3_50Geometry = endpoint_middle_l_3_50
    ? new THREE.CylinderGeometry(endpoint_middle_l_3_50.endRadius, endpoint_middle_l_3_50.baseRadius, endpoint_middle_l_3_50.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_middle_l_3_50) {
    mesh_middle_l_3_50Geometry.scale(0.01197, 0.0189, 0.01197);
  }
  const mesh_middle_l_3_50 = new THREE.Mesh(
    mesh_middle_l_3_50Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_middle_l_3_50.name = "Middle L 3";
  if (endpoint_middle_l_3_50) {
    mesh_middle_l_3_50.position.copy(endpoint_middle_l_3_50.midpoint);
    mesh_middle_l_3_50.quaternion.copy(endpoint_middle_l_3_50.quaternion);
  }
  mesh_middle_l_3_50.castShadow = options.castShadow ?? true;
  mesh_middle_l_3_50.receiveShadow = options.receiveShadow ?? true;
  mesh_middle_l_3_50.userData.sculptComponent = { id: "middle-l-3" };
  node_middle_l_3_50.add(mesh_middle_l_3_50);
  meshes["middle-l-3"] = mesh_middle_l_3_50;
  colliders["middle-l-3"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_middle_l_3_50);

  const attachment_ring_l_1_51 = {"parentSocket": "hand-l-ring-l-1", "localStart": [0.01575, -0.04409, 0.0126], "localEnd": [0.01811, -0.07206, 0.01657], "contactType": "rigid-weld", "baseRadius": 0.00913, "endRadius": 0.00756, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_ring_l_1_51 = makeAttachmentEndpoint(attachment_ring_l_1_51);
  const node_ring_l_1_51 = new THREE.Group();
  node_ring_l_1_51.name = "Ring L 1__pivot";
  node_ring_l_1_51.scale.set(1, 1, 1);
  if (endpoint_ring_l_1_51) {
    node_ring_l_1_51.position.copy(endpoint_ring_l_1_51.start);
    node_ring_l_1_51.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_ring_l_1_51.position.set(0.01575, -0.04409, 0.0126);
    node_ring_l_1_51.rotation.set(0.0, 0.0, 0.0);
  }
  node_ring_l_1_51.userData.sculptComponent = { id: "ring-l-1" };
  node_ring_l_1_51.userData.actionProfile = {};
  (nodes["hand-l"] ?? root).add(node_ring_l_1_51);
  nodes["ring-l-1"] = node_ring_l_1_51;
  const mesh_ring_l_1_51Geometry = endpoint_ring_l_1_51
    ? new THREE.CylinderGeometry(endpoint_ring_l_1_51.endRadius, endpoint_ring_l_1_51.baseRadius, endpoint_ring_l_1_51.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_ring_l_1_51) {
    mesh_ring_l_1_51Geometry.scale(0.01827, 0.02835, 0.01827);
  }
  const mesh_ring_l_1_51 = new THREE.Mesh(
    mesh_ring_l_1_51Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ring_l_1_51.name = "Ring L 1";
  if (endpoint_ring_l_1_51) {
    mesh_ring_l_1_51.position.copy(endpoint_ring_l_1_51.midpoint);
    mesh_ring_l_1_51.quaternion.copy(endpoint_ring_l_1_51.quaternion);
  }
  mesh_ring_l_1_51.castShadow = options.castShadow ?? true;
  mesh_ring_l_1_51.receiveShadow = options.receiveShadow ?? true;
  mesh_ring_l_1_51.userData.sculptComponent = { id: "ring-l-1" };
  node_ring_l_1_51.add(mesh_ring_l_1_51);
  meshes["ring-l-1"] = mesh_ring_l_1_51;
  colliders["ring-l-1"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_ring_l_1_51);

  const attachment_ring_l_2_52 = {"parentSocket": "ring-l-1-ring-l-2", "localStart": [0.00236, -0.02797, 0.00397], "localEnd": [0.00412, -0.04885, 0.01082], "contactType": "hinge-joint", "baseRadius": 0.00756, "endRadius": 0.00598, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_ring_l_2_52 = makeAttachmentEndpoint(attachment_ring_l_2_52);
  const node_ring_l_2_52 = new THREE.Group();
  node_ring_l_2_52.name = "Ring L 2__pivot";
  node_ring_l_2_52.scale.set(1, 1, 1);
  if (endpoint_ring_l_2_52) {
    node_ring_l_2_52.position.copy(endpoint_ring_l_2_52.start);
    node_ring_l_2_52.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_ring_l_2_52.position.set(0.00236, -0.02797, 0.00397);
    node_ring_l_2_52.rotation.set(0.0, 0.0, 0.0);
  }
  node_ring_l_2_52.userData.sculptComponent = { id: "ring-l-2" };
  node_ring_l_2_52.userData.actionProfile = {};
  (nodes["ring-l-1"] ?? root).add(node_ring_l_2_52);
  nodes["ring-l-2"] = node_ring_l_2_52;
  const mesh_ring_l_2_52Geometry = endpoint_ring_l_2_52
    ? new THREE.CylinderGeometry(endpoint_ring_l_2_52.endRadius, endpoint_ring_l_2_52.baseRadius, endpoint_ring_l_2_52.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_ring_l_2_52) {
    mesh_ring_l_2_52Geometry.scale(0.01512, 0.02205, 0.01512);
  }
  const mesh_ring_l_2_52 = new THREE.Mesh(
    mesh_ring_l_2_52Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ring_l_2_52.name = "Ring L 2";
  if (endpoint_ring_l_2_52) {
    mesh_ring_l_2_52.position.copy(endpoint_ring_l_2_52.midpoint);
    mesh_ring_l_2_52.quaternion.copy(endpoint_ring_l_2_52.quaternion);
  }
  mesh_ring_l_2_52.castShadow = options.castShadow ?? true;
  mesh_ring_l_2_52.receiveShadow = options.receiveShadow ?? true;
  mesh_ring_l_2_52.userData.sculptComponent = { id: "ring-l-2" };
  node_ring_l_2_52.add(mesh_ring_l_2_52);
  meshes["ring-l-2"] = mesh_ring_l_2_52;
  colliders["ring-l-2"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_ring_l_2_52);

  const attachment_ring_l_3_53 = {"parentSocket": "ring-l-2-ring-l-3", "localStart": [0.00176, -0.02088, 0.00685], "localEnd": [0.00316, -0.03749, 0.01577], "contactType": "hinge-joint", "baseRadius": 0.00598, "endRadius": 0.00441, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_ring_l_3_53 = makeAttachmentEndpoint(attachment_ring_l_3_53);
  const node_ring_l_3_53 = new THREE.Group();
  node_ring_l_3_53.name = "Ring L 3__pivot";
  node_ring_l_3_53.scale.set(1, 1, 1);
  if (endpoint_ring_l_3_53) {
    node_ring_l_3_53.position.copy(endpoint_ring_l_3_53.start);
    node_ring_l_3_53.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_ring_l_3_53.position.set(0.00176, -0.02088, 0.00685);
    node_ring_l_3_53.rotation.set(0.0, 0.0, 0.0);
  }
  node_ring_l_3_53.userData.sculptComponent = { id: "ring-l-3" };
  node_ring_l_3_53.userData.actionProfile = {};
  (nodes["ring-l-2"] ?? root).add(node_ring_l_3_53);
  nodes["ring-l-3"] = node_ring_l_3_53;
  const mesh_ring_l_3_53Geometry = endpoint_ring_l_3_53
    ? new THREE.CylinderGeometry(endpoint_ring_l_3_53.endRadius, endpoint_ring_l_3_53.baseRadius, endpoint_ring_l_3_53.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_ring_l_3_53) {
    mesh_ring_l_3_53Geometry.scale(0.01197, 0.0189, 0.01197);
  }
  const mesh_ring_l_3_53 = new THREE.Mesh(
    mesh_ring_l_3_53Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ring_l_3_53.name = "Ring L 3";
  if (endpoint_ring_l_3_53) {
    mesh_ring_l_3_53.position.copy(endpoint_ring_l_3_53.midpoint);
    mesh_ring_l_3_53.quaternion.copy(endpoint_ring_l_3_53.quaternion);
  }
  mesh_ring_l_3_53.castShadow = options.castShadow ?? true;
  mesh_ring_l_3_53.receiveShadow = options.receiveShadow ?? true;
  mesh_ring_l_3_53.userData.sculptComponent = { id: "ring-l-3" };
  node_ring_l_3_53.add(mesh_ring_l_3_53);
  meshes["ring-l-3"] = mesh_ring_l_3_53;
  colliders["ring-l-3"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_ring_l_3_53);

  const attachment_little_l_1_54 = {"parentSocket": "hand-l-little-l-1", "localStart": [0.0315, -0.04409, 0.00945], "localEnd": [0.0352, -0.0656, 0.01259], "contactType": "rigid-weld", "baseRadius": 0.00913, "endRadius": 0.00756, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_little_l_1_54 = makeAttachmentEndpoint(attachment_little_l_1_54);
  const node_little_l_1_54 = new THREE.Group();
  node_little_l_1_54.name = "Little L 1__pivot";
  node_little_l_1_54.scale.set(1, 1, 1);
  if (endpoint_little_l_1_54) {
    node_little_l_1_54.position.copy(endpoint_little_l_1_54.start);
    node_little_l_1_54.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_little_l_1_54.position.set(0.0315, -0.04409, 0.00945);
    node_little_l_1_54.rotation.set(0.0, 0.0, 0.0);
  }
  node_little_l_1_54.userData.sculptComponent = { id: "little-l-1" };
  node_little_l_1_54.userData.actionProfile = {};
  (nodes["hand-l"] ?? root).add(node_little_l_1_54);
  nodes["little-l-1"] = node_little_l_1_54;
  const mesh_little_l_1_54Geometry = endpoint_little_l_1_54
    ? new THREE.CylinderGeometry(endpoint_little_l_1_54.endRadius, endpoint_little_l_1_54.baseRadius, endpoint_little_l_1_54.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_little_l_1_54) {
    mesh_little_l_1_54Geometry.scale(0.01827, 0.02205, 0.01827);
  }
  const mesh_little_l_1_54 = new THREE.Mesh(
    mesh_little_l_1_54Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_little_l_1_54.name = "Little L 1";
  if (endpoint_little_l_1_54) {
    mesh_little_l_1_54.position.copy(endpoint_little_l_1_54.midpoint);
    mesh_little_l_1_54.quaternion.copy(endpoint_little_l_1_54.quaternion);
  }
  mesh_little_l_1_54.castShadow = options.castShadow ?? true;
  mesh_little_l_1_54.receiveShadow = options.receiveShadow ?? true;
  mesh_little_l_1_54.userData.sculptComponent = { id: "little-l-1" };
  node_little_l_1_54.add(mesh_little_l_1_54);
  meshes["little-l-1"] = mesh_little_l_1_54;
  colliders["little-l-1"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_little_l_1_54);

  const attachment_little_l_2_55 = {"parentSocket": "little-l-1-little-l-2", "localStart": [0.0037, -0.02151, 0.00314], "localEnd": [0.00623, -0.03623, 0.00812], "contactType": "hinge-joint", "baseRadius": 0.00756, "endRadius": 0.00598, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_little_l_2_55 = makeAttachmentEndpoint(attachment_little_l_2_55);
  const node_little_l_2_55 = new THREE.Group();
  node_little_l_2_55.name = "Little L 2__pivot";
  node_little_l_2_55.scale.set(1, 1, 1);
  if (endpoint_little_l_2_55) {
    node_little_l_2_55.position.copy(endpoint_little_l_2_55.start);
    node_little_l_2_55.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_little_l_2_55.position.set(0.0037, -0.02151, 0.00314);
    node_little_l_2_55.rotation.set(0.0, 0.0, 0.0);
  }
  node_little_l_2_55.userData.sculptComponent = { id: "little-l-2" };
  node_little_l_2_55.userData.actionProfile = {};
  (nodes["little-l-1"] ?? root).add(node_little_l_2_55);
  nodes["little-l-2"] = node_little_l_2_55;
  const mesh_little_l_2_55Geometry = endpoint_little_l_2_55
    ? new THREE.CylinderGeometry(endpoint_little_l_2_55.endRadius, endpoint_little_l_2_55.baseRadius, endpoint_little_l_2_55.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_little_l_2_55) {
    mesh_little_l_2_55Geometry.scale(0.01512, 0.01575, 0.01512);
  }
  const mesh_little_l_2_55 = new THREE.Mesh(
    mesh_little_l_2_55Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_little_l_2_55.name = "Little L 2";
  if (endpoint_little_l_2_55) {
    mesh_little_l_2_55.position.copy(endpoint_little_l_2_55.midpoint);
    mesh_little_l_2_55.quaternion.copy(endpoint_little_l_2_55.quaternion);
  }
  mesh_little_l_2_55.castShadow = options.castShadow ?? true;
  mesh_little_l_2_55.receiveShadow = options.receiveShadow ?? true;
  mesh_little_l_2_55.userData.sculptComponent = { id: "little-l-2" };
  node_little_l_2_55.add(mesh_little_l_2_55);
  meshes["little-l-2"] = mesh_little_l_2_55;
  colliders["little-l-2"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_little_l_2_55);

  const attachment_little_l_3_56 = {"parentSocket": "little-l-2-little-l-3", "localStart": [0.00253, -0.01472, 0.00498], "localEnd": [0.00488, -0.02835, 0.01251], "contactType": "hinge-joint", "baseRadius": 0.00598, "endRadius": 0.00441, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_little_l_3_56 = makeAttachmentEndpoint(attachment_little_l_3_56);
  const node_little_l_3_56 = new THREE.Group();
  node_little_l_3_56.name = "Little L 3__pivot";
  node_little_l_3_56.scale.set(1, 1, 1);
  if (endpoint_little_l_3_56) {
    node_little_l_3_56.position.copy(endpoint_little_l_3_56.start);
    node_little_l_3_56.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_little_l_3_56.position.set(0.00253, -0.01472, 0.00498);
    node_little_l_3_56.rotation.set(0.0, 0.0, 0.0);
  }
  node_little_l_3_56.userData.sculptComponent = { id: "little-l-3" };
  node_little_l_3_56.userData.actionProfile = {};
  (nodes["little-l-2"] ?? root).add(node_little_l_3_56);
  nodes["little-l-3"] = node_little_l_3_56;
  const mesh_little_l_3_56Geometry = endpoint_little_l_3_56
    ? new THREE.CylinderGeometry(endpoint_little_l_3_56.endRadius, endpoint_little_l_3_56.baseRadius, endpoint_little_l_3_56.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_little_l_3_56) {
    mesh_little_l_3_56Geometry.scale(0.01197, 0.01575, 0.01197);
  }
  const mesh_little_l_3_56 = new THREE.Mesh(
    mesh_little_l_3_56Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_little_l_3_56.name = "Little L 3";
  if (endpoint_little_l_3_56) {
    mesh_little_l_3_56.position.copy(endpoint_little_l_3_56.midpoint);
    mesh_little_l_3_56.quaternion.copy(endpoint_little_l_3_56.quaternion);
  }
  mesh_little_l_3_56.castShadow = options.castShadow ?? true;
  mesh_little_l_3_56.receiveShadow = options.receiveShadow ?? true;
  mesh_little_l_3_56.userData.sculptComponent = { id: "little-l-3" };
  node_little_l_3_56.add(mesh_little_l_3_56);
  meshes["little-l-3"] = mesh_little_l_3_56;
  colliders["little-l-3"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_little_l_3_56);

  const endpoint_seam_chest_l_57 = makeAttachmentEndpoint(null);
  const node_seam_chest_l_57 = new THREE.Group();
  node_seam_chest_l_57.name = "Gold seam seam-chest-l__pivot";
  node_seam_chest_l_57.scale.set(1, 1, 1);
  if (endpoint_seam_chest_l_57) {
    node_seam_chest_l_57.position.copy(endpoint_seam_chest_l_57.start);
    node_seam_chest_l_57.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seam_chest_l_57.position.set(0.0, 0.0, 0.0);
    node_seam_chest_l_57.rotation.set(0.0, 0.0, 0.0);
  }
  node_seam_chest_l_57.userData.sculptComponent = { id: "seam-chest-l" };
  node_seam_chest_l_57.userData.actionProfile = {};
  (nodes["chest-shell-l"] ?? root).add(node_seam_chest_l_57);
  nodes["seam-chest-l"] = node_seam_chest_l_57;
  const mesh_seam_chest_l_57Geometry = endpoint_seam_chest_l_57
    ? new THREE.CylinderGeometry(endpoint_seam_chest_l_57.endRadius, endpoint_seam_chest_l_57.baseRadius, endpoint_seam_chest_l_57.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.06385, -0.0, 0.04057], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [-0.09341, -0.06929, 0.08945], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [-0.11173, -0.17008, 0.10205], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [-0.10664, -0.26457, 0.07257], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_seam_chest_l_57) {
    mesh_seam_chest_l_57Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seam_chest_l_57 = new THREE.Mesh(
    mesh_seam_chest_l_57Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seam_chest_l_57.name = "Gold seam seam-chest-l";
  if (endpoint_seam_chest_l_57) {
    mesh_seam_chest_l_57.position.copy(endpoint_seam_chest_l_57.midpoint);
    mesh_seam_chest_l_57.quaternion.copy(endpoint_seam_chest_l_57.quaternion);
  }
  mesh_seam_chest_l_57.castShadow = options.castShadow ?? true;
  mesh_seam_chest_l_57.receiveShadow = options.receiveShadow ?? true;
  mesh_seam_chest_l_57.userData.sculptComponent = { id: "seam-chest-l" };
  node_seam_chest_l_57.add(mesh_seam_chest_l_57);
  meshes["seam-chest-l"] = mesh_seam_chest_l_57;
  colliders["seam-chest-l"] = {};
  destructionGroups["chest-shell-l"] ??= [];
  destructionGroups["chest-shell-l"].push(node_seam_chest_l_57);

  const endpoint_seam_chest_out_l_58 = makeAttachmentEndpoint(null);
  const node_seam_chest_out_l_58 = new THREE.Group();
  node_seam_chest_out_l_58.name = "Gold seam seam-chest-out-l__pivot";
  node_seam_chest_out_l_58.scale.set(1, 1, 1);
  if (endpoint_seam_chest_out_l_58) {
    node_seam_chest_out_l_58.position.copy(endpoint_seam_chest_out_l_58.start);
    node_seam_chest_out_l_58.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seam_chest_out_l_58.position.set(0.0, 0.0, 0.0);
    node_seam_chest_out_l_58.rotation.set(0.0, 0.0, 0.0);
  }
  node_seam_chest_out_l_58.userData.sculptComponent = { id: "seam-chest-out-l" };
  node_seam_chest_out_l_58.userData.actionProfile = {};
  (nodes["chest-shell-l"] ?? root).add(node_seam_chest_out_l_58);
  nodes["seam-chest-out-l"] = node_seam_chest_out_l_58;
  const mesh_seam_chest_out_l_58Geometry = endpoint_seam_chest_out_l_58
    ? new THREE.CylinderGeometry(endpoint_seam_chest_out_l_58.endRadius, endpoint_seam_chest_out_l_58.baseRadius, endpoint_seam_chest_out_l_58.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.06385, -0.0, 0.04057], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [0.05751, -0.06929, 0.08945], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [0.01598, -0.17008, 0.10205], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [-0.03698, -0.26457, 0.07257], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_seam_chest_out_l_58) {
    mesh_seam_chest_out_l_58Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seam_chest_out_l_58 = new THREE.Mesh(
    mesh_seam_chest_out_l_58Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seam_chest_out_l_58.name = "Gold seam seam-chest-out-l";
  if (endpoint_seam_chest_out_l_58) {
    mesh_seam_chest_out_l_58.position.copy(endpoint_seam_chest_out_l_58.midpoint);
    mesh_seam_chest_out_l_58.quaternion.copy(endpoint_seam_chest_out_l_58.quaternion);
  }
  mesh_seam_chest_out_l_58.castShadow = options.castShadow ?? true;
  mesh_seam_chest_out_l_58.receiveShadow = options.receiveShadow ?? true;
  mesh_seam_chest_out_l_58.userData.sculptComponent = { id: "seam-chest-out-l" };
  node_seam_chest_out_l_58.add(mesh_seam_chest_out_l_58);
  meshes["seam-chest-out-l"] = mesh_seam_chest_out_l_58;
  colliders["seam-chest-out-l"] = {};
  destructionGroups["chest-shell-l"] ??= [];
  destructionGroups["chest-shell-l"].push(node_seam_chest_out_l_58);

  const endpoint_seam_pauldron_l_59 = makeAttachmentEndpoint(null);
  const node_seam_pauldron_l_59 = new THREE.Group();
  node_seam_pauldron_l_59.name = "Gold seam seam-pauldron-l__pivot";
  node_seam_pauldron_l_59.scale.set(1, 1, 1);
  if (endpoint_seam_pauldron_l_59) {
    node_seam_pauldron_l_59.position.copy(endpoint_seam_pauldron_l_59.start);
    node_seam_pauldron_l_59.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seam_pauldron_l_59.position.set(0.0, 0.0, 0.0);
    node_seam_pauldron_l_59.rotation.set(0.0, 0.0, 0.0);
  }
  node_seam_pauldron_l_59.userData.sculptComponent = { id: "seam-pauldron-l" };
  node_seam_pauldron_l_59.userData.actionProfile = {};
  (nodes["pauldron-l"] ?? root).add(node_seam_pauldron_l_59);
  nodes["seam-pauldron-l"] = node_seam_pauldron_l_59;
  const mesh_seam_pauldron_l_59Geometry = endpoint_seam_pauldron_l_59
    ? new THREE.CylinderGeometry(endpoint_seam_pauldron_l_59.endRadius, endpoint_seam_pauldron_l_59.baseRadius, endpoint_seam_pauldron_l_59.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0275, -0.0, 0.01039], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [0.09077, -0.07559, 0.02425], "rx": 0.0063, "rz": 0.0063, "twist": 0.0}, {"position": [0.12693, -0.15748, 0.02803], "rx": 0.0063, "rz": 0.0063, "twist": 0.0}, {"position": [0.10274, -0.23307, 0.01795], "rx": 0.0063, "rz": 0.0063, "twist": 0.0}, {"position": [0.05424, -0.28346, 0.00126], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_seam_pauldron_l_59) {
    mesh_seam_pauldron_l_59Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seam_pauldron_l_59 = new THREE.Mesh(
    mesh_seam_pauldron_l_59Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seam_pauldron_l_59.name = "Gold seam seam-pauldron-l";
  if (endpoint_seam_pauldron_l_59) {
    mesh_seam_pauldron_l_59.position.copy(endpoint_seam_pauldron_l_59.midpoint);
    mesh_seam_pauldron_l_59.quaternion.copy(endpoint_seam_pauldron_l_59.quaternion);
  }
  mesh_seam_pauldron_l_59.castShadow = options.castShadow ?? true;
  mesh_seam_pauldron_l_59.receiveShadow = options.receiveShadow ?? true;
  mesh_seam_pauldron_l_59.userData.sculptComponent = { id: "seam-pauldron-l" };
  node_seam_pauldron_l_59.add(mesh_seam_pauldron_l_59);
  meshes["seam-pauldron-l"] = mesh_seam_pauldron_l_59;
  colliders["seam-pauldron-l"] = {};
  destructionGroups["pauldron-l"] ??= [];
  destructionGroups["pauldron-l"].push(node_seam_pauldron_l_59);

  const endpoint_seam_pauldron_in_l_60 = makeAttachmentEndpoint(null);
  const node_seam_pauldron_in_l_60 = new THREE.Group();
  node_seam_pauldron_in_l_60.name = "Gold seam seam-pauldron-in-l__pivot";
  node_seam_pauldron_in_l_60.scale.set(1, 1, 1);
  if (endpoint_seam_pauldron_in_l_60) {
    node_seam_pauldron_in_l_60.position.copy(endpoint_seam_pauldron_in_l_60.start);
    node_seam_pauldron_in_l_60.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seam_pauldron_in_l_60.position.set(0.0, 0.0, 0.0);
    node_seam_pauldron_in_l_60.rotation.set(0.0, 0.0, 0.0);
  }
  node_seam_pauldron_in_l_60.userData.sculptComponent = { id: "seam-pauldron-in-l" };
  node_seam_pauldron_in_l_60.userData.actionProfile = {};
  (nodes["pauldron-l"] ?? root).add(node_seam_pauldron_in_l_60);
  nodes["seam-pauldron-in-l"] = node_seam_pauldron_in_l_60;
  const mesh_seam_pauldron_in_l_60Geometry = endpoint_seam_pauldron_in_l_60
    ? new THREE.CylinderGeometry(endpoint_seam_pauldron_in_l_60.endRadius, endpoint_seam_pauldron_in_l_60.baseRadius, endpoint_seam_pauldron_in_l_60.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.0275, -0.0, 0.01039], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [-0.00699, -0.07559, 0.02425], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [0.00472, -0.15748, 0.02803], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [0.00498, -0.23307, 0.01795], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [0.01757, -0.28346, 0.00126], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_seam_pauldron_in_l_60) {
    mesh_seam_pauldron_in_l_60Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seam_pauldron_in_l_60 = new THREE.Mesh(
    mesh_seam_pauldron_in_l_60Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seam_pauldron_in_l_60.name = "Gold seam seam-pauldron-in-l";
  if (endpoint_seam_pauldron_in_l_60) {
    mesh_seam_pauldron_in_l_60.position.copy(endpoint_seam_pauldron_in_l_60.midpoint);
    mesh_seam_pauldron_in_l_60.quaternion.copy(endpoint_seam_pauldron_in_l_60.quaternion);
  }
  mesh_seam_pauldron_in_l_60.castShadow = options.castShadow ?? true;
  mesh_seam_pauldron_in_l_60.receiveShadow = options.receiveShadow ?? true;
  mesh_seam_pauldron_in_l_60.userData.sculptComponent = { id: "seam-pauldron-in-l" };
  node_seam_pauldron_in_l_60.add(mesh_seam_pauldron_in_l_60);
  meshes["seam-pauldron-in-l"] = mesh_seam_pauldron_in_l_60;
  colliders["seam-pauldron-in-l"] = {};
  destructionGroups["pauldron-l"] ??= [];
  destructionGroups["pauldron-l"].push(node_seam_pauldron_in_l_60);

  const endpoint_seam_bicep_l_61 = makeAttachmentEndpoint(null);
  const node_seam_bicep_l_61 = new THREE.Group();
  node_seam_bicep_l_61.name = "Gold seam seam-bicep-l__pivot";
  node_seam_bicep_l_61.scale.set(1, 1, 1);
  if (endpoint_seam_bicep_l_61) {
    node_seam_bicep_l_61.position.copy(endpoint_seam_bicep_l_61.start);
    node_seam_bicep_l_61.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seam_bicep_l_61.position.set(0.0, 0.0, 0.0);
    node_seam_bicep_l_61.rotation.set(0.0, 0.0, 0.0);
  }
  node_seam_bicep_l_61.userData.sculptComponent = { id: "seam-bicep-l" };
  node_seam_bicep_l_61.userData.actionProfile = {};
  (nodes["upper-arm-shell-l"] ?? root).add(node_seam_bicep_l_61);
  nodes["seam-bicep-l"] = node_seam_bicep_l_61;
  const mesh_seam_bicep_l_61Geometry = endpoint_seam_bicep_l_61
    ? new THREE.CylinderGeometry(endpoint_seam_bicep_l_61.endRadius, endpoint_seam_bicep_l_61.baseRadius, endpoint_seam_bicep_l_61.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.01039, -0.0, 0.01837], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [0.0825, -0.03937, 0.05814], "rx": 0.00441, "rz": 0.00441, "twist": 0.0}, {"position": [0.13902, -0.07874, 0.08567], "rx": 0.00441, "rz": 0.00441, "twist": 0.0}, {"position": [0.17218, -0.11811, 0.09483], "rx": 0.00441, "rz": 0.00441, "twist": 0.0}, {"position": [0.18456, -0.15748, 0.08766], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_seam_bicep_l_61) {
    mesh_seam_bicep_l_61Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seam_bicep_l_61 = new THREE.Mesh(
    mesh_seam_bicep_l_61Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seam_bicep_l_61.name = "Gold seam seam-bicep-l";
  if (endpoint_seam_bicep_l_61) {
    mesh_seam_bicep_l_61.position.copy(endpoint_seam_bicep_l_61.midpoint);
    mesh_seam_bicep_l_61.quaternion.copy(endpoint_seam_bicep_l_61.quaternion);
  }
  mesh_seam_bicep_l_61.castShadow = options.castShadow ?? true;
  mesh_seam_bicep_l_61.receiveShadow = options.receiveShadow ?? true;
  mesh_seam_bicep_l_61.userData.sculptComponent = { id: "seam-bicep-l" };
  node_seam_bicep_l_61.add(mesh_seam_bicep_l_61);
  meshes["seam-bicep-l"] = mesh_seam_bicep_l_61;
  colliders["seam-bicep-l"] = {};
  destructionGroups["upper-arm-shell-l"] ??= [];
  destructionGroups["upper-arm-shell-l"].push(node_seam_bicep_l_61);

  const endpoint_shoulder_joint_r_62 = makeAttachmentEndpoint(null);
  const node_shoulder_joint_r_62 = new THREE.Group();
  node_shoulder_joint_r_62.name = "Shoulder joint R__pivot";
  node_shoulder_joint_r_62.scale.set(1, 1, 1);
  if (endpoint_shoulder_joint_r_62) {
    node_shoulder_joint_r_62.position.copy(endpoint_shoulder_joint_r_62.start);
    node_shoulder_joint_r_62.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_shoulder_joint_r_62.position.set(-0.19748, 0.22677, -0.0063);
    node_shoulder_joint_r_62.rotation.set(0.0, 0.0, 0.0);
  }
  node_shoulder_joint_r_62.userData.sculptComponent = { id: "shoulder-joint-r" };
  node_shoulder_joint_r_62.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_shoulder_joint_r_62);
  nodes["shoulder-joint-r"] = node_shoulder_joint_r_62;
  const mesh_shoulder_joint_r_62Geometry = endpoint_shoulder_joint_r_62
    ? new THREE.CylinderGeometry(endpoint_shoulder_joint_r_62.endRadius, endpoint_shoulder_joint_r_62.baseRadius, endpoint_shoulder_joint_r_62.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_shoulder_joint_r_62) {
    mesh_shoulder_joint_r_62Geometry.scale(0.10079, 0.10079, 0.10079);
  }
  const mesh_shoulder_joint_r_62 = new THREE.Mesh(
    mesh_shoulder_joint_r_62Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_shoulder_joint_r_62.name = "Shoulder joint R";
  if (endpoint_shoulder_joint_r_62) {
    mesh_shoulder_joint_r_62.position.copy(endpoint_shoulder_joint_r_62.midpoint);
    mesh_shoulder_joint_r_62.quaternion.copy(endpoint_shoulder_joint_r_62.quaternion);
  }
  mesh_shoulder_joint_r_62.castShadow = options.castShadow ?? true;
  mesh_shoulder_joint_r_62.receiveShadow = options.receiveShadow ?? true;
  mesh_shoulder_joint_r_62.userData.sculptComponent = { id: "shoulder-joint-r" };
  node_shoulder_joint_r_62.add(mesh_shoulder_joint_r_62);
  meshes["shoulder-joint-r"] = mesh_shoulder_joint_r_62;
  colliders["shoulder-joint-r"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_shoulder_joint_r_62);

  const endpoint_pauldron_r_63 = makeAttachmentEndpoint(null);
  const node_pauldron_r_63 = new THREE.Group();
  node_pauldron_r_63.name = "Pauldron R__pivot";
  node_pauldron_r_63.scale.set(1, 1, 1);
  if (endpoint_pauldron_r_63) {
    node_pauldron_r_63.position.copy(endpoint_pauldron_r_63.start);
    node_pauldron_r_63.rotation.set(0.0, -0.0, 0.0);
  } else {
    node_pauldron_r_63.position.set(-0.23937, 0.34016, 0.0126);
    node_pauldron_r_63.rotation.set(0.0, -0.0, 0.0);
  }
  node_pauldron_r_63.userData.sculptComponent = { id: "pauldron-r" };
  node_pauldron_r_63.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_pauldron_r_63);
  nodes["pauldron-r"] = node_pauldron_r_63;
  const mesh_pauldron_r_63Geometry = endpoint_pauldron_r_63
    ? new THREE.CylinderGeometry(endpoint_pauldron_r_63.endRadius, endpoint_pauldron_r_63.baseRadius, endpoint_pauldron_r_63.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.03465, "rz": 0.02835, "twist": 0.0}, {"position": [-0.04189, -0.07559, 0.0063], "rx": 0.05984, "rz": 0.05039, "twist": 0.0}, {"position": [-0.06583, -0.15748, 0.0063], "rx": 0.07244, "rz": 0.06299, "twist": 0.0}, {"position": [-0.05386, -0.23307, 0.0], "rx": 0.05984, "rz": 0.05039, "twist": 0.0}, {"position": [-0.03591, -0.28346, -0.0063], "rx": 0.0252, "rz": 0.0189, "twist": 0.0}], "radialSegments": 22, "capEnds": true});
  if (!endpoint_pauldron_r_63) {
    mesh_pauldron_r_63Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_pauldron_r_63 = new THREE.Mesh(
    mesh_pauldron_r_63Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pauldron_r_63.name = "Pauldron R";
  if (endpoint_pauldron_r_63) {
    mesh_pauldron_r_63.position.copy(endpoint_pauldron_r_63.midpoint);
    mesh_pauldron_r_63.quaternion.copy(endpoint_pauldron_r_63.quaternion);
  }
  mesh_pauldron_r_63.castShadow = options.castShadow ?? true;
  mesh_pauldron_r_63.receiveShadow = options.receiveShadow ?? true;
  mesh_pauldron_r_63.userData.sculptComponent = { id: "pauldron-r" };
  node_pauldron_r_63.add(mesh_pauldron_r_63);
  meshes["pauldron-r"] = mesh_pauldron_r_63;
  colliders["pauldron-r"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_pauldron_r_63);

  const endpoint_pauldron_top_r_64 = makeAttachmentEndpoint(null);
  const node_pauldron_top_r_64 = new THREE.Group();
  node_pauldron_top_r_64.name = "Pauldron top petal R__pivot";
  node_pauldron_top_r_64.scale.set(1, 1, 1);
  if (endpoint_pauldron_top_r_64) {
    node_pauldron_top_r_64.position.copy(endpoint_pauldron_top_r_64.start);
    node_pauldron_top_r_64.rotation.set(0.0, -0.5, 0.0);
  } else {
    node_pauldron_top_r_64.position.set(-0.23339, 0.34646, 0.0252);
    node_pauldron_top_r_64.rotation.set(0.0, -0.5, 0.0);
  }
  node_pauldron_top_r_64.userData.sculptComponent = { id: "pauldron-top-r" };
  node_pauldron_top_r_64.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_pauldron_top_r_64);
  nodes["pauldron-top-r"] = node_pauldron_top_r_64;
  const mesh_pauldron_top_r_64Geometry = endpoint_pauldron_top_r_64
    ? new THREE.CylinderGeometry(endpoint_pauldron_top_r_64.endRadius, endpoint_pauldron_top_r_64.baseRadius, endpoint_pauldron_top_r_64.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.0189, "rz": 0.01575, "twist": 0.0}, {"position": [-0.02394, -0.06299, 0.0126], "rx": 0.04724, "rz": 0.04094, "twist": 0.0}, {"position": [-0.04189, -0.13228, 0.0063], "rx": 0.01575, "rz": 0.0126, "twist": 0.0}], "radialSegments": 18, "capEnds": true});
  if (!endpoint_pauldron_top_r_64) {
    mesh_pauldron_top_r_64Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_pauldron_top_r_64 = new THREE.Mesh(
    mesh_pauldron_top_r_64Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pauldron_top_r_64.name = "Pauldron top petal R";
  if (endpoint_pauldron_top_r_64) {
    mesh_pauldron_top_r_64.position.copy(endpoint_pauldron_top_r_64.midpoint);
    mesh_pauldron_top_r_64.quaternion.copy(endpoint_pauldron_top_r_64.quaternion);
  }
  mesh_pauldron_top_r_64.castShadow = options.castShadow ?? true;
  mesh_pauldron_top_r_64.receiveShadow = options.receiveShadow ?? true;
  mesh_pauldron_top_r_64.userData.sculptComponent = { id: "pauldron-top-r" };
  node_pauldron_top_r_64.add(mesh_pauldron_top_r_64);
  meshes["pauldron-top-r"] = mesh_pauldron_top_r_64;
  colliders["pauldron-top-r"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_pauldron_top_r_64);

  const endpoint_pauldron_low_r_65 = makeAttachmentEndpoint(null);
  const node_pauldron_low_r_65 = new THREE.Group();
  node_pauldron_low_r_65.name = "Pauldron lower petal R__pivot";
  node_pauldron_low_r_65.scale.set(1, 1, 1);
  if (endpoint_pauldron_low_r_65) {
    node_pauldron_low_r_65.position.copy(endpoint_pauldron_low_r_65.start);
    node_pauldron_low_r_65.rotation.set(0.0, -0.4, 0.0);
  } else {
    node_pauldron_low_r_65.position.set(-0.29323, 0.15118, 0.0126);
    node_pauldron_low_r_65.rotation.set(0.0, -0.4, 0.0);
  }
  node_pauldron_low_r_65.userData.sculptComponent = { id: "pauldron-low-r" };
  node_pauldron_low_r_65.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_pauldron_low_r_65);
  nodes["pauldron-low-r"] = node_pauldron_low_r_65;
  const mesh_pauldron_low_r_65Geometry = endpoint_pauldron_low_r_65
    ? new THREE.CylinderGeometry(endpoint_pauldron_low_r_65.endRadius, endpoint_pauldron_low_r_65.baseRadius, endpoint_pauldron_low_r_65.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.03465, "rz": 0.0252, "twist": 0.0}, {"position": [-0.01795, -0.06929, 0.0126], "rx": 0.04724, "rz": 0.04094, "twist": 0.0}, {"position": [-0.00598, -0.13858, 0.0063], "rx": 0.0252, "rz": 0.01575, "twist": 0.0}], "radialSegments": 18, "capEnds": true});
  if (!endpoint_pauldron_low_r_65) {
    mesh_pauldron_low_r_65Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_pauldron_low_r_65 = new THREE.Mesh(
    mesh_pauldron_low_r_65Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pauldron_low_r_65.name = "Pauldron lower petal R";
  if (endpoint_pauldron_low_r_65) {
    mesh_pauldron_low_r_65.position.copy(endpoint_pauldron_low_r_65.midpoint);
    mesh_pauldron_low_r_65.quaternion.copy(endpoint_pauldron_low_r_65.quaternion);
  }
  mesh_pauldron_low_r_65.castShadow = options.castShadow ?? true;
  mesh_pauldron_low_r_65.receiveShadow = options.receiveShadow ?? true;
  mesh_pauldron_low_r_65.userData.sculptComponent = { id: "pauldron-low-r" };
  node_pauldron_low_r_65.add(mesh_pauldron_low_r_65);
  meshes["pauldron-low-r"] = mesh_pauldron_low_r_65;
  colliders["pauldron-low-r"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_pauldron_low_r_65);

  const endpoint_pauldron_glow_r_66 = makeAttachmentEndpoint(null);
  const node_pauldron_glow_r_66 = new THREE.Group();
  node_pauldron_glow_r_66.name = "Pauldron glow R__pivot";
  node_pauldron_glow_r_66.scale.set(1, 1, 1);
  if (endpoint_pauldron_glow_r_66) {
    node_pauldron_glow_r_66.position.copy(endpoint_pauldron_glow_r_66.start);
    node_pauldron_glow_r_66.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_pauldron_glow_r_66.position.set(-0.29921, 0.08819, 0.06299);
    node_pauldron_glow_r_66.rotation.set(0.0, 0.0, 0.0);
  }
  node_pauldron_glow_r_66.userData.sculptComponent = { id: "pauldron-glow-r" };
  node_pauldron_glow_r_66.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_pauldron_glow_r_66);
  nodes["pauldron-glow-r"] = node_pauldron_glow_r_66;
  const mesh_pauldron_glow_r_66Geometry = endpoint_pauldron_glow_r_66
    ? new THREE.CylinderGeometry(endpoint_pauldron_glow_r_66.endRadius, endpoint_pauldron_glow_r_66.baseRadius, endpoint_pauldron_glow_r_66.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_pauldron_glow_r_66) {
    mesh_pauldron_glow_r_66Geometry.scale(0.0252, 0.05039, 0.01575);
  }
  const mesh_pauldron_glow_r_66 = new THREE.Mesh(
    mesh_pauldron_glow_r_66Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pauldron_glow_r_66.name = "Pauldron glow R";
  if (endpoint_pauldron_glow_r_66) {
    mesh_pauldron_glow_r_66.position.copy(endpoint_pauldron_glow_r_66.midpoint);
    mesh_pauldron_glow_r_66.quaternion.copy(endpoint_pauldron_glow_r_66.quaternion);
  }
  mesh_pauldron_glow_r_66.castShadow = options.castShadow ?? true;
  mesh_pauldron_glow_r_66.receiveShadow = options.receiveShadow ?? true;
  mesh_pauldron_glow_r_66.userData.sculptComponent = { id: "pauldron-glow-r" };
  node_pauldron_glow_r_66.add(mesh_pauldron_glow_r_66);
  meshes["pauldron-glow-r"] = mesh_pauldron_glow_r_66;
  colliders["pauldron-glow-r"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_pauldron_glow_r_66);

  const attachment_upper_arm_r_67 = {"parentSocket": "chest-upper-arm-r", "localStart": [-0.19748, 0.22677, -0.0063], "localEnd": [-0.37165, 0.06929, 0.06299], "contactType": "socket-joint", "baseRadius": 0.0378, "endRadius": 0.0315, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_upper_arm_r_67 = makeAttachmentEndpoint(attachment_upper_arm_r_67);
  const node_upper_arm_r_67 = new THREE.Group();
  node_upper_arm_r_67.name = "Upper arm core R__pivot";
  node_upper_arm_r_67.scale.set(1, 1, 1);
  if (endpoint_upper_arm_r_67) {
    node_upper_arm_r_67.position.copy(endpoint_upper_arm_r_67.start);
    node_upper_arm_r_67.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_upper_arm_r_67.position.set(-0.19748, 0.22677, -0.0063);
    node_upper_arm_r_67.rotation.set(0.0, 0.0, 0.0);
  }
  node_upper_arm_r_67.userData.sculptComponent = { id: "upper-arm-r" };
  node_upper_arm_r_67.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_upper_arm_r_67);
  nodes["upper-arm-r"] = node_upper_arm_r_67;
  const mesh_upper_arm_r_67Geometry = endpoint_upper_arm_r_67
    ? new THREE.CylinderGeometry(endpoint_upper_arm_r_67.endRadius, endpoint_upper_arm_r_67.baseRadius, endpoint_upper_arm_r_67.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_upper_arm_r_67) {
    mesh_upper_arm_r_67Geometry.scale(0.07559, 0.24482, 0.07559);
  }
  const mesh_upper_arm_r_67 = new THREE.Mesh(
    mesh_upper_arm_r_67Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_upper_arm_r_67.name = "Upper arm core R";
  if (endpoint_upper_arm_r_67) {
    mesh_upper_arm_r_67.position.copy(endpoint_upper_arm_r_67.midpoint);
    mesh_upper_arm_r_67.quaternion.copy(endpoint_upper_arm_r_67.quaternion);
  }
  mesh_upper_arm_r_67.castShadow = options.castShadow ?? true;
  mesh_upper_arm_r_67.receiveShadow = options.receiveShadow ?? true;
  mesh_upper_arm_r_67.userData.sculptComponent = { id: "upper-arm-r" };
  node_upper_arm_r_67.add(mesh_upper_arm_r_67);
  meshes["upper-arm-r"] = mesh_upper_arm_r_67;
  colliders["upper-arm-r"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_upper_arm_r_67);

  const endpoint_upper_arm_shell_r_68 = makeAttachmentEndpoint(null);
  const node_upper_arm_shell_r_68 = new THREE.Group();
  node_upper_arm_shell_r_68.name = "Bicep shell R__pivot";
  node_upper_arm_shell_r_68.scale.set(1, 1, 1);
  if (endpoint_upper_arm_shell_r_68) {
    node_upper_arm_shell_r_68.position.copy(endpoint_upper_arm_shell_r_68.start);
    node_upper_arm_shell_r_68.rotation.set(0.0, -0.0, 0.0);
  } else {
    node_upper_arm_shell_r_68.position.set(0.0, 0.0, 0.0);
    node_upper_arm_shell_r_68.rotation.set(0.0, -0.0, 0.0);
  }
  node_upper_arm_shell_r_68.userData.sculptComponent = { id: "upper-arm-shell-r" };
  node_upper_arm_shell_r_68.userData.actionProfile = {};
  (nodes["upper-arm-r"] ?? root).add(node_upper_arm_shell_r_68);
  nodes["upper-arm-shell-r"] = node_upper_arm_shell_r_68;
  const mesh_upper_arm_shell_r_68Geometry = endpoint_upper_arm_shell_r_68
    ? new THREE.CylinderGeometry(endpoint_upper_arm_shell_r_68.endRadius, endpoint_upper_arm_shell_r_68.baseRadius, endpoint_upper_arm_shell_r_68.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.02041, "rz": 0.01071, "twist": 0.0}, {"position": [-0.04354, -0.03937, 0.01732], "rx": 0.04535, "rz": 0.04016, "twist": 0.0}, {"position": [-0.08709, -0.07874, 0.03465], "rx": 0.05669, "rz": 0.05354, "twist": 0.0}, {"position": [-0.13063, -0.11811, 0.05197], "rx": 0.04762, "rz": 0.04283, "twist": 0.0}, {"position": [-0.17417, -0.15748, 0.06929], "rx": 0.02041, "rz": 0.01071, "twist": 0.0}], "radialSegments": 16, "capEnds": true});
  if (!endpoint_upper_arm_shell_r_68) {
    mesh_upper_arm_shell_r_68Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_upper_arm_shell_r_68 = new THREE.Mesh(
    mesh_upper_arm_shell_r_68Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_upper_arm_shell_r_68.name = "Bicep shell R";
  if (endpoint_upper_arm_shell_r_68) {
    mesh_upper_arm_shell_r_68.position.copy(endpoint_upper_arm_shell_r_68.midpoint);
    mesh_upper_arm_shell_r_68.quaternion.copy(endpoint_upper_arm_shell_r_68.quaternion);
  }
  mesh_upper_arm_shell_r_68.castShadow = options.castShadow ?? true;
  mesh_upper_arm_shell_r_68.receiveShadow = options.receiveShadow ?? true;
  mesh_upper_arm_shell_r_68.userData.sculptComponent = { id: "upper-arm-shell-r" };
  node_upper_arm_shell_r_68.add(mesh_upper_arm_shell_r_68);
  meshes["upper-arm-shell-r"] = mesh_upper_arm_shell_r_68;
  colliders["upper-arm-shell-r"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_upper_arm_shell_r_68);

  const endpoint_elbow_r_69 = makeAttachmentEndpoint(null);
  const node_elbow_r_69 = new THREE.Group();
  node_elbow_r_69.name = "Elbow joint R__pivot";
  node_elbow_r_69.scale.set(1, 1, 1);
  if (endpoint_elbow_r_69) {
    node_elbow_r_69.position.copy(endpoint_elbow_r_69.start);
    node_elbow_r_69.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_elbow_r_69.position.set(-0.17417, -0.15748, 0.06929);
    node_elbow_r_69.rotation.set(0.0, 0.0, 0.0);
  }
  node_elbow_r_69.userData.sculptComponent = { id: "elbow-r" };
  node_elbow_r_69.userData.actionProfile = {};
  (nodes["upper-arm-r"] ?? root).add(node_elbow_r_69);
  nodes["elbow-r"] = node_elbow_r_69;
  const mesh_elbow_r_69Geometry = endpoint_elbow_r_69
    ? new THREE.CylinderGeometry(endpoint_elbow_r_69.endRadius, endpoint_elbow_r_69.baseRadius, endpoint_elbow_r_69.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_elbow_r_69) {
    mesh_elbow_r_69Geometry.scale(0.08189, 0.08189, 0.08189);
  }
  const mesh_elbow_r_69 = new THREE.Mesh(
    mesh_elbow_r_69Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_elbow_r_69.name = "Elbow joint R";
  if (endpoint_elbow_r_69) {
    mesh_elbow_r_69.position.copy(endpoint_elbow_r_69.midpoint);
    mesh_elbow_r_69.quaternion.copy(endpoint_elbow_r_69.quaternion);
  }
  mesh_elbow_r_69.castShadow = options.castShadow ?? true;
  mesh_elbow_r_69.receiveShadow = options.receiveShadow ?? true;
  mesh_elbow_r_69.userData.sculptComponent = { id: "elbow-r" };
  node_elbow_r_69.add(mesh_elbow_r_69);
  meshes["elbow-r"] = mesh_elbow_r_69;
  colliders["elbow-r"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_elbow_r_69);

  const attachment_forearm_r_70 = {"parentSocket": "upper-arm-r-forearm-r", "localStart": [-0.17417, -0.15748, 0.06929], "localEnd": [-0.28126, -0.06929, 0.11339], "contactType": "hinge-joint", "baseRadius": 0.0315, "endRadius": 0.0252, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_forearm_r_70 = makeAttachmentEndpoint(attachment_forearm_r_70);
  const node_forearm_r_70 = new THREE.Group();
  node_forearm_r_70.name = "Forearm core R__pivot";
  node_forearm_r_70.scale.set(1, 1, 1);
  if (endpoint_forearm_r_70) {
    node_forearm_r_70.position.copy(endpoint_forearm_r_70.start);
    node_forearm_r_70.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_forearm_r_70.position.set(-0.17417, -0.15748, 0.06929);
    node_forearm_r_70.rotation.set(0.0, 0.0, 0.0);
  }
  node_forearm_r_70.userData.sculptComponent = { id: "forearm-r" };
  node_forearm_r_70.userData.actionProfile = {};
  (nodes["upper-arm-r"] ?? root).add(node_forearm_r_70);
  nodes["forearm-r"] = node_forearm_r_70;
  const mesh_forearm_r_70Geometry = endpoint_forearm_r_70
    ? new THREE.CylinderGeometry(endpoint_forearm_r_70.endRadius, endpoint_forearm_r_70.baseRadius, endpoint_forearm_r_70.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_forearm_r_70) {
    mesh_forearm_r_70Geometry.scale(0.06299, 0.14557, 0.06299);
  }
  const mesh_forearm_r_70 = new THREE.Mesh(
    mesh_forearm_r_70Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_forearm_r_70.name = "Forearm core R";
  if (endpoint_forearm_r_70) {
    mesh_forearm_r_70.position.copy(endpoint_forearm_r_70.midpoint);
    mesh_forearm_r_70.quaternion.copy(endpoint_forearm_r_70.quaternion);
  }
  mesh_forearm_r_70.castShadow = options.castShadow ?? true;
  mesh_forearm_r_70.receiveShadow = options.receiveShadow ?? true;
  mesh_forearm_r_70.userData.sculptComponent = { id: "forearm-r" };
  node_forearm_r_70.add(mesh_forearm_r_70);
  meshes["forearm-r"] = mesh_forearm_r_70;
  colliders["forearm-r"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_forearm_r_70);

  const endpoint_forearm_shell_r_71 = makeAttachmentEndpoint(null);
  const node_forearm_shell_r_71 = new THREE.Group();
  node_forearm_shell_r_71.name = "Forearm shell R__pivot";
  node_forearm_shell_r_71.scale.set(1, 1, 1);
  if (endpoint_forearm_shell_r_71) {
    node_forearm_shell_r_71.position.copy(endpoint_forearm_shell_r_71.start);
    node_forearm_shell_r_71.rotation.set(0.0, -0.0, 0.0);
  } else {
    node_forearm_shell_r_71.position.set(0.0, 0.0, 0.0);
    node_forearm_shell_r_71.rotation.set(0.0, -0.0, 0.0);
  }
  node_forearm_shell_r_71.userData.sculptComponent = { id: "forearm-shell-r" };
  node_forearm_shell_r_71.userData.actionProfile = {};
  (nodes["forearm-r"] ?? root).add(node_forearm_shell_r_71);
  nodes["forearm-shell-r"] = node_forearm_shell_r_71;
  const mesh_forearm_shell_r_71Geometry = endpoint_forearm_shell_r_71
    ? new THREE.CylinderGeometry(endpoint_forearm_shell_r_71.endRadius, endpoint_forearm_shell_r_71.baseRadius, endpoint_forearm_shell_r_71.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.01587, "rz": 0.00882, "twist": 0.0}, {"position": [-0.02677, 0.02205, 0.01102], "rx": 0.03528, "rz": 0.03307, "twist": 0.0}, {"position": [-0.05354, 0.04409, 0.02205], "rx": 0.04409, "rz": 0.04409, "twist": 0.0}, {"position": [-0.08032, 0.06614, 0.03307], "rx": 0.03704, "rz": 0.03528, "twist": 0.0}, {"position": [-0.10709, 0.08819, 0.04409], "rx": 0.01587, "rz": 0.00882, "twist": 0.0}], "radialSegments": 16, "capEnds": true});
  if (!endpoint_forearm_shell_r_71) {
    mesh_forearm_shell_r_71Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_forearm_shell_r_71 = new THREE.Mesh(
    mesh_forearm_shell_r_71Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_forearm_shell_r_71.name = "Forearm shell R";
  if (endpoint_forearm_shell_r_71) {
    mesh_forearm_shell_r_71.position.copy(endpoint_forearm_shell_r_71.midpoint);
    mesh_forearm_shell_r_71.quaternion.copy(endpoint_forearm_shell_r_71.quaternion);
  }
  mesh_forearm_shell_r_71.castShadow = options.castShadow ?? true;
  mesh_forearm_shell_r_71.receiveShadow = options.receiveShadow ?? true;
  mesh_forearm_shell_r_71.userData.sculptComponent = { id: "forearm-shell-r" };
  node_forearm_shell_r_71.add(mesh_forearm_shell_r_71);
  meshes["forearm-shell-r"] = mesh_forearm_shell_r_71;
  colliders["forearm-shell-r"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_forearm_shell_r_71);

  const endpoint_hand_r_72 = makeAttachmentEndpoint(null);
  const node_hand_r_72 = new THREE.Group();
  node_hand_r_72.name = "Hand R__pivot";
  node_hand_r_72.scale.set(1, 1, 1);
  if (endpoint_hand_r_72) {
    node_hand_r_72.position.copy(endpoint_hand_r_72.start);
    node_hand_r_72.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hand_r_72.position.set(-0.10709, 0.04409, 0.04409);
    node_hand_r_72.rotation.set(0.0, 0.0, 0.0);
  }
  node_hand_r_72.userData.sculptComponent = { id: "hand-r" };
  node_hand_r_72.userData.actionProfile = {};
  (nodes["forearm-r"] ?? root).add(node_hand_r_72);
  nodes["hand-r"] = node_hand_r_72;
  const mesh_hand_r_72Geometry = endpoint_hand_r_72
    ? new THREE.CylinderGeometry(endpoint_hand_r_72.endRadius, endpoint_hand_r_72.baseRadius, endpoint_hand_r_72.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_hand_r_72) {
    mesh_hand_r_72Geometry.scale(0.07559, 0.08819, 0.0378);
  }
  const mesh_hand_r_72 = new THREE.Mesh(
    mesh_hand_r_72Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hand_r_72.name = "Hand R";
  if (endpoint_hand_r_72) {
    mesh_hand_r_72.position.copy(endpoint_hand_r_72.midpoint);
    mesh_hand_r_72.quaternion.copy(endpoint_hand_r_72.quaternion);
  }
  mesh_hand_r_72.castShadow = options.castShadow ?? true;
  mesh_hand_r_72.receiveShadow = options.receiveShadow ?? true;
  mesh_hand_r_72.userData.sculptComponent = { id: "hand-r" };
  node_hand_r_72.add(mesh_hand_r_72);
  meshes["hand-r"] = mesh_hand_r_72;
  colliders["hand-r"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_hand_r_72);

  const attachment_thumb_r_1_73 = {"parentSocket": "hand-r-thumb-r-1", "localStart": [0.0315, -0.04409, 0.0189], "localEnd": [0.03849, -0.06801, 0.02264], "contactType": "rigid-weld", "baseRadius": 0.00913, "endRadius": 0.00756, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_thumb_r_1_73 = makeAttachmentEndpoint(attachment_thumb_r_1_73);
  const node_thumb_r_1_73 = new THREE.Group();
  node_thumb_r_1_73.name = "Thumb R 1__pivot";
  node_thumb_r_1_73.scale.set(1, 1, 1);
  if (endpoint_thumb_r_1_73) {
    node_thumb_r_1_73.position.copy(endpoint_thumb_r_1_73.start);
    node_thumb_r_1_73.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_thumb_r_1_73.position.set(0.0315, -0.04409, 0.0189);
    node_thumb_r_1_73.rotation.set(0.0, 0.0, 0.0);
  }
  node_thumb_r_1_73.userData.sculptComponent = { id: "thumb-r-1" };
  node_thumb_r_1_73.userData.actionProfile = {};
  (nodes["hand-r"] ?? root).add(node_thumb_r_1_73);
  nodes["thumb-r-1"] = node_thumb_r_1_73;
  const mesh_thumb_r_1_73Geometry = endpoint_thumb_r_1_73
    ? new THREE.CylinderGeometry(endpoint_thumb_r_1_73.endRadius, endpoint_thumb_r_1_73.baseRadius, endpoint_thumb_r_1_73.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_thumb_r_1_73) {
    mesh_thumb_r_1_73Geometry.scale(0.01827, 0.0252, 0.01827);
  }
  const mesh_thumb_r_1_73 = new THREE.Mesh(
    mesh_thumb_r_1_73Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_thumb_r_1_73.name = "Thumb R 1";
  if (endpoint_thumb_r_1_73) {
    mesh_thumb_r_1_73.position.copy(endpoint_thumb_r_1_73.midpoint);
    mesh_thumb_r_1_73.quaternion.copy(endpoint_thumb_r_1_73.quaternion);
  }
  mesh_thumb_r_1_73.castShadow = options.castShadow ?? true;
  mesh_thumb_r_1_73.receiveShadow = options.receiveShadow ?? true;
  mesh_thumb_r_1_73.userData.sculptComponent = { id: "thumb-r-1" };
  node_thumb_r_1_73.add(mesh_thumb_r_1_73);
  meshes["thumb-r-1"] = mesh_thumb_r_1_73;
  colliders["thumb-r-1"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_thumb_r_1_73);

  const attachment_thumb_r_2_74 = {"parentSocket": "thumb-r-1-thumb-r-2", "localStart": [0.007, -0.02391, 0.00374], "localEnd": [0.01285, -0.04391, 0.01097], "contactType": "hinge-joint", "baseRadius": 0.00756, "endRadius": 0.00598, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_thumb_r_2_74 = makeAttachmentEndpoint(attachment_thumb_r_2_74);
  const node_thumb_r_2_74 = new THREE.Group();
  node_thumb_r_2_74.name = "Thumb R 2__pivot";
  node_thumb_r_2_74.scale.set(1, 1, 1);
  if (endpoint_thumb_r_2_74) {
    node_thumb_r_2_74.position.copy(endpoint_thumb_r_2_74.start);
    node_thumb_r_2_74.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_thumb_r_2_74.position.set(0.007, -0.02391, 0.00374);
    node_thumb_r_2_74.rotation.set(0.0, 0.0, 0.0);
  }
  node_thumb_r_2_74.userData.sculptComponent = { id: "thumb-r-2" };
  node_thumb_r_2_74.userData.actionProfile = {};
  (nodes["thumb-r-1"] ?? root).add(node_thumb_r_2_74);
  nodes["thumb-r-2"] = node_thumb_r_2_74;
  const mesh_thumb_r_2_74Geometry = endpoint_thumb_r_2_74
    ? new THREE.CylinderGeometry(endpoint_thumb_r_2_74.endRadius, endpoint_thumb_r_2_74.baseRadius, endpoint_thumb_r_2_74.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_thumb_r_2_74) {
    mesh_thumb_r_2_74Geometry.scale(0.01512, 0.02205, 0.01512);
  }
  const mesh_thumb_r_2_74 = new THREE.Mesh(
    mesh_thumb_r_2_74Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_thumb_r_2_74.name = "Thumb R 2";
  if (endpoint_thumb_r_2_74) {
    mesh_thumb_r_2_74.position.copy(endpoint_thumb_r_2_74.midpoint);
    mesh_thumb_r_2_74.quaternion.copy(endpoint_thumb_r_2_74.quaternion);
  }
  mesh_thumb_r_2_74.castShadow = options.castShadow ?? true;
  mesh_thumb_r_2_74.receiveShadow = options.receiveShadow ?? true;
  mesh_thumb_r_2_74.userData.sculptComponent = { id: "thumb-r-2" };
  node_thumb_r_2_74.add(mesh_thumb_r_2_74);
  meshes["thumb-r-2"] = mesh_thumb_r_2_74;
  colliders["thumb-r-2"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_thumb_r_2_74);

  const attachment_thumb_r_3_75 = {"parentSocket": "thumb-r-2-thumb-r-3", "localStart": [0.00585, -0.01999, 0.00723], "localEnd": [0.01047, -0.03576, 0.01656], "contactType": "hinge-joint", "baseRadius": 0.00598, "endRadius": 0.00441, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_thumb_r_3_75 = makeAttachmentEndpoint(attachment_thumb_r_3_75);
  const node_thumb_r_3_75 = new THREE.Group();
  node_thumb_r_3_75.name = "Thumb R 3__pivot";
  node_thumb_r_3_75.scale.set(1, 1, 1);
  if (endpoint_thumb_r_3_75) {
    node_thumb_r_3_75.position.copy(endpoint_thumb_r_3_75.start);
    node_thumb_r_3_75.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_thumb_r_3_75.position.set(0.00585, -0.01999, 0.00723);
    node_thumb_r_3_75.rotation.set(0.0, 0.0, 0.0);
  }
  node_thumb_r_3_75.userData.sculptComponent = { id: "thumb-r-3" };
  node_thumb_r_3_75.userData.actionProfile = {};
  (nodes["thumb-r-2"] ?? root).add(node_thumb_r_3_75);
  nodes["thumb-r-3"] = node_thumb_r_3_75;
  const mesh_thumb_r_3_75Geometry = endpoint_thumb_r_3_75
    ? new THREE.CylinderGeometry(endpoint_thumb_r_3_75.endRadius, endpoint_thumb_r_3_75.baseRadius, endpoint_thumb_r_3_75.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_thumb_r_3_75) {
    mesh_thumb_r_3_75Geometry.scale(0.01197, 0.0189, 0.01197);
  }
  const mesh_thumb_r_3_75 = new THREE.Mesh(
    mesh_thumb_r_3_75Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_thumb_r_3_75.name = "Thumb R 3";
  if (endpoint_thumb_r_3_75) {
    mesh_thumb_r_3_75.position.copy(endpoint_thumb_r_3_75.midpoint);
    mesh_thumb_r_3_75.quaternion.copy(endpoint_thumb_r_3_75.quaternion);
  }
  mesh_thumb_r_3_75.castShadow = options.castShadow ?? true;
  mesh_thumb_r_3_75.receiveShadow = options.receiveShadow ?? true;
  mesh_thumb_r_3_75.userData.sculptComponent = { id: "thumb-r-3" };
  node_thumb_r_3_75.add(mesh_thumb_r_3_75);
  meshes["thumb-r-3"] = mesh_thumb_r_3_75;
  colliders["thumb-r-3"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_thumb_r_3_75);

  const attachment_index_r_1_76 = {"parentSocket": "hand-r-index-r-1", "localStart": [0.02205, -0.04409, 0.0126], "localEnd": [0.025, -0.072, 0.01658], "contactType": "rigid-weld", "baseRadius": 0.00913, "endRadius": 0.00756, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_index_r_1_76 = makeAttachmentEndpoint(attachment_index_r_1_76);
  const node_index_r_1_76 = new THREE.Group();
  node_index_r_1_76.name = "Index R 1__pivot";
  node_index_r_1_76.scale.set(1, 1, 1);
  if (endpoint_index_r_1_76) {
    node_index_r_1_76.position.copy(endpoint_index_r_1_76.start);
    node_index_r_1_76.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_index_r_1_76.position.set(0.02205, -0.04409, 0.0126);
    node_index_r_1_76.rotation.set(0.0, 0.0, 0.0);
  }
  node_index_r_1_76.userData.sculptComponent = { id: "index-r-1" };
  node_index_r_1_76.userData.actionProfile = {};
  (nodes["hand-r"] ?? root).add(node_index_r_1_76);
  nodes["index-r-1"] = node_index_r_1_76;
  const mesh_index_r_1_76Geometry = endpoint_index_r_1_76
    ? new THREE.CylinderGeometry(endpoint_index_r_1_76.endRadius, endpoint_index_r_1_76.baseRadius, endpoint_index_r_1_76.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_index_r_1_76) {
    mesh_index_r_1_76Geometry.scale(0.01827, 0.02835, 0.01827);
  }
  const mesh_index_r_1_76 = new THREE.Mesh(
    mesh_index_r_1_76Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_index_r_1_76.name = "Index R 1";
  if (endpoint_index_r_1_76) {
    mesh_index_r_1_76.position.copy(endpoint_index_r_1_76.midpoint);
    mesh_index_r_1_76.quaternion.copy(endpoint_index_r_1_76.quaternion);
  }
  mesh_index_r_1_76.castShadow = options.castShadow ?? true;
  mesh_index_r_1_76.receiveShadow = options.receiveShadow ?? true;
  mesh_index_r_1_76.userData.sculptComponent = { id: "index-r-1" };
  node_index_r_1_76.add(mesh_index_r_1_76);
  meshes["index-r-1"] = mesh_index_r_1_76;
  colliders["index-r-1"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_index_r_1_76);

  const attachment_index_r_2_77 = {"parentSocket": "index-r-1-index-r-2", "localStart": [0.00295, -0.02791, 0.00398], "localEnd": [0.00516, -0.04874, 0.01086], "contactType": "hinge-joint", "baseRadius": 0.00756, "endRadius": 0.00598, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_index_r_2_77 = makeAttachmentEndpoint(attachment_index_r_2_77);
  const node_index_r_2_77 = new THREE.Group();
  node_index_r_2_77.name = "Index R 2__pivot";
  node_index_r_2_77.scale.set(1, 1, 1);
  if (endpoint_index_r_2_77) {
    node_index_r_2_77.position.copy(endpoint_index_r_2_77.start);
    node_index_r_2_77.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_index_r_2_77.position.set(0.00295, -0.02791, 0.00398);
    node_index_r_2_77.rotation.set(0.0, 0.0, 0.0);
  }
  node_index_r_2_77.userData.sculptComponent = { id: "index-r-2" };
  node_index_r_2_77.userData.actionProfile = {};
  (nodes["index-r-1"] ?? root).add(node_index_r_2_77);
  nodes["index-r-2"] = node_index_r_2_77;
  const mesh_index_r_2_77Geometry = endpoint_index_r_2_77
    ? new THREE.CylinderGeometry(endpoint_index_r_2_77.endRadius, endpoint_index_r_2_77.baseRadius, endpoint_index_r_2_77.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_index_r_2_77) {
    mesh_index_r_2_77Geometry.scale(0.01512, 0.02205, 0.01512);
  }
  const mesh_index_r_2_77 = new THREE.Mesh(
    mesh_index_r_2_77Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_index_r_2_77.name = "Index R 2";
  if (endpoint_index_r_2_77) {
    mesh_index_r_2_77.position.copy(endpoint_index_r_2_77.midpoint);
    mesh_index_r_2_77.quaternion.copy(endpoint_index_r_2_77.quaternion);
  }
  mesh_index_r_2_77.castShadow = options.castShadow ?? true;
  mesh_index_r_2_77.receiveShadow = options.receiveShadow ?? true;
  mesh_index_r_2_77.userData.sculptComponent = { id: "index-r-2" };
  node_index_r_2_77.add(mesh_index_r_2_77);
  meshes["index-r-2"] = mesh_index_r_2_77;
  colliders["index-r-2"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_index_r_2_77);

  const attachment_index_r_3_78 = {"parentSocket": "index-r-2-index-r-3", "localStart": [0.0022, -0.02083, 0.00687], "localEnd": [0.00396, -0.03739, 0.01581], "contactType": "hinge-joint", "baseRadius": 0.00598, "endRadius": 0.00441, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_index_r_3_78 = makeAttachmentEndpoint(attachment_index_r_3_78);
  const node_index_r_3_78 = new THREE.Group();
  node_index_r_3_78.name = "Index R 3__pivot";
  node_index_r_3_78.scale.set(1, 1, 1);
  if (endpoint_index_r_3_78) {
    node_index_r_3_78.position.copy(endpoint_index_r_3_78.start);
    node_index_r_3_78.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_index_r_3_78.position.set(0.0022, -0.02083, 0.00687);
    node_index_r_3_78.rotation.set(0.0, 0.0, 0.0);
  }
  node_index_r_3_78.userData.sculptComponent = { id: "index-r-3" };
  node_index_r_3_78.userData.actionProfile = {};
  (nodes["index-r-2"] ?? root).add(node_index_r_3_78);
  nodes["index-r-3"] = node_index_r_3_78;
  const mesh_index_r_3_78Geometry = endpoint_index_r_3_78
    ? new THREE.CylinderGeometry(endpoint_index_r_3_78.endRadius, endpoint_index_r_3_78.baseRadius, endpoint_index_r_3_78.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_index_r_3_78) {
    mesh_index_r_3_78Geometry.scale(0.01197, 0.0189, 0.01197);
  }
  const mesh_index_r_3_78 = new THREE.Mesh(
    mesh_index_r_3_78Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_index_r_3_78.name = "Index R 3";
  if (endpoint_index_r_3_78) {
    mesh_index_r_3_78.position.copy(endpoint_index_r_3_78.midpoint);
    mesh_index_r_3_78.quaternion.copy(endpoint_index_r_3_78.quaternion);
  }
  mesh_index_r_3_78.castShadow = options.castShadow ?? true;
  mesh_index_r_3_78.receiveShadow = options.receiveShadow ?? true;
  mesh_index_r_3_78.userData.sculptComponent = { id: "index-r-3" };
  node_index_r_3_78.add(mesh_index_r_3_78);
  meshes["index-r-3"] = mesh_index_r_3_78;
  colliders["index-r-3"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_index_r_3_78);

  const attachment_middle_r_1_79 = {"parentSocket": "hand-r-middle-r-1", "localStart": [0.00315, -0.04409, 0.0126], "localEnd": [0.00315, -0.07528, 0.01698], "contactType": "rigid-weld", "baseRadius": 0.00913, "endRadius": 0.00756, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_middle_r_1_79 = makeAttachmentEndpoint(attachment_middle_r_1_79);
  const node_middle_r_1_79 = new THREE.Group();
  node_middle_r_1_79.name = "Middle R 1__pivot";
  node_middle_r_1_79.scale.set(1, 1, 1);
  if (endpoint_middle_r_1_79) {
    node_middle_r_1_79.position.copy(endpoint_middle_r_1_79.start);
    node_middle_r_1_79.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_middle_r_1_79.position.set(0.00315, -0.04409, 0.0126);
    node_middle_r_1_79.rotation.set(0.0, 0.0, 0.0);
  }
  node_middle_r_1_79.userData.sculptComponent = { id: "middle-r-1" };
  node_middle_r_1_79.userData.actionProfile = {};
  (nodes["hand-r"] ?? root).add(node_middle_r_1_79);
  nodes["middle-r-1"] = node_middle_r_1_79;
  const mesh_middle_r_1_79Geometry = endpoint_middle_r_1_79
    ? new THREE.CylinderGeometry(endpoint_middle_r_1_79.endRadius, endpoint_middle_r_1_79.baseRadius, endpoint_middle_r_1_79.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_middle_r_1_79) {
    mesh_middle_r_1_79Geometry.scale(0.01827, 0.0315, 0.01827);
  }
  const mesh_middle_r_1_79 = new THREE.Mesh(
    mesh_middle_r_1_79Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_middle_r_1_79.name = "Middle R 1";
  if (endpoint_middle_r_1_79) {
    mesh_middle_r_1_79.position.copy(endpoint_middle_r_1_79.midpoint);
    mesh_middle_r_1_79.quaternion.copy(endpoint_middle_r_1_79.quaternion);
  }
  mesh_middle_r_1_79.castShadow = options.castShadow ?? true;
  mesh_middle_r_1_79.receiveShadow = options.receiveShadow ?? true;
  mesh_middle_r_1_79.userData.sculptComponent = { id: "middle-r-1" };
  node_middle_r_1_79.add(mesh_middle_r_1_79);
  meshes["middle-r-1"] = mesh_middle_r_1_79;
  colliders["middle-r-1"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_middle_r_1_79);

  const attachment_middle_r_2_80 = {"parentSocket": "middle-r-1-middle-r-2", "localStart": [0.0, -0.03119, 0.00438], "localEnd": [0.0, -0.05515, 0.01217], "contactType": "hinge-joint", "baseRadius": 0.00756, "endRadius": 0.00598, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_middle_r_2_80 = makeAttachmentEndpoint(attachment_middle_r_2_80);
  const node_middle_r_2_80 = new THREE.Group();
  node_middle_r_2_80.name = "Middle R 2__pivot";
  node_middle_r_2_80.scale.set(1, 1, 1);
  if (endpoint_middle_r_2_80) {
    node_middle_r_2_80.position.copy(endpoint_middle_r_2_80.start);
    node_middle_r_2_80.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_middle_r_2_80.position.set(0.0, -0.03119, 0.00438);
    node_middle_r_2_80.rotation.set(0.0, 0.0, 0.0);
  }
  node_middle_r_2_80.userData.sculptComponent = { id: "middle-r-2" };
  node_middle_r_2_80.userData.actionProfile = {};
  (nodes["middle-r-1"] ?? root).add(node_middle_r_2_80);
  nodes["middle-r-2"] = node_middle_r_2_80;
  const mesh_middle_r_2_80Geometry = endpoint_middle_r_2_80
    ? new THREE.CylinderGeometry(endpoint_middle_r_2_80.endRadius, endpoint_middle_r_2_80.baseRadius, endpoint_middle_r_2_80.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_middle_r_2_80) {
    mesh_middle_r_2_80Geometry.scale(0.01512, 0.0252, 0.01512);
  }
  const mesh_middle_r_2_80 = new THREE.Mesh(
    mesh_middle_r_2_80Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_middle_r_2_80.name = "Middle R 2";
  if (endpoint_middle_r_2_80) {
    mesh_middle_r_2_80.position.copy(endpoint_middle_r_2_80.midpoint);
    mesh_middle_r_2_80.quaternion.copy(endpoint_middle_r_2_80.quaternion);
  }
  mesh_middle_r_2_80.castShadow = options.castShadow ?? true;
  mesh_middle_r_2_80.receiveShadow = options.receiveShadow ?? true;
  mesh_middle_r_2_80.userData.sculptComponent = { id: "middle-r-2" };
  node_middle_r_2_80.add(mesh_middle_r_2_80);
  meshes["middle-r-2"] = mesh_middle_r_2_80;
  colliders["middle-r-2"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_middle_r_2_80);

  const attachment_middle_r_3_81 = {"parentSocket": "middle-r-2-middle-r-3", "localStart": [0.0, -0.02396, 0.00779], "localEnd": [0.0, -0.04065, 0.01666], "contactType": "hinge-joint", "baseRadius": 0.00598, "endRadius": 0.00441, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_middle_r_3_81 = makeAttachmentEndpoint(attachment_middle_r_3_81);
  const node_middle_r_3_81 = new THREE.Group();
  node_middle_r_3_81.name = "Middle R 3__pivot";
  node_middle_r_3_81.scale.set(1, 1, 1);
  if (endpoint_middle_r_3_81) {
    node_middle_r_3_81.position.copy(endpoint_middle_r_3_81.start);
    node_middle_r_3_81.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_middle_r_3_81.position.set(0.0, -0.02396, 0.00779);
    node_middle_r_3_81.rotation.set(0.0, 0.0, 0.0);
  }
  node_middle_r_3_81.userData.sculptComponent = { id: "middle-r-3" };
  node_middle_r_3_81.userData.actionProfile = {};
  (nodes["middle-r-2"] ?? root).add(node_middle_r_3_81);
  nodes["middle-r-3"] = node_middle_r_3_81;
  const mesh_middle_r_3_81Geometry = endpoint_middle_r_3_81
    ? new THREE.CylinderGeometry(endpoint_middle_r_3_81.endRadius, endpoint_middle_r_3_81.baseRadius, endpoint_middle_r_3_81.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_middle_r_3_81) {
    mesh_middle_r_3_81Geometry.scale(0.01197, 0.0189, 0.01197);
  }
  const mesh_middle_r_3_81 = new THREE.Mesh(
    mesh_middle_r_3_81Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_middle_r_3_81.name = "Middle R 3";
  if (endpoint_middle_r_3_81) {
    mesh_middle_r_3_81.position.copy(endpoint_middle_r_3_81.midpoint);
    mesh_middle_r_3_81.quaternion.copy(endpoint_middle_r_3_81.quaternion);
  }
  mesh_middle_r_3_81.castShadow = options.castShadow ?? true;
  mesh_middle_r_3_81.receiveShadow = options.receiveShadow ?? true;
  mesh_middle_r_3_81.userData.sculptComponent = { id: "middle-r-3" };
  node_middle_r_3_81.add(mesh_middle_r_3_81);
  meshes["middle-r-3"] = mesh_middle_r_3_81;
  colliders["middle-r-3"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_middle_r_3_81);

  const attachment_ring_r_1_82 = {"parentSocket": "hand-r-ring-r-1", "localStart": [-0.01575, -0.04409, 0.0126], "localEnd": [-0.01811, -0.07206, 0.01657], "contactType": "rigid-weld", "baseRadius": 0.00913, "endRadius": 0.00756, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_ring_r_1_82 = makeAttachmentEndpoint(attachment_ring_r_1_82);
  const node_ring_r_1_82 = new THREE.Group();
  node_ring_r_1_82.name = "Ring R 1__pivot";
  node_ring_r_1_82.scale.set(1, 1, 1);
  if (endpoint_ring_r_1_82) {
    node_ring_r_1_82.position.copy(endpoint_ring_r_1_82.start);
    node_ring_r_1_82.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_ring_r_1_82.position.set(-0.01575, -0.04409, 0.0126);
    node_ring_r_1_82.rotation.set(0.0, 0.0, 0.0);
  }
  node_ring_r_1_82.userData.sculptComponent = { id: "ring-r-1" };
  node_ring_r_1_82.userData.actionProfile = {};
  (nodes["hand-r"] ?? root).add(node_ring_r_1_82);
  nodes["ring-r-1"] = node_ring_r_1_82;
  const mesh_ring_r_1_82Geometry = endpoint_ring_r_1_82
    ? new THREE.CylinderGeometry(endpoint_ring_r_1_82.endRadius, endpoint_ring_r_1_82.baseRadius, endpoint_ring_r_1_82.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_ring_r_1_82) {
    mesh_ring_r_1_82Geometry.scale(0.01827, 0.02835, 0.01827);
  }
  const mesh_ring_r_1_82 = new THREE.Mesh(
    mesh_ring_r_1_82Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ring_r_1_82.name = "Ring R 1";
  if (endpoint_ring_r_1_82) {
    mesh_ring_r_1_82.position.copy(endpoint_ring_r_1_82.midpoint);
    mesh_ring_r_1_82.quaternion.copy(endpoint_ring_r_1_82.quaternion);
  }
  mesh_ring_r_1_82.castShadow = options.castShadow ?? true;
  mesh_ring_r_1_82.receiveShadow = options.receiveShadow ?? true;
  mesh_ring_r_1_82.userData.sculptComponent = { id: "ring-r-1" };
  node_ring_r_1_82.add(mesh_ring_r_1_82);
  meshes["ring-r-1"] = mesh_ring_r_1_82;
  colliders["ring-r-1"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_ring_r_1_82);

  const attachment_ring_r_2_83 = {"parentSocket": "ring-r-1-ring-r-2", "localStart": [-0.00236, -0.02797, 0.00397], "localEnd": [-0.00412, -0.04885, 0.01082], "contactType": "hinge-joint", "baseRadius": 0.00756, "endRadius": 0.00598, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_ring_r_2_83 = makeAttachmentEndpoint(attachment_ring_r_2_83);
  const node_ring_r_2_83 = new THREE.Group();
  node_ring_r_2_83.name = "Ring R 2__pivot";
  node_ring_r_2_83.scale.set(1, 1, 1);
  if (endpoint_ring_r_2_83) {
    node_ring_r_2_83.position.copy(endpoint_ring_r_2_83.start);
    node_ring_r_2_83.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_ring_r_2_83.position.set(-0.00236, -0.02797, 0.00397);
    node_ring_r_2_83.rotation.set(0.0, 0.0, 0.0);
  }
  node_ring_r_2_83.userData.sculptComponent = { id: "ring-r-2" };
  node_ring_r_2_83.userData.actionProfile = {};
  (nodes["ring-r-1"] ?? root).add(node_ring_r_2_83);
  nodes["ring-r-2"] = node_ring_r_2_83;
  const mesh_ring_r_2_83Geometry = endpoint_ring_r_2_83
    ? new THREE.CylinderGeometry(endpoint_ring_r_2_83.endRadius, endpoint_ring_r_2_83.baseRadius, endpoint_ring_r_2_83.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_ring_r_2_83) {
    mesh_ring_r_2_83Geometry.scale(0.01512, 0.02205, 0.01512);
  }
  const mesh_ring_r_2_83 = new THREE.Mesh(
    mesh_ring_r_2_83Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ring_r_2_83.name = "Ring R 2";
  if (endpoint_ring_r_2_83) {
    mesh_ring_r_2_83.position.copy(endpoint_ring_r_2_83.midpoint);
    mesh_ring_r_2_83.quaternion.copy(endpoint_ring_r_2_83.quaternion);
  }
  mesh_ring_r_2_83.castShadow = options.castShadow ?? true;
  mesh_ring_r_2_83.receiveShadow = options.receiveShadow ?? true;
  mesh_ring_r_2_83.userData.sculptComponent = { id: "ring-r-2" };
  node_ring_r_2_83.add(mesh_ring_r_2_83);
  meshes["ring-r-2"] = mesh_ring_r_2_83;
  colliders["ring-r-2"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_ring_r_2_83);

  const attachment_ring_r_3_84 = {"parentSocket": "ring-r-2-ring-r-3", "localStart": [-0.00176, -0.02088, 0.00685], "localEnd": [-0.00316, -0.03749, 0.01577], "contactType": "hinge-joint", "baseRadius": 0.00598, "endRadius": 0.00441, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_ring_r_3_84 = makeAttachmentEndpoint(attachment_ring_r_3_84);
  const node_ring_r_3_84 = new THREE.Group();
  node_ring_r_3_84.name = "Ring R 3__pivot";
  node_ring_r_3_84.scale.set(1, 1, 1);
  if (endpoint_ring_r_3_84) {
    node_ring_r_3_84.position.copy(endpoint_ring_r_3_84.start);
    node_ring_r_3_84.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_ring_r_3_84.position.set(-0.00176, -0.02088, 0.00685);
    node_ring_r_3_84.rotation.set(0.0, 0.0, 0.0);
  }
  node_ring_r_3_84.userData.sculptComponent = { id: "ring-r-3" };
  node_ring_r_3_84.userData.actionProfile = {};
  (nodes["ring-r-2"] ?? root).add(node_ring_r_3_84);
  nodes["ring-r-3"] = node_ring_r_3_84;
  const mesh_ring_r_3_84Geometry = endpoint_ring_r_3_84
    ? new THREE.CylinderGeometry(endpoint_ring_r_3_84.endRadius, endpoint_ring_r_3_84.baseRadius, endpoint_ring_r_3_84.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_ring_r_3_84) {
    mesh_ring_r_3_84Geometry.scale(0.01197, 0.0189, 0.01197);
  }
  const mesh_ring_r_3_84 = new THREE.Mesh(
    mesh_ring_r_3_84Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ring_r_3_84.name = "Ring R 3";
  if (endpoint_ring_r_3_84) {
    mesh_ring_r_3_84.position.copy(endpoint_ring_r_3_84.midpoint);
    mesh_ring_r_3_84.quaternion.copy(endpoint_ring_r_3_84.quaternion);
  }
  mesh_ring_r_3_84.castShadow = options.castShadow ?? true;
  mesh_ring_r_3_84.receiveShadow = options.receiveShadow ?? true;
  mesh_ring_r_3_84.userData.sculptComponent = { id: "ring-r-3" };
  node_ring_r_3_84.add(mesh_ring_r_3_84);
  meshes["ring-r-3"] = mesh_ring_r_3_84;
  colliders["ring-r-3"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_ring_r_3_84);

  const attachment_little_r_1_85 = {"parentSocket": "hand-r-little-r-1", "localStart": [-0.0315, -0.04409, 0.00945], "localEnd": [-0.0352, -0.0656, 0.01259], "contactType": "rigid-weld", "baseRadius": 0.00913, "endRadius": 0.00756, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_little_r_1_85 = makeAttachmentEndpoint(attachment_little_r_1_85);
  const node_little_r_1_85 = new THREE.Group();
  node_little_r_1_85.name = "Little R 1__pivot";
  node_little_r_1_85.scale.set(1, 1, 1);
  if (endpoint_little_r_1_85) {
    node_little_r_1_85.position.copy(endpoint_little_r_1_85.start);
    node_little_r_1_85.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_little_r_1_85.position.set(-0.0315, -0.04409, 0.00945);
    node_little_r_1_85.rotation.set(0.0, 0.0, 0.0);
  }
  node_little_r_1_85.userData.sculptComponent = { id: "little-r-1" };
  node_little_r_1_85.userData.actionProfile = {};
  (nodes["hand-r"] ?? root).add(node_little_r_1_85);
  nodes["little-r-1"] = node_little_r_1_85;
  const mesh_little_r_1_85Geometry = endpoint_little_r_1_85
    ? new THREE.CylinderGeometry(endpoint_little_r_1_85.endRadius, endpoint_little_r_1_85.baseRadius, endpoint_little_r_1_85.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_little_r_1_85) {
    mesh_little_r_1_85Geometry.scale(0.01827, 0.02205, 0.01827);
  }
  const mesh_little_r_1_85 = new THREE.Mesh(
    mesh_little_r_1_85Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_little_r_1_85.name = "Little R 1";
  if (endpoint_little_r_1_85) {
    mesh_little_r_1_85.position.copy(endpoint_little_r_1_85.midpoint);
    mesh_little_r_1_85.quaternion.copy(endpoint_little_r_1_85.quaternion);
  }
  mesh_little_r_1_85.castShadow = options.castShadow ?? true;
  mesh_little_r_1_85.receiveShadow = options.receiveShadow ?? true;
  mesh_little_r_1_85.userData.sculptComponent = { id: "little-r-1" };
  node_little_r_1_85.add(mesh_little_r_1_85);
  meshes["little-r-1"] = mesh_little_r_1_85;
  colliders["little-r-1"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_little_r_1_85);

  const attachment_little_r_2_86 = {"parentSocket": "little-r-1-little-r-2", "localStart": [-0.0037, -0.02151, 0.00314], "localEnd": [-0.00623, -0.03623, 0.00812], "contactType": "hinge-joint", "baseRadius": 0.00756, "endRadius": 0.00598, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_little_r_2_86 = makeAttachmentEndpoint(attachment_little_r_2_86);
  const node_little_r_2_86 = new THREE.Group();
  node_little_r_2_86.name = "Little R 2__pivot";
  node_little_r_2_86.scale.set(1, 1, 1);
  if (endpoint_little_r_2_86) {
    node_little_r_2_86.position.copy(endpoint_little_r_2_86.start);
    node_little_r_2_86.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_little_r_2_86.position.set(-0.0037, -0.02151, 0.00314);
    node_little_r_2_86.rotation.set(0.0, 0.0, 0.0);
  }
  node_little_r_2_86.userData.sculptComponent = { id: "little-r-2" };
  node_little_r_2_86.userData.actionProfile = {};
  (nodes["little-r-1"] ?? root).add(node_little_r_2_86);
  nodes["little-r-2"] = node_little_r_2_86;
  const mesh_little_r_2_86Geometry = endpoint_little_r_2_86
    ? new THREE.CylinderGeometry(endpoint_little_r_2_86.endRadius, endpoint_little_r_2_86.baseRadius, endpoint_little_r_2_86.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_little_r_2_86) {
    mesh_little_r_2_86Geometry.scale(0.01512, 0.01575, 0.01512);
  }
  const mesh_little_r_2_86 = new THREE.Mesh(
    mesh_little_r_2_86Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_little_r_2_86.name = "Little R 2";
  if (endpoint_little_r_2_86) {
    mesh_little_r_2_86.position.copy(endpoint_little_r_2_86.midpoint);
    mesh_little_r_2_86.quaternion.copy(endpoint_little_r_2_86.quaternion);
  }
  mesh_little_r_2_86.castShadow = options.castShadow ?? true;
  mesh_little_r_2_86.receiveShadow = options.receiveShadow ?? true;
  mesh_little_r_2_86.userData.sculptComponent = { id: "little-r-2" };
  node_little_r_2_86.add(mesh_little_r_2_86);
  meshes["little-r-2"] = mesh_little_r_2_86;
  colliders["little-r-2"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_little_r_2_86);

  const attachment_little_r_3_87 = {"parentSocket": "little-r-2-little-r-3", "localStart": [-0.00253, -0.01472, 0.00498], "localEnd": [-0.00488, -0.02835, 0.01251], "contactType": "hinge-joint", "baseRadius": 0.00598, "endRadius": 0.00441, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_little_r_3_87 = makeAttachmentEndpoint(attachment_little_r_3_87);
  const node_little_r_3_87 = new THREE.Group();
  node_little_r_3_87.name = "Little R 3__pivot";
  node_little_r_3_87.scale.set(1, 1, 1);
  if (endpoint_little_r_3_87) {
    node_little_r_3_87.position.copy(endpoint_little_r_3_87.start);
    node_little_r_3_87.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_little_r_3_87.position.set(-0.00253, -0.01472, 0.00498);
    node_little_r_3_87.rotation.set(0.0, 0.0, 0.0);
  }
  node_little_r_3_87.userData.sculptComponent = { id: "little-r-3" };
  node_little_r_3_87.userData.actionProfile = {};
  (nodes["little-r-2"] ?? root).add(node_little_r_3_87);
  nodes["little-r-3"] = node_little_r_3_87;
  const mesh_little_r_3_87Geometry = endpoint_little_r_3_87
    ? new THREE.CylinderGeometry(endpoint_little_r_3_87.endRadius, endpoint_little_r_3_87.baseRadius, endpoint_little_r_3_87.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_little_r_3_87) {
    mesh_little_r_3_87Geometry.scale(0.01197, 0.01575, 0.01197);
  }
  const mesh_little_r_3_87 = new THREE.Mesh(
    mesh_little_r_3_87Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_little_r_3_87.name = "Little R 3";
  if (endpoint_little_r_3_87) {
    mesh_little_r_3_87.position.copy(endpoint_little_r_3_87.midpoint);
    mesh_little_r_3_87.quaternion.copy(endpoint_little_r_3_87.quaternion);
  }
  mesh_little_r_3_87.castShadow = options.castShadow ?? true;
  mesh_little_r_3_87.receiveShadow = options.receiveShadow ?? true;
  mesh_little_r_3_87.userData.sculptComponent = { id: "little-r-3" };
  node_little_r_3_87.add(mesh_little_r_3_87);
  meshes["little-r-3"] = mesh_little_r_3_87;
  colliders["little-r-3"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_little_r_3_87);

  const endpoint_seam_chest_r_88 = makeAttachmentEndpoint(null);
  const node_seam_chest_r_88 = new THREE.Group();
  node_seam_chest_r_88.name = "Gold seam seam-chest-r__pivot";
  node_seam_chest_r_88.scale.set(1, 1, 1);
  if (endpoint_seam_chest_r_88) {
    node_seam_chest_r_88.position.copy(endpoint_seam_chest_r_88.start);
    node_seam_chest_r_88.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seam_chest_r_88.position.set(0.0, 0.0, 0.0);
    node_seam_chest_r_88.rotation.set(0.0, 0.0, 0.0);
  }
  node_seam_chest_r_88.userData.sculptComponent = { id: "seam-chest-r" };
  node_seam_chest_r_88.userData.actionProfile = {};
  (nodes["chest-shell-r"] ?? root).add(node_seam_chest_r_88);
  nodes["seam-chest-r"] = node_seam_chest_r_88;
  const mesh_seam_chest_r_88Geometry = endpoint_seam_chest_r_88
    ? new THREE.CylinderGeometry(endpoint_seam_chest_r_88.endRadius, endpoint_seam_chest_r_88.baseRadius, endpoint_seam_chest_r_88.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.06385, -0.0, 0.04057], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [0.09341, -0.06929, 0.08945], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [0.11173, -0.17008, 0.10205], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [0.10664, -0.26457, 0.07257], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_seam_chest_r_88) {
    mesh_seam_chest_r_88Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seam_chest_r_88 = new THREE.Mesh(
    mesh_seam_chest_r_88Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seam_chest_r_88.name = "Gold seam seam-chest-r";
  if (endpoint_seam_chest_r_88) {
    mesh_seam_chest_r_88.position.copy(endpoint_seam_chest_r_88.midpoint);
    mesh_seam_chest_r_88.quaternion.copy(endpoint_seam_chest_r_88.quaternion);
  }
  mesh_seam_chest_r_88.castShadow = options.castShadow ?? true;
  mesh_seam_chest_r_88.receiveShadow = options.receiveShadow ?? true;
  mesh_seam_chest_r_88.userData.sculptComponent = { id: "seam-chest-r" };
  node_seam_chest_r_88.add(mesh_seam_chest_r_88);
  meshes["seam-chest-r"] = mesh_seam_chest_r_88;
  colliders["seam-chest-r"] = {};
  destructionGroups["chest-shell-r"] ??= [];
  destructionGroups["chest-shell-r"].push(node_seam_chest_r_88);

  const endpoint_seam_chest_out_r_89 = makeAttachmentEndpoint(null);
  const node_seam_chest_out_r_89 = new THREE.Group();
  node_seam_chest_out_r_89.name = "Gold seam seam-chest-out-r__pivot";
  node_seam_chest_out_r_89.scale.set(1, 1, 1);
  if (endpoint_seam_chest_out_r_89) {
    node_seam_chest_out_r_89.position.copy(endpoint_seam_chest_out_r_89.start);
    node_seam_chest_out_r_89.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seam_chest_out_r_89.position.set(0.0, 0.0, 0.0);
    node_seam_chest_out_r_89.rotation.set(0.0, 0.0, 0.0);
  }
  node_seam_chest_out_r_89.userData.sculptComponent = { id: "seam-chest-out-r" };
  node_seam_chest_out_r_89.userData.actionProfile = {};
  (nodes["chest-shell-r"] ?? root).add(node_seam_chest_out_r_89);
  nodes["seam-chest-out-r"] = node_seam_chest_out_r_89;
  const mesh_seam_chest_out_r_89Geometry = endpoint_seam_chest_out_r_89
    ? new THREE.CylinderGeometry(endpoint_seam_chest_out_r_89.endRadius, endpoint_seam_chest_out_r_89.baseRadius, endpoint_seam_chest_out_r_89.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.06385, -0.0, 0.04057], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [-0.05751, -0.06929, 0.08945], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [-0.01598, -0.17008, 0.10205], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [0.03698, -0.26457, 0.07257], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_seam_chest_out_r_89) {
    mesh_seam_chest_out_r_89Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seam_chest_out_r_89 = new THREE.Mesh(
    mesh_seam_chest_out_r_89Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seam_chest_out_r_89.name = "Gold seam seam-chest-out-r";
  if (endpoint_seam_chest_out_r_89) {
    mesh_seam_chest_out_r_89.position.copy(endpoint_seam_chest_out_r_89.midpoint);
    mesh_seam_chest_out_r_89.quaternion.copy(endpoint_seam_chest_out_r_89.quaternion);
  }
  mesh_seam_chest_out_r_89.castShadow = options.castShadow ?? true;
  mesh_seam_chest_out_r_89.receiveShadow = options.receiveShadow ?? true;
  mesh_seam_chest_out_r_89.userData.sculptComponent = { id: "seam-chest-out-r" };
  node_seam_chest_out_r_89.add(mesh_seam_chest_out_r_89);
  meshes["seam-chest-out-r"] = mesh_seam_chest_out_r_89;
  colliders["seam-chest-out-r"] = {};
  destructionGroups["chest-shell-r"] ??= [];
  destructionGroups["chest-shell-r"].push(node_seam_chest_out_r_89);

  const endpoint_seam_pauldron_r_90 = makeAttachmentEndpoint(null);
  const node_seam_pauldron_r_90 = new THREE.Group();
  node_seam_pauldron_r_90.name = "Gold seam seam-pauldron-r__pivot";
  node_seam_pauldron_r_90.scale.set(1, 1, 1);
  if (endpoint_seam_pauldron_r_90) {
    node_seam_pauldron_r_90.position.copy(endpoint_seam_pauldron_r_90.start);
    node_seam_pauldron_r_90.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seam_pauldron_r_90.position.set(0.0, 0.0, 0.0);
    node_seam_pauldron_r_90.rotation.set(0.0, 0.0, 0.0);
  }
  node_seam_pauldron_r_90.userData.sculptComponent = { id: "seam-pauldron-r" };
  node_seam_pauldron_r_90.userData.actionProfile = {};
  (nodes["pauldron-r"] ?? root).add(node_seam_pauldron_r_90);
  nodes["seam-pauldron-r"] = node_seam_pauldron_r_90;
  const mesh_seam_pauldron_r_90Geometry = endpoint_seam_pauldron_r_90
    ? new THREE.CylinderGeometry(endpoint_seam_pauldron_r_90.endRadius, endpoint_seam_pauldron_r_90.baseRadius, endpoint_seam_pauldron_r_90.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.0275, -0.0, 0.01039], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [-0.09077, -0.07559, 0.02425], "rx": 0.0063, "rz": 0.0063, "twist": 0.0}, {"position": [-0.12693, -0.15748, 0.02803], "rx": 0.0063, "rz": 0.0063, "twist": 0.0}, {"position": [-0.10274, -0.23307, 0.01795], "rx": 0.0063, "rz": 0.0063, "twist": 0.0}, {"position": [-0.05424, -0.28346, 0.00126], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_seam_pauldron_r_90) {
    mesh_seam_pauldron_r_90Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seam_pauldron_r_90 = new THREE.Mesh(
    mesh_seam_pauldron_r_90Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seam_pauldron_r_90.name = "Gold seam seam-pauldron-r";
  if (endpoint_seam_pauldron_r_90) {
    mesh_seam_pauldron_r_90.position.copy(endpoint_seam_pauldron_r_90.midpoint);
    mesh_seam_pauldron_r_90.quaternion.copy(endpoint_seam_pauldron_r_90.quaternion);
  }
  mesh_seam_pauldron_r_90.castShadow = options.castShadow ?? true;
  mesh_seam_pauldron_r_90.receiveShadow = options.receiveShadow ?? true;
  mesh_seam_pauldron_r_90.userData.sculptComponent = { id: "seam-pauldron-r" };
  node_seam_pauldron_r_90.add(mesh_seam_pauldron_r_90);
  meshes["seam-pauldron-r"] = mesh_seam_pauldron_r_90;
  colliders["seam-pauldron-r"] = {};
  destructionGroups["pauldron-r"] ??= [];
  destructionGroups["pauldron-r"].push(node_seam_pauldron_r_90);

  const endpoint_seam_pauldron_in_r_91 = makeAttachmentEndpoint(null);
  const node_seam_pauldron_in_r_91 = new THREE.Group();
  node_seam_pauldron_in_r_91.name = "Gold seam seam-pauldron-in-r__pivot";
  node_seam_pauldron_in_r_91.scale.set(1, 1, 1);
  if (endpoint_seam_pauldron_in_r_91) {
    node_seam_pauldron_in_r_91.position.copy(endpoint_seam_pauldron_in_r_91.start);
    node_seam_pauldron_in_r_91.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seam_pauldron_in_r_91.position.set(0.0, 0.0, 0.0);
    node_seam_pauldron_in_r_91.rotation.set(0.0, 0.0, 0.0);
  }
  node_seam_pauldron_in_r_91.userData.sculptComponent = { id: "seam-pauldron-in-r" };
  node_seam_pauldron_in_r_91.userData.actionProfile = {};
  (nodes["pauldron-r"] ?? root).add(node_seam_pauldron_in_r_91);
  nodes["seam-pauldron-in-r"] = node_seam_pauldron_in_r_91;
  const mesh_seam_pauldron_in_r_91Geometry = endpoint_seam_pauldron_in_r_91
    ? new THREE.CylinderGeometry(endpoint_seam_pauldron_in_r_91.endRadius, endpoint_seam_pauldron_in_r_91.baseRadius, endpoint_seam_pauldron_in_r_91.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0275, -0.0, 0.01039], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [0.00699, -0.07559, 0.02425], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [-0.00472, -0.15748, 0.02803], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [-0.00498, -0.23307, 0.01795], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [-0.01757, -0.28346, 0.00126], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_seam_pauldron_in_r_91) {
    mesh_seam_pauldron_in_r_91Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seam_pauldron_in_r_91 = new THREE.Mesh(
    mesh_seam_pauldron_in_r_91Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seam_pauldron_in_r_91.name = "Gold seam seam-pauldron-in-r";
  if (endpoint_seam_pauldron_in_r_91) {
    mesh_seam_pauldron_in_r_91.position.copy(endpoint_seam_pauldron_in_r_91.midpoint);
    mesh_seam_pauldron_in_r_91.quaternion.copy(endpoint_seam_pauldron_in_r_91.quaternion);
  }
  mesh_seam_pauldron_in_r_91.castShadow = options.castShadow ?? true;
  mesh_seam_pauldron_in_r_91.receiveShadow = options.receiveShadow ?? true;
  mesh_seam_pauldron_in_r_91.userData.sculptComponent = { id: "seam-pauldron-in-r" };
  node_seam_pauldron_in_r_91.add(mesh_seam_pauldron_in_r_91);
  meshes["seam-pauldron-in-r"] = mesh_seam_pauldron_in_r_91;
  colliders["seam-pauldron-in-r"] = {};
  destructionGroups["pauldron-r"] ??= [];
  destructionGroups["pauldron-r"].push(node_seam_pauldron_in_r_91);

  const endpoint_seam_bicep_r_92 = makeAttachmentEndpoint(null);
  const node_seam_bicep_r_92 = new THREE.Group();
  node_seam_bicep_r_92.name = "Gold seam seam-bicep-r__pivot";
  node_seam_bicep_r_92.scale.set(1, 1, 1);
  if (endpoint_seam_bicep_r_92) {
    node_seam_bicep_r_92.position.copy(endpoint_seam_bicep_r_92.start);
    node_seam_bicep_r_92.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seam_bicep_r_92.position.set(0.0, 0.0, 0.0);
    node_seam_bicep_r_92.rotation.set(0.0, 0.0, 0.0);
  }
  node_seam_bicep_r_92.userData.sculptComponent = { id: "seam-bicep-r" };
  node_seam_bicep_r_92.userData.actionProfile = {};
  (nodes["upper-arm-shell-r"] ?? root).add(node_seam_bicep_r_92);
  nodes["seam-bicep-r"] = node_seam_bicep_r_92;
  const mesh_seam_bicep_r_92Geometry = endpoint_seam_bicep_r_92
    ? new THREE.CylinderGeometry(endpoint_seam_bicep_r_92.endRadius, endpoint_seam_bicep_r_92.baseRadius, endpoint_seam_bicep_r_92.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.01039, -0.0, 0.01837], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [-0.0825, -0.03937, 0.05814], "rx": 0.00441, "rz": 0.00441, "twist": 0.0}, {"position": [-0.13902, -0.07874, 0.08567], "rx": 0.00441, "rz": 0.00441, "twist": 0.0}, {"position": [-0.17218, -0.11811, 0.09483], "rx": 0.00441, "rz": 0.00441, "twist": 0.0}, {"position": [-0.18456, -0.15748, 0.08766], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_seam_bicep_r_92) {
    mesh_seam_bicep_r_92Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seam_bicep_r_92 = new THREE.Mesh(
    mesh_seam_bicep_r_92Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seam_bicep_r_92.name = "Gold seam seam-bicep-r";
  if (endpoint_seam_bicep_r_92) {
    mesh_seam_bicep_r_92.position.copy(endpoint_seam_bicep_r_92.midpoint);
    mesh_seam_bicep_r_92.quaternion.copy(endpoint_seam_bicep_r_92.quaternion);
  }
  mesh_seam_bicep_r_92.castShadow = options.castShadow ?? true;
  mesh_seam_bicep_r_92.receiveShadow = options.receiveShadow ?? true;
  mesh_seam_bicep_r_92.userData.sculptComponent = { id: "seam-bicep-r" };
  node_seam_bicep_r_92.add(mesh_seam_bicep_r_92);
  meshes["seam-bicep-r"] = mesh_seam_bicep_r_92;
  colliders["seam-bicep-r"] = {};
  destructionGroups["upper-arm-shell-r"] ??= [];
  destructionGroups["upper-arm-shell-r"].push(node_seam_bicep_r_92);

  const endpoint_seam_helmet_93 = makeAttachmentEndpoint(null);
  const node_seam_helmet_93 = new THREE.Group();
  node_seam_helmet_93.name = "Gold crown stripe__pivot";
  node_seam_helmet_93.scale.set(1, 1, 1);
  if (endpoint_seam_helmet_93) {
    node_seam_helmet_93.position.copy(endpoint_seam_helmet_93.start);
    node_seam_helmet_93.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seam_helmet_93.position.set(0.0, 0.0, 0.0);
    node_seam_helmet_93.rotation.set(0.0, 0.0, 0.0);
  }
  node_seam_helmet_93.userData.sculptComponent = { id: "seam-helmet" };
  node_seam_helmet_93.userData.actionProfile = {};
  (nodes["head"] ?? root).add(node_seam_helmet_93);
  nodes["seam-helmet"] = node_seam_helmet_93;
  const mesh_seam_helmet_93Geometry = endpoint_seam_helmet_93
    ? new THREE.CylinderGeometry(endpoint_seam_helmet_93.endRadius, endpoint_seam_helmet_93.baseRadius, endpoint_seam_helmet_93.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.15118, 0.1365], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [0.0, 0.21417, 0.12409], "rx": 0.0063, "rz": 0.0063, "twist": 0.0}, {"position": [0.0, 0.25197, 0.09307], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_seam_helmet_93) {
    mesh_seam_helmet_93Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seam_helmet_93 = new THREE.Mesh(
    mesh_seam_helmet_93Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seam_helmet_93.name = "Gold crown stripe";
  if (endpoint_seam_helmet_93) {
    mesh_seam_helmet_93.position.copy(endpoint_seam_helmet_93.midpoint);
    mesh_seam_helmet_93.quaternion.copy(endpoint_seam_helmet_93.quaternion);
  }
  mesh_seam_helmet_93.castShadow = options.castShadow ?? true;
  mesh_seam_helmet_93.receiveShadow = options.receiveShadow ?? true;
  mesh_seam_helmet_93.userData.sculptComponent = { id: "seam-helmet" };
  node_seam_helmet_93.add(mesh_seam_helmet_93);
  meshes["seam-helmet"] = mesh_seam_helmet_93;
  colliders["seam-helmet"] = {};
  destructionGroups["head"] ??= [];
  destructionGroups["head"].push(node_seam_helmet_93);

  const endpoint_pod_core_94 = makeAttachmentEndpoint(null);
  const node_pod_core_94 = new THREE.Group();
  node_pod_core_94.name = "Pod core__pivot";
  node_pod_core_94.scale.set(1, 1, 1);
  if (endpoint_pod_core_94) {
    node_pod_core_94.position.copy(endpoint_pod_core_94.start);
    node_pod_core_94.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_pod_core_94.position.set(0.0, -0.09449, 0.0063);
    node_pod_core_94.rotation.set(0.0, 0.0, 0.0);
  }
  node_pod_core_94.userData.sculptComponent = { id: "pod-core" };
  node_pod_core_94.userData.actionProfile = {};
  (nodes["pelvis"] ?? root).add(node_pod_core_94);
  nodes["pod-core"] = node_pod_core_94;
  const mesh_pod_core_94Geometry = endpoint_pod_core_94
    ? new THREE.CylinderGeometry(endpoint_pod_core_94.endRadius, endpoint_pod_core_94.baseRadius, endpoint_pod_core_94.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.09449, "rz": 0.14488, "twist": 0.0}, {"position": [0.0, -0.22047, 0.0], "rx": 0.08189, "rz": 0.11339, "twist": 0.0}, {"position": [0.0, -0.44095, 0.0], "rx": 0.05354, "rz": 0.06929, "twist": 0.0}, {"position": [0.0, -0.72441, 0.0], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 20, "capEnds": true});
  if (!endpoint_pod_core_94) {
    mesh_pod_core_94Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_pod_core_94 = new THREE.Mesh(
    mesh_pod_core_94Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pod_core_94.name = "Pod core";
  if (endpoint_pod_core_94) {
    mesh_pod_core_94.position.copy(endpoint_pod_core_94.midpoint);
    mesh_pod_core_94.quaternion.copy(endpoint_pod_core_94.quaternion);
  }
  mesh_pod_core_94.castShadow = options.castShadow ?? true;
  mesh_pod_core_94.receiveShadow = options.receiveShadow ?? true;
  mesh_pod_core_94.userData.sculptComponent = { id: "pod-core" };
  node_pod_core_94.add(mesh_pod_core_94);
  meshes["pod-core"] = mesh_pod_core_94;
  colliders["pod-core"] = {};
  destructionGroups["pod"] ??= [];
  destructionGroups["pod"].push(node_pod_core_94);

  const endpoint_pod_shell_l_95 = makeAttachmentEndpoint(null);
  const node_pod_shell_l_95 = new THREE.Group();
  node_pod_shell_l_95.name = "Pod shell L__pivot";
  node_pod_shell_l_95.scale.set(1, 1, 1);
  if (endpoint_pod_shell_l_95) {
    node_pod_shell_l_95.position.copy(endpoint_pod_shell_l_95.start);
    node_pod_shell_l_95.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_pod_shell_l_95.position.set(0.10709, 0.0252, 0.0189);
    node_pod_shell_l_95.rotation.set(0.0, 0.0, 0.0);
  }
  node_pod_shell_l_95.userData.sculptComponent = { id: "pod-shell-l" };
  node_pod_shell_l_95.userData.actionProfile = {};
  (nodes["pod-core"] ?? root).add(node_pod_shell_l_95);
  nodes["pod-shell-l"] = node_pod_shell_l_95;
  const mesh_pod_shell_l_95Geometry = endpoint_pod_shell_l_95
    ? new THREE.CylinderGeometry(endpoint_pod_shell_l_95.endRadius, endpoint_pod_shell_l_95.baseRadius, endpoint_pod_shell_l_95.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.01587, "rz": 0.01764, "twist": 0.0}, {"position": [0.00472, -0.15591, -0.00157], "rx": 0.03528, "rz": 0.06614, "twist": 0.0}, {"position": [0.00945, -0.31181, -0.00315], "rx": 0.04409, "rz": 0.08819, "twist": 0.0}, {"position": [0.01417, -0.46772, -0.00472], "rx": 0.03704, "rz": 0.07055, "twist": 0.0}, {"position": [0.0189, -0.62362, -0.0063], "rx": 0.01587, "rz": 0.01764, "twist": 0.0}], "radialSegments": 16, "capEnds": true});
  if (!endpoint_pod_shell_l_95) {
    mesh_pod_shell_l_95Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_pod_shell_l_95 = new THREE.Mesh(
    mesh_pod_shell_l_95Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pod_shell_l_95.name = "Pod shell L";
  if (endpoint_pod_shell_l_95) {
    mesh_pod_shell_l_95.position.copy(endpoint_pod_shell_l_95.midpoint);
    mesh_pod_shell_l_95.quaternion.copy(endpoint_pod_shell_l_95.quaternion);
  }
  mesh_pod_shell_l_95.castShadow = options.castShadow ?? true;
  mesh_pod_shell_l_95.receiveShadow = options.receiveShadow ?? true;
  mesh_pod_shell_l_95.userData.sculptComponent = { id: "pod-shell-l" };
  node_pod_shell_l_95.add(mesh_pod_shell_l_95);
  meshes["pod-shell-l"] = mesh_pod_shell_l_95;
  colliders["pod-shell-l"] = {};
  destructionGroups["pod"] ??= [];
  destructionGroups["pod"].push(node_pod_shell_l_95);

  const endpoint_pod_fin_l_96 = makeAttachmentEndpoint(null);
  const node_pod_fin_l_96 = new THREE.Group();
  node_pod_fin_l_96.name = "Pod fin L__pivot";
  node_pod_fin_l_96.scale.set(1, 1, 1);
  if (endpoint_pod_fin_l_96) {
    node_pod_fin_l_96.position.copy(endpoint_pod_fin_l_96.start);
    node_pod_fin_l_96.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_pod_fin_l_96.position.set(0.13858, -0.06299, -0.0315);
    node_pod_fin_l_96.rotation.set(0.0, 0.0, 0.0);
  }
  node_pod_fin_l_96.userData.sculptComponent = { id: "pod-fin-l" };
  node_pod_fin_l_96.userData.actionProfile = {};
  (nodes["pod-core"] ?? root).add(node_pod_fin_l_96);
  nodes["pod-fin-l"] = node_pod_fin_l_96;
  const mesh_pod_fin_l_96Geometry = endpoint_pod_fin_l_96
    ? new THREE.CylinderGeometry(endpoint_pod_fin_l_96.endRadius, endpoint_pod_fin_l_96.baseRadius, endpoint_pod_fin_l_96.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.00794, "rz": 0.0126, "twist": 0.0}, {"position": [0.03307, -0.11811, -0.00315], "rx": 0.01764, "rz": 0.04724, "twist": 0.0}, {"position": [0.06614, -0.23622, -0.0063], "rx": 0.02205, "rz": 0.06299, "twist": 0.0}, {"position": [0.09921, -0.35433, -0.00945], "rx": 0.01852, "rz": 0.05039, "twist": 0.0}, {"position": [0.13228, -0.47244, -0.0126], "rx": 0.00794, "rz": 0.0126, "twist": 0.0}], "radialSegments": 16, "capEnds": true});
  if (!endpoint_pod_fin_l_96) {
    mesh_pod_fin_l_96Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_pod_fin_l_96 = new THREE.Mesh(
    mesh_pod_fin_l_96Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pod_fin_l_96.name = "Pod fin L";
  if (endpoint_pod_fin_l_96) {
    mesh_pod_fin_l_96.position.copy(endpoint_pod_fin_l_96.midpoint);
    mesh_pod_fin_l_96.quaternion.copy(endpoint_pod_fin_l_96.quaternion);
  }
  mesh_pod_fin_l_96.castShadow = options.castShadow ?? true;
  mesh_pod_fin_l_96.receiveShadow = options.receiveShadow ?? true;
  mesh_pod_fin_l_96.userData.sculptComponent = { id: "pod-fin-l" };
  node_pod_fin_l_96.add(mesh_pod_fin_l_96);
  meshes["pod-fin-l"] = mesh_pod_fin_l_96;
  colliders["pod-fin-l"] = {};
  destructionGroups["pod"] ??= [];
  destructionGroups["pod"].push(node_pod_fin_l_96);

  const endpoint_seam_pod_l_97 = makeAttachmentEndpoint(null);
  const node_seam_pod_l_97 = new THREE.Group();
  node_seam_pod_l_97.name = "Gold seam seam-pod-l__pivot";
  node_seam_pod_l_97.scale.set(1, 1, 1);
  if (endpoint_seam_pod_l_97) {
    node_seam_pod_l_97.position.copy(endpoint_seam_pod_l_97.start);
    node_seam_pod_l_97.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seam_pod_l_97.position.set(0.0, 0.0, 0.0);
    node_seam_pod_l_97.rotation.set(0.0, 0.0, 0.0);
  }
  node_seam_pod_l_97.userData.sculptComponent = { id: "seam-pod-l" };
  node_seam_pod_l_97.userData.actionProfile = {};
  (nodes["pod-shell-l"] ?? root).add(node_seam_pod_l_97);
  nodes["seam-pod-l"] = node_seam_pod_l_97;
  const mesh_seam_pod_l_97Geometry = endpoint_seam_pod_l_97
    ? new THREE.CylinderGeometry(endpoint_seam_pod_l_97.endRadius, endpoint_seam_pod_l_97.baseRadius, endpoint_seam_pod_l_97.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.01711, -0.0, 0.01429], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [0.06888, -0.15591, 0.03017], "rx": 0.00567, "rz": 0.00567, "twist": 0.0}, {"position": [0.09499, -0.31181, 0.03654], "rx": 0.00567, "rz": 0.00567, "twist": 0.0}, {"position": [0.08261, -0.46772, 0.02861], "rx": 0.00567, "rz": 0.00567, "twist": 0.0}, {"position": [0.03601, -0.62362, 0.00799], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_seam_pod_l_97) {
    mesh_seam_pod_l_97Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seam_pod_l_97 = new THREE.Mesh(
    mesh_seam_pod_l_97Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seam_pod_l_97.name = "Gold seam seam-pod-l";
  if (endpoint_seam_pod_l_97) {
    mesh_seam_pod_l_97.position.copy(endpoint_seam_pod_l_97.midpoint);
    mesh_seam_pod_l_97.quaternion.copy(endpoint_seam_pod_l_97.quaternion);
  }
  mesh_seam_pod_l_97.castShadow = options.castShadow ?? true;
  mesh_seam_pod_l_97.receiveShadow = options.receiveShadow ?? true;
  mesh_seam_pod_l_97.userData.sculptComponent = { id: "seam-pod-l" };
  node_seam_pod_l_97.add(mesh_seam_pod_l_97);
  meshes["seam-pod-l"] = mesh_seam_pod_l_97;
  colliders["seam-pod-l"] = {};
  destructionGroups["pod-shell-l"] ??= [];
  destructionGroups["pod-shell-l"].push(node_seam_pod_l_97);

  const endpoint_pod_shell_r_98 = makeAttachmentEndpoint(null);
  const node_pod_shell_r_98 = new THREE.Group();
  node_pod_shell_r_98.name = "Pod shell R__pivot";
  node_pod_shell_r_98.scale.set(1, 1, 1);
  if (endpoint_pod_shell_r_98) {
    node_pod_shell_r_98.position.copy(endpoint_pod_shell_r_98.start);
    node_pod_shell_r_98.rotation.set(0.0, -0.0, 0.0);
  } else {
    node_pod_shell_r_98.position.set(-0.10709, 0.0252, 0.0189);
    node_pod_shell_r_98.rotation.set(0.0, -0.0, 0.0);
  }
  node_pod_shell_r_98.userData.sculptComponent = { id: "pod-shell-r" };
  node_pod_shell_r_98.userData.actionProfile = {};
  (nodes["pod-core"] ?? root).add(node_pod_shell_r_98);
  nodes["pod-shell-r"] = node_pod_shell_r_98;
  const mesh_pod_shell_r_98Geometry = endpoint_pod_shell_r_98
    ? new THREE.CylinderGeometry(endpoint_pod_shell_r_98.endRadius, endpoint_pod_shell_r_98.baseRadius, endpoint_pod_shell_r_98.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.01587, "rz": 0.01764, "twist": 0.0}, {"position": [-0.00472, -0.15591, -0.00157], "rx": 0.03528, "rz": 0.06614, "twist": 0.0}, {"position": [-0.00945, -0.31181, -0.00315], "rx": 0.04409, "rz": 0.08819, "twist": 0.0}, {"position": [-0.01417, -0.46772, -0.00472], "rx": 0.03704, "rz": 0.07055, "twist": 0.0}, {"position": [-0.0189, -0.62362, -0.0063], "rx": 0.01587, "rz": 0.01764, "twist": 0.0}], "radialSegments": 16, "capEnds": true});
  if (!endpoint_pod_shell_r_98) {
    mesh_pod_shell_r_98Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_pod_shell_r_98 = new THREE.Mesh(
    mesh_pod_shell_r_98Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pod_shell_r_98.name = "Pod shell R";
  if (endpoint_pod_shell_r_98) {
    mesh_pod_shell_r_98.position.copy(endpoint_pod_shell_r_98.midpoint);
    mesh_pod_shell_r_98.quaternion.copy(endpoint_pod_shell_r_98.quaternion);
  }
  mesh_pod_shell_r_98.castShadow = options.castShadow ?? true;
  mesh_pod_shell_r_98.receiveShadow = options.receiveShadow ?? true;
  mesh_pod_shell_r_98.userData.sculptComponent = { id: "pod-shell-r" };
  node_pod_shell_r_98.add(mesh_pod_shell_r_98);
  meshes["pod-shell-r"] = mesh_pod_shell_r_98;
  colliders["pod-shell-r"] = {};
  destructionGroups["pod"] ??= [];
  destructionGroups["pod"].push(node_pod_shell_r_98);

  const endpoint_pod_fin_r_99 = makeAttachmentEndpoint(null);
  const node_pod_fin_r_99 = new THREE.Group();
  node_pod_fin_r_99.name = "Pod fin R__pivot";
  node_pod_fin_r_99.scale.set(1, 1, 1);
  if (endpoint_pod_fin_r_99) {
    node_pod_fin_r_99.position.copy(endpoint_pod_fin_r_99.start);
    node_pod_fin_r_99.rotation.set(0.0, -0.0, 0.0);
  } else {
    node_pod_fin_r_99.position.set(-0.13858, -0.06299, -0.0315);
    node_pod_fin_r_99.rotation.set(0.0, -0.0, 0.0);
  }
  node_pod_fin_r_99.userData.sculptComponent = { id: "pod-fin-r" };
  node_pod_fin_r_99.userData.actionProfile = {};
  (nodes["pod-core"] ?? root).add(node_pod_fin_r_99);
  nodes["pod-fin-r"] = node_pod_fin_r_99;
  const mesh_pod_fin_r_99Geometry = endpoint_pod_fin_r_99
    ? new THREE.CylinderGeometry(endpoint_pod_fin_r_99.endRadius, endpoint_pod_fin_r_99.baseRadius, endpoint_pod_fin_r_99.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.00794, "rz": 0.0126, "twist": 0.0}, {"position": [-0.03307, -0.11811, -0.00315], "rx": 0.01764, "rz": 0.04724, "twist": 0.0}, {"position": [-0.06614, -0.23622, -0.0063], "rx": 0.02205, "rz": 0.06299, "twist": 0.0}, {"position": [-0.09921, -0.35433, -0.00945], "rx": 0.01852, "rz": 0.05039, "twist": 0.0}, {"position": [-0.13228, -0.47244, -0.0126], "rx": 0.00794, "rz": 0.0126, "twist": 0.0}], "radialSegments": 16, "capEnds": true});
  if (!endpoint_pod_fin_r_99) {
    mesh_pod_fin_r_99Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_pod_fin_r_99 = new THREE.Mesh(
    mesh_pod_fin_r_99Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pod_fin_r_99.name = "Pod fin R";
  if (endpoint_pod_fin_r_99) {
    mesh_pod_fin_r_99.position.copy(endpoint_pod_fin_r_99.midpoint);
    mesh_pod_fin_r_99.quaternion.copy(endpoint_pod_fin_r_99.quaternion);
  }
  mesh_pod_fin_r_99.castShadow = options.castShadow ?? true;
  mesh_pod_fin_r_99.receiveShadow = options.receiveShadow ?? true;
  mesh_pod_fin_r_99.userData.sculptComponent = { id: "pod-fin-r" };
  node_pod_fin_r_99.add(mesh_pod_fin_r_99);
  meshes["pod-fin-r"] = mesh_pod_fin_r_99;
  colliders["pod-fin-r"] = {};
  destructionGroups["pod"] ??= [];
  destructionGroups["pod"].push(node_pod_fin_r_99);

  const endpoint_seam_pod_r_100 = makeAttachmentEndpoint(null);
  const node_seam_pod_r_100 = new THREE.Group();
  node_seam_pod_r_100.name = "Gold seam seam-pod-r__pivot";
  node_seam_pod_r_100.scale.set(1, 1, 1);
  if (endpoint_seam_pod_r_100) {
    node_seam_pod_r_100.position.copy(endpoint_seam_pod_r_100.start);
    node_seam_pod_r_100.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seam_pod_r_100.position.set(0.0, 0.0, 0.0);
    node_seam_pod_r_100.rotation.set(0.0, 0.0, 0.0);
  }
  node_seam_pod_r_100.userData.sculptComponent = { id: "seam-pod-r" };
  node_seam_pod_r_100.userData.actionProfile = {};
  (nodes["pod-shell-r"] ?? root).add(node_seam_pod_r_100);
  nodes["seam-pod-r"] = node_seam_pod_r_100;
  const mesh_seam_pod_r_100Geometry = endpoint_seam_pod_r_100
    ? new THREE.CylinderGeometry(endpoint_seam_pod_r_100.endRadius, endpoint_seam_pod_r_100.baseRadius, endpoint_seam_pod_r_100.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.01711, -0.0, 0.01429], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [-0.06888, -0.15591, 0.03017], "rx": 0.00567, "rz": 0.00567, "twist": 0.0}, {"position": [-0.09499, -0.31181, 0.03654], "rx": 0.00567, "rz": 0.00567, "twist": 0.0}, {"position": [-0.08261, -0.46772, 0.02861], "rx": 0.00567, "rz": 0.00567, "twist": 0.0}, {"position": [-0.03601, -0.62362, 0.00799], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_seam_pod_r_100) {
    mesh_seam_pod_r_100Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seam_pod_r_100 = new THREE.Mesh(
    mesh_seam_pod_r_100Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seam_pod_r_100.name = "Gold seam seam-pod-r";
  if (endpoint_seam_pod_r_100) {
    mesh_seam_pod_r_100.position.copy(endpoint_seam_pod_r_100.midpoint);
    mesh_seam_pod_r_100.quaternion.copy(endpoint_seam_pod_r_100.quaternion);
  }
  mesh_seam_pod_r_100.castShadow = options.castShadow ?? true;
  mesh_seam_pod_r_100.receiveShadow = options.receiveShadow ?? true;
  mesh_seam_pod_r_100.userData.sculptComponent = { id: "seam-pod-r" };
  node_seam_pod_r_100.add(mesh_seam_pod_r_100);
  meshes["seam-pod-r"] = mesh_seam_pod_r_100;
  colliders["seam-pod-r"] = {};
  destructionGroups["pod-shell-r"] ??= [];
  destructionGroups["pod-shell-r"].push(node_seam_pod_r_100);

  const endpoint_pod_glow_101 = makeAttachmentEndpoint(null);
  const node_pod_glow_101 = new THREE.Group();
  node_pod_glow_101.name = "Pod glow__pivot";
  node_pod_glow_101.scale.set(1, 1, 1);
  if (endpoint_pod_glow_101) {
    node_pod_glow_101.position.copy(endpoint_pod_glow_101.start);
    node_pod_glow_101.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_pod_glow_101.position.set(0.0, -0.44095, 0.06929);
    node_pod_glow_101.rotation.set(0.0, 0.0, 0.0);
  }
  node_pod_glow_101.userData.sculptComponent = { id: "pod-glow" };
  node_pod_glow_101.userData.actionProfile = {};
  (nodes["pod-core"] ?? root).add(node_pod_glow_101);
  nodes["pod-glow"] = node_pod_glow_101;
  const mesh_pod_glow_101Geometry = endpoint_pod_glow_101
    ? new THREE.CylinderGeometry(endpoint_pod_glow_101.endRadius, endpoint_pod_glow_101.baseRadius, endpoint_pod_glow_101.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_pod_glow_101) {
    mesh_pod_glow_101Geometry.scale(0.12598, 0.0315, 0.02205);
  }
  const mesh_pod_glow_101 = new THREE.Mesh(
    mesh_pod_glow_101Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pod_glow_101.name = "Pod glow";
  if (endpoint_pod_glow_101) {
    mesh_pod_glow_101.position.copy(endpoint_pod_glow_101.midpoint);
    mesh_pod_glow_101.quaternion.copy(endpoint_pod_glow_101.quaternion);
  }
  mesh_pod_glow_101.castShadow = options.castShadow ?? true;
  mesh_pod_glow_101.receiveShadow = options.receiveShadow ?? true;
  mesh_pod_glow_101.userData.sculptComponent = { id: "pod-glow" };
  node_pod_glow_101.add(mesh_pod_glow_101);
  meshes["pod-glow"] = mesh_pod_glow_101;
  colliders["pod-glow"] = {};
  destructionGroups["pod"] ??= [];
  destructionGroups["pod"].push(node_pod_glow_101);

  const endpoint_prop_orb_1_102 = makeAttachmentEndpoint(null);
  const node_prop_orb_1_102 = new THREE.Group();
  node_prop_orb_1_102.name = "Orb drone prop-orb-1__pivot";
  node_prop_orb_1_102.scale.set(1, 1, 1);
  if (endpoint_prop_orb_1_102) {
    node_prop_orb_1_102.position.copy(endpoint_prop_orb_1_102.start);
    node_prop_orb_1_102.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_orb_1_102.position.set(-0.32756, 1.83937, 0.0378);
    node_prop_orb_1_102.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_orb_1_102.userData.sculptComponent = { id: "prop-orb-1" };
  node_prop_orb_1_102.userData.actionProfile = {};
  (nodes["root"] ?? root).add(node_prop_orb_1_102);
  nodes["prop-orb-1"] = node_prop_orb_1_102;
  const mesh_prop_orb_1_102Geometry = endpoint_prop_orb_1_102
    ? new THREE.CylinderGeometry(endpoint_prop_orb_1_102.endRadius, endpoint_prop_orb_1_102.baseRadius, endpoint_prop_orb_1_102.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_prop_orb_1_102) {
    mesh_prop_orb_1_102Geometry.scale(0.20158, 0.20158, 0.20158);
  }
  const mesh_prop_orb_1_102 = new THREE.Mesh(
    mesh_prop_orb_1_102Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_orb_1_102.name = "Orb drone prop-orb-1";
  if (endpoint_prop_orb_1_102) {
    mesh_prop_orb_1_102.position.copy(endpoint_prop_orb_1_102.midpoint);
    mesh_prop_orb_1_102.quaternion.copy(endpoint_prop_orb_1_102.quaternion);
  }
  mesh_prop_orb_1_102.castShadow = options.castShadow ?? true;
  mesh_prop_orb_1_102.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_orb_1_102.userData.sculptComponent = { id: "prop-orb-1" };
  node_prop_orb_1_102.add(mesh_prop_orb_1_102);
  meshes["prop-orb-1"] = mesh_prop_orb_1_102;
  colliders["prop-orb-1"] = {};
  destructionGroups["prop-orb-1"] ??= [];
  destructionGroups["prop-orb-1"].push(node_prop_orb_1_102);

  const endpoint_prop_orb_1_face_103 = makeAttachmentEndpoint(null);
  const node_prop_orb_1_face_103 = new THREE.Group();
  node_prop_orb_1_face_103.name = "Drone face prop-orb-1__pivot";
  node_prop_orb_1_face_103.scale.set(1, 1, 1);
  if (endpoint_prop_orb_1_face_103) {
    node_prop_orb_1_face_103.position.copy(endpoint_prop_orb_1_face_103.start);
    node_prop_orb_1_face_103.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_orb_1_face_103.position.set(0.0, 0.0, 0.06249);
    node_prop_orb_1_face_103.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_orb_1_face_103.userData.sculptComponent = { id: "prop-orb-1-face" };
  node_prop_orb_1_face_103.userData.actionProfile = {};
  (nodes["prop-orb-1"] ?? root).add(node_prop_orb_1_face_103);
  nodes["prop-orb-1-face"] = node_prop_orb_1_face_103;
  const mesh_prop_orb_1_face_103Geometry = endpoint_prop_orb_1_face_103
    ? new THREE.CylinderGeometry(endpoint_prop_orb_1_face_103.endRadius, endpoint_prop_orb_1_face_103.baseRadius, endpoint_prop_orb_1_face_103.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_prop_orb_1_face_103) {
    mesh_prop_orb_1_face_103Geometry.scale(0.14614, 0.12095, 0.07055);
  }
  const mesh_prop_orb_1_face_103 = new THREE.Mesh(
    mesh_prop_orb_1_face_103Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_orb_1_face_103.name = "Drone face prop-orb-1";
  if (endpoint_prop_orb_1_face_103) {
    mesh_prop_orb_1_face_103.position.copy(endpoint_prop_orb_1_face_103.midpoint);
    mesh_prop_orb_1_face_103.quaternion.copy(endpoint_prop_orb_1_face_103.quaternion);
  }
  mesh_prop_orb_1_face_103.castShadow = options.castShadow ?? true;
  mesh_prop_orb_1_face_103.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_orb_1_face_103.userData.sculptComponent = { id: "prop-orb-1-face" };
  node_prop_orb_1_face_103.add(mesh_prop_orb_1_face_103);
  meshes["prop-orb-1-face"] = mesh_prop_orb_1_face_103;
  colliders["prop-orb-1-face"] = {};
  destructionGroups["prop-orb-1"] ??= [];
  destructionGroups["prop-orb-1"].push(node_prop_orb_1_face_103);

  const endpoint_prop_orb_1_eye0_104 = makeAttachmentEndpoint(null);
  const node_prop_orb_1_eye0_104 = new THREE.Group();
  node_prop_orb_1_eye0_104.name = "Drone eye prop-orb-1 0__pivot";
  node_prop_orb_1_eye0_104.scale.set(1, 1, 1);
  if (endpoint_prop_orb_1_eye0_104) {
    node_prop_orb_1_eye0_104.position.copy(endpoint_prop_orb_1_eye0_104.start);
    node_prop_orb_1_eye0_104.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_orb_1_eye0_104.position.set(-0.04233, 0.00403, 0.09575);
    node_prop_orb_1_eye0_104.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_orb_1_eye0_104.userData.sculptComponent = { id: "prop-orb-1-eye0" };
  node_prop_orb_1_eye0_104.userData.actionProfile = {};
  (nodes["prop-orb-1"] ?? root).add(node_prop_orb_1_eye0_104);
  nodes["prop-orb-1-eye0"] = node_prop_orb_1_eye0_104;
  const mesh_prop_orb_1_eye0_104Geometry = endpoint_prop_orb_1_eye0_104
    ? new THREE.CylinderGeometry(endpoint_prop_orb_1_eye0_104.endRadius, endpoint_prop_orb_1_eye0_104.baseRadius, endpoint_prop_orb_1_eye0_104.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_prop_orb_1_eye0_104) {
    mesh_prop_orb_1_eye0_104Geometry.scale(0.03024, 0.03427, 0.01411);
  }
  const mesh_prop_orb_1_eye0_104 = new THREE.Mesh(
    mesh_prop_orb_1_eye0_104Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_orb_1_eye0_104.name = "Drone eye prop-orb-1 0";
  if (endpoint_prop_orb_1_eye0_104) {
    mesh_prop_orb_1_eye0_104.position.copy(endpoint_prop_orb_1_eye0_104.midpoint);
    mesh_prop_orb_1_eye0_104.quaternion.copy(endpoint_prop_orb_1_eye0_104.quaternion);
  }
  mesh_prop_orb_1_eye0_104.castShadow = options.castShadow ?? true;
  mesh_prop_orb_1_eye0_104.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_orb_1_eye0_104.userData.sculptComponent = { id: "prop-orb-1-eye0" };
  node_prop_orb_1_eye0_104.add(mesh_prop_orb_1_eye0_104);
  meshes["prop-orb-1-eye0"] = mesh_prop_orb_1_eye0_104;
  colliders["prop-orb-1-eye0"] = {};
  destructionGroups["prop-orb-1"] ??= [];
  destructionGroups["prop-orb-1"].push(node_prop_orb_1_eye0_104);

  const endpoint_prop_orb_1_eye1_105 = makeAttachmentEndpoint(null);
  const node_prop_orb_1_eye1_105 = new THREE.Group();
  node_prop_orb_1_eye1_105.name = "Drone eye prop-orb-1 1__pivot";
  node_prop_orb_1_eye1_105.scale.set(1, 1, 1);
  if (endpoint_prop_orb_1_eye1_105) {
    node_prop_orb_1_eye1_105.position.copy(endpoint_prop_orb_1_eye1_105.start);
    node_prop_orb_1_eye1_105.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_orb_1_eye1_105.position.set(0.04233, 0.00403, 0.09575);
    node_prop_orb_1_eye1_105.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_orb_1_eye1_105.userData.sculptComponent = { id: "prop-orb-1-eye1" };
  node_prop_orb_1_eye1_105.userData.actionProfile = {};
  (nodes["prop-orb-1"] ?? root).add(node_prop_orb_1_eye1_105);
  nodes["prop-orb-1-eye1"] = node_prop_orb_1_eye1_105;
  const mesh_prop_orb_1_eye1_105Geometry = endpoint_prop_orb_1_eye1_105
    ? new THREE.CylinderGeometry(endpoint_prop_orb_1_eye1_105.endRadius, endpoint_prop_orb_1_eye1_105.baseRadius, endpoint_prop_orb_1_eye1_105.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_prop_orb_1_eye1_105) {
    mesh_prop_orb_1_eye1_105Geometry.scale(0.03024, 0.03427, 0.01411);
  }
  const mesh_prop_orb_1_eye1_105 = new THREE.Mesh(
    mesh_prop_orb_1_eye1_105Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_orb_1_eye1_105.name = "Drone eye prop-orb-1 1";
  if (endpoint_prop_orb_1_eye1_105) {
    mesh_prop_orb_1_eye1_105.position.copy(endpoint_prop_orb_1_eye1_105.midpoint);
    mesh_prop_orb_1_eye1_105.quaternion.copy(endpoint_prop_orb_1_eye1_105.quaternion);
  }
  mesh_prop_orb_1_eye1_105.castShadow = options.castShadow ?? true;
  mesh_prop_orb_1_eye1_105.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_orb_1_eye1_105.userData.sculptComponent = { id: "prop-orb-1-eye1" };
  node_prop_orb_1_eye1_105.add(mesh_prop_orb_1_eye1_105);
  meshes["prop-orb-1-eye1"] = mesh_prop_orb_1_eye1_105;
  colliders["prop-orb-1-eye1"] = {};
  destructionGroups["prop-orb-1"] ??= [];
  destructionGroups["prop-orb-1"].push(node_prop_orb_1_eye1_105);

  const endpoint_prop_orb_1_band_106 = makeAttachmentEndpoint(null);
  const node_prop_orb_1_band_106 = new THREE.Group();
  node_prop_orb_1_band_106.name = "Drone band prop-orb-1__pivot";
  node_prop_orb_1_band_106.scale.set(1, 1, 1);
  if (endpoint_prop_orb_1_band_106) {
    node_prop_orb_1_band_106.position.copy(endpoint_prop_orb_1_band_106.start);
    node_prop_orb_1_band_106.rotation.set(0.0, 1.5708, 0.0);
  } else {
    node_prop_orb_1_band_106.position.set(0.0, 0.0, 0.0);
    node_prop_orb_1_band_106.rotation.set(0.0, 1.5708, 0.0);
  }
  node_prop_orb_1_band_106.userData.sculptComponent = { id: "prop-orb-1-band" };
  node_prop_orb_1_band_106.userData.actionProfile = {};
  (nodes["prop-orb-1"] ?? root).add(node_prop_orb_1_band_106);
  nodes["prop-orb-1-band"] = node_prop_orb_1_band_106;
  const mesh_prop_orb_1_band_106Geometry = endpoint_prop_orb_1_band_106
    ? new THREE.CylinderGeometry(endpoint_prop_orb_1_band_106.endRadius, endpoint_prop_orb_1_band_106.baseRadius, endpoint_prop_orb_1_band_106.length, 8, 4)
    : new THREE.TorusGeometry(0.45, 0.0135, 8, 16);
  if (!endpoint_prop_orb_1_band_106) {
    mesh_prop_orb_1_band_106Geometry.scale(0.21165, 0.21165, 0.21165);
  }
  const mesh_prop_orb_1_band_106 = new THREE.Mesh(
    mesh_prop_orb_1_band_106Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_orb_1_band_106.name = "Drone band prop-orb-1";
  if (endpoint_prop_orb_1_band_106) {
    mesh_prop_orb_1_band_106.position.copy(endpoint_prop_orb_1_band_106.midpoint);
    mesh_prop_orb_1_band_106.quaternion.copy(endpoint_prop_orb_1_band_106.quaternion);
  }
  mesh_prop_orb_1_band_106.castShadow = options.castShadow ?? true;
  mesh_prop_orb_1_band_106.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_orb_1_band_106.userData.sculptComponent = { id: "prop-orb-1-band" };
  node_prop_orb_1_band_106.add(mesh_prop_orb_1_band_106);
  meshes["prop-orb-1-band"] = mesh_prop_orb_1_band_106;
  colliders["prop-orb-1-band"] = {};
  destructionGroups["prop-orb-1"] ??= [];
  destructionGroups["prop-orb-1"].push(node_prop_orb_1_band_106);

  const endpoint_prop_orb_2_107 = makeAttachmentEndpoint(null);
  const node_prop_orb_2_107 = new THREE.Group();
  node_prop_orb_2_107.name = "Orb drone prop-orb-2__pivot";
  node_prop_orb_2_107.scale.set(1, 1, 1);
  if (endpoint_prop_orb_2_107) {
    node_prop_orb_2_107.position.copy(endpoint_prop_orb_2_107.start);
    node_prop_orb_2_107.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_orb_2_107.position.set(0.52284, 1.76378, 0.06929);
    node_prop_orb_2_107.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_orb_2_107.userData.sculptComponent = { id: "prop-orb-2" };
  node_prop_orb_2_107.userData.actionProfile = {};
  (nodes["root"] ?? root).add(node_prop_orb_2_107);
  nodes["prop-orb-2"] = node_prop_orb_2_107;
  const mesh_prop_orb_2_107Geometry = endpoint_prop_orb_2_107
    ? new THREE.CylinderGeometry(endpoint_prop_orb_2_107.endRadius, endpoint_prop_orb_2_107.baseRadius, endpoint_prop_orb_2_107.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_prop_orb_2_107) {
    mesh_prop_orb_2_107Geometry.scale(0.13858, 0.13858, 0.13858);
  }
  const mesh_prop_orb_2_107 = new THREE.Mesh(
    mesh_prop_orb_2_107Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_orb_2_107.name = "Orb drone prop-orb-2";
  if (endpoint_prop_orb_2_107) {
    mesh_prop_orb_2_107.position.copy(endpoint_prop_orb_2_107.midpoint);
    mesh_prop_orb_2_107.quaternion.copy(endpoint_prop_orb_2_107.quaternion);
  }
  mesh_prop_orb_2_107.castShadow = options.castShadow ?? true;
  mesh_prop_orb_2_107.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_orb_2_107.userData.sculptComponent = { id: "prop-orb-2" };
  node_prop_orb_2_107.add(mesh_prop_orb_2_107);
  meshes["prop-orb-2"] = mesh_prop_orb_2_107;
  colliders["prop-orb-2"] = {};
  destructionGroups["prop-orb-2"] ??= [];
  destructionGroups["prop-orb-2"].push(node_prop_orb_2_107);

  const endpoint_prop_orb_2_face_108 = makeAttachmentEndpoint(null);
  const node_prop_orb_2_face_108 = new THREE.Group();
  node_prop_orb_2_face_108.name = "Drone face prop-orb-2__pivot";
  node_prop_orb_2_face_108.scale.set(1, 1, 1);
  if (endpoint_prop_orb_2_face_108) {
    node_prop_orb_2_face_108.position.copy(endpoint_prop_orb_2_face_108.start);
    node_prop_orb_2_face_108.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_orb_2_face_108.position.set(0.0, 0.0, 0.04296);
    node_prop_orb_2_face_108.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_orb_2_face_108.userData.sculptComponent = { id: "prop-orb-2-face" };
  node_prop_orb_2_face_108.userData.actionProfile = {};
  (nodes["prop-orb-2"] ?? root).add(node_prop_orb_2_face_108);
  nodes["prop-orb-2-face"] = node_prop_orb_2_face_108;
  const mesh_prop_orb_2_face_108Geometry = endpoint_prop_orb_2_face_108
    ? new THREE.CylinderGeometry(endpoint_prop_orb_2_face_108.endRadius, endpoint_prop_orb_2_face_108.baseRadius, endpoint_prop_orb_2_face_108.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_prop_orb_2_face_108) {
    mesh_prop_orb_2_face_108Geometry.scale(0.10047, 0.08315, 0.0485);
  }
  const mesh_prop_orb_2_face_108 = new THREE.Mesh(
    mesh_prop_orb_2_face_108Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_orb_2_face_108.name = "Drone face prop-orb-2";
  if (endpoint_prop_orb_2_face_108) {
    mesh_prop_orb_2_face_108.position.copy(endpoint_prop_orb_2_face_108.midpoint);
    mesh_prop_orb_2_face_108.quaternion.copy(endpoint_prop_orb_2_face_108.quaternion);
  }
  mesh_prop_orb_2_face_108.castShadow = options.castShadow ?? true;
  mesh_prop_orb_2_face_108.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_orb_2_face_108.userData.sculptComponent = { id: "prop-orb-2-face" };
  node_prop_orb_2_face_108.add(mesh_prop_orb_2_face_108);
  meshes["prop-orb-2-face"] = mesh_prop_orb_2_face_108;
  colliders["prop-orb-2-face"] = {};
  destructionGroups["prop-orb-2"] ??= [];
  destructionGroups["prop-orb-2"].push(node_prop_orb_2_face_108);

  const endpoint_prop_orb_2_eye0_109 = makeAttachmentEndpoint(null);
  const node_prop_orb_2_eye0_109 = new THREE.Group();
  node_prop_orb_2_eye0_109.name = "Drone eye prop-orb-2 0__pivot";
  node_prop_orb_2_eye0_109.scale.set(1, 1, 1);
  if (endpoint_prop_orb_2_eye0_109) {
    node_prop_orb_2_eye0_109.position.copy(endpoint_prop_orb_2_eye0_109.start);
    node_prop_orb_2_eye0_109.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_orb_2_eye0_109.position.set(-0.0291, 0.00277, 0.06583);
    node_prop_orb_2_eye0_109.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_orb_2_eye0_109.userData.sculptComponent = { id: "prop-orb-2-eye0" };
  node_prop_orb_2_eye0_109.userData.actionProfile = {};
  (nodes["prop-orb-2"] ?? root).add(node_prop_orb_2_eye0_109);
  nodes["prop-orb-2-eye0"] = node_prop_orb_2_eye0_109;
  const mesh_prop_orb_2_eye0_109Geometry = endpoint_prop_orb_2_eye0_109
    ? new THREE.CylinderGeometry(endpoint_prop_orb_2_eye0_109.endRadius, endpoint_prop_orb_2_eye0_109.baseRadius, endpoint_prop_orb_2_eye0_109.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_prop_orb_2_eye0_109) {
    mesh_prop_orb_2_eye0_109Geometry.scale(0.02079, 0.02356, 0.0097);
  }
  const mesh_prop_orb_2_eye0_109 = new THREE.Mesh(
    mesh_prop_orb_2_eye0_109Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_orb_2_eye0_109.name = "Drone eye prop-orb-2 0";
  if (endpoint_prop_orb_2_eye0_109) {
    mesh_prop_orb_2_eye0_109.position.copy(endpoint_prop_orb_2_eye0_109.midpoint);
    mesh_prop_orb_2_eye0_109.quaternion.copy(endpoint_prop_orb_2_eye0_109.quaternion);
  }
  mesh_prop_orb_2_eye0_109.castShadow = options.castShadow ?? true;
  mesh_prop_orb_2_eye0_109.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_orb_2_eye0_109.userData.sculptComponent = { id: "prop-orb-2-eye0" };
  node_prop_orb_2_eye0_109.add(mesh_prop_orb_2_eye0_109);
  meshes["prop-orb-2-eye0"] = mesh_prop_orb_2_eye0_109;
  colliders["prop-orb-2-eye0"] = {};
  destructionGroups["prop-orb-2"] ??= [];
  destructionGroups["prop-orb-2"].push(node_prop_orb_2_eye0_109);

  const endpoint_prop_orb_2_eye1_110 = makeAttachmentEndpoint(null);
  const node_prop_orb_2_eye1_110 = new THREE.Group();
  node_prop_orb_2_eye1_110.name = "Drone eye prop-orb-2 1__pivot";
  node_prop_orb_2_eye1_110.scale.set(1, 1, 1);
  if (endpoint_prop_orb_2_eye1_110) {
    node_prop_orb_2_eye1_110.position.copy(endpoint_prop_orb_2_eye1_110.start);
    node_prop_orb_2_eye1_110.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_orb_2_eye1_110.position.set(0.0291, 0.00277, 0.06583);
    node_prop_orb_2_eye1_110.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_orb_2_eye1_110.userData.sculptComponent = { id: "prop-orb-2-eye1" };
  node_prop_orb_2_eye1_110.userData.actionProfile = {};
  (nodes["prop-orb-2"] ?? root).add(node_prop_orb_2_eye1_110);
  nodes["prop-orb-2-eye1"] = node_prop_orb_2_eye1_110;
  const mesh_prop_orb_2_eye1_110Geometry = endpoint_prop_orb_2_eye1_110
    ? new THREE.CylinderGeometry(endpoint_prop_orb_2_eye1_110.endRadius, endpoint_prop_orb_2_eye1_110.baseRadius, endpoint_prop_orb_2_eye1_110.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_prop_orb_2_eye1_110) {
    mesh_prop_orb_2_eye1_110Geometry.scale(0.02079, 0.02356, 0.0097);
  }
  const mesh_prop_orb_2_eye1_110 = new THREE.Mesh(
    mesh_prop_orb_2_eye1_110Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_orb_2_eye1_110.name = "Drone eye prop-orb-2 1";
  if (endpoint_prop_orb_2_eye1_110) {
    mesh_prop_orb_2_eye1_110.position.copy(endpoint_prop_orb_2_eye1_110.midpoint);
    mesh_prop_orb_2_eye1_110.quaternion.copy(endpoint_prop_orb_2_eye1_110.quaternion);
  }
  mesh_prop_orb_2_eye1_110.castShadow = options.castShadow ?? true;
  mesh_prop_orb_2_eye1_110.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_orb_2_eye1_110.userData.sculptComponent = { id: "prop-orb-2-eye1" };
  node_prop_orb_2_eye1_110.add(mesh_prop_orb_2_eye1_110);
  meshes["prop-orb-2-eye1"] = mesh_prop_orb_2_eye1_110;
  colliders["prop-orb-2-eye1"] = {};
  destructionGroups["prop-orb-2"] ??= [];
  destructionGroups["prop-orb-2"].push(node_prop_orb_2_eye1_110);

  const endpoint_prop_orb_2_band_111 = makeAttachmentEndpoint(null);
  const node_prop_orb_2_band_111 = new THREE.Group();
  node_prop_orb_2_band_111.name = "Drone band prop-orb-2__pivot";
  node_prop_orb_2_band_111.scale.set(1, 1, 1);
  if (endpoint_prop_orb_2_band_111) {
    node_prop_orb_2_band_111.position.copy(endpoint_prop_orb_2_band_111.start);
    node_prop_orb_2_band_111.rotation.set(0.0, 1.5708, 0.0);
  } else {
    node_prop_orb_2_band_111.position.set(0.0, 0.0, 0.0);
    node_prop_orb_2_band_111.rotation.set(0.0, 1.5708, 0.0);
  }
  node_prop_orb_2_band_111.userData.sculptComponent = { id: "prop-orb-2-band" };
  node_prop_orb_2_band_111.userData.actionProfile = {};
  (nodes["prop-orb-2"] ?? root).add(node_prop_orb_2_band_111);
  nodes["prop-orb-2-band"] = node_prop_orb_2_band_111;
  const mesh_prop_orb_2_band_111Geometry = endpoint_prop_orb_2_band_111
    ? new THREE.CylinderGeometry(endpoint_prop_orb_2_band_111.endRadius, endpoint_prop_orb_2_band_111.baseRadius, endpoint_prop_orb_2_band_111.length, 8, 4)
    : new THREE.TorusGeometry(0.45, 0.0135, 8, 16);
  if (!endpoint_prop_orb_2_band_111) {
    mesh_prop_orb_2_band_111Geometry.scale(0.14551, 0.14551, 0.14551);
  }
  const mesh_prop_orb_2_band_111 = new THREE.Mesh(
    mesh_prop_orb_2_band_111Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_orb_2_band_111.name = "Drone band prop-orb-2";
  if (endpoint_prop_orb_2_band_111) {
    mesh_prop_orb_2_band_111.position.copy(endpoint_prop_orb_2_band_111.midpoint);
    mesh_prop_orb_2_band_111.quaternion.copy(endpoint_prop_orb_2_band_111.quaternion);
  }
  mesh_prop_orb_2_band_111.castShadow = options.castShadow ?? true;
  mesh_prop_orb_2_band_111.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_orb_2_band_111.userData.sculptComponent = { id: "prop-orb-2-band" };
  node_prop_orb_2_band_111.add(mesh_prop_orb_2_band_111);
  meshes["prop-orb-2-band"] = mesh_prop_orb_2_band_111;
  colliders["prop-orb-2-band"] = {};
  destructionGroups["prop-orb-2"] ??= [];
  destructionGroups["prop-orb-2"].push(node_prop_orb_2_band_111);

  const endpoint_prop_orb_3_112 = makeAttachmentEndpoint(null);
  const node_prop_orb_3_112 = new THREE.Group();
  node_prop_orb_3_112.name = "Orb drone prop-orb-3__pivot";
  node_prop_orb_3_112.scale.set(1, 1, 1);
  if (endpoint_prop_orb_3_112) {
    node_prop_orb_3_112.position.copy(endpoint_prop_orb_3_112.start);
    node_prop_orb_3_112.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_orb_3_112.position.set(0.47874, 0.94488, 0.10079);
    node_prop_orb_3_112.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_orb_3_112.userData.sculptComponent = { id: "prop-orb-3" };
  node_prop_orb_3_112.userData.actionProfile = {};
  (nodes["root"] ?? root).add(node_prop_orb_3_112);
  nodes["prop-orb-3"] = node_prop_orb_3_112;
  const mesh_prop_orb_3_112Geometry = endpoint_prop_orb_3_112
    ? new THREE.CylinderGeometry(endpoint_prop_orb_3_112.endRadius, endpoint_prop_orb_3_112.baseRadius, endpoint_prop_orb_3_112.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_prop_orb_3_112) {
    mesh_prop_orb_3_112Geometry.scale(0.20158, 0.20158, 0.20158);
  }
  const mesh_prop_orb_3_112 = new THREE.Mesh(
    mesh_prop_orb_3_112Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_orb_3_112.name = "Orb drone prop-orb-3";
  if (endpoint_prop_orb_3_112) {
    mesh_prop_orb_3_112.position.copy(endpoint_prop_orb_3_112.midpoint);
    mesh_prop_orb_3_112.quaternion.copy(endpoint_prop_orb_3_112.quaternion);
  }
  mesh_prop_orb_3_112.castShadow = options.castShadow ?? true;
  mesh_prop_orb_3_112.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_orb_3_112.userData.sculptComponent = { id: "prop-orb-3" };
  node_prop_orb_3_112.add(mesh_prop_orb_3_112);
  meshes["prop-orb-3"] = mesh_prop_orb_3_112;
  colliders["prop-orb-3"] = {};
  destructionGroups["prop-orb-3"] ??= [];
  destructionGroups["prop-orb-3"].push(node_prop_orb_3_112);

  const endpoint_prop_orb_3_face_113 = makeAttachmentEndpoint(null);
  const node_prop_orb_3_face_113 = new THREE.Group();
  node_prop_orb_3_face_113.name = "Drone face prop-orb-3__pivot";
  node_prop_orb_3_face_113.scale.set(1, 1, 1);
  if (endpoint_prop_orb_3_face_113) {
    node_prop_orb_3_face_113.position.copy(endpoint_prop_orb_3_face_113.start);
    node_prop_orb_3_face_113.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_orb_3_face_113.position.set(0.0, 0.0, 0.06249);
    node_prop_orb_3_face_113.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_orb_3_face_113.userData.sculptComponent = { id: "prop-orb-3-face" };
  node_prop_orb_3_face_113.userData.actionProfile = {};
  (nodes["prop-orb-3"] ?? root).add(node_prop_orb_3_face_113);
  nodes["prop-orb-3-face"] = node_prop_orb_3_face_113;
  const mesh_prop_orb_3_face_113Geometry = endpoint_prop_orb_3_face_113
    ? new THREE.CylinderGeometry(endpoint_prop_orb_3_face_113.endRadius, endpoint_prop_orb_3_face_113.baseRadius, endpoint_prop_orb_3_face_113.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_prop_orb_3_face_113) {
    mesh_prop_orb_3_face_113Geometry.scale(0.14614, 0.12095, 0.07055);
  }
  const mesh_prop_orb_3_face_113 = new THREE.Mesh(
    mesh_prop_orb_3_face_113Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_orb_3_face_113.name = "Drone face prop-orb-3";
  if (endpoint_prop_orb_3_face_113) {
    mesh_prop_orb_3_face_113.position.copy(endpoint_prop_orb_3_face_113.midpoint);
    mesh_prop_orb_3_face_113.quaternion.copy(endpoint_prop_orb_3_face_113.quaternion);
  }
  mesh_prop_orb_3_face_113.castShadow = options.castShadow ?? true;
  mesh_prop_orb_3_face_113.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_orb_3_face_113.userData.sculptComponent = { id: "prop-orb-3-face" };
  node_prop_orb_3_face_113.add(mesh_prop_orb_3_face_113);
  meshes["prop-orb-3-face"] = mesh_prop_orb_3_face_113;
  colliders["prop-orb-3-face"] = {};
  destructionGroups["prop-orb-3"] ??= [];
  destructionGroups["prop-orb-3"].push(node_prop_orb_3_face_113);

  const endpoint_prop_orb_3_eye0_114 = makeAttachmentEndpoint(null);
  const node_prop_orb_3_eye0_114 = new THREE.Group();
  node_prop_orb_3_eye0_114.name = "Drone eye prop-orb-3 0__pivot";
  node_prop_orb_3_eye0_114.scale.set(1, 1, 1);
  if (endpoint_prop_orb_3_eye0_114) {
    node_prop_orb_3_eye0_114.position.copy(endpoint_prop_orb_3_eye0_114.start);
    node_prop_orb_3_eye0_114.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_orb_3_eye0_114.position.set(-0.04233, 0.00403, 0.09575);
    node_prop_orb_3_eye0_114.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_orb_3_eye0_114.userData.sculptComponent = { id: "prop-orb-3-eye0" };
  node_prop_orb_3_eye0_114.userData.actionProfile = {};
  (nodes["prop-orb-3"] ?? root).add(node_prop_orb_3_eye0_114);
  nodes["prop-orb-3-eye0"] = node_prop_orb_3_eye0_114;
  const mesh_prop_orb_3_eye0_114Geometry = endpoint_prop_orb_3_eye0_114
    ? new THREE.CylinderGeometry(endpoint_prop_orb_3_eye0_114.endRadius, endpoint_prop_orb_3_eye0_114.baseRadius, endpoint_prop_orb_3_eye0_114.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_prop_orb_3_eye0_114) {
    mesh_prop_orb_3_eye0_114Geometry.scale(0.03024, 0.03427, 0.01411);
  }
  const mesh_prop_orb_3_eye0_114 = new THREE.Mesh(
    mesh_prop_orb_3_eye0_114Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_orb_3_eye0_114.name = "Drone eye prop-orb-3 0";
  if (endpoint_prop_orb_3_eye0_114) {
    mesh_prop_orb_3_eye0_114.position.copy(endpoint_prop_orb_3_eye0_114.midpoint);
    mesh_prop_orb_3_eye0_114.quaternion.copy(endpoint_prop_orb_3_eye0_114.quaternion);
  }
  mesh_prop_orb_3_eye0_114.castShadow = options.castShadow ?? true;
  mesh_prop_orb_3_eye0_114.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_orb_3_eye0_114.userData.sculptComponent = { id: "prop-orb-3-eye0" };
  node_prop_orb_3_eye0_114.add(mesh_prop_orb_3_eye0_114);
  meshes["prop-orb-3-eye0"] = mesh_prop_orb_3_eye0_114;
  colliders["prop-orb-3-eye0"] = {};
  destructionGroups["prop-orb-3"] ??= [];
  destructionGroups["prop-orb-3"].push(node_prop_orb_3_eye0_114);

  const endpoint_prop_orb_3_eye1_115 = makeAttachmentEndpoint(null);
  const node_prop_orb_3_eye1_115 = new THREE.Group();
  node_prop_orb_3_eye1_115.name = "Drone eye prop-orb-3 1__pivot";
  node_prop_orb_3_eye1_115.scale.set(1, 1, 1);
  if (endpoint_prop_orb_3_eye1_115) {
    node_prop_orb_3_eye1_115.position.copy(endpoint_prop_orb_3_eye1_115.start);
    node_prop_orb_3_eye1_115.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_orb_3_eye1_115.position.set(0.04233, 0.00403, 0.09575);
    node_prop_orb_3_eye1_115.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_orb_3_eye1_115.userData.sculptComponent = { id: "prop-orb-3-eye1" };
  node_prop_orb_3_eye1_115.userData.actionProfile = {};
  (nodes["prop-orb-3"] ?? root).add(node_prop_orb_3_eye1_115);
  nodes["prop-orb-3-eye1"] = node_prop_orb_3_eye1_115;
  const mesh_prop_orb_3_eye1_115Geometry = endpoint_prop_orb_3_eye1_115
    ? new THREE.CylinderGeometry(endpoint_prop_orb_3_eye1_115.endRadius, endpoint_prop_orb_3_eye1_115.baseRadius, endpoint_prop_orb_3_eye1_115.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_prop_orb_3_eye1_115) {
    mesh_prop_orb_3_eye1_115Geometry.scale(0.03024, 0.03427, 0.01411);
  }
  const mesh_prop_orb_3_eye1_115 = new THREE.Mesh(
    mesh_prop_orb_3_eye1_115Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_orb_3_eye1_115.name = "Drone eye prop-orb-3 1";
  if (endpoint_prop_orb_3_eye1_115) {
    mesh_prop_orb_3_eye1_115.position.copy(endpoint_prop_orb_3_eye1_115.midpoint);
    mesh_prop_orb_3_eye1_115.quaternion.copy(endpoint_prop_orb_3_eye1_115.quaternion);
  }
  mesh_prop_orb_3_eye1_115.castShadow = options.castShadow ?? true;
  mesh_prop_orb_3_eye1_115.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_orb_3_eye1_115.userData.sculptComponent = { id: "prop-orb-3-eye1" };
  node_prop_orb_3_eye1_115.add(mesh_prop_orb_3_eye1_115);
  meshes["prop-orb-3-eye1"] = mesh_prop_orb_3_eye1_115;
  colliders["prop-orb-3-eye1"] = {};
  destructionGroups["prop-orb-3"] ??= [];
  destructionGroups["prop-orb-3"].push(node_prop_orb_3_eye1_115);

  const endpoint_prop_orb_3_band_116 = makeAttachmentEndpoint(null);
  const node_prop_orb_3_band_116 = new THREE.Group();
  node_prop_orb_3_band_116.name = "Drone band prop-orb-3__pivot";
  node_prop_orb_3_band_116.scale.set(1, 1, 1);
  if (endpoint_prop_orb_3_band_116) {
    node_prop_orb_3_band_116.position.copy(endpoint_prop_orb_3_band_116.start);
    node_prop_orb_3_band_116.rotation.set(0.0, 1.5708, 0.0);
  } else {
    node_prop_orb_3_band_116.position.set(0.0, 0.0, 0.0);
    node_prop_orb_3_band_116.rotation.set(0.0, 1.5708, 0.0);
  }
  node_prop_orb_3_band_116.userData.sculptComponent = { id: "prop-orb-3-band" };
  node_prop_orb_3_band_116.userData.actionProfile = {};
  (nodes["prop-orb-3"] ?? root).add(node_prop_orb_3_band_116);
  nodes["prop-orb-3-band"] = node_prop_orb_3_band_116;
  const mesh_prop_orb_3_band_116Geometry = endpoint_prop_orb_3_band_116
    ? new THREE.CylinderGeometry(endpoint_prop_orb_3_band_116.endRadius, endpoint_prop_orb_3_band_116.baseRadius, endpoint_prop_orb_3_band_116.length, 8, 4)
    : new THREE.TorusGeometry(0.45, 0.0135, 8, 16);
  if (!endpoint_prop_orb_3_band_116) {
    mesh_prop_orb_3_band_116Geometry.scale(0.21165, 0.21165, 0.21165);
  }
  const mesh_prop_orb_3_band_116 = new THREE.Mesh(
    mesh_prop_orb_3_band_116Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_orb_3_band_116.name = "Drone band prop-orb-3";
  if (endpoint_prop_orb_3_band_116) {
    mesh_prop_orb_3_band_116.position.copy(endpoint_prop_orb_3_band_116.midpoint);
    mesh_prop_orb_3_band_116.quaternion.copy(endpoint_prop_orb_3_band_116.quaternion);
  }
  mesh_prop_orb_3_band_116.castShadow = options.castShadow ?? true;
  mesh_prop_orb_3_band_116.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_orb_3_band_116.userData.sculptComponent = { id: "prop-orb-3-band" };
  node_prop_orb_3_band_116.add(mesh_prop_orb_3_band_116);
  meshes["prop-orb-3-band"] = mesh_prop_orb_3_band_116;
  colliders["prop-orb-3-band"] = {};
  destructionGroups["prop-orb-3"] ??= [];
  destructionGroups["prop-orb-3"].push(node_prop_orb_3_band_116);

  const endpoint_prop_orb_4_117 = makeAttachmentEndpoint(null);
  const node_prop_orb_4_117 = new THREE.Group();
  node_prop_orb_4_117.name = "Orb drone prop-orb-4__pivot";
  node_prop_orb_4_117.scale.set(1, 1, 1);
  if (endpoint_prop_orb_4_117) {
    node_prop_orb_4_117.position.copy(endpoint_prop_orb_4_117.start);
    node_prop_orb_4_117.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_orb_4_117.position.set(-0.44724, 0.65512, 0.10079);
    node_prop_orb_4_117.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_orb_4_117.userData.sculptComponent = { id: "prop-orb-4" };
  node_prop_orb_4_117.userData.actionProfile = {};
  (nodes["root"] ?? root).add(node_prop_orb_4_117);
  nodes["prop-orb-4"] = node_prop_orb_4_117;
  const mesh_prop_orb_4_117Geometry = endpoint_prop_orb_4_117
    ? new THREE.CylinderGeometry(endpoint_prop_orb_4_117.endRadius, endpoint_prop_orb_4_117.baseRadius, endpoint_prop_orb_4_117.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_prop_orb_4_117) {
    mesh_prop_orb_4_117Geometry.scale(0.26457, 0.26457, 0.26457);
  }
  const mesh_prop_orb_4_117 = new THREE.Mesh(
    mesh_prop_orb_4_117Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_orb_4_117.name = "Orb drone prop-orb-4";
  if (endpoint_prop_orb_4_117) {
    mesh_prop_orb_4_117.position.copy(endpoint_prop_orb_4_117.midpoint);
    mesh_prop_orb_4_117.quaternion.copy(endpoint_prop_orb_4_117.quaternion);
  }
  mesh_prop_orb_4_117.castShadow = options.castShadow ?? true;
  mesh_prop_orb_4_117.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_orb_4_117.userData.sculptComponent = { id: "prop-orb-4" };
  node_prop_orb_4_117.add(mesh_prop_orb_4_117);
  meshes["prop-orb-4"] = mesh_prop_orb_4_117;
  colliders["prop-orb-4"] = {};
  destructionGroups["prop-orb-4"] ??= [];
  destructionGroups["prop-orb-4"].push(node_prop_orb_4_117);

  const endpoint_prop_orb_4_face_118 = makeAttachmentEndpoint(null);
  const node_prop_orb_4_face_118 = new THREE.Group();
  node_prop_orb_4_face_118.name = "Drone face prop-orb-4__pivot";
  node_prop_orb_4_face_118.scale.set(1, 1, 1);
  if (endpoint_prop_orb_4_face_118) {
    node_prop_orb_4_face_118.position.copy(endpoint_prop_orb_4_face_118.start);
    node_prop_orb_4_face_118.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_orb_4_face_118.position.set(0.0, 0.0, 0.08202);
    node_prop_orb_4_face_118.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_orb_4_face_118.userData.sculptComponent = { id: "prop-orb-4-face" };
  node_prop_orb_4_face_118.userData.actionProfile = {};
  (nodes["prop-orb-4"] ?? root).add(node_prop_orb_4_face_118);
  nodes["prop-orb-4-face"] = node_prop_orb_4_face_118;
  const mesh_prop_orb_4_face_118Geometry = endpoint_prop_orb_4_face_118
    ? new THREE.CylinderGeometry(endpoint_prop_orb_4_face_118.endRadius, endpoint_prop_orb_4_face_118.baseRadius, endpoint_prop_orb_4_face_118.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_prop_orb_4_face_118) {
    mesh_prop_orb_4_face_118Geometry.scale(0.19181, 0.15874, 0.0926);
  }
  const mesh_prop_orb_4_face_118 = new THREE.Mesh(
    mesh_prop_orb_4_face_118Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_orb_4_face_118.name = "Drone face prop-orb-4";
  if (endpoint_prop_orb_4_face_118) {
    mesh_prop_orb_4_face_118.position.copy(endpoint_prop_orb_4_face_118.midpoint);
    mesh_prop_orb_4_face_118.quaternion.copy(endpoint_prop_orb_4_face_118.quaternion);
  }
  mesh_prop_orb_4_face_118.castShadow = options.castShadow ?? true;
  mesh_prop_orb_4_face_118.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_orb_4_face_118.userData.sculptComponent = { id: "prop-orb-4-face" };
  node_prop_orb_4_face_118.add(mesh_prop_orb_4_face_118);
  meshes["prop-orb-4-face"] = mesh_prop_orb_4_face_118;
  colliders["prop-orb-4-face"] = {};
  destructionGroups["prop-orb-4"] ??= [];
  destructionGroups["prop-orb-4"].push(node_prop_orb_4_face_118);

  const endpoint_prop_orb_4_eye0_119 = makeAttachmentEndpoint(null);
  const node_prop_orb_4_eye0_119 = new THREE.Group();
  node_prop_orb_4_eye0_119.name = "Drone eye prop-orb-4 0__pivot";
  node_prop_orb_4_eye0_119.scale.set(1, 1, 1);
  if (endpoint_prop_orb_4_eye0_119) {
    node_prop_orb_4_eye0_119.position.copy(endpoint_prop_orb_4_eye0_119.start);
    node_prop_orb_4_eye0_119.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_orb_4_eye0_119.position.set(-0.05556, 0.00529, 0.12567);
    node_prop_orb_4_eye0_119.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_orb_4_eye0_119.userData.sculptComponent = { id: "prop-orb-4-eye0" };
  node_prop_orb_4_eye0_119.userData.actionProfile = {};
  (nodes["prop-orb-4"] ?? root).add(node_prop_orb_4_eye0_119);
  nodes["prop-orb-4-eye0"] = node_prop_orb_4_eye0_119;
  const mesh_prop_orb_4_eye0_119Geometry = endpoint_prop_orb_4_eye0_119
    ? new THREE.CylinderGeometry(endpoint_prop_orb_4_eye0_119.endRadius, endpoint_prop_orb_4_eye0_119.baseRadius, endpoint_prop_orb_4_eye0_119.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_prop_orb_4_eye0_119) {
    mesh_prop_orb_4_eye0_119Geometry.scale(0.03969, 0.04498, 0.01852);
  }
  const mesh_prop_orb_4_eye0_119 = new THREE.Mesh(
    mesh_prop_orb_4_eye0_119Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_orb_4_eye0_119.name = "Drone eye prop-orb-4 0";
  if (endpoint_prop_orb_4_eye0_119) {
    mesh_prop_orb_4_eye0_119.position.copy(endpoint_prop_orb_4_eye0_119.midpoint);
    mesh_prop_orb_4_eye0_119.quaternion.copy(endpoint_prop_orb_4_eye0_119.quaternion);
  }
  mesh_prop_orb_4_eye0_119.castShadow = options.castShadow ?? true;
  mesh_prop_orb_4_eye0_119.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_orb_4_eye0_119.userData.sculptComponent = { id: "prop-orb-4-eye0" };
  node_prop_orb_4_eye0_119.add(mesh_prop_orb_4_eye0_119);
  meshes["prop-orb-4-eye0"] = mesh_prop_orb_4_eye0_119;
  colliders["prop-orb-4-eye0"] = {};
  destructionGroups["prop-orb-4"] ??= [];
  destructionGroups["prop-orb-4"].push(node_prop_orb_4_eye0_119);

  const endpoint_prop_orb_4_eye1_120 = makeAttachmentEndpoint(null);
  const node_prop_orb_4_eye1_120 = new THREE.Group();
  node_prop_orb_4_eye1_120.name = "Drone eye prop-orb-4 1__pivot";
  node_prop_orb_4_eye1_120.scale.set(1, 1, 1);
  if (endpoint_prop_orb_4_eye1_120) {
    node_prop_orb_4_eye1_120.position.copy(endpoint_prop_orb_4_eye1_120.start);
    node_prop_orb_4_eye1_120.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_orb_4_eye1_120.position.set(0.05556, 0.00529, 0.12567);
    node_prop_orb_4_eye1_120.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_orb_4_eye1_120.userData.sculptComponent = { id: "prop-orb-4-eye1" };
  node_prop_orb_4_eye1_120.userData.actionProfile = {};
  (nodes["prop-orb-4"] ?? root).add(node_prop_orb_4_eye1_120);
  nodes["prop-orb-4-eye1"] = node_prop_orb_4_eye1_120;
  const mesh_prop_orb_4_eye1_120Geometry = endpoint_prop_orb_4_eye1_120
    ? new THREE.CylinderGeometry(endpoint_prop_orb_4_eye1_120.endRadius, endpoint_prop_orb_4_eye1_120.baseRadius, endpoint_prop_orb_4_eye1_120.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_prop_orb_4_eye1_120) {
    mesh_prop_orb_4_eye1_120Geometry.scale(0.03969, 0.04498, 0.01852);
  }
  const mesh_prop_orb_4_eye1_120 = new THREE.Mesh(
    mesh_prop_orb_4_eye1_120Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_orb_4_eye1_120.name = "Drone eye prop-orb-4 1";
  if (endpoint_prop_orb_4_eye1_120) {
    mesh_prop_orb_4_eye1_120.position.copy(endpoint_prop_orb_4_eye1_120.midpoint);
    mesh_prop_orb_4_eye1_120.quaternion.copy(endpoint_prop_orb_4_eye1_120.quaternion);
  }
  mesh_prop_orb_4_eye1_120.castShadow = options.castShadow ?? true;
  mesh_prop_orb_4_eye1_120.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_orb_4_eye1_120.userData.sculptComponent = { id: "prop-orb-4-eye1" };
  node_prop_orb_4_eye1_120.add(mesh_prop_orb_4_eye1_120);
  meshes["prop-orb-4-eye1"] = mesh_prop_orb_4_eye1_120;
  colliders["prop-orb-4-eye1"] = {};
  destructionGroups["prop-orb-4"] ??= [];
  destructionGroups["prop-orb-4"].push(node_prop_orb_4_eye1_120);

  const endpoint_prop_orb_4_band_121 = makeAttachmentEndpoint(null);
  const node_prop_orb_4_band_121 = new THREE.Group();
  node_prop_orb_4_band_121.name = "Drone band prop-orb-4__pivot";
  node_prop_orb_4_band_121.scale.set(1, 1, 1);
  if (endpoint_prop_orb_4_band_121) {
    node_prop_orb_4_band_121.position.copy(endpoint_prop_orb_4_band_121.start);
    node_prop_orb_4_band_121.rotation.set(0.0, 1.5708, 0.0);
  } else {
    node_prop_orb_4_band_121.position.set(0.0, 0.0, 0.0);
    node_prop_orb_4_band_121.rotation.set(0.0, 1.5708, 0.0);
  }
  node_prop_orb_4_band_121.userData.sculptComponent = { id: "prop-orb-4-band" };
  node_prop_orb_4_band_121.userData.actionProfile = {};
  (nodes["prop-orb-4"] ?? root).add(node_prop_orb_4_band_121);
  nodes["prop-orb-4-band"] = node_prop_orb_4_band_121;
  const mesh_prop_orb_4_band_121Geometry = endpoint_prop_orb_4_band_121
    ? new THREE.CylinderGeometry(endpoint_prop_orb_4_band_121.endRadius, endpoint_prop_orb_4_band_121.baseRadius, endpoint_prop_orb_4_band_121.length, 8, 4)
    : new THREE.TorusGeometry(0.45, 0.0135, 8, 16);
  if (!endpoint_prop_orb_4_band_121) {
    mesh_prop_orb_4_band_121Geometry.scale(0.2778, 0.2778, 0.2778);
  }
  const mesh_prop_orb_4_band_121 = new THREE.Mesh(
    mesh_prop_orb_4_band_121Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_orb_4_band_121.name = "Drone band prop-orb-4";
  if (endpoint_prop_orb_4_band_121) {
    mesh_prop_orb_4_band_121.position.copy(endpoint_prop_orb_4_band_121.midpoint);
    mesh_prop_orb_4_band_121.quaternion.copy(endpoint_prop_orb_4_band_121.quaternion);
  }
  mesh_prop_orb_4_band_121.castShadow = options.castShadow ?? true;
  mesh_prop_orb_4_band_121.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_orb_4_band_121.userData.sculptComponent = { id: "prop-orb-4-band" };
  node_prop_orb_4_band_121.add(mesh_prop_orb_4_band_121);
  meshes["prop-orb-4-band"] = mesh_prop_orb_4_band_121;
  colliders["prop-orb-4-band"] = {};
  destructionGroups["prop-orb-4"] ??= [];
  destructionGroups["prop-orb-4"].push(node_prop_orb_4_band_121);

  const endpoint_prop_wheel_122 = makeAttachmentEndpoint(null);
  const node_prop_wheel_122 = new THREE.Group();
  node_prop_wheel_122.name = "Wheel drone__pivot";
  node_prop_wheel_122.scale.set(1, 1, 1);
  if (endpoint_prop_wheel_122) {
    node_prop_wheel_122.position.copy(endpoint_prop_wheel_122.start);
    node_prop_wheel_122.rotation.set(1.5708, 0.0, 0.0);
  } else {
    node_prop_wheel_122.position.set(0.0, 0.35276, 0.20158);
    node_prop_wheel_122.rotation.set(1.5708, 0.0, 0.0);
  }
  node_prop_wheel_122.userData.sculptComponent = { id: "prop-wheel" };
  node_prop_wheel_122.userData.actionProfile = {};
  (nodes["root"] ?? root).add(node_prop_wheel_122);
  nodes["prop-wheel"] = node_prop_wheel_122;
  const mesh_prop_wheel_122Geometry = endpoint_prop_wheel_122
    ? new THREE.CylinderGeometry(endpoint_prop_wheel_122.endRadius, endpoint_prop_wheel_122.baseRadius, endpoint_prop_wheel_122.length, 8, 4)
    : buildLatheGeometry({"points": [[0, -0.0378], [0.14488, -0.0378], [0.18898, -0.0189], [0.18898, 0.0189], [0.14488, 0.0378], [0, 0.0378]], "segments": 28});
  if (!endpoint_prop_wheel_122) {
    mesh_prop_wheel_122Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_prop_wheel_122 = new THREE.Mesh(
    mesh_prop_wheel_122Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_wheel_122.name = "Wheel drone";
  if (endpoint_prop_wheel_122) {
    mesh_prop_wheel_122.position.copy(endpoint_prop_wheel_122.midpoint);
    mesh_prop_wheel_122.quaternion.copy(endpoint_prop_wheel_122.quaternion);
  }
  mesh_prop_wheel_122.castShadow = options.castShadow ?? true;
  mesh_prop_wheel_122.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_wheel_122.userData.sculptComponent = { id: "prop-wheel" };
  node_prop_wheel_122.add(mesh_prop_wheel_122);
  meshes["prop-wheel"] = mesh_prop_wheel_122;
  colliders["prop-wheel"] = {};
  destructionGroups["wheel"] ??= [];
  destructionGroups["wheel"].push(node_prop_wheel_122);

  const endpoint_prop_wheel_gold_123 = makeAttachmentEndpoint(null);
  const node_prop_wheel_gold_123 = new THREE.Group();
  node_prop_wheel_gold_123.name = "Wheel gold band__pivot";
  node_prop_wheel_gold_123.scale.set(1, 1, 1);
  if (endpoint_prop_wheel_gold_123) {
    node_prop_wheel_gold_123.position.copy(endpoint_prop_wheel_gold_123.start);
    node_prop_wheel_gold_123.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_wheel_gold_123.position.set(0.0, 0.0, 0.0378);
    node_prop_wheel_gold_123.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_wheel_gold_123.userData.sculptComponent = { id: "prop-wheel-gold" };
  node_prop_wheel_gold_123.userData.actionProfile = {};
  (nodes["prop-wheel"] ?? root).add(node_prop_wheel_gold_123);
  nodes["prop-wheel-gold"] = node_prop_wheel_gold_123;
  const mesh_prop_wheel_gold_123Geometry = endpoint_prop_wheel_gold_123
    ? new THREE.CylinderGeometry(endpoint_prop_wheel_gold_123.endRadius, endpoint_prop_wheel_gold_123.baseRadius, endpoint_prop_wheel_gold_123.length, 8, 4)
    : new THREE.TorusGeometry(0.45, 0.0241, 8, 16);
  if (!endpoint_prop_wheel_gold_123) {
    mesh_prop_wheel_gold_123Geometry.scale(0.39195, 0.39195, 0.39195);
  }
  const mesh_prop_wheel_gold_123 = new THREE.Mesh(
    mesh_prop_wheel_gold_123Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_wheel_gold_123.name = "Wheel gold band";
  if (endpoint_prop_wheel_gold_123) {
    mesh_prop_wheel_gold_123.position.copy(endpoint_prop_wheel_gold_123.midpoint);
    mesh_prop_wheel_gold_123.quaternion.copy(endpoint_prop_wheel_gold_123.quaternion);
  }
  mesh_prop_wheel_gold_123.castShadow = options.castShadow ?? true;
  mesh_prop_wheel_gold_123.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_wheel_gold_123.userData.sculptComponent = { id: "prop-wheel-gold" };
  node_prop_wheel_gold_123.add(mesh_prop_wheel_gold_123);
  meshes["prop-wheel-gold"] = mesh_prop_wheel_gold_123;
  colliders["prop-wheel-gold"] = {};
  destructionGroups["wheel"] ??= [];
  destructionGroups["wheel"].push(node_prop_wheel_gold_123);

  const endpoint_prop_wheel_glow_124 = makeAttachmentEndpoint(null);
  const node_prop_wheel_glow_124 = new THREE.Group();
  node_prop_wheel_glow_124.name = "Wheel glow ring__pivot";
  node_prop_wheel_glow_124.scale.set(1, 1, 1);
  if (endpoint_prop_wheel_glow_124) {
    node_prop_wheel_glow_124.position.copy(endpoint_prop_wheel_glow_124.start);
    node_prop_wheel_glow_124.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_wheel_glow_124.position.set(0.0, 0.0, -0.0126);
    node_prop_wheel_glow_124.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_wheel_glow_124.userData.sculptComponent = { id: "prop-wheel-glow" };
  node_prop_wheel_glow_124.userData.actionProfile = {};
  (nodes["prop-wheel"] ?? root).add(node_prop_wheel_glow_124);
  nodes["prop-wheel-glow"] = node_prop_wheel_glow_124;
  const mesh_prop_wheel_glow_124Geometry = endpoint_prop_wheel_glow_124
    ? new THREE.CylinderGeometry(endpoint_prop_wheel_glow_124.endRadius, endpoint_prop_wheel_glow_124.baseRadius, endpoint_prop_wheel_glow_124.length, 8, 4)
    : new THREE.TorusGeometry(0.45, 0.0264, 8, 16);
  if (!endpoint_prop_wheel_glow_124) {
    mesh_prop_wheel_glow_124Geometry.scale(0.40595, 0.40595, 0.40595);
  }
  const mesh_prop_wheel_glow_124 = new THREE.Mesh(
    mesh_prop_wheel_glow_124Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_wheel_glow_124.name = "Wheel glow ring";
  if (endpoint_prop_wheel_glow_124) {
    mesh_prop_wheel_glow_124.position.copy(endpoint_prop_wheel_glow_124.midpoint);
    mesh_prop_wheel_glow_124.quaternion.copy(endpoint_prop_wheel_glow_124.quaternion);
  }
  mesh_prop_wheel_glow_124.castShadow = options.castShadow ?? true;
  mesh_prop_wheel_glow_124.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_wheel_glow_124.userData.sculptComponent = { id: "prop-wheel-glow" };
  node_prop_wheel_glow_124.add(mesh_prop_wheel_glow_124);
  meshes["prop-wheel-glow"] = mesh_prop_wheel_glow_124;
  colliders["prop-wheel-glow"] = {};
  destructionGroups["wheel"] ??= [];
  destructionGroups["wheel"].push(node_prop_wheel_glow_124);

  const endpoint_prop_wheel_lens_125 = makeAttachmentEndpoint(null);
  const node_prop_wheel_lens_125 = new THREE.Group();
  node_prop_wheel_lens_125.name = "Wheel lens__pivot";
  node_prop_wheel_lens_125.scale.set(1, 1, 1);
  if (endpoint_prop_wheel_lens_125) {
    node_prop_wheel_lens_125.position.copy(endpoint_prop_wheel_lens_125.start);
    node_prop_wheel_lens_125.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_wheel_lens_125.position.set(0.0, 0.0, 0.04409);
    node_prop_wheel_lens_125.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_wheel_lens_125.userData.sculptComponent = { id: "prop-wheel-lens" };
  node_prop_wheel_lens_125.userData.actionProfile = {};
  (nodes["prop-wheel"] ?? root).add(node_prop_wheel_lens_125);
  nodes["prop-wheel-lens"] = node_prop_wheel_lens_125;
  const mesh_prop_wheel_lens_125Geometry = endpoint_prop_wheel_lens_125
    ? new THREE.CylinderGeometry(endpoint_prop_wheel_lens_125.endRadius, endpoint_prop_wheel_lens_125.baseRadius, endpoint_prop_wheel_lens_125.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_prop_wheel_lens_125) {
    mesh_prop_wheel_lens_125Geometry.scale(0.06929, 0.06929, 0.06929);
  }
  const mesh_prop_wheel_lens_125 = new THREE.Mesh(
    mesh_prop_wheel_lens_125Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_wheel_lens_125.name = "Wheel lens";
  if (endpoint_prop_wheel_lens_125) {
    mesh_prop_wheel_lens_125.position.copy(endpoint_prop_wheel_lens_125.midpoint);
    mesh_prop_wheel_lens_125.quaternion.copy(endpoint_prop_wheel_lens_125.quaternion);
  }
  mesh_prop_wheel_lens_125.castShadow = options.castShadow ?? true;
  mesh_prop_wheel_lens_125.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_wheel_lens_125.userData.sculptComponent = { id: "prop-wheel-lens" };
  node_prop_wheel_lens_125.add(mesh_prop_wheel_lens_125);
  meshes["prop-wheel-lens"] = mesh_prop_wheel_lens_125;
  colliders["prop-wheel-lens"] = {};
  destructionGroups["wheel"] ??= [];
  destructionGroups["wheel"].push(node_prop_wheel_lens_125);

  const endpoint_prop_icon_contact_126 = makeAttachmentEndpoint(null);
  const node_prop_icon_contact_126 = new THREE.Group();
  node_prop_icon_contact_126.name = "Icon tile prop-icon-contact__pivot";
  node_prop_icon_contact_126.scale.set(1, 1, 1);
  if (endpoint_prop_icon_contact_126) {
    node_prop_icon_contact_126.position.copy(endpoint_prop_icon_contact_126.start);
    node_prop_icon_contact_126.rotation.set(0.0, 0.4, 0.0);
  } else {
    node_prop_icon_contact_126.position.set(-0.47874, 1.66929, 0.09449);
    node_prop_icon_contact_126.rotation.set(0.0, 0.4, 0.0);
  }
  node_prop_icon_contact_126.userData.sculptComponent = { id: "prop-icon-contact" };
  node_prop_icon_contact_126.userData.actionProfile = {};
  (nodes["root"] ?? root).add(node_prop_icon_contact_126);
  nodes["prop-icon-contact"] = node_prop_icon_contact_126;
  const mesh_prop_icon_contact_126Geometry = endpoint_prop_icon_contact_126
    ? new THREE.CylinderGeometry(endpoint_prop_icon_contact_126.endRadius, endpoint_prop_icon_contact_126.baseRadius, endpoint_prop_icon_contact_126.length, 8, 4)
    : buildExtrudeGeometry({"points": [[0.07874, 0.04409], [0.0761, 0.05735], [0.06859, 0.06859], [0.05735, 0.0761], [0.04409, 0.07874], [-0.04409, 0.07874], [-0.05735, 0.0761], [-0.06859, 0.06859], [-0.0761, 0.05735], [-0.07874, 0.04409], [-0.07874, -0.04409], [-0.0761, -0.05735], [-0.06859, -0.06859], [-0.05735, -0.0761], [-0.04409, -0.07874], [0.04409, -0.07874], [0.05735, -0.0761], [0.06859, -0.06859], [0.0761, -0.05735], [0.07874, -0.04409]], "depth": 0.00945});
  if (!endpoint_prop_icon_contact_126) {
    mesh_prop_icon_contact_126Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_prop_icon_contact_126 = new THREE.Mesh(
    mesh_prop_icon_contact_126Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_icon_contact_126.name = "Icon tile prop-icon-contact";
  if (endpoint_prop_icon_contact_126) {
    mesh_prop_icon_contact_126.position.copy(endpoint_prop_icon_contact_126.midpoint);
    mesh_prop_icon_contact_126.quaternion.copy(endpoint_prop_icon_contact_126.quaternion);
  }
  mesh_prop_icon_contact_126.castShadow = options.castShadow ?? true;
  mesh_prop_icon_contact_126.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_icon_contact_126.userData.sculptComponent = { id: "prop-icon-contact" };
  node_prop_icon_contact_126.add(mesh_prop_icon_contact_126);
  meshes["prop-icon-contact"] = mesh_prop_icon_contact_126;
  colliders["prop-icon-contact"] = {};
  destructionGroups["icons"] ??= [];
  destructionGroups["icons"].push(node_prop_icon_contact_126);

  const endpoint_prop_icon_contact_head_127 = makeAttachmentEndpoint(null);
  const node_prop_icon_contact_head_127 = new THREE.Group();
  node_prop_icon_contact_head_127.name = "Glyph prop-icon-contact head__pivot";
  node_prop_icon_contact_head_127.scale.set(1, 1, 1);
  if (endpoint_prop_icon_contact_head_127) {
    node_prop_icon_contact_head_127.position.copy(endpoint_prop_icon_contact_head_127.start);
    node_prop_icon_contact_head_127.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_icon_contact_head_127.position.set(0.0, 0.0, 0.01008);
    node_prop_icon_contact_head_127.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_icon_contact_head_127.userData.sculptComponent = { id: "prop-icon-contact-head" };
  node_prop_icon_contact_head_127.userData.actionProfile = {};
  (nodes["prop-icon-contact"] ?? root).add(node_prop_icon_contact_head_127);
  nodes["prop-icon-contact-head"] = node_prop_icon_contact_head_127;
  const mesh_prop_icon_contact_head_127Geometry = endpoint_prop_icon_contact_head_127
    ? new THREE.CylinderGeometry(endpoint_prop_icon_contact_head_127.endRadius, endpoint_prop_icon_contact_head_127.baseRadius, endpoint_prop_icon_contact_head_127.length, 8, 4)
    : buildExtrudeGeometry({"points": [[0.01339, 0.01575], [0.01206, 0.02156], [0.00835, 0.02621], [0.00298, 0.0288], [-0.00298, 0.0288], [-0.00835, 0.02621], [-0.01206, 0.02156], [-0.01339, 0.01575], [-0.01206, 0.00994], [-0.00835, 0.00528], [-0.00298, 0.0027], [0.00298, 0.0027], [0.00835, 0.00528], [0.01206, 0.00994]], "depth": 0.0063});
  if (!endpoint_prop_icon_contact_head_127) {
    mesh_prop_icon_contact_head_127Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_prop_icon_contact_head_127 = new THREE.Mesh(
    mesh_prop_icon_contact_head_127Geometry,
    materialMap["emblem-white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_icon_contact_head_127.name = "Glyph prop-icon-contact head";
  if (endpoint_prop_icon_contact_head_127) {
    mesh_prop_icon_contact_head_127.position.copy(endpoint_prop_icon_contact_head_127.midpoint);
    mesh_prop_icon_contact_head_127.quaternion.copy(endpoint_prop_icon_contact_head_127.quaternion);
  }
  mesh_prop_icon_contact_head_127.castShadow = options.castShadow ?? true;
  mesh_prop_icon_contact_head_127.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_icon_contact_head_127.userData.sculptComponent = { id: "prop-icon-contact-head" };
  node_prop_icon_contact_head_127.add(mesh_prop_icon_contact_head_127);
  meshes["prop-icon-contact-head"] = mesh_prop_icon_contact_head_127;
  colliders["prop-icon-contact-head"] = {};
  destructionGroups["icons"] ??= [];
  destructionGroups["icons"].push(node_prop_icon_contact_head_127);

  const endpoint_prop_icon_contact_body_128 = makeAttachmentEndpoint(null);
  const node_prop_icon_contact_body_128 = new THREE.Group();
  node_prop_icon_contact_body_128.name = "Glyph prop-icon-contact body__pivot";
  node_prop_icon_contact_body_128.scale.set(1, 1, 1);
  if (endpoint_prop_icon_contact_body_128) {
    node_prop_icon_contact_body_128.position.copy(endpoint_prop_icon_contact_body_128.start);
    node_prop_icon_contact_body_128.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_icon_contact_body_128.position.set(0.0, 0.0, 0.01008);
    node_prop_icon_contact_body_128.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_icon_contact_body_128.userData.sculptComponent = { id: "prop-icon-contact-body" };
  node_prop_icon_contact_body_128.userData.actionProfile = {};
  (nodes["prop-icon-contact"] ?? root).add(node_prop_icon_contact_body_128);
  nodes["prop-icon-contact-body"] = node_prop_icon_contact_body_128;
  const mesh_prop_icon_contact_body_128Geometry = endpoint_prop_icon_contact_body_128
    ? new THREE.CylinderGeometry(endpoint_prop_icon_contact_body_128.endRadius, endpoint_prop_icon_contact_body_128.baseRadius, endpoint_prop_icon_contact_body_128.length, 8, 4)
    : buildExtrudeGeometry({"points": [[-0.0315, -0.0315], [0.0315, -0.0315], [0.02677, -0.0063], [0.0, 0.00315], [-0.02677, -0.0063]], "depth": 0.0063});
  if (!endpoint_prop_icon_contact_body_128) {
    mesh_prop_icon_contact_body_128Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_prop_icon_contact_body_128 = new THREE.Mesh(
    mesh_prop_icon_contact_body_128Geometry,
    materialMap["emblem-white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_icon_contact_body_128.name = "Glyph prop-icon-contact body";
  if (endpoint_prop_icon_contact_body_128) {
    mesh_prop_icon_contact_body_128.position.copy(endpoint_prop_icon_contact_body_128.midpoint);
    mesh_prop_icon_contact_body_128.quaternion.copy(endpoint_prop_icon_contact_body_128.quaternion);
  }
  mesh_prop_icon_contact_body_128.castShadow = options.castShadow ?? true;
  mesh_prop_icon_contact_body_128.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_icon_contact_body_128.userData.sculptComponent = { id: "prop-icon-contact-body" };
  node_prop_icon_contact_body_128.add(mesh_prop_icon_contact_body_128);
  meshes["prop-icon-contact-body"] = mesh_prop_icon_contact_body_128;
  colliders["prop-icon-contact-body"] = {};
  destructionGroups["icons"] ??= [];
  destructionGroups["icons"].push(node_prop_icon_contact_body_128);

  const endpoint_prop_icon_card_129 = makeAttachmentEndpoint(null);
  const node_prop_icon_card_129 = new THREE.Group();
  node_prop_icon_card_129.name = "Icon tile prop-icon-card__pivot";
  node_prop_icon_card_129.scale.set(1, 1, 1);
  if (endpoint_prop_icon_card_129) {
    node_prop_icon_card_129.position.copy(endpoint_prop_icon_card_129.start);
    node_prop_icon_card_129.rotation.set(0.0, 0.4, 0.0);
  } else {
    node_prop_icon_card_129.position.set(-0.38425, 1.44882, 0.13228);
    node_prop_icon_card_129.rotation.set(0.0, 0.4, 0.0);
  }
  node_prop_icon_card_129.userData.sculptComponent = { id: "prop-icon-card" };
  node_prop_icon_card_129.userData.actionProfile = {};
  (nodes["root"] ?? root).add(node_prop_icon_card_129);
  nodes["prop-icon-card"] = node_prop_icon_card_129;
  const mesh_prop_icon_card_129Geometry = endpoint_prop_icon_card_129
    ? new THREE.CylinderGeometry(endpoint_prop_icon_card_129.endRadius, endpoint_prop_icon_card_129.baseRadius, endpoint_prop_icon_card_129.length, 8, 4)
    : buildExtrudeGeometry({"points": [[0.08189, 0.04586], [0.07915, 0.05965], [0.07134, 0.07134], [0.05965, 0.07915], [0.04586, 0.08189], [-0.04586, 0.08189], [-0.05965, 0.07915], [-0.07134, 0.07134], [-0.07915, 0.05965], [-0.08189, 0.04586], [-0.08189, -0.04586], [-0.07915, -0.05965], [-0.07134, -0.07134], [-0.05965, -0.07915], [-0.04586, -0.08189], [0.04586, -0.08189], [0.05965, -0.07915], [0.07134, -0.07134], [0.07915, -0.05965], [0.08189, -0.04586]], "depth": 0.00945});
  if (!endpoint_prop_icon_card_129) {
    mesh_prop_icon_card_129Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_prop_icon_card_129 = new THREE.Mesh(
    mesh_prop_icon_card_129Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_icon_card_129.name = "Icon tile prop-icon-card";
  if (endpoint_prop_icon_card_129) {
    mesh_prop_icon_card_129.position.copy(endpoint_prop_icon_card_129.midpoint);
    mesh_prop_icon_card_129.quaternion.copy(endpoint_prop_icon_card_129.quaternion);
  }
  mesh_prop_icon_card_129.castShadow = options.castShadow ?? true;
  mesh_prop_icon_card_129.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_icon_card_129.userData.sculptComponent = { id: "prop-icon-card" };
  node_prop_icon_card_129.add(mesh_prop_icon_card_129);
  meshes["prop-icon-card"] = mesh_prop_icon_card_129;
  colliders["prop-icon-card"] = {};
  destructionGroups["icons"] ??= [];
  destructionGroups["icons"].push(node_prop_icon_card_129);

  const endpoint_prop_icon_card_page_130 = makeAttachmentEndpoint(null);
  const node_prop_icon_card_page_130 = new THREE.Group();
  node_prop_icon_card_page_130.name = "Glyph prop-icon-card page__pivot";
  node_prop_icon_card_page_130.scale.set(1, 1, 1);
  if (endpoint_prop_icon_card_page_130) {
    node_prop_icon_card_page_130.position.copy(endpoint_prop_icon_card_page_130.start);
    node_prop_icon_card_page_130.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_icon_card_page_130.position.set(0.0, 0.0, 0.01008);
    node_prop_icon_card_page_130.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_icon_card_page_130.userData.sculptComponent = { id: "prop-icon-card-page" };
  node_prop_icon_card_page_130.userData.actionProfile = {};
  (nodes["prop-icon-card"] ?? root).add(node_prop_icon_card_page_130);
  nodes["prop-icon-card-page"] = node_prop_icon_card_page_130;
  const mesh_prop_icon_card_page_130Geometry = endpoint_prop_icon_card_page_130
    ? new THREE.CylinderGeometry(endpoint_prop_icon_card_page_130.endRadius, endpoint_prop_icon_card_page_130.baseRadius, endpoint_prop_icon_card_page_130.length, 8, 4)
    : buildExtrudeGeometry({"points": [[-0.02784, -0.03685], [0.02784, -0.03685], [0.02784, 0.03685], [-0.02784, 0.03685]], "depth": 0.0063, "holes": [[[-0.02129, -0.0303], [0.02129, -0.0303], [0.02129, 0.0303], [-0.02129, 0.0303]]]});
  if (!endpoint_prop_icon_card_page_130) {
    mesh_prop_icon_card_page_130Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_prop_icon_card_page_130 = new THREE.Mesh(
    mesh_prop_icon_card_page_130Geometry,
    materialMap["emblem-white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_icon_card_page_130.name = "Glyph prop-icon-card page";
  if (endpoint_prop_icon_card_page_130) {
    mesh_prop_icon_card_page_130.position.copy(endpoint_prop_icon_card_page_130.midpoint);
    mesh_prop_icon_card_page_130.quaternion.copy(endpoint_prop_icon_card_page_130.quaternion);
  }
  mesh_prop_icon_card_page_130.castShadow = options.castShadow ?? true;
  mesh_prop_icon_card_page_130.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_icon_card_page_130.userData.sculptComponent = { id: "prop-icon-card-page" };
  node_prop_icon_card_page_130.add(mesh_prop_icon_card_page_130);
  meshes["prop-icon-card-page"] = mesh_prop_icon_card_page_130;
  colliders["prop-icon-card-page"] = {};
  destructionGroups["icons"] ??= [];
  destructionGroups["icons"].push(node_prop_icon_card_page_130);

  const endpoint_prop_icon_mail_131 = makeAttachmentEndpoint(null);
  const node_prop_icon_mail_131 = new THREE.Group();
  node_prop_icon_mail_131.name = "Icon tile prop-icon-mail__pivot";
  node_prop_icon_mail_131.scale.set(1, 1, 1);
  if (endpoint_prop_icon_mail_131) {
    node_prop_icon_mail_131.position.copy(endpoint_prop_icon_mail_131.start);
    node_prop_icon_mail_131.rotation.set(0.0, -0.4, 0.0);
  } else {
    node_prop_icon_mail_131.position.set(0.54173, 1.46142, 0.10079);
    node_prop_icon_mail_131.rotation.set(0.0, -0.4, 0.0);
  }
  node_prop_icon_mail_131.userData.sculptComponent = { id: "prop-icon-mail" };
  node_prop_icon_mail_131.userData.actionProfile = {};
  (nodes["root"] ?? root).add(node_prop_icon_mail_131);
  nodes["prop-icon-mail"] = node_prop_icon_mail_131;
  const mesh_prop_icon_mail_131Geometry = endpoint_prop_icon_mail_131
    ? new THREE.CylinderGeometry(endpoint_prop_icon_mail_131.endRadius, endpoint_prop_icon_mail_131.baseRadius, endpoint_prop_icon_mail_131.length, 8, 4)
    : buildExtrudeGeometry({"points": [[0.07244, 0.04057], [0.07001, 0.05276], [0.06311, 0.06311], [0.05276, 0.07001], [0.04057, 0.07244], [-0.04057, 0.07244], [-0.05276, 0.07001], [-0.06311, 0.06311], [-0.07001, 0.05276], [-0.07244, 0.04057], [-0.07244, -0.04057], [-0.07001, -0.05276], [-0.06311, -0.06311], [-0.05276, -0.07001], [-0.04057, -0.07244], [0.04057, -0.07244], [0.05276, -0.07001], [0.06311, -0.06311], [0.07001, -0.05276], [0.07244, -0.04057]], "depth": 0.00945});
  if (!endpoint_prop_icon_mail_131) {
    mesh_prop_icon_mail_131Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_prop_icon_mail_131 = new THREE.Mesh(
    mesh_prop_icon_mail_131Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_icon_mail_131.name = "Icon tile prop-icon-mail";
  if (endpoint_prop_icon_mail_131) {
    mesh_prop_icon_mail_131.position.copy(endpoint_prop_icon_mail_131.midpoint);
    mesh_prop_icon_mail_131.quaternion.copy(endpoint_prop_icon_mail_131.quaternion);
  }
  mesh_prop_icon_mail_131.castShadow = options.castShadow ?? true;
  mesh_prop_icon_mail_131.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_icon_mail_131.userData.sculptComponent = { id: "prop-icon-mail" };
  node_prop_icon_mail_131.add(mesh_prop_icon_mail_131);
  meshes["prop-icon-mail"] = mesh_prop_icon_mail_131;
  colliders["prop-icon-mail"] = {};
  destructionGroups["icons"] ??= [];
  destructionGroups["icons"].push(node_prop_icon_mail_131);

  const endpoint_prop_icon_mail_env_132 = makeAttachmentEndpoint(null);
  const node_prop_icon_mail_env_132 = new THREE.Group();
  node_prop_icon_mail_env_132.name = "Glyph prop-icon-mail env__pivot";
  node_prop_icon_mail_env_132.scale.set(1, 1, 1);
  if (endpoint_prop_icon_mail_env_132) {
    node_prop_icon_mail_env_132.position.copy(endpoint_prop_icon_mail_env_132.start);
    node_prop_icon_mail_env_132.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_icon_mail_env_132.position.set(0.0, 0.0, 0.01008);
    node_prop_icon_mail_env_132.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_icon_mail_env_132.userData.sculptComponent = { id: "prop-icon-mail-env" };
  node_prop_icon_mail_env_132.userData.actionProfile = {};
  (nodes["prop-icon-mail"] ?? root).add(node_prop_icon_mail_env_132);
  nodes["prop-icon-mail-env"] = node_prop_icon_mail_env_132;
  const mesh_prop_icon_mail_env_132Geometry = endpoint_prop_icon_mail_env_132
    ? new THREE.CylinderGeometry(endpoint_prop_icon_mail_env_132.endRadius, endpoint_prop_icon_mail_env_132.baseRadius, endpoint_prop_icon_mail_env_132.length, 8, 4)
    : buildExtrudeGeometry({"points": [[-0.03622, -0.02318], [0.03622, -0.02318], [0.03622, 0.02318], [-0.03622, 0.02318]], "depth": 0.0063, "holes": [[[-0.03043, -0.01739], [0.03043, -0.01739], [0.03043, 0.01739], [-0.03043, 0.01739]]]});
  if (!endpoint_prop_icon_mail_env_132) {
    mesh_prop_icon_mail_env_132Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_prop_icon_mail_env_132 = new THREE.Mesh(
    mesh_prop_icon_mail_env_132Geometry,
    materialMap["emblem-white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_icon_mail_env_132.name = "Glyph prop-icon-mail env";
  if (endpoint_prop_icon_mail_env_132) {
    mesh_prop_icon_mail_env_132.position.copy(endpoint_prop_icon_mail_env_132.midpoint);
    mesh_prop_icon_mail_env_132.quaternion.copy(endpoint_prop_icon_mail_env_132.quaternion);
  }
  mesh_prop_icon_mail_env_132.castShadow = options.castShadow ?? true;
  mesh_prop_icon_mail_env_132.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_icon_mail_env_132.userData.sculptComponent = { id: "prop-icon-mail-env" };
  node_prop_icon_mail_env_132.add(mesh_prop_icon_mail_env_132);
  meshes["prop-icon-mail-env"] = mesh_prop_icon_mail_env_132;
  colliders["prop-icon-mail-env"] = {};
  destructionGroups["icons"] ??= [];
  destructionGroups["icons"].push(node_prop_icon_mail_env_132);

  const endpoint_prop_icon_mail_flap_133 = makeAttachmentEndpoint(null);
  const node_prop_icon_mail_flap_133 = new THREE.Group();
  node_prop_icon_mail_flap_133.name = "Glyph prop-icon-mail flap__pivot";
  node_prop_icon_mail_flap_133.scale.set(1, 1, 1);
  if (endpoint_prop_icon_mail_flap_133) {
    node_prop_icon_mail_flap_133.position.copy(endpoint_prop_icon_mail_flap_133.start);
    node_prop_icon_mail_flap_133.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_icon_mail_flap_133.position.set(0.0, 0.0, 0.01008);
    node_prop_icon_mail_flap_133.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_icon_mail_flap_133.userData.sculptComponent = { id: "prop-icon-mail-flap" };
  node_prop_icon_mail_flap_133.userData.actionProfile = {};
  (nodes["prop-icon-mail"] ?? root).add(node_prop_icon_mail_flap_133);
  nodes["prop-icon-mail-flap"] = node_prop_icon_mail_flap_133;
  const mesh_prop_icon_mail_flap_133Geometry = endpoint_prop_icon_mail_flap_133
    ? new THREE.CylinderGeometry(endpoint_prop_icon_mail_flap_133.endRadius, endpoint_prop_icon_mail_flap_133.baseRadius, endpoint_prop_icon_mail_flap_133.length, 8, 4)
    : buildExtrudeGeometry({"points": [[-0.03332, 0.02173], [0.03332, 0.02173], [0.0, -0.00435]], "depth": 0.0063});
  if (!endpoint_prop_icon_mail_flap_133) {
    mesh_prop_icon_mail_flap_133Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_prop_icon_mail_flap_133 = new THREE.Mesh(
    mesh_prop_icon_mail_flap_133Geometry,
    materialMap["emblem-white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_icon_mail_flap_133.name = "Glyph prop-icon-mail flap";
  if (endpoint_prop_icon_mail_flap_133) {
    mesh_prop_icon_mail_flap_133.position.copy(endpoint_prop_icon_mail_flap_133.midpoint);
    mesh_prop_icon_mail_flap_133.quaternion.copy(endpoint_prop_icon_mail_flap_133.quaternion);
  }
  mesh_prop_icon_mail_flap_133.castShadow = options.castShadow ?? true;
  mesh_prop_icon_mail_flap_133.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_icon_mail_flap_133.userData.sculptComponent = { id: "prop-icon-mail-flap" };
  node_prop_icon_mail_flap_133.add(mesh_prop_icon_mail_flap_133);
  meshes["prop-icon-mail-flap"] = mesh_prop_icon_mail_flap_133;
  colliders["prop-icon-mail-flap"] = {};
  destructionGroups["icons"] ??= [];
  destructionGroups["icons"].push(node_prop_icon_mail_flap_133);

  const endpoint_prop_icon_edge_134 = makeAttachmentEndpoint(null);
  const node_prop_icon_edge_134 = new THREE.Group();
  node_prop_icon_edge_134.name = "Icon tile prop-icon-edge__pivot";
  node_prop_icon_edge_134.scale.set(1, 1, 1);
  if (endpoint_prop_icon_edge_134) {
    node_prop_icon_edge_134.position.copy(endpoint_prop_icon_edge_134.start);
    node_prop_icon_edge_134.rotation.set(0.0, 0.3, 0.0);
  } else {
    node_prop_icon_edge_134.position.set(-0.28976, 0.90709, 0.13858);
    node_prop_icon_edge_134.rotation.set(0.0, 0.3, 0.0);
  }
  node_prop_icon_edge_134.userData.sculptComponent = { id: "prop-icon-edge" };
  node_prop_icon_edge_134.userData.actionProfile = {};
  (nodes["root"] ?? root).add(node_prop_icon_edge_134);
  nodes["prop-icon-edge"] = node_prop_icon_edge_134;
  const mesh_prop_icon_edge_134Geometry = endpoint_prop_icon_edge_134
    ? new THREE.CylinderGeometry(endpoint_prop_icon_edge_134.endRadius, endpoint_prop_icon_edge_134.baseRadius, endpoint_prop_icon_edge_134.length, 8, 4)
    : buildExtrudeGeometry({"points": [[0.07559, 0.04233], [0.07306, 0.05506], [0.06585, 0.06585], [0.05506, 0.07306], [0.04233, 0.07559], [-0.04233, 0.07559], [-0.05506, 0.07306], [-0.06585, 0.06585], [-0.07306, 0.05506], [-0.07559, 0.04233], [-0.07559, -0.04233], [-0.07306, -0.05506], [-0.06585, -0.06585], [-0.05506, -0.07306], [-0.04233, -0.07559], [0.04233, -0.07559], [0.05506, -0.07306], [0.06585, -0.06585], [0.07306, -0.05506], [0.07559, -0.04233]], "depth": 0.00945});
  if (!endpoint_prop_icon_edge_134) {
    mesh_prop_icon_edge_134Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_prop_icon_edge_134 = new THREE.Mesh(
    mesh_prop_icon_edge_134Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_icon_edge_134.name = "Icon tile prop-icon-edge";
  if (endpoint_prop_icon_edge_134) {
    mesh_prop_icon_edge_134.position.copy(endpoint_prop_icon_edge_134.midpoint);
    mesh_prop_icon_edge_134.quaternion.copy(endpoint_prop_icon_edge_134.quaternion);
  }
  mesh_prop_icon_edge_134.castShadow = options.castShadow ?? true;
  mesh_prop_icon_edge_134.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_icon_edge_134.userData.sculptComponent = { id: "prop-icon-edge" };
  node_prop_icon_edge_134.add(mesh_prop_icon_edge_134);
  meshes["prop-icon-edge"] = mesh_prop_icon_edge_134;
  colliders["prop-icon-edge"] = {};
  destructionGroups["icons"] ??= [];
  destructionGroups["icons"].push(node_prop_icon_edge_134);

  const endpoint_prop_icon_edge_g_135 = makeAttachmentEndpoint(null);
  const node_prop_icon_edge_g_135 = new THREE.Group();
  node_prop_icon_edge_g_135.name = "Glyph prop-icon-edge g__pivot";
  node_prop_icon_edge_g_135.scale.set(1, 1, 1);
  if (endpoint_prop_icon_edge_g_135) {
    node_prop_icon_edge_g_135.position.copy(endpoint_prop_icon_edge_g_135.start);
    node_prop_icon_edge_g_135.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_icon_edge_g_135.position.set(0.0, 0.0, 0.01008);
    node_prop_icon_edge_g_135.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_icon_edge_g_135.userData.sculptComponent = { id: "prop-icon-edge-g" };
  node_prop_icon_edge_g_135.userData.actionProfile = {};
  (nodes["prop-icon-edge"] ?? root).add(node_prop_icon_edge_g_135);
  nodes["prop-icon-edge-g"] = node_prop_icon_edge_g_135;
  const mesh_prop_icon_edge_g_135Geometry = endpoint_prop_icon_edge_g_135
    ? new THREE.CylinderGeometry(endpoint_prop_icon_edge_g_135.endRadius, endpoint_prop_icon_edge_g_135.baseRadius, endpoint_prop_icon_edge_g_135.length, 8, 4)
    : buildExtrudeGeometry({"points": [[0.02419, 0.0], [0.02933, 0.01215], [0.0171, 0.0171], [0.01215, 0.02933], [0.0, 0.02419], [-0.01215, 0.02933], [-0.0171, 0.0171], [-0.02933, 0.01215], [-0.02419, 0.0], [-0.02933, -0.01215], [-0.0171, -0.0171], [-0.01215, -0.02933], [-0.0, -0.02419], [0.01215, -0.02933], [0.0171, -0.0171], [0.02933, -0.01215]], "depth": 0.0063, "holes": [[[0.01058, 0.0], [0.00856, 0.00622], [0.00327, 0.01006], [-0.00327, 0.01006], [-0.00856, 0.00622], [-0.01058, 0.0], [-0.00856, -0.00622], [-0.00327, -0.01006], [0.00327, -0.01006], [0.00856, -0.00622]]]});
  if (!endpoint_prop_icon_edge_g_135) {
    mesh_prop_icon_edge_g_135Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_prop_icon_edge_g_135 = new THREE.Mesh(
    mesh_prop_icon_edge_g_135Geometry,
    materialMap["emblem-white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_icon_edge_g_135.name = "Glyph prop-icon-edge g";
  if (endpoint_prop_icon_edge_g_135) {
    mesh_prop_icon_edge_g_135.position.copy(endpoint_prop_icon_edge_g_135.midpoint);
    mesh_prop_icon_edge_g_135.quaternion.copy(endpoint_prop_icon_edge_g_135.quaternion);
  }
  mesh_prop_icon_edge_g_135.castShadow = options.castShadow ?? true;
  mesh_prop_icon_edge_g_135.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_icon_edge_g_135.userData.sculptComponent = { id: "prop-icon-edge-g" };
  node_prop_icon_edge_g_135.add(mesh_prop_icon_edge_g_135);
  meshes["prop-icon-edge-g"] = mesh_prop_icon_edge_g_135;
  colliders["prop-icon-edge-g"] = {};
  destructionGroups["icons"] ??= [];
  destructionGroups["icons"].push(node_prop_icon_edge_g_135);

  const endpoint_prop_icon_mail2_136 = makeAttachmentEndpoint(null);
  const node_prop_icon_mail2_136 = new THREE.Group();
  node_prop_icon_mail2_136.name = "Icon tile prop-icon-mail2__pivot";
  node_prop_icon_mail2_136.scale.set(1, 1, 1);
  if (endpoint_prop_icon_mail2_136) {
    node_prop_icon_mail2_136.position.copy(endpoint_prop_icon_mail2_136.start);
    node_prop_icon_mail2_136.rotation.set(0.0, -0.3, 0.0);
  } else {
    node_prop_icon_mail2_136.position.set(0.44724, 0.7685, 0.11339);
    node_prop_icon_mail2_136.rotation.set(0.0, -0.3, 0.0);
  }
  node_prop_icon_mail2_136.userData.sculptComponent = { id: "prop-icon-mail2" };
  node_prop_icon_mail2_136.userData.actionProfile = {};
  (nodes["root"] ?? root).add(node_prop_icon_mail2_136);
  nodes["prop-icon-mail2"] = node_prop_icon_mail2_136;
  const mesh_prop_icon_mail2_136Geometry = endpoint_prop_icon_mail2_136
    ? new THREE.CylinderGeometry(endpoint_prop_icon_mail2_136.endRadius, endpoint_prop_icon_mail2_136.baseRadius, endpoint_prop_icon_mail2_136.length, 8, 4)
    : buildExtrudeGeometry({"points": [[0.07244, 0.04057], [0.07001, 0.05276], [0.06311, 0.06311], [0.05276, 0.07001], [0.04057, 0.07244], [-0.04057, 0.07244], [-0.05276, 0.07001], [-0.06311, 0.06311], [-0.07001, 0.05276], [-0.07244, 0.04057], [-0.07244, -0.04057], [-0.07001, -0.05276], [-0.06311, -0.06311], [-0.05276, -0.07001], [-0.04057, -0.07244], [0.04057, -0.07244], [0.05276, -0.07001], [0.06311, -0.06311], [0.07001, -0.05276], [0.07244, -0.04057]], "depth": 0.00945});
  if (!endpoint_prop_icon_mail2_136) {
    mesh_prop_icon_mail2_136Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_prop_icon_mail2_136 = new THREE.Mesh(
    mesh_prop_icon_mail2_136Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_icon_mail2_136.name = "Icon tile prop-icon-mail2";
  if (endpoint_prop_icon_mail2_136) {
    mesh_prop_icon_mail2_136.position.copy(endpoint_prop_icon_mail2_136.midpoint);
    mesh_prop_icon_mail2_136.quaternion.copy(endpoint_prop_icon_mail2_136.quaternion);
  }
  mesh_prop_icon_mail2_136.castShadow = options.castShadow ?? true;
  mesh_prop_icon_mail2_136.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_icon_mail2_136.userData.sculptComponent = { id: "prop-icon-mail2" };
  node_prop_icon_mail2_136.add(mesh_prop_icon_mail2_136);
  meshes["prop-icon-mail2"] = mesh_prop_icon_mail2_136;
  colliders["prop-icon-mail2"] = {};
  destructionGroups["icons"] ??= [];
  destructionGroups["icons"].push(node_prop_icon_mail2_136);

  const endpoint_prop_icon_mail2_env_137 = makeAttachmentEndpoint(null);
  const node_prop_icon_mail2_env_137 = new THREE.Group();
  node_prop_icon_mail2_env_137.name = "Glyph prop-icon-mail2 env__pivot";
  node_prop_icon_mail2_env_137.scale.set(1, 1, 1);
  if (endpoint_prop_icon_mail2_env_137) {
    node_prop_icon_mail2_env_137.position.copy(endpoint_prop_icon_mail2_env_137.start);
    node_prop_icon_mail2_env_137.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_icon_mail2_env_137.position.set(0.0, 0.0, 0.01008);
    node_prop_icon_mail2_env_137.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_icon_mail2_env_137.userData.sculptComponent = { id: "prop-icon-mail2-env" };
  node_prop_icon_mail2_env_137.userData.actionProfile = {};
  (nodes["prop-icon-mail2"] ?? root).add(node_prop_icon_mail2_env_137);
  nodes["prop-icon-mail2-env"] = node_prop_icon_mail2_env_137;
  const mesh_prop_icon_mail2_env_137Geometry = endpoint_prop_icon_mail2_env_137
    ? new THREE.CylinderGeometry(endpoint_prop_icon_mail2_env_137.endRadius, endpoint_prop_icon_mail2_env_137.baseRadius, endpoint_prop_icon_mail2_env_137.length, 8, 4)
    : buildExtrudeGeometry({"points": [[-0.03622, -0.02318], [0.03622, -0.02318], [0.03622, 0.02318], [-0.03622, 0.02318]], "depth": 0.0063, "holes": [[[-0.03043, -0.01739], [0.03043, -0.01739], [0.03043, 0.01739], [-0.03043, 0.01739]]]});
  if (!endpoint_prop_icon_mail2_env_137) {
    mesh_prop_icon_mail2_env_137Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_prop_icon_mail2_env_137 = new THREE.Mesh(
    mesh_prop_icon_mail2_env_137Geometry,
    materialMap["emblem-white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_icon_mail2_env_137.name = "Glyph prop-icon-mail2 env";
  if (endpoint_prop_icon_mail2_env_137) {
    mesh_prop_icon_mail2_env_137.position.copy(endpoint_prop_icon_mail2_env_137.midpoint);
    mesh_prop_icon_mail2_env_137.quaternion.copy(endpoint_prop_icon_mail2_env_137.quaternion);
  }
  mesh_prop_icon_mail2_env_137.castShadow = options.castShadow ?? true;
  mesh_prop_icon_mail2_env_137.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_icon_mail2_env_137.userData.sculptComponent = { id: "prop-icon-mail2-env" };
  node_prop_icon_mail2_env_137.add(mesh_prop_icon_mail2_env_137);
  meshes["prop-icon-mail2-env"] = mesh_prop_icon_mail2_env_137;
  colliders["prop-icon-mail2-env"] = {};
  destructionGroups["icons"] ??= [];
  destructionGroups["icons"].push(node_prop_icon_mail2_env_137);

  const endpoint_prop_icon_mail2_flap_138 = makeAttachmentEndpoint(null);
  const node_prop_icon_mail2_flap_138 = new THREE.Group();
  node_prop_icon_mail2_flap_138.name = "Glyph prop-icon-mail2 flap__pivot";
  node_prop_icon_mail2_flap_138.scale.set(1, 1, 1);
  if (endpoint_prop_icon_mail2_flap_138) {
    node_prop_icon_mail2_flap_138.position.copy(endpoint_prop_icon_mail2_flap_138.start);
    node_prop_icon_mail2_flap_138.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_icon_mail2_flap_138.position.set(0.0, 0.0, 0.01008);
    node_prop_icon_mail2_flap_138.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_icon_mail2_flap_138.userData.sculptComponent = { id: "prop-icon-mail2-flap" };
  node_prop_icon_mail2_flap_138.userData.actionProfile = {};
  (nodes["prop-icon-mail2"] ?? root).add(node_prop_icon_mail2_flap_138);
  nodes["prop-icon-mail2-flap"] = node_prop_icon_mail2_flap_138;
  const mesh_prop_icon_mail2_flap_138Geometry = endpoint_prop_icon_mail2_flap_138
    ? new THREE.CylinderGeometry(endpoint_prop_icon_mail2_flap_138.endRadius, endpoint_prop_icon_mail2_flap_138.baseRadius, endpoint_prop_icon_mail2_flap_138.length, 8, 4)
    : buildExtrudeGeometry({"points": [[-0.03332, 0.02173], [0.03332, 0.02173], [0.0, -0.00435]], "depth": 0.0063});
  if (!endpoint_prop_icon_mail2_flap_138) {
    mesh_prop_icon_mail2_flap_138Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_prop_icon_mail2_flap_138 = new THREE.Mesh(
    mesh_prop_icon_mail2_flap_138Geometry,
    materialMap["emblem-white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_icon_mail2_flap_138.name = "Glyph prop-icon-mail2 flap";
  if (endpoint_prop_icon_mail2_flap_138) {
    mesh_prop_icon_mail2_flap_138.position.copy(endpoint_prop_icon_mail2_flap_138.midpoint);
    mesh_prop_icon_mail2_flap_138.quaternion.copy(endpoint_prop_icon_mail2_flap_138.quaternion);
  }
  mesh_prop_icon_mail2_flap_138.castShadow = options.castShadow ?? true;
  mesh_prop_icon_mail2_flap_138.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_icon_mail2_flap_138.userData.sculptComponent = { id: "prop-icon-mail2-flap" };
  node_prop_icon_mail2_flap_138.add(mesh_prop_icon_mail2_flap_138);
  meshes["prop-icon-mail2-flap"] = mesh_prop_icon_mail2_flap_138;
  colliders["prop-icon-mail2-flap"] = {};
  destructionGroups["icons"] ??= [];
  destructionGroups["icons"].push(node_prop_icon_mail2_flap_138);

  const endpoint_prop_icon_person_back_139 = makeAttachmentEndpoint(null);
  const node_prop_icon_person_back_139 = new THREE.Group();
  node_prop_icon_person_back_139.name = "Icon tile prop-icon-person-back__pivot";
  node_prop_icon_person_back_139.scale.set(1, 1, 1);
  if (endpoint_prop_icon_person_back_139) {
    node_prop_icon_person_back_139.position.copy(endpoint_prop_icon_person_back_139.start);
    node_prop_icon_person_back_139.rotation.set(0.0, 2.74159, 0.0);
  } else {
    node_prop_icon_person_back_139.position.set(0.35276, 1.39213, -0.28976);
    node_prop_icon_person_back_139.rotation.set(0.0, 2.74159, 0.0);
  }
  node_prop_icon_person_back_139.userData.sculptComponent = { id: "prop-icon-person-back" };
  node_prop_icon_person_back_139.userData.actionProfile = {};
  (nodes["root"] ?? root).add(node_prop_icon_person_back_139);
  nodes["prop-icon-person-back"] = node_prop_icon_person_back_139;
  const mesh_prop_icon_person_back_139Geometry = endpoint_prop_icon_person_back_139
    ? new THREE.CylinderGeometry(endpoint_prop_icon_person_back_139.endRadius, endpoint_prop_icon_person_back_139.baseRadius, endpoint_prop_icon_person_back_139.length, 8, 4)
    : buildExtrudeGeometry({"points": [[0.07559, 0.04233], [0.07306, 0.05506], [0.06585, 0.06585], [0.05506, 0.07306], [0.04233, 0.07559], [-0.04233, 0.07559], [-0.05506, 0.07306], [-0.06585, 0.06585], [-0.07306, 0.05506], [-0.07559, 0.04233], [-0.07559, -0.04233], [-0.07306, -0.05506], [-0.06585, -0.06585], [-0.05506, -0.07306], [-0.04233, -0.07559], [0.04233, -0.07559], [0.05506, -0.07306], [0.06585, -0.06585], [0.07306, -0.05506], [0.07559, -0.04233]], "depth": 0.00945});
  if (!endpoint_prop_icon_person_back_139) {
    mesh_prop_icon_person_back_139Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_prop_icon_person_back_139 = new THREE.Mesh(
    mesh_prop_icon_person_back_139Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_icon_person_back_139.name = "Icon tile prop-icon-person-back";
  if (endpoint_prop_icon_person_back_139) {
    mesh_prop_icon_person_back_139.position.copy(endpoint_prop_icon_person_back_139.midpoint);
    mesh_prop_icon_person_back_139.quaternion.copy(endpoint_prop_icon_person_back_139.quaternion);
  }
  mesh_prop_icon_person_back_139.castShadow = options.castShadow ?? true;
  mesh_prop_icon_person_back_139.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_icon_person_back_139.userData.sculptComponent = { id: "prop-icon-person-back" };
  node_prop_icon_person_back_139.add(mesh_prop_icon_person_back_139);
  meshes["prop-icon-person-back"] = mesh_prop_icon_person_back_139;
  colliders["prop-icon-person-back"] = {};
  destructionGroups["icons"] ??= [];
  destructionGroups["icons"].push(node_prop_icon_person_back_139);

  const endpoint_prop_icon_person_back_head_140 = makeAttachmentEndpoint(null);
  const node_prop_icon_person_back_head_140 = new THREE.Group();
  node_prop_icon_person_back_head_140.name = "Glyph prop-icon-person-back head__pivot";
  node_prop_icon_person_back_head_140.scale.set(1, 1, 1);
  if (endpoint_prop_icon_person_back_head_140) {
    node_prop_icon_person_back_head_140.position.copy(endpoint_prop_icon_person_back_head_140.start);
    node_prop_icon_person_back_head_140.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_icon_person_back_head_140.position.set(0.0, 0.0, 0.01008);
    node_prop_icon_person_back_head_140.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_icon_person_back_head_140.userData.sculptComponent = { id: "prop-icon-person-back-head" };
  node_prop_icon_person_back_head_140.userData.actionProfile = {};
  (nodes["prop-icon-person-back"] ?? root).add(node_prop_icon_person_back_head_140);
  nodes["prop-icon-person-back-head"] = node_prop_icon_person_back_head_140;
  const mesh_prop_icon_person_back_head_140Geometry = endpoint_prop_icon_person_back_head_140
    ? new THREE.CylinderGeometry(endpoint_prop_icon_person_back_head_140.endRadius, endpoint_prop_icon_person_back_head_140.baseRadius, endpoint_prop_icon_person_back_head_140.length, 8, 4)
    : buildExtrudeGeometry({"points": [[0.01285, 0.01512], [0.01158, 0.02069], [0.00801, 0.02516], [0.00286, 0.02765], [-0.00286, 0.02765], [-0.00801, 0.02516], [-0.01158, 0.02069], [-0.01285, 0.01512], [-0.01158, 0.00954], [-0.00801, 0.00507], [-0.00286, 0.00259], [0.00286, 0.00259], [0.00801, 0.00507], [0.01158, 0.00954]], "depth": 0.0063});
  if (!endpoint_prop_icon_person_back_head_140) {
    mesh_prop_icon_person_back_head_140Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_prop_icon_person_back_head_140 = new THREE.Mesh(
    mesh_prop_icon_person_back_head_140Geometry,
    materialMap["emblem-white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_icon_person_back_head_140.name = "Glyph prop-icon-person-back head";
  if (endpoint_prop_icon_person_back_head_140) {
    mesh_prop_icon_person_back_head_140.position.copy(endpoint_prop_icon_person_back_head_140.midpoint);
    mesh_prop_icon_person_back_head_140.quaternion.copy(endpoint_prop_icon_person_back_head_140.quaternion);
  }
  mesh_prop_icon_person_back_head_140.castShadow = options.castShadow ?? true;
  mesh_prop_icon_person_back_head_140.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_icon_person_back_head_140.userData.sculptComponent = { id: "prop-icon-person-back-head" };
  node_prop_icon_person_back_head_140.add(mesh_prop_icon_person_back_head_140);
  meshes["prop-icon-person-back-head"] = mesh_prop_icon_person_back_head_140;
  colliders["prop-icon-person-back-head"] = {};
  destructionGroups["icons"] ??= [];
  destructionGroups["icons"].push(node_prop_icon_person_back_head_140);

  const endpoint_prop_icon_person_back_body_141 = makeAttachmentEndpoint(null);
  const node_prop_icon_person_back_body_141 = new THREE.Group();
  node_prop_icon_person_back_body_141.name = "Glyph prop-icon-person-back body__pivot";
  node_prop_icon_person_back_body_141.scale.set(1, 1, 1);
  if (endpoint_prop_icon_person_back_body_141) {
    node_prop_icon_person_back_body_141.position.copy(endpoint_prop_icon_person_back_body_141.start);
    node_prop_icon_person_back_body_141.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_icon_person_back_body_141.position.set(0.0, 0.0, 0.01008);
    node_prop_icon_person_back_body_141.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_icon_person_back_body_141.userData.sculptComponent = { id: "prop-icon-person-back-body" };
  node_prop_icon_person_back_body_141.userData.actionProfile = {};
  (nodes["prop-icon-person-back"] ?? root).add(node_prop_icon_person_back_body_141);
  nodes["prop-icon-person-back-body"] = node_prop_icon_person_back_body_141;
  const mesh_prop_icon_person_back_body_141Geometry = endpoint_prop_icon_person_back_body_141
    ? new THREE.CylinderGeometry(endpoint_prop_icon_person_back_body_141.endRadius, endpoint_prop_icon_person_back_body_141.baseRadius, endpoint_prop_icon_person_back_body_141.length, 8, 4)
    : buildExtrudeGeometry({"points": [[-0.03024, -0.03024], [0.03024, -0.03024], [0.0257, -0.00605], [0.0, 0.00302], [-0.0257, -0.00605]], "depth": 0.0063});
  if (!endpoint_prop_icon_person_back_body_141) {
    mesh_prop_icon_person_back_body_141Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_prop_icon_person_back_body_141 = new THREE.Mesh(
    mesh_prop_icon_person_back_body_141Geometry,
    materialMap["emblem-white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_icon_person_back_body_141.name = "Glyph prop-icon-person-back body";
  if (endpoint_prop_icon_person_back_body_141) {
    mesh_prop_icon_person_back_body_141.position.copy(endpoint_prop_icon_person_back_body_141.midpoint);
    mesh_prop_icon_person_back_body_141.quaternion.copy(endpoint_prop_icon_person_back_body_141.quaternion);
  }
  mesh_prop_icon_person_back_body_141.castShadow = options.castShadow ?? true;
  mesh_prop_icon_person_back_body_141.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_icon_person_back_body_141.userData.sculptComponent = { id: "prop-icon-person-back-body" };
  node_prop_icon_person_back_body_141.add(mesh_prop_icon_person_back_body_141);
  meshes["prop-icon-person-back-body"] = mesh_prop_icon_person_back_body_141;
  colliders["prop-icon-person-back-body"] = {};
  destructionGroups["icons"] ??= [];
  destructionGroups["icons"].push(node_prop_icon_person_back_body_141);

  const endpoint_prop_panel_1_142 = makeAttachmentEndpoint(null);
  const node_prop_panel_1_142 = new THREE.Group();
  node_prop_panel_1_142.name = "Holo panel prop-panel-1__pivot";
  node_prop_panel_1_142.scale.set(1, 1, 1);
  if (endpoint_prop_panel_1_142) {
    node_prop_panel_1_142.position.copy(endpoint_prop_panel_1_142.start);
    node_prop_panel_1_142.rotation.set(0.0, -0.4, 0.0);
  } else {
    node_prop_panel_1_142.position.set(0.58583, 1.80788, 0.06929);
    node_prop_panel_1_142.rotation.set(0.0, -0.4, 0.0);
  }
  node_prop_panel_1_142.userData.sculptComponent = { id: "prop-panel-1" };
  node_prop_panel_1_142.userData.actionProfile = {};
  (nodes["root"] ?? root).add(node_prop_panel_1_142);
  nodes["prop-panel-1"] = node_prop_panel_1_142;
  const mesh_prop_panel_1_142Geometry = endpoint_prop_panel_1_142
    ? new THREE.CylinderGeometry(endpoint_prop_panel_1_142.endRadius, endpoint_prop_panel_1_142.baseRadius, endpoint_prop_panel_1_142.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_1_142) {
    mesh_prop_panel_1_142Geometry.scale(0.22677, 0.13228, 0.00504);
  }
  const mesh_prop_panel_1_142 = new THREE.Mesh(
    mesh_prop_panel_1_142Geometry,
    materialMap["holo-panel"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_1_142.name = "Holo panel prop-panel-1";
  if (endpoint_prop_panel_1_142) {
    mesh_prop_panel_1_142.position.copy(endpoint_prop_panel_1_142.midpoint);
    mesh_prop_panel_1_142.quaternion.copy(endpoint_prop_panel_1_142.quaternion);
  }
  mesh_prop_panel_1_142.castShadow = options.castShadow ?? true;
  mesh_prop_panel_1_142.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_1_142.userData.sculptComponent = { id: "prop-panel-1" };
  node_prop_panel_1_142.add(mesh_prop_panel_1_142);
  meshes["prop-panel-1"] = mesh_prop_panel_1_142;
  colliders["prop-panel-1"] = {};
  destructionGroups["icons"] ??= [];
  destructionGroups["icons"].push(node_prop_panel_1_142);

  const endpoint_prop_panel_1_edge0_143 = makeAttachmentEndpoint(null);
  const node_prop_panel_1_edge0_143 = new THREE.Group();
  node_prop_panel_1_edge0_143.name = "Panel edge prop-panel-1 0__pivot";
  node_prop_panel_1_edge0_143.scale.set(1, 1, 1);
  if (endpoint_prop_panel_1_edge0_143) {
    node_prop_panel_1_edge0_143.position.copy(endpoint_prop_panel_1_edge0_143.start);
    node_prop_panel_1_edge0_143.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_1_edge0_143.position.set(0.0, 0.06614, 0.0);
    node_prop_panel_1_edge0_143.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_1_edge0_143.userData.sculptComponent = { id: "prop-panel-1-edge0" };
  node_prop_panel_1_edge0_143.userData.actionProfile = {};
  (nodes["prop-panel-1"] ?? root).add(node_prop_panel_1_edge0_143);
  nodes["prop-panel-1-edge0"] = node_prop_panel_1_edge0_143;
  const mesh_prop_panel_1_edge0_143Geometry = endpoint_prop_panel_1_edge0_143
    ? new THREE.CylinderGeometry(endpoint_prop_panel_1_edge0_143.endRadius, endpoint_prop_panel_1_edge0_143.baseRadius, endpoint_prop_panel_1_edge0_143.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_1_edge0_143) {
    mesh_prop_panel_1_edge0_143Geometry.scale(0.22677, 0.00441, 0.00504);
  }
  const mesh_prop_panel_1_edge0_143 = new THREE.Mesh(
    mesh_prop_panel_1_edge0_143Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_1_edge0_143.name = "Panel edge prop-panel-1 0";
  if (endpoint_prop_panel_1_edge0_143) {
    mesh_prop_panel_1_edge0_143.position.copy(endpoint_prop_panel_1_edge0_143.midpoint);
    mesh_prop_panel_1_edge0_143.quaternion.copy(endpoint_prop_panel_1_edge0_143.quaternion);
  }
  mesh_prop_panel_1_edge0_143.castShadow = options.castShadow ?? true;
  mesh_prop_panel_1_edge0_143.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_1_edge0_143.userData.sculptComponent = { id: "prop-panel-1-edge0" };
  node_prop_panel_1_edge0_143.add(mesh_prop_panel_1_edge0_143);
  meshes["prop-panel-1-edge0"] = mesh_prop_panel_1_edge0_143;
  colliders["prop-panel-1-edge0"] = {};
  destructionGroups["icons"] ??= [];
  destructionGroups["icons"].push(node_prop_panel_1_edge0_143);

  const endpoint_prop_panel_1_edge1_144 = makeAttachmentEndpoint(null);
  const node_prop_panel_1_edge1_144 = new THREE.Group();
  node_prop_panel_1_edge1_144.name = "Panel edge prop-panel-1 1__pivot";
  node_prop_panel_1_edge1_144.scale.set(1, 1, 1);
  if (endpoint_prop_panel_1_edge1_144) {
    node_prop_panel_1_edge1_144.position.copy(endpoint_prop_panel_1_edge1_144.start);
    node_prop_panel_1_edge1_144.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_1_edge1_144.position.set(0.0, -0.06614, 0.0);
    node_prop_panel_1_edge1_144.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_1_edge1_144.userData.sculptComponent = { id: "prop-panel-1-edge1" };
  node_prop_panel_1_edge1_144.userData.actionProfile = {};
  (nodes["prop-panel-1"] ?? root).add(node_prop_panel_1_edge1_144);
  nodes["prop-panel-1-edge1"] = node_prop_panel_1_edge1_144;
  const mesh_prop_panel_1_edge1_144Geometry = endpoint_prop_panel_1_edge1_144
    ? new THREE.CylinderGeometry(endpoint_prop_panel_1_edge1_144.endRadius, endpoint_prop_panel_1_edge1_144.baseRadius, endpoint_prop_panel_1_edge1_144.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_1_edge1_144) {
    mesh_prop_panel_1_edge1_144Geometry.scale(0.22677, 0.00441, 0.00504);
  }
  const mesh_prop_panel_1_edge1_144 = new THREE.Mesh(
    mesh_prop_panel_1_edge1_144Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_1_edge1_144.name = "Panel edge prop-panel-1 1";
  if (endpoint_prop_panel_1_edge1_144) {
    mesh_prop_panel_1_edge1_144.position.copy(endpoint_prop_panel_1_edge1_144.midpoint);
    mesh_prop_panel_1_edge1_144.quaternion.copy(endpoint_prop_panel_1_edge1_144.quaternion);
  }
  mesh_prop_panel_1_edge1_144.castShadow = options.castShadow ?? true;
  mesh_prop_panel_1_edge1_144.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_1_edge1_144.userData.sculptComponent = { id: "prop-panel-1-edge1" };
  node_prop_panel_1_edge1_144.add(mesh_prop_panel_1_edge1_144);
  meshes["prop-panel-1-edge1"] = mesh_prop_panel_1_edge1_144;
  colliders["prop-panel-1-edge1"] = {};
  destructionGroups["icons"] ??= [];
  destructionGroups["icons"].push(node_prop_panel_1_edge1_144);

  const endpoint_prop_panel_1_edge2_145 = makeAttachmentEndpoint(null);
  const node_prop_panel_1_edge2_145 = new THREE.Group();
  node_prop_panel_1_edge2_145.name = "Panel edge prop-panel-1 2__pivot";
  node_prop_panel_1_edge2_145.scale.set(1, 1, 1);
  if (endpoint_prop_panel_1_edge2_145) {
    node_prop_panel_1_edge2_145.position.copy(endpoint_prop_panel_1_edge2_145.start);
    node_prop_panel_1_edge2_145.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_1_edge2_145.position.set(-0.11339, 0.0, 0.0);
    node_prop_panel_1_edge2_145.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_1_edge2_145.userData.sculptComponent = { id: "prop-panel-1-edge2" };
  node_prop_panel_1_edge2_145.userData.actionProfile = {};
  (nodes["prop-panel-1"] ?? root).add(node_prop_panel_1_edge2_145);
  nodes["prop-panel-1-edge2"] = node_prop_panel_1_edge2_145;
  const mesh_prop_panel_1_edge2_145Geometry = endpoint_prop_panel_1_edge2_145
    ? new THREE.CylinderGeometry(endpoint_prop_panel_1_edge2_145.endRadius, endpoint_prop_panel_1_edge2_145.baseRadius, endpoint_prop_panel_1_edge2_145.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_1_edge2_145) {
    mesh_prop_panel_1_edge2_145Geometry.scale(0.00441, 0.13228, 0.00504);
  }
  const mesh_prop_panel_1_edge2_145 = new THREE.Mesh(
    mesh_prop_panel_1_edge2_145Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_1_edge2_145.name = "Panel edge prop-panel-1 2";
  if (endpoint_prop_panel_1_edge2_145) {
    mesh_prop_panel_1_edge2_145.position.copy(endpoint_prop_panel_1_edge2_145.midpoint);
    mesh_prop_panel_1_edge2_145.quaternion.copy(endpoint_prop_panel_1_edge2_145.quaternion);
  }
  mesh_prop_panel_1_edge2_145.castShadow = options.castShadow ?? true;
  mesh_prop_panel_1_edge2_145.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_1_edge2_145.userData.sculptComponent = { id: "prop-panel-1-edge2" };
  node_prop_panel_1_edge2_145.add(mesh_prop_panel_1_edge2_145);
  meshes["prop-panel-1-edge2"] = mesh_prop_panel_1_edge2_145;
  colliders["prop-panel-1-edge2"] = {};
  destructionGroups["icons"] ??= [];
  destructionGroups["icons"].push(node_prop_panel_1_edge2_145);

  const endpoint_prop_panel_1_edge3_146 = makeAttachmentEndpoint(null);
  const node_prop_panel_1_edge3_146 = new THREE.Group();
  node_prop_panel_1_edge3_146.name = "Panel edge prop-panel-1 3__pivot";
  node_prop_panel_1_edge3_146.scale.set(1, 1, 1);
  if (endpoint_prop_panel_1_edge3_146) {
    node_prop_panel_1_edge3_146.position.copy(endpoint_prop_panel_1_edge3_146.start);
    node_prop_panel_1_edge3_146.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_1_edge3_146.position.set(0.11339, 0.0, 0.0);
    node_prop_panel_1_edge3_146.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_1_edge3_146.userData.sculptComponent = { id: "prop-panel-1-edge3" };
  node_prop_panel_1_edge3_146.userData.actionProfile = {};
  (nodes["prop-panel-1"] ?? root).add(node_prop_panel_1_edge3_146);
  nodes["prop-panel-1-edge3"] = node_prop_panel_1_edge3_146;
  const mesh_prop_panel_1_edge3_146Geometry = endpoint_prop_panel_1_edge3_146
    ? new THREE.CylinderGeometry(endpoint_prop_panel_1_edge3_146.endRadius, endpoint_prop_panel_1_edge3_146.baseRadius, endpoint_prop_panel_1_edge3_146.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_1_edge3_146) {
    mesh_prop_panel_1_edge3_146Geometry.scale(0.00441, 0.13228, 0.00504);
  }
  const mesh_prop_panel_1_edge3_146 = new THREE.Mesh(
    mesh_prop_panel_1_edge3_146Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_1_edge3_146.name = "Panel edge prop-panel-1 3";
  if (endpoint_prop_panel_1_edge3_146) {
    mesh_prop_panel_1_edge3_146.position.copy(endpoint_prop_panel_1_edge3_146.midpoint);
    mesh_prop_panel_1_edge3_146.quaternion.copy(endpoint_prop_panel_1_edge3_146.quaternion);
  }
  mesh_prop_panel_1_edge3_146.castShadow = options.castShadow ?? true;
  mesh_prop_panel_1_edge3_146.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_1_edge3_146.userData.sculptComponent = { id: "prop-panel-1-edge3" };
  node_prop_panel_1_edge3_146.add(mesh_prop_panel_1_edge3_146);
  meshes["prop-panel-1-edge3"] = mesh_prop_panel_1_edge3_146;
  colliders["prop-panel-1-edge3"] = {};
  destructionGroups["icons"] ??= [];
  destructionGroups["icons"].push(node_prop_panel_1_edge3_146);

  const endpoint_prop_panel_1_dot_147 = makeAttachmentEndpoint(null);
  const node_prop_panel_1_dot_147 = new THREE.Group();
  node_prop_panel_1_dot_147.name = "Panel dot prop-panel-1__pivot";
  node_prop_panel_1_dot_147.scale.set(1, 1, 1);
  if (endpoint_prop_panel_1_dot_147) {
    node_prop_panel_1_dot_147.position.copy(endpoint_prop_panel_1_dot_147.start);
    node_prop_panel_1_dot_147.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_1_dot_147.position.set(0.0, 0.0, 0.00378);
    node_prop_panel_1_dot_147.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_1_dot_147.userData.sculptComponent = { id: "prop-panel-1-dot" };
  node_prop_panel_1_dot_147.userData.actionProfile = {};
  (nodes["prop-panel-1"] ?? root).add(node_prop_panel_1_dot_147);
  nodes["prop-panel-1-dot"] = node_prop_panel_1_dot_147;
  const mesh_prop_panel_1_dot_147Geometry = endpoint_prop_panel_1_dot_147
    ? new THREE.CylinderGeometry(endpoint_prop_panel_1_dot_147.endRadius, endpoint_prop_panel_1_dot_147.baseRadius, endpoint_prop_panel_1_dot_147.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_prop_panel_1_dot_147) {
    mesh_prop_panel_1_dot_147Geometry.scale(0.02117, 0.02117, 0.02117);
  }
  const mesh_prop_panel_1_dot_147 = new THREE.Mesh(
    mesh_prop_panel_1_dot_147Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_1_dot_147.name = "Panel dot prop-panel-1";
  if (endpoint_prop_panel_1_dot_147) {
    mesh_prop_panel_1_dot_147.position.copy(endpoint_prop_panel_1_dot_147.midpoint);
    mesh_prop_panel_1_dot_147.quaternion.copy(endpoint_prop_panel_1_dot_147.quaternion);
  }
  mesh_prop_panel_1_dot_147.castShadow = options.castShadow ?? true;
  mesh_prop_panel_1_dot_147.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_1_dot_147.userData.sculptComponent = { id: "prop-panel-1-dot" };
  node_prop_panel_1_dot_147.add(mesh_prop_panel_1_dot_147);
  meshes["prop-panel-1-dot"] = mesh_prop_panel_1_dot_147;
  colliders["prop-panel-1-dot"] = {};
  destructionGroups["icons"] ??= [];
  destructionGroups["icons"].push(node_prop_panel_1_dot_147);

  const endpoint_prop_panel_2_148 = makeAttachmentEndpoint(null);
  const node_prop_panel_2_148 = new THREE.Group();
  node_prop_panel_2_148.name = "Holo panel prop-panel-2__pivot";
  node_prop_panel_2_148.scale.set(1, 1, 1);
  if (endpoint_prop_panel_2_148) {
    node_prop_panel_2_148.position.copy(endpoint_prop_panel_2_148.start);
    node_prop_panel_2_148.rotation.set(0.0, -0.5, 0.0);
  } else {
    node_prop_panel_2_148.position.set(0.61732, 1.56221, 0.10079);
    node_prop_panel_2_148.rotation.set(0.0, -0.5, 0.0);
  }
  node_prop_panel_2_148.userData.sculptComponent = { id: "prop-panel-2" };
  node_prop_panel_2_148.userData.actionProfile = {};
  (nodes["root"] ?? root).add(node_prop_panel_2_148);
  nodes["prop-panel-2"] = node_prop_panel_2_148;
  const mesh_prop_panel_2_148Geometry = endpoint_prop_panel_2_148
    ? new THREE.CylinderGeometry(endpoint_prop_panel_2_148.endRadius, endpoint_prop_panel_2_148.baseRadius, endpoint_prop_panel_2_148.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_2_148) {
    mesh_prop_panel_2_148Geometry.scale(0.20787, 0.25827, 0.00504);
  }
  const mesh_prop_panel_2_148 = new THREE.Mesh(
    mesh_prop_panel_2_148Geometry,
    materialMap["holo-panel"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_2_148.name = "Holo panel prop-panel-2";
  if (endpoint_prop_panel_2_148) {
    mesh_prop_panel_2_148.position.copy(endpoint_prop_panel_2_148.midpoint);
    mesh_prop_panel_2_148.quaternion.copy(endpoint_prop_panel_2_148.quaternion);
  }
  mesh_prop_panel_2_148.castShadow = options.castShadow ?? true;
  mesh_prop_panel_2_148.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_2_148.userData.sculptComponent = { id: "prop-panel-2" };
  node_prop_panel_2_148.add(mesh_prop_panel_2_148);
  meshes["prop-panel-2"] = mesh_prop_panel_2_148;
  colliders["prop-panel-2"] = {};
  destructionGroups["icons"] ??= [];
  destructionGroups["icons"].push(node_prop_panel_2_148);

  const endpoint_prop_panel_2_edge0_149 = makeAttachmentEndpoint(null);
  const node_prop_panel_2_edge0_149 = new THREE.Group();
  node_prop_panel_2_edge0_149.name = "Panel edge prop-panel-2 0__pivot";
  node_prop_panel_2_edge0_149.scale.set(1, 1, 1);
  if (endpoint_prop_panel_2_edge0_149) {
    node_prop_panel_2_edge0_149.position.copy(endpoint_prop_panel_2_edge0_149.start);
    node_prop_panel_2_edge0_149.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_2_edge0_149.position.set(0.0, 0.12913, 0.0);
    node_prop_panel_2_edge0_149.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_2_edge0_149.userData.sculptComponent = { id: "prop-panel-2-edge0" };
  node_prop_panel_2_edge0_149.userData.actionProfile = {};
  (nodes["prop-panel-2"] ?? root).add(node_prop_panel_2_edge0_149);
  nodes["prop-panel-2-edge0"] = node_prop_panel_2_edge0_149;
  const mesh_prop_panel_2_edge0_149Geometry = endpoint_prop_panel_2_edge0_149
    ? new THREE.CylinderGeometry(endpoint_prop_panel_2_edge0_149.endRadius, endpoint_prop_panel_2_edge0_149.baseRadius, endpoint_prop_panel_2_edge0_149.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_2_edge0_149) {
    mesh_prop_panel_2_edge0_149Geometry.scale(0.20787, 0.00441, 0.00504);
  }
  const mesh_prop_panel_2_edge0_149 = new THREE.Mesh(
    mesh_prop_panel_2_edge0_149Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_2_edge0_149.name = "Panel edge prop-panel-2 0";
  if (endpoint_prop_panel_2_edge0_149) {
    mesh_prop_panel_2_edge0_149.position.copy(endpoint_prop_panel_2_edge0_149.midpoint);
    mesh_prop_panel_2_edge0_149.quaternion.copy(endpoint_prop_panel_2_edge0_149.quaternion);
  }
  mesh_prop_panel_2_edge0_149.castShadow = options.castShadow ?? true;
  mesh_prop_panel_2_edge0_149.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_2_edge0_149.userData.sculptComponent = { id: "prop-panel-2-edge0" };
  node_prop_panel_2_edge0_149.add(mesh_prop_panel_2_edge0_149);
  meshes["prop-panel-2-edge0"] = mesh_prop_panel_2_edge0_149;
  colliders["prop-panel-2-edge0"] = {};
  destructionGroups["icons"] ??= [];
  destructionGroups["icons"].push(node_prop_panel_2_edge0_149);

  const endpoint_prop_panel_2_edge1_150 = makeAttachmentEndpoint(null);
  const node_prop_panel_2_edge1_150 = new THREE.Group();
  node_prop_panel_2_edge1_150.name = "Panel edge prop-panel-2 1__pivot";
  node_prop_panel_2_edge1_150.scale.set(1, 1, 1);
  if (endpoint_prop_panel_2_edge1_150) {
    node_prop_panel_2_edge1_150.position.copy(endpoint_prop_panel_2_edge1_150.start);
    node_prop_panel_2_edge1_150.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_2_edge1_150.position.set(0.0, -0.12913, 0.0);
    node_prop_panel_2_edge1_150.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_2_edge1_150.userData.sculptComponent = { id: "prop-panel-2-edge1" };
  node_prop_panel_2_edge1_150.userData.actionProfile = {};
  (nodes["prop-panel-2"] ?? root).add(node_prop_panel_2_edge1_150);
  nodes["prop-panel-2-edge1"] = node_prop_panel_2_edge1_150;
  const mesh_prop_panel_2_edge1_150Geometry = endpoint_prop_panel_2_edge1_150
    ? new THREE.CylinderGeometry(endpoint_prop_panel_2_edge1_150.endRadius, endpoint_prop_panel_2_edge1_150.baseRadius, endpoint_prop_panel_2_edge1_150.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_2_edge1_150) {
    mesh_prop_panel_2_edge1_150Geometry.scale(0.20787, 0.00441, 0.00504);
  }
  const mesh_prop_panel_2_edge1_150 = new THREE.Mesh(
    mesh_prop_panel_2_edge1_150Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_2_edge1_150.name = "Panel edge prop-panel-2 1";
  if (endpoint_prop_panel_2_edge1_150) {
    mesh_prop_panel_2_edge1_150.position.copy(endpoint_prop_panel_2_edge1_150.midpoint);
    mesh_prop_panel_2_edge1_150.quaternion.copy(endpoint_prop_panel_2_edge1_150.quaternion);
  }
  mesh_prop_panel_2_edge1_150.castShadow = options.castShadow ?? true;
  mesh_prop_panel_2_edge1_150.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_2_edge1_150.userData.sculptComponent = { id: "prop-panel-2-edge1" };
  node_prop_panel_2_edge1_150.add(mesh_prop_panel_2_edge1_150);
  meshes["prop-panel-2-edge1"] = mesh_prop_panel_2_edge1_150;
  colliders["prop-panel-2-edge1"] = {};
  destructionGroups["icons"] ??= [];
  destructionGroups["icons"].push(node_prop_panel_2_edge1_150);

  const endpoint_prop_panel_2_edge2_151 = makeAttachmentEndpoint(null);
  const node_prop_panel_2_edge2_151 = new THREE.Group();
  node_prop_panel_2_edge2_151.name = "Panel edge prop-panel-2 2__pivot";
  node_prop_panel_2_edge2_151.scale.set(1, 1, 1);
  if (endpoint_prop_panel_2_edge2_151) {
    node_prop_panel_2_edge2_151.position.copy(endpoint_prop_panel_2_edge2_151.start);
    node_prop_panel_2_edge2_151.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_2_edge2_151.position.set(-0.10394, 0.0, 0.0);
    node_prop_panel_2_edge2_151.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_2_edge2_151.userData.sculptComponent = { id: "prop-panel-2-edge2" };
  node_prop_panel_2_edge2_151.userData.actionProfile = {};
  (nodes["prop-panel-2"] ?? root).add(node_prop_panel_2_edge2_151);
  nodes["prop-panel-2-edge2"] = node_prop_panel_2_edge2_151;
  const mesh_prop_panel_2_edge2_151Geometry = endpoint_prop_panel_2_edge2_151
    ? new THREE.CylinderGeometry(endpoint_prop_panel_2_edge2_151.endRadius, endpoint_prop_panel_2_edge2_151.baseRadius, endpoint_prop_panel_2_edge2_151.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_2_edge2_151) {
    mesh_prop_panel_2_edge2_151Geometry.scale(0.00441, 0.25827, 0.00504);
  }
  const mesh_prop_panel_2_edge2_151 = new THREE.Mesh(
    mesh_prop_panel_2_edge2_151Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_2_edge2_151.name = "Panel edge prop-panel-2 2";
  if (endpoint_prop_panel_2_edge2_151) {
    mesh_prop_panel_2_edge2_151.position.copy(endpoint_prop_panel_2_edge2_151.midpoint);
    mesh_prop_panel_2_edge2_151.quaternion.copy(endpoint_prop_panel_2_edge2_151.quaternion);
  }
  mesh_prop_panel_2_edge2_151.castShadow = options.castShadow ?? true;
  mesh_prop_panel_2_edge2_151.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_2_edge2_151.userData.sculptComponent = { id: "prop-panel-2-edge2" };
  node_prop_panel_2_edge2_151.add(mesh_prop_panel_2_edge2_151);
  meshes["prop-panel-2-edge2"] = mesh_prop_panel_2_edge2_151;
  colliders["prop-panel-2-edge2"] = {};
  destructionGroups["icons"] ??= [];
  destructionGroups["icons"].push(node_prop_panel_2_edge2_151);

  const endpoint_prop_panel_2_edge3_152 = makeAttachmentEndpoint(null);
  const node_prop_panel_2_edge3_152 = new THREE.Group();
  node_prop_panel_2_edge3_152.name = "Panel edge prop-panel-2 3__pivot";
  node_prop_panel_2_edge3_152.scale.set(1, 1, 1);
  if (endpoint_prop_panel_2_edge3_152) {
    node_prop_panel_2_edge3_152.position.copy(endpoint_prop_panel_2_edge3_152.start);
    node_prop_panel_2_edge3_152.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_2_edge3_152.position.set(0.10394, 0.0, 0.0);
    node_prop_panel_2_edge3_152.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_2_edge3_152.userData.sculptComponent = { id: "prop-panel-2-edge3" };
  node_prop_panel_2_edge3_152.userData.actionProfile = {};
  (nodes["prop-panel-2"] ?? root).add(node_prop_panel_2_edge3_152);
  nodes["prop-panel-2-edge3"] = node_prop_panel_2_edge3_152;
  const mesh_prop_panel_2_edge3_152Geometry = endpoint_prop_panel_2_edge3_152
    ? new THREE.CylinderGeometry(endpoint_prop_panel_2_edge3_152.endRadius, endpoint_prop_panel_2_edge3_152.baseRadius, endpoint_prop_panel_2_edge3_152.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_2_edge3_152) {
    mesh_prop_panel_2_edge3_152Geometry.scale(0.00441, 0.25827, 0.00504);
  }
  const mesh_prop_panel_2_edge3_152 = new THREE.Mesh(
    mesh_prop_panel_2_edge3_152Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_2_edge3_152.name = "Panel edge prop-panel-2 3";
  if (endpoint_prop_panel_2_edge3_152) {
    mesh_prop_panel_2_edge3_152.position.copy(endpoint_prop_panel_2_edge3_152.midpoint);
    mesh_prop_panel_2_edge3_152.quaternion.copy(endpoint_prop_panel_2_edge3_152.quaternion);
  }
  mesh_prop_panel_2_edge3_152.castShadow = options.castShadow ?? true;
  mesh_prop_panel_2_edge3_152.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_2_edge3_152.userData.sculptComponent = { id: "prop-panel-2-edge3" };
  node_prop_panel_2_edge3_152.add(mesh_prop_panel_2_edge3_152);
  meshes["prop-panel-2-edge3"] = mesh_prop_panel_2_edge3_152;
  colliders["prop-panel-2-edge3"] = {};
  destructionGroups["icons"] ??= [];
  destructionGroups["icons"].push(node_prop_panel_2_edge3_152);

  const endpoint_prop_panel_2_line0_153 = makeAttachmentEndpoint(null);
  const node_prop_panel_2_line0_153 = new THREE.Group();
  node_prop_panel_2_line0_153.name = "Text line prop-panel-2 0__pivot";
  node_prop_panel_2_line0_153.scale.set(1, 1, 1);
  if (endpoint_prop_panel_2_line0_153) {
    node_prop_panel_2_line0_153.position.copy(endpoint_prop_panel_2_line0_153.start);
    node_prop_panel_2_line0_153.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_2_line0_153.position.set(-0.02598, 0.07748, 0.00378);
    node_prop_panel_2_line0_153.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_2_line0_153.userData.sculptComponent = { id: "prop-panel-2-line0" };
  node_prop_panel_2_line0_153.userData.actionProfile = {};
  (nodes["prop-panel-2"] ?? root).add(node_prop_panel_2_line0_153);
  nodes["prop-panel-2-line0"] = node_prop_panel_2_line0_153;
  const mesh_prop_panel_2_line0_153Geometry = endpoint_prop_panel_2_line0_153
    ? new THREE.CylinderGeometry(endpoint_prop_panel_2_line0_153.endRadius, endpoint_prop_panel_2_line0_153.baseRadius, endpoint_prop_panel_2_line0_153.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_2_line0_153) {
    mesh_prop_panel_2_line0_153Geometry.scale(0.11433, 0.00378, 0.00504);
  }
  const mesh_prop_panel_2_line0_153 = new THREE.Mesh(
    mesh_prop_panel_2_line0_153Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_2_line0_153.name = "Text line prop-panel-2 0";
  if (endpoint_prop_panel_2_line0_153) {
    mesh_prop_panel_2_line0_153.position.copy(endpoint_prop_panel_2_line0_153.midpoint);
    mesh_prop_panel_2_line0_153.quaternion.copy(endpoint_prop_panel_2_line0_153.quaternion);
  }
  mesh_prop_panel_2_line0_153.castShadow = options.castShadow ?? true;
  mesh_prop_panel_2_line0_153.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_2_line0_153.userData.sculptComponent = { id: "prop-panel-2-line0" };
  node_prop_panel_2_line0_153.add(mesh_prop_panel_2_line0_153);
  meshes["prop-panel-2-line0"] = mesh_prop_panel_2_line0_153;
  colliders["prop-panel-2-line0"] = {};
  destructionGroups["icons"] ??= [];
  destructionGroups["icons"].push(node_prop_panel_2_line0_153);

  const endpoint_prop_panel_2_line1_154 = makeAttachmentEndpoint(null);
  const node_prop_panel_2_line1_154 = new THREE.Group();
  node_prop_panel_2_line1_154.name = "Text line prop-panel-2 1__pivot";
  node_prop_panel_2_line1_154.scale.set(1, 1, 1);
  if (endpoint_prop_panel_2_line1_154) {
    node_prop_panel_2_line1_154.position.copy(endpoint_prop_panel_2_line1_154.start);
    node_prop_panel_2_line1_154.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_2_line1_154.position.set(-0.0343, 0.04649, 0.00378);
    node_prop_panel_2_line1_154.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_2_line1_154.userData.sculptComponent = { id: "prop-panel-2-line1" };
  node_prop_panel_2_line1_154.userData.actionProfile = {};
  (nodes["prop-panel-2"] ?? root).add(node_prop_panel_2_line1_154);
  nodes["prop-panel-2-line1"] = node_prop_panel_2_line1_154;
  const mesh_prop_panel_2_line1_154Geometry = endpoint_prop_panel_2_line1_154
    ? new THREE.CylinderGeometry(endpoint_prop_panel_2_line1_154.endRadius, endpoint_prop_panel_2_line1_154.baseRadius, endpoint_prop_panel_2_line1_154.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_2_line1_154) {
    mesh_prop_panel_2_line1_154Geometry.scale(0.0977, 0.00378, 0.00504);
  }
  const mesh_prop_panel_2_line1_154 = new THREE.Mesh(
    mesh_prop_panel_2_line1_154Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_2_line1_154.name = "Text line prop-panel-2 1";
  if (endpoint_prop_panel_2_line1_154) {
    mesh_prop_panel_2_line1_154.position.copy(endpoint_prop_panel_2_line1_154.midpoint);
    mesh_prop_panel_2_line1_154.quaternion.copy(endpoint_prop_panel_2_line1_154.quaternion);
  }
  mesh_prop_panel_2_line1_154.castShadow = options.castShadow ?? true;
  mesh_prop_panel_2_line1_154.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_2_line1_154.userData.sculptComponent = { id: "prop-panel-2-line1" };
  node_prop_panel_2_line1_154.add(mesh_prop_panel_2_line1_154);
  meshes["prop-panel-2-line1"] = mesh_prop_panel_2_line1_154;
  colliders["prop-panel-2-line1"] = {};
  destructionGroups["icons"] ??= [];
  destructionGroups["icons"].push(node_prop_panel_2_line1_154);

  const endpoint_prop_panel_2_line2_155 = makeAttachmentEndpoint(null);
  const node_prop_panel_2_line2_155 = new THREE.Group();
  node_prop_panel_2_line2_155.name = "Text line prop-panel-2 2__pivot";
  node_prop_panel_2_line2_155.scale.set(1, 1, 1);
  if (endpoint_prop_panel_2_line2_155) {
    node_prop_panel_2_line2_155.position.copy(endpoint_prop_panel_2_line2_155.start);
    node_prop_panel_2_line2_155.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_2_line2_155.position.set(-0.04261, 0.0155, 0.00378);
    node_prop_panel_2_line2_155.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_2_line2_155.userData.sculptComponent = { id: "prop-panel-2-line2" };
  node_prop_panel_2_line2_155.userData.actionProfile = {};
  (nodes["prop-panel-2"] ?? root).add(node_prop_panel_2_line2_155);
  nodes["prop-panel-2-line2"] = node_prop_panel_2_line2_155;
  const mesh_prop_panel_2_line2_155Geometry = endpoint_prop_panel_2_line2_155
    ? new THREE.CylinderGeometry(endpoint_prop_panel_2_line2_155.endRadius, endpoint_prop_panel_2_line2_155.baseRadius, endpoint_prop_panel_2_line2_155.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_2_line2_155) {
    mesh_prop_panel_2_line2_155Geometry.scale(0.08107, 0.00378, 0.00504);
  }
  const mesh_prop_panel_2_line2_155 = new THREE.Mesh(
    mesh_prop_panel_2_line2_155Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_2_line2_155.name = "Text line prop-panel-2 2";
  if (endpoint_prop_panel_2_line2_155) {
    mesh_prop_panel_2_line2_155.position.copy(endpoint_prop_panel_2_line2_155.midpoint);
    mesh_prop_panel_2_line2_155.quaternion.copy(endpoint_prop_panel_2_line2_155.quaternion);
  }
  mesh_prop_panel_2_line2_155.castShadow = options.castShadow ?? true;
  mesh_prop_panel_2_line2_155.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_2_line2_155.userData.sculptComponent = { id: "prop-panel-2-line2" };
  node_prop_panel_2_line2_155.add(mesh_prop_panel_2_line2_155);
  meshes["prop-panel-2-line2"] = mesh_prop_panel_2_line2_155;
  colliders["prop-panel-2-line2"] = {};
  destructionGroups["icons"] ??= [];
  destructionGroups["icons"].push(node_prop_panel_2_line2_155);

  const endpoint_prop_panel_2_line3_156 = makeAttachmentEndpoint(null);
  const node_prop_panel_2_line3_156 = new THREE.Group();
  node_prop_panel_2_line3_156.name = "Text line prop-panel-2 3__pivot";
  node_prop_panel_2_line3_156.scale.set(1, 1, 1);
  if (endpoint_prop_panel_2_line3_156) {
    node_prop_panel_2_line3_156.position.copy(endpoint_prop_panel_2_line3_156.start);
    node_prop_panel_2_line3_156.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_2_line3_156.position.set(-0.02598, -0.0155, 0.00378);
    node_prop_panel_2_line3_156.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_2_line3_156.userData.sculptComponent = { id: "prop-panel-2-line3" };
  node_prop_panel_2_line3_156.userData.actionProfile = {};
  (nodes["prop-panel-2"] ?? root).add(node_prop_panel_2_line3_156);
  nodes["prop-panel-2-line3"] = node_prop_panel_2_line3_156;
  const mesh_prop_panel_2_line3_156Geometry = endpoint_prop_panel_2_line3_156
    ? new THREE.CylinderGeometry(endpoint_prop_panel_2_line3_156.endRadius, endpoint_prop_panel_2_line3_156.baseRadius, endpoint_prop_panel_2_line3_156.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_2_line3_156) {
    mesh_prop_panel_2_line3_156Geometry.scale(0.11433, 0.00378, 0.00504);
  }
  const mesh_prop_panel_2_line3_156 = new THREE.Mesh(
    mesh_prop_panel_2_line3_156Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_2_line3_156.name = "Text line prop-panel-2 3";
  if (endpoint_prop_panel_2_line3_156) {
    mesh_prop_panel_2_line3_156.position.copy(endpoint_prop_panel_2_line3_156.midpoint);
    mesh_prop_panel_2_line3_156.quaternion.copy(endpoint_prop_panel_2_line3_156.quaternion);
  }
  mesh_prop_panel_2_line3_156.castShadow = options.castShadow ?? true;
  mesh_prop_panel_2_line3_156.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_2_line3_156.userData.sculptComponent = { id: "prop-panel-2-line3" };
  node_prop_panel_2_line3_156.add(mesh_prop_panel_2_line3_156);
  meshes["prop-panel-2-line3"] = mesh_prop_panel_2_line3_156;
  colliders["prop-panel-2-line3"] = {};
  destructionGroups["icons"] ??= [];
  destructionGroups["icons"].push(node_prop_panel_2_line3_156);

  const endpoint_prop_panel_2_line4_157 = makeAttachmentEndpoint(null);
  const node_prop_panel_2_line4_157 = new THREE.Group();
  node_prop_panel_2_line4_157.name = "Text line prop-panel-2 4__pivot";
  node_prop_panel_2_line4_157.scale.set(1, 1, 1);
  if (endpoint_prop_panel_2_line4_157) {
    node_prop_panel_2_line4_157.position.copy(endpoint_prop_panel_2_line4_157.start);
    node_prop_panel_2_line4_157.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_2_line4_157.position.set(-0.0343, -0.04649, 0.00378);
    node_prop_panel_2_line4_157.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_2_line4_157.userData.sculptComponent = { id: "prop-panel-2-line4" };
  node_prop_panel_2_line4_157.userData.actionProfile = {};
  (nodes["prop-panel-2"] ?? root).add(node_prop_panel_2_line4_157);
  nodes["prop-panel-2-line4"] = node_prop_panel_2_line4_157;
  const mesh_prop_panel_2_line4_157Geometry = endpoint_prop_panel_2_line4_157
    ? new THREE.CylinderGeometry(endpoint_prop_panel_2_line4_157.endRadius, endpoint_prop_panel_2_line4_157.baseRadius, endpoint_prop_panel_2_line4_157.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_2_line4_157) {
    mesh_prop_panel_2_line4_157Geometry.scale(0.0977, 0.00378, 0.00504);
  }
  const mesh_prop_panel_2_line4_157 = new THREE.Mesh(
    mesh_prop_panel_2_line4_157Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_2_line4_157.name = "Text line prop-panel-2 4";
  if (endpoint_prop_panel_2_line4_157) {
    mesh_prop_panel_2_line4_157.position.copy(endpoint_prop_panel_2_line4_157.midpoint);
    mesh_prop_panel_2_line4_157.quaternion.copy(endpoint_prop_panel_2_line4_157.quaternion);
  }
  mesh_prop_panel_2_line4_157.castShadow = options.castShadow ?? true;
  mesh_prop_panel_2_line4_157.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_2_line4_157.userData.sculptComponent = { id: "prop-panel-2-line4" };
  node_prop_panel_2_line4_157.add(mesh_prop_panel_2_line4_157);
  meshes["prop-panel-2-line4"] = mesh_prop_panel_2_line4_157;
  colliders["prop-panel-2-line4"] = {};
  destructionGroups["icons"] ??= [];
  destructionGroups["icons"].push(node_prop_panel_2_line4_157);

  const endpoint_prop_tray_158 = makeAttachmentEndpoint(null);
  const node_prop_tray_158 = new THREE.Group();
  node_prop_tray_158.name = "Floating tray__pivot";
  node_prop_tray_158.scale.set(1, 1, 1);
  if (endpoint_prop_tray_158) {
    node_prop_tray_158.position.copy(endpoint_prop_tray_158.start);
    node_prop_tray_158.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_tray_158.position.set(0.51024, 1.19685, 0.15748);
    node_prop_tray_158.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_tray_158.userData.sculptComponent = { id: "prop-tray" };
  node_prop_tray_158.userData.actionProfile = {};
  (nodes["root"] ?? root).add(node_prop_tray_158);
  nodes["prop-tray"] = node_prop_tray_158;
  const mesh_prop_tray_158Geometry = endpoint_prop_tray_158
    ? new THREE.CylinderGeometry(endpoint_prop_tray_158.endRadius, endpoint_prop_tray_158.baseRadius, endpoint_prop_tray_158.length, 8, 4)
    : buildLatheGeometry({"points": [[0, 0], [0.14488, 0], [0.15748, 0.0126], [0.14488, 0.0252], [0, 0.0252]], "segments": 24});
  if (!endpoint_prop_tray_158) {
    mesh_prop_tray_158Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_prop_tray_158 = new THREE.Mesh(
    mesh_prop_tray_158Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_tray_158.name = "Floating tray";
  if (endpoint_prop_tray_158) {
    mesh_prop_tray_158.position.copy(endpoint_prop_tray_158.midpoint);
    mesh_prop_tray_158.quaternion.copy(endpoint_prop_tray_158.quaternion);
  }
  mesh_prop_tray_158.castShadow = options.castShadow ?? true;
  mesh_prop_tray_158.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_tray_158.userData.sculptComponent = { id: "prop-tray" };
  node_prop_tray_158.add(mesh_prop_tray_158);
  meshes["prop-tray"] = mesh_prop_tray_158;
  colliders["prop-tray"] = {};
  destructionGroups["tray"] ??= [];
  destructionGroups["tray"].push(node_prop_tray_158);

  const endpoint_prop_cup_159 = makeAttachmentEndpoint(null);
  const node_prop_cup_159 = new THREE.Group();
  node_prop_cup_159.name = "Coffee cup__pivot";
  node_prop_cup_159.scale.set(1, 1, 1);
  if (endpoint_prop_cup_159) {
    node_prop_cup_159.position.copy(endpoint_prop_cup_159.start);
    node_prop_cup_159.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_cup_159.position.set(-0.04409, 0.0252, 0.0126);
    node_prop_cup_159.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_cup_159.userData.sculptComponent = { id: "prop-cup" };
  node_prop_cup_159.userData.actionProfile = {};
  (nodes["prop-tray"] ?? root).add(node_prop_cup_159);
  nodes["prop-cup"] = node_prop_cup_159;
  const mesh_prop_cup_159Geometry = endpoint_prop_cup_159
    ? new THREE.CylinderGeometry(endpoint_prop_cup_159.endRadius, endpoint_prop_cup_159.baseRadius, endpoint_prop_cup_159.length, 8, 4)
    : buildLatheGeometry({"points": [[0, 0], [0.03465, 0], [0.04409, 0.05669], [0.04724, 0.06929], [0, 0.06929]], "segments": 20});
  if (!endpoint_prop_cup_159) {
    mesh_prop_cup_159Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_prop_cup_159 = new THREE.Mesh(
    mesh_prop_cup_159Geometry,
    materialMap["emblem-white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_cup_159.name = "Coffee cup";
  if (endpoint_prop_cup_159) {
    mesh_prop_cup_159.position.copy(endpoint_prop_cup_159.midpoint);
    mesh_prop_cup_159.quaternion.copy(endpoint_prop_cup_159.quaternion);
  }
  mesh_prop_cup_159.castShadow = options.castShadow ?? true;
  mesh_prop_cup_159.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_cup_159.userData.sculptComponent = { id: "prop-cup" };
  node_prop_cup_159.add(mesh_prop_cup_159);
  meshes["prop-cup"] = mesh_prop_cup_159;
  colliders["prop-cup"] = {};
  destructionGroups["tray"] ??= [];
  destructionGroups["tray"].push(node_prop_cup_159);

  const endpoint_prop_pot_160 = makeAttachmentEndpoint(null);
  const node_prop_pot_160 = new THREE.Group();
  node_prop_pot_160.name = "Plant pot__pivot";
  node_prop_pot_160.scale.set(1, 1, 1);
  if (endpoint_prop_pot_160) {
    node_prop_pot_160.position.copy(endpoint_prop_pot_160.start);
    node_prop_pot_160.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_pot_160.position.set(0.06929, 0.05039, 0.0);
    node_prop_pot_160.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_pot_160.userData.sculptComponent = { id: "prop-pot" };
  node_prop_pot_160.userData.actionProfile = {};
  (nodes["prop-tray"] ?? root).add(node_prop_pot_160);
  nodes["prop-pot"] = node_prop_pot_160;
  const mesh_prop_pot_160Geometry = endpoint_prop_pot_160
    ? new THREE.CylinderGeometry(endpoint_prop_pot_160.endRadius, endpoint_prop_pot_160.baseRadius, endpoint_prop_pot_160.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_pot_160) {
    mesh_prop_pot_160Geometry.scale(0.06929, 0.05039, 0.06929);
  }
  const mesh_prop_pot_160 = new THREE.Mesh(
    mesh_prop_pot_160Geometry,
    materialMap["pot-brown"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_pot_160.name = "Plant pot";
  if (endpoint_prop_pot_160) {
    mesh_prop_pot_160.position.copy(endpoint_prop_pot_160.midpoint);
    mesh_prop_pot_160.quaternion.copy(endpoint_prop_pot_160.quaternion);
  }
  mesh_prop_pot_160.castShadow = options.castShadow ?? true;
  mesh_prop_pot_160.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_pot_160.userData.sculptComponent = { id: "prop-pot" };
  node_prop_pot_160.add(mesh_prop_pot_160);
  meshes["prop-pot"] = mesh_prop_pot_160;
  colliders["prop-pot"] = {};
  destructionGroups["tray"] ??= [];
  destructionGroups["tray"].push(node_prop_pot_160);

  const endpoint_prop_leaf_0_161 = makeAttachmentEndpoint(null);
  const node_prop_leaf_0_161 = new THREE.Group();
  node_prop_leaf_0_161.name = "Plant leaf 0__pivot";
  node_prop_leaf_0_161.scale.set(1, 1, 1);
  if (endpoint_prop_leaf_0_161) {
    node_prop_leaf_0_161.position.copy(endpoint_prop_leaf_0_161.start);
    node_prop_leaf_0_161.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_leaf_0_161.position.set(0.06929, 0.10079, 0.0);
    node_prop_leaf_0_161.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_leaf_0_161.userData.sculptComponent = { id: "prop-leaf-0" };
  node_prop_leaf_0_161.userData.actionProfile = {};
  (nodes["prop-tray"] ?? root).add(node_prop_leaf_0_161);
  nodes["prop-leaf-0"] = node_prop_leaf_0_161;
  const mesh_prop_leaf_0_161Geometry = endpoint_prop_leaf_0_161
    ? new THREE.CylinderGeometry(endpoint_prop_leaf_0_161.endRadius, endpoint_prop_leaf_0_161.baseRadius, endpoint_prop_leaf_0_161.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_prop_leaf_0_161) {
    mesh_prop_leaf_0_161Geometry.scale(0.05669, 0.05669, 0.05669);
  }
  const mesh_prop_leaf_0_161 = new THREE.Mesh(
    mesh_prop_leaf_0_161Geometry,
    materialMap["leaf-green"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_leaf_0_161.name = "Plant leaf 0";
  if (endpoint_prop_leaf_0_161) {
    mesh_prop_leaf_0_161.position.copy(endpoint_prop_leaf_0_161.midpoint);
    mesh_prop_leaf_0_161.quaternion.copy(endpoint_prop_leaf_0_161.quaternion);
  }
  mesh_prop_leaf_0_161.castShadow = options.castShadow ?? true;
  mesh_prop_leaf_0_161.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_leaf_0_161.userData.sculptComponent = { id: "prop-leaf-0" };
  node_prop_leaf_0_161.add(mesh_prop_leaf_0_161);
  meshes["prop-leaf-0"] = mesh_prop_leaf_0_161;
  colliders["prop-leaf-0"] = {};
  destructionGroups["tray"] ??= [];
  destructionGroups["tray"].push(node_prop_leaf_0_161);

  const endpoint_prop_leaf_1_162 = makeAttachmentEndpoint(null);
  const node_prop_leaf_1_162 = new THREE.Group();
  node_prop_leaf_1_162.name = "Plant leaf 1__pivot";
  node_prop_leaf_1_162.scale.set(1, 1, 1);
  if (endpoint_prop_leaf_1_162) {
    node_prop_leaf_1_162.position.copy(endpoint_prop_leaf_1_162.start);
    node_prop_leaf_1_162.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_leaf_1_162.position.set(0.04409, 0.09449, 0.0);
    node_prop_leaf_1_162.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_leaf_1_162.userData.sculptComponent = { id: "prop-leaf-1" };
  node_prop_leaf_1_162.userData.actionProfile = {};
  (nodes["prop-tray"] ?? root).add(node_prop_leaf_1_162);
  nodes["prop-leaf-1"] = node_prop_leaf_1_162;
  const mesh_prop_leaf_1_162Geometry = endpoint_prop_leaf_1_162
    ? new THREE.CylinderGeometry(endpoint_prop_leaf_1_162.endRadius, endpoint_prop_leaf_1_162.baseRadius, endpoint_prop_leaf_1_162.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_prop_leaf_1_162) {
    mesh_prop_leaf_1_162Geometry.scale(0.04409, 0.04409, 0.04409);
  }
  const mesh_prop_leaf_1_162 = new THREE.Mesh(
    mesh_prop_leaf_1_162Geometry,
    materialMap["leaf-green"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_leaf_1_162.name = "Plant leaf 1";
  if (endpoint_prop_leaf_1_162) {
    mesh_prop_leaf_1_162.position.copy(endpoint_prop_leaf_1_162.midpoint);
    mesh_prop_leaf_1_162.quaternion.copy(endpoint_prop_leaf_1_162.quaternion);
  }
  mesh_prop_leaf_1_162.castShadow = options.castShadow ?? true;
  mesh_prop_leaf_1_162.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_leaf_1_162.userData.sculptComponent = { id: "prop-leaf-1" };
  node_prop_leaf_1_162.add(mesh_prop_leaf_1_162);
  meshes["prop-leaf-1"] = mesh_prop_leaf_1_162;
  colliders["prop-leaf-1"] = {};
  destructionGroups["tray"] ??= [];
  destructionGroups["tray"].push(node_prop_leaf_1_162);

  const endpoint_prop_leaf_2_163 = makeAttachmentEndpoint(null);
  const node_prop_leaf_2_163 = new THREE.Group();
  node_prop_leaf_2_163.name = "Plant leaf 2__pivot";
  node_prop_leaf_2_163.scale.set(1, 1, 1);
  if (endpoint_prop_leaf_2_163) {
    node_prop_leaf_2_163.position.copy(endpoint_prop_leaf_2_163.start);
    node_prop_leaf_2_163.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_leaf_2_163.position.set(0.09449, 0.09449, 0.0);
    node_prop_leaf_2_163.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_leaf_2_163.userData.sculptComponent = { id: "prop-leaf-2" };
  node_prop_leaf_2_163.userData.actionProfile = {};
  (nodes["prop-tray"] ?? root).add(node_prop_leaf_2_163);
  nodes["prop-leaf-2"] = node_prop_leaf_2_163;
  const mesh_prop_leaf_2_163Geometry = endpoint_prop_leaf_2_163
    ? new THREE.CylinderGeometry(endpoint_prop_leaf_2_163.endRadius, endpoint_prop_leaf_2_163.baseRadius, endpoint_prop_leaf_2_163.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_prop_leaf_2_163) {
    mesh_prop_leaf_2_163Geometry.scale(0.04409, 0.04409, 0.04409);
  }
  const mesh_prop_leaf_2_163 = new THREE.Mesh(
    mesh_prop_leaf_2_163Geometry,
    materialMap["leaf-green"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_leaf_2_163.name = "Plant leaf 2";
  if (endpoint_prop_leaf_2_163) {
    mesh_prop_leaf_2_163.position.copy(endpoint_prop_leaf_2_163.midpoint);
    mesh_prop_leaf_2_163.quaternion.copy(endpoint_prop_leaf_2_163.quaternion);
  }
  mesh_prop_leaf_2_163.castShadow = options.castShadow ?? true;
  mesh_prop_leaf_2_163.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_leaf_2_163.userData.sculptComponent = { id: "prop-leaf-2" };
  node_prop_leaf_2_163.add(mesh_prop_leaf_2_163);
  meshes["prop-leaf-2"] = mesh_prop_leaf_2_163;
  colliders["prop-leaf-2"] = {};
  destructionGroups["tray"] ??= [];
  destructionGroups["tray"].push(node_prop_leaf_2_163);

  const endpoint_prop_leaf_3_164 = makeAttachmentEndpoint(null);
  const node_prop_leaf_3_164 = new THREE.Group();
  node_prop_leaf_3_164.name = "Plant leaf 3__pivot";
  node_prop_leaf_3_164.scale.set(1, 1, 1);
  if (endpoint_prop_leaf_3_164) {
    node_prop_leaf_3_164.position.copy(endpoint_prop_leaf_3_164.start);
    node_prop_leaf_3_164.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_leaf_3_164.position.set(0.06299, 0.11969, 0.0);
    node_prop_leaf_3_164.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_leaf_3_164.userData.sculptComponent = { id: "prop-leaf-3" };
  node_prop_leaf_3_164.userData.actionProfile = {};
  (nodes["prop-tray"] ?? root).add(node_prop_leaf_3_164);
  nodes["prop-leaf-3"] = node_prop_leaf_3_164;
  const mesh_prop_leaf_3_164Geometry = endpoint_prop_leaf_3_164
    ? new THREE.CylinderGeometry(endpoint_prop_leaf_3_164.endRadius, endpoint_prop_leaf_3_164.baseRadius, endpoint_prop_leaf_3_164.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_prop_leaf_3_164) {
    mesh_prop_leaf_3_164Geometry.scale(0.04409, 0.04409, 0.04409);
  }
  const mesh_prop_leaf_3_164 = new THREE.Mesh(
    mesh_prop_leaf_3_164Geometry,
    materialMap["leaf-green"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_leaf_3_164.name = "Plant leaf 3";
  if (endpoint_prop_leaf_3_164) {
    mesh_prop_leaf_3_164.position.copy(endpoint_prop_leaf_3_164.midpoint);
    mesh_prop_leaf_3_164.quaternion.copy(endpoint_prop_leaf_3_164.quaternion);
  }
  mesh_prop_leaf_3_164.castShadow = options.castShadow ?? true;
  mesh_prop_leaf_3_164.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_leaf_3_164.userData.sculptComponent = { id: "prop-leaf-3" };
  node_prop_leaf_3_164.add(mesh_prop_leaf_3_164);
  meshes["prop-leaf-3"] = mesh_prop_leaf_3_164;
  colliders["prop-leaf-3"] = {};
  destructionGroups["tray"] ??= [];
  destructionGroups["tray"].push(node_prop_leaf_3_164);

  const endpoint_prop_leaf_4_165 = makeAttachmentEndpoint(null);
  const node_prop_leaf_4_165 = new THREE.Group();
  node_prop_leaf_4_165.name = "Plant leaf 4__pivot";
  node_prop_leaf_4_165.scale.set(1, 1, 1);
  if (endpoint_prop_leaf_4_165) {
    node_prop_leaf_4_165.position.copy(endpoint_prop_leaf_4_165.start);
    node_prop_leaf_4_165.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_leaf_4_165.position.set(0.08189, 0.11969, 0.0);
    node_prop_leaf_4_165.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_leaf_4_165.userData.sculptComponent = { id: "prop-leaf-4" };
  node_prop_leaf_4_165.userData.actionProfile = {};
  (nodes["prop-tray"] ?? root).add(node_prop_leaf_4_165);
  nodes["prop-leaf-4"] = node_prop_leaf_4_165;
  const mesh_prop_leaf_4_165Geometry = endpoint_prop_leaf_4_165
    ? new THREE.CylinderGeometry(endpoint_prop_leaf_4_165.endRadius, endpoint_prop_leaf_4_165.baseRadius, endpoint_prop_leaf_4_165.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_prop_leaf_4_165) {
    mesh_prop_leaf_4_165Geometry.scale(0.0378, 0.0378, 0.0378);
  }
  const mesh_prop_leaf_4_165 = new THREE.Mesh(
    mesh_prop_leaf_4_165Geometry,
    materialMap["leaf-green"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_leaf_4_165.name = "Plant leaf 4";
  if (endpoint_prop_leaf_4_165) {
    mesh_prop_leaf_4_165.position.copy(endpoint_prop_leaf_4_165.midpoint);
    mesh_prop_leaf_4_165.quaternion.copy(endpoint_prop_leaf_4_165.quaternion);
  }
  mesh_prop_leaf_4_165.castShadow = options.castShadow ?? true;
  mesh_prop_leaf_4_165.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_leaf_4_165.userData.sculptComponent = { id: "prop-leaf-4" };
  node_prop_leaf_4_165.add(mesh_prop_leaf_4_165);
  meshes["prop-leaf-4"] = mesh_prop_leaf_4_165;
  colliders["prop-leaf-4"] = {};
  destructionGroups["tray"] ??= [];
  destructionGroups["tray"].push(node_prop_leaf_4_165);
  // repetition system "gold-seam-strips" describes 13 parts that are already built individually; not instanced.
  // repetition system "glow-parts" describes 14 parts that are already built individually; not instanced.
  // repetition system "panel-content" describes 15 parts that are already built individually; not instanced.

  root.userData.sculptRuntime = { nodes, meshes, sockets, colliders, destructionGroups } satisfies ProceduralModelRuntime;
  root.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  root.userData.actionReadiness = {
    note: 'Use root.userData.sculptRuntime.nodes for transforms, sockets for attachments, colliders for physics proxies, and destructionGroups for breakable sets.',
  };
  return root;
}
