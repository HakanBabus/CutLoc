import { useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import { clamp, formatTime, projectDuration, type Asset, type Clip, type Project } from '@cutloc/shared';
import { useI18n, type TranslationKey } from '../i18n';
import { ConfirmDialog } from '../components/dialogs';
import { ContextMenu, type ContextMenuItem } from '../components/context-menu';
import { api } from './api';
import { createLayerTrack, createMediaClip, findEmptyPlacement } from './media-model';
import { DEFAULT_TEXT_STYLE, SHAPE_PRESETS, TEXT_PRESETS, localizeShapePreset, localizeTextPreset, type ShapePreset, type TextPreset } from './text-model';
import { STOCK_MEDIA, localizeStockMedia, useEditor, type Panel, type StockMediaItem } from './store';

function panelTitle(panel: Panel): TranslationKey {
  const labels: Record<Panel, TranslationKey> = {
    media: 'editor.panel.media', text: 'editor.panel.text', elements: 'editor.panel.elements',
    project: 'editor.panel.project', transitions: 'editor.panel.transitions', effects: 'editor.panel.effects', color: 'editor.panel.color',
    animation: 'editor.panel.animation',
  };
  return labels[panel];
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
    adjustment: false,
    keyframes: [],
    textStyle,
  };
}

type TransitionPreset = 'none' | 'fade' | 'dissolve' | 'slide' | 'wipe' | 'zoom';
type AnimationApplyMode = 'in' | 'out' | 'both';
type TransitionDirection = 'left' | 'right' | 'up' | 'down' | 'center';
type TransitionEasing = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out';
type AnimationCategory = 'all' | 'cut' | 'soft' | 'motion' | 'focus';
type AnimationPreset = {
  id: string;
  labelKey: TranslationKey;
  descriptionKey: TranslationKey;
  type: TransitionPreset;
  category: Exclude<AnimationCategory, 'all'>;
  motionDirection: TransitionDirection;
  directionKey: TranslationKey;
  duration: number;
};

const ANIMATION_PRESETS: AnimationPreset[] = [
  { id: 'none', labelKey: 'preset.animation.none.label', descriptionKey: 'preset.animation.none.description', type: 'none', category: 'cut', motionDirection: 'center', directionKey: 'preset.animation.none.direction', duration: 0 },
  { id: 'fade', labelKey: 'preset.animation.fade.label', descriptionKey: 'preset.animation.fade.description', type: 'fade', category: 'soft', motionDirection: 'center', directionKey: 'preset.animation.fade.direction', duration: 0.35 },
  { id: 'dissolve', labelKey: 'preset.animation.dissolve.label', descriptionKey: 'preset.animation.dissolve.description', type: 'dissolve', category: 'soft', motionDirection: 'center', directionKey: 'preset.animation.dissolve.direction', duration: 0.45 },
  { id: 'slide-left', labelKey: 'preset.animation.slide-left.label', descriptionKey: 'preset.animation.slide-left.description', type: 'slide', category: 'motion', motionDirection: 'left', directionKey: 'preset.animation.slide-left.direction', duration: 0.4 },
  { id: 'slide-right', labelKey: 'preset.animation.slide-right.label', descriptionKey: 'preset.animation.slide-right.description', type: 'slide', category: 'motion', motionDirection: 'right', directionKey: 'preset.animation.slide-right.direction', duration: 0.4 },
  { id: 'slide-up', labelKey: 'preset.animation.slide-up.label', descriptionKey: 'preset.animation.slide-up.description', type: 'slide', category: 'motion', motionDirection: 'down', directionKey: 'preset.animation.slide-up.direction', duration: 0.4 },
  { id: 'slide-down', labelKey: 'preset.animation.slide-down.label', descriptionKey: 'preset.animation.slide-down.description', type: 'slide', category: 'motion', motionDirection: 'up', directionKey: 'preset.animation.slide-down.direction', duration: 0.4 },
  { id: 'wipe', labelKey: 'preset.animation.wipe.label', descriptionKey: 'preset.animation.wipe.description', type: 'wipe', category: 'motion', motionDirection: 'left', directionKey: 'preset.animation.wipe.direction', duration: 0.4 },
  { id: 'zoom', labelKey: 'preset.animation.zoom.label', descriptionKey: 'preset.animation.zoom.description', type: 'zoom', category: 'focus', motionDirection: 'center', directionKey: 'preset.animation.zoom.direction', duration: 0.45 },
];
type BackupSummary = { fileName: string; createdAt: string; size: number };

