import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatTime,
  parseTimelineTimecode,
  defaultProject,
  enforceLockedTrackInvariants,
  exportDimensions,
  ExportOptionsSchema,
  ExportRangeSchema,
  interpolateKeyframes,
  mergeProjectThreeWay,
  AssetSchema,
  adjustmentLayersForVisual,
  ClipSchema,
  ProjectSchema,
  projectDuration,
  playbackTime,
  quantizeFrameTime,
  rippleDeleteClip,
  rippleDeleteAcrossTimeline,
  retimeClipMotion,
  sourceTimeAt,
  speedCurveSegments,
  snapTime,
  sliceClipForRange,
  splitClipAt,
  timelineDurationForSourceDuration,
  trimClip,
  trimClipToPlayhead,
  visualLayerPlan,
} from '../dist/index.js';

test('formats timeline time with frames', () => {
  assert.equal(formatTime(65.5, true, 30), '00:01:05:15');
});

test('parses exact editor timecodes and rejects overflow', () => {
  assert.equal(parseTimelineTimecode('00:01:05:15', 30), 65.5);
  assert.equal(parseTimelineTimecode('01:05'), 65);
  assert.equal(parseTimelineTimecode('8'), 8);
  assert.equal(parseTimelineTimecode('00:00:60:00', 30), null);
  assert.equal(parseTimelineTimecode('00:00:01:30', 30), null);
  assert.equal(parseTimelineTimecode('nope', 30), null);
});

test('creates a valid starter project', () => {
  const project = defaultProject('p1');
  assert.equal(project.schemaVersion, 1);
  assert.equal(project.tracks.length, 4);
  assert.equal(project.canvas.aspect, '16:9');
  assert.ok(project.tracks.every((track) => track.type === 'layer'));
  assert.equal(project.canvas.fitMode, 'fit');
});

test('accepts social and cinematic canvas presets', () => {
  const project = defaultProject('p2');
  const social = ProjectSchema.parse({ ...project, canvas: { ...project.canvas, aspect: '4:5', width: 1080, height: 1350 } });
  const cinematic = ProjectSchema.parse({ ...project, canvas: { ...project.canvas, aspect: '21:9', width: 2560, height: 1080 } });
  assert.equal(social.canvas.aspect, '4:5');
  assert.equal(cinematic.canvas.aspect, '21:9');
});

test('normalizes professional export profiles', () => {
  const options = ExportOptionsSchema.parse({ format: 'mp4', aspect: '9:16', resolution: '4K', fps: 60, quality: 'custom', rateMode: 'bitrate', videoBitrateKbps: 18000, audioBitrateKbps: 256, fileName: 'my video' });
  assert.equal(options.resolution, '4K');
  assert.equal(options.videoBitrateKbps, 18000);
  assert.equal(options.audioBitrateKbps, 256);
  assert.equal(ExportOptionsSchema.parse({ aspect: '4:5' }).aspect, '4:5');
});

test('maps export resolution to exact even output dimensions', () => {
  assert.deepEqual(exportDimensions('16:9', '720p'), { width: 1280, height: 720 });
  assert.deepEqual(exportDimensions('16:9', '1080p'), { width: 1920, height: 1080 });
  assert.deepEqual(exportDimensions('16:9', '2K'), { width: 2560, height: 1440 });
  assert.deepEqual(exportDimensions('16:9', '4K'), { width: 3840, height: 2160 });
  assert.deepEqual(exportDimensions('9:16', '4K'), { width: 2160, height: 3840 });
  assert.deepEqual(exportDimensions('source', '1080p', { width: 1080, height: 1350 }), { width: 1080, height: 1350 });
});

test('rejects an inverted In-Out range', () => {
  assert.throws(() => ExportRangeSchema.parse({ start: 8, end: 4 }));
});

test('interpolates keyframes with easing', () => {
  const keyframes = [
    { id: 'a', property: 'opacity', time: 0, value: 0, easing: 'linear' },
    { id: 'b', property: 'opacity', time: 2, value: 1, easing: 'ease-in' },
  ];
  assert.equal(interpolateKeyframes(keyframes, 'opacity', 0, 0), 0);
  assert.equal(interpolateKeyframes(keyframes, 'opacity', 2, 0), 1);
  assert.ok(interpolateKeyframes(keyframes, 'opacity', 1, 0) < 0.5);
});

