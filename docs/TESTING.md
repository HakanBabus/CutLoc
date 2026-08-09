# CutLoc test ve baseline politikası

Bu belge, v0.0.2 için gerçekten çalışan otomatik kontrolleri, CI kapılarını ve otomatik olmayan web smoke adımını birbirinden ayırır. Bir kontrol burada yazıyorsa ya package script'iyle ya da açıkça manuel bir akışla doğrulanabilir olmalıdır.

## Test katmanları

| Katman | Komut | Sorumluluk |
| --- | --- | --- |
| Shared contract | `npm run test:shared` | Zod modelleri, default değerler, timeline yardımcıları ve export boyutları |
| Server integration | `npm run test:server` | Local API, proje CRUD, revision, path güvenliği, FFmpeg job ve export |
| Full baseline | `npm run verify` | Build + shared/server testleri |
| Dependency audit | `npm audit --omit=dev --audit-level=high` | Production dependency güvenlik eşiği |
| Web smoke | Manuel; aşağıdaki akış | Dashboard, local API bağlantısı, proje oluşturma ve editor shell |

Şu anda package script'lerinde `test:web` veya `verify:all` tanımlı değildir. Bu nedenle web smoke adımı otomatik CI testi gibi sunulmaz; browser tabanlı bir smoke runner eklendiğinde bu belge ve package script'leri birlikte güncellenmelidir.

## Web smoke test sınırı

Web smoke testi ürün kabul testi değildir; yalnızca en kritik açılış sözleşmesini kontrol eder:

1. Vite arayüzü `127.0.0.1:5173` üzerinde açılır.
2. Fastify health endpoint'i `127.0.0.1:4173` üzerinden erişilebilir.
3. Dashboard DOM'a render edilir.
4. Kullanıcı yeni proje oluşturabilir.
5. Editor shell, canvas, Inspector, timeline ve save status görünür.
6. Built-in stock media veya küçük bir deterministik fixture timeline'a eklenebilir.

Bu akış gerçek kullanıcı verisine dokunmamalıdır. Manuel doğrulama için ayrı bir geçici `DATA_DIR` kullanın ve test sonunda bu alanı temizleyin.

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
4. `npm audit --omit=dev --audit-level=high`

CodeQL ayrı bir workflow olarak yapılandırılmıştır. Browser smoke testi henüz CI job'ı değildir; public sürüm öncesi manuel kontrol olarak takip edilir.

## Yerel çalıştırma

PowerShell üzerinde önerilen akış:

```powershell
npm ci
npm run verify
npm audit --omit=dev --audit-level=high
```

PowerShell execution policy `npm` shim'ini engellerse eşdeğer komutlarda `npm.cmd` kullanın:

```powershell
npm.cmd run verify
npm.cmd audit --omit=dev --audit-level=high
```

Smoke testi için port `5173` ve API portu `4173` kullanılır. Bu portlardan biri zaten kullanılıyorsa mevcut süreci kontrol edin; farklı ve desteklenmeyen bir Vite portu kullanmak, local origin kontrolü nedeniyle API isteklerini reddedebilir. Testin gerçek kullanıcı verisine bağlanmaması için ayrı `DATA_DIR` kullanın.
