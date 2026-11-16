// ============================================================
// Atacama 2027 — app de planejamento de viagem
// Mobile-first, conectado ao Supabase (projeto Atacama_2027)
// ============================================================

let sb;
let state = {
  tripInfo: null,
  flights: [],
  accommodations: [],
  tours: [],
  days: [],
  items: [],
  expenses: [],
  rates: null, // { usd_brl, clp_brl, data_cotacao }
};

const MONEY = (v, moeda = "BRL") => {
  const n = Number(v || 0);
  try {
    return n.toLocaleString("pt-BR", { style: "currency", currency: moeda || "BRL" });
  } catch (e) {
    return `${moeda || "R$"} ${n.toFixed(2)}`;
  }
};

// Rótulo "em Nx de R$ Y" exibido junto ao preço quando o item está parcelado.
function installmentLabel(total, parcelado, parcelas, moeda) {
  if (!parcelado || !parcelas || parcelas < 2 || !total) return "";
  return `💳 em ${parcelas}x de ${MONEY(Number(total) / parcelas, moeda)}`;
}

// Soma o valor da parcela mensal de todos os itens parcelados de uma lista —
// usado no orçamento para mostrar o compromisso financeiro mensal da viagem.
function sumInstallments(arr, field) {
  return arr.reduce((acc, x) => acc + (x.parcelado && x.parcelas >= 2 ? (Number(x[field]) || 0) / x.parcelas : 0), 0);
}

// Insere o bloco "Parcelado? / Em quantas parcelas" em um formulário, e liga o
// comportamento de mostrar o campo de parcelas só quando "Sim" é selecionado.
function parcelamentoFieldsHTML(p, item) {
  const parcelado = !!item.parcelado;
  return `
    <div class="form-grid-2">
      <div class="form-row"><label>Parcelado?</label>
        <select id="${p}-parcelado">
          <option value="false" ${!parcelado ? "selected" : ""}>Não</option>
          <option value="true" ${parcelado ? "selected" : ""}>Sim</option>
        </select>
      </div>
      <div class="form-row" id="${p}-parcelas-row" style="${parcelado ? "" : "display:none"}">
        <label>Em quantas parcelas</label>
        <input type="number" min="2" step="1" id="${p}-parcelas" value="${item.parcelas ?? ""}"/>
      </div>
    </div>`;
}
function wireParcelamento(p) {
  const sel = document.getElementById(`${p}-parcelado`);
  const row = document.getElementById(`${p}-parcelas-row`);
  const sync = () => { row.style.display = sel.value === "true" ? "" : "none"; };
  sel.addEventListener("change", sync);
  sync();
}
function parcelamentoPayload(p) {
  const parcelado = val(`${p}-parcelado`) === "true";
  return { parcelado, parcelas: parcelado ? numOrNull(`${p}-parcelas`) : null };
}

const DATE_BR = (d) => {
  if (!d) return "—";
  const dt = new Date(d + (String(d).length === 10 ? "T00:00:00" : ""));
  if (isNaN(dt.getTime())) return d;
  return dt.toLocaleDateString("pt-BR");
};

function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => el.classList.add("hidden"), 2200);
}

// ---------------- PIN GATE ----------------
// Acesso a sessionStorage pode ser bloqueado em alguns contextos
// (ex: sandbox de artefatos). Essas funções nunca lançam erro.
function safeGetSession(key) {
  try { return sessionStorage.getItem(key); } catch (e) { return null; }
}
function safeSetSession(key, value) {
  try { sessionStorage.setItem(key, value); } catch (e) { /* ignora: sem persistência de sessão neste contexto */ }
}

function initPinGate() {
  const gate = document.getElementById("pin-gate");
  const app = document.getElementById("app");
  const unlocked = safeGetSession("atacama_unlocked") === "1";

  if (unlocked) {
    gate.classList.add("hidden");
    app.classList.remove("hidden");
    boot();
    return;
  }

  document.getElementById("pin-submit").addEventListener("click", tryUnlock);
  document.getElementById("pin-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") tryUnlock();
  });

  function tryUnlock() {
    const val = document.getElementById("pin-input").value.trim();
    const expectedPin = String(window.APP_PIN ?? "2027"); // fallback caso config.js não tenha carregado
    if (val === expectedPin) {
      safeSetSession("atacama_unlocked", "1");
      gate.classList.add("hidden");
      app.classList.remove("hidden");
      boot();
    } else {
      document.getElementById("pin-error").textContent = "Código incorreto. Tente novamente.";
      document.getElementById("pin-input").value = "";
    }
  }
}

// ---------------- BOOT ----------------
async function boot() {
  sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
  setupNav();
  setupModal();
  setupExchangeUI();
  await refreshAll();
}

async function refreshAll() {
  await Promise.all([
    loadTripInfo(),
    loadFlights(),
    loadAccommodations(),
    loadTours(),
    loadDaysAndItems(),
    loadExpenses(),
  ]);
  renderResumo();
  renderFlights();
  renderAccommodations();
  renderTours();
  renderDays();
  renderBudget();
  ensureExchangeRates(); // não bloqueia o resto do app enquanto busca a cotação
}

// ================= EXCHANGE RATES (USD/CLP -> BRL) =================
// Cacheado no Supabase: busca na API só uma vez por dia (o primeiro
// acesso do dia atualiza para todo mundo que usa o app).
async function ensureExchangeRates(force = false) {
  const todayStr = new Date().toISOString().slice(0, 10);
  const updatedEl = document.getElementById("exchange-updated");
  try {
    if (!force) {
      const { data, error } = await sb.from("exchange_rates").select("*").eq("id", 1).maybeSingle();
      if (!error && data && data.data_cotacao === todayStr) {
        state.rates = data;
        renderRates();
        return;
      }
      if (!error && data) state.rates = data; // usa como fallback enquanto busca atualização
    }
    if (updatedEl) updatedEl.textContent = "Atualizando cotação...";
    const resp = await fetch("https://open.er-api.com/v6/latest/USD");
    const json = await resp.json();
    if (json.result !== "success" || !json.rates?.BRL || !json.rates?.CLP) throw new Error("resposta inválida");
    const usd_brl = json.rates.BRL;
    const clp_brl = json.rates.BRL / json.rates.CLP;
    const payload = { id: 1, data_cotacao: todayStr, usd_brl, clp_brl, fonte: "open.er-api.com", updated_at: new Date().toISOString() };
    await sb.from("exchange_rates").upsert(payload);
    state.rates = payload;
    renderRates();
  } catch (e) {
    console.error("Falha ao buscar cotação:", e);
    if (state.rates) {
      renderRates(true);
    } else if (updatedEl) {
      updatedEl.textContent = "Não foi possível obter a cotação agora.";
    }
  }
}

