import type { Asset, Clip, Project, Track } from '@cutloc/shared';

export function mediaTrackType(asset: Asset): Track['type'] { return asset.type === 'audio' ? 'audio' : asset.type === 'image' ? 'overlay' : 'video'; }

export const TRACK_TYPE_NAMES: Record<Track['type'], string> = { layer: 'Layer', video: 'Video', overlay: 'Overlay', audio: 'Audio', text: 'Text', subtitle: 'Subtitle' };

export function createLayerTrack(draft: Project, name?: string): Track {
  const index = draft.tracks.length;
  const track: Track = { id: `track-layer-${crypto.randomUUID().slice(0, 8)}`, type: 'layer', name: name ?? `Layer ${index + 1}`, order: index, clips: [], locked: false, hidden: false, muted: false, volume: 1 };
  draft.tracks.push(track);
  return track;
}

export function trackIcon(type: Track['type']) {
  if (type === 'audio') return '♫';
  if (type === 'text') return 'T';
  if (type === 'subtitle') return '≡';
  if (type === 'video') return '▧';
  if (type === 'overlay') return '◈';
  return '◫';
}

export function createMediaClip(asset: Asset, start: number): Clip {
  const sourceDuration = Math.max(asset.duration || 5, 0.5);
  return {
    id: `clip_${crypto.randomUUID().slice(0, 8)}`,
    assetId: asset.id,
    type: asset.type,
    name: asset.name,
    start: Math.max(0, start),
    duration: sourceDuration,
    sourceStart: 0,
    sourceDuration,
    speed: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, fit: 'contain', flipX: false, flipY: false },
    filters: { brightness: 0, contrast: 0, saturation: 0, blur: 0, grayscale: 0 },
    transitionIn: { type: 'none', duration: 0.4 },
    transitionOut: { type: 'none', duration: 0.4 },
    volume: 1,
    adjustment: false,
    keyframes: [],
  };
}

/**
 * An adjustment layer has no source media of its own.  It is a timeline item
 * whose filters are composited over media that is visible at the same time.
 * Keeping it on the normal Clip contract makes it undoable, movable and
 * exportable without introducing a second kind of timeline object.
 */
export function createAdjustmentClip(start: number, duration = 5): Clip {
  const safeDuration = Math.max(0.05, duration);
  return {
    id: `adjustment_${crypto.randomUUID().slice(0, 8)}`,
    type: 'image',
    name: 'Adjustment layer',
    start: Math.max(0, start),
    duration: safeDuration,
    sourceStart: 0,
    sourceDuration: safeDuration,
    speed: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, fit: 'contain', flipX: false, flipY: false },
    filters: { brightness: 0, contrast: 0, saturation: 0, blur: 0, grayscale: 0 },
    transitionIn: { type: 'none', duration: 0 },
    transitionOut: { type: 'none', duration: 0 },
    volume: 1,
    adjustment: true,
    keyframes: [],
  };
}

/**
 * Find the earliest non-overlapping slot for an automatic insertion. Explicit
 * timeline drops still honour the user's requested time and may overlap; this
 * helper is used by library buttons and stock media so they never hide an
 * existing clip by landing on top of it.
 */
export function findEmptyPlacement(project: Project, duration: number, desiredStart: number, preferredTrackId?: string | null) {
  const tracks = project.tracks.filter((track) => !track.locked);
  const ordered = tracks.slice().sort((a, b) => {
    const aPreferred = a.id === preferredTrackId ? 0 : 1;
    const bPreferred = b.id === preferredTrackId ? 0 : 1;
    return aPreferred - bPreferred || a.order - b.order;
  });
  const length = Math.max(0.05, duration);
  const requested = Math.max(0, desiredStart);
  let best: { trackId: string; start: number; rank: number } | null = null;
  for (const [rank, track] of ordered.entries()) {
    let candidate = requested;
    const clips = track.clips.slice().sort((a, b) => a.start - b.start);
    for (const clip of clips) {
      if (candidate + length <= clip.start + 0.0001) break;
      if (clip.start < candidate + length && clip.start + clip.duration > candidate + 0.0001) {
        candidate = Math.max(candidate, clip.start + clip.duration);
      }
    }
    if (!best || candidate < best.start - 0.0001 || (Math.abs(candidate - best.start) <= 0.0001 && rank < best.rank)) {
      best = { trackId: track.id, start: candidate, rank };
    }
  }
  return best ? { trackId: best.trackId, start: best.start } : { trackId: null, start: requested };
}
