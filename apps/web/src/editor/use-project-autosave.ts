import { useCallback, useEffect, useRef, type MutableRefObject, type RefObject } from 'react';
import { mergeProjectThreeWay, type Project, type ProjectAccessLease } from '@cutloc/shared';
import { useI18n } from '../i18n';
import { api, ApiError } from './api';
import { useEditor } from './store';

class ProjectConflictError extends Error {
  constructor(readonly paths: string[]) {
    super('This project has edits from another tab that conflict with your local changes. Your edits remain open; reload the project to review and recover them.');
    this.name = 'ProjectConflictError';
  }
}

export function useProjectAutosave(project: Project, projectAccess: ProjectAccessLease | null, projectAccessRef: RefObject<ProjectAccessLease | null>, saveTimerRef: MutableRefObject<number | null>) {
  const { t } = useI18n();
  const saveState = useEditor((state) => state.saveState);
  const localRevision = useEditor((state) => state.localRevision);
  const savedRevision = useEditor((state) => state.savedRevision);
  const acknowledgeSaved = useEditor((state) => state.acknowledgeSaved);
  const setSaveState = useEditor((state) => state.setSaveState);
  const setEditorNotice = useEditor((state) => state.setNotice);
  const savePromiseRef = useRef<Promise<void> | null>(null);

  const saveProjectNow = useCallback(async (): Promise<void> => {
    if (savePromiseRef.current) return savePromiseRef.current;
    const promise = (async () => {
      const beforeSave = useEditor.getState();
      const snapshot = beforeSave.project;
      if (!snapshot) return;
      if (projectAccessRef.current) throw new Error(t('editor.access.cliCopy', { owner: projectAccessRef.current.ownerLabel }));
      if (beforeSave.localRevision === beforeSave.savedRevision && beforeSave.saveState === 'saved') return;
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        setSaveState('offline');
        throw new Error(t('editor.saveOffline'));
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
            const base = useEditor.getState().lastSavedProject;
            if (!base) throw error;
            const merged = mergeProjectThreeWay(base, candidate, latest);
            if (merged.conflicts.length) throw new ProjectConflictError(merged.conflicts);
            candidate = merged.project;
          }
        }
        if (!saved) throw new Error(t('editor.projectSaveFailed'));
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
        setEditorNotice(offline ? t('editor.saveOffline') : error instanceof Error ? t('editor.saveErrorWithReason', { reason: error.message }) : t('common.saveError'));
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
  }, [acknowledgeSaved, projectAccessRef, setEditorNotice, setSaveState, t]);

  useEffect(() => {
    if (!project || projectAccess || saveState !== 'saving' || localRevision === savedRevision) return;
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
  }, [localRevision, project, projectAccess, saveProjectNow, saveState, saveTimerRef, savedRevision]);

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

  return { saveProjectNow, savePromiseRef };
}
