// Anonim "Çiftçimiz Ol" başvuru formu → POST /api/ciftci-basvuru
(() => {
  const $ = (id) => document.getElementById(id);
  const form = $("ciftci-form");
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

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearAlert();
    const btn = $("f-submit");
    const yilStr = $("f-deneyim_yil").value.trim();

    const body = {
      ad: $("f-ad").value.trim(),
      soyad: $("f-soyad").value.trim(),
      sehir: $("f-sehir").value.trim(),
      deneyim_yil: yilStr === "" ? null : Number(yilStr),
      deneyim: opt($("f-deneyim").value),
      telefon: $("f-telefon").value.trim(),
      email: $("f-email").value.trim(),
    };

    btn.disabled = true;
    try {
      const r = await fetch("/api/ciftci-basvuru", {
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
      showAlert(err.message || "Başvuru gönderilemedi.");
    } finally {
      btn.disabled = false;
    }
  });

  $("yeni-basvuru").addEventListener("click", () => {
    form.reset();
    $("done-card").classList.add("hidden");
    $("form-card").classList.remove("hidden");
  });
})();
