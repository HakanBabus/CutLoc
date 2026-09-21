import { useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import { clamp, effectiveVisualFit, evaluateClipFrame, evaluateFrameRenderPlan, formatTime, normalizeTextLineBreaks, parseTimelineTimecode, playbackTime, projectDuration, quantizeFrameTime, resolveMediaFrameGeometry, resolveTextFrameGeometry, shouldMountPreviewMedia, visualLayerPlan, type CanvasAspect, type Clip, type FrameWipe, type Project, type Settings } from '@cutloc/shared';
import { useI18n, type TranslationKey } from '../i18n';
import { UiIcon } from '../components/ui-icon';
import { DEFAULT_TEXT_STYLE } from './text-model';
import { useEditor } from './store';
import { api } from './api';
import { setMotionValue } from './keyframes';

declare global {
  interface Window {
    __cutlocRenderer?: {
      seek: (time: number) => Promise<{ frameIndex: number; time: number }>;
      projectId: string;
    };
  }
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

function transitionClipPath(wipe: FrameWipe | null) {
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
  const feather = clamp(mask.feather ?? 0, 0, 1);
  const background = mask.invert ? 'white' : 'black';
  const foreground = mask.invert ? 'black' : 'white';
  const filter = feather > 0.001 ? `<filter id="soft" x="-25%" y="-25%" width="150%" height="150%"><feGaussianBlur stdDeviation="${Math.max(0.2, feather * 6)}"/></filter>` : '';
  const shape = mask.type === 'ellipse' ? `<ellipse cx="${x + width / 2}" cy="${y + height / 2}" rx="${width / 2}" ry="${height / 2}" fill="${foreground}"${filter ? ' filter="url(#soft)"' : ''}/>` : `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${foreground}"${filter ? ' filter="url(#soft)"' : ''}/>`;
  // CSS image masks read the SVG alpha channel. First resolve the luminance
  // shape into real transparency so the area outside the mask is not opaque.
  const svg = mask.invert
    ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" preserveAspectRatio="none"><defs>${filter}<mask id="cutloc-mask" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse"><rect width="100" height="100" fill="${background}"/>${shape}</mask></defs><rect width="100" height="100" fill="white" mask="url(#cutloc-mask)"/></svg>`
    : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" preserveAspectRatio="none"><defs>${filter}</defs>${shape}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
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
      // `duration` is an authored timeline value. Recomputing it from the
      // source range while opening a project made the browser silently shorten
      // still images and disagree with the exporter whenever autosave failed.
      clips: track.clips,
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
  const formatted = formatTime(value, true, fps);
  const frameSeparator = formatted.lastIndexOf(':');
  const clock = formatted.slice(0, frameSeparator);
  const frames = formatted.slice(frameSeparator + 1);
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
  if (!editing) {
    return (
      <button type="button" className="preview-timecode-display" aria-label={t('preview.timecode')} title={t('preview.timecodeHint')} onClick={() => setEditing(true)}>
        <span>{clock}</span>
        <i>:</i>
        <b>{frames}</b>
      </button>
    );
  }
  return (
    <input
      autoFocus
      className="preview-timecode-input"
      aria-label={t('preview.timecode')}
      aria-invalid={invalid}
      title={invalid ? t('preview.invalidTimecode') : t('preview.timecodeHint')}
      value={draft}
      onFocus={(event) => {
        setInvalid(false);
        event.currentTarget.select();
      }}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        commit();
        setEditing(false);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') {
          setDraft(formatTime(value, true, fps));
          setInvalid(false);
          event.currentTarget.blur();
        }
      }}
    />
  );
}

export function PreviewArea({ project, settings }: { project: Project; settings: Settings | null }) {
  const { t } = useI18n();
  const renderMode = useMemo(() => new URLSearchParams(window.location.search).has('renderProject'), []);
  const currentTime = useEditor((state) => state.currentTime);
  const playing = useEditor((state) => state.playing);
  const setPlaying = useEditor((state) => state.setPlaying);
  const setCurrentTime = useEditor((state) => state.setCurrentTime);
  const selectedClipId = useEditor((state) => state.selectedClipId);
  const selectedClipIds = useEditor((state) => state.selectedClipIds);
  const setSelected = useEditor((state) => state.setSelected);
  const mutateProject = useEditor((state) => state.mutateProject);
  // Keep one media element per active or imminent clip. Upcoming media is mounted
  // hidden so local image decode and video seek finish before a hard-cut boundary.
  const mediaRefs = useRef<Record<string, HTMLVideoElement | null>>({});
  const audioRefs = useRef<Record<string, HTMLAudioElement | null>>({});
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioGainNodesRef = useRef(new WeakMap<HTMLMediaElement, GainNode>());
  const canvasRef = useRef<HTMLDivElement>(null);
  const fullscreenRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [previewFraming, setPreviewFraming] = useState<'clip' | 'fit' | 'fill' | 'smart'>(project.canvas.fitMode === 'keep' ? 'clip' : (project.canvas.fitMode ?? 'fit'));
  const [previewZoom, setPreviewZoom] = useState(100);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [previewDrag, setPreviewDrag] = useState<{
    clipId: string;
    mode: 'move' | 'scale';
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    originScale: number;
    historyGroup: string;
  } | null>(null);
  const playbackStartRef = useRef<{
    projectTime: number;
    wallTime: number;
  } | null>(null);
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
    };
    document.addEventListener('fullscreenchange', updateFullscreenState);
    updateFullscreenState();
    return () => document.removeEventListener('fullscreenchange', updateFullscreenState);
  }, []);
  const visualPlan = useMemo(() => visualLayerPlan(project), [project]);
  const fastPreviewTime = quantizeFrameTime(currentTime, project.canvas.fps, project.duration);
  const framePlan = useMemo(() => evaluateFrameRenderPlan(project, fastPreviewTime), [fastPreviewTime, project]);
  const frameLayerByClipId = useMemo(() => new Map(framePlan.visual.map((layer) => [layer.clip.id, layer])), [framePlan]);
  const frameValues = (clip: Clip) => frameLayerByClipId.get(clip.id)?.values ?? evaluateClipFrame(clip, framePlan.time);
  const activeClips = visualPlan.filter(({ clip }) => framePlan.time >= clip.start && framePlan.time < clip.start + clip.duration);
  const activeMedia = useMemo(() => framePlan.visual.filter(({ clip, asset }) => Boolean(asset) && (clip.type === 'video' || clip.type === 'image')), [framePlan]);
  const mountedMedia = visualPlan.filter(({ clip }) => !clip.adjustment && shouldMountPreviewMedia(clip, currentTime));
  const activeAudio = framePlan.audio;
  const texts = useMemo(() => framePlan.visual
    .filter(({ clip }) => clip.textStyle)
    .map(({ clip, trackIndex, values, textGeometry }) => ({
      clip,
      style: clip.textStyle!,
      trackIndex,
      values,
      textGeometry,
    })), [framePlan]);
  const activeSelected = selectedClipId ? activeClips.find(({ clip }) => clip.id === selectedClipId && (clip.adjustment || clip.type === 'video' || clip.type === 'image' || clip.type === 'text')) : undefined;
  const activeSelectedVisual = activeSelected ? frameValues(activeSelected.clip) : null;
  const activeSelectedAsset = activeSelected?.clip.assetId ? project.assets.find((item) => item.id === activeSelected.clip.assetId) : undefined;

  useEffect(() => {
    if (!renderMode) return;
    const nextPaint = () => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    const waitForMedia = async (element: HTMLMediaElement, target: number) => {
      element.pause();
      if (Math.abs(element.currentTime - target) <= 0.5 / framePlan.fps && element.readyState >= 2) return;
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          element.removeEventListener('seeked', finish);
          element.removeEventListener('loadeddata', finish);
          resolve();
        };
        const timer = window.setTimeout(finish, 8_000);
        element.addEventListener('seeked', finish, { once: true });
        element.addEventListener('loadeddata', finish, { once: true });
        element.currentTime = target;
      });
    };
    window.__cutlocRenderer = {
      projectId: project.id,
      seek: async (requestedTime) => {
        const time = quantizeFrameTime(requestedTime, project.canvas.fps, Math.max(0, project.duration - 1 / project.canvas.fps));
        setPlaying(false);
        setCurrentTime(time);
        await nextPaint();
        await nextPaint();
        await document.fonts.ready;
        const clips = project.tracks.flatMap((track) => track.clips).filter((clip) => time >= clip.start && time < clip.start + clip.duration);
        await Promise.all(clips.map(async (clip) => {
          const media = mediaRefs.current[clip.id] ?? audioRefs.current[clip.id];
          if (!media || (clip.type !== 'video' && clip.type !== 'audio')) return;
          await waitForMedia(media, evaluateClipFrame(clip, time).sourceTime);
        }));
        const images = Array.from(canvasRef.current?.querySelectorAll<HTMLImageElement>('img.preview-media') ?? []);
        await Promise.all(images.map((image) => image.decode?.().catch(() => undefined)));
        await nextPaint();
        return { frameIndex: Math.round(time * project.canvas.fps), time };
      },
    };
    return () => { delete window.__cutlocRenderer; };
  }, [framePlan.fps, project, renderMode, setCurrentTime, setPlaying]);

  const beginPreviewTransform = (event: React.PointerEvent<HTMLElement>, clip: Clip, mode: 'move' | 'scale') => {
    if (event.button !== 0) return;
    if (project.tracks.find((track) => track.clips.some((item) => item.id === clip.id))?.locked) return;
    event.preventDefault();
    event.stopPropagation();
    setSelected(clip.id, project.tracks.find((track) => track.clips.some((item) => item.id === clip.id))?.id ?? null);
    const values = frameValues(clip);
    setPreviewDrag({
      clipId: clip.id,
      mode,
      startX: event.clientX,
      startY: event.clientY,
      originX: values.x,
      originY: values.y,
      originScale: values.scale,
      historyGroup: crypto.randomUUID(),
    });
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const updatePreviewTransform = (event: React.PointerEvent<HTMLElement>) => {
    if (!previewDrag) return;
    const rect = canvasRef.current?.getBoundingClientRect();
    const scaleX = project.canvas.width / Math.max(1, rect?.width ?? project.canvas.width);
    const scaleY = project.canvas.height / Math.max(1, rect?.height ?? project.canvas.height);
    const deltaX = (event.clientX - previewDrag.startX) * scaleX;
    const deltaY = (event.clientY - previewDrag.startY) * scaleY;
    mutateProject(
      (draft) => {
        const clip = draft.tracks.flatMap((track) => track.clips).find((item) => item.id === previewDrag.clipId);
        if (!clip) return;
        const localTime = clamp(currentTime - clip.start, 0, clip.duration);
        if (previewDrag.mode === 'move') {
          setMotionValue(clip, 'x', localTime, Math.round(previewDrag.originX + deltaX), project.canvas.fps);
          setMotionValue(clip, 'y', localTime, Math.round(previewDrag.originY + deltaY), project.canvas.fps);
        } else {
          setMotionValue(clip, 'scale', localTime, clamp(previewDrag.originScale + deltaX / Math.max(120, project.canvas.width * 0.12), 0.05, 8), project.canvas.fps);
        }
      },
      { historyGroup: previewDrag.historyGroup },
    );
  };

  const finishPreviewTransform = () => setPreviewDrag(null);

  const syncVideo = (clip: Clip, video: HTMLVideoElement) => {
    const values = frameValues(clip);
    const target = Math.max(0, values.sourceTime);
    video.playbackRate = clamp(values.speed, 0.25, 4);
    const driftTolerance = playing ? Math.max(0.04, 2 / framePlan.fps) : 0.5 / framePlan.fps;
    if (Math.abs(video.currentTime - target) > driftTolerance) video.currentTime = target;
    if (playing) void video.play().catch(() => undefined);
    else video.pause();
  };

  const primeVideo = (clip: Clip, video: HTMLVideoElement) => {
    const target = Math.max(0, clip.sourceStart);
    video.pause();
    if (video.readyState >= 1 && Math.abs(video.currentTime - target) > 0.02) video.currentTime = target;
  };

  const syncAudio = (clip: Clip, audio: HTMLAudioElement, trackVolume = 1) => {
    const values = frameValues(clip);
    const target = Math.max(0, values.sourceTime);
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
    const driftTolerance = playing ? Math.max(0.04, 2 / framePlan.fps) : 0.5 / framePlan.fps;
    if (Math.abs(audio.currentTime - target) > driftTolerance) audio.currentTime = target;
    if (playing) void audio.play().catch(() => undefined);
    else audio.pause();
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
    void api('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ proxyQuality: next }),
    });
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
  const baseScale = isFullscreen || renderMode ? fitScale : Math.min(1, fitScale);
  const displayScale = baseScale * clamp(previewZoom / 100, 0.5, 2.5);
  // Every overlay, hit target and selection box must use the same scale as the
  // canvas itself; otherwise zoom changes the frame but leaves controls behind.
  const canvasScale = displayScale;
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
  const selectedMediaGeometry = activeSelectedAsset && activeSelected
    ? resolveMediaFrameGeometry(activeSelectedAsset, activeSelected.clip.crop, project.canvas.width, project.canvas.height, frameLayerByClipId.get(activeSelected.clip.id)?.fit ?? activeSelected.clip.transform.fit)
    : null;
  const selectedBounds =
    activeSelected?.clip.type === 'text' && !activeSelected.clip.adjustment
      ? resolveTextFrameGeometry(
          activeSelected.clip.textStyle ?? {
            ...DEFAULT_TEXT_STYLE,
            text: activeSelected.clip.name,
          },
          project.canvas.width,
          project.canvas.height,
          canvasScale,
        )
      : activeSelectedAsset
        ? selectedMediaGeometry!.frame
        : {
            width: project.canvas.width * 0.72,
            height: project.canvas.height * 0.72,
          };
  const changePreviewFraming = (next: 'clip' | 'fit' | 'fill' | 'smart') => {
    setPreviewFraming(next);
    mutateProject((draft) => {
      draft.canvas.fitMode = next === 'clip' ? 'keep' : next;
    });
  };

  useEffect(() => {
    if (!playing) {
      playbackStartRef.current = null;
      return;
    }
    let start = {
      projectTime: useEditor.getState().currentTime,
      wallTime: performance.now(),
    };
    let lastPlaybackTime = start.projectTime;
    playbackStartRef.current = start;
    let frame = 0;
    const tick = (now: number) => {
      const requestedTime = useEditor.getState().currentTime;
      if (requestedTime !== lastPlaybackTime) {
        start = { projectTime: requestedTime, wallTime: now };
        playbackStartRef.current = start;
      }
      const next = playbackTime(start.projectTime, start.wallTime, now, project.duration);
      if (next >= project.duration) {
        setPlaying(false);
        setCurrentTime(0);
        return;
      }
      // The composition is frame based. Publishing the same frame to Zustand
      // multiple times only rerenders the editor without changing pixels.
      const frameTime = quantizeFrameTime(next, project.canvas.fps, project.duration);
      if (frameTime !== lastPlaybackTime) {
        setCurrentTime(frameTime);
        lastPlaybackTime = frameTime;
      }
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [playing, project.canvas.fps, project.duration, setCurrentTime, setPlaying]);

  const useProxy = !renderMode && settings?.proxyQuality !== 'high';
  return (
    <main ref={fullscreenRef} className="preview-area">
      <div className="preview-toolbar">
        <div className="preview-breadcrumb">
          <span>{t('preview.canvas')}</span>
          <select className="preview-aspect-select" aria-label={t('preview.aspect')} value={aspect} onChange={(event) => setAspect(event.target.value as CanvasAspect)}>
            <option value="16:9">16:9 · YouTube</option>
            <option value="9:16">9:16 · {t('preview.portrait')}</option>
            <option value="1:1">1:1 · {t('preview.square')}</option>
            <option value="4:5">4:5 · Instagram</option>
            <option value="3:2">3:2 · {t('preview.classic')}</option>
            <option value="21:9">21:9 · {t('preview.cinematic')}</option>
          </select>
          <select className="preview-fit-select" aria-label={t('preview.framing')} title={t('preview.framingHint')} value={previewFraming} onChange={(event) => changePreviewFraming(event.target.value as typeof previewFraming)}>
            <option value="clip">{t('preview.clipFraming')}</option>
            <option value="fit">{t('preview.fitMedia')}</option>
            <option value="fill">{t('preview.fillMedia')}</option>
            <option value="smart">{t('preview.smartFraming')}</option>
          </select>
          <select
            className="preview-fps-select"
            aria-label={t('preview.frameRate')}
            title={t('preview.frameRateHint')}
            value={project.canvas.fps}
            onChange={(event) => {
              const fps = Number(event.target.value);
              mutateProject((draft) => { draft.canvas.fps = fps; });
            }}
          >
            {[23.976, 24, 25, 29.97, 30, 50, 59.94, 60].map((fps) => <option key={fps} value={fps}>{fps} FPS</option>)}
          </select>
        </div>
      </div>
      <div className="preview-inline-zoom" aria-label={t('preview.zoom')}>
        <button aria-label={t('preview.zoomOut')} onClick={() => setPreviewZoom((value) => clamp(value - 10, 50, 250))}>
          −
        </button>
        <output>{previewZoom}%</output>
        <button aria-label={t('preview.zoomIn')} onClick={() => setPreviewZoom((value) => clamp(value + 10, 50, 250))}>
          +
        </button>
        <button onClick={() => setPreviewZoom(100)}>{t('preview.fitZoom')}</button>
      </div>
      <div ref={stageRef} className="preview-stage">
        <div ref={viewportRef} className="preview-canvas-viewport">
          <div className="preview-canvas-pad" style={{ width: canvasPadSize.width, height: canvasPadSize.height }}>
            <div className="preview-fullscreen-shell" style={{ ['--canvas-ratio' as string]: canvasRatio }}>
              <div
                ref={canvasRef}
                className={`canvas-frame canvas-aspect-${aspect.replace(':', '-')}`}
                style={{
                  width: canvasDisplaySize.width,
                  height: canvasDisplaySize.height,
                  aspectRatio: `${project.canvas.width}/${project.canvas.height}`,
                  ['--canvas-ratio' as string]: canvasRatio,
                  background: project.canvas.background,
                }}
                onPointerMove={updatePreviewTransform}
                onPointerUp={finishPreviewTransform}
                onPointerCancel={finishPreviewTransform}
              >
                <svg width="0" height="0" aria-hidden="true" style={{ position: 'absolute' }}>
                  <defs>
                    {activeMedia.flatMap(({ clip, filters }) =>
                      filters.chromaKey
                        ? [
                            <filter key={clip.id} id={`preview-chroma-${clip.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`} colorInterpolationFilters="sRGB">
                              <feColorMatrix type="matrix" values={previewChromaMatrix(filters.chromaKey.color, filters.chromaKey.similarity)} />
                              <feComponentTransfer>
                                <feFuncA type="gamma" amplitude="1" exponent={Math.max(0.2, 1 - filters.chromaKey.blend)} offset="0" />
                              </feComponentTransfer>
                            </filter>,
                          ]
                        : [],
                    )}
                  </defs>
                </svg>
                {mountedMedia.map(({ clip, stackOrder }) => {
                  const asset = clip.assetId ? project.assets.find((item) => item.id === clip.assetId) : undefined;
                  if (!asset) return null;
                  const layer = frameLayerByClipId.get(clip.id);
                  const isActive = Boolean(layer);
                  const visual = frameValues(clip);
                  const mediaUrl = `/api/projects/${project.id}/media/${asset.id}${useProxy && asset.proxyPath ? '?proxy=1' : ''}`;
                  const filter = layer?.filters ?? clip.filters;
                  const crop = clip.crop;
                  const mask = clip.mask;
                  const fit = layer?.fit ?? effectiveVisualFit(project.canvas.fitMode, clip.transform.fit);
                  const geometry = layer?.mediaGeometry ?? resolveMediaFrameGeometry(asset, crop, project.canvas.width, project.canvas.height, fit);
                  const frameBounds = geometry.frame;
                  const temperature = filter.temperature ?? 0;
                  const hue = filter.hue ?? 0;
                  const vignette = filter.vignette ?? 0;
                  const temperatureFilter = Math.abs(temperature) > 0.001
                    ? ` sepia(${Math.max(0, temperature) * 0.18}) saturate(${1 + Math.abs(temperature) * 0.12}) hue-rotate(${-temperature * 12}deg)`
                    : '';
                  const chromaFilter = filter.chromaKey ? ` url(#preview-chroma-${clip.id.replace(/[^a-zA-Z0-9_-]/g, '-')})` : '';
                  const mediaFilter = `${chromaFilter} brightness(${1 + filter.brightness}) contrast(${1 + filter.contrast}) saturate(${1 + filter.saturation}) hue-rotate(${hue}deg) blur(${filter.blur}px) grayscale(${filter.grayscale})${temperatureFilter}`;
                  const mediaFrameStyle: React.CSSProperties = {
                    position: 'absolute',
                    left: '50%',
                    top: '50%',
                    right: 'auto',
                    bottom: 'auto',
                    width: frameBounds.width * canvasScale,
                    height: frameBounds.height * canvasScale,
                    opacity: isActive ? visual.opacity : 0,
                    pointerEvents: 'none',
                    overflow: 'hidden',
                    zIndex: stackOrder + 1,
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
                  const mediaStyle: React.CSSProperties = crop || fit === 'cover'
                    ? {
                        position: 'absolute',
                        left: geometry.source.left * canvasScale,
                        top: geometry.source.top * canvasScale,
                        width: geometry.source.width * canvasScale,
                        height: geometry.source.height * canvasScale,
                        display: 'block',
                        objectFit: 'fill',
                        filter: mediaFilter,
                      }
                    : {
                        width: '100%',
                        height: '100%',
                        display: 'block',
                        objectFit: 'fill',
                        filter: mediaFilter,
                      };
                  const mediaElement =
                    asset.type === 'video' ? (
                      <video
                        ref={(element) => {
                          mediaRefs.current[clip.id] = element;
                          if (element) isActive ? syncVideo(clip, element) : primeVideo(clip, element);
                        }}
                        src={mediaUrl}
                        preload="auto"
                        muted
                        playsInline
                        className={`preview-media ${!isFullscreen && selectedClipIds.includes(clip.id) ? 'preview-selected' : ''}`}
                        style={mediaStyle}
                        onLoadedMetadata={(event) => (isActive ? syncVideo(clip, event.currentTarget) : primeVideo(clip, event.currentTarget))}
                        onCanPlay={(event) => {
                          if (isActive) syncVideo(clip, event.currentTarget);
                        }}
                      />
                    ) : (
                      <img src={mediaUrl} loading="eager" decoding="async" className={`preview-media ${!isFullscreen && selectedClipIds.includes(clip.id) ? 'preview-selected' : ''}`} style={mediaStyle} alt={clip.name} />
                    );
                  return (
                    <div key={clip.id} className="preview-media-frame preview-layer" style={mediaFrameStyle}>
                      <div className="preview-media-mask" style={maskStyle}>
                        {mediaElement}
                        {vignette > 0.001 && <span className="preview-vignette" style={{ opacity: clamp(vignette, 0, 1) }} />}
                      </div>
                    </div>
                  );
                })}
                {!isFullscreen &&
                  activeMedia.map(({ clip, trackIndex, values: visual, mediaGeometry }) => {
                    if (!mediaGeometry) return null;
                    const bounds = mediaGeometry.frame;
                    const track = project.tracks.find((item) => item.clips.some((candidate) => candidate.id === clip.id));
                    return (
                      <button
                        type="button"
                        key={`preview-hit-${clip.id}`}
                        className={`preview-hit-target ${selectedClipIds.includes(clip.id) ? 'selected' : ''}`}
                        style={{
                          width: bounds.width * canvasScale,
                          height: bounds.height * canvasScale,
                          zIndex: 40 + trackIndex,
                          transform: `translate(-50%, -50%) translate(${visual.x * canvasScale}px, ${visual.y * canvasScale}px) rotate(${visual.rotation}deg) scale(${visual.scale}) scaleX(${clip.transform.flipX ? -1 : 1}) scaleY(${clip.transform.flipY ? -1 : 1})`,
                        }}
                        onPointerDown={(event) => beginPreviewTransform(event, clip, 'move')}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            setSelected(clip.id, track?.id ?? null);
                          }
                        }}
                        aria-label={t('preview.selectAria', {
                          name: clip.name,
                        })}
                      >
                        <span className="preview-hit-label">{t(clip.type === 'image' ? 'preview.type.image' : 'preview.type.video')}</span>
                      </button>
                    );
                  })}
                {activeAudio.map(({ clip, track }) => {
                  const asset = clip.assetId ? project.assets.find((item) => item.id === clip.assetId) : undefined;
                  if (!asset) return null;
                  const mediaUrl = `/api/projects/${project.id}/media/${asset.id}${useProxy && asset.proxyPath ? '?proxy=1' : ''}`;
                  return (
                    <audio
                      key={`audio-${clip.id}`}
                      ref={(element) => {
                        audioRefs.current[clip.id] = element;
                        if (element) syncAudio(clip, element, track.volume ?? 1);
                      }}
                      src={mediaUrl}
                      preload="auto"
                      onLoadedMetadata={(event) => syncAudio(clip, event.currentTarget, track.volume ?? 1)}
                    />
                  );
                })}
                {texts.map(({ clip, style, trackIndex, values: visual }) => {
                  const bounds = resolveTextFrameGeometry(style, project.canvas.width, project.canvas.height, canvasScale);
                  const track = project.tracks.find((item) => item.clips.some((candidate) => candidate.id === clip.id));
                  return (
                    <div
                      key={clip.id}
                      className={`preview-text preview-layer ${!isFullscreen && selectedClipIds.includes(clip.id) ? 'preview-selected' : ''}`}
                      role="button"
                      tabIndex={isFullscreen ? -1 : 0}
                      aria-label={t('preview.selectAria', {
                        name: style.text || clip.name,
                      })}
                      onPointerDown={(event) => beginPreviewTransform(event, clip, 'move')}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setSelected(clip.id, track?.id ?? null);
                        }
                      }}
                      style={{
                        left: '50%',
                        top: '50%',
                        bottom: 'auto',
                        width: bounds.width * canvasScale,
                        zIndex: trackIndex + 1,
                        pointerEvents: isFullscreen ? 'none' : 'auto',
                        transform: `translate(-50%, -50%) translate(${visual.x * canvasScale}px, ${visual.y * canvasScale}px) rotate(${visual.rotation}deg) scale(${visual.scale})`,
                        opacity: visual.opacity,
                        fontFamily: style.fontFamily,
                        fontSize: Math.max(1, style.fontSize * canvasScale),
                        color: style.color,
                        fontWeight: style.fontWeight,
                        fontStyle: style.fontStyle,
                        textDecoration: style.textDecoration,
                        letterSpacing: `${style.letterSpacing * canvasScale}px`,
                        lineHeight: style.lineHeight,
                        padding: `${style.padding * canvasScale}px`,
                        background: style.background,
                        clipPath: transitionClipPath(visual.wipe),
                        WebkitTextStroke: `${style.strokeWidth * canvasScale}px ${style.stroke}`,
                        textShadow: style.shadow
                          ? `0 ${2 * canvasScale}px ${8 * canvasScale}px rgba(0, 0, 0, .92)`
                          : 'none',
                        textAlign: style.align,
                        whiteSpace: 'pre',
                      }}
                    >
                      {normalizeTextLineBreaks(style.text)}
                    </div>
                  );
                })}
                {!isFullscreen && activeSelected && activeSelectedVisual && (
                  <div
                    className="preview-transform-box"
                    style={{
                      zIndex: 300,
                      left: '50%',
                      top: '50%',
                      width: selectedBounds.width * canvasScale,
                      height: selectedBounds.height * canvasScale,
                      transform: `translate(-50%, -50%) translate(${activeSelectedVisual.x * canvasScale}px, ${activeSelectedVisual.y * canvasScale}px) rotate(${activeSelectedVisual.rotation}deg) scale(${activeSelectedVisual.scale})`,
                    }}
                  >
                    <span className="preview-transform-label">{t(activeSelected.clip.adjustment ? 'preview.type.adjustment' : activeSelected.clip.type === 'text' ? 'preview.type.text' : activeSelected.clip.type === 'image' ? 'preview.type.image' : 'preview.type.video')}</span>
                    <button className="preview-scale-handle" aria-label={t('preview.resizeAria')} onPointerDown={(event) => beginPreviewTransform(event, activeSelected.clip, 'scale')} />
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className="preview-controls">
        <span className="preview-time">
          <EditableTimecode value={currentTime} duration={project.duration} fps={project.canvas.fps} onChange={setCurrentTime} />
          <span className="preview-time-divider">/</span>
          <b className="preview-time-duration">{formatTime(project.duration, true, project.canvas.fps)}</b>
          <small className="preview-time-fps">{project.canvas.fps} FPS</small>
        </span>
        <div className="transport-center">
          <button className="control-button" aria-label={t('preview.previousFrame')} title={t('preview.previousFrame')} onClick={() => stepFrame(-1)}>
            <UiIcon name="previous" />
          </button>
          <button className="play-button" aria-label={t(playing ? 'preview.pause' : 'preview.play')} onClick={() => setPlaying(!playing)}>
            <UiIcon name={playing ? 'pause' : 'play'} />
          </button>
          <button className="control-button" aria-label={t('preview.nextFrame')} title={t('preview.nextFrame')} onClick={() => stepFrame(1)}>
            <UiIcon name="next" />
          </button>
        </div>
        <div className="transport-right">
          <button className={`control-button fullscreen-button ${isFullscreen ? 'active' : ''}`} aria-label={t('preview.fullscreen')} aria-pressed={isFullscreen} title={t('preview.fullscreen')} onClick={toggleFullscreen}>
            <span className="fullscreen-glyph" aria-hidden="true">⛶</span>
          </button>
          <button
            className="control-button"
            aria-label={t('preview.rewind')}
            title={t('preview.rewind')}
            onClick={() => {
              setPlaying(false);
              setCurrentTime(0);
            }}
          >
            <UiIcon name="rewind" />
          </button>
          <button className="quality-button" onClick={cycleQuality} title={t('preview.quality')}>
            <UiIcon name="quality" />
            <span>{t(`settings.previewQuality.${settings?.proxyQuality ?? 'balanced'}` as TranslationKey)}</span>
            <b>⌄</b>
          </button>
        </div>
      </div>
    </main>
  );
}
