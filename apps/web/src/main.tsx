import { StrictMode, useEffect, useMemo, useRef, useState } from 'react';
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
  quantizeFrameTime,
  rippleDeleteClip,
  snapTime as snapProjectTime,
  splitClipAt,
  trimClipToPlayhead,
  type ExportOptions,
  type ExportPreflight,
  type ExportJobResult,
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
import { UiLanguageBoundary } from './i18n';

type Theme = 'dark' | 'gray' | 'light';
type Panel = 'media' | 'text' | 'captions' | 'project' | 'transitions' | 'effects' | 'color' | 'animation' | 'help';
type TrashEntry = { trashId: string; projectId: string; name: string; createdAt: string; updatedAt: string; deletedAt: string; duration: number; assetCount: number };
type HistoryState = { past: Project[]; future: Project[] };
type HistoryMutationOptions = { historyGroup?: string };
type ShortcutAction = keyof ShortcutSettings;
type StockMediaItem = { id: string; name: string; description: string; category: 'solid' | 'soft' | 'texture'; mimeType: string; width: number; height: number };

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

const SHORTCUT_LABELS: Record<ShortcutAction, { label: string; description: string }> = {
  togglePlayback: { label: 'Oynat / duraklat', description: 'Preview oynatmayı açıp kapatır' },
  undo: { label: 'Geri al', description: 'Son düzenlemeyi geri alır' },
  redo: { label: 'Yinele', description: 'Geri alınan düzenlemeyi tekrarlar' },
  split: { label: 'Klibi böl', description: 'Seçili klibi playhead noktasında böler' },
  setIn: { label: 'In noktası', description: 'Export başlangıcını belirler' },
  setOut: { label: 'Out noktası', description: 'Export bitişini belirler' },
  clearRange: { label: 'In/Out temizle', description: 'Seçili export aralığını kaldırır' },
  deleteClip: { label: 'Klibi sil', description: 'Seçili klibi timeline’dan kaldırır' },
  duplicate: { label: 'Klibi çoğalt', description: 'Seçili kliplerin kopyasını oluşturur' },
  selectAll: { label: 'Tüm klipleri seç', description: 'Kilitsiz track kliplerini seçer' },
};

const STOCK_MEDIA: StockMediaItem[] = [
  { id: 'white', name: 'Beyaz yüzey', description: 'Temiz ve aydınlık', category: 'solid', mimeType: 'image/png', width: 1600, height: 900 },
  { id: 'black', name: 'Siyah yüzey', description: 'Sade ve sinematik', category: 'solid', mimeType: 'image/png', width: 1600, height: 900 },
  { id: 'sage', name: 'Adaçayı', description: 'Yumuşak yeşil', category: 'soft', mimeType: 'image/png', width: 1600, height: 900 },
  { id: 'sunset', name: 'Gün batımı', description: 'Sıcak renkler', category: 'soft', mimeType: 'image/png', width: 1600, height: 900 },
  { id: 'paper', name: 'Kâğıt', description: 'Nötr doku', category: 'texture', mimeType: 'image/png', width: 1600, height: 900 },
  { id: 'neon-grid', name: 'Neon ızgara', description: 'Teknolojik vurgu', category: 'texture', mimeType: 'image/png', width: 1600, height: 900 },
];
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
  saveState: 'saved' | 'saving' | 'error';
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
  notice: '',
  history: { past: [], future: [] },
  historyGroup: null,
  setProject: (project, resetHistory = true) => set((state) => resetHistory
    ? { project, history: { past: [], future: [] }, historyGroup: null, selectedClipId: null, selectedClipIds: [], selectedTrackId: null, currentTime: 0, rangeStart: null, rangeEnd: null, assetDragId: null }
    : { ...state, project }),
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
      saveState: 'saving',
    };
  }),
  undo: () => set((state) => {
    const previous = state.history.past.at(-1);
    if (!previous || !state.project) return state;
    return { project: previous, history: { past: state.history.past.slice(0, -1), future: [state.project, ...state.history.future] }, historyGroup: null, saveState: 'saving' };
  }),
  redo: () => set((state) => {
    const next = state.history.future[0];
    if (!next || !state.project) return state;
    return { project: next, history: { past: [...state.history.past, state.project], future: state.history.future.slice(1) }, historyGroup: null, saveState: 'saving' };
  }),
  setSaveState: (saveState) => set({ saveState }),
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
  if (init?.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(url, { ...init, headers });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ApiError(body.error || `İstek başarısız (${response.status})`, response.status, body);
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
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-title"><div className="modal-head"><div><p className="eyebrow">Onay işlemi</p><h2 id="confirm-dialog-title">{title}</h2></div><button onClick={onClose} aria-label="Kapat">×</button></div><p>{message}</p><div className="modal-actions"><button className="secondary-button" onClick={onClose}>Vazgeç</button><button className="primary-button danger-button" onClick={onConfirm}>{confirmLabel}</button></div></section></div>;
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
    }).catch((error: unknown) => setNotice(error instanceof Error ? error.message : 'Sunucuya bağlanılamadı')).finally(() => setLoading(false));
  }, [setSettings]);

  const openProject = async (id: string) => {
    try {
      const loaded = await api<Project>(`/api/projects/${id}`);
      const normalized = normalizeProjectDurations(loaded);
      const ready = normalized === loaded ? loaded : await api<Project>(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify(normalized) }).catch(() => normalized);
      setProject(ready);
      transitionTo('editor');
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Proje açılamadı'); }
  };

  const createProject = async () => {
    try {
      const created = await api<Project>('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'Yeni proje' }) });
      setProjects((items) => [created, ...items]);
      setProject(created);
      transitionTo('editor');
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Proje oluşturulamadı'); }
  };

  const requestDeleteProject = (id: string) => {
    const candidate = projects.find((item) => item.id === id);
    if (candidate) setDeleteCandidate(candidate);
  };

  const deleteProject = async () => {
    const candidate = deleteCandidate;
    if (!candidate) return;
    setDeleteCandidate(null);
    try {
      await api(`/api/projects/${candidate.id}`, { method: 'DELETE' });
      setProjects((items) => items.filter((item) => item.id !== candidate.id));
      setTrash(await api<TrashEntry[]>('/api/trash'));
    }
    catch (error) { setNotice(error instanceof Error ? error.message : 'Proje silinemedi'); }
  };

  const restoreTrash = async (trashId: string) => {
    const entry = trash.find((item) => item.trashId === trashId);
    if (!entry || !window.confirm(`“${entry.name}” projesi geri yüklensin mi?`)) return;
    try {
      const restored = await api<Project>('/api/trash/' + encodeURIComponent(trashId) + '/restore', { method: 'POST', body: JSON.stringify({}) });
      setProjects((items) => [restored, ...items]);
      setTrash((items) => items.filter((item) => item.trashId !== trashId));
      setNotice('Proje çöp kutusundan geri yüklendi.');
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Proje geri yüklenemedi'); }
  };

  const purgeTrash = async (trashId: string) => {
    const entry = trash.find((item) => item.trashId === trashId);
    if (!entry || !window.confirm(`“${entry.name}” projesi kalıcı olarak silinsin mi? Bu işlem geri alınamaz.`)) return;
    try {
      await api('/api/trash/' + encodeURIComponent(trashId), { method: 'DELETE' });
      setTrash((items) => items.filter((item) => item.trashId !== trashId));
      setNotice('Çöp kutusu kaydı kalıcı olarak silindi.');
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Çöp kutusu kaydı silinemedi'); }
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
      {screen === 'dashboard' ? <Dashboard projects={projects} trash={trash} loading={loading} onCreate={createProject} onOpen={openProject} onDelete={requestDeleteProject} onRestoreTrash={restoreTrash} onPurgeTrash={purgeTrash} onSettings={() => setShowSettings(true)} /> : project ? <Editor onBack={returnToDashboard} /> : null}
    </div>
    {screenTransition !== 'idle' && <div className={`route-transition ${screenTransition === 'enter' ? 'route-transition-enter' : ''}`} aria-hidden="true"><div className="route-transition-orbit"><i /><i /><i /></div><span>{screen === 'editor' ? 'Editör hazırlanıyor' : 'Çalışma alanına dönülüyor'}</span></div>}
    {screen === 'dashboard' && showSettings && <SettingsModal settings={useEditor.getState().settings} onClose={() => setShowSettings(false)} />}
    {screen === 'dashboard' && deleteCandidate && <ConfirmDialog title="Taslağı çöp kutusuna taşı?" message={`“${deleteCandidate.name}” projesi geri dönüşümlü olarak silinecek.`} confirmLabel="Çöp kutusuna taşı" onConfirm={() => void deleteProject()} onClose={() => setDeleteCandidate(null)} />}
    {notice && <div className="toast toast-error"><Glyph>!</Glyph>{notice}<button onClick={() => setNotice('')}>×</button></div>}
  </div>;
}

function ThemeSwitcher({ compact = false }: { compact?: boolean }) {
  const theme = useEditor((state) => state.theme);
  const setTheme = useEditor((state) => state.setTheme);
  const options: Array<[Theme, string, string]> = [['light', 'Beyaz', '○'], ['gray', 'Gri', '◐'], ['dark', 'Siyah', '●']];
  return <div className={`theme-switcher ${compact ? 'compact' : ''}`} role="group" aria-label="Tema seçimi">
    {options.map(([value, label, icon]) => <button key={value} className={theme === value ? 'active' : ''} onClick={() => setTheme(value)} title={`${label} tema`} aria-label={`${label} tema`}><span>{icon}</span>{!compact && <small>{label}</small>}</button>)}
  </div>;
}

function Dashboard({ projects, trash, loading, onCreate, onOpen, onDelete, onRestoreTrash, onPurgeTrash, onSettings }: { projects: Project[]; trash: TrashEntry[]; loading: boolean; onCreate: () => void; onOpen: (id: string) => void; onDelete: (id: string) => void; onRestoreTrash: (trashId: string) => void; onPurgeTrash: (trashId: string) => void; onSettings: () => void }) {
  const language = useEditor((state) => state.settings?.language ?? 'en');
  const isEnglish = language === 'en';
  return <main key={language} className="dashboard">
    <header className="dashboard-header">
      <div className="brand"><div className="brand-mark"><span /></div><div><strong>CUTLOC</strong><small>Yerel video editörü</small></div></div>
      <div className="header-actions"><span className="offline-pill"><i /> Yerel mod</span><ThemeSwitcher /><button className="icon-button" title="Ayarlar" onClick={onSettings}><Glyph>⚙</Glyph></button></div>
    </header>
    <section className="dashboard-hero">
      <div><p className="eyebrow">Yaratıcılık, cihazında</p><h1>Hikâyeni <em>kes.</em><br />Kendi ritmini bul.</h1><p className="hero-copy">Videolarını, seslerini ve fikirlerini tek bir yerel çalışma alanında birleştir. Verilerin dışarı çıkmaz.</p><button className="primary-button large" onClick={onCreate}><Glyph>＋</Glyph> Yeni proje oluştur</button></div>
      <div className="hero-orbit"><div className="orbit-ring ring-a" /><div className="orbit-ring ring-b" /><div className="orbit-card card-one">◒<small>timeline</small></div><div className="orbit-card card-two">✦<small>effects</small></div><div className="orbit-card card-three">▣<small>export</small></div><div className="hero-core"><b>CL</b><span>LOCAL<br />FIRST</span></div></div>
    </section>
    <section className="dashboard-command-strip" aria-label="Hızlı başlangıç">
      <button className="command-card command-primary" onClick={onCreate}><span className="command-icon">＋</span><span><strong>Yeni proje</strong><small>Boş bir canvas ile başla</small></span><b>↗</b></button>
      <button className="command-card" onClick={onCreate}><span className="command-icon">▣</span><span><strong>Medyayla başla</strong><small>Dosyanı ekle ve timeline’a yerleştir</small></span><b>↗</b></button>
      {projects[0] ? <button className="command-card" onClick={() => onOpen(projects[0].id)}><span className="command-icon">▶</span><span><strong>Düzenlemeye devam et</strong><small>{projects[0].name} · {formatTime(projects[0].duration)}</small></span><b>↗</b></button> : <div className="command-card command-muted"><span className="command-icon">⌁</span><span><strong>Yerel çalışma alanı</strong><small>Dosyaların cihazından çıkmaz</small></span></div>}
    </section>
    <section className="projects-section">
      <div className="section-heading"><div><p className="eyebrow">Çalışma alanın</p><h2>Taslakların</h2></div><span className="project-count">{`${projects.length} ${isEnglish ? 'projects' : 'proje'}`}</span></div>
      <div className="dashboard-insights"><span><b>{projects.reduce((total, item) => total + item.assets.length, 0)}</b> {isEnglish ? 'media assets' : 'medya varlığı'}</span><span><b>{projects.filter((item) => item.duration > 0).length}</b> {isEnglish ? 'active timelines' : 'aktif timeline'}</span><span><b>Ctrl / ⌘ Z</b> {isEnglish ? 'to undo' : 'ile geri al'}</span></div>
      {loading ? <div className="empty-state"><div className="spinner" /> Projeler yükleniyor…</div> : projects.length === 0 ? <div className="empty-state empty-dashed"><div className="empty-icon">✦</div><h3>İlk hikâyeni başlat</h3><p>Bir proje oluştur ve medya dosyalarını sürükleyerek timeline’a ekle.</p><button className="secondary-button" onClick={onCreate}>Yeni proje</button></div> : <div className="project-grid">{projects.map((item) => <ProjectCard key={item.id} project={item} onOpen={() => onOpen(item.id)} onDelete={() => onDelete(item.id)} />)}</div>}
    </section>
    <TrashSection entries={trash} onRestore={onRestoreTrash} onPurge={onPurgeTrash} />
    <footer className="dashboard-footer"><span><i className="status-dot" /> Verilerin cihazında kalır</span><span>CutLoc <b>v0.0.2</b></span></footer>
  </main>;
}

function TrashSection({ entries, onRestore, onPurge }: { entries: TrashEntry[]; onRestore: (trashId: string) => void; onPurge: (trashId: string) => void }) {
  const language = useEditor((state) => state.settings?.language ?? 'en');
  return <section key={language} className="trash-section" aria-label="Çöp kutusu">
    <div className="section-heading"><div><p className="eyebrow">Kurtarma alanı</p><h2>Çöp kutusu</h2></div><span className="project-count">{`${entries.length} ${language === 'en' ? 'items' : 'kayıt'}`}</span></div>
    {entries.length === 0 ? <div className="trash-empty">Silinen projeler burada tutulur; istersen geri yükleyebilir veya kalıcı olarak temizleyebilirsin.</div> : <div className="trash-grid">{entries.map((entry) => <article className="trash-card" key={entry.trashId}><div className="trash-card-main"><strong>{entry.name}</strong><small>{new Date(entry.deletedAt).toLocaleString(language === 'tr' ? 'tr-TR' : 'en-US', { dateStyle: 'short', timeStyle: 'short' })} · {entry.assetCount} {language === 'en' ? 'media' : 'medya'}</small></div><div className="trash-card-actions"><button className="secondary-button" onClick={() => onRestore(entry.trashId)}>Geri yükle</button><button className="danger-button" onClick={() => onPurge(entry.trashId)}>Kalıcı sil</button></div></article>)}</div>}
  </section>;
}

function ProjectCard({ project, onOpen, onDelete }: { project: Project; onOpen: () => void; onDelete: () => void }) {
  const language = useEditor((state) => state.settings?.language ?? 'en');
  const accent = project.canvas.width > project.canvas.height ? 'landscape' : 'portrait';
  const hasTimeline = project.duration > 0;
  return <article className="project-card" onDoubleClick={onOpen}>
    <button className={`project-preview ${accent}`} onClick={onOpen}><div className="preview-grid" /><span className="project-play">▶</span><span className="aspect-tag">{project.canvas.width}:{project.canvas.height}</span></button>
    <div className="project-card-info"><div><div className="project-card-title"><h3>{project.name}</h3><span className={`project-status ${hasTimeline ? 'ready' : ''}`}>{hasTimeline ? 'Kurgu var' : 'Başlangıç'}</span></div><p>{new Date(project.updatedAt).toLocaleDateString(language === 'tr' ? 'tr-TR' : 'en-US', { day: '2-digit', month: 'short' })} · {formatTime(project.duration)} · {project.assets.length} {language === 'en' ? 'media' : 'medya'}</p></div><button className="more-button" onClick={onDelete} title="Çöp kutusuna taşı">•••</button></div>
  </article>;
}

function Editor({ onBack }: { onBack: () => void }) {
  const project = useEditor((state) => state.project)!;
  const settings = useEditor((state) => state.settings);
  const setSettings = useEditor((state) => state.setSettings);
  const saveState = useEditor((state) => state.saveState);
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
  const [exportStatus, setExportStatus] = useState<{ jobId?: string; status?: string; progress: number; message?: string; downloadUrl?: string; fileName?: string; error?: string }>({ progress: 0 });
  const [workspaceLayout, setWorkspaceLayout] = useState<WorkspaceLayout>({ ...DEFAULT_WORKSPACE_LAYOUT, ...(settings?.workspaceLayout ?? {}) });
  const saveTimerRef = useRef<number | null>(null);
  const saveInFlightRef = useRef(false);

  useEffect(() => {
    if (settings?.workspaceLayout) setWorkspaceLayout({ ...DEFAULT_WORKSPACE_LAYOUT, ...settings.workspaceLayout });
  }, [settings?.workspaceLayout]);

  const persistWorkspaceLayout = (next: WorkspaceLayout) => {
    setWorkspaceLayout(next);
    if (!settings) return;
    setSettings({ ...settings, workspaceLayout: next });
    void api<Settings>('/api/settings', { method: 'PUT', body: JSON.stringify({ workspaceLayout: next }) }).catch(() => setEditorNotice('Çalışma alanı düzeni kaydedilemedi.'));
  };

  useEffect(() => {
    if (saveState !== 'saving') return;
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
          if (!saved) throw new Error('Proje kaydedilemedi');
          const currentProject = useEditor.getState().project;
          if (currentProject === snapshot) {
            // A server acknowledgement must not erase the local undo/redo stack.
            setProject(saved, false);
            const survivingClipIds = keepClipIds.filter((id) => saved!.tracks.some((track) => track.clips.some((clip) => clip.id === id)));
            if (survivingClipIds.length) useEditor.getState().setSelectedMany(survivingClipIds, keepTrackId);
            else if (keepClipId && saved.tracks.some((track) => track.clips.some((clip) => clip.id === keepClipId))) useEditor.getState().setSelected(keepClipId, keepTrackId);
            useEditor.getState().setCurrentTime(keepTime);
            setSaveState('saved');
          } else {
            // A newer local edit arrived while the request was in flight. Keep it
            // visible and immediately schedule that newer snapshot for saving.
            setSaveState('saved');
            window.setTimeout(() => {
              if (useEditor.getState().project !== saved) useEditor.getState().setSaveState('saving');
            }, 0);
          }
        } catch (error) {
          setSaveState('error');
          setEditorNotice(error instanceof Error ? `Kaydetme hatası: ${error.message}` : 'Kaydetme hatası');
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

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
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
            const copies = track.clips.filter((clip) => duplicateMap.has(clip.id)).map((clip) => ({ ...clip, id: duplicateMap.get(clip.id)!, name: `${clip.name} kopya`, start: clip.start + 0.25 }));
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
      if (!response.ok) throw new Error((await response.json()).error || 'Medya import edilemedi');
      const result = await response.json() as { asset: Asset; project: Project };
      const serverProject = result.project;
      // Importing populates the library only.  Reconcile the new asset without
      // hydrating the whole server snapshot: that would reset the playhead,
      // selection and local timeline edits while a proxy is being prepared.
      const localProject = useEditor.getState().project;
      const mergedProject = localProject ? mergeImportedProject(localProject, serverProject) : serverProject;
      useEditor.getState().setProject(mergedProject, false);
      useEditor.getState().setSaveState('saving');
      setEditorNotice(`“${result.asset.name}” kütüphaneye eklendi. Timeline'a eklemek için karttaki Ekle düğmesini kullanın.`);
    } catch (error) { setExportMessage(error instanceof Error ? error.message : 'Medya import edilemedi'); }
  };

  const addFirstAssetToTimeline = (): boolean => {
    const current = useEditor.getState().project;
    if (!current) return false;
    const asset = current.assets.find((item) => item.type === 'video' || item.type === 'image') ?? current.assets.find((item) => item.type === 'audio');
    if (!asset) {
      setEditorNotice('Önce medya içe aktarın, ardından timeline üzerinde bir klip oluşturun.');
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
    setEditorNotice(`“${asset.name}” timeline'a eklendi. Şimdi export başlatabilirsiniz.`);
    return true;
  };

  const flushPendingSave = async () => {
    const deadline = Date.now() + 3500;
    while (useEditor.getState().saveState === 'saving' && Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 80));
    }
    if (useEditor.getState().saveState === 'error') throw new Error('Önce bekleyen proje kaydını düzeltin.');
  };

  const startExport = async (options: ExportOptions): Promise<ExportPreflight> => {
    await flushPendingSave();
    setExporting(true);
    setExportStatus({ progress: 0, status: 'preflight', message: 'Export ön kontrolü yapılıyor' });
    try {
      const preflight = await api<ExportPreflight>(`/api/projects/${project.id}/export/preflight`, { method: 'POST', body: JSON.stringify(options) });
      if (!preflight.ok) throw new Error(preflight.errors.map((item) => item.message).join(' '));
      // Remember the last successful profile so the next export opens with the
      // user's preferred framing, resolution, frame rate and quality.
      void api<Settings>('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({
          defaultExport: {
            format: options.format,
            aspect: options.aspect === 'source' ? project.canvas.aspect : options.aspect,
            resolution: options.resolution,
            fps: options.fps,
            quality: options.quality,
            audioBitrateKbps: options.audioBitrateKbps,
          },
        }),
      }).then(setSettings).catch(() => undefined);
      const response = await api<{ job: { id: string }; preflight?: ExportPreflight }>(`/api/projects/${project.id}/export`, { method: 'POST', body: JSON.stringify(options) });
      const jobId = response.job.id;
      setExportStatus({ jobId, progress: 0, status: 'queued', message: 'Export kuyruğa alındı' });
      void new Promise<void>((resolve) => {
        const eventSource = new EventSource('/api/events');
        eventSource.addEventListener('job', (event) => {
          const job = JSON.parse((event as MessageEvent).data) as { id: string; status: string; progress: number; message?: string; downloadUrl?: string; fileName?: string; error?: string };
          if (job.id !== jobId) return;
          setExportStatus({ jobId, progress: job.progress ?? 0, status: job.status, message: job.message, downloadUrl: job.downloadUrl, fileName: job.fileName, error: job.error });
          if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
            setExporting(false);
            eventSource.close();
            resolve();
          }
        });
        eventSource.onerror = () => { eventSource.close(); setExporting(false); resolve(); };
      });
      return preflight;
    } catch (error) {
      setExporting(false);
      setExportStatus({ progress: 0, status: 'failed', error: error instanceof Error ? error.message : 'Export başarısız' });
      throw error;
    }
  };

  return <div className="editor-shell">
    <EditorTopbar project={project} onBack={onBack} onExport={() => setShowExport(true)} exporting={exporting} onSettings={() => setShowSettings(true)} />
    <div className="editor-body workspace-layout" style={{ '--workspace-rail-width': `${workspaceLayout.railWidth}px`, '--workspace-library-width': `${workspaceLayout.libraryWidth}px`, '--workspace-inspector-width': `${workspaceLayout.inspectorWidth}px`, '--workspace-timeline-height': `${workspaceLayout.timelineHeight}px` } as React.CSSProperties}><ToolRail onOpenSettings={() => setShowSettings(true)} /><AssetPanelPro onImport={importMedia} onOpenSettings={() => setShowSettings(true)} /><PreviewArea project={project} settings={settings} /><Inspector project={project} /><TimelinePro project={project} /><WorkspaceResizers layout={workspaceLayout} onPreview={setWorkspaceLayout} onCommit={persistWorkspaceLayout} /></div>
    {exportMessage && <div className={`export-toast ${exporting ? 'active' : ''}`}><span className="export-pulse" />{exportMessage}{!exporting && <button onClick={() => setExportMessage('')}>×</button>}</div>}
    {editorNotice && <div className="export-toast"><span className="export-pulse" />{editorNotice}<button onClick={() => setEditorNotice('')}>×</button></div>}
    <div className="editor-statusbar"><span><i className="status-dot" /> CutLoc hazır</span><span>{saveState === 'saving' ? 'Kaydediliyor…' : saveState === 'error' ? 'Kaydetme hatası' : 'Tüm değişiklikler kaydedildi'}</span><span>⌘/Ctrl Z geri al · Space oynat</span></div>
    {showSettings && <SettingsModal settings={settings} onClose={() => setShowSettings(false)} />}
    {showExport && <ExportModal project={project} settings={settings} rangeStart={rangeStart} rangeEnd={rangeEnd} exporting={exporting} status={exportStatus} onStart={startExport} onAddFirstAsset={addFirstAssetToTimeline} onClose={() => setShowExport(false)} />}
  </div>;
}

