import { useEffect, useRef, type ReactNode } from 'react';

export type UiLanguage = 'en' | 'tr';

const ENGLISH: Record<string, string> = {
  'Ayarlar': 'Settings', 'Genel': 'General', 'Kısayollar': 'Shortcuts', 'Kaydet': 'Save', 'Vazgeç': 'Cancel',
  'Kaydedildi': 'Saved', 'Kaydediliyor…': 'Saving…', 'Arayüz dili': 'Interface language',
  'Değişiklik kaydedildiğinde tüm arayüze uygulanır': 'Applied to the entire interface after saving',
  'Çıktı çözünürlüğü': 'Output resolution', 'Preview kalitesi': 'Preview quality', 'Video encoder': 'Video encoder',
  'Canvas oranı korunarak gerçek video boyutu belirlenir': 'Sets the real video size while preserving the canvas aspect.',
  'Uzun projelerde akıcılık': 'Playback performance for longer projects',
  'Bu sürümde doğrulanmış yerel encoder': 'Verified local encoder for this release',
  'Çalışma alanı': 'Workspace', 'Varsayılan düzene dön': 'Reset layout',
  'Panelleri sürükleyerek genişlik ve yüksekliği değiştirebilirsin.': 'Drag the panel dividers to change their width and height.',
  'Kurgu kısayolları': 'Editing shortcuts', 'Kısayollar bu sürümde sabittir; yanlışlıkla değiştirilemez.': 'Shortcuts are fixed in this release and cannot be changed accidentally.',
  'Oynat / duraklat': 'Play / pause', 'Geri al': 'Undo', 'Yinele': 'Redo', 'Klibi böl': 'Split clip',
  'Preview oynatmayı açıp kapatır': 'Toggles preview playback', 'Son düzenlemeyi geri alır': 'Undoes the last edit',
  'Geri alınan düzenlemeyi tekrarlar': 'Redoes the reverted edit', 'Seçili klibi playhead noktasında böler': 'Splits the selected clip at the playhead',
  'Export başlangıcını belirler': 'Sets the export start', 'Export bitişini belirler': 'Sets the export end',
  'Seçili export aralığını kaldırır': 'Clears the selected export range', 'Seçili klibi timeline’dan kaldırır': 'Removes the selected clip from the timeline',
  'Seçili kliplerin kopyasını oluşturur': 'Creates a copy of the selected clips', 'Kilitsiz track kliplerini seçer': 'Selects clips on unlocked tracks',
  'In noktası': 'In point', 'Out noktası': 'Out point', 'In/Out temizle': 'Clear In/Out', 'Klibi sil': 'Delete clip',
  'Klibi çoğalt': 'Duplicate clip', 'Tüm klipleri seç': 'Select all clips',
  'Medya': 'Media', 'Metin': 'Text', 'Altyazı': 'Captions', 'Altyazılar': 'Captions', 'Proje': 'Project',
  'Şekiller': 'Shapes', 'Geçişler': 'Transitions', 'Efektler': 'Effects', 'Renk': 'Color', 'Animasyon': 'Animation',
  'Yardım': 'Help', 'Ayar': 'Settings', 'AI Sohbet': 'AI Chat', 'Yakında': 'Soon',
  'Projeler': 'Projects', 'Çöp Kutusu': 'Trash', 'Yeni proje': 'New project', 'Yeni proje oluştur': 'Create new project',
  'Yerel video editörü': 'Local video editor', 'Yerel mod': 'Local mode', 'Tema seçimi': 'Theme selection',
  'Beyaz': 'Light', 'Gri': 'Gray', 'Siyah': 'Dark', 'Beyaz tema': 'Light theme', 'Gri tema': 'Gray theme', 'Siyah tema': 'Dark theme',
  'Hızlı başlangıç': 'Quick start', 'Boş bir canvas ile başla': 'Start with a blank canvas',
  'Medyayla başla': 'Start with media', 'Dosyanı ekle ve timeline’a yerleştir': 'Add a file and place it on the timeline',
  'Düzenlemeye devam et': 'Continue editing', 'Yerel çalışma alanı': 'Local workspace', 'Dosyaların cihazından çıkmaz': 'Your files stay on your device',
  'Çalışma alanın': 'Your workspace', 'Taslakların': 'Your drafts', 'Kurgu var': 'Edited', 'Başlangıç': 'New',
  'Kurtarma alanı': 'Recovery area', 'Çöp kutusu': 'Trash', 'Verilerin cihazında kalır': 'Your data stays on your device',
  'Silinen projeler burada tutulur; istersen geri yükleyebilir veya kalıcı olarak temizleyebilirsin.': 'Deleted projects stay here until you restore or permanently remove them.',
  'İlk hikâyeni başlat': 'Start your first story', 'Bir proje oluştur ve medya dosyalarını sürükleyerek timeline’a ekle.': 'Create a project and drag media files onto the timeline.',
  'Projelerin': 'Your projects', 'Henüz proje yok': 'No projects yet', 'Projeyi aç': 'Open project', 'Sil': 'Delete',
  'Geri yükle': 'Restore', 'Kalıcı sil': 'Delete permanently', 'Çöp kutusu boş': 'Trash is empty',
  'Yaratıcılık, cihazında': 'Creativity, on your device', 'Hikâyeni': 'Your story,', 'kes.': 'cut.', 'Kendi ritmini bul.': 'Find your own rhythm.',
  'Videolarını, seslerini ve fikirlerini tek bir yerel çalışma alanında birleştir. Verilerin dışarı çıkmaz.': 'Bring videos, audio and ideas together in one local workspace. Your data stays on your device.',
  'Son projeler': 'Recent projects', 'Tümünü gör': 'View all', 'Son düzenlenen': 'Recently edited',
  'Kütüphane': 'Library', 'Dosyalar': 'Files', 'Stok': 'Stock', 'Şekil': 'Shapes', 'İçe aktar': 'Import',
  'Projendeki dosyaları yönet, ara ve timeline’a yerleştir.': 'Manage, search and place project files on the timeline.',
  'Dosya ekle': 'Add files', 'Medya ara…': 'Search media…', 'Tümü': 'All', 'Video': 'Video', 'Ses': 'Audio', 'Görsel': 'Image',
  'Panel menüsü': 'Panel menu', 'Medya kaynakları': 'Media sources', 'PROJE MEDYASI': 'PROJECT MEDIA',
  'Medya ekle': 'Add media', 'Medya ara': 'Search media', 'Medya filtresi': 'Media filter', 'Medya sıralama': 'Sort media',
  'Tüm medya': 'All media', 'Son eklenen': 'Recently added', 'Ada göre': 'By name', 'Süreye göre': 'By duration',
  'Liste görünümü': 'List view', 'Kart görünümü': 'Card view', 'Liste': 'List', 'Medya dosyalarını bırakma alanı': 'Media drop area',
  'Kullanılmadı': 'Unused',
  'Kullanılmayan': 'Unused', 'Henüz medya yok': 'No media yet', 'Dosyalarını buraya ekle': 'Add your files here',
  'Medya bulunamadı': 'No media found', 'Arama veya filtreyi değiştir': 'Change the search or filter', 'Ekle': 'Add', 'Ekleniyor…': 'Adding…',
  'Stok yüzeyler': 'Stock backgrounds', 'Beyaz, siyah ve hazır arka planlar': 'Solid colors, textures and ready backgrounds',
  'Temel şekiller': 'Basic shapes', 'Timeline’a metin tabanlı şekil ekle': 'Add a text-based shape to the timeline',
  'Canvas': 'Canvas', 'Klip kadrajı': 'Clip framing', 'Medya: Sığdır': 'Media: Fit', 'Medya: Doldur': 'Media: Fill',
  'Preview oranı': 'Preview aspect', 'Dikey': 'Portrait', 'Kare': 'Square', 'Klasik': 'Classic', 'Sinematik': 'Cinematic',
  'Medya kadrajı': 'Media framing', 'Preview görünümü': 'Preview view', 'Canvas yakınlaştırma': 'Canvas zoom',
  'Akıllı kadraj': 'Smart framing', 'Güvenli alan': 'Safe area', 'Tam ekran': 'Fullscreen', 'Önceki kare': 'Previous frame',
  'Sonraki kare': 'Next frame', 'Başa sar': 'Go to start', 'Oynat': 'Play', 'Duraklat': 'Pause',
  'Klip seç': 'Select a clip', 'Özellikleri düzenlemek için timeline’dan bir klip seç.': 'Select a clip on the timeline to edit its properties.',
  'Özellikleri düzenlemek için timeline\'dan bir klip seç.': 'Select a clip on the timeline to edit its properties.',
  'Yerleşim': 'Layout', 'Ses ve kırpma': 'Audio & trim', 'Hız': 'Speed', 'Görünüm': 'Appearance', 'Yazı stili': 'Text style',
  'Klibi tuval üzerinde taşı, boyutlandır, döndür ve saydamlığını ayarla.': 'Move, resize, rotate and adjust clip opacity on the canvas.',
  'Klibin zaman içinde nasıl hareket edeceğini keyframe noktalarıyla belirle.': 'Use keyframes to define how the clip changes over time.',
  'Transform': 'Transform', 'Saydamlık %': 'Opacity %', 'Yatay çevir': 'Flip horizontal', 'Dikey çevir': 'Flip vertical',
  'Timeline’a sığdır': 'Fit timeline', 'Track ekle': 'Add track', 'Seçim': 'Select', 'Marker ekle': 'Add marker',
  'Böl': 'Split', 'Marker ve klip kenarı snap': 'Marker and clip-edge snapping',
  'Ctrl/⌘ + ←/→ ile klibi kare hassasiyetinde taşı': 'Use Ctrl/⌘ + ←/→ to move clips one frame at a time',
  'Araç çubuğu genişliğini ayarla': 'Resize tool rail', 'Sol panel genişliğini ayarla': 'Resize left panel',
  'Inspector genişliğini ayarla': 'Resize Inspector', 'Timeline yüksekliğini ayarla': 'Resize timeline',
  'CutLoc hazır': 'CutLoc is ready', 'Tüm değişiklikler kaydedildi': 'All changes saved',
  '⌘/Ctrl Z geri al · Space oynat': '⌘/Ctrl Z to undo · Space to play',
  'In/Out yok': 'No In/Out', 'Snap kapalı': 'Snap off', 'Marker ve klip kenarı snap açık': 'Marker and clip-edge snapping on',
  'Dışa aktar': 'Export', 'Dışa aktarma': 'Export', 'Render studio': 'Render studio', 'Kapat': 'Close',
  'Preview oranı korunur': 'Preview aspect is preserved', 'Çıktı:': 'Output:', 'Format': 'Format', 'Çözünürlük': 'Resolution',
  'Frame rate': 'Frame rate', 'Ses bitrate': 'Audio bitrate', 'Kalite': 'Quality', 'Taslak': 'Draft', 'Standart': 'Standard',
  'Yüksek': 'High', 'Gelişmiş': 'Advanced', 'Kapsam': 'Range', 'Tüm timeline': 'Entire timeline', 'belirlenmedi': 'not set',
  'Dosya adı': 'File name', 'Video export': 'Video export', 'Ses export': 'Audio export', 'Hazırlanıyor': 'Preparing',
  'Hazır': 'Ready', 'Kopyalandı': 'Copied', 'Yolu kopyala': 'Copy path', 'Yeniden export': 'Export again',
  'Export ediliyor…': 'Exporting…', 'FFmpeg yerel olarak çalışır': 'FFmpeg runs locally',
  'Aç': 'Open', 'İptal': 'Cancel', 'Onayla': 'Confirm', 'Ara': 'Search', 'Daha fazla': 'More',
};

