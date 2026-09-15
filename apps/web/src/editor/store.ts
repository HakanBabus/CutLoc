import { create } from 'zustand';
import { produce } from 'immer';
import { clamp, enforceLockedTrackInvariants, mergeProjectThreeWay, type Job, type Project, type Settings, type ShortcutSettings, type WorkspaceLayout } from '@cutloc/shared';
import type { TranslationKey } from '../i18n';

export type Theme = 'dark' | 'gray' | 'light';
export type Panel = 'media' | 'text' | 'elements' | 'project' | 'transitions' | 'effects' | 'color' | 'animation';
export type InspectorTab = 'primary' | 'audio' | 'speed' | 'motion' | 'adjust';
export type TrashEntry = { trashId: string; projectId: string; name: string; createdAt: string; updatedAt: string; deletedAt: string; expiresAt: string; duration: number; assetCount: number; sizeBytes: number };
type HistoryState = { past: Project[]; future: Project[] };
type HistoryMutationOptions = { historyGroup?: string };
export type ShortcutAction = keyof ShortcutSettings;
export type StockMediaItem = { id: string; name: string; description: string; category: 'solid' | 'soft' | 'texture'; mimeType: string; width: number; height: number };
export type SaveState = 'saved' | 'saving' | 'error' | 'offline';
type ExportUiStatus = Job['status'] | 'reconnecting' | 'preflight' | 'saving';
export type ExportStatus = { jobId?: string; status?: ExportUiStatus; progress: number; message?: string; downloadUrl?: string; fileName?: string; error?: string };

export const DEFAULT_SHORTCUTS: ShortcutSettings = {
  togglePlayback: 'Space',
  undo: 'Ctrl/Cmd+Z',
  redo: 'Ctrl/Cmd+Shift+Z',
  split: 'B',
  setIn: 'I',
  setOut: 'O',
  clearRange: 'X',
  deleteClip: 'Delete',
  duplicate: 'Ctrl/Cmd+D',
  selectAll: 'Ctrl/Cmd+A',
};

export const DEFAULT_WORKSPACE_LAYOUT: WorkspaceLayout = {
  railWidth: 56,
  libraryWidth: 270,
  inspectorWidth: 304,
  timelineHeight: 265,
};

export const SHORTCUT_LABELS: Record<ShortcutAction, { labelKey: TranslationKey; descriptionKey: TranslationKey }> = {
  togglePlayback: { labelKey: 'shortcut.togglePlayback.label', descriptionKey: 'shortcut.togglePlayback.description' },
  undo: { labelKey: 'shortcut.undo.label', descriptionKey: 'shortcut.undo.description' },
  redo: { labelKey: 'shortcut.redo.label', descriptionKey: 'shortcut.redo.description' },
  split: { labelKey: 'shortcut.split.label', descriptionKey: 'shortcut.split.description' },
  setIn: { labelKey: 'shortcut.setIn.label', descriptionKey: 'shortcut.setIn.description' },
  setOut: { labelKey: 'shortcut.setOut.label', descriptionKey: 'shortcut.setOut.description' },
  clearRange: { labelKey: 'shortcut.clearRange.label', descriptionKey: 'shortcut.clearRange.description' },
  deleteClip: { labelKey: 'shortcut.deleteClip.label', descriptionKey: 'shortcut.deleteClip.description' },
  duplicate: { labelKey: 'shortcut.duplicate.label', descriptionKey: 'shortcut.duplicate.description' },
  selectAll: { labelKey: 'shortcut.selectAll.label', descriptionKey: 'shortcut.selectAll.description' },
};

export const STOCK_MEDIA: StockMediaItem[] = [
  { id: 'white', name: 'White surface', description: 'Clean and bright', category: 'solid', mimeType: 'image/png', width: 1600, height: 900 },
  { id: 'black', name: 'Black surface', description: 'Simple and cinematic', category: 'solid', mimeType: 'image/png', width: 1600, height: 900 },
  { id: 'sage', name: 'Sage', description: 'Soft green', category: 'soft', mimeType: 'image/png', width: 1600, height: 900 },
  { id: 'sunset', name: 'Sunset', description: 'Warm colors', category: 'soft', mimeType: 'image/png', width: 1600, height: 900 },
  { id: 'paper', name: 'Paper', description: 'Neutral texture', category: 'texture', mimeType: 'image/png', width: 1600, height: 900 },
  { id: 'neon-grid', name: 'Neon grid', description: 'Tech accent', category: 'texture', mimeType: 'image/png', width: 1600, height: 900 },
];

