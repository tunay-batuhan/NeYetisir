# NeYetişir — Sunucu Yapısı ve Deploy Rehberi

## 1. Sunucu Yapısı

**Sunucu:** DigitalOcean droplet — Ubuntu 24.04, 1 vCPU / 1 GB RAM
**IP:** 159.223.106.217
**Bağlantı:** `ssh root@159.223.106.217`

### İstek akışı

```
Ziyaretçi → nginx (port 80) → Docker konteyner "tarla" (127.0.0.1:8000, FastAPI/uvicorn)
```

### Önemli konumlar

| Konum                       | Ne var                                                       | Not                                                                                                                                      |
| --------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `/opt/tarla`                | **Canlı kod** + `Dockerfile` + `.env` + `deploy.sh`          | Git reposu DEĞİL. Docker image buradan build edilir. `.env` sadece burada durur (parolalar burada).                                      |
| `/root/tarla-islet-kodlari` | **Git reposu**                                               | GitHub'a bağlı (`github.com/tunay-batuhan/NeYetisir`). Deploy'da aracı olarak kullanılır.                                                |
| Docker volume `tarla-data`  | **Canlı veritabanı** (`app.db`) + soilgrids raster dosyaları | Konteynerin içinde `/app/data` olarak görünür. Kod güncellemesinden ETKİLENMEZ. Fiziksel yol: `/var/lib/docker/volumes/tarla-data/_data` |

### Docker

- Image: `tarla:latest` — konteyner adı: `tarla`
- Restart policy: `unless-stopped` (sunucu yeniden başlasa da konteyner kalkar)
- Sadece `127.0.0.1:8000` dinler; dış dünyaya nginx açar

### Kritik kurallar

- `/opt/tarla/.env` dosyasına ASLA dokunma / üzerine yazma (canlı parolalar burada)
- `Dockerfile`, `deploy.sh`, `scripts/` sadece `/opt/tarla`'da var, GitHub reposunda YOK — rsync ile silme!
- Veritabanı volume'da olduğu için `docker rm` konteyneri silse bile veri kaybolmaz
- `backend/db.py` içindeki `_migrate_ekstra_kolonlar` açılışta yeni kolonları otomatik ekler (şema değişikliği güvenli)

---

## 2. Deploy Adımları (baştan sona)

### Adım 0 — Local'de: commit + push

```bash
git add -A
git commit -m "değişiklik açıklaması"
git push
```

### Adım 1 — Sunucuya bağlan

```bash
ssh root@159.223.106.217
```

### Adım 2 — Yedek al (her deploy öncesi, 30 saniye)

```bash
# Çalışan image'ı "onceki" olarak etiketle (anında geri dönüş noktası)
docker tag tarla:latest tarla:onceki

# Veritabanı yedeği
tar czf /root/tarla-data-yedek-$(date +%F).tar.gz -C /var/lib/docker/volumes/tarla-data/_data .

# Kod yedeği
tar czf /root/opt-tarla-yedek-$(date +%F).tar.gz -C /opt tarla
```

### Adım 3 — GitHub'dan son kodu çek

```bash
cd /root/tarla-islet-kodlari
git pull
```

### Adım 4 — Kodu canlı klasöre kopyala

Sadece `backend/` ve `frontend/` kopyalanır; `.env`, `Dockerfile`, `deploy.sh` korunur:

```bash
rsync -a --delete --exclude='__pycache__' --exclude='*.pyc' \
  /root/tarla-islet-kodlari/backend/ /opt/tarla/backend/

rsync -a --delete /root/tarla-islet-kodlari/frontend/ /opt/tarla/frontend/
```

### Adım 5 — Yeni image'ı build et

Eski konteyner bu sırada çalışmaya devam eder, site kesintiye uğramaz:

```bash
cd /opt/tarla && docker build -t tarla:latest .
```

Sonunda `naming to docker.io/library/tarla:latest` görmelisin. Hata varsa DUR — site hâlâ eski haliyle çalışıyor, acele etme.

### Adım 6 — Konteyneri değiştir (~5 sn kesinti)

```bash
docker rm -f tarla
docker run -d --name tarla \
  --restart unless-stopped \
  --env-file /opt/tarla/.env \
  -p 127.0.0.1:8000:8000 \
  -v tarla-data:/app/data \
  tarla:latest
```

### Adım 7 — Sağlık kontrolü

```bash
sleep 5
curl -s -o /dev/null -w 'HTTP durum: %{http_code}\n' http://127.0.0.1:8000/
docker ps --filter name=tarla --format '{{.Names}}  {{.Status}}'
docker logs tarla --tail 15
```

Beklenen: `HTTP durum: 200`, konteyner `Up`, loglarda `Application startup complete`.
Sonra tarayıcıdan siteyi açıp elle test et (ana sayfa, formlar, admin paneli).

---

## 3. SORUN OLURSA — Geri dönüş (rollback)

### Kod bozuksa → eski image'a dön (~5 sn)

```bash
docker rm -f tarla
docker run -d --name tarla \
  --restart unless-stopped \
  --env-file /opt/tarla/.env \
  -p 127.0.0.1:8000:8000 \
  -v tarla-data:/app/data \
  tarla:onceki
```

### Veritabanı bozulduysa → yedekten geri yükle

```bash
# Önce konteyneri durdur
docker stop tarla

# Volume içeriğini yedekten geri aç (TARİHİ kendi yedeğinle değiştir)
rm -rf /var/lib/docker/volumes/tarla-data/_data/*
tar xzf /root/tarla-data-yedek-2026-07-06.tar.gz -C /var/lib/docker/volumes/tarla-data/_data

# Konteyneri başlat
docker start tarla
```

### Temizlik (deploy'dan birkaç gün sonra her şey yolundaysa)

```bash
docker rmi tarla:onceki          # eski image'ı sil
rm /root/*-yedek-*.tar.gz        # eski yedekleri sil (yenisi alınmışsa)
```