function ExportModal({ project, settings, rangeStart, rangeEnd, exporting, status, onStart, onAddFirstAsset, onClose }: { project: Project; settings: Settings | null; rangeStart: number | null; rangeEnd: number | null; exporting: boolean; status: { jobId?: string; status?: string; progress: number; message?: string; downloadUrl?: string; fileName?: string; error?: string }; onStart: (options: ExportOptions) => Promise<ExportPreflight>; onAddFirstAsset: () => boolean; onClose: () => void }) {
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
    catch (submitError) { setError(submitError instanceof Error ? submitError.message : 'Export başlatılamadı'); }
  };
  return <div className="modal-backdrop export-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !exporting) onClose(); }}><section className="export-modal" role="dialog" aria-modal="true" aria-labelledby="export-title">
    <div className="modal-head"><div><p className="eyebrow">Render studio</p><h2 id="export-title">Dışa aktarma</h2><small>{project.name} · {formatTime(project.duration)} timeline</small></div><button onClick={onClose} disabled={exporting} aria-label="Kapat">×</button></div>
    <div className="export-layout">
      <div className="export-form">
        <div className="export-section"><span className="export-label">Canvas</span><div className="export-canvas-readonly export-canvas-profile"><span>Preview oranı korunur</span><strong>{aspect} · Canvas {canvasHint}</strong><small>Çıktı: {resolution === '2K' ? '1440p' : resolution} · {outputHint}</small></div></div>
        <div className="export-grid-row"><label><span>Format</span><select value={format} onChange={(event) => setFormat(event.target.value as ExportOptions['format'])} disabled={exporting}><option value="mp4">MP4 · H.264 + AAC</option><option value="mp3">MP3 ses</option><option value="wav">WAV ses</option></select></label><label><span>Çözünürlük</span><select aria-label="Çıktı çözünürlüğü" value={resolution} onChange={(event) => setResolution(event.target.value as ExportOptions['resolution'])} disabled={exporting || format !== 'mp4'}><option value="720p">720p · HD</option><option value="1080p">1080p · Full HD</option><option value="2K">1440p · 2K</option><option value="4K">2160p · 4K UHD</option></select></label></div>
        <div className="export-grid-row"><label><span>Frame rate</span><select value={fps} onChange={(event) => setFps(Number(event.target.value) as ExportOptions['fps'])} disabled={exporting}><option value={24}>24 FPS</option><option value={25}>25 FPS</option><option value={30}>30 FPS</option><option value={50}>50 FPS</option><option value={60}>60 FPS</option></select></label><label><span>Ses bitrate</span><select value={audioBitrateKbps} onChange={(event) => setAudioBitrateKbps(Number(event.target.value) as 128 | 192 | 256)} disabled={exporting}><option value={128}>128 kbps</option><option value={192}>192 kbps</option><option value={256}>256 kbps</option></select></label></div>
        <div className="export-section"><span className="export-label">Kalite</span><div className="quality-tabs">{(['draft', 'standard', 'high', 'custom'] as const).map((value) => <button key={value} className={quality === value ? 'active' : ''} onClick={() => setQuality(value)} disabled={exporting}>{value === 'draft' ? 'Taslak' : value === 'standard' ? 'Standart' : value === 'high' ? 'Yüksek' : 'Gelişmiş'}</button>)}</div>{quality === 'custom' && <div className="advanced-quality"><label><span>Rate mode</span><select value={rateMode} onChange={(event) => setRateMode(event.target.value as ExportOptions['rateMode'])}><option value="crf">CRF</option><option value="bitrate">Bitrate</option></select></label>{rateMode === 'crf' ? <label><span>CRF (16–32)</span><input type="number" min={16} max={32} value={crf} onChange={(event) => setCrf(Number(event.target.value))} /></label> : <label><span>Video bitrate (kbps)</span><input type="number" min={500} max={50000} step={500} value={videoBitrateKbps} onChange={(event) => setVideoBitrateKbps(Number(event.target.value))} /></label>}</div>}</div>
        <div className="export-section"><span className="export-label">Kapsam</span><div className="scope-toggle"><button className={scope === 'all' ? 'active' : ''} onClick={() => setScope('all')} disabled={exporting}>Tüm timeline</button><button className={scope === 'range' ? 'active' : ''} onClick={() => setScope('range')} disabled={exporting || rangeStart === null || rangeEnd === null}>In–Out {rangeStart !== null && rangeEnd !== null ? `(${formatTime(rangeEnd - rangeStart)})` : 'belirlenmedi'}</button></div></div>
        <label className="export-file-name"><span>Dosya adı</span><input value={fileName} onChange={(event) => setFileName(event.target.value)} disabled={exporting} /></label>
      </div>
      <aside className="export-summary"><div className="summary-icon">↗</div><strong>{format === 'mp4' ? 'Video export' : 'Ses export'}</strong><p>{format === 'mp4' ? `${aspect} · ${outputHint} · ${fps} FPS` : `${format.toUpperCase()} · ${audioBitrateKbps} kbps`}</p><div className="summary-row"><span>Kalite</span><b>{quality === 'draft' ? 'Taslak' : quality === 'standard' ? 'Standart' : quality === 'high' ? 'Yüksek' : 'Özel'}</b></div><div className="summary-row"><span>Codec</span><b>{format === 'mp4' ? 'H.264 / AAC' : format.toUpperCase()}</b></div>{preflight?.warnings.map((warning) => <div className="export-warning" key={warning.code}>⚠ {warning.message}</div>)}{status.status && <div className="export-progress"><div className="progress-head"><span>{status.message || 'Hazırlanıyor'}</span><b>{Math.round(status.progress * 100)}%</b></div><div className="progress-track"><i style={{ width: `${Math.max(2, status.progress * 100)}%` }} /></div></div>}{status.error && <div className="export-error">{status.error}</div>}{done && status.downloadUrl && <div className="export-complete"><span>✓ Hazır</span><strong>{status.fileName}</strong><a className="secondary-button" href={status.downloadUrl} download={status.fileName}>İndir</a></div>}</aside>
    </div>
    {error && <div className="export-error export-error-bottom">{error}{error.toLocaleLowerCase('tr-TR').includes('timeline') && <button className="secondary-button export-recovery-button" onClick={() => { if (onAddFirstAsset()) setError(''); }}>Kütüphanedeki medyayı timeline'a ekle</button>}</div>}
    <div className="modal-actions"><span>{preflight?.estimatedBytes ? `Tahmini boyut: ${(preflight.estimatedBytes / 1024 / 1024).toFixed(1)} MB` : 'FFmpeg yerel olarak çalışır'}</span><button className="secondary-button" onClick={onClose} disabled={exporting}>Kapat</button><button className="primary-button export-start-button" onClick={() => void submit()} disabled={exporting}>{exporting ? 'Export ediliyor…' : done ? 'Yeniden export' : 'Dışa aktar'}</button></div>
  </section></div>;
}

function EditorTopbar({ project, onBack, onExport, exporting, onSettings }: { project: Project; onBack: () => void; onExport: () => void; exporting: boolean; onSettings: () => void }) {
  const mutateProject = useEditor((state) => state.mutateProject);
  const undo = useEditor((state) => state.undo); const redo = useEditor((state) => state.redo);
  return <header className="editor-topbar"><div className="topbar-left"><button className="back-button" onClick={onBack}>‹</button><div className="editor-brand"><div className="mini-mark">CL</div><span>CUTLOC</span></div><div className="topbar-divider" /><input className="project-name-input" value={project.name} onChange={(event) => mutateProject((draft) => { draft.name = event.target.value; })} /></div><div className="topbar-center"><button className="history-button" onClick={undo} title="Geri al">↶</button><button className="history-button" onClick={redo} title="Yinele">↷</button><span className="save-indicator"><i className="status-dot" /> Kaydedildi</span></div><div className="topbar-right"><ThemeSwitcher compact /><button className="export-button" disabled={exporting} onClick={onExport}>{exporting ? 'Export…' : 'Dışa aktar'} <Glyph>↗</Glyph></button><button className="icon-button editor-settings" onClick={onSettings} title="Ayarlar"><Glyph>⚙</Glyph></button><button className="avatar-button" onClick={onSettings} title="Ayarlar">HK</button></div></header>;
}

function SettingsModal({ settings, onClose }: { settings: Settings | null; onClose: () => void }) {
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
    setStatus('Kaydediliyor…');
    try {
      const saved = await api<Settings>('/api/settings', { method: 'PUT', body: JSON.stringify(form) });
      setSettings(saved); setStatus('Kaydedildi'); window.setTimeout(onClose, 450);
    } catch (error) { setStatus(error instanceof Error ? error.message : 'Ayarlar kaydedilemedi'); }
  };
  const generalSettings = <>
    <label className="setting-row"><span><strong>Arayüz dili</strong><small>Değişiklik kaydedildiğinde tüm arayüze uygulanır</small></span><select aria-label="Arayüz dili" value={form.language} onChange={(event) => setForm({ ...form, language: event.target.value as 'en' | 'tr' })}><option value="en">English</option><option value="tr">Türkçe</option></select></label>
    <label className="setting-row"><span><strong>Çıktı çözünürlüğü</strong><small>Canvas oranı korunarak gerçek video boyutu belirlenir</small></span><select value={form.defaultExport.resolution} onChange={(event) => setForm({ ...form, defaultExport: { ...form.defaultExport, resolution: event.target.value as typeof form.defaultExport.resolution } })}><option value="720p">720p · 1280 × 720</option><option value="1080p">1080p · 1920 × 1080</option><option value="2K">1440p · 2560 × 1440</option><option value="4K">4K UHD · 3840 × 2160</option></select></label>
    <label className="setting-row"><span><strong>Preview kalitesi</strong><small>Uzun projelerde akıcılık</small></span><select value={form.proxyQuality} onChange={(event) => setForm({ ...form, proxyQuality: event.target.value as 'draft' | 'balanced' | 'high' })}><option value="draft">Draft</option><option value="balanced">Balanced</option><option value="high">High</option></select></label>
    <div className="setting-row setting-readonly"><span><strong>Video encoder</strong><small>Bu sürümde doğrulanmış yerel encoder</small></span><b>H.264 · CPU</b></div>
    <div className="workspace-settings-card"><div><strong>Çalışma alanı</strong><small>Panelleri sürükleyerek genişlik ve yüksekliği değiştirebilirsin.</small></div><button type="button" className="shortcut-reset" onClick={() => setForm({ ...form, workspaceLayout: { ...DEFAULT_WORKSPACE_LAYOUT } })}>Varsayılan düzene dön</button></div>
  </>;
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="settings-modal"><div className="modal-head"><div><p className="eyebrow">Workspace</p><h2>Ayarlar</h2></div><button onClick={onClose}>×</button></div><div className="settings-tabs"><button className={activeTab === 'general' ? 'active' : ''} onClick={() => setActiveTab('general')}>Genel</button><button className={activeTab === 'shortcuts' ? 'active' : ''} onClick={() => setActiveTab('shortcuts')}>Kısayollar</button></div>{activeTab === 'general' && generalSettings}{activeTab === 'shortcuts' && <div className="shortcut-settings"><div className="settings-intro"><strong>Kurgu kısayolları</strong><small>Kısayollar bu sürümde sabittir; yanlışlıkla değiştirilemez.</small></div>{(Object.keys(SHORTCUT_LABELS) as ShortcutAction[]).map((action) => <div className="shortcut-setting-row" key={action}><span><strong>{SHORTCUT_LABELS[action].label}</strong><small>{SHORTCUT_LABELS[action].description}</small></span><kbd aria-label={`${SHORTCUT_LABELS[action].label} kısayolu`}>{DEFAULT_SHORTCUTS[action]}</kbd></div>)}</div>}<div className="modal-actions"><span>{status}</span><button className="secondary-button" onClick={onClose}>Vazgeç</button><button className="primary-button" onClick={() => void save()}>Kaydet</button></div></section></div>;
}

function panelTitle(panel: Panel) {
  const labels: Record<Panel, string> = {
    media: 'Medya', text: 'Metin', captions: 'Altyazılar',
    project: 'Proje', transitions: 'Geçişler', effects: 'Efektler', color: 'Renk',
    animation: 'Animasyon', help: 'Yardım',
  };
  return labels[panel];
}

type WorkspaceResizeHandle = 'rail' | 'library' | 'inspector' | 'timeline';

function WorkspaceResizers({ layout, onPreview, onCommit }: { layout: WorkspaceLayout; onPreview: (next: WorkspaceLayout) => void; onCommit: (next: WorkspaceLayout) => void }) {
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
  return <>{resizer('rail', 'workspace-resizer-rail', 'Araç çubuğu genişliğini ayarla', 'vertical')}{resizer('library', 'workspace-resizer-library', 'Sol panel genişliğini ayarla', 'vertical')}{resizer('inspector', 'workspace-resizer-inspector', 'Inspector genişliğini ayarla', 'vertical')}{resizer('timeline', 'workspace-resizer-timeline', 'Timeline yüksekliğini ayarla', 'horizontal')}</>;
}

function ToolRail({ onOpenSettings }: { onOpenSettings: () => void }) {
  const panel = useEditor((state) => state.panel); const setPanel = useEditor((state) => state.setPanel);
  const tools: Array<[Panel, string, string]> = [
    ['media', '▧', 'Medya'], ['text', 'T', 'Metin'],
    ['animation', '✧', 'Animasyon'], ['captions', '≡', 'Altyazı'], ['project', '◉', 'Proje'],
  ];
  return <aside className="tool-rail" aria-label="Proje araçları"><div className="rail-caption">PROJE</div><div className="rail-scroll">{tools.map(([key, icon, label]) => <button key={key} className={panel === key ? 'active' : ''} onClick={() => setPanel(key)}><span>{icon}</span><small>{label}</small></button>)}</div><div className="rail-spacer" /><button className="rail-ai rail-coming-soon" disabled title="AI sohbet testler tamamlandıktan sonra açılacak"><span>✦</span><small>AI Sohbet</small><i>Yakında</i></button><button className="rail-ai" onClick={() => setPanel('help')}><span>?</span><small>Yardım</small></button><button onClick={onOpenSettings}><span>⚙</span><small>Ayar</small></button></aside>;
}

function AssetPanel({ onImport }: { onImport: (file: File) => void }) {
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
  const title = panelTitle(panel);
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
  const track: Track = { id: `track-layer-${crypto.randomUUID().slice(0, 8)}`, type: 'layer', name: name ?? `Layer ${index + 1}`, order: index, clips: [], locked: false, hidden: false, muted: false };
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
    keyframes: [],
    textStyle,
  };
}

