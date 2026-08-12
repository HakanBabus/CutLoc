import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { produce } from 'immer';
import {
  clamp,
  defaultProject,
  exportDimensions,
  interpolateKeyframes,
  projectDuration,
  parseTimelineTimecode,
  quantizeFrameTime,
  retimeClipMotion,
  rippleDeleteAcrossTimeline,
  sourceTimeAt,
  speedAt,
  snapTime as snapProjectTime,
  sliceClipForRange,
  splitClipAt,
  timelineDurationForSourceDuration,
  trimClip,
  trimClipToPlayhead,
  type ExportOptions,
  type ExportPreflight,
  type ExportJobResult,
  type Job,
  formatTime,
  type Asset,
  type CanvasAspect,
  type Clip,
  type Project,
  type Settings,
  type ShortcutSettings,
  type Track,
  type WorkspaceLayout,
} from '@cutloc/shared';
import './styles.css';
import './preview-redesign.css';
import './product-refresh.css';
import { I18nProvider, translate, useI18n, type TranslationKey } from './i18n';

type Theme = 'dark' | 'gray' | 'light';
type Panel = 'media' | 'text' | 'project' | 'transitions' | 'effects' | 'color' | 'animation' | 'help';
type TrashEntry = { trashId: string; projectId: string; name: string; createdAt: string; updatedAt: string; deletedAt: string; duration: number; assetCount: number };
type HistoryState = { past: Project[]; future: Project[] };
type HistoryMutationOptions = { historyGroup?: string };
type ShortcutAction = keyof ShortcutSettings;
type StockMediaItem = { id: string; name: string; description: string; category: 'solid' | 'soft' | 'texture'; mimeType: string; width: number; height: number };
type SaveState = 'saved' | 'saving' | 'error' | 'offline';
type ExportUiStatus = Job['status'] | 'reconnecting' | 'preflight' | 'saving';
type ExportStatus = { jobId?: string; status?: ExportUiStatus; progress: number; message?: string; downloadUrl?: string; fileName?: string; error?: string };

const DEFAULT_SHORTCUTS: ShortcutSettings = {
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

const DEFAULT_WORKSPACE_LAYOUT: WorkspaceLayout = {
  railWidth: 56,
  libraryWidth: 270,
  inspectorWidth: 304,
  timelineHeight: 265,
};

const SHORTCUT_LABELS: Record<ShortcutAction, { labelKey: TranslationKey; descriptionKey: TranslationKey }> = {
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

const STOCK_MEDIA: StockMediaItem[] = [
  { id: 'white', name: 'White surface', description: 'Clean and bright', category: 'solid', mimeType: 'image/png', width: 1600, height: 900 },
  { id: 'black', name: 'Black surface', description: 'Simple and cinematic', category: 'solid', mimeType: 'image/png', width: 1600, height: 900 },
  { id: 'sage', name: 'Sage', description: 'Soft green', category: 'soft', mimeType: 'image/png', width: 1600, height: 900 },
  { id: 'sunset', name: 'Sunset', description: 'Warm colors', category: 'soft', mimeType: 'image/png', width: 1600, height: 900 },
  { id: 'paper', name: 'Paper', description: 'Neutral texture', category: 'texture', mimeType: 'image/png', width: 1600, height: 900 },
  { id: 'neon-grid', name: 'Neon grid', description: 'Tech accent', category: 'texture', mimeType: 'image/png', width: 1600, height: 900 },
];

function localizeStockMedia(stock: StockMediaItem, t: (key: TranslationKey) => string): StockMediaItem {
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
  theme: Theme;
  saveState: SaveState;
  localRevision: number;
  savedRevision: number;
  lastSavedAt: string | null;
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

function shortcutValue(settings: Settings | null, action: ShortcutAction) {
  void settings;
  return DEFAULT_SHORTCUTS[action];
}

function matchesShortcut(event: KeyboardEvent, binding: string) {
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

const useEditor = create<EditorState>((set) => ({
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
  theme: initialTheme(),
  saveState: 'saved',
  localRevision: 0,
  savedRevision: 0,
  lastSavedAt: null,
  notice: '',
  history: { past: [], future: [] },
  historyGroup: null,
  setProject: (project, resetHistory = true) => set((state) => resetHistory
    ? { project, localRevision: project.revision, savedRevision: project.revision, lastSavedAt: project.updatedAt, saveState: 'saved', history: { past: [], future: [] }, historyGroup: null, selectedClipId: null, selectedClipIds: [], selectedTrackId: null, currentTime: 0, rangeStart: null, rangeEnd: null, assetDragId: null }
    : { ...state, project, localRevision: Math.max(state.localRevision, project.revision), savedRevision: Math.max(state.savedRevision, project.revision), lastSavedAt: project.updatedAt }),
  setSettings: (settings) => set({ settings }),
  setCurrentTime: (time) => set((state) => ({ currentTime: clamp(time, 0, state.project?.duration ?? 0) })),
  setRangeStart: (rangeStart) => set((state) => ({ rangeStart: rangeStart === null ? null : clamp(rangeStart, 0, state.project?.duration ?? 0) })),
  setRangeEnd: (rangeEnd) => set((state) => ({ rangeEnd: rangeEnd === null ? null : clamp(rangeEnd, 0, state.project?.duration ?? 0) })),
  setAssetDragId: (assetDragId) => set({ assetDragId }),
  clearRange: () => set({ rangeStart: null, rangeEnd: null }),
  setPlaying: (playing) => set({ playing }),
  setPanel: (panel) => set({ panel }),
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
    if (!state.project) return state;
    const next = produce(state.project, recipe);
    const grouped = Boolean(options?.historyGroup && options.historyGroup === state.historyGroup);
    return {
      project: next,
      history: grouped ? { ...state.history, future: [] } : { past: [...state.history.past.slice(-49), state.project], future: [] },
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
  applyServerProject: (project) => set((state) => {
    const wasDirty = state.localRevision !== state.savedRevision;
    return {
      project,
      localRevision: wasDirty ? Math.max(state.localRevision, project.revision) + 1 : project.revision,
      savedRevision: project.revision,
      lastSavedAt: project.updatedAt,
      saveState: wasDirty ? 'saving' : 'saved',
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
      saveState: isLatestLocalSnapshot ? 'saved' : 'saving',
    };
  }),
  setNotice: (notice) => set({ notice }),
}));

class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

const api = async <T,>(url: string, init?: RequestInit): Promise<T> => {
  const headers = new Headers(init?.headers);
  const language = document.documentElement.lang === 'tr' ? 'tr' : 'en';
  if (!headers.has('Accept-Language')) headers.set('Accept-Language', language);
  if (init?.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(url, { ...init, headers });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ApiError(body.error || translate(language, 'common.requestFailed', { status: response.status }), response.status, body);
  }
  return response.json() as Promise<T>;
};

/**
 * Media import responses contain a server snapshot.  Replacing the local
 * project with that snapshot resets the playhead/selection and can discard an
 * edit that is still waiting for autosave.  Reconcile only the asset library
 * and server metadata; the local timeline remains the source of truth.
 */
function mergeImportedProject(local: Project, server: Project): Project {
  const localAssets = local.assets;
  const mergedAssets = server.assets.map((serverAsset) => {
    const localAsset = localAssets.find((asset) => asset.id === serverAsset.id);
    return localAsset ? { ...localAsset, ...serverAsset } : serverAsset;
  });
  mergedAssets.push(...localAssets.filter((asset) => !server.assets.some((serverAsset) => serverAsset.id === asset.id)));
  return {
    ...server,
    name: local.name,
    canvas: local.canvas,
    tracks: local.tracks,
    markers: local.markers,
    duration: Math.max(local.duration, projectDuration(local)),
    assets: mergedAssets,
  };
}

function Glyph({ children }: { children: string }) { return <span className="glyph" aria-hidden="true">{children}</span>; }

function ConfirmDialog({ title, message, confirmLabel, onConfirm, onClose }: { title: string; message: string; confirmLabel: string; onConfirm: () => void; onClose: () => void }) {
  const { t } = useI18n();
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-title"><div className="modal-head"><div><p className="eyebrow">{t('confirm.eyebrow')}</p><h2 id="confirm-dialog-title">{title}</h2></div><button onClick={onClose} aria-label={t('common.close')}>×</button></div><p>{message}</p><div className="modal-actions"><button className="secondary-button" onClick={onClose}>{t('common.cancel')}</button><button className="primary-button danger-button" onClick={onConfirm}>{confirmLabel}</button></div></section></div>;
}

type ContextMenuItem = {
  label: string;
  icon?: string;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
};

function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: ContextMenuItem[]; onClose: () => void }) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  useEffect(() => {
    const closeOnPointer = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) onClose(); };
    const closeOnKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('pointerdown', closeOnPointer);
    document.addEventListener('keydown', closeOnKey);
    return () => { document.removeEventListener('pointerdown', closeOnPointer); document.removeEventListener('keydown', closeOnKey); };
  }, [onClose]);
  useEffect(() => {
    const element = menuRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const gutter = 8;
    setPosition({
      left: Math.max(gutter, Math.min(x, window.innerWidth - rect.width - gutter)),
      top: Math.max(gutter, Math.min(y, window.innerHeight - rect.height - gutter)),
    });
  }, [x, y, items.length]);
  const portalTarget = document.querySelector('.i18n-root') ?? document.body;
  return createPortal(<div ref={menuRef} className="context-menu" role="menu" style={{ left: position.left, top: position.top }} onPointerDown={(event) => event.stopPropagation()}>
    {items.map((item, index) => <button key={`${item.label}-${index}`} className={item.danger ? 'danger' : ''} disabled={item.disabled} role="menuitem" onClick={() => { onClose(); item.onSelect(); }}><span className="context-menu-icon">{item.icon ?? '•'}</span><span>{item.label}</span>{item.shortcut && <kbd>{item.shortcut}</kbd>}</button>)}
  </div>, portalTarget);
}

function App() {
  const { t } = useI18n();
  const [screen, setScreen] = useState<'dashboard' | 'editor'>('dashboard');
  const [screenTransition, setScreenTransition] = useState<'idle' | 'exit' | 'enter'>('idle');
  const [projects, setProjects] = useState<Project[]>([]);
  const [trash, setTrash] = useState<TrashEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [deleteCandidate, setDeleteCandidate] = useState<Project | null>(null);
  const project = useEditor((state) => state.project);
  const setProject = useEditor((state) => state.setProject);
  const setSettings = useEditor((state) => state.setSettings);
  const theme = useEditor((state) => state.theme);

  const transitionTo = (nextScreen: 'dashboard' | 'editor') => {
    if (nextScreen === screen) return;
    setScreenTransition('exit');
    window.setTimeout(() => {
      setScreen(nextScreen);
      setScreenTransition('enter');
      window.setTimeout(() => setScreenTransition('idle'), 620);
    }, 180);
  };

  useEffect(() => {
    void Promise.all([
      api<Project[]>('/api/projects'),
      api<Settings>('/api/settings'),
      api<TrashEntry[]>('/api/trash'),
    ]).then(([list, settings, trashList]) => {
      setProjects(list);
      setSettings(settings);
      setTrash(trashList);
    }).catch((error: unknown) => setNotice(error instanceof Error ? error.message : t('dashboard.serverUnavailable'))).finally(() => setLoading(false));
  }, [setSettings]);

  const openProject = async (id: string) => {
    try {
      const loaded = await api<Project>(`/api/projects/${id}`);
      const normalized = normalizeProjectDurations(loaded);
      const ready = normalized === loaded ? loaded : await api<Project>(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify(normalized) }).catch(() => normalized);
      setProject(ready);
      transitionTo('editor');
    } catch (error) { setNotice(error instanceof Error ? error.message : t('dashboard.openFailed')); }
  };

  const createProject = async () => {
    try {
      const created = await api<Project>('/api/projects', { method: 'POST', body: JSON.stringify({ name: t('project.defaultName') }) });
      setProjects((items) => [created, ...items]);
      setProject(created);
      transitionTo('editor');
    } catch (error) { setNotice(error instanceof Error ? error.message : t('dashboard.createFailed')); }
  };

  const importBundle = async (bundle: unknown) => {
    try {
      let imported: Project;
      if (typeof File !== 'undefined' && bundle instanceof File) {
        const language = document.documentElement.lang === 'tr' ? 'tr' : 'en';
        const response = await fetch('/api/projects/import', { method: 'POST', headers: { 'Accept-Language': language, 'Content-Type': 'application/zip' }, body: bundle });
        const body = await response.json().catch(() => ({})) as { error?: string };
        if (!response.ok) throw new Error(body.error || t('dashboard.importFailed'));
        imported = body as Project;
      } else {
        imported = await api<Project>('/api/projects/import', { method: 'POST', body: JSON.stringify(bundle) });
      }
      setProjects((items) => [imported, ...items]);
      setProject(imported);
      transitionTo('editor');
    } catch (error) { setNotice(error instanceof Error ? error.message : t('dashboard.importFailed')); }
  };

  const requestDeleteProject = (id: string) => { const candidate = projects.find((item) => item.id === id); if (candidate) setDeleteCandidate(candidate); };
  const startWithMedia = async (file: File) => {
    try {
      const created = await api<Project>('/api/projects', { method: 'POST', body: JSON.stringify({ name: file.name.replace(/\.[^.]+$/, '') || 'Yeni proje' }) });
      const form = new FormData();
      form.append('file', file);
      const response = await fetch('/api/projects/' + created.id + '/media', { method: 'POST', body: form });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error || 'Medya import edilemedi');
      }
      const result = await response.json() as { asset: Asset; project: Project };
      setProjects((items) => [result.project, ...items.filter((item) => item.id !== result.project.id)]);
      setProject(result.project);
      const placement = findEmptyPlacement(result.project, Math.max(result.asset.duration || 5, 0.5), 0);
      const clip = createMediaClip(result.asset, placement.start);
      let targetId = placement.trackId;
      useEditor.getState().mutateProject((draft) => {
        const destination = targetId ? draft.tracks.find((track) => track.id === targetId) : undefined;
        const track = destination && !destination.locked ? destination : createLayerTrack(draft);
        targetId = track.id;
        track.clips.push(clip);
        draft.duration = projectDuration(draft);
      });
      useEditor.getState().setSelected(clip.id, targetId);
      useEditor.getState().setPanel('media');
      useEditor.getState().setNotice('Medya haz\u0131r: ' + result.asset.name + ' timeline\x27a eklendi.');
      transitionTo('editor');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Medya ba\u015flat\u0131lamad\u0131');
    }
  };


/* Legacy requestDelete body retained only for reference.
    const candidate = projects.find((item) => item.id === id);
    if (candidate) setDeleteCandidate(candidate);
*/

  const deleteProject = async () => {
    const candidate = deleteCandidate;
    if (!candidate) return;
    setDeleteCandidate(null);
    try {
      await api(`/api/projects/${candidate.id}`, { method: 'DELETE' });
      setProjects((items) => items.filter((item) => item.id !== candidate.id));
      setTrash(await api<TrashEntry[]>('/api/trash'));
    }
    catch (error) { setNotice(error instanceof Error ? error.message : t('dashboard.deleteFailed')); }
  };

  const restoreTrash = async (trashId: string) => {
    const entry = trash.find((item) => item.trashId === trashId);
    if (!entry || !window.confirm(t('dashboard.restoreConfirm', { name: entry.name }))) return;
    try {
      const restored = await api<Project>('/api/trash/' + encodeURIComponent(trashId) + '/restore', { method: 'POST', body: JSON.stringify({}) });
      setProjects((items) => [restored, ...items]);
      setTrash((items) => items.filter((item) => item.trashId !== trashId));
      setNotice(t('dashboard.restored'));
    } catch (error) { setNotice(error instanceof Error ? error.message : t('dashboard.restoreFailed')); }
  };

  const purgeTrash = async (trashId: string) => {
    const entry = trash.find((item) => item.trashId === trashId);
    if (!entry || !window.confirm(t('dashboard.purgeConfirm', { name: entry.name }))) return;
    try {
      await api('/api/trash/' + encodeURIComponent(trashId), { method: 'DELETE' });
      setTrash((items) => items.filter((item) => item.trashId !== trashId));
      setNotice(t('dashboard.purged'));
    } catch (error) { setNotice(error instanceof Error ? error.message : t('dashboard.purgeFailed')); }
  };

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!project || screen !== 'editor') return;
    const title = project.name;
    document.title = `${title} — CutLoc`;
  }, [project, screen]);

  const returnToDashboard = () => {
    transitionTo('dashboard');
    void Promise.all([api<Project[]>('/api/projects'), api<TrashEntry[]>('/api/trash')]).then(([list, trashList]) => { setProjects(list); setTrash(trashList); });
  };

  const viewClass = `screen-view ${screenTransition === 'exit' ? 'screen-exit' : screenTransition === 'enter' ? 'screen-enter' : ''}`;

  return <div className="app-shell" data-theme={theme}>
    <div className={viewClass} key={screen}>
      {screen === 'dashboard' ? <Dashboard projects={projects} trash={trash} loading={loading} onCreate={createProject} onStartWithMedia={startWithMedia} onOpen={openProject} onDelete={requestDeleteProject} onRestoreTrash={restoreTrash} onPurgeTrash={purgeTrash} onSettings={() => setShowSettings(true)} onImportBundle={importBundle} /> : project ? <Editor onBack={returnToDashboard} /> : null}
    </div>
    {screenTransition !== 'idle' && <div className={`route-transition ${screenTransition === 'enter' ? 'route-transition-enter' : ''}`} aria-hidden="true"><div className="route-transition-orbit"><i /><i /><i /></div><span>{t(screen === 'editor' ? 'route.editor' : 'route.dashboard')}</span></div>}
    {screen === 'dashboard' && showSettings && <SettingsModal settings={useEditor.getState().settings} onClose={() => setShowSettings(false)} />}
    {screen === 'dashboard' && deleteCandidate && <ConfirmDialog title={t('dashboard.confirmTitle')} message={t('dashboard.confirmMessage', { name: deleteCandidate.name })} confirmLabel={t('dashboard.moveToTrash')} onConfirm={() => void deleteProject()} onClose={() => setDeleteCandidate(null)} />}
    {notice && <div className="toast toast-error"><Glyph>!</Glyph>{notice}<button onClick={() => setNotice('')}>×</button></div>}
  </div>;
}

function ThemeSwitcher({ compact = false }: { compact?: boolean }) {
  const { t } = useI18n();
  const theme = useEditor((state) => state.theme);
  const setTheme = useEditor((state) => state.setTheme);
  const options: Array<[Theme, TranslationKey, string]> = [['light', 'theme.light', '○'], ['gray', 'theme.gray', '◐'], ['dark', 'theme.dark', '●']];
  return <div className={`theme-switcher ${compact ? 'compact' : ''}`} role="group" aria-label={t('theme.label')}>
    {options.map(([value, labelKey, icon]) => { const label = t(labelKey); const optionLabel = t('theme.option', { name: label }); return <button key={value} className={theme === value ? 'active' : ''} onClick={() => setTheme(value)} title={optionLabel} aria-label={optionLabel}><span>{icon}</span>{!compact && <small>{label}</small>}</button>; })}
  </div>;
}

type CommandAction = { id: string; label: string; icon: string; shortcut?: string; run: () => void };

function CommandPalette({ actions, onClose }: { actions: CommandAction[]; onClose: () => void }) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return actions.filter((action) => action.label.toLocaleLowerCase().includes(needle));
  }, [actions, query]);
  useEffect(() => setActiveIndex(0), [query]);
  const run = (action: CommandAction | undefined) => {
    if (!action) return;
    action.run();
    onClose();
  };
  return <div className="command-palette-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="command-palette" role="dialog" aria-modal="true" aria-labelledby="command-palette-title" onKeyDown={(event) => {
    if (event.key === 'Escape') { event.preventDefault(); onClose(); }
    if (event.key === 'ArrowDown') { event.preventDefault(); setActiveIndex((index) => Math.min(filtered.length - 1, index + 1)); }
    if (event.key === 'ArrowUp') { event.preventDefault(); setActiveIndex((index) => Math.max(0, index - 1)); }
    if (event.key === 'Enter') { event.preventDefault(); run(filtered[activeIndex]); }
  }}><div className="command-palette-head"><span>⌕</span><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('command.placeholder')} aria-label={t('command.title')} /><kbd>ESC</kbd></div><div className="command-palette-list">{filtered.length ? filtered.map((action, index) => <button key={action.id} className={index === activeIndex ? 'active' : ''} onMouseEnter={() => setActiveIndex(index)} onClick={() => run(action)}><span className="command-palette-icon">{action.icon}</span><strong>{action.label}</strong>{action.shortcut && <kbd>{action.shortcut}</kbd>}</button>) : <div className="command-palette-empty">{t('command.empty')}</div>}</div><footer><strong id="command-palette-title">{t('command.title')}</strong><span>{t('command.hint')}</span></footer></section></div>;
}

function Dashboard({ projects, trash, loading, onCreate, onStartWithMedia, onOpen, onDelete, onRestoreTrash, onPurgeTrash, onSettings, onImportBundle }: { projects: Project[]; trash: TrashEntry[]; loading: boolean; onCreate: () => void; onStartWithMedia: (file: File) => void; onOpen: (id: string) => void; onDelete: (id: string) => void; onRestoreTrash: (trashId: string) => void; onPurgeTrash: (trashId: string) => void; onSettings: () => void; onImportBundle: (bundle: unknown) => void }) {
  const { language, t } = useI18n();
  const bundleInputRef = useRef<HTMLInputElement>(null);
  const mediaFileRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<'recent' | 'name'>('recent');
  const visibleProjects = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase(language === 'tr' ? 'tr-TR' : 'en-US');
    return [...projects]
      .filter((project) => !normalizedQuery || project.name.toLocaleLowerCase(language === 'tr' ? 'tr-TR' : 'en-US').includes(normalizedQuery))
      .sort((left, right) => sort === 'name'
        ? left.name.localeCompare(right.name, language === 'tr' ? 'tr-TR' : 'en-US')
        : new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
  }, [language, projects, query, sort]);
  const readBundle = async (file: File) => {
    try {
      if (file.name.toLocaleLowerCase().endsWith('.json')) onImportBundle(JSON.parse(await file.text()) as unknown);
      else onImportBundle(file);
    } catch {
      // Keep malformed files out of the API and give the user a useful local error.
      window.alert(t('dashboard.bundleError'));
    }
  };
  return <main key={language} className="dashboard">
    <header className="dashboard-header">
      <div className="brand"><div className="brand-mark"><span /></div><div><strong>CUTLOC</strong><small>{t('brand.tagline')}</small></div></div>
      <div className="header-actions"><span className="offline-pill"><i /> {t('brand.localMode')}</span><button className="secondary-button dashboard-bundle-import" onClick={() => bundleInputRef.current?.click()}>{t('dashboard.openBundle')}</button><input ref={bundleInputRef} className="hidden-input" type="file" accept=".json,.cutloc,.cutloc.json,application/json,application/zip" onChange={(event) => { const file = event.target.files?.[0]; if (file) void readBundle(file); event.target.value = ''; }} /><ThemeSwitcher /><button className="icon-button" title={t('common.settings')} onClick={onSettings}><Glyph>⚙</Glyph></button></div>
    </header>
    <section className="dashboard-hero">
      <div><p className="eyebrow">{t('dashboard.hero.eyebrow')}</p><h1>{t('dashboard.hero.titleLead')} <em>{t('dashboard.hero.titleAccent')}</em><br />{t('dashboard.hero.titleTail')}</h1><p className="hero-copy">{t('dashboard.hero.copy')}</p><button className="primary-button large" onClick={onCreate}><Glyph>＋</Glyph> {t('dashboard.newProject')}</button></div>
      <div className="hero-orbit"><div className="orbit-ring ring-a" /><div className="orbit-ring ring-b" /><div className="orbit-card card-one">◒<small>timeline</small></div><div className="orbit-card card-two">✦<small>effects</small></div><div className="orbit-card card-three">▣<small>export</small></div><div className="hero-core"><b>CL</b><span>LOCAL<br />FIRST</span></div></div>
    </section>
    <section className="dashboard-command-strip" aria-label={t('dashboard.quickStart')}>
      <button className="command-card command-primary" onClick={() => mediaFileRef.current?.click()}><span className="command-icon">＋</span><span><strong>{t('dashboard.command.new')}</strong><small>{t('dashboard.command.newHint')}</small></span><b>↗</b></button>
      <button className="command-card" onClick={onCreate}><span className="command-icon">▣</span><span><strong>{t('dashboard.command.media')}</strong><small>{t('dashboard.command.mediaHint')}</small></span><b>↗</b></button>
      {projects[0] ? <button className="command-card" onClick={() => onOpen(projects[0].id)}><span className="command-icon">▶</span><span><strong>{t('dashboard.command.continue')}</strong><small>{projects[0].name} · {formatTime(projects[0].duration)}</small></span><b>↗</b></button> : <div className="command-card command-muted"><span className="command-icon">⌁</span><span><strong>{t('dashboard.command.local')}</strong><small>{t('dashboard.command.localHint')}</small></span></div>}
    </section>
    <input ref={mediaFileRef} className="hidden-input" type="file" accept="video/*,audio/*,image/*" aria-label="Medya dosyasi sec" onChange={(event) => { const file = event.target.files?.[0]; if (file) onStartWithMedia(file); event.target.value = ''; }} />
    <section className="projects-section">
      <div className="section-heading dashboard-project-heading"><div><p className="eyebrow">{t('dashboard.workspace')}</p><h2>{t('dashboard.drafts')}</h2></div><span className="project-count">{query ? t('dashboard.filteredCount', { visible: visibleProjects.length, total: projects.length }) : t('common.projects', { count: projects.length })}</span></div>
      <div className="dashboard-project-tools"><label className="project-search"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('dashboard.searchPlaceholder')} aria-label={t('dashboard.searchPlaceholder')} />{query && <button onClick={() => setQuery('')} aria-label={t('common.close')}>×</button>}</label><select value={sort} onChange={(event) => setSort(event.target.value as 'recent' | 'name')} aria-label={t('common.search')}><option value="recent">{t('dashboard.sortRecent')}</option><option value="name">{t('dashboard.sortName')}</option></select></div>
      <div className="dashboard-insights"><span><b>{projects.reduce((total, item) => total + item.assets.length, 0)}</b> {t('dashboard.mediaAssets', { count: projects.reduce((total, item) => total + item.assets.length, 0) }).replace(/^\d+\s*/, '')}</span><span><b>{projects.filter((item) => item.duration > 0).length}</b> {t('dashboard.activeTimelines', { count: projects.filter((item) => item.duration > 0).length }).replace(/^\d+\s*/, '')}</span><span><b>Ctrl / ⌘ Z</b> {t('dashboard.undoHint')}</span></div>
      {loading ? <div className="empty-state"><div className="spinner" /> {t('dashboard.loading')}</div> : projects.length === 0 ? <div className="empty-state empty-dashed"><div className="empty-icon">✦</div><h3>{t('dashboard.emptyTitle')}</h3><p>{t('dashboard.emptyCopy')}</p><button className="secondary-button" onClick={onCreate}>{t('dashboard.command.new')}</button></div> : visibleProjects.length === 0 ? <div className="empty-state empty-dashed"><div className="empty-icon">⌕</div><h3>{t('dashboard.noSearchTitle')}</h3><p>{t('dashboard.noSearchCopy')}</p></div> : <div className="project-grid">{visibleProjects.map((item) => <ProjectCard key={item.id} project={item} onOpen={() => onOpen(item.id)} onDelete={() => onDelete(item.id)} />)}</div>}
    </section>
    <TrashSection entries={trash} onRestore={onRestoreTrash} onPurge={onPurgeTrash} />
    <footer className="dashboard-footer"><span><i className="status-dot" /> {t('dashboard.dataLocal')}</span><span>CutLoc <b>v0.0.2</b></span></footer>
  </main>;
}

function TrashSection({ entries, onRestore, onPurge }: { entries: TrashEntry[]; onRestore: (trashId: string) => void; onPurge: (trashId: string) => void }) {
  const { language, t, formatDate } = useI18n();
  return <section key={language} className="trash-section" aria-label={t('dashboard.trash')}>
    <div className="section-heading"><div><p className="eyebrow">{t('dashboard.recovery')}</p><h2>{t('dashboard.trash')}</h2></div><span className="project-count">{t('common.items', { count: entries.length })}</span></div>
    {entries.length === 0 ? <div className="trash-empty">{t('dashboard.trashEmpty')}</div> : <div className="trash-grid">{entries.map((entry) => <article className="trash-card" key={entry.trashId}><div className="trash-card-main"><strong>{entry.name}</strong><small>{formatDate(entry.deletedAt, { dateStyle: 'short', timeStyle: 'short' })} · {entry.assetCount} {t('common.media')}</small></div><div className="trash-card-actions"><button className="secondary-button" onClick={() => onRestore(entry.trashId)}>{t('common.restore')}</button><button className="danger-button" onClick={() => onPurge(entry.trashId)}>{t('common.deletePermanently')}</button></div></article>)}</div>}
  </section>;
}

function ProjectCard({ project, onOpen, onDelete }: { project: Project; onOpen: () => void; onDelete: () => void }) {
  const { t, formatDate } = useI18n();
  const accent = project.canvas.width > project.canvas.height ? 'landscape' : 'portrait';
  const hasTimeline = project.duration > 0;
  return <article className="project-card" onDoubleClick={onOpen}>
    <button className={`project-preview ${accent}`} onClick={onOpen}><div className="preview-grid" /><span className="project-play">▶</span><span className="aspect-tag">{project.canvas.width}:{project.canvas.height}</span></button>
    <div className="project-card-info"><div><div className="project-card-title"><h3>{project.name}</h3><span className={`project-status ${hasTimeline ? 'ready' : ''}`}>{t(hasTimeline ? 'dashboard.statusEdited' : 'dashboard.statusStarter')}</span></div><p>{formatDate(project.updatedAt, { day: '2-digit', month: 'short' })} · {formatTime(project.duration)} · {project.assets.length} {t('common.media')}</p></div><button className="more-button" onClick={onDelete} title={t('dashboard.moveToTrash')}>•••</button></div>
  </article>;
}

