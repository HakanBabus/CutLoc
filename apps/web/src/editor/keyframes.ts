import { clamp, interpolateKeyframes, type Clip, type KeyframeProperty } from '@cutloc/shared';

export function motionValue(clip: Clip, property: KeyframeProperty, localTime: number) {
  const fallback = property === 'x'
    ? clip.transform.x
    : property === 'y'
      ? clip.transform.y
      : property === 'scale'
        ? clip.transform.scale
        : property === 'rotation'
          ? clip.transform.rotation
          : property === 'opacity'
            ? clip.transform.opacity
            : clip.volume;
  return interpolateKeyframes(clip.keyframes, property, clamp(localTime, 0, clip.duration), fallback);
}

export function keyframeAtTime(clip: Clip, property: KeyframeProperty, localTime: number, fps: number) {
  const time = clamp(localTime, 0, clip.duration);
  const tolerance = 0.5 / Math.max(1, fps);
  return clip.keyframes.find((keyframe) => keyframe.property === property && Math.abs(keyframe.time - time) <= tolerance);
}

function setBaseValue(clip: Clip, property: KeyframeProperty, value: number) {
  if (property === 'x') clip.transform.x = value;
  else if (property === 'y') clip.transform.y = value;
  else if (property === 'scale') clip.transform.scale = value;
  else if (property === 'rotation') clip.transform.rotation = value;
  else if (property === 'opacity') clip.transform.opacity = value;
  else clip.volume = value;
}

/**
 * Once a property has been animated, editing it at another playhead position
 * writes a point automatically. Before animation is enabled, the same control
 * keeps changing the clip-wide base value.
 */
export function setMotionValue(clip: Clip, property: KeyframeProperty, localTime: number, value: number, fps: number, forceKeyframe = false) {
  const hasAnimation = clip.keyframes.some((keyframe) => keyframe.property === property);
  if (!forceKeyframe && !hasAnimation) {
    setBaseValue(clip, property, value);
    return { keyframed: false, created: false };
  }

  const time = clamp(localTime, 0, clip.duration);
  const existing = keyframeAtTime(clip, property, time, fps);
  if (existing) {
    existing.time = time;
    existing.value = value;
    return { keyframed: true, created: false, keyframe: existing };
  }

  const keyframe = {
    id: `key_${crypto.randomUUID().slice(0, 8)}`,
    property,
    time,
    value,
    easing: 'linear' as const,
  };
  clip.keyframes.push(keyframe);
  return { keyframed: true, created: true, keyframe };
}

export function toggleMotionKeyframe(clip: Clip, property: KeyframeProperty, localTime: number, fps: number) {
  const existing = keyframeAtTime(clip, property, localTime, fps);
  if (existing) {
    clip.keyframes = clip.keyframes.filter((keyframe) => keyframe.id !== existing.id);
    return { active: false, keyframe: existing };
  }
  const value = motionValue(clip, property, localTime);
  const result = setMotionValue(clip, property, localTime, value, fps, true);
  return { active: true, keyframe: result.keyframe! };
}
