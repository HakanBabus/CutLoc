import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';
import { clamp, exportDimensions, formatTime, projectDuration, splitClipAt, type Asset, type ExportOptions, type ExportPreflight, type Job, type Project, type Settings, type WorkspaceLayout } from '@cutloc/shared';
import { useI18n, type TranslationKey } from '../i18n';
import { CommandPalette, type CommandAction } from '../components/command-palette';
import { ThemeSwitcher } from '../components/theme-switcher';
import { api } from './api';
import { Inspector } from './inspector';
import { AssetPanelPro } from './library';
import { createLayerTrack, createMediaClip, findEmptyPlacement } from './media-model';
import { PreviewArea } from './preview';
import { DEFAULT_SHORTCUTS, DEFAULT_WORKSPACE_LAYOUT, SHORTCUT_LABELS, matchesShortcut, shortcutValue, useEditor, type ExportStatus, type Panel, type ShortcutAction } from './store';
import { TimelinePro } from './timeline';
import { useProjectAccess } from './use-project-access';
import { useProjectAutosave } from './use-project-autosave';

function Glyph({ children }: { children: string }) { return <span className="glyph" aria-hidden="true">{children}</span>; }

export function Editor({ onBack }: { onBack: () => void }) {
  const { t } = useI18n();
  const project = useEditor((state) => state.project)!;
  const settings = useEditor((state) => state.settings);
  const setSettings = useEditor((state) => state.setSettings);
  const saveState = useEditor((state) => state.saveState);
  const applyServerProject = useEditor((state) => state.applyServerProject);
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
  const exportWatchCleanupRef = useRef<(() => void) | null>(null);
  const { projectAccess, projectAccessRef } = useProjectAccess(project.id, applyServerProject, saveTimerRef);
  const { saveProjectNow, savePromiseRef } = useProjectAutosave(project, projectAccess, projectAccessRef, saveTimerRef);

  useEffect(() => {
    if (settings?.workspaceLayout) setWorkspaceLayout({ ...DEFAULT_WORKSPACE_LAYOUT, ...settings.workspaceLayout });
  }, [settings?.workspaceLayout]);

  useEffect(() => {
    if (!editorNotice) return;
    const timeout = window.setTimeout(() => setEditorNotice(''), 5_500);
    return () => window.clearTimeout(timeout);
  }, [editorNotice, setEditorNotice]);

  const persistWorkspaceLayout = (next: WorkspaceLayout) => {
    setWorkspaceLayout(next);
    if (!settings) return;
    setSettings({ ...settings, workspaceLayout: next });
    void api<Settings>('/api/settings', { method: 'PUT', body: JSON.stringify({ workspaceLayout: next }) }).catch(() => setEditorNotice(t('editor.layoutSaveFailed')));
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (projectAccessRef.current) { event.preventDefault(); return; }
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'k') { event.preventDefault(); setShowCommandPalette((visible) => !visible); return; }
      const tag = (event.target as HTMLElement).tagName;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return;
      if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLocaleLowerCase() === 'm') { event.preventDefault(); useEditor.getState().setPanel('media'); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'e') { event.preventDefault(); setShowExport(true); }
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
      // Importing populates the library only.  The central reconciliation path
      // keeps the local timeline authoritative while a proxy is prepared.
      applyServerProject(result.project);
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
      if (!state.project) throw new Error(t('editor.projectNotFound'));
      if (state.saveState === 'offline') throw new Error(t('editor.exportOffline'));
      if (state.saveState === 'error') throw new Error(t('editor.fixPendingSave'));
      if (state.localRevision !== state.savedRevision) {
        await saveProjectNow();
        continue;
      }
      const confirmed = await api<Project>(`/api/projects/${state.project.id}`);
      const latestState = useEditor.getState();
      if (confirmed.revision !== latestState.savedRevision) {
        if (!latestState.project) throw new Error(t('editor.projectNotFound'));
        applyServerProject(confirmed);
        continue;
      }
      return confirmed;
    }
    throw new Error(t('editor.projectSaveVerificationFailed'));
  };
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
      void api<Job>('/api/jobs/' + jobId).then(applyJob).catch(() => {
        if (!settled && !source) setExportStatus((current) => ({ ...current, jobId, status: 'reconnecting', message: t('export.serverReconnecting') }));
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
        setExportStatus((current) => ({ ...current, jobId, status: 'reconnecting', message: t('export.connectionReconnecting') }));
        if (reconnectAttempts <= 3) {
          reconnectTimer = window.setTimeout(connect, 500 * reconnectAttempts);
        }
      };
    };

    exportWatchCleanupRef.current = cleanup;
    void api<Job>('/api/jobs/' + jobId).then(applyJob).catch(() => undefined);
    // SSE is the fast path. Polling closes the race where a short export
    // finishes between the initial job snapshot and the event connection.
    pollTimer = window.setTimeout(poll, 1000);
    connect();
  });

  const startExportResilient = async (options: ExportOptions): Promise<ExportPreflight> => {
    setExporting(true);
    try {
      setExportStatus({ progress: 0, status: 'saving', message: t('export.verifyingProjectSave') });
      const confirmedProject = await ensureProjectSaved();
      const requestBody = { ...options, projectRevision: confirmedProject.revision };
      setExportStatus({ progress: 0, status: 'preflight', message: t('export.preflightRunning') });
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
      setExportStatus({ jobId, progress: 0, status: 'queued', message: t('export.queued') });
      // Return preflight immediately so warnings and the estimated size are
      // visible while the background watcher follows the running job.
      void watchExportJob(jobId);
      return preflight;
    } catch (error) {
      setExporting(false);
      setExportStatus({ progress: 0, status: 'failed', error: error instanceof Error ? error.message : t('export.failedToStart') });
      throw error;
    }
  };


  const startExport = async (options: ExportOptions): Promise<ExportPreflight> => {
    return startExportResilient(options);
  };

  const commandActions: CommandAction[] = [
    { id: 'media', label: t('command.media'), icon: '▧', shortcut: 'M', run: () => useEditor.getState().setPanel('media') },
    { id: 'text', label: t('command.text'), icon: 'T', run: () => useEditor.getState().setPanel('text') },
    { id: 'animation', label: t('command.animation'), icon: '✧', run: () => useEditor.getState().setInspectorTab('motion') },
    { id: 'project', label: t('command.project'), icon: '◉', run: () => useEditor.getState().setPanel('project') },
    { id: 'playback', label: t('command.playback'), icon: '▶', shortcut: shortcutValue(settings, 'togglePlayback'), run: () => useEditor.getState().setPlaying(!useEditor.getState().playing) },
    { id: 'export', label: t('command.export'), icon: '↗', shortcut: 'Ctrl+E', run: () => setShowExport(true) },
    { id: 'settings', label: t('command.settings'), icon: '⚙', run: () => setShowSettings(true) },
  ];

  return <div className="editor-shell">
    <EditorTopbar project={project} onBack={handleBack} backPending={backPending} onExport={() => setShowExport(true)} exporting={exporting} onSettings={() => setShowSettings(true)} onCommands={() => setShowCommandPalette(true)} />
    <div className="editor-body workspace-layout" style={{ '--workspace-rail-width': `${workspaceLayout.railWidth}px`, '--workspace-library-width': `${workspaceLayout.libraryWidth}px`, '--workspace-inspector-width': `${workspaceLayout.inspectorWidth}px`, '--workspace-timeline-height': `${workspaceLayout.timelineHeight}px` } as React.CSSProperties}><ToolRail onOpenSettings={() => setShowSettings(true)} /><AssetPanelPro onImport={importMedia} onOpenSettings={() => setShowSettings(true)} /><PreviewArea project={project} settings={settings} /><Inspector project={project} /><TimelinePro project={project} /><WorkspaceResizers layout={workspaceLayout} onPreview={setWorkspaceLayout} onCommit={persistWorkspaceLayout} /></div>
    {exportMessage && <div className={`export-toast ${exporting ? 'active' : ''}`}><span className="export-pulse" />{exportMessage}{!exporting && <button onClick={() => setExportMessage('')}>×</button>}</div>}
    {editorNotice && <div className="export-toast editor-notice" role="status" aria-live="polite"><span className="editor-notice-icon" aria-hidden="true">i</span><span className="editor-notice-copy">{editorNotice}</span><button onClick={() => setEditorNotice('')} aria-label={t('common.close')}>×</button></div>}
    <div className="editor-statusbar"><span><i className="status-dot" /> {t('editor.status.ready')}</span><span>{saveState === 'saving' ? t('common.saving') : saveState === 'offline' ? t('editor.saveOffline') : saveState === 'error' ? t('common.saveError') : t('editor.status.allSaved')}</span><span>{t('editor.status.shortcuts', { undo: shortcutValue(settings, 'undo'), togglePlayback: shortcutValue(settings, 'togglePlayback') })}</span></div>
    {projectAccess && <div className="cli-access-lock" role="alert" aria-live="assertive"><section><span className="cli-access-badge">CLI</span><h2>{t('editor.access.cliTitle')}</h2><p>{t('editor.access.cliCopy', { owner: projectAccess.ownerLabel })}</p><small>{t('editor.access.cliHint')}</small></section></div>}
    {showCommandPalette && <CommandPalette actions={commandActions} onClose={() => setShowCommandPalette(false)} />}
    {showSettings && <SettingsModal settings={settings} onClose={() => setShowSettings(false)} />}
    {showExport && <ExportModal project={project} settings={settings} rangeStart={rangeStart} rangeEnd={rangeEnd} exporting={exporting} status={exportStatus} onStart={startExport} onAddFirstAsset={addFirstAssetToTimeline} onClose={() => setShowExport(false)} />}
  </div>;
}