export function localizeStockMedia(stock: StockMediaItem, t: (key: TranslationKey) => string): StockMediaItem {
  return { ...stock, name: t(`preset.stock.${stock.id}.label` as TranslationKey), description: t(`preset.stock.${stock.id}.description` as TranslationKey) };
}
type EditorState = {
  project: Project | null;
  settings: Settings | null;
  selectedClipId: string | null;
  selectedClipIds: string[];
  selectedTrackId: string | null;
  currentTime: number;
  rangeStart: number | null;
  rangeEnd: number | null;
  assetDragId: string | null;
  playing: boolean;
  pxPerSecond: number;
  panel: Panel;
  inspectorTab: InspectorTab;
  theme: Theme;
  saveState: SaveState;
  localRevision: number;
  savedRevision: number;
  lastSavedAt: string | null;
  lastSavedProject: Project | null;
  notice: string;
  history: HistoryState;
  historyGroup: string | null;
  setProject: (project: Project, resetHistory?: boolean) => void;
  setSettings: (settings: Settings) => void;
  setCurrentTime: (time: number) => void;
  setRangeStart: (time: number | null) => void;
  setRangeEnd: (time: number | null) => void;
  setAssetDragId: (assetId: string | null) => void;
  clearRange: () => void;
  setPlaying: (playing: boolean) => void;
  setPanel: (panel: Panel) => void;
  setInspectorTab: (tab: InspectorTab) => void;
  setTheme: (theme: Theme) => void;
  setSelected: (clipId: string | null, trackId?: string | null) => void;
  setSelectedMany: (clipIds: string[], trackId?: string | null) => void;
  toggleSelected: (clipId: string, trackId?: string | null) => void;
  setZoom: (zoom: number) => void;
  mutateProject: (recipe: (draft: Project) => void, options?: HistoryMutationOptions) => void;
  applyServerProject: (project: Project) => void;
  acknowledgeSaved: (project: Project, snapshot: Project) => void;
  undo: () => void;
  redo: () => void;
  setSaveState: (state: EditorState['saveState']) => void;
  setNotice: (notice: string) => void;
};

function initialTheme(): Theme {
  try {
    // Keep the previous key as a read-only migration source so existing users retain their theme.
    const saved = window.localStorage.getItem('cutloc-theme') ?? window.localStorage.getItem('local-cut-theme');
    if (saved === 'light' || saved === 'gray' || saved === 'dark') return saved;
  } catch {
    // Local storage can be unavailable in private or embedded contexts.
  }
  return 'dark';
}

export function shortcutValue(settings: Settings | null, action: ShortcutAction) {
  return settings?.shortcuts?.[action] || DEFAULT_SHORTCUTS[action];
}

export function matchesShortcut(event: KeyboardEvent, binding: string) {
  const parts = binding.toLocaleLowerCase('en-US').replaceAll('⌘', 'cmd').replaceAll(' ', '').split('+').filter(Boolean);
  const key = parts.at(-1) ?? '';
  const hasCtrlOrMeta = parts.includes('ctrl/cmd') || parts.includes('cmd') || parts.includes('meta') || parts.includes('command');
  const hasCtrl = parts.includes('ctrl') || hasCtrlOrMeta;
  const hasShift = parts.includes('shift');
  const hasAlt = parts.includes('alt') || parts.includes('option');
  if (hasCtrl !== (event.ctrlKey || event.metaKey)) return false;
  if (hasShift !== event.shiftKey || hasAlt !== event.altKey) return false;
  if (key === 'space') return event.code === 'Space';
  if (key === 'delete' || key === 'backspace') return event.key.toLocaleLowerCase('en-US') === key;
  if (key === 'escape' || key === 'esc') return event.key === 'Escape';
  return event.key.toLocaleLowerCase('en-US') === key;
}

