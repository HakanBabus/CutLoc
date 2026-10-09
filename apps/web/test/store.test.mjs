import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultProject } from '@cutloc/shared';

const storage = new Map();
globalThis.window = {
  localStorage: {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  },
  setTimeout,
  clearTimeout,
  addEventListener() {},
};
globalThis.document = { addEventListener() {} };
const { useEditor } = await import('../src/editor/store.ts');

test('an acknowledgement with a newer server revision keeps in-flight edits dirty and recoverable', async () => {
  const base = defaultProject('ack-dirty', 'Original');
  useEditor.getState().setProject(base);
  useEditor.getState().mutateProject((draft) => { draft.name = 'First edit'; });
  const snapshot = useEditor.getState().project;
  useEditor.getState().mutateProject((draft) => { draft.name = 'Second edit'; });
  useEditor.getState().acknowledgeSaved({ ...snapshot, revision: 10 }, snapshot);
  const state = useEditor.getState();
  assert.equal(state.project.name, 'Second edit');
  assert.ok(state.localRevision > state.savedRevision);
  assert.equal(state.saveState, 'saving');
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(JSON.parse(storage.get(`cutloc-project-draft:${base.id}`)).project.name, 'Second edit');
});

test('an acknowledgement retains remote changes alongside edits made during the request', () => {
  const base = defaultProject('ack-merge', 'Original');
  useEditor.getState().setProject(base);
  useEditor.getState().mutateProject((draft) => { draft.name = 'Submitted'; });
  const snapshot = useEditor.getState().project;
  useEditor.getState().mutateProject((draft) => { draft.name = 'Latest local'; });
  const saved = { ...snapshot, revision: 10, canvas: { ...snapshot.canvas, background: '#123456' } };
  useEditor.getState().acknowledgeSaved(saved, snapshot);
  assert.equal(useEditor.getState().project.name, 'Latest local');
  assert.equal(useEditor.getState().project.canvas.background, '#123456');
});

test('late responses for another project cannot replace or merge into the open project', () => {
  const oldProject = defaultProject('old-project', 'Old');
  const current = defaultProject('current-project', 'Current');
  useEditor.getState().setProject(current);
  useEditor.getState().acknowledgeSaved({ ...oldProject, revision: 10 }, oldProject);
  assert.equal(useEditor.getState().project, current);
  useEditor.getState().applyServerProject(oldProject);
  assert.equal(useEditor.getState().project, current);
});

test('competing changes during an acknowledgement retain local recovery and stop autosave', () => {
  const base = defaultProject('ack-conflict', 'Original');
  useEditor.getState().setProject(base);
  const snapshot = useEditor.getState().project;
  useEditor.getState().mutateProject((draft) => { draft.name = 'Local'; });
  useEditor.getState().acknowledgeSaved({ ...snapshot, name: 'Remote', revision: 10 }, snapshot);
  const state = useEditor.getState();
  assert.equal(state.project.name, 'Local');
  assert.equal(state.lastSavedProject.name, 'Remote');
  assert.equal(state.saveState, 'error');
  assert.ok(state.localRevision > state.savedRevision);
  assert.match(state.notice, /conflict/i);
});

test('acknowledging the current snapshot marks it clean', () => {
  const base = defaultProject('ack-clean', 'Original');
  useEditor.getState().setProject(base);
  useEditor.getState().mutateProject((draft) => { draft.name = 'Saved'; });
  const snapshot = useEditor.getState().project;
  const saved = { ...snapshot, revision: 10 };
  useEditor.getState().acknowledgeSaved(saved, snapshot);
  assert.equal(useEditor.getState().project, saved);
  assert.equal(useEditor.getState().localRevision, useEditor.getState().savedRevision);
  assert.equal(useEditor.getState().saveState, 'saved');
});

test('out-of-order responses cannot roll the current project back to an older revision', () => {
  const oldProject = defaultProject('same-project', 'Old');
  const current = { ...oldProject, name: 'Current', revision: 10 };
  useEditor.getState().setProject(current);
  useEditor.getState().applyServerProject(oldProject);
  assert.equal(useEditor.getState().project, current);
  useEditor.getState().acknowledgeSaved(oldProject, oldProject);
  assert.equal(useEditor.getState().project, current);
  assert.equal(useEditor.getState().savedRevision, 10);
});