function PanelContent({ panel, onAddText, onApplyEffect, onOpenSettings }: { panel: Panel; onAddText: (preset: TextPreset) => void; onApplyEffect: (preset: 'film' | 'retro' | 'glow' | 'blur' | 'chroma' | 'noise') => void; onOpenSettings: () => void }) {
  const { t, locale } = useI18n();
  const project = useEditor((state) => state.project);
  const mutateProject = useEditor((state) => state.mutateProject);
  const setNotice = useEditor((state) => state.setNotice);
  const [backups, setBackups] = useState<BackupSummary[]>([]);
  const [textSearch, setTextSearch] = useState('');
  const [textCategory, setTextCategory] = useState<'all' | TextPreset['category']>('all');
  const localizedTextPresets = TEXT_PRESETS.map((preset) => localizeTextPreset(preset, t));
  const filteredTextPresets = localizedTextPresets.filter((preset) => {
    const query = textSearch.trim().toLocaleLowerCase(locale);
    return (!query || `${preset.label} ${preset.description} ${preset.text}`.toLocaleLowerCase(locale).includes(query)) && (textCategory === 'all' || preset.category === textCategory);
  });
  useEffect(() => {
    if (panel !== 'project' || !project) return;
    let active = true;
    void api<BackupSummary[]>('/api/projects/' + project.id + '/backups')
      .then((items) => { if (active) setBackups(items); })
      .catch(() => { if (active) setBackups([]); });
    return () => { active = false; };
  }, [panel, project?.id]);
  const restoreBackup = async (fileName: string) => {
    if (!project) return;
    try {
      const restored = await api<Project>('/api/projects/' + project.id + '/restore', { method: 'POST', body: JSON.stringify({ fileName }) });
      useEditor.getState().setProject(restored);
      useEditor.getState().setSaveState('saved');
      setNotice(t('backup.restored'));
    } catch (error) {
      setNotice(error instanceof Error ? t('backup.restoreFailedWithReason', { reason: error.message }) : t('backup.restoreFailed'));
    }
  };
  if (panel === 'project') return <div className="quick-panel project-tools-panel">
    <ProjectBackupPanel backups={backups} onRestore={restoreBackup} />
    <div className="text-library-head"><div><strong>{t('projectTools.title')}</strong><small>{t('projectTools.copy')}</small></div><span>⌘</span></div>
    <div className="project-tool-card"><div><strong>{t('projectTools.background')}</strong><small>{t('projectTools.backgroundCopy')}</small></div><input type="color" value={project?.canvas.background?.slice(0, 7) === 'transpa' ? '#101116' : project?.canvas.background ?? '#101116'} onChange={(event) => mutateProject((draft) => { draft.canvas.background = event.target.value; })} /></div>
    <div className="project-background-grid"><button onClick={() => mutateProject((draft) => { draft.canvas.background = '#101116'; })}>{t('projectTools.black')}</button><button onClick={() => mutateProject((draft) => { draft.canvas.background = '#f3f4f1'; })}>{t('projectTools.white')}</button><button onClick={() => mutateProject((draft) => { draft.canvas.background = '#7b8088'; })}>{t('projectTools.gray')}</button><button onClick={() => mutateProject((draft) => { draft.canvas.background = 'transparent'; })}>{t('projectTools.transparent')}</button></div>
    <div className="project-tool-list"><button onClick={() => { if (project) window.location.href = `/api/projects/${project.id}/bundle`; }}>⇩ {t('projectTools.downloadBundle')} <span>›</span></button><button onClick={onOpenSettings}>⚙ {t('projectTools.workspaceSettings')} <span>›</span></button></div>
  </div>;
  if (panel === 'color') return <div className="quick-panel">
    <div className="text-library-head"><div><strong>{t('color.title')}</strong><small>{t('color.copy')}</small></div><span>6</span></div>
    <div className="effect-grid"><button onClick={() => onApplyEffect('film')}>◌<small>Film</small></button><button onClick={() => onApplyEffect('retro')}>◍<small>Retro</small></button><button onClick={() => onApplyEffect('glow')}>◈<small>Glow</small></button><button onClick={() => onApplyEffect('blur')}>◇<small>{t('effects.blur')}</small></button><button onClick={() => onApplyEffect('noise')}>◒<small>Mono</small></button><button onClick={() => onApplyEffect('chroma')}>⌁<small>Chroma</small></button></div>
    <p className="panel-note">{t('effects.selectClip')}</p>
  </div>;
  if (panel === 'text') {
    const quickStarts = ['clean-title', 'lower-third', 'quote'].map((id) => localizedTextPresets.find((preset) => preset.id === id) ?? localizedTextPresets[0]);
    return <div className="quick-panel text-library text-studio">
      <button className="text-primary-action" onClick={() => onAddText(localizedTextPresets[0])}><span>＋</span><div><strong>{t('text.addBlank')}</strong><small>{t('text.addBlankCopy')}</small></div><b>↗</b></button>
      <div className="text-section-label"><span>{t('text.quickStart')}</span><small>{t('text.oneClick')}</small></div>
      <div className="text-quick-starts">{quickStarts.map((preset) => <button key={preset.id} className={`text-quick-card text-quick-${preset.id}`} onClick={() => onAddText(preset)}><span style={{ fontFamily: preset.fontFamily, fontWeight: preset.fontWeight, fontStyle: preset.fontStyle }}>{preset.text}</span><strong>{preset.label}</strong><small>{preset.description}</small><i>＋</i></button>)}</div>
      <div className="text-library-head text-library-section-head"><div><strong>{t('text.library')}</strong><small>{t('text.libraryCopy')}</small></div><span>{filteredTextPresets.length}</span></div>
      <input className="media-search text-search" value={textSearch} onChange={(event) => setTextSearch(event.target.value)} placeholder={t('text.search')} aria-label={t('text.searchAria')} />
      <div className="text-category-chips">{(['all', 'title', 'social', 'card', 'accent'] as const).map((category) => <button key={category} className={textCategory === category ? 'active' : ''} onClick={() => setTextCategory(category)}>{category === 'all' ? t('library.category.all') : t(`text.category.${category}` as TranslationKey)}</button>)}</div>
      <div className="text-preset-grid">{filteredTextPresets.map((preset) => <button key={preset.id} className="text-preset-card" onClick={() => onAddText(preset)}><span className="text-preset-sample" style={{ fontFamily: preset.fontFamily, fontSize: `${Math.max(18, preset.fontSize / 2.75)}px`, fontWeight: preset.fontWeight, fontStyle: preset.fontStyle, color: preset.color, background: preset.background, textAlign: preset.align, lineHeight: 1.05, WebkitTextStroke: `${Math.min(1.5, preset.strokeWidth / 2)}px ${preset.stroke}` }}>{preset.text}</span><span className="text-preset-meta"><strong>{preset.label}</strong><small>{t(`text.category.${preset.category}` as TranslationKey)} · {preset.description}</small></span><i aria-hidden="true">＋</i></button>)}</div>
      <div className="text-studio-tip"><span>✦</span><p><strong>{t('text.tip')}</strong><small>{t('text.tipCopy')}</small></p></div>
    </div>;
  }
  return <div className="quick-panel"><div className="panel-placeholder-card"><span>✦</span><div><strong>{t('effects.title')}</strong><small>{t('effects.copy')}</small></div></div><div className="effect-grid"><button onClick={() => onApplyEffect('film')}>◌<small>Film</small></button><button onClick={() => onApplyEffect('retro')}>◍<small>Retro</small></button><button onClick={() => onApplyEffect('glow')}>◈<small>Glow</small></button><button onClick={() => onApplyEffect('blur')}>◇<small>Blur</small></button><button onClick={() => onApplyEffect('chroma')}>⌁<small>Chroma</small></button><button onClick={() => onApplyEffect('noise')}>◒<small>Mono</small></button></div><p className="panel-note">{t('effects.clickPreset')}</p></div>;
}

