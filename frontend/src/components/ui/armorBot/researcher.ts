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

// Generated from ObjectSculptSpec target: AI Researcher Bot
// Sculpt build pass: blockout
// This factory is intentionally pass-gated. Finish browser screenshot review before unlocking deeper passes.
export function createBot(options: ProceduralModelOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = "AI Researcher Bot";
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
    {"id": "armor-pearl-silver", "name": "Pearl-silver clear-coated armor", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#9fa3b6", "color": "#9fa3b6", "albedo": {"dominant": "#9fa3b6", "secondary": ["#9496a8", "#b4b8c8"]}, "colorVariation": {"palette": ["#9fa3b6", "#9496a8", "#b4b8c8"], "pattern": "flat", "amplitude": 0.02, "heightCorrelation": 0.0}, "roughness": {"base": 0.22, "variation": 0.04}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "clearcoat-sheen", "region": "armor plates", "change": "low roughness + clearcoat hotspot band following plate curvature", "strength": 0.7, "evidenceRef": "/home/divyansh-muley/Divyansh/Projects/Divi/hero-bot-workspace/refs/bot2.png", "note": "Metadata only: the generator applies clearcoat to the whole material."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Albedo from sampled flat-lit silver regions; gloss from clearcoat + environment light.", "clearcoat": {"base": 1.0}, "clearcoatRoughness": {"base": 0.03}, "textureless": {"declared": true, "evidence": ["Reference view: /home/divyansh-muley/Divyansh/Projects/Divi/hero-bot-workspace/refs/bot2.png shows clean uniform clear-coated pearl paint without grain or wear."]}},
    options
  );
  materialMap["trim-gold"] = createSculptMaterial(
    "trim-gold",
    {"id": "trim-gold", "name": "Metallic gold trim", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#b68241", "color": "#b68241", "albedo": {"dominant": "#b68241", "secondary": ["#a8763a", "#c58f4a"]}, "colorVariation": {"palette": ["#b68241", "#a8763a", "#c58f4a"], "pattern": "flat", "amplitude": 0.02, "heightCorrelation": 0.0}, "roughness": {"base": 0.3, "variation": 0.04}, "metalness": {"base": 1.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Metal: needs environment reflections.", "textureless": {"declared": true, "evidence": ["Reference view: /home/divyansh-muley/Divyansh/Projects/Divi/hero-bot-workspace/refs/bot2.png shows gold as thin smooth inlay lines with no pattern."]}},
    options
  );
  materialMap["joint-black"] = createSculptMaterial(
    "joint-black",
    {"id": "joint-black", "name": "Glossy black polymer", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#141317", "color": "#141317", "albedo": {"dominant": "#141317", "secondary": ["#0e0d11", "#1b1a20"]}, "colorVariation": {"palette": ["#141317", "#0e0d11", "#1b1a20"], "pattern": "flat", "amplitude": 0.02, "heightCorrelation": 0.0}, "roughness": {"base": 0.3, "variation": 0.04}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "", "clearcoat": {"base": 0.5}, "clearcoatRoughness": {"base": 0.1}, "textureless": {"declared": true, "evidence": ["Reference view: /home/divyansh-muley/Divyansh/Projects/Divi/hero-bot-workspace/refs/bot2.png shows smooth glossy black joints and cores."]}},
    options
  );
  materialMap["emissive-accent"] = createSculptMaterial(
    "emissive-accent",
    {"id": "emissive-accent", "name": "Emissive accent", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#2b86ff", "color": "#2b86ff", "albedo": {"dominant": "#2b86ff", "secondary": ["#2b86ff"]}, "colorVariation": {"palette": ["#2b86ff"], "pattern": "flat", "amplitude": 0.02, "heightCorrelation": 0.0}, "roughness": {"base": 0.45, "variation": 0.04}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "bloom-core", "region": "all emissive accents", "change": "emissive intensity intended to bloom", "strength": 1.0, "evidenceRef": "/home/divyansh-muley/Divyansh/Projects/Divi/hero-bot-workspace/refs/bot2.png", "note": "Metadata only."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Every glow is a dedicated component using this material.", "emissive": "#2b86ff", "emissiveIntensity": {"base": 2.6}, "textureless": {"declared": true, "evidence": ["Reference view: /home/divyansh-muley/Divyansh/Projects/Divi/hero-bot-workspace/refs/bot2.png shows uniform glow with no grain or pattern."]}},
    options
  );
  materialMap["emblem-disc-dark"] = createSculptMaterial(
    "emblem-disc-dark",
    {"id": "emblem-disc-dark", "name": "Dark emblem disc", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#0a2a6b", "color": "#0a2a6b", "albedo": {"dominant": "#0a2a6b", "secondary": ["#0a2a6b"]}, "colorVariation": {"palette": ["#0a2a6b"], "pattern": "flat", "amplitude": 0.02, "heightCorrelation": 0.0}, "roughness": {"base": 0.2, "variation": 0.04}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "", "clearcoat": {"base": 1.0}, "clearcoatRoughness": {"base": 0.05}, "textureless": {"declared": true, "evidence": ["Reference view: /home/divyansh-muley/Divyansh/Projects/Divi/hero-bot-workspace/refs/bot2.png shows a plain dark disc behind the AI lettering."]}},
    options
  );
  materialMap["emblem-white"] = createSculptMaterial(
    "emblem-white",
    {"id": "emblem-white", "name": "Emblem white lettering", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#f3f9fc", "color": "#f3f9fc", "albedo": {"dominant": "#f3f9fc", "secondary": ["#f3f9fc"]}, "colorVariation": {"palette": ["#f3f9fc"], "pattern": "flat", "amplitude": 0.02, "heightCorrelation": 0.0}, "roughness": {"base": 0.3, "variation": 0.04}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "", "emissive": "#cfe3ff", "emissiveIntensity": {"base": 0.9}, "textureless": {"declared": true, "evidence": ["Reference view: /home/divyansh-muley/Divyansh/Projects/Divi/hero-bot-workspace/refs/bot2.png shows solid white AI letters."]}},
    options
  );
  materialMap["holo-panel"] = createSculptMaterial(
    "holo-panel",
    {"id": "holo-panel", "name": "Translucent holographic panel", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#4a98ff", "color": "#4a98ff", "albedo": {"dominant": "#4a98ff", "secondary": ["#4a98ff"]}, "colorVariation": {"palette": ["#4a98ff"], "pattern": "flat", "amplitude": 0.02, "heightCorrelation": 0.0}, "roughness": {"base": 0.2, "variation": 0.04}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "", "emissive": "#2b86ff", "emissiveIntensity": {"base": 0.9}, "opacity": {"base": 0.3}, "textureless": {"declared": true, "evidence": ["Reference view: /home/divyansh-muley/Divyansh/Projects/Divi/hero-bot-workspace/refs/bot2.png shows flat translucent coloured panels whose detail is thin lines and bars, which are separate parts."]}},
    options
  );
  materialMap["emissive-amber"] = createSculptMaterial(
    "emissive-amber",
    {"id": "emissive-amber", "name": "Amber eye glow", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#ffd34a", "color": "#ffd34a", "albedo": {"dominant": "#ffd34a", "secondary": ["#ffd34a"]}, "colorVariation": {"palette": ["#ffd34a"], "pattern": "flat", "amplitude": 0.02, "heightCorrelation": 0.0}, "roughness": {"base": 0.4, "variation": 0.04}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "", "emissive": "#ffd34a", "emissiveIntensity": {"base": 2.2}, "textureless": {"declared": true, "evidence": ["Reference view: /home/divyansh-muley/Divyansh/Projects/Divi/hero-bot-workspace/refs/bot2.png shows a small flat amber eye dot on the helmet."]}},
    options
  );

  const nodes: Record<string, THREE.Object3D> = { root };
  const meshes: Record<string, THREE.Mesh> = {};
  const sockets: Record<string, THREE.Object3D> = {};
  const colliders: Record<string, unknown> = {};
  const destructionGroups: Record<string, THREE.Object3D[]> = {};

  const endpoint_root_0 = makeAttachmentEndpoint(null);
  const node_root_0 = new THREE.Group();
  node_root_0.name = "AI Researcher Bot (root)__pivot";
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
  mesh_root_0.name = "AI Researcher Bot (root)";
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

  const endpoint_hover_base_1 = makeAttachmentEndpoint(null);
  const node_hover_base_1 = new THREE.Group();
  node_hover_base_1.name = "Hover base hover-base__pivot";
  node_hover_base_1.scale.set(1, 1, 1);
  if (endpoint_hover_base_1) {
    node_hover_base_1.position.copy(endpoint_hover_base_1.start);
    node_hover_base_1.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hover_base_1.position.set(0.0, 0.34646, 0.0);
    node_hover_base_1.rotation.set(0.0, 0.0, 0.0);
  }
  node_hover_base_1.userData.sculptComponent = { id: "hover-base" };
  node_hover_base_1.userData.actionProfile = {};
  (nodes["root"] ?? root).add(node_hover_base_1);
  nodes["hover-base"] = node_hover_base_1;
  const mesh_hover_base_1Geometry = endpoint_hover_base_1
    ? new THREE.CylinderGeometry(endpoint_hover_base_1.endRadius, endpoint_hover_base_1.baseRadius, endpoint_hover_base_1.length, 8, 4)
    : buildLatheGeometry({"points": [[0.0, 0.0], [0.09134, 0.0], [0.16806, 0.02677], [0.18268, 0.06425], [0.1498, 0.10709], [0.07307, 0.11244], [0.0, 0.11244]], "segments": 28});
  if (!endpoint_hover_base_1) {
    mesh_hover_base_1Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_hover_base_1 = new THREE.Mesh(
    mesh_hover_base_1Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hover_base_1.name = "Hover base hover-base";
  if (endpoint_hover_base_1) {
    mesh_hover_base_1.position.copy(endpoint_hover_base_1.midpoint);
    mesh_hover_base_1.quaternion.copy(endpoint_hover_base_1.quaternion);
  }
  mesh_hover_base_1.castShadow = options.castShadow ?? true;
  mesh_hover_base_1.receiveShadow = options.receiveShadow ?? true;
  mesh_hover_base_1.userData.sculptComponent = { id: "hover-base" };
  node_hover_base_1.add(mesh_hover_base_1);
  meshes["hover-base"] = mesh_hover_base_1;
  colliders["hover-base"] = {};
  destructionGroups["base"] ??= [];
  destructionGroups["base"].push(node_hover_base_1);

  const endpoint_hover_base_ring_2 = makeAttachmentEndpoint(null);
  const node_hover_base_ring_2 = new THREE.Group();
  node_hover_base_ring_2.name = "Base ring hover-base__pivot";
  node_hover_base_ring_2.scale.set(1, 1, 1);
  if (endpoint_hover_base_ring_2) {
    node_hover_base_ring_2.position.copy(endpoint_hover_base_ring_2.start);
    node_hover_base_ring_2.rotation.set(1.5708, 0.0, 0.0);
  } else {
    node_hover_base_ring_2.position.set(0.0, 0.0589, 0.0);
    node_hover_base_ring_2.rotation.set(1.5708, 0.0, 0.0);
  }
  node_hover_base_ring_2.userData.sculptComponent = { id: "hover-base-ring" };
  node_hover_base_ring_2.userData.actionProfile = {};
  (nodes["hover-base"] ?? root).add(node_hover_base_ring_2);
  nodes["hover-base-ring"] = node_hover_base_ring_2;
  const mesh_hover_base_ring_2Geometry = endpoint_hover_base_ring_2
    ? new THREE.CylinderGeometry(endpoint_hover_base_ring_2.endRadius, endpoint_hover_base_ring_2.baseRadius, endpoint_hover_base_ring_2.length, 8, 4)
    : new THREE.TorusGeometry(0.45, 0.0225, 8, 16);
  if (!endpoint_hover_base_ring_2) {
    mesh_hover_base_ring_2Geometry.scale(0.39783, 0.39783, 0.39783);
  }
  const mesh_hover_base_ring_2 = new THREE.Mesh(
    mesh_hover_base_ring_2Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hover_base_ring_2.name = "Base ring hover-base";
  if (endpoint_hover_base_ring_2) {
    mesh_hover_base_ring_2.position.copy(endpoint_hover_base_ring_2.midpoint);
    mesh_hover_base_ring_2.quaternion.copy(endpoint_hover_base_ring_2.quaternion);
  }
  mesh_hover_base_ring_2.castShadow = options.castShadow ?? true;
  mesh_hover_base_ring_2.receiveShadow = options.receiveShadow ?? true;
  mesh_hover_base_ring_2.userData.sculptComponent = { id: "hover-base-ring" };
  node_hover_base_ring_2.add(mesh_hover_base_ring_2);
  meshes["hover-base-ring"] = mesh_hover_base_ring_2;
  colliders["hover-base-ring"] = {};
  destructionGroups["base"] ??= [];
  destructionGroups["base"].push(node_hover_base_ring_2);

  const endpoint_hover_base_glow_3 = makeAttachmentEndpoint(null);
  const node_hover_base_glow_3 = new THREE.Group();
  node_hover_base_glow_3.name = "Base glow hover-base__pivot";
  node_hover_base_glow_3.scale.set(1, 1, 1);
  if (endpoint_hover_base_glow_3) {
    node_hover_base_glow_3.position.copy(endpoint_hover_base_glow_3.start);
    node_hover_base_glow_3.rotation.set(1.5708, 0.0, 0.0);
  } else {
    node_hover_base_glow_3.position.set(0.0, 0.10923, 0.0);
    node_hover_base_glow_3.rotation.set(1.5708, 0.0, 0.0);
  }
  node_hover_base_glow_3.userData.sculptComponent = { id: "hover-base-glow" };
  node_hover_base_glow_3.userData.actionProfile = {};
  (nodes["hover-base"] ?? root).add(node_hover_base_glow_3);
  nodes["hover-base-glow"] = node_hover_base_glow_3;
  const mesh_hover_base_glow_3Geometry = endpoint_hover_base_glow_3
    ? new THREE.CylinderGeometry(endpoint_hover_base_glow_3.endRadius, endpoint_hover_base_glow_3.baseRadius, endpoint_hover_base_glow_3.length, 8, 4)
    : new THREE.TorusGeometry(0.45, 0.018, 8, 16);
  if (!endpoint_hover_base_glow_3) {
    mesh_hover_base_glow_3Geometry.scale(0.27848, 0.27848, 0.27848);
  }
  const mesh_hover_base_glow_3 = new THREE.Mesh(
    mesh_hover_base_glow_3Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hover_base_glow_3.name = "Base glow hover-base";
  if (endpoint_hover_base_glow_3) {
    mesh_hover_base_glow_3.position.copy(endpoint_hover_base_glow_3.midpoint);
    mesh_hover_base_glow_3.quaternion.copy(endpoint_hover_base_glow_3.quaternion);
  }
  mesh_hover_base_glow_3.castShadow = options.castShadow ?? true;
  mesh_hover_base_glow_3.receiveShadow = options.receiveShadow ?? true;
  mesh_hover_base_glow_3.userData.sculptComponent = { id: "hover-base-glow" };
  node_hover_base_glow_3.add(mesh_hover_base_glow_3);
  meshes["hover-base-glow"] = mesh_hover_base_glow_3;
  colliders["hover-base-glow"] = {};
  destructionGroups["base"] ??= [];
  destructionGroups["base"].push(node_hover_base_glow_3);

  const endpoint_hover_base_cone_4 = makeAttachmentEndpoint(null);
  const node_hover_base_cone_4 = new THREE.Group();
  node_hover_base_cone_4.name = "Drill cone hover-base__pivot";
  node_hover_base_cone_4.scale.set(1, 1, 1);
  if (endpoint_hover_base_cone_4) {
    node_hover_base_cone_4.position.copy(endpoint_hover_base_cone_4.start);
    node_hover_base_cone_4.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hover_base_cone_4.position.set(0.0, 0.0, 0.0);
    node_hover_base_cone_4.rotation.set(0.0, 0.0, 0.0);
  }
  node_hover_base_cone_4.userData.sculptComponent = { id: "hover-base-cone" };
  node_hover_base_cone_4.userData.actionProfile = {};
  (nodes["hover-base"] ?? root).add(node_hover_base_cone_4);
  nodes["hover-base-cone"] = node_hover_base_cone_4;
  const mesh_hover_base_cone_4Geometry = endpoint_hover_base_cone_4
    ? new THREE.CylinderGeometry(endpoint_hover_base_cone_4.endRadius, endpoint_hover_base_cone_4.baseRadius, endpoint_hover_base_cone_4.length, 8, 4)
    : buildLatheGeometry({"points": [[0.0, -0.34646], [0.02192, -0.29449], [0.07672, -0.12126], [0.09134, 0.0], [0.0, 0.0]], "segments": 24});
  if (!endpoint_hover_base_cone_4) {
    mesh_hover_base_cone_4Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_hover_base_cone_4 = new THREE.Mesh(
    mesh_hover_base_cone_4Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hover_base_cone_4.name = "Drill cone hover-base";
  if (endpoint_hover_base_cone_4) {
    mesh_hover_base_cone_4.position.copy(endpoint_hover_base_cone_4.midpoint);
    mesh_hover_base_cone_4.quaternion.copy(endpoint_hover_base_cone_4.quaternion);
  }
  mesh_hover_base_cone_4.castShadow = options.castShadow ?? true;
  mesh_hover_base_cone_4.receiveShadow = options.receiveShadow ?? true;
  mesh_hover_base_cone_4.userData.sculptComponent = { id: "hover-base-cone" };
  node_hover_base_cone_4.add(mesh_hover_base_cone_4);
  meshes["hover-base-cone"] = mesh_hover_base_cone_4;
  colliders["hover-base-cone"] = {};
  destructionGroups["base"] ??= [];
  destructionGroups["base"].push(node_hover_base_cone_4);

  const endpoint_hover_base_cone_glow0_5 = makeAttachmentEndpoint(null);
  const node_hover_base_cone_glow0_5 = new THREE.Group();
  node_hover_base_cone_glow0_5.name = "Cone glow hover-base 0__pivot";
  node_hover_base_cone_glow0_5.scale.set(1, 1, 1);
  if (endpoint_hover_base_cone_glow0_5) {
    node_hover_base_cone_glow0_5.position.copy(endpoint_hover_base_cone_glow0_5.start);
    node_hover_base_cone_glow0_5.rotation.set(1.5708, 0.0, 0.0);
  } else {
    node_hover_base_cone_glow0_5.position.set(0.0, -0.06236, 0.0);
    node_hover_base_cone_glow0_5.rotation.set(1.5708, 0.0, 0.0);
  }
  node_hover_base_cone_glow0_5.userData.sculptComponent = { id: "hover-base-cone-glow0" };
  node_hover_base_cone_glow0_5.userData.actionProfile = {};
  (nodes["hover-base-cone"] ?? root).add(node_hover_base_cone_glow0_5);
  nodes["hover-base-cone-glow0"] = node_hover_base_cone_glow0_5;
  const mesh_hover_base_cone_glow0_5Geometry = endpoint_hover_base_cone_glow0_5
    ? new THREE.CylinderGeometry(endpoint_hover_base_cone_glow0_5.endRadius, endpoint_hover_base_cone_glow0_5.baseRadius, endpoint_hover_base_cone_glow0_5.length, 8, 4)
    : new THREE.TorusGeometry(0.45, 0.0225, 8, 16);
  if (!endpoint_hover_base_cone_glow0_5) {
    mesh_hover_base_cone_glow0_5Geometry.scale(0.17862, 0.17862, 0.17862);
  }
  const mesh_hover_base_cone_glow0_5 = new THREE.Mesh(
    mesh_hover_base_cone_glow0_5Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hover_base_cone_glow0_5.name = "Cone glow hover-base 0";
  if (endpoint_hover_base_cone_glow0_5) {
    mesh_hover_base_cone_glow0_5.position.copy(endpoint_hover_base_cone_glow0_5.midpoint);
    mesh_hover_base_cone_glow0_5.quaternion.copy(endpoint_hover_base_cone_glow0_5.quaternion);
  }
  mesh_hover_base_cone_glow0_5.castShadow = options.castShadow ?? true;
  mesh_hover_base_cone_glow0_5.receiveShadow = options.receiveShadow ?? true;
  mesh_hover_base_cone_glow0_5.userData.sculptComponent = { id: "hover-base-cone-glow0" };
  node_hover_base_cone_glow0_5.add(mesh_hover_base_cone_glow0_5);
  meshes["hover-base-cone-glow0"] = mesh_hover_base_cone_glow0_5;
  colliders["hover-base-cone-glow0"] = {};
  destructionGroups["base"] ??= [];
  destructionGroups["base"].push(node_hover_base_cone_glow0_5);

  const endpoint_hover_base_cone_glow1_6 = makeAttachmentEndpoint(null);
  const node_hover_base_cone_glow1_6 = new THREE.Group();
  node_hover_base_cone_glow1_6.name = "Cone glow hover-base 1__pivot";
  node_hover_base_cone_glow1_6.scale.set(1, 1, 1);
  if (endpoint_hover_base_cone_glow1_6) {
    node_hover_base_cone_glow1_6.position.copy(endpoint_hover_base_cone_glow1_6.start);
    node_hover_base_cone_glow1_6.rotation.set(1.5708, 0.0, 0.0);
  } else {
    node_hover_base_cone_glow1_6.position.set(0.0, -0.13858, 0.0);
    node_hover_base_cone_glow1_6.rotation.set(1.5708, 0.0, 0.0);
  }
  node_hover_base_cone_glow1_6.userData.sculptComponent = { id: "hover-base-cone-glow1" };
  node_hover_base_cone_glow1_6.userData.actionProfile = {};
  (nodes["hover-base-cone"] ?? root).add(node_hover_base_cone_glow1_6);
  nodes["hover-base-cone-glow1"] = node_hover_base_cone_glow1_6;
  const mesh_hover_base_cone_glow1_6Geometry = endpoint_hover_base_cone_glow1_6
    ? new THREE.CylinderGeometry(endpoint_hover_base_cone_glow1_6.endRadius, endpoint_hover_base_cone_glow1_6.baseRadius, endpoint_hover_base_cone_glow1_6.length, 8, 4)
    : new THREE.TorusGeometry(0.45, 0.0225, 8, 16);
  if (!endpoint_hover_base_cone_glow1_6) {
    mesh_hover_base_cone_glow1_6Geometry.scale(0.13396, 0.13396, 0.13396);
  }
  const mesh_hover_base_cone_glow1_6 = new THREE.Mesh(
    mesh_hover_base_cone_glow1_6Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hover_base_cone_glow1_6.name = "Cone glow hover-base 1";
  if (endpoint_hover_base_cone_glow1_6) {
    mesh_hover_base_cone_glow1_6.position.copy(endpoint_hover_base_cone_glow1_6.midpoint);
    mesh_hover_base_cone_glow1_6.quaternion.copy(endpoint_hover_base_cone_glow1_6.quaternion);
  }
  mesh_hover_base_cone_glow1_6.castShadow = options.castShadow ?? true;
  mesh_hover_base_cone_glow1_6.receiveShadow = options.receiveShadow ?? true;
  mesh_hover_base_cone_glow1_6.userData.sculptComponent = { id: "hover-base-cone-glow1" };
  node_hover_base_cone_glow1_6.add(mesh_hover_base_cone_glow1_6);
  meshes["hover-base-cone-glow1"] = mesh_hover_base_cone_glow1_6;
  colliders["hover-base-cone-glow1"] = {};
  destructionGroups["base"] ??= [];
  destructionGroups["base"].push(node_hover_base_cone_glow1_6);

  const endpoint_hover_base_cone_glow2_7 = makeAttachmentEndpoint(null);
  const node_hover_base_cone_glow2_7 = new THREE.Group();
  node_hover_base_cone_glow2_7.name = "Cone glow hover-base 2__pivot";
  node_hover_base_cone_glow2_7.scale.set(1, 1, 1);
  if (endpoint_hover_base_cone_glow2_7) {
    node_hover_base_cone_glow2_7.position.copy(endpoint_hover_base_cone_glow2_7.start);
    node_hover_base_cone_glow2_7.rotation.set(1.5708, 0.0, 0.0);
  } else {
    node_hover_base_cone_glow2_7.position.set(0.0, -0.2148, 0.0);
    node_hover_base_cone_glow2_7.rotation.set(1.5708, 0.0, 0.0);
  }
  node_hover_base_cone_glow2_7.userData.sculptComponent = { id: "hover-base-cone-glow2" };
  node_hover_base_cone_glow2_7.userData.actionProfile = {};
  (nodes["hover-base-cone"] ?? root).add(node_hover_base_cone_glow2_7);
  nodes["hover-base-cone-glow2"] = node_hover_base_cone_glow2_7;
  const mesh_hover_base_cone_glow2_7Geometry = endpoint_hover_base_cone_glow2_7
    ? new THREE.CylinderGeometry(endpoint_hover_base_cone_glow2_7.endRadius, endpoint_hover_base_cone_glow2_7.baseRadius, endpoint_hover_base_cone_glow2_7.length, 8, 4)
    : new THREE.TorusGeometry(0.45, 0.0225, 8, 16);
  if (!endpoint_hover_base_cone_glow2_7) {
    mesh_hover_base_cone_glow2_7Geometry.scale(0.08931, 0.08931, 0.08931);
  }
  const mesh_hover_base_cone_glow2_7 = new THREE.Mesh(
    mesh_hover_base_cone_glow2_7Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hover_base_cone_glow2_7.name = "Cone glow hover-base 2";
  if (endpoint_hover_base_cone_glow2_7) {
    mesh_hover_base_cone_glow2_7.position.copy(endpoint_hover_base_cone_glow2_7.midpoint);
    mesh_hover_base_cone_glow2_7.quaternion.copy(endpoint_hover_base_cone_glow2_7.quaternion);
  }
  mesh_hover_base_cone_glow2_7.castShadow = options.castShadow ?? true;
  mesh_hover_base_cone_glow2_7.receiveShadow = options.receiveShadow ?? true;
  mesh_hover_base_cone_glow2_7.userData.sculptComponent = { id: "hover-base-cone-glow2" };
  node_hover_base_cone_glow2_7.add(mesh_hover_base_cone_glow2_7);
  meshes["hover-base-cone-glow2"] = mesh_hover_base_cone_glow2_7;
  colliders["hover-base-cone-glow2"] = {};
  destructionGroups["base"] ??= [];
  destructionGroups["base"].push(node_hover_base_cone_glow2_7);

  const endpoint_body_column_8 = makeAttachmentEndpoint(null);
  const node_body_column_8 = new THREE.Group();
  node_body_column_8.name = "Body column__pivot";
  node_body_column_8.scale.set(1, 1, 1);
  if (endpoint_body_column_8) {
    node_body_column_8.position.copy(endpoint_body_column_8.start);
    node_body_column_8.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_body_column_8.position.set(0.0, 0.15748, 0.0063);
    node_body_column_8.rotation.set(0.0, 0.0, 0.0);
  }
  node_body_column_8.userData.sculptComponent = { id: "body-column" };
  node_body_column_8.userData.actionProfile = {};
  (nodes["hover-base"] ?? root).add(node_body_column_8);
  nodes["body-column"] = node_body_column_8;
  const mesh_body_column_8Geometry = endpoint_body_column_8
    ? new THREE.CylinderGeometry(endpoint_body_column_8.endRadius, endpoint_body_column_8.baseRadius, endpoint_body_column_8.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.06299, "rz": 0.09449, "twist": 0.0}, {"position": [0.0, 0.11024, 0.0], "rx": 0.03465, "rz": 0.04724, "twist": 0.0}, {"position": [0.0, 0.28346, 0.0], "rx": 0.0315, "rz": 0.04409, "twist": 0.0}, {"position": [0.0, 0.44095, 0.0], "rx": 0.0378, "rz": 0.05039, "twist": 0.0}], "radialSegments": 20, "capEnds": true});
  if (!endpoint_body_column_8) {
    mesh_body_column_8Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_body_column_8 = new THREE.Mesh(
    mesh_body_column_8Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_body_column_8.name = "Body column";
  if (endpoint_body_column_8) {
    mesh_body_column_8.position.copy(endpoint_body_column_8.midpoint);
    mesh_body_column_8.quaternion.copy(endpoint_body_column_8.quaternion);
  }
  mesh_body_column_8.castShadow = options.castShadow ?? true;
  mesh_body_column_8.receiveShadow = options.receiveShadow ?? true;
  mesh_body_column_8.userData.sculptComponent = { id: "body-column" };
  node_body_column_8.add(mesh_body_column_8);
  meshes["body-column"] = mesh_body_column_8;
  colliders["body-column"] = {};
  destructionGroups["torso"] ??= [];
  destructionGroups["torso"].push(node_body_column_8);

  const endpoint_column_plate_l_9 = makeAttachmentEndpoint(null);
  const node_column_plate_l_9 = new THREE.Group();
  node_column_plate_l_9.name = "Column plate L__pivot";
  node_column_plate_l_9.scale.set(1, 1, 1);
  if (endpoint_column_plate_l_9) {
    node_column_plate_l_9.position.copy(endpoint_column_plate_l_9.start);
    node_column_plate_l_9.rotation.set(0.0, 0.66323, 0.0);
  } else {
    node_column_plate_l_9.position.set(0.02327, 0.42205, 0.02348);
    node_column_plate_l_9.rotation.set(0.0, 0.66323, 0.0);
  }
  node_column_plate_l_9.userData.sculptComponent = { id: "column-plate-l" };
  node_column_plate_l_9.userData.actionProfile = {};
  (nodes["body-column"] ?? root).add(node_column_plate_l_9);
  nodes["column-plate-l"] = node_column_plate_l_9;
  const mesh_column_plate_l_9Geometry = endpoint_column_plate_l_9
    ? new THREE.CylinderGeometry(endpoint_column_plate_l_9.endRadius, endpoint_column_plate_l_9.baseRadius, endpoint_column_plate_l_9.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.01209, "rz": 0.00693, "twist": 0.0}, {"position": [0.0, -0.07685, 0.0], "rx": 0.01635, "rz": 0.02425, "twist": 0.0}, {"position": [0.0, -0.21134, 0.0], "rx": 0.0189, "rz": 0.03465, "twist": 0.0}, {"position": [0.0, -0.32661, 0.0], "rx": 0.01677, "rz": 0.02598, "twist": 0.0}, {"position": [0.0, -0.38425, 0.0], "rx": 0.01209, "rz": 0.00693, "twist": 0.0}], "radialSegments": 16, "capEnds": true});
  if (!endpoint_column_plate_l_9) {
    mesh_column_plate_l_9Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_column_plate_l_9 = new THREE.Mesh(
    mesh_column_plate_l_9Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_column_plate_l_9.name = "Column plate L";
  if (endpoint_column_plate_l_9) {
    mesh_column_plate_l_9.position.copy(endpoint_column_plate_l_9.midpoint);
    mesh_column_plate_l_9.quaternion.copy(endpoint_column_plate_l_9.quaternion);
  }
  mesh_column_plate_l_9.castShadow = options.castShadow ?? true;
  mesh_column_plate_l_9.receiveShadow = options.receiveShadow ?? true;
  mesh_column_plate_l_9.userData.sculptComponent = { id: "column-plate-l" };
  node_column_plate_l_9.add(mesh_column_plate_l_9);
  meshes["column-plate-l"] = mesh_column_plate_l_9;
  colliders["column-plate-l"] = {};
  destructionGroups["torso"] ??= [];
  destructionGroups["torso"].push(node_column_plate_l_9);

  const endpoint_column_plate_r_10 = makeAttachmentEndpoint(null);
  const node_column_plate_r_10 = new THREE.Group();
  node_column_plate_r_10.name = "Column plate R__pivot";
  node_column_plate_r_10.scale.set(1, 1, 1);
  if (endpoint_column_plate_r_10) {
    node_column_plate_r_10.position.copy(endpoint_column_plate_r_10.start);
    node_column_plate_r_10.rotation.set(0.0, -0.66323, 0.0);
  } else {
    node_column_plate_r_10.position.set(-0.02327, 0.42205, 0.02348);
    node_column_plate_r_10.rotation.set(0.0, -0.66323, 0.0);
  }
  node_column_plate_r_10.userData.sculptComponent = { id: "column-plate-r" };
  node_column_plate_r_10.userData.actionProfile = {};
  (nodes["body-column"] ?? root).add(node_column_plate_r_10);
  nodes["column-plate-r"] = node_column_plate_r_10;
  const mesh_column_plate_r_10Geometry = endpoint_column_plate_r_10
    ? new THREE.CylinderGeometry(endpoint_column_plate_r_10.endRadius, endpoint_column_plate_r_10.baseRadius, endpoint_column_plate_r_10.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.01209, "rz": 0.00693, "twist": 0.0}, {"position": [0.0, -0.07685, 0.0], "rx": 0.01635, "rz": 0.02425, "twist": 0.0}, {"position": [0.0, -0.21134, 0.0], "rx": 0.0189, "rz": 0.03465, "twist": 0.0}, {"position": [0.0, -0.32661, 0.0], "rx": 0.01677, "rz": 0.02598, "twist": 0.0}, {"position": [0.0, -0.38425, 0.0], "rx": 0.01209, "rz": 0.00693, "twist": 0.0}], "radialSegments": 16, "capEnds": true});
  if (!endpoint_column_plate_r_10) {
    mesh_column_plate_r_10Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_column_plate_r_10 = new THREE.Mesh(
    mesh_column_plate_r_10Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_column_plate_r_10.name = "Column plate R";
  if (endpoint_column_plate_r_10) {
    mesh_column_plate_r_10.position.copy(endpoint_column_plate_r_10.midpoint);
    mesh_column_plate_r_10.quaternion.copy(endpoint_column_plate_r_10.quaternion);
  }
  mesh_column_plate_r_10.castShadow = options.castShadow ?? true;
  mesh_column_plate_r_10.receiveShadow = options.receiveShadow ?? true;
  mesh_column_plate_r_10.userData.sculptComponent = { id: "column-plate-r" };
  node_column_plate_r_10.add(mesh_column_plate_r_10);
  meshes["column-plate-r"] = mesh_column_plate_r_10;
  colliders["column-plate-r"] = {};
  destructionGroups["torso"] ??= [];
  destructionGroups["torso"].push(node_column_plate_r_10);

  const endpoint_column_glow_11 = makeAttachmentEndpoint(null);
  const node_column_glow_11 = new THREE.Group();
  node_column_glow_11.name = "Column glow line__pivot";
  node_column_glow_11.scale.set(1, 1, 1);
  if (endpoint_column_glow_11) {
    node_column_glow_11.position.copy(endpoint_column_glow_11.start);
    node_column_glow_11.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_column_glow_11.position.set(0.0, 0.0, 0.0);
    node_column_glow_11.rotation.set(0.0, 0.0, 0.0);
  }
  node_column_glow_11.userData.sculptComponent = { id: "column-glow" };
  node_column_glow_11.userData.actionProfile = {};
  (nodes["body-column"] ?? root).add(node_column_glow_11);
  nodes["column-glow"] = node_column_glow_11;
  const mesh_column_glow_11Geometry = endpoint_column_glow_11
    ? new THREE.CylinderGeometry(endpoint_column_glow_11.endRadius, endpoint_column_glow_11.baseRadius, endpoint_column_glow_11.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0252, 0.04409, 0.02835], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [0.02205, 0.17323, 0.02835], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [0.02205, 0.29921, 0.02835], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [0.02835, 0.41575, 0.02835], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_column_glow_11) {
    mesh_column_glow_11Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_column_glow_11 = new THREE.Mesh(
    mesh_column_glow_11Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_column_glow_11.name = "Column glow line";
  if (endpoint_column_glow_11) {
    mesh_column_glow_11.position.copy(endpoint_column_glow_11.midpoint);
    mesh_column_glow_11.quaternion.copy(endpoint_column_glow_11.quaternion);
  }
  mesh_column_glow_11.castShadow = options.castShadow ?? true;
  mesh_column_glow_11.receiveShadow = options.receiveShadow ?? true;
  mesh_column_glow_11.userData.sculptComponent = { id: "column-glow" };
  node_column_glow_11.add(mesh_column_glow_11);
  meshes["column-glow"] = mesh_column_glow_11;
  colliders["column-glow"] = {};
  destructionGroups["body-column"] ??= [];
  destructionGroups["body-column"].push(node_column_glow_11);

  const attachment_chest_12 = {"parentSocket": "body-column-chest", "localStart": [0.0, 0.45354, 0.0], "localEnd": [0.0, 0.7685, 0.0063], "contactType": "rigid-weld", "baseRadius": 0.06929, "endRadius": 0.12598, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_chest_12 = makeAttachmentEndpoint(attachment_chest_12);
  const node_chest_12 = new THREE.Group();
  node_chest_12.name = "Chest core__pivot";
  node_chest_12.scale.set(1, 1, 1);
  if (endpoint_chest_12) {
    node_chest_12.position.copy(endpoint_chest_12.start);
    node_chest_12.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_chest_12.position.set(0.0, 0.45354, 0.0);
    node_chest_12.rotation.set(0.0, 0.0, 0.0);
  }
  node_chest_12.userData.sculptComponent = { id: "chest" };
  node_chest_12.userData.actionProfile = {};
  (nodes["body-column"] ?? root).add(node_chest_12);
  nodes["chest"] = node_chest_12;
  const mesh_chest_12Geometry = endpoint_chest_12
    ? new THREE.CylinderGeometry(endpoint_chest_12.endRadius, endpoint_chest_12.baseRadius, endpoint_chest_12.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_chest_12) {
    mesh_chest_12Geometry.scale(0.13858, 0.31502, 0.13858);
  }
  const mesh_chest_12 = new THREE.Mesh(
    mesh_chest_12Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_chest_12.name = "Chest core";
  if (endpoint_chest_12) {
    mesh_chest_12.position.copy(endpoint_chest_12.midpoint);
    mesh_chest_12.quaternion.copy(endpoint_chest_12.quaternion);
  }
  mesh_chest_12.castShadow = options.castShadow ?? true;
  mesh_chest_12.receiveShadow = options.receiveShadow ?? true;
  mesh_chest_12.userData.sculptComponent = { id: "chest" };
  node_chest_12.add(mesh_chest_12);
  meshes["chest"] = mesh_chest_12;
  colliders["chest"] = {};
  destructionGroups["torso"] ??= [];
  destructionGroups["torso"].push(node_chest_12);

  const attachment_neck_13 = {"parentSocket": "chest-neck", "localStart": [0.0, 0.31496, 0.0063], "localEnd": [0.0, 0.40315, 0.0063], "contactType": "rigid-weld", "baseRadius": 0.0315, "endRadius": 0.02835, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_neck_13 = makeAttachmentEndpoint(attachment_neck_13);
  const node_neck_13 = new THREE.Group();
  node_neck_13.name = "Neck__pivot";
  node_neck_13.scale.set(1, 1, 1);
  if (endpoint_neck_13) {
    node_neck_13.position.copy(endpoint_neck_13.start);
    node_neck_13.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_neck_13.position.set(0.0, 0.31496, 0.0063);
    node_neck_13.rotation.set(0.0, 0.0, 0.0);
  }
  node_neck_13.userData.sculptComponent = { id: "neck" };
  node_neck_13.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_neck_13);
  nodes["neck"] = node_neck_13;
  const mesh_neck_13Geometry = endpoint_neck_13
    ? new THREE.CylinderGeometry(endpoint_neck_13.endRadius, endpoint_neck_13.baseRadius, endpoint_neck_13.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_neck_13) {
    mesh_neck_13Geometry.scale(0.06299, 0.08819, 0.06299);
  }
  const mesh_neck_13 = new THREE.Mesh(
    mesh_neck_13Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_neck_13.name = "Neck";
  if (endpoint_neck_13) {
    mesh_neck_13.position.copy(endpoint_neck_13.midpoint);
    mesh_neck_13.quaternion.copy(endpoint_neck_13.quaternion);
  }
  mesh_neck_13.castShadow = options.castShadow ?? true;
  mesh_neck_13.receiveShadow = options.receiveShadow ?? true;
  mesh_neck_13.userData.sculptComponent = { id: "neck" };
  node_neck_13.add(mesh_neck_13);
  meshes["neck"] = mesh_neck_13;
  colliders["neck"] = {};
  destructionGroups["head"] ??= [];
  destructionGroups["head"].push(node_neck_13);

  const endpoint_neck_ring_14 = makeAttachmentEndpoint(null);
  const node_neck_ring_14 = new THREE.Group();
  node_neck_ring_14.name = "Gold neck collar__pivot";
  node_neck_ring_14.scale.set(1, 1, 1);
  if (endpoint_neck_ring_14) {
    node_neck_ring_14.position.copy(endpoint_neck_ring_14.start);
    node_neck_ring_14.rotation.set(1.5708, 0.0, 0.0);
  } else {
    node_neck_ring_14.position.set(0.0, 0.30866, 0.0063);
    node_neck_ring_14.rotation.set(1.5708, 0.0, 0.0);
  }
  node_neck_ring_14.userData.sculptComponent = { id: "neck-ring" };
  node_neck_ring_14.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_neck_ring_14);
  nodes["neck-ring"] = node_neck_ring_14;
  const mesh_neck_ring_14Geometry = endpoint_neck_ring_14
    ? new THREE.CylinderGeometry(endpoint_neck_ring_14.endRadius, endpoint_neck_ring_14.baseRadius, endpoint_neck_ring_14.length, 8, 4)
    : new THREE.TorusGeometry(0.45, 0.045, 8, 16);
  if (!endpoint_neck_ring_14) {
    mesh_neck_ring_14Geometry.scale(0.15398, 0.15398, 0.15398);
  }
  const mesh_neck_ring_14 = new THREE.Mesh(
    mesh_neck_ring_14Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_neck_ring_14.name = "Gold neck collar";
  if (endpoint_neck_ring_14) {
    mesh_neck_ring_14.position.copy(endpoint_neck_ring_14.midpoint);
    mesh_neck_ring_14.quaternion.copy(endpoint_neck_ring_14.quaternion);
  }
  mesh_neck_ring_14.castShadow = options.castShadow ?? true;
  mesh_neck_ring_14.receiveShadow = options.receiveShadow ?? true;
  mesh_neck_ring_14.userData.sculptComponent = { id: "neck-ring" };
  node_neck_ring_14.add(mesh_neck_ring_14);
  meshes["neck-ring"] = mesh_neck_ring_14;
  colliders["neck-ring"] = {};
  destructionGroups["head"] ??= [];
  destructionGroups["head"].push(node_neck_ring_14);

  const endpoint_head_15 = makeAttachmentEndpoint(null);
  const node_head_15 = new THREE.Group();
  node_head_15.name = "Round helmet__pivot";
  node_head_15.scale.set(1, 1, 1);
  if (endpoint_head_15) {
    node_head_15.position.copy(endpoint_head_15.start);
    node_head_15.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_head_15.position.set(0.0, 0.07559, -0.00315);
    node_head_15.rotation.set(0.0, 0.0, 0.0);
  }
  node_head_15.userData.sculptComponent = { id: "head" };
  node_head_15.userData.actionProfile = {};
  (nodes["neck"] ?? root).add(node_head_15);
  nodes["head"] = node_head_15;
  const mesh_head_15Geometry = endpoint_head_15
    ? new THREE.CylinderGeometry(endpoint_head_15.endRadius, endpoint_head_15.baseRadius, endpoint_head_15.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.04094, "rz": 0.0378, "twist": 0.0}, {"position": [0.0, 0.0315, 0.0], "rx": 0.07874, "rz": 0.07559, "twist": 0.0}, {"position": [0.0, 0.09449, 0.0], "rx": 0.11339, "rz": 0.11339, "twist": 0.0}, {"position": [0.0, 0.16378, 0.0], "rx": 0.12598, "rz": 0.12598, "twist": 0.0}, {"position": [0.0, 0.22677, 0.0], "rx": 0.10709, "rz": 0.10709, "twist": 0.0}, {"position": [0.0, 0.25827, 0.0], "rx": 0.06299, "rz": 0.06299, "twist": 0.0}, {"position": [0.0, 0.27402, 0.0], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 24, "capEnds": true});
  if (!endpoint_head_15) {
    mesh_head_15Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_head_15 = new THREE.Mesh(
    mesh_head_15Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_head_15.name = "Round helmet";
  if (endpoint_head_15) {
    mesh_head_15.position.copy(endpoint_head_15.midpoint);
    mesh_head_15.quaternion.copy(endpoint_head_15.quaternion);
  }
  mesh_head_15.castShadow = options.castShadow ?? true;
  mesh_head_15.receiveShadow = options.receiveShadow ?? true;
  mesh_head_15.userData.sculptComponent = { id: "head" };
  node_head_15.add(mesh_head_15);
  meshes["head"] = mesh_head_15;
  colliders["head"] = {};
  destructionGroups["head"] ??= [];
  destructionGroups["head"].push(node_head_15);

  const endpoint_head_cap_16 = makeAttachmentEndpoint(null);
  const node_head_cap_16 = new THREE.Group();
  node_head_cap_16.name = "Silver helmet cap__pivot";
  node_head_cap_16.scale.set(1, 1, 1);
  if (endpoint_head_cap_16) {
    node_head_cap_16.position.copy(endpoint_head_cap_16.start);
    node_head_cap_16.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_head_cap_16.position.set(0.0, 0.13858, 0.0);
    node_head_cap_16.rotation.set(0.0, 0.0, 0.0);
  }
  node_head_cap_16.userData.sculptComponent = { id: "head-cap" };
  node_head_cap_16.userData.actionProfile = {};
  (nodes["head"] ?? root).add(node_head_cap_16);
  nodes["head-cap"] = node_head_cap_16;
  const mesh_head_cap_16Geometry = endpoint_head_cap_16
    ? new THREE.CylinderGeometry(endpoint_head_cap_16.endRadius, endpoint_head_cap_16.baseRadius, endpoint_head_cap_16.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.13543, "rz": 0.12913, "twist": 0.0}, {"position": [0.0, 0.05669, 0.0], "rx": 0.13228, "rz": 0.12598, "twist": 0.0}, {"position": [0.0, 0.10709, 0.0], "rx": 0.09134, "rz": 0.08819, "twist": 0.0}, {"position": [0.0, 0.13228, 0.0], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 24, "capEnds": true});
  if (!endpoint_head_cap_16) {
    mesh_head_cap_16Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_head_cap_16 = new THREE.Mesh(
    mesh_head_cap_16Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_head_cap_16.name = "Silver helmet cap";
  if (endpoint_head_cap_16) {
    mesh_head_cap_16.position.copy(endpoint_head_cap_16.midpoint);
    mesh_head_cap_16.quaternion.copy(endpoint_head_cap_16.quaternion);
  }
  mesh_head_cap_16.castShadow = options.castShadow ?? true;
  mesh_head_cap_16.receiveShadow = options.receiveShadow ?? true;
  mesh_head_cap_16.userData.sculptComponent = { id: "head-cap" };
  node_head_cap_16.add(mesh_head_cap_16);
  meshes["head-cap"] = mesh_head_cap_16;
  colliders["head-cap"] = {};
  destructionGroups["head"] ??= [];
  destructionGroups["head"].push(node_head_cap_16);

  const endpoint_head_ring_17 = makeAttachmentEndpoint(null);
  const node_head_ring_17 = new THREE.Group();
  node_head_ring_17.name = "Gold helmet band__pivot";
  node_head_ring_17.scale.set(1, 1, 1);
  if (endpoint_head_ring_17) {
    node_head_ring_17.position.copy(endpoint_head_ring_17.start);
    node_head_ring_17.rotation.set(1.5708, 0.0, 0.0);
  } else {
    node_head_ring_17.position.set(0.0, 0.15118, 0.0);
    node_head_ring_17.rotation.set(1.5708, 0.0, 0.0);
  }
  node_head_ring_17.userData.sculptComponent = { id: "head-ring" };
  node_head_ring_17.userData.actionProfile = {};
  (nodes["head"] ?? root).add(node_head_ring_17);
  nodes["head-ring"] = node_head_ring_17;
  const mesh_head_ring_17Geometry = endpoint_head_ring_17
    ? new THREE.CylinderGeometry(endpoint_head_ring_17.endRadius, endpoint_head_ring_17.baseRadius, endpoint_head_ring_17.length, 8, 4)
    : new THREE.TorusGeometry(0.45, 0.022, 8, 16);
  if (!endpoint_head_ring_17) {
    mesh_head_ring_17Geometry.scale(0.28696, 0.28696, 0.28696);
  }
  const mesh_head_ring_17 = new THREE.Mesh(
    mesh_head_ring_17Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_head_ring_17.name = "Gold helmet band";
  if (endpoint_head_ring_17) {
    mesh_head_ring_17.position.copy(endpoint_head_ring_17.midpoint);
    mesh_head_ring_17.quaternion.copy(endpoint_head_ring_17.quaternion);
  }
  mesh_head_ring_17.castShadow = options.castShadow ?? true;
  mesh_head_ring_17.receiveShadow = options.receiveShadow ?? true;
  mesh_head_ring_17.userData.sculptComponent = { id: "head-ring" };
  node_head_ring_17.add(mesh_head_ring_17);
  meshes["head-ring"] = mesh_head_ring_17;
  colliders["head-ring"] = {};
  destructionGroups["head"] ??= [];
  destructionGroups["head"].push(node_head_ring_17);

  const endpoint_visor_glow_18 = makeAttachmentEndpoint(null);
  const node_visor_glow_18 = new THREE.Group();
  node_visor_glow_18.name = "Visor glow band__pivot";
  node_visor_glow_18.scale.set(1, 1, 1);
  if (endpoint_visor_glow_18) {
    node_visor_glow_18.position.copy(endpoint_visor_glow_18.start);
    node_visor_glow_18.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_visor_glow_18.position.set(0.0, 0.10709, 0.11024);
    node_visor_glow_18.rotation.set(0.0, 0.0, 0.0);
  }
  node_visor_glow_18.userData.sculptComponent = { id: "visor-glow" };
  node_visor_glow_18.userData.actionProfile = {};
  (nodes["head"] ?? root).add(node_visor_glow_18);
  nodes["visor-glow"] = node_visor_glow_18;
  const mesh_visor_glow_18Geometry = endpoint_visor_glow_18
    ? new THREE.CylinderGeometry(endpoint_visor_glow_18.endRadius, endpoint_visor_glow_18.baseRadius, endpoint_visor_glow_18.length, 8, 4)
    : buildExtrudeGeometry({"points": [[-0.09449, -0.0126], [-0.04724, 0.0063], [0.0, 0.01575], [0.04724, 0.0063], [0.09449, -0.0126], [0.08189, -0.03465], [0.04724, -0.0189], [0.0, -0.00945], [-0.04724, -0.0189], [-0.08189, -0.03465]], "depth": 0.00945});
  if (!endpoint_visor_glow_18) {
    mesh_visor_glow_18Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_visor_glow_18 = new THREE.Mesh(
    mesh_visor_glow_18Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_visor_glow_18.name = "Visor glow band";
  if (endpoint_visor_glow_18) {
    mesh_visor_glow_18.position.copy(endpoint_visor_glow_18.midpoint);
    mesh_visor_glow_18.quaternion.copy(endpoint_visor_glow_18.quaternion);
  }
  mesh_visor_glow_18.castShadow = options.castShadow ?? true;
  mesh_visor_glow_18.receiveShadow = options.receiveShadow ?? true;
  mesh_visor_glow_18.userData.sculptComponent = { id: "visor-glow" };
  node_visor_glow_18.add(mesh_visor_glow_18);
  meshes["visor-glow"] = mesh_visor_glow_18;
  colliders["visor-glow"] = {};
  destructionGroups["head"] ??= [];
  destructionGroups["head"].push(node_visor_glow_18);

  const endpoint_head_eye_19 = makeAttachmentEndpoint(null);
  const node_head_eye_19 = new THREE.Group();
  node_head_eye_19.name = "Amber eye__pivot";
  node_head_eye_19.scale.set(1, 1, 1);
  if (endpoint_head_eye_19) {
    node_head_eye_19.position.copy(endpoint_head_eye_19.start);
    node_head_eye_19.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_head_eye_19.position.set(-0.05039, 0.14488, 0.11339);
    node_head_eye_19.rotation.set(0.0, 0.0, 0.0);
  }
  node_head_eye_19.userData.sculptComponent = { id: "head-eye" };
  node_head_eye_19.userData.actionProfile = {};
  (nodes["head"] ?? root).add(node_head_eye_19);
  nodes["head-eye"] = node_head_eye_19;
  const mesh_head_eye_19Geometry = endpoint_head_eye_19
    ? new THREE.CylinderGeometry(endpoint_head_eye_19.endRadius, endpoint_head_eye_19.baseRadius, endpoint_head_eye_19.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_head_eye_19) {
    mesh_head_eye_19Geometry.scale(0.05039, 0.05039, 0.0252);
  }
  const mesh_head_eye_19 = new THREE.Mesh(
    mesh_head_eye_19Geometry,
    materialMap["emissive-amber"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_head_eye_19.name = "Amber eye";
  if (endpoint_head_eye_19) {
    mesh_head_eye_19.position.copy(endpoint_head_eye_19.midpoint);
    mesh_head_eye_19.quaternion.copy(endpoint_head_eye_19.quaternion);
  }
  mesh_head_eye_19.castShadow = options.castShadow ?? true;
  mesh_head_eye_19.receiveShadow = options.receiveShadow ?? true;
  mesh_head_eye_19.userData.sculptComponent = { id: "head-eye" };
  node_head_eye_19.add(mesh_head_eye_19);
  meshes["head-eye"] = mesh_head_eye_19;
  colliders["head-eye"] = {};
  destructionGroups["head"] ??= [];
  destructionGroups["head"].push(node_head_eye_19);

  const attachment_ear_pod_l_20 = {"parentSocket": "head-ear-pod-l", "localStart": [0.11024, 0.12598, 0.0], "localEnd": [0.14488, 0.12598, 0.0], "contactType": "rigid-weld", "baseRadius": 0.0315, "endRadius": 0.0315, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_ear_pod_l_20 = makeAttachmentEndpoint(attachment_ear_pod_l_20);
  const node_ear_pod_l_20 = new THREE.Group();
  node_ear_pod_l_20.name = "Ear pod L__pivot";
  node_ear_pod_l_20.scale.set(1, 1, 1);
  if (endpoint_ear_pod_l_20) {
    node_ear_pod_l_20.position.copy(endpoint_ear_pod_l_20.start);
    node_ear_pod_l_20.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_ear_pod_l_20.position.set(0.11024, 0.12598, 0.0);
    node_ear_pod_l_20.rotation.set(0.0, 0.0, 0.0);
  }
  node_ear_pod_l_20.userData.sculptComponent = { id: "ear-pod-l" };
  node_ear_pod_l_20.userData.actionProfile = {};
  (nodes["head"] ?? root).add(node_ear_pod_l_20);
  nodes["ear-pod-l"] = node_ear_pod_l_20;
  const mesh_ear_pod_l_20Geometry = endpoint_ear_pod_l_20
    ? new THREE.CylinderGeometry(endpoint_ear_pod_l_20.endRadius, endpoint_ear_pod_l_20.baseRadius, endpoint_ear_pod_l_20.length, 8, 4)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 10, 4);
  if (!endpoint_ear_pod_l_20) {
    mesh_ear_pod_l_20Geometry.scale(0.06299, 0.03465, 0.06299);
  }
  const mesh_ear_pod_l_20 = new THREE.Mesh(
    mesh_ear_pod_l_20Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ear_pod_l_20.name = "Ear pod L";
  if (endpoint_ear_pod_l_20) {
    mesh_ear_pod_l_20.position.copy(endpoint_ear_pod_l_20.midpoint);
    mesh_ear_pod_l_20.quaternion.copy(endpoint_ear_pod_l_20.quaternion);
  }
  mesh_ear_pod_l_20.castShadow = options.castShadow ?? true;
  mesh_ear_pod_l_20.receiveShadow = options.receiveShadow ?? true;
  mesh_ear_pod_l_20.userData.sculptComponent = { id: "ear-pod-l" };
  node_ear_pod_l_20.add(mesh_ear_pod_l_20);
  meshes["ear-pod-l"] = mesh_ear_pod_l_20;
  colliders["ear-pod-l"] = {};
  destructionGroups["head"] ??= [];
  destructionGroups["head"].push(node_ear_pod_l_20);

  const endpoint_ear_pod_ring_l_21 = makeAttachmentEndpoint(null);
  const node_ear_pod_ring_l_21 = new THREE.Group();
  node_ear_pod_ring_l_21.name = "Ear pod ring L__pivot";
  node_ear_pod_ring_l_21.scale.set(1, 1, 1);
  if (endpoint_ear_pod_ring_l_21) {
    node_ear_pod_ring_l_21.position.copy(endpoint_ear_pod_ring_l_21.start);
    node_ear_pod_ring_l_21.rotation.set(0.0, 1.5708, 0.0);
  } else {
    node_ear_pod_ring_l_21.position.set(0.14646, 0.12598, 0.0);
    node_ear_pod_ring_l_21.rotation.set(0.0, 1.5708, 0.0);
  }
  node_ear_pod_ring_l_21.userData.sculptComponent = { id: "ear-pod-ring-l" };
  node_ear_pod_ring_l_21.userData.actionProfile = {};
  (nodes["head"] ?? root).add(node_ear_pod_ring_l_21);
  nodes["ear-pod-ring-l"] = node_ear_pod_ring_l_21;
  const mesh_ear_pod_ring_l_21Geometry = endpoint_ear_pod_ring_l_21
    ? new THREE.CylinderGeometry(endpoint_ear_pod_ring_l_21.endRadius, endpoint_ear_pod_ring_l_21.baseRadius, endpoint_ear_pod_ring_l_21.length, 8, 4)
    : new THREE.TorusGeometry(0.45, 0.09, 8, 16);
  if (!endpoint_ear_pod_ring_l_21) {
    mesh_ear_pod_ring_l_21Geometry.scale(0.06299, 0.06299, 0.06299);
  }
  const mesh_ear_pod_ring_l_21 = new THREE.Mesh(
    mesh_ear_pod_ring_l_21Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ear_pod_ring_l_21.name = "Ear pod ring L";
  if (endpoint_ear_pod_ring_l_21) {
    mesh_ear_pod_ring_l_21.position.copy(endpoint_ear_pod_ring_l_21.midpoint);
    mesh_ear_pod_ring_l_21.quaternion.copy(endpoint_ear_pod_ring_l_21.quaternion);
  }
  mesh_ear_pod_ring_l_21.castShadow = options.castShadow ?? true;
  mesh_ear_pod_ring_l_21.receiveShadow = options.receiveShadow ?? true;
  mesh_ear_pod_ring_l_21.userData.sculptComponent = { id: "ear-pod-ring-l" };
  node_ear_pod_ring_l_21.add(mesh_ear_pod_ring_l_21);
  meshes["ear-pod-ring-l"] = mesh_ear_pod_ring_l_21;
  colliders["ear-pod-ring-l"] = {};
  destructionGroups["head"] ??= [];
  destructionGroups["head"].push(node_ear_pod_ring_l_21);

  const attachment_ear_pod_r_22 = {"parentSocket": "head-ear-pod-r", "localStart": [-0.11024, 0.12598, 0.0], "localEnd": [-0.14488, 0.12598, 0.0], "contactType": "rigid-weld", "baseRadius": 0.0315, "endRadius": 0.0315, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_ear_pod_r_22 = makeAttachmentEndpoint(attachment_ear_pod_r_22);
  const node_ear_pod_r_22 = new THREE.Group();
  node_ear_pod_r_22.name = "Ear pod R__pivot";
  node_ear_pod_r_22.scale.set(1, 1, 1);
  if (endpoint_ear_pod_r_22) {
    node_ear_pod_r_22.position.copy(endpoint_ear_pod_r_22.start);
    node_ear_pod_r_22.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_ear_pod_r_22.position.set(-0.11024, 0.12598, 0.0);
    node_ear_pod_r_22.rotation.set(0.0, 0.0, 0.0);
  }
  node_ear_pod_r_22.userData.sculptComponent = { id: "ear-pod-r" };
  node_ear_pod_r_22.userData.actionProfile = {};
  (nodes["head"] ?? root).add(node_ear_pod_r_22);
  nodes["ear-pod-r"] = node_ear_pod_r_22;
  const mesh_ear_pod_r_22Geometry = endpoint_ear_pod_r_22
    ? new THREE.CylinderGeometry(endpoint_ear_pod_r_22.endRadius, endpoint_ear_pod_r_22.baseRadius, endpoint_ear_pod_r_22.length, 8, 4)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 10, 4);
  if (!endpoint_ear_pod_r_22) {
    mesh_ear_pod_r_22Geometry.scale(0.06299, 0.03465, 0.06299);
  }
  const mesh_ear_pod_r_22 = new THREE.Mesh(
    mesh_ear_pod_r_22Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ear_pod_r_22.name = "Ear pod R";
  if (endpoint_ear_pod_r_22) {
    mesh_ear_pod_r_22.position.copy(endpoint_ear_pod_r_22.midpoint);
    mesh_ear_pod_r_22.quaternion.copy(endpoint_ear_pod_r_22.quaternion);
  }
  mesh_ear_pod_r_22.castShadow = options.castShadow ?? true;
  mesh_ear_pod_r_22.receiveShadow = options.receiveShadow ?? true;
  mesh_ear_pod_r_22.userData.sculptComponent = { id: "ear-pod-r" };
  node_ear_pod_r_22.add(mesh_ear_pod_r_22);
  meshes["ear-pod-r"] = mesh_ear_pod_r_22;
  colliders["ear-pod-r"] = {};
  destructionGroups["head"] ??= [];
  destructionGroups["head"].push(node_ear_pod_r_22);

  const endpoint_ear_pod_ring_r_23 = makeAttachmentEndpoint(null);
  const node_ear_pod_ring_r_23 = new THREE.Group();
  node_ear_pod_ring_r_23.name = "Ear pod ring R__pivot";
  node_ear_pod_ring_r_23.scale.set(1, 1, 1);
  if (endpoint_ear_pod_ring_r_23) {
    node_ear_pod_ring_r_23.position.copy(endpoint_ear_pod_ring_r_23.start);
    node_ear_pod_ring_r_23.rotation.set(0.0, 1.5708, 0.0);
  } else {
    node_ear_pod_ring_r_23.position.set(-0.14646, 0.12598, 0.0);
    node_ear_pod_ring_r_23.rotation.set(0.0, 1.5708, 0.0);
  }
  node_ear_pod_ring_r_23.userData.sculptComponent = { id: "ear-pod-ring-r" };
  node_ear_pod_ring_r_23.userData.actionProfile = {};
  (nodes["head"] ?? root).add(node_ear_pod_ring_r_23);
  nodes["ear-pod-ring-r"] = node_ear_pod_ring_r_23;
  const mesh_ear_pod_ring_r_23Geometry = endpoint_ear_pod_ring_r_23
    ? new THREE.CylinderGeometry(endpoint_ear_pod_ring_r_23.endRadius, endpoint_ear_pod_ring_r_23.baseRadius, endpoint_ear_pod_ring_r_23.length, 8, 4)
    : new THREE.TorusGeometry(0.45, 0.09, 8, 16);
  if (!endpoint_ear_pod_ring_r_23) {
    mesh_ear_pod_ring_r_23Geometry.scale(0.06299, 0.06299, 0.06299);
  }
  const mesh_ear_pod_ring_r_23 = new THREE.Mesh(
    mesh_ear_pod_ring_r_23Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ear_pod_ring_r_23.name = "Ear pod ring R";
  if (endpoint_ear_pod_ring_r_23) {
    mesh_ear_pod_ring_r_23.position.copy(endpoint_ear_pod_ring_r_23.midpoint);
    mesh_ear_pod_ring_r_23.quaternion.copy(endpoint_ear_pod_ring_r_23.quaternion);
  }
  mesh_ear_pod_ring_r_23.castShadow = options.castShadow ?? true;
  mesh_ear_pod_ring_r_23.receiveShadow = options.receiveShadow ?? true;
  mesh_ear_pod_ring_r_23.userData.sculptComponent = { id: "ear-pod-ring-r" };
  node_ear_pod_ring_r_23.add(mesh_ear_pod_ring_r_23);
  meshes["ear-pod-ring-r"] = mesh_ear_pod_ring_r_23;
  colliders["ear-pod-ring-r"] = {};
  destructionGroups["head"] ??= [];
  destructionGroups["head"].push(node_ear_pod_ring_r_23);

  const endpoint_pauldron_l_24 = makeAttachmentEndpoint(null);
  const node_pauldron_l_24 = new THREE.Group();
  node_pauldron_l_24.name = "Pauldron L__pivot";
  node_pauldron_l_24.scale.set(1, 1, 1);
  if (endpoint_pauldron_l_24) {
    node_pauldron_l_24.position.copy(endpoint_pauldron_l_24.start);
    node_pauldron_l_24.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_pauldron_l_24.position.set(0.18898, 0.30866, 0.0063);
    node_pauldron_l_24.rotation.set(0.0, 0.0, 0.0);
  }
  node_pauldron_l_24.userData.sculptComponent = { id: "pauldron-l" };
  node_pauldron_l_24.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_pauldron_l_24);
  nodes["pauldron-l"] = node_pauldron_l_24;
  const mesh_pauldron_l_24Geometry = endpoint_pauldron_l_24
    ? new THREE.CylinderGeometry(endpoint_pauldron_l_24.endRadius, endpoint_pauldron_l_24.baseRadius, endpoint_pauldron_l_24.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.04409, "rz": 0.0378, "twist": 0.0}, {"position": [0.0378, -0.05039, 0.0063], "rx": 0.06299, "rz": 0.05669, "twist": 0.0}, {"position": [0.05039, -0.13228, 0.0], "rx": 0.0252, "rz": 0.02205, "twist": 0.0}], "radialSegments": 20, "capEnds": true});
  if (!endpoint_pauldron_l_24) {
    mesh_pauldron_l_24Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_pauldron_l_24 = new THREE.Mesh(
    mesh_pauldron_l_24Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pauldron_l_24.name = "Pauldron L";
  if (endpoint_pauldron_l_24) {
    mesh_pauldron_l_24.position.copy(endpoint_pauldron_l_24.midpoint);
    mesh_pauldron_l_24.quaternion.copy(endpoint_pauldron_l_24.quaternion);
  }
  mesh_pauldron_l_24.castShadow = options.castShadow ?? true;
  mesh_pauldron_l_24.receiveShadow = options.receiveShadow ?? true;
  mesh_pauldron_l_24.userData.sculptComponent = { id: "pauldron-l" };
  node_pauldron_l_24.add(mesh_pauldron_l_24);
  meshes["pauldron-l"] = mesh_pauldron_l_24;
  colliders["pauldron-l"] = {};
  destructionGroups["shoulder-l"] ??= [];
  destructionGroups["shoulder-l"].push(node_pauldron_l_24);

  const endpoint_chest_shell_l_25 = makeAttachmentEndpoint(null);
  const node_chest_shell_l_25 = new THREE.Group();
  node_chest_shell_l_25.name = "Chest shell L__pivot";
  node_chest_shell_l_25.scale.set(1, 1, 1);
  if (endpoint_chest_shell_l_25) {
    node_chest_shell_l_25.position.copy(endpoint_chest_shell_l_25.start);
    node_chest_shell_l_25.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_chest_shell_l_25.position.set(0.10709, 0.30236, 0.04409);
    node_chest_shell_l_25.rotation.set(0.0, 0.0, 0.0);
  }
  node_chest_shell_l_25.userData.sculptComponent = { id: "chest-shell-l" };
  node_chest_shell_l_25.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_chest_shell_l_25);
  nodes["chest-shell-l"] = node_chest_shell_l_25;
  const mesh_chest_shell_l_25Geometry = endpoint_chest_shell_l_25
    ? new THREE.CylinderGeometry(endpoint_chest_shell_l_25.endRadius, endpoint_chest_shell_l_25.baseRadius, endpoint_chest_shell_l_25.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.0378, "rz": 0.05669, "twist": 0.0}, {"position": [-0.0189, -0.07874, 0.0252], "rx": 0.05039, "rz": 0.06929, "twist": 0.0}, {"position": [-0.04409, -0.19528, 0.0189], "rx": 0.0315, "rz": 0.04409, "twist": 0.0}, {"position": [-0.06929, -0.28346, 0.0063], "rx": 0.01575, "rz": 0.0126, "twist": 0.0}], "radialSegments": 20, "capEnds": true});
  if (!endpoint_chest_shell_l_25) {
    mesh_chest_shell_l_25Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_chest_shell_l_25 = new THREE.Mesh(
    mesh_chest_shell_l_25Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_chest_shell_l_25.name = "Chest shell L";
  if (endpoint_chest_shell_l_25) {
    mesh_chest_shell_l_25.position.copy(endpoint_chest_shell_l_25.midpoint);
    mesh_chest_shell_l_25.quaternion.copy(endpoint_chest_shell_l_25.quaternion);
  }
  mesh_chest_shell_l_25.castShadow = options.castShadow ?? true;
  mesh_chest_shell_l_25.receiveShadow = options.receiveShadow ?? true;
  mesh_chest_shell_l_25.userData.sculptComponent = { id: "chest-shell-l" };
  node_chest_shell_l_25.add(mesh_chest_shell_l_25);
  meshes["chest-shell-l"] = mesh_chest_shell_l_25;
  colliders["chest-shell-l"] = {};
  destructionGroups["torso"] ??= [];
  destructionGroups["torso"].push(node_chest_shell_l_25);

  const endpoint_chest_shell_back_l_26 = makeAttachmentEndpoint(null);
  const node_chest_shell_back_l_26 = new THREE.Group();
  node_chest_shell_back_l_26.name = "Back shell L (inferred)__pivot";
  node_chest_shell_back_l_26.scale.set(1, 1, 1);
  if (endpoint_chest_shell_back_l_26) {
    node_chest_shell_back_l_26.position.copy(endpoint_chest_shell_back_l_26.start);
    node_chest_shell_back_l_26.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_chest_shell_back_l_26.position.set(0.10709, 0.30236, -0.05669);
    node_chest_shell_back_l_26.rotation.set(0.0, 0.0, 0.0);
  }
  node_chest_shell_back_l_26.userData.sculptComponent = { id: "chest-shell-back-l" };
  node_chest_shell_back_l_26.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_chest_shell_back_l_26);
  nodes["chest-shell-back-l"] = node_chest_shell_back_l_26;
  const mesh_chest_shell_back_l_26Geometry = endpoint_chest_shell_back_l_26
    ? new THREE.CylinderGeometry(endpoint_chest_shell_back_l_26.endRadius, endpoint_chest_shell_back_l_26.baseRadius, endpoint_chest_shell_back_l_26.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.0378, "rz": 0.05669, "twist": 0.0}, {"position": [-0.0189, -0.07874, -0.0252], "rx": 0.05039, "rz": 0.06929, "twist": 0.0}, {"position": [-0.04409, -0.19528, -0.0189], "rx": 0.0315, "rz": 0.04409, "twist": 0.0}, {"position": [-0.06929, -0.28346, -0.0063], "rx": 0.01575, "rz": 0.0126, "twist": 0.0}], "radialSegments": 20, "capEnds": true});
  if (!endpoint_chest_shell_back_l_26) {
    mesh_chest_shell_back_l_26Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_chest_shell_back_l_26 = new THREE.Mesh(
    mesh_chest_shell_back_l_26Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_chest_shell_back_l_26.name = "Back shell L (inferred)";
  if (endpoint_chest_shell_back_l_26) {
    mesh_chest_shell_back_l_26.position.copy(endpoint_chest_shell_back_l_26.midpoint);
    mesh_chest_shell_back_l_26.quaternion.copy(endpoint_chest_shell_back_l_26.quaternion);
  }
  mesh_chest_shell_back_l_26.castShadow = options.castShadow ?? true;
  mesh_chest_shell_back_l_26.receiveShadow = options.receiveShadow ?? true;
  mesh_chest_shell_back_l_26.userData.sculptComponent = { id: "chest-shell-back-l" };
  node_chest_shell_back_l_26.add(mesh_chest_shell_back_l_26);
  meshes["chest-shell-back-l"] = mesh_chest_shell_back_l_26;
  colliders["chest-shell-back-l"] = {};
  destructionGroups["torso"] ??= [];
  destructionGroups["torso"].push(node_chest_shell_back_l_26);

  const endpoint_seam_chest_l_27 = makeAttachmentEndpoint(null);
  const node_seam_chest_l_27 = new THREE.Group();
  node_seam_chest_l_27.name = "Gold seam seam-chest-l__pivot";
  node_seam_chest_l_27.scale.set(1, 1, 1);
  if (endpoint_seam_chest_l_27) {
    node_seam_chest_l_27.position.copy(endpoint_seam_chest_l_27.start);
    node_seam_chest_l_27.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seam_chest_l_27.position.set(0.0, 0.0, 0.0);
    node_seam_chest_l_27.rotation.set(0.0, 0.0, 0.0);
  }
  node_seam_chest_l_27.userData.sculptComponent = { id: "seam-chest-l" };
  node_seam_chest_l_27.userData.actionProfile = {};
  (nodes["chest-shell-l"] ?? root).add(node_seam_chest_l_27);
  nodes["seam-chest-l"] = node_seam_chest_l_27;
  const mesh_seam_chest_l_27Geometry = endpoint_seam_chest_l_27
    ? new THREE.CylinderGeometry(endpoint_seam_chest_l_27.endRadius, endpoint_seam_chest_l_27.baseRadius, endpoint_seam_chest_l_27.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.05499, 0.0, 0.03402], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [-0.08611, -0.07874, 0.07055], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [-0.08687, -0.19528, 0.04724], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [-0.08151, -0.28346, 0.02047], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_seam_chest_l_27) {
    mesh_seam_chest_l_27Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seam_chest_l_27 = new THREE.Mesh(
    mesh_seam_chest_l_27Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seam_chest_l_27.name = "Gold seam seam-chest-l";
  if (endpoint_seam_chest_l_27) {
    mesh_seam_chest_l_27.position.copy(endpoint_seam_chest_l_27.midpoint);
    mesh_seam_chest_l_27.quaternion.copy(endpoint_seam_chest_l_27.quaternion);
  }
  mesh_seam_chest_l_27.castShadow = options.castShadow ?? true;
  mesh_seam_chest_l_27.receiveShadow = options.receiveShadow ?? true;
  mesh_seam_chest_l_27.userData.sculptComponent = { id: "seam-chest-l" };
  node_seam_chest_l_27.add(mesh_seam_chest_l_27);
  meshes["seam-chest-l"] = mesh_seam_chest_l_27;
  colliders["seam-chest-l"] = {};
  destructionGroups["chest-shell-l"] ??= [];
  destructionGroups["chest-shell-l"].push(node_seam_chest_l_27);

  const endpoint_seam_pauldron_l_28 = makeAttachmentEndpoint(null);
  const node_seam_pauldron_l_28 = new THREE.Group();
  node_seam_pauldron_l_28.name = "Gold seam seam-pauldron-l__pivot";
  node_seam_pauldron_l_28.scale.set(1, 1, 1);
  if (endpoint_seam_pauldron_l_28) {
    node_seam_pauldron_l_28.position.copy(endpoint_seam_pauldron_l_28.start);
    node_seam_pauldron_l_28.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seam_pauldron_l_28.position.set(0.0, 0.0, 0.0);
    node_seam_pauldron_l_28.rotation.set(0.0, 0.0, 0.0);
  }
  node_seam_pauldron_l_28.userData.sculptComponent = { id: "seam-pauldron-l" };
  node_seam_pauldron_l_28.userData.actionProfile = {};
  (nodes["pauldron-l"] ?? root).add(node_seam_pauldron_l_28);
  nodes["seam-pauldron-l"] = node_seam_pauldron_l_28;
  const mesh_seam_pauldron_l_28Geometry = endpoint_seam_pauldron_l_28
    ? new THREE.CylinderGeometry(endpoint_seam_pauldron_l_28.endRadius, endpoint_seam_pauldron_l_28.baseRadius, endpoint_seam_pauldron_l_28.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.03666, 0.0, 0.01323], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [0.09279, -0.05039, 0.0252], "rx": 0.00567, "rz": 0.00567, "twist": 0.0}, {"position": [0.07178, -0.13228, 0.00756], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_seam_pauldron_l_28) {
    mesh_seam_pauldron_l_28Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seam_pauldron_l_28 = new THREE.Mesh(
    mesh_seam_pauldron_l_28Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seam_pauldron_l_28.name = "Gold seam seam-pauldron-l";
  if (endpoint_seam_pauldron_l_28) {
    mesh_seam_pauldron_l_28.position.copy(endpoint_seam_pauldron_l_28.midpoint);
    mesh_seam_pauldron_l_28.quaternion.copy(endpoint_seam_pauldron_l_28.quaternion);
  }
  mesh_seam_pauldron_l_28.castShadow = options.castShadow ?? true;
  mesh_seam_pauldron_l_28.receiveShadow = options.receiveShadow ?? true;
  mesh_seam_pauldron_l_28.userData.sculptComponent = { id: "seam-pauldron-l" };
  node_seam_pauldron_l_28.add(mesh_seam_pauldron_l_28);
  meshes["seam-pauldron-l"] = mesh_seam_pauldron_l_28;
  colliders["seam-pauldron-l"] = {};
  destructionGroups["pauldron-l"] ??= [];
  destructionGroups["pauldron-l"].push(node_seam_pauldron_l_28);

  const endpoint_pauldron_r_29 = makeAttachmentEndpoint(null);
  const node_pauldron_r_29 = new THREE.Group();
  node_pauldron_r_29.name = "Pauldron R__pivot";
  node_pauldron_r_29.scale.set(1, 1, 1);
  if (endpoint_pauldron_r_29) {
    node_pauldron_r_29.position.copy(endpoint_pauldron_r_29.start);
    node_pauldron_r_29.rotation.set(0.0, -0.0, 0.0);
  } else {
    node_pauldron_r_29.position.set(-0.18898, 0.30866, 0.0063);
    node_pauldron_r_29.rotation.set(0.0, -0.0, 0.0);
  }
  node_pauldron_r_29.userData.sculptComponent = { id: "pauldron-r" };
  node_pauldron_r_29.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_pauldron_r_29);
  nodes["pauldron-r"] = node_pauldron_r_29;
  const mesh_pauldron_r_29Geometry = endpoint_pauldron_r_29
    ? new THREE.CylinderGeometry(endpoint_pauldron_r_29.endRadius, endpoint_pauldron_r_29.baseRadius, endpoint_pauldron_r_29.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.04409, "rz": 0.0378, "twist": 0.0}, {"position": [-0.0378, -0.05039, 0.0063], "rx": 0.06299, "rz": 0.05669, "twist": 0.0}, {"position": [-0.05039, -0.13228, 0.0], "rx": 0.0252, "rz": 0.02205, "twist": 0.0}], "radialSegments": 20, "capEnds": true});
  if (!endpoint_pauldron_r_29) {
    mesh_pauldron_r_29Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_pauldron_r_29 = new THREE.Mesh(
    mesh_pauldron_r_29Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pauldron_r_29.name = "Pauldron R";
  if (endpoint_pauldron_r_29) {
    mesh_pauldron_r_29.position.copy(endpoint_pauldron_r_29.midpoint);
    mesh_pauldron_r_29.quaternion.copy(endpoint_pauldron_r_29.quaternion);
  }
  mesh_pauldron_r_29.castShadow = options.castShadow ?? true;
  mesh_pauldron_r_29.receiveShadow = options.receiveShadow ?? true;
  mesh_pauldron_r_29.userData.sculptComponent = { id: "pauldron-r" };
  node_pauldron_r_29.add(mesh_pauldron_r_29);
  meshes["pauldron-r"] = mesh_pauldron_r_29;
  colliders["pauldron-r"] = {};
  destructionGroups["shoulder-r"] ??= [];
  destructionGroups["shoulder-r"].push(node_pauldron_r_29);

  const endpoint_chest_shell_r_30 = makeAttachmentEndpoint(null);
  const node_chest_shell_r_30 = new THREE.Group();
  node_chest_shell_r_30.name = "Chest shell R__pivot";
  node_chest_shell_r_30.scale.set(1, 1, 1);
  if (endpoint_chest_shell_r_30) {
    node_chest_shell_r_30.position.copy(endpoint_chest_shell_r_30.start);
    node_chest_shell_r_30.rotation.set(0.0, -0.0, 0.0);
  } else {
    node_chest_shell_r_30.position.set(-0.10709, 0.30236, 0.04409);
    node_chest_shell_r_30.rotation.set(0.0, -0.0, 0.0);
  }
  node_chest_shell_r_30.userData.sculptComponent = { id: "chest-shell-r" };
  node_chest_shell_r_30.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_chest_shell_r_30);
  nodes["chest-shell-r"] = node_chest_shell_r_30;
  const mesh_chest_shell_r_30Geometry = endpoint_chest_shell_r_30
    ? new THREE.CylinderGeometry(endpoint_chest_shell_r_30.endRadius, endpoint_chest_shell_r_30.baseRadius, endpoint_chest_shell_r_30.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.0378, "rz": 0.05669, "twist": 0.0}, {"position": [0.0189, -0.07874, 0.0252], "rx": 0.05039, "rz": 0.06929, "twist": 0.0}, {"position": [0.04409, -0.19528, 0.0189], "rx": 0.0315, "rz": 0.04409, "twist": 0.0}, {"position": [0.06929, -0.28346, 0.0063], "rx": 0.01575, "rz": 0.0126, "twist": 0.0}], "radialSegments": 20, "capEnds": true});
  if (!endpoint_chest_shell_r_30) {
    mesh_chest_shell_r_30Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_chest_shell_r_30 = new THREE.Mesh(
    mesh_chest_shell_r_30Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_chest_shell_r_30.name = "Chest shell R";
  if (endpoint_chest_shell_r_30) {
    mesh_chest_shell_r_30.position.copy(endpoint_chest_shell_r_30.midpoint);
    mesh_chest_shell_r_30.quaternion.copy(endpoint_chest_shell_r_30.quaternion);
  }
  mesh_chest_shell_r_30.castShadow = options.castShadow ?? true;
  mesh_chest_shell_r_30.receiveShadow = options.receiveShadow ?? true;
  mesh_chest_shell_r_30.userData.sculptComponent = { id: "chest-shell-r" };
  node_chest_shell_r_30.add(mesh_chest_shell_r_30);
  meshes["chest-shell-r"] = mesh_chest_shell_r_30;
  colliders["chest-shell-r"] = {};
  destructionGroups["torso"] ??= [];
  destructionGroups["torso"].push(node_chest_shell_r_30);

  const endpoint_chest_shell_back_r_31 = makeAttachmentEndpoint(null);
  const node_chest_shell_back_r_31 = new THREE.Group();
  node_chest_shell_back_r_31.name = "Back shell R (inferred)__pivot";
  node_chest_shell_back_r_31.scale.set(1, 1, 1);
  if (endpoint_chest_shell_back_r_31) {
    node_chest_shell_back_r_31.position.copy(endpoint_chest_shell_back_r_31.start);
    node_chest_shell_back_r_31.rotation.set(0.0, -0.0, 0.0);
  } else {
    node_chest_shell_back_r_31.position.set(-0.10709, 0.30236, -0.05669);
    node_chest_shell_back_r_31.rotation.set(0.0, -0.0, 0.0);
  }
  node_chest_shell_back_r_31.userData.sculptComponent = { id: "chest-shell-back-r" };
  node_chest_shell_back_r_31.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_chest_shell_back_r_31);
  nodes["chest-shell-back-r"] = node_chest_shell_back_r_31;
  const mesh_chest_shell_back_r_31Geometry = endpoint_chest_shell_back_r_31
    ? new THREE.CylinderGeometry(endpoint_chest_shell_back_r_31.endRadius, endpoint_chest_shell_back_r_31.baseRadius, endpoint_chest_shell_back_r_31.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.0378, "rz": 0.05669, "twist": 0.0}, {"position": [0.0189, -0.07874, -0.0252], "rx": 0.05039, "rz": 0.06929, "twist": 0.0}, {"position": [0.04409, -0.19528, -0.0189], "rx": 0.0315, "rz": 0.04409, "twist": 0.0}, {"position": [0.06929, -0.28346, -0.0063], "rx": 0.01575, "rz": 0.0126, "twist": 0.0}], "radialSegments": 20, "capEnds": true});
  if (!endpoint_chest_shell_back_r_31) {
    mesh_chest_shell_back_r_31Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_chest_shell_back_r_31 = new THREE.Mesh(
    mesh_chest_shell_back_r_31Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_chest_shell_back_r_31.name = "Back shell R (inferred)";
  if (endpoint_chest_shell_back_r_31) {
    mesh_chest_shell_back_r_31.position.copy(endpoint_chest_shell_back_r_31.midpoint);
    mesh_chest_shell_back_r_31.quaternion.copy(endpoint_chest_shell_back_r_31.quaternion);
  }
  mesh_chest_shell_back_r_31.castShadow = options.castShadow ?? true;
  mesh_chest_shell_back_r_31.receiveShadow = options.receiveShadow ?? true;
  mesh_chest_shell_back_r_31.userData.sculptComponent = { id: "chest-shell-back-r" };
  node_chest_shell_back_r_31.add(mesh_chest_shell_back_r_31);
  meshes["chest-shell-back-r"] = mesh_chest_shell_back_r_31;
  colliders["chest-shell-back-r"] = {};
  destructionGroups["torso"] ??= [];
  destructionGroups["torso"].push(node_chest_shell_back_r_31);

  const endpoint_seam_chest_r_32 = makeAttachmentEndpoint(null);
  const node_seam_chest_r_32 = new THREE.Group();
  node_seam_chest_r_32.name = "Gold seam seam-chest-r__pivot";
  node_seam_chest_r_32.scale.set(1, 1, 1);
  if (endpoint_seam_chest_r_32) {
    node_seam_chest_r_32.position.copy(endpoint_seam_chest_r_32.start);
    node_seam_chest_r_32.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seam_chest_r_32.position.set(0.0, 0.0, 0.0);
    node_seam_chest_r_32.rotation.set(0.0, 0.0, 0.0);
  }
  node_seam_chest_r_32.userData.sculptComponent = { id: "seam-chest-r" };
  node_seam_chest_r_32.userData.actionProfile = {};
  (nodes["chest-shell-r"] ?? root).add(node_seam_chest_r_32);
  nodes["seam-chest-r"] = node_seam_chest_r_32;
  const mesh_seam_chest_r_32Geometry = endpoint_seam_chest_r_32
    ? new THREE.CylinderGeometry(endpoint_seam_chest_r_32.endRadius, endpoint_seam_chest_r_32.baseRadius, endpoint_seam_chest_r_32.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.05499, 0.0, 0.03402], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [0.08611, -0.07874, 0.07055], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [0.08687, -0.19528, 0.04724], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [0.08151, -0.28346, 0.02047], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_seam_chest_r_32) {
    mesh_seam_chest_r_32Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seam_chest_r_32 = new THREE.Mesh(
    mesh_seam_chest_r_32Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seam_chest_r_32.name = "Gold seam seam-chest-r";
  if (endpoint_seam_chest_r_32) {
    mesh_seam_chest_r_32.position.copy(endpoint_seam_chest_r_32.midpoint);
    mesh_seam_chest_r_32.quaternion.copy(endpoint_seam_chest_r_32.quaternion);
  }
  mesh_seam_chest_r_32.castShadow = options.castShadow ?? true;
  mesh_seam_chest_r_32.receiveShadow = options.receiveShadow ?? true;
  mesh_seam_chest_r_32.userData.sculptComponent = { id: "seam-chest-r" };
  node_seam_chest_r_32.add(mesh_seam_chest_r_32);
  meshes["seam-chest-r"] = mesh_seam_chest_r_32;
  colliders["seam-chest-r"] = {};
  destructionGroups["chest-shell-r"] ??= [];
  destructionGroups["chest-shell-r"].push(node_seam_chest_r_32);

  const endpoint_seam_pauldron_r_33 = makeAttachmentEndpoint(null);
  const node_seam_pauldron_r_33 = new THREE.Group();
  node_seam_pauldron_r_33.name = "Gold seam seam-pauldron-r__pivot";
  node_seam_pauldron_r_33.scale.set(1, 1, 1);
  if (endpoint_seam_pauldron_r_33) {
    node_seam_pauldron_r_33.position.copy(endpoint_seam_pauldron_r_33.start);
    node_seam_pauldron_r_33.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seam_pauldron_r_33.position.set(0.0, 0.0, 0.0);
    node_seam_pauldron_r_33.rotation.set(0.0, 0.0, 0.0);
  }
  node_seam_pauldron_r_33.userData.sculptComponent = { id: "seam-pauldron-r" };
  node_seam_pauldron_r_33.userData.actionProfile = {};
  (nodes["pauldron-r"] ?? root).add(node_seam_pauldron_r_33);
  nodes["seam-pauldron-r"] = node_seam_pauldron_r_33;
  const mesh_seam_pauldron_r_33Geometry = endpoint_seam_pauldron_r_33
    ? new THREE.CylinderGeometry(endpoint_seam_pauldron_r_33.endRadius, endpoint_seam_pauldron_r_33.baseRadius, endpoint_seam_pauldron_r_33.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.03666, 0.0, 0.01323], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [-0.09279, -0.05039, 0.0252], "rx": 0.00567, "rz": 0.00567, "twist": 0.0}, {"position": [-0.07178, -0.13228, 0.00756], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_seam_pauldron_r_33) {
    mesh_seam_pauldron_r_33Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seam_pauldron_r_33 = new THREE.Mesh(
    mesh_seam_pauldron_r_33Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seam_pauldron_r_33.name = "Gold seam seam-pauldron-r";
  if (endpoint_seam_pauldron_r_33) {
    mesh_seam_pauldron_r_33.position.copy(endpoint_seam_pauldron_r_33.midpoint);
    mesh_seam_pauldron_r_33.quaternion.copy(endpoint_seam_pauldron_r_33.quaternion);
  }
  mesh_seam_pauldron_r_33.castShadow = options.castShadow ?? true;
  mesh_seam_pauldron_r_33.receiveShadow = options.receiveShadow ?? true;
  mesh_seam_pauldron_r_33.userData.sculptComponent = { id: "seam-pauldron-r" };
  node_seam_pauldron_r_33.add(mesh_seam_pauldron_r_33);
  meshes["seam-pauldron-r"] = mesh_seam_pauldron_r_33;
  colliders["seam-pauldron-r"] = {};
  destructionGroups["pauldron-r"] ??= [];
  destructionGroups["pauldron-r"].push(node_seam_pauldron_r_33);

  const attachment_emblem_disc_34 = {"parentSocket": "chest-emblem-disc", "localStart": [0.0315, 0.22677, 0.11181], "localEnd": [0.0315, 0.22677, 0.12756], "contactType": "rigid-weld", "baseRadius": 0.05354, "endRadius": 0.05354, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_emblem_disc_34 = makeAttachmentEndpoint(attachment_emblem_disc_34);
  const node_emblem_disc_34 = new THREE.Group();
  node_emblem_disc_34.name = "Emblem disc__pivot";
  node_emblem_disc_34.scale.set(1, 1, 1);
  if (endpoint_emblem_disc_34) {
    node_emblem_disc_34.position.copy(endpoint_emblem_disc_34.start);
    node_emblem_disc_34.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_emblem_disc_34.position.set(0.0315, 0.22677, 0.11181);
    node_emblem_disc_34.rotation.set(0.0, 0.0, 0.0);
  }
  node_emblem_disc_34.userData.sculptComponent = { id: "emblem-disc" };
  node_emblem_disc_34.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_emblem_disc_34);
  nodes["emblem-disc"] = node_emblem_disc_34;
  const mesh_emblem_disc_34Geometry = endpoint_emblem_disc_34
    ? new THREE.CylinderGeometry(endpoint_emblem_disc_34.endRadius, endpoint_emblem_disc_34.baseRadius, endpoint_emblem_disc_34.length, 8, 4)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 10, 4);
  if (!endpoint_emblem_disc_34) {
    mesh_emblem_disc_34Geometry.scale(0.10709, 0.01575, 0.10709);
  }
  const mesh_emblem_disc_34 = new THREE.Mesh(
    mesh_emblem_disc_34Geometry,
    materialMap["emblem-disc-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_emblem_disc_34.name = "Emblem disc";
  if (endpoint_emblem_disc_34) {
    mesh_emblem_disc_34.position.copy(endpoint_emblem_disc_34.midpoint);
    mesh_emblem_disc_34.quaternion.copy(endpoint_emblem_disc_34.quaternion);
  }
  mesh_emblem_disc_34.castShadow = options.castShadow ?? true;
  mesh_emblem_disc_34.receiveShadow = options.receiveShadow ?? true;
  mesh_emblem_disc_34.userData.sculptComponent = { id: "emblem-disc" };
  node_emblem_disc_34.add(mesh_emblem_disc_34);
  meshes["emblem-disc"] = mesh_emblem_disc_34;
  colliders["emblem-disc"] = {};
  destructionGroups["torso"] ??= [];
  destructionGroups["torso"].push(node_emblem_disc_34);

  const endpoint_emblem_ring_35 = makeAttachmentEndpoint(null);
  const node_emblem_ring_35 = new THREE.Group();
  node_emblem_ring_35.name = "Emblem ring__pivot";
  node_emblem_ring_35.scale.set(1, 1, 1);
  if (endpoint_emblem_ring_35) {
    node_emblem_ring_35.position.copy(endpoint_emblem_ring_35.start);
    node_emblem_ring_35.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_emblem_ring_35.position.set(0.0315, 0.22677, 0.12756);
    node_emblem_ring_35.rotation.set(0.0, 0.0, 0.0);
  }
  node_emblem_ring_35.userData.sculptComponent = { id: "emblem-ring" };
  node_emblem_ring_35.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_emblem_ring_35);
  nodes["emblem-ring"] = node_emblem_ring_35;
  const mesh_emblem_ring_35Geometry = endpoint_emblem_ring_35
    ? new THREE.CylinderGeometry(endpoint_emblem_ring_35.endRadius, endpoint_emblem_ring_35.baseRadius, endpoint_emblem_ring_35.length, 8, 4)
    : new THREE.TorusGeometry(0.45, 0.0675, 8, 16);
  if (!endpoint_emblem_ring_35) {
    mesh_emblem_ring_35Geometry.scale(0.11199, 0.11199, 0.11199);
  }
  const mesh_emblem_ring_35 = new THREE.Mesh(
    mesh_emblem_ring_35Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_emblem_ring_35.name = "Emblem ring";
  if (endpoint_emblem_ring_35) {
    mesh_emblem_ring_35.position.copy(endpoint_emblem_ring_35.midpoint);
    mesh_emblem_ring_35.quaternion.copy(endpoint_emblem_ring_35.quaternion);
  }
  mesh_emblem_ring_35.castShadow = options.castShadow ?? true;
  mesh_emblem_ring_35.receiveShadow = options.receiveShadow ?? true;
  mesh_emblem_ring_35.userData.sculptComponent = { id: "emblem-ring" };
  node_emblem_ring_35.add(mesh_emblem_ring_35);
  meshes["emblem-ring"] = mesh_emblem_ring_35;
  colliders["emblem-ring"] = {};
  destructionGroups["torso"] ??= [];
  destructionGroups["torso"].push(node_emblem_ring_35);

  const endpoint_emblem_letter_a_36 = makeAttachmentEndpoint(null);
  const node_emblem_letter_a_36 = new THREE.Group();
  node_emblem_letter_a_36.name = "Emblem letter A__pivot";
  node_emblem_letter_a_36.scale.set(1, 1, 1);
  if (endpoint_emblem_letter_a_36) {
    node_emblem_letter_a_36.position.copy(endpoint_emblem_letter_a_36.start);
    node_emblem_letter_a_36.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_emblem_letter_a_36.position.set(0.01933, 0.22677, 0.13071);
    node_emblem_letter_a_36.rotation.set(0.0, 0.0, 0.0);
  }
  node_emblem_letter_a_36.userData.sculptComponent = { id: "emblem-letter-a" };
  node_emblem_letter_a_36.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_emblem_letter_a_36);
  nodes["emblem-letter-a"] = node_emblem_letter_a_36;
  const mesh_emblem_letter_a_36Geometry = endpoint_emblem_letter_a_36
    ? new THREE.CylinderGeometry(endpoint_emblem_letter_a_36.endRadius, endpoint_emblem_letter_a_36.baseRadius, endpoint_emblem_letter_a_36.length, 8, 4)
    : buildExtrudeGeometry({"points": [[-0.01558, -0.01947], [-0.00779, -0.01947], [-0.00545, -0.01071], [0.00545, -0.01071], [0.00779, -0.01947], [0.01558, -0.01947], [0.00545, 0.01947], [-0.00545, 0.01947]], "holes": [[[-0.0035, 0.00097], [0.0035, 0.00097], [0.0, 0.01168]]], "depth": 0.00945});
  if (!endpoint_emblem_letter_a_36) {
    mesh_emblem_letter_a_36Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_emblem_letter_a_36 = new THREE.Mesh(
    mesh_emblem_letter_a_36Geometry,
    materialMap["emblem-white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_emblem_letter_a_36.name = "Emblem letter A";
  if (endpoint_emblem_letter_a_36) {
    mesh_emblem_letter_a_36.position.copy(endpoint_emblem_letter_a_36.midpoint);
    mesh_emblem_letter_a_36.quaternion.copy(endpoint_emblem_letter_a_36.quaternion);
  }
  mesh_emblem_letter_a_36.castShadow = options.castShadow ?? true;
  mesh_emblem_letter_a_36.receiveShadow = options.receiveShadow ?? true;
  mesh_emblem_letter_a_36.userData.sculptComponent = { id: "emblem-letter-a" };
  node_emblem_letter_a_36.add(mesh_emblem_letter_a_36);
  meshes["emblem-letter-a"] = mesh_emblem_letter_a_36;
  colliders["emblem-letter-a"] = {};
  destructionGroups["torso"] ??= [];
  destructionGroups["torso"].push(node_emblem_letter_a_36);

  const endpoint_emblem_letter_i_37 = makeAttachmentEndpoint(null);
  const node_emblem_letter_i_37 = new THREE.Group();
  node_emblem_letter_i_37.name = "Emblem letter I__pivot";
  node_emblem_letter_i_37.scale.set(1, 1, 1);
  if (endpoint_emblem_letter_i_37) {
    node_emblem_letter_i_37.position.copy(endpoint_emblem_letter_i_37.start);
    node_emblem_letter_i_37.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_emblem_letter_i_37.position.set(0.05097, 0.22677, 0.13071);
    node_emblem_letter_i_37.rotation.set(0.0, 0.0, 0.0);
  }
  node_emblem_letter_i_37.userData.sculptComponent = { id: "emblem-letter-i" };
  node_emblem_letter_i_37.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_emblem_letter_i_37);
  nodes["emblem-letter-i"] = node_emblem_letter_i_37;
  const mesh_emblem_letter_i_37Geometry = endpoint_emblem_letter_i_37
    ? new THREE.CylinderGeometry(endpoint_emblem_letter_i_37.endRadius, endpoint_emblem_letter_i_37.baseRadius, endpoint_emblem_letter_i_37.length, 8, 4)
    : buildExtrudeGeometry({"points": [[-0.00389, -0.01947], [0.00389, -0.01947], [0.00389, 0.01947], [-0.00389, 0.01947]], "depth": 0.00945});
  if (!endpoint_emblem_letter_i_37) {
    mesh_emblem_letter_i_37Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_emblem_letter_i_37 = new THREE.Mesh(
    mesh_emblem_letter_i_37Geometry,
    materialMap["emblem-white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_emblem_letter_i_37.name = "Emblem letter I";
  if (endpoint_emblem_letter_i_37) {
    mesh_emblem_letter_i_37.position.copy(endpoint_emblem_letter_i_37.midpoint);
    mesh_emblem_letter_i_37.quaternion.copy(endpoint_emblem_letter_i_37.quaternion);
  }
  mesh_emblem_letter_i_37.castShadow = options.castShadow ?? true;
  mesh_emblem_letter_i_37.receiveShadow = options.receiveShadow ?? true;
  mesh_emblem_letter_i_37.userData.sculptComponent = { id: "emblem-letter-i" };
  node_emblem_letter_i_37.add(mesh_emblem_letter_i_37);
  meshes["emblem-letter-i"] = mesh_emblem_letter_i_37;
  colliders["emblem-letter-i"] = {};
  destructionGroups["torso"] ??= [];
  destructionGroups["torso"].push(node_emblem_letter_i_37);

  const endpoint_reach_joint_A1_0_38 = makeAttachmentEndpoint(null);
  const node_reach_joint_A1_0_38 = new THREE.Group();
  node_reach_joint_A1_0_38.name = "Reach joint A1 0__pivot";
  node_reach_joint_A1_0_38.scale.set(1, 1, 1);
  if (endpoint_reach_joint_A1_0_38) {
    node_reach_joint_A1_0_38.position.copy(endpoint_reach_joint_A1_0_38.start);
    node_reach_joint_A1_0_38.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_reach_joint_A1_0_38.position.set(-0.18898, 0.28661, 0.0252);
    node_reach_joint_A1_0_38.rotation.set(0.0, 0.0, 0.0);
  }
  node_reach_joint_A1_0_38.userData.sculptComponent = { id: "reach-joint-A1-0" };
  node_reach_joint_A1_0_38.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_reach_joint_A1_0_38);
  nodes["reach-joint-A1-0"] = node_reach_joint_A1_0_38;
  const mesh_reach_joint_A1_0_38Geometry = endpoint_reach_joint_A1_0_38
    ? new THREE.CylinderGeometry(endpoint_reach_joint_A1_0_38.endRadius, endpoint_reach_joint_A1_0_38.baseRadius, endpoint_reach_joint_A1_0_38.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_reach_joint_A1_0_38) {
    mesh_reach_joint_A1_0_38Geometry.scale(0.05669, 0.05669, 0.05669);
  }
  const mesh_reach_joint_A1_0_38 = new THREE.Mesh(
    mesh_reach_joint_A1_0_38Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_joint_A1_0_38.name = "Reach joint A1 0";
  if (endpoint_reach_joint_A1_0_38) {
    mesh_reach_joint_A1_0_38.position.copy(endpoint_reach_joint_A1_0_38.midpoint);
    mesh_reach_joint_A1_0_38.quaternion.copy(endpoint_reach_joint_A1_0_38.quaternion);
  }
  mesh_reach_joint_A1_0_38.castShadow = options.castShadow ?? true;
  mesh_reach_joint_A1_0_38.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_joint_A1_0_38.userData.sculptComponent = { id: "reach-joint-A1-0" };
  node_reach_joint_A1_0_38.add(mesh_reach_joint_A1_0_38);
  meshes["reach-joint-A1-0"] = mesh_reach_joint_A1_0_38;
  colliders["reach-joint-A1-0"] = {};
  destructionGroups["reach-A1"] ??= [];
  destructionGroups["reach-A1"].push(node_reach_joint_A1_0_38);

  const attachment_reach_rod_A1_0_39 = {"parentSocket": "chest-reach-rod-A1-0", "localStart": [-0.18898, 0.28661, 0.0252], "localEnd": [-0.28976, 0.42835, 0.06929], "contactType": "hinge-joint", "baseRadius": 0.02362, "endRadius": 0.0189, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_reach_rod_A1_0_39 = makeAttachmentEndpoint(attachment_reach_rod_A1_0_39);
  const node_reach_rod_A1_0_39 = new THREE.Group();
  node_reach_rod_A1_0_39.name = "Reach rod A1 0__pivot";
  node_reach_rod_A1_0_39.scale.set(1, 1, 1);
  if (endpoint_reach_rod_A1_0_39) {
    node_reach_rod_A1_0_39.position.copy(endpoint_reach_rod_A1_0_39.start);
    node_reach_rod_A1_0_39.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_reach_rod_A1_0_39.position.set(-0.18898, 0.28661, 0.0252);
    node_reach_rod_A1_0_39.rotation.set(0.0, 0.0, 0.0);
  }
  node_reach_rod_A1_0_39.userData.sculptComponent = { id: "reach-rod-A1-0" };
  node_reach_rod_A1_0_39.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_reach_rod_A1_0_39);
  nodes["reach-rod-A1-0"] = node_reach_rod_A1_0_39;
  const mesh_reach_rod_A1_0_39Geometry = endpoint_reach_rod_A1_0_39
    ? new THREE.CylinderGeometry(endpoint_reach_rod_A1_0_39.endRadius, endpoint_reach_rod_A1_0_39.baseRadius, endpoint_reach_rod_A1_0_39.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_reach_rod_A1_0_39) {
    mesh_reach_rod_A1_0_39Geometry.scale(0.04724, 0.17942, 0.04724);
  }
  const mesh_reach_rod_A1_0_39 = new THREE.Mesh(
    mesh_reach_rod_A1_0_39Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_rod_A1_0_39.name = "Reach rod A1 0";
  if (endpoint_reach_rod_A1_0_39) {
    mesh_reach_rod_A1_0_39.position.copy(endpoint_reach_rod_A1_0_39.midpoint);
    mesh_reach_rod_A1_0_39.quaternion.copy(endpoint_reach_rod_A1_0_39.quaternion);
  }
  mesh_reach_rod_A1_0_39.castShadow = options.castShadow ?? true;
  mesh_reach_rod_A1_0_39.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_rod_A1_0_39.userData.sculptComponent = { id: "reach-rod-A1-0" };
  node_reach_rod_A1_0_39.add(mesh_reach_rod_A1_0_39);
  meshes["reach-rod-A1-0"] = mesh_reach_rod_A1_0_39;
  colliders["reach-rod-A1-0"] = {};
  destructionGroups["reach-A1"] ??= [];
  destructionGroups["reach-A1"].push(node_reach_rod_A1_0_39);

  const endpoint_reach_joint_A1_1_40 = makeAttachmentEndpoint(null);
  const node_reach_joint_A1_1_40 = new THREE.Group();
  node_reach_joint_A1_1_40.name = "Reach joint A1 1__pivot";
  node_reach_joint_A1_1_40.scale.set(1, 1, 1);
  if (endpoint_reach_joint_A1_1_40) {
    node_reach_joint_A1_1_40.position.copy(endpoint_reach_joint_A1_1_40.start);
    node_reach_joint_A1_1_40.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_reach_joint_A1_1_40.position.set(-0.10079, 0.14173, 0.04409);
    node_reach_joint_A1_1_40.rotation.set(0.0, 0.0, 0.0);
  }
  node_reach_joint_A1_1_40.userData.sculptComponent = { id: "reach-joint-A1-1" };
  node_reach_joint_A1_1_40.userData.actionProfile = {};
  (nodes["reach-rod-A1-0"] ?? root).add(node_reach_joint_A1_1_40);
  nodes["reach-joint-A1-1"] = node_reach_joint_A1_1_40;
  const mesh_reach_joint_A1_1_40Geometry = endpoint_reach_joint_A1_1_40
    ? new THREE.CylinderGeometry(endpoint_reach_joint_A1_1_40.endRadius, endpoint_reach_joint_A1_1_40.baseRadius, endpoint_reach_joint_A1_1_40.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_reach_joint_A1_1_40) {
    mesh_reach_joint_A1_1_40Geometry.scale(0.05354, 0.05354, 0.05354);
  }
  const mesh_reach_joint_A1_1_40 = new THREE.Mesh(
    mesh_reach_joint_A1_1_40Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_joint_A1_1_40.name = "Reach joint A1 1";
  if (endpoint_reach_joint_A1_1_40) {
    mesh_reach_joint_A1_1_40.position.copy(endpoint_reach_joint_A1_1_40.midpoint);
    mesh_reach_joint_A1_1_40.quaternion.copy(endpoint_reach_joint_A1_1_40.quaternion);
  }
  mesh_reach_joint_A1_1_40.castShadow = options.castShadow ?? true;
  mesh_reach_joint_A1_1_40.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_joint_A1_1_40.userData.sculptComponent = { id: "reach-joint-A1-1" };
  node_reach_joint_A1_1_40.add(mesh_reach_joint_A1_1_40);
  meshes["reach-joint-A1-1"] = mesh_reach_joint_A1_1_40;
  colliders["reach-joint-A1-1"] = {};
  destructionGroups["reach-A1"] ??= [];
  destructionGroups["reach-A1"].push(node_reach_joint_A1_1_40);

  const endpoint_reach_ring_A1_0_41 = makeAttachmentEndpoint(null);
  const node_reach_ring_A1_0_41 = new THREE.Group();
  node_reach_ring_A1_0_41.name = "Joint ring A1 0__pivot";
  node_reach_ring_A1_0_41.scale.set(1, 1, 1);
  if (endpoint_reach_ring_A1_0_41) {
    node_reach_ring_A1_0_41.position.copy(endpoint_reach_ring_A1_0_41.start);
    node_reach_ring_A1_0_41.rotation.set(-1.26918, -0.5965, 0.0);
  } else {
    node_reach_ring_A1_0_41.position.set(-0.05039, 0.07087, 0.02205);
    node_reach_ring_A1_0_41.rotation.set(-1.26918, -0.5965, 0.0);
  }
  node_reach_ring_A1_0_41.userData.sculptComponent = { id: "reach-ring-A1-0" };
  node_reach_ring_A1_0_41.userData.actionProfile = {};
  (nodes["reach-rod-A1-0"] ?? root).add(node_reach_ring_A1_0_41);
  nodes["reach-ring-A1-0"] = node_reach_ring_A1_0_41;
  const mesh_reach_ring_A1_0_41Geometry = endpoint_reach_ring_A1_0_41
    ? new THREE.CylinderGeometry(endpoint_reach_ring_A1_0_41.endRadius, endpoint_reach_ring_A1_0_41.baseRadius, endpoint_reach_ring_A1_0_41.length, 8, 4)
    : new THREE.TorusGeometry(0.45, 0.0614, 8, 16);
  if (!endpoint_reach_ring_A1_0_41) {
    mesh_reach_ring_A1_0_41Geometry.scale(0.07699, 0.07699, 0.07699);
  }
  const mesh_reach_ring_A1_0_41 = new THREE.Mesh(
    mesh_reach_ring_A1_0_41Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_ring_A1_0_41.name = "Joint ring A1 0";
  if (endpoint_reach_ring_A1_0_41) {
    mesh_reach_ring_A1_0_41.position.copy(endpoint_reach_ring_A1_0_41.midpoint);
    mesh_reach_ring_A1_0_41.quaternion.copy(endpoint_reach_ring_A1_0_41.quaternion);
  }
  mesh_reach_ring_A1_0_41.castShadow = options.castShadow ?? true;
  mesh_reach_ring_A1_0_41.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_ring_A1_0_41.userData.sculptComponent = { id: "reach-ring-A1-0" };
  node_reach_ring_A1_0_41.add(mesh_reach_ring_A1_0_41);
  meshes["reach-ring-A1-0"] = mesh_reach_ring_A1_0_41;
  colliders["reach-ring-A1-0"] = {};
  destructionGroups["reach-A1"] ??= [];
  destructionGroups["reach-A1"].push(node_reach_ring_A1_0_41);

  const attachment_reach_rod_A1_1_42 = {"parentSocket": "reach-rod-A1-0-reach-rod-A1-1", "localStart": [-0.10079, 0.14173, 0.04409], "localEnd": [-0.16378, 0.29291, 0.06299], "contactType": "hinge-joint", "baseRadius": 0.02362, "endRadius": 0.0189, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_reach_rod_A1_1_42 = makeAttachmentEndpoint(attachment_reach_rod_A1_1_42);
  const node_reach_rod_A1_1_42 = new THREE.Group();
  node_reach_rod_A1_1_42.name = "Reach rod A1 1__pivot";
  node_reach_rod_A1_1_42.scale.set(1, 1, 1);
  if (endpoint_reach_rod_A1_1_42) {
    node_reach_rod_A1_1_42.position.copy(endpoint_reach_rod_A1_1_42.start);
    node_reach_rod_A1_1_42.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_reach_rod_A1_1_42.position.set(-0.10079, 0.14173, 0.04409);
    node_reach_rod_A1_1_42.rotation.set(0.0, 0.0, 0.0);
  }
  node_reach_rod_A1_1_42.userData.sculptComponent = { id: "reach-rod-A1-1" };
  node_reach_rod_A1_1_42.userData.actionProfile = {};
  (nodes["reach-rod-A1-0"] ?? root).add(node_reach_rod_A1_1_42);
  nodes["reach-rod-A1-1"] = node_reach_rod_A1_1_42;
  const mesh_reach_rod_A1_1_42Geometry = endpoint_reach_rod_A1_1_42
    ? new THREE.CylinderGeometry(endpoint_reach_rod_A1_1_42.endRadius, endpoint_reach_rod_A1_1_42.baseRadius, endpoint_reach_rod_A1_1_42.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_reach_rod_A1_1_42) {
    mesh_reach_rod_A1_1_42Geometry.scale(0.04724, 0.16487, 0.04724);
  }
  const mesh_reach_rod_A1_1_42 = new THREE.Mesh(
    mesh_reach_rod_A1_1_42Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_rod_A1_1_42.name = "Reach rod A1 1";
  if (endpoint_reach_rod_A1_1_42) {
    mesh_reach_rod_A1_1_42.position.copy(endpoint_reach_rod_A1_1_42.midpoint);
    mesh_reach_rod_A1_1_42.quaternion.copy(endpoint_reach_rod_A1_1_42.quaternion);
  }
  mesh_reach_rod_A1_1_42.castShadow = options.castShadow ?? true;
  mesh_reach_rod_A1_1_42.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_rod_A1_1_42.userData.sculptComponent = { id: "reach-rod-A1-1" };
  node_reach_rod_A1_1_42.add(mesh_reach_rod_A1_1_42);
  meshes["reach-rod-A1-1"] = mesh_reach_rod_A1_1_42;
  colliders["reach-rod-A1-1"] = {};
  destructionGroups["reach-A1"] ??= [];
  destructionGroups["reach-A1"].push(node_reach_rod_A1_1_42);

  const endpoint_reach_joint_A1_2_43 = makeAttachmentEndpoint(null);
  const node_reach_joint_A1_2_43 = new THREE.Group();
  node_reach_joint_A1_2_43.name = "Reach joint A1 2__pivot";
  node_reach_joint_A1_2_43.scale.set(1, 1, 1);
  if (endpoint_reach_joint_A1_2_43) {
    node_reach_joint_A1_2_43.position.copy(endpoint_reach_joint_A1_2_43.start);
    node_reach_joint_A1_2_43.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_reach_joint_A1_2_43.position.set(-0.06299, 0.15118, 0.0189);
    node_reach_joint_A1_2_43.rotation.set(0.0, 0.0, 0.0);
  }
  node_reach_joint_A1_2_43.userData.sculptComponent = { id: "reach-joint-A1-2" };
  node_reach_joint_A1_2_43.userData.actionProfile = {};
  (nodes["reach-rod-A1-1"] ?? root).add(node_reach_joint_A1_2_43);
  nodes["reach-joint-A1-2"] = node_reach_joint_A1_2_43;
  const mesh_reach_joint_A1_2_43Geometry = endpoint_reach_joint_A1_2_43
    ? new THREE.CylinderGeometry(endpoint_reach_joint_A1_2_43.endRadius, endpoint_reach_joint_A1_2_43.baseRadius, endpoint_reach_joint_A1_2_43.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_reach_joint_A1_2_43) {
    mesh_reach_joint_A1_2_43Geometry.scale(0.04724, 0.04724, 0.04724);
  }
  const mesh_reach_joint_A1_2_43 = new THREE.Mesh(
    mesh_reach_joint_A1_2_43Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_joint_A1_2_43.name = "Reach joint A1 2";
  if (endpoint_reach_joint_A1_2_43) {
    mesh_reach_joint_A1_2_43.position.copy(endpoint_reach_joint_A1_2_43.midpoint);
    mesh_reach_joint_A1_2_43.quaternion.copy(endpoint_reach_joint_A1_2_43.quaternion);
  }
  mesh_reach_joint_A1_2_43.castShadow = options.castShadow ?? true;
  mesh_reach_joint_A1_2_43.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_joint_A1_2_43.userData.sculptComponent = { id: "reach-joint-A1-2" };
  node_reach_joint_A1_2_43.add(mesh_reach_joint_A1_2_43);
  meshes["reach-joint-A1-2"] = mesh_reach_joint_A1_2_43;
  colliders["reach-joint-A1-2"] = {};
  destructionGroups["reach-A1"] ??= [];
  destructionGroups["reach-A1"].push(node_reach_joint_A1_2_43);

  const endpoint_reach_ring_A1_1_44 = makeAttachmentEndpoint(null);
  const node_reach_ring_A1_1_44 = new THREE.Group();
  node_reach_ring_A1_1_44.name = "Joint ring A1 1__pivot";
  node_reach_ring_A1_1_44.scale.set(1, 1, 1);
  if (endpoint_reach_ring_A1_1_44) {
    node_reach_ring_A1_1_44.position.copy(endpoint_reach_ring_A1_1_44.start);
    node_reach_ring_A1_1_44.rotation.set(-1.44644, -0.39205, 0.0);
  } else {
    node_reach_ring_A1_1_44.position.set(-0.0315, 0.07559, 0.00945);
    node_reach_ring_A1_1_44.rotation.set(-1.44644, -0.39205, 0.0);
  }
  node_reach_ring_A1_1_44.userData.sculptComponent = { id: "reach-ring-A1-1" };
  node_reach_ring_A1_1_44.userData.actionProfile = {};
  (nodes["reach-rod-A1-1"] ?? root).add(node_reach_ring_A1_1_44);
  nodes["reach-ring-A1-1"] = node_reach_ring_A1_1_44;
  const mesh_reach_ring_A1_1_44Geometry = endpoint_reach_ring_A1_1_44
    ? new THREE.CylinderGeometry(endpoint_reach_ring_A1_1_44.endRadius, endpoint_reach_ring_A1_1_44.baseRadius, endpoint_reach_ring_A1_1_44.length, 8, 4)
    : new THREE.TorusGeometry(0.45, 0.0614, 8, 16);
  if (!endpoint_reach_ring_A1_1_44) {
    mesh_reach_ring_A1_1_44Geometry.scale(0.07699, 0.07699, 0.07699);
  }
  const mesh_reach_ring_A1_1_44 = new THREE.Mesh(
    mesh_reach_ring_A1_1_44Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_ring_A1_1_44.name = "Joint ring A1 1";
  if (endpoint_reach_ring_A1_1_44) {
    mesh_reach_ring_A1_1_44.position.copy(endpoint_reach_ring_A1_1_44.midpoint);
    mesh_reach_ring_A1_1_44.quaternion.copy(endpoint_reach_ring_A1_1_44.quaternion);
  }
  mesh_reach_ring_A1_1_44.castShadow = options.castShadow ?? true;
  mesh_reach_ring_A1_1_44.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_ring_A1_1_44.userData.sculptComponent = { id: "reach-ring-A1-1" };
  node_reach_ring_A1_1_44.add(mesh_reach_ring_A1_1_44);
  meshes["reach-ring-A1-1"] = mesh_reach_ring_A1_1_44;
  colliders["reach-ring-A1-1"] = {};
  destructionGroups["reach-A1"] ??= [];
  destructionGroups["reach-A1"].push(node_reach_ring_A1_1_44);

  const attachment_reach_rod_A1_2_45 = {"parentSocket": "reach-rod-A1-1-reach-rod-A1-2", "localStart": [-0.06299, 0.15118, 0.0189], "localEnd": [-0.05039, 0.22047, 0.0315], "contactType": "hinge-joint", "baseRadius": 0.02362, "endRadius": 0.0189, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_reach_rod_A1_2_45 = makeAttachmentEndpoint(attachment_reach_rod_A1_2_45);
  const node_reach_rod_A1_2_45 = new THREE.Group();
  node_reach_rod_A1_2_45.name = "Reach rod A1 2__pivot";
  node_reach_rod_A1_2_45.scale.set(1, 1, 1);
  if (endpoint_reach_rod_A1_2_45) {
    node_reach_rod_A1_2_45.position.copy(endpoint_reach_rod_A1_2_45.start);
    node_reach_rod_A1_2_45.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_reach_rod_A1_2_45.position.set(-0.06299, 0.15118, 0.0189);
    node_reach_rod_A1_2_45.rotation.set(0.0, 0.0, 0.0);
  }
  node_reach_rod_A1_2_45.userData.sculptComponent = { id: "reach-rod-A1-2" };
  node_reach_rod_A1_2_45.userData.actionProfile = {};
  (nodes["reach-rod-A1-1"] ?? root).add(node_reach_rod_A1_2_45);
  nodes["reach-rod-A1-2"] = node_reach_rod_A1_2_45;
  const mesh_reach_rod_A1_2_45Geometry = endpoint_reach_rod_A1_2_45
    ? new THREE.CylinderGeometry(endpoint_reach_rod_A1_2_45.endRadius, endpoint_reach_rod_A1_2_45.baseRadius, endpoint_reach_rod_A1_2_45.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_reach_rod_A1_2_45) {
    mesh_reach_rod_A1_2_45Geometry.scale(0.04724, 0.07155, 0.04724);
  }
  const mesh_reach_rod_A1_2_45 = new THREE.Mesh(
    mesh_reach_rod_A1_2_45Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_rod_A1_2_45.name = "Reach rod A1 2";
  if (endpoint_reach_rod_A1_2_45) {
    mesh_reach_rod_A1_2_45.position.copy(endpoint_reach_rod_A1_2_45.midpoint);
    mesh_reach_rod_A1_2_45.quaternion.copy(endpoint_reach_rod_A1_2_45.quaternion);
  }
  mesh_reach_rod_A1_2_45.castShadow = options.castShadow ?? true;
  mesh_reach_rod_A1_2_45.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_rod_A1_2_45.userData.sculptComponent = { id: "reach-rod-A1-2" };
  node_reach_rod_A1_2_45.add(mesh_reach_rod_A1_2_45);
  meshes["reach-rod-A1-2"] = mesh_reach_rod_A1_2_45;
  colliders["reach-rod-A1-2"] = {};
  destructionGroups["reach-A1"] ??= [];
  destructionGroups["reach-A1"].push(node_reach_rod_A1_2_45);

  const endpoint_reach_joint_A1_3_46 = makeAttachmentEndpoint(null);
  const node_reach_joint_A1_3_46 = new THREE.Group();
  node_reach_joint_A1_3_46.name = "Reach joint A1 3__pivot";
  node_reach_joint_A1_3_46.scale.set(1, 1, 1);
  if (endpoint_reach_joint_A1_3_46) {
    node_reach_joint_A1_3_46.position.copy(endpoint_reach_joint_A1_3_46.start);
    node_reach_joint_A1_3_46.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_reach_joint_A1_3_46.position.set(0.0126, 0.06929, 0.0126);
    node_reach_joint_A1_3_46.rotation.set(0.0, 0.0, 0.0);
  }
  node_reach_joint_A1_3_46.userData.sculptComponent = { id: "reach-joint-A1-3" };
  node_reach_joint_A1_3_46.userData.actionProfile = {};
  (nodes["reach-rod-A1-2"] ?? root).add(node_reach_joint_A1_3_46);
  nodes["reach-joint-A1-3"] = node_reach_joint_A1_3_46;
  const mesh_reach_joint_A1_3_46Geometry = endpoint_reach_joint_A1_3_46
    ? new THREE.CylinderGeometry(endpoint_reach_joint_A1_3_46.endRadius, endpoint_reach_joint_A1_3_46.baseRadius, endpoint_reach_joint_A1_3_46.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_reach_joint_A1_3_46) {
    mesh_reach_joint_A1_3_46Geometry.scale(0.04094, 0.04094, 0.04094);
  }
  const mesh_reach_joint_A1_3_46 = new THREE.Mesh(
    mesh_reach_joint_A1_3_46Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_joint_A1_3_46.name = "Reach joint A1 3";
  if (endpoint_reach_joint_A1_3_46) {
    mesh_reach_joint_A1_3_46.position.copy(endpoint_reach_joint_A1_3_46.midpoint);
    mesh_reach_joint_A1_3_46.quaternion.copy(endpoint_reach_joint_A1_3_46.quaternion);
  }
  mesh_reach_joint_A1_3_46.castShadow = options.castShadow ?? true;
  mesh_reach_joint_A1_3_46.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_joint_A1_3_46.userData.sculptComponent = { id: "reach-joint-A1-3" };
  node_reach_joint_A1_3_46.add(mesh_reach_joint_A1_3_46);
  meshes["reach-joint-A1-3"] = mesh_reach_joint_A1_3_46;
  colliders["reach-joint-A1-3"] = {};
  destructionGroups["reach-A1"] ??= [];
  destructionGroups["reach-A1"].push(node_reach_joint_A1_3_46);

  const endpoint_reach_ring_A1_2_47 = makeAttachmentEndpoint(null);
  const node_reach_ring_A1_2_47 = new THREE.Group();
  node_reach_ring_A1_2_47.name = "Joint ring A1 2__pivot";
  node_reach_ring_A1_2_47.scale.set(1, 1, 1);
  if (endpoint_reach_ring_A1_2_47) {
    node_reach_ring_A1_2_47.position.copy(endpoint_reach_ring_A1_2_47.start);
    node_reach_ring_A1_2_47.rotation.set(-1.39094, 0.17701, 0.0);
  } else {
    node_reach_ring_A1_2_47.position.set(0.0063, 0.03465, 0.0063);
    node_reach_ring_A1_2_47.rotation.set(-1.39094, 0.17701, 0.0);
  }
  node_reach_ring_A1_2_47.userData.sculptComponent = { id: "reach-ring-A1-2" };
  node_reach_ring_A1_2_47.userData.actionProfile = {};
  (nodes["reach-rod-A1-2"] ?? root).add(node_reach_ring_A1_2_47);
  nodes["reach-ring-A1-2"] = node_reach_ring_A1_2_47;
  const mesh_reach_ring_A1_2_47Geometry = endpoint_reach_ring_A1_2_47
    ? new THREE.CylinderGeometry(endpoint_reach_ring_A1_2_47.endRadius, endpoint_reach_ring_A1_2_47.baseRadius, endpoint_reach_ring_A1_2_47.length, 8, 4)
    : new THREE.TorusGeometry(0.45, 0.0614, 8, 16);
  if (!endpoint_reach_ring_A1_2_47) {
    mesh_reach_ring_A1_2_47Geometry.scale(0.07699, 0.07699, 0.07699);
  }
  const mesh_reach_ring_A1_2_47 = new THREE.Mesh(
    mesh_reach_ring_A1_2_47Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_ring_A1_2_47.name = "Joint ring A1 2";
  if (endpoint_reach_ring_A1_2_47) {
    mesh_reach_ring_A1_2_47.position.copy(endpoint_reach_ring_A1_2_47.midpoint);
    mesh_reach_ring_A1_2_47.quaternion.copy(endpoint_reach_ring_A1_2_47.quaternion);
  }
  mesh_reach_ring_A1_2_47.castShadow = options.castShadow ?? true;
  mesh_reach_ring_A1_2_47.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_ring_A1_2_47.userData.sculptComponent = { id: "reach-ring-A1-2" };
  node_reach_ring_A1_2_47.add(mesh_reach_ring_A1_2_47);
  meshes["reach-ring-A1-2"] = mesh_reach_ring_A1_2_47;
  colliders["reach-ring-A1-2"] = {};
  destructionGroups["reach-A1"] ??= [];
  destructionGroups["reach-A1"].push(node_reach_ring_A1_2_47);

  const endpoint_reach_grip_A1_48 = makeAttachmentEndpoint(null);
  const node_reach_grip_A1_48 = new THREE.Group();
  node_reach_grip_A1_48.name = "Grip block A1__pivot";
  node_reach_grip_A1_48.scale.set(1, 1, 1);
  if (endpoint_reach_grip_A1_48) {
    node_reach_grip_A1_48.position.copy(endpoint_reach_grip_A1_48.start);
    node_reach_grip_A1_48.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_reach_grip_A1_48.position.set(0.0126, 0.06929, 0.0126);
    node_reach_grip_A1_48.rotation.set(0.0, 0.0, 0.0);
  }
  node_reach_grip_A1_48.userData.sculptComponent = { id: "reach-grip-A1" };
  node_reach_grip_A1_48.userData.actionProfile = {};
  (nodes["reach-rod-A1-2"] ?? root).add(node_reach_grip_A1_48);
  nodes["reach-grip-A1"] = node_reach_grip_A1_48;
  const mesh_reach_grip_A1_48Geometry = endpoint_reach_grip_A1_48
    ? new THREE.CylinderGeometry(endpoint_reach_grip_A1_48.endRadius, endpoint_reach_grip_A1_48.baseRadius, endpoint_reach_grip_A1_48.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_reach_grip_A1_48) {
    mesh_reach_grip_A1_48Geometry.scale(0.06929, 0.05039, 0.04409);
  }
  const mesh_reach_grip_A1_48 = new THREE.Mesh(
    mesh_reach_grip_A1_48Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_grip_A1_48.name = "Grip block A1";
  if (endpoint_reach_grip_A1_48) {
    mesh_reach_grip_A1_48.position.copy(endpoint_reach_grip_A1_48.midpoint);
    mesh_reach_grip_A1_48.quaternion.copy(endpoint_reach_grip_A1_48.quaternion);
  }
  mesh_reach_grip_A1_48.castShadow = options.castShadow ?? true;
  mesh_reach_grip_A1_48.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_grip_A1_48.userData.sculptComponent = { id: "reach-grip-A1" };
  node_reach_grip_A1_48.add(mesh_reach_grip_A1_48);
  meshes["reach-grip-A1"] = mesh_reach_grip_A1_48;
  colliders["reach-grip-A1"] = {};
  destructionGroups["reach-A1"] ??= [];
  destructionGroups["reach-A1"].push(node_reach_grip_A1_48);

  const endpoint_reach_grip_glow_A1_49 = makeAttachmentEndpoint(null);
  const node_reach_grip_glow_A1_49 = new THREE.Group();
  node_reach_grip_glow_A1_49.name = "Grip glow A1__pivot";
  node_reach_grip_glow_A1_49.scale.set(1, 1, 1);
  if (endpoint_reach_grip_glow_A1_49) {
    node_reach_grip_glow_A1_49.position.copy(endpoint_reach_grip_glow_A1_49.start);
    node_reach_grip_glow_A1_49.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_reach_grip_glow_A1_49.position.set(0.0, 0.0, 0.0252);
    node_reach_grip_glow_A1_49.rotation.set(0.0, 0.0, 0.0);
  }
  node_reach_grip_glow_A1_49.userData.sculptComponent = { id: "reach-grip-glow-A1" };
  node_reach_grip_glow_A1_49.userData.actionProfile = {};
  (nodes["reach-grip-A1"] ?? root).add(node_reach_grip_glow_A1_49);
  nodes["reach-grip-glow-A1"] = node_reach_grip_glow_A1_49;
  const mesh_reach_grip_glow_A1_49Geometry = endpoint_reach_grip_glow_A1_49
    ? new THREE.CylinderGeometry(endpoint_reach_grip_glow_A1_49.endRadius, endpoint_reach_grip_glow_A1_49.baseRadius, endpoint_reach_grip_glow_A1_49.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_reach_grip_glow_A1_49) {
    mesh_reach_grip_glow_A1_49Geometry.scale(0.04409, 0.00945, 0.0063);
  }
  const mesh_reach_grip_glow_A1_49 = new THREE.Mesh(
    mesh_reach_grip_glow_A1_49Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_grip_glow_A1_49.name = "Grip glow A1";
  if (endpoint_reach_grip_glow_A1_49) {
    mesh_reach_grip_glow_A1_49.position.copy(endpoint_reach_grip_glow_A1_49.midpoint);
    mesh_reach_grip_glow_A1_49.quaternion.copy(endpoint_reach_grip_glow_A1_49.quaternion);
  }
  mesh_reach_grip_glow_A1_49.castShadow = options.castShadow ?? true;
  mesh_reach_grip_glow_A1_49.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_grip_glow_A1_49.userData.sculptComponent = { id: "reach-grip-glow-A1" };
  node_reach_grip_glow_A1_49.add(mesh_reach_grip_glow_A1_49);
  meshes["reach-grip-glow-A1"] = mesh_reach_grip_glow_A1_49;
  colliders["reach-grip-glow-A1"] = {};
  destructionGroups["reach-A1"] ??= [];
  destructionGroups["reach-A1"].push(node_reach_grip_glow_A1_49);

  const endpoint_reach_joint_A2_0_50 = makeAttachmentEndpoint(null);
  const node_reach_joint_A2_0_50 = new THREE.Group();
  node_reach_joint_A2_0_50.name = "Reach joint A2 0__pivot";
  node_reach_joint_A2_0_50.scale.set(1, 1, 1);
  if (endpoint_reach_joint_A2_0_50) {
    node_reach_joint_A2_0_50.position.copy(endpoint_reach_joint_A2_0_50.start);
    node_reach_joint_A2_0_50.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_reach_joint_A2_0_50.position.set(-0.11969, 0.10709, 0.0189);
    node_reach_joint_A2_0_50.rotation.set(0.0, 0.0, 0.0);
  }
  node_reach_joint_A2_0_50.userData.sculptComponent = { id: "reach-joint-A2-0" };
  node_reach_joint_A2_0_50.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_reach_joint_A2_0_50);
  nodes["reach-joint-A2-0"] = node_reach_joint_A2_0_50;
  const mesh_reach_joint_A2_0_50Geometry = endpoint_reach_joint_A2_0_50
    ? new THREE.CylinderGeometry(endpoint_reach_joint_A2_0_50.endRadius, endpoint_reach_joint_A2_0_50.baseRadius, endpoint_reach_joint_A2_0_50.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_reach_joint_A2_0_50) {
    mesh_reach_joint_A2_0_50Geometry.scale(0.05669, 0.05669, 0.05669);
  }
  const mesh_reach_joint_A2_0_50 = new THREE.Mesh(
    mesh_reach_joint_A2_0_50Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_joint_A2_0_50.name = "Reach joint A2 0";
  if (endpoint_reach_joint_A2_0_50) {
    mesh_reach_joint_A2_0_50.position.copy(endpoint_reach_joint_A2_0_50.midpoint);
    mesh_reach_joint_A2_0_50.quaternion.copy(endpoint_reach_joint_A2_0_50.quaternion);
  }
  mesh_reach_joint_A2_0_50.castShadow = options.castShadow ?? true;
  mesh_reach_joint_A2_0_50.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_joint_A2_0_50.userData.sculptComponent = { id: "reach-joint-A2-0" };
  node_reach_joint_A2_0_50.add(mesh_reach_joint_A2_0_50);
  meshes["reach-joint-A2-0"] = mesh_reach_joint_A2_0_50;
  colliders["reach-joint-A2-0"] = {};
  destructionGroups["reach-A2"] ??= [];
  destructionGroups["reach-A2"].push(node_reach_joint_A2_0_50);

  const attachment_reach_rod_A2_0_51 = {"parentSocket": "chest-reach-rod-A2-0", "localStart": [-0.11969, 0.10709, 0.0189], "localEnd": [-0.27087, -0.0126, 0.05669], "contactType": "hinge-joint", "baseRadius": 0.02362, "endRadius": 0.0189, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_reach_rod_A2_0_51 = makeAttachmentEndpoint(attachment_reach_rod_A2_0_51);
  const node_reach_rod_A2_0_51 = new THREE.Group();
  node_reach_rod_A2_0_51.name = "Reach rod A2 0__pivot";
  node_reach_rod_A2_0_51.scale.set(1, 1, 1);
  if (endpoint_reach_rod_A2_0_51) {
    node_reach_rod_A2_0_51.position.copy(endpoint_reach_rod_A2_0_51.start);
    node_reach_rod_A2_0_51.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_reach_rod_A2_0_51.position.set(-0.11969, 0.10709, 0.0189);
    node_reach_rod_A2_0_51.rotation.set(0.0, 0.0, 0.0);
  }
  node_reach_rod_A2_0_51.userData.sculptComponent = { id: "reach-rod-A2-0" };
  node_reach_rod_A2_0_51.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_reach_rod_A2_0_51);
  nodes["reach-rod-A2-0"] = node_reach_rod_A2_0_51;
  const mesh_reach_rod_A2_0_51Geometry = endpoint_reach_rod_A2_0_51
    ? new THREE.CylinderGeometry(endpoint_reach_rod_A2_0_51.endRadius, endpoint_reach_rod_A2_0_51.baseRadius, endpoint_reach_rod_A2_0_51.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_reach_rod_A2_0_51) {
    mesh_reach_rod_A2_0_51Geometry.scale(0.04724, 0.19649, 0.04724);
  }
  const mesh_reach_rod_A2_0_51 = new THREE.Mesh(
    mesh_reach_rod_A2_0_51Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_rod_A2_0_51.name = "Reach rod A2 0";
  if (endpoint_reach_rod_A2_0_51) {
    mesh_reach_rod_A2_0_51.position.copy(endpoint_reach_rod_A2_0_51.midpoint);
    mesh_reach_rod_A2_0_51.quaternion.copy(endpoint_reach_rod_A2_0_51.quaternion);
  }
  mesh_reach_rod_A2_0_51.castShadow = options.castShadow ?? true;
  mesh_reach_rod_A2_0_51.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_rod_A2_0_51.userData.sculptComponent = { id: "reach-rod-A2-0" };
  node_reach_rod_A2_0_51.add(mesh_reach_rod_A2_0_51);
  meshes["reach-rod-A2-0"] = mesh_reach_rod_A2_0_51;
  colliders["reach-rod-A2-0"] = {};
  destructionGroups["reach-A2"] ??= [];
  destructionGroups["reach-A2"].push(node_reach_rod_A2_0_51);

  const endpoint_reach_joint_A2_1_52 = makeAttachmentEndpoint(null);
  const node_reach_joint_A2_1_52 = new THREE.Group();
  node_reach_joint_A2_1_52.name = "Reach joint A2 1__pivot";
  node_reach_joint_A2_1_52.scale.set(1, 1, 1);
  if (endpoint_reach_joint_A2_1_52) {
    node_reach_joint_A2_1_52.position.copy(endpoint_reach_joint_A2_1_52.start);
    node_reach_joint_A2_1_52.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_reach_joint_A2_1_52.position.set(-0.15118, -0.11969, 0.0378);
    node_reach_joint_A2_1_52.rotation.set(0.0, 0.0, 0.0);
  }
  node_reach_joint_A2_1_52.userData.sculptComponent = { id: "reach-joint-A2-1" };
  node_reach_joint_A2_1_52.userData.actionProfile = {};
  (nodes["reach-rod-A2-0"] ?? root).add(node_reach_joint_A2_1_52);
  nodes["reach-joint-A2-1"] = node_reach_joint_A2_1_52;
  const mesh_reach_joint_A2_1_52Geometry = endpoint_reach_joint_A2_1_52
    ? new THREE.CylinderGeometry(endpoint_reach_joint_A2_1_52.endRadius, endpoint_reach_joint_A2_1_52.baseRadius, endpoint_reach_joint_A2_1_52.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_reach_joint_A2_1_52) {
    mesh_reach_joint_A2_1_52Geometry.scale(0.05354, 0.05354, 0.05354);
  }
  const mesh_reach_joint_A2_1_52 = new THREE.Mesh(
    mesh_reach_joint_A2_1_52Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_joint_A2_1_52.name = "Reach joint A2 1";
  if (endpoint_reach_joint_A2_1_52) {
    mesh_reach_joint_A2_1_52.position.copy(endpoint_reach_joint_A2_1_52.midpoint);
    mesh_reach_joint_A2_1_52.quaternion.copy(endpoint_reach_joint_A2_1_52.quaternion);
  }
  mesh_reach_joint_A2_1_52.castShadow = options.castShadow ?? true;
  mesh_reach_joint_A2_1_52.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_joint_A2_1_52.userData.sculptComponent = { id: "reach-joint-A2-1" };
  node_reach_joint_A2_1_52.add(mesh_reach_joint_A2_1_52);
  meshes["reach-joint-A2-1"] = mesh_reach_joint_A2_1_52;
  colliders["reach-joint-A2-1"] = {};
  destructionGroups["reach-A2"] ??= [];
  destructionGroups["reach-A2"].push(node_reach_joint_A2_1_52);

  const endpoint_reach_ring_A2_0_53 = makeAttachmentEndpoint(null);
  const node_reach_ring_A2_0_53 = new THREE.Group();
  node_reach_ring_A2_0_53.name = "Joint ring A2 0__pivot";
  node_reach_ring_A2_0_53.scale.set(1, 1, 1);
  if (endpoint_reach_ring_A2_0_53) {
    node_reach_ring_A2_0_53.position.copy(endpoint_reach_ring_A2_0_53.start);
    node_reach_ring_A2_0_53.rotation.set(1.26492, -0.87791, 0.0);
  } else {
    node_reach_ring_A2_0_53.position.set(-0.07559, -0.05984, 0.0189);
    node_reach_ring_A2_0_53.rotation.set(1.26492, -0.87791, 0.0);
  }
  node_reach_ring_A2_0_53.userData.sculptComponent = { id: "reach-ring-A2-0" };
  node_reach_ring_A2_0_53.userData.actionProfile = {};
  (nodes["reach-rod-A2-0"] ?? root).add(node_reach_ring_A2_0_53);
  nodes["reach-ring-A2-0"] = node_reach_ring_A2_0_53;
  const mesh_reach_ring_A2_0_53Geometry = endpoint_reach_ring_A2_0_53
    ? new THREE.CylinderGeometry(endpoint_reach_ring_A2_0_53.endRadius, endpoint_reach_ring_A2_0_53.baseRadius, endpoint_reach_ring_A2_0_53.length, 8, 4)
    : new THREE.TorusGeometry(0.45, 0.0614, 8, 16);
  if (!endpoint_reach_ring_A2_0_53) {
    mesh_reach_ring_A2_0_53Geometry.scale(0.07699, 0.07699, 0.07699);
  }
  const mesh_reach_ring_A2_0_53 = new THREE.Mesh(
    mesh_reach_ring_A2_0_53Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_ring_A2_0_53.name = "Joint ring A2 0";
  if (endpoint_reach_ring_A2_0_53) {
    mesh_reach_ring_A2_0_53.position.copy(endpoint_reach_ring_A2_0_53.midpoint);
    mesh_reach_ring_A2_0_53.quaternion.copy(endpoint_reach_ring_A2_0_53.quaternion);
  }
  mesh_reach_ring_A2_0_53.castShadow = options.castShadow ?? true;
  mesh_reach_ring_A2_0_53.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_ring_A2_0_53.userData.sculptComponent = { id: "reach-ring-A2-0" };
  node_reach_ring_A2_0_53.add(mesh_reach_ring_A2_0_53);
  meshes["reach-ring-A2-0"] = mesh_reach_ring_A2_0_53;
  colliders["reach-ring-A2-0"] = {};
  destructionGroups["reach-A2"] ??= [];
  destructionGroups["reach-A2"].push(node_reach_ring_A2_0_53);

  const attachment_reach_rod_A2_1_54 = {"parentSocket": "reach-rod-A2-0-reach-rod-A2-1", "localStart": [-0.15118, -0.11969, 0.0378], "localEnd": [-0.23307, -0.30866, 0.05669], "contactType": "hinge-joint", "baseRadius": 0.02362, "endRadius": 0.0189, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_reach_rod_A2_1_54 = makeAttachmentEndpoint(attachment_reach_rod_A2_1_54);
  const node_reach_rod_A2_1_54 = new THREE.Group();
  node_reach_rod_A2_1_54.name = "Reach rod A2 1__pivot";
  node_reach_rod_A2_1_54.scale.set(1, 1, 1);
  if (endpoint_reach_rod_A2_1_54) {
    node_reach_rod_A2_1_54.position.copy(endpoint_reach_rod_A2_1_54.start);
    node_reach_rod_A2_1_54.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_reach_rod_A2_1_54.position.set(-0.15118, -0.11969, 0.0378);
    node_reach_rod_A2_1_54.rotation.set(0.0, 0.0, 0.0);
  }
  node_reach_rod_A2_1_54.userData.sculptComponent = { id: "reach-rod-A2-1" };
  node_reach_rod_A2_1_54.userData.actionProfile = {};
  (nodes["reach-rod-A2-0"] ?? root).add(node_reach_rod_A2_1_54);
  nodes["reach-rod-A2-1"] = node_reach_rod_A2_1_54;
  const mesh_reach_rod_A2_1_54Geometry = endpoint_reach_rod_A2_1_54
    ? new THREE.CylinderGeometry(endpoint_reach_rod_A2_1_54.endRadius, endpoint_reach_rod_A2_1_54.baseRadius, endpoint_reach_rod_A2_1_54.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_reach_rod_A2_1_54) {
    mesh_reach_rod_A2_1_54Geometry.scale(0.04724, 0.20682, 0.04724);
  }
  const mesh_reach_rod_A2_1_54 = new THREE.Mesh(
    mesh_reach_rod_A2_1_54Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_rod_A2_1_54.name = "Reach rod A2 1";
  if (endpoint_reach_rod_A2_1_54) {
    mesh_reach_rod_A2_1_54.position.copy(endpoint_reach_rod_A2_1_54.midpoint);
    mesh_reach_rod_A2_1_54.quaternion.copy(endpoint_reach_rod_A2_1_54.quaternion);
  }
  mesh_reach_rod_A2_1_54.castShadow = options.castShadow ?? true;
  mesh_reach_rod_A2_1_54.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_rod_A2_1_54.userData.sculptComponent = { id: "reach-rod-A2-1" };
  node_reach_rod_A2_1_54.add(mesh_reach_rod_A2_1_54);
  meshes["reach-rod-A2-1"] = mesh_reach_rod_A2_1_54;
  colliders["reach-rod-A2-1"] = {};
  destructionGroups["reach-A2"] ??= [];
  destructionGroups["reach-A2"].push(node_reach_rod_A2_1_54);

  const endpoint_reach_joint_A2_2_55 = makeAttachmentEndpoint(null);
  const node_reach_joint_A2_2_55 = new THREE.Group();
  node_reach_joint_A2_2_55.name = "Reach joint A2 2__pivot";
  node_reach_joint_A2_2_55.scale.set(1, 1, 1);
  if (endpoint_reach_joint_A2_2_55) {
    node_reach_joint_A2_2_55.position.copy(endpoint_reach_joint_A2_2_55.start);
    node_reach_joint_A2_2_55.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_reach_joint_A2_2_55.position.set(-0.08189, -0.18898, 0.0189);
    node_reach_joint_A2_2_55.rotation.set(0.0, 0.0, 0.0);
  }
  node_reach_joint_A2_2_55.userData.sculptComponent = { id: "reach-joint-A2-2" };
  node_reach_joint_A2_2_55.userData.actionProfile = {};
  (nodes["reach-rod-A2-1"] ?? root).add(node_reach_joint_A2_2_55);
  nodes["reach-joint-A2-2"] = node_reach_joint_A2_2_55;
  const mesh_reach_joint_A2_2_55Geometry = endpoint_reach_joint_A2_2_55
    ? new THREE.CylinderGeometry(endpoint_reach_joint_A2_2_55.endRadius, endpoint_reach_joint_A2_2_55.baseRadius, endpoint_reach_joint_A2_2_55.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_reach_joint_A2_2_55) {
    mesh_reach_joint_A2_2_55Geometry.scale(0.04724, 0.04724, 0.04724);
  }
  const mesh_reach_joint_A2_2_55 = new THREE.Mesh(
    mesh_reach_joint_A2_2_55Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_joint_A2_2_55.name = "Reach joint A2 2";
  if (endpoint_reach_joint_A2_2_55) {
    mesh_reach_joint_A2_2_55.position.copy(endpoint_reach_joint_A2_2_55.midpoint);
    mesh_reach_joint_A2_2_55.quaternion.copy(endpoint_reach_joint_A2_2_55.quaternion);
  }
  mesh_reach_joint_A2_2_55.castShadow = options.castShadow ?? true;
  mesh_reach_joint_A2_2_55.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_joint_A2_2_55.userData.sculptComponent = { id: "reach-joint-A2-2" };
  node_reach_joint_A2_2_55.add(mesh_reach_joint_A2_2_55);
  meshes["reach-joint-A2-2"] = mesh_reach_joint_A2_2_55;
  colliders["reach-joint-A2-2"] = {};
  destructionGroups["reach-A2"] ??= [];
  destructionGroups["reach-A2"].push(node_reach_joint_A2_2_55);

  const endpoint_reach_ring_A2_1_56 = makeAttachmentEndpoint(null);
  const node_reach_ring_A2_1_56 = new THREE.Group();
  node_reach_ring_A2_1_56.name = "Joint ring A2 1__pivot";
  node_reach_ring_A2_1_56.scale.set(1, 1, 1);
  if (endpoint_reach_ring_A2_1_56) {
    node_reach_ring_A2_1_56.position.copy(endpoint_reach_ring_A2_1_56.start);
    node_reach_ring_A2_1_56.rotation.set(1.47113, -0.4071, 0.0);
  } else {
    node_reach_ring_A2_1_56.position.set(-0.04094, -0.09449, 0.00945);
    node_reach_ring_A2_1_56.rotation.set(1.47113, -0.4071, 0.0);
  }
  node_reach_ring_A2_1_56.userData.sculptComponent = { id: "reach-ring-A2-1" };
  node_reach_ring_A2_1_56.userData.actionProfile = {};
  (nodes["reach-rod-A2-1"] ?? root).add(node_reach_ring_A2_1_56);
  nodes["reach-ring-A2-1"] = node_reach_ring_A2_1_56;
  const mesh_reach_ring_A2_1_56Geometry = endpoint_reach_ring_A2_1_56
    ? new THREE.CylinderGeometry(endpoint_reach_ring_A2_1_56.endRadius, endpoint_reach_ring_A2_1_56.baseRadius, endpoint_reach_ring_A2_1_56.length, 8, 4)
    : new THREE.TorusGeometry(0.45, 0.0614, 8, 16);
  if (!endpoint_reach_ring_A2_1_56) {
    mesh_reach_ring_A2_1_56Geometry.scale(0.07699, 0.07699, 0.07699);
  }
  const mesh_reach_ring_A2_1_56 = new THREE.Mesh(
    mesh_reach_ring_A2_1_56Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_ring_A2_1_56.name = "Joint ring A2 1";
  if (endpoint_reach_ring_A2_1_56) {
    mesh_reach_ring_A2_1_56.position.copy(endpoint_reach_ring_A2_1_56.midpoint);
    mesh_reach_ring_A2_1_56.quaternion.copy(endpoint_reach_ring_A2_1_56.quaternion);
  }
  mesh_reach_ring_A2_1_56.castShadow = options.castShadow ?? true;
  mesh_reach_ring_A2_1_56.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_ring_A2_1_56.userData.sculptComponent = { id: "reach-ring-A2-1" };
  node_reach_ring_A2_1_56.add(mesh_reach_ring_A2_1_56);
  meshes["reach-ring-A2-1"] = mesh_reach_ring_A2_1_56;
  colliders["reach-ring-A2-1"] = {};
  destructionGroups["reach-A2"] ??= [];
  destructionGroups["reach-A2"].push(node_reach_ring_A2_1_56);

  const attachment_reach_rod_A2_2_57 = {"parentSocket": "reach-rod-A2-1-reach-rod-A2-2", "localStart": [-0.08189, -0.18898, 0.0189], "localEnd": [-0.0378, -0.45669, 0.0126], "contactType": "hinge-joint", "baseRadius": 0.02362, "endRadius": 0.0189, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_reach_rod_A2_2_57 = makeAttachmentEndpoint(attachment_reach_rod_A2_2_57);
  const node_reach_rod_A2_2_57 = new THREE.Group();
  node_reach_rod_A2_2_57.name = "Reach rod A2 2__pivot";
  node_reach_rod_A2_2_57.scale.set(1, 1, 1);
  if (endpoint_reach_rod_A2_2_57) {
    node_reach_rod_A2_2_57.position.copy(endpoint_reach_rod_A2_2_57.start);
    node_reach_rod_A2_2_57.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_reach_rod_A2_2_57.position.set(-0.08189, -0.18898, 0.0189);
    node_reach_rod_A2_2_57.rotation.set(0.0, 0.0, 0.0);
  }
  node_reach_rod_A2_2_57.userData.sculptComponent = { id: "reach-rod-A2-2" };
  node_reach_rod_A2_2_57.userData.actionProfile = {};
  (nodes["reach-rod-A2-1"] ?? root).add(node_reach_rod_A2_2_57);
  nodes["reach-rod-A2-2"] = node_reach_rod_A2_2_57;
  const mesh_reach_rod_A2_2_57Geometry = endpoint_reach_rod_A2_2_57
    ? new THREE.CylinderGeometry(endpoint_reach_rod_A2_2_57.endRadius, endpoint_reach_rod_A2_2_57.baseRadius, endpoint_reach_rod_A2_2_57.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_reach_rod_A2_2_57) {
    mesh_reach_rod_A2_2_57Geometry.scale(0.04724, 0.2714, 0.04724);
  }
  const mesh_reach_rod_A2_2_57 = new THREE.Mesh(
    mesh_reach_rod_A2_2_57Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_rod_A2_2_57.name = "Reach rod A2 2";
  if (endpoint_reach_rod_A2_2_57) {
    mesh_reach_rod_A2_2_57.position.copy(endpoint_reach_rod_A2_2_57.midpoint);
    mesh_reach_rod_A2_2_57.quaternion.copy(endpoint_reach_rod_A2_2_57.quaternion);
  }
  mesh_reach_rod_A2_2_57.castShadow = options.castShadow ?? true;
  mesh_reach_rod_A2_2_57.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_rod_A2_2_57.userData.sculptComponent = { id: "reach-rod-A2-2" };
  node_reach_rod_A2_2_57.add(mesh_reach_rod_A2_2_57);
  meshes["reach-rod-A2-2"] = mesh_reach_rod_A2_2_57;
  colliders["reach-rod-A2-2"] = {};
  destructionGroups["reach-A2"] ??= [];
  destructionGroups["reach-A2"].push(node_reach_rod_A2_2_57);

  const endpoint_reach_joint_A2_3_58 = makeAttachmentEndpoint(null);
  const node_reach_joint_A2_3_58 = new THREE.Group();
  node_reach_joint_A2_3_58.name = "Reach joint A2 3__pivot";
  node_reach_joint_A2_3_58.scale.set(1, 1, 1);
  if (endpoint_reach_joint_A2_3_58) {
    node_reach_joint_A2_3_58.position.copy(endpoint_reach_joint_A2_3_58.start);
    node_reach_joint_A2_3_58.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_reach_joint_A2_3_58.position.set(0.04409, -0.26772, -0.0063);
    node_reach_joint_A2_3_58.rotation.set(0.0, 0.0, 0.0);
  }
  node_reach_joint_A2_3_58.userData.sculptComponent = { id: "reach-joint-A2-3" };
  node_reach_joint_A2_3_58.userData.actionProfile = {};
  (nodes["reach-rod-A2-2"] ?? root).add(node_reach_joint_A2_3_58);
  nodes["reach-joint-A2-3"] = node_reach_joint_A2_3_58;
  const mesh_reach_joint_A2_3_58Geometry = endpoint_reach_joint_A2_3_58
    ? new THREE.CylinderGeometry(endpoint_reach_joint_A2_3_58.endRadius, endpoint_reach_joint_A2_3_58.baseRadius, endpoint_reach_joint_A2_3_58.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_reach_joint_A2_3_58) {
    mesh_reach_joint_A2_3_58Geometry.scale(0.04094, 0.04094, 0.04094);
  }
  const mesh_reach_joint_A2_3_58 = new THREE.Mesh(
    mesh_reach_joint_A2_3_58Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_joint_A2_3_58.name = "Reach joint A2 3";
  if (endpoint_reach_joint_A2_3_58) {
    mesh_reach_joint_A2_3_58.position.copy(endpoint_reach_joint_A2_3_58.midpoint);
    mesh_reach_joint_A2_3_58.quaternion.copy(endpoint_reach_joint_A2_3_58.quaternion);
  }
  mesh_reach_joint_A2_3_58.castShadow = options.castShadow ?? true;
  mesh_reach_joint_A2_3_58.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_joint_A2_3_58.userData.sculptComponent = { id: "reach-joint-A2-3" };
  node_reach_joint_A2_3_58.add(mesh_reach_joint_A2_3_58);
  meshes["reach-joint-A2-3"] = mesh_reach_joint_A2_3_58;
  colliders["reach-joint-A2-3"] = {};
  destructionGroups["reach-A2"] ??= [];
  destructionGroups["reach-A2"].push(node_reach_joint_A2_3_58);

  const endpoint_reach_ring_A2_2_59 = makeAttachmentEndpoint(null);
  const node_reach_ring_A2_2_59 = new THREE.Group();
  node_reach_ring_A2_2_59.name = "Joint ring A2 2__pivot";
  node_reach_ring_A2_2_59.scale.set(1, 1, 1);
  if (endpoint_reach_ring_A2_2_59) {
    node_reach_ring_A2_2_59.position.copy(endpoint_reach_ring_A2_2_59.start);
    node_reach_ring_A2_2_59.rotation.set(1.59432, 0.1632, 0.0);
  } else {
    node_reach_ring_A2_2_59.position.set(0.02205, -0.13386, -0.00315);
    node_reach_ring_A2_2_59.rotation.set(1.59432, 0.1632, 0.0);
  }
  node_reach_ring_A2_2_59.userData.sculptComponent = { id: "reach-ring-A2-2" };
  node_reach_ring_A2_2_59.userData.actionProfile = {};
  (nodes["reach-rod-A2-2"] ?? root).add(node_reach_ring_A2_2_59);
  nodes["reach-ring-A2-2"] = node_reach_ring_A2_2_59;
  const mesh_reach_ring_A2_2_59Geometry = endpoint_reach_ring_A2_2_59
    ? new THREE.CylinderGeometry(endpoint_reach_ring_A2_2_59.endRadius, endpoint_reach_ring_A2_2_59.baseRadius, endpoint_reach_ring_A2_2_59.length, 8, 4)
    : new THREE.TorusGeometry(0.45, 0.0614, 8, 16);
  if (!endpoint_reach_ring_A2_2_59) {
    mesh_reach_ring_A2_2_59Geometry.scale(0.07699, 0.07699, 0.07699);
  }
  const mesh_reach_ring_A2_2_59 = new THREE.Mesh(
    mesh_reach_ring_A2_2_59Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_ring_A2_2_59.name = "Joint ring A2 2";
  if (endpoint_reach_ring_A2_2_59) {
    mesh_reach_ring_A2_2_59.position.copy(endpoint_reach_ring_A2_2_59.midpoint);
    mesh_reach_ring_A2_2_59.quaternion.copy(endpoint_reach_ring_A2_2_59.quaternion);
  }
  mesh_reach_ring_A2_2_59.castShadow = options.castShadow ?? true;
  mesh_reach_ring_A2_2_59.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_ring_A2_2_59.userData.sculptComponent = { id: "reach-ring-A2-2" };
  node_reach_ring_A2_2_59.add(mesh_reach_ring_A2_2_59);
  meshes["reach-ring-A2-2"] = mesh_reach_ring_A2_2_59;
  colliders["reach-ring-A2-2"] = {};
  destructionGroups["reach-A2"] ??= [];
  destructionGroups["reach-A2"].push(node_reach_ring_A2_2_59);

  const endpoint_reach_grip_A2_60 = makeAttachmentEndpoint(null);
  const node_reach_grip_A2_60 = new THREE.Group();
  node_reach_grip_A2_60.name = "Grip block A2__pivot";
  node_reach_grip_A2_60.scale.set(1, 1, 1);
  if (endpoint_reach_grip_A2_60) {
    node_reach_grip_A2_60.position.copy(endpoint_reach_grip_A2_60.start);
    node_reach_grip_A2_60.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_reach_grip_A2_60.position.set(0.04409, -0.26772, -0.0063);
    node_reach_grip_A2_60.rotation.set(0.0, 0.0, 0.0);
  }
  node_reach_grip_A2_60.userData.sculptComponent = { id: "reach-grip-A2" };
  node_reach_grip_A2_60.userData.actionProfile = {};
  (nodes["reach-rod-A2-2"] ?? root).add(node_reach_grip_A2_60);
  nodes["reach-grip-A2"] = node_reach_grip_A2_60;
  const mesh_reach_grip_A2_60Geometry = endpoint_reach_grip_A2_60
    ? new THREE.CylinderGeometry(endpoint_reach_grip_A2_60.endRadius, endpoint_reach_grip_A2_60.baseRadius, endpoint_reach_grip_A2_60.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_reach_grip_A2_60) {
    mesh_reach_grip_A2_60Geometry.scale(0.06929, 0.05039, 0.04409);
  }
  const mesh_reach_grip_A2_60 = new THREE.Mesh(
    mesh_reach_grip_A2_60Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_grip_A2_60.name = "Grip block A2";
  if (endpoint_reach_grip_A2_60) {
    mesh_reach_grip_A2_60.position.copy(endpoint_reach_grip_A2_60.midpoint);
    mesh_reach_grip_A2_60.quaternion.copy(endpoint_reach_grip_A2_60.quaternion);
  }
  mesh_reach_grip_A2_60.castShadow = options.castShadow ?? true;
  mesh_reach_grip_A2_60.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_grip_A2_60.userData.sculptComponent = { id: "reach-grip-A2" };
  node_reach_grip_A2_60.add(mesh_reach_grip_A2_60);
  meshes["reach-grip-A2"] = mesh_reach_grip_A2_60;
  colliders["reach-grip-A2"] = {};
  destructionGroups["reach-A2"] ??= [];
  destructionGroups["reach-A2"].push(node_reach_grip_A2_60);

  const endpoint_reach_grip_glow_A2_61 = makeAttachmentEndpoint(null);
  const node_reach_grip_glow_A2_61 = new THREE.Group();
  node_reach_grip_glow_A2_61.name = "Grip glow A2__pivot";
  node_reach_grip_glow_A2_61.scale.set(1, 1, 1);
  if (endpoint_reach_grip_glow_A2_61) {
    node_reach_grip_glow_A2_61.position.copy(endpoint_reach_grip_glow_A2_61.start);
    node_reach_grip_glow_A2_61.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_reach_grip_glow_A2_61.position.set(0.0, 0.0, 0.0252);
    node_reach_grip_glow_A2_61.rotation.set(0.0, 0.0, 0.0);
  }
  node_reach_grip_glow_A2_61.userData.sculptComponent = { id: "reach-grip-glow-A2" };
  node_reach_grip_glow_A2_61.userData.actionProfile = {};
  (nodes["reach-grip-A2"] ?? root).add(node_reach_grip_glow_A2_61);
  nodes["reach-grip-glow-A2"] = node_reach_grip_glow_A2_61;
  const mesh_reach_grip_glow_A2_61Geometry = endpoint_reach_grip_glow_A2_61
    ? new THREE.CylinderGeometry(endpoint_reach_grip_glow_A2_61.endRadius, endpoint_reach_grip_glow_A2_61.baseRadius, endpoint_reach_grip_glow_A2_61.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_reach_grip_glow_A2_61) {
    mesh_reach_grip_glow_A2_61Geometry.scale(0.04409, 0.00945, 0.0063);
  }
  const mesh_reach_grip_glow_A2_61 = new THREE.Mesh(
    mesh_reach_grip_glow_A2_61Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_grip_glow_A2_61.name = "Grip glow A2";
  if (endpoint_reach_grip_glow_A2_61) {
    mesh_reach_grip_glow_A2_61.position.copy(endpoint_reach_grip_glow_A2_61.midpoint);
    mesh_reach_grip_glow_A2_61.quaternion.copy(endpoint_reach_grip_glow_A2_61.quaternion);
  }
  mesh_reach_grip_glow_A2_61.castShadow = options.castShadow ?? true;
  mesh_reach_grip_glow_A2_61.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_grip_glow_A2_61.userData.sculptComponent = { id: "reach-grip-glow-A2" };
  node_reach_grip_glow_A2_61.add(mesh_reach_grip_glow_A2_61);
  meshes["reach-grip-glow-A2"] = mesh_reach_grip_glow_A2_61;
  colliders["reach-grip-glow-A2"] = {};
  destructionGroups["reach-A2"] ??= [];
  destructionGroups["reach-A2"].push(node_reach_grip_glow_A2_61);

  const endpoint_reach_joint_A3_0_62 = makeAttachmentEndpoint(null);
  const node_reach_joint_A3_0_62 = new THREE.Group();
  node_reach_joint_A3_0_62.name = "Reach joint A3 0__pivot";
  node_reach_joint_A3_0_62.scale.set(1, 1, 1);
  if (endpoint_reach_joint_A3_0_62) {
    node_reach_joint_A3_0_62.position.copy(endpoint_reach_joint_A3_0_62.start);
    node_reach_joint_A3_0_62.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_reach_joint_A3_0_62.position.set(-0.16378, 0.18268, 0.0126);
    node_reach_joint_A3_0_62.rotation.set(0.0, 0.0, 0.0);
  }
  node_reach_joint_A3_0_62.userData.sculptComponent = { id: "reach-joint-A3-0" };
  node_reach_joint_A3_0_62.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_reach_joint_A3_0_62);
  nodes["reach-joint-A3-0"] = node_reach_joint_A3_0_62;
  const mesh_reach_joint_A3_0_62Geometry = endpoint_reach_joint_A3_0_62
    ? new THREE.CylinderGeometry(endpoint_reach_joint_A3_0_62.endRadius, endpoint_reach_joint_A3_0_62.baseRadius, endpoint_reach_joint_A3_0_62.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_reach_joint_A3_0_62) {
    mesh_reach_joint_A3_0_62Geometry.scale(0.05669, 0.05669, 0.05669);
  }
  const mesh_reach_joint_A3_0_62 = new THREE.Mesh(
    mesh_reach_joint_A3_0_62Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_joint_A3_0_62.name = "Reach joint A3 0";
  if (endpoint_reach_joint_A3_0_62) {
    mesh_reach_joint_A3_0_62.position.copy(endpoint_reach_joint_A3_0_62.midpoint);
    mesh_reach_joint_A3_0_62.quaternion.copy(endpoint_reach_joint_A3_0_62.quaternion);
  }
  mesh_reach_joint_A3_0_62.castShadow = options.castShadow ?? true;
  mesh_reach_joint_A3_0_62.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_joint_A3_0_62.userData.sculptComponent = { id: "reach-joint-A3-0" };
  node_reach_joint_A3_0_62.add(mesh_reach_joint_A3_0_62);
  meshes["reach-joint-A3-0"] = mesh_reach_joint_A3_0_62;
  colliders["reach-joint-A3-0"] = {};
  destructionGroups["reach-A3"] ??= [];
  destructionGroups["reach-A3"].push(node_reach_joint_A3_0_62);

  const attachment_reach_rod_A3_0_63 = {"parentSocket": "chest-reach-rod-A3-0", "localStart": [-0.16378, 0.18268, 0.0126], "localEnd": [-0.31496, 0.20158, 0.08819], "contactType": "hinge-joint", "baseRadius": 0.02362, "endRadius": 0.0189, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_reach_rod_A3_0_63 = makeAttachmentEndpoint(attachment_reach_rod_A3_0_63);
  const node_reach_rod_A3_0_63 = new THREE.Group();
  node_reach_rod_A3_0_63.name = "Reach rod A3 0__pivot";
  node_reach_rod_A3_0_63.scale.set(1, 1, 1);
  if (endpoint_reach_rod_A3_0_63) {
    node_reach_rod_A3_0_63.position.copy(endpoint_reach_rod_A3_0_63.start);
    node_reach_rod_A3_0_63.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_reach_rod_A3_0_63.position.set(-0.16378, 0.18268, 0.0126);
    node_reach_rod_A3_0_63.rotation.set(0.0, 0.0, 0.0);
  }
  node_reach_rod_A3_0_63.userData.sculptComponent = { id: "reach-rod-A3-0" };
  node_reach_rod_A3_0_63.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_reach_rod_A3_0_63);
  nodes["reach-rod-A3-0"] = node_reach_rod_A3_0_63;
  const mesh_reach_rod_A3_0_63Geometry = endpoint_reach_rod_A3_0_63
    ? new THREE.CylinderGeometry(endpoint_reach_rod_A3_0_63.endRadius, endpoint_reach_rod_A3_0_63.baseRadius, endpoint_reach_rod_A3_0_63.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_reach_rod_A3_0_63) {
    mesh_reach_rod_A3_0_63Geometry.scale(0.04724, 0.17008, 0.04724);
  }
  const mesh_reach_rod_A3_0_63 = new THREE.Mesh(
    mesh_reach_rod_A3_0_63Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_rod_A3_0_63.name = "Reach rod A3 0";
  if (endpoint_reach_rod_A3_0_63) {
    mesh_reach_rod_A3_0_63.position.copy(endpoint_reach_rod_A3_0_63.midpoint);
    mesh_reach_rod_A3_0_63.quaternion.copy(endpoint_reach_rod_A3_0_63.quaternion);
  }
  mesh_reach_rod_A3_0_63.castShadow = options.castShadow ?? true;
  mesh_reach_rod_A3_0_63.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_rod_A3_0_63.userData.sculptComponent = { id: "reach-rod-A3-0" };
  node_reach_rod_A3_0_63.add(mesh_reach_rod_A3_0_63);
  meshes["reach-rod-A3-0"] = mesh_reach_rod_A3_0_63;
  colliders["reach-rod-A3-0"] = {};
  destructionGroups["reach-A3"] ??= [];
  destructionGroups["reach-A3"].push(node_reach_rod_A3_0_63);

  const endpoint_reach_joint_A3_1_64 = makeAttachmentEndpoint(null);
  const node_reach_joint_A3_1_64 = new THREE.Group();
  node_reach_joint_A3_1_64.name = "Reach joint A3 1__pivot";
  node_reach_joint_A3_1_64.scale.set(1, 1, 1);
  if (endpoint_reach_joint_A3_1_64) {
    node_reach_joint_A3_1_64.position.copy(endpoint_reach_joint_A3_1_64.start);
    node_reach_joint_A3_1_64.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_reach_joint_A3_1_64.position.set(-0.15118, 0.0189, 0.07559);
    node_reach_joint_A3_1_64.rotation.set(0.0, 0.0, 0.0);
  }
  node_reach_joint_A3_1_64.userData.sculptComponent = { id: "reach-joint-A3-1" };
  node_reach_joint_A3_1_64.userData.actionProfile = {};
  (nodes["reach-rod-A3-0"] ?? root).add(node_reach_joint_A3_1_64);
  nodes["reach-joint-A3-1"] = node_reach_joint_A3_1_64;
  const mesh_reach_joint_A3_1_64Geometry = endpoint_reach_joint_A3_1_64
    ? new THREE.CylinderGeometry(endpoint_reach_joint_A3_1_64.endRadius, endpoint_reach_joint_A3_1_64.baseRadius, endpoint_reach_joint_A3_1_64.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_reach_joint_A3_1_64) {
    mesh_reach_joint_A3_1_64Geometry.scale(0.05354, 0.05354, 0.05354);
  }
  const mesh_reach_joint_A3_1_64 = new THREE.Mesh(
    mesh_reach_joint_A3_1_64Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_joint_A3_1_64.name = "Reach joint A3 1";
  if (endpoint_reach_joint_A3_1_64) {
    mesh_reach_joint_A3_1_64.position.copy(endpoint_reach_joint_A3_1_64.midpoint);
    mesh_reach_joint_A3_1_64.quaternion.copy(endpoint_reach_joint_A3_1_64.quaternion);
  }
  mesh_reach_joint_A3_1_64.castShadow = options.castShadow ?? true;
  mesh_reach_joint_A3_1_64.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_joint_A3_1_64.userData.sculptComponent = { id: "reach-joint-A3-1" };
  node_reach_joint_A3_1_64.add(mesh_reach_joint_A3_1_64);
  meshes["reach-joint-A3-1"] = mesh_reach_joint_A3_1_64;
  colliders["reach-joint-A3-1"] = {};
  destructionGroups["reach-A3"] ??= [];
  destructionGroups["reach-A3"].push(node_reach_joint_A3_1_64);

  const endpoint_reach_ring_A3_0_65 = makeAttachmentEndpoint(null);
  const node_reach_ring_A3_0_65 = new THREE.Group();
  node_reach_ring_A3_0_65.name = "Joint ring A3 0__pivot";
  node_reach_ring_A3_0_65.scale.set(1, 1, 1);
  if (endpoint_reach_ring_A3_0_65) {
    node_reach_ring_A3_0_65.position.copy(endpoint_reach_ring_A3_0_65.start);
    node_reach_ring_A3_0_65.rotation.set(-0.24498, -1.09491, 0.0);
  } else {
    node_reach_ring_A3_0_65.position.set(-0.07559, 0.00945, 0.0378);
    node_reach_ring_A3_0_65.rotation.set(-0.24498, -1.09491, 0.0);
  }
  node_reach_ring_A3_0_65.userData.sculptComponent = { id: "reach-ring-A3-0" };
  node_reach_ring_A3_0_65.userData.actionProfile = {};
  (nodes["reach-rod-A3-0"] ?? root).add(node_reach_ring_A3_0_65);
  nodes["reach-ring-A3-0"] = node_reach_ring_A3_0_65;
  const mesh_reach_ring_A3_0_65Geometry = endpoint_reach_ring_A3_0_65
    ? new THREE.CylinderGeometry(endpoint_reach_ring_A3_0_65.endRadius, endpoint_reach_ring_A3_0_65.baseRadius, endpoint_reach_ring_A3_0_65.length, 8, 4)
    : new THREE.TorusGeometry(0.45, 0.0614, 8, 16);
  if (!endpoint_reach_ring_A3_0_65) {
    mesh_reach_ring_A3_0_65Geometry.scale(0.07699, 0.07699, 0.07699);
  }
  const mesh_reach_ring_A3_0_65 = new THREE.Mesh(
    mesh_reach_ring_A3_0_65Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_ring_A3_0_65.name = "Joint ring A3 0";
  if (endpoint_reach_ring_A3_0_65) {
    mesh_reach_ring_A3_0_65.position.copy(endpoint_reach_ring_A3_0_65.midpoint);
    mesh_reach_ring_A3_0_65.quaternion.copy(endpoint_reach_ring_A3_0_65.quaternion);
  }
  mesh_reach_ring_A3_0_65.castShadow = options.castShadow ?? true;
  mesh_reach_ring_A3_0_65.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_ring_A3_0_65.userData.sculptComponent = { id: "reach-ring-A3-0" };
  node_reach_ring_A3_0_65.add(mesh_reach_ring_A3_0_65);
  meshes["reach-ring-A3-0"] = mesh_reach_ring_A3_0_65;
  colliders["reach-ring-A3-0"] = {};
  destructionGroups["reach-A3"] ??= [];
  destructionGroups["reach-A3"].push(node_reach_ring_A3_0_65);

  const attachment_reach_rod_A3_1_66 = {"parentSocket": "reach-rod-A3-0-reach-rod-A3-1", "localStart": [-0.15118, 0.0189, 0.07559], "localEnd": [-0.26457, -0.0063, 0.11969], "contactType": "hinge-joint", "baseRadius": 0.02362, "endRadius": 0.0189, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_reach_rod_A3_1_66 = makeAttachmentEndpoint(attachment_reach_rod_A3_1_66);
  const node_reach_rod_A3_1_66 = new THREE.Group();
  node_reach_rod_A3_1_66.name = "Reach rod A3 1__pivot";
  node_reach_rod_A3_1_66.scale.set(1, 1, 1);
  if (endpoint_reach_rod_A3_1_66) {
    node_reach_rod_A3_1_66.position.copy(endpoint_reach_rod_A3_1_66.start);
    node_reach_rod_A3_1_66.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_reach_rod_A3_1_66.position.set(-0.15118, 0.0189, 0.07559);
    node_reach_rod_A3_1_66.rotation.set(0.0, 0.0, 0.0);
  }
  node_reach_rod_A3_1_66.userData.sculptComponent = { id: "reach-rod-A3-1" };
  node_reach_rod_A3_1_66.userData.actionProfile = {};
  (nodes["reach-rod-A3-0"] ?? root).add(node_reach_rod_A3_1_66);
  nodes["reach-rod-A3-1"] = node_reach_rod_A3_1_66;
  const mesh_reach_rod_A3_1_66Geometry = endpoint_reach_rod_A3_1_66
    ? new THREE.CylinderGeometry(endpoint_reach_rod_A3_1_66.endRadius, endpoint_reach_rod_A3_1_66.baseRadius, endpoint_reach_rod_A3_1_66.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_reach_rod_A3_1_66) {
    mesh_reach_rod_A3_1_66Geometry.scale(0.04724, 0.12424, 0.04724);
  }
  const mesh_reach_rod_A3_1_66 = new THREE.Mesh(
    mesh_reach_rod_A3_1_66Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_rod_A3_1_66.name = "Reach rod A3 1";
  if (endpoint_reach_rod_A3_1_66) {
    mesh_reach_rod_A3_1_66.position.copy(endpoint_reach_rod_A3_1_66.midpoint);
    mesh_reach_rod_A3_1_66.quaternion.copy(endpoint_reach_rod_A3_1_66.quaternion);
  }
  mesh_reach_rod_A3_1_66.castShadow = options.castShadow ?? true;
  mesh_reach_rod_A3_1_66.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_rod_A3_1_66.userData.sculptComponent = { id: "reach-rod-A3-1" };
  node_reach_rod_A3_1_66.add(mesh_reach_rod_A3_1_66);
  meshes["reach-rod-A3-1"] = mesh_reach_rod_A3_1_66;
  colliders["reach-rod-A3-1"] = {};
  destructionGroups["reach-A3"] ??= [];
  destructionGroups["reach-A3"].push(node_reach_rod_A3_1_66);

  const endpoint_reach_joint_A3_2_67 = makeAttachmentEndpoint(null);
  const node_reach_joint_A3_2_67 = new THREE.Group();
  node_reach_joint_A3_2_67.name = "Reach joint A3 2__pivot";
  node_reach_joint_A3_2_67.scale.set(1, 1, 1);
  if (endpoint_reach_joint_A3_2_67) {
    node_reach_joint_A3_2_67.position.copy(endpoint_reach_joint_A3_2_67.start);
    node_reach_joint_A3_2_67.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_reach_joint_A3_2_67.position.set(-0.11339, -0.0252, 0.04409);
    node_reach_joint_A3_2_67.rotation.set(0.0, 0.0, 0.0);
  }
  node_reach_joint_A3_2_67.userData.sculptComponent = { id: "reach-joint-A3-2" };
  node_reach_joint_A3_2_67.userData.actionProfile = {};
  (nodes["reach-rod-A3-1"] ?? root).add(node_reach_joint_A3_2_67);
  nodes["reach-joint-A3-2"] = node_reach_joint_A3_2_67;
  const mesh_reach_joint_A3_2_67Geometry = endpoint_reach_joint_A3_2_67
    ? new THREE.CylinderGeometry(endpoint_reach_joint_A3_2_67.endRadius, endpoint_reach_joint_A3_2_67.baseRadius, endpoint_reach_joint_A3_2_67.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_reach_joint_A3_2_67) {
    mesh_reach_joint_A3_2_67Geometry.scale(0.04724, 0.04724, 0.04724);
  }
  const mesh_reach_joint_A3_2_67 = new THREE.Mesh(
    mesh_reach_joint_A3_2_67Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_joint_A3_2_67.name = "Reach joint A3 2";
  if (endpoint_reach_joint_A3_2_67) {
    mesh_reach_joint_A3_2_67.position.copy(endpoint_reach_joint_A3_2_67.midpoint);
    mesh_reach_joint_A3_2_67.quaternion.copy(endpoint_reach_joint_A3_2_67.quaternion);
  }
  mesh_reach_joint_A3_2_67.castShadow = options.castShadow ?? true;
  mesh_reach_joint_A3_2_67.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_joint_A3_2_67.userData.sculptComponent = { id: "reach-joint-A3-2" };
  node_reach_joint_A3_2_67.add(mesh_reach_joint_A3_2_67);
  meshes["reach-joint-A3-2"] = mesh_reach_joint_A3_2_67;
  colliders["reach-joint-A3-2"] = {};
  destructionGroups["reach-A3"] ??= [];
  destructionGroups["reach-A3"].push(node_reach_joint_A3_2_67);

  const endpoint_reach_ring_A3_1_68 = makeAttachmentEndpoint(null);
  const node_reach_ring_A3_1_68 = new THREE.Group();
  node_reach_ring_A3_1_68.name = "Joint ring A3 1__pivot";
  node_reach_ring_A3_1_68.scale.set(1, 1, 1);
  if (endpoint_reach_ring_A3_1_68) {
    node_reach_ring_A3_1_68.position.copy(endpoint_reach_ring_A3_1_68.start);
    node_reach_ring_A3_1_68.rotation.set(0.51915, -1.14969, 0.0);
  } else {
    node_reach_ring_A3_1_68.position.set(-0.05669, -0.0126, 0.02205);
    node_reach_ring_A3_1_68.rotation.set(0.51915, -1.14969, 0.0);
  }
  node_reach_ring_A3_1_68.userData.sculptComponent = { id: "reach-ring-A3-1" };
  node_reach_ring_A3_1_68.userData.actionProfile = {};
  (nodes["reach-rod-A3-1"] ?? root).add(node_reach_ring_A3_1_68);
  nodes["reach-ring-A3-1"] = node_reach_ring_A3_1_68;
  const mesh_reach_ring_A3_1_68Geometry = endpoint_reach_ring_A3_1_68
    ? new THREE.CylinderGeometry(endpoint_reach_ring_A3_1_68.endRadius, endpoint_reach_ring_A3_1_68.baseRadius, endpoint_reach_ring_A3_1_68.length, 8, 4)
    : new THREE.TorusGeometry(0.45, 0.0614, 8, 16);
  if (!endpoint_reach_ring_A3_1_68) {
    mesh_reach_ring_A3_1_68Geometry.scale(0.07699, 0.07699, 0.07699);
  }
  const mesh_reach_ring_A3_1_68 = new THREE.Mesh(
    mesh_reach_ring_A3_1_68Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_ring_A3_1_68.name = "Joint ring A3 1";
  if (endpoint_reach_ring_A3_1_68) {
    mesh_reach_ring_A3_1_68.position.copy(endpoint_reach_ring_A3_1_68.midpoint);
    mesh_reach_ring_A3_1_68.quaternion.copy(endpoint_reach_ring_A3_1_68.quaternion);
  }
  mesh_reach_ring_A3_1_68.castShadow = options.castShadow ?? true;
  mesh_reach_ring_A3_1_68.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_ring_A3_1_68.userData.sculptComponent = { id: "reach-ring-A3-1" };
  node_reach_ring_A3_1_68.add(mesh_reach_ring_A3_1_68);
  meshes["reach-ring-A3-1"] = mesh_reach_ring_A3_1_68;
  colliders["reach-ring-A3-1"] = {};
  destructionGroups["reach-A3"] ??= [];
  destructionGroups["reach-A3"].push(node_reach_ring_A3_1_68);

  const endpoint_reach_grip_A3_69 = makeAttachmentEndpoint(null);
  const node_reach_grip_A3_69 = new THREE.Group();
  node_reach_grip_A3_69.name = "Grip block A3__pivot";
  node_reach_grip_A3_69.scale.set(1, 1, 1);
  if (endpoint_reach_grip_A3_69) {
    node_reach_grip_A3_69.position.copy(endpoint_reach_grip_A3_69.start);
    node_reach_grip_A3_69.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_reach_grip_A3_69.position.set(-0.11339, -0.0252, 0.04409);
    node_reach_grip_A3_69.rotation.set(0.0, 0.0, 0.0);
  }
  node_reach_grip_A3_69.userData.sculptComponent = { id: "reach-grip-A3" };
  node_reach_grip_A3_69.userData.actionProfile = {};
  (nodes["reach-rod-A3-1"] ?? root).add(node_reach_grip_A3_69);
  nodes["reach-grip-A3"] = node_reach_grip_A3_69;
  const mesh_reach_grip_A3_69Geometry = endpoint_reach_grip_A3_69
    ? new THREE.CylinderGeometry(endpoint_reach_grip_A3_69.endRadius, endpoint_reach_grip_A3_69.baseRadius, endpoint_reach_grip_A3_69.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_reach_grip_A3_69) {
    mesh_reach_grip_A3_69Geometry.scale(0.06929, 0.05039, 0.04409);
  }
  const mesh_reach_grip_A3_69 = new THREE.Mesh(
    mesh_reach_grip_A3_69Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_grip_A3_69.name = "Grip block A3";
  if (endpoint_reach_grip_A3_69) {
    mesh_reach_grip_A3_69.position.copy(endpoint_reach_grip_A3_69.midpoint);
    mesh_reach_grip_A3_69.quaternion.copy(endpoint_reach_grip_A3_69.quaternion);
  }
  mesh_reach_grip_A3_69.castShadow = options.castShadow ?? true;
  mesh_reach_grip_A3_69.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_grip_A3_69.userData.sculptComponent = { id: "reach-grip-A3" };
  node_reach_grip_A3_69.add(mesh_reach_grip_A3_69);
  meshes["reach-grip-A3"] = mesh_reach_grip_A3_69;
  colliders["reach-grip-A3"] = {};
  destructionGroups["reach-A3"] ??= [];
  destructionGroups["reach-A3"].push(node_reach_grip_A3_69);

  const endpoint_reach_grip_glow_A3_70 = makeAttachmentEndpoint(null);
  const node_reach_grip_glow_A3_70 = new THREE.Group();
  node_reach_grip_glow_A3_70.name = "Grip glow A3__pivot";
  node_reach_grip_glow_A3_70.scale.set(1, 1, 1);
  if (endpoint_reach_grip_glow_A3_70) {
    node_reach_grip_glow_A3_70.position.copy(endpoint_reach_grip_glow_A3_70.start);
    node_reach_grip_glow_A3_70.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_reach_grip_glow_A3_70.position.set(0.0, 0.0, 0.0252);
    node_reach_grip_glow_A3_70.rotation.set(0.0, 0.0, 0.0);
  }
  node_reach_grip_glow_A3_70.userData.sculptComponent = { id: "reach-grip-glow-A3" };
  node_reach_grip_glow_A3_70.userData.actionProfile = {};
  (nodes["reach-grip-A3"] ?? root).add(node_reach_grip_glow_A3_70);
  nodes["reach-grip-glow-A3"] = node_reach_grip_glow_A3_70;
  const mesh_reach_grip_glow_A3_70Geometry = endpoint_reach_grip_glow_A3_70
    ? new THREE.CylinderGeometry(endpoint_reach_grip_glow_A3_70.endRadius, endpoint_reach_grip_glow_A3_70.baseRadius, endpoint_reach_grip_glow_A3_70.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_reach_grip_glow_A3_70) {
    mesh_reach_grip_glow_A3_70Geometry.scale(0.04409, 0.00945, 0.0063);
  }
  const mesh_reach_grip_glow_A3_70 = new THREE.Mesh(
    mesh_reach_grip_glow_A3_70Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_grip_glow_A3_70.name = "Grip glow A3";
  if (endpoint_reach_grip_glow_A3_70) {
    mesh_reach_grip_glow_A3_70.position.copy(endpoint_reach_grip_glow_A3_70.midpoint);
    mesh_reach_grip_glow_A3_70.quaternion.copy(endpoint_reach_grip_glow_A3_70.quaternion);
  }
  mesh_reach_grip_glow_A3_70.castShadow = options.castShadow ?? true;
  mesh_reach_grip_glow_A3_70.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_grip_glow_A3_70.userData.sculptComponent = { id: "reach-grip-glow-A3" };
  node_reach_grip_glow_A3_70.add(mesh_reach_grip_glow_A3_70);
  meshes["reach-grip-glow-A3"] = mesh_reach_grip_glow_A3_70;
  colliders["reach-grip-glow-A3"] = {};
  destructionGroups["reach-A3"] ??= [];
  destructionGroups["reach-A3"].push(node_reach_grip_glow_A3_70);

  const endpoint_reach_joint_A4_0_71 = makeAttachmentEndpoint(null);
  const node_reach_joint_A4_0_71 = new THREE.Group();
  node_reach_joint_A4_0_71.name = "Reach joint A4 0__pivot";
  node_reach_joint_A4_0_71.scale.set(1, 1, 1);
  if (endpoint_reach_joint_A4_0_71) {
    node_reach_joint_A4_0_71.position.copy(endpoint_reach_joint_A4_0_71.start);
    node_reach_joint_A4_0_71.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_reach_joint_A4_0_71.position.set(0.18268, 0.27717, 0.0252);
    node_reach_joint_A4_0_71.rotation.set(0.0, 0.0, 0.0);
  }
  node_reach_joint_A4_0_71.userData.sculptComponent = { id: "reach-joint-A4-0" };
  node_reach_joint_A4_0_71.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_reach_joint_A4_0_71);
  nodes["reach-joint-A4-0"] = node_reach_joint_A4_0_71;
  const mesh_reach_joint_A4_0_71Geometry = endpoint_reach_joint_A4_0_71
    ? new THREE.CylinderGeometry(endpoint_reach_joint_A4_0_71.endRadius, endpoint_reach_joint_A4_0_71.baseRadius, endpoint_reach_joint_A4_0_71.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_reach_joint_A4_0_71) {
    mesh_reach_joint_A4_0_71Geometry.scale(0.05669, 0.05669, 0.05669);
  }
  const mesh_reach_joint_A4_0_71 = new THREE.Mesh(
    mesh_reach_joint_A4_0_71Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_joint_A4_0_71.name = "Reach joint A4 0";
  if (endpoint_reach_joint_A4_0_71) {
    mesh_reach_joint_A4_0_71.position.copy(endpoint_reach_joint_A4_0_71.midpoint);
    mesh_reach_joint_A4_0_71.quaternion.copy(endpoint_reach_joint_A4_0_71.quaternion);
  }
  mesh_reach_joint_A4_0_71.castShadow = options.castShadow ?? true;
  mesh_reach_joint_A4_0_71.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_joint_A4_0_71.userData.sculptComponent = { id: "reach-joint-A4-0" };
  node_reach_joint_A4_0_71.add(mesh_reach_joint_A4_0_71);
  meshes["reach-joint-A4-0"] = mesh_reach_joint_A4_0_71;
  colliders["reach-joint-A4-0"] = {};
  destructionGroups["reach-A4"] ??= [];
  destructionGroups["reach-A4"].push(node_reach_joint_A4_0_71);

  const attachment_reach_rod_A4_0_72 = {"parentSocket": "chest-reach-rod-A4-0", "localStart": [0.18268, 0.27717, 0.0252], "localEnd": [0.28976, 0.40945, 0.06929], "contactType": "hinge-joint", "baseRadius": 0.02362, "endRadius": 0.0189, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_reach_rod_A4_0_72 = makeAttachmentEndpoint(attachment_reach_rod_A4_0_72);
  const node_reach_rod_A4_0_72 = new THREE.Group();
  node_reach_rod_A4_0_72.name = "Reach rod A4 0__pivot";
  node_reach_rod_A4_0_72.scale.set(1, 1, 1);
  if (endpoint_reach_rod_A4_0_72) {
    node_reach_rod_A4_0_72.position.copy(endpoint_reach_rod_A4_0_72.start);
    node_reach_rod_A4_0_72.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_reach_rod_A4_0_72.position.set(0.18268, 0.27717, 0.0252);
    node_reach_rod_A4_0_72.rotation.set(0.0, 0.0, 0.0);
  }
  node_reach_rod_A4_0_72.userData.sculptComponent = { id: "reach-rod-A4-0" };
  node_reach_rod_A4_0_72.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_reach_rod_A4_0_72);
  nodes["reach-rod-A4-0"] = node_reach_rod_A4_0_72;
  const mesh_reach_rod_A4_0_72Geometry = endpoint_reach_rod_A4_0_72
    ? new THREE.CylinderGeometry(endpoint_reach_rod_A4_0_72.endRadius, endpoint_reach_rod_A4_0_72.baseRadius, endpoint_reach_rod_A4_0_72.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_reach_rod_A4_0_72) {
    mesh_reach_rod_A4_0_72Geometry.scale(0.04724, 0.17581, 0.04724);
  }
  const mesh_reach_rod_A4_0_72 = new THREE.Mesh(
    mesh_reach_rod_A4_0_72Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_rod_A4_0_72.name = "Reach rod A4 0";
  if (endpoint_reach_rod_A4_0_72) {
    mesh_reach_rod_A4_0_72.position.copy(endpoint_reach_rod_A4_0_72.midpoint);
    mesh_reach_rod_A4_0_72.quaternion.copy(endpoint_reach_rod_A4_0_72.quaternion);
  }
  mesh_reach_rod_A4_0_72.castShadow = options.castShadow ?? true;
  mesh_reach_rod_A4_0_72.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_rod_A4_0_72.userData.sculptComponent = { id: "reach-rod-A4-0" };
  node_reach_rod_A4_0_72.add(mesh_reach_rod_A4_0_72);
  meshes["reach-rod-A4-0"] = mesh_reach_rod_A4_0_72;
  colliders["reach-rod-A4-0"] = {};
  destructionGroups["reach-A4"] ??= [];
  destructionGroups["reach-A4"].push(node_reach_rod_A4_0_72);

  const endpoint_reach_joint_A4_1_73 = makeAttachmentEndpoint(null);
  const node_reach_joint_A4_1_73 = new THREE.Group();
  node_reach_joint_A4_1_73.name = "Reach joint A4 1__pivot";
  node_reach_joint_A4_1_73.scale.set(1, 1, 1);
  if (endpoint_reach_joint_A4_1_73) {
    node_reach_joint_A4_1_73.position.copy(endpoint_reach_joint_A4_1_73.start);
    node_reach_joint_A4_1_73.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_reach_joint_A4_1_73.position.set(0.10709, 0.13228, 0.04409);
    node_reach_joint_A4_1_73.rotation.set(0.0, 0.0, 0.0);
  }
  node_reach_joint_A4_1_73.userData.sculptComponent = { id: "reach-joint-A4-1" };
  node_reach_joint_A4_1_73.userData.actionProfile = {};
  (nodes["reach-rod-A4-0"] ?? root).add(node_reach_joint_A4_1_73);
  nodes["reach-joint-A4-1"] = node_reach_joint_A4_1_73;
  const mesh_reach_joint_A4_1_73Geometry = endpoint_reach_joint_A4_1_73
    ? new THREE.CylinderGeometry(endpoint_reach_joint_A4_1_73.endRadius, endpoint_reach_joint_A4_1_73.baseRadius, endpoint_reach_joint_A4_1_73.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_reach_joint_A4_1_73) {
    mesh_reach_joint_A4_1_73Geometry.scale(0.05354, 0.05354, 0.05354);
  }
  const mesh_reach_joint_A4_1_73 = new THREE.Mesh(
    mesh_reach_joint_A4_1_73Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_joint_A4_1_73.name = "Reach joint A4 1";
  if (endpoint_reach_joint_A4_1_73) {
    mesh_reach_joint_A4_1_73.position.copy(endpoint_reach_joint_A4_1_73.midpoint);
    mesh_reach_joint_A4_1_73.quaternion.copy(endpoint_reach_joint_A4_1_73.quaternion);
  }
  mesh_reach_joint_A4_1_73.castShadow = options.castShadow ?? true;
  mesh_reach_joint_A4_1_73.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_joint_A4_1_73.userData.sculptComponent = { id: "reach-joint-A4-1" };
  node_reach_joint_A4_1_73.add(mesh_reach_joint_A4_1_73);
  meshes["reach-joint-A4-1"] = mesh_reach_joint_A4_1_73;
  colliders["reach-joint-A4-1"] = {};
  destructionGroups["reach-A4"] ??= [];
  destructionGroups["reach-A4"].push(node_reach_joint_A4_1_73);

  const endpoint_reach_ring_A4_0_74 = makeAttachmentEndpoint(null);
  const node_reach_ring_A4_0_74 = new THREE.Group();
  node_reach_ring_A4_0_74.name = "Joint ring A4 0__pivot";
  node_reach_ring_A4_0_74.scale.set(1, 1, 1);
  if (endpoint_reach_ring_A4_0_74) {
    node_reach_ring_A4_0_74.position.copy(endpoint_reach_ring_A4_0_74.start);
    node_reach_ring_A4_0_74.rotation.set(-1.24905, 0.65491, 0.0);
  } else {
    node_reach_ring_A4_0_74.position.set(0.05354, 0.06614, 0.02205);
    node_reach_ring_A4_0_74.rotation.set(-1.24905, 0.65491, 0.0);
  }
  node_reach_ring_A4_0_74.userData.sculptComponent = { id: "reach-ring-A4-0" };
  node_reach_ring_A4_0_74.userData.actionProfile = {};
  (nodes["reach-rod-A4-0"] ?? root).add(node_reach_ring_A4_0_74);
  nodes["reach-ring-A4-0"] = node_reach_ring_A4_0_74;
  const mesh_reach_ring_A4_0_74Geometry = endpoint_reach_ring_A4_0_74
    ? new THREE.CylinderGeometry(endpoint_reach_ring_A4_0_74.endRadius, endpoint_reach_ring_A4_0_74.baseRadius, endpoint_reach_ring_A4_0_74.length, 8, 4)
    : new THREE.TorusGeometry(0.45, 0.0614, 8, 16);
  if (!endpoint_reach_ring_A4_0_74) {
    mesh_reach_ring_A4_0_74Geometry.scale(0.07699, 0.07699, 0.07699);
  }
  const mesh_reach_ring_A4_0_74 = new THREE.Mesh(
    mesh_reach_ring_A4_0_74Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_ring_A4_0_74.name = "Joint ring A4 0";
  if (endpoint_reach_ring_A4_0_74) {
    mesh_reach_ring_A4_0_74.position.copy(endpoint_reach_ring_A4_0_74.midpoint);
    mesh_reach_ring_A4_0_74.quaternion.copy(endpoint_reach_ring_A4_0_74.quaternion);
  }
  mesh_reach_ring_A4_0_74.castShadow = options.castShadow ?? true;
  mesh_reach_ring_A4_0_74.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_ring_A4_0_74.userData.sculptComponent = { id: "reach-ring-A4-0" };
  node_reach_ring_A4_0_74.add(mesh_reach_ring_A4_0_74);
  meshes["reach-ring-A4-0"] = mesh_reach_ring_A4_0_74;
  colliders["reach-ring-A4-0"] = {};
  destructionGroups["reach-A4"] ??= [];
  destructionGroups["reach-A4"].push(node_reach_ring_A4_0_74);

  const attachment_reach_rod_A4_1_75 = {"parentSocket": "reach-rod-A4-0-reach-rod-A4-1", "localStart": [0.10709, 0.13228, 0.04409], "localEnd": [0.15118, 0.25197, 0.05669], "contactType": "hinge-joint", "baseRadius": 0.02362, "endRadius": 0.0189, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_reach_rod_A4_1_75 = makeAttachmentEndpoint(attachment_reach_rod_A4_1_75);
  const node_reach_rod_A4_1_75 = new THREE.Group();
  node_reach_rod_A4_1_75.name = "Reach rod A4 1__pivot";
  node_reach_rod_A4_1_75.scale.set(1, 1, 1);
  if (endpoint_reach_rod_A4_1_75) {
    node_reach_rod_A4_1_75.position.copy(endpoint_reach_rod_A4_1_75.start);
    node_reach_rod_A4_1_75.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_reach_rod_A4_1_75.position.set(0.10709, 0.13228, 0.04409);
    node_reach_rod_A4_1_75.rotation.set(0.0, 0.0, 0.0);
  }
  node_reach_rod_A4_1_75.userData.sculptComponent = { id: "reach-rod-A4-1" };
  node_reach_rod_A4_1_75.userData.actionProfile = {};
  (nodes["reach-rod-A4-0"] ?? root).add(node_reach_rod_A4_1_75);
  nodes["reach-rod-A4-1"] = node_reach_rod_A4_1_75;
  const mesh_reach_rod_A4_1_75Geometry = endpoint_reach_rod_A4_1_75
    ? new THREE.CylinderGeometry(endpoint_reach_rod_A4_1_75.endRadius, endpoint_reach_rod_A4_1_75.baseRadius, endpoint_reach_rod_A4_1_75.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_reach_rod_A4_1_75) {
    mesh_reach_rod_A4_1_75Geometry.scale(0.04724, 0.12817, 0.04724);
  }
  const mesh_reach_rod_A4_1_75 = new THREE.Mesh(
    mesh_reach_rod_A4_1_75Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_rod_A4_1_75.name = "Reach rod A4 1";
  if (endpoint_reach_rod_A4_1_75) {
    mesh_reach_rod_A4_1_75.position.copy(endpoint_reach_rod_A4_1_75.midpoint);
    mesh_reach_rod_A4_1_75.quaternion.copy(endpoint_reach_rod_A4_1_75.quaternion);
  }
  mesh_reach_rod_A4_1_75.castShadow = options.castShadow ?? true;
  mesh_reach_rod_A4_1_75.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_rod_A4_1_75.userData.sculptComponent = { id: "reach-rod-A4-1" };
  node_reach_rod_A4_1_75.add(mesh_reach_rod_A4_1_75);
  meshes["reach-rod-A4-1"] = mesh_reach_rod_A4_1_75;
  colliders["reach-rod-A4-1"] = {};
  destructionGroups["reach-A4"] ??= [];
  destructionGroups["reach-A4"].push(node_reach_rod_A4_1_75);

  const endpoint_reach_joint_A4_2_76 = makeAttachmentEndpoint(null);
  const node_reach_joint_A4_2_76 = new THREE.Group();
  node_reach_joint_A4_2_76.name = "Reach joint A4 2__pivot";
  node_reach_joint_A4_2_76.scale.set(1, 1, 1);
  if (endpoint_reach_joint_A4_2_76) {
    node_reach_joint_A4_2_76.position.copy(endpoint_reach_joint_A4_2_76.start);
    node_reach_joint_A4_2_76.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_reach_joint_A4_2_76.position.set(0.04409, 0.11969, 0.0126);
    node_reach_joint_A4_2_76.rotation.set(0.0, 0.0, 0.0);
  }
  node_reach_joint_A4_2_76.userData.sculptComponent = { id: "reach-joint-A4-2" };
  node_reach_joint_A4_2_76.userData.actionProfile = {};
  (nodes["reach-rod-A4-1"] ?? root).add(node_reach_joint_A4_2_76);
  nodes["reach-joint-A4-2"] = node_reach_joint_A4_2_76;
  const mesh_reach_joint_A4_2_76Geometry = endpoint_reach_joint_A4_2_76
    ? new THREE.CylinderGeometry(endpoint_reach_joint_A4_2_76.endRadius, endpoint_reach_joint_A4_2_76.baseRadius, endpoint_reach_joint_A4_2_76.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_reach_joint_A4_2_76) {
    mesh_reach_joint_A4_2_76Geometry.scale(0.04724, 0.04724, 0.04724);
  }
  const mesh_reach_joint_A4_2_76 = new THREE.Mesh(
    mesh_reach_joint_A4_2_76Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_joint_A4_2_76.name = "Reach joint A4 2";
  if (endpoint_reach_joint_A4_2_76) {
    mesh_reach_joint_A4_2_76.position.copy(endpoint_reach_joint_A4_2_76.midpoint);
    mesh_reach_joint_A4_2_76.quaternion.copy(endpoint_reach_joint_A4_2_76.quaternion);
  }
  mesh_reach_joint_A4_2_76.castShadow = options.castShadow ?? true;
  mesh_reach_joint_A4_2_76.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_joint_A4_2_76.userData.sculptComponent = { id: "reach-joint-A4-2" };
  node_reach_joint_A4_2_76.add(mesh_reach_joint_A4_2_76);
  meshes["reach-joint-A4-2"] = mesh_reach_joint_A4_2_76;
  colliders["reach-joint-A4-2"] = {};
  destructionGroups["reach-A4"] ??= [];
  destructionGroups["reach-A4"].push(node_reach_joint_A4_2_76);

  const endpoint_reach_ring_A4_1_77 = makeAttachmentEndpoint(null);
  const node_reach_ring_A4_1_77 = new THREE.Group();
  node_reach_ring_A4_1_77.name = "Joint ring A4 1__pivot";
  node_reach_ring_A4_1_77.scale.set(1, 1, 1);
  if (endpoint_reach_ring_A4_1_77) {
    node_reach_ring_A4_1_77.position.copy(endpoint_reach_ring_A4_1_77.start);
    node_reach_ring_A4_1_77.rotation.set(-1.46592, 0.35121, 0.0);
  } else {
    node_reach_ring_A4_1_77.position.set(0.02205, 0.05984, 0.0063);
    node_reach_ring_A4_1_77.rotation.set(-1.46592, 0.35121, 0.0);
  }
  node_reach_ring_A4_1_77.userData.sculptComponent = { id: "reach-ring-A4-1" };
  node_reach_ring_A4_1_77.userData.actionProfile = {};
  (nodes["reach-rod-A4-1"] ?? root).add(node_reach_ring_A4_1_77);
  nodes["reach-ring-A4-1"] = node_reach_ring_A4_1_77;
  const mesh_reach_ring_A4_1_77Geometry = endpoint_reach_ring_A4_1_77
    ? new THREE.CylinderGeometry(endpoint_reach_ring_A4_1_77.endRadius, endpoint_reach_ring_A4_1_77.baseRadius, endpoint_reach_ring_A4_1_77.length, 8, 4)
    : new THREE.TorusGeometry(0.45, 0.0614, 8, 16);
  if (!endpoint_reach_ring_A4_1_77) {
    mesh_reach_ring_A4_1_77Geometry.scale(0.07699, 0.07699, 0.07699);
  }
  const mesh_reach_ring_A4_1_77 = new THREE.Mesh(
    mesh_reach_ring_A4_1_77Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_ring_A4_1_77.name = "Joint ring A4 1";
  if (endpoint_reach_ring_A4_1_77) {
    mesh_reach_ring_A4_1_77.position.copy(endpoint_reach_ring_A4_1_77.midpoint);
    mesh_reach_ring_A4_1_77.quaternion.copy(endpoint_reach_ring_A4_1_77.quaternion);
  }
  mesh_reach_ring_A4_1_77.castShadow = options.castShadow ?? true;
  mesh_reach_ring_A4_1_77.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_ring_A4_1_77.userData.sculptComponent = { id: "reach-ring-A4-1" };
  node_reach_ring_A4_1_77.add(mesh_reach_ring_A4_1_77);
  meshes["reach-ring-A4-1"] = mesh_reach_ring_A4_1_77;
  colliders["reach-ring-A4-1"] = {};
  destructionGroups["reach-A4"] ??= [];
  destructionGroups["reach-A4"].push(node_reach_ring_A4_1_77);

  const endpoint_reach_grip_A4_78 = makeAttachmentEndpoint(null);
  const node_reach_grip_A4_78 = new THREE.Group();
  node_reach_grip_A4_78.name = "Grip block A4__pivot";
  node_reach_grip_A4_78.scale.set(1, 1, 1);
  if (endpoint_reach_grip_A4_78) {
    node_reach_grip_A4_78.position.copy(endpoint_reach_grip_A4_78.start);
    node_reach_grip_A4_78.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_reach_grip_A4_78.position.set(0.04409, 0.11969, 0.0126);
    node_reach_grip_A4_78.rotation.set(0.0, 0.0, 0.0);
  }
  node_reach_grip_A4_78.userData.sculptComponent = { id: "reach-grip-A4" };
  node_reach_grip_A4_78.userData.actionProfile = {};
  (nodes["reach-rod-A4-1"] ?? root).add(node_reach_grip_A4_78);
  nodes["reach-grip-A4"] = node_reach_grip_A4_78;
  const mesh_reach_grip_A4_78Geometry = endpoint_reach_grip_A4_78
    ? new THREE.CylinderGeometry(endpoint_reach_grip_A4_78.endRadius, endpoint_reach_grip_A4_78.baseRadius, endpoint_reach_grip_A4_78.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_reach_grip_A4_78) {
    mesh_reach_grip_A4_78Geometry.scale(0.06929, 0.05039, 0.04409);
  }
  const mesh_reach_grip_A4_78 = new THREE.Mesh(
    mesh_reach_grip_A4_78Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_grip_A4_78.name = "Grip block A4";
  if (endpoint_reach_grip_A4_78) {
    mesh_reach_grip_A4_78.position.copy(endpoint_reach_grip_A4_78.midpoint);
    mesh_reach_grip_A4_78.quaternion.copy(endpoint_reach_grip_A4_78.quaternion);
  }
  mesh_reach_grip_A4_78.castShadow = options.castShadow ?? true;
  mesh_reach_grip_A4_78.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_grip_A4_78.userData.sculptComponent = { id: "reach-grip-A4" };
  node_reach_grip_A4_78.add(mesh_reach_grip_A4_78);
  meshes["reach-grip-A4"] = mesh_reach_grip_A4_78;
  colliders["reach-grip-A4"] = {};
  destructionGroups["reach-A4"] ??= [];
  destructionGroups["reach-A4"].push(node_reach_grip_A4_78);

  const endpoint_reach_grip_glow_A4_79 = makeAttachmentEndpoint(null);
  const node_reach_grip_glow_A4_79 = new THREE.Group();
  node_reach_grip_glow_A4_79.name = "Grip glow A4__pivot";
  node_reach_grip_glow_A4_79.scale.set(1, 1, 1);
  if (endpoint_reach_grip_glow_A4_79) {
    node_reach_grip_glow_A4_79.position.copy(endpoint_reach_grip_glow_A4_79.start);
    node_reach_grip_glow_A4_79.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_reach_grip_glow_A4_79.position.set(0.0, 0.0, 0.0252);
    node_reach_grip_glow_A4_79.rotation.set(0.0, 0.0, 0.0);
  }
  node_reach_grip_glow_A4_79.userData.sculptComponent = { id: "reach-grip-glow-A4" };
  node_reach_grip_glow_A4_79.userData.actionProfile = {};
  (nodes["reach-grip-A4"] ?? root).add(node_reach_grip_glow_A4_79);
  nodes["reach-grip-glow-A4"] = node_reach_grip_glow_A4_79;
  const mesh_reach_grip_glow_A4_79Geometry = endpoint_reach_grip_glow_A4_79
    ? new THREE.CylinderGeometry(endpoint_reach_grip_glow_A4_79.endRadius, endpoint_reach_grip_glow_A4_79.baseRadius, endpoint_reach_grip_glow_A4_79.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_reach_grip_glow_A4_79) {
    mesh_reach_grip_glow_A4_79Geometry.scale(0.04409, 0.00945, 0.0063);
  }
  const mesh_reach_grip_glow_A4_79 = new THREE.Mesh(
    mesh_reach_grip_glow_A4_79Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_grip_glow_A4_79.name = "Grip glow A4";
  if (endpoint_reach_grip_glow_A4_79) {
    mesh_reach_grip_glow_A4_79.position.copy(endpoint_reach_grip_glow_A4_79.midpoint);
    mesh_reach_grip_glow_A4_79.quaternion.copy(endpoint_reach_grip_glow_A4_79.quaternion);
  }
  mesh_reach_grip_glow_A4_79.castShadow = options.castShadow ?? true;
  mesh_reach_grip_glow_A4_79.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_grip_glow_A4_79.userData.sculptComponent = { id: "reach-grip-glow-A4" };
  node_reach_grip_glow_A4_79.add(mesh_reach_grip_glow_A4_79);
  meshes["reach-grip-glow-A4"] = mesh_reach_grip_glow_A4_79;
  colliders["reach-grip-glow-A4"] = {};
  destructionGroups["reach-A4"] ??= [];
  destructionGroups["reach-A4"].push(node_reach_grip_glow_A4_79);

  const endpoint_reach_joint_A5_0_80 = makeAttachmentEndpoint(null);
  const node_reach_joint_A5_0_80 = new THREE.Group();
  node_reach_joint_A5_0_80.name = "Reach joint A5 0__pivot";
  node_reach_joint_A5_0_80.scale.set(1, 1, 1);
  if (endpoint_reach_joint_A5_0_80) {
    node_reach_joint_A5_0_80.position.copy(endpoint_reach_joint_A5_0_80.start);
    node_reach_joint_A5_0_80.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_reach_joint_A5_0_80.position.set(0.15118, 0.10709, 0.0189);
    node_reach_joint_A5_0_80.rotation.set(0.0, 0.0, 0.0);
  }
  node_reach_joint_A5_0_80.userData.sculptComponent = { id: "reach-joint-A5-0" };
  node_reach_joint_A5_0_80.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_reach_joint_A5_0_80);
  nodes["reach-joint-A5-0"] = node_reach_joint_A5_0_80;
  const mesh_reach_joint_A5_0_80Geometry = endpoint_reach_joint_A5_0_80
    ? new THREE.CylinderGeometry(endpoint_reach_joint_A5_0_80.endRadius, endpoint_reach_joint_A5_0_80.baseRadius, endpoint_reach_joint_A5_0_80.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_reach_joint_A5_0_80) {
    mesh_reach_joint_A5_0_80Geometry.scale(0.05669, 0.05669, 0.05669);
  }
  const mesh_reach_joint_A5_0_80 = new THREE.Mesh(
    mesh_reach_joint_A5_0_80Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_joint_A5_0_80.name = "Reach joint A5 0";
  if (endpoint_reach_joint_A5_0_80) {
    mesh_reach_joint_A5_0_80.position.copy(endpoint_reach_joint_A5_0_80.midpoint);
    mesh_reach_joint_A5_0_80.quaternion.copy(endpoint_reach_joint_A5_0_80.quaternion);
  }
  mesh_reach_joint_A5_0_80.castShadow = options.castShadow ?? true;
  mesh_reach_joint_A5_0_80.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_joint_A5_0_80.userData.sculptComponent = { id: "reach-joint-A5-0" };
  node_reach_joint_A5_0_80.add(mesh_reach_joint_A5_0_80);
  meshes["reach-joint-A5-0"] = mesh_reach_joint_A5_0_80;
  colliders["reach-joint-A5-0"] = {};
  destructionGroups["reach-A5"] ??= [];
  destructionGroups["reach-A5"].push(node_reach_joint_A5_0_80);

  const attachment_reach_rod_A5_0_81 = {"parentSocket": "chest-reach-rod-A5-0", "localStart": [0.15118, 0.10709, 0.0189], "localEnd": [0.30236, -0.0126, 0.06299], "contactType": "hinge-joint", "baseRadius": 0.02362, "endRadius": 0.0189, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_reach_rod_A5_0_81 = makeAttachmentEndpoint(attachment_reach_rod_A5_0_81);
  const node_reach_rod_A5_0_81 = new THREE.Group();
  node_reach_rod_A5_0_81.name = "Reach rod A5 0__pivot";
  node_reach_rod_A5_0_81.scale.set(1, 1, 1);
  if (endpoint_reach_rod_A5_0_81) {
    node_reach_rod_A5_0_81.position.copy(endpoint_reach_rod_A5_0_81.start);
    node_reach_rod_A5_0_81.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_reach_rod_A5_0_81.position.set(0.15118, 0.10709, 0.0189);
    node_reach_rod_A5_0_81.rotation.set(0.0, 0.0, 0.0);
  }
  node_reach_rod_A5_0_81.userData.sculptComponent = { id: "reach-rod-A5-0" };
  node_reach_rod_A5_0_81.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_reach_rod_A5_0_81);
  nodes["reach-rod-A5-0"] = node_reach_rod_A5_0_81;
  const mesh_reach_rod_A5_0_81Geometry = endpoint_reach_rod_A5_0_81
    ? new THREE.CylinderGeometry(endpoint_reach_rod_A5_0_81.endRadius, endpoint_reach_rod_A5_0_81.baseRadius, endpoint_reach_rod_A5_0_81.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_reach_rod_A5_0_81) {
    mesh_reach_rod_A5_0_81Geometry.scale(0.04724, 0.1978, 0.04724);
  }
  const mesh_reach_rod_A5_0_81 = new THREE.Mesh(
    mesh_reach_rod_A5_0_81Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_rod_A5_0_81.name = "Reach rod A5 0";
  if (endpoint_reach_rod_A5_0_81) {
    mesh_reach_rod_A5_0_81.position.copy(endpoint_reach_rod_A5_0_81.midpoint);
    mesh_reach_rod_A5_0_81.quaternion.copy(endpoint_reach_rod_A5_0_81.quaternion);
  }
  mesh_reach_rod_A5_0_81.castShadow = options.castShadow ?? true;
  mesh_reach_rod_A5_0_81.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_rod_A5_0_81.userData.sculptComponent = { id: "reach-rod-A5-0" };
  node_reach_rod_A5_0_81.add(mesh_reach_rod_A5_0_81);
  meshes["reach-rod-A5-0"] = mesh_reach_rod_A5_0_81;
  colliders["reach-rod-A5-0"] = {};
  destructionGroups["reach-A5"] ??= [];
  destructionGroups["reach-A5"].push(node_reach_rod_A5_0_81);

  const endpoint_reach_joint_A5_1_82 = makeAttachmentEndpoint(null);
  const node_reach_joint_A5_1_82 = new THREE.Group();
  node_reach_joint_A5_1_82.name = "Reach joint A5 1__pivot";
  node_reach_joint_A5_1_82.scale.set(1, 1, 1);
  if (endpoint_reach_joint_A5_1_82) {
    node_reach_joint_A5_1_82.position.copy(endpoint_reach_joint_A5_1_82.start);
    node_reach_joint_A5_1_82.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_reach_joint_A5_1_82.position.set(0.15118, -0.11969, 0.04409);
    node_reach_joint_A5_1_82.rotation.set(0.0, 0.0, 0.0);
  }
  node_reach_joint_A5_1_82.userData.sculptComponent = { id: "reach-joint-A5-1" };
  node_reach_joint_A5_1_82.userData.actionProfile = {};
  (nodes["reach-rod-A5-0"] ?? root).add(node_reach_joint_A5_1_82);
  nodes["reach-joint-A5-1"] = node_reach_joint_A5_1_82;
  const mesh_reach_joint_A5_1_82Geometry = endpoint_reach_joint_A5_1_82
    ? new THREE.CylinderGeometry(endpoint_reach_joint_A5_1_82.endRadius, endpoint_reach_joint_A5_1_82.baseRadius, endpoint_reach_joint_A5_1_82.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_reach_joint_A5_1_82) {
    mesh_reach_joint_A5_1_82Geometry.scale(0.05354, 0.05354, 0.05354);
  }
  const mesh_reach_joint_A5_1_82 = new THREE.Mesh(
    mesh_reach_joint_A5_1_82Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_joint_A5_1_82.name = "Reach joint A5 1";
  if (endpoint_reach_joint_A5_1_82) {
    mesh_reach_joint_A5_1_82.position.copy(endpoint_reach_joint_A5_1_82.midpoint);
    mesh_reach_joint_A5_1_82.quaternion.copy(endpoint_reach_joint_A5_1_82.quaternion);
  }
  mesh_reach_joint_A5_1_82.castShadow = options.castShadow ?? true;
  mesh_reach_joint_A5_1_82.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_joint_A5_1_82.userData.sculptComponent = { id: "reach-joint-A5-1" };
  node_reach_joint_A5_1_82.add(mesh_reach_joint_A5_1_82);
  meshes["reach-joint-A5-1"] = mesh_reach_joint_A5_1_82;
  colliders["reach-joint-A5-1"] = {};
  destructionGroups["reach-A5"] ??= [];
  destructionGroups["reach-A5"].push(node_reach_joint_A5_1_82);

  const endpoint_reach_ring_A5_0_83 = makeAttachmentEndpoint(null);
  const node_reach_ring_A5_0_83 = new THREE.Group();
  node_reach_ring_A5_0_83.name = "Joint ring A5 0__pivot";
  node_reach_ring_A5_0_83.scale.set(1, 1, 1);
  if (endpoint_reach_ring_A5_0_83) {
    node_reach_ring_A5_0_83.position.copy(endpoint_reach_ring_A5_0_83.start);
    node_reach_ring_A5_0_83.rotation.set(1.21781, 0.86998, 0.0);
  } else {
    node_reach_ring_A5_0_83.position.set(0.07559, -0.05984, 0.02205);
    node_reach_ring_A5_0_83.rotation.set(1.21781, 0.86998, 0.0);
  }
  node_reach_ring_A5_0_83.userData.sculptComponent = { id: "reach-ring-A5-0" };
  node_reach_ring_A5_0_83.userData.actionProfile = {};
  (nodes["reach-rod-A5-0"] ?? root).add(node_reach_ring_A5_0_83);
  nodes["reach-ring-A5-0"] = node_reach_ring_A5_0_83;
  const mesh_reach_ring_A5_0_83Geometry = endpoint_reach_ring_A5_0_83
    ? new THREE.CylinderGeometry(endpoint_reach_ring_A5_0_83.endRadius, endpoint_reach_ring_A5_0_83.baseRadius, endpoint_reach_ring_A5_0_83.length, 8, 4)
    : new THREE.TorusGeometry(0.45, 0.0614, 8, 16);
  if (!endpoint_reach_ring_A5_0_83) {
    mesh_reach_ring_A5_0_83Geometry.scale(0.07699, 0.07699, 0.07699);
  }
  const mesh_reach_ring_A5_0_83 = new THREE.Mesh(
    mesh_reach_ring_A5_0_83Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_ring_A5_0_83.name = "Joint ring A5 0";
  if (endpoint_reach_ring_A5_0_83) {
    mesh_reach_ring_A5_0_83.position.copy(endpoint_reach_ring_A5_0_83.midpoint);
    mesh_reach_ring_A5_0_83.quaternion.copy(endpoint_reach_ring_A5_0_83.quaternion);
  }
  mesh_reach_ring_A5_0_83.castShadow = options.castShadow ?? true;
  mesh_reach_ring_A5_0_83.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_ring_A5_0_83.userData.sculptComponent = { id: "reach-ring-A5-0" };
  node_reach_ring_A5_0_83.add(mesh_reach_ring_A5_0_83);
  meshes["reach-ring-A5-0"] = mesh_reach_ring_A5_0_83;
  colliders["reach-ring-A5-0"] = {};
  destructionGroups["reach-A5"] ??= [];
  destructionGroups["reach-A5"].push(node_reach_ring_A5_0_83);

  const attachment_reach_rod_A5_1_84 = {"parentSocket": "reach-rod-A5-0-reach-rod-A5-1", "localStart": [0.15118, -0.11969, 0.04409], "localEnd": [0.22677, -0.28346, 0.06929], "contactType": "hinge-joint", "baseRadius": 0.02362, "endRadius": 0.0189, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_reach_rod_A5_1_84 = makeAttachmentEndpoint(attachment_reach_rod_A5_1_84);
  const node_reach_rod_A5_1_84 = new THREE.Group();
  node_reach_rod_A5_1_84.name = "Reach rod A5 1__pivot";
  node_reach_rod_A5_1_84.scale.set(1, 1, 1);
  if (endpoint_reach_rod_A5_1_84) {
    node_reach_rod_A5_1_84.position.copy(endpoint_reach_rod_A5_1_84.start);
    node_reach_rod_A5_1_84.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_reach_rod_A5_1_84.position.set(0.15118, -0.11969, 0.04409);
    node_reach_rod_A5_1_84.rotation.set(0.0, 0.0, 0.0);
  }
  node_reach_rod_A5_1_84.userData.sculptComponent = { id: "reach-rod-A5-1" };
  node_reach_rod_A5_1_84.userData.actionProfile = {};
  (nodes["reach-rod-A5-0"] ?? root).add(node_reach_rod_A5_1_84);
  nodes["reach-rod-A5-1"] = node_reach_rod_A5_1_84;
  const mesh_reach_rod_A5_1_84Geometry = endpoint_reach_rod_A5_1_84
    ? new THREE.CylinderGeometry(endpoint_reach_rod_A5_1_84.endRadius, endpoint_reach_rod_A5_1_84.baseRadius, endpoint_reach_rod_A5_1_84.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_reach_rod_A5_1_84) {
    mesh_reach_rod_A5_1_84Geometry.scale(0.04724, 0.18213, 0.04724);
  }
  const mesh_reach_rod_A5_1_84 = new THREE.Mesh(
    mesh_reach_rod_A5_1_84Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_rod_A5_1_84.name = "Reach rod A5 1";
  if (endpoint_reach_rod_A5_1_84) {
    mesh_reach_rod_A5_1_84.position.copy(endpoint_reach_rod_A5_1_84.midpoint);
    mesh_reach_rod_A5_1_84.quaternion.copy(endpoint_reach_rod_A5_1_84.quaternion);
  }
  mesh_reach_rod_A5_1_84.castShadow = options.castShadow ?? true;
  mesh_reach_rod_A5_1_84.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_rod_A5_1_84.userData.sculptComponent = { id: "reach-rod-A5-1" };
  node_reach_rod_A5_1_84.add(mesh_reach_rod_A5_1_84);
  meshes["reach-rod-A5-1"] = mesh_reach_rod_A5_1_84;
  colliders["reach-rod-A5-1"] = {};
  destructionGroups["reach-A5"] ??= [];
  destructionGroups["reach-A5"].push(node_reach_rod_A5_1_84);

  const endpoint_reach_joint_A5_2_85 = makeAttachmentEndpoint(null);
  const node_reach_joint_A5_2_85 = new THREE.Group();
  node_reach_joint_A5_2_85.name = "Reach joint A5 2__pivot";
  node_reach_joint_A5_2_85.scale.set(1, 1, 1);
  if (endpoint_reach_joint_A5_2_85) {
    node_reach_joint_A5_2_85.position.copy(endpoint_reach_joint_A5_2_85.start);
    node_reach_joint_A5_2_85.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_reach_joint_A5_2_85.position.set(0.07559, -0.16378, 0.0252);
    node_reach_joint_A5_2_85.rotation.set(0.0, 0.0, 0.0);
  }
  node_reach_joint_A5_2_85.userData.sculptComponent = { id: "reach-joint-A5-2" };
  node_reach_joint_A5_2_85.userData.actionProfile = {};
  (nodes["reach-rod-A5-1"] ?? root).add(node_reach_joint_A5_2_85);
  nodes["reach-joint-A5-2"] = node_reach_joint_A5_2_85;
  const mesh_reach_joint_A5_2_85Geometry = endpoint_reach_joint_A5_2_85
    ? new THREE.CylinderGeometry(endpoint_reach_joint_A5_2_85.endRadius, endpoint_reach_joint_A5_2_85.baseRadius, endpoint_reach_joint_A5_2_85.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_reach_joint_A5_2_85) {
    mesh_reach_joint_A5_2_85Geometry.scale(0.04724, 0.04724, 0.04724);
  }
  const mesh_reach_joint_A5_2_85 = new THREE.Mesh(
    mesh_reach_joint_A5_2_85Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_joint_A5_2_85.name = "Reach joint A5 2";
  if (endpoint_reach_joint_A5_2_85) {
    mesh_reach_joint_A5_2_85.position.copy(endpoint_reach_joint_A5_2_85.midpoint);
    mesh_reach_joint_A5_2_85.quaternion.copy(endpoint_reach_joint_A5_2_85.quaternion);
  }
  mesh_reach_joint_A5_2_85.castShadow = options.castShadow ?? true;
  mesh_reach_joint_A5_2_85.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_joint_A5_2_85.userData.sculptComponent = { id: "reach-joint-A5-2" };
  node_reach_joint_A5_2_85.add(mesh_reach_joint_A5_2_85);
  meshes["reach-joint-A5-2"] = mesh_reach_joint_A5_2_85;
  colliders["reach-joint-A5-2"] = {};
  destructionGroups["reach-A5"] ??= [];
  destructionGroups["reach-A5"].push(node_reach_joint_A5_2_85);

  const endpoint_reach_ring_A5_1_86 = makeAttachmentEndpoint(null);
  const node_reach_ring_A5_1_86 = new THREE.Group();
  node_reach_ring_A5_1_86.name = "Joint ring A5 1__pivot";
  node_reach_ring_A5_1_86.scale.set(1, 1, 1);
  if (endpoint_reach_ring_A5_1_86) {
    node_reach_ring_A5_1_86.position.copy(endpoint_reach_ring_A5_1_86.start);
    node_reach_ring_A5_1_86.rotation.set(1.41815, 0.42797, 0.0);
  } else {
    node_reach_ring_A5_1_86.position.set(0.0378, -0.08189, 0.0126);
    node_reach_ring_A5_1_86.rotation.set(1.41815, 0.42797, 0.0);
  }
  node_reach_ring_A5_1_86.userData.sculptComponent = { id: "reach-ring-A5-1" };
  node_reach_ring_A5_1_86.userData.actionProfile = {};
  (nodes["reach-rod-A5-1"] ?? root).add(node_reach_ring_A5_1_86);
  nodes["reach-ring-A5-1"] = node_reach_ring_A5_1_86;
  const mesh_reach_ring_A5_1_86Geometry = endpoint_reach_ring_A5_1_86
    ? new THREE.CylinderGeometry(endpoint_reach_ring_A5_1_86.endRadius, endpoint_reach_ring_A5_1_86.baseRadius, endpoint_reach_ring_A5_1_86.length, 8, 4)
    : new THREE.TorusGeometry(0.45, 0.0614, 8, 16);
  if (!endpoint_reach_ring_A5_1_86) {
    mesh_reach_ring_A5_1_86Geometry.scale(0.07699, 0.07699, 0.07699);
  }
  const mesh_reach_ring_A5_1_86 = new THREE.Mesh(
    mesh_reach_ring_A5_1_86Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_ring_A5_1_86.name = "Joint ring A5 1";
  if (endpoint_reach_ring_A5_1_86) {
    mesh_reach_ring_A5_1_86.position.copy(endpoint_reach_ring_A5_1_86.midpoint);
    mesh_reach_ring_A5_1_86.quaternion.copy(endpoint_reach_ring_A5_1_86.quaternion);
  }
  mesh_reach_ring_A5_1_86.castShadow = options.castShadow ?? true;
  mesh_reach_ring_A5_1_86.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_ring_A5_1_86.userData.sculptComponent = { id: "reach-ring-A5-1" };
  node_reach_ring_A5_1_86.add(mesh_reach_ring_A5_1_86);
  meshes["reach-ring-A5-1"] = mesh_reach_ring_A5_1_86;
  colliders["reach-ring-A5-1"] = {};
  destructionGroups["reach-A5"] ??= [];
  destructionGroups["reach-A5"].push(node_reach_ring_A5_1_86);

  const attachment_reach_rod_A5_2_87 = {"parentSocket": "reach-rod-A5-1-reach-rod-A5-2", "localStart": [0.07559, -0.16378, 0.0252], "localEnd": [-0.0126, -0.23307, 0.05039], "contactType": "hinge-joint", "baseRadius": 0.02362, "endRadius": 0.0189, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_reach_rod_A5_2_87 = makeAttachmentEndpoint(attachment_reach_rod_A5_2_87);
  const node_reach_rod_A5_2_87 = new THREE.Group();
  node_reach_rod_A5_2_87.name = "Reach rod A5 2__pivot";
  node_reach_rod_A5_2_87.scale.set(1, 1, 1);
  if (endpoint_reach_rod_A5_2_87) {
    node_reach_rod_A5_2_87.position.copy(endpoint_reach_rod_A5_2_87.start);
    node_reach_rod_A5_2_87.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_reach_rod_A5_2_87.position.set(0.07559, -0.16378, 0.0252);
    node_reach_rod_A5_2_87.rotation.set(0.0, 0.0, 0.0);
  }
  node_reach_rod_A5_2_87.userData.sculptComponent = { id: "reach-rod-A5-2" };
  node_reach_rod_A5_2_87.userData.actionProfile = {};
  (nodes["reach-rod-A5-1"] ?? root).add(node_reach_rod_A5_2_87);
  nodes["reach-rod-A5-2"] = node_reach_rod_A5_2_87;
  const mesh_reach_rod_A5_2_87Geometry = endpoint_reach_rod_A5_2_87
    ? new THREE.CylinderGeometry(endpoint_reach_rod_A5_2_87.endRadius, endpoint_reach_rod_A5_2_87.baseRadius, endpoint_reach_rod_A5_2_87.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_reach_rod_A5_2_87) {
    mesh_reach_rod_A5_2_87Geometry.scale(0.04724, 0.11495, 0.04724);
  }
  const mesh_reach_rod_A5_2_87 = new THREE.Mesh(
    mesh_reach_rod_A5_2_87Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_rod_A5_2_87.name = "Reach rod A5 2";
  if (endpoint_reach_rod_A5_2_87) {
    mesh_reach_rod_A5_2_87.position.copy(endpoint_reach_rod_A5_2_87.midpoint);
    mesh_reach_rod_A5_2_87.quaternion.copy(endpoint_reach_rod_A5_2_87.quaternion);
  }
  mesh_reach_rod_A5_2_87.castShadow = options.castShadow ?? true;
  mesh_reach_rod_A5_2_87.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_rod_A5_2_87.userData.sculptComponent = { id: "reach-rod-A5-2" };
  node_reach_rod_A5_2_87.add(mesh_reach_rod_A5_2_87);
  meshes["reach-rod-A5-2"] = mesh_reach_rod_A5_2_87;
  colliders["reach-rod-A5-2"] = {};
  destructionGroups["reach-A5"] ??= [];
  destructionGroups["reach-A5"].push(node_reach_rod_A5_2_87);

  const endpoint_reach_joint_A5_3_88 = makeAttachmentEndpoint(null);
  const node_reach_joint_A5_3_88 = new THREE.Group();
  node_reach_joint_A5_3_88.name = "Reach joint A5 3__pivot";
  node_reach_joint_A5_3_88.scale.set(1, 1, 1);
  if (endpoint_reach_joint_A5_3_88) {
    node_reach_joint_A5_3_88.position.copy(endpoint_reach_joint_A5_3_88.start);
    node_reach_joint_A5_3_88.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_reach_joint_A5_3_88.position.set(-0.08819, -0.06929, 0.0252);
    node_reach_joint_A5_3_88.rotation.set(0.0, 0.0, 0.0);
  }
  node_reach_joint_A5_3_88.userData.sculptComponent = { id: "reach-joint-A5-3" };
  node_reach_joint_A5_3_88.userData.actionProfile = {};
  (nodes["reach-rod-A5-2"] ?? root).add(node_reach_joint_A5_3_88);
  nodes["reach-joint-A5-3"] = node_reach_joint_A5_3_88;
  const mesh_reach_joint_A5_3_88Geometry = endpoint_reach_joint_A5_3_88
    ? new THREE.CylinderGeometry(endpoint_reach_joint_A5_3_88.endRadius, endpoint_reach_joint_A5_3_88.baseRadius, endpoint_reach_joint_A5_3_88.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_reach_joint_A5_3_88) {
    mesh_reach_joint_A5_3_88Geometry.scale(0.04094, 0.04094, 0.04094);
  }
  const mesh_reach_joint_A5_3_88 = new THREE.Mesh(
    mesh_reach_joint_A5_3_88Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_joint_A5_3_88.name = "Reach joint A5 3";
  if (endpoint_reach_joint_A5_3_88) {
    mesh_reach_joint_A5_3_88.position.copy(endpoint_reach_joint_A5_3_88.midpoint);
    mesh_reach_joint_A5_3_88.quaternion.copy(endpoint_reach_joint_A5_3_88.quaternion);
  }
  mesh_reach_joint_A5_3_88.castShadow = options.castShadow ?? true;
  mesh_reach_joint_A5_3_88.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_joint_A5_3_88.userData.sculptComponent = { id: "reach-joint-A5-3" };
  node_reach_joint_A5_3_88.add(mesh_reach_joint_A5_3_88);
  meshes["reach-joint-A5-3"] = mesh_reach_joint_A5_3_88;
  colliders["reach-joint-A5-3"] = {};
  destructionGroups["reach-A5"] ??= [];
  destructionGroups["reach-A5"].push(node_reach_joint_A5_3_88);

  const endpoint_reach_ring_A5_2_89 = makeAttachmentEndpoint(null);
  const node_reach_ring_A5_2_89 = new THREE.Group();
  node_reach_ring_A5_2_89.name = "Joint ring A5 2__pivot";
  node_reach_ring_A5_2_89.scale.set(1, 1, 1);
  if (endpoint_reach_ring_A5_2_89) {
    node_reach_ring_A5_2_89.position.copy(endpoint_reach_ring_A5_2_89.start);
    node_reach_ring_A5_2_89.rotation.set(1.22203, -0.87446, 0.0);
  } else {
    node_reach_ring_A5_2_89.position.set(-0.04409, -0.03465, 0.0126);
    node_reach_ring_A5_2_89.rotation.set(1.22203, -0.87446, 0.0);
  }
  node_reach_ring_A5_2_89.userData.sculptComponent = { id: "reach-ring-A5-2" };
  node_reach_ring_A5_2_89.userData.actionProfile = {};
  (nodes["reach-rod-A5-2"] ?? root).add(node_reach_ring_A5_2_89);
  nodes["reach-ring-A5-2"] = node_reach_ring_A5_2_89;
  const mesh_reach_ring_A5_2_89Geometry = endpoint_reach_ring_A5_2_89
    ? new THREE.CylinderGeometry(endpoint_reach_ring_A5_2_89.endRadius, endpoint_reach_ring_A5_2_89.baseRadius, endpoint_reach_ring_A5_2_89.length, 8, 4)
    : new THREE.TorusGeometry(0.45, 0.0614, 8, 16);
  if (!endpoint_reach_ring_A5_2_89) {
    mesh_reach_ring_A5_2_89Geometry.scale(0.07699, 0.07699, 0.07699);
  }
  const mesh_reach_ring_A5_2_89 = new THREE.Mesh(
    mesh_reach_ring_A5_2_89Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_ring_A5_2_89.name = "Joint ring A5 2";
  if (endpoint_reach_ring_A5_2_89) {
    mesh_reach_ring_A5_2_89.position.copy(endpoint_reach_ring_A5_2_89.midpoint);
    mesh_reach_ring_A5_2_89.quaternion.copy(endpoint_reach_ring_A5_2_89.quaternion);
  }
  mesh_reach_ring_A5_2_89.castShadow = options.castShadow ?? true;
  mesh_reach_ring_A5_2_89.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_ring_A5_2_89.userData.sculptComponent = { id: "reach-ring-A5-2" };
  node_reach_ring_A5_2_89.add(mesh_reach_ring_A5_2_89);
  meshes["reach-ring-A5-2"] = mesh_reach_ring_A5_2_89;
  colliders["reach-ring-A5-2"] = {};
  destructionGroups["reach-A5"] ??= [];
  destructionGroups["reach-A5"].push(node_reach_ring_A5_2_89);

  const endpoint_reach_grip_A5_90 = makeAttachmentEndpoint(null);
  const node_reach_grip_A5_90 = new THREE.Group();
  node_reach_grip_A5_90.name = "Grip block A5__pivot";
  node_reach_grip_A5_90.scale.set(1, 1, 1);
  if (endpoint_reach_grip_A5_90) {
    node_reach_grip_A5_90.position.copy(endpoint_reach_grip_A5_90.start);
    node_reach_grip_A5_90.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_reach_grip_A5_90.position.set(-0.08819, -0.06929, 0.0252);
    node_reach_grip_A5_90.rotation.set(0.0, 0.0, 0.0);
  }
  node_reach_grip_A5_90.userData.sculptComponent = { id: "reach-grip-A5" };
  node_reach_grip_A5_90.userData.actionProfile = {};
  (nodes["reach-rod-A5-2"] ?? root).add(node_reach_grip_A5_90);
  nodes["reach-grip-A5"] = node_reach_grip_A5_90;
  const mesh_reach_grip_A5_90Geometry = endpoint_reach_grip_A5_90
    ? new THREE.CylinderGeometry(endpoint_reach_grip_A5_90.endRadius, endpoint_reach_grip_A5_90.baseRadius, endpoint_reach_grip_A5_90.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_reach_grip_A5_90) {
    mesh_reach_grip_A5_90Geometry.scale(0.06929, 0.05039, 0.04409);
  }
  const mesh_reach_grip_A5_90 = new THREE.Mesh(
    mesh_reach_grip_A5_90Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_grip_A5_90.name = "Grip block A5";
  if (endpoint_reach_grip_A5_90) {
    mesh_reach_grip_A5_90.position.copy(endpoint_reach_grip_A5_90.midpoint);
    mesh_reach_grip_A5_90.quaternion.copy(endpoint_reach_grip_A5_90.quaternion);
  }
  mesh_reach_grip_A5_90.castShadow = options.castShadow ?? true;
  mesh_reach_grip_A5_90.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_grip_A5_90.userData.sculptComponent = { id: "reach-grip-A5" };
  node_reach_grip_A5_90.add(mesh_reach_grip_A5_90);
  meshes["reach-grip-A5"] = mesh_reach_grip_A5_90;
  colliders["reach-grip-A5"] = {};
  destructionGroups["reach-A5"] ??= [];
  destructionGroups["reach-A5"].push(node_reach_grip_A5_90);

  const endpoint_reach_grip_glow_A5_91 = makeAttachmentEndpoint(null);
  const node_reach_grip_glow_A5_91 = new THREE.Group();
  node_reach_grip_glow_A5_91.name = "Grip glow A5__pivot";
  node_reach_grip_glow_A5_91.scale.set(1, 1, 1);
  if (endpoint_reach_grip_glow_A5_91) {
    node_reach_grip_glow_A5_91.position.copy(endpoint_reach_grip_glow_A5_91.start);
    node_reach_grip_glow_A5_91.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_reach_grip_glow_A5_91.position.set(0.0, 0.0, 0.0252);
    node_reach_grip_glow_A5_91.rotation.set(0.0, 0.0, 0.0);
  }
  node_reach_grip_glow_A5_91.userData.sculptComponent = { id: "reach-grip-glow-A5" };
  node_reach_grip_glow_A5_91.userData.actionProfile = {};
  (nodes["reach-grip-A5"] ?? root).add(node_reach_grip_glow_A5_91);
  nodes["reach-grip-glow-A5"] = node_reach_grip_glow_A5_91;
  const mesh_reach_grip_glow_A5_91Geometry = endpoint_reach_grip_glow_A5_91
    ? new THREE.CylinderGeometry(endpoint_reach_grip_glow_A5_91.endRadius, endpoint_reach_grip_glow_A5_91.baseRadius, endpoint_reach_grip_glow_A5_91.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_reach_grip_glow_A5_91) {
    mesh_reach_grip_glow_A5_91Geometry.scale(0.04409, 0.00945, 0.0063);
  }
  const mesh_reach_grip_glow_A5_91 = new THREE.Mesh(
    mesh_reach_grip_glow_A5_91Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_grip_glow_A5_91.name = "Grip glow A5";
  if (endpoint_reach_grip_glow_A5_91) {
    mesh_reach_grip_glow_A5_91.position.copy(endpoint_reach_grip_glow_A5_91.midpoint);
    mesh_reach_grip_glow_A5_91.quaternion.copy(endpoint_reach_grip_glow_A5_91.quaternion);
  }
  mesh_reach_grip_glow_A5_91.castShadow = options.castShadow ?? true;
  mesh_reach_grip_glow_A5_91.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_grip_glow_A5_91.userData.sculptComponent = { id: "reach-grip-glow-A5" };
  node_reach_grip_glow_A5_91.add(mesh_reach_grip_glow_A5_91);
  meshes["reach-grip-glow-A5"] = mesh_reach_grip_glow_A5_91;
  colliders["reach-grip-glow-A5"] = {};
  destructionGroups["reach-A5"] ??= [];
  destructionGroups["reach-A5"].push(node_reach_grip_glow_A5_91);

  const endpoint_reach_joint_A6_0_92 = makeAttachmentEndpoint(null);
  const node_reach_joint_A6_0_92 = new THREE.Group();
  node_reach_joint_A6_0_92.name = "Reach joint A6 0__pivot";
  node_reach_joint_A6_0_92.scale.set(1, 1, 1);
  if (endpoint_reach_joint_A6_0_92) {
    node_reach_joint_A6_0_92.position.copy(endpoint_reach_joint_A6_0_92.start);
    node_reach_joint_A6_0_92.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_reach_joint_A6_0_92.position.set(0.11339, -0.0126, 0.0126);
    node_reach_joint_A6_0_92.rotation.set(0.0, 0.0, 0.0);
  }
  node_reach_joint_A6_0_92.userData.sculptComponent = { id: "reach-joint-A6-0" };
  node_reach_joint_A6_0_92.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_reach_joint_A6_0_92);
  nodes["reach-joint-A6-0"] = node_reach_joint_A6_0_92;
  const mesh_reach_joint_A6_0_92Geometry = endpoint_reach_joint_A6_0_92
    ? new THREE.CylinderGeometry(endpoint_reach_joint_A6_0_92.endRadius, endpoint_reach_joint_A6_0_92.baseRadius, endpoint_reach_joint_A6_0_92.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_reach_joint_A6_0_92) {
    mesh_reach_joint_A6_0_92Geometry.scale(0.05669, 0.05669, 0.05669);
  }
  const mesh_reach_joint_A6_0_92 = new THREE.Mesh(
    mesh_reach_joint_A6_0_92Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_joint_A6_0_92.name = "Reach joint A6 0";
  if (endpoint_reach_joint_A6_0_92) {
    mesh_reach_joint_A6_0_92.position.copy(endpoint_reach_joint_A6_0_92.midpoint);
    mesh_reach_joint_A6_0_92.quaternion.copy(endpoint_reach_joint_A6_0_92.quaternion);
  }
  mesh_reach_joint_A6_0_92.castShadow = options.castShadow ?? true;
  mesh_reach_joint_A6_0_92.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_joint_A6_0_92.userData.sculptComponent = { id: "reach-joint-A6-0" };
  node_reach_joint_A6_0_92.add(mesh_reach_joint_A6_0_92);
  meshes["reach-joint-A6-0"] = mesh_reach_joint_A6_0_92;
  colliders["reach-joint-A6-0"] = {};
  destructionGroups["reach-A6"] ??= [];
  destructionGroups["reach-A6"].push(node_reach_joint_A6_0_92);

  const attachment_reach_rod_A6_0_93 = {"parentSocket": "chest-reach-rod-A6-0", "localStart": [0.11339, -0.0126, 0.0126], "localEnd": [0.28346, -0.18898, 0.04409], "contactType": "hinge-joint", "baseRadius": 0.02362, "endRadius": 0.0189, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_reach_rod_A6_0_93 = makeAttachmentEndpoint(attachment_reach_rod_A6_0_93);
  const node_reach_rod_A6_0_93 = new THREE.Group();
  node_reach_rod_A6_0_93.name = "Reach rod A6 0__pivot";
  node_reach_rod_A6_0_93.scale.set(1, 1, 1);
  if (endpoint_reach_rod_A6_0_93) {
    node_reach_rod_A6_0_93.position.copy(endpoint_reach_rod_A6_0_93.start);
    node_reach_rod_A6_0_93.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_reach_rod_A6_0_93.position.set(0.11339, -0.0126, 0.0126);
    node_reach_rod_A6_0_93.rotation.set(0.0, 0.0, 0.0);
  }
  node_reach_rod_A6_0_93.userData.sculptComponent = { id: "reach-rod-A6-0" };
  node_reach_rod_A6_0_93.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_reach_rod_A6_0_93);
  nodes["reach-rod-A6-0"] = node_reach_rod_A6_0_93;
  const mesh_reach_rod_A6_0_93Geometry = endpoint_reach_rod_A6_0_93
    ? new THREE.CylinderGeometry(endpoint_reach_rod_A6_0_93.endRadius, endpoint_reach_rod_A6_0_93.baseRadius, endpoint_reach_rod_A6_0_93.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_reach_rod_A6_0_93) {
    mesh_reach_rod_A6_0_93Geometry.scale(0.04724, 0.24704, 0.04724);
  }
  const mesh_reach_rod_A6_0_93 = new THREE.Mesh(
    mesh_reach_rod_A6_0_93Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_rod_A6_0_93.name = "Reach rod A6 0";
  if (endpoint_reach_rod_A6_0_93) {
    mesh_reach_rod_A6_0_93.position.copy(endpoint_reach_rod_A6_0_93.midpoint);
    mesh_reach_rod_A6_0_93.quaternion.copy(endpoint_reach_rod_A6_0_93.quaternion);
  }
  mesh_reach_rod_A6_0_93.castShadow = options.castShadow ?? true;
  mesh_reach_rod_A6_0_93.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_rod_A6_0_93.userData.sculptComponent = { id: "reach-rod-A6-0" };
  node_reach_rod_A6_0_93.add(mesh_reach_rod_A6_0_93);
  meshes["reach-rod-A6-0"] = mesh_reach_rod_A6_0_93;
  colliders["reach-rod-A6-0"] = {};
  destructionGroups["reach-A6"] ??= [];
  destructionGroups["reach-A6"].push(node_reach_rod_A6_0_93);

  const endpoint_reach_joint_A6_1_94 = makeAttachmentEndpoint(null);
  const node_reach_joint_A6_1_94 = new THREE.Group();
  node_reach_joint_A6_1_94.name = "Reach joint A6 1__pivot";
  node_reach_joint_A6_1_94.scale.set(1, 1, 1);
  if (endpoint_reach_joint_A6_1_94) {
    node_reach_joint_A6_1_94.position.copy(endpoint_reach_joint_A6_1_94.start);
    node_reach_joint_A6_1_94.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_reach_joint_A6_1_94.position.set(0.17008, -0.17638, 0.0315);
    node_reach_joint_A6_1_94.rotation.set(0.0, 0.0, 0.0);
  }
  node_reach_joint_A6_1_94.userData.sculptComponent = { id: "reach-joint-A6-1" };
  node_reach_joint_A6_1_94.userData.actionProfile = {};
  (nodes["reach-rod-A6-0"] ?? root).add(node_reach_joint_A6_1_94);
  nodes["reach-joint-A6-1"] = node_reach_joint_A6_1_94;
  const mesh_reach_joint_A6_1_94Geometry = endpoint_reach_joint_A6_1_94
    ? new THREE.CylinderGeometry(endpoint_reach_joint_A6_1_94.endRadius, endpoint_reach_joint_A6_1_94.baseRadius, endpoint_reach_joint_A6_1_94.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_reach_joint_A6_1_94) {
    mesh_reach_joint_A6_1_94Geometry.scale(0.05354, 0.05354, 0.05354);
  }
  const mesh_reach_joint_A6_1_94 = new THREE.Mesh(
    mesh_reach_joint_A6_1_94Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_joint_A6_1_94.name = "Reach joint A6 1";
  if (endpoint_reach_joint_A6_1_94) {
    mesh_reach_joint_A6_1_94.position.copy(endpoint_reach_joint_A6_1_94.midpoint);
    mesh_reach_joint_A6_1_94.quaternion.copy(endpoint_reach_joint_A6_1_94.quaternion);
  }
  mesh_reach_joint_A6_1_94.castShadow = options.castShadow ?? true;
  mesh_reach_joint_A6_1_94.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_joint_A6_1_94.userData.sculptComponent = { id: "reach-joint-A6-1" };
  node_reach_joint_A6_1_94.add(mesh_reach_joint_A6_1_94);
  meshes["reach-joint-A6-1"] = mesh_reach_joint_A6_1_94;
  colliders["reach-joint-A6-1"] = {};
  destructionGroups["reach-A6"] ??= [];
  destructionGroups["reach-A6"].push(node_reach_joint_A6_1_94);

  const endpoint_reach_ring_A6_0_95 = makeAttachmentEndpoint(null);
  const node_reach_ring_A6_0_95 = new THREE.Group();
  node_reach_ring_A6_0_95.name = "Joint ring A6 0__pivot";
  node_reach_ring_A6_0_95.scale.set(1, 1, 1);
  if (endpoint_reach_ring_A6_0_95) {
    node_reach_ring_A6_0_95.position.copy(endpoint_reach_ring_A6_0_95.start);
    node_reach_ring_A6_0_95.rotation.set(1.39409, 0.75938, 0.0);
  } else {
    node_reach_ring_A6_0_95.position.set(0.08504, -0.08819, 0.01575);
    node_reach_ring_A6_0_95.rotation.set(1.39409, 0.75938, 0.0);
  }
  node_reach_ring_A6_0_95.userData.sculptComponent = { id: "reach-ring-A6-0" };
  node_reach_ring_A6_0_95.userData.actionProfile = {};
  (nodes["reach-rod-A6-0"] ?? root).add(node_reach_ring_A6_0_95);
  nodes["reach-ring-A6-0"] = node_reach_ring_A6_0_95;
  const mesh_reach_ring_A6_0_95Geometry = endpoint_reach_ring_A6_0_95
    ? new THREE.CylinderGeometry(endpoint_reach_ring_A6_0_95.endRadius, endpoint_reach_ring_A6_0_95.baseRadius, endpoint_reach_ring_A6_0_95.length, 8, 4)
    : new THREE.TorusGeometry(0.45, 0.0614, 8, 16);
  if (!endpoint_reach_ring_A6_0_95) {
    mesh_reach_ring_A6_0_95Geometry.scale(0.07699, 0.07699, 0.07699);
  }
  const mesh_reach_ring_A6_0_95 = new THREE.Mesh(
    mesh_reach_ring_A6_0_95Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_ring_A6_0_95.name = "Joint ring A6 0";
  if (endpoint_reach_ring_A6_0_95) {
    mesh_reach_ring_A6_0_95.position.copy(endpoint_reach_ring_A6_0_95.midpoint);
    mesh_reach_ring_A6_0_95.quaternion.copy(endpoint_reach_ring_A6_0_95.quaternion);
  }
  mesh_reach_ring_A6_0_95.castShadow = options.castShadow ?? true;
  mesh_reach_ring_A6_0_95.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_ring_A6_0_95.userData.sculptComponent = { id: "reach-ring-A6-0" };
  node_reach_ring_A6_0_95.add(mesh_reach_ring_A6_0_95);
  meshes["reach-ring-A6-0"] = mesh_reach_ring_A6_0_95;
  colliders["reach-ring-A6-0"] = {};
  destructionGroups["reach-A6"] ??= [];
  destructionGroups["reach-A6"].push(node_reach_ring_A6_0_95);

  const attachment_reach_rod_A6_1_96 = {"parentSocket": "reach-rod-A6-0-reach-rod-A6-1", "localStart": [0.17008, -0.17638, 0.0315], "localEnd": [0.25827, -0.35276, 0.05669], "contactType": "hinge-joint", "baseRadius": 0.02362, "endRadius": 0.0189, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_reach_rod_A6_1_96 = makeAttachmentEndpoint(attachment_reach_rod_A6_1_96);
  const node_reach_rod_A6_1_96 = new THREE.Group();
  node_reach_rod_A6_1_96.name = "Reach rod A6 1__pivot";
  node_reach_rod_A6_1_96.scale.set(1, 1, 1);
  if (endpoint_reach_rod_A6_1_96) {
    node_reach_rod_A6_1_96.position.copy(endpoint_reach_rod_A6_1_96.start);
    node_reach_rod_A6_1_96.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_reach_rod_A6_1_96.position.set(0.17008, -0.17638, 0.0315);
    node_reach_rod_A6_1_96.rotation.set(0.0, 0.0, 0.0);
  }
  node_reach_rod_A6_1_96.userData.sculptComponent = { id: "reach-rod-A6-1" };
  node_reach_rod_A6_1_96.userData.actionProfile = {};
  (nodes["reach-rod-A6-0"] ?? root).add(node_reach_rod_A6_1_96);
  nodes["reach-rod-A6-1"] = node_reach_rod_A6_1_96;
  const mesh_reach_rod_A6_1_96Geometry = endpoint_reach_rod_A6_1_96
    ? new THREE.CylinderGeometry(endpoint_reach_rod_A6_1_96.endRadius, endpoint_reach_rod_A6_1_96.baseRadius, endpoint_reach_rod_A6_1_96.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_reach_rod_A6_1_96) {
    mesh_reach_rod_A6_1_96Geometry.scale(0.04724, 0.1988, 0.04724);
  }
  const mesh_reach_rod_A6_1_96 = new THREE.Mesh(
    mesh_reach_rod_A6_1_96Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_rod_A6_1_96.name = "Reach rod A6 1";
  if (endpoint_reach_rod_A6_1_96) {
    mesh_reach_rod_A6_1_96.position.copy(endpoint_reach_rod_A6_1_96.midpoint);
    mesh_reach_rod_A6_1_96.quaternion.copy(endpoint_reach_rod_A6_1_96.quaternion);
  }
  mesh_reach_rod_A6_1_96.castShadow = options.castShadow ?? true;
  mesh_reach_rod_A6_1_96.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_rod_A6_1_96.userData.sculptComponent = { id: "reach-rod-A6-1" };
  node_reach_rod_A6_1_96.add(mesh_reach_rod_A6_1_96);
  meshes["reach-rod-A6-1"] = mesh_reach_rod_A6_1_96;
  colliders["reach-rod-A6-1"] = {};
  destructionGroups["reach-A6"] ??= [];
  destructionGroups["reach-A6"].push(node_reach_rod_A6_1_96);

  const endpoint_reach_joint_A6_2_97 = makeAttachmentEndpoint(null);
  const node_reach_joint_A6_2_97 = new THREE.Group();
  node_reach_joint_A6_2_97.name = "Reach joint A6 2__pivot";
  node_reach_joint_A6_2_97.scale.set(1, 1, 1);
  if (endpoint_reach_joint_A6_2_97) {
    node_reach_joint_A6_2_97.position.copy(endpoint_reach_joint_A6_2_97.start);
    node_reach_joint_A6_2_97.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_reach_joint_A6_2_97.position.set(0.08819, -0.17638, 0.0252);
    node_reach_joint_A6_2_97.rotation.set(0.0, 0.0, 0.0);
  }
  node_reach_joint_A6_2_97.userData.sculptComponent = { id: "reach-joint-A6-2" };
  node_reach_joint_A6_2_97.userData.actionProfile = {};
  (nodes["reach-rod-A6-1"] ?? root).add(node_reach_joint_A6_2_97);
  nodes["reach-joint-A6-2"] = node_reach_joint_A6_2_97;
  const mesh_reach_joint_A6_2_97Geometry = endpoint_reach_joint_A6_2_97
    ? new THREE.CylinderGeometry(endpoint_reach_joint_A6_2_97.endRadius, endpoint_reach_joint_A6_2_97.baseRadius, endpoint_reach_joint_A6_2_97.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_reach_joint_A6_2_97) {
    mesh_reach_joint_A6_2_97Geometry.scale(0.04724, 0.04724, 0.04724);
  }
  const mesh_reach_joint_A6_2_97 = new THREE.Mesh(
    mesh_reach_joint_A6_2_97Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_joint_A6_2_97.name = "Reach joint A6 2";
  if (endpoint_reach_joint_A6_2_97) {
    mesh_reach_joint_A6_2_97.position.copy(endpoint_reach_joint_A6_2_97.midpoint);
    mesh_reach_joint_A6_2_97.quaternion.copy(endpoint_reach_joint_A6_2_97.quaternion);
  }
  mesh_reach_joint_A6_2_97.castShadow = options.castShadow ?? true;
  mesh_reach_joint_A6_2_97.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_joint_A6_2_97.userData.sculptComponent = { id: "reach-joint-A6-2" };
  node_reach_joint_A6_2_97.add(mesh_reach_joint_A6_2_97);
  meshes["reach-joint-A6-2"] = mesh_reach_joint_A6_2_97;
  colliders["reach-joint-A6-2"] = {};
  destructionGroups["reach-A6"] ??= [];
  destructionGroups["reach-A6"].push(node_reach_joint_A6_2_97);

  const endpoint_reach_ring_A6_1_98 = makeAttachmentEndpoint(null);
  const node_reach_ring_A6_1_98 = new THREE.Group();
  node_reach_ring_A6_1_98.name = "Joint ring A6 1__pivot";
  node_reach_ring_A6_1_98.scale.set(1, 1, 1);
  if (endpoint_reach_ring_A6_1_98) {
    node_reach_ring_A6_1_98.position.copy(endpoint_reach_ring_A6_1_98.start);
    node_reach_ring_A6_1_98.rotation.set(1.4289, 0.45962, 0.0);
  } else {
    node_reach_ring_A6_1_98.position.set(0.04409, -0.08819, 0.0126);
    node_reach_ring_A6_1_98.rotation.set(1.4289, 0.45962, 0.0);
  }
  node_reach_ring_A6_1_98.userData.sculptComponent = { id: "reach-ring-A6-1" };
  node_reach_ring_A6_1_98.userData.actionProfile = {};
  (nodes["reach-rod-A6-1"] ?? root).add(node_reach_ring_A6_1_98);
  nodes["reach-ring-A6-1"] = node_reach_ring_A6_1_98;
  const mesh_reach_ring_A6_1_98Geometry = endpoint_reach_ring_A6_1_98
    ? new THREE.CylinderGeometry(endpoint_reach_ring_A6_1_98.endRadius, endpoint_reach_ring_A6_1_98.baseRadius, endpoint_reach_ring_A6_1_98.length, 8, 4)
    : new THREE.TorusGeometry(0.45, 0.0614, 8, 16);
  if (!endpoint_reach_ring_A6_1_98) {
    mesh_reach_ring_A6_1_98Geometry.scale(0.07699, 0.07699, 0.07699);
  }
  const mesh_reach_ring_A6_1_98 = new THREE.Mesh(
    mesh_reach_ring_A6_1_98Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_ring_A6_1_98.name = "Joint ring A6 1";
  if (endpoint_reach_ring_A6_1_98) {
    mesh_reach_ring_A6_1_98.position.copy(endpoint_reach_ring_A6_1_98.midpoint);
    mesh_reach_ring_A6_1_98.quaternion.copy(endpoint_reach_ring_A6_1_98.quaternion);
  }
  mesh_reach_ring_A6_1_98.castShadow = options.castShadow ?? true;
  mesh_reach_ring_A6_1_98.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_ring_A6_1_98.userData.sculptComponent = { id: "reach-ring-A6-1" };
  node_reach_ring_A6_1_98.add(mesh_reach_ring_A6_1_98);
  meshes["reach-ring-A6-1"] = mesh_reach_ring_A6_1_98;
  colliders["reach-ring-A6-1"] = {};
  destructionGroups["reach-A6"] ??= [];
  destructionGroups["reach-A6"].push(node_reach_ring_A6_1_98);

  const attachment_reach_rod_A6_2_99 = {"parentSocket": "reach-rod-A6-1-reach-rod-A6-2", "localStart": [0.08819, -0.17638, 0.0252], "localEnd": [-0.0063, -0.27717, 0.0315], "contactType": "hinge-joint", "baseRadius": 0.02362, "endRadius": 0.0189, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_reach_rod_A6_2_99 = makeAttachmentEndpoint(attachment_reach_rod_A6_2_99);
  const node_reach_rod_A6_2_99 = new THREE.Group();
  node_reach_rod_A6_2_99.name = "Reach rod A6 2__pivot";
  node_reach_rod_A6_2_99.scale.set(1, 1, 1);
  if (endpoint_reach_rod_A6_2_99) {
    node_reach_rod_A6_2_99.position.copy(endpoint_reach_rod_A6_2_99.start);
    node_reach_rod_A6_2_99.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_reach_rod_A6_2_99.position.set(0.08819, -0.17638, 0.0252);
    node_reach_rod_A6_2_99.rotation.set(0.0, 0.0, 0.0);
  }
  node_reach_rod_A6_2_99.userData.sculptComponent = { id: "reach-rod-A6-2" };
  node_reach_rod_A6_2_99.userData.actionProfile = {};
  (nodes["reach-rod-A6-1"] ?? root).add(node_reach_rod_A6_2_99);
  nodes["reach-rod-A6-2"] = node_reach_rod_A6_2_99;
  const mesh_reach_rod_A6_2_99Geometry = endpoint_reach_rod_A6_2_99
    ? new THREE.CylinderGeometry(endpoint_reach_rod_A6_2_99.endRadius, endpoint_reach_rod_A6_2_99.baseRadius, endpoint_reach_rod_A6_2_99.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_reach_rod_A6_2_99) {
    mesh_reach_rod_A6_2_99Geometry.scale(0.04724, 0.1383, 0.04724);
  }
  const mesh_reach_rod_A6_2_99 = new THREE.Mesh(
    mesh_reach_rod_A6_2_99Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_rod_A6_2_99.name = "Reach rod A6 2";
  if (endpoint_reach_rod_A6_2_99) {
    mesh_reach_rod_A6_2_99.position.copy(endpoint_reach_rod_A6_2_99.midpoint);
    mesh_reach_rod_A6_2_99.quaternion.copy(endpoint_reach_rod_A6_2_99.quaternion);
  }
  mesh_reach_rod_A6_2_99.castShadow = options.castShadow ?? true;
  mesh_reach_rod_A6_2_99.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_rod_A6_2_99.userData.sculptComponent = { id: "reach-rod-A6-2" };
  node_reach_rod_A6_2_99.add(mesh_reach_rod_A6_2_99);
  meshes["reach-rod-A6-2"] = mesh_reach_rod_A6_2_99;
  colliders["reach-rod-A6-2"] = {};
  destructionGroups["reach-A6"] ??= [];
  destructionGroups["reach-A6"].push(node_reach_rod_A6_2_99);

  const endpoint_reach_joint_A6_3_100 = makeAttachmentEndpoint(null);
  const node_reach_joint_A6_3_100 = new THREE.Group();
  node_reach_joint_A6_3_100.name = "Reach joint A6 3__pivot";
  node_reach_joint_A6_3_100.scale.set(1, 1, 1);
  if (endpoint_reach_joint_A6_3_100) {
    node_reach_joint_A6_3_100.position.copy(endpoint_reach_joint_A6_3_100.start);
    node_reach_joint_A6_3_100.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_reach_joint_A6_3_100.position.set(-0.09449, -0.10079, 0.0063);
    node_reach_joint_A6_3_100.rotation.set(0.0, 0.0, 0.0);
  }
  node_reach_joint_A6_3_100.userData.sculptComponent = { id: "reach-joint-A6-3" };
  node_reach_joint_A6_3_100.userData.actionProfile = {};
  (nodes["reach-rod-A6-2"] ?? root).add(node_reach_joint_A6_3_100);
  nodes["reach-joint-A6-3"] = node_reach_joint_A6_3_100;
  const mesh_reach_joint_A6_3_100Geometry = endpoint_reach_joint_A6_3_100
    ? new THREE.CylinderGeometry(endpoint_reach_joint_A6_3_100.endRadius, endpoint_reach_joint_A6_3_100.baseRadius, endpoint_reach_joint_A6_3_100.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_reach_joint_A6_3_100) {
    mesh_reach_joint_A6_3_100Geometry.scale(0.04094, 0.04094, 0.04094);
  }
  const mesh_reach_joint_A6_3_100 = new THREE.Mesh(
    mesh_reach_joint_A6_3_100Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_joint_A6_3_100.name = "Reach joint A6 3";
  if (endpoint_reach_joint_A6_3_100) {
    mesh_reach_joint_A6_3_100.position.copy(endpoint_reach_joint_A6_3_100.midpoint);
    mesh_reach_joint_A6_3_100.quaternion.copy(endpoint_reach_joint_A6_3_100.quaternion);
  }
  mesh_reach_joint_A6_3_100.castShadow = options.castShadow ?? true;
  mesh_reach_joint_A6_3_100.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_joint_A6_3_100.userData.sculptComponent = { id: "reach-joint-A6-3" };
  node_reach_joint_A6_3_100.add(mesh_reach_joint_A6_3_100);
  meshes["reach-joint-A6-3"] = mesh_reach_joint_A6_3_100;
  colliders["reach-joint-A6-3"] = {};
  destructionGroups["reach-A6"] ??= [];
  destructionGroups["reach-A6"].push(node_reach_joint_A6_3_100);

  const endpoint_reach_ring_A6_2_101 = makeAttachmentEndpoint(null);
  const node_reach_ring_A6_2_101 = new THREE.Group();
  node_reach_ring_A6_2_101.name = "Joint ring A6 2__pivot";
  node_reach_ring_A6_2_101.scale.set(1, 1, 1);
  if (endpoint_reach_ring_A6_2_101) {
    node_reach_ring_A6_2_101.position.copy(endpoint_reach_ring_A6_2_101.start);
    node_reach_ring_A6_2_101.rotation.set(1.50838, -0.75218, 0.0);
  } else {
    node_reach_ring_A6_2_101.position.set(-0.04724, -0.05039, 0.00315);
    node_reach_ring_A6_2_101.rotation.set(1.50838, -0.75218, 0.0);
  }
  node_reach_ring_A6_2_101.userData.sculptComponent = { id: "reach-ring-A6-2" };
  node_reach_ring_A6_2_101.userData.actionProfile = {};
  (nodes["reach-rod-A6-2"] ?? root).add(node_reach_ring_A6_2_101);
  nodes["reach-ring-A6-2"] = node_reach_ring_A6_2_101;
  const mesh_reach_ring_A6_2_101Geometry = endpoint_reach_ring_A6_2_101
    ? new THREE.CylinderGeometry(endpoint_reach_ring_A6_2_101.endRadius, endpoint_reach_ring_A6_2_101.baseRadius, endpoint_reach_ring_A6_2_101.length, 8, 4)
    : new THREE.TorusGeometry(0.45, 0.0614, 8, 16);
  if (!endpoint_reach_ring_A6_2_101) {
    mesh_reach_ring_A6_2_101Geometry.scale(0.07699, 0.07699, 0.07699);
  }
  const mesh_reach_ring_A6_2_101 = new THREE.Mesh(
    mesh_reach_ring_A6_2_101Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_ring_A6_2_101.name = "Joint ring A6 2";
  if (endpoint_reach_ring_A6_2_101) {
    mesh_reach_ring_A6_2_101.position.copy(endpoint_reach_ring_A6_2_101.midpoint);
    mesh_reach_ring_A6_2_101.quaternion.copy(endpoint_reach_ring_A6_2_101.quaternion);
  }
  mesh_reach_ring_A6_2_101.castShadow = options.castShadow ?? true;
  mesh_reach_ring_A6_2_101.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_ring_A6_2_101.userData.sculptComponent = { id: "reach-ring-A6-2" };
  node_reach_ring_A6_2_101.add(mesh_reach_ring_A6_2_101);
  meshes["reach-ring-A6-2"] = mesh_reach_ring_A6_2_101;
  colliders["reach-ring-A6-2"] = {};
  destructionGroups["reach-A6"] ??= [];
  destructionGroups["reach-A6"].push(node_reach_ring_A6_2_101);

  const endpoint_reach_grip_A6_102 = makeAttachmentEndpoint(null);
  const node_reach_grip_A6_102 = new THREE.Group();
  node_reach_grip_A6_102.name = "Grip block A6__pivot";
  node_reach_grip_A6_102.scale.set(1, 1, 1);
  if (endpoint_reach_grip_A6_102) {
    node_reach_grip_A6_102.position.copy(endpoint_reach_grip_A6_102.start);
    node_reach_grip_A6_102.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_reach_grip_A6_102.position.set(-0.09449, -0.10079, 0.0063);
    node_reach_grip_A6_102.rotation.set(0.0, 0.0, 0.0);
  }
  node_reach_grip_A6_102.userData.sculptComponent = { id: "reach-grip-A6" };
  node_reach_grip_A6_102.userData.actionProfile = {};
  (nodes["reach-rod-A6-2"] ?? root).add(node_reach_grip_A6_102);
  nodes["reach-grip-A6"] = node_reach_grip_A6_102;
  const mesh_reach_grip_A6_102Geometry = endpoint_reach_grip_A6_102
    ? new THREE.CylinderGeometry(endpoint_reach_grip_A6_102.endRadius, endpoint_reach_grip_A6_102.baseRadius, endpoint_reach_grip_A6_102.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_reach_grip_A6_102) {
    mesh_reach_grip_A6_102Geometry.scale(0.06929, 0.05039, 0.04409);
  }
  const mesh_reach_grip_A6_102 = new THREE.Mesh(
    mesh_reach_grip_A6_102Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_grip_A6_102.name = "Grip block A6";
  if (endpoint_reach_grip_A6_102) {
    mesh_reach_grip_A6_102.position.copy(endpoint_reach_grip_A6_102.midpoint);
    mesh_reach_grip_A6_102.quaternion.copy(endpoint_reach_grip_A6_102.quaternion);
  }
  mesh_reach_grip_A6_102.castShadow = options.castShadow ?? true;
  mesh_reach_grip_A6_102.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_grip_A6_102.userData.sculptComponent = { id: "reach-grip-A6" };
  node_reach_grip_A6_102.add(mesh_reach_grip_A6_102);
  meshes["reach-grip-A6"] = mesh_reach_grip_A6_102;
  colliders["reach-grip-A6"] = {};
  destructionGroups["reach-A6"] ??= [];
  destructionGroups["reach-A6"].push(node_reach_grip_A6_102);

  const endpoint_reach_grip_glow_A6_103 = makeAttachmentEndpoint(null);
  const node_reach_grip_glow_A6_103 = new THREE.Group();
  node_reach_grip_glow_A6_103.name = "Grip glow A6__pivot";
  node_reach_grip_glow_A6_103.scale.set(1, 1, 1);
  if (endpoint_reach_grip_glow_A6_103) {
    node_reach_grip_glow_A6_103.position.copy(endpoint_reach_grip_glow_A6_103.start);
    node_reach_grip_glow_A6_103.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_reach_grip_glow_A6_103.position.set(0.0, 0.0, 0.0252);
    node_reach_grip_glow_A6_103.rotation.set(0.0, 0.0, 0.0);
  }
  node_reach_grip_glow_A6_103.userData.sculptComponent = { id: "reach-grip-glow-A6" };
  node_reach_grip_glow_A6_103.userData.actionProfile = {};
  (nodes["reach-grip-A6"] ?? root).add(node_reach_grip_glow_A6_103);
  nodes["reach-grip-glow-A6"] = node_reach_grip_glow_A6_103;
  const mesh_reach_grip_glow_A6_103Geometry = endpoint_reach_grip_glow_A6_103
    ? new THREE.CylinderGeometry(endpoint_reach_grip_glow_A6_103.endRadius, endpoint_reach_grip_glow_A6_103.baseRadius, endpoint_reach_grip_glow_A6_103.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_reach_grip_glow_A6_103) {
    mesh_reach_grip_glow_A6_103Geometry.scale(0.04409, 0.00945, 0.0063);
  }
  const mesh_reach_grip_glow_A6_103 = new THREE.Mesh(
    mesh_reach_grip_glow_A6_103Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_grip_glow_A6_103.name = "Grip glow A6";
  if (endpoint_reach_grip_glow_A6_103) {
    mesh_reach_grip_glow_A6_103.position.copy(endpoint_reach_grip_glow_A6_103.midpoint);
    mesh_reach_grip_glow_A6_103.quaternion.copy(endpoint_reach_grip_glow_A6_103.quaternion);
  }
  mesh_reach_grip_glow_A6_103.castShadow = options.castShadow ?? true;
  mesh_reach_grip_glow_A6_103.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_grip_glow_A6_103.userData.sculptComponent = { id: "reach-grip-glow-A6" };
  node_reach_grip_glow_A6_103.add(mesh_reach_grip_glow_A6_103);
  meshes["reach-grip-glow-A6"] = mesh_reach_grip_glow_A6_103;
  colliders["reach-grip-glow-A6"] = {};
  destructionGroups["reach-A6"] ??= [];
  destructionGroups["reach-A6"].push(node_reach_grip_glow_A6_103);

  const endpoint_reach_joint_B1_0_104 = makeAttachmentEndpoint(null);
  const node_reach_joint_B1_0_104 = new THREE.Group();
  node_reach_joint_B1_0_104.name = "Reach joint B1 0__pivot";
  node_reach_joint_B1_0_104.scale.set(1, 1, 1);
  if (endpoint_reach_joint_B1_0_104) {
    node_reach_joint_B1_0_104.position.copy(endpoint_reach_joint_B1_0_104.start);
    node_reach_joint_B1_0_104.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_reach_joint_B1_0_104.position.set(-0.15748, 0.14488, -0.0315);
    node_reach_joint_B1_0_104.rotation.set(0.0, 0.0, 0.0);
  }
  node_reach_joint_B1_0_104.userData.sculptComponent = { id: "reach-joint-B1-0" };
  node_reach_joint_B1_0_104.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_reach_joint_B1_0_104);
  nodes["reach-joint-B1-0"] = node_reach_joint_B1_0_104;
  const mesh_reach_joint_B1_0_104Geometry = endpoint_reach_joint_B1_0_104
    ? new THREE.CylinderGeometry(endpoint_reach_joint_B1_0_104.endRadius, endpoint_reach_joint_B1_0_104.baseRadius, endpoint_reach_joint_B1_0_104.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_reach_joint_B1_0_104) {
    mesh_reach_joint_B1_0_104Geometry.scale(0.05669, 0.05669, 0.05669);
  }
  const mesh_reach_joint_B1_0_104 = new THREE.Mesh(
    mesh_reach_joint_B1_0_104Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_joint_B1_0_104.name = "Reach joint B1 0";
  if (endpoint_reach_joint_B1_0_104) {
    mesh_reach_joint_B1_0_104.position.copy(endpoint_reach_joint_B1_0_104.midpoint);
    mesh_reach_joint_B1_0_104.quaternion.copy(endpoint_reach_joint_B1_0_104.quaternion);
  }
  mesh_reach_joint_B1_0_104.castShadow = options.castShadow ?? true;
  mesh_reach_joint_B1_0_104.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_joint_B1_0_104.userData.sculptComponent = { id: "reach-joint-B1-0" };
  node_reach_joint_B1_0_104.add(mesh_reach_joint_B1_0_104);
  meshes["reach-joint-B1-0"] = mesh_reach_joint_B1_0_104;
  colliders["reach-joint-B1-0"] = {};
  destructionGroups["reach-B1"] ??= [];
  destructionGroups["reach-B1"].push(node_reach_joint_B1_0_104);

  const attachment_reach_rod_B1_0_105 = {"parentSocket": "chest-reach-rod-B1-0", "localStart": [-0.15748, 0.14488, -0.0315], "localEnd": [-0.28346, 0.0189, -0.10079], "contactType": "hinge-joint", "baseRadius": 0.02362, "endRadius": 0.0189, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_reach_rod_B1_0_105 = makeAttachmentEndpoint(attachment_reach_rod_B1_0_105);
  const node_reach_rod_B1_0_105 = new THREE.Group();
  node_reach_rod_B1_0_105.name = "Reach rod B1 0__pivot";
  node_reach_rod_B1_0_105.scale.set(1, 1, 1);
  if (endpoint_reach_rod_B1_0_105) {
    node_reach_rod_B1_0_105.position.copy(endpoint_reach_rod_B1_0_105.start);
    node_reach_rod_B1_0_105.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_reach_rod_B1_0_105.position.set(-0.15748, 0.14488, -0.0315);
    node_reach_rod_B1_0_105.rotation.set(0.0, 0.0, 0.0);
  }
  node_reach_rod_B1_0_105.userData.sculptComponent = { id: "reach-rod-B1-0" };
  node_reach_rod_B1_0_105.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_reach_rod_B1_0_105);
  nodes["reach-rod-B1-0"] = node_reach_rod_B1_0_105;
  const mesh_reach_rod_B1_0_105Geometry = endpoint_reach_rod_B1_0_105
    ? new THREE.CylinderGeometry(endpoint_reach_rod_B1_0_105.endRadius, endpoint_reach_rod_B1_0_105.baseRadius, endpoint_reach_rod_B1_0_105.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_reach_rod_B1_0_105) {
    mesh_reach_rod_B1_0_105Geometry.scale(0.04724, 0.19117, 0.04724);
  }
  const mesh_reach_rod_B1_0_105 = new THREE.Mesh(
    mesh_reach_rod_B1_0_105Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_rod_B1_0_105.name = "Reach rod B1 0";
  if (endpoint_reach_rod_B1_0_105) {
    mesh_reach_rod_B1_0_105.position.copy(endpoint_reach_rod_B1_0_105.midpoint);
    mesh_reach_rod_B1_0_105.quaternion.copy(endpoint_reach_rod_B1_0_105.quaternion);
  }
  mesh_reach_rod_B1_0_105.castShadow = options.castShadow ?? true;
  mesh_reach_rod_B1_0_105.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_rod_B1_0_105.userData.sculptComponent = { id: "reach-rod-B1-0" };
  node_reach_rod_B1_0_105.add(mesh_reach_rod_B1_0_105);
  meshes["reach-rod-B1-0"] = mesh_reach_rod_B1_0_105;
  colliders["reach-rod-B1-0"] = {};
  destructionGroups["reach-B1"] ??= [];
  destructionGroups["reach-B1"].push(node_reach_rod_B1_0_105);

  const endpoint_reach_joint_B1_1_106 = makeAttachmentEndpoint(null);
  const node_reach_joint_B1_1_106 = new THREE.Group();
  node_reach_joint_B1_1_106.name = "Reach joint B1 1__pivot";
  node_reach_joint_B1_1_106.scale.set(1, 1, 1);
  if (endpoint_reach_joint_B1_1_106) {
    node_reach_joint_B1_1_106.position.copy(endpoint_reach_joint_B1_1_106.start);
    node_reach_joint_B1_1_106.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_reach_joint_B1_1_106.position.set(-0.12598, -0.12598, -0.06929);
    node_reach_joint_B1_1_106.rotation.set(0.0, 0.0, 0.0);
  }
  node_reach_joint_B1_1_106.userData.sculptComponent = { id: "reach-joint-B1-1" };
  node_reach_joint_B1_1_106.userData.actionProfile = {};
  (nodes["reach-rod-B1-0"] ?? root).add(node_reach_joint_B1_1_106);
  nodes["reach-joint-B1-1"] = node_reach_joint_B1_1_106;
  const mesh_reach_joint_B1_1_106Geometry = endpoint_reach_joint_B1_1_106
    ? new THREE.CylinderGeometry(endpoint_reach_joint_B1_1_106.endRadius, endpoint_reach_joint_B1_1_106.baseRadius, endpoint_reach_joint_B1_1_106.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_reach_joint_B1_1_106) {
    mesh_reach_joint_B1_1_106Geometry.scale(0.05354, 0.05354, 0.05354);
  }
  const mesh_reach_joint_B1_1_106 = new THREE.Mesh(
    mesh_reach_joint_B1_1_106Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_joint_B1_1_106.name = "Reach joint B1 1";
  if (endpoint_reach_joint_B1_1_106) {
    mesh_reach_joint_B1_1_106.position.copy(endpoint_reach_joint_B1_1_106.midpoint);
    mesh_reach_joint_B1_1_106.quaternion.copy(endpoint_reach_joint_B1_1_106.quaternion);
  }
  mesh_reach_joint_B1_1_106.castShadow = options.castShadow ?? true;
  mesh_reach_joint_B1_1_106.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_joint_B1_1_106.userData.sculptComponent = { id: "reach-joint-B1-1" };
  node_reach_joint_B1_1_106.add(mesh_reach_joint_B1_1_106);
  meshes["reach-joint-B1-1"] = mesh_reach_joint_B1_1_106;
  colliders["reach-joint-B1-1"] = {};
  destructionGroups["reach-B1"] ??= [];
  destructionGroups["reach-B1"].push(node_reach_joint_B1_1_106);

  const endpoint_reach_ring_B1_0_107 = makeAttachmentEndpoint(null);
  const node_reach_ring_B1_0_107 = new THREE.Group();
  node_reach_ring_B1_0_107.name = "Joint ring B1 0__pivot";
  node_reach_ring_B1_0_107.scale.set(1, 1, 1);
  if (endpoint_reach_ring_B1_0_107) {
    node_reach_ring_B1_0_107.position.copy(endpoint_reach_ring_B1_0_107.start);
    node_reach_ring_B1_0_107.rotation.set(2.07364, -0.71952, 0.0);
  } else {
    node_reach_ring_B1_0_107.position.set(-0.06299, -0.06299, -0.03465);
    node_reach_ring_B1_0_107.rotation.set(2.07364, -0.71952, 0.0);
  }
  node_reach_ring_B1_0_107.userData.sculptComponent = { id: "reach-ring-B1-0" };
  node_reach_ring_B1_0_107.userData.actionProfile = {};
  (nodes["reach-rod-B1-0"] ?? root).add(node_reach_ring_B1_0_107);
  nodes["reach-ring-B1-0"] = node_reach_ring_B1_0_107;
  const mesh_reach_ring_B1_0_107Geometry = endpoint_reach_ring_B1_0_107
    ? new THREE.CylinderGeometry(endpoint_reach_ring_B1_0_107.endRadius, endpoint_reach_ring_B1_0_107.baseRadius, endpoint_reach_ring_B1_0_107.length, 8, 4)
    : new THREE.TorusGeometry(0.45, 0.0614, 8, 16);
  if (!endpoint_reach_ring_B1_0_107) {
    mesh_reach_ring_B1_0_107Geometry.scale(0.07699, 0.07699, 0.07699);
  }
  const mesh_reach_ring_B1_0_107 = new THREE.Mesh(
    mesh_reach_ring_B1_0_107Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_ring_B1_0_107.name = "Joint ring B1 0";
  if (endpoint_reach_ring_B1_0_107) {
    mesh_reach_ring_B1_0_107.position.copy(endpoint_reach_ring_B1_0_107.midpoint);
    mesh_reach_ring_B1_0_107.quaternion.copy(endpoint_reach_ring_B1_0_107.quaternion);
  }
  mesh_reach_ring_B1_0_107.castShadow = options.castShadow ?? true;
  mesh_reach_ring_B1_0_107.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_ring_B1_0_107.userData.sculptComponent = { id: "reach-ring-B1-0" };
  node_reach_ring_B1_0_107.add(mesh_reach_ring_B1_0_107);
  meshes["reach-ring-B1-0"] = mesh_reach_ring_B1_0_107;
  colliders["reach-ring-B1-0"] = {};
  destructionGroups["reach-B1"] ??= [];
  destructionGroups["reach-B1"].push(node_reach_ring_B1_0_107);

  const attachment_reach_rod_B1_1_108 = {"parentSocket": "reach-rod-B1-0-reach-rod-B1-1", "localStart": [-0.12598, -0.12598, -0.06929], "localEnd": [-0.16378, -0.31496, -0.13228], "contactType": "hinge-joint", "baseRadius": 0.02362, "endRadius": 0.0189, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_reach_rod_B1_1_108 = makeAttachmentEndpoint(attachment_reach_rod_B1_1_108);
  const node_reach_rod_B1_1_108 = new THREE.Group();
  node_reach_rod_B1_1_108.name = "Reach rod B1 1__pivot";
  node_reach_rod_B1_1_108.scale.set(1, 1, 1);
  if (endpoint_reach_rod_B1_1_108) {
    node_reach_rod_B1_1_108.position.copy(endpoint_reach_rod_B1_1_108.start);
    node_reach_rod_B1_1_108.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_reach_rod_B1_1_108.position.set(-0.12598, -0.12598, -0.06929);
    node_reach_rod_B1_1_108.rotation.set(0.0, 0.0, 0.0);
  }
  node_reach_rod_B1_1_108.userData.sculptComponent = { id: "reach-rod-B1-1" };
  node_reach_rod_B1_1_108.userData.actionProfile = {};
  (nodes["reach-rod-B1-0"] ?? root).add(node_reach_rod_B1_1_108);
  nodes["reach-rod-B1-1"] = node_reach_rod_B1_1_108;
  const mesh_reach_rod_B1_1_108Geometry = endpoint_reach_rod_B1_1_108
    ? new THREE.CylinderGeometry(endpoint_reach_rod_B1_1_108.endRadius, endpoint_reach_rod_B1_1_108.baseRadius, endpoint_reach_rod_B1_1_108.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_reach_rod_B1_1_108) {
    mesh_reach_rod_B1_1_108Geometry.scale(0.04724, 0.20275, 0.04724);
  }
  const mesh_reach_rod_B1_1_108 = new THREE.Mesh(
    mesh_reach_rod_B1_1_108Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_rod_B1_1_108.name = "Reach rod B1 1";
  if (endpoint_reach_rod_B1_1_108) {
    mesh_reach_rod_B1_1_108.position.copy(endpoint_reach_rod_B1_1_108.midpoint);
    mesh_reach_rod_B1_1_108.quaternion.copy(endpoint_reach_rod_B1_1_108.quaternion);
  }
  mesh_reach_rod_B1_1_108.castShadow = options.castShadow ?? true;
  mesh_reach_rod_B1_1_108.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_rod_B1_1_108.userData.sculptComponent = { id: "reach-rod-B1-1" };
  node_reach_rod_B1_1_108.add(mesh_reach_rod_B1_1_108);
  meshes["reach-rod-B1-1"] = mesh_reach_rod_B1_1_108;
  colliders["reach-rod-B1-1"] = {};
  destructionGroups["reach-B1"] ??= [];
  destructionGroups["reach-B1"].push(node_reach_rod_B1_1_108);

  const endpoint_reach_joint_B1_2_109 = makeAttachmentEndpoint(null);
  const node_reach_joint_B1_2_109 = new THREE.Group();
  node_reach_joint_B1_2_109.name = "Reach joint B1 2__pivot";
  node_reach_joint_B1_2_109.scale.set(1, 1, 1);
  if (endpoint_reach_joint_B1_2_109) {
    node_reach_joint_B1_2_109.position.copy(endpoint_reach_joint_B1_2_109.start);
    node_reach_joint_B1_2_109.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_reach_joint_B1_2_109.position.set(-0.0378, -0.18898, -0.06299);
    node_reach_joint_B1_2_109.rotation.set(0.0, 0.0, 0.0);
  }
  node_reach_joint_B1_2_109.userData.sculptComponent = { id: "reach-joint-B1-2" };
  node_reach_joint_B1_2_109.userData.actionProfile = {};
  (nodes["reach-rod-B1-1"] ?? root).add(node_reach_joint_B1_2_109);
  nodes["reach-joint-B1-2"] = node_reach_joint_B1_2_109;
  const mesh_reach_joint_B1_2_109Geometry = endpoint_reach_joint_B1_2_109
    ? new THREE.CylinderGeometry(endpoint_reach_joint_B1_2_109.endRadius, endpoint_reach_joint_B1_2_109.baseRadius, endpoint_reach_joint_B1_2_109.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_reach_joint_B1_2_109) {
    mesh_reach_joint_B1_2_109Geometry.scale(0.04724, 0.04724, 0.04724);
  }
  const mesh_reach_joint_B1_2_109 = new THREE.Mesh(
    mesh_reach_joint_B1_2_109Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_joint_B1_2_109.name = "Reach joint B1 2";
  if (endpoint_reach_joint_B1_2_109) {
    mesh_reach_joint_B1_2_109.position.copy(endpoint_reach_joint_B1_2_109.midpoint);
    mesh_reach_joint_B1_2_109.quaternion.copy(endpoint_reach_joint_B1_2_109.quaternion);
  }
  mesh_reach_joint_B1_2_109.castShadow = options.castShadow ?? true;
  mesh_reach_joint_B1_2_109.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_joint_B1_2_109.userData.sculptComponent = { id: "reach-joint-B1-2" };
  node_reach_joint_B1_2_109.add(mesh_reach_joint_B1_2_109);
  meshes["reach-joint-B1-2"] = mesh_reach_joint_B1_2_109;
  colliders["reach-joint-B1-2"] = {};
  destructionGroups["reach-B1"] ??= [];
  destructionGroups["reach-B1"].push(node_reach_joint_B1_2_109);

  const endpoint_reach_ring_B1_1_110 = makeAttachmentEndpoint(null);
  const node_reach_ring_B1_1_110 = new THREE.Group();
  node_reach_ring_B1_1_110.name = "Joint ring B1 1__pivot";
  node_reach_ring_B1_1_110.scale.set(1, 1, 1);
  if (endpoint_reach_ring_B1_1_110) {
    node_reach_ring_B1_1_110.position.copy(endpoint_reach_ring_B1_1_110.start);
    node_reach_ring_B1_1_110.rotation.set(1.89255, -0.18751, 0.0);
  } else {
    node_reach_ring_B1_1_110.position.set(-0.0189, -0.09449, -0.0315);
    node_reach_ring_B1_1_110.rotation.set(1.89255, -0.18751, 0.0);
  }
  node_reach_ring_B1_1_110.userData.sculptComponent = { id: "reach-ring-B1-1" };
  node_reach_ring_B1_1_110.userData.actionProfile = {};
  (nodes["reach-rod-B1-1"] ?? root).add(node_reach_ring_B1_1_110);
  nodes["reach-ring-B1-1"] = node_reach_ring_B1_1_110;
  const mesh_reach_ring_B1_1_110Geometry = endpoint_reach_ring_B1_1_110
    ? new THREE.CylinderGeometry(endpoint_reach_ring_B1_1_110.endRadius, endpoint_reach_ring_B1_1_110.baseRadius, endpoint_reach_ring_B1_1_110.length, 8, 4)
    : new THREE.TorusGeometry(0.45, 0.0614, 8, 16);
  if (!endpoint_reach_ring_B1_1_110) {
    mesh_reach_ring_B1_1_110Geometry.scale(0.07699, 0.07699, 0.07699);
  }
  const mesh_reach_ring_B1_1_110 = new THREE.Mesh(
    mesh_reach_ring_B1_1_110Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_ring_B1_1_110.name = "Joint ring B1 1";
  if (endpoint_reach_ring_B1_1_110) {
    mesh_reach_ring_B1_1_110.position.copy(endpoint_reach_ring_B1_1_110.midpoint);
    mesh_reach_ring_B1_1_110.quaternion.copy(endpoint_reach_ring_B1_1_110.quaternion);
  }
  mesh_reach_ring_B1_1_110.castShadow = options.castShadow ?? true;
  mesh_reach_ring_B1_1_110.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_ring_B1_1_110.userData.sculptComponent = { id: "reach-ring-B1-1" };
  node_reach_ring_B1_1_110.add(mesh_reach_ring_B1_1_110);
  meshes["reach-ring-B1-1"] = mesh_reach_ring_B1_1_110;
  colliders["reach-ring-B1-1"] = {};
  destructionGroups["reach-B1"] ??= [];
  destructionGroups["reach-B1"].push(node_reach_ring_B1_1_110);

  const endpoint_reach_grip_B1_111 = makeAttachmentEndpoint(null);
  const node_reach_grip_B1_111 = new THREE.Group();
  node_reach_grip_B1_111.name = "Grip block B1__pivot";
  node_reach_grip_B1_111.scale.set(1, 1, 1);
  if (endpoint_reach_grip_B1_111) {
    node_reach_grip_B1_111.position.copy(endpoint_reach_grip_B1_111.start);
    node_reach_grip_B1_111.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_reach_grip_B1_111.position.set(-0.0378, -0.18898, -0.06299);
    node_reach_grip_B1_111.rotation.set(0.0, 0.0, 0.0);
  }
  node_reach_grip_B1_111.userData.sculptComponent = { id: "reach-grip-B1" };
  node_reach_grip_B1_111.userData.actionProfile = {};
  (nodes["reach-rod-B1-1"] ?? root).add(node_reach_grip_B1_111);
  nodes["reach-grip-B1"] = node_reach_grip_B1_111;
  const mesh_reach_grip_B1_111Geometry = endpoint_reach_grip_B1_111
    ? new THREE.CylinderGeometry(endpoint_reach_grip_B1_111.endRadius, endpoint_reach_grip_B1_111.baseRadius, endpoint_reach_grip_B1_111.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_reach_grip_B1_111) {
    mesh_reach_grip_B1_111Geometry.scale(0.06929, 0.05039, 0.04409);
  }
  const mesh_reach_grip_B1_111 = new THREE.Mesh(
    mesh_reach_grip_B1_111Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_grip_B1_111.name = "Grip block B1";
  if (endpoint_reach_grip_B1_111) {
    mesh_reach_grip_B1_111.position.copy(endpoint_reach_grip_B1_111.midpoint);
    mesh_reach_grip_B1_111.quaternion.copy(endpoint_reach_grip_B1_111.quaternion);
  }
  mesh_reach_grip_B1_111.castShadow = options.castShadow ?? true;
  mesh_reach_grip_B1_111.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_grip_B1_111.userData.sculptComponent = { id: "reach-grip-B1" };
  node_reach_grip_B1_111.add(mesh_reach_grip_B1_111);
  meshes["reach-grip-B1"] = mesh_reach_grip_B1_111;
  colliders["reach-grip-B1"] = {};
  destructionGroups["reach-B1"] ??= [];
  destructionGroups["reach-B1"].push(node_reach_grip_B1_111);

  const endpoint_reach_grip_glow_B1_112 = makeAttachmentEndpoint(null);
  const node_reach_grip_glow_B1_112 = new THREE.Group();
  node_reach_grip_glow_B1_112.name = "Grip glow B1__pivot";
  node_reach_grip_glow_B1_112.scale.set(1, 1, 1);
  if (endpoint_reach_grip_glow_B1_112) {
    node_reach_grip_glow_B1_112.position.copy(endpoint_reach_grip_glow_B1_112.start);
    node_reach_grip_glow_B1_112.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_reach_grip_glow_B1_112.position.set(0.0, 0.0, 0.0252);
    node_reach_grip_glow_B1_112.rotation.set(0.0, 0.0, 0.0);
  }
  node_reach_grip_glow_B1_112.userData.sculptComponent = { id: "reach-grip-glow-B1" };
  node_reach_grip_glow_B1_112.userData.actionProfile = {};
  (nodes["reach-grip-B1"] ?? root).add(node_reach_grip_glow_B1_112);
  nodes["reach-grip-glow-B1"] = node_reach_grip_glow_B1_112;
  const mesh_reach_grip_glow_B1_112Geometry = endpoint_reach_grip_glow_B1_112
    ? new THREE.CylinderGeometry(endpoint_reach_grip_glow_B1_112.endRadius, endpoint_reach_grip_glow_B1_112.baseRadius, endpoint_reach_grip_glow_B1_112.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_reach_grip_glow_B1_112) {
    mesh_reach_grip_glow_B1_112Geometry.scale(0.04409, 0.00945, 0.0063);
  }
  const mesh_reach_grip_glow_B1_112 = new THREE.Mesh(
    mesh_reach_grip_glow_B1_112Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_grip_glow_B1_112.name = "Grip glow B1";
  if (endpoint_reach_grip_glow_B1_112) {
    mesh_reach_grip_glow_B1_112.position.copy(endpoint_reach_grip_glow_B1_112.midpoint);
    mesh_reach_grip_glow_B1_112.quaternion.copy(endpoint_reach_grip_glow_B1_112.quaternion);
  }
  mesh_reach_grip_glow_B1_112.castShadow = options.castShadow ?? true;
  mesh_reach_grip_glow_B1_112.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_grip_glow_B1_112.userData.sculptComponent = { id: "reach-grip-glow-B1" };
  node_reach_grip_glow_B1_112.add(mesh_reach_grip_glow_B1_112);
  meshes["reach-grip-glow-B1"] = mesh_reach_grip_glow_B1_112;
  colliders["reach-grip-glow-B1"] = {};
  destructionGroups["reach-B1"] ??= [];
  destructionGroups["reach-B1"].push(node_reach_grip_glow_B1_112);

  const endpoint_reach_joint_B2_0_113 = makeAttachmentEndpoint(null);
  const node_reach_joint_B2_0_113 = new THREE.Group();
  node_reach_joint_B2_0_113.name = "Reach joint B2 0__pivot";
  node_reach_joint_B2_0_113.scale.set(1, 1, 1);
  if (endpoint_reach_joint_B2_0_113) {
    node_reach_joint_B2_0_113.position.copy(endpoint_reach_joint_B2_0_113.start);
    node_reach_joint_B2_0_113.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_reach_joint_B2_0_113.position.set(0.15118, 0.13858, -0.0315);
    node_reach_joint_B2_0_113.rotation.set(0.0, 0.0, 0.0);
  }
  node_reach_joint_B2_0_113.userData.sculptComponent = { id: "reach-joint-B2-0" };
  node_reach_joint_B2_0_113.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_reach_joint_B2_0_113);
  nodes["reach-joint-B2-0"] = node_reach_joint_B2_0_113;
  const mesh_reach_joint_B2_0_113Geometry = endpoint_reach_joint_B2_0_113
    ? new THREE.CylinderGeometry(endpoint_reach_joint_B2_0_113.endRadius, endpoint_reach_joint_B2_0_113.baseRadius, endpoint_reach_joint_B2_0_113.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_reach_joint_B2_0_113) {
    mesh_reach_joint_B2_0_113Geometry.scale(0.05669, 0.05669, 0.05669);
  }
  const mesh_reach_joint_B2_0_113 = new THREE.Mesh(
    mesh_reach_joint_B2_0_113Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_joint_B2_0_113.name = "Reach joint B2 0";
  if (endpoint_reach_joint_B2_0_113) {
    mesh_reach_joint_B2_0_113.position.copy(endpoint_reach_joint_B2_0_113.midpoint);
    mesh_reach_joint_B2_0_113.quaternion.copy(endpoint_reach_joint_B2_0_113.quaternion);
  }
  mesh_reach_joint_B2_0_113.castShadow = options.castShadow ?? true;
  mesh_reach_joint_B2_0_113.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_joint_B2_0_113.userData.sculptComponent = { id: "reach-joint-B2-0" };
  node_reach_joint_B2_0_113.add(mesh_reach_joint_B2_0_113);
  meshes["reach-joint-B2-0"] = mesh_reach_joint_B2_0_113;
  colliders["reach-joint-B2-0"] = {};
  destructionGroups["reach-B2"] ??= [];
  destructionGroups["reach-B2"].push(node_reach_joint_B2_0_113);

  const attachment_reach_rod_B2_0_114 = {"parentSocket": "chest-reach-rod-B2-0", "localStart": [0.15118, 0.13858, -0.0315], "localEnd": [0.28976, -0.0126, -0.09449], "contactType": "hinge-joint", "baseRadius": 0.02362, "endRadius": 0.0189, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_reach_rod_B2_0_114 = makeAttachmentEndpoint(attachment_reach_rod_B2_0_114);
  const node_reach_rod_B2_0_114 = new THREE.Group();
  node_reach_rod_B2_0_114.name = "Reach rod B2 0__pivot";
  node_reach_rod_B2_0_114.scale.set(1, 1, 1);
  if (endpoint_reach_rod_B2_0_114) {
    node_reach_rod_B2_0_114.position.copy(endpoint_reach_rod_B2_0_114.start);
    node_reach_rod_B2_0_114.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_reach_rod_B2_0_114.position.set(0.15118, 0.13858, -0.0315);
    node_reach_rod_B2_0_114.rotation.set(0.0, 0.0, 0.0);
  }
  node_reach_rod_B2_0_114.userData.sculptComponent = { id: "reach-rod-B2-0" };
  node_reach_rod_B2_0_114.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_reach_rod_B2_0_114);
  nodes["reach-rod-B2-0"] = node_reach_rod_B2_0_114;
  const mesh_reach_rod_B2_0_114Geometry = endpoint_reach_rod_B2_0_114
    ? new THREE.CylinderGeometry(endpoint_reach_rod_B2_0_114.endRadius, endpoint_reach_rod_B2_0_114.baseRadius, endpoint_reach_rod_B2_0_114.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_reach_rod_B2_0_114) {
    mesh_reach_rod_B2_0_114Geometry.scale(0.04724, 0.21454, 0.04724);
  }
  const mesh_reach_rod_B2_0_114 = new THREE.Mesh(
    mesh_reach_rod_B2_0_114Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_rod_B2_0_114.name = "Reach rod B2 0";
  if (endpoint_reach_rod_B2_0_114) {
    mesh_reach_rod_B2_0_114.position.copy(endpoint_reach_rod_B2_0_114.midpoint);
    mesh_reach_rod_B2_0_114.quaternion.copy(endpoint_reach_rod_B2_0_114.quaternion);
  }
  mesh_reach_rod_B2_0_114.castShadow = options.castShadow ?? true;
  mesh_reach_rod_B2_0_114.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_rod_B2_0_114.userData.sculptComponent = { id: "reach-rod-B2-0" };
  node_reach_rod_B2_0_114.add(mesh_reach_rod_B2_0_114);
  meshes["reach-rod-B2-0"] = mesh_reach_rod_B2_0_114;
  colliders["reach-rod-B2-0"] = {};
  destructionGroups["reach-B2"] ??= [];
  destructionGroups["reach-B2"].push(node_reach_rod_B2_0_114);

  const endpoint_reach_joint_B2_1_115 = makeAttachmentEndpoint(null);
  const node_reach_joint_B2_1_115 = new THREE.Group();
  node_reach_joint_B2_1_115.name = "Reach joint B2 1__pivot";
  node_reach_joint_B2_1_115.scale.set(1, 1, 1);
  if (endpoint_reach_joint_B2_1_115) {
    node_reach_joint_B2_1_115.position.copy(endpoint_reach_joint_B2_1_115.start);
    node_reach_joint_B2_1_115.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_reach_joint_B2_1_115.position.set(0.13858, -0.15118, -0.06299);
    node_reach_joint_B2_1_115.rotation.set(0.0, 0.0, 0.0);
  }
  node_reach_joint_B2_1_115.userData.sculptComponent = { id: "reach-joint-B2-1" };
  node_reach_joint_B2_1_115.userData.actionProfile = {};
  (nodes["reach-rod-B2-0"] ?? root).add(node_reach_joint_B2_1_115);
  nodes["reach-joint-B2-1"] = node_reach_joint_B2_1_115;
  const mesh_reach_joint_B2_1_115Geometry = endpoint_reach_joint_B2_1_115
    ? new THREE.CylinderGeometry(endpoint_reach_joint_B2_1_115.endRadius, endpoint_reach_joint_B2_1_115.baseRadius, endpoint_reach_joint_B2_1_115.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_reach_joint_B2_1_115) {
    mesh_reach_joint_B2_1_115Geometry.scale(0.05354, 0.05354, 0.05354);
  }
  const mesh_reach_joint_B2_1_115 = new THREE.Mesh(
    mesh_reach_joint_B2_1_115Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_joint_B2_1_115.name = "Reach joint B2 1";
  if (endpoint_reach_joint_B2_1_115) {
    mesh_reach_joint_B2_1_115.position.copy(endpoint_reach_joint_B2_1_115.midpoint);
    mesh_reach_joint_B2_1_115.quaternion.copy(endpoint_reach_joint_B2_1_115.quaternion);
  }
  mesh_reach_joint_B2_1_115.castShadow = options.castShadow ?? true;
  mesh_reach_joint_B2_1_115.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_joint_B2_1_115.userData.sculptComponent = { id: "reach-joint-B2-1" };
  node_reach_joint_B2_1_115.add(mesh_reach_joint_B2_1_115);
  meshes["reach-joint-B2-1"] = mesh_reach_joint_B2_1_115;
  colliders["reach-joint-B2-1"] = {};
  destructionGroups["reach-B2"] ??= [];
  destructionGroups["reach-B2"].push(node_reach_joint_B2_1_115);

  const endpoint_reach_ring_B2_0_116 = makeAttachmentEndpoint(null);
  const node_reach_ring_B2_0_116 = new THREE.Group();
  node_reach_ring_B2_0_116.name = "Joint ring B2 0__pivot";
  node_reach_ring_B2_0_116.scale.set(1, 1, 1);
  if (endpoint_reach_ring_B2_0_116) {
    node_reach_ring_B2_0_116.position.copy(endpoint_reach_ring_B2_0_116.start);
    node_reach_ring_B2_0_116.rotation.set(1.96559, 0.70226, 0.0);
  } else {
    node_reach_ring_B2_0_116.position.set(0.06929, -0.07559, -0.0315);
    node_reach_ring_B2_0_116.rotation.set(1.96559, 0.70226, 0.0);
  }
  node_reach_ring_B2_0_116.userData.sculptComponent = { id: "reach-ring-B2-0" };
  node_reach_ring_B2_0_116.userData.actionProfile = {};
  (nodes["reach-rod-B2-0"] ?? root).add(node_reach_ring_B2_0_116);
  nodes["reach-ring-B2-0"] = node_reach_ring_B2_0_116;
  const mesh_reach_ring_B2_0_116Geometry = endpoint_reach_ring_B2_0_116
    ? new THREE.CylinderGeometry(endpoint_reach_ring_B2_0_116.endRadius, endpoint_reach_ring_B2_0_116.baseRadius, endpoint_reach_ring_B2_0_116.length, 8, 4)
    : new THREE.TorusGeometry(0.45, 0.0614, 8, 16);
  if (!endpoint_reach_ring_B2_0_116) {
    mesh_reach_ring_B2_0_116Geometry.scale(0.07699, 0.07699, 0.07699);
  }
  const mesh_reach_ring_B2_0_116 = new THREE.Mesh(
    mesh_reach_ring_B2_0_116Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_ring_B2_0_116.name = "Joint ring B2 0";
  if (endpoint_reach_ring_B2_0_116) {
    mesh_reach_ring_B2_0_116.position.copy(endpoint_reach_ring_B2_0_116.midpoint);
    mesh_reach_ring_B2_0_116.quaternion.copy(endpoint_reach_ring_B2_0_116.quaternion);
  }
  mesh_reach_ring_B2_0_116.castShadow = options.castShadow ?? true;
  mesh_reach_ring_B2_0_116.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_ring_B2_0_116.userData.sculptComponent = { id: "reach-ring-B2-0" };
  node_reach_ring_B2_0_116.add(mesh_reach_ring_B2_0_116);
  meshes["reach-ring-B2-0"] = mesh_reach_ring_B2_0_116;
  colliders["reach-ring-B2-0"] = {};
  destructionGroups["reach-B2"] ??= [];
  destructionGroups["reach-B2"].push(node_reach_ring_B2_0_116);

  const attachment_reach_rod_B2_1_117 = {"parentSocket": "reach-rod-B2-0-reach-rod-B2-1", "localStart": [0.13858, -0.15118, -0.06299], "localEnd": [0.17638, -0.34016, -0.12598], "contactType": "hinge-joint", "baseRadius": 0.02362, "endRadius": 0.0189, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_reach_rod_B2_1_117 = makeAttachmentEndpoint(attachment_reach_rod_B2_1_117);
  const node_reach_rod_B2_1_117 = new THREE.Group();
  node_reach_rod_B2_1_117.name = "Reach rod B2 1__pivot";
  node_reach_rod_B2_1_117.scale.set(1, 1, 1);
  if (endpoint_reach_rod_B2_1_117) {
    node_reach_rod_B2_1_117.position.copy(endpoint_reach_rod_B2_1_117.start);
    node_reach_rod_B2_1_117.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_reach_rod_B2_1_117.position.set(0.13858, -0.15118, -0.06299);
    node_reach_rod_B2_1_117.rotation.set(0.0, 0.0, 0.0);
  }
  node_reach_rod_B2_1_117.userData.sculptComponent = { id: "reach-rod-B2-1" };
  node_reach_rod_B2_1_117.userData.actionProfile = {};
  (nodes["reach-rod-B2-0"] ?? root).add(node_reach_rod_B2_1_117);
  nodes["reach-rod-B2-1"] = node_reach_rod_B2_1_117;
  const mesh_reach_rod_B2_1_117Geometry = endpoint_reach_rod_B2_1_117
    ? new THREE.CylinderGeometry(endpoint_reach_rod_B2_1_117.endRadius, endpoint_reach_rod_B2_1_117.baseRadius, endpoint_reach_rod_B2_1_117.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_reach_rod_B2_1_117) {
    mesh_reach_rod_B2_1_117Geometry.scale(0.04724, 0.20275, 0.04724);
  }
  const mesh_reach_rod_B2_1_117 = new THREE.Mesh(
    mesh_reach_rod_B2_1_117Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_rod_B2_1_117.name = "Reach rod B2 1";
  if (endpoint_reach_rod_B2_1_117) {
    mesh_reach_rod_B2_1_117.position.copy(endpoint_reach_rod_B2_1_117.midpoint);
    mesh_reach_rod_B2_1_117.quaternion.copy(endpoint_reach_rod_B2_1_117.quaternion);
  }
  mesh_reach_rod_B2_1_117.castShadow = options.castShadow ?? true;
  mesh_reach_rod_B2_1_117.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_rod_B2_1_117.userData.sculptComponent = { id: "reach-rod-B2-1" };
  node_reach_rod_B2_1_117.add(mesh_reach_rod_B2_1_117);
  meshes["reach-rod-B2-1"] = mesh_reach_rod_B2_1_117;
  colliders["reach-rod-B2-1"] = {};
  destructionGroups["reach-B2"] ??= [];
  destructionGroups["reach-B2"].push(node_reach_rod_B2_1_117);

  const endpoint_reach_joint_B2_2_118 = makeAttachmentEndpoint(null);
  const node_reach_joint_B2_2_118 = new THREE.Group();
  node_reach_joint_B2_2_118.name = "Reach joint B2 2__pivot";
  node_reach_joint_B2_2_118.scale.set(1, 1, 1);
  if (endpoint_reach_joint_B2_2_118) {
    node_reach_joint_B2_2_118.position.copy(endpoint_reach_joint_B2_2_118.start);
    node_reach_joint_B2_2_118.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_reach_joint_B2_2_118.position.set(0.0378, -0.18898, -0.06299);
    node_reach_joint_B2_2_118.rotation.set(0.0, 0.0, 0.0);
  }
  node_reach_joint_B2_2_118.userData.sculptComponent = { id: "reach-joint-B2-2" };
  node_reach_joint_B2_2_118.userData.actionProfile = {};
  (nodes["reach-rod-B2-1"] ?? root).add(node_reach_joint_B2_2_118);
  nodes["reach-joint-B2-2"] = node_reach_joint_B2_2_118;
  const mesh_reach_joint_B2_2_118Geometry = endpoint_reach_joint_B2_2_118
    ? new THREE.CylinderGeometry(endpoint_reach_joint_B2_2_118.endRadius, endpoint_reach_joint_B2_2_118.baseRadius, endpoint_reach_joint_B2_2_118.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_reach_joint_B2_2_118) {
    mesh_reach_joint_B2_2_118Geometry.scale(0.04724, 0.04724, 0.04724);
  }
  const mesh_reach_joint_B2_2_118 = new THREE.Mesh(
    mesh_reach_joint_B2_2_118Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_joint_B2_2_118.name = "Reach joint B2 2";
  if (endpoint_reach_joint_B2_2_118) {
    mesh_reach_joint_B2_2_118.position.copy(endpoint_reach_joint_B2_2_118.midpoint);
    mesh_reach_joint_B2_2_118.quaternion.copy(endpoint_reach_joint_B2_2_118.quaternion);
  }
  mesh_reach_joint_B2_2_118.castShadow = options.castShadow ?? true;
  mesh_reach_joint_B2_2_118.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_joint_B2_2_118.userData.sculptComponent = { id: "reach-joint-B2-2" };
  node_reach_joint_B2_2_118.add(mesh_reach_joint_B2_2_118);
  meshes["reach-joint-B2-2"] = mesh_reach_joint_B2_2_118;
  colliders["reach-joint-B2-2"] = {};
  destructionGroups["reach-B2"] ??= [];
  destructionGroups["reach-B2"].push(node_reach_joint_B2_2_118);

  const endpoint_reach_ring_B2_1_119 = makeAttachmentEndpoint(null);
  const node_reach_ring_B2_1_119 = new THREE.Group();
  node_reach_ring_B2_1_119.name = "Joint ring B2 1__pivot";
  node_reach_ring_B2_1_119.scale.set(1, 1, 1);
  if (endpoint_reach_ring_B2_1_119) {
    node_reach_ring_B2_1_119.position.copy(endpoint_reach_ring_B2_1_119.start);
    node_reach_ring_B2_1_119.rotation.set(1.89255, 0.18751, 0.0);
  } else {
    node_reach_ring_B2_1_119.position.set(0.0189, -0.09449, -0.0315);
    node_reach_ring_B2_1_119.rotation.set(1.89255, 0.18751, 0.0);
  }
  node_reach_ring_B2_1_119.userData.sculptComponent = { id: "reach-ring-B2-1" };
  node_reach_ring_B2_1_119.userData.actionProfile = {};
  (nodes["reach-rod-B2-1"] ?? root).add(node_reach_ring_B2_1_119);
  nodes["reach-ring-B2-1"] = node_reach_ring_B2_1_119;
  const mesh_reach_ring_B2_1_119Geometry = endpoint_reach_ring_B2_1_119
    ? new THREE.CylinderGeometry(endpoint_reach_ring_B2_1_119.endRadius, endpoint_reach_ring_B2_1_119.baseRadius, endpoint_reach_ring_B2_1_119.length, 8, 4)
    : new THREE.TorusGeometry(0.45, 0.0614, 8, 16);
  if (!endpoint_reach_ring_B2_1_119) {
    mesh_reach_ring_B2_1_119Geometry.scale(0.07699, 0.07699, 0.07699);
  }
  const mesh_reach_ring_B2_1_119 = new THREE.Mesh(
    mesh_reach_ring_B2_1_119Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_ring_B2_1_119.name = "Joint ring B2 1";
  if (endpoint_reach_ring_B2_1_119) {
    mesh_reach_ring_B2_1_119.position.copy(endpoint_reach_ring_B2_1_119.midpoint);
    mesh_reach_ring_B2_1_119.quaternion.copy(endpoint_reach_ring_B2_1_119.quaternion);
  }
  mesh_reach_ring_B2_1_119.castShadow = options.castShadow ?? true;
  mesh_reach_ring_B2_1_119.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_ring_B2_1_119.userData.sculptComponent = { id: "reach-ring-B2-1" };
  node_reach_ring_B2_1_119.add(mesh_reach_ring_B2_1_119);
  meshes["reach-ring-B2-1"] = mesh_reach_ring_B2_1_119;
  colliders["reach-ring-B2-1"] = {};
  destructionGroups["reach-B2"] ??= [];
  destructionGroups["reach-B2"].push(node_reach_ring_B2_1_119);

  const endpoint_reach_grip_B2_120 = makeAttachmentEndpoint(null);
  const node_reach_grip_B2_120 = new THREE.Group();
  node_reach_grip_B2_120.name = "Grip block B2__pivot";
  node_reach_grip_B2_120.scale.set(1, 1, 1);
  if (endpoint_reach_grip_B2_120) {
    node_reach_grip_B2_120.position.copy(endpoint_reach_grip_B2_120.start);
    node_reach_grip_B2_120.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_reach_grip_B2_120.position.set(0.0378, -0.18898, -0.06299);
    node_reach_grip_B2_120.rotation.set(0.0, 0.0, 0.0);
  }
  node_reach_grip_B2_120.userData.sculptComponent = { id: "reach-grip-B2" };
  node_reach_grip_B2_120.userData.actionProfile = {};
  (nodes["reach-rod-B2-1"] ?? root).add(node_reach_grip_B2_120);
  nodes["reach-grip-B2"] = node_reach_grip_B2_120;
  const mesh_reach_grip_B2_120Geometry = endpoint_reach_grip_B2_120
    ? new THREE.CylinderGeometry(endpoint_reach_grip_B2_120.endRadius, endpoint_reach_grip_B2_120.baseRadius, endpoint_reach_grip_B2_120.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_reach_grip_B2_120) {
    mesh_reach_grip_B2_120Geometry.scale(0.06929, 0.05039, 0.04409);
  }
  const mesh_reach_grip_B2_120 = new THREE.Mesh(
    mesh_reach_grip_B2_120Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_grip_B2_120.name = "Grip block B2";
  if (endpoint_reach_grip_B2_120) {
    mesh_reach_grip_B2_120.position.copy(endpoint_reach_grip_B2_120.midpoint);
    mesh_reach_grip_B2_120.quaternion.copy(endpoint_reach_grip_B2_120.quaternion);
  }
  mesh_reach_grip_B2_120.castShadow = options.castShadow ?? true;
  mesh_reach_grip_B2_120.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_grip_B2_120.userData.sculptComponent = { id: "reach-grip-B2" };
  node_reach_grip_B2_120.add(mesh_reach_grip_B2_120);
  meshes["reach-grip-B2"] = mesh_reach_grip_B2_120;
  colliders["reach-grip-B2"] = {};
  destructionGroups["reach-B2"] ??= [];
  destructionGroups["reach-B2"].push(node_reach_grip_B2_120);

  const endpoint_reach_grip_glow_B2_121 = makeAttachmentEndpoint(null);
  const node_reach_grip_glow_B2_121 = new THREE.Group();
  node_reach_grip_glow_B2_121.name = "Grip glow B2__pivot";
  node_reach_grip_glow_B2_121.scale.set(1, 1, 1);
  if (endpoint_reach_grip_glow_B2_121) {
    node_reach_grip_glow_B2_121.position.copy(endpoint_reach_grip_glow_B2_121.start);
    node_reach_grip_glow_B2_121.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_reach_grip_glow_B2_121.position.set(0.0, 0.0, 0.0252);
    node_reach_grip_glow_B2_121.rotation.set(0.0, 0.0, 0.0);
  }
  node_reach_grip_glow_B2_121.userData.sculptComponent = { id: "reach-grip-glow-B2" };
  node_reach_grip_glow_B2_121.userData.actionProfile = {};
  (nodes["reach-grip-B2"] ?? root).add(node_reach_grip_glow_B2_121);
  nodes["reach-grip-glow-B2"] = node_reach_grip_glow_B2_121;
  const mesh_reach_grip_glow_B2_121Geometry = endpoint_reach_grip_glow_B2_121
    ? new THREE.CylinderGeometry(endpoint_reach_grip_glow_B2_121.endRadius, endpoint_reach_grip_glow_B2_121.baseRadius, endpoint_reach_grip_glow_B2_121.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_reach_grip_glow_B2_121) {
    mesh_reach_grip_glow_B2_121Geometry.scale(0.04409, 0.00945, 0.0063);
  }
  const mesh_reach_grip_glow_B2_121 = new THREE.Mesh(
    mesh_reach_grip_glow_B2_121Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_reach_grip_glow_B2_121.name = "Grip glow B2";
  if (endpoint_reach_grip_glow_B2_121) {
    mesh_reach_grip_glow_B2_121.position.copy(endpoint_reach_grip_glow_B2_121.midpoint);
    mesh_reach_grip_glow_B2_121.quaternion.copy(endpoint_reach_grip_glow_B2_121.quaternion);
  }
  mesh_reach_grip_glow_B2_121.castShadow = options.castShadow ?? true;
  mesh_reach_grip_glow_B2_121.receiveShadow = options.receiveShadow ?? true;
  mesh_reach_grip_glow_B2_121.userData.sculptComponent = { id: "reach-grip-glow-B2" };
  node_reach_grip_glow_B2_121.add(mesh_reach_grip_glow_B2_121);
  meshes["reach-grip-glow-B2"] = mesh_reach_grip_glow_B2_121;
  colliders["reach-grip-glow-B2"] = {};
  destructionGroups["reach-B2"] ??= [];
  destructionGroups["reach-B2"].push(node_reach_grip_glow_B2_121);

  const endpoint_prop_panel_1_122 = makeAttachmentEndpoint(null);
  const node_prop_panel_1_122 = new THREE.Group();
  node_prop_panel_1_122.name = "Holo panel prop-panel-1__pivot";
  node_prop_panel_1_122.scale.set(1, 1, 1);
  if (endpoint_prop_panel_1_122) {
    node_prop_panel_1_122.position.copy(endpoint_prop_panel_1_122.start);
    node_prop_panel_1_122.rotation.set(0.0, 0.45, -0.1);
  } else {
    node_prop_panel_1_122.position.set(-0.34646, 1.6378, 0.12598);
    node_prop_panel_1_122.rotation.set(0.0, 0.45, -0.1);
  }
  node_prop_panel_1_122.userData.sculptComponent = { id: "prop-panel-1" };
  node_prop_panel_1_122.userData.actionProfile = {};
  (nodes["root"] ?? root).add(node_prop_panel_1_122);
  nodes["prop-panel-1"] = node_prop_panel_1_122;
  const mesh_prop_panel_1_122Geometry = endpoint_prop_panel_1_122
    ? new THREE.CylinderGeometry(endpoint_prop_panel_1_122.endRadius, endpoint_prop_panel_1_122.baseRadius, endpoint_prop_panel_1_122.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_1_122) {
    mesh_prop_panel_1_122Geometry.scale(0.31496, 0.36221, 0.00504);
  }
  const mesh_prop_panel_1_122 = new THREE.Mesh(
    mesh_prop_panel_1_122Geometry,
    materialMap["holo-panel"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_1_122.name = "Holo panel prop-panel-1";
  if (endpoint_prop_panel_1_122) {
    mesh_prop_panel_1_122.position.copy(endpoint_prop_panel_1_122.midpoint);
    mesh_prop_panel_1_122.quaternion.copy(endpoint_prop_panel_1_122.quaternion);
  }
  mesh_prop_panel_1_122.castShadow = options.castShadow ?? true;
  mesh_prop_panel_1_122.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_1_122.userData.sculptComponent = { id: "prop-panel-1" };
  node_prop_panel_1_122.add(mesh_prop_panel_1_122);
  meshes["prop-panel-1"] = mesh_prop_panel_1_122;
  colliders["prop-panel-1"] = {};
  destructionGroups["prop-panel-1"] ??= [];
  destructionGroups["prop-panel-1"].push(node_prop_panel_1_122);

  const endpoint_prop_panel_1_edge0_123 = makeAttachmentEndpoint(null);
  const node_prop_panel_1_edge0_123 = new THREE.Group();
  node_prop_panel_1_edge0_123.name = "Panel edge prop-panel-1 0__pivot";
  node_prop_panel_1_edge0_123.scale.set(1, 1, 1);
  if (endpoint_prop_panel_1_edge0_123) {
    node_prop_panel_1_edge0_123.position.copy(endpoint_prop_panel_1_edge0_123.start);
    node_prop_panel_1_edge0_123.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_1_edge0_123.position.set(0.0, 0.1811, 0.0);
    node_prop_panel_1_edge0_123.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_1_edge0_123.userData.sculptComponent = { id: "prop-panel-1-edge0" };
  node_prop_panel_1_edge0_123.userData.actionProfile = {};
  (nodes["prop-panel-1"] ?? root).add(node_prop_panel_1_edge0_123);
  nodes["prop-panel-1-edge0"] = node_prop_panel_1_edge0_123;
  const mesh_prop_panel_1_edge0_123Geometry = endpoint_prop_panel_1_edge0_123
    ? new THREE.CylinderGeometry(endpoint_prop_panel_1_edge0_123.endRadius, endpoint_prop_panel_1_edge0_123.baseRadius, endpoint_prop_panel_1_edge0_123.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_1_edge0_123) {
    mesh_prop_panel_1_edge0_123Geometry.scale(0.31496, 0.00441, 0.00504);
  }
  const mesh_prop_panel_1_edge0_123 = new THREE.Mesh(
    mesh_prop_panel_1_edge0_123Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_1_edge0_123.name = "Panel edge prop-panel-1 0";
  if (endpoint_prop_panel_1_edge0_123) {
    mesh_prop_panel_1_edge0_123.position.copy(endpoint_prop_panel_1_edge0_123.midpoint);
    mesh_prop_panel_1_edge0_123.quaternion.copy(endpoint_prop_panel_1_edge0_123.quaternion);
  }
  mesh_prop_panel_1_edge0_123.castShadow = options.castShadow ?? true;
  mesh_prop_panel_1_edge0_123.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_1_edge0_123.userData.sculptComponent = { id: "prop-panel-1-edge0" };
  node_prop_panel_1_edge0_123.add(mesh_prop_panel_1_edge0_123);
  meshes["prop-panel-1-edge0"] = mesh_prop_panel_1_edge0_123;
  colliders["prop-panel-1-edge0"] = {};
  destructionGroups["prop-panel-1"] ??= [];
  destructionGroups["prop-panel-1"].push(node_prop_panel_1_edge0_123);

  const endpoint_prop_panel_1_edge1_124 = makeAttachmentEndpoint(null);
  const node_prop_panel_1_edge1_124 = new THREE.Group();
  node_prop_panel_1_edge1_124.name = "Panel edge prop-panel-1 1__pivot";
  node_prop_panel_1_edge1_124.scale.set(1, 1, 1);
  if (endpoint_prop_panel_1_edge1_124) {
    node_prop_panel_1_edge1_124.position.copy(endpoint_prop_panel_1_edge1_124.start);
    node_prop_panel_1_edge1_124.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_1_edge1_124.position.set(0.0, -0.1811, 0.0);
    node_prop_panel_1_edge1_124.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_1_edge1_124.userData.sculptComponent = { id: "prop-panel-1-edge1" };
  node_prop_panel_1_edge1_124.userData.actionProfile = {};
  (nodes["prop-panel-1"] ?? root).add(node_prop_panel_1_edge1_124);
  nodes["prop-panel-1-edge1"] = node_prop_panel_1_edge1_124;
  const mesh_prop_panel_1_edge1_124Geometry = endpoint_prop_panel_1_edge1_124
    ? new THREE.CylinderGeometry(endpoint_prop_panel_1_edge1_124.endRadius, endpoint_prop_panel_1_edge1_124.baseRadius, endpoint_prop_panel_1_edge1_124.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_1_edge1_124) {
    mesh_prop_panel_1_edge1_124Geometry.scale(0.31496, 0.00441, 0.00504);
  }
  const mesh_prop_panel_1_edge1_124 = new THREE.Mesh(
    mesh_prop_panel_1_edge1_124Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_1_edge1_124.name = "Panel edge prop-panel-1 1";
  if (endpoint_prop_panel_1_edge1_124) {
    mesh_prop_panel_1_edge1_124.position.copy(endpoint_prop_panel_1_edge1_124.midpoint);
    mesh_prop_panel_1_edge1_124.quaternion.copy(endpoint_prop_panel_1_edge1_124.quaternion);
  }
  mesh_prop_panel_1_edge1_124.castShadow = options.castShadow ?? true;
  mesh_prop_panel_1_edge1_124.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_1_edge1_124.userData.sculptComponent = { id: "prop-panel-1-edge1" };
  node_prop_panel_1_edge1_124.add(mesh_prop_panel_1_edge1_124);
  meshes["prop-panel-1-edge1"] = mesh_prop_panel_1_edge1_124;
  colliders["prop-panel-1-edge1"] = {};
  destructionGroups["prop-panel-1"] ??= [];
  destructionGroups["prop-panel-1"].push(node_prop_panel_1_edge1_124);

  const endpoint_prop_panel_1_edge2_125 = makeAttachmentEndpoint(null);
  const node_prop_panel_1_edge2_125 = new THREE.Group();
  node_prop_panel_1_edge2_125.name = "Panel edge prop-panel-1 2__pivot";
  node_prop_panel_1_edge2_125.scale.set(1, 1, 1);
  if (endpoint_prop_panel_1_edge2_125) {
    node_prop_panel_1_edge2_125.position.copy(endpoint_prop_panel_1_edge2_125.start);
    node_prop_panel_1_edge2_125.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_1_edge2_125.position.set(-0.15748, 0.0, 0.0);
    node_prop_panel_1_edge2_125.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_1_edge2_125.userData.sculptComponent = { id: "prop-panel-1-edge2" };
  node_prop_panel_1_edge2_125.userData.actionProfile = {};
  (nodes["prop-panel-1"] ?? root).add(node_prop_panel_1_edge2_125);
  nodes["prop-panel-1-edge2"] = node_prop_panel_1_edge2_125;
  const mesh_prop_panel_1_edge2_125Geometry = endpoint_prop_panel_1_edge2_125
    ? new THREE.CylinderGeometry(endpoint_prop_panel_1_edge2_125.endRadius, endpoint_prop_panel_1_edge2_125.baseRadius, endpoint_prop_panel_1_edge2_125.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_1_edge2_125) {
    mesh_prop_panel_1_edge2_125Geometry.scale(0.00441, 0.36221, 0.00504);
  }
  const mesh_prop_panel_1_edge2_125 = new THREE.Mesh(
    mesh_prop_panel_1_edge2_125Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_1_edge2_125.name = "Panel edge prop-panel-1 2";
  if (endpoint_prop_panel_1_edge2_125) {
    mesh_prop_panel_1_edge2_125.position.copy(endpoint_prop_panel_1_edge2_125.midpoint);
    mesh_prop_panel_1_edge2_125.quaternion.copy(endpoint_prop_panel_1_edge2_125.quaternion);
  }
  mesh_prop_panel_1_edge2_125.castShadow = options.castShadow ?? true;
  mesh_prop_panel_1_edge2_125.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_1_edge2_125.userData.sculptComponent = { id: "prop-panel-1-edge2" };
  node_prop_panel_1_edge2_125.add(mesh_prop_panel_1_edge2_125);
  meshes["prop-panel-1-edge2"] = mesh_prop_panel_1_edge2_125;
  colliders["prop-panel-1-edge2"] = {};
  destructionGroups["prop-panel-1"] ??= [];
  destructionGroups["prop-panel-1"].push(node_prop_panel_1_edge2_125);

  const endpoint_prop_panel_1_edge3_126 = makeAttachmentEndpoint(null);
  const node_prop_panel_1_edge3_126 = new THREE.Group();
  node_prop_panel_1_edge3_126.name = "Panel edge prop-panel-1 3__pivot";
  node_prop_panel_1_edge3_126.scale.set(1, 1, 1);
  if (endpoint_prop_panel_1_edge3_126) {
    node_prop_panel_1_edge3_126.position.copy(endpoint_prop_panel_1_edge3_126.start);
    node_prop_panel_1_edge3_126.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_1_edge3_126.position.set(0.15748, 0.0, 0.0);
    node_prop_panel_1_edge3_126.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_1_edge3_126.userData.sculptComponent = { id: "prop-panel-1-edge3" };
  node_prop_panel_1_edge3_126.userData.actionProfile = {};
  (nodes["prop-panel-1"] ?? root).add(node_prop_panel_1_edge3_126);
  nodes["prop-panel-1-edge3"] = node_prop_panel_1_edge3_126;
  const mesh_prop_panel_1_edge3_126Geometry = endpoint_prop_panel_1_edge3_126
    ? new THREE.CylinderGeometry(endpoint_prop_panel_1_edge3_126.endRadius, endpoint_prop_panel_1_edge3_126.baseRadius, endpoint_prop_panel_1_edge3_126.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_1_edge3_126) {
    mesh_prop_panel_1_edge3_126Geometry.scale(0.00441, 0.36221, 0.00504);
  }
  const mesh_prop_panel_1_edge3_126 = new THREE.Mesh(
    mesh_prop_panel_1_edge3_126Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_1_edge3_126.name = "Panel edge prop-panel-1 3";
  if (endpoint_prop_panel_1_edge3_126) {
    mesh_prop_panel_1_edge3_126.position.copy(endpoint_prop_panel_1_edge3_126.midpoint);
    mesh_prop_panel_1_edge3_126.quaternion.copy(endpoint_prop_panel_1_edge3_126.quaternion);
  }
  mesh_prop_panel_1_edge3_126.castShadow = options.castShadow ?? true;
  mesh_prop_panel_1_edge3_126.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_1_edge3_126.userData.sculptComponent = { id: "prop-panel-1-edge3" };
  node_prop_panel_1_edge3_126.add(mesh_prop_panel_1_edge3_126);
  meshes["prop-panel-1-edge3"] = mesh_prop_panel_1_edge3_126;
  colliders["prop-panel-1-edge3"] = {};
  destructionGroups["prop-panel-1"] ??= [];
  destructionGroups["prop-panel-1"].push(node_prop_panel_1_edge3_126);

  const endpoint_prop_panel_1_line0_127 = makeAttachmentEndpoint(null);
  const node_prop_panel_1_line0_127 = new THREE.Group();
  node_prop_panel_1_line0_127.name = "Text line prop-panel-1 0__pivot";
  node_prop_panel_1_line0_127.scale.set(1, 1, 1);
  if (endpoint_prop_panel_1_line0_127) {
    node_prop_panel_1_line0_127.position.copy(endpoint_prop_panel_1_line0_127.start);
    node_prop_panel_1_line0_127.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_1_line0_127.position.set(-0.03937, 0.10866, 0.00378);
    node_prop_panel_1_line0_127.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_1_line0_127.userData.sculptComponent = { id: "prop-panel-1-line0" };
  node_prop_panel_1_line0_127.userData.actionProfile = {};
  (nodes["prop-panel-1"] ?? root).add(node_prop_panel_1_line0_127);
  nodes["prop-panel-1-line0"] = node_prop_panel_1_line0_127;
  const mesh_prop_panel_1_line0_127Geometry = endpoint_prop_panel_1_line0_127
    ? new THREE.CylinderGeometry(endpoint_prop_panel_1_line0_127.endRadius, endpoint_prop_panel_1_line0_127.baseRadius, endpoint_prop_panel_1_line0_127.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_1_line0_127) {
    mesh_prop_panel_1_line0_127Geometry.scale(0.17323, 0.00378, 0.00504);
  }
  const mesh_prop_panel_1_line0_127 = new THREE.Mesh(
    mesh_prop_panel_1_line0_127Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_1_line0_127.name = "Text line prop-panel-1 0";
  if (endpoint_prop_panel_1_line0_127) {
    mesh_prop_panel_1_line0_127.position.copy(endpoint_prop_panel_1_line0_127.midpoint);
    mesh_prop_panel_1_line0_127.quaternion.copy(endpoint_prop_panel_1_line0_127.quaternion);
  }
  mesh_prop_panel_1_line0_127.castShadow = options.castShadow ?? true;
  mesh_prop_panel_1_line0_127.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_1_line0_127.userData.sculptComponent = { id: "prop-panel-1-line0" };
  node_prop_panel_1_line0_127.add(mesh_prop_panel_1_line0_127);
  meshes["prop-panel-1-line0"] = mesh_prop_panel_1_line0_127;
  colliders["prop-panel-1-line0"] = {};
  destructionGroups["prop-panel-1"] ??= [];
  destructionGroups["prop-panel-1"].push(node_prop_panel_1_line0_127);

  const endpoint_prop_panel_1_line1_128 = makeAttachmentEndpoint(null);
  const node_prop_panel_1_line1_128 = new THREE.Group();
  node_prop_panel_1_line1_128.name = "Text line prop-panel-1 1__pivot";
  node_prop_panel_1_line1_128.scale.set(1, 1, 1);
  if (endpoint_prop_panel_1_line1_128) {
    node_prop_panel_1_line1_128.position.copy(endpoint_prop_panel_1_line1_128.start);
    node_prop_panel_1_line1_128.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_1_line1_128.position.set(-0.05197, 0.0652, 0.00378);
    node_prop_panel_1_line1_128.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_1_line1_128.userData.sculptComponent = { id: "prop-panel-1-line1" };
  node_prop_panel_1_line1_128.userData.actionProfile = {};
  (nodes["prop-panel-1"] ?? root).add(node_prop_panel_1_line1_128);
  nodes["prop-panel-1-line1"] = node_prop_panel_1_line1_128;
  const mesh_prop_panel_1_line1_128Geometry = endpoint_prop_panel_1_line1_128
    ? new THREE.CylinderGeometry(endpoint_prop_panel_1_line1_128.endRadius, endpoint_prop_panel_1_line1_128.baseRadius, endpoint_prop_panel_1_line1_128.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_1_line1_128) {
    mesh_prop_panel_1_line1_128Geometry.scale(0.14803, 0.00378, 0.00504);
  }
  const mesh_prop_panel_1_line1_128 = new THREE.Mesh(
    mesh_prop_panel_1_line1_128Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_1_line1_128.name = "Text line prop-panel-1 1";
  if (endpoint_prop_panel_1_line1_128) {
    mesh_prop_panel_1_line1_128.position.copy(endpoint_prop_panel_1_line1_128.midpoint);
    mesh_prop_panel_1_line1_128.quaternion.copy(endpoint_prop_panel_1_line1_128.quaternion);
  }
  mesh_prop_panel_1_line1_128.castShadow = options.castShadow ?? true;
  mesh_prop_panel_1_line1_128.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_1_line1_128.userData.sculptComponent = { id: "prop-panel-1-line1" };
  node_prop_panel_1_line1_128.add(mesh_prop_panel_1_line1_128);
  meshes["prop-panel-1-line1"] = mesh_prop_panel_1_line1_128;
  colliders["prop-panel-1-line1"] = {};
  destructionGroups["prop-panel-1"] ??= [];
  destructionGroups["prop-panel-1"].push(node_prop_panel_1_line1_128);

  const endpoint_prop_panel_1_line2_129 = makeAttachmentEndpoint(null);
  const node_prop_panel_1_line2_129 = new THREE.Group();
  node_prop_panel_1_line2_129.name = "Text line prop-panel-1 2__pivot";
  node_prop_panel_1_line2_129.scale.set(1, 1, 1);
  if (endpoint_prop_panel_1_line2_129) {
    node_prop_panel_1_line2_129.position.copy(endpoint_prop_panel_1_line2_129.start);
    node_prop_panel_1_line2_129.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_1_line2_129.position.set(-0.06457, 0.02173, 0.00378);
    node_prop_panel_1_line2_129.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_1_line2_129.userData.sculptComponent = { id: "prop-panel-1-line2" };
  node_prop_panel_1_line2_129.userData.actionProfile = {};
  (nodes["prop-panel-1"] ?? root).add(node_prop_panel_1_line2_129);
  nodes["prop-panel-1-line2"] = node_prop_panel_1_line2_129;
  const mesh_prop_panel_1_line2_129Geometry = endpoint_prop_panel_1_line2_129
    ? new THREE.CylinderGeometry(endpoint_prop_panel_1_line2_129.endRadius, endpoint_prop_panel_1_line2_129.baseRadius, endpoint_prop_panel_1_line2_129.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_1_line2_129) {
    mesh_prop_panel_1_line2_129Geometry.scale(0.12283, 0.00378, 0.00504);
  }
  const mesh_prop_panel_1_line2_129 = new THREE.Mesh(
    mesh_prop_panel_1_line2_129Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_1_line2_129.name = "Text line prop-panel-1 2";
  if (endpoint_prop_panel_1_line2_129) {
    mesh_prop_panel_1_line2_129.position.copy(endpoint_prop_panel_1_line2_129.midpoint);
    mesh_prop_panel_1_line2_129.quaternion.copy(endpoint_prop_panel_1_line2_129.quaternion);
  }
  mesh_prop_panel_1_line2_129.castShadow = options.castShadow ?? true;
  mesh_prop_panel_1_line2_129.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_1_line2_129.userData.sculptComponent = { id: "prop-panel-1-line2" };
  node_prop_panel_1_line2_129.add(mesh_prop_panel_1_line2_129);
  meshes["prop-panel-1-line2"] = mesh_prop_panel_1_line2_129;
  colliders["prop-panel-1-line2"] = {};
  destructionGroups["prop-panel-1"] ??= [];
  destructionGroups["prop-panel-1"].push(node_prop_panel_1_line2_129);

  const endpoint_prop_panel_1_line3_130 = makeAttachmentEndpoint(null);
  const node_prop_panel_1_line3_130 = new THREE.Group();
  node_prop_panel_1_line3_130.name = "Text line prop-panel-1 3__pivot";
  node_prop_panel_1_line3_130.scale.set(1, 1, 1);
  if (endpoint_prop_panel_1_line3_130) {
    node_prop_panel_1_line3_130.position.copy(endpoint_prop_panel_1_line3_130.start);
    node_prop_panel_1_line3_130.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_1_line3_130.position.set(-0.03937, -0.02173, 0.00378);
    node_prop_panel_1_line3_130.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_1_line3_130.userData.sculptComponent = { id: "prop-panel-1-line3" };
  node_prop_panel_1_line3_130.userData.actionProfile = {};
  (nodes["prop-panel-1"] ?? root).add(node_prop_panel_1_line3_130);
  nodes["prop-panel-1-line3"] = node_prop_panel_1_line3_130;
  const mesh_prop_panel_1_line3_130Geometry = endpoint_prop_panel_1_line3_130
    ? new THREE.CylinderGeometry(endpoint_prop_panel_1_line3_130.endRadius, endpoint_prop_panel_1_line3_130.baseRadius, endpoint_prop_panel_1_line3_130.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_1_line3_130) {
    mesh_prop_panel_1_line3_130Geometry.scale(0.17323, 0.00378, 0.00504);
  }
  const mesh_prop_panel_1_line3_130 = new THREE.Mesh(
    mesh_prop_panel_1_line3_130Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_1_line3_130.name = "Text line prop-panel-1 3";
  if (endpoint_prop_panel_1_line3_130) {
    mesh_prop_panel_1_line3_130.position.copy(endpoint_prop_panel_1_line3_130.midpoint);
    mesh_prop_panel_1_line3_130.quaternion.copy(endpoint_prop_panel_1_line3_130.quaternion);
  }
  mesh_prop_panel_1_line3_130.castShadow = options.castShadow ?? true;
  mesh_prop_panel_1_line3_130.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_1_line3_130.userData.sculptComponent = { id: "prop-panel-1-line3" };
  node_prop_panel_1_line3_130.add(mesh_prop_panel_1_line3_130);
  meshes["prop-panel-1-line3"] = mesh_prop_panel_1_line3_130;
  colliders["prop-panel-1-line3"] = {};
  destructionGroups["prop-panel-1"] ??= [];
  destructionGroups["prop-panel-1"].push(node_prop_panel_1_line3_130);

  const endpoint_prop_panel_1_bar0_131 = makeAttachmentEndpoint(null);
  const node_prop_panel_1_bar0_131 = new THREE.Group();
  node_prop_panel_1_bar0_131.name = "Chart bar prop-panel-1 0__pivot";
  node_prop_panel_1_bar0_131.scale.set(1, 1, 1);
  if (endpoint_prop_panel_1_bar0_131) {
    node_prop_panel_1_bar0_131.position.copy(endpoint_prop_panel_1_bar0_131.start);
    node_prop_panel_1_bar0_131.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_1_bar0_131.position.set(-0.11339, -0.09055, 0.00378);
    node_prop_panel_1_bar0_131.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_1_bar0_131.userData.sculptComponent = { id: "prop-panel-1-bar0" };
  node_prop_panel_1_bar0_131.userData.actionProfile = {};
  (nodes["prop-panel-1"] ?? root).add(node_prop_panel_1_bar0_131);
  nodes["prop-panel-1-bar0"] = node_prop_panel_1_bar0_131;
  const mesh_prop_panel_1_bar0_131Geometry = endpoint_prop_panel_1_bar0_131
    ? new THREE.CylinderGeometry(endpoint_prop_panel_1_bar0_131.endRadius, endpoint_prop_panel_1_bar0_131.baseRadius, endpoint_prop_panel_1_bar0_131.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_1_bar0_131) {
    mesh_prop_panel_1_bar0_131Geometry.scale(0.02205, 0.0652, 0.00567);
  }
  const mesh_prop_panel_1_bar0_131 = new THREE.Mesh(
    mesh_prop_panel_1_bar0_131Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_1_bar0_131.name = "Chart bar prop-panel-1 0";
  if (endpoint_prop_panel_1_bar0_131) {
    mesh_prop_panel_1_bar0_131.position.copy(endpoint_prop_panel_1_bar0_131.midpoint);
    mesh_prop_panel_1_bar0_131.quaternion.copy(endpoint_prop_panel_1_bar0_131.quaternion);
  }
  mesh_prop_panel_1_bar0_131.castShadow = options.castShadow ?? true;
  mesh_prop_panel_1_bar0_131.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_1_bar0_131.userData.sculptComponent = { id: "prop-panel-1-bar0" };
  node_prop_panel_1_bar0_131.add(mesh_prop_panel_1_bar0_131);
  meshes["prop-panel-1-bar0"] = mesh_prop_panel_1_bar0_131;
  colliders["prop-panel-1-bar0"] = {};
  destructionGroups["prop-panel-1"] ??= [];
  destructionGroups["prop-panel-1"].push(node_prop_panel_1_bar0_131);

  const endpoint_prop_panel_1_bar1_132 = makeAttachmentEndpoint(null);
  const node_prop_panel_1_bar1_132 = new THREE.Group();
  node_prop_panel_1_bar1_132.name = "Chart bar prop-panel-1 1__pivot";
  node_prop_panel_1_bar1_132.scale.set(1, 1, 1);
  if (endpoint_prop_panel_1_bar1_132) {
    node_prop_panel_1_bar1_132.position.copy(endpoint_prop_panel_1_bar1_132.start);
    node_prop_panel_1_bar1_132.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_1_bar1_132.position.set(-0.05669, -0.02717, 0.00378);
    node_prop_panel_1_bar1_132.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_1_bar1_132.userData.sculptComponent = { id: "prop-panel-1-bar1" };
  node_prop_panel_1_bar1_132.userData.actionProfile = {};
  (nodes["prop-panel-1"] ?? root).add(node_prop_panel_1_bar1_132);
  nodes["prop-panel-1-bar1"] = node_prop_panel_1_bar1_132;
  const mesh_prop_panel_1_bar1_132Geometry = endpoint_prop_panel_1_bar1_132
    ? new THREE.CylinderGeometry(endpoint_prop_panel_1_bar1_132.endRadius, endpoint_prop_panel_1_bar1_132.baseRadius, endpoint_prop_panel_1_bar1_132.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_1_bar1_132) {
    mesh_prop_panel_1_bar1_132Geometry.scale(0.02205, 0.19197, 0.00567);
  }
  const mesh_prop_panel_1_bar1_132 = new THREE.Mesh(
    mesh_prop_panel_1_bar1_132Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_1_bar1_132.name = "Chart bar prop-panel-1 1";
  if (endpoint_prop_panel_1_bar1_132) {
    mesh_prop_panel_1_bar1_132.position.copy(endpoint_prop_panel_1_bar1_132.midpoint);
    mesh_prop_panel_1_bar1_132.quaternion.copy(endpoint_prop_panel_1_bar1_132.quaternion);
  }
  mesh_prop_panel_1_bar1_132.castShadow = options.castShadow ?? true;
  mesh_prop_panel_1_bar1_132.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_1_bar1_132.userData.sculptComponent = { id: "prop-panel-1-bar1" };
  node_prop_panel_1_bar1_132.add(mesh_prop_panel_1_bar1_132);
  meshes["prop-panel-1-bar1"] = mesh_prop_panel_1_bar1_132;
  colliders["prop-panel-1-bar1"] = {};
  destructionGroups["prop-panel-1"] ??= [];
  destructionGroups["prop-panel-1"].push(node_prop_panel_1_bar1_132);

  const endpoint_prop_panel_1_bar2_133 = makeAttachmentEndpoint(null);
  const node_prop_panel_1_bar2_133 = new THREE.Group();
  node_prop_panel_1_bar2_133.name = "Chart bar prop-panel-1 2__pivot";
  node_prop_panel_1_bar2_133.scale.set(1, 1, 1);
  if (endpoint_prop_panel_1_bar2_133) {
    node_prop_panel_1_bar2_133.position.copy(endpoint_prop_panel_1_bar2_133.start);
    node_prop_panel_1_bar2_133.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_1_bar2_133.position.set(0.0, -0.05433, 0.00378);
    node_prop_panel_1_bar2_133.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_1_bar2_133.userData.sculptComponent = { id: "prop-panel-1-bar2" };
  node_prop_panel_1_bar2_133.userData.actionProfile = {};
  (nodes["prop-panel-1"] ?? root).add(node_prop_panel_1_bar2_133);
  nodes["prop-panel-1-bar2"] = node_prop_panel_1_bar2_133;
  const mesh_prop_panel_1_bar2_133Geometry = endpoint_prop_panel_1_bar2_133
    ? new THREE.CylinderGeometry(endpoint_prop_panel_1_bar2_133.endRadius, endpoint_prop_panel_1_bar2_133.baseRadius, endpoint_prop_panel_1_bar2_133.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_1_bar2_133) {
    mesh_prop_panel_1_bar2_133Geometry.scale(0.02205, 0.13764, 0.00567);
  }
  const mesh_prop_panel_1_bar2_133 = new THREE.Mesh(
    mesh_prop_panel_1_bar2_133Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_1_bar2_133.name = "Chart bar prop-panel-1 2";
  if (endpoint_prop_panel_1_bar2_133) {
    mesh_prop_panel_1_bar2_133.position.copy(endpoint_prop_panel_1_bar2_133.midpoint);
    mesh_prop_panel_1_bar2_133.quaternion.copy(endpoint_prop_panel_1_bar2_133.quaternion);
  }
  mesh_prop_panel_1_bar2_133.castShadow = options.castShadow ?? true;
  mesh_prop_panel_1_bar2_133.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_1_bar2_133.userData.sculptComponent = { id: "prop-panel-1-bar2" };
  node_prop_panel_1_bar2_133.add(mesh_prop_panel_1_bar2_133);
  meshes["prop-panel-1-bar2"] = mesh_prop_panel_1_bar2_133;
  colliders["prop-panel-1-bar2"] = {};
  destructionGroups["prop-panel-1"] ??= [];
  destructionGroups["prop-panel-1"].push(node_prop_panel_1_bar2_133);

  const endpoint_prop_panel_1_bar3_134 = makeAttachmentEndpoint(null);
  const node_prop_panel_1_bar3_134 = new THREE.Group();
  node_prop_panel_1_bar3_134.name = "Chart bar prop-panel-1 3__pivot";
  node_prop_panel_1_bar3_134.scale.set(1, 1, 1);
  if (endpoint_prop_panel_1_bar3_134) {
    node_prop_panel_1_bar3_134.position.copy(endpoint_prop_panel_1_bar3_134.start);
    node_prop_panel_1_bar3_134.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_1_bar3_134.position.set(0.05669, -0.0815, 0.00378);
    node_prop_panel_1_bar3_134.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_1_bar3_134.userData.sculptComponent = { id: "prop-panel-1-bar3" };
  node_prop_panel_1_bar3_134.userData.actionProfile = {};
  (nodes["prop-panel-1"] ?? root).add(node_prop_panel_1_bar3_134);
  nodes["prop-panel-1-bar3"] = node_prop_panel_1_bar3_134;
  const mesh_prop_panel_1_bar3_134Geometry = endpoint_prop_panel_1_bar3_134
    ? new THREE.CylinderGeometry(endpoint_prop_panel_1_bar3_134.endRadius, endpoint_prop_panel_1_bar3_134.baseRadius, endpoint_prop_panel_1_bar3_134.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_1_bar3_134) {
    mesh_prop_panel_1_bar3_134Geometry.scale(0.02205, 0.08331, 0.00567);
  }
  const mesh_prop_panel_1_bar3_134 = new THREE.Mesh(
    mesh_prop_panel_1_bar3_134Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_1_bar3_134.name = "Chart bar prop-panel-1 3";
  if (endpoint_prop_panel_1_bar3_134) {
    mesh_prop_panel_1_bar3_134.position.copy(endpoint_prop_panel_1_bar3_134.midpoint);
    mesh_prop_panel_1_bar3_134.quaternion.copy(endpoint_prop_panel_1_bar3_134.quaternion);
  }
  mesh_prop_panel_1_bar3_134.castShadow = options.castShadow ?? true;
  mesh_prop_panel_1_bar3_134.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_1_bar3_134.userData.sculptComponent = { id: "prop-panel-1-bar3" };
  node_prop_panel_1_bar3_134.add(mesh_prop_panel_1_bar3_134);
  meshes["prop-panel-1-bar3"] = mesh_prop_panel_1_bar3_134;
  colliders["prop-panel-1-bar3"] = {};
  destructionGroups["prop-panel-1"] ??= [];
  destructionGroups["prop-panel-1"].push(node_prop_panel_1_bar3_134);

  const endpoint_prop_panel_1_bar4_135 = makeAttachmentEndpoint(null);
  const node_prop_panel_1_bar4_135 = new THREE.Group();
  node_prop_panel_1_bar4_135.name = "Chart bar prop-panel-1 4__pivot";
  node_prop_panel_1_bar4_135.scale.set(1, 1, 1);
  if (endpoint_prop_panel_1_bar4_135) {
    node_prop_panel_1_bar4_135.position.copy(endpoint_prop_panel_1_bar4_135.start);
    node_prop_panel_1_bar4_135.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_1_bar4_135.position.set(0.11339, -0.01811, 0.00378);
    node_prop_panel_1_bar4_135.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_1_bar4_135.userData.sculptComponent = { id: "prop-panel-1-bar4" };
  node_prop_panel_1_bar4_135.userData.actionProfile = {};
  (nodes["prop-panel-1"] ?? root).add(node_prop_panel_1_bar4_135);
  nodes["prop-panel-1-bar4"] = node_prop_panel_1_bar4_135;
  const mesh_prop_panel_1_bar4_135Geometry = endpoint_prop_panel_1_bar4_135
    ? new THREE.CylinderGeometry(endpoint_prop_panel_1_bar4_135.endRadius, endpoint_prop_panel_1_bar4_135.baseRadius, endpoint_prop_panel_1_bar4_135.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_1_bar4_135) {
    mesh_prop_panel_1_bar4_135Geometry.scale(0.02205, 0.21008, 0.00567);
  }
  const mesh_prop_panel_1_bar4_135 = new THREE.Mesh(
    mesh_prop_panel_1_bar4_135Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_1_bar4_135.name = "Chart bar prop-panel-1 4";
  if (endpoint_prop_panel_1_bar4_135) {
    mesh_prop_panel_1_bar4_135.position.copy(endpoint_prop_panel_1_bar4_135.midpoint);
    mesh_prop_panel_1_bar4_135.quaternion.copy(endpoint_prop_panel_1_bar4_135.quaternion);
  }
  mesh_prop_panel_1_bar4_135.castShadow = options.castShadow ?? true;
  mesh_prop_panel_1_bar4_135.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_1_bar4_135.userData.sculptComponent = { id: "prop-panel-1-bar4" };
  node_prop_panel_1_bar4_135.add(mesh_prop_panel_1_bar4_135);
  meshes["prop-panel-1-bar4"] = mesh_prop_panel_1_bar4_135;
  colliders["prop-panel-1-bar4"] = {};
  destructionGroups["prop-panel-1"] ??= [];
  destructionGroups["prop-panel-1"].push(node_prop_panel_1_bar4_135);

  const endpoint_prop_panel_2_136 = makeAttachmentEndpoint(null);
  const node_prop_panel_2_136 = new THREE.Group();
  node_prop_panel_2_136.name = "Holo panel prop-panel-2__pivot";
  node_prop_panel_2_136.scale.set(1, 1, 1);
  if (endpoint_prop_panel_2_136) {
    node_prop_panel_2_136.position.copy(endpoint_prop_panel_2_136.start);
    node_prop_panel_2_136.rotation.set(0.0, 0.35, 0.04);
  } else {
    node_prop_panel_2_136.position.set(-0.4189, 1.14961, 0.17323);
    node_prop_panel_2_136.rotation.set(0.0, 0.35, 0.04);
  }
  node_prop_panel_2_136.userData.sculptComponent = { id: "prop-panel-2" };
  node_prop_panel_2_136.userData.actionProfile = {};
  (nodes["root"] ?? root).add(node_prop_panel_2_136);
  nodes["prop-panel-2"] = node_prop_panel_2_136;
  const mesh_prop_panel_2_136Geometry = endpoint_prop_panel_2_136
    ? new THREE.CylinderGeometry(endpoint_prop_panel_2_136.endRadius, endpoint_prop_panel_2_136.baseRadius, endpoint_prop_panel_2_136.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_2_136) {
    mesh_prop_panel_2_136Geometry.scale(0.36221, 0.40945, 0.00504);
  }
  const mesh_prop_panel_2_136 = new THREE.Mesh(
    mesh_prop_panel_2_136Geometry,
    materialMap["holo-panel"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_2_136.name = "Holo panel prop-panel-2";
  if (endpoint_prop_panel_2_136) {
    mesh_prop_panel_2_136.position.copy(endpoint_prop_panel_2_136.midpoint);
    mesh_prop_panel_2_136.quaternion.copy(endpoint_prop_panel_2_136.quaternion);
  }
  mesh_prop_panel_2_136.castShadow = options.castShadow ?? true;
  mesh_prop_panel_2_136.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_2_136.userData.sculptComponent = { id: "prop-panel-2" };
  node_prop_panel_2_136.add(mesh_prop_panel_2_136);
  meshes["prop-panel-2"] = mesh_prop_panel_2_136;
  colliders["prop-panel-2"] = {};
  destructionGroups["prop-panel-2"] ??= [];
  destructionGroups["prop-panel-2"].push(node_prop_panel_2_136);

  const endpoint_prop_panel_2_edge0_137 = makeAttachmentEndpoint(null);
  const node_prop_panel_2_edge0_137 = new THREE.Group();
  node_prop_panel_2_edge0_137.name = "Panel edge prop-panel-2 0__pivot";
  node_prop_panel_2_edge0_137.scale.set(1, 1, 1);
  if (endpoint_prop_panel_2_edge0_137) {
    node_prop_panel_2_edge0_137.position.copy(endpoint_prop_panel_2_edge0_137.start);
    node_prop_panel_2_edge0_137.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_2_edge0_137.position.set(0.0, 0.20472, 0.0);
    node_prop_panel_2_edge0_137.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_2_edge0_137.userData.sculptComponent = { id: "prop-panel-2-edge0" };
  node_prop_panel_2_edge0_137.userData.actionProfile = {};
  (nodes["prop-panel-2"] ?? root).add(node_prop_panel_2_edge0_137);
  nodes["prop-panel-2-edge0"] = node_prop_panel_2_edge0_137;
  const mesh_prop_panel_2_edge0_137Geometry = endpoint_prop_panel_2_edge0_137
    ? new THREE.CylinderGeometry(endpoint_prop_panel_2_edge0_137.endRadius, endpoint_prop_panel_2_edge0_137.baseRadius, endpoint_prop_panel_2_edge0_137.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_2_edge0_137) {
    mesh_prop_panel_2_edge0_137Geometry.scale(0.36221, 0.00441, 0.00504);
  }
  const mesh_prop_panel_2_edge0_137 = new THREE.Mesh(
    mesh_prop_panel_2_edge0_137Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_2_edge0_137.name = "Panel edge prop-panel-2 0";
  if (endpoint_prop_panel_2_edge0_137) {
    mesh_prop_panel_2_edge0_137.position.copy(endpoint_prop_panel_2_edge0_137.midpoint);
    mesh_prop_panel_2_edge0_137.quaternion.copy(endpoint_prop_panel_2_edge0_137.quaternion);
  }
  mesh_prop_panel_2_edge0_137.castShadow = options.castShadow ?? true;
  mesh_prop_panel_2_edge0_137.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_2_edge0_137.userData.sculptComponent = { id: "prop-panel-2-edge0" };
  node_prop_panel_2_edge0_137.add(mesh_prop_panel_2_edge0_137);
  meshes["prop-panel-2-edge0"] = mesh_prop_panel_2_edge0_137;
  colliders["prop-panel-2-edge0"] = {};
  destructionGroups["prop-panel-2"] ??= [];
  destructionGroups["prop-panel-2"].push(node_prop_panel_2_edge0_137);

  const endpoint_prop_panel_2_edge1_138 = makeAttachmentEndpoint(null);
  const node_prop_panel_2_edge1_138 = new THREE.Group();
  node_prop_panel_2_edge1_138.name = "Panel edge prop-panel-2 1__pivot";
  node_prop_panel_2_edge1_138.scale.set(1, 1, 1);
  if (endpoint_prop_panel_2_edge1_138) {
    node_prop_panel_2_edge1_138.position.copy(endpoint_prop_panel_2_edge1_138.start);
    node_prop_panel_2_edge1_138.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_2_edge1_138.position.set(0.0, -0.20472, 0.0);
    node_prop_panel_2_edge1_138.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_2_edge1_138.userData.sculptComponent = { id: "prop-panel-2-edge1" };
  node_prop_panel_2_edge1_138.userData.actionProfile = {};
  (nodes["prop-panel-2"] ?? root).add(node_prop_panel_2_edge1_138);
  nodes["prop-panel-2-edge1"] = node_prop_panel_2_edge1_138;
  const mesh_prop_panel_2_edge1_138Geometry = endpoint_prop_panel_2_edge1_138
    ? new THREE.CylinderGeometry(endpoint_prop_panel_2_edge1_138.endRadius, endpoint_prop_panel_2_edge1_138.baseRadius, endpoint_prop_panel_2_edge1_138.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_2_edge1_138) {
    mesh_prop_panel_2_edge1_138Geometry.scale(0.36221, 0.00441, 0.00504);
  }
  const mesh_prop_panel_2_edge1_138 = new THREE.Mesh(
    mesh_prop_panel_2_edge1_138Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_2_edge1_138.name = "Panel edge prop-panel-2 1";
  if (endpoint_prop_panel_2_edge1_138) {
    mesh_prop_panel_2_edge1_138.position.copy(endpoint_prop_panel_2_edge1_138.midpoint);
    mesh_prop_panel_2_edge1_138.quaternion.copy(endpoint_prop_panel_2_edge1_138.quaternion);
  }
  mesh_prop_panel_2_edge1_138.castShadow = options.castShadow ?? true;
  mesh_prop_panel_2_edge1_138.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_2_edge1_138.userData.sculptComponent = { id: "prop-panel-2-edge1" };
  node_prop_panel_2_edge1_138.add(mesh_prop_panel_2_edge1_138);
  meshes["prop-panel-2-edge1"] = mesh_prop_panel_2_edge1_138;
  colliders["prop-panel-2-edge1"] = {};
  destructionGroups["prop-panel-2"] ??= [];
  destructionGroups["prop-panel-2"].push(node_prop_panel_2_edge1_138);

  const endpoint_prop_panel_2_edge2_139 = makeAttachmentEndpoint(null);
  const node_prop_panel_2_edge2_139 = new THREE.Group();
  node_prop_panel_2_edge2_139.name = "Panel edge prop-panel-2 2__pivot";
  node_prop_panel_2_edge2_139.scale.set(1, 1, 1);
  if (endpoint_prop_panel_2_edge2_139) {
    node_prop_panel_2_edge2_139.position.copy(endpoint_prop_panel_2_edge2_139.start);
    node_prop_panel_2_edge2_139.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_2_edge2_139.position.set(-0.1811, 0.0, 0.0);
    node_prop_panel_2_edge2_139.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_2_edge2_139.userData.sculptComponent = { id: "prop-panel-2-edge2" };
  node_prop_panel_2_edge2_139.userData.actionProfile = {};
  (nodes["prop-panel-2"] ?? root).add(node_prop_panel_2_edge2_139);
  nodes["prop-panel-2-edge2"] = node_prop_panel_2_edge2_139;
  const mesh_prop_panel_2_edge2_139Geometry = endpoint_prop_panel_2_edge2_139
    ? new THREE.CylinderGeometry(endpoint_prop_panel_2_edge2_139.endRadius, endpoint_prop_panel_2_edge2_139.baseRadius, endpoint_prop_panel_2_edge2_139.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_2_edge2_139) {
    mesh_prop_panel_2_edge2_139Geometry.scale(0.00441, 0.40945, 0.00504);
  }
  const mesh_prop_panel_2_edge2_139 = new THREE.Mesh(
    mesh_prop_panel_2_edge2_139Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_2_edge2_139.name = "Panel edge prop-panel-2 2";
  if (endpoint_prop_panel_2_edge2_139) {
    mesh_prop_panel_2_edge2_139.position.copy(endpoint_prop_panel_2_edge2_139.midpoint);
    mesh_prop_panel_2_edge2_139.quaternion.copy(endpoint_prop_panel_2_edge2_139.quaternion);
  }
  mesh_prop_panel_2_edge2_139.castShadow = options.castShadow ?? true;
  mesh_prop_panel_2_edge2_139.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_2_edge2_139.userData.sculptComponent = { id: "prop-panel-2-edge2" };
  node_prop_panel_2_edge2_139.add(mesh_prop_panel_2_edge2_139);
  meshes["prop-panel-2-edge2"] = mesh_prop_panel_2_edge2_139;
  colliders["prop-panel-2-edge2"] = {};
  destructionGroups["prop-panel-2"] ??= [];
  destructionGroups["prop-panel-2"].push(node_prop_panel_2_edge2_139);

  const endpoint_prop_panel_2_edge3_140 = makeAttachmentEndpoint(null);
  const node_prop_panel_2_edge3_140 = new THREE.Group();
  node_prop_panel_2_edge3_140.name = "Panel edge prop-panel-2 3__pivot";
  node_prop_panel_2_edge3_140.scale.set(1, 1, 1);
  if (endpoint_prop_panel_2_edge3_140) {
    node_prop_panel_2_edge3_140.position.copy(endpoint_prop_panel_2_edge3_140.start);
    node_prop_panel_2_edge3_140.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_2_edge3_140.position.set(0.1811, 0.0, 0.0);
    node_prop_panel_2_edge3_140.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_2_edge3_140.userData.sculptComponent = { id: "prop-panel-2-edge3" };
  node_prop_panel_2_edge3_140.userData.actionProfile = {};
  (nodes["prop-panel-2"] ?? root).add(node_prop_panel_2_edge3_140);
  nodes["prop-panel-2-edge3"] = node_prop_panel_2_edge3_140;
  const mesh_prop_panel_2_edge3_140Geometry = endpoint_prop_panel_2_edge3_140
    ? new THREE.CylinderGeometry(endpoint_prop_panel_2_edge3_140.endRadius, endpoint_prop_panel_2_edge3_140.baseRadius, endpoint_prop_panel_2_edge3_140.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_2_edge3_140) {
    mesh_prop_panel_2_edge3_140Geometry.scale(0.00441, 0.40945, 0.00504);
  }
  const mesh_prop_panel_2_edge3_140 = new THREE.Mesh(
    mesh_prop_panel_2_edge3_140Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_2_edge3_140.name = "Panel edge prop-panel-2 3";
  if (endpoint_prop_panel_2_edge3_140) {
    mesh_prop_panel_2_edge3_140.position.copy(endpoint_prop_panel_2_edge3_140.midpoint);
    mesh_prop_panel_2_edge3_140.quaternion.copy(endpoint_prop_panel_2_edge3_140.quaternion);
  }
  mesh_prop_panel_2_edge3_140.castShadow = options.castShadow ?? true;
  mesh_prop_panel_2_edge3_140.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_2_edge3_140.userData.sculptComponent = { id: "prop-panel-2-edge3" };
  node_prop_panel_2_edge3_140.add(mesh_prop_panel_2_edge3_140);
  meshes["prop-panel-2-edge3"] = mesh_prop_panel_2_edge3_140;
  colliders["prop-panel-2-edge3"] = {};
  destructionGroups["prop-panel-2"] ??= [];
  destructionGroups["prop-panel-2"].push(node_prop_panel_2_edge3_140);

  const endpoint_prop_panel_2_ring_141 = makeAttachmentEndpoint(null);
  const node_prop_panel_2_ring_141 = new THREE.Group();
  node_prop_panel_2_ring_141.name = "Panel ring prop-panel-2__pivot";
  node_prop_panel_2_ring_141.scale.set(1, 1, 1);
  if (endpoint_prop_panel_2_ring_141) {
    node_prop_panel_2_ring_141.position.copy(endpoint_prop_panel_2_ring_141.start);
    node_prop_panel_2_ring_141.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_2_ring_141.position.set(0.0, 0.0, 0.00378);
    node_prop_panel_2_ring_141.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_2_ring_141.userData.sculptComponent = { id: "prop-panel-2-ring" };
  node_prop_panel_2_ring_141.userData.actionProfile = {};
  (nodes["prop-panel-2"] ?? root).add(node_prop_panel_2_ring_141);
  nodes["prop-panel-2-ring"] = node_prop_panel_2_ring_141;
  const mesh_prop_panel_2_ring_141Geometry = endpoint_prop_panel_2_ring_141
    ? new THREE.CylinderGeometry(endpoint_prop_panel_2_ring_141.endRadius, endpoint_prop_panel_2_ring_141.baseRadius, endpoint_prop_panel_2_ring_141.length, 8, 4)
    : new THREE.TorusGeometry(0.45, 0.0315, 8, 16);
  if (!endpoint_prop_panel_2_ring_141) {
    mesh_prop_panel_2_ring_141Geometry.scale(0.27367, 0.27367, 0.27367);
  }
  const mesh_prop_panel_2_ring_141 = new THREE.Mesh(
    mesh_prop_panel_2_ring_141Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_2_ring_141.name = "Panel ring prop-panel-2";
  if (endpoint_prop_panel_2_ring_141) {
    mesh_prop_panel_2_ring_141.position.copy(endpoint_prop_panel_2_ring_141.midpoint);
    mesh_prop_panel_2_ring_141.quaternion.copy(endpoint_prop_panel_2_ring_141.quaternion);
  }
  mesh_prop_panel_2_ring_141.castShadow = options.castShadow ?? true;
  mesh_prop_panel_2_ring_141.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_2_ring_141.userData.sculptComponent = { id: "prop-panel-2-ring" };
  node_prop_panel_2_ring_141.add(mesh_prop_panel_2_ring_141);
  meshes["prop-panel-2-ring"] = mesh_prop_panel_2_ring_141;
  colliders["prop-panel-2-ring"] = {};
  destructionGroups["prop-panel-2"] ??= [];
  destructionGroups["prop-panel-2"].push(node_prop_panel_2_ring_141);

  const endpoint_prop_panel_2_line0_142 = makeAttachmentEndpoint(null);
  const node_prop_panel_2_line0_142 = new THREE.Group();
  node_prop_panel_2_line0_142.name = "Text line prop-panel-2 0__pivot";
  node_prop_panel_2_line0_142.scale.set(1, 1, 1);
  if (endpoint_prop_panel_2_line0_142) {
    node_prop_panel_2_line0_142.position.copy(endpoint_prop_panel_2_line0_142.start);
    node_prop_panel_2_line0_142.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_2_line0_142.position.set(-0.04528, 0.12283, 0.00378);
    node_prop_panel_2_line0_142.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_2_line0_142.userData.sculptComponent = { id: "prop-panel-2-line0" };
  node_prop_panel_2_line0_142.userData.actionProfile = {};
  (nodes["prop-panel-2"] ?? root).add(node_prop_panel_2_line0_142);
  nodes["prop-panel-2-line0"] = node_prop_panel_2_line0_142;
  const mesh_prop_panel_2_line0_142Geometry = endpoint_prop_panel_2_line0_142
    ? new THREE.CylinderGeometry(endpoint_prop_panel_2_line0_142.endRadius, endpoint_prop_panel_2_line0_142.baseRadius, endpoint_prop_panel_2_line0_142.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_2_line0_142) {
    mesh_prop_panel_2_line0_142Geometry.scale(0.19921, 0.00378, 0.00504);
  }
  const mesh_prop_panel_2_line0_142 = new THREE.Mesh(
    mesh_prop_panel_2_line0_142Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_2_line0_142.name = "Text line prop-panel-2 0";
  if (endpoint_prop_panel_2_line0_142) {
    mesh_prop_panel_2_line0_142.position.copy(endpoint_prop_panel_2_line0_142.midpoint);
    mesh_prop_panel_2_line0_142.quaternion.copy(endpoint_prop_panel_2_line0_142.quaternion);
  }
  mesh_prop_panel_2_line0_142.castShadow = options.castShadow ?? true;
  mesh_prop_panel_2_line0_142.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_2_line0_142.userData.sculptComponent = { id: "prop-panel-2-line0" };
  node_prop_panel_2_line0_142.add(mesh_prop_panel_2_line0_142);
  meshes["prop-panel-2-line0"] = mesh_prop_panel_2_line0_142;
  colliders["prop-panel-2-line0"] = {};
  destructionGroups["prop-panel-2"] ??= [];
  destructionGroups["prop-panel-2"].push(node_prop_panel_2_line0_142);

  const endpoint_prop_panel_2_line1_143 = makeAttachmentEndpoint(null);
  const node_prop_panel_2_line1_143 = new THREE.Group();
  node_prop_panel_2_line1_143.name = "Text line prop-panel-2 1__pivot";
  node_prop_panel_2_line1_143.scale.set(1, 1, 1);
  if (endpoint_prop_panel_2_line1_143) {
    node_prop_panel_2_line1_143.position.copy(endpoint_prop_panel_2_line1_143.start);
    node_prop_panel_2_line1_143.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_2_line1_143.position.set(-0.05976, 0.0737, 0.00378);
    node_prop_panel_2_line1_143.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_2_line1_143.userData.sculptComponent = { id: "prop-panel-2-line1" };
  node_prop_panel_2_line1_143.userData.actionProfile = {};
  (nodes["prop-panel-2"] ?? root).add(node_prop_panel_2_line1_143);
  nodes["prop-panel-2-line1"] = node_prop_panel_2_line1_143;
  const mesh_prop_panel_2_line1_143Geometry = endpoint_prop_panel_2_line1_143
    ? new THREE.CylinderGeometry(endpoint_prop_panel_2_line1_143.endRadius, endpoint_prop_panel_2_line1_143.baseRadius, endpoint_prop_panel_2_line1_143.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_2_line1_143) {
    mesh_prop_panel_2_line1_143Geometry.scale(0.17024, 0.00378, 0.00504);
  }
  const mesh_prop_panel_2_line1_143 = new THREE.Mesh(
    mesh_prop_panel_2_line1_143Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_2_line1_143.name = "Text line prop-panel-2 1";
  if (endpoint_prop_panel_2_line1_143) {
    mesh_prop_panel_2_line1_143.position.copy(endpoint_prop_panel_2_line1_143.midpoint);
    mesh_prop_panel_2_line1_143.quaternion.copy(endpoint_prop_panel_2_line1_143.quaternion);
  }
  mesh_prop_panel_2_line1_143.castShadow = options.castShadow ?? true;
  mesh_prop_panel_2_line1_143.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_2_line1_143.userData.sculptComponent = { id: "prop-panel-2-line1" };
  node_prop_panel_2_line1_143.add(mesh_prop_panel_2_line1_143);
  meshes["prop-panel-2-line1"] = mesh_prop_panel_2_line1_143;
  colliders["prop-panel-2-line1"] = {};
  destructionGroups["prop-panel-2"] ??= [];
  destructionGroups["prop-panel-2"].push(node_prop_panel_2_line1_143);

  const endpoint_prop_panel_2_line2_144 = makeAttachmentEndpoint(null);
  const node_prop_panel_2_line2_144 = new THREE.Group();
  node_prop_panel_2_line2_144.name = "Text line prop-panel-2 2__pivot";
  node_prop_panel_2_line2_144.scale.set(1, 1, 1);
  if (endpoint_prop_panel_2_line2_144) {
    node_prop_panel_2_line2_144.position.copy(endpoint_prop_panel_2_line2_144.start);
    node_prop_panel_2_line2_144.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_2_line2_144.position.set(-0.07425, 0.02457, 0.00378);
    node_prop_panel_2_line2_144.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_2_line2_144.userData.sculptComponent = { id: "prop-panel-2-line2" };
  node_prop_panel_2_line2_144.userData.actionProfile = {};
  (nodes["prop-panel-2"] ?? root).add(node_prop_panel_2_line2_144);
  nodes["prop-panel-2-line2"] = node_prop_panel_2_line2_144;
  const mesh_prop_panel_2_line2_144Geometry = endpoint_prop_panel_2_line2_144
    ? new THREE.CylinderGeometry(endpoint_prop_panel_2_line2_144.endRadius, endpoint_prop_panel_2_line2_144.baseRadius, endpoint_prop_panel_2_line2_144.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_2_line2_144) {
    mesh_prop_panel_2_line2_144Geometry.scale(0.14126, 0.00378, 0.00504);
  }
  const mesh_prop_panel_2_line2_144 = new THREE.Mesh(
    mesh_prop_panel_2_line2_144Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_2_line2_144.name = "Text line prop-panel-2 2";
  if (endpoint_prop_panel_2_line2_144) {
    mesh_prop_panel_2_line2_144.position.copy(endpoint_prop_panel_2_line2_144.midpoint);
    mesh_prop_panel_2_line2_144.quaternion.copy(endpoint_prop_panel_2_line2_144.quaternion);
  }
  mesh_prop_panel_2_line2_144.castShadow = options.castShadow ?? true;
  mesh_prop_panel_2_line2_144.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_2_line2_144.userData.sculptComponent = { id: "prop-panel-2-line2" };
  node_prop_panel_2_line2_144.add(mesh_prop_panel_2_line2_144);
  meshes["prop-panel-2-line2"] = mesh_prop_panel_2_line2_144;
  colliders["prop-panel-2-line2"] = {};
  destructionGroups["prop-panel-2"] ??= [];
  destructionGroups["prop-panel-2"].push(node_prop_panel_2_line2_144);

  const endpoint_prop_panel_3_145 = makeAttachmentEndpoint(null);
  const node_prop_panel_3_145 = new THREE.Group();
  node_prop_panel_3_145.name = "Holo panel prop-panel-3__pivot";
  node_prop_panel_3_145.scale.set(1, 1, 1);
  if (endpoint_prop_panel_3_145) {
    node_prop_panel_3_145.position.copy(endpoint_prop_panel_3_145.start);
    node_prop_panel_3_145.rotation.set(0.0, -0.5, 0.05);
  } else {
    node_prop_panel_3_145.position.set(0.34646, 1.52756, 0.09449);
    node_prop_panel_3_145.rotation.set(0.0, -0.5, 0.05);
  }
  node_prop_panel_3_145.userData.sculptComponent = { id: "prop-panel-3" };
  node_prop_panel_3_145.userData.actionProfile = {};
  (nodes["root"] ?? root).add(node_prop_panel_3_145);
  nodes["prop-panel-3"] = node_prop_panel_3_145;
  const mesh_prop_panel_3_145Geometry = endpoint_prop_panel_3_145
    ? new THREE.CylinderGeometry(endpoint_prop_panel_3_145.endRadius, endpoint_prop_panel_3_145.baseRadius, endpoint_prop_panel_3_145.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_3_145) {
    mesh_prop_panel_3_145Geometry.scale(0.18898, 0.26772, 0.00504);
  }
  const mesh_prop_panel_3_145 = new THREE.Mesh(
    mesh_prop_panel_3_145Geometry,
    materialMap["holo-panel"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_3_145.name = "Holo panel prop-panel-3";
  if (endpoint_prop_panel_3_145) {
    mesh_prop_panel_3_145.position.copy(endpoint_prop_panel_3_145.midpoint);
    mesh_prop_panel_3_145.quaternion.copy(endpoint_prop_panel_3_145.quaternion);
  }
  mesh_prop_panel_3_145.castShadow = options.castShadow ?? true;
  mesh_prop_panel_3_145.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_3_145.userData.sculptComponent = { id: "prop-panel-3" };
  node_prop_panel_3_145.add(mesh_prop_panel_3_145);
  meshes["prop-panel-3"] = mesh_prop_panel_3_145;
  colliders["prop-panel-3"] = {};
  destructionGroups["prop-panel-3"] ??= [];
  destructionGroups["prop-panel-3"].push(node_prop_panel_3_145);

  const endpoint_prop_panel_3_edge0_146 = makeAttachmentEndpoint(null);
  const node_prop_panel_3_edge0_146 = new THREE.Group();
  node_prop_panel_3_edge0_146.name = "Panel edge prop-panel-3 0__pivot";
  node_prop_panel_3_edge0_146.scale.set(1, 1, 1);
  if (endpoint_prop_panel_3_edge0_146) {
    node_prop_panel_3_edge0_146.position.copy(endpoint_prop_panel_3_edge0_146.start);
    node_prop_panel_3_edge0_146.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_3_edge0_146.position.set(0.0, 0.13386, 0.0);
    node_prop_panel_3_edge0_146.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_3_edge0_146.userData.sculptComponent = { id: "prop-panel-3-edge0" };
  node_prop_panel_3_edge0_146.userData.actionProfile = {};
  (nodes["prop-panel-3"] ?? root).add(node_prop_panel_3_edge0_146);
  nodes["prop-panel-3-edge0"] = node_prop_panel_3_edge0_146;
  const mesh_prop_panel_3_edge0_146Geometry = endpoint_prop_panel_3_edge0_146
    ? new THREE.CylinderGeometry(endpoint_prop_panel_3_edge0_146.endRadius, endpoint_prop_panel_3_edge0_146.baseRadius, endpoint_prop_panel_3_edge0_146.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_3_edge0_146) {
    mesh_prop_panel_3_edge0_146Geometry.scale(0.18898, 0.00441, 0.00504);
  }
  const mesh_prop_panel_3_edge0_146 = new THREE.Mesh(
    mesh_prop_panel_3_edge0_146Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_3_edge0_146.name = "Panel edge prop-panel-3 0";
  if (endpoint_prop_panel_3_edge0_146) {
    mesh_prop_panel_3_edge0_146.position.copy(endpoint_prop_panel_3_edge0_146.midpoint);
    mesh_prop_panel_3_edge0_146.quaternion.copy(endpoint_prop_panel_3_edge0_146.quaternion);
  }
  mesh_prop_panel_3_edge0_146.castShadow = options.castShadow ?? true;
  mesh_prop_panel_3_edge0_146.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_3_edge0_146.userData.sculptComponent = { id: "prop-panel-3-edge0" };
  node_prop_panel_3_edge0_146.add(mesh_prop_panel_3_edge0_146);
  meshes["prop-panel-3-edge0"] = mesh_prop_panel_3_edge0_146;
  colliders["prop-panel-3-edge0"] = {};
  destructionGroups["prop-panel-3"] ??= [];
  destructionGroups["prop-panel-3"].push(node_prop_panel_3_edge0_146);

  const endpoint_prop_panel_3_edge1_147 = makeAttachmentEndpoint(null);
  const node_prop_panel_3_edge1_147 = new THREE.Group();
  node_prop_panel_3_edge1_147.name = "Panel edge prop-panel-3 1__pivot";
  node_prop_panel_3_edge1_147.scale.set(1, 1, 1);
  if (endpoint_prop_panel_3_edge1_147) {
    node_prop_panel_3_edge1_147.position.copy(endpoint_prop_panel_3_edge1_147.start);
    node_prop_panel_3_edge1_147.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_3_edge1_147.position.set(0.0, -0.13386, 0.0);
    node_prop_panel_3_edge1_147.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_3_edge1_147.userData.sculptComponent = { id: "prop-panel-3-edge1" };
  node_prop_panel_3_edge1_147.userData.actionProfile = {};
  (nodes["prop-panel-3"] ?? root).add(node_prop_panel_3_edge1_147);
  nodes["prop-panel-3-edge1"] = node_prop_panel_3_edge1_147;
  const mesh_prop_panel_3_edge1_147Geometry = endpoint_prop_panel_3_edge1_147
    ? new THREE.CylinderGeometry(endpoint_prop_panel_3_edge1_147.endRadius, endpoint_prop_panel_3_edge1_147.baseRadius, endpoint_prop_panel_3_edge1_147.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_3_edge1_147) {
    mesh_prop_panel_3_edge1_147Geometry.scale(0.18898, 0.00441, 0.00504);
  }
  const mesh_prop_panel_3_edge1_147 = new THREE.Mesh(
    mesh_prop_panel_3_edge1_147Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_3_edge1_147.name = "Panel edge prop-panel-3 1";
  if (endpoint_prop_panel_3_edge1_147) {
    mesh_prop_panel_3_edge1_147.position.copy(endpoint_prop_panel_3_edge1_147.midpoint);
    mesh_prop_panel_3_edge1_147.quaternion.copy(endpoint_prop_panel_3_edge1_147.quaternion);
  }
  mesh_prop_panel_3_edge1_147.castShadow = options.castShadow ?? true;
  mesh_prop_panel_3_edge1_147.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_3_edge1_147.userData.sculptComponent = { id: "prop-panel-3-edge1" };
  node_prop_panel_3_edge1_147.add(mesh_prop_panel_3_edge1_147);
  meshes["prop-panel-3-edge1"] = mesh_prop_panel_3_edge1_147;
  colliders["prop-panel-3-edge1"] = {};
  destructionGroups["prop-panel-3"] ??= [];
  destructionGroups["prop-panel-3"].push(node_prop_panel_3_edge1_147);

  const endpoint_prop_panel_3_edge2_148 = makeAttachmentEndpoint(null);
  const node_prop_panel_3_edge2_148 = new THREE.Group();
  node_prop_panel_3_edge2_148.name = "Panel edge prop-panel-3 2__pivot";
  node_prop_panel_3_edge2_148.scale.set(1, 1, 1);
  if (endpoint_prop_panel_3_edge2_148) {
    node_prop_panel_3_edge2_148.position.copy(endpoint_prop_panel_3_edge2_148.start);
    node_prop_panel_3_edge2_148.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_3_edge2_148.position.set(-0.09449, 0.0, 0.0);
    node_prop_panel_3_edge2_148.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_3_edge2_148.userData.sculptComponent = { id: "prop-panel-3-edge2" };
  node_prop_panel_3_edge2_148.userData.actionProfile = {};
  (nodes["prop-panel-3"] ?? root).add(node_prop_panel_3_edge2_148);
  nodes["prop-panel-3-edge2"] = node_prop_panel_3_edge2_148;
  const mesh_prop_panel_3_edge2_148Geometry = endpoint_prop_panel_3_edge2_148
    ? new THREE.CylinderGeometry(endpoint_prop_panel_3_edge2_148.endRadius, endpoint_prop_panel_3_edge2_148.baseRadius, endpoint_prop_panel_3_edge2_148.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_3_edge2_148) {
    mesh_prop_panel_3_edge2_148Geometry.scale(0.00441, 0.26772, 0.00504);
  }
  const mesh_prop_panel_3_edge2_148 = new THREE.Mesh(
    mesh_prop_panel_3_edge2_148Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_3_edge2_148.name = "Panel edge prop-panel-3 2";
  if (endpoint_prop_panel_3_edge2_148) {
    mesh_prop_panel_3_edge2_148.position.copy(endpoint_prop_panel_3_edge2_148.midpoint);
    mesh_prop_panel_3_edge2_148.quaternion.copy(endpoint_prop_panel_3_edge2_148.quaternion);
  }
  mesh_prop_panel_3_edge2_148.castShadow = options.castShadow ?? true;
  mesh_prop_panel_3_edge2_148.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_3_edge2_148.userData.sculptComponent = { id: "prop-panel-3-edge2" };
  node_prop_panel_3_edge2_148.add(mesh_prop_panel_3_edge2_148);
  meshes["prop-panel-3-edge2"] = mesh_prop_panel_3_edge2_148;
  colliders["prop-panel-3-edge2"] = {};
  destructionGroups["prop-panel-3"] ??= [];
  destructionGroups["prop-panel-3"].push(node_prop_panel_3_edge2_148);

  const endpoint_prop_panel_3_edge3_149 = makeAttachmentEndpoint(null);
  const node_prop_panel_3_edge3_149 = new THREE.Group();
  node_prop_panel_3_edge3_149.name = "Panel edge prop-panel-3 3__pivot";
  node_prop_panel_3_edge3_149.scale.set(1, 1, 1);
  if (endpoint_prop_panel_3_edge3_149) {
    node_prop_panel_3_edge3_149.position.copy(endpoint_prop_panel_3_edge3_149.start);
    node_prop_panel_3_edge3_149.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_3_edge3_149.position.set(0.09449, 0.0, 0.0);
    node_prop_panel_3_edge3_149.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_3_edge3_149.userData.sculptComponent = { id: "prop-panel-3-edge3" };
  node_prop_panel_3_edge3_149.userData.actionProfile = {};
  (nodes["prop-panel-3"] ?? root).add(node_prop_panel_3_edge3_149);
  nodes["prop-panel-3-edge3"] = node_prop_panel_3_edge3_149;
  const mesh_prop_panel_3_edge3_149Geometry = endpoint_prop_panel_3_edge3_149
    ? new THREE.CylinderGeometry(endpoint_prop_panel_3_edge3_149.endRadius, endpoint_prop_panel_3_edge3_149.baseRadius, endpoint_prop_panel_3_edge3_149.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_3_edge3_149) {
    mesh_prop_panel_3_edge3_149Geometry.scale(0.00441, 0.26772, 0.00504);
  }
  const mesh_prop_panel_3_edge3_149 = new THREE.Mesh(
    mesh_prop_panel_3_edge3_149Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_3_edge3_149.name = "Panel edge prop-panel-3 3";
  if (endpoint_prop_panel_3_edge3_149) {
    mesh_prop_panel_3_edge3_149.position.copy(endpoint_prop_panel_3_edge3_149.midpoint);
    mesh_prop_panel_3_edge3_149.quaternion.copy(endpoint_prop_panel_3_edge3_149.quaternion);
  }
  mesh_prop_panel_3_edge3_149.castShadow = options.castShadow ?? true;
  mesh_prop_panel_3_edge3_149.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_3_edge3_149.userData.sculptComponent = { id: "prop-panel-3-edge3" };
  node_prop_panel_3_edge3_149.add(mesh_prop_panel_3_edge3_149);
  meshes["prop-panel-3-edge3"] = mesh_prop_panel_3_edge3_149;
  colliders["prop-panel-3-edge3"] = {};
  destructionGroups["prop-panel-3"] ??= [];
  destructionGroups["prop-panel-3"].push(node_prop_panel_3_edge3_149);

  const endpoint_prop_panel_3_line0_150 = makeAttachmentEndpoint(null);
  const node_prop_panel_3_line0_150 = new THREE.Group();
  node_prop_panel_3_line0_150.name = "Text line prop-panel-3 0__pivot";
  node_prop_panel_3_line0_150.scale.set(1, 1, 1);
  if (endpoint_prop_panel_3_line0_150) {
    node_prop_panel_3_line0_150.position.copy(endpoint_prop_panel_3_line0_150.start);
    node_prop_panel_3_line0_150.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_3_line0_150.position.set(-0.02362, 0.08032, 0.00378);
    node_prop_panel_3_line0_150.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_3_line0_150.userData.sculptComponent = { id: "prop-panel-3-line0" };
  node_prop_panel_3_line0_150.userData.actionProfile = {};
  (nodes["prop-panel-3"] ?? root).add(node_prop_panel_3_line0_150);
  nodes["prop-panel-3-line0"] = node_prop_panel_3_line0_150;
  const mesh_prop_panel_3_line0_150Geometry = endpoint_prop_panel_3_line0_150
    ? new THREE.CylinderGeometry(endpoint_prop_panel_3_line0_150.endRadius, endpoint_prop_panel_3_line0_150.baseRadius, endpoint_prop_panel_3_line0_150.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_3_line0_150) {
    mesh_prop_panel_3_line0_150Geometry.scale(0.10394, 0.00378, 0.00504);
  }
  const mesh_prop_panel_3_line0_150 = new THREE.Mesh(
    mesh_prop_panel_3_line0_150Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_3_line0_150.name = "Text line prop-panel-3 0";
  if (endpoint_prop_panel_3_line0_150) {
    mesh_prop_panel_3_line0_150.position.copy(endpoint_prop_panel_3_line0_150.midpoint);
    mesh_prop_panel_3_line0_150.quaternion.copy(endpoint_prop_panel_3_line0_150.quaternion);
  }
  mesh_prop_panel_3_line0_150.castShadow = options.castShadow ?? true;
  mesh_prop_panel_3_line0_150.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_3_line0_150.userData.sculptComponent = { id: "prop-panel-3-line0" };
  node_prop_panel_3_line0_150.add(mesh_prop_panel_3_line0_150);
  meshes["prop-panel-3-line0"] = mesh_prop_panel_3_line0_150;
  colliders["prop-panel-3-line0"] = {};
  destructionGroups["prop-panel-3"] ??= [];
  destructionGroups["prop-panel-3"].push(node_prop_panel_3_line0_150);

  const endpoint_prop_panel_3_line1_151 = makeAttachmentEndpoint(null);
  const node_prop_panel_3_line1_151 = new THREE.Group();
  node_prop_panel_3_line1_151.name = "Text line prop-panel-3 1__pivot";
  node_prop_panel_3_line1_151.scale.set(1, 1, 1);
  if (endpoint_prop_panel_3_line1_151) {
    node_prop_panel_3_line1_151.position.copy(endpoint_prop_panel_3_line1_151.start);
    node_prop_panel_3_line1_151.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_3_line1_151.position.set(-0.03118, 0.04819, 0.00378);
    node_prop_panel_3_line1_151.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_3_line1_151.userData.sculptComponent = { id: "prop-panel-3-line1" };
  node_prop_panel_3_line1_151.userData.actionProfile = {};
  (nodes["prop-panel-3"] ?? root).add(node_prop_panel_3_line1_151);
  nodes["prop-panel-3-line1"] = node_prop_panel_3_line1_151;
  const mesh_prop_panel_3_line1_151Geometry = endpoint_prop_panel_3_line1_151
    ? new THREE.CylinderGeometry(endpoint_prop_panel_3_line1_151.endRadius, endpoint_prop_panel_3_line1_151.baseRadius, endpoint_prop_panel_3_line1_151.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_3_line1_151) {
    mesh_prop_panel_3_line1_151Geometry.scale(0.08882, 0.00378, 0.00504);
  }
  const mesh_prop_panel_3_line1_151 = new THREE.Mesh(
    mesh_prop_panel_3_line1_151Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_3_line1_151.name = "Text line prop-panel-3 1";
  if (endpoint_prop_panel_3_line1_151) {
    mesh_prop_panel_3_line1_151.position.copy(endpoint_prop_panel_3_line1_151.midpoint);
    mesh_prop_panel_3_line1_151.quaternion.copy(endpoint_prop_panel_3_line1_151.quaternion);
  }
  mesh_prop_panel_3_line1_151.castShadow = options.castShadow ?? true;
  mesh_prop_panel_3_line1_151.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_3_line1_151.userData.sculptComponent = { id: "prop-panel-3-line1" };
  node_prop_panel_3_line1_151.add(mesh_prop_panel_3_line1_151);
  meshes["prop-panel-3-line1"] = mesh_prop_panel_3_line1_151;
  colliders["prop-panel-3-line1"] = {};
  destructionGroups["prop-panel-3"] ??= [];
  destructionGroups["prop-panel-3"].push(node_prop_panel_3_line1_151);

  const endpoint_prop_panel_3_line2_152 = makeAttachmentEndpoint(null);
  const node_prop_panel_3_line2_152 = new THREE.Group();
  node_prop_panel_3_line2_152.name = "Text line prop-panel-3 2__pivot";
  node_prop_panel_3_line2_152.scale.set(1, 1, 1);
  if (endpoint_prop_panel_3_line2_152) {
    node_prop_panel_3_line2_152.position.copy(endpoint_prop_panel_3_line2_152.start);
    node_prop_panel_3_line2_152.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_3_line2_152.position.set(-0.03874, 0.01606, 0.00378);
    node_prop_panel_3_line2_152.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_3_line2_152.userData.sculptComponent = { id: "prop-panel-3-line2" };
  node_prop_panel_3_line2_152.userData.actionProfile = {};
  (nodes["prop-panel-3"] ?? root).add(node_prop_panel_3_line2_152);
  nodes["prop-panel-3-line2"] = node_prop_panel_3_line2_152;
  const mesh_prop_panel_3_line2_152Geometry = endpoint_prop_panel_3_line2_152
    ? new THREE.CylinderGeometry(endpoint_prop_panel_3_line2_152.endRadius, endpoint_prop_panel_3_line2_152.baseRadius, endpoint_prop_panel_3_line2_152.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_3_line2_152) {
    mesh_prop_panel_3_line2_152Geometry.scale(0.0737, 0.00378, 0.00504);
  }
  const mesh_prop_panel_3_line2_152 = new THREE.Mesh(
    mesh_prop_panel_3_line2_152Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_3_line2_152.name = "Text line prop-panel-3 2";
  if (endpoint_prop_panel_3_line2_152) {
    mesh_prop_panel_3_line2_152.position.copy(endpoint_prop_panel_3_line2_152.midpoint);
    mesh_prop_panel_3_line2_152.quaternion.copy(endpoint_prop_panel_3_line2_152.quaternion);
  }
  mesh_prop_panel_3_line2_152.castShadow = options.castShadow ?? true;
  mesh_prop_panel_3_line2_152.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_3_line2_152.userData.sculptComponent = { id: "prop-panel-3-line2" };
  node_prop_panel_3_line2_152.add(mesh_prop_panel_3_line2_152);
  meshes["prop-panel-3-line2"] = mesh_prop_panel_3_line2_152;
  colliders["prop-panel-3-line2"] = {};
  destructionGroups["prop-panel-3"] ??= [];
  destructionGroups["prop-panel-3"].push(node_prop_panel_3_line2_152);

  const endpoint_prop_panel_3_line3_153 = makeAttachmentEndpoint(null);
  const node_prop_panel_3_line3_153 = new THREE.Group();
  node_prop_panel_3_line3_153.name = "Text line prop-panel-3 3__pivot";
  node_prop_panel_3_line3_153.scale.set(1, 1, 1);
  if (endpoint_prop_panel_3_line3_153) {
    node_prop_panel_3_line3_153.position.copy(endpoint_prop_panel_3_line3_153.start);
    node_prop_panel_3_line3_153.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_3_line3_153.position.set(-0.02362, -0.01606, 0.00378);
    node_prop_panel_3_line3_153.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_3_line3_153.userData.sculptComponent = { id: "prop-panel-3-line3" };
  node_prop_panel_3_line3_153.userData.actionProfile = {};
  (nodes["prop-panel-3"] ?? root).add(node_prop_panel_3_line3_153);
  nodes["prop-panel-3-line3"] = node_prop_panel_3_line3_153;
  const mesh_prop_panel_3_line3_153Geometry = endpoint_prop_panel_3_line3_153
    ? new THREE.CylinderGeometry(endpoint_prop_panel_3_line3_153.endRadius, endpoint_prop_panel_3_line3_153.baseRadius, endpoint_prop_panel_3_line3_153.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_3_line3_153) {
    mesh_prop_panel_3_line3_153Geometry.scale(0.10394, 0.00378, 0.00504);
  }
  const mesh_prop_panel_3_line3_153 = new THREE.Mesh(
    mesh_prop_panel_3_line3_153Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_3_line3_153.name = "Text line prop-panel-3 3";
  if (endpoint_prop_panel_3_line3_153) {
    mesh_prop_panel_3_line3_153.position.copy(endpoint_prop_panel_3_line3_153.midpoint);
    mesh_prop_panel_3_line3_153.quaternion.copy(endpoint_prop_panel_3_line3_153.quaternion);
  }
  mesh_prop_panel_3_line3_153.castShadow = options.castShadow ?? true;
  mesh_prop_panel_3_line3_153.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_3_line3_153.userData.sculptComponent = { id: "prop-panel-3-line3" };
  node_prop_panel_3_line3_153.add(mesh_prop_panel_3_line3_153);
  meshes["prop-panel-3-line3"] = mesh_prop_panel_3_line3_153;
  colliders["prop-panel-3-line3"] = {};
  destructionGroups["prop-panel-3"] ??= [];
  destructionGroups["prop-panel-3"].push(node_prop_panel_3_line3_153);

  const endpoint_prop_panel_3_line4_154 = makeAttachmentEndpoint(null);
  const node_prop_panel_3_line4_154 = new THREE.Group();
  node_prop_panel_3_line4_154.name = "Text line prop-panel-3 4__pivot";
  node_prop_panel_3_line4_154.scale.set(1, 1, 1);
  if (endpoint_prop_panel_3_line4_154) {
    node_prop_panel_3_line4_154.position.copy(endpoint_prop_panel_3_line4_154.start);
    node_prop_panel_3_line4_154.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_3_line4_154.position.set(-0.03118, -0.04819, 0.00378);
    node_prop_panel_3_line4_154.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_3_line4_154.userData.sculptComponent = { id: "prop-panel-3-line4" };
  node_prop_panel_3_line4_154.userData.actionProfile = {};
  (nodes["prop-panel-3"] ?? root).add(node_prop_panel_3_line4_154);
  nodes["prop-panel-3-line4"] = node_prop_panel_3_line4_154;
  const mesh_prop_panel_3_line4_154Geometry = endpoint_prop_panel_3_line4_154
    ? new THREE.CylinderGeometry(endpoint_prop_panel_3_line4_154.endRadius, endpoint_prop_panel_3_line4_154.baseRadius, endpoint_prop_panel_3_line4_154.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_3_line4_154) {
    mesh_prop_panel_3_line4_154Geometry.scale(0.08882, 0.00378, 0.00504);
  }
  const mesh_prop_panel_3_line4_154 = new THREE.Mesh(
    mesh_prop_panel_3_line4_154Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_3_line4_154.name = "Text line prop-panel-3 4";
  if (endpoint_prop_panel_3_line4_154) {
    mesh_prop_panel_3_line4_154.position.copy(endpoint_prop_panel_3_line4_154.midpoint);
    mesh_prop_panel_3_line4_154.quaternion.copy(endpoint_prop_panel_3_line4_154.quaternion);
  }
  mesh_prop_panel_3_line4_154.castShadow = options.castShadow ?? true;
  mesh_prop_panel_3_line4_154.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_3_line4_154.userData.sculptComponent = { id: "prop-panel-3-line4" };
  node_prop_panel_3_line4_154.add(mesh_prop_panel_3_line4_154);
  meshes["prop-panel-3-line4"] = mesh_prop_panel_3_line4_154;
  colliders["prop-panel-3-line4"] = {};
  destructionGroups["prop-panel-3"] ??= [];
  destructionGroups["prop-panel-3"].push(node_prop_panel_3_line4_154);

  const endpoint_prop_panel_4_155 = makeAttachmentEndpoint(null);
  const node_prop_panel_4_155 = new THREE.Group();
  node_prop_panel_4_155.name = "Holo panel prop-panel-4__pivot";
  node_prop_panel_4_155.scale.set(1, 1, 1);
  if (endpoint_prop_panel_4_155) {
    node_prop_panel_4_155.position.copy(endpoint_prop_panel_4_155.start);
    node_prop_panel_4_155.rotation.set(0.0, -0.55, 0.0);
  } else {
    node_prop_panel_4_155.position.set(0.3937, 1.37008, 0.15748);
    node_prop_panel_4_155.rotation.set(0.0, -0.55, 0.0);
  }
  node_prop_panel_4_155.userData.sculptComponent = { id: "prop-panel-4" };
  node_prop_panel_4_155.userData.actionProfile = {};
  (nodes["root"] ?? root).add(node_prop_panel_4_155);
  nodes["prop-panel-4"] = node_prop_panel_4_155;
  const mesh_prop_panel_4_155Geometry = endpoint_prop_panel_4_155
    ? new THREE.CylinderGeometry(endpoint_prop_panel_4_155.endRadius, endpoint_prop_panel_4_155.baseRadius, endpoint_prop_panel_4_155.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_4_155) {
    mesh_prop_panel_4_155Geometry.scale(0.23622, 0.29921, 0.00504);
  }
  const mesh_prop_panel_4_155 = new THREE.Mesh(
    mesh_prop_panel_4_155Geometry,
    materialMap["holo-panel"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_4_155.name = "Holo panel prop-panel-4";
  if (endpoint_prop_panel_4_155) {
    mesh_prop_panel_4_155.position.copy(endpoint_prop_panel_4_155.midpoint);
    mesh_prop_panel_4_155.quaternion.copy(endpoint_prop_panel_4_155.quaternion);
  }
  mesh_prop_panel_4_155.castShadow = options.castShadow ?? true;
  mesh_prop_panel_4_155.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_4_155.userData.sculptComponent = { id: "prop-panel-4" };
  node_prop_panel_4_155.add(mesh_prop_panel_4_155);
  meshes["prop-panel-4"] = mesh_prop_panel_4_155;
  colliders["prop-panel-4"] = {};
  destructionGroups["prop-panel-4"] ??= [];
  destructionGroups["prop-panel-4"].push(node_prop_panel_4_155);

  const endpoint_prop_panel_4_edge0_156 = makeAttachmentEndpoint(null);
  const node_prop_panel_4_edge0_156 = new THREE.Group();
  node_prop_panel_4_edge0_156.name = "Panel edge prop-panel-4 0__pivot";
  node_prop_panel_4_edge0_156.scale.set(1, 1, 1);
  if (endpoint_prop_panel_4_edge0_156) {
    node_prop_panel_4_edge0_156.position.copy(endpoint_prop_panel_4_edge0_156.start);
    node_prop_panel_4_edge0_156.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_4_edge0_156.position.set(0.0, 0.14961, 0.0);
    node_prop_panel_4_edge0_156.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_4_edge0_156.userData.sculptComponent = { id: "prop-panel-4-edge0" };
  node_prop_panel_4_edge0_156.userData.actionProfile = {};
  (nodes["prop-panel-4"] ?? root).add(node_prop_panel_4_edge0_156);
  nodes["prop-panel-4-edge0"] = node_prop_panel_4_edge0_156;
  const mesh_prop_panel_4_edge0_156Geometry = endpoint_prop_panel_4_edge0_156
    ? new THREE.CylinderGeometry(endpoint_prop_panel_4_edge0_156.endRadius, endpoint_prop_panel_4_edge0_156.baseRadius, endpoint_prop_panel_4_edge0_156.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_4_edge0_156) {
    mesh_prop_panel_4_edge0_156Geometry.scale(0.23622, 0.00441, 0.00504);
  }
  const mesh_prop_panel_4_edge0_156 = new THREE.Mesh(
    mesh_prop_panel_4_edge0_156Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_4_edge0_156.name = "Panel edge prop-panel-4 0";
  if (endpoint_prop_panel_4_edge0_156) {
    mesh_prop_panel_4_edge0_156.position.copy(endpoint_prop_panel_4_edge0_156.midpoint);
    mesh_prop_panel_4_edge0_156.quaternion.copy(endpoint_prop_panel_4_edge0_156.quaternion);
  }
  mesh_prop_panel_4_edge0_156.castShadow = options.castShadow ?? true;
  mesh_prop_panel_4_edge0_156.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_4_edge0_156.userData.sculptComponent = { id: "prop-panel-4-edge0" };
  node_prop_panel_4_edge0_156.add(mesh_prop_panel_4_edge0_156);
  meshes["prop-panel-4-edge0"] = mesh_prop_panel_4_edge0_156;
  colliders["prop-panel-4-edge0"] = {};
  destructionGroups["prop-panel-4"] ??= [];
  destructionGroups["prop-panel-4"].push(node_prop_panel_4_edge0_156);

  const endpoint_prop_panel_4_edge1_157 = makeAttachmentEndpoint(null);
  const node_prop_panel_4_edge1_157 = new THREE.Group();
  node_prop_panel_4_edge1_157.name = "Panel edge prop-panel-4 1__pivot";
  node_prop_panel_4_edge1_157.scale.set(1, 1, 1);
  if (endpoint_prop_panel_4_edge1_157) {
    node_prop_panel_4_edge1_157.position.copy(endpoint_prop_panel_4_edge1_157.start);
    node_prop_panel_4_edge1_157.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_4_edge1_157.position.set(0.0, -0.14961, 0.0);
    node_prop_panel_4_edge1_157.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_4_edge1_157.userData.sculptComponent = { id: "prop-panel-4-edge1" };
  node_prop_panel_4_edge1_157.userData.actionProfile = {};
  (nodes["prop-panel-4"] ?? root).add(node_prop_panel_4_edge1_157);
  nodes["prop-panel-4-edge1"] = node_prop_panel_4_edge1_157;
  const mesh_prop_panel_4_edge1_157Geometry = endpoint_prop_panel_4_edge1_157
    ? new THREE.CylinderGeometry(endpoint_prop_panel_4_edge1_157.endRadius, endpoint_prop_panel_4_edge1_157.baseRadius, endpoint_prop_panel_4_edge1_157.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_4_edge1_157) {
    mesh_prop_panel_4_edge1_157Geometry.scale(0.23622, 0.00441, 0.00504);
  }
  const mesh_prop_panel_4_edge1_157 = new THREE.Mesh(
    mesh_prop_panel_4_edge1_157Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_4_edge1_157.name = "Panel edge prop-panel-4 1";
  if (endpoint_prop_panel_4_edge1_157) {
    mesh_prop_panel_4_edge1_157.position.copy(endpoint_prop_panel_4_edge1_157.midpoint);
    mesh_prop_panel_4_edge1_157.quaternion.copy(endpoint_prop_panel_4_edge1_157.quaternion);
  }
  mesh_prop_panel_4_edge1_157.castShadow = options.castShadow ?? true;
  mesh_prop_panel_4_edge1_157.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_4_edge1_157.userData.sculptComponent = { id: "prop-panel-4-edge1" };
  node_prop_panel_4_edge1_157.add(mesh_prop_panel_4_edge1_157);
  meshes["prop-panel-4-edge1"] = mesh_prop_panel_4_edge1_157;
  colliders["prop-panel-4-edge1"] = {};
  destructionGroups["prop-panel-4"] ??= [];
  destructionGroups["prop-panel-4"].push(node_prop_panel_4_edge1_157);

  const endpoint_prop_panel_4_edge2_158 = makeAttachmentEndpoint(null);
  const node_prop_panel_4_edge2_158 = new THREE.Group();
  node_prop_panel_4_edge2_158.name = "Panel edge prop-panel-4 2__pivot";
  node_prop_panel_4_edge2_158.scale.set(1, 1, 1);
  if (endpoint_prop_panel_4_edge2_158) {
    node_prop_panel_4_edge2_158.position.copy(endpoint_prop_panel_4_edge2_158.start);
    node_prop_panel_4_edge2_158.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_4_edge2_158.position.set(-0.11811, 0.0, 0.0);
    node_prop_panel_4_edge2_158.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_4_edge2_158.userData.sculptComponent = { id: "prop-panel-4-edge2" };
  node_prop_panel_4_edge2_158.userData.actionProfile = {};
  (nodes["prop-panel-4"] ?? root).add(node_prop_panel_4_edge2_158);
  nodes["prop-panel-4-edge2"] = node_prop_panel_4_edge2_158;
  const mesh_prop_panel_4_edge2_158Geometry = endpoint_prop_panel_4_edge2_158
    ? new THREE.CylinderGeometry(endpoint_prop_panel_4_edge2_158.endRadius, endpoint_prop_panel_4_edge2_158.baseRadius, endpoint_prop_panel_4_edge2_158.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_4_edge2_158) {
    mesh_prop_panel_4_edge2_158Geometry.scale(0.00441, 0.29921, 0.00504);
  }
  const mesh_prop_panel_4_edge2_158 = new THREE.Mesh(
    mesh_prop_panel_4_edge2_158Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_4_edge2_158.name = "Panel edge prop-panel-4 2";
  if (endpoint_prop_panel_4_edge2_158) {
    mesh_prop_panel_4_edge2_158.position.copy(endpoint_prop_panel_4_edge2_158.midpoint);
    mesh_prop_panel_4_edge2_158.quaternion.copy(endpoint_prop_panel_4_edge2_158.quaternion);
  }
  mesh_prop_panel_4_edge2_158.castShadow = options.castShadow ?? true;
  mesh_prop_panel_4_edge2_158.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_4_edge2_158.userData.sculptComponent = { id: "prop-panel-4-edge2" };
  node_prop_panel_4_edge2_158.add(mesh_prop_panel_4_edge2_158);
  meshes["prop-panel-4-edge2"] = mesh_prop_panel_4_edge2_158;
  colliders["prop-panel-4-edge2"] = {};
  destructionGroups["prop-panel-4"] ??= [];
  destructionGroups["prop-panel-4"].push(node_prop_panel_4_edge2_158);

  const endpoint_prop_panel_4_edge3_159 = makeAttachmentEndpoint(null);
  const node_prop_panel_4_edge3_159 = new THREE.Group();
  node_prop_panel_4_edge3_159.name = "Panel edge prop-panel-4 3__pivot";
  node_prop_panel_4_edge3_159.scale.set(1, 1, 1);
  if (endpoint_prop_panel_4_edge3_159) {
    node_prop_panel_4_edge3_159.position.copy(endpoint_prop_panel_4_edge3_159.start);
    node_prop_panel_4_edge3_159.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_4_edge3_159.position.set(0.11811, 0.0, 0.0);
    node_prop_panel_4_edge3_159.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_4_edge3_159.userData.sculptComponent = { id: "prop-panel-4-edge3" };
  node_prop_panel_4_edge3_159.userData.actionProfile = {};
  (nodes["prop-panel-4"] ?? root).add(node_prop_panel_4_edge3_159);
  nodes["prop-panel-4-edge3"] = node_prop_panel_4_edge3_159;
  const mesh_prop_panel_4_edge3_159Geometry = endpoint_prop_panel_4_edge3_159
    ? new THREE.CylinderGeometry(endpoint_prop_panel_4_edge3_159.endRadius, endpoint_prop_panel_4_edge3_159.baseRadius, endpoint_prop_panel_4_edge3_159.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_4_edge3_159) {
    mesh_prop_panel_4_edge3_159Geometry.scale(0.00441, 0.29921, 0.00504);
  }
  const mesh_prop_panel_4_edge3_159 = new THREE.Mesh(
    mesh_prop_panel_4_edge3_159Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_4_edge3_159.name = "Panel edge prop-panel-4 3";
  if (endpoint_prop_panel_4_edge3_159) {
    mesh_prop_panel_4_edge3_159.position.copy(endpoint_prop_panel_4_edge3_159.midpoint);
    mesh_prop_panel_4_edge3_159.quaternion.copy(endpoint_prop_panel_4_edge3_159.quaternion);
  }
  mesh_prop_panel_4_edge3_159.castShadow = options.castShadow ?? true;
  mesh_prop_panel_4_edge3_159.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_4_edge3_159.userData.sculptComponent = { id: "prop-panel-4-edge3" };
  node_prop_panel_4_edge3_159.add(mesh_prop_panel_4_edge3_159);
  meshes["prop-panel-4-edge3"] = mesh_prop_panel_4_edge3_159;
  colliders["prop-panel-4-edge3"] = {};
  destructionGroups["prop-panel-4"] ??= [];
  destructionGroups["prop-panel-4"].push(node_prop_panel_4_edge3_159);

  const endpoint_prop_panel_4_ring_160 = makeAttachmentEndpoint(null);
  const node_prop_panel_4_ring_160 = new THREE.Group();
  node_prop_panel_4_ring_160.name = "Panel ring prop-panel-4__pivot";
  node_prop_panel_4_ring_160.scale.set(1, 1, 1);
  if (endpoint_prop_panel_4_ring_160) {
    node_prop_panel_4_ring_160.position.copy(endpoint_prop_panel_4_ring_160.start);
    node_prop_panel_4_ring_160.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_4_ring_160.position.set(0.0, 0.0, 0.00378);
    node_prop_panel_4_ring_160.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_4_ring_160.userData.sculptComponent = { id: "prop-panel-4-ring" };
  node_prop_panel_4_ring_160.userData.actionProfile = {};
  (nodes["prop-panel-4"] ?? root).add(node_prop_panel_4_ring_160);
  nodes["prop-panel-4-ring"] = node_prop_panel_4_ring_160;
  const mesh_prop_panel_4_ring_160Geometry = endpoint_prop_panel_4_ring_160
    ? new THREE.CylinderGeometry(endpoint_prop_panel_4_ring_160.endRadius, endpoint_prop_panel_4_ring_160.baseRadius, endpoint_prop_panel_4_ring_160.length, 8, 4)
    : new THREE.TorusGeometry(0.45, 0.0315, 8, 16);
  if (!endpoint_prop_panel_4_ring_160) {
    mesh_prop_panel_4_ring_160Geometry.scale(0.17848, 0.17848, 0.17848);
  }
  const mesh_prop_panel_4_ring_160 = new THREE.Mesh(
    mesh_prop_panel_4_ring_160Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_4_ring_160.name = "Panel ring prop-panel-4";
  if (endpoint_prop_panel_4_ring_160) {
    mesh_prop_panel_4_ring_160.position.copy(endpoint_prop_panel_4_ring_160.midpoint);
    mesh_prop_panel_4_ring_160.quaternion.copy(endpoint_prop_panel_4_ring_160.quaternion);
  }
  mesh_prop_panel_4_ring_160.castShadow = options.castShadow ?? true;
  mesh_prop_panel_4_ring_160.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_4_ring_160.userData.sculptComponent = { id: "prop-panel-4-ring" };
  node_prop_panel_4_ring_160.add(mesh_prop_panel_4_ring_160);
  meshes["prop-panel-4-ring"] = mesh_prop_panel_4_ring_160;
  colliders["prop-panel-4-ring"] = {};
  destructionGroups["prop-panel-4"] ??= [];
  destructionGroups["prop-panel-4"].push(node_prop_panel_4_ring_160);

  const endpoint_prop_panel_4_line0_161 = makeAttachmentEndpoint(null);
  const node_prop_panel_4_line0_161 = new THREE.Group();
  node_prop_panel_4_line0_161.name = "Text line prop-panel-4 0__pivot";
  node_prop_panel_4_line0_161.scale.set(1, 1, 1);
  if (endpoint_prop_panel_4_line0_161) {
    node_prop_panel_4_line0_161.position.copy(endpoint_prop_panel_4_line0_161.start);
    node_prop_panel_4_line0_161.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_4_line0_161.position.set(-0.02953, 0.08976, 0.00378);
    node_prop_panel_4_line0_161.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_4_line0_161.userData.sculptComponent = { id: "prop-panel-4-line0" };
  node_prop_panel_4_line0_161.userData.actionProfile = {};
  (nodes["prop-panel-4"] ?? root).add(node_prop_panel_4_line0_161);
  nodes["prop-panel-4-line0"] = node_prop_panel_4_line0_161;
  const mesh_prop_panel_4_line0_161Geometry = endpoint_prop_panel_4_line0_161
    ? new THREE.CylinderGeometry(endpoint_prop_panel_4_line0_161.endRadius, endpoint_prop_panel_4_line0_161.baseRadius, endpoint_prop_panel_4_line0_161.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_4_line0_161) {
    mesh_prop_panel_4_line0_161Geometry.scale(0.12992, 0.00378, 0.00504);
  }
  const mesh_prop_panel_4_line0_161 = new THREE.Mesh(
    mesh_prop_panel_4_line0_161Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_4_line0_161.name = "Text line prop-panel-4 0";
  if (endpoint_prop_panel_4_line0_161) {
    mesh_prop_panel_4_line0_161.position.copy(endpoint_prop_panel_4_line0_161.midpoint);
    mesh_prop_panel_4_line0_161.quaternion.copy(endpoint_prop_panel_4_line0_161.quaternion);
  }
  mesh_prop_panel_4_line0_161.castShadow = options.castShadow ?? true;
  mesh_prop_panel_4_line0_161.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_4_line0_161.userData.sculptComponent = { id: "prop-panel-4-line0" };
  node_prop_panel_4_line0_161.add(mesh_prop_panel_4_line0_161);
  meshes["prop-panel-4-line0"] = mesh_prop_panel_4_line0_161;
  colliders["prop-panel-4-line0"] = {};
  destructionGroups["prop-panel-4"] ??= [];
  destructionGroups["prop-panel-4"].push(node_prop_panel_4_line0_161);

  const endpoint_prop_panel_4_line1_162 = makeAttachmentEndpoint(null);
  const node_prop_panel_4_line1_162 = new THREE.Group();
  node_prop_panel_4_line1_162.name = "Text line prop-panel-4 1__pivot";
  node_prop_panel_4_line1_162.scale.set(1, 1, 1);
  if (endpoint_prop_panel_4_line1_162) {
    node_prop_panel_4_line1_162.position.copy(endpoint_prop_panel_4_line1_162.start);
    node_prop_panel_4_line1_162.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_4_line1_162.position.set(-0.03898, 0.05386, 0.00378);
    node_prop_panel_4_line1_162.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_4_line1_162.userData.sculptComponent = { id: "prop-panel-4-line1" };
  node_prop_panel_4_line1_162.userData.actionProfile = {};
  (nodes["prop-panel-4"] ?? root).add(node_prop_panel_4_line1_162);
  nodes["prop-panel-4-line1"] = node_prop_panel_4_line1_162;
  const mesh_prop_panel_4_line1_162Geometry = endpoint_prop_panel_4_line1_162
    ? new THREE.CylinderGeometry(endpoint_prop_panel_4_line1_162.endRadius, endpoint_prop_panel_4_line1_162.baseRadius, endpoint_prop_panel_4_line1_162.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_4_line1_162) {
    mesh_prop_panel_4_line1_162Geometry.scale(0.11102, 0.00378, 0.00504);
  }
  const mesh_prop_panel_4_line1_162 = new THREE.Mesh(
    mesh_prop_panel_4_line1_162Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_4_line1_162.name = "Text line prop-panel-4 1";
  if (endpoint_prop_panel_4_line1_162) {
    mesh_prop_panel_4_line1_162.position.copy(endpoint_prop_panel_4_line1_162.midpoint);
    mesh_prop_panel_4_line1_162.quaternion.copy(endpoint_prop_panel_4_line1_162.quaternion);
  }
  mesh_prop_panel_4_line1_162.castShadow = options.castShadow ?? true;
  mesh_prop_panel_4_line1_162.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_4_line1_162.userData.sculptComponent = { id: "prop-panel-4-line1" };
  node_prop_panel_4_line1_162.add(mesh_prop_panel_4_line1_162);
  meshes["prop-panel-4-line1"] = mesh_prop_panel_4_line1_162;
  colliders["prop-panel-4-line1"] = {};
  destructionGroups["prop-panel-4"] ??= [];
  destructionGroups["prop-panel-4"].push(node_prop_panel_4_line1_162);

  const endpoint_prop_panel_5_163 = makeAttachmentEndpoint(null);
  const node_prop_panel_5_163 = new THREE.Group();
  node_prop_panel_5_163.name = "Holo panel prop-panel-5__pivot";
  node_prop_panel_5_163.scale.set(1, 1, 1);
  if (endpoint_prop_panel_5_163) {
    node_prop_panel_5_163.position.copy(endpoint_prop_panel_5_163.start);
    node_prop_panel_5_163.rotation.set(0.0, -0.6, 0.0);
  } else {
    node_prop_panel_5_163.position.set(0.47244, 1.00788, 0.09449);
    node_prop_panel_5_163.rotation.set(0.0, -0.6, 0.0);
  }
  node_prop_panel_5_163.userData.sculptComponent = { id: "prop-panel-5" };
  node_prop_panel_5_163.userData.actionProfile = {};
  (nodes["root"] ?? root).add(node_prop_panel_5_163);
  nodes["prop-panel-5"] = node_prop_panel_5_163;
  const mesh_prop_panel_5_163Geometry = endpoint_prop_panel_5_163
    ? new THREE.CylinderGeometry(endpoint_prop_panel_5_163.endRadius, endpoint_prop_panel_5_163.baseRadius, endpoint_prop_panel_5_163.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_5_163) {
    mesh_prop_panel_5_163Geometry.scale(0.28346, 0.34646, 0.00504);
  }
  const mesh_prop_panel_5_163 = new THREE.Mesh(
    mesh_prop_panel_5_163Geometry,
    materialMap["holo-panel"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_5_163.name = "Holo panel prop-panel-5";
  if (endpoint_prop_panel_5_163) {
    mesh_prop_panel_5_163.position.copy(endpoint_prop_panel_5_163.midpoint);
    mesh_prop_panel_5_163.quaternion.copy(endpoint_prop_panel_5_163.quaternion);
  }
  mesh_prop_panel_5_163.castShadow = options.castShadow ?? true;
  mesh_prop_panel_5_163.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_5_163.userData.sculptComponent = { id: "prop-panel-5" };
  node_prop_panel_5_163.add(mesh_prop_panel_5_163);
  meshes["prop-panel-5"] = mesh_prop_panel_5_163;
  colliders["prop-panel-5"] = {};
  destructionGroups["prop-panel-5"] ??= [];
  destructionGroups["prop-panel-5"].push(node_prop_panel_5_163);

  const endpoint_prop_panel_5_edge0_164 = makeAttachmentEndpoint(null);
  const node_prop_panel_5_edge0_164 = new THREE.Group();
  node_prop_panel_5_edge0_164.name = "Panel edge prop-panel-5 0__pivot";
  node_prop_panel_5_edge0_164.scale.set(1, 1, 1);
  if (endpoint_prop_panel_5_edge0_164) {
    node_prop_panel_5_edge0_164.position.copy(endpoint_prop_panel_5_edge0_164.start);
    node_prop_panel_5_edge0_164.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_5_edge0_164.position.set(0.0, 0.17323, 0.0);
    node_prop_panel_5_edge0_164.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_5_edge0_164.userData.sculptComponent = { id: "prop-panel-5-edge0" };
  node_prop_panel_5_edge0_164.userData.actionProfile = {};
  (nodes["prop-panel-5"] ?? root).add(node_prop_panel_5_edge0_164);
  nodes["prop-panel-5-edge0"] = node_prop_panel_5_edge0_164;
  const mesh_prop_panel_5_edge0_164Geometry = endpoint_prop_panel_5_edge0_164
    ? new THREE.CylinderGeometry(endpoint_prop_panel_5_edge0_164.endRadius, endpoint_prop_panel_5_edge0_164.baseRadius, endpoint_prop_panel_5_edge0_164.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_5_edge0_164) {
    mesh_prop_panel_5_edge0_164Geometry.scale(0.28346, 0.00441, 0.00504);
  }
  const mesh_prop_panel_5_edge0_164 = new THREE.Mesh(
    mesh_prop_panel_5_edge0_164Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_5_edge0_164.name = "Panel edge prop-panel-5 0";
  if (endpoint_prop_panel_5_edge0_164) {
    mesh_prop_panel_5_edge0_164.position.copy(endpoint_prop_panel_5_edge0_164.midpoint);
    mesh_prop_panel_5_edge0_164.quaternion.copy(endpoint_prop_panel_5_edge0_164.quaternion);
  }
  mesh_prop_panel_5_edge0_164.castShadow = options.castShadow ?? true;
  mesh_prop_panel_5_edge0_164.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_5_edge0_164.userData.sculptComponent = { id: "prop-panel-5-edge0" };
  node_prop_panel_5_edge0_164.add(mesh_prop_panel_5_edge0_164);
  meshes["prop-panel-5-edge0"] = mesh_prop_panel_5_edge0_164;
  colliders["prop-panel-5-edge0"] = {};
  destructionGroups["prop-panel-5"] ??= [];
  destructionGroups["prop-panel-5"].push(node_prop_panel_5_edge0_164);

  const endpoint_prop_panel_5_edge1_165 = makeAttachmentEndpoint(null);
  const node_prop_panel_5_edge1_165 = new THREE.Group();
  node_prop_panel_5_edge1_165.name = "Panel edge prop-panel-5 1__pivot";
  node_prop_panel_5_edge1_165.scale.set(1, 1, 1);
  if (endpoint_prop_panel_5_edge1_165) {
    node_prop_panel_5_edge1_165.position.copy(endpoint_prop_panel_5_edge1_165.start);
    node_prop_panel_5_edge1_165.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_5_edge1_165.position.set(0.0, -0.17323, 0.0);
    node_prop_panel_5_edge1_165.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_5_edge1_165.userData.sculptComponent = { id: "prop-panel-5-edge1" };
  node_prop_panel_5_edge1_165.userData.actionProfile = {};
  (nodes["prop-panel-5"] ?? root).add(node_prop_panel_5_edge1_165);
  nodes["prop-panel-5-edge1"] = node_prop_panel_5_edge1_165;
  const mesh_prop_panel_5_edge1_165Geometry = endpoint_prop_panel_5_edge1_165
    ? new THREE.CylinderGeometry(endpoint_prop_panel_5_edge1_165.endRadius, endpoint_prop_panel_5_edge1_165.baseRadius, endpoint_prop_panel_5_edge1_165.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_5_edge1_165) {
    mesh_prop_panel_5_edge1_165Geometry.scale(0.28346, 0.00441, 0.00504);
  }
  const mesh_prop_panel_5_edge1_165 = new THREE.Mesh(
    mesh_prop_panel_5_edge1_165Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_5_edge1_165.name = "Panel edge prop-panel-5 1";
  if (endpoint_prop_panel_5_edge1_165) {
    mesh_prop_panel_5_edge1_165.position.copy(endpoint_prop_panel_5_edge1_165.midpoint);
    mesh_prop_panel_5_edge1_165.quaternion.copy(endpoint_prop_panel_5_edge1_165.quaternion);
  }
  mesh_prop_panel_5_edge1_165.castShadow = options.castShadow ?? true;
  mesh_prop_panel_5_edge1_165.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_5_edge1_165.userData.sculptComponent = { id: "prop-panel-5-edge1" };
  node_prop_panel_5_edge1_165.add(mesh_prop_panel_5_edge1_165);
  meshes["prop-panel-5-edge1"] = mesh_prop_panel_5_edge1_165;
  colliders["prop-panel-5-edge1"] = {};
  destructionGroups["prop-panel-5"] ??= [];
  destructionGroups["prop-panel-5"].push(node_prop_panel_5_edge1_165);

  const endpoint_prop_panel_5_edge2_166 = makeAttachmentEndpoint(null);
  const node_prop_panel_5_edge2_166 = new THREE.Group();
  node_prop_panel_5_edge2_166.name = "Panel edge prop-panel-5 2__pivot";
  node_prop_panel_5_edge2_166.scale.set(1, 1, 1);
  if (endpoint_prop_panel_5_edge2_166) {
    node_prop_panel_5_edge2_166.position.copy(endpoint_prop_panel_5_edge2_166.start);
    node_prop_panel_5_edge2_166.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_5_edge2_166.position.set(-0.14173, 0.0, 0.0);
    node_prop_panel_5_edge2_166.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_5_edge2_166.userData.sculptComponent = { id: "prop-panel-5-edge2" };
  node_prop_panel_5_edge2_166.userData.actionProfile = {};
  (nodes["prop-panel-5"] ?? root).add(node_prop_panel_5_edge2_166);
  nodes["prop-panel-5-edge2"] = node_prop_panel_5_edge2_166;
  const mesh_prop_panel_5_edge2_166Geometry = endpoint_prop_panel_5_edge2_166
    ? new THREE.CylinderGeometry(endpoint_prop_panel_5_edge2_166.endRadius, endpoint_prop_panel_5_edge2_166.baseRadius, endpoint_prop_panel_5_edge2_166.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_5_edge2_166) {
    mesh_prop_panel_5_edge2_166Geometry.scale(0.00441, 0.34646, 0.00504);
  }
  const mesh_prop_panel_5_edge2_166 = new THREE.Mesh(
    mesh_prop_panel_5_edge2_166Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_5_edge2_166.name = "Panel edge prop-panel-5 2";
  if (endpoint_prop_panel_5_edge2_166) {
    mesh_prop_panel_5_edge2_166.position.copy(endpoint_prop_panel_5_edge2_166.midpoint);
    mesh_prop_panel_5_edge2_166.quaternion.copy(endpoint_prop_panel_5_edge2_166.quaternion);
  }
  mesh_prop_panel_5_edge2_166.castShadow = options.castShadow ?? true;
  mesh_prop_panel_5_edge2_166.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_5_edge2_166.userData.sculptComponent = { id: "prop-panel-5-edge2" };
  node_prop_panel_5_edge2_166.add(mesh_prop_panel_5_edge2_166);
  meshes["prop-panel-5-edge2"] = mesh_prop_panel_5_edge2_166;
  colliders["prop-panel-5-edge2"] = {};
  destructionGroups["prop-panel-5"] ??= [];
  destructionGroups["prop-panel-5"].push(node_prop_panel_5_edge2_166);

  const endpoint_prop_panel_5_edge3_167 = makeAttachmentEndpoint(null);
  const node_prop_panel_5_edge3_167 = new THREE.Group();
  node_prop_panel_5_edge3_167.name = "Panel edge prop-panel-5 3__pivot";
  node_prop_panel_5_edge3_167.scale.set(1, 1, 1);
  if (endpoint_prop_panel_5_edge3_167) {
    node_prop_panel_5_edge3_167.position.copy(endpoint_prop_panel_5_edge3_167.start);
    node_prop_panel_5_edge3_167.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_5_edge3_167.position.set(0.14173, 0.0, 0.0);
    node_prop_panel_5_edge3_167.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_5_edge3_167.userData.sculptComponent = { id: "prop-panel-5-edge3" };
  node_prop_panel_5_edge3_167.userData.actionProfile = {};
  (nodes["prop-panel-5"] ?? root).add(node_prop_panel_5_edge3_167);
  nodes["prop-panel-5-edge3"] = node_prop_panel_5_edge3_167;
  const mesh_prop_panel_5_edge3_167Geometry = endpoint_prop_panel_5_edge3_167
    ? new THREE.CylinderGeometry(endpoint_prop_panel_5_edge3_167.endRadius, endpoint_prop_panel_5_edge3_167.baseRadius, endpoint_prop_panel_5_edge3_167.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_5_edge3_167) {
    mesh_prop_panel_5_edge3_167Geometry.scale(0.00441, 0.34646, 0.00504);
  }
  const mesh_prop_panel_5_edge3_167 = new THREE.Mesh(
    mesh_prop_panel_5_edge3_167Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_5_edge3_167.name = "Panel edge prop-panel-5 3";
  if (endpoint_prop_panel_5_edge3_167) {
    mesh_prop_panel_5_edge3_167.position.copy(endpoint_prop_panel_5_edge3_167.midpoint);
    mesh_prop_panel_5_edge3_167.quaternion.copy(endpoint_prop_panel_5_edge3_167.quaternion);
  }
  mesh_prop_panel_5_edge3_167.castShadow = options.castShadow ?? true;
  mesh_prop_panel_5_edge3_167.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_5_edge3_167.userData.sculptComponent = { id: "prop-panel-5-edge3" };
  node_prop_panel_5_edge3_167.add(mesh_prop_panel_5_edge3_167);
  meshes["prop-panel-5-edge3"] = mesh_prop_panel_5_edge3_167;
  colliders["prop-panel-5-edge3"] = {};
  destructionGroups["prop-panel-5"] ??= [];
  destructionGroups["prop-panel-5"].push(node_prop_panel_5_edge3_167);

  const endpoint_prop_panel_5_line0_168 = makeAttachmentEndpoint(null);
  const node_prop_panel_5_line0_168 = new THREE.Group();
  node_prop_panel_5_line0_168.name = "Text line prop-panel-5 0__pivot";
  node_prop_panel_5_line0_168.scale.set(1, 1, 1);
  if (endpoint_prop_panel_5_line0_168) {
    node_prop_panel_5_line0_168.position.copy(endpoint_prop_panel_5_line0_168.start);
    node_prop_panel_5_line0_168.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_5_line0_168.position.set(-0.03543, 0.10394, 0.00378);
    node_prop_panel_5_line0_168.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_5_line0_168.userData.sculptComponent = { id: "prop-panel-5-line0" };
  node_prop_panel_5_line0_168.userData.actionProfile = {};
  (nodes["prop-panel-5"] ?? root).add(node_prop_panel_5_line0_168);
  nodes["prop-panel-5-line0"] = node_prop_panel_5_line0_168;
  const mesh_prop_panel_5_line0_168Geometry = endpoint_prop_panel_5_line0_168
    ? new THREE.CylinderGeometry(endpoint_prop_panel_5_line0_168.endRadius, endpoint_prop_panel_5_line0_168.baseRadius, endpoint_prop_panel_5_line0_168.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_5_line0_168) {
    mesh_prop_panel_5_line0_168Geometry.scale(0.15591, 0.00378, 0.00504);
  }
  const mesh_prop_panel_5_line0_168 = new THREE.Mesh(
    mesh_prop_panel_5_line0_168Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_5_line0_168.name = "Text line prop-panel-5 0";
  if (endpoint_prop_panel_5_line0_168) {
    mesh_prop_panel_5_line0_168.position.copy(endpoint_prop_panel_5_line0_168.midpoint);
    mesh_prop_panel_5_line0_168.quaternion.copy(endpoint_prop_panel_5_line0_168.quaternion);
  }
  mesh_prop_panel_5_line0_168.castShadow = options.castShadow ?? true;
  mesh_prop_panel_5_line0_168.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_5_line0_168.userData.sculptComponent = { id: "prop-panel-5-line0" };
  node_prop_panel_5_line0_168.add(mesh_prop_panel_5_line0_168);
  meshes["prop-panel-5-line0"] = mesh_prop_panel_5_line0_168;
  colliders["prop-panel-5-line0"] = {};
  destructionGroups["prop-panel-5"] ??= [];
  destructionGroups["prop-panel-5"].push(node_prop_panel_5_line0_168);

  const endpoint_prop_panel_5_line1_169 = makeAttachmentEndpoint(null);
  const node_prop_panel_5_line1_169 = new THREE.Group();
  node_prop_panel_5_line1_169.name = "Text line prop-panel-5 1__pivot";
  node_prop_panel_5_line1_169.scale.set(1, 1, 1);
  if (endpoint_prop_panel_5_line1_169) {
    node_prop_panel_5_line1_169.position.copy(endpoint_prop_panel_5_line1_169.start);
    node_prop_panel_5_line1_169.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_5_line1_169.position.set(-0.04677, 0.06236, 0.00378);
    node_prop_panel_5_line1_169.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_5_line1_169.userData.sculptComponent = { id: "prop-panel-5-line1" };
  node_prop_panel_5_line1_169.userData.actionProfile = {};
  (nodes["prop-panel-5"] ?? root).add(node_prop_panel_5_line1_169);
  nodes["prop-panel-5-line1"] = node_prop_panel_5_line1_169;
  const mesh_prop_panel_5_line1_169Geometry = endpoint_prop_panel_5_line1_169
    ? new THREE.CylinderGeometry(endpoint_prop_panel_5_line1_169.endRadius, endpoint_prop_panel_5_line1_169.baseRadius, endpoint_prop_panel_5_line1_169.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_5_line1_169) {
    mesh_prop_panel_5_line1_169Geometry.scale(0.13323, 0.00378, 0.00504);
  }
  const mesh_prop_panel_5_line1_169 = new THREE.Mesh(
    mesh_prop_panel_5_line1_169Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_5_line1_169.name = "Text line prop-panel-5 1";
  if (endpoint_prop_panel_5_line1_169) {
    mesh_prop_panel_5_line1_169.position.copy(endpoint_prop_panel_5_line1_169.midpoint);
    mesh_prop_panel_5_line1_169.quaternion.copy(endpoint_prop_panel_5_line1_169.quaternion);
  }
  mesh_prop_panel_5_line1_169.castShadow = options.castShadow ?? true;
  mesh_prop_panel_5_line1_169.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_5_line1_169.userData.sculptComponent = { id: "prop-panel-5-line1" };
  node_prop_panel_5_line1_169.add(mesh_prop_panel_5_line1_169);
  meshes["prop-panel-5-line1"] = mesh_prop_panel_5_line1_169;
  colliders["prop-panel-5-line1"] = {};
  destructionGroups["prop-panel-5"] ??= [];
  destructionGroups["prop-panel-5"].push(node_prop_panel_5_line1_169);

  const endpoint_prop_panel_5_line2_170 = makeAttachmentEndpoint(null);
  const node_prop_panel_5_line2_170 = new THREE.Group();
  node_prop_panel_5_line2_170.name = "Text line prop-panel-5 2__pivot";
  node_prop_panel_5_line2_170.scale.set(1, 1, 1);
  if (endpoint_prop_panel_5_line2_170) {
    node_prop_panel_5_line2_170.position.copy(endpoint_prop_panel_5_line2_170.start);
    node_prop_panel_5_line2_170.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_5_line2_170.position.set(-0.05811, 0.02079, 0.00378);
    node_prop_panel_5_line2_170.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_5_line2_170.userData.sculptComponent = { id: "prop-panel-5-line2" };
  node_prop_panel_5_line2_170.userData.actionProfile = {};
  (nodes["prop-panel-5"] ?? root).add(node_prop_panel_5_line2_170);
  nodes["prop-panel-5-line2"] = node_prop_panel_5_line2_170;
  const mesh_prop_panel_5_line2_170Geometry = endpoint_prop_panel_5_line2_170
    ? new THREE.CylinderGeometry(endpoint_prop_panel_5_line2_170.endRadius, endpoint_prop_panel_5_line2_170.baseRadius, endpoint_prop_panel_5_line2_170.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_5_line2_170) {
    mesh_prop_panel_5_line2_170Geometry.scale(0.11055, 0.00378, 0.00504);
  }
  const mesh_prop_panel_5_line2_170 = new THREE.Mesh(
    mesh_prop_panel_5_line2_170Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_5_line2_170.name = "Text line prop-panel-5 2";
  if (endpoint_prop_panel_5_line2_170) {
    mesh_prop_panel_5_line2_170.position.copy(endpoint_prop_panel_5_line2_170.midpoint);
    mesh_prop_panel_5_line2_170.quaternion.copy(endpoint_prop_panel_5_line2_170.quaternion);
  }
  mesh_prop_panel_5_line2_170.castShadow = options.castShadow ?? true;
  mesh_prop_panel_5_line2_170.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_5_line2_170.userData.sculptComponent = { id: "prop-panel-5-line2" };
  node_prop_panel_5_line2_170.add(mesh_prop_panel_5_line2_170);
  meshes["prop-panel-5-line2"] = mesh_prop_panel_5_line2_170;
  colliders["prop-panel-5-line2"] = {};
  destructionGroups["prop-panel-5"] ??= [];
  destructionGroups["prop-panel-5"].push(node_prop_panel_5_line2_170);

  const endpoint_prop_panel_5_dot_171 = makeAttachmentEndpoint(null);
  const node_prop_panel_5_dot_171 = new THREE.Group();
  node_prop_panel_5_dot_171.name = "Panel dot prop-panel-5__pivot";
  node_prop_panel_5_dot_171.scale.set(1, 1, 1);
  if (endpoint_prop_panel_5_dot_171) {
    node_prop_panel_5_dot_171.position.copy(endpoint_prop_panel_5_dot_171.start);
    node_prop_panel_5_dot_171.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_5_dot_171.position.set(0.0, 0.0, 0.00378);
    node_prop_panel_5_dot_171.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_5_dot_171.userData.sculptComponent = { id: "prop-panel-5-dot" };
  node_prop_panel_5_dot_171.userData.actionProfile = {};
  (nodes["prop-panel-5"] ?? root).add(node_prop_panel_5_dot_171);
  nodes["prop-panel-5-dot"] = node_prop_panel_5_dot_171;
  const mesh_prop_panel_5_dot_171Geometry = endpoint_prop_panel_5_dot_171
    ? new THREE.CylinderGeometry(endpoint_prop_panel_5_dot_171.endRadius, endpoint_prop_panel_5_dot_171.baseRadius, endpoint_prop_panel_5_dot_171.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_prop_panel_5_dot_171) {
    mesh_prop_panel_5_dot_171Geometry.scale(0.04535, 0.04535, 0.04535);
  }
  const mesh_prop_panel_5_dot_171 = new THREE.Mesh(
    mesh_prop_panel_5_dot_171Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_5_dot_171.name = "Panel dot prop-panel-5";
  if (endpoint_prop_panel_5_dot_171) {
    mesh_prop_panel_5_dot_171.position.copy(endpoint_prop_panel_5_dot_171.midpoint);
    mesh_prop_panel_5_dot_171.quaternion.copy(endpoint_prop_panel_5_dot_171.quaternion);
  }
  mesh_prop_panel_5_dot_171.castShadow = options.castShadow ?? true;
  mesh_prop_panel_5_dot_171.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_5_dot_171.userData.sculptComponent = { id: "prop-panel-5-dot" };
  node_prop_panel_5_dot_171.add(mesh_prop_panel_5_dot_171);
  meshes["prop-panel-5-dot"] = mesh_prop_panel_5_dot_171;
  colliders["prop-panel-5-dot"] = {};
  destructionGroups["prop-panel-5"] ??= [];
  destructionGroups["prop-panel-5"].push(node_prop_panel_5_dot_171);

  const endpoint_prop_panel_6_172 = makeAttachmentEndpoint(null);
  const node_prop_panel_6_172 = new THREE.Group();
  node_prop_panel_6_172.name = "Holo panel prop-panel-6__pivot";
  node_prop_panel_6_172.scale.set(1, 1, 1);
  if (endpoint_prop_panel_6_172) {
    node_prop_panel_6_172.position.copy(endpoint_prop_panel_6_172.start);
    node_prop_panel_6_172.rotation.set(0.0, 2.74159, 0.0);
  } else {
    node_prop_panel_6_172.position.set(0.28976, 1.25984, -0.28976);
    node_prop_panel_6_172.rotation.set(0.0, 2.74159, 0.0);
  }
  node_prop_panel_6_172.userData.sculptComponent = { id: "prop-panel-6" };
  node_prop_panel_6_172.userData.actionProfile = {};
  (nodes["root"] ?? root).add(node_prop_panel_6_172);
  nodes["prop-panel-6"] = node_prop_panel_6_172;
  const mesh_prop_panel_6_172Geometry = endpoint_prop_panel_6_172
    ? new THREE.CylinderGeometry(endpoint_prop_panel_6_172.endRadius, endpoint_prop_panel_6_172.baseRadius, endpoint_prop_panel_6_172.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_6_172) {
    mesh_prop_panel_6_172Geometry.scale(0.25197, 0.31496, 0.00504);
  }
  const mesh_prop_panel_6_172 = new THREE.Mesh(
    mesh_prop_panel_6_172Geometry,
    materialMap["holo-panel"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_6_172.name = "Holo panel prop-panel-6";
  if (endpoint_prop_panel_6_172) {
    mesh_prop_panel_6_172.position.copy(endpoint_prop_panel_6_172.midpoint);
    mesh_prop_panel_6_172.quaternion.copy(endpoint_prop_panel_6_172.quaternion);
  }
  mesh_prop_panel_6_172.castShadow = options.castShadow ?? true;
  mesh_prop_panel_6_172.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_6_172.userData.sculptComponent = { id: "prop-panel-6" };
  node_prop_panel_6_172.add(mesh_prop_panel_6_172);
  meshes["prop-panel-6"] = mesh_prop_panel_6_172;
  colliders["prop-panel-6"] = {};
  destructionGroups["prop-panel-6"] ??= [];
  destructionGroups["prop-panel-6"].push(node_prop_panel_6_172);

  const endpoint_prop_panel_6_edge0_173 = makeAttachmentEndpoint(null);
  const node_prop_panel_6_edge0_173 = new THREE.Group();
  node_prop_panel_6_edge0_173.name = "Panel edge prop-panel-6 0__pivot";
  node_prop_panel_6_edge0_173.scale.set(1, 1, 1);
  if (endpoint_prop_panel_6_edge0_173) {
    node_prop_panel_6_edge0_173.position.copy(endpoint_prop_panel_6_edge0_173.start);
    node_prop_panel_6_edge0_173.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_6_edge0_173.position.set(0.0, 0.15748, 0.0);
    node_prop_panel_6_edge0_173.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_6_edge0_173.userData.sculptComponent = { id: "prop-panel-6-edge0" };
  node_prop_panel_6_edge0_173.userData.actionProfile = {};
  (nodes["prop-panel-6"] ?? root).add(node_prop_panel_6_edge0_173);
  nodes["prop-panel-6-edge0"] = node_prop_panel_6_edge0_173;
  const mesh_prop_panel_6_edge0_173Geometry = endpoint_prop_panel_6_edge0_173
    ? new THREE.CylinderGeometry(endpoint_prop_panel_6_edge0_173.endRadius, endpoint_prop_panel_6_edge0_173.baseRadius, endpoint_prop_panel_6_edge0_173.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_6_edge0_173) {
    mesh_prop_panel_6_edge0_173Geometry.scale(0.25197, 0.00441, 0.00504);
  }
  const mesh_prop_panel_6_edge0_173 = new THREE.Mesh(
    mesh_prop_panel_6_edge0_173Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_6_edge0_173.name = "Panel edge prop-panel-6 0";
  if (endpoint_prop_panel_6_edge0_173) {
    mesh_prop_panel_6_edge0_173.position.copy(endpoint_prop_panel_6_edge0_173.midpoint);
    mesh_prop_panel_6_edge0_173.quaternion.copy(endpoint_prop_panel_6_edge0_173.quaternion);
  }
  mesh_prop_panel_6_edge0_173.castShadow = options.castShadow ?? true;
  mesh_prop_panel_6_edge0_173.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_6_edge0_173.userData.sculptComponent = { id: "prop-panel-6-edge0" };
  node_prop_panel_6_edge0_173.add(mesh_prop_panel_6_edge0_173);
  meshes["prop-panel-6-edge0"] = mesh_prop_panel_6_edge0_173;
  colliders["prop-panel-6-edge0"] = {};
  destructionGroups["prop-panel-6"] ??= [];
  destructionGroups["prop-panel-6"].push(node_prop_panel_6_edge0_173);

  const endpoint_prop_panel_6_edge1_174 = makeAttachmentEndpoint(null);
  const node_prop_panel_6_edge1_174 = new THREE.Group();
  node_prop_panel_6_edge1_174.name = "Panel edge prop-panel-6 1__pivot";
  node_prop_panel_6_edge1_174.scale.set(1, 1, 1);
  if (endpoint_prop_panel_6_edge1_174) {
    node_prop_panel_6_edge1_174.position.copy(endpoint_prop_panel_6_edge1_174.start);
    node_prop_panel_6_edge1_174.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_6_edge1_174.position.set(0.0, -0.15748, 0.0);
    node_prop_panel_6_edge1_174.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_6_edge1_174.userData.sculptComponent = { id: "prop-panel-6-edge1" };
  node_prop_panel_6_edge1_174.userData.actionProfile = {};
  (nodes["prop-panel-6"] ?? root).add(node_prop_panel_6_edge1_174);
  nodes["prop-panel-6-edge1"] = node_prop_panel_6_edge1_174;
  const mesh_prop_panel_6_edge1_174Geometry = endpoint_prop_panel_6_edge1_174
    ? new THREE.CylinderGeometry(endpoint_prop_panel_6_edge1_174.endRadius, endpoint_prop_panel_6_edge1_174.baseRadius, endpoint_prop_panel_6_edge1_174.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_6_edge1_174) {
    mesh_prop_panel_6_edge1_174Geometry.scale(0.25197, 0.00441, 0.00504);
  }
  const mesh_prop_panel_6_edge1_174 = new THREE.Mesh(
    mesh_prop_panel_6_edge1_174Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_6_edge1_174.name = "Panel edge prop-panel-6 1";
  if (endpoint_prop_panel_6_edge1_174) {
    mesh_prop_panel_6_edge1_174.position.copy(endpoint_prop_panel_6_edge1_174.midpoint);
    mesh_prop_panel_6_edge1_174.quaternion.copy(endpoint_prop_panel_6_edge1_174.quaternion);
  }
  mesh_prop_panel_6_edge1_174.castShadow = options.castShadow ?? true;
  mesh_prop_panel_6_edge1_174.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_6_edge1_174.userData.sculptComponent = { id: "prop-panel-6-edge1" };
  node_prop_panel_6_edge1_174.add(mesh_prop_panel_6_edge1_174);
  meshes["prop-panel-6-edge1"] = mesh_prop_panel_6_edge1_174;
  colliders["prop-panel-6-edge1"] = {};
  destructionGroups["prop-panel-6"] ??= [];
  destructionGroups["prop-panel-6"].push(node_prop_panel_6_edge1_174);

  const endpoint_prop_panel_6_edge2_175 = makeAttachmentEndpoint(null);
  const node_prop_panel_6_edge2_175 = new THREE.Group();
  node_prop_panel_6_edge2_175.name = "Panel edge prop-panel-6 2__pivot";
  node_prop_panel_6_edge2_175.scale.set(1, 1, 1);
  if (endpoint_prop_panel_6_edge2_175) {
    node_prop_panel_6_edge2_175.position.copy(endpoint_prop_panel_6_edge2_175.start);
    node_prop_panel_6_edge2_175.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_6_edge2_175.position.set(-0.12598, 0.0, 0.0);
    node_prop_panel_6_edge2_175.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_6_edge2_175.userData.sculptComponent = { id: "prop-panel-6-edge2" };
  node_prop_panel_6_edge2_175.userData.actionProfile = {};
  (nodes["prop-panel-6"] ?? root).add(node_prop_panel_6_edge2_175);
  nodes["prop-panel-6-edge2"] = node_prop_panel_6_edge2_175;
  const mesh_prop_panel_6_edge2_175Geometry = endpoint_prop_panel_6_edge2_175
    ? new THREE.CylinderGeometry(endpoint_prop_panel_6_edge2_175.endRadius, endpoint_prop_panel_6_edge2_175.baseRadius, endpoint_prop_panel_6_edge2_175.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_6_edge2_175) {
    mesh_prop_panel_6_edge2_175Geometry.scale(0.00441, 0.31496, 0.00504);
  }
  const mesh_prop_panel_6_edge2_175 = new THREE.Mesh(
    mesh_prop_panel_6_edge2_175Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_6_edge2_175.name = "Panel edge prop-panel-6 2";
  if (endpoint_prop_panel_6_edge2_175) {
    mesh_prop_panel_6_edge2_175.position.copy(endpoint_prop_panel_6_edge2_175.midpoint);
    mesh_prop_panel_6_edge2_175.quaternion.copy(endpoint_prop_panel_6_edge2_175.quaternion);
  }
  mesh_prop_panel_6_edge2_175.castShadow = options.castShadow ?? true;
  mesh_prop_panel_6_edge2_175.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_6_edge2_175.userData.sculptComponent = { id: "prop-panel-6-edge2" };
  node_prop_panel_6_edge2_175.add(mesh_prop_panel_6_edge2_175);
  meshes["prop-panel-6-edge2"] = mesh_prop_panel_6_edge2_175;
  colliders["prop-panel-6-edge2"] = {};
  destructionGroups["prop-panel-6"] ??= [];
  destructionGroups["prop-panel-6"].push(node_prop_panel_6_edge2_175);

  const endpoint_prop_panel_6_edge3_176 = makeAttachmentEndpoint(null);
  const node_prop_panel_6_edge3_176 = new THREE.Group();
  node_prop_panel_6_edge3_176.name = "Panel edge prop-panel-6 3__pivot";
  node_prop_panel_6_edge3_176.scale.set(1, 1, 1);
  if (endpoint_prop_panel_6_edge3_176) {
    node_prop_panel_6_edge3_176.position.copy(endpoint_prop_panel_6_edge3_176.start);
    node_prop_panel_6_edge3_176.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_6_edge3_176.position.set(0.12598, 0.0, 0.0);
    node_prop_panel_6_edge3_176.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_6_edge3_176.userData.sculptComponent = { id: "prop-panel-6-edge3" };
  node_prop_panel_6_edge3_176.userData.actionProfile = {};
  (nodes["prop-panel-6"] ?? root).add(node_prop_panel_6_edge3_176);
  nodes["prop-panel-6-edge3"] = node_prop_panel_6_edge3_176;
  const mesh_prop_panel_6_edge3_176Geometry = endpoint_prop_panel_6_edge3_176
    ? new THREE.CylinderGeometry(endpoint_prop_panel_6_edge3_176.endRadius, endpoint_prop_panel_6_edge3_176.baseRadius, endpoint_prop_panel_6_edge3_176.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_6_edge3_176) {
    mesh_prop_panel_6_edge3_176Geometry.scale(0.00441, 0.31496, 0.00504);
  }
  const mesh_prop_panel_6_edge3_176 = new THREE.Mesh(
    mesh_prop_panel_6_edge3_176Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_6_edge3_176.name = "Panel edge prop-panel-6 3";
  if (endpoint_prop_panel_6_edge3_176) {
    mesh_prop_panel_6_edge3_176.position.copy(endpoint_prop_panel_6_edge3_176.midpoint);
    mesh_prop_panel_6_edge3_176.quaternion.copy(endpoint_prop_panel_6_edge3_176.quaternion);
  }
  mesh_prop_panel_6_edge3_176.castShadow = options.castShadow ?? true;
  mesh_prop_panel_6_edge3_176.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_6_edge3_176.userData.sculptComponent = { id: "prop-panel-6-edge3" };
  node_prop_panel_6_edge3_176.add(mesh_prop_panel_6_edge3_176);
  meshes["prop-panel-6-edge3"] = mesh_prop_panel_6_edge3_176;
  colliders["prop-panel-6-edge3"] = {};
  destructionGroups["prop-panel-6"] ??= [];
  destructionGroups["prop-panel-6"].push(node_prop_panel_6_edge3_176);

  const endpoint_prop_panel_6_line0_177 = makeAttachmentEndpoint(null);
  const node_prop_panel_6_line0_177 = new THREE.Group();
  node_prop_panel_6_line0_177.name = "Text line prop-panel-6 0__pivot";
  node_prop_panel_6_line0_177.scale.set(1, 1, 1);
  if (endpoint_prop_panel_6_line0_177) {
    node_prop_panel_6_line0_177.position.copy(endpoint_prop_panel_6_line0_177.start);
    node_prop_panel_6_line0_177.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_6_line0_177.position.set(-0.0315, 0.09449, 0.00378);
    node_prop_panel_6_line0_177.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_6_line0_177.userData.sculptComponent = { id: "prop-panel-6-line0" };
  node_prop_panel_6_line0_177.userData.actionProfile = {};
  (nodes["prop-panel-6"] ?? root).add(node_prop_panel_6_line0_177);
  nodes["prop-panel-6-line0"] = node_prop_panel_6_line0_177;
  const mesh_prop_panel_6_line0_177Geometry = endpoint_prop_panel_6_line0_177
    ? new THREE.CylinderGeometry(endpoint_prop_panel_6_line0_177.endRadius, endpoint_prop_panel_6_line0_177.baseRadius, endpoint_prop_panel_6_line0_177.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_6_line0_177) {
    mesh_prop_panel_6_line0_177Geometry.scale(0.13858, 0.00378, 0.00504);
  }
  const mesh_prop_panel_6_line0_177 = new THREE.Mesh(
    mesh_prop_panel_6_line0_177Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_6_line0_177.name = "Text line prop-panel-6 0";
  if (endpoint_prop_panel_6_line0_177) {
    mesh_prop_panel_6_line0_177.position.copy(endpoint_prop_panel_6_line0_177.midpoint);
    mesh_prop_panel_6_line0_177.quaternion.copy(endpoint_prop_panel_6_line0_177.quaternion);
  }
  mesh_prop_panel_6_line0_177.castShadow = options.castShadow ?? true;
  mesh_prop_panel_6_line0_177.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_6_line0_177.userData.sculptComponent = { id: "prop-panel-6-line0" };
  node_prop_panel_6_line0_177.add(mesh_prop_panel_6_line0_177);
  meshes["prop-panel-6-line0"] = mesh_prop_panel_6_line0_177;
  colliders["prop-panel-6-line0"] = {};
  destructionGroups["prop-panel-6"] ??= [];
  destructionGroups["prop-panel-6"].push(node_prop_panel_6_line0_177);

  const endpoint_prop_panel_6_line1_178 = makeAttachmentEndpoint(null);
  const node_prop_panel_6_line1_178 = new THREE.Group();
  node_prop_panel_6_line1_178.name = "Text line prop-panel-6 1__pivot";
  node_prop_panel_6_line1_178.scale.set(1, 1, 1);
  if (endpoint_prop_panel_6_line1_178) {
    node_prop_panel_6_line1_178.position.copy(endpoint_prop_panel_6_line1_178.start);
    node_prop_panel_6_line1_178.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_6_line1_178.position.set(-0.04157, 0.05669, 0.00378);
    node_prop_panel_6_line1_178.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_6_line1_178.userData.sculptComponent = { id: "prop-panel-6-line1" };
  node_prop_panel_6_line1_178.userData.actionProfile = {};
  (nodes["prop-panel-6"] ?? root).add(node_prop_panel_6_line1_178);
  nodes["prop-panel-6-line1"] = node_prop_panel_6_line1_178;
  const mesh_prop_panel_6_line1_178Geometry = endpoint_prop_panel_6_line1_178
    ? new THREE.CylinderGeometry(endpoint_prop_panel_6_line1_178.endRadius, endpoint_prop_panel_6_line1_178.baseRadius, endpoint_prop_panel_6_line1_178.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_6_line1_178) {
    mesh_prop_panel_6_line1_178Geometry.scale(0.11843, 0.00378, 0.00504);
  }
  const mesh_prop_panel_6_line1_178 = new THREE.Mesh(
    mesh_prop_panel_6_line1_178Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_6_line1_178.name = "Text line prop-panel-6 1";
  if (endpoint_prop_panel_6_line1_178) {
    mesh_prop_panel_6_line1_178.position.copy(endpoint_prop_panel_6_line1_178.midpoint);
    mesh_prop_panel_6_line1_178.quaternion.copy(endpoint_prop_panel_6_line1_178.quaternion);
  }
  mesh_prop_panel_6_line1_178.castShadow = options.castShadow ?? true;
  mesh_prop_panel_6_line1_178.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_6_line1_178.userData.sculptComponent = { id: "prop-panel-6-line1" };
  node_prop_panel_6_line1_178.add(mesh_prop_panel_6_line1_178);
  meshes["prop-panel-6-line1"] = mesh_prop_panel_6_line1_178;
  colliders["prop-panel-6-line1"] = {};
  destructionGroups["prop-panel-6"] ??= [];
  destructionGroups["prop-panel-6"].push(node_prop_panel_6_line1_178);

  const endpoint_prop_panel_6_line2_179 = makeAttachmentEndpoint(null);
  const node_prop_panel_6_line2_179 = new THREE.Group();
  node_prop_panel_6_line2_179.name = "Text line prop-panel-6 2__pivot";
  node_prop_panel_6_line2_179.scale.set(1, 1, 1);
  if (endpoint_prop_panel_6_line2_179) {
    node_prop_panel_6_line2_179.position.copy(endpoint_prop_panel_6_line2_179.start);
    node_prop_panel_6_line2_179.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_6_line2_179.position.set(-0.05165, 0.0189, 0.00378);
    node_prop_panel_6_line2_179.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_6_line2_179.userData.sculptComponent = { id: "prop-panel-6-line2" };
  node_prop_panel_6_line2_179.userData.actionProfile = {};
  (nodes["prop-panel-6"] ?? root).add(node_prop_panel_6_line2_179);
  nodes["prop-panel-6-line2"] = node_prop_panel_6_line2_179;
  const mesh_prop_panel_6_line2_179Geometry = endpoint_prop_panel_6_line2_179
    ? new THREE.CylinderGeometry(endpoint_prop_panel_6_line2_179.endRadius, endpoint_prop_panel_6_line2_179.baseRadius, endpoint_prop_panel_6_line2_179.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_6_line2_179) {
    mesh_prop_panel_6_line2_179Geometry.scale(0.09827, 0.00378, 0.00504);
  }
  const mesh_prop_panel_6_line2_179 = new THREE.Mesh(
    mesh_prop_panel_6_line2_179Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_6_line2_179.name = "Text line prop-panel-6 2";
  if (endpoint_prop_panel_6_line2_179) {
    mesh_prop_panel_6_line2_179.position.copy(endpoint_prop_panel_6_line2_179.midpoint);
    mesh_prop_panel_6_line2_179.quaternion.copy(endpoint_prop_panel_6_line2_179.quaternion);
  }
  mesh_prop_panel_6_line2_179.castShadow = options.castShadow ?? true;
  mesh_prop_panel_6_line2_179.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_6_line2_179.userData.sculptComponent = { id: "prop-panel-6-line2" };
  node_prop_panel_6_line2_179.add(mesh_prop_panel_6_line2_179);
  meshes["prop-panel-6-line2"] = mesh_prop_panel_6_line2_179;
  colliders["prop-panel-6-line2"] = {};
  destructionGroups["prop-panel-6"] ??= [];
  destructionGroups["prop-panel-6"].push(node_prop_panel_6_line2_179);

  const endpoint_prop_panel_6_line3_180 = makeAttachmentEndpoint(null);
  const node_prop_panel_6_line3_180 = new THREE.Group();
  node_prop_panel_6_line3_180.name = "Text line prop-panel-6 3__pivot";
  node_prop_panel_6_line3_180.scale.set(1, 1, 1);
  if (endpoint_prop_panel_6_line3_180) {
    node_prop_panel_6_line3_180.position.copy(endpoint_prop_panel_6_line3_180.start);
    node_prop_panel_6_line3_180.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_6_line3_180.position.set(-0.0315, -0.0189, 0.00378);
    node_prop_panel_6_line3_180.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_6_line3_180.userData.sculptComponent = { id: "prop-panel-6-line3" };
  node_prop_panel_6_line3_180.userData.actionProfile = {};
  (nodes["prop-panel-6"] ?? root).add(node_prop_panel_6_line3_180);
  nodes["prop-panel-6-line3"] = node_prop_panel_6_line3_180;
  const mesh_prop_panel_6_line3_180Geometry = endpoint_prop_panel_6_line3_180
    ? new THREE.CylinderGeometry(endpoint_prop_panel_6_line3_180.endRadius, endpoint_prop_panel_6_line3_180.baseRadius, endpoint_prop_panel_6_line3_180.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_6_line3_180) {
    mesh_prop_panel_6_line3_180Geometry.scale(0.13858, 0.00378, 0.00504);
  }
  const mesh_prop_panel_6_line3_180 = new THREE.Mesh(
    mesh_prop_panel_6_line3_180Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_6_line3_180.name = "Text line prop-panel-6 3";
  if (endpoint_prop_panel_6_line3_180) {
    mesh_prop_panel_6_line3_180.position.copy(endpoint_prop_panel_6_line3_180.midpoint);
    mesh_prop_panel_6_line3_180.quaternion.copy(endpoint_prop_panel_6_line3_180.quaternion);
  }
  mesh_prop_panel_6_line3_180.castShadow = options.castShadow ?? true;
  mesh_prop_panel_6_line3_180.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_6_line3_180.userData.sculptComponent = { id: "prop-panel-6-line3" };
  node_prop_panel_6_line3_180.add(mesh_prop_panel_6_line3_180);
  meshes["prop-panel-6-line3"] = mesh_prop_panel_6_line3_180;
  colliders["prop-panel-6-line3"] = {};
  destructionGroups["prop-panel-6"] ??= [];
  destructionGroups["prop-panel-6"].push(node_prop_panel_6_line3_180);

  const endpoint_prop_panel_7_181 = makeAttachmentEndpoint(null);
  const node_prop_panel_7_181 = new THREE.Group();
  node_prop_panel_7_181.name = "Holo panel prop-panel-7__pivot";
  node_prop_panel_7_181.scale.set(1, 1, 1);
  if (endpoint_prop_panel_7_181) {
    node_prop_panel_7_181.position.copy(endpoint_prop_panel_7_181.start);
    node_prop_panel_7_181.rotation.set(0.0, 3.54159, 0.0);
  } else {
    node_prop_panel_7_181.position.set(-0.31496, 0.94488, -0.25827);
    node_prop_panel_7_181.rotation.set(0.0, 3.54159, 0.0);
  }
  node_prop_panel_7_181.userData.sculptComponent = { id: "prop-panel-7" };
  node_prop_panel_7_181.userData.actionProfile = {};
  (nodes["root"] ?? root).add(node_prop_panel_7_181);
  nodes["prop-panel-7"] = node_prop_panel_7_181;
  const mesh_prop_panel_7_181Geometry = endpoint_prop_panel_7_181
    ? new THREE.CylinderGeometry(endpoint_prop_panel_7_181.endRadius, endpoint_prop_panel_7_181.baseRadius, endpoint_prop_panel_7_181.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_7_181) {
    mesh_prop_panel_7_181Geometry.scale(0.25197, 0.31496, 0.00504);
  }
  const mesh_prop_panel_7_181 = new THREE.Mesh(
    mesh_prop_panel_7_181Geometry,
    materialMap["holo-panel"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_7_181.name = "Holo panel prop-panel-7";
  if (endpoint_prop_panel_7_181) {
    mesh_prop_panel_7_181.position.copy(endpoint_prop_panel_7_181.midpoint);
    mesh_prop_panel_7_181.quaternion.copy(endpoint_prop_panel_7_181.quaternion);
  }
  mesh_prop_panel_7_181.castShadow = options.castShadow ?? true;
  mesh_prop_panel_7_181.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_7_181.userData.sculptComponent = { id: "prop-panel-7" };
  node_prop_panel_7_181.add(mesh_prop_panel_7_181);
  meshes["prop-panel-7"] = mesh_prop_panel_7_181;
  colliders["prop-panel-7"] = {};
  destructionGroups["prop-panel-7"] ??= [];
  destructionGroups["prop-panel-7"].push(node_prop_panel_7_181);

  const endpoint_prop_panel_7_edge0_182 = makeAttachmentEndpoint(null);
  const node_prop_panel_7_edge0_182 = new THREE.Group();
  node_prop_panel_7_edge0_182.name = "Panel edge prop-panel-7 0__pivot";
  node_prop_panel_7_edge0_182.scale.set(1, 1, 1);
  if (endpoint_prop_panel_7_edge0_182) {
    node_prop_panel_7_edge0_182.position.copy(endpoint_prop_panel_7_edge0_182.start);
    node_prop_panel_7_edge0_182.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_7_edge0_182.position.set(0.0, 0.15748, 0.0);
    node_prop_panel_7_edge0_182.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_7_edge0_182.userData.sculptComponent = { id: "prop-panel-7-edge0" };
  node_prop_panel_7_edge0_182.userData.actionProfile = {};
  (nodes["prop-panel-7"] ?? root).add(node_prop_panel_7_edge0_182);
  nodes["prop-panel-7-edge0"] = node_prop_panel_7_edge0_182;
  const mesh_prop_panel_7_edge0_182Geometry = endpoint_prop_panel_7_edge0_182
    ? new THREE.CylinderGeometry(endpoint_prop_panel_7_edge0_182.endRadius, endpoint_prop_panel_7_edge0_182.baseRadius, endpoint_prop_panel_7_edge0_182.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_7_edge0_182) {
    mesh_prop_panel_7_edge0_182Geometry.scale(0.25197, 0.00441, 0.00504);
  }
  const mesh_prop_panel_7_edge0_182 = new THREE.Mesh(
    mesh_prop_panel_7_edge0_182Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_7_edge0_182.name = "Panel edge prop-panel-7 0";
  if (endpoint_prop_panel_7_edge0_182) {
    mesh_prop_panel_7_edge0_182.position.copy(endpoint_prop_panel_7_edge0_182.midpoint);
    mesh_prop_panel_7_edge0_182.quaternion.copy(endpoint_prop_panel_7_edge0_182.quaternion);
  }
  mesh_prop_panel_7_edge0_182.castShadow = options.castShadow ?? true;
  mesh_prop_panel_7_edge0_182.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_7_edge0_182.userData.sculptComponent = { id: "prop-panel-7-edge0" };
  node_prop_panel_7_edge0_182.add(mesh_prop_panel_7_edge0_182);
  meshes["prop-panel-7-edge0"] = mesh_prop_panel_7_edge0_182;
  colliders["prop-panel-7-edge0"] = {};
  destructionGroups["prop-panel-7"] ??= [];
  destructionGroups["prop-panel-7"].push(node_prop_panel_7_edge0_182);

  const endpoint_prop_panel_7_edge1_183 = makeAttachmentEndpoint(null);
  const node_prop_panel_7_edge1_183 = new THREE.Group();
  node_prop_panel_7_edge1_183.name = "Panel edge prop-panel-7 1__pivot";
  node_prop_panel_7_edge1_183.scale.set(1, 1, 1);
  if (endpoint_prop_panel_7_edge1_183) {
    node_prop_panel_7_edge1_183.position.copy(endpoint_prop_panel_7_edge1_183.start);
    node_prop_panel_7_edge1_183.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_7_edge1_183.position.set(0.0, -0.15748, 0.0);
    node_prop_panel_7_edge1_183.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_7_edge1_183.userData.sculptComponent = { id: "prop-panel-7-edge1" };
  node_prop_panel_7_edge1_183.userData.actionProfile = {};
  (nodes["prop-panel-7"] ?? root).add(node_prop_panel_7_edge1_183);
  nodes["prop-panel-7-edge1"] = node_prop_panel_7_edge1_183;
  const mesh_prop_panel_7_edge1_183Geometry = endpoint_prop_panel_7_edge1_183
    ? new THREE.CylinderGeometry(endpoint_prop_panel_7_edge1_183.endRadius, endpoint_prop_panel_7_edge1_183.baseRadius, endpoint_prop_panel_7_edge1_183.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_7_edge1_183) {
    mesh_prop_panel_7_edge1_183Geometry.scale(0.25197, 0.00441, 0.00504);
  }
  const mesh_prop_panel_7_edge1_183 = new THREE.Mesh(
    mesh_prop_panel_7_edge1_183Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_7_edge1_183.name = "Panel edge prop-panel-7 1";
  if (endpoint_prop_panel_7_edge1_183) {
    mesh_prop_panel_7_edge1_183.position.copy(endpoint_prop_panel_7_edge1_183.midpoint);
    mesh_prop_panel_7_edge1_183.quaternion.copy(endpoint_prop_panel_7_edge1_183.quaternion);
  }
  mesh_prop_panel_7_edge1_183.castShadow = options.castShadow ?? true;
  mesh_prop_panel_7_edge1_183.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_7_edge1_183.userData.sculptComponent = { id: "prop-panel-7-edge1" };
  node_prop_panel_7_edge1_183.add(mesh_prop_panel_7_edge1_183);
  meshes["prop-panel-7-edge1"] = mesh_prop_panel_7_edge1_183;
  colliders["prop-panel-7-edge1"] = {};
  destructionGroups["prop-panel-7"] ??= [];
  destructionGroups["prop-panel-7"].push(node_prop_panel_7_edge1_183);

  const endpoint_prop_panel_7_edge2_184 = makeAttachmentEndpoint(null);
  const node_prop_panel_7_edge2_184 = new THREE.Group();
  node_prop_panel_7_edge2_184.name = "Panel edge prop-panel-7 2__pivot";
  node_prop_panel_7_edge2_184.scale.set(1, 1, 1);
  if (endpoint_prop_panel_7_edge2_184) {
    node_prop_panel_7_edge2_184.position.copy(endpoint_prop_panel_7_edge2_184.start);
    node_prop_panel_7_edge2_184.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_7_edge2_184.position.set(-0.12598, 0.0, 0.0);
    node_prop_panel_7_edge2_184.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_7_edge2_184.userData.sculptComponent = { id: "prop-panel-7-edge2" };
  node_prop_panel_7_edge2_184.userData.actionProfile = {};
  (nodes["prop-panel-7"] ?? root).add(node_prop_panel_7_edge2_184);
  nodes["prop-panel-7-edge2"] = node_prop_panel_7_edge2_184;
  const mesh_prop_panel_7_edge2_184Geometry = endpoint_prop_panel_7_edge2_184
    ? new THREE.CylinderGeometry(endpoint_prop_panel_7_edge2_184.endRadius, endpoint_prop_panel_7_edge2_184.baseRadius, endpoint_prop_panel_7_edge2_184.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_7_edge2_184) {
    mesh_prop_panel_7_edge2_184Geometry.scale(0.00441, 0.31496, 0.00504);
  }
  const mesh_prop_panel_7_edge2_184 = new THREE.Mesh(
    mesh_prop_panel_7_edge2_184Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_7_edge2_184.name = "Panel edge prop-panel-7 2";
  if (endpoint_prop_panel_7_edge2_184) {
    mesh_prop_panel_7_edge2_184.position.copy(endpoint_prop_panel_7_edge2_184.midpoint);
    mesh_prop_panel_7_edge2_184.quaternion.copy(endpoint_prop_panel_7_edge2_184.quaternion);
  }
  mesh_prop_panel_7_edge2_184.castShadow = options.castShadow ?? true;
  mesh_prop_panel_7_edge2_184.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_7_edge2_184.userData.sculptComponent = { id: "prop-panel-7-edge2" };
  node_prop_panel_7_edge2_184.add(mesh_prop_panel_7_edge2_184);
  meshes["prop-panel-7-edge2"] = mesh_prop_panel_7_edge2_184;
  colliders["prop-panel-7-edge2"] = {};
  destructionGroups["prop-panel-7"] ??= [];
  destructionGroups["prop-panel-7"].push(node_prop_panel_7_edge2_184);

  const endpoint_prop_panel_7_edge3_185 = makeAttachmentEndpoint(null);
  const node_prop_panel_7_edge3_185 = new THREE.Group();
  node_prop_panel_7_edge3_185.name = "Panel edge prop-panel-7 3__pivot";
  node_prop_panel_7_edge3_185.scale.set(1, 1, 1);
  if (endpoint_prop_panel_7_edge3_185) {
    node_prop_panel_7_edge3_185.position.copy(endpoint_prop_panel_7_edge3_185.start);
    node_prop_panel_7_edge3_185.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_7_edge3_185.position.set(0.12598, 0.0, 0.0);
    node_prop_panel_7_edge3_185.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_7_edge3_185.userData.sculptComponent = { id: "prop-panel-7-edge3" };
  node_prop_panel_7_edge3_185.userData.actionProfile = {};
  (nodes["prop-panel-7"] ?? root).add(node_prop_panel_7_edge3_185);
  nodes["prop-panel-7-edge3"] = node_prop_panel_7_edge3_185;
  const mesh_prop_panel_7_edge3_185Geometry = endpoint_prop_panel_7_edge3_185
    ? new THREE.CylinderGeometry(endpoint_prop_panel_7_edge3_185.endRadius, endpoint_prop_panel_7_edge3_185.baseRadius, endpoint_prop_panel_7_edge3_185.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_7_edge3_185) {
    mesh_prop_panel_7_edge3_185Geometry.scale(0.00441, 0.31496, 0.00504);
  }
  const mesh_prop_panel_7_edge3_185 = new THREE.Mesh(
    mesh_prop_panel_7_edge3_185Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_7_edge3_185.name = "Panel edge prop-panel-7 3";
  if (endpoint_prop_panel_7_edge3_185) {
    mesh_prop_panel_7_edge3_185.position.copy(endpoint_prop_panel_7_edge3_185.midpoint);
    mesh_prop_panel_7_edge3_185.quaternion.copy(endpoint_prop_panel_7_edge3_185.quaternion);
  }
  mesh_prop_panel_7_edge3_185.castShadow = options.castShadow ?? true;
  mesh_prop_panel_7_edge3_185.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_7_edge3_185.userData.sculptComponent = { id: "prop-panel-7-edge3" };
  node_prop_panel_7_edge3_185.add(mesh_prop_panel_7_edge3_185);
  meshes["prop-panel-7-edge3"] = mesh_prop_panel_7_edge3_185;
  colliders["prop-panel-7-edge3"] = {};
  destructionGroups["prop-panel-7"] ??= [];
  destructionGroups["prop-panel-7"].push(node_prop_panel_7_edge3_185);

  const endpoint_prop_panel_7_bar0_186 = makeAttachmentEndpoint(null);
  const node_prop_panel_7_bar0_186 = new THREE.Group();
  node_prop_panel_7_bar0_186.name = "Chart bar prop-panel-7 0__pivot";
  node_prop_panel_7_bar0_186.scale.set(1, 1, 1);
  if (endpoint_prop_panel_7_bar0_186) {
    node_prop_panel_7_bar0_186.position.copy(endpoint_prop_panel_7_bar0_186.start);
    node_prop_panel_7_bar0_186.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_7_bar0_186.position.set(-0.09071, -0.07874, 0.00378);
    node_prop_panel_7_bar0_186.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_7_bar0_186.userData.sculptComponent = { id: "prop-panel-7-bar0" };
  node_prop_panel_7_bar0_186.userData.actionProfile = {};
  (nodes["prop-panel-7"] ?? root).add(node_prop_panel_7_bar0_186);
  nodes["prop-panel-7-bar0"] = node_prop_panel_7_bar0_186;
  const mesh_prop_panel_7_bar0_186Geometry = endpoint_prop_panel_7_bar0_186
    ? new THREE.CylinderGeometry(endpoint_prop_panel_7_bar0_186.endRadius, endpoint_prop_panel_7_bar0_186.baseRadius, endpoint_prop_panel_7_bar0_186.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_7_bar0_186) {
    mesh_prop_panel_7_bar0_186Geometry.scale(0.01764, 0.05669, 0.00567);
  }
  const mesh_prop_panel_7_bar0_186 = new THREE.Mesh(
    mesh_prop_panel_7_bar0_186Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_7_bar0_186.name = "Chart bar prop-panel-7 0";
  if (endpoint_prop_panel_7_bar0_186) {
    mesh_prop_panel_7_bar0_186.position.copy(endpoint_prop_panel_7_bar0_186.midpoint);
    mesh_prop_panel_7_bar0_186.quaternion.copy(endpoint_prop_panel_7_bar0_186.quaternion);
  }
  mesh_prop_panel_7_bar0_186.castShadow = options.castShadow ?? true;
  mesh_prop_panel_7_bar0_186.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_7_bar0_186.userData.sculptComponent = { id: "prop-panel-7-bar0" };
  node_prop_panel_7_bar0_186.add(mesh_prop_panel_7_bar0_186);
  meshes["prop-panel-7-bar0"] = mesh_prop_panel_7_bar0_186;
  colliders["prop-panel-7-bar0"] = {};
  destructionGroups["prop-panel-7"] ??= [];
  destructionGroups["prop-panel-7"].push(node_prop_panel_7_bar0_186);

  const endpoint_prop_panel_7_bar1_187 = makeAttachmentEndpoint(null);
  const node_prop_panel_7_bar1_187 = new THREE.Group();
  node_prop_panel_7_bar1_187.name = "Chart bar prop-panel-7 1__pivot";
  node_prop_panel_7_bar1_187.scale.set(1, 1, 1);
  if (endpoint_prop_panel_7_bar1_187) {
    node_prop_panel_7_bar1_187.position.copy(endpoint_prop_panel_7_bar1_187.start);
    node_prop_panel_7_bar1_187.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_7_bar1_187.position.set(-0.03024, -0.02362, 0.00378);
    node_prop_panel_7_bar1_187.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_7_bar1_187.userData.sculptComponent = { id: "prop-panel-7-bar1" };
  node_prop_panel_7_bar1_187.userData.actionProfile = {};
  (nodes["prop-panel-7"] ?? root).add(node_prop_panel_7_bar1_187);
  nodes["prop-panel-7-bar1"] = node_prop_panel_7_bar1_187;
  const mesh_prop_panel_7_bar1_187Geometry = endpoint_prop_panel_7_bar1_187
    ? new THREE.CylinderGeometry(endpoint_prop_panel_7_bar1_187.endRadius, endpoint_prop_panel_7_bar1_187.baseRadius, endpoint_prop_panel_7_bar1_187.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_7_bar1_187) {
    mesh_prop_panel_7_bar1_187Geometry.scale(0.01764, 0.16693, 0.00567);
  }
  const mesh_prop_panel_7_bar1_187 = new THREE.Mesh(
    mesh_prop_panel_7_bar1_187Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_7_bar1_187.name = "Chart bar prop-panel-7 1";
  if (endpoint_prop_panel_7_bar1_187) {
    mesh_prop_panel_7_bar1_187.position.copy(endpoint_prop_panel_7_bar1_187.midpoint);
    mesh_prop_panel_7_bar1_187.quaternion.copy(endpoint_prop_panel_7_bar1_187.quaternion);
  }
  mesh_prop_panel_7_bar1_187.castShadow = options.castShadow ?? true;
  mesh_prop_panel_7_bar1_187.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_7_bar1_187.userData.sculptComponent = { id: "prop-panel-7-bar1" };
  node_prop_panel_7_bar1_187.add(mesh_prop_panel_7_bar1_187);
  meshes["prop-panel-7-bar1"] = mesh_prop_panel_7_bar1_187;
  colliders["prop-panel-7-bar1"] = {};
  destructionGroups["prop-panel-7"] ??= [];
  destructionGroups["prop-panel-7"].push(node_prop_panel_7_bar1_187);

  const endpoint_prop_panel_7_bar2_188 = makeAttachmentEndpoint(null);
  const node_prop_panel_7_bar2_188 = new THREE.Group();
  node_prop_panel_7_bar2_188.name = "Chart bar prop-panel-7 2__pivot";
  node_prop_panel_7_bar2_188.scale.set(1, 1, 1);
  if (endpoint_prop_panel_7_bar2_188) {
    node_prop_panel_7_bar2_188.position.copy(endpoint_prop_panel_7_bar2_188.start);
    node_prop_panel_7_bar2_188.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_7_bar2_188.position.set(0.03024, -0.04724, 0.00378);
    node_prop_panel_7_bar2_188.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_7_bar2_188.userData.sculptComponent = { id: "prop-panel-7-bar2" };
  node_prop_panel_7_bar2_188.userData.actionProfile = {};
  (nodes["prop-panel-7"] ?? root).add(node_prop_panel_7_bar2_188);
  nodes["prop-panel-7-bar2"] = node_prop_panel_7_bar2_188;
  const mesh_prop_panel_7_bar2_188Geometry = endpoint_prop_panel_7_bar2_188
    ? new THREE.CylinderGeometry(endpoint_prop_panel_7_bar2_188.endRadius, endpoint_prop_panel_7_bar2_188.baseRadius, endpoint_prop_panel_7_bar2_188.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_7_bar2_188) {
    mesh_prop_panel_7_bar2_188Geometry.scale(0.01764, 0.11969, 0.00567);
  }
  const mesh_prop_panel_7_bar2_188 = new THREE.Mesh(
    mesh_prop_panel_7_bar2_188Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_7_bar2_188.name = "Chart bar prop-panel-7 2";
  if (endpoint_prop_panel_7_bar2_188) {
    mesh_prop_panel_7_bar2_188.position.copy(endpoint_prop_panel_7_bar2_188.midpoint);
    mesh_prop_panel_7_bar2_188.quaternion.copy(endpoint_prop_panel_7_bar2_188.quaternion);
  }
  mesh_prop_panel_7_bar2_188.castShadow = options.castShadow ?? true;
  mesh_prop_panel_7_bar2_188.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_7_bar2_188.userData.sculptComponent = { id: "prop-panel-7-bar2" };
  node_prop_panel_7_bar2_188.add(mesh_prop_panel_7_bar2_188);
  meshes["prop-panel-7-bar2"] = mesh_prop_panel_7_bar2_188;
  colliders["prop-panel-7-bar2"] = {};
  destructionGroups["prop-panel-7"] ??= [];
  destructionGroups["prop-panel-7"].push(node_prop_panel_7_bar2_188);

  const endpoint_prop_panel_7_bar3_189 = makeAttachmentEndpoint(null);
  const node_prop_panel_7_bar3_189 = new THREE.Group();
  node_prop_panel_7_bar3_189.name = "Chart bar prop-panel-7 3__pivot";
  node_prop_panel_7_bar3_189.scale.set(1, 1, 1);
  if (endpoint_prop_panel_7_bar3_189) {
    node_prop_panel_7_bar3_189.position.copy(endpoint_prop_panel_7_bar3_189.start);
    node_prop_panel_7_bar3_189.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_7_bar3_189.position.set(0.09071, -0.07087, 0.00378);
    node_prop_panel_7_bar3_189.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_7_bar3_189.userData.sculptComponent = { id: "prop-panel-7-bar3" };
  node_prop_panel_7_bar3_189.userData.actionProfile = {};
  (nodes["prop-panel-7"] ?? root).add(node_prop_panel_7_bar3_189);
  nodes["prop-panel-7-bar3"] = node_prop_panel_7_bar3_189;
  const mesh_prop_panel_7_bar3_189Geometry = endpoint_prop_panel_7_bar3_189
    ? new THREE.CylinderGeometry(endpoint_prop_panel_7_bar3_189.endRadius, endpoint_prop_panel_7_bar3_189.baseRadius, endpoint_prop_panel_7_bar3_189.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_7_bar3_189) {
    mesh_prop_panel_7_bar3_189Geometry.scale(0.01764, 0.07244, 0.00567);
  }
  const mesh_prop_panel_7_bar3_189 = new THREE.Mesh(
    mesh_prop_panel_7_bar3_189Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_7_bar3_189.name = "Chart bar prop-panel-7 3";
  if (endpoint_prop_panel_7_bar3_189) {
    mesh_prop_panel_7_bar3_189.position.copy(endpoint_prop_panel_7_bar3_189.midpoint);
    mesh_prop_panel_7_bar3_189.quaternion.copy(endpoint_prop_panel_7_bar3_189.quaternion);
  }
  mesh_prop_panel_7_bar3_189.castShadow = options.castShadow ?? true;
  mesh_prop_panel_7_bar3_189.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_7_bar3_189.userData.sculptComponent = { id: "prop-panel-7-bar3" };
  node_prop_panel_7_bar3_189.add(mesh_prop_panel_7_bar3_189);
  meshes["prop-panel-7-bar3"] = mesh_prop_panel_7_bar3_189;
  colliders["prop-panel-7-bar3"] = {};
  destructionGroups["prop-panel-7"] ??= [];
  destructionGroups["prop-panel-7"].push(node_prop_panel_7_bar3_189);

  const endpoint_prop_panel_7_line0_190 = makeAttachmentEndpoint(null);
  const node_prop_panel_7_line0_190 = new THREE.Group();
  node_prop_panel_7_line0_190.name = "Text line prop-panel-7 0__pivot";
  node_prop_panel_7_line0_190.scale.set(1, 1, 1);
  if (endpoint_prop_panel_7_line0_190) {
    node_prop_panel_7_line0_190.position.copy(endpoint_prop_panel_7_line0_190.start);
    node_prop_panel_7_line0_190.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_7_line0_190.position.set(-0.0315, 0.09449, 0.00378);
    node_prop_panel_7_line0_190.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_7_line0_190.userData.sculptComponent = { id: "prop-panel-7-line0" };
  node_prop_panel_7_line0_190.userData.actionProfile = {};
  (nodes["prop-panel-7"] ?? root).add(node_prop_panel_7_line0_190);
  nodes["prop-panel-7-line0"] = node_prop_panel_7_line0_190;
  const mesh_prop_panel_7_line0_190Geometry = endpoint_prop_panel_7_line0_190
    ? new THREE.CylinderGeometry(endpoint_prop_panel_7_line0_190.endRadius, endpoint_prop_panel_7_line0_190.baseRadius, endpoint_prop_panel_7_line0_190.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_7_line0_190) {
    mesh_prop_panel_7_line0_190Geometry.scale(0.13858, 0.00378, 0.00504);
  }
  const mesh_prop_panel_7_line0_190 = new THREE.Mesh(
    mesh_prop_panel_7_line0_190Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_7_line0_190.name = "Text line prop-panel-7 0";
  if (endpoint_prop_panel_7_line0_190) {
    mesh_prop_panel_7_line0_190.position.copy(endpoint_prop_panel_7_line0_190.midpoint);
    mesh_prop_panel_7_line0_190.quaternion.copy(endpoint_prop_panel_7_line0_190.quaternion);
  }
  mesh_prop_panel_7_line0_190.castShadow = options.castShadow ?? true;
  mesh_prop_panel_7_line0_190.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_7_line0_190.userData.sculptComponent = { id: "prop-panel-7-line0" };
  node_prop_panel_7_line0_190.add(mesh_prop_panel_7_line0_190);
  meshes["prop-panel-7-line0"] = mesh_prop_panel_7_line0_190;
  colliders["prop-panel-7-line0"] = {};
  destructionGroups["prop-panel-7"] ??= [];
  destructionGroups["prop-panel-7"].push(node_prop_panel_7_line0_190);

  const endpoint_prop_panel_7_line1_191 = makeAttachmentEndpoint(null);
  const node_prop_panel_7_line1_191 = new THREE.Group();
  node_prop_panel_7_line1_191.name = "Text line prop-panel-7 1__pivot";
  node_prop_panel_7_line1_191.scale.set(1, 1, 1);
  if (endpoint_prop_panel_7_line1_191) {
    node_prop_panel_7_line1_191.position.copy(endpoint_prop_panel_7_line1_191.start);
    node_prop_panel_7_line1_191.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_7_line1_191.position.set(-0.04157, 0.05669, 0.00378);
    node_prop_panel_7_line1_191.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_7_line1_191.userData.sculptComponent = { id: "prop-panel-7-line1" };
  node_prop_panel_7_line1_191.userData.actionProfile = {};
  (nodes["prop-panel-7"] ?? root).add(node_prop_panel_7_line1_191);
  nodes["prop-panel-7-line1"] = node_prop_panel_7_line1_191;
  const mesh_prop_panel_7_line1_191Geometry = endpoint_prop_panel_7_line1_191
    ? new THREE.CylinderGeometry(endpoint_prop_panel_7_line1_191.endRadius, endpoint_prop_panel_7_line1_191.baseRadius, endpoint_prop_panel_7_line1_191.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_7_line1_191) {
    mesh_prop_panel_7_line1_191Geometry.scale(0.11843, 0.00378, 0.00504);
  }
  const mesh_prop_panel_7_line1_191 = new THREE.Mesh(
    mesh_prop_panel_7_line1_191Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_7_line1_191.name = "Text line prop-panel-7 1";
  if (endpoint_prop_panel_7_line1_191) {
    mesh_prop_panel_7_line1_191.position.copy(endpoint_prop_panel_7_line1_191.midpoint);
    mesh_prop_panel_7_line1_191.quaternion.copy(endpoint_prop_panel_7_line1_191.quaternion);
  }
  mesh_prop_panel_7_line1_191.castShadow = options.castShadow ?? true;
  mesh_prop_panel_7_line1_191.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_7_line1_191.userData.sculptComponent = { id: "prop-panel-7-line1" };
  node_prop_panel_7_line1_191.add(mesh_prop_panel_7_line1_191);
  meshes["prop-panel-7-line1"] = mesh_prop_panel_7_line1_191;
  colliders["prop-panel-7-line1"] = {};
  destructionGroups["prop-panel-7"] ??= [];
  destructionGroups["prop-panel-7"].push(node_prop_panel_7_line1_191);

  const endpoint_prop_globe_192 = makeAttachmentEndpoint(null);
  const node_prop_globe_192 = new THREE.Group();
  node_prop_globe_192.name = "Holo globe prop-globe__pivot";
  node_prop_globe_192.scale.set(1, 1, 1);
  if (endpoint_prop_globe_192) {
    node_prop_globe_192.position.copy(endpoint_prop_globe_192.start);
    node_prop_globe_192.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_globe_192.position.set(0.27402, 0.99213, 0.13228);
    node_prop_globe_192.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_globe_192.userData.sculptComponent = { id: "prop-globe" };
  node_prop_globe_192.userData.actionProfile = {};
  (nodes["root"] ?? root).add(node_prop_globe_192);
  nodes["prop-globe"] = node_prop_globe_192;
  const mesh_prop_globe_192Geometry = endpoint_prop_globe_192
    ? new THREE.CylinderGeometry(endpoint_prop_globe_192.endRadius, endpoint_prop_globe_192.baseRadius, endpoint_prop_globe_192.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_prop_globe_192) {
    mesh_prop_globe_192Geometry.scale(0.32756, 0.32756, 0.32756);
  }
  const mesh_prop_globe_192 = new THREE.Mesh(
    mesh_prop_globe_192Geometry,
    materialMap["holo-panel"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_globe_192.name = "Holo globe prop-globe";
  if (endpoint_prop_globe_192) {
    mesh_prop_globe_192.position.copy(endpoint_prop_globe_192.midpoint);
    mesh_prop_globe_192.quaternion.copy(endpoint_prop_globe_192.quaternion);
  }
  mesh_prop_globe_192.castShadow = options.castShadow ?? true;
  mesh_prop_globe_192.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_globe_192.userData.sculptComponent = { id: "prop-globe" };
  node_prop_globe_192.add(mesh_prop_globe_192);
  meshes["prop-globe"] = mesh_prop_globe_192;
  colliders["prop-globe"] = {};
  destructionGroups["prop-globe"] ??= [];
  destructionGroups["prop-globe"].push(node_prop_globe_192);

  const endpoint_prop_globe_ring0_193 = makeAttachmentEndpoint(null);
  const node_prop_globe_ring0_193 = new THREE.Group();
  node_prop_globe_ring0_193.name = "Globe ring prop-globe 0__pivot";
  node_prop_globe_ring0_193.scale.set(1, 1, 1);
  if (endpoint_prop_globe_ring0_193) {
    node_prop_globe_ring0_193.position.copy(endpoint_prop_globe_ring0_193.start);
    node_prop_globe_ring0_193.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_globe_ring0_193.position.set(0.0, 0.0, 0.0);
    node_prop_globe_ring0_193.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_globe_ring0_193.userData.sculptComponent = { id: "prop-globe-ring0" };
  node_prop_globe_ring0_193.userData.actionProfile = {};
  (nodes["prop-globe"] ?? root).add(node_prop_globe_ring0_193);
  nodes["prop-globe-ring0"] = node_prop_globe_ring0_193;
  const mesh_prop_globe_ring0_193Geometry = endpoint_prop_globe_ring0_193
    ? new THREE.CylinderGeometry(endpoint_prop_globe_ring0_193.endRadius, endpoint_prop_globe_ring0_193.baseRadius, endpoint_prop_globe_ring0_193.length, 8, 4)
    : new THREE.TorusGeometry(0.45, 0.0054, 8, 16);
  if (!endpoint_prop_globe_ring0_193) {
    mesh_prop_globe_ring0_193Geometry.scale(0.36395, 0.36395, 0.36395);
  }
  const mesh_prop_globe_ring0_193 = new THREE.Mesh(
    mesh_prop_globe_ring0_193Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_globe_ring0_193.name = "Globe ring prop-globe 0";
  if (endpoint_prop_globe_ring0_193) {
    mesh_prop_globe_ring0_193.position.copy(endpoint_prop_globe_ring0_193.midpoint);
    mesh_prop_globe_ring0_193.quaternion.copy(endpoint_prop_globe_ring0_193.quaternion);
  }
  mesh_prop_globe_ring0_193.castShadow = options.castShadow ?? true;
  mesh_prop_globe_ring0_193.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_globe_ring0_193.userData.sculptComponent = { id: "prop-globe-ring0" };
  node_prop_globe_ring0_193.add(mesh_prop_globe_ring0_193);
  meshes["prop-globe-ring0"] = mesh_prop_globe_ring0_193;
  colliders["prop-globe-ring0"] = {};
  destructionGroups["prop-globe"] ??= [];
  destructionGroups["prop-globe"].push(node_prop_globe_ring0_193);

  const endpoint_prop_globe_ring1_194 = makeAttachmentEndpoint(null);
  const node_prop_globe_ring1_194 = new THREE.Group();
  node_prop_globe_ring1_194.name = "Globe ring prop-globe 1__pivot";
  node_prop_globe_ring1_194.scale.set(1, 1, 1);
  if (endpoint_prop_globe_ring1_194) {
    node_prop_globe_ring1_194.position.copy(endpoint_prop_globe_ring1_194.start);
    node_prop_globe_ring1_194.rotation.set(1.5708, 0.0, 0.0);
  } else {
    node_prop_globe_ring1_194.position.set(0.0, 0.0, 0.0);
    node_prop_globe_ring1_194.rotation.set(1.5708, 0.0, 0.0);
  }
  node_prop_globe_ring1_194.userData.sculptComponent = { id: "prop-globe-ring1" };
  node_prop_globe_ring1_194.userData.actionProfile = {};
  (nodes["prop-globe"] ?? root).add(node_prop_globe_ring1_194);
  nodes["prop-globe-ring1"] = node_prop_globe_ring1_194;
  const mesh_prop_globe_ring1_194Geometry = endpoint_prop_globe_ring1_194
    ? new THREE.CylinderGeometry(endpoint_prop_globe_ring1_194.endRadius, endpoint_prop_globe_ring1_194.baseRadius, endpoint_prop_globe_ring1_194.length, 8, 4)
    : new THREE.TorusGeometry(0.45, 0.0054, 8, 16);
  if (!endpoint_prop_globe_ring1_194) {
    mesh_prop_globe_ring1_194Geometry.scale(0.36395, 0.36395, 0.36395);
  }
  const mesh_prop_globe_ring1_194 = new THREE.Mesh(
    mesh_prop_globe_ring1_194Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_globe_ring1_194.name = "Globe ring prop-globe 1";
  if (endpoint_prop_globe_ring1_194) {
    mesh_prop_globe_ring1_194.position.copy(endpoint_prop_globe_ring1_194.midpoint);
    mesh_prop_globe_ring1_194.quaternion.copy(endpoint_prop_globe_ring1_194.quaternion);
  }
  mesh_prop_globe_ring1_194.castShadow = options.castShadow ?? true;
  mesh_prop_globe_ring1_194.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_globe_ring1_194.userData.sculptComponent = { id: "prop-globe-ring1" };
  node_prop_globe_ring1_194.add(mesh_prop_globe_ring1_194);
  meshes["prop-globe-ring1"] = mesh_prop_globe_ring1_194;
  colliders["prop-globe-ring1"] = {};
  destructionGroups["prop-globe"] ??= [];
  destructionGroups["prop-globe"].push(node_prop_globe_ring1_194);

  const endpoint_prop_globe_ring2_195 = makeAttachmentEndpoint(null);
  const node_prop_globe_ring2_195 = new THREE.Group();
  node_prop_globe_ring2_195.name = "Globe ring prop-globe 2__pivot";
  node_prop_globe_ring2_195.scale.set(1, 1, 1);
  if (endpoint_prop_globe_ring2_195) {
    node_prop_globe_ring2_195.position.copy(endpoint_prop_globe_ring2_195.start);
    node_prop_globe_ring2_195.rotation.set(0.0, 1.5708, 0.0);
  } else {
    node_prop_globe_ring2_195.position.set(0.0, 0.0, 0.0);
    node_prop_globe_ring2_195.rotation.set(0.0, 1.5708, 0.0);
  }
  node_prop_globe_ring2_195.userData.sculptComponent = { id: "prop-globe-ring2" };
  node_prop_globe_ring2_195.userData.actionProfile = {};
  (nodes["prop-globe"] ?? root).add(node_prop_globe_ring2_195);
  nodes["prop-globe-ring2"] = node_prop_globe_ring2_195;
  const mesh_prop_globe_ring2_195Geometry = endpoint_prop_globe_ring2_195
    ? new THREE.CylinderGeometry(endpoint_prop_globe_ring2_195.endRadius, endpoint_prop_globe_ring2_195.baseRadius, endpoint_prop_globe_ring2_195.length, 8, 4)
    : new THREE.TorusGeometry(0.45, 0.0054, 8, 16);
  if (!endpoint_prop_globe_ring2_195) {
    mesh_prop_globe_ring2_195Geometry.scale(0.36395, 0.36395, 0.36395);
  }
  const mesh_prop_globe_ring2_195 = new THREE.Mesh(
    mesh_prop_globe_ring2_195Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_globe_ring2_195.name = "Globe ring prop-globe 2";
  if (endpoint_prop_globe_ring2_195) {
    mesh_prop_globe_ring2_195.position.copy(endpoint_prop_globe_ring2_195.midpoint);
    mesh_prop_globe_ring2_195.quaternion.copy(endpoint_prop_globe_ring2_195.quaternion);
  }
  mesh_prop_globe_ring2_195.castShadow = options.castShadow ?? true;
  mesh_prop_globe_ring2_195.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_globe_ring2_195.userData.sculptComponent = { id: "prop-globe-ring2" };
  node_prop_globe_ring2_195.add(mesh_prop_globe_ring2_195);
  meshes["prop-globe-ring2"] = mesh_prop_globe_ring2_195;
  colliders["prop-globe-ring2"] = {};
  destructionGroups["prop-globe"] ??= [];
  destructionGroups["prop-globe"].push(node_prop_globe_ring2_195);

  const endpoint_prop_book_196 = makeAttachmentEndpoint(null);
  const node_prop_book_196 = new THREE.Group();
  node_prop_book_196.name = "Open book prop-book__pivot";
  node_prop_book_196.scale.set(1, 1, 1);
  if (endpoint_prop_book_196) {
    node_prop_book_196.position.copy(endpoint_prop_book_196.start);
    node_prop_book_196.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_book_196.position.set(0.11654, 0.7811, 0.14488);
    node_prop_book_196.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_book_196.userData.sculptComponent = { id: "prop-book" };
  node_prop_book_196.userData.actionProfile = {};
  (nodes["root"] ?? root).add(node_prop_book_196);
  nodes["prop-book"] = node_prop_book_196;
  const mesh_prop_book_196Geometry = endpoint_prop_book_196
    ? new THREE.CylinderGeometry(endpoint_prop_book_196.endRadius, endpoint_prop_book_196.baseRadius, endpoint_prop_book_196.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_book_196) {
    mesh_prop_book_196Geometry.scale(0.47244, 0.0063, 0.12598);
  }
  const mesh_prop_book_196 = new THREE.Mesh(
    mesh_prop_book_196Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_book_196.name = "Open book prop-book";
  if (endpoint_prop_book_196) {
    mesh_prop_book_196.position.copy(endpoint_prop_book_196.midpoint);
    mesh_prop_book_196.quaternion.copy(endpoint_prop_book_196.quaternion);
  }
  mesh_prop_book_196.castShadow = options.castShadow ?? true;
  mesh_prop_book_196.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_book_196.userData.sculptComponent = { id: "prop-book" };
  node_prop_book_196.add(mesh_prop_book_196);
  meshes["prop-book"] = mesh_prop_book_196;
  colliders["prop-book"] = {};
  destructionGroups["prop-book"] ??= [];
  destructionGroups["prop-book"].push(node_prop_book_196);

  const endpoint_prop_book_page0_197 = makeAttachmentEndpoint(null);
  const node_prop_book_page0_197 = new THREE.Group();
  node_prop_book_page0_197.name = "Book page prop-book 0__pivot";
  node_prop_book_page0_197.scale.set(1, 1, 1);
  if (endpoint_prop_book_page0_197) {
    node_prop_book_page0_197.position.copy(endpoint_prop_book_page0_197.start);
    node_prop_book_page0_197.rotation.set(0.0, 0.0, 0.12);
  } else {
    node_prop_book_page0_197.position.set(0.11339, 0.0063, 0.0);
    node_prop_book_page0_197.rotation.set(0.0, 0.0, 0.12);
  }
  node_prop_book_page0_197.userData.sculptComponent = { id: "prop-book-page0" };
  node_prop_book_page0_197.userData.actionProfile = {};
  (nodes["prop-book"] ?? root).add(node_prop_book_page0_197);
  nodes["prop-book-page0"] = node_prop_book_page0_197;
  const mesh_prop_book_page0_197Geometry = endpoint_prop_book_page0_197
    ? new THREE.CylinderGeometry(endpoint_prop_book_page0_197.endRadius, endpoint_prop_book_page0_197.baseRadius, endpoint_prop_book_page0_197.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_book_page0_197) {
    mesh_prop_book_page0_197Geometry.scale(0.21732, 0.00378, 0.11339);
  }
  const mesh_prop_book_page0_197 = new THREE.Mesh(
    mesh_prop_book_page0_197Geometry,
    materialMap["emblem-white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_book_page0_197.name = "Book page prop-book 0";
  if (endpoint_prop_book_page0_197) {
    mesh_prop_book_page0_197.position.copy(endpoint_prop_book_page0_197.midpoint);
    mesh_prop_book_page0_197.quaternion.copy(endpoint_prop_book_page0_197.quaternion);
  }
  mesh_prop_book_page0_197.castShadow = options.castShadow ?? true;
  mesh_prop_book_page0_197.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_book_page0_197.userData.sculptComponent = { id: "prop-book-page0" };
  node_prop_book_page0_197.add(mesh_prop_book_page0_197);
  meshes["prop-book-page0"] = mesh_prop_book_page0_197;
  colliders["prop-book-page0"] = {};
  destructionGroups["prop-book"] ??= [];
  destructionGroups["prop-book"].push(node_prop_book_page0_197);

  const endpoint_prop_book_page1_198 = makeAttachmentEndpoint(null);
  const node_prop_book_page1_198 = new THREE.Group();
  node_prop_book_page1_198.name = "Book page prop-book 1__pivot";
  node_prop_book_page1_198.scale.set(1, 1, 1);
  if (endpoint_prop_book_page1_198) {
    node_prop_book_page1_198.position.copy(endpoint_prop_book_page1_198.start);
    node_prop_book_page1_198.rotation.set(0.0, 0.0, -0.12);
  } else {
    node_prop_book_page1_198.position.set(-0.11339, 0.0063, 0.0);
    node_prop_book_page1_198.rotation.set(0.0, 0.0, -0.12);
  }
  node_prop_book_page1_198.userData.sculptComponent = { id: "prop-book-page1" };
  node_prop_book_page1_198.userData.actionProfile = {};
  (nodes["prop-book"] ?? root).add(node_prop_book_page1_198);
  nodes["prop-book-page1"] = node_prop_book_page1_198;
  const mesh_prop_book_page1_198Geometry = endpoint_prop_book_page1_198
    ? new THREE.CylinderGeometry(endpoint_prop_book_page1_198.endRadius, endpoint_prop_book_page1_198.baseRadius, endpoint_prop_book_page1_198.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_book_page1_198) {
    mesh_prop_book_page1_198Geometry.scale(0.21732, 0.00378, 0.11339);
  }
  const mesh_prop_book_page1_198 = new THREE.Mesh(
    mesh_prop_book_page1_198Geometry,
    materialMap["emblem-white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_book_page1_198.name = "Book page prop-book 1";
  if (endpoint_prop_book_page1_198) {
    mesh_prop_book_page1_198.position.copy(endpoint_prop_book_page1_198.midpoint);
    mesh_prop_book_page1_198.quaternion.copy(endpoint_prop_book_page1_198.quaternion);
  }
  mesh_prop_book_page1_198.castShadow = options.castShadow ?? true;
  mesh_prop_book_page1_198.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_book_page1_198.userData.sculptComponent = { id: "prop-book-page1" };
  node_prop_book_page1_198.add(mesh_prop_book_page1_198);
  meshes["prop-book-page1"] = mesh_prop_book_page1_198;
  colliders["prop-book-page1"] = {};
  destructionGroups["prop-book"] ??= [];
  destructionGroups["prop-book"].push(node_prop_book_page1_198);

  const endpoint_prop_sat_199 = makeAttachmentEndpoint(null);
  const node_prop_sat_199 = new THREE.Group();
  node_prop_sat_199.name = "Orb drone prop-sat__pivot";
  node_prop_sat_199.scale.set(1, 1, 1);
  if (endpoint_prop_sat_199) {
    node_prop_sat_199.position.copy(endpoint_prop_sat_199.start);
    node_prop_sat_199.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_sat_199.position.set(-0.07874, 1.66929, 0.0315);
    node_prop_sat_199.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_sat_199.userData.sculptComponent = { id: "prop-sat" };
  node_prop_sat_199.userData.actionProfile = {};
  (nodes["root"] ?? root).add(node_prop_sat_199);
  nodes["prop-sat"] = node_prop_sat_199;
  const mesh_prop_sat_199Geometry = endpoint_prop_sat_199
    ? new THREE.CylinderGeometry(endpoint_prop_sat_199.endRadius, endpoint_prop_sat_199.baseRadius, endpoint_prop_sat_199.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_prop_sat_199) {
    mesh_prop_sat_199Geometry.scale(0.12598, 0.12598, 0.12598);
  }
  const mesh_prop_sat_199 = new THREE.Mesh(
    mesh_prop_sat_199Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_sat_199.name = "Orb drone prop-sat";
  if (endpoint_prop_sat_199) {
    mesh_prop_sat_199.position.copy(endpoint_prop_sat_199.midpoint);
    mesh_prop_sat_199.quaternion.copy(endpoint_prop_sat_199.quaternion);
  }
  mesh_prop_sat_199.castShadow = options.castShadow ?? true;
  mesh_prop_sat_199.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_sat_199.userData.sculptComponent = { id: "prop-sat" };
  node_prop_sat_199.add(mesh_prop_sat_199);
  meshes["prop-sat"] = mesh_prop_sat_199;
  colliders["prop-sat"] = {};
  destructionGroups["prop-sat"] ??= [];
  destructionGroups["prop-sat"].push(node_prop_sat_199);

  const endpoint_prop_sat_face_200 = makeAttachmentEndpoint(null);
  const node_prop_sat_face_200 = new THREE.Group();
  node_prop_sat_face_200.name = "Drone face prop-sat__pivot";
  node_prop_sat_face_200.scale.set(1, 1, 1);
  if (endpoint_prop_sat_face_200) {
    node_prop_sat_face_200.position.copy(endpoint_prop_sat_face_200.start);
    node_prop_sat_face_200.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_sat_face_200.position.set(0.0, 0.0, 0.03906);
    node_prop_sat_face_200.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_sat_face_200.userData.sculptComponent = { id: "prop-sat-face" };
  node_prop_sat_face_200.userData.actionProfile = {};
  (nodes["prop-sat"] ?? root).add(node_prop_sat_face_200);
  nodes["prop-sat-face"] = node_prop_sat_face_200;
  const mesh_prop_sat_face_200Geometry = endpoint_prop_sat_face_200
    ? new THREE.CylinderGeometry(endpoint_prop_sat_face_200.endRadius, endpoint_prop_sat_face_200.baseRadius, endpoint_prop_sat_face_200.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_prop_sat_face_200) {
    mesh_prop_sat_face_200Geometry.scale(0.09134, 0.07559, 0.04409);
  }
  const mesh_prop_sat_face_200 = new THREE.Mesh(
    mesh_prop_sat_face_200Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_sat_face_200.name = "Drone face prop-sat";
  if (endpoint_prop_sat_face_200) {
    mesh_prop_sat_face_200.position.copy(endpoint_prop_sat_face_200.midpoint);
    mesh_prop_sat_face_200.quaternion.copy(endpoint_prop_sat_face_200.quaternion);
  }
  mesh_prop_sat_face_200.castShadow = options.castShadow ?? true;
  mesh_prop_sat_face_200.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_sat_face_200.userData.sculptComponent = { id: "prop-sat-face" };
  node_prop_sat_face_200.add(mesh_prop_sat_face_200);
  meshes["prop-sat-face"] = mesh_prop_sat_face_200;
  colliders["prop-sat-face"] = {};
  destructionGroups["prop-sat"] ??= [];
  destructionGroups["prop-sat"].push(node_prop_sat_face_200);

  const endpoint_prop_sat_eye0_201 = makeAttachmentEndpoint(null);
  const node_prop_sat_eye0_201 = new THREE.Group();
  node_prop_sat_eye0_201.name = "Drone eye prop-sat 0__pivot";
  node_prop_sat_eye0_201.scale.set(1, 1, 1);
  if (endpoint_prop_sat_eye0_201) {
    node_prop_sat_eye0_201.position.copy(endpoint_prop_sat_eye0_201.start);
    node_prop_sat_eye0_201.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_sat_eye0_201.position.set(-0.02646, 0.00252, 0.05984);
    node_prop_sat_eye0_201.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_sat_eye0_201.userData.sculptComponent = { id: "prop-sat-eye0" };
  node_prop_sat_eye0_201.userData.actionProfile = {};
  (nodes["prop-sat"] ?? root).add(node_prop_sat_eye0_201);
  nodes["prop-sat-eye0"] = node_prop_sat_eye0_201;
  const mesh_prop_sat_eye0_201Geometry = endpoint_prop_sat_eye0_201
    ? new THREE.CylinderGeometry(endpoint_prop_sat_eye0_201.endRadius, endpoint_prop_sat_eye0_201.baseRadius, endpoint_prop_sat_eye0_201.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_prop_sat_eye0_201) {
    mesh_prop_sat_eye0_201Geometry.scale(0.0189, 0.02142, 0.00882);
  }
  const mesh_prop_sat_eye0_201 = new THREE.Mesh(
    mesh_prop_sat_eye0_201Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_sat_eye0_201.name = "Drone eye prop-sat 0";
  if (endpoint_prop_sat_eye0_201) {
    mesh_prop_sat_eye0_201.position.copy(endpoint_prop_sat_eye0_201.midpoint);
    mesh_prop_sat_eye0_201.quaternion.copy(endpoint_prop_sat_eye0_201.quaternion);
  }
  mesh_prop_sat_eye0_201.castShadow = options.castShadow ?? true;
  mesh_prop_sat_eye0_201.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_sat_eye0_201.userData.sculptComponent = { id: "prop-sat-eye0" };
  node_prop_sat_eye0_201.add(mesh_prop_sat_eye0_201);
  meshes["prop-sat-eye0"] = mesh_prop_sat_eye0_201;
  colliders["prop-sat-eye0"] = {};
  destructionGroups["prop-sat"] ??= [];
  destructionGroups["prop-sat"].push(node_prop_sat_eye0_201);

  const endpoint_prop_sat_eye1_202 = makeAttachmentEndpoint(null);
  const node_prop_sat_eye1_202 = new THREE.Group();
  node_prop_sat_eye1_202.name = "Drone eye prop-sat 1__pivot";
  node_prop_sat_eye1_202.scale.set(1, 1, 1);
  if (endpoint_prop_sat_eye1_202) {
    node_prop_sat_eye1_202.position.copy(endpoint_prop_sat_eye1_202.start);
    node_prop_sat_eye1_202.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_sat_eye1_202.position.set(0.02646, 0.00252, 0.05984);
    node_prop_sat_eye1_202.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_sat_eye1_202.userData.sculptComponent = { id: "prop-sat-eye1" };
  node_prop_sat_eye1_202.userData.actionProfile = {};
  (nodes["prop-sat"] ?? root).add(node_prop_sat_eye1_202);
  nodes["prop-sat-eye1"] = node_prop_sat_eye1_202;
  const mesh_prop_sat_eye1_202Geometry = endpoint_prop_sat_eye1_202
    ? new THREE.CylinderGeometry(endpoint_prop_sat_eye1_202.endRadius, endpoint_prop_sat_eye1_202.baseRadius, endpoint_prop_sat_eye1_202.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_prop_sat_eye1_202) {
    mesh_prop_sat_eye1_202Geometry.scale(0.0189, 0.02142, 0.00882);
  }
  const mesh_prop_sat_eye1_202 = new THREE.Mesh(
    mesh_prop_sat_eye1_202Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_sat_eye1_202.name = "Drone eye prop-sat 1";
  if (endpoint_prop_sat_eye1_202) {
    mesh_prop_sat_eye1_202.position.copy(endpoint_prop_sat_eye1_202.midpoint);
    mesh_prop_sat_eye1_202.quaternion.copy(endpoint_prop_sat_eye1_202.quaternion);
  }
  mesh_prop_sat_eye1_202.castShadow = options.castShadow ?? true;
  mesh_prop_sat_eye1_202.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_sat_eye1_202.userData.sculptComponent = { id: "prop-sat-eye1" };
  node_prop_sat_eye1_202.add(mesh_prop_sat_eye1_202);
  meshes["prop-sat-eye1"] = mesh_prop_sat_eye1_202;
  colliders["prop-sat-eye1"] = {};
  destructionGroups["prop-sat"] ??= [];
  destructionGroups["prop-sat"].push(node_prop_sat_eye1_202);

  const endpoint_prop_sat_band_203 = makeAttachmentEndpoint(null);
  const node_prop_sat_band_203 = new THREE.Group();
  node_prop_sat_band_203.name = "Drone band prop-sat__pivot";
  node_prop_sat_band_203.scale.set(1, 1, 1);
  if (endpoint_prop_sat_band_203) {
    node_prop_sat_band_203.position.copy(endpoint_prop_sat_band_203.start);
    node_prop_sat_band_203.rotation.set(0.0, 1.5708, 0.0);
  } else {
    node_prop_sat_band_203.position.set(0.0, 0.0, 0.0);
    node_prop_sat_band_203.rotation.set(0.0, 1.5708, 0.0);
  }
  node_prop_sat_band_203.userData.sculptComponent = { id: "prop-sat-band" };
  node_prop_sat_band_203.userData.actionProfile = {};
  (nodes["prop-sat"] ?? root).add(node_prop_sat_band_203);
  nodes["prop-sat-band"] = node_prop_sat_band_203;
  const mesh_prop_sat_band_203Geometry = endpoint_prop_sat_band_203
    ? new THREE.CylinderGeometry(endpoint_prop_sat_band_203.endRadius, endpoint_prop_sat_band_203.baseRadius, endpoint_prop_sat_band_203.length, 8, 4)
    : new THREE.TorusGeometry(0.45, 0.0135, 8, 16);
  if (!endpoint_prop_sat_band_203) {
    mesh_prop_sat_band_203Geometry.scale(0.13228, 0.13228, 0.13228);
  }
  const mesh_prop_sat_band_203 = new THREE.Mesh(
    mesh_prop_sat_band_203Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_sat_band_203.name = "Drone band prop-sat";
  if (endpoint_prop_sat_band_203) {
    mesh_prop_sat_band_203.position.copy(endpoint_prop_sat_band_203.midpoint);
    mesh_prop_sat_band_203.quaternion.copy(endpoint_prop_sat_band_203.quaternion);
  }
  mesh_prop_sat_band_203.castShadow = options.castShadow ?? true;
  mesh_prop_sat_band_203.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_sat_band_203.userData.sculptComponent = { id: "prop-sat-band" };
  node_prop_sat_band_203.add(mesh_prop_sat_band_203);
  meshes["prop-sat-band"] = mesh_prop_sat_band_203;
  colliders["prop-sat-band"] = {};
  destructionGroups["prop-sat"] ??= [];
  destructionGroups["prop-sat"].push(node_prop_sat_band_203);
  // repetition system "gold-seam-strips" describes 4 parts that are already built individually; not instanced.
  // repetition system "glow-parts" describes 17 parts that are already built individually; not instanced.
  // repetition system "panel-content" describes 60 parts that are already built individually; not instanced.

  root.userData.sculptRuntime = { nodes, meshes, sockets, colliders, destructionGroups } satisfies ProceduralModelRuntime;
  root.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  root.userData.actionReadiness = {
    note: 'Use root.userData.sculptRuntime.nodes for transforms, sockets for attachments, colliders for physics proxies, and destructionGroups for breakable sets.',
  };
  return root;
}
