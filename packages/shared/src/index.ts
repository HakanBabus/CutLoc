import { z } from 'zod';

const EntityIdSchema = z.string()
  .regex(/^[A-Za-z0-9_.-]+$/, 'ID contains unsupported characters')
  .refine((value) => value !== '.' && value !== '..', 'ID contains unsupported characters');
const ProjectIdSchema = z.string().regex(/^[A-Za-z0-9_-]+$/, 'Project ID contains unsupported characters');

function managedFilePath(...folders: string[]) {
  return z.string().transform((value) => value.replaceAll('\\', '/')).refine((normalized) => {
    const [folder, fileName, ...rest] = normalized.split('/');
    return rest.length === 0
      && folders.includes(folder)
      && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(fileName ?? '');
  }, 'Managed media path must stay inside its CutLoc project folder');
}

/** Normalize physical and encoded line breaks across preview and export. */
export function normalizeTextLineBreaks(value: string) {
  return String(value ?? '')
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .replaceAll('\\n', '\n')
    .replaceAll('/n', '\n');
}

export const AssetType = z.enum(['video', 'audio', 'image']);
export type AssetType = z.infer<typeof AssetType>;

export const ClipType = z.enum(['video', 'audio', 'image', 'text', 'subtitle']);
export type ClipType = z.infer<typeof ClipType>;

/**
 * Tracks are now general-purpose layers.  The legacy media-specific values
 * remain accepted so older project files can still be opened, while new UI
 * actions use `layer` and allow any clip type on it.
 */
export const TrackType = z.enum(['layer', 'video', 'overlay', 'audio', 'text', 'subtitle']);
export type TrackType = z.infer<typeof TrackType>;

/** Canvas presets shared by the preview, project model and export pipeline. */
export const CanvasAspectSchema = z.enum(['16:9', '9:16', '1:1', '4:5', '3:2', '21:9']);
export type CanvasAspect = z.infer<typeof CanvasAspectSchema>;

export const CanvasFitModeSchema = z.enum(['fit', 'fill', 'smart', 'keep']).default('fit');
export type CanvasFitMode = z.infer<typeof CanvasFitModeSchema>;

/**
 * Resolve the authored canvas framing to the media fit understood by both the
 * browser compositor and FFmpeg. `keep` preserves the clip-level choice while
 * `smart` currently uses the deterministic fill/cover contract.
 */
export function effectiveVisualFit(canvasFitMode: CanvasFitMode | undefined, clipFit: Transform['fit']): Transform['fit'] {
  if (canvasFitMode === 'fill' || canvasFitMode === 'smart') return 'cover';
  if (canvasFitMode === 'fit') return 'contain';
  return clipFit;
}

export const KeyframeProperty = z.enum(['x', 'y', 'scale', 'rotation', 'opacity', 'volume']);
export type KeyframeProperty = z.infer<typeof KeyframeProperty>;

export const KeyframeSchema = z.object({
  id: EntityIdSchema,
  property: KeyframeProperty,
  time: z.number().nonnegative(),
  value: z.number(),
  easing: z.enum(['linear', 'ease-in', 'ease-out', 'ease-in-out']).default('linear'),
}).superRefine((keyframe, context) => {
  const valid = keyframe.property === 'opacity'
    ? keyframe.value >= 0 && keyframe.value <= 1
    : keyframe.property === 'volume'
      ? keyframe.value >= 0 && keyframe.value <= 2
      : keyframe.property === 'scale'
        ? keyframe.value > 0
        : true;
  if (!valid) context.addIssue({ code: z.ZodIssueCode.custom, path: ['value'], message: `Invalid ${keyframe.property} keyframe value` });
});
export type Keyframe = z.infer<typeof KeyframeSchema>;

/**
 * Interpolates a numeric keyframed property at a local clip time.  This lives
 * in the shared package so preview, export planning and tests can use the same
 * easing semantics instead of each surface drifting apart.
 */
export function easeKeyframeProgress(value: number, easing: Keyframe['easing']) {
  const t = Math.max(0, Math.min(1, value));
  if (easing === 'ease-in') return t * t;
  if (easing === 'ease-out') return 1 - ((1 - t) * (1 - t));
  if (easing === 'ease-in-out') return t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
  return t;
}

export function interpolateKeyframes(keyframes: readonly Keyframe[], property: Keyframe['property'], time: number, fallback: number) {
  const points = keyframes.filter((keyframe) => keyframe.property === property).sort((a, b) => a.time - b.time);
  if (!points.length) return fallback;
  if (time <= points[0].time) return points[0].value;
  const last = points[points.length - 1];
  if (time >= last.time) return last.value;
  const nextIndex = points.findIndex((point) => point.time >= time);
  const next = points[Math.max(1, nextIndex)];
  const previous = points[Math.max(0, nextIndex - 1)];
  const span = Math.max(0.000001, next.time - previous.time);
  return previous.value + (next.value - previous.value) * easeKeyframeProgress((time - previous.time) / span, next.easing);
}

/**
 * Returns the instantaneous speed at a clip-local time.  The editor stores
 * speed-curve points in timeline seconds, so this helper is intentionally
 * independent of media duration and can be shared by preview, trimming and
 * export planning.
 */
export function speedAt(speedCurve: readonly SpeedPoint[] | undefined, baseSpeed: number, time: number) {
  const fallback = clampNumber(baseSpeed, 0.1, 10, 1);
  const points = normalizedSpeedPoints(speedCurve);
  if (!points.length) return fallback;
  const safeTime = Math.max(0, Number.isFinite(time) ? time : 0);
  if (safeTime <= points[0].time) return clampNumber(points[0].speed, 0.1, 10, fallback);
  const last = points[points.length - 1];
  if (safeTime >= last.time) return clampNumber(last.speed, 0.1, 10, fallback);
  const nextIndex = points.findIndex((point) => point.time >= safeTime);
  const next = points[Math.max(1, nextIndex)];
  const previous = points[Math.max(0, nextIndex - 1)];
  const span = Math.max(0.000001, next.time - previous.time);
  const progress = easeKeyframeProgress((safeTime - previous.time) / span, next.easing);
  return clampNumber(previous.speed + (next.speed - previous.speed) * progress, 0.1, 10, fallback);
}

/**
 * Integrates the speed curve over clip-local time.  A speed curve describes
 * how many source seconds are consumed by one timeline second; using the
 * integral fixes the common bug where a preview jumps backwards/forwards when
 * the instantaneous speed changes.
 */
export function sourceTimeAt(speedCurve: readonly SpeedPoint[] | undefined, baseSpeed: number, time: number) {
  const safeTime = Math.max(0, Number.isFinite(time) ? time : 0);
  if (safeTime <= 0) return 0;
  if (!speedCurve?.length) return safeTime * clampNumber(baseSpeed, 0.1, 10, 1);
  const points = normalizedSpeedPoints(speedCurve);
  const breakpoints = [0, ...points.map((point) => point.time).filter((point) => Number.isFinite(point) && point > 0 && point < safeTime), safeTime]
    .sort((a, b) => a - b)
    .filter((point, index, all) => index === 0 || point - all[index - 1] > 0.000001);
  let total = 0;
  // Simpson integration keeps easing curves smooth while remaining cheap for
  // the small number of points an editor clip normally contains.
  for (let index = 1; index < breakpoints.length; index += 1) {
    const start = breakpoints[index - 1];
    const end = breakpoints[index];
    const span = end - start;
    const slices = 12;
    const step = span / slices;
    let sum = speedAt(speedCurve, baseSpeed, start) + speedAt(speedCurve, baseSpeed, end);
    for (let slice = 1; slice < slices; slice += 1) {
      sum += speedAt(speedCurve, baseSpeed, start + step * slice) * (slice % 2 === 0 ? 2 : 4);
    }
    total += (step / 3) * sum;
  }
  return Math.max(0, total);
}

/**
 * Solve the inverse of `sourceTimeAt` for a source duration.  Project files
 * store the clip's source length, while the timeline needs the amount of
 * time required to consume that source through a variable speed curve.
 */
