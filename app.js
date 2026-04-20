/* JD Facturation – Refonte (local-only)
   - Devis + Factures
   - PDF (html2pdf)
   - Gmail compose pré-rempli (sans pièce jointe auto)
   - Stockage local + export/import
*/

const $ = (id)=>document.getElementById(id);

const STORAGE_KEY = "jd.billing.v2";
const DRAFT_KEY   = "jd.billing.draft";
let   draftTimer   = null;
let   previewTimer = null;
const HISTORY_PAGE_SIZE = 50;
let   historyPage  = 0;
const DEFAULTS = {
  settings: {
    brand: "Jeune Designer Studio",
    legalName: "",
    status: "Entrepreneur individuel – Micro-entreprise (Micro-BNC)",
    siret: "",
    ape: "",
    email: "",
    phone: "",
    address: "",
    vatMode: "exempt",
    vatRate: 20,
    vatMention: "TVA non applicable, art. 293 B du CGI",
    payTerms: "",
    lateFee: "",
    recoveryFee: "40 € (si client pro)",
    footer: ""
  },
  template: {
    subject: "{type} {no} — {client}",
    body:
`Bonjour {client},

Veuillez trouver ci-joint votre {type} {no}.
Date : {date}
Total : {total}

Cordialement,
{brand}`
  },
  counters: { quote: 1, invoice: 1 },
  history: [],
  clients: []
};

let store = loadStore();

let editorState = emptyDoc("quote");

init();