test('rejects broken cross-project references and timeline invariants', () => {
  const missingAsset = defaultProject('integrity-missing');
  missingAsset.tracks[0].clips.push(ClipSchema.parse({ id: 'clip-missing', assetId: 'asset-nope', type: 'video', name: 'Missing', start: 0, duration: 1, sourceDuration: 1 }));
  missingAsset.duration = 1;
  assert.equal(ProjectSchema.safeParse(missingAsset).success, false);

  const duplicate = defaultProject('integrity-duplicate');
  duplicate.tracks[1].id = duplicate.tracks[0].id;
  assert.equal(ProjectSchema.safeParse(duplicate).success, false);

  const outOfBounds = defaultProject('integrity-bounds');
  outOfBounds.assets.push(AssetSchema.parse({ id: 'asset-a', name: 'Audio', type: 'audio', path: 'a.wav', mimeType: 'audio/wav', size: 1, duration: 2, createdAt: outOfBounds.createdAt }));
  outOfBounds.tracks[0].clips.push(ClipSchema.parse({ id: 'clip-a', assetId: 'asset-a', type: 'audio', name: 'Audio', start: 0, duration: 2, sourceStart: 1, sourceDuration: 2, keyframes: [{ id: 'kf-a', property: 'volume', time: 3, value: 1 }] }));
  outOfBounds.duration = 2;
  assert.equal(ProjectSchema.safeParse(outOfBounds).success, false);
});

test('uses the same supported speed range for clips and speed points', () => {
  assert.equal(ClipSchema.safeParse({ id: 'slow', type: 'image', name: 'Slow', start: 0, duration: 1, sourceDuration: 1, speed: 0.2 }).success, false);
  assert.equal(ClipSchema.safeParse({ id: 'fast', type: 'image', name: 'Fast', start: 0, duration: 1, sourceDuration: 1, speedCurve: [{ time: 0, speed: 4.1 }] }).success, false);
});

test('visual layer plan preserves general-purpose track and clip ordering', () => {
  const project = defaultProject('render-order');
  project.tracks[0].order = 2;
  project.tracks[1].order = 1;
  project.tracks[0].clips.push(ClipSchema.parse({ id: 'media-top', type: 'image', name: 'Media', start: 0, duration: 1, sourceDuration: 1 }));
  project.tracks[1].clips.push(ClipSchema.parse({ id: 'text-bottom', type: 'text', name: 'Text', start: 0, duration: 1, sourceDuration: 1, textStyle: { text: 'Below' } }));
  assert.deepEqual(visualLayerPlan(project).map(({ clip }) => clip.id), ['text-bottom', 'media-top']);
});

test('three-way project merge preserves independent timeline edits and local asset deletion', () => {
  const base = projectWithClips();
  base.assets = [AssetSchema.parse({ id: 'asset-a', name: 'Original', type: 'image', path: 'a.png', mimeType: 'image/png', size: 1, duration: 1, createdAt: base.createdAt })];
  const local = structuredClone(base);
  const remote = structuredClone(base);
  local.tracks[0].clips[0].transform.scale = 1.25;
  local.assets = [];
  remote.tracks[0].clips[0].transform.x = 42;
  remote.assets[0].thumbnailPath = 'thumbs/a.jpg';

  const result = mergeProjectThreeWay(base, local, remote);
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.project.tracks[0].clips[0].transform.scale, 1.25);
  assert.equal(result.project.tracks[0].clips[0].transform.x, 42);
  assert.deepEqual(result.project.assets, []);
});

test('three-way project merge reports competing clip-property edits', () => {
  const base = projectWithClips();
  const local = structuredClone(base);
  const remote = structuredClone(base);
  local.tracks[0].clips[0].transform.scale = 1.25;
  remote.tracks[0].clips[0].transform.scale = 1.5;

  const result = mergeProjectThreeWay(base, local, remote);
  assert.ok(result.conflicts.includes(`tracks[${base.tracks[0].id}].clips[clip-a].transform.scale`));
  assert.equal(result.project.tracks[0].clips[0].transform.scale, 1.25);
});