function renderRates(stale = false) {
  const r = state.rates;
  if (!r) return;
  const usdChip = document.getElementById("rate-usd");
  const clpChip = document.getElementById("rate-clp");
  if (usdChip) usdChip.textContent = `USD R$ ${Number(r.usd_brl).toFixed(2)}`;
  if (clpChip) clpChip.textContent = `CLP R$ ${(Number(r.clp_brl) * 1000).toFixed(2)}/mil`;

  const updatedEl = document.getElementById("exchange-updated");
  if (updatedEl) {
    const dt = r.data_cotacao ? DATE_BR(r.data_cotacao) : "—";
    updatedEl.textContent = stale
      ? `Não foi possível atualizar agora — mostrando a última cotação (${dt}).`
      : `Cotação de ${dt} · 1 USD = R$ ${Number(r.usd_brl).toFixed(4)} · 1.000 CLP = R$ ${(Number(r.clp_brl) * 1000).toFixed(4)}`;
  }
  recalcConverters();
}

function recalcConverters() {
  const r = state.rates;
  if (!r) return;
  const usdInput = document.getElementById("conv-usd");
  const clpInput = document.getElementById("conv-clp");
  const usdResult = document.getElementById("conv-usd-result");
  const clpResult = document.getElementById("conv-clp-result");
  if (usdInput && usdResult) {
    const v = Number(usdInput.value || 0);
    usdResult.textContent = MONEY(v * Number(r.usd_brl));
  }
  if (clpInput && clpResult) {
    const v = Number(clpInput.value || 0);
    clpResult.textContent = MONEY(v * Number(r.clp_brl));
  }
}

function setupExchangeUI() {
  document.getElementById("conv-usd")?.addEventListener("input", recalcConverters);
  document.getElementById("conv-clp")?.addEventListener("input", recalcConverters);
  document.getElementById("btn-refresh-rates")?.addEventListener("click", () => {
    toast("Atualizando cotação...");
    ensureExchangeRates(true);
  });
}

// ---------------- NAVIGATION ----------------
function setupNav() {
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
      document.getElementById("view-" + btn.dataset.view).classList.remove("hidden");
    });
  });

  document.querySelectorAll(".section-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".section-tab").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      document.querySelectorAll(".sub-view").forEach((v) => v.classList.add("hidden"));
      document.getElementById("sub-" + btn.dataset.sub).classList.remove("hidden");
    });
  });

  document.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => handleAddAction(btn.dataset.action));
  });

  document.getElementById("btn-edit-trip").addEventListener("click", openTripInfoModal);
}

function handleAddAction(action) {
  const map = {
    "add-flight": openFlightModal,
    "add-accommodation": openAccommodationModal,
    "add-tour": openTourModal,
    "add-day": openDayModal,
    "add-expense": openExpenseModal,
  };
  if (map[action]) map[action]();
}

// ---------------- MODAL ----------------
function setupModal() {
  document.getElementById("modal-close").addEventListener("click", closeModal);
  document.getElementById("modal-overlay").addEventListener("click", (e) => {
    if (e.target.id === "modal-overlay") closeModal();
  });
}
function openModal(title, bodyHtml) {
  document.getElementById("modal-title").textContent = title;
  document.getElementById("modal-body").innerHTML = bodyHtml;
  document.getElementById("modal-overlay").classList.remove("hidden");
}
function closeModal() {
  document.getElementById("modal-overlay").classList.add("hidden");
}

// ================= TRIP INFO =================
async function loadTripInfo() {
  const { data, error } = await sb.from("trip_info").select("*").eq("id", 1).maybeSingle();
  if (error) { console.error(error); return; }
  state.tripInfo = data;
}

function renderResumo() {
  const t = state.tripInfo || {};
  document.getElementById("trip-name").textContent = t.nome || "Deserto do Atacama";
  document.getElementById("info-data-ida").textContent = DATE_BR(t.data_ida);
  document.getElementById("info-data-volta").textContent = DATE_BR(t.data_volta);
  document.getElementById("info-cidade-base").textContent = t.cidade_base || "—";
  document.getElementById("info-notas").textContent = t.notas || "";

  const countdownEl = document.getElementById("trip-countdown");
  if (t.data_ida) {
    const diff = Math.ceil((new Date(t.data_ida + "T00:00:00") - new Date()) / 86400000);
    countdownEl.textContent = diff > 0 ? `Faltam ${diff} dias ✦` : diff === 0 ? "É hoje! ✦" : "Viagem em andamento/concluída";
  } else {
    countdownEl.textContent = "Defina a data de ida";
  }

  document.getElementById("stat-flights").textContent = state.flights.length;
  document.getElementById("stat-hotels").textContent = state.accommodations.length;
  document.getElementById("stat-tours").textContent = state.tours.length;
  document.getElementById("stat-days").textContent = state.days.length;
}

function openTripInfoModal() {
  const t = state.tripInfo || {};
  openModal("Editar viagem", `
    <div class="form-row"><label>Nome da viagem</label><input id="f-nome" value="${t.nome || ""}"/></div>
    <div class="form-grid-2">
      <div class="form-row"><label>Data ida</label><input type="date" id="f-ida" value="${t.data_ida || ""}"/></div>
      <div class="form-row"><label>Data volta</label><input type="date" id="f-volta" value="${t.data_volta || ""}"/></div>
    </div>
    <div class="form-row"><label>Cidade base</label><input id="f-base" value="${t.cidade_base || "San Pedro de Atacama"}"/></div>
    <div class="form-row"><label>Orçamento total (R$)</label><input type="number" step="0.01" id="f-orcamento" value="${t.orcamento_total || ""}"/></div>
    <div class="form-row"><label>Notas</label><textarea id="f-notas">${t.notas || ""}</textarea></div>
    <div class="modal-footer"><button class="btn-save" id="f-save">Salvar</button></div>
  `);
  document.getElementById("f-save").addEventListener("click", async () => {
    const payload = {
      id: 1,
      nome: val("f-nome"), data_ida: val("f-ida") || null, data_volta: val("f-volta") || null,
      cidade_base: val("f-base"), orcamento_total: numOrNull("f-orcamento"), notas: val("f-notas"),
      updated_at: new Date().toISOString(),
    };
    const { error } = await sb.from("trip_info").upsert(payload);
    if (error) return toast("Erro ao salvar");
    closeModal(); toast("Viagem atualizada"); await loadTripInfo(); renderResumo(); renderBudget();
  });
}

