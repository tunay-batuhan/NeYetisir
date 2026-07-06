// Admin paneli — giriş + kiralık tarla başvuru/ilan yönetimi.
(() => {
  const $ = (id) => document.getElementById(id);

  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );

  // Kiraya-ver / ekim-yardım formlarındaki ortak "tarla anketi" alanlarını
  // tek bir okunabilir satıra (ör. "Ağaç: Evet · Taş: Hayır · ...") çevirir.
  function tarlaSurveyOzeti(t) {
    const eh = (v) => (v === "evet" ? "Evet" : v === "hayır" ? "Hayır" : null);
    return [
      t.agac_var ? `Ağaç: ${eh(t.agac_var)}` : null,
      t.tas_var ? `Taş: ${eh(t.tas_var)}` : null,
      t.son_urun ? `Son ürün: ${t.son_urun}` : null,
      t.kimyasal_gubre_var
        ? `Kimyasal/Gübre: ${eh(t.kimyasal_gubre_var)}${t.kimyasal_gubre_aciklama ? ` (${t.kimyasal_gubre_aciklama})` : ""}`
        : null,
      t.su_kaynagina_uzaklik_km != null ? `Su kaynağı: ${t.su_kaynagina_uzaklik_km} km` : null,
    ].filter(Boolean).join(" · ");
  }

  let aktifFiltre = ""; // "" = hepsi
  let aktifFiltreCiftci = ""; // çiftçi sekmesi filtresi
  let ciftciYuklendi = false; // çiftçi tablosu lazy-load edildi mi
  let aktifFiltreTalep = ""; // kiralama talebi sekmesi filtresi
  let talepYuklendi = false; // talep tablosu lazy-load edildi mi
  let aktifFiltreEkim = ""; // ekim yardımı sekmesi filtresi
  let ekimYuklendi = false; // ekim yardımı tablosu lazy-load edildi mi

  // --- API yardımcısı ------------------------------------------------------
  async function api(url, opts = {}) {
    const r = await fetch(url, { credentials: "same-origin", ...opts });
    if (r.status === 401) {
      // Oturum düştü → giriş ekranına dön.
      showLogin();
      throw new Error("Oturum gerekli.");
    }
    if (!r.ok) {
      let detail = `HTTP ${r.status}`;
      try {
        const j = await r.json();
        if (j && j.detail) detail = Array.isArray(j.detail) ? (j.detail[0]?.msg || detail) : j.detail;
      } catch (_) {}
      throw new Error(detail);
    }
    return r.status === 204 ? null : r.json();
  }

  // --- Görünüm geçişleri ---------------------------------------------------
  function showLogin() {
    $("login-view").classList.remove("hidden");
    $("dash-view").classList.add("hidden");
    $("admin-durum").classList.add("hidden");
    $("admin-durum").classList.remove("flex");
  }
  function showDash(kullanici) {
    $("login-view").classList.add("hidden");
    $("dash-view").classList.remove("hidden");
    $("admin-durum").classList.remove("hidden");
    $("admin-durum").classList.add("flex");
    $("admin-kullanici").textContent = kullanici;
    renderFiltre();
    renderFiltreCiftci();
    renderFiltreTalep();
    renderFiltreEkim();
    ciftciYuklendi = false;
    talepYuklendi = false;
    ekimYuklendi = false;
    switchTab("tarlalar");
    yukleTablo();
  }

  // --- Sekme geçişi --------------------------------------------------------
  function switchTab(tab) {
    ["tarlalar", "talepler", "ciftciler", "ekim"].forEach((t) => {
      $("content-" + t).classList.toggle("hidden", t !== tab);
      const aktif = t === tab;
      $("tab-" + t).className = `-mb-px border-b-2 px-4 py-2.5 text-sm ${aktif ? "border-brand font-semibold text-slate-800" : "border-transparent font-medium text-slate-500 hover:text-slate-700"}`;
    });
    if (tab === "ciftciler" && !ciftciYuklendi) { ciftciYuklendi = true; yukleTabloCiftci(); }
    if (tab === "talepler" && !talepYuklendi) { talepYuklendi = true; yukleTabloTalep(); }
    if (tab === "ekim" && !ekimYuklendi) { ekimYuklendi = true; yukleTabloEkim(); }
  }

  // --- Giriş ---------------------------------------------------------------
  $("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const alertBox = $("login-alert");
    alertBox.classList.add("hidden");
    const btn = $("l-submit");
    btn.disabled = true;
    try {
      const bilgi = await api("/api/admin/giris", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kullanici: $("l-kullanici").value.trim(), parola: $("l-parola").value }),
      });
      $("login-form").reset();
      showDash(bilgi.kullanici);
    } catch (err) {
      alertBox.textContent = err.message || "Giriş başarısız.";
      alertBox.classList.remove("hidden");
    } finally {
      btn.disabled = false;
    }
  });

  $("btn-cikis").addEventListener("click", async () => {
    try { await api("/api/admin/cikis", { method: "POST" }); } catch (_) {}
    showLogin();
  });

  // --- Filtre çubuğu -------------------------------------------------------
  const FILTRELER = [
    { v: "", l: "Hepsi" },
    { v: "beklemede", l: "Beklemede" },
    { v: "yayinda", l: "Yayında" },
    { v: "reddedildi", l: "Reddedildi" },
  ];
  function renderFiltre() {
    const box = $("filtre");
    box.innerHTML = "";
    FILTRELER.forEach((f) => {
      const b = document.createElement("button");
      const aktif = f.v === aktifFiltre;
      b.className = `rounded-md px-3 py-1 transition ${aktif ? "bg-white font-semibold text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-700"}`;
      b.textContent = f.l;
      b.addEventListener("click", () => { aktifFiltre = f.v; renderFiltre(); yukleTablo(); });
      box.appendChild(b);
    });
  }

  // --- Tablo ---------------------------------------------------------------
  const DURUM_ROZET = {
    "beklemede": "bg-amber-100 text-amber-700",
    "yayinda": "bg-green-100 text-green-700",
    "reddedildi": "bg-red-100 text-red-700",
  };
  const DURUM_ETIKET = { "beklemede": "Beklemede", "yayinda": "Yayında", "reddedildi": "Reddedildi" };

  function aksiyonlar(t) {
    const btns = [];
    if (t.durum !== "yayinda")
      btns.push(`<button data-act="yayinda" data-id="${t.id}" class="rounded-md bg-green-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-green-700">Yayınla</button>`);
    if (t.durum !== "reddedildi")
      btns.push(`<button data-act="reddedildi" data-id="${t.id}" class="rounded-md bg-amber-500 px-2.5 py-1 text-xs font-semibold text-white hover:bg-amber-600">Reddet</button>`);
    btns.push(`<button data-act="sil" data-id="${t.id}" class="rounded-md border border-red-200 px-2.5 py-1 text-xs font-semibold text-red-600 hover:bg-red-50">Sil</button>`);
    return btns.join(" ");
  }

  function satir(t) {
    const konum = [t.il, t.ilce, t.mahalle].filter(Boolean).join(" / ") || "—";
    const ozellik = [
      t.alan_m2 != null ? `${Number(t.alan_m2).toLocaleString("tr-TR")} m²` : null,
      t.egim, t.su_durumu,
    ].filter(Boolean).join(" · ") || "—";
    const survey = tarlaSurveyOzeti(t);
    const tr = document.createElement("tr");
    tr.className = "border-b border-slate-50 align-top";
    tr.innerHTML = `
      <td class="px-4 py-3"><span class="inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${DURUM_ROZET[t.durum] || "bg-slate-100 text-slate-600"}">${esc(DURUM_ETIKET[t.durum] || t.durum)}</span></td>
      <td class="px-4 py-3">
        <div class="text-xs text-slate-400">${esc(konum)}</div>
        <div class="font-medium text-slate-700">Ada ${esc(t.ada)} / Parsel ${esc(t.parsel)}</div>
        ${t.aciklama ? `<div class="mt-0.5 max-w-xs truncate text-xs text-slate-400" title="${esc(t.aciklama)}">${esc(t.aciklama)}</div>` : ""}
      </td>
      <td class="px-4 py-3 text-slate-600">
        <div>${esc(ozellik)}</div>
        ${survey ? `<div class="mt-0.5 max-w-xs truncate text-xs text-slate-400" title="${esc(survey)}">${esc(survey)}</div>` : ""}
      </td>
      <td class="px-4 py-3">
        <div class="font-medium text-slate-700">${esc(t.ad_soyad)}</div>
        <div class="text-xs text-slate-500">${esc(t.telefon)}</div>
        <div class="text-xs text-slate-400">${esc(t.email)}</div>
      </td>
      <td class="px-4 py-3 text-xs text-slate-400">${t.kaynak === "admin" ? "Admin" : "Başvuru"}</td>
      <td class="px-4 py-3"><div class="flex flex-wrap justify-end gap-1.5">${aksiyonlar(t)}</div></td>`;
    return tr;
  }

  async function yukleTablo() {
    const body = $("tablo-body");
    body.innerHTML = "";
    try {
      const url = aktifFiltre ? `/api/admin/tarlalar?durum=${encodeURIComponent(aktifFiltre)}` : "/api/admin/tarlalar";
      const liste = await api(url);
      $("tablo-bos").classList.toggle("hidden", liste.length > 0);
      const frag = document.createDocumentFragment();
      liste.forEach((t) => frag.appendChild(satir(t)));
      body.appendChild(frag);
    } catch (err) {
      // 401 zaten showLogin tetikledi; diğer hatalar sessiz tablo.
    }
  }

  // Tablo aksiyonları (event delegation).
  $("tablo-body").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const id = btn.dataset.id;
    const act = btn.dataset.act;
    btn.disabled = true;
    try {
      if (act === "sil") {
        if (!confirm("Bu kaydı silmek istediğinize emin misiniz?")) { btn.disabled = false; return; }
        await api(`/api/admin/tarla/${id}`, { method: "DELETE" });
      } else {
        await api(`/api/admin/tarla/${id}?durum=${act}`, { method: "PATCH" });
      }
      yukleTablo();
    } catch (err) {
      alert(err.message || "İşlem başarısız.");
      btn.disabled = false;
    }
  });

  $("yenile").addEventListener("click", yukleTablo);

  // --- Yeni ilan ekleme ----------------------------------------------------
  $("ekle-toggle").addEventListener("click", () => $("ekle-form").classList.toggle("hidden"));
  window.IlIlce.baglaSelectler("e-il", "e-ilce");

  const opt = (v) => { const t = (v || "").trim(); return t === "" ? null : t; };

  $("ekle-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const alertBox = $("ekle-alert");
    alertBox.classList.add("hidden");
    const btn = $("e-submit");
    const alanStr = $("e-alan_m2").value.trim();
    const body = {
      ad_soyad: $("e-ad_soyad").value.trim(),
      telefon: $("e-telefon").value.trim(),
      email: $("e-email").value.trim(),
      il: window.IlIlce.seciliAd("e-il"), ilce: window.IlIlce.seciliAd("e-ilce"), mahalle: opt($("e-mahalle").value),
      ada: $("e-ada").value.trim(), parsel: $("e-parsel").value.trim(),
      alan_m2: alanStr === "" ? null : Number(alanStr),
      egim: opt($("e-egim").value), su_durumu: opt($("e-su_durumu").value),
      aciklama: opt($("e-aciklama").value),
      durum: $("e-durum").value,
    };
    btn.disabled = true;
    try {
      await api("/api/admin/tarla", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      $("ekle-form").reset();
      window.IlIlce.baglaSelectler("e-il", "e-ilce");
      $("e-durum").value = "yayinda";
      alertBox.textContent = "İlan eklendi.";
      alertBox.className = "mt-3 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700";
      alertBox.classList.remove("hidden");
      yukleTablo();
    } catch (err) {
      alertBox.textContent = err.message || "Eklenemedi.";
      alertBox.className = "mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700";
      alertBox.classList.remove("hidden");
    } finally {
      btn.disabled = false;
    }
  });

  // --- Sekme butonları -----------------------------------------------------
  $("tab-tarlalar").addEventListener("click", () => switchTab("tarlalar"));
  $("tab-talepler").addEventListener("click", () => switchTab("talepler"));
  $("tab-ciftciler").addEventListener("click", () => switchTab("ciftciler"));
  $("tab-ekim").addEventListener("click", () => switchTab("ekim"));

  // --- Çiftçi başvuruları sekmesi ------------------------------------------

  const FILTRELER_CIFTCI = [
    { v: "", l: "Hepsi" },
    { v: "beklemede", l: "Beklemede" },
    { v: "onaylandi", l: "Onaylı" },
    { v: "reddedildi", l: "Reddedildi" },
  ];
  function renderFiltreCiftci() {
    const box = $("filtre-ciftci");
    box.innerHTML = "";
    FILTRELER_CIFTCI.forEach((f) => {
      const b = document.createElement("button");
      const aktif = f.v === aktifFiltreCiftci;
      b.className = `rounded-md px-3 py-1 transition ${aktif ? "bg-white font-semibold text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-700"}`;
      b.textContent = f.l;
      b.addEventListener("click", () => { aktifFiltreCiftci = f.v; renderFiltreCiftci(); yukleTabloCiftci(); });
      box.appendChild(b);
    });
  }

  const DURUM_ROZET_CIFTCI = {
    "beklemede": "bg-amber-100 text-amber-700",
    "onaylandi": "bg-green-100 text-green-700",
    "reddedildi": "bg-red-100 text-red-700",
  };
  const DURUM_ETIKET_CIFTCI = { "beklemede": "Beklemede", "onaylandi": "Onaylı", "reddedildi": "Reddedildi" };

  function aksiyonlarCiftci(c) {
    const btns = [];
    if (c.durum !== "onaylandi")
      btns.push(`<button data-act="onaylandi" data-id="${c.id}" class="rounded-md bg-green-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-green-700">Onayla</button>`);
    if (c.durum !== "reddedildi")
      btns.push(`<button data-act="reddedildi" data-id="${c.id}" class="rounded-md bg-amber-500 px-2.5 py-1 text-xs font-semibold text-white hover:bg-amber-600">Reddet</button>`);
    btns.push(`<button data-act="sil" data-id="${c.id}" class="rounded-md border border-red-200 px-2.5 py-1 text-xs font-semibold text-red-600 hover:bg-red-50">Sil</button>`);
    return btns.join(" ");
  }

  function satirCiftci(c) {
    const deneyim = [
      c.deneyim_yil != null ? `${c.deneyim_yil} yıl` : null,
      c.deneyim,
    ].filter(Boolean).join(" · ") || "—";
    const tr = document.createElement("tr");
    tr.className = "border-b border-slate-50 align-top";
    tr.innerHTML = `
      <td class="px-4 py-3"><span class="inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${DURUM_ROZET_CIFTCI[c.durum] || "bg-slate-100 text-slate-600"}">${esc(DURUM_ETIKET_CIFTCI[c.durum] || c.durum)}</span></td>
      <td class="px-4 py-3 font-medium text-slate-700">${esc(c.ad)} ${esc(c.soyad)}</td>
      <td class="px-4 py-3 text-slate-600">${esc(c.sehir)}</td>
      <td class="px-4 py-3"><div class="max-w-xs truncate text-slate-600" title="${esc(deneyim)}">${esc(deneyim)}</div></td>
      <td class="px-4 py-3">
        <div class="text-xs text-slate-500">${esc(c.telefon)}</div>
        <div class="text-xs text-slate-400">${esc(c.email)}</div>
      </td>
      <td class="px-4 py-3"><div class="flex flex-wrap justify-end gap-1.5">${aksiyonlarCiftci(c)}</div></td>`;
    return tr;
  }

  async function yukleTabloCiftci() {
    const body = $("tablo-ciftci-body");
    body.innerHTML = "";
    try {
      const url = aktifFiltreCiftci ? `/api/admin/ciftciler?durum=${encodeURIComponent(aktifFiltreCiftci)}` : "/api/admin/ciftciler";
      const liste = await api(url);
      $("tablo-ciftci-bos").classList.toggle("hidden", liste.length > 0);
      const frag = document.createDocumentFragment();
      liste.forEach((c) => frag.appendChild(satirCiftci(c)));
      body.appendChild(frag);
    } catch (err) {
      // 401 zaten showLogin tetikledi; diğer hatalar sessiz tablo.
    }
  }

  // Çiftçi tablo aksiyonları (event delegation).
  $("tablo-ciftci-body").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const id = btn.dataset.id;
    const act = btn.dataset.act;
    btn.disabled = true;
    try {
      if (act === "sil") {
        if (!confirm("Bu başvuruyu silmek istediğinize emin misiniz?")) { btn.disabled = false; return; }
        await api(`/api/admin/ciftci/${id}`, { method: "DELETE" });
      } else {
        await api(`/api/admin/ciftci/${id}?durum=${act}`, { method: "PATCH" });
      }
      yukleTabloCiftci();
    } catch (err) {
      alert(err.message || "İşlem başarısız.");
      btn.disabled = false;
    }
  });

  $("yenile-ciftci").addEventListener("click", yukleTabloCiftci);

  // --- Kiralama talepleri sekmesi ------------------------------------------
  // Durum etiket/rozet değerleri çiftçi ile aynı (beklemede/onaylandi/reddedildi).
  const FILTRELER_TALEP = FILTRELER_CIFTCI;
  function renderFiltreTalep() {
    const box = $("filtre-talep");
    box.innerHTML = "";
    FILTRELER_TALEP.forEach((f) => {
      const b = document.createElement("button");
      const aktif = f.v === aktifFiltreTalep;
      b.className = `rounded-md px-3 py-1 transition ${aktif ? "bg-white font-semibold text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-700"}`;
      b.textContent = f.l;
      b.addEventListener("click", () => { aktifFiltreTalep = f.v; renderFiltreTalep(); yukleTabloTalep(); });
      box.appendChild(b);
    });
  }

  function aksiyonlarTalep(t) {
    const btns = [];
    if (t.durum !== "onaylandi")
      btns.push(`<button data-act="onaylandi" data-id="${t.id}" class="rounded-md bg-green-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-green-700">Onayla</button>`);
    if (t.durum !== "reddedildi")
      btns.push(`<button data-act="reddedildi" data-id="${t.id}" class="rounded-md bg-amber-500 px-2.5 py-1 text-xs font-semibold text-white hover:bg-amber-600">Reddet</button>`);
    btns.push(`<button data-act="sil" data-id="${t.id}" class="rounded-md border border-red-200 px-2.5 py-1 text-xs font-semibold text-red-600 hover:bg-red-50">Sil</button>`);
    return btns.join(" ");
  }

  function satirTalep(t) {
    const konum = [t.il, t.ilce, t.mahalle].filter(Boolean).join(" / ");
    const tarlaVar = t.ada != null || t.parsel != null;
    const tarlaBilgi = tarlaVar
      ? `${konum ? `<div class="text-xs text-slate-400">${esc(konum)}</div>` : ""}<div class="font-medium text-slate-700">Ada ${esc(t.ada || "—")} / Parsel ${esc(t.parsel || "—")}</div>`
      : `<div class="text-xs italic text-slate-400">İlan silinmiş (#${esc(t.tarla_id)})</div>`;
    const tr = document.createElement("tr");
    tr.className = "border-b border-slate-50 align-top";
    tr.innerHTML = `
      <td class="px-4 py-3"><span class="inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${DURUM_ROZET_CIFTCI[t.durum] || "bg-slate-100 text-slate-600"}">${esc(DURUM_ETIKET_CIFTCI[t.durum] || t.durum)}</span></td>
      <td class="px-4 py-3">${tarlaBilgi}</td>
      <td class="px-4 py-3 font-medium text-slate-700">${esc(t.ad)} ${esc(t.soyad)}</td>
      <td class="px-4 py-3">
        <div class="text-xs text-slate-500">${esc(t.telefon)}</div>
        <div class="text-xs text-slate-400">${esc(t.email)}</div>
      </td>
      <td class="px-4 py-3"><div class="flex flex-wrap justify-end gap-1.5">${aksiyonlarTalep(t)}</div></td>`;
    return tr;
  }

  async function yukleTabloTalep() {
    const body = $("tablo-talep-body");
    body.innerHTML = "";
    try {
      const url = aktifFiltreTalep ? `/api/admin/kiralama-talepleri?durum=${encodeURIComponent(aktifFiltreTalep)}` : "/api/admin/kiralama-talepleri";
      const liste = await api(url);
      $("tablo-talep-bos").classList.toggle("hidden", liste.length > 0);
      const frag = document.createDocumentFragment();
      liste.forEach((t) => frag.appendChild(satirTalep(t)));
      body.appendChild(frag);
    } catch (err) {
      // 401 zaten showLogin tetikledi; diğer hatalar sessiz tablo.
    }
  }

  // Talep tablo aksiyonları (event delegation).
  $("tablo-talep-body").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const id = btn.dataset.id;
    const act = btn.dataset.act;
    btn.disabled = true;
    try {
      if (act === "sil") {
        if (!confirm("Bu talebi silmek istediğinize emin misiniz?")) { btn.disabled = false; return; }
        await api(`/api/admin/kiralama-talebi/${id}`, { method: "DELETE" });
      } else {
        await api(`/api/admin/kiralama-talebi/${id}?durum=${act}`, { method: "PATCH" });
      }
      yukleTabloTalep();
    } catch (err) {
      alert(err.message || "İşlem başarısız.");
      btn.disabled = false;
    }
  });

  $("yenile-talep").addEventListener("click", yukleTabloTalep);

  // --- Ekim yardımı sekmesi ------------------------------------------------
  // Durum etiket/rozet değerleri çiftçi ile aynı (beklemede/onaylandi/reddedildi).
  function renderFiltreEkim() {
    const box = $("filtre-ekim");
    box.innerHTML = "";
    FILTRELER_CIFTCI.forEach((f) => {
      const b = document.createElement("button");
      const aktif = f.v === aktifFiltreEkim;
      b.className = `rounded-md px-3 py-1 transition ${aktif ? "bg-white font-semibold text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-700"}`;
      b.textContent = f.l;
      b.addEventListener("click", () => { aktifFiltreEkim = f.v; renderFiltreEkim(); yukleTabloEkim(); });
      box.appendChild(b);
    });
  }

  function aksiyonlarEkim(t) {
    const btns = [];
    if (t.durum !== "onaylandi")
      btns.push(`<button data-act="onaylandi" data-id="${t.id}" class="rounded-md bg-green-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-green-700">Onayla</button>`);
    if (t.durum !== "reddedildi")
      btns.push(`<button data-act="reddedildi" data-id="${t.id}" class="rounded-md bg-amber-500 px-2.5 py-1 text-xs font-semibold text-white hover:bg-amber-600">Reddet</button>`);
    btns.push(`<button data-act="sil" data-id="${t.id}" class="rounded-md border border-red-200 px-2.5 py-1 text-xs font-semibold text-red-600 hover:bg-red-50">Sil</button>`);
    return btns.join(" ");
  }

  function satirEkim(t) {
    const konum = [t.il, t.ilce, t.mahalle].filter(Boolean).join(" / ");
    const tarlaVar = t.ada != null || t.parsel != null;
    const tarlaBilgi = `${konum ? `<div class="text-xs text-slate-400">${esc(konum)}</div>` : ""}${
      tarlaVar
        ? `<div class="font-medium text-slate-700">Ada ${esc(t.ada || "—")} / Parsel ${esc(t.parsel || "—")}</div>`
        : `<div class="text-xs italic text-slate-400">Parsel belirtilmemiş</div>`
    }${t.alan_m2 != null ? `<div class="text-xs text-slate-400">${Number(t.alan_m2).toLocaleString("tr-TR")} m²</div>` : ""}`;
    const tr = document.createElement("tr");
    tr.className = "border-b border-slate-50 align-top";
    tr.innerHTML = `
      <td class="px-4 py-3"><span class="inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${DURUM_ROZET_CIFTCI[t.durum] || "bg-slate-100 text-slate-600"}">${esc(DURUM_ETIKET_CIFTCI[t.durum] || t.durum)}</span></td>
      <td class="px-4 py-3">${tarlaBilgi}</td>
      <td class="px-4 py-3 font-medium text-slate-700">${esc(t.ad_soyad)}</td>
      <td class="px-4 py-3">
        <div class="text-xs text-slate-500">${esc(t.telefon)}</div>
        <div class="text-xs text-slate-400">${esc(t.email)}</div>
      </td>
      <td class="px-4 py-3">
        <div class="max-w-xs truncate text-slate-600" title="${esc(t.aciklama || "")}">${esc(t.aciklama || "—")}</div>
        ${tarlaSurveyOzeti(t) ? `<div class="mt-0.5 max-w-xs truncate text-xs text-slate-400" title="${esc(tarlaSurveyOzeti(t))}">${esc(tarlaSurveyOzeti(t))}</div>` : ""}
      </td>
      <td class="px-4 py-3"><div class="flex flex-wrap justify-end gap-1.5">${aksiyonlarEkim(t)}</div></td>`;
    return tr;
  }

  async function yukleTabloEkim() {
    const body = $("tablo-ekim-body");
    body.innerHTML = "";
    try {
      const url = aktifFiltreEkim ? `/api/admin/ekim-yardimlar?durum=${encodeURIComponent(aktifFiltreEkim)}` : "/api/admin/ekim-yardimlar";
      const liste = await api(url);
      $("tablo-ekim-bos").classList.toggle("hidden", liste.length > 0);
      const frag = document.createDocumentFragment();
      liste.forEach((t) => frag.appendChild(satirEkim(t)));
      body.appendChild(frag);
    } catch (err) {
      // 401 zaten showLogin tetikledi; diğer hatalar sessiz tablo.
    }
  }

  // Ekim yardımı tablo aksiyonları (event delegation).
  $("tablo-ekim-body").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const id = btn.dataset.id;
    const act = btn.dataset.act;
    btn.disabled = true;
    try {
      if (act === "sil") {
        if (!confirm("Bu talebi silmek istediğinize emin misiniz?")) { btn.disabled = false; return; }
        await api(`/api/admin/ekim-yardim/${id}`, { method: "DELETE" });
      } else {
        await api(`/api/admin/ekim-yardim/${id}?durum=${act}`, { method: "PATCH" });
      }
      yukleTabloEkim();
    } catch (err) {
      alert(err.message || "İşlem başarısız.");
      btn.disabled = false;
    }
  });

  $("yenile-ekim").addEventListener("click", yukleTabloEkim);

  // --- Boot: oturum var mı? ------------------------------------------------
  (async () => {
    try {
      const bilgi = await api("/api/admin/ben");
      showDash(bilgi.kullanici);
    } catch (_) {
      showLogin();
    }
  })();
})();