test('three-way project merge reports delete-versus-edited clip conflicts without deleting the edit', () => {
  const base = projectWithClips();
  const localDelete = structuredClone(base);
  const remoteEdit = structuredClone(base);
  localDelete.tracks[0].clips = localDelete.tracks[0].clips.filter((clip) => clip.id !== 'clip-a');
  remoteEdit.tracks[0].clips[0].transform.scale = 1.5;
  const deletedVsEdited = mergeProjectThreeWay(base, localDelete, remoteEdit);
  assert.ok(deletedVsEdited.conflicts.includes(`tracks[${base.tracks[0].id}].clips[clip-a]`));

  const localEdit = structuredClone(base);
  const remoteDelete = structuredClone(base);
  localEdit.tracks[0].clips[0].transform.scale = 1.5;
  remoteDelete.tracks[0].clips = remoteDelete.tracks[0].clips.filter((clip) => clip.id !== 'clip-a');
  const editedVsDeleted = mergeProjectThreeWay(base, localEdit, remoteDelete);
  assert.ok(editedVsDeleted.conflicts.includes(`tracks[${base.tracks[0].id}].clips[clip-a]`));
  assert.equal(editedVsDeleted.project.tracks[0].clips.find((clip) => clip.id === 'clip-a').transform.scale, 1.5);
});

test('three-way merge accepts deletion only when the other side is unchanged and preserves deleted assets across metadata refreshes', () => {
  const base = projectWithClips();
  const local = structuredClone(base);
  local.tracks[0].clips = local.tracks[0].clips.filter((clip) => clip.id !== 'clip-a');
  assert.equal(mergeProjectThreeWay(base, local, structuredClone(base)).conflicts.length, 0);
  const asset = AssetSchema.parse({ id: 'asset-a', name: 'A', type: 'image', path: 'a.png', mimeType: 'image/png', size: 1, duration: 1, createdAt: base.createdAt });
  base.assets = [asset];
  const deleted = structuredClone(base); deleted.assets = [];
  const refreshed = structuredClone(base); refreshed.assets[0].thumbnailPath = 'thumb/a.jpg';
  const result = mergeProjectThreeWay(base, deleted, refreshed);
  assert.deepEqual(result.assets ?? result.project.assets, []);
  assert.equal(result.conflicts.length, 0);
});

test('adjustment targeting and playback clock are stack and wall-clock based', () => {
  const project = defaultProject('adjustment-targets');
  project.tracks = project.tracks.slice(0, 3);
  project.tracks.forEach((track, index) => { track.order = index; track.clips = []; });
  for (const [index, clip] of [
    { id: 'background', type: 'image', name: 'Background', start: 0, duration: 2, sourceDuration: 2 },
    { id: 'adjustment', type: 'image', name: 'Adjustment', start: 0, duration: 2, sourceDuration: 2, adjustment: true },
    { id: 'logo', type: 'image', name: 'Logo', start: 0, duration: 2, sourceDuration: 2 },
  ].entries()) project.tracks[index].clips.push(ClipSchema.parse(clip));
  const plan = visualLayerPlan(project);
  assert.deepEqual(adjustmentLayersForVisual(plan, plan[0], 1).map(({ clip }) => clip.id), ['adjustment']);
  assert.deepEqual(adjustmentLayersForVisual(plan, plan[2], 1), []);
  assert.deepEqual(adjustmentLayersForVisual(plan, plan[0], 3), []);
  assert.equal(playbackTime(0, 1000, 2000, 10), 1);
  assert.equal(playbackTime(4, 1000, 2000, 4.5), 4.5);
});

