/* 基于市场环境的电力系统规划仿真平台 —— 前端 SPA（按六屏原型实现） */
"use strict";

const API = "";
const $ = (sel, el = document) => el.querySelector(sel);
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
let charts = [];
const chartMap = new Map();
const mountChart = (id) => {
  const node = $("#" + id);
  const old = chartMap.get(id);
  if (old) { if (old.getDom() === node) return old; old.dispose(); chartMap.delete(id); }
  const c = echarts.init(node);
  chartMap.set(id, c); charts = [...chartMap.values()];
  return c;
};
/* 无数据时用占位文案替代空坐标轴，避免"没数据却画了图" */
const emptyChart = (id, text = "暂无数据") => {
  const box = $("#" + id);
  if (box) { box.classList.add("chart-empty"); box.textContent = text; }
};
window.addEventListener("resize", () => charts.forEach(c => c.resize()));

function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.add("show"); setTimeout(() => t.classList.remove("show"), 2200); }
async function api(path, opts = {}) {
  const r = await fetch(API + path, opts);
  if (!r.ok) { let m = "请求失败"; try { m = (await r.json()).detail || m; } catch (e) {} throw new Error(m); }
  return r.headers.get("content-type")?.includes("json") ? r.json() : r;
}
const fmt = (v, d = 1) => v == null || isNaN(v) ? "—" : Number(v).toLocaleString("zh-CN", { maximumFractionDigits: d });
const yi = (v) => v == null ? "—" : fmt(v / 1e8, 2) + " 亿元";
const pad2 = (n) => String(n).padStart(2, "0");
const defaultJobName = () => { const d = new Date(); return `规划计算 ${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const KIND_LABEL = { 1: "燃煤", 2: "燃气", 3: "水电", 4: "光伏", 5: "风电", 6: "储能" };
const KIND_COLOR = { 1: "#4e5969", 2: "#ff8800", 3: "#14c9c9", 4: "#f7ba1e", 5: "#53a7ff", 6: "#00b578" };
const JOB_STATUS = { pending: ["排队", ""], running: ["运行中", "blue"], done: ["已完成", "green"], failed: ["失败", "red"], cancelled: ["已取消", "orange"] };

/* ---------------- 全局状态 ---------------- */
const state = {
  systems: [], sid: null, view: null, modelingTab: "units",
  boundaryKind: "res", boundaryKey: "", boundaryMonth: 1,
  params: JSON.parse(localStorage.getItem("pp_params") || "null") || { annualize: true, years: 20, discount: 8, res_min_share: 32, time_limit: 300, mip_gap: 0.01, relax_z: false },
  jobOptions: JSON.parse(localStorage.getItem("pp_jobopts") || "null") || {},
  selectedJob: null, jobLog: {}, comparePre: null, compareAfter: null
};
state.jobOptions = { ...{ annualize: state.params.annualize, years: state.params.years, discount: state.params.discount, res_min_share: state.params.res_min_share, time_limit: state.params.time_limit, mip_gap: state.params.mip_gap, relax_z: state.params.relax_z, horizon_limit: 24, job_name: "" }, ...state.jobOptions };

async function loadSystems(pickFirst = true) {
  state.systems = await api("/api/systems");
  if (!state.sid && pickFirst && state.systems.length) state.sid = state.systems[0].id;
  if (!state.systems.some(s => s.id === state.sid)) state.sid = state.systems[0]?.id ?? null;
  const sel = $("#sys-sel");
  sel.innerHTML = state.systems.map(x => `<option value="${x.id}" ${x.id === state.sid ? "selected" : ""}>${x.name} ${x.version}</option>`).join("");
  const cur = state.systems.find(s => s.id === state.sid);
  $("#ver-tag").textContent = cur ? `系统版本 ${cur.version}` : "未选择系统";
}
function curSystem() { return state.systems.find(s => s.id === state.sid); }

/* ---------------- 五步流程条 ---------------- */
const STEPS = [["modeling", "电力系统建模"], ["boundary", "运行边界"], ["params", "算法参数"], ["run", "执行计算"], ["result", "结果分析"]];
const STEP_NO = { modeling: 0, boundary: 1, params: 2, run: 3, result: 4, compare: 4 };
function flowBar(view) {
  const cur = STEP_NO[view];
  const bar = el("div", "steps");
  bar.innerHTML = STEPS.map(([v, label], i) => {
    const cls = i === cur ? "active" : i < cur ? "done" : "";
    return `<span class="step ${cls}" data-step="${v}"><span class="dot">${i < cur ? "✓" : i + 1}</span>${label}</span>`;
  }).join("");
  bar.querySelectorAll(".step").forEach(s => s.onclick = () => { location.hash = "#/" + s.dataset.step; });
  $("#steps-bar").innerHTML = "";
  $("#steps-bar").append(bar);
}

/* ---------------- 弹窗 ---------------- */
function openModal(title, bodyHtml, onOk, okText, after) {
  const root = $("#modal-root");
  root.innerHTML = `<div class="modal-mask"><div class="modal"><h3>${title}</h3>${bodyHtml}
    <div class="foot">${onOk ? `<button class="btn" id="m-cancel">取消</button><button class="btn primary" id="m-ok">${okText || "确定"}</button>` : `<button class="btn primary" id="m-close">关闭</button>`}</div></div></div>`;
  if (onOk) {
    $("#m-ok").onclick = () => onOk().catch(e => toast(e.message));
    $("#m-cancel").onclick = closeModal;
  } else $("#m-close").onclick = closeModal;
  root.querySelector(".modal-mask").onclick = e => { if (e.target.classList.contains("modal-mask")) closeModal(); };
  if (after) after();
}
function closeModal() { $("#modal-root").innerHTML = ""; }

function fileImportDialog(title, cols, url, afterMsg) {
  openModal(title, `<p class="muted" style="margin-bottom:12px">列：${cols}。导入为<b>全量替换</b>，可先「下载模板」或「导出 CSV」获取格式。</p>
    <input type="file" id="csv-file" accept=".csv">`, async () => {
    const f = $("#csv-file").files[0]; if (!f) return toast("请选择文件");
    const fd = new FormData(); fd.append("file", f);
    const r = await api(url, { method: "POST", body: fd });
    closeModal(); toast(afterMsg(r)); return r;
  }, "导入");
}

/* ================= ① 电力系统建模 ================= */
const MODEL_LABEL = { units: "机组", nodes: "节点", lines: "线路", ties: "联络线" };
const putModel = (kind, rows) => api(`/api/systems/${state.sid}/${kind}`, {
  method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rows })
});

function emptyState(colspan, kind) {
  const lb = MODEL_LABEL[kind];
  const extra = kind === "nodes" ? "（节点是机组、线路、联络线与负荷预测的共同基础，建议先建节点）"
    : kind === "units" ? "（可先在节点清单中建好网架节点，再添加机组）"
      : kind === "lines" ? "（线路用于构造网架拓扑与 PTDF，需要先有节点）"
        : "（联络线代表区外来电通道，需先有节点）";
  return `<tr><td colspan="${colspan}" class="empty-cell">
    <div class="empty-title">尚未添加${lb}</div>
    <div class="empty-sub">点击右上角「＋ 新增${lb}」逐条添加，或使用「导入 CSV」批量导入${extra}</div>
  </td></tr>`;
}

async function renderModeling() {
  if (!state.sid) { renderNoSystem(); return; }
  const full = await api(`/api/systems/${state.sid}`);
  const c = $("#content"); c.innerHTML = "";
  c.append(el("div", "page-title", "电力系统建模"));
  c.append(el("div", "page-desc", "四类清单从零开始维护，平台不预置任何数据。请先建节点，再建线路与联络线，最后添加机组；运行边界的填写对象由这里的清单自动生成。"));

  const built = full.units.filter(u => !u.is_new), news = full.units.filter(u => u.is_new);
  const capSum = full.units.reduce((a, u) => a + (u.is_new ? 0 : u.cap), 0);
  const kpis = el("div", "kpis");
  kpis.innerHTML = [
    ["节点", fmt(full.nodes.length, 0), ""],
    ["线路", fmt(full.lines.length, 0), ""],
    ["联络线", fmt(full.ties.length, 0), ""],
    ["机组（含待建）", fmt(full.units.length, 0), " 台"],
    ["总装机容量", fmt(capSum, 0), " MW"]
  ].map(([k, v, u]) => `<div class="kpi"><div class="k">${k}</div><div class="v blue">${v}<span class="u">${u}</span></div></div>`).join("");
  c.append(kpis);

  const tab = state.modelingTab || "units";

  const bar = el("div", "toolbar");
  bar.innerHTML = `
    <div class="spacer"></div>
    <button class="btn small" id="btn-topo" ${full.nodes.length ? "" : "disabled"}>⌗ 拓扑可视化</button>
    <button class="btn small" id="btn-import">导入 CSV</button>
    <button class="btn small" id="btn-export" ${full[tab].length ? "" : "disabled"}>导出 CSV</button>
    <button class="btn primary small" id="btn-add">＋ 新增${MODEL_LABEL[tab]}</button>`;
  c.append(bar);

  const tabs = el("div", "tabs");
  tabs.innerHTML = [["units", `机组清单`], ["nodes", `节点清单`], ["lines", `线路清单`], ["ties", `联络线清单`]]
    .map(([k, t]) => `<a data-k="${k}" class="${tab === k ? "active" : ""}">${t}<span class="tab-num">${full[k].length}</span></a>`).join("");
  c.append(tabs);

  const stat = el("div", "muted");
  stat.style.cssText = "font-size:12px;margin:-10px 0 10px 2px";
  stat.textContent = tab === "units"
    ? `共 ${full.units.length} 台 · 已建 ${built.length} · 待建 ${news.length} · 装机 ${fmt(capSum, 0)} MW`
    : tab === "nodes" ? `共 ${full.nodes.length} 个节点`
      : tab === "lines" ? `共 ${full.lines.length} 条线路`
        : `共 ${full.ties.length} 条联络线`;
  c.append(stat);

  const card = el("div", "card");
  const table = el("table", "tbl");
  if (tab === "units") {
    table.innerHTML = `<thead><tr><th>机组名称</th><th>机组类型</th><th>装机容量 MW</th><th>所在节点</th><th>待建状态</th><th>运行成本 元/MWh</th><th>投建成本 元/MW</th><th>操作</th></tr></thead><tbody>` +
      (full.units.length ? full.units.map((u, i) => `<tr>
        <td class="nm" style="font-weight:600">${u.name}</td>
        <td>${KIND_LABEL[u.kind] || u.kind}</td>
        <td>${u.is_new ? "≤" + fmt(u.cap, 0) : (u.kind === 6 ? `${fmt(u.cap, 0)} · ${fmt(u.hours, 0)}h` : fmt(u.cap, 0))}</td>
        <td>${u.node || "—"}</td>
        <td><span class="tag ${u.is_new ? "new" : "blue"}">${u.is_new ? "待建" : "已建"}</span></td>
        <td>${fmt(u.c_op, 0)}</td>
        <td>${u.c_inv > 0 ? fmt(u.c_inv / 1e4, 0) + " 万" : "—"}</td>
        <td><span class="link" data-act="edit" data-i="${i}">编辑</span><span class="link danger" data-act="del" data-i="${i}">删除</span></td></tr>`).join("")
        : emptyState(8, "units")) + "</tbody>";
  } else if (tab === "nodes") {
    table.innerHTML = `<thead><tr><th>节点名称</th><th>关联机组</th><th>关联线路</th><th>操作</th></tr></thead><tbody>` +
      (full.nodes.length ? full.nodes.map((n, i) => {
        const uc = full.units.filter(u => u.node === n.name).length;
        const lc = full.lines.filter(l => l.frm === n.name || l.too === n.name).length;
        return `<tr><td style="font-weight:600">${n.name}</td><td class="muted">${uc} 台</td><td class="muted">${lc} 条</td>
          <td><span class="link" data-act="edit" data-i="${i}">编辑</span><span class="link danger" data-act="del" data-i="${i}">删除</span></td></tr>`;
      }).join("") : emptyState(4, "nodes")) + "</tbody>";
  } else if (tab === "lines") {
    table.innerHTML = `<thead><tr><th>线路名称</th><th>首端节点</th><th>末端节点</th><th>线路容量 MW</th><th>电抗标幺值</th><th>操作</th></tr></thead><tbody>` +
      (full.lines.length ? full.lines.map((l, i) => `<tr><td style="font-weight:600">${l.name}</td><td>${l.frm}</td><td>${l.too}</td><td>${fmt(l.cap, 0)}</td><td>${l.x}</td>
        <td><span class="link" data-act="edit" data-i="${i}">编辑</span><span class="link danger" data-act="del" data-i="${i}">删除</span></td></tr>`).join("")
        : emptyState(6, "lines")) + "</tbody>";
  } else {
    table.innerHTML = `<thead><tr><th>联络线名称</th><th>所在节点</th><th>操作</th></tr></thead><tbody>` +
      (full.ties.length ? full.ties.map((t, i) => `<tr><td style="font-weight:600">${t.name}</td><td>${t.node}</td>
        <td><span class="link" data-act="edit" data-i="${i}">编辑</span><span class="link danger" data-act="del" data-i="${i}">删除</span></td></tr>`).join("")
        : emptyState(3, "ties")) + "</tbody>";
  }
  card.append(table);
  c.append(card);

  tabs.querySelectorAll("a").forEach(a => a.onclick = () => { state.modelingTab = a.dataset.k; renderModeling(); });
  $("#btn-import").onclick = () => {
    const cols = {
      units: "序号,机组名称,机组类型,装机容量,爬坡速率,最小技术出力,所在节点,可用小时数,储能充电效率,储能放电效率,投建成本,运行成本,是否待建",
      nodes: "节点名称", lines: "线路名称,首端节点,末端节点,线路容量,电抗标幺值", ties: "联络线名称,所在节点"
    }[tab];
    fileImportDialog(`导入${MODEL_LABEL[tab]}清单 CSV`, cols, `/api/systems/${state.sid}/import/${tab}`, r => `导入 ${r.count} 行`);
  };
  $("#btn-export").onclick = () => { location.href = `/api/systems/${state.sid}/export/${tab}`; };
  $("#btn-add").onclick = () => openModelEditor(tab, full, -1);
  $("#btn-topo").onclick = () => showTopo(full);
  table.querySelectorAll("[data-act]").forEach(a => a.onclick = () => {
    const i = +a.dataset.i;
    if (a.dataset.act === "edit") return openModelEditor(tab, full, i);
    const name = full[tab][i].name;
    if (confirm(`确认删除${MODEL_LABEL[tab]}「${name}」？`)) delModelRow(tab, full, i);
  });
}

/* ---------- 四清单通用：新增 / 编辑 / 删除 ---------- */
function nodeOptions(nodes, selected) {
  if (!nodes.length) return `<option value="">（请先添加节点）</option>`;
  return nodes.map(n => `<option ${n.name === selected ? "selected" : ""}>${n.name}</option>`).join("");
}

function openModelEditor(kind, full, idx) {
  const rec = idx >= 0 ? full[kind][idx] : null;
  const isNew = !rec;
  const title = `${isNew ? "新增" : "编辑"}${MODEL_LABEL[kind]}`;
  let body = "";
  if (kind === "nodes") {
    body = `<div class="field"><label>节点名称</label><input class="inp" data-k="name" value="${rec?.name || ""}" style="flex:1" placeholder="如 N1"></div>`;
  } else if (kind === "lines") {
    const l = rec || {};
    body = `<div class="form-grid">
      <div class="field"><label>线路名称</label><input class="inp" data-k="name" value="${l.name || ""}" placeholder="如 L1"></div>
      <div class="field"><label>线路容量 MW</label><input class="inp" data-k="cap" value="${l.cap ?? 500}"></div>
      <div class="field"><label>首端节点</label><select class="sel" data-k="frm">${nodeOptions(full.nodes, l.frm)}</select></div>
      <div class="field"><label>末端节点</label><select class="sel" data-k="too">${nodeOptions(full.nodes, l.too)}</select></div>
      <div class="field"><label>电抗标幺值</label><input class="inp" data-k="x" value="${l.x ?? 0.05}"></div></div>`;
  } else if (kind === "ties") {
    const t = rec || {};
    body = `<div class="form-grid">
      <div class="field"><label>联络线名称</label><input class="inp" data-k="name" value="${t.name || ""}" placeholder="如 X1"></div>
      <div class="field"><label>所在节点</label><select class="sel" data-k="node">${nodeOptions(full.nodes, t.node)}</select></div></div>`;
  } else {
    const u = rec || {};
    body = unitForm(u, full.nodes);
  }
  openModal(title, body, async () => {
    const box = $("#modal-root .modal");
    const raw = {};
    box.querySelectorAll("[data-k]").forEach(inp => raw[inp.dataset.k] = inp.value);
    if (!raw.name || !String(raw.name).trim()) throw new Error("名称不能为空");

    if (kind === "units") {
      const row = isNew ? { seq: full.units.length + 1 } : { ...rec };
      box.querySelectorAll("[data-k]").forEach(inp => {
        const k = inp.dataset.k; let v = inp.value;
        if (k === "eta_ch_p") { row.eta_ch = (+v || 0) / 100; return; }
        if (k === "eta_dis_p") { row.eta_dis = (+v || 0) / 100; return; }
        row[k] = ["name", "node"].includes(k) ? v : +v || 0;
      });
      row.kind = +row.kind; row.is_new = +row.is_new;
      const rows = isNew ? [...full.units, row] : full.units.map((x, i) => i === idx ? row : x);
      await putModel("units", rows);
    } else if (kind === "nodes") {
      const name = raw.name.trim();
      if (full.nodes.some((n, i) => n.name === name && i !== idx)) throw new Error(`节点「${name}」已存在`);
      const rows = full.nodes.map((n, i) => i === idx ? { name } : n);
      if (isNew) rows.push({ name });
      await putModel("nodes", rows);
      if (!isNew && rec.name !== name) {
        // 名称级联：机组所在节点、线路首末端、联络线所在节点、负荷时序的对象键
        await putModel("units", full.units.map(u => u.node === rec.name ? { ...u, node: name } : u));
        await putModel("lines", full.lines.map(l => ({ ...l, frm: l.frm === rec.name ? name : l.frm, too: l.too === rec.name ? name : l.too })));
        await putModel("ties", full.ties.map(t => t.node === rec.name ? { ...t, node: name } : t));
        await api(`/api/systems/${state.sid}/boundary/rename`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "load", from: rec.name, to: name })
        });
      }
    } else if (kind === "lines") {
      const row = {
        name: raw.name.trim(), frm: raw.frm, too: raw.too,
        cap: +raw.cap || 0, x: +raw.x || 0.001
      };
      if (!row.frm || !row.too) throw new Error("请先添加节点，再选择首端 / 末端节点");
      if (row.frm === row.too) throw new Error("首端与末端不能是同一节点");
      const rows = isNew ? [...full.lines, row] : full.lines.map((x2, i) => i === idx ? { ...x2, ...row } : x2);
      await putModel("lines", rows);
    } else {
      const row = { name: raw.name.trim(), node: raw.node };
      if (!row.node) throw new Error("请先添加节点，再选择所在节点");
      const rows = isNew ? [...full.ties, row] : full.ties.map((x2, i) => i === idx ? { ...x2, ...row } : x2);
      await putModel("ties", rows);
    }
    closeModal(); toast("已保存"); renderModeling();
  });
}

async function delModelRow(kind, full, idx) {
  const rows = full[kind].filter((_, i) => i !== idx);
  await putModel(kind, rows);
  toast("已删除");
  renderModeling();
}

function unitForm(u, nodes) {
  u = u || {};
  const nodeSel = nodes && nodes.length
    ? `<select class="sel" data-k="node">${nodeOptions(nodes, u.node)}</select>`
    : `<input class="inp" data-k="node" value="${u.node || ""}" placeholder="请先添加节点">`;
  return `<div class="form-grid">
    <div class="field"><label>机组名称</label><input class="inp" data-k="name" value="${u.name || ""}"></div>
    <div class="field"><label>机组类型</label><select class="sel" data-k="kind">${[1, 2, 3, 4, 5, 6].map(k => `<option value="${k}" ${+u.kind === k ? "selected" : ""}>${KIND_LABEL[k]}</option>`).join("")}</select></div>
    <div class="field"><label>装机容量 MW</label><input class="inp" data-k="cap" value="${u.cap ?? 100}"></div>
    <div class="field"><label>所在节点</label>${nodeSel}</div>
    <div class="field"><label>爬坡速率 MW/h</label><input class="inp" data-k="ramp" value="${u.ramp ?? 1e6}"></div>
    <div class="field"><label>最小技术出力 MW</label><input class="inp" data-k="pmin" value="${u.pmin ?? 0}"></div>
    <div class="field"><label>可用小时数 h（储能）</label><input class="inp" data-k="hours" value="${u.hours ?? 0}"></div>
    <div class="field"><label>是否待建</label><select class="sel" data-k="is_new"><option value="0" ${+u.is_new ? "" : "selected"}>已建</option><option value="1" ${+u.is_new ? "selected" : ""}>待建（规划候选）</option></select></div>
    <div class="field"><label>充电效率 %（储能）</label><input class="inp" data-k="eta_ch_p" value="${u.eta_ch ? +(u.eta_ch * 100).toFixed(1) : ""}"></div>
    <div class="field"><label>放电效率 %（储能）</label><input class="inp" data-k="eta_dis_p" value="${u.eta_dis ? +(u.eta_dis * 100).toFixed(1) : ""}"></div>
    <div class="field"><label>投建成本 元/MW</label><input class="inp" data-k="c_inv" value="${u.c_inv ?? 0}"></div>
    <div class="field"><label>运行成本 元/MWh</label><input class="inp" data-k="c_op" value="${u.c_op ?? 0}"></div></div>`;
}

function showTopo(full) {
  const data = full.nodes.map(n => ({ name: n.name, itemStyle: { color: "#0052d9" }, symbolSize: 34 }));
  full.units.filter(u => u.is_new).forEach(u => data.push({ name: u.name, itemStyle: { color: "#ff8800" }, symbolSize: 22, label: { show: true, formatter: u.name + "*" } }));
  const links = full.lines.map(l => ({ source: l.frm, target: l.too, lineStyle: { width: Math.min(4, 1 + l.cap / 200), color: "#94a3b8" } }));
  full.ties.forEach(t => links.push({ source: t.node, symbol: ["none", "arrow"], lineStyle: { type: "dashed", color: "#00b578", width: 2 } }));
  full.units.filter(u => !u.is_new).forEach(u => links.push({ source: u.name, target: u.node, lineStyle: { color: "#cbd5e1", width: 1.5 } }));
  full.units.filter(u => u.is_new).forEach(u => links.push({ source: u.name, target: u.node, lineStyle: { color: "#ff8800", width: 1.5, type: "dotted" } }));
  openModal(`网架拓扑 · ${full.nodes.length} 节点 / ${full.lines.length} 线路 / ${full.ties.length} 联络线（橙色*为待建机组）`,
    `<div id="topo-chart" style="height:460px"></div>`, null, null, () => {
      echarts.init($("#topo-chart")).setOption({
        tooltip: {}, series: [{ type: "graph", layout: "force", roam: true, force: { repulsion: 260, edgeLength: 90 },
          label: { show: true, color: "#1d2129" }, data, links }]
      });
    });
}

/* ---------------- 无系统引导 ---------------- */
function renderNoSystem() {
  const c = $("#content"); c.innerHTML = "";
  c.append(el("div", "page-title", "还没有电力系统"));
  const card = el("div", "card");
  card.innerHTML = `<h3>从零开始建立第一个系统</h3>
    <p class="muted" style="margin-bottom:8px">平台不预置任何样例数据。请先新建系统，再按顺序维护清单：</p>
    <p class="muted" style="line-height:2">
      ① <b>节点清单</b> —— 网架节点（也是负荷预测的填写对象）<br>
      ② <b>线路清单 / 联络线清单</b> —— 线路构造拓扑，联络线代表区外来电通道<br>
      ③ <b>机组清单</b> —— 含类型、容量、经济参数；光伏 / 风电机组会成为新能源预测的填写对象
    </p>
    <p class="muted" style="margin:10px 0 16px">清单建好后，「运行边界」页会自动按这些对象生成全年 8760h 的填写表单。</p>
    <button class="btn primary" id="no-sys-new">＋ 新建系统</button>`;
  c.append(card);
  $("#no-sys-new").onclick = () => newSystemDialog();
}

function newSystemDialog() {
  openModal("新建电力系统", `
    <div class="field"><label>系统名称</label><input class="inp" id="ns-name" value=""></div>
    <div class="field"><label>版本号</label><input class="inp" id="ns-ver" value="v1.0"></div>
    <p class="muted">新系统为空模型，可逐表导入 CSV，或在建模页逐条录入。</p>`, async () => {
    const r = await api("/api/systems", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: $("#ns-name").value, version: $("#ns-ver").value }) });
    state.sid = r.id; closeModal(); toast("已创建"); await loadSystems(); route();
  }, "创建");
}

/* ================= ② 运行边界 ================= */
async function renderBoundary() {
  const c = $("#content"); c.innerHTML = "";
  c.append(el("div", "page-title", "运行边界"));
  c.append(el("div", "page-desc", "填写对象由建模页的清单自动生成：负荷 = 节点清单，新能源出力 = 光伏 / 风电机组，区外来电 = 联络线清单。按对象 × 全年逐时填写，也可导入 / 导出 CSV。"));

  const ov = await api(`/api/systems/${state.sid}/boundary/overview`);
  const keys = await api(`/api/systems/${state.sid}/boundary/keys`);
  const checks = await api(`/api/systems/${state.sid}/boundary/checks`);
  const totalDays = Math.max(1, Math.ceil((ov.horizon || 0) / 24));

  // 三张全年曲线卡
  const top = el("div", "grid2");
  const c1 = el("div", "card"); c1.innerHTML = `<h3 style="display:flex;justify-content:space-between;align-items:center">系统负荷预测（全年 8760h）<span class="pill blue" id="load-badge"></span></h3><div class='chart' id='ov-load'></div>`;
  const c2 = el("div", "card"); c2.innerHTML = `<h3>新能源出力预测（全年 · 分机组）</h3><div class='chart' id='ov-res'></div>`;
  top.append(c1, c2); c.append(top);
  const row2 = el("div", "grid2");
  const c3 = el("div", "card"); c3.innerHTML = `<h3 style="display:flex;justify-content:space-between;align-items:center">区外来电预测（全年 · 联络线）<span class="pill orange">固定注入 · 不可调</span></h3><div class='chart' id='ov-tie'></div>`;
  const c4 = el("div", "card"); c4.innerHTML = `<h3>数据校验</h3><div id="v-box"></div>`;
  row2.append(c3, c4); c.append(row2);

  const drawOverview = async (kind, mountId, stacked, colorList) => {
    const sr = await api(`/api/systems/${state.sid}/boundary/series?kind=${kind}&day_from=1&day_to=${totalDays}`);
    const names = sr.keys.length ? sr.keys : [];
    if (!names.length || !(sr.days || []).length) {
      emptyChart(mountId, { load: "暂无负荷数据：请在下方「数据维护」中选择节点逐格填写，或导入 CSV", res: "暂无新能源出力数据：请在下方「数据维护」中选择光伏 / 风电机组填写", tie: "暂无区外来电数据：请在下方「数据维护」中选择联络线填写" }[kind] || "暂无数据");
      return { xs: [], data: [], names: [] };
    }
    const xs = [];
    const data = names.map(() => []);
    (sr.days || []).forEach(d => { for (let h = 0; h < 24; h++) { xs.push(`${d + 1}日${h}时`); names.forEach((k, i) => data[i].push((sr.series[d] || {})[h] ?? 0)); } });
    const colors = ["#0052d9", "#00b578", "#ff8800", "#14c9c9", "#53a7ff", "#9270ff"];
    mountChart(mountId).setOption({
      tooltip: { trigger: "axis" }, legend: { type: "scroll", data: names },
      grid: { left: 56, right: 20, top: 34, bottom: 40 },
      xAxis: { type: "category", data: xs, boundaryGap: false },
      yAxis: { type: "value", name: "MW" },
      series: names.map((k, i) => ({ name: k, type: "line", stack: stacked ? "S" : null, areaStyle: stacked ? { opacity: .8 } : null, showSymbol: false, itemStyle: { color: colors[i % colors.length] }, data: data[i] }))
    });
    return { xs, data, names };
  };

  // 负荷图（分节点堆叠）+ 峰谷 badge
  const ld = await drawOverview("load", "ov-load", true);
  if (ld.names.length) {
    const total = ld.xs.map((_, i) => ld.data.reduce((a, s) => a + (s[i] || 0), 0));
    const pk = Math.max(...total), vl = Math.min(...total);
    $("#load-badge").textContent = `峰值 ${fmt(pk, 0)} MW · 谷值 ${fmt(vl, 0)} MW`;
  } else $("#load-badge").style.display = "none";
  drawOverview("res", "ov-res", true);
  drawOverview("tie", "ov-tie", false);

  // 数据校验卡
  const vbox = $("#v-box");
  const have = checks.have || { load: 0, res: 0, tie: 0 };
  const filledAny = have.load + have.res + have.tie > 0;
  if (checks.blocking.length) {
    vbox.innerHTML = checks.blocking.map(i => `<div class="vblock block">${i.msg}</div>`).join("") +
      checks.warnings.map(i => `<div class="vblock warn">${i.msg}</div>`).join("");
  } else if (checks.warnings.length) {
    vbox.innerHTML = checks.warnings.map(i => `<div class="vblock warn">${i.msg}</div>`).join("") + `<div class="vblock pass">未发现阻断项，可进入下一步。</div>`;
  } else if (!filledAny) {
    vbox.innerHTML = `<div class="vblock warn">运行边界尚未填写：请在下表中逐格填写，或使用「生成全年空白数据表」后导入 CSV。</div>`;
  } else {
    vbox.innerHTML = `<div class="vblock pass">校验通过：负荷、新能源预测、区外来电均在可行范围内，可进入下一步。</div>`;
  }

  // 数据维护卡（填写对象由四清单生成）
  const mc = el("div", "card");
  const kindNames = { load: "节点负荷", res: "新能源出力预测", tie: "区外来电" };
  const kindHint = {
    load: "对象来自「节点清单」：每个节点一条全年逐时负荷曲线",
    res: "对象来自「机组清单」中的光伏 / 风电机组",
    tie: "对象来自「联络线清单」：每条联络线一条逐时注入曲线"
  };
  mc.innerHTML = `
    <h3 style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
      <span>数据维护 · 全年 ${fmt(checks.horizon || 0, 0)}h（逐时）</span>
      <span style="display:flex;gap:10px">
        <button class="btn small" id="b-init">生成全年空白数据表</button>
        <button class="btn small" id="b-tpl">下载模板</button>
        <button class="btn small" id="b-imp">导入 CSV</button>
        <button class="btn small" id="b-exp" ${(keys[state.boundaryKind] || []).length ? "" : "disabled"}>导出 CSV</button>
        <button class="btn primary small" id="b-save">保存本页</button>
      </span></h3>
    <p class="muted" style="font-size:12px;margin:-6px 0 12px">${kindHint[state.boundaryKind]}</p>
    <div class="tabs" style="margin-bottom:14px" id="b-tabs">${Object.entries(kindNames).map(([k, t]) => `<a data-k="${k}" class="${state.boundaryKind === k ? "active" : ""}">${t}<span class="tab-num">${(keys[k] || []).length} 个对象</span></a>`).join("")}</div>
    <div class="toolbar" style="margin-bottom:10px">
      <span class="muted">对象：</span><select class="sel" id="b-key" style="max-width:220px"></select>
      <span id="b-months" style="display:flex;gap:2px;flex-wrap:wrap"></span>
      <div class="spacer"></div>
      <span class="muted" id="b-count" style="font-size:12px"></span>
    </div>
    <div style="overflow-x:auto"><table class="tbl grid-tbl" id="b-grid"></table></div>
    <div class="notes">· 单元格可直接填写 / 修改，改完点右上「保存本页」写入（未填写的时点按 0 处理）\n· 也可先「生成全年空白数据表」，再「导出 CSV」用 Excel 批量填写后导入覆盖</div>`;
  c.append(mc);

  const foot = el("div", "foot-bar");
  foot.innerHTML = `
    <span class="st ${checks.ok ? "ok" : "bad"}"><span class="foot-dot"></span>${checks.ok ? "校验通过，可进入下一步" : "校验存在阻断项，请修正数据后再继续"}</span>
    <span style="display:flex;gap:10px">
      <button class="btn" id="b-prev">上一步</button>
      <button class="btn primary" id="b-next">下一步：算法参数</button></span>`;
  c.append(foot);

  $("#b-prev").onclick = () => location.hash = "#/modeling";
  $("#b-next").onclick = () => location.hash = "#/params";
  mc.querySelectorAll("#b-tabs a").forEach(a => a.onclick = () => { state.boundaryKind = a.dataset.k; state.boundaryKey = ""; renderBoundary(); });
  $("#b-tpl").onclick = () => { location.href = `/api/systems/${state.sid}/boundary/template/${state.boundaryKind}`; };
  $("#b-imp").onclick = () => {
    const cols = { load: "节点名称,时段,节点负荷", res: "新能源机组名称,时段,新能源出力预测", tie: "联络线名称,时段,联络线预测" }[state.boundaryKind];
    fileImportDialog(`导入${kindNames[state.boundaryKind]} CSV（全量替换）`, cols, `/api/systems/${state.sid}/boundary/import/${state.boundaryKind}`,
      r => `导入 ${r.count} 条，时序 ${r.horizon}h`);
  };
  $("#b-exp").onclick = () => { location.href = `/api/systems/${state.sid}/boundary/export/${state.boundaryKind}`; };
  $("#b-init").onclick = async () => {
    const r = await api(`/api/systems/${state.sid}/boundary/init`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const n = Object.values(r.created || {}).reduce((a, b) => a + b, 0);
    toast(n ? `已生成 ${n.toLocaleString()} 个空白时点，开始填写` : "空白数据表已存在，无需重复生成");
    renderBoundary();
  };

  // 筛选行：对象 + 月份页签 + 记录数
  const keySel = $("#b-key");
  const ks = keys[state.boundaryKind] || [];
  keySel.innerHTML = ks.map(k => `<option ${k === state.boundaryKey ? "selected" : ""}>${k}</option>`).join("") || `<option value="">（清单中暂无对象）</option>`;
  if (!ks.includes(state.boundaryKey)) state.boundaryKey = ks[0] || "";
  keySel.value = state.boundaryKey;
  keySel.onchange = () => { state.boundaryKey = keySel.value; drawGrid(); };
  const monthsBox = $("#b-months");
  monthsBox.innerHTML = [...Array(12).keys()].map(i => `<span class="pill ${state.boundaryMonth === i + 1 ? "blue" : ""}" style="cursor:pointer" data-m="${i + 1}">${i + 1}月</span>`).join("");
  monthsBox.querySelectorAll("[data-m]").forEach(p => p.onclick = () => {
    state.boundaryMonth = +p.dataset.m;
    monthsBox.querySelectorAll("[data-m]").forEach(q => q.className = `pill ${q.dataset.m == state.boundaryMonth ? "blue" : ""}`);
    drawGrid();
  });
  const filled = have[state.boundaryKind] || 0;
  const totalRecords = (checks.horizon || 0) * ks.length;
  $("#b-count").textContent = ks.length ? `已填 ${filled.toLocaleString()} / ${totalRecords.toLocaleString()} 条` : "";

  // 当月网格表（日期 × 24 时刻，可填写）
  const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  async function drawGrid() {
    const grid = $("#b-grid");
    if (!ks.length) {
      const tip = {
        load: "节点清单为空：请先到「电力系统建模 → 节点清单」添加节点，负荷填写对象会自动出现",
        res: "机组清单中没有光伏 / 风电机组：请先添加类型为「光伏」或「风电」的机组",
        tie: "联络线清单为空：请先到「电力系统建模 → 联络线清单」添加区外来电通道"
      }[state.boundaryKind];
      grid.innerHTML = `<tbody><tr><td class="empty-cell"><div class="empty-title">暂无可填写的对象</div><div class="empty-sub">${tip}</div></td></tr></tbody>`;
      return;
    }
    let start = 1;
    for (let i = 0; i < state.boundaryMonth - 1; i++) start += MONTH_DAYS[i];
    let end = start + MONTH_DAYS[state.boundaryMonth - 1] - 1;
    const totalDays = Math.max(1, Math.ceil((checks.horizon || 0) / 24));
    start = Math.min(start, totalDays); end = Math.min(end, totalDays);
    const sr = await api(`/api/systems/${state.sid}/boundary/series?kind=${state.boundaryKind}&key=${encodeURIComponent(state.boundaryKey)}&day_from=${start}&day_to=${end}`);
    let html = `<thead><tr><th class="sticky-col">日期 / 时</th>${[...Array(24).keys()].map(h => `<th>${h}</th>`).join("")}</tr></thead><tbody>`;
    for (let d = start; d <= end; d++) {
      const row = sr.series[d - 1] || {};
      html += `<tr><td class="sticky-col muted">${d}日</td>` + [...Array(24).keys()].map(h => {
        const v = row[h];
        const t = (d - 1) * 24 + h + 1;
        return `<td><input class="cell" data-t="${t}" value="${v == null ? "" : (Math.round(v * 10) / 10)}" placeholder="0"></td>`;
      }).join("") + "</tr>";
    }
    html += "</tbody>";
    grid.innerHTML = html;
  }
  $("#b-save").onclick = async () => {
    if (!state.boundaryKey) return toast("没有可保存的对象");
    const cells = [...$("#b-grid").querySelectorAll(".cell")].map(i => ({ t: +i.dataset.t, val: i.value === "" ? 0 : +i.value }));
    if (!cells.length) return toast("本页没有可保存的单元格");
    const r = await api(`/api/systems/${state.sid}/boundary/values`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: state.boundaryKind, key: state.boundaryKey, cells })
    });
    toast(`已保存 ${r.count} 个时点`);
    renderBoundary();
  };
  drawGrid();
}

/* ================= ③ 算法参数 ================= */
async function renderParams() {
  const s = curSystem();
  const c = $("#content"); c.innerHTML = "";
  c.append(el("div", "page-title", "算法参数"));
  c.append(el("div", "page-desc", "本页设定 ④ 执行求解的模型口径；① 系统建模与 ② 运行边界的数据在此只读引用，如需调整请返回对应步骤。"));
  const p = state.params;
  const jo = state.jobOptions;

  const sw = (id, checked) => `<span class="switch"><input type="checkbox" id="${id}" ${checked ? "checked" : ""}><i></i></span>`;
  const left = el("div");
  left.innerHTML = `
    <div class="card"><h3>投资与弃电经济参数</h3>
      <div class="field"><label>投资上限 B</label><input class="inp" id="p-budget" value="${s?.budget ?? 0}" style="flex:1"><span class="hint">元，作用于全部待建机组</span></div>
      <div class="field"><label>弃电惩罚</label><input class="inp" id="p-curt" value="${s?.c_curt ?? 0}" style="flex:1"><span class="hint">元/MWh</span></div></div>
    <div class="card"><h3>年化设置（投资口径修正）</h3>
      <div class="field"><label>投资 CRF 年化 + 运行成本按 365 天放大</label>${sw("p-ann", p.annualize)}</div>
      <div class="field"><label>年限 / 折现率</label><input class="inp" id="p-years" value="${jo.years ?? p.years}" style="width:110px"> 年　<input class="inp" id="p-disc" value="${jo.discount ?? p.discount}" style="width:110px"> %</div></div>
    <div class="card"><h3>政策约束（新能源占比）</h3>
      <div class="field"><label>新能源占比下限</label><input class="inp" id="p-res" value="${jo.res_min_share ?? p.res_min_share}" style="width:140px"> %<span class="hint">0 或留空表示不启用</span></div></div>
    <div class="card"><h3>求解器设置</h3>
      <div class="field"><label>求解时限</label><input class="inp" id="p-tl" value="${jo.time_limit ?? p.time_limit}" style="width:140px"> 秒</div>
      <div class="field"><label>MIP Gap</label><input class="inp" id="p-gap" value="${jo.mip_gap ?? p.mip_gap}" style="width:140px"> %</div>
      <div class="field"><label>储能充放互斥 z 松弛（不推荐）</label>${sw("p-relax", p.relax_z)}</div></div>
    <div class="card"><h3>计算周期（求解规模）</h3>
      <div class="field"><label>计算时段</label>
        <select class="sel" id="p-hl" style="max-width:300px">
          <option value="24" ${(+jo.horizon_limit || 24) === 24 ? "selected" : ""}>代表日 · 前 24h</option>
          <option value="168" ${+jo.horizon_limit === 168 ? "selected" : ""}>一周 · 前 168h</option>
          <option value="720" ${+jo.horizon_limit === 720 ? "selected" : ""}>一月 · 前 720h</option>
          <option value="0" ${jo.horizon_limit === 0 ? "selected" : ""}>全年 · 全部时段</option>
        </select>
        <span class="hint" id="p-scale">规模预估中…</span></div>
      <p class="hint muted" style="margin:2px 0 0">受限 Gurobi 许可上限 2,000 变量/约束；切片求解只代表所选时段，不折算为全年指标。全年直解需商业许可，或后续采用典型日聚类口径。</p></div>`;

  const rail = el("div", "rail");
  rail.innerHTML = `
    <div class="card"><h4>本次计算方案</h4>
      <div class="sum-row"><b>① 电力系统建模</b><span>${s ? s.version : "—"}（${fmt(s?._cnt ?? 0, 0)}）</span></div>
      <div class="sum-row" id="sum-2"><b>② 运行边界</b><span>加载中…</span></div>
      <div class="sum-row"><b>③ 算法参数</b><span id="sum-3"></span></div>
      <div class="sum-row"><b>④ 执行求解</b><span>Gurobi 13 · 时限 ${jo.time_limit ?? p.time_limit}s</span></div>
      <div class="dv-pass">预计求解耗时 1~3 分钟</div>
      <button class="btn primary" id="p-run">下一步：执行计算</button>
      <button class="btn ghost" id="p-save">保存为参数模板</button>
      <p class="hint muted" style="margin-top:8px">本页仅保存参数口径，不触发计算；确认无误后进入下一步提交任务</p></div>`;

  const cols = el("div", "cols"); cols.append(left, rail); c.append(cols);

  function refreshSum() {
    const ann = $("#p-ann").checked, res = +$("#p-res").value || 0, hl = +$("#p-hl").value || 0;
    const period = hl ? `前 ${hl}h` : "全年";
    $("#sum-3").textContent = `${ann ? "投资年化" : "规范口径"}${res ? " + 配额 " + res + "%" : ""} · ${period}`;
  }
  refreshSum();
  $("#p-ann").onchange = refreshSum; $("#p-res").oninput = refreshSum; $("#p-hl").onchange = refreshSum;

  // ② 摘要：边界规模
  (async () => {
    try {
      const keys = await api(`/api/systems/${state.sid}/boundary/keys`);
      const n = (keys.horizon || 0) * Math.max(1, (keys.load.length || 1));
      $("#sum-2").innerHTML = `<span>全年 ${(keys.horizon || 0).toLocaleString()}h（逐时）</span>`;
    } catch (e) { $("#sum-2").innerHTML = "<span>—</span>"; }
  })();
  // ① 摘要：机组/节点数 + 规模预估（受限于 Gurobi 2000 变量许可上限）
  (async () => {
    try {
      const full = await api(`/api/systems/${state.sid}`);
      const row = rail.querySelectorAll(".sum-row")[0].querySelector("span");
      row.textContent = `${full.nodes.length} 节点 / ${full.units.length} 机组`;
      const H = (await api(`/api/systems/${state.sid}/boundary/keys`).catch(() => ({ horizon: 0 }))).horizon || 0;
      const scaleOf = () => {
        const T = (+$("#p-hl").value || H || 24);
        const est = T * (full.units.length * 3 + full.nodes.length + full.lines.length + 2);
        const over = est > 2000;
        $("#p-scale").innerHTML = `该设置下预计变量约 <b>${fmt(est, 0)}</b>（上限 2,000）`
          + (over ? ` · <span class="warn">超限，受限许可无法求解</span>` : ` · <span style="color:#00b578">预计可解</span>`);
      };
      scaleOf();
      $("#p-hl").addEventListener("change", scaleOf);
    } catch (e) {}
  })();

  function collect() {
    return {
      annualize: $("#p-ann").checked, years: +$("#p-years").value || 20, discount: +$("#p-disc").value || 8,
      res_min_share: +$("#p-res").value || 0, time_limit: +$("#p-tl").value || 300,
      mip_gap: +$("#p-gap").value || 0.01, relax_z: $("#p-relax").checked,
      horizon_limit: +$("#p-hl").value || 0
    };
  }
  async function saveParams(silent) {
    const v = collect();
    state.params = { ...state.params, ...v };
    state.jobOptions = { ...state.jobOptions, ...v };
    localStorage.setItem("pp_params", JSON.stringify(state.params));
    localStorage.setItem("pp_jobopts", JSON.stringify(state.jobOptions));
    await api(`/api/systems/${state.sid}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ budget: +$("#p-budget").value || 0, c_curt: +$("#p-curt").value || 0 }) });
    await loadSystems();
    if (!silent) toast("参数已保存");
  }
  $("#p-save").onclick = () => saveParams();
  $("#p-run").onclick = async () => { await saveParams(true); location.hash = "#/run"; };
}

