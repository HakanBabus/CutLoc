# CutLoc ürün sözleşmesi

Bu belge, CutLoc'un mevcut sürümünün neyi garanti ettiğini ve hangi davranışların henüz garanti edilmediğini tanımlar. Amaç, yeni özellik eklerken ürün sınırlarının ve geriye dönük uyumluluk kararlarının koddan kopmasını önlemektir.

## Ürün kimliği

CutLoc, **tek kullanıcı için local-first bir video editörüdür**.

Mevcut ürünün ana akışı:

1. Local dashboard'dan proje oluşturulur veya açılır.
2. Video, ses ve görsel dosyaları proje medya alanına alınır.
3. Medya için proxy, thumbnail ve waveform gibi türetilmiş dosyalar local olarak hazırlanır.
4. Kullanıcı medya ve metin kliplerini çoklu track timeline'ında düzenler.
5. Preview, Inspector ve timeline üzerinden değişiklikler yapılır.
6. FFmpeg ile local export alınır.

## Local-first sınırı

### Garanti edilen davranış

- Uygulamanın local API'si varsayılan olarak `127.0.0.1` üzerinde çalışır.
- Proje JSON'u, medya, proxy, thumbnail, waveform, backup ve export dosyaları cihazın `data/` alanında tutulur.
- Uygulama çalışma sırasında medya veya proje içeriğini bir hosted servise yüklemez.
- API, local olmayan host ve origin isteklerini reddetmek üzere korunur.
- AI özellikleri varsayılan olarak kapalıdır ve mevcut sürümde aktif bir dış sağlayıcı akışı yoktur.

### Garanti edilmeyen davranış

- Local server'ın public interface, LAN, tunnel veya reverse proxy üzerinden güvenli biçimde yayınlanması.
- Çok kullanıcılı veya eş zamanlı collaborative editing.
- Proje klasörünün başka bilgisayarda medya yolları değişmeden otomatik açılması.
- Donanım encoder kullanımının her makinede mevcut veya doğru çalışması.
- Her FFmpeg codec/container kombinasyonunun desteklenmesi.

## Mevcut editör kapsamı

### Mevcut

- Video, ses ve görsel import.
- Çoklu track timeline.
- Frame-aware playhead, marker ve snapping.
- Split, trim, taşıma, duplicate, ripple delete ve undo/redo.
- Canvas üzerinde position, scale, rotation, opacity ve fit ayarları.
- Canvas üzerinde görünür nesneye tıklayarak eşleşen timeline klibini ve Inspector'ı seçme; zoom ve kaydırmalı preview viewport'u.
- Filtre, mask, speed, fade, transition ve keyframe modeli.
- Motion studio üzerinden giriş, çıkış veya birlikte animasyon seçimi; yön, easing, yoğunluk ve süre ayarları.
- Text, shape, caption ve SRT/VTT import.
- Şekillerin ayrı bir araç rayı yerine Media alanında tutulması ve aranabilir yardım merkezi.
- MP4, MP3 ve WAV local export.
- Autosave, revision kontrolü, backup ve trash.

### Deneysel veya henüz garanti edilmeyen

- Tüm Inspector kontrollerinin her medya türünde export ile birebir aynı sonucu vermesi.
- Browser preview ile FFmpeg çıktısının her codec ve filtre kombinasyonunda aynı görünmesi.
- Motion studio'nun yön/easing/yoğunluk gibi gelişmiş ayarlarının tüm export yollarında birebir render edilmesi; export fallback davranışı sürüm sözleşmesine göre değişebilir.
- Otomatik altyazı/transcription.
- AI ile doğrudan edit uygulama.
- Lossless/remux tabanlı hızlı kesme modu.
- Proje paketi olarak taşınabilir `.cutloc` formatı.

## Proje dosyası uyumluluk politikası

Mevcut project JSON sözleşmesinin versiyonu **1**'dir.

Faz 0 kararı:

- Yeni bir alan eklemek mevcut `schemaVersion` değerini değiştirmez.
- Geriye dönük uyumsuz bir model değişikliği yapılmadan önce yeni schema versiyonu tanımlanır.
- Her yeni versiyon için açık bir migration fonksiyonu ve fixture gerekir.
- Migration başarısız olursa dosya sessizce üzerine yazılmaz; kullanıcıya recovery yolu bırakılır.
- Backup dosyaları migration öncesi korunur.
- Bir proje dosyası yalnızca Zod doğrulamasından geçtikten sonra uygulama modeline alınır.

Faz 0, bu politikanın sabitlerini ve testlerini ekler. Çok adımlı migration registry'si Faz 1 kapsamındadır.

## Export sözleşmesi

Mevcut export, **creative render** modelidir ve varsayılan olarak yeniden encode eder. MP4 çıktısı için CPU üzerinde `libx264` ve AAC kullanılır. Bu nedenle mevcut export akışı lossless export olarak adlandırılamaz.

Export seçenekleri ve doğrulanmış sınırlar [medya ve export matrisinde](./MEDIA_EXPORT_MATRIX.md) tutulur.

## Değişiklik ilkeleri

Yeni bir özellik eklenmeden önce şu sorular cevaplanmalıdır:

1. Bu özellik local-first sınırını genişletiyor mu?
2. Project JSON'a yeni alan ekliyorsa migration gerekir mi?
3. Browser preview ve FFmpeg export aynı davranışı verecek mi?
4. Undo/redo ve autosave bu değişikliği koruyor mu?
5. En az bir shared, server veya web smoke testiyle davranış kilitleniyor mu?
6. Kullanıcıya başarısızlık ve recovery durumu görünür mü?

Bu sorular cevaplanamıyorsa özellik deneysel olarak etiketlenmeli ve mevcut garantilerin parçası gibi sunulmamalıdır.
