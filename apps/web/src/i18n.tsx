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
  'Medya kadrajı': 'Media framing', 'Medyanın canvas içindeki kadrajı': 'How media is framed inside the canvas',
  'Preview görünümü': 'Preview view', 'Canvas yakınlaştırma': 'Canvas zoom',
  'Akıllı kadraj': 'Smart framing', 'Güvenli alan': 'Safe area', 'Tam ekran': 'Fullscreen', 'Önceki kare': 'Previous frame',
  'Sonraki kare': 'Next frame', 'Başa sar': 'Go to start', 'Oynat': 'Play', 'Duraklat': 'Pause',
  'Klip seç': 'Select a clip', 'Özellikleri düzenlemek için timeline’dan bir klip seç.': 'Select a clip on the timeline to edit its properties.',
  'Özellikleri düzenlemek için timeline\'dan bir klip seç.': 'Select a clip on the timeline to edit its properties.',
  'Yerleşim': 'Layout', 'Ses ve kırpma': 'Audio & trim', 'Hız': 'Speed', 'Görünüm': 'Appearance', 'Yazı stili': 'Text style',
  'Klibi tuval üzerinde taşı, boyutlandır, döndür ve saydamlığını ayarla.': 'Move, resize, rotate and adjust clip opacity on the canvas.',
  'Klibin zaman içinde nasıl hareket edeceğini keyframe noktalarıyla belirle.': 'Use keyframes to define how the clip changes over time.',
  'Transform': 'Transform', 'Saydamlık %': 'Opacity %', 'Yatay çevir': 'Flip horizontal', 'Dikey çevir': 'Flip vertical',
  'Timeline’a sığdır': 'Fit timeline', '↔ Timeline’a sığdır': '↔ Fit timeline', 'Track ekle': 'Add track', 'Seçim': 'Select', 'Marker ekle': 'Add marker',
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
  'Seçimi kaldır': 'Clear selection', 'Metin klibi': 'Text clip', 'Görsel klibi': 'Image clip',
  'Video klibi': 'Video clip', 'Altyazı klibi': 'Caption clip', 'Animasyon keyframe\'leri': 'Animation keyframes',
  '· Kullanılmadı': '· Unused', 'PROJE': 'PROJECT',
  '9:16 · Dikey': '9:16 · Portrait', '1:1 · Kare': '1:1 · Square', '3:2 · Klasik': '3:2 · Classic',
  '21:9 · Sinematik': '21:9 · Cinematic', 'YouTube / yatay': 'YouTube / landscape',
  'Instagram gönderi': 'Instagram post', 'Fotoğraf / klasik': 'Photo / classic',
  'Geri yükleme noktaları': 'Restore points', 'Son kayıtların güvenli kopyaları': 'Safe copies of recent saves',
  'Henüz yedek oluşturulmadı. Proje kaydedildikçe burada görünür.': 'No backup has been created yet. It will appear as the project is saved.',
  'Renk, atmosfer ve dokuya göre seç': 'Choose by color, atmosphere and texture',
  'Düz': 'Solid', 'Yumuşak': 'Soft', 'Doku': 'Texture', 'Medya panelinden hızlı vurgu ekle': 'Add a quick accent from the media panel',
 'Stok medya': 'Stock media', 'Stok medyayı ekle': 'Add stock media',
  'Süre:': 'Duration:', 'Süre': 'Duration',
 'Beyaz yüzey stok medyayı ekle': 'Add White surface stock media',
  'Siyah yüzey stok medyayı ekle': 'Add Black surface stock media',
  'Adaçayı stok medyayı ekle': 'Add Sage stock media',
  'Gün batımı stok medyayı ekle': 'Add Sunset stock media',
  'Kâğıt stok medyayı ekle': 'Add Paper stock media',
  'Neon ızgara stok medyayı ekle': 'Add Neon grid stock media',
  'Basit vurguları ve metin şekillerini hızlıca timeline’a ekle.': 'Quickly add simple accents and text shapes to the timeline.',
  'Hazır arka planları ve yüzeyleri seç, tek tıkla boş bir alana ekle.': 'Choose ready-made backgrounds and surfaces, then add one to an empty area.',
  'Beyaz yüzey': 'White surface', 'Siyah yüzey': 'Black surface', 'Adaçayı': 'Sage', 'Gün batımı': 'Sunset',
  'Kâğıt': 'Paper', 'Neon ızgara': 'Neon grid', 'Temiz ve aydınlık': 'Clean and bright',
  'Sade ve sinematik': 'Simple and cinematic', 'Yumuşak yeşil': 'Soft green', 'Sıcak renkler': 'Warm colors',
  'Nötr doku': 'Neutral texture', 'Teknolojik vurgu': 'Tech accent',
  'Daire': 'Circle', 'Yıldız': 'Star', 'Ok': 'Arrow', 'Kalp': 'Heart', 'Onay': 'Check',
  'Vurgu şekli': 'Accent shape', 'Parlak vurgu': 'Bright accent', 'Yön göstergesi': 'Direction indicator',
  'Temiz başlık': 'Clean title', 'Editoryal': 'Editorial', 'Sosyal kanca': 'Social hook', 'Alt bilgi': 'Lower third',
  'Okunaklı altyazı': 'Readable caption', 'Altyazı kutusu': 'Caption box', 'Alıntı': 'Quote',
  'Bilgi kartı': 'Info card', 'Konturlu': 'Outlined', 'Yumuşak not': 'Soft note',
  'Başlık': 'Title', 'Sosyal': 'Social', 'Kart': 'Card', 'Vurgu': 'Accent',
  'Video açılışları için net': 'Clear for video openings', 'Zarif ve okunaklı serif': 'Elegant, readable serif',
  'Kısa, güçlü, yüksek kontrast': 'Short, strong, high contrast', 'İsim ve konum bilgisi': 'Name and location information',
  'Uzun konuşmalar için rahat': 'Comfortable for long conversations', 'Kontrastı yüksek kutulu stil': 'High-contrast boxed style',
  'Duygusal ve sakin görünüm': 'Emotional and calm look', 'İpuçları ve açıklamalar': 'Tips and explanations',
  'Görüntü üstünde güçlü vurgu': 'Strong accent over footage', 'Minimal ve sıcak': 'Minimal and warm',
  'Yeni başlık': 'New title', 'Bir hikâye başlıyor': 'A story begins', 'Bunu mutlaka gör!': 'You have to see this!',
  'Hakan · CutLoc': 'Hakan · CutLoc', 'Buraya altyazı yazın.': 'Write a caption here.',
  'Net ve erişilebilir metin': 'Clear and accessible text', 'Bir anı yakala.': 'Capture a moment.',
  'İpucu · Zaman çizelgesini deneyin': 'Tip · Try the timeline', 'Öne çıkar': 'Make it stand out', 'Küçük bir not': 'A small note',
  'Inspector’ı kullan': 'Use the Inspector', 'Inspector araçları': 'Inspector tools',
  'Bir klibi timeline’da seçin; Inspector değerleri ve geçişler sağ panelde açılır.': 'Select a clip on the timeline; its Inspector values and transitions open in the right panel.',
 'Klip seçin, değerleri artı/eksi adımlarıyla değiştirin.': 'Select a clip and adjust values with the plus/minus controls.',
  'Görselin renk, ton ve filtre değerlerini düzenle.': 'Adjust the image color, tone and filter values.',
  'Metni, yazı tipini ve okunabilirlik ayarlarını düzenle.': 'Adjust the text, font and readability settings.',
  'Ses seviyesini, kaynak süresini ve yumuşak giriş/çıkışı düzenle.': 'Adjust volume, source duration and soft fade in/out.',
 'Renk ve efekt': 'Color & effects', 'Parlaklık %': 'Brightness %', 'Kontrast %': 'Contrast %', 'Doygunluk %': 'Saturation %',
  'Metin kütüphanesi': 'Text library', 'Bir stil seç, sonra Inspector\'dan içeriği değiştir.': 'Choose a style, then edit the content in the Inspector.',
  'Bir stil seç, sonra Inspector’dan içeriği değiştir.': 'Choose a style, then edit the content in the Inspector.',
  'Temiz metin, güçlü hiyerarşi': 'Clean text, strong hierarchy',
  'Başlık, altyazı ve bilgi kartlarını önizleyerek ekle.': 'Preview and add titles, captions and info cards.',
  'Metin stili ara': 'Search text styles', 'Stil veya metin ara…': 'Search styles or text…',
  'Karta tıkla → add to timeline → sağdaki Inspector’da metni ve animasyonu düzenle.': 'Click a card → add to timeline → edit the text and animation in the Inspector on the right.',
  "Karta tıkla → add to timeline → sağdaki Inspector'da metni ve animasyonu düzenle.": 'Click a card → add to timeline → edit the text and animation in the Inspector on the right.',
  'Karta tıkla → timeline’a ekle → sağdaki Inspector’da metni ve animasyonu düzenle.': 'Click a card → add to timeline → edit the text and animation in the Inspector on the right.',
  'Altyazı merkezi': 'Caption center', 'SRT/VTT içe aktarın veya seçili klibe altyazı ekleyin.': 'Import SRT/VTT or add captions to the selected clip.',
  'SRT / VTT içe aktar': 'Import SRT / VTT', 'Zaman kodları otomatik korunur': 'Timecodes are preserved automatically',
  'Otomatik altyazı': 'Automatic captions', 'Yerel ve onaylı ses analizi': 'Local, approved audio analysis',
  'SRT dışa aktar': 'Export SRT', 'Timeline altyazılarını indir': 'Download timeline captions',
  'Yardım merkezi': 'Help center', 'Kurgu akışını hızlandıran kısa yollar ve temel ipuçları.': 'Shortcuts and essential tips to speed up editing.',
  'İleri al': 'Redo', 'Seçili klibi böl': 'Split selected clip',
  'Export öncesi timeline’da en az bir medya veya metin klibi olduğundan emin olun.': 'Make sure the timeline contains at least one media or text clip before exporting.',
 'Proje araçları': 'Project tools', 'Canvas arka planı': 'Canvas background',
  'Canvas, arka plan ve genel çalışma tercihleri.': 'Canvas, background and general workspace preferences.',
 'Boş alanların ve export zeminlerinin rengi': 'Color of empty areas and export backgrounds', 'Şeffaf': 'Transparent',
  '⌁ Timeline rehberi': '⌁ Timeline guide', '⚙ Çalışma alanı ayarları': '⚙ Workspace settings',
 'Timeline rehberi': 'Timeline guide', 'Çalışma alanı ayarları': 'Workspace settings',
 'Bulanıklık': 'Blur', 'Sıcaklık %': 'Temperature %', 'Ton (Hue)': 'Hue', 'Vinyet %': 'Vignette %',
  'Maske ve geçiş': 'Mask & transitions', 'Maske şekli': 'Mask shape', 'Dikdörtgen': 'Rectangle', 'Elips': 'Ellipse',
  'Genişlik': 'Width', 'Yükseklik': 'Height', 'Giriş geçişi': 'In transition', 'Çıkış geçişi': 'Out transition',
 'Giriş sn': 'In sec', 'Çıkış sn': 'Out sec', 'Klip hızı': 'Clip speed', 'Görüntü': 'Image',
  'Sığdır': 'Fit', 'Doldur': 'Fill', 'Uzat': 'Stretch',
 'Hız eğrisi': 'Speed curve', 'Sabit hız': 'Constant speed', 'Yumuşak hız rampası': 'Soft speed ramp',
  'Önizlemede klibe tıklayıp sürükleyin. Sağ alt tutamacı kullanarak yeniden boyutlandırabilirsiniz.': 'Click and drag the clip in the preview. Use the lower-right handle to resize it.',
  'Playhead\'i taşıyıp bir özellik düğmesine basarak animasyon noktası ekleyin. Easing düğmeleri aşağıdaki grafikten değişir.': 'Move the playhead and press a property button to add an animation point. Change easing with the buttons below the graph.',
  '↔ Yatay çevir': '↔ Flip horizontal', '↕ Dikey çevir': '↕ Flip vertical', '◇ Ekle': '◇ Add',
  'Ses seviyesini normalize et': 'Normalize audio level', 'Sessize al': 'Mute', 'Sesi aç': 'Unmute',
  'Kaynak başlangıcı': 'Source start', 'Kaynak süresi': 'Source duration', 'Metin stili': 'Text style',
  'Altyazı stili': 'Caption style', 'Yazı tipi': 'Font', 'Harf aralığı': 'Letter spacing', 'Satır yüksekliği': 'Line height',
  'İç boşluk': 'Padding', 'Ağırlık': 'Weight', 'Yazı ağırlığı': 'Font weight', 'Altı çizili': 'Underline',
  'Gölge': 'Shadow', 'Hizalama': 'Alignment', 'Sol': 'Left', 'Orta': 'Center', 'Sağ': 'Right',
  'Arka plan': 'Background', 'Boyut': 'Size',
 'Snap ve marker': 'Snap and marker', 'Timeline çubuğundaki ⌁ düğmesiyle yakalamayı açıp kapatın.': 'Toggle snapping with the ⌁ button in the timeline bar.',
  'Snap açıkken playhead marker ve klip kenarlarına otomatik yaklaşır.': 'When snap is on, the playhead automatically snaps to markers and clip edges.',
  'Otomatik altyazı için yerel Whisper bağlantısı bir sonraki render motoru paketinde etkinleştirilecek.': 'The local Whisper connection for automatic captions will be enabled in the next render engine package.',
 'Marker adını değiştir': 'Rename marker', 'Marker adı': 'Marker name', 'Marker’ı sil': 'Delete marker',
  'Yeni genel layer': 'New general layer', 'Buraya yeni layer ekle': 'Add a new layer here', 'Üstüne layer ekle': 'Add a layer above',
  'Altına layer ekle': 'Add a layer below', 'Track seçenekleri': 'Track options', 'Playhead’i buraya taşı': 'Move the playhead here',
  'Playhead’de böl': 'Split at playhead', 'Başlangıcı playhead’e kırp': 'Trim start to playhead',
  'Sonu playhead’e kırp': 'Trim end to playhead', 'Transformu sıfırla': 'Reset transform',
  'Efektleri sıfırla': 'Reset effects', 'Medya panelinde göster': 'Show in media panel', 'Ripple delete': 'Ripple delete',
  'Kaydetme hatası': 'Save error', 'Medya import edilemedi': 'Media import failed', 'Export başlatılamadı': 'Export could not start',
  'Önce medya içe aktarın, ardından timeline üzerinde bir klip oluşturun.': 'Import media first, then create a clip on the timeline.',
  'Kütüphanedeki medyayı timeline’a ekle': 'Add library media to the timeline', 'süre yok': 'no duration', 'bayt': 'bytes',
  'İstek başarısız': 'Request failed', 'Geçersiz proje kimliği': 'Invalid project id', 'İşlem iptal edildi': 'Operation cancelled',
  'Geçersiz dosya yolu': 'Invalid file path', 'Export için timeline üzerinde medya veya metin klibi gerekli': 'The timeline needs media or a text clip to export.',
  'Dışa aktarma için yeterli disk alanı yok.': 'There is not enough disk space to export.',
  'Dışa aktarma disk alanının büyük bölümünü kullanabilir.': 'The export may use most of the available disk space.',
  'Disk alanı doğrulanamadı.': 'Disk space could not be verified.', 'Export ayarları geçersiz': 'Export settings are invalid',
  'Export hazırlanamadı': 'Export could not be prepared', 'Export tamamlandı': 'Export complete', 'Medya hazırlanıyor': 'Preparing media',
  'Medya hazır': 'Media ready', 'Video dışa aktarılıyor': 'Exporting video', 'Ses dışa aktarılıyor': 'Exporting audio',
  'İptal edildi': 'Cancelled', 'İş bulunamadı': 'Job not found', 'Çok fazla ilerleme bağlantısı açık': 'Too many progress connections are open',
  'Dosya içe aktar': 'Import file', 'Kütüphaneyi yenile': 'Refresh library', 'Panel ayarları': 'Panel settings',
  'Timeline’a ekle': 'Add to timeline', 'Adı kopyala': 'Copy name', 'Medya bilgisi': 'Media info',
 'Kullanımları göster': 'Show uses', 'Projeden kaldır': 'Remove from project',
  'Sesi kapat': 'Mute', 'Kilidi aç': 'Unlock', 'Kilitle': 'Lock', 'Sustur': 'Mute', 'Göster': 'Show', 'Gizle': 'Hide',
  'Gizle/göster': 'Show/hide', 'Track adı': 'Track name',
  'Böl (klip seçip playhead\'i klibin içine taşıyın)': 'Split (select a clip and move the playhead inside it)',
 'Özellikleri aç': 'Open properties', 'Çoğalt': 'Duplicate', 'Klip verisini kopyala': 'Copy clip data',
  'Yukarı taşı': 'Move up', 'Aşağı taşı': 'Move down', 'Yeniden adlandır': 'Rename',
  'Scale azalt': 'Decrease scale', 'Scale artır': 'Increase scale', 'Rotate azalt': 'Decrease rotation', 'Rotate artır': 'Increase rotation',
 'Opacity % azalt': 'Decrease opacity', 'Opacity % artır': 'Increase opacity',
  'Onay işlemi': 'Confirmation', 'Sunucuya bağlanılamadı': 'Could not connect to the server', 'Proje açılamadı': 'Could not open the project',
  'Proje oluşturulamadı': 'Could not create the project', 'Proje çöp kutusundan geri yüklendi.': 'Project restored from trash.',
  'Proje geri yüklenemedi': 'Could not restore the project', 'Çöp kutusu kaydı kalıcı olarak silindi.': 'Trash entry permanently deleted.',
  'Çöp kutusu kaydı silinemedi': 'Could not delete the trash entry', 'Editör hazırlanıyor': 'Preparing editor',
  'Çalışma alanına dönülüyor': 'Returning to workspace', 'Çöp kutusuna taşı': 'Move to trash',
  'Çalışma alanı düzeni kaydedilemedi.': 'Could not save the workspace layout.',
  'Timeline\'a eklemek için karttaki Ekle düğmesini kullanın.': 'Use the Add button on the card to place it on the timeline.',
  'Timeline’a eklemek için karttaki Ekle düğmesini kullanın.': 'Use the Add button on the card to place it on the timeline.',
  'Şimdi export başlatabilirsiniz.': 'You can start the export now.', 'Önce bekleyen proje kaydını düzeltin.': 'Fix the pending project save first.',
  'Export ön kontrolü yapılıyor': 'Running export preflight', 'Export kuyruğa alındı': 'Export queued', 'Export başarısız': 'Export failed',
  'Özel': 'Custom', 'SRT/VTT içinde geçerli altyazı bulunamadı.': 'No valid captions found in the SRT/VTT file.',
  'Bu yedekten dönmek mevcut proje durumunu değiştirecek. Devam edilsin mi?': 'Restoring this backup will change the current project state. Continue?',
 'Yedek geri yüklendi.': 'Backup restored.', 'Yedek geri yüklenemedi.': 'Could not restore the backup.',
  'Bu medya ve timeline kullanımları projeden kaldırılacak. Devam edilsin mi?': 'This media and its timeline uses will be removed from the project. Continue?',
  'Önce timeline üzerinde bir klip seçin.': 'Select a clip on the timeline first.',
 'Timeline’da seçili klibin giriş ve çıkış davranışını değiştirin.': 'Change the selected clip’s intro and outro behavior on the timeline.',
  'Timeline klipleri artık medya importundan bağımsız korunuyor. Snap ve marker araçlarını alttaki timeline çubuğundan kullanabilirsiniz.': 'Timeline clips are now preserved independently of media imports. You can use the snap and marker tools in the timeline bar below.',
 'Geçişler seçili klibe çıkış geçişi olarak uygulanır; komşu klip doğrulaması render parity aşamasında genişletilecek.': 'Transitions are applied as an outro to the selected clip; neighboring clip validation will be expanded during render parity.',
  'Renk ve filtre': 'Color & filters', 'Hazır görünümlerle başlayın, Inspector’da ince ayar yapın.': 'Start with ready-made looks, then fine-tune them in the Inspector.',
  'Yumuşat': 'Soften', 'Seçili klip yoksa önce timeline’dan bir klip seçin.': 'Select a clip on the timeline first.',
  'Şekiller ve çıkartmalar': 'Shapes & stickers', 'Canvas’a hızlı vurgu öğeleri ekleyin.': 'Add quick accent elements to the canvas.',
  'Playhead’i taşıyıp seçili özellik için keyframe ekleyin.': 'Move the playhead and add a keyframe for the selected property.',
  'Konum, ölçek, dönüş ve opaklık': 'Position, scale, rotation and opacity', 'Keyframe eklemek için Inspector’daki Animasyon keyframe’leri bölümünü kullanın.': 'Use the Animation keyframes section in the Inspector to add a keyframe.',
  'Speed curve düzenleyicisi Inspector’a ekleniyor.': 'The speed curve editor is being added to the Inspector.',
  'Kurgu yardımcısı ayarlardan açılır': 'The editing assistant can be enabled in Settings.', 'Bir klip seçip preset’e tıkla.': 'Select a clip and click a preset.',
  'Video, ses veya görsel dosyası bırakın.': 'Drop a video, audio or image file.', 'Medya içe aktar': 'Import media',
  'Video, ses veya görsel seç': 'Choose a video, audio or image', 'Proje medyası': 'Project media',
  'Sürükle, çift tıkla veya karttaki Ekle düğmesine bas.': 'Drag, double-click or press the Add button on a card.',
  'Dosyaları buraya bırak': 'Drop files here', 'Video, ses veya görsel': 'Video, audio or image',
  'Karta tıkla': 'Click a card',
  'Medya panelinde hızlı vurgu ekle': 'Add a quick accent from the media panel',
  'Yakınlaştırma': 'Zoom', 'Yakınlaştırmayı azalt': 'Zoom out', 'Yakınlaştırmayı artır': 'Zoom in', 'Preview sığdır': 'Fit preview',
  'Hareket stüdyosu': 'Motion studio', 'Giriş ve çıkışı birlikte tasarla': 'Design the intro and outro together', 'Bir kart seç; sonra süre, yön ve yumuşatmayı ince ayarla.': 'Choose a card, then fine-tune duration, direction and easing.',
  'Uygulama alanı': 'Apply to', 'Hangi bölüme yazacağını seç': 'Choose which part to edit', 'Giriş + çıkış': 'In + out', 'Yalnız giriş': 'In only', 'Yalnız çıkış': 'Out only',
  'Giriş süresi': 'In duration', 'Çıkış süresi': 'Out duration', 'Giriş animasyonu süresi': 'In animation duration', 'Çıkış animasyonu süresi': 'Out animation duration',
  'Hareket seç': 'Choose motion', 'hazır davranış': 'ready behaviors', 'Kesme': 'Cut', 'Hareket': 'Motion', 'Odak': 'Focus',
  'Anında görünür': 'Appears instantly', 'Yumuşakça görünür': 'Appears softly', 'Sakin ve organik': 'Calm and organic', 'Soldan kaydır': 'Slide from left', 'Sağdan kaydır': 'Slide from right',
  'Aşağıdan yükselt': 'Rise from below', 'Yukarıdan indir': 'Drop from above', 'Sürme': 'Wipe', 'Yakınlaş': 'Zoom in', 'Kes': 'Cut',
  'Sol → merkez': 'Left → center', 'Sağ → merkez': 'Right → center', 'Alt → merkez': 'Bottom → center', 'Üst → merkez': 'Top → center', 'Perde → açık': 'Wipe → open', 'Şeffaf → net': 'Transparent → clear', 'Yumuşak doku': 'Soft texture', 'Küçük → büyük': 'Small → large',
  'Klip seçilmedi': 'No clip selected', 'Önce timeline’dan bir klip seç': 'Select a clip on the timeline first', 'Seçili klip': 'Selected clip', 'klip seçili': 'clips selected',
  'Gelişmiş hareket': 'Advanced motion', 'Yön, yumuşatma, yoğunluk ve süre bağlantısı': 'Direction, easing, intensity and linked durations', 'Yön': 'Direction', 'Soldan': 'From left', 'Sağdan': 'From right', 'Yukarıdan': 'From top', 'Aşağıdan': 'From bottom', 'Merkezden': 'From center',
  'Doğrusal': 'Linear', 'Yavaş başla': 'Ease in', 'Yavaş bitir': 'Ease out', 'Yumuşak giriş/çıkış': 'Ease in/out', 'Yoğunluk': 'Intensity', 'Giriş ve çıkış süresini birlikte ayarla': 'Link in and out durations', 'Gelişmiş ayarları uygula': 'Apply advanced settings',
  '◇ Keyframe': '◇ Keyframe', 'Animasyon seçmek klibin giriş/çıkış davranışını günceller; dışa aktarmada gelişmiş geçişler fade yaklaşımıyla işlenebilir.': 'Choosing an animation updates the clip intro/outro; advanced transitions may be rendered as a fade during export.',
  'İlk adım': 'First steps', 'İlk videonu üç hamlede hazırla': 'Prepare your first video in three moves', 'Dosyanı içe aktar, timeline’a yerleştir ve önizlemede sonucu kontrol et.': 'Import your file, place it on the timeline and check the result in the preview.',
  'Medya panelinden video, ses veya görsel ekle.': 'Add a video, audio file or image from the Media panel.', 'Karttaki Ekle düğmesiyle klibi timeline’a yerleştir.': 'Place the clip on the timeline with the Add button on its card.', 'Oynat düğmesine basıp playhead’i kontrol et.': 'Press Play and check the playhead.', 'Medya panelini aç': 'Open Media panel',
  'Kütüphaneyi düzenli tut': 'Keep the library tidy', 'Proje medyası, stok içerik ve şekiller aynı Media alanında; aradığını tek yerde bul.': 'Project media, stock content and shapes live in one Media area; find what you need in one place.', 'Medya sekmesinde arama ve filtreyi kullan.': 'Use search and filters in the Media tab.', 'Şekiller için Media içindeki Şekiller sekmesine geç.': 'Open the Shapes tab inside Media.', 'Bir kartı çift tıklayarak ya da Ekle düğmesiyle timeline’a gönder.': 'Double-click a card or use its Add button to send it to the timeline.', 'Media alanını aç': 'Open Media area',
  'Canvas’ta doğrudan seç ve taşı': 'Select and move directly on the canvas', 'Metne veya görsele tıklayınca nesne seçilir; aynı klip timeline ve Inspector’da da açılır.': 'Clicking text or an image selects the object; the same clip opens in the timeline and Inspector.', 'Canvas üzerindeki metin ya da medya alanına tıkla.': 'Click the text or media area on the canvas.', 'Seçim çerçevesinden nesneyi sürükle veya köşe tutamacıyla ölçekle.': 'Drag the object from its selection box or scale it with the corner handle.', 'Yakınlaştırmayı kullanırken kaydırma alanında canvas’ın istediğin bölgesine ilerle.': 'When zoomed in, scroll to the area of the canvas you need.', 'Metin alanını aç': 'Open Text area',
  'Girişi ve çıkışı ayrı ayrı tasarla': 'Design the intro and outro separately', 'Hazır hareket kartını seç, sonra yön, yumuşatma, yoğunluk ve süreyi birlikte ayarla.': 'Choose a motion card, then tune direction, easing, intensity and duration.', 'Timeline’da bir klip seçip Animasyon panelini aç.': 'Select a clip on the timeline and open Animation.', 'Giriş + çıkış, yalnız giriş veya yalnız çıkış kapsamını seç.': 'Choose in + out, in only or out only.', 'Gelişmiş hareket bölümünde yönü ve easing’i düzenle.': 'Adjust direction and easing in Advanced motion.', 'Hareket stüdyosunu aç': 'Open Motion studio',
  'Kes, böl, hizala': 'Cut, split and align', 'Playhead’i taşı, klibi böl ve snap ile kenarlara temizce hizala.': 'Move the playhead, split the clip and align cleanly with snap.', 'Klibi seçip playhead’i kesmek istediğin noktaya taşı.': 'Select the clip and move the playhead to the cut point.', 'B kısayoluyla klibi böl veya timeline menüsünü aç.': 'Split with B or open the timeline menu.', 'Snap’i açarak playhead ve klip kenarlarını birbirine yaklaştır.': 'Turn on Snap to bring the playhead and clip edges together.', 'Timeline araçlarını gör': 'View timeline tools',
  'Export öncesi son kontrol': 'Final export check', 'Canvas oranını, aralığı ve kaliteyi kontrol et; sonra videonu dışa aktar.': 'Check the canvas aspect, range and quality, then export your video.', 'Canvas oranını hedef platforma göre seç.': 'Choose the canvas aspect for your target platform.', 'In/Out aralığını gerekiyorsa I ve O ile belirle.': 'Set the In/Out range with I and O if needed.', 'Export penceresinde kaliteyi seçip ön kontrolü çalıştır.': 'Choose quality in the Export window and run preflight.', 'Proje araçlarını aç': 'Open Project tools',
  'Yardımda ara…': 'Search help…', 'Yardım konuları': 'Help topics', 'Kurgu akışını klavyeden hızlandır.': 'Speed up editing from the keyboard.', 'Ayarları aç': 'Open settings', 'Hızlı ipuçları': 'Quick tips', 'Bir sonraki hamleni seç.': 'Choose your next move.', 'Canvas’tan seç': 'Select from canvas', 'Metne tıklayınca doğru klip açılır.': 'Click text to open the right clip.', 'Hareket ekle': 'Add motion', 'Giriş, çıkış ve easing’i birlikte ayarla.': 'Tune in, out and easing together.', 'Şekil ekle': 'Add a shape', 'Media içindeki Şekiller sekmesini kullan.': 'Use the Shapes tab inside Media.', 'Kurguya yardım eden küçük rehber': 'A small guide for editing', 'İhtiyacın olan aracı bul, ne işe yaradığını gör ve doğrudan ilgili panele geç.': 'Find the tool you need, see what it does and jump straight to its panel.', 'Aramana uygun konu yok': 'No matching topic', 'Başka bir kelime dene veya tüm konuları görmek için aramayı temizle.': 'Try another word or clear the search to see every topic.',
};

