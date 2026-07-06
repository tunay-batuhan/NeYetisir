// Paylaşılan üyelik/oturum modülü — index, kiralik ve kiralama sayfalarının
// header'ında ortak çalışır. Auth modalı buradan DOM'a enjekte edilir (tek
// kaynak), header kontrolleri (#btn-giris/#btn-kayit/#user-box/#btn-cikis) ID
// ile bağlanır. Diğer scriptler `window.Auth` üzerinden erişir:
//   Auth.user            -> aktif kullanıcı ya da null
//   Auth.openModal(tab)  -> "giris" | "kayit"
//   Auth.setAlert(m,knd) -> modal içi bilgi/hata satırı
//   Auth.setLoggedOut()  -> durumu çıkış yapılmış olarak işaretle + render
//   Auth.reload()        -> /api/ben ile oturumu sessizce geri yükle
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);

  function profilEtiket(profil) {
    const map = {
      eken: "auth.profile_label_eken",
      kiralayan: "auth.profile_label_kiralayan",
      kiraci: "auth.profile_label_kiraci",
    };
    return map[profil] ? window.I18n.t(map[profil]) : profil;
  }

  // --- Modal markup'ı (tek kaynak) DOM'a enjekte et ---------------------------
  const AUTH_MODAL_HTML = `
  <div id="auth-modal" class="fixed inset-0 z-50 hidden">
    <div id="auth-backdrop" class="absolute inset-0 bg-slate-900/50 backdrop-blur-sm"></div>
    <div class="absolute inset-0 flex items-start justify-center p-4 overflow-y-auto">
      <div id="auth-card"
           class="relative mt-16 w-full max-w-md rounded-2xl bg-white shadow-2xl
                  scale-95 opacity-0 transition-all duration-200">
        <div class="flex items-center justify-between px-5 py-3.5 border-b">
          <div class="flex items-center gap-2">
            <span class="grid place-items-center h-8 w-8 rounded-lg bg-brand text-white">
              <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                   stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>
              </svg>
            </span>
            <h2 class="font-bold text-brand-deep text-lg" data-i18n="auth.account_title">Hesabım</h2>
          </div>
          <button id="auth-close" class="text-slate-400 hover:text-slate-600 text-2xl leading-none">&times;</button>
        </div>

        <div class="px-5 pt-4">
          <div class="grid grid-cols-2 gap-1 p-1 rounded-xl bg-slate-100 text-sm font-medium">
            <button id="at-giris" data-i18n="auth.login"
                    class="rounded-lg py-1.5 transition bg-white text-brand-deep shadow-sm">Giriş Yap</button>
            <button id="at-kayit" data-i18n="auth.register"
                    class="rounded-lg py-1.5 transition text-slate-500 hover:text-slate-700">Kayıt Ol</button>
          </div>
        </div>

        <div id="auth-alert" class="hidden mx-5 mt-3 text-sm rounded-lg border px-3 py-2"></div>

        <form id="giris-form" class="px-5 py-4 space-y-3">
          <div>
            <label class="block text-sm font-medium text-slate-600 mb-1" data-i18n="auth.email_label">E-posta</label>
            <input id="giris-email" type="email" required autocomplete="email"
                   class="w-full border rounded-lg px-3 py-2" data-i18n-placeholder="auth.email_placeholder" placeholder="ornek@eposta.com" />
          </div>
          <div>
            <label class="block text-sm font-medium text-slate-600 mb-1" data-i18n="auth.password_label">Parola</label>
            <input id="giris-parola" type="password" required autocomplete="current-password"
                   class="w-full border rounded-lg px-3 py-2" placeholder="••••••••" />
          </div>
          <button id="giris-submit" type="submit" data-i18n="auth.login"
                  class="w-full bg-brand hover:bg-brand-dark disabled:bg-slate-400
                         text-white font-semibold px-4 py-2.5 rounded-lg transition">
            Giriş Yap
          </button>
        </form>

        <form id="kayit-form" class="hidden px-5 py-4 space-y-3">
          <div>
            <label class="block text-sm font-medium text-slate-600 mb-1" data-i18n="auth.fullname_label">Ad Soyad</label>
            <input id="kayit-ad" type="text" required autocomplete="name"
                   class="w-full border rounded-lg px-3 py-2" data-i18n-placeholder="auth.fullname_placeholder" placeholder="Adınız Soyadınız" />
          </div>
          <div>
            <label class="block text-sm font-medium text-slate-600 mb-1" data-i18n="auth.email_label">E-posta</label>
            <input id="kayit-email" type="email" required autocomplete="email"
                   class="w-full border rounded-lg px-3 py-2" data-i18n-placeholder="auth.email_placeholder" placeholder="ornek@eposta.com" />
          </div>
          <div>
            <label class="block text-sm font-medium text-slate-600 mb-1" data-i18n="auth.password_label">Parola</label>
            <input id="kayit-parola" type="password" required autocomplete="new-password" minlength="6"
                   class="w-full border rounded-lg px-3 py-2" data-i18n-placeholder="auth.password_min_placeholder" placeholder="En az 6 karakter" />
          </div>

          <div>
            <label class="block text-sm font-medium text-slate-600 mb-1.5" data-i18n="auth.profile_question">Nasıl kullanacaksın?</label>
            <div id="profil-secim" class="space-y-2">
              <label class="profil-kart flex items-start gap-3 rounded-xl border-2 border-slate-200 p-3 cursor-pointer transition hover:border-brand/50">
                <input type="radio" name="profil" value="eken" class="mt-0.5 accent-brand" required />
                <span>
                  <span class="block text-sm font-semibold text-slate-800" data-i18n="auth.profile_eken_title">Tarlamı ekmek istiyorum</span>
                  <span class="block text-xs text-slate-500" data-i18n="auth.profile_eken_desc">Kendi tarlamı işleyeceğim, ne yetişeceğini öğreneceğim.</span>
                </span>
              </label>
              <label class="profil-kart flex items-start gap-3 rounded-xl border-2 border-slate-200 p-3 cursor-pointer transition hover:border-brand/50">
                <input type="radio" name="profil" value="kiralayan" class="mt-0.5 accent-brand" />
                <span>
                  <span class="block text-sm font-semibold text-slate-800" data-i18n="auth.profile_kiralayan_title">Tarlamı kiralamak istiyorum</span>
                  <span class="block text-xs text-slate-500" data-i18n="auth.profile_kiralayan_desc">Tarlamı işleyecek birini arıyorum, kiraya vereceğim.</span>
                </span>
              </label>
              <label class="profil-kart flex items-start gap-3 rounded-xl border-2 border-slate-200 p-3 cursor-pointer transition hover:border-brand/50">
                <input type="radio" name="profil" value="kiraci" class="mt-0.5 accent-brand" />
                <span>
                  <span class="block text-sm font-semibold text-slate-800" data-i18n="auth.profile_kiraci_title">Tarla kiralayıp ekmek istiyorum</span>
                  <span class="block text-xs text-slate-500" data-i18n="auth.profile_kiraci_desc">Başkasının tarlasını kiralayıp işlemek istiyorum.</span>
                </span>
              </label>
            </div>
          </div>

          <button id="kayit-submit" type="submit" data-i18n="auth.register"
                  class="w-full bg-brand hover:bg-brand-dark disabled:bg-slate-400
                         text-white font-semibold px-4 py-2.5 rounded-lg transition">
            Kayıt Ol
          </button>
        </form>
      </div>
    </div>
  </div>`;

  if (!$("auth-modal")) {
    const holder = document.createElement("div");
    holder.innerHTML = AUTH_MODAL_HTML.trim();
    document.body.appendChild(holder.firstChild);
  }

  // --- State + element referansları ------------------------------------------
  let aktifKullanici = null;

  const authModal = $("auth-modal");
  const authCard = $("auth-card");
  const authAlert = $("auth-alert");
  const girisForm = $("giris-form");
  const kayitForm = $("kayit-form");
  const atGiris = $("at-giris");
  const atKayit = $("at-kayit");

  function setAuthAlert(msg, kind = "error") {
    if (!msg) { authAlert.classList.add("hidden"); authAlert.textContent = ""; return; }
    authAlert.textContent = msg;
    authAlert.classList.remove("hidden", "error", "info");
    authAlert.classList.add(kind);
  }

  function setAuthTab(name) {
    const giris = name === "giris";
    atGiris.className = `rounded-lg py-1.5 transition ${giris ? "bg-white text-brand-deep shadow-sm" : "text-slate-500 hover:text-slate-700"}`;
    atKayit.className = `rounded-lg py-1.5 transition ${giris ? "text-slate-500 hover:text-slate-700" : "bg-white text-brand-deep shadow-sm"}`;
    girisForm.classList.toggle("hidden", !giris);
    kayitForm.classList.toggle("hidden", giris);
    setAuthAlert("");
  }

  function openAuthModal(tab = "giris") {
    setAuthTab(tab);
    authModal.classList.remove("hidden");
    requestAnimationFrame(() => {
      authCard.classList.remove("scale-95", "opacity-0");
    });
  }
  function closeAuthModal() {
    authCard.classList.add("scale-95", "opacity-0");
    setTimeout(() => authModal.classList.add("hidden"), 200);
  }

  atGiris.addEventListener("click", () => setAuthTab("giris"));
  atKayit.addEventListener("click", () => setAuthTab("kayit"));
  $("auth-close").addEventListener("click", closeAuthModal);
  $("auth-backdrop").addEventListener("click", closeAuthModal);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !authModal.classList.contains("hidden")) closeAuthModal();
  });

  // --- Header kontrolleri (her sayfada bulunur) ------------------------------
  const btnGiris = $("btn-giris");
  const btnKayit = $("btn-kayit");
  const userBox = $("user-box");
  const btnCikis = $("btn-cikis");

  if (btnGiris) btnGiris.addEventListener("click", () => openAuthModal("giris"));
  if (btnKayit) btnKayit.addEventListener("click", () => openAuthModal("kayit"));

  function renderAuthDurum() {
    const authButtons = [btnGiris, btnKayit].filter(Boolean);
    if (aktifKullanici) {
      // Butonlar "hidden sm:inline-flex" — gizlemek için sm: override'ını da kaldır.
      for (const b of authButtons) { b.classList.add("hidden"); b.classList.remove("sm:inline-flex"); }
      if (userBox) {
        userBox.classList.remove("hidden");
        userBox.classList.add("flex");
        const adEl = $("user-ad"), profilEl = $("user-profil");
        if (adEl) adEl.textContent = aktifKullanici.ad;
        if (profilEl) profilEl.textContent = profilEtiket(aktifKullanici.profil);
      }
    } else {
      for (const b of authButtons) { b.classList.remove("hidden"); b.classList.add("sm:inline-flex"); }
      if (userBox) { userBox.classList.add("hidden"); userBox.classList.remove("flex"); }
    }
  }

  // POST + JSON; hata gövdesindeki `detail`'i mesaja çevirir.
  async function authPost(url, body) {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) {
      let detail = `HTTP ${r.status}`;
      try {
        const j = await r.json();
        if (j && j.detail) {
          detail = Array.isArray(j.detail) ? (j.detail[0]?.msg || detail) : j.detail;
        }
      } catch (_) {}
      throw new Error(detail);
    }
    return r.status === 204 ? null : r.json();
  }

  girisForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("giris-submit");
    btn.disabled = true;
    setAuthAlert("");
    try {
      aktifKullanici = await authPost("/api/giris", {
        email: $("giris-email").value.trim(),
        parola: $("giris-parola").value,
      });
      renderAuthDurum();
      closeAuthModal();
      girisForm.reset();
    } catch (err) {
      setAuthAlert(err.message || window.I18n.t("auth.login_failed"));
    } finally {
      btn.disabled = false;
    }
  });

  kayitForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("kayit-submit");
    const profilEl = kayitForm.querySelector('input[name="profil"]:checked');
    if (!profilEl) { setAuthAlert(window.I18n.t("auth.profile_required")); return; }
    btn.disabled = true;
    setAuthAlert("");
    try {
      aktifKullanici = await authPost("/api/kayit", {
        ad: $("kayit-ad").value.trim(),
        email: $("kayit-email").value.trim(),
        parola: $("kayit-parola").value,
        profil: profilEl.value,
      });
      renderAuthDurum();
      closeAuthModal();
      kayitForm.reset();
    } catch (err) {
      setAuthAlert(err.message || window.I18n.t("auth.register_failed"));
    } finally {
      btn.disabled = false;
    }
  });

  if (btnCikis) {
    btnCikis.addEventListener("click", async () => {
      try { await authPost("/api/cikis"); } catch (_) {}
      aktifKullanici = null;
      renderAuthDurum();
    });
  }

  // Sayfa açılışında oturumu sessizce geri yükle.
  async function loadOturum() {
    try {
      const r = await fetch("/api/ben", { credentials: "same-origin" });
      aktifKullanici = r.ok ? await r.json() : null;
    } catch (_) {
      aktifKullanici = null;
    }
    renderAuthDurum();
  }

  // --- Dışa açılan API -------------------------------------------------------
  window.Auth = {
    get user() { return aktifKullanici; },
    openModal: openAuthModal,
    closeModal: closeAuthModal,
    setAlert: setAuthAlert,
    setLoggedOut() { aktifKullanici = null; renderAuthDurum(); },
    reload: loadOturum,
  };

  loadOturum();
})();
