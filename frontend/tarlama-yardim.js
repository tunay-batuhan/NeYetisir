// Anonim "Tarlama Yardım Al" formu → POST /api/ekim-yardim-basvuru
(() => {
  const $ = (id) => document.getElementById(id);
  const form = $("yardim-form");
  const alertBox = $("alert");

  function showAlert(msg) {
    alertBox.textContent = msg;
    alertBox.className = "mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700";
    alertBox.classList.remove("hidden");
  }
  function clearAlert() {
    alertBox.classList.add("hidden");
  }

  // Boş string'leri null'a çevirir (opsiyonel alanlar için).
  const opt = (v) => {
    const t = (v || "").trim();
    return t === "" ? null : t;
  };

  // Rapordan gelen parsel bilgilerini URL query-param'larından ön-doldur.
  const p = new URLSearchParams(location.search);
  window.IlIlce.baglaSelectler("f-il", "f-ilce", { il: p.get("il"), ilce: p.get("ilce") });
  [["mahalle", "f-mahalle"], ["ada", "f-ada"],
   ["parsel", "f-parsel"], ["alan_m2", "f-alan_m2"]].forEach(([k, id]) => {
    const v = p.get(k);
    if (v) { const el = $(id); if (el) el.value = v; }
  });

  // Kimyasal/gübre "Evet" seçilince "ne kullanıldı" alanını göster.
  $("f-kimyasal_gubre_var").addEventListener("change", (e) => {
    $("f-kimyasal_gubre_aciklama_wrap").classList.toggle("hidden", e.target.value !== "evet");
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearAlert();
    const btn = $("f-submit");
    const alanStr = $("f-alan_m2").value.trim();
    const uzaklikStr = $("f-su_kaynagina_uzaklik_km").value.trim();

    const body = {
      ad_soyad: $("f-ad_soyad").value.trim(),
      telefon: $("f-telefon").value.trim(),
      email: $("f-email").value.trim(),
      il: window.IlIlce.seciliAd("f-il"),
      ilce: window.IlIlce.seciliAd("f-ilce"),
      mahalle: opt($("f-mahalle").value),
      ada: opt($("f-ada").value),
      parsel: opt($("f-parsel").value),
      alan_m2: alanStr === "" ? null : Number(alanStr),
      agac_var: opt($("f-agac_var").value),
      tas_var: opt($("f-tas_var").value),
      son_urun: opt($("f-son_urun").value),
      kimyasal_gubre_var: opt($("f-kimyasal_gubre_var").value),
      kimyasal_gubre_aciklama: opt($("f-kimyasal_gubre_aciklama").value),
      su_kaynagina_uzaklik_km: uzaklikStr === "" ? null : Number(uzaklikStr),
      aciklama: opt($("f-aciklama").value),
    };

    btn.disabled = true;
    try {
      const r = await fetch("/api/ekim-yardim-basvuru", {
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
      // Başarı: formu gizle, teşekkür kartını göster.
      $("form-card").classList.add("hidden");
      $("done-card").classList.remove("hidden");
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      showAlert(err.message || window.I18n.t("tarlayardim.submit_failed"));
    } finally {
      btn.disabled = false;
    }
  });

  $("yeni-basvuru").addEventListener("click", () => {
    form.reset();
    window.IlIlce.baglaSelectler("f-il", "f-ilce");
    $("done-card").classList.add("hidden");
    $("form-card").classList.remove("hidden");
  });
})();