function val(id) { return document.getElementById(id).value.trim(); }
function numOrNull(id) { const v = val(id); return v === "" ? null : Number(v); }

// ================= FLIGHTS =================
async function loadFlights() {
  const { data, error } = await sb.from("flights").select("*").order("data_partida", { ascending: true });
  if (error) { console.error(error); return; }
  state.flights = data || [];
}

function renderFlights() {
  const el = document.getElementById("list-flights");
  if (!state.flights.length) { el.innerHTML = emptyState("Nenhum voo cadastrado ainda."); return; }
  el.innerHTML = state.flights.map(f => `
    <div class="item-card status-${f.status}">
      <div class="item-top">
        <div>
          <p class="item-title">${f.origem} → ${f.destino}</p>
          <p class="item-sub">${f.companhia || "Cia a definir"} ${f.numero_voo ? "· " + f.numero_voo : ""}</p>
          <p class="item-sub">${f.data_partida ? new Date(f.data_partida).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "Data a definir"}</p>
        </div>
        <span class="item-price">${f.preco != null ? MONEY(f.preco, f.moeda) : ""}</span>
      </div>
      ${installmentLabel(f.preco, f.parcelado, f.parcelas, f.moeda) ? `<p class="item-sub">${installmentLabel(f.preco, f.parcelado, f.parcelas, f.moeda)}</p>` : ""}
      <span class="badge ${badgeClass(f.status)}">${f.status}</span>
      <div class="item-actions">
        <button data-edit="${f.id}">Editar</button>
        <button class="danger" data-del="${f.id}">Excluir</button>
      </div>
    </div>
  `).join("");

  el.querySelectorAll("[data-edit]").forEach(b => b.addEventListener("click", () => openFlightModal(state.flights.find(x => x.id === b.dataset.edit))));
  el.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", () => confirmDelete("flights", b.dataset.del, loadFlights, renderFlights)));
}

function badgeClass(status) {
  if (["confirmado", "pago", "concluido"].includes(status)) return "ok";
  if (["comprado", "reservado"].includes(status)) return "mid";
  return "";
}

function openFlightModal(f = {}) {
  openModal(f.id ? "Editar voo" : "Novo voo", `
    <div class="form-grid-2">
      <div class="form-row"><label>Tipo</label>
        <select id="f-tipo">
          ${["ida", "volta", "interno"].map(t => `<option value="${t}" ${f.tipo === t ? "selected" : ""}>${t}</option>`).join("")}
        </select>
      </div>
      <div class="form-row"><label>Status</label>
        <select id="f-status">
          ${["planejado", "comprado", "confirmado"].map(s => `<option value="${s}" ${f.status === s ? "selected" : ""}>${s}</option>`).join("")}
        </select>
      </div>
    </div>
    <div class="form-grid-2">
      <div class="form-row"><label>Origem</label><input id="f-origem" value="${f.origem || ""}"/></div>
      <div class="form-row"><label>Destino</label><input id="f-destino" value="${f.destino || ""}"/></div>
    </div>
    <div class="form-row"><label>Companhia aérea</label><input id="f-cia" value="${f.companhia || ""}"/></div>
    <div class="form-grid-2">
      <div class="form-row"><label>Nº do voo</label><input id="f-num" value="${f.numero_voo || ""}"/></div>
      <div class="form-row"><label>Preço (R$)</label><input type="number" step="0.01" id="f-preco" value="${f.preco ?? ""}"/></div>
    </div>
    <div class="form-grid-2">
      <div class="form-row"><label>Partida</label><input type="datetime-local" id="f-partida" value="${toLocalInput(f.data_partida)}"/></div>
      <div class="form-row"><label>Chegada</label><input type="datetime-local" id="f-chegada" value="${toLocalInput(f.data_chegada)}"/></div>
    </div>
    <div class="form-row"><label>Código da reserva</label><input id="f-cod" value="${f.codigo_reserva || ""}"/></div>
    ${parcelamentoFieldsHTML("f", f)}
    <div class="form-row"><label>Notas</label><textarea id="f-notas">${f.notas || ""}</textarea></div>
    <div class="modal-footer">
      <button class="btn-save" id="f-save">Salvar</button>
      ${f.id ? `<button class="btn-delete" id="f-del">Excluir</button>` : ""}
    </div>
  `);
  wireParcelamento("f");

  document.getElementById("f-save").addEventListener("click", async () => {
    const payload = {
      tipo: val("f-tipo"), status: val("f-status"), origem: val("f-origem"), destino: val("f-destino"),
      companhia: val("f-cia"), numero_voo: val("f-num"), preco: numOrNull("f-preco"),
      data_partida: val("f-partida") || null, data_chegada: val("f-chegada") || null,
      codigo_reserva: val("f-cod"), notas: val("f-notas"), updated_at: new Date().toISOString(),
      ...parcelamentoPayload("f"),
    };
    if (!payload.origem || !payload.destino) return toast("Informe origem e destino");

    if (payload.data_partida) {
      const [date, time] = payload.data_partida.split("T");
      const startMin = hhmmToMinutes(time?.slice(0, 5));
      if (startMin != null) {
        let endMin = startMin + 60;
        if (payload.data_chegada) {
          const [dateE, timeE] = payload.data_chegada.split("T");
          if (dateE === date) endMin = Math.max(hhmmToMinutes(timeE.slice(0, 5)), startMin + 1);
        }
        const conflicts = findConflicts(date, startMin, endMin, f.id ? { type: "flight", id: f.id } : null);
        if (conflicts.length) {
          const ok = await askConflictWarning(conflictMessage(conflicts));
          if (!ok) return;
        }
      }
    }

    let error, saved;
    if (f.id) ({ data: saved, error } = await sb.from("flights").update(payload).eq("id", f.id).select().single());
    else ({ data: saved, error } = await sb.from("flights").insert(payload).select().single());
    if (error) return toast("Erro ao salvar voo");
    closeModal(); toast("Voo salvo"); await loadFlights(); renderFlights(); renderResumo(); renderBudget();
    if (saved) await syncItineraryForFlight(saved);
  });

  if (f.id) document.getElementById("f-del").addEventListener("click", () => confirmDelete("flights", f.id, loadFlights, () => { renderFlights(); renderResumo(); renderBudget(); }, true));
}

function toLocalInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ================= ACCOMMODATIONS =================
async function loadAccommodations() {
  const { data, error } = await sb.from("accommodations").select("*").order("checkin", { ascending: true });
  if (error) { console.error(error); return; }
  state.accommodations = data || [];
}

function renderAccommodations() {
  const el = document.getElementById("list-accommodations");
  if (!state.accommodations.length) { el.innerHTML = emptyState("Nenhuma hospedagem cadastrada ainda."); return; }
  el.innerHTML = state.accommodations.map(a => `
    <div class="item-card status-${a.status}">
      <div class="item-top">
        <div>
          <p class="item-title">${a.nome}</p>
          <p class="item-sub">${a.cidade || ""}</p>
          <p class="item-sub">${DATE_BR(a.checkin)} → ${DATE_BR(a.checkout)}</p>
        </div>
        <span class="item-price">${a.preco_total != null ? MONEY(a.preco_total, a.moeda) : ""}</span>
      </div>
      ${installmentLabel(a.preco_total, a.parcelado, a.parcelas, a.moeda) ? `<p class="item-sub">${installmentLabel(a.preco_total, a.parcelado, a.parcelas, a.moeda)}</p>` : ""}
      <span class="badge ${badgeClass(a.status)}">${a.status}</span>
      <div class="item-actions">
        <button data-edit="${a.id}">Editar</button>
        <button class="danger" data-del="${a.id}">Excluir</button>
      </div>
    </div>
  `).join("");
  el.querySelectorAll("[data-edit]").forEach(b => b.addEventListener("click", () => openAccommodationModal(state.accommodations.find(x => x.id === b.dataset.edit))));
  el.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", () => confirmDelete("accommodations", b.dataset.del, loadAccommodations, () => { renderAccommodations(); renderResumo(); renderBudget(); })));
}

function openAccommodationModal(a = {}) {
  openModal(a.id ? "Editar hospedagem" : "Nova hospedagem", `
    <div class="form-row"><label>Nome</label><input id="a-nome" value="${a.nome || ""}"/></div>
    <div class="form-grid-2">
      <div class="form-row"><label>Cidade</label><input id="a-cidade" value="${a.cidade || "San Pedro de Atacama"}"/></div>
      <div class="form-row"><label>Status</label>
        <select id="a-status">${["planejado", "reservado", "pago"].map(s => `<option value="${s}" ${a.status === s ? "selected" : ""}>${s}</option>`).join("")}</select>
      </div>
    </div>
    <div class="form-grid-2">
      <div class="form-row"><label>Check-in</label><input type="date" id="a-checkin" value="${a.checkin || ""}"/></div>
      <div class="form-row"><label>Check-out</label><input type="date" id="a-checkout" value="${a.checkout || ""}"/></div>
    </div>
    <div class="form-row"><label>Preço total (R$)</label><input type="number" step="0.01" id="a-preco" value="${a.preco_total ?? ""}"/></div>
    <div class="form-row"><label>Código da reserva</label><input id="a-cod" value="${a.codigo_reserva || ""}"/></div>
    <div class="form-row"><label>Endereço</label><input id="a-endereco" value="${a.endereco || ""}"/></div>
    ${parcelamentoFieldsHTML("a", a)}
    <div class="form-row"><label>Notas</label><textarea id="a-notas">${a.notas || ""}</textarea></div>
    <div class="modal-footer">
      <button class="btn-save" id="a-save">Salvar</button>
      ${a.id ? `<button class="btn-delete" id="a-del">Excluir</button>` : ""}
    </div>
  `);
  wireParcelamento("a");
  document.getElementById("a-save").addEventListener("click", async () => {
    const payload = {
      nome: val("a-nome"), cidade: val("a-cidade"), status: val("a-status"),
      checkin: val("a-checkin") || null, checkout: val("a-checkout") || null,
      preco_total: numOrNull("a-preco"), codigo_reserva: val("a-cod"),
      endereco: val("a-endereco"), notas: val("a-notas"), updated_at: new Date().toISOString(),
      ...parcelamentoPayload("a"),
    };
    if (!payload.nome) return toast("Informe o nome da hospedagem");
    let error;
    if (a.id) ({ error } = await sb.from("accommodations").update(payload).eq("id", a.id));
    else ({ error } = await sb.from("accommodations").insert(payload));
    if (error) return toast("Erro ao salvar");
    closeModal(); toast("Hospedagem salva"); await loadAccommodations(); renderAccommodations(); renderResumo(); renderBudget();
  });
  if (a.id) document.getElementById("a-del").addEventListener("click", () => confirmDelete("accommodations", a.id, loadAccommodations, () => { renderAccommodations(); renderResumo(); renderBudget(); }, true));
}

// ================= TOURS =================
async function loadTours() {
  const { data, error } = await sb.from("tours").select("*").order("data", { ascending: true });
  if (error) { console.error(error); return; }
  state.tours = data || [];
}

function renderTours() {
  const el = document.getElementById("list-tours");
  if (!state.tours.length) { el.innerHTML = emptyState("Nenhum passeio cadastrado ainda."); return; }
  el.innerHTML = state.tours.map(t => `
    <div class="item-card status-${t.status}">
      <div class="item-top">
        <div>
          <p class="item-title">${t.nome}</p>
          <p class="item-sub">${t.categoria || ""}</p>
          <p class="item-sub">${DATE_BR(t.data)} ${t.horario ? "· " + t.horario : ""}</p>
        </div>
        <span class="item-price">${t.preco != null ? MONEY(t.preco, t.moeda) : ""}</span>
      </div>
      ${installmentLabel(t.preco, t.parcelado, t.parcelas, t.moeda) ? `<p class="item-sub">${installmentLabel(t.preco, t.parcelado, t.parcelas, t.moeda)}</p>` : ""}
      <span class="badge ${badgeClass(t.status)}">${t.status}</span>
      <div class="item-actions">
        <button data-edit="${t.id}">Editar</button>
        <button class="danger" data-del="${t.id}">Excluir</button>
      </div>
    </div>
  `).join("");
  el.querySelectorAll("[data-edit]").forEach(b => b.addEventListener("click", () => openTourModal(state.tours.find(x => x.id === b.dataset.edit))));
  el.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", () => confirmDelete("tours", b.dataset.del, loadTours, () => { renderTours(); renderResumo(); renderBudget(); renderDays(); })));
}