export function timelineDurationForSourceDuration(sourceDuration: number, baseSpeed: number, speedCurve?: readonly SpeedPoint[]) {
  const target = Math.max(0, Number.isFinite(sourceDuration) ? sourceDuration : 0);
  if (target <= 0) return 0;
  const fallback = clampNumber(baseSpeed, 0.1, 10, 1);
  if (!speedCurve?.length) return target / fallback;

  let low = 0;
  let high = Math.max(0.000001, target / 0.1);
  // The curve is clamped to a minimum speed of 0.1, so this bound is enough
  // for valid points.  Keep a deterministic expansion for malformed legacy
  // data rather than returning an under-sized timeline clip.
  while (sourceTimeAt(speedCurve, fallback, high) < target && high < 1e7) high *= 2;
  for (let iteration = 0; iteration < 56; iteration += 1) {
    const middle = (low + high) / 2;
    if (sourceTimeAt(speedCurve, fallback, middle) < target) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

export type SpeedCurveSegment = {
  time: number;
  duration: number;
  sourceTime: number;
  sourceDuration: number;
  speed: number;
};

/** Create short, constant-speed render segments with the same source integral. */
export function speedCurveSegments(duration: number, baseSpeed: number, speedCurve?: readonly SpeedPoint[]) {
  const safeDuration = Math.max(0.000001, Number.isFinite(duration) ? duration : 0.000001);
  if (!speedCurve?.length) return [{ time: 0, duration: safeDuration, sourceTime: 0, sourceDuration: safeDuration * clampNumber(baseSpeed, 0.1, 10, 1), speed: clampNumber(baseSpeed, 0.1, 10, 1) }];
  const points = normalizedSpeedPoints(speedCurve);
  const knots = [0, ...points.map((point) => point.time).filter((point) => Number.isFinite(point) && point > 0 && point < safeDuration), safeDuration]
    .sort((a, b) => a - b)
    .filter((point, index, all) => index === 0 || point - all[index - 1] > 0.000001);
  const segments: SpeedCurveSegment[] = [];
  for (let knot = 1; knot < knots.length; knot += 1) {
    const start = knots[knot - 1];
    const end = knots[knot];
    const span = end - start;
    const subdivisions = Math.max(1, Math.min(12, Math.ceil(span / 0.5)));
    for (let index = 0; index < subdivisions; index += 1) {
      const time = start + (span * index) / subdivisions;
      const nextTime = start + (span * (index + 1)) / subdivisions;
      const sourceTime = sourceTimeAt(speedCurve, baseSpeed, time);
      const sourceEnd = sourceTimeAt(speedCurve, baseSpeed, nextTime);
      const segmentDuration = Math.max(0.000001, nextTime - time);
      const sourceDuration = Math.max(0.000001, sourceEnd - sourceTime);
      segments.push({ time, duration: segmentDuration, sourceTime, sourceDuration, speed: clampNumber(sourceDuration / segmentDuration, 0.1, 10, baseSpeed) });
    }
  }
  return segments;
}

function normalizedSpeedPoints(speedCurve: readonly SpeedPoint[] | undefined) {
  const sorted = [...(speedCurve ?? [])]
    .filter((point) => Number.isFinite(point.time) && Number.isFinite(point.speed))
    .map((point) => ({ ...point, time: Math.max(0, point.time), speed: clampNumber(point.speed, 0.1, 10, 1) }))
    .sort((a, b) => a.time - b.time);
  const points: SpeedPoint[] = [];
  for (const point of sorted) {
    const previous = points.at(-1);
    if (previous && Math.abs(previous.time - point.time) <= 0.000001) points[points.length - 1] = point;
    else points.push(point);
  }
  return points;
}

function clampNumber(value: number, min: number, max: number, fallback: number) {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

export const TransformSchema = z.object({
  x: z.number().default(0),
  y: z.number().default(0),
  scale: z.number().positive().default(1),
  rotation: z.number().default(0),
  opacity: z.number().min(0).max(1).default(1),
  fit: z.enum(['contain', 'cover', 'stretch']).default('contain'),
  flipX: z.boolean().default(false),
  flipY: z.boolean().default(false),
});
export type Transform = z.infer<typeof TransformSchema>;

export const FilterSchema = z.object({
  brightness: z.number().min(-1).max(1).default(0),
  contrast: z.number().min(-1).max(1).default(0),
  saturation: z.number().min(-1).max(1).default(0),
  temperature: z.number().min(-1).max(1).optional(),
  hue: z.number().min(-180).max(180).optional(),
  vignette: z.number().min(0).max(1).optional(),
  blur: z.number().min(0).max(24).default(0),
  grayscale: z.number().min(0).max(1).default(0),
  chromaKey: z.object({
    color: z.string().default('#00ff00'),
    similarity: z.number().min(0).max(1).default(0.35),
    blend: z.number().min(0).max(1).default(0.1),
  }).optional(),
});
export type Filter = z.infer<typeof FilterSchema>;

export const MaskSchema = z.object({
  type: z.enum(['rectangle', 'ellipse']).default('rectangle'),
  x: z.number().min(0).max(1).default(0),
  y: z.number().min(0).max(1).default(0),
  width: z.number().min(0.01).max(1).default(1),
  height: z.number().min(0.01).max(1).default(1),
  feather: z.number().min(0).max(1).default(0),
  invert: z.boolean().default(false),
});
export type Mask = z.infer<typeof MaskSchema>;

/** Crop is a framing operation; mask remains an alpha/shape operation. */
export const CropSchema = z.object({
  x: z.number().min(0).max(1).default(0),
  y: z.number().min(0).max(1).default(0),
  width: z.number().min(0.01).max(1).default(1),
  height: z.number().min(0.01).max(1).default(1),
});
export type Crop = z.infer<typeof CropSchema>;

export const SpeedPointSchema = z.object({
  time: z.number().nonnegative(),
  speed: z.number().min(0.25).max(4),
  easing: z.enum(['linear', 'ease-in', 'ease-out', 'ease-in-out']).default('linear'),
});
export type SpeedPoint = z.infer<typeof SpeedPointSchema>;

export const TextStyleSchema = z.object({
  text: z.string().default('Yeni metin'),
  fontFamily: z.string().default('Inter, Arial, sans-serif'),
  fontSize: z.number().positive().default(64),
  fontWeight: z.number().int().min(300).max(900).default(700),
  fontStyle: z.enum(['normal', 'italic']).default('normal'),
  textDecoration: z.enum(['none', 'underline']).default('none'),
  letterSpacing: z.number().min(-20).max(100).default(0),
  lineHeight: z.number().min(0.5).max(3).default(1.2),
  padding: z.number().min(0).max(100).default(4),
  color: z.string().default('#ffffff'),
  background: z.string().default('transparent'),
  stroke: z.string().default('transparent'),
  strokeWidth: z.number().min(0).max(20).default(0),
  shadow: z.boolean().default(true),
  align: z.enum(['left', 'center', 'right']).default('center'),
});
export type TextStyle = z.infer<typeof TextStyleSchema>;

export const TransitionSchema = z.object({
  type: z.enum(['none', 'dissolve', 'fade', 'slide', 'wipe', 'zoom']).default('none'),
  duration: z.number().min(0).max(5).default(0.4),
  /** Optional motion controls keep old project files valid while letting the
   * preview and animation studio share one transition contract. */
  direction: z.enum(['left', 'right', 'up', 'down', 'center']).optional(),
  easing: z.enum(['linear', 'ease-in', 'ease-out', 'ease-in-out']).optional(),
  intensity: z.number().min(0.1).max(2).optional(),
});
export type Transition = z.infer<typeof TransitionSchema>;

export const AssetSchema = z.object({
  id: EntityIdSchema,
  name: z.string(),
  type: AssetType,
  mimeType: z.string(),
  path: managedFilePath('media'),
  proxyPath: managedFilePath('proxies').optional(),
  thumbnailPath: managedFilePath('media', 'thumbnails').optional(),
  waveformPath: managedFilePath('waveforms').optional(),
  size: z.number().nonnegative(),
  duration: z.number().nonnegative().default(0),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  fps: z.number().positive().optional(),
  hasAudio: z.boolean().default(false),
  createdAt: z.string(),
});
export type Asset = z.infer<typeof AssetSchema>;

export const ClipSchema = z.object({
  id: EntityIdSchema,
  assetId: EntityIdSchema.optional(),
  type: ClipType,
  name: z.string(),
  start: z.number().nonnegative(),
  duration: z.number().positive(),
  sourceStart: z.number().nonnegative().default(0),
  sourceDuration: z.number().positive().default(1),
  speed: z.number().min(0.25).max(4).default(1),
  transform: TransformSchema.default({}),
  filters: FilterSchema.default({}),
  transitionIn: TransitionSchema.default({}),
  transitionOut: TransitionSchema.default({}),
  volume: z.number().min(0).max(2).default(1),
  fadeIn: z.number().min(0).optional(),
  fadeOut: z.number().min(0).optional(),
  normalize: z.boolean().optional(),
  mask: MaskSchema.optional(),
  crop: CropSchema.optional(),
  adjustment: z.boolean().default(false),
  speedCurve: z.array(SpeedPointSchema).optional(),
  keyframes: z.array(KeyframeSchema).default([]),
  textStyle: TextStyleSchema.optional(),
  subtitle: z.object({
    start: z.number().nonnegative(),
    end: z.number().positive(),
    text: z.string(),
  }).optional(),
});
export type Clip = z.infer<typeof ClipSchema>;

/** Clone a clip for insertion while preserving globally unique entity IDs. */
export function cloneClipWithFreshIds(clip: Clip, createId: (kind: 'clip' | 'keyframe') => string): Clip {
  const copy = structuredClone(clip);
  copy.id = createId('clip');
  copy.keyframes = copy.keyframes.map((keyframe) => ({ ...keyframe, id: createId('keyframe') }));
  return copy;
}

/** Style/keyframe paste must never reuse IDs already present in the project. */
export function cloneKeyframesWithFreshIds(keyframes: readonly Keyframe[], createId: () => string): Keyframe[] {
  return keyframes.map((keyframe) => ({ ...structuredClone(keyframe), id: createId() }));
}

/** Keep imminent media mounted so hard cuts do not wait on load/seek at the boundary. */
export function shouldMountPreviewMedia(clip: Pick<Clip, 'type' | 'start' | 'duration'>, currentTime: number, lookAheadSeconds = 3) {
  if (clip.type !== 'video' && clip.type !== 'image') return false;
  const lookAhead = Math.max(0, Number.isFinite(lookAheadSeconds) ? lookAheadSeconds : 0);
  return currentTime >= Math.max(0, clip.start - lookAhead) && currentTime < clip.start + clip.duration;
}

/**
 * Keep time-based motion attached to a clip when its timeline duration
 * changes.  Keyframes, transitions, fades and speed-curve knots all describe
 * local clip time, so they must move together when a clip is retimed.
 */
export function retimeClipMotion(clip: Clip, nextDuration: number) {
  const previousDuration = Math.max(0.000001, clip.duration);
  const safeDuration = Math.max(0.05, Number.isFinite(nextDuration) ? nextDuration : previousDuration);
  const ratio = safeDuration / previousDuration;
  clip.keyframes = clip.keyframes.map((keyframe) => ({
    ...keyframe,
    time: Math.min(safeDuration, Math.max(0, keyframe.time * ratio)),
  }));
  if (clip.speedCurve?.length) {
    clip.speedCurve = clip.speedCurve.map((point) => ({
      ...point,
      time: Math.min(safeDuration, Math.max(0, point.time * ratio)),
    }));
  }
  for (const transition of [clip.transitionIn, clip.transitionOut]) {
    if (transition.type !== 'none') transition.duration = Math.min(safeDuration, Math.max(0, transition.duration * ratio));
  }
  if (clip.fadeIn !== undefined) clip.fadeIn = Math.min(safeDuration, Math.max(0, clip.fadeIn * ratio));
  if (clip.fadeOut !== undefined) clip.fadeOut = Math.min(safeDuration, Math.max(0, clip.fadeOut * ratio));
  clip.duration = safeDuration;
  return ratio;
}

export const TrackSchema = z.object({
  id: EntityIdSchema,
  type: TrackType,
  name: z.string(),
  order: z.number().int().nonnegative(),
  locked: z.boolean().default(false),
  hidden: z.boolean().default(false),
  muted: z.boolean().default(false),
  volume: z.number().min(0).max(2).default(1),
  clips: z.array(ClipSchema).default([]),
});
export type Track = z.infer<typeof TrackSchema>;

const ProjectBaseSchema = z.object({
  schemaVersion: z.literal(1),
  id: ProjectIdSchema,
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  revision: z.number().int().nonnegative().default(0),
  canvas: z.object({
    width: z.number().int().positive().default(1920),
    height: z.number().int().positive().default(1080),
    aspect: CanvasAspectSchema.default('16:9'),
    fitMode: CanvasFitModeSchema,
    fps: z.number().positive().default(30),
    background: z.string().default('#101116'),
  }),
  duration: z.number().nonnegative().default(0),
  assets: z.array(AssetSchema).default([]),
  tracks: z.array(TrackSchema).default([]),
  markers: z.array(z.object({ id: EntityIdSchema, time: z.number().nonnegative(), label: z.string() })).default([]),
});

/**
 * Zod validates each field's shape; this second pass enforces relationships
 * that must hold across a complete timeline before it reaches the editor or
 * is persisted by the server.
 */
export const ProjectSchema = ProjectBaseSchema.superRefine((project, context) => {
  const seen = new Map<string, string>();
  const register = (id: string, path: Array<string | number>, kind: string) => {
    const previous = seen.get(id);
    if (previous) context.addIssue({ code: z.ZodIssueCode.custom, path, message: `Duplicate id ${id} (${previous}, ${kind})` });
    else seen.set(id, kind);
  };

  project.assets.forEach((asset, assetIndex) => register(asset.id, ['assets', assetIndex, 'id'], 'asset'));
  project.markers.forEach((marker, markerIndex) => {
    register(marker.id, ['markers', markerIndex, 'id'], 'marker');
    if (marker.time > project.duration + 0.000001) context.addIssue({ code: z.ZodIssueCode.custom, path: ['markers', markerIndex, 'time'], message: 'Marker exceeds project duration' });
  });

  const assets = new Map(project.assets.map((asset) => [asset.id, asset]));
  const trackOrders = new Map<number, number>();
  let requiredDuration = 0;
  project.tracks.forEach((track, trackIndex) => {
    register(track.id, ['tracks', trackIndex, 'id'], 'track');
    const previousTrackIndex = trackOrders.get(track.order);
    if (previousTrackIndex !== undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ['tracks', trackIndex, 'order'], message: `Duplicate track order ${track.order}` });
    else trackOrders.set(track.order, trackIndex);
    track.clips.forEach((clip, clipIndex) => {
      const clipPath: Array<string | number> = ['tracks', trackIndex, 'clips', clipIndex];
      register(clip.id, [...clipPath, 'id'], 'clip');
      requiredDuration = Math.max(requiredDuration, clip.start + clip.duration);
      const needsAsset = !clip.adjustment && ['video', 'audio', 'image'].includes(clip.type);
      const asset = clip.assetId ? assets.get(clip.assetId) : undefined;
      if (needsAsset && !asset) context.addIssue({ code: z.ZodIssueCode.custom, path: [...clipPath, 'assetId'], message: 'Clip references a missing asset' });
      if (asset && asset.type !== 'image' && asset.duration > 0 && clip.sourceStart + clip.sourceDuration > asset.duration + 0.000001) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: [...clipPath, 'sourceDuration'], message: 'Clip source range exceeds asset duration' });
      }
      clip.keyframes.forEach((keyframe, keyframeIndex) => {
        register(keyframe.id, [...clipPath, 'keyframes', keyframeIndex, 'id'], 'keyframe');
        if (keyframe.time > clip.duration + 0.000001) context.addIssue({ code: z.ZodIssueCode.custom, path: [...clipPath, 'keyframes', keyframeIndex, 'time'], message: 'Keyframe exceeds clip duration' });
      });
      clip.speedCurve?.forEach((point, pointIndex) => {
        if (point.time > clip.duration + 0.000001) context.addIssue({ code: z.ZodIssueCode.custom, path: [...clipPath, 'speedCurve', pointIndex, 'time'], message: 'Speed point exceeds clip duration' });
      });
      if ((clip.fadeIn ?? 0) > clip.duration + 0.000001) context.addIssue({ code: z.ZodIssueCode.custom, path: [...clipPath, 'fadeIn'], message: 'Fade exceeds clip duration' });
      if ((clip.fadeOut ?? 0) > clip.duration + 0.000001) context.addIssue({ code: z.ZodIssueCode.custom, path: [...clipPath, 'fadeOut'], message: 'Fade exceeds clip duration' });
    });
  });
  if (project.duration + 0.000001 < requiredDuration) context.addIssue({ code: z.ZodIssueCode.custom, path: ['duration'], message: 'Project duration is shorter than its timeline' });
});
export type Project = z.infer<typeof ProjectSchema>;

