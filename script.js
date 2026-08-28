/* Spendlight dashboard.
 *
 * data.js supplies ROWS (every transaction), plus the whole-dataset facts that
 * do not depend on the current filter: CATEGORY_TREE, RECURRING, MERCHANTS,
 * CURRENCY, META. Everything else is derived here, in the browser, so moving a
 * filter never waits on Python.
 */

// --- tokens ---------------------------------------------------------------

const CSS = getComputedStyle(document.documentElement);
const tok = (name) => CSS.getPropertyValue(name).trim();

const SLOTS = ['--s1', '--s2', '--s3', '--s4', '--s5', '--s6', '--s7', '--s8'].map(tok);
const OTHER = tok('--s-other');
const RAMP = ['--q1', '--q2', '--q3', '--q4', '--q5'].map(tok);
const EMPTY_CELL = tok('--q0');
const INK = tok('--ink'), INK2 = tok('--ink-2'), INK3 = tok('--ink-3');
const GRID = tok('--grid'), AXIS = tok('--axis'), SURFACE = tok('--surface');
const GOOD = tok('--good'), BAD = tok('--critical');

const DOW_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                     'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// --- formatting -----------------------------------------------------------

function group(intPart) {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, CURRENCY.thousands);
}

function fmt(n, decimals) {
  const dec = decimals === undefined ? CURRENCY.decimals : decimals;
  const parts = Math.abs(n).toFixed(dec).split('.');
  const body = group(parts[0]) + (parts[1] ? '.' + parts[1] : '');
  const sign = n < 0 ? '−' : '';
  return CURRENCY.position === 'prefix'
    ? sign + CURRENCY.symbol + body
    : sign + body + ' ' + CURRENCY.symbol;
}

/** Axis ticks: short enough not to crowd, still honest about scale. */
function compact(n) {
  const a = Math.abs(n);
  if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'k';
  return String(Math.round(n));
}

const pct = (n) => (n * 100).toFixed(1) + '%';
const sum = (list, pick) => list.reduce((acc, item) => acc + (pick ? pick(item) : item), 0);

/* toISOString() is UTC: local midnight in a positive offset stringifies to the
 * previous day, which would slide every calendar cell one square left. */