function openTourModal(t = {}) {
  openModal(t.id ? "Editar passeio" : "Novo passeio", `
    <div class="form-row"><label>Nome do passeio</label><input id="t-nome" value="${t.nome || ""}"/></div>
    <div class="form-grid-2">
      <div class="form-row"><label>Categoria</label><input id="t-categoria" placeholder="Ex: Vale da Lua" value="${t.categoria || ""}"/></div>
      <div class="form-row"><label>Status</label>
        <select id="t-status">${["planejado", "reservado", "pago", "concluido"].map(s => `<option value="${s}" ${t.status === s ? "selected" : ""}>${s}</option>`).join("")}</select>
      </div>
    </div>
    <div class="form-grid-2">
      <div class="form-row"><label>Data</label><input type="date" id="t-data" value="${t.data || ""}"/></div>
      <div class="form-row"><label>Horário de início</label><input type="time" id="t-horario" value="${/^\d{2}:\d{2}$/.test(t.horario || "") ? t.horario : ""}"/></div>
    </div>
    <div class="form-grid-2">
      <div class="form-row"><label>Duração (h)</label><input type="number" step="0.5" id="t-duracao" value="${t.duracao_horas ?? ""}"/></div>
      <div class="form-row"><label>Preço (R$)</label><input type="number" step="0.01" id="t-preco" value="${t.preco ?? ""}"/></div>
    </div>
    <div class="form-grid-2">
      <div class="form-row"><label>Altitude (m)</label><input type="number" id="t-altitude" value="${t.altitude_m ?? ""}"/></div>
      <div class="form-row"><label>Dificuldade</label><input id="t-dificuldade" value="${t.nivel_dificuldade || ""}"/></div>
    </div>
    <div class="form-row"><label>Agência</label><input id="t-agencia" value="${t.agencia || ""}"/></div>
    ${parcelamentoFieldsHTML("t", t)}
    <div class="form-row"><label>Notas</label><textarea id="t-notas">${t.notas || ""}</textarea></div>
    <div class="modal-footer">
      <button class="btn-save" id="t-save">Salvar</button>
      ${t.id ? `<button class="btn-delete" id="t-del">Excluir</button>` : ""}
    </div>
  `);
  wireParcelamento("t");
  document.getElementById("t-save").addEventListener("click", async () => {
    const payload = {
      nome: val("t-nome"), categoria: val("t-categoria"), status: val("t-status"),
      data: val("t-data") || null, horario: val("t-horario"), duracao_horas: numOrNull("t-duracao"),
      preco: numOrNull("t-preco"), altitude_m: numOrNull("t-altitude"), nivel_dificuldade: val("t-dificuldade"),
      agencia: val("t-agencia"), notas: val("t-notas"), updated_at: new Date().toISOString(),
      ...parcelamentoPayload("t"),
    };
    if (!payload.nome) return toast("Informe o nome do passeio");

    if (payload.data && payload.horario) {
      const startMin = hhmmToMinutes(payload.horario);
      if (startMin != null) {
        const dur = Number(payload.duracao_horas) || 1;
        const endMin = startMin + dur * 60;
        const conflicts = findConflicts(payload.data, startMin, endMin, t.id ? { type: "tour", id: t.id } : null);
        if (conflicts.length) {
          const ok = await askConflictWarning(conflictMessage(conflicts));
          if (!ok) return;
        }
      }
    }

    let error, saved;
    if (t.id) ({ data: saved, error } = await sb.from("tours").update(payload).eq("id", t.id).select().single());
    else ({ data: saved, error } = await sb.from("tours").insert(payload).select().single());
    if (error) return toast("Erro ao salvar passeio");
    closeModal(); toast("Passeio salvo"); await loadTours(); renderTours(); renderResumo(); renderBudget();
    if (saved) await syncItineraryForTour(saved);
  });
  if (t.id) document.getElementById("t-del").addEventListener("click", () => confirmDelete("tours", t.id, loadTours, () => { renderTours(); renderResumo(); renderBudget(); renderDays(); }, true));
}

// ================= ITINERARY (DAYS + ITEMS) =================
async function loadDaysAndItems() {
  const { data: days, error: e1 } = await sb.from("itinerary_days").select("*").order("data", { ascending: true });
  const { data: items, error: e2 } = await sb.from("itinerary_items").select("*").order("ordem", { ascending: true });
  if (e1 || e2) { console.error(e1, e2); return; }
  state.days = days || [];
  state.items = items || [];
}

function renderDays() {
  const el = document.getElementById("list-days");
  if (!state.days.length) { el.innerHTML = emptyState("Nenhum dia no roteiro ainda. Adicione o primeiro dia da viagem."); return; }
  el.innerHTML = state.days.map(d => {
    const items = state.items.filter(i => i.day_id === d.id).slice().sort((a, b) => {
      const ta = itemStartMinutes(a.horario), tb = itemStartMinutes(b.horario);
      if (ta == null && tb == null) return 0;
      if (ta == null) return 1; // itens sem horário definido vão para o fim
      if (tb == null) return -1;
      return ta - tb;
    });
    return `
    <div class="day-card">
      <div class="day-head">
        <div>
          <h3>Dia ${d.numero_dia}${d.titulo ? " · " + d.titulo : ""}</h3>
          <p class="day-date">${DATE_BR(d.data)}</p>
        </div>
        <div class="item-actions" style="margin:0; gap:6px;">
          <button data-edit-day="${d.id}" style="flex:none; padding:6px 10px;">Editar</button>
          <button class="danger" data-del-day="${d.id}" style="flex:none; padding:6px 10px;">Excluir</button>
        </div>
      </div>
      ${d.resumo ? `<p class="item-sub" style="margin-top:8px;">${d.resumo}</p>` : ""}
      <div class="day-items">
        ${items.map(i => `
          <div class="day-item-row">
            <span class="day-item-time">${i.horario || ""}</span>
            <div class="day-item-main">
              <div>${i.titulo}</div>
              <div class="day-item-type">${i.tipo}</div>
            </div>
            <button data-edit-item="${i.id}" style="flex:none; padding:4px 8px; border:none; background:none; color:var(--muted);">✎</button>
          </div>
        `).join("")}
      </div>
      <button class="btn-small-add" data-add-item="${d.id}">+ Adicionar item ao dia</button>
    </div>
  `}).join("");

  el.querySelectorAll("[data-edit-day]").forEach(b => b.addEventListener("click", () => openDayModal(state.days.find(x => x.id === b.dataset.editDay))));
  el.querySelectorAll("[data-del-day]").forEach(b => b.addEventListener("click", () => confirmDelete("itinerary_days", b.dataset.delDay, loadDaysAndItems, () => { renderDays(); renderResumo(); })));
  el.querySelectorAll("[data-add-item]").forEach(b => b.addEventListener("click", () => openItemModal({}, b.dataset.addItem)));
  el.querySelectorAll("[data-edit-item]").forEach(b => b.addEventListener("click", () => {
    const item = state.items.find(x => x.id === b.dataset.editItem);
    openItemModal(item, item.day_id);
  }));
}