export const ProjectAccessLeaseSchema = z.object({
  projectId: z.string().min(1),
  ownerId: z.string().min(1).max(120),
  ownerLabel: z.string().min(1).max(120),
  client: z.literal('cli'),
  acquiredAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});
export type ProjectAccessLease = z.infer<typeof ProjectAccessLeaseSchema>;

export type VisualLayerPlanItem = { clip: Clip; track: Track; trackIndex: number; stackOrder: number };

/** Shared back-to-front visual ordering for browser preview and FFmpeg export. */
export function visualLayerPlan(project: Project): VisualLayerPlanItem[] {
  let stackOrder = 0;
  return [...project.tracks]
    .sort((left, right) => left.order - right.order)
    .flatMap((track, trackIndex) => track.clips.map((clip) => ({ clip, track, trackIndex, stackOrder: stackOrder++ })))
    .filter(({ track }) => !track.hidden);
}

/**
 * Adjustment clips affect only visible visual layers below them in the shared
 * back-to-front stack, and only while the adjustment clip is active.
 */
export function adjustmentLayersForVisual(plan: readonly VisualLayerPlanItem[], visual: VisualLayerPlanItem, time: number) {
  return plan.filter(({ clip, stackOrder }) => clip.adjustment
    && stackOrder > visual.stackOrder
    && time >= clip.start
    && time < clip.start + clip.duration);
}