function AssetPanelEnhanced({ onImport, onOpenSettings }: { onImport: (file: File) => void; onOpenSettings: () => void }) {
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
        track = { id: targetTrackId, type: 'layer', name: `Layer ${draft.tracks.length + 1}`, order: draft.tracks.length, clips: [], locked: false, hidden: false, muted: false };
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

  const title = panelTitle(panel);
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
type AnimationCategory = 'Tümü' | 'Kesme' | 'Yumuşak' | 'Hareket' | 'Odak';
type AnimationPreset = {
  id: string;
  label: string;
  description: string;
  type: TransitionPreset;
  category: Exclude<AnimationCategory, 'Tümü'>;
  motionDirection: TransitionDirection;
  directionLabel: string;
  duration: number;
};

const ANIMATION_PRESETS: AnimationPreset[] = [
  { id: 'none', label: 'Yok', description: 'Anında görünür', type: 'none', category: 'Kesme', motionDirection: 'center', directionLabel: 'Kes', duration: 0 },
  { id: 'fade', label: 'Soluklaşma', description: 'Yumuşakça görünür', type: 'fade', category: 'Yumuşak', motionDirection: 'center', directionLabel: 'Şeffaf → net', duration: 0.35 },
  { id: 'dissolve', label: 'Çözülme', description: 'Sakin ve organik', type: 'dissolve', category: 'Yumuşak', motionDirection: 'center', directionLabel: 'Yumuşak doku', duration: 0.45 },
  { id: 'slide-left', label: 'Soldan kaydır', description: 'Soldan akarak gelir', type: 'slide', category: 'Hareket', motionDirection: 'left', directionLabel: 'Sol → merkez', duration: 0.4 },
  { id: 'slide-right', label: 'Sağdan kaydır', description: 'Sağdan akarak gelir', type: 'slide', category: 'Hareket', motionDirection: 'right', directionLabel: 'Sağ → merkez', duration: 0.4 },
  { id: 'slide-up', label: 'Aşağıdan yükselt', description: 'Aşağıdan yukarı taşır', type: 'slide', category: 'Hareket', motionDirection: 'down', directionLabel: 'Alt → merkez', duration: 0.4 },
  { id: 'slide-down', label: 'Yukarıdan indir', description: 'Yukarıdan aşağı taşır', type: 'slide', category: 'Hareket', motionDirection: 'up', directionLabel: 'Üst → merkez', duration: 0.4 },
  { id: 'wipe', label: 'Sürme', description: 'Perde gibi açılır', type: 'wipe', category: 'Hareket', motionDirection: 'left', directionLabel: 'Perde → açık', duration: 0.4 },
  { id: 'zoom', label: 'Yakınlaş', description: 'Odaklanarak büyür', type: 'zoom', category: 'Odak', motionDirection: 'center', directionLabel: 'Küçük → büyük', duration: 0.45 },
];
type BackupSummary = { fileName: string; createdAt: string; size: number };

type HelpTopicId = 'start' | 'media' | 'preview' | 'motion' | 'timeline' | 'export';
type HelpTopic = {
  id: HelpTopicId;
  icon: string;
  label: string;
  title: string;
  summary: string;
  steps: string[];
  actionLabel: string;
  actionPanel?: Panel;
  actionNotice?: string;
};

const HELP_TOPICS: HelpTopic[] = [
  {
    id: 'start', icon: '✦', label: 'İlk adım', title: 'İlk videonu üç hamlede hazırla',
    summary: 'Dosyanı içe aktar, timeline’a yerleştir ve önizlemede sonucu kontrol et.',
    steps: ['Medya panelinden video, ses veya görsel ekle.', 'Karttaki Ekle düğmesiyle klibi timeline’a yerleştir.', 'Oynat düğmesine basıp playhead’i kontrol et.'],
    actionLabel: 'Medya panelini aç', actionPanel: 'media',
  },
  {
    id: 'media', icon: '▧', label: 'Medya', title: 'Kütüphaneyi düzenli tut',
    summary: 'Proje medyası, stok içerik ve şekiller aynı Media alanında; aradığını tek yerde bul.',
    steps: ['Medya sekmesinde arama ve filtreyi kullan.', 'Şekiller için Media içindeki Şekiller sekmesine geç.', 'Bir kartı çift tıklayarak ya da Ekle düğmesiyle timeline’a gönder.'],
    actionLabel: 'Media alanını aç', actionPanel: 'media',
  },
  {
    id: 'preview', icon: '⌖', label: 'Önizleme', title: 'Canvas’ta doğrudan seç ve taşı',
    summary: 'Metne veya görsele tıklayınca nesne seçilir; aynı klip timeline ve Inspector’da da açılır.',
    steps: ['Canvas üzerindeki metin ya da medya alanına tıkla.', 'Seçim çerçevesinden nesneyi sürükle veya köşe tutamacıyla ölçekle.', 'Yakınlaştırmayı kullanırken kaydırma alanında canvas’ın istediğin bölgesine ilerle.'],
    actionLabel: 'Metin alanını aç', actionPanel: 'text',
  },
  {
    id: 'motion', icon: '↝', label: 'Animasyon', title: 'Girişi ve çıkışı ayrı ayrı tasarla',
    summary: 'Hazır hareket kartını seç, sonra yön, yumuşatma, yoğunluk ve süreyi birlikte ayarla.',
    steps: ['Timeline’da bir klip seçip Animasyon panelini aç.', 'Giriş + çıkış, yalnız giriş veya yalnız çıkış kapsamını seç.', 'Gelişmiş hareket bölümünde yönü ve easing’i düzenle.'],
    actionLabel: 'Hareket stüdyosunu aç', actionPanel: 'animation',
  },
  {
    id: 'timeline', icon: '⌁', label: 'Timeline', title: 'Kes, böl, hizala',
    summary: 'Playhead’i taşı, klibi böl ve snap ile kenarlara temizce hizala.',
    steps: ['Klibi seçip playhead’i kesmek istediğin noktaya taşı.', 'B kısayoluyla klibi böl veya timeline menüsünü aç.', 'Snap’i açarak playhead ve klip kenarlarını birbirine yaklaştır.'],
    actionLabel: 'Timeline araçlarını gör', actionPanel: 'project',
  },
  {
    id: 'export', icon: '↗', label: 'Dışa aktar', title: 'Export öncesi son kontrol',
    summary: 'Canvas oranını, aralığı ve kaliteyi kontrol et; sonra videonu dışa aktar.',
    steps: ['Canvas oranını hedef platforma göre seç.', 'In/Out aralığını gerekiyorsa I ve O ile belirle.', 'Export penceresinde kaliteyi seçip ön kontrolü çalıştır.'],
    actionLabel: 'Proje araçlarını aç', actionPanel: 'project',
  },
];

function PanelContent({ panel, onAddText, onImport, onApplyEffect, onApplyTransition, onOpenSettings }: { panel: Panel; onAddText: (preset: TextPreset) => void; onImport: (file: File) => void; onApplyEffect: (preset: 'film' | 'retro' | 'glow' | 'blur' | 'chroma' | 'noise') => void; onApplyTransition?: (preset: TransitionPreset) => void; onOpenSettings: () => void }) {
  const subtitleFileRef = useRef<HTMLInputElement>(null);
  const project = useEditor((state) => state.project);
  const currentSettings = useEditor((state) => state.settings);
  const mutateProject = useEditor((state) => state.mutateProject);
  const setNotice = useEditor((state) => state.setNotice);
  const setPanel = useEditor((state) => state.setPanel);
  const [backups, setBackups] = useState<BackupSummary[]>([]);
  const [textSearch, setTextSearch] = useState('');
  const [textCategory, setTextCategory] = useState<'Tümü' | TextPreset['category']>('Tümü');
  const [helpTopicId, setHelpTopicId] = useState<HelpTopicId>('start');
  const [helpSearch, setHelpSearch] = useState('');
  const filteredTextPresets = TEXT_PRESETS.filter((preset) => {
    const query = textSearch.trim().toLocaleLowerCase('tr-TR');
    return (!query || `${preset.label} ${preset.description} ${preset.text}`.toLocaleLowerCase('tr-TR').includes(query)) && (textCategory === 'Tümü' || preset.category === textCategory);
  });
  const parseStamp = (value: string) => { const [clock, ms = '0'] = value.trim().replace(',', '.').split(/[,.](?=\d+$)/); const parts = clock.split(':').map(Number); return (parts.at(-1) ?? 0) + (parts.at(-2) ?? 0) * 60 + (parts.at(-3) ?? 0) * 3600 + Number(`0.${ms}`); };
  const importSubtitles = (file: File) => { void file.text().then((raw) => { const blocks = raw.replace(/\r/g, '').split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean); const entries = blocks.map((block) => { const lines = block.split('\n'); const timing = lines.find((line) => line.includes('-->')); if (!timing) return null; const [start, end] = timing.split('-->').map((value) => parseStamp(value)); return { start, end, text: lines.slice(lines.indexOf(timing) + 1).join('\n').trim() }; }).filter((entry): entry is { start: number; end: number; text: string } => Boolean(entry && entry.end > entry.start && entry.text)); if (!entries.length) { setNotice('SRT/VTT içinde geçerli altyazı bulunamadı.'); return; } mutateProject((draft) => { let track = draft.tracks.find((item) => !item.locked); if (!track) track = createLayerTrack(draft); for (const entry of entries) track.clips.push({ id: `sub_${crypto.randomUUID().slice(0, 8)}`, type: 'subtitle', name: entry.text.slice(0, 28), start: entry.start, duration: entry.end - entry.start, sourceStart: 0, sourceDuration: entry.end - entry.start, speed: 1, transform: { x: 0, y: 260, scale: 1, rotation: 0, opacity: 1, fit: 'contain', flipX: false, flipY: false }, filters: { brightness: 0, contrast: 0, saturation: 0, blur: 0, grayscale: 0 }, transitionIn: { type: 'none', duration: 0 }, transitionOut: { type: 'none', duration: 0 }, volume: 0, keyframes: [], subtitle: entry, textStyle: { ...DEFAULT_TEXT_STYLE, text: entry.text, fontSize: 40, fontWeight: 600, background: '#101116cc', padding: 10, align: 'center' } }); draft.duration = projectDuration(draft); }); setNotice(`${entries.length} altyazı segmenti içe aktarıldı.`); }); };
  const exportSubtitles = () => { if (!project) return; const stamp = (seconds: number) => { const ms = Math.max(0, Math.round(seconds * 1000)); const h = Math.floor(ms / 3600000); const m = Math.floor((ms % 3600000) / 60000); const s = Math.floor((ms % 60000) / 1000); return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; }; const subtitles = project.tracks.flatMap((track) => track.clips.filter((clip) => clip.type === 'subtitle' && clip.subtitle).sort((a, b) => a.start - b.start)); const body = subtitles.map((clip, index) => `${index + 1}\n${stamp(clip.start)} --> ${stamp(clip.start + clip.duration)}\n${clip.subtitle?.text ?? clip.textStyle?.text ?? clip.name}`).join('\n\n'); const blob = new Blob([body], { type: 'text/plain;charset=utf-8' }); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `${project.name.replace(/[^\p{L}\p{N}_-]+/gu, '-')}.srt`; link.click(); URL.revokeObjectURL(link.href); };
  useEffect(() => {
    if (panel !== 'project' || !project) return;
    let active = true;
    void api<BackupSummary[]>('/api/projects/' + project.id + '/backups')
      .then((items) => { if (active) setBackups(items); })
      .catch(() => { if (active) setBackups([]); });
    return () => { active = false; };
  }, [panel, project?.id]);
  const restoreBackup = async (fileName: string) => {
    if (!project || !window.confirm('Bu yedekten dönmek mevcut proje durumunu değiştirecek. Devam edilsin mi?')) return;
    try {
      const restored = await api<Project>('/api/projects/' + project.id + '/restore', { method: 'POST', body: JSON.stringify({ fileName }) });
      useEditor.getState().setProject(restored);
      useEditor.getState().setSaveState('saved');
      setNotice('Yedek geri yüklendi.');
    } catch (error) {
      setNotice(error instanceof Error ? `Yedek geri yüklenemedi: ${error.message}` : 'Yedek geri yüklenemedi.');
    }
  };
  if (panel === 'help') {
    const query = helpSearch.trim().toLocaleLowerCase('tr-TR');
    const matchingTopics = HELP_TOPICS.filter((topic) => !query || `${topic.label} ${topic.title} ${topic.summary} ${topic.steps.join(' ')}`.toLocaleLowerCase('tr-TR').includes(query));
    const activeTopic = matchingTopics.find((topic) => topic.id === helpTopicId) ?? matchingTopics[0];
    const openHelpAction = (topic: HelpTopic) => {
      if (topic.actionPanel) setPanel(topic.actionPanel);
      if (topic.actionNotice) setNotice(topic.actionNotice);
    };
    return <div className="quick-panel help-panel">
      <div className="help-hero"><div><p className="eyebrow">Yardım merkezi</p><h3>Kurguya yardım eden küçük rehber</h3><small>İhtiyacın olan aracı bul, ne işe yaradığını gör ve doğrudan ilgili panele geç.</small></div><span className="help-hero-mark">?</span></div>
      <label className="help-search-field"><span>⌕</span><input value={helpSearch} onChange={(event) => setHelpSearch(event.target.value)} placeholder="Yardımda ara…" aria-label="Yardımda ara" /></label>
      <div className="help-topic-tabs" role="tablist" aria-label="Yardım konuları">{matchingTopics.map((topic) => <button key={topic.id} type="button" role="tab" aria-selected={activeTopic?.id === topic.id} className={activeTopic?.id === topic.id ? 'active' : ''} onClick={() => setHelpTopicId(topic.id)}><span>{topic.icon}</span>{topic.label}</button>)}</div>
      {activeTopic ? <article className="help-topic-card"><div className="help-topic-heading"><span className="help-topic-icon">{activeTopic.icon}</span><div><p className="eyebrow">{activeTopic.label}</p><h4>{activeTopic.title}</h4><p>{activeTopic.summary}</p></div></div><ol className="help-steps">{activeTopic.steps.map((step, index) => <li key={step}><b>{index + 1}</b><span>{step}</span></li>)}</ol><button type="button" className="help-open-action" onClick={() => openHelpAction(activeTopic)}>{activeTopic.actionLabel}<span>→</span></button></article> : <div className="help-empty"><strong>Aramana uygun konu yok</strong><small>Başka bir kelime dene veya tüm konuları görmek için aramayı temizle.</small></div>}
      <section className="help-section"><div className="help-section-heading"><div><strong>Kısayollar</strong><small>Kurgu akışını klavyeden hızlandır.</small></div><button type="button" onClick={onOpenSettings}>Ayarları aç</button></div><div className="help-shortcut-grid">{(Object.keys(SHORTCUT_LABELS) as ShortcutAction[]).map((action) => <div className="help-shortcut" key={action}><kbd>{shortcutValue(currentSettings, action)}</kbd><span><strong>{SHORTCUT_LABELS[action].label}</strong><small>{SHORTCUT_LABELS[action].description}</small></span></div>)}</div></section>
      <section className="help-section"><div className="help-section-heading"><div><strong>Hızlı ipuçları</strong><small>Bir sonraki hamleni seç.</small></div></div><div className="help-tip-grid"><button type="button" className="help-tip-card" onClick={() => { setNotice('Canvas üzerindeki metin veya medyaya tıklayın; seçim timeline ve Inspector’da da eşleşir.'); setPanel('text'); }}><span>⌖</span><strong>Canvas’tan seç</strong><small>Metne tıklayınca doğru klip açılır.</small></button><button type="button" className="help-tip-card" onClick={() => setPanel('animation')}><span>↝</span><strong>Hareket ekle</strong><small>Giriş, çıkış ve easing’i birlikte ayarla.</small></button><button type="button" className="help-tip-card" onClick={() => setPanel('media')}><span>▧</span><strong>Şekil ekle</strong><small>Media içindeki Şekiller sekmesini kullan.</small></button></div></section>
      <p className="panel-note">Export öncesi timeline’da en az bir medya veya metin klibi olduğundan emin olun.</p>
    </div>;
  }
  if (panel === 'project') return <div className="quick-panel project-tools-panel">
    <ProjectBackupPanel backups={backups} onRestore={restoreBackup} />
    <div className="text-library-head"><div><strong>Proje araçları</strong><small>Canvas, arka plan ve genel çalışma tercihleri.</small></div><span>⌘</span></div>
    <div className="project-tool-card"><div><strong>Canvas arka planı</strong><small>Boş alanların ve export zeminlerinin rengi</small></div><input type="color" value={project?.canvas.background?.slice(0, 7) === 'transpa' ? '#101116' : project?.canvas.background ?? '#101116'} onChange={(event) => mutateProject((draft) => { draft.canvas.background = event.target.value; })} /></div>
    <div className="project-background-grid"><button onClick={() => mutateProject((draft) => { draft.canvas.background = '#101116'; })}>Siyah</button><button onClick={() => mutateProject((draft) => { draft.canvas.background = '#f3f4f1'; })}>Beyaz</button><button onClick={() => mutateProject((draft) => { draft.canvas.background = '#7b8088'; })}>Gri</button><button onClick={() => mutateProject((draft) => { draft.canvas.background = 'transparent'; })}>Şeffaf</button></div>
    <div className="project-tool-list"><button onClick={() => setNotice('Timeline klipleri artık medya importundan bağımsız korunuyor. Snap ve marker araçlarını alttaki timeline çubuğundan kullanabilirsiniz.')}>⌁ Timeline rehberi <span>›</span></button><button onClick={onOpenSettings}>⚙ Çalışma alanı ayarları <span>›</span></button></div>
  </div>;
  if (panel === 'captions') return <div className="quick-panel">
    <div className="text-library-head"><div><strong>Altyazı merkezi</strong><small>SRT/VTT içe aktarın veya seçili klibe altyazı ekleyin.</small></div><span>CC</span></div>
    <input ref={subtitleFileRef} className="hidden-input" type="file" accept=".srt,.vtt,text/vtt" onChange={(event) => { const file = event.target.files?.[0]; if (file) importSubtitles(file); event.target.value = ''; }} />
    <button className="import-zone compact" onClick={() => subtitleFileRef.current?.click()}><span className="import-icon">＋</span><strong>SRT / VTT içe aktar</strong><small>Zaman kodları otomatik korunur</small></button>
    <div className="feature-card-grid"><button className="feature-card" onClick={() => setNotice('Otomatik altyazı için yerel Whisper bağlantısı bir sonraki render motoru paketinde etkinleştirilecek.')}><span className="feature-card-icon">✦</span><strong>Otomatik altyazı</strong><small>Yerel ve onaylı ses analizi</small></button><button className="feature-card" onClick={exportSubtitles}><span className="feature-card-icon">↓</span><strong>SRT dışa aktar</strong><small>Timeline altyazılarını indir</small></button></div>
  </div>;
  if (panel === 'transitions' || panel === 'animation') return <AnimationStudio />;
  if (panel === 'color') return <div className="quick-panel">
    <div className="text-library-head"><div><strong>Renk ve filtre</strong><small>Hazır görünümlerle başlayın, Inspector’da ince ayar yapın.</small></div><span>6</span></div>
    <div className="effect-grid"><button onClick={() => onApplyEffect('film')}>◌<small>Film</small></button><button onClick={() => onApplyEffect('retro')}>◍<small>Retro</small></button><button onClick={() => onApplyEffect('glow')}>◈<small>Glow</small></button><button onClick={() => onApplyEffect('blur')}>◇<small>Yumuşat</small></button><button onClick={() => onApplyEffect('noise')}>◒<small>Mono</small></button><button onClick={() => onApplyEffect('chroma')}>⌁<small>Chroma</small></button></div>
    <p className="panel-note">Seçili klip yoksa önce timeline’dan bir klip seçin.</p>
  </div>;
  if (panel === 'text') {
    const quickStarts = ['clean-title', 'lower-third', 'quote'].map((id) => TEXT_PRESETS.find((preset) => preset.id === id) ?? TEXT_PRESETS[0]);
    return <div className="quick-panel text-library text-studio">
      <div className="text-studio-heading"><div><p className="eyebrow">Metin stüdyosu</p><h3>Hikâyene bir katman ekle</h3><small>Önizle, ekle ve sonra sağdaki Inspector’da kendi cümlene dönüştür.</small></div><span className="text-studio-mark">Aa</span></div>
      <button className="text-primary-action" onClick={() => onAddText(TEXT_PRESETS[0])}><span>＋</span><div><strong>Boş metin ekle</strong><small>Her şeyi sen yaz, stilini sonra seç</small></div><b>↗</b></button>
      <div className="text-section-label"><span>Hızlı başlangıç</span><small>Tek tıkla yerleştir</small></div>
      <div className="text-quick-starts">{quickStarts.map((preset) => <button key={preset.id} className={`text-quick-card text-quick-${preset.id}`} onClick={() => onAddText(preset)}><span style={{ fontFamily: preset.fontFamily, fontWeight: preset.fontWeight, fontStyle: preset.fontStyle }}>{preset.text}</span><strong>{preset.label}</strong><small>{preset.description}</small><i>＋</i></button>)}</div>
      <div className="text-library-head text-library-section-head"><div><strong>Stil kitaplığı</strong><small>İçeriği sonra Inspector’da düzenleyebilirsin.</small></div><span>{filteredTextPresets.length}</span></div>
      <input className="media-search text-search" value={textSearch} onChange={(event) => setTextSearch(event.target.value)} placeholder="Stil veya metin ara…" aria-label="Metin stili ara" />
      <div className="text-category-chips">{(['Tümü', 'Başlık', 'Sosyal', 'Altyazı', 'Kart', 'Vurgu'] as const).map((category) => <button key={category} className={textCategory === category ? 'active' : ''} onClick={() => setTextCategory(category)}>{category}</button>)}</div>
      <div className="text-preset-grid">{filteredTextPresets.map((preset) => <button key={preset.id} className="text-preset-card" onClick={() => onAddText(preset)}><span className="text-preset-sample" style={{ fontFamily: preset.fontFamily, fontSize: `${Math.max(18, preset.fontSize / 2.75)}px`, fontWeight: preset.fontWeight, fontStyle: preset.fontStyle, color: preset.color, background: preset.background, textAlign: preset.align, lineHeight: 1.05, WebkitTextStroke: `${Math.min(1.5, preset.strokeWidth / 2)}px ${preset.stroke}` }}>{preset.text}</span><span className="text-preset-meta"><strong>{preset.label}</strong><small>{preset.category} · {preset.description}</small></span><i aria-hidden="true">＋</i></button>)}</div>
      <div className="text-studio-tip"><span>✦</span><p><strong>İpucu</strong><small>Metni ekledikten sonra Inspector’daki Animasyon sekmesinden Fade, Kaydır veya Yakınlaş seçebilirsin. Yeni metinler varsayılan olarak animasyonsuz gelir.</small></p></div>
    </div>;
  }
  return <div className="quick-panel"><button className="experimental-card" onClick={onOpenSettings}><span>✦</span><div><strong>Experimental AI</strong><small>Kurgu yardımcısı ayarlardan açılır</small></div><span className="toggle off" /></button><div className="effect-grid"><button onClick={() => onApplyEffect('film')}>◌<small>Film</small></button><button onClick={() => onApplyEffect('retro')}>◍<small>Retro</small></button><button onClick={() => onApplyEffect('glow')}>◈<small>Glow</small></button><button onClick={() => onApplyEffect('blur')}>◇<small>Blur</small></button><button onClick={() => onApplyEffect('chroma')}>⌁<small>Chroma</small></button><button onClick={() => onApplyEffect('noise')}>◒<small>Noise</small></button></div><p className="panel-note">Bir klip seçip preset’e tıkla.</p></div>;
}