function Editor({ onBack }: { onBack: () => void }) {
  const { t } = useI18n();
  const project = useEditor((state) => state.project)!;
  const settings = useEditor((state) => state.settings);
  const setSettings = useEditor((state) => state.setSettings);
  const saveState = useEditor((state) => state.saveState);
  const localRevision = useEditor((state) => state.localRevision);
  const savedRevision = useEditor((state) => state.savedRevision);
  const lastSavedAt = useEditor((state) => state.lastSavedAt);
  const acknowledgeSaved = useEditor((state) => state.acknowledgeSaved);
  const applyServerProject = useEditor((state) => state.applyServerProject);
  const setProject = useEditor((state) => state.setProject);
  const setSaveState = useEditor((state) => state.setSaveState);
  const selectedClipId = useEditor((state) => state.selectedClipId);
  const selectedClipIds = useEditor((state) => state.selectedClipIds);
  const editorNotice = useEditor((state) => state.notice);
  const setEditorNotice = useEditor((state) => state.setNotice);
  const mutateProject = useEditor((state) => state.mutateProject);
  const undo = useEditor((state) => state.undo);
  const redo = useEditor((state) => state.redo);
  const rangeStart = useEditor((state) => state.rangeStart);
  const rangeEnd = useEditor((state) => state.rangeEnd);
  const setRangeStart = useEditor((state) => state.setRangeStart);
  const setRangeEnd = useEditor((state) => state.setRangeEnd);
  const clearRange = useEditor((state) => state.clearRange);
  const [exporting, setExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [backPending, setBackPending] = useState(false);
  const [exportStatus, setExportStatus] = useState<ExportStatus>({ progress: 0 });
  const [workspaceLayout, setWorkspaceLayout] = useState<WorkspaceLayout>({ ...DEFAULT_WORKSPACE_LAYOUT, ...(settings?.workspaceLayout ?? {}) });
  const saveTimerRef = useRef<number | null>(null);
  const saveInFlightRef = useRef(false);
  const savePromiseRef = useRef<Promise<void> | null>(null);
  const exportWatchCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (settings?.workspaceLayout) setWorkspaceLayout({ ...DEFAULT_WORKSPACE_LAYOUT, ...settings.workspaceLayout });
  }, [settings?.workspaceLayout]);

  const persistWorkspaceLayout = (next: WorkspaceLayout) => {
    setWorkspaceLayout(next);
    if (!settings) return;
    setSettings({ ...settings, workspaceLayout: next });
    void api<Settings>('/api/settings', { method: 'PUT', body: JSON.stringify({ workspaceLayout: next }) }).catch(() => setEditorNotice(t('editor.layoutSaveFailed')));
  };

  const saveProjectNow = useCallback(async (): Promise<void> => {
    if (savePromiseRef.current) return savePromiseRef.current;
    const promise = (async () => {
      const beforeSave = useEditor.getState();
      const snapshot = beforeSave.project;
      if (!snapshot) return;
      if (beforeSave.localRevision === beforeSave.savedRevision && beforeSave.saveState === 'saved') return;
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        setSaveState('offline');
        throw new Error('\u00c7evrimd\u0131\u015f\u0131 oldu\u011funuz i\u00e7in proje kaydedilemedi.');
      }
      const keepClipId = beforeSave.selectedClipId;
      const keepClipIds = beforeSave.selectedClipIds;
      const keepTrackId = beforeSave.selectedTrackId;
      const keepTime = beforeSave.currentTime;
      let candidate: Project = { ...snapshot, revision: beforeSave.savedRevision };
      let saved: Project | null = null;
      try {
        setSaveState('saving');
        for (let attempt = 0; attempt < 3 && !saved; attempt += 1) {
          try {
            saved = await api<Project>(`/api/projects/${snapshot.id}`, { method: 'PATCH', body: JSON.stringify(candidate) });
          } catch (error) {
            if (!(error instanceof ApiError) || error.status !== 409 || attempt >= 2) throw error;
            const latest = await api<Project>(`/api/projects/${snapshot.id}`);
            candidate = mergeImportedProject(candidate, latest);
          }
        }
        if (!saved) throw new Error('Proje kaydedilemedi');
        const isLatestLocalSnapshot = useEditor.getState().project === snapshot;
        acknowledgeSaved(saved, snapshot);
        if (isLatestLocalSnapshot) {
          const survivingClipIds = keepClipIds.filter((id) => saved!.tracks.some((track) => track.clips.some((clip) => clip.id === id)));
          if (survivingClipIds.length) useEditor.getState().setSelectedMany(survivingClipIds, keepTrackId);
          else if (keepClipId && saved.tracks.some((track) => track.clips.some((clip) => clip.id === keepClipId))) useEditor.getState().setSelected(keepClipId, keepTrackId);
          useEditor.getState().setCurrentTime(keepTime);
        }
      } catch (error) {
        const offline = typeof navigator !== 'undefined' && !navigator.onLine || error instanceof TypeError;
        setSaveState(offline ? 'offline' : 'error');
        setEditorNotice(offline ? '\u00c7evrimd\u0131\u015f\u0131: de\u011fi\u015fiklikler yerelde bekliyor.' : error instanceof Error ? `Kaydetme hatas\u0131: ${error.message}` : 'Kaydetme hatas\u0131');
        throw error;
      }
    })();
    savePromiseRef.current = promise;
    void promise.then(() => {
      if (savePromiseRef.current === promise) savePromiseRef.current = null;
    }, () => {
      if (savePromiseRef.current === promise) savePromiseRef.current = null;
    });
    return promise;
  }, [acknowledgeSaved, setEditorNotice, setSaveState]);
  useEffect(() => {
    if (!project || saveState !== 'saving' || localRevision === savedRevision) return;
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      void saveProjectNow().catch(() => undefined);
    }, 550);
    return () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [localRevision, project, saveProjectNow, saveState, savedRevision]);
  useEffect(() => {
    const onOffline = () => setSaveState('offline');
    const onOnline = () => {
      const state = useEditor.getState();
      setSaveState(state.localRevision !== state.savedRevision ? 'saving' : 'saved');
    };
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    if (!navigator.onLine) onOffline();
    return () => {
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
    };
  }, [setSaveState]);
  /* Legacy autosave body kept only as a migration reference; saveProjectNow above is the live path.
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      if (saveInFlightRef.current) return;
      const snapshot = useEditor.getState().project;
      if (!snapshot) return;
      const beforeSave = useEditor.getState();
      const keepClipId = beforeSave.selectedClipId;
      const keepClipIds = beforeSave.selectedClipIds;
      const keepTrackId = beforeSave.selectedTrackId;
      const keepTime = beforeSave.currentTime;
      saveInFlightRef.current = true;
      void (async () => {
        try {
          let candidate = snapshot;
          let saved: Project | null = null;
          for (let attempt = 0; attempt < 3 && !saved; attempt += 1) {
            try {
              saved = await api<Project>(`/api/projects/${snapshot.id}`, { method: 'PATCH', body: JSON.stringify(candidate) });
            } catch (error) {
              if (!(error instanceof ApiError) || error.status !== 409 || attempt >= 2) throw error;
              const latest = await api<Project>(`/api/projects/${snapshot.id}`);
              const localAssets = candidate.assets;
              const mergedAssets = latest.assets.map((serverAsset) => {
                const localAsset = localAssets.find((asset) => asset.id === serverAsset.id);
                return localAsset ? { ...localAsset, ...serverAsset } : serverAsset;
              });
              mergedAssets.push(...localAssets.filter((asset) => !latest.assets.some((serverAsset) => serverAsset.id === asset.id)));
              candidate = { ...candidate, assets: mergedAssets, revision: latest.revision };
            }
          }
          if (!saved) throw new Error(t('editor.projectSaveFailed'));
          const currentProject = useEditor.getState().project;
          if (currentProject === snapshot) {
            // A server acknowledgement must not erase the local undo/redo stack.
            setProject(saved, false);
            const survivingClipIds = keepClipIds.filter((id) => saved!.tracks.some((track) => track.clips.some((clip) => clip.id === id)));
            if (survivingClipIds.length) useEditor.getState().setSelectedMany(survivingClipIds, keepTrackId);
            else if (keepClipId && saved.tracks.some((track) => track.clips.some((clip) => clip.id === keepClipId))) useEditor.getState().setSelected(keepClipId, keepTrackId);
            useEditor.getState().setCurrentTime(keepTime);
            setEditorNotice('');
            setSaveState('saved');
          } else {
            // A newer local edit arrived while the request was in flight. Keep it
            // visible and immediately schedule that newer snapshot for saving.
            setSaveState('saved');
            setEditorNotice('');
            window.setTimeout(() => {
              if (useEditor.getState().project !== saved) useEditor.getState().setSaveState('saving');
            }, 0);
          }
          setSaveState('error');
          setEditorNotice(t('editor.saveErrorWithReason', { reason: error instanceof Error ? error.message : t('common.saveError') }));
        } finally {
          saveInFlightRef.current = false;
        }
      })();
    }, 550);
    return () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [project, saveState, setEditorNotice, setProject, setSaveState]);

  */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'k') { event.preventDefault(); setShowCommandPalette((visible) => !visible); return; }
      const tag = (event.target as HTMLElement).tagName;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return;
      if (matchesShortcut(event, shortcutValue(settings, 'undo'))) { event.preventDefault(); undo(); }
      if (matchesShortcut(event, shortcutValue(settings, 'redo')) || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y')) { event.preventDefault(); redo(); }
      if (matchesShortcut(event, shortcutValue(settings, 'selectAll'))) {
        event.preventDefault();
        useEditor.getState().setSelectedMany(project.tracks.filter((track) => !track.locked).flatMap((track) => track.clips).map((clip) => clip.id));
      }
      if (matchesShortcut(event, shortcutValue(settings, 'duplicate')) && selectedClipIds.length) {
        event.preventDefault();
        const duplicateSourceIds = new Set(project.tracks.filter((track) => !track.locked).flatMap((track) => track.clips).filter((clip) => selectedClipIds.includes(clip.id)).map((clip) => clip.id));
        const duplicateIds = [...duplicateSourceIds].map(() => `clip_${crypto.randomUUID().slice(0, 8)}`);
        const duplicateMap = new Map([...duplicateSourceIds].map((sourceId, index) => [sourceId, duplicateIds[index]]));
        mutateProject((draft) => {
          for (const track of draft.tracks) {
            if (track.locked) continue;
            const copies = track.clips.filter((clip) => duplicateMap.has(clip.id)).map((clip) => ({ ...clip, id: duplicateMap.get(clip.id)!, name: t('editor.copySuffix', { name: clip.name }), start: clip.start + 0.25 }));
            track.clips.push(...copies);
          }
          draft.duration = projectDuration(draft);
        });
        if (duplicateIds.length) useEditor.getState().setSelectedMany(duplicateIds);
      }
      if (matchesShortcut(event, shortcutValue(settings, 'togglePlayback'))) { event.preventDefault(); useEditor.getState().setPlaying(!useEditor.getState().playing); }
      if (matchesShortcut(event, shortcutValue(settings, 'deleteClip')) && selectedClipId) {
        event.preventDefault();
        mutateProject((draft) => { for (const track of draft.tracks) track.clips = track.clips.filter((clip) => !selectedClipIds.includes(clip.id)); draft.duration = projectDuration(draft); });
        useEditor.getState().setSelected(null);
      }
      if (matchesShortcut(event, shortcutValue(settings, 'split')) && selectedClipId) {
        event.preventDefault();
        mutateProject((draft) => { splitClipAt(draft, selectedClipId, useEditor.getState().currentTime); });
      }
      if ((event.ctrlKey || event.metaKey) && (event.key === 'ArrowLeft' || event.key === 'ArrowRight') && selectedClipIds.length) {
        event.preventDefault();
        const frameStep = 1 / Math.max(1, project.canvas.fps);
        const direction = event.key === 'ArrowLeft' ? -1 : 1;
        const step = frameStep * (event.shiftKey ? 10 : 1);
        mutateProject((draft) => {
          for (const track of draft.tracks) {
            if (track.locked) continue;
            for (const clip of track.clips) {
              if (!selectedClipIds.includes(clip.id)) continue;
              clip.start = Math.max(0, Math.round((clip.start + direction * step) / frameStep) * frameStep);
            }
          }
          draft.duration = projectDuration(draft);
        });
      }
      if (matchesShortcut(event, shortcutValue(settings, 'setIn'))) { event.preventDefault(); setRangeStart(useEditor.getState().currentTime); }
      if (matchesShortcut(event, shortcutValue(settings, 'setOut'))) { event.preventDefault(); setRangeEnd(useEditor.getState().currentTime); }
      if (matchesShortcut(event, shortcutValue(settings, 'clearRange'))) { event.preventDefault(); clearRange(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [clearRange, mutateProject, project, redo, selectedClipId, selectedClipIds, setRangeEnd, setRangeStart, settings, undo]);

  const importMedia = async (file: File) => {
    const form = new FormData(); form.append('file', file);
    try {
      const response = await fetch(`/api/projects/${project.id}/media`, { method: 'POST', body: form });
      if (!response.ok) throw new Error((await response.json()).error || t('editor.mediaImportFailed'));
      const result = await response.json() as { asset: Asset; project: Project };
      const serverProject = result.project;
      // Importing populates the library only.  Reconcile the new asset without
      // hydrating the whole server snapshot: that would reset the playhead,
      // selection and local timeline edits while a proxy is being prepared.
      const localProject = useEditor.getState().project;
      const mergedProject = localProject ? mergeImportedProject(localProject, serverProject) : serverProject;
      applyServerProject(mergedProject);
      // The media endpoint already persisted the asset; only local edits remain pending.
      setEditorNotice(t('editor.mediaImported', { name: result.asset.name }));
    } catch (error) { setExportMessage(error instanceof Error ? error.message : t('editor.mediaImportFailed')); }
  };

  const addFirstAssetToTimeline = (): boolean => {
    const current = useEditor.getState().project;
    if (!current) return false;
    const asset = current.assets.find((item) => item.type === 'video' || item.type === 'image') ?? current.assets.find((item) => item.type === 'audio');
    if (!asset) {
      setEditorNotice(t('editor.importMediaFirst'));
      return false;
    }
    const placement = findEmptyPlacement(current, Math.max(asset.duration || 5, 0.5), useEditor.getState().currentTime, useEditor.getState().selectedTrackId);
    const clip = createMediaClip(asset, placement.start);
    let targetId = placement.trackId;
    mutateProject((draft) => {
      const destination = targetId ? draft.tracks.find((track) => track.id === targetId) : undefined;
      const track = destination && !destination.locked ? destination : createLayerTrack(draft);
      targetId = track.id;
      track.clips.push(clip);
      draft.duration = projectDuration(draft);
    });
    useEditor.getState().setSelected(clip.id, targetId);
    setExportStatus({ progress: 0 });
    setEditorNotice(t('editor.assetAddedToTimeline', { name: asset.name }));
    return true;
  };

  const flushPendingSave = useCallback(async () => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const state = useEditor.getState();
      if (!state.project) return;
      const dirty = state.localRevision !== state.savedRevision;
      if (dirty && (state.saveState === 'offline' || (typeof navigator !== 'undefined' && !navigator.onLine))) {
        throw new Error(t('editor.saveOffline'));
      }
      if (dirty && state.saveState === 'error') throw new Error(t('editor.fixPendingSave'));
      const inFlight = savePromiseRef.current;
      if (inFlight) {
        await inFlight;
        continue;
      }
      if (dirty || state.saveState === 'saving') {
        await saveProjectNow();
        continue;
      }
      if (state.saveState === 'error') throw new Error(t('editor.fixPendingSave'));
      return;
    }
    throw new Error(t('editor.fixPendingSave'));
  }, [saveProjectNow, t]);

  const handleBack = useCallback(() => {
    if (backPending) return;
    setBackPending(true);
    void flushPendingSave().then(() => {
      onBack();
    }).catch((error: unknown) => {
      setEditorNotice(error instanceof Error ? error.message : t('editor.fixPendingSave'));
    }).finally(() => {
      setBackPending(false);
    });
  }, [backPending, flushPendingSave, onBack, setEditorNotice, t]);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      const state = useEditor.getState();
      if (state.project && state.localRevision !== state.savedRevision) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);
  const ensureProjectSaved = async (): Promise<Project> => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const state = useEditor.getState();
      if (!state.project) throw new Error('Proje bulunamad\u0131.');
      if (state.saveState === 'offline') throw new Error('\u00c7evrimd\u0131\u015f\u0131 ba\u011flant\u0131 varken export ba\u015flat\u0131lamaz.');
      if (state.saveState === 'error') throw new Error('Export i\u00e7in bekleyen proje kayd\u0131n\u0131 d\u00fczeltin.');
      if (state.localRevision !== state.savedRevision) {
        await saveProjectNow();
        continue;
      }
      const confirmed = await api<Project>(`/api/projects/${state.project.id}`);
      const latestState = useEditor.getState();
      if (confirmed.revision !== latestState.savedRevision) {
        const localProject = latestState.project;
        if (!localProject) throw new Error('Proje bulunamad\u0131.');
        applyServerProject(mergeImportedProject(localProject, confirmed));
        continue;
      }
      return confirmed;
    }
    throw new Error('Proje kayd\u0131 backend taraf\u0131ndan do\u011frulanamad\u0131.');
  };
  /* Legacy timeout helper body retained only for reference.
    const deadline = Date.now() + 3500;
    while (useEditor.getState().saveState === 'saving' && Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 80));
    }
    if (useEditor.getState().saveState === 'error') throw new Error(t('editor.fixPendingSave'));
  };

  */
  useEffect(() => {
    return () => {
      exportWatchCleanupRef.current?.();
    };
  }, []);

  const watchExportJob = (jobId: string) => new Promise<void>((resolve) => {
    let source: EventSource | null = null;
    let reconnectTimer: number | null = null;
    let pollTimer: number | null = null;
    let reconnectAttempts = 0;
    let settled = false;

    const cleanup = () => {
      source?.close();
      source = null;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (pollTimer !== null) window.clearTimeout(pollTimer);
      if (exportWatchCleanupRef.current === cleanup) exportWatchCleanupRef.current = null;
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      setExporting(false);
      resolve();
    };
    const applyJob = (job: Job) => {
      setExportStatus({
        jobId,
        progress: job.progress ?? 0,
        status: job.status,
        message: job.message,
        downloadUrl: job.downloadUrl,
        fileName: job.fileName,
        error: job.error,
      });
      if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') finish();
    };
    const poll = () => {
      if (settled) return;
      setExportStatus((current) => ({ ...current, jobId, status: 'reconnecting', message: 'Export durumu yoklan\u0131yor...' }));
      void api<Job>('/api/jobs/' + jobId).then(applyJob).catch(() => {
        if (!settled) setExportStatus((current) => ({ ...current, jobId, status: 'reconnecting', message: 'Export sunucusuna yeniden ba\u011flan\u0131l\u0131yor...' }));
      }).finally(() => {
        if (!settled) pollTimer = window.setTimeout(poll, 1000);
      });
    };
    const connect = () => {
      if (settled) return;
      source = new EventSource('/api/events');
      source.addEventListener('job', (event) => {
        try {
          const job = JSON.parse((event as MessageEvent).data) as Job;
          if (job.id === jobId) applyJob(job);
        } catch {
          // Ignore malformed events and let the job polling fallback recover.
        }
      });
      source.onerror = () => {
        if (settled) return;
        source?.close();
        source = null;
        reconnectAttempts += 1;
        setExportStatus((current) => ({ ...current, jobId, status: 'reconnecting', message: 'Export ba\u011flant\u0131s\u0131 yeniden kuruluyor...' }));
        if (reconnectAttempts <= 3) {
          reconnectTimer = window.setTimeout(connect, 500 * reconnectAttempts);
        } else {
          poll();
        }
      };
    };

    exportWatchCleanupRef.current = cleanup;
    void api<Job>('/api/jobs/' + jobId).then(applyJob).catch(() => undefined);
    connect();
  });

  const startExportResilient = async (options: ExportOptions): Promise<ExportPreflight> => {
    setExporting(true);
    try {
      setExportStatus({ progress: 0, status: 'saving', message: 'Proje kayd\u0131 backend taraf\u0131ndan do\u011frulan\u0131yor' });
      const confirmedProject = await ensureProjectSaved();
      const requestBody = { ...options, projectRevision: confirmedProject.revision };
      setExportStatus({ progress: 0, status: 'preflight', message: 'Export \u00f6n kontrol\u00fc yap\u0131l\u0131yor' });
      const preflight = await api<ExportPreflight>('/api/projects/' + confirmedProject.id + '/export/preflight', { method: 'POST', body: JSON.stringify(requestBody) });
      if (!preflight.ok) throw new Error(preflight.errors.map((item) => item.message).join(' '));
      const currentProject = useEditor.getState().project ?? project;
      void api<Settings>('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({
          defaultExport: {
            format: options.format,
            aspect: options.aspect === 'source' ? currentProject.canvas.aspect : options.aspect,
            resolution: options.resolution,
            fps: options.fps,
            quality: options.quality,
            audioBitrateKbps: options.audioBitrateKbps,
          },
        }),
      }).then(setSettings).catch(() => undefined);
      const response = await api<{ job: { id: string } }>('/api/projects/' + confirmedProject.id + '/export', { method: 'POST', body: JSON.stringify(requestBody) });
      const jobId = response.job.id;
      setExportStatus({ jobId, progress: 0, status: 'queued', message: 'Export kuyru\u011fa al\u0131nd\u0131' });
      await watchExportJob(jobId);
      return preflight;
    } catch (error) {
      setExporting(false);
      setExportStatus({ progress: 0, status: 'failed', error: error instanceof Error ? error.message : 'Export ba\u015flat\u0131lamad\u0131' });
      throw error;
    }
  };


  const startExport = async (options: ExportOptions): Promise<ExportPreflight> => {
    return startExportResilient(options);
  };

  const commandActions: CommandAction[] = [
    { id: 'media', label: t('command.media'), icon: '▧', shortcut: 'M', run: () => useEditor.getState().setPanel('media') },
    { id: 'text', label: t('command.text'), icon: 'T', run: () => useEditor.getState().setPanel('text') },
    { id: 'animation', label: t('command.animation'), icon: '✧', run: () => useEditor.getState().setPanel('animation') },
    { id: 'project', label: t('command.project'), icon: '◉', run: () => useEditor.getState().setPanel('project') },
    { id: 'playback', label: t('command.playback'), icon: '▶', shortcut: 'Space', run: () => useEditor.getState().setPlaying(!useEditor.getState().playing) },
    { id: 'export', label: t('command.export'), icon: '↗', shortcut: 'Ctrl+E', run: () => setShowExport(true) },
    { id: 'settings', label: t('command.settings'), icon: '⚙', run: () => setShowSettings(true) },
  ];

  return <div className="editor-shell">
    <EditorTopbar project={project} onBack={handleBack} backPending={backPending} onExport={() => setShowExport(true)} exporting={exporting} onSettings={() => setShowSettings(true)} onCommands={() => setShowCommandPalette(true)} />
    <div className="editor-body workspace-layout" style={{ '--workspace-rail-width': `${workspaceLayout.railWidth}px`, '--workspace-library-width': `${workspaceLayout.libraryWidth}px`, '--workspace-inspector-width': `${workspaceLayout.inspectorWidth}px`, '--workspace-timeline-height': `${workspaceLayout.timelineHeight}px` } as React.CSSProperties}><ToolRail onOpenSettings={() => setShowSettings(true)} /><AssetPanelPro onImport={importMedia} onOpenSettings={() => setShowSettings(true)} /><PreviewArea project={project} settings={settings} /><Inspector project={project} /><TimelinePro project={project} /><WorkspaceResizers layout={workspaceLayout} onPreview={setWorkspaceLayout} onCommit={persistWorkspaceLayout} /></div>
    {exportMessage && <div className={`export-toast ${exporting ? 'active' : ''}`}><span className="export-pulse" />{exportMessage}{!exporting && <button onClick={() => setExportMessage('')}>×</button>}</div>}
    {editorNotice && <div className="export-toast"><span className="export-pulse" />{editorNotice}<button onClick={() => setEditorNotice('')}>×</button></div>}
    <div className="editor-statusbar"><span><i className="status-dot" /> {t('editor.status.ready')}</span><span>{saveState === 'saving' ? t('common.saving') : saveState === 'error' ? t('common.saveError') : t('editor.status.allSaved')}</span><span>{t('editor.status.shortcuts')}</span></div>
    {showCommandPalette && <CommandPalette actions={commandActions} onClose={() => setShowCommandPalette(false)} />}
    {showSettings && <SettingsModal settings={settings} onClose={() => setShowSettings(false)} />}
    {showExport && <ExportModal project={project} settings={settings} rangeStart={rangeStart} rangeEnd={rangeEnd} exporting={exporting} status={exportStatus} onStart={startExport} onAddFirstAsset={addFirstAssetToTimeline} onClose={() => setShowExport(false)} />}
  </div>;
}

function ExportModal({ project, settings, rangeStart, rangeEnd, exporting, status, onStart, onAddFirstAsset, onClose }: { project: Project; settings: Settings | null; rangeStart: number | null; rangeEnd: number | null; exporting: boolean; status: ExportStatus; onStart: (options: ExportOptions) => Promise<ExportPreflight>; onAddFirstAsset: () => boolean; onClose: () => void }) {
  const { t } = useI18n();
  const defaults = settings?.defaultExport;
  // Export always follows the project canvas.  Aspect changes belong to the
  // Preview toolbar; keeping a second profile picker here made output sizing
  // ambiguous and looked like a hidden resolution selector.
  const aspect: ExportOptions['aspect'] = project.canvas.aspect ?? '16:9';
  const [format, setFormat] = useState<ExportOptions['format']>(defaults?.format ?? 'mp4');
  const [resolution, setResolution] = useState<ExportOptions['resolution']>(defaults?.resolution ?? '1080p');
  const [fps, setFps] = useState<ExportOptions['fps']>((defaults?.fps === 24 || defaults?.fps === 25 || defaults?.fps === 30 || defaults?.fps === 50 || defaults?.fps === 60) ? defaults.fps : 30);
  const [quality, setQuality] = useState<ExportOptions['quality']>(defaults?.quality ?? 'standard');
  const [rateMode, setRateMode] = useState<ExportOptions['rateMode']>('crf');
  const [crf, setCrf] = useState(23);
  const [videoBitrateKbps, setVideoBitrateKbps] = useState(7000);
  const [audioBitrateKbps, setAudioBitrateKbps] = useState<128 | 192 | 256>(defaults?.audioBitrateKbps ?? 192);
  const [scope, setScope] = useState<'all' | 'range'>('all');
  const [fileName, setFileName] = useState(`${project.name}-export`);
  const [error, setError] = useState('');
  const [preflight, setPreflight] = useState<ExportPreflight | null>(null);
  const done = status.status === 'completed';
  const statusLabel = status.status === 'queued' ? 'Kuyrukta'
    : status.status === 'running' ? '\u00c7al\u0131\u015f\u0131yor'
      : status.status === 'reconnecting' ? 'Yeniden ba\u011flan\u0131yor'
        : status.status === 'completed' ? 'Tamamland\u0131'
          : status.status === 'failed' ? 'Ba\u015far\u0131s\u0131z'
            : status.status === 'cancelled' ? '\u0130ptal edildi'
              : status.status === 'saving' ? 'Kaydediliyor\u2026'
                : status.status === 'preflight' ? '\u00d6n kontrol' : 'Haz\u0131rlan\u0131yor';
  const hasTimelineClips = project.tracks.some((track) => track.clips.length > 0);
  const canvasHint = `${project.canvas.width} × ${project.canvas.height}`;
  const outputSize = exportDimensions(aspect, resolution, { width: project.canvas.width, height: project.canvas.height });
  const outputHint = `${outputSize.width} × ${outputSize.height}`;
  const options = (): ExportOptions => ({
    format,
    aspect,
    resolution,
    fps,
    quality,
    rateMode,
    crf: quality === 'custom' && rateMode === 'crf' ? crf : undefined,
    videoBitrateKbps: quality === 'custom' && rateMode === 'bitrate' ? videoBitrateKbps : undefined,
    audioBitrateKbps,
    range: scope === 'range' && rangeStart !== null && rangeEnd !== null && rangeEnd > rangeStart ? { start: rangeStart, end: rangeEnd } : undefined,
    fileName,
  });
  const submit = async () => {
    setError('');
    try { setPreflight(await onStart(options())); }
    catch (submitError) { setError(submitError instanceof Error ? submitError.message : t('export.failedToStart')); }
  };
  return <div className="modal-backdrop export-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !exporting) onClose(); }}><section className="export-modal" role="dialog" aria-modal="true" aria-labelledby="export-title">
    <div className="modal-head"><div><p className="eyebrow">{t('export.studio')}</p><h2 id="export-title">{t('export.title')}</h2><small>{project.name} · {formatTime(project.duration)} timeline</small></div><button onClick={onClose} disabled={exporting} aria-label={t('common.close')}>×</button></div>
    <div className="export-layout">
      <div className="export-form">
        <div className="export-section"><span className="export-label">{t('export.canvas')}</span><div className="export-canvas-readonly export-canvas-profile"><span>{t('export.canvasLocked')}</span><strong>{aspect} · {t('export.canvas')} {canvasHint}</strong><small>{t('export.output', { resolution: resolution === '2K' ? '1440p' : resolution, size: outputHint })}</small></div></div>
        <div className="export-grid-row"><label><span>{t('export.format')}</span><select value={format} onChange={(event) => setFormat(event.target.value as ExportOptions['format'])} disabled={exporting}><option value="mp4">MP4 · H.264 + AAC</option><option value="mp3">{t('export.mp3')}</option><option value="wav">{t('export.wav')}</option></select></label><label><span>{t('export.resolution')}</span><select aria-label={t('export.outputResolution')} value={resolution} onChange={(event) => setResolution(event.target.value as ExportOptions['resolution'])} disabled={exporting || format !== 'mp4'}><option value="720p">720p · HD</option><option value="1080p">1080p · Full HD</option><option value="2K">1440p · 2K</option><option value="4K">2160p · 4K UHD</option></select></label></div>
        <div className="export-grid-row"><label><span>{t('export.frameRate')}</span><select value={fps} onChange={(event) => setFps(Number(event.target.value) as ExportOptions['fps'])} disabled={exporting}><option value={24}>24 FPS</option><option value={25}>25 FPS</option><option value={30}>30 FPS</option><option value={50}>50 FPS</option><option value={60}>60 FPS</option></select></label><label><span>{t('export.audioBitrate')}</span><select value={audioBitrateKbps} onChange={(event) => setAudioBitrateKbps(Number(event.target.value) as 128 | 192 | 256)} disabled={exporting}><option value={128}>128 kbps</option><option value={192}>192 kbps</option><option value={256}>256 kbps</option></select></label></div>
        <div className="export-section"><span className="export-label">{t('export.quality')}</span><div className="quality-tabs">{(['draft', 'standard', 'high', 'custom'] as const).map((value) => <button key={value} className={quality === value ? 'active' : ''} onClick={() => setQuality(value)} disabled={exporting}>{t(`export.quality.${value}` as TranslationKey)}</button>)}</div>{quality === 'custom' && <div className="advanced-quality"><label><span>{t('export.rateMode')}</span><select value={rateMode} onChange={(event) => setRateMode(event.target.value as ExportOptions['rateMode'])}><option value="crf">CRF</option><option value="bitrate">Bitrate</option></select></label>{rateMode === 'crf' ? <label><span>CRF (16–32)</span><input type="number" min={16} max={32} value={crf} onChange={(event) => setCrf(Number(event.target.value))} /></label> : <label><span>{t('export.videoBitrate')}</span><input type="number" min={500} max={50000} step={500} value={videoBitrateKbps} onChange={(event) => setVideoBitrateKbps(Number(event.target.value))} /></label>}</div>}</div>
        <div className="export-section"><span className="export-label">{t('export.scope')}</span><div className="scope-toggle"><button className={scope === 'all' ? 'active' : ''} onClick={() => setScope('all')} disabled={exporting}>{t('export.allTimeline')}</button><button className={scope === 'range' ? 'active' : ''} onClick={() => setScope('range')} disabled={exporting || rangeStart === null || rangeEnd === null}>In–Out {rangeStart !== null && rangeEnd !== null ? `(${formatTime(rangeEnd - rangeStart)})` : t('common.notSet')}</button></div></div>
        <label className="export-file-name"><span>{t('export.fileName')}</span><input value={fileName} onChange={(event) => setFileName(event.target.value)} disabled={exporting} /></label>
      </div>
      <aside className="export-summary"><div className="summary-icon">↗</div><strong>{format === 'mp4' ? t('export.videoExport') : t('export.audioExport')}</strong><p>{format === 'mp4' ? `${aspect} · ${outputHint} · ${fps} FPS` : `${format.toUpperCase()} · ${audioBitrateKbps} kbps`}</p><div className="summary-row"><span>{t('export.quality')}</span><b>{t(`export.quality.${quality}` as TranslationKey)}</b></div><div className="summary-row"><span>Codec</span><b>{format === 'mp4' ? 'H.264 / AAC' : format.toUpperCase()}</b></div>{preflight?.warnings.map((warning) => <div className="export-warning" key={warning.code}>⚠ {warning.message}</div>)}{status.status && <div className="export-progress"><div className="progress-head"><strong>{statusLabel}</strong><span>{status.message || statusLabel}</span><b>{Math.round(status.progress * 100)}%</b></div><div className="progress-track"><i style={{ width: `${Math.max(2, status.progress * 100)}%` }} /></div></div>}{status.error && <div className="export-error">{status.error}</div>}{done && status.downloadUrl && <div className="export-complete"><span>✓ {t('common.ready')}</span><strong>{status.fileName}</strong><a className="secondary-button" href={status.downloadUrl} download={status.fileName}>{t('common.download')}</a></div>}</aside>
    </div>
    {error && <div className="export-error export-error-bottom">{error}{!hasTimelineClips && <button className="secondary-button export-recovery-button" onClick={() => { if (onAddFirstAsset()) setError(''); }}>{t('export.addLibraryMedia')}</button>}</div>}
    <div className="modal-actions"><span>{preflight?.estimatedBytes ? t('export.estimatedSize', { size: (preflight.estimatedBytes / 1024 / 1024).toFixed(1) }) : t('export.localFfmpeg')}</span><button className="secondary-button" onClick={onClose} disabled={exporting}>{t('common.close')}</button><button className="primary-button export-start-button" onClick={() => void submit()} disabled={exporting}>{exporting ? t('common.exporting') : done ? t('export.reExport') : t('common.export')}</button></div>
  </section></div>;
}