function init(){
  // Topbar export/import
  $("btnExport").addEventListener("click", exportJSON);
  const btnExport2 = $("btnExport2");
  if(btnExport2) btnExport2.addEventListener("click", exportJSON);
  $("importFile").addEventListener("change", importJSON);

  // Sidebar routes
  document.querySelectorAll(".nav__item").forEach(btn=>{
    btn.addEventListener("click", ()=> route(btn.dataset.route));
  });

  // Mobile preview toggle
  const btnTogglePreview = $("btnTogglePreview");
  if(btnTogglePreview){
    btnTogglePreview.addEventListener("click", ()=>{
      const right = document.querySelector(".editor__right");
      right.classList.toggle("mob-visible");
      btnTogglePreview.textContent = right.classList.contains("mob-visible") ? "▲ Masquer l'aperçu" : "Voir l'aperçu ▼";
    });
  }

  // Mobile menu
  const btnMenu = $("btnMenu");
  const overlay = $("overlay");
  const closeMenu = ()=>{
    document.body.classList.remove("menu-open");
    if(overlay) overlay.hidden = true;
  };
  const openMenu = ()=>{
    document.body.classList.add("menu-open");
    if(overlay) overlay.hidden = false;
  };
  if(btnMenu) btnMenu.addEventListener("click", ()=>{
    document.body.classList.contains("menu-open") ? closeMenu() : openMenu();
  });
  if(overlay) overlay.addEventListener("click", closeMenu);
  // close menu after navigation on mobile
  document.querySelectorAll(".nav__item,[data-go]").forEach(el=>{
    el.addEventListener("click", ()=>{
      if(window.matchMedia("(max-width: 860px)").matches) closeMenu();
    });
  });



  initClientsUI();

  // Dashboard shortcuts
  document.querySelectorAll("[data-go]").forEach(btn=>{
    btn.addEventListener("click", ()=> route(btn.dataset.go));
  });

  // Editor hooks
  $("docType").addEventListener("change", ()=>{
    editorState.type = $("docType").value;
    syncEditorToUI(); setLockedUI(editorState.status==="final");
    scheduleDraftSave();
  });

  // TVA toggle (par document)
  const vatToggle = $("vatToggle");
  if(vatToggle){
    vatToggle.addEventListener("change", ()=>{
      editorState.vatEnabled = vatToggle.checked;
      if(!vatToggle.checked){
        $("taxRate").value = "0";
        editorState.taxRate = "0";
      }else{
        const pref = String(store.settings.vatRate ?? 20);
        if(toNum(editorState.taxRate)===0) $("taxRate").value = pref;
        editorState.taxRate = $("taxRate").value;
      }
      renderPreview();
      scheduleDraftSave();
    });
  }

  // steppers remise/acompte
  const bindStep = (minusId, plusId, key)=>{
    const minus = $(minusId), plus = $(plusId), inp = $(key);
    if(!minus || !plus || !inp) return;
    const bump = (d)=>{
      const next = Math.max(0, round2(toNum(inp.value) + d));
      inp.value = String(next);
      editorState[key] = inp.value;
      renderPreview();
      scheduleDraftSave();
      inp.focus();
      inp.select();
    };
    minus.addEventListener("click", ()=> bump(-5));
    plus.addEventListener("click", ()=> bump(5));
  };
  bindStep("discMinus","discPlus","discount");
  bindStep("depMinus","depPlus","deposit");

  ["docNo","docDate","docDue","cName","cEmail","cAddress","discount","deposit","notes","taxRate"].forEach(id=>{
    $(id).addEventListener("input", ()=>{
      editorState[id] = $(id).value;
      schedulePreview();
      scheduleDraftSave();
    });
  });

  $("btnAutoNo").addEventListener("click", ()=>{
    editorState.docNo = nextNumber(editorState.type);
    $("docNo").value = editorState.docNo;
    renderPreview();
    scheduleDraftSave();
  });

  $("btnAddLine").addEventListener("click", ()=>{
    editorState.lines.push({ desc:"Prestation", qty:1, price:0 });
    renderLines();
    renderPreview();
    scheduleDraftSave();
  });

  $("btnReset").addEventListener("click", ()=>{
    editorState = emptyDoc(editorState.type);
    syncEditorToUI(); setLockedUI(editorState.status==="final");
    toast("Formulaire réinitialisé");
  });

  $("btnSave").addEventListener("click", ()=>{
    saveCurrentToHistory();
  });

  $("btnPdf").addEventListener("click", async ()=>{
    const ok = await downloadCurrentPDF();
    if(ok) toast("PDF téléchargé ✅");
  });

  $("btnSend").addEventListener("click", async ()=>{
    await sendFlow();
  });

  $("btnConvert").addEventListener("click", ()=>{
    convertCurrentQuoteToInvoice();
  });

  // History
  $("historyFilter").addEventListener("change", ()=>{ historyPage=0; renderHistory(); });
  $("historySearch").addEventListener("input",  ()=>{ historyPage=0; renderHistory(); });
  $("btnClearHistory").addEventListener("click", ()=>{
    if(!confirm("Vider l'historique ?")) return;
    store.history = [];
    saveStore();
    renderAll();
    toast("Historique vidé");
  });

  // Settings
  $("btnSaveSettings").addEventListener("click", ()=>{
    store.settings.brand = $("sBrand").value.trim();
    store.settings.legalName = $("sLegalName").value.trim();
    store.settings.status = $("sStatus").value.trim();
    store.settings.siret = $("sSiret").value.trim();
    store.settings.ape = $("sApe").value.trim();
    store.settings.email = $("sEmail").value.trim();
    store.settings.phone = $("sPhone").value.trim();
    store.settings.address = $("sAddress").value.trim();

    store.settings.vatMode = $("sVatMode").value;
    store.settings.vatRate = toNum($("sVatRate").value);
    store.settings.vatMention = $("sVatMention").value.trim() || "TVA non applicable, art. 293 B du CGI";

    store.settings.payTerms = $("sPayTerms").value.trim();
    store.settings.lateFee = $("sLateFee").value.trim();
    store.settings.recoveryFee = $("sRecoveryFee").value.trim();

    store.settings.footer = $("sFooter").value.trim();
    saveStore();
    renderPreview();
    toast("Paramètres sauvegardés");
  });

  $("btnResetTemplate").addEventListener("click", ()=>{
    store.template = structuredClone(DEFAULTS.template);
    syncSettingsToUI();
    saveStore();
    toast("Template réinitialisé");
  });

  $("btnSaveTemplate").addEventListener("click", ()=>{
    store.template.subject = $("tSubject").value;
    store.template.body = $("tBody").value;
    saveStore();
    toast("Template sauvegardé");
  });

  // Keyboard shortcuts
  document.addEventListener("keydown", e=>{
    if((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey){
      if(e.key==="s"){ e.preventDefault(); saveCurrentToHistory(); }
      if(e.key==="p"){ e.preventDefault(); downloadCurrentPDF().then(ok=>{ if(ok) toast("PDF téléchargé ✅","ok"); }); }
    }
  });

  // New client shortcut button (in editor)
  const btnNewClientShortcut = $("btnNewClientShortcut");
  if(btnNewClientShortcut) btnNewClientShortcut.addEventListener("click", ()=> route("clients"));

  // popstate (bouton retour/suivant)
  window.addEventListener("popstate", e=>{
    const r = e.state?.route || "dashboard";
    route(r, {silent:true, push:false, force:true});
  });

  // Initial UI — lire le hash si présent
  const VALID_ROUTES = ["dashboard","quote","invoice","history","clients","settings"];
  const hashRoute = window.location.hash.slice(1);
  const initRoute = VALID_ROUTES.includes(hashRoute) ? hashRoute : "dashboard";
  history.replaceState({route: initRoute}, "", "#" + initRoute);
  route(initRoute, {silent:true, push:false});
  // Pre-fill editor with one line
  if(editorState.lines.length === 0) editorState.lines.push({ desc:"Prestation", qty:1, price:0 });
  syncSettingsToUI();
  syncEditorToUI(); setLockedUI(editorState.status==="final");
  renderAll();

  // Restore draft if any
  try{
    const raw = localStorage.getItem(DRAFT_KEY);
    if(raw){
      const draft = JSON.parse(raw);
      if(draft && (draft.cName || (draft.lines && draft.lines.length > 1) || draft.docNo)){
        editorState = draft;
        syncEditorToUI(); setLockedUI(editorState.status==="final");
      }
    }
  }catch(e){ /* ignore */ }
  setAutoSaveStatus("saved");
}

function route(name, {silent=false, push=true, force=false}={}){
  // Guard : avertir si brouillon non sauvegardé et on quitte l'éditeur
  if(!force){
    const inEditor = $("view-editor").classList.contains("is-active");
    const goEditor = name==="quote" || name==="invoice";
    if(inEditor && !goEditor && hasDraft()){
      if(!confirm("Tu as un brouillon non enregistré. Quitter l'éditeur ?")){
        return;
      }
    }
  }

  if(!silent && push) history.pushState({route: name}, "", "#" + name);

  // active nav
  document.querySelectorAll(".nav__item").forEach(b=>b.classList.toggle("is-active", b.dataset.route===name));
  // show view
  document.querySelectorAll(".view").forEach(v=>v.classList.remove("is-active"));

  if(name==="quote" || name==="invoice"){
    $("view-editor").classList.add("is-active");
    editorState.type = name;
    $("docType").value = name;
    syncEditorToUI(); setLockedUI(editorState.status==="final");
    renderPreview();
    setPageTitle(name==="quote" ? "Nouveau devis" : "Nouvelle facture", "Crée, télécharge, envoie via Gmail");
  } else if(name==="history"){
    $("view-history").classList.add("is-active");
    setPageTitle("Historique", "Tous tes devis & factures enregistrés localement");
    renderHistory();
  } else if(name==="settings"){
    $("view-settings").classList.add("is-active");
    setPageTitle("Paramètres", "Ton identité + templates d'email");
    syncSettingsToUI();
  } else if(name==="clients"){
    $("view-clients").classList.add("is-active");
    setPageTitle("Clients", "Carnet d'adresses");
  } else {
    $("view-dashboard").classList.add("is-active");
    setPageTitle("Tableau de bord", "Vue rapide (local)");
    renderDashboard();
  }

  if(!silent) window.scrollTo({top:0, behavior:"smooth"});
}

function setPageTitle(title, meta){
  $("pageTitle").textContent = title;
  $("pageMeta").textContent = meta;
}

/* -------------------------
   Data
------------------------- */
function loadStore(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(!raw) return structuredClone(DEFAULTS);
    const parsed = JSON.parse(raw);
    // Merge defaults
    return deepMerge(structuredClone(DEFAULTS), parsed);
  }catch(e){
    console.warn("store load error", e);
    return structuredClone(DEFAULTS);
  }
}
function saveStore(){
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

function deepMerge(a,b){
  for(const k of Object.keys(b||{})){
    if(b[k] && typeof b[k]==="object" && !Array.isArray(b[k])){
      a[k] = deepMerge(a[k]||{}, b[k]);
    }else{
      a[k] = b[k];
    }
  }
  return a;
}

function emptyDoc(type){
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth()+1).padStart(2,"0");
  const dd = String(today.getDate()).padStart(2,"0");
  return {
    type,
    status: "draft",
    finalizedAt: null,
    docNo: "",
    docDate: `${yyyy}-${mm}-${dd}`,
    serviceDate: "",
    dueDate: "",
    vatEnabled: null,
    clientVat: "",
    docDue: type==="quote" ? "Validité 30 jours" : "",
    cName: "",
    cEmail: "",
    cAddress: "",
    taxRate: "0",
    discount: "0",
    deposit: "0",
    notes: "",
    lines: []
  };
}

