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
        return;
      }
      fillSelect(ilceSel, [], window.I18n.t("query.loading"));
      try {
        const ilceler = await fetchJson(`/api/ilceler?ilId=${encodeURIComponent(ilId)}`);
        fillSelect(ilceSel, ilceler, window.I18n.t("query.select_ilce"));
        ilceSel.disabled = false;
        if (oncedenIlceAd) secByAd(ilceSel, oncedenIlceAd);
      } catch (e) {
        fillSelect(ilceSel, [], window.I18n.t("query.ilce_load_error"));
      }
    }

    ilSel.addEventListener("change", () => yukleIlceler(ilSel.value));

    // İlk yükleme placeholder'ı statik HTML'de zaten var (data-i18n="query.loading")
    // — burada tekrar yazmıyoruz çünkü sayfa açılışında i18next henüz hazır
    // olmayabilir (t() bu durumda boş döner, iyi olan statik metni ezerdi).
    (async () => {
      try {
        const iller = await fetchJson("/api/iller");
        fillSelect(ilSel, iller, window.I18n.t("query.select_il"));
        if (onceden && onceden.il && secByAd(ilSel, onceden.il)) {
          await yukleIlceler(ilSel.value, onceden.ilce);
        }
      } catch (e) {
        fillSelect(ilSel, [], window.I18n.t("query.il_load_error"));
      }
    })();
  }

  // Seçili option'ın görünen adını (metnini) döndürür; seçim yoksa null.
  function seciliAd(selId) {
    const sel = document.getElementById(selId);
    if (!sel || !sel.value) return null;
    return sel.options[sel.selectedIndex].textContent;
  }

  return { baglaSelectler, seciliAd };
})();