function isoLocal(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function prettyDate(iso) {
  const [y, m, d] = iso.split('-');
  return `${Number(d)} ${MONTH_NAMES[Number(m) - 1]} ${y}`;
}
function prettyMonth(ym) {
  const [y, m] = ym.split('-');
  return `${MONTH_NAMES[Number(m) - 1]} ${y}`;
}

/** White or near-black, whichever clears contrast on the given fill. */
function inkOn(hex) {
  const c = hex.replace('#', '');
  const v = [0, 1, 2].map((i) => {
    const channel = parseInt(c.substr(i * 2, 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
  });
  const lum = 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  return lum > 0.42 ? '#0b1121' : '#ffffff';
}

// --- colour assignment ----------------------------------------------------

/* Colour follows the entity, never its rank inside the current filter: the map
 * is built once from the full dataset, so filtering never repaints a survivor.
 * Only the eight biggest parents get a hue — the palette has eight slots and
 * cycling past them would produce colours nobody can tell apart. The long tail
 * shares one neutral. */
const PARENT_COLOR = (() => {
  const totals = new Map();
  for (const row of ROWS) {
    totals.set(row.parent, (totals.get(row.parent) || 0) + row.amt);
  }
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const map = new Map();
  ranked.forEach(([parent], index) => {
    map.set(parent, index < SLOTS.length ? SLOTS[index] : OTHER);
  });
  return map;
})();

const NAMED_PARENTS = [...PARENT_COLOR.keys()].slice(0, SLOTS.length);
const colorFor = (parent) => PARENT_COLOR.get(parent) || OTHER;

// --- state ----------------------------------------------------------------

const S = {
  from: META.first,
  to: META.last,
  parent: '',
  cat: '',
  merchant: '',
  day: '',
  q: '',
  kind: 'expense',
  drill: null,
  tab: 'cat',
  txnLimit: 250,
  sort: { key: 'date', dir: -1 },
};

/** Everything except the income/expense switch — the KPI row needs both sides. */
function baseRows() {
  const q = S.q.toLowerCase();
  return ROWS.filter((r) =>
    r.date >= S.from && r.date <= S.to &&
    (!S.parent || r.parent === S.parent) &&
    (!S.cat || r.cat === S.cat) &&
    (!S.merchant || r.cp === S.merchant) &&
    (!S.day || r.date === S.day) &&
    (!q || (r.cp + ' ' + r.cat).toLowerCase().includes(q)));
}

/** The slice the charts draw, honouring the Expenses / Income / Both switch. */
function viewRows() {
  const rows = baseRows();
  return S.kind === 'all' ? rows : rows.filter((r) => r.kind === S.kind);
}

const isSpend = () => S.kind !== 'income';

// --- tooltip (for the hand-drawn SVG charts) ------------------------------

const TIP = document.getElementById('tip');

function showTip(event, title, rows) {
  TIP.textContent = '';
  const head = document.createElement('div');
  head.className = 't-title';
  head.textContent = title;                      // labels are data — never innerHTML
  TIP.appendChild(head);
  for (const row of rows) {
    const line = document.createElement('div');
    line.className = 't-row';
    if (row.color) {
      const key = document.createElement('span');
      key.className = 't-key';
      key.style.background = row.color;
      line.appendChild(key);
    }
    const value = document.createElement('span');
    value.className = 't-val';
    value.textContent = row.value;
    line.appendChild(value);
    if (row.name) {
      const name = document.createElement('span');
      name.className = 't-name';
      name.textContent = row.name;
      line.appendChild(name);
    }
    TIP.appendChild(line);
  }
  TIP.style.opacity = '1';
  moveTip(event);
}

function moveTip(event) {
  const box = TIP.getBoundingClientRect();
  let x = event.clientX + 14;
  let y = event.clientY + 14;
  if (x + box.width > window.innerWidth - 8) x = event.clientX - box.width - 14;
  if (y + box.height > window.innerHeight - 8) y = event.clientY - box.height - 14;
  TIP.style.left = x + 'px';
  TIP.style.top = y + 'px';
}

const hideTip = () => { TIP.style.opacity = '0'; };

// --- Chart.js defaults ----------------------------------------------------

Chart.defaults.font.family = "'Inter', system-ui, sans-serif";
Chart.defaults.font.size = 12;
Chart.defaults.color = INK2;
Chart.defaults.animation.duration = 260;
Chart.defaults.maintainAspectRatio = false;

const charts = {};

function draw(id, config) {
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart(document.getElementById(id), config);
  return charts[id];
}

const tooltipStyle = {
  backgroundColor: '#0a1020',
  borderColor: GRID,
  borderWidth: 1,
  titleColor: INK2,
  titleFont: { size: 11, weight: '500' },
  bodyColor: INK,
  bodyFont: { size: 12, weight: '600' },
  padding: 10,
  cornerRadius: 8,
  displayColors: true,
  boxWidth: 12,
  boxHeight: 2,
  usePointStyle: false,
};

/** Hairline, solid, one step off the surface — never dashed. */
function valueAxis(extra) {
  return Object.assign({
    grid: { color: GRID, drawTicks: false, lineWidth: 1 },
    border: { display: false },
    ticks: { color: INK3, padding: 8, callback: (v) => compact(v) },
  }, extra || {});
}

function catAxis(extra) {
  return Object.assign({
    grid: { display: false },
    border: { color: AXIS },
    ticks: { color: INK3, padding: 6, autoSkip: false },
  }, extra || {});
}

/* 4px rounded data-end, square at the baseline; capped thickness so the band
 * keeps some air. A 2px ring in the surface colour is the gap between
 * neighbouring and stacked bars — never a border drawn to separate them. */
const barMark = {
  borderRadius: 4,
  borderSkipped: 'start',
  maxBarThickness: 24,
  borderWidth: 2,
  borderColor: SURFACE,
};

// --- table views ----------------------------------------------------------

/* Every chart has a table twin, so no value is reachable only by hovering. */
const TABLES = {};

function setTable(key, head, rows, opts) {
  TABLES[key] = { head, rows, opts: opts || {} };
  const host = document.getElementById(key + '-table');
  if (host && !host.hidden) paintTable(key);
}

function paintTable(key) {
  const spec = TABLES[key];
  const host = document.getElementById(key + '-table');
  if (!spec || !host) return;
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  for (const label of spec.head) {
    const th = document.createElement('th');
    th.textContent = label;
    th.style.cursor = 'default';
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  for (const row of spec.rows) {
    const tr = document.createElement('tr');
    for (const cell of row) {
      const td = document.createElement('td');
      td.textContent = cell;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  host.textContent = '';
  host.appendChild(table);
}

document.querySelectorAll('.tbtn[data-table]').forEach((button) => {
  button.addEventListener('click', () => {
    const key = button.dataset.table;
    const host = document.getElementById(key + '-table');
    const card = button.closest('.card');
    const plot = card.querySelector('.plot, #tm-plot, #cal-plot');
    const showTable = host.hidden;
    host.hidden = !showTable;
    if (plot) plot.hidden = showTable;
    const crumb = card.querySelector('.crumb');
    if (crumb) crumb.hidden = showTable;
    button.setAttribute('aria-pressed', String(showTable));
    button.textContent = showTable ? 'Chart' : 'Table';
    if (showTable) paintTable(key);
  });
});

// --- KPI row --------------------------------------------------------------

function renderKpis() {
  const rows = baseRows();
  const spend = sum(rows.filter((r) => r.kind === 'expense'), (r) => r.amt);
  const income = sum(rows.filter((r) => r.kind === 'income'), (r) => r.amt);
  const net = income - spend;
  const months = new Set(rows.map((r) => r.ym)).size || 1;
  const rate = income > 0 ? net / income : null;

  const tiles = [
    { label: 'Total spent', value: fmt(spend), note: `${months} month${months === 1 ? '' : 's'} in view`, hero: true },
    { label: 'Income', value: fmt(income), note: income ? `${fmt(income / months)} a month` : 'none in range' },
    { label: 'Net saved', value: fmt(net), note: 'income minus spending', tone: net >= 0 ? 'up' : 'down' },
    { label: 'Savings rate', value: rate === null ? '—' : pct(rate), note: rate === null ? 'no income in range' : 'of income kept', tone: rate === null ? undefined : (rate >= 0 ? 'up' : 'down') },
    { label: 'Avg spend / month', value: fmt(spend / months), note: `${fmt(spend / Math.max(1, daysInView()))} a day` },
    { label: 'Transactions', value: group(String(rows.length)), note: (() => {
        const n = new Set(rows.map((r) => r.cp).filter(Boolean)).size;
        return `${n} merchant${n === 1 ? '' : 's'}`;
      })() },
  ];

  const host = document.getElementById('kpis');
  host.textContent = '';
  for (const tile of tiles) {
    const box = document.createElement('div');
    box.className = 'kpi' + (tile.hero ? ' hero' : '');
    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = tile.label;
    const value = document.createElement('div');
    value.className = 'value' + (tile.tone ? ' ' + tile.tone : '');
    value.textContent = tile.value;
    const note = document.createElement('div');
    note.className = 'note';
    note.textContent = tile.note;
    box.append(label, value, note);
    host.appendChild(box);
  }
}

function daysInView() {
  const from = new Date(S.from), to = new Date(S.to);
  return Math.round((to - from) / 86400000) + 1;
}

// --- monthly aggregates ---------------------------------------------------

function monthsInView() {
  const seen = new Set(baseRows().map((r) => r.ym));
  return [...seen].sort();
}

function byMonth(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.ym)) map.set(row.ym, { spend: 0, income: 0, n: 0 });
    const bucket = map.get(row.ym);
    if (row.kind === 'expense') bucket.spend += row.amt; else bucket.income += row.amt;
    bucket.n += 1;
  }
  return map;
}

// ==========================================================================
//  TAB 1 — Categories
// ==========================================================================

function worstRatio(row, short, scale) {
  const areas = row.map((item) => item.value * scale);
  const total = sum(areas);
  const biggest = Math.max(...areas), smallest = Math.min(...areas);
  return Math.max((short * short * biggest) / (total * total),
                  (total * total) / (short * short * smallest));
}

/** Squarified treemap: keeps tiles close to square so areas stay comparable. */
function squarify(items, x, y, w, h) {
  const placed = [];
  const queue = items.filter((i) => i.value > 0).slice().sort((a, b) => b.value - a.value);
  const total = sum(queue, (i) => i.value);
  if (!total || w <= 0 || h <= 0) return placed;
  const scale = (w * h) / total;

  let [rx, ry, rw, rh] = [x, y, w, h];
  while (queue.length && rw > 0.5 && rh > 0.5) {
    const short = Math.min(rw, rh);
    let row = [], best = Infinity;
    while (queue.length) {
      const candidate = row.concat([queue[0]]);
      const ratio = worstRatio(candidate, short, scale);
      if (row.length && ratio > best) break;
      best = ratio;
      row = candidate;
      queue.shift();
    }
    const thickness = (sum(row, (i) => i.value) * scale) / short;
    let offset = 0;
    for (const item of row) {
      const length = (item.value * scale) / thickness;
      placed.push(rw >= rh
        ? Object.assign({}, item, { x: rx, y: ry + offset, w: thickness, h: length })
        : Object.assign({}, item, { x: rx + offset, y: ry, w: length, h: thickness }));
      offset += length;
    }
    if (rw >= rh) { rx += thickness; rw -= thickness; }
    else { ry += thickness; rh -= thickness; }
  }
  return placed;
}

function svgEl(name, attrs) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const key in attrs) node.setAttribute(key, attrs[key]);
  return node;
}

function renderTreemap() {
  const host = document.getElementById('tm-plot');
  const crumb = document.getElementById('tm-crumb');
  const rows = viewRows();

  // Breadcrumb — how you get back out of a drill-down.
  crumb.textContent = '';
  const root = document.createElement('button');
  root.textContent = 'All categories';
  root.addEventListener('click', () => { S.drill = null; render(); });
  crumb.appendChild(root);
  if (S.drill) {
    const sep = document.createElement('span');
    sep.textContent = '›';
    const here = document.createElement('span');
    here.textContent = S.drill;
    here.style.color = INK;
    crumb.append(sep, here);
  }

  const totals = new Map();
  for (const row of rows) {
    if (S.drill && row.parent !== S.drill) continue;
    const id = S.drill ? row.cat : row.parent;
    if (!totals.has(id)) {
      totals.set(id, {
        name: S.drill ? (row.child || '(no subcategory)') : row.parent,
        value: 0,
        cat: id,
      });
    }
    totals.get(id).value += row.amt;
  }
  const items = [...totals.values()].sort((a, b) => b.value - a.value);
  const grand = sum(items, (i) => i.value);

  setTable('tm', [S.drill ? 'Subcategory' : 'Category', 'Total', 'Share'],
    items.map((i) => [i.name, fmt(i.value), pct(grand ? i.value / grand : 0)]));

  host.textContent = '';
  if (!items.length) {
    const none = document.createElement('div');
    none.className = 'empty';
    none.textContent = 'Nothing in this selection.';
    host.appendChild(none);
    return;
  }

  const width = Math.max(320, host.clientWidth || 900);
  const height = Math.max(260, Math.min(460, Math.round(width * 0.42)));
  const svg = svgEl('svg', { width: '100%', height, viewBox: `0 0 ${width} ${height}` });
  const tiles = squarify(items, 0, 0, width, height);

  for (const tile of tiles) {
    const fill = S.drill ? colorFor(S.drill) : colorFor(tile.name);
    const group = svgEl('g', { class: 'tile', tabindex: '0', role: 'button' });
    group.setAttribute('aria-label', `${tile.name}, ${fmt(tile.value)}`);

    // 2px surface gap — the separator is space, not a stroke on the mark.
    group.appendChild(svgEl('rect', {
      x: tile.x + 1, y: tile.y + 1,
      width: Math.max(0, tile.w - 2), height: Math.max(0, tile.h - 2),
      rx: 4, fill,
    }));

    // A label only where it genuinely fits; otherwise the tooltip and the
    // table carry it, rather than clipping the text.
    const label = tile.name;
    const roomForText = tile.w > label.length * 7.4 + 18 && tile.h > 28;
    if (roomForText) {
      const textInk = inkOn(fill);
      const name = svgEl('text', {
        x: tile.x + 10, y: tile.y + 22,
        fill: textInk, 'font-size': 13, 'font-weight': 600,
      });
      name.textContent = label;
      group.appendChild(name);
      if (tile.h > 48) {
        const value = svgEl('text', {
          x: tile.x + 10, y: tile.y + 40,
          fill: textInk, 'font-size': 12, 'fill-opacity': 0.82,
        });
        value.textContent = fmt(tile.value);
        group.appendChild(value);
      }
    }

    const share = grand ? tile.value / grand : 0;
    const onEnter = (event) => showTip(event, tile.name, [
      { color: fill, value: fmt(tile.value), name: pct(share) + ' of shown' },
    ]);
    group.addEventListener('pointerenter', onEnter);
    group.addEventListener('pointermove', moveTip);
    group.addEventListener('pointerleave', hideTip);
    group.addEventListener('focus', () => {
      const box = group.getBoundingClientRect();
      onEnter({ clientX: box.left + 12, clientY: box.top + 12 });
    });
    group.addEventListener('blur', hideTip);

    const activate = () => {
      hideTip();
      if (S.drill) {
        S.cat = tile.cat;
        S.parent = '';
        S.drill = null;
        syncControls();
      } else {
        const named = (CATEGORY_TREE[tile.name] || []).filter(Boolean);
        if (named.length) {
          S.drill = tile.name;
        } else {
          S.parent = tile.name;
          S.cat = '';
          syncControls();
        }
      }
      render();
    };
    group.addEventListener('click', activate);
    group.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
    });
    svg.appendChild(group);
  }
  host.appendChild(svg);
}

