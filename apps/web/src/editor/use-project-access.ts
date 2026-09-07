import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { Project, ProjectAccessLease } from '@cutloc/shared';
import { api } from './api';
import { useEditor } from './store';

export function useProjectAccess(projectId: string, applyServerProject: (project: Project) => void, saveTimerRef: MutableRefObject<number | null>) {
  const [projectAccess, setProjectAccess] = useState<ProjectAccessLease | null>(null);
  const projectAccessRef = useRef<ProjectAccessLease | null>(null);

  useEffect(() => {
    let disposed = false;
    const events = new EventSource('/api/events');
    const applyAccess = (lease: ProjectAccessLease | null) => {
      if (disposed) return;
      const wasLocked = Boolean(projectAccessRef.current);
      projectAccessRef.current = lease;
      setProjectAccess(lease);
      if (lease) {
        if (saveTimerRef.current !== null) {
          window.clearTimeout(saveTimerRef.current);
          saveTimerRef.current = null;
        }
        useEditor.getState().setPlaying(false);
      } else if (wasLocked) {
        void api<Project>(`/api/projects/${projectId}`).then(applyServerProject).catch(() => undefined);
      }
    };
    const refresh = () => {
      void api<{ lease: ProjectAccessLease | null }>(`/api/projects/${projectId}/access`)
        .then((result) => applyAccess(result.lease))
        .catch(() => undefined);
    };
    const onAccess = (event: Event) => {
      try {
        const update = JSON.parse((event as MessageEvent).data) as { projectId?: string; lease?: ProjectAccessLease | null };
        if (update.projectId === projectId) applyAccess(update.lease ?? null);
      } catch { /* polling remains available when an event is malformed */ }
    };
    events.addEventListener('project-access', onAccess);
    const poll = window.setInterval(refresh, 3_000);
    refresh();
    return () => {
      disposed = true;
      window.clearInterval(poll);
      events.removeEventListener('project-access', onAccess);
      events.close();
      projectAccessRef.current = null;
    };
  }, [applyServerProject, projectId, saveTimerRef]);

  return { projectAccess, projectAccessRef };
}
