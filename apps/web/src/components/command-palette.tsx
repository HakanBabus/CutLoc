import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../i18n';

export type CommandAction = { id: string; label: string; icon: string; shortcut?: string; run: () => void };

export function CommandPalette({ actions, onClose }: { actions: CommandAction[]; onClose: () => void }) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return actions.filter((action) => action.label.toLocaleLowerCase().includes(needle));
  }, [actions, query]);
  useEffect(() => setActiveIndex(0), [query]);
  const run = (action: CommandAction | undefined) => {
    if (!action) return;
    action.run();
    onClose();
  };
  return <div className="command-palette-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="command-palette" role="dialog" aria-modal="true" aria-labelledby="command-palette-title" onKeyDown={(event) => {
    if (event.key === 'Escape') { event.preventDefault(); onClose(); }
    if (event.key === 'ArrowDown') { event.preventDefault(); setActiveIndex((index) => Math.min(filtered.length - 1, index + 1)); }
    if (event.key === 'ArrowUp') { event.preventDefault(); setActiveIndex((index) => Math.max(0, index - 1)); }
    if (event.key === 'Enter') { event.preventDefault(); run(filtered[activeIndex]); }
  }}><div className="command-palette-head"><span>⌕</span><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('command.placeholder')} aria-label={t('command.title')} /><kbd>ESC</kbd></div><div className="command-palette-list">{filtered.length ? filtered.map((action, index) => <button key={action.id} className={index === activeIndex ? 'active' : ''} onMouseEnter={() => setActiveIndex(index)} onClick={() => run(action)}><span className="command-palette-icon">{action.icon}</span><strong>{action.label}</strong>{action.shortcut && <kbd>{action.shortcut}</kbd>}</button>) : <div className="command-palette-empty">{t('command.empty')}</div>}</div><footer><strong id="command-palette-title">{t('command.title')}</strong><span>{t('command.hint')}</span></footer></section></div>;
}