function renderStack() {
  const months = monthsInView();
  const rows = viewRows();

  // Eight hues is the ceiling; a ninth would be a colour nobody can name.
  // The tail becomes one honest "Other" series rather than a cycled hue.
  const totals = new Map();
  for (const row of rows) totals.set(row.parent, (totals.get(row.parent) || 0) + row.amt);
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p);
  const named = ranked.slice(0, 7);
  const hasTail = ranked.length > 7;

  const series = named.map((parent) => ({
    label: parent,
    data: months.map((ym) => sum(rows.filter((r) => r.ym === ym && r.parent === parent), (r) => r.amt)),
    backgroundColor: colorFor(parent),
  }));
  if (hasTail) {
    series.push({
      label: 'Other',
      data: months.map((ym) => sum(rows.filter((r) => r.ym === ym && !named.includes(r.parent)), (r) => r.amt)),
      backgroundColor: OTHER,
    });
  }
  series.forEach((s) => Object.assign(s, barMark));

  setTable('stack', ['Month', ...series.map((s) => s.label), 'Total'],
    months.map((ym, i) => [prettyMonth(ym), ...series.map((s) => fmt(s.data[i])),
      fmt(sum(series, (s) => s.data[i]))]));

  draw('c-stack', {
    type: 'bar',
    data: { labels: months.map(prettyMonth), datasets: series },
    options: {
      scales: {
        x: catAxis({ stacked: true, ticks: { color: INK3, maxRotation: 60, minRotation: 0, autoSkip: true } }),
        y: valueAxis({ stacked: true, beginAtZero: true }),
      },
      plugins: {
        legend: { display: true, position: 'bottom', labels: { color: INK2, boxWidth: 11, boxHeight: 11, usePointStyle: false, padding: 14 } },
        tooltip: Object.assign({ mode: 'index', intersect: false }, tooltipStyle, {
          callbacks: {
            label: (ctx) => ` ${ctx.dataset.label}: ${fmt(ctx.parsed.y)}`,
            footer: (items) => 'Total ' + fmt(sum(items, (i) => i.parsed.y)),
          },
          footerColor: INK2, footerFont: { size: 11, weight: '500' },
        }),
      },
    },
  });
}