function nextNumber(type){
  const yyyy = new Date().getFullYear();
  const prefix = type==="quote" ? "DEV" : "FAC";
  const n = store.counters[type] || 1;
  const no = `${prefix}-${yyyy}-${String(n).padStart(4,"0")}`;
  store.counters[type] = n + 1;
  saveStore();
  return no;
}

/* -------------------------
   UI Sync
------------------------- */
function syncEditorToUI(){
  $("editorTitle").textContent = editorState.type==="quote" ? "Devis" : "Facture";
  $("docType").value = editorState.type;

  $("docNo").value = editorState.docNo || "";
  $("docNo").disabled = false;
  $("docDate").value = editorState.docDate || "";
  $("docDue").value = editorState.docDue || "";

  $("cName").value = editorState.cName || "";
  $("cEmail").value = editorState.cEmail || "";
  $("cAddress").value = editorState.cAddress || "";

  // TVA: par défaut, on prend le réglage Paramètres, sauf si override du document
  const prefVatEnabled = (store.settings.vatMode || "exempt") === "standard";
  const enabled = (editorState.vatEnabled === null || editorState.vatEnabled === undefined) ? prefVatEnabled : !!editorState.vatEnabled;
  if($("vatToggle")) $("vatToggle").checked = enabled;

  if(enabled){
    const rate = String(toNum(editorState.taxRate) || toNum(store.settings.vatRate) || 20);
    $("taxRate").value = rate;
    editorState.taxRate = rate;
  }else{
    $("taxRate").value = "0";
    editorState.taxRate = "0";
  }
  $("discount").value = editorState.discount ?? "0";
  $("deposit").value = editorState.deposit ?? "0";
  $("notes").value = editorState.notes || "";

  // Show Devis→Facture only when editing a quote
  const btnConvert = $("btnConvert");
  if(btnConvert) btnConvert.style.display = editorState.type==="quote" ? "" : "none";

  renderLines();
  renderPreview();
}

function syncSettingsToUI(){
  $("sBrand").value = store.settings.brand || "";
  $("sLegalName").value = store.settings.legalName || "";
  $("sStatus").value = store.settings.status || "";
  $("sSiret").value = store.settings.siret || "";
  $("sApe").value = store.settings.ape || "";
  $("sEmail").value = store.settings.email || "";
  $("sPhone").value = store.settings.phone || "";
  $("sAddress").value = store.settings.address || "";

  $("sVatMode").value = store.settings.vatMode || "exempt";
  $("sVatRate").value = String(store.settings.vatRate ?? 20);
  $("sVatMention").value = store.settings.vatMention || "TVA non applicable, art. 293 B du CGI";

  $("sPayTerms").value = store.settings.payTerms || "";
  $("sLateFee").value = store.settings.lateFee || "";
  $("sRecoveryFee").value = store.settings.recoveryFee || "40 € (si client pro)";

  $("sFooter").value = store.settings.footer || "";

  $("tSubject").value = store.template.subject || "";
  $("tBody").value = store.template.body || "";
}

/* -------------------------
   Lines
------------------------- */
function renderLines(){
  const wrap = $("lines");
  wrap.innerHTML = "";

  if(editorState.lines.length===0){
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.textContent = 'Aucune ligne. Clique "+ Ajouter".';
    wrap.appendChild(empty);
    return;
  }

  editorState.lines.forEach((ln, idx)=>{
    const el = document.createElement("div");
    el.className = "lineItem";

    const qtyVal = Number(ln.qty ?? 1);
    const priceVal = Number(ln.price ?? 0);

    el.innerHTML = `
      <div class="lineGrid">
        <div class="field">
          <label>Description</label>
          <input data-k="desc" value="${escapeHTML(ln.desc||"")}" />
        </div>

        <div class="field">
          <label>Qté</label>
          <input data-k="qty" type="number" step="1" min="0" value="${Number.isFinite(qtyVal)?qtyVal:1}" />
        </div>

        <div class="field">
          <label>Prix (€)</label>
          <div class="stepper">
            <button class="btnMini" type="button" data-step="-5" title="-5">-5</button>
            <input data-k="price" type="number" step="5" min="0" value="${Number.isFinite(priceVal)?priceVal:0}" />
            <button class="btnMini" type="button" data-step="5" title="+5">+5</button>
          </div>
          <div class="help">Astuce : flèches = pas de 5€</div>
        </div>

        <div class="field">
          <label>Total</label>
          <input data-total value="${fmtEUR(lineTotal(ln))}" disabled />
        </div>
      </div>

      <div class="lineActions">
        <div class="lineReorder">
          <button class="btnMini" type="button" data-move-up="${idx}" title="Monter" ${idx===0?"disabled":""}>▲</button>
          <button class="btnMini" type="button" data-move-down="${idx}" title="Descendre">▼</button>
        </div>
        <button class="btn btn--ghost" type="button" data-cancel="${idx}">Supprimer</button>
      </div>
    `;

    const totalInput = el.querySelector("input[data-total]");

    el.querySelectorAll("input[data-k]").forEach(inp=>{
      inp.addEventListener("input", ()=>{
        const k = inp.dataset.k;
        editorState.lines[idx][k] = inp.value;
        totalInput.value = fmtEUR(lineTotal(editorState.lines[idx]));
        schedulePreview();
        scheduleDraftSave();
      });
    });

    el.querySelectorAll("button[data-step]").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        const delta = toNum(btn.dataset.step);
        const cur = toNum(editorState.lines[idx].price);
        const next = Math.max(0, round2(cur + delta));
        editorState.lines[idx].price = next;
        const priceInput = el.querySelector('input[data-k="price"]');
        priceInput.value = String(next);
        totalInput.value = fmtEUR(lineTotal(editorState.lines[idx]));
        renderPreview();
        scheduleDraftSave();
        priceInput.focus();
        priceInput.select();
      });
    });

    el.querySelector("[data-cancel]").addEventListener("click", ()=>{
      editorState.lines.splice(idx,1);
      renderLines();
      renderPreview();
      scheduleDraftSave();
    });

    const moveUpBtn = el.querySelector("[data-move-up]");
    const moveDnBtn = el.querySelector("[data-move-down]");
    if(moveDnBtn && idx >= editorState.lines.length - 1) moveDnBtn.disabled = true;
    if(moveUpBtn) moveUpBtn.addEventListener("click", ()=>{
      if(idx===0) return;
      [editorState.lines[idx-1], editorState.lines[idx]] = [editorState.lines[idx], editorState.lines[idx-1]];
      renderLines(); renderPreview(); scheduleDraftSave();
    });
    if(moveDnBtn) moveDnBtn.addEventListener("click", ()=>{
      if(idx >= editorState.lines.length-1) return;
      [editorState.lines[idx], editorState.lines[idx+1]] = [editorState.lines[idx+1], editorState.lines[idx]];
      renderLines(); renderPreview(); scheduleDraftSave();
    });

    wrap.appendChild(el);
  });
}

