import { useEffect, useRef, useState } from 'react';
import type React from 'react';
import { clamp, formatTime, projectDuration, quantizeFrameTime, rippleDeleteAcrossTimeline, snapTime as snapProjectTime, splitClipAt, trimClip, trimClipToPlayhead, type Clip, type Project, type Track } from '@cutloc/shared';
import { useI18n, type TranslationKey } from '../i18n';
import { ContextMenu, type ContextMenuItem } from '../components/context-menu';
import { PromptDialog } from '../components/dialogs';
import { UiIcon } from '../components/ui-icon';
import { createAdjustmentClip, createLayerTrack, createMediaClip } from './media-model';
import { shortcutValue, useEditor } from './store';
import './timeline.css';

const TIMELINE_LABEL_WIDTH = 160;

type ProTimelineDrag =
  | {
      kind: 'clip';
      clipId: string;
      trackId: string;
      startX: number;
      start: number;
      selectedClipIds: string[];
      selectedClipStarts: Record<string, number>;
      historyGroup?: string;
    }
  | {
      kind: 'trimLeft' | 'trimRight';
      clipId: string;
      trackId: string;
      startX: number;
      start: number;
      duration: number;
      clipSnapshot: Clip;
      historyGroup: string;
    }
  | { kind: 'playhead' }
  | { kind: 'marker'; markerId: string; historyGroup?: string };

type ClipStyleSnapshot = Pick<Clip, 'transform' | 'filters' | 'transitionIn' | 'transitionOut' | 'volume' | 'fadeIn' | 'fadeOut' | 'normalize' | 'mask' | 'crop' | 'keyframes' | 'textStyle'>;
let clipStyleClipboard: {
  sourceType: Clip['type'];
  style: ClipStyleSnapshot;
} | null = null;

function copyClipStyle(clip: Clip) {
  const { transform, filters, transitionIn, transitionOut, volume, fadeIn, fadeOut, normalize, mask, crop, keyframes, textStyle } = clip;
  clipStyleClipboard = structuredClone({
    sourceType: clip.type,
    style: {
      transform,
      filters,
      transitionIn,
      transitionOut,
      volume,
      fadeIn,
      fadeOut,
      normalize,
      mask,
      crop,
      keyframes,
      textStyle,
    },
  });
}

function clipTypeIcon(clip: Pick<Clip, 'type' | 'adjustment'>) {
  if (clip.adjustment) return '◐';
  if (clip.type === 'video') return '▶';
  if (clip.type === 'audio') return '♫';
  if (clip.type === 'image') return '▧';
  if (clip.type === 'subtitle') return 'CC';
  return 'T';
}