export function AnimationStudio({ compact = false }: { compact?: boolean }) {
  const { t, formatNumber } = useI18n();
  const project = useEditor((state) => state.project);
  const selectedClipId = useEditor((state) => state.selectedClipId);
  const selectedClipIds = useEditor((state) => state.selectedClipIds);
  const mutateProject = useEditor((state) => state.mutateProject);
  const setNotice = useEditor((state) => state.setNotice);
  const [mode, setMode] = useState<AnimationApplyMode>('in');
  const [category, setCategory] = useState<AnimationCategory>('all');
  const [inDuration, setInDuration] = useState(0.4);
  const [outDuration, setOutDuration] = useState(0.4);
  const [linkDurations, setLinkDurations] = useState(false);
  const [easing, setEasing] = useState<TransitionEasing>('ease-in-out');
  const [direction, setDirection] = useState<TransitionDirection>('left');
  const [intensity, setIntensity] = useState(1);
  const [activePresetId, setActivePresetId] = useState('fade');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const selected = project?.tracks.flatMap((track) => track.clips).find((clip) => clip.id === selectedClipId);
  const visiblePresets = category === 'all' ? ANIMATION_PRESETS : ANIMATION_PRESETS.filter((preset) => preset.category === category);
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
    const activeTransition = mode === 'out' ? outgoing : incoming;
    const bothMatch = (incoming.type ?? 'none') === (outgoing.type ?? 'none') && (incoming.type !== 'slide' || (incoming.direction ?? 'left') === (outgoing.direction ?? 'left'));
    const current = mode === 'both' && !bothMatch ? undefined : ANIMATION_PRESETS.find((preset) => preset.type === (activeTransition.type ?? 'none') && (preset.type !== 'slide' || preset.motionDirection === (activeTransition.direction ?? 'left')));
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
    mode,
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
      setNotice(t('animation.selectClipNotice'));
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
    setNotice(t(mode === 'both' ? 'animation.appliedBoth' : mode === 'in' ? 'animation.appliedIn' : 'animation.appliedOut', { name: t(preset.labelKey) }));
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
  const durationControl = (kind: 'in' | 'out', value: number, onChange: (value: number) => void) => {
    const label = t(kind === 'in' ? 'animation.inDuration' : 'animation.outDuration');
    const ariaLabel = t(kind === 'in' ? 'animation.inDurationAria' : 'animation.outDurationAria');
    return <div className="animation-duration-card" key={kind} data-duration-kind={kind}>
      <div className="animation-duration-head"><span>{kind === 'in' ? '↘' : '↗'}</span><div><strong>{label}</strong><small>{t('animation.durationHint')}</small></div><label><input type="number" min="0" max="1.5" step="0.05" value={value.toFixed(2)} disabled={!selectedIds.length} onChange={(event) => onChange(clamp(Number(event.target.value), 0, 1.5))} aria-label={ariaLabel} /><b>s</b></label></div>
      <input className="animation-duration-range" style={{ '--duration-fill': `${(value / 1.5) * 100}%` } as React.CSSProperties} type="range" min="0" max="1.5" step="0.05" value={value} disabled={!selectedIds.length} onChange={(event) => onChange(Number(event.target.value))} aria-label={ariaLabel} />
      <div className="animation-duration-presets" aria-label={t('animation.durationQuick')}>{[0.2, 0.4, 0.75, 1.25].map((duration) => <button type="button" key={duration} className={Math.abs(value - duration) < 0.001 ? 'active' : ''} disabled={!selectedIds.length} onClick={() => onChange(duration)}>{formatNumber(duration, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}s</button>)}</div>
    </div>;
  };

  return <div className={`quick-panel animation-studio animation-studio-v3 ${compact ? 'animation-studio-compact' : ''}`} data-mode={mode} data-category={category} data-has-selection={selectedIds.length ? 'true' : 'false'}>
    {!compact && <div className="animation-studio-heading"><div><p className="eyebrow">{t('animation.studio')}</p><h3>{t('animation.title')}</h3><small>{t('animation.copy')}</small></div></div>}
    {!compact && <div className="animation-target-row"><span className={selected ? 'target-dot ready' : 'target-dot'} />{selected ? <><strong>{selected.name}</strong><small>{selectedIds.length > 1 ? t('common.selectedClips', { count: selectedIds.length }) : t('animation.selectedClip')}</small></> : <><strong>{t('animation.noClip')}</strong><small>{t('animation.selectClip')}</small></>}</div>}
    <section className="animation-setup" aria-label={t('animation.sectionAria')}>
      <div className="animation-setup-heading"><div><span>{t('animation.applyArea')}</span><strong>{t('animation.applyAreaCopy')}</strong></div><b>{t(`animation.modeLabel.${mode}` as TranslationKey)}</b></div>
      <div className="animation-mode-tabs" role="tablist" aria-label={t('animation.sectionAria')}>{(['in', 'both', 'out'] as const).map((value) => <button key={value} type="button" role="tab" aria-selected={mode === value} className={mode === value ? 'active' : ''} onClick={() => setMode(value)}><span className="animation-mode-icon" aria-hidden="true">{value === 'in' ? '↘' : value === 'both' ? '✦' : '↗'}</span><span><strong>{t(`animation.modeLabel.${value}` as TranslationKey)}</strong><small>{t(`animation.mode.${value}Hint` as TranslationKey)}</small></span></button>)}</div>
      <div className={`animation-duration-grid ${mode === 'both' ? '' : 'single'}`}>
        {mode !== 'out' && durationControl('in', inDuration, changeInDuration)}
        {mode !== 'in' && durationControl('out', outDuration, changeOutDuration)}
      </div>
    </section>
    <section className="animation-preset-section" aria-label={t('animation.categoriesAria')}>
      <div className="animation-section-label"><div><strong>{t('animation.choose')}</strong><small>{t('animation.readyCount', { count: visiblePresets.length })}</small></div><span>{visiblePresets.length}</span></div>
      <div className="animation-category-tabs" role="tablist" aria-label={t('animation.categoriesAria')}>{(['all', 'cut', 'soft', 'motion', 'focus'] as const).map((value) => <button key={value} type="button" role="tab" aria-selected={category === value} className={category === value ? 'active' : ''} onClick={() => setCategory(value)}>{value === 'all' ? t('library.category.all') : t(`animation.category.${value}` as TranslationKey)}</button>)}</div>
      <div className="animation-card-grid animation-preset-list">{visiblePresets.map((preset) => { const active = isActive(preset); return <button key={preset.id} type="button" className={`animation-card ${active ? 'active' : ''}`} aria-pressed={active} onClick={() => { setActivePresetId(preset.id); setDirection(preset.motionDirection); apply(preset, preset.motionDirection); }}><span className={`animation-card-visual animation-visual-${preset.type} animation-visual-${preset.id}`}><i /></span><span className="animation-card-copy"><strong>{t(preset.labelKey)}</strong><small>{t(preset.descriptionKey)}</small><em>{t(preset.directionKey)} · {t('animation.seconds', { value: preset.duration.toFixed(2) })}</em></span><b aria-hidden="true">{active ? '✓' : '＋'}</b></button>; })}</div>
    </section>
    <button type="button" className={`animation-advanced-toggle ${showAdvanced ? 'active' : ''}`} onClick={() => setShowAdvanced((value) => !value)} aria-expanded={showAdvanced} aria-controls="animation-advanced-controls"><span><strong>{t('animation.advanced')}</strong><small>{t('animation.advancedCopy')}</small></span><b aria-hidden="true">{showAdvanced ? '⌃' : '⌄'}</b></button>
    {showAdvanced && <div id="animation-advanced-controls" className="animation-advanced">
      <div className="animation-advanced-heading"><div><strong>{t('animation.advanced')}</strong><small>{t('animation.advancedCopy')}</small></div><span>⌘</span></div>
      <div className="animation-advanced-fields">
        <label><span>{t('animation.direction')}</span><select value={direction} onChange={(event) => setDirection(event.target.value as TransitionDirection)}>{(['left', 'right', 'up', 'down', 'center'] as const).map((value) => <option key={value} value={value}>{t(`animation.direction.${value}` as TranslationKey)}</option>)}</select></label>
        <label><span>{t('animation.easing')}</span><select value={easing} onChange={(event) => setEasing(event.target.value as TransitionEasing)}><option value="linear">{t('animation.easing.linear')}</option><option value="ease-in">{t('animation.easing.in')}</option><option value="ease-out">{t('animation.easing.out')}</option><option value="ease-in-out">{t('animation.easing.both')}</option></select></label>
      </div>
      <label className="animation-intensity"><span>{t('animation.intensity')} <b>{Math.round(intensity * 100)}%</b></span><input type="range" min="0.1" max="2" step="0.05" value={intensity} onChange={(event) => setIntensity(Number(event.target.value))} /></label>
      {mode === 'both' && <label className="animation-link-toggle"><input type="checkbox" checked={linkDurations} onChange={(event) => setLinkDurations(event.target.checked)} /><span>{t('animation.linkDurations')}</span></label>}
      <button type="button" className="animation-apply-button" onClick={applyAdvanced}>{t('animation.applyAdvanced')}</button>
    </div>}
  </div>;
}

function ProjectBackupPanel({ backups, onRestore }: { backups: BackupSummary[]; onRestore: (fileName: string) => void }) {
  const { t, formatDate } = useI18n();
  const [restoreCandidate, setRestoreCandidate] = useState<string | null>(null);
  return <section className="project-backup-panel">
    <div className="project-backup-heading"><div><strong>{t('backup.title')}</strong><small>{t('backup.copy')}</small></div><span>{backups.length}</span></div>
    {backups.length === 0 ? <p className="project-backup-empty">{t('backup.empty')}</p> : <div className="project-backup-list">{backups.slice(0, 5).map((backup) => <div className="project-backup-item" key={backup.fileName}><div><strong>{formatDate(backup.createdAt, { dateStyle: 'short', timeStyle: 'short' })}</strong><small>{Math.max(1, Math.round(backup.size / 1024))} KB</small></div><button type="button" onClick={() => setRestoreCandidate(backup.fileName)}>{t('common.restore')}</button></div>)}</div>}
    {restoreCandidate && <ConfirmDialog title={t('backup.title')} message={t('backup.confirm')} confirmLabel={t('common.restore')} danger={false} onConfirm={() => { const fileName = restoreCandidate; setRestoreCandidate(null); onRestore(fileName); }} onClose={() => setRestoreCandidate(null)} />}
  </section>;
}

export function AssetPanelPro({ onImport, onOpenSettings }: { onImport: (file: File) => void; onOpenSettings: () => void }) {
  const { t, locale, formatNumber } = useI18n();
  const panel = useEditor((state) => state.panel);
  const project = useEditor((state) => state.project)!;
  const applyServerProject = useEditor((state) => state.applyServerProject);
  const currentTime = useEditor((state) => state.currentTime);
  const selectedClipIds = useEditor((state) => state.selectedClipIds);
  const mutateProject = useEditor((state) => state.mutateProject);
  const setSelected = useEditor((state) => state.setSelected);
  const setNotice = useEditor((state) => state.setNotice);
  const fileRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [filter, setFilter] = useState<'all' | Asset['type'] | 'unused'>('all');
  const [view, setView] = useState<'list' | 'grid'>('list');
  const [elementsSection, setElementsSection] = useState<'backgrounds' | 'shapes'>('backgrounds');
  const [isDropActive, setIsDropActive] = useState(false);
  const [stockBusyId, setStockBusyId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; asset?: Asset; panel?: boolean } | null>(null);
  const [mediaHealth, setMediaHealth] = useState<Record<string, { status: 'ready' | 'missing' | 'derived-missing'; sourceExists: boolean; proxyExists: boolean; thumbnailExists: boolean; waveformExists: boolean }>>({});
  const [previewAsset, setPreviewAsset] = useState<Asset | null>(null);
  const [removeCandidate, setRemoveCandidate] = useState<Asset | null>(null);
  const [relinkAssetId, setRelinkAssetId] = useState<string | null>(null);
  const [bulkRebuildBusy, setBulkRebuildBusy] = useState(false);
  const relinkRef = useRef<HTMLInputElement>(null);
  const closeMenu = () => setMenu(null);
  const usageCount = (assetId: string) => project.tracks.reduce((count, track) => count + track.clips.filter((clip) => clip.assetId === assetId).length, 0);
  const refreshMediaHealth = async () => {
    try {
      const rows = await api<Array<{ assetId: string; status: 'ready' | 'missing' | 'derived-missing'; sourceExists: boolean; proxyExists: boolean; thumbnailExists: boolean; waveformExists: boolean }>>(`/api/projects/${project.id}/media-health`);
      setMediaHealth(Object.fromEntries(rows.map((row) => [row.assetId, row])));
    } catch { /* the library remains usable when a health check races a save */ }
  };

  useEffect(() => { void refreshMediaHealth(); }, [project.id, project.assets.length]);
  useEffect(() => {
    const events = new EventSource('/api/events');
    const onJob = (event: Event) => {
      const job = JSON.parse((event as MessageEvent).data) as { projectId?: string; kind?: string; status?: string };
      if (job.projectId !== project.id || job.kind !== 'proxy' || !['completed', 'failed', 'cancelled'].includes(job.status ?? '')) return;
      void api<Project>(`/api/projects/${project.id}`).then((fresh) => {
        applyServerProject(fresh);
        void refreshMediaHealth();
      }).catch(() => void refreshMediaHealth());
    };
    events.addEventListener('job', onJob);
    return () => { events.removeEventListener('job', onJob); events.close(); };
  }, [applyServerProject, project.id]);
  const derivedMissingAssets = useMemo(() => project.assets.filter((asset) => mediaHealth[asset.id]?.status === 'derived-missing' && mediaHealth[asset.id]?.sourceExists), [mediaHealth, project.assets]);
  const visibleAssets = useMemo(() => project.assets.filter((asset) => {
    const query = search.trim().toLocaleLowerCase(locale);
    const matchesType = filter === 'all' || (filter === 'unused' ? usageCount(asset.id) === 0 : asset.type === filter);
    return (!query || `${asset.name} ${asset.mimeType}`.toLocaleLowerCase(locale).includes(query)) && matchesType;
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [filter, locale, project.assets, project.tracks, search]);
  const hasFilePayload = (event: React.DragEvent) => Array.from(event.dataTransfer.types).includes('Files');
  const importDroppedFiles = async (files: File[]) => {
    const supported = files.filter((file) => /^(video|audio|image)\//.test(file.type));
    if (!supported.length) {
      setNotice(t('library.dropUnsupported'));
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
        track = { id: trackId, type: 'layer', name: `Layer ${draft.tracks.length + 1}`, order: draft.tracks.length, clips: [], locked: false, hidden: false, muted: false, volume: 1 };
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
      applyServerProject(result.project);
      addAsset(result.asset, useEditor.getState().currentTime);
      setNotice(t('library.stockAdded', { name: stock.name }));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : t('library.stockAddFailed'));
    } finally {
      setStockBusyId(null);
    }
  };
  const removeAsset = (asset: Asset) => {
    mutateProject((draft) => { draft.assets = draft.assets.filter((item) => item.id !== asset.id); for (const track of draft.tracks) track.clips = track.clips.filter((clip) => clip.assetId !== asset.id); draft.duration = projectDuration(draft); });
    closeMenu();
  };
  const showInfo = (asset: Asset) => { setNotice(`${asset.name} · ${asset.mimeType} · ${asset.duration ? formatTime(asset.duration) : t('library.noDuration')} · ${t('library.bytes', { count: formatNumber(asset.size) })}`); closeMenu(); };
  const rebuildDerived = async (asset: Asset) => {
    closeMenu();
    try {
      await api(`/api/projects/${project.id}/media/${asset.id}/rebuild-derived`, { method: 'POST', body: JSON.stringify({}) });
      setNotice(t('library.rebuilding', { name: asset.name }));
      window.setTimeout(() => void refreshMediaHealth(), 900);
    } catch (error) { setNotice(error instanceof Error ? error.message : t('library.rebuildFailed')); }
  };
  const waitForDerivedJob = async (jobId: string) => {
    for (let attempt = 0; attempt < 160; attempt += 1) {
      const jobs = await api<Array<{ id: string; status: string; error?: string }>>('/api/jobs');
      const job = jobs.find((item) => item.id === jobId);
      if (job?.status === 'completed') return;
      if (job && (job.status === 'failed' || job.status === 'cancelled')) throw new Error(job.error || t('library.derivedJobFailed'));
      await new Promise((resolve) => window.setTimeout(resolve, 250));
    }
    throw new Error(t('library.derivedTimeout'));
  };
  const rebuildAllDerived = async () => {
    if (!derivedMissingAssets.length || bulkRebuildBusy) return;
    closeMenu();
    setBulkRebuildBusy(true);
    let repaired = 0;
    try {
      for (const asset of derivedMissingAssets) {
        setNotice(t('library.preparingAsset', { name: asset.name, current: repaired + 1, total: derivedMissingAssets.length }));
        const result = await api<{ job: { id: string } }>(`/api/projects/${project.id}/media/${asset.id}/rebuild-derived`, { method: 'POST', body: JSON.stringify({}) });
        await waitForDerivedJob(result.job.id);
        repaired += 1;
        const fresh = await api<Project>(`/api/projects/${project.id}`);
        applyServerProject(fresh);
        await refreshMediaHealth();
      }
      setNotice(t('library.rebuildDone', { count: repaired }));
    } catch (error) {
      setNotice(t('library.rebuildPartial', { repaired, total: derivedMissingAssets.length, reason: error instanceof Error ? error.message : t('library.operationFailed') }));
    } finally {
      setBulkRebuildBusy(false);
      await refreshMediaHealth();
    }
  };
  const relinkMedia = async (file: File) => {
    const asset = project.assets.find((item) => item.id === relinkAssetId);
    setRelinkAssetId(null);
    if (!asset) return;
    const form = new FormData();
    form.append('file', file);
    try {
      const result = await api<{ project: Project }>(`/api/projects/${project.id}/media/${asset.id}/relink`, { method: 'POST', body: form });
      applyServerProject(result.project);
      setNotice(t('library.relinked', { name: asset.name }));
      window.setTimeout(() => void refreshMediaHealth(), 900);
    } catch (error) { setNotice(error instanceof Error ? error.message : t('library.relinkFailed')); }
  };
  const title = t(panelTitle(panel));
  const panelMenuItems: ContextMenuItem[] = [
    { label: t('library.menu.import'), icon: '+', onSelect: () => fileRef.current?.click() },
    { label: t('library.menu.refresh'), icon: '↻', onSelect: () => { void api<Project>(`/api/projects/${project.id}`).then((fresh) => applyServerProject(fresh)); } },
    { label: bulkRebuildBusy ? t('library.menu.rebuilding') : t('library.menu.rebuildMissing', { count: derivedMissingAssets.length }), icon: '⟳', disabled: bulkRebuildBusy || derivedMissingAssets.length === 0, onSelect: () => { void rebuildAllDerived(); } },
    { label: t('library.menu.settings'), icon: '⚙', onSelect: onOpenSettings },
  ];
  const assetMenuItems = (asset: Asset): ContextMenuItem[] => [
    { label: t('library.menu.preview'), icon: '▶', onSelect: () => { setPreviewAsset(asset); closeMenu(); } },
    { label: t('library.menu.addTimeline'), icon: '+', shortcut: 'Enter', onSelect: () => addAsset(asset) },
    { label: t('library.menu.copyName'), icon: '⧉', onSelect: () => { void navigator.clipboard?.writeText(asset.name); closeMenu(); } },
    { label: t('library.menu.info'), icon: 'i', onSelect: () => showInfo(asset) },
    { label: t('library.menu.rebuild'), icon: '↻', onSelect: () => { void rebuildDerived(asset); } },
    { label: t('library.menu.relink'), icon: '↪', onSelect: () => { setRelinkAssetId(asset.id); window.setTimeout(() => relinkRef.current?.click(), 0); closeMenu(); } },
    { label: t('library.menu.showUsage'), icon: '⌁', onSelect: () => setNotice(t('library.timelineUsage', { count: usageCount(asset.id) })) },
    { label: t('library.menu.remove'), icon: '×', danger: true, onSelect: () => { setRemoveCandidate(asset); closeMenu(); } },
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
    if (!selected.length) { setNotice(t('effects.selectClip')); return; }
    mutateProject((draft) => { for (const clip of draft.tracks.flatMap((track) => track.clips)) { if (!selected.includes(clip.id)) continue; if (preset === 'film') { clip.filters.brightness = -0.05; clip.filters.contrast = 0.12; clip.filters.saturation = -0.1; } if (preset === 'retro') { clip.filters.saturation = -0.22; } if (preset === 'glow') clip.filters.blur = 1.5; if (preset === 'blur') clip.filters.blur = 8; if (preset === 'chroma') clip.filters.chromaKey = { color: '#00ff00', similarity: 0.35, blend: 0.1 }; if (preset === 'noise') clip.filters.grayscale = 0.08; } });
  };
  if (panel === 'media') {
    return <aside className="asset-panel asset-panel-pro">
      <div className="panel-heading media-panel-heading"><div><h2>{t('editor.panel.media')}</h2><small>{t('library.mediaSubtitle')}</small></div><div className="media-heading-actions"><button type="button" className="media-import-primary" onClick={() => fileRef.current?.click()}><span>＋</span>{t('library.addMedia')}</button><button className="panel-more" aria-label={t('library.panelMenu')} onClick={(event) => { event.stopPropagation(); setMenu({ x: event.clientX, y: event.clientY, panel: true }); }}>•••</button></div></div>
      <input ref={fileRef} className="hidden-input" type="file" accept="video/*,audio/*,image/*" onChange={(event) => { const file = event.target.files?.[0]; if (file) onImport(file); event.target.value = ''; }} />
      <input ref={relinkRef} className="hidden-input" type="file" accept="video/*,audio/*,image/*" onChange={(event) => { const file = event.target.files?.[0]; if (file) void relinkMedia(file); event.target.value = ''; }} />
      {project.assets.length > 0 && <><div className="media-compact-tools"><button type="button" className={searchOpen ? 'media-search-toggle active' : 'media-search-toggle'} aria-label={t('library.search')} aria-expanded={searchOpen} onClick={() => { setSearchOpen((value) => !value); if (searchOpen) setSearch(''); }}>⌕</button><select className="media-filter-compact" value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)} aria-label={t('library.filter')}><option value="all">{t('library.allMedia')}</option><option value="video">{t('library.video')}</option><option value="audio">{t('library.audio')}</option><option value="image">{t('library.image')}</option><option value="unused">{t('library.unused')}</option></select><button type="button" className="media-view-button" onClick={() => setView((value) => value === 'list' ? 'grid' : 'list')} title={t(view === 'list' ? 'library.gridView' : 'library.listView')} aria-label={t(view === 'list' ? 'library.gridView' : 'library.listView')}>{view === 'list' ? '▦' : '☰'}</button></div>{searchOpen && <div className="media-search-field media-search-expanded"><span aria-hidden="true">⌕</span><input autoFocus className="media-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('library.search')} aria-label={t('library.search')} />{search && <button type="button" className="media-search-clear" aria-label={t('library.clearSearch')} onClick={() => setSearch('')}>×</button>}</div>}</>}
      <div className={`asset-list media-content-list ${view === 'grid' ? 'asset-grid-view' : ''} ${isDropActive ? 'is-drop-active' : ''}`} role="region" aria-label={t('library.dropRegion')} onDragEnter={handleMediaDragEnter} onDragOver={handleMediaDragOver} onDragLeave={handleMediaDragLeave} onDrop={handleMediaDrop}>{visibleAssets.length === 0 ? <div className="media-empty-state"><span>▧</span><strong>{project.assets.length === 0 ? t('library.emptyTitle') : t('library.notFound')}</strong><small>{project.assets.length === 0 ? t('library.emptyCopy') : t('library.notFoundHint')}</small><button type="button" onClick={() => fileRef.current?.click()}>＋ {t('library.addMedia')}</button></div> : visibleAssets.map((asset) => <AssetCardPro key={asset.id} projectId={project.id} asset={asset} usage={usageCount(asset.id)} health={mediaHealth[asset.id]} view={view} onAdd={() => addAsset(asset)} onPreview={() => setPreviewAsset(asset)} onOpenMenu={(event) => { event.stopPropagation(); setMenu({ x: event.clientX, y: event.clientY, asset }); }} />)}{isDropActive && <div className="media-drop-overlay" aria-live="polite"><span>＋</span><strong>{t('library.dropFiles')}</strong><small>{t('library.dropHint')}</small></div>}</div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.panel ? panelMenuItems : menu.asset ? assetMenuItems(menu.asset) : []} onClose={closeMenu} />}
      {previewAsset && <MediaPreviewModal projectId={project.id} asset={previewAsset} onClose={() => setPreviewAsset(null)} />}
      {removeCandidate && <ConfirmDialog title={t('library.menu.remove')} message={t('library.removeConfirm')} confirmLabel={t('library.menu.remove')} onConfirm={() => { const asset = removeCandidate; setRemoveCandidate(null); removeAsset(asset); }} onClose={() => setRemoveCandidate(null)} />}
    </aside>;
  }
  if (panel === 'elements') {
    return <aside className="asset-panel asset-panel-pro elements-panel">
      <div className="panel-heading compact-panel-heading"><div><h2>{t('editor.panel.elements')}</h2><small>{t('library.elementsSubtitle')}</small></div></div>
      <div className="elements-source-tabs" role="tablist" aria-label={t('library.elementSources')}><button type="button" role="tab" aria-selected={elementsSection === 'backgrounds'} className={elementsSection === 'backgrounds' ? 'active' : ''} onClick={() => setElementsSection('backgrounds')}>▧ {t('library.backgrounds')}</button><button type="button" role="tab" aria-selected={elementsSection === 'shapes'} className={elementsSection === 'shapes' ? 'active' : ''} onClick={() => setElementsSection('shapes')}>◇ {t('library.shapes')}</button></div>
      {elementsSection === 'backgrounds' ? <StockMediaShelf busyId={stockBusyId} onAdd={(stock) => void addStock(stock)} /> : <ShapeShelf onAdd={addTextClip} />}
    </aside>;
  }
  if (panel === 'text') {
    return <aside className="asset-panel asset-panel-pro text-panel">
      <div className="panel-heading compact-panel-heading"><div><h2>{title}</h2><small>{t('text.panelSubtitle')}</small></div><button className="panel-more" aria-label={t('library.panelMenu')} onClick={(event) => { event.stopPropagation(); setMenu({ x: event.clientX, y: event.clientY, panel: true }); }}>•••</button></div>
      <PanelContent panel={panel} onAddText={addTextClip} onApplyEffect={applyEffect} onOpenSettings={onOpenSettings} />
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.panel ? panelMenuItems : menu.asset ? assetMenuItems(menu.asset) : []} onClose={closeMenu} />}
    </aside>;
  }
  return <aside className="asset-panel asset-panel-pro">
    <div className="panel-heading"><div><p className="eyebrow">{t('library.title')}</p><h2>{title}</h2></div><button className="panel-more" aria-label={t('library.panelMenu')} onClick={(event) => { event.stopPropagation(); setMenu({ x: event.clientX, y: event.clientY, panel: true }); }}>•••</button></div>
    <PanelContent panel={panel} onAddText={addTextClip} onApplyEffect={applyEffect} onOpenSettings={onOpenSettings} />
    {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.panel ? panelMenuItems : menu.asset ? assetMenuItems(menu.asset) : []} onClose={closeMenu} />}
  </aside>;
}