// The current UI is mostly written with Turkish source text, but a few older
// controls were authored in English. Keep those controls in the same
// dictionary-based system until the app moves to component-level locale keys.
const TURKISH: Record<string, string> = {
  'Workspace': 'Çalışma alanı', 'Render studio': 'Dışa aktarma stüdyosu', 'Frame rate': 'Kare hızı',
  'Video export': 'Video dışa aktarma', 'Audio export': 'Ses dışa aktarma', 'Ses export': 'Ses dışa aktarma',
  'Codec': 'Kodlayıcı', 'Video encoder': 'Video kodlayıcı', 'Canvas': 'Tuval', 'Preview': 'Önizleme', 'Zoom': 'Yakınlaştırma',
  'Canvas yakınlaştırma': 'Tuval yakınlaştırma', 'Medyanın canvas içindeki kadrajı': 'Medyanın tuval içindeki kadrajı',
  'Ses bitrate': 'Ses bit hızı', 'Bitrate': 'Bit hızı', 'effects': 'efektler', 'export': 'dışa aktarma',
  'Balanced': 'Dengeli', 'Draft': 'Taslak', 'High': 'Yüksek', 'Experimental AI': 'Deneysel yapay zekâ',
  '＋ Track': '＋ Katman', 'Track': 'Katman', 'Layer': 'Katman', 'Overlay': 'Kaplama', 'Audio': 'Ses',
  'Text': 'Metin', 'Subtitle': 'Altyazı', 'Timeline zoom': 'Timeline yakınlaştırma', 'Transform': 'Dönüşüm',
  'Scale': 'Ölçek', 'Rotate': 'Döndürme', 'Opacity': 'Opaklık', 'Opacity %': 'Opaklık %',
  'Fit mode': 'Sığdırma modu', 'Brightness': 'Parlaklık', 'Contrast': 'Kontrast', 'Saturation': 'Doygunluk',
  'Opacity keyframe': 'Opaklık keyframe', 'Opacity graph': 'Opaklık grafiği', 'Easing': 'Yumuşatma',
  'Italic': 'İtalik', 'Stroke': 'Kontur', 'Stroke px': 'Kontur px', 'Light': 'İnce', 'Regular': 'Normal',
  'Medium': 'Orta', 'Semibold': 'Yarı kalın', 'Bold': 'Kalın', 'Extra bold': 'Ekstra kalın', 'Black': 'Siyah',
  'Mask X': 'Maske X', 'Mask Y': 'Maske Y', 'Feather %': 'Yumuşatma %', 'Speed curve': 'Hız eğrisi',
  'Rate mode': 'Hız modu', 'Video bitrate (kbps)': 'Video bit hızı (kbps)', 'Opacity easing graph': 'Opaklık yumuşatma grafiği',
  'Contain': 'Sığdır', 'Cover': 'Doldur', 'Stretch': 'Uzat', 'In': 'Başlangıç', 'Out': 'Bitiş',
 'Ripple delete': 'Ripple silme', 'Selected range does not contain media or text': 'Seçilen aralıkta medya veya metin yok',
  'Canvas oranı korunarak gerçek video boyutu belirlenir': 'Tuval oranı korunarak gerçek video boyutu belirlenir',
  'Canvas, arka plan ve genel çalışma tercihleri.': 'Tuval, arka plan ve genel çalışma tercihleri.', 'Canvas arka planı': 'Tuval arka planı',
  'Canvas’a hızlı vurgu öğeleri ekleyin.': 'Tuval’e hızlı vurgu öğeleri ekleyin.',
  'Bu sürümde doğrulanmış yerel encoder': 'Bu sürümde doğrulanmış yerel kodlayıcı',
  'Export': 'Dışa aktarma', 'Export başlangıcını belirler': 'Dışa aktarma başlangıcını belirler',
  'Export bitişini belirler': 'Dışa aktarma bitişini belirler',
  'Seçili export aralığını kaldırır': 'Seçili dışa aktarma aralığını kaldırır',
  'Yeniden export': 'Dışa aktarmayı yeniden başlat', 'Export ediliyor…': 'Dışa aktarılıyor…',
  'Export başlatılamadı': 'Dışa aktarma başlatılamadı',
  'Export için timeline üzerinde medya veya metin klibi gerekli': 'Dışa aktarma için timeline üzerinde medya veya metin klibi gerekli',
  'Export ayarları geçersiz': 'Dışa aktarma ayarları geçersiz', 'Export hazırlanamadı': 'Dışa aktarma hazırlanamadı',
  'Export tamamlandı': 'Dışa aktarma tamamlandı', 'Export ön kontrolü yapılıyor': 'Dışa aktarma ön kontrolü yapılıyor',
  'Export kuyruğa alındı': 'Dışa aktarma kuyruğa alındı', 'Export başarısız': 'Dışa aktarma başarısız',
  'Export öncesi timeline’da en az bir medya veya metin klibi olduğundan emin olun.': 'Dışa aktarma öncesi timeline’da en az bir medya veya metin klibi olduğundan emin olun.',
  "Export öncesi timeline'da en az bir medya veya metin klibi olduğundan emin olun.": "Dışa aktarma öncesi timeline'da en az bir medya veya metin klibi olduğundan emin olun.",
  'Scale azalt': 'Ölçek azalt', 'Scale artır': 'Ölçek artır', 'Rotate azalt': 'Döndürme azalt', 'Rotate artır': 'Döndürme artır',
  'Opacity % azalt': 'Opaklığı azalt', 'Opacity % artır': 'Opaklığı artır',
};