function openDayModal(d = {}) {
  const nextNum = d.numero_dia || (state.days.length + 1);
  openModal(d.id ? "Editar dia" : "Novo dia do roteiro", `
    <div class="form-grid-2">
      <div class="form-row"><label>Data</label><input type="date" id="d-data" value="${d.data || ""}"/></div>
      <div class="form-row"><label>Nº do dia</label><input type="number" id="d-num" value="${nextNum}"/></div>
    </div>
    <div class="form-row"><label>Título</label><input id="d-titulo" placeholder="ex: Vale da Lua e Pôr do sol" value="${d.titulo || ""}"/></div>
    <div class="form-row"><label>Resumo</label><textarea id="d-resumo">${d.resumo || ""}</textarea></div>
    <div class="modal-footer">
      <button class="btn-save" id="d-save">Salvar</button>
      ${d.id ? `<button class="btn-delete" id="d-del">Excluir</button>` : ""}
    </div>
  `);
  document.getElementById("d-save").addEventListener("click", async () => {
    const payload = { data: val("d-data") || null, numero_dia: Number(val("d-num") || nextNum), titulo: val("d-titulo"), resumo: val("d-resumo") };
    if (!payload.data) return toast("Informe a data do dia");
    let error;
    if (d.id) ({ error } = await sb.from("itinerary_days").update(payload).eq("id", d.id));
    else ({ error } = await sb.from("itinerary_days").insert(payload));
    if (error) return toast("Erro ao salvar dia (verifique se já existe um dia com essa data)");
    closeModal(); toast("Dia salvo"); await loadDaysAndItems(); renderDays(); renderResumo();
  });
  if (d.id) document.getElementById("d-del").addEventListener("click", () => confirmDelete("itinerary_days", d.id, loadDaysAndItems, () => { renderDays(); renderResumo(); }, true));
}

function openItemModal(i = {}, dayId) {
  const flightOpts = state.flights.map(f => `<option value="${f.id}" ${i.flight_id === f.id ? "selected" : ""}>${f.origem} → ${f.destino}</option>`).join("");
  const tourOpts = state.tours.map(t => `<option value="${t.id}" ${i.tour_id === t.id ? "selected" : ""}>${t.nome}</option>`).join("");
  openModal(i.id ? "Editar item" : "Novo item do dia", `
    <div class="form-grid-2">
      <div class="form-row"><label>Horário</label><input id="i-horario" placeholder="ex: 08h00" value="${i.horario || ""}"/></div>
      <div class="form-row"><label>Tipo</label>
        <select id="i-tipo">${["atividade", "voo", "passeio", "traslado", "refeicao", "hospedagem", "livre"].map(t => `<option value="${t}" ${i.tipo === t ? "selected" : ""}>${t}</option>`).join("")}</select>
      </div>
    </div>
    <div class="form-row"><label>Título</label><input id="i-titulo" value="${i.titulo || ""}"/></div>
    <div class="form-row"><label>Vincular a um voo (opcional)</label><select id="i-flight"><option value="">—</option>${flightOpts}</select></div>
    <div class="form-row"><label>Vincular a um passeio (opcional)</label><select id="i-tour"><option value="">—</option>${tourOpts}</select></div>
    <div class="form-row"><label>Notas</label><textarea id="i-notas">${i.notas || ""}</textarea></div>
    <div class="modal-footer">
      <button class="btn-save" id="i-save">Salvar</button>
      ${i.id ? `<button class="btn-delete" id="i-del">Excluir</button>` : ""}
    </div>
  `);
  document.getElementById("i-flight").value = i.flight_id || "";
  document.getElementById("i-tour").value = i.tour_id || "";

  document.getElementById("i-save").addEventListener("click", async () => {
    const payload = {
      day_id: dayId, horario: val("i-horario"), tipo: val("i-tipo"), titulo: val("i-titulo"),
      flight_id: val("i-flight") || null, tour_id: val("i-tour") || null, notas: val("i-notas"),
      ordem: i.ordem ?? state.items.filter(x => x.day_id === dayId).length,
    };
    if (!payload.titulo) return toast("Informe o título do item");
    let error;
    if (i.id) ({ error } = await sb.from("itinerary_items").update(payload).eq("id", i.id));
    else ({ error } = await sb.from("itinerary_items").insert(payload));
    if (error) return toast("Erro ao salvar item");
    closeModal(); toast("Item salvo"); await loadDaysAndItems(); renderDays();
  });
  if (i.id) document.getElementById("i-del").addEventListener("click", () => confirmDelete("itinerary_items", i.id, loadDaysAndItems, renderDays, true));
}

// ================= EXPENSES / BUDGET =================
async function loadExpenses() {
  const { data, error } = await sb.from("expenses").select("*").order("data", { ascending: true });
  if (error) { console.error(error); return; }
  state.expenses = data || [];
}

