// Lokalizasyon altyapısı — i18next (CDN, build adımı yok; Leaflet/Tailwind ile
// aynı yöntem). Çeviriler /locales/tr.json ve /locales/en.json'dan fetch edilir.
//
// Kullanım:
//   <span data-i18n="nav.home">Ana Sayfa</span>              → textContent
//   <input data-i18n-placeholder="form.il" placeholder="İl">  → placeholder
//   <button data-i18n-title="common.close" title="Kapat">     → title
//   JS içinden: window.I18n.t("nav.home")
//
// en.json'da bir anahtarın değeri boşsa ("") otomatik olarak tr.json'daki
// karşılığına düşer (returnEmptyString: false) — çeviri tamamlanana kadar
// site İngilizce modda da bozulmadan Türkçe metin gösterir.
window.I18n = (function () {
  const STORAGE_KEY = "neyetisir_lang";
  const DEFAULT_LANG = "tr";
  const SUPPORTED = ["tr", "en"];

  function getLang() {
    try {
      const v = localStorage.getItem(STORAGE_KEY);
      return SUPPORTED.includes(v) ? v : DEFAULT_LANG;
    } catch (_) {
      return DEFAULT_LANG;
    }
  }

  function saveLang(lang) {
    try { localStorage.setItem(STORAGE_KEY, lang); } catch (_) {}
  }

  async function fetchJson(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  function applyToDom() {
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      const val = t(el.getAttribute("data-i18n"));
      if (val) el.textContent = val;
    });
    document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
      const val = t(el.getAttribute("data-i18n-placeholder"));
      if (val) el.placeholder = val;
    });
    document.querySelectorAll("[data-i18n-title]").forEach((el) => {
      const val = t(el.getAttribute("data-i18n-title"));
      if (val) el.title = val;
    });
    document.querySelectorAll("[data-i18n-aria-label]").forEach((el) => {
      const val = t(el.getAttribute("data-i18n-aria-label"));
      if (val) el.setAttribute("aria-label", val);
    });
    // Yalnız çeviri dosyalarından gelen sabit HTML (ör. "<br>" ile iki satıra
    // bölünen kısa etiketler) için — kullanıcı girdisi asla buraya gelmez.
    document.querySelectorAll("[data-i18n-html]").forEach((el) => {
      const val = t(el.getAttribute("data-i18n-html"));
      if (val) el.innerHTML = val;
    });
    document.documentElement.lang = window.i18next.language;
    updateLangButtons();
    document.dispatchEvent(new CustomEvent("i18n:applied"));
  }

  function updateLangButtons() {
    const lang = window.i18next.language;
    const tr = document.getElementById("lang-tr");
    const en = document.getElementById("lang-en");
    if (!tr || !en) return;
    const active = "h-8 w-8 grid place-items-center rounded-lg text-lg ring-2 ring-brand bg-white";
    const idle = "h-8 w-8 grid place-items-center rounded-lg text-lg ring-1 ring-transparent hover:bg-slate-100";
    tr.className = lang === "tr" ? active : idle;
    en.className = lang === "en" ? active : idle;
  }

  let ready = null;

  function init() {
    if (ready) return ready;
    ready = (async () => {
      const [tr, en] = await Promise.all([
        fetchJson("/locales/tr.json"),
        fetchJson("/locales/en.json"),
      ]);
      await window.i18next.init({
        lng: getLang(),
        fallbackLng: "tr",
        returnEmptyString: false,
        resources: { tr: { translation: tr }, en: { translation: en } },
      });
      applyToDom();

      const btnTr = document.getElementById("lang-tr");
      const btnEn = document.getElementById("lang-en");
      if (btnTr) btnTr.addEventListener("click", () => changeLanguage("tr"));
      if (btnEn) btnEn.addEventListener("click", () => changeLanguage("en"));
    })();
    return ready;
  }

  async function changeLanguage(lang) {
    if (!SUPPORTED.includes(lang)) return;
    saveLang(lang);
    await window.i18next.changeLanguage(lang);
    applyToDom();
  }

  // Sayfa açılışında bazı script'ler (ör. il-ilce.js) DOMContentLoaded'dan önce,
  // yani init() tamamlanmadan t() çağırabilir. i18next başlamadan .t() çağrısı
  // undefined döner (metni "undefined" yapar) — bu yüzden boş string'e düşüyoruz;
  // init() bitince applyToDom() zaten doğru metni yazacak.
  function t(key, opts) {
    if (!window.i18next || !window.i18next.isInitialized) return "";
    return window.i18next.t(key, opts);
  }

  return { init, changeLanguage, applyToDom, t, getLang };
})();

document.addEventListener("DOMContentLoaded", () => window.I18n.init());
