import { useEffect, useRef, useState } from 'react';
import type React from 'react';
import { adjustmentLayersForVisual, clamp, formatTime, interpolateKeyframes, parseTimelineTimecode, playbackTime, projectDuration, sourceTimeAt, speedAt, timelineDurationForSourceDuration, visualLayerPlan, type Asset, type CanvasAspect, type Clip, type Project, type Settings } from '@cutloc/shared';
import { useI18n, type TranslationKey } from '../i18n';
import { DEFAULT_TEXT_STYLE } from './text-model';
import { useEditor } from './store';
import { api } from './api';

type TransitionDirection = 'left' | 'right' | 'up' | 'down' | 'center';
type TransitionEasing = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out';

function timelineClipDuration(clip: Clip) {
  if (clip.type === 'text' || clip.type === 'subtitle') return clip.duration;
  return Math.max(0.05, timelineDurationForSourceDuration(clip.sourceDuration, clip.speed, clip.speedCurve));
}

function clipLocalTime(clip: Clip, projectTime: number) {
  return clamp(projectTime - clip.start, 0, clip.duration);
}

function clipSpeedAt(clip: Clip, localTime: number) {
  return speedAt(clip.speedCurve, clip.speed, localTime);
}

function clipSourceTime(clip: Clip, localTime: number) {
  return sourceTimeAt(clip.speedCurve, clip.speed, clamp(localTime, 0, clip.duration));
}

function clipVisualValues(clip: Clip, projectTime: number) {
  const localTime = clipLocalTime(clip, projectTime);
  let transitionOpacity = 1;
  let transitionX = 0;
  let transitionY = 0;
  let transitionScale = 1;
  let wipe: { progress: number; direction: TransitionDirection } | null = null;
  const enter = clip.transitionIn?.duration ?? 0;
  const leave = clip.transitionOut?.duration ?? 0;
  const applyMotion = (transition: NonNullable<Clip['transitionIn']>, progress: number, entering: boolean) => {
    const eased = motionProgress(progress, transition.easing as TransitionEasing | undefined);
    const intensity = clamp(transition.intensity ?? 1, 0.1, 2);
    const direction = transition.direction ?? 'left';
    if (transition.type === 'fade' || transition.type === 'dissolve') transitionOpacity *= eased;
    if (transition.type === 'wipe') wipe = !wipe || eased < wipe.progress ? { progress: eased, direction } : wipe;
    if (transition.type === 'slide') {
      const vector = transitionVector(direction);
      const distance = (1 - eased) * 120 * intensity;
      if (entering) { transitionX += vector.x * distance; transitionY += vector.y * distance; }
      else { transitionX += vector.x * distance; transitionY += vector.y * distance; }
    }
    if (transition.type === 'zoom') {
      const amount = 0.18 * intensity;
      transitionScale *= entering ? Math.max(0.12, 1 - (1 - eased) * amount) : 1 + (1 - eased) * amount;
    }
  };
  if (clip.transitionIn?.type !== 'none' && enter > 0 && localTime < enter) applyMotion(clip.transitionIn, clamp(localTime / enter, 0, 1), true);
  const remaining = clip.duration - localTime;
  if (clip.transitionOut?.type !== 'none' && leave > 0 && remaining < leave) {
    applyMotion(clip.transitionOut, clamp(remaining / leave, 0, 1), false);
  }
  const usesTransitionFadeIn = clip.transitionIn?.type === 'fade' || clip.transitionIn?.type === 'dissolve';
  const usesTransitionFadeOut = clip.transitionOut?.type === 'fade' || clip.transitionOut?.type === 'dissolve';
  const visualFadeIn = !usesTransitionFadeIn && (clip.fadeIn ?? 0) > 0 ? clamp(localTime / Math.max(0.000001, clip.fadeIn!), 0, 1) : 1;
  const visualFadeOut = !usesTransitionFadeOut && (clip.fadeOut ?? 0) > 0 ? clamp(remaining / Math.max(0.000001, clip.fadeOut!), 0, 1) : 1;
  const audioFadeIn = (clip.fadeIn ?? 0) > 0 ? clamp(localTime / Math.max(0.000001, clip.fadeIn!), 0, 1) : 1;
  const audioFadeOut = (clip.fadeOut ?? 0) > 0 ? clamp(remaining / Math.max(0.000001, clip.fadeOut!), 0, 1) : 1;
  return {
    localTime,
    x: interpolateKeyframes(clip.keyframes, 'x', localTime, clip.transform.x) + transitionX,
    y: interpolateKeyframes(clip.keyframes, 'y', localTime, clip.transform.y) + transitionY,
    scale: interpolateKeyframes(clip.keyframes, 'scale', localTime, clip.transform.scale) * transitionScale,
    rotation: interpolateKeyframes(clip.keyframes, 'rotation', localTime, clip.transform.rotation),
    opacity: clamp(interpolateKeyframes(clip.keyframes, 'opacity', localTime, clip.transform.opacity) * transitionOpacity * visualFadeIn * visualFadeOut, 0, 1),
    volume: clamp(interpolateKeyframes(clip.keyframes, 'volume', localTime, clip.volume) * audioFadeIn * audioFadeOut, 0, 2),
    speed: clipSpeedAt(clip, localTime),
    wipe,
  };
}