function StockMediaShelf({ busyId, onAdd }: { busyId: string | null; onAdd: (stock: StockMediaItem) => void }) {
  const { t } = useI18n();
  const [category, setCategory] = useState<'all' | StockMediaItem['category']>('all');
  const localizedStocks = STOCK_MEDIA.map((stock) => localizeStockMedia(stock, t));
  const visible = category === 'all' ? localizedStocks : localizedStocks.filter((stock) => stock.category === category);
  return <section className="stock-media-shelf" aria-label={t('library.stockAria')}><div className="stock-shelf-heading"><div><strong>{t('library.stockTitle')}</strong><small>{t('library.stockCopy')}</small></div><span>{STOCK_MEDIA.length}</span></div><div className="stock-category-tabs">{(['all', 'solid', 'soft', 'texture'] as const).map((value) => <button key={value} className={category === value ? 'active' : ''} onClick={() => setCategory(value)}>{t(`library.category.${value}` as TranslationKey)}</button>)}</div><div className="stock-media-grid">{visible.map((stock) => <button key={stock.id} className="stock-media-card" onClick={() => onAdd(stock)} disabled={busyId !== null} aria-label={t('library.stockAddAria', { name: stock.name })}><span className={`stock-preview stock-${stock.id}`}><img src={`/api/stock/${stock.id}`} alt="" /></span><span><strong>{busyId === stock.id ? t('common.adding') : stock.name}</strong><small>{stock.description}</small></span><b>＋</b></button>)}</div></section>;
}