const SKIP_SELECTOR = [
  '.project-name-input', '.project-card-title h3', '.preview-text', '.timeline-clip strong', '.asset-info strong',
  '.selected-file strong', '.export-complete code', 'textarea', '[data-i18n-skip]',
].join(',');

function translate(value: string, language: UiLanguage) {
  if (language === 'tr') return value;
  const leading = value.match(/^\s*/)?.[0] ?? '';
  const trailing = value.match(/\s*$/)?.[0] ?? '';
  const core = value.trim();
  if (!core) return value;
  const exact = ENGLISH[core];
  if (exact) return `${leading}${exact}${trailing}`;
  return value
    .replace(/(\d+) medya varlığı/gi, '$1 media assets')
    .replace(/(\d+) medya/gi, '$1 media')
    .replace(/(\d+) proje/gi, '$1 projects')
    .replace(/(\d+) dosya/gi, '$1 files')
    .replace(/(\d+) sonuç/gi, '$1 results')
    .replace(/(\d+) kayıt/gi, '$1 items')
    .replace(/(\d+) aktif timeline/gi, '$1 active timelines')
    .replace(/ · (\d+) kullanım/gi, ' · $1 use')
    .replace(/timeline['’]a ekle/gi, 'add to timeline')
    .replace(/ menüsü\b/gi, ' menu')
    .replace(/ kısayolu\b/gi, ' shortcut')
    .replace(/(\d+) klip seçili/g, '$1 clips selected')
    .replace(/Tahmini boyut:/g, 'Estimated size:')
    .replace(/Çıktı:/g, 'Output:')
    .replace(/ · kullanımlar?/g, ' · uses');
}

export function UiLanguageBoundary({ language, children }: { language: UiLanguage; children: ReactNode }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const originals = useRef(new WeakMap<Node, string>());
  const originalAttributes = useRef(new WeakMap<Element, Map<string, string>>());

  useEffect(() => {
    document.documentElement.lang = language;
    const root = rootRef.current;
    if (!root) return;
    const apply = (target: Node) => {
      const parent = target.nodeType === Node.TEXT_NODE ? target.parentElement : target instanceof Element ? target : null;
      if (parent?.closest(SKIP_SELECTOR)) return;
      if (target.nodeType === Node.TEXT_NODE) {
        const current = target.textContent ?? '';
        if (!originals.current.has(target)) originals.current.set(target, current);
        target.textContent = translate(originals.current.get(target) ?? current, language);
        return;
      }
      if (!(target instanceof Element)) return;
      const attributes = ['aria-label', 'title', 'placeholder'];
      let saved = originalAttributes.current.get(target);
      if (!saved) { saved = new Map(); originalAttributes.current.set(target, saved); }
      for (const name of attributes) {
        const current = target.getAttribute(name);
        if (current === null) continue;
        if (!saved.has(name)) saved.set(name, current);
        target.setAttribute(name, translate(saved.get(name) ?? current, language));
      }
      for (const child of Array.from(target.childNodes)) apply(child);
    };
    apply(root);
    const observer = new MutationObserver((records) => {
      observer.disconnect();
      for (const record of records) {
        if (record.type === 'characterData') {
          originals.current.set(record.target, record.target.textContent ?? '');
          apply(record.target);
        }
        if (record.type === 'attributes' && record.target instanceof Element && record.attributeName) {
          let saved = originalAttributes.current.get(record.target);
          if (!saved) { saved = new Map(); originalAttributes.current.set(record.target, saved); }
          const current = record.target.getAttribute(record.attributeName);
          if (current !== null) saved.set(record.attributeName, current);
          apply(record.target);
        }
        for (const node of Array.from(record.addedNodes)) apply(node);
      }
      observer.observe(root, { childList: true, characterData: true, attributes: true, attributeFilter: ['aria-label', 'title', 'placeholder'], subtree: true });
    });
    observer.observe(root, { childList: true, characterData: true, attributes: true, attributeFilter: ['aria-label', 'title', 'placeholder'], subtree: true });
    return () => observer.disconnect();
  }, [language]);

  return <div ref={rootRef} className="i18n-root">{children}</div>;
}
