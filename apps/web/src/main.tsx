import { StrictMode, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  projectDuration,
  formatTime,
  type Asset,
  type Project,
  type Settings,
} from '@cutloc/shared';
import './styles.css';
import './preview-redesign.css';
import './product-refresh.css';
import { I18nProvider, useI18n } from './i18n';
import { ConfirmDialog, MessageDialog } from './components/dialogs';
import { ThemeSwitcher } from './components/theme-switcher';
import { Editor, SettingsModal } from './editor/workspace';
import { createLayerTrack, createMediaClip, findEmptyPlacement } from './editor/media-model';
import { normalizeProjectDurations } from './editor/preview';
import { api } from './editor/api';
import { useEditor, type TrashEntry } from './editor/store';

function Glyph({ children }: { children: string }) { return <span className="glyph" aria-hidden="true">{children}</span>; }

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
  const [trashAction, setTrashAction] = useState<{ kind: 'restore' | 'purge'; entry: TrashEntry } | null>(null);
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
    if (!entry) return;
    try {
      const restored = await api<Project>('/api/trash/' + encodeURIComponent(trashId) + '/restore', { method: 'POST', body: JSON.stringify({}) });
      setProjects((items) => [restored, ...items]);
      setTrash((items) => items.filter((item) => item.trashId !== trashId));
      setNotice(t('dashboard.restored'));
    } catch (error) { setNotice(error instanceof Error ? error.message : t('dashboard.restoreFailed')); }
  };

  const purgeTrash = async (trashId: string) => {
    const entry = trash.find((item) => item.trashId === trashId);
    if (!entry) return;
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
      {screen === 'dashboard' ? <Dashboard projects={projects} trash={trash} loading={loading} onCreate={createProject} onStartWithMedia={startWithMedia} onOpen={openProject} onDelete={requestDeleteProject} onRestoreTrash={(trashId) => { const entry = trash.find((item) => item.trashId === trashId); if (entry) setTrashAction({ kind: 'restore', entry }); }} onPurgeTrash={(trashId) => { const entry = trash.find((item) => item.trashId === trashId); if (entry) setTrashAction({ kind: 'purge', entry }); }} onSettings={() => setShowSettings(true)} onImportBundle={importBundle} /> : project ? <Editor onBack={returnToDashboard} /> : null}
    </div>
    {screenTransition !== 'idle' && <div className={`route-transition ${screenTransition === 'enter' ? 'route-transition-enter' : ''}`} aria-hidden="true"><div className="route-transition-orbit"><i /><i /><i /></div><span>{t(screen === 'editor' ? 'route.editor' : 'route.dashboard')}</span></div>}
    {screen === 'dashboard' && showSettings && <SettingsModal settings={useEditor.getState().settings} onClose={() => setShowSettings(false)} />}
    {screen === 'dashboard' && deleteCandidate && <ConfirmDialog title={t('dashboard.confirmTitle')} message={t('dashboard.confirmMessage', { name: deleteCandidate.name })} confirmLabel={t('dashboard.moveToTrash')} onConfirm={() => void deleteProject()} onClose={() => setDeleteCandidate(null)} />}
    {screen === 'dashboard' && trashAction && <ConfirmDialog title={t(trashAction.kind === 'restore' ? 'common.restore' : 'common.deletePermanently')} message={t(trashAction.kind === 'restore' ? 'dashboard.restoreConfirm' : 'dashboard.purgeConfirm', { name: trashAction.entry.name })} confirmLabel={t(trashAction.kind === 'restore' ? 'common.restore' : 'common.deletePermanently')} danger={trashAction.kind === 'purge'} onConfirm={() => { const action = trashAction; setTrashAction(null); void (action.kind === 'restore' ? restoreTrash(action.entry.trashId) : purgeTrash(action.entry.trashId)); }} onClose={() => setTrashAction(null)} />}
    {notice && <div className="toast toast-error"><Glyph>!</Glyph>{notice}<button onClick={() => setNotice('')}>×</button></div>}
  </div>;
}