function EditorTopbar({ project, onBack, backPending, onExport, exporting, onSettings, onCommands }: { project: Project; onBack: () => void; backPending: boolean; onExport: () => void; exporting: boolean; onSettings: () => void; onCommands: () => void }) {
  const { t } = useI18n();
  const mutateProject = useEditor((state) => state.mutateProject);
  const undo = useEditor((state) => state.undo);
  const redo = useEditor((state) => state.redo);
  const saveState = useEditor((state) => state.saveState);
  const lastSavedAt = useEditor((state) => state.lastSavedAt);
  const language = useEditor((state) => state.settings?.language ?? 'tr');
  const saveTime = lastSavedAt ? new Date(lastSavedAt).toLocaleTimeString(language === 'tr' ? 'tr-TR' : 'en-US', { hour: '2-digit', minute: '2-digit' }) : '';
  const saveLabel = saveState === 'saving'
    ? 'Kaydediliyor\u2026'
    : saveState === 'error'
      ? 'Kaydetme hatas\u0131'
      : saveState === 'offline'
        ? '\u00c7evrimd\u0131\u015f\u0131 - bekliyor'
        : saveTime ? 'Kaydedildi \u00b7 ' + saveTime : 'Kaydedildi';
  const saveTitle = saveState === 'saved' && saveTime ? 'Son ba\u015far\u0131l\u0131 kay\u0131t: ' + saveTime : saveLabel;
  return <header className="editor-topbar"><div className="topbar-left"><button className="back-button" disabled={backPending} aria-busy={backPending} onClick={onBack}>&#8249;</button><div className="editor-brand"><div className="mini-mark">CL</div><span>CUTLOC</span></div><div className="topbar-divider" /><input className="project-name-input" value={project.name} onChange={(event) => mutateProject((draft) => { draft.name = event.target.value; })} /></div><div className="topbar-center"><button className="history-button" onClick={undo} title="Geri al">&#8630;</button><button className="history-button" onClick={redo} title="Yinele">&#8631;</button><button className="topbar-command-button" onClick={onCommands} title={t('command.open')}><span>&#8981;</span><small>{t('command.title')}</small><kbd>&#8984; K</kbd></button><span className={'save-indicator ' + saveState} title={saveTitle} aria-live="polite"><i className={'status-dot ' + saveState} /> {saveLabel}</span></div><div className="topbar-right"><ThemeSwitcher compact /><button className="export-button" disabled={exporting} onClick={onExport}>{exporting ? 'Export\u2026' : 'D\u0131\u015fa aktar'} <Glyph>&#8599;</Glyph></button><button className="icon-button editor-settings" onClick={onSettings} title="Ayarlar"><Glyph>&#9881;</Glyph></button><button className="avatar-button" onClick={onSettings} title="Ayarlar">HK</button></div></header>;
}
// Legacy topbar body removed during merge; the live topbar is above.

function SettingsModal({ settings, onClose }: { settings: Settings | null; onClose: () => void }) {
  const { t } = useI18n();
  const setSettings = useEditor((state) => state.setSettings);
  const [form, setForm] = useState({
    language: settings?.language ?? 'en',
    proxyQuality: settings?.proxyQuality ?? 'balanced',
    hardwareAcceleration: settings?.hardwareAcceleration ?? 'software',
    defaultExport: {
      format: settings?.defaultExport?.format ?? 'mp4',
      aspect: settings?.defaultExport?.aspect ?? '16:9',
      resolution: settings?.defaultExport?.resolution ?? '1080p',
      fps: settings?.defaultExport?.fps ?? 30,
      quality: settings?.defaultExport?.quality ?? 'standard',
      audioBitrateKbps: settings?.defaultExport?.audioBitrateKbps ?? 192,
    },
    workspaceLayout: { ...DEFAULT_WORKSPACE_LAYOUT, ...(settings?.workspaceLayout ?? {}) },
    experimentalAi: false as const,
    shortcuts: { ...DEFAULT_SHORTCUTS, ...(settings?.shortcuts ?? {}) },
  });
  const [status, setStatus] = useState('');
  const [activeTab, setActiveTab] = useState<'general' | 'shortcuts'>('general');
  const save = async () => {
    setStatus(t('settings.saving'));
    try {
      const saved = await api<Settings>('/api/settings', { method: 'PUT', body: JSON.stringify(form) });
      setSettings(saved); setStatus(t('settings.saved')); window.setTimeout(onClose, 450);
    } catch (error) { setStatus(error instanceof Error ? error.message : t('settings.saveFailed')); }
  };
  const generalSettings = <>
    <label className="setting-row"><span><strong>{t('settings.language')}</strong><small>{t('settings.languageHint')}</small></span><select aria-label={t('settings.language')} value={form.language} onChange={(event) => setForm({ ...form, language: event.target.value as 'en' | 'tr' })}><option value="en">English</option><option value="tr">Türkçe</option></select></label>
    <label className="setting-row"><span><strong>{t('settings.resolution')}</strong><small>{t('settings.resolutionHint')}</small></span><select value={form.defaultExport.resolution} onChange={(event) => setForm({ ...form, defaultExport: { ...form.defaultExport, resolution: event.target.value as typeof form.defaultExport.resolution } })}><option value="720p">720p · 1280 × 720</option><option value="1080p">1080p · 1920 × 1080</option><option value="2K">1440p · 2560 × 1440</option><option value="4K">4K UHD · 3840 × 2160</option></select></label>
    <label className="setting-row"><span><strong>{t('settings.previewQuality')}</strong><small>{t('settings.previewQualityHint')}</small></span><select value={form.proxyQuality} onChange={(event) => setForm({ ...form, proxyQuality: event.target.value as 'draft' | 'balanced' | 'high' })}><option value="draft">{t('settings.previewQuality.draft')}</option><option value="balanced">{t('settings.previewQuality.balanced')}</option><option value="high">{t('settings.previewQuality.high')}</option></select></label>
    <div className="setting-row setting-readonly"><span><strong>{t('settings.encoder')}</strong><small>{t('settings.encoderHint')}</small></span><b>H.264 · CPU</b></div>
    <div className="workspace-settings-card"><div><strong>{t('settings.layout')}</strong><small>{t('settings.layoutHint')}</small></div><button type="button" className="shortcut-reset" onClick={() => setForm({ ...form, workspaceLayout: { ...DEFAULT_WORKSPACE_LAYOUT } })}>{t('settings.resetLayout')}</button></div>
  </>;
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="settings-modal"><div className="modal-head"><div><p className="eyebrow">{t('settings.workspace')}</p><h2>{t('settings.title')}</h2></div><button onClick={onClose} aria-label={t('common.close')}>×</button></div><div className="settings-tabs"><button className={activeTab === 'general' ? 'active' : ''} onClick={() => setActiveTab('general')}>{t('settings.general')}</button><button className={activeTab === 'shortcuts' ? 'active' : ''} onClick={() => setActiveTab('shortcuts')}>{t('settings.shortcuts')}</button></div>{activeTab === 'general' && generalSettings}{activeTab === 'shortcuts' && <div className="shortcut-settings"><div className="settings-intro"><strong>{t('settings.editShortcuts')}</strong><small>{t('settings.shortcutHint')}</small></div>{(Object.keys(SHORTCUT_LABELS) as ShortcutAction[]).map((action) => { const label = t(SHORTCUT_LABELS[action].labelKey); return <div className="shortcut-setting-row" key={action}><span><strong>{label}</strong><small>{t(SHORTCUT_LABELS[action].descriptionKey)}</small></span><kbd aria-label={t('settings.shortcutAria', { label })}>{DEFAULT_SHORTCUTS[action]}</kbd></div>; })}</div>}<div className="modal-actions"><span>{status}</span><button className="secondary-button" onClick={onClose}>{t('common.cancel')}</button><button className="primary-button" onClick={() => void save()}>{t('common.save')}</button></div></section></div>;
}

function panelTitle(panel: Panel): TranslationKey {
  const labels: Record<Panel, TranslationKey> = {
    media: 'editor.panel.media', text: 'editor.panel.text',
    project: 'editor.panel.project', transitions: 'editor.panel.transitions', effects: 'editor.panel.effects', color: 'editor.panel.color',
    animation: 'editor.panel.animation', help: 'editor.panel.help',
  };
  return labels[panel];
}

type WorkspaceResizeHandle = 'rail' | 'library' | 'inspector' | 'timeline';

function WorkspaceResizers({ layout, onPreview, onCommit }: { layout: WorkspaceLayout; onPreview: (next: WorkspaceLayout) => void; onCommit: (next: WorkspaceLayout) => void }) {
  const { t } = useI18n();
  const nudge = (handle: WorkspaceResizeHandle, direction: -1 | 1) => {
    const next = { ...layout };
    if (handle === 'rail') next.railWidth = clamp(layout.railWidth + direction * 8, 48, 96);
    if (handle === 'library') next.libraryWidth = clamp(layout.libraryWidth + direction * 12, 210, 420);
    if (handle === 'inspector') next.inspectorWidth = clamp(layout.inspectorWidth - direction * 12, 240, 460);
    if (handle === 'timeline') next.timelineHeight = clamp(layout.timelineHeight - direction * 12, 180, 460);
    onPreview(next);
    onCommit(next);
  };

  const beginResize = (handle: WorkspaceResizeHandle, event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const body = event.currentTarget.parentElement;
    if (!body) return;
    const rect = body.getBoundingClientRect();
    const start = { ...layout };
    let latest = start;
    const minPreviewWidth = 280;
    const minTopHeight = 260;
    const bound = (value: number, min: number, max: number) => clamp(value, min, Math.max(min, max));
    const update = (moveEvent: PointerEvent) => {
      const dx = moveEvent.clientX - event.clientX;
      const dy = moveEvent.clientY - event.clientY;
      const next = { ...start };
      if (handle === 'rail') next.railWidth = bound(start.railWidth + dx, 48, Math.min(96, rect.width - start.libraryWidth - start.inspectorWidth - minPreviewWidth));
      if (handle === 'library') next.libraryWidth = bound(start.libraryWidth + dx, 210, Math.min(420, rect.width - start.railWidth - start.inspectorWidth - minPreviewWidth));
      if (handle === 'inspector') next.inspectorWidth = bound(start.inspectorWidth - dx, 240, Math.min(460, rect.width - start.railWidth - start.libraryWidth - minPreviewWidth));
      if (handle === 'timeline') next.timelineHeight = bound(start.timelineHeight - dy, 180, Math.min(460, rect.height - minTopHeight));
      latest = next;
      onPreview(next);
    };
    const finish = () => {
      window.removeEventListener('pointermove', update);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      onCommit(latest);
    };
    document.body.style.cursor = handle === 'timeline' ? 'ns-resize' : 'ew-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', update);
    window.addEventListener('pointerup', finish, { once: true });
    window.addEventListener('pointercancel', finish, { once: true });
  };

  const handleKeyDown = (handle: WorkspaceResizeHandle, event: React.KeyboardEvent<HTMLDivElement>) => {
    const positive = event.key === 'ArrowRight' || event.key === 'ArrowDown';
    const negative = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
    if (!positive && !negative) return;
    event.preventDefault();
    nudge(handle, positive ? 1 : -1);
  };

  const resizer = (handle: WorkspaceResizeHandle, className: string, label: string, orientation: 'vertical' | 'horizontal') => <div className={`workspace-resizer ${className}`} role="separator" tabIndex={0} aria-label={label} aria-orientation={orientation} onPointerDown={(event) => beginResize(handle, event)} onKeyDown={(event) => handleKeyDown(handle, event)} />;
  return <>{resizer('rail', 'workspace-resizer-rail', t('workspace.resizeRail'), 'vertical')}{resizer('library', 'workspace-resizer-library', t('workspace.resizeLibrary'), 'vertical')}{resizer('inspector', 'workspace-resizer-inspector', t('workspace.resizeInspector'), 'vertical')}{resizer('timeline', 'workspace-resizer-timeline', t('workspace.resizeTimeline'), 'horizontal')}</>;
}