function renderLeafBars() {
  const rows = viewRows();
  const totals = new Map();
  for (const row of rows) totals.set(row.cat, (totals.get(row.cat) || 0) + row.amt);
  const top = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);

  setTable('leaf', ['Subcategory', 'Total'], top.map(([cat, v]) => [cat, fmt(v)]));

  // One series, one colour: bar length already encodes magnitude, so shading
  // it by size too would spend the colour channel on nothing.
  draw('c-leaf', {
    type: 'bar',
    data: {
      labels: top.map(([cat]) => cat),
      datasets: [Object.assign({
        label: 'Spend',
        data: top.map(([, v]) => v),
        backgroundColor: SLOTS[0],
      }, barMark)],
    },
    options: {
      indexAxis: 'y',
      onClick: (_e, els) => {
        if (!els.length) return;
        S.cat = top[els[0].index][0];
        S.parent = '';
        S.drill = null;
        syncControls();
        render();
      },
      scales: {
        x: valueAxis({ beginAtZero: true }),
        y: catAxis({ ticks: { color: INK2, font: { size: 11 }, autoSkip: false } }),
      },
      plugins: {
        legend: { display: false },
        tooltip: Object.assign({}, tooltipStyle, {
          callbacks: { label: (ctx) => ' ' + fmt(ctx.parsed.x) },
        }),
      },
    },
  });
}

// ==========================================================================
//  TAB 2 — Trends
// ==========================================================================

function renderFlow() {
  const months = monthsInView();
  const stats = byMonth(baseRows());
  const income = months.map((ym) => (stats.get(ym) || {}).income || 0);
  const spend = months.map((ym) => (stats.get(ym) || {}).spend || 0);
  const net = months.map((_, i) => income[i] - spend[i]);

  setTable('flow', ['Month', 'Income', 'Spent', 'Net', 'Savings rate'],
    months.map((ym, i) => [prettyMonth(ym), fmt(income[i]), fmt(spend[i]), fmt(net[i]),
      income[i] > 0 ? pct(net[i] / income[i]) : '—']));

  // Three measures, one currency, one axis. A second y-scale would invent a
  // relationship between them that the data does not contain.
  draw('c-flow', {
    type: 'bar',
    data: {
      labels: months.map(prettyMonth),
      datasets: [
        Object.assign({ label: 'Income', data: income, backgroundColor: SLOTS[0] }, barMark),
        Object.assign({ label: 'Spent', data: spend, backgroundColor: SLOTS[1] }, barMark),
        {
          label: 'Net saved', data: net, type: 'line',
          borderColor: SLOTS[2], backgroundColor: SLOTS[2],
          borderWidth: 2, tension: 0.25,
          pointRadius: 4, pointHoverRadius: 6,
          pointBorderColor: SURFACE, pointBorderWidth: 2,
        },
      ],
    },
    options: {
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: catAxis({ ticks: { color: INK3, autoSkip: true, maxRotation: 60 } }),
        y: valueAxis(),
      },
      plugins: {
        legend: { display: true, position: 'bottom', labels: { color: INK2, boxWidth: 11, boxHeight: 11, padding: 14 } },
        tooltip: Object.assign({}, tooltipStyle, {
          callbacks: { label: (ctx) => ` ${ctx.dataset.label}: ${fmt(ctx.parsed.y)}` },
        }),
      },
    },
  });

  const noIncome = months.filter((ym) => !((stats.get(ym) || {}).income));
  document.getElementById('flow-note').textContent = noIncome.length
    ? `No income recorded in ${noIncome.map(prettyMonth).join(', ')} — the savings rate is not meaningful there.`
    : '';
}

function renderRate() {
  const months = monthsInView();
  const stats = byMonth(baseRows());
  const rate = months.map((ym) => {
    const bucket = stats.get(ym) || { income: 0, spend: 0 };
    return bucket.income > 0 ? ((bucket.income - bucket.spend) / bucket.income) * 100 : null;
  });
  // Rolling mean over the months that actually have income — a month with no
  // salary row is a gap, not a zero, and averaging it in would drag the line down.
  const rolling = rate.map((_, i) => {
    const window = rate.slice(Math.max(0, i - 2), i + 1).filter((v) => v !== null);
    return window.length ? sum(window) / window.length : null;
  });

  setTable('rate', ['Month', 'Savings rate', '3-month average'],
    months.map((ym, i) => [prettyMonth(ym),
      rate[i] === null ? '—' : rate[i].toFixed(1) + '%',
      rolling[i] === null ? '—' : rolling[i].toFixed(1) + '%']));

  draw('c-rate', {
    type: 'line',
    data: {
      labels: months.map(prettyMonth),
      datasets: [
        {
          label: 'Monthly', data: rate, spanGaps: true,
          borderColor: SLOTS[0], backgroundColor: SLOTS[0] + '1a',
          borderWidth: 2, tension: 0.25, fill: true,
          pointRadius: 4, pointHoverRadius: 6,
          pointBorderColor: SURFACE, pointBorderWidth: 2,
        },
        {
          label: '3-month average', data: rolling, spanGaps: true,
          borderColor: SLOTS[3], borderWidth: 2, tension: 0.35,
          pointRadius: 0, pointHoverRadius: 5, fill: false,
        },
      ],
    },
    options: {
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: catAxis({ ticks: { color: INK3, autoSkip: true, maxRotation: 60 } }),
        y: valueAxis({ ticks: { color: INK3, padding: 8, callback: (v) => v + '%' } }),
      },
      plugins: {
        legend: { display: true, position: 'bottom', labels: { color: INK2, boxWidth: 14, boxHeight: 3, padding: 14 } },
        tooltip: Object.assign({}, tooltipStyle, {
          callbacks: {
            label: (ctx) => ctx.parsed.y === null ? ` ${ctx.dataset.label}: no income`
              : ` ${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)}%`,
          },
        }),
      },
    },
  });
}

