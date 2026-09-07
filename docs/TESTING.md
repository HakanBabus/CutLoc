# CutLoc test ve baseline politikası

Bu belge, v0.0.2 için gerçekten çalışan otomatik kontrolleri ve CI kapılarını birbirinden ayırır. Bir kontrol burada yazıyorsa package script'iyle doğrulanabilir olmalıdır.

## Test katmanları

| Katman | Komut | Sorumluluk |
| --- | --- | --- |
| Shared contract | `npm run test:shared` | Zod modelleri, default değerler, timeline yardımcıları ve export boyutları |
| Server integration | `npm run test:server` | Local API, proje CRUD, revision, CLI access lease, path güvenliği, FFmpeg job ve export |
| CLI integration | `npm run test:cli` | Gerçek CLI executable, JSON stdout, argüman doğrulama, session izolasyonu ve low-level API routing |
| Full baseline | `npm run verify` | Build + shared/server testleri |
| Dependency audit | `npm audit --omit=dev --audit-level=high` | Production dependency güvenlik eşiği |
| Browser regression | `npm run test:web` | Dashboard, autosave, iki sekmeli revision conflict ve editor kısayolları |
| Full automated baseline | `npm run verify:all` | Build + shared/server + Playwright browser testleri |

`test:web`, Playwright Chromium ile çalışır. `verify:all` build, shared/server testleri ve browser regression testlerini birlikte çalıştırır.

## Browser regression sınırı

Browser regression paketi tam görsel parity testi değildir; kritik açılış ve veri güvenliği sözleşmelerini kontrol eder:

1. Vite arayüzü `127.0.0.1:5173` üzerinde açılır.
2. Fastify health endpoint'i `127.0.0.1:4173` üzerinden erişilebilir.
3. Dashboard DOM'a render edilir.
4. Kullanıcı yeni proje oluşturabilir.
5. Editor shell, canvas, Inspector, timeline ve save status görünür.
6. Built-in stock media veya küçük bir deterministik fixture timeline'a eklenebilir.
7. İki stale sekmenin bağımsız alan editleri üç yönlü merge edilir; aynı alan conflict'i sessizce kaydedilmez.
8. Dashboard quick-card eylemleri ve Command Palette'te gösterilen `M` / `Ctrl/Cmd+E` kısayolları gerçek davranışla eşleşir.
9. CLI bir projeyi devraldığında açık web editörü lease sahibini gösterir, pointer editlerini engeller ve lease bırakılınca yeniden kullanılabilir olur.

Bu akış gerçek kullanıcı verisine dokunmamalıdır. Playwright ayrı bir geçici `DATA_DIR` kullanır ve testler oluşturdukları projeleri temizler.

## Fixture politikası

- Fixture'lar küçük, deterministik ve kişisel medya içermeyen dosyalardır.
- Ses fixture'ı sinüs dalgası olarak test sırasında üretilir.
- Görsel fixture'ı test sırasında üretilir.
- Subtitle fixture'ı sabit SRT metnidir.
- Gerçek kullanıcı dosyaları, büyük medya ve network tabanlı fixture kullanılmaz.
- Yeni bir fixture eklendiğinde beklenen format, boyut, süre ve test amacı belgelenir.

## CI baseline

Pull request ve `main`/`master` push'larında mevcut CI şu kapıları çalıştırır:

1. `npm ci`
2. `npm run build`
3. `npm test`
4. Playwright Chromium kurulumu
5. `npm run test:web`
6. `npm audit --omit=dev --audit-level=high`

CodeQL ayrı bir workflow olarak yapılandırılmıştır. Browser regression normal PR ve main CI akışının parçasıdır.

## Yerel çalıştırma

PowerShell üzerinde önerilen akış:

```powershell
npm ci
npm run verify:all
npm audit --omit=dev --audit-level=high
```

PowerShell execution policy `npm` shim'ini engellerse eşdeğer komutlarda `npm.cmd` kullanın:

```powershell
npm.cmd run verify:all
npm.cmd audit --omit=dev --audit-level=high
```

Browser testi için port `5173` ve API portu `4173` kullanılır. Bu portlardan biri zaten kullanılıyorsa mevcut süreci kontrol edin; farklı ve desteklenmeyen bir Vite portu kullanmak, local origin kontrolü nedeniyle API isteklerini reddedebilir. Testin gerçek kullanıcı verisine bağlanmaması için ayrı `DATA_DIR` kullanın.
