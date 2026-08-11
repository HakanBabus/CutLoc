import { z } from 'zod';

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

export const KeyframeProperty = z.enum(['x', 'y', 'scale', 'rotation', 'opacity', 'volume']);
export type KeyframeProperty = z.infer<typeof KeyframeProperty>;

export const KeyframeSchema = z.object({
  id: z.string(),
  property: KeyframeProperty,
  time: z.number().nonnegative(),
  value: z.number(),
  easing: z.enum(['linear', 'ease-in', 'ease-out', 'ease-in-out']).default('linear'),
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
  const points = [...(speedCurve ?? [])]
    .filter((point) => Number.isFinite(point.time) && Number.isFinite(point.speed))
    .sort((a, b) => a.time - b.time);
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
  const breakpoints = [0, ...speedCurve.map((point) => point.time).filter((point) => Number.isFinite(point) && point > 0 && point < safeTime), safeTime]
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
  const knots = [0, ...speedCurve.map((point) => point.time).filter((point) => Number.isFinite(point) && point > 0 && point < safeDuration), safeDuration]
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
  speed: z.number().min(0.1).max(10),
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
  id: z.string(),
  name: z.string(),
  type: AssetType,
  mimeType: z.string(),
  path: z.string(),
  proxyPath: z.string().optional(),
  thumbnailPath: z.string().optional(),
  waveformPath: z.string().optional(),
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
  id: z.string(),
  assetId: z.string().optional(),
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
  id: z.string(),
  type: TrackType,
  name: z.string(),
  order: z.number().int(),
  locked: z.boolean().default(false),
  hidden: z.boolean().default(false),
  muted: z.boolean().default(false),
  volume: z.number().min(0).max(2).default(1),
  clips: z.array(ClipSchema).default([]),
});
export type Track = z.infer<typeof TrackSchema>;

export const ProjectSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
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
  markers: z.array(z.object({ id: z.string(), time: z.number().nonnegative(), label: z.string() })).default([]),
});
export type Project = z.infer<typeof ProjectSchema>;

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
    fps: z.number().positive().default(30),
    quality: z.enum(['draft', 'standard', 'high', 'custom']).default('standard'),
    audioBitrateKbps: z.union([z.literal(128), z.literal(192), z.literal(256)]).default(192),
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
  const shortEdge = resolution === '720p' ? 720 : resolution === '2K' ? 1440 : resolution === '4K' ? 2160 : 1080;
  const rawWidth = ratio >= 1 ? Math.round(shortEdge * ratio) : shortEdge;
  const rawHeight = ratio >= 1 ? shortEdge : Math.round(shortEdge / ratio);
  const even = (value: number) => Math.max(2, value % 2 === 0 ? value : value + 1);
  return { width: even(rawWidth), height: even(rawHeight) };
}

export const ExportFpsSchema = z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(50), z.literal(60)]);
export type ExportFps = z.infer<typeof ExportFpsSchema>;

export const ExportQualitySchema = z.enum(['draft', 'standard', 'high', 'custom']);
export type ExportQuality = z.infer<typeof ExportQualitySchema>;

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
  audioBitrateKbps: z.union([z.literal(128), z.literal(192), z.literal(256)]).default(192),
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
  defaultExport: { format: 'mp4', aspect: '16:9', resolution: '1080p', fps: 30, quality: 'standard', audioBitrateKbps: 192 },
  hardwareAcceleration: 'software',
  experimentalAi: false,
  aiProvider: 'openai',
  aiModel: '',
  shortcuts: {},
  workspaceLayout: { railWidth: 56, libraryWidth: 270, inspectorWidth: 304, timelineHeight: 265 },
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