function median(list) {
  if (!list.length) return 0;
  const sorted = list.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function renderMoM() {
  const months = monthsInView();
  const rows = viewRows();
  const parents = [...new Set(rows.map((r) => r.parent))];
  const totals = new Map(parents.map((p) => [p, sum(rows.filter((r) => r.parent === p), (r) => r.amt)]));
  parents.sort((a, b) => totals.get(b) - totals.get(a));

  const host = document.getElementById('mom-table');
  host.textContent = '';
  if (!months.length || !parents.length) {
    const none = document.createElement('div');
    none.className = 'empty';
    none.textContent = 'Nothing in this selection.';
    host.appendChild(none);
    return;
  }

  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  ['Category', ...months.map(prettyMonth), 'Total'].forEach((label) => {
    const th = document.createElement('th');
    th.textContent = label;
    th.style.cursor = 'default';
    hr.appendChild(th);
  });
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const parent of parents) {
    const values = months.map((ym) =>
      sum(rows.filter((r) => r.ym === ym && r.parent === parent), (r) => r.amt));
    const mid = median(values.filter((v) => v > 0));
    const tr = document.createElement('tr');

    const nameCell = document.createElement('td');
    const link = document.createElement('span');
    link.className = 'clickable';
    link.textContent = parent;
    link.setAttribute('role', 'button');
    link.tabIndex = 0;
    const pick = () => { S.parent = parent; S.cat = ''; S.drill = null; syncControls(); render(); };
    link.addEventListener('click', pick);
    link.addEventListener('keydown', (e) => { if (e.key === 'Enter') pick(); });
    const swatch = document.createElement('i');
    swatch.style.cssText = `display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:8px;background:${colorFor(parent)}`;
    nameCell.append(swatch, link);
    tr.appendChild(nameCell);

    values.forEach((value) => {
      const td = document.createElement('td');
      td.textContent = value ? fmt(value) : '·';
      // Sequential wash: heavier than this category's own typical month reads
      // stronger. The number is always present, so colour is never the only cue.
      if (value > 0 && mid > 0) {
        const heat = Math.max(0, Math.min(1, (value / mid - 0.6) / 1.4));
        if (heat > 0.02) td.style.background = `rgba(57,135,229,${(heat * 0.5).toFixed(3)})`;
      }
      tr.appendChild(td);
    });

    const totalCell = document.createElement('td');
    totalCell.textContent = fmt(totals.get(parent));
    totalCell.style.fontWeight = '600';
    tr.appendChild(totalCell);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  host.appendChild(table);
}

// ==========================================================================
//  TAB 3 — Merchants & recurring
// ==========================================================================

function sparkline(history) {
  const width = 190, height = 34, pad = 3;
  const values = history.map((h) => h.amt);
  const lo = Math.min(...values), hi = Math.max(...values);
  const span = hi - lo || 1;
  const svg = svgEl('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img' });
  svg.setAttribute('aria-label', `${history.length} charges, ${fmt(lo)} to ${fmt(hi)}`);
  const step = history.length > 1 ? (width - pad * 2) / (history.length - 1) : 0;
  const points = history.map((h, i) => [
    pad + i * step,
    height - pad - ((h.amt - lo) / span) * (height - pad * 2),
  ]);
  svg.appendChild(svgEl('polyline', {
    points: points.map((p) => p.join(',')).join(' '),
    fill: 'none', stroke: SLOTS[0], 'stroke-width': 2,
    'stroke-linejoin': 'round', 'stroke-linecap': 'round',
  }));
  const last = points[points.length - 1];
  svg.appendChild(svgEl('circle', {
    cx: last[0], cy: last[1], r: 4,
    fill: SLOTS[0], stroke: tok('--surface-2'), 'stroke-width': 2,
  }));
  return svg;
}

function renderRecurring() {
  const host = document.getElementById('rec-list');
  host.textContent = '';
  document.getElementById('rec-count').textContent =
    RECURRING.length + ' found · ' + fmt(sum(RECURRING, (r) => r.annual)) + ' a year';

  if (!RECURRING.length) {
    const none = document.createElement('div');
    none.className = 'empty';
    none.textContent = 'No recurring charges detected.';
    host.appendChild(none);
    return;
  }

  for (const item of RECURRING) {
    const card = document.createElement('div');
    card.className = 'sub-card';

    const name = document.createElement('div');
    name.className = 'name clickable';
    name.textContent = item.cp;
    name.setAttribute('role', 'button');
    name.tabIndex = 0;
    const pick = () => { S.merchant = item.cp; syncControls(); render(); };
    name.addEventListener('click', pick);
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') pick(); });

    const cat = document.createElement('div');
    cat.className = 'cat';
    cat.textContent = item.cat;

    const cost = document.createElement('div');
    cost.className = 'cost';
    cost.textContent = fmt(item.avg) + ' / mo';

    const year = document.createElement('div');
    year.className = 'yr';
    year.textContent = `${fmt(item.annual)} a year · ${item.n} charges over ${item.months} months`;

    card.append(name, cat, cost, year, sparkline(item.history));
    host.appendChild(card);
  }
}