test('locked tracks reject deletion, rename, reorder and cross-track clip moves without a revision-worthy change', () => {
  const previous = projectWithClips();
  previous.tracks[0].locked = true;
  const candidate = structuredClone(previous);
  candidate.tracks[0].name = 'Renamed';
  candidate.tracks[0].clips = [];
  candidate.tracks.reverse();
  candidate.tracks[0].clips.push(...previous.tracks[0].clips);
  candidate.tracks = candidate.tracks.filter((track) => track.id !== previous.tracks[0].id);
  const next = enforceLockedTrackInvariants(previous, candidate);
  assert.deepEqual(next.tracks.find((track) => track.id === previous.tracks[0].id), previous.tracks[0]);
  assert.equal(next.tracks.filter((track) => track.clips.some((clip) => clip.id === 'clip-a')).length, 1);
  const unlocked = structuredClone(previous); unlocked.tracks[0].locked = false;
  assert.equal(enforceLockedTrackInvariants(previous, unlocked).tracks[0].locked, false);
});

test('integrates speed curves into source time instead of using instantaneous speed', () => {
  const curve = [{ time: 0, speed: 0.5, easing: 'linear' }, { time: 4, speed: 2, easing: 'linear' }];
  const source = sourceTimeAt(curve, 1, 4);
  assert.ok(source > 4.5 && source < 5.5);
  const segments = speedCurveSegments(4, 1, curve);
  assert.ok(segments.length > 2);
  assert.ok(Math.abs(segments.reduce((total, segment) => total + segment.sourceDuration, 0) - source) < 0.01);
});

test('accepts advanced clip controls without breaking legacy defaults', () => {
  const clip = ClipSchema.parse({
    id: 'clip', type: 'image', name: 'poster', start: 0, duration: 5,
    sourceDuration: 5, mask: { type: 'ellipse', width: 0.8, height: 0.7, feather: 0.2 },
    speedCurve: [{ time: 0, speed: 0.5 }, { time: 5, speed: 2 }], fadeIn: 0.25, normalize: true,
  });
  assert.equal(clip.mask?.type, 'ellipse');
  assert.equal(clip.speedCurve?.[1].speed, 2);
  assert.equal(clip.transitionIn.type, 'none');
});

function projectWithClips() {
  const project = defaultProject('commands');
  const clip = ClipSchema.parse({ id: 'clip-a', type: 'video', name: 'A', start: 0, duration: 10, sourceDuration: 10 });
  const next = ClipSchema.parse({ id: 'clip-b', type: 'video', name: 'B', start: 12, duration: 4, sourceDuration: 4 });
  project.tracks[0].clips.push(clip, next);
  project.duration = projectDuration(project);
  return project;
}

test('splitClipAt preserves source timing and creates a second clip', () => {
  const project = projectWithClips();
  assert.equal(splitClipAt(project, 'clip-a', 4, () => 'clip-a-second'), true);
  const clips = project.tracks[0].clips;
  assert.equal(clips.length, 3);
  assert.equal(clips[0].duration, 4);
  assert.equal(clips[1].start, 4);
  assert.equal(clips[1].duration, 6);
  assert.equal(clips[1].sourceStart, 4);
  assert.equal(clips[1].id, 'clip-a-second');
  assert.equal(project.duration, 16);
  assert.equal(splitClipAt(project, 'clip-a', 0, () => 'unused'), false);
});

test('split and trim preserve interpolated motion at their new boundaries', () => {
  const project = projectWithClips();
  const clip = project.tracks[0].clips.find((item) => item.id === 'clip-a');
  clip.keyframes = [
    { id: 'x-start', property: 'x', time: 0, value: 0, easing: 'linear' },
    { id: 'x-end', property: 'x', time: 10, value: 100, easing: 'ease-in-out' },
  ];
  assert.equal(splitClipAt(project, 'clip-a', 4, () => 'clip-a-second'), true);
  const first = project.tracks[0].clips.find((item) => item.id === 'clip-a');
  const second = project.tracks[0].clips.find((item) => item.id === 'clip-a-second');
  assert.equal(Math.round(interpolateKeyframes(first.keyframes, 'x', first.duration, -1)), 32);
  assert.equal(Math.round(interpolateKeyframes(second.keyframes, 'x', 0, -1)), 32);
  assert.equal(trimClipToPlayhead(project, 'clip-a-second', 7, 'start'), true);
  assert.equal(Number.isFinite(interpolateKeyframes(second.keyframes, 'x', 0, -1)), true);
});