export function projectDuration(project: Project) {
  return Math.max(0, ...project.tracks.flatMap((track) => track.clips.map((clip) => clip.start + clip.duration)));
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

function sliceSpeedCurve(speedCurve: Clip['speedCurve'], start: number, end: number) {
  if (!speedCurve?.length) return undefined;
  const points = speedCurve
    .filter((point) => point.time >= start - 0.000001 && point.time <= end + 0.000001)
    .map((point) => ({ ...point, time: clamp(point.time - start, 0, Math.max(0, end - start)) }));
  const startPoint = { time: 0, speed: speedAt(speedCurve, 1, start), easing: 'linear' as const };
  const endPoint = { time: Math.max(0, end - start), speed: speedAt(speedCurve, 1, end), easing: 'linear' as const };
  const merged = [startPoint, ...points, endPoint].sort((a, b) => a.time - b.time);
  return merged.filter((point, index, all) => index === 0 || point.time - all[index - 1].time > 0.000001);
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
  if (at <= clip.start + frame / 2 || at >= clip.start + clip.duration - frame / 2) return false;
  const firstDuration = at - clip.start;
  const originalDuration = clip.duration;
  const originalSourceDuration = sourceTimeAt(clip.speedCurve, clip.speed, originalDuration);
  const firstSourceDuration = Math.max(frame * clip.speed, sourceTimeAt(clip.speedCurve, clip.speed, firstDuration));
  const second = {
    ...clip,
    id: createId(),
    start: at,
    duration: clip.duration - firstDuration,
    sourceStart: clip.sourceStart + firstSourceDuration,
    sourceDuration: Math.max(frame * clip.speed, originalSourceDuration - firstSourceDuration),
    keyframes: remapKeyframes(clip.keyframes, firstDuration, originalDuration, firstDuration),
    speedCurve: sliceSpeedCurve(clip.speedCurve, firstDuration, originalDuration),
  };
  clip.duration = firstDuration;
  clip.sourceDuration = firstSourceDuration;
  clip.keyframes = remapKeyframes(clip.keyframes, 0, firstDuration, 0);
  clip.speedCurve = sliceSpeedCurve(clip.speedCurve, 0, firstDuration);
  track.clips.splice(index + 1, 0, second);
  project.duration = projectDuration(project);
  return true;
}

export function trimClipToPlayhead(project: Project, clipId: string, at: number, edge: 'start' | 'end') {
  const track = project.tracks.find((item) => item.clips.some((clip) => clip.id === clipId));
  const clip = track?.clips.find((item) => item.id === clipId);
  if (!track || !clip || track.locked) return false;
  const frame = 1 / Math.max(1, project.canvas.fps);
  if (at <= clip.start || at >= clip.start + clip.duration) return false;
  if (edge === 'start') {
    const delta = at - clip.start;
    const originalDuration = clip.duration;
    const sourceOffset = sourceTimeAt(clip.speedCurve, clip.speed, delta);
    clip.start = at;
    clip.duration = Math.max(frame, clip.duration - delta);
    clip.sourceStart += sourceOffset;
    clip.sourceDuration = Math.max(frame * clip.speed, sourceTimeAt(clip.speedCurve, clip.speed, originalDuration) - sourceOffset);
    clip.keyframes = remapKeyframes(clip.keyframes, delta, originalDuration, delta);
    clip.speedCurve = sliceSpeedCurve(clip.speedCurve, delta, originalDuration);
  } else {
    clip.duration = Math.max(frame, at - clip.start);
    clip.sourceDuration = Math.max(frame * clip.speed, sourceTimeAt(clip.speedCurve, clip.speed, clip.duration));
    clip.keyframes = remapKeyframes(clip.keyframes, 0, clip.duration, 0);
    clip.speedCurve = sliceSpeedCurve(clip.speedCurve, 0, clip.duration);
  }
  project.duration = projectDuration(project);
  return true;
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

export function snapTime(
  project: Project,
  value: number,
  options: { enabled?: boolean; threshold?: number; currentTime?: number; rangeStart?: number | null; rangeEnd?: number | null } = {},
) {
  const safeValue = clamp(value, 0, project.duration);
  if (options.enabled === false) return safeValue;
  const threshold = options.threshold ?? 0.08;
  const clipEdges = project.tracks.flatMap((track) => track.clips.flatMap((clip) => [clip.start, clip.start + clip.duration]));
  const rangeEdges = [options.rangeStart ?? null, options.rangeEnd ?? null].filter((edge): edge is number => edge !== null);
  const candidates = [0, project.duration, options.currentTime, ...rangeEdges, ...clipEdges, ...project.markers.map((marker) => marker.time)].filter((item): item is number => typeof item === 'number');
  const nearest = candidates.reduce<number | null>((best, candidate) => {
    if (Math.abs(candidate - safeValue) >= threshold) return best;
    return best === null || Math.abs(candidate - safeValue) < Math.abs(best - safeValue) ? candidate : best;
  }, null);
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