const SKIP_SELECTOR = [
  '.project-name-input', '.project-card-title h3', '.preview-text', '.timeline-clip strong', '.asset-info strong',
  '.selected-file strong', '.export-complete code', 'textarea', '[data-i18n-skip]',
].join(',');

function translate(value: string, language: UiLanguage): string {
  const leading = value.match(/^\s*/)?.[0] ?? '';
  const trailing = value.match(/\s*$/)?.[0] ?? '';
  const core = value.trim();
  if (!core) return value;
  const exact = language === 'en' ? ENGLISH[core] : TURKISH[core];
  if (exact) return `${leading}${exact}${trailing}`;
  if (language === 'tr') {
    return value
      .replace(/(\d+)\s+media assets?/gi, '$1 medya varlığı')
      .replace(/(\d+)\s+active timelines?/gi, '$1 aktif timeline')
      .replace(/(\d+)\s+projects?/gi, '$1 proje')
      .replace(/(\d+)\s+files?/gi, '$1 dosya')
      .replace(/(\d+)\s+results?/gi, '$1 sonuç')
      .replace(/(\d+)\s+items?/gi, '$1 kayıt')
      .replace(/(\d+)\s+media/gi, '$1 medya')
      .replace(/ · (\d+) uses?/gi, ' · $1 kullanım')
      .replace(/ · Unused/gi, ' · Kullanılmadı')
      .replace(/add to timeline/gi, "timeline'a ekle")
      .replace(/ menu\b/gi, ' menüsü')
      .replace(/ shortcut\b/gi, ' kısayolu')
      .replace(/(\d+) clips selected/gi, '$1 klip seçili')
      .replace(/Estimated size:/gi, 'Tahmini boyut:')
      .replace(/Output:/gi, 'Çıktı:')
      .replace(/ · uses/gi, ' · kullanımlar')
      .replace(/Used in (\d+) timeline clips?/gi, '$1 timeline klibinde kullanılıyor')
      .replace(/\bLayer (\d+)\b/gi, 'Katman $1')
      .replace(/\bLight (\d+)\b/gi, 'İnce $1')
      .replace(/\bRegular (\d+)\b/gi, 'Normal $1')
      .replace(/\bMedium (\d+)\b/gi, 'Orta $1')
      .replace(/\bSemibold (\d+)\b/gi, 'Yarı kalın $1')
      .replace(/\bBold (\d+)\b/gi, 'Kalın $1')
      .replace(/\bExtra bold (\d+)\b/gi, 'Ekstra kalın $1')
      .replace(/\bBlack (\d+)\b/gi, 'Siyah $1')
     .replace(/^Export…$/gi, 'Dışa aktarılıyor…')
     .replace(/\bCanvas\b/g, 'Tuval')
      .replace(/\bcanvas\b/g, 'tuval')
      .replace(/\bexport\b/gi, 'dışa aktarma')
      .replace(/\beffects\b/gi, 'efektler')
     .replace(/\bPreview\b/gi, 'Önizleme');
  }
  return value
    .replace(/(\d+) medya varlığı/gi, '$1 media assets')
    .replace(/(\d+) hazır davranış/gi, '$1 ready behaviors')
    .replace(/(\d+) medya\b/gi, '$1 media')
    .replace(/(\d+) proje\b/gi, '$1 projects')
    .replace(/(\d+) dosya\b/gi, '$1 files')
    .replace(/(\d+) sonuç/gi, '$1 results')
    .replace(/(\d+) kayıt/gi, '$1 items')
    .replace(/(\d+) aktif timeline\b/gi, '$1 active timelines')
    .replace(/ · (\d+) kullanım/gi, ' · $1 use')
    .replace(/ · Kullanılmadı/gi, ' · Unused')
    .replace(/süre yok/gi, 'no duration')
    .replace(/bayt/gi, 'bytes')
   .replace(/(\d+) timeline klibinde kullanılıyor/gi, 'Used in $1 timeline clips')
    .replace(/“(.+?)” kütüphaneye eklendi\. Timeline['’]a eklemek için karttaki Ekle düğmesini kullanın\./gi, '“$1” was added to the library. Use the Add button on the card to place it on the timeline.')
    .replace(/“(.+?)” kütüphaneye eklendi ve timeline['’]a yerleştirildi\./gi, '“$1” was added to the library and placed on the timeline.')
    .replace(/“(.+?)” timeline['’]a eklendi\. Şimdi export başlatabilirsiniz\./gi, '“$1” was added to the timeline. You can start the export now.')
   .replace(/(\d+) altyazı segmenti içe aktarıldı\./gi, '$1 caption segments imported.')
    .replace(/“(.+?)” projesi geri yüklensin mi\?/gi, 'Restore the project “$1”?')
    .replace(/“(.+?)” projesi kalıcı olarak silinsin mi\? Bu işlem geri alınamaz\./gi, 'Permanently delete the project “$1”? This cannot be undone.')
    .replace(/“(.+?)” projesi geri dönüşümlü olarak silinecek\./gi, 'The project “$1” will be moved to trash.')
    .replace(/^Kaydetme hatası:\s*/gi, 'Save error: ')
   .replace(/^(.*?)\s+azalt$/gi, (_, label: string) => `Decrease ${translate(label, 'en')}`)
    .replace(/^(.*?)\s+artır$/gi, (_, label: string) => `Increase ${translate(label, 'en')}`)
    .replace(/(\d+) klip seçili · ortak ayarlar birlikte uygulanır\./gi, '$1 clips selected · shared settings apply together.')
   .replace(/timeline['’]a ekle/gi, 'add to timeline')
    .replace(/ menüsü/gi, ' menu')
    .replace(/ kısayolu/gi, ' shortcut')
    .replace(/(\d+) klip seçili/g, '$1 clips selected')
    .replace(/İstek başarısız \((\d+)\)/gi, 'Request failed ($1)')
    .replace(/Klip medyası bulunamadı:/gi, 'Clip media not found:')
    .replace(/Medya dosyası bulunamadı:/gi, 'Media file not found:')
    .replace(/Proje FPS değeri (\d+) FPS olarak yeniden örneklenecek\./gi, 'The project FPS value will be resampled to $1 FPS.')
    .replace(/4K dışa aktarma daha uzun sürebilir ve daha fazla disk alanı kullanır\./gi, '4K export may take longer and use more disk space.')
    .replace(/Animasyon keyframe'leri preview'de uygulanıyor; export için temel klip değerleri kullanılacak\./gi, 'Animation keyframes are applied in preview; base clip values will be used for export.')
    .replace(/Hız rampaları preview'de uygulanıyor; export sabit klip hızına dönecek\./gi, 'Speed ramps are applied in preview; export will use the fixed clip speed.')
    .replace(/Maske ayarları preview'de gösteriliyor; export için medya kadrajı kullanılacak\./gi, 'Mask settings are shown in preview; the media framing will be used for export.')
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