test('locked tracks reject split and remain unchanged during cross-track ripple delete', () => {
  const project = projectWithClips();
  const locked = project.tracks[1];
  locked.locked = true;
  locked.clips.push(ClipSchema.parse({ id: 'locked-clip', type: 'image', name: 'Locked', start: 13, duration: 2, sourceDuration: 2 }));
  project.tracks[0].locked = true;
  assert.equal(splitClipAt(project, 'clip-a', 4, () => 'blocked'), false);
  project.tracks[0].locked = false;
  assert.equal(rippleDeleteAcrossTimeline(project, 'clip-a'), true);
  assert.equal(locked.clips[0].start, 13);
});

test('trimClipToPlayhead adjusts source and timeline boundaries', () => {
  const project = projectWithClips();
  assert.equal(trimClipToPlayhead(project, 'clip-a', 3, 'start'), true);
  assert.equal(project.tracks[0].clips[0].start, 3);
  assert.equal(project.tracks[0].clips[0].duration, 7);
  assert.equal(project.tracks[0].clips[0].sourceStart, 3);
  assert.equal(trimClipToPlayhead(project, 'clip-a', 6, 'end'), true);
  assert.equal(project.tracks[0].clips[0].duration, 3);
  assert.equal(project.tracks[0].clips[0].sourceDuration, 3);
});

test('rippleDeleteClip closes the gap only on the selected track', () => {
  const project = projectWithClips();
  assert.equal(rippleDeleteClip(project, 'clip-a'), true);
  assert.equal(project.tracks[0].clips[0].id, 'clip-b');
  assert.equal(project.tracks[0].clips[0].start, 2);
  assert.equal(project.duration, 6);
});

test('retimes clip-local motion when a clip becomes faster', () => {
  const clip = ClipSchema.parse({
    id: 'motion-clip', type: 'video', name: 'motion', start: 0, duration: 10, sourceDuration: 10,
    keyframes: [{ id: 'kf', property: 'x', time: 8, value: 120, easing: 'ease-out' }],
    speedCurve: [{ time: 0, speed: 1 }, { time: 10, speed: 2 }],
    transitionIn: { type: 'fade', duration: 2 },
    fadeOut: 1,
  });
  retimeClipMotion(clip, 5);
  assert.equal(clip.duration, 5);
  assert.equal(clip.keyframes[0].time, 4);
  assert.equal(clip.speedCurve?.[1].time, 5);
  assert.equal(clip.transitionIn.duration, 1);
  assert.equal(clip.fadeOut, 0.5);
});

test('speed curves remain finite and ordered with duplicate or unsorted points', () => {
  const curve = [
    { time: 2, speed: 1.5, easing: 'ease-out' },
    { time: 0, speed: 0.5, easing: 'linear' },
    { time: 2, speed: 2, easing: 'ease-in' },
    { time: 1, speed: 1, easing: 'ease-in-out' },
  ];
  const consumed = sourceTimeAt(curve, 1, 3);
  const segments = speedCurveSegments(3, 1, curve);
  assert.equal(Number.isFinite(consumed), true);
  assert.equal(segments.every((segment) => segment.duration > 0 && Number.isFinite(segment.sourceDuration)), true);
  assert.equal(segments.every((segment, index) => index === 0 || segment.time >= segments[index - 1].time), true);
  assert.equal(Math.abs(segments.reduce((sum, segment) => sum + segment.sourceDuration, 0) - consumed) < 0.0001, true);
});

test('inverts variable speed curves without mutating project duration on load', () => {
  const curve = [
    { time: 4, speed: 2, easing: 'linear' },
    { time: 0, speed: 1, easing: 'linear' },
    { time: 4, speed: 1.5, easing: 'ease-out' },
  ];
  const timeline = timelineDurationForSourceDuration(8, 1, curve);
  assert.equal(Number.isFinite(timeline), true);
  assert.ok(timeline > 0);
  assert.ok(Math.abs(sourceTimeAt(curve, 1, timeline) - 8) < 0.000001);
  assert.ok(Math.abs(timelineDurationForSourceDuration(8, 1, curve) - timeline) < 0.000001);
});