/* ================= ④ 执行计算 ================= */
let pollTimer = null;
async function renderRun() {
  if (pollTimer) clearInterval(pollTimer);
  const c = $("#content"); c.innerHTML = "";
  c.append(el("div", "page-title", "执行计算"));
  c.append(el("div", "page-desc", "确认 ①②③ 的配置后在此提交任务——这是全流程唯一的计算入口；任务在后台运行，可离开本页。"));
  const s = curSystem();
  const jo = state.jobOptions;
  const jobs = await api(`/api/jobs?system_id=${state.sid}`);
  const active = jobs.find(j => j.status === "running" || j.status === "pending") || jobs[0];

  if (active) {
    const pc = el("div", "card");
    const [stLabel, stPill] = JOB_STATUS[active.status] || [active.status, ""];
    pc.innerHTML = `
      <h3 style="display:flex;justify-content:space-between;align-items:center">
        <span>任务 #${active.id} · ${active.name}</span>
        <span class="pill ${stPill}">${stLabel}</span></h3>
      <div class="progress-bar" style="height:10px;margin-bottom:8px"><i style="width:${active.progress}%"></i></div>
      <div class="muted" style="font-size:12px;margin-bottom:12px" id="r-meta"></div>
      <div class="console" id="r-console"></div>
      <div class="toolbar" style="margin-top:14px;justify-content:flex-end">
        <span class="hint muted" style="flex:1">计算完成后可前往「结果分析」查看</span>
        <button class="btn danger" id="r-cancel" ${active.status === "running" || active.status === "pending" ? "" : "disabled"}>取消任务</button>
        <button class="btn" id="r-view" ${active.status === "done" ? "" : "disabled"}>查看结果</button></div>`;
    c.append(pc);
    // 日志（阶段累计）
    const logKey = active.id;
    const log = state.jobLog[logKey] || (state.jobLog[logKey] = []);
    const line = `[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}] ${active.stage || ""}${active.message ? " · " + active.message : ""}`;
    if (!log.length || log[log.length - 1].slice(11) !== line.slice(11)) log.push(line);
    const con = $("#r-console");
    con.innerHTML = (active.notes ? JSON.parse(active.notes) : []).map(m => `<div class="warn">${m}</div>`).join("") +
      log.map(m => `<div>${m}</div>`).join("");
    con.scrollTop = con.scrollHeight;
    $("#r-meta").textContent = `已用时 ${elapsed(active)} · 当前阶段：${active.stage || "—"} · 进度 ${active.progress}%`;
    $("#r-cancel").onclick = async () => { if (confirm("确认取消该任务？")) { await api(`/api/jobs/${active.id}/cancel`, { method: "POST" }); toast("已请求取消"); } };
    $("#r-view").onclick = () => { location.hash = `#/result/${active.id}`; };
  }

  // 配置确认卡
  const conf = el("div", "card");
  const bKeys = await api(`/api/systems/${state.sid}/boundary/keys`).catch(() => ({ horizon: 0 }));
  const horizon = bKeys.horizon || 0;
  const unitCount = s?.unit_count || 0;
  const missing = [];
  if (!unitCount) missing.push("① 电力系统建模 尚无机组清单");
  if (!horizon) missing.push("② 运行边界 尚无逐时负荷 / 新能源数据");
  conf.innerHTML = `
    <h3 style="display:flex;justify-content:space-between;align-items:center">本次计算配置确认
      <span class="muted" style="font-size:12px">配置快照随任务存档，保证结果可复现</span></h3>
    <div class="field"><label>系统版本</label><span>${s ? `${s.version} · ${s.name}` : "未选择"}</span><span class="link" data-go="modeling">查看</span></div>
    <div class="field"><label>运行边界</label><span>${horizon ? `全年 ${horizon.toLocaleString()}h · 负荷 / 新能源预测 / 区外来电已维护` : "尚未维护运行边界数据"}</span><span class="link" data-go="boundary">${horizon ? "查看" : "去维护"}</span></div>
    <div class="field"><label>经济参数</label><span>投资上限 B = ${fmt(s?.budget, 2)} 元 · 弃电惩罚 ${fmt(s?.c_curt, 0)} 元/MWh</span><span class="link" data-go="params">修改</span></div>
    <div class="field"><label>目标口径</label><span>${jo.annualize ? `投资年化（${jo.years} 年 / ${jo.discount}%）` : "规范单日口径"}${jo.res_min_share ? ` · 新能源配额 ${jo.res_min_share}%` : ""}</span><span class="link" data-go="params">修改</span></div>
    <div class="field"><label>求解器</label><span>Gurobi 13 · 时限 ${jo.time_limit}s · MIP Gap ${jo.mip_gap}% · 储能互斥 ${jo.relax_z ? "松弛" : "保留"}</span><span class="link" data-go="params">修改</span></div>
    <div class="field"><label>计算周期</label><span>${(+jo.horizon_limit || 0) === 0 ? `全年 ${horizon.toLocaleString()}h（需商业许可）` : `前 ${(+jo.horizon_limit).toLocaleString()}h（${+jo.horizon_limit === 24 ? "代表日" : +jo.horizon_limit === 168 ? "一周" : "一月"}切片）`}</span><span class="link" data-go="params">修改</span></div>
    ${missing.length ? `<div class="vblock warn" style="margin-top:10px">当前系统数据不完整，无法提交计算：<br>${missing.join("<br>")}</div>` : ""}
    <div class="toolbar" style="margin-top:6px">
      <input class="inp" id="j-name" value="${jo.job_name || defaultJobName()}" style="flex:1;max-width:380px" placeholder="任务名称">
      <button class="btn primary" id="j-submit" ${missing.length ? "disabled" : ""}>提交计算</button>
      <span class="hint muted">提交后按以上配置构建 MILP 求解；如需调整请先返回对应步骤修改</span></div>`;
  c.append(conf);
  conf.querySelectorAll("[data-go]").forEach(a => a.onclick = () => { location.hash = "#/" + a.dataset.go; });

  // 任务历史
  const list = el("div", "card");
  list.innerHTML = `<h3>任务历史</h3><div id="job-list"></div>`;
  c.append(list);
  $("#j-submit").onclick = async () => {
    if (missing.length) return toast("系统数据不完整，请先补齐建模与运行边界数据");
    jo.job_name = $("#j-name").value;
    localStorage.setItem("pp_jobopts", JSON.stringify(jo));
    const r = await api("/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      system_id: state.sid, name: jo.job_name,
      options: { annualize: jo.annualize, years: jo.years, discount: jo.discount, res_min_share: jo.res_min_share, time_limit: jo.time_limit, mip_gap: jo.mip_gap, relax_z: jo.relax_z, horizon_limit: +jo.horizon_limit || 0 }
    }) });
    toast(`任务 #${r.id} 已提交`); state.jobLog[r.id] = []; renderRun();
  };
  refreshList();
  function refreshList() {
    api(`/api/jobs?system_id=${state.sid}`).then(js => {
      $("#job-list").innerHTML = `<table class="tbl"><thead><tr><th>ID</th><th>任务</th><th>状态</th><th>进度</th><th>阶段</th><th>创建时间</th><th>操作</th></tr></thead><tbody>` +
        js.map(j => `<tr><td>${j.id}</td><td>${j.name}</td>
        <td><span class="status-dot ${j.status}"></span>${{ pending: "排队", running: "计算中", done: "完成", failed: "失败", cancelled: "已取消" }[j.status]}</td>
        <td style="min-width:140px"><div class="progress-bar"><i style="width:${j.progress}%"></i></div></td>
        <td class="muted">${j.stage || ""}${j.message ? " · " + j.message : ""}</td>
        <td class="muted">${j.created_at || ""}</td>
        <td><span class="link" data-v="${j.id}">查看结果</span>${j.status === "running" || j.status === "pending" ? `<span class="link danger" data-c="${j.id}">取消</span>` : ""}</td></tr>`).join("") + "</tbody></table>";
      $("#job-list").querySelectorAll("[data-v]").forEach(a => a.onclick = () => { location.hash = `#/result/${a.dataset.v}`; });
      $("#job-list").querySelectorAll("[data-c]").forEach(a => a.onclick = async () => { if (confirm("确认取消？")) { await api(`/api/jobs/${a.dataset.c}/cancel`, { method: "POST" }); toast("已请求取消"); } });
      if (js.some(j => j.status === "pending" || j.status === "running")) pollTimer = setTimeout(() => { if (state.view === "run") renderRun(); else refreshList(); }, 2000);
    });
  }
}