export const useEditor = create<EditorState>((set) => ({
  project: null,
  settings: null,
  selectedClipId: null,
  selectedClipIds: [],
  selectedTrackId: null,
  currentTime: 0,
  rangeStart: null,
  rangeEnd: null,
  assetDragId: null,
  playing: false,
  pxPerSecond: 92,
  panel: 'media',
  inspectorTab: 'primary',
  theme: initialTheme(),
  saveState: 'saved',
  localRevision: 0,
  savedRevision: 0,
  lastSavedAt: null,
  lastSavedProject: null,
  notice: '',
  history: { past: [], future: [] },
  historyGroup: null,
  setProject: (project, resetHistory = true) => set((state) => resetHistory
    ? { project, localRevision: project.revision, savedRevision: project.revision, lastSavedAt: project.updatedAt, lastSavedProject: project, saveState: 'saved', history: { past: [], future: [] }, historyGroup: null, selectedClipId: null, selectedClipIds: [], selectedTrackId: null, currentTime: 0, rangeStart: null, rangeEnd: null, assetDragId: null, inspectorTab: 'primary' }
    : { ...state, project, localRevision: Math.max(state.localRevision, project.revision), savedRevision: Math.max(state.savedRevision, project.revision), lastSavedAt: project.updatedAt, lastSavedProject: project }),
  setSettings: (settings) => set({ settings }),
  setCurrentTime: (time) => set((state) => ({ currentTime: clamp(time, 0, state.project?.duration ?? 0) })),
  setRangeStart: (rangeStart) => set((state) => ({ rangeStart: rangeStart === null ? null : clamp(rangeStart, 0, state.project?.duration ?? 0) })),
  setRangeEnd: (rangeEnd) => set((state) => ({ rangeEnd: rangeEnd === null ? null : clamp(rangeEnd, 0, state.project?.duration ?? 0) })),
  setAssetDragId: (assetDragId) => set({ assetDragId }),
  clearRange: () => set({ rangeStart: null, rangeEnd: null }),
  setPlaying: (playing) => set({ playing }),
  setPanel: (panel) => set({ panel }),
  setInspectorTab: (inspectorTab) => set({ inspectorTab }),
  setTheme: (theme) => {
    try { window.localStorage.setItem('cutloc-theme', theme); } catch { /* ignore */ }
    set({ theme });
  },
  setSelected: (selectedClipId, selectedTrackId = null) => set({ selectedClipId, selectedClipIds: selectedClipId ? [selectedClipId] : [], selectedTrackId }),
  setSelectedMany: (selectedClipIds, selectedTrackId = null) => set({ selectedClipIds, selectedClipId: selectedClipIds.at(-1) ?? null, selectedTrackId }),
  toggleSelected: (clipId, trackId = null) => set((state) => {
    const selectedClipIds = state.selectedClipIds.includes(clipId)
      ? state.selectedClipIds.filter((id) => id !== clipId)
      : [...state.selectedClipIds, clipId];
    return { selectedClipIds, selectedClipId: selectedClipIds.at(-1) ?? null, selectedTrackId: selectedClipIds.length ? trackId : null };
  }),
  setZoom: (pxPerSecond) => set({ pxPerSecond: clamp(pxPerSecond, 20, 260) }),
  mutateProject: (recipe, options) => set((state) => {
    const previousProject = state.project;
    if (!previousProject) return state;
    let next = produce(previousProject, recipe);
    // A track lock is a project-level contract, not a collection of UI hints.
    // Keep the complete track snapshot (identity, order, name and content),
    // while still allowing the track's own lock toggle to unlock it.
    const lockedTracks = previousProject.tracks.filter((track) => track.locked);
    if (lockedTracks.length) {
      next = enforceLockedTrackInvariants(previousProject, next);
    }
    // Immer returns the original reference for ordinary no-ops.  The equality
    // check also catches operations rejected by the lock contract above.
    if (next === previousProject || JSON.stringify(next) === JSON.stringify(previousProject)) return state;
    const grouped = Boolean(options?.historyGroup && options.historyGroup === state.historyGroup);
    return {
      project: next,
      history: grouped ? { ...state.history, future: [] } : { past: [...state.history.past.slice(-49), previousProject], future: [] },
      historyGroup: options?.historyGroup ?? null,
      localRevision: Math.max(state.localRevision, state.savedRevision) + 1,
      saveState: typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'saving',
    };
  }),
  undo: () => set((state) => {
    const previous = state.history.past.at(-1);
    if (!previous || !state.project) return state;
    return { project: previous, history: { past: state.history.past.slice(0, -1), future: [state.project, ...state.history.future] }, historyGroup: null, localRevision: Math.max(state.localRevision, state.savedRevision) + 1, saveState: typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'saving' };
  }),
  redo: () => set((state) => {
    const next = state.history.future[0];
    if (!next || !state.project) return state;
    return { project: next, history: { past: [...state.history.past, state.project], future: state.history.future.slice(1) }, historyGroup: null, localRevision: Math.max(state.localRevision, state.savedRevision) + 1, saveState: typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'saving' };
  }),
  setSaveState: (saveState) => set({ saveState }),
  applyServerProject: (serverProject) => set((state) => {
    const wasDirty = state.localRevision !== state.savedRevision;
    const project = wasDirty && state.project
      ? mergeProjectThreeWay(state.lastSavedProject ?? state.project, state.project, serverProject).project
      : serverProject;
    if (wasDirty) {
      // A server refresh can contain newer asset/proxy metadata without
      // containing the local timeline edit that is still waiting for
      // autosave.  It must never advance savedRevision: only a successful
      // acknowledgement of our own PATCH may do that.
      return {
        project,
        localRevision: state.localRevision,
        savedRevision: state.savedRevision,
        lastSavedAt: state.lastSavedAt,
        saveState: 'saving',
      };
    }
    return {
      project,
      localRevision: serverProject.revision,
      savedRevision: serverProject.revision,
      lastSavedAt: serverProject.updatedAt,
      lastSavedProject: serverProject,
      saveState: 'saved',
    };
  }),
  acknowledgeSaved: (project, snapshot) => set((state) => {
    const isLatestLocalSnapshot = state.project === snapshot;
    return {
      project: isLatestLocalSnapshot || !state.project
        ? project
        : { ...state.project, revision: project.revision, updatedAt: state.project.updatedAt },
      localRevision: isLatestLocalSnapshot ? project.revision : Math.max(state.localRevision, project.revision),
      savedRevision: project.revision,
      lastSavedAt: project.updatedAt,
      lastSavedProject: project,
      saveState: isLatestLocalSnapshot ? 'saved' : 'saving',
    };
  }),
  setNotice: (notice) => set({ notice }),
}));