function lineTotal(ln){
  const qty = toNum(ln.qty);
  const price = toNum(ln.price);
  return round2(qty * price);
}

function calcTotals(doc){
  const subtotal = round2((doc.lines||[]).reduce((s,ln)=>s+lineTotal(ln),0));
  const discount = toNum(doc.discount);
  const vatEnabled = (doc.vatEnabled === null || doc.vatEnabled === undefined) ? ((store.settings.vatMode||"exempt")==="standard") : !!doc.vatEnabled;
  const taxRate = vatEnabled ? toNum(doc.taxRate) : 0;
  const taxable = Math.max(0, subtotal - discount);
  const tax = round2(taxable * (taxRate/100));
  const total = round2(taxable + tax);
  const deposit = toNum(doc.deposit);
  const remaining = round2(Math.max(0, total - deposit));
  return { subtotal, discount, taxable, tax, total, deposit, remaining, taxRate };
}

/* -------------------------
   Preview render
------------------------- */
function renderPreview(){
  const paper = $("docPaper");
  const t = calcTotals(editorState);
  $("totalsPill").textContent = `Total: ${fmtEUR(t.total)}`;

  const typeLabel = editorState.type==="quote" ? "DEVIS" : "FACTURE";

  const brandMeta = [store.settings.address, store.settings.email, store.settings.phone].filter(Boolean).join("\n");
  const clientMeta = [editorState.cAddress].filter(Boolean).join("\n");

  const rows = (editorState.lines||[]).map(ln=>{
    return `
      <div class="docTableRow">
        <div class="desc">${escapeHTML(ln.desc||"")}</div>
        <div class="right">${fmtNum(toNum(ln.qty))}</div>
        <div class="right">${fmtEUR(toNum(ln.price))}</div>
        <div class="right">${fmtEUR(lineTotal(ln))}</div>
      </div>
    `;
  }).join("");

  const dueLine = editorState.docDue ? `<div class="docType__date">Échéance / validité : ${escapeHTML(editorState.docDue)}</div>` : "";

  paper.innerHTML = `
    <div class="doc">
      <div class="docHeader">
        <div class="docBrand">
          <img src="./crayonjd.svg" alt="" onerror="this.style.display='none'">
          <div>
            <div class="docBrand__name">${escapeHTML(store.settings.brand || "—")}</div>
            <div class="docBrand__meta">${escapeHTML(brandMeta || "")}</div>
          </div>
        </div>
        <div class="docType">
          <div class="docType__title">${typeLabel}</div>
          <div class="docType__no"><b>N°</b> ${escapeHTML(editorState.docNo || "—")}</div>
          <div class="docType__date">Date : ${escapeHTML(formatFR(editorState.docDate) || "—")}</div>
          ${dueLine}
        </div>
      </div>

      <div class="docBlock">
        <div class="docBox">
          <div class="docBox__title">Émetteur</div>
          <div class="docBox__text">${escapeHTML([store.settings.legalName, store.settings.brand].filter(Boolean).join(" — "))}\n${escapeHTML(store.settings.address||"")}</div>
        </div>
        <div class="docBox">
          <div class="docBox__title">Client</div>
          <div class="docBox__text">${escapeHTML(editorState.cName || "")}\n${escapeHTML(clientMeta || "")}\n${escapeHTML(editorState.cEmail || "")}</div>
        </div>
      </div>

      <div class="docTable">
        <div class="docTableHead">
          <div>Description</div><div class="right">Qté</div><div class="right">Prix</div><div class="right">Total</div>
        </div>
        ${rows || `<div class="docTableRow"><div class="desc">—</div><div class="right">—</div><div class="right">—</div><div class="right">—</div></div>`}
      </div>

      <div class="docTotals">
        <div class="totalsBox">
          <div class="totalsLine"><span>Sous-total</span><span>${fmtEUR(t.subtotal)}</span></div>
          <div class="totalsLine"><span>Remise</span><span>- ${fmtEUR(t.discount)}</span></div>
          <div class="totalsLine"><span>TVA (${fmtNum(t.taxRate)}%)</span><span>${fmtEUR(t.tax)}</span></div>
          <div class="totalsLine"><strong>Total</strong><strong>${fmtEUR(t.total)}</strong></div>
          ${t.deposit>0 ? `<div class="totalsLine"><span>Acompte</span><span>- ${fmtEUR(t.deposit)}</span></div>
          <div class="totalsLine"><strong>Reste</strong><strong>${fmtEUR(t.remaining)}</strong></div>` : ``}
        </div>
      </div>

      ${editorState.notes ? `<div class="docNotes"><b>Notes :</b> ${escapeHTML(editorState.notes)}</div>` : ``}

      <div class="docFooter">
        ${[
          store.settings.status ? store.settings.status : "",
          store.settings.siret ? `SIRET : ${store.settings.siret}` : "",
          store.settings.ape ? `APE : ${store.settings.ape}` : "",
          store.settings.payTerms ? `Conditions de paiement : ${store.settings.payTerms}` : "",
          store.settings.lateFee ? `Pénalités de retard : ${store.settings.lateFee}` : "",
          store.settings.recoveryFee ? `Indemnité forfaitaire de recouvrement (B2B) : ${store.settings.recoveryFee}` : "",
          ((store.settings.vatMode||"exempt")==="exempt") ? (store.settings.vatMention || "TVA non applicable, art. 293 B du CGI") : "",
          store.settings.footer || ""
        ].filter(Boolean).join("\n")}
      </div></div>
    </div>
  `;
}