function Dashboard({ projects, trash, loading, onCreate, onStartWithMedia, onOpen, onDelete, onRestoreTrash, onPurgeTrash, onSettings, onImportBundle }: { projects: Project[]; trash: TrashEntry[]; loading: boolean; onCreate: () => void; onStartWithMedia: (file: File) => void; onOpen: (id: string) => void; onDelete: (id: string) => void; onRestoreTrash: (trashId: string) => void; onPurgeTrash: (trashId: string) => void; onSettings: () => void; onImportBundle: (bundle: unknown) => void }) {
  const { language, t } = useI18n();
  const bundleInputRef = useRef<HTMLInputElement>(null);
  const mediaFileRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<'recent' | 'name'>('recent');
  const [bundleError, setBundleError] = useState(false);
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
      setBundleError(true);
    }
  };
  return <main key={language} className="dashboard">
    <header className="dashboard-header">
      <div className="brand"><img className="brand-logo" src="/favicon.svg" alt="" /><div><strong>CutLoc</strong><small>{t('brand.tagline')}</small></div></div>
      <div className="header-actions"><button className="secondary-button dashboard-bundle-import" onClick={() => bundleInputRef.current?.click()}>{t('dashboard.openBundle')}</button><input ref={bundleInputRef} className="hidden-input" type="file" accept=".json,.cutloc,.cutloc.json,application/json,application/zip" onChange={(event) => { const file = event.target.files?.[0]; if (file) void readBundle(file); event.target.value = ''; }} /><ThemeSwitcher /><button className="icon-button" title={t('common.settings')} onClick={onSettings}><Glyph>⚙</Glyph></button></div>
    </header>
    <section className="dashboard-hero">
      <div><p className="eyebrow">{t('dashboard.hero.eyebrow')}</p><h1>{t('dashboard.hero.titleLead')} <em>{t('dashboard.hero.titleAccent')}</em><br />{t('dashboard.hero.titleTail')}</h1><p className="hero-copy">{t('dashboard.hero.copy')}</p><button className="primary-button large" onClick={onCreate}><Glyph>＋</Glyph> {t('dashboard.newProject')}</button></div>
      <div className="hero-editor-demo" aria-hidden="true">
        <div className="hero-editor-top"><span className="hero-window-dots"><i /><i /><i /></span><strong>{t('dashboard.heroDemo.project')}</strong><span className="hero-demo-export">{t('common.export')} ↗</span></div>
        <div className="hero-editor-workspace">
          <div className="hero-demo-rail"><i className="active">▣</i><i>T</i><i>◈</i><i>⌁</i></div>
          <div className="hero-demo-stage"><span className="hero-demo-stage-label">{t('dashboard.heroDemo.preview')} · 16:9</span><div className="hero-demo-canvas"><div className="hero-demo-subject"><i /><b>CUT<br />WITH<br /><em>INTENT</em></b></div><span className="hero-demo-play">▶</span></div></div>
          <div className="hero-demo-speed"><div><small>{t('dashboard.heroDemo.speed')}</small><strong>1.50×</strong></div><svg viewBox="0 0 118 56"><path className="grid" d="M4 12H114M4 28H114M4 44H114" /><path className="curve" d="M4 43C29 43 39 34 55 27S87 12 114 10" /><circle cx="55" cy="27" r="3" /></svg><span><i>{t('dashboard.heroDemo.source')}</i><b>00:12</b><i>→</i><b>00:08</b></span></div>
        </div>
        <div className="hero-demo-timeline"><div className="hero-demo-time"><span>00:00:04:12</span><i>{t('dashboard.heroDemo.localPreview')}</i></div><div className="hero-demo-tracks"><span className="hero-demo-playhead" /><div><b /><b /><b /></div><div><b /><b /></div><div className="wave"><b /></div></div></div>
      </div>
    </section>
    <section className="dashboard-command-strip" aria-label={t('dashboard.quickStart')}>
      <button className="command-card command-primary" onClick={onCreate}><span className="command-icon">＋</span><span><strong>{t('dashboard.command.new')}</strong><small>{t('dashboard.command.newHint')}</small></span><b>↗</b></button>
      <button className="command-card" onClick={() => mediaFileRef.current?.click()}><span className="command-icon">▣</span><span><strong>{t('dashboard.command.media')}</strong><small>{t('dashboard.command.mediaHint')}</small></span><b>↗</b></button>
      {projects[0] ? <button className="command-card" onClick={() => onOpen(projects[0].id)}><span className="command-icon">▶</span><span><strong>{t('dashboard.command.continue')}</strong><small>{projects[0].name} · {formatTime(projects[0].duration)}</small></span><b>↗</b></button> : <div className="command-card command-muted"><span className="command-icon">⌁</span><span><strong>{t('dashboard.command.local')}</strong><small>{t('dashboard.command.localHint')}</small></span></div>}
    </section>
    <input ref={mediaFileRef} className="hidden-input" type="file" accept="video/*,audio/*,image/*" aria-label={t('dashboard.mediaPicker')} onChange={(event) => { const file = event.target.files?.[0]; if (file) onStartWithMedia(file); event.target.value = ''; }} />
    <section className="projects-section">
      <div className="section-heading dashboard-project-heading"><div><p className="eyebrow">{t('dashboard.workspace')}</p><h2>{t('dashboard.drafts')}</h2></div><span className="project-count">{query ? t('dashboard.filteredCount', { visible: visibleProjects.length, total: projects.length }) : t('common.projects', { count: projects.length })}</span></div>
      <div className="dashboard-project-tools"><label className="project-search"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('dashboard.searchPlaceholder')} aria-label={t('dashboard.searchPlaceholder')} />{query && <button onClick={() => setQuery('')} aria-label={t('common.close')}>×</button>}</label><select value={sort} onChange={(event) => setSort(event.target.value as 'recent' | 'name')} aria-label={t('common.search')}><option value="recent">{t('dashboard.sortRecent')}</option><option value="name">{t('dashboard.sortName')}</option></select></div>
      <div className="dashboard-insights"><span><b>{projects.reduce((total, item) => total + item.assets.length, 0)}</b> {t('dashboard.mediaAssets', { count: projects.reduce((total, item) => total + item.assets.length, 0) }).replace(/^\d+\s*/, '')}</span><span><b>{projects.filter((item) => item.duration > 0).length}</b> {t('dashboard.activeTimelines', { count: projects.filter((item) => item.duration > 0).length }).replace(/^\d+\s*/, '')}</span><span><b>Ctrl / ⌘ Z</b> {t('dashboard.undoHint')}</span></div>
      {loading ? <div className="empty-state"><div className="spinner" /> {t('dashboard.loading')}</div> : projects.length === 0 ? <div className="empty-state empty-dashed"><div className="empty-icon">✦</div><h3>{t('dashboard.emptyTitle')}</h3><p>{t('dashboard.emptyCopy')}</p><button className="secondary-button" onClick={onCreate}>{t('dashboard.command.new')}</button></div> : visibleProjects.length === 0 ? <div className="empty-state empty-dashed"><div className="empty-icon">⌕</div><h3>{t('dashboard.noSearchTitle')}</h3><p>{t('dashboard.noSearchCopy')}</p></div> : <div className="project-grid">{visibleProjects.map((item) => <ProjectCard key={item.id} project={item} onOpen={() => onOpen(item.id)} onDelete={() => onDelete(item.id)} />)}</div>}
    </section>
    <TrashSection entries={trash} onRestore={onRestoreTrash} onPurge={onPurgeTrash} />
    <footer className="dashboard-footer"><span><i className="status-dot" /> {t('dashboard.dataLocal')}</span><span>CutLoc <b>v0.1.0 beta</b></span></footer>
    {bundleError && <MessageDialog title={t('dashboard.importFailed')} message={t('dashboard.bundleError')} onClose={() => setBundleError(false)} />}
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
  const coverAsset = project.assets.find((asset) => asset.type === 'image') ?? project.assets.find((asset) => asset.type === 'video' && asset.thumbnailPath);
  const coverUrl = coverAsset ? `/api/projects/${project.id}/media/${coverAsset.id}${coverAsset.thumbnailPath ? '?thumbnail=1' : ''}` : null;
  return <article className="project-card" onDoubleClick={onOpen}>
    <button className={`project-preview ${accent}`} onClick={onOpen}>{coverUrl && <img className="project-preview-media" src={coverUrl} alt="" loading="lazy" onError={(event) => { event.currentTarget.hidden = true; }} />}<div className="preview-grid" /><span className="project-play">▶</span><span className="aspect-tag">{project.canvas.width}:{project.canvas.height}</span></button>
    <div className="project-card-info"><div><div className="project-card-title"><h3>{project.name}</h3><span className={`project-status ${hasTimeline ? 'ready' : ''}`}>{t(hasTimeline ? 'dashboard.statusEdited' : 'dashboard.statusStarter')}</span></div><p>{formatDate(project.updatedAt, { day: '2-digit', month: 'short' })} · {formatTime(project.duration)} · {project.assets.length} {t('common.media')}</p></div><button className="more-button" onClick={onDelete} title={t('dashboard.moveToTrash')}>•••</button></div>
  </article>;
}

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