function renderBudget() {
  const totalFlights = sum(state.flights, "preco");
  const totalHotels = sum(state.accommodations, "preco_total");
  const totalTours = sum(state.tours, "preco");
  const totalExpenses = sum(state.expenses, "valor");
  const total = totalFlights + totalHotels + totalTours + totalExpenses;
  const budget = Number(state.tripInfo?.orcamento_total || 0);

  const pct = budget > 0 ? Math.min(100, Math.round((total / budget) * 100)) : 0;
  document.getElementById("budget-fill").style.width = pct + "%";
  document.getElementById("budget-text").textContent = budget > 0
    ? `${MONEY(total)} de ${MONEY(budget)} (${pct}%)`
    : `${MONEY(total)} gastos até agora — defina um orçamento total em "Resumo"`;

  const mensalParcelas = sumInstallments(state.flights, "preco") + sumInstallments(state.accommodations, "preco_total")
    + sumInstallments(state.tours, "preco") + sumInstallments(state.expenses, "valor");

  const breakdown = document.getElementById("budget-breakdown");
  breakdown.innerHTML = [
    ["Voos", totalFlights], ["Hospedagem", totalHotels], ["Passeios", totalTours], ["Outras despesas", totalExpenses], ["Total", total],
  ].map(([label, v]) => `<div class="breakdown-row"><span>${label}</span><span>${MONEY(v)}</span></div>`).join("")
    + (mensalParcelas > 0 ? `<div class="breakdown-row breakdown-highlight"><span>💳 Compromisso mensal (parcelas em aberto)</span><span>${MONEY(mensalParcelas)}/mês</span></div>` : "");

  renderExpenses();
}

function sum(arr, field) { return arr.reduce((acc, x) => acc + (Number(x[field]) || 0), 0); }

function renderExpenses() {
  const el = document.getElementById("list-expenses");
  if (!state.expenses.length) { el.innerHTML = emptyState("Nenhuma despesa extra cadastrada."); return; }
  el.innerHTML = state.expenses.map(e => `
    <div class="item-card ${e.pago ? "status-pago" : ""}">
      <div class="item-top">
        <div>
          <p class="item-title">${e.descricao}</p>
          <p class="item-sub">${e.categoria} ${e.data ? "· " + DATE_BR(e.data) : ""}</p>
        </div>
        <span class="item-price">${MONEY(e.valor, e.moeda)}</span>
      </div>
      ${installmentLabel(e.valor, e.parcelado, e.parcelas, e.moeda) ? `<p class="item-sub">${installmentLabel(e.valor, e.parcelado, e.parcelas, e.moeda)}</p>` : ""}
      <span class="badge ${e.pago ? "ok" : ""}">${e.pago ? "pago" : "pendente"}</span>
      <div class="item-actions">
        <button data-edit="${e.id}">Editar</button>
        <button class="danger" data-del="${e.id}">Excluir</button>
      </div>
    </div>
  `).join("");
  el.querySelectorAll("[data-edit]").forEach(b => b.addEventListener("click", () => openExpenseModal(state.expenses.find(x => x.id === b.dataset.edit))));
  el.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", () => confirmDelete("expenses", b.dataset.del, loadExpenses, renderBudget)));
}

function openExpenseModal(e = {}) {
  openModal(e.id ? "Editar despesa" : "Nova despesa", `
    <div class="form-row"><label>Descrição</label><input id="e-desc" value="${e.descricao || ""}"/></div>
    <div class="form-grid-2">
      <div class="form-row"><label>Categoria</label><input id="e-cat" placeholder="ex: Seguro viagem" value="${e.categoria || ""}"/></div>
      <div class="form-row"><label>Valor (R$)</label><input type="number" step="0.01" id="e-valor" value="${e.valor ?? ""}"/></div>
    </div>
    <div class="form-grid-2">
      <div class="form-row"><label>Data</label><input type="date" id="e-data" value="${e.data || ""}"/></div>
      <div class="form-row"><label>Status</label>
        <select id="e-pago"><option value="false" ${!e.pago ? "selected" : ""}>Pendente</option><option value="true" ${e.pago ? "selected" : ""}>Pago</option></select>
      </div>
    </div>
    ${parcelamentoFieldsHTML("e", e)}
    <div class="form-row"><label>Notas</label><textarea id="e-notas">${e.notas || ""}</textarea></div>
    <div class="modal-footer">
      <button class="btn-save" id="e-save">Salvar</button>
      ${e.id ? `<button class="btn-delete" id="e-del">Excluir</button>` : ""}
    </div>
  `);
  wireParcelamento("e");
  document.getElementById("e-save").addEventListener("click", async () => {
    const payload = {
      descricao: val("e-desc"), categoria: val("e-cat") || "Outros", valor: Number(val("e-valor") || 0),
      data: val("e-data") || null, pago: val("e-pago") === "true", notas: val("e-notas"),
      ...parcelamentoPayload("e"),
    };
    if (!payload.descricao) return toast("Informe a descrição");
    let error;
    if (e.id) ({ error } = await sb.from("expenses").update(payload).eq("id", e.id));
    else ({ error } = await sb.from("expenses").insert(payload));
    if (error) return toast("Erro ao salvar despesa");
    closeModal(); toast("Despesa salva"); await loadExpenses(); renderBudget();
  });
  if (e.id) document.getElementById("e-del").addEventListener("click", () => confirmDelete("expenses", e.id, loadExpenses, renderBudget, true));
}

// ================= SHARED HELPERS =================
function emptyState(msg) { return `<div class="empty-state">${msg}</div>`; }

