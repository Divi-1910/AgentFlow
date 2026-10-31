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

// Generated from ObjectSculptSpec target: AI Social Bot
// Sculpt build pass: blockout
// This factory is intentionally pass-gated. Finish browser screenshot review before unlocking deeper passes.
export function createBot(options: ProceduralModelOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = "AI Social Bot";
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
    {"id": "armor-pearl-silver", "name": "Pearl-silver clear-coated armor", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#9fa3b6", "color": "#9fa3b6", "albedo": {"dominant": "#9fa3b6", "secondary": ["#9496a8", "#b4b8c8"]}, "colorVariation": {"palette": ["#9fa3b6", "#9496a8", "#b4b8c8"], "pattern": "flat", "amplitude": 0.02, "heightCorrelation": 0.0}, "roughness": {"base": 0.22, "variation": 0.04}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "clearcoat-sheen", "region": "armor plates", "change": "low roughness + clearcoat hotspot band following plate curvature", "strength": 0.7, "evidenceRef": "/home/divyansh-muley/Divyansh/Projects/Divi/hero-bot-workspace/refs/bot7.png", "note": "Metadata only: the generator applies clearcoat to the whole material."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Albedo from sampled flat-lit silver regions; gloss from clearcoat + environment light.", "clearcoat": {"base": 1.0}, "clearcoatRoughness": {"base": 0.03}, "textureless": {"declared": true, "evidence": ["Reference view: /home/divyansh-muley/Divyansh/Projects/Divi/hero-bot-workspace/refs/bot7.png shows clean uniform clear-coated pearl paint without grain or wear."]}},
    options
  );
  materialMap["trim-gold"] = createSculptMaterial(
    "trim-gold",
    {"id": "trim-gold", "name": "Metallic gold trim", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#b68241", "color": "#b68241", "albedo": {"dominant": "#b68241", "secondary": ["#a8763a", "#c58f4a"]}, "colorVariation": {"palette": ["#b68241", "#a8763a", "#c58f4a"], "pattern": "flat", "amplitude": 0.02, "heightCorrelation": 0.0}, "roughness": {"base": 0.3, "variation": 0.04}, "metalness": {"base": 1.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Metal: needs environment reflections.", "textureless": {"declared": true, "evidence": ["Reference view: /home/divyansh-muley/Divyansh/Projects/Divi/hero-bot-workspace/refs/bot7.png shows gold as thin smooth inlay lines with no pattern."]}},
    options
  );
  materialMap["joint-black"] = createSculptMaterial(
    "joint-black",
    {"id": "joint-black", "name": "Glossy black polymer", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#141317", "color": "#141317", "albedo": {"dominant": "#141317", "secondary": ["#0e0d11", "#1b1a20"]}, "colorVariation": {"palette": ["#141317", "#0e0d11", "#1b1a20"], "pattern": "flat", "amplitude": 0.02, "heightCorrelation": 0.0}, "roughness": {"base": 0.3, "variation": 0.04}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "", "clearcoat": {"base": 0.5}, "clearcoatRoughness": {"base": 0.1}, "textureless": {"declared": true, "evidence": ["Reference view: /home/divyansh-muley/Divyansh/Projects/Divi/hero-bot-workspace/refs/bot7.png shows smooth glossy black joints and cores."]}},
    options
  );
  materialMap["emissive-accent"] = createSculptMaterial(
    "emissive-accent",
    {"id": "emissive-accent", "name": "Emissive accent", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#ff2d95", "color": "#ff2d95", "albedo": {"dominant": "#ff2d95", "secondary": ["#ff2d95"]}, "colorVariation": {"palette": ["#ff2d95"], "pattern": "flat", "amplitude": 0.02, "heightCorrelation": 0.0}, "roughness": {"base": 0.45, "variation": 0.04}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "bloom-core", "region": "all emissive accents", "change": "emissive intensity intended to bloom", "strength": 1.0, "evidenceRef": "/home/divyansh-muley/Divyansh/Projects/Divi/hero-bot-workspace/refs/bot7.png", "note": "Metadata only."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Every glow is a dedicated component using this material.", "emissive": "#ff2d95", "emissiveIntensity": {"base": 2.6}, "textureless": {"declared": true, "evidence": ["Reference view: /home/divyansh-muley/Divyansh/Projects/Divi/hero-bot-workspace/refs/bot7.png shows uniform glow with no grain or pattern."]}},
    options
  );
  materialMap["emblem-disc-dark"] = createSculptMaterial(
    "emblem-disc-dark",
    {"id": "emblem-disc-dark", "name": "Dark emblem disc", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#5a0f3a", "color": "#5a0f3a", "albedo": {"dominant": "#5a0f3a", "secondary": ["#5a0f3a"]}, "colorVariation": {"palette": ["#5a0f3a"], "pattern": "flat", "amplitude": 0.02, "heightCorrelation": 0.0}, "roughness": {"base": 0.2, "variation": 0.04}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "", "clearcoat": {"base": 1.0}, "clearcoatRoughness": {"base": 0.05}, "textureless": {"declared": true, "evidence": ["Reference view: /home/divyansh-muley/Divyansh/Projects/Divi/hero-bot-workspace/refs/bot7.png shows a plain dark disc behind the AI lettering."]}},
    options
  );
  materialMap["emblem-white"] = createSculptMaterial(
    "emblem-white",
    {"id": "emblem-white", "name": "Emblem white lettering", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#f3f9fc", "color": "#f3f9fc", "albedo": {"dominant": "#f3f9fc", "secondary": ["#f3f9fc"]}, "colorVariation": {"palette": ["#f3f9fc"], "pattern": "flat", "amplitude": 0.02, "heightCorrelation": 0.0}, "roughness": {"base": 0.3, "variation": 0.04}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "", "emissive": "#cfe3ff", "emissiveIntensity": {"base": 0.9}, "textureless": {"declared": true, "evidence": ["Reference view: /home/divyansh-muley/Divyansh/Projects/Divi/hero-bot-workspace/refs/bot7.png shows solid white AI letters."]}},
    options
  );
  materialMap["holo-panel"] = createSculptMaterial(
    "holo-panel",
    {"id": "holo-panel", "name": "Translucent holographic panel", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#ff4ca4", "color": "#ff4ca4", "albedo": {"dominant": "#ff4ca4", "secondary": ["#ff4ca4"]}, "colorVariation": {"palette": ["#ff4ca4"], "pattern": "flat", "amplitude": 0.02, "heightCorrelation": 0.0}, "roughness": {"base": 0.2, "variation": 0.04}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "", "emissive": "#ff2d95", "emissiveIntensity": {"base": 0.9}, "opacity": {"base": 0.3}, "textureless": {"declared": true, "evidence": ["Reference view: /home/divyansh-muley/Divyansh/Projects/Divi/hero-bot-workspace/refs/bot7.png shows flat translucent coloured panels whose detail is thin lines and bars, which are separate parts."]}},
    options
  );
  materialMap["tile-dark"] = createSculptMaterial(
    "tile-dark",
    {"id": "tile-dark", "name": "Dark icon tile", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#2a1a22", "color": "#2a1a22", "albedo": {"dominant": "#2a1a22", "secondary": ["#2a1a22"]}, "colorVariation": {"palette": ["#2a1a22"], "pattern": "flat", "amplitude": 0.02, "heightCorrelation": 0.0}, "roughness": {"base": 0.25, "variation": 0.04}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "", "clearcoat": {"base": 0.6}, "clearcoatRoughness": {"base": 0.1}, "textureless": {"declared": true, "evidence": ["Reference view: /home/divyansh-muley/Divyansh/Projects/Divi/hero-bot-workspace/refs/bot7.png shows a dark app tile with a white glyph."]}},
    options
  );

  const nodes: Record<string, THREE.Object3D> = { root };
  const meshes: Record<string, THREE.Mesh> = {};
  const sockets: Record<string, THREE.Object3D> = {};
  const colliders: Record<string, unknown> = {};
  const destructionGroups: Record<string, THREE.Object3D[]> = {};

  const endpoint_root_0 = makeAttachmentEndpoint(null);
  const node_root_0 = new THREE.Group();
  node_root_0.name = "AI Social Bot (root)__pivot";
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
  mesh_root_0.name = "AI Social Bot (root)";
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
    mesh_pelvis_1Geometry.scale(0.2948, 0.31496, 0.20787);
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

  const attachment_abdomen_2 = {"parentSocket": "pelvis-abdomen", "localStart": [0.0, 0.11969, 0.0], "localEnd": [0.0, 0.25827, 0.0063], "contactType": "rigid-weld", "baseRadius": 0.08787, "endRadius": 0.09354, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
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
    mesh_abdomen_2Geometry.scale(0.17575, 0.13873, 0.17575);
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

  const attachment_chest_3 = {"parentSocket": "abdomen-chest", "localStart": [0.0, 0.13858, 0.0063], "localEnd": [0.0, 0.42205, 0.0126], "contactType": "rigid-weld", "baseRadius": 0.10205, "endRadius": 0.13606, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
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
    mesh_chest_3Geometry.scale(0.20409, 0.28353, 0.20409);
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

  const endpoint_visor_slit_7 = makeAttachmentEndpoint(null);
  const node_visor_slit_7 = new THREE.Group();
  node_visor_slit_7.name = "Visor glow band__pivot";
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
    ? new THREE.CylinderGeometry(endpoint_visor_slit_7.endRadius, endpoint_visor_slit_7.baseRadius, endpoint_visor_slit_7.length, 8, 4)
    : buildExtrudeGeometry({"points": [[-0.09449, -0.0126], [-0.04724, 0.0063], [0.0, 0.01575], [0.04724, 0.0063], [0.09449, -0.0126], [0.08189, -0.03465], [0.04724, -0.0189], [0.0, -0.00945], [-0.04724, -0.0189], [-0.08189, -0.03465]], "depth": 0.0126});
  if (!endpoint_visor_slit_7) {
    mesh_visor_slit_7Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_visor_slit_7 = new THREE.Mesh(
    mesh_visor_slit_7Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_visor_slit_7.name = "Visor glow band";
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
    ? new THREE.CylinderGeometry(endpoint_ear_pod_l_8.endRadius, endpoint_ear_pod_l_8.baseRadius, endpoint_ear_pod_l_8.length, 8, 4)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 10, 4);
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
    ? new THREE.CylinderGeometry(endpoint_ear_pod_ring_l_9.endRadius, endpoint_ear_pod_ring_l_9.baseRadius, endpoint_ear_pod_ring_l_9.length, 8, 4)
    : new THREE.TorusGeometry(0.45, 0.09, 8, 16);
  if (!endpoint_ear_pod_ring_l_9) {
    mesh_ear_pod_ring_l_9Geometry.scale(0.06299, 0.06299, 0.06299);
  }
  const mesh_ear_pod_ring_l_9 = new THREE.Mesh(
    mesh_ear_pod_ring_l_9Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
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

  const attachment_ear_pod_r_10 = {"parentSocket": "head-ear-pod-r", "localStart": [-0.10394, 0.14488, 0.0], "localEnd": [-0.13543, 0.14488, 0.0], "contactType": "rigid-weld", "baseRadius": 0.02835, "endRadius": 0.02835, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_ear_pod_r_10 = makeAttachmentEndpoint(attachment_ear_pod_r_10);
  const node_ear_pod_r_10 = new THREE.Group();
  node_ear_pod_r_10.name = "Ear pod R__pivot";
  node_ear_pod_r_10.scale.set(1, 1, 1);
  if (endpoint_ear_pod_r_10) {
    node_ear_pod_r_10.position.copy(endpoint_ear_pod_r_10.start);
    node_ear_pod_r_10.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_ear_pod_r_10.position.set(-0.10394, 0.14488, 0.0);
    node_ear_pod_r_10.rotation.set(0.0, 0.0, 0.0);
  }
  node_ear_pod_r_10.userData.sculptComponent = { id: "ear-pod-r" };
  node_ear_pod_r_10.userData.actionProfile = {};
  (nodes["head"] ?? root).add(node_ear_pod_r_10);
  nodes["ear-pod-r"] = node_ear_pod_r_10;
  const mesh_ear_pod_r_10Geometry = endpoint_ear_pod_r_10
    ? new THREE.CylinderGeometry(endpoint_ear_pod_r_10.endRadius, endpoint_ear_pod_r_10.baseRadius, endpoint_ear_pod_r_10.length, 8, 4)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 10, 4);
  if (!endpoint_ear_pod_r_10) {
    mesh_ear_pod_r_10Geometry.scale(0.05669, 0.0315, 0.05669);
  }
  const mesh_ear_pod_r_10 = new THREE.Mesh(
    mesh_ear_pod_r_10Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ear_pod_r_10.name = "Ear pod R";
  if (endpoint_ear_pod_r_10) {
    mesh_ear_pod_r_10.position.copy(endpoint_ear_pod_r_10.midpoint);
    mesh_ear_pod_r_10.quaternion.copy(endpoint_ear_pod_r_10.quaternion);
  }
  mesh_ear_pod_r_10.castShadow = options.castShadow ?? true;
  mesh_ear_pod_r_10.receiveShadow = options.receiveShadow ?? true;
  mesh_ear_pod_r_10.userData.sculptComponent = { id: "ear-pod-r" };
  node_ear_pod_r_10.add(mesh_ear_pod_r_10);
  meshes["ear-pod-r"] = mesh_ear_pod_r_10;
  colliders["ear-pod-r"] = {};
  destructionGroups["head"] ??= [];
  destructionGroups["head"].push(node_ear_pod_r_10);

  const endpoint_ear_pod_ring_r_11 = makeAttachmentEndpoint(null);
  const node_ear_pod_ring_r_11 = new THREE.Group();
  node_ear_pod_ring_r_11.name = "Ear pod ring R__pivot";
  node_ear_pod_ring_r_11.scale.set(1, 1, 1);
  if (endpoint_ear_pod_ring_r_11) {
    node_ear_pod_ring_r_11.position.copy(endpoint_ear_pod_ring_r_11.start);
    node_ear_pod_ring_r_11.rotation.set(0.0, 1.5708, 0.0);
  } else {
    node_ear_pod_ring_r_11.position.set(-0.13701, 0.14488, 0.0);
    node_ear_pod_ring_r_11.rotation.set(0.0, 1.5708, 0.0);
  }
  node_ear_pod_ring_r_11.userData.sculptComponent = { id: "ear-pod-ring-r" };
  node_ear_pod_ring_r_11.userData.actionProfile = {};
  (nodes["head"] ?? root).add(node_ear_pod_ring_r_11);
  nodes["ear-pod-ring-r"] = node_ear_pod_ring_r_11;
  const mesh_ear_pod_ring_r_11Geometry = endpoint_ear_pod_ring_r_11
    ? new THREE.CylinderGeometry(endpoint_ear_pod_ring_r_11.endRadius, endpoint_ear_pod_ring_r_11.baseRadius, endpoint_ear_pod_ring_r_11.length, 8, 4)
    : new THREE.TorusGeometry(0.45, 0.09, 8, 16);
  if (!endpoint_ear_pod_ring_r_11) {
    mesh_ear_pod_ring_r_11Geometry.scale(0.06299, 0.06299, 0.06299);
  }
  const mesh_ear_pod_ring_r_11 = new THREE.Mesh(
    mesh_ear_pod_ring_r_11Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ear_pod_ring_r_11.name = "Ear pod ring R";
  if (endpoint_ear_pod_ring_r_11) {
    mesh_ear_pod_ring_r_11.position.copy(endpoint_ear_pod_ring_r_11.midpoint);
    mesh_ear_pod_ring_r_11.quaternion.copy(endpoint_ear_pod_ring_r_11.quaternion);
  }
  mesh_ear_pod_ring_r_11.castShadow = options.castShadow ?? true;
  mesh_ear_pod_ring_r_11.receiveShadow = options.receiveShadow ?? true;
  mesh_ear_pod_ring_r_11.userData.sculptComponent = { id: "ear-pod-ring-r" };
  node_ear_pod_ring_r_11.add(mesh_ear_pod_ring_r_11);
  meshes["ear-pod-ring-r"] = mesh_ear_pod_ring_r_11;
  colliders["ear-pod-ring-r"] = {};
  destructionGroups["head"] ??= [];
  destructionGroups["head"].push(node_ear_pod_ring_r_11);

  const endpoint_horn_fin_l_12 = makeAttachmentEndpoint(null);
  const node_horn_fin_l_12 = new THREE.Group();
  node_horn_fin_l_12.name = "Horn fin crest__pivot";
  node_horn_fin_l_12.scale.set(1, 1, 1);
  if (endpoint_horn_fin_l_12) {
    node_horn_fin_l_12.position.copy(endpoint_horn_fin_l_12.start);
    node_horn_fin_l_12.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_horn_fin_l_12.position.set(0.0, 0.20158, -0.08189);
    node_horn_fin_l_12.rotation.set(0.0, 0.0, 0.0);
  }
  node_horn_fin_l_12.userData.sculptComponent = { id: "horn-fin-l" };
  node_horn_fin_l_12.userData.actionProfile = {};
  (nodes["head"] ?? root).add(node_horn_fin_l_12);
  nodes["horn-fin-l"] = node_horn_fin_l_12;
  const mesh_horn_fin_l_12Geometry = endpoint_horn_fin_l_12
    ? new THREE.CylinderGeometry(endpoint_horn_fin_l_12.endRadius, endpoint_horn_fin_l_12.baseRadius, endpoint_horn_fin_l_12.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.0315, "rz": 0.0126, "twist": 0.0}, {"position": [0.0, 0.04409, -0.0189], "rx": 0.0378, "rz": 0.0126, "twist": 0.0}, {"position": [0.0, 0.09449, -0.0378], "rx": 0.0252, "rz": 0.00945, "twist": 0.0}, {"position": [0.0, 0.11969, -0.05039], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 12, "capEnds": true});
  if (!endpoint_horn_fin_l_12) {
    mesh_horn_fin_l_12Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_horn_fin_l_12 = new THREE.Mesh(
    mesh_horn_fin_l_12Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_horn_fin_l_12.name = "Horn fin crest";
  if (endpoint_horn_fin_l_12) {
    mesh_horn_fin_l_12.position.copy(endpoint_horn_fin_l_12.midpoint);
    mesh_horn_fin_l_12.quaternion.copy(endpoint_horn_fin_l_12.quaternion);
  }
  mesh_horn_fin_l_12.castShadow = options.castShadow ?? true;
  mesh_horn_fin_l_12.receiveShadow = options.receiveShadow ?? true;
  mesh_horn_fin_l_12.userData.sculptComponent = { id: "horn-fin-l" };
  node_horn_fin_l_12.add(mesh_horn_fin_l_12);
  meshes["horn-fin-l"] = mesh_horn_fin_l_12;
  colliders["horn-fin-l"] = {};
  destructionGroups["head"] ??= [];
  destructionGroups["head"].push(node_horn_fin_l_12);

  const endpoint_head_band_13 = makeAttachmentEndpoint(null);
  const node_head_band_13 = new THREE.Group();
  node_head_band_13.name = "Helmet band__pivot";
  node_head_band_13.scale.set(1, 1, 1);
  if (endpoint_head_band_13) {
    node_head_band_13.position.copy(endpoint_head_band_13.start);
    node_head_band_13.rotation.set(1.5708, 0.0, 0.0);
  } else {
    node_head_band_13.position.set(0.0, 0.18268, 0.0);
    node_head_band_13.rotation.set(1.5708, 0.0, 0.0);
  }
  node_head_band_13.userData.sculptComponent = { id: "head-band" };
  node_head_band_13.userData.actionProfile = {};
  (nodes["head"] ?? root).add(node_head_band_13);
  nodes["head-band"] = node_head_band_13;
  const mesh_head_band_13Geometry = endpoint_head_band_13
    ? new THREE.CylinderGeometry(endpoint_head_band_13.endRadius, endpoint_head_band_13.baseRadius, endpoint_head_band_13.length, 8, 4)
    : new THREE.TorusGeometry(0.45, 0.0198, 8, 16);
  if (!endpoint_head_band_13) {
    mesh_head_band_13Geometry.scale(0.28696, 0.28696, 0.28696);
  }
  const mesh_head_band_13 = new THREE.Mesh(
    mesh_head_band_13Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_head_band_13.name = "Helmet band";
  if (endpoint_head_band_13) {
    mesh_head_band_13.position.copy(endpoint_head_band_13.midpoint);
    mesh_head_band_13.quaternion.copy(endpoint_head_band_13.quaternion);
  }
  mesh_head_band_13.castShadow = options.castShadow ?? true;
  mesh_head_band_13.receiveShadow = options.receiveShadow ?? true;
  mesh_head_band_13.userData.sculptComponent = { id: "head-band" };
  node_head_band_13.add(mesh_head_band_13);
  meshes["head-band"] = mesh_head_band_13;
  colliders["head-band"] = {};
  destructionGroups["head"] ??= [];
  destructionGroups["head"].push(node_head_band_13);

  const endpoint_chest_shell_l_14 = makeAttachmentEndpoint(null);
  const node_chest_shell_l_14 = new THREE.Group();
  node_chest_shell_l_14.name = "Chest shell L__pivot";
  node_chest_shell_l_14.scale.set(1, 1, 1);
  if (endpoint_chest_shell_l_14) {
    node_chest_shell_l_14.position.copy(endpoint_chest_shell_l_14.start);
    node_chest_shell_l_14.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_chest_shell_l_14.position.set(0.13039, 0.27717, 0.0378);
    node_chest_shell_l_14.rotation.set(0.0, 0.0, 0.0);
  }
  node_chest_shell_l_14.userData.sculptComponent = { id: "chest-shell-l" };
  node_chest_shell_l_14.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_chest_shell_l_14);
  nodes["chest-shell-l"] = node_chest_shell_l_14;
  const mesh_chest_shell_l_14Geometry = endpoint_chest_shell_l_14
    ? new THREE.CylinderGeometry(endpoint_chest_shell_l_14.endRadius, endpoint_chest_shell_l_14.baseRadius, endpoint_chest_shell_l_14.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.04409, "rz": 0.06236, "twist": 0.0}, {"position": [-0.01701, -0.06929, 0.0315], "rx": 0.06299, "rz": 0.0737, "twist": 0.0}, {"position": [-0.04535, -0.17008, 0.04409], "rx": 0.06299, "rz": 0.06236, "twist": 0.0}, {"position": [-0.06803, -0.26457, 0.0378], "rx": 0.0378, "rz": 0.03402, "twist": 0.0}], "radialSegments": 20, "capEnds": true});
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
    node_chest_shell_back_l_15.position.set(0.13039, 0.27717, -0.05039);
    node_chest_shell_back_l_15.rotation.set(0.0, 0.0, 0.0);
  }
  node_chest_shell_back_l_15.userData.sculptComponent = { id: "chest-shell-back-l" };
  node_chest_shell_back_l_15.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_chest_shell_back_l_15);
  nodes["chest-shell-back-l"] = node_chest_shell_back_l_15;
  const mesh_chest_shell_back_l_15Geometry = endpoint_chest_shell_back_l_15
    ? new THREE.CylinderGeometry(endpoint_chest_shell_back_l_15.endRadius, endpoint_chest_shell_back_l_15.baseRadius, endpoint_chest_shell_back_l_15.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.04409, "rz": 0.06236, "twist": 0.0}, {"position": [-0.01701, -0.06929, -0.0315], "rx": 0.06299, "rz": 0.0737, "twist": 0.0}, {"position": [-0.04535, -0.17008, -0.04409], "rx": 0.06299, "rz": 0.06236, "twist": 0.0}, {"position": [-0.06803, -0.26457, -0.0378], "rx": 0.0378, "rz": 0.03402, "twist": 0.0}], "radialSegments": 20, "capEnds": true});
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

  const endpoint_chest_lower_l_16 = makeAttachmentEndpoint(null);
  const node_chest_lower_l_16 = new THREE.Group();
  node_chest_lower_l_16.name = "Lower chest plate L__pivot";
  node_chest_lower_l_16.scale.set(1, 1, 1);
  if (endpoint_chest_lower_l_16) {
    node_chest_lower_l_16.position.copy(endpoint_chest_lower_l_16.start);
    node_chest_lower_l_16.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_chest_lower_l_16.position.set(0.06803, 0.06929, 0.08819);
    node_chest_lower_l_16.rotation.set(0.0, 0.0, 0.0);
  }
  node_chest_lower_l_16.userData.sculptComponent = { id: "chest-lower-l" };
  node_chest_lower_l_16.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_chest_lower_l_16);
  nodes["chest-lower-l"] = node_chest_lower_l_16;
  const mesh_chest_lower_l_16Geometry = endpoint_chest_lower_l_16
    ? new THREE.CylinderGeometry(endpoint_chest_lower_l_16.endRadius, endpoint_chest_lower_l_16.baseRadius, endpoint_chest_lower_l_16.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.0189, "rz": 0.0189, "twist": 0.0}, {"position": [-0.01701, -0.08819, 0.00315], "rx": 0.0315, "rz": 0.0378, "twist": 0.0}, {"position": [-0.03969, -0.17638, -0.00945], "rx": 0.0126, "rz": 0.00945, "twist": 0.0}], "radialSegments": 16, "capEnds": true});
  if (!endpoint_chest_lower_l_16) {
    mesh_chest_lower_l_16Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_chest_lower_l_16 = new THREE.Mesh(
    mesh_chest_lower_l_16Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_chest_lower_l_16.name = "Lower chest plate L";
  if (endpoint_chest_lower_l_16) {
    mesh_chest_lower_l_16.position.copy(endpoint_chest_lower_l_16.midpoint);
    mesh_chest_lower_l_16.quaternion.copy(endpoint_chest_lower_l_16.quaternion);
  }
  mesh_chest_lower_l_16.castShadow = options.castShadow ?? true;
  mesh_chest_lower_l_16.receiveShadow = options.receiveShadow ?? true;
  mesh_chest_lower_l_16.userData.sculptComponent = { id: "chest-lower-l" };
  node_chest_lower_l_16.add(mesh_chest_lower_l_16);
  meshes["chest-lower-l"] = mesh_chest_lower_l_16;
  colliders["chest-lower-l"] = {};
  destructionGroups["torso"] ??= [];
  destructionGroups["torso"].push(node_chest_lower_l_16);

  const endpoint_chest_shell_r_17 = makeAttachmentEndpoint(null);
  const node_chest_shell_r_17 = new THREE.Group();
  node_chest_shell_r_17.name = "Chest shell R__pivot";
  node_chest_shell_r_17.scale.set(1, 1, 1);
  if (endpoint_chest_shell_r_17) {
    node_chest_shell_r_17.position.copy(endpoint_chest_shell_r_17.start);
    node_chest_shell_r_17.rotation.set(0.0, -0.0, 0.0);
  } else {
    node_chest_shell_r_17.position.set(-0.13039, 0.27717, 0.0378);
    node_chest_shell_r_17.rotation.set(0.0, -0.0, 0.0);
  }
  node_chest_shell_r_17.userData.sculptComponent = { id: "chest-shell-r" };
  node_chest_shell_r_17.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_chest_shell_r_17);
  nodes["chest-shell-r"] = node_chest_shell_r_17;
  const mesh_chest_shell_r_17Geometry = endpoint_chest_shell_r_17
    ? new THREE.CylinderGeometry(endpoint_chest_shell_r_17.endRadius, endpoint_chest_shell_r_17.baseRadius, endpoint_chest_shell_r_17.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.04409, "rz": 0.06236, "twist": 0.0}, {"position": [0.01701, -0.06929, 0.0315], "rx": 0.06299, "rz": 0.0737, "twist": 0.0}, {"position": [0.04535, -0.17008, 0.04409], "rx": 0.06299, "rz": 0.06236, "twist": 0.0}, {"position": [0.06803, -0.26457, 0.0378], "rx": 0.0378, "rz": 0.03402, "twist": 0.0}], "radialSegments": 20, "capEnds": true});
  if (!endpoint_chest_shell_r_17) {
    mesh_chest_shell_r_17Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_chest_shell_r_17 = new THREE.Mesh(
    mesh_chest_shell_r_17Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_chest_shell_r_17.name = "Chest shell R";
  if (endpoint_chest_shell_r_17) {
    mesh_chest_shell_r_17.position.copy(endpoint_chest_shell_r_17.midpoint);
    mesh_chest_shell_r_17.quaternion.copy(endpoint_chest_shell_r_17.quaternion);
  }
  mesh_chest_shell_r_17.castShadow = options.castShadow ?? true;
  mesh_chest_shell_r_17.receiveShadow = options.receiveShadow ?? true;
  mesh_chest_shell_r_17.userData.sculptComponent = { id: "chest-shell-r" };
  node_chest_shell_r_17.add(mesh_chest_shell_r_17);
  meshes["chest-shell-r"] = mesh_chest_shell_r_17;
  colliders["chest-shell-r"] = {};
  destructionGroups["torso"] ??= [];
  destructionGroups["torso"].push(node_chest_shell_r_17);

  const endpoint_chest_shell_back_r_18 = makeAttachmentEndpoint(null);
  const node_chest_shell_back_r_18 = new THREE.Group();
  node_chest_shell_back_r_18.name = "Back shell R (inferred)__pivot";
  node_chest_shell_back_r_18.scale.set(1, 1, 1);
  if (endpoint_chest_shell_back_r_18) {
    node_chest_shell_back_r_18.position.copy(endpoint_chest_shell_back_r_18.start);
    node_chest_shell_back_r_18.rotation.set(0.0, -0.0, 0.0);
  } else {
    node_chest_shell_back_r_18.position.set(-0.13039, 0.27717, -0.05039);
    node_chest_shell_back_r_18.rotation.set(0.0, -0.0, 0.0);
  }
  node_chest_shell_back_r_18.userData.sculptComponent = { id: "chest-shell-back-r" };
  node_chest_shell_back_r_18.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_chest_shell_back_r_18);
  nodes["chest-shell-back-r"] = node_chest_shell_back_r_18;
  const mesh_chest_shell_back_r_18Geometry = endpoint_chest_shell_back_r_18
    ? new THREE.CylinderGeometry(endpoint_chest_shell_back_r_18.endRadius, endpoint_chest_shell_back_r_18.baseRadius, endpoint_chest_shell_back_r_18.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.04409, "rz": 0.06236, "twist": 0.0}, {"position": [0.01701, -0.06929, -0.0315], "rx": 0.06299, "rz": 0.0737, "twist": 0.0}, {"position": [0.04535, -0.17008, -0.04409], "rx": 0.06299, "rz": 0.06236, "twist": 0.0}, {"position": [0.06803, -0.26457, -0.0378], "rx": 0.0378, "rz": 0.03402, "twist": 0.0}], "radialSegments": 20, "capEnds": true});
  if (!endpoint_chest_shell_back_r_18) {
    mesh_chest_shell_back_r_18Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_chest_shell_back_r_18 = new THREE.Mesh(
    mesh_chest_shell_back_r_18Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_chest_shell_back_r_18.name = "Back shell R (inferred)";
  if (endpoint_chest_shell_back_r_18) {
    mesh_chest_shell_back_r_18.position.copy(endpoint_chest_shell_back_r_18.midpoint);
    mesh_chest_shell_back_r_18.quaternion.copy(endpoint_chest_shell_back_r_18.quaternion);
  }
  mesh_chest_shell_back_r_18.castShadow = options.castShadow ?? true;
  mesh_chest_shell_back_r_18.receiveShadow = options.receiveShadow ?? true;
  mesh_chest_shell_back_r_18.userData.sculptComponent = { id: "chest-shell-back-r" };
  node_chest_shell_back_r_18.add(mesh_chest_shell_back_r_18);
  meshes["chest-shell-back-r"] = mesh_chest_shell_back_r_18;
  colliders["chest-shell-back-r"] = {};
  destructionGroups["torso"] ??= [];
  destructionGroups["torso"].push(node_chest_shell_back_r_18);

  const endpoint_chest_lower_r_19 = makeAttachmentEndpoint(null);
  const node_chest_lower_r_19 = new THREE.Group();
  node_chest_lower_r_19.name = "Lower chest plate R__pivot";
  node_chest_lower_r_19.scale.set(1, 1, 1);
  if (endpoint_chest_lower_r_19) {
    node_chest_lower_r_19.position.copy(endpoint_chest_lower_r_19.start);
    node_chest_lower_r_19.rotation.set(0.0, -0.0, 0.0);
  } else {
    node_chest_lower_r_19.position.set(-0.06803, 0.06929, 0.08819);
    node_chest_lower_r_19.rotation.set(0.0, -0.0, 0.0);
  }
  node_chest_lower_r_19.userData.sculptComponent = { id: "chest-lower-r" };
  node_chest_lower_r_19.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_chest_lower_r_19);
  nodes["chest-lower-r"] = node_chest_lower_r_19;
  const mesh_chest_lower_r_19Geometry = endpoint_chest_lower_r_19
    ? new THREE.CylinderGeometry(endpoint_chest_lower_r_19.endRadius, endpoint_chest_lower_r_19.baseRadius, endpoint_chest_lower_r_19.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.0189, "rz": 0.0189, "twist": 0.0}, {"position": [0.01701, -0.08819, 0.00315], "rx": 0.0315, "rz": 0.0378, "twist": 0.0}, {"position": [0.03969, -0.17638, -0.00945], "rx": 0.0126, "rz": 0.00945, "twist": 0.0}], "radialSegments": 16, "capEnds": true});
  if (!endpoint_chest_lower_r_19) {
    mesh_chest_lower_r_19Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_chest_lower_r_19 = new THREE.Mesh(
    mesh_chest_lower_r_19Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_chest_lower_r_19.name = "Lower chest plate R";
  if (endpoint_chest_lower_r_19) {
    mesh_chest_lower_r_19.position.copy(endpoint_chest_lower_r_19.midpoint);
    mesh_chest_lower_r_19.quaternion.copy(endpoint_chest_lower_r_19.quaternion);
  }
  mesh_chest_lower_r_19.castShadow = options.castShadow ?? true;
  mesh_chest_lower_r_19.receiveShadow = options.receiveShadow ?? true;
  mesh_chest_lower_r_19.userData.sculptComponent = { id: "chest-lower-r" };
  node_chest_lower_r_19.add(mesh_chest_lower_r_19);
  meshes["chest-lower-r"] = mesh_chest_lower_r_19;
  colliders["chest-lower-r"] = {};
  destructionGroups["torso"] ??= [];
  destructionGroups["torso"].push(node_chest_lower_r_19);

  const attachment_emblem_disc_20 = {"parentSocket": "chest-emblem-disc", "localStart": [0.0, 0.14488, 0.13071], "localEnd": [0.0, 0.14488, 0.14646], "contactType": "rigid-weld", "baseRadius": 0.06929, "endRadius": 0.06929, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_emblem_disc_20 = makeAttachmentEndpoint(attachment_emblem_disc_20);
  const node_emblem_disc_20 = new THREE.Group();
  node_emblem_disc_20.name = "Emblem disc__pivot";
  node_emblem_disc_20.scale.set(1, 1, 1);
  if (endpoint_emblem_disc_20) {
    node_emblem_disc_20.position.copy(endpoint_emblem_disc_20.start);
    node_emblem_disc_20.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_emblem_disc_20.position.set(0.0, 0.14488, 0.13071);
    node_emblem_disc_20.rotation.set(0.0, 0.0, 0.0);
  }
  node_emblem_disc_20.userData.sculptComponent = { id: "emblem-disc" };
  node_emblem_disc_20.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_emblem_disc_20);
  nodes["emblem-disc"] = node_emblem_disc_20;
  const mesh_emblem_disc_20Geometry = endpoint_emblem_disc_20
    ? new THREE.CylinderGeometry(endpoint_emblem_disc_20.endRadius, endpoint_emblem_disc_20.baseRadius, endpoint_emblem_disc_20.length, 8, 4)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 10, 4);
  if (!endpoint_emblem_disc_20) {
    mesh_emblem_disc_20Geometry.scale(0.13858, 0.01575, 0.13858);
  }
  const mesh_emblem_disc_20 = new THREE.Mesh(
    mesh_emblem_disc_20Geometry,
    materialMap["emblem-disc-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_emblem_disc_20.name = "Emblem disc";
  if (endpoint_emblem_disc_20) {
    mesh_emblem_disc_20.position.copy(endpoint_emblem_disc_20.midpoint);
    mesh_emblem_disc_20.quaternion.copy(endpoint_emblem_disc_20.quaternion);
  }
  mesh_emblem_disc_20.castShadow = options.castShadow ?? true;
  mesh_emblem_disc_20.receiveShadow = options.receiveShadow ?? true;
  mesh_emblem_disc_20.userData.sculptComponent = { id: "emblem-disc" };
  node_emblem_disc_20.add(mesh_emblem_disc_20);
  meshes["emblem-disc"] = mesh_emblem_disc_20;
  colliders["emblem-disc"] = {};
  destructionGroups["torso"] ??= [];
  destructionGroups["torso"].push(node_emblem_disc_20);

  const endpoint_emblem_ring_21 = makeAttachmentEndpoint(null);
  const node_emblem_ring_21 = new THREE.Group();
  node_emblem_ring_21.name = "Emblem ring__pivot";
  node_emblem_ring_21.scale.set(1, 1, 1);
  if (endpoint_emblem_ring_21) {
    node_emblem_ring_21.position.copy(endpoint_emblem_ring_21.start);
    node_emblem_ring_21.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_emblem_ring_21.position.set(0.0, 0.14488, 0.14646);
    node_emblem_ring_21.rotation.set(0.0, 0.0, 0.0);
  }
  node_emblem_ring_21.userData.sculptComponent = { id: "emblem-ring" };
  node_emblem_ring_21.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_emblem_ring_21);
  nodes["emblem-ring"] = node_emblem_ring_21;
  const mesh_emblem_ring_21Geometry = endpoint_emblem_ring_21
    ? new THREE.CylinderGeometry(endpoint_emblem_ring_21.endRadius, endpoint_emblem_ring_21.baseRadius, endpoint_emblem_ring_21.length, 8, 4)
    : new THREE.TorusGeometry(0.45, 0.0514, 8, 16);
  if (!endpoint_emblem_ring_21) {
    mesh_emblem_ring_21Geometry.scale(0.14698, 0.14698, 0.14698);
  }
  const mesh_emblem_ring_21 = new THREE.Mesh(
    mesh_emblem_ring_21Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_emblem_ring_21.name = "Emblem ring";
  if (endpoint_emblem_ring_21) {
    mesh_emblem_ring_21.position.copy(endpoint_emblem_ring_21.midpoint);
    mesh_emblem_ring_21.quaternion.copy(endpoint_emblem_ring_21.quaternion);
  }
  mesh_emblem_ring_21.castShadow = options.castShadow ?? true;
  mesh_emblem_ring_21.receiveShadow = options.receiveShadow ?? true;
  mesh_emblem_ring_21.userData.sculptComponent = { id: "emblem-ring" };
  node_emblem_ring_21.add(mesh_emblem_ring_21);
  meshes["emblem-ring"] = mesh_emblem_ring_21;
  colliders["emblem-ring"] = {};
  destructionGroups["torso"] ??= [];
  destructionGroups["torso"].push(node_emblem_ring_21);

  const endpoint_emblem_letter_a_22 = makeAttachmentEndpoint(null);
  const node_emblem_letter_a_22 = new THREE.Group();
  node_emblem_letter_a_22.name = "Emblem letter A__pivot";
  node_emblem_letter_a_22.scale.set(1, 1, 1);
  if (endpoint_emblem_letter_a_22) {
    node_emblem_letter_a_22.position.copy(endpoint_emblem_letter_a_22.start);
    node_emblem_letter_a_22.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_emblem_letter_a_22.position.set(-0.01575, 0.14488, 0.14961);
    node_emblem_letter_a_22.rotation.set(0.0, 0.0, 0.0);
  }
  node_emblem_letter_a_22.userData.sculptComponent = { id: "emblem-letter-a" };
  node_emblem_letter_a_22.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_emblem_letter_a_22);
  nodes["emblem-letter-a"] = node_emblem_letter_a_22;
  const mesh_emblem_letter_a_22Geometry = endpoint_emblem_letter_a_22
    ? new THREE.CylinderGeometry(endpoint_emblem_letter_a_22.endRadius, endpoint_emblem_letter_a_22.baseRadius, endpoint_emblem_letter_a_22.length, 8, 4)
    : buildExtrudeGeometry({"points": [[-0.02016, -0.0252], [-0.01008, -0.0252], [-0.00706, -0.01386], [0.00706, -0.01386], [0.01008, -0.0252], [0.02016, -0.0252], [0.00706, 0.0252], [-0.00706, 0.0252]], "holes": [[[-0.00454, 0.00126], [0.00454, 0.00126], [0.0, 0.01512]]], "depth": 0.00945});
  if (!endpoint_emblem_letter_a_22) {
    mesh_emblem_letter_a_22Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_emblem_letter_a_22 = new THREE.Mesh(
    mesh_emblem_letter_a_22Geometry,
    materialMap["emblem-white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_emblem_letter_a_22.name = "Emblem letter A";
  if (endpoint_emblem_letter_a_22) {
    mesh_emblem_letter_a_22.position.copy(endpoint_emblem_letter_a_22.midpoint);
    mesh_emblem_letter_a_22.quaternion.copy(endpoint_emblem_letter_a_22.quaternion);
  }
  mesh_emblem_letter_a_22.castShadow = options.castShadow ?? true;
  mesh_emblem_letter_a_22.receiveShadow = options.receiveShadow ?? true;
  mesh_emblem_letter_a_22.userData.sculptComponent = { id: "emblem-letter-a" };
  node_emblem_letter_a_22.add(mesh_emblem_letter_a_22);
  meshes["emblem-letter-a"] = mesh_emblem_letter_a_22;
  colliders["emblem-letter-a"] = {};
  destructionGroups["torso"] ??= [];
  destructionGroups["torso"].push(node_emblem_letter_a_22);

  const endpoint_emblem_letter_i_23 = makeAttachmentEndpoint(null);
  const node_emblem_letter_i_23 = new THREE.Group();
  node_emblem_letter_i_23.name = "Emblem letter I__pivot";
  node_emblem_letter_i_23.scale.set(1, 1, 1);
  if (endpoint_emblem_letter_i_23) {
    node_emblem_letter_i_23.position.copy(endpoint_emblem_letter_i_23.start);
    node_emblem_letter_i_23.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_emblem_letter_i_23.position.set(0.0252, 0.14488, 0.14961);
    node_emblem_letter_i_23.rotation.set(0.0, 0.0, 0.0);
  }
  node_emblem_letter_i_23.userData.sculptComponent = { id: "emblem-letter-i" };
  node_emblem_letter_i_23.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_emblem_letter_i_23);
  nodes["emblem-letter-i"] = node_emblem_letter_i_23;
  const mesh_emblem_letter_i_23Geometry = endpoint_emblem_letter_i_23
    ? new THREE.CylinderGeometry(endpoint_emblem_letter_i_23.endRadius, endpoint_emblem_letter_i_23.baseRadius, endpoint_emblem_letter_i_23.length, 8, 4)
    : buildExtrudeGeometry({"points": [[-0.00504, -0.0252], [0.00504, -0.0252], [0.00504, 0.0252], [-0.00504, 0.0252]], "depth": 0.00945});
  if (!endpoint_emblem_letter_i_23) {
    mesh_emblem_letter_i_23Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_emblem_letter_i_23 = new THREE.Mesh(
    mesh_emblem_letter_i_23Geometry,
    materialMap["emblem-white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_emblem_letter_i_23.name = "Emblem letter I";
  if (endpoint_emblem_letter_i_23) {
    mesh_emblem_letter_i_23.position.copy(endpoint_emblem_letter_i_23.midpoint);
    mesh_emblem_letter_i_23.quaternion.copy(endpoint_emblem_letter_i_23.quaternion);
  }
  mesh_emblem_letter_i_23.castShadow = options.castShadow ?? true;
  mesh_emblem_letter_i_23.receiveShadow = options.receiveShadow ?? true;
  mesh_emblem_letter_i_23.userData.sculptComponent = { id: "emblem-letter-i" };
  node_emblem_letter_i_23.add(mesh_emblem_letter_i_23);
  meshes["emblem-letter-i"] = mesh_emblem_letter_i_23;
  colliders["emblem-letter-i"] = {};
  destructionGroups["torso"] ??= [];
  destructionGroups["torso"].push(node_emblem_letter_i_23);

  const endpoint_abdomen_rib_1_24 = makeAttachmentEndpoint(null);
  const node_abdomen_rib_1_24 = new THREE.Group();
  node_abdomen_rib_1_24.name = "Abdomen segment ring 1__pivot";
  node_abdomen_rib_1_24.scale.set(1, 1, 1);
  if (endpoint_abdomen_rib_1_24) {
    node_abdomen_rib_1_24.position.copy(endpoint_abdomen_rib_1_24.start);
    node_abdomen_rib_1_24.rotation.set(1.5708, 0.0, 0.0);
  } else {
    node_abdomen_rib_1_24.position.set(0.0, 0.09449, 0.0);
    node_abdomen_rib_1_24.rotation.set(1.5708, 0.0, 0.0);
  }
  node_abdomen_rib_1_24.userData.sculptComponent = { id: "abdomen-rib-1" };
  node_abdomen_rib_1_24.userData.actionProfile = {};
  (nodes["abdomen"] ?? root).add(node_abdomen_rib_1_24);
  nodes["abdomen-rib-1"] = node_abdomen_rib_1_24;
  const mesh_abdomen_rib_1_24Geometry = endpoint_abdomen_rib_1_24
    ? new THREE.CylinderGeometry(endpoint_abdomen_rib_1_24.endRadius, endpoint_abdomen_rib_1_24.baseRadius, endpoint_abdomen_rib_1_24.length, 8, 4)
    : new THREE.TorusGeometry(0.45, 0.0662, 8, 16);
  if (!endpoint_abdomen_rib_1_24) {
    mesh_abdomen_rib_1_24Geometry.scale(0.21417, 0.17562, 0.21417);
  }
  const mesh_abdomen_rib_1_24 = new THREE.Mesh(
    mesh_abdomen_rib_1_24Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_abdomen_rib_1_24.name = "Abdomen segment ring 1";
  if (endpoint_abdomen_rib_1_24) {
    mesh_abdomen_rib_1_24.position.copy(endpoint_abdomen_rib_1_24.midpoint);
    mesh_abdomen_rib_1_24.quaternion.copy(endpoint_abdomen_rib_1_24.quaternion);
  }
  mesh_abdomen_rib_1_24.castShadow = options.castShadow ?? true;
  mesh_abdomen_rib_1_24.receiveShadow = options.receiveShadow ?? true;
  mesh_abdomen_rib_1_24.userData.sculptComponent = { id: "abdomen-rib-1" };
  node_abdomen_rib_1_24.add(mesh_abdomen_rib_1_24);
  meshes["abdomen-rib-1"] = mesh_abdomen_rib_1_24;
  colliders["abdomen-rib-1"] = {};
  destructionGroups["torso"] ??= [];
  destructionGroups["torso"].push(node_abdomen_rib_1_24);

  const endpoint_abdomen_rib_2_25 = makeAttachmentEndpoint(null);
  const node_abdomen_rib_2_25 = new THREE.Group();
  node_abdomen_rib_2_25.name = "Abdomen segment ring 2__pivot";
  node_abdomen_rib_2_25.scale.set(1, 1, 1);
  if (endpoint_abdomen_rib_2_25) {
    node_abdomen_rib_2_25.position.copy(endpoint_abdomen_rib_2_25.start);
    node_abdomen_rib_2_25.rotation.set(1.5708, 0.0, 0.0);
  } else {
    node_abdomen_rib_2_25.position.set(0.0, 0.06929, 0.0);
    node_abdomen_rib_2_25.rotation.set(1.5708, 0.0, 0.0);
  }
  node_abdomen_rib_2_25.userData.sculptComponent = { id: "abdomen-rib-2" };
  node_abdomen_rib_2_25.userData.actionProfile = {};
  (nodes["abdomen"] ?? root).add(node_abdomen_rib_2_25);
  nodes["abdomen-rib-2"] = node_abdomen_rib_2_25;
  const mesh_abdomen_rib_2_25Geometry = endpoint_abdomen_rib_2_25
    ? new THREE.CylinderGeometry(endpoint_abdomen_rib_2_25.endRadius, endpoint_abdomen_rib_2_25.baseRadius, endpoint_abdomen_rib_2_25.length, 8, 4)
    : new THREE.TorusGeometry(0.45, 0.0662, 8, 16);
  if (!endpoint_abdomen_rib_2_25) {
    mesh_abdomen_rib_2_25Geometry.scale(0.21417, 0.17562, 0.21417);
  }
  const mesh_abdomen_rib_2_25 = new THREE.Mesh(
    mesh_abdomen_rib_2_25Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_abdomen_rib_2_25.name = "Abdomen segment ring 2";
  if (endpoint_abdomen_rib_2_25) {
    mesh_abdomen_rib_2_25.position.copy(endpoint_abdomen_rib_2_25.midpoint);
    mesh_abdomen_rib_2_25.quaternion.copy(endpoint_abdomen_rib_2_25.quaternion);
  }
  mesh_abdomen_rib_2_25.castShadow = options.castShadow ?? true;
  mesh_abdomen_rib_2_25.receiveShadow = options.receiveShadow ?? true;
  mesh_abdomen_rib_2_25.userData.sculptComponent = { id: "abdomen-rib-2" };
  node_abdomen_rib_2_25.add(mesh_abdomen_rib_2_25);
  meshes["abdomen-rib-2"] = mesh_abdomen_rib_2_25;
  colliders["abdomen-rib-2"] = {};
  destructionGroups["torso"] ??= [];
  destructionGroups["torso"].push(node_abdomen_rib_2_25);

  const endpoint_abdomen_rib_3_26 = makeAttachmentEndpoint(null);
  const node_abdomen_rib_3_26 = new THREE.Group();
  node_abdomen_rib_3_26.name = "Abdomen segment ring 3__pivot";
  node_abdomen_rib_3_26.scale.set(1, 1, 1);
  if (endpoint_abdomen_rib_3_26) {
    node_abdomen_rib_3_26.position.copy(endpoint_abdomen_rib_3_26.start);
    node_abdomen_rib_3_26.rotation.set(1.5708, 0.0, 0.0);
  } else {
    node_abdomen_rib_3_26.position.set(0.0, 0.04409, 0.0);
    node_abdomen_rib_3_26.rotation.set(1.5708, 0.0, 0.0);
  }
  node_abdomen_rib_3_26.userData.sculptComponent = { id: "abdomen-rib-3" };
  node_abdomen_rib_3_26.userData.actionProfile = {};
  (nodes["abdomen"] ?? root).add(node_abdomen_rib_3_26);
  nodes["abdomen-rib-3"] = node_abdomen_rib_3_26;
  const mesh_abdomen_rib_3_26Geometry = endpoint_abdomen_rib_3_26
    ? new THREE.CylinderGeometry(endpoint_abdomen_rib_3_26.endRadius, endpoint_abdomen_rib_3_26.baseRadius, endpoint_abdomen_rib_3_26.length, 8, 4)
    : new THREE.TorusGeometry(0.45, 0.0662, 8, 16);
  if (!endpoint_abdomen_rib_3_26) {
    mesh_abdomen_rib_3_26Geometry.scale(0.21417, 0.17562, 0.21417);
  }
  const mesh_abdomen_rib_3_26 = new THREE.Mesh(
    mesh_abdomen_rib_3_26Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_abdomen_rib_3_26.name = "Abdomen segment ring 3";
  if (endpoint_abdomen_rib_3_26) {
    mesh_abdomen_rib_3_26.position.copy(endpoint_abdomen_rib_3_26.midpoint);
    mesh_abdomen_rib_3_26.quaternion.copy(endpoint_abdomen_rib_3_26.quaternion);
  }
  mesh_abdomen_rib_3_26.castShadow = options.castShadow ?? true;
  mesh_abdomen_rib_3_26.receiveShadow = options.receiveShadow ?? true;
  mesh_abdomen_rib_3_26.userData.sculptComponent = { id: "abdomen-rib-3" };
  node_abdomen_rib_3_26.add(mesh_abdomen_rib_3_26);
  meshes["abdomen-rib-3"] = mesh_abdomen_rib_3_26;
  colliders["abdomen-rib-3"] = {};
  destructionGroups["torso"] ??= [];
  destructionGroups["torso"].push(node_abdomen_rib_3_26);

  const endpoint_abdomen_rib_4_27 = makeAttachmentEndpoint(null);
  const node_abdomen_rib_4_27 = new THREE.Group();
  node_abdomen_rib_4_27.name = "Abdomen segment ring 4__pivot";
  node_abdomen_rib_4_27.scale.set(1, 1, 1);
  if (endpoint_abdomen_rib_4_27) {
    node_abdomen_rib_4_27.position.copy(endpoint_abdomen_rib_4_27.start);
    node_abdomen_rib_4_27.rotation.set(1.5708, 0.0, 0.0);
  } else {
    node_abdomen_rib_4_27.position.set(0.0, 0.0189, 0.0);
    node_abdomen_rib_4_27.rotation.set(1.5708, 0.0, 0.0);
  }
  node_abdomen_rib_4_27.userData.sculptComponent = { id: "abdomen-rib-4" };
  node_abdomen_rib_4_27.userData.actionProfile = {};
  (nodes["abdomen"] ?? root).add(node_abdomen_rib_4_27);
  nodes["abdomen-rib-4"] = node_abdomen_rib_4_27;
  const mesh_abdomen_rib_4_27Geometry = endpoint_abdomen_rib_4_27
    ? new THREE.CylinderGeometry(endpoint_abdomen_rib_4_27.endRadius, endpoint_abdomen_rib_4_27.baseRadius, endpoint_abdomen_rib_4_27.length, 8, 4)
    : new THREE.TorusGeometry(0.45, 0.0662, 8, 16);
  if (!endpoint_abdomen_rib_4_27) {
    mesh_abdomen_rib_4_27Geometry.scale(0.21417, 0.17562, 0.21417);
  }
  const mesh_abdomen_rib_4_27 = new THREE.Mesh(
    mesh_abdomen_rib_4_27Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_abdomen_rib_4_27.name = "Abdomen segment ring 4";
  if (endpoint_abdomen_rib_4_27) {
    mesh_abdomen_rib_4_27.position.copy(endpoint_abdomen_rib_4_27.midpoint);
    mesh_abdomen_rib_4_27.quaternion.copy(endpoint_abdomen_rib_4_27.quaternion);
  }
  mesh_abdomen_rib_4_27.castShadow = options.castShadow ?? true;
  mesh_abdomen_rib_4_27.receiveShadow = options.receiveShadow ?? true;
  mesh_abdomen_rib_4_27.userData.sculptComponent = { id: "abdomen-rib-4" };
  node_abdomen_rib_4_27.add(mesh_abdomen_rib_4_27);
  meshes["abdomen-rib-4"] = mesh_abdomen_rib_4_27;
  colliders["abdomen-rib-4"] = {};
  destructionGroups["torso"] ??= [];
  destructionGroups["torso"].push(node_abdomen_rib_4_27);

  const endpoint_pelvis_plate_28 = makeAttachmentEndpoint(null);
  const node_pelvis_plate_28 = new THREE.Group();
  node_pelvis_plate_28.name = "Pelvis front plate__pivot";
  node_pelvis_plate_28.scale.set(1, 1, 1);
  if (endpoint_pelvis_plate_28) {
    node_pelvis_plate_28.position.copy(endpoint_pelvis_plate_28.start);
    node_pelvis_plate_28.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_pelvis_plate_28.position.set(0.0, 0.11969, 0.06929);
    node_pelvis_plate_28.rotation.set(0.0, 0.0, 0.0);
  }
  node_pelvis_plate_28.userData.sculptComponent = { id: "pelvis-plate" };
  node_pelvis_plate_28.userData.actionProfile = {};
  (nodes["pelvis"] ?? root).add(node_pelvis_plate_28);
  nodes["pelvis-plate"] = node_pelvis_plate_28;
  const mesh_pelvis_plate_28Geometry = endpoint_pelvis_plate_28
    ? new THREE.CylinderGeometry(endpoint_pelvis_plate_28.endRadius, endpoint_pelvis_plate_28.baseRadius, endpoint_pelvis_plate_28.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.04409, "rz": 0.09638, "twist": 0.0}, {"position": [0.0, -0.11969, 0.0252], "rx": 0.05669, "rz": 0.12472, "twist": 0.0}, {"position": [0.0, -0.23937, 0.0189], "rx": 0.05039, "rz": 0.10205, "twist": 0.0}, {"position": [0.0, -0.30236, 0.0063], "rx": 0.0315, "rz": 0.03969, "twist": 0.0}], "radialSegments": 20, "capEnds": true});
  if (!endpoint_pelvis_plate_28) {
    mesh_pelvis_plate_28Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_pelvis_plate_28 = new THREE.Mesh(
    mesh_pelvis_plate_28Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pelvis_plate_28.name = "Pelvis front plate";
  if (endpoint_pelvis_plate_28) {
    mesh_pelvis_plate_28.position.copy(endpoint_pelvis_plate_28.midpoint);
    mesh_pelvis_plate_28.quaternion.copy(endpoint_pelvis_plate_28.quaternion);
  }
  mesh_pelvis_plate_28.castShadow = options.castShadow ?? true;
  mesh_pelvis_plate_28.receiveShadow = options.receiveShadow ?? true;
  mesh_pelvis_plate_28.userData.sculptComponent = { id: "pelvis-plate" };
  node_pelvis_plate_28.add(mesh_pelvis_plate_28);
  meshes["pelvis-plate"] = mesh_pelvis_plate_28;
  colliders["pelvis-plate"] = {};
  destructionGroups["pelvis"] ??= [];
  destructionGroups["pelvis"].push(node_pelvis_plate_28);

  const endpoint_pelvis_plate_back_29 = makeAttachmentEndpoint(null);
  const node_pelvis_plate_back_29 = new THREE.Group();
  node_pelvis_plate_back_29.name = "Pelvis back plate (inferred)__pivot";
  node_pelvis_plate_back_29.scale.set(1, 1, 1);
  if (endpoint_pelvis_plate_back_29) {
    node_pelvis_plate_back_29.position.copy(endpoint_pelvis_plate_back_29.start);
    node_pelvis_plate_back_29.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_pelvis_plate_back_29.position.set(0.0, 0.11969, -0.06929);
    node_pelvis_plate_back_29.rotation.set(0.0, 0.0, 0.0);
  }
  node_pelvis_plate_back_29.userData.sculptComponent = { id: "pelvis-plate-back" };
  node_pelvis_plate_back_29.userData.actionProfile = {};
  (nodes["pelvis"] ?? root).add(node_pelvis_plate_back_29);
  nodes["pelvis-plate-back"] = node_pelvis_plate_back_29;
  const mesh_pelvis_plate_back_29Geometry = endpoint_pelvis_plate_back_29
    ? new THREE.CylinderGeometry(endpoint_pelvis_plate_back_29.endRadius, endpoint_pelvis_plate_back_29.baseRadius, endpoint_pelvis_plate_back_29.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.04409, "rz": 0.09638, "twist": 0.0}, {"position": [0.0, -0.11969, -0.0252], "rx": 0.05669, "rz": 0.12472, "twist": 0.0}, {"position": [0.0, -0.23937, -0.0189], "rx": 0.05039, "rz": 0.10205, "twist": 0.0}, {"position": [0.0, -0.30236, -0.0063], "rx": 0.0315, "rz": 0.03969, "twist": 0.0}], "radialSegments": 20, "capEnds": true});
  if (!endpoint_pelvis_plate_back_29) {
    mesh_pelvis_plate_back_29Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_pelvis_plate_back_29 = new THREE.Mesh(
    mesh_pelvis_plate_back_29Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pelvis_plate_back_29.name = "Pelvis back plate (inferred)";
  if (endpoint_pelvis_plate_back_29) {
    mesh_pelvis_plate_back_29.position.copy(endpoint_pelvis_plate_back_29.midpoint);
    mesh_pelvis_plate_back_29.quaternion.copy(endpoint_pelvis_plate_back_29.quaternion);
  }
  mesh_pelvis_plate_back_29.castShadow = options.castShadow ?? true;
  mesh_pelvis_plate_back_29.receiveShadow = options.receiveShadow ?? true;
  mesh_pelvis_plate_back_29.userData.sculptComponent = { id: "pelvis-plate-back" };
  node_pelvis_plate_back_29.add(mesh_pelvis_plate_back_29);
  meshes["pelvis-plate-back"] = mesh_pelvis_plate_back_29;
  colliders["pelvis-plate-back"] = {};
  destructionGroups["pelvis"] ??= [];
  destructionGroups["pelvis"].push(node_pelvis_plate_back_29);

  const endpoint_hip_joint_l_30 = makeAttachmentEndpoint(null);
  const node_hip_joint_l_30 = new THREE.Group();
  node_hip_joint_l_30.name = "Hip joint L__pivot";
  node_hip_joint_l_30.scale.set(1, 1, 1);
  if (endpoint_hip_joint_l_30) {
    node_hip_joint_l_30.position.copy(endpoint_hip_joint_l_30.start);
    node_hip_joint_l_30.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hip_joint_l_30.position.set(0.09354, 0.07559, 0.0);
    node_hip_joint_l_30.rotation.set(0.0, 0.0, 0.0);
  }
  node_hip_joint_l_30.userData.sculptComponent = { id: "hip-joint-l" };
  node_hip_joint_l_30.userData.actionProfile = {};
  (nodes["pelvis"] ?? root).add(node_hip_joint_l_30);
  nodes["hip-joint-l"] = node_hip_joint_l_30;
  const mesh_hip_joint_l_30Geometry = endpoint_hip_joint_l_30
    ? new THREE.CylinderGeometry(endpoint_hip_joint_l_30.endRadius, endpoint_hip_joint_l_30.baseRadius, endpoint_hip_joint_l_30.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_hip_joint_l_30) {
    mesh_hip_joint_l_30Geometry.scale(0.10079, 0.10079, 0.10079);
  }
  const mesh_hip_joint_l_30 = new THREE.Mesh(
    mesh_hip_joint_l_30Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hip_joint_l_30.name = "Hip joint L";
  if (endpoint_hip_joint_l_30) {
    mesh_hip_joint_l_30.position.copy(endpoint_hip_joint_l_30.midpoint);
    mesh_hip_joint_l_30.quaternion.copy(endpoint_hip_joint_l_30.quaternion);
  }
  mesh_hip_joint_l_30.castShadow = options.castShadow ?? true;
  mesh_hip_joint_l_30.receiveShadow = options.receiveShadow ?? true;
  mesh_hip_joint_l_30.userData.sculptComponent = { id: "hip-joint-l" };
  node_hip_joint_l_30.add(mesh_hip_joint_l_30);
  meshes["hip-joint-l"] = mesh_hip_joint_l_30;
  colliders["hip-joint-l"] = {};
  destructionGroups["leg-l"] ??= [];
  destructionGroups["leg-l"].push(node_hip_joint_l_30);

  const attachment_thigh_l_31 = {"parentSocket": "pelvis-thigh-l", "localStart": [0.09354, 0.07559, 0.0], "localEnd": [0.11906, -0.4252, 0.0126], "contactType": "socket-joint", "baseRadius": 0.05354, "endRadius": 0.04724, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_thigh_l_31 = makeAttachmentEndpoint(attachment_thigh_l_31);
  const node_thigh_l_31 = new THREE.Group();
  node_thigh_l_31.name = "Thigh core L__pivot";
  node_thigh_l_31.scale.set(1, 1, 1);
  if (endpoint_thigh_l_31) {
    node_thigh_l_31.position.copy(endpoint_thigh_l_31.start);
    node_thigh_l_31.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_thigh_l_31.position.set(0.09354, 0.07559, 0.0);
    node_thigh_l_31.rotation.set(0.0, 0.0, 0.0);
  }
  node_thigh_l_31.userData.sculptComponent = { id: "thigh-l" };
  node_thigh_l_31.userData.actionProfile = {};
  (nodes["pelvis"] ?? root).add(node_thigh_l_31);
  nodes["thigh-l"] = node_thigh_l_31;
  const mesh_thigh_l_31Geometry = endpoint_thigh_l_31
    ? new THREE.CylinderGeometry(endpoint_thigh_l_31.endRadius, endpoint_thigh_l_31.baseRadius, endpoint_thigh_l_31.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_thigh_l_31) {
    mesh_thigh_l_31Geometry.scale(0.10709, 0.5016, 0.10709);
  }
  const mesh_thigh_l_31 = new THREE.Mesh(
    mesh_thigh_l_31Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_thigh_l_31.name = "Thigh core L";
  if (endpoint_thigh_l_31) {
    mesh_thigh_l_31.position.copy(endpoint_thigh_l_31.midpoint);
    mesh_thigh_l_31.quaternion.copy(endpoint_thigh_l_31.quaternion);
  }
  mesh_thigh_l_31.castShadow = options.castShadow ?? true;
  mesh_thigh_l_31.receiveShadow = options.receiveShadow ?? true;
  mesh_thigh_l_31.userData.sculptComponent = { id: "thigh-l" };
  node_thigh_l_31.add(mesh_thigh_l_31);
  meshes["thigh-l"] = mesh_thigh_l_31;
  colliders["thigh-l"] = {};
  destructionGroups["leg-l"] ??= [];
  destructionGroups["leg-l"].push(node_thigh_l_31);

  const endpoint_thigh_plate_front_l_32 = makeAttachmentEndpoint(null);
  const node_thigh_plate_front_l_32 = new THREE.Group();
  node_thigh_plate_front_l_32.name = "Thigh front plate L__pivot";
  node_thigh_plate_front_l_32.scale.set(1, 1, 1);
  if (endpoint_thigh_plate_front_l_32) {
    node_thigh_plate_front_l_32.position.copy(endpoint_thigh_plate_front_l_32.start);
    node_thigh_plate_front_l_32.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_thigh_plate_front_l_32.position.set(0.00096, -0.0189, 0.06929);
    node_thigh_plate_front_l_32.rotation.set(0.0, 0.0, 0.0);
  }
  node_thigh_plate_front_l_32.userData.sculptComponent = { id: "thigh-plate-front-l" };
  node_thigh_plate_front_l_32.userData.actionProfile = {};
  (nodes["thigh-l"] ?? root).add(node_thigh_plate_front_l_32);
  nodes["thigh-plate-front-l"] = node_thigh_plate_front_l_32;
  const mesh_thigh_plate_front_l_32Geometry = endpoint_thigh_plate_front_l_32
    ? new THREE.CylinderGeometry(endpoint_thigh_plate_front_l_32.endRadius, endpoint_thigh_plate_front_l_32.baseRadius, endpoint_thigh_plate_front_l_32.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.01814, "rz": 0.01361, "twist": 0.0}, {"position": [0.00501, -0.09827, 0.0], "rx": 0.02452, "rz": 0.04762, "twist": 0.0}, {"position": [0.01377, -0.27024, 0.0], "rx": 0.02835, "rz": 0.06803, "twist": 0.0}, {"position": [0.02128, -0.41764, 0.0], "rx": 0.02516, "rz": 0.05102, "twist": 0.0}, {"position": [0.02503, -0.49134, 0.0], "rx": 0.01814, "rz": 0.01361, "twist": 0.0}], "radialSegments": 18, "capEnds": true});
  if (!endpoint_thigh_plate_front_l_32) {
    mesh_thigh_plate_front_l_32Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_thigh_plate_front_l_32 = new THREE.Mesh(
    mesh_thigh_plate_front_l_32Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_thigh_plate_front_l_32.name = "Thigh front plate L";
  if (endpoint_thigh_plate_front_l_32) {
    mesh_thigh_plate_front_l_32.position.copy(endpoint_thigh_plate_front_l_32.midpoint);
    mesh_thigh_plate_front_l_32.quaternion.copy(endpoint_thigh_plate_front_l_32.quaternion);
  }
  mesh_thigh_plate_front_l_32.castShadow = options.castShadow ?? true;
  mesh_thigh_plate_front_l_32.receiveShadow = options.receiveShadow ?? true;
  mesh_thigh_plate_front_l_32.userData.sculptComponent = { id: "thigh-plate-front-l" };
  node_thigh_plate_front_l_32.add(mesh_thigh_plate_front_l_32);
  meshes["thigh-plate-front-l"] = mesh_thigh_plate_front_l_32;
  colliders["thigh-plate-front-l"] = {};
  destructionGroups["leg-l"] ??= [];
  destructionGroups["leg-l"].push(node_thigh_plate_front_l_32);

  const endpoint_thigh_plate_outer_l_33 = makeAttachmentEndpoint(null);
  const node_thigh_plate_outer_l_33 = new THREE.Group();
  node_thigh_plate_outer_l_33.name = "Thigh outer plate L__pivot";
  node_thigh_plate_outer_l_33.scale.set(1, 1, 1);
  if (endpoint_thigh_plate_outer_l_33) {
    node_thigh_plate_outer_l_33.position.copy(endpoint_thigh_plate_outer_l_33.start);
    node_thigh_plate_outer_l_33.rotation.set(0.0, 1.01229, 0.0);
  } else {
    node_thigh_plate_outer_l_33.position.set(0.06678, 0.0, 0.04173);
    node_thigh_plate_outer_l_33.rotation.set(0.0, 1.01229, 0.0);
  }
  node_thigh_plate_outer_l_33.userData.sculptComponent = { id: "thigh-plate-outer-l" };
  node_thigh_plate_outer_l_33.userData.actionProfile = {};
  (nodes["thigh-l"] ?? root).add(node_thigh_plate_outer_l_33);
  nodes["thigh-plate-outer-l"] = node_thigh_plate_outer_l_33;
  const mesh_thigh_plate_outer_l_33Geometry = endpoint_thigh_plate_outer_l_33
    ? new THREE.CylinderGeometry(endpoint_thigh_plate_outer_l_33.endRadius, endpoint_thigh_plate_outer_l_33.baseRadius, endpoint_thigh_plate_outer_l_33.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.01613, "rz": 0.0102, "twist": 0.0}, {"position": [0.00269, -0.09953, 0.0043], "rx": 0.0218, "rz": 0.03572, "twist": 0.0}, {"position": [0.00739, -0.2737, 0.01182], "rx": 0.0252, "rz": 0.05102, "twist": 0.0}, {"position": [0.01142, -0.42299, 0.01827], "rx": 0.02236, "rz": 0.03827, "twist": 0.0}, {"position": [0.01343, -0.49764, 0.0215], "rx": 0.01613, "rz": 0.0102, "twist": 0.0}], "radialSegments": 18, "capEnds": true});
  if (!endpoint_thigh_plate_outer_l_33) {
    mesh_thigh_plate_outer_l_33Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_thigh_plate_outer_l_33 = new THREE.Mesh(
    mesh_thigh_plate_outer_l_33Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_thigh_plate_outer_l_33.name = "Thigh outer plate L";
  if (endpoint_thigh_plate_outer_l_33) {
    mesh_thigh_plate_outer_l_33.position.copy(endpoint_thigh_plate_outer_l_33.midpoint);
    mesh_thigh_plate_outer_l_33.quaternion.copy(endpoint_thigh_plate_outer_l_33.quaternion);
  }
  mesh_thigh_plate_outer_l_33.castShadow = options.castShadow ?? true;
  mesh_thigh_plate_outer_l_33.receiveShadow = options.receiveShadow ?? true;
  mesh_thigh_plate_outer_l_33.userData.sculptComponent = { id: "thigh-plate-outer-l" };
  node_thigh_plate_outer_l_33.add(mesh_thigh_plate_outer_l_33);
  meshes["thigh-plate-outer-l"] = mesh_thigh_plate_outer_l_33;
  colliders["thigh-plate-outer-l"] = {};
  destructionGroups["leg-l"] ??= [];
  destructionGroups["leg-l"].push(node_thigh_plate_outer_l_33);

  const endpoint_thigh_plate_inner_l_34 = makeAttachmentEndpoint(null);
  const node_thigh_plate_inner_l_34 = new THREE.Group();
  node_thigh_plate_inner_l_34.name = "Thigh inner plate L__pivot";
  node_thigh_plate_inner_l_34.scale.set(1, 1, 1);
  if (endpoint_thigh_plate_inner_l_34) {
    node_thigh_plate_inner_l_34.position.copy(endpoint_thigh_plate_inner_l_34.start);
    node_thigh_plate_inner_l_34.rotation.set(0.0, -0.83776, 0.0);
  } else {
    node_thigh_plate_inner_l_34.position.set(-0.04691, -0.04409, 0.04426);
    node_thigh_plate_inner_l_34.rotation.set(0.0, -0.83776, 0.0);
  }
  node_thigh_plate_inner_l_34.userData.sculptComponent = { id: "thigh-plate-inner-l" };
  node_thigh_plate_inner_l_34.userData.actionProfile = {};
  (nodes["thigh-l"] ?? root).add(node_thigh_plate_inner_l_34);
  nodes["thigh-plate-inner-l"] = node_thigh_plate_inner_l_34;
  const mesh_thigh_plate_inner_l_34Geometry = endpoint_thigh_plate_inner_l_34
    ? new THREE.CylinderGeometry(endpoint_thigh_plate_inner_l_34.endRadius, endpoint_thigh_plate_inner_l_34.baseRadius, endpoint_thigh_plate_inner_l_34.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.01613, "rz": 0.00737, "twist": 0.0}, {"position": [0.00258, -0.07559, -0.00286], "rx": 0.0218, "rz": 0.0258, "twist": 0.0}, {"position": [0.00709, -0.20787, -0.00787], "rx": 0.0252, "rz": 0.03685, "twist": 0.0}, {"position": [0.01095, -0.32126, -0.01216], "rx": 0.02236, "rz": 0.02764, "twist": 0.0}, {"position": [0.01288, -0.37795, -0.01431], "rx": 0.01613, "rz": 0.00737, "twist": 0.0}], "radialSegments": 18, "capEnds": true});
  if (!endpoint_thigh_plate_inner_l_34) {
    mesh_thigh_plate_inner_l_34Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_thigh_plate_inner_l_34 = new THREE.Mesh(
    mesh_thigh_plate_inner_l_34Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_thigh_plate_inner_l_34.name = "Thigh inner plate L";
  if (endpoint_thigh_plate_inner_l_34) {
    mesh_thigh_plate_inner_l_34.position.copy(endpoint_thigh_plate_inner_l_34.midpoint);
    mesh_thigh_plate_inner_l_34.quaternion.copy(endpoint_thigh_plate_inner_l_34.quaternion);
  }
  mesh_thigh_plate_inner_l_34.castShadow = options.castShadow ?? true;
  mesh_thigh_plate_inner_l_34.receiveShadow = options.receiveShadow ?? true;
  mesh_thigh_plate_inner_l_34.userData.sculptComponent = { id: "thigh-plate-inner-l" };
  node_thigh_plate_inner_l_34.add(mesh_thigh_plate_inner_l_34);
  meshes["thigh-plate-inner-l"] = mesh_thigh_plate_inner_l_34;
  colliders["thigh-plate-inner-l"] = {};
  destructionGroups["leg-l"] ??= [];
  destructionGroups["leg-l"].push(node_thigh_plate_inner_l_34);

  const endpoint_thigh_plate_back_l_35 = makeAttachmentEndpoint(null);
  const node_thigh_plate_back_l_35 = new THREE.Group();
  node_thigh_plate_back_l_35.name = "Thigh back plate L__pivot";
  node_thigh_plate_back_l_35.scale.set(1, 1, 1);
  if (endpoint_thigh_plate_back_l_35) {
    node_thigh_plate_back_l_35.position.copy(endpoint_thigh_plate_back_l_35.start);
    node_thigh_plate_back_l_35.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_thigh_plate_back_l_35.position.set(0.00096, -0.0189, -0.06929);
    node_thigh_plate_back_l_35.rotation.set(0.0, 3.14159, 0.0);
  }
  node_thigh_plate_back_l_35.userData.sculptComponent = { id: "thigh-plate-back-l" };
  node_thigh_plate_back_l_35.userData.actionProfile = {};
  (nodes["thigh-l"] ?? root).add(node_thigh_plate_back_l_35);
  nodes["thigh-plate-back-l"] = node_thigh_plate_back_l_35;
  const mesh_thigh_plate_back_l_35Geometry = endpoint_thigh_plate_back_l_35
    ? new THREE.CylinderGeometry(endpoint_thigh_plate_back_l_35.endRadius, endpoint_thigh_plate_back_l_35.baseRadius, endpoint_thigh_plate_back_l_35.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.0, -0.0, 0.0], "rx": 0.01814, "rz": 0.01247, "twist": 0.0}, {"position": [-0.00488, -0.09575, 0.0], "rx": 0.02452, "rz": 0.04365, "twist": 0.0}, {"position": [-0.01341, -0.26331, 0.0], "rx": 0.02835, "rz": 0.06236, "twist": 0.0}, {"position": [-0.02073, -0.40693, 0.0], "rx": 0.02516, "rz": 0.04677, "twist": 0.0}, {"position": [-0.02439, -0.47874, 0.0], "rx": 0.01814, "rz": 0.01247, "twist": 0.0}], "radialSegments": 18, "capEnds": true});
  if (!endpoint_thigh_plate_back_l_35) {
    mesh_thigh_plate_back_l_35Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_thigh_plate_back_l_35 = new THREE.Mesh(
    mesh_thigh_plate_back_l_35Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_thigh_plate_back_l_35.name = "Thigh back plate L";
  if (endpoint_thigh_plate_back_l_35) {
    mesh_thigh_plate_back_l_35.position.copy(endpoint_thigh_plate_back_l_35.midpoint);
    mesh_thigh_plate_back_l_35.quaternion.copy(endpoint_thigh_plate_back_l_35.quaternion);
  }
  mesh_thigh_plate_back_l_35.castShadow = options.castShadow ?? true;
  mesh_thigh_plate_back_l_35.receiveShadow = options.receiveShadow ?? true;
  mesh_thigh_plate_back_l_35.userData.sculptComponent = { id: "thigh-plate-back-l" };
  node_thigh_plate_back_l_35.add(mesh_thigh_plate_back_l_35);
  meshes["thigh-plate-back-l"] = mesh_thigh_plate_back_l_35;
  colliders["thigh-plate-back-l"] = {};
  destructionGroups["leg-l"] ??= [];
  destructionGroups["leg-l"].push(node_thigh_plate_back_l_35);

  const endpoint_thigh_plate_backout_l_36 = makeAttachmentEndpoint(null);
  const node_thigh_plate_backout_l_36 = new THREE.Group();
  node_thigh_plate_backout_l_36.name = "Thigh backout plate L__pivot";
  node_thigh_plate_backout_l_36.scale.set(1, 1, 1);
  if (endpoint_thigh_plate_backout_l_36) {
    node_thigh_plate_backout_l_36.position.copy(endpoint_thigh_plate_backout_l_36.start);
    node_thigh_plate_backout_l_36.rotation.set(0.0, 2.18166, 0.0);
  } else {
    node_thigh_plate_backout_l_36.position.set(0.06159, -0.04409, -0.04155);
    node_thigh_plate_backout_l_36.rotation.set(0.0, 2.18166, 0.0);
  }
  node_thigh_plate_backout_l_36.userData.sculptComponent = { id: "thigh-plate-backout-l" };
  node_thigh_plate_backout_l_36.userData.actionProfile = {};
  (nodes["thigh-l"] ?? root).add(node_thigh_plate_backout_l_36);
  nodes["thigh-plate-backout-l"] = node_thigh_plate_backout_l_36;
  const mesh_thigh_plate_backout_l_36Geometry = endpoint_thigh_plate_backout_l_36
    ? new THREE.CylinderGeometry(endpoint_thigh_plate_backout_l_36.endRadius, endpoint_thigh_plate_backout_l_36.baseRadius, endpoint_thigh_plate_backout_l_36.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.0, -0.0, 0.0], "rx": 0.01613, "rz": 0.00907, "twist": 0.0}, {"position": [-0.00239, -0.08189, 0.00342], "rx": 0.0218, "rz": 0.03175, "twist": 0.0}, {"position": [-0.00658, -0.2252, 0.0094], "rx": 0.0252, "rz": 0.04535, "twist": 0.0}, {"position": [-0.01017, -0.34803, 0.01452], "rx": 0.02236, "rz": 0.03402, "twist": 0.0}, {"position": [-0.01196, -0.40945, 0.01709], "rx": 0.01613, "rz": 0.00907, "twist": 0.0}], "radialSegments": 18, "capEnds": true});
  if (!endpoint_thigh_plate_backout_l_36) {
    mesh_thigh_plate_backout_l_36Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_thigh_plate_backout_l_36 = new THREE.Mesh(
    mesh_thigh_plate_backout_l_36Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_thigh_plate_backout_l_36.name = "Thigh backout plate L";
  if (endpoint_thigh_plate_backout_l_36) {
    mesh_thigh_plate_backout_l_36.position.copy(endpoint_thigh_plate_backout_l_36.midpoint);
    mesh_thigh_plate_backout_l_36.quaternion.copy(endpoint_thigh_plate_backout_l_36.quaternion);
  }
  mesh_thigh_plate_backout_l_36.castShadow = options.castShadow ?? true;
  mesh_thigh_plate_backout_l_36.receiveShadow = options.receiveShadow ?? true;
  mesh_thigh_plate_backout_l_36.userData.sculptComponent = { id: "thigh-plate-backout-l" };
  node_thigh_plate_backout_l_36.add(mesh_thigh_plate_backout_l_36);
  meshes["thigh-plate-backout-l"] = mesh_thigh_plate_backout_l_36;
  colliders["thigh-plate-backout-l"] = {};
  destructionGroups["leg-l"] ??= [];
  destructionGroups["leg-l"].push(node_thigh_plate_backout_l_36);

  const endpoint_knee_l_37 = makeAttachmentEndpoint(null);
  const node_knee_l_37 = new THREE.Group();
  node_knee_l_37.name = "Knee joint L__pivot";
  node_knee_l_37.scale.set(1, 1, 1);
  if (endpoint_knee_l_37) {
    node_knee_l_37.position.copy(endpoint_knee_l_37.start);
    node_knee_l_37.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_knee_l_37.position.set(0.02551, -0.50394, 0.0189);
    node_knee_l_37.rotation.set(0.0, 0.0, 0.0);
  }
  node_knee_l_37.userData.sculptComponent = { id: "knee-l" };
  node_knee_l_37.userData.actionProfile = {};
  (nodes["thigh-l"] ?? root).add(node_knee_l_37);
  nodes["knee-l"] = node_knee_l_37;
  const mesh_knee_l_37Geometry = endpoint_knee_l_37
    ? new THREE.CylinderGeometry(endpoint_knee_l_37.endRadius, endpoint_knee_l_37.baseRadius, endpoint_knee_l_37.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_knee_l_37) {
    mesh_knee_l_37Geometry.scale(0.10709, 0.10709, 0.10709);
  }
  const mesh_knee_l_37 = new THREE.Mesh(
    mesh_knee_l_37Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_knee_l_37.name = "Knee joint L";
  if (endpoint_knee_l_37) {
    mesh_knee_l_37.position.copy(endpoint_knee_l_37.midpoint);
    mesh_knee_l_37.quaternion.copy(endpoint_knee_l_37.quaternion);
  }
  mesh_knee_l_37.castShadow = options.castShadow ?? true;
  mesh_knee_l_37.receiveShadow = options.receiveShadow ?? true;
  mesh_knee_l_37.userData.sculptComponent = { id: "knee-l" };
  node_knee_l_37.add(mesh_knee_l_37);
  meshes["knee-l"] = mesh_knee_l_37;
  colliders["knee-l"] = {};
  destructionGroups["leg-l"] ??= [];
  destructionGroups["leg-l"].push(node_knee_l_37);

  const endpoint_knee_glow_l_38 = makeAttachmentEndpoint(null);
  const node_knee_glow_l_38 = new THREE.Group();
  node_knee_glow_l_38.name = "Knee glow L__pivot";
  node_knee_glow_l_38.scale.set(1, 1, 1);
  if (endpoint_knee_glow_l_38) {
    node_knee_glow_l_38.position.copy(endpoint_knee_glow_l_38.start);
    node_knee_glow_l_38.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_knee_glow_l_38.position.set(0.02551, -0.61102, 0.06929);
    node_knee_glow_l_38.rotation.set(0.0, 0.0, 0.0);
  }
  node_knee_glow_l_38.userData.sculptComponent = { id: "knee-glow-l" };
  node_knee_glow_l_38.userData.actionProfile = {};
  (nodes["thigh-l"] ?? root).add(node_knee_glow_l_38);
  nodes["knee-glow-l"] = node_knee_glow_l_38;
  const mesh_knee_glow_l_38Geometry = endpoint_knee_glow_l_38
    ? new THREE.CylinderGeometry(endpoint_knee_glow_l_38.endRadius, endpoint_knee_glow_l_38.baseRadius, endpoint_knee_glow_l_38.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_knee_glow_l_38) {
    mesh_knee_glow_l_38Geometry.scale(0.08819, 0.02835, 0.02205);
  }
  const mesh_knee_glow_l_38 = new THREE.Mesh(
    mesh_knee_glow_l_38Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_knee_glow_l_38.name = "Knee glow L";
  if (endpoint_knee_glow_l_38) {
    mesh_knee_glow_l_38.position.copy(endpoint_knee_glow_l_38.midpoint);
    mesh_knee_glow_l_38.quaternion.copy(endpoint_knee_glow_l_38.quaternion);
  }
  mesh_knee_glow_l_38.castShadow = options.castShadow ?? true;
  mesh_knee_glow_l_38.receiveShadow = options.receiveShadow ?? true;
  mesh_knee_glow_l_38.userData.sculptComponent = { id: "knee-glow-l" };
  node_knee_glow_l_38.add(mesh_knee_glow_l_38);
  meshes["knee-glow-l"] = mesh_knee_glow_l_38;
  colliders["knee-glow-l"] = {};
  destructionGroups["leg-l"] ??= [];
  destructionGroups["leg-l"].push(node_knee_glow_l_38);

  const endpoint_hip_glow_l_39 = makeAttachmentEndpoint(null);
  const node_hip_glow_l_39 = new THREE.Group();
  node_hip_glow_l_39.name = "Hip glow L__pivot";
  node_hip_glow_l_39.scale.set(1, 1, 1);
  if (endpoint_hip_glow_l_39) {
    node_hip_glow_l_39.position.copy(endpoint_hip_glow_l_39.start);
    node_hip_glow_l_39.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hip_glow_l_39.position.set(0.09071, 0.08819, 0.09449);
    node_hip_glow_l_39.rotation.set(0.0, 0.0, 0.0);
  }
  node_hip_glow_l_39.userData.sculptComponent = { id: "hip-glow-l" };
  node_hip_glow_l_39.userData.actionProfile = {};
  (nodes["pelvis"] ?? root).add(node_hip_glow_l_39);
  nodes["hip-glow-l"] = node_hip_glow_l_39;
  const mesh_hip_glow_l_39Geometry = endpoint_hip_glow_l_39
    ? new THREE.CylinderGeometry(endpoint_hip_glow_l_39.endRadius, endpoint_hip_glow_l_39.baseRadius, endpoint_hip_glow_l_39.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_hip_glow_l_39) {
    mesh_hip_glow_l_39Geometry.scale(0.04409, 0.02835, 0.0189);
  }
  const mesh_hip_glow_l_39 = new THREE.Mesh(
    mesh_hip_glow_l_39Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hip_glow_l_39.name = "Hip glow L";
  if (endpoint_hip_glow_l_39) {
    mesh_hip_glow_l_39.position.copy(endpoint_hip_glow_l_39.midpoint);
    mesh_hip_glow_l_39.quaternion.copy(endpoint_hip_glow_l_39.quaternion);
  }
  mesh_hip_glow_l_39.castShadow = options.castShadow ?? true;
  mesh_hip_glow_l_39.receiveShadow = options.receiveShadow ?? true;
  mesh_hip_glow_l_39.userData.sculptComponent = { id: "hip-glow-l" };
  node_hip_glow_l_39.add(mesh_hip_glow_l_39);
  meshes["hip-glow-l"] = mesh_hip_glow_l_39;
  colliders["hip-glow-l"] = {};
  destructionGroups["leg-l"] ??= [];
  destructionGroups["leg-l"].push(node_hip_glow_l_39);

  const attachment_shin_l_40 = {"parentSocket": "thigh-l-shin-l", "localStart": [0.02551, -0.50394, 0.0189], "localEnd": [0.09354, -0.91339, 0.0063], "contactType": "hinge-joint", "baseRadius": 0.04409, "endRadius": 0.03465, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_shin_l_40 = makeAttachmentEndpoint(attachment_shin_l_40);
  const node_shin_l_40 = new THREE.Group();
  node_shin_l_40.name = "Shin core L__pivot";
  node_shin_l_40.scale.set(1, 1, 1);
  if (endpoint_shin_l_40) {
    node_shin_l_40.position.copy(endpoint_shin_l_40.start);
    node_shin_l_40.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_shin_l_40.position.set(0.02551, -0.50394, 0.0189);
    node_shin_l_40.rotation.set(0.0, 0.0, 0.0);
  }
  node_shin_l_40.userData.sculptComponent = { id: "shin-l" };
  node_shin_l_40.userData.actionProfile = {};
  (nodes["thigh-l"] ?? root).add(node_shin_l_40);
  nodes["shin-l"] = node_shin_l_40;
  const mesh_shin_l_40Geometry = endpoint_shin_l_40
    ? new THREE.CylinderGeometry(endpoint_shin_l_40.endRadius, endpoint_shin_l_40.baseRadius, endpoint_shin_l_40.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_shin_l_40) {
    mesh_shin_l_40Geometry.scale(0.08819, 0.41525, 0.08819);
  }
  const mesh_shin_l_40 = new THREE.Mesh(
    mesh_shin_l_40Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_shin_l_40.name = "Shin core L";
  if (endpoint_shin_l_40) {
    mesh_shin_l_40.position.copy(endpoint_shin_l_40.midpoint);
    mesh_shin_l_40.quaternion.copy(endpoint_shin_l_40.quaternion);
  }
  mesh_shin_l_40.castShadow = options.castShadow ?? true;
  mesh_shin_l_40.receiveShadow = options.receiveShadow ?? true;
  mesh_shin_l_40.userData.sculptComponent = { id: "shin-l" };
  node_shin_l_40.add(mesh_shin_l_40);
  meshes["shin-l"] = mesh_shin_l_40;
  colliders["shin-l"] = {};
  destructionGroups["leg-l"] ??= [];
  destructionGroups["leg-l"].push(node_shin_l_40);

  const endpoint_shin_plate_front_l_41 = makeAttachmentEndpoint(null);
  const node_shin_plate_front_l_41 = new THREE.Group();
  node_shin_plate_front_l_41.name = "Shin front plate L__pivot";
  node_shin_plate_front_l_41.scale.set(1, 1, 1);
  if (endpoint_shin_plate_front_l_41) {
    node_shin_plate_front_l_41.position.copy(endpoint_shin_plate_front_l_41.start);
    node_shin_plate_front_l_41.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_shin_plate_front_l_41.position.set(0.00209, -0.0126, 0.04094);
    node_shin_plate_front_l_41.rotation.set(0.0, 0.0, 0.0);
  }
  node_shin_plate_front_l_41.userData.sculptComponent = { id: "shin-plate-front-l" };
  node_shin_plate_front_l_41.userData.actionProfile = {};
  (nodes["shin-l"] ?? root).add(node_shin_plate_front_l_41);
  nodes["shin-plate-front-l"] = node_shin_plate_front_l_41;
  const mesh_shin_plate_front_l_41Geometry = endpoint_shin_plate_front_l_41
    ? new THREE.CylinderGeometry(endpoint_shin_plate_front_l_41.endRadius, endpoint_shin_plate_front_l_41.baseRadius, endpoint_shin_plate_front_l_41.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.01814, "rz": 0.01361, "twist": 0.0}, {"position": [0.01591, -0.09575, 0.0], "rx": 0.02452, "rz": 0.04762, "twist": 0.0}, {"position": [0.04375, -0.26331, 0.0], "rx": 0.02835, "rz": 0.06803, "twist": 0.0}, {"position": [0.06761, -0.40693, 0.0], "rx": 0.02516, "rz": 0.05102, "twist": 0.0}, {"position": [0.07954, -0.47874, 0.0], "rx": 0.01814, "rz": 0.01361, "twist": 0.0}], "radialSegments": 18, "capEnds": true});
  if (!endpoint_shin_plate_front_l_41) {
    mesh_shin_plate_front_l_41Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_shin_plate_front_l_41 = new THREE.Mesh(
    mesh_shin_plate_front_l_41Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_shin_plate_front_l_41.name = "Shin front plate L";
  if (endpoint_shin_plate_front_l_41) {
    mesh_shin_plate_front_l_41.position.copy(endpoint_shin_plate_front_l_41.midpoint);
    mesh_shin_plate_front_l_41.quaternion.copy(endpoint_shin_plate_front_l_41.quaternion);
  }
  mesh_shin_plate_front_l_41.castShadow = options.castShadow ?? true;
  mesh_shin_plate_front_l_41.receiveShadow = options.receiveShadow ?? true;
  mesh_shin_plate_front_l_41.userData.sculptComponent = { id: "shin-plate-front-l" };
  node_shin_plate_front_l_41.add(mesh_shin_plate_front_l_41);
  meshes["shin-plate-front-l"] = mesh_shin_plate_front_l_41;
  colliders["shin-plate-front-l"] = {};
  destructionGroups["leg-l"] ??= [];
  destructionGroups["leg-l"].push(node_shin_plate_front_l_41);

  const endpoint_shin_plate_outer_l_42 = makeAttachmentEndpoint(null);
  const node_shin_plate_outer_l_42 = new THREE.Group();
  node_shin_plate_outer_l_42.name = "Shin outer plate L__pivot";
  node_shin_plate_outer_l_42.scale.set(1, 1, 1);
  if (endpoint_shin_plate_outer_l_42) {
    node_shin_plate_outer_l_42.position.copy(endpoint_shin_plate_outer_l_42.start);
    node_shin_plate_outer_l_42.rotation.set(0.0, 1.0472, 0.0);
  } else {
    node_shin_plate_outer_l_42.position.set(0.06924, -0.0063, 0.02047);
    node_shin_plate_outer_l_42.rotation.set(0.0, 1.0472, 0.0);
  }
  node_shin_plate_outer_l_42.userData.sculptComponent = { id: "shin-plate-outer-l" };
  node_shin_plate_outer_l_42.userData.actionProfile = {};
  (nodes["shin-l"] ?? root).add(node_shin_plate_outer_l_42);
  nodes["shin-plate-outer-l"] = node_shin_plate_outer_l_42;
  const mesh_shin_plate_outer_l_42Geometry = endpoint_shin_plate_outer_l_42
    ? new THREE.CylinderGeometry(endpoint_shin_plate_outer_l_42.endRadius, endpoint_shin_plate_outer_l_42.baseRadius, endpoint_shin_plate_outer_l_42.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.01613, "rz": 0.0102, "twist": 0.0}, {"position": [0.0067, -0.08063, 0.0116], "rx": 0.0218, "rz": 0.03572, "twist": 0.0}, {"position": [0.01842, -0.22173, 0.03191], "rx": 0.0252, "rz": 0.05102, "twist": 0.0}, {"position": [0.02847, -0.34268, 0.04931], "rx": 0.02236, "rz": 0.03827, "twist": 0.0}, {"position": [0.03349, -0.40315, 0.05801], "rx": 0.01613, "rz": 0.0102, "twist": 0.0}], "radialSegments": 18, "capEnds": true});
  if (!endpoint_shin_plate_outer_l_42) {
    mesh_shin_plate_outer_l_42Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_shin_plate_outer_l_42 = new THREE.Mesh(
    mesh_shin_plate_outer_l_42Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_shin_plate_outer_l_42.name = "Shin outer plate L";
  if (endpoint_shin_plate_outer_l_42) {
    mesh_shin_plate_outer_l_42.position.copy(endpoint_shin_plate_outer_l_42.midpoint);
    mesh_shin_plate_outer_l_42.quaternion.copy(endpoint_shin_plate_outer_l_42.quaternion);
  }
  mesh_shin_plate_outer_l_42.castShadow = options.castShadow ?? true;
  mesh_shin_plate_outer_l_42.receiveShadow = options.receiveShadow ?? true;
  mesh_shin_plate_outer_l_42.userData.sculptComponent = { id: "shin-plate-outer-l" };
  node_shin_plate_outer_l_42.add(mesh_shin_plate_outer_l_42);
  meshes["shin-plate-outer-l"] = mesh_shin_plate_outer_l_42;
  colliders["shin-plate-outer-l"] = {};
  destructionGroups["leg-l"] ??= [];
  destructionGroups["leg-l"].push(node_shin_plate_outer_l_42);

  const endpoint_shin_plate_inner_l_43 = makeAttachmentEndpoint(null);
  const node_shin_plate_inner_l_43 = new THREE.Group();
  node_shin_plate_inner_l_43.name = "Shin inner plate L__pivot";
  node_shin_plate_inner_l_43.scale.set(1, 1, 1);
  if (endpoint_shin_plate_inner_l_43) {
    node_shin_plate_inner_l_43.position.copy(endpoint_shin_plate_inner_l_43.start);
    node_shin_plate_inner_l_43.rotation.set(0.0, -0.87266, 0.0);
  } else {
    node_shin_plate_inner_l_43.position.set(-0.03433, -0.06929, 0.01957);
    node_shin_plate_inner_l_43.rotation.set(0.0, -0.87266, 0.0);
  }
  node_shin_plate_inner_l_43.userData.sculptComponent = { id: "shin-plate-inner-l" };
  node_shin_plate_inner_l_43.userData.actionProfile = {};
  (nodes["shin-l"] ?? root).add(node_shin_plate_inner_l_43);
  nodes["shin-plate-inner-l"] = node_shin_plate_inner_l_43;
  const mesh_shin_plate_inner_l_43Geometry = endpoint_shin_plate_inner_l_43
    ? new THREE.CylinderGeometry(endpoint_shin_plate_inner_l_43.endRadius, endpoint_shin_plate_inner_l_43.baseRadius, endpoint_shin_plate_inner_l_43.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.01411, "rz": 0.0068, "twist": 0.0}, {"position": [0.00632, -0.05921, -0.00754], "rx": 0.01907, "rz": 0.02381, "twist": 0.0}, {"position": [0.01739, -0.16283, -0.02073], "rx": 0.02205, "rz": 0.03402, "twist": 0.0}, {"position": [0.02688, -0.25165, -0.03203], "rx": 0.01957, "rz": 0.02551, "twist": 0.0}, {"position": [0.03162, -0.29606, -0.03768], "rx": 0.01411, "rz": 0.0068, "twist": 0.0}], "radialSegments": 18, "capEnds": true});
  if (!endpoint_shin_plate_inner_l_43) {
    mesh_shin_plate_inner_l_43Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_shin_plate_inner_l_43 = new THREE.Mesh(
    mesh_shin_plate_inner_l_43Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_shin_plate_inner_l_43.name = "Shin inner plate L";
  if (endpoint_shin_plate_inner_l_43) {
    mesh_shin_plate_inner_l_43.position.copy(endpoint_shin_plate_inner_l_43.midpoint);
    mesh_shin_plate_inner_l_43.quaternion.copy(endpoint_shin_plate_inner_l_43.quaternion);
  }
  mesh_shin_plate_inner_l_43.castShadow = options.castShadow ?? true;
  mesh_shin_plate_inner_l_43.receiveShadow = options.receiveShadow ?? true;
  mesh_shin_plate_inner_l_43.userData.sculptComponent = { id: "shin-plate-inner-l" };
  node_shin_plate_inner_l_43.add(mesh_shin_plate_inner_l_43);
  meshes["shin-plate-inner-l"] = mesh_shin_plate_inner_l_43;
  colliders["shin-plate-inner-l"] = {};
  destructionGroups["leg-l"] ??= [];
  destructionGroups["leg-l"].push(node_shin_plate_inner_l_43);

  const endpoint_shin_plate_back_l_44 = makeAttachmentEndpoint(null);
  const node_shin_plate_back_l_44 = new THREE.Group();
  node_shin_plate_back_l_44.name = "Shin back plate L__pivot";
  node_shin_plate_back_l_44.scale.set(1, 1, 1);
  if (endpoint_shin_plate_back_l_44) {
    node_shin_plate_back_l_44.position.copy(endpoint_shin_plate_back_l_44.start);
    node_shin_plate_back_l_44.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_shin_plate_back_l_44.position.set(0.00419, -0.0252, -0.07874);
    node_shin_plate_back_l_44.rotation.set(0.0, 3.14159, 0.0);
  }
  node_shin_plate_back_l_44.userData.sculptComponent = { id: "shin-plate-back-l" };
  node_shin_plate_back_l_44.userData.actionProfile = {};
  (nodes["shin-l"] ?? root).add(node_shin_plate_back_l_44);
  nodes["shin-plate-back-l"] = node_shin_plate_back_l_44;
  const mesh_shin_plate_back_l_44Geometry = endpoint_shin_plate_back_l_44
    ? new THREE.CylinderGeometry(endpoint_shin_plate_back_l_44.endRadius, endpoint_shin_plate_back_l_44.baseRadius, endpoint_shin_plate_back_l_44.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.0, -0.0, 0.0], "rx": 0.01814, "rz": 0.01247, "twist": 0.0}, {"position": [-0.01507, -0.09071, 0.0], "rx": 0.02452, "rz": 0.04365, "twist": 0.0}, {"position": [-0.04145, -0.24945, 0.0], "rx": 0.02835, "rz": 0.06236, "twist": 0.0}, {"position": [-0.06405, -0.38551, 0.0], "rx": 0.02516, "rz": 0.04677, "twist": 0.0}, {"position": [-0.07536, -0.45354, 0.0], "rx": 0.01814, "rz": 0.01247, "twist": 0.0}], "radialSegments": 18, "capEnds": true});
  if (!endpoint_shin_plate_back_l_44) {
    mesh_shin_plate_back_l_44Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_shin_plate_back_l_44 = new THREE.Mesh(
    mesh_shin_plate_back_l_44Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_shin_plate_back_l_44.name = "Shin back plate L";
  if (endpoint_shin_plate_back_l_44) {
    mesh_shin_plate_back_l_44.position.copy(endpoint_shin_plate_back_l_44.midpoint);
    mesh_shin_plate_back_l_44.quaternion.copy(endpoint_shin_plate_back_l_44.quaternion);
  }
  mesh_shin_plate_back_l_44.castShadow = options.castShadow ?? true;
  mesh_shin_plate_back_l_44.receiveShadow = options.receiveShadow ?? true;
  mesh_shin_plate_back_l_44.userData.sculptComponent = { id: "shin-plate-back-l" };
  node_shin_plate_back_l_44.add(mesh_shin_plate_back_l_44);
  meshes["shin-plate-back-l"] = mesh_shin_plate_back_l_44;
  colliders["shin-plate-back-l"] = {};
  destructionGroups["leg-l"] ??= [];
  destructionGroups["leg-l"].push(node_shin_plate_back_l_44);

  const endpoint_shin_spur_l_45 = makeAttachmentEndpoint(null);
  const node_shin_spur_l_45 = new THREE.Group();
  node_shin_spur_l_45.name = "Shin spur L__pivot";
  node_shin_spur_l_45.scale.set(1, 1, 1);
  if (endpoint_shin_spur_l_45) {
    node_shin_spur_l_45.position.copy(endpoint_shin_spur_l_45.start);
    node_shin_spur_l_45.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_shin_spur_l_45.position.set(0.06803, -0.18898, 0.0);
    node_shin_spur_l_45.rotation.set(0.0, 0.0, 0.0);
  }
  node_shin_spur_l_45.userData.sculptComponent = { id: "shin-spur-l" };
  node_shin_spur_l_45.userData.actionProfile = {};
  (nodes["shin-l"] ?? root).add(node_shin_spur_l_45);
  nodes["shin-spur-l"] = node_shin_spur_l_45;
  const mesh_shin_spur_l_45Geometry = endpoint_shin_spur_l_45
    ? new THREE.CylinderGeometry(endpoint_shin_spur_l_45.endRadius, endpoint_shin_spur_l_45.baseRadius, endpoint_shin_spur_l_45.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.0189, "rz": 0.02205, "twist": 0.0}, {"position": [0.02268, 0.08189, -0.00315], "rx": 0.01417, "rz": 0.01575, "twist": 0.0}, {"position": [0.04535, 0.18268, -0.0063], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 14, "capEnds": true});
  if (!endpoint_shin_spur_l_45) {
    mesh_shin_spur_l_45Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_shin_spur_l_45 = new THREE.Mesh(
    mesh_shin_spur_l_45Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_shin_spur_l_45.name = "Shin spur L";
  if (endpoint_shin_spur_l_45) {
    mesh_shin_spur_l_45.position.copy(endpoint_shin_spur_l_45.midpoint);
    mesh_shin_spur_l_45.quaternion.copy(endpoint_shin_spur_l_45.quaternion);
  }
  mesh_shin_spur_l_45.castShadow = options.castShadow ?? true;
  mesh_shin_spur_l_45.receiveShadow = options.receiveShadow ?? true;
  mesh_shin_spur_l_45.userData.sculptComponent = { id: "shin-spur-l" };
  node_shin_spur_l_45.add(mesh_shin_spur_l_45);
  meshes["shin-spur-l"] = mesh_shin_spur_l_45;
  colliders["shin-spur-l"] = {};
  destructionGroups["leg-l"] ??= [];
  destructionGroups["leg-l"].push(node_shin_spur_l_45);

  const endpoint_ankle_l_46 = makeAttachmentEndpoint(null);
  const node_ankle_l_46 = new THREE.Group();
  node_ankle_l_46.name = "Ankle joint L__pivot";
  node_ankle_l_46.scale.set(1, 1, 1);
  if (endpoint_ankle_l_46) {
    node_ankle_l_46.position.copy(endpoint_ankle_l_46.start);
    node_ankle_l_46.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_ankle_l_46.position.set(0.06803, -0.40945, -0.0126);
    node_ankle_l_46.rotation.set(0.0, 0.0, 0.0);
  }
  node_ankle_l_46.userData.sculptComponent = { id: "ankle-l" };
  node_ankle_l_46.userData.actionProfile = {};
  (nodes["shin-l"] ?? root).add(node_ankle_l_46);
  nodes["ankle-l"] = node_ankle_l_46;
  const mesh_ankle_l_46Geometry = endpoint_ankle_l_46
    ? new THREE.CylinderGeometry(endpoint_ankle_l_46.endRadius, endpoint_ankle_l_46.baseRadius, endpoint_ankle_l_46.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_ankle_l_46) {
    mesh_ankle_l_46Geometry.scale(0.08189, 0.08189, 0.08189);
  }
  const mesh_ankle_l_46 = new THREE.Mesh(
    mesh_ankle_l_46Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ankle_l_46.name = "Ankle joint L";
  if (endpoint_ankle_l_46) {
    mesh_ankle_l_46.position.copy(endpoint_ankle_l_46.midpoint);
    mesh_ankle_l_46.quaternion.copy(endpoint_ankle_l_46.quaternion);
  }
  mesh_ankle_l_46.castShadow = options.castShadow ?? true;
  mesh_ankle_l_46.receiveShadow = options.receiveShadow ?? true;
  mesh_ankle_l_46.userData.sculptComponent = { id: "ankle-l" };
  node_ankle_l_46.add(mesh_ankle_l_46);
  meshes["ankle-l"] = mesh_ankle_l_46;
  colliders["ankle-l"] = {};
  destructionGroups["leg-l"] ??= [];
  destructionGroups["leg-l"].push(node_ankle_l_46);

  const endpoint_boot_l_47 = makeAttachmentEndpoint(null);
  const node_boot_l_47 = new THREE.Group();
  node_boot_l_47.name = "Boot L__pivot";
  node_boot_l_47.scale.set(1, 1, 1);
  if (endpoint_boot_l_47) {
    node_boot_l_47.position.copy(endpoint_boot_l_47.start);
    node_boot_l_47.rotation.set(0.0, 0.3, 0.0);
  } else {
    node_boot_l_47.position.set(0.09638, -0.56063, -0.11339);
    node_boot_l_47.rotation.set(0.0, 0.3, 0.0);
  }
  node_boot_l_47.userData.sculptComponent = { id: "boot-l" };
  node_boot_l_47.userData.actionProfile = {};
  (nodes["shin-l"] ?? root).add(node_boot_l_47);
  nodes["boot-l"] = node_boot_l_47;
  const mesh_boot_l_47Geometry = endpoint_boot_l_47
    ? new THREE.CylinderGeometry(endpoint_boot_l_47.endRadius, endpoint_boot_l_47.baseRadius, endpoint_boot_l_47.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.06299, "rz": 0.04724, "twist": 0.0}, {"position": [0.0, -0.0063, 0.07874], "rx": 0.08819, "rz": 0.05669, "twist": 0.0}, {"position": [0.0, -0.0126, 0.17323], "rx": 0.08819, "rz": 0.04094, "twist": 0.0}, {"position": [0.0, -0.0315, 0.25827], "rx": 0.06299, "rz": 0.0252, "twist": 0.0}, {"position": [0.0, -0.0378, 0.30236], "rx": 0.0315, "rz": 0.0126, "twist": 0.0}], "radialSegments": 20, "capEnds": true});
  if (!endpoint_boot_l_47) {
    mesh_boot_l_47Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_boot_l_47 = new THREE.Mesh(
    mesh_boot_l_47Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_boot_l_47.name = "Boot L";
  if (endpoint_boot_l_47) {
    mesh_boot_l_47.position.copy(endpoint_boot_l_47.midpoint);
    mesh_boot_l_47.quaternion.copy(endpoint_boot_l_47.quaternion);
  }
  mesh_boot_l_47.castShadow = options.castShadow ?? true;
  mesh_boot_l_47.receiveShadow = options.receiveShadow ?? true;
  mesh_boot_l_47.userData.sculptComponent = { id: "boot-l" };
  node_boot_l_47.add(mesh_boot_l_47);
  meshes["boot-l"] = mesh_boot_l_47;
  colliders["boot-l"] = {};
  destructionGroups["leg-l"] ??= [];
  destructionGroups["leg-l"].push(node_boot_l_47);

  const endpoint_boot_shaft_l_48 = makeAttachmentEndpoint(null);
  const node_boot_shaft_l_48 = new THREE.Group();
  node_boot_shaft_l_48.name = "Boot shaft L__pivot";
  node_boot_shaft_l_48.scale.set(1, 1, 1);
  if (endpoint_boot_shaft_l_48) {
    node_boot_shaft_l_48.position.copy(endpoint_boot_shaft_l_48.start);
    node_boot_shaft_l_48.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_boot_shaft_l_48.position.set(0.08504, -0.40945, -0.0063);
    node_boot_shaft_l_48.rotation.set(0.0, 0.0, 0.0);
  }
  node_boot_shaft_l_48.userData.sculptComponent = { id: "boot-shaft-l" };
  node_boot_shaft_l_48.userData.actionProfile = {};
  (nodes["shin-l"] ?? root).add(node_boot_shaft_l_48);
  nodes["boot-shaft-l"] = node_boot_shaft_l_48;
  const mesh_boot_shaft_l_48Geometry = endpoint_boot_shaft_l_48
    ? new THREE.CylinderGeometry(endpoint_boot_shaft_l_48.endRadius, endpoint_boot_shaft_l_48.baseRadius, endpoint_boot_shaft_l_48.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.0252, "rz": 0.0315, "twist": 0.0}, {"position": [0.00567, -0.07559, 0.0063], "rx": 0.04724, "rz": 0.08189, "twist": 0.0}, {"position": [0.01134, -0.15748, 0.0063], "rx": 0.0252, "rz": 0.0252, "twist": 0.0}], "radialSegments": 18, "capEnds": true});
  if (!endpoint_boot_shaft_l_48) {
    mesh_boot_shaft_l_48Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_boot_shaft_l_48 = new THREE.Mesh(
    mesh_boot_shaft_l_48Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_boot_shaft_l_48.name = "Boot shaft L";
  if (endpoint_boot_shaft_l_48) {
    mesh_boot_shaft_l_48.position.copy(endpoint_boot_shaft_l_48.midpoint);
    mesh_boot_shaft_l_48.quaternion.copy(endpoint_boot_shaft_l_48.quaternion);
  }
  mesh_boot_shaft_l_48.castShadow = options.castShadow ?? true;
  mesh_boot_shaft_l_48.receiveShadow = options.receiveShadow ?? true;
  mesh_boot_shaft_l_48.userData.sculptComponent = { id: "boot-shaft-l" };
  node_boot_shaft_l_48.add(mesh_boot_shaft_l_48);
  meshes["boot-shaft-l"] = mesh_boot_shaft_l_48;
  colliders["boot-shaft-l"] = {};
  destructionGroups["leg-l"] ??= [];
  destructionGroups["leg-l"].push(node_boot_shaft_l_48);

  const endpoint_boot_sole_l_49 = makeAttachmentEndpoint(null);
  const node_boot_sole_l_49 = new THREE.Group();
  node_boot_sole_l_49.name = "Boot sole L__pivot";
  node_boot_sole_l_49.scale.set(1, 1, 1);
  if (endpoint_boot_sole_l_49) {
    node_boot_sole_l_49.position.copy(endpoint_boot_sole_l_49.start);
    node_boot_sole_l_49.rotation.set(0.0, 0.3, 0.0);
  } else {
    node_boot_sole_l_49.position.set(0.09638, -0.60945, 0.0315);
    node_boot_sole_l_49.rotation.set(0.0, 0.3, 0.0);
  }
  node_boot_sole_l_49.userData.sculptComponent = { id: "boot-sole-l" };
  node_boot_sole_l_49.userData.actionProfile = {};
  (nodes["shin-l"] ?? root).add(node_boot_sole_l_49);
  nodes["boot-sole-l"] = node_boot_sole_l_49;
  const mesh_boot_sole_l_49Geometry = endpoint_boot_sole_l_49
    ? new THREE.CylinderGeometry(endpoint_boot_sole_l_49.endRadius, endpoint_boot_sole_l_49.baseRadius, endpoint_boot_sole_l_49.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_boot_sole_l_49) {
    mesh_boot_sole_l_49Geometry.scale(0.13858, 0.01575, 0.30236);
  }
  const mesh_boot_sole_l_49 = new THREE.Mesh(
    mesh_boot_sole_l_49Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_boot_sole_l_49.name = "Boot sole L";
  if (endpoint_boot_sole_l_49) {
    mesh_boot_sole_l_49.position.copy(endpoint_boot_sole_l_49.midpoint);
    mesh_boot_sole_l_49.quaternion.copy(endpoint_boot_sole_l_49.quaternion);
  }
  mesh_boot_sole_l_49.castShadow = options.castShadow ?? true;
  mesh_boot_sole_l_49.receiveShadow = options.receiveShadow ?? true;
  mesh_boot_sole_l_49.userData.sculptComponent = { id: "boot-sole-l" };
  node_boot_sole_l_49.add(mesh_boot_sole_l_49);
  meshes["boot-sole-l"] = mesh_boot_sole_l_49;
  colliders["boot-sole-l"] = {};
  destructionGroups["leg-l"] ??= [];
  destructionGroups["leg-l"].push(node_boot_sole_l_49);

  const endpoint_seam_thigh_l_50 = makeAttachmentEndpoint(null);
  const node_seam_thigh_l_50 = new THREE.Group();
  node_seam_thigh_l_50.name = "Gold seam seam-thigh-l__pivot";
  node_seam_thigh_l_50.scale.set(1, 1, 1);
  if (endpoint_seam_thigh_l_50) {
    node_seam_thigh_l_50.position.copy(endpoint_seam_thigh_l_50.start);
    node_seam_thigh_l_50.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seam_thigh_l_50.position.set(0.0, 0.0, 0.0);
    node_seam_thigh_l_50.rotation.set(0.0, 0.0, 0.0);
  }
  node_seam_thigh_l_50.userData.sculptComponent = { id: "seam-thigh-l" };
  node_seam_thigh_l_50.userData.actionProfile = {};
  (nodes["thigh-plate-front-l"] ?? root).add(node_seam_thigh_l_50);
  nodes["seam-thigh-l"] = node_seam_thigh_l_50;
  const mesh_seam_thigh_l_50Geometry = endpoint_seam_thigh_l_50
    ? new THREE.CylinderGeometry(endpoint_seam_thigh_l_50.endRadius, endpoint_seam_thigh_l_50.baseRadius, endpoint_seam_thigh_l_50.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.0132, -0.0, 0.01669], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [-0.04119, -0.09827, 0.02256], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [-0.05222, -0.27024, 0.02608], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [-0.02822, -0.41764, 0.02314], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [0.01183, -0.49134, 0.01669], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_seam_thigh_l_50) {
    mesh_seam_thigh_l_50Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seam_thigh_l_50 = new THREE.Mesh(
    mesh_seam_thigh_l_50Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seam_thigh_l_50.name = "Gold seam seam-thigh-l";
  if (endpoint_seam_thigh_l_50) {
    mesh_seam_thigh_l_50.position.copy(endpoint_seam_thigh_l_50.midpoint);
    mesh_seam_thigh_l_50.quaternion.copy(endpoint_seam_thigh_l_50.quaternion);
  }
  mesh_seam_thigh_l_50.castShadow = options.castShadow ?? true;
  mesh_seam_thigh_l_50.receiveShadow = options.receiveShadow ?? true;
  mesh_seam_thigh_l_50.userData.sculptComponent = { id: "seam-thigh-l" };
  node_seam_thigh_l_50.add(mesh_seam_thigh_l_50);
  meshes["seam-thigh-l"] = mesh_seam_thigh_l_50;
  colliders["seam-thigh-l"] = {};
  destructionGroups["thigh-plate-front-l"] ??= [];
  destructionGroups["thigh-plate-front-l"].push(node_seam_thigh_l_50);

  const endpoint_seam_thigh_out_l_51 = makeAttachmentEndpoint(null);
  const node_seam_thigh_out_l_51 = new THREE.Group();
  node_seam_thigh_out_l_51.name = "Gold seam seam-thigh-out-l__pivot";
  node_seam_thigh_out_l_51.scale.set(1, 1, 1);
  if (endpoint_seam_thigh_out_l_51) {
    node_seam_thigh_out_l_51.position.copy(endpoint_seam_thigh_out_l_51.start);
    node_seam_thigh_out_l_51.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seam_thigh_out_l_51.position.set(0.0, 0.0, 0.0);
    node_seam_thigh_out_l_51.rotation.set(0.0, 0.0, 0.0);
  }
  node_seam_thigh_out_l_51.userData.sculptComponent = { id: "seam-thigh-out-l" };
  node_seam_thigh_out_l_51.userData.actionProfile = {};
  (nodes["thigh-plate-front-l"] ?? root).add(node_seam_thigh_out_l_51);
  nodes["seam-thigh-out-l"] = node_seam_thigh_out_l_51;
  const mesh_seam_thigh_out_l_51Geometry = endpoint_seam_thigh_out_l_51
    ? new THREE.CylinderGeometry(endpoint_seam_thigh_out_l_51.endRadius, endpoint_seam_thigh_out_l_51.baseRadius, endpoint_seam_thigh_out_l_51.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0132, -0.0, 0.01669], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [0.0512, -0.09827, 0.02256], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [0.07976, -0.27024, 0.02608], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [0.07077, -0.41764, 0.02314], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [0.03823, -0.49134, 0.01669], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_seam_thigh_out_l_51) {
    mesh_seam_thigh_out_l_51Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seam_thigh_out_l_51 = new THREE.Mesh(
    mesh_seam_thigh_out_l_51Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seam_thigh_out_l_51.name = "Gold seam seam-thigh-out-l";
  if (endpoint_seam_thigh_out_l_51) {
    mesh_seam_thigh_out_l_51.position.copy(endpoint_seam_thigh_out_l_51.midpoint);
    mesh_seam_thigh_out_l_51.quaternion.copy(endpoint_seam_thigh_out_l_51.quaternion);
  }
  mesh_seam_thigh_out_l_51.castShadow = options.castShadow ?? true;
  mesh_seam_thigh_out_l_51.receiveShadow = options.receiveShadow ?? true;
  mesh_seam_thigh_out_l_51.userData.sculptComponent = { id: "seam-thigh-out-l" };
  node_seam_thigh_out_l_51.add(mesh_seam_thigh_out_l_51);
  meshes["seam-thigh-out-l"] = mesh_seam_thigh_out_l_51;
  colliders["seam-thigh-out-l"] = {};
  destructionGroups["thigh-plate-front-l"] ??= [];
  destructionGroups["thigh-plate-front-l"].push(node_seam_thigh_out_l_51);

  const endpoint_seam_shin_l_52 = makeAttachmentEndpoint(null);
  const node_seam_shin_l_52 = new THREE.Group();
  node_seam_shin_l_52.name = "Gold seam seam-shin-l__pivot";
  node_seam_shin_l_52.scale.set(1, 1, 1);
  if (endpoint_seam_shin_l_52) {
    node_seam_shin_l_52.position.copy(endpoint_seam_shin_l_52.start);
    node_seam_shin_l_52.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seam_shin_l_52.position.set(0.0, 0.0, 0.0);
    node_seam_shin_l_52.rotation.set(0.0, 0.0, 0.0);
  }
  node_seam_shin_l_52.userData.sculptComponent = { id: "seam-shin-l" };
  node_seam_shin_l_52.userData.actionProfile = {};
  (nodes["shin-plate-front-l"] ?? root).add(node_seam_shin_l_52);
  nodes["seam-shin-l"] = node_seam_shin_l_52;
  const mesh_seam_shin_l_52Geometry = endpoint_seam_shin_l_52
    ? new THREE.CylinderGeometry(endpoint_seam_shin_l_52.endRadius, endpoint_seam_shin_l_52.baseRadius, endpoint_seam_shin_l_52.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0132, -0.0, 0.01669], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [0.0621, -0.09575, 0.02256], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [0.10974, -0.26331, 0.02608], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [0.11711, -0.40693, 0.02314], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [0.09274, -0.47874, 0.01669], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_seam_shin_l_52) {
    mesh_seam_shin_l_52Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seam_shin_l_52 = new THREE.Mesh(
    mesh_seam_shin_l_52Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seam_shin_l_52.name = "Gold seam seam-shin-l";
  if (endpoint_seam_shin_l_52) {
    mesh_seam_shin_l_52.position.copy(endpoint_seam_shin_l_52.midpoint);
    mesh_seam_shin_l_52.quaternion.copy(endpoint_seam_shin_l_52.quaternion);
  }
  mesh_seam_shin_l_52.castShadow = options.castShadow ?? true;
  mesh_seam_shin_l_52.receiveShadow = options.receiveShadow ?? true;
  mesh_seam_shin_l_52.userData.sculptComponent = { id: "seam-shin-l" };
  node_seam_shin_l_52.add(mesh_seam_shin_l_52);
  meshes["seam-shin-l"] = mesh_seam_shin_l_52;
  colliders["seam-shin-l"] = {};
  destructionGroups["shin-plate-front-l"] ??= [];
  destructionGroups["shin-plate-front-l"].push(node_seam_shin_l_52);

  const endpoint_seam_boot_l_53 = makeAttachmentEndpoint(null);
  const node_seam_boot_l_53 = new THREE.Group();
  node_seam_boot_l_53.name = "Gold seam seam-boot-l__pivot";
  node_seam_boot_l_53.scale.set(1, 1, 1);
  if (endpoint_seam_boot_l_53) {
    node_seam_boot_l_53.position.copy(endpoint_seam_boot_l_53.start);
    node_seam_boot_l_53.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seam_boot_l_53.position.set(0.0, 0.0, 0.0);
    node_seam_boot_l_53.rotation.set(0.0, 0.0, 0.0);
  }
  node_seam_boot_l_53.userData.sculptComponent = { id: "seam-boot-l" };
  node_seam_boot_l_53.userData.actionProfile = {};
  (nodes["boot-l"] ?? root).add(node_seam_boot_l_53);
  nodes["seam-boot-l"] = node_seam_boot_l_53;
  const mesh_seam_boot_l_53Geometry = endpoint_seam_boot_l_53
    ? new THREE.CylinderGeometry(endpoint_seam_boot_l_53.endRadius, endpoint_seam_boot_l_53.baseRadius, endpoint_seam_boot_l_53.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0611, 0.01654, 0.0], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [0.08554, 0.01354, 0.07874], "rx": 0.00567, "rz": 0.00567, "twist": 0.0}, {"position": [0.08554, 0.00173, 0.17323], "rx": 0.00567, "rz": 0.00567, "twist": 0.0}, {"position": [0.0611, -0.02268, 0.25827], "rx": 0.00567, "rz": 0.00567, "twist": 0.0}, {"position": [0.03055, -0.03339, 0.30236], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_seam_boot_l_53) {
    mesh_seam_boot_l_53Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seam_boot_l_53 = new THREE.Mesh(
    mesh_seam_boot_l_53Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seam_boot_l_53.name = "Gold seam seam-boot-l";
  if (endpoint_seam_boot_l_53) {
    mesh_seam_boot_l_53.position.copy(endpoint_seam_boot_l_53.midpoint);
    mesh_seam_boot_l_53.quaternion.copy(endpoint_seam_boot_l_53.quaternion);
  }
  mesh_seam_boot_l_53.castShadow = options.castShadow ?? true;
  mesh_seam_boot_l_53.receiveShadow = options.receiveShadow ?? true;
  mesh_seam_boot_l_53.userData.sculptComponent = { id: "seam-boot-l" };
  node_seam_boot_l_53.add(mesh_seam_boot_l_53);
  meshes["seam-boot-l"] = mesh_seam_boot_l_53;
  colliders["seam-boot-l"] = {};
  destructionGroups["boot-l"] ??= [];
  destructionGroups["boot-l"].push(node_seam_boot_l_53);

  const endpoint_hip_joint_r_54 = makeAttachmentEndpoint(null);
  const node_hip_joint_r_54 = new THREE.Group();
  node_hip_joint_r_54.name = "Hip joint R__pivot";
  node_hip_joint_r_54.scale.set(1, 1, 1);
  if (endpoint_hip_joint_r_54) {
    node_hip_joint_r_54.position.copy(endpoint_hip_joint_r_54.start);
    node_hip_joint_r_54.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hip_joint_r_54.position.set(-0.09354, 0.07559, 0.0);
    node_hip_joint_r_54.rotation.set(0.0, 0.0, 0.0);
  }
  node_hip_joint_r_54.userData.sculptComponent = { id: "hip-joint-r" };
  node_hip_joint_r_54.userData.actionProfile = {};
  (nodes["pelvis"] ?? root).add(node_hip_joint_r_54);
  nodes["hip-joint-r"] = node_hip_joint_r_54;
  const mesh_hip_joint_r_54Geometry = endpoint_hip_joint_r_54
    ? new THREE.CylinderGeometry(endpoint_hip_joint_r_54.endRadius, endpoint_hip_joint_r_54.baseRadius, endpoint_hip_joint_r_54.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_hip_joint_r_54) {
    mesh_hip_joint_r_54Geometry.scale(0.10079, 0.10079, 0.10079);
  }
  const mesh_hip_joint_r_54 = new THREE.Mesh(
    mesh_hip_joint_r_54Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hip_joint_r_54.name = "Hip joint R";
  if (endpoint_hip_joint_r_54) {
    mesh_hip_joint_r_54.position.copy(endpoint_hip_joint_r_54.midpoint);
    mesh_hip_joint_r_54.quaternion.copy(endpoint_hip_joint_r_54.quaternion);
  }
  mesh_hip_joint_r_54.castShadow = options.castShadow ?? true;
  mesh_hip_joint_r_54.receiveShadow = options.receiveShadow ?? true;
  mesh_hip_joint_r_54.userData.sculptComponent = { id: "hip-joint-r" };
  node_hip_joint_r_54.add(mesh_hip_joint_r_54);
  meshes["hip-joint-r"] = mesh_hip_joint_r_54;
  colliders["hip-joint-r"] = {};
  destructionGroups["leg-r"] ??= [];
  destructionGroups["leg-r"].push(node_hip_joint_r_54);

  const attachment_thigh_r_55 = {"parentSocket": "pelvis-thigh-r", "localStart": [-0.09354, 0.07559, 0.0], "localEnd": [-0.11906, -0.4252, 0.0126], "contactType": "socket-joint", "baseRadius": 0.05354, "endRadius": 0.04724, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_thigh_r_55 = makeAttachmentEndpoint(attachment_thigh_r_55);
  const node_thigh_r_55 = new THREE.Group();
  node_thigh_r_55.name = "Thigh core R__pivot";
  node_thigh_r_55.scale.set(1, 1, 1);
  if (endpoint_thigh_r_55) {
    node_thigh_r_55.position.copy(endpoint_thigh_r_55.start);
    node_thigh_r_55.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_thigh_r_55.position.set(-0.09354, 0.07559, 0.0);
    node_thigh_r_55.rotation.set(0.0, 0.0, 0.0);
  }
  node_thigh_r_55.userData.sculptComponent = { id: "thigh-r" };
  node_thigh_r_55.userData.actionProfile = {};
  (nodes["pelvis"] ?? root).add(node_thigh_r_55);
  nodes["thigh-r"] = node_thigh_r_55;
  const mesh_thigh_r_55Geometry = endpoint_thigh_r_55
    ? new THREE.CylinderGeometry(endpoint_thigh_r_55.endRadius, endpoint_thigh_r_55.baseRadius, endpoint_thigh_r_55.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_thigh_r_55) {
    mesh_thigh_r_55Geometry.scale(0.10709, 0.5016, 0.10709);
  }
  const mesh_thigh_r_55 = new THREE.Mesh(
    mesh_thigh_r_55Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_thigh_r_55.name = "Thigh core R";
  if (endpoint_thigh_r_55) {
    mesh_thigh_r_55.position.copy(endpoint_thigh_r_55.midpoint);
    mesh_thigh_r_55.quaternion.copy(endpoint_thigh_r_55.quaternion);
  }
  mesh_thigh_r_55.castShadow = options.castShadow ?? true;
  mesh_thigh_r_55.receiveShadow = options.receiveShadow ?? true;
  mesh_thigh_r_55.userData.sculptComponent = { id: "thigh-r" };
  node_thigh_r_55.add(mesh_thigh_r_55);
  meshes["thigh-r"] = mesh_thigh_r_55;
  colliders["thigh-r"] = {};
  destructionGroups["leg-r"] ??= [];
  destructionGroups["leg-r"].push(node_thigh_r_55);

  const endpoint_thigh_plate_front_r_56 = makeAttachmentEndpoint(null);
  const node_thigh_plate_front_r_56 = new THREE.Group();
  node_thigh_plate_front_r_56.name = "Thigh front plate R__pivot";
  node_thigh_plate_front_r_56.scale.set(1, 1, 1);
  if (endpoint_thigh_plate_front_r_56) {
    node_thigh_plate_front_r_56.position.copy(endpoint_thigh_plate_front_r_56.start);
    node_thigh_plate_front_r_56.rotation.set(0.0, -0.0, 0.0);
  } else {
    node_thigh_plate_front_r_56.position.set(-0.00096, -0.0189, 0.06929);
    node_thigh_plate_front_r_56.rotation.set(0.0, -0.0, 0.0);
  }
  node_thigh_plate_front_r_56.userData.sculptComponent = { id: "thigh-plate-front-r" };
  node_thigh_plate_front_r_56.userData.actionProfile = {};
  (nodes["thigh-r"] ?? root).add(node_thigh_plate_front_r_56);
  nodes["thigh-plate-front-r"] = node_thigh_plate_front_r_56;
  const mesh_thigh_plate_front_r_56Geometry = endpoint_thigh_plate_front_r_56
    ? new THREE.CylinderGeometry(endpoint_thigh_plate_front_r_56.endRadius, endpoint_thigh_plate_front_r_56.baseRadius, endpoint_thigh_plate_front_r_56.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.01814, "rz": 0.01361, "twist": 0.0}, {"position": [-0.00501, -0.09827, 0.0], "rx": 0.02452, "rz": 0.04762, "twist": 0.0}, {"position": [-0.01377, -0.27024, 0.0], "rx": 0.02835, "rz": 0.06803, "twist": 0.0}, {"position": [-0.02128, -0.41764, 0.0], "rx": 0.02516, "rz": 0.05102, "twist": 0.0}, {"position": [-0.02503, -0.49134, 0.0], "rx": 0.01814, "rz": 0.01361, "twist": 0.0}], "radialSegments": 18, "capEnds": true});
  if (!endpoint_thigh_plate_front_r_56) {
    mesh_thigh_plate_front_r_56Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_thigh_plate_front_r_56 = new THREE.Mesh(
    mesh_thigh_plate_front_r_56Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_thigh_plate_front_r_56.name = "Thigh front plate R";
  if (endpoint_thigh_plate_front_r_56) {
    mesh_thigh_plate_front_r_56.position.copy(endpoint_thigh_plate_front_r_56.midpoint);
    mesh_thigh_plate_front_r_56.quaternion.copy(endpoint_thigh_plate_front_r_56.quaternion);
  }
  mesh_thigh_plate_front_r_56.castShadow = options.castShadow ?? true;
  mesh_thigh_plate_front_r_56.receiveShadow = options.receiveShadow ?? true;
  mesh_thigh_plate_front_r_56.userData.sculptComponent = { id: "thigh-plate-front-r" };
  node_thigh_plate_front_r_56.add(mesh_thigh_plate_front_r_56);
  meshes["thigh-plate-front-r"] = mesh_thigh_plate_front_r_56;
  colliders["thigh-plate-front-r"] = {};
  destructionGroups["leg-r"] ??= [];
  destructionGroups["leg-r"].push(node_thigh_plate_front_r_56);

  const endpoint_thigh_plate_outer_r_57 = makeAttachmentEndpoint(null);
  const node_thigh_plate_outer_r_57 = new THREE.Group();
  node_thigh_plate_outer_r_57.name = "Thigh outer plate R__pivot";
  node_thigh_plate_outer_r_57.scale.set(1, 1, 1);
  if (endpoint_thigh_plate_outer_r_57) {
    node_thigh_plate_outer_r_57.position.copy(endpoint_thigh_plate_outer_r_57.start);
    node_thigh_plate_outer_r_57.rotation.set(0.0, -1.01229, 0.0);
  } else {
    node_thigh_plate_outer_r_57.position.set(-0.06678, 0.0, 0.04173);
    node_thigh_plate_outer_r_57.rotation.set(0.0, -1.01229, 0.0);
  }
  node_thigh_plate_outer_r_57.userData.sculptComponent = { id: "thigh-plate-outer-r" };
  node_thigh_plate_outer_r_57.userData.actionProfile = {};
  (nodes["thigh-r"] ?? root).add(node_thigh_plate_outer_r_57);
  nodes["thigh-plate-outer-r"] = node_thigh_plate_outer_r_57;
  const mesh_thigh_plate_outer_r_57Geometry = endpoint_thigh_plate_outer_r_57
    ? new THREE.CylinderGeometry(endpoint_thigh_plate_outer_r_57.endRadius, endpoint_thigh_plate_outer_r_57.baseRadius, endpoint_thigh_plate_outer_r_57.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.01613, "rz": 0.0102, "twist": 0.0}, {"position": [-0.00269, -0.09953, 0.0043], "rx": 0.0218, "rz": 0.03572, "twist": 0.0}, {"position": [-0.00739, -0.2737, 0.01182], "rx": 0.0252, "rz": 0.05102, "twist": 0.0}, {"position": [-0.01142, -0.42299, 0.01827], "rx": 0.02236, "rz": 0.03827, "twist": 0.0}, {"position": [-0.01343, -0.49764, 0.0215], "rx": 0.01613, "rz": 0.0102, "twist": 0.0}], "radialSegments": 18, "capEnds": true});
  if (!endpoint_thigh_plate_outer_r_57) {
    mesh_thigh_plate_outer_r_57Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_thigh_plate_outer_r_57 = new THREE.Mesh(
    mesh_thigh_plate_outer_r_57Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_thigh_plate_outer_r_57.name = "Thigh outer plate R";
  if (endpoint_thigh_plate_outer_r_57) {
    mesh_thigh_plate_outer_r_57.position.copy(endpoint_thigh_plate_outer_r_57.midpoint);
    mesh_thigh_plate_outer_r_57.quaternion.copy(endpoint_thigh_plate_outer_r_57.quaternion);
  }
  mesh_thigh_plate_outer_r_57.castShadow = options.castShadow ?? true;
  mesh_thigh_plate_outer_r_57.receiveShadow = options.receiveShadow ?? true;
  mesh_thigh_plate_outer_r_57.userData.sculptComponent = { id: "thigh-plate-outer-r" };
  node_thigh_plate_outer_r_57.add(mesh_thigh_plate_outer_r_57);
  meshes["thigh-plate-outer-r"] = mesh_thigh_plate_outer_r_57;
  colliders["thigh-plate-outer-r"] = {};
  destructionGroups["leg-r"] ??= [];
  destructionGroups["leg-r"].push(node_thigh_plate_outer_r_57);

  const endpoint_thigh_plate_inner_r_58 = makeAttachmentEndpoint(null);
  const node_thigh_plate_inner_r_58 = new THREE.Group();
  node_thigh_plate_inner_r_58.name = "Thigh inner plate R__pivot";
  node_thigh_plate_inner_r_58.scale.set(1, 1, 1);
  if (endpoint_thigh_plate_inner_r_58) {
    node_thigh_plate_inner_r_58.position.copy(endpoint_thigh_plate_inner_r_58.start);
    node_thigh_plate_inner_r_58.rotation.set(0.0, 0.83776, 0.0);
  } else {
    node_thigh_plate_inner_r_58.position.set(0.04691, -0.04409, 0.04426);
    node_thigh_plate_inner_r_58.rotation.set(0.0, 0.83776, 0.0);
  }
  node_thigh_plate_inner_r_58.userData.sculptComponent = { id: "thigh-plate-inner-r" };
  node_thigh_plate_inner_r_58.userData.actionProfile = {};
  (nodes["thigh-r"] ?? root).add(node_thigh_plate_inner_r_58);
  nodes["thigh-plate-inner-r"] = node_thigh_plate_inner_r_58;
  const mesh_thigh_plate_inner_r_58Geometry = endpoint_thigh_plate_inner_r_58
    ? new THREE.CylinderGeometry(endpoint_thigh_plate_inner_r_58.endRadius, endpoint_thigh_plate_inner_r_58.baseRadius, endpoint_thigh_plate_inner_r_58.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.01613, "rz": 0.00737, "twist": 0.0}, {"position": [-0.00258, -0.07559, -0.00286], "rx": 0.0218, "rz": 0.0258, "twist": 0.0}, {"position": [-0.00709, -0.20787, -0.00787], "rx": 0.0252, "rz": 0.03685, "twist": 0.0}, {"position": [-0.01095, -0.32126, -0.01216], "rx": 0.02236, "rz": 0.02764, "twist": 0.0}, {"position": [-0.01288, -0.37795, -0.01431], "rx": 0.01613, "rz": 0.00737, "twist": 0.0}], "radialSegments": 18, "capEnds": true});
  if (!endpoint_thigh_plate_inner_r_58) {
    mesh_thigh_plate_inner_r_58Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_thigh_plate_inner_r_58 = new THREE.Mesh(
    mesh_thigh_plate_inner_r_58Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_thigh_plate_inner_r_58.name = "Thigh inner plate R";
  if (endpoint_thigh_plate_inner_r_58) {
    mesh_thigh_plate_inner_r_58.position.copy(endpoint_thigh_plate_inner_r_58.midpoint);
    mesh_thigh_plate_inner_r_58.quaternion.copy(endpoint_thigh_plate_inner_r_58.quaternion);
  }
  mesh_thigh_plate_inner_r_58.castShadow = options.castShadow ?? true;
  mesh_thigh_plate_inner_r_58.receiveShadow = options.receiveShadow ?? true;
  mesh_thigh_plate_inner_r_58.userData.sculptComponent = { id: "thigh-plate-inner-r" };
  node_thigh_plate_inner_r_58.add(mesh_thigh_plate_inner_r_58);
  meshes["thigh-plate-inner-r"] = mesh_thigh_plate_inner_r_58;
  colliders["thigh-plate-inner-r"] = {};
  destructionGroups["leg-r"] ??= [];
  destructionGroups["leg-r"].push(node_thigh_plate_inner_r_58);

  const endpoint_thigh_plate_back_r_59 = makeAttachmentEndpoint(null);
  const node_thigh_plate_back_r_59 = new THREE.Group();
  node_thigh_plate_back_r_59.name = "Thigh back plate R__pivot";
  node_thigh_plate_back_r_59.scale.set(1, 1, 1);
  if (endpoint_thigh_plate_back_r_59) {
    node_thigh_plate_back_r_59.position.copy(endpoint_thigh_plate_back_r_59.start);
    node_thigh_plate_back_r_59.rotation.set(0.0, -3.14159, 0.0);
  } else {
    node_thigh_plate_back_r_59.position.set(-0.00096, -0.0189, -0.06929);
    node_thigh_plate_back_r_59.rotation.set(0.0, -3.14159, 0.0);
  }
  node_thigh_plate_back_r_59.userData.sculptComponent = { id: "thigh-plate-back-r" };
  node_thigh_plate_back_r_59.userData.actionProfile = {};
  (nodes["thigh-r"] ?? root).add(node_thigh_plate_back_r_59);
  nodes["thigh-plate-back-r"] = node_thigh_plate_back_r_59;
  const mesh_thigh_plate_back_r_59Geometry = endpoint_thigh_plate_back_r_59
    ? new THREE.CylinderGeometry(endpoint_thigh_plate_back_r_59.endRadius, endpoint_thigh_plate_back_r_59.baseRadius, endpoint_thigh_plate_back_r_59.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, -0.0], "rx": 0.01814, "rz": 0.01247, "twist": 0.0}, {"position": [0.00488, -0.09575, 0.0], "rx": 0.02452, "rz": 0.04365, "twist": 0.0}, {"position": [0.01341, -0.26331, 0.0], "rx": 0.02835, "rz": 0.06236, "twist": 0.0}, {"position": [0.02073, -0.40693, 0.0], "rx": 0.02516, "rz": 0.04677, "twist": 0.0}, {"position": [0.02439, -0.47874, 0.0], "rx": 0.01814, "rz": 0.01247, "twist": 0.0}], "radialSegments": 18, "capEnds": true});
  if (!endpoint_thigh_plate_back_r_59) {
    mesh_thigh_plate_back_r_59Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_thigh_plate_back_r_59 = new THREE.Mesh(
    mesh_thigh_plate_back_r_59Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_thigh_plate_back_r_59.name = "Thigh back plate R";
  if (endpoint_thigh_plate_back_r_59) {
    mesh_thigh_plate_back_r_59.position.copy(endpoint_thigh_plate_back_r_59.midpoint);
    mesh_thigh_plate_back_r_59.quaternion.copy(endpoint_thigh_plate_back_r_59.quaternion);
  }
  mesh_thigh_plate_back_r_59.castShadow = options.castShadow ?? true;
  mesh_thigh_plate_back_r_59.receiveShadow = options.receiveShadow ?? true;
  mesh_thigh_plate_back_r_59.userData.sculptComponent = { id: "thigh-plate-back-r" };
  node_thigh_plate_back_r_59.add(mesh_thigh_plate_back_r_59);
  meshes["thigh-plate-back-r"] = mesh_thigh_plate_back_r_59;
  colliders["thigh-plate-back-r"] = {};
  destructionGroups["leg-r"] ??= [];
  destructionGroups["leg-r"].push(node_thigh_plate_back_r_59);

  const endpoint_thigh_plate_backout_r_60 = makeAttachmentEndpoint(null);
  const node_thigh_plate_backout_r_60 = new THREE.Group();
  node_thigh_plate_backout_r_60.name = "Thigh backout plate R__pivot";
  node_thigh_plate_backout_r_60.scale.set(1, 1, 1);
  if (endpoint_thigh_plate_backout_r_60) {
    node_thigh_plate_backout_r_60.position.copy(endpoint_thigh_plate_backout_r_60.start);
    node_thigh_plate_backout_r_60.rotation.set(0.0, -2.18166, 0.0);
  } else {
    node_thigh_plate_backout_r_60.position.set(-0.06159, -0.04409, -0.04155);
    node_thigh_plate_backout_r_60.rotation.set(0.0, -2.18166, 0.0);
  }
  node_thigh_plate_backout_r_60.userData.sculptComponent = { id: "thigh-plate-backout-r" };
  node_thigh_plate_backout_r_60.userData.actionProfile = {};
  (nodes["thigh-r"] ?? root).add(node_thigh_plate_backout_r_60);
  nodes["thigh-plate-backout-r"] = node_thigh_plate_backout_r_60;
  const mesh_thigh_plate_backout_r_60Geometry = endpoint_thigh_plate_backout_r_60
    ? new THREE.CylinderGeometry(endpoint_thigh_plate_backout_r_60.endRadius, endpoint_thigh_plate_backout_r_60.baseRadius, endpoint_thigh_plate_backout_r_60.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, -0.0], "rx": 0.01613, "rz": 0.00907, "twist": 0.0}, {"position": [0.00239, -0.08189, 0.00342], "rx": 0.0218, "rz": 0.03175, "twist": 0.0}, {"position": [0.00658, -0.2252, 0.0094], "rx": 0.0252, "rz": 0.04535, "twist": 0.0}, {"position": [0.01017, -0.34803, 0.01452], "rx": 0.02236, "rz": 0.03402, "twist": 0.0}, {"position": [0.01196, -0.40945, 0.01709], "rx": 0.01613, "rz": 0.00907, "twist": 0.0}], "radialSegments": 18, "capEnds": true});
  if (!endpoint_thigh_plate_backout_r_60) {
    mesh_thigh_plate_backout_r_60Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_thigh_plate_backout_r_60 = new THREE.Mesh(
    mesh_thigh_plate_backout_r_60Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_thigh_plate_backout_r_60.name = "Thigh backout plate R";
  if (endpoint_thigh_plate_backout_r_60) {
    mesh_thigh_plate_backout_r_60.position.copy(endpoint_thigh_plate_backout_r_60.midpoint);
    mesh_thigh_plate_backout_r_60.quaternion.copy(endpoint_thigh_plate_backout_r_60.quaternion);
  }
  mesh_thigh_plate_backout_r_60.castShadow = options.castShadow ?? true;
  mesh_thigh_plate_backout_r_60.receiveShadow = options.receiveShadow ?? true;
  mesh_thigh_plate_backout_r_60.userData.sculptComponent = { id: "thigh-plate-backout-r" };
  node_thigh_plate_backout_r_60.add(mesh_thigh_plate_backout_r_60);
  meshes["thigh-plate-backout-r"] = mesh_thigh_plate_backout_r_60;
  colliders["thigh-plate-backout-r"] = {};
  destructionGroups["leg-r"] ??= [];
  destructionGroups["leg-r"].push(node_thigh_plate_backout_r_60);

  const endpoint_knee_r_61 = makeAttachmentEndpoint(null);
  const node_knee_r_61 = new THREE.Group();
  node_knee_r_61.name = "Knee joint R__pivot";
  node_knee_r_61.scale.set(1, 1, 1);
  if (endpoint_knee_r_61) {
    node_knee_r_61.position.copy(endpoint_knee_r_61.start);
    node_knee_r_61.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_knee_r_61.position.set(-0.02551, -0.50394, 0.0189);
    node_knee_r_61.rotation.set(0.0, 0.0, 0.0);
  }
  node_knee_r_61.userData.sculptComponent = { id: "knee-r" };
  node_knee_r_61.userData.actionProfile = {};
  (nodes["thigh-r"] ?? root).add(node_knee_r_61);
  nodes["knee-r"] = node_knee_r_61;
  const mesh_knee_r_61Geometry = endpoint_knee_r_61
    ? new THREE.CylinderGeometry(endpoint_knee_r_61.endRadius, endpoint_knee_r_61.baseRadius, endpoint_knee_r_61.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_knee_r_61) {
    mesh_knee_r_61Geometry.scale(0.10709, 0.10709, 0.10709);
  }
  const mesh_knee_r_61 = new THREE.Mesh(
    mesh_knee_r_61Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_knee_r_61.name = "Knee joint R";
  if (endpoint_knee_r_61) {
    mesh_knee_r_61.position.copy(endpoint_knee_r_61.midpoint);
    mesh_knee_r_61.quaternion.copy(endpoint_knee_r_61.quaternion);
  }
  mesh_knee_r_61.castShadow = options.castShadow ?? true;
  mesh_knee_r_61.receiveShadow = options.receiveShadow ?? true;
  mesh_knee_r_61.userData.sculptComponent = { id: "knee-r" };
  node_knee_r_61.add(mesh_knee_r_61);
  meshes["knee-r"] = mesh_knee_r_61;
  colliders["knee-r"] = {};
  destructionGroups["leg-r"] ??= [];
  destructionGroups["leg-r"].push(node_knee_r_61);

  const endpoint_knee_glow_r_62 = makeAttachmentEndpoint(null);
  const node_knee_glow_r_62 = new THREE.Group();
  node_knee_glow_r_62.name = "Knee glow R__pivot";
  node_knee_glow_r_62.scale.set(1, 1, 1);
  if (endpoint_knee_glow_r_62) {
    node_knee_glow_r_62.position.copy(endpoint_knee_glow_r_62.start);
    node_knee_glow_r_62.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_knee_glow_r_62.position.set(-0.02551, -0.61102, 0.06929);
    node_knee_glow_r_62.rotation.set(0.0, 0.0, 0.0);
  }
  node_knee_glow_r_62.userData.sculptComponent = { id: "knee-glow-r" };
  node_knee_glow_r_62.userData.actionProfile = {};
  (nodes["thigh-r"] ?? root).add(node_knee_glow_r_62);
  nodes["knee-glow-r"] = node_knee_glow_r_62;
  const mesh_knee_glow_r_62Geometry = endpoint_knee_glow_r_62
    ? new THREE.CylinderGeometry(endpoint_knee_glow_r_62.endRadius, endpoint_knee_glow_r_62.baseRadius, endpoint_knee_glow_r_62.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_knee_glow_r_62) {
    mesh_knee_glow_r_62Geometry.scale(0.08819, 0.02835, 0.02205);
  }
  const mesh_knee_glow_r_62 = new THREE.Mesh(
    mesh_knee_glow_r_62Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_knee_glow_r_62.name = "Knee glow R";
  if (endpoint_knee_glow_r_62) {
    mesh_knee_glow_r_62.position.copy(endpoint_knee_glow_r_62.midpoint);
    mesh_knee_glow_r_62.quaternion.copy(endpoint_knee_glow_r_62.quaternion);
  }
  mesh_knee_glow_r_62.castShadow = options.castShadow ?? true;
  mesh_knee_glow_r_62.receiveShadow = options.receiveShadow ?? true;
  mesh_knee_glow_r_62.userData.sculptComponent = { id: "knee-glow-r" };
  node_knee_glow_r_62.add(mesh_knee_glow_r_62);
  meshes["knee-glow-r"] = mesh_knee_glow_r_62;
  colliders["knee-glow-r"] = {};
  destructionGroups["leg-r"] ??= [];
  destructionGroups["leg-r"].push(node_knee_glow_r_62);

  const endpoint_hip_glow_r_63 = makeAttachmentEndpoint(null);
  const node_hip_glow_r_63 = new THREE.Group();
  node_hip_glow_r_63.name = "Hip glow R__pivot";
  node_hip_glow_r_63.scale.set(1, 1, 1);
  if (endpoint_hip_glow_r_63) {
    node_hip_glow_r_63.position.copy(endpoint_hip_glow_r_63.start);
    node_hip_glow_r_63.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hip_glow_r_63.position.set(-0.09071, 0.08819, 0.09449);
    node_hip_glow_r_63.rotation.set(0.0, 0.0, 0.0);
  }
  node_hip_glow_r_63.userData.sculptComponent = { id: "hip-glow-r" };
  node_hip_glow_r_63.userData.actionProfile = {};
  (nodes["pelvis"] ?? root).add(node_hip_glow_r_63);
  nodes["hip-glow-r"] = node_hip_glow_r_63;
  const mesh_hip_glow_r_63Geometry = endpoint_hip_glow_r_63
    ? new THREE.CylinderGeometry(endpoint_hip_glow_r_63.endRadius, endpoint_hip_glow_r_63.baseRadius, endpoint_hip_glow_r_63.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_hip_glow_r_63) {
    mesh_hip_glow_r_63Geometry.scale(0.04409, 0.02835, 0.0189);
  }
  const mesh_hip_glow_r_63 = new THREE.Mesh(
    mesh_hip_glow_r_63Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hip_glow_r_63.name = "Hip glow R";
  if (endpoint_hip_glow_r_63) {
    mesh_hip_glow_r_63.position.copy(endpoint_hip_glow_r_63.midpoint);
    mesh_hip_glow_r_63.quaternion.copy(endpoint_hip_glow_r_63.quaternion);
  }
  mesh_hip_glow_r_63.castShadow = options.castShadow ?? true;
  mesh_hip_glow_r_63.receiveShadow = options.receiveShadow ?? true;
  mesh_hip_glow_r_63.userData.sculptComponent = { id: "hip-glow-r" };
  node_hip_glow_r_63.add(mesh_hip_glow_r_63);
  meshes["hip-glow-r"] = mesh_hip_glow_r_63;
  colliders["hip-glow-r"] = {};
  destructionGroups["leg-r"] ??= [];
  destructionGroups["leg-r"].push(node_hip_glow_r_63);

  const attachment_shin_r_64 = {"parentSocket": "thigh-r-shin-r", "localStart": [-0.02551, -0.50394, 0.0189], "localEnd": [-0.09354, -0.91339, 0.0063], "contactType": "hinge-joint", "baseRadius": 0.04409, "endRadius": 0.03465, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_shin_r_64 = makeAttachmentEndpoint(attachment_shin_r_64);
  const node_shin_r_64 = new THREE.Group();
  node_shin_r_64.name = "Shin core R__pivot";
  node_shin_r_64.scale.set(1, 1, 1);
  if (endpoint_shin_r_64) {
    node_shin_r_64.position.copy(endpoint_shin_r_64.start);
    node_shin_r_64.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_shin_r_64.position.set(-0.02551, -0.50394, 0.0189);
    node_shin_r_64.rotation.set(0.0, 0.0, 0.0);
  }
  node_shin_r_64.userData.sculptComponent = { id: "shin-r" };
  node_shin_r_64.userData.actionProfile = {};
  (nodes["thigh-r"] ?? root).add(node_shin_r_64);
  nodes["shin-r"] = node_shin_r_64;
  const mesh_shin_r_64Geometry = endpoint_shin_r_64
    ? new THREE.CylinderGeometry(endpoint_shin_r_64.endRadius, endpoint_shin_r_64.baseRadius, endpoint_shin_r_64.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_shin_r_64) {
    mesh_shin_r_64Geometry.scale(0.08819, 0.41525, 0.08819);
  }
  const mesh_shin_r_64 = new THREE.Mesh(
    mesh_shin_r_64Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_shin_r_64.name = "Shin core R";
  if (endpoint_shin_r_64) {
    mesh_shin_r_64.position.copy(endpoint_shin_r_64.midpoint);
    mesh_shin_r_64.quaternion.copy(endpoint_shin_r_64.quaternion);
  }
  mesh_shin_r_64.castShadow = options.castShadow ?? true;
  mesh_shin_r_64.receiveShadow = options.receiveShadow ?? true;
  mesh_shin_r_64.userData.sculptComponent = { id: "shin-r" };
  node_shin_r_64.add(mesh_shin_r_64);
  meshes["shin-r"] = mesh_shin_r_64;
  colliders["shin-r"] = {};
  destructionGroups["leg-r"] ??= [];
  destructionGroups["leg-r"].push(node_shin_r_64);

  const endpoint_shin_plate_front_r_65 = makeAttachmentEndpoint(null);
  const node_shin_plate_front_r_65 = new THREE.Group();
  node_shin_plate_front_r_65.name = "Shin front plate R__pivot";
  node_shin_plate_front_r_65.scale.set(1, 1, 1);
  if (endpoint_shin_plate_front_r_65) {
    node_shin_plate_front_r_65.position.copy(endpoint_shin_plate_front_r_65.start);
    node_shin_plate_front_r_65.rotation.set(0.0, -0.0, 0.0);
  } else {
    node_shin_plate_front_r_65.position.set(-0.00209, -0.0126, 0.04094);
    node_shin_plate_front_r_65.rotation.set(0.0, -0.0, 0.0);
  }
  node_shin_plate_front_r_65.userData.sculptComponent = { id: "shin-plate-front-r" };
  node_shin_plate_front_r_65.userData.actionProfile = {};
  (nodes["shin-r"] ?? root).add(node_shin_plate_front_r_65);
  nodes["shin-plate-front-r"] = node_shin_plate_front_r_65;
  const mesh_shin_plate_front_r_65Geometry = endpoint_shin_plate_front_r_65
    ? new THREE.CylinderGeometry(endpoint_shin_plate_front_r_65.endRadius, endpoint_shin_plate_front_r_65.baseRadius, endpoint_shin_plate_front_r_65.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.01814, "rz": 0.01361, "twist": 0.0}, {"position": [-0.01591, -0.09575, 0.0], "rx": 0.02452, "rz": 0.04762, "twist": 0.0}, {"position": [-0.04375, -0.26331, 0.0], "rx": 0.02835, "rz": 0.06803, "twist": 0.0}, {"position": [-0.06761, -0.40693, 0.0], "rx": 0.02516, "rz": 0.05102, "twist": 0.0}, {"position": [-0.07954, -0.47874, 0.0], "rx": 0.01814, "rz": 0.01361, "twist": 0.0}], "radialSegments": 18, "capEnds": true});
  if (!endpoint_shin_plate_front_r_65) {
    mesh_shin_plate_front_r_65Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_shin_plate_front_r_65 = new THREE.Mesh(
    mesh_shin_plate_front_r_65Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_shin_plate_front_r_65.name = "Shin front plate R";
  if (endpoint_shin_plate_front_r_65) {
    mesh_shin_plate_front_r_65.position.copy(endpoint_shin_plate_front_r_65.midpoint);
    mesh_shin_plate_front_r_65.quaternion.copy(endpoint_shin_plate_front_r_65.quaternion);
  }
  mesh_shin_plate_front_r_65.castShadow = options.castShadow ?? true;
  mesh_shin_plate_front_r_65.receiveShadow = options.receiveShadow ?? true;
  mesh_shin_plate_front_r_65.userData.sculptComponent = { id: "shin-plate-front-r" };
  node_shin_plate_front_r_65.add(mesh_shin_plate_front_r_65);
  meshes["shin-plate-front-r"] = mesh_shin_plate_front_r_65;
  colliders["shin-plate-front-r"] = {};
  destructionGroups["leg-r"] ??= [];
  destructionGroups["leg-r"].push(node_shin_plate_front_r_65);

  const endpoint_shin_plate_outer_r_66 = makeAttachmentEndpoint(null);
  const node_shin_plate_outer_r_66 = new THREE.Group();
  node_shin_plate_outer_r_66.name = "Shin outer plate R__pivot";
  node_shin_plate_outer_r_66.scale.set(1, 1, 1);
  if (endpoint_shin_plate_outer_r_66) {
    node_shin_plate_outer_r_66.position.copy(endpoint_shin_plate_outer_r_66.start);
    node_shin_plate_outer_r_66.rotation.set(0.0, -1.0472, 0.0);
  } else {
    node_shin_plate_outer_r_66.position.set(-0.06924, -0.0063, 0.02047);
    node_shin_plate_outer_r_66.rotation.set(0.0, -1.0472, 0.0);
  }
  node_shin_plate_outer_r_66.userData.sculptComponent = { id: "shin-plate-outer-r" };
  node_shin_plate_outer_r_66.userData.actionProfile = {};
  (nodes["shin-r"] ?? root).add(node_shin_plate_outer_r_66);
  nodes["shin-plate-outer-r"] = node_shin_plate_outer_r_66;
  const mesh_shin_plate_outer_r_66Geometry = endpoint_shin_plate_outer_r_66
    ? new THREE.CylinderGeometry(endpoint_shin_plate_outer_r_66.endRadius, endpoint_shin_plate_outer_r_66.baseRadius, endpoint_shin_plate_outer_r_66.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.01613, "rz": 0.0102, "twist": 0.0}, {"position": [-0.0067, -0.08063, 0.0116], "rx": 0.0218, "rz": 0.03572, "twist": 0.0}, {"position": [-0.01842, -0.22173, 0.03191], "rx": 0.0252, "rz": 0.05102, "twist": 0.0}, {"position": [-0.02847, -0.34268, 0.04931], "rx": 0.02236, "rz": 0.03827, "twist": 0.0}, {"position": [-0.03349, -0.40315, 0.05801], "rx": 0.01613, "rz": 0.0102, "twist": 0.0}], "radialSegments": 18, "capEnds": true});
  if (!endpoint_shin_plate_outer_r_66) {
    mesh_shin_plate_outer_r_66Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_shin_plate_outer_r_66 = new THREE.Mesh(
    mesh_shin_plate_outer_r_66Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_shin_plate_outer_r_66.name = "Shin outer plate R";
  if (endpoint_shin_plate_outer_r_66) {
    mesh_shin_plate_outer_r_66.position.copy(endpoint_shin_plate_outer_r_66.midpoint);
    mesh_shin_plate_outer_r_66.quaternion.copy(endpoint_shin_plate_outer_r_66.quaternion);
  }
  mesh_shin_plate_outer_r_66.castShadow = options.castShadow ?? true;
  mesh_shin_plate_outer_r_66.receiveShadow = options.receiveShadow ?? true;
  mesh_shin_plate_outer_r_66.userData.sculptComponent = { id: "shin-plate-outer-r" };
  node_shin_plate_outer_r_66.add(mesh_shin_plate_outer_r_66);
  meshes["shin-plate-outer-r"] = mesh_shin_plate_outer_r_66;
  colliders["shin-plate-outer-r"] = {};
  destructionGroups["leg-r"] ??= [];
  destructionGroups["leg-r"].push(node_shin_plate_outer_r_66);

  const endpoint_shin_plate_inner_r_67 = makeAttachmentEndpoint(null);
  const node_shin_plate_inner_r_67 = new THREE.Group();
  node_shin_plate_inner_r_67.name = "Shin inner plate R__pivot";
  node_shin_plate_inner_r_67.scale.set(1, 1, 1);
  if (endpoint_shin_plate_inner_r_67) {
    node_shin_plate_inner_r_67.position.copy(endpoint_shin_plate_inner_r_67.start);
    node_shin_plate_inner_r_67.rotation.set(0.0, 0.87266, 0.0);
  } else {
    node_shin_plate_inner_r_67.position.set(0.03433, -0.06929, 0.01957);
    node_shin_plate_inner_r_67.rotation.set(0.0, 0.87266, 0.0);
  }
  node_shin_plate_inner_r_67.userData.sculptComponent = { id: "shin-plate-inner-r" };
  node_shin_plate_inner_r_67.userData.actionProfile = {};
  (nodes["shin-r"] ?? root).add(node_shin_plate_inner_r_67);
  nodes["shin-plate-inner-r"] = node_shin_plate_inner_r_67;
  const mesh_shin_plate_inner_r_67Geometry = endpoint_shin_plate_inner_r_67
    ? new THREE.CylinderGeometry(endpoint_shin_plate_inner_r_67.endRadius, endpoint_shin_plate_inner_r_67.baseRadius, endpoint_shin_plate_inner_r_67.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.01411, "rz": 0.0068, "twist": 0.0}, {"position": [-0.00632, -0.05921, -0.00754], "rx": 0.01907, "rz": 0.02381, "twist": 0.0}, {"position": [-0.01739, -0.16283, -0.02073], "rx": 0.02205, "rz": 0.03402, "twist": 0.0}, {"position": [-0.02688, -0.25165, -0.03203], "rx": 0.01957, "rz": 0.02551, "twist": 0.0}, {"position": [-0.03162, -0.29606, -0.03768], "rx": 0.01411, "rz": 0.0068, "twist": 0.0}], "radialSegments": 18, "capEnds": true});
  if (!endpoint_shin_plate_inner_r_67) {
    mesh_shin_plate_inner_r_67Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_shin_plate_inner_r_67 = new THREE.Mesh(
    mesh_shin_plate_inner_r_67Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_shin_plate_inner_r_67.name = "Shin inner plate R";
  if (endpoint_shin_plate_inner_r_67) {
    mesh_shin_plate_inner_r_67.position.copy(endpoint_shin_plate_inner_r_67.midpoint);
    mesh_shin_plate_inner_r_67.quaternion.copy(endpoint_shin_plate_inner_r_67.quaternion);
  }
  mesh_shin_plate_inner_r_67.castShadow = options.castShadow ?? true;
  mesh_shin_plate_inner_r_67.receiveShadow = options.receiveShadow ?? true;
  mesh_shin_plate_inner_r_67.userData.sculptComponent = { id: "shin-plate-inner-r" };
  node_shin_plate_inner_r_67.add(mesh_shin_plate_inner_r_67);
  meshes["shin-plate-inner-r"] = mesh_shin_plate_inner_r_67;
  colliders["shin-plate-inner-r"] = {};
  destructionGroups["leg-r"] ??= [];
  destructionGroups["leg-r"].push(node_shin_plate_inner_r_67);

  const endpoint_shin_plate_back_r_68 = makeAttachmentEndpoint(null);
  const node_shin_plate_back_r_68 = new THREE.Group();
  node_shin_plate_back_r_68.name = "Shin back plate R__pivot";
  node_shin_plate_back_r_68.scale.set(1, 1, 1);
  if (endpoint_shin_plate_back_r_68) {
    node_shin_plate_back_r_68.position.copy(endpoint_shin_plate_back_r_68.start);
    node_shin_plate_back_r_68.rotation.set(0.0, -3.14159, 0.0);
  } else {
    node_shin_plate_back_r_68.position.set(-0.00419, -0.0252, -0.07874);
    node_shin_plate_back_r_68.rotation.set(0.0, -3.14159, 0.0);
  }
  node_shin_plate_back_r_68.userData.sculptComponent = { id: "shin-plate-back-r" };
  node_shin_plate_back_r_68.userData.actionProfile = {};
  (nodes["shin-r"] ?? root).add(node_shin_plate_back_r_68);
  nodes["shin-plate-back-r"] = node_shin_plate_back_r_68;
  const mesh_shin_plate_back_r_68Geometry = endpoint_shin_plate_back_r_68
    ? new THREE.CylinderGeometry(endpoint_shin_plate_back_r_68.endRadius, endpoint_shin_plate_back_r_68.baseRadius, endpoint_shin_plate_back_r_68.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, -0.0], "rx": 0.01814, "rz": 0.01247, "twist": 0.0}, {"position": [0.01507, -0.09071, 0.0], "rx": 0.02452, "rz": 0.04365, "twist": 0.0}, {"position": [0.04145, -0.24945, 0.0], "rx": 0.02835, "rz": 0.06236, "twist": 0.0}, {"position": [0.06405, -0.38551, 0.0], "rx": 0.02516, "rz": 0.04677, "twist": 0.0}, {"position": [0.07536, -0.45354, 0.0], "rx": 0.01814, "rz": 0.01247, "twist": 0.0}], "radialSegments": 18, "capEnds": true});
  if (!endpoint_shin_plate_back_r_68) {
    mesh_shin_plate_back_r_68Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_shin_plate_back_r_68 = new THREE.Mesh(
    mesh_shin_plate_back_r_68Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_shin_plate_back_r_68.name = "Shin back plate R";
  if (endpoint_shin_plate_back_r_68) {
    mesh_shin_plate_back_r_68.position.copy(endpoint_shin_plate_back_r_68.midpoint);
    mesh_shin_plate_back_r_68.quaternion.copy(endpoint_shin_plate_back_r_68.quaternion);
  }
  mesh_shin_plate_back_r_68.castShadow = options.castShadow ?? true;
  mesh_shin_plate_back_r_68.receiveShadow = options.receiveShadow ?? true;
  mesh_shin_plate_back_r_68.userData.sculptComponent = { id: "shin-plate-back-r" };
  node_shin_plate_back_r_68.add(mesh_shin_plate_back_r_68);
  meshes["shin-plate-back-r"] = mesh_shin_plate_back_r_68;
  colliders["shin-plate-back-r"] = {};
  destructionGroups["leg-r"] ??= [];
  destructionGroups["leg-r"].push(node_shin_plate_back_r_68);

  const endpoint_shin_spur_r_69 = makeAttachmentEndpoint(null);
  const node_shin_spur_r_69 = new THREE.Group();
  node_shin_spur_r_69.name = "Shin spur R__pivot";
  node_shin_spur_r_69.scale.set(1, 1, 1);
  if (endpoint_shin_spur_r_69) {
    node_shin_spur_r_69.position.copy(endpoint_shin_spur_r_69.start);
    node_shin_spur_r_69.rotation.set(0.0, -0.0, 0.0);
  } else {
    node_shin_spur_r_69.position.set(-0.06803, -0.18898, 0.0);
    node_shin_spur_r_69.rotation.set(0.0, -0.0, 0.0);
  }
  node_shin_spur_r_69.userData.sculptComponent = { id: "shin-spur-r" };
  node_shin_spur_r_69.userData.actionProfile = {};
  (nodes["shin-r"] ?? root).add(node_shin_spur_r_69);
  nodes["shin-spur-r"] = node_shin_spur_r_69;
  const mesh_shin_spur_r_69Geometry = endpoint_shin_spur_r_69
    ? new THREE.CylinderGeometry(endpoint_shin_spur_r_69.endRadius, endpoint_shin_spur_r_69.baseRadius, endpoint_shin_spur_r_69.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.0189, "rz": 0.02205, "twist": 0.0}, {"position": [-0.02268, 0.08189, -0.00315], "rx": 0.01417, "rz": 0.01575, "twist": 0.0}, {"position": [-0.04535, 0.18268, -0.0063], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 14, "capEnds": true});
  if (!endpoint_shin_spur_r_69) {
    mesh_shin_spur_r_69Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_shin_spur_r_69 = new THREE.Mesh(
    mesh_shin_spur_r_69Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_shin_spur_r_69.name = "Shin spur R";
  if (endpoint_shin_spur_r_69) {
    mesh_shin_spur_r_69.position.copy(endpoint_shin_spur_r_69.midpoint);
    mesh_shin_spur_r_69.quaternion.copy(endpoint_shin_spur_r_69.quaternion);
  }
  mesh_shin_spur_r_69.castShadow = options.castShadow ?? true;
  mesh_shin_spur_r_69.receiveShadow = options.receiveShadow ?? true;
  mesh_shin_spur_r_69.userData.sculptComponent = { id: "shin-spur-r" };
  node_shin_spur_r_69.add(mesh_shin_spur_r_69);
  meshes["shin-spur-r"] = mesh_shin_spur_r_69;
  colliders["shin-spur-r"] = {};
  destructionGroups["leg-r"] ??= [];
  destructionGroups["leg-r"].push(node_shin_spur_r_69);

  const endpoint_ankle_r_70 = makeAttachmentEndpoint(null);
  const node_ankle_r_70 = new THREE.Group();
  node_ankle_r_70.name = "Ankle joint R__pivot";
  node_ankle_r_70.scale.set(1, 1, 1);
  if (endpoint_ankle_r_70) {
    node_ankle_r_70.position.copy(endpoint_ankle_r_70.start);
    node_ankle_r_70.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_ankle_r_70.position.set(-0.06803, -0.40945, -0.0126);
    node_ankle_r_70.rotation.set(0.0, 0.0, 0.0);
  }
  node_ankle_r_70.userData.sculptComponent = { id: "ankle-r" };
  node_ankle_r_70.userData.actionProfile = {};
  (nodes["shin-r"] ?? root).add(node_ankle_r_70);
  nodes["ankle-r"] = node_ankle_r_70;
  const mesh_ankle_r_70Geometry = endpoint_ankle_r_70
    ? new THREE.CylinderGeometry(endpoint_ankle_r_70.endRadius, endpoint_ankle_r_70.baseRadius, endpoint_ankle_r_70.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_ankle_r_70) {
    mesh_ankle_r_70Geometry.scale(0.08189, 0.08189, 0.08189);
  }
  const mesh_ankle_r_70 = new THREE.Mesh(
    mesh_ankle_r_70Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ankle_r_70.name = "Ankle joint R";
  if (endpoint_ankle_r_70) {
    mesh_ankle_r_70.position.copy(endpoint_ankle_r_70.midpoint);
    mesh_ankle_r_70.quaternion.copy(endpoint_ankle_r_70.quaternion);
  }
  mesh_ankle_r_70.castShadow = options.castShadow ?? true;
  mesh_ankle_r_70.receiveShadow = options.receiveShadow ?? true;
  mesh_ankle_r_70.userData.sculptComponent = { id: "ankle-r" };
  node_ankle_r_70.add(mesh_ankle_r_70);
  meshes["ankle-r"] = mesh_ankle_r_70;
  colliders["ankle-r"] = {};
  destructionGroups["leg-r"] ??= [];
  destructionGroups["leg-r"].push(node_ankle_r_70);

  const endpoint_boot_r_71 = makeAttachmentEndpoint(null);
  const node_boot_r_71 = new THREE.Group();
  node_boot_r_71.name = "Boot R__pivot";
  node_boot_r_71.scale.set(1, 1, 1);
  if (endpoint_boot_r_71) {
    node_boot_r_71.position.copy(endpoint_boot_r_71.start);
    node_boot_r_71.rotation.set(0.0, -0.3, 0.0);
  } else {
    node_boot_r_71.position.set(-0.09638, -0.56063, -0.11339);
    node_boot_r_71.rotation.set(0.0, -0.3, 0.0);
  }
  node_boot_r_71.userData.sculptComponent = { id: "boot-r" };
  node_boot_r_71.userData.actionProfile = {};
  (nodes["shin-r"] ?? root).add(node_boot_r_71);
  nodes["boot-r"] = node_boot_r_71;
  const mesh_boot_r_71Geometry = endpoint_boot_r_71
    ? new THREE.CylinderGeometry(endpoint_boot_r_71.endRadius, endpoint_boot_r_71.baseRadius, endpoint_boot_r_71.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.06299, "rz": 0.04724, "twist": 0.0}, {"position": [0.0, -0.0063, 0.07874], "rx": 0.08819, "rz": 0.05669, "twist": 0.0}, {"position": [0.0, -0.0126, 0.17323], "rx": 0.08819, "rz": 0.04094, "twist": 0.0}, {"position": [0.0, -0.0315, 0.25827], "rx": 0.06299, "rz": 0.0252, "twist": 0.0}, {"position": [0.0, -0.0378, 0.30236], "rx": 0.0315, "rz": 0.0126, "twist": 0.0}], "radialSegments": 20, "capEnds": true});
  if (!endpoint_boot_r_71) {
    mesh_boot_r_71Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_boot_r_71 = new THREE.Mesh(
    mesh_boot_r_71Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_boot_r_71.name = "Boot R";
  if (endpoint_boot_r_71) {
    mesh_boot_r_71.position.copy(endpoint_boot_r_71.midpoint);
    mesh_boot_r_71.quaternion.copy(endpoint_boot_r_71.quaternion);
  }
  mesh_boot_r_71.castShadow = options.castShadow ?? true;
  mesh_boot_r_71.receiveShadow = options.receiveShadow ?? true;
  mesh_boot_r_71.userData.sculptComponent = { id: "boot-r" };
  node_boot_r_71.add(mesh_boot_r_71);
  meshes["boot-r"] = mesh_boot_r_71;
  colliders["boot-r"] = {};
  destructionGroups["leg-r"] ??= [];
  destructionGroups["leg-r"].push(node_boot_r_71);

  const endpoint_boot_shaft_r_72 = makeAttachmentEndpoint(null);
  const node_boot_shaft_r_72 = new THREE.Group();
  node_boot_shaft_r_72.name = "Boot shaft R__pivot";
  node_boot_shaft_r_72.scale.set(1, 1, 1);
  if (endpoint_boot_shaft_r_72) {
    node_boot_shaft_r_72.position.copy(endpoint_boot_shaft_r_72.start);
    node_boot_shaft_r_72.rotation.set(0.0, -0.0, 0.0);
  } else {
    node_boot_shaft_r_72.position.set(-0.08504, -0.40945, -0.0063);
    node_boot_shaft_r_72.rotation.set(0.0, -0.0, 0.0);
  }
  node_boot_shaft_r_72.userData.sculptComponent = { id: "boot-shaft-r" };
  node_boot_shaft_r_72.userData.actionProfile = {};
  (nodes["shin-r"] ?? root).add(node_boot_shaft_r_72);
  nodes["boot-shaft-r"] = node_boot_shaft_r_72;
  const mesh_boot_shaft_r_72Geometry = endpoint_boot_shaft_r_72
    ? new THREE.CylinderGeometry(endpoint_boot_shaft_r_72.endRadius, endpoint_boot_shaft_r_72.baseRadius, endpoint_boot_shaft_r_72.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.0252, "rz": 0.0315, "twist": 0.0}, {"position": [-0.00567, -0.07559, 0.0063], "rx": 0.04724, "rz": 0.08189, "twist": 0.0}, {"position": [-0.01134, -0.15748, 0.0063], "rx": 0.0252, "rz": 0.0252, "twist": 0.0}], "radialSegments": 18, "capEnds": true});
  if (!endpoint_boot_shaft_r_72) {
    mesh_boot_shaft_r_72Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_boot_shaft_r_72 = new THREE.Mesh(
    mesh_boot_shaft_r_72Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_boot_shaft_r_72.name = "Boot shaft R";
  if (endpoint_boot_shaft_r_72) {
    mesh_boot_shaft_r_72.position.copy(endpoint_boot_shaft_r_72.midpoint);
    mesh_boot_shaft_r_72.quaternion.copy(endpoint_boot_shaft_r_72.quaternion);
  }
  mesh_boot_shaft_r_72.castShadow = options.castShadow ?? true;
  mesh_boot_shaft_r_72.receiveShadow = options.receiveShadow ?? true;
  mesh_boot_shaft_r_72.userData.sculptComponent = { id: "boot-shaft-r" };
  node_boot_shaft_r_72.add(mesh_boot_shaft_r_72);
  meshes["boot-shaft-r"] = mesh_boot_shaft_r_72;
  colliders["boot-shaft-r"] = {};
  destructionGroups["leg-r"] ??= [];
  destructionGroups["leg-r"].push(node_boot_shaft_r_72);

  const endpoint_boot_sole_r_73 = makeAttachmentEndpoint(null);
  const node_boot_sole_r_73 = new THREE.Group();
  node_boot_sole_r_73.name = "Boot sole R__pivot";
  node_boot_sole_r_73.scale.set(1, 1, 1);
  if (endpoint_boot_sole_r_73) {
    node_boot_sole_r_73.position.copy(endpoint_boot_sole_r_73.start);
    node_boot_sole_r_73.rotation.set(0.0, -0.3, 0.0);
  } else {
    node_boot_sole_r_73.position.set(-0.09638, -0.60945, 0.0315);
    node_boot_sole_r_73.rotation.set(0.0, -0.3, 0.0);
  }
  node_boot_sole_r_73.userData.sculptComponent = { id: "boot-sole-r" };
  node_boot_sole_r_73.userData.actionProfile = {};
  (nodes["shin-r"] ?? root).add(node_boot_sole_r_73);
  nodes["boot-sole-r"] = node_boot_sole_r_73;
  const mesh_boot_sole_r_73Geometry = endpoint_boot_sole_r_73
    ? new THREE.CylinderGeometry(endpoint_boot_sole_r_73.endRadius, endpoint_boot_sole_r_73.baseRadius, endpoint_boot_sole_r_73.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_boot_sole_r_73) {
    mesh_boot_sole_r_73Geometry.scale(0.13858, 0.01575, 0.30236);
  }
  const mesh_boot_sole_r_73 = new THREE.Mesh(
    mesh_boot_sole_r_73Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_boot_sole_r_73.name = "Boot sole R";
  if (endpoint_boot_sole_r_73) {
    mesh_boot_sole_r_73.position.copy(endpoint_boot_sole_r_73.midpoint);
    mesh_boot_sole_r_73.quaternion.copy(endpoint_boot_sole_r_73.quaternion);
  }
  mesh_boot_sole_r_73.castShadow = options.castShadow ?? true;
  mesh_boot_sole_r_73.receiveShadow = options.receiveShadow ?? true;
  mesh_boot_sole_r_73.userData.sculptComponent = { id: "boot-sole-r" };
  node_boot_sole_r_73.add(mesh_boot_sole_r_73);
  meshes["boot-sole-r"] = mesh_boot_sole_r_73;
  colliders["boot-sole-r"] = {};
  destructionGroups["leg-r"] ??= [];
  destructionGroups["leg-r"].push(node_boot_sole_r_73);

  const endpoint_seam_thigh_r_74 = makeAttachmentEndpoint(null);
  const node_seam_thigh_r_74 = new THREE.Group();
  node_seam_thigh_r_74.name = "Gold seam seam-thigh-r__pivot";
  node_seam_thigh_r_74.scale.set(1, 1, 1);
  if (endpoint_seam_thigh_r_74) {
    node_seam_thigh_r_74.position.copy(endpoint_seam_thigh_r_74.start);
    node_seam_thigh_r_74.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seam_thigh_r_74.position.set(0.0, 0.0, 0.0);
    node_seam_thigh_r_74.rotation.set(0.0, 0.0, 0.0);
  }
  node_seam_thigh_r_74.userData.sculptComponent = { id: "seam-thigh-r" };
  node_seam_thigh_r_74.userData.actionProfile = {};
  (nodes["thigh-plate-front-r"] ?? root).add(node_seam_thigh_r_74);
  nodes["seam-thigh-r"] = node_seam_thigh_r_74;
  const mesh_seam_thigh_r_74Geometry = endpoint_seam_thigh_r_74
    ? new THREE.CylinderGeometry(endpoint_seam_thigh_r_74.endRadius, endpoint_seam_thigh_r_74.baseRadius, endpoint_seam_thigh_r_74.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0132, -0.0, 0.01669], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [0.04119, -0.09827, 0.02256], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [0.05222, -0.27024, 0.02608], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [0.02822, -0.41764, 0.02314], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [-0.01183, -0.49134, 0.01669], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_seam_thigh_r_74) {
    mesh_seam_thigh_r_74Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seam_thigh_r_74 = new THREE.Mesh(
    mesh_seam_thigh_r_74Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seam_thigh_r_74.name = "Gold seam seam-thigh-r";
  if (endpoint_seam_thigh_r_74) {
    mesh_seam_thigh_r_74.position.copy(endpoint_seam_thigh_r_74.midpoint);
    mesh_seam_thigh_r_74.quaternion.copy(endpoint_seam_thigh_r_74.quaternion);
  }
  mesh_seam_thigh_r_74.castShadow = options.castShadow ?? true;
  mesh_seam_thigh_r_74.receiveShadow = options.receiveShadow ?? true;
  mesh_seam_thigh_r_74.userData.sculptComponent = { id: "seam-thigh-r" };
  node_seam_thigh_r_74.add(mesh_seam_thigh_r_74);
  meshes["seam-thigh-r"] = mesh_seam_thigh_r_74;
  colliders["seam-thigh-r"] = {};
  destructionGroups["thigh-plate-front-r"] ??= [];
  destructionGroups["thigh-plate-front-r"].push(node_seam_thigh_r_74);

  const endpoint_seam_thigh_out_r_75 = makeAttachmentEndpoint(null);
  const node_seam_thigh_out_r_75 = new THREE.Group();
  node_seam_thigh_out_r_75.name = "Gold seam seam-thigh-out-r__pivot";
  node_seam_thigh_out_r_75.scale.set(1, 1, 1);
  if (endpoint_seam_thigh_out_r_75) {
    node_seam_thigh_out_r_75.position.copy(endpoint_seam_thigh_out_r_75.start);
    node_seam_thigh_out_r_75.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seam_thigh_out_r_75.position.set(0.0, 0.0, 0.0);
    node_seam_thigh_out_r_75.rotation.set(0.0, 0.0, 0.0);
  }
  node_seam_thigh_out_r_75.userData.sculptComponent = { id: "seam-thigh-out-r" };
  node_seam_thigh_out_r_75.userData.actionProfile = {};
  (nodes["thigh-plate-front-r"] ?? root).add(node_seam_thigh_out_r_75);
  nodes["seam-thigh-out-r"] = node_seam_thigh_out_r_75;
  const mesh_seam_thigh_out_r_75Geometry = endpoint_seam_thigh_out_r_75
    ? new THREE.CylinderGeometry(endpoint_seam_thigh_out_r_75.endRadius, endpoint_seam_thigh_out_r_75.baseRadius, endpoint_seam_thigh_out_r_75.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.0132, -0.0, 0.01669], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [-0.0512, -0.09827, 0.02256], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [-0.07976, -0.27024, 0.02608], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [-0.07077, -0.41764, 0.02314], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [-0.03823, -0.49134, 0.01669], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_seam_thigh_out_r_75) {
    mesh_seam_thigh_out_r_75Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seam_thigh_out_r_75 = new THREE.Mesh(
    mesh_seam_thigh_out_r_75Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seam_thigh_out_r_75.name = "Gold seam seam-thigh-out-r";
  if (endpoint_seam_thigh_out_r_75) {
    mesh_seam_thigh_out_r_75.position.copy(endpoint_seam_thigh_out_r_75.midpoint);
    mesh_seam_thigh_out_r_75.quaternion.copy(endpoint_seam_thigh_out_r_75.quaternion);
  }
  mesh_seam_thigh_out_r_75.castShadow = options.castShadow ?? true;
  mesh_seam_thigh_out_r_75.receiveShadow = options.receiveShadow ?? true;
  mesh_seam_thigh_out_r_75.userData.sculptComponent = { id: "seam-thigh-out-r" };
  node_seam_thigh_out_r_75.add(mesh_seam_thigh_out_r_75);
  meshes["seam-thigh-out-r"] = mesh_seam_thigh_out_r_75;
  colliders["seam-thigh-out-r"] = {};
  destructionGroups["thigh-plate-front-r"] ??= [];
  destructionGroups["thigh-plate-front-r"].push(node_seam_thigh_out_r_75);

  const endpoint_seam_shin_r_76 = makeAttachmentEndpoint(null);
  const node_seam_shin_r_76 = new THREE.Group();
  node_seam_shin_r_76.name = "Gold seam seam-shin-r__pivot";
  node_seam_shin_r_76.scale.set(1, 1, 1);
  if (endpoint_seam_shin_r_76) {
    node_seam_shin_r_76.position.copy(endpoint_seam_shin_r_76.start);
    node_seam_shin_r_76.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seam_shin_r_76.position.set(0.0, 0.0, 0.0);
    node_seam_shin_r_76.rotation.set(0.0, 0.0, 0.0);
  }
  node_seam_shin_r_76.userData.sculptComponent = { id: "seam-shin-r" };
  node_seam_shin_r_76.userData.actionProfile = {};
  (nodes["shin-plate-front-r"] ?? root).add(node_seam_shin_r_76);
  nodes["seam-shin-r"] = node_seam_shin_r_76;
  const mesh_seam_shin_r_76Geometry = endpoint_seam_shin_r_76
    ? new THREE.CylinderGeometry(endpoint_seam_shin_r_76.endRadius, endpoint_seam_shin_r_76.baseRadius, endpoint_seam_shin_r_76.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.0132, -0.0, 0.01669], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [-0.0621, -0.09575, 0.02256], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [-0.10974, -0.26331, 0.02608], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [-0.11711, -0.40693, 0.02314], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [-0.09274, -0.47874, 0.01669], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_seam_shin_r_76) {
    mesh_seam_shin_r_76Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seam_shin_r_76 = new THREE.Mesh(
    mesh_seam_shin_r_76Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seam_shin_r_76.name = "Gold seam seam-shin-r";
  if (endpoint_seam_shin_r_76) {
    mesh_seam_shin_r_76.position.copy(endpoint_seam_shin_r_76.midpoint);
    mesh_seam_shin_r_76.quaternion.copy(endpoint_seam_shin_r_76.quaternion);
  }
  mesh_seam_shin_r_76.castShadow = options.castShadow ?? true;
  mesh_seam_shin_r_76.receiveShadow = options.receiveShadow ?? true;
  mesh_seam_shin_r_76.userData.sculptComponent = { id: "seam-shin-r" };
  node_seam_shin_r_76.add(mesh_seam_shin_r_76);
  meshes["seam-shin-r"] = mesh_seam_shin_r_76;
  colliders["seam-shin-r"] = {};
  destructionGroups["shin-plate-front-r"] ??= [];
  destructionGroups["shin-plate-front-r"].push(node_seam_shin_r_76);

  const endpoint_seam_boot_r_77 = makeAttachmentEndpoint(null);
  const node_seam_boot_r_77 = new THREE.Group();
  node_seam_boot_r_77.name = "Gold seam seam-boot-r__pivot";
  node_seam_boot_r_77.scale.set(1, 1, 1);
  if (endpoint_seam_boot_r_77) {
    node_seam_boot_r_77.position.copy(endpoint_seam_boot_r_77.start);
    node_seam_boot_r_77.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seam_boot_r_77.position.set(0.0, 0.0, 0.0);
    node_seam_boot_r_77.rotation.set(0.0, 0.0, 0.0);
  }
  node_seam_boot_r_77.userData.sculptComponent = { id: "seam-boot-r" };
  node_seam_boot_r_77.userData.actionProfile = {};
  (nodes["boot-r"] ?? root).add(node_seam_boot_r_77);
  nodes["seam-boot-r"] = node_seam_boot_r_77;
  const mesh_seam_boot_r_77Geometry = endpoint_seam_boot_r_77
    ? new THREE.CylinderGeometry(endpoint_seam_boot_r_77.endRadius, endpoint_seam_boot_r_77.baseRadius, endpoint_seam_boot_r_77.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.0611, 0.01654, 0.0], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [-0.08554, 0.01354, 0.07874], "rx": 0.00567, "rz": 0.00567, "twist": 0.0}, {"position": [-0.08554, 0.00173, 0.17323], "rx": 0.00567, "rz": 0.00567, "twist": 0.0}, {"position": [-0.0611, -0.02268, 0.25827], "rx": 0.00567, "rz": 0.00567, "twist": 0.0}, {"position": [-0.03055, -0.03339, 0.30236], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_seam_boot_r_77) {
    mesh_seam_boot_r_77Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seam_boot_r_77 = new THREE.Mesh(
    mesh_seam_boot_r_77Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seam_boot_r_77.name = "Gold seam seam-boot-r";
  if (endpoint_seam_boot_r_77) {
    mesh_seam_boot_r_77.position.copy(endpoint_seam_boot_r_77.midpoint);
    mesh_seam_boot_r_77.quaternion.copy(endpoint_seam_boot_r_77.quaternion);
  }
  mesh_seam_boot_r_77.castShadow = options.castShadow ?? true;
  mesh_seam_boot_r_77.receiveShadow = options.receiveShadow ?? true;
  mesh_seam_boot_r_77.userData.sculptComponent = { id: "seam-boot-r" };
  node_seam_boot_r_77.add(mesh_seam_boot_r_77);
  meshes["seam-boot-r"] = mesh_seam_boot_r_77;
  colliders["seam-boot-r"] = {};
  destructionGroups["boot-r"] ??= [];
  destructionGroups["boot-r"].push(node_seam_boot_r_77);

  const endpoint_shoulder_joint_l_78 = makeAttachmentEndpoint(null);
  const node_shoulder_joint_l_78 = new THREE.Group();
  node_shoulder_joint_l_78.name = "Shoulder joint L__pivot";
  node_shoulder_joint_l_78.scale.set(1, 1, 1);
  if (endpoint_shoulder_joint_l_78) {
    node_shoulder_joint_l_78.position.copy(endpoint_shoulder_joint_l_78.start);
    node_shoulder_joint_l_78.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_shoulder_joint_l_78.position.set(0.18709, 0.22677, -0.0063);
    node_shoulder_joint_l_78.rotation.set(0.0, 0.0, 0.0);
  }
  node_shoulder_joint_l_78.userData.sculptComponent = { id: "shoulder-joint-l" };
  node_shoulder_joint_l_78.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_shoulder_joint_l_78);
  nodes["shoulder-joint-l"] = node_shoulder_joint_l_78;
  const mesh_shoulder_joint_l_78Geometry = endpoint_shoulder_joint_l_78
    ? new THREE.CylinderGeometry(endpoint_shoulder_joint_l_78.endRadius, endpoint_shoulder_joint_l_78.baseRadius, endpoint_shoulder_joint_l_78.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_shoulder_joint_l_78) {
    mesh_shoulder_joint_l_78Geometry.scale(0.10079, 0.10079, 0.10079);
  }
  const mesh_shoulder_joint_l_78 = new THREE.Mesh(
    mesh_shoulder_joint_l_78Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_shoulder_joint_l_78.name = "Shoulder joint L";
  if (endpoint_shoulder_joint_l_78) {
    mesh_shoulder_joint_l_78.position.copy(endpoint_shoulder_joint_l_78.midpoint);
    mesh_shoulder_joint_l_78.quaternion.copy(endpoint_shoulder_joint_l_78.quaternion);
  }
  mesh_shoulder_joint_l_78.castShadow = options.castShadow ?? true;
  mesh_shoulder_joint_l_78.receiveShadow = options.receiveShadow ?? true;
  mesh_shoulder_joint_l_78.userData.sculptComponent = { id: "shoulder-joint-l" };
  node_shoulder_joint_l_78.add(mesh_shoulder_joint_l_78);
  meshes["shoulder-joint-l"] = mesh_shoulder_joint_l_78;
  colliders["shoulder-joint-l"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_shoulder_joint_l_78);

  const endpoint_pauldron_l_79 = makeAttachmentEndpoint(null);
  const node_pauldron_l_79 = new THREE.Group();
  node_pauldron_l_79.name = "Pauldron L__pivot";
  node_pauldron_l_79.scale.set(1, 1, 1);
  if (endpoint_pauldron_l_79) {
    node_pauldron_l_79.position.copy(endpoint_pauldron_l_79.start);
    node_pauldron_l_79.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_pauldron_l_79.position.set(0.22677, 0.34016, 0.0126);
    node_pauldron_l_79.rotation.set(0.0, 0.0, 0.0);
  }
  node_pauldron_l_79.userData.sculptComponent = { id: "pauldron-l" };
  node_pauldron_l_79.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_pauldron_l_79);
  nodes["pauldron-l"] = node_pauldron_l_79;
  const mesh_pauldron_l_79Geometry = endpoint_pauldron_l_79
    ? new THREE.CylinderGeometry(endpoint_pauldron_l_79.endRadius, endpoint_pauldron_l_79.baseRadius, endpoint_pauldron_l_79.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.03465, "rz": 0.02835, "twist": 0.0}, {"position": [0.03969, -0.07559, 0.0063], "rx": 0.05984, "rz": 0.05039, "twist": 0.0}, {"position": [0.06236, -0.15748, 0.0063], "rx": 0.07244, "rz": 0.06299, "twist": 0.0}, {"position": [0.05102, -0.23307, 0.0], "rx": 0.05984, "rz": 0.05039, "twist": 0.0}, {"position": [0.03402, -0.28346, -0.0063], "rx": 0.0252, "rz": 0.0189, "twist": 0.0}], "radialSegments": 22, "capEnds": true});
  if (!endpoint_pauldron_l_79) {
    mesh_pauldron_l_79Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_pauldron_l_79 = new THREE.Mesh(
    mesh_pauldron_l_79Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pauldron_l_79.name = "Pauldron L";
  if (endpoint_pauldron_l_79) {
    mesh_pauldron_l_79.position.copy(endpoint_pauldron_l_79.midpoint);
    mesh_pauldron_l_79.quaternion.copy(endpoint_pauldron_l_79.quaternion);
  }
  mesh_pauldron_l_79.castShadow = options.castShadow ?? true;
  mesh_pauldron_l_79.receiveShadow = options.receiveShadow ?? true;
  mesh_pauldron_l_79.userData.sculptComponent = { id: "pauldron-l" };
  node_pauldron_l_79.add(mesh_pauldron_l_79);
  meshes["pauldron-l"] = mesh_pauldron_l_79;
  colliders["pauldron-l"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_pauldron_l_79);

  const endpoint_pauldron_top_l_80 = makeAttachmentEndpoint(null);
  const node_pauldron_top_l_80 = new THREE.Group();
  node_pauldron_top_l_80.name = "Pauldron top petal L__pivot";
  node_pauldron_top_l_80.scale.set(1, 1, 1);
  if (endpoint_pauldron_top_l_80) {
    node_pauldron_top_l_80.position.copy(endpoint_pauldron_top_l_80.start);
    node_pauldron_top_l_80.rotation.set(0.0, 0.5, 0.0);
  } else {
    node_pauldron_top_l_80.position.set(0.2211, 0.34646, 0.0252);
    node_pauldron_top_l_80.rotation.set(0.0, 0.5, 0.0);
  }
  node_pauldron_top_l_80.userData.sculptComponent = { id: "pauldron-top-l" };
  node_pauldron_top_l_80.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_pauldron_top_l_80);
  nodes["pauldron-top-l"] = node_pauldron_top_l_80;
  const mesh_pauldron_top_l_80Geometry = endpoint_pauldron_top_l_80
    ? new THREE.CylinderGeometry(endpoint_pauldron_top_l_80.endRadius, endpoint_pauldron_top_l_80.baseRadius, endpoint_pauldron_top_l_80.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.0189, "rz": 0.01575, "twist": 0.0}, {"position": [0.02268, -0.06299, 0.0126], "rx": 0.04724, "rz": 0.04094, "twist": 0.0}, {"position": [0.03969, -0.13228, 0.0063], "rx": 0.01575, "rz": 0.0126, "twist": 0.0}], "radialSegments": 18, "capEnds": true});
  if (!endpoint_pauldron_top_l_80) {
    mesh_pauldron_top_l_80Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_pauldron_top_l_80 = new THREE.Mesh(
    mesh_pauldron_top_l_80Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pauldron_top_l_80.name = "Pauldron top petal L";
  if (endpoint_pauldron_top_l_80) {
    mesh_pauldron_top_l_80.position.copy(endpoint_pauldron_top_l_80.midpoint);
    mesh_pauldron_top_l_80.quaternion.copy(endpoint_pauldron_top_l_80.quaternion);
  }
  mesh_pauldron_top_l_80.castShadow = options.castShadow ?? true;
  mesh_pauldron_top_l_80.receiveShadow = options.receiveShadow ?? true;
  mesh_pauldron_top_l_80.userData.sculptComponent = { id: "pauldron-top-l" };
  node_pauldron_top_l_80.add(mesh_pauldron_top_l_80);
  meshes["pauldron-top-l"] = mesh_pauldron_top_l_80;
  colliders["pauldron-top-l"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_pauldron_top_l_80);

  const endpoint_pauldron_low_l_81 = makeAttachmentEndpoint(null);
  const node_pauldron_low_l_81 = new THREE.Group();
  node_pauldron_low_l_81.name = "Pauldron lower petal L__pivot";
  node_pauldron_low_l_81.scale.set(1, 1, 1);
  if (endpoint_pauldron_low_l_81) {
    node_pauldron_low_l_81.position.copy(endpoint_pauldron_low_l_81.start);
    node_pauldron_low_l_81.rotation.set(0.0, 0.4, 0.0);
  } else {
    node_pauldron_low_l_81.position.set(0.2778, 0.15118, 0.0126);
    node_pauldron_low_l_81.rotation.set(0.0, 0.4, 0.0);
  }
  node_pauldron_low_l_81.userData.sculptComponent = { id: "pauldron-low-l" };
  node_pauldron_low_l_81.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_pauldron_low_l_81);
  nodes["pauldron-low-l"] = node_pauldron_low_l_81;
  const mesh_pauldron_low_l_81Geometry = endpoint_pauldron_low_l_81
    ? new THREE.CylinderGeometry(endpoint_pauldron_low_l_81.endRadius, endpoint_pauldron_low_l_81.baseRadius, endpoint_pauldron_low_l_81.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.03465, "rz": 0.0252, "twist": 0.0}, {"position": [0.01701, -0.06929, 0.0126], "rx": 0.04724, "rz": 0.04094, "twist": 0.0}, {"position": [0.00567, -0.13858, 0.0063], "rx": 0.0252, "rz": 0.01575, "twist": 0.0}], "radialSegments": 18, "capEnds": true});
  if (!endpoint_pauldron_low_l_81) {
    mesh_pauldron_low_l_81Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_pauldron_low_l_81 = new THREE.Mesh(
    mesh_pauldron_low_l_81Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pauldron_low_l_81.name = "Pauldron lower petal L";
  if (endpoint_pauldron_low_l_81) {
    mesh_pauldron_low_l_81.position.copy(endpoint_pauldron_low_l_81.midpoint);
    mesh_pauldron_low_l_81.quaternion.copy(endpoint_pauldron_low_l_81.quaternion);
  }
  mesh_pauldron_low_l_81.castShadow = options.castShadow ?? true;
  mesh_pauldron_low_l_81.receiveShadow = options.receiveShadow ?? true;
  mesh_pauldron_low_l_81.userData.sculptComponent = { id: "pauldron-low-l" };
  node_pauldron_low_l_81.add(mesh_pauldron_low_l_81);
  meshes["pauldron-low-l"] = mesh_pauldron_low_l_81;
  colliders["pauldron-low-l"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_pauldron_low_l_81);

  const endpoint_pauldron_glow_l_82 = makeAttachmentEndpoint(null);
  const node_pauldron_glow_l_82 = new THREE.Group();
  node_pauldron_glow_l_82.name = "Pauldron glow L__pivot";
  node_pauldron_glow_l_82.scale.set(1, 1, 1);
  if (endpoint_pauldron_glow_l_82) {
    node_pauldron_glow_l_82.position.copy(endpoint_pauldron_glow_l_82.start);
    node_pauldron_glow_l_82.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_pauldron_glow_l_82.position.set(0.28346, 0.08819, 0.06299);
    node_pauldron_glow_l_82.rotation.set(0.0, 0.0, 0.0);
  }
  node_pauldron_glow_l_82.userData.sculptComponent = { id: "pauldron-glow-l" };
  node_pauldron_glow_l_82.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_pauldron_glow_l_82);
  nodes["pauldron-glow-l"] = node_pauldron_glow_l_82;
  const mesh_pauldron_glow_l_82Geometry = endpoint_pauldron_glow_l_82
    ? new THREE.CylinderGeometry(endpoint_pauldron_glow_l_82.endRadius, endpoint_pauldron_glow_l_82.baseRadius, endpoint_pauldron_glow_l_82.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_pauldron_glow_l_82) {
    mesh_pauldron_glow_l_82Geometry.scale(0.0252, 0.05039, 0.01575);
  }
  const mesh_pauldron_glow_l_82 = new THREE.Mesh(
    mesh_pauldron_glow_l_82Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pauldron_glow_l_82.name = "Pauldron glow L";
  if (endpoint_pauldron_glow_l_82) {
    mesh_pauldron_glow_l_82.position.copy(endpoint_pauldron_glow_l_82.midpoint);
    mesh_pauldron_glow_l_82.quaternion.copy(endpoint_pauldron_glow_l_82.quaternion);
  }
  mesh_pauldron_glow_l_82.castShadow = options.castShadow ?? true;
  mesh_pauldron_glow_l_82.receiveShadow = options.receiveShadow ?? true;
  mesh_pauldron_glow_l_82.userData.sculptComponent = { id: "pauldron-glow-l" };
  node_pauldron_glow_l_82.add(mesh_pauldron_glow_l_82);
  meshes["pauldron-glow-l"] = mesh_pauldron_glow_l_82;
  colliders["pauldron-glow-l"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_pauldron_glow_l_82);

  const attachment_upper_arm_l_83 = {"parentSocket": "chest-upper-arm-l", "localStart": [0.18709, 0.22677, -0.0063], "localEnd": [0.35276, 0.08819, 0.05669], "contactType": "socket-joint", "baseRadius": 0.0378, "endRadius": 0.0315, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_upper_arm_l_83 = makeAttachmentEndpoint(attachment_upper_arm_l_83);
  const node_upper_arm_l_83 = new THREE.Group();
  node_upper_arm_l_83.name = "Upper arm core L__pivot";
  node_upper_arm_l_83.scale.set(1, 1, 1);
  if (endpoint_upper_arm_l_83) {
    node_upper_arm_l_83.position.copy(endpoint_upper_arm_l_83.start);
    node_upper_arm_l_83.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_upper_arm_l_83.position.set(0.18709, 0.22677, -0.0063);
    node_upper_arm_l_83.rotation.set(0.0, 0.0, 0.0);
  }
  node_upper_arm_l_83.userData.sculptComponent = { id: "upper-arm-l" };
  node_upper_arm_l_83.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_upper_arm_l_83);
  nodes["upper-arm-l"] = node_upper_arm_l_83;
  const mesh_upper_arm_l_83Geometry = endpoint_upper_arm_l_83
    ? new THREE.CylinderGeometry(endpoint_upper_arm_l_83.endRadius, endpoint_upper_arm_l_83.baseRadius, endpoint_upper_arm_l_83.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_upper_arm_l_83) {
    mesh_upper_arm_l_83Geometry.scale(0.07559, 0.22499, 0.07559);
  }
  const mesh_upper_arm_l_83 = new THREE.Mesh(
    mesh_upper_arm_l_83Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_upper_arm_l_83.name = "Upper arm core L";
  if (endpoint_upper_arm_l_83) {
    mesh_upper_arm_l_83.position.copy(endpoint_upper_arm_l_83.midpoint);
    mesh_upper_arm_l_83.quaternion.copy(endpoint_upper_arm_l_83.quaternion);
  }
  mesh_upper_arm_l_83.castShadow = options.castShadow ?? true;
  mesh_upper_arm_l_83.receiveShadow = options.receiveShadow ?? true;
  mesh_upper_arm_l_83.userData.sculptComponent = { id: "upper-arm-l" };
  node_upper_arm_l_83.add(mesh_upper_arm_l_83);
  meshes["upper-arm-l"] = mesh_upper_arm_l_83;
  colliders["upper-arm-l"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_upper_arm_l_83);

  const endpoint_upper_arm_shell_l_84 = makeAttachmentEndpoint(null);
  const node_upper_arm_shell_l_84 = new THREE.Group();
  node_upper_arm_shell_l_84.name = "Bicep shell L__pivot";
  node_upper_arm_shell_l_84.scale.set(1, 1, 1);
  if (endpoint_upper_arm_shell_l_84) {
    node_upper_arm_shell_l_84.position.copy(endpoint_upper_arm_shell_l_84.start);
    node_upper_arm_shell_l_84.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_upper_arm_shell_l_84.position.set(0.0, 0.0, 0.0);
    node_upper_arm_shell_l_84.rotation.set(0.0, 0.0, 0.0);
  }
  node_upper_arm_shell_l_84.userData.sculptComponent = { id: "upper-arm-shell-l" };
  node_upper_arm_shell_l_84.userData.actionProfile = {};
  (nodes["upper-arm-l"] ?? root).add(node_upper_arm_shell_l_84);
  nodes["upper-arm-shell-l"] = node_upper_arm_shell_l_84;
  const mesh_upper_arm_shell_l_84Geometry = endpoint_upper_arm_shell_l_84
    ? new THREE.CylinderGeometry(endpoint_upper_arm_shell_l_84.endRadius, endpoint_upper_arm_shell_l_84.baseRadius, endpoint_upper_arm_shell_l_84.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.02041, "rz": 0.01071, "twist": 0.0}, {"position": [0.04142, -0.03465, 0.01575], "rx": 0.04535, "rz": 0.04016, "twist": 0.0}, {"position": [0.08283, -0.06929, 0.0315], "rx": 0.05669, "rz": 0.05354, "twist": 0.0}, {"position": [0.12425, -0.10394, 0.04724], "rx": 0.04762, "rz": 0.04283, "twist": 0.0}, {"position": [0.16567, -0.13858, 0.06299], "rx": 0.02041, "rz": 0.01071, "twist": 0.0}], "radialSegments": 16, "capEnds": true});
  if (!endpoint_upper_arm_shell_l_84) {
    mesh_upper_arm_shell_l_84Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_upper_arm_shell_l_84 = new THREE.Mesh(
    mesh_upper_arm_shell_l_84Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_upper_arm_shell_l_84.name = "Bicep shell L";
  if (endpoint_upper_arm_shell_l_84) {
    mesh_upper_arm_shell_l_84.position.copy(endpoint_upper_arm_shell_l_84.midpoint);
    mesh_upper_arm_shell_l_84.quaternion.copy(endpoint_upper_arm_shell_l_84.quaternion);
  }
  mesh_upper_arm_shell_l_84.castShadow = options.castShadow ?? true;
  mesh_upper_arm_shell_l_84.receiveShadow = options.receiveShadow ?? true;
  mesh_upper_arm_shell_l_84.userData.sculptComponent = { id: "upper-arm-shell-l" };
  node_upper_arm_shell_l_84.add(mesh_upper_arm_shell_l_84);
  meshes["upper-arm-shell-l"] = mesh_upper_arm_shell_l_84;
  colliders["upper-arm-shell-l"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_upper_arm_shell_l_84);

  const endpoint_elbow_l_85 = makeAttachmentEndpoint(null);
  const node_elbow_l_85 = new THREE.Group();
  node_elbow_l_85.name = "Elbow joint L__pivot";
  node_elbow_l_85.scale.set(1, 1, 1);
  if (endpoint_elbow_l_85) {
    node_elbow_l_85.position.copy(endpoint_elbow_l_85.start);
    node_elbow_l_85.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_elbow_l_85.position.set(0.16567, -0.13858, 0.06299);
    node_elbow_l_85.rotation.set(0.0, 0.0, 0.0);
  }
  node_elbow_l_85.userData.sculptComponent = { id: "elbow-l" };
  node_elbow_l_85.userData.actionProfile = {};
  (nodes["upper-arm-l"] ?? root).add(node_elbow_l_85);
  nodes["elbow-l"] = node_elbow_l_85;
  const mesh_elbow_l_85Geometry = endpoint_elbow_l_85
    ? new THREE.CylinderGeometry(endpoint_elbow_l_85.endRadius, endpoint_elbow_l_85.baseRadius, endpoint_elbow_l_85.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_elbow_l_85) {
    mesh_elbow_l_85Geometry.scale(0.08189, 0.08189, 0.08189);
  }
  const mesh_elbow_l_85 = new THREE.Mesh(
    mesh_elbow_l_85Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_elbow_l_85.name = "Elbow joint L";
  if (endpoint_elbow_l_85) {
    mesh_elbow_l_85.position.copy(endpoint_elbow_l_85.midpoint);
    mesh_elbow_l_85.quaternion.copy(endpoint_elbow_l_85.quaternion);
  }
  mesh_elbow_l_85.castShadow = options.castShadow ?? true;
  mesh_elbow_l_85.receiveShadow = options.receiveShadow ?? true;
  mesh_elbow_l_85.userData.sculptComponent = { id: "elbow-l" };
  node_elbow_l_85.add(mesh_elbow_l_85);
  meshes["elbow-l"] = mesh_elbow_l_85;
  colliders["elbow-l"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_elbow_l_85);

  const attachment_forearm_l_86 = {"parentSocket": "upper-arm-l-forearm-l", "localStart": [0.16567, -0.13858, 0.06299], "localEnd": [0.28535, -0.21417, 0.10709], "contactType": "hinge-joint", "baseRadius": 0.0315, "endRadius": 0.0252, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_forearm_l_86 = makeAttachmentEndpoint(attachment_forearm_l_86);
  const node_forearm_l_86 = new THREE.Group();
  node_forearm_l_86.name = "Forearm core L__pivot";
  node_forearm_l_86.scale.set(1, 1, 1);
  if (endpoint_forearm_l_86) {
    node_forearm_l_86.position.copy(endpoint_forearm_l_86.start);
    node_forearm_l_86.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_forearm_l_86.position.set(0.16567, -0.13858, 0.06299);
    node_forearm_l_86.rotation.set(0.0, 0.0, 0.0);
  }
  node_forearm_l_86.userData.sculptComponent = { id: "forearm-l" };
  node_forearm_l_86.userData.actionProfile = {};
  (nodes["upper-arm-l"] ?? root).add(node_forearm_l_86);
  nodes["forearm-l"] = node_forearm_l_86;
  const mesh_forearm_l_86Geometry = endpoint_forearm_l_86
    ? new THREE.CylinderGeometry(endpoint_forearm_l_86.endRadius, endpoint_forearm_l_86.baseRadius, endpoint_forearm_l_86.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_forearm_l_86) {
    mesh_forearm_l_86Geometry.scale(0.06299, 0.14827, 0.06299);
  }
  const mesh_forearm_l_86 = new THREE.Mesh(
    mesh_forearm_l_86Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_forearm_l_86.name = "Forearm core L";
  if (endpoint_forearm_l_86) {
    mesh_forearm_l_86.position.copy(endpoint_forearm_l_86.midpoint);
    mesh_forearm_l_86.quaternion.copy(endpoint_forearm_l_86.quaternion);
  }
  mesh_forearm_l_86.castShadow = options.castShadow ?? true;
  mesh_forearm_l_86.receiveShadow = options.receiveShadow ?? true;
  mesh_forearm_l_86.userData.sculptComponent = { id: "forearm-l" };
  node_forearm_l_86.add(mesh_forearm_l_86);
  meshes["forearm-l"] = mesh_forearm_l_86;
  colliders["forearm-l"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_forearm_l_86);

  const endpoint_forearm_shell_l_87 = makeAttachmentEndpoint(null);
  const node_forearm_shell_l_87 = new THREE.Group();
  node_forearm_shell_l_87.name = "Forearm shell L__pivot";
  node_forearm_shell_l_87.scale.set(1, 1, 1);
  if (endpoint_forearm_shell_l_87) {
    node_forearm_shell_l_87.position.copy(endpoint_forearm_shell_l_87.start);
    node_forearm_shell_l_87.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_forearm_shell_l_87.position.set(0.0, 0.0, 0.0);
    node_forearm_shell_l_87.rotation.set(0.0, 0.0, 0.0);
  }
  node_forearm_shell_l_87.userData.sculptComponent = { id: "forearm-shell-l" };
  node_forearm_shell_l_87.userData.actionProfile = {};
  (nodes["forearm-l"] ?? root).add(node_forearm_shell_l_87);
  nodes["forearm-shell-l"] = node_forearm_shell_l_87;
  const mesh_forearm_shell_l_87Geometry = endpoint_forearm_shell_l_87
    ? new THREE.CylinderGeometry(endpoint_forearm_shell_l_87.endRadius, endpoint_forearm_shell_l_87.baseRadius, endpoint_forearm_shell_l_87.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.01587, "rz": 0.00882, "twist": 0.0}, {"position": [0.02992, -0.0189, 0.01102], "rx": 0.03528, "rz": 0.03307, "twist": 0.0}, {"position": [0.05984, -0.0378, 0.02205], "rx": 0.04409, "rz": 0.04409, "twist": 0.0}, {"position": [0.08976, -0.05669, 0.03307], "rx": 0.03704, "rz": 0.03528, "twist": 0.0}, {"position": [0.11969, -0.07559, 0.04409], "rx": 0.01587, "rz": 0.00882, "twist": 0.0}], "radialSegments": 16, "capEnds": true});
  if (!endpoint_forearm_shell_l_87) {
    mesh_forearm_shell_l_87Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_forearm_shell_l_87 = new THREE.Mesh(
    mesh_forearm_shell_l_87Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_forearm_shell_l_87.name = "Forearm shell L";
  if (endpoint_forearm_shell_l_87) {
    mesh_forearm_shell_l_87.position.copy(endpoint_forearm_shell_l_87.midpoint);
    mesh_forearm_shell_l_87.quaternion.copy(endpoint_forearm_shell_l_87.quaternion);
  }
  mesh_forearm_shell_l_87.castShadow = options.castShadow ?? true;
  mesh_forearm_shell_l_87.receiveShadow = options.receiveShadow ?? true;
  mesh_forearm_shell_l_87.userData.sculptComponent = { id: "forearm-shell-l" };
  node_forearm_shell_l_87.add(mesh_forearm_shell_l_87);
  meshes["forearm-shell-l"] = mesh_forearm_shell_l_87;
  colliders["forearm-shell-l"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_forearm_shell_l_87);

  const endpoint_hand_l_88 = makeAttachmentEndpoint(null);
  const node_hand_l_88 = new THREE.Group();
  node_hand_l_88.name = "Hand L__pivot";
  node_hand_l_88.scale.set(1, 1, 1);
  if (endpoint_hand_l_88) {
    node_hand_l_88.position.copy(endpoint_hand_l_88.start);
    node_hand_l_88.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hand_l_88.position.set(0.11969, -0.11969, 0.04409);
    node_hand_l_88.rotation.set(0.0, 0.0, 0.0);
  }
  node_hand_l_88.userData.sculptComponent = { id: "hand-l" };
  node_hand_l_88.userData.actionProfile = {};
  (nodes["forearm-l"] ?? root).add(node_hand_l_88);
  nodes["hand-l"] = node_hand_l_88;
  const mesh_hand_l_88Geometry = endpoint_hand_l_88
    ? new THREE.CylinderGeometry(endpoint_hand_l_88.endRadius, endpoint_hand_l_88.baseRadius, endpoint_hand_l_88.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_hand_l_88) {
    mesh_hand_l_88Geometry.scale(0.07559, 0.08819, 0.0378);
  }
  const mesh_hand_l_88 = new THREE.Mesh(
    mesh_hand_l_88Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hand_l_88.name = "Hand L";
  if (endpoint_hand_l_88) {
    mesh_hand_l_88.position.copy(endpoint_hand_l_88.midpoint);
    mesh_hand_l_88.quaternion.copy(endpoint_hand_l_88.quaternion);
  }
  mesh_hand_l_88.castShadow = options.castShadow ?? true;
  mesh_hand_l_88.receiveShadow = options.receiveShadow ?? true;
  mesh_hand_l_88.userData.sculptComponent = { id: "hand-l" };
  node_hand_l_88.add(mesh_hand_l_88);
  meshes["hand-l"] = mesh_hand_l_88;
  colliders["hand-l"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_hand_l_88);

  const attachment_thumb_l_1_89 = {"parentSocket": "hand-l-thumb-l-1", "localStart": [-0.0315, -0.04409, 0.0189], "localEnd": [-0.03849, -0.06801, 0.02264], "contactType": "rigid-weld", "baseRadius": 0.00913, "endRadius": 0.00756, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_thumb_l_1_89 = makeAttachmentEndpoint(attachment_thumb_l_1_89);
  const node_thumb_l_1_89 = new THREE.Group();
  node_thumb_l_1_89.name = "Thumb L 1__pivot";
  node_thumb_l_1_89.scale.set(1, 1, 1);
  if (endpoint_thumb_l_1_89) {
    node_thumb_l_1_89.position.copy(endpoint_thumb_l_1_89.start);
    node_thumb_l_1_89.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_thumb_l_1_89.position.set(-0.0315, -0.04409, 0.0189);
    node_thumb_l_1_89.rotation.set(0.0, 0.0, 0.0);
  }
  node_thumb_l_1_89.userData.sculptComponent = { id: "thumb-l-1" };
  node_thumb_l_1_89.userData.actionProfile = {};
  (nodes["hand-l"] ?? root).add(node_thumb_l_1_89);
  nodes["thumb-l-1"] = node_thumb_l_1_89;
  const mesh_thumb_l_1_89Geometry = endpoint_thumb_l_1_89
    ? new THREE.CylinderGeometry(endpoint_thumb_l_1_89.endRadius, endpoint_thumb_l_1_89.baseRadius, endpoint_thumb_l_1_89.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_thumb_l_1_89) {
    mesh_thumb_l_1_89Geometry.scale(0.01827, 0.0252, 0.01827);
  }
  const mesh_thumb_l_1_89 = new THREE.Mesh(
    mesh_thumb_l_1_89Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_thumb_l_1_89.name = "Thumb L 1";
  if (endpoint_thumb_l_1_89) {
    mesh_thumb_l_1_89.position.copy(endpoint_thumb_l_1_89.midpoint);
    mesh_thumb_l_1_89.quaternion.copy(endpoint_thumb_l_1_89.quaternion);
  }
  mesh_thumb_l_1_89.castShadow = options.castShadow ?? true;
  mesh_thumb_l_1_89.receiveShadow = options.receiveShadow ?? true;
  mesh_thumb_l_1_89.userData.sculptComponent = { id: "thumb-l-1" };
  node_thumb_l_1_89.add(mesh_thumb_l_1_89);
  meshes["thumb-l-1"] = mesh_thumb_l_1_89;
  colliders["thumb-l-1"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_thumb_l_1_89);

  const attachment_thumb_l_2_90 = {"parentSocket": "thumb-l-1-thumb-l-2", "localStart": [-0.007, -0.02391, 0.00374], "localEnd": [-0.01285, -0.04391, 0.01097], "contactType": "hinge-joint", "baseRadius": 0.00756, "endRadius": 0.00598, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_thumb_l_2_90 = makeAttachmentEndpoint(attachment_thumb_l_2_90);
  const node_thumb_l_2_90 = new THREE.Group();
  node_thumb_l_2_90.name = "Thumb L 2__pivot";
  node_thumb_l_2_90.scale.set(1, 1, 1);
  if (endpoint_thumb_l_2_90) {
    node_thumb_l_2_90.position.copy(endpoint_thumb_l_2_90.start);
    node_thumb_l_2_90.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_thumb_l_2_90.position.set(-0.007, -0.02391, 0.00374);
    node_thumb_l_2_90.rotation.set(0.0, 0.0, 0.0);
  }
  node_thumb_l_2_90.userData.sculptComponent = { id: "thumb-l-2" };
  node_thumb_l_2_90.userData.actionProfile = {};
  (nodes["thumb-l-1"] ?? root).add(node_thumb_l_2_90);
  nodes["thumb-l-2"] = node_thumb_l_2_90;
  const mesh_thumb_l_2_90Geometry = endpoint_thumb_l_2_90
    ? new THREE.CylinderGeometry(endpoint_thumb_l_2_90.endRadius, endpoint_thumb_l_2_90.baseRadius, endpoint_thumb_l_2_90.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_thumb_l_2_90) {
    mesh_thumb_l_2_90Geometry.scale(0.01512, 0.02205, 0.01512);
  }
  const mesh_thumb_l_2_90 = new THREE.Mesh(
    mesh_thumb_l_2_90Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_thumb_l_2_90.name = "Thumb L 2";
  if (endpoint_thumb_l_2_90) {
    mesh_thumb_l_2_90.position.copy(endpoint_thumb_l_2_90.midpoint);
    mesh_thumb_l_2_90.quaternion.copy(endpoint_thumb_l_2_90.quaternion);
  }
  mesh_thumb_l_2_90.castShadow = options.castShadow ?? true;
  mesh_thumb_l_2_90.receiveShadow = options.receiveShadow ?? true;
  mesh_thumb_l_2_90.userData.sculptComponent = { id: "thumb-l-2" };
  node_thumb_l_2_90.add(mesh_thumb_l_2_90);
  meshes["thumb-l-2"] = mesh_thumb_l_2_90;
  colliders["thumb-l-2"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_thumb_l_2_90);

  const attachment_thumb_l_3_91 = {"parentSocket": "thumb-l-2-thumb-l-3", "localStart": [-0.00585, -0.01999, 0.00723], "localEnd": [-0.01047, -0.03576, 0.01656], "contactType": "hinge-joint", "baseRadius": 0.00598, "endRadius": 0.00441, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_thumb_l_3_91 = makeAttachmentEndpoint(attachment_thumb_l_3_91);
  const node_thumb_l_3_91 = new THREE.Group();
  node_thumb_l_3_91.name = "Thumb L 3__pivot";
  node_thumb_l_3_91.scale.set(1, 1, 1);
  if (endpoint_thumb_l_3_91) {
    node_thumb_l_3_91.position.copy(endpoint_thumb_l_3_91.start);
    node_thumb_l_3_91.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_thumb_l_3_91.position.set(-0.00585, -0.01999, 0.00723);
    node_thumb_l_3_91.rotation.set(0.0, 0.0, 0.0);
  }
  node_thumb_l_3_91.userData.sculptComponent = { id: "thumb-l-3" };
  node_thumb_l_3_91.userData.actionProfile = {};
  (nodes["thumb-l-2"] ?? root).add(node_thumb_l_3_91);
  nodes["thumb-l-3"] = node_thumb_l_3_91;
  const mesh_thumb_l_3_91Geometry = endpoint_thumb_l_3_91
    ? new THREE.CylinderGeometry(endpoint_thumb_l_3_91.endRadius, endpoint_thumb_l_3_91.baseRadius, endpoint_thumb_l_3_91.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_thumb_l_3_91) {
    mesh_thumb_l_3_91Geometry.scale(0.01197, 0.0189, 0.01197);
  }
  const mesh_thumb_l_3_91 = new THREE.Mesh(
    mesh_thumb_l_3_91Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_thumb_l_3_91.name = "Thumb L 3";
  if (endpoint_thumb_l_3_91) {
    mesh_thumb_l_3_91.position.copy(endpoint_thumb_l_3_91.midpoint);
    mesh_thumb_l_3_91.quaternion.copy(endpoint_thumb_l_3_91.quaternion);
  }
  mesh_thumb_l_3_91.castShadow = options.castShadow ?? true;
  mesh_thumb_l_3_91.receiveShadow = options.receiveShadow ?? true;
  mesh_thumb_l_3_91.userData.sculptComponent = { id: "thumb-l-3" };
  node_thumb_l_3_91.add(mesh_thumb_l_3_91);
  meshes["thumb-l-3"] = mesh_thumb_l_3_91;
  colliders["thumb-l-3"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_thumb_l_3_91);

  const attachment_index_l_1_92 = {"parentSocket": "hand-l-index-l-1", "localStart": [-0.02205, -0.04409, 0.0126], "localEnd": [-0.025, -0.072, 0.01658], "contactType": "rigid-weld", "baseRadius": 0.00913, "endRadius": 0.00756, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_index_l_1_92 = makeAttachmentEndpoint(attachment_index_l_1_92);
  const node_index_l_1_92 = new THREE.Group();
  node_index_l_1_92.name = "Index L 1__pivot";
  node_index_l_1_92.scale.set(1, 1, 1);
  if (endpoint_index_l_1_92) {
    node_index_l_1_92.position.copy(endpoint_index_l_1_92.start);
    node_index_l_1_92.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_index_l_1_92.position.set(-0.02205, -0.04409, 0.0126);
    node_index_l_1_92.rotation.set(0.0, 0.0, 0.0);
  }
  node_index_l_1_92.userData.sculptComponent = { id: "index-l-1" };
  node_index_l_1_92.userData.actionProfile = {};
  (nodes["hand-l"] ?? root).add(node_index_l_1_92);
  nodes["index-l-1"] = node_index_l_1_92;
  const mesh_index_l_1_92Geometry = endpoint_index_l_1_92
    ? new THREE.CylinderGeometry(endpoint_index_l_1_92.endRadius, endpoint_index_l_1_92.baseRadius, endpoint_index_l_1_92.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_index_l_1_92) {
    mesh_index_l_1_92Geometry.scale(0.01827, 0.02835, 0.01827);
  }
  const mesh_index_l_1_92 = new THREE.Mesh(
    mesh_index_l_1_92Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_index_l_1_92.name = "Index L 1";
  if (endpoint_index_l_1_92) {
    mesh_index_l_1_92.position.copy(endpoint_index_l_1_92.midpoint);
    mesh_index_l_1_92.quaternion.copy(endpoint_index_l_1_92.quaternion);
  }
  mesh_index_l_1_92.castShadow = options.castShadow ?? true;
  mesh_index_l_1_92.receiveShadow = options.receiveShadow ?? true;
  mesh_index_l_1_92.userData.sculptComponent = { id: "index-l-1" };
  node_index_l_1_92.add(mesh_index_l_1_92);
  meshes["index-l-1"] = mesh_index_l_1_92;
  colliders["index-l-1"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_index_l_1_92);

  const attachment_index_l_2_93 = {"parentSocket": "index-l-1-index-l-2", "localStart": [-0.00295, -0.02791, 0.00398], "localEnd": [-0.00516, -0.04874, 0.01086], "contactType": "hinge-joint", "baseRadius": 0.00756, "endRadius": 0.00598, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_index_l_2_93 = makeAttachmentEndpoint(attachment_index_l_2_93);
  const node_index_l_2_93 = new THREE.Group();
  node_index_l_2_93.name = "Index L 2__pivot";
  node_index_l_2_93.scale.set(1, 1, 1);
  if (endpoint_index_l_2_93) {
    node_index_l_2_93.position.copy(endpoint_index_l_2_93.start);
    node_index_l_2_93.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_index_l_2_93.position.set(-0.00295, -0.02791, 0.00398);
    node_index_l_2_93.rotation.set(0.0, 0.0, 0.0);
  }
  node_index_l_2_93.userData.sculptComponent = { id: "index-l-2" };
  node_index_l_2_93.userData.actionProfile = {};
  (nodes["index-l-1"] ?? root).add(node_index_l_2_93);
  nodes["index-l-2"] = node_index_l_2_93;
  const mesh_index_l_2_93Geometry = endpoint_index_l_2_93
    ? new THREE.CylinderGeometry(endpoint_index_l_2_93.endRadius, endpoint_index_l_2_93.baseRadius, endpoint_index_l_2_93.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_index_l_2_93) {
    mesh_index_l_2_93Geometry.scale(0.01512, 0.02205, 0.01512);
  }
  const mesh_index_l_2_93 = new THREE.Mesh(
    mesh_index_l_2_93Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_index_l_2_93.name = "Index L 2";
  if (endpoint_index_l_2_93) {
    mesh_index_l_2_93.position.copy(endpoint_index_l_2_93.midpoint);
    mesh_index_l_2_93.quaternion.copy(endpoint_index_l_2_93.quaternion);
  }
  mesh_index_l_2_93.castShadow = options.castShadow ?? true;
  mesh_index_l_2_93.receiveShadow = options.receiveShadow ?? true;
  mesh_index_l_2_93.userData.sculptComponent = { id: "index-l-2" };
  node_index_l_2_93.add(mesh_index_l_2_93);
  meshes["index-l-2"] = mesh_index_l_2_93;
  colliders["index-l-2"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_index_l_2_93);

  const attachment_index_l_3_94 = {"parentSocket": "index-l-2-index-l-3", "localStart": [-0.0022, -0.02083, 0.00687], "localEnd": [-0.00396, -0.03739, 0.01581], "contactType": "hinge-joint", "baseRadius": 0.00598, "endRadius": 0.00441, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_index_l_3_94 = makeAttachmentEndpoint(attachment_index_l_3_94);
  const node_index_l_3_94 = new THREE.Group();
  node_index_l_3_94.name = "Index L 3__pivot";
  node_index_l_3_94.scale.set(1, 1, 1);
  if (endpoint_index_l_3_94) {
    node_index_l_3_94.position.copy(endpoint_index_l_3_94.start);
    node_index_l_3_94.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_index_l_3_94.position.set(-0.0022, -0.02083, 0.00687);
    node_index_l_3_94.rotation.set(0.0, 0.0, 0.0);
  }
  node_index_l_3_94.userData.sculptComponent = { id: "index-l-3" };
  node_index_l_3_94.userData.actionProfile = {};
  (nodes["index-l-2"] ?? root).add(node_index_l_3_94);
  nodes["index-l-3"] = node_index_l_3_94;
  const mesh_index_l_3_94Geometry = endpoint_index_l_3_94
    ? new THREE.CylinderGeometry(endpoint_index_l_3_94.endRadius, endpoint_index_l_3_94.baseRadius, endpoint_index_l_3_94.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_index_l_3_94) {
    mesh_index_l_3_94Geometry.scale(0.01197, 0.0189, 0.01197);
  }
  const mesh_index_l_3_94 = new THREE.Mesh(
    mesh_index_l_3_94Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_index_l_3_94.name = "Index L 3";
  if (endpoint_index_l_3_94) {
    mesh_index_l_3_94.position.copy(endpoint_index_l_3_94.midpoint);
    mesh_index_l_3_94.quaternion.copy(endpoint_index_l_3_94.quaternion);
  }
  mesh_index_l_3_94.castShadow = options.castShadow ?? true;
  mesh_index_l_3_94.receiveShadow = options.receiveShadow ?? true;
  mesh_index_l_3_94.userData.sculptComponent = { id: "index-l-3" };
  node_index_l_3_94.add(mesh_index_l_3_94);
  meshes["index-l-3"] = mesh_index_l_3_94;
  colliders["index-l-3"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_index_l_3_94);

  const attachment_middle_l_1_95 = {"parentSocket": "hand-l-middle-l-1", "localStart": [-0.00315, -0.04409, 0.0126], "localEnd": [-0.00315, -0.07528, 0.01698], "contactType": "rigid-weld", "baseRadius": 0.00913, "endRadius": 0.00756, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_middle_l_1_95 = makeAttachmentEndpoint(attachment_middle_l_1_95);
  const node_middle_l_1_95 = new THREE.Group();
  node_middle_l_1_95.name = "Middle L 1__pivot";
  node_middle_l_1_95.scale.set(1, 1, 1);
  if (endpoint_middle_l_1_95) {
    node_middle_l_1_95.position.copy(endpoint_middle_l_1_95.start);
    node_middle_l_1_95.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_middle_l_1_95.position.set(-0.00315, -0.04409, 0.0126);
    node_middle_l_1_95.rotation.set(0.0, 0.0, 0.0);
  }
  node_middle_l_1_95.userData.sculptComponent = { id: "middle-l-1" };
  node_middle_l_1_95.userData.actionProfile = {};
  (nodes["hand-l"] ?? root).add(node_middle_l_1_95);
  nodes["middle-l-1"] = node_middle_l_1_95;
  const mesh_middle_l_1_95Geometry = endpoint_middle_l_1_95
    ? new THREE.CylinderGeometry(endpoint_middle_l_1_95.endRadius, endpoint_middle_l_1_95.baseRadius, endpoint_middle_l_1_95.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_middle_l_1_95) {
    mesh_middle_l_1_95Geometry.scale(0.01827, 0.0315, 0.01827);
  }
  const mesh_middle_l_1_95 = new THREE.Mesh(
    mesh_middle_l_1_95Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_middle_l_1_95.name = "Middle L 1";
  if (endpoint_middle_l_1_95) {
    mesh_middle_l_1_95.position.copy(endpoint_middle_l_1_95.midpoint);
    mesh_middle_l_1_95.quaternion.copy(endpoint_middle_l_1_95.quaternion);
  }
  mesh_middle_l_1_95.castShadow = options.castShadow ?? true;
  mesh_middle_l_1_95.receiveShadow = options.receiveShadow ?? true;
  mesh_middle_l_1_95.userData.sculptComponent = { id: "middle-l-1" };
  node_middle_l_1_95.add(mesh_middle_l_1_95);
  meshes["middle-l-1"] = mesh_middle_l_1_95;
  colliders["middle-l-1"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_middle_l_1_95);

  const attachment_middle_l_2_96 = {"parentSocket": "middle-l-1-middle-l-2", "localStart": [0.0, -0.03119, 0.00438], "localEnd": [0.0, -0.05515, 0.01217], "contactType": "hinge-joint", "baseRadius": 0.00756, "endRadius": 0.00598, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_middle_l_2_96 = makeAttachmentEndpoint(attachment_middle_l_2_96);
  const node_middle_l_2_96 = new THREE.Group();
  node_middle_l_2_96.name = "Middle L 2__pivot";
  node_middle_l_2_96.scale.set(1, 1, 1);
  if (endpoint_middle_l_2_96) {
    node_middle_l_2_96.position.copy(endpoint_middle_l_2_96.start);
    node_middle_l_2_96.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_middle_l_2_96.position.set(0.0, -0.03119, 0.00438);
    node_middle_l_2_96.rotation.set(0.0, 0.0, 0.0);
  }
  node_middle_l_2_96.userData.sculptComponent = { id: "middle-l-2" };
  node_middle_l_2_96.userData.actionProfile = {};
  (nodes["middle-l-1"] ?? root).add(node_middle_l_2_96);
  nodes["middle-l-2"] = node_middle_l_2_96;
  const mesh_middle_l_2_96Geometry = endpoint_middle_l_2_96
    ? new THREE.CylinderGeometry(endpoint_middle_l_2_96.endRadius, endpoint_middle_l_2_96.baseRadius, endpoint_middle_l_2_96.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_middle_l_2_96) {
    mesh_middle_l_2_96Geometry.scale(0.01512, 0.0252, 0.01512);
  }
  const mesh_middle_l_2_96 = new THREE.Mesh(
    mesh_middle_l_2_96Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_middle_l_2_96.name = "Middle L 2";
  if (endpoint_middle_l_2_96) {
    mesh_middle_l_2_96.position.copy(endpoint_middle_l_2_96.midpoint);
    mesh_middle_l_2_96.quaternion.copy(endpoint_middle_l_2_96.quaternion);
  }
  mesh_middle_l_2_96.castShadow = options.castShadow ?? true;
  mesh_middle_l_2_96.receiveShadow = options.receiveShadow ?? true;
  mesh_middle_l_2_96.userData.sculptComponent = { id: "middle-l-2" };
  node_middle_l_2_96.add(mesh_middle_l_2_96);
  meshes["middle-l-2"] = mesh_middle_l_2_96;
  colliders["middle-l-2"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_middle_l_2_96);

  const attachment_middle_l_3_97 = {"parentSocket": "middle-l-2-middle-l-3", "localStart": [0.0, -0.02396, 0.00779], "localEnd": [0.0, -0.04065, 0.01666], "contactType": "hinge-joint", "baseRadius": 0.00598, "endRadius": 0.00441, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_middle_l_3_97 = makeAttachmentEndpoint(attachment_middle_l_3_97);
  const node_middle_l_3_97 = new THREE.Group();
  node_middle_l_3_97.name = "Middle L 3__pivot";
  node_middle_l_3_97.scale.set(1, 1, 1);
  if (endpoint_middle_l_3_97) {
    node_middle_l_3_97.position.copy(endpoint_middle_l_3_97.start);
    node_middle_l_3_97.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_middle_l_3_97.position.set(0.0, -0.02396, 0.00779);
    node_middle_l_3_97.rotation.set(0.0, 0.0, 0.0);
  }
  node_middle_l_3_97.userData.sculptComponent = { id: "middle-l-3" };
  node_middle_l_3_97.userData.actionProfile = {};
  (nodes["middle-l-2"] ?? root).add(node_middle_l_3_97);
  nodes["middle-l-3"] = node_middle_l_3_97;
  const mesh_middle_l_3_97Geometry = endpoint_middle_l_3_97
    ? new THREE.CylinderGeometry(endpoint_middle_l_3_97.endRadius, endpoint_middle_l_3_97.baseRadius, endpoint_middle_l_3_97.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_middle_l_3_97) {
    mesh_middle_l_3_97Geometry.scale(0.01197, 0.0189, 0.01197);
  }
  const mesh_middle_l_3_97 = new THREE.Mesh(
    mesh_middle_l_3_97Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_middle_l_3_97.name = "Middle L 3";
  if (endpoint_middle_l_3_97) {
    mesh_middle_l_3_97.position.copy(endpoint_middle_l_3_97.midpoint);
    mesh_middle_l_3_97.quaternion.copy(endpoint_middle_l_3_97.quaternion);
  }
  mesh_middle_l_3_97.castShadow = options.castShadow ?? true;
  mesh_middle_l_3_97.receiveShadow = options.receiveShadow ?? true;
  mesh_middle_l_3_97.userData.sculptComponent = { id: "middle-l-3" };
  node_middle_l_3_97.add(mesh_middle_l_3_97);
  meshes["middle-l-3"] = mesh_middle_l_3_97;
  colliders["middle-l-3"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_middle_l_3_97);

  const attachment_ring_l_1_98 = {"parentSocket": "hand-l-ring-l-1", "localStart": [0.01575, -0.04409, 0.0126], "localEnd": [0.01811, -0.07206, 0.01657], "contactType": "rigid-weld", "baseRadius": 0.00913, "endRadius": 0.00756, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_ring_l_1_98 = makeAttachmentEndpoint(attachment_ring_l_1_98);
  const node_ring_l_1_98 = new THREE.Group();
  node_ring_l_1_98.name = "Ring L 1__pivot";
  node_ring_l_1_98.scale.set(1, 1, 1);
  if (endpoint_ring_l_1_98) {
    node_ring_l_1_98.position.copy(endpoint_ring_l_1_98.start);
    node_ring_l_1_98.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_ring_l_1_98.position.set(0.01575, -0.04409, 0.0126);
    node_ring_l_1_98.rotation.set(0.0, 0.0, 0.0);
  }
  node_ring_l_1_98.userData.sculptComponent = { id: "ring-l-1" };
  node_ring_l_1_98.userData.actionProfile = {};
  (nodes["hand-l"] ?? root).add(node_ring_l_1_98);
  nodes["ring-l-1"] = node_ring_l_1_98;
  const mesh_ring_l_1_98Geometry = endpoint_ring_l_1_98
    ? new THREE.CylinderGeometry(endpoint_ring_l_1_98.endRadius, endpoint_ring_l_1_98.baseRadius, endpoint_ring_l_1_98.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_ring_l_1_98) {
    mesh_ring_l_1_98Geometry.scale(0.01827, 0.02835, 0.01827);
  }
  const mesh_ring_l_1_98 = new THREE.Mesh(
    mesh_ring_l_1_98Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ring_l_1_98.name = "Ring L 1";
  if (endpoint_ring_l_1_98) {
    mesh_ring_l_1_98.position.copy(endpoint_ring_l_1_98.midpoint);
    mesh_ring_l_1_98.quaternion.copy(endpoint_ring_l_1_98.quaternion);
  }
  mesh_ring_l_1_98.castShadow = options.castShadow ?? true;
  mesh_ring_l_1_98.receiveShadow = options.receiveShadow ?? true;
  mesh_ring_l_1_98.userData.sculptComponent = { id: "ring-l-1" };
  node_ring_l_1_98.add(mesh_ring_l_1_98);
  meshes["ring-l-1"] = mesh_ring_l_1_98;
  colliders["ring-l-1"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_ring_l_1_98);

  const attachment_ring_l_2_99 = {"parentSocket": "ring-l-1-ring-l-2", "localStart": [0.00236, -0.02797, 0.00397], "localEnd": [0.00412, -0.04885, 0.01082], "contactType": "hinge-joint", "baseRadius": 0.00756, "endRadius": 0.00598, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_ring_l_2_99 = makeAttachmentEndpoint(attachment_ring_l_2_99);
  const node_ring_l_2_99 = new THREE.Group();
  node_ring_l_2_99.name = "Ring L 2__pivot";
  node_ring_l_2_99.scale.set(1, 1, 1);
  if (endpoint_ring_l_2_99) {
    node_ring_l_2_99.position.copy(endpoint_ring_l_2_99.start);
    node_ring_l_2_99.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_ring_l_2_99.position.set(0.00236, -0.02797, 0.00397);
    node_ring_l_2_99.rotation.set(0.0, 0.0, 0.0);
  }
  node_ring_l_2_99.userData.sculptComponent = { id: "ring-l-2" };
  node_ring_l_2_99.userData.actionProfile = {};
  (nodes["ring-l-1"] ?? root).add(node_ring_l_2_99);
  nodes["ring-l-2"] = node_ring_l_2_99;
  const mesh_ring_l_2_99Geometry = endpoint_ring_l_2_99
    ? new THREE.CylinderGeometry(endpoint_ring_l_2_99.endRadius, endpoint_ring_l_2_99.baseRadius, endpoint_ring_l_2_99.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_ring_l_2_99) {
    mesh_ring_l_2_99Geometry.scale(0.01512, 0.02205, 0.01512);
  }
  const mesh_ring_l_2_99 = new THREE.Mesh(
    mesh_ring_l_2_99Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ring_l_2_99.name = "Ring L 2";
  if (endpoint_ring_l_2_99) {
    mesh_ring_l_2_99.position.copy(endpoint_ring_l_2_99.midpoint);
    mesh_ring_l_2_99.quaternion.copy(endpoint_ring_l_2_99.quaternion);
  }
  mesh_ring_l_2_99.castShadow = options.castShadow ?? true;
  mesh_ring_l_2_99.receiveShadow = options.receiveShadow ?? true;
  mesh_ring_l_2_99.userData.sculptComponent = { id: "ring-l-2" };
  node_ring_l_2_99.add(mesh_ring_l_2_99);
  meshes["ring-l-2"] = mesh_ring_l_2_99;
  colliders["ring-l-2"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_ring_l_2_99);

  const attachment_ring_l_3_100 = {"parentSocket": "ring-l-2-ring-l-3", "localStart": [0.00176, -0.02088, 0.00685], "localEnd": [0.00316, -0.03749, 0.01577], "contactType": "hinge-joint", "baseRadius": 0.00598, "endRadius": 0.00441, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_ring_l_3_100 = makeAttachmentEndpoint(attachment_ring_l_3_100);
  const node_ring_l_3_100 = new THREE.Group();
  node_ring_l_3_100.name = "Ring L 3__pivot";
  node_ring_l_3_100.scale.set(1, 1, 1);
  if (endpoint_ring_l_3_100) {
    node_ring_l_3_100.position.copy(endpoint_ring_l_3_100.start);
    node_ring_l_3_100.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_ring_l_3_100.position.set(0.00176, -0.02088, 0.00685);
    node_ring_l_3_100.rotation.set(0.0, 0.0, 0.0);
  }
  node_ring_l_3_100.userData.sculptComponent = { id: "ring-l-3" };
  node_ring_l_3_100.userData.actionProfile = {};
  (nodes["ring-l-2"] ?? root).add(node_ring_l_3_100);
  nodes["ring-l-3"] = node_ring_l_3_100;
  const mesh_ring_l_3_100Geometry = endpoint_ring_l_3_100
    ? new THREE.CylinderGeometry(endpoint_ring_l_3_100.endRadius, endpoint_ring_l_3_100.baseRadius, endpoint_ring_l_3_100.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_ring_l_3_100) {
    mesh_ring_l_3_100Geometry.scale(0.01197, 0.0189, 0.01197);
  }
  const mesh_ring_l_3_100 = new THREE.Mesh(
    mesh_ring_l_3_100Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ring_l_3_100.name = "Ring L 3";
  if (endpoint_ring_l_3_100) {
    mesh_ring_l_3_100.position.copy(endpoint_ring_l_3_100.midpoint);
    mesh_ring_l_3_100.quaternion.copy(endpoint_ring_l_3_100.quaternion);
  }
  mesh_ring_l_3_100.castShadow = options.castShadow ?? true;
  mesh_ring_l_3_100.receiveShadow = options.receiveShadow ?? true;
  mesh_ring_l_3_100.userData.sculptComponent = { id: "ring-l-3" };
  node_ring_l_3_100.add(mesh_ring_l_3_100);
  meshes["ring-l-3"] = mesh_ring_l_3_100;
  colliders["ring-l-3"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_ring_l_3_100);

  const attachment_little_l_1_101 = {"parentSocket": "hand-l-little-l-1", "localStart": [0.0315, -0.04409, 0.00945], "localEnd": [0.0352, -0.0656, 0.01259], "contactType": "rigid-weld", "baseRadius": 0.00913, "endRadius": 0.00756, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_little_l_1_101 = makeAttachmentEndpoint(attachment_little_l_1_101);
  const node_little_l_1_101 = new THREE.Group();
  node_little_l_1_101.name = "Little L 1__pivot";
  node_little_l_1_101.scale.set(1, 1, 1);
  if (endpoint_little_l_1_101) {
    node_little_l_1_101.position.copy(endpoint_little_l_1_101.start);
    node_little_l_1_101.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_little_l_1_101.position.set(0.0315, -0.04409, 0.00945);
    node_little_l_1_101.rotation.set(0.0, 0.0, 0.0);
  }
  node_little_l_1_101.userData.sculptComponent = { id: "little-l-1" };
  node_little_l_1_101.userData.actionProfile = {};
  (nodes["hand-l"] ?? root).add(node_little_l_1_101);
  nodes["little-l-1"] = node_little_l_1_101;
  const mesh_little_l_1_101Geometry = endpoint_little_l_1_101
    ? new THREE.CylinderGeometry(endpoint_little_l_1_101.endRadius, endpoint_little_l_1_101.baseRadius, endpoint_little_l_1_101.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_little_l_1_101) {
    mesh_little_l_1_101Geometry.scale(0.01827, 0.02205, 0.01827);
  }
  const mesh_little_l_1_101 = new THREE.Mesh(
    mesh_little_l_1_101Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_little_l_1_101.name = "Little L 1";
  if (endpoint_little_l_1_101) {
    mesh_little_l_1_101.position.copy(endpoint_little_l_1_101.midpoint);
    mesh_little_l_1_101.quaternion.copy(endpoint_little_l_1_101.quaternion);
  }
  mesh_little_l_1_101.castShadow = options.castShadow ?? true;
  mesh_little_l_1_101.receiveShadow = options.receiveShadow ?? true;
  mesh_little_l_1_101.userData.sculptComponent = { id: "little-l-1" };
  node_little_l_1_101.add(mesh_little_l_1_101);
  meshes["little-l-1"] = mesh_little_l_1_101;
  colliders["little-l-1"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_little_l_1_101);

  const attachment_little_l_2_102 = {"parentSocket": "little-l-1-little-l-2", "localStart": [0.0037, -0.02151, 0.00314], "localEnd": [0.00623, -0.03623, 0.00812], "contactType": "hinge-joint", "baseRadius": 0.00756, "endRadius": 0.00598, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_little_l_2_102 = makeAttachmentEndpoint(attachment_little_l_2_102);
  const node_little_l_2_102 = new THREE.Group();
  node_little_l_2_102.name = "Little L 2__pivot";
  node_little_l_2_102.scale.set(1, 1, 1);
  if (endpoint_little_l_2_102) {
    node_little_l_2_102.position.copy(endpoint_little_l_2_102.start);
    node_little_l_2_102.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_little_l_2_102.position.set(0.0037, -0.02151, 0.00314);
    node_little_l_2_102.rotation.set(0.0, 0.0, 0.0);
  }
  node_little_l_2_102.userData.sculptComponent = { id: "little-l-2" };
  node_little_l_2_102.userData.actionProfile = {};
  (nodes["little-l-1"] ?? root).add(node_little_l_2_102);
  nodes["little-l-2"] = node_little_l_2_102;
  const mesh_little_l_2_102Geometry = endpoint_little_l_2_102
    ? new THREE.CylinderGeometry(endpoint_little_l_2_102.endRadius, endpoint_little_l_2_102.baseRadius, endpoint_little_l_2_102.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_little_l_2_102) {
    mesh_little_l_2_102Geometry.scale(0.01512, 0.01575, 0.01512);
  }
  const mesh_little_l_2_102 = new THREE.Mesh(
    mesh_little_l_2_102Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_little_l_2_102.name = "Little L 2";
  if (endpoint_little_l_2_102) {
    mesh_little_l_2_102.position.copy(endpoint_little_l_2_102.midpoint);
    mesh_little_l_2_102.quaternion.copy(endpoint_little_l_2_102.quaternion);
  }
  mesh_little_l_2_102.castShadow = options.castShadow ?? true;
  mesh_little_l_2_102.receiveShadow = options.receiveShadow ?? true;
  mesh_little_l_2_102.userData.sculptComponent = { id: "little-l-2" };
  node_little_l_2_102.add(mesh_little_l_2_102);
  meshes["little-l-2"] = mesh_little_l_2_102;
  colliders["little-l-2"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_little_l_2_102);

  const attachment_little_l_3_103 = {"parentSocket": "little-l-2-little-l-3", "localStart": [0.00253, -0.01472, 0.00498], "localEnd": [0.00488, -0.02835, 0.01251], "contactType": "hinge-joint", "baseRadius": 0.00598, "endRadius": 0.00441, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_little_l_3_103 = makeAttachmentEndpoint(attachment_little_l_3_103);
  const node_little_l_3_103 = new THREE.Group();
  node_little_l_3_103.name = "Little L 3__pivot";
  node_little_l_3_103.scale.set(1, 1, 1);
  if (endpoint_little_l_3_103) {
    node_little_l_3_103.position.copy(endpoint_little_l_3_103.start);
    node_little_l_3_103.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_little_l_3_103.position.set(0.00253, -0.01472, 0.00498);
    node_little_l_3_103.rotation.set(0.0, 0.0, 0.0);
  }
  node_little_l_3_103.userData.sculptComponent = { id: "little-l-3" };
  node_little_l_3_103.userData.actionProfile = {};
  (nodes["little-l-2"] ?? root).add(node_little_l_3_103);
  nodes["little-l-3"] = node_little_l_3_103;
  const mesh_little_l_3_103Geometry = endpoint_little_l_3_103
    ? new THREE.CylinderGeometry(endpoint_little_l_3_103.endRadius, endpoint_little_l_3_103.baseRadius, endpoint_little_l_3_103.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_little_l_3_103) {
    mesh_little_l_3_103Geometry.scale(0.01197, 0.01575, 0.01197);
  }
  const mesh_little_l_3_103 = new THREE.Mesh(
    mesh_little_l_3_103Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_little_l_3_103.name = "Little L 3";
  if (endpoint_little_l_3_103) {
    mesh_little_l_3_103.position.copy(endpoint_little_l_3_103.midpoint);
    mesh_little_l_3_103.quaternion.copy(endpoint_little_l_3_103.quaternion);
  }
  mesh_little_l_3_103.castShadow = options.castShadow ?? true;
  mesh_little_l_3_103.receiveShadow = options.receiveShadow ?? true;
  mesh_little_l_3_103.userData.sculptComponent = { id: "little-l-3" };
  node_little_l_3_103.add(mesh_little_l_3_103);
  meshes["little-l-3"] = mesh_little_l_3_103;
  colliders["little-l-3"] = {};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_little_l_3_103);

  const endpoint_seam_chest_l_104 = makeAttachmentEndpoint(null);
  const node_seam_chest_l_104 = new THREE.Group();
  node_seam_chest_l_104.name = "Gold seam seam-chest-l__pivot";
  node_seam_chest_l_104.scale.set(1, 1, 1);
  if (endpoint_seam_chest_l_104) {
    node_seam_chest_l_104.position.copy(endpoint_seam_chest_l_104.start);
    node_seam_chest_l_104.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seam_chest_l_104.position.set(0.0, 0.0, 0.0);
    node_seam_chest_l_104.rotation.set(0.0, 0.0, 0.0);
  }
  node_seam_chest_l_104.userData.sculptComponent = { id: "seam-chest-l" };
  node_seam_chest_l_104.userData.actionProfile = {};
  (nodes["chest-shell-l"] ?? root).add(node_seam_chest_l_104);
  nodes["seam-chest-l"] = node_seam_chest_l_104;
  const mesh_seam_chest_l_104Geometry = endpoint_seam_chest_l_104
    ? new THREE.CylinderGeometry(endpoint_seam_chest_l_104.endRadius, endpoint_seam_chest_l_104.baseRadius, endpoint_seam_chest_l_104.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.06049, -0.0, 0.04057], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [-0.0885, -0.06929, 0.08945], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [-0.10585, -0.17008, 0.10205], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [-0.10103, -0.26457, 0.07257], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_seam_chest_l_104) {
    mesh_seam_chest_l_104Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seam_chest_l_104 = new THREE.Mesh(
    mesh_seam_chest_l_104Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seam_chest_l_104.name = "Gold seam seam-chest-l";
  if (endpoint_seam_chest_l_104) {
    mesh_seam_chest_l_104.position.copy(endpoint_seam_chest_l_104.midpoint);
    mesh_seam_chest_l_104.quaternion.copy(endpoint_seam_chest_l_104.quaternion);
  }
  mesh_seam_chest_l_104.castShadow = options.castShadow ?? true;
  mesh_seam_chest_l_104.receiveShadow = options.receiveShadow ?? true;
  mesh_seam_chest_l_104.userData.sculptComponent = { id: "seam-chest-l" };
  node_seam_chest_l_104.add(mesh_seam_chest_l_104);
  meshes["seam-chest-l"] = mesh_seam_chest_l_104;
  colliders["seam-chest-l"] = {};
  destructionGroups["chest-shell-l"] ??= [];
  destructionGroups["chest-shell-l"].push(node_seam_chest_l_104);

  const endpoint_seam_chest_out_l_105 = makeAttachmentEndpoint(null);
  const node_seam_chest_out_l_105 = new THREE.Group();
  node_seam_chest_out_l_105.name = "Gold seam seam-chest-out-l__pivot";
  node_seam_chest_out_l_105.scale.set(1, 1, 1);
  if (endpoint_seam_chest_out_l_105) {
    node_seam_chest_out_l_105.position.copy(endpoint_seam_chest_out_l_105.start);
    node_seam_chest_out_l_105.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seam_chest_out_l_105.position.set(0.0, 0.0, 0.0);
    node_seam_chest_out_l_105.rotation.set(0.0, 0.0, 0.0);
  }
  node_seam_chest_out_l_105.userData.sculptComponent = { id: "seam-chest-out-l" };
  node_seam_chest_out_l_105.userData.actionProfile = {};
  (nodes["chest-shell-l"] ?? root).add(node_seam_chest_out_l_105);
  nodes["seam-chest-out-l"] = node_seam_chest_out_l_105;
  const mesh_seam_chest_out_l_105Geometry = endpoint_seam_chest_out_l_105
    ? new THREE.CylinderGeometry(endpoint_seam_chest_out_l_105.endRadius, endpoint_seam_chest_out_l_105.baseRadius, endpoint_seam_chest_out_l_105.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.06049, -0.0, 0.04057], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [0.05448, -0.06929, 0.08945], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [0.01514, -0.17008, 0.10205], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [-0.03504, -0.26457, 0.07257], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_seam_chest_out_l_105) {
    mesh_seam_chest_out_l_105Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seam_chest_out_l_105 = new THREE.Mesh(
    mesh_seam_chest_out_l_105Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seam_chest_out_l_105.name = "Gold seam seam-chest-out-l";
  if (endpoint_seam_chest_out_l_105) {
    mesh_seam_chest_out_l_105.position.copy(endpoint_seam_chest_out_l_105.midpoint);
    mesh_seam_chest_out_l_105.quaternion.copy(endpoint_seam_chest_out_l_105.quaternion);
  }
  mesh_seam_chest_out_l_105.castShadow = options.castShadow ?? true;
  mesh_seam_chest_out_l_105.receiveShadow = options.receiveShadow ?? true;
  mesh_seam_chest_out_l_105.userData.sculptComponent = { id: "seam-chest-out-l" };
  node_seam_chest_out_l_105.add(mesh_seam_chest_out_l_105);
  meshes["seam-chest-out-l"] = mesh_seam_chest_out_l_105;
  colliders["seam-chest-out-l"] = {};
  destructionGroups["chest-shell-l"] ??= [];
  destructionGroups["chest-shell-l"].push(node_seam_chest_out_l_105);

  const endpoint_seam_pauldron_l_106 = makeAttachmentEndpoint(null);
  const node_seam_pauldron_l_106 = new THREE.Group();
  node_seam_pauldron_l_106.name = "Gold seam seam-pauldron-l__pivot";
  node_seam_pauldron_l_106.scale.set(1, 1, 1);
  if (endpoint_seam_pauldron_l_106) {
    node_seam_pauldron_l_106.position.copy(endpoint_seam_pauldron_l_106.start);
    node_seam_pauldron_l_106.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seam_pauldron_l_106.position.set(0.0, 0.0, 0.0);
    node_seam_pauldron_l_106.rotation.set(0.0, 0.0, 0.0);
  }
  node_seam_pauldron_l_106.userData.sculptComponent = { id: "seam-pauldron-l" };
  node_seam_pauldron_l_106.userData.actionProfile = {};
  (nodes["pauldron-l"] ?? root).add(node_seam_pauldron_l_106);
  nodes["seam-pauldron-l"] = node_seam_pauldron_l_106;
  const mesh_seam_pauldron_l_106Geometry = endpoint_seam_pauldron_l_106
    ? new THREE.CylinderGeometry(endpoint_seam_pauldron_l_106.endRadius, endpoint_seam_pauldron_l_106.baseRadius, endpoint_seam_pauldron_l_106.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0275, -0.0, 0.01039], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [0.08857, -0.07559, 0.02425], "rx": 0.0063, "rz": 0.0063, "twist": 0.0}, {"position": [0.12346, -0.15748, 0.02803], "rx": 0.0063, "rz": 0.0063, "twist": 0.0}, {"position": [0.09991, -0.23307, 0.01795], "rx": 0.0063, "rz": 0.0063, "twist": 0.0}, {"position": [0.05235, -0.28346, 0.00126], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_seam_pauldron_l_106) {
    mesh_seam_pauldron_l_106Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seam_pauldron_l_106 = new THREE.Mesh(
    mesh_seam_pauldron_l_106Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seam_pauldron_l_106.name = "Gold seam seam-pauldron-l";
  if (endpoint_seam_pauldron_l_106) {
    mesh_seam_pauldron_l_106.position.copy(endpoint_seam_pauldron_l_106.midpoint);
    mesh_seam_pauldron_l_106.quaternion.copy(endpoint_seam_pauldron_l_106.quaternion);
  }
  mesh_seam_pauldron_l_106.castShadow = options.castShadow ?? true;
  mesh_seam_pauldron_l_106.receiveShadow = options.receiveShadow ?? true;
  mesh_seam_pauldron_l_106.userData.sculptComponent = { id: "seam-pauldron-l" };
  node_seam_pauldron_l_106.add(mesh_seam_pauldron_l_106);
  meshes["seam-pauldron-l"] = mesh_seam_pauldron_l_106;
  colliders["seam-pauldron-l"] = {};
  destructionGroups["pauldron-l"] ??= [];
  destructionGroups["pauldron-l"].push(node_seam_pauldron_l_106);

  const endpoint_seam_pauldron_in_l_107 = makeAttachmentEndpoint(null);
  const node_seam_pauldron_in_l_107 = new THREE.Group();
  node_seam_pauldron_in_l_107.name = "Gold seam seam-pauldron-in-l__pivot";
  node_seam_pauldron_in_l_107.scale.set(1, 1, 1);
  if (endpoint_seam_pauldron_in_l_107) {
    node_seam_pauldron_in_l_107.position.copy(endpoint_seam_pauldron_in_l_107.start);
    node_seam_pauldron_in_l_107.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seam_pauldron_in_l_107.position.set(0.0, 0.0, 0.0);
    node_seam_pauldron_in_l_107.rotation.set(0.0, 0.0, 0.0);
  }
  node_seam_pauldron_in_l_107.userData.sculptComponent = { id: "seam-pauldron-in-l" };
  node_seam_pauldron_in_l_107.userData.actionProfile = {};
  (nodes["pauldron-l"] ?? root).add(node_seam_pauldron_in_l_107);
  nodes["seam-pauldron-in-l"] = node_seam_pauldron_in_l_107;
  const mesh_seam_pauldron_in_l_107Geometry = endpoint_seam_pauldron_in_l_107
    ? new THREE.CylinderGeometry(endpoint_seam_pauldron_in_l_107.endRadius, endpoint_seam_pauldron_in_l_107.baseRadius, endpoint_seam_pauldron_in_l_107.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.0275, -0.0, 0.01039], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [-0.0092, -0.07559, 0.02425], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [0.00126, -0.15748, 0.02803], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [0.00214, -0.23307, 0.01795], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [0.01569, -0.28346, 0.00126], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_seam_pauldron_in_l_107) {
    mesh_seam_pauldron_in_l_107Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seam_pauldron_in_l_107 = new THREE.Mesh(
    mesh_seam_pauldron_in_l_107Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seam_pauldron_in_l_107.name = "Gold seam seam-pauldron-in-l";
  if (endpoint_seam_pauldron_in_l_107) {
    mesh_seam_pauldron_in_l_107.position.copy(endpoint_seam_pauldron_in_l_107.midpoint);
    mesh_seam_pauldron_in_l_107.quaternion.copy(endpoint_seam_pauldron_in_l_107.quaternion);
  }
  mesh_seam_pauldron_in_l_107.castShadow = options.castShadow ?? true;
  mesh_seam_pauldron_in_l_107.receiveShadow = options.receiveShadow ?? true;
  mesh_seam_pauldron_in_l_107.userData.sculptComponent = { id: "seam-pauldron-in-l" };
  node_seam_pauldron_in_l_107.add(mesh_seam_pauldron_in_l_107);
  meshes["seam-pauldron-in-l"] = mesh_seam_pauldron_in_l_107;
  colliders["seam-pauldron-in-l"] = {};
  destructionGroups["pauldron-l"] ??= [];
  destructionGroups["pauldron-l"].push(node_seam_pauldron_in_l_107);

  const endpoint_seam_bicep_l_108 = makeAttachmentEndpoint(null);
  const node_seam_bicep_l_108 = new THREE.Group();
  node_seam_bicep_l_108.name = "Gold seam seam-bicep-l__pivot";
  node_seam_bicep_l_108.scale.set(1, 1, 1);
  if (endpoint_seam_bicep_l_108) {
    node_seam_bicep_l_108.position.copy(endpoint_seam_bicep_l_108.start);
    node_seam_bicep_l_108.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seam_bicep_l_108.position.set(0.0, 0.0, 0.0);
    node_seam_bicep_l_108.rotation.set(0.0, 0.0, 0.0);
  }
  node_seam_bicep_l_108.userData.sculptComponent = { id: "seam-bicep-l" };
  node_seam_bicep_l_108.userData.actionProfile = {};
  (nodes["upper-arm-shell-l"] ?? root).add(node_seam_bicep_l_108);
  nodes["seam-bicep-l"] = node_seam_bicep_l_108;
  const mesh_seam_bicep_l_108Geometry = endpoint_seam_bicep_l_108
    ? new THREE.CylinderGeometry(endpoint_seam_bicep_l_108.endRadius, endpoint_seam_bicep_l_108.baseRadius, endpoint_seam_bicep_l_108.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.01039, -0.0, 0.01837], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [0.08037, -0.03465, 0.05657], "rx": 0.00441, "rz": 0.00441, "twist": 0.0}, {"position": [0.13477, -0.06929, 0.08252], "rx": 0.00441, "rz": 0.00441, "twist": 0.0}, {"position": [0.1658, -0.10394, 0.0901], "rx": 0.00441, "rz": 0.00441, "twist": 0.0}, {"position": [0.17606, -0.13858, 0.08136], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_seam_bicep_l_108) {
    mesh_seam_bicep_l_108Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seam_bicep_l_108 = new THREE.Mesh(
    mesh_seam_bicep_l_108Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seam_bicep_l_108.name = "Gold seam seam-bicep-l";
  if (endpoint_seam_bicep_l_108) {
    mesh_seam_bicep_l_108.position.copy(endpoint_seam_bicep_l_108.midpoint);
    mesh_seam_bicep_l_108.quaternion.copy(endpoint_seam_bicep_l_108.quaternion);
  }
  mesh_seam_bicep_l_108.castShadow = options.castShadow ?? true;
  mesh_seam_bicep_l_108.receiveShadow = options.receiveShadow ?? true;
  mesh_seam_bicep_l_108.userData.sculptComponent = { id: "seam-bicep-l" };
  node_seam_bicep_l_108.add(mesh_seam_bicep_l_108);
  meshes["seam-bicep-l"] = mesh_seam_bicep_l_108;
  colliders["seam-bicep-l"] = {};
  destructionGroups["upper-arm-shell-l"] ??= [];
  destructionGroups["upper-arm-shell-l"].push(node_seam_bicep_l_108);

  const endpoint_shoulder_joint_r_109 = makeAttachmentEndpoint(null);
  const node_shoulder_joint_r_109 = new THREE.Group();
  node_shoulder_joint_r_109.name = "Shoulder joint R__pivot";
  node_shoulder_joint_r_109.scale.set(1, 1, 1);
  if (endpoint_shoulder_joint_r_109) {
    node_shoulder_joint_r_109.position.copy(endpoint_shoulder_joint_r_109.start);
    node_shoulder_joint_r_109.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_shoulder_joint_r_109.position.set(-0.18709, 0.22677, -0.0063);
    node_shoulder_joint_r_109.rotation.set(0.0, 0.0, 0.0);
  }
  node_shoulder_joint_r_109.userData.sculptComponent = { id: "shoulder-joint-r" };
  node_shoulder_joint_r_109.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_shoulder_joint_r_109);
  nodes["shoulder-joint-r"] = node_shoulder_joint_r_109;
  const mesh_shoulder_joint_r_109Geometry = endpoint_shoulder_joint_r_109
    ? new THREE.CylinderGeometry(endpoint_shoulder_joint_r_109.endRadius, endpoint_shoulder_joint_r_109.baseRadius, endpoint_shoulder_joint_r_109.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_shoulder_joint_r_109) {
    mesh_shoulder_joint_r_109Geometry.scale(0.10079, 0.10079, 0.10079);
  }
  const mesh_shoulder_joint_r_109 = new THREE.Mesh(
    mesh_shoulder_joint_r_109Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_shoulder_joint_r_109.name = "Shoulder joint R";
  if (endpoint_shoulder_joint_r_109) {
    mesh_shoulder_joint_r_109.position.copy(endpoint_shoulder_joint_r_109.midpoint);
    mesh_shoulder_joint_r_109.quaternion.copy(endpoint_shoulder_joint_r_109.quaternion);
  }
  mesh_shoulder_joint_r_109.castShadow = options.castShadow ?? true;
  mesh_shoulder_joint_r_109.receiveShadow = options.receiveShadow ?? true;
  mesh_shoulder_joint_r_109.userData.sculptComponent = { id: "shoulder-joint-r" };
  node_shoulder_joint_r_109.add(mesh_shoulder_joint_r_109);
  meshes["shoulder-joint-r"] = mesh_shoulder_joint_r_109;
  colliders["shoulder-joint-r"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_shoulder_joint_r_109);

  const endpoint_pauldron_r_110 = makeAttachmentEndpoint(null);
  const node_pauldron_r_110 = new THREE.Group();
  node_pauldron_r_110.name = "Pauldron R__pivot";
  node_pauldron_r_110.scale.set(1, 1, 1);
  if (endpoint_pauldron_r_110) {
    node_pauldron_r_110.position.copy(endpoint_pauldron_r_110.start);
    node_pauldron_r_110.rotation.set(0.0, -0.0, 0.0);
  } else {
    node_pauldron_r_110.position.set(-0.22677, 0.34016, 0.0126);
    node_pauldron_r_110.rotation.set(0.0, -0.0, 0.0);
  }
  node_pauldron_r_110.userData.sculptComponent = { id: "pauldron-r" };
  node_pauldron_r_110.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_pauldron_r_110);
  nodes["pauldron-r"] = node_pauldron_r_110;
  const mesh_pauldron_r_110Geometry = endpoint_pauldron_r_110
    ? new THREE.CylinderGeometry(endpoint_pauldron_r_110.endRadius, endpoint_pauldron_r_110.baseRadius, endpoint_pauldron_r_110.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.03465, "rz": 0.02835, "twist": 0.0}, {"position": [-0.03969, -0.07559, 0.0063], "rx": 0.05984, "rz": 0.05039, "twist": 0.0}, {"position": [-0.06236, -0.15748, 0.0063], "rx": 0.07244, "rz": 0.06299, "twist": 0.0}, {"position": [-0.05102, -0.23307, 0.0], "rx": 0.05984, "rz": 0.05039, "twist": 0.0}, {"position": [-0.03402, -0.28346, -0.0063], "rx": 0.0252, "rz": 0.0189, "twist": 0.0}], "radialSegments": 22, "capEnds": true});
  if (!endpoint_pauldron_r_110) {
    mesh_pauldron_r_110Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_pauldron_r_110 = new THREE.Mesh(
    mesh_pauldron_r_110Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pauldron_r_110.name = "Pauldron R";
  if (endpoint_pauldron_r_110) {
    mesh_pauldron_r_110.position.copy(endpoint_pauldron_r_110.midpoint);
    mesh_pauldron_r_110.quaternion.copy(endpoint_pauldron_r_110.quaternion);
  }
  mesh_pauldron_r_110.castShadow = options.castShadow ?? true;
  mesh_pauldron_r_110.receiveShadow = options.receiveShadow ?? true;
  mesh_pauldron_r_110.userData.sculptComponent = { id: "pauldron-r" };
  node_pauldron_r_110.add(mesh_pauldron_r_110);
  meshes["pauldron-r"] = mesh_pauldron_r_110;
  colliders["pauldron-r"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_pauldron_r_110);

  const endpoint_pauldron_top_r_111 = makeAttachmentEndpoint(null);
  const node_pauldron_top_r_111 = new THREE.Group();
  node_pauldron_top_r_111.name = "Pauldron top petal R__pivot";
  node_pauldron_top_r_111.scale.set(1, 1, 1);
  if (endpoint_pauldron_top_r_111) {
    node_pauldron_top_r_111.position.copy(endpoint_pauldron_top_r_111.start);
    node_pauldron_top_r_111.rotation.set(0.0, -0.5, 0.0);
  } else {
    node_pauldron_top_r_111.position.set(-0.2211, 0.34646, 0.0252);
    node_pauldron_top_r_111.rotation.set(0.0, -0.5, 0.0);
  }
  node_pauldron_top_r_111.userData.sculptComponent = { id: "pauldron-top-r" };
  node_pauldron_top_r_111.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_pauldron_top_r_111);
  nodes["pauldron-top-r"] = node_pauldron_top_r_111;
  const mesh_pauldron_top_r_111Geometry = endpoint_pauldron_top_r_111
    ? new THREE.CylinderGeometry(endpoint_pauldron_top_r_111.endRadius, endpoint_pauldron_top_r_111.baseRadius, endpoint_pauldron_top_r_111.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.0189, "rz": 0.01575, "twist": 0.0}, {"position": [-0.02268, -0.06299, 0.0126], "rx": 0.04724, "rz": 0.04094, "twist": 0.0}, {"position": [-0.03969, -0.13228, 0.0063], "rx": 0.01575, "rz": 0.0126, "twist": 0.0}], "radialSegments": 18, "capEnds": true});
  if (!endpoint_pauldron_top_r_111) {
    mesh_pauldron_top_r_111Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_pauldron_top_r_111 = new THREE.Mesh(
    mesh_pauldron_top_r_111Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pauldron_top_r_111.name = "Pauldron top petal R";
  if (endpoint_pauldron_top_r_111) {
    mesh_pauldron_top_r_111.position.copy(endpoint_pauldron_top_r_111.midpoint);
    mesh_pauldron_top_r_111.quaternion.copy(endpoint_pauldron_top_r_111.quaternion);
  }
  mesh_pauldron_top_r_111.castShadow = options.castShadow ?? true;
  mesh_pauldron_top_r_111.receiveShadow = options.receiveShadow ?? true;
  mesh_pauldron_top_r_111.userData.sculptComponent = { id: "pauldron-top-r" };
  node_pauldron_top_r_111.add(mesh_pauldron_top_r_111);
  meshes["pauldron-top-r"] = mesh_pauldron_top_r_111;
  colliders["pauldron-top-r"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_pauldron_top_r_111);

  const endpoint_pauldron_low_r_112 = makeAttachmentEndpoint(null);
  const node_pauldron_low_r_112 = new THREE.Group();
  node_pauldron_low_r_112.name = "Pauldron lower petal R__pivot";
  node_pauldron_low_r_112.scale.set(1, 1, 1);
  if (endpoint_pauldron_low_r_112) {
    node_pauldron_low_r_112.position.copy(endpoint_pauldron_low_r_112.start);
    node_pauldron_low_r_112.rotation.set(0.0, -0.4, 0.0);
  } else {
    node_pauldron_low_r_112.position.set(-0.2778, 0.15118, 0.0126);
    node_pauldron_low_r_112.rotation.set(0.0, -0.4, 0.0);
  }
  node_pauldron_low_r_112.userData.sculptComponent = { id: "pauldron-low-r" };
  node_pauldron_low_r_112.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_pauldron_low_r_112);
  nodes["pauldron-low-r"] = node_pauldron_low_r_112;
  const mesh_pauldron_low_r_112Geometry = endpoint_pauldron_low_r_112
    ? new THREE.CylinderGeometry(endpoint_pauldron_low_r_112.endRadius, endpoint_pauldron_low_r_112.baseRadius, endpoint_pauldron_low_r_112.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.03465, "rz": 0.0252, "twist": 0.0}, {"position": [-0.01701, -0.06929, 0.0126], "rx": 0.04724, "rz": 0.04094, "twist": 0.0}, {"position": [-0.00567, -0.13858, 0.0063], "rx": 0.0252, "rz": 0.01575, "twist": 0.0}], "radialSegments": 18, "capEnds": true});
  if (!endpoint_pauldron_low_r_112) {
    mesh_pauldron_low_r_112Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_pauldron_low_r_112 = new THREE.Mesh(
    mesh_pauldron_low_r_112Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pauldron_low_r_112.name = "Pauldron lower petal R";
  if (endpoint_pauldron_low_r_112) {
    mesh_pauldron_low_r_112.position.copy(endpoint_pauldron_low_r_112.midpoint);
    mesh_pauldron_low_r_112.quaternion.copy(endpoint_pauldron_low_r_112.quaternion);
  }
  mesh_pauldron_low_r_112.castShadow = options.castShadow ?? true;
  mesh_pauldron_low_r_112.receiveShadow = options.receiveShadow ?? true;
  mesh_pauldron_low_r_112.userData.sculptComponent = { id: "pauldron-low-r" };
  node_pauldron_low_r_112.add(mesh_pauldron_low_r_112);
  meshes["pauldron-low-r"] = mesh_pauldron_low_r_112;
  colliders["pauldron-low-r"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_pauldron_low_r_112);

  const endpoint_pauldron_glow_r_113 = makeAttachmentEndpoint(null);
  const node_pauldron_glow_r_113 = new THREE.Group();
  node_pauldron_glow_r_113.name = "Pauldron glow R__pivot";
  node_pauldron_glow_r_113.scale.set(1, 1, 1);
  if (endpoint_pauldron_glow_r_113) {
    node_pauldron_glow_r_113.position.copy(endpoint_pauldron_glow_r_113.start);
    node_pauldron_glow_r_113.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_pauldron_glow_r_113.position.set(-0.28346, 0.08819, 0.06299);
    node_pauldron_glow_r_113.rotation.set(0.0, 0.0, 0.0);
  }
  node_pauldron_glow_r_113.userData.sculptComponent = { id: "pauldron-glow-r" };
  node_pauldron_glow_r_113.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_pauldron_glow_r_113);
  nodes["pauldron-glow-r"] = node_pauldron_glow_r_113;
  const mesh_pauldron_glow_r_113Geometry = endpoint_pauldron_glow_r_113
    ? new THREE.CylinderGeometry(endpoint_pauldron_glow_r_113.endRadius, endpoint_pauldron_glow_r_113.baseRadius, endpoint_pauldron_glow_r_113.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_pauldron_glow_r_113) {
    mesh_pauldron_glow_r_113Geometry.scale(0.0252, 0.05039, 0.01575);
  }
  const mesh_pauldron_glow_r_113 = new THREE.Mesh(
    mesh_pauldron_glow_r_113Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pauldron_glow_r_113.name = "Pauldron glow R";
  if (endpoint_pauldron_glow_r_113) {
    mesh_pauldron_glow_r_113.position.copy(endpoint_pauldron_glow_r_113.midpoint);
    mesh_pauldron_glow_r_113.quaternion.copy(endpoint_pauldron_glow_r_113.quaternion);
  }
  mesh_pauldron_glow_r_113.castShadow = options.castShadow ?? true;
  mesh_pauldron_glow_r_113.receiveShadow = options.receiveShadow ?? true;
  mesh_pauldron_glow_r_113.userData.sculptComponent = { id: "pauldron-glow-r" };
  node_pauldron_glow_r_113.add(mesh_pauldron_glow_r_113);
  meshes["pauldron-glow-r"] = mesh_pauldron_glow_r_113;
  colliders["pauldron-glow-r"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_pauldron_glow_r_113);

  const attachment_upper_arm_r_114 = {"parentSocket": "chest-upper-arm-r", "localStart": [-0.18709, 0.22677, -0.0063], "localEnd": [-0.35276, 0.08819, 0.05669], "contactType": "socket-joint", "baseRadius": 0.0378, "endRadius": 0.0315, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_upper_arm_r_114 = makeAttachmentEndpoint(attachment_upper_arm_r_114);
  const node_upper_arm_r_114 = new THREE.Group();
  node_upper_arm_r_114.name = "Upper arm core R__pivot";
  node_upper_arm_r_114.scale.set(1, 1, 1);
  if (endpoint_upper_arm_r_114) {
    node_upper_arm_r_114.position.copy(endpoint_upper_arm_r_114.start);
    node_upper_arm_r_114.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_upper_arm_r_114.position.set(-0.18709, 0.22677, -0.0063);
    node_upper_arm_r_114.rotation.set(0.0, 0.0, 0.0);
  }
  node_upper_arm_r_114.userData.sculptComponent = { id: "upper-arm-r" };
  node_upper_arm_r_114.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_upper_arm_r_114);
  nodes["upper-arm-r"] = node_upper_arm_r_114;
  const mesh_upper_arm_r_114Geometry = endpoint_upper_arm_r_114
    ? new THREE.CylinderGeometry(endpoint_upper_arm_r_114.endRadius, endpoint_upper_arm_r_114.baseRadius, endpoint_upper_arm_r_114.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_upper_arm_r_114) {
    mesh_upper_arm_r_114Geometry.scale(0.07559, 0.22499, 0.07559);
  }
  const mesh_upper_arm_r_114 = new THREE.Mesh(
    mesh_upper_arm_r_114Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_upper_arm_r_114.name = "Upper arm core R";
  if (endpoint_upper_arm_r_114) {
    mesh_upper_arm_r_114.position.copy(endpoint_upper_arm_r_114.midpoint);
    mesh_upper_arm_r_114.quaternion.copy(endpoint_upper_arm_r_114.quaternion);
  }
  mesh_upper_arm_r_114.castShadow = options.castShadow ?? true;
  mesh_upper_arm_r_114.receiveShadow = options.receiveShadow ?? true;
  mesh_upper_arm_r_114.userData.sculptComponent = { id: "upper-arm-r" };
  node_upper_arm_r_114.add(mesh_upper_arm_r_114);
  meshes["upper-arm-r"] = mesh_upper_arm_r_114;
  colliders["upper-arm-r"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_upper_arm_r_114);

  const endpoint_upper_arm_shell_r_115 = makeAttachmentEndpoint(null);
  const node_upper_arm_shell_r_115 = new THREE.Group();
  node_upper_arm_shell_r_115.name = "Bicep shell R__pivot";
  node_upper_arm_shell_r_115.scale.set(1, 1, 1);
  if (endpoint_upper_arm_shell_r_115) {
    node_upper_arm_shell_r_115.position.copy(endpoint_upper_arm_shell_r_115.start);
    node_upper_arm_shell_r_115.rotation.set(0.0, -0.0, 0.0);
  } else {
    node_upper_arm_shell_r_115.position.set(0.0, 0.0, 0.0);
    node_upper_arm_shell_r_115.rotation.set(0.0, -0.0, 0.0);
  }
  node_upper_arm_shell_r_115.userData.sculptComponent = { id: "upper-arm-shell-r" };
  node_upper_arm_shell_r_115.userData.actionProfile = {};
  (nodes["upper-arm-r"] ?? root).add(node_upper_arm_shell_r_115);
  nodes["upper-arm-shell-r"] = node_upper_arm_shell_r_115;
  const mesh_upper_arm_shell_r_115Geometry = endpoint_upper_arm_shell_r_115
    ? new THREE.CylinderGeometry(endpoint_upper_arm_shell_r_115.endRadius, endpoint_upper_arm_shell_r_115.baseRadius, endpoint_upper_arm_shell_r_115.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.02041, "rz": 0.01071, "twist": 0.0}, {"position": [-0.04142, -0.03465, 0.01575], "rx": 0.04535, "rz": 0.04016, "twist": 0.0}, {"position": [-0.08283, -0.06929, 0.0315], "rx": 0.05669, "rz": 0.05354, "twist": 0.0}, {"position": [-0.12425, -0.10394, 0.04724], "rx": 0.04762, "rz": 0.04283, "twist": 0.0}, {"position": [-0.16567, -0.13858, 0.06299], "rx": 0.02041, "rz": 0.01071, "twist": 0.0}], "radialSegments": 16, "capEnds": true});
  if (!endpoint_upper_arm_shell_r_115) {
    mesh_upper_arm_shell_r_115Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_upper_arm_shell_r_115 = new THREE.Mesh(
    mesh_upper_arm_shell_r_115Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_upper_arm_shell_r_115.name = "Bicep shell R";
  if (endpoint_upper_arm_shell_r_115) {
    mesh_upper_arm_shell_r_115.position.copy(endpoint_upper_arm_shell_r_115.midpoint);
    mesh_upper_arm_shell_r_115.quaternion.copy(endpoint_upper_arm_shell_r_115.quaternion);
  }
  mesh_upper_arm_shell_r_115.castShadow = options.castShadow ?? true;
  mesh_upper_arm_shell_r_115.receiveShadow = options.receiveShadow ?? true;
  mesh_upper_arm_shell_r_115.userData.sculptComponent = { id: "upper-arm-shell-r" };
  node_upper_arm_shell_r_115.add(mesh_upper_arm_shell_r_115);
  meshes["upper-arm-shell-r"] = mesh_upper_arm_shell_r_115;
  colliders["upper-arm-shell-r"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_upper_arm_shell_r_115);

  const endpoint_elbow_r_116 = makeAttachmentEndpoint(null);
  const node_elbow_r_116 = new THREE.Group();
  node_elbow_r_116.name = "Elbow joint R__pivot";
  node_elbow_r_116.scale.set(1, 1, 1);
  if (endpoint_elbow_r_116) {
    node_elbow_r_116.position.copy(endpoint_elbow_r_116.start);
    node_elbow_r_116.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_elbow_r_116.position.set(-0.16567, -0.13858, 0.06299);
    node_elbow_r_116.rotation.set(0.0, 0.0, 0.0);
  }
  node_elbow_r_116.userData.sculptComponent = { id: "elbow-r" };
  node_elbow_r_116.userData.actionProfile = {};
  (nodes["upper-arm-r"] ?? root).add(node_elbow_r_116);
  nodes["elbow-r"] = node_elbow_r_116;
  const mesh_elbow_r_116Geometry = endpoint_elbow_r_116
    ? new THREE.CylinderGeometry(endpoint_elbow_r_116.endRadius, endpoint_elbow_r_116.baseRadius, endpoint_elbow_r_116.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_elbow_r_116) {
    mesh_elbow_r_116Geometry.scale(0.08189, 0.08189, 0.08189);
  }
  const mesh_elbow_r_116 = new THREE.Mesh(
    mesh_elbow_r_116Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_elbow_r_116.name = "Elbow joint R";
  if (endpoint_elbow_r_116) {
    mesh_elbow_r_116.position.copy(endpoint_elbow_r_116.midpoint);
    mesh_elbow_r_116.quaternion.copy(endpoint_elbow_r_116.quaternion);
  }
  mesh_elbow_r_116.castShadow = options.castShadow ?? true;
  mesh_elbow_r_116.receiveShadow = options.receiveShadow ?? true;
  mesh_elbow_r_116.userData.sculptComponent = { id: "elbow-r" };
  node_elbow_r_116.add(mesh_elbow_r_116);
  meshes["elbow-r"] = mesh_elbow_r_116;
  colliders["elbow-r"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_elbow_r_116);

  const attachment_forearm_r_117 = {"parentSocket": "upper-arm-r-forearm-r", "localStart": [-0.16567, -0.13858, 0.06299], "localEnd": [-0.28535, -0.21417, 0.10709], "contactType": "hinge-joint", "baseRadius": 0.0315, "endRadius": 0.0252, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_forearm_r_117 = makeAttachmentEndpoint(attachment_forearm_r_117);
  const node_forearm_r_117 = new THREE.Group();
  node_forearm_r_117.name = "Forearm core R__pivot";
  node_forearm_r_117.scale.set(1, 1, 1);
  if (endpoint_forearm_r_117) {
    node_forearm_r_117.position.copy(endpoint_forearm_r_117.start);
    node_forearm_r_117.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_forearm_r_117.position.set(-0.16567, -0.13858, 0.06299);
    node_forearm_r_117.rotation.set(0.0, 0.0, 0.0);
  }
  node_forearm_r_117.userData.sculptComponent = { id: "forearm-r" };
  node_forearm_r_117.userData.actionProfile = {};
  (nodes["upper-arm-r"] ?? root).add(node_forearm_r_117);
  nodes["forearm-r"] = node_forearm_r_117;
  const mesh_forearm_r_117Geometry = endpoint_forearm_r_117
    ? new THREE.CylinderGeometry(endpoint_forearm_r_117.endRadius, endpoint_forearm_r_117.baseRadius, endpoint_forearm_r_117.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_forearm_r_117) {
    mesh_forearm_r_117Geometry.scale(0.06299, 0.14827, 0.06299);
  }
  const mesh_forearm_r_117 = new THREE.Mesh(
    mesh_forearm_r_117Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_forearm_r_117.name = "Forearm core R";
  if (endpoint_forearm_r_117) {
    mesh_forearm_r_117.position.copy(endpoint_forearm_r_117.midpoint);
    mesh_forearm_r_117.quaternion.copy(endpoint_forearm_r_117.quaternion);
  }
  mesh_forearm_r_117.castShadow = options.castShadow ?? true;
  mesh_forearm_r_117.receiveShadow = options.receiveShadow ?? true;
  mesh_forearm_r_117.userData.sculptComponent = { id: "forearm-r" };
  node_forearm_r_117.add(mesh_forearm_r_117);
  meshes["forearm-r"] = mesh_forearm_r_117;
  colliders["forearm-r"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_forearm_r_117);

  const endpoint_forearm_shell_r_118 = makeAttachmentEndpoint(null);
  const node_forearm_shell_r_118 = new THREE.Group();
  node_forearm_shell_r_118.name = "Forearm shell R__pivot";
  node_forearm_shell_r_118.scale.set(1, 1, 1);
  if (endpoint_forearm_shell_r_118) {
    node_forearm_shell_r_118.position.copy(endpoint_forearm_shell_r_118.start);
    node_forearm_shell_r_118.rotation.set(0.0, -0.0, 0.0);
  } else {
    node_forearm_shell_r_118.position.set(0.0, 0.0, 0.0);
    node_forearm_shell_r_118.rotation.set(0.0, -0.0, 0.0);
  }
  node_forearm_shell_r_118.userData.sculptComponent = { id: "forearm-shell-r" };
  node_forearm_shell_r_118.userData.actionProfile = {};
  (nodes["forearm-r"] ?? root).add(node_forearm_shell_r_118);
  nodes["forearm-shell-r"] = node_forearm_shell_r_118;
  const mesh_forearm_shell_r_118Geometry = endpoint_forearm_shell_r_118
    ? new THREE.CylinderGeometry(endpoint_forearm_shell_r_118.endRadius, endpoint_forearm_shell_r_118.baseRadius, endpoint_forearm_shell_r_118.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.01587, "rz": 0.00882, "twist": 0.0}, {"position": [-0.02992, -0.0189, 0.01102], "rx": 0.03528, "rz": 0.03307, "twist": 0.0}, {"position": [-0.05984, -0.0378, 0.02205], "rx": 0.04409, "rz": 0.04409, "twist": 0.0}, {"position": [-0.08976, -0.05669, 0.03307], "rx": 0.03704, "rz": 0.03528, "twist": 0.0}, {"position": [-0.11969, -0.07559, 0.04409], "rx": 0.01587, "rz": 0.00882, "twist": 0.0}], "radialSegments": 16, "capEnds": true});
  if (!endpoint_forearm_shell_r_118) {
    mesh_forearm_shell_r_118Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_forearm_shell_r_118 = new THREE.Mesh(
    mesh_forearm_shell_r_118Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_forearm_shell_r_118.name = "Forearm shell R";
  if (endpoint_forearm_shell_r_118) {
    mesh_forearm_shell_r_118.position.copy(endpoint_forearm_shell_r_118.midpoint);
    mesh_forearm_shell_r_118.quaternion.copy(endpoint_forearm_shell_r_118.quaternion);
  }
  mesh_forearm_shell_r_118.castShadow = options.castShadow ?? true;
  mesh_forearm_shell_r_118.receiveShadow = options.receiveShadow ?? true;
  mesh_forearm_shell_r_118.userData.sculptComponent = { id: "forearm-shell-r" };
  node_forearm_shell_r_118.add(mesh_forearm_shell_r_118);
  meshes["forearm-shell-r"] = mesh_forearm_shell_r_118;
  colliders["forearm-shell-r"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_forearm_shell_r_118);

  const endpoint_hand_r_119 = makeAttachmentEndpoint(null);
  const node_hand_r_119 = new THREE.Group();
  node_hand_r_119.name = "Hand R__pivot";
  node_hand_r_119.scale.set(1, 1, 1);
  if (endpoint_hand_r_119) {
    node_hand_r_119.position.copy(endpoint_hand_r_119.start);
    node_hand_r_119.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hand_r_119.position.set(-0.11969, -0.11969, 0.04409);
    node_hand_r_119.rotation.set(0.0, 0.0, 0.0);
  }
  node_hand_r_119.userData.sculptComponent = { id: "hand-r" };
  node_hand_r_119.userData.actionProfile = {};
  (nodes["forearm-r"] ?? root).add(node_hand_r_119);
  nodes["hand-r"] = node_hand_r_119;
  const mesh_hand_r_119Geometry = endpoint_hand_r_119
    ? new THREE.CylinderGeometry(endpoint_hand_r_119.endRadius, endpoint_hand_r_119.baseRadius, endpoint_hand_r_119.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_hand_r_119) {
    mesh_hand_r_119Geometry.scale(0.07559, 0.08819, 0.0378);
  }
  const mesh_hand_r_119 = new THREE.Mesh(
    mesh_hand_r_119Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hand_r_119.name = "Hand R";
  if (endpoint_hand_r_119) {
    mesh_hand_r_119.position.copy(endpoint_hand_r_119.midpoint);
    mesh_hand_r_119.quaternion.copy(endpoint_hand_r_119.quaternion);
  }
  mesh_hand_r_119.castShadow = options.castShadow ?? true;
  mesh_hand_r_119.receiveShadow = options.receiveShadow ?? true;
  mesh_hand_r_119.userData.sculptComponent = { id: "hand-r" };
  node_hand_r_119.add(mesh_hand_r_119);
  meshes["hand-r"] = mesh_hand_r_119;
  colliders["hand-r"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_hand_r_119);

  const attachment_thumb_r_1_120 = {"parentSocket": "hand-r-thumb-r-1", "localStart": [0.0315, -0.04409, 0.0189], "localEnd": [0.03849, -0.06801, 0.02264], "contactType": "rigid-weld", "baseRadius": 0.00913, "endRadius": 0.00756, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_thumb_r_1_120 = makeAttachmentEndpoint(attachment_thumb_r_1_120);
  const node_thumb_r_1_120 = new THREE.Group();
  node_thumb_r_1_120.name = "Thumb R 1__pivot";
  node_thumb_r_1_120.scale.set(1, 1, 1);
  if (endpoint_thumb_r_1_120) {
    node_thumb_r_1_120.position.copy(endpoint_thumb_r_1_120.start);
    node_thumb_r_1_120.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_thumb_r_1_120.position.set(0.0315, -0.04409, 0.0189);
    node_thumb_r_1_120.rotation.set(0.0, 0.0, 0.0);
  }
  node_thumb_r_1_120.userData.sculptComponent = { id: "thumb-r-1" };
  node_thumb_r_1_120.userData.actionProfile = {};
  (nodes["hand-r"] ?? root).add(node_thumb_r_1_120);
  nodes["thumb-r-1"] = node_thumb_r_1_120;
  const mesh_thumb_r_1_120Geometry = endpoint_thumb_r_1_120
    ? new THREE.CylinderGeometry(endpoint_thumb_r_1_120.endRadius, endpoint_thumb_r_1_120.baseRadius, endpoint_thumb_r_1_120.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_thumb_r_1_120) {
    mesh_thumb_r_1_120Geometry.scale(0.01827, 0.0252, 0.01827);
  }
  const mesh_thumb_r_1_120 = new THREE.Mesh(
    mesh_thumb_r_1_120Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_thumb_r_1_120.name = "Thumb R 1";
  if (endpoint_thumb_r_1_120) {
    mesh_thumb_r_1_120.position.copy(endpoint_thumb_r_1_120.midpoint);
    mesh_thumb_r_1_120.quaternion.copy(endpoint_thumb_r_1_120.quaternion);
  }
  mesh_thumb_r_1_120.castShadow = options.castShadow ?? true;
  mesh_thumb_r_1_120.receiveShadow = options.receiveShadow ?? true;
  mesh_thumb_r_1_120.userData.sculptComponent = { id: "thumb-r-1" };
  node_thumb_r_1_120.add(mesh_thumb_r_1_120);
  meshes["thumb-r-1"] = mesh_thumb_r_1_120;
  colliders["thumb-r-1"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_thumb_r_1_120);

  const attachment_thumb_r_2_121 = {"parentSocket": "thumb-r-1-thumb-r-2", "localStart": [0.007, -0.02391, 0.00374], "localEnd": [0.01285, -0.04391, 0.01097], "contactType": "hinge-joint", "baseRadius": 0.00756, "endRadius": 0.00598, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_thumb_r_2_121 = makeAttachmentEndpoint(attachment_thumb_r_2_121);
  const node_thumb_r_2_121 = new THREE.Group();
  node_thumb_r_2_121.name = "Thumb R 2__pivot";
  node_thumb_r_2_121.scale.set(1, 1, 1);
  if (endpoint_thumb_r_2_121) {
    node_thumb_r_2_121.position.copy(endpoint_thumb_r_2_121.start);
    node_thumb_r_2_121.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_thumb_r_2_121.position.set(0.007, -0.02391, 0.00374);
    node_thumb_r_2_121.rotation.set(0.0, 0.0, 0.0);
  }
  node_thumb_r_2_121.userData.sculptComponent = { id: "thumb-r-2" };
  node_thumb_r_2_121.userData.actionProfile = {};
  (nodes["thumb-r-1"] ?? root).add(node_thumb_r_2_121);
  nodes["thumb-r-2"] = node_thumb_r_2_121;
  const mesh_thumb_r_2_121Geometry = endpoint_thumb_r_2_121
    ? new THREE.CylinderGeometry(endpoint_thumb_r_2_121.endRadius, endpoint_thumb_r_2_121.baseRadius, endpoint_thumb_r_2_121.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_thumb_r_2_121) {
    mesh_thumb_r_2_121Geometry.scale(0.01512, 0.02205, 0.01512);
  }
  const mesh_thumb_r_2_121 = new THREE.Mesh(
    mesh_thumb_r_2_121Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_thumb_r_2_121.name = "Thumb R 2";
  if (endpoint_thumb_r_2_121) {
    mesh_thumb_r_2_121.position.copy(endpoint_thumb_r_2_121.midpoint);
    mesh_thumb_r_2_121.quaternion.copy(endpoint_thumb_r_2_121.quaternion);
  }
  mesh_thumb_r_2_121.castShadow = options.castShadow ?? true;
  mesh_thumb_r_2_121.receiveShadow = options.receiveShadow ?? true;
  mesh_thumb_r_2_121.userData.sculptComponent = { id: "thumb-r-2" };
  node_thumb_r_2_121.add(mesh_thumb_r_2_121);
  meshes["thumb-r-2"] = mesh_thumb_r_2_121;
  colliders["thumb-r-2"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_thumb_r_2_121);

  const attachment_thumb_r_3_122 = {"parentSocket": "thumb-r-2-thumb-r-3", "localStart": [0.00585, -0.01999, 0.00723], "localEnd": [0.01047, -0.03576, 0.01656], "contactType": "hinge-joint", "baseRadius": 0.00598, "endRadius": 0.00441, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_thumb_r_3_122 = makeAttachmentEndpoint(attachment_thumb_r_3_122);
  const node_thumb_r_3_122 = new THREE.Group();
  node_thumb_r_3_122.name = "Thumb R 3__pivot";
  node_thumb_r_3_122.scale.set(1, 1, 1);
  if (endpoint_thumb_r_3_122) {
    node_thumb_r_3_122.position.copy(endpoint_thumb_r_3_122.start);
    node_thumb_r_3_122.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_thumb_r_3_122.position.set(0.00585, -0.01999, 0.00723);
    node_thumb_r_3_122.rotation.set(0.0, 0.0, 0.0);
  }
  node_thumb_r_3_122.userData.sculptComponent = { id: "thumb-r-3" };
  node_thumb_r_3_122.userData.actionProfile = {};
  (nodes["thumb-r-2"] ?? root).add(node_thumb_r_3_122);
  nodes["thumb-r-3"] = node_thumb_r_3_122;
  const mesh_thumb_r_3_122Geometry = endpoint_thumb_r_3_122
    ? new THREE.CylinderGeometry(endpoint_thumb_r_3_122.endRadius, endpoint_thumb_r_3_122.baseRadius, endpoint_thumb_r_3_122.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_thumb_r_3_122) {
    mesh_thumb_r_3_122Geometry.scale(0.01197, 0.0189, 0.01197);
  }
  const mesh_thumb_r_3_122 = new THREE.Mesh(
    mesh_thumb_r_3_122Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_thumb_r_3_122.name = "Thumb R 3";
  if (endpoint_thumb_r_3_122) {
    mesh_thumb_r_3_122.position.copy(endpoint_thumb_r_3_122.midpoint);
    mesh_thumb_r_3_122.quaternion.copy(endpoint_thumb_r_3_122.quaternion);
  }
  mesh_thumb_r_3_122.castShadow = options.castShadow ?? true;
  mesh_thumb_r_3_122.receiveShadow = options.receiveShadow ?? true;
  mesh_thumb_r_3_122.userData.sculptComponent = { id: "thumb-r-3" };
  node_thumb_r_3_122.add(mesh_thumb_r_3_122);
  meshes["thumb-r-3"] = mesh_thumb_r_3_122;
  colliders["thumb-r-3"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_thumb_r_3_122);

  const attachment_index_r_1_123 = {"parentSocket": "hand-r-index-r-1", "localStart": [0.02205, -0.04409, 0.0126], "localEnd": [0.025, -0.072, 0.01658], "contactType": "rigid-weld", "baseRadius": 0.00913, "endRadius": 0.00756, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_index_r_1_123 = makeAttachmentEndpoint(attachment_index_r_1_123);
  const node_index_r_1_123 = new THREE.Group();
  node_index_r_1_123.name = "Index R 1__pivot";
  node_index_r_1_123.scale.set(1, 1, 1);
  if (endpoint_index_r_1_123) {
    node_index_r_1_123.position.copy(endpoint_index_r_1_123.start);
    node_index_r_1_123.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_index_r_1_123.position.set(0.02205, -0.04409, 0.0126);
    node_index_r_1_123.rotation.set(0.0, 0.0, 0.0);
  }
  node_index_r_1_123.userData.sculptComponent = { id: "index-r-1" };
  node_index_r_1_123.userData.actionProfile = {};
  (nodes["hand-r"] ?? root).add(node_index_r_1_123);
  nodes["index-r-1"] = node_index_r_1_123;
  const mesh_index_r_1_123Geometry = endpoint_index_r_1_123
    ? new THREE.CylinderGeometry(endpoint_index_r_1_123.endRadius, endpoint_index_r_1_123.baseRadius, endpoint_index_r_1_123.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_index_r_1_123) {
    mesh_index_r_1_123Geometry.scale(0.01827, 0.02835, 0.01827);
  }
  const mesh_index_r_1_123 = new THREE.Mesh(
    mesh_index_r_1_123Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_index_r_1_123.name = "Index R 1";
  if (endpoint_index_r_1_123) {
    mesh_index_r_1_123.position.copy(endpoint_index_r_1_123.midpoint);
    mesh_index_r_1_123.quaternion.copy(endpoint_index_r_1_123.quaternion);
  }
  mesh_index_r_1_123.castShadow = options.castShadow ?? true;
  mesh_index_r_1_123.receiveShadow = options.receiveShadow ?? true;
  mesh_index_r_1_123.userData.sculptComponent = { id: "index-r-1" };
  node_index_r_1_123.add(mesh_index_r_1_123);
  meshes["index-r-1"] = mesh_index_r_1_123;
  colliders["index-r-1"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_index_r_1_123);

  const attachment_index_r_2_124 = {"parentSocket": "index-r-1-index-r-2", "localStart": [0.00295, -0.02791, 0.00398], "localEnd": [0.00516, -0.04874, 0.01086], "contactType": "hinge-joint", "baseRadius": 0.00756, "endRadius": 0.00598, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_index_r_2_124 = makeAttachmentEndpoint(attachment_index_r_2_124);
  const node_index_r_2_124 = new THREE.Group();
  node_index_r_2_124.name = "Index R 2__pivot";
  node_index_r_2_124.scale.set(1, 1, 1);
  if (endpoint_index_r_2_124) {
    node_index_r_2_124.position.copy(endpoint_index_r_2_124.start);
    node_index_r_2_124.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_index_r_2_124.position.set(0.00295, -0.02791, 0.00398);
    node_index_r_2_124.rotation.set(0.0, 0.0, 0.0);
  }
  node_index_r_2_124.userData.sculptComponent = { id: "index-r-2" };
  node_index_r_2_124.userData.actionProfile = {};
  (nodes["index-r-1"] ?? root).add(node_index_r_2_124);
  nodes["index-r-2"] = node_index_r_2_124;
  const mesh_index_r_2_124Geometry = endpoint_index_r_2_124
    ? new THREE.CylinderGeometry(endpoint_index_r_2_124.endRadius, endpoint_index_r_2_124.baseRadius, endpoint_index_r_2_124.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_index_r_2_124) {
    mesh_index_r_2_124Geometry.scale(0.01512, 0.02205, 0.01512);
  }
  const mesh_index_r_2_124 = new THREE.Mesh(
    mesh_index_r_2_124Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_index_r_2_124.name = "Index R 2";
  if (endpoint_index_r_2_124) {
    mesh_index_r_2_124.position.copy(endpoint_index_r_2_124.midpoint);
    mesh_index_r_2_124.quaternion.copy(endpoint_index_r_2_124.quaternion);
  }
  mesh_index_r_2_124.castShadow = options.castShadow ?? true;
  mesh_index_r_2_124.receiveShadow = options.receiveShadow ?? true;
  mesh_index_r_2_124.userData.sculptComponent = { id: "index-r-2" };
  node_index_r_2_124.add(mesh_index_r_2_124);
  meshes["index-r-2"] = mesh_index_r_2_124;
  colliders["index-r-2"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_index_r_2_124);

  const attachment_index_r_3_125 = {"parentSocket": "index-r-2-index-r-3", "localStart": [0.0022, -0.02083, 0.00687], "localEnd": [0.00396, -0.03739, 0.01581], "contactType": "hinge-joint", "baseRadius": 0.00598, "endRadius": 0.00441, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_index_r_3_125 = makeAttachmentEndpoint(attachment_index_r_3_125);
  const node_index_r_3_125 = new THREE.Group();
  node_index_r_3_125.name = "Index R 3__pivot";
  node_index_r_3_125.scale.set(1, 1, 1);
  if (endpoint_index_r_3_125) {
    node_index_r_3_125.position.copy(endpoint_index_r_3_125.start);
    node_index_r_3_125.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_index_r_3_125.position.set(0.0022, -0.02083, 0.00687);
    node_index_r_3_125.rotation.set(0.0, 0.0, 0.0);
  }
  node_index_r_3_125.userData.sculptComponent = { id: "index-r-3" };
  node_index_r_3_125.userData.actionProfile = {};
  (nodes["index-r-2"] ?? root).add(node_index_r_3_125);
  nodes["index-r-3"] = node_index_r_3_125;
  const mesh_index_r_3_125Geometry = endpoint_index_r_3_125
    ? new THREE.CylinderGeometry(endpoint_index_r_3_125.endRadius, endpoint_index_r_3_125.baseRadius, endpoint_index_r_3_125.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_index_r_3_125) {
    mesh_index_r_3_125Geometry.scale(0.01197, 0.0189, 0.01197);
  }
  const mesh_index_r_3_125 = new THREE.Mesh(
    mesh_index_r_3_125Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_index_r_3_125.name = "Index R 3";
  if (endpoint_index_r_3_125) {
    mesh_index_r_3_125.position.copy(endpoint_index_r_3_125.midpoint);
    mesh_index_r_3_125.quaternion.copy(endpoint_index_r_3_125.quaternion);
  }
  mesh_index_r_3_125.castShadow = options.castShadow ?? true;
  mesh_index_r_3_125.receiveShadow = options.receiveShadow ?? true;
  mesh_index_r_3_125.userData.sculptComponent = { id: "index-r-3" };
  node_index_r_3_125.add(mesh_index_r_3_125);
  meshes["index-r-3"] = mesh_index_r_3_125;
  colliders["index-r-3"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_index_r_3_125);

  const attachment_middle_r_1_126 = {"parentSocket": "hand-r-middle-r-1", "localStart": [0.00315, -0.04409, 0.0126], "localEnd": [0.00315, -0.07528, 0.01698], "contactType": "rigid-weld", "baseRadius": 0.00913, "endRadius": 0.00756, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_middle_r_1_126 = makeAttachmentEndpoint(attachment_middle_r_1_126);
  const node_middle_r_1_126 = new THREE.Group();
  node_middle_r_1_126.name = "Middle R 1__pivot";
  node_middle_r_1_126.scale.set(1, 1, 1);
  if (endpoint_middle_r_1_126) {
    node_middle_r_1_126.position.copy(endpoint_middle_r_1_126.start);
    node_middle_r_1_126.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_middle_r_1_126.position.set(0.00315, -0.04409, 0.0126);
    node_middle_r_1_126.rotation.set(0.0, 0.0, 0.0);
  }
  node_middle_r_1_126.userData.sculptComponent = { id: "middle-r-1" };
  node_middle_r_1_126.userData.actionProfile = {};
  (nodes["hand-r"] ?? root).add(node_middle_r_1_126);
  nodes["middle-r-1"] = node_middle_r_1_126;
  const mesh_middle_r_1_126Geometry = endpoint_middle_r_1_126
    ? new THREE.CylinderGeometry(endpoint_middle_r_1_126.endRadius, endpoint_middle_r_1_126.baseRadius, endpoint_middle_r_1_126.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_middle_r_1_126) {
    mesh_middle_r_1_126Geometry.scale(0.01827, 0.0315, 0.01827);
  }
  const mesh_middle_r_1_126 = new THREE.Mesh(
    mesh_middle_r_1_126Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_middle_r_1_126.name = "Middle R 1";
  if (endpoint_middle_r_1_126) {
    mesh_middle_r_1_126.position.copy(endpoint_middle_r_1_126.midpoint);
    mesh_middle_r_1_126.quaternion.copy(endpoint_middle_r_1_126.quaternion);
  }
  mesh_middle_r_1_126.castShadow = options.castShadow ?? true;
  mesh_middle_r_1_126.receiveShadow = options.receiveShadow ?? true;
  mesh_middle_r_1_126.userData.sculptComponent = { id: "middle-r-1" };
  node_middle_r_1_126.add(mesh_middle_r_1_126);
  meshes["middle-r-1"] = mesh_middle_r_1_126;
  colliders["middle-r-1"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_middle_r_1_126);

  const attachment_middle_r_2_127 = {"parentSocket": "middle-r-1-middle-r-2", "localStart": [0.0, -0.03119, 0.00438], "localEnd": [0.0, -0.05515, 0.01217], "contactType": "hinge-joint", "baseRadius": 0.00756, "endRadius": 0.00598, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_middle_r_2_127 = makeAttachmentEndpoint(attachment_middle_r_2_127);
  const node_middle_r_2_127 = new THREE.Group();
  node_middle_r_2_127.name = "Middle R 2__pivot";
  node_middle_r_2_127.scale.set(1, 1, 1);
  if (endpoint_middle_r_2_127) {
    node_middle_r_2_127.position.copy(endpoint_middle_r_2_127.start);
    node_middle_r_2_127.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_middle_r_2_127.position.set(0.0, -0.03119, 0.00438);
    node_middle_r_2_127.rotation.set(0.0, 0.0, 0.0);
  }
  node_middle_r_2_127.userData.sculptComponent = { id: "middle-r-2" };
  node_middle_r_2_127.userData.actionProfile = {};
  (nodes["middle-r-1"] ?? root).add(node_middle_r_2_127);
  nodes["middle-r-2"] = node_middle_r_2_127;
  const mesh_middle_r_2_127Geometry = endpoint_middle_r_2_127
    ? new THREE.CylinderGeometry(endpoint_middle_r_2_127.endRadius, endpoint_middle_r_2_127.baseRadius, endpoint_middle_r_2_127.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_middle_r_2_127) {
    mesh_middle_r_2_127Geometry.scale(0.01512, 0.0252, 0.01512);
  }
  const mesh_middle_r_2_127 = new THREE.Mesh(
    mesh_middle_r_2_127Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_middle_r_2_127.name = "Middle R 2";
  if (endpoint_middle_r_2_127) {
    mesh_middle_r_2_127.position.copy(endpoint_middle_r_2_127.midpoint);
    mesh_middle_r_2_127.quaternion.copy(endpoint_middle_r_2_127.quaternion);
  }
  mesh_middle_r_2_127.castShadow = options.castShadow ?? true;
  mesh_middle_r_2_127.receiveShadow = options.receiveShadow ?? true;
  mesh_middle_r_2_127.userData.sculptComponent = { id: "middle-r-2" };
  node_middle_r_2_127.add(mesh_middle_r_2_127);
  meshes["middle-r-2"] = mesh_middle_r_2_127;
  colliders["middle-r-2"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_middle_r_2_127);

  const attachment_middle_r_3_128 = {"parentSocket": "middle-r-2-middle-r-3", "localStart": [0.0, -0.02396, 0.00779], "localEnd": [0.0, -0.04065, 0.01666], "contactType": "hinge-joint", "baseRadius": 0.00598, "endRadius": 0.00441, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_middle_r_3_128 = makeAttachmentEndpoint(attachment_middle_r_3_128);
  const node_middle_r_3_128 = new THREE.Group();
  node_middle_r_3_128.name = "Middle R 3__pivot";
  node_middle_r_3_128.scale.set(1, 1, 1);
  if (endpoint_middle_r_3_128) {
    node_middle_r_3_128.position.copy(endpoint_middle_r_3_128.start);
    node_middle_r_3_128.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_middle_r_3_128.position.set(0.0, -0.02396, 0.00779);
    node_middle_r_3_128.rotation.set(0.0, 0.0, 0.0);
  }
  node_middle_r_3_128.userData.sculptComponent = { id: "middle-r-3" };
  node_middle_r_3_128.userData.actionProfile = {};
  (nodes["middle-r-2"] ?? root).add(node_middle_r_3_128);
  nodes["middle-r-3"] = node_middle_r_3_128;
  const mesh_middle_r_3_128Geometry = endpoint_middle_r_3_128
    ? new THREE.CylinderGeometry(endpoint_middle_r_3_128.endRadius, endpoint_middle_r_3_128.baseRadius, endpoint_middle_r_3_128.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_middle_r_3_128) {
    mesh_middle_r_3_128Geometry.scale(0.01197, 0.0189, 0.01197);
  }
  const mesh_middle_r_3_128 = new THREE.Mesh(
    mesh_middle_r_3_128Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_middle_r_3_128.name = "Middle R 3";
  if (endpoint_middle_r_3_128) {
    mesh_middle_r_3_128.position.copy(endpoint_middle_r_3_128.midpoint);
    mesh_middle_r_3_128.quaternion.copy(endpoint_middle_r_3_128.quaternion);
  }
  mesh_middle_r_3_128.castShadow = options.castShadow ?? true;
  mesh_middle_r_3_128.receiveShadow = options.receiveShadow ?? true;
  mesh_middle_r_3_128.userData.sculptComponent = { id: "middle-r-3" };
  node_middle_r_3_128.add(mesh_middle_r_3_128);
  meshes["middle-r-3"] = mesh_middle_r_3_128;
  colliders["middle-r-3"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_middle_r_3_128);

  const attachment_ring_r_1_129 = {"parentSocket": "hand-r-ring-r-1", "localStart": [-0.01575, -0.04409, 0.0126], "localEnd": [-0.01811, -0.07206, 0.01657], "contactType": "rigid-weld", "baseRadius": 0.00913, "endRadius": 0.00756, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_ring_r_1_129 = makeAttachmentEndpoint(attachment_ring_r_1_129);
  const node_ring_r_1_129 = new THREE.Group();
  node_ring_r_1_129.name = "Ring R 1__pivot";
  node_ring_r_1_129.scale.set(1, 1, 1);
  if (endpoint_ring_r_1_129) {
    node_ring_r_1_129.position.copy(endpoint_ring_r_1_129.start);
    node_ring_r_1_129.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_ring_r_1_129.position.set(-0.01575, -0.04409, 0.0126);
    node_ring_r_1_129.rotation.set(0.0, 0.0, 0.0);
  }
  node_ring_r_1_129.userData.sculptComponent = { id: "ring-r-1" };
  node_ring_r_1_129.userData.actionProfile = {};
  (nodes["hand-r"] ?? root).add(node_ring_r_1_129);
  nodes["ring-r-1"] = node_ring_r_1_129;
  const mesh_ring_r_1_129Geometry = endpoint_ring_r_1_129
    ? new THREE.CylinderGeometry(endpoint_ring_r_1_129.endRadius, endpoint_ring_r_1_129.baseRadius, endpoint_ring_r_1_129.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_ring_r_1_129) {
    mesh_ring_r_1_129Geometry.scale(0.01827, 0.02835, 0.01827);
  }
  const mesh_ring_r_1_129 = new THREE.Mesh(
    mesh_ring_r_1_129Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ring_r_1_129.name = "Ring R 1";
  if (endpoint_ring_r_1_129) {
    mesh_ring_r_1_129.position.copy(endpoint_ring_r_1_129.midpoint);
    mesh_ring_r_1_129.quaternion.copy(endpoint_ring_r_1_129.quaternion);
  }
  mesh_ring_r_1_129.castShadow = options.castShadow ?? true;
  mesh_ring_r_1_129.receiveShadow = options.receiveShadow ?? true;
  mesh_ring_r_1_129.userData.sculptComponent = { id: "ring-r-1" };
  node_ring_r_1_129.add(mesh_ring_r_1_129);
  meshes["ring-r-1"] = mesh_ring_r_1_129;
  colliders["ring-r-1"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_ring_r_1_129);

  const attachment_ring_r_2_130 = {"parentSocket": "ring-r-1-ring-r-2", "localStart": [-0.00236, -0.02797, 0.00397], "localEnd": [-0.00412, -0.04885, 0.01082], "contactType": "hinge-joint", "baseRadius": 0.00756, "endRadius": 0.00598, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_ring_r_2_130 = makeAttachmentEndpoint(attachment_ring_r_2_130);
  const node_ring_r_2_130 = new THREE.Group();
  node_ring_r_2_130.name = "Ring R 2__pivot";
  node_ring_r_2_130.scale.set(1, 1, 1);
  if (endpoint_ring_r_2_130) {
    node_ring_r_2_130.position.copy(endpoint_ring_r_2_130.start);
    node_ring_r_2_130.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_ring_r_2_130.position.set(-0.00236, -0.02797, 0.00397);
    node_ring_r_2_130.rotation.set(0.0, 0.0, 0.0);
  }
  node_ring_r_2_130.userData.sculptComponent = { id: "ring-r-2" };
  node_ring_r_2_130.userData.actionProfile = {};
  (nodes["ring-r-1"] ?? root).add(node_ring_r_2_130);
  nodes["ring-r-2"] = node_ring_r_2_130;
  const mesh_ring_r_2_130Geometry = endpoint_ring_r_2_130
    ? new THREE.CylinderGeometry(endpoint_ring_r_2_130.endRadius, endpoint_ring_r_2_130.baseRadius, endpoint_ring_r_2_130.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_ring_r_2_130) {
    mesh_ring_r_2_130Geometry.scale(0.01512, 0.02205, 0.01512);
  }
  const mesh_ring_r_2_130 = new THREE.Mesh(
    mesh_ring_r_2_130Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ring_r_2_130.name = "Ring R 2";
  if (endpoint_ring_r_2_130) {
    mesh_ring_r_2_130.position.copy(endpoint_ring_r_2_130.midpoint);
    mesh_ring_r_2_130.quaternion.copy(endpoint_ring_r_2_130.quaternion);
  }
  mesh_ring_r_2_130.castShadow = options.castShadow ?? true;
  mesh_ring_r_2_130.receiveShadow = options.receiveShadow ?? true;
  mesh_ring_r_2_130.userData.sculptComponent = { id: "ring-r-2" };
  node_ring_r_2_130.add(mesh_ring_r_2_130);
  meshes["ring-r-2"] = mesh_ring_r_2_130;
  colliders["ring-r-2"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_ring_r_2_130);

  const attachment_ring_r_3_131 = {"parentSocket": "ring-r-2-ring-r-3", "localStart": [-0.00176, -0.02088, 0.00685], "localEnd": [-0.00316, -0.03749, 0.01577], "contactType": "hinge-joint", "baseRadius": 0.00598, "endRadius": 0.00441, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_ring_r_3_131 = makeAttachmentEndpoint(attachment_ring_r_3_131);
  const node_ring_r_3_131 = new THREE.Group();
  node_ring_r_3_131.name = "Ring R 3__pivot";
  node_ring_r_3_131.scale.set(1, 1, 1);
  if (endpoint_ring_r_3_131) {
    node_ring_r_3_131.position.copy(endpoint_ring_r_3_131.start);
    node_ring_r_3_131.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_ring_r_3_131.position.set(-0.00176, -0.02088, 0.00685);
    node_ring_r_3_131.rotation.set(0.0, 0.0, 0.0);
  }
  node_ring_r_3_131.userData.sculptComponent = { id: "ring-r-3" };
  node_ring_r_3_131.userData.actionProfile = {};
  (nodes["ring-r-2"] ?? root).add(node_ring_r_3_131);
  nodes["ring-r-3"] = node_ring_r_3_131;
  const mesh_ring_r_3_131Geometry = endpoint_ring_r_3_131
    ? new THREE.CylinderGeometry(endpoint_ring_r_3_131.endRadius, endpoint_ring_r_3_131.baseRadius, endpoint_ring_r_3_131.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_ring_r_3_131) {
    mesh_ring_r_3_131Geometry.scale(0.01197, 0.0189, 0.01197);
  }
  const mesh_ring_r_3_131 = new THREE.Mesh(
    mesh_ring_r_3_131Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ring_r_3_131.name = "Ring R 3";
  if (endpoint_ring_r_3_131) {
    mesh_ring_r_3_131.position.copy(endpoint_ring_r_3_131.midpoint);
    mesh_ring_r_3_131.quaternion.copy(endpoint_ring_r_3_131.quaternion);
  }
  mesh_ring_r_3_131.castShadow = options.castShadow ?? true;
  mesh_ring_r_3_131.receiveShadow = options.receiveShadow ?? true;
  mesh_ring_r_3_131.userData.sculptComponent = { id: "ring-r-3" };
  node_ring_r_3_131.add(mesh_ring_r_3_131);
  meshes["ring-r-3"] = mesh_ring_r_3_131;
  colliders["ring-r-3"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_ring_r_3_131);

  const attachment_little_r_1_132 = {"parentSocket": "hand-r-little-r-1", "localStart": [-0.0315, -0.04409, 0.00945], "localEnd": [-0.0352, -0.0656, 0.01259], "contactType": "rigid-weld", "baseRadius": 0.00913, "endRadius": 0.00756, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_little_r_1_132 = makeAttachmentEndpoint(attachment_little_r_1_132);
  const node_little_r_1_132 = new THREE.Group();
  node_little_r_1_132.name = "Little R 1__pivot";
  node_little_r_1_132.scale.set(1, 1, 1);
  if (endpoint_little_r_1_132) {
    node_little_r_1_132.position.copy(endpoint_little_r_1_132.start);
    node_little_r_1_132.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_little_r_1_132.position.set(-0.0315, -0.04409, 0.00945);
    node_little_r_1_132.rotation.set(0.0, 0.0, 0.0);
  }
  node_little_r_1_132.userData.sculptComponent = { id: "little-r-1" };
  node_little_r_1_132.userData.actionProfile = {};
  (nodes["hand-r"] ?? root).add(node_little_r_1_132);
  nodes["little-r-1"] = node_little_r_1_132;
  const mesh_little_r_1_132Geometry = endpoint_little_r_1_132
    ? new THREE.CylinderGeometry(endpoint_little_r_1_132.endRadius, endpoint_little_r_1_132.baseRadius, endpoint_little_r_1_132.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_little_r_1_132) {
    mesh_little_r_1_132Geometry.scale(0.01827, 0.02205, 0.01827);
  }
  const mesh_little_r_1_132 = new THREE.Mesh(
    mesh_little_r_1_132Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_little_r_1_132.name = "Little R 1";
  if (endpoint_little_r_1_132) {
    mesh_little_r_1_132.position.copy(endpoint_little_r_1_132.midpoint);
    mesh_little_r_1_132.quaternion.copy(endpoint_little_r_1_132.quaternion);
  }
  mesh_little_r_1_132.castShadow = options.castShadow ?? true;
  mesh_little_r_1_132.receiveShadow = options.receiveShadow ?? true;
  mesh_little_r_1_132.userData.sculptComponent = { id: "little-r-1" };
  node_little_r_1_132.add(mesh_little_r_1_132);
  meshes["little-r-1"] = mesh_little_r_1_132;
  colliders["little-r-1"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_little_r_1_132);

  const attachment_little_r_2_133 = {"parentSocket": "little-r-1-little-r-2", "localStart": [-0.0037, -0.02151, 0.00314], "localEnd": [-0.00623, -0.03623, 0.00812], "contactType": "hinge-joint", "baseRadius": 0.00756, "endRadius": 0.00598, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_little_r_2_133 = makeAttachmentEndpoint(attachment_little_r_2_133);
  const node_little_r_2_133 = new THREE.Group();
  node_little_r_2_133.name = "Little R 2__pivot";
  node_little_r_2_133.scale.set(1, 1, 1);
  if (endpoint_little_r_2_133) {
    node_little_r_2_133.position.copy(endpoint_little_r_2_133.start);
    node_little_r_2_133.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_little_r_2_133.position.set(-0.0037, -0.02151, 0.00314);
    node_little_r_2_133.rotation.set(0.0, 0.0, 0.0);
  }
  node_little_r_2_133.userData.sculptComponent = { id: "little-r-2" };
  node_little_r_2_133.userData.actionProfile = {};
  (nodes["little-r-1"] ?? root).add(node_little_r_2_133);
  nodes["little-r-2"] = node_little_r_2_133;
  const mesh_little_r_2_133Geometry = endpoint_little_r_2_133
    ? new THREE.CylinderGeometry(endpoint_little_r_2_133.endRadius, endpoint_little_r_2_133.baseRadius, endpoint_little_r_2_133.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_little_r_2_133) {
    mesh_little_r_2_133Geometry.scale(0.01512, 0.01575, 0.01512);
  }
  const mesh_little_r_2_133 = new THREE.Mesh(
    mesh_little_r_2_133Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_little_r_2_133.name = "Little R 2";
  if (endpoint_little_r_2_133) {
    mesh_little_r_2_133.position.copy(endpoint_little_r_2_133.midpoint);
    mesh_little_r_2_133.quaternion.copy(endpoint_little_r_2_133.quaternion);
  }
  mesh_little_r_2_133.castShadow = options.castShadow ?? true;
  mesh_little_r_2_133.receiveShadow = options.receiveShadow ?? true;
  mesh_little_r_2_133.userData.sculptComponent = { id: "little-r-2" };
  node_little_r_2_133.add(mesh_little_r_2_133);
  meshes["little-r-2"] = mesh_little_r_2_133;
  colliders["little-r-2"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_little_r_2_133);

  const attachment_little_r_3_134 = {"parentSocket": "little-r-2-little-r-3", "localStart": [-0.00253, -0.01472, 0.00498], "localEnd": [-0.00488, -0.02835, 0.01251], "contactType": "hinge-joint", "baseRadius": 0.00598, "endRadius": 0.00441, "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_little_r_3_134 = makeAttachmentEndpoint(attachment_little_r_3_134);
  const node_little_r_3_134 = new THREE.Group();
  node_little_r_3_134.name = "Little R 3__pivot";
  node_little_r_3_134.scale.set(1, 1, 1);
  if (endpoint_little_r_3_134) {
    node_little_r_3_134.position.copy(endpoint_little_r_3_134.start);
    node_little_r_3_134.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_little_r_3_134.position.set(-0.00253, -0.01472, 0.00498);
    node_little_r_3_134.rotation.set(0.0, 0.0, 0.0);
  }
  node_little_r_3_134.userData.sculptComponent = { id: "little-r-3" };
  node_little_r_3_134.userData.actionProfile = {};
  (nodes["little-r-2"] ?? root).add(node_little_r_3_134);
  nodes["little-r-3"] = node_little_r_3_134;
  const mesh_little_r_3_134Geometry = endpoint_little_r_3_134
    ? new THREE.CylinderGeometry(endpoint_little_r_3_134.endRadius, endpoint_little_r_3_134.baseRadius, endpoint_little_r_3_134.length, 8, 4)
    : buildWatertightCapsule(0.35, 0.7, 4, 8, 1);
  if (!endpoint_little_r_3_134) {
    mesh_little_r_3_134Geometry.scale(0.01197, 0.01575, 0.01197);
  }
  const mesh_little_r_3_134 = new THREE.Mesh(
    mesh_little_r_3_134Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_little_r_3_134.name = "Little R 3";
  if (endpoint_little_r_3_134) {
    mesh_little_r_3_134.position.copy(endpoint_little_r_3_134.midpoint);
    mesh_little_r_3_134.quaternion.copy(endpoint_little_r_3_134.quaternion);
  }
  mesh_little_r_3_134.castShadow = options.castShadow ?? true;
  mesh_little_r_3_134.receiveShadow = options.receiveShadow ?? true;
  mesh_little_r_3_134.userData.sculptComponent = { id: "little-r-3" };
  node_little_r_3_134.add(mesh_little_r_3_134);
  meshes["little-r-3"] = mesh_little_r_3_134;
  colliders["little-r-3"] = {};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_little_r_3_134);

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
    ? new THREE.CylinderGeometry(endpoint_seam_chest_r_135.endRadius, endpoint_seam_chest_r_135.baseRadius, endpoint_seam_chest_r_135.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.06049, -0.0, 0.04057], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [0.0885, -0.06929, 0.08945], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [0.10585, -0.17008, 0.10205], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [0.10103, -0.26457, 0.07257], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
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

  const endpoint_seam_chest_out_r_136 = makeAttachmentEndpoint(null);
  const node_seam_chest_out_r_136 = new THREE.Group();
  node_seam_chest_out_r_136.name = "Gold seam seam-chest-out-r__pivot";
  node_seam_chest_out_r_136.scale.set(1, 1, 1);
  if (endpoint_seam_chest_out_r_136) {
    node_seam_chest_out_r_136.position.copy(endpoint_seam_chest_out_r_136.start);
    node_seam_chest_out_r_136.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seam_chest_out_r_136.position.set(0.0, 0.0, 0.0);
    node_seam_chest_out_r_136.rotation.set(0.0, 0.0, 0.0);
  }
  node_seam_chest_out_r_136.userData.sculptComponent = { id: "seam-chest-out-r" };
  node_seam_chest_out_r_136.userData.actionProfile = {};
  (nodes["chest-shell-r"] ?? root).add(node_seam_chest_out_r_136);
  nodes["seam-chest-out-r"] = node_seam_chest_out_r_136;
  const mesh_seam_chest_out_r_136Geometry = endpoint_seam_chest_out_r_136
    ? new THREE.CylinderGeometry(endpoint_seam_chest_out_r_136.endRadius, endpoint_seam_chest_out_r_136.baseRadius, endpoint_seam_chest_out_r_136.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.06049, -0.0, 0.04057], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [-0.05448, -0.06929, 0.08945], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [-0.01514, -0.17008, 0.10205], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [0.03504, -0.26457, 0.07257], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_seam_chest_out_r_136) {
    mesh_seam_chest_out_r_136Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seam_chest_out_r_136 = new THREE.Mesh(
    mesh_seam_chest_out_r_136Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seam_chest_out_r_136.name = "Gold seam seam-chest-out-r";
  if (endpoint_seam_chest_out_r_136) {
    mesh_seam_chest_out_r_136.position.copy(endpoint_seam_chest_out_r_136.midpoint);
    mesh_seam_chest_out_r_136.quaternion.copy(endpoint_seam_chest_out_r_136.quaternion);
  }
  mesh_seam_chest_out_r_136.castShadow = options.castShadow ?? true;
  mesh_seam_chest_out_r_136.receiveShadow = options.receiveShadow ?? true;
  mesh_seam_chest_out_r_136.userData.sculptComponent = { id: "seam-chest-out-r" };
  node_seam_chest_out_r_136.add(mesh_seam_chest_out_r_136);
  meshes["seam-chest-out-r"] = mesh_seam_chest_out_r_136;
  colliders["seam-chest-out-r"] = {};
  destructionGroups["chest-shell-r"] ??= [];
  destructionGroups["chest-shell-r"].push(node_seam_chest_out_r_136);

  const endpoint_seam_pauldron_r_137 = makeAttachmentEndpoint(null);
  const node_seam_pauldron_r_137 = new THREE.Group();
  node_seam_pauldron_r_137.name = "Gold seam seam-pauldron-r__pivot";
  node_seam_pauldron_r_137.scale.set(1, 1, 1);
  if (endpoint_seam_pauldron_r_137) {
    node_seam_pauldron_r_137.position.copy(endpoint_seam_pauldron_r_137.start);
    node_seam_pauldron_r_137.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seam_pauldron_r_137.position.set(0.0, 0.0, 0.0);
    node_seam_pauldron_r_137.rotation.set(0.0, 0.0, 0.0);
  }
  node_seam_pauldron_r_137.userData.sculptComponent = { id: "seam-pauldron-r" };
  node_seam_pauldron_r_137.userData.actionProfile = {};
  (nodes["pauldron-r"] ?? root).add(node_seam_pauldron_r_137);
  nodes["seam-pauldron-r"] = node_seam_pauldron_r_137;
  const mesh_seam_pauldron_r_137Geometry = endpoint_seam_pauldron_r_137
    ? new THREE.CylinderGeometry(endpoint_seam_pauldron_r_137.endRadius, endpoint_seam_pauldron_r_137.baseRadius, endpoint_seam_pauldron_r_137.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.0275, -0.0, 0.01039], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [-0.08857, -0.07559, 0.02425], "rx": 0.0063, "rz": 0.0063, "twist": 0.0}, {"position": [-0.12346, -0.15748, 0.02803], "rx": 0.0063, "rz": 0.0063, "twist": 0.0}, {"position": [-0.09991, -0.23307, 0.01795], "rx": 0.0063, "rz": 0.0063, "twist": 0.0}, {"position": [-0.05235, -0.28346, 0.00126], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_seam_pauldron_r_137) {
    mesh_seam_pauldron_r_137Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seam_pauldron_r_137 = new THREE.Mesh(
    mesh_seam_pauldron_r_137Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seam_pauldron_r_137.name = "Gold seam seam-pauldron-r";
  if (endpoint_seam_pauldron_r_137) {
    mesh_seam_pauldron_r_137.position.copy(endpoint_seam_pauldron_r_137.midpoint);
    mesh_seam_pauldron_r_137.quaternion.copy(endpoint_seam_pauldron_r_137.quaternion);
  }
  mesh_seam_pauldron_r_137.castShadow = options.castShadow ?? true;
  mesh_seam_pauldron_r_137.receiveShadow = options.receiveShadow ?? true;
  mesh_seam_pauldron_r_137.userData.sculptComponent = { id: "seam-pauldron-r" };
  node_seam_pauldron_r_137.add(mesh_seam_pauldron_r_137);
  meshes["seam-pauldron-r"] = mesh_seam_pauldron_r_137;
  colliders["seam-pauldron-r"] = {};
  destructionGroups["pauldron-r"] ??= [];
  destructionGroups["pauldron-r"].push(node_seam_pauldron_r_137);

  const endpoint_seam_pauldron_in_r_138 = makeAttachmentEndpoint(null);
  const node_seam_pauldron_in_r_138 = new THREE.Group();
  node_seam_pauldron_in_r_138.name = "Gold seam seam-pauldron-in-r__pivot";
  node_seam_pauldron_in_r_138.scale.set(1, 1, 1);
  if (endpoint_seam_pauldron_in_r_138) {
    node_seam_pauldron_in_r_138.position.copy(endpoint_seam_pauldron_in_r_138.start);
    node_seam_pauldron_in_r_138.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seam_pauldron_in_r_138.position.set(0.0, 0.0, 0.0);
    node_seam_pauldron_in_r_138.rotation.set(0.0, 0.0, 0.0);
  }
  node_seam_pauldron_in_r_138.userData.sculptComponent = { id: "seam-pauldron-in-r" };
  node_seam_pauldron_in_r_138.userData.actionProfile = {};
  (nodes["pauldron-r"] ?? root).add(node_seam_pauldron_in_r_138);
  nodes["seam-pauldron-in-r"] = node_seam_pauldron_in_r_138;
  const mesh_seam_pauldron_in_r_138Geometry = endpoint_seam_pauldron_in_r_138
    ? new THREE.CylinderGeometry(endpoint_seam_pauldron_in_r_138.endRadius, endpoint_seam_pauldron_in_r_138.baseRadius, endpoint_seam_pauldron_in_r_138.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0275, -0.0, 0.01039], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [0.0092, -0.07559, 0.02425], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [-0.00126, -0.15748, 0.02803], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [-0.00214, -0.23307, 0.01795], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [-0.01569, -0.28346, 0.00126], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_seam_pauldron_in_r_138) {
    mesh_seam_pauldron_in_r_138Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seam_pauldron_in_r_138 = new THREE.Mesh(
    mesh_seam_pauldron_in_r_138Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seam_pauldron_in_r_138.name = "Gold seam seam-pauldron-in-r";
  if (endpoint_seam_pauldron_in_r_138) {
    mesh_seam_pauldron_in_r_138.position.copy(endpoint_seam_pauldron_in_r_138.midpoint);
    mesh_seam_pauldron_in_r_138.quaternion.copy(endpoint_seam_pauldron_in_r_138.quaternion);
  }
  mesh_seam_pauldron_in_r_138.castShadow = options.castShadow ?? true;
  mesh_seam_pauldron_in_r_138.receiveShadow = options.receiveShadow ?? true;
  mesh_seam_pauldron_in_r_138.userData.sculptComponent = { id: "seam-pauldron-in-r" };
  node_seam_pauldron_in_r_138.add(mesh_seam_pauldron_in_r_138);
  meshes["seam-pauldron-in-r"] = mesh_seam_pauldron_in_r_138;
  colliders["seam-pauldron-in-r"] = {};
  destructionGroups["pauldron-r"] ??= [];
  destructionGroups["pauldron-r"].push(node_seam_pauldron_in_r_138);

  const endpoint_seam_bicep_r_139 = makeAttachmentEndpoint(null);
  const node_seam_bicep_r_139 = new THREE.Group();
  node_seam_bicep_r_139.name = "Gold seam seam-bicep-r__pivot";
  node_seam_bicep_r_139.scale.set(1, 1, 1);
  if (endpoint_seam_bicep_r_139) {
    node_seam_bicep_r_139.position.copy(endpoint_seam_bicep_r_139.start);
    node_seam_bicep_r_139.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seam_bicep_r_139.position.set(0.0, 0.0, 0.0);
    node_seam_bicep_r_139.rotation.set(0.0, 0.0, 0.0);
  }
  node_seam_bicep_r_139.userData.sculptComponent = { id: "seam-bicep-r" };
  node_seam_bicep_r_139.userData.actionProfile = {};
  (nodes["upper-arm-shell-r"] ?? root).add(node_seam_bicep_r_139);
  nodes["seam-bicep-r"] = node_seam_bicep_r_139;
  const mesh_seam_bicep_r_139Geometry = endpoint_seam_bicep_r_139
    ? new THREE.CylinderGeometry(endpoint_seam_bicep_r_139.endRadius, endpoint_seam_bicep_r_139.baseRadius, endpoint_seam_bicep_r_139.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.01039, -0.0, 0.01837], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [-0.08037, -0.03465, 0.05657], "rx": 0.00441, "rz": 0.00441, "twist": 0.0}, {"position": [-0.13477, -0.06929, 0.08252], "rx": 0.00441, "rz": 0.00441, "twist": 0.0}, {"position": [-0.1658, -0.10394, 0.0901], "rx": 0.00441, "rz": 0.00441, "twist": 0.0}, {"position": [-0.17606, -0.13858, 0.08136], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_seam_bicep_r_139) {
    mesh_seam_bicep_r_139Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seam_bicep_r_139 = new THREE.Mesh(
    mesh_seam_bicep_r_139Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seam_bicep_r_139.name = "Gold seam seam-bicep-r";
  if (endpoint_seam_bicep_r_139) {
    mesh_seam_bicep_r_139.position.copy(endpoint_seam_bicep_r_139.midpoint);
    mesh_seam_bicep_r_139.quaternion.copy(endpoint_seam_bicep_r_139.quaternion);
  }
  mesh_seam_bicep_r_139.castShadow = options.castShadow ?? true;
  mesh_seam_bicep_r_139.receiveShadow = options.receiveShadow ?? true;
  mesh_seam_bicep_r_139.userData.sculptComponent = { id: "seam-bicep-r" };
  node_seam_bicep_r_139.add(mesh_seam_bicep_r_139);
  meshes["seam-bicep-r"] = mesh_seam_bicep_r_139;
  colliders["seam-bicep-r"] = {};
  destructionGroups["upper-arm-shell-r"] ??= [];
  destructionGroups["upper-arm-shell-r"].push(node_seam_bicep_r_139);

  const endpoint_seam_helmet_140 = makeAttachmentEndpoint(null);
  const node_seam_helmet_140 = new THREE.Group();
  node_seam_helmet_140.name = "Gold crown stripe__pivot";
  node_seam_helmet_140.scale.set(1, 1, 1);
  if (endpoint_seam_helmet_140) {
    node_seam_helmet_140.position.copy(endpoint_seam_helmet_140.start);
    node_seam_helmet_140.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seam_helmet_140.position.set(0.0, 0.0, 0.0);
    node_seam_helmet_140.rotation.set(0.0, 0.0, 0.0);
  }
  node_seam_helmet_140.userData.sculptComponent = { id: "seam-helmet" };
  node_seam_helmet_140.userData.actionProfile = {};
  (nodes["head"] ?? root).add(node_seam_helmet_140);
  nodes["seam-helmet"] = node_seam_helmet_140;
  const mesh_seam_helmet_140Geometry = endpoint_seam_helmet_140
    ? new THREE.CylinderGeometry(endpoint_seam_helmet_140.endRadius, endpoint_seam_helmet_140.baseRadius, endpoint_seam_helmet_140.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.15118, 0.1365], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [0.0, 0.21417, 0.12409], "rx": 0.0063, "rz": 0.0063, "twist": 0.0}, {"position": [0.0, 0.25197, 0.09307], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_seam_helmet_140) {
    mesh_seam_helmet_140Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seam_helmet_140 = new THREE.Mesh(
    mesh_seam_helmet_140Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seam_helmet_140.name = "Gold crown stripe";
  if (endpoint_seam_helmet_140) {
    mesh_seam_helmet_140.position.copy(endpoint_seam_helmet_140.midpoint);
    mesh_seam_helmet_140.quaternion.copy(endpoint_seam_helmet_140.quaternion);
  }
  mesh_seam_helmet_140.castShadow = options.castShadow ?? true;
  mesh_seam_helmet_140.receiveShadow = options.receiveShadow ?? true;
  mesh_seam_helmet_140.userData.sculptComponent = { id: "seam-helmet" };
  node_seam_helmet_140.add(mesh_seam_helmet_140);
  meshes["seam-helmet"] = mesh_seam_helmet_140;
  colliders["seam-helmet"] = {};
  destructionGroups["head"] ??= [];
  destructionGroups["head"].push(node_seam_helmet_140);

  const endpoint_fin_a_l_141 = makeAttachmentEndpoint(null);
  const node_fin_a_l_141 = new THREE.Group();
  node_fin_a_l_141.name = "Fin blade A L__pivot";
  node_fin_a_l_141.scale.set(1, 1, 1);
  if (endpoint_fin_a_l_141) {
    node_fin_a_l_141.position.copy(endpoint_fin_a_l_141.start);
    node_fin_a_l_141.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_fin_a_l_141.position.set(0.08819, 0.21417, -0.10709);
    node_fin_a_l_141.rotation.set(0.0, 0.0, 0.0);
  }
  node_fin_a_l_141.userData.sculptComponent = { id: "fin-a-l" };
  node_fin_a_l_141.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_fin_a_l_141);
  nodes["fin-a-l"] = node_fin_a_l_141;
  const mesh_fin_a_l_141Geometry = endpoint_fin_a_l_141
    ? new THREE.CylinderGeometry(endpoint_fin_a_l_141.endRadius, endpoint_fin_a_l_141.baseRadius, endpoint_fin_a_l_141.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.0068, "rz": 0.0126, "twist": 0.0}, {"position": [0.07874, 0.08976, -0.03307], "rx": 0.01512, "rz": 0.04724, "twist": 0.0}, {"position": [0.15748, 0.17953, -0.06614], "rx": 0.0189, "rz": 0.06299, "twist": 0.0}, {"position": [0.23622, 0.26929, -0.09921], "rx": 0.01587, "rz": 0.05039, "twist": 0.0}, {"position": [0.31496, 0.35906, -0.13228], "rx": 0.0068, "rz": 0.0126, "twist": 0.0}], "radialSegments": 16, "capEnds": true});
  if (!endpoint_fin_a_l_141) {
    mesh_fin_a_l_141Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_fin_a_l_141 = new THREE.Mesh(
    mesh_fin_a_l_141Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_fin_a_l_141.name = "Fin blade A L";
  if (endpoint_fin_a_l_141) {
    mesh_fin_a_l_141.position.copy(endpoint_fin_a_l_141.midpoint);
    mesh_fin_a_l_141.quaternion.copy(endpoint_fin_a_l_141.quaternion);
  }
  mesh_fin_a_l_141.castShadow = options.castShadow ?? true;
  mesh_fin_a_l_141.receiveShadow = options.receiveShadow ?? true;
  mesh_fin_a_l_141.userData.sculptComponent = { id: "fin-a-l" };
  node_fin_a_l_141.add(mesh_fin_a_l_141);
  meshes["fin-a-l"] = mesh_fin_a_l_141;
  colliders["fin-a-l"] = {};
  destructionGroups["fins"] ??= [];
  destructionGroups["fins"].push(node_fin_a_l_141);

  const endpoint_fin_b_l_142 = makeAttachmentEndpoint(null);
  const node_fin_b_l_142 = new THREE.Group();
  node_fin_b_l_142.name = "Fin blade B L__pivot";
  node_fin_b_l_142.scale.set(1, 1, 1);
  if (endpoint_fin_b_l_142) {
    node_fin_b_l_142.position.copy(endpoint_fin_b_l_142.start);
    node_fin_b_l_142.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_fin_b_l_142.position.set(0.07559, 0.16378, -0.11339);
    node_fin_b_l_142.rotation.set(0.0, 0.0, 0.0);
  }
  node_fin_b_l_142.userData.sculptComponent = { id: "fin-b-l" };
  node_fin_b_l_142.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_fin_b_l_142);
  nodes["fin-b-l"] = node_fin_b_l_142;
  const mesh_fin_b_l_142Geometry = endpoint_fin_b_l_142
    ? new THREE.CylinderGeometry(endpoint_fin_b_l_142.endRadius, endpoint_fin_b_l_142.baseRadius, endpoint_fin_b_l_142.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.00567, "rz": 0.01008, "twist": 0.0}, {"position": [0.09921, 0.03622, -0.03622], "rx": 0.0126, "rz": 0.0378, "twist": 0.0}, {"position": [0.19843, 0.07244, -0.07244], "rx": 0.01575, "rz": 0.05039, "twist": 0.0}, {"position": [0.29764, 0.10866, -0.10866], "rx": 0.01323, "rz": 0.04032, "twist": 0.0}, {"position": [0.39685, 0.14488, -0.14488], "rx": 0.00567, "rz": 0.01008, "twist": 0.0}], "radialSegments": 16, "capEnds": true});
  if (!endpoint_fin_b_l_142) {
    mesh_fin_b_l_142Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_fin_b_l_142 = new THREE.Mesh(
    mesh_fin_b_l_142Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_fin_b_l_142.name = "Fin blade B L";
  if (endpoint_fin_b_l_142) {
    mesh_fin_b_l_142.position.copy(endpoint_fin_b_l_142.midpoint);
    mesh_fin_b_l_142.quaternion.copy(endpoint_fin_b_l_142.quaternion);
  }
  mesh_fin_b_l_142.castShadow = options.castShadow ?? true;
  mesh_fin_b_l_142.receiveShadow = options.receiveShadow ?? true;
  mesh_fin_b_l_142.userData.sculptComponent = { id: "fin-b-l" };
  node_fin_b_l_142.add(mesh_fin_b_l_142);
  meshes["fin-b-l"] = mesh_fin_b_l_142;
  colliders["fin-b-l"] = {};
  destructionGroups["fins"] ??= [];
  destructionGroups["fins"].push(node_fin_b_l_142);

  const endpoint_fin_c_l_143 = makeAttachmentEndpoint(null);
  const node_fin_c_l_143 = new THREE.Group();
  node_fin_c_l_143.name = "Fin blade C L__pivot";
  node_fin_c_l_143.scale.set(1, 1, 1);
  if (endpoint_fin_c_l_143) {
    node_fin_c_l_143.position.copy(endpoint_fin_c_l_143.start);
    node_fin_c_l_143.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_fin_c_l_143.position.set(0.09449, -0.09449, -0.06929);
    node_fin_c_l_143.rotation.set(0.0, 0.0, 0.0);
  }
  node_fin_c_l_143.userData.sculptComponent = { id: "fin-c-l" };
  node_fin_c_l_143.userData.actionProfile = {};
  (nodes["pelvis"] ?? root).add(node_fin_c_l_143);
  nodes["fin-c-l"] = node_fin_c_l_143;
  const mesh_fin_c_l_143Geometry = endpoint_fin_c_l_143
    ? new THREE.CylinderGeometry(endpoint_fin_c_l_143.endRadius, endpoint_fin_c_l_143.baseRadius, endpoint_fin_c_l_143.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.0068, "rz": 0.01134, "twist": 0.0}, {"position": [0.08189, -0.07087, -0.0252], "rx": 0.01512, "rz": 0.04252, "twist": 0.0}, {"position": [0.16378, -0.14173, -0.05039], "rx": 0.0189, "rz": 0.05669, "twist": 0.0}, {"position": [0.24567, -0.2126, -0.07559], "rx": 0.01587, "rz": 0.04535, "twist": 0.0}, {"position": [0.32756, -0.28346, -0.10079], "rx": 0.0068, "rz": 0.01134, "twist": 0.0}], "radialSegments": 16, "capEnds": true});
  if (!endpoint_fin_c_l_143) {
    mesh_fin_c_l_143Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_fin_c_l_143 = new THREE.Mesh(
    mesh_fin_c_l_143Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_fin_c_l_143.name = "Fin blade C L";
  if (endpoint_fin_c_l_143) {
    mesh_fin_c_l_143.position.copy(endpoint_fin_c_l_143.midpoint);
    mesh_fin_c_l_143.quaternion.copy(endpoint_fin_c_l_143.quaternion);
  }
  mesh_fin_c_l_143.castShadow = options.castShadow ?? true;
  mesh_fin_c_l_143.receiveShadow = options.receiveShadow ?? true;
  mesh_fin_c_l_143.userData.sculptComponent = { id: "fin-c-l" };
  node_fin_c_l_143.add(mesh_fin_c_l_143);
  meshes["fin-c-l"] = mesh_fin_c_l_143;
  colliders["fin-c-l"] = {};
  destructionGroups["fins"] ??= [];
  destructionGroups["fins"].push(node_fin_c_l_143);

  const endpoint_fin_d_l_144 = makeAttachmentEndpoint(null);
  const node_fin_d_l_144 = new THREE.Group();
  node_fin_d_l_144.name = "Fin blade D L__pivot";
  node_fin_d_l_144.scale.set(1, 1, 1);
  if (endpoint_fin_d_l_144) {
    node_fin_d_l_144.position.copy(endpoint_fin_d_l_144.start);
    node_fin_d_l_144.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_fin_d_l_144.position.set(0.07559, -0.15748, -0.05669);
    node_fin_d_l_144.rotation.set(0.0, 0.0, 0.0);
  }
  node_fin_d_l_144.userData.sculptComponent = { id: "fin-d-l" };
  node_fin_d_l_144.userData.actionProfile = {};
  (nodes["pelvis"] ?? root).add(node_fin_d_l_144);
  nodes["fin-d-l"] = node_fin_d_l_144;
  const mesh_fin_d_l_144Geometry = endpoint_fin_d_l_144
    ? new THREE.CylinderGeometry(endpoint_fin_d_l_144.endRadius, endpoint_fin_d_l_144.baseRadius, endpoint_fin_d_l_144.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.00567, "rz": 0.00882, "twist": 0.0}, {"position": [0.05669, -0.11811, -0.01732], "rx": 0.0126, "rz": 0.03307, "twist": 0.0}, {"position": [0.11339, -0.23622, -0.03465], "rx": 0.01575, "rz": 0.04409, "twist": 0.0}, {"position": [0.17008, -0.35433, -0.05197], "rx": 0.01323, "rz": 0.03528, "twist": 0.0}, {"position": [0.22677, -0.47244, -0.06929], "rx": 0.00567, "rz": 0.00882, "twist": 0.0}], "radialSegments": 16, "capEnds": true});
  if (!endpoint_fin_d_l_144) {
    mesh_fin_d_l_144Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_fin_d_l_144 = new THREE.Mesh(
    mesh_fin_d_l_144Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_fin_d_l_144.name = "Fin blade D L";
  if (endpoint_fin_d_l_144) {
    mesh_fin_d_l_144.position.copy(endpoint_fin_d_l_144.midpoint);
    mesh_fin_d_l_144.quaternion.copy(endpoint_fin_d_l_144.quaternion);
  }
  mesh_fin_d_l_144.castShadow = options.castShadow ?? true;
  mesh_fin_d_l_144.receiveShadow = options.receiveShadow ?? true;
  mesh_fin_d_l_144.userData.sculptComponent = { id: "fin-d-l" };
  node_fin_d_l_144.add(mesh_fin_d_l_144);
  meshes["fin-d-l"] = mesh_fin_d_l_144;
  colliders["fin-d-l"] = {};
  destructionGroups["fins"] ??= [];
  destructionGroups["fins"].push(node_fin_d_l_144);

  const endpoint_seam_fin_l_145 = makeAttachmentEndpoint(null);
  const node_seam_fin_l_145 = new THREE.Group();
  node_seam_fin_l_145.name = "Gold seam seam-fin-l__pivot";
  node_seam_fin_l_145.scale.set(1, 1, 1);
  if (endpoint_seam_fin_l_145) {
    node_seam_fin_l_145.position.copy(endpoint_seam_fin_l_145.start);
    node_seam_fin_l_145.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seam_fin_l_145.position.set(0.0, 0.0, 0.0);
    node_seam_fin_l_145.rotation.set(0.0, 0.0, 0.0);
  }
  node_seam_fin_l_145.userData.sculptComponent = { id: "seam-fin-l" };
  node_seam_fin_l_145.userData.actionProfile = {};
  (nodes["fin-a-l"] ?? root).add(node_seam_fin_l_145);
  nodes["seam-fin-l"] = node_seam_fin_l_145;
  const mesh_seam_fin_l_145Geometry = endpoint_seam_fin_l_145
    ? new THREE.CylinderGeometry(endpoint_seam_fin_l_145.endRadius, endpoint_seam_fin_l_145.baseRadius, endpoint_seam_fin_l_145.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.01222, -0.0, 0.00612], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [0.12457, 0.08976, -0.01946], "rx": 0.00567, "rz": 0.00567, "twist": 0.0}, {"position": [0.21858, 0.17953, -0.04913], "rx": 0.00567, "rz": 0.00567, "twist": 0.0}, {"position": [0.2851, 0.26929, -0.08493], "rx": 0.00567, "rz": 0.00567, "twist": 0.0}, {"position": [0.32718, 0.35906, -0.12616], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_seam_fin_l_145) {
    mesh_seam_fin_l_145Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seam_fin_l_145 = new THREE.Mesh(
    mesh_seam_fin_l_145Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seam_fin_l_145.name = "Gold seam seam-fin-l";
  if (endpoint_seam_fin_l_145) {
    mesh_seam_fin_l_145.position.copy(endpoint_seam_fin_l_145.midpoint);
    mesh_seam_fin_l_145.quaternion.copy(endpoint_seam_fin_l_145.quaternion);
  }
  mesh_seam_fin_l_145.castShadow = options.castShadow ?? true;
  mesh_seam_fin_l_145.receiveShadow = options.receiveShadow ?? true;
  mesh_seam_fin_l_145.userData.sculptComponent = { id: "seam-fin-l" };
  node_seam_fin_l_145.add(mesh_seam_fin_l_145);
  meshes["seam-fin-l"] = mesh_seam_fin_l_145;
  colliders["seam-fin-l"] = {};
  destructionGroups["fin-a-l"] ??= [];
  destructionGroups["fin-a-l"].push(node_seam_fin_l_145);

  const endpoint_seam_fin_c_l_146 = makeAttachmentEndpoint(null);
  const node_seam_fin_c_l_146 = new THREE.Group();
  node_seam_fin_c_l_146.name = "Gold seam seam-fin-c-l__pivot";
  node_seam_fin_c_l_146.scale.set(1, 1, 1);
  if (endpoint_seam_fin_c_l_146) {
    node_seam_fin_c_l_146.position.copy(endpoint_seam_fin_c_l_146.start);
    node_seam_fin_c_l_146.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seam_fin_c_l_146.position.set(0.0, 0.0, 0.0);
    node_seam_fin_c_l_146.rotation.set(0.0, 0.0, 0.0);
  }
  node_seam_fin_c_l_146.userData.sculptComponent = { id: "seam-fin-c-l" };
  node_seam_fin_c_l_146.userData.actionProfile = {};
  (nodes["fin-c-l"] ?? root).add(node_seam_fin_c_l_146);
  nodes["seam-fin-c-l"] = node_seam_fin_c_l_146;
  const mesh_seam_fin_c_l_146Geometry = endpoint_seam_fin_c_l_146
    ? new THREE.CylinderGeometry(endpoint_seam_fin_c_l_146.endRadius, endpoint_seam_fin_c_l_146.baseRadius, endpoint_seam_fin_c_l_146.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.011, -0.0, 0.00612], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [0.12313, -0.07087, -0.01159], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [0.21877, -0.14173, -0.03339], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [0.28966, -0.2126, -0.0613], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [0.33856, -0.28346, -0.09466], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_seam_fin_c_l_146) {
    mesh_seam_fin_c_l_146Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seam_fin_c_l_146 = new THREE.Mesh(
    mesh_seam_fin_c_l_146Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seam_fin_c_l_146.name = "Gold seam seam-fin-c-l";
  if (endpoint_seam_fin_c_l_146) {
    mesh_seam_fin_c_l_146.position.copy(endpoint_seam_fin_c_l_146.midpoint);
    mesh_seam_fin_c_l_146.quaternion.copy(endpoint_seam_fin_c_l_146.quaternion);
  }
  mesh_seam_fin_c_l_146.castShadow = options.castShadow ?? true;
  mesh_seam_fin_c_l_146.receiveShadow = options.receiveShadow ?? true;
  mesh_seam_fin_c_l_146.userData.sculptComponent = { id: "seam-fin-c-l" };
  node_seam_fin_c_l_146.add(mesh_seam_fin_c_l_146);
  meshes["seam-fin-c-l"] = mesh_seam_fin_c_l_146;
  colliders["seam-fin-c-l"] = {};
  destructionGroups["fin-c-l"] ??= [];
  destructionGroups["fin-c-l"].push(node_seam_fin_c_l_146);

  const endpoint_fin_a_r_147 = makeAttachmentEndpoint(null);
  const node_fin_a_r_147 = new THREE.Group();
  node_fin_a_r_147.name = "Fin blade A R__pivot";
  node_fin_a_r_147.scale.set(1, 1, 1);
  if (endpoint_fin_a_r_147) {
    node_fin_a_r_147.position.copy(endpoint_fin_a_r_147.start);
    node_fin_a_r_147.rotation.set(0.0, -0.0, 0.0);
  } else {
    node_fin_a_r_147.position.set(-0.08819, 0.21417, -0.10709);
    node_fin_a_r_147.rotation.set(0.0, -0.0, 0.0);
  }
  node_fin_a_r_147.userData.sculptComponent = { id: "fin-a-r" };
  node_fin_a_r_147.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_fin_a_r_147);
  nodes["fin-a-r"] = node_fin_a_r_147;
  const mesh_fin_a_r_147Geometry = endpoint_fin_a_r_147
    ? new THREE.CylinderGeometry(endpoint_fin_a_r_147.endRadius, endpoint_fin_a_r_147.baseRadius, endpoint_fin_a_r_147.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.0068, "rz": 0.0126, "twist": 0.0}, {"position": [-0.07874, 0.08976, -0.03307], "rx": 0.01512, "rz": 0.04724, "twist": 0.0}, {"position": [-0.15748, 0.17953, -0.06614], "rx": 0.0189, "rz": 0.06299, "twist": 0.0}, {"position": [-0.23622, 0.26929, -0.09921], "rx": 0.01587, "rz": 0.05039, "twist": 0.0}, {"position": [-0.31496, 0.35906, -0.13228], "rx": 0.0068, "rz": 0.0126, "twist": 0.0}], "radialSegments": 16, "capEnds": true});
  if (!endpoint_fin_a_r_147) {
    mesh_fin_a_r_147Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_fin_a_r_147 = new THREE.Mesh(
    mesh_fin_a_r_147Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_fin_a_r_147.name = "Fin blade A R";
  if (endpoint_fin_a_r_147) {
    mesh_fin_a_r_147.position.copy(endpoint_fin_a_r_147.midpoint);
    mesh_fin_a_r_147.quaternion.copy(endpoint_fin_a_r_147.quaternion);
  }
  mesh_fin_a_r_147.castShadow = options.castShadow ?? true;
  mesh_fin_a_r_147.receiveShadow = options.receiveShadow ?? true;
  mesh_fin_a_r_147.userData.sculptComponent = { id: "fin-a-r" };
  node_fin_a_r_147.add(mesh_fin_a_r_147);
  meshes["fin-a-r"] = mesh_fin_a_r_147;
  colliders["fin-a-r"] = {};
  destructionGroups["fins"] ??= [];
  destructionGroups["fins"].push(node_fin_a_r_147);

  const endpoint_fin_b_r_148 = makeAttachmentEndpoint(null);
  const node_fin_b_r_148 = new THREE.Group();
  node_fin_b_r_148.name = "Fin blade B R__pivot";
  node_fin_b_r_148.scale.set(1, 1, 1);
  if (endpoint_fin_b_r_148) {
    node_fin_b_r_148.position.copy(endpoint_fin_b_r_148.start);
    node_fin_b_r_148.rotation.set(0.0, -0.0, 0.0);
  } else {
    node_fin_b_r_148.position.set(-0.07559, 0.16378, -0.11339);
    node_fin_b_r_148.rotation.set(0.0, -0.0, 0.0);
  }
  node_fin_b_r_148.userData.sculptComponent = { id: "fin-b-r" };
  node_fin_b_r_148.userData.actionProfile = {};
  (nodes["chest"] ?? root).add(node_fin_b_r_148);
  nodes["fin-b-r"] = node_fin_b_r_148;
  const mesh_fin_b_r_148Geometry = endpoint_fin_b_r_148
    ? new THREE.CylinderGeometry(endpoint_fin_b_r_148.endRadius, endpoint_fin_b_r_148.baseRadius, endpoint_fin_b_r_148.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.00567, "rz": 0.01008, "twist": 0.0}, {"position": [-0.09921, 0.03622, -0.03622], "rx": 0.0126, "rz": 0.0378, "twist": 0.0}, {"position": [-0.19843, 0.07244, -0.07244], "rx": 0.01575, "rz": 0.05039, "twist": 0.0}, {"position": [-0.29764, 0.10866, -0.10866], "rx": 0.01323, "rz": 0.04032, "twist": 0.0}, {"position": [-0.39685, 0.14488, -0.14488], "rx": 0.00567, "rz": 0.01008, "twist": 0.0}], "radialSegments": 16, "capEnds": true});
  if (!endpoint_fin_b_r_148) {
    mesh_fin_b_r_148Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_fin_b_r_148 = new THREE.Mesh(
    mesh_fin_b_r_148Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_fin_b_r_148.name = "Fin blade B R";
  if (endpoint_fin_b_r_148) {
    mesh_fin_b_r_148.position.copy(endpoint_fin_b_r_148.midpoint);
    mesh_fin_b_r_148.quaternion.copy(endpoint_fin_b_r_148.quaternion);
  }
  mesh_fin_b_r_148.castShadow = options.castShadow ?? true;
  mesh_fin_b_r_148.receiveShadow = options.receiveShadow ?? true;
  mesh_fin_b_r_148.userData.sculptComponent = { id: "fin-b-r" };
  node_fin_b_r_148.add(mesh_fin_b_r_148);
  meshes["fin-b-r"] = mesh_fin_b_r_148;
  colliders["fin-b-r"] = {};
  destructionGroups["fins"] ??= [];
  destructionGroups["fins"].push(node_fin_b_r_148);

  const endpoint_fin_c_r_149 = makeAttachmentEndpoint(null);
  const node_fin_c_r_149 = new THREE.Group();
  node_fin_c_r_149.name = "Fin blade C R__pivot";
  node_fin_c_r_149.scale.set(1, 1, 1);
  if (endpoint_fin_c_r_149) {
    node_fin_c_r_149.position.copy(endpoint_fin_c_r_149.start);
    node_fin_c_r_149.rotation.set(0.0, -0.0, 0.0);
  } else {
    node_fin_c_r_149.position.set(-0.09449, -0.09449, -0.06929);
    node_fin_c_r_149.rotation.set(0.0, -0.0, 0.0);
  }
  node_fin_c_r_149.userData.sculptComponent = { id: "fin-c-r" };
  node_fin_c_r_149.userData.actionProfile = {};
  (nodes["pelvis"] ?? root).add(node_fin_c_r_149);
  nodes["fin-c-r"] = node_fin_c_r_149;
  const mesh_fin_c_r_149Geometry = endpoint_fin_c_r_149
    ? new THREE.CylinderGeometry(endpoint_fin_c_r_149.endRadius, endpoint_fin_c_r_149.baseRadius, endpoint_fin_c_r_149.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.0068, "rz": 0.01134, "twist": 0.0}, {"position": [-0.08189, -0.07087, -0.0252], "rx": 0.01512, "rz": 0.04252, "twist": 0.0}, {"position": [-0.16378, -0.14173, -0.05039], "rx": 0.0189, "rz": 0.05669, "twist": 0.0}, {"position": [-0.24567, -0.2126, -0.07559], "rx": 0.01587, "rz": 0.04535, "twist": 0.0}, {"position": [-0.32756, -0.28346, -0.10079], "rx": 0.0068, "rz": 0.01134, "twist": 0.0}], "radialSegments": 16, "capEnds": true});
  if (!endpoint_fin_c_r_149) {
    mesh_fin_c_r_149Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_fin_c_r_149 = new THREE.Mesh(
    mesh_fin_c_r_149Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_fin_c_r_149.name = "Fin blade C R";
  if (endpoint_fin_c_r_149) {
    mesh_fin_c_r_149.position.copy(endpoint_fin_c_r_149.midpoint);
    mesh_fin_c_r_149.quaternion.copy(endpoint_fin_c_r_149.quaternion);
  }
  mesh_fin_c_r_149.castShadow = options.castShadow ?? true;
  mesh_fin_c_r_149.receiveShadow = options.receiveShadow ?? true;
  mesh_fin_c_r_149.userData.sculptComponent = { id: "fin-c-r" };
  node_fin_c_r_149.add(mesh_fin_c_r_149);
  meshes["fin-c-r"] = mesh_fin_c_r_149;
  colliders["fin-c-r"] = {};
  destructionGroups["fins"] ??= [];
  destructionGroups["fins"].push(node_fin_c_r_149);

  const endpoint_fin_d_r_150 = makeAttachmentEndpoint(null);
  const node_fin_d_r_150 = new THREE.Group();
  node_fin_d_r_150.name = "Fin blade D R__pivot";
  node_fin_d_r_150.scale.set(1, 1, 1);
  if (endpoint_fin_d_r_150) {
    node_fin_d_r_150.position.copy(endpoint_fin_d_r_150.start);
    node_fin_d_r_150.rotation.set(0.0, -0.0, 0.0);
  } else {
    node_fin_d_r_150.position.set(-0.07559, -0.15748, -0.05669);
    node_fin_d_r_150.rotation.set(0.0, -0.0, 0.0);
  }
  node_fin_d_r_150.userData.sculptComponent = { id: "fin-d-r" };
  node_fin_d_r_150.userData.actionProfile = {};
  (nodes["pelvis"] ?? root).add(node_fin_d_r_150);
  nodes["fin-d-r"] = node_fin_d_r_150;
  const mesh_fin_d_r_150Geometry = endpoint_fin_d_r_150
    ? new THREE.CylinderGeometry(endpoint_fin_d_r_150.endRadius, endpoint_fin_d_r_150.baseRadius, endpoint_fin_d_r_150.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.0, 0.0], "rx": 0.00567, "rz": 0.00882, "twist": 0.0}, {"position": [-0.05669, -0.11811, -0.01732], "rx": 0.0126, "rz": 0.03307, "twist": 0.0}, {"position": [-0.11339, -0.23622, -0.03465], "rx": 0.01575, "rz": 0.04409, "twist": 0.0}, {"position": [-0.17008, -0.35433, -0.05197], "rx": 0.01323, "rz": 0.03528, "twist": 0.0}, {"position": [-0.22677, -0.47244, -0.06929], "rx": 0.00567, "rz": 0.00882, "twist": 0.0}], "radialSegments": 16, "capEnds": true});
  if (!endpoint_fin_d_r_150) {
    mesh_fin_d_r_150Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_fin_d_r_150 = new THREE.Mesh(
    mesh_fin_d_r_150Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_fin_d_r_150.name = "Fin blade D R";
  if (endpoint_fin_d_r_150) {
    mesh_fin_d_r_150.position.copy(endpoint_fin_d_r_150.midpoint);
    mesh_fin_d_r_150.quaternion.copy(endpoint_fin_d_r_150.quaternion);
  }
  mesh_fin_d_r_150.castShadow = options.castShadow ?? true;
  mesh_fin_d_r_150.receiveShadow = options.receiveShadow ?? true;
  mesh_fin_d_r_150.userData.sculptComponent = { id: "fin-d-r" };
  node_fin_d_r_150.add(mesh_fin_d_r_150);
  meshes["fin-d-r"] = mesh_fin_d_r_150;
  colliders["fin-d-r"] = {};
  destructionGroups["fins"] ??= [];
  destructionGroups["fins"].push(node_fin_d_r_150);

  const endpoint_seam_fin_r_151 = makeAttachmentEndpoint(null);
  const node_seam_fin_r_151 = new THREE.Group();
  node_seam_fin_r_151.name = "Gold seam seam-fin-r__pivot";
  node_seam_fin_r_151.scale.set(1, 1, 1);
  if (endpoint_seam_fin_r_151) {
    node_seam_fin_r_151.position.copy(endpoint_seam_fin_r_151.start);
    node_seam_fin_r_151.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seam_fin_r_151.position.set(0.0, 0.0, 0.0);
    node_seam_fin_r_151.rotation.set(0.0, 0.0, 0.0);
  }
  node_seam_fin_r_151.userData.sculptComponent = { id: "seam-fin-r" };
  node_seam_fin_r_151.userData.actionProfile = {};
  (nodes["fin-a-r"] ?? root).add(node_seam_fin_r_151);
  nodes["seam-fin-r"] = node_seam_fin_r_151;
  const mesh_seam_fin_r_151Geometry = endpoint_seam_fin_r_151
    ? new THREE.CylinderGeometry(endpoint_seam_fin_r_151.endRadius, endpoint_seam_fin_r_151.baseRadius, endpoint_seam_fin_r_151.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.01222, -0.0, 0.00612], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [-0.12457, 0.08976, -0.01946], "rx": 0.00567, "rz": 0.00567, "twist": 0.0}, {"position": [-0.21858, 0.17953, -0.04913], "rx": 0.00567, "rz": 0.00567, "twist": 0.0}, {"position": [-0.2851, 0.26929, -0.08493], "rx": 0.00567, "rz": 0.00567, "twist": 0.0}, {"position": [-0.32718, 0.35906, -0.12616], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_seam_fin_r_151) {
    mesh_seam_fin_r_151Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seam_fin_r_151 = new THREE.Mesh(
    mesh_seam_fin_r_151Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seam_fin_r_151.name = "Gold seam seam-fin-r";
  if (endpoint_seam_fin_r_151) {
    mesh_seam_fin_r_151.position.copy(endpoint_seam_fin_r_151.midpoint);
    mesh_seam_fin_r_151.quaternion.copy(endpoint_seam_fin_r_151.quaternion);
  }
  mesh_seam_fin_r_151.castShadow = options.castShadow ?? true;
  mesh_seam_fin_r_151.receiveShadow = options.receiveShadow ?? true;
  mesh_seam_fin_r_151.userData.sculptComponent = { id: "seam-fin-r" };
  node_seam_fin_r_151.add(mesh_seam_fin_r_151);
  meshes["seam-fin-r"] = mesh_seam_fin_r_151;
  colliders["seam-fin-r"] = {};
  destructionGroups["fin-a-r"] ??= [];
  destructionGroups["fin-a-r"].push(node_seam_fin_r_151);

  const endpoint_seam_fin_c_r_152 = makeAttachmentEndpoint(null);
  const node_seam_fin_c_r_152 = new THREE.Group();
  node_seam_fin_c_r_152.name = "Gold seam seam-fin-c-r__pivot";
  node_seam_fin_c_r_152.scale.set(1, 1, 1);
  if (endpoint_seam_fin_c_r_152) {
    node_seam_fin_c_r_152.position.copy(endpoint_seam_fin_c_r_152.start);
    node_seam_fin_c_r_152.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seam_fin_c_r_152.position.set(0.0, 0.0, 0.0);
    node_seam_fin_c_r_152.rotation.set(0.0, 0.0, 0.0);
  }
  node_seam_fin_c_r_152.userData.sculptComponent = { id: "seam-fin-c-r" };
  node_seam_fin_c_r_152.userData.actionProfile = {};
  (nodes["fin-c-r"] ?? root).add(node_seam_fin_c_r_152);
  nodes["seam-fin-c-r"] = node_seam_fin_c_r_152;
  const mesh_seam_fin_c_r_152Geometry = endpoint_seam_fin_c_r_152
    ? new THREE.CylinderGeometry(endpoint_seam_fin_c_r_152.endRadius, endpoint_seam_fin_c_r_152.baseRadius, endpoint_seam_fin_c_r_152.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.011, -0.0, 0.00612], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [-0.12313, -0.07087, -0.01159], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [-0.21877, -0.14173, -0.03339], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [-0.28966, -0.2126, -0.0613], "rx": 0.00504, "rz": 0.00504, "twist": 0.0}, {"position": [-0.33856, -0.28346, -0.09466], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_seam_fin_c_r_152) {
    mesh_seam_fin_c_r_152Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seam_fin_c_r_152 = new THREE.Mesh(
    mesh_seam_fin_c_r_152Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seam_fin_c_r_152.name = "Gold seam seam-fin-c-r";
  if (endpoint_seam_fin_c_r_152) {
    mesh_seam_fin_c_r_152.position.copy(endpoint_seam_fin_c_r_152.midpoint);
    mesh_seam_fin_c_r_152.quaternion.copy(endpoint_seam_fin_c_r_152.quaternion);
  }
  mesh_seam_fin_c_r_152.castShadow = options.castShadow ?? true;
  mesh_seam_fin_c_r_152.receiveShadow = options.receiveShadow ?? true;
  mesh_seam_fin_c_r_152.userData.sculptComponent = { id: "seam-fin-c-r" };
  node_seam_fin_c_r_152.add(mesh_seam_fin_c_r_152);
  meshes["seam-fin-c-r"] = mesh_seam_fin_c_r_152;
  colliders["seam-fin-c-r"] = {};
  destructionGroups["fin-c-r"] ??= [];
  destructionGroups["fin-c-r"].push(node_seam_fin_c_r_152);

  const endpoint_prop_icon_insta_153 = makeAttachmentEndpoint(null);
  const node_prop_icon_insta_153 = new THREE.Group();
  node_prop_icon_insta_153.name = "Icon tile prop-icon-insta__pivot";
  node_prop_icon_insta_153.scale.set(1, 1, 1);
  if (endpoint_prop_icon_insta_153) {
    node_prop_icon_insta_153.position.copy(endpoint_prop_icon_insta_153.start);
    node_prop_icon_insta_153.rotation.set(0.0, 0.35, 0.05);
  } else {
    node_prop_icon_insta_153.position.set(-0.35276, 1.82677, 0.11339);
    node_prop_icon_insta_153.rotation.set(0.0, 0.35, 0.05);
  }
  node_prop_icon_insta_153.userData.sculptComponent = { id: "prop-icon-insta" };
  node_prop_icon_insta_153.userData.actionProfile = {};
  (nodes["root"] ?? root).add(node_prop_icon_insta_153);
  nodes["prop-icon-insta"] = node_prop_icon_insta_153;
  const mesh_prop_icon_insta_153Geometry = endpoint_prop_icon_insta_153
    ? new THREE.CylinderGeometry(endpoint_prop_icon_insta_153.endRadius, endpoint_prop_icon_insta_153.baseRadius, endpoint_prop_icon_insta_153.length, 8, 4)
    : buildExtrudeGeometry({"points": [[0.08189, 0.04586], [0.07915, 0.05965], [0.07134, 0.07134], [0.05965, 0.07915], [0.04586, 0.08189], [-0.04586, 0.08189], [-0.05965, 0.07915], [-0.07134, 0.07134], [-0.07915, 0.05965], [-0.08189, 0.04586], [-0.08189, -0.04586], [-0.07915, -0.05965], [-0.07134, -0.07134], [-0.05965, -0.07915], [-0.04586, -0.08189], [0.04586, -0.08189], [0.05965, -0.07915], [0.07134, -0.07134], [0.07915, -0.05965], [0.08189, -0.04586]], "depth": 0.00945});
  if (!endpoint_prop_icon_insta_153) {
    mesh_prop_icon_insta_153Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_prop_icon_insta_153 = new THREE.Mesh(
    mesh_prop_icon_insta_153Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_icon_insta_153.name = "Icon tile prop-icon-insta";
  if (endpoint_prop_icon_insta_153) {
    mesh_prop_icon_insta_153.position.copy(endpoint_prop_icon_insta_153.midpoint);
    mesh_prop_icon_insta_153.quaternion.copy(endpoint_prop_icon_insta_153.quaternion);
  }
  mesh_prop_icon_insta_153.castShadow = options.castShadow ?? true;
  mesh_prop_icon_insta_153.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_icon_insta_153.userData.sculptComponent = { id: "prop-icon-insta" };
  node_prop_icon_insta_153.add(mesh_prop_icon_insta_153);
  meshes["prop-icon-insta"] = mesh_prop_icon_insta_153;
  colliders["prop-icon-insta"] = {};
  destructionGroups["icons"] ??= [];
  destructionGroups["icons"].push(node_prop_icon_insta_153);

  const endpoint_prop_icon_insta_body_154 = makeAttachmentEndpoint(null);
  const node_prop_icon_insta_body_154 = new THREE.Group();
  node_prop_icon_insta_body_154.name = "Glyph prop-icon-insta body__pivot";
  node_prop_icon_insta_body_154.scale.set(1, 1, 1);
  if (endpoint_prop_icon_insta_body_154) {
    node_prop_icon_insta_body_154.position.copy(endpoint_prop_icon_insta_body_154.start);
    node_prop_icon_insta_body_154.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_icon_insta_body_154.position.set(0.0, 0.0, 0.01008);
    node_prop_icon_insta_body_154.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_icon_insta_body_154.userData.sculptComponent = { id: "prop-icon-insta-body" };
  node_prop_icon_insta_body_154.userData.actionProfile = {};
  (nodes["prop-icon-insta"] ?? root).add(node_prop_icon_insta_body_154);
  nodes["prop-icon-insta-body"] = node_prop_icon_insta_body_154;
  const mesh_prop_icon_insta_body_154Geometry = endpoint_prop_icon_insta_body_154
    ? new THREE.CylinderGeometry(endpoint_prop_icon_insta_body_154.endRadius, endpoint_prop_icon_insta_body_154.baseRadius, endpoint_prop_icon_insta_body_154.length, 8, 4)
    : buildExtrudeGeometry({"points": [[-0.03767, -0.02457], [0.03767, -0.02457], [0.03767, 0.02457], [-0.03767, 0.02457]], "depth": 0.0063, "holes": [[[0.01392, 0.0], [0.01206, 0.00696], [0.00696, 0.01206], [0.0, 0.01392], [-0.00696, 0.01206], [-0.01206, 0.00696], [-0.01392, 0.0], [-0.01206, -0.00696], [-0.00696, -0.01206], [-0.0, -0.01392], [0.00696, -0.01206], [0.01206, -0.00696]]]});
  if (!endpoint_prop_icon_insta_body_154) {
    mesh_prop_icon_insta_body_154Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_prop_icon_insta_body_154 = new THREE.Mesh(
    mesh_prop_icon_insta_body_154Geometry,
    materialMap["emblem-white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_icon_insta_body_154.name = "Glyph prop-icon-insta body";
  if (endpoint_prop_icon_insta_body_154) {
    mesh_prop_icon_insta_body_154.position.copy(endpoint_prop_icon_insta_body_154.midpoint);
    mesh_prop_icon_insta_body_154.quaternion.copy(endpoint_prop_icon_insta_body_154.quaternion);
  }
  mesh_prop_icon_insta_body_154.castShadow = options.castShadow ?? true;
  mesh_prop_icon_insta_body_154.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_icon_insta_body_154.userData.sculptComponent = { id: "prop-icon-insta-body" };
  node_prop_icon_insta_body_154.add(mesh_prop_icon_insta_body_154);
  meshes["prop-icon-insta-body"] = mesh_prop_icon_insta_body_154;
  colliders["prop-icon-insta-body"] = {};
  destructionGroups["icons"] ??= [];
  destructionGroups["icons"].push(node_prop_icon_insta_body_154);

  const endpoint_prop_icon_heart_155 = makeAttachmentEndpoint(null);
  const node_prop_icon_heart_155 = new THREE.Group();
  node_prop_icon_heart_155.name = "Icon tile prop-icon-heart__pivot";
  node_prop_icon_heart_155.scale.set(1, 1, 1);
  if (endpoint_prop_icon_heart_155) {
    node_prop_icon_heart_155.position.copy(endpoint_prop_icon_heart_155.start);
    node_prop_icon_heart_155.rotation.set(0.0, -0.35, -0.05);
  } else {
    node_prop_icon_heart_155.position.set(0.38425, 1.79528, 0.09449);
    node_prop_icon_heart_155.rotation.set(0.0, -0.35, -0.05);
  }
  node_prop_icon_heart_155.userData.sculptComponent = { id: "prop-icon-heart" };
  node_prop_icon_heart_155.userData.actionProfile = {};
  (nodes["root"] ?? root).add(node_prop_icon_heart_155);
  nodes["prop-icon-heart"] = node_prop_icon_heart_155;
  const mesh_prop_icon_heart_155Geometry = endpoint_prop_icon_heart_155
    ? new THREE.CylinderGeometry(endpoint_prop_icon_heart_155.endRadius, endpoint_prop_icon_heart_155.baseRadius, endpoint_prop_icon_heart_155.length, 8, 4)
    : buildExtrudeGeometry({"points": [[0.07244, 0.04057], [0.07001, 0.05276], [0.06311, 0.06311], [0.05276, 0.07001], [0.04057, 0.07244], [-0.04057, 0.07244], [-0.05276, 0.07001], [-0.06311, 0.06311], [-0.07001, 0.05276], [-0.07244, 0.04057], [-0.07244, -0.04057], [-0.07001, -0.05276], [-0.06311, -0.06311], [-0.05276, -0.07001], [-0.04057, -0.07244], [0.04057, -0.07244], [0.05276, -0.07001], [0.06311, -0.06311], [0.07001, -0.05276], [0.07244, -0.04057]], "depth": 0.00945});
  if (!endpoint_prop_icon_heart_155) {
    mesh_prop_icon_heart_155Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_prop_icon_heart_155 = new THREE.Mesh(
    mesh_prop_icon_heart_155Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_icon_heart_155.name = "Icon tile prop-icon-heart";
  if (endpoint_prop_icon_heart_155) {
    mesh_prop_icon_heart_155.position.copy(endpoint_prop_icon_heart_155.midpoint);
    mesh_prop_icon_heart_155.quaternion.copy(endpoint_prop_icon_heart_155.quaternion);
  }
  mesh_prop_icon_heart_155.castShadow = options.castShadow ?? true;
  mesh_prop_icon_heart_155.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_icon_heart_155.userData.sculptComponent = { id: "prop-icon-heart" };
  node_prop_icon_heart_155.add(mesh_prop_icon_heart_155);
  meshes["prop-icon-heart"] = mesh_prop_icon_heart_155;
  colliders["prop-icon-heart"] = {};
  destructionGroups["icons"] ??= [];
  destructionGroups["icons"].push(node_prop_icon_heart_155);

  const endpoint_prop_icon_heart_heart_156 = makeAttachmentEndpoint(null);
  const node_prop_icon_heart_heart_156 = new THREE.Group();
  node_prop_icon_heart_heart_156.name = "Glyph prop-icon-heart heart__pivot";
  node_prop_icon_heart_heart_156.scale.set(1, 1, 1);
  if (endpoint_prop_icon_heart_heart_156) {
    node_prop_icon_heart_heart_156.position.copy(endpoint_prop_icon_heart_heart_156.start);
    node_prop_icon_heart_heart_156.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_icon_heart_heart_156.position.set(0.0, 0.0, 0.01008);
    node_prop_icon_heart_heart_156.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_icon_heart_heart_156.userData.sculptComponent = { id: "prop-icon-heart-heart" };
  node_prop_icon_heart_heart_156.userData.actionProfile = {};
  (nodes["prop-icon-heart"] ?? root).add(node_prop_icon_heart_heart_156);
  nodes["prop-icon-heart-heart"] = node_prop_icon_heart_heart_156;
  const mesh_prop_icon_heart_heart_156Geometry = endpoint_prop_icon_heart_heart_156
    ? new THREE.CylinderGeometry(endpoint_prop_icon_heart_heart_156.endRadius, endpoint_prop_icon_heart_heart_156.baseRadius, endpoint_prop_icon_heart_heart_156.length, 8, 4)
    : buildExtrudeGeometry({"points": [[0.0, 0.00974], [0.00063, 0.01272], [0.00453, 0.01938], [0.01281, 0.0247], [0.02353, 0.02446], [0.03264, 0.01791], [0.03622, 0.00748], [0.03264, -0.00372], [0.02353, -0.01403], [0.01281, -0.02332], [0.00453, -0.03159], [0.00063, -0.03773], [0.0, -0.04006], [-0.00063, -0.03773], [-0.00453, -0.03159], [-0.01281, -0.02332], [-0.02353, -0.01403], [-0.03264, -0.00372], [-0.03622, 0.00748], [-0.03264, 0.01791], [-0.02353, 0.02446], [-0.01281, 0.0247], [-0.00453, 0.01938], [-0.00063, 0.01272]], "depth": 0.0063});
  if (!endpoint_prop_icon_heart_heart_156) {
    mesh_prop_icon_heart_heart_156Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_prop_icon_heart_heart_156 = new THREE.Mesh(
    mesh_prop_icon_heart_heart_156Geometry,
    materialMap["emblem-white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_icon_heart_heart_156.name = "Glyph prop-icon-heart heart";
  if (endpoint_prop_icon_heart_heart_156) {
    mesh_prop_icon_heart_heart_156.position.copy(endpoint_prop_icon_heart_heart_156.midpoint);
    mesh_prop_icon_heart_heart_156.quaternion.copy(endpoint_prop_icon_heart_heart_156.quaternion);
  }
  mesh_prop_icon_heart_heart_156.castShadow = options.castShadow ?? true;
  mesh_prop_icon_heart_heart_156.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_icon_heart_heart_156.userData.sculptComponent = { id: "prop-icon-heart-heart" };
  node_prop_icon_heart_heart_156.add(mesh_prop_icon_heart_heart_156);
  meshes["prop-icon-heart-heart"] = mesh_prop_icon_heart_heart_156;
  colliders["prop-icon-heart-heart"] = {};
  destructionGroups["icons"] ??= [];
  destructionGroups["icons"].push(node_prop_icon_heart_heart_156);

  const endpoint_prop_icon_play_157 = makeAttachmentEndpoint(null);
  const node_prop_icon_play_157 = new THREE.Group();
  node_prop_icon_play_157.name = "Icon tile prop-icon-play__pivot";
  node_prop_icon_play_157.scale.set(1, 1, 1);
  if (endpoint_prop_icon_play_157) {
    node_prop_icon_play_157.position.copy(endpoint_prop_icon_play_157.start);
    node_prop_icon_play_157.rotation.set(0.0, 0.4, 0.0);
  } else {
    node_prop_icon_play_157.position.set(-0.47874, 1.24095, 0.12598);
    node_prop_icon_play_157.rotation.set(0.0, 0.4, 0.0);
  }
  node_prop_icon_play_157.userData.sculptComponent = { id: "prop-icon-play" };
  node_prop_icon_play_157.userData.actionProfile = {};
  (nodes["root"] ?? root).add(node_prop_icon_play_157);
  nodes["prop-icon-play"] = node_prop_icon_play_157;
  const mesh_prop_icon_play_157Geometry = endpoint_prop_icon_play_157
    ? new THREE.CylinderGeometry(endpoint_prop_icon_play_157.endRadius, endpoint_prop_icon_play_157.baseRadius, endpoint_prop_icon_play_157.length, 8, 4)
    : buildExtrudeGeometry({"points": [[0.08819, 0.04939], [0.08524, 0.06424], [0.07682, 0.07682], [0.06424, 0.08524], [0.04939, 0.08819], [-0.04939, 0.08819], [-0.06424, 0.08524], [-0.07682, 0.07682], [-0.08524, 0.06424], [-0.08819, 0.04939], [-0.08819, -0.04939], [-0.08524, -0.06424], [-0.07682, -0.07682], [-0.06424, -0.08524], [-0.04939, -0.08819], [0.04939, -0.08819], [0.06424, -0.08524], [0.07682, -0.07682], [0.08524, -0.06424], [0.08819, -0.04939]], "depth": 0.00945});
  if (!endpoint_prop_icon_play_157) {
    mesh_prop_icon_play_157Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_prop_icon_play_157 = new THREE.Mesh(
    mesh_prop_icon_play_157Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_icon_play_157.name = "Icon tile prop-icon-play";
  if (endpoint_prop_icon_play_157) {
    mesh_prop_icon_play_157.position.copy(endpoint_prop_icon_play_157.midpoint);
    mesh_prop_icon_play_157.quaternion.copy(endpoint_prop_icon_play_157.quaternion);
  }
  mesh_prop_icon_play_157.castShadow = options.castShadow ?? true;
  mesh_prop_icon_play_157.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_icon_play_157.userData.sculptComponent = { id: "prop-icon-play" };
  node_prop_icon_play_157.add(mesh_prop_icon_play_157);
  meshes["prop-icon-play"] = mesh_prop_icon_play_157;
  colliders["prop-icon-play"] = {};
  destructionGroups["icons"] ??= [];
  destructionGroups["icons"].push(node_prop_icon_play_157);

  const endpoint_prop_icon_play_play_158 = makeAttachmentEndpoint(null);
  const node_prop_icon_play_play_158 = new THREE.Group();
  node_prop_icon_play_play_158.name = "Glyph prop-icon-play play__pivot";
  node_prop_icon_play_play_158.scale.set(1, 1, 1);
  if (endpoint_prop_icon_play_play_158) {
    node_prop_icon_play_play_158.position.copy(endpoint_prop_icon_play_play_158.start);
    node_prop_icon_play_play_158.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_icon_play_play_158.position.set(0.0, 0.0, 0.01008);
    node_prop_icon_play_play_158.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_icon_play_play_158.userData.sculptComponent = { id: "prop-icon-play-play" };
  node_prop_icon_play_play_158.userData.actionProfile = {};
  (nodes["prop-icon-play"] ?? root).add(node_prop_icon_play_play_158);
  nodes["prop-icon-play-play"] = node_prop_icon_play_play_158;
  const mesh_prop_icon_play_play_158Geometry = endpoint_prop_icon_play_play_158
    ? new THREE.CylinderGeometry(endpoint_prop_icon_play_play_158.endRadius, endpoint_prop_icon_play_play_158.baseRadius, endpoint_prop_icon_play_play_158.length, 8, 4)
    : buildExtrudeGeometry({"points": [[-0.02469, -0.03528], [-0.02469, 0.03528], [0.03528, 0.0]], "depth": 0.0063});
  if (!endpoint_prop_icon_play_play_158) {
    mesh_prop_icon_play_play_158Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_prop_icon_play_play_158 = new THREE.Mesh(
    mesh_prop_icon_play_play_158Geometry,
    materialMap["emblem-white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_icon_play_play_158.name = "Glyph prop-icon-play play";
  if (endpoint_prop_icon_play_play_158) {
    mesh_prop_icon_play_play_158.position.copy(endpoint_prop_icon_play_play_158.midpoint);
    mesh_prop_icon_play_play_158.quaternion.copy(endpoint_prop_icon_play_play_158.quaternion);
  }
  mesh_prop_icon_play_play_158.castShadow = options.castShadow ?? true;
  mesh_prop_icon_play_play_158.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_icon_play_play_158.userData.sculptComponent = { id: "prop-icon-play-play" };
  node_prop_icon_play_play_158.add(mesh_prop_icon_play_play_158);
  meshes["prop-icon-play-play"] = mesh_prop_icon_play_play_158;
  colliders["prop-icon-play-play"] = {};
  destructionGroups["icons"] ??= [];
  destructionGroups["icons"].push(node_prop_icon_play_play_158);

  const endpoint_prop_icon_tiktok_159 = makeAttachmentEndpoint(null);
  const node_prop_icon_tiktok_159 = new THREE.Group();
  node_prop_icon_tiktok_159.name = "Icon tile prop-icon-tiktok__pivot";
  node_prop_icon_tiktok_159.scale.set(1, 1, 1);
  if (endpoint_prop_icon_tiktok_159) {
    node_prop_icon_tiktok_159.position.copy(endpoint_prop_icon_tiktok_159.start);
    node_prop_icon_tiktok_159.rotation.set(0.0, 0.4, 0.0);
  } else {
    node_prop_icon_tiktok_159.position.set(-0.47244, 0.94488, 0.13858);
    node_prop_icon_tiktok_159.rotation.set(0.0, 0.4, 0.0);
  }
  node_prop_icon_tiktok_159.userData.sculptComponent = { id: "prop-icon-tiktok" };
  node_prop_icon_tiktok_159.userData.actionProfile = {};
  (nodes["root"] ?? root).add(node_prop_icon_tiktok_159);
  nodes["prop-icon-tiktok"] = node_prop_icon_tiktok_159;
  const mesh_prop_icon_tiktok_159Geometry = endpoint_prop_icon_tiktok_159
    ? new THREE.CylinderGeometry(endpoint_prop_icon_tiktok_159.endRadius, endpoint_prop_icon_tiktok_159.baseRadius, endpoint_prop_icon_tiktok_159.length, 8, 4)
    : buildExtrudeGeometry({"points": [[0.08819, 0.04939], [0.08524, 0.06424], [0.07682, 0.07682], [0.06424, 0.08524], [0.04939, 0.08819], [-0.04939, 0.08819], [-0.06424, 0.08524], [-0.07682, 0.07682], [-0.08524, 0.06424], [-0.08819, 0.04939], [-0.08819, -0.04939], [-0.08524, -0.06424], [-0.07682, -0.07682], [-0.06424, -0.08524], [-0.04939, -0.08819], [0.04939, -0.08819], [0.06424, -0.08524], [0.07682, -0.07682], [0.08524, -0.06424], [0.08819, -0.04939]], "depth": 0.00945});
  if (!endpoint_prop_icon_tiktok_159) {
    mesh_prop_icon_tiktok_159Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_prop_icon_tiktok_159 = new THREE.Mesh(
    mesh_prop_icon_tiktok_159Geometry,
    materialMap["tile-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_icon_tiktok_159.name = "Icon tile prop-icon-tiktok";
  if (endpoint_prop_icon_tiktok_159) {
    mesh_prop_icon_tiktok_159.position.copy(endpoint_prop_icon_tiktok_159.midpoint);
    mesh_prop_icon_tiktok_159.quaternion.copy(endpoint_prop_icon_tiktok_159.quaternion);
  }
  mesh_prop_icon_tiktok_159.castShadow = options.castShadow ?? true;
  mesh_prop_icon_tiktok_159.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_icon_tiktok_159.userData.sculptComponent = { id: "prop-icon-tiktok" };
  node_prop_icon_tiktok_159.add(mesh_prop_icon_tiktok_159);
  meshes["prop-icon-tiktok"] = mesh_prop_icon_tiktok_159;
  colliders["prop-icon-tiktok"] = {};
  destructionGroups["icons"] ??= [];
  destructionGroups["icons"].push(node_prop_icon_tiktok_159);

  const endpoint_prop_icon_tiktok_stem_160 = makeAttachmentEndpoint(null);
  const node_prop_icon_tiktok_stem_160 = new THREE.Group();
  node_prop_icon_tiktok_stem_160.name = "Glyph prop-icon-tiktok stem__pivot";
  node_prop_icon_tiktok_stem_160.scale.set(1, 1, 1);
  if (endpoint_prop_icon_tiktok_stem_160) {
    node_prop_icon_tiktok_stem_160.position.copy(endpoint_prop_icon_tiktok_stem_160.start);
    node_prop_icon_tiktok_stem_160.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_icon_tiktok_stem_160.position.set(0.0, 0.0, 0.01008);
    node_prop_icon_tiktok_stem_160.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_icon_tiktok_stem_160.userData.sculptComponent = { id: "prop-icon-tiktok-stem" };
  node_prop_icon_tiktok_stem_160.userData.actionProfile = {};
  (nodes["prop-icon-tiktok"] ?? root).add(node_prop_icon_tiktok_stem_160);
  nodes["prop-icon-tiktok-stem"] = node_prop_icon_tiktok_stem_160;
  const mesh_prop_icon_tiktok_stem_160Geometry = endpoint_prop_icon_tiktok_stem_160
    ? new THREE.CylinderGeometry(endpoint_prop_icon_tiktok_stem_160.endRadius, endpoint_prop_icon_tiktok_stem_160.baseRadius, endpoint_prop_icon_tiktok_stem_160.length, 8, 4)
    : buildExtrudeGeometry({"points": [[0.00441, -0.03528], [0.01499, -0.03528], [0.01499, 0.03969], [0.00441, 0.03969]], "depth": 0.0063});
  if (!endpoint_prop_icon_tiktok_stem_160) {
    mesh_prop_icon_tiktok_stem_160Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_prop_icon_tiktok_stem_160 = new THREE.Mesh(
    mesh_prop_icon_tiktok_stem_160Geometry,
    materialMap["emblem-white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_icon_tiktok_stem_160.name = "Glyph prop-icon-tiktok stem";
  if (endpoint_prop_icon_tiktok_stem_160) {
    mesh_prop_icon_tiktok_stem_160.position.copy(endpoint_prop_icon_tiktok_stem_160.midpoint);
    mesh_prop_icon_tiktok_stem_160.quaternion.copy(endpoint_prop_icon_tiktok_stem_160.quaternion);
  }
  mesh_prop_icon_tiktok_stem_160.castShadow = options.castShadow ?? true;
  mesh_prop_icon_tiktok_stem_160.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_icon_tiktok_stem_160.userData.sculptComponent = { id: "prop-icon-tiktok-stem" };
  node_prop_icon_tiktok_stem_160.add(mesh_prop_icon_tiktok_stem_160);
  meshes["prop-icon-tiktok-stem"] = mesh_prop_icon_tiktok_stem_160;
  colliders["prop-icon-tiktok-stem"] = {};
  destructionGroups["icons"] ??= [];
  destructionGroups["icons"].push(node_prop_icon_tiktok_stem_160);

  const endpoint_prop_icon_tiktok_head_161 = makeAttachmentEndpoint(null);
  const node_prop_icon_tiktok_head_161 = new THREE.Group();
  node_prop_icon_tiktok_head_161.name = "Glyph prop-icon-tiktok head__pivot";
  node_prop_icon_tiktok_head_161.scale.set(1, 1, 1);
  if (endpoint_prop_icon_tiktok_head_161) {
    node_prop_icon_tiktok_head_161.position.copy(endpoint_prop_icon_tiktok_head_161.start);
    node_prop_icon_tiktok_head_161.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_icon_tiktok_head_161.position.set(0.0, 0.0, 0.01008);
    node_prop_icon_tiktok_head_161.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_icon_tiktok_head_161.userData.sculptComponent = { id: "prop-icon-tiktok-head" };
  node_prop_icon_tiktok_head_161.userData.actionProfile = {};
  (nodes["prop-icon-tiktok"] ?? root).add(node_prop_icon_tiktok_head_161);
  nodes["prop-icon-tiktok-head"] = node_prop_icon_tiktok_head_161;
  const mesh_prop_icon_tiktok_head_161Geometry = endpoint_prop_icon_tiktok_head_161
    ? new THREE.CylinderGeometry(endpoint_prop_icon_tiktok_head_161.endRadius, endpoint_prop_icon_tiktok_head_161.baseRadius, endpoint_prop_icon_tiktok_head_161.length, 8, 4)
    : buildExtrudeGeometry({"points": [[0.00441, -0.02646], [0.0024, -0.01896], [-0.00309, -0.01347], [-0.01058, -0.01146], [-0.01808, -0.01347], [-0.02357, -0.01896], [-0.02557, -0.02646], [-0.02357, -0.03395], [-0.01808, -0.03944], [-0.01058, -0.04145], [-0.00309, -0.03944], [0.0024, -0.03395]], "depth": 0.0063});
  if (!endpoint_prop_icon_tiktok_head_161) {
    mesh_prop_icon_tiktok_head_161Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_prop_icon_tiktok_head_161 = new THREE.Mesh(
    mesh_prop_icon_tiktok_head_161Geometry,
    materialMap["emblem-white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_icon_tiktok_head_161.name = "Glyph prop-icon-tiktok head";
  if (endpoint_prop_icon_tiktok_head_161) {
    mesh_prop_icon_tiktok_head_161.position.copy(endpoint_prop_icon_tiktok_head_161.midpoint);
    mesh_prop_icon_tiktok_head_161.quaternion.copy(endpoint_prop_icon_tiktok_head_161.quaternion);
  }
  mesh_prop_icon_tiktok_head_161.castShadow = options.castShadow ?? true;
  mesh_prop_icon_tiktok_head_161.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_icon_tiktok_head_161.userData.sculptComponent = { id: "prop-icon-tiktok-head" };
  node_prop_icon_tiktok_head_161.add(mesh_prop_icon_tiktok_head_161);
  meshes["prop-icon-tiktok-head"] = mesh_prop_icon_tiktok_head_161;
  colliders["prop-icon-tiktok-head"] = {};
  destructionGroups["icons"] ??= [];
  destructionGroups["icons"].push(node_prop_icon_tiktok_head_161);

  const endpoint_prop_icon_heart2_162 = makeAttachmentEndpoint(null);
  const node_prop_icon_heart2_162 = new THREE.Group();
  node_prop_icon_heart2_162.name = "Icon tile prop-icon-heart2__pivot";
  node_prop_icon_heart2_162.scale.set(1, 1, 1);
  if (endpoint_prop_icon_heart2_162) {
    node_prop_icon_heart2_162.position.copy(endpoint_prop_icon_heart2_162.start);
    node_prop_icon_heart2_162.rotation.set(0.0, -0.4, 0.0);
  } else {
    node_prop_icon_heart2_162.position.set(0.49134, 0.61732, 0.10079);
    node_prop_icon_heart2_162.rotation.set(0.0, -0.4, 0.0);
  }
  node_prop_icon_heart2_162.userData.sculptComponent = { id: "prop-icon-heart2" };
  node_prop_icon_heart2_162.userData.actionProfile = {};
  (nodes["root"] ?? root).add(node_prop_icon_heart2_162);
  nodes["prop-icon-heart2"] = node_prop_icon_heart2_162;
  const mesh_prop_icon_heart2_162Geometry = endpoint_prop_icon_heart2_162
    ? new THREE.CylinderGeometry(endpoint_prop_icon_heart2_162.endRadius, endpoint_prop_icon_heart2_162.baseRadius, endpoint_prop_icon_heart2_162.length, 8, 4)
    : buildExtrudeGeometry({"points": [[0.08819, 0.04939], [0.08524, 0.06424], [0.07682, 0.07682], [0.06424, 0.08524], [0.04939, 0.08819], [-0.04939, 0.08819], [-0.06424, 0.08524], [-0.07682, 0.07682], [-0.08524, 0.06424], [-0.08819, 0.04939], [-0.08819, -0.04939], [-0.08524, -0.06424], [-0.07682, -0.07682], [-0.06424, -0.08524], [-0.04939, -0.08819], [0.04939, -0.08819], [0.06424, -0.08524], [0.07682, -0.07682], [0.08524, -0.06424], [0.08819, -0.04939]], "depth": 0.00945});
  if (!endpoint_prop_icon_heart2_162) {
    mesh_prop_icon_heart2_162Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_prop_icon_heart2_162 = new THREE.Mesh(
    mesh_prop_icon_heart2_162Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_icon_heart2_162.name = "Icon tile prop-icon-heart2";
  if (endpoint_prop_icon_heart2_162) {
    mesh_prop_icon_heart2_162.position.copy(endpoint_prop_icon_heart2_162.midpoint);
    mesh_prop_icon_heart2_162.quaternion.copy(endpoint_prop_icon_heart2_162.quaternion);
  }
  mesh_prop_icon_heart2_162.castShadow = options.castShadow ?? true;
  mesh_prop_icon_heart2_162.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_icon_heart2_162.userData.sculptComponent = { id: "prop-icon-heart2" };
  node_prop_icon_heart2_162.add(mesh_prop_icon_heart2_162);
  meshes["prop-icon-heart2"] = mesh_prop_icon_heart2_162;
  colliders["prop-icon-heart2"] = {};
  destructionGroups["icons"] ??= [];
  destructionGroups["icons"].push(node_prop_icon_heart2_162);

  const endpoint_prop_icon_heart2_heart_163 = makeAttachmentEndpoint(null);
  const node_prop_icon_heart2_heart_163 = new THREE.Group();
  node_prop_icon_heart2_heart_163.name = "Glyph prop-icon-heart2 heart__pivot";
  node_prop_icon_heart2_heart_163.scale.set(1, 1, 1);
  if (endpoint_prop_icon_heart2_heart_163) {
    node_prop_icon_heart2_heart_163.position.copy(endpoint_prop_icon_heart2_heart_163.start);
    node_prop_icon_heart2_heart_163.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_icon_heart2_heart_163.position.set(0.0, 0.0, 0.01008);
    node_prop_icon_heart2_heart_163.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_icon_heart2_heart_163.userData.sculptComponent = { id: "prop-icon-heart2-heart" };
  node_prop_icon_heart2_heart_163.userData.actionProfile = {};
  (nodes["prop-icon-heart2"] ?? root).add(node_prop_icon_heart2_heart_163);
  nodes["prop-icon-heart2-heart"] = node_prop_icon_heart2_heart_163;
  const mesh_prop_icon_heart2_heart_163Geometry = endpoint_prop_icon_heart2_heart_163
    ? new THREE.CylinderGeometry(endpoint_prop_icon_heart2_heart_163.endRadius, endpoint_prop_icon_heart2_heart_163.baseRadius, endpoint_prop_icon_heart2_heart_163.length, 8, 4)
    : buildExtrudeGeometry({"points": [[0.0, 0.0122], [0.00076, 0.01582], [0.00551, 0.02394], [0.01559, 0.03041], [0.02864, 0.03012], [0.03974, 0.02215], [0.04409, 0.00945], [0.03974, -0.00419], [0.02864, -0.01673], [0.01559, -0.02805], [0.00551, -0.03811], [0.00076, -0.04559], [0.0, -0.04843], [-0.00076, -0.04559], [-0.00551, -0.03811], [-0.01559, -0.02805], [-0.02864, -0.01673], [-0.03974, -0.00419], [-0.04409, 0.00945], [-0.03974, 0.02215], [-0.02864, 0.03012], [-0.01559, 0.03041], [-0.00551, 0.02394], [-0.00076, 0.01582]], "depth": 0.0063});
  if (!endpoint_prop_icon_heart2_heart_163) {
    mesh_prop_icon_heart2_heart_163Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_prop_icon_heart2_heart_163 = new THREE.Mesh(
    mesh_prop_icon_heart2_heart_163Geometry,
    materialMap["emblem-white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_icon_heart2_heart_163.name = "Glyph prop-icon-heart2 heart";
  if (endpoint_prop_icon_heart2_heart_163) {
    mesh_prop_icon_heart2_heart_163.position.copy(endpoint_prop_icon_heart2_heart_163.midpoint);
    mesh_prop_icon_heart2_heart_163.quaternion.copy(endpoint_prop_icon_heart2_heart_163.quaternion);
  }
  mesh_prop_icon_heart2_heart_163.castShadow = options.castShadow ?? true;
  mesh_prop_icon_heart2_heart_163.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_icon_heart2_heart_163.userData.sculptComponent = { id: "prop-icon-heart2-heart" };
  node_prop_icon_heart2_heart_163.add(mesh_prop_icon_heart2_heart_163);
  meshes["prop-icon-heart2-heart"] = mesh_prop_icon_heart2_heart_163;
  colliders["prop-icon-heart2-heart"] = {};
  destructionGroups["icons"] ??= [];
  destructionGroups["icons"].push(node_prop_icon_heart2_heart_163);

  const endpoint_prop_icon_bars_164 = makeAttachmentEndpoint(null);
  const node_prop_icon_bars_164 = new THREE.Group();
  node_prop_icon_bars_164.name = "Icon tile prop-icon-bars__pivot";
  node_prop_icon_bars_164.scale.set(1, 1, 1);
  if (endpoint_prop_icon_bars_164) {
    node_prop_icon_bars_164.position.copy(endpoint_prop_icon_bars_164.start);
    node_prop_icon_bars_164.rotation.set(0.0, 2.74159, 0.0);
  } else {
    node_prop_icon_bars_164.position.set(0.35276, 1.44882, -0.28976);
    node_prop_icon_bars_164.rotation.set(0.0, 2.74159, 0.0);
  }
  node_prop_icon_bars_164.userData.sculptComponent = { id: "prop-icon-bars" };
  node_prop_icon_bars_164.userData.actionProfile = {};
  (nodes["root"] ?? root).add(node_prop_icon_bars_164);
  nodes["prop-icon-bars"] = node_prop_icon_bars_164;
  const mesh_prop_icon_bars_164Geometry = endpoint_prop_icon_bars_164
    ? new THREE.CylinderGeometry(endpoint_prop_icon_bars_164.endRadius, endpoint_prop_icon_bars_164.baseRadius, endpoint_prop_icon_bars_164.length, 8, 4)
    : buildExtrudeGeometry({"points": [[0.07874, 0.04409], [0.0761, 0.05735], [0.06859, 0.06859], [0.05735, 0.0761], [0.04409, 0.07874], [-0.04409, 0.07874], [-0.05735, 0.0761], [-0.06859, 0.06859], [-0.0761, 0.05735], [-0.07874, 0.04409], [-0.07874, -0.04409], [-0.0761, -0.05735], [-0.06859, -0.06859], [-0.05735, -0.0761], [-0.04409, -0.07874], [0.04409, -0.07874], [0.05735, -0.0761], [0.06859, -0.06859], [0.0761, -0.05735], [0.07874, -0.04409]], "depth": 0.00945});
  if (!endpoint_prop_icon_bars_164) {
    mesh_prop_icon_bars_164Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_prop_icon_bars_164 = new THREE.Mesh(
    mesh_prop_icon_bars_164Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_icon_bars_164.name = "Icon tile prop-icon-bars";
  if (endpoint_prop_icon_bars_164) {
    mesh_prop_icon_bars_164.position.copy(endpoint_prop_icon_bars_164.midpoint);
    mesh_prop_icon_bars_164.quaternion.copy(endpoint_prop_icon_bars_164.quaternion);
  }
  mesh_prop_icon_bars_164.castShadow = options.castShadow ?? true;
  mesh_prop_icon_bars_164.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_icon_bars_164.userData.sculptComponent = { id: "prop-icon-bars" };
  node_prop_icon_bars_164.add(mesh_prop_icon_bars_164);
  meshes["prop-icon-bars"] = mesh_prop_icon_bars_164;
  colliders["prop-icon-bars"] = {};
  destructionGroups["icons"] ??= [];
  destructionGroups["icons"].push(node_prop_icon_bars_164);

  const endpoint_prop_icon_bars_bar0_165 = makeAttachmentEndpoint(null);
  const node_prop_icon_bars_bar0_165 = new THREE.Group();
  node_prop_icon_bars_bar0_165.name = "Glyph prop-icon-bars bar0__pivot";
  node_prop_icon_bars_bar0_165.scale.set(1, 1, 1);
  if (endpoint_prop_icon_bars_bar0_165) {
    node_prop_icon_bars_bar0_165.position.copy(endpoint_prop_icon_bars_bar0_165.start);
    node_prop_icon_bars_bar0_165.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_icon_bars_bar0_165.position.set(0.0, 0.0, 0.01008);
    node_prop_icon_bars_bar0_165.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_icon_bars_bar0_165.userData.sculptComponent = { id: "prop-icon-bars-bar0" };
  node_prop_icon_bars_bar0_165.userData.actionProfile = {};
  (nodes["prop-icon-bars"] ?? root).add(node_prop_icon_bars_bar0_165);
  nodes["prop-icon-bars-bar0"] = node_prop_icon_bars_bar0_165;
  const mesh_prop_icon_bars_bar0_165Geometry = endpoint_prop_icon_bars_bar0_165
    ? new THREE.CylinderGeometry(endpoint_prop_icon_bars_bar0_165.endRadius, endpoint_prop_icon_bars_bar0_165.baseRadius, endpoint_prop_icon_bars_bar0_165.length, 8, 4)
    : buildExtrudeGeometry({"points": [[-0.02598, -0.0315], [-0.01811, -0.0315], [-0.01811, -0.00787], [-0.02598, -0.00787]], "depth": 0.0063});
  if (!endpoint_prop_icon_bars_bar0_165) {
    mesh_prop_icon_bars_bar0_165Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_prop_icon_bars_bar0_165 = new THREE.Mesh(
    mesh_prop_icon_bars_bar0_165Geometry,
    materialMap["emblem-white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_icon_bars_bar0_165.name = "Glyph prop-icon-bars bar0";
  if (endpoint_prop_icon_bars_bar0_165) {
    mesh_prop_icon_bars_bar0_165.position.copy(endpoint_prop_icon_bars_bar0_165.midpoint);
    mesh_prop_icon_bars_bar0_165.quaternion.copy(endpoint_prop_icon_bars_bar0_165.quaternion);
  }
  mesh_prop_icon_bars_bar0_165.castShadow = options.castShadow ?? true;
  mesh_prop_icon_bars_bar0_165.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_icon_bars_bar0_165.userData.sculptComponent = { id: "prop-icon-bars-bar0" };
  node_prop_icon_bars_bar0_165.add(mesh_prop_icon_bars_bar0_165);
  meshes["prop-icon-bars-bar0"] = mesh_prop_icon_bars_bar0_165;
  colliders["prop-icon-bars-bar0"] = {};
  destructionGroups["icons"] ??= [];
  destructionGroups["icons"].push(node_prop_icon_bars_bar0_165);

  const endpoint_prop_icon_bars_bar1_166 = makeAttachmentEndpoint(null);
  const node_prop_icon_bars_bar1_166 = new THREE.Group();
  node_prop_icon_bars_bar1_166.name = "Glyph prop-icon-bars bar1__pivot";
  node_prop_icon_bars_bar1_166.scale.set(1, 1, 1);
  if (endpoint_prop_icon_bars_bar1_166) {
    node_prop_icon_bars_bar1_166.position.copy(endpoint_prop_icon_bars_bar1_166.start);
    node_prop_icon_bars_bar1_166.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_icon_bars_bar1_166.position.set(0.0, 0.0, 0.01008);
    node_prop_icon_bars_bar1_166.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_icon_bars_bar1_166.userData.sculptComponent = { id: "prop-icon-bars-bar1" };
  node_prop_icon_bars_bar1_166.userData.actionProfile = {};
  (nodes["prop-icon-bars"] ?? root).add(node_prop_icon_bars_bar1_166);
  nodes["prop-icon-bars-bar1"] = node_prop_icon_bars_bar1_166;
  const mesh_prop_icon_bars_bar1_166Geometry = endpoint_prop_icon_bars_bar1_166
    ? new THREE.CylinderGeometry(endpoint_prop_icon_bars_bar1_166.endRadius, endpoint_prop_icon_bars_bar1_166.baseRadius, endpoint_prop_icon_bars_bar1_166.length, 8, 4)
    : buildExtrudeGeometry({"points": [[-0.00394, -0.0315], [0.00394, -0.0315], [0.00394, 0.01181], [-0.00394, 0.01181]], "depth": 0.0063});
  if (!endpoint_prop_icon_bars_bar1_166) {
    mesh_prop_icon_bars_bar1_166Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_prop_icon_bars_bar1_166 = new THREE.Mesh(
    mesh_prop_icon_bars_bar1_166Geometry,
    materialMap["emblem-white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_icon_bars_bar1_166.name = "Glyph prop-icon-bars bar1";
  if (endpoint_prop_icon_bars_bar1_166) {
    mesh_prop_icon_bars_bar1_166.position.copy(endpoint_prop_icon_bars_bar1_166.midpoint);
    mesh_prop_icon_bars_bar1_166.quaternion.copy(endpoint_prop_icon_bars_bar1_166.quaternion);
  }
  mesh_prop_icon_bars_bar1_166.castShadow = options.castShadow ?? true;
  mesh_prop_icon_bars_bar1_166.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_icon_bars_bar1_166.userData.sculptComponent = { id: "prop-icon-bars-bar1" };
  node_prop_icon_bars_bar1_166.add(mesh_prop_icon_bars_bar1_166);
  meshes["prop-icon-bars-bar1"] = mesh_prop_icon_bars_bar1_166;
  colliders["prop-icon-bars-bar1"] = {};
  destructionGroups["icons"] ??= [];
  destructionGroups["icons"].push(node_prop_icon_bars_bar1_166);

  const endpoint_prop_icon_bars_bar2_167 = makeAttachmentEndpoint(null);
  const node_prop_icon_bars_bar2_167 = new THREE.Group();
  node_prop_icon_bars_bar2_167.name = "Glyph prop-icon-bars bar2__pivot";
  node_prop_icon_bars_bar2_167.scale.set(1, 1, 1);
  if (endpoint_prop_icon_bars_bar2_167) {
    node_prop_icon_bars_bar2_167.position.copy(endpoint_prop_icon_bars_bar2_167.start);
    node_prop_icon_bars_bar2_167.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_icon_bars_bar2_167.position.set(0.0, 0.0, 0.01008);
    node_prop_icon_bars_bar2_167.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_icon_bars_bar2_167.userData.sculptComponent = { id: "prop-icon-bars-bar2" };
  node_prop_icon_bars_bar2_167.userData.actionProfile = {};
  (nodes["prop-icon-bars"] ?? root).add(node_prop_icon_bars_bar2_167);
  nodes["prop-icon-bars-bar2"] = node_prop_icon_bars_bar2_167;
  const mesh_prop_icon_bars_bar2_167Geometry = endpoint_prop_icon_bars_bar2_167
    ? new THREE.CylinderGeometry(endpoint_prop_icon_bars_bar2_167.endRadius, endpoint_prop_icon_bars_bar2_167.baseRadius, endpoint_prop_icon_bars_bar2_167.length, 8, 4)
    : buildExtrudeGeometry({"points": [[0.01811, -0.0315], [0.02598, -0.0315], [0.02598, 0.0315], [0.01811, 0.0315]], "depth": 0.0063});
  if (!endpoint_prop_icon_bars_bar2_167) {
    mesh_prop_icon_bars_bar2_167Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_prop_icon_bars_bar2_167 = new THREE.Mesh(
    mesh_prop_icon_bars_bar2_167Geometry,
    materialMap["emblem-white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_icon_bars_bar2_167.name = "Glyph prop-icon-bars bar2";
  if (endpoint_prop_icon_bars_bar2_167) {
    mesh_prop_icon_bars_bar2_167.position.copy(endpoint_prop_icon_bars_bar2_167.midpoint);
    mesh_prop_icon_bars_bar2_167.quaternion.copy(endpoint_prop_icon_bars_bar2_167.quaternion);
  }
  mesh_prop_icon_bars_bar2_167.castShadow = options.castShadow ?? true;
  mesh_prop_icon_bars_bar2_167.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_icon_bars_bar2_167.userData.sculptComponent = { id: "prop-icon-bars-bar2" };
  node_prop_icon_bars_bar2_167.add(mesh_prop_icon_bars_bar2_167);
  meshes["prop-icon-bars-bar2"] = mesh_prop_icon_bars_bar2_167;
  colliders["prop-icon-bars-bar2"] = {};
  destructionGroups["icons"] ??= [];
  destructionGroups["icons"].push(node_prop_icon_bars_bar2_167);

  const endpoint_prop_icon_heart3_168 = makeAttachmentEndpoint(null);
  const node_prop_icon_heart3_168 = new THREE.Group();
  node_prop_icon_heart3_168.name = "Icon tile prop-icon-heart3__pivot";
  node_prop_icon_heart3_168.scale.set(1, 1, 1);
  if (endpoint_prop_icon_heart3_168) {
    node_prop_icon_heart3_168.position.copy(endpoint_prop_icon_heart3_168.start);
    node_prop_icon_heart3_168.rotation.set(0.0, 3.54159, 0.0);
  } else {
    node_prop_icon_heart3_168.position.set(-0.34646, 1.19685, -0.28976);
    node_prop_icon_heart3_168.rotation.set(0.0, 3.54159, 0.0);
  }
  node_prop_icon_heart3_168.userData.sculptComponent = { id: "prop-icon-heart3" };
  node_prop_icon_heart3_168.userData.actionProfile = {};
  (nodes["root"] ?? root).add(node_prop_icon_heart3_168);
  nodes["prop-icon-heart3"] = node_prop_icon_heart3_168;
  const mesh_prop_icon_heart3_168Geometry = endpoint_prop_icon_heart3_168
    ? new THREE.CylinderGeometry(endpoint_prop_icon_heart3_168.endRadius, endpoint_prop_icon_heart3_168.baseRadius, endpoint_prop_icon_heart3_168.length, 8, 4)
    : buildExtrudeGeometry({"points": [[0.07244, 0.04057], [0.07001, 0.05276], [0.06311, 0.06311], [0.05276, 0.07001], [0.04057, 0.07244], [-0.04057, 0.07244], [-0.05276, 0.07001], [-0.06311, 0.06311], [-0.07001, 0.05276], [-0.07244, 0.04057], [-0.07244, -0.04057], [-0.07001, -0.05276], [-0.06311, -0.06311], [-0.05276, -0.07001], [-0.04057, -0.07244], [0.04057, -0.07244], [0.05276, -0.07001], [0.06311, -0.06311], [0.07001, -0.05276], [0.07244, -0.04057]], "depth": 0.00945});
  if (!endpoint_prop_icon_heart3_168) {
    mesh_prop_icon_heart3_168Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_prop_icon_heart3_168 = new THREE.Mesh(
    mesh_prop_icon_heart3_168Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_icon_heart3_168.name = "Icon tile prop-icon-heart3";
  if (endpoint_prop_icon_heart3_168) {
    mesh_prop_icon_heart3_168.position.copy(endpoint_prop_icon_heart3_168.midpoint);
    mesh_prop_icon_heart3_168.quaternion.copy(endpoint_prop_icon_heart3_168.quaternion);
  }
  mesh_prop_icon_heart3_168.castShadow = options.castShadow ?? true;
  mesh_prop_icon_heart3_168.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_icon_heart3_168.userData.sculptComponent = { id: "prop-icon-heart3" };
  node_prop_icon_heart3_168.add(mesh_prop_icon_heart3_168);
  meshes["prop-icon-heart3"] = mesh_prop_icon_heart3_168;
  colliders["prop-icon-heart3"] = {};
  destructionGroups["icons"] ??= [];
  destructionGroups["icons"].push(node_prop_icon_heart3_168);

  const endpoint_prop_icon_heart3_heart_169 = makeAttachmentEndpoint(null);
  const node_prop_icon_heart3_heart_169 = new THREE.Group();
  node_prop_icon_heart3_heart_169.name = "Glyph prop-icon-heart3 heart__pivot";
  node_prop_icon_heart3_heart_169.scale.set(1, 1, 1);
  if (endpoint_prop_icon_heart3_heart_169) {
    node_prop_icon_heart3_heart_169.position.copy(endpoint_prop_icon_heart3_heart_169.start);
    node_prop_icon_heart3_heart_169.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_icon_heart3_heart_169.position.set(0.0, 0.0, 0.01008);
    node_prop_icon_heart3_heart_169.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_icon_heart3_heart_169.userData.sculptComponent = { id: "prop-icon-heart3-heart" };
  node_prop_icon_heart3_heart_169.userData.actionProfile = {};
  (nodes["prop-icon-heart3"] ?? root).add(node_prop_icon_heart3_heart_169);
  nodes["prop-icon-heart3-heart"] = node_prop_icon_heart3_heart_169;
  const mesh_prop_icon_heart3_heart_169Geometry = endpoint_prop_icon_heart3_heart_169
    ? new THREE.CylinderGeometry(endpoint_prop_icon_heart3_heart_169.endRadius, endpoint_prop_icon_heart3_heart_169.baseRadius, endpoint_prop_icon_heart3_heart_169.length, 8, 4)
    : buildExtrudeGeometry({"points": [[0.0, 0.00974], [0.00063, 0.01272], [0.00453, 0.01938], [0.01281, 0.0247], [0.02353, 0.02446], [0.03264, 0.01791], [0.03622, 0.00748], [0.03264, -0.00372], [0.02353, -0.01403], [0.01281, -0.02332], [0.00453, -0.03159], [0.00063, -0.03773], [0.0, -0.04006], [-0.00063, -0.03773], [-0.00453, -0.03159], [-0.01281, -0.02332], [-0.02353, -0.01403], [-0.03264, -0.00372], [-0.03622, 0.00748], [-0.03264, 0.01791], [-0.02353, 0.02446], [-0.01281, 0.0247], [-0.00453, 0.01938], [-0.00063, 0.01272]], "depth": 0.0063});
  if (!endpoint_prop_icon_heart3_heart_169) {
    mesh_prop_icon_heart3_heart_169Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_prop_icon_heart3_heart_169 = new THREE.Mesh(
    mesh_prop_icon_heart3_heart_169Geometry,
    materialMap["emblem-white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_icon_heart3_heart_169.name = "Glyph prop-icon-heart3 heart";
  if (endpoint_prop_icon_heart3_heart_169) {
    mesh_prop_icon_heart3_heart_169.position.copy(endpoint_prop_icon_heart3_heart_169.midpoint);
    mesh_prop_icon_heart3_heart_169.quaternion.copy(endpoint_prop_icon_heart3_heart_169.quaternion);
  }
  mesh_prop_icon_heart3_heart_169.castShadow = options.castShadow ?? true;
  mesh_prop_icon_heart3_heart_169.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_icon_heart3_heart_169.userData.sculptComponent = { id: "prop-icon-heart3-heart" };
  node_prop_icon_heart3_heart_169.add(mesh_prop_icon_heart3_heart_169);
  meshes["prop-icon-heart3-heart"] = mesh_prop_icon_heart3_heart_169;
  colliders["prop-icon-heart3-heart"] = {};
  destructionGroups["icons"] ??= [];
  destructionGroups["icons"].push(node_prop_icon_heart3_heart_169);

  const endpoint_prop_panel_chart_170 = makeAttachmentEndpoint(null);
  const node_prop_panel_chart_170 = new THREE.Group();
  node_prop_panel_chart_170.name = "Holo panel prop-panel-chart__pivot";
  node_prop_panel_chart_170.scale.set(1, 1, 1);
  if (endpoint_prop_panel_chart_170) {
    node_prop_panel_chart_170.position.copy(endpoint_prop_panel_chart_170.start);
    node_prop_panel_chart_170.rotation.set(0.0, -0.5, 0.0);
  } else {
    node_prop_panel_chart_170.position.set(0.58583, 1.37323, 0.12598);
    node_prop_panel_chart_170.rotation.set(0.0, -0.5, 0.0);
  }
  node_prop_panel_chart_170.userData.sculptComponent = { id: "prop-panel-chart" };
  node_prop_panel_chart_170.userData.actionProfile = {};
  (nodes["root"] ?? root).add(node_prop_panel_chart_170);
  nodes["prop-panel-chart"] = node_prop_panel_chart_170;
  const mesh_prop_panel_chart_170Geometry = endpoint_prop_panel_chart_170
    ? new THREE.CylinderGeometry(endpoint_prop_panel_chart_170.endRadius, endpoint_prop_panel_chart_170.baseRadius, endpoint_prop_panel_chart_170.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_chart_170) {
    mesh_prop_panel_chart_170Geometry.scale(0.21417, 0.23307, 0.00504);
  }
  const mesh_prop_panel_chart_170 = new THREE.Mesh(
    mesh_prop_panel_chart_170Geometry,
    materialMap["holo-panel"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_chart_170.name = "Holo panel prop-panel-chart";
  if (endpoint_prop_panel_chart_170) {
    mesh_prop_panel_chart_170.position.copy(endpoint_prop_panel_chart_170.midpoint);
    mesh_prop_panel_chart_170.quaternion.copy(endpoint_prop_panel_chart_170.quaternion);
  }
  mesh_prop_panel_chart_170.castShadow = options.castShadow ?? true;
  mesh_prop_panel_chart_170.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_chart_170.userData.sculptComponent = { id: "prop-panel-chart" };
  node_prop_panel_chart_170.add(mesh_prop_panel_chart_170);
  meshes["prop-panel-chart"] = mesh_prop_panel_chart_170;
  colliders["prop-panel-chart"] = {};
  destructionGroups["icons"] ??= [];
  destructionGroups["icons"].push(node_prop_panel_chart_170);

  const endpoint_prop_panel_chart_edge0_171 = makeAttachmentEndpoint(null);
  const node_prop_panel_chart_edge0_171 = new THREE.Group();
  node_prop_panel_chart_edge0_171.name = "Panel edge prop-panel-chart 0__pivot";
  node_prop_panel_chart_edge0_171.scale.set(1, 1, 1);
  if (endpoint_prop_panel_chart_edge0_171) {
    node_prop_panel_chart_edge0_171.position.copy(endpoint_prop_panel_chart_edge0_171.start);
    node_prop_panel_chart_edge0_171.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_chart_edge0_171.position.set(0.0, 0.11654, 0.0);
    node_prop_panel_chart_edge0_171.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_chart_edge0_171.userData.sculptComponent = { id: "prop-panel-chart-edge0" };
  node_prop_panel_chart_edge0_171.userData.actionProfile = {};
  (nodes["prop-panel-chart"] ?? root).add(node_prop_panel_chart_edge0_171);
  nodes["prop-panel-chart-edge0"] = node_prop_panel_chart_edge0_171;
  const mesh_prop_panel_chart_edge0_171Geometry = endpoint_prop_panel_chart_edge0_171
    ? new THREE.CylinderGeometry(endpoint_prop_panel_chart_edge0_171.endRadius, endpoint_prop_panel_chart_edge0_171.baseRadius, endpoint_prop_panel_chart_edge0_171.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_chart_edge0_171) {
    mesh_prop_panel_chart_edge0_171Geometry.scale(0.21417, 0.00441, 0.00504);
  }
  const mesh_prop_panel_chart_edge0_171 = new THREE.Mesh(
    mesh_prop_panel_chart_edge0_171Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_chart_edge0_171.name = "Panel edge prop-panel-chart 0";
  if (endpoint_prop_panel_chart_edge0_171) {
    mesh_prop_panel_chart_edge0_171.position.copy(endpoint_prop_panel_chart_edge0_171.midpoint);
    mesh_prop_panel_chart_edge0_171.quaternion.copy(endpoint_prop_panel_chart_edge0_171.quaternion);
  }
  mesh_prop_panel_chart_edge0_171.castShadow = options.castShadow ?? true;
  mesh_prop_panel_chart_edge0_171.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_chart_edge0_171.userData.sculptComponent = { id: "prop-panel-chart-edge0" };
  node_prop_panel_chart_edge0_171.add(mesh_prop_panel_chart_edge0_171);
  meshes["prop-panel-chart-edge0"] = mesh_prop_panel_chart_edge0_171;
  colliders["prop-panel-chart-edge0"] = {};
  destructionGroups["icons"] ??= [];
  destructionGroups["icons"].push(node_prop_panel_chart_edge0_171);

  const endpoint_prop_panel_chart_edge1_172 = makeAttachmentEndpoint(null);
  const node_prop_panel_chart_edge1_172 = new THREE.Group();
  node_prop_panel_chart_edge1_172.name = "Panel edge prop-panel-chart 1__pivot";
  node_prop_panel_chart_edge1_172.scale.set(1, 1, 1);
  if (endpoint_prop_panel_chart_edge1_172) {
    node_prop_panel_chart_edge1_172.position.copy(endpoint_prop_panel_chart_edge1_172.start);
    node_prop_panel_chart_edge1_172.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_chart_edge1_172.position.set(0.0, -0.11654, 0.0);
    node_prop_panel_chart_edge1_172.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_chart_edge1_172.userData.sculptComponent = { id: "prop-panel-chart-edge1" };
  node_prop_panel_chart_edge1_172.userData.actionProfile = {};
  (nodes["prop-panel-chart"] ?? root).add(node_prop_panel_chart_edge1_172);
  nodes["prop-panel-chart-edge1"] = node_prop_panel_chart_edge1_172;
  const mesh_prop_panel_chart_edge1_172Geometry = endpoint_prop_panel_chart_edge1_172
    ? new THREE.CylinderGeometry(endpoint_prop_panel_chart_edge1_172.endRadius, endpoint_prop_panel_chart_edge1_172.baseRadius, endpoint_prop_panel_chart_edge1_172.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_chart_edge1_172) {
    mesh_prop_panel_chart_edge1_172Geometry.scale(0.21417, 0.00441, 0.00504);
  }
  const mesh_prop_panel_chart_edge1_172 = new THREE.Mesh(
    mesh_prop_panel_chart_edge1_172Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_chart_edge1_172.name = "Panel edge prop-panel-chart 1";
  if (endpoint_prop_panel_chart_edge1_172) {
    mesh_prop_panel_chart_edge1_172.position.copy(endpoint_prop_panel_chart_edge1_172.midpoint);
    mesh_prop_panel_chart_edge1_172.quaternion.copy(endpoint_prop_panel_chart_edge1_172.quaternion);
  }
  mesh_prop_panel_chart_edge1_172.castShadow = options.castShadow ?? true;
  mesh_prop_panel_chart_edge1_172.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_chart_edge1_172.userData.sculptComponent = { id: "prop-panel-chart-edge1" };
  node_prop_panel_chart_edge1_172.add(mesh_prop_panel_chart_edge1_172);
  meshes["prop-panel-chart-edge1"] = mesh_prop_panel_chart_edge1_172;
  colliders["prop-panel-chart-edge1"] = {};
  destructionGroups["icons"] ??= [];
  destructionGroups["icons"].push(node_prop_panel_chart_edge1_172);

  const endpoint_prop_panel_chart_edge2_173 = makeAttachmentEndpoint(null);
  const node_prop_panel_chart_edge2_173 = new THREE.Group();
  node_prop_panel_chart_edge2_173.name = "Panel edge prop-panel-chart 2__pivot";
  node_prop_panel_chart_edge2_173.scale.set(1, 1, 1);
  if (endpoint_prop_panel_chart_edge2_173) {
    node_prop_panel_chart_edge2_173.position.copy(endpoint_prop_panel_chart_edge2_173.start);
    node_prop_panel_chart_edge2_173.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_chart_edge2_173.position.set(-0.10709, 0.0, 0.0);
    node_prop_panel_chart_edge2_173.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_chart_edge2_173.userData.sculptComponent = { id: "prop-panel-chart-edge2" };
  node_prop_panel_chart_edge2_173.userData.actionProfile = {};
  (nodes["prop-panel-chart"] ?? root).add(node_prop_panel_chart_edge2_173);
  nodes["prop-panel-chart-edge2"] = node_prop_panel_chart_edge2_173;
  const mesh_prop_panel_chart_edge2_173Geometry = endpoint_prop_panel_chart_edge2_173
    ? new THREE.CylinderGeometry(endpoint_prop_panel_chart_edge2_173.endRadius, endpoint_prop_panel_chart_edge2_173.baseRadius, endpoint_prop_panel_chart_edge2_173.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_chart_edge2_173) {
    mesh_prop_panel_chart_edge2_173Geometry.scale(0.00441, 0.23307, 0.00504);
  }
  const mesh_prop_panel_chart_edge2_173 = new THREE.Mesh(
    mesh_prop_panel_chart_edge2_173Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_chart_edge2_173.name = "Panel edge prop-panel-chart 2";
  if (endpoint_prop_panel_chart_edge2_173) {
    mesh_prop_panel_chart_edge2_173.position.copy(endpoint_prop_panel_chart_edge2_173.midpoint);
    mesh_prop_panel_chart_edge2_173.quaternion.copy(endpoint_prop_panel_chart_edge2_173.quaternion);
  }
  mesh_prop_panel_chart_edge2_173.castShadow = options.castShadow ?? true;
  mesh_prop_panel_chart_edge2_173.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_chart_edge2_173.userData.sculptComponent = { id: "prop-panel-chart-edge2" };
  node_prop_panel_chart_edge2_173.add(mesh_prop_panel_chart_edge2_173);
  meshes["prop-panel-chart-edge2"] = mesh_prop_panel_chart_edge2_173;
  colliders["prop-panel-chart-edge2"] = {};
  destructionGroups["icons"] ??= [];
  destructionGroups["icons"].push(node_prop_panel_chart_edge2_173);

  const endpoint_prop_panel_chart_edge3_174 = makeAttachmentEndpoint(null);
  const node_prop_panel_chart_edge3_174 = new THREE.Group();
  node_prop_panel_chart_edge3_174.name = "Panel edge prop-panel-chart 3__pivot";
  node_prop_panel_chart_edge3_174.scale.set(1, 1, 1);
  if (endpoint_prop_panel_chart_edge3_174) {
    node_prop_panel_chart_edge3_174.position.copy(endpoint_prop_panel_chart_edge3_174.start);
    node_prop_panel_chart_edge3_174.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_chart_edge3_174.position.set(0.10709, 0.0, 0.0);
    node_prop_panel_chart_edge3_174.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_chart_edge3_174.userData.sculptComponent = { id: "prop-panel-chart-edge3" };
  node_prop_panel_chart_edge3_174.userData.actionProfile = {};
  (nodes["prop-panel-chart"] ?? root).add(node_prop_panel_chart_edge3_174);
  nodes["prop-panel-chart-edge3"] = node_prop_panel_chart_edge3_174;
  const mesh_prop_panel_chart_edge3_174Geometry = endpoint_prop_panel_chart_edge3_174
    ? new THREE.CylinderGeometry(endpoint_prop_panel_chart_edge3_174.endRadius, endpoint_prop_panel_chart_edge3_174.baseRadius, endpoint_prop_panel_chart_edge3_174.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_chart_edge3_174) {
    mesh_prop_panel_chart_edge3_174Geometry.scale(0.00441, 0.23307, 0.00504);
  }
  const mesh_prop_panel_chart_edge3_174 = new THREE.Mesh(
    mesh_prop_panel_chart_edge3_174Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_chart_edge3_174.name = "Panel edge prop-panel-chart 3";
  if (endpoint_prop_panel_chart_edge3_174) {
    mesh_prop_panel_chart_edge3_174.position.copy(endpoint_prop_panel_chart_edge3_174.midpoint);
    mesh_prop_panel_chart_edge3_174.quaternion.copy(endpoint_prop_panel_chart_edge3_174.quaternion);
  }
  mesh_prop_panel_chart_edge3_174.castShadow = options.castShadow ?? true;
  mesh_prop_panel_chart_edge3_174.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_chart_edge3_174.userData.sculptComponent = { id: "prop-panel-chart-edge3" };
  node_prop_panel_chart_edge3_174.add(mesh_prop_panel_chart_edge3_174);
  meshes["prop-panel-chart-edge3"] = mesh_prop_panel_chart_edge3_174;
  colliders["prop-panel-chart-edge3"] = {};
  destructionGroups["icons"] ??= [];
  destructionGroups["icons"].push(node_prop_panel_chart_edge3_174);

  const endpoint_prop_panel_chart_bar0_175 = makeAttachmentEndpoint(null);
  const node_prop_panel_chart_bar0_175 = new THREE.Group();
  node_prop_panel_chart_bar0_175.name = "Chart bar prop-panel-chart 0__pivot";
  node_prop_panel_chart_bar0_175.scale.set(1, 1, 1);
  if (endpoint_prop_panel_chart_bar0_175) {
    node_prop_panel_chart_bar0_175.position.copy(endpoint_prop_panel_chart_bar0_175.start);
    node_prop_panel_chart_bar0_175.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_chart_bar0_175.position.set(-0.0771, -0.05827, 0.00378);
    node_prop_panel_chart_bar0_175.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_chart_bar0_175.userData.sculptComponent = { id: "prop-panel-chart-bar0" };
  node_prop_panel_chart_bar0_175.userData.actionProfile = {};
  (nodes["prop-panel-chart"] ?? root).add(node_prop_panel_chart_bar0_175);
  nodes["prop-panel-chart-bar0"] = node_prop_panel_chart_bar0_175;
  const mesh_prop_panel_chart_bar0_175Geometry = endpoint_prop_panel_chart_bar0_175
    ? new THREE.CylinderGeometry(endpoint_prop_panel_chart_bar0_175.endRadius, endpoint_prop_panel_chart_bar0_175.baseRadius, endpoint_prop_panel_chart_bar0_175.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_chart_bar0_175) {
    mesh_prop_panel_chart_bar0_175Geometry.scale(0.01499, 0.04195, 0.00567);
  }
  const mesh_prop_panel_chart_bar0_175 = new THREE.Mesh(
    mesh_prop_panel_chart_bar0_175Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_chart_bar0_175.name = "Chart bar prop-panel-chart 0";
  if (endpoint_prop_panel_chart_bar0_175) {
    mesh_prop_panel_chart_bar0_175.position.copy(endpoint_prop_panel_chart_bar0_175.midpoint);
    mesh_prop_panel_chart_bar0_175.quaternion.copy(endpoint_prop_panel_chart_bar0_175.quaternion);
  }
  mesh_prop_panel_chart_bar0_175.castShadow = options.castShadow ?? true;
  mesh_prop_panel_chart_bar0_175.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_chart_bar0_175.userData.sculptComponent = { id: "prop-panel-chart-bar0" };
  node_prop_panel_chart_bar0_175.add(mesh_prop_panel_chart_bar0_175);
  meshes["prop-panel-chart-bar0"] = mesh_prop_panel_chart_bar0_175;
  colliders["prop-panel-chart-bar0"] = {};
  destructionGroups["icons"] ??= [];
  destructionGroups["icons"].push(node_prop_panel_chart_bar0_175);

  const endpoint_prop_panel_chart_bar1_176 = makeAttachmentEndpoint(null);
  const node_prop_panel_chart_bar1_176 = new THREE.Group();
  node_prop_panel_chart_bar1_176.name = "Chart bar prop-panel-chart 1__pivot";
  node_prop_panel_chart_bar1_176.scale.set(1, 1, 1);
  if (endpoint_prop_panel_chart_bar1_176) {
    node_prop_panel_chart_bar1_176.position.copy(endpoint_prop_panel_chart_bar1_176.start);
    node_prop_panel_chart_bar1_176.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_chart_bar1_176.position.set(-0.0257, -0.01748, 0.00378);
    node_prop_panel_chart_bar1_176.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_chart_bar1_176.userData.sculptComponent = { id: "prop-panel-chart-bar1" };
  node_prop_panel_chart_bar1_176.userData.actionProfile = {};
  (nodes["prop-panel-chart"] ?? root).add(node_prop_panel_chart_bar1_176);
  nodes["prop-panel-chart-bar1"] = node_prop_panel_chart_bar1_176;
  const mesh_prop_panel_chart_bar1_176Geometry = endpoint_prop_panel_chart_bar1_176
    ? new THREE.CylinderGeometry(endpoint_prop_panel_chart_bar1_176.endRadius, endpoint_prop_panel_chart_bar1_176.baseRadius, endpoint_prop_panel_chart_bar1_176.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_chart_bar1_176) {
    mesh_prop_panel_chart_bar1_176Geometry.scale(0.01499, 0.12353, 0.00567);
  }
  const mesh_prop_panel_chart_bar1_176 = new THREE.Mesh(
    mesh_prop_panel_chart_bar1_176Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_chart_bar1_176.name = "Chart bar prop-panel-chart 1";
  if (endpoint_prop_panel_chart_bar1_176) {
    mesh_prop_panel_chart_bar1_176.position.copy(endpoint_prop_panel_chart_bar1_176.midpoint);
    mesh_prop_panel_chart_bar1_176.quaternion.copy(endpoint_prop_panel_chart_bar1_176.quaternion);
  }
  mesh_prop_panel_chart_bar1_176.castShadow = options.castShadow ?? true;
  mesh_prop_panel_chart_bar1_176.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_chart_bar1_176.userData.sculptComponent = { id: "prop-panel-chart-bar1" };
  node_prop_panel_chart_bar1_176.add(mesh_prop_panel_chart_bar1_176);
  meshes["prop-panel-chart-bar1"] = mesh_prop_panel_chart_bar1_176;
  colliders["prop-panel-chart-bar1"] = {};
  destructionGroups["icons"] ??= [];
  destructionGroups["icons"].push(node_prop_panel_chart_bar1_176);

  const endpoint_prop_panel_chart_bar2_177 = makeAttachmentEndpoint(null);
  const node_prop_panel_chart_bar2_177 = new THREE.Group();
  node_prop_panel_chart_bar2_177.name = "Chart bar prop-panel-chart 2__pivot";
  node_prop_panel_chart_bar2_177.scale.set(1, 1, 1);
  if (endpoint_prop_panel_chart_bar2_177) {
    node_prop_panel_chart_bar2_177.position.copy(endpoint_prop_panel_chart_bar2_177.start);
    node_prop_panel_chart_bar2_177.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_chart_bar2_177.position.set(0.0257, -0.03496, 0.00378);
    node_prop_panel_chart_bar2_177.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_chart_bar2_177.userData.sculptComponent = { id: "prop-panel-chart-bar2" };
  node_prop_panel_chart_bar2_177.userData.actionProfile = {};
  (nodes["prop-panel-chart"] ?? root).add(node_prop_panel_chart_bar2_177);
  nodes["prop-panel-chart-bar2"] = node_prop_panel_chart_bar2_177;
  const mesh_prop_panel_chart_bar2_177Geometry = endpoint_prop_panel_chart_bar2_177
    ? new THREE.CylinderGeometry(endpoint_prop_panel_chart_bar2_177.endRadius, endpoint_prop_panel_chart_bar2_177.baseRadius, endpoint_prop_panel_chart_bar2_177.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_chart_bar2_177) {
    mesh_prop_panel_chart_bar2_177Geometry.scale(0.01499, 0.08857, 0.00567);
  }
  const mesh_prop_panel_chart_bar2_177 = new THREE.Mesh(
    mesh_prop_panel_chart_bar2_177Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_chart_bar2_177.name = "Chart bar prop-panel-chart 2";
  if (endpoint_prop_panel_chart_bar2_177) {
    mesh_prop_panel_chart_bar2_177.position.copy(endpoint_prop_panel_chart_bar2_177.midpoint);
    mesh_prop_panel_chart_bar2_177.quaternion.copy(endpoint_prop_panel_chart_bar2_177.quaternion);
  }
  mesh_prop_panel_chart_bar2_177.castShadow = options.castShadow ?? true;
  mesh_prop_panel_chart_bar2_177.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_chart_bar2_177.userData.sculptComponent = { id: "prop-panel-chart-bar2" };
  node_prop_panel_chart_bar2_177.add(mesh_prop_panel_chart_bar2_177);
  meshes["prop-panel-chart-bar2"] = mesh_prop_panel_chart_bar2_177;
  colliders["prop-panel-chart-bar2"] = {};
  destructionGroups["icons"] ??= [];
  destructionGroups["icons"].push(node_prop_panel_chart_bar2_177);

  const endpoint_prop_panel_chart_bar3_178 = makeAttachmentEndpoint(null);
  const node_prop_panel_chart_bar3_178 = new THREE.Group();
  node_prop_panel_chart_bar3_178.name = "Chart bar prop-panel-chart 3__pivot";
  node_prop_panel_chart_bar3_178.scale.set(1, 1, 1);
  if (endpoint_prop_panel_chart_bar3_178) {
    node_prop_panel_chart_bar3_178.position.copy(endpoint_prop_panel_chart_bar3_178.start);
    node_prop_panel_chart_bar3_178.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_chart_bar3_178.position.set(0.0771, -0.05244, 0.00378);
    node_prop_panel_chart_bar3_178.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_chart_bar3_178.userData.sculptComponent = { id: "prop-panel-chart-bar3" };
  node_prop_panel_chart_bar3_178.userData.actionProfile = {};
  (nodes["prop-panel-chart"] ?? root).add(node_prop_panel_chart_bar3_178);
  nodes["prop-panel-chart-bar3"] = node_prop_panel_chart_bar3_178;
  const mesh_prop_panel_chart_bar3_178Geometry = endpoint_prop_panel_chart_bar3_178
    ? new THREE.CylinderGeometry(endpoint_prop_panel_chart_bar3_178.endRadius, endpoint_prop_panel_chart_bar3_178.baseRadius, endpoint_prop_panel_chart_bar3_178.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_chart_bar3_178) {
    mesh_prop_panel_chart_bar3_178Geometry.scale(0.01499, 0.05361, 0.00567);
  }
  const mesh_prop_panel_chart_bar3_178 = new THREE.Mesh(
    mesh_prop_panel_chart_bar3_178Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_chart_bar3_178.name = "Chart bar prop-panel-chart 3";
  if (endpoint_prop_panel_chart_bar3_178) {
    mesh_prop_panel_chart_bar3_178.position.copy(endpoint_prop_panel_chart_bar3_178.midpoint);
    mesh_prop_panel_chart_bar3_178.quaternion.copy(endpoint_prop_panel_chart_bar3_178.quaternion);
  }
  mesh_prop_panel_chart_bar3_178.castShadow = options.castShadow ?? true;
  mesh_prop_panel_chart_bar3_178.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_chart_bar3_178.userData.sculptComponent = { id: "prop-panel-chart-bar3" };
  node_prop_panel_chart_bar3_178.add(mesh_prop_panel_chart_bar3_178);
  meshes["prop-panel-chart-bar3"] = mesh_prop_panel_chart_bar3_178;
  colliders["prop-panel-chart-bar3"] = {};
  destructionGroups["icons"] ??= [];
  destructionGroups["icons"].push(node_prop_panel_chart_bar3_178);

  const endpoint_prop_panel_chart_line0_179 = makeAttachmentEndpoint(null);
  const node_prop_panel_chart_line0_179 = new THREE.Group();
  node_prop_panel_chart_line0_179.name = "Text line prop-panel-chart 0__pivot";
  node_prop_panel_chart_line0_179.scale.set(1, 1, 1);
  if (endpoint_prop_panel_chart_line0_179) {
    node_prop_panel_chart_line0_179.position.copy(endpoint_prop_panel_chart_line0_179.start);
    node_prop_panel_chart_line0_179.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_chart_line0_179.position.set(-0.02677, 0.06992, 0.00378);
    node_prop_panel_chart_line0_179.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_chart_line0_179.userData.sculptComponent = { id: "prop-panel-chart-line0" };
  node_prop_panel_chart_line0_179.userData.actionProfile = {};
  (nodes["prop-panel-chart"] ?? root).add(node_prop_panel_chart_line0_179);
  nodes["prop-panel-chart-line0"] = node_prop_panel_chart_line0_179;
  const mesh_prop_panel_chart_line0_179Geometry = endpoint_prop_panel_chart_line0_179
    ? new THREE.CylinderGeometry(endpoint_prop_panel_chart_line0_179.endRadius, endpoint_prop_panel_chart_line0_179.baseRadius, endpoint_prop_panel_chart_line0_179.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_chart_line0_179) {
    mesh_prop_panel_chart_line0_179Geometry.scale(0.1178, 0.00378, 0.00504);
  }
  const mesh_prop_panel_chart_line0_179 = new THREE.Mesh(
    mesh_prop_panel_chart_line0_179Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_chart_line0_179.name = "Text line prop-panel-chart 0";
  if (endpoint_prop_panel_chart_line0_179) {
    mesh_prop_panel_chart_line0_179.position.copy(endpoint_prop_panel_chart_line0_179.midpoint);
    mesh_prop_panel_chart_line0_179.quaternion.copy(endpoint_prop_panel_chart_line0_179.quaternion);
  }
  mesh_prop_panel_chart_line0_179.castShadow = options.castShadow ?? true;
  mesh_prop_panel_chart_line0_179.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_chart_line0_179.userData.sculptComponent = { id: "prop-panel-chart-line0" };
  node_prop_panel_chart_line0_179.add(mesh_prop_panel_chart_line0_179);
  meshes["prop-panel-chart-line0"] = mesh_prop_panel_chart_line0_179;
  colliders["prop-panel-chart-line0"] = {};
  destructionGroups["icons"] ??= [];
  destructionGroups["icons"].push(node_prop_panel_chart_line0_179);

  const endpoint_prop_panel_chart_line1_180 = makeAttachmentEndpoint(null);
  const node_prop_panel_chart_line1_180 = new THREE.Group();
  node_prop_panel_chart_line1_180.name = "Text line prop-panel-chart 1__pivot";
  node_prop_panel_chart_line1_180.scale.set(1, 1, 1);
  if (endpoint_prop_panel_chart_line1_180) {
    node_prop_panel_chart_line1_180.position.copy(endpoint_prop_panel_chart_line1_180.start);
    node_prop_panel_chart_line1_180.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_panel_chart_line1_180.position.set(-0.03534, 0.04195, 0.00378);
    node_prop_panel_chart_line1_180.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_panel_chart_line1_180.userData.sculptComponent = { id: "prop-panel-chart-line1" };
  node_prop_panel_chart_line1_180.userData.actionProfile = {};
  (nodes["prop-panel-chart"] ?? root).add(node_prop_panel_chart_line1_180);
  nodes["prop-panel-chart-line1"] = node_prop_panel_chart_line1_180;
  const mesh_prop_panel_chart_line1_180Geometry = endpoint_prop_panel_chart_line1_180
    ? new THREE.CylinderGeometry(endpoint_prop_panel_chart_line1_180.endRadius, endpoint_prop_panel_chart_line1_180.baseRadius, endpoint_prop_panel_chart_line1_180.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_prop_panel_chart_line1_180) {
    mesh_prop_panel_chart_line1_180Geometry.scale(0.10066, 0.00378, 0.00504);
  }
  const mesh_prop_panel_chart_line1_180 = new THREE.Mesh(
    mesh_prop_panel_chart_line1_180Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_panel_chart_line1_180.name = "Text line prop-panel-chart 1";
  if (endpoint_prop_panel_chart_line1_180) {
    mesh_prop_panel_chart_line1_180.position.copy(endpoint_prop_panel_chart_line1_180.midpoint);
    mesh_prop_panel_chart_line1_180.quaternion.copy(endpoint_prop_panel_chart_line1_180.quaternion);
  }
  mesh_prop_panel_chart_line1_180.castShadow = options.castShadow ?? true;
  mesh_prop_panel_chart_line1_180.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_panel_chart_line1_180.userData.sculptComponent = { id: "prop-panel-chart-line1" };
  node_prop_panel_chart_line1_180.add(mesh_prop_panel_chart_line1_180);
  meshes["prop-panel-chart-line1"] = mesh_prop_panel_chart_line1_180;
  colliders["prop-panel-chart-line1"] = {};
  destructionGroups["icons"] ??= [];
  destructionGroups["icons"].push(node_prop_panel_chart_line1_180);

  const endpoint_prop_cam_1_181 = makeAttachmentEndpoint(null);
  const node_prop_cam_1_181 = new THREE.Group();
  node_prop_cam_1_181.name = "Orb drone prop-cam-1__pivot";
  node_prop_cam_1_181.scale.set(1, 1, 1);
  if (endpoint_prop_cam_1_181) {
    node_prop_cam_1_181.position.copy(endpoint_prop_cam_1_181.start);
    node_prop_cam_1_181.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_cam_1_181.position.set(0.49134, 1.57481, 0.13228);
    node_prop_cam_1_181.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_cam_1_181.userData.sculptComponent = { id: "prop-cam-1" };
  node_prop_cam_1_181.userData.actionProfile = {};
  (nodes["root"] ?? root).add(node_prop_cam_1_181);
  nodes["prop-cam-1"] = node_prop_cam_1_181;
  const mesh_prop_cam_1_181Geometry = endpoint_prop_cam_1_181
    ? new THREE.CylinderGeometry(endpoint_prop_cam_1_181.endRadius, endpoint_prop_cam_1_181.baseRadius, endpoint_prop_cam_1_181.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_prop_cam_1_181) {
    mesh_prop_cam_1_181Geometry.scale(0.16378, 0.16378, 0.16378);
  }
  const mesh_prop_cam_1_181 = new THREE.Mesh(
    mesh_prop_cam_1_181Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_cam_1_181.name = "Orb drone prop-cam-1";
  if (endpoint_prop_cam_1_181) {
    mesh_prop_cam_1_181.position.copy(endpoint_prop_cam_1_181.midpoint);
    mesh_prop_cam_1_181.quaternion.copy(endpoint_prop_cam_1_181.quaternion);
  }
  mesh_prop_cam_1_181.castShadow = options.castShadow ?? true;
  mesh_prop_cam_1_181.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_cam_1_181.userData.sculptComponent = { id: "prop-cam-1" };
  node_prop_cam_1_181.add(mesh_prop_cam_1_181);
  meshes["prop-cam-1"] = mesh_prop_cam_1_181;
  colliders["prop-cam-1"] = {};
  destructionGroups["prop-cam-1"] ??= [];
  destructionGroups["prop-cam-1"].push(node_prop_cam_1_181);

  const endpoint_prop_cam_1_face_182 = makeAttachmentEndpoint(null);
  const node_prop_cam_1_face_182 = new THREE.Group();
  node_prop_cam_1_face_182.name = "Drone face prop-cam-1__pivot";
  node_prop_cam_1_face_182.scale.set(1, 1, 1);
  if (endpoint_prop_cam_1_face_182) {
    node_prop_cam_1_face_182.position.copy(endpoint_prop_cam_1_face_182.start);
    node_prop_cam_1_face_182.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_cam_1_face_182.position.set(0.0, 0.0, 0.05077);
    node_prop_cam_1_face_182.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_cam_1_face_182.userData.sculptComponent = { id: "prop-cam-1-face" };
  node_prop_cam_1_face_182.userData.actionProfile = {};
  (nodes["prop-cam-1"] ?? root).add(node_prop_cam_1_face_182);
  nodes["prop-cam-1-face"] = node_prop_cam_1_face_182;
  const mesh_prop_cam_1_face_182Geometry = endpoint_prop_cam_1_face_182
    ? new THREE.CylinderGeometry(endpoint_prop_cam_1_face_182.endRadius, endpoint_prop_cam_1_face_182.baseRadius, endpoint_prop_cam_1_face_182.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_prop_cam_1_face_182) {
    mesh_prop_cam_1_face_182Geometry.scale(0.11874, 0.09827, 0.05732);
  }
  const mesh_prop_cam_1_face_182 = new THREE.Mesh(
    mesh_prop_cam_1_face_182Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_cam_1_face_182.name = "Drone face prop-cam-1";
  if (endpoint_prop_cam_1_face_182) {
    mesh_prop_cam_1_face_182.position.copy(endpoint_prop_cam_1_face_182.midpoint);
    mesh_prop_cam_1_face_182.quaternion.copy(endpoint_prop_cam_1_face_182.quaternion);
  }
  mesh_prop_cam_1_face_182.castShadow = options.castShadow ?? true;
  mesh_prop_cam_1_face_182.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_cam_1_face_182.userData.sculptComponent = { id: "prop-cam-1-face" };
  node_prop_cam_1_face_182.add(mesh_prop_cam_1_face_182);
  meshes["prop-cam-1-face"] = mesh_prop_cam_1_face_182;
  colliders["prop-cam-1-face"] = {};
  destructionGroups["prop-cam-1"] ??= [];
  destructionGroups["prop-cam-1"].push(node_prop_cam_1_face_182);

  const endpoint_prop_cam_1_eye0_183 = makeAttachmentEndpoint(null);
  const node_prop_cam_1_eye0_183 = new THREE.Group();
  node_prop_cam_1_eye0_183.name = "Drone eye prop-cam-1 0__pivot";
  node_prop_cam_1_eye0_183.scale.set(1, 1, 1);
  if (endpoint_prop_cam_1_eye0_183) {
    node_prop_cam_1_eye0_183.position.copy(endpoint_prop_cam_1_eye0_183.start);
    node_prop_cam_1_eye0_183.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_cam_1_eye0_183.position.set(-0.03439, 0.00328, 0.0778);
    node_prop_cam_1_eye0_183.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_cam_1_eye0_183.userData.sculptComponent = { id: "prop-cam-1-eye0" };
  node_prop_cam_1_eye0_183.userData.actionProfile = {};
  (nodes["prop-cam-1"] ?? root).add(node_prop_cam_1_eye0_183);
  nodes["prop-cam-1-eye0"] = node_prop_cam_1_eye0_183;
  const mesh_prop_cam_1_eye0_183Geometry = endpoint_prop_cam_1_eye0_183
    ? new THREE.CylinderGeometry(endpoint_prop_cam_1_eye0_183.endRadius, endpoint_prop_cam_1_eye0_183.baseRadius, endpoint_prop_cam_1_eye0_183.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_prop_cam_1_eye0_183) {
    mesh_prop_cam_1_eye0_183Geometry.scale(0.02457, 0.02784, 0.01146);
  }
  const mesh_prop_cam_1_eye0_183 = new THREE.Mesh(
    mesh_prop_cam_1_eye0_183Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_cam_1_eye0_183.name = "Drone eye prop-cam-1 0";
  if (endpoint_prop_cam_1_eye0_183) {
    mesh_prop_cam_1_eye0_183.position.copy(endpoint_prop_cam_1_eye0_183.midpoint);
    mesh_prop_cam_1_eye0_183.quaternion.copy(endpoint_prop_cam_1_eye0_183.quaternion);
  }
  mesh_prop_cam_1_eye0_183.castShadow = options.castShadow ?? true;
  mesh_prop_cam_1_eye0_183.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_cam_1_eye0_183.userData.sculptComponent = { id: "prop-cam-1-eye0" };
  node_prop_cam_1_eye0_183.add(mesh_prop_cam_1_eye0_183);
  meshes["prop-cam-1-eye0"] = mesh_prop_cam_1_eye0_183;
  colliders["prop-cam-1-eye0"] = {};
  destructionGroups["prop-cam-1"] ??= [];
  destructionGroups["prop-cam-1"].push(node_prop_cam_1_eye0_183);

  const endpoint_prop_cam_1_eye1_184 = makeAttachmentEndpoint(null);
  const node_prop_cam_1_eye1_184 = new THREE.Group();
  node_prop_cam_1_eye1_184.name = "Drone eye prop-cam-1 1__pivot";
  node_prop_cam_1_eye1_184.scale.set(1, 1, 1);
  if (endpoint_prop_cam_1_eye1_184) {
    node_prop_cam_1_eye1_184.position.copy(endpoint_prop_cam_1_eye1_184.start);
    node_prop_cam_1_eye1_184.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_cam_1_eye1_184.position.set(0.03439, 0.00328, 0.0778);
    node_prop_cam_1_eye1_184.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_cam_1_eye1_184.userData.sculptComponent = { id: "prop-cam-1-eye1" };
  node_prop_cam_1_eye1_184.userData.actionProfile = {};
  (nodes["prop-cam-1"] ?? root).add(node_prop_cam_1_eye1_184);
  nodes["prop-cam-1-eye1"] = node_prop_cam_1_eye1_184;
  const mesh_prop_cam_1_eye1_184Geometry = endpoint_prop_cam_1_eye1_184
    ? new THREE.CylinderGeometry(endpoint_prop_cam_1_eye1_184.endRadius, endpoint_prop_cam_1_eye1_184.baseRadius, endpoint_prop_cam_1_eye1_184.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_prop_cam_1_eye1_184) {
    mesh_prop_cam_1_eye1_184Geometry.scale(0.02457, 0.02784, 0.01146);
  }
  const mesh_prop_cam_1_eye1_184 = new THREE.Mesh(
    mesh_prop_cam_1_eye1_184Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_cam_1_eye1_184.name = "Drone eye prop-cam-1 1";
  if (endpoint_prop_cam_1_eye1_184) {
    mesh_prop_cam_1_eye1_184.position.copy(endpoint_prop_cam_1_eye1_184.midpoint);
    mesh_prop_cam_1_eye1_184.quaternion.copy(endpoint_prop_cam_1_eye1_184.quaternion);
  }
  mesh_prop_cam_1_eye1_184.castShadow = options.castShadow ?? true;
  mesh_prop_cam_1_eye1_184.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_cam_1_eye1_184.userData.sculptComponent = { id: "prop-cam-1-eye1" };
  node_prop_cam_1_eye1_184.add(mesh_prop_cam_1_eye1_184);
  meshes["prop-cam-1-eye1"] = mesh_prop_cam_1_eye1_184;
  colliders["prop-cam-1-eye1"] = {};
  destructionGroups["prop-cam-1"] ??= [];
  destructionGroups["prop-cam-1"].push(node_prop_cam_1_eye1_184);

  const endpoint_prop_cam_1_band_185 = makeAttachmentEndpoint(null);
  const node_prop_cam_1_band_185 = new THREE.Group();
  node_prop_cam_1_band_185.name = "Drone band prop-cam-1__pivot";
  node_prop_cam_1_band_185.scale.set(1, 1, 1);
  if (endpoint_prop_cam_1_band_185) {
    node_prop_cam_1_band_185.position.copy(endpoint_prop_cam_1_band_185.start);
    node_prop_cam_1_band_185.rotation.set(0.0, 1.5708, 0.0);
  } else {
    node_prop_cam_1_band_185.position.set(0.0, 0.0, 0.0);
    node_prop_cam_1_band_185.rotation.set(0.0, 1.5708, 0.0);
  }
  node_prop_cam_1_band_185.userData.sculptComponent = { id: "prop-cam-1-band" };
  node_prop_cam_1_band_185.userData.actionProfile = {};
  (nodes["prop-cam-1"] ?? root).add(node_prop_cam_1_band_185);
  nodes["prop-cam-1-band"] = node_prop_cam_1_band_185;
  const mesh_prop_cam_1_band_185Geometry = endpoint_prop_cam_1_band_185
    ? new THREE.CylinderGeometry(endpoint_prop_cam_1_band_185.endRadius, endpoint_prop_cam_1_band_185.baseRadius, endpoint_prop_cam_1_band_185.length, 8, 4)
    : new THREE.TorusGeometry(0.45, 0.0135, 8, 16);
  if (!endpoint_prop_cam_1_band_185) {
    mesh_prop_cam_1_band_185Geometry.scale(0.17197, 0.17197, 0.17197);
  }
  const mesh_prop_cam_1_band_185 = new THREE.Mesh(
    mesh_prop_cam_1_band_185Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_cam_1_band_185.name = "Drone band prop-cam-1";
  if (endpoint_prop_cam_1_band_185) {
    mesh_prop_cam_1_band_185.position.copy(endpoint_prop_cam_1_band_185.midpoint);
    mesh_prop_cam_1_band_185.quaternion.copy(endpoint_prop_cam_1_band_185.quaternion);
  }
  mesh_prop_cam_1_band_185.castShadow = options.castShadow ?? true;
  mesh_prop_cam_1_band_185.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_cam_1_band_185.userData.sculptComponent = { id: "prop-cam-1-band" };
  node_prop_cam_1_band_185.add(mesh_prop_cam_1_band_185);
  meshes["prop-cam-1-band"] = mesh_prop_cam_1_band_185;
  colliders["prop-cam-1-band"] = {};
  destructionGroups["prop-cam-1"] ??= [];
  destructionGroups["prop-cam-1"].push(node_prop_cam_1_band_185);

  const endpoint_prop_cam_2_186 = makeAttachmentEndpoint(null);
  const node_prop_cam_2_186 = new THREE.Group();
  node_prop_cam_2_186.name = "Orb drone prop-cam-2__pivot";
  node_prop_cam_2_186.scale.set(1, 1, 1);
  if (endpoint_prop_cam_2_186) {
    node_prop_cam_2_186.position.copy(endpoint_prop_cam_2_186.start);
    node_prop_cam_2_186.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_cam_2_186.position.set(-0.45354, 0.71811, 0.12598);
    node_prop_cam_2_186.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_cam_2_186.userData.sculptComponent = { id: "prop-cam-2" };
  node_prop_cam_2_186.userData.actionProfile = {};
  (nodes["root"] ?? root).add(node_prop_cam_2_186);
  nodes["prop-cam-2"] = node_prop_cam_2_186;
  const mesh_prop_cam_2_186Geometry = endpoint_prop_cam_2_186
    ? new THREE.CylinderGeometry(endpoint_prop_cam_2_186.endRadius, endpoint_prop_cam_2_186.baseRadius, endpoint_prop_cam_2_186.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_prop_cam_2_186) {
    mesh_prop_cam_2_186Geometry.scale(0.25197, 0.25197, 0.25197);
  }
  const mesh_prop_cam_2_186 = new THREE.Mesh(
    mesh_prop_cam_2_186Geometry,
    materialMap["armor-pearl-silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_cam_2_186.name = "Orb drone prop-cam-2";
  if (endpoint_prop_cam_2_186) {
    mesh_prop_cam_2_186.position.copy(endpoint_prop_cam_2_186.midpoint);
    mesh_prop_cam_2_186.quaternion.copy(endpoint_prop_cam_2_186.quaternion);
  }
  mesh_prop_cam_2_186.castShadow = options.castShadow ?? true;
  mesh_prop_cam_2_186.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_cam_2_186.userData.sculptComponent = { id: "prop-cam-2" };
  node_prop_cam_2_186.add(mesh_prop_cam_2_186);
  meshes["prop-cam-2"] = mesh_prop_cam_2_186;
  colliders["prop-cam-2"] = {};
  destructionGroups["prop-cam-2"] ??= [];
  destructionGroups["prop-cam-2"].push(node_prop_cam_2_186);

  const endpoint_prop_cam_2_face_187 = makeAttachmentEndpoint(null);
  const node_prop_cam_2_face_187 = new THREE.Group();
  node_prop_cam_2_face_187.name = "Drone face prop-cam-2__pivot";
  node_prop_cam_2_face_187.scale.set(1, 1, 1);
  if (endpoint_prop_cam_2_face_187) {
    node_prop_cam_2_face_187.position.copy(endpoint_prop_cam_2_face_187.start);
    node_prop_cam_2_face_187.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_cam_2_face_187.position.set(0.0, 0.0, 0.07811);
    node_prop_cam_2_face_187.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_cam_2_face_187.userData.sculptComponent = { id: "prop-cam-2-face" };
  node_prop_cam_2_face_187.userData.actionProfile = {};
  (nodes["prop-cam-2"] ?? root).add(node_prop_cam_2_face_187);
  nodes["prop-cam-2-face"] = node_prop_cam_2_face_187;
  const mesh_prop_cam_2_face_187Geometry = endpoint_prop_cam_2_face_187
    ? new THREE.CylinderGeometry(endpoint_prop_cam_2_face_187.endRadius, endpoint_prop_cam_2_face_187.baseRadius, endpoint_prop_cam_2_face_187.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_prop_cam_2_face_187) {
    mesh_prop_cam_2_face_187Geometry.scale(0.18268, 0.15118, 0.08819);
  }
  const mesh_prop_cam_2_face_187 = new THREE.Mesh(
    mesh_prop_cam_2_face_187Geometry,
    materialMap["joint-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_cam_2_face_187.name = "Drone face prop-cam-2";
  if (endpoint_prop_cam_2_face_187) {
    mesh_prop_cam_2_face_187.position.copy(endpoint_prop_cam_2_face_187.midpoint);
    mesh_prop_cam_2_face_187.quaternion.copy(endpoint_prop_cam_2_face_187.quaternion);
  }
  mesh_prop_cam_2_face_187.castShadow = options.castShadow ?? true;
  mesh_prop_cam_2_face_187.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_cam_2_face_187.userData.sculptComponent = { id: "prop-cam-2-face" };
  node_prop_cam_2_face_187.add(mesh_prop_cam_2_face_187);
  meshes["prop-cam-2-face"] = mesh_prop_cam_2_face_187;
  colliders["prop-cam-2-face"] = {};
  destructionGroups["prop-cam-2"] ??= [];
  destructionGroups["prop-cam-2"].push(node_prop_cam_2_face_187);

  const endpoint_prop_cam_2_eye0_188 = makeAttachmentEndpoint(null);
  const node_prop_cam_2_eye0_188 = new THREE.Group();
  node_prop_cam_2_eye0_188.name = "Drone eye prop-cam-2 0__pivot";
  node_prop_cam_2_eye0_188.scale.set(1, 1, 1);
  if (endpoint_prop_cam_2_eye0_188) {
    node_prop_cam_2_eye0_188.position.copy(endpoint_prop_cam_2_eye0_188.start);
    node_prop_cam_2_eye0_188.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_cam_2_eye0_188.position.set(-0.05291, 0.00504, 0.11969);
    node_prop_cam_2_eye0_188.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_cam_2_eye0_188.userData.sculptComponent = { id: "prop-cam-2-eye0" };
  node_prop_cam_2_eye0_188.userData.actionProfile = {};
  (nodes["prop-cam-2"] ?? root).add(node_prop_cam_2_eye0_188);
  nodes["prop-cam-2-eye0"] = node_prop_cam_2_eye0_188;
  const mesh_prop_cam_2_eye0_188Geometry = endpoint_prop_cam_2_eye0_188
    ? new THREE.CylinderGeometry(endpoint_prop_cam_2_eye0_188.endRadius, endpoint_prop_cam_2_eye0_188.baseRadius, endpoint_prop_cam_2_eye0_188.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_prop_cam_2_eye0_188) {
    mesh_prop_cam_2_eye0_188Geometry.scale(0.0378, 0.04283, 0.01764);
  }
  const mesh_prop_cam_2_eye0_188 = new THREE.Mesh(
    mesh_prop_cam_2_eye0_188Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_cam_2_eye0_188.name = "Drone eye prop-cam-2 0";
  if (endpoint_prop_cam_2_eye0_188) {
    mesh_prop_cam_2_eye0_188.position.copy(endpoint_prop_cam_2_eye0_188.midpoint);
    mesh_prop_cam_2_eye0_188.quaternion.copy(endpoint_prop_cam_2_eye0_188.quaternion);
  }
  mesh_prop_cam_2_eye0_188.castShadow = options.castShadow ?? true;
  mesh_prop_cam_2_eye0_188.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_cam_2_eye0_188.userData.sculptComponent = { id: "prop-cam-2-eye0" };
  node_prop_cam_2_eye0_188.add(mesh_prop_cam_2_eye0_188);
  meshes["prop-cam-2-eye0"] = mesh_prop_cam_2_eye0_188;
  colliders["prop-cam-2-eye0"] = {};
  destructionGroups["prop-cam-2"] ??= [];
  destructionGroups["prop-cam-2"].push(node_prop_cam_2_eye0_188);

  const endpoint_prop_cam_2_eye1_189 = makeAttachmentEndpoint(null);
  const node_prop_cam_2_eye1_189 = new THREE.Group();
  node_prop_cam_2_eye1_189.name = "Drone eye prop-cam-2 1__pivot";
  node_prop_cam_2_eye1_189.scale.set(1, 1, 1);
  if (endpoint_prop_cam_2_eye1_189) {
    node_prop_cam_2_eye1_189.position.copy(endpoint_prop_cam_2_eye1_189.start);
    node_prop_cam_2_eye1_189.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_prop_cam_2_eye1_189.position.set(0.05291, 0.00504, 0.11969);
    node_prop_cam_2_eye1_189.rotation.set(0.0, 0.0, 0.0);
  }
  node_prop_cam_2_eye1_189.userData.sculptComponent = { id: "prop-cam-2-eye1" };
  node_prop_cam_2_eye1_189.userData.actionProfile = {};
  (nodes["prop-cam-2"] ?? root).add(node_prop_cam_2_eye1_189);
  nodes["prop-cam-2-eye1"] = node_prop_cam_2_eye1_189;
  const mesh_prop_cam_2_eye1_189Geometry = endpoint_prop_cam_2_eye1_189
    ? new THREE.CylinderGeometry(endpoint_prop_cam_2_eye1_189.endRadius, endpoint_prop_cam_2_eye1_189.baseRadius, endpoint_prop_cam_2_eye1_189.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_prop_cam_2_eye1_189) {
    mesh_prop_cam_2_eye1_189Geometry.scale(0.0378, 0.04283, 0.01764);
  }
  const mesh_prop_cam_2_eye1_189 = new THREE.Mesh(
    mesh_prop_cam_2_eye1_189Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_cam_2_eye1_189.name = "Drone eye prop-cam-2 1";
  if (endpoint_prop_cam_2_eye1_189) {
    mesh_prop_cam_2_eye1_189.position.copy(endpoint_prop_cam_2_eye1_189.midpoint);
    mesh_prop_cam_2_eye1_189.quaternion.copy(endpoint_prop_cam_2_eye1_189.quaternion);
  }
  mesh_prop_cam_2_eye1_189.castShadow = options.castShadow ?? true;
  mesh_prop_cam_2_eye1_189.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_cam_2_eye1_189.userData.sculptComponent = { id: "prop-cam-2-eye1" };
  node_prop_cam_2_eye1_189.add(mesh_prop_cam_2_eye1_189);
  meshes["prop-cam-2-eye1"] = mesh_prop_cam_2_eye1_189;
  colliders["prop-cam-2-eye1"] = {};
  destructionGroups["prop-cam-2"] ??= [];
  destructionGroups["prop-cam-2"].push(node_prop_cam_2_eye1_189);

  const endpoint_prop_cam_2_band_190 = makeAttachmentEndpoint(null);
  const node_prop_cam_2_band_190 = new THREE.Group();
  node_prop_cam_2_band_190.name = "Drone band prop-cam-2__pivot";
  node_prop_cam_2_band_190.scale.set(1, 1, 1);
  if (endpoint_prop_cam_2_band_190) {
    node_prop_cam_2_band_190.position.copy(endpoint_prop_cam_2_band_190.start);
    node_prop_cam_2_band_190.rotation.set(0.0, 1.5708, 0.0);
  } else {
    node_prop_cam_2_band_190.position.set(0.0, 0.0, 0.0);
    node_prop_cam_2_band_190.rotation.set(0.0, 1.5708, 0.0);
  }
  node_prop_cam_2_band_190.userData.sculptComponent = { id: "prop-cam-2-band" };
  node_prop_cam_2_band_190.userData.actionProfile = {};
  (nodes["prop-cam-2"] ?? root).add(node_prop_cam_2_band_190);
  nodes["prop-cam-2-band"] = node_prop_cam_2_band_190;
  const mesh_prop_cam_2_band_190Geometry = endpoint_prop_cam_2_band_190
    ? new THREE.CylinderGeometry(endpoint_prop_cam_2_band_190.endRadius, endpoint_prop_cam_2_band_190.baseRadius, endpoint_prop_cam_2_band_190.length, 8, 4)
    : new THREE.TorusGeometry(0.45, 0.0135, 8, 16);
  if (!endpoint_prop_cam_2_band_190) {
    mesh_prop_cam_2_band_190Geometry.scale(0.26457, 0.26457, 0.26457);
  }
  const mesh_prop_cam_2_band_190 = new THREE.Mesh(
    mesh_prop_cam_2_band_190Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_prop_cam_2_band_190.name = "Drone band prop-cam-2";
  if (endpoint_prop_cam_2_band_190) {
    mesh_prop_cam_2_band_190.position.copy(endpoint_prop_cam_2_band_190.midpoint);
    mesh_prop_cam_2_band_190.quaternion.copy(endpoint_prop_cam_2_band_190.quaternion);
  }
  mesh_prop_cam_2_band_190.castShadow = options.castShadow ?? true;
  mesh_prop_cam_2_band_190.receiveShadow = options.receiveShadow ?? true;
  mesh_prop_cam_2_band_190.userData.sculptComponent = { id: "prop-cam-2-band" };
  node_prop_cam_2_band_190.add(mesh_prop_cam_2_band_190);
  meshes["prop-cam-2-band"] = mesh_prop_cam_2_band_190;
  colliders["prop-cam-2-band"] = {};
  destructionGroups["prop-cam-2"] ??= [];
  destructionGroups["prop-cam-2"].push(node_prop_cam_2_band_190);

  const endpoint_cord_1_191 = makeAttachmentEndpoint(null);
  const node_cord_1_191 = new THREE.Group();
  node_cord_1_191.name = "Pink cord cord-1__pivot";
  node_cord_1_191.scale.set(1, 1, 1);
  if (endpoint_cord_1_191) {
    node_cord_1_191.position.copy(endpoint_cord_1_191.start);
    node_cord_1_191.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_cord_1_191.position.set(0.0, 0.0, 0.0);
    node_cord_1_191.rotation.set(0.0, 0.0, 0.0);
  }
  node_cord_1_191.userData.sculptComponent = { id: "cord-1" };
  node_cord_1_191.userData.actionProfile = {};
  (nodes["root"] ?? root).add(node_cord_1_191);
  nodes["cord-1"] = node_cord_1_191;
  const mesh_cord_1_191Geometry = endpoint_cord_1_191
    ? new THREE.CylinderGeometry(endpoint_cord_1_191.endRadius, endpoint_cord_1_191.baseRadius, endpoint_cord_1_191.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.15748, 0.98268, -0.0063], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [0.18525, 0.99659, -0.00096], "rx": 0.00819, "rz": 0.00819, "twist": 0.0}, {"position": [0.22516, 1.01836, 0.0067], "rx": 0.00819, "rz": 0.00819, "twist": 0.0}, {"position": [0.27072, 1.04073, 0.01547], "rx": 0.00819, "rz": 0.00819, "twist": 0.0}, {"position": [0.31541, 1.05645, 0.02414], "rx": 0.00819, "rz": 0.00819, "twist": 0.0}, {"position": [0.35276, 1.05827, 0.0315], "rx": 0.00819, "rz": 0.00819, "twist": 0.0}, {"position": [0.38466, 1.04275, 0.03754], "rx": 0.00819, "rz": 0.00819, "twist": 0.0}, {"position": [0.41545, 1.01473, 0.04309], "rx": 0.00819, "rz": 0.00819, "twist": 0.0}, {"position": [0.44226, 0.97935, 0.04813], "rx": 0.00819, "rz": 0.00819, "twist": 0.0}, {"position": [0.46221, 0.94176, 0.05266], "rx": 0.00819, "rz": 0.00819, "twist": 0.0}, {"position": [0.47244, 0.90709, 0.05669], "rx": 0.00819, "rz": 0.00819, "twist": 0.0}, {"position": [0.46861, 0.87252, 0.06022], "rx": 0.00819, "rz": 0.00819, "twist": 0.0}, {"position": [0.45264, 0.83462, 0.06324], "rx": 0.00819, "rz": 0.00819, "twist": 0.0}, {"position": [0.43102, 0.79763, 0.06576], "rx": 0.00819, "rz": 0.00819, "twist": 0.0}, {"position": [0.41026, 0.76578, 0.06778], "rx": 0.00819, "rz": 0.00819, "twist": 0.0}, {"position": [0.39685, 0.74331, 0.06929], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_cord_1_191) {
    mesh_cord_1_191Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_cord_1_191 = new THREE.Mesh(
    mesh_cord_1_191Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_cord_1_191.name = "Pink cord cord-1";
  if (endpoint_cord_1_191) {
    mesh_cord_1_191.position.copy(endpoint_cord_1_191.midpoint);
    mesh_cord_1_191.quaternion.copy(endpoint_cord_1_191.quaternion);
  }
  mesh_cord_1_191.castShadow = options.castShadow ?? true;
  mesh_cord_1_191.receiveShadow = options.receiveShadow ?? true;
  mesh_cord_1_191.userData.sculptComponent = { id: "cord-1" };
  node_cord_1_191.add(mesh_cord_1_191);
  meshes["cord-1"] = mesh_cord_1_191;
  colliders["cord-1"] = {};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_cord_1_191);

  const endpoint_cord_2_192 = makeAttachmentEndpoint(null);
  const node_cord_2_192 = new THREE.Group();
  node_cord_2_192.name = "Pink cord cord-2__pivot";
  node_cord_2_192.scale.set(1, 1, 1);
  if (endpoint_cord_2_192) {
    node_cord_2_192.position.copy(endpoint_cord_2_192.start);
    node_cord_2_192.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_cord_2_192.position.set(0.0, 0.0, 0.0);
    node_cord_2_192.rotation.set(0.0, 0.0, 0.0);
  }
  node_cord_2_192.userData.sculptComponent = { id: "cord-2" };
  node_cord_2_192.userData.actionProfile = {};
  (nodes["root"] ?? root).add(node_cord_2_192);
  nodes["cord-2"] = node_cord_2_192;
  const mesh_cord_2_192Geometry = endpoint_cord_2_192
    ? new THREE.CylinderGeometry(endpoint_cord_2_192.endRadius, endpoint_cord_2_192.baseRadius, endpoint_cord_2_192.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.15748, 0.95118, -0.0063], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [-0.18459, 0.96232, -0.00096], "rx": 0.00819, "rz": 0.00819, "twist": 0.0}, {"position": [-0.2237, 0.98006, 0.0067], "rx": 0.00819, "rz": 0.00819, "twist": 0.0}, {"position": [-0.26815, 0.9979, 0.01547], "rx": 0.00819, "rz": 0.00819, "twist": 0.0}, {"position": [-0.31128, 1.00934, 0.02414], "rx": 0.00819, "rz": 0.00819, "twist": 0.0}, {"position": [-0.34646, 1.00788, 0.0315], "rx": 0.00819, "rz": 0.00819, "twist": 0.0}, {"position": [-0.37508, 0.98999, 0.03754], "rx": 0.00819, "rz": 0.00819, "twist": 0.0}, {"position": [-0.40159, 0.96, 0.04309], "rx": 0.00819, "rz": 0.00819, "twist": 0.0}, {"position": [-0.42386, 0.92321, 0.04813], "rx": 0.00819, "rz": 0.00819, "twist": 0.0}, {"position": [-0.43979, 0.88491, 0.05266], "rx": 0.00819, "rz": 0.00819, "twist": 0.0}, {"position": [-0.44724, 0.85039, 0.05669], "rx": 0.00819, "rz": 0.00819, "twist": 0.0}, {"position": [-0.44221, 0.81734, 0.06022], "rx": 0.00819, "rz": 0.00819, "twist": 0.0}, {"position": [-0.42608, 0.78221, 0.06324], "rx": 0.00819, "rz": 0.00819, "twist": 0.0}, {"position": [-0.40491, 0.7485, 0.06576], "rx": 0.00819, "rz": 0.00819, "twist": 0.0}, {"position": [-0.38476, 0.71967, 0.06778], "rx": 0.00819, "rz": 0.00819, "twist": 0.0}, {"position": [-0.37165, 0.69921, 0.06929], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_cord_2_192) {
    mesh_cord_2_192Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_cord_2_192 = new THREE.Mesh(
    mesh_cord_2_192Geometry,
    materialMap["emissive-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_cord_2_192.name = "Pink cord cord-2";
  if (endpoint_cord_2_192) {
    mesh_cord_2_192.position.copy(endpoint_cord_2_192.midpoint);
    mesh_cord_2_192.quaternion.copy(endpoint_cord_2_192.quaternion);
  }
  mesh_cord_2_192.castShadow = options.castShadow ?? true;
  mesh_cord_2_192.receiveShadow = options.receiveShadow ?? true;
  mesh_cord_2_192.userData.sculptComponent = { id: "cord-2" };
  node_cord_2_192.add(mesh_cord_2_192);
  meshes["cord-2"] = mesh_cord_2_192;
  colliders["cord-2"] = {};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_cord_2_192);
  // repetition system "gold-seam-strips" describes 23 parts that are already built individually; not instanced.
  // repetition system "glow-parts" describes 10 parts that are already built individually; not instanced.
  // repetition system "panel-content" describes 14 parts that are already built individually; not instanced.

  root.userData.sculptRuntime = { nodes, meshes, sockets, colliders, destructionGroups } satisfies ProceduralModelRuntime;
  root.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  root.userData.actionReadiness = {
    note: 'Use root.userData.sculptRuntime.nodes for transforms, sockets for attachments, colliders for physics proxies, and destructionGroups for breakable sets.',
  };
  return root;
}