/* -------------------------
   History
------------------------- */
function saveCurrentToHistory(){
  // Ensure docNo exists
  if(!editorState.docNo){
    editorState.docNo = nextNumber(editorState.type);
    $("docNo").value = editorState.docNo;
  }
  if(!editorState.cName){
    toast("Client manquant (nom)"); 
    route(editorState.type);
    return false;
  }
  const totals = calcTotals(editorState);

  const entry = {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2),
    type: editorState.type,
    no: editorState.docNo,
    date: editorState.docDate,
    client: editorState.cName,
    email: editorState.cEmail || "",
    total: totals.total,
    createdAt: new Date().toISOString(),
    data: structuredClone(editorState)
  };

  // Upsert by (type,no)
  const idx = store.history.findIndex(h=>h.type===entry.type && h.no===entry.no);
  if(idx>=0) store.history[idx] = entry;
  else store.history.unshift(entry);

  saveStore();
  try{ localStorage.removeItem(DRAFT_KEY); }catch(e){}
  setAutoSaveStatus("saved");
  historyPage = 0;
  renderAll();
  toast("Enregistré ✅");
  return true;
}

function renderHistory(){
  const filter = $("historyFilter").value;
  const q = ($("historySearch").value || "").trim().toLowerCase();

  const filtered = store.history.filter(h=>{
    if(filter!=="all" && h.type!==filter) return false;
    if(!q) return true;
    return (
      (h.no||"").toLowerCase().includes(q) ||
      (h.client||"").toLowerCase().includes(q) ||
      (h.email||"").toLowerCase().includes(q)
    );
  });

  $("historyEmpty").style.display = filtered.length ? "none" : "block";

  const table = $("historyTable");
  table.innerHTML = "";
  if(!filtered.length){ renderHistoryPager(0,0); return; }

  const totalPages = Math.ceil(filtered.length / HISTORY_PAGE_SIZE);
  historyPage = Math.min(historyPage, totalPages - 1);
  const start = historyPage * HISTORY_PAGE_SIZE;
  const rows  = filtered.slice(start, start + HISTORY_PAGE_SIZE);

  const head = document.createElement("div");
  head.className = "thead";
  head.innerHTML = `
    <div>Date</div><div>Type</div><div>Client</div>
    <div class="cell--right">Total</div><div>Numéro</div><div>Actions</div>
  `;
  table.appendChild(head);

  rows.forEach(h=>{
    const r = document.createElement("div");
    r.className = "trow";
    r.innerHTML = `
      <div>${escapeHTML(formatFR(h.date) || "")}</div>
      <div>${h.type==="quote" ? `<span class="badge badge--q">Devis</span>` : `<span class="badge badge--i">Facture</span>`}</div>
      <div>${escapeHTML(h.client || "")}</div>
      <div class="cell--right">${fmtEUR(toNum(h.total))}</div>
      <div>${escapeHTML(h.no || "")}</div>
      <div class="rowActions"></div>
    `;
    r.addEventListener("click", ()=>{
      editorState = structuredClone(h.data);
      $("docType").value = editorState.type;
      syncEditorToUI(); setLockedUI(editorState.status==="final");
      route(editorState.type, {force:true});
      toast("Document rechargé");
    });

    const pdfBtn = document.createElement("button");
    pdfBtn.className = "btnMini";
    pdfBtn.title = "Télécharger PDF";
    pdfBtn.textContent = "PDF";
    pdfBtn.addEventListener("click", async e=>{
      e.stopPropagation();
      const ok = await generatePDFFromState(structuredClone(h.data));
      if(ok) toast("PDF téléchargé ✅","ok");
    });

    const dupBtn = document.createElement("button");
    dupBtn.className = "btnMini";
    dupBtn.title = "Dupliquer comme brouillon";
    dupBtn.textContent = "Dup.";
    dupBtn.addEventListener("click", e=>{
      e.stopPropagation();
      const copy = structuredClone(h.data);
      copy.status = "draft";
      copy.docNo = "";
      copy.finalizedAt = null;
      editorState = copy;
      syncEditorToUI(); setLockedUI(false);
      route(copy.type, {force:true});
      toast("Document dupliqué");
    });

    r.querySelector(".rowActions").append(pdfBtn, dupBtn);
    table.appendChild(r);
  });

  renderHistoryPager(totalPages, filtered.length);
}

function renderHistoryPager(totalPages, total){
  let pager = $("historyPager");
  if(!pager){
    pager = document.createElement("div");
    pager.id = "historyPager";
    $("historyTable").insertAdjacentElement("afterend", pager);
  }
  pager.innerHTML = "";
  if(totalPages <= 1){ pager.hidden = true; return; }
  pager.hidden = false;

  const info = document.createElement("span");
  info.className = "pager__info";
  const from = historyPage * HISTORY_PAGE_SIZE + 1;
  const to   = Math.min((historyPage + 1) * HISTORY_PAGE_SIZE, total);
  info.textContent = `${from}–${to} sur ${total}`;

  const prev = document.createElement("button");
  prev.className = "btnMini";
  prev.textContent = "← Préc.";
  prev.disabled = historyPage === 0;
  prev.addEventListener("click", ()=>{ historyPage--; renderHistory(); });

  const next = document.createElement("button");
  next.className = "btnMini";
  next.textContent = "Suiv. →";
  next.disabled = historyPage >= totalPages - 1;
  next.addEventListener("click", ()=>{ historyPage++; renderHistory(); });

  pager.append(prev, info, next);
}