function renderMerchants() {
  const rows = viewRows().filter((r) => r.cp);
  const totals = new Map();
  for (const row of rows) {
    if (!totals.has(row.cp)) totals.set(row.cp, { total: 0, n: 0 });
    const bucket = totals.get(row.cp);
    bucket.total += row.amt;
    bucket.n += 1;
  }
  const top = [...totals.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 25);

  setTable('merch', ['Merchant', 'Total', 'Visits', 'Average'],
    top.map(([cp, v]) => [cp, fmt(v.total), String(v.n), fmt(v.total / v.n)]));

  draw('c-merch', {
    type: 'bar',
    data: {
      labels: top.map(([cp]) => cp),
      datasets: [Object.assign({
        label: 'Spend', data: top.map(([, v]) => v.total), backgroundColor: SLOTS[0],
      }, barMark)],
    },
    options: {
      indexAxis: 'y',
      onClick: (_e, els) => { if (els.length) { S.merchant = top[els[0].index][0]; syncControls(); render(); } },
      scales: {
        x: valueAxis({ beginAtZero: true }),
        y: catAxis({ ticks: { color: INK2, font: { size: 11 }, autoSkip: false } }),
      },
      plugins: {
        legend: { display: false },
        tooltip: Object.assign({}, tooltipStyle, {
          callbacks: {
            label: (ctx) => {
              const stat = top[ctx.dataIndex][1];
              return [` ${fmt(stat.total)}`, ` ${stat.n} visits · ${fmt(stat.total / stat.n)} average`];
            },
          },
        }),
      },
    },
  });
}

// ==========================================================================
//  TAB 4 — Calendar & transactions
// ==========================================================================

function renderCalendar() {
  const host = document.getElementById('cal-plot');
  const rows = viewRows();
  const perDay = new Map();
  for (const row of rows) {
    if (!perDay.has(row.date)) perDay.set(row.date, { total: 0, n: 0 });
    const bucket = perDay.get(row.date);
    bucket.total += row.amt;
    bucket.n += 1;
  }

  const busiest = [...perDay.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 20);
  setTable('cal', ['Day', 'Spend', 'Transactions'],
    busiest.map(([date, v]) => [prettyDate(date), fmt(v.total), String(v.n)]));

  host.textContent = '';
  if (!perDay.size) {
    const none = document.createElement('div');
    none.className = 'empty';
    none.textContent = 'Nothing in this selection.';
    host.appendChild(none);
    return;
  }

  // Quintiles of the days that actually had spending: an even split beats a
  // linear scale here, where a handful of huge days would flatten everything else.
  const amounts = [...perDay.values()].map((v) => v.total).sort((a, b) => a - b);
  const cuts = [0.2, 0.4, 0.6, 0.8].map((q) => amounts[Math.floor(q * (amounts.length - 1))]);
  const bucketOf = (value) => {
    let index = 0;
    while (index < cuts.length && value > cuts[index]) index++;
    return index;
  };

  const CELL = 12, GAP = 3, PITCH = CELL + GAP, TOP = 20, LEFT = 32;
  const start = new Date(S.from + 'T00:00:00');
  const end = new Date(S.to + 'T00:00:00');
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));   // back to Monday

  const weeks = Math.max(1, Math.round((end - start) / (7 * 86400000)) + 1);
  const width = LEFT + weeks * PITCH + 8;
  const height = TOP + 7 * PITCH + 6;

  const scroller = document.createElement('div');
  scroller.style.overflowX = 'auto';
  const svg = svgEl('svg', { width, height, viewBox: `0 0 ${width} ${height}` });

  DOW_NAMES.forEach((name, i) => {
    if (i % 2) return;                                    // every other row, to stay quiet
    const label = svgEl('text', {
      x: 0, y: TOP + i * PITCH + CELL - 2, fill: INK3, 'font-size': 10,
    });
    label.textContent = name;
    svg.appendChild(label);
  });

  // A month is labelled at the week holding its 1st, and only if that week is
  // far enough from the last label to not collide. The grid starts on the Monday
  // before the range, so the leading partial month gets no label of its own.
  let lastLabelWeek = -99;
  const cursor = new Date(start);
  for (let week = 0; week < weeks; week++) {
    for (let day = 0; day < 7; day++) {
      const iso = isoLocal(cursor);
      const inRange = iso >= S.from && iso <= S.to;
      const stat = perDay.get(iso);
      const x = LEFT + week * PITCH, y = TOP + day * PITCH;

      if (cursor.getDate() === 1 && week - lastLabelWeek >= 3 && isoLocal(cursor) <= S.to) {
        lastLabelWeek = week;
        const month = cursor.getMonth();
        const label = svgEl('text', { x, y: TOP - 7, fill: INK3, 'font-size': 10 });
        label.textContent = month === 0
          ? `${MONTH_NAMES[month]} ${String(cursor.getFullYear()).slice(2)}`
          : MONTH_NAMES[month];
        svg.appendChild(label);
      }

      const fill = !inRange ? 'transparent' : (stat ? RAMP[bucketOf(stat.total)] : EMPTY_CELL);
      const rect = svgEl('rect', {
        x, y, width: CELL, height: CELL, rx: 2.5, fill,
        class: inRange ? 'cell' : '',
      });
      if (inRange) {
        rect.setAttribute('tabindex', '0');
        rect.setAttribute('role', 'button');
        rect.setAttribute('aria-label',
          `${prettyDate(iso)}: ${stat ? fmt(stat.total) : 'nothing'}`);
        const onEnter = (event) => showTip(event, prettyDate(iso), stat
          ? [{ color: fill, value: fmt(stat.total), name: `${stat.n} transaction${stat.n === 1 ? '' : 's'}` }]
          : [{ value: 'Nothing spent' }]);
        rect.addEventListener('pointerenter', onEnter);
        rect.addEventListener('pointermove', moveTip);
        rect.addEventListener('pointerleave', hideTip);
        rect.addEventListener('blur', hideTip);
        const activate = () => { hideTip(); S.day = S.day === iso ? '' : iso; syncControls(); render(); };
        rect.addEventListener('click', activate);
        rect.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
        });
        if (S.day === iso) {
          rect.setAttribute('stroke', INK);
          rect.setAttribute('stroke-width', '2');
        }
      }
      svg.appendChild(rect);
      cursor.setDate(cursor.getDate() + 1);
    }
  }
  scroller.appendChild(svg);
  host.appendChild(scroller);

  // Scale legend — a colour scale always says what its steps mean.
  const legend = document.createElement('div');
  legend.className = 'legend';
  const less = document.createElement('span');
  less.textContent = 'Quiet';
  legend.appendChild(less);
  RAMP.forEach((color, i) => {
    const item = document.createElement('span');
    const swatch = document.createElement('i');
    swatch.style.background = color;
    const upTo = i < cuts.length ? '≤ ' + fmt(cuts[i]) : '> ' + fmt(cuts[cuts.length - 1]);
    item.append(swatch, document.createTextNode(upTo));
    legend.appendChild(item);
  });
  const more = document.createElement('span');
  more.textContent = 'Heavy';
  legend.appendChild(more);
  host.appendChild(legend);
}