export function TimelinePro({ project }: { project: Project }) {
  const { t, language } = useI18n();
  const settings = useEditor((state) => state.settings);
  const currentTime = useEditor((state) => state.currentTime);
  const setCurrentTime = useEditor((state) => state.setCurrentTime);
  const px = useEditor((state) => state.pxPerSecond);
  const setZoom = useEditor((state) => state.setZoom);
  const selectedClipId = useEditor((state) => state.selectedClipId);
  const selectedClipIds = useEditor((state) => state.selectedClipIds);
  const selectedTrackId = useEditor((state) => state.selectedTrackId);
  const setSelected = useEditor((state) => state.setSelected);
  const toggleSelected = useEditor((state) => state.toggleSelected);
  const mutateProject = useEditor((state) => state.mutateProject);
  const setNotice = useEditor((state) => state.setNotice);
  const undo = useEditor((state) => state.undo);
  const redo = useEditor((state) => state.redo);
  const canUndo = useEditor((state) => state.history.past.length > 0);
  const canRedo = useEditor((state) => state.history.future.length > 0);
  const setPanel = useEditor((state) => state.setPanel);
  const assetDragId = useEditor((state) => state.assetDragId);
  const setAssetDragId = useEditor((state) => state.setAssetDragId);
  const timelineRef = useRef<HTMLDivElement>(null);
  const dragHistoryGroupRef = useRef<string | null>(null);
  const [drag, setDrag] = useState<ProTimelineDrag | null>(null);
  const [drop, setDrop] = useState<{ trackId: string; time: number } | null>(null);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    kind: 'clip' | 'track' | 'marker' | 'add-track' | 'empty';
    clipId?: string;
    trackId?: string;
    markerId?: string;
    time?: number;
  } | null>(null);
  const [editingTrackId, setEditingTrackId] = useState<string | null>(null);
  const [editingTrackName, setEditingTrackName] = useState('');
  const [renameMarker, setRenameMarker] = useState<{
    id: string;
    label: string;
  } | null>(null);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const closeMenu = () => setMenu(null);
  const newHistoryGroup = () => `timeline-${crypto.randomUUID()}`;
  useEffect(() => {
    const clearAssetDrag = () => {
      setAssetDragId(null);
      setDrop(null);
      dragHistoryGroupRef.current = null;
    };
    window.addEventListener('pointerup', clearAssetDrag);
    window.addEventListener('pointercancel', clearAssetDrag);
    return () => {
      window.removeEventListener('pointerup', clearAssetDrag);
      window.removeEventListener('pointercancel', clearAssetDrag);
    };
  }, [setAssetDragId]);
  useEffect(() => {
    const root = timelineRef.current;
    if (!root) return;
    for (const row of Array.from(root.querySelectorAll<HTMLElement>('[data-track-id]'))) {
      const track = project.tracks.find((item) => item.id === row.dataset.trackId);
      if (!track) continue;
      for (const [index, clipElement] of Array.from(row.querySelectorAll<HTMLElement>('.timeline-clip')).entries()) {
        const clip = track.clips[index];
        const asset = clip?.assetId ? project.assets.find((item) => item.id === clip.assetId) : undefined;
        if (clip) {
          const typeKey: TranslationKey = clip.adjustment ? 'inspector.type.adjustment' : clip.type === 'video' ? 'inspector.type.video' : clip.type === 'audio' ? 'inspector.type.audio' : clip.type === 'image' ? 'inspector.type.image' : clip.type === 'text' || clip.type === 'subtitle' ? 'inspector.type.text' : 'inspector.type.clip';
          clipElement.title = `${clip.name} · ${formatTime(clip.start)}–${formatTime(clip.start + clip.duration)} · ${asset?.name ?? t(typeKey)}`;
        }
        if (clip?.type === 'audio' && asset?.waveformPath) clipElement.style.setProperty('--waveform-url', `url("/api/projects/${project.id}/media/${asset.id}?waveform=1")`);
        else clipElement.style.removeProperty('--waveform-url');
      }
    }
  }, [project, t]);
  // Capture timeline presses before React's click/selection behaviour.  This
  // makes a marker move as soon as the pointer is pressed and keeps text
  // selection from turning the timeline into a blue selection region.
  useEffect(() => {
    const root = timelineRef.current;
    if (!root) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || assetDragId) return;
      const target = event.target as HTMLElement;
      const trimHandle = target.closest<HTMLElement>('.clip-handle');
      if (trimHandle) {
        const clipElement = trimHandle.closest<HTMLElement>('.timeline-clip');
        const row = clipElement?.closest<HTMLElement>('[data-track-id]');
        const trackId = row?.dataset.trackId;
        const clipIndex = clipElement && row ? Array.from(row.querySelectorAll('.timeline-clip')).indexOf(clipElement) : -1;
        const track = trackId ? project.tracks.find((item) => item.id === trackId) : undefined;
        const clip = track && clipIndex >= 0 ? track.clips[clipIndex] : undefined;
        if (track && clip && !track.locked) {
          event.preventDefault();
          event.stopPropagation();
          setSelected(clip.id, track.id);
          const historyGroup = newHistoryGroup();
          dragHistoryGroupRef.current = historyGroup;
          setDrag({
            kind: trimHandle.classList.contains('left') ? 'trimLeft' : 'trimRight',
            clipId: clip.id,
            trackId: track.id,
            startX: event.clientX,
            start: clip.start,
            duration: clip.duration,
            clipSnapshot: structuredClone(clip),
            historyGroup,
          });
          root.setPointerCapture(event.pointerId);
          return;
        }
      }
      if (target.closest('.timeline-clip') || target.closest('.playhead')) return;
      const at = quantizeFrameTime(timeFromClientX(event.clientX), project.canvas.fps, project.duration);
      const button = target.closest<HTMLElement>('.timeline-marker');
      const nearestFromDom = button ? Number.parseFloat(button.style.left) / px : Number.POSITIVE_INFINITY;
      const nearest = button
        ? project.markers.reduce<{ id: string; time: number } | null>((best, marker) => {
            const distance = button ? Math.abs(marker.time - nearestFromDom) : Math.abs(marker.time - at);
            return !best || distance < Math.abs(best.time - (button ? nearestFromDom : at)) ? marker : best;
          }, null)
        : null;
      event.preventDefault();
      event.stopPropagation();
      if (nearest) {
        const historyGroup = newHistoryGroup();
        dragHistoryGroupRef.current = historyGroup;
        mutateProject(
          (draft) => {
            const marker = draft.markers.find((item) => item.id === nearest.id);
            if (marker) marker.time = clamp(at, 0, project.duration);
          },
          { historyGroup },
        );
        setCurrentTime(at);
        setDrag({ kind: 'marker', markerId: nearest.id, historyGroup });
      } else {
        if (target.closest('.tracks-canvas')) setSelected(null, null);
        setCurrentTime(at);
        setDrag({ kind: 'playhead' });
      }
      root.setPointerCapture(event.pointerId);
    };
    root.addEventListener('pointerdown', handlePointerDown, true);
    return () => root.removeEventListener('pointerdown', handlePointerDown, true);
  }, [assetDragId, currentTime, mutateProject, project, px, setCurrentTime, setSelected, snapEnabled]);
  const maxTime = project.duration > 0 ? Math.max(10, project.duration + Math.max(10, project.duration * 0.5)) : 10;
  const rulerTicks = Array.from({ length: Math.ceil(maxTime) + 1 }, (_, index) => index).filter((tick) => tick % (px < 60 ? 5 : px < 100 ? 2 : 1) === 0);
  const timeFromClientX = (clientX: number) => {
    const box = timelineRef.current?.getBoundingClientRect();
    if (!box) return 0;
    return clamp((clientX - box.left + (timelineRef.current?.scrollLeft ?? 0) - TIMELINE_LABEL_WIDTH) / px, 0, maxTime);
  };
  const trackIdAtClientY = (clientY: number) => {
    const rows = Array.from(timelineRef.current?.querySelectorAll<HTMLElement>('[data-track-id]') ?? []);
    return (
      rows.find((row) => {
        const box = row.getBoundingClientRect();
        return clientY >= box.top && clientY <= box.bottom;
      })?.dataset.trackId ?? null
    );
  };
  const frameTime = (value: number) => quantizeFrameTime(value, project.canvas.fps, project.duration);
  const snapTime = (value: number) => snapProjectTime(project, value, { enabled: snapEnabled, currentTime });
  const addMarker = () => {
    const at = frameTime(currentTime);
    if (project.markers.some((marker) => Math.abs(marker.time - at) < 1 / Math.max(1, project.canvas.fps) / 2)) {
      setNotice(t('timeline.markerExists'));
      return;
    }
    mutateProject((draft) => {
      draft.markers.push({
        id: `marker_${crypto.randomUUID().slice(0, 8)}`,
        time: at,
        label: t('timeline.markerDefault', { count: draft.markers.length + 1 }),
      });
    });
  };
  const seek = (event: React.MouseEvent<HTMLElement>) => {
    setCurrentTime(frameTime(timeFromClientX(event.clientX)));
  };
  const onPointerMove = (event: React.PointerEvent) => {
    if (assetDragId) {
      const row = (event.target as HTMLElement).closest<HTMLElement>('[data-track-id]');
      const targetTrack = row ? project.tracks.find((item) => item.id === row.dataset.trackId) : undefined;
      const asset = project.assets.find((item) => item.id === assetDragId);
      if (targetTrack && asset && !targetTrack.locked) {
        setDrop({
          trackId: targetTrack.id,
          time: snapTime(timeFromClientX(event.clientX)),
        });
      } else {
        setDrop(null);
      }
    }
    if (!drag) return;
    if (drag.kind === 'playhead') {
      setCurrentTime(frameTime(timeFromClientX(event.clientX)));
      return;
    }
    if (drag.kind === 'marker') {
      const at = frameTime(timeFromClientX(event.clientX));
      mutateProject(
        (draft) => {
          const marker = draft.markers.find((item) => item.id === drag.markerId);
          if (marker) marker.time = at;
        },
        { historyGroup: drag.historyGroup },
      );
      setCurrentTime(at);
      return;
    }
    if (drag.kind === 'trimLeft' || drag.kind === 'trimRight') {
      const delta = (event.clientX - drag.startX) / px;
      const frame = 1 / project.canvas.fps;
      mutateProject(
        (draft) => {
          const nextStart = drag.kind === 'trimLeft' ? clamp(Math.round((drag.start + delta) / frame) * frame, 0, drag.start + drag.duration - frame) : drag.start;
          const nextEnd = drag.kind === 'trimRight' ? clamp(Math.round((drag.start + drag.duration + delta) / frame) * frame, drag.start + frame, drag.clipSnapshot.type === 'image' ? maxTime : drag.start + drag.duration) : drag.start + drag.duration;
          trimClip(draft, drag.clipId, nextStart, nextEnd, drag.clipSnapshot);
        },
        { historyGroup: drag.historyGroup },
      );
      return;
    }
    const targetTrackId = trackIdAtClientY(event.clientY);
    const historyGroup = drag.kind === 'clip' ? (drag.historyGroup ?? dragHistoryGroupRef.current ?? (dragHistoryGroupRef.current = newHistoryGroup())) : drag.historyGroup;
    if (drag.kind === 'clip' && targetTrackId && targetTrackId !== drag.trackId) {
      const destination = project.tracks.find((track) => track.id === targetTrackId);
      if (destination && !destination.locked) {
        const selected = new Set(drag.selectedClipIds);
        mutateProject(
          (draft) => {
            const target = draft.tracks.find((track) => track.id === targetTrackId);
            if (!target || target.locked) return;
            const moving: Clip[] = [];
            for (const track of draft.tracks) {
              const keep: Clip[] = [];
              for (const clip of track.clips) {
                if (selected.has(clip.id)) moving.push(clip);
                else keep.push(clip);
              }
              track.clips = keep;
            }
            target.clips.push(...moving);
            draft.duration = projectDuration(draft);
          },
          { historyGroup },
        );
        setDrag((current) => (current?.kind === 'clip' ? { ...current, trackId: targetTrackId, historyGroup } : current));
        setSelected(drag.clipId, targetTrackId);
        return;
      }
    }
    const delta = (event.clientX - drag.startX) / px;
    mutateProject(
      (draft) => {
        if (drag.kind !== 'clip') return;
        const selected = new Set(drag.selectedClipIds);
        for (const track of draft.tracks) {
          if (track.locked) continue;
          for (const clip of track.clips) {
            if (!selected.has(clip.id)) continue;
            const original = drag.selectedClipStarts[clip.id] ?? (clip.id === drag.clipId ? drag.start : clip.start);
            clip.start = Math.max(0, Math.round((original + delta) * project.canvas.fps) / project.canvas.fps);
          }
        }
        draft.duration = projectDuration(draft);
      },
      { historyGroup },
    );
  };
  const fitTimeline = () => {
    const width = timelineRef.current?.clientWidth ?? 900;
    const available = Math.max(280, width - TIMELINE_LABEL_WIDTH - 24);
    const duration = Math.max(1, project.duration);
    setZoom(clamp(available / duration, 38, 260));
    timelineRef.current?.scrollTo({ left: 0, behavior: 'smooth' });
  };
  const addTrack = () => {
    mutateProject((draft) => {
      createLayerTrack(draft);
    });
    closeMenu();
  };
  const updateTrack = (trackId: string, field: 'hidden' | 'muted' | 'locked') =>
    mutateProject((draft) => {
      const track = draft.tracks.find((item) => item.id === trackId);
      if (track) track[field] = !track[field];
    });
  const addAdjustmentLayer = () => {
    const start = snapTime(currentTime);
    const duration = Math.max(0.5, Math.min(5, project.duration > start ? project.duration - start : 5));
    let targetTrackId: string | null = project.tracks.find((item) => !item.locked && (item.type === 'layer' || item.type === 'overlay'))?.id ?? null;
    const clip = createAdjustmentClip(start, duration);
    mutateProject((draft) => {
      let target = targetTrackId ? draft.tracks.find((item) => item.id === targetTrackId) : undefined;
      if (!target || target.locked) {
        target = createLayerTrack(draft, t('timeline.adjustmentTrack'));
        targetTrackId = target.id;
      }
      target.clips.push(clip);
      draft.duration = projectDuration(draft);
    });
    setSelected(clip.id, targetTrackId);
    setNotice(t('timeline.adjustmentAdded'));
    closeMenu();
  };
  const duplicateTrack = (trackId: string) => {
    mutateProject((draft) => {
      const index = draft.tracks.findIndex((item) => item.id === trackId);
      if (index < 0) return;
      const source = draft.tracks[index];
      const copy = {
        ...source,
        id: `track-${crypto.randomUUID().slice(0, 8)}`,
        name: t('timeline.copySuffix', { name: source.name }),
        order: index + 1,
        clips: source.clips.map((clip) => ({
          ...clip,
          id: `clip_${crypto.randomUUID().slice(0, 8)}`,
        })),
      };
      draft.tracks.splice(index + 1, 0, copy);
      draft.tracks.forEach((track, order) => {
        track.order = order;
      });
    });
    closeMenu();
  };
  const moveTrack = (trackId: string, direction: -1 | 1) => {
    mutateProject((draft) => {
      const index = draft.tracks.findIndex((item) => item.id === trackId);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= draft.tracks.length) return;
      [draft.tracks[index], draft.tracks[target]] = [draft.tracks[target], draft.tracks[index]];
      draft.tracks.forEach((track, order) => {
        track.order = order;
      });
    });
    closeMenu();
  };
  const deleteTrack = (trackId: string) => {
    mutateProject((draft) => {
      draft.tracks = draft.tracks.filter((track) => track.id !== trackId);
      draft.tracks.forEach((track, order) => {
        track.order = order;
      });
      draft.duration = projectDuration(draft);
    });
    setSelected(null, null);
    closeMenu();
  };
  const deleteClip = (clipId: string, ripple = false) => {
    mutateProject((draft) => {
      if (ripple) rippleDeleteAcrossTimeline(draft, clipId);
      else {
        const track = draft.tracks.find((item) => item.clips.some((clip) => clip.id === clipId));
        const clip = track?.clips.find((item) => item.id === clipId);
        if (track && clip && !track.locked) {
          track.clips = track.clips.filter((item) => item.id !== clipId);
          draft.duration = projectDuration(draft);
        }
      }
    });
    setSelected(null, null);
    closeMenu();
  };
  const duplicateClip = (clipId: string) => {
    mutateProject((draft) => {
      const track = draft.tracks.find((item) => item.clips.some((clip) => clip.id === clipId));
      const clip = track?.clips.find((item) => item.id === clipId);
      if (track && clip)
        track.clips.push({
          ...clip,
          id: `clip_${crypto.randomUUID().slice(0, 8)}`,
          start: clip.start + clip.duration,
        });
      draft.duration = projectDuration(draft);
    });
    closeMenu();
  };
  const splitClip = (clipId: string) => {
    mutateProject((draft) => {
      splitClipAt(draft, clipId, currentTime);
    });
    closeMenu();
  };
  const trimSelectedClipToPlayhead = (clipId: string, edge: 'start' | 'end') => {
    mutateProject((draft) => {
      trimClipToPlayhead(draft, clipId, currentTime, edge);
    });
    closeMenu();
  };
  const resetClip = (clipId: string, section: 'transform' | 'filters') => {
    mutateProject((draft) => {
      const clip = draft.tracks.flatMap((item) => item.clips).find((item) => item.id === clipId);
      if (!clip) return;
      if (section === 'transform')
        clip.transform = {
          x: 0,
          y: 0,
          scale: 1,
          rotation: 0,
          opacity: 1,
          fit: 'contain',
          flipX: false,
          flipY: false,
        };
      else
        clip.filters = {
          brightness: 0,
          contrast: 0,
          saturation: 0,
          blur: 0,
          grayscale: 0,
        };
    });
    closeMenu();
  };
  const addLayerRelative = (trackId: string, offset: -1 | 1) => {
    mutateProject((draft) => {
      const index = draft.tracks.findIndex((item) => item.id === trackId);
      if (index < 0) return;
      createLayerTrack(draft);
      const [layer] = draft.tracks.splice(draft.tracks.length - 1, 1);
      draft.tracks.splice(Math.max(0, Math.min(draft.tracks.length, index + (offset < 0 ? 0 : 1))), 0, layer);
      draft.tracks.forEach((item, order) => {
        item.order = order;
      });
    });
    closeMenu();
  };
  const placeAsset = (assetId: string, requestedTrackId: string | undefined, startTime: number) => {
    const asset = project.assets.find((item) => item.id === assetId);
    if (!asset) return;
    const compatible = (track: Track) => !track.locked;
    const requested = requestedTrackId ? project.tracks.find((item) => item.id === requestedTrackId) : undefined;
    const target = requested && compatible(requested) ? requested : project.tracks.find(compatible);
    const clip = createMediaClip(asset, snapTime(startTime));
    let selectedTrackId: string | null = target?.id ?? null;
    mutateProject((draft) => {
      let draftTrack = selectedTrackId ? draft.tracks.find((item) => item.id === selectedTrackId) : undefined;
      if (!draftTrack || draftTrack.locked) {
        draftTrack = createLayerTrack(draft);
        selectedTrackId = draftTrack.id;
      }
      draftTrack.clips.push(clip);
      draft.duration = projectDuration(draft);
    });
    setSelected(clip.id, selectedTrackId);
  };
  const dropAsset = (event: React.DragEvent, track: Track) => {
    event.preventDefault();
    const raw = event.dataTransfer.getData('application/x-cutloc-asset');
    if (!raw) return;
    try {
      const { assetId } = JSON.parse(raw) as { assetId: string };
      placeAsset(assetId, track.id, timeFromClientX(event.clientX));
    } catch {
      setNotice(t('timeline.dragError'));
    }
    setDrop(null);
    setAssetDragId(null);
  };
  const finishPointerAssetDrop = () => {
    if (assetDragId && drop) placeAsset(assetDragId, drop.trackId, drop.time);
    setDrop(null);
    setAssetDragId(null);
    setDrag(null);
  };
  const draggedAsset = assetDragId ? project.assets.find((asset) => asset.id === assetDragId) : undefined;
  const dropGhostWidth = Math.max(36, Math.max(draggedAsset?.duration || 5, 0.5) * px);
  const clip = menu?.clipId ? project.tracks.flatMap((track) => track.clips).find((item) => item.id === menu.clipId) : undefined;
  const track = menu?.trackId ? project.tracks.find((item) => item.id === menu.trackId) : undefined;
  const selectedClip = selectedClipId ? project.tracks.flatMap((item) => item.clips).find((item) => item.id === selectedClipId) : undefined;
  const selectedTrack = selectedTrackId ? project.tracks.find((item) => item.id === selectedTrackId) : undefined;
  const canSplit = Boolean(selectedClip && !selectedTrack?.locked && currentTime > selectedClip.start && currentTime < selectedClip.start + selectedClip.duration);
  const pasteClipStyle = (targetClip: Clip) => {
    if (!clipStyleClipboard) {
      setNotice(t('timeline.noStyle'));
      return;
    }
    const ids = new Set(selectedClipIds.includes(targetClip.id) ? selectedClipIds : [targetClip.id]);
    mutateProject((draft) => {
      for (const draftTrack of draft.tracks) {
        if (draftTrack.locked) continue;
        for (const draftClip of draftTrack.clips) {
          if (!ids.has(draftClip.id)) continue;
          const style = structuredClone(clipStyleClipboard!.style);
          draftClip.transform = style.transform;
          draftClip.filters = style.filters;
          draftClip.transitionIn = style.transitionIn;
          draftClip.transitionOut = style.transitionOut;
          draftClip.volume = style.volume;
          draftClip.fadeIn = style.fadeIn;
          draftClip.fadeOut = style.fadeOut;
          draftClip.normalize = style.normalize;
          draftClip.mask = style.mask;
          draftClip.crop = style.crop;
          draftClip.keyframes = style.keyframes;
          if ((draftClip.type === 'text' || draftClip.type === 'subtitle') && style.textStyle) draftClip.textStyle = style.textStyle;
        }
      }
    });
    setNotice(t('timeline.stylePasted'));
  };
  const menuItems: ContextMenuItem[] =
    menu?.kind === 'add-track'
      ? [
          {
            label: t('timeline.menu.newLayer'),
            icon: '◫',
            shortcut: 'Ctrl+Shift+L',
            onSelect: addTrack,
          },
          {
            label: t('timeline.menu.addAdjustment'),
            icon: '✦',
            onSelect: addAdjustmentLayer,
          },
        ]
      : menu?.kind === 'empty'
        ? [
            {
              label: t('timeline.menu.newLayerHere'),
              icon: '◫',
              shortcut: 'Ctrl+Shift+L',
              onSelect: () => {
                if (menu.time !== undefined) setCurrentTime(menu.time);
                addTrack();
              },
            },
            {
              label: t('timeline.menu.addAdjustmentHere'),
              icon: '✦',
              onSelect: () => {
                if (menu.time !== undefined) setCurrentTime(menu.time);
                addAdjustmentLayer();
              },
            },
            {
              label: t('timeline.menu.movePlayheadHere'),
              icon: '⌖',
              onSelect: () => {
                if (menu.time !== undefined) setCurrentTime(menu.time);
                closeMenu();
              },
            },
          ]
        : menu?.kind === 'clip' && clip
          ? [
              {
                label: t('timeline.menu.openProperties'),
                icon: '⚙',
                shortcut: 'Enter',
                onSelect: () => {
                  setSelected(clip.id, menu.trackId ?? null);
                  closeMenu();
                },
              },
              {
                label: t('timeline.menu.splitAtPlayhead'),
                icon: '✂',
                shortcut: shortcutValue(settings, 'split'),
                disabled: currentTime <= clip.start || currentTime >= clip.start + clip.duration,
                onSelect: () => splitClip(clip.id),
              },
              {
                label: t('timeline.menu.trimStart'),
                icon: '◁',
                disabled: currentTime <= clip.start || currentTime >= clip.start + clip.duration,
                onSelect: () => trimSelectedClipToPlayhead(clip.id, 'start'),
              },
              {
                label: t('timeline.menu.trimEnd'),
                icon: '▷',
                disabled: currentTime <= clip.start || currentTime >= clip.start + clip.duration,
                onSelect: () => trimSelectedClipToPlayhead(clip.id, 'end'),
              },
              {
                label: t('timeline.menu.duplicate'),
                icon: '⧉',
                onSelect: () => duplicateClip(clip.id),
              },
              {
                label: t('timeline.copyStyle'),
                icon: '◫',
                onSelect: () => {
                  copyClipStyle(clip);
                  setNotice(t('timeline.styleCopied'));
                },
              },
              {
                label: t('timeline.pasteStyle'),
                icon: '◧',
                disabled: !clipStyleClipboard,
                onSelect: () => pasteClipStyle(clip),
              },
              {
                label: t('timeline.menu.copyClipData'),
                icon: '⧉',
                onSelect: () => {
                  void navigator.clipboard?.writeText(JSON.stringify(clip, null, 2));
                  closeMenu();
                },
              },
              {
                label: t('timeline.menu.resetTransform'),
                icon: '⌗',
                onSelect: () => resetClip(clip.id, 'transform'),
              },
              {
                label: t('timeline.menu.resetEffects'),
                icon: '✦',
                onSelect: () => resetClip(clip.id, 'filters'),
              },
              {
                label: t(clip.volume === 0 ? 'timeline.menu.unmute' : 'timeline.menu.mute'),
                icon: '♫',
                onSelect: () =>
                  mutateProject((draft) => {
                    const target = draft.tracks.flatMap((item) => item.clips).find((item) => item.id === clip.id);
                    if (target) target.volume = target.volume === 0 ? 1 : 0;
                  }),
              },
              {
                label: t('timeline.menu.delete'),
                icon: '×',
                danger: true,
                shortcut: 'Del',
                onSelect: () => deleteClip(clip.id),
              },
              {
                label: t('timeline.menu.rippleDelete'),
                icon: '↔',
                danger: true,
                onSelect: () => deleteClip(clip.id, true),
              },
              {
                label: t('timeline.menu.showInMedia'),
                icon: '▧',
                onSelect: () => {
                  setPanel('media');
                  closeMenu();
                },
              },
            ]
          : menu?.kind === 'track' && track
            ? [
                {
                  label: t('timeline.menu.moveUp'),
                  icon: '↑',
                  onSelect: () => moveTrack(track.id, -1),
                },
                {
                  label: t('timeline.menu.moveDown'),
                  icon: '↓',
                  onSelect: () => moveTrack(track.id, 1),
                },
                {
                  label: t('timeline.menu.addAbove'),
                  icon: '＋',
                  onSelect: () => addLayerRelative(track.id, -1),
                },
                {
                  label: t('timeline.menu.addBelow'),
                  icon: '＋',
                  onSelect: () => addLayerRelative(track.id, 1),
                },
                {
                  label: t('timeline.menu.rename'),
                  icon: '✎',
                  onSelect: () => {
                    setEditingTrackId(track.id);
                    setEditingTrackName(track.name);
                    closeMenu();
                  },
                },
                {
                  label: t('timeline.menu.duplicate'),
                  icon: '⧉',
                  onSelect: () => duplicateTrack(track.id),
                },
                {
                  label: t(track.locked ? 'timeline.menu.unlock' : 'timeline.menu.lock'),
                  icon: '♙',
                  onSelect: () => updateTrack(track.id, 'locked'),
                },
                {
                  label: t(track.muted ? 'timeline.menu.unmute' : 'timeline.menu.silence'),
                  icon: '♫',
                  onSelect: () => updateTrack(track.id, 'muted'),
                },
                {
                  label: t(track.hidden ? 'timeline.menu.show' : 'timeline.menu.hide'),
                  icon: '◉',
                  onSelect: () => updateTrack(track.id, 'hidden'),
                },
                {
                  label: t('timeline.menu.delete'),
                  icon: '×',
                  danger: true,
                  onSelect: () => deleteTrack(track.id),
                },
              ]
            : menu?.kind === 'marker' && menu.markerId
              ? [
                  {
                    label: t('timeline.menu.renameMarker'),
                    icon: '✎',
                    onSelect: () => {
                      const marker = project.markers.find((item) => item.id === menu.markerId);
                      if (marker) setRenameMarker({ id: marker.id, label: marker.label });
                      closeMenu();
                    },
                  },
                  {
                    label: t('timeline.menu.deleteMarker'),
                    icon: '×',
                    danger: true,
                    onSelect: () => {
                      mutateProject((draft) => {
                        draft.markers = draft.markers.filter((item) => item.id !== menu.markerId);
                      });
                      closeMenu();
                    },
                  },
                ]
              : [];
  const hasClips = project.tracks.some((item) => item.clips.length > 0);
  // The active implementation below supersedes the removed legacy timeline prototype.
  return (
    <section
      className="timeline timeline-pro"
      onContextMenu={(event) => {
        event.preventDefault();
        const target = event.target as HTMLElement;
        if (target.closest('.timeline-clip,.track-label,.timeline-marker,.context-menu')) return;
        setMenu({
          x: event.clientX,
          y: event.clientY,
          kind: 'empty',
          time: snapTime(timeFromClientX(event.clientX)),
        });
      }}
    >
      <div className="timeline-toolbar">
        <div className="timeline-toolbar-left">
          <span className="timeline-tool-group">
            <button className="timeline-tool active" title={t('timeline.selection')} aria-label={t('timeline.selection')} onClick={() => setSelected(null, null)}>
              <UiIcon name="cursor" />
            </button>
            <button className="timeline-tool" title={canSplit ? t('timeline.split') : t('timeline.splitHint')} aria-label={t('timeline.split')} disabled={!canSplit} onClick={() => selectedClipId && splitClip(selectedClipId)}>
              <UiIcon name="scissors" />
            </button>
          </span>
          <span className="timeline-tool-group">
            <button className="timeline-tool" title={t('common.undo')} aria-label={t('common.undo')} disabled={!canUndo} onClick={undo}>
              <UiIcon name="undo" />
            </button>
            <button className="timeline-tool" title={t('common.redo')} aria-label={t('common.redo')} disabled={!canRedo} onClick={redo}>
              <UiIcon name="redo" />
            </button>
          </span>
          <span className="timeline-tool-group">
            <button className={`timeline-tool snap-toggle ${snapEnabled ? 'active' : ''}`} title={t(snapEnabled ? 'timeline.snapOn' : 'timeline.snapOff')} aria-label={t(snapEnabled ? 'timeline.snapOn' : 'timeline.snapOff')} aria-pressed={snapEnabled} onClick={() => setSnapEnabled((value) => !value)}>
              <UiIcon name={snapEnabled ? 'snap' : 'snapOff'} />
            </button>
            <button className="timeline-tool" title={t('timeline.addMarker')} aria-label={t('timeline.addMarker')} onClick={addMarker}>
              <UiIcon name="marker" />
            </button>
          </span>
          <span className="timeline-tool-group timeline-layer-tools">
            <button
              className="track-add-button"
              onClick={(event) =>
                setMenu({
                  x: event.clientX,
                  y: event.clientY,
                  kind: 'add-track',
                })
              }
            >
              <UiIcon name="plus" /> <span>{t('timeline.addTrack')}</span>
            </button>
          </span>
        </div>
        <div className="timeline-toolbar-right">
          <span className="zoom-label">
            {t('timeline.zoom')} · {Math.round(px)} px/s
          </span>
          <input aria-label={t('timeline.zoom')} type="range" min="38" max="260" value={px} onChange={(event) => setZoom(Number(event.target.value))} />
        </div>
      </div>
      <div className="timeline-fit-row">
        <button className="timeline-fit-button" onClick={fitTimeline}>
          <UiIcon name="fit" /> <span>{t('timeline.fit')}</span>
        </button>
      </div>
      <div
        className="timeline-scroll"
        ref={timelineRef}
        onPointerMove={onPointerMove}
        onPointerUp={finishPointerAssetDrop}
        onPointerCancel={() => {
          setDrag(null);
          setDrop(null);
          setAssetDragId(null);
        }}
      >
        <div className="timeline-head">
          <div className="track-label-spacer" />
          <div className="ruler" onClick={seek}>
            {rulerTicks.map((tick) => (
              <div key={tick} className="ruler-tick" style={{ left: tick * px }}>
                <span>{formatTime(tick).slice(3)}</span>
              </div>
            ))}
            {project.markers.map((marker) => (
              <button
                key={marker.id}
                className="timeline-marker"
                style={{ left: marker.time * px }}
                title={`${marker.label} · ${formatTime(marker.time, true, project.canvas.fps)}`}
                onClick={(event) => {
                  event.stopPropagation();
                  setCurrentTime(marker.time);
                }}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  setCurrentTime(marker.time);
                  setDrag({ kind: 'marker', markerId: marker.id });
                  event.currentTarget.setPointerCapture(event.pointerId);
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setMenu({
                    x: event.clientX,
                    y: event.clientY,
                    kind: 'marker',
                    markerId: marker.id,
                  });
                }}
              >
                <i />
                <span>{marker.label}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="timeline-content">
          <div className="track-labels">
            {project.tracks.map((item) => (
              <div
                className={`track-label ${item.hidden ? 'is-hidden' : ''} ${item.muted ? 'is-muted' : ''}`}
                key={item.id}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setMenu({
                    x: event.clientX,
                    y: event.clientY,
                    kind: 'track',
                    trackId: item.id,
                  });
                }}
              >
                {editingTrackId === item.id ? (
                  <input
                    className="track-name-input"
                    autoFocus
                    value={editingTrackName}
                    onChange={(event) => setEditingTrackName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        mutateProject((draft) => {
                          const target = draft.tracks.find((track) => track.id === item.id);
                          if (target && editingTrackName.trim()) target.name = editingTrackName.trim();
                        });
                        setEditingTrackId(null);
                      }
                      if (event.key === 'Escape') setEditingTrackId(null);
                    }}
                    onBlur={() => setEditingTrackId(null)}
                  />
                ) : (
                  <>
                    <span className={`track-type track-type-${item.type}`} aria-hidden="true">
                      {item.type === 'audio' ? 'A' : item.type === 'text' ? 'T' : item.type === 'subtitle' ? 'S' : item.type === 'overlay' ? 'O' : 'V'}
                    </span>
                    <span className="track-name" title={item.name}>
                      {language === 'tr' ? item.name.replace(/^Layer (\d+)$/, 'Katman $1') : item.name}
                    </span>
                  </>
                )}
                <span className="track-status-strip">
                  {item.hidden && <i className="track-status is-hidden" title={t('timeline.menu.hide')} />}
                  {item.muted && <i className="track-status is-muted" title={t('timeline.menu.silence')} />}
                  {item.locked && <i className="track-status is-locked" title={t('timeline.menu.lock')} />}
                </span>
                <div className="track-actions">
                  <button
                    className="track-menu-button"
                    title={t('timeline.trackOptions')}
                    aria-label={t('timeline.trackOptions')}
                    onClick={(event) =>
                      setMenu({
                        x: event.clientX,
                        y: event.clientY,
                        kind: 'track',
                        trackId: item.id,
                      })
                    }
                  >
                    <span className="track-menu-dots" aria-hidden="true">
                      <i />
                      <i />
                      <i />
                    </span>
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div className="tracks-canvas" onClick={seek}>
            {!hasClips && (
              <div className="timeline-empty-guide">
                <span aria-hidden="true">＋</span>
                <div>
                  <strong>{t('timeline.emptyTitle')}</strong>
                  <small>{t('timeline.emptyCopy')}</small>
                </div>
              </div>
            )}
            <div
              className="playhead"
              style={{ left: currentTime * px }}
              onPointerDown={(event) => {
                event.stopPropagation();
                setDrag({ kind: 'playhead' });
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
            >
              <div className="playhead-cap" />
            </div>
            {project.tracks.map((item) => (
              <div
                data-track-id={item.id}
                className={`track-row ${item.locked ? 'locked' : ''} ${item.hidden ? 'is-hidden' : ''} ${drop?.trackId === item.id ? 'drop-target' : ''}`}
                key={item.id}
                onDragOver={(event) => {
                  if (event.dataTransfer.types.includes('application/x-cutloc-asset')) {
                    event.preventDefault();
                    setDrop({
                      trackId: item.id,
                      time: snapTime(timeFromClientX(event.clientX)),
                    });
                  }
                }}
                onDragLeave={() => setDrop((current) => (current?.trackId === item.id ? null : current))}
                onDrop={(event) => dropAsset(event, item)}
              >
                {drop?.trackId === item.id && <div className="drop-ghost" title={draggedAsset ? `${draggedAsset.name} · ${formatTime(Math.max(draggedAsset.duration || 5, 0.5))}` : undefined} style={{ left: drop.time * px, width: dropGhostWidth }} />}
                {item.clips.map((itemClip) => (
                  <div
                    key={itemClip.id}
                    role="button"
                    tabIndex={item.locked ? -1 : 0}
                    aria-pressed={selectedClipIds.includes(itemClip.id)}
                    aria-disabled={item.locked}
                    aria-label={`${itemClip.name}, ${formatTime(itemClip.duration)}`}
                    className={`timeline-clip clip-${itemClip.type} ${selectedClipIds.includes(itemClip.id) ? 'selected' : ''} ${item.locked ? 'disabled' : ''}`}
                    style={{
                      left: itemClip.start * px,
                      width: Math.max(36, itemClip.duration * px),
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return;
                      event.preventDefault();
                      event.stopPropagation();
                      if (event.shiftKey || event.ctrlKey || event.metaKey) toggleSelected(itemClip.id, item.id);
                      else setSelected(itemClip.id, item.id);
                    }}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (event.shiftKey || event.ctrlKey || event.metaKey) toggleSelected(itemClip.id, item.id);
                      else if (selectedClipIds.length <= 1 || !selectedClipIds.includes(itemClip.id)) setSelected(itemClip.id, item.id);
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setSelected(itemClip.id, item.id);
                      setMenu({
                        x: event.clientX,
                        y: event.clientY,
                        kind: 'clip',
                        clipId: itemClip.id,
                        trackId: item.id,
                      });
                    }}
                    onPointerDown={(event) => {
                      event.stopPropagation();
                      if (item.locked) return;
                      if (event.shiftKey || event.ctrlKey || event.metaKey) {
                        return;
                      }
                      if (!selectedClipIds.includes(itemClip.id)) setSelected(itemClip.id, item.id);
                      const selectedIds = selectedClipIds.includes(itemClip.id) ? selectedClipIds : [itemClip.id];
                      const selectedStarts = Object.fromEntries(
                        project.tracks
                          .flatMap((track) => track.clips)
                          .filter((clip) => selectedIds.includes(clip.id))
                          .map((clip) => [clip.id, clip.start]),
                      );
                      const historyGroup = newHistoryGroup();
                      dragHistoryGroupRef.current = historyGroup;
                      setDrag({
                        kind: 'clip',
                        clipId: itemClip.id,
                        trackId: item.id,
                        startX: event.clientX,
                        start: itemClip.start,
                        selectedClipIds: selectedIds,
                        selectedClipStarts: selectedStarts,
                        historyGroup,
                      });
                      event.currentTarget.setPointerCapture(event.pointerId);
                    }}
                  >
                    <div className="clip-handle left" />
                    <div className="clip-body">
                      <span className="clip-icon">{clipTypeIcon(itemClip)}</span>
                      <strong>{itemClip.name}</strong>
                      <small>{formatTime(itemClip.duration)}</small>
                    </div>
                    <div className="clip-handle right" />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={closeMenu} />}
      {renameMarker && (
        <PromptDialog
          title={t('timeline.menu.renameMarker')}
          label={t('timeline.markerNamePrompt')}
          initialValue={renameMarker.label || t('timeline.markerFallback')}
          confirmLabel={t('common.save')}
          onConfirm={(value) => {
            const markerId = renameMarker.id;
            mutateProject((draft) => {
              const target = draft.markers.find((item) => item.id === markerId);
              if (target) target.label = value;
            });
            setRenameMarker(null);
          }}
          onClose={() => setRenameMarker(null)}
        />
      )}
    </section>
  );
}