export type FrameWipe = { progress: number; direction: 'left' | 'right' | 'up' | 'down' | 'center' };
export type FrameVisualValues = {
  localTime: number;
  sourceTime: number;
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
  volume: number;
  speed: number;
  wipe: FrameWipe | null;
};

export type MediaFrameGeometry = {
  full: { width: number; height: number };
  render: { width: number; height: number };
  frame: { width: number; height: number };
  source: { width: number; height: number; left: number; top: number };
};

export type TextFrameGeometry = { width: number; height: number };

export type FrameVisualLayer = VisualLayerPlanItem & {
  asset?: Asset;
  values: FrameVisualValues;
  filters: Filter;
  fit: Transform['fit'];
  mediaGeometry?: MediaFrameGeometry;
  textGeometry?: TextFrameGeometry;
};

export type FrameAudioLayer = {
  clip: Clip;
  track: Track;
  asset: Asset;
  values: FrameVisualValues;
  gain: number;
};

export type FrameRenderPlan = {
  frameIndex: number;
  time: number;
  fps: number;
  canvas: Project['canvas'];
  visual: FrameVisualLayer[];
  audio: FrameAudioLayer[];
};

function transitionProgress(value: number, easing: Transition['easing'] = 'ease-in-out') {
  const time = clampNumber(value, 0, 1, 0);
  if (easing === 'ease-in') return time * time;
  if (easing === 'ease-out') return 1 - (1 - time) ** 2;
  if (easing === 'ease-in-out') return time < 0.5 ? 2 * time * time : 1 - (-2 * time + 2) ** 2 / 2;
  return time;
}

function transitionVector(direction: Transition['direction']) {
  if (direction === 'right') return { x: 1, y: 0 };
  if (direction === 'up') return { x: 0, y: -1 };
  if (direction === 'down') return { x: 0, y: 1 };
  if (direction === 'center') return { x: 0, y: 0 };
  return { x: -1, y: 0 };
}

/**
 * Evaluate every time-dependent clip property once for both render backends.
 * The browser consumes these numbers directly; the FFmpeg compiler mirrors the
 * same expressions for continuous rendering and is regression-tested against
 * this frame contract at boundaries and keyframes.
 */
export function evaluateClipFrame(clip: Clip, projectTime: number): FrameVisualValues {
  const localTime = clampNumber(projectTime - clip.start, 0, clip.duration, 0);
  const remaining = clip.duration - localTime;
  let transitionOpacity = 1;
  let transitionX = 0;
  let transitionY = 0;
  let transitionScale = 1;
  let wipe: FrameWipe | null = null;
  const applyTransition = (transition: Transition, progress: number, entering: boolean) => {
    if (transition.type === 'none') return;
    const eased = transitionProgress(progress, transition.easing);
    const intensity = clampNumber(transition.intensity ?? 1, 0.1, 2, 1);
    const direction = transition.direction ?? 'left';
    if (transition.type === 'fade' || transition.type === 'dissolve') transitionOpacity *= eased;
    if (transition.type === 'wipe') wipe = !wipe || eased < wipe.progress ? { progress: eased, direction } : wipe;
    if (transition.type === 'slide') {
      const vector = transitionVector(direction);
      const distance = (1 - eased) * 120 * intensity;
      transitionX += vector.x * distance;
      transitionY += vector.y * distance;
    }
    if (transition.type === 'zoom') {
      const amount = 0.18 * intensity;
      transitionScale *= entering ? Math.max(0.12, 1 - (1 - eased) * amount) : 1 + (1 - eased) * amount;
    }
  };
  const enter = clampNumber(clip.transitionIn?.duration ?? 0, 0, clip.duration, 0);
  const leave = clampNumber(clip.transitionOut?.duration ?? 0, 0, clip.duration, 0);
  if (enter > 0 && localTime < enter) applyTransition(clip.transitionIn, localTime / enter, true);
  if (leave > 0 && remaining < leave) applyTransition(clip.transitionOut, remaining / leave, false);
  const usesTransitionFadeIn = clip.transitionIn.type === 'fade' || clip.transitionIn.type === 'dissolve';
  const usesTransitionFadeOut = clip.transitionOut.type === 'fade' || clip.transitionOut.type === 'dissolve';
  const visualFadeIn = !usesTransitionFadeIn && (clip.fadeIn ?? 0) > 0 ? clampNumber(localTime / Math.max(0.000001, clip.fadeIn!), 0, 1, 1) : 1;
  const visualFadeOut = !usesTransitionFadeOut && (clip.fadeOut ?? 0) > 0 ? clampNumber(remaining / Math.max(0.000001, clip.fadeOut!), 0, 1, 1) : 1;
  const audioFadeIn = (clip.fadeIn ?? 0) > 0 ? clampNumber(localTime / Math.max(0.000001, clip.fadeIn!), 0, 1, 1) : 1;
  const audioFadeOut = (clip.fadeOut ?? 0) > 0 ? clampNumber(remaining / Math.max(0.000001, clip.fadeOut!), 0, 1, 1) : 1;
  return {
    localTime,
    sourceTime: clip.sourceStart + sourceTimeAt(clip.speedCurve, clip.speed, localTime),
    x: interpolateKeyframes(clip.keyframes, 'x', localTime, clip.transform.x) + transitionX,
    y: interpolateKeyframes(clip.keyframes, 'y', localTime, clip.transform.y) + transitionY,
    scale: interpolateKeyframes(clip.keyframes, 'scale', localTime, clip.transform.scale) * transitionScale,
    rotation: interpolateKeyframes(clip.keyframes, 'rotation', localTime, clip.transform.rotation),
    opacity: clampNumber(interpolateKeyframes(clip.keyframes, 'opacity', localTime, clip.transform.opacity) * transitionOpacity * visualFadeIn * visualFadeOut, 0, 1, 1),
    volume: clampNumber(interpolateKeyframes(clip.keyframes, 'volume', localTime, clip.volume) * audioFadeIn * audioFadeOut, 0, 2, 1),
    speed: speedAt(clip.speedCurve, clip.speed, localTime),
    wipe,
  };
}

/** Combine clip and active higher adjustment-layer filters deterministically. */
export function mergeVisualFilters(base: Filter, layers: readonly Filter[]): Filter {
  const stack = [base, ...layers];
  return {
    ...base,
    brightness: clampNumber(stack.reduce((sum, filter) => sum + (filter.brightness ?? 0), 0), -1, 1, 0),
    contrast: clampNumber(stack.reduce((sum, filter) => sum + (filter.contrast ?? 0), 0), -1, 1, 0),
    saturation: clampNumber(stack.reduce((sum, filter) => sum + (filter.saturation ?? 0), 0), -1, 1, 0),
    temperature: clampNumber(stack.reduce((sum, filter) => sum + (filter.temperature ?? 0), 0), -1, 1, 0),
    hue: clampNumber(stack.reduce((sum, filter) => sum + (filter.hue ?? 0), 0), -180, 180, 0),
    vignette: clampNumber(stack.reduce((sum, filter) => sum + (filter.vignette ?? 0), 0), 0, 1, 0),
    blur: clampNumber(stack.reduce((sum, filter) => sum + (filter.blur ?? 0), 0), 0, 24, 0),
    grayscale: clampNumber(stack.reduce((sum, filter) => sum + (filter.grayscale ?? 0), 0), 0, 1, 0),
    chromaKey: [...stack].reverse().find((filter) => filter.chromaKey)?.chromaKey,
  };
}

