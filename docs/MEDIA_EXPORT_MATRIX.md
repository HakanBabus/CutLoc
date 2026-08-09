# CutLoc medya ve export matrisi

Bu belge, uygulamanın şu anki upload filtresini, export sözleşmesini ve otomatik test kapsamını birbirinden ayırır. Bir dosyanın upload filtresinden geçmesi, FFmpeg build'inin o dosyadaki codec'i başarıyla decode edeceği anlamına gelmez.

## Import: kabul edilen dosya sınıfları

| Sınıf | Uzantılar | MIME davranışı | Durum |
| --- | --- | --- | --- |
| Video | `.mp4`, `.webm`, `.mov`, `.mkv`, `.avi`, `.m4v` | `video/*` MIME'ları kabul edilir | Upload filtresi mevcut; codec kombinasyonları ayrı doğrulanır |
| Ses | `.mp3`, `.wav`, `.m4a`, `.aac`, `.ogg`, `.flac`, `.opus` | `audio/*` MIME'ları kabul edilir | Upload filtresi mevcut; codec kombinasyonları ayrı doğrulanır |
| Görsel | `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.bmp`, `.tif`, `.tiff` | `image/*` MIME'ları kabul edilir | Upload filtresi mevcut; decode/export davranışı ayrı doğrulanır |

### Import sözleşmesi

- Dosya proje içindeki `media/` alanına kopyalanır.
- Asset kaydında ad, MIME, boyut, süre, çözünürlük, FPS ve ses bilgisi tutulur.
- Video için proxy ve thumbnail; ses için waveform; görsel için thumbnail oluşturulması arka plan job'ıdır.
- FFmpeg veya ffprobe bulunamazsa proje kaydı ile türetilmiş medya job'ı birbirinden ayrılır; export preflight eksik binary'yi hata olarak bildirir.
- Bozuk veya FFmpeg tarafından çözülemeyen bir dosya şu an tam codec-uyumluluk garantisi almaz.

## Export formatları

| Format | Video codec | Audio codec | Not |
| --- | --- | --- | --- |
| MP4 | H.264 `libx264` | AAC | `yuv420p`, `+faststart`, yeniden encode |
| MP3 | Yok | `libmp3lame` | Seçilebilir 128/192/256 kbps |
| WAV | Yok | `pcm_s16le` | PCM ses çıktısı |

## Export seçenekleri

| Alan | Değerler |
| --- | --- |
| Aspect | `source`, `16:9`, `9:16`, `1:1`, `4:5`, `3:2`, `21:9` |
| Resolution | `720p`, `1080p`, `2K`, `4K` |
| FPS | `24`, `25`, `30`, `50`, `60` |
| Quality | `draft`, `standard`, `high`, `custom` |
| Audio bitrate | `128`, `192`, `256` kbps |
| Range | Timeline üzerinde geçerli `start` ve `end` aralığı |

### MP4 kalite karşılıkları

| Seçim | Preset | CRF |
| --- | --- | --- |
| Draft | `veryfast` | 28 |
| Standard | `medium` | 23 |
| High | `slow` | 18 |
| Custom | Kullanıcının CRF veya bitrate seçimi | Kullanıcı seçimi |

## Çözünürlük hesabı

Resolution etiketi kısa kenarı ifade eder. Çıktı boyutları FFmpeg'in çift piksel gereksinimini karşılayacak şekilde çift sayıya yuvarlanır.

Örnekler:

- `16:9 + 1080p` → `1920x1080`
- `9:16 + 1080p` → `1080x1920`
- `1:1 + 1080p` → `1080x1080`
- `4:5 + 1080p` → `1080x1350`
- `21:9 + 1080p` → `2560x1080`

## Otomatik doğrulama kapsamı

### Şu anda test edilen

- WAV fixture import.
- WAV waveform job'ı.
- MP3 export.
- WAV export ve RIFF başlığı.
- Built-in PNG stock media import ve MP4 export.
- MP4 export için 4K, 24 FPS ve draft kalite kombinasyonu.
- Shared export schema ve çözünürlük hesaplama.

### Faz 0 baseline'ında tanımlanan ancak kapsamı ileride genişletilecek

- Gerçek video dosyalarının tüm listedeki container/codec kombinasyonları.
- GIF/WebP/TIFF animasyon ve renk profili davranışları.
- Subtitle burn-in ve ses/video senkron matrisi.
- Donanım encoder çıktısı.
- Browser preview ile export piksel/parite karşılaştırması.

## Kullanıcıya söylenecek doğru ifade

CutLoc, listelenen yaygın video, ses ve görsel dosyalarını local FFmpeg pipeline'ına almayı hedefler. **Codec/container uyumluluğu kullanılan FFmpeg build'ine bağlıdır.** Bir dosyanın kesin desteklendiği ancak o dosya türü için otomatik fixture ve export testi bulunduğunda söylenmelidir.