function ToolRail({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { t } = useI18n();
  const panel = useEditor((state) => state.panel); const setPanel = useEditor((state) => state.setPanel);
  const tools: Array<[Panel, string, TranslationKey]> = [
    ['media', '▧', 'editor.panel.media'], ['text', 'T', 'editor.panel.text'],
    ['animation', '✧', 'editor.panel.animation'], ['project', '◉', 'editor.panel.project'],
  ];
  return <aside className="tool-rail" aria-label={t('editor.tools')}><div className="rail-caption">{t('editor.project')}</div><div className="rail-scroll">{tools.map(([key, icon, label]) => <button key={key} className={panel === key ? 'active' : ''} onClick={() => setPanel(key)}><span>{icon}</span><small>{t(label)}</small></button>)}</div><div className="rail-spacer" /><button className="rail-ai" onClick={() => setPanel('help')}><span>?</span><small>{t('editor.panel.help')}</small></button><button onClick={onOpenSettings}><span>⚙</span><small>{t('common.settings')}</small></button></aside>;
}

function AssetPanel({ onImport }: { onImport: (file: File) => void }) {
  const { t } = useI18n();
  const panel = useEditor((state) => state.panel); const project = useEditor((state) => state.project)!;
  const fileRef = useRef<HTMLInputElement>(null);
  const addTextClip = (preset: TextPreset) => {
    const state = useEditor.getState();
    if (!state.project) return;
    const project = state.project;
    const track = project.tracks.find((item) => item.type === 'text') ?? project.tracks[0];
    const clip = createTextClip(preset, state.currentTime);
    let targetId = track?.id ?? null;
    state.mutateProject((draft) => { const target = targetId ? draft.tracks.find((item) => item.id === targetId) : undefined; const destination = target && !target.locked ? target : createLayerTrack(draft); targetId = destination.id; destination.clips.push(clip); draft.duration = projectDuration(draft); });
    useEditor.getState().setSelected(clip.id, targetId);
  };
  const title = t(panelTitle(panel));
  return <aside className="asset-panel"><div className="panel-heading"><div><p className="eyebrow">Kütüphane</p><h2>{title}</h2></div><button className="panel-more">•••</button></div>{panel === 'media' ? <><button className="import-zone" onClick={() => fileRef.current?.click()}><span className="import-icon">＋</span><strong>Medya içe aktar</strong><small>Video, ses veya görsel seç</small></button><input ref={fileRef} className="hidden-input" type="file" accept="video/*,audio/*,image/*" onChange={(event) => { const file = event.target.files?.[0]; if (file) onImport(file); event.target.value = ''; }} /><div className="asset-filter"><span>Proje medyası</span><span>{project.assets.length}</span></div><div className="asset-list">{project.assets.length === 0 ? <div className="panel-empty"><span>▱</span><p>Henüz medya yok</p><small>Dosyalarını buraya ekle</small></div> : project.assets.map((asset) => <AssetItem key={asset.id} asset={asset} />)}</div></> : <PanelContent panel={panel} onAddText={addTextClip} onImport={onImport} onApplyEffect={() => undefined} onOpenSettings={() => undefined} />}</aside>;
}

function AssetItem({ asset }: { asset: Asset }) {
  const icon = asset.type === 'video' ? '▶' : asset.type === 'audio' ? '♫' : '▧';
  const meta = asset.duration ? formatTime(asset.duration) : asset.mimeType.split('/')[1]?.toUpperCase() || 'MEDIA';
  return <div className="asset-item"><div className={`asset-thumb ${asset.type}`}><span>{icon}</span><small>{meta}</small></div><div className="asset-info"><strong title={asset.name}>{asset.name}</strong><small>{asset.width && asset.height ? `${asset.width} × ${asset.height}` : asset.type}</small></div><button className="asset-dots">•••</button></div>;
}

/**
 * Asset library UX: importing only registers an asset. A file is inserted into
 * the timeline after the explicit "Add to timeline" action in its menu.
 */
function mediaTrackType(asset: Asset): Track['type'] { return asset.type === 'audio' ? 'audio' : asset.type === 'image' ? 'overlay' : 'video'; }

const TRACK_TYPE_NAMES: Record<Track['type'], string> = { layer: 'Layer', video: 'Video', overlay: 'Overlay', audio: 'Audio', text: 'Text', subtitle: 'Subtitle' };

function createLayerTrack(draft: Project, name?: string): Track {
  const index = draft.tracks.length;
  const track: Track = { id: `track-layer-${crypto.randomUUID().slice(0, 8)}`, type: 'layer', name: name ?? `Layer ${index + 1}`, order: index, clips: [], locked: false, hidden: false, muted: false, volume: 1 };
  draft.tracks.push(track);
  return track;
}

function trackIcon(type: Track['type']) {
  if (type === 'audio') return '♫';
  if (type === 'text') return 'T';
  if (type === 'subtitle') return '≡';
  if (type === 'video') return '▧';
  if (type === 'overlay') return '◈';
  return '◫';
}

function createMediaClip(asset: Asset, start: number): Clip {
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
function createAdjustmentClip(start: number, duration = 5): Clip {
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
function findEmptyPlacement(project: Project, duration: number, desiredStart: number, preferredTrackId?: string | null) {
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

function createTextClip(preset: TextPreset, start: number): Clip {
  const textStyle: NonNullable<Clip['textStyle']> = {
    ...DEFAULT_TEXT_STYLE,
    text: preset.text,
    fontFamily: preset.fontFamily,
    fontSize: preset.fontSize,
    fontWeight: preset.fontWeight,
    fontStyle: preset.fontStyle,
    letterSpacing: preset.letterSpacing ?? 0,
    color: preset.color,
    background: preset.background,
    stroke: preset.stroke,
    strokeWidth: preset.strokeWidth,
    shadow: preset.shadow,
    align: preset.align,
  };
  return {
    id: `text_${crypto.randomUUID().slice(0, 8)}`,
    type: 'text',
    name: preset.label,
    start: Math.max(0, start),
    duration: 4,
    sourceStart: 0,
    sourceDuration: 4,
    speed: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, fit: 'contain', flipX: false, flipY: false },
    filters: { brightness: 0, contrast: 0, saturation: 0, blur: 0, grayscale: 0 },
    // Text appears immediately by default.  Fade is an explicit creative choice
    // in the Animation studio, never a hidden side effect of inserting text.
    transitionIn: { type: 'none', duration: 0 },
    transitionOut: { type: 'none', duration: 0 },
    volume: 1,
    adjustment: false,
    keyframes: [],
    textStyle,
  };
}

function AssetPanelEnhanced({ onImport, onOpenSettings }: { onImport: (file: File) => void; onOpenSettings: () => void }) {
  const { t } = useI18n();
  const panel = useEditor((state) => state.panel);
  const project = useEditor((state) => state.project)!;
  const currentTime = useEditor((state) => state.currentTime);
  const mutateProject = useEditor((state) => state.mutateProject);
  const setSelected = useEditor((state) => state.setSelected);
  const setEditorNotice = useEditor((state) => state.setNotice);
  const fileRef = useRef<HTMLInputElement>(null);
  const [panelMenuOpen, setPanelMenuOpen] = useState(false);
  const [assetMenuId, setAssetMenuId] = useState<string | null>(null);
  const [assetSearch, setAssetSearch] = useState('');
  const [assetFilter, setAssetFilter] = useState<'all' | Asset['type']>('all');
  const [assetSort, setAssetSort] = useState<'name' | 'date' | 'duration'>('date');
  const [assetView, setAssetView] = useState<'grid' | 'list'>('list');
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; asset: Asset } | null>(null);

  const refreshProject = async () => {
    try {
      const fresh = await api<Project>(`/api/projects/${project.id}`);
      useEditor.getState().setProject(normalizeProjectDurations(fresh));
    } catch {
      // Keep the current in-memory project when a refresh races with a save.
    } finally {
      setPanelMenuOpen(false);
    }
  };

  const showAssetInfo = (asset: Asset) => {
    const dimensions = asset.width && asset.height ? `\nBoyut: ${asset.width} × ${asset.height}` : '';
    const duration = asset.duration ? `\nSüre: ${formatTime(asset.duration)}` : '';
    setEditorNotice(`${asset.name} · ${asset.mimeType}${dimensions}${duration} · ${asset.size.toLocaleString('tr-TR')} bayt`);
    setAssetMenuId(null);
  };

  const addAssetToTimeline = (asset: Asset) => {
    const state = useEditor.getState();
    const currentProject = state.project;
    if (!currentProject) return;
    const targetTrack = currentProject.tracks.find((track) => !track.locked);
    const targetTrackId = targetTrack?.id ?? `track-layer-${crypto.randomUUID().slice(0, 8)}`;
    const clip = createMediaClip(asset, currentTime);
    mutateProject((draft) => {
      let track = draft.tracks.find((item) => item.id === targetTrackId);
      if (!track) {
        track = { id: targetTrackId, type: 'layer', name: `Layer ${draft.tracks.length + 1}`, order: draft.tracks.length, clips: [], locked: false, hidden: false, muted: false, volume: 1 };
        draft.tracks.push(track);
      }
      if (track.locked) return;
      track.clips.push(clip);
      draft.duration = projectDuration(draft);
    });
    setSelected(clip.id, targetTrackId);
    setAssetMenuId(null);
  };

  const addTextClip = (preset: TextPreset) => {
    const state = useEditor.getState();
    if (!state.project) return;
    const target = state.project.tracks.find((track) => !track.locked);
    const clip = createTextClip(preset, state.currentTime);
    let targetId = target?.id ?? null;
    mutateProject((draft) => { const track = targetId ? draft.tracks.find((item) => item.id === targetId) : undefined; const targetTrack = track && !track.locked ? track : createLayerTrack(draft); targetId = targetTrack.id; targetTrack.clips.push(clip); draft.duration = projectDuration(draft); });
    setSelected(clip.id, targetId);
  };

  const applyEffect = (preset: 'film' | 'retro' | 'glow' | 'blur' | 'chroma' | 'noise') => {
    const selectedClipId = useEditor.getState().selectedClipId;
    if (!selectedClipId) {
      setEditorNotice('Önce timeline üzerinde bir klip seçin.');
      return;
    }
    mutateProject((draft) => {
      const clip = draft.tracks.flatMap((track) => track.clips).find((item) => item.id === selectedClipId);
      if (!clip) return;
      if (preset === 'film') { clip.filters.brightness = -0.05; clip.filters.contrast = 0.12; clip.filters.saturation = -0.1; }
      if (preset === 'retro') { clip.filters.brightness = 0.04; clip.filters.contrast = 0.08; clip.filters.saturation = -0.22; }
      if (preset === 'glow') { clip.filters.brightness = 0.1; clip.filters.contrast = 0.04; clip.filters.saturation = 0.16; clip.filters.blur = 1.5; }
      if (preset === 'blur') clip.filters.blur = 8;
      if (preset === 'chroma') clip.filters.chromaKey = { color: '#00ff00', similarity: 0.35, blend: 0.1 };
      if (preset === 'noise') { clip.filters.contrast = 0.12; clip.filters.grayscale = 0.08; }
    });
  };

  const title = t(panelTitle(panel));
  return <aside className="asset-panel" onClick={() => { setPanelMenuOpen(false); setAssetMenuId(null); }}>
    <div className="panel-heading"><div><p className="eyebrow">Kütüphane</p><h2>{title}</h2></div><div className="panel-menu-wrap"><button className="panel-more" aria-label="Panel menüsü" onClick={(event) => { event.stopPropagation(); setPanelMenuOpen((open) => !open); }}>•••</button>{panelMenuOpen && <div className="floating-menu panel-menu" onClick={(event) => event.stopPropagation()}><button onClick={() => { setPanelMenuOpen(false); fileRef.current?.click(); }}>＋ Dosya içe aktar</button><button onClick={() => { void refreshProject(); }}>⌘ Kütüphaneyi yenile</button><button onClick={() => { setPanelMenuOpen(false); onOpenSettings(); }}>⚙ Panel ayarları</button></div>}</div></div>
    {panel === 'media' ? <><button className="import-zone" onClick={() => fileRef.current?.click()}><span className="import-icon">＋</span><strong>Medya içe aktar</strong><small>Video, ses veya görsel seç</small></button><input ref={fileRef} className="hidden-input" type="file" accept="video/*,audio/*,image/*" onChange={(event) => { const file = event.target.files?.[0]; if (file) onImport(file); event.target.value = ''; }} /><div className="asset-filter"><span>Proje medyası</span><span>{project.assets.length}</span></div><div className="asset-list">{project.assets.length === 0 ? <div className="panel-empty"><span>▱</span><p>Henüz medya yok</p><small>Dosyalarını buraya ekle</small></div> : project.assets.map((asset) => <AssetItemEnhanced key={asset.id} asset={asset} menuOpen={assetMenuId === asset.id} onToggleMenu={() => setAssetMenuId((open) => open === asset.id ? null : asset.id)} onAddToTimeline={() => addAssetToTimeline(asset)} onShowInfo={() => showAssetInfo(asset)} />)}</div></> : <PanelContent panel={panel} onAddText={addTextClip} onImport={onImport} onApplyEffect={applyEffect} onOpenSettings={onOpenSettings} />}
  </aside>;
}

function AssetItemEnhanced({ asset, menuOpen, onToggleMenu, onAddToTimeline, onShowInfo }: { asset: Asset; menuOpen: boolean; onToggleMenu: () => void; onAddToTimeline: () => void; onShowInfo: () => void }) {
  const icon = asset.type === 'video' ? '▶' : asset.type === 'audio' ? '♫' : '▧';
  const meta = asset.duration ? formatTime(asset.duration) : asset.mimeType.split('/')[1]?.toUpperCase() || 'MEDIA';
  return <div className="asset-item" onClick={(event) => event.stopPropagation()}><div className={`asset-thumb ${asset.type}`}><span>{icon}</span><small>{meta}</small></div><div className="asset-info"><strong title={asset.name}>{asset.name}</strong><small>{asset.width && asset.height ? `${asset.width} × ${asset.height}` : asset.type}</small></div><div className="asset-menu-wrap"><button className="asset-dots" aria-label={`${asset.name} menüsü`} onClick={onToggleMenu}>•••</button>{menuOpen && <div className="floating-menu asset-menu"><button onClick={onAddToTimeline}>＋ Timeline'a ekle</button><button onClick={() => { void navigator.clipboard?.writeText(asset.name); onToggleMenu(); }}>⧉ Adı kopyala</button><button onClick={onShowInfo}>ⓘ Medya bilgisi</button></div>}</div></div>;
}

type TransitionPreset = 'none' | 'fade' | 'dissolve' | 'slide' | 'wipe' | 'zoom';
type AnimationApplyMode = 'in' | 'out' | 'both';
type TransitionDirection = 'left' | 'right' | 'up' | 'down' | 'center';
type TransitionEasing = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out';
type AnimationCategory = 'all' | 'cut' | 'soft' | 'motion' | 'focus';
type AnimationPreset = {
  id: string;
  labelKey: TranslationKey;
  descriptionKey: TranslationKey;
  type: TransitionPreset;
  category: Exclude<AnimationCategory, 'all'>;
  motionDirection: TransitionDirection;
  directionKey: TranslationKey;
  duration: number;
};

const ANIMATION_PRESETS: AnimationPreset[] = [
  { id: 'none', labelKey: 'preset.animation.none.label', descriptionKey: 'preset.animation.none.description', type: 'none', category: 'cut', motionDirection: 'center', directionKey: 'preset.animation.none.direction', duration: 0 },
  { id: 'fade', labelKey: 'preset.animation.fade.label', descriptionKey: 'preset.animation.fade.description', type: 'fade', category: 'soft', motionDirection: 'center', directionKey: 'preset.animation.fade.direction', duration: 0.35 },
  { id: 'dissolve', labelKey: 'preset.animation.dissolve.label', descriptionKey: 'preset.animation.dissolve.description', type: 'dissolve', category: 'soft', motionDirection: 'center', directionKey: 'preset.animation.dissolve.direction', duration: 0.45 },
  { id: 'slide-left', labelKey: 'preset.animation.slide-left.label', descriptionKey: 'preset.animation.slide-left.description', type: 'slide', category: 'motion', motionDirection: 'left', directionKey: 'preset.animation.slide-left.direction', duration: 0.4 },
  { id: 'slide-right', labelKey: 'preset.animation.slide-right.label', descriptionKey: 'preset.animation.slide-right.description', type: 'slide', category: 'motion', motionDirection: 'right', directionKey: 'preset.animation.slide-right.direction', duration: 0.4 },
  { id: 'slide-up', labelKey: 'preset.animation.slide-up.label', descriptionKey: 'preset.animation.slide-up.description', type: 'slide', category: 'motion', motionDirection: 'down', directionKey: 'preset.animation.slide-up.direction', duration: 0.4 },
  { id: 'slide-down', labelKey: 'preset.animation.slide-down.label', descriptionKey: 'preset.animation.slide-down.description', type: 'slide', category: 'motion', motionDirection: 'up', directionKey: 'preset.animation.slide-down.direction', duration: 0.4 },
  { id: 'wipe', labelKey: 'preset.animation.wipe.label', descriptionKey: 'preset.animation.wipe.description', type: 'wipe', category: 'motion', motionDirection: 'left', directionKey: 'preset.animation.wipe.direction', duration: 0.4 },
  { id: 'zoom', labelKey: 'preset.animation.zoom.label', descriptionKey: 'preset.animation.zoom.description', type: 'zoom', category: 'focus', motionDirection: 'center', directionKey: 'preset.animation.zoom.direction', duration: 0.45 },
];
type BackupSummary = { fileName: string; createdAt: string; size: number };

type HelpTopicId = 'start' | 'media' | 'preview' | 'motion' | 'timeline' | 'export';
type HelpTopic = {
  id: HelpTopicId;
  icon: string;
  labelKey: TranslationKey;
  titleKey: TranslationKey;
  summaryKey: TranslationKey;
  stepKeys: TranslationKey[];
  actionLabelKey: TranslationKey;
  actionPanel?: Panel;
  actionNotice?: string;
};

const HELP_TOPICS: HelpTopic[] = [
  {
    id: 'start', icon: '✦', labelKey: 'help.topic.start.label', titleKey: 'help.topic.start.title', summaryKey: 'help.topic.start.summary',
    stepKeys: ['help.topic.start.step1', 'help.topic.start.step2', 'help.topic.start.step3'], actionLabelKey: 'help.topic.start.action', actionPanel: 'media',
  },
  {
    id: 'media', icon: '▧', labelKey: 'help.topic.media.label', titleKey: 'help.topic.media.title', summaryKey: 'help.topic.media.summary',
    stepKeys: ['help.topic.media.step1', 'help.topic.media.step2', 'help.topic.media.step3'], actionLabelKey: 'help.topic.media.action', actionPanel: 'media',
  },
  {
    id: 'preview', icon: '⌖', labelKey: 'help.topic.preview.label', titleKey: 'help.topic.preview.title', summaryKey: 'help.topic.preview.summary',
    stepKeys: ['help.topic.preview.step1', 'help.topic.preview.step2', 'help.topic.preview.step3'], actionLabelKey: 'help.topic.preview.action', actionPanel: 'text',
  },
  {
    id: 'motion', icon: '↝', labelKey: 'help.topic.motion.label', titleKey: 'help.topic.motion.title', summaryKey: 'help.topic.motion.summary',
    stepKeys: ['help.topic.motion.step1', 'help.topic.motion.step2', 'help.topic.motion.step3'], actionLabelKey: 'help.topic.motion.action', actionPanel: 'animation',
  },
  {
    id: 'timeline', icon: '⌁', labelKey: 'help.topic.timeline.label', titleKey: 'help.topic.timeline.title', summaryKey: 'help.topic.timeline.summary',
    stepKeys: ['help.topic.timeline.step1', 'help.topic.timeline.step2', 'help.topic.timeline.step3'], actionLabelKey: 'help.topic.timeline.action', actionPanel: 'project',
  },
  {
    id: 'export', icon: '↗', labelKey: 'help.topic.export.label', titleKey: 'help.topic.export.title', summaryKey: 'help.topic.export.summary',
    stepKeys: ['help.topic.export.step1', 'help.topic.export.step2', 'help.topic.export.step3'], actionLabelKey: 'help.topic.export.action', actionPanel: 'project',
  },
];

function PanelContent({ panel, onAddText, onImport, onApplyEffect, onApplyTransition, onOpenSettings }: { panel: Panel; onAddText: (preset: TextPreset) => void; onImport: (file: File) => void; onApplyEffect: (preset: 'film' | 'retro' | 'glow' | 'blur' | 'chroma' | 'noise') => void; onApplyTransition?: (preset: TransitionPreset) => void; onOpenSettings: () => void }) {
  const { t, locale } = useI18n();
  const project = useEditor((state) => state.project);
  const currentSettings = useEditor((state) => state.settings);
  const mutateProject = useEditor((state) => state.mutateProject);
  const setNotice = useEditor((state) => state.setNotice);
  const setPanel = useEditor((state) => state.setPanel);
  const [backups, setBackups] = useState<BackupSummary[]>([]);
  const [textSearch, setTextSearch] = useState('');
  const [textCategory, setTextCategory] = useState<'all' | TextPreset['category']>('all');
  const [helpTopicId, setHelpTopicId] = useState<HelpTopicId>('start');
  const [helpSearch, setHelpSearch] = useState('');
  const localizedTextPresets = TEXT_PRESETS.map((preset) => localizeTextPreset(preset, t));
  const filteredTextPresets = localizedTextPresets.filter((preset) => {
    const query = textSearch.trim().toLocaleLowerCase(locale);
    return (!query || `${preset.label} ${preset.description} ${preset.text}`.toLocaleLowerCase(locale).includes(query)) && (textCategory === 'all' || preset.category === textCategory);
  });
  useEffect(() => {
    if (panel !== 'project' || !project) return;
    let active = true;
    void api<BackupSummary[]>('/api/projects/' + project.id + '/backups')
      .then((items) => { if (active) setBackups(items); })
      .catch(() => { if (active) setBackups([]); });
    return () => { active = false; };
  }, [panel, project?.id]);
  const restoreBackup = async (fileName: string) => {
    if (!project || !window.confirm(t('backup.confirm'))) return;
    try {
      const restored = await api<Project>('/api/projects/' + project.id + '/restore', { method: 'POST', body: JSON.stringify({ fileName }) });
      useEditor.getState().setProject(restored);
      useEditor.getState().setSaveState('saved');
      setNotice(t('backup.restored'));
    } catch (error) {
      setNotice(error instanceof Error ? t('backup.restoreFailedWithReason', { reason: error.message }) : t('backup.restoreFailed'));
    }
  };
  if (panel === 'help') {
    const query = helpSearch.trim().toLocaleLowerCase(locale);
    const matchingTopics = HELP_TOPICS.filter((topic) => !query || `${t(topic.labelKey)} ${t(topic.titleKey)} ${t(topic.summaryKey)} ${topic.stepKeys.map((key) => t(key)).join(' ')}`.toLocaleLowerCase(locale).includes(query));
    const activeTopic = matchingTopics.find((topic) => topic.id === helpTopicId) ?? matchingTopics[0];
    const openHelpAction = (topic: HelpTopic) => {
      if (topic.actionPanel) setPanel(topic.actionPanel);
      if (topic.actionNotice) setNotice(topic.actionNotice);
    };
    return <div className="quick-panel help-panel">
      <div className="help-hero"><div><p className="eyebrow">{t('help.center')}</p><h3>{t('help.title')}</h3><small>{t('help.copy')}</small></div><span className="help-hero-mark">?</span></div>
      <label className="help-search-field"><span>⌕</span><input value={helpSearch} onChange={(event) => setHelpSearch(event.target.value)} placeholder={t('help.search')} aria-label={t('help.search')} /></label>
      <div className="help-topic-tabs" role="tablist" aria-label={t('help.topics')}>{matchingTopics.map((topic) => <button key={topic.id} type="button" role="tab" aria-selected={activeTopic?.id === topic.id} className={activeTopic?.id === topic.id ? 'active' : ''} onClick={() => setHelpTopicId(topic.id)}><span>{topic.icon}</span>{t(topic.labelKey)}</button>)}</div>
      {activeTopic ? <article className="help-topic-card"><div className="help-topic-heading"><span className="help-topic-icon">{activeTopic.icon}</span><div><p className="eyebrow">{t(activeTopic.labelKey)}</p><h4>{t(activeTopic.titleKey)}</h4><p>{t(activeTopic.summaryKey)}</p></div></div><ol className="help-steps">{activeTopic.stepKeys.map((key, index) => <li key={key}><b>{index + 1}</b><span>{t(key)}</span></li>)}</ol><button type="button" className="help-open-action" onClick={() => openHelpAction(activeTopic)}>{t(activeTopic.actionLabelKey)}<span>→</span></button></article> : <div className="help-empty"><strong>{t('help.noResult')}</strong><small>{t('help.noResultCopy')}</small></div>}
      <section className="help-section"><div className="help-section-heading"><div><strong>{t('settings.shortcuts')}</strong><small>{t('help.shortcutsCopy')}</small></div><button type="button" onClick={onOpenSettings}>{t('help.openSettings')}</button></div><div className="help-shortcut-grid">{(Object.keys(SHORTCUT_LABELS) as ShortcutAction[]).map((action) => <div className="help-shortcut" key={action}><kbd>{shortcutValue(currentSettings, action)}</kbd><span><strong>{t(SHORTCUT_LABELS[action].labelKey)}</strong><small>{t(SHORTCUT_LABELS[action].descriptionKey)}</small></span></div>)}</div></section>
      <section className="help-section"><div className="help-section-heading"><div><strong>{t('help.quickTips')}</strong><small>{t('help.quickTipsCopy')}</small></div></div><div className="help-tip-grid"><button type="button" className="help-tip-card" onClick={() => { setNotice(t('help.selectCanvasNotice')); setPanel('text'); }}><span>⌖</span><strong>{t('help.selectCanvas')}</strong><small>{t('help.selectCanvasCopy')}</small></button><button type="button" className="help-tip-card" onClick={() => setPanel('animation')}><span>↝</span><strong>{t('help.addMotion')}</strong><small>{t('help.addMotionCopy')}</small></button><button type="button" className="help-tip-card" onClick={() => setPanel('media')}><span>▧</span><strong>{t('help.addShape')}</strong><small>{t('help.addShapeCopy')}</small></button></div></section>
      <p className="panel-note">{t('help.exportReminder')}</p>
    </div>;
  }
  if (panel === 'project') return <div className="quick-panel project-tools-panel">
    <ProjectBackupPanel backups={backups} onRestore={restoreBackup} />
    <div className="text-library-head"><div><strong>{t('projectTools.title')}</strong><small>{t('projectTools.copy')}</small></div><span>⌘</span></div>
    <div className="project-tool-card"><div><strong>{t('projectTools.background')}</strong><small>{t('projectTools.backgroundCopy')}</small></div><input type="color" value={project?.canvas.background?.slice(0, 7) === 'transpa' ? '#101116' : project?.canvas.background ?? '#101116'} onChange={(event) => mutateProject((draft) => { draft.canvas.background = event.target.value; })} /></div>
    <div className="project-background-grid"><button onClick={() => mutateProject((draft) => { draft.canvas.background = '#101116'; })}>{t('projectTools.black')}</button><button onClick={() => mutateProject((draft) => { draft.canvas.background = '#f3f4f1'; })}>{t('projectTools.white')}</button><button onClick={() => mutateProject((draft) => { draft.canvas.background = '#7b8088'; })}>{t('projectTools.gray')}</button><button onClick={() => mutateProject((draft) => { draft.canvas.background = 'transparent'; })}>{t('projectTools.transparent')}</button></div>
    <div className="project-tool-list"><button onClick={() => setNotice(t('projectTools.timelineGuideNotice'))}>⌁ {t('projectTools.timelineGuide')} <span>›</span></button><button onClick={() => { if (project) window.location.href = `/api/projects/${project.id}/bundle`; }}>⇩ {t('projectTools.downloadBundle')} <span>›</span></button><button onClick={onOpenSettings}>⚙ {t('projectTools.workspaceSettings')} <span>›</span></button></div>
  </div>;
  if (panel === 'transitions' || panel === 'animation') return <AnimationStudio />;
  if (panel === 'color') return <div className="quick-panel">
    <div className="text-library-head"><div><strong>{t('color.title')}</strong><small>{t('color.copy')}</small></div><span>6</span></div>
    <div className="effect-grid"><button onClick={() => onApplyEffect('film')}>◌<small>Film</small></button><button onClick={() => onApplyEffect('retro')}>◍<small>Retro</small></button><button onClick={() => onApplyEffect('glow')}>◈<small>Glow</small></button><button onClick={() => onApplyEffect('blur')}>◇<small>{t('effects.blur')}</small></button><button onClick={() => onApplyEffect('noise')}>◒<small>Mono</small></button><button onClick={() => onApplyEffect('chroma')}>⌁<small>Chroma</small></button></div>
    <p className="panel-note">{t('effects.selectClip')}</p>
  </div>;
  if (panel === 'text') {
    const quickStarts = ['clean-title', 'lower-third', 'quote'].map((id) => localizedTextPresets.find((preset) => preset.id === id) ?? localizedTextPresets[0]);
    return <div className="quick-panel text-library text-studio">
      <button className="text-primary-action" onClick={() => onAddText(localizedTextPresets[0])}><span>＋</span><div><strong>{t('text.addBlank')}</strong><small>{t('text.addBlankCopy')}</small></div><b>↗</b></button>
      <div className="text-section-label"><span>{t('text.quickStart')}</span><small>{t('text.oneClick')}</small></div>
      <div className="text-quick-starts">{quickStarts.map((preset) => <button key={preset.id} className={`text-quick-card text-quick-${preset.id}`} onClick={() => onAddText(preset)}><span style={{ fontFamily: preset.fontFamily, fontWeight: preset.fontWeight, fontStyle: preset.fontStyle }}>{preset.text}</span><strong>{preset.label}</strong><small>{preset.description}</small><i>＋</i></button>)}</div>
      <div className="text-library-head text-library-section-head"><div><strong>{t('text.library')}</strong><small>{t('text.libraryCopy')}</small></div><span>{filteredTextPresets.length}</span></div>
      <input className="media-search text-search" value={textSearch} onChange={(event) => setTextSearch(event.target.value)} placeholder={t('text.search')} aria-label={t('text.searchAria')} />
      <div className="text-category-chips">{(['all', 'title', 'social', 'card', 'accent'] as const).map((category) => <button key={category} className={textCategory === category ? 'active' : ''} onClick={() => setTextCategory(category)}>{category === 'all' ? t('library.category.all') : t(`text.category.${category}` as TranslationKey)}</button>)}</div>
      <div className="text-preset-grid">{filteredTextPresets.map((preset) => <button key={preset.id} className="text-preset-card" onClick={() => onAddText(preset)}><span className="text-preset-sample" style={{ fontFamily: preset.fontFamily, fontSize: `${Math.max(18, preset.fontSize / 2.75)}px`, fontWeight: preset.fontWeight, fontStyle: preset.fontStyle, color: preset.color, background: preset.background, textAlign: preset.align, lineHeight: 1.05, WebkitTextStroke: `${Math.min(1.5, preset.strokeWidth / 2)}px ${preset.stroke}` }}>{preset.text}</span><span className="text-preset-meta"><strong>{preset.label}</strong><small>{t(`text.category.${preset.category}` as TranslationKey)} · {preset.description}</small></span><i aria-hidden="true">＋</i></button>)}</div>
      <div className="text-studio-tip"><span>✦</span><p><strong>{t('text.tip')}</strong><small>{t('text.tipCopy')}</small></p></div>
    </div>;
  }
  return <div className="quick-panel"><div className="panel-placeholder-card"><span>✦</span><div><strong>{t('effects.title')}</strong><small>{t('effects.copy')}</small></div></div><div className="effect-grid"><button onClick={() => onApplyEffect('film')}>◌<small>Film</small></button><button onClick={() => onApplyEffect('retro')}>◍<small>Retro</small></button><button onClick={() => onApplyEffect('glow')}>◈<small>Glow</small></button><button onClick={() => onApplyEffect('blur')}>◇<small>Blur</small></button><button onClick={() => onApplyEffect('chroma')}>⌁<small>Chroma</small></button><button onClick={() => onApplyEffect('noise')}>◒<small>Mono</small></button></div><p className="panel-note">{t('effects.clickPreset')}</p></div>;
}

function AnimationStudio() {
  const { t } = useI18n();
  const project = useEditor((state) => state.project);
  const selectedClipId = useEditor((state) => state.selectedClipId);
  const selectedClipIds = useEditor((state) => state.selectedClipIds);
  const mutateProject = useEditor((state) => state.mutateProject);
  const setNotice = useEditor((state) => state.setNotice);
  const [mode, setMode] = useState<AnimationApplyMode>('in');
  const [category, setCategory] = useState<AnimationCategory>('all');
  const [inDuration, setInDuration] = useState(0.4);
  const [outDuration, setOutDuration] = useState(0.4);
  const [linkDurations, setLinkDurations] = useState(false);
  const [easing, setEasing] = useState<TransitionEasing>('ease-in-out');
  const [direction, setDirection] = useState<TransitionDirection>('left');
  const [intensity, setIntensity] = useState(1);
  const [activePresetId, setActivePresetId] = useState('fade');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const selected = project?.tracks.flatMap((track) => track.clips).find((clip) => clip.id === selectedClipId);
  const visiblePresets = category === 'all' ? ANIMATION_PRESETS : ANIMATION_PRESETS.filter((preset) => preset.category === category);
  const selectedIds = selectedClipIds.length ? selectedClipIds : selected ? [selected.id] : [];

  useEffect(() => {
    if (!selected) return;
    const incoming = selected.transitionIn ?? { type: 'none', duration: 0 };
    const outgoing = selected.transitionOut ?? { type: 'none', duration: 0 };
    setInDuration(incoming.duration ?? 0);
    setOutDuration(outgoing.duration ?? 0);
    setEasing((incoming.easing ?? outgoing.easing ?? 'ease-in-out') as TransitionEasing);
    setDirection((incoming.direction ?? outgoing.direction ?? 'left') as TransitionDirection);
    setIntensity(clamp(incoming.intensity ?? outgoing.intensity ?? 1, 0.1, 2));
    const activeTransition = mode === 'out' ? outgoing : incoming;
    const bothMatch = (incoming.type ?? 'none') === (outgoing.type ?? 'none') && (incoming.type !== 'slide' || (incoming.direction ?? 'left') === (outgoing.direction ?? 'left'));
    const current = mode === 'both' && !bothMatch ? undefined : ANIMATION_PRESETS.find((preset) => preset.type === (activeTransition.type ?? 'none') && (preset.type !== 'slide' || preset.motionDirection === (activeTransition.direction ?? 'left')));
    if (current) setActivePresetId(current.id);
  }, [
    selected?.id,
    selected?.transitionIn?.type,
    selected?.transitionIn?.duration,
    selected?.transitionIn?.direction,
    selected?.transitionIn?.easing,
    selected?.transitionIn?.intensity,
    selected?.transitionOut?.type,
    selected?.transitionOut?.duration,
    selected?.transitionOut?.direction,
    selected?.transitionOut?.easing,
    selected?.transitionOut?.intensity,
    mode,
  ]);

  const isActive = (preset: AnimationPreset) => {
    if (!selected) return false;
    const inType = selected.transitionIn?.type ?? 'none';
    const outType = selected.transitionOut?.type ?? 'none';
    const inDirection = selected.transitionIn?.direction ?? 'left';
    const outDirection = selected.transitionOut?.direction ?? 'left';
    const matches = (type: TransitionPreset, value: TransitionDirection) => type === preset.type && (preset.type !== 'slide' || value === preset.motionDirection);
    if (mode === 'in') return matches(inType, inDirection);
    if (mode === 'out') return matches(outType, outDirection);
    return matches(inType, inDirection) && matches(outType, outDirection);
  };

  const apply = (preset: AnimationPreset, directionOverride = preset.motionDirection) => {
    if (!selectedIds.length) {
      setNotice(t('animation.selectClipNotice'));
      return;
    }
    const nextInDuration = preset.type === 'none' ? 0 : Math.max(0.1, inDuration || preset.duration);
    const nextOutDuration = preset.type === 'none' ? 0 : Math.max(0.1, outDuration || preset.duration);
    const makeTransition = (duration: number, clip: Clip): Clip['transitionIn'] => ({
      type: preset.type,
      duration: Math.min(Math.min(5, clip.duration), duration),
      direction: directionOverride,
      easing,
      intensity: clamp(intensity, 0.1, 2),
    });
    mutateProject((draft) => {
      for (const track of draft.tracks) {
        for (const clip of track.clips) {
          if (!selectedIds.includes(clip.id)) continue;
          if (mode === 'in' || mode === 'both') clip.transitionIn = makeTransition(nextInDuration, clip);
          if (mode === 'out' || mode === 'both') clip.transitionOut = makeTransition(nextOutDuration, clip);
        }
      }
    });
    setNotice(t(mode === 'both' ? 'animation.appliedBoth' : mode === 'in' ? 'animation.appliedIn' : 'animation.appliedOut', { name: t(preset.labelKey) }));
  };
  const applyAdvanced = () => {
    const preset = ANIMATION_PRESETS.find((item) => item.id === activePresetId) ?? ANIMATION_PRESETS[1];
    apply(preset, direction);
  };
  const updateSelectedDurations = (nextInDuration: number, nextOutDuration: number) => {
    if (!selectedIds.length) return;
    mutateProject((draft) => {
      for (const track of draft.tracks) {
        for (const clip of track.clips) {
          if (!selectedIds.includes(clip.id)) continue;
          const maxDuration = Math.min(5, clip.duration);
          if (mode === 'in' || mode === 'both') clip.transitionIn.duration = Math.min(maxDuration, Math.max(0, nextInDuration));
          if (mode === 'out' || mode === 'both') clip.transitionOut.duration = Math.min(maxDuration, Math.max(0, nextOutDuration));
        }
      }
    });
  };
  const changeInDuration = (value: number) => {
    const nextOutDuration = linkDurations ? value : outDuration;
    setInDuration(value);
    if (linkDurations) setOutDuration(value);
    updateSelectedDurations(value, nextOutDuration);
  };
  const changeOutDuration = (value: number) => {
    const nextInDuration = linkDurations ? value : inDuration;
    setOutDuration(value);
    if (linkDurations) setInDuration(value);
    updateSelectedDurations(nextInDuration, value);
  };

  return <div className="quick-panel animation-studio animation-studio-v2">
    <div className="animation-studio-heading"><div><p className="eyebrow">{t('animation.studio')}</p><h3>{t('animation.title')}</h3><small>{t('animation.copy')}</small></div><span className="animation-studio-mark">↗</span></div>
    <div className="animation-target-row"><span className={selected ? 'target-dot ready' : 'target-dot'} />{selected ? <><strong>{selected.name}</strong><small>{selectedIds.length > 1 ? t('common.selectedClips', { count: selectedIds.length }) : t('animation.selectedClip')}</small></> : <><strong>{t('animation.noClip')}</strong><small>{t('animation.selectClip')}</small></>}</div>
    <div className="animation-mode-tabs" role="tablist" aria-label={t('animation.sectionAria')}>{(['in', 'both', 'out'] as const).map((value) => <button key={value} role="tab" aria-selected={mode === value} className={mode === value ? 'active' : ''} onClick={() => setMode(value)}><span className="animation-mode-icon" aria-hidden="true">{value === 'in' ? '↘' : value === 'both' ? '✦' : '↗'}</span><span><strong>{t(`animation.modeLabel.${value}` as TranslationKey)}</strong><small>{t(`animation.mode.${value}Hint` as TranslationKey)}</small></span></button>)}</div>
    <div className={`animation-duration-grid ${mode === 'both' ? '' : 'single'}`}>
      {mode !== 'out' && <label><span>{t('animation.inDuration')}</span><strong>{t('animation.seconds', { value: inDuration.toFixed(2) })}</strong><input type="range" min="0" max="1.5" step="0.05" value={inDuration} disabled={!selectedIds.length} onChange={(event) => changeInDuration(Number(event.target.value))} aria-label={t('animation.inDurationAria')} /></label>}
      {mode !== 'in' && <label><span>{t('animation.outDuration')}</span><strong>{t('animation.seconds', { value: outDuration.toFixed(2) })}</strong><input type="range" min="0" max="1.5" step="0.05" value={outDuration} disabled={!selectedIds.length} onChange={(event) => changeOutDuration(Number(event.target.value))} aria-label={t('animation.outDurationAria')} /></label>}
    </div>
    <div className="animation-section-label"><strong>{t('animation.choose')}</strong><small>{t('animation.readyCount', { count: visiblePresets.length })}</small></div>
    <div className="animation-category-tabs" role="tablist" aria-label={t('animation.categoriesAria')}>{(['all', 'cut', 'soft', 'motion', 'focus'] as const).map((value) => <button key={value} role="tab" aria-selected={category === value} className={category === value ? 'active' : ''} onClick={() => setCategory(value)}>{value === 'all' ? t('library.category.all') : t(`animation.category.${value}` as TranslationKey)}</button>)}</div>
    <div className="animation-card-grid">{visiblePresets.map((preset) => <button key={preset.id} className={`animation-card ${isActive(preset) ? 'active' : ''}`} aria-pressed={isActive(preset)} onClick={() => { setActivePresetId(preset.id); setDirection(preset.motionDirection); apply(preset, preset.motionDirection); }}><span className={`animation-card-visual animation-visual-${preset.type} animation-visual-${preset.id}`}><i /></span><span className="animation-card-copy"><strong>{t(preset.labelKey)}</strong><small>{t(preset.descriptionKey)}</small></span><b>{isActive(preset) ? '✓' : '＋'}</b></button>)}</div>
    <button className={`animation-advanced-toggle ${showAdvanced ? 'active' : ''}`} onClick={() => setShowAdvanced((value) => !value)} aria-expanded={showAdvanced}><span><strong>{t('animation.advanced')}</strong><small>{t('animation.advancedCopy')}</small></span><b>{showAdvanced ? '⌃' : '⌄'}</b></button>
    {showAdvanced && <div className="animation-advanced">
      <label><span>{t('animation.direction')}</span><select value={direction} onChange={(event) => setDirection(event.target.value as TransitionDirection)}>{(['left', 'right', 'up', 'down', 'center'] as const).map((value) => <option key={value} value={value}>{t(`animation.direction.${value}` as TranslationKey)}</option>)}</select></label>
       <label><span>{t('animation.easing')}</span><select value={easing} onChange={(event) => setEasing(event.target.value as TransitionEasing)}><option value="linear">{t('animation.easing.linear')}</option><option value="ease-in">{t('animation.easing.in')}</option><option value="ease-out">{t('animation.easing.out')}</option><option value="ease-in-out">{t('animation.easing.both')}</option></select></label>
      <label className="animation-intensity"><span>{t('animation.intensity')} <b>{Math.round(intensity * 100)}%</b></span><input type="range" min="0.1" max="2" step="0.05" value={intensity} onChange={(event) => setIntensity(Number(event.target.value))} /></label>
      {mode === 'both' && <label className="animation-link-toggle"><input type="checkbox" checked={linkDurations} onChange={(event) => setLinkDurations(event.target.checked)} /><span>{t('animation.linkDurations')}</span></label>}
      <button className="animation-apply-button" onClick={applyAdvanced}>{t('animation.applyAdvanced')}</button>
    </div>}
  </div>;
}

function ProjectBackupPanel({ backups, onRestore }: { backups: BackupSummary[]; onRestore: (fileName: string) => void }) {
  const { t, formatDate } = useI18n();
  return <section className="project-backup-panel">
    <div className="project-backup-heading"><div><strong>{t('backup.title')}</strong><small>{t('backup.copy')}</small></div><span>{backups.length}</span></div>
    {backups.length === 0 ? <p className="project-backup-empty">{t('backup.empty')}</p> : <div className="project-backup-list">{backups.slice(0, 5).map((backup) => <div className="project-backup-item" key={backup.fileName}><div><strong>{formatDate(backup.createdAt, { dateStyle: 'short', timeStyle: 'short' })}</strong><small>{Math.max(1, Math.round(backup.size / 1024))} KB</small></div><button type="button" onClick={() => onRestore(backup.fileName)}>{t('common.restore')}</button></div>)}</div>}
  </section>;
}

function AssetPanelPro({ onImport, onOpenSettings }: { onImport: (file: File) => void; onOpenSettings: () => void }) {
  const { t, locale, formatNumber } = useI18n();
  const panel = useEditor((state) => state.panel);
  const project = useEditor((state) => state.project)!;
  const currentTime = useEditor((state) => state.currentTime);
  const selectedClipIds = useEditor((state) => state.selectedClipIds);
  const mutateProject = useEditor((state) => state.mutateProject);
  const setSelected = useEditor((state) => state.setSelected);
  const setNotice = useEditor((state) => state.setNotice);
  const fileRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | Asset['type'] | 'unused'>('all');
  const [sort, setSort] = useState<'date' | 'name' | 'duration'>('date');
  const [view, setView] = useState<'list' | 'grid'>('list');
  const [mediaSection, setMediaSection] = useState<'project' | 'stock' | 'shapes'>('project');
  const [isDropActive, setIsDropActive] = useState(false);
  const [stockBusyId, setStockBusyId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; asset?: Asset; panel?: boolean } | null>(null);
  const [mediaHealth, setMediaHealth] = useState<Record<string, { status: 'ready' | 'missing' | 'derived-missing'; sourceExists: boolean; proxyExists: boolean; thumbnailExists: boolean; waveformExists: boolean }>>({});
  const [previewAsset, setPreviewAsset] = useState<Asset | null>(null);
  const [relinkAssetId, setRelinkAssetId] = useState<string | null>(null);
  const [bulkRebuildBusy, setBulkRebuildBusy] = useState(false);
  const relinkRef = useRef<HTMLInputElement>(null);
  const closeMenu = () => setMenu(null);
  const usageCount = (assetId: string) => project.tracks.reduce((count, track) => count + track.clips.filter((clip) => clip.assetId === assetId).length, 0);
  const refreshMediaHealth = async () => {
    try {
      const rows = await api<Array<{ assetId: string; status: 'ready' | 'missing' | 'derived-missing'; sourceExists: boolean; proxyExists: boolean; thumbnailExists: boolean; waveformExists: boolean }>>(`/api/projects/${project.id}/media-health`);
      setMediaHealth(Object.fromEntries(rows.map((row) => [row.assetId, row])));
    } catch { /* the library remains usable when a health check races a save */ }
  };

  useEffect(() => { void refreshMediaHealth(); }, [project.id, project.assets.length]);
  useEffect(() => {
    const events = new EventSource('/api/events');
    const onJob = (event: Event) => {
      const job = JSON.parse((event as MessageEvent).data) as { projectId?: string; kind?: string; status?: string };
      if (job.projectId !== project.id || job.kind !== 'proxy' || !['completed', 'failed', 'cancelled'].includes(job.status ?? '')) return;
      void api<Project>(`/api/projects/${project.id}`).then((fresh) => {
        const local = useEditor.getState().project;
        if (local) useEditor.getState().setProject(mergeImportedProject(local, fresh), false);
        void refreshMediaHealth();
      }).catch(() => void refreshMediaHealth());
    };
    events.addEventListener('job', onJob);
    return () => { events.removeEventListener('job', onJob); events.close(); };
  }, [project.id]);
  const derivedMissingAssets = useMemo(() => project.assets.filter((asset) => mediaHealth[asset.id]?.status === 'derived-missing' && mediaHealth[asset.id]?.sourceExists), [mediaHealth, project.assets]);
  const visibleAssets = useMemo(() => project.assets.filter((asset) => {
    const query = search.trim().toLocaleLowerCase(locale);
    const matchesType = filter === 'all' || (filter === 'unused' ? usageCount(asset.id) === 0 : asset.type === filter);
    return (!query || `${asset.name} ${asset.mimeType}`.toLocaleLowerCase(locale).includes(query)) && matchesType;
  }).sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name, locale) : sort === 'duration' ? b.duration - a.duration : b.createdAt.localeCompare(a.createdAt)), [filter, locale, project.assets, project.tracks, search, sort]);
  const hasFilePayload = (event: React.DragEvent) => Array.from(event.dataTransfer.types).includes('Files');
  const importDroppedFiles = async (files: File[]) => {
    const supported = files.filter((file) => /^(video|audio|image)\//.test(file.type));
    if (!supported.length) {
      setNotice(t('library.dropUnsupported'));
      return;
    }
    for (const file of supported) await onImport(file);
  };
  const handleMediaDragEnter = (event: React.DragEvent<HTMLDivElement>) => {
    if (!hasFilePayload(event)) return;
    event.preventDefault();
    setIsDropActive(true);
  };
  const handleMediaDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!hasFilePayload(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setIsDropActive(true);
  };
  const handleMediaDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    if (!hasFilePayload(event)) return;
    const currentTarget = event.currentTarget;
    if (!currentTarget.contains(event.relatedTarget as Node | null)) setIsDropActive(false);
  };
  const handleMediaDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (!hasFilePayload(event)) return;
    event.preventDefault();
    setIsDropActive(false);
    void importDroppedFiles(Array.from(event.dataTransfer.files));
  };
  const addAsset = (asset: Asset, start = currentTime) => {
    const currentProject = useEditor.getState().project;
    if (!currentProject) return;
    const placement = findEmptyPlacement(currentProject, Math.max(asset.duration || 5, 0.5), start, useEditor.getState().selectedTrackId);
    const trackId = placement.trackId ?? `track-layer-${crypto.randomUUID().slice(0, 8)}`;
    const clip = createMediaClip(asset, placement.start);
    mutateProject((draft) => {
      let track = draft.tracks.find((item) => item.id === trackId);
      if (!track) {
        track = { id: trackId, type: 'layer', name: `Layer ${draft.tracks.length + 1}`, order: draft.tracks.length, clips: [], locked: false, hidden: false, muted: false, volume: 1 };
        draft.tracks.push(track);
      }
      if (track.locked) return;
      track.clips.push(clip);
      draft.duration = projectDuration(draft);
    });
    setSelected(clip.id, trackId);
    closeMenu();
  };
  const addStock = async (stock: StockMediaItem) => {
    setStockBusyId(stock.id);
    try {
      const result = await api<{ asset: Asset; project: Project }>(`/api/projects/${project.id}/stock`, { method: 'POST', body: JSON.stringify({ stockId: stock.id }) });
      const localProject = useEditor.getState().project;
      const mergedProject = localProject ? mergeImportedProject(localProject, result.project) : result.project;
      useEditor.getState().setProject(mergedProject, false);
      addAsset(result.asset, useEditor.getState().currentTime);
      setNotice(t('library.stockAdded', { name: stock.name }));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : t('library.stockAddFailed'));
    } finally {
      setStockBusyId(null);
    }
  };
  const removeAsset = (asset: Asset) => {
    if (!window.confirm(t('library.removeConfirm'))) { closeMenu(); return; }
    mutateProject((draft) => { draft.assets = draft.assets.filter((item) => item.id !== asset.id); for (const track of draft.tracks) track.clips = track.clips.filter((clip) => clip.assetId !== asset.id); draft.duration = projectDuration(draft); });
    closeMenu();
  };
  const showInfo = (asset: Asset) => { setNotice(`${asset.name} · ${asset.mimeType} · ${asset.duration ? formatTime(asset.duration) : t('library.noDuration')} · ${t('library.bytes', { count: formatNumber(asset.size) })}`); closeMenu(); };
  const rebuildDerived = async (asset: Asset) => {
    closeMenu();
    try {
      await api(`/api/projects/${project.id}/media/${asset.id}/rebuild-derived`, { method: 'POST', body: JSON.stringify({}) });
      setNotice(t('library.rebuilding', { name: asset.name }));
      window.setTimeout(() => void refreshMediaHealth(), 900);
    } catch (error) { setNotice(error instanceof Error ? error.message : t('library.rebuildFailed')); }
  };
  const waitForDerivedJob = async (jobId: string) => {
    for (let attempt = 0; attempt < 160; attempt += 1) {
      const jobs = await api<Array<{ id: string; status: string; error?: string }>>('/api/jobs');
      const job = jobs.find((item) => item.id === jobId);
      if (job?.status === 'completed') return;
      if (job && (job.status === 'failed' || job.status === 'cancelled')) throw new Error(job.error || t('library.derivedJobFailed'));
      await new Promise((resolve) => window.setTimeout(resolve, 250));
    }
    throw new Error(t('library.derivedTimeout'));
  };
  const rebuildAllDerived = async () => {
    if (!derivedMissingAssets.length || bulkRebuildBusy) return;
    closeMenu();
    setBulkRebuildBusy(true);
    let repaired = 0;
    try {
      for (const asset of derivedMissingAssets) {
        setNotice(t('library.preparingAsset', { name: asset.name, current: repaired + 1, total: derivedMissingAssets.length }));
        const result = await api<{ job: { id: string } }>(`/api/projects/${project.id}/media/${asset.id}/rebuild-derived`, { method: 'POST', body: JSON.stringify({}) });
        await waitForDerivedJob(result.job.id);
        repaired += 1;
        const fresh = await api<Project>(`/api/projects/${project.id}`);
        const local = useEditor.getState().project;
        if (local) useEditor.getState().setProject(mergeImportedProject(local, fresh), false);
        await refreshMediaHealth();
      }
      setNotice(t('library.rebuildDone', { count: repaired }));
    } catch (error) {
      setNotice(t('library.rebuildPartial', { repaired, total: derivedMissingAssets.length, reason: error instanceof Error ? error.message : t('library.operationFailed') }));
    } finally {
      setBulkRebuildBusy(false);
      await refreshMediaHealth();
    }
  };
  const relinkMedia = async (file: File) => {
    const asset = project.assets.find((item) => item.id === relinkAssetId);
    setRelinkAssetId(null);
    if (!asset) return;
    const form = new FormData();
    form.append('file', file);
    try {
      const result = await api<{ project: Project }>(`/api/projects/${project.id}/media/${asset.id}/relink`, { method: 'POST', body: form });
      const local = useEditor.getState().project;
      if (local) useEditor.getState().setProject(mergeImportedProject(local, result.project), false);
      setNotice(t('library.relinked', { name: asset.name }));
      window.setTimeout(() => void refreshMediaHealth(), 900);
    } catch (error) { setNotice(error instanceof Error ? error.message : t('library.relinkFailed')); }
  };
  const title = t(panelTitle(panel));
  const panelMenuItems: ContextMenuItem[] = [
    { label: t('library.menu.import'), icon: '+', onSelect: () => fileRef.current?.click() },
    { label: t('library.menu.refresh'), icon: '↻', onSelect: () => { void api<Project>(`/api/projects/${project.id}`).then((fresh) => { const local = useEditor.getState().project; if (local) useEditor.getState().setProject(mergeImportedProject(local, fresh), false); }); } },
    { label: bulkRebuildBusy ? t('library.menu.rebuilding') : t('library.menu.rebuildMissing', { count: derivedMissingAssets.length }), icon: '⟳', disabled: bulkRebuildBusy || derivedMissingAssets.length === 0, onSelect: () => { void rebuildAllDerived(); } },
    { label: t('library.menu.settings'), icon: '⚙', onSelect: onOpenSettings },
  ];
  const assetMenuItems = (asset: Asset): ContextMenuItem[] => [
    { label: t('library.menu.preview'), icon: '▶', onSelect: () => { setPreviewAsset(asset); closeMenu(); } },
    { label: t('library.menu.addTimeline'), icon: '+', shortcut: 'Enter', onSelect: () => addAsset(asset) },
    { label: t('library.menu.copyName'), icon: '⧉', onSelect: () => { void navigator.clipboard?.writeText(asset.name); closeMenu(); } },
    { label: t('library.menu.info'), icon: 'i', onSelect: () => showInfo(asset) },
    { label: t('library.menu.rebuild'), icon: '↻', onSelect: () => { void rebuildDerived(asset); } },
    { label: t('library.menu.relink'), icon: '↪', onSelect: () => { setRelinkAssetId(asset.id); window.setTimeout(() => relinkRef.current?.click(), 0); closeMenu(); } },
    { label: t('library.menu.showUsage'), icon: '⌁', onSelect: () => setNotice(t('library.timelineUsage', { count: usageCount(asset.id) })) },
    { label: t('library.menu.remove'), icon: '×', danger: true, onSelect: () => removeAsset(asset) },
  ];
  const addTextClip = (preset: TextPreset) => {
    const state = useEditor.getState();
    if (!state.project) return;
    const placement = findEmptyPlacement(state.project, 4, state.currentTime, state.selectedTrackId);
    const clip = createTextClip(preset, placement.start);
    let targetId = placement.trackId;
    mutateProject((draft) => { const track = targetId ? draft.tracks.find((item) => item.id === targetId) : undefined; const destination = track && !track.locked ? track : createLayerTrack(draft); targetId = destination.id; destination.clips.push(clip); draft.duration = projectDuration(draft); });
    setSelected(clip.id, targetId);
  };
  const applyEffect = (preset: 'film' | 'retro' | 'glow' | 'blur' | 'chroma' | 'noise') => {
    const selected = selectedClipIds.length ? selectedClipIds : useEditor.getState().selectedClipId ? [useEditor.getState().selectedClipId!] : [];
    if (!selected.length) { setNotice(t('effects.selectClip')); return; }
    mutateProject((draft) => { for (const clip of draft.tracks.flatMap((track) => track.clips)) { if (!selected.includes(clip.id)) continue; if (preset === 'film') { clip.filters.brightness = -0.05; clip.filters.contrast = 0.12; clip.filters.saturation = -0.1; } if (preset === 'retro') { clip.filters.saturation = -0.22; } if (preset === 'glow') clip.filters.blur = 1.5; if (preset === 'blur') clip.filters.blur = 8; if (preset === 'chroma') clip.filters.chromaKey = { color: '#00ff00', similarity: 0.35, blend: 0.1 }; if (preset === 'noise') clip.filters.grayscale = 0.08; } });
  };
  const applyTransition = (preset: TransitionPreset) => {
    const selected = selectedClipIds.length ? selectedClipIds : useEditor.getState().selectedClipId ? [useEditor.getState().selectedClipId!] : [];
    if (!selected.length) { setNotice(t('effects.selectClip')); return; }
    mutateProject((draft) => {
      for (const clip of draft.tracks.flatMap((track) => track.clips)) {
        if (!selected.includes(clip.id)) continue;
        clip.transitionOut.type = preset;
        clip.transitionOut.duration = preset === 'none' ? 0 : Math.min(0.4, clip.duration);
      }
    });
  };
  if (panel === 'media') {
    return <aside className="asset-panel asset-panel-pro">
      <div className="panel-heading"><div><p className="eyebrow">{t('library.title')}</p><h2>{t('editor.panel.media')}</h2></div><button className="panel-more" aria-label={t('library.panelMenu')} onClick={(event) => { event.stopPropagation(); setMenu({ x: event.clientX, y: event.clientY, panel: true }); }}>•••</button></div>
      <div className="media-source-tabs" role="tablist" aria-label={t('library.mediaSources')}>
        <button role="tab" aria-selected={mediaSection === 'project'} className={mediaSection === 'project' ? 'active' : ''} onClick={() => setMediaSection('project')}><span className="media-source-tab-icon">▧</span><span className="media-source-tab-label">{t('editor.panel.media')}</span><small>{project.assets.length}</small></button>
        <button role="tab" aria-selected={mediaSection === 'stock'} className={mediaSection === 'stock' ? 'active' : ''} onClick={() => setMediaSection('stock')}><span className="media-source-tab-icon">✦</span><span className="media-source-tab-label">{t('library.stock')}</span><small>{STOCK_MEDIA.length}</small></button>
        <button role="tab" aria-selected={mediaSection === 'shapes'} className={mediaSection === 'shapes' ? 'active' : ''} onClick={() => setMediaSection('shapes')}><span className="media-source-tab-icon">◇</span><span className="media-source-tab-label">{t('library.shapes')}</span><small>{SHAPE_PRESETS.length}</small></button>
      </div>
      {mediaSection !== 'project' && <p className="media-source-copy">{t(mediaSection === 'stock' ? 'library.stockHint' : 'library.shapesHint')}</p>}
      <input ref={fileRef} className="hidden-input" type="file" accept="video/*,audio/*,image/*" onChange={(event) => { const file = event.target.files?.[0]; if (file) onImport(file); event.target.value = ''; }} />
      <input ref={relinkRef} className="hidden-input" type="file" accept="video/*,audio/*,image/*" onChange={(event) => { const file = event.target.files?.[0]; if (file) void relinkMedia(file); event.target.value = ''; }} />
      {mediaSection === 'project' && <>
        <div className="media-library-summary"><div><span className="media-section-kicker">{t('library.projectMedia')}</span><strong>{t('library.files', { count: project.assets.length })}</strong></div><div className="media-library-actions">{derivedMissingAssets.length > 0 && <button type="button" className="media-rebuild-all-button" onClick={() => void rebuildAllDerived()} disabled={bulkRebuildBusy} aria-label={t('library.rebuildAll')} title={t('library.rebuildAll')}><span>{bulkRebuildBusy ? '…' : '⟳'}</span><b>{derivedMissingAssets.length}</b></button>}<button type="button" className="media-import-button" onClick={() => fileRef.current?.click()} aria-label={t('library.addMedia')} title={t('library.addMedia')}>＋</button></div></div>
        <div className="media-controls">
          <div className="media-search-field"><span aria-hidden="true">⌕</span><input className="media-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('library.search')} aria-label={t('library.search')} />{search && <button type="button" className="media-search-clear" aria-label={t('library.clearSearch')} onClick={() => setSearch('')}>×</button>}</div>
          <div className="media-controls-row"><select className="media-filter-select" value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)} aria-label={t('library.filter')}><option value="all">{t('library.allMedia')}</option><option value="video">{t('library.video')}</option><option value="audio">{t('library.audio')}</option><option value="image">{t('library.image')}</option><option value="unused">{t('library.unused')}</option></select><select className="media-sort-select" value={sort} onChange={(event) => setSort(event.target.value as typeof sort)} aria-label={t('library.sort')}><option value="date">{t('library.recent')}</option><option value="name">{t('library.byName')}</option><option value="duration">{t('library.byDuration')}</option></select><div className="media-view-toggle"><button className={view === 'list' ? 'active' : ''} onClick={() => setView('list')} title={t('library.listView')} aria-label={t('library.listView')}>☰</button><button className={view === 'grid' ? 'active' : ''} onClick={() => setView('grid')} title={t('library.gridView')} aria-label={t('library.gridView')}>▦</button></div></div>
        </div>
        <div className="media-list-heading"><span>{t('library.results', { count: visibleAssets.length })}</span><span>{t(view === 'list' ? 'library.list' : 'library.grid')}</span></div>
        <div className={`asset-list ${view === 'grid' ? 'asset-grid-view' : ''} ${isDropActive ? 'is-drop-active' : ''}`} role="region" aria-label={t('library.dropRegion')} onDragEnter={handleMediaDragEnter} onDragOver={handleMediaDragOver} onDragLeave={handleMediaDragLeave} onDrop={handleMediaDrop}>{visibleAssets.length === 0 ? <div className="panel-empty"><span>⊘</span><p>{t('library.notFound')}</p><small>{t('library.notFoundHint')}</small></div> : visibleAssets.map((asset) => <AssetCardPro key={asset.id} projectId={project.id} asset={asset} usage={usageCount(asset.id)} health={mediaHealth[asset.id]} view={view} onAdd={() => addAsset(asset)} onPreview={() => setPreviewAsset(asset)} onRebuild={() => void rebuildDerived(asset)} onOpenMenu={(event) => { event.stopPropagation(); setMenu({ x: event.clientX, y: event.clientY, asset }); }} />)}{isDropActive && <div className="media-drop-overlay" aria-live="polite"><span>＋</span><strong>{t('library.dropFiles')}</strong><small>{t('library.dropHint')}</small></div>}</div>
      </>}
      {mediaSection === 'stock' && <StockMediaShelf busyId={stockBusyId} onAdd={(stock) => void addStock(stock)} />}
      {mediaSection === 'shapes' && <ShapeShelf onAdd={addTextClip} />}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.panel ? panelMenuItems : menu.asset ? assetMenuItems(menu.asset) : []} onClose={closeMenu} />}
      {previewAsset && <MediaPreviewModal projectId={project.id} asset={previewAsset} onClose={() => setPreviewAsset(null)} />}
    </aside>;
  }
  return <aside className="asset-panel asset-panel-pro">
    <div className="panel-heading"><div><p className="eyebrow">{t('library.title')}</p><h2>{title}</h2></div><button className="panel-more" aria-label={t('library.panelMenu')} onClick={(event) => { event.stopPropagation(); setMenu({ x: event.clientX, y: event.clientY, panel: true }); }}>•••</button></div>
    <PanelContent panel={panel} onAddText={addTextClip} onImport={onImport} onApplyEffect={applyEffect} onApplyTransition={applyTransition} onOpenSettings={onOpenSettings} />
    {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.panel ? panelMenuItems : menu.asset ? assetMenuItems(menu.asset) : []} onClose={closeMenu} />}
  </aside>;
}