function fittedBounds(sourceWidth: number, sourceHeight: number, canvasWidth: number, canvasHeight: number, fit: Transform['fit']) {
  if (fit === 'stretch') return { width: canvasWidth, height: canvasHeight };
  const ratio = fit === 'cover'
    ? Math.max(canvasWidth / sourceWidth, canvasHeight / sourceHeight)
    : Math.min(canvasWidth / sourceWidth, canvasHeight / sourceHeight);
  return { width: sourceWidth * ratio, height: sourceHeight * ratio };
}

/** Canvas-space media geometry shared by selection UI and the fast compositor. */
export function resolveMediaFrameGeometry(asset: Asset, crop: Clip['crop'], canvasWidth: number, canvasHeight: number, fit: Transform['fit']): MediaFrameGeometry {
  const sourceWidth = Math.max(1, asset.width ?? canvasWidth);
  const sourceHeight = Math.max(1, asset.height ?? canvasHeight);
  const full = fittedBounds(sourceWidth, sourceHeight, canvasWidth, canvasHeight, fit);
  const cropX = crop ? clampNumber(crop.x, 0, 0.99, 0) : 0;
  const cropY = crop ? clampNumber(crop.y, 0, 0.99, 0) : 0;
  const cropWidth = crop ? clampNumber(Math.min(crop.width, 1 - cropX), 0.01, 1, 1) : 1;
  const cropHeight = crop ? clampNumber(Math.min(crop.height, 1 - cropY), 0.01, 1, 1) : 1;
  const render = crop
    ? fittedBounds(Math.max(1, sourceWidth * cropWidth), Math.max(1, sourceHeight * cropHeight), canvasWidth, canvasHeight, fit)
    : full;
  const frame = fit === 'cover' || fit === 'stretch' ? { width: canvasWidth, height: canvasHeight } : render;
  const innerWidth = crop ? render.width / cropWidth : full.width;
  const innerHeight = crop ? render.height / cropHeight : full.height;
  return {
    full,
    render,
    frame,
    source: {
      width: innerWidth,
      height: innerHeight,
      left: (frame.width - render.width) / 2 - cropX * innerWidth,
      top: (frame.height - render.height) / 2 - cropY * innerHeight,
    },
  };
}

/** Stable text box estimate used by both canvas drawing and export planning. */
export function resolveTextFrameGeometry(style: TextStyle, canvasWidth: number, canvasHeight: number, _renderScale = 1): TextFrameGeometry {
  // Geometry is always expressed in authored canvas pixels. Display zoom must
  // never change layout or the preview will disagree with an exported frame.
  const effectiveFontSize = style.fontSize;
  const lines = normalizeTextLineBreaks(style.text).split('\n');
  const longestLine = Math.max(1, ...lines.map((line) => line.length));
  const estimatedWidth = longestLine * effectiveFontSize * 0.58 + Math.max(0, longestLine - 1) * style.letterSpacing + style.padding * 2;
  return {
    width: Math.min(canvasWidth * 0.9, Math.max(64, estimatedWidth)),
    height: Math.min(canvasHeight * 0.75, Math.max(effectiveFontSize, lines.length * effectiveFontSize * style.lineHeight + style.padding * 2)),
  };
}

/** Build the canonical, frame-quantized preview/export semantics for one frame. */
export function evaluateFrameRenderPlan(project: Project, requestedTime: number): FrameRenderPlan {
  const fps = Number.isFinite(project.canvas.fps) && project.canvas.fps > 0 ? project.canvas.fps : 30;
  const frameIndex = Math.max(0, Math.round(clampNumber(requestedTime, 0, project.duration, 0) * fps));
  const time = Math.min(project.duration, frameIndex / fps);
  const plan = visualLayerPlan(project);
  const assets = new Map(project.assets.map((asset) => [asset.id, asset]));
  const visual = plan.flatMap((item): FrameVisualLayer[] => {
    const { clip } = item;
    if (clip.adjustment || time < clip.start || time >= clip.start + clip.duration) return [];
    const asset = clip.assetId ? assets.get(clip.assetId) : undefined;
    const fit = effectiveVisualFit(project.canvas.fitMode, clip.transform.fit);
    const filters = mergeVisualFilters(clip.filters, adjustmentLayersForVisual(plan, item, time).map((layer) => layer.clip.filters));
    const values = evaluateClipFrame(clip, time);
    const textStyle = clip.textStyle;
    return [{
      ...item,
      asset,
      values,
      filters,
      fit,
      mediaGeometry: asset && (clip.type === 'video' || clip.type === 'image')
        ? resolveMediaFrameGeometry(asset, clip.crop, project.canvas.width, project.canvas.height, fit)
        : undefined,
      textGeometry: textStyle ? resolveTextFrameGeometry(textStyle, project.canvas.width, project.canvas.height) : undefined,
    }];
  });
  const audio = [...project.tracks]
    .sort((left, right) => left.order - right.order)
    .flatMap((track): FrameAudioLayer[] => track.muted ? [] : track.clips.flatMap((clip): FrameAudioLayer[] => {
      if (time < clip.start || time >= clip.start + clip.duration || (clip.type !== 'audio' && clip.type !== 'video') || !clip.assetId) return [];
      const asset = assets.get(clip.assetId);
      if (!asset?.hasAudio) return [];
      const values = evaluateClipFrame(clip, time);
      return [{ clip, track, asset, values, gain: clampNumber(values.volume * track.volume, 0, 4, 1) }];
    }));
  return { frameIndex, time, fps, canvas: project.canvas, visual, audio };
}

export type ProjectMergeResult = { project: Project; conflicts: string[] };

function jsonEqual(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function mergeProjectValue(base: unknown, local: unknown, remote: unknown, path: string, conflicts: string[]): unknown {
  if (jsonEqual(local, remote)) return local;
  if (jsonEqual(local, base)) return remote;
  if (jsonEqual(remote, base)) return local;

  if (Array.isArray(base) && Array.isArray(local) && Array.isArray(remote) && [...base, ...local, ...remote].every((item) => isRecord(item) && typeof item.id === 'string')) {
    const byId = (items: Record<string, unknown>[]) => new Map(items.map((item) => [item.id as string, item]));
    const baseById = byId(base as Record<string, unknown>[]);
    const localById = byId(local as Record<string, unknown>[]);
    const remoteById = byId(remote as Record<string, unknown>[]);
    const orderedIds = [...new Set([...baseById.keys(), ...localById.keys(), ...remoteById.keys()])];
    return orderedIds.flatMap((id) => {
      const baseItem = baseById.get(id);
      const localItem = localById.get(id);
      const remoteItem = remoteById.get(id);
      if (baseItem && !localItem && remoteItem) {
        // Deleting a library asset deliberately wins over server-generated
        // derivative metadata refreshes. Timeline entities, however, must not
        // silently discard a genuine edit from the other tab.
        if (path === 'assets' || jsonEqual(remoteItem, baseItem)) return [];
        conflicts.push(`${path}[${id}]`);
        return [];
      }
      if (baseItem && localItem && !remoteItem) {
        if (jsonEqual(localItem, baseItem)) return [];
        conflicts.push(`${path}[${id}]`);
        return [localItem];
      }
      if (baseItem && !localItem && !remoteItem) return [];
      if (!baseItem) return [localItem ?? remoteItem];
      return [mergeProjectValue(baseItem, localItem, remoteItem, `${path}[${id}]`, conflicts)];
    });
  }

  if (isRecord(base) && isRecord(local) && isRecord(remote)) {
    const result: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])) {
      result[key] = mergeProjectValue(base[key], local[key], remote[key], path ? `${path}.${key}` : key, conflicts);
    }
    return result;
  }

  conflicts.push(path || 'project');
  // Preserve the local value in the recovery snapshot.  The caller must not
  // save it automatically when conflicts are present.
  return local;
}

/**
 * Three-way reconciliation for a stale editor tab.  It merges independent
 * edits but deliberately reports competing edits to the same leaf instead of
 * silently overwriting the other tab.  Revision/timestamps are server-owned.
 */
export function mergeProjectThreeWay(base: Project, local: Project, remote: Project): ProjectMergeResult {
  const conflicts: string[] = [];
  const merged = mergeProjectValue(base, local, remote, '', conflicts) as Project;
  return {
    project: {
      ...merged,
      id: remote.id,
      revision: remote.revision,
      createdAt: remote.createdAt,
      updatedAt: remote.updatedAt,
    },
    conflicts,
  };
}