function ShapeShelf({ onAdd }: { onAdd: (preset: TextPreset) => void }) {
  const { t } = useI18n();
  const [category, setCategory] = useState<ShapePreset['category'] | 'all'>('all');
  const localizedShapes = SHAPE_PRESETS.map((shape) => localizeShapePreset(shape, t));
  const visibleShapes = category === 'all' ? localizedShapes : localizedShapes.filter((shape) => shape.category === category);
  const baseTextPreset = localizeTextPreset(TEXT_PRESETS[0], t);
  return <section className="shape-shelf" aria-label={t('library.shapes')}>
    <div className="stock-shelf-heading"><div><strong>{t('library.shapesTitle')}</strong><small>{t('library.shapesCopy')}</small></div><span>{SHAPE_PRESETS.length}</span></div>
    <div className="shape-category-tabs" role="tablist" aria-label={t('library.shapeCategories')}>
      {(['all', 'basic', 'arrows', 'symbols', 'badges'] as const).map((value) => <button key={value} role="tab" aria-selected={category === value} className={category === value ? 'active' : ''} onClick={() => setCategory(value)}>{t(`library.category.${value}` as TranslationKey)}</button>)}
    </div>
    <div className="shape-shelf-grid">{visibleShapes.map((shape) => <button key={shape.id} className="shape-card" onClick={() => onAdd({ ...baseTextPreset, id: `shape-${shape.id}-${Date.now()}`, label: t('library.shapeClipName', { name: shape.label }), text: shape.glyph, fontSize: 120, color: shape.color, background: 'transparent' })} aria-label={t('library.shapeAddAria', { name: shape.label })}><b style={{ color: shape.color }}>{shape.glyph}</b><span><strong>{shape.label}</strong><small>{shape.description}</small></span><i>＋</i></button>)}</div>
  </section>;
}