function StockMediaShelf({ busyId, onAdd }: { busyId: string | null; onAdd: (stock: StockMediaItem) => void }) {
  const { t } = useI18n();
  const [category, setCategory] = useState<'all' | StockMediaItem['category']>('all');
  const localizedStocks = STOCK_MEDIA.map((stock) => localizeStockMedia(stock, t));
  const visible = category === 'all' ? localizedStocks : localizedStocks.filter((stock) => stock.category === category);
  return <section className="stock-media-shelf" aria-label={t('library.stockAria')}><div className="stock-shelf-heading"><div><strong>{t('library.stockTitle')}</strong><small>{t('library.stockCopy')}</small></div><span>{STOCK_MEDIA.length}</span></div><div className="stock-category-tabs">{(['all', 'solid', 'soft', 'texture'] as const).map((value) => <button key={value} className={category === value ? 'active' : ''} onClick={() => setCategory(value)}>{t(`library.category.${value}` as TranslationKey)}</button>)}</div><div className="stock-media-grid">{visible.map((stock) => <button key={stock.id} className="stock-media-card" onClick={() => onAdd(stock)} disabled={busyId !== null} aria-label={t('library.stockAddAria', { name: stock.name })}><span className={`stock-preview stock-${stock.id}`}><img src={`/api/stock/${stock.id}`} alt="" /></span><span><strong>{busyId === stock.id ? t('common.adding') : stock.name}</strong><small>{stock.description}</small></span><b>＋</b></button>)}</div></section>;
}

function ShapeShelf({ onAdd }: { onAdd: (preset: TextPreset) => void }) {
  const { t } = useI18n();
  const [category, setCategory] = useState<ShapePreset['category'] | 'all'>('all');
  const localizedShapes = SHAPE_PRESETS.map((shape) => localizeShapePreset(shape, t));
  const visibleShapes = category === 'all' ? localizedShapes : localizedShapes.filter((shape) => shape.category === category);
  const baseTextPreset = localizeTextPreset(TEXT_PRESETS[0], t);
  return <section className="shape-shelf" aria-label={t('library.shapes')}>
    <div className="stock-shelf-heading"><div><strong>{t('library.shapesTitle')}</strong><small>{t('library.shapesCopy')}</small></div><span>{SHAPE_PRESETS.length}</span></div>
    <div className="shape-category-tabs" role="tablist" aria-label={t('library.shapeCategories')}>
      {(['all', 'basic', 'arrows', 'symbols', 'badges'] as const).map((value) => <button key={value} role="tab" aria-selected={category === value} className={category === value ? 'active' : ''} onClick={() => setCategory(value)}>{t(`library.category.${value}` as TranslationKey)}</button>)}
    </div>
    <div className="shape-shelf-grid">{visibleShapes.map((shape) => <button key={shape.id} className="shape-card" onClick={() => onAdd({ ...baseTextPreset, id: `shape-${shape.id}-${Date.now()}`, label: t('library.shapeClipName', { name: shape.label }), text: shape.glyph, fontSize: 120, color: shape.color, background: 'transparent' })} aria-label={t('library.shapeAddAria', { name: shape.label })}><b style={{ color: shape.color }}>{shape.glyph}</b><span><strong>{shape.label}</strong><small>{shape.description}</small></span><i>＋</i></button>)}</div>
  </section>;
}

function AssetCardPro({ projectId, asset, usage, health, view, onAdd, onPreview = () => undefined, onRebuild = () => undefined, onOpenMenu }: { projectId: string; asset: Asset; usage: number; health?: { status: 'ready' | 'missing' | 'derived-missing'; sourceExists: boolean; proxyExists: boolean; thumbnailExists: boolean; waveformExists: boolean }; view: 'list' | 'grid'; onAdd: () => void; onPreview?: () => void; onRebuild?: () => void; onOpenMenu: (event: React.MouseEvent<HTMLButtonElement>) => void }) {
  const { t } = useI18n();
  const [previewFailed, setPreviewFailed] = useState(false);
  const icon = asset.type === 'video' ? '▶' : asset.type === 'audio' ? '♫' : '▧';
  const meta = asset.duration ? formatTime(asset.duration) : asset.mimeType.split('/')[1]?.toUpperCase() || 'MEDIA';
  const assetDetails = `${asset.width && asset.height ? `${asset.width} × ${asset.height}` : asset.type}${usage > 0 ? ` · ${t('library.usedCount', { count: usage })}` : ` · ${t('library.notUsed')}`}`;
  const mediaUrl = `/api/projects/${projectId}/media/${asset.id}`;
  const preview = !previewFailed && asset.type === 'image' ? <img src={mediaUrl} alt="" onError={() => setPreviewFailed(true)} /> : !previewFailed && asset.type === 'video' ? <video src={mediaUrl} poster={asset.thumbnailPath ? `${mediaUrl}?thumbnail=1` : undefined} muted preload="metadata" onError={() => setPreviewFailed(true)} /> : null;
  const status = health?.status ?? (asset.proxyPath || asset.thumbnailPath || asset.waveformPath ? 'ready' : 'derived-missing');
  const statusLabel = t(status === 'ready' ? 'library.status.ready' : status === 'missing' ? 'library.status.missing' : 'library.status.derivedMissing');
  return <div className={`asset-item pro ${view === 'grid' ? 'grid-card' : ''} media-${status}`} draggable onPointerDown={(event) => { if (!(event.target as HTMLElement).closest('button')) useEditor.getState().setAssetDragId(asset.id); }} onPointerUp={() => useEditor.getState().setAssetDragId(null)} onPointerCancel={() => useEditor.getState().setAssetDragId(null)} onDragStart={(event) => { event.dataTransfer.effectAllowed = 'copy'; event.dataTransfer.setData('application/x-cutloc-asset', JSON.stringify({ assetId: asset.id })); useEditor.getState().setAssetDragId(asset.id); }} onDragEnd={() => useEditor.getState().setAssetDragId(null)} onDoubleClick={onPreview} onContextMenu={(event) => { event.preventDefault(); onOpenMenu(event as unknown as React.MouseEvent<HTMLButtonElement>); }}><button type="button" className={`asset-thumb ${asset.type} ${preview ? 'has-preview' : ''}`} onClick={(event) => { event.stopPropagation(); onPreview(); }} aria-label={t('library.previewAria', { name: asset.name })}><span className="asset-thumb-fallback">{icon}</span>{preview}<small>{meta}</small></button><div className="asset-info"><strong title={asset.name}>{asset.name}</strong><small>{assetDetails}</small><span className={`asset-health asset-health-${status}`}><i />{statusLabel}</span></div><button className="asset-add-button" onClick={(event) => { event.stopPropagation(); onAdd(); }} aria-label={t('library.addToTimelineAria', { name: asset.name })}>＋ <span>{t('common.add')}</span></button><button className="asset-dots" aria-label={t('library.itemMenuAria', { name: asset.name })} onClick={onOpenMenu}>•••</button>{status === 'derived-missing' && <button className="asset-rebuild-button" onClick={(event) => { event.stopPropagation(); onRebuild(); }} aria-label={t('library.rebuildAria')}>↻</button>}</div>;
}

function MediaPreviewModal({ projectId, asset, onClose }: { projectId: string; asset: Asset; onClose: () => void }) {
  const { t } = useI18n();
  const source = `/api/projects/${projectId}/media/${asset.id}`;
  return <div className="media-preview-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="media-preview-modal" role="dialog" aria-modal="true" aria-label={t('library.previewAria', { name: asset.name })}><div className="modal-head"><div><p className="eyebrow">{t('library.sourceMonitor')}</p><h2>{asset.name}</h2></div><button onClick={onClose} aria-label={t('library.closePreview')}>×</button></div><div className="media-preview-stage">{asset.type === 'video' ? <video src={source} controls autoPlay playsInline /> : asset.type === 'audio' ? <audio src={source} controls autoPlay /> : <img src={source} alt={asset.name} />}</div><p className="media-preview-note">{t('library.previewNote')}</p></section></div>;
}

const TEXT_FONT_OPTIONS = [
  'Segoe UI, Arial, sans-serif',
  'Arial, sans-serif',
  'Inter, Arial, sans-serif',
  'Roboto, Arial, sans-serif',
  'Open Sans, Arial, sans-serif',
  'Lato, Arial, sans-serif',
  'Nunito, Arial, sans-serif',
  'DM Sans, Arial, sans-serif',
  'Montserrat, Arial, sans-serif',
  'Poppins, Arial, sans-serif',
  'Trebuchet MS, sans-serif',
  'Verdana, sans-serif',
  'Georgia, serif',
  'Playfair Display, Georgia, serif',
  'Space Grotesk, Arial, sans-serif',
  'Oswald, Arial, sans-serif',
  'Courier New, monospace',
  'Bebas Neue, Impact, sans-serif',
];

type TextPreset = {
  id: string;
  label: string;
  category: 'title' | 'social' | 'card' | 'accent';
  description: string;
  text: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  fontStyle: 'normal' | 'italic';
  color: string;
  background: string;
  stroke: string;
  strokeWidth: number;
  shadow: boolean;
  align: 'left' | 'center' | 'right';
  letterSpacing?: number;
};

/** Readable, offline-safe text presets. They deliberately use common system
 * fonts so preview and FFmpeg export render the same way without a download. */
const TEXT_PRESETS: TextPreset[] = [
  { id: 'clean-title', label: 'Clean title', category: 'title', description: 'Clear opener for videos', text: 'New title', fontFamily: 'Segoe UI, Arial, sans-serif', fontSize: 72, fontWeight: 750, fontStyle: 'normal', color: '#ffffff', background: 'transparent', stroke: 'transparent', strokeWidth: 0, shadow: true, align: 'center' },
  { id: 'editorial', label: 'Editorial', category: 'title', description: 'Elegant and readable serif', text: 'A story begins', fontFamily: 'Georgia, serif', fontSize: 62, fontWeight: 700, fontStyle: 'normal', color: '#fff8e8', background: 'transparent', stroke: 'transparent', strokeWidth: 0, shadow: true, align: 'center', letterSpacing: 1 },
  { id: 'social-hook', label: 'Social hook', category: 'social', description: 'Short, bold, high contrast', text: 'You need to see this!', fontFamily: 'Arial, sans-serif', fontSize: 58, fontWeight: 800, fontStyle: 'normal', color: '#ffffff', background: '#243dff', stroke: 'transparent', strokeWidth: 0, shadow: true, align: 'center' },
  { id: 'lower-third', label: 'Lower third', category: 'social', description: 'Name and location', text: 'Hakan · CutLoc', fontFamily: 'DM Sans, Arial, sans-serif', fontSize: 34, fontWeight: 600, fontStyle: 'normal', color: '#ffffff', background: '#101116dd', stroke: 'transparent', strokeWidth: 0, shadow: false, align: 'left' },
  { id: 'quote', label: 'Quote', category: 'card', description: 'Calm and emotional', text: 'Capture a moment.', fontFamily: 'Georgia, serif', fontSize: 52, fontWeight: 600, fontStyle: 'italic', color: '#ffffff', background: '#101116bb', stroke: 'transparent', strokeWidth: 0, shadow: true, align: 'center' },
  { id: 'info-card', label: 'Info card', category: 'card', description: 'Tips and explanations', text: 'Tip · Try the timeline', fontFamily: 'Segoe UI, Arial, sans-serif', fontSize: 32, fontWeight: 600, fontStyle: 'normal', color: '#102018', background: '#b7f36a', stroke: 'transparent', strokeWidth: 0, shadow: false, align: 'left' },
  { id: 'outline', label: 'Outline', category: 'accent', description: 'Bold accent over footage', text: 'Stand out', fontFamily: 'Arial, sans-serif', fontSize: 68, fontWeight: 800, fontStyle: 'normal', color: '#ffffff', background: 'transparent', stroke: '#101116', strokeWidth: 2, shadow: true, align: 'center' },
  { id: 'soft-note', label: 'Soft note', category: 'accent', description: 'Minimal and warm', text: 'A small note', fontFamily: 'Nunito, Arial, sans-serif', fontSize: 42, fontWeight: 600, fontStyle: 'normal', color: '#fff2d6', background: '#4d304acc', stroke: 'transparent', strokeWidth: 0, shadow: true, align: 'center' },
];

function localizeTextPreset(preset: TextPreset, t: (key: TranslationKey) => string): TextPreset {
  const prefix = `preset.text.${preset.id}`;
  return { ...preset, label: t(`${prefix}.label` as TranslationKey), description: t(`${prefix}.description` as TranslationKey), text: t(`${prefix}.text` as TranslationKey) };
}

type ShapePreset = {
  id: string;
  label: string;
  glyph: string;
  color: string;
  category: 'basic' | 'arrows' | 'symbols' | 'badges';
  description: string;
};

/**
 * Shapes intentionally remain text-based clips for now. That keeps insertion,
 * transform, keyframes and FFmpeg export on the existing stable Clip contract
 * while giving the left library a real, browsable catalog.
 */
const SHAPE_PRESETS: ShapePreset[] = [
  { id: 'circle', label: 'Circle', glyph: '●', color: '#b7f36a', category: 'basic', description: 'Soft accent' },
  { id: 'square', label: 'Square', glyph: '■', color: '#ffd36a', category: 'basic', description: 'Sharp block' },
  { id: 'diamond', label: 'Diamond', glyph: '◆', color: '#f18df0', category: 'basic', description: 'Rotated accent' },
  { id: 'triangle', label: 'Triangle', glyph: '▲', color: '#9ce8ff', category: 'basic', description: 'Directional surface' },
  { id: 'star', label: 'Star', glyph: '★', color: '#ffd36a', category: 'symbols', description: 'Bright accent' },
  { id: 'spark', label: 'Spark', glyph: '✦', color: '#f18df0', category: 'symbols', description: 'Small shimmer' },
  { id: 'heart', label: 'Heart', glyph: '♥', color: '#ff7f9f', category: 'symbols', description: 'Emotional accent' },
  { id: 'sun', label: 'Sun', glyph: '☀', color: '#ffd36a', category: 'symbols', description: 'Warm energy' },
  { id: 'arrow-right', label: 'Right arrow', glyph: '→', color: '#9ce8ff', category: 'arrows', description: 'Point the way' },
  { id: 'arrow-up', label: 'Up arrow', glyph: '↑', color: '#9ce8ff', category: 'arrows', description: 'Move upward' },
  { id: 'arrow-diagonal', label: 'Diagonal arrow', glyph: '↗', color: '#9ce8ff', category: 'arrows', description: 'Motion direction' },
  { id: 'chevron', label: 'Chevron', glyph: '›', color: '#b7f36a', category: 'arrows', description: 'Forward callout' },
  { id: 'check', label: 'Check', glyph: '✓', color: '#82e6b5', category: 'badges', description: 'Completed' },
  { id: 'plus', label: 'Plus', glyph: '＋', color: '#b7f36a', category: 'badges', description: 'Add symbol' },
  { id: 'cross', label: 'Cross', glyph: '×', color: '#ff9d9d', category: 'badges', description: 'Close symbol' },
  { id: 'badge', label: 'Badge', glyph: '⬡', color: '#f18df0', category: 'badges', description: 'Hexagonal label' },
  { id: 'orbit', label: 'Orbit', glyph: '◒', color: '#9ce8ff', category: 'symbols', description: 'Circular motion' },
  { id: 'cloud', label: 'Cloud', glyph: '☁', color: '#d5e7ff', category: 'symbols', description: 'Light atmosphere' },
];

function localizeShapePreset(preset: ShapePreset, t: (key: TranslationKey) => string): ShapePreset {
  const prefix = `preset.shape.${preset.id}`;
  return { ...preset, label: t(`${prefix}.label` as TranslationKey), description: t(`${prefix}.description` as TranslationKey) };
}

const DEFAULT_TEXT_STYLE: NonNullable<Clip['textStyle']> = {
  text: 'New text',
  fontFamily: 'Inter, Arial, sans-serif',
  fontSize: 64,
  fontWeight: 700,
  fontStyle: 'normal',
  textDecoration: 'none',
  letterSpacing: 0,
  lineHeight: 1.2,
  padding: 4,
  color: '#ffffff',
  background: 'transparent',
  stroke: 'transparent',
  strokeWidth: 0,
  shadow: true,
  align: 'center',
};

function waveformBars(seed: string, count = 56) {
  let hash = 2166136261;
  for (const character of seed) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return Array.from({ length: count }, (_, index) => {
    hash = Math.imul(hash ^ (index + 1), 16777619);
    return 18 + ((hash >>> 0) % 76);
  });
}

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
  return {
    localTime,
    x: interpolateKeyframes(clip.keyframes, 'x', localTime, clip.transform.x) + transitionX,
    y: interpolateKeyframes(clip.keyframes, 'y', localTime, clip.transform.y) + transitionY,
    scale: interpolateKeyframes(clip.keyframes, 'scale', localTime, clip.transform.scale) * transitionScale,
    rotation: interpolateKeyframes(clip.keyframes, 'rotation', localTime, clip.transform.rotation),
    opacity: clamp(interpolateKeyframes(clip.keyframes, 'opacity', localTime, clip.transform.opacity) * transitionOpacity, 0, 1),
    volume: clamp(interpolateKeyframes(clip.keyframes, 'volume', localTime, clip.volume), 0, 2),
    speed: clipSpeedAt(clip, localTime),
    wipe,
  };
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

function normalizeProjectDurations(project: Project): Project {
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
  if (!changed) return project;
  const next = { ...project, tracks };
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

function PreviewArea({ project, settings }: { project: Project; settings: Settings | null }) {
  const { t } = useI18n();
  const currentTime = useEditor((state) => state.currentTime); const playing = useEditor((state) => state.playing); const setPlaying = useEditor((state) => state.setPlaying); const setCurrentTime = useEditor((state) => state.setCurrentTime);
  const selectedClipId = useEditor((state) => state.selectedClipId);
  const selectedClipIds = useEditor((state) => state.selectedClipIds);
  const setSelected = useEditor((state) => state.setSelected);
  const setPanel = useEditor((state) => state.setPanel);
  const mutateProject = useEditor((state) => state.mutateProject);
  // Keep one media element per active clip.  The previous implementation rendered
  // only the selected clip, which made overlays/images appear to disappear as soon
  // as another clip was selected in the timeline.
  const mediaRefs = useRef<Record<string, HTMLVideoElement | null>>({});
  const audioRefs = useRef<Record<string, HTMLAudioElement | null>>({});
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
  const activeClips = project.tracks
    .flatMap((track, trackIndex) => track.clips.map((clip) => ({ clip, track, trackIndex })))
    .filter(({ clip, track }) => !track.hidden && currentTime >= clip.start && currentTime < clip.start + clip.duration);
  const adjustmentClips = activeClips.filter(({ clip }) => clip.adjustment);
  const activeMedia = activeClips.filter(({ clip }) => !clip.adjustment && (clip.type === 'video' || clip.type === 'image'));
  const activeAudio = activeClips.filter(({ clip, track }) => {
    if (track.muted || (clip.type !== 'audio' && clip.type !== 'video')) return false;
    const asset = clip.assetId ? project.assets.find((item) => item.id === clip.assetId) : undefined;
    return Boolean(asset?.hasAudio);
  });
  const texts = activeClips.filter(({ clip }) => !clip.adjustment && clip.textStyle).map(({ clip }) => ({ clip, style: clip.textStyle! }));
  const activeSelected = selectedClipId ? activeClips.find(({ clip }) => clip.id === selectedClipId && (clip.adjustment || clip.type === 'video' || clip.type === 'image' || clip.type === 'text')) : undefined;
  const activeSelectedVisual = activeSelected ? clipVisualValues(activeSelected.clip, currentTime) : null;
  const activeSelectedAsset = activeSelected?.clip.assetId ? project.assets.find((item) => item.id === activeSelected.clip.assetId) : undefined;

  const beginPreviewTransform = (event: React.PointerEvent<HTMLElement>, clip: Clip, mode: 'move' | 'scale') => {
    if (event.button !== 0) return;
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
    audio.volume = clamp(values.volume * trackVolume, 0, 1);
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
    if (!playing) return;
    const timer = window.setInterval(() => { const next = useEditor.getState().currentTime + 1 / project.canvas.fps; if (next >= project.duration) { setPlaying(false); setCurrentTime(0); } else setCurrentTime(next); }, 1000 / project.canvas.fps);
    return () => window.clearInterval(timer);
  }, [playing, project.canvas.fps, project.duration, setCurrentTime, setPlaying]);

  const useProxy = settings?.proxyQuality !== 'high';
  const adjustmentFilter = (clip: Clip) => adjustmentClips.reduce((filter, item) => ({
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
      const mediaFilter = `brightness(${1 + filter.brightness}) contrast(${1 + filter.contrast}) saturate(${1 + filter.saturation}) hue-rotate(${filter.hue}deg) blur(${filter.blur}px) grayscale(${filter.grayscale})${filter.temperature > 0 ? ` sepia(${Math.abs(filter.temperature) * 0.35})` : ''}`;
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
    {texts.map(({ clip, style }) => { const visual = clipVisualValues(clip, currentTime); const bounds = previewTextBounds(style, project.canvas.width, project.canvas.height, canvasScale); const track = project.tracks.find((item) => item.clips.some((candidate) => candidate.id === clip.id)); return <div key={clip.id} className={`preview-text preview-layer ${!isFullscreen && selectedClipIds.includes(clip.id) ? 'preview-selected' : ''}`} role="button" tabIndex={isFullscreen ? -1 : 0} aria-label={t('preview.selectAria', { name: style.text || clip.name })} onPointerDown={(event) => beginPreviewTransform(event, clip, 'move')} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelected(clip.id, track?.id ?? null); } }} style={{ left: '50%', top: '50%', bottom: 'auto', width: bounds.width * canvasScale, zIndex: 100 + (clip.start || 0), pointerEvents: isFullscreen ? 'none' : 'auto', transform: `translate(-50%, -50%) translate(${visual.x * canvasScale}px, ${visual.y * canvasScale}px) rotate(${visual.rotation}deg) scale(${visual.scale})`, opacity: visual.opacity, fontFamily: style.fontFamily, fontSize: Math.max(1, style.fontSize * canvasScale), color: style.color, fontWeight: style.fontWeight, fontStyle: style.fontStyle, textDecoration: style.textDecoration, letterSpacing: `${style.letterSpacing * canvasScale}px`, lineHeight: style.lineHeight, padding: `${style.padding * canvasScale}px`, background: style.background, clipPath: transitionClipPath(visual.wipe), WebkitTextStroke: `${style.strokeWidth * canvasScale}px ${style.stroke}`, textShadow: style.shadow ? '0 2px 8px #000' : 'none', textAlign: style.align }}>{style.text}</div>; })}
    {!isFullscreen && activeSelected && activeSelectedVisual && <div className="preview-transform-box" style={{ zIndex: 300, left: '50%', top: '50%', width: selectedBounds.width * canvasScale, height: selectedBounds.height * canvasScale, transform: `translate(-50%, -50%) translate(${activeSelectedVisual.x * canvasScale}px, ${activeSelectedVisual.y * canvasScale}px) rotate(${activeSelectedVisual.rotation}deg) scale(${activeSelectedVisual.scale})` }}><span className="preview-transform-label">{t(activeSelected.clip.adjustment ? 'preview.type.adjustment' : activeSelected.clip.type === 'text' ? 'preview.type.text' : activeSelected.clip.type === 'image' ? 'preview.type.image' : 'preview.type.video')}</span><button className="preview-scale-handle" aria-label={t('preview.resizeAria')} onPointerDown={(event) => beginPreviewTransform(event, activeSelected.clip, 'scale')} /></div>}
    {!isFullscreen && showSafeArea && <div className="safe-area" />}
          </div>
        </div>
        </div>
      </div>
    </div>
    <div className="preview-controls"><span className="preview-time"><EditableTimecode value={currentTime} duration={project.duration} fps={project.canvas.fps} onChange={setCurrentTime} /> <i>/</i> {formatTime(project.duration, true, project.canvas.fps)}</span><div className="transport-center"><button className="control-button" title={t('preview.previousFrame')} onClick={() => stepFrame(-1)}>↶</button><button className="play-button" aria-label={t(playing ? 'preview.pause' : 'preview.play')} onClick={() => setPlaying(!playing)}>{playing ? 'Ⅱ' : '▶'}</button><button className="control-button" title={t('preview.nextFrame')} onClick={() => stepFrame(1)}>↷</button></div><div className="transport-right"><button className="control-button" title={t('preview.rewind')} onClick={() => { setPlaying(false); setCurrentTime(0); }}>⌁</button><button className="quality-button" onClick={cycleQuality} title={t('preview.quality')}>{t(`settings.previewQuality.${settings?.proxyQuality ?? 'balanced'}` as TranslationKey)}⌄</button></div></div></main>;
}