function renderRhythm() {
  const rows = viewRows();

  const dow = DOW_NAMES.map((_, i) => sum(rows.filter((r) => r.dow === i), (r) => r.amt));
  setTable('dow', ['Weekday', 'Spend', 'Transactions'],
    DOW_NAMES.map((name, i) => [name, fmt(dow[i]), String(rows.filter((r) => r.dow === i).length)]));

  draw('c-dow', {
    type: 'bar',
    data: {
      labels: DOW_NAMES,
      datasets: [Object.assign({ label: 'Spend', data: dow, backgroundColor: SLOTS[0] }, barMark)],
    },
    options: {
      scales: { x: catAxis(), y: valueAxis({ beginAtZero: true }) },
      plugins: {
        legend: { display: false },
        tooltip: Object.assign({}, tooltipStyle, { callbacks: { label: (c) => ' ' + fmt(c.parsed.y) } }),
      },
    },
  });

  const days = Array.from({ length: 31 }, (_, i) => i + 1);
  const dom = days.map((d) => sum(rows.filter((r) => r.dom === d), (r) => r.amt));
  setTable('dom', ['Day of month', 'Spend'], days.map((d, i) => [String(d), fmt(dom[i])]));

  draw('c-dom', {
    type: 'bar',
    data: {
      labels: days.map(String),
      datasets: [Object.assign({ label: 'Spend', data: dom, backgroundColor: SLOTS[0] }, barMark)],
    },
    options: {
      scales: {
        x: catAxis({ ticks: { color: INK3, autoSkip: true, maxTicksLimit: 16 } }),
        y: valueAxis({ beginAtZero: true }),
      },
      plugins: {
        legend: { display: false },
        tooltip: Object.assign({}, tooltipStyle, {
          callbacks: {
            title: (items) => 'Day ' + items[0].label,
            label: (c) => ' ' + fmt(c.parsed.y),
          },
        }),
      },
    },
  });
}

const TXN_COLS = [
  { key: 'date', label: 'Date', get: (r) => prettyDate(r.date) },
  { key: 'cp', label: 'Merchant', get: (r) => r.cp || '—' },
  { key: 'cat', label: 'Category', get: (r) => r.cat },
  { key: 'amt', label: 'Amount', get: (r) => fmt(r.amt, 2), num: true },
];