/* -------------------------
   Dashboard
------------------------- */
function renderDashboard(){
  const docs = store.history.length;
  const quotes = store.history.filter(h=>h.type==="quote").length;
  const invoices = store.history.filter(h=>h.type==="invoice").length;
  const invoicedTotal = round2(store.history.filter(h=>h.type==="invoice").reduce((s,h)=>s+toNum(h.total),0));

  $("kpiDocs").textContent = String(docs);
  $("kpiQuotes").textContent = String(quotes);
  $("kpiInvoices").textContent = String(invoices);
  $("kpiInvoiced").textContent = fmtEUR(invoicedTotal);

  $("kpiDocsSub").textContent = "Enregistrés dans l'historique";
  $("kpiQuotesSub").textContent = "Devis créés";
  $("kpiInvoicesSub").textContent = "Factures créées";

  // recents
  const list = $("recentList");
  const empty = $("recentEmpty");
  list.innerHTML = "";
  const recents = store.history.slice(0,5);
  empty.style.display = recents.length ? "none" : "block";

  recents.forEach(h=>{
    const el = document.createElement("div");
    el.className = "item";
    el.innerHTML = `
      <div class="item__left">
        <div class="item__title">${h.type==="quote" ? "Devis" : "Facture"} • ${escapeHTML(h.no||"")}</div>
        <div class="item__meta">${escapeHTML(h.client||"")} • ${escapeHTML(formatFR(h.date)||"")}</div>
      </div>
      <div class="pill">${fmtEUR(toNum(h.total))}</div>
    `;
    el.addEventListener("click", ()=>{
      editorState = structuredClone(h.data);
      syncEditorToUI(); setLockedUI(editorState.status==="final");
      route(h.type);
    });
    list.appendChild(el);
  });
}

function renderAll(){
  renderDashboard();
  renderHistory();
}

/* -------------------------
   PDF + Email
------------------------- */

