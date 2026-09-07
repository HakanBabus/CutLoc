import { useI18n, type TranslationKey } from '../i18n';
import { useEditor, type Theme } from '../editor/store';

export function ThemeSwitcher({ compact = false }: { compact?: boolean }) {
  const { t } = useI18n();
  const theme = useEditor((state) => state.theme);
  const setTheme = useEditor((state) => state.setTheme);
  const options: Array<[Theme, TranslationKey, string]> = [['light', 'theme.light', '○'], ['gray', 'theme.gray', '◐'], ['dark', 'theme.dark', '●']];
  return <div className={`theme-switcher ${compact ? 'compact' : ''}`} role="group" aria-label={t('theme.label')}>
    {options.map(([value, labelKey, icon]) => { const label = t(labelKey); const optionLabel = t('theme.option', { name: label }); return <button key={value} className={theme === value ? 'active' : ''} onClick={() => setTheme(value)} title={optionLabel} aria-label={optionLabel}><span>{icon}</span>{!compact && <small>{label}</small>}</button>; })}
  </div>;
}