export const ShortcutSettingsSchema = z.object({
  togglePlayback: z.string().min(1).max(40).default('Space'),
  undo: z.string().min(1).max(40).default('Ctrl/Cmd+Z'),
  redo: z.string().min(1).max(40).default('Ctrl/Cmd+Shift+Z'),
  split: z.string().min(1).max(40).default('B'),
  setIn: z.string().min(1).max(40).default('I'),
  setOut: z.string().min(1).max(40).default('O'),
  clearRange: z.string().min(1).max(40).default('X'),
  deleteClip: z.string().min(1).max(40).default('Delete'),
  duplicate: z.string().min(1).max(40).default('Ctrl/Cmd+D'),
  selectAll: z.string().min(1).max(40).default('Ctrl/Cmd+A'),
});
export type ShortcutSettings = z.infer<typeof ShortcutSettingsSchema>;

/** Canonical release shortcuts. The application exposes these as read-only. */
export const DEFAULT_SHORTCUT_SETTINGS: ShortcutSettings = ShortcutSettingsSchema.parse({});

export const WorkspaceLayoutSchema = z.object({
  railWidth: z.number().min(48).max(96).default(56),
  libraryWidth: z.number().min(210).max(420).default(270),
  inspectorWidth: z.number().min(240).max(460).default(304),
  timelineHeight: z.number().min(180).max(460).default(265),
});
export type WorkspaceLayout = z.infer<typeof WorkspaceLayoutSchema>;

