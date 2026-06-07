// charts.js — Rapor infografikleri. Saf SVG string üreten, bağımlılıksız fonksiyonlar.
// Veri gerçek JSON'dan (hava/toprak) gelir; LLM çizmez, sayılar doğrudur. Mevcut
// #t-baki-ok SVG deseniyle aynı yaklaşım. window.Charts API'si açar.
(function () {
  "use strict";

  const AYK = ["Oca", "Şub", "Mar", "Nis", "May", "Haz",
               "Tem", "Ağu", "Eyl", "Eki", "Kas", "Ara"];

  // Renk paleti (mevcut UI ile uyumlu)
  const C = {
    yesil: "#2e6b32", yesilAcik: "#047857",
    yagis: "#60a5fa", yagisKoyu: "#2563eb",
    sicaklik: "#dc2626",
    kum: "#eab308", kil: "#b45309", silt: "#94a3b8",
    eksen: "#94a3b8", grid: "#e5e7eb", metin: "#475569", metinKoyu: "#1f2937",
  };

  const num = (v) => (v == null || isNaN(v) ? null : Number(v));

  function niceMax(v) {
    if (!(v > 0)) return 1;
    const exp = Math.floor(Math.log10(v));
    const f = v / Math.pow(10, exp);
    const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
    return nf * Math.pow(10, exp);
  }

  const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));

  // --- USDA tekstür sınıfı (agronomy.py:usda_tekstur birebir portu) ----------
  const USDA_TR = {
    sand: "Kum", "loamy sand": "Tınlı kum", "sandy loam": "Kumlu tın",
    loam: "Tın", "silt loam": "Siltli tın", silt: "Silt",
    "sandy clay loam": "Kumlu killi tın", "clay loam": "Killi tın",
    "silty clay loam": "Siltli killi tın", "sandy clay": "Kumlu kil",
    "silty clay": "Siltli kil", clay: "Kil",
  };

  function usdaTekstur(kil, kum, silt) {
    const c = num(kil), s = num(kum), si = num(silt);
    if (c == null || s == null || si == null) return null;
    if (!(c >= 0 && c <= 100 && s >= 0 && s <= 100 && si >= 0 && si <= 100)) return null;
    let key;
    if (si + 1.5 * c < 15) key = "sand";
    else if (si + 1.5 * c >= 15 && si + 2 * c < 30) key = "loamy sand";
    else if ((c >= 7 && c < 20 && s > 52 && si + 2 * c >= 30) || (c < 7 && si < 50 && si + 2 * c >= 30)) key = "sandy loam";
    else if (c >= 7 && c < 27 && si >= 28 && si < 50 && s <= 52) key = "loam";
    else if ((si >= 50 && c >= 12 && c < 27) || (si >= 50 && si < 80 && c < 12)) key = "silt loam";
    else if (si >= 80 && c < 12) key = "silt";
    else if (c >= 20 && c < 35 && si < 28 && s > 45) key = "sandy clay loam";
    else if (c >= 27 && c < 40 && s > 20 && s <= 45) key = "clay loam";
    else if (c >= 27 && c < 40 && s <= 20) key = "silty clay loam";
    else if (c >= 35 && s > 45) key = "sandy clay";
    else if (c >= 40 && si >= 40) key = "silty clay";
    else if (c >= 40 && s <= 45 && si < 40) key = "clay";
    else key = "clay loam";
    return USDA_TR[key];
  }

  // --- 1) Walter-Lieth tarzı iklim diyagramı ---------------------------------
  // normal: [{ay, sicaklik_ort, yagis_top}] (12 ay). Yağış mavi bar (sol eksen),
  // sıcaklık kırmızı çizgi (sağ eksen).
  function iklimDiyagrami(normal) {
    if (!Array.isArray(normal) || normal.length < 12) return null;
    const aylar = normal.slice().sort((a, b) => a.ay - b.ay);
    const temps = aylar.map((m) => num(m.sicaklik_ort));
    const precs = aylar.map((m) => num(m.yagis_top));
    if (temps.some((t) => t == null) || precs.some((p) => p == null)) return null;

    const W = 360, H = 208, padL = 34, padR = 30, padT = 22, padB = 30;
    const plotL = padL, plotR = W - padR, plotW = plotR - plotL;
    const plotT = padT, plotB = H - padB, plotH = plotB - plotT;
    const slotW = plotW / 12;

    const pMax = Math.max(10, niceMax(Math.max(...precs)));
    let tMin = Math.floor(Math.min(0, ...temps) / 5) * 5;
    let tMax = Math.ceil(Math.max(...temps) / 5) * 5;
    if (tMax === tMin) tMax += 5;

    const pY = (p) => plotB - (p / pMax) * plotH;
    const tY = (t) => plotB - ((t - tMin) / (tMax - tMin)) * plotH;

    const parts = [];
    // yatay grid + sol(yağış)/sağ(sıcaklık) eksen etiketleri (3 seviye)
    for (let k = 0; k <= 2; k++) {
      const y = plotT + (plotH * k) / 2;
      const pv = Math.round(pMax * (1 - k / 2));
      const tv = Math.round(tMax - ((tMax - tMin) * k) / 2);
      parts.push(`<line x1="${plotL}" y1="${y.toFixed(1)}" x2="${plotR}" y2="${y.toFixed(1)}" stroke="${C.grid}" stroke-width="1"/>`);
      parts.push(`<text x="${plotL - 4}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="8" fill="${C.yagisKoyu}">${pv}</text>`);
      parts.push(`<text x="${plotR + 4}" y="${(y + 3).toFixed(1)}" text-anchor="start" font-size="8" fill="${C.sicaklik}">${tv}</text>`);
    }
    // yağış barları
    aylar.forEach((m, i) => {
      const p = precs[i];
      const x = plotL + i * slotW + slotW * 0.2;
      const bw = slotW * 0.6;
      const y = pY(p);
      parts.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${(plotB - y).toFixed(1)}" fill="${C.yagis}" rx="1"/>`);
    });
    // sıcaklık çizgisi + noktalar
    const pts = temps.map((t, i) => `${(plotL + i * slotW + slotW / 2).toFixed(1)},${tY(t).toFixed(1)}`).join(" ");
    parts.push(`<polyline points="${pts}" fill="none" stroke="${C.sicaklik}" stroke-width="2" stroke-linejoin="round"/>`);
    temps.forEach((t, i) => {
      parts.push(`<circle cx="${(plotL + i * slotW + slotW / 2).toFixed(1)}" cy="${tY(t).toFixed(1)}" r="2.1" fill="${C.sicaklik}"/>`);
    });
    // ay etiketleri
    AYK.forEach((ay, i) => {
      parts.push(`<text x="${(plotL + i * slotW + slotW / 2).toFixed(1)}" y="${plotB + 12}" text-anchor="middle" font-size="7.5" fill="${C.metin}">${ay}</text>`);
    });
    // lejant
    parts.push(`<rect x="${plotL}" y="6" width="9" height="9" fill="${C.yagis}" rx="1"/>`);
    parts.push(`<text x="${plotL + 13}" y="13.5" font-size="8.5" fill="${C.metin}">Yağış (mm)</text>`);
    parts.push(`<line x1="${plotL + 86}" y1="10.5" x2="${plotL + 102}" y2="10.5" stroke="${C.sicaklik}" stroke-width="2"/>`);
    parts.push(`<text x="${plotL + 106}" y="13.5" font-size="8.5" fill="${C.metin}">Sıcaklık (°C)</text>`);

    return svgWrap(W, H, parts.join(""));
  }

  // --- 2) Toprak kompozisyon (kum/kil/silt yığılmış bar, katman başına) -------
  function toprakKompozisyon(katmanlar) {
    if (!Array.isArray(katmanlar)) return null;
    const rows = katmanlar
      .map((k) => ({
        ad: k.derinlik || "",
        kum: num(k.kum_pct), kil: num(k.kil_pct), silt: num(k.silt_pct),
      }))
      .filter((r) => r.kum != null && r.kil != null && r.silt != null && r.kum + r.kil + r.silt > 0);
    if (!rows.length) return null;

    const W = 360, rowH = 30, top = 8, legendH = 22, labelW = 50, barL = 54, barR = 350;
    const barW = barR - barL;
    const H = top + rows.length * rowH + legendH;
    const segs = [["kum", C.kum, "Kum"], ["kil", C.kil, "Kil"], ["silt", C.silt, "Silt"]];
    const parts = [];

    rows.forEach((r, i) => {
      const cy = top + i * rowH;
      const total = r.kum + r.kil + r.silt;
      parts.push(`<text x="0" y="${cy + rowH / 2 + 3}" font-size="9" fill="${C.metinKoyu}" font-weight="600">${esc(r.ad)}</text>`);
      let x = barL;
      segs.forEach(([key, col]) => {
        const w = (r[key] / total) * barW;
        parts.push(`<rect x="${x.toFixed(1)}" y="${(cy + 6).toFixed(1)}" width="${w.toFixed(1)}" height="${rowH - 12}" fill="${col}"/>`);
        if (w > 24) {
          parts.push(`<text x="${(x + w / 2).toFixed(1)}" y="${(cy + rowH / 2 + 3).toFixed(1)}" text-anchor="middle" font-size="8" fill="#fff" font-weight="600">${Math.round(r[key])}</text>`);
        }
        x += w;
      });
    });
    // lejant
    let lx = barL;
    const ly = top + rows.length * rowH + 6;
    segs.forEach(([, col, ad]) => {
      parts.push(`<rect x="${lx}" y="${ly}" width="9" height="9" fill="${col}" rx="1"/>`);
      parts.push(`<text x="${lx + 13}" y="${ly + 8}" font-size="8.5" fill="${C.metin}">${ad}</text>`);
      lx += 58;
    });

    return svgWrap(W, H, parts.join(""));
  }

  // --- 3) USDA tekstür üçgeni (üst katmanın noktası işaretli) -----------------
  function teksturUcgeni(ust) {
    if (!ust) return null;
    const kil = num(ust.kil_pct), kum = num(ust.kum_pct), silt = num(ust.silt_pct);
    if (kil == null || kum == null || silt == null) return null;
    const sinif = usdaTekstur(kil, kum, silt);

    const W = 240, H = 212, mL = 22, mT = 14, triW = 196;
    const triH = (triW * Math.sqrt(3)) / 2;
    const BLx = mL, BRx = mL + triW, baseY = mT + triH, Tx = mL + triW / 2, Ty = mT;
    // barycentric: kum→sol-alt, silt→sağ-alt, kil→tepe
    const pt = (c, s, si) => {
      const x = BLx * (s / 100) + BRx * (si / 100) + Tx * (c / 100);
      const y = baseY * (s / 100) + baseY * (si / 100) + Ty * (c / 100);
      return [x, y];
    };
    const parts = [];
    // iç grid (her aile için %20,40,60,80)
    for (const f of [20, 40, 60, 80]) {
      const grids = [
        [pt(f, 100 - f, 0), pt(f, 0, 100 - f)],   // kil sabit
        [pt(100 - f, f, 0), pt(0, f, 100 - f)],   // kum sabit
        [pt(100 - f, 0, f), pt(0, 100 - f, f)],   // silt sabit
      ];
      for (const [[x1, y1], [x2, y2]] of grids) {
        parts.push(`<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${C.grid}" stroke-width="0.6"/>`);
      }
    }
    // üçgen kenarları
    parts.push(`<polygon points="${BLx},${baseY.toFixed(1)} ${BRx},${baseY.toFixed(1)} ${Tx},${Ty}" fill="none" stroke="${C.eksen}" stroke-width="1.2"/>`);
    // köşe etiketleri
    parts.push(`<text x="${Tx}" y="${Ty - 4}" text-anchor="middle" font-size="9" fill="${C.kil}" font-weight="600">Kil %</text>`);
    parts.push(`<text x="${BLx - 2}" y="${baseY + 11}" text-anchor="middle" font-size="9" fill="${C.kum}" font-weight="600">Kum</text>`);
    parts.push(`<text x="${BRx + 2}" y="${baseY + 11}" text-anchor="middle" font-size="9" fill="${C.silt}" font-weight="600">Silt</text>`);
    // parselin noktası
    const [px, py] = pt(kil, kum, silt);
    parts.push(`<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="4.5" fill="${C.sicaklik}" stroke="#fff" stroke-width="1.5"/>`);
    if (sinif) {
      parts.push(`<text x="${W / 2}" y="${H - 4}" text-anchor="middle" font-size="10" fill="${C.metinKoyu}" font-weight="700">${esc(sinif)}</text>`);
    }
    return svgWrap(W, H, parts.join(""));
  }

  // --- 4) Topografya kartı (rakım/eğim + bakı pusulası) -----------------------
  function topografyaKart(y) {
    if (!y) return null;
    const rakim = num(y.rakim_m), egim = num(y.egim_derece), bakiDer = num(y.baki_derece);
    const W = 360, H = 132;
    const cx = 286, cy = 66, r = 44;
    const parts = [];
    // sol: istatistikler
    parts.push(`<text x="8" y="44" font-size="11" fill="${C.metin}">Rakım</text>`);
    parts.push(`<text x="8" y="64" font-size="20" fill="${C.metinKoyu}" font-weight="700">${rakim != null ? Math.round(rakim) + " m" : "—"}</text>`);
    parts.push(`<text x="8" y="92" font-size="11" fill="${C.metin}">Eğim</text>`);
    parts.push(`<text x="8" y="112" font-size="20" fill="${C.metinKoyu}" font-weight="700">${egim != null ? egim.toFixed(1) + "°" : "—"}</text>`);
    // pusula
    parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="#f8fafc" stroke="${C.grid}" stroke-width="1.5"/>`);
    const dirs = [["K", 0], ["D", 90], ["G", 180], ["B", 270]];
    for (const [lbl, deg] of dirs) {
      const a = ((deg - 90) * Math.PI) / 180;
      const lx = cx + Math.cos(a) * (r + 9), ly = cy + Math.sin(a) * (r + 9) + 3;
      parts.push(`<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle" font-size="9" fill="${C.metin}" font-weight="600">${lbl}</text>`);
    }
    if (y.baki_yon && bakiDer != null) {
      // 0=Kuzey(yukarı), saat yönünde; ok bakı yönüne işaret eder
      parts.push(`<g transform="rotate(${bakiDer} ${cx} ${cy})">
        <line x1="${cx}" y1="${cy}" x2="${cx}" y2="${cy - r + 8}" stroke="${C.yesilAcik}" stroke-width="2.5"/>
        <polygon points="${cx},${cy - r + 2} ${cx - 5},${cy - r + 12} ${cx + 5},${cy - r + 12}" fill="${C.yesilAcik}"/>
      </g>`);
      parts.push(`<circle cx="${cx}" cy="${cy}" r="3" fill="${C.yesil}"/>`);
      parts.push(`<text x="${cx}" y="${cy + r + 20}" text-anchor="middle" font-size="9.5" fill="${C.metinKoyu}" font-weight="600">Bakı: ${esc(y.baki_yon)} (${Math.round(bakiDer)}°)</text>`);
    } else {
      parts.push(`<circle cx="${cx}" cy="${cy}" r="3" fill="${C.eksen}"/>`);
      parts.push(`<text x="${cx}" y="${cy + r + 20}" text-anchor="middle" font-size="9.5" fill="${C.metin}">Düz arazi</text>`);
    }
    return svgWrap(W, H + 16, parts.join(""));
  }

  function svgWrap(w, h, inner) {
    return `<svg viewBox="0 0 ${w} ${h}" width="100%" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg" font-family="system-ui,sans-serif">${inner}</svg>`;
  }

  window.Charts = { iklimDiyagrami, toprakKompozisyon, teksturUcgeni, topografyaKart, usdaTekstur };
})();
