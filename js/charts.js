// Graphiques en courbe, en SVG, sans bibliothèque externe.
// Chaque graphique se redessine à la largeur de son conteneur et suit le thème clair/sombre.

const HEIGHT = 210;
const PAD = { top: 16, right: 16, bottom: 28, left: 42 };
const hosts = new Set();

function fmt(n, decimals) {
  return n.toLocaleString("fr-FR", { maximumFractionDigits: decimals });
}

function fmtDate(t, long = false) {
  const d = new Date(t);
  return d.toLocaleDateString("fr-FR", long
    ? { day: "numeric", month: "long", year: "numeric" }
    : { day: "numeric", month: "short" });
}

function fmtDateAxis(t, spanDays) {
  const d = new Date(t);
  if (spanDays > 300) return d.toLocaleDateString("fr-FR", { month: "short", year: "2-digit" });
  return d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
}

// Pas « ronds » pour l'axe vertical (1, 2, 2,5, 5 × 10^n)
function niceStep(range, target = 4) {
  const raw = range / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const nice = norm < 1.5 ? 1 : norm < 2.25 ? 2 : norm < 3.5 ? 2.5 : norm < 7.5 ? 5 : 10;
  return nice * mag;
}

function draw(host) {
  const cfg = host._chart;
  if (!cfg) return;
  const { points, unit = "", decimals = 1, band = null, emptyText = "Pas encore de données." } = cfg;

  if (!points.length) {
    host.innerHTML = `<p class="chart-empty">${emptyText}</p>`;
    return;
  }

  const width = Math.max(260, host.clientWidth || 320);
  const w = width - PAD.left - PAD.right;
  const h = HEIGHT - PAD.top - PAD.bottom;

  const ys = points.map(p => p.y);
  let yMin = Math.min(...ys);
  let yMax = Math.max(...ys);
  if (yMin === yMax) { yMin -= Math.max(1, Math.abs(yMin) * 0.05); yMax += Math.max(1, Math.abs(yMax) * 0.05); }
  const margin = (yMax - yMin) * 0.15;
  yMin -= margin; yMax += margin;
  const step = niceStep(yMax - yMin);
  yMin = Math.floor(yMin / step) * step;
  yMax = Math.ceil(yMax / step) * step;

  const tMin = points[0].t;
  const tMax = points[points.length - 1].t;
  const single = tMin === tMax;
  const spanDays = (tMax - tMin) / 86400000;

  const x = t => PAD.left + (single ? w / 2 : ((t - tMin) / (tMax - tMin)) * w);
  const y = v => PAD.top + h - ((v - yMin) / (yMax - yMin)) * h;

  // Grille et graduations
  let grid = "";
  const tickDecimals = Number.isInteger(step) ? 0 : Number.isInteger(Math.round(step * 1e6) / 1e5) ? 1 : 2;
  const ticks = Math.round((yMax - yMin) / step);
  for (let k = 0; k <= ticks; k++) {
    const v = yMin + k * step;
    const yy = y(v).toFixed(1);
    grid += `<line class="chart-grid" x1="${PAD.left}" x2="${PAD.left + w}" y1="${yy}" y2="${yy}"></line>`;
    grid += `<text class="chart-tick" x="${PAD.left - 8}" y="${yy}" text-anchor="end" dominant-baseline="middle">${v.toLocaleString("fr-FR", { minimumFractionDigits: tickDecimals, maximumFractionDigits: tickDecimals })}</text>`;
  }

  // Zone de référence (ex. IMC normal)
  let bandSvg = "";
  if (band) {
    const lo = Math.max(band.from, yMin);
    const hi = Math.min(band.to, yMax);
    if (hi > lo) {
      bandSvg = `<rect class="chart-band" x="${PAD.left}" width="${w}" y="${y(hi).toFixed(1)}" height="${(y(lo) - y(hi)).toFixed(1)}"></rect>`;
      if (band.label) bandSvg += `<text class="chart-band-label" x="${PAD.left + w - 6}" y="${(y(hi) + 12).toFixed(1)}" text-anchor="end">${band.label}</text>`;
    }
  }

  // Dates en abscisse
  const xLabels = [];
  if (single) xLabels.push({ t: tMin, anchor: "middle" });
  else {
    xLabels.push({ t: tMin, anchor: "start" });
    if (points.length > 2 && width > 340) xLabels.push({ t: (tMin + tMax) / 2, anchor: "middle" });
    xLabels.push({ t: tMax, anchor: "end" });
  }
  const xAxis = xLabels.map(l =>
    `<text class="chart-tick" x="${x(l.t).toFixed(1)}" y="${HEIGHT - 8}" text-anchor="${l.anchor}">${fmtDateAxis(l.t, spanDays)}</text>`
  ).join("");

  const coords = points.map(p => [x(p.t), y(p.y)]);
  const line = coords.map((c, i) => `${i ? "L" : "M"}${c[0].toFixed(1)},${c[1].toFixed(1)}`).join("");
  const area = coords.length > 1
    ? `${line}L${coords[coords.length - 1][0].toFixed(1)},${PAD.top + h}L${coords[0][0].toFixed(1)},${PAD.top + h}Z`
    : "";
  const dots = coords.map((c, i) =>
    `<circle class="chart-dot" cx="${c[0].toFixed(1)}" cy="${c[1].toFixed(1)}" r="${i === coords.length - 1 ? 4.5 : 3}"></circle>`
  ).join("");

  host.innerHTML = `
    <div class="chart-readout" aria-live="polite"></div>
    <svg class="chart-svg" width="${width}" height="${HEIGHT}" viewBox="0 0 ${width} ${HEIGHT}" role="img" aria-label="${cfg.label || "Graphique d’évolution"}">
      ${bandSvg}${grid}
      ${area ? `<path class="chart-area" d="${area}"></path>` : ""}
      <path class="chart-line" d="${line}"></path>
      ${dots}
      <line class="chart-guide" x1="0" x2="0" y1="${PAD.top}" y2="${PAD.top + h}" visibility="hidden"></line>
      <circle class="chart-focus" r="6.5" visibility="hidden"></circle>
      ${xAxis}
      <rect class="chart-hit" x="${PAD.left - 10}" y="0" width="${w + 20}" height="${HEIGHT}" fill="transparent"></rect>
    </svg>`;

  const readout = host.querySelector(".chart-readout");
  const guide = host.querySelector(".chart-guide");
  const focus = host.querySelector(".chart-focus");
  const svg = host.querySelector("svg");

  const show = i => {
    const p = points[i];
    const [cx, cy] = coords[i];
    readout.innerHTML = `<strong>${fmt(p.y, decimals)}${unit ? " " + unit : ""}</strong> <span>${fmtDate(p.t, true)}</span>`;
    guide.setAttribute("x1", cx); guide.setAttribute("x2", cx); guide.setAttribute("visibility", "visible");
    focus.setAttribute("cx", cx); focus.setAttribute("cy", cy); focus.setAttribute("visibility", "visible");
  };
  const nearest = evt => {
    const rect = svg.getBoundingClientRect();
    const px = (evt.clientX - rect.left) * (width / rect.width);
    let best = 0;
    coords.forEach((c, i) => { if (Math.abs(c[0] - px) < Math.abs(coords[best][0] - px)) best = i; });
    return best;
  };
  const hit = host.querySelector(".chart-hit");
  hit.addEventListener("pointermove", e => show(nearest(e)));
  hit.addEventListener("pointerdown", e => show(nearest(e)));
  show(points.length - 1);
}