export const SettingsSchema = z.object({
  language: z.enum(['en', 'tr']).default('en'),
  proxyQuality: z.enum(['draft', 'balanced', 'high']).default('balanced'),
  defaultExport: z.object({
    format: z.enum(['mp4', 'mp3', 'wav']).default('mp4'),
    aspect: CanvasAspectSchema.default('16:9'),
    resolution: z.enum(['720p', '1080p', '2K', '4K']).default('1080p'),
    fps: z.union([z.literal(23.976), z.literal(24), z.literal(25), z.literal(29.97), z.literal(30), z.literal(50), z.literal(59.94), z.literal(60)]).default(30),
    quality: z.enum(['draft', 'standard', 'high', 'custom']).default('standard'),
    audioBitrateKbps: z.union([z.literal(128), z.literal(192), z.literal(256)]).default(256),
  }),
  // Video export currently uses libx264 on the CPU.  Hardware encoders must be
  // detected and tested before they can be exposed as a real preference.
  hardwareAcceleration: z.literal('software').default('software'),
  // AI is deliberately unavailable until its data-flow and providers have
  // completed a dedicated privacy/security review.
  experimentalAi: z.literal(false).default(false),
  aiProvider: z.enum(['openai', 'gemini']).default('openai'),
  aiModel: z.string().default(''),
  shortcuts: ShortcutSettingsSchema.default({}),
  workspaceLayout: WorkspaceLayoutSchema.default({}),
  hasOpenAiKey: z.boolean().default(false),
  hasGeminiKey: z.boolean().default(false),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const ExportFormatSchema = z.enum(['mp4', 'mp3', 'wav']);
export type ExportFormat = z.infer<typeof ExportFormatSchema>;

export const ExportResolutionSchema = z.enum(['720p', '1080p', '2K', '4K']);
export type ExportResolution = z.infer<typeof ExportResolutionSchema>;

export const EXPORT_RESOLUTION_PROFILES: ReadonlyArray<{
  value: ExportResolution;
  pixels: number;
  label: string;
}> = [
  { value: '720p', pixels: 720, label: '720p HD' },
  { value: '1080p', pixels: 1080, label: '1080p Full HD' },
  { value: '2K', pixels: 1440, label: '1440p QHD' },
  { value: '4K', pixels: 2160, label: '2160p UHD' },
];

const exportAspectRatios: Record<CanvasAspect, number> = {
  '16:9': 16 / 9,
  '9:16': 9 / 16,
  '1:1': 1,
  '4:5': 4 / 5,
  '3:2': 3 / 2,
  // Keep this aligned with the editor's 2560x1080 cinematic canvas preset.
  '21:9': 2560 / 1080,
};

/**
 * Resolve the exact even-pixel output size shared by the UI and FFmpeg.
 * Resolution labels describe the short edge: 720, 1080, 1440 or 2160 px.
 */
export function exportDimensions(
  aspect: CanvasAspect | 'source',
  resolution: ExportResolution,
  source?: { width: number; height: number },
) {
  const sourceRatio = source && source.width > 0 && source.height > 0 ? source.width / source.height : exportAspectRatios['16:9'];
  const ratio = aspect === 'source' ? sourceRatio : exportAspectRatios[aspect];
  const shortEdge = EXPORT_RESOLUTION_PROFILES.find((profile) => profile.value === resolution)?.pixels ?? 1080;
  const rawWidth = ratio >= 1 ? Math.round(shortEdge * ratio) : shortEdge;
  const rawHeight = ratio >= 1 ? shortEdge : Math.round(shortEdge / ratio);
  const even = (value: number) => Math.max(2, value % 2 === 0 ? value : value + 1);
  return { width: even(rawWidth), height: even(rawHeight) };
}

export const EXPORT_FRAME_RATES = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60] as const;
export const ExportFpsSchema = z.union([z.literal(23.976), z.literal(24), z.literal(25), z.literal(29.97), z.literal(30), z.literal(50), z.literal(59.94), z.literal(60)]);
export type ExportFps = z.infer<typeof ExportFpsSchema>;

export const ExportQualitySchema = z.enum(['draft', 'standard', 'high', 'custom']);
export type ExportQuality = z.infer<typeof ExportQualitySchema>;

export function recommendedVideoBitrateKbps(
  resolution: ExportResolution,
  fps: ExportFps,
  quality: ExportQuality,
  dimensions?: { width: number; height: number },
) {
  const baseByResolution: Record<ExportResolution, number> = {
    '720p': 5000,
    '1080p': 8000,
    '2K': 16000,
    '4K': 35000,
  };
  const shortEdge = EXPORT_RESOLUTION_PROFILES.find((profile) => profile.value === resolution)?.pixels ?? 1080;
  const baselinePixels = shortEdge * shortEdge * (16 / 9);
  const actualPixels = dimensions ? dimensions.width * dimensions.height : baselinePixels;
  const pixelFactor = clamp(actualPixels / baselinePixels, 0.65, 1.6);
  const fpsFactor = clamp(fps / 30, 0.8, 1.5);
  const qualityFactor = quality === 'draft' ? 0.7 : quality === 'high' ? 1.35 : 1;
  return Math.round(baseByResolution[resolution] * pixelFactor * fpsFactor * qualityFactor / 250) * 250;
}

export const ExportRangeSchema = z.object({
  start: z.number().finite().nonnegative(),
  end: z.number().finite().positive(),
}).refine((range) => range.end > range.start, { message: 'INVALID_EXPORT_RANGE' });
export type ExportRange = z.infer<typeof ExportRangeSchema>;

export const ExportOptionsSchema = z.object({
  format: ExportFormatSchema.default('mp4'),
  aspect: CanvasAspectSchema.or(z.literal('source')).default('source'),
  resolution: ExportResolutionSchema.default('1080p'),
  fps: ExportFpsSchema.default(30),
  quality: ExportQualitySchema.default('standard'),
  rateMode: z.enum(['crf', 'bitrate']).default('crf'),
  crf: z.number().int().min(16).max(32).optional(),
  videoBitrateKbps: z.number().int().min(500).max(50000).optional(),
  audioBitrateKbps: z.union([z.literal(128), z.literal(192), z.literal(256)]).default(256),
  range: ExportRangeSchema.optional(),
  fileName: z.string().max(120).optional(),
});
export type ExportOptions = z.infer<typeof ExportOptionsSchema>;

export const ExportPreflightSchema = z.object({
  ok: z.boolean(),
  errors: z.array(z.object({ code: z.string(), message: z.string() })).default([]),
  warnings: z.array(z.object({ code: z.string(), message: z.string() })).default([]),
  estimatedBytes: z.number().nonnegative().optional(),
});
export type ExportPreflight = z.infer<typeof ExportPreflightSchema>;

export const ExportJobResultSchema = z.object({
  jobId: z.string(),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']),
  fileName: z.string().optional(),
  format: ExportFormatSchema.optional(),
  downloadUrl: z.string().optional(),
});
export type ExportJobResult = z.infer<typeof ExportJobResultSchema>;

export const JobSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  kind: z.enum(['import', 'proxy', 'export', 'ai']),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']),
  progress: z.number().min(0).max(1).default(0),
  message: z.string().optional(),
  fileName: z.string().optional(),
  format: ExportFormatSchema.optional(),
  downloadUrl: z.string().optional(),
  phase: z.string().optional(),
  etaSeconds: z.number().nonnegative().optional(),
  error: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Job = z.infer<typeof JobSchema>;

export const defaultProject = (id: string, name = 'Yeni proje'): Project => {
  const now = new Date().toISOString();
  return ProjectSchema.parse({
    schemaVersion: 1,
    id,
    name,
    createdAt: now,
    updatedAt: now,
    revision: 0,
    canvas: { width: 1920, height: 1080, aspect: '16:9', fitMode: 'fit', fps: 30, background: '#101116' },
    duration: 0,
    assets: [],
    tracks: [
      { id: 'track-layer-1', type: 'layer', name: 'Layer 1', order: 0, clips: [] },
      { id: 'track-layer-2', type: 'layer', name: 'Layer 2', order: 1, clips: [] },
      { id: 'track-layer-3', type: 'layer', name: 'Layer 3', order: 2, clips: [] },
      { id: 'track-layer-4', type: 'layer', name: 'Layer 4', order: 3, clips: [] },
    ],
    markers: [],
  });
};

export const defaultSettings = (): Settings => SettingsSchema.parse({
  language: 'en',
  proxyQuality: 'balanced',
  defaultExport: { format: 'mp4', aspect: '16:9', resolution: '1080p', fps: 30, quality: 'standard', audioBitrateKbps: 256 },
  hardwareAcceleration: 'software',
  experimentalAi: false,
  aiProvider: 'openai',
  aiModel: '',
  shortcuts: {},
  workspaceLayout: { railWidth: 52, libraryWidth: 232, inspectorWidth: 280, timelineHeight: 238 },
  hasOpenAiKey: false,
  hasGeminiKey: false,
});

export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Quantize a timeline value to an exact frame boundary. */
export function quantizeFrameTime(value: number, fps: number, duration = Number.POSITIVE_INFINITY) {
  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : 30;
  const safeValue = Number.isFinite(value) ? value : 0;
  return clamp(Math.round(safeValue * safeFps) / safeFps, 0, duration);
}

/** Wall-clock playback position; FPS is deliberately not part of this clock. */
export function playbackTime(startProjectTime: number, startWallTimeMs: number, nowMs: number, duration: number) {
  return clamp(startProjectTime + Math.max(0, nowMs - startWallTimeMs) / 1000, 0, Math.max(0, duration));
}

export function projectDuration(project: Project) {
  return Math.max(0, ...project.tracks.flatMap((track) => track.clips.map((clip) => clip.start + clip.duration)));
}

/** Restore immutable locked-track snapshots, except for an explicit unlock. */
export function enforceLockedTrackInvariants(previous: Project, candidate: Project): Project {
  const lockedTracks = previous.tracks.filter((track) => track.locked);
  if (!lockedTracks.length) return candidate;
  const next = structuredClone(candidate);
  const explicitlyUnlockedTrackIds = new Set(lockedTracks
    .filter((original) => next.tracks.some((track) => track.id === original.id && !track.locked))
    .map((track) => track.id));
  const lockedClipIds = new Set(lockedTracks
    .filter((track) => !explicitlyUnlockedTrackIds.has(track.id))
    .flatMap((track) => track.clips.map((clip) => clip.id)));
  for (const track of next.tracks) track.clips = track.clips.filter((clip) => !lockedClipIds.has(clip.id));
  for (const original of lockedTracks) {
    const previousIndex = previous.tracks.findIndex((track) => track.id === original.id);
    const nextIndex = next.tracks.findIndex((track) => track.id === original.id);
    const target = nextIndex >= 0 ? next.tracks[nextIndex] : undefined;
    if (explicitlyUnlockedTrackIds.has(original.id)) continue;
    if (nextIndex >= 0) next.tracks.splice(nextIndex, 1);
    next.tracks.splice(Math.min(previousIndex, next.tracks.length), 0, structuredClone(original));
  }
  next.tracks.forEach((track, order) => { track.order = order; });
  next.duration = projectDuration(next);
  return next;
}

function generatedClipId() {
  return 'clip_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function remapKeyframes(keyframes: Clip['keyframes'], start: number, end: number, offset: number) {
  const duration = Math.max(0, end - start);
  return [...new Set(keyframes.map((keyframe) => keyframe.property))].flatMap((property) => {
    const propertyPoints = keyframes.filter((keyframe) => keyframe.property === property).sort((a, b) => a.time - b.time);
    if (!propertyPoints.length) return [];
    const sliced = propertyPoints
      .filter((keyframe) => keyframe.time >= start - 0.000001 && keyframe.time <= end + 0.000001)
      .map((keyframe) => ({ ...keyframe, time: clamp(keyframe.time - offset, 0, duration) }));
    if (!sliced.some((keyframe) => keyframe.time <= 0.000001)) {
      sliced.push({ ...propertyPoints[0], id: `${propertyPoints[0].id}-slice-start-${start}`, time: 0, value: interpolateKeyframes(propertyPoints, property, start, propertyPoints[0].value), easing: 'linear' });
    }
    if (!sliced.some((keyframe) => Math.abs(keyframe.time - duration) <= 0.000001)) {
      const last = propertyPoints[propertyPoints.length - 1];
      const next = propertyPoints.find((keyframe) => keyframe.time >= end) ?? last;
      sliced.push({ ...last, id: `${last.id}-slice-end-${end}`, time: duration, value: interpolateKeyframes(propertyPoints, property, end, last.value), easing: next.easing });
    }
    return sliced.sort((a, b) => a.time - b.time);
  });
}

function sliceSpeedCurve(speedCurve: Clip['speedCurve'], start: number, end: number, baseSpeed: number) {
  if (!speedCurve?.length) return undefined;
  const safeStart = Math.max(0, start);
  const safeEnd = Math.max(safeStart, end);
  const points = normalizedSpeedPoints(speedCurve)
    .filter((point) => point.time >= start - 0.000001 && point.time <= end + 0.000001)
    .map((point) => ({ ...point, time: clamp(point.time - safeStart, 0, Math.max(0, safeEnd - safeStart)) }));
  const startPoint = { time: 0, speed: speedAt(speedCurve, baseSpeed, safeStart), easing: 'linear' as const };
  const endPoint = { time: Math.max(0, safeEnd - safeStart), speed: speedAt(speedCurve, baseSpeed, safeEnd), easing: 'linear' as const };
  const merged = [startPoint, ...points, endPoint].sort((a, b) => a.time - b.time);
  return merged.filter((point, index, all) => index === 0 || point.time - all[index - 1].time > 0.000001);
}

function slicedTransition(transition: Clip['transitionIn'], localStart: number, localEnd: number, originalDuration: number, entering: boolean) {
  if (!transition || transition.type === 'none') return transition;
  const duration = clamp(transition.duration, 0, originalDuration);
  const boundary = entering ? duration : originalDuration - duration;
  const remaining = entering
    ? boundary - localStart
    : localEnd - Math.max(localStart, boundary);
  if (remaining <= 0.000001) return { ...transition, type: 'none' as const, duration: 0 };
  return { ...transition, duration: Math.min(localEnd - localStart, remaining) };
}

function slicedFade(value: number | undefined, localStart: number, localEnd: number, originalDuration: number, entering: boolean) {
  if (value === undefined) return undefined;
  const duration = clamp(value, 0, originalDuration);
  const boundary = entering ? duration : originalDuration - duration;
  const remaining = entering
    ? boundary - localStart
    : localEnd - Math.max(localStart, boundary);
  return remaining <= 0.000001 ? 0 : Math.min(localEnd - localStart, remaining);
}

/**
 * Return a clip whose local timeline interval is sliced and rebased to zero.
 * Source timing is calculated from the integral of the speed curve, while
 * keyframes, speed knots, fades and transitions are all clipped to the same
 * interval.  The returned `start` is the original start plus `localStart`;
 * callers that render a range can rebase it to the range origin afterwards.
 */
export function sliceClipForRange(clip: Clip, localStart: number, localEnd: number): Clip {
  const originalDuration = Math.max(0.000001, Number.isFinite(clip.duration) ? clip.duration : 0.000001);
  const start = clamp(Number.isFinite(localStart) ? localStart : 0, 0, originalDuration);
  const end = clamp(Number.isFinite(localEnd) ? localEnd : originalDuration, start, originalDuration);
  const duration = Math.max(0.000001, end - start);
  const speed = clampNumber(clip.speed, 0.1, 10, 1);
  const sourceAtStart = sourceTimeAt(clip.speedCurve, speed, start);
  const sourceAtEnd = sourceTimeAt(clip.speedCurve, speed, end);
  return {
    ...clip,
    start: clip.start + start,
    duration,
    sourceStart: Math.max(0, clip.sourceStart + sourceAtStart),
    sourceDuration: Math.max(0.000001, sourceAtEnd - sourceAtStart),
    transitionIn: slicedTransition(clip.transitionIn, start, end, originalDuration, true),
    transitionOut: slicedTransition(clip.transitionOut, start, end, originalDuration, false),
    fadeIn: slicedFade(clip.fadeIn, start, end, originalDuration, true),
    fadeOut: slicedFade(clip.fadeOut, start, end, originalDuration, false),
    keyframes: remapKeyframes(clip.keyframes, start, end, start),
    speedCurve: sliceSpeedCurve(clip.speedCurve, start, end, speed),
  };
}

/** Trim a clip to absolute project boundaries using the shared range slicer. */
export function trimClip(project: Project, clipId: string, newStart: number, newEnd: number, sourceClip?: Clip) {
  const track = project.tracks.find((item) => item.clips.some((clip) => clip.id === clipId));
  const clip = track?.clips.find((item) => item.id === clipId);
  if (!track || !clip || track.locked) return false;
  const base = sourceClip ?? clip;
  const frame = 1 / Math.max(1, project.canvas.fps);
  const baseStart = base.start;
  const baseEnd = base.start + base.duration;
  const canExtendStill = base.type === 'image';
  const start = clamp(Number.isFinite(newStart) ? newStart : baseStart, baseStart, baseEnd - frame);
  const requestedEnd = Number.isFinite(newEnd) ? newEnd : baseEnd;
  const end = canExtendStill && requestedEnd > baseEnd
    ? Math.max(start + frame, requestedEnd)
    : clamp(requestedEnd, start + frame, baseEnd);
  if (canExtendStill && end > baseEnd) {
    const next = structuredClone(base);
    retimeClipMotion(next, end - start);
    next.sourceStart = base.sourceStart;
    next.sourceDuration = Math.max(frame, end - start);
    Object.assign(clip, next, { start, duration: end - start });
    project.duration = projectDuration(project);
    return true;
  }
  const sliced = sliceClipForRange(base, start - baseStart, end - baseStart);
  Object.assign(clip, sliced, { start, duration: Math.max(frame, end - start) });
  project.duration = projectDuration(project);
  return true;
}

/**
 * Split a clip without changing its source timing.  The optional id factory
 * keeps the command deterministic in unit tests while the editor can continue
 * to use unique runtime ids.
 */
export function splitClipAt(project: Project, clipId: string, at: number, createId: () => string = generatedClipId) {
  const track = project.tracks.find((item) => item.clips.some((clip) => clip.id === clipId));
  const index = track?.clips.findIndex((clip) => clip.id === clipId) ?? -1;
  if (!track || index < 0 || track.locked) return false;
  const clip = track.clips[index];
  const frame = 1 / Math.max(1, project.canvas.fps);
  if (!Number.isFinite(at) || at - clip.start < frame - 0.000001 || clip.start + clip.duration - at < frame - 0.000001) return false;
  const firstDuration = at - clip.start;
  const originalDuration = clip.duration;
  const first = sliceClipForRange(clip, 0, firstDuration);
  const second = { ...sliceClipForRange(clip, firstDuration, originalDuration), id: createId(), start: at };
  Object.assign(clip, first, { start: clip.start, duration: firstDuration });
  track.clips.splice(index + 1, 0, second);
  project.duration = projectDuration(project);
  return true;
}

export function trimClipToPlayhead(project: Project, clipId: string, at: number, edge: 'start' | 'end') {
  const track = project.tracks.find((item) => item.clips.some((clip) => clip.id === clipId));
  const clip = track?.clips.find((item) => item.id === clipId);
  if (!track || !clip || track.locked) return false;
  if (at <= clip.start || at >= clip.start + clip.duration) return false;
  return edge === 'start'
    ? trimClip(project, clipId, at, clip.start + clip.duration)
    : trimClip(project, clipId, clip.start, at);
}

export function rippleDeleteClip(project: Project, clipId: string) {
  const track = project.tracks.find((item) => item.clips.some((clip) => clip.id === clipId));
  const clip = track?.clips.find((item) => item.id === clipId);
  if (!track || !clip || track.locked) return false;
  const end = clip.start + clip.duration;
  track.clips = track.clips.filter((item) => item.id !== clipId);
  for (const item of track.clips) {
    if (item.start >= end) item.start = Math.max(0, item.start - clip.duration);
  }
  project.duration = projectDuration(project);
  return true;
}

/** Ripple delete across every unlocked track, preserving clips that span the removed range. */
export function rippleDeleteAcrossTimeline(project: Project, clipId: string) {
  const sourceTrack = project.tracks.find((item) => item.clips.some((clip) => clip.id === clipId));
  const clip = sourceTrack?.clips.find((item) => item.id === clipId);
  if (!sourceTrack || !clip || sourceTrack.locked) return false;
  const end = clip.start + clip.duration;
  const shift = clip.duration;
  sourceTrack.clips = sourceTrack.clips.filter((item) => item.id !== clipId);
  for (const track of project.tracks) {
    if (track.locked) continue;
    for (const item of track.clips) {
      if (item.start >= end - 0.000001) item.start = Math.max(0, item.start - shift);
    }
  }
  project.duration = projectDuration(project);
  return true;
}

export type SnapTimeOptions = {
  enabled?: boolean;
  threshold?: number;
  currentTime?: number;
  rangeStart?: number | null;
  rangeEnd?: number | null;
  excludeClipIds?: Iterable<string>;
  excludeMarkerIds?: Iterable<string>;
  clampToDuration?: boolean;
  includeProjectEnd?: boolean;
};

export function snapTimeCandidate(project: Project, value: number, options: SnapTimeOptions = {}) {
  const safeValue = options.clampToDuration === false ? Math.max(0, value) : clamp(value, 0, project.duration);
  if (options.enabled === false) return null;
  const threshold = options.threshold ?? 0.08;
  const excludedClipIds = new Set(options.excludeClipIds ?? []);
  const excludedMarkerIds = new Set(options.excludeMarkerIds ?? []);
  const clipEdges = project.tracks.flatMap((track) => track.clips.filter((clip) => !excludedClipIds.has(clip.id)).flatMap((clip) => [clip.start, clip.start + clip.duration]));
  const rangeEdges = [options.rangeStart ?? null, options.rangeEnd ?? null].filter((edge): edge is number => edge !== null);
  const projectEdges = options.includeProjectEnd === false ? [0] : [0, project.duration];
  const candidates = [...projectEdges, options.currentTime, ...rangeEdges, ...clipEdges, ...project.markers.filter((marker) => !excludedMarkerIds.has(marker.id)).map((marker) => marker.time)].filter((item): item is number => typeof item === 'number');
  const nearest = candidates.reduce<number | null>((best, candidate) => {
    if (Math.abs(candidate - safeValue) >= threshold) return best;
    return best === null || Math.abs(candidate - safeValue) < Math.abs(best - safeValue) ? candidate : best;
  }, null);
  return nearest;
}

export function snapTime(project: Project, value: number, options: SnapTimeOptions = {}) {
  const safeValue = options.clampToDuration === false ? Math.max(0, value) : clamp(value, 0, project.duration);
  if (options.enabled === false) return safeValue;
  const nearest = snapTimeCandidate(project, safeValue, options);
  return nearest ?? Math.round(safeValue * project.canvas.fps) / project.canvas.fps;
}

export function formatTime(seconds: number, showFrames = false, fps = 30) {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const frames = Math.floor((safe % 1) * fps);
  const base = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  return showFrames ? `${base}:${String(frames).padStart(2, '0')}` : base;
}

/**
 * Parses editor timecodes without accepting ambiguous overflow. Supported
 * forms are SS, MM:SS, HH:MM:SS and HH:MM:SS:FF.
 */
export function parseTimelineTimecode(value: string, fps = 30) {
  const parts = value.trim().split(':');
  if (parts.length < 1 || parts.length > 4 || parts.some((part) => !/^\d+$/.test(part))) return null;
  const numbers = parts.map(Number);
  const safeFps = Math.max(1, Math.round(fps));
  let hours = 0;
  let minutes = 0;
  let seconds = 0;
  let frames = 0;
  if (numbers.length === 4) [hours, minutes, seconds, frames] = numbers;
  if (numbers.length === 3) [hours, minutes, seconds] = numbers;
  if (numbers.length === 2) [minutes, seconds] = numbers;
  if (numbers.length === 1) [seconds] = numbers;
  if (minutes >= 60 || seconds >= 60 || frames >= safeFps) return null;
  return hours * 3600 + minutes * 60 + seconds + frames / safeFps;
}