function previewChromaMatrix(color: string, similarity: number) {
  const match = /^#([0-9a-f]{6})$/i.exec(color);
  const rgb = match ? [0, 2, 4].map((offset) => Number.parseInt(match[1].slice(offset, offset + 2), 16)) : [0, 255, 0];
  const dominant = rgb.indexOf(Math.max(...rgb));
  const alpha = [1, 1, 1];
  alpha[dominant] = -2;
  const bias = 2 * (1 - clamp(similarity, 0, 1));
  return `1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  ${alpha[0]} ${alpha[1]} ${alpha[2]} 0 ${bias}`;
}

function motionProgress(value: number, easing: TransitionEasing = 'ease-in-out') {
  const t = clamp(value, 0, 1);
  if (easing === 'ease-in') return t * t;
  if (easing === 'ease-out') return 1 - ((1 - t) ** 2);
  if (easing === 'ease-in-out') return t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
  return t;
}

function transitionVector(direction: TransitionDirection) {
  if (direction === 'right') return { x: 1, y: 0 };
  if (direction === 'up') return { x: 0, y: -1 };
  if (direction === 'down') return { x: 0, y: 1 };
  if (direction === 'center') return { x: 0, y: 0 };
  return { x: -1, y: 0 };
}

function transitionClipPath(wipe: { progress: number; direction: TransitionDirection } | null) {
  if (!wipe) return undefined;
  const hidden = `${Math.round((1 - clamp(wipe.progress, 0, 1)) * 10000) / 100}%`;
  if (wipe.direction === 'right') return `inset(0 0 0 ${hidden})`;
  if (wipe.direction === 'up') return `inset(0 0 ${hidden} 0)`;
  if (wipe.direction === 'down') return `inset(${hidden} 0 0 0)`;
  if (wipe.direction === 'center') {
    const centerHidden = `${Math.round((1 - clamp(wipe.progress, 0, 1)) * 5000) / 100}%`;
    return `inset(${centerHidden} ${centerHidden} ${centerHidden} ${centerHidden})`;
  }
  return `inset(0 ${hidden} 0 0)`;
}