function elapsed(j) {
  if (!j.started_at) return "—";
  const t0 = new Date(j.started_at.replace(" ", "T"));
  if (isNaN(t0)) return "—";
  const sec = Math.max(0, (Date.now() - t0.getTime()) / 1000);
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/* ================= ⑤ 结果分析 ================= */
async function renderResult(jobId) {
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  const c = $("#content"); c.innerHTML = "";
  c.append(el("div", "page-title", "结果分析"));
  const jobs = await api(`/api/jobs?system_id=${state.sid}`);
  const done = jobs.filter(j => j.status === "done");
  if (!jobId) jobId = state.selectedJob || (done[0] && done[0].id);
  if (jobId && !done.some(j => j.id == jobId)) jobId = done[0] && done[0].id;
  state.selectedJob = jobId;
  if (!done.length) {
    const cur = curSystem();
    const card = el("div", "card");
    card.innerHTML = `<h3>暂无可分析的结果</h3>
      <p class="muted" style="margin-bottom:6px">当前系统「${cur ? cur.name + " " + cur.version : "未选择"}」还没有已完成的计算任务。</p>
      <p class="muted">请先完成 ① 建模 → ② 运行边界 → ③ 算法参数 的数据准备，再在 ④ 执行计算 提交任务；计算完成后本页会显示该系统的结果。</p>`;
    c.append(card);
    return;
  }
  const sel = el("div", "toolbar");
  sel.innerHTML = `<select class="sel" id="r-job">${done.map(j => `<option value="${j.id}" ${j.id == jobId ? "selected" : ""}>#${j.id} ${j.name}（${j.system_name}）</option>`).join("")}</select>
    <div class="spacer"></div>
    <button class="btn small" id="r-export">导出结果 CSV</button>
    <button class="btn primary small" id="r-cmp">查看方案对比</button>`;
  c.append(sel);
  $("#r-export").onclick = () => { location.href = `/api/jobs/${jobId}/export-summary`; };
  $("#r-cmp").onclick = () => { location.hash = "#/compare"; };

  const j = await api(`/api/jobs/${jobId}`);
  const sm = j.summary || {};
  const ind = sm["指标"] || {};
  const full = await api(`/api/systems/${j.system_id}`);
  const cInvOf = {}; full.units.forEach(u => cInvOf[u.name] = u.c_inv || 0);
  const inv = sm["投建明细"] || [];
  const invCap = inv.reduce((a, i) => a + i["容量_MW"], 0);
  const invCost = inv.reduce((a, i) => a + cInvOf[i["机组"]] * i["容量_MW"], 0) || sm["成本分解"]?.["投资成本_元"] || 0;

  const kpis = el("div", "kpis");
  kpis.innerHTML = [
    ["平均供电成本", fmt(ind["平均供电成本_元每MWh"], 1), "元/MWh", "orange"],
    ["弃电率", fmt(ind["弃电率"] * 100, 2), "%", "orange"],
    ["新能源电量占比", fmt(ind["新能源电量占比"] * 100, 1), "%", "green"],
    ["投建容量 / 成本", `${fmt(invCap, 0)} MW · ${yi(invCost)}`, "", "blue"]
  ].map(([k, v, u, cls]) => `<div class="kpi"><div class="k">${k}</div><div class="v ${cls}">${v}<span class="u">${u}</span></div></div>`).join("");
  c.append(kpis);

  const c1 = el("div", "card"); c1.innerHTML = "<h3>全年出力构成（堆叠）与负荷曲线</h3><div class='chart' id='d-chart' style='height:360px'></div>";
  c.append(c1);

  const grid = el("div", "grid2");
  const c2 = el("div", "card");
  c2.innerHTML = "<h3>机组投建结果</h3>" + (inv.length ? inv.map(i => {
    const cost = cInvOf[i["机组"]] * i["容量_MW"];
    const capTxt = i["能量_MWh"] ? `${fmt(i["容量_MW"], 0)} MW · ${fmt(i["能量_MWh"], 0)} MWh` : `${fmt(i["容量_MW"], 0)} MW`;
    return `<div class="inv-row"><span class="nm">${i["机组"]}</span><span class="val">${capTxt}　<b>${yi(cost)}</b></span></div>`;
  }).join("") : "<p class='muted'>本方案无投建。</p>");
  const c3 = el("div", "card"); c3.innerHTML = "<h3>储能运行与新能源弃电</h3><div class='chart' id='e-chart' style='height:200px'></div><div class='chart' id='ct-chart' style='height:160px'></div>";
  grid.append(c2, c3); c.append(grid);

  // 主图：堆叠出力 + 负荷虚线
  const dc = await api(`/api/jobs/${jobId}/chart/dispatch`);
  const seriesKeys = Object.keys(dc.series || {});
  const T = seriesKeys.length ? Math.max(...seriesKeys.map(k => dc.series[k].length)) : 0;
  if (!T) {
    emptyChart("d-chart", "该任务未产生机组出力序列（可能已无投建/运行结果），请重新提交计算");
    emptyChart("e-chart", "无储能运行数据");
    emptyChart("ct-chart", "无弃电数据");
  } else {
    const colorOf = {}; full.units.forEach(u => colorOf[u.name] = KIND_COLOR[u.kind] || "#64748b");
    mountChart("d-chart").setOption({
      tooltip: { trigger: "axis" }, legend: { type: "scroll" },
      dataZoom: [{ type: "inside" }, { type: "slider" }],
      grid: { left: 60, right: 30, top: 40, bottom: 60 },
      xAxis: { type: "category", data: [...Array(T).keys()].map(t => "T" + (t + 1)) },
      yAxis: { type: "value", name: "MW" },
      series: [
        ...seriesKeys.map(k => ({ name: k, type: "line", stack: "total", areaStyle: { opacity: .75 }, showSymbol: false, itemStyle: { color: colorOf[k] }, data: dc.series[k] })),
        { name: "系统总负荷", type: "line", showSymbol: false, lineStyle: { type: "dashed", color: "#1d2129", width: 2 }, itemStyle: { color: "#1d2129" }, data: dc.load || [] }
      ]
    });
  }
  // 储能 + 弃电
  if (T) try {
    const ex = await api(`/api/jobs/${jobId}/chart/extra`);
    const eNames = Object.keys(ex.ess);
    if (eNames.length) {
      const colors = ["#0052d9", "#00b578", "#9270ff"];
      mountChart("e-chart").setOption({
        tooltip: { trigger: "axis" }, legend: { data: ["充电功率", "放电功率", "SOC能量"] },
        grid: { left: 56, right: 16, top: 30, bottom: 24 },
        xAxis: { type: "category", data: [...Array((ex.ess[eNames[0]].charge.length)).keys()].map(t => "T" + (t + 1)) },
        yAxis: { type: "value", name: "MW" },
        series: eNames.slice(0, 3).flatMap((k, i) => [
          { name: `${k} 充电`, type: "bar", stack: "c" + i, itemStyle: { color: "#0052d9" }, data: ex.ess[k].charge },
          { name: `${k} 放电`, type: "bar", stack: "d" + i, itemStyle: { color: "#00b578" }, data: ex.ess[k].discharge }
        ])
      });
    } else emptyChart("e-chart", "本方案无储能投建或未运行");
    const ctNames = Object.keys(ex.curtail);
    if (ctNames.length) {
      const tN = ex.curtail[ctNames[0]].length;
      mountChart("ct-chart").setOption({
        tooltip: { trigger: "axis" }, legend: { type: "scroll" },
        grid: { left: 56, right: 16, top: 30, bottom: 24 },
        xAxis: { type: "category", data: [...Array(tN).keys()].map(t => "T" + (t + 1)) },
        yAxis: { type: "value", name: "MW" },
        series: ctNames.map((k, i) => ({ name: k + " 弃电", type: "bar", stack: "ct", itemStyle: { color: ["#ff8800", "#f7ba1e", "#e34d59"][i % 3] }, data: ex.curtail[k] }))
      });
    } else emptyChart("ct-chart", "无弃电记录");
  } catch (e) {}

  // 结果文件 + 校验 + 提示
  const notesCard = el("div", "card");
  const fileRows = (await api(`/api/jobs/${jobId}/files`)).map(f => `<tr><td>${f.name}</td><td class="muted">${(f.size / 1024).toFixed(1)} KB</td><td><a class="link" href="/api/jobs/${jobId}/files/${f.name}">下载</a></td></tr>`).join("");
  notesCard.innerHTML = `<h3>输出文件与独立校验</h3><table class="tbl">${fileRows}</table>
    ${j.verify_ok != null ? `<div class="vblock ${j.verify_ok ? "pass" : "block"}" style="margin-top:12px">独立校验：${j.verify_ok ? "通过" : "未通过"}</div>` : ""}
    ${j.verify_msgs?.length ? `<div class="notes">${j.verify_msgs.join("\n")}</div>` : ""}
    ${j.notes?.length ? `<div class="notes">${j.notes.join("\n")}</div>` : ""}`;
  c.append(notesCard);
  $("#r-job").onchange = e => { state.selectedJob = +e.target.value; renderResult(+e.target.value); };
}

/* ================= ⑥ 对比分析 ================= */
async function renderCompare() {
  const jobs = await api(`/api/jobs?system_id=${state.sid}`);
  const done = jobs.filter(j => j.status === "done");
  const c = $("#content"); c.innerHTML = "";
  c.append(el("div", "page-title", "对比分析"));
  c.append(el("div", "page-desc", "规划前 / 规划后双方案对比：关键指标变化、装机容量结构、全年曲线。"));
  if (done.length < 1) {
    const cur = curSystem();
    const card = el("div", "card");
    card.innerHTML = `<h3>暂无可对比的方案</h3>
      <p class="muted" style="margin-bottom:6px">当前系统「${cur ? cur.name + " " + cur.version : "未选择"}」还没有已完成的计算任务。</p>
      <p class="muted">对比分析以「同一系统内的多个方案」为对象：先完成一次计算作为规划前基准，调整参数（如投资上限、新能源配额）后再算一次，即可在本页对比。</p>`;
    c.append(card);
    return;
  }
  if (done.length === 1) {
    const cur = curSystem();
    const card = el("div", "card");
    card.innerHTML = `<h3>还差一个方案才能对比</h3>
      <p class="muted" style="margin-bottom:6px">当前系统「${cur ? cur.name + " " + cur.version : "未选择"}」只有 1 个已完成任务：<b>#${done[0].id} ${done[0].name}</b>。</p>
      <p class="muted">请在 ③ 算法参数 中调整口径后回到 ④ 执行计算 再提交一次，两个方案都完成后即可对比规划前后差异。</p>`;
    c.append(card);
    return;
  }
  if (!state.comparePre || !done.some(j => j.id === state.comparePre)) state.comparePre = done[done.length - 1]?.id;
  if (!state.compareAfter || !done.some(j => j.id === state.compareAfter)) state.compareAfter = done[0]?.id;
  if (state.comparePre === state.compareAfter && done.length > 1) state.comparePre = done[done.length - 1].id, state.compareAfter = done[0].id;

  const vs = el("div", "vs-bar");
  const optHtml = sel => done.map(j => `<option value="${j.id}" ${j.id === sel ? "selected" : ""}>${j.name}</option>`).join("");
  vs.innerHTML = `
    <span class="vs-chip">规划前 · <select id="vs-pre">${optHtml(state.comparePre)}</select></span>
    <span class="vs-arrow">VS</span>
    <span class="vs-chip primary">规划后 · <select id="vs-after">${optHtml(state.compareAfter)}</select></span>
    <div class="spacer" style="flex:1"></div>
    <button class="btn small" id="vs-export">导出对比报告</button>`;
  c.append(vs);
  $("#vs-pre").onchange = e => { state.comparePre = +e.target.value; draw(); };
  $("#vs-after").onchange = e => { state.compareAfter = +e.target.value; draw(); };
  $("#vs-export").onclick = () => { location.href = `/api/compare/export?jids=${state.comparePre},${state.compareAfter}`; };

  const holder = el("div"); holder.id = "cmp-holder"; c.append(holder);

  async function draw() {
    const holder = $("#cmp-holder"); holder.innerHTML = "";
    const pre = await api(`/api/jobs/${state.comparePre}`);
    const aft = await api(`/api/jobs/${state.compareAfter}`);
    const preS = pre.summary || {}, aftS = aft.summary || {};
    const pi = preS["指标"] || {}, ai = aftS["指标"] || {};
    const preSys = await api(`/api/systems/${pre.system_id}`);
    const aftSys = await api(`/api/systems/${aft.system_id}`);

    // Delta KPI
    const dg = el("div", "delta-grid");
    const costD = (ai["平均供电成本_元每MWh"] ?? 0) - (pi["平均供电成本_元每MWh"] ?? 0);
    const curtD = ((ai["弃电率"] ?? 0) - (pi["弃电率"] ?? 0)) * 100;
    const resD = ((ai["新能源电量占比"] ?? 0) - (pi["新能源电量占比"] ?? 0)) * 100;
    const capA = ai["投建总容量_MW"] ?? 0;
    const invCost = (aftS["成本分解"] || {})["投资成本_元"] || 0;
    const budgetLeft = ai["投资上限余额_元"];
    dg.innerHTML = [
      ["平均供电成本", `${fmt(pi["平均供电成本_元每MWh"], 1)} → ${fmt(ai["平均供电成本_元每MWh"], 1)} 元/MWh`,
        `<span class="delta ${costD > 0 ? "up" : costD < 0 ? "down" : "flat"}">${costD > 0 ? "▲" : costD < 0 ? "▼" : "—"} ${fmt(Math.abs(costD), 2)} 元/MWh（${fmt(costD / (pi["平均供电成本_元每MWh"] || 1) * 100, 1)}%）</span>`],
      ["弃电率", `${fmt((pi["弃电率"] || 0) * 100, 1)}% → ${fmt((ai["弃电率"] || 0) * 100, 1)}%`,
        `<span class="delta ${curtD > 0 ? "up" : "flat"}">${curtD > 0 ? "▲" : "—"} ${fmt(Math.abs(curtD), 1)}pp · 弃电 ${fmt(ai["弃电电量_MWh"], 1)} MWh</span>`],
      ["新能源电量占比", `${fmt((pi["新能源电量占比"] || 0) * 100, 1)}% → ${fmt((ai["新能源电量占比"] || 0) * 100, 1)}%`,
        `<span class="delta ${resD > 0 ? "down" : "flat"}" style="${resD > 0 ? "color:var(--green)" : ""}">${resD > 0 ? "▲" : "—"} ${fmt(resD, 1)}pp${state.params.res_min_share ? ` · 达成 ${state.params.res_min_share}% 配额目标` : ""}</span>`],
      ["投建容量 / 投资", `${fmt(pi["投建总容量_MW"], 0)} → ${fmt((pi["投建总容量_MW"] || 0) + capA, 0)} MW`,
        `<span class="delta blue" style="color:var(--blue)">投资 ${yi(invCost)}${budgetLeft != null ? ` · 预算余额 ${yi(budgetLeft)}` : ""}</span>`]
    ].map(([k, v, d]) => `<div class="kpi"><div class="k">${k}</div><div class="v" style="font-size:17px">${v}</div>${d}</div>`).join("");
    holder.append(dg);

    const grid = el("div", "grid2");
    // 关键指标对比表
    const rowsDef = [
      ["新能源发电量 MWh", "新能源发电量_MWh", 1, "up"],
      ["弃电电量 MWh", "弃电电量_MWh", 1, "bad"],
      ["储能放电量 MWh", "储能放电量_MWh", 1, "up"],
      ["总负荷电量 MWh", "总负荷电量_MWh", 1, "flat"],
      ["投建总容量 MW", "投建总容量_MW", 1, "up"],
      ["投资上限余额 亿元", "投资上限余额_元", 1e8, "bad"],
      ["平均供电成本 元/MWh", "平均供电成本_元每MWh", 1, "bad"]
    ];
    const tb = el("div", "card");
    tb.innerHTML = `<h3>关键指标对比</h3><table class="tbl"><thead><tr><th>指标</th><th>规划前</th><th>规划后</th><th>变化</th></tr></thead><tbody>` +
      rowsDef.map(([label, k, div, dir]) => {
        const a = pi[k], b = ai[k];
        const d = (b ?? 0) - (a ?? 0);
        const good = dir === "up" ? d > 0 : dir === "bad" ? d < 0 : null;
        const cls = dir === "flat" ? "flat" : good ? "green" : "red";
        const dTxt = dir === "flat" ? (Math.abs(d) < 1e-6 ? "持平" : fmt(d, 1)) : `${d > 0 ? "+" : ""}${fmt(d / div, div === 1e8 ? 2 : 1)}`;
        const color = cls === "green" ? "var(--green)" : cls === "red" ? "var(--red)" : "var(--text3)";
        return `<tr><td>${label}</td><td>${fmt(a, 1)}</td><td>${fmt(b, 1)}</td><td style="color:${color};font-weight:600">${dTxt}</td></tr>`;
      }).join("") + "</tbody></table>" +
      `<div class="dv-pass">两侧基于同一负荷口径对比；投资成本不作年化比较，以最优供电成本与新能源占比为主。</div>`;
    // 装机容量结构对比
    const capCard = el("div", "card");
    const kindAgg = sys => {
      const agg = {};
      sys.units.filter(u => !u.is_new).forEach(u => agg[u.kind] = (agg[u.kind] || 0) + u.cap);
      return agg;
    };
    const invByKind = {};
    (aftS["投建明细"] || []).forEach(i => {
      const u = aftSys.units.find(x => x.name === i["机组"]);
      if (u) invByKind[u.kind] = (invByKind[u.kind] || 0) + i["容量_MW"];
    });
    const preAgg = kindAgg(preSys), postAgg = { ...preAgg };
    Object.entries(invByKind).forEach(([k, v]) => postAgg[k] = (postAgg[k] || 0) + v);
    const allKinds = [...new Set([...Object.keys(preAgg), ...Object.keys(postAgg)])].map(Number).sort((a, b) => a - b);
    const sumOf = agg => allKinds.reduce((acc, k) => acc + (agg[k] || 0), 0);
    capCard.innerHTML = `<h3>装机容量结构对比（MW）</h3><div class='chart' id='cap-chart' style='height:180px'></div>
      ${(aftS["投建明细"] || []).length ? `<div class="dv-pass" style="margin-top:8px">新增投建明细：${aftS["投建明细"].map(i => `${i["机组"]}：${fmt(i["容量_MW"], 0)} MW${i["能量_MWh"] ? ` / ${fmt(i["能量_MWh"], 0)} MWh` : ""}`).join("；")}</div>` : ""}`;
    grid.append(tb, capCard); holder.append(grid);

    // 装机图
    mountChart("cap-chart").setOption({
      tooltip: {}, legend: { type: "scroll", data: allKinds.map(k => KIND_LABEL[k]) },
      grid: { left: 70, right: 60, top: 30, bottom: 24 },
      xAxis: { type: "value" },
      yAxis: { type: "category", data: ["规划前", "规划后"] },
      series: allKinds.map(k => ({
        name: KIND_LABEL[k] + (invByKind[k] ? "（含新建）" : ""), type: "bar", stack: "cap", barMaxWidth: 26,
        itemStyle: { color: KIND_COLOR[k] },
        data: [preAgg[k] || 0, postAgg[k] || 0],
        label: { show: true, position: "right", fontSize: 11, formatter: p => p.dataIndex === 1 ? fmt(sumOf(postAgg), 0) : (p.dataIndex === 0 ? fmt(sumOf(preAgg), 0) : "") }
      }))
    });

    // 全年新能源出力对比与负荷曲线
    const cmpCard = el("div", "card");
    cmpCard.innerHTML = `<h3>全年新能源出力对比与负荷曲线</h3><div class='chart' id='cv-chart' style='height:300px'></div>
      <div class="dv-pass">瞬时平衡约束下受区外来电注入与负荷曲线空间压迫出现弃电，高向绿线为切除弃电后覆盖率。</div>`;
    holder.append(cmpCard);
    const cur = await api(`/api/jobs/${state.compareAfter}/chart/dispatch`);
    const prev = await api(`/api/jobs/${state.comparePre}/chart/dispatch`);
    const T = Math.max(...Object.values(cur.series).map(a => a.length), ...Object.values(prev.series).map(a => a.length));
    const xs = [...Array(T).keys()].map(t => "T" + (t + 1));
    const resSum = dcs => {
      const names = Object.keys(dcs.series);
      const arr = new Array(T).fill(0);
      names.forEach(n => dcs.series[n].forEach((v, i) => arr[i] += v));
      return arr;
    };
    mountChart("cv-chart").setOption({
      tooltip: { trigger: "axis" }, legend: { data: ["系统总负荷", "新能源出力 · 规划前", "新能源出力 · 规划后"] },
      grid: { left: 60, right: 30, top: 40, bottom: 30 },
      xAxis: { type: "category", data: xs, boundaryGap: false },
      yAxis: { type: "value", name: "MW" },
      series: [
        { name: "系统总负荷", type: "line", showSymbol: false, lineStyle: { type: "dashed", color: "#1d2129", width: 2 }, itemStyle: { color: "#1d2129" }, data: cur.load || [] },
        { name: "新能源出力 · 规划前", type: "line", showSymbol: false, lineStyle: { color: "#86909c", width: 2 }, itemStyle: { color: "#86909c" }, data: resSum(prev) },
        { name: "新能源出力 · 规划后", type: "line", showSymbol: false, lineStyle: { color: "#00b578", width: 2.5 }, itemStyle: { color: "#00b578" }, data: resSum(cur) }
      ]
    });
  }
  draw();
}

/* ---------------- 路由与全局事件 ---------------- */
const VIEWS = { modeling: renderModeling, boundary: renderBoundary, params: renderParams, run: renderRun, result: renderResult, compare: renderCompare };
const TITLES = { modeling: "电力系统建模", boundary: "运行边界", params: "算法参数", run: "执行计算", result: "结果分析", compare: "对比分析" };

async function route() {
  const h = location.hash.replace("#/", "") || "modeling";
  const [view, arg] = h.split("/");
  if (!VIEWS[view]) return routeTo("modeling");
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  state.view = view;
  document.querySelectorAll("#nav a").forEach(a => a.classList.toggle("active", a.dataset.view === view));
  $("#crumb").textContent = "规划仿真 / " + TITLES[view];
  flowBar(view);
  try {
    await loadSystems();
    if (!state.sid) { renderNoSystem(); return; }
    await VIEWS[view](arg ? +arg : undefined);
  } catch (e) { $("#content").innerHTML = `<div class="card note-fail">加载失败：${e.message}</div>`; }
}
function routeTo(v) { location.hash = "#/" + v; }
document.querySelectorAll("#nav a").forEach(a => a.onclick = () => routeTo(a.dataset.view));
$("#sys-sel").onchange = e => { state.sid = +e.target.value; state.boundaryKey = ""; route(); };
$("#btn-new-sys").onclick = () => newSystemDialog();
$("#btn-save-ver").onclick = async () => {
  const s = curSystem(); if (!s) return toast("未选择系统");
  await api(`/api/systems/${state.sid}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version: s.version }) });
  toast(`已保存系统版本 ${s.version}`);
};
window.addEventListener("hashchange", route);
route();