function AnimationStudio() {
  const project = useEditor((state) => state.project);
  const selectedClipId = useEditor((state) => state.selectedClipId);
  const selectedClipIds = useEditor((state) => state.selectedClipIds);
  const mutateProject = useEditor((state) => state.mutateProject);
  const setNotice = useEditor((state) => state.setNotice);
  const [mode, setMode] = useState<AnimationApplyMode>('both');
  const [category, setCategory] = useState<AnimationCategory>('Tümü');
  const [inDuration, setInDuration] = useState(0.4);
  const [outDuration, setOutDuration] = useState(0.4);
  const [linkDurations, setLinkDurations] = useState(true);
  const [easing, setEasing] = useState<TransitionEasing>('ease-in-out');
  const [direction, setDirection] = useState<TransitionDirection>('left');
  const [intensity, setIntensity] = useState(1);
  const [activePresetId, setActivePresetId] = useState('fade');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const selected = project?.tracks.flatMap((track) => track.clips).find((clip) => clip.id === selectedClipId);
  const visiblePresets = category === 'Tümü' ? ANIMATION_PRESETS : ANIMATION_PRESETS.filter((preset) => preset.category === category);
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
    const current = ANIMATION_PRESETS.find((preset) => preset.type === (incoming.type ?? 'none') && (preset.type !== 'slide' || preset.motionDirection === (incoming.direction ?? 'left')));
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
      setNotice('Önce timeline’dan bir klip seç; animasyon seçimi o klibe uygulanır.');
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
    setNotice(`${preset.label} ${mode === 'both' ? 'giriş ve çıkışa' : mode === 'in' ? 'girişe' : 'çıkışa'} uygulandı.`);
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

  return <div className="quick-panel animation-studio">
    <div className="animation-studio-heading"><div><p className="eyebrow">Hareket stüdyosu</p><h3>Giriş ve çıkışı birlikte tasarla</h3><small>Bir kart seç; sonra süre, yön ve yumuşatmayı ince ayarla.</small></div><span className="animation-studio-mark">✧</span></div>
    <div className="animation-target-row"><span className={selected ? 'target-dot ready' : 'target-dot'} />{selected ? <><strong>{selected.name}</strong><small>{selectedIds.length > 1 ? `${selectedIds.length} klip seçili` : 'Seçili klip'}</small></> : <><strong>Klip seçilmedi</strong><small>Önce timeline’dan bir klip seç</small></>}</div>
    <div className="animation-section-label"><strong>Uygulama alanı</strong><small>Hangi bölüme yazacağını seç</small></div>
    <div className="animation-mode-tabs" role="tablist" aria-label="Animasyon bölümü">{([['both', 'Giriş + çıkış'], ['in', 'Yalnız giriş'], ['out', 'Yalnız çıkış']] as const).map(([value, label]) => <button key={value} role="tab" aria-selected={mode === value} className={mode === value ? 'active' : ''} onClick={() => setMode(value)}>{label}</button>)}</div>
    <div className="animation-duration-grid">
      <label><span>Giriş süresi</span><strong>{inDuration.toFixed(2)} sn</strong><input type="range" min="0" max="1.5" step="0.05" value={inDuration} disabled={!selectedIds.length} onChange={(event) => changeInDuration(Number(event.target.value))} aria-label="Giriş animasyonu süresi" /></label>
      <label><span>Çıkış süresi</span><strong>{outDuration.toFixed(2)} sn</strong><input type="range" min="0" max="1.5" step="0.05" value={outDuration} disabled={!selectedIds.length} onChange={(event) => changeOutDuration(Number(event.target.value))} aria-label="Çıkış animasyonu süresi" /></label>
    </div>
    <div className="animation-section-label"><strong>Hareket seç</strong><small>{visiblePresets.length} hazır davranış</small></div>
    <div className="animation-category-tabs" role="tablist" aria-label="Animasyon kategorileri">{(['Tümü', 'Kesme', 'Yumuşak', 'Hareket', 'Odak'] as const).map((value) => <button key={value} role="tab" aria-selected={category === value} className={category === value ? 'active' : ''} onClick={() => setCategory(value)}>{value}</button>)}</div>
    <div className="animation-card-grid">{visiblePresets.map((preset) => <button key={preset.id} className={`animation-card ${isActive(preset) ? 'active' : ''}`} aria-pressed={isActive(preset)} onClick={() => { setActivePresetId(preset.id); setDirection(preset.motionDirection); apply(preset, preset.motionDirection); }}><span className={`animation-card-visual animation-visual-${preset.type} animation-visual-${preset.id}`}><i /></span><span className="animation-card-copy"><strong>{preset.label}</strong><small>{preset.description}</small><em>{preset.directionLabel}</em></span><b>{isActive(preset) ? '✓' : '＋'}</b></button>)}</div>
    <button className={`animation-advanced-toggle ${showAdvanced ? 'active' : ''}`} onClick={() => setShowAdvanced((value) => !value)} aria-expanded={showAdvanced}><span><strong>Gelişmiş hareket</strong><small>Yön, yumuşatma, yoğunluk ve süre bağlantısı</small></span><b>{showAdvanced ? '⌃' : '⌄'}</b></button>
    {showAdvanced && <div className="animation-advanced">
      <label><span>Yön</span><select value={direction} onChange={(event) => setDirection(event.target.value as TransitionDirection)}><option value="left">Soldan</option><option value="right">Sağdan</option><option value="up">Yukarıdan</option><option value="down">Aşağıdan</option><option value="center">Merkezden</option></select></label>
       <label><span>Yumuşatma</span><select value={easing} onChange={(event) => setEasing(event.target.value as TransitionEasing)}><option value="linear">Doğrusal</option><option value="ease-in">Yavaş başla</option><option value="ease-out">Yavaş bitir</option><option value="ease-in-out">Yumuşak giriş/çıkış</option></select></label>
      <label className="animation-intensity"><span>Yoğunluk <b>{Math.round(intensity * 100)}%</b></span><input type="range" min="0.1" max="2" step="0.05" value={intensity} onChange={(event) => setIntensity(Number(event.target.value))} /></label>
      <label className="animation-link-toggle"><input type="checkbox" checked={linkDurations} onChange={(event) => setLinkDurations(event.target.checked)} /><span>Giriş ve çıkış süresini birlikte ayarla</span></label>
      <button className="animation-apply-button" onClick={applyAdvanced}>Gelişmiş ayarları uygula</button>
    </div>}
    <div className="animation-footer"><button onClick={() => setNotice('Keyframe için playhead’i taşı ve sağ Inspector’daki Animasyon sekmesinden özellik düğmesine bas.')}>◇ Keyframe</button><small>Animasyon seçmek klibin giriş/çıkış davranışını günceller; dışa aktarmada gelişmiş geçişler fade yaklaşımıyla işlenebilir.</small></div>
  </div>;
}

function ProjectBackupPanel({ backups, onRestore }: { backups: BackupSummary[]; onRestore: (fileName: string) => void }) {
  const language = useEditor((state) => state.settings?.language ?? 'en');
  return <section className="project-backup-panel">
    <div className="project-backup-heading"><div><strong>Geri yükleme noktaları</strong><small>Son kayıtların güvenli kopyaları</small></div><span>{backups.length}</span></div>
    {backups.length === 0 ? <p className="project-backup-empty">Henüz yedek oluşturulmadı. Proje kaydedildikçe burada görünür.</p> : <div className="project-backup-list">{backups.slice(0, 5).map((backup) => <div className="project-backup-item" key={backup.fileName}><div><strong>{new Date(backup.createdAt).toLocaleString(language === 'tr' ? 'tr-TR' : 'en-US', { dateStyle: 'short', timeStyle: 'short' })}</strong><small>{Math.max(1, Math.round(backup.size / 1024))} KB</small></div><button type="button" onClick={() => onRestore(backup.fileName)}>Geri yükle</button></div>)}</div>}
  </section>;
}

