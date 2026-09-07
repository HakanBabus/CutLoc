import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';

export type ContextMenuItem = {
  label: string;
  icon?: string;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
};

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: ContextMenuItem[]; onClose: () => void }) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  useEffect(() => {
    const closeOnPointer = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) onClose(); };
    const closeOnKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('pointerdown', closeOnPointer);
    document.addEventListener('keydown', closeOnKey);
    return () => { document.removeEventListener('pointerdown', closeOnPointer); document.removeEventListener('keydown', closeOnKey); };
  }, [onClose]);
  useEffect(() => {
    const element = menuRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const gutter = 8;
    setPosition({
      left: Math.max(gutter, Math.min(x, window.innerWidth - rect.width - gutter)),
      top: Math.max(gutter, Math.min(y, window.innerHeight - rect.height - gutter)),
    });
  }, [x, y, items.length]);
  const portalTarget = document.querySelector('.i18n-root') ?? document.body;
  return createPortal(<div ref={menuRef} className="context-menu" role="menu" style={{ left: position.left, top: position.top }} onPointerDown={(event) => event.stopPropagation()}>
    {items.map((item, index) => <button key={`${item.label}-${index}`} className={item.danger ? 'danger' : ''} disabled={item.disabled} role="menuitem" onClick={() => { onClose(); item.onSelect(); }}><span className="context-menu-icon">{item.icon ?? '•'}</span><span>{item.label}</span>{item.shortcut && <kbd>{item.shortcut}</kbd>}</button>)}
  </div>, portalTarget);
}
