// Herkese açık kiralık tarlalar galerisi → GET /api/kiralik-tarlalar
(() => {
  const $ = (id) => document.getElementById(id);
  const grid = $("grid");

  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );

  const fmtAlan = (m2) => {
    if (m2 == null) return null;
    const da = m2 / 1000; // dekar
    return `${m2.toLocaleString("tr-TR")} m² (${da.toLocaleString("tr-TR", { maximumFractionDigits: 1 })} da)`;
  };

  // Su durumu rozet rengi.
  const SU_RENK = {
    "sulu": "bg-sky-100 text-sky-700",
    "kısmen sulu": "bg-cyan-100 text-cyan-700",
    "kuru": "bg-amber-100 text-amber-700",
  };

  function rozet(metin, renk) {
    return `<span class="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${renk}">${esc(metin)}</span>`;
  }

  function kart(t) {
    const konum = [t.il, t.ilce, t.mahalle].filter(Boolean).join(" / ") || window.I18n.t("kiralik.location_unset");
    const alan = fmtAlan(t.alan_m2);
    const rozetler = [];
    if (t.egim) rozetler.push(rozet(`${window.I18n.t("kiralik.slope_prefix")}${t.egim}`, "bg-slate-100 text-slate-600"));
    if (t.su_durumu) rozetler.push(rozet(t.su_durumu, SU_RENK[t.su_durumu] || "bg-slate-100 text-slate-600"));
    const adaLabel = window.I18n.t("query.placeholder_ada");
    const parselLabel = window.I18n.t("query.placeholder_parsel");

    const el = document.createElement("div");
    el.className = "flex flex-col rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:shadow-md";
    el.innerHTML = `
      <div class="flex items-start justify-between gap-2">
        <div>
          <div class="text-xs font-medium uppercase tracking-wide text-brand">${esc(konum)}</div>
          <div class="mt-0.5 text-lg font-bold text-slate-800">${adaLabel} ${esc(t.ada)} / ${parselLabel} ${esc(t.parsel)}</div>
        </div>
        <span class="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-soft text-brand-deep">
          <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
               stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18"/><path d="M5 21V7l8-4v18"/><path d="M19 21V11l-6-4"/></svg>
        </span>
      </div>
      ${alan ? `<div class="mt-2 text-sm font-medium text-slate-600">${esc(alan)}</div>` : ""}
      ${rozetler.length ? `<div class="mt-3 flex flex-wrap gap-1.5">${rozetler.join("")}</div>` : ""}
      ${t.aciklama ? `<p class="mt-3 text-sm text-slate-500 leading-relaxed">${esc(t.aciklama)}</p>` : ""}
      <div class="mt-4 flex-1"></div>
      <div class="mt-3 border-t border-slate-100 pt-3">
        <button data-basvur="${t.id}" data-konum="${esc(konum)}" data-ada="${esc(t.ada)}" data-parsel="${esc(t.parsel)}"
                class="w-full inline-flex items-center justify-center gap-1.5 rounded-lg bg-brand px-3 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-dark">
          <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
               stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4Z"/></svg>
          ${window.I18n.t("kiralik.apply_title")}
        </button>
      </div>`;
    return el;
  }

  // --- Kiralama talebi modalı ----------------------------------------------
  let seciliTarlaId = null;

  function basvurAc(id, etiket) {
    seciliTarlaId = id;
    $("basvur-tarla").textContent = etiket;
    $("basvur-form").reset();
    $("basvur-form").classList.remove("hidden");
    $("basvur-done").classList.add("hidden");
    $("basvur-alert").classList.add("hidden");
    $("basvur-modal").classList.remove("hidden");
  }
  function basvurKapat() {
    $("basvur-modal").classList.add("hidden");
    seciliTarlaId = null;
  }

  // Kart üzerindeki "başvur" butonları (event delegation).
  grid.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-basvur]");
    if (!btn) return;
    const belirsizKonum = window.I18n.t("kiralik.location_unset");
    const konum = btn.dataset.konum && btn.dataset.konum !== belirsizKonum ? btn.dataset.konum + " · " : "";
    const etiket = `${konum}${window.I18n.t("query.placeholder_ada")} ${btn.dataset.ada} / ${window.I18n.t("query.placeholder_parsel")} ${btn.dataset.parsel}`;
    basvurAc(Number(btn.dataset.basvur), etiket);
  });

  $("basvur-close").addEventListener("click", basvurKapat);
  $("basvur-backdrop").addEventListener("click", basvurKapat);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("basvur-modal").classList.contains("hidden")) basvurKapat();
  });

  $("basvur-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const alertBox = $("basvur-alert");
    alertBox.classList.add("hidden");
    const btn = $("b-submit");
    const body = {
      tarla_id: seciliTarlaId,
      ad: $("b-ad").value.trim(),
      soyad: $("b-soyad").value.trim(),
      telefon: $("b-telefon").value.trim(),
      email: $("b-email").value.trim(),
    };
    btn.disabled = true;
    try {
      const r = await fetch("/api/kiralama-talebi", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        let detail = `HTTP ${r.status}`;
        try {
          const j = await r.json();
          if (j && j.detail) detail = Array.isArray(j.detail) ? (j.detail[0]?.msg || detail) : j.detail;
        } catch (_) {}
        throw new Error(detail);
      }
      $("basvur-form").classList.add("hidden");
      $("basvur-done").classList.remove("hidden");
    } catch (err) {
      alertBox.textContent = err.message || window.I18n.t("kiralik.apply_failed");
      alertBox.classList.remove("hidden");
    } finally {
      btn.disabled = false;
    }
  });

  $("basvur-done-kapat").addEventListener("click", basvurKapat);

  async function yukle() {
    try {
      const r = await fetch("/api/kiralik-tarlalar");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const liste = await r.json();
      if (!Array.isArray(liste) || liste.length === 0) {
        $("ozet").textContent = window.I18n.t("kiralik.no_listings");
        $("bos").classList.remove("hidden");
        return;
      }
      $("ozet").textContent = window.I18n.t("kiralik.listing_count", { count: liste.length });
      const frag = document.createDocumentFragment();
      liste.forEach((t) => frag.appendChild(kart(t)));
      grid.appendChild(frag);
    } catch (err) {
      $("ozet").textContent = "";
      const h = $("hata");
      h.textContent = `${window.I18n.t("kiralik.list_load_failed")}: ${err.message || window.I18n.t("kiralik.unknown_error")}`;
      h.classList.remove("hidden");
    }
  }

  yukle();
})();