function AssetPanelPro({ onImport, onOpenSettings }: { onImport: (file: File) => void; onOpenSettings: () => void }) {
  const panel = useEditor((state) => state.panel);
  const project = useEditor((state) => state.project)!;
  const currentTime = useEditor((state) => state.currentTime);
  const language = useEditor((state) => state.settings?.language ?? 'en');
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
  const closeMenu = () => setMenu(null);
  const usageCount = (assetId: string) => project.tracks.reduce((count, track) => count + track.clips.filter((clip) => clip.assetId === assetId).length, 0);
  const visibleAssets = useMemo(() => project.assets.filter((asset) => {
    const query = search.trim().toLocaleLowerCase('tr-TR');
    const matchesType = filter === 'all' || (filter === 'unused' ? usageCount(asset.id) === 0 : asset.type === filter);
    return (!query || `${asset.name} ${asset.mimeType}`.toLocaleLowerCase('tr-TR').includes(query)) && matchesType;
  }).sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name, 'tr') : sort === 'duration' ? b.duration - a.duration : b.createdAt.localeCompare(a.createdAt)), [filter, project.assets, project.tracks, search, sort]);
  const hasFilePayload = (event: React.DragEvent) => Array.from(event.dataTransfer.types).includes('Files');
  const importDroppedFiles = async (files: File[]) => {
    const supported = files.filter((file) => /^(video|audio|image)\//.test(file.type));
    if (!supported.length) {
      setNotice('Video, ses veya görsel dosyası bırakın.');
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
        track = { id: trackId, type: 'layer', name: `Layer ${draft.tracks.length + 1}`, order: draft.tracks.length, clips: [], locked: false, hidden: false, muted: false };
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
      setNotice(`“${stock.name}” kütüphaneye eklendi ve timeline’a yerleştirildi.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Stok medya eklenemedi');
    } finally {
      setStockBusyId(null);
    }
  };
  const removeAsset = (asset: Asset) => {
    if (!window.confirm('Bu medya ve timeline kullanımları projeden kaldırılacak. Devam edilsin mi?')) { closeMenu(); return; }
    mutateProject((draft) => { draft.assets = draft.assets.filter((item) => item.id !== asset.id); for (const track of draft.tracks) track.clips = track.clips.filter((clip) => clip.assetId !== asset.id); draft.duration = projectDuration(draft); });
    closeMenu();
  };
  const showInfo = (asset: Asset) => { setNotice(`${asset.name} · ${asset.mimeType} · ${asset.duration ? formatTime(asset.duration) : 'süre yok'} · ${asset.size.toLocaleString(language === 'tr' ? 'tr-TR' : 'en-US')} bayt`); closeMenu(); };
  const title = panelTitle(panel);
  const panelMenuItems: ContextMenuItem[] = [
    { label: 'Dosya içe aktar', icon: '+', onSelect: () => fileRef.current?.click() },
    { label: 'Kütüphaneyi yenile', icon: '↻', onSelect: () => { void api<Project>(`/api/projects/${project.id}`).then((fresh) => { const local = useEditor.getState().project; if (local) useEditor.getState().setProject(mergeImportedProject(local, fresh), false); }); } },
    { label: 'Panel ayarları', icon: '⚙', onSelect: onOpenSettings },
  ];
  const assetMenuItems = (asset: Asset): ContextMenuItem[] => [
    { label: 'Timeline’a ekle', icon: '+', shortcut: 'Enter', onSelect: () => addAsset(asset) },
    { label: 'Adı kopyala', icon: '⧉', onSelect: () => { void navigator.clipboard?.writeText(asset.name); closeMenu(); } },
    { label: 'Medya bilgisi', icon: 'i', onSelect: () => showInfo(asset) },
    { label: 'Kullanımları göster', icon: '⌁', onSelect: () => setNotice(`${usageCount(asset.id)} timeline klibinde kullanılıyor`) },
    { label: 'Projeden kaldır', icon: '×', danger: true, onSelect: () => removeAsset(asset) },
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
    if (!selected.length) { setNotice('Önce timeline üzerinde bir klip seçin.'); return; }
    mutateProject((draft) => { for (const clip of draft.tracks.flatMap((track) => track.clips)) { if (!selected.includes(clip.id)) continue; if (preset === 'film') { clip.filters.brightness = -0.05; clip.filters.contrast = 0.12; clip.filters.saturation = -0.1; } if (preset === 'retro') { clip.filters.saturation = -0.22; } if (preset === 'glow') clip.filters.blur = 1.5; if (preset === 'blur') clip.filters.blur = 8; if (preset === 'chroma') clip.filters.chromaKey = { color: '#00ff00', similarity: 0.35, blend: 0.1 }; if (preset === 'noise') clip.filters.grayscale = 0.08; } });
  };
  const applyTransition = (preset: TransitionPreset) => {
    const selected = selectedClipIds.length ? selectedClipIds : useEditor.getState().selectedClipId ? [useEditor.getState().selectedClipId!] : [];
    if (!selected.length) { setNotice('Önce timeline üzerinde bir klip seçin.'); return; }
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
      <div className="panel-heading"><div><p className="eyebrow">Kütüphane</p><h2>Medya</h2></div><button className="panel-more" aria-label="Panel menüsü" onClick={(event) => { event.stopPropagation(); setMenu({ x: event.clientX, y: event.clientY, panel: true }); }}>•••</button></div>
      <div className="media-source-tabs" role="tablist" aria-label="Medya kaynakları">
        <button role="tab" aria-selected={mediaSection === 'project'} className={mediaSection === 'project' ? 'active' : ''} onClick={() => setMediaSection('project')}><span className="media-source-tab-icon">▧</span><span className="media-source-tab-label">Medya</span><small>{project.assets.length}</small></button>
        <button role="tab" aria-selected={mediaSection === 'stock'} className={mediaSection === 'stock' ? 'active' : ''} onClick={() => setMediaSection('stock')}><span className="media-source-tab-icon">✦</span><span className="media-source-tab-label">Stok</span><small>{STOCK_MEDIA.length}</small></button>
        <button role="tab" aria-selected={mediaSection === 'shapes'} className={mediaSection === 'shapes' ? 'active' : ''} onClick={() => setMediaSection('shapes')}><span className="media-source-tab-icon">◇</span><span className="media-source-tab-label">Şekiller</span><small>{SHAPE_PRESETS.length}</small></button>
      </div>
      {mediaSection !== 'project' && <p className="media-source-copy">{mediaSection === 'stock' ? 'Hazır arka planları ve yüzeyleri seç, tek tıkla boş bir alana ekle.' : 'Basit vurguları ve metin şekillerini hızlıca timeline’a ekle.'}</p>}
      <input ref={fileRef} className="hidden-input" type="file" accept="video/*,audio/*,image/*" onChange={(event) => { const file = event.target.files?.[0]; if (file) onImport(file); event.target.value = ''; }} />
      {mediaSection === 'project' && <>
        <div className="media-library-summary"><div><span className="media-section-kicker">PROJE MEDYASI</span><strong>{`${project.assets.length} dosya`}</strong></div><button type="button" className="media-import-button" onClick={() => fileRef.current?.click()} aria-label="Medya ekle" title="Medya ekle">＋</button></div>
        <div className="media-controls">
          <div className="media-search-field"><span aria-hidden="true">⌕</span><input className="media-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Medya ara…" aria-label="Medya ara" />{search && <button type="button" className="media-search-clear" aria-label="Aramayı temizle" onClick={() => setSearch('')}>×</button>}</div>
          <div className="media-controls-row"><select className="media-filter-select" value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)} aria-label="Medya filtresi"><option value="all">Tüm medya</option><option value="video">Video</option><option value="audio">Ses</option><option value="image">Görsel</option><option value="unused">Kullanılmayan</option></select><select className="media-sort-select" value={sort} onChange={(event) => setSort(event.target.value as typeof sort)} aria-label="Medya sıralama"><option value="date">Son eklenen</option><option value="name">Ada göre</option><option value="duration">Süreye göre</option></select><div className="media-view-toggle"><button className={view === 'list' ? 'active' : ''} onClick={() => setView('list')} title="Liste görünümü" aria-label="Liste görünümü">☰</button><button className={view === 'grid' ? 'active' : ''} onClick={() => setView('grid')} title="Kart görünümü" aria-label="Kart görünümü">▦</button></div></div>
        </div>
        <div className="media-list-heading"><span>{`${visibleAssets.length} sonuç`}</span><span>{view === 'list' ? 'Liste' : 'Kart'}</span></div>
        <div className={`asset-list ${view === 'grid' ? 'asset-grid-view' : ''} ${isDropActive ? 'is-drop-active' : ''}`} role="region" aria-label="Medya dosyalarını bırakma alanı" onDragEnter={handleMediaDragEnter} onDragOver={handleMediaDragOver} onDragLeave={handleMediaDragLeave} onDrop={handleMediaDrop}>{visibleAssets.length === 0 ? <div className="panel-empty"><span>⊘</span><p>Medya bulunamadı</p><small>Arama veya filtreyi değiştir</small></div> : visibleAssets.map((asset) => <AssetCardPro key={asset.id} projectId={project.id} asset={asset} usage={usageCount(asset.id)} view={view} onAdd={() => addAsset(asset)} onOpenMenu={(event) => { event.stopPropagation(); setMenu({ x: event.clientX, y: event.clientY, asset }); }} />)}{isDropActive && <div className="media-drop-overlay" aria-live="polite"><span>＋</span><strong>Dosyaları buraya bırak</strong><small>Video, ses veya görsel</small></div>}</div>
      </>}
      {mediaSection === 'stock' && <StockMediaShelf busyId={stockBusyId} onAdd={(stock) => void addStock(stock)} />}
      {mediaSection === 'shapes' && <ShapeShelf onAdd={addTextClip} />}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.panel ? panelMenuItems : menu.asset ? assetMenuItems(menu.asset) : []} onClose={closeMenu} />}
    </aside>;
  }
  return <aside className="asset-panel asset-panel-pro">
    <div className="panel-heading"><div><p className="eyebrow">Kütüphane</p><h2>{title}</h2></div><button className="panel-more" aria-label="Panel menüsü" onClick={(event) => { event.stopPropagation(); setMenu({ x: event.clientX, y: event.clientY, panel: true }); }}>•••</button></div>
    {false ? <><button className="import-zone" onClick={() => fileRef.current?.click()}><span className="import-icon">＋</span><strong>Medya içe aktar</strong><small>Video, ses veya görsel seç</small></button><p className="media-panel-hint">Sürükle, çift tıkla veya karttaki <b>Ekle</b> düğmesine bas.</p><input ref={fileRef} className="hidden-input" type="file" accept="video/*,audio/*,image/*" onChange={(event) => { const file = event.target.files?.[0]; if (file) onImport(file); event.target.value = ''; }} /><StockMediaShelf busyId={stockBusyId} onAdd={(stock) => void addStock(stock)} /><div className="media-toolbar"><input className="media-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Medya ara…" aria-label="Medya ara" /><select value={sort} onChange={(event) => setSort(event.target.value as typeof sort)} aria-label="Medya sıralama"><option value="date">Son eklenen</option><option value="name">Ada göre</option><option value="duration">Süreye göre</option></select><div className="media-view-toggle"><button className={view === 'list' ? 'active' : ''} onClick={() => setView('list')} title="Liste görünümü">☰</button><button className={view === 'grid' ? 'active' : ''} onClick={() => setView('grid')} title="Grid görünümü">▦</button></div></div><div className="media-filter-chips">{(['all', 'video', 'audio', 'image', 'unused'] as const).map((value) => <button key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{value === 'all' ? 'Tümü' : value === 'video' ? 'Video' : value === 'audio' ? 'Ses' : value === 'image' ? 'Görsel' : 'Kullanılmayan'}</button>)}</div><div className="asset-filter"><span>{visibleAssets.length} medya</span><span>{filter === 'all' ? 'Tümü' : filter === 'unused' ? 'Kullanılmayan' : filter}</span></div><div className={`asset-list ${view === 'grid' ? 'asset-grid-view' : ''}`}>{visibleAssets.length === 0 ? <div className="panel-empty"><span>⊘</span><p>Medya bulunamadı</p><small>Arama veya filtreyi değiştir</small></div> : visibleAssets.map((asset) => <AssetCardPro key={asset.id} projectId={project.id} asset={asset} usage={usageCount(asset.id)} view={view} onAdd={() => addAsset(asset)} onOpenMenu={(event) => { event.stopPropagation(); setMenu({ x: event.clientX, y: event.clientY, asset }); }} />)}</div><ShapeShelf onAdd={addTextClip} /></> : <PanelContent panel={panel} onAddText={addTextClip} onImport={onImport} onApplyEffect={applyEffect} onApplyTransition={applyTransition} onOpenSettings={onOpenSettings} />}
    {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.panel ? panelMenuItems : menu.asset ? assetMenuItems(menu.asset) : []} onClose={closeMenu} />}
  </aside>;
}

function StockMediaShelf({ busyId, onAdd }: { busyId: string | null; onAdd: (stock: StockMediaItem) => void }) {
  const [category, setCategory] = useState<'all' | StockMediaItem['category']>('all');
  const visible = category === 'all' ? STOCK_MEDIA : STOCK_MEDIA.filter((stock) => stock.category === category);
  return <section className="stock-media-shelf" aria-label="Stok medya"><div className="stock-shelf-heading"><div><strong>Stok yüzeyler</strong><small>Renk, atmosfer ve dokuya göre seç</small></div><span>{STOCK_MEDIA.length}</span></div><div className="stock-category-tabs">{([['all', 'Tümü'], ['solid', 'Düz'], ['soft', 'Yumuşak'], ['texture', 'Doku']] as const).map(([value, label]) => <button key={value} className={category === value ? 'active' : ''} onClick={() => setCategory(value)}>{label}</button>)}</div><div className="stock-media-grid">{visible.map((stock) => <button key={stock.id} className="stock-media-card" onClick={() => onAdd(stock)} disabled={busyId !== null} aria-label={`${stock.name} stok medyayı ekle`}><span className={`stock-preview stock-${stock.id}`}><img src={`/api/stock/${stock.id}`} alt="" /></span><span><strong>{busyId === stock.id ? 'Ekleniyor…' : stock.name}</strong><small>{stock.description}</small></span><b>＋</b></button>)}</div></section>;
}

function ShapeShelf({ onAdd }: { onAdd: (preset: TextPreset) => void }) {
  const [category, setCategory] = useState<ShapePreset['category'] | 'Tümü'>('Tümü');
  const visibleShapes = category === 'Tümü' ? SHAPE_PRESETS : SHAPE_PRESETS.filter((shape) => shape.category === category);
  return <section className="shape-shelf" aria-label="Şekiller">
    <div className="stock-shelf-heading"><div><strong>Şekil stüdyosu</strong><small>Bir vurgu seç, timeline’a ekle</small></div><span>{SHAPE_PRESETS.length}</span></div>
    <div className="shape-category-tabs" role="tablist" aria-label="Şekil kategorileri">
      {(['Tümü', 'Temel', 'Oklar', 'Semboller', 'Rozet'] as const).map((value) => <button key={value} role="tab" aria-selected={category === value} className={category === value ? 'active' : ''} onClick={() => setCategory(value)}>{value}</button>)}
    </div>
    <div className="shape-shelf-grid">{visibleShapes.map((shape) => <button key={shape.id} className="shape-card" onClick={() => onAdd({ ...TEXT_PRESETS[0], id: `shape-${shape.id}-${Date.now()}`, label: `${shape.label} vurgu`, text: shape.glyph, fontSize: 120, color: shape.color, background: 'transparent' })} aria-label={`${shape.label} şeklini timeline'a ekle`}><b style={{ color: shape.color }}>{shape.glyph}</b><span><strong>{shape.label}</strong><small>{shape.description}</small></span><i>＋</i></button>)}</div>
  </section>;
}

function AssetCardPro({ projectId, asset, usage, view, onAdd, onOpenMenu }: { projectId: string; asset: Asset; usage: number; view: 'list' | 'grid'; onAdd: () => void; onOpenMenu: (event: React.MouseEvent<HTMLButtonElement>) => void }) {
  const [previewFailed, setPreviewFailed] = useState(false);
  const icon = asset.type === 'video' ? '▶' : asset.type === 'audio' ? '♫' : '▧';
  const meta = asset.duration ? formatTime(asset.duration) : asset.mimeType.split('/')[1]?.toUpperCase() || 'MEDIA';
  const assetDetails = `${asset.width && asset.height ? `${asset.width} × ${asset.height}` : asset.type}${usage > 0 ? ` · ${usage} kullanım` : ' · Kullanılmadı'}`;
  const mediaUrl = `/api/projects/${projectId}/media/${asset.id}`;
  const preview = !previewFailed && asset.type === 'image' ? <img src={mediaUrl} alt="" onError={() => setPreviewFailed(true)} /> : !previewFailed && asset.type === 'video' ? <video src={mediaUrl} poster={asset.thumbnailPath ? `${mediaUrl}?thumbnail=1` : undefined} muted preload="metadata" onError={() => setPreviewFailed(true)} /> : null;
  return <div className={`asset-item pro ${view === 'grid' ? 'grid-card' : ''}`} draggable onPointerDown={(event) => { if (!(event.target as HTMLElement).closest('button')) useEditor.getState().setAssetDragId(asset.id); }} onPointerUp={() => useEditor.getState().setAssetDragId(null)} onPointerCancel={() => useEditor.getState().setAssetDragId(null)} onDragStart={(event) => { event.dataTransfer.effectAllowed = 'copy'; event.dataTransfer.setData('application/x-cutloc-asset', JSON.stringify({ assetId: asset.id })); useEditor.getState().setAssetDragId(asset.id); }} onDragEnd={() => useEditor.getState().setAssetDragId(null)} onDoubleClick={onAdd} onContextMenu={(event) => { event.preventDefault(); onOpenMenu(event as unknown as React.MouseEvent<HTMLButtonElement>); }}><div className={`asset-thumb ${asset.type} ${preview ? 'has-preview' : ''}`}><span className="asset-thumb-fallback">{icon}</span>{preview}<small>{meta}</small></div><div className="asset-info"><strong title={asset.name}>{asset.name}</strong><small>{assetDetails}</small></div><button className="asset-add-button" onClick={(event) => { event.stopPropagation(); onAdd(); }} aria-label={`${asset.name} timeline'a ekle`}>＋ <span>Ekle</span></button><button className="asset-dots" aria-label={`${asset.name} menüsü`} onClick={onOpenMenu}>•••</button></div>;
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
  category: 'Başlık' | 'Sosyal' | 'Altyazı' | 'Kart' | 'Vurgu';
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
  { id: 'clean-title', label: 'Temiz başlık', category: 'Başlık', description: 'Video açılışları için net', text: 'Yeni başlık', fontFamily: 'Segoe UI, Arial, sans-serif', fontSize: 72, fontWeight: 750, fontStyle: 'normal', color: '#ffffff', background: 'transparent', stroke: 'transparent', strokeWidth: 0, shadow: true, align: 'center' },
  { id: 'editorial', label: 'Editoryal', category: 'Başlık', description: 'Zarif ve okunaklı serif', text: 'Bir hikâye başlıyor', fontFamily: 'Georgia, serif', fontSize: 62, fontWeight: 700, fontStyle: 'normal', color: '#fff8e8', background: 'transparent', stroke: 'transparent', strokeWidth: 0, shadow: true, align: 'center', letterSpacing: 1 },
  { id: 'social-hook', label: 'Sosyal kanca', category: 'Sosyal', description: 'Kısa, güçlü, yüksek kontrast', text: 'Bunu mutlaka gör!', fontFamily: 'Arial, sans-serif', fontSize: 58, fontWeight: 800, fontStyle: 'normal', color: '#ffffff', background: '#243dff', stroke: 'transparent', strokeWidth: 0, shadow: true, align: 'center' },
  { id: 'lower-third', label: 'Alt bilgi', category: 'Sosyal', description: 'İsim ve konum bilgisi', text: 'Hakan · CutLoc', fontFamily: 'DM Sans, Arial, sans-serif', fontSize: 34, fontWeight: 600, fontStyle: 'normal', color: '#ffffff', background: '#101116dd', stroke: 'transparent', strokeWidth: 0, shadow: false, align: 'left' },
  { id: 'caption', label: 'Okunaklı altyazı', category: 'Altyazı', description: 'Uzun konuşmalar için rahat', text: 'Buraya altyazı yazın.', fontFamily: 'Arial, sans-serif', fontSize: 40, fontWeight: 600, fontStyle: 'normal', color: '#ffffff', background: '#101116dd', stroke: 'transparent', strokeWidth: 0, shadow: false, align: 'center' },
  { id: 'caption-box', label: 'Altyazı kutusu', category: 'Altyazı', description: 'Kontrastı yüksek kutulu stil', text: 'Net ve erişilebilir metin', fontFamily: 'Verdana, sans-serif', fontSize: 34, fontWeight: 700, fontStyle: 'normal', color: '#101116', background: '#f5f7f2', stroke: 'transparent', strokeWidth: 0, shadow: false, align: 'center' },
  { id: 'quote', label: 'Alıntı', category: 'Kart', description: 'Duygusal ve sakin görünüm', text: 'Bir anı yakala.', fontFamily: 'Georgia, serif', fontSize: 52, fontWeight: 600, fontStyle: 'italic', color: '#ffffff', background: '#101116bb', stroke: 'transparent', strokeWidth: 0, shadow: true, align: 'center' },
  { id: 'info-card', label: 'Bilgi kartı', category: 'Kart', description: 'İpuçları ve açıklamalar', text: 'İpucu · Zaman çizelgesini deneyin', fontFamily: 'Segoe UI, Arial, sans-serif', fontSize: 32, fontWeight: 600, fontStyle: 'normal', color: '#102018', background: '#b7f36a', stroke: 'transparent', strokeWidth: 0, shadow: false, align: 'left' },
  { id: 'outline', label: 'Konturlu', category: 'Vurgu', description: 'Görüntü üstünde güçlü vurgu', text: 'Öne çıkar', fontFamily: 'Arial, sans-serif', fontSize: 68, fontWeight: 800, fontStyle: 'normal', color: '#ffffff', background: 'transparent', stroke: '#101116', strokeWidth: 2, shadow: true, align: 'center' },
  { id: 'soft-note', label: 'Yumuşak not', category: 'Vurgu', description: 'Minimal ve sıcak', text: 'Küçük bir not', fontFamily: 'Nunito, Arial, sans-serif', fontSize: 42, fontWeight: 600, fontStyle: 'normal', color: '#fff2d6', background: '#4d304acc', stroke: 'transparent', strokeWidth: 0, shadow: true, align: 'center' },
];

type ShapePreset = {
  id: string;
  label: string;
  glyph: string;
  color: string;
  category: 'Temel' | 'Oklar' | 'Semboller' | 'Rozet';
  description: string;
};

/**
 * Shapes intentionally remain text-based clips for now. That keeps insertion,
 * transform, keyframes and FFmpeg export on the existing stable Clip contract
 * while giving the left library a real, browsable catalog.
 */
const SHAPE_PRESETS: ShapePreset[] = [
  { id: 'circle', label: 'Daire', glyph: '●', color: '#b7f36a', category: 'Temel', description: 'Yumuşak vurgu' },
  { id: 'square', label: 'Kare', glyph: '■', color: '#ffd36a', category: 'Temel', description: 'Keskin blok' },
  { id: 'diamond', label: 'Elmas', glyph: '◆', color: '#f18df0', category: 'Temel', description: 'Döndürülmüş vurgu' },
  { id: 'triangle', label: 'Üçgen', glyph: '▲', color: '#9ce8ff', category: 'Temel', description: 'Yönlü yüzey' },
  { id: 'star', label: 'Yıldız', glyph: '★', color: '#ffd36a', category: 'Semboller', description: 'Parlak vurgu' },
  { id: 'spark', label: 'Parıltı', glyph: '✦', color: '#f18df0', category: 'Semboller', description: 'Küçük ışıltı' },
  { id: 'heart', label: 'Kalp', glyph: '♥', color: '#ff7f9f', category: 'Semboller', description: 'Duygusal vurgu' },
  { id: 'sun', label: 'Güneş', glyph: '☀', color: '#ffd36a', category: 'Semboller', description: 'Sıcak enerji' },
  { id: 'arrow-right', label: 'Sağ ok', glyph: '→', color: '#9ce8ff', category: 'Oklar', description: 'Yön göster' },
  { id: 'arrow-up', label: 'Yukarı ok', glyph: '↑', color: '#9ce8ff', category: 'Oklar', description: 'Yukarı taşı' },
  { id: 'arrow-diagonal', label: 'Çapraz ok', glyph: '↗', color: '#9ce8ff', category: 'Oklar', description: 'Hareket yönü' },
  { id: 'chevron', label: 'Şevron', glyph: '›', color: '#b7f36a', category: 'Oklar', description: 'İleri çağrı' },
  { id: 'check', label: 'Onay', glyph: '✓', color: '#82e6b5', category: 'Rozet', description: 'Tamamlandı' },
  { id: 'plus', label: 'Artı', glyph: '＋', color: '#b7f36a', category: 'Rozet', description: 'Ekle işareti' },
  { id: 'cross', label: 'Çarpı', glyph: '×', color: '#ff9d9d', category: 'Rozet', description: 'Kapat işareti' },
  { id: 'badge', label: 'Rozet', glyph: '⬡', color: '#f18df0', category: 'Rozet', description: 'Altıgen etiket' },
  { id: 'orbit', label: 'Yörünge', glyph: '◒', color: '#9ce8ff', category: 'Semboller', description: 'Dairesel hareket' },
  { id: 'cloud', label: 'Bulut', glyph: '☁', color: '#d5e7ff', category: 'Semboller', description: 'Hafif atmosfer' },
];

function legacyTextPreset(template: 'title' | 'subtitle' | 'quote'): TextPreset {
  return TEXT_PRESETS.find((preset) => preset.id === (template === 'title' ? 'clean-title' : template === 'subtitle' ? 'caption' : 'quote')) ?? TEXT_PRESETS[0];
}

const DEFAULT_TEXT_STYLE: NonNullable<Clip['textStyle']> = {
  text: 'Yeni metin',
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
  return Math.max(0.05, clip.sourceDuration / Math.max(0.25, clip.speed));
}

function clipLocalTime(clip: Clip, projectTime: number) {
  return clamp(projectTime - clip.start, 0, clip.duration);
}

function clipSpeedAt(clip: Clip, localTime: number) {
  const points = [...(clip.speedCurve ?? [])].sort((a, b) => a.time - b.time);
  if (!points.length) return clip.speed;
  if (localTime <= points[0].time) return points[0].speed;
  const last = points[points.length - 1];
  if (localTime >= last.time) return last.speed;
  const nextIndex = points.findIndex((point) => point.time >= localTime);
  const next = points[Math.max(1, nextIndex)];
  const previous = points[Math.max(0, nextIndex - 1)];
  const amount = clamp((localTime - previous.time) / Math.max(0.000001, next.time - previous.time), 0, 1);
  const eased = next.easing === 'ease-in' ? amount * amount : next.easing === 'ease-out' ? 1 - ((1 - amount) ** 2) : next.easing === 'ease-in-out' ? amount < 0.5 ? 2 * amount * amount : 1 - ((-2 * amount + 2) ** 2) / 2 : amount;
  return clamp(previous.speed + (next.speed - previous.speed) * eased, 0.1, 10);
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

function previewMediaBounds(asset: Asset, canvasWidth: number, canvasHeight: number, fit: 'contain' | 'cover' | 'stretch') {
  const sourceWidth = Math.max(1, asset.width ?? canvasWidth);
  const sourceHeight = Math.max(1, asset.height ?? canvasHeight);
  if (fit === 'stretch') return { width: canvasWidth, height: canvasHeight };
  const ratio = fit === 'cover' ? Math.max(canvasWidth / sourceWidth, canvasHeight / sourceHeight) : Math.min(canvasWidth / sourceWidth, canvasHeight / sourceHeight);
  return { width: sourceWidth * ratio, height: sourceHeight * ratio };
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

function PreviewArea({ project, settings }: { project: Project; settings: Settings | null }) {
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
  const stageRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [showSafeArea, setShowSafeArea] = useState(false);
  const [previewZoom, setPreviewZoom] = useState(100);
  const [previewFraming, setPreviewFraming] = useState<'clip' | 'fit' | 'fill' | 'smart'>(project.canvas.fitMode === 'keep' ? 'fit' : project.canvas.fitMode ?? 'fit');
  const [canvasScale, setCanvasScale] = useState(1);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [previewDrag, setPreviewDrag] = useState<{ clipId: string; mode: 'move' | 'scale'; startX: number; startY: number; originX: number; originY: number; originScale: number; historyGroup: string } | null>(null);
  const setSettings = useEditor((state) => state.setSettings);
  useEffect(() => {
    const element = canvasRef.current;
    if (!element) return;
    const updateScale = () => setCanvasScale(element.getBoundingClientRect().width / Math.max(1, project.canvas.width));
    updateScale();
    const observer = new ResizeObserver(updateScale);
    observer.observe(element);
    return () => observer.disconnect();
  }, [project.canvas.width, project.canvas.height]);
  useEffect(() => {
    const element = viewportRef.current ?? stageRef.current;
    if (!element) return;
    const updateSize = () => {
      setStageSize({
        width: Math.max(1, element.clientWidth),
        height: Math.max(1, element.clientHeight),
      });
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const activeClips = project.tracks
    .flatMap((track, trackIndex) => track.clips.map((clip) => ({ clip, track, trackIndex })))
    .filter(({ clip, track }) => !track.hidden && currentTime >= clip.start && currentTime < clip.start + clip.duration);
  const activeMedia = activeClips.filter(({ clip }) => clip.type === 'video' || clip.type === 'image');
  const activeAudio = activeClips.filter(({ clip, track }) => {
    if (track.muted || (clip.type !== 'audio' && clip.type !== 'video')) return false;
    const asset = clip.assetId ? project.assets.find((item) => item.id === clip.assetId) : undefined;
    return Boolean(asset?.hasAudio);
  });
  const texts = activeClips.filter(({ clip }) => clip.textStyle || clip.subtitle).map(({ clip }) => ({ clip, style: clip.textStyle ?? { ...DEFAULT_TEXT_STYLE, text: clip.subtitle?.text ?? clip.name, fontSize: 42, background: '#101116cc', padding: 10 } }));
  const activeSelected = selectedClipId ? activeClips.find(({ clip }) => clip.id === selectedClipId && (clip.type === 'video' || clip.type === 'image' || clip.type === 'text' || clip.type === 'subtitle')) : undefined;
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
    const target = Math.max(0, (currentTime - clip.start) * values.speed + clip.sourceStart);
    video.playbackRate = clamp(values.speed, 0.25, 4);
    if (Math.abs(video.currentTime - target) > 0.18 || video.readyState < 2) video.currentTime = target;
    if (playing) void video.play().catch(() => undefined); else video.pause();
  };

  const syncAudio = (clip: Clip, audio: HTMLAudioElement) => {
    const values = clipVisualValues(clip, currentTime);
    const target = Math.max(0, (currentTime - clip.start) * values.speed + clip.sourceStart);
    audio.playbackRate = clamp(values.speed, 0.25, 4);
    audio.volume = clamp(values.volume, 0, 1);
    if (Math.abs(audio.currentTime - target) > 0.18 || audio.readyState < 2) audio.currentTime = target;
    if (playing) void audio.play().catch(() => undefined); else audio.pause();
  };

  useEffect(() => {
    for (const { clip } of activeMedia) {
      const video = mediaRefs.current[clip.id];
      if (video) syncVideo(clip, video);
    }
    for (const { clip } of activeAudio) {
      const audio = audioRefs.current[clip.id];
      if (audio) syncAudio(clip, audio);
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
    else void canvasRef.current?.requestFullscreen?.();
  };

  const aspect: CanvasAspect = project.canvas.aspect ?? (project.canvas.width === project.canvas.height ? '1:1' : project.canvas.width > project.canvas.height ? '16:9' : '9:16');
  const aspectDimensions: Record<CanvasAspect, { width: number; height: number; label: string }> = {
    '16:9': { width: 1920, height: 1080, label: 'YouTube / yatay' },
    '9:16': { width: 1080, height: 1920, label: 'TikTok / Reels' },
    '1:1': { width: 1080, height: 1080, label: 'Kare' },
    '4:5': { width: 1080, height: 1350, label: 'Instagram gönderi' },
    '3:2': { width: 1440, height: 960, label: 'Fotoğraf / klasik' },
    '21:9': { width: 2560, height: 1080, label: 'Sinematik' },
  };
  const setAspect = (next: CanvasAspect) => {
    const dimensions = aspectDimensions[next];
    mutateProject((draft) => { draft.canvas.aspect = next; draft.canvas.width = dimensions.width; draft.canvas.height = dimensions.height; if (previewFraming !== 'clip') draft.canvas.fitMode = previewFraming; });
  };
  const canvasRatio = project.canvas.width / Math.max(1, project.canvas.height);
  const fitScale = Math.min(stageSize.width / Math.max(1, project.canvas.width), stageSize.height / Math.max(1, project.canvas.height));
  const displayScale = fitScale * (previewZoom / 100);
  const canvasDisplaySize = {
    width: Math.max(1, Math.round(project.canvas.width * displayScale)),
    height: Math.max(1, Math.round(project.canvas.height * displayScale)),
  };
  const canvasPadding = 28;
  const canvasPadSize = {
    width: Math.max(stageSize.width, canvasDisplaySize.width + canvasPadding * 2),
    height: Math.max(stageSize.height, canvasDisplaySize.height + canvasPadding * 2),
  };
  const selectedBounds = activeSelected?.clip.type === 'text' || activeSelected?.clip.type === 'subtitle'
    ? previewTextBounds(activeSelected.clip.textStyle ?? { ...DEFAULT_TEXT_STYLE, text: activeSelected.clip.name }, project.canvas.width, project.canvas.height, canvasScale)
    : activeSelectedAsset
      ? previewMediaBounds(activeSelectedAsset, project.canvas.width, project.canvas.height, (previewFraming === 'fill' || previewFraming === 'smart') ? 'cover' : previewFraming === 'fit' ? 'contain' : activeSelected?.clip.transform.fit ?? 'contain')
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
  return <main className="preview-area">
    <div className="preview-toolbar"><div className="preview-breadcrumb"><span>Canvas</span><select className="preview-aspect-select" aria-label="Preview oranı" value={aspect} onChange={(event) => setAspect(event.target.value as CanvasAspect)}><option value="16:9">16:9 · YouTube</option><option value="9:16">9:16 · Dikey</option><option value="1:1">1:1 · Kare</option><option value="4:5">4:5 · Instagram</option><option value="3:2">3:2 · Klasik</option><option value="21:9">21:9 · Sinematik</option></select><select className="preview-fit-select" aria-label="Medya kadrajı" title="Medyanın canvas içindeki kadrajı" value={previewFraming} onChange={(event) => changePreviewFraming(event.target.value as typeof previewFraming)}><option value="clip">Klip kadrajı</option><option value="fit">Medya: Sığdır</option><option value="fill">Medya: Doldur</option><option value="smart">Akıllı kadraj</option></select></div><div className="preview-tools" aria-label="Preview görünümü"><div className="preview-zoom-control" aria-label="Canvas yakınlaştırma"><div className="preview-zoom-readout"><span>Yakınlaştırma</span><strong>{previewZoom}%</strong></div><button type="button" className="preview-zoom-step" aria-label="Yakınlaştırmayı azalt" onClick={() => setPreviewZoom((value) => clamp(value - 10, 40, 180))}>−</button><input type="range" min="40" max="180" step="5" value={previewZoom} onChange={(event) => setPreviewZoom(Number(event.target.value))} aria-label="Canvas yakınlaştırma" /><button type="button" className="preview-zoom-step" aria-label="Yakınlaştırmayı artır" onClick={() => setPreviewZoom((value) => clamp(value + 10, 40, 180))}>＋</button><button type="button" className="preview-zoom-fit" onClick={() => setPreviewZoom(100)} aria-label="Preview sığdır" title="Preview sığdır">Sığdır</button></div><button className={showSafeArea ? 'active' : ''} aria-label="Güvenli alan" aria-pressed={showSafeArea} title="Güvenli alan" onClick={() => setShowSafeArea((value) => !value)}>◫</button><button aria-label="Tam ekran" title="Tam ekran" onClick={toggleFullscreen}>⛶</button></div></div>
    <div ref={stageRef} className="preview-stage"><div ref={viewportRef} className="preview-canvas-viewport"><div className="preview-canvas-pad" style={{ width: canvasPadSize.width, height: canvasPadSize.height }}><div ref={canvasRef} className={`canvas-frame canvas-aspect-${aspect.replace(':', '-')}`} style={{ width: canvasDisplaySize.width, height: canvasDisplaySize.height, aspectRatio: `${project.canvas.width}/${project.canvas.height}`, ['--canvas-ratio' as string]: canvasRatio, background: project.canvas.background }} onPointerMove={updatePreviewTransform} onPointerUp={finishPreviewTransform} onPointerCancel={finishPreviewTransform}>
    {activeMedia.map(({ clip, trackIndex }) => {
      const asset = clip.assetId ? project.assets.find((item) => item.id === clip.assetId) : undefined;
      if (!asset) return null;
      const visual = clipVisualValues(clip, currentTime);
      const mediaUrl = `/api/projects/${project.id}/media/${asset.id}${useProxy && asset.proxyPath ? '?proxy=1' : ''}`;
      const mediaStyle: React.CSSProperties = {
        opacity: visual.opacity,
        pointerEvents: 'none',
        objectFit: (previewFraming === 'fill' || previewFraming === 'smart') ? 'cover' : previewFraming === 'fit' ? 'contain' : clip.transform.fit === 'stretch' ? 'fill' : clip.transform.fit,
        zIndex: trackIndex + 1,
        transform: `translate(${visual.x * canvasScale}px, ${visual.y * canvasScale}px) rotate(${visual.rotation}deg) scale(${visual.scale}) scaleX(${clip.transform.flipX ? -1 : 1}) scaleY(${clip.transform.flipY ? -1 : 1})`,
        filter: `brightness(${1 + clip.filters.brightness}) contrast(${1 + clip.filters.contrast}) saturate(${1 + clip.filters.saturation}) hue-rotate(${clip.filters.hue ?? 0}deg) blur(${clip.filters.blur}px) grayscale(${clip.filters.grayscale})${(clip.filters.temperature ?? 0) > 0 ? ` sepia(${Math.abs(clip.filters.temperature ?? 0) * 0.35})` : ''}`,
        clipPath: visual.wipe ? transitionClipPath(visual.wipe) : clip.mask ? `${clip.mask.type === 'ellipse' ? 'ellipse' : 'inset'}(${clip.mask.type === 'ellipse' ? `${clip.mask.height * 50}% ${clip.mask.width * 50}%` : `${clip.mask.y * 100}% ${(1 - clip.mask.x - clip.mask.width) * 100}% ${(1 - clip.mask.y - clip.mask.height) * 100}% ${clip.mask.x * 100}%`}${clip.mask.type === 'ellipse' ? ` at ${(clip.mask.x + clip.mask.width / 2) * 100}% ${(clip.mask.y + clip.mask.height / 2) * 100}%` : ''})` : undefined,
        borderRadius: clip.mask?.type === 'ellipse' ? '50%' : undefined,
      };
      return asset.type === 'video'
        ? <video key={clip.id} ref={(element) => { mediaRefs.current[clip.id] = element; if (element) syncVideo(clip, element); }} src={mediaUrl} muted playsInline className={`preview-media preview-layer ${selectedClipIds.includes(clip.id) ? 'preview-selected' : ''}`} style={mediaStyle} onLoadedMetadata={(event) => syncVideo(clip, event.currentTarget)} />
        : <img key={clip.id} src={mediaUrl} className={`preview-media preview-layer ${selectedClipIds.includes(clip.id) ? 'preview-selected' : ''}`} style={mediaStyle} alt={clip.name} />;
    })}
    {activeMedia.map(({ clip, trackIndex }) => {
      const asset = clip.assetId ? project.assets.find((item) => item.id === clip.assetId) : undefined;
      if (!asset) return null;
      const visual = clipVisualValues(clip, currentTime);
      const fit = (previewFraming === 'fill' || previewFraming === 'smart') ? 'cover' : previewFraming === 'fit' ? 'contain' : clip.transform.fit;
      const bounds = previewMediaBounds(asset, project.canvas.width, project.canvas.height, fit);
      const track = project.tracks.find((item) => item.clips.some((candidate) => candidate.id === clip.id));
      return <button type="button" key={`preview-hit-${clip.id}`} className={`preview-hit-target ${selectedClipIds.includes(clip.id) ? 'selected' : ''}`} style={{ width: bounds.width * canvasScale, height: bounds.height * canvasScale, zIndex: 40 + trackIndex, transform: `translate(-50%, -50%) translate(${visual.x * canvasScale}px, ${visual.y * canvasScale}px) rotate(${visual.rotation}deg) scale(${visual.scale}) scaleX(${clip.transform.flipX ? -1 : 1}) scaleY(${clip.transform.flipY ? -1 : 1})` }} onPointerDown={(event) => beginPreviewTransform(event, clip, 'move')} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelected(clip.id, track?.id ?? null); } }} aria-label={`${clip.name} seç`}><span className="preview-hit-label">{clip.type === 'image' ? 'Görsel' : 'Video'}</span></button>;
    })}
    {activeAudio.map(({ clip }) => {
      const asset = clip.assetId ? project.assets.find((item) => item.id === clip.assetId) : undefined;
      if (!asset) return null;
      const mediaUrl = `/api/projects/${project.id}/media/${asset.id}${useProxy && asset.proxyPath ? '?proxy=1' : ''}`;
      return <audio key={`audio-${clip.id}`} ref={(element) => { audioRefs.current[clip.id] = element; if (element) syncAudio(clip, element); }} src={mediaUrl} preload="auto" onLoadedMetadata={(event) => syncAudio(clip, event.currentTarget)} />;
    })}
    {texts.map(({ clip, style }) => { const visual = clipVisualValues(clip, currentTime); const bounds = previewTextBounds(style, project.canvas.width, project.canvas.height, canvasScale); const track = project.tracks.find((item) => item.clips.some((candidate) => candidate.id === clip.id)); return <div key={clip.id} className={`preview-text preview-layer ${selectedClipIds.includes(clip.id) ? 'preview-selected' : ''}`} role="button" tabIndex={0} aria-label={`${style.text || clip.name} seç`} onPointerDown={(event) => beginPreviewTransform(event, clip, 'move')} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelected(clip.id, track?.id ?? null); } }} style={{ left: '50%', top: '50%', bottom: 'auto', width: bounds.width * canvasScale, zIndex: 100 + (clip.start || 0), pointerEvents: 'auto', transform: `translate(-50%, -50%) translate(${visual.x * canvasScale}px, ${visual.y * canvasScale}px) rotate(${visual.rotation}deg) scale(${visual.scale})`, opacity: visual.opacity, fontFamily: style.fontFamily, fontSize: Math.max(12, style.fontSize * canvasScale), color: style.color, fontWeight: style.fontWeight, fontStyle: style.fontStyle, textDecoration: style.textDecoration, letterSpacing: `${style.letterSpacing * canvasScale}px`, lineHeight: style.lineHeight, padding: `${style.padding * canvasScale}px`, background: style.background, clipPath: transitionClipPath(visual.wipe), WebkitTextStroke: `${style.strokeWidth * canvasScale}px ${style.stroke}`, textShadow: style.shadow ? '0 2px 8px #000' : 'none', textAlign: style.align }}>{style.text}</div>; })}
    {activeSelected && activeSelectedVisual && <div className="preview-transform-box" style={{ zIndex: 300, left: '50%', top: '50%', width: selectedBounds.width * canvasScale, height: selectedBounds.height * canvasScale, transform: `translate(-50%, -50%) translate(${activeSelectedVisual.x * canvasScale}px, ${activeSelectedVisual.y * canvasScale}px) rotate(${activeSelectedVisual.rotation}deg) scale(${activeSelectedVisual.scale})` }}><span className="preview-transform-label">{activeSelected.clip.type === 'text' ? 'Metin' : activeSelected.clip.type === 'subtitle' ? 'Altyazı' : activeSelected.clip.type === 'image' ? 'Görsel' : 'Video'}</span><button className="preview-scale-handle" aria-label="Önizlemede yeniden boyutlandır" onPointerDown={(event) => beginPreviewTransform(event, activeSelected.clip, 'scale')} /></div>}
    {showSafeArea && <div className="safe-area" />}
          </div>
        </div>
      </div>
    </div>
    <div className="preview-controls"><span className="preview-time"><b>{formatTime(currentTime, true, project.canvas.fps)}</b> <i>/</i> {formatTime(project.duration, true, project.canvas.fps)}</span><div className="transport-center"><button className="control-button" title="Önceki kare" onClick={() => stepFrame(-1)}>↶</button><button className="play-button" aria-label={playing ? 'Duraklat' : 'Oynat'} onClick={() => setPlaying(!playing)}>{playing ? 'Ⅱ' : '▶'}</button><button className="control-button" title="Sonraki kare" onClick={() => stepFrame(1)}>↷</button></div><div className="transport-right"><button className="control-button" title="Başa sar" onClick={() => { setPlaying(false); setCurrentTime(0); }}>⌁</button><button className="quality-button" onClick={cycleQuality} title="Preview kalitesini değiştir">{settings?.proxyQuality === 'draft' ? 'Draft' : settings?.proxyQuality === 'high' ? 'High' : 'Balanced'}⌄</button></div></div></main>;
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
  const selectedClipId = useEditor((state) => state.selectedClipId);
  const selectedClipIds = useEditor((state) => state.selectedClipIds);
  const currentTime = useEditor((state) => state.currentTime);
  const mutateProject = useEditor((state) => state.mutateProject);
  const setSelected = useEditor((state) => state.setSelected);
  const setPanel = useEditor((state) => state.setPanel);
  const [activeGroup, setActiveGroup] = useState<'layout' | 'motion' | 'audio'>('layout');
  const [activeInspectorTab, setActiveInspectorTab] = useState<'primary' | 'audio' | 'speed' | 'motion' | 'adjust'>('primary');
  const selected = project.tracks.flatMap((track) => track.clips).find((clip) => clip.id === selectedClipId);
  const selectedAsset = selected?.assetId ? project.assets.find((asset) => asset.id === selected.assetId) : undefined;
  if (!selected) return <aside className="inspector"><div className="inspector-empty"><span>⌖</span><strong>Klip seç</strong><small>Özellikleri düzenlemek için timeline'dan bir klip seç.</small></div></aside>;

  const update = (recipe: (clip: Clip) => void) => mutateProject((draft) => {
    const ids = new Set(selectedClipIds.length ? selectedClipIds : [selected.id]);
    for (const track of draft.tracks) {
      if (track.locked) continue;
      for (const clip of track.clips) {
        if (ids.has(clip.id)) recipe(clip);
      }
    }
  });
  const updateText = (recipe: (style: NonNullable<Clip['textStyle']>) => void) => update((clip) => {
    if (clip.type !== 'text' && clip.type !== 'subtitle') return;
    const style = clip.textStyle ?? { ...DEFAULT_TEXT_STYLE };
    recipe(style);
    clip.textStyle = style;
  });
  const textStyle = selected.textStyle ?? DEFAULT_TEXT_STYLE;
  const setSpeed = (value: number) => update((clip) => {
    clip.speed = clamp(value, 0.25, 4);
    if (clip.type !== 'text' && clip.type !== 'subtitle') clip.duration = Math.max(0.05, clip.sourceDuration / clip.speed);
  });
  const addKeyframe = (property: Clip['keyframes'][number]['property']) => {
    const localTime = clamp(currentTime - selected.start, 0, selected.duration);
    mutateProject((draft) => {
      const clip = draft.tracks.flatMap((track) => track.clips).find((item) => item.id === selected.id);
      if (!clip || clip.keyframes.some((keyframe) => keyframe.property === property && Math.abs(keyframe.time - localTime) < 1 / project.canvas.fps)) return;
      const value = property === 'x' ? clip.transform.x : property === 'y' ? clip.transform.y : property === 'scale' ? clip.transform.scale : property === 'rotation' ? clip.transform.rotation : property === 'volume' ? clip.volume : clip.transform.opacity;
      clip.keyframes.push({ id: `key_${crypto.randomUUID().slice(0, 8)}`, property, time: localTime, value, easing: 'linear' });
    });
  };
  const keyframeEasing = (easing: Clip['keyframes'][number]['easing']) => easing === 'linear' ? 'ease-in' : easing === 'ease-in' ? 'ease-out' : easing === 'ease-out' ? 'ease-in-out' : 'linear';
  const opacityKeyframes = selected.keyframes.filter((keyframe) => keyframe.property === 'opacity').sort((a, b) => a.time - b.time);
  const graphPoints = opacityKeyframes.map((keyframe, index) => `${opacityKeyframes.length === 1 ? 90 : (index / (opacityKeyframes.length - 1)) * 180},${58 - clamp(keyframe.value, 0, 1) * 48}`).join(' ');
  const typeLabel = selected.type === 'video' ? 'Video' : selected.type === 'audio' ? 'Ses' : selected.type === 'image' ? 'Görsel' : selected.type === 'text' ? 'Metin' : 'Altyazı';
  const textColor = textStyle.color.startsWith('#') ? textStyle.color : '#ffffff';

  return <aside className="inspector inspector-pro">
    {selectedClipIds.length > 1 && <div className="multi-selection-hint">{selectedClipIds.length} klip seçili · ortak ayarlar birlikte uygulanır.</div>}
    <div className="inspector-heading"><div><p className="eyebrow">Inspector</p><h2>{`${typeLabel} klibi`}</h2></div><button onClick={() => setSelected(null, null)} aria-label="Seçimi kaldır">×</button></div>
    <div className="selected-file"><div className={`mini-thumb ${selected.type}`}>{selected.type === 'video' ? '▶' : selected.type === 'audio' ? '♫' : selected.type === 'image' ? '▧' : 'T'}</div><div><strong>{selected.name}</strong><small>{formatTime(selected.duration)} · {selected.speed}×{selectedAsset ? ` · ${selectedAsset.mimeType}` : ''}</small></div></div>
    <div className="inspector-tool-tabs" role="tablist" aria-label="Inspector araçları">
      {(selected.type === 'text' || selected.type === 'subtitle' ? [['primary', 'Yerleşim'], ['motion', 'Animasyon'], ['adjust', 'Yazı stili']] : [['primary', 'Yerleşim'], ['audio', 'Ses ve kırpma'], ['speed', 'Hız'], ['motion', 'Animasyon'], ['adjust', 'Görünüm']]).map(([key, label]) => <button key={key} role="tab" aria-selected={activeInspectorTab === key} className={activeInspectorTab === key ? 'active' : ''} onClick={() => { setActiveInspectorTab(key as typeof activeInspectorTab); setActiveGroup(key === 'motion' ? 'motion' : key === 'primary' ? 'layout' : 'audio'); }}><span>{label}</span></button>)}
    </div>
    <div className="inspector-group-note">{activeGroup === 'layout' ? 'Klibi tuval üzerinde taşı, boyutlandır, döndür ve saydamlığını ayarla.' : activeGroup === 'motion' ? 'Klibin zaman içinde nasıl hareket edeceğini keyframe noktalarıyla belirle.' : selected.type === 'audio' || selected.type === 'video' ? 'Ses seviyesini, kaynak süresini ve yumuşak giriş/çıkışı düzenle.' : selected.type === 'image' ? 'Görselin renk, ton ve filtre değerlerini düzenle.' : 'Metni, yazı tipini ve okunabilirlik ayarlarını düzenle.'}</div>

    {activeGroup === 'layout' && <InspectorSection id="inspector-transform" title="Transform">
      <div className="field-grid"><NumberField label="X" value={selected.transform.x} onChange={(value) => update((clip) => { clip.transform.x = value; })} /><NumberField label="Y" value={selected.transform.y} onChange={(value) => update((clip) => { clip.transform.y = value; })} /><NumberField label="Scale" value={selected.transform.scale} step={0.05} onChange={(value) => update((clip) => { clip.transform.scale = Math.max(0.05, value); })} /><NumberField label="Rotate" value={selected.transform.rotation} onChange={(value) => update((clip) => { clip.transform.rotation = value; })} /></div>
      <NumberField label="Opacity %" value={Math.round(selected.transform.opacity * 100)} min={0} max={100} step={1} onChange={(value) => update((clip) => { clip.transform.opacity = value / 100; })} />
      {(selected.type === 'video' || selected.type === 'image') && <div className="inspector-button-row"><button className={selected.transform.flipX ? 'active' : ''} onClick={() => update((clip) => { clip.transform.flipX = !clip.transform.flipX; })}>↔ Yatay çevir</button><button className={selected.transform.flipY ? 'active' : ''} onClick={() => update((clip) => { clip.transform.flipY = !clip.transform.flipY; })}>↕ Dikey çevir</button></div>}
    </InspectorSection>}
    {activeGroup === 'motion' && <InspectorSection id="inspector-motion" title="Animasyon keyframe'leri">
      <div className="inspector-animation-launch"><div><strong>Geçiş davranışı</strong><small>Fade, Kaydır ve Yakınlaş seçeneklerini önizleyerek seç.</small></div><button onClick={() => setPanel('animation')}>Stüdyoyu aç ↗</button></div>
      <div className="inspector-button-row keyframe-buttons"><button onClick={() => addKeyframe('x')}>X</button><button onClick={() => addKeyframe('y')}>Y</button><button onClick={() => addKeyframe('scale')}>Scale</button><button onClick={() => addKeyframe('rotation')}>Rotate</button><button onClick={() => addKeyframe('opacity')}>Opacity</button>{(selected.type === 'audio' || selected.type === 'video') && <button onClick={() => addKeyframe('volume')}>Volume</button>}</div>
      <div className="inspector-tip">Playhead'i taşıyıp bir özellik düğmesine basarak animasyon noktası ekleyin. Easing düğmeleri aşağıdaki grafikten değişir.</div>
    </InspectorSection>}

    {activeGroup === 'audio' && (selected.type === 'text' || selected.type === 'subtitle') && <InspectorSection id="inspector-text" title={selected.type === 'subtitle' ? 'Altyazı stili' : 'Metin stili'}>
      <label className="inspector-wide-field"><span>Metin</span><textarea value={textStyle.text} rows={3} onChange={(event) => updateText((style) => { style.text = event.target.value; })} /></label>
      <div className="field-row"><span>Yazı tipi</span><select aria-label="Yazı tipi" value={textStyle.fontFamily} onChange={(event) => updateText((style) => { style.fontFamily = event.target.value; })}>{TEXT_FONT_OPTIONS.map((font) => <option key={font} value={font}>{font.split(',')[0]}</option>)}</select></div>
      <div className="field-grid"><NumberField label="Boyut" value={textStyle.fontSize} step={1} onChange={(value) => updateText((style) => { style.fontSize = Math.max(8, value); })} /><NumberField label="Harf aralığı" value={textStyle.letterSpacing} step={0.5} onChange={(value) => updateText((style) => { style.letterSpacing = value; })} /><NumberField label="Satır yüksekliği" value={textStyle.lineHeight} step={0.05} onChange={(value) => updateText((style) => { style.lineHeight = clamp(value, 0.5, 3); })} /><NumberField label="İç boşluk" value={textStyle.padding} step={1} onChange={(value) => updateText((style) => { style.padding = Math.max(0, value); })} /></div>
      <div className="field-row"><span>Ağırlık</span><select aria-label="Yazı ağırlığı" value={textStyle.fontWeight} onChange={(event) => updateText((style) => { style.fontWeight = Number(event.target.value); })}><option value="300">Light 300</option><option value="400">Regular 400</option><option value="500">Medium 500</option><option value="600">Semibold 600</option><option value="700">Bold 700</option><option value="800">Extra bold 800</option><option value="900">Black 900</option></select></div>
      <div className="inspector-button-row"><button className={textStyle.fontStyle === 'italic' ? 'active' : ''} onClick={() => updateText((style) => { style.fontStyle = style.fontStyle === 'italic' ? 'normal' : 'italic'; })}>Italic</button><button className={textStyle.textDecoration === 'underline' ? 'active' : ''} onClick={() => updateText((style) => { style.textDecoration = style.textDecoration === 'underline' ? 'none' : 'underline'; })}>Altı çizili</button><button className={textStyle.shadow ? 'active' : ''} onClick={() => updateText((style) => { style.shadow = !style.shadow; })}>Gölge</button></div>
      <div className="field-row"><span>Hizalama</span><div className="segmented-control"><button className={textStyle.align === 'left' ? 'active' : ''} onClick={() => updateText((style) => { style.align = 'left'; })}>Sol</button><button className={textStyle.align === 'center' ? 'active' : ''} onClick={() => updateText((style) => { style.align = 'center'; })}>Orta</button><button className={textStyle.align === 'right' ? 'active' : ''} onClick={() => updateText((style) => { style.align = 'right'; })}>Sağ</button></div></div>
      <div className="color-grid"><label><span>Renk</span><input type="color" value={textColor} onChange={(event) => updateText((style) => { style.color = event.target.value; })} /></label><label><span>Arka plan</span><input type="text" value={textStyle.background} onChange={(event) => updateText((style) => { style.background = event.target.value; })} /></label><label><span>Stroke</span><input type="text" value={textStyle.stroke} onChange={(event) => updateText((style) => { style.stroke = event.target.value; })} /></label><NumberField label="Stroke px" value={textStyle.strokeWidth} step={1} onChange={(value) => updateText((style) => { style.strokeWidth = clamp(value, 0, 20); })} /></div>
    </InspectorSection>}

    {activeGroup === 'layout' && (selected.type === 'video' || selected.type === 'image') && <InspectorSection id="inspector-media" title={selected.type === 'image' ? 'Görsel' : 'Video'}>
      <div className="field-row"><span>Hız</span><select aria-label="Klip hızı" value={selected.speed} onChange={(event) => setSpeed(Number(event.target.value))}><option value="0.25">0.25×</option><option value="0.5">0.5×</option><option value="1">1×</option><option value="1.5">1.5×</option><option value="2">2×</option><option value="4">4×</option></select></div>
      <div className="field-row"><span>Görüntü</span><select value={selected.transform.fit} onChange={(event) => update((clip) => { clip.transform.fit = event.target.value as Clip['transform']['fit']; })}><option value="contain">Sığdır</option><option value="cover">Doldur</option><option value="stretch">Uzat</option></select></div>
      <div className="field-row"><span>Hız eğrisi</span><select value={selected.speedCurve?.length ? 'custom' : 'constant'} onChange={(event) => update((clip) => { clip.speedCurve = event.target.value === 'constant' ? undefined : [{ time: 0, speed: Math.max(0.25, clip.speed * 0.5), easing: 'ease-in' }, { time: clip.duration / 2, speed: clip.speed, easing: 'ease-in-out' }, { time: clip.duration, speed: Math.min(4, clip.speed * 1.5), easing: 'ease-out' }]; })}><option value="constant">Sabit hız</option><option value="custom">Yumuşak hız rampası</option></select></div>
      <div className="inspector-tip">Önizlemede klibe tıklayıp sürükleyin. Sağ alt tutamacı kullanarak yeniden boyutlandırabilirsiniz.</div>
    </InspectorSection>}

    {activeGroup === 'motion' && (selected.type === 'video' || selected.type === 'image') && <InspectorSection id="inspector-transition" title="Maske ve geçiş">
      <div className="field-row"><span>Maske şekli</span><select value={selected.mask?.type ?? 'rectangle'} onChange={(event) => update((clip) => { clip.mask = { type: event.target.value as 'rectangle' | 'ellipse', x: clip.mask?.x ?? 0, y: clip.mask?.y ?? 0, width: clip.mask?.width ?? 1, height: clip.mask?.height ?? 1, feather: clip.mask?.feather ?? 0, invert: clip.mask?.invert ?? false }; })}><option value="rectangle">Dikdörtgen</option><option value="ellipse">Elips</option></select></div>
      <div className="field-grid"><NumberField label="Mask X" value={selected.mask?.x ?? 0} step={0.01} onChange={(value) => update((clip) => { clip.mask = { type: clip.mask?.type ?? 'rectangle', x: clamp(value, 0, 1), y: clip.mask?.y ?? 0, width: clip.mask?.width ?? 1, height: clip.mask?.height ?? 1, feather: clip.mask?.feather ?? 0, invert: clip.mask?.invert ?? false }; })} /><NumberField label="Mask Y" value={selected.mask?.y ?? 0} step={0.01} onChange={(value) => update((clip) => { clip.mask = { type: clip.mask?.type ?? 'rectangle', x: clip.mask?.x ?? 0, y: clamp(value, 0, 1), width: clip.mask?.width ?? 1, height: clip.mask?.height ?? 1, feather: clip.mask?.feather ?? 0, invert: clip.mask?.invert ?? false }; })} /><NumberField label="Genişlik" value={selected.mask?.width ?? 1} step={0.01} onChange={(value) => update((clip) => { clip.mask = { type: clip.mask?.type ?? 'rectangle', x: clip.mask?.x ?? 0, y: clip.mask?.y ?? 0, width: clamp(value, 0.01, 1), height: clip.mask?.height ?? 1, feather: clip.mask?.feather ?? 0, invert: clip.mask?.invert ?? false }; })} /><NumberField label="Yükseklik" value={selected.mask?.height ?? 1} step={0.01} onChange={(value) => update((clip) => { clip.mask = { type: clip.mask?.type ?? 'rectangle', x: clip.mask?.x ?? 0, y: clip.mask?.y ?? 0, width: clip.mask?.width ?? 1, height: clamp(value, 0.01, 1), feather: clip.mask?.feather ?? 0, invert: clip.mask?.invert ?? false }; })} /></div>
      <NumberField label="Feather %" value={Math.round((selected.mask?.feather ?? 0) * 100)} min={0} max={100} step={1} onChange={(value) => update((clip) => { if (clip.mask) clip.mask.feather = value / 100; else clip.mask = { type: 'rectangle', x: 0, y: 0, width: 1, height: 1, feather: value / 100, invert: false }; })} />
      <div className="field-grid"><label className="inspector-wide-field"><span>Giriş geçişi</span><select value={selected.transitionIn?.type ?? 'none'} onChange={(event) => update((clip) => { clip.transitionIn.type = event.target.value as Clip['transitionIn']['type']; })}>{['none', 'fade', 'dissolve', 'slide', 'wipe', 'zoom'].map((value) => <option key={value} value={value}>{value}</option>)}</select></label><label className="inspector-wide-field"><span>Çıkış geçişi</span><select value={selected.transitionOut?.type ?? 'none'} onChange={(event) => update((clip) => { clip.transitionOut.type = event.target.value as Clip['transitionOut']['type']; })}>{['none', 'fade', 'dissolve', 'slide', 'wipe', 'zoom'].map((value) => <option key={value} value={value}>{value}</option>)}</select></label></div>
      <div className="field-grid"><NumberField label="Giriş sn" value={selected.transitionIn?.duration ?? 0} step={0.05} onChange={(value) => update((clip) => { clip.transitionIn.duration = clamp(value, 0, Math.min(5, clip.duration)); })} /><NumberField label="Çıkış sn" value={selected.transitionOut?.duration ?? 0} step={0.05} onChange={(value) => update((clip) => { clip.transitionOut.duration = clamp(value, 0, Math.min(5, clip.duration)); })} /></div>
    </InspectorSection>}

    {activeGroup === 'audio' && (selected.type === 'audio' || selected.type === 'video') && <InspectorSection id="inspector-audio" title="Ses">
      <NumberField label="Ses seviyesi %" value={Math.round(selected.volume * 100)} min={0} max={200} step={1} onChange={(value) => update((clip) => { clip.volume = value / 100; })} />
      <div className="field-row"><span>Hız</span><select value={selected.speed} onChange={(event) => setSpeed(Number(event.target.value))}><option value="0.25">0.25×</option><option value="0.5">0.5×</option><option value="1">1×</option><option value="1.5">1.5×</option><option value="2">2×</option><option value="4">4×</option></select></div>
      <div className="field-grid"><NumberField label="Kaynak başlangıcı" value={selected.sourceStart} step={0.01} onChange={(value) => update((clip) => { clip.sourceStart = Math.max(0, value); })} /><NumberField label="Kaynak süresi" value={selected.sourceDuration} step={0.01} onChange={(value) => update((clip) => { clip.sourceDuration = Math.max(0.05, value); clip.duration = Math.max(0.05, clip.sourceDuration / clip.speed); })} /></div>
      <div className="field-grid"><NumberField label="Fade in" value={selected.fadeIn ?? 0} step={0.05} onChange={(value) => update((clip) => { clip.fadeIn = clamp(value, 0, clip.duration); })} /><NumberField label="Fade out" value={selected.fadeOut ?? 0} step={0.05} onChange={(value) => update((clip) => { clip.fadeOut = clamp(value, 0, clip.duration); })} /></div>
      <label className="check-field"><input type="checkbox" checked={Boolean(selected.normalize)} onChange={(event) => update((clip) => { clip.normalize = event.target.checked; })} /><span>Ses seviyesini normalize et</span></label>
      <div className="inspector-button-row"><button className={selected.volume === 0 ? 'active' : ''} onClick={() => update((clip) => { clip.volume = clip.volume === 0 ? 1 : 0; })}>{selected.volume === 0 ? 'Sesi aç' : 'Sessize al'}</button></div>
    </InspectorSection>}

    {((activeGroup === 'layout' && selected.type === 'video') || (activeGroup === 'audio' && selected.type === 'image')) && <InspectorSection id="inspector-color" title="Renk ve efekt">
      <NumberField label="Parlaklık %" value={Math.round(selected.filters.brightness * 100)} min={-100} max={100} step={1} onChange={(value) => update((clip) => { clip.filters.brightness = value / 100; })} />
      <NumberField label="Kontrast %" value={Math.round(selected.filters.contrast * 100)} min={-100} max={100} step={1} onChange={(value) => update((clip) => { clip.filters.contrast = value / 100; })} />
      <NumberField label="Doygunluk %" value={Math.round(selected.filters.saturation * 100)} min={-100} max={100} step={1} onChange={(value) => update((clip) => { clip.filters.saturation = value / 100; })} />
      <NumberField label="Bulanıklık" value={selected.filters.blur} min={0} max={24} step={0.5} onChange={(value) => update((clip) => { clip.filters.blur = value; })} />
      <NumberField label="Sıcaklık %" value={Math.round((selected.filters.temperature ?? 0) * 100)} min={-100} max={100} step={1} onChange={(value) => update((clip) => { clip.filters.temperature = value / 100; })} />
      <NumberField label="Ton (Hue)" value={selected.filters.hue ?? 0} min={-180} max={180} step={1} onChange={(value) => update((clip) => { clip.filters.hue = value; })} />
      <NumberField label="Vinyet %" value={Math.round((selected.filters.vignette ?? 0) * 100)} min={0} max={100} step={1} onChange={(value) => update((clip) => { clip.filters.vignette = value / 100; })} />
    </InspectorSection>}

    {activeGroup === 'motion' && <><div className="keyframe-current"><span>Opacity keyframe</span><button className="add-keyframe" onClick={() => addKeyframe('opacity')}>◇ Ekle</button></div>
    {opacityKeyframes.length > 0 && <section className="keyframe-graph"><div className="keyframe-graph-head"><strong>Opacity graph</strong><small>{opacityKeyframes.length} keyframe</small></div><svg viewBox="0 0 180 60" role="img" aria-label="Opacity easing graph"><path d="M0 58H180M0 10H180" /><polyline points={graphPoints} />{opacityKeyframes.map((keyframe, index) => <circle key={keyframe.id} cx={opacityKeyframes.length === 1 ? 90 : (index / (opacityKeyframes.length - 1)) * 180} cy={58 - clamp(keyframe.value, 0, 1) * 48} r="3" />)}</svg><div className="keyframe-easing-list">{opacityKeyframes.map((keyframe) => <button key={keyframe.id} onClick={() => mutateProject((draft) => { const target = draft.tracks.flatMap((track) => track.clips).find((clip) => clip.id === selected.id)?.keyframes.find((item) => item.id === keyframe.id); if (target) target.easing = keyframeEasing(target.easing); })}>{formatTime(keyframe.time)} · {keyframe.easing}</button>)}</div></section>}</>}
  </aside>;
}

function InspectorSection({ id, title, children }: { id?: string; title: string; children: React.ReactNode }) { const [open, setOpen] = useState(true); return <section id={id} className="inspector-section"><button className="section-toggle" onClick={() => setOpen((value) => !value)} aria-expanded={open}><span>{open ? '⌄' : '›'}</span><strong>{title}</strong><i>{open ? '◇' : '＋'}</i></button>{open && children}</section>; }
function NumberField({ label, value, step = 1, min, max, onChange }: { label: string; value: number; step?: number; min?: number; max?: number; onChange: (value: number) => void }) {
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
      <button type="button" aria-label={`${label} azalt`} title="Azalt" onClick={() => nudge(-1)}>−</button>
      <input className={isDragging ? 'number-drag-input is-dragging' : 'number-drag-input'} aria-label={label} title="Değeri yatay sürükleyerek değiştir" type="number" value={value} step={step} min={min} max={max} onPointerDown={beginValueDrag} onPointerMove={moveValueDrag} onPointerUp={finishValueDrag} onPointerCancel={finishValueDrag} onChange={(event) => onChange(clampValue(Number(event.target.value)))} />
      <button type="button" aria-label={`${label} artır`} title="Artır" onClick={() => nudge(1)}>＋</button>
    </div>
  </div>;
}

const TIMELINE_LABEL_WIDTH = 108;

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

  const maxTime = Math.max(project.duration + 5, 30);
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
      draft.tracks.push({ id: `track-${type}-${crypto.randomUUID().slice(0, 8)}`, type, name: `${names[type]} ${index + 1}`, order: index, clips: [], locked: false, hidden: false, muted: false });
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
              <button onClick={() => addTrack('subtitle')}>≡ Subtitle</button>
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
  | { kind: 'trimLeft' | 'trimRight'; clipId: string; trackId: string; startX: number; start: number; duration: number; sourceStart: number; sourceDuration: number; speed: number; historyGroup: string }
  | { kind: 'playhead' }
  | { kind: 'marker'; markerId: string; historyGroup?: string }
  | { kind: 'rangeStart' }
  | { kind: 'rangeEnd' };

function TimelinePro({ project }: { project: Project }) {
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
  const rangeStart = useEditor((state) => state.rangeStart);
  const rangeEnd = useEditor((state) => state.rangeEnd);
  const setRangeStart = useEditor((state) => state.setRangeStart);
  const setRangeEnd = useEditor((state) => state.setRangeEnd);
  const clearRange = useEditor((state) => state.clearRange);
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
        if (clip) clipElement.title = `${clip.name} · ${formatTime(clip.start)}–${formatTime(clip.start + clip.duration)} · ${asset?.name ?? clip.type}`;
        if (clip?.type === 'audio' && asset?.waveformPath) clipElement.style.setProperty('--waveform-url', `url("/api/projects/${project.id}/media/${asset.id}?waveform=1")`);
        else clipElement.style.removeProperty('--waveform-url');
      }
    }
  }, [project]);
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
          setDrag({ kind: trimHandle.classList.contains('left') ? 'trimLeft' : 'trimRight', clipId: clip.id, trackId: track.id, startX: event.clientX, start: clip.start, duration: clip.duration, sourceStart: clip.sourceStart, sourceDuration: clip.sourceDuration, speed: clip.speed, historyGroup });
          root.setPointerCapture(event.pointerId);
          return;
        }
      }
      if (target.closest('.timeline-clip') || target.closest('.range-handle') || target.closest('.playhead')) return;
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
  }, [assetDragId, currentTime, mutateProject, project, px, rangeEnd, rangeStart, setCurrentTime, setSelected, snapEnabled]);
  const maxTime = Math.max(project.duration + 5, 30);
  const rulerTicks = Array.from({ length: Math.ceil(maxTime) + 1 }, (_, index) => index).filter((tick) => tick % (px < 60 ? 5 : px < 100 ? 2 : 1) === 0);
  const timeFromClientX = (clientX: number) => { const box = timelineRef.current?.getBoundingClientRect(); if (!box) return 0; return clamp((clientX - box.left + (timelineRef.current?.scrollLeft ?? 0) - TIMELINE_LABEL_WIDTH) / px, 0, project.duration); };
  const trackIdAtClientY = (clientY: number) => {
    const rows = Array.from(timelineRef.current?.querySelectorAll<HTMLElement>('[data-track-id]') ?? []);
    return rows.find((row) => { const box = row.getBoundingClientRect(); return clientY >= box.top && clientY <= box.bottom; })?.dataset.trackId ?? null;
  };
  const frameTime = (value: number) => quantizeFrameTime(value, project.canvas.fps, project.duration);
  const snapTime = (value: number) => snapProjectTime(project, value, { enabled: snapEnabled, currentTime, rangeStart, rangeEnd });
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
    if (drag.kind === 'rangeStart') { setRangeStart(Math.min(frameTime(timeFromClientX(event.clientX)), rangeEnd ?? project.duration)); return; }
    if (drag.kind === 'rangeEnd') { setRangeEnd(Math.max(frameTime(timeFromClientX(event.clientX)), rangeStart ?? 0)); return; }
    if (drag.kind === 'marker') { const at = frameTime(timeFromClientX(event.clientX)); mutateProject((draft) => { const marker = draft.markers.find((item) => item.id === drag.markerId); if (marker) marker.time = at; }, { historyGroup: drag.historyGroup }); setCurrentTime(at); return; }
    if (drag.kind === 'trimLeft' || drag.kind === 'trimRight') {
      const delta = (event.clientX - drag.startX) / px;
      const frame = 1 / project.canvas.fps;
      mutateProject((draft) => {
        const track = draft.tracks.find((item) => item.id === drag.trackId);
        const clip = track?.clips.find((item) => item.id === drag.clipId);
        if (!clip || track?.locked) return;
        if (drag.kind === 'trimLeft') {
          const nextStart = clamp(Math.round((drag.start + delta) / frame) * frame, 0, drag.start + drag.duration - frame);
          const consumed = nextStart - drag.start;
          clip.start = nextStart;
          clip.duration = Math.max(frame, drag.duration - consumed);
          clip.sourceStart = Math.max(0, drag.sourceStart + consumed * drag.speed);
          clip.sourceDuration = Math.max(frame * drag.speed, drag.sourceDuration - consumed * drag.speed);
        } else {
          const maxDuration = Math.max(frame, drag.sourceDuration / Math.max(0.25, drag.speed));
          const nextDuration = clamp(Math.round((drag.duration + delta) / frame) * frame, frame, maxDuration);
          clip.duration = nextDuration;
          clip.sourceDuration = Math.max(frame * drag.speed, nextDuration * drag.speed);
        }
        draft.duration = projectDuration(draft);
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
  const addMarker = () => mutateProject((draft) => { const time = Math.round(currentTime * project.canvas.fps) / project.canvas.fps; if (!draft.markers.some((marker) => Math.abs(marker.time - time) < 1 / project.canvas.fps)) draft.markers.push({ id: `marker_${crypto.randomUUID().slice(0, 8)}`, time, label: `Marker ${draft.markers.length + 1}` }); });
  const addTrack = () => { mutateProject((draft) => { createLayerTrack(draft); }); closeMenu(); };
  const updateTrack = (trackId: string, field: 'hidden' | 'muted' | 'locked') => mutateProject((draft) => { const track = draft.tracks.find((item) => item.id === trackId); if (track) track[field] = !track[field]; });
  const duplicateTrack = (trackId: string) => { mutateProject((draft) => { const index = draft.tracks.findIndex((item) => item.id === trackId); if (index < 0) return; const source = draft.tracks[index]; const copy = { ...source, id: `track-${crypto.randomUUID().slice(0, 8)}`, name: `${source.name} kopya`, order: index + 1, clips: source.clips.map((clip) => ({ ...clip, id: `clip_${crypto.randomUUID().slice(0, 8)}` })) }; draft.tracks.splice(index + 1, 0, copy); draft.tracks.forEach((track, order) => { track.order = order; }); }); closeMenu(); };
  const moveTrack = (trackId: string, direction: -1 | 1) => { mutateProject((draft) => { const index = draft.tracks.findIndex((item) => item.id === trackId); const target = index + direction; if (index < 0 || target < 0 || target >= draft.tracks.length) return; [draft.tracks[index], draft.tracks[target]] = [draft.tracks[target], draft.tracks[index]]; draft.tracks.forEach((track, order) => { track.order = order; }); }); closeMenu(); };
  const deleteTrack = (trackId: string) => { mutateProject((draft) => { draft.tracks = draft.tracks.filter((track) => track.id !== trackId); draft.tracks.forEach((track, order) => { track.order = order; }); draft.duration = projectDuration(draft); }); setSelected(null, null); closeMenu(); };
  const deleteClip = (clipId: string, ripple = false) => { mutateProject((draft) => { if (ripple) rippleDeleteClip(draft, clipId); else { const track = draft.tracks.find((item) => item.clips.some((clip) => clip.id === clipId)); const clip = track?.clips.find((item) => item.id === clipId); if (track && clip && !track.locked) { track.clips = track.clips.filter((item) => item.id !== clipId); draft.duration = projectDuration(draft); } } }); setSelected(null, null); closeMenu(); };
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
    } catch { setNotice('Medya sürükleme verisi okunamadı.'); }
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
  const menuItems: ContextMenuItem[] = menu?.kind === 'add-track' ? [{ label: 'Yeni genel layer', icon: '◫', shortcut: 'Ctrl+Shift+L', onSelect: addTrack }] : menu?.kind === 'empty' ? [{ label: 'Buraya yeni layer ekle', icon: '◫', shortcut: 'Ctrl+Shift+L', onSelect: () => { if (menu.time !== undefined) setCurrentTime(menu.time); addTrack(); } }, { label: 'Playhead’i buraya taşı', icon: '⌖', onSelect: () => { if (menu.time !== undefined) setCurrentTime(menu.time); closeMenu(); } }] : menu?.kind === 'clip' && clip ? [
    { label: 'Özellikleri aç', icon: '⚙', shortcut: 'Enter', onSelect: () => { setSelected(clip.id, menu.trackId ?? null); closeMenu(); } },
    { label: 'Playhead’de böl', icon: '✂', shortcut: 'B', disabled: currentTime <= clip.start || currentTime >= clip.start + clip.duration, onSelect: () => splitClip(clip.id) },
    { label: 'Başlangıcı playhead’e kırp', icon: '◁', disabled: currentTime <= clip.start || currentTime >= clip.start + clip.duration, onSelect: () => trimSelectedClipToPlayhead(clip.id, 'start') },
    { label: 'Sonu playhead’e kırp', icon: '▷', disabled: currentTime <= clip.start || currentTime >= clip.start + clip.duration, onSelect: () => trimSelectedClipToPlayhead(clip.id, 'end') },
    { label: 'Çoğalt', icon: '⧉', onSelect: () => duplicateClip(clip.id) },
    { label: 'Klip verisini kopyala', icon: '⧉', onSelect: () => { void navigator.clipboard?.writeText(JSON.stringify(clip, null, 2)); closeMenu(); } },
    { label: 'Transformu sıfırla', icon: '⌗', onSelect: () => resetClip(clip.id, 'transform') },
    { label: 'Efektleri sıfırla', icon: '✦', onSelect: () => resetClip(clip.id, 'filters') },
    { label: clip.volume === 0 ? 'Sesi aç' : 'Sesi kapat', icon: '♫', onSelect: () => mutateProject((draft) => { const target = draft.tracks.flatMap((item) => item.clips).find((item) => item.id === clip.id); if (target) target.volume = target.volume === 0 ? 1 : 0; }) },
    { label: 'Sil', icon: '×', danger: true, shortcut: 'Del', onSelect: () => deleteClip(clip.id) },
    { label: 'Ripple delete', icon: '↔', danger: true, onSelect: () => deleteClip(clip.id, true) },
    { label: 'Medya panelinde göster', icon: '▧', onSelect: () => { setPanel('media'); closeMenu(); } },
  ] : menu?.kind === 'track' && track ? [
    { label: 'Yukarı taşı', icon: '↑', onSelect: () => moveTrack(track.id, -1) },
    { label: 'Aşağı taşı', icon: '↓', onSelect: () => moveTrack(track.id, 1) },
    { label: 'Üstüne layer ekle', icon: '＋', onSelect: () => addLayerRelative(track.id, -1) },
    { label: 'Altına layer ekle', icon: '＋', onSelect: () => addLayerRelative(track.id, 1) },
    { label: 'Yeniden adlandır', icon: '✎', onSelect: () => { setEditingTrackId(track.id); setEditingTrackName(track.name); closeMenu(); } },
    { label: 'Çoğalt', icon: '⧉', onSelect: () => duplicateTrack(track.id) },
    { label: track.locked ? 'Kilidi aç' : 'Kilitle', icon: '♙', onSelect: () => updateTrack(track.id, 'locked') },
    { label: track.muted ? 'Sesi aç' : 'Sustur', icon: '♫', onSelect: () => updateTrack(track.id, 'muted') },
    { label: track.hidden ? 'Göster' : 'Gizle', icon: '◉', onSelect: () => updateTrack(track.id, 'hidden') },
    { label: 'Sil', icon: '×', danger: true, onSelect: () => deleteTrack(track.id) },
  ] : menu?.kind === 'marker' && menu.markerId ? [{ label: 'Marker adını değiştir', icon: '✎', onSelect: () => { const marker = project.markers.find((item) => item.id === menu.markerId); const next = window.prompt('Marker adı', marker?.label ?? 'Marker'); if (next?.trim()) mutateProject((draft) => { const target = draft.markers.find((item) => item.id === menu.markerId); if (target) target.label = next.trim(); }); closeMenu(); } }, { label: 'Marker’ı sil', icon: '×', danger: true, onSelect: () => { mutateProject((draft) => { draft.markers = draft.markers.filter((item) => item.id !== menu.markerId); }); closeMenu(); } }] : [];
  // The active implementation below supersedes the removed legacy timeline prototype.
  return <section className="timeline timeline-pro" onContextMenu={(event) => { event.preventDefault(); const target = event.target as HTMLElement; if (target.closest('.timeline-clip,.track-label,.timeline-marker,.context-menu')) return; setMenu({ x: event.clientX, y: event.clientY, kind: 'empty', time: snapTime(timeFromClientX(event.clientX)) }); }}>
    <div className="timeline-toolbar"><div className="timeline-toolbar-left"><button className="timeline-tool active" title="Seçim" onClick={() => setSelected(null, null)}>↖</button><button className="timeline-tool" title={canSplit ? "Böl" : "Böl (klip seçip playhead'i klibin içine taşıyın)"} aria-label="Böl" disabled={!canSplit} onClick={() => selectedClipId && splitClip(selectedClipId)}>✂</button><button className="timeline-tool" title="Marker ekle" onClick={addMarker}>⊙</button><button className="timeline-tool" title="In noktası (I)" onClick={() => setRangeStart(currentTime)}>I</button><button className="timeline-tool" title="Out noktası (O)" onClick={() => setRangeEnd(currentTime)}>O</button>{(rangeStart !== null || rangeEnd !== null) && <button className="timeline-tool" title="In/Out temizle" onClick={clearRange}>×</button>}<button className={`timeline-tool snap-toggle ${snapEnabled ? 'active' : ''}`} title={snapEnabled ? 'Marker ve klip kenarı snap açık' : 'Snap kapalı'} aria-label="Marker ve klip kenarı snap" aria-pressed={snapEnabled} onClick={() => setSnapEnabled((value) => !value)}>⌁</button><button className="track-add-button" onClick={(event) => setMenu({ x: event.clientX, y: event.clientY, kind: 'add-track' })}>＋ Track</button></div><div className="timeline-toolbar-right"><span className="range-label">{rangeStart !== null && rangeEnd !== null ? `${formatTime(rangeStart)} – ${formatTime(rangeEnd)}` : 'In/Out yok'}</span><span className="zoom-label">{Math.round(px)} px/s</span><input aria-label="Timeline zoom" type="range" min="38" max="260" value={px} onChange={(event) => setZoom(Number(event.target.value))} /></div></div>
    <div className="timeline-fit-row"><button className="timeline-fit-button" onClick={fitTimeline}>↔ Timeline’a sığdır</button><span>Ctrl/⌘ + ←/→ ile klibi kare hassasiyetinde taşı</span></div>
    <div className="timeline-scroll" ref={timelineRef} onPointerMove={onPointerMove} onPointerUp={finishPointerAssetDrop} onPointerCancel={() => { setDrag(null); setDrop(null); setAssetDragId(null); }}>
      <div className="timeline-head"><div className="track-label-spacer" /><div className="ruler" onClick={seek}>{rulerTicks.map((tick) => <div key={tick} className="ruler-tick" style={{ left: tick * px }}><span>{formatTime(tick).slice(3)}</span></div>)}{rangeStart !== null && <button className="range-handle range-in" style={{ left: rangeStart * px }} title="In" onPointerDown={(event) => { event.stopPropagation(); setDrag({ kind: 'rangeStart' }); event.currentTarget.setPointerCapture(event.pointerId); }}>I</button>}{rangeEnd !== null && <button className="range-handle range-out" style={{ left: rangeEnd * px }} title="Out" onPointerDown={(event) => { event.stopPropagation(); setDrag({ kind: 'rangeEnd' }); event.currentTarget.setPointerCapture(event.pointerId); }}>O</button>}{project.markers.map((marker) => <button key={marker.id} className="timeline-marker" style={{ left: marker.time * px }} title={`${marker.label} · ${formatTime(marker.time, true, project.canvas.fps)}`} onClick={(event) => { event.stopPropagation(); setCurrentTime(marker.time); setSelected(null, null); }} onPointerDown={(event) => { event.stopPropagation(); setCurrentTime(marker.time); setDrag({ kind: 'marker', markerId: marker.id }); event.currentTarget.setPointerCapture(event.pointerId); }} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); setMenu({ x: event.clientX, y: event.clientY, kind: 'marker', markerId: marker.id }); }}><i /><span>{marker.label}</span></button>)}</div></div>
      <div className="timeline-content"><div className="track-labels">{project.tracks.map((item) => <div className={`track-label ${item.hidden ? 'is-hidden' : ''} ${item.muted ? 'is-muted' : ''}`} key={item.id} onContextMenu={(event) => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY, kind: 'track', trackId: item.id }); }}>{editingTrackId === item.id ? <input className="track-name-input" autoFocus value={editingTrackName} onChange={(event) => setEditingTrackName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { mutateProject((draft) => { const target = draft.tracks.find((track) => track.id === item.id); if (target && editingTrackName.trim()) target.name = editingTrackName.trim(); }); setEditingTrackId(null); } if (event.key === 'Escape') setEditingTrackId(null); }} onBlur={() => setEditingTrackId(null)} /> : <><span className="track-type">{item.type === 'audio' ? '♫' : item.type === 'text' ? 'T' : item.type === 'overlay' ? '◈' : '▧'}</span><span>{item.name}</span></>}<div className="track-actions"><button className={item.hidden ? 'active' : ''} title="Gizle/göster" onClick={() => updateTrack(item.id, 'hidden')}>◉</button><button className={item.muted ? 'active' : ''} title="Sessize al" onClick={() => updateTrack(item.id, 'muted')}>♫</button><button className={item.locked ? 'active' : ''} title="Kilitle" onClick={() => updateTrack(item.id, 'locked')}>♙</button><button title="Track seçenekleri" onClick={(event) => setMenu({ x: event.clientX, y: event.clientY, kind: 'track', trackId: item.id })}>•••</button></div></div>)}</div>
        <div className="tracks-canvas" onClick={seek}><div className="playhead" style={{ left: currentTime * px }} onPointerDown={(event) => { event.stopPropagation(); setDrag({ kind: 'playhead' }); event.currentTarget.setPointerCapture(event.pointerId); }}><div className="playhead-cap" /></div>{project.tracks.map((item) => <div data-track-id={item.id} className={`track-row ${item.locked ? 'locked' : ''} ${item.hidden ? 'is-hidden' : ''} ${drop?.trackId === item.id ? 'drop-target' : ''}`} key={item.id} onDragOver={(event) => { if (event.dataTransfer.types.includes('application/x-cutloc-asset')) { event.preventDefault(); setDrop({ trackId: item.id, time: snapTime(timeFromClientX(event.clientX)) }); } }} onDragLeave={() => setDrop((current) => current?.trackId === item.id ? null : current)} onDrop={(event) => dropAsset(event, item)}>{drop?.trackId === item.id && <div className="drop-ghost" title={draggedAsset ? `${draggedAsset.name} · ${formatTime(Math.max(draggedAsset.duration || 5, 0.5))}` : undefined} style={{ left: drop.time * px, width: dropGhostWidth }} />}{item.clips.map((itemClip) => <div key={itemClip.id} className={`timeline-clip clip-${itemClip.type} ${selectedClipIds.includes(itemClip.id) ? 'selected' : ''} ${item.locked ? 'disabled' : ''}`} style={{ left: itemClip.start * px, width: Math.max(36, itemClip.duration * px) }} onClick={(event) => { event.stopPropagation(); if (event.shiftKey || event.ctrlKey || event.metaKey) toggleSelected(itemClip.id, item.id); else if (selectedClipIds.length <= 1 || !selectedClipIds.includes(itemClip.id)) setSelected(itemClip.id, item.id); }} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); setSelected(itemClip.id, item.id); setMenu({ x: event.clientX, y: event.clientY, kind: 'clip', clipId: itemClip.id, trackId: item.id }); }} onPointerDown={(event) => { event.stopPropagation(); if (item.locked) return; if (event.shiftKey || event.ctrlKey || event.metaKey) { return; } if (!selectedClipIds.includes(itemClip.id)) setSelected(itemClip.id, item.id); const selectedIds = selectedClipIds.includes(itemClip.id) ? selectedClipIds : [itemClip.id]; const selectedStarts = Object.fromEntries(project.tracks.flatMap((track) => track.clips).filter((clip) => selectedIds.includes(clip.id)).map((clip) => [clip.id, clip.start])); const historyGroup = newHistoryGroup(); dragHistoryGroupRef.current = historyGroup; setDrag({ kind: 'clip', clipId: itemClip.id, trackId: item.id, startX: event.clientX, start: itemClip.start, selectedClipIds: selectedIds, selectedClipStarts: selectedStarts, historyGroup }); event.currentTarget.setPointerCapture(event.pointerId); }}><div className="clip-handle left" /><div className="clip-body"><span className="clip-icon">{itemClip.type === 'video' ? '▶' : itemClip.type === 'audio' ? '♫' : '▧'}</span><strong>{itemClip.name}</strong><small>{formatTime(itemClip.duration)}</small></div><div className="clip-handle right" /></div>)}</div>)}</div>
      </div>
    </div>
    {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={closeMenu} />}
  </section>;
}

