// Paylaşılan il/ilçe cascading-select yardımcısı — /api/iller ve /api/ilceler'i
// kullanır. Backend'deki il/ilçe alanları serbest metin olduğu için (TKGM id'sine
// referans değil) form gönderiminde seçili option'ın görünen adı (ad) kullanılır;
// id yalnızca ilçe listesini çekmek için tutulur.
window.IlIlce = (function () {
  async function fetchJson(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  // il/ilçe listeleri neredeyse hiç değişmez — localStorage'da 7 gün önbellekleyip
  // her sayfa açılışında backend'e tekrar gitmeyi önlüyoruz.
  const LOC_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  async function fetchJsonCached(url) {
    const key = `neyetisir_loc_cache:${url}`;
    try {
      const cached = JSON.parse(localStorage.getItem(key));
      if (cached && Date.now() - cached.t < LOC_CACHE_TTL_MS) return cached.d;
    } catch (_) {}
    const data = await fetchJson(url);
    try {
      localStorage.setItem(key, JSON.stringify({ t: Date.now(), d: data }));
    } catch (_) {
      // localStorage dolu/kapalı olabilir — önbellek olmadan devam, işlevi bozmaz.
    }
    return data;
  }

  const CHEVRON = `<path d="m6 9 6 6 6-6"/>`;
  const SPINNER = `<style>@keyframes _spin{to{transform:rotate(360deg)}}</style>
    <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="3" stroke-dasharray="28 56"
      style="transform-origin:center;animation:_spin .7s linear infinite"/>`;

  function setYukleniyor(sel, yukleniyor) {
    const svg = sel.parentElement && sel.parentElement.querySelector("svg");
    if (!svg) return;
    svg.innerHTML = yukleniyor ? SPINNER : CHEVRON;
    svg.classList.toggle("text-brand", yukleniyor);
    svg.classList.toggle("text-slate-400", !yukleniyor);
  }

  function fillSelect(sel, items, placeholder) {
    sel.innerHTML = "";
    const ph = document.createElement("option");
    ph.value = "";
    ph.textContent = placeholder;
    sel.appendChild(ph);
    for (const it of items) {
      const opt = document.createElement("option");
      opt.value = it.id;
      opt.textContent = it.ad;
      sel.appendChild(opt);
    }
  }

  function secByAd(sel, ad) {
    if (!ad) return false;
    for (const opt of sel.options) {
      if (opt.textContent === ad) {
        sel.value = opt.value;
        return true;
      }
    }
    return false;
  }

  // İl/ilçe select'lerini bağlar: il listesini yükler, il değişince ilçe
  // listesini çeker. `onceden` verilirse ({il, ilce}) sayfa açılışında o
  // isimlerle ön-seçim yapar (rapordan gelen query-param'lar için).
  function baglaSelectler(ilSelId, ilceSelId, onceden) {
    const ilSel = document.getElementById(ilSelId);
    const ilceSel = document.getElementById(ilceSelId);
    if (!ilSel || !ilceSel) return;

    async function yukleIlceler(ilId, oncedenIlceAd) {
      ilceSel.disabled = true;
      if (!ilId) {
        fillSelect(ilceSel, [], window.I18n.t("query.none_placeholder"));
        setYukleniyor(ilceSel, false);
        return;
      }
      fillSelect(ilceSel, [], window.I18n.t("query.loading") || "Yükleniyor…");
      setYukleniyor(ilceSel, true);
      try {
        const ilceler = await fetchJsonCached(`/api/ilceler?ilId=${encodeURIComponent(ilId)}`);
        fillSelect(ilceSel, ilceler, window.I18n.t("query.select_ilce") || "— İlçe seçin —");
        ilceSel.disabled = false;
      } catch (e) {
        fillSelect(ilceSel, [], window.I18n.t("query.ilce_load_error") || "Hata");
      } finally {
        setYukleniyor(ilceSel, false);
        if (oncedenIlceAd) secByAd(ilceSel, oncedenIlceAd);
      }
    }

    ilSel.addEventListener("change", () => yukleIlceler(ilSel.value));

    // Select option'ları dinamik doldurulduğu için data-i18n ile otomatik
    // çevrilmez — dil değişince placeholder'ı yeniden fetch yapmadan günceller.
    document.addEventListener("i18n:applied", () => {
      const phIl = ilSel.options[0];
      if (phIl && phIl.value === "") phIl.textContent = window.I18n.t("query.select_il");
      const phIlce = ilceSel.options[0];
      if (phIlce && phIlce.value === "") {
        phIlce.textContent = window.I18n.t(ilceSel.disabled ? "query.none_placeholder" : "query.select_ilce");
      }
    });

    // İlk yükleme placeholder'ı statik HTML'de zaten var (data-i18n="query.loading")
    // — burada tekrar yazmıyoruz çünkü sayfa açılışında i18next henüz hazır
    // olmayabilir (t() bu durumda boş döner, iyi olan statik metni ezerdi).
    setYukleniyor(ilSel, true);
    (async () => {
      try {
        const iller = await fetchJsonCached("/api/iller");
        fillSelect(ilSel, iller, window.I18n.t("query.select_il") || "— İl seçin —");
        if (onceden && onceden.il && secByAd(ilSel, onceden.il)) {
          await yukleIlceler(ilSel.value, onceden.ilce);
        }
      } catch (e) {
        fillSelect(ilSel, [], window.I18n.t("query.il_load_error") || "Hata");
      } finally {
        setYukleniyor(ilSel, false);
      }
    })();
  }

  // Seçili option'ın görünen adını (metnini) döndürür; seçim yoksa null.
  function seciliAd(selId) {
    const sel = document.getElementById(selId);
    if (!sel || !sel.value) return null;
    return sel.options[sel.selectedIndex].textContent;
  }

  return { baglaSelectler, seciliAd, setYukleniyor };
})();
