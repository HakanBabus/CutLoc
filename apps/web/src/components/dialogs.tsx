import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { useI18n } from '../i18n';
import './dialogs.css';

function DialogShell({ labelledBy, children, onClose }: { labelledBy: string; children: ReactNode; onClose: () => void }) {
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    dialog?.querySelector<HTMLElement>('input, button, select, textarea, [tabindex]:not([tabindex="-1"])')?.focus();
    return () => previous?.focus();
  }, []);
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('input, button, select, textarea, [tabindex]:not([tabindex="-1"])')).filter((item) => !item.hasAttribute('disabled'));
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section ref={dialogRef} className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby={labelledBy} onKeyDown={onKeyDown}>{children}</section></div>;
}

export function ConfirmDialog({ title, message, confirmLabel, cancelLabel, danger = true, onConfirm, onCancel, onClose }: { title: string; message: string; confirmLabel: string; cancelLabel?: string; danger?: boolean; onConfirm: () => void; onCancel?: () => void; onClose: () => void }) {
  const { t } = useI18n();
  return <DialogShell labelledBy="confirm-dialog-title" onClose={onClose}><div className="modal-head"><div><p className="eyebrow">{t('confirm.eyebrow')}</p><h2 id="confirm-dialog-title">{title}</h2></div><button onClick={onClose} aria-label={t('common.close')}>×</button></div><p>{message}</p><div className="modal-actions"><button className="secondary-button" onClick={onCancel ?? onClose}>{cancelLabel ?? t('common.cancel')}</button><button className={`primary-button ${danger ? 'danger-button' : ''}`} onClick={onConfirm}>{confirmLabel}</button></div></DialogShell>;
}

export function MessageDialog({ title, message, onClose }: { title: string; message: string; onClose: () => void }) {
  const { t } = useI18n();
  return <DialogShell labelledBy="message-dialog-title" onClose={onClose}><div className="modal-head"><h2 id="message-dialog-title">{title}</h2><button onClick={onClose} aria-label={t('common.close')}>×</button></div><p>{message}</p><div className="modal-actions"><button className="primary-button" onClick={onClose}>{t('common.close')}</button></div></DialogShell>;
}

export function PromptDialog({ title, label, initialValue, confirmLabel, onConfirm, onClose }: { title: string; label: string; initialValue: string; confirmLabel: string; onConfirm: (value: string) => void; onClose: () => void }) {
  const { t } = useI18n();
  const [value, setValue] = useState(initialValue);
  const submit = () => { const next = value.trim(); if (next) onConfirm(next); };
  return <DialogShell labelledBy="prompt-dialog-title" onClose={onClose}><div className="modal-head"><h2 id="prompt-dialog-title">{title}</h2><button onClick={onClose} aria-label={t('common.close')}>×</button></div><label className="dialog-input"><span>{label}</span><input value={value} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); submit(); } }} /></label><div className="modal-actions"><button className="secondary-button" onClick={onClose}>{t('common.cancel')}</button><button className="primary-button" disabled={!value.trim()} onClick={submit}>{confirmLabel}</button></div></DialogShell>;
}