function askConfirmCustom(message, okLabel, cancelLabel, tone = "default") {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "confirm-overlay";
    wrap.innerHTML = `
      <div class="confirm-box">
        <p>${message}</p>
        <div class="confirm-actions">
          <button class="confirm-cancel" type="button">${cancelLabel}</button>
          <button class="confirm-ok ${tone === "warning" ? "warning" : ""}" type="button">${okLabel}</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    wrap.querySelector(".confirm-cancel").addEventListener("click", () => { wrap.remove(); resolve(false); });
    wrap.querySelector(".confirm-ok").addEventListener("click", () => { wrap.remove(); resolve(true); });
  });
}
function askConfirm(message) { return askConfirmCustom(message, "Excluir", "Cancelar"); }
function askConflictWarning(message) { return askConfirmCustom(message, "Salvar mesmo assim", "Ajustar horário", "warning"); }

async function confirmDelete(table, id, reload, rerender, closeModalAfter = false) {
  const ok = await askConfirm("Tem certeza que deseja excluir este item?");
  if (!ok) return;
  // Se o item a excluir tinha um espelho no roteiro (voo ou passeio), remove o espelho
  // ANTES de excluir o registro original: a FK em itinerary_items zera tour_id/flight_id
  // no instante em que a linha original é apagada, então precisamos localizar o espelho
  // enquanto a referência ainda é válida.
  if (table === "flights" || table === "tours") {
    const col = table === "flights" ? "flight_id" : "tour_id";
    await sb.from("itinerary_items").delete().eq(col, id);
  }
  const { error } = await sb.from(table).delete().eq("id", id);
  if (error) return toast("Erro ao excluir");
  if (table === "flights" || table === "tours") {
    await loadDaysAndItems();
    renderDays();
  }
  if (closeModalAfter) closeModal();
  toast("Excluído");
  await reload();
  rerender();
}

// ================= HORÁRIOS, CONFLITOS E SINCRONIA COM O ROTEIRO =================
function hhmmToMinutes(str) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(str || "").trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

// Extrai o horário de início de um texto de horário do roteiro, que pode ser
// um horário simples ("15:30") ou um intervalo ("02:00–05:00").
function itemStartMinutes(horario) {
  if (!horario) return null;
  const first = String(horario).split("–")[0].trim();
  return hhmmToMinutes(first);
}

function formatRange(startMin, endMin) {
  const fmt = (m) => {
    const mm = ((m % 1440) + 1440) % 1440;
    return `${String(Math.floor(mm / 60)).padStart(2, "0")}:${String(Math.floor(mm % 60)).padStart(2, "0")}`;
  };
  return `${fmt(startMin)}–${fmt(endMin)}`;
}

function tourToInterval(t) {
  if (!t.data || !t.horario) return null;
  const start = hhmmToMinutes(t.horario);
  if (start == null) return null;
  const dur = Number(t.duracao_horas) || 1;
  const end = start + dur * 60;
  return { date: t.data, start, end, label: `⛰ ${t.nome}`, range: formatRange(start, end) };
}

function flightToInterval(f) {
  if (!f.data_partida) return null;
  const [date, time] = f.data_partida.split("T");
  const start = hhmmToMinutes((time || "").slice(0, 5));
  if (start == null) return null;
  let end = start + 60;
  if (f.data_chegada) {
    const [dateE, timeE] = f.data_chegada.split("T");
    if (dateE === date) end = Math.max(hhmmToMinutes(timeE.slice(0, 5)), start + 1);
  }
  return { date, start, end, label: `✈ ${f.origem} → ${f.destino}`, range: formatRange(start, end) };
}

// Procura, entre os voos e passeios já cadastrados no mesmo dia, algum que
// se sobreponha ao intervalo [start,end) informado. "exclude" evita comparar
// o item com ele mesmo quando está sendo editado.
function findConflicts(date, start, end, exclude = null) {
  const intervals = [];
  state.tours.forEach((t) => {
    if (exclude?.type === "tour" && exclude.id === t.id) return;
    const iv = tourToInterval(t);
    if (iv && iv.date === date) intervals.push(iv);
  });
  state.flights.forEach((f) => {
    if (exclude?.type === "flight" && exclude.id === f.id) return;
    const iv = flightToInterval(f);
    if (iv && iv.date === date) intervals.push(iv);
  });
  return intervals.filter((iv) => iv.start < end && iv.end > start);
}

function conflictMessage(conflicts) {
  const lista = conflicts.map((c) => `"${c.label.replace(/^[⛰✈]\s*/, "")}" (${c.range})`).join(" e ");
  return `Você já tem ${lista} nesse mesmo horário. Quer salvar mesmo assim?`;
}

async function ensureDayForDate(date) {
  let day = state.days.find((d) => d.data === date);
  if (day) return day;
  const payload = { data: date, numero_dia: state.days.length + 1 };
  const { data, error } = await sb.from("itinerary_days").insert(payload).select().single();
  if (error) { console.error(error); return null; }
  state.days.push(data);
  return data;
}

async function upsertMirroredItem({ day_id, horario, titulo, tipo, tour_id = null, flight_id = null }) {
  const existing = state.items.find((i) => (flight_id && i.flight_id === flight_id) || (tour_id && i.tour_id === tour_id));
  const payload = { day_id, horario, titulo, tipo, tour_id, flight_id };
  if (existing) {
    const { error } = await sb.from("itinerary_items").update(payload).eq("id", existing.id);
    if (error) console.error(error);
  } else {
    const ordem = state.items.filter((i) => i.day_id === day_id).length;
    const { error } = await sb.from("itinerary_items").insert({ ...payload, ordem });
    if (error) console.error(error);
  }
}

async function removeMirroredItem(flight_id, tour_id) {
  const existing = state.items.find((i) => (flight_id && i.flight_id === flight_id) || (tour_id && i.tour_id === tour_id));
  if (existing) await sb.from("itinerary_items").delete().eq("id", existing.id);
}

// Cria/atualiza automaticamente o item correspondente no roteiro sempre
// que um passeio é salvo — criando o dia, se ainda não existir.
async function syncItineraryForTour(tour) {
  if (!tour.data) {
    await removeMirroredItem(null, tour.id);
  } else {
    const day = await ensureDayForDate(tour.data);
    if (day) {
      const start = tour.horario ? hhmmToMinutes(tour.horario) : null;
      const dur = Number(tour.duracao_horas) || null;
      const horarioLabel = start != null ? (dur ? formatRange(start, start + dur * 60) : tour.horario) : (tour.horario || "");
      await upsertMirroredItem({ day_id: day.id, horario: horarioLabel, titulo: `⛰ ${tour.nome}`, tipo: "passeio", tour_id: tour.id });
    }
  }
  await loadDaysAndItems();
  renderDays();
  renderResumo();
}

// O mesmo, mas para voos — usa data/hora de partida e chegada.
async function syncItineraryForFlight(flight) {
  if (!flight.data_partida) {
    await removeMirroredItem(flight.id, null);
  } else {
    const [date, time] = flight.data_partida.split("T");
    const day = await ensureDayForDate(date);
    if (day) {
      const startTime = (time || "").slice(0, 5);
      let horarioLabel = startTime;
      if (flight.data_chegada) {
        const [dateE, timeE] = flight.data_chegada.split("T");
        if (dateE === date && timeE) horarioLabel = `${startTime}–${timeE.slice(0, 5)}`;
      }
      await upsertMirroredItem({ day_id: day.id, horario: horarioLabel, titulo: `✈ ${flight.origem} → ${flight.destino}`, tipo: "voo", flight_id: flight.id });
    }
  }
  await loadDaysAndItems();
  renderDays();
  renderResumo();
}

document.addEventListener("DOMContentLoaded", initPinGate);