test('range slicing rebases source, speed curve, keyframes, fades and transitions together', () => {
  const clip = ClipSchema.parse({
    id: 'range-clip', type: 'video', name: 'Range', start: 12, duration: 10, sourceStart: 3, sourceDuration: 10,
    speed: 1, speedCurve: [{ time: 0, speed: 1 }, { time: 10, speed: 2 }],
    keyframes: [
      { id: 'opacity-start', property: 'opacity', time: 0, value: 0, easing: 'linear' },
      { id: 'opacity-end', property: 'opacity', time: 10, value: 1, easing: 'linear' },
    ],
    transitionIn: { type: 'fade', duration: 2 },
    transitionOut: { type: 'fade', duration: 2 },
    fadeIn: 2,
    fadeOut: 2,
  });
  const sliced = sliceClipForRange(clip, 5, 10);
  assert.equal(sliced.start, 17);
  assert.equal(sliced.duration, 5);
  assert.ok(Math.abs(sliced.sourceStart - (3 + sourceTimeAt(clip.speedCurve, clip.speed, 5))) < 0.000001);
  assert.ok(Math.abs(sliced.sourceDuration - (sourceTimeAt(clip.speedCurve, clip.speed, 10) - sourceTimeAt(clip.speedCurve, clip.speed, 5))) < 0.000001);
  assert.equal(sliced.fadeIn, 0);
  assert.equal(sliced.transitionIn.type, 'none');
  assert.equal(sliced.fadeOut, 2);
  assert.equal(sliced.transitionOut.duration, 2);
  assert.equal(sliced.keyframes.some((keyframe) => keyframe.time === 0), true);
  assert.equal(sliced.speedCurve?.[0].time, 0);
  assert.ok(Math.abs(interpolateKeyframes(sliced.keyframes, 'opacity', 0, -1) - interpolateKeyframes(clip.keyframes, 'opacity', 5, -1)) < 0.000001);
});

test('trimClip uses the same range primitive for a variable-speed pointer boundary', () => {
  const project = projectWithClips();
  const clip = project.tracks[0].clips[0];
  clip.duration = 10;
  clip.sourceDuration = sourceTimeAt([{ time: 0, speed: 1 }, { time: 10, speed: 2 }], 1, 10);
  clip.speedCurve = [{ time: 0, speed: 1 }, { time: 10, speed: 2 }];
  const snapshot = structuredClone(clip);
  assert.equal(trimClip(project, clip.id, 2, 8, snapshot), true);
  assert.equal(clip.start, 2);
  assert.equal(clip.duration, 6);
  assert.ok(Math.abs(clip.sourceStart - sourceTimeAt(snapshot.speedCurve, snapshot.speed, 2)) < 0.000001);
  assert.ok(Math.abs(clip.sourceDuration - (sourceTimeAt(snapshot.speedCurve, snapshot.speed, 8) - sourceTimeAt(snapshot.speedCurve, snapshot.speed, 2))) < 0.000001);
});

test('rippleDeleteAcrossTimeline closes the gap on unlocked tracks', () => {
  const project = projectWithClips();
  const overlay = project.tracks[1];
  overlay.clips.push(ClipSchema.parse({ id: 'overlay', type: 'image', name: 'O', start: 13, duration: 2, sourceDuration: 2 }));
  assert.equal(rippleDeleteAcrossTimeline(project, 'clip-a'), true);
  assert.equal(project.tracks[0].clips.find((clip) => clip.id === 'clip-b')?.start, 2);
  assert.equal(overlay.clips[0].start, 3);
});

test('snapTime uses clips, markers, range and frame grid', () => {
  const project = projectWithClips();
  project.markers.push({ id: 'marker-a', time: 7, label: 'Beat' });
  assert.equal(snapTime(project, 6.97), 7);
  assert.equal(snapTime(project, 11.2, { enabled: false }), 11.2);
  assert.equal(snapTime(project, 5.013, { currentTime: 5 }), 5);
});

test('quantizeFrameTime stays on exact frame boundaries', () => {
  assert.equal(quantizeFrameTime(1.019, 30, 10), 1 + 1 / 30);
  assert.equal(quantizeFrameTime(-4, 25, 10), 0);
  assert.equal(quantizeFrameTime(12, 60, 10), 10);
});