function InspectorLegacy({ project }: { project: Project }) {
  const selectedClipId = useEditor((state) => state.selectedClipId); const currentTime = useEditor((state) => state.currentTime); const mutateProject = useEditor((state) => state.mutateProject); const setSelected = useEditor((state) => state.setSelected);
  const selected = project.tracks.flatMap((track) => track.clips).find((clip) => clip.id === selectedClipId);
  if (!selected) return <aside className="inspector"><div className="inspector-empty"><span>⌖</span><strong>Klip seç</strong><small>Özellikleri düzenlemek için timeline’dan bir klip seç.</small></div></aside>;
  const update = (recipe: (clip: Clip) => void) => mutateProject((draft) => { const clip = draft.tracks.flatMap((track) => track.clips).find((item) => item.id === selected.id); if (clip) recipe(clip); });
  const addKeyframe = () => {
    const localTime = clamp(currentTime - selected.start, 0, selected.duration);
    mutateProject((draft) => {
      const clip = draft.tracks.flatMap((track) => track.clips).find((item) => item.id === selected.id);
      if (!clip) return;
      const existing = clip.keyframes.find((keyframe) => keyframe.property === 'opacity' && Math.abs(keyframe.time - localTime) < 1 / project.canvas.fps);
      if (!existing) clip.keyframes.push({ id: `key_${crypto.randomUUID().slice(0, 8)}`, property: 'opacity', time: localTime, value: clip.transform.opacity, easing: 'linear' });
    });
  };
  const keyframeEasing = (easing: Clip['keyframes'][number]['easing']) => easing === 'linear' ? 'ease-in' : easing === 'ease-in' ? 'ease-out' : easing === 'ease-out' ? 'ease-in-out' : 'linear';
  const opacityKeyframes = selected.keyframes.filter((keyframe) => keyframe.property === 'opacity').sort((a, b) => a.time - b.time);
  const graphPoints = opacityKeyframes.map((keyframe, index) => {
    const x = opacityKeyframes.length === 1 ? 90 : (index / (opacityKeyframes.length - 1)) * 180;
    return `${x},${58 - clamp(keyframe.value, 0, 1) * 48}`;
  }).join(' ');
  return <aside className="inspector"><div className="inspector-heading"><div><p className="eyebrow">Inspector</p><h2>{selected.type === 'video' ? 'Video klibi' : selected.type === 'audio' ? 'Ses klibi' : 'Klip'}</h2></div><button onClick={() => setSelected(null, null)} aria-label="Seçimi kaldır">×</button></div><div className="selected-file"><div className={`mini-thumb ${selected.type}`}>{selected.type === 'video' ? '▶' : selected.type === 'audio' ? '♫' : 'T'}</div><div><strong>{selected.name}</strong><small>{formatTime(selected.duration)} · {selected.speed}×</small></div></div><InspectorSection title="Transform"><div className="field-grid"><NumberField label="X" value={selected.transform.x} onChange={(value) => update((clip) => { clip.transform.x = value; })} /><NumberField label="Y" value={selected.transform.y} onChange={(value) => update((clip) => { clip.transform.y = value; })} /><NumberField label="Scale" value={selected.transform.scale} step={0.05} onChange={(value) => update((clip) => { clip.transform.scale = value; })} /><NumberField label="Rotate" value={selected.transform.rotation} onChange={(value) => update((clip) => { clip.transform.rotation = value; })} /></div><div className="field-row"><span>Opacity</span><input type="range" min="0" max="1" step="0.01" value={selected.transform.opacity} onChange={(event) => update((clip) => { clip.transform.opacity = Number(event.target.value); })} /><b>{Math.round(selected.transform.opacity * 100)}%</b></div></InspectorSection><InspectorSection title="Video"><div className="field-row"><span>Hız</span><select value={selected.speed} onChange={(event) => update((clip) => { clip.speed = Number(event.target.value); })}><option value="0.25">0.25×</option><option value="0.5">0.5×</option><option value="1">1×</option><option value="1.5">1.5×</option><option value="2">2×</option><option value="4">4×</option></select></div><div className="field-row"><span>Fit mode</span><select value={selected.transform.fit} onChange={(event) => update((clip) => { clip.transform.fit = event.target.value as Clip['transform']['fit']; })}><option value="contain">Contain</option><option value="cover">Cover</option><option value="stretch">Stretch</option></select></div></InspectorSection><InspectorSection title="Renk"><div className="field-row"><span>Brightness</span><input type="range" min="-1" max="1" step="0.01" value={selected.filters.brightness} onChange={(event) => update((clip) => { clip.filters.brightness = Number(event.target.value); })} /></div><div className="field-row"><span>Contrast</span><input type="range" min="-1" max="1" step="0.01" value={selected.filters.contrast} onChange={(event) => update((clip) => { clip.filters.contrast = Number(event.target.value); })} /></div><div className="field-row"><span>Saturation</span><input type="range" min="-1" max="1" step="0.01" value={selected.filters.saturation} onChange={(event) => update((clip) => { clip.filters.saturation = Number(event.target.value); })} /></div></InspectorSection><button className="add-keyframe" onClick={addKeyframe}>◇ Opacity keyframe ekle</button>{opacityKeyframes.length > 0 && <section className="keyframe-graph"><div className="keyframe-graph-head"><strong>Opacity graph</strong><small>{opacityKeyframes.length} keyframe</small></div><svg viewBox="0 0 180 60" role="img" aria-label="Opacity easing graph"><path d="M0 58H180M0 10H180" /><polyline points={graphPoints} /><>{opacityKeyframes.map((keyframe, index) => <circle key={keyframe.id} cx={opacityKeyframes.length === 1 ? 90 : (index / (opacityKeyframes.length - 1)) * 180} cy={58 - clamp(keyframe.value, 0, 1) * 48} r="3" />)}</></svg><div className="keyframe-easing-list">{opacityKeyframes.map((keyframe) => <button key={keyframe.id} onClick={() => mutateProject((draft) => { const target = draft.tracks.flatMap((track) => track.clips).find((clip) => clip.id === selected.id)?.keyframes.find((item) => item.id === keyframe.id); if (target) target.easing = keyframeEasing(target.easing); })}>{formatTime(keyframe.time)} · {keyframe.easing}</button>)}</div></section>}</aside>;
}

function Inspector({ project }: { project: Project }) {
  const { t } = useI18n();
  const selectedClipId = useEditor((state) => state.selectedClipId);
  const selectedClipIds = useEditor((state) => state.selectedClipIds);
  const currentTime = useEditor((state) => state.currentTime);
  const mutateProject = useEditor((state) => state.mutateProject);
  const setSelected = useEditor((state) => state.setSelected);
  const setPanel = useEditor((state) => state.setPanel);
  const [activeGroup, setActiveGroup] = useState<'layout' | 'audio' | 'speed' | 'motion' | 'appearance'>('layout');
  const [activeInspectorTab, setActiveInspectorTab] = useState<'primary' | 'audio' | 'speed' | 'motion' | 'adjust'>('primary');
  const [keyframeProperty, setKeyframeProperty] = useState<Clip['keyframes'][number]['property']>('opacity');
  const selected = project.tracks.flatMap((track) => track.clips).find((clip) => clip.id === selectedClipId);
  const selectedAsset = selected?.assetId ? project.assets.find((asset) => asset.id === selected.assetId) : undefined;
  useEffect(() => {
    setActiveInspectorTab('primary');
    setActiveGroup('layout');
    setKeyframeProperty('opacity');
  }, [selected?.id]);
  if (!selected) return <aside className="inspector"><div className="inspector-empty"><span>⌖</span><strong>{t('inspector.selectClip')}</strong><small>{t('inspector.selectClipHint')}</small></div></aside>;

  const update = (recipe: (clip: Clip) => void) => mutateProject((draft) => {
    const ids = new Set(selectedClipIds.length ? selectedClipIds : [selected.id]);
    for (const track of draft.tracks) {
      if (track.locked) continue;
      for (const clip of track.clips) {
        if (ids.has(clip.id)) recipe(clip);
      }
    }
    // Inspector edits can change clip duration (for example speed/source
    // duration). Keep the project end, ruler and export range in sync.
    draft.duration = projectDuration(draft);
  });
  const updateText = (recipe: (style: NonNullable<Clip['textStyle']>) => void) => update((clip) => {
    if (clip.type !== 'text' && clip.type !== 'subtitle') return;
    const style = clip.textStyle ?? { ...DEFAULT_TEXT_STYLE, text: t('preset.text.clean-title.text') };
    recipe(style);
    clip.textStyle = style;
  });
  const textStyle = selected.textStyle ?? { ...DEFAULT_TEXT_STYLE, text: t('preset.text.clean-title.text') };
  const setSpeed = (value: number) => update((clip) => {
    clip.speed = clamp(value, 0.25, 4);
    retimeClipMotion(clip, Math.max(0.05, clip.sourceDuration / clip.speed));
  });
  const addKeyframe = (property: Clip['keyframes'][number]['property']) => {
    setKeyframeProperty(property);
    const localTime = clamp(currentTime - selected.start, 0, selected.duration);
    mutateProject((draft) => {
      const clip = draft.tracks.flatMap((track) => track.clips).find((item) => item.id === selected.id);
      if (!clip) return;
      const value = property === 'x' ? interpolateKeyframes(clip.keyframes, 'x', localTime, clip.transform.x) : property === 'y' ? interpolateKeyframes(clip.keyframes, 'y', localTime, clip.transform.y) : property === 'scale' ? interpolateKeyframes(clip.keyframes, 'scale', localTime, clip.transform.scale) : property === 'rotation' ? interpolateKeyframes(clip.keyframes, 'rotation', localTime, clip.transform.rotation) : property === 'volume' ? interpolateKeyframes(clip.keyframes, 'volume', localTime, clip.volume) : interpolateKeyframes(clip.keyframes, 'opacity', localTime, clip.transform.opacity);
      const existing = clip.keyframes.find((keyframe) => keyframe.property === property && Math.abs(keyframe.time - localTime) < 1 / project.canvas.fps);
      if (existing) existing.value = value;
      else clip.keyframes.push({ id: `key_${crypto.randomUUID().slice(0, 8)}`, property, time: localTime, value, easing: 'linear' });
    });
  };
  const deleteKeyframe = (keyframeId: string) => mutateProject((draft) => {
    const clip = draft.tracks.flatMap((track) => track.clips).find((item) => item.id === selected.id);
    if (clip) clip.keyframes = clip.keyframes.filter((keyframe) => keyframe.id !== keyframeId);
  });
  const keyframeEasing = (easing: Clip['keyframes'][number]['easing']) => easing === 'linear' ? 'ease-in' : easing === 'ease-in' ? 'ease-out' : easing === 'ease-out' ? 'ease-in-out' : 'linear';
  const activeKeyframes = selected.keyframes.filter((keyframe) => keyframe.property === keyframeProperty).sort((a, b) => a.time - b.time);
  const keyframeRange = keyframeProperty === 'opacity' ? { min: 0, max: 1 } : keyframeProperty === 'scale' ? { min: 0, max: 3 } : keyframeProperty === 'volume' ? { min: 0, max: 2 } : { min: -500, max: 500 };
  const graphPoints = activeKeyframes.map((keyframe, index) => `${activeKeyframes.length === 1 ? 90 : (index / (activeKeyframes.length - 1)) * 180},${58 - clamp((keyframe.value - keyframeRange.min) / Math.max(0.0001, keyframeRange.max - keyframeRange.min), 0, 1) * 48}`).join(' ');
  const typeLabel = t(selected.adjustment ? 'inspector.type.adjustment' : selected.type === 'video' ? 'inspector.type.video' : selected.type === 'audio' ? 'inspector.type.audio' : selected.type === 'image' ? 'inspector.type.image' : selected.type === 'text' ? 'inspector.type.text' : 'inspector.type.clip');
  const textColor = textStyle.color.startsWith('#') ? textStyle.color : '#ffffff';
  const isTextClip = selected.type === 'text' || selected.type === 'subtitle';
  const supportsSpeedCurve = selected.type === 'video' || selected.type === 'image' || selected.type === 'audio';
  const speedPresets = [0.25, 0.5, 1, 1.5, 2, 4] as const;
  const curvePoints = selected.speedCurve ?? [];
  const speedCurveMode = !curvePoints.length ? 'constant' : curvePoints.length >= 4 ? 'pulse' : (curvePoints[0]?.speed ?? selected.speed) <= (curvePoints.at(-1)?.speed ?? selected.speed) ? 'rampUp' : 'rampDown';
  const speedGraphPoints = Array.from({ length: 49 }, (_, index) => {
    const time = selected.duration * index / 48;
    const value = clamp(speedAt(selected.speedCurve, selected.speed, time), 0.25, 4);
    const x = 12 + index * 4.5;
    const y = 86 - ((Math.log2(value) + 2) / 4) * 64;
    return `${x},${y}`;
  }).join(' ');
  const setSpeedCurveMode = (mode: 'constant' | 'rampUp' | 'rampDown' | 'pulse') => update((clip) => {
    if (clip.type === 'text' || clip.type === 'subtitle') return;
    const base = clamp(clip.speed, 0.25, 4);
    const slow = clamp(base * 0.5, 0.25, 4);
    const fast = clamp(base * 1.75, 0.25, 4);
    clip.speedCurve = mode === 'constant' ? undefined : mode === 'rampUp'
      ? [{ time: 0, speed: slow, easing: 'ease-in' }, { time: clip.duration / 2, speed: base, easing: 'ease-in-out' }, { time: clip.duration, speed: fast, easing: 'ease-out' }]
      : mode === 'rampDown'
        ? [{ time: 0, speed: fast, easing: 'ease-out' }, { time: clip.duration / 2, speed: base, easing: 'ease-in-out' }, { time: clip.duration, speed: slow, easing: 'ease-in' }]
        : [{ time: 0, speed: base, easing: 'ease-in-out' }, { time: clip.duration * 0.3, speed: fast, easing: 'ease-out' }, { time: clip.duration * 0.7, speed: slow, easing: 'ease-in' }, { time: clip.duration, speed: base, easing: 'ease-in-out' }];
  });
  const addSpeedPoint = () => update((clip) => {
    if (clip.type === 'text' || clip.type === 'subtitle') return;
    const time = clamp(currentTime - clip.start, 0, clip.duration);
    const point = { time, speed: speedAt(clip.speedCurve, clip.speed, time), easing: 'ease-in-out' as const };
    clip.speedCurve = [...(clip.speedCurve ?? [{ time: 0, speed: clip.speed, easing: 'linear' as const }, { time: clip.duration, speed: clip.speed, easing: 'linear' as const }]), point].sort((a, b) => a.time - b.time);
  });

  const resolvedGroup = activeInspectorTab === 'motion' ? 'motion' : activeInspectorTab === 'primary' ? 'layout' : activeInspectorTab === 'speed' ? 'speed' : activeInspectorTab === 'adjust' ? 'appearance' : 'audio';
  const inspectorTabs: Array<[typeof activeInspectorTab, TranslationKey]> = selected.type === 'text' && !selected.adjustment
    ? [['primary', 'inspector.tab.layout'], ['speed', 'inspector.tab.speed'], ['motion', 'inspector.tab.animation'], ['adjust', 'inspector.tab.textStyle']]
    : selected.type === 'subtitle'
      ? [['primary', 'inspector.tab.layout'], ['speed', 'inspector.tab.speed'], ['motion', 'inspector.tab.animation']]
    : selected.type === 'image' || selected.adjustment
      ? [['primary', 'inspector.tab.layout'], ['speed', 'inspector.tab.speed'], ['motion', 'inspector.tab.animation'], ['adjust', 'inspector.tab.appearance']]
      : selected.type === 'audio'
        ? [['primary', 'inspector.tab.layout'], ['audio', 'inspector.tab.audioTrim'], ['speed', 'inspector.tab.speed'], ['motion', 'inspector.tab.animation']]
        : [['primary', 'inspector.tab.layout'], ['audio', 'inspector.tab.audioTrim'], ['speed', 'inspector.tab.speed'], ['motion', 'inspector.tab.animation'], ['adjust', 'inspector.tab.appearance']];
  return <aside className="inspector inspector-pro">
    {selectedClipIds.length > 1 && <div className="multi-selection-hint">{t('inspector.multiSelection', { count: selectedClipIds.length })}</div>}
    <div className="inspector-heading"><div><p className="eyebrow">{t('inspector.title')}</p><h2>{t('inspector.clipTitle', { type: typeLabel })}</h2></div><button onClick={() => setSelected(null, null)} aria-label={t('inspector.clearSelection')}>×</button></div>
    <div className="selected-file"><div className={`mini-thumb ${selected.type} ${selected.adjustment ? 'adjustment' : ''}`}>{selected.adjustment ? '✦' : selected.type === 'video' ? '▶' : selected.type === 'audio' ? '♫' : selected.type === 'image' ? '▧' : 'T'}</div><div><strong>{selected.name}</strong><small>{formatTime(selected.duration)} · {selected.speed}×{selectedAsset ? ` · ${selectedAsset.mimeType}` : ''}</small></div></div>
    <div className="inspector-tool-tabs" role="tablist" aria-label={t('inspector.tools')}>
      {inspectorTabs.map(([key, labelKey]) => <button key={key} role="tab" aria-selected={activeInspectorTab === key} className={activeInspectorTab === key ? 'active' : ''} onClick={() => { setActiveInspectorTab(key); setActiveGroup(key === 'motion' ? 'motion' : key === 'primary' ? 'layout' : key === 'speed' ? 'speed' : key === 'adjust' ? 'appearance' : 'audio'); }}><span>{t(labelKey)}</span></button>)}
    </div>
    <div className="inspector-group-note">{t(resolvedGroup === 'layout' ? 'inspector.note.layout' : resolvedGroup === 'motion' ? 'inspector.note.motion' : resolvedGroup === 'speed' ? 'inspector.note.speed' : resolvedGroup === 'appearance' ? 'inspector.note.appearance' : selected.type === 'audio' || selected.type === 'video' ? 'inspector.note.audio' : 'inspector.note.text')}</div>

    {resolvedGroup === 'layout' && <InspectorSection id="inspector-transform" title={t('inspector.transform')}>
      <div className="field-grid"><NumberField label="X" value={selected.transform.x} onChange={(value) => update((clip) => { clip.transform.x = value; })} /><NumberField label="Y" value={selected.transform.y} onChange={(value) => update((clip) => { clip.transform.y = value; })} /><NumberField label={t('inspector.scale')} value={selected.transform.scale} step={0.05} onChange={(value) => update((clip) => { clip.transform.scale = Math.max(0.05, value); })} /><NumberField label={t('inspector.rotate')} value={selected.transform.rotation} onChange={(value) => update((clip) => { clip.transform.rotation = value; })} /></div>
      <NumberField label={t('inspector.opacity')} value={Math.round(selected.transform.opacity * 100)} min={0} max={100} step={1} onChange={(value) => update((clip) => { clip.transform.opacity = value / 100; })} />
      {(selected.type === 'video' || selected.type === 'image') && <div className="inspector-button-row"><button className={selected.transform.flipX ? 'active' : ''} onClick={() => update((clip) => { clip.transform.flipX = !clip.transform.flipX; })}>↔ {t('inspector.flipHorizontal')}</button><button className={selected.transform.flipY ? 'active' : ''} onClick={() => update((clip) => { clip.transform.flipY = !clip.transform.flipY; })}>↕ {t('inspector.flipVertical')}</button></div>}
    </InspectorSection>}
    {resolvedGroup === 'motion' && <InspectorSection id="inspector-motion" title={t('inspector.motionKeyframes')}>
      <div className="inspector-animation-launch"><div><strong>{t('inspector.transitionBehavior')}</strong><small>{t('inspector.transitionBehaviorCopy')}</small></div><button onClick={() => setPanel('animation')}>{t('inspector.openStudio')} ↗</button></div>
      <div className="inspector-button-row keyframe-buttons"><button onClick={() => addKeyframe('x')}>X</button><button onClick={() => addKeyframe('y')}>Y</button><button onClick={() => addKeyframe('scale')}>{t('inspector.scale')}</button><button onClick={() => addKeyframe('rotation')}>{t('inspector.rotate')}</button><button onClick={() => addKeyframe('opacity')}>Opacity</button>{(selected.type === 'audio' || selected.type === 'video') && <button onClick={() => addKeyframe('volume')}>{t('inspector.volume')}</button>}</div>
      <div className="inspector-tip"><strong>{t('inspector.keyframeWhat')}</strong> {t('inspector.keyframeWhatCopy')}</div>
    </InspectorSection>}

    {resolvedGroup === 'appearance' && selected.type === 'text' && !selected.adjustment && <InspectorSection id="inspector-text" title={t('inspector.textStyle')}>
      <label className="inspector-wide-field"><span>{t('inspector.text')}</span><textarea value={textStyle.text} rows={3} onChange={(event) => updateText((style) => { style.text = event.target.value; })} /></label>
      <div className="field-row"><span>{t('inspector.font')}</span><select aria-label={t('inspector.font')} value={textStyle.fontFamily} onChange={(event) => updateText((style) => { style.fontFamily = event.target.value; })}>{TEXT_FONT_OPTIONS.map((font) => <option key={font} value={font}>{font.split(',')[0]}</option>)}</select></div>
      <div className="field-grid"><NumberField label={t('inspector.size')} value={textStyle.fontSize} step={1} onChange={(value) => updateText((style) => { style.fontSize = Math.max(8, value); })} /><NumberField label={t('inspector.letterSpacing')} value={textStyle.letterSpacing} step={0.5} onChange={(value) => updateText((style) => { style.letterSpacing = value; })} /><NumberField label={t('inspector.lineHeight')} value={textStyle.lineHeight} step={0.05} onChange={(value) => updateText((style) => { style.lineHeight = clamp(value, 0.5, 3); })} /><NumberField label={t('inspector.padding')} value={textStyle.padding} step={1} onChange={(value) => updateText((style) => { style.padding = Math.max(0, value); })} /></div>
      <div className="field-row"><span>{t('inspector.weight')}</span><select aria-label={t('inspector.weight')} value={textStyle.fontWeight} onChange={(event) => updateText((style) => { style.fontWeight = Number(event.target.value); })}><option value="300">Light 300</option><option value="400">Regular 400</option><option value="500">Medium 500</option><option value="600">Semibold 600</option><option value="700">Bold 700</option><option value="800">Extra bold 800</option><option value="900">Black 900</option></select></div>
      <div className="inspector-button-row"><button className={textStyle.fontStyle === 'italic' ? 'active' : ''} onClick={() => updateText((style) => { style.fontStyle = style.fontStyle === 'italic' ? 'normal' : 'italic'; })}>{t('inspector.italic')}</button><button className={textStyle.textDecoration === 'underline' ? 'active' : ''} onClick={() => updateText((style) => { style.textDecoration = style.textDecoration === 'underline' ? 'none' : 'underline'; })}>{t('inspector.underline')}</button><button className={textStyle.shadow ? 'active' : ''} onClick={() => updateText((style) => { style.shadow = !style.shadow; })}>{t('inspector.shadow')}</button></div>
      <div className="field-row"><span>{t('inspector.alignment')}</span><div className="segmented-control"><button className={textStyle.align === 'left' ? 'active' : ''} onClick={() => updateText((style) => { style.align = 'left'; })}>{t('inspector.left')}</button><button className={textStyle.align === 'center' ? 'active' : ''} onClick={() => updateText((style) => { style.align = 'center'; })}>{t('inspector.center')}</button><button className={textStyle.align === 'right' ? 'active' : ''} onClick={() => updateText((style) => { style.align = 'right'; })}>{t('inspector.right')}</button></div></div>
      <div className="color-grid"><label><span>{t('inspector.color')}</span><input type="color" value={textColor} onChange={(event) => updateText((style) => { style.color = event.target.value; })} /></label><label><span>{t('inspector.background')}</span><input type="text" value={textStyle.background} onChange={(event) => updateText((style) => { style.background = event.target.value; })} /></label><label><span>{t('inspector.stroke')}</span><input type="text" value={textStyle.stroke} onChange={(event) => updateText((style) => { style.stroke = event.target.value; })} /></label><NumberField label={t('inspector.strokePx')} value={textStyle.strokeWidth} step={1} onChange={(value) => updateText((style) => { style.strokeWidth = clamp(value, 0, 20); })} /></div>
    </InspectorSection>}

    {resolvedGroup === 'speed' && !selected.adjustment && (supportsSpeedCurve || isTextClip) && <InspectorSection id="inspector-media" title={t(isTextClip ? 'inspector.textSpeed' : selected.type === 'image' ? 'inspector.imageSpeed' : selected.type === 'audio' ? 'inspector.audioSpeed' : 'inspector.videoSpeed')}>
      <div className="speed-editor">
        <div className="speed-value-card"><span>{t('inspector.speedValue')}</span><output>{selected.speed.toFixed(2)}×</output><input className="speed-slider" aria-label={t('inspector.clipSpeed')} type="range" min="0.25" max="4" step="0.05" value={selected.speed} onChange={(event) => setSpeed(Number(event.target.value))} /></div>
        <div className="speed-control-label"><strong>{t('inspector.speedPresets')}</strong><small>0.25× — 4×</small></div>
        <div className="speed-preset-grid">{speedPresets.map((value) => <button key={value} className={Math.abs(selected.speed - value) < 0.001 ? 'active' : ''} aria-pressed={Math.abs(selected.speed - value) < 0.001} onClick={() => setSpeed(value)}>{value}×</button>)}</div>
        {(selected.type === 'video' || selected.type === 'image') && <div className="field-row"><span>{t('inspector.image')}</span><select value={selected.transform.fit} onChange={(event) => update((clip) => { clip.transform.fit = event.target.value as Clip['transform']['fit']; })}>{(['contain', 'cover', 'stretch'] as const).map((value) => <option key={value} value={value}>{t(`inspector.fit.${value}` as TranslationKey)}</option>)}</select></div>}
        <div className="speed-curve-card">
          <div className="speed-control-label"><strong>{t('inspector.speedGraph')}</strong><small>{supportsSpeedCurve ? t('inspector.speedGraphHint') : t('inspector.textSpeedHint')}</small></div>
          <svg className="speed-curve-graph" viewBox="0 0 240 100" role="img" aria-label={t('inspector.speedGraphAria')}>
            <path className="speed-graph-grid" d="M12 22H228M12 38H228M12 54H228M12 70H228M12 86H228" />
            <polyline points={speedGraphPoints} />
            {curvePoints.map((point, index) => { const x = 12 + clamp(point.time / Math.max(selected.duration, 0.05), 0, 1) * 216; const y = 86 - ((Math.log2(clamp(point.speed, 0.25, 4)) + 2) / 4) * 64; return <circle key={`${point.time}-${index}`} cx={x} cy={y} r="3.5" />; })}
          </svg>
          <div className="speed-graph-scale" aria-hidden="true"><span>4×</span><span>2×</span><span>1×</span><span>0.5×</span><span>0.25×</span></div>
        </div>
        {supportsSpeedCurve && <>
          <div className="speed-control-label"><strong>{t('inspector.speedModes')}</strong><small>{t('inspector.speedCurve')}</small></div>
          <div className="speed-mode-grid">{(['constant', 'rampUp', 'rampDown', 'pulse'] as const).map((value) => <button key={value} className={speedCurveMode === value ? 'active' : ''} aria-pressed={speedCurveMode === value} onClick={() => setSpeedCurveMode(value)}>{t(`inspector.speedMode.${value}` as TranslationKey)}</button>)}</div>
          {curvePoints.length > 0 && <div className="speed-point-list"><div className="keyframe-graph-head"><strong>{t('inspector.speedPoints')}</strong><small>{t('inspector.points', { count: curvePoints.length })}</small></div>{curvePoints.map((point, index) => <div className="speed-point-row" key={`${point.time}-${index}`}><NumberField label={t('inspector.time')} value={point.time} min={0} max={selected.duration} step={0.05} onChange={(value) => update((clip) => { if (clip.speedCurve?.[index]) { clip.speedCurve[index].time = clamp(value, 0, clip.duration); clip.speedCurve.sort((a, b) => a.time - b.time); } })} /><NumberField label={t('inspector.speed')} value={point.speed} min={0.25} max={4} step={0.05} onChange={(value) => update((clip) => { if (clip.speedCurve?.[index]) clip.speedCurve[index].speed = clamp(value, 0.25, 4); })} /><button className="keyframe-delete" aria-label={t('inspector.deleteSpeedPoint')} onClick={() => update((clip) => { clip.speedCurve = clip.speedCurve?.filter((_, pointIndex) => pointIndex !== index); })}>×</button></div>)}</div>}
          <button className="speed-add-point" onClick={addSpeedPoint}>＋ {t('inspector.addSpeedPoint')}</button>
        </>}
      </div>
    </InspectorSection>}

    {resolvedGroup === 'motion' && (selected.type === 'video' || selected.type === 'image') && <InspectorSection id="inspector-transition" title={t('inspector.maskTransition')}>
      <div className="field-row"><span>{t('inspector.maskShape')}</span><select value={selected.mask?.type ?? 'rectangle'} onChange={(event) => update((clip) => { clip.mask = { type: event.target.value as 'rectangle' | 'ellipse', x: clip.mask?.x ?? 0, y: clip.mask?.y ?? 0, width: clip.mask?.width ?? 1, height: clip.mask?.height ?? 1, feather: clip.mask?.feather ?? 0, invert: clip.mask?.invert ?? false }; })}><option value="rectangle">{t('inspector.rectangle')}</option><option value="ellipse">{t('inspector.ellipse')}</option></select></div>
      <div className="field-grid"><NumberField label="Mask X" value={selected.mask?.x ?? 0} min={0} max={1 - (selected.mask?.width ?? 1)} step={0.01} onChange={(value) => update((clip) => { const width = clip.mask?.width ?? 1; clip.mask = { type: clip.mask?.type ?? 'rectangle', x: clamp(value, 0, 1 - width), y: clip.mask?.y ?? 0, width, height: clip.mask?.height ?? 1, feather: clip.mask?.feather ?? 0, invert: clip.mask?.invert ?? false }; })} /><NumberField label="Mask Y" value={selected.mask?.y ?? 0} min={0} max={1 - (selected.mask?.height ?? 1)} step={0.01} onChange={(value) => update((clip) => { const height = clip.mask?.height ?? 1; clip.mask = { type: clip.mask?.type ?? 'rectangle', x: clip.mask?.x ?? 0, y: clamp(value, 0, 1 - height), width: clip.mask?.width ?? 1, height, feather: clip.mask?.feather ?? 0, invert: clip.mask?.invert ?? false }; })} /><NumberField label={t('inspector.width')} value={selected.mask?.width ?? 1} min={0.01} max={1 - (selected.mask?.x ?? 0)} step={0.01} onChange={(value) => update((clip) => { const x = clip.mask?.x ?? 0; clip.mask = { type: clip.mask?.type ?? 'rectangle', x, y: clip.mask?.y ?? 0, width: clamp(value, 0.01, 1 - x), height: clip.mask?.height ?? 1, feather: clip.mask?.feather ?? 0, invert: clip.mask?.invert ?? false }; })} /><NumberField label={t('inspector.height')} value={selected.mask?.height ?? 1} min={0.01} max={1 - (selected.mask?.y ?? 0)} step={0.01} onChange={(value) => update((clip) => { const y = clip.mask?.y ?? 0; clip.mask = { type: clip.mask?.type ?? 'rectangle', x: clip.mask?.x ?? 0, y, width: clip.mask?.width ?? 1, height: clamp(value, 0.01, 1 - y), feather: clip.mask?.feather ?? 0, invert: clip.mask?.invert ?? false }; })} /></div>
      <NumberField label={t('inspector.feather')} value={Math.round((selected.mask?.feather ?? 0) * 100)} min={0} max={100} step={1} onChange={(value) => update((clip) => { if (clip.mask) clip.mask.feather = value / 100; else clip.mask = { type: 'rectangle', x: 0, y: 0, width: 1, height: 1, feather: value / 100, invert: false }; })} />
      <button className="inspector-reset-button" onClick={() => update((clip) => { clip.mask = undefined; })}>{t('inspector.resetMask')}</button>
      <div className="field-grid"><label className="inspector-wide-field"><span>{t('inspector.transitionIn')}</span><select value={selected.transitionIn?.type ?? 'none'} onChange={(event) => update((clip) => { clip.transitionIn.type = event.target.value as Clip['transitionIn']['type']; })}>{['none', 'fade', 'dissolve', 'slide', 'wipe', 'zoom'].map((value) => <option key={value} value={value}>{t(`inspector.transition.${value}` as TranslationKey)}</option>)}</select></label><label className="inspector-wide-field"><span>{t('inspector.transitionOut')}</span><select value={selected.transitionOut?.type ?? 'none'} onChange={(event) => update((clip) => { clip.transitionOut.type = event.target.value as Clip['transitionOut']['type']; })}>{['none', 'fade', 'dissolve', 'slide', 'wipe', 'zoom'].map((value) => <option key={value} value={value}>{t(`inspector.transition.${value}` as TranslationKey)}</option>)}</select></label></div>
      <div className="field-grid"><NumberField label={t('inspector.inSeconds')} value={selected.transitionIn?.duration ?? 0} step={0.05} onChange={(value) => update((clip) => { clip.transitionIn.duration = clamp(value, 0, Math.min(5, clip.duration)); })} /><NumberField label={t('inspector.outSeconds')} value={selected.transitionOut?.duration ?? 0} step={0.05} onChange={(value) => update((clip) => { clip.transitionOut.duration = clamp(value, 0, Math.min(5, clip.duration)); })} /></div>
    </InspectorSection>}

    {resolvedGroup === 'motion' && (selected.type === 'video' || selected.type === 'image') && <InspectorSection id="inspector-transition-details" title={t('inspector.transitionDetails')}><div className="field-grid"><label className="inspector-wide-field"><span>{t('inspector.directionIn')}</span><select value={selected.transitionIn?.direction ?? 'left'} onChange={(event) => update((clip) => { clip.transitionIn.direction = event.target.value as NonNullable<Clip['transitionIn']>['direction']; })}>{(['left', 'right', 'up', 'down', 'center'] as const).map((value) => <option key={value} value={value}>{t(`animation.direction.${value}` as TranslationKey)}</option>)}</select></label><label className="inspector-wide-field"><span>{t('inspector.directionOut')}</span><select value={selected.transitionOut?.direction ?? 'left'} onChange={(event) => update((clip) => { clip.transitionOut.direction = event.target.value as NonNullable<Clip['transitionOut']>['direction']; })}>{(['left', 'right', 'up', 'down', 'center'] as const).map((value) => <option key={value} value={value}>{t(`animation.direction.${value}` as TranslationKey)}</option>)}</select></label></div><div className="field-grid"><label className="inspector-wide-field"><span>{t('inspector.easingIn')}</span><select value={selected.transitionIn?.easing ?? 'ease-in-out'} onChange={(event) => update((clip) => { clip.transitionIn.easing = event.target.value as NonNullable<Clip['transitionIn']>['easing']; })}><option value="linear">{t('animation.easing.linear')}</option><option value="ease-in">{t('animation.easing.in')}</option><option value="ease-out">{t('animation.easing.out')}</option><option value="ease-in-out">{t('animation.easing.both')}</option></select></label><label className="inspector-wide-field"><span>{t('inspector.easingOut')}</span><select value={selected.transitionOut?.easing ?? 'ease-in-out'} onChange={(event) => update((clip) => { clip.transitionOut.easing = event.target.value as NonNullable<Clip['transitionOut']>['easing']; })}><option value="linear">{t('animation.easing.linear')}</option><option value="ease-in">{t('animation.easing.in')}</option><option value="ease-out">{t('animation.easing.out')}</option><option value="ease-in-out">{t('animation.easing.both')}</option></select></label></div><div className="field-grid"><NumberField label={t('inspector.intensityIn')} value={selected.transitionIn?.intensity ?? 1} min={0.1} max={2} step={0.1} onChange={(value) => update((clip) => { clip.transitionIn.intensity = clamp(value, 0.1, 2); })} /><NumberField label={t('inspector.intensityOut')} value={selected.transitionOut?.intensity ?? 1} min={0.1} max={2} step={0.1} onChange={(value) => update((clip) => { clip.transitionOut.intensity = clamp(value, 0.1, 2); })} /></div><label className="check-field"><input type="checkbox" checked={Boolean(selected.mask?.invert)} onChange={(event) => update((clip) => { if (clip.mask) clip.mask.invert = event.target.checked; })} /><span>{t('inspector.invertMask')}</span></label></InspectorSection>}

    {resolvedGroup === 'audio' && !selected.adjustment && (selected.type === 'audio' || selected.type === 'video') && <InspectorSection id="inspector-audio" title={t('inspector.audioTrim')}>
      <NumberField label={t('inspector.volumePercent')} value={Math.round(selected.volume * 100)} min={0} max={200} step={1} onChange={(value) => update((clip) => { clip.volume = value / 100; })} />
      <div className="field-grid"><NumberField label={t('inspector.sourceStart')} value={selected.sourceStart} step={0.01} onChange={(value) => update((clip) => { clip.sourceStart = Math.max(0, value); })} /><NumberField label={t('inspector.sourceDuration')} value={selected.sourceDuration} step={0.01} onChange={(value) => update((clip) => { clip.sourceDuration = Math.max(0.05, value); retimeClipMotion(clip, Math.max(0.05, clip.sourceDuration / clip.speed)); })} /></div>
      <div className="field-grid"><NumberField label={t('inspector.fadeIn')} value={selected.fadeIn ?? 0} step={0.05} onChange={(value) => update((clip) => { clip.fadeIn = clamp(value, 0, clip.duration); })} /><NumberField label={t('inspector.fadeOut')} value={selected.fadeOut ?? 0} step={0.05} onChange={(value) => update((clip) => { clip.fadeOut = clamp(value, 0, clip.duration); })} /></div>
      <label className="check-field"><input type="checkbox" checked={Boolean(selected.normalize)} onChange={(event) => update((clip) => { clip.normalize = event.target.checked; })} /><span>{t('inspector.normalize')}</span></label>
      <div className="inspector-button-row"><button className={selected.volume === 0 ? 'active' : ''} onClick={() => update((clip) => { clip.volume = clip.volume === 0 ? 1 : 0; })}>{t(selected.volume === 0 ? 'inspector.unmute' : 'inspector.mute')}</button></div>
    </InspectorSection>}

    {resolvedGroup === 'appearance' && (selected.adjustment || selected.type === 'video' || selected.type === 'image') && <InspectorSection id="inspector-color" title={t(selected.adjustment ? 'inspector.adjustmentAppearance' : 'inspector.colorEffectsCrop')}>
      <NumberField label={t('inspector.brightness')} value={Math.round(selected.filters.brightness * 100)} min={-100} max={100} step={1} onChange={(value) => update((clip) => { clip.filters.brightness = value / 100; })} />
      <NumberField label={t('inspector.contrast')} value={Math.round(selected.filters.contrast * 100)} min={-100} max={100} step={1} onChange={(value) => update((clip) => { clip.filters.contrast = value / 100; })} />
      <NumberField label={t('inspector.saturation')} value={Math.round(selected.filters.saturation * 100)} min={-100} max={100} step={1} onChange={(value) => update((clip) => { clip.filters.saturation = value / 100; })} />
      <NumberField label={t('inspector.blur')} value={selected.filters.blur} min={0} max={24} step={0.5} onChange={(value) => update((clip) => { clip.filters.blur = value; })} />
      <NumberField label={t('inspector.temperature')} value={Math.round((selected.filters.temperature ?? 0) * 100)} min={-100} max={100} step={1} onChange={(value) => update((clip) => { clip.filters.temperature = value / 100; })} />
      <NumberField label={t('inspector.hue')} value={selected.filters.hue ?? 0} min={-180} max={180} step={1} onChange={(value) => update((clip) => { clip.filters.hue = value; })} />
      <NumberField label={t('inspector.vignette')} value={Math.round((selected.filters.vignette ?? 0) * 100)} min={0} max={100} step={1} onChange={(value) => update((clip) => { clip.filters.vignette = value / 100; })} />
    </InspectorSection>}

    {resolvedGroup === 'appearance' && !selected.adjustment && (selected.type === 'video' || selected.type === 'image') && <InspectorSection id="inspector-crop" title={t('inspector.crop')}><div className="inspector-tip">{t('inspector.cropTip')}</div><div className="field-grid"><NumberField label="X %" value={Math.round((selected.crop?.x ?? 0) * 100)} min={0} max={Math.round((1 - (selected.crop?.width ?? 1)) * 100)} onChange={(value) => update((clip) => { const width = clip.crop?.width ?? 1; clip.crop = { x: clamp(value / 100, 0, 1 - width), y: clip.crop?.y ?? 0, width, height: clip.crop?.height ?? 1 }; })} /><NumberField label="Y %" value={Math.round((selected.crop?.y ?? 0) * 100)} min={0} max={Math.round((1 - (selected.crop?.height ?? 1)) * 100)} onChange={(value) => update((clip) => { const height = clip.crop?.height ?? 1; clip.crop = { x: clip.crop?.x ?? 0, y: clamp(value / 100, 0, 1 - height), width: clip.crop?.width ?? 1, height }; })} /><NumberField label={`${t('inspector.width')} %`} value={Math.round((selected.crop?.width ?? 1) * 100)} min={1} max={Math.round((1 - (selected.crop?.x ?? 0)) * 100)} onChange={(value) => update((clip) => { const x = clip.crop?.x ?? 0; clip.crop = { x, y: clip.crop?.y ?? 0, width: clamp(value / 100, 0.01, 1 - x), height: clip.crop?.height ?? 1 }; })} /><NumberField label={`${t('inspector.height')} %`} value={Math.round((selected.crop?.height ?? 1) * 100)} min={1} max={Math.round((1 - (selected.crop?.y ?? 0)) * 100)} onChange={(value) => update((clip) => { const y = clip.crop?.y ?? 0; clip.crop = { x: clip.crop?.x ?? 0, y, width: clip.crop?.width ?? 1, height: clamp(value / 100, 0.01, 1 - y) }; })} /></div><button className="inspector-reset-button" onClick={() => update((clip) => { clip.crop = undefined; })}>{t('inspector.resetCrop')}</button></InspectorSection>}

    {resolvedGroup === 'motion' && <><div className="keyframe-current"><span>{t('inspector.keyframe', { property: keyframeProperty })}</span><button className="add-keyframe" onClick={() => addKeyframe(keyframeProperty)}>◇ {t('inspector.add')}</button></div>
    {activeKeyframes.length > 0 && <section className="keyframe-graph"><div className="keyframe-graph-head"><strong>{t('inspector.graph', { property: keyframeProperty })}</strong><small>{t('inspector.keyframes', { count: activeKeyframes.length })}</small></div><svg viewBox="0 0 180 60" role="img" aria-label={t('inspector.graphAria')}><path d="M0 58H180M0 10H180" /><polyline points={graphPoints} />{activeKeyframes.map((keyframe, index) => <circle key={keyframe.id} cx={activeKeyframes.length === 1 ? 90 : (index / (activeKeyframes.length - 1)) * 180} cy={58 - clamp((keyframe.value - keyframeRange.min) / Math.max(0.0001, keyframeRange.max - keyframeRange.min), 0, 1) * 48} r="3" />)}</svg><div className="keyframe-easing-list">{activeKeyframes.map((keyframe) => <span key={keyframe.id}><button onClick={() => mutateProject((draft) => { const target = draft.tracks.flatMap((track) => track.clips).find((clip) => clip.id === selected.id)?.keyframes.find((item) => item.id === keyframe.id); if (target) target.easing = keyframeEasing(target.easing); })}>{formatTime(keyframe.time)} · {keyframe.easing}</button><button className="keyframe-delete" aria-label={t('inspector.deleteKeyframe')} onClick={() => deleteKeyframe(keyframe.id)}>×</button></span>)}</div></section>}</>}
  </aside>;
}

