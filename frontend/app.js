(() => {
  const $ = (id) => document.getElementById(id);

  const ilSel = $("il");
  const ilceSel = $("ilce");
  const mahSel = $("mahalle");
  const adaInp = $("ada");
  const parselInp = $("parsel");
  const form = $("parsel-form");
  const submitBtn = $("submit-btn");
  const submitLabel = $("submit-label");
  const spinner = $("spinner");
  const alertBox = $("alert");
  const resultPanel = $("result");
  const koordBody = $("koord-body");

  // --- Map ----------------------------------------------------------------

  const map = L.map("map", { zoomControl: true }).setView([39.0, 35.0], 6);

  const osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "© OpenStreetMap",
  });

  // Esri World_Imagery'nin gerçek çözünürlüğü kırsal/tarım arazilerinde belli bir
  // seviyenin ötesine gitmiyor — daha yüksek zoom'da "Map data not yet available"
  // gri kare dönüyor. maxZoom'u düşük tutunca kullanıcı o noktanın ötesine hiç
  // yakınlaşamıyor.
  const satellite = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 16, attribution: "Tiles © Esri" }
  ).addTo(map);

  L.control.layers({ "Uydu (Esri)": satellite, "Sokak (OSM)": osm }).addTo(map);

  let parselLayer = null;
  let kosePointsLayer = null;
  let lastSonuc = null;
  let lastQuery = null;       // {mahalleId, ada, parsel} — /api/rapor için
  let lastCentroid = null;    // {lat, lon}
  let havaDone = false;
  let toprakDone = false;
  let lastHava = null;        // /api/analiz/hava yanıtı — rapor infografiği için
  let lastToprak = null;      // /api/analiz/toprak yanıtı — rapor infografiği için

  const parselStyle = { color: "#dc2626", weight: 3, fillColor: "#ef4444", fillOpacity: 0.25 };

  // Her seviyenin geometrisini id ile sakla; seçim değişince outline çizilir.
  const geomByLevel = { il: {}, ilce: {}, mahalle: {} };
  const outlineLayers = { il: null, ilce: null, mahalle: null };
  const outlineStyle = {
    il:      { color: "#1d4ed8", weight: 2, fillColor: "#3b82f6", fillOpacity: 0.05, interactive: false },
    ilce:    { color: "#047857", weight: 2, fillColor: "#10b981", fillOpacity: 0.08, interactive: false },
    mahalle: { color: "#b45309", weight: 2, fillColor: "#f59e0b", fillOpacity: 0.10, interactive: false },
  };
  const maxZoomByLevel = { il: 13, ilce: 14, mahalle: 16 };

  function clearOutline(level) {
    if (outlineLayers[level]) {
      map.removeLayer(outlineLayers[level]);
      outlineLayers[level] = null;
    }
  }

  function drawOutline(level, id) {
    clearOutline(level);
    const geom = geomByLevel[level][id];
    if (!geom) return;
    const layer = L.geoJSON(geom, { style: outlineStyle[level] }).addTo(map);
    outlineLayers[level] = layer;
    try {
      map.flyToBounds(layer.getBounds(), {
        padding: [30, 30],
        maxZoom: maxZoomByLevel[level],
        duration: 0.6,
      });
    } catch (_) { /* boş geometry */ }
  }

  // --- UI helpers ---------------------------------------------------------

  function setAlert(msg, kind = "error") {
    if (!msg) {
      alertBox.classList.add("hidden");
      alertBox.textContent = "";
      alertBox.classList.remove("error", "info");
      return;
    }
    alertBox.textContent = msg;
    alertBox.classList.remove("hidden", "error", "info");
    alertBox.classList.add(kind);
  }

  function setLoading(on) {
    submitBtn.disabled = on;
    spinner.classList.toggle("hidden", !on);
    submitLabel.textContent = on ? window.I18n.t("query.submit_loading") : window.I18n.t("query.submit");
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

  async function fetchJson(url) {
    const r = await fetch(url);
    if (!r.ok) {
      let detail = `HTTP ${r.status}`;
      try {
        const body = await r.json();
        if (body && body.detail) detail = body.detail;
      } catch (_) {}
      throw new Error(detail);
    }
    return r.json();
  }

  const TKGM_IL  = "https://parselsorgu.tkgm.gov.tr/app/modules/administrativeQuery/data/ilListe.json";
  const TKGM_ILC = "https://cbsapi.tkgm.gov.tr/megsiswebapi.v3.1/api/idariYapi/ilceListe";
  const TKGM_MAH = "https://cbsapi.tkgm.gov.tr/megsiswebapi.v3.1/api/idariYapi/mahalleListe";

  function parseTkgm(fc) {
    const feats = (fc && fc.features) || [];
    return feats
      .map(f => {
        const p = (f && f.properties) || {};
        return p.id != null && p.text != null
          ? { id: String(p.id), ad: String(p.text), geometry: (f.geometry || null) }
          : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.ad.localeCompare(b.ad, "tr"));
  }

  // --- Panel & chrome controls -------------------------------------------

  const resultsPanel = $("results-panel");
  const resultsReopen = $("results-reopen");
  function openResultsPanel() {
    resultsPanel.classList.remove("translate-x-full");
    resultsReopen.classList.add("hidden");
  }
  function closeResultsPanel() {
    resultsPanel.classList.add("translate-x-full");
    resultsReopen.classList.remove("hidden");  // kapatılan panele geri dönüş butonu
  }
  $("results-close").addEventListener("click", closeResultsPanel);
  resultsReopen.addEventListener("click", openResultsPanel);

  // --- Keşif sekmeleri (Özet / Hava / Toprak) ----------------------------

  const TAB_BASE = "flex items-center justify-center gap-1.5 rounded-lg py-1.5 transition disabled:opacity-40 disabled:cursor-not-allowed";
  const TAB_ON = "bg-white text-brand-deep shadow-sm";
  const TAB_OFF = "text-slate-500 hover:text-slate-700";

  const KESIF = ["ozet", "hava", "toprak"];
  const ktBtn = { ozet: $("kt-ozet"), hava: $("kt-hava"), toprak: $("kt-toprak") };
  const kpPanel = { ozet: $("kp-ozet"), hava: $("kp-hava"), toprak: $("kp-toprak") };
  // Sekme etiketi yanındaki yüklenme/biti işaretleri.
  const ktSpin = { hava: $("kt-hava-spin"), toprak: $("kt-toprak-spin") };
  const ktOk = { hava: $("kt-hava-ok"), toprak: $("kt-toprak-ok") };

  function setKesifTab(name) {
    for (const t of KESIF) {
      const active = t === name;
      ktBtn[t].className = `${TAB_BASE} ${active ? TAB_ON : TAB_OFF}`;
      kpPanel[t].classList.toggle("hidden", !active);
    }
  }
  // Sekme durum işareti: "busy" → spinner, "done" → tik, "none" → ikisi de gizli.
  function setKesifTabState(name, state) {
    if (!ktSpin[name]) return;
    ktSpin[name].classList.toggle("hidden", state !== "busy");
    ktOk[name].classList.toggle("hidden", state !== "done");
  }
  function resetKesifTabs() {
    ktBtn.hava.disabled = true;
    ktBtn.toprak.disabled = true;
    setKesifTabState("hava", "none");
    setKesifTabState("toprak", "none");
    setKesifTab("ozet");
  }
  for (const t of KESIF) {
    ktBtn[t].addEventListener("click", () => { if (!ktBtn[t].disabled) setKesifTab(t); });
  }

  // --- Geniş AI rapor görünümü (modal) -----------------------------------

  const raporModal = $("rapor-modal");
  const raporDrawer = $("rapor-drawer");
  function openRaporModal() {
    raporModal.classList.remove("hidden");
    requestAnimationFrame(() => raporDrawer.classList.remove("translate-x-full"));
  }
  function closeRaporModal() {
    raporDrawer.classList.add("translate-x-full");
    setTimeout(() => raporModal.classList.add("hidden"), 300);
  }
  $("rapor-back").addEventListener("click", closeRaporModal);
  $("rapor-backdrop").addEventListener("click", closeRaporModal);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !raporModal.classList.contains("hidden")) closeRaporModal();
  });

  // Rapor görünümü içi sekmeler (Rapor / Sohbet)
  const rtBtn = { rapor: $("rt-rapor"), sohbet: $("rt-sohbet") };
  const rpPanel = { rapor: $("rp-rapor"), sohbet: $("rp-sohbet") };
  function setRaporTab(name) {
    for (const t of ["rapor", "sohbet"]) {
      const active = t === name;
      rtBtn[t].className = `${TAB_BASE} px-6 ${active ? TAB_ON : TAB_OFF}`;
      rpPanel[t].classList.toggle("hidden", !active);
    }
    if (name === "sohbet") sohbetInput.focus();
  }
  rtBtn.rapor.addEventListener("click", () => setRaporTab("rapor"));
  rtBtn.sohbet.addEventListener("click", () => { if (!rtBtn.sohbet.disabled) setRaporTab("sohbet"); });

  // Rapor sekmesi durum işareti (Hava/Toprak sekmeleriyle aynı dil).
  const rtRaporSpin = $("rt-rapor-spin");
  const rtRaporOk = $("rt-rapor-ok");
  function setRaporTabState(state) {
    rtRaporSpin.classList.toggle("hidden", state !== "busy");
    rtRaporOk.classList.toggle("hidden", state !== "done");
  }

  // Rapor → Sohbet geçiş butonu (rapor bitince görünür).
  $("rapor-to-sohbet").addEventListener("click", () => {
    if (!rtBtn.sohbet.disabled) setRaporTab("sohbet");
  });

  // Footer butonu: geniş görünümü aç; ilk açılışta raporu otomatik üret.
  const openRaporBtn = $("open-rapor-btn");
  openRaporBtn.addEventListener("click", () => {
    if (openRaporBtn.disabled) return;
    if (!window.Auth.user) {
      window.Auth.openModal("giris");
      window.Auth.setAlert(window.I18n.t("report.login_required"), "info");
      return;
    }
    setRaporTab("rapor");
    openRaporModal();
    if (!raporIcerik && !raporBtn.disabled) raporBtn.click();
  });

  // Sol panel collapse: query-wrap'i panel genişliği kadar sola kaydır, handle görünür kalır.
  const queryWrap = $("query-wrap");
  const panelToggleIcon = $("panel-toggle-icon");
  let panelCollapsed = false;
  $("panel-toggle").addEventListener("click", () => {
    panelCollapsed = !panelCollapsed;
    queryWrap.classList.toggle("-translate-x-[340px]", panelCollapsed);
    // Ok yönünü çevir (kapalıyken sağ ok, açıkken sol ok).
    panelToggleIcon.innerHTML = panelCollapsed ? '<path d="m9 18 6-6-6-6"/>' : '<path d="m15 18-6-6 6-6"/>';
  });

  // "Seç" sekmesi (haritadan tıklayarak parsel seçimi) henüz çalışmıyor —
  // index.html'de disabled, tıklanamıyor. "Sorgula" tek aktif mod.

  // Üst bar placeholder'ları (görsel; backend yok).
  const langTr = $("lang-tr");
  const langEn = $("lang-en");
  function setLang(active, idle) {
    active.className = "h-8 w-8 grid place-items-center rounded-lg text-lg ring-2 ring-brand bg-white";
    idle.className = "h-8 w-8 grid place-items-center rounded-lg text-lg ring-1 ring-transparent hover:bg-slate-100";
  }
  langTr.addEventListener("click", () => setLang(langTr, langEn));
  langEn.addEventListener("click", () => setLang(langEn, langTr));
  // --- Üyelik / oturum ----------------------------------------------------
  // Auth mantığı paylaşılan `auth.js` modülüne taşındı (window.Auth);
  // app.js sadece rapor/sohbet kapısında oturum durumunu okur.

  // --- Cascading dropdowns ------------------------------------------------

  function cacheGeoms(level, items) {
    geomByLevel[level] = {};
    for (const it of items) if (it.geometry) geomByLevel[level][it.id] = it.geometry;
  }

  async function loadIller() {
    try {
      const iller = parseTkgm(await fetchJson(TKGM_IL));
      cacheGeoms("il", iller);
      fillSelect(ilSel, iller, window.I18n.t("query.select_il") || "— İl seçin —");
    } catch (e) {
      fillSelect(ilSel, [], window.I18n.t("query.il_load_error"));
      setAlert(`${window.I18n.t("query.il_fetch_failed")}: ${e.message}`);
    }
  }

  async function loadIlceler(ilId) {
    fillSelect(ilceSel, [], window.I18n.t("query.loading"));
    ilceSel.disabled = true;
    fillSelect(mahSel, [], window.I18n.t("query.none_placeholder"));
    mahSel.disabled = true;
    if (!ilId) {
      fillSelect(ilceSel, [], window.I18n.t("query.none_placeholder"));
      return;
    }
    try {
      const items = parseTkgm(await fetchJson(`${TKGM_ILC}/${encodeURIComponent(ilId)}`));
      cacheGeoms("ilce", items);
      fillSelect(ilceSel, items, window.I18n.t("query.select_ilce"));
      ilceSel.disabled = false;
    } catch (e) {
      fillSelect(ilceSel, [], window.I18n.t("query.error"));
      setAlert(`${window.I18n.t("query.ilce_fetch_failed")}: ${e.message}`);
    }
  }

  const spinSel = (sel, v) => window.IlIlce && window.IlIlce.setYukleniyor(sel, v);

  async function loadMahalleler(ilceId) {
    fillSelect(mahSel, [], window.I18n.t("query.loading") || "Yükleniyor…");
    mahSel.disabled = true;
    spinSel(mahSel, true);
    if (!ilceId) {
      fillSelect(mahSel, [], window.I18n.t("query.none_placeholder"));
      spinSel(mahSel, false);
      return;
    }
    try {
      const items = parseTkgm(await fetchJson(`${TKGM_MAH}/${encodeURIComponent(ilceId)}`));
      cacheGeoms("mahalle", items);
      fillSelect(mahSel, items, window.I18n.t("query.select_mahalle") || "— Mahalle seçin —");
      mahSel.disabled = false;
    } catch (e) {
      fillSelect(mahSel, [], window.I18n.t("query.error"));
      setAlert(`${window.I18n.t("query.mahalle_fetch_failed")}: ${e.message}`);
    } finally {
      spinSel(mahSel, false);
    }
  }

  ilSel.addEventListener("change", () => {
    setAlert("");
    // Üst seviye değişince alt seviye outline'larını sil.
    clearOutline("ilce");
    clearOutline("mahalle");
    if (ilSel.value) drawOutline("il", ilSel.value);
    else clearOutline("il");
    loadIlceler(ilSel.value);
  });
  ilceSel.addEventListener("change", () => {
    setAlert("");
    clearOutline("mahalle");
    if (ilceSel.value) drawOutline("ilce", ilceSel.value);
    else clearOutline("ilce");
    loadMahalleler(ilceSel.value);
  });
  mahSel.addEventListener("change", () => {
    setAlert("");
    if (mahSel.value) drawOutline("mahalle", mahSel.value);
    else clearOutline("mahalle");
  });

  // --- Submit -------------------------------------------------------------

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    setAlert("");
    clearAnaliz();
    clearRapor();

    const mahalleId = mahSel.value;
    const ada = adaInp.value.trim();
    const parsel = parselInp.value.trim();

    if (!mahalleId) return setAlert(window.I18n.t("query.no_selection"));
    if (!ada || !parsel) return setAlert(window.I18n.t("query.ada_parsel_required"));

    setLoading(true);
    try {
      const url = `/api/parsel?mahalleId=${encodeURIComponent(mahalleId)}&ada=${encodeURIComponent(ada)}&parsel=${encodeURIComponent(parsel)}`;
      const sonuc = await fetchJson(url);
      lastQuery = { mahalleId, ada, parsel };
      drawSonuc(sonuc);
    } catch (err) {
      clearLayers();
      resultPanel.classList.add("hidden");
      lastQuery = null;
      setAlert(err.message || window.I18n.t("query.search_failed"));
    } finally {
      setLoading(false);
    }
  });

  // --- Result rendering ---------------------------------------------------

  function clearLayers() {
    if (parselLayer) { map.removeLayer(parselLayer); parselLayer = null; }
    if (kosePointsLayer) { map.removeLayer(kosePointsLayer); kosePointsLayer = null; }
  }

  function drawSonuc(sonuc) {
    lastSonuc = sonuc;
    clearLayers();

    parselLayer = L.geoJSON(sonuc.geometry, { style: parselStyle }).addTo(map);

    const koords = sonuc.koordinatlar || [];
    const markers = koords.map((k, i) =>
      L.circleMarker([k.lat, k.lon], {
        radius: 4, color: "#7f1d1d", weight: 1.5, fillColor: "#fff", fillOpacity: 1,
      }).bindTooltip(String(i + 1), { permanent: false })
    );
    kosePointsLayer = L.layerGroup(markers).addTo(map);

    try {
      map.fitBounds(parselLayer.getBounds(), { padding: [30, 30], maxZoom: 16 });
    } catch (_) { /* boş geometry */ }

    const o = sonuc.ozellikler || {};
    $("r-konum").textContent = [
      o.il, o.ilce, o.mahalle,
      o.ada && `${window.I18n.t("query.placeholder_ada")} ${o.ada}`,
      o.parsel && `${window.I18n.t("query.placeholder_parsel")} ${o.parsel}`,
    ].filter(Boolean).join(" / ");
    $("r-yuz").textContent = o.yuzolcumu != null ? `${o.yuzolcumu.toLocaleString("tr-TR")} m²` : "—";
    $("r-nitelik").textContent = o.nitelik || "—";
    $("r-mevki").textContent = o.mevki || "—";
    $("r-kose").textContent = String(koords.length);

    koordBody.innerHTML = "";
    koords.forEach((k, i) => {
      const tr = document.createElement("tr");
      tr.className = i % 2 ? "bg-white" : "bg-slate-50";
      tr.innerHTML = `
        <td class="px-2 py-1 text-slate-500">${i + 1}</td>
        <td class="px-2 py-1 font-mono">${k.lat.toFixed(6)}</td>
        <td class="px-2 py-1 font-mono">${k.lon.toFixed(6)}</td>
        <td class="px-2 py-1 text-right">
          <button data-i="${i}" class="copy-row text-xs px-2 py-0.5 border rounded hover:bg-slate-100">
            ${window.I18n.t("results.summary.copy_row")}
          </button>
        </td>`;
      koordBody.appendChild(tr);
    });

    resultPanel.classList.remove("hidden");
    openResultsPanel();

    // 2. aşama analiz artık otomatik tetiklenmiyor — kullanıcı butonla başlatır.
    const c = polygonCentroid(sonuc.geometry) || parselLayer.getBounds().getCenter();
    lastCentroid = { lat: c.lat, lon: c.lng ?? c.lon };
  }

  // --- Centroid (poligon ağırlık merkezi, sub-ha parsellerde fitBounds.center'a çok yakın) ---

  function polygonCentroid(geom) {
    if (!geom) return null;
    let ring = null;
    if (geom.type === "Polygon") ring = geom.coordinates?.[0];
    else if (geom.type === "MultiPolygon") ring = geom.coordinates?.[0]?.[0];
    if (!ring || ring.length < 4) return null;
    let area = 0, cx = 0, cy = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      const [x1, y1] = ring[i];
      const [x2, y2] = ring[i + 1];
      const a = x1 * y2 - x2 * y1;
      area += a;
      cx += (x1 + x2) * a;
      cy += (y1 + y2) * a;
    }
    area /= 2;
    if (Math.abs(area) < 1e-12) return null;
    return { lat: cy / (6 * area), lng: cx / (6 * area) };
  }

  // Row + bulk actions
  koordBody.addEventListener("click", (e) => {
    const btn = e.target.closest(".copy-row");
    if (!btn || !lastSonuc) return;
    const i = Number(btn.dataset.i);
    const k = lastSonuc.koordinatlar[i];
    navigator.clipboard.writeText(`${k.lat.toFixed(6)},${k.lon.toFixed(6)}`);
    btn.textContent = window.I18n.t("results.summary.copied");
    setTimeout(() => (btn.textContent = window.I18n.t("results.summary.copy_row")), 1200);
  });

  $("copy-btn").addEventListener("click", () => {
    if (!lastSonuc) return;
    const text = lastSonuc.koordinatlar
      .map((k) => `${k.lat.toFixed(6)},${k.lon.toFixed(6)}`)
      .join("\n");
    navigator.clipboard.writeText(text);
  });

  $("csv-btn").addEventListener("click", () => {
    if (!lastSonuc) return;
    const o = lastSonuc.ozellikler || {};
    const header = "no,lat,lon\n";
    const rows = lastSonuc.koordinatlar
      .map((k, i) => `${i + 1},${k.lat.toFixed(6)},${k.lon.toFixed(6)}`)
      .join("\n");
    const blob = new Blob([header + rows + "\n"], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `parsel_${o.ada || "x"}_${o.parsel || "x"}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  });

  // --- Analiz (hava + toprak) ---------------------------------------------

  const havaCard = $("hava-card");
  const havaLoading = $("hava-loading");
  const havaContent = $("hava-content");
  const havaError = $("hava-error");
  const havaStatus = $("hava-status");
  const havaTahminEl = $("hava-tahmin");
  const havaNormalBody = $("hava-normal-body");

  const toprakCard = $("toprak-card");
  const toprakLoading = $("toprak-loading");
  const toprakContent = $("toprak-content");
  const toprakError = $("toprak-error");
  const toprakStatus = $("toprak-status");
  const toprakKatmanBody = $("toprak-katman-body");

  // Hava içeriği altındaki "Toprak verisine geç" butonu.
  const havaToToprakBtn = $("hava-to-toprak");
  const havaToToprakLabel = $("hava-to-toprak-label");
  const havaToToprakSpin = $("hava-to-toprak-spin");
  const havaToToprakArrow = $("hava-to-toprak-arrow");
  havaToToprakBtn.addEventListener("click", () => {
    if (!ktBtn.toprak.disabled) setKesifTab("toprak");
  });
  function setHavaToToprak(state) {
    // "loading" → toprak yükleniyor (buton pasif, spinner); "ready" → tıklanabilir.
    const loading = state === "loading";
    havaToToprakBtn.disabled = loading;
    havaToToprakSpin.classList.toggle("hidden", !loading);
    havaToToprakArrow.classList.toggle("hidden", loading);
    havaToToprakLabel.textContent = loading
      ? window.I18n.t("results.weather.to_soil_loading")
      : window.I18n.t("results.weather.to_soil");
  }

  // Not: bu dizilere doğrudan erişmek yerine ayKisa()/gunKisa() kullanın —
  // i18n hazır olmadan çağrılırsa (henüz init olmadıysa) tr'ye düşer.
  function ayKisa() {
    const v = window.I18n.t("date.months_short", { returnObjects: true });
    return Array.isArray(v) && v.length === 12 && v[0]
      ? v
      : ["Oca","Şub","Mar","Nis","May","Haz","Tem","Ağu","Eyl","Eki","Kas","Ara"];
  }
  function gunKisa() {
    const v = window.I18n.t("date.days_short", { returnObjects: true });
    return Array.isArray(v) && v.length === 7 && v[0]
      ? v
      : ["Paz","Pzt","Sal","Çar","Per","Cum","Cmt"];
  }

  function clearAnaliz() {
    for (const el of [havaCard, toprakCard, havaLoading, toprakLoading,
                      havaContent, toprakContent, havaError, toprakError]) {
      el.classList.add("hidden");
    }
    havaStatus.textContent = "";
    toprakStatus.textContent = "";
    havaDone = false;
    toprakDone = false;
    lastHava = null;
    lastToprak = null;
    openRaporBtn.disabled = true;
    // Hava→Toprak butonunu başlangıç durumuna al (pasif, varsayılan etiket).
    havaToToprakBtn.disabled = true;
    havaToToprakSpin.classList.add("hidden");
    havaToToprakArrow.classList.remove("hidden");
    havaToToprakLabel.textContent = window.I18n.t("results.weather.to_soil");
    resetKesifTabs();
  }

  function showAnalizCard(which, statusText) {
    const card    = which === "hava" ? havaCard    : toprakCard;
    const loading = which === "hava" ? havaLoading : toprakLoading;
    const status  = which === "hava" ? havaStatus  : toprakStatus;
    const errEl   = which === "hava" ? havaError   : toprakError;
    const content = which === "hava" ? havaContent : toprakContent;
    card.classList.remove("hidden");
    loading.classList.remove("hidden");
    errEl.classList.add("hidden");
    content.classList.add("hidden");
    status.textContent = statusText || "";
  }

  function setAnalizError(which, msg) {
    const loading = which === "hava" ? havaLoading : toprakLoading;
    const errEl   = which === "hava" ? havaError   : toprakError;
    loading.classList.add("hidden");
    errEl.classList.remove("hidden");
    errEl.textContent = msg;
  }

  async function runAnaliz(lat, lon) {
    // Sıralı: önce hava kartı dolar, sonra toprak kartı tetiklenir.
    const lat6 = lat.toFixed(6), lon6 = lon.toFixed(6);
    showAnalizCard("hava", `${lat6}, ${lon6}`);
    setKesifTabState("hava", "busy");
    try {
      const hava = await fetchJson(`/api/analiz/hava?lat=${lat6}&lon=${lon6}`);
      renderHava(hava);
      havaDone = true;
      setKesifTabState("hava", "done");
    } catch (e) {
      setAnalizError("hava", `${window.I18n.t("results.weather.fetch_failed")}: ${e.message}`);
      setKesifTabState("hava", "none");
      return;
    }

    showAnalizCard("toprak", `${lat6}, ${lon6}`);
    ktBtn.toprak.disabled = false;
    setKesifTabState("toprak", "busy");
    setHavaToToprak("loading");  // hava bitti, toprak yükleniyor: buton spinner'lı pasif
    try {
      const toprak = await fetchJson(`/api/analiz/toprak?lat=${lat6}&lon=${lon6}`);
      renderToprak(toprak);
      toprakDone = true;
      setKesifTabState("toprak", "done");
      setHavaToToprak("ready");  // toprak hazır: butonla geçilebilir
    } catch (e) {
      setAnalizError("toprak", `${window.I18n.t("results.soil.fetch_failed")}: ${e.message}`);
      setKesifTabState("toprak", "none");
      setHavaToToprak("ready");  // hata olsa da sekme açık; kullanıcı geçebilsin
      return;
    }

    if (havaDone && toprakDone) {
      openRaporBtn.disabled = false;
    }
  }

  function renderHava(hava) {
    lastHava = hava;
    havaTahminEl.innerHTML = "";
    for (const g of hava.tahmin) {
      const d = new Date(g.tarih + "T00:00:00");
      const card = document.createElement("div");
      card.className = "border rounded p-2 text-center text-xs space-y-0.5 bg-slate-50";
      card.innerHTML = `
        <div class="font-medium text-slate-700">${gunKisa()[d.getDay()]}, ${d.getDate()} ${ayKisa()[d.getMonth()]}</div>
        <div>
          <span class="text-red-600 font-semibold">${Math.round(g.sicaklik_max)}°</span>
          <span class="text-slate-400 mx-0.5">/</span>
          <span class="text-blue-600">${Math.round(g.sicaklik_min)}°</span>
        </div>
        <div class="text-blue-700">${g.yagis_mm.toFixed(1)} mm</div>
        ${g.et0_mm != null ? `<div class="text-slate-500">ET0: ${g.et0_mm.toFixed(1)}</div>` : ""}
      `;
      havaTahminEl.appendChild(card);
    }
    havaNormalBody.innerHTML = "";
    for (const m of hava.iklim_normali) {
      const tr = document.createElement("tr");
      tr.className = m.ay % 2 ? "bg-white" : "bg-slate-50";
      tr.innerHTML = `
        <td class="px-2 py-1 font-medium">${ayKisa()[m.ay - 1]}</td>
        <td class="px-2 py-1 font-mono">${m.sicaklik_ort.toFixed(1)}</td>
        <td class="px-2 py-1 font-mono">${m.yagis_top.toFixed(1)}</td>
      `;
      havaNormalBody.appendChild(tr);
    }
    havaLoading.classList.add("hidden");
    havaContent.classList.remove("hidden");
  }

  function renderToprak(toprak) {
    lastToprak = toprak;
    const y = toprak.yukseklik || {};
    $("t-rakim").textContent = y.rakim_m != null ? `${Math.round(y.rakim_m)} m` : "—";
    $("t-egim").textContent  = y.egim_derece != null ? `${y.egim_derece.toFixed(1)}°` : "—";
    const ok = $("t-baki-ok");
    if (y.baki_yon) {
      $("t-baki").textContent = `${y.baki_yon} (${Math.round(y.baki_derece)}°)`;
      ok.classList.remove("hidden");
      ok.style.transform = `rotate(${y.baki_derece}deg)`;
    } else {
      $("t-baki").textContent = window.I18n.t("results.soil.flat");
      ok.classList.add("hidden");
    }
    toprakKatmanBody.innerHTML = "";
    const fmt = (v, d = 1) => (v == null ? "—" : v.toFixed(d));
    for (const k of toprak.katmanlar) {
      const tr = document.createElement("tr");
      tr.className = "bg-white";
      tr.innerHTML = `
        <td class="px-2 py-1 font-medium">${k.derinlik}</td>
        <td class="px-2 py-1 font-mono">${fmt(k.ph, 1)}</td>
        <td class="px-2 py-1 font-mono">${fmt(k.kum_pct, 1)}</td>
        <td class="px-2 py-1 font-mono">${fmt(k.kil_pct, 1)}</td>
        <td class="px-2 py-1 font-mono">${fmt(k.silt_pct, 1)}</td>
        <td class="px-2 py-1 font-mono">${fmt(k.organik_karbon_pct, 2)}</td>
        <td class="px-2 py-1 font-mono">${fmt(k.yogunluk, 2)}</td>
      `;
      toprakKatmanBody.appendChild(tr);
    }
    toprakLoading.classList.add("hidden");
    toprakContent.classList.remove("hidden");
  }

  // --- Analiz tetikleyici butonu -----------------------------------------

  const analizBtn = $("analiz-btn");
  analizBtn.addEventListener("click", () => {
    if (!lastCentroid) return setAlert(window.I18n.t("results.summary.query_first"));
    setAlert("");
    clearAnaliz();
    clearRapor();
    analizBtn.disabled = true;
    // Hava verisi yüklenirken kullanıcı ilerlemeyi görsün diye Hava sekmesine geç.
    ktBtn.hava.disabled = false;
    setKesifTab("hava");
    runAnaliz(lastCentroid.lat, lastCentroid.lon).finally(() => {
      analizBtn.disabled = false;
    });
  });

  // --- AI Rapor ----------------------------------------------------------

  const raporBtn = $("rapor-btn");
  const raporSpinner = $("rapor-spinner");
  const raporBtnLabel = $("rapor-btn-label");
  const raporCard = $("rapor-card");
  const raporContent = $("rapor-content");
  const raporInfografik = $("rapor-infografik");
  const raporError = $("rapor-error");
  const raporStatus = $("rapor-status");
  const raporAdimlar = $("rapor-adimlar");
  const raporToSohbetWrap = $("rapor-to-sohbet-wrap");
  const raporAksiyonWrap = $("rapor-aksiyon-wrap");
  const pdfIndirBtn = $("pdf-indir");

  // Eldeki parsel bilgisini kiraya-ver / ekim-yardım formlarına taşıyacak query string.
  // TKGM parsel yanıtı il/ilçe/mahalle adlarını her zaman döndürmediğinden, önce
  // ozellikler'e bakar, yoksa kullanıcının seçtiği dropdown adlarına/girdiği ada-parsele düşer.
  function buildTarlaParams() {
    const o = (lastSonuc && lastSonuc.ozellikler) || {};
    const p = new URLSearchParams();
    const ekle = (k, v) => { if (v != null && String(v).trim() !== "") p.set(k, String(v)); };
    // Seçili dropdown option'ının görünen metni (placeholder seçiliyse null).
    const secimAdi = (el) => {
      const opt = el && el.selectedOptions && el.selectedOptions[0];
      return opt && opt.value !== "" ? opt.text : null;
    };
    ekle("il", o.il || secimAdi(ilSel));
    ekle("ilce", o.ilce || secimAdi(ilceSel));
    ekle("mahalle", o.mahalle || secimAdi(mahSel));
    ekle("ada", o.ada != null ? o.ada : ((lastQuery && lastQuery.ada) || adaInp.value.trim()));
    ekle("parsel", o.parsel != null ? o.parsel : ((lastQuery && lastQuery.parsel) || parselInp.value.trim()));
    ekle("alan_m2", o.yuzolcumu);
    return p.toString();
  }
  $("rapor-kiraya-ver").addEventListener("click", () => {
    location.href = "/kiralama.html?" + buildTarlaParams();
  });
  $("rapor-ekim-yardim").addEventListener("click", () => {
    location.href = "/tarlama-yardim.html?" + buildTarlaParams();
  });

  // Rapor infografiği — LLM'den bağımsız, gerçek hava/toprak JSON'ından SVG çizer.
  function igKart(baslik, svg, genis = false) {
    if (!svg) return "";
    return `<div class="ig-card${genis ? " sm:col-span-2" : ""}">
      <div class="ig-baslik">${baslik}</div>${svg}</div>`;
  }

  function renderRaporInfografik() {
    raporInfografik.innerHTML = "";
    raporInfografik.classList.add("hidden");
    if (!window.Charts || (!lastHava && !lastToprak)) return;
    const ust = lastToprak && Array.isArray(lastToprak.katmanlar) ? lastToprak.katmanlar[0] : null;
    const kartlar = [
      igKart(window.I18n.t("report.infographic.climate_normal"), lastHava && Charts.iklimDiyagrami(lastHava.iklim_normali), true),
      igKart(window.I18n.t("report.infographic.texture_triangle"), ust && Charts.teksturUcgeni(ust)),
      igKart(window.I18n.t("report.infographic.soil_composition"), lastToprak && Charts.toprakKompozisyon(lastToprak.katmanlar)),
      igKart(window.I18n.t("report.infographic.topography"), lastToprak && Charts.topografyaKart(lastToprak.yukseklik), true),
    ].filter(Boolean);
    if (!kartlar.length) return;
    raporInfografik.innerHTML = kartlar.join("");
    raporInfografik.classList.remove("hidden");
  }

  function clearRapor() {
    raporCard.classList.add("hidden");
    raporInfografik.innerHTML = "";
    raporInfografik.classList.add("hidden");
    raporContent.innerHTML = "";
    raporError.classList.add("hidden");
    raporStatus.textContent = "";
    raporAdimlar.innerHTML = "";
    raporAdimlar.classList.add("hidden");
    raporBtnLabel.textContent = window.I18n.t("report.generate");
    raporToSohbetWrap.classList.add("hidden");
    raporAksiyonWrap.classList.add("hidden");
    pdfIndirBtn.disabled = true;
    setRaporTabState("none");
    rtBtn.sohbet.disabled = true;
    setRaporTab("rapor");
    clearSohbet();
  }

  function adimEkle(text, kind = "info") {
    const li = document.createElement("li");
    const renk = { call: "text-emerald-700", result: "text-slate-600", info: "text-slate-500", err: "text-red-600" }[kind];
    li.className = renk;
    li.textContent = text;
    raporAdimlar.appendChild(li);
    raporAdimlar.classList.remove("hidden");
    raporAdimlar.scrollTop = raporAdimlar.scrollHeight;
  }

  function fmtArgs(args) {
    if (!args || typeof args !== "object") return "";
    return Object.entries(args).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ");
  }

  raporBtn.addEventListener("click", async () => {
    if (!lastQuery) return;
    clearRapor();
    raporCard.classList.remove("hidden");
    raporStatus.textContent = window.I18n.t("report.agent_running");
    raporSpinner.classList.remove("hidden");
    raporBtnLabel.textContent = window.I18n.t("report.generating");
    raporBtn.disabled = true;
    setRaporTabState("busy");
    try {
      const r = await fetch("/api/rapor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...lastQuery, model: selectedModel() }),
      });
      if (!r.ok) {
        let detail = `HTTP ${r.status}`;
        try { const b = await r.json(); if (b.detail) detail = b.detail; } catch (_) {}
        if (r.status === 401) {
          window.Auth.setLoggedOut();
          window.Auth.openModal("giris");
          window.Auth.setAlert(window.I18n.t("auth.session_expired"), "info");
        }
        throw new Error(detail);
      }

      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let stoppedByErr = false;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let ev;
          try { ev = JSON.parse(line); } catch (_) { continue; }
          if (ev.tip === "baslangic") {
            raporStatus.textContent = ev.model || "";
            adimEkle(window.I18n.t("report.step_started"), "info");
          } else if (ev.tip === "tool_call") {
            adimEkle(`  → ${ev.ad}(${fmtArgs(ev.args)})`, "call");
          } else if (ev.tip === "tool_result") {
            adimEkle(`  ← ${ev.ad}: ${ev.ozet}`, "result");
          } else if (ev.tip === "rapor") {
            adimEkle(window.I18n.t("report.step_ready"), "info");
            raporIcerik = ev.icerik || "";
            raporContent.innerHTML = marked.parse(raporIcerik);
            renderRaporInfografik();
          } else if (ev.tip === "ozet") {
            adimEkle(`• ${ev.llm_call_sayisi} LLM çağrı · ${ev.sure_ms} ms · ${ev.input_tokens}↑/${ev.output_tokens}↓ tok · ${ev.tps} t/s`, "info");
          } else if (ev.tip === "bitti") {
            raporStatus.textContent = ev.model || raporStatus.textContent;
          } else if (ev.tip === "hata") {
            stoppedByErr = true;
            raporError.textContent = `${window.I18n.t("report.generation_failed")}: ${ev.mesaj}`;
            raporError.classList.remove("hidden");
          }
        }
      }
      if (!stoppedByErr && !raporContent.innerHTML) {
        throw new Error(window.I18n.t("report.empty_response"));
      }
      if (!stoppedByErr && raporIcerik) {
        rtBtn.sohbet.disabled = false;
        setRaporTabState("done");
        raporToSohbetWrap.classList.remove("hidden");  // sohbete geçiş butonunu göster
        raporAksiyonWrap.classList.remove("hidden");   // kiraya ver / ekim yardım butonları
        pdfIndirBtn.disabled = false;                  // PDF indir butonunu aktifleştir
      } else {
        setRaporTabState("none");
      }
    } catch (e) {
      raporError.textContent = `${window.I18n.t("report.generation_failed")}: ${e.message}`;
      raporError.classList.remove("hidden");
      setRaporTabState("none");
    } finally {
      raporSpinner.classList.add("hidden");
      raporBtnLabel.textContent = window.I18n.t("report.generate");
      raporBtn.disabled = false;
    }
  });

  // --- PDF indir ---------------------------------------------------------
  // Markalı yazdırma belgesi kurup tarayıcının PDF motoruna veriyoruz:
  // SVG infografikler + Türkçe karakterler vektörel/temiz çıkar, site renkleri korunur.

  const PDF_LOGO = `<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2"
       stroke-linecap="round" stroke-linejoin="round" width="26" height="26">
    <path d="M7 20h10"/><path d="M10 20c5.5-2.5.8-6.4 3-10"/>
    <path d="M9.5 9.4c1.1.8 1.8 2.2 2.3 3.7-2 .4-3.5.4-4.8-.3-1.2-.6-2.3-1.9-3-4.2 2.8-.5 4.4 0 5.5.8z"/>
    <path d="M14.1 6a7 7 0 0 0-1.1 4c1.9-.1 3.3-.6 4.3-1.4 1-1 1.6-2.3 1.7-4.6-2.7.1-4 1-4.9 2z"/>
  </svg>`;

  function pdfDosyaAdi(o) {
    const parca = ["Ne_Yetisir_Rapor", o.ada && `Ada${o.ada}`, o.parsel && `Parsel${o.parsel}`]
      .filter(Boolean).join("_");
    return parca || "Ne_Yetisir_Rapor";
  }

  function buildRaporPdfHtml() {
    const o = (lastSonuc && lastSonuc.ozellikler) || {};
    const konum = [o.il, o.ilce, o.mahalle].filter(Boolean).join(" / ") || "—";
    const adaParsel = [o.ada && `Ada ${o.ada}`, o.parsel && `Parsel ${o.parsel}`].filter(Boolean).join(" · ");
    const tarih = new Date().toLocaleDateString("tr-TR", { day: "numeric", month: "long", year: "numeric" });
    const yuz = o.yuzolcumu != null ? `${o.yuzolcumu.toLocaleString("tr-TR")} m²` : null;
    const infografik = raporInfografik.innerHTML && !raporInfografik.classList.contains("hidden")
      ? raporInfografik.innerHTML : "";
    const baslik = pdfDosyaAdi(o);

    // Ada/parsel kalın; ardından yüzölçüm/nitelik/mevki detayları.
    const detaylar = [yuz, o.nitelik, o.mevki && `${o.mevki} mevkii`].filter(Boolean).join(" · ");
    const konumKutu = (adaParsel || detaylar)
      ? `<div class="pdf-konum"><span class="ap">${escapeHtml(adaParsel)}</span>${
          adaParsel && detaylar ? " · " : ""}${escapeHtml(detaylar)}</div>`
      : "";

    return `<!DOCTYPE html><html lang="tr"><head><meta charset="UTF-8"><title>${baslik}</title>
<style>
  @page { size: A4; margin: 14mm 15mm 16mm; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
         color: #1f2937; font-size: 11pt; line-height: 1.55; }

  .pdf-head { display: flex; align-items: center; justify-content: space-between; gap: 16px;
    background: linear-gradient(120deg, #5fae5f, #4d9a51 55%, #2e6b32);
    color: #fff; border-radius: 12px; padding: 16px 20px; margin-bottom: 18px; }
  .pdf-brand { display: flex; align-items: center; gap: 12px; }
  .pdf-logo { display: grid; place-items: center; height: 44px; width: 44px;
    background: rgba(255,255,255,.18); border: 1px solid rgba(255,255,255,.35); border-radius: 12px; }
  .pdf-mark { font-size: 19pt; font-weight: 800; line-height: 1; }
  .pdf-sub { font-size: 9pt; opacity: .9; margin-top: 3px; }
  .pdf-meta { text-align: right; font-size: 9pt; line-height: 1.5; }
  .pdf-meta .k { font-weight: 700; font-size: 11pt; }

  .pdf-konum { background: #e8f3e6; border: 1px solid #cfe6cb; border-radius: 10px;
    padding: 10px 14px; margin-bottom: 18px; font-size: 9.5pt; color: #2e6b32; }
  .pdf-konum .ap { font-weight: 700; }

  .pdf-ig { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 18px; }
  .pdf-ig .ig-card { break-inside: avoid; background: #fff; border: 1px solid #e5e7eb;
    border-radius: 10px; padding: 8px 10px 6px; }
  .pdf-ig .ig-card.sm\\:col-span-2 { grid-column: span 2; }
  .pdf-ig .ig-baslik { font-size: 9pt; font-weight: 700; color: #2e6b32; margin-bottom: 4px; }
  .pdf-ig svg { display: block; width: 100%; height: auto; }

  .pdf-body { max-width: 100%; }
  .pdf-body > :first-child { margin-top: 0; }
  .pdf-body h1 { font-size: 16pt; font-weight: 700; margin: 1.1em 0 .4em; color: #2e6b32; }
  .pdf-body h2 { font-size: 13.5pt; font-weight: 700; margin: 1.1em 0 .35em; color: #2e6b32;
    border-bottom: 1px solid #e5e7eb; padding-bottom: .2em; break-after: avoid; }
  .pdf-body h3 { font-size: 11.5pt; font-weight: 600; margin: .9em 0 .25em; color: #374151; break-after: avoid; }
  .pdf-body p { margin: .5em 0; }
  .pdf-body ul { list-style: disc; margin: .4em 0; padding-left: 1.3em; }
  .pdf-body ol { list-style: decimal; margin: .4em 0; padding-left: 1.3em; }
  .pdf-body li { margin: .25em 0; }
  .pdf-body strong { font-weight: 700; color: #111827; }
  .pdf-body blockquote { border-left: 3px solid #bbf7d0; padding-left: .8em; color: #4b5563; margin: .7em 0; }
  .pdf-body table { width: 100%; border-collapse: collapse; margin: .8em 0; font-size: 9.5pt; break-inside: avoid; }
  .pdf-body th, .pdf-body td { border: 1px solid #e5e7eb; padding: .4em .55em; text-align: left; }
  .pdf-body th { background: #f1f5f9; font-weight: 600; }
  .pdf-body hr { border: 0; border-top: 1px solid #e5e7eb; margin: 1em 0; }

  .pdf-foot { margin-top: 22px; padding-top: 10px; border-top: 1px solid #e5e7eb;
    font-size: 7.5pt; color: #94a3b8; line-height: 1.5; }
</style></head><body>
  <div class="pdf-head">
    <div class="pdf-brand">
      <span class="pdf-logo">${PDF_LOGO}</span>
      <div><div class="pdf-mark">Ne Yetişir?</div>
        <div class="pdf-sub">${window.I18n.t("report.pdf.subtitle")}</div></div>
    </div>
    <div class="pdf-meta"><div class="k">${konum}</div><div>${tarih}</div></div>
  </div>
  ${konumKutu}
  ${infografik ? `<div class="pdf-ig">${infografik}</div>` : ""}
  <div class="pdf-body">${raporContent.innerHTML}</div>
  <div class="pdf-foot">${window.I18n.t("report.pdf.disclaimer")}</div>
</body></html>`;
  }

  function indirRaporPdf() {
    if (pdfIndirBtn.disabled || !raporContent.innerHTML) return;
    const html = buildRaporPdfHtml();
    const iframe = document.createElement("iframe");
    iframe.style.position = "fixed";
    iframe.style.right = "0";
    iframe.style.bottom = "0";
    iframe.style.width = "0";
    iframe.style.height = "0";
    iframe.style.border = "0";
    document.body.appendChild(iframe);

    const cleanup = () => { setTimeout(() => iframe.remove(), 500); };
    const doc = iframe.contentWindow.document;
    doc.open();
    doc.write(html);
    doc.close();

    // İçerik (SVG/font) yerleşsin diye bir frame bekleyip yazdır.
    const printNow = () => {
      try {
        iframe.contentWindow.focus();
        iframe.contentWindow.onafterprint = cleanup;
        iframe.contentWindow.print();
      } catch (_) { cleanup(); }
    };
    if (iframe.contentWindow.document.readyState === "complete") {
      requestAnimationFrame(() => requestAnimationFrame(printNow));
    } else {
      iframe.onload = () => requestAnimationFrame(printNow);
    }
  }

  pdfIndirBtn.addEventListener("click", indirRaporPdf);

  // --- Sohbet ------------------------------------------------------------

  const sohbetStatus = $("sohbet-status");
  const sohbetMesajlar = $("sohbet-mesajlar");
  const sohbetForm = $("sohbet-form");
  const sohbetInput = $("sohbet-input");
  const sohbetGonder = $("sohbet-gonder");

  let raporIcerik = null;
  let chatGecmis = [];
  const sohbetIlkBilgi = sohbetMesajlar.innerHTML;

  function clearSohbet() {
    sohbetMesajlar.innerHTML = sohbetIlkBilgi;
    sohbetStatus.textContent = "";
    sohbetInput.value = "";
    sohbetGonder.disabled = false;
    raporIcerik = null;
    chatGecmis = [];
  }

  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function addBubble(rol, icerik) {
    const wrap = document.createElement("div");
    wrap.className = "flex " + (rol === "user" ? "justify-end" : "justify-start");
    const bubble = document.createElement("div");
    if (rol === "user") {
      bubble.className = "max-w-[80%] bg-emerald-600 text-white rounded-lg px-3 py-2 text-sm whitespace-pre-wrap";
      bubble.innerHTML = escapeHtml(icerik);
    } else {
      bubble.className = "max-w-[85%] bg-white border rounded-lg px-3 py-2 prose prose-sm max-w-none";
      bubble.innerHTML = marked.parse(icerik);
    }
    wrap.appendChild(bubble);
    sohbetMesajlar.appendChild(wrap);
    sohbetMesajlar.scrollTop = sohbetMesajlar.scrollHeight;
    return bubble;
  }

  sohbetForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const mesaj = sohbetInput.value.trim();
    if (!mesaj) return;
    if (!window.Auth.user) {
      window.Auth.openModal("giris");
      window.Auth.setAlert(window.I18n.t("report.chat.login_required"), "info");
      return;
    }
    if (!raporIcerik || !lastQuery) {
      sohbetStatus.textContent = window.I18n.t("report.chat.generate_report_first");
      return;
    }

    addBubble("user", mesaj);
    sohbetInput.value = "";
    sohbetGonder.disabled = true;
    sohbetInput.disabled = true;
    sohbetStatus.textContent = window.I18n.t("report.chat.typing");
    const aiBubble = addBubble("assistant", `_${window.I18n.t("report.chat.typing")}_`);

    let yanit = "";
    let stoppedByErr = false;
    try {
      const r = await fetch("/api/sohbet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...lastQuery,
          rapor: raporIcerik,
          gecmis: chatGecmis,
          mesaj,
          model: selectedModel(),
        }),
      });
      if (!r.ok) {
        let detail = `HTTP ${r.status}`;
        try { const b = await r.json(); if (b.detail) detail = b.detail; } catch (_) {}
        if (r.status === 401) {
          window.Auth.setLoggedOut();
          window.Auth.openModal("giris");
          window.Auth.setAlert(window.I18n.t("auth.session_expired"), "info");
        }
        throw new Error(detail);
      }

      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let ev;
          try { ev = JSON.parse(line); } catch (_) { continue; }
          if (ev.tip === "baslangic") {
            sohbetStatus.textContent = ev.model || "";
          } else if (ev.tip === "tool_call") {
            sohbetStatus.textContent = `→ ${ev.ad}`;
          } else if (ev.tip === "tool_result") {
            sohbetStatus.textContent = `← ${ev.ad}`;
          } else if (ev.tip === "yanit") {
            yanit = ev.icerik || "";
            aiBubble.innerHTML = marked.parse(yanit);
            sohbetMesajlar.scrollTop = sohbetMesajlar.scrollHeight;
          } else if (ev.tip === "ozet") {
            sohbetStatus.textContent =
              `${ev.llm_call_sayisi} çağrı · ${ev.sure_ms} ms · ${ev.input_tokens}↑/${ev.output_tokens}↓ tok · ${ev.tps} t/s`;
          } else if (ev.tip === "bitti") {
            // status zaten ozet'ten dolmuş olabilir
          } else if (ev.tip === "hata") {
            stoppedByErr = true;
            aiBubble.innerHTML = `<p class="text-red-600 m-0">${window.I18n.t("report.chat.error_prefix")}: ${escapeHtml(ev.mesaj || "")}</p>`;
            sohbetStatus.textContent = window.I18n.t("report.chat.error_status");
          }
        }
      }
      if (!stoppedByErr && !yanit) {
        aiBubble.innerHTML = `<p class="text-red-600 m-0">${window.I18n.t("report.chat.empty_response")}</p>`;
      }
      if (!stoppedByErr && yanit) {
        chatGecmis.push({ rol: "user", icerik: mesaj });
        chatGecmis.push({ rol: "assistant", icerik: yanit });
      }
    } catch (err) {
      aiBubble.innerHTML = `<p class="text-red-600 m-0">${window.I18n.t("report.chat.error_prefix")}: ${escapeHtml(err.message)}</p>`;
      sohbetStatus.textContent = window.I18n.t("report.chat.error_status");
    } finally {
      sohbetGonder.disabled = false;
      sohbetInput.disabled = false;
      sohbetInput.focus();
    }
  });

  // --- Model seçici -------------------------------------------------------

  const modelSelect = $("model-select");

  function selectedModel() {
    return modelSelect.value || null;
  }

  async function loadModeller() {
    try {
      const data = await fetchJson("/api/modeller");
      const varsayilan = data.varsayilan;
      const liste = Array.isArray(data.modeller) ? [...data.modeller] : [];
      // Varsayılan listede yoksa başa ekle (kullanıcı .env'deki seçimi de görebilsin).
      if (varsayilan && !liste.includes(varsayilan)) liste.unshift(varsayilan);
      modelSelect.innerHTML = "";
      for (const id of liste) {
        const opt = document.createElement("option");
        opt.value = id;
        opt.textContent = id === varsayilan ? `${id}${window.I18n.t("report.model_default_suffix")}` : id;
        if (id === varsayilan) opt.selected = true;
        modelSelect.appendChild(opt);
      }
    } catch (e) {
      modelSelect.innerHTML = "";
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = window.I18n.t("report.model_load_error");
      modelSelect.appendChild(opt);
    }
  }

  // --- Hoş geldin popup ---------------------------------------------------

  const hgModal = $("hosgeldin-modal");
  const hgCard = $("hosgeldin-card");
  function openHosgeldin() {
    hgModal.classList.remove("hidden");
    requestAnimationFrame(() => hgCard.classList.remove("scale-95", "opacity-0"));
  }
  // Popup, kullanıcı çarpıya basana kadar her açılışta (yenileme dahil) gösterilir.
  // Yalnızca X'e basınca oturum boyunca bir daha açılmaz.
  function maybeOpenHosgeldin() {
    try {
      if (sessionStorage.getItem("hosgeldin_kapatildi")) return;
    } catch (e) {
      // sessionStorage erişilemezse (gizli mod vb.) yine de göster.
    }
    openHosgeldin();
  }
  function hideHosgeldin() {
    hgCard.classList.add("scale-95", "opacity-0");
    setTimeout(() => hgModal.classList.add("hidden"), 200);
  }
  // Çarpıya basınca: bir daha (yenilemede dahil) oturum boyunca açılmaz.
  function closeHosgeldin() {
    try { sessionStorage.setItem("hosgeldin_kapatildi", "1"); } catch (e) {}
    hideHosgeldin();
  }
  // Boş alana tıklayınca: sadece o an kapanır, sessionStorage'a yazılmaz —
  // sayfa yenilenince popup tekrar gösterilir.
  function dismissHosgeldin() {
    hideHosgeldin();
  }
  $("hosgeldin-close").addEventListener("click", closeHosgeldin);
  // Kartı ortalayan sarmalayıcı tüm ekranı kapladığı için tıklamalar önce ona
  // düşer; kartın kendisine değil de bu sarmalayıcıya (boş alana) tıklandıysa kapat.
  $("hosgeldin-overlay").addEventListener("click", (e) => {
    if (e.target.id === "hosgeldin-overlay") dismissHosgeldin();
  });
  // "Tarlaları İncele" → herkese açık kiralık tarlalar sayfası.
  $("hosgeldin-cta").addEventListener("click", () => { location.href = "/kiralik.html"; });
  // "Başvuru Yap" → anonim çiftçi başvuru formu.
  $("hosgeldin-basvuru").addEventListener("click", () => { location.href = "/ciftcimiz-ol.html"; });
  // "Tarlanızı kiraya mı vermek istiyorsunuz?" → anonim kiraya verme formu.
  $("hosgeldin-kiralayan").addEventListener("click", () => { location.href = "/kiralama.html"; });

  // --- Boot ---------------------------------------------------------------

  loadIller();
  loadModeller();
  maybeOpenHosgeldin();
})();