function ExportModal({ project, settings, rangeStart, rangeEnd, exporting, status, onStart, onAddFirstAsset, onClose }: { project: Project; settings: Settings | null; rangeStart: number | null; rangeEnd: number | null; exporting: boolean; status: ExportStatus; onStart: (options: ExportOptions) => Promise<ExportPreflight>; onAddFirstAsset: () => boolean; onClose: () => void }) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLElement>(null);
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
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    return () => previousFocus?.focus();
  }, []);
  const handleDialogKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape' && !exporting) {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), input:not(:disabled), a[href]') ?? []);
    if (!focusable.length) {
      event.preventDefault();
      dialogRef.current?.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable.at(-1)!;
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  const done = status.status === 'completed';
  const isVideo = format === 'mp4';
  const usesCompressedAudio = format !== 'wav';
  const statusLabel = status.status === 'queued' ? t('export.status.queued')
    : status.status === 'running' ? t('export.status.running')
      : status.status === 'reconnecting' ? t('export.status.reconnecting')
        : status.status === 'completed' ? t('export.status.completed')
          : status.status === 'failed' ? t('export.status.failed')
            : status.status === 'cancelled' ? t('export.status.cancelled')
              : status.status === 'saving' ? t('export.status.saving')
                : status.status === 'preflight' ? t('export.status.preflight') : t('export.preparing');
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
    if (scope === 'range' && (rangeStart === null || rangeEnd === null || rangeEnd <= rangeStart)) {
      setError(t('export.invalidRange'));
      return;
    }
    try { setPreflight(await onStart(options())); }
    catch (submitError) { setError(submitError instanceof Error ? submitError.message : t('export.failedToStart')); }
  };
  return <div className="modal-backdrop export-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !exporting) onClose(); }}><section ref={dialogRef} className="export-modal" role="dialog" aria-modal="true" aria-labelledby="export-title" tabIndex={-1} onKeyDown={handleDialogKeyDown}>
    <div className="modal-head"><div><p className="eyebrow">{t('export.studio')}</p><h2 id="export-title">{t('export.title')}</h2><small>{project.name} · {t('export.timelineDuration', { duration: formatTime(project.duration, true, project.canvas.fps) })}</small></div><button onClick={onClose} disabled={exporting} aria-label={t('common.close')}>×</button></div>
    <div className="export-layout">
      <div className="export-form">
        <div className="export-section"><span className="export-label">{t('export.canvas')}</span><div className="export-canvas-readonly export-canvas-profile"><span>{t('export.canvasLocked')}</span><strong>{aspect} · {t('export.canvas')} {canvasHint}</strong><small>{isVideo ? t('export.output', { resolution: resolution === '2K' ? '1440p' : resolution, size: outputHint }) : t('export.audioOnlyOutput')}</small></div></div>
        <div className="export-grid-row"><label><span>{t('export.format')}</span><select value={format} onChange={(event) => setFormat(event.target.value as ExportOptions['format'])} disabled={exporting}><option value="mp4">MP4 · H.264 + AAC</option><option value="mp3">{t('export.mp3')}</option><option value="wav">{t('export.wav')}</option></select></label>{isVideo ? <label><span>{t('export.resolution')}</span><select aria-label={t('export.outputResolution')} value={resolution} onChange={(event) => setResolution(event.target.value as ExportOptions['resolution'])} disabled={exporting}><option value="720p">720p · HD</option><option value="1080p">1080p · Full HD</option><option value="2K">1440p · 2K</option><option value="4K">2160p · 4K UHD</option></select></label> : <div className="export-format-note"><span>{t('export.outputType')}</span><strong>{format === 'wav' ? t('export.losslessAudio') : t('export.compressedAudio')}</strong></div>}</div>
        <div className="export-grid-row">{isVideo && <label><span>{t('export.frameRate')}</span><select value={fps} onChange={(event) => setFps(Number(event.target.value) as ExportOptions['fps'])} disabled={exporting}><option value={24}>24 FPS</option><option value={25}>25 FPS</option><option value={30}>30 FPS</option><option value={50}>50 FPS</option><option value={60}>60 FPS</option></select></label>}{usesCompressedAudio && <label><span>{t('export.audioBitrate')}</span><select value={audioBitrateKbps} onChange={(event) => setAudioBitrateKbps(Number(event.target.value) as 128 | 192 | 256)} disabled={exporting}><option value={128}>128 kbps</option><option value={192}>192 kbps</option><option value={256}>256 kbps</option></select></label>}{!isVideo && !usesCompressedAudio && <div className="export-format-note export-format-note-wide"><span>{t('export.audioBitrate')}</span><strong>{t('export.pcmAudio')}</strong></div>}</div>
        {isVideo && <div className="export-section"><span className="export-label">{t('export.quality')}</span><div className="quality-tabs">{(['draft', 'standard', 'high', 'custom'] as const).map((value) => <button key={value} className={quality === value ? 'active' : ''} onClick={() => setQuality(value)} disabled={exporting}>{t(`export.quality.${value}` as TranslationKey)}</button>)}</div>{quality === 'custom' && <div className="advanced-quality"><label><span>{t('export.rateMode')}</span><select value={rateMode} onChange={(event) => setRateMode(event.target.value as ExportOptions['rateMode'])}><option value="crf">CRF</option><option value="bitrate">Bitrate</option></select></label>{rateMode === 'crf' ? <label><span>CRF (16–32)</span><input type="number" min={16} max={32} value={crf} onChange={(event) => setCrf(Number(event.target.value))} /></label> : <label><span>{t('export.videoBitrate')}</span><input type="number" min={500} max={50000} step={500} value={videoBitrateKbps} onChange={(event) => setVideoBitrateKbps(Number(event.target.value))} /></label>}</div>}</div>}
        <div className="export-section"><span className="export-label">{t('export.scope')}</span><div className="scope-toggle"><button className={scope === 'all' ? 'active' : ''} onClick={() => setScope('all')} disabled={exporting}>{t('export.allTimeline')}</button><button className={scope === 'range' ? 'active' : ''} onClick={() => setScope('range')} disabled={exporting || rangeStart === null || rangeEnd === null}>In–Out {rangeStart !== null && rangeEnd !== null ? `(${formatTime(rangeEnd - rangeStart)})` : t('common.notSet')}</button></div></div>
        <label className="export-file-name"><span>{t('export.fileName')}</span><input value={fileName} onChange={(event) => setFileName(event.target.value)} disabled={exporting} /></label>
      </div>
      <aside className="export-summary"><div className="summary-icon">↗</div><strong>{isVideo ? t('export.videoExport') : t('export.audioExport')}</strong><p>{isVideo ? `${aspect} · ${outputHint} · ${fps} FPS` : format === 'mp3' ? `MP3 · ${audioBitrateKbps} kbps` : 'WAV · PCM'}</p>{isVideo && <div className="summary-row"><span>{t('export.quality')}</span><b>{t(`export.quality.${quality}` as TranslationKey)}</b></div>}<div className="summary-row"><span>Codec</span><b>{isVideo ? 'H.264 / AAC' : format === 'mp3' ? 'MP3' : 'PCM'}</b></div>{preflight?.warnings.map((warning) => <div className="export-warning" key={warning.code}>⚠ {warning.message}</div>)}{status.status && <div className="export-progress"><div className="progress-head"><strong>{statusLabel}</strong><span>{status.message || statusLabel}</span><b>{Math.round(status.progress * 100)}%</b></div><div className="progress-track"><i style={{ width: `${Math.max(2, status.progress * 100)}%` }} /></div></div>}{status.error && status.error !== error && <div className="export-error">{status.error}</div>}{done && status.downloadUrl && <div className="export-complete"><span>✓ {t('common.ready')}</span><strong>{status.fileName}</strong><a className="secondary-button" href={status.downloadUrl} download={status.fileName}>{t('common.download')}</a></div>}</aside>
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
    ? t('common.saving')
    : saveState === 'error'
      ? t('common.saveError')
      : saveState === 'offline'
        ? t('editor.status.offlinePending')
        : saveTime ? `${t('common.saved')} · ${saveTime}` : t('common.saved');
  const saveTitle = saveState === 'saved' && saveTime ? t('editor.status.lastSavedAt', { time: saveTime }) : saveLabel;
  return <header className="editor-topbar"><div className="topbar-left"><button className="back-button" disabled={backPending} aria-busy={backPending} onClick={onBack}>&#8249;</button><div className="editor-brand"><div className="mini-mark">CL</div><span>CUTLOC</span></div><div className="topbar-divider" /><input className="project-name-input" value={project.name} onChange={(event) => mutateProject((draft) => { draft.name = event.target.value; })} /></div><div className="topbar-center"><button className="history-button" onClick={undo} title={t('common.undo')}>&#8630;</button><button className="history-button" onClick={redo} title={t('common.redo')}>&#8631;</button><button className="topbar-command-button" onClick={onCommands} title={t('command.open')}><span>&#8981;</span><small>{t('command.title')}</small><kbd>&#8984; K</kbd></button><span className={'save-indicator ' + saveState} title={saveTitle} aria-live="polite"><i className={'status-dot ' + saveState} /> {saveLabel}</span></div><div className="topbar-right"><ThemeSwitcher compact /><button className="export-button" disabled={exporting} onClick={onExport}>{exporting ? t('common.exporting') : t('common.export')} <Glyph>&#8599;</Glyph></button><button className="icon-button editor-settings" onClick={onSettings} title={t('common.settings')}><Glyph>&#9881;</Glyph></button><button className="avatar-button" onClick={onSettings} title={t('common.settings')}>HK</button></div></header>;
}

