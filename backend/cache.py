from cachetools import TTLCache

ONE_DAY = 60 * 60 * 24
THIRTY_DAYS = ONE_DAY * 30
SIX_HOURS = 60 * 60 * 6

iller_cache: TTLCache = TTLCache(maxsize=1, ttl=ONE_DAY)
ilceler_cache: TTLCache = TTLCache(maxsize=128, ttl=ONE_DAY)
mahalleler_cache: TTLCache = TTLCache(maxsize=2048, ttl=ONE_DAY)

# 2. aşama — analiz katmanı. Key: (round(lat,3), round(lon,3)) ≈ 110m hassasiyet.
# forecast 6 saatte tazelenir; iklim normali / toprak / DEM aylar boyunca sabit.
hava_cache: TTLCache = TTLCache(maxsize=512, ttl=SIX_HOURS)
iklim_cache: TTLCache = TTLCache(maxsize=512, ttl=THIRTY_DAYS)
toprak_cache: TTLCache = TTLCache(maxsize=2048, ttl=THIRTY_DAYS)
yukseklik_cache: TTLCache = TTLCache(maxsize=2048, ttl=THIRTY_DAYS)