function printFallback(){
  // Fallback universel : ouvre un onglet avec l'aperçu et lance l'impression.
  // Dans la boîte d'impression, choisis "Enregistrer en PDF".
  const html = $("docPaper").innerHTML;
  const w = window.open("", "_blank");
  if(!w){ toast("Popup bloquée : autorise les popups"); return; }
  w.document.open();
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Impression</title>
    <link rel="stylesheet" href="./document.css">
    <style>body{margin:0;background:#fff} .docPaper{box-shadow:none;border-radius:0;width:auto}</style>
  </head><body>${html}</body></html>`);
  w.document.close();
  w.focus();
  setTimeout(()=> w.print(), 350);
}

async function generatePDFFromState(state){
  const filename = `${state.type==="quote"?"DEVIS":"FACTURE"}_${(state.docNo||"SANS_NUM").replaceAll(" ","_")}`;

  // Render into live preview to get the latest HTML
  const saved = editorState;
  editorState = state;
  renderPreview();
  const html = $("docPaper").innerHTML;
  editorState = saved;
  renderPreview();

  // Open a dedicated print window — avoids all html2canvas / CORS / font issues.
  // The browser prints natively, fonts are loaded properly, result is a real PDF.
  const w = window.open("", "_blank");
  if(!w){
    toast("Popup bloquée — autorise les popups pour ce site", "error");
    return false;
  }

  w.document.open();
  w.document.write(`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${filename}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: #fff; }
    .docPaper { box-shadow: none !important; border-radius: 0 !important; margin: 0 !important; width: 210mm; }
    @page  { size: A4 portrait; margin: 0; }
    @media print { html, body { width: 210mm; } body { background: #fff !important; } }

    /* ── document.css inlined ── */
    .doc { font-family: 'Montserrat', ui-sans-serif, system-ui, sans-serif; padding: 30px 34px; line-height: 1.3; background: #fff; color: #111; }
    .docHeader { display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; border-bottom: 2px solid #f5a623; padding-bottom: 16px; }
    .docBrand { display: flex; align-items: center; gap: 12px; }
    .docBrand img { width: 52px; height: 52px; object-fit: contain; }
    .docBrand__name { font-weight: 900; font-size: 15px; letter-spacing: .2px; }
    .docBrand__meta { font-size: 10.5px; color: #555; margin-top: 4px; white-space: pre-line; line-height: 1.45; }
    .docType { text-align: right; }
    .docType__title { font-weight: 900; font-size: 20px; letter-spacing: 1px; text-transform: uppercase; color: #0a0a0a; }
    .docType__no   { font-size: 12px; color: #555; margin-top: 6px; font-weight: 700; }
    .docType__date { font-size: 11px; color: #777; margin-top: 3px; }
    .docBlock { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 16px; }
    .docBox { border: 1px solid #ebebeb; border-radius: 10px; padding: 12px 14px; }
    .docBox__title { font-weight: 900; font-size: 11px; margin-bottom: 6px; text-transform: uppercase; letter-spacing: .5px; color: #888; }
    .docBox__text  { font-size: 11px; color: #222; white-space: pre-line; line-height: 1.5; }
    .docTable { margin-top: 18px; border: 1px solid #ebebeb; border-radius: 10px; overflow: hidden; }
    .docTableHead, .docTableRow { display: grid; grid-template-columns: 1fr 90px 110px 110px; gap: 10px; padding: 10px 14px; align-items: center; }
    .docTableHead { background: #0a0a0a; color: #f5a623; font-weight: 900; font-size: 10.5px; text-transform: uppercase; letter-spacing: .5px; }
    .docTableRow { border-top: 1px solid #ebebeb; font-size: 11px; }
    .docTableRow .right { text-align: right; }
    .desc { white-space: pre-line; }
    .docTotals { display: flex; justify-content: flex-end; margin-top: 16px; }
    .totalsBox { width: 290px; border: 1px solid #ebebeb; border-radius: 10px; overflow: hidden; }
    .totalsLine { display: flex; justify-content: space-between; font-size: 11px; padding: 8px 14px; border-bottom: 1px solid #f0f0f0; }
    .totalsLine:last-child { border-bottom: none; background: #0a0a0a; color: #f5a623; font-weight: 900; font-size: 13px; }
    .totalsLine strong { font-weight: 800; }
    .docNotes { margin-top: 16px; font-size: 11px; color: #444; white-space: pre-line; border-left: 3px solid #f5a623; padding-left: 10px; line-height: 1.5; }
    .docFooter { margin-top: 18px; border-top: 1px solid #ebebeb; padding-top: 10px; font-size: 10px; color: #777; white-space: pre-line; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="docPaper">${html}</div>
  <script>
    var go = function(){ setTimeout(function(){ window.print(); }, 250); };
    if(document.fonts && document.fonts.ready){ document.fonts.ready.then(go); }
    else { setTimeout(go, 900); }
  <\/script>
</body>
</html>`);
  w.document.close();
  return true;
}

async function downloadCurrentPDF(){
  if(editorState.cName) saveCurrentToHistory();
  return await generatePDFFromState(structuredClone(editorState));
}

function buildEmail(doc){
  const typeLabel = doc.type==="quote" ? "Devis" : "Facture";
  const totals = calcTotals(doc);
  const vars = {
    type: typeLabel,
    no: doc.docNo || "",
    date: formatFR(doc.docDate) || "",
    client: doc.cName || "",
    total: fmtEUR(totals.total),
    brand: store.settings.brand || ""
  };

  const subject = applyTemplate(store.template.subject, vars);
  const body = applyTemplate(store.template.body, vars);

  return { to: doc.cEmail || "", subject, body };
}

function applyTemplate(str, vars){
  return String(str||"").replace(/\{(type|no|date|client|total|brand)\}/g, (_,k)=> vars[k] ?? "");
}

function gmailUrl(to, subject, body){
  return "https://mail.google.com/mail/?view=cm&fs=1"
    + `&to=${encodeURIComponent(to||"")}`
    + `&su=${encodeURIComponent(subject||"")}`
    + `&body=${encodeURIComponent(body||"")}`;
}

async function sendFlow(){
  // To avoid popup blocked: open blank sync, then redirect after pdf done.
  const w = window.open("about:blank", "_blank");

  const ok = await downloadCurrentPDF();

  const email = buildEmail(editorState);
  const url = gmailUrl(email.to, email.subject, email.body);

  if(w) w.location.href = url;
  else window.open(url, "_blank");

  toast(ok ? "PDF téléchargé ✅ Glisse-le dans Gmail" : "Gmail ouvert ✅ (PDF via impression si besoin)");
}

/* -------------------------
   Export / Import
------------------------- */
function exportJSON(){
  const data = {
    ...store,
    exportedAt: new Date().toISOString(),
    version: 2
  };
  const blob = new Blob([JSON.stringify(data,null,2)], {type:"application/json"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `jd_facturation_export_${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast("Export téléchargé");
}

async function importJSON(ev){
  const file = ev.target.files?.[0];
  ev.target.value = "";
  if(!file) return;

  try{
    const txt = await file.text();
    const data = JSON.parse(txt);

    // Merge history by (type,no)
    const incoming = Array.isArray(data.history) ? data.history : [];
    const map = new Map();
    [...store.history, ...incoming].forEach(h=>{
      const key = `${h.type}::${h.no}`;
      if(!map.has(key)) map.set(key, h);
      else{
        // keep newest
        const a = map.get(key);
        const keep = (new Date(h.createdAt||0) > new Date(a.createdAt||0)) ? h : a;
        map.set(key, keep);
      }
    });

    store.history = [...map.values()].sort((a,b)=> new Date(b.createdAt||0) - new Date(a.createdAt||0));
    store.settings = deepMerge(store.settings, data.settings||{});
    store.template = deepMerge(store.template, data.template||{});
    store.counters = deepMerge(store.counters, data.counters||{});

    saveStore();
    historyPage = 0;
    renderAll();
    toast("Import OK ✅");
  }catch(e){
    console.error(e);
    toast("Import impossible (JSON invalide)");
  }
}

/* -------------------------
   Utils
------------------------- */
let toastTimer;
function toast(msg, type){
  const el = $("toast");
  el.textContent = msg;
  el.className = "toast is-show" + (type ? " toast--" + type : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=> el.classList.remove("is-show"), 2200);
}

function setAutoSaveStatus(state){
  const el = $("autoSaveStatus");
  if(!el) return;
  const txt = el.querySelector(".autoSaveStatus__text");
  el.dataset.state = state;
  if(txt){
    if(state === "saved")   txt.textContent = "Sauvegardé";
    else if(state === "saving") txt.textContent = "Sauvegarde…";
    else if(state === "unsaved") txt.textContent = "Brouillon";
  }
}

function saveDraft(){
  try{ localStorage.setItem(DRAFT_KEY, JSON.stringify(editorState)); }catch(e){ console.warn("draft save failed", e); }
  setAutoSaveStatus("saved");
}

function scheduleDraftSave(){
  setAutoSaveStatus("unsaved");
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraft, 1500);
}

function schedulePreview(){
  clearTimeout(previewTimer);
  previewTimer = setTimeout(renderPreview, 120);
}

function hasDraft(){
  return editorState.status === "draft" && (
    !!editorState.cName ||
    !!editorState.docNo ||
    (editorState.lines||[]).some(l => toNum(l.price) > 0 || (l.desc && l.desc !== "Prestation"))
  );
}

function toNum(v){
  const n = Number(String(v??"").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}
function round2(n){ return Math.round((n + Number.EPSILON) * 100) / 100; }
function fmtEUR(n){
  const v = toNum(n);
  return v.toLocaleString("fr-FR", {style:"currency", currency:"EUR"});
}
function fmtNum(n){
  const v = toNum(n);
  return v.toLocaleString("fr-FR", {maximumFractionDigits: 2});
}
function formatFR(isoDate){
  if(!isoDate) return "";
  // Accept YYYY-MM-DD
  const m = String(isoDate).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if(!m) return isoDate;
  return `${m[3]}/${m[2]}/${m[1]}`;
}
function escapeHTML(s){
  return String(s??"")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}


function finalizeDocument(){
  if(editorState.status === "final") return;
  if(!editorState.docNo){
    editorState.docNo = nextNumber(editorState.type);
  }
  editorState.status = "final";
  editorState.finalizedAt = new Date().toISOString();
  saveCurrentToHistory();
  syncEditorToUI(); setLockedUI(editorState.status==="final");
  toast("Document finalisé");
}

function cancelDocument(){
  editorState.status = "cancelled";
  saveCurrentToHistory();
  syncEditorToUI(); setLockedUI(editorState.status==="final");
  toast("Document annulé");
}

function duplicateDocument(){
  const copy = JSON.parse(JSON.stringify(editorState));
  copy.status = "draft";
  copy.docNo = "";
  copy.finalizedAt = null;
  editorState = copy;
  syncEditorToUI(); setLockedUI(editorState.status==="final");
  toast("Document dupliqué");
}


function setLockedUI(locked){
  const editor = $("view-editor");
  if(!editor) return;
  editor.querySelectorAll("input, textarea, select, button").forEach(el=>{
    if(el.id === "btnReset") return;
    el.disabled = locked;
  });
}

function uid(){
  return (crypto && crypto.randomUUID) ? crypto.randomUUID() : ("id-"+Math.random().toString(16).slice(2)+Date.now());
}

function upsertClient(client){
  const arr = store.clients || (store.clients=[]);
  const idx = arr.findIndex(c=>c.id===client.id);
  if(idx>=0) arr[idx]=client;
  else arr.unshift(client);
  saveStore();
}
function deleteClient(id){
  store.clients = (store.clients||[]).filter(c=>c.id!==id);
  saveStore();
}
function getClient(id){
  return (store.clients||[]).find(c=>c.id===id) || null;
}

function initClientsUI(){
  const table = document.querySelector("#clientTable tbody");
  const empty = $("clientEmpty");
  const search = $("clientSearch");
  const modal = $("clientModal");
  const closeBtn = $("clientModalClose");
  const addBtn = $("btnAddClient");
  const saveBtn = $("btnSaveClient");
  const delBtn = $("btnDeleteClient");
  const manageBtn = $("btnManageClients");
  const pick = $("clientPick");

  let editingId = null;

  const openModal = (client=null)=>{
    editingId = client ? client.id : null;
    $("clientModalTitle").textContent = client ? "Modifier client" : "Nouveau client";
    $("clName").value = client?.name || "";
    $("clEmail").value = client?.email || "";
    $("clAddress").value = client?.address || "";
    $("clType").value = client?.type || "particulier";
    $("clVat").value = client?.vat || "";
    delBtn.hidden = !client;
    modal.hidden = false;
  };
  const closeModal = ()=>{ modal.hidden = true; };

  const render = ()=>{
    const q = (search?.value || "").toLowerCase().trim();
    const items = (store.clients||[]).filter(c=>{
      if(!q) return true;
      return (c.name||"").toLowerCase().includes(q) || (c.email||"").toLowerCase().includes(q);
    });
    table.innerHTML = "";
    empty.hidden = items.length!==0;
    items.forEach(c=>{
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><strong>${escapeHTML(c.name||"")}</strong><div class="muted" style="margin-top:6px;white-space:pre-line">${escapeHTML(c.address||"")}</div></td>
        <td>${escapeHTML(c.email||"")}</td>
        <td>${c.type==="pro" ? '<span class="badge">Pro</span>' : '<span class="badge">Particulier</span>'}</td>
        <td style="text-align:right">
          <button class="btn btn--ghost" data-edit="${c.id}">Modifier</button>
          <button class="btn" data-use="${c.id}">Utiliser</button>
        </td>`;
      table.appendChild(tr);
    });

    // bind row actions
    table.querySelectorAll("[data-edit]").forEach(b=> b.addEventListener("click", ()=> openModal(getClient(b.dataset.edit))));
    table.querySelectorAll("[data-use]").forEach(b=> b.addEventListener("click", ()=>{
      const c = getClient(b.dataset.use);
      if(!c) return;
      // apply to current doc
      applyClientToDoc(c);
      route(editorState.type);
      toast("Client appliqué");
    }));

    renderClientPick();
  };

  const renderClientPick = ()=>{
    if(!pick) return;
    const current = pick.value;
    pick.innerHTML = `<option value="">— Choisir —</option>` + (store.clients||[]).map(c=>`<option value="${c.id}">${escapeHTML(c.name||"")}</option>`).join("");
    if(current) pick.value = current;
  };

  const applyClientToDoc = (c)=>{
    $("cName").value = c.name || "";
    $("cEmail").value = c.email || "";
    $("cAddress").value = c.address || "";
    editorState.cName = $("cName").value;
    editorState.cEmail = $("cEmail").value;
    editorState.cAddress = $("cAddress").value;
    editorState.clientId = c.id;
    editorState.clientType = c.type || "particulier";
    editorState.clientVat = c.vat || "";
    renderPreview();
  };

  if(search) search.addEventListener("input", render);
  if(addBtn) addBtn.addEventListener("click", ()=> openModal(null));
  if(closeBtn) closeBtn.addEventListener("click", closeModal);
  if(modal) modal.addEventListener("click", (e)=>{ if(e.target===modal) closeModal(); });

  if(saveBtn) saveBtn.addEventListener("click", ()=>{
    const c = {
      id: editingId || uid(),
      name: $("clName").value.trim(),
      email: $("clEmail").value.trim(),
      address: $("clAddress").value.trim(),
      type: $("clType").value,
      vat: $("clVat").value.trim(),
      updatedAt: new Date().toISOString(),
    };
    if(!c.name){ toast("Nom client obligatoire"); return; }
    upsertClient(c);
    closeModal();
    render();
    toast("Client enregistré");
  });

  if(delBtn) delBtn.addEventListener("click", ()=>{
    if(!editingId) return;
    deleteClient(editingId);
    closeModal();
    render();
    toast("Client supprimé");
  });

  if(manageBtn) manageBtn.addEventListener("click", ()=> route("clients"));

  if(pick) pick.addEventListener("change", ()=>{
    const id = pick.value;
    const c = id ? getClient(id) : null;
    if(c) applyClientToDoc(c);
    else{
      editorState.clientId = "";
      // do not wipe fields
    }
  });

  // initial
  render();
}

function convertCurrentQuoteToInvoice(){
  if(editorState.type !== "quote"){ toast("Ouvre un devis d'abord"); return; }
  // duplicate into invoice draft
  const copy = JSON.parse(JSON.stringify(editorState));
  copy.type = "invoice";
  copy.status = "draft";
  copy.docNo = "";
  copy.finalizedAt = null;
  editorState = copy;
  // update docType select
  $("docType").value = "invoice";
  syncEditorToUI();
  renderLines();
  renderPreview();
  toast("Facture créée depuis devis");
}
