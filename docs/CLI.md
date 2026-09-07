# CutLoc CLI

CutLoc CLI, yerel web editörünün kullandığı **aynı Fastify API'sine** bağlanır. Böylece CLI ile yapılan proje editleri de web arayüzündeki Zod doğrulaması, revision kontrolü, backup, medya ve export kurallarından geçer. CLI proje dosyalarını doğrudan değiştirmez.

## Başlatma

Önce CutLoc sunucusunu çalıştırın:

```powershell
npm.cmd run dev:server
```

Başka bir terminalde CLI komutunu kullanın:

```powershell
npm.cmd run cli -- projects list
npm.cmd run cli -- projects get <project-id>
```

Varsayılan adres `http://127.0.0.1:4173` değeridir. Farklı bir local port için `--url` veya `CUTLOC_URL` kullanılabilir. `--url` yalnızca `http://` veya `https://` şemalı bir loopback adresi olabilir; CLI güvenlik gereği loopback dışındaki sunuculara bağlanmaz.

Geçersiz URL, loopback dışı adres veya bilinmeyen CLI argümanı durumunda süreç `1` çıkış koduyla sonlanır ve makine-okunur hata JSON'u yalnızca `stderr` üzerine yazılır.

`projects create [name]` birden fazla konumsal kelimeyi tek proje adı olarak birleştirir; tanınmayan `--...` seçenekleri reddedilir.

## AI aracıyla proje düzenleme

Bir AI aracı önce güncel project JSON'unu alıp dosyaya yazabilir:

```powershell
npm.cmd run cli -- projects get <project-id> --out project.json
```

Araç JSON üzerinde istediği timeline, track, clip, canvas, text, filter, transition veya keyframe değişikliğini yaptıktan sonra güncel **revision** değerini koruyarak projeye uygulayabilir:

```powershell
npm.cmd run cli -- projects apply <project-id> --file project.json
```

Sunucu gönderilen modelin tamamını `ProjectSchema` ile doğrular. Revision başka bir istemci tarafından ilerletilmişse istek sessizce üzerine yazmak yerine conflict hatası verir.

Çok sayıda ardışık işlem yapan araçlar için kalıcı oturum kullanılabilir:

```powershell
npm.cmd run cli -- session <project-id>
```

Oturum stdin'den satır başına bir JSON isteği alır:

```json
{"method":"GET","path":"/api/projects/<project-id>"}
{"method":"PATCH","path":"/api/projects/<project-id>","body":{"name":"CLI ile düzenlendi","revision":3}}
```

İlk çıktı `ready: true` içerir. Sonraki her çıktı `{ "ok": true, "result": ... }` veya `{ "ok": false, "error": ... }` biçimindedir. stdin kapandığında oturum kilidi bırakılır.

## Proje erişim kilidi

- Projeyi değiştiren normal CLI komutları işlem boyunca otomatik bir erişim lease'i alır.
- `session` komutu lease'i heartbeat ile canlı tutar.
- CLI, aynı proje webde açık olsa bile erişimi devralır.
- Web editörü sahibin adını gösteren bir uyarıyla salt okunur hâle gelir ve autosave bekler.
- CLI düzgün kapanırsa kilit hemen bırakılır. Süreç çöker veya bağlantı kesilirse lease en geç yaklaşık 15 saniyede sona erer.
- Kilit yalnızca ilgili projeyi etkiler; dashboard ve diğer projeler kullanılabilir.

## Komutlar

Tam ve güncel liste:

```powershell
npm.cmd run cli -- --help
```

| Alan | Komutlar |
| --- | --- |
| Proje | `projects list/create/get/apply/duplicate/delete/import/bundle` |
| Medya | `media add/remove/relink/rebuild/health/stock` |
| Yedek | `backups list/restore` |
| Export | `export preflight/start` ve `jobs list/get/cancel/download` |
| Çöp kutusu | `trash list/restore/delete` |
| Ayarlar | `settings get/set` |
| Tüm local API | `api <method> </api/path>` |

`api` komutu JSON tabanlı local API endpoint'lerine düşük seviyeli erişim sağlar. Mutating bir `/api/projects/<id>/...` yolu verildiğinde proje kilidi otomatik alınır. Binary cevaplar için `--out` kullanılmalıdır. Medya yükleme ve relink için `media`, ZIP proje paketi için `projects import` komutları kullanılmalıdır; `/api/events` SSE akışı generic `api` veya `session` komutu tarafından stream edilmez.

## Güvenli kullanım notları

- CLI yalnızca çalışan local CutLoc sunucusuna bağlanır; sunucuyu veya hosted bir AI sağlayıcısını kendisi başlatmaz.
- Project JSON editlerinde önce `projects get` ile son revision'ı alın.
- Project JSON'u dosyaya alırken shell yönlendirmesi yerine `projects get --out <dosya>` kullanın; böylece npm lifecycle metni JSON'a karışmaz.
- Bir projenin içeriğini güncellerken `projects apply` veya `session` kullanın; `data/projects/.../project.json` dosyasını elle yazmayın.
- Silme, backup restore ve media remove işlemleri web arayüzündekiyle aynı kalıcı sonuçlara sahiptir.