function AssetCardPro({ projectId, asset, usage, health, view, onAdd, onPreview = () => undefined, onOpenMenu }: { projectId: string; asset: Asset; usage: number; health?: { status: 'ready' | 'missing' | 'derived-missing'; sourceExists: boolean; proxyExists: boolean; thumbnailExists: boolean; waveformExists: boolean }; view: 'list' | 'grid'; onAdd: () => void; onPreview?: () => void; onOpenMenu: (event: React.MouseEvent<HTMLButtonElement>) => void }) {
  const { t } = useI18n();
  const [previewFailed, setPreviewFailed] = useState(false);
  const icon = asset.type === 'video' ? '▶' : asset.type === 'audio' ? '♫' : '▧';
  const meta = asset.duration ? formatTime(asset.duration) : asset.mimeType.split('/')[1]?.toUpperCase() || 'MEDIA';
  const assetDetails = `${asset.width && asset.height ? `${asset.width} × ${asset.height}` : asset.type}${usage > 0 ? ` · ${t('library.usedCount', { count: usage })}` : ` · ${t('library.notUsed')}`}`;
  const mediaUrl = `/api/projects/${projectId}/media/${asset.id}`;
  const preview = !previewFailed && asset.type === 'image' ? <img src={mediaUrl} alt="" onError={() => setPreviewFailed(true)} /> : !previewFailed && asset.type === 'video' ? <video src={mediaUrl} poster={asset.thumbnailPath ? `${mediaUrl}?thumbnail=1` : undefined} muted preload="metadata" onError={() => setPreviewFailed(true)} /> : null;
  const status = health?.status ?? (asset.proxyPath || asset.thumbnailPath || asset.waveformPath ? 'ready' : 'derived-missing');
  const statusLabel = t(status === 'ready' ? 'library.status.ready' : status === 'missing' ? 'library.status.missing' : 'library.status.derivedMissing');
  return <div className={`asset-item pro ${view === 'grid' ? 'grid-card' : ''} media-${status}`} draggable onPointerDown={(event) => { if (!(event.target as HTMLElement).closest('button')) useEditor.getState().setAssetDragId(asset.id); }} onPointerUp={() => useEditor.getState().setAssetDragId(null)} onPointerCancel={() => useEditor.getState().setAssetDragId(null)} onDragStart={(event) => { event.dataTransfer.effectAllowed = 'copy'; event.dataTransfer.setData('application/x-cutloc-asset', JSON.stringify({ assetId: asset.id })); useEditor.getState().setAssetDragId(asset.id); }} onDragEnd={() => useEditor.getState().setAssetDragId(null)} onDoubleClick={onPreview} onContextMenu={(event) => { event.preventDefault(); onOpenMenu(event as unknown as React.MouseEvent<HTMLButtonElement>); }}><button type="button" className={`asset-thumb ${asset.type} ${preview ? 'has-preview' : ''}`} onClick={(event) => { event.stopPropagation(); onPreview(); }} aria-label={t('library.previewAria', { name: asset.name })}><span className="asset-thumb-fallback">{icon}</span>{preview}<small>{meta}</small></button><div className="asset-info"><strong title={asset.name}>{asset.name}</strong><small>{assetDetails}</small><span className={`asset-health asset-health-${status}`}><i />{statusLabel}</span></div><button className="asset-add-button" onClick={(event) => { event.stopPropagation(); onAdd(); }} aria-label={t('library.addToTimelineAria', { name: asset.name })}>＋ <span>{t('common.add')}</span></button><button className="asset-dots" aria-label={t('library.itemMenuAria', { name: asset.name })} onClick={onOpenMenu}>•••</button></div>;
}

function MediaPreviewModal({ projectId, asset, onClose }: { projectId: string; asset: Asset; onClose: () => void }) {
  const { t } = useI18n();
  const source = `/api/projects/${projectId}/media/${asset.id}`;
  return <div className="media-preview-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="media-preview-modal" role="dialog" aria-modal="true" aria-label={t('library.previewAria', { name: asset.name })}><div className="modal-head"><div><p className="eyebrow">{t('library.sourceMonitor')}</p><h2>{asset.name}</h2></div><button onClick={onClose} aria-label={t('library.closePreview')}>×</button></div><div className="media-preview-stage">{asset.type === 'video' ? <video src={source} controls autoPlay playsInline /> : asset.type === 'audio' ? <audio src={source} controls autoPlay /> : <img src={source} alt={asset.name} />}</div><p className="media-preview-note">{t('library.previewNote')}</p></section></div>;
}