function InspectorSection({ id, title, children }: { id?: string; title: string; children: React.ReactNode }) { const [open, setOpen] = useState(true); return <section id={id} className="inspector-section"><button className="section-toggle" onClick={() => setOpen((value) => !value)} aria-expanded={open}><span>{open ? '⌄' : '›'}</span><strong>{title}</strong><i>{open ? '◇' : '＋'}</i></button>{open && children}</section>; }
function NumberField({ label, value, step = 1, min, max, onChange }: { label: string; value: number; step?: number; min?: number; max?: number; onChange: (value: number) => void }) {
  const { t } = useI18n();
  const decimalPlaces = (number: number) => {
    if (!Number.isFinite(number)) return 0;
    const text = String(number);
    if (text.includes('e-')) return Number(text.split('e-')[1]) || 0;
    return Math.min(6, Math.max(0, (text.split('.')[1] ?? '').length));
  };
  // Keep higher-precision media timings intact while still respecting the
  // declared step.  Without this, nudging a 68.566s source duration by 0.01
  // rounded it to two decimals and a second nudge could not return to the
  // original value.
  const precision = Math.max(decimalPlaces(step), decimalPlaces(value));
  const clampValue = (next: number) => {
    if (!Number.isFinite(next)) return value;
    const bounded = Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min ?? Number.NEGATIVE_INFINITY, next));
    return precision ? Number(bounded.toFixed(precision)) : Math.round(bounded);
  };
  const nudge = (direction: -1 | 1) => onChange(clampValue(value + direction * step));
  const dragRef = useRef<{ startX: number; startValue: number; accumulated: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const beginValueDrag = (event: React.PointerEvent<HTMLInputElement>) => {
    if (event.button !== 0) return;
    dragRef.current = { startX: event.clientX, startValue: value, accumulated: 0 };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveValueDrag = (event: React.PointerEvent<HTMLInputElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const pointerLocked = document.pointerLockElement === event.currentTarget;
    if (pointerLocked) drag.accumulated += event.movementX;
    const delta = pointerLocked ? drag.accumulated : event.clientX - drag.startX;
    if (!isDragging && Math.abs(delta) < 3) return;
    if (!isDragging) {
      setIsDragging(true);
      void event.currentTarget.requestPointerLock?.();
    }
    event.preventDefault();
    const pixelsPerStep = 6;
    onChange(clampValue(drag.startValue + (delta / pixelsPerStep) * step));
  };
  const finishValueDrag = () => {
    if (document.pointerLockElement) document.exitPointerLock();
    dragRef.current = null;
    setIsDragging(false);
  };
  return <div className="number-field">
    <span>{label}</span>
    <div className="number-stepper">
      <button type="button" aria-label={t('number.decrease', { label })} title={t('number.decreaseTitle')} onClick={() => nudge(-1)}>−</button>
      <input className={isDragging ? 'number-drag-input is-dragging' : 'number-drag-input'} aria-label={label} title={t('number.dragTitle')} type="number" value={value} step={step} min={min} max={max} onPointerDown={beginValueDrag} onPointerMove={moveValueDrag} onPointerUp={finishValueDrag} onPointerCancel={finishValueDrag} onChange={(event) => onChange(clampValue(Number(event.target.value)))} />
      <button type="button" aria-label={t('number.increase', { label })} title={t('number.increaseTitle')} onClick={() => nudge(1)}>＋</button>
    </div>
  </div>;
}

const TIMELINE_LABEL_WIDTH = 160;

type TimelineDrag =
  | { kind: 'clip'; clipId: string; trackId: string; startX: number; start: number }
  | { kind: 'playhead'; startX: number }
  | { kind: 'marker'; markerId: string; startX: number; start: number };

function Timeline({ project }: { project: Project }) {
  const currentTime = useEditor((state) => state.currentTime);
  const setCurrentTime = useEditor((state) => state.setCurrentTime);
  const px = useEditor((state) => state.pxPerSecond);
  const setZoom = useEditor((state) => state.setZoom);
  const selectedClipId = useEditor((state) => state.selectedClipId);
  const setSelected = useEditor((state) => state.setSelected);
  const mutateProject = useEditor((state) => state.mutateProject);
  const timelineRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<TimelineDrag | null>(null);
  const [trackTypeMenuOpen, setTrackTypeMenuOpen] = useState(false);
  const [trackMenuId, setTrackMenuId] = useState<string | null>(null);
  const [editingTrackId, setEditingTrackId] = useState<string | null>(null);
  const [editingTrackName, setEditingTrackName] = useState('');
  const [pendingDeleteTrackId, setPendingDeleteTrackId] = useState<string | null>(null);

  const maxTime = Math.max(project.duration + 5, 10);
  const rulerTicks = Array.from({ length: Math.ceil(maxTime) + 1 }, (_, i) => i)
    .filter((i) => i % (px < 60 ? 5 : px < 100 ? 2 : 1) === 0);
  // Timeline coordinates always originate at the ruler/canvas edge, not at the
  // scroll container edge.  Subtracting the label column fixes the old ~108px
  // seek offset and keeps seeking correct after horizontal scrolling.
  const timeFromClientX = (clientX: number) => {
    const box = timelineRef.current?.getBoundingClientRect();
    if (!box) return 0;
    return clamp((clientX - box.left + (timelineRef.current?.scrollLeft ?? 0) - TIMELINE_LABEL_WIDTH) / px, 0, project.duration);
  };
  const seekFromEvent = (event: React.MouseEvent<HTMLElement>, clearSelection = true) => {
    setCurrentTime(timeFromClientX(event.clientX));
    if (clearSelection) setSelected(null, null);
  };
  const seekFromPointer = (event: React.PointerEvent) => setCurrentTime(timeFromClientX(event.clientX));

  const onPointerMove = (event: React.PointerEvent) => {
    if (!drag) return;
    if (drag.kind === 'playhead') {
      seekFromPointer(event);
      return;
    }
    if (drag.kind === 'marker') {
      const at = Math.round(timeFromClientX(event.clientX) * project.canvas.fps) / project.canvas.fps;
      mutateProject((draft) => {
        const marker = draft.markers.find((item) => item.id === drag.markerId);
        if (marker) marker.time = clamp(at, 0, project.duration);
      });
      return;
    }
    const delta = (event.clientX - drag.startX) / px;
    mutateProject((draft) => {
      const track = draft.tracks.find((item) => item.id === drag.trackId);
      const clip = track?.clips.find((item) => item.id === drag.clipId);
      if (clip && !track?.locked) {
        clip.start = Math.max(0, Math.round((drag.start + delta) * project.canvas.fps) / project.canvas.fps);
        draft.duration = projectDuration(draft);
      }
    });
  };

  const splitSelected = () => {
    if (!selectedClipId) return;
    const at = currentTime;
    mutateProject((draft) => { splitClipAt(draft, selectedClipId, at); });
  };

  const addMarker = () => mutateProject((draft) => {
    const time = Math.round(currentTime * project.canvas.fps) / project.canvas.fps;
    if (draft.markers.some((marker) => Math.abs(marker.time - time) < 1 / project.canvas.fps)) return;
    draft.markers.push({ id: `marker_${crypto.randomUUID().slice(0, 8)}`, time, label: `Marker ${draft.markers.length + 1}` });
  });

  const addTrack = (type: Track['type']) => {
    mutateProject((draft) => {
      const index = draft.tracks.length;
      const names: Record<Track['type'], string> = { layer: 'Layer', video: 'Video', overlay: 'Overlay', audio: 'Audio', text: 'Text', subtitle: 'Subtitle' };
      draft.tracks.push({ id: `track-${type}-${crypto.randomUUID().slice(0, 8)}`, type, name: `${names[type]} ${index + 1}`, order: index, clips: [], locked: false, hidden: false, muted: false, volume: 1 });
    });
    setTrackTypeMenuOpen(false);
  };
  const toggleTrack = (trackId: string, field: 'hidden' | 'muted' | 'locked') => mutateProject((draft) => { const track = draft.tracks.find((item) => item.id === trackId); if (track) track[field] = !track[field]; });
  const renameTrack = (track: Track) => {
    setEditingTrackId(track.id);
    setEditingTrackName(track.name);
    setTrackMenuId(null);
  };
  const commitTrackRename = (trackId: string) => {
    const name = editingTrackName.trim();
    if (name) mutateProject((draft) => { const item = draft.tracks.find((entry) => entry.id === trackId); if (item) item.name = name; });
    setEditingTrackId(null);
  };
  const duplicateTrack = (track: Track) => {
    mutateProject((draft) => {
      const index = draft.tracks.findIndex((item) => item.id === track.id);
      if (index < 0) return;
      const copy: Track = { ...track, id: `track-${crypto.randomUUID().slice(0, 8)}`, name: `${track.name} kopya`, order: index + 1, clips: track.clips.map((clip) => ({ ...clip, id: `clip_${crypto.randomUUID().slice(0, 8)}` })) };
      draft.tracks.splice(index + 1, 0, copy);
      draft.tracks.forEach((item, i) => { item.order = i; });
    });
    setTrackMenuId(null);
  };
  const moveTrack = (track: Track, direction: -1 | 1) => {
    mutateProject((draft) => {
      const index = draft.tracks.findIndex((item) => item.id === track.id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= draft.tracks.length) return;
      [draft.tracks[index], draft.tracks[target]] = [draft.tracks[target], draft.tracks[index]];
      draft.tracks.forEach((item, i) => { item.order = i; });
    });
    setTrackMenuId(null);
  };
  const deleteTrack = (track: Track) => {
    setPendingDeleteTrackId(track.id);
    setTrackMenuId(null);
  };
  const confirmDeleteTrack = () => {
    const trackId = pendingDeleteTrackId;
    if (!trackId) return;
    mutateProject((draft) => { draft.tracks = draft.tracks.filter((item) => item.id !== trackId); draft.tracks.forEach((item, i) => { item.order = i; }); draft.duration = projectDuration(draft); });
    setPendingDeleteTrackId(null);
    setSelected(null, null);
  };
  const markerPointerDown = (event: React.PointerEvent<HTMLButtonElement>, marker: { id: string; time: number }) => {
    event.stopPropagation();
    setCurrentTime(marker.time);
    setDrag({ kind: 'marker', markerId: marker.id, startX: event.clientX, start: marker.time });
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const pendingDeleteTrack = project.tracks.find((track) => track.id === pendingDeleteTrackId);

  return (
    <section className="timeline">
      <div className="timeline-toolbar">
        <div className="timeline-toolbar-left">
          <button className="timeline-tool active" title="Seçim" onClick={() => setSelected(null, null)}>↖</button>
          <button className="timeline-tool" title="Böl" onClick={splitSelected}>✂</button>
          <button className="timeline-tool" title="Marker ekle" onClick={addMarker}>⊙</button>
          <div className="toolbar-rule" />
          <div className="track-menu-wrap">
            <button className="track-add-button" onClick={() => setTrackTypeMenuOpen((open) => !open)}>＋ Track</button>
            {trackTypeMenuOpen && <div className="floating-menu track-type-menu" onClick={(event) => event.stopPropagation()}>
              <button onClick={() => addTrack('video')}>▧ Video</button>
              <button onClick={() => addTrack('overlay')}>◈ Overlay</button>
              <button onClick={() => addTrack('audio')}>♫ Audio</button>
              <button onClick={() => addTrack('text')}>T Text</button>
            </div>}
          </div>
        </div>
        <div className="timeline-toolbar-right">
          <button className="timeline-tool" title="Marker ekle" onClick={addMarker}>⌁</button>
          <span className="zoom-label">{Math.round(px)} px/s</span>
          <input aria-label="Timeline zoom" type="range" min="38" max="260" value={px} onChange={(event) => setZoom(Number(event.target.value))} />
        </div>
        {pendingDeleteTrack && <div className="track-confirm" role="status"><span>“{pendingDeleteTrack.name}” silinsin mi?</span><button className="confirm" onClick={confirmDeleteTrack}>Sil</button><button onClick={() => setPendingDeleteTrackId(null)}>Vazgeç</button></div>}
      </div>
      <div className="timeline-scroll" ref={timelineRef} onPointerMove={onPointerMove} onPointerUp={() => setDrag(null)} onPointerCancel={() => setDrag(null)}>
        <div className="timeline-head">
          <div className="track-label-spacer" />
          <div className="ruler" onClick={(event) => seekFromEvent(event)}>
            {rulerTicks.map((tick) => <div key={tick} className="ruler-tick" style={{ left: tick * px }}><span>{formatTime(tick).slice(3)}</span></div>)}
            {project.markers.map((marker) => <button key={marker.id} className="timeline-marker" title={`${marker.label} · ${formatTime(marker.time, true, project.canvas.fps)}`} style={{ left: marker.time * px }} onClick={(event) => { event.stopPropagation(); setCurrentTime(marker.time); setSelected(null, null); }} onPointerDown={(event) => markerPointerDown(event, marker)}><i /><span>{marker.label}</span></button>)}
          </div>
        </div>
        <div className="timeline-content">
          <div className="track-labels">
            {project.tracks.map((track, trackIndex) => <div className={`track-label ${track.hidden ? 'is-hidden' : ''} ${track.muted ? 'is-muted' : ''}`} key={track.id}>
              <span className="track-type">{trackIcon(track.type)}</span>
              {editingTrackId === track.id ? <input className="track-name-input" value={editingTrackName} autoFocus aria-label="Track adı" onChange={(event) => setEditingTrackName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') commitTrackRename(track.id); if (event.key === 'Escape') setEditingTrackId(null); }} onBlur={() => commitTrackRename(track.id)} /> : <span>{track.name}</span>}
              <div className="track-actions">
                <button className={track.hidden ? 'active' : ''} title="Gizle/göster" onClick={() => toggleTrack(track.id, 'hidden')}>◉</button>
                <button className={track.muted ? 'active' : ''} title="Sessize al" onClick={() => toggleTrack(track.id, 'muted')}>♫</button>
                <button className={track.locked ? 'active' : ''} title="Kilitle" onClick={() => toggleTrack(track.id, 'locked')}>♙</button>
                <div className="track-menu-wrap">
                  <button title="Track seçenekleri" onClick={() => setTrackMenuId((id) => id === track.id ? null : track.id)}>•••</button>
                  {trackMenuId === track.id && <div className="floating-menu track-menu" onClick={(event) => event.stopPropagation()}>
                    <button onClick={() => moveTrack(track, -1)} disabled={trackIndex === 0}>↑ Yukarı</button>
                    <button onClick={() => moveTrack(track, 1)} disabled={trackIndex === project.tracks.length - 1}>↓ Aşağı</button>
                    <button onClick={() => renameTrack(track)}>✎ Yeniden adlandır</button>
                    <button onClick={() => duplicateTrack(track)}>⧉ Çoğalt</button>
                    <button onClick={() => deleteTrack(track)}>× Sil</button>
                  </div>}
                </div>
              </div>
            </div>)}
          </div>
          <div className="tracks-canvas" onClick={(event) => seekFromEvent(event)}>
            <div className="playhead" style={{ left: currentTime * px }} onPointerDown={(event) => { event.stopPropagation(); setDrag({ kind: 'playhead', startX: event.clientX }); event.currentTarget.setPointerCapture(event.pointerId); }}><div className="playhead-cap" /></div>
            {project.tracks.map((track) => <div className={`track-row ${track.locked ? 'locked' : ''} ${track.hidden ? 'is-hidden' : ''}`} key={track.id}>{track.clips.map((clip) => <TimelineClip key={clip.id} clip={clip} selected={selectedClipId === clip.id} px={px} disabled={track.locked} onSelect={() => setSelected(clip.id, track.id)} onPointerDown={(event) => { event.stopPropagation(); if (track.locked) return; setSelected(clip.id, track.id); setDrag({ kind: 'clip', clipId: clip.id, trackId: track.id, startX: event.clientX, start: clip.start }); event.currentTarget.setPointerCapture(event.pointerId); }} />)}</div>)}
          </div>
        </div>
      </div>
    </section>
  );

  return <section className="timeline"><div className="timeline-toolbar"><div className="timeline-toolbar-left"><button className="timeline-tool active" title="Seçim" onClick={() => setSelected(null, null)}>↖</button><button className="timeline-tool" title="Böl" onClick={splitSelected}>✂</button><button className="timeline-tool" title="Marker ekle" onClick={addMarker}>⊙</button><div className="toolbar-rule" /><div className="track-menu-wrap"><button className="track-add-button" onClick={() => setTrackTypeMenuOpen((open) => !open)}>＋ Track</button>{trackTypeMenuOpen && <div className="floating-menu track-type-menu" onClick={(event) => event.stopPropagation()}><button onClick={() => addTrack('video')}>▧ Video</button><button onClick={() => addTrack('overlay')}>◈ Overlay</button><button onClick={() => addTrack('audio')}>♫ Audio</button><button onClick={() => addTrack('text')}>T Text</button><button onClick={() => addTrack('subtitle')}>≡ Subtitle</button></div>}</div></div><div className="timeline-toolbar-right"><button className="timeline-tool" title="Marker ekle" onClick={addMarker}>⌁</button><span className="zoom-label">{Math.round(px)} px/s</span><input aria-label="Timeline zoom" type="range" min="38" max="260" value={px} onChange={(event) => setZoom(Number(event.target.value))} /></div></div><div className="timeline-scroll" ref={timelineRef} onPointerMove={onPointerMove} onPointerUp={() => setDrag(null)} onPointerCancel={() => setDrag(null)}><div className="timeline-head"><div className="track-label-spacer" /><div className="ruler" onClick={(event) => seekFromEvent(event)}>{rulerTicks.map((tick) => <div key={tick} className="ruler-tick" style={{ left: tick * px }}><span>{formatTime(tick).slice(3)}</span></div>)}{project.markers.map((marker) => <button key={marker.id} className="timeline-marker" title={`${marker.label} · ${formatTime(marker.time, true, project.canvas.fps)}`} style={{ left: marker.time * px }} onClick={(event) => { event.stopPropagation(); setCurrentTime(marker.time); setSelected(null, null); }} onPointerDown={(event) => markerPointerDown(event, marker)}><i /> <span>{marker.label}</span></button>)}</div></div><div className="timeline-content"><div className="track-labels">{project.tracks.map((track, trackIndex) => <div className={`track-label ${track.hidden ? 'is-hidden' : ''} ${track.muted ? 'is-muted' : ''}`} key={track.id}><span className="track-type">{track.type === 'video' ? '▧' : track.type === 'audio' ? '♫' : track.type === 'text' ? 'T' : track.type === 'subtitle' ? '≡' : '◈'}</span><span>{track.name}</span><div className="track-actions"><button className={track.hidden ? 'active' : ''} title="Gizle/göster" onClick={() => toggleTrack(track.id, 'hidden')}>◉</button><button className={track.muted ? 'active' : ''} title="Sessize al" onClick={() => toggleTrack(track.id, 'muted')}>♫</button><button className={track.locked ? 'active' : ''} title="Kilitle" onClick={() => toggleTrack(track.id, 'locked')}>♙</button><div className="track-menu-wrap"><button title="Track seçenekleri" onClick={() => setTrackMenuId((id) => id === track.id ? null : track.id)}>•••</button>{trackMenuId === track.id && <div className="floating-menu track-menu" onClick={(event) => event.stopPropagation()}><button onClick={() => moveTrack(track, -1)} disabled={trackIndex === 0}>↑ Yukarı</button><button onClick={() => moveTrack(track, 1)} disabled={trackIndex === project.tracks.length - 1}>↓ Aşağı</button><button onClick={() => renameTrack(track)}>✎ Yeniden adlandır</button><button onClick={() => duplicateTrack(track)}>⧉ Çoğalt</button><button onClick={() => deleteTrack(track)}>× Sil</button></div>}</div></div></div>)}</div><div className="tracks-canvas" onClick={(event) => seekFromEvent(event)}><div className="playhead" style={{ left: currentTime * px }} onPointerDown={(event) => { event.stopPropagation(); setDrag({ kind: 'playhead', startX: event.clientX }); event.currentTarget.setPointerCapture(event.pointerId); }}><div className="playhead-cap" /></div>{project.tracks.map((track) => <div className={`track-row ${track.locked ? 'locked' : ''} ${track.hidden ? 'is-hidden' : ''}`} key={track.id}>{track.clips.map((clip) => <TimelineClip key={clip.id} clip={clip} selected={selectedClipId === clip.id} px={px} disabled={track.locked} onSelect={() => setSelected(clip.id, track.id)} onPointerDown={(event) => { event.stopPropagation(); if (track.locked) return; setSelected(clip.id, track.id); setDrag({ kind: 'clip', clipId: clip.id, trackId: track.id, startX: event.clientX, start: clip.start }); event.currentTarget.setPointerCapture(event.pointerId); }} />)}</div>)}</div></div></div></section>;
}

type ProTimelineDrag =
  | { kind: 'clip'; clipId: string; trackId: string; startX: number; start: number; selectedClipIds: string[]; selectedClipStarts: Record<string, number>; historyGroup?: string }
  | { kind: 'trimLeft' | 'trimRight'; clipId: string; trackId: string; startX: number; start: number; duration: number; clipSnapshot: Clip; historyGroup: string }
  | { kind: 'playhead' }
  | { kind: 'marker'; markerId: string; historyGroup?: string };

type ClipStyleSnapshot = Pick<Clip, 'transform' | 'filters' | 'transitionIn' | 'transitionOut' | 'volume' | 'fadeIn' | 'fadeOut' | 'normalize' | 'mask' | 'crop' | 'keyframes' | 'textStyle'>;
let clipStyleClipboard: { sourceType: Clip['type']; style: ClipStyleSnapshot } | null = null;

function copyClipStyle(clip: Clip) {
  const { transform, filters, transitionIn, transitionOut, volume, fadeIn, fadeOut, normalize, mask, crop, keyframes, textStyle } = clip;
  clipStyleClipboard = structuredClone({ sourceType: clip.type, style: { transform, filters, transitionIn, transitionOut, volume, fadeIn, fadeOut, normalize, mask, crop, keyframes, textStyle } });
}

function TimelinePro({ project }: { project: Project }) {
  const { t } = useI18n();
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
  const [menu, setMenu] = useState<{ x: number; y: number; kind: 'clip' | 'track' | 'marker' | 'add-track' | 'empty'; clipId?: string; trackId?: string; markerId?: string; time?: number } | null>(null);
  const [editingTrackId, setEditingTrackId] = useState<string | null>(null);
  const [editingTrackName, setEditingTrackName] = useState('');
  const [snapEnabled, setSnapEnabled] = useState(true);
  const closeMenu = () => setMenu(null);
  const newHistoryGroup = () => `timeline-${crypto.randomUUID()}`;
  useEffect(() => {
    const clearAssetDrag = () => { setAssetDragId(null); setDrop(null); dragHistoryGroupRef.current = null; };
    window.addEventListener('pointerup', clearAssetDrag);
    window.addEventListener('pointercancel', clearAssetDrag);
    return () => { window.removeEventListener('pointerup', clearAssetDrag); window.removeEventListener('pointercancel', clearAssetDrag); };
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
          setDrag({ kind: trimHandle.classList.contains('left') ? 'trimLeft' : 'trimRight', clipId: clip.id, trackId: track.id, startX: event.clientX, start: clip.start, duration: clip.duration, clipSnapshot: structuredClone(clip), historyGroup });
          root.setPointerCapture(event.pointerId);
          return;
        }
      }
      if (target.closest('.timeline-clip') || target.closest('.playhead')) return;
      const at = quantizeFrameTime(timeFromClientX(event.clientX), project.canvas.fps, project.duration);
      const button = target.closest<HTMLElement>('.timeline-marker');
      const nearestFromDom = button ? Number.parseFloat(button.style.left) / px : Number.POSITIVE_INFINITY;
      const nearest = button ? project.markers.reduce<{ id: string; time: number } | null>((best, marker) => {
        const distance = button ? Math.abs(marker.time - nearestFromDom) : Math.abs(marker.time - at);
        return !best || distance < Math.abs(best.time - (button ? nearestFromDom : at)) ? marker : best;
      }, null) : null;
      event.preventDefault();
      event.stopPropagation();
      if (nearest) {
        const historyGroup = newHistoryGroup();
        dragHistoryGroupRef.current = historyGroup;
        mutateProject((draft) => {
          const marker = draft.markers.find((item) => item.id === nearest.id);
          if (marker) marker.time = clamp(at, 0, project.duration);
        }, { historyGroup });
        setCurrentTime(at);
        setDrag({ kind: 'marker', markerId: nearest.id, historyGroup });
      } else {
        setCurrentTime(at);
        setSelected(null, null);
        setDrag({ kind: 'playhead' });
      }
      root.setPointerCapture(event.pointerId);
    };
    root.addEventListener('pointerdown', handlePointerDown, true);
    return () => root.removeEventListener('pointerdown', handlePointerDown, true);
  }, [assetDragId, currentTime, mutateProject, project, px, setCurrentTime, setSelected, snapEnabled]);
  const maxTime = Math.max(project.duration + 5, 10);
  const rulerTicks = Array.from({ length: Math.ceil(maxTime) + 1 }, (_, index) => index).filter((tick) => tick % (px < 60 ? 5 : px < 100 ? 2 : 1) === 0);
  const timeFromClientX = (clientX: number) => { const box = timelineRef.current?.getBoundingClientRect(); if (!box) return 0; return clamp((clientX - box.left + (timelineRef.current?.scrollLeft ?? 0) - TIMELINE_LABEL_WIDTH) / px, 0, project.duration); };
  const trackIdAtClientY = (clientY: number) => {
    const rows = Array.from(timelineRef.current?.querySelectorAll<HTMLElement>('[data-track-id]') ?? []);
    return rows.find((row) => { const box = row.getBoundingClientRect(); return clientY >= box.top && clientY <= box.bottom; })?.dataset.trackId ?? null;
  };
  const frameTime = (value: number) => quantizeFrameTime(value, project.canvas.fps, project.duration);
  const snapTime = (value: number) => snapProjectTime(project, value, { enabled: snapEnabled, currentTime });
  const addMarker = () => {
    const at = frameTime(currentTime);
    if (project.markers.some((marker) => Math.abs(marker.time - at) < 1 / Math.max(1, project.canvas.fps) / 2)) {
      setNotice(t('timeline.markerExists'));
      return;
    }
    mutateProject((draft) => { draft.markers.push({ id: `marker_${crypto.randomUUID().slice(0, 8)}`, time: at, label: t('timeline.markerDefault', { count: draft.markers.length + 1 }) }); });
  };
  const seek = (event: React.MouseEvent<HTMLElement>) => { setCurrentTime(frameTime(timeFromClientX(event.clientX))); setSelected(null, null); };
  const beginTimelinePointer = (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || assetDragId) return;
    event.preventDefault();
    const at = frameTime(timeFromClientX(event.clientX));
    const nearest = project.markers.reduce<{ id: string; time: number } | null>((best, marker) => !best || Math.abs(marker.time - at) < Math.abs(best.time - at) ? marker : best, null);
    if (nearest) {
      const historyGroup = newHistoryGroup();
      dragHistoryGroupRef.current = historyGroup;
      mutateProject((draft) => {
        const marker = draft.markers.find((item) => item.id === nearest.id);
        if (marker) marker.time = clamp(at, 0, project.duration);
      }, { historyGroup });
      setCurrentTime(at);
      setDrag({ kind: 'marker', markerId: nearest.id, historyGroup });
    } else {
      setCurrentTime(at);
      setSelected(null, null);
      setDrag({ kind: 'playhead' });
    }
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const markerPointerDown = (event: React.PointerEvent<HTMLButtonElement>, marker: { id: string; time: number }) => {
    event.preventDefault();
    event.stopPropagation();
    const at = frameTime(timeFromClientX(event.clientX));
    const historyGroup = newHistoryGroup();
    dragHistoryGroupRef.current = historyGroup;
    mutateProject((draft) => {
      const target = draft.markers.find((item) => item.id === marker.id);
      if (target) target.time = clamp(at, 0, project.duration);
    }, { historyGroup });
    setCurrentTime(at);
    setDrag({ kind: 'marker', markerId: marker.id, historyGroup });
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent) => {
    if (assetDragId) {
      const row = (event.target as HTMLElement).closest<HTMLElement>('[data-track-id]');
      const targetTrack = row ? project.tracks.find((item) => item.id === row.dataset.trackId) : undefined;
      const asset = project.assets.find((item) => item.id === assetDragId);
      if (targetTrack && asset && !targetTrack.locked) {
        setDrop({ trackId: targetTrack.id, time: snapTime(timeFromClientX(event.clientX)) });
      } else {
        setDrop(null);
      }
    }
    if (!drag) return;
    if (drag.kind === 'playhead') { setCurrentTime(frameTime(timeFromClientX(event.clientX))); return; }
    if (drag.kind === 'marker') { const at = frameTime(timeFromClientX(event.clientX)); mutateProject((draft) => { const marker = draft.markers.find((item) => item.id === drag.markerId); if (marker) marker.time = at; }, { historyGroup: drag.historyGroup }); setCurrentTime(at); return; }
    if (drag.kind === 'trimLeft' || drag.kind === 'trimRight') {
      const delta = (event.clientX - drag.startX) / px;
      const frame = 1 / project.canvas.fps;
      mutateProject((draft) => {
        const nextStart = drag.kind === 'trimLeft'
          ? clamp(Math.round((drag.start + delta) / frame) * frame, 0, drag.start + drag.duration - frame)
          : drag.start;
        const nextEnd = drag.kind === 'trimRight'
          ? clamp(Math.round((drag.start + drag.duration + delta) / frame) * frame, drag.start + frame, drag.start + drag.duration)
          : drag.start + drag.duration;
        trimClip(draft, drag.clipId, nextStart, nextEnd, drag.clipSnapshot);
      }, { historyGroup: drag.historyGroup });
      return;
    }
    const targetTrackId = trackIdAtClientY(event.clientY);
    const historyGroup = drag.kind === 'clip' ? (drag.historyGroup ?? dragHistoryGroupRef.current ?? (dragHistoryGroupRef.current = newHistoryGroup())) : drag.historyGroup;
    if (drag.kind === 'clip' && targetTrackId && targetTrackId !== drag.trackId) {
      const destination = project.tracks.find((track) => track.id === targetTrackId);
      if (destination && !destination.locked) {
        const selected = new Set(drag.selectedClipIds);
        mutateProject((draft) => {
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
        }, { historyGroup });
        setDrag((current) => current?.kind === 'clip' ? { ...current, trackId: targetTrackId, historyGroup } : current);
        setSelected(drag.clipId, targetTrackId);
        return;
      }
    }
    const delta = (event.clientX - drag.startX) / px;
    mutateProject((draft) => {
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
    }, { historyGroup });
  };
  const fitTimeline = () => {
    const width = timelineRef.current?.clientWidth ?? 900;
    const available = Math.max(280, width - TIMELINE_LABEL_WIDTH - 24);
    const duration = Math.max(1, project.duration);
    setZoom(clamp(available / duration, 38, 260));
    timelineRef.current?.scrollTo({ left: 0, behavior: 'smooth' });
  };
  const addTrack = () => { mutateProject((draft) => { createLayerTrack(draft); }); closeMenu(); };
  const updateTrack = (trackId: string, field: 'hidden' | 'muted' | 'locked') => mutateProject((draft) => { const track = draft.tracks.find((item) => item.id === trackId); if (track) track[field] = !track[field]; });
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
  const duplicateTrack = (trackId: string) => { mutateProject((draft) => { const index = draft.tracks.findIndex((item) => item.id === trackId); if (index < 0) return; const source = draft.tracks[index]; const copy = { ...source, id: `track-${crypto.randomUUID().slice(0, 8)}`, name: t('timeline.copySuffix', { name: source.name }), order: index + 1, clips: source.clips.map((clip) => ({ ...clip, id: `clip_${crypto.randomUUID().slice(0, 8)}` })) }; draft.tracks.splice(index + 1, 0, copy); draft.tracks.forEach((track, order) => { track.order = order; }); }); closeMenu(); };
  const moveTrack = (trackId: string, direction: -1 | 1) => { mutateProject((draft) => { const index = draft.tracks.findIndex((item) => item.id === trackId); const target = index + direction; if (index < 0 || target < 0 || target >= draft.tracks.length) return; [draft.tracks[index], draft.tracks[target]] = [draft.tracks[target], draft.tracks[index]]; draft.tracks.forEach((track, order) => { track.order = order; }); }); closeMenu(); };
  const deleteTrack = (trackId: string) => { mutateProject((draft) => { draft.tracks = draft.tracks.filter((track) => track.id !== trackId); draft.tracks.forEach((track, order) => { track.order = order; }); draft.duration = projectDuration(draft); }); setSelected(null, null); closeMenu(); };
  const deleteClip = (clipId: string, ripple = false) => { mutateProject((draft) => { if (ripple) rippleDeleteAcrossTimeline(draft, clipId); else { const track = draft.tracks.find((item) => item.clips.some((clip) => clip.id === clipId)); const clip = track?.clips.find((item) => item.id === clipId); if (track && clip && !track.locked) { track.clips = track.clips.filter((item) => item.id !== clipId); draft.duration = projectDuration(draft); } } }); setSelected(null, null); closeMenu(); };
  const duplicateClip = (clipId: string) => { mutateProject((draft) => { const track = draft.tracks.find((item) => item.clips.some((clip) => clip.id === clipId)); const clip = track?.clips.find((item) => item.id === clipId); if (track && clip) track.clips.push({ ...clip, id: `clip_${crypto.randomUUID().slice(0, 8)}`, start: clip.start + clip.duration }); draft.duration = projectDuration(draft); }); closeMenu(); };
  const splitClip = (clipId: string) => { mutateProject((draft) => { splitClipAt(draft, clipId, currentTime); }); closeMenu(); };
  const trimSelectedClipToPlayhead = (clipId: string, edge: 'start' | 'end') => { mutateProject((draft) => { trimClipToPlayhead(draft, clipId, currentTime, edge); }); closeMenu(); };
  const resetClip = (clipId: string, section: 'transform' | 'filters') => { mutateProject((draft) => { const clip = draft.tracks.flatMap((item) => item.clips).find((item) => item.id === clipId); if (!clip) return; if (section === 'transform') clip.transform = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, fit: 'contain', flipX: false, flipY: false }; else clip.filters = { brightness: 0, contrast: 0, saturation: 0, blur: 0, grayscale: 0 }; }); closeMenu(); };
  const addLayerRelative = (trackId: string, offset: -1 | 1) => { mutateProject((draft) => { const index = draft.tracks.findIndex((item) => item.id === trackId); if (index < 0) return; const destination = createLayerTrack(draft); const [layer] = draft.tracks.splice(draft.tracks.length - 1, 1); draft.tracks.splice(Math.max(0, Math.min(draft.tracks.length, index + (offset < 0 ? 0 : 1))), 0, layer); draft.tracks.forEach((item, order) => { item.order = order; }); }); closeMenu(); };
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
    } catch { setNotice(t('timeline.dragError')); }
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
    if (!clipStyleClipboard) { setNotice(t('timeline.noStyle')); return; }
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
  const menuItems: ContextMenuItem[] = menu?.kind === 'add-track' ? [{ label: t('timeline.menu.newLayer'), icon: '◫', shortcut: 'Ctrl+Shift+L', onSelect: addTrack }, { label: t('timeline.menu.addAdjustment'), icon: '✦', onSelect: addAdjustmentLayer }] : menu?.kind === 'empty' ? [{ label: t('timeline.menu.newLayerHere'), icon: '◫', shortcut: 'Ctrl+Shift+L', onSelect: () => { if (menu.time !== undefined) setCurrentTime(menu.time); addTrack(); } }, { label: t('timeline.menu.addAdjustmentHere'), icon: '✦', onSelect: () => { if (menu.time !== undefined) setCurrentTime(menu.time); addAdjustmentLayer(); } }, { label: t('timeline.menu.movePlayheadHere'), icon: '⌖', onSelect: () => { if (menu.time !== undefined) setCurrentTime(menu.time); closeMenu(); } }] : menu?.kind === 'clip' && clip ? [
    { label: t('timeline.menu.openProperties'), icon: '⚙', shortcut: 'Enter', onSelect: () => { setSelected(clip.id, menu.trackId ?? null); closeMenu(); } },
    { label: t('timeline.menu.splitAtPlayhead'), icon: '✂', shortcut: 'B', disabled: currentTime <= clip.start || currentTime >= clip.start + clip.duration, onSelect: () => splitClip(clip.id) },
    { label: t('timeline.menu.trimStart'), icon: '◁', disabled: currentTime <= clip.start || currentTime >= clip.start + clip.duration, onSelect: () => trimSelectedClipToPlayhead(clip.id, 'start') },
    { label: t('timeline.menu.trimEnd'), icon: '▷', disabled: currentTime <= clip.start || currentTime >= clip.start + clip.duration, onSelect: () => trimSelectedClipToPlayhead(clip.id, 'end') },
    { label: t('timeline.menu.duplicate'), icon: '⧉', onSelect: () => duplicateClip(clip.id) },
    { label: t('timeline.copyStyle'), icon: '◫', onSelect: () => { copyClipStyle(clip); setNotice(t('timeline.styleCopied')); } },
    { label: t('timeline.pasteStyle'), icon: '◧', disabled: !clipStyleClipboard, onSelect: () => pasteClipStyle(clip) },
    { label: t('timeline.menu.copyClipData'), icon: '⧉', onSelect: () => { void navigator.clipboard?.writeText(JSON.stringify(clip, null, 2)); closeMenu(); } },
    { label: t('timeline.menu.resetTransform'), icon: '⌗', onSelect: () => resetClip(clip.id, 'transform') },
    { label: t('timeline.menu.resetEffects'), icon: '✦', onSelect: () => resetClip(clip.id, 'filters') },
    { label: t(clip.volume === 0 ? 'timeline.menu.unmute' : 'timeline.menu.mute'), icon: '♫', onSelect: () => mutateProject((draft) => { const target = draft.tracks.flatMap((item) => item.clips).find((item) => item.id === clip.id); if (target) target.volume = target.volume === 0 ? 1 : 0; }) },
    { label: t('timeline.menu.delete'), icon: '×', danger: true, shortcut: 'Del', onSelect: () => deleteClip(clip.id) },
    { label: t('timeline.menu.rippleDelete'), icon: '↔', danger: true, onSelect: () => deleteClip(clip.id, true) },
    { label: t('timeline.menu.showInMedia'), icon: '▧', onSelect: () => { setPanel('media'); closeMenu(); } },
  ] : menu?.kind === 'track' && track ? [
    { label: t('timeline.menu.moveUp'), icon: '↑', onSelect: () => moveTrack(track.id, -1) },
    { label: t('timeline.menu.moveDown'), icon: '↓', onSelect: () => moveTrack(track.id, 1) },
    { label: t('timeline.menu.addAbove'), icon: '＋', onSelect: () => addLayerRelative(track.id, -1) },
    { label: t('timeline.menu.addBelow'), icon: '＋', onSelect: () => addLayerRelative(track.id, 1) },
    { label: t('timeline.menu.rename'), icon: '✎', onSelect: () => { setEditingTrackId(track.id); setEditingTrackName(track.name); closeMenu(); } },
    { label: t('timeline.menu.duplicate'), icon: '⧉', onSelect: () => duplicateTrack(track.id) },
    { label: t(track.locked ? 'timeline.menu.unlock' : 'timeline.menu.lock'), icon: '♙', onSelect: () => updateTrack(track.id, 'locked') },
    { label: t(track.muted ? 'timeline.menu.unmute' : 'timeline.menu.silence'), icon: '♫', onSelect: () => updateTrack(track.id, 'muted') },
    { label: t(track.hidden ? 'timeline.menu.show' : 'timeline.menu.hide'), icon: '◉', onSelect: () => updateTrack(track.id, 'hidden') },
    { label: t('timeline.menu.delete'), icon: '×', danger: true, onSelect: () => deleteTrack(track.id) },
  ] : menu?.kind === 'marker' && menu.markerId ? [{ label: t('timeline.menu.renameMarker'), icon: '✎', onSelect: () => { const marker = project.markers.find((item) => item.id === menu.markerId); const next = window.prompt(t('timeline.markerNamePrompt'), marker?.label ?? t('timeline.markerFallback')); if (next?.trim()) mutateProject((draft) => { const target = draft.markers.find((item) => item.id === menu.markerId); if (target) target.label = next.trim(); }); closeMenu(); } }, { label: t('timeline.menu.deleteMarker'), icon: '×', danger: true, onSelect: () => { mutateProject((draft) => { draft.markers = draft.markers.filter((item) => item.id !== menu.markerId); }); closeMenu(); } }] : [];
  // The active implementation below supersedes the removed legacy timeline prototype.
  return <section className="timeline timeline-pro" onContextMenu={(event) => { event.preventDefault(); const target = event.target as HTMLElement; if (target.closest('.timeline-clip,.track-label,.timeline-marker,.context-menu')) return; setMenu({ x: event.clientX, y: event.clientY, kind: 'empty', time: snapTime(timeFromClientX(event.clientX)) }); }}>
    <div className="timeline-toolbar">
      <div className="timeline-toolbar-left">
        <button className="timeline-tool active" title={t('timeline.selection')} onClick={() => setSelected(null, null)}>↖</button>
        <button className="timeline-tool" title={canSplit ? t('timeline.split') : t('timeline.splitHint')} aria-label={t('timeline.split')} disabled={!canSplit} onClick={() => selectedClipId && splitClip(selectedClipId)}>✂</button>
        <button className="timeline-tool" title={t('common.undo')} aria-label={t('common.undo')} disabled={!canUndo} onClick={undo}>↶</button>
        <button className="timeline-tool" title={t('common.redo')} aria-label={t('common.redo')} disabled={!canRedo} onClick={redo}>↷</button>
        <button className={`timeline-tool snap-toggle ${snapEnabled ? 'active' : ''}`} title={t(snapEnabled ? 'timeline.snapOn' : 'timeline.snapOff')} aria-label={t(snapEnabled ? 'timeline.snapOn' : 'timeline.snapOff')} aria-pressed={snapEnabled} onClick={() => setSnapEnabled((value) => !value)}>⌁</button>
        <button className="timeline-tool" title={t('timeline.addMarker')} aria-label={t('timeline.addMarker')} onClick={addMarker}>⊙</button>
        <button className="track-add-button" onClick={(event) => setMenu({ x: event.clientX, y: event.clientY, kind: 'add-track' })}>＋ {t('timeline.addTrack')}</button>
      </div>
      <div className="timeline-toolbar-right"><span className="zoom-label">{Math.round(px)} px/s</span><input aria-label={t('timeline.zoom')} type="range" min="38" max="260" value={px} onChange={(event) => setZoom(Number(event.target.value))} /></div>
    </div>
    <div className="timeline-fit-row"><button className="timeline-fit-button" onClick={fitTimeline}>↔ {t('timeline.fit')}</button><span>{t('timeline.nudgeHint')}</span></div>
    <div className="timeline-scroll" ref={timelineRef} onPointerMove={onPointerMove} onPointerUp={finishPointerAssetDrop} onPointerCancel={() => { setDrag(null); setDrop(null); setAssetDragId(null); }}>
      <div className="timeline-head"><div className="track-label-spacer" /><div className="ruler" onClick={seek}>{rulerTicks.map((tick) => <div key={tick} className="ruler-tick" style={{ left: tick * px }}><span>{formatTime(tick).slice(3)}</span></div>)}{project.markers.map((marker) => <button key={marker.id} className="timeline-marker" style={{ left: marker.time * px }} title={`${marker.label} · ${formatTime(marker.time, true, project.canvas.fps)}`} onClick={(event) => { event.stopPropagation(); setCurrentTime(marker.time); setSelected(null, null); }} onPointerDown={(event) => { event.stopPropagation(); setCurrentTime(marker.time); setDrag({ kind: 'marker', markerId: marker.id }); event.currentTarget.setPointerCapture(event.pointerId); }} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); setMenu({ x: event.clientX, y: event.clientY, kind: 'marker', markerId: marker.id }); }}><i /><span>{marker.label}</span></button>)}</div></div>
      <div className="timeline-content"><div className="track-labels">{project.tracks.map((item) => <div className={`track-label ${item.hidden ? 'is-hidden' : ''} ${item.muted ? 'is-muted' : ''}`} key={item.id} onContextMenu={(event) => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY, kind: 'track', trackId: item.id }); }}>{editingTrackId === item.id ? <input className="track-name-input" autoFocus value={editingTrackName} onChange={(event) => setEditingTrackName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { mutateProject((draft) => { const target = draft.tracks.find((track) => track.id === item.id); if (target && editingTrackName.trim()) target.name = editingTrackName.trim(); }); setEditingTrackId(null); } if (event.key === 'Escape') setEditingTrackId(null); }} onBlur={() => setEditingTrackId(null)} /> : <><span className={`track-type track-type-${item.type}`} aria-hidden="true">{item.type === 'audio' ? 'A' : item.type === 'text' ? 'T' : item.type === 'subtitle' ? 'S' : item.type === 'overlay' ? 'O' : 'V'}</span><span className="track-name" title={item.name}>{item.name}</span></>}<span className="track-status-strip">{item.hidden && <i className="track-status is-hidden" title={t('timeline.menu.hide')} />}{item.muted && <i className="track-status is-muted" title={t('timeline.menu.silence')} />}{item.locked && <i className="track-status is-locked" title={t('timeline.menu.lock')} />}</span><div className="track-actions"><button className="track-menu-button" title={t('timeline.trackOptions')} aria-label={t('timeline.trackOptions')} onClick={(event) => setMenu({ x: event.clientX, y: event.clientY, kind: 'track', trackId: item.id })}><span className="track-menu-dots" aria-hidden="true"><i /><i /><i /></span></button></div></div>)}</div>
        <div className="tracks-canvas" onClick={seek}><div className="playhead" style={{ left: currentTime * px }} onPointerDown={(event) => { event.stopPropagation(); setDrag({ kind: 'playhead' }); event.currentTarget.setPointerCapture(event.pointerId); }}><div className="playhead-cap" /></div>{project.tracks.map((item) => <div data-track-id={item.id} className={`track-row ${item.locked ? 'locked' : ''} ${item.hidden ? 'is-hidden' : ''} ${drop?.trackId === item.id ? 'drop-target' : ''}`} key={item.id} onDragOver={(event) => { if (event.dataTransfer.types.includes('application/x-cutloc-asset')) { event.preventDefault(); setDrop({ trackId: item.id, time: snapTime(timeFromClientX(event.clientX)) }); } }} onDragLeave={() => setDrop((current) => current?.trackId === item.id ? null : current)} onDrop={(event) => dropAsset(event, item)}>{drop?.trackId === item.id && <div className="drop-ghost" title={draggedAsset ? `${draggedAsset.name} · ${formatTime(Math.max(draggedAsset.duration || 5, 0.5))}` : undefined} style={{ left: drop.time * px, width: dropGhostWidth }} />}{item.clips.map((itemClip) => <div key={itemClip.id} className={`timeline-clip clip-${itemClip.type} ${selectedClipIds.includes(itemClip.id) ? 'selected' : ''} ${item.locked ? 'disabled' : ''}`} style={{ left: itemClip.start * px, width: Math.max(36, itemClip.duration * px) }} onClick={(event) => { event.stopPropagation(); if (event.shiftKey || event.ctrlKey || event.metaKey) toggleSelected(itemClip.id, item.id); else if (selectedClipIds.length <= 1 || !selectedClipIds.includes(itemClip.id)) setSelected(itemClip.id, item.id); }} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); setSelected(itemClip.id, item.id); setMenu({ x: event.clientX, y: event.clientY, kind: 'clip', clipId: itemClip.id, trackId: item.id }); }} onPointerDown={(event) => { event.stopPropagation(); if (item.locked) return; if (event.shiftKey || event.ctrlKey || event.metaKey) { return; } if (!selectedClipIds.includes(itemClip.id)) setSelected(itemClip.id, item.id); const selectedIds = selectedClipIds.includes(itemClip.id) ? selectedClipIds : [itemClip.id]; const selectedStarts = Object.fromEntries(project.tracks.flatMap((track) => track.clips).filter((clip) => selectedIds.includes(clip.id)).map((clip) => [clip.id, clip.start])); const historyGroup = newHistoryGroup(); dragHistoryGroupRef.current = historyGroup; setDrag({ kind: 'clip', clipId: itemClip.id, trackId: item.id, startX: event.clientX, start: itemClip.start, selectedClipIds: selectedIds, selectedClipStarts: selectedStarts, historyGroup }); event.currentTarget.setPointerCapture(event.pointerId); }}><div className="clip-handle left" /><div className="clip-body"><span className="clip-icon">{itemClip.type === 'video' ? '▶' : itemClip.type === 'audio' ? '♫' : '▧'}</span><strong>{itemClip.name}</strong><small>{formatTime(itemClip.duration)}</small></div><div className="clip-handle right" /></div>)}</div>)}</div>
      </div>
    </div>
    {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={closeMenu} />}
  </section>;
}