function TimelineClip({ clip, selected, px, disabled, onSelect, onPointerDown }: { clip: Clip; selected: boolean; px: number; disabled?: boolean; onSelect: () => void; onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void }) { return <div className={`timeline-clip clip-${clip.type} ${selected ? 'selected' : ''} ${disabled ? 'disabled' : ''}`} style={{ left: clip.start * px, width: Math.max(36, clip.duration * px) }} onClick={(event) => { event.stopPropagation(); onSelect(); }} onPointerDown={onPointerDown}><div className="clip-handle left" /><div className="clip-body"><span className="clip-icon">{clip.type === 'video' ? '▶' : clip.type === 'audio' ? '♫' : clip.type === 'image' ? '▧' : 'T'}</span><strong>{clip.name}</strong><small>{formatTime(clip.duration)}</small></div><div className="clip-handle right" /></div>; }

function AppWrapper() {
  const language = useEditor((state) => state.settings?.language ?? 'en');
  return <StrictMode><UiLanguageBoundary language={language}><App /></UiLanguageBoundary></StrictMode>;
}

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('CutLoc root elementi bulunamadı.');
const root = createRoot(rootElement);
root.render(<AppWrapper />);
const hot = (import.meta as ImportMeta & { hot?: { dispose: (callback: () => void) => void } }).hot;
hot?.dispose(() => root.unmount());