// Histogramme (ex. nombre de séances par semaine)
function drawBars(host) {
  const cfg = host._chart;
  const { bars, unitSingular = "", unitPlural = "" } = cfg;
  const width = Math.max(260, host.clientWidth || 320);
  const height = 170;
  const pad = { top: 14, right: 8, bottom: 26, left: 28 };
  const w = width - pad.left - pad.right;
  const h = height - pad.top - pad.bottom;
  const max = Math.max(2, ...bars.map(b => b.value));
  const step = max <= 4 ? 1 : max <= 10 ? 2 : Math.ceil(max / 4);
  const top = Math.ceil(max / step) * step;
  const slot = w / bars.length;
  const bw = Math.min(26, slot * 0.62);
  const y = v => pad.top + h - (v / top) * h;

  let grid = "";
  for (let v = 0; v <= top; v += step) {
    grid += `<line class="chart-grid" x1="${pad.left}" x2="${pad.left + w}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"></line>`;
    grid += `<text class="chart-tick" x="${pad.left - 7}" y="${y(v).toFixed(1)}" text-anchor="end" dominant-baseline="middle">${v}</text>`;
  }
  const every = bars.length > 8 ? Math.ceil(bars.length / 6) : 1;
  const rects = bars.map((b, i) => {
    const cx = pad.left + slot * i + slot / 2;
    const bh = Math.max(b.value ? 3 : 0, (b.value / top) * h);
    const label = ((bars.length - 1 - i) % every === 0)
      ? `<text class="chart-tick" x="${cx.toFixed(1)}" y="${height - 8}" text-anchor="middle">${b.label}</text>` : "";
    return `<rect class="chart-bar ${b.highlight ? "is-current" : ""}" data-i="${i}" x="${(cx - bw / 2).toFixed(1)}" y="${(pad.top + h - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="5"></rect>${label}`;
  }).join("");

  host.innerHTML = `
    <div class="chart-readout" aria-live="polite"></div>
    <svg class="chart-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${cfg.label || "Histogramme"}">
      ${grid}${rects}
      <rect class="chart-hit" x="${pad.left}" y="0" width="${w}" height="${height}" fill="transparent"></rect>
    </svg>`;
  const readout = host.querySelector(".chart-readout");
  const svg = host.querySelector("svg");
  const show = i => {
    const b = bars[i];
    host.querySelectorAll(".chart-bar").forEach(r => r.classList.toggle("is-focus", +r.dataset.i === i));
    readout.innerHTML = `<strong>${b.value} ${b.value > 1 ? unitPlural : unitSingular}</strong> <span>${b.detail || b.label}</span>`;
  };
  const pick = e => {
    const rect = svg.getBoundingClientRect();
    const px = (e.clientX - rect.left) * (width / rect.width) - pad.left;
    show(Math.max(0, Math.min(bars.length - 1, Math.floor(px / slot))));
  };
  const hit = host.querySelector(".chart-hit");
  hit.addEventListener("pointermove", pick);
  hit.addEventListener("pointerdown", pick);
  show(bars.length - 1);
}

function redraw(host) {
  if (host._chart?.kind === "bars") drawBars(host);
  else draw(host);
}

export function mountChart(host, config) {
  host._chart = config;
  host.classList.add("chart");
  hosts.add(host);
  draw(host);
}

export function mountBarChart(host, config) {
  host._chart = { ...config, kind: "bars" };
  host.classList.add("chart");
  hosts.add(host);
  drawBars(host);
}

let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    hosts.forEach(h => { if (!h.isConnected) hosts.delete(h); else redraw(h); });
  }, 120);
});