function TimelineClip({ clip, selected, px, disabled, onSelect, onPointerDown }: { clip: Clip; selected: boolean; px: number; disabled?: boolean; onSelect: () => void; onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void }) { return <div className={`timeline-clip clip-${clip.type} ${selected ? 'selected' : ''} ${disabled ? 'disabled' : ''}`} style={{ left: clip.start * px, width: Math.max(36, clip.duration * px) }} onClick={(event) => { event.stopPropagation(); onSelect(); }} onPointerDown={onPointerDown}><div className="clip-handle left" /><div className="clip-body"><span className="clip-icon">{clip.type === 'video' ? '▶' : clip.type === 'audio' ? '♫' : clip.type === 'image' ? '▧' : 'T'}</span><strong>{clip.name}</strong><small>{formatTime(clip.duration)}</small></div><div className="clip-handle right" /></div>; }

function AppWrapper() {
  const language = useEditor((state) => state.settings?.language ?? 'en');
  return <StrictMode><I18nProvider language={language}><App /></I18nProvider></StrictMode>;
}

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('CutLoc root element was not found.');
const root = createRoot(rootElement);
root.render(<AppWrapper />);
const hot = (import.meta as ImportMeta & { hot?: { dispose: (callback: () => void) => void } }).hot;
hot?.dispose(() => root.unmount());
