import { useEffect, useRef, useState } from 'react';
import type React from 'react';
import { clamp, formatTime, interpolateKeyframes, projectDuration, retimeClipMotion, speedAt, type Clip, type Project } from '@cutloc/shared';
import { useI18n, type TranslationKey } from '../i18n';
import { DEFAULT_TEXT_STYLE, TEXT_FONT_OPTIONS } from './text-model';
import { useEditor } from './store';

export function Inspector({ project }: { project: Project }) {
  const { t } = useI18n();
  const selectedClipId = useEditor((state) => state.selectedClipId);
  const selectedClipIds = useEditor((state) => state.selectedClipIds);
  const currentTime = useEditor((state) => state.currentTime);
  const mutateProject = useEditor((state) => state.mutateProject);
  const setSelected = useEditor((state) => state.setSelected);
  const setPanel = useEditor((state) => state.setPanel);
  const [, setActiveGroup] = useState<'layout' | 'audio' | 'speed' | 'motion' | 'appearance'>('layout');
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
