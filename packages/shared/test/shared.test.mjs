import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatTime,
  parseTimelineTimecode,
  defaultProject,
  exportDimensions,
  ExportOptionsSchema,
  ExportRangeSchema,
  interpolateKeyframes,
  ClipSchema,
  ProjectSchema,
  projectDuration,
  quantizeFrameTime,
  rippleDeleteClip,
  rippleDeleteAcrossTimeline,
  retimeClipMotion,
  sourceTimeAt,
  speedCurveSegments,
  snapTime,
  splitClipAt,
  trimClipToPlayhead,
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