export function SettingsModal({ settings, onClose }: { settings: Settings | null; onClose: () => void }) {
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
  const generalSettings = <div className="settings-sections">
    <section className="settings-section">
      <div className="settings-section-heading"><span aria-hidden="true">Aa</span><div><strong>{t('settings.interface')}</strong><small>{t('settings.interfaceHint')}</small></div></div>
      <label className="setting-row"><span><strong>{t('settings.language')}</strong><small>{t('settings.languageHint')}</small></span><select aria-label={t('settings.language')} value={form.language} onChange={(event) => setForm({ ...form, language: event.target.value as 'en' | 'tr' })}><option value="en">English</option><option value="tr">Türkçe</option></select></label>
      <label className="setting-row"><span><strong>{t('settings.previewQuality')}</strong><small>{t('settings.previewQualityHint')}</small></span><select value={form.proxyQuality} onChange={(event) => setForm({ ...form, proxyQuality: event.target.value as 'draft' | 'balanced' | 'high' })}><option value="draft">{t('settings.previewQuality.draft')}</option><option value="balanced">{t('settings.previewQuality.balanced')}</option><option value="high">{t('settings.previewQuality.high')}</option></select></label>
    </section>
    <section className="settings-section">
      <div className="settings-section-heading"><span aria-hidden="true">↗</span><div><strong>{t('settings.exportDefaults')}</strong><small>{t('settings.exportDefaultsHint')}</small></div></div>
      <div className="settings-control-grid">
        <label><span>{t('export.format')}</span><select value={form.defaultExport.format} onChange={(event) => setForm({ ...form, defaultExport: { ...form.defaultExport, format: event.target.value as typeof form.defaultExport.format } })}><option value="mp4">MP4</option><option value="mp3">MP3</option><option value="wav">WAV</option></select></label>
        <label><span>{t('settings.resolution')}</span><select value={form.defaultExport.resolution} onChange={(event) => setForm({ ...form, defaultExport: { ...form.defaultExport, resolution: event.target.value as typeof form.defaultExport.resolution } })}><option value="720p">720p</option><option value="1080p">1080p</option><option value="2K">1440p</option><option value="4K">4K UHD</option></select></label>
        <label><span>{t('export.frameRate')}</span><select value={form.defaultExport.fps} onChange={(event) => setForm({ ...form, defaultExport: { ...form.defaultExport, fps: Number(event.target.value) as typeof form.defaultExport.fps } })}>{[24, 25, 30, 50, 60].map((fps) => <option key={fps} value={fps}>{fps} FPS</option>)}</select></label>
        <label><span>{t('export.quality')}</span><select value={form.defaultExport.quality} onChange={(event) => setForm({ ...form, defaultExport: { ...form.defaultExport, quality: event.target.value as typeof form.defaultExport.quality } })}><option value="draft">{t('export.quality.draft')}</option><option value="standard">{t('export.quality.standard')}</option><option value="high">{t('export.quality.high')}</option><option value="custom">{t('export.quality.custom')}</option></select></label>
      </div>
      <div className="setting-row setting-readonly"><span><strong>{t('settings.encoder')}</strong><small>{t('settings.encoderHint')}</small></span><b><i /> H.264 · CPU</b></div>
    </section>
    <section className="settings-section settings-layout-section">
      <div className="settings-section-heading"><span aria-hidden="true">▦</span><div><strong>{t('settings.layout')}</strong><small>{t('settings.layoutHint')}</small></div></div>
      <button type="button" className="settings-reset-layout" onClick={() => setForm({ ...form, workspaceLayout: { ...DEFAULT_WORKSPACE_LAYOUT } })}><span>↺</span><div><strong>{t('settings.resetLayout')}</strong><small>{t('settings.resetLayoutHint')}</small></div></button>
    </section>
  </div>;
  return <div className="modal-backdrop settings-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="settings-modal settings-modal-v2" role="dialog" aria-modal="true" aria-labelledby="settings-title"><div className="modal-head settings-modal-head"><div><p className="eyebrow">{t('settings.workspace')}</p><h2 id="settings-title">{t('settings.title')}</h2><small>{t('settings.copy')}</small></div><button onClick={onClose} aria-label={t('common.close')}>×</button></div><div className="settings-layout"><nav className="settings-tabs" aria-label={t('settings.title')}><button className={activeTab === 'general' ? 'active' : ''} onClick={() => setActiveTab('general')}><span aria-hidden="true">⚙</span><div><strong>{t('settings.general')}</strong><small>{t('settings.generalHint')}</small></div></button><button className={activeTab === 'shortcuts' ? 'active' : ''} onClick={() => setActiveTab('shortcuts')}><span aria-hidden="true">⌨</span><div><strong>{t('settings.shortcuts')}</strong><small>{t('settings.shortcutsHint')}</small></div></button><div className="settings-local-card"><span>●</span><strong>{t('settings.localFirst')}</strong><small>{t('settings.localFirstHint')}</small></div></nav><div className="settings-content">{activeTab === 'general' && generalSettings}{activeTab === 'shortcuts' && <div className="shortcut-settings"><div className="settings-intro"><strong>{t('settings.editShortcuts')}</strong><small>{t('settings.shortcutHint')}</small></div>{(Object.keys(SHORTCUT_LABELS) as ShortcutAction[]).map((action) => { const label = t(SHORTCUT_LABELS[action].labelKey); return <label className="shortcut-setting-row" key={action}><span><strong>{label}</strong><small>{t(SHORTCUT_LABELS[action].descriptionKey)}</small></span><input type="text" maxLength={40} autoComplete="off" spellCheck={false} aria-label={t('settings.shortcutAria', { label })} value={form.shortcuts[action]} onChange={(event) => setForm({ ...form, shortcuts: { ...form.shortcuts, [action]: event.target.value } })} /></label>; })}</div>}</div></div><div className="modal-actions settings-actions"><span role="status" aria-live="polite">{status}</span><button className="secondary-button" onClick={onClose}>{t('common.cancel')}</button><button className="primary-button" onClick={() => void save()}>{t('common.save')}</button></div></section></div>;
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
    ['elements', '◇', 'editor.panel.elements'], ['project', '◉', 'editor.panel.project'],
  ];
  return <aside className="tool-rail" aria-label={t('editor.tools')}><div className="rail-caption">{t('editor.project')}</div><div className="rail-scroll">{tools.map(([key, icon, label]) => <button key={key} className={panel === key ? 'active' : ''} onClick={() => setPanel(key)}><span>{icon}</span><small>{t(label)}</small></button>)}</div><div className="rail-spacer" /><button onClick={onOpenSettings}><span>⚙</span><small>{t('common.settings')}</small></button></aside>;
}