function previewMaskImage(mask: NonNullable<Clip['mask']>) {
  const x = clamp(mask.x, 0, 0.99) * 100;
  const y = clamp(mask.y, 0, 0.99) * 100;
  const width = clamp(Math.min(mask.width, 1 - mask.x), 0.01, 1) * 100;
  const height = clamp(Math.min(mask.height, 1 - mask.y), 0.01, 1) * 100;
  const background = mask.invert ? '#ffffff' : '#000000';
  const foreground = mask.invert ? '#000000' : '#ffffff';
  const feather = clamp(mask.feather ?? 0, 0, 1);
  const filter = feather > 0.001 ? `<defs><filter id="soft" x="-25%" y="-25%" width="150%" height="150%"><feGaussianBlur stdDeviation="${Math.max(0.2, feather * 6)}"/></filter></defs>` : '';
  const shape = mask.type === 'ellipse'
    ? `<ellipse cx="${x + width / 2}" cy="${y + height / 2}" rx="${width / 2}" ry="${height / 2}" fill="${foreground}"${filter ? ' filter="url(#soft)"' : ''}/>`
    : `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${foreground}"${filter ? ' filter="url(#soft)"' : ''}/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs>${filter ? filter.slice(6, -7) : ''}</defs><rect width="100" height="100" fill="${background}"/>${shape}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

function previewMediaBounds(asset: Asset, canvasWidth: number, canvasHeight: number, fit: 'contain' | 'cover' | 'stretch') {
  const sourceWidth = Math.max(1, asset.width ?? canvasWidth);
  const sourceHeight = Math.max(1, asset.height ?? canvasHeight);
  if (fit === 'stretch') return { width: canvasWidth, height: canvasHeight };
  const ratio = fit === 'cover' ? Math.max(canvasWidth / sourceWidth, canvasHeight / sourceHeight) : Math.min(canvasWidth / sourceWidth, canvasHeight / sourceHeight);
  return { width: sourceWidth * ratio, height: sourceHeight * ratio };
}

function previewMediaRenderBounds(asset: Asset, crop: Clip['crop'], canvasWidth: number, canvasHeight: number, fit: 'contain' | 'cover' | 'stretch') {
  if (!crop) return previewMediaBounds(asset, canvasWidth, canvasHeight, fit);
  const sourceWidth = Math.max(1, asset.width ?? canvasWidth);
  const sourceHeight = Math.max(1, asset.height ?? canvasHeight);
  const cropX = clamp(crop.x, 0, 0.99);
  const cropY = clamp(crop.y, 0, 0.99);
  const cropWidth = clamp(Math.min(crop.width, 1 - cropX), 0.01, 1);
  const cropHeight = clamp(Math.min(crop.height, 1 - cropY), 0.01, 1);
  return previewMediaBounds({ ...asset, width: Math.max(1, sourceWidth * cropWidth), height: Math.max(1, sourceHeight * cropHeight) }, canvasWidth, canvasHeight, fit);
}

function previewTextBounds(style: NonNullable<Clip['textStyle']>, canvasWidth: number, canvasHeight: number, renderScale = 1) {
  const effectiveFontSize = Math.max(style.fontSize, 12 / Math.max(0.001, renderScale));
  const longestLine = Math.max(1, ...style.text.split('\n').map((line) => line.length));
  const estimatedWidth = longestLine * effectiveFontSize * 0.58 + style.padding * 2;
  const width = Math.min(canvasWidth * 0.9, Math.max(64, estimatedWidth));
  const lineCount = Math.max(1, style.text.split('\n').length);
  const height = Math.min(canvasHeight * 0.75, Math.max(effectiveFontSize, lineCount * effectiveFontSize * style.lineHeight + style.padding * 2));
  return { width, height };
}

export function normalizeProjectDurations(project: Project): Project {
  let changed = false;
  const tracks = project.tracks.map((track, trackIndex) => {
    const isLegacyName = /^(Video|Overlay|Audio|Text|Subtitle)\s+\d+$/i.test(track.name);
    const normalizedTrack = {
      ...track,
      type: 'layer' as const,
      name: isLegacyName ? `Layer ${trackIndex + 1}` : track.name,
    };
    if (track.type !== 'layer' || normalizedTrack.name !== track.name) changed = true;
    return {
      ...normalizedTrack,
    clips: track.clips.map((clip) => {
      if (clip.type === 'text' || clip.type === 'subtitle') return clip;
      const duration = timelineClipDuration(clip);
      if (Math.abs(duration - clip.duration) <= 1 / project.canvas.fps) return clip;
      changed = true;
      return { ...clip, duration };
      }),
    };
  });
  const next = { ...project, tracks };
  if (Math.abs(project.duration - projectDuration(next)) > 0.000001) changed = true;
  if (!changed) return project;
  return { ...next, duration: projectDuration(next) };
}

function EditableTimecode({ value, duration, fps, onChange }: { value: number; duration: number; fps: number; onChange: (value: number) => void }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(() => formatTime(value, true, fps));
  const [editing, setEditing] = useState(false);
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    if (!editing) setDraft(formatTime(value, true, fps));
  }, [editing, fps, value]);
  const commit = () => {
    const parsed = parseTimelineTimecode(draft, fps);
    if (parsed === null) {
      setInvalid(true);
      setDraft(formatTime(value, true, fps));
      return;
    }
    setInvalid(false);
    onChange(clamp(parsed, 0, duration));
  };
  return <input className="preview-timecode-input" aria-label={t('preview.timecode')} aria-invalid={invalid} title={invalid ? t('preview.invalidTimecode') : t('preview.timecodeHint')} value={draft} onFocus={(event) => { setEditing(true); setInvalid(false); event.currentTarget.select(); }} onChange={(event) => setDraft(event.target.value)} onBlur={() => { commit(); setEditing(false); }} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { setDraft(formatTime(value, true, fps)); setInvalid(false); event.currentTarget.blur(); } }} />;
}

export function PreviewArea({ project, settings }: { project: Project; settings: Settings | null }) {
  const { t } = useI18n();
  const currentTime = useEditor((state) => state.currentTime); const playing = useEditor((state) => state.playing); const setPlaying = useEditor((state) => state.setPlaying); const setCurrentTime = useEditor((state) => state.setCurrentTime);
  const selectedClipId = useEditor((state) => state.selectedClipId);
  const selectedClipIds = useEditor((state) => state.selectedClipIds);
  const setSelected = useEditor((state) => state.setSelected);
  const mutateProject = useEditor((state) => state.mutateProject);
  // Keep one media element per active clip.  The previous implementation rendered
  // only the selected clip, which made overlays/images appear to disappear as soon
  // as another clip was selected in the timeline.
  const mediaRefs = useRef<Record<string, HTMLVideoElement | null>>({});
  const audioRefs = useRef<Record<string, HTMLAudioElement | null>>({});
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioGainNodesRef = useRef(new WeakMap<HTMLMediaElement, GainNode>());
  const canvasRef = useRef<HTMLDivElement>(null);
  const fullscreenRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [showSafeArea, setShowSafeArea] = useState(false);
  const [previewFraming, setPreviewFraming] = useState<'clip' | 'fit' | 'fill' | 'smart'>(project.canvas.fitMode === 'keep' ? 'fit' : project.canvas.fitMode ?? 'fit');
  const [previewZoom, setPreviewZoom] = useState(100);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fullscreenSize, setFullscreenSize] = useState({ width: 0, height: 0 });
  const [previewDrag, setPreviewDrag] = useState<{ clipId: string; mode: 'move' | 'scale'; startX: number; startY: number; originX: number; originY: number; originScale: number; historyGroup: string } | null>(null);
  const playbackStartRef = useRef<{ projectTime: number; wallTime: number } | null>(null);
  const setSettings = useEditor((state) => state.setSettings);
  useEffect(() => {
    const element = viewportRef.current ?? stageRef.current;
    if (!element) return;
    const updateSize = () => {
      const rect = element.getBoundingClientRect();
      setStageSize({
        // clientWidth/clientHeight shrink when a zoomed canvas introduces a
        // scrollbar. Measuring the viewport box instead keeps Fit mode from
        // inheriting that reduced size after the user zooms back out.
        width: Math.max(1, Math.floor(rect.width)),
        height: Math.max(1, Math.floor(rect.height)),
      });
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const updateFullscreenState = () => {
      const active = document.fullscreenElement === fullscreenRef.current;
      setIsFullscreen(active);
      if (active) setFullscreenSize({ width: Math.max(1, window.innerWidth), height: Math.max(1, window.innerHeight) });
    };
    document.addEventListener('fullscreenchange', updateFullscreenState);
    updateFullscreenState();
    return () => document.removeEventListener('fullscreenchange', updateFullscreenState);
  }, []);
  useEffect(() => {
    if (!isFullscreen) return;
    const updateSize = () => setFullscreenSize({ width: Math.max(1, window.innerWidth), height: Math.max(1, window.innerHeight) });
    window.addEventListener('resize', updateSize);
    updateSize();
    return () => window.removeEventListener('resize', updateSize);
  }, [isFullscreen]);
  const visualPlan = visualLayerPlan(project);
  const activeClips = visualPlan
    .filter(({ clip }) => currentTime >= clip.start && currentTime < clip.start + clip.duration);
  const activeMedia = activeClips.filter(({ clip }) => !clip.adjustment && (clip.type === 'video' || clip.type === 'image'));
  const activeAudio = activeClips.filter(({ clip, track }) => {
    if (track.muted || (clip.type !== 'audio' && clip.type !== 'video')) return false;
    const asset = clip.assetId ? project.assets.find((item) => item.id === clip.assetId) : undefined;
    return Boolean(asset?.hasAudio);
  });
  const texts = activeClips.filter(({ clip }) => !clip.adjustment && clip.textStyle).map(({ clip, trackIndex }) => ({ clip, style: clip.textStyle!, trackIndex }));
  const activeSelected = selectedClipId ? activeClips.find(({ clip }) => clip.id === selectedClipId && (clip.adjustment || clip.type === 'video' || clip.type === 'image' || clip.type === 'text')) : undefined;
  const activeSelectedVisual = activeSelected ? clipVisualValues(activeSelected.clip, currentTime) : null;
  const activeSelectedAsset = activeSelected?.clip.assetId ? project.assets.find((item) => item.id === activeSelected.clip.assetId) : undefined;

  const beginPreviewTransform = (event: React.PointerEvent<HTMLElement>, clip: Clip, mode: 'move' | 'scale') => {
    if (event.button !== 0) return;
    if (project.tracks.find((track) => track.clips.some((item) => item.id === clip.id))?.locked) return;
    event.preventDefault();
    event.stopPropagation();
    setSelected(clip.id, project.tracks.find((track) => track.clips.some((item) => item.id === clip.id))?.id ?? null);
    setPreviewDrag({ clipId: clip.id, mode, startX: event.clientX, startY: event.clientY, originX: clip.transform.x, originY: clip.transform.y, originScale: clip.transform.scale, historyGroup: crypto.randomUUID() });
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const updatePreviewTransform = (event: React.PointerEvent<HTMLElement>) => {
    if (!previewDrag) return;
    const rect = canvasRef.current?.getBoundingClientRect();
    const scaleX = project.canvas.width / Math.max(1, rect?.width ?? project.canvas.width);
    const scaleY = project.canvas.height / Math.max(1, rect?.height ?? project.canvas.height);
    const deltaX = (event.clientX - previewDrag.startX) * scaleX;
    const deltaY = (event.clientY - previewDrag.startY) * scaleY;
    mutateProject((draft) => {
      const clip = draft.tracks.flatMap((track) => track.clips).find((item) => item.id === previewDrag.clipId);
      if (!clip) return;
      if (previewDrag.mode === 'move') {
        clip.transform.x = Math.round(previewDrag.originX + deltaX);
        clip.transform.y = Math.round(previewDrag.originY + deltaY);
      } else {
        clip.transform.scale = clamp(previewDrag.originScale + deltaX / Math.max(120, project.canvas.width * 0.12), 0.05, 8);
      }
    }, { historyGroup: previewDrag.historyGroup });
  };

  const finishPreviewTransform = () => setPreviewDrag(null);

  const syncVideo = (clip: Clip, video: HTMLVideoElement) => {
    const values = clipVisualValues(clip, currentTime);
    const target = Math.max(0, clipSourceTime(clip, currentTime - clip.start) + clip.sourceStart);
    video.playbackRate = clamp(values.speed, 0.25, 4);
    if (Math.abs(video.currentTime - target) > 0.18 || video.readyState < 2) video.currentTime = target;
    if (playing) void video.play().catch(() => undefined); else video.pause();
  };

  const syncAudio = (clip: Clip, audio: HTMLAudioElement, trackVolume = 1) => {
    const values = clipVisualValues(clip, currentTime);
    const target = Math.max(0, clipSourceTime(clip, currentTime - clip.start) + clip.sourceStart);
    audio.playbackRate = clamp(values.speed, 0.25, 4);
    const requestedGain = clamp(values.volume * trackVolume, 0, 4);
    try {
      const AudioContextConstructor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AudioContextConstructor) {
        const context = audioContextRef.current ?? new AudioContextConstructor();
        audioContextRef.current = context;
        let gainNode = audioGainNodesRef.current.get(audio);
        if (!gainNode) {
          gainNode = context.createGain();
          context.createMediaElementSource(audio).connect(gainNode).connect(context.destination);
          audioGainNodesRef.current.set(audio, gainNode);
        }
        gainNode.gain.value = requestedGain;
        audio.volume = 1;
        if (playing && context.state === 'suspended') void context.resume().catch(() => undefined);
      } else audio.volume = clamp(requestedGain, 0, 1);
    } catch {
      audio.volume = clamp(requestedGain, 0, 1);
    }
    if (Math.abs(audio.currentTime - target) > 0.18 || audio.readyState < 2) audio.currentTime = target;
    if (playing) void audio.play().catch(() => undefined); else audio.pause();
  };

  useEffect(() => {
    for (const { clip } of activeMedia) {
      const video = mediaRefs.current[clip.id];
      if (video) syncVideo(clip, video);
    }
    for (const { clip, track } of activeAudio) {
      const audio = audioRefs.current[clip.id];
      if (audio) syncAudio(clip, audio, track.volume ?? 1);
    }
  }, [currentTime, playing, activeMedia, activeAudio, setPlaying]);

  const stepFrame = (direction: -1 | 1) => {
    setPlaying(false);
    setCurrentTime(clamp(currentTime + direction / project.canvas.fps, 0, project.duration));
  };

  const cycleQuality = () => {
    const current = settings?.proxyQuality ?? 'balanced';
    const next = current === 'draft' ? 'balanced' : current === 'balanced' ? 'high' : 'draft';
    if (settings) setSettings({ ...settings, proxyQuality: next });
    void api('/api/settings', { method: 'PUT', body: JSON.stringify({ proxyQuality: next }) });
  };

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void fullscreenRef.current?.requestFullscreen?.();
  };

  const aspect: CanvasAspect = project.canvas.aspect ?? (project.canvas.width === project.canvas.height ? '1:1' : project.canvas.width > project.canvas.height ? '16:9' : '9:16');
  const aspectDimensions: Record<CanvasAspect, { width: number; height: number; label: string }> = {
    '16:9': { width: 1920, height: 1080, label: t('preview.aspect.youtube') },
    '9:16': { width: 1080, height: 1920, label: t('preview.aspect.vertical') },
    '1:1': { width: 1080, height: 1080, label: t('preview.aspect.square') },
    '4:5': { width: 1080, height: 1350, label: t('preview.aspect.instagram') },
    '3:2': { width: 1440, height: 960, label: t('preview.aspect.photo') },
    '21:9': { width: 2560, height: 1080, label: t('preview.aspect.cinematic') },
  };
  const setAspect = (next: CanvasAspect) => {
    if (next === aspect) return;
    const dimensions = aspectDimensions[next];
    const oldWidth = Math.max(1, project.canvas.width);
    const oldHeight = Math.max(1, project.canvas.height);
    const widthRatio = dimensions.width / oldWidth;
    const heightRatio = dimensions.height / oldHeight;
    mutateProject((draft) => {
      for (const track of draft.tracks) {
        for (const clip of track.clips) {
          clip.transform.x *= widthRatio;
          clip.transform.y *= heightRatio;
          clip.keyframes = clip.keyframes.map((keyframe) => ({
            ...keyframe,
            value: keyframe.property === 'x' ? keyframe.value * widthRatio : keyframe.property === 'y' ? keyframe.value * heightRatio : keyframe.value,
          }));
          if (clip.textStyle) {
            clip.textStyle.fontSize *= heightRatio;
            clip.textStyle.padding *= heightRatio;
            clip.textStyle.letterSpacing *= heightRatio;
            clip.textStyle.strokeWidth *= heightRatio;
          }
        }
      }
      draft.canvas.aspect = next;
      draft.canvas.width = dimensions.width;
      draft.canvas.height = dimensions.height;
      draft.canvas.fitMode = 'fit';
    });
    setPreviewFraming('fit');
    setPreviewZoom(100);
  };
  const canvasRatio = project.canvas.width / Math.max(1, project.canvas.height);
  const fitScale = Math.min(stageSize.width / Math.max(1, project.canvas.width), stageSize.height / Math.max(1, project.canvas.height));
  const baseScale = Math.min(1, fitScale);
  const displayScale = baseScale * clamp(previewZoom / 100, 0.5, 2.5);
  const fullWidth = fullscreenSize.width || (typeof window === 'undefined' ? stageSize.width : window.innerWidth);
  const fullHeight = fullscreenSize.height || (typeof window === 'undefined' ? stageSize.height : window.innerHeight);
  const fullscreenScale = Math.min(Math.max(1, fullWidth - 48) / Math.max(1, project.canvas.width), Math.max(1, fullHeight - 48) / Math.max(1, project.canvas.height));
  // Every overlay, hit target and selection box must use the same scale as the
  // canvas itself; otherwise zoom changes the frame but leaves controls behind.
  const canvasScale = isFullscreen ? fullscreenScale : displayScale;
  const canvasDisplaySize = {
    width: Math.max(1, Math.round(project.canvas.width * canvasScale)),
    height: Math.max(1, Math.round(project.canvas.height * canvasScale)),
  };
  // Fit mode should use the full viewport. Padding is only useful once the
  // user intentionally zooms in; applying it at 100% creates fake scrollbars
  // and makes the canvas look smaller than the available preview area.
  const canvasPadding = isFullscreen ? 0 : previewZoom > 100 ? 28 : 0;
  const canvasPadSize = {
    width: Math.max(stageSize.width, canvasDisplaySize.width + canvasPadding * 2),
    height: Math.max(stageSize.height, canvasDisplaySize.height + canvasPadding * 2),
  };
  const selectedBounds = activeSelected?.clip.type === 'text' && !activeSelected.clip.adjustment
    ? previewTextBounds(activeSelected.clip.textStyle ?? { ...DEFAULT_TEXT_STYLE, text: activeSelected.clip.name }, project.canvas.width, project.canvas.height, canvasScale)
    : activeSelectedAsset
      ? previewMediaRenderBounds(activeSelectedAsset, activeSelected?.clip.crop, project.canvas.width, project.canvas.height, (previewFraming === 'fill' || previewFraming === 'smart') ? 'cover' : previewFraming === 'fit' ? 'contain' : activeSelected?.clip.transform.fit ?? 'contain')
      : { width: project.canvas.width * 0.72, height: project.canvas.height * 0.72 };
  const changePreviewFraming = (next: 'clip' | 'fit' | 'fill' | 'smart') => {
    setPreviewFraming(next);
    mutateProject((draft) => { draft.canvas.fitMode = next === 'clip' ? 'fit' : next; });
  };

  useEffect(() => {
    if (!playing) {
      playbackStartRef.current = null;
      return;
    }
    const start = { projectTime: useEditor.getState().currentTime, wallTime: performance.now() };
    playbackStartRef.current = start;
    let frame = 0;
    const tick = (now: number) => {
      const next = playbackTime(start.projectTime, start.wallTime, now, project.duration);
      if (next >= project.duration) {
        setPlaying(false);
        setCurrentTime(0);
        return;
      }
      setCurrentTime(next);
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [playing, project.duration, setCurrentTime, setPlaying]);

  const useProxy = settings?.proxyQuality !== 'high';
  const adjustmentFilter = (clip: Clip) => adjustmentLayersForVisual(visualPlan, visualPlan.find((item) => item.clip.id === clip.id)!, currentTime).reduce((filter, item) => ({
    brightness: filter.brightness + item.clip.filters.brightness,
    contrast: filter.contrast + item.clip.filters.contrast,
    saturation: filter.saturation + item.clip.filters.saturation,
    blur: filter.blur + item.clip.filters.blur,
    grayscale: clamp(filter.grayscale + item.clip.filters.grayscale, 0, 1),
    hue: filter.hue + (item.clip.filters.hue ?? 0),
    temperature: filter.temperature + (item.clip.filters.temperature ?? 0),
    vignette: clamp(filter.vignette + (item.clip.filters.vignette ?? 0), 0, 1),
  }), { brightness: clip.filters.brightness, contrast: clip.filters.contrast, saturation: clip.filters.saturation, blur: clip.filters.blur, grayscale: clip.filters.grayscale, hue: clip.filters.hue ?? 0, temperature: clip.filters.temperature ?? 0, vignette: clip.filters.vignette ?? 0 });
  return <main className="preview-area">
    <div className="preview-toolbar"><div className="preview-breadcrumb"><span>{t('preview.canvas')}</span><select className="preview-aspect-select" aria-label={t('preview.aspect')} value={aspect} onChange={(event) => setAspect(event.target.value as CanvasAspect)}><option value="16:9">16:9 · YouTube</option><option value="9:16">9:16 · {t('preview.portrait')}</option><option value="1:1">1:1 · {t('preview.square')}</option><option value="4:5">4:5 · Instagram</option><option value="3:2">3:2 · {t('preview.classic')}</option><option value="21:9">21:9 · {t('preview.cinematic')}</option></select><select className="preview-fit-select" aria-label={t('preview.framing')} title={t('preview.framingHint')} value={previewFraming} onChange={(event) => changePreviewFraming(event.target.value as typeof previewFraming)}><option value="clip">{t('preview.clipFraming')}</option><option value="fit">{t('preview.fitMedia')}</option><option value="fill">{t('preview.fillMedia')}</option><option value="smart">{t('preview.smartFraming')}</option></select></div><div className="preview-tools" aria-label={t('preview.view')}><button className={showSafeArea ? 'active' : ''} aria-label={t('preview.safeArea')} aria-pressed={showSafeArea} title={t('preview.safeArea')} onClick={() => setShowSafeArea((value) => !value)}>◫</button><button aria-label={t('preview.fullscreen')} title={t('preview.fullscreen')} onClick={toggleFullscreen}>⛶</button></div></div>
     <div className="preview-inline-zoom" aria-label={t('preview.zoom')}><button aria-label={t('preview.zoomOut')} onClick={() => setPreviewZoom((value) => clamp(value - 10, 50, 250))}>−</button><output>{previewZoom}%</output><button aria-label={t('preview.zoomIn')} onClick={() => setPreviewZoom((value) => clamp(value + 10, 50, 250))}>+</button><button onClick={() => setPreviewZoom(100)}>{t('preview.fitZoom')}</button></div>
     <div ref={stageRef} className="preview-stage"><div ref={viewportRef} className="preview-canvas-viewport"><div className="preview-canvas-pad" style={{ width: canvasPadSize.width, height: canvasPadSize.height }}><div ref={fullscreenRef} className="preview-fullscreen-shell" style={{ ['--canvas-ratio' as string]: canvasRatio }}><div ref={canvasRef} className={`canvas-frame canvas-aspect-${aspect.replace(':', '-')}`} style={{ width: canvasDisplaySize.width, height: canvasDisplaySize.height, aspectRatio: `${project.canvas.width}/${project.canvas.height}`, ['--canvas-ratio' as string]: canvasRatio, background: project.canvas.background }} onPointerMove={updatePreviewTransform} onPointerUp={finishPreviewTransform} onPointerCancel={finishPreviewTransform}>
     <svg width="0" height="0" aria-hidden="true" style={{ position: 'absolute' }}><defs>{activeMedia.flatMap(({ clip }) => clip.filters.chromaKey ? [<filter key={clip.id} id={`preview-chroma-${clip.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`} colorInterpolationFilters="sRGB"><feColorMatrix type="matrix" values={previewChromaMatrix(clip.filters.chromaKey.color, clip.filters.chromaKey.similarity)} /><feComponentTransfer><feFuncA type="gamma" amplitude="1" exponent={Math.max(0.2, 1 - clip.filters.chromaKey.blend)} offset="0" /></feComponentTransfer></filter>] : [])}</defs></svg>
     {activeMedia.map(({ clip, trackIndex }) => {
      const asset = clip.assetId ? project.assets.find((item) => item.id === clip.assetId) : undefined;
      if (!asset) return null;
      const visual = clipVisualValues(clip, currentTime);
      const mediaUrl = `/api/projects/${project.id}/media/${asset.id}${useProxy && asset.proxyPath ? '?proxy=1' : ''}`;
      const filter = adjustmentFilter(clip);
      const crop = clip.crop;
      const mask = clip.mask;
      const fit = (previewFraming === 'fill' || previewFraming === 'smart') ? 'cover' : previewFraming === 'fit' ? 'contain' : clip.transform.fit;
      const fullBounds = previewMediaBounds(asset, project.canvas.width, project.canvas.height, fit);
      const frameBounds = previewMediaRenderBounds(asset, crop, project.canvas.width, project.canvas.height, fit);
      const cropX = crop ? clamp(crop.x, 0, 0.99) : 0;
      const cropY = crop ? clamp(crop.y, 0, 0.99) : 0;
      const cropWidth = crop ? clamp(Math.min(crop.width, 1 - cropX), 0.01, 1) : 1;
      const cropHeight = crop ? clamp(Math.min(crop.height, 1 - cropY), 0.01, 1) : 1;
      const innerWidth = crop ? frameBounds.width / cropWidth : fullBounds.width;
      const innerHeight = crop ? frameBounds.height / cropHeight : fullBounds.height;
      const temperatureFilter = Math.abs(filter.temperature) > 0.001
        ? ` sepia(${Math.abs(filter.temperature) * 0.35}) saturate(${1 + Math.abs(filter.temperature) * 0.4}) hue-rotate(${filter.temperature > 0 ? -12 : 180}deg)`
        : '';
      const chromaFilter = clip.filters.chromaKey ? ` url(#preview-chroma-${clip.id.replace(/[^a-zA-Z0-9_-]/g, '-')})` : '';
      const mediaFilter = `${chromaFilter} brightness(${1 + filter.brightness}) contrast(${1 + filter.contrast}) saturate(${1 + filter.saturation}) hue-rotate(${filter.hue}deg) blur(${filter.blur}px) grayscale(${filter.grayscale})${temperatureFilter}`;
      const mediaFrameStyle: React.CSSProperties = {
        position: 'absolute',
        left: '50%',
        top: '50%',
        right: 'auto',
        bottom: 'auto',
        width: frameBounds.width * canvasScale,
        height: frameBounds.height * canvasScale,
        opacity: visual.opacity,
        pointerEvents: 'none',
        overflow: 'hidden',
        zIndex: trackIndex + 1,
        transform: `translate(-50%, -50%) translate(${visual.x * canvasScale}px, ${visual.y * canvasScale}px) rotate(${visual.rotation}deg) scale(${visual.scale}) scaleX(${clip.transform.flipX ? -1 : 1}) scaleY(${clip.transform.flipY ? -1 : 1})`,
        clipPath: visual.wipe ? transitionClipPath(visual.wipe) : undefined,
      };
      const maskStyle: React.CSSProperties = {
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        maskImage: mask ? previewMaskImage(mask) : undefined,
        WebkitMaskImage: mask ? previewMaskImage(mask) : undefined,
        maskSize: '100% 100%',
        WebkitMaskSize: '100% 100%',
        maskRepeat: 'no-repeat',
        WebkitMaskRepeat: 'no-repeat',
      };
      const mediaStyle: React.CSSProperties = crop
        ? { position: 'absolute', left: -cropX * innerWidth * canvasScale, top: -cropY * innerHeight * canvasScale, width: innerWidth * canvasScale, height: innerHeight * canvasScale, display: 'block', objectFit: 'fill', filter: mediaFilter }
        : { width: '100%', height: '100%', display: 'block', objectFit: 'fill', filter: mediaFilter };
      const mediaElement = asset.type === 'video'
        ? <video ref={(element) => { mediaRefs.current[clip.id] = element; if (element) syncVideo(clip, element); }} src={mediaUrl} muted playsInline className={`preview-media ${!isFullscreen && selectedClipIds.includes(clip.id) ? 'preview-selected' : ''}`} style={mediaStyle} onLoadedMetadata={(event) => syncVideo(clip, event.currentTarget)} />
        : <img src={mediaUrl} className={`preview-media ${!isFullscreen && selectedClipIds.includes(clip.id) ? 'preview-selected' : ''}`} style={mediaStyle} alt={clip.name} />;
      return <div key={clip.id} className="preview-media-frame preview-layer" style={mediaFrameStyle}><div className="preview-media-mask" style={maskStyle}>{mediaElement}{filter.vignette > 0.001 && <span className="preview-vignette" style={{ opacity: clamp(filter.vignette, 0, 1) }} />}</div></div>;
    })}
     {!isFullscreen && activeMedia.map(({ clip, trackIndex }) => {
      const asset = clip.assetId ? project.assets.find((item) => item.id === clip.assetId) : undefined;
      if (!asset) return null;
      const visual = clipVisualValues(clip, currentTime);
      const fit = (previewFraming === 'fill' || previewFraming === 'smart') ? 'cover' : previewFraming === 'fit' ? 'contain' : clip.transform.fit;
      const bounds = previewMediaRenderBounds(asset, clip.crop, project.canvas.width, project.canvas.height, fit);
      const track = project.tracks.find((item) => item.clips.some((candidate) => candidate.id === clip.id));
      return <button type="button" key={`preview-hit-${clip.id}`} className={`preview-hit-target ${selectedClipIds.includes(clip.id) ? 'selected' : ''}`} style={{ width: bounds.width * canvasScale, height: bounds.height * canvasScale, zIndex: 40 + trackIndex, transform: `translate(-50%, -50%) translate(${visual.x * canvasScale}px, ${visual.y * canvasScale}px) rotate(${visual.rotation}deg) scale(${visual.scale}) scaleX(${clip.transform.flipX ? -1 : 1}) scaleY(${clip.transform.flipY ? -1 : 1})` }} onPointerDown={(event) => beginPreviewTransform(event, clip, 'move')} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelected(clip.id, track?.id ?? null); } }} aria-label={t('preview.selectAria', { name: clip.name })}><span className="preview-hit-label">{t(clip.type === 'image' ? 'preview.type.image' : 'preview.type.video')}</span></button>;
    })}
     {activeAudio.map(({ clip, track }) => {
      const asset = clip.assetId ? project.assets.find((item) => item.id === clip.assetId) : undefined;
      if (!asset) return null;
      const mediaUrl = `/api/projects/${project.id}/media/${asset.id}${useProxy && asset.proxyPath ? '?proxy=1' : ''}`;
       return <audio key={`audio-${clip.id}`} ref={(element) => { audioRefs.current[clip.id] = element; if (element) syncAudio(clip, element, track.volume ?? 1); }} src={mediaUrl} preload="auto" onLoadedMetadata={(event) => syncAudio(clip, event.currentTarget, track.volume ?? 1)} />;
    })}
    {texts.map(({ clip, style, trackIndex }) => { const visual = clipVisualValues(clip, currentTime); const bounds = previewTextBounds(style, project.canvas.width, project.canvas.height, canvasScale); const track = project.tracks.find((item) => item.clips.some((candidate) => candidate.id === clip.id)); return <div key={clip.id} className={`preview-text preview-layer ${!isFullscreen && selectedClipIds.includes(clip.id) ? 'preview-selected' : ''}`} role="button" tabIndex={isFullscreen ? -1 : 0} aria-label={t('preview.selectAria', { name: style.text || clip.name })} onPointerDown={(event) => beginPreviewTransform(event, clip, 'move')} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelected(clip.id, track?.id ?? null); } }} style={{ left: '50%', top: '50%', bottom: 'auto', width: bounds.width * canvasScale, zIndex: trackIndex + 1, pointerEvents: isFullscreen ? 'none' : 'auto', transform: `translate(-50%, -50%) translate(${visual.x * canvasScale}px, ${visual.y * canvasScale}px) rotate(${visual.rotation}deg) scale(${visual.scale})`, opacity: visual.opacity, fontFamily: style.fontFamily, fontSize: Math.max(1, style.fontSize * canvasScale), color: style.color, fontWeight: style.fontWeight, fontStyle: style.fontStyle, textDecoration: style.textDecoration, letterSpacing: `${style.letterSpacing * canvasScale}px`, lineHeight: style.lineHeight, padding: `${style.padding * canvasScale}px`, background: style.background, clipPath: transitionClipPath(visual.wipe), WebkitTextStroke: `${style.strokeWidth * canvasScale}px ${style.stroke}`, textShadow: style.shadow ? '0 2px 8px #000' : 'none', textAlign: style.align }}>{style.text}</div>; })}
    {!isFullscreen && activeSelected && activeSelectedVisual && <div className="preview-transform-box" style={{ zIndex: 300, left: '50%', top: '50%', width: selectedBounds.width * canvasScale, height: selectedBounds.height * canvasScale, transform: `translate(-50%, -50%) translate(${activeSelectedVisual.x * canvasScale}px, ${activeSelectedVisual.y * canvasScale}px) rotate(${activeSelectedVisual.rotation}deg) scale(${activeSelectedVisual.scale})` }}><span className="preview-transform-label">{t(activeSelected.clip.adjustment ? 'preview.type.adjustment' : activeSelected.clip.type === 'text' ? 'preview.type.text' : activeSelected.clip.type === 'image' ? 'preview.type.image' : 'preview.type.video')}</span><button className="preview-scale-handle" aria-label={t('preview.resizeAria')} onPointerDown={(event) => beginPreviewTransform(event, activeSelected.clip, 'scale')} /></div>}
    {!isFullscreen && showSafeArea && <div className="safe-area" />}
          </div>
        </div>
        </div>
      </div>
    </div>
    <div className="preview-controls"><span className="preview-time"><EditableTimecode value={currentTime} duration={project.duration} fps={project.canvas.fps} onChange={setCurrentTime} /> <i>/</i> {formatTime(project.duration, true, project.canvas.fps)}</span><div className="transport-center"><button className="control-button" title={t('preview.previousFrame')} onClick={() => stepFrame(-1)}>↶</button><button className="play-button" aria-label={t(playing ? 'preview.pause' : 'preview.play')} onClick={() => setPlaying(!playing)}>{playing ? 'Ⅱ' : '▶'}</button><button className="control-button" title={t('preview.nextFrame')} onClick={() => stepFrame(1)}>↷</button></div><div className="transport-right"><button className="control-button" title={t('preview.rewind')} onClick={() => { setPlaying(false); setCurrentTime(0); }}>⌁</button><button className="quality-button" onClick={cycleQuality} title={t('preview.quality')}>{t(`settings.previewQuality.${settings?.proxyQuality ?? 'balanced'}` as TranslationKey)}⌄</button></div></div></main>;
}