function renderTxns() {
  const rows = viewRows().slice();
  const { key, dir } = S.sort;
  rows.sort((a, b) => {
    const av = a[key], bv = b[key];
    if (av === bv) return a.i - b.i;
    return (av > bv ? 1 : -1) * dir;
  });

  document.getElementById('txn-count').textContent =
    `${group(String(rows.length))} rows · ${fmt(sum(rows, (r) => r.amt))}`;

  const host = document.getElementById('txn-table');
  host.textContent = '';
  if (!rows.length) {
    const none = document.createElement('div');
    none.className = 'empty';
    none.textContent = 'Nothing matches these filters.';
    host.appendChild(none);
    return;
  }

  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  for (const col of TXN_COLS) {
    const th = document.createElement('th');
    th.textContent = col.label + (key === col.key ? (dir === 1 ? '  ↑' : '  ↓') : '');
    th.tabIndex = 0;
    const sortBy = () => {
      S.sort = { key: col.key, dir: key === col.key ? -dir : (col.num ? -1 : 1) };
      renderTxns();
    };
    th.addEventListener('click', sortBy);
    th.addEventListener('keydown', (e) => { if (e.key === 'Enter') sortBy(); });
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  const shown = rows.slice(0, S.txnLimit);
  for (const row of shown) {
    const tr = document.createElement('tr');
    for (const col of TXN_COLS) {
      const td = document.createElement('td');
      td.textContent = col.get(row);
      if (col.key === 'amt' && row.kind === 'income') td.className = 'pos';
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  host.appendChild(table);

  if (rows.length > shown.length) {
    const more = document.createElement('button');
    more.className = 'btn';
    more.style.marginTop = '14px';
    more.textContent = `Show all ${group(String(rows.length))} rows`;
    more.addEventListener('click', () => { S.txnLimit = Infinity; renderTxns(); });
    host.appendChild(more);
  }
}

// ==========================================================================
//  Filters, chips, tabs
// ==========================================================================

const PRESETS = [
  { id: 'all', label: 'All time' },
  { id: 'ytd', label: 'This year' },
  { id: '12m', label: 'Last 12 months' },
  { id: '90d', label: 'Last 90 days' },
  { id: '30d', label: 'Last 30 days' },
];

function applyPreset(id) {
  const last = new Date(META.last + 'T00:00:00');
  const iso = isoLocal;
  if (id === 'all') { S.from = META.first; S.to = META.last; }
  else if (id === 'ytd') { S.from = META.last.slice(0, 4) + '-01-01'; S.to = META.last; }
  else {
    const back = { '12m': 365, '90d': 90, '30d': 30 }[id];
    const from = new Date(last);
    from.setDate(from.getDate() - back + 1);
    S.from = iso(from) < META.first ? META.first : iso(from);
    S.to = META.last;
  }
  syncControls();
  render();
}

function activePreset() {
  for (const preset of PRESETS) {
    const before = { from: S.from, to: S.to };
    // cheap probe: recompute the preset's dates without touching state
    const last = new Date(META.last + 'T00:00:00');
    const iso = isoLocal;
    let from, to = META.last;
    if (preset.id === 'all') { from = META.first; }
    else if (preset.id === 'ytd') { from = META.last.slice(0, 4) + '-01-01'; }
    else {
      const back = { '12m': 365, '90d': 90, '30d': 30 }[preset.id];
      const d = new Date(last);
      d.setDate(d.getDate() - back + 1);
      from = iso(d) < META.first ? META.first : iso(d);
    }
    if (before.from === from && before.to === to) return preset.id;
  }
  return null;
}

function buildFilterUI() {
  const presetHost = document.getElementById('f-presets');
  for (const preset of PRESETS) {
    const button = document.createElement('button');
    button.textContent = preset.label;
    button.dataset.preset = preset.id;
    button.addEventListener('click', () => applyPreset(preset.id));
    presetHost.appendChild(button);
  }

  const select = document.getElementById('f-parent');
  for (const parent of Object.keys(CATEGORY_TREE)) {
    const group = document.createElement('optgroup');
    group.label = parent;
    const all = document.createElement('option');
    all.value = 'P:' + parent;
    all.textContent = 'All ' + parent;
    group.appendChild(all);
    for (const child of CATEGORY_TREE[parent]) {
      if (!child) continue;
      const option = document.createElement('option');
      option.value = 'C:' + parent + ' > ' + child;
      option.textContent = child;
      group.appendChild(option);
    }
    select.appendChild(group);
  }
  select.addEventListener('change', () => {
    const value = select.value;
    S.parent = value.startsWith('P:') ? value.slice(2) : '';
    S.cat = value.startsWith('C:') ? value.slice(2) : '';
    S.drill = null;
    syncControls();
    render();
  });

  document.getElementById('f-from').addEventListener('change', (e) => {
    S.from = e.target.value || META.first;
    syncControls();
    render();
  });
  document.getElementById('f-to').addEventListener('change', (e) => {
    S.to = e.target.value || META.last;
    syncControls();
    render();
  });

  let searchTimer;
  document.getElementById('f-search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { S.q = e.target.value.trim(); render(); }, 160);
  });

  document.querySelectorAll('#f-kind button').forEach((button) => {
    button.addEventListener('click', () => {
      S.kind = button.dataset.kind;
      syncControls();
      render();
    });
  });

  document.getElementById('f-reset').addEventListener('click', () => {
    Object.assign(S, {
      from: META.first, to: META.last, parent: '', cat: '', merchant: '',
      day: '', q: '', kind: 'expense', drill: null, txnLimit: 250,
    });
    document.getElementById('f-search').value = '';
    syncControls();
    render();
  });

  document.querySelectorAll('[role="tab"]').forEach((tab) => {
    tab.addEventListener('click', () => selectTab(tab.id.replace('tab-', '')));
  });
  window.addEventListener('hashchange', () => selectTab(location.hash.slice(1) || 'cat'));

  window.addEventListener('resize', () => {
    clearTimeout(window.__spendlightResize);
    window.__spendlightResize = setTimeout(() => {
      if (S.tab === 'cat') renderTreemap();
    }, 180);
  });
}

const TABS = ['cat', 'trend', 'merch', 'cal'];

function selectTab(name) {
  if (!TABS.includes(name)) name = 'cat';
  S.tab = name;
  document.querySelectorAll('[role="tab"]').forEach((tab) => {
    const on = tab.id === 'tab-' + name;
    tab.setAttribute('aria-selected', String(on));
    document.getElementById(tab.getAttribute('aria-controls')).hidden = !on;
  });
  if (location.hash.slice(1) !== name) history.replaceState(null, '', '#' + name);
  render();
}

function categorySelectValue() {
  if (S.cat.includes(' > ')) return 'C:' + S.cat;
  if (S.cat) {
    const named = (CATEGORY_TREE[S.cat] || []).filter(Boolean);
    return named.length ? '' : 'P:' + S.cat;
  }
  return S.parent ? 'P:' + S.parent : '';
}

/** Push state back into the controls, so chart clicks and chips stay in sync. */
function syncControls() {
  document.getElementById('f-from').value = S.from;
  document.getElementById('f-to').value = S.to;
  document.getElementById('f-parent').value = categorySelectValue();
  document.querySelectorAll('#f-kind button').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.kind === S.kind)));
  const active = activePreset();
  document.querySelectorAll('#f-presets button').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.preset === active)));
}

function renderChips() {
  const host = document.getElementById('chips');
  host.textContent = '';
  const active = [
    S.cat && { label: 'Category: ' + S.cat, clear: () => { S.cat = ''; S.drill = null; } },
    S.parent && { label: 'Category: ' + S.parent, clear: () => { S.parent = ''; } },
    S.merchant && { label: 'Merchant: ' + S.merchant, clear: () => { S.merchant = ''; } },
    S.day && { label: 'Day: ' + prettyDate(S.day), clear: () => { S.day = ''; } },
    S.q && { label: 'Search: ' + S.q, clear: () => { S.q = ''; document.getElementById('f-search').value = ''; } },
    S.drill && { label: 'Drilled into: ' + S.drill, clear: () => { S.drill = null; } },
  ].filter(Boolean);

  for (const item of active) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    const text = document.createElement('span');
    text.textContent = item.label;
    const close = document.createElement('button');
    close.textContent = '×';
    close.setAttribute('aria-label', 'Remove filter ' + item.label);
    close.addEventListener('click', () => { item.clear(); syncControls(); render(); });
    chip.append(text, close);
    host.appendChild(chip);
  }
}

// ==========================================================================

function render() {
  renderChips();
  renderKpis();
  if (S.tab === 'cat') { renderTreemap(); renderStack(); renderLeafBars(); }
  else if (S.tab === 'trend') { renderFlow(); renderRate(); renderMoM(); }
  else if (S.tab === 'merch') { renderRecurring(); renderMerchants(); }
  else if (S.tab === 'cal') { renderCalendar(); renderRhythm(); renderTxns(); }
}

function boot() {
  document.getElementById('hdr-sub').textContent =
    `${prettyDate(META.first)} – ${prettyDate(META.last)} · ${group(String(META.count))} transactions`;
  document.getElementById('hdr-gen').textContent = 'Generated ' + META.generated;
  document.getElementById('foot').textContent =
    `Spendlight · ${META.source} · generated ${META.generated}. Rerun spendlight.py after a new export.`;
  buildFilterUI();
  syncControls();
  selectTab(location.hash.slice(1) || 'cat');
}

boot();
