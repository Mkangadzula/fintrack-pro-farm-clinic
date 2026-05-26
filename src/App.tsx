import { useState, useEffect, useCallback, useRef } from "react";

// ─── Constants ────────────────────────────────────────────────────────────────
const MODULES = ["personal", "farming", "clinic"];
const MODULE_META = {
  personal: { label: "Personal",   icon: "👤", color: "#2563eb", light: "#eff6ff", border: "#bfdbfe" },
  farming:  { label: "Farming",    icon: "🌾", color: "#16a34a", light: "#f0fdf4", border: "#bbf7d0" },
  clinic:   { label: "Clinic Hub", icon: "🏥", color: "#7c3aed", light: "#f5f3ff", border: "#ddd6fe" },
};
const PERSONAL_CATS = ["Food","Transport","Utilities","Health","Education","Entertainment","Clothing","Savings","Other"];
const FARMING_CATS  = ["Produce Stock Purchase","Rainy Season Farming","Seeds","Fertiliser","Labour","Equipment","Irrigation","Pesticides","Harvest","Land Rent","BCH Farm Finance","Sales Income","Subsidy","Other"];
const CLINIC_CATS   = ["Farm Produce Finance","Loan Issued","Repayment Received","Interest Income","Application Fee","Penalty Income","Default","Operational Cost","Salary","Other"];
const LOAN_INTEREST_RATE = 35;
const LOAN_APPLICATION_FEE = 15000;
const ADMARC_PRICES = [
  { crop: "Maize",    unit: "50kg bag", price: 35000 },
  { crop: "Tobacco",  unit: "kg",       price: 2800  },
  { crop: "Soya",     unit: "50kg bag", price: 42000 },
  { crop: "Groundnut",unit: "50kg bag", price: 55000 },
  { crop: "Rice",     unit: "50kg bag", price: 48000 },
];

function cats(mod) {
  if (mod === "personal") return PERSONAL_CATS;
  if (mod === "farming")  return FARMING_CATS;
  return CLINIC_CATS;
}
function isIncome(mod, cat) {
  if (mod === "personal") return cat === "Savings";
  if (mod === "farming")  return ["BCH Farm Finance","Sales Income","Subsidy"].includes(cat);
  if (mod === "clinic")   return ["Repayment Received","Interest Income","Application Fee","Penalty Income"].includes(cat);
  return false;
}
function txIsIncome(mod, tx) {
  if (tx && tx.direction) return tx.direction === "credit";
  return isIncome(mod, tx.category);
}
function daysBetween(a, b) {
  var start = new Date(a+"T00:00:00");
  var end = new Date(b+"T00:00:00");
  return Math.max(0, Math.floor((end-start)/86400000));
}
function penaltyForDelay(daysLate) {
  if (daysLate <= 0) return 0;
  if (daysLate <= 5) return 15000;
  if (daysLate <= 10) return 20000;
  if (daysLate <= 15) return 25000;
  if (daysLate <= 20) return 30000;
  if (daysLate <= 25) return 35000;
  return 40000 * Math.max(1, Math.ceil(daysLate/30));
}
function loanTotals(loan) {
  var principal = +loan.amount || 0;
  var rate = loan.interestRate == null ? LOAN_INTEREST_RATE : +loan.interestRate;
  var appFee = loan.applicationFee == null ? LOAN_APPLICATION_FEE : +loan.applicationFee;
  var interest = principal * (rate/100);
  var lateDays = loan.due ? daysBetween(loan.due, today()) : 0;
  var penalty = penaltyForDelay(lateDays);
  var totalDue = principal + interest + appFee + penalty;
  var paid = (loan.repayments||[]).reduce(function(a,r){return a+(+r.amount||0);},0);
  return {principal:principal,rate:rate,appFee:appFee,interest:interest,lateDays:lateDays,penalty:penalty,totalDue:totalDue,paid:paid,outstanding:Math.max(0,totalDue-paid)};
}

// ─── Storage ──────────────────────────────────────────────────────────────────
const LEGACY_STORAGE_KEY = "fintrack_v4";
const AUTH_KEY = "fintrack_auth_v1";
const SESSION_KEY = "fintrack_session_v1";
function userDataKey(username) { return "fintrack_db_"+String(username||"").trim().toLowerCase(); }
function emptyDb() {
  return { personal:[], farming:[], clinic:[], loans:[], budgets:{personal:{},farming:{},clinic:{}}, goals:[] };
}
function normalizeDb(raw) {
  raw = raw || {};
  return {
    personal: raw.personal||[], farming: raw.farming||[], clinic: raw.clinic||[], loans: raw.loans||[],
    budgets: raw.budgets||{personal:{},farming:{},clinic:{}},
    goals: raw.goals||[],
  };
}
function loadLegacyDb() { try { return JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY)) || {}; } catch(e) { return {}; } }
function loadDb(username) { try { return normalizeDb(JSON.parse(localStorage.getItem(userDataKey(username))) || {}); } catch(e) { return emptyDb(); } }
function saveDb(username, d) { try { localStorage.setItem(userDataKey(username), JSON.stringify(d)); } catch(e) {} }
function loadUsers() { try { return JSON.parse(localStorage.getItem(AUTH_KEY)) || {}; } catch(e) { return {}; } }
function saveUsers(users) { try { localStorage.setItem(AUTH_KEY, JSON.stringify(users)); } catch(e) {} }
function loadSession() { try { return localStorage.getItem(SESSION_KEY) || ""; } catch(e) { return ""; } }
function saveSession(username) { try { localStorage.setItem(SESSION_KEY, username); } catch(e) {} }
function clearSession() { try { localStorage.removeItem(SESSION_KEY); } catch(e) {} }
function simpleHash(text) {
  var h = 2166136261;
  for (var i=0; i<text.length; i++) {
    h ^= text.charCodeAt(i);
    h += (h<<1) + (h<<4) + (h<<7) + (h<<8) + (h<<24);
  }
  return (h>>>0).toString(16);
}
function hashPassword(password, salt) { return simpleHash(salt+"|"+password+"|fintrack-pro"); }

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmt(n) { return "MK " + Number(n||0).toLocaleString("en-MW",{minimumFractionDigits:2,maximumFractionDigits:2}); }
function today() { return new Date().toISOString().slice(0,10); }
function uid()   { return Date.now().toString(36) + Math.random().toString(36).slice(2); }
function monthLabel(m) { return new Date(m+"-01").toLocaleDateString("en-MW",{month:"long",year:"numeric"}); }

// ─── SMS Parser ───────────────────────────────────────────────────────────────
function parseSmsBlob(raw) {
  const results = [];
  const blocks = raw.split(/\n{2,}|(?=From[\s:]626626)/i).map(function(b){ return b.trim(); }).filter(Boolean);
  blocks.forEach(function(block) {
    const hasMwk = /mwk/i.test(block);
    if (!hasMwk) return;
    const lines = block.split("\n").map(function(l){ return l.trim(); }).filter(Boolean);
    var amount = null, rawAmountStr = "";
    for (var i=0; i<lines.length; i++) {
      var m = lines[i].match(/mwk\s*([0-9,]+(?:\.[0-9]{1,2})?)/i);
      if (m) { rawAmountStr = m[1].replace(/,/g,""); amount = parseFloat(rawAmountStr); break; }
    }
    if (!amount || isNaN(amount)) return;
    var date = today();
    var months2 = {jan:"01",feb:"02",mar:"03",apr:"04",may:"05",jun:"06",jul:"07",aug:"08",sep:"09",oct:"10",nov:"11",dec:"12"};
    for (var j=0; j<lines.length; j++) {
      var dm;
      if ((dm = lines[j].match(/(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})/))) { date = dm[1]+"-"+dm[2].padStart(2,"0")+"-"+dm[3].padStart(2,"0"); break; }
      if ((dm = lines[j].match(/(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})/))) {
        var yy = dm[3].length === 2 ? "20"+dm[3] : dm[3];
        date = yy+"-"+dm[2].padStart(2,"0")+"-"+dm[1].padStart(2,"0"); break;
      }
      if ((dm = lines[j].match(/(\d{1,2})[\s\-](jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[\s\-](\d{2,4})/i))) {
        var yyyy = dm[3].length === 2 ? "20"+dm[3] : dm[3];
        date = yyyy+"-"+months2[dm[2].toLowerCase().slice(0,3)]+"-"+dm[1].padStart(2,"0"); break;
      }
    }
    var full = block.toLowerCase();
    var direction = "debit";
    var codeMatch = block.match(/\b(CR|DR)\b/i);
    if (codeMatch) direction = codeMatch[1].toUpperCase() === "CR" ? "credit" : "debit";
    else if (/received|credited|credit|deposit|deposited|transfer to you|paid to you|incoming|cr\b/i.test(block)) direction = "credit";
    if (!codeMatch && /deducted|debited|debit|paid|sent|withdrawal|withdrawn|charged|payment of|you have paid|dr\b/i.test(block)) direction = "debit";
    var note = "";
    for (var k=0; k<lines.length; k++) {
      var nm = lines[k].match(/(?:narration|ref(?:erence)?|description|for|to|from)[:\s]+(.+)/i);
      if (nm) { note = nm[1].trim().slice(0,80); break; }
    }
    if (!note) {
      for (var l=0; l<lines.length; l++) {
        if (/mwk|626626|\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4}/i.test(lines[l])) continue;
        if (lines[l].length > 5 && lines[l].length < 100) { note = lines[l].slice(0,80); break; }
      }
    }
    var suggestedCat = "";
    var suggestedModule = "personal";
    var relation = "personal";
    if (/(business clinic hub|clinic hub|bch).*(farm|produce|maize|groundnut)|finance.*(farm|produce)/.test(full)) {
      suggestedModule = "farming"; relation = "bch-farm-finance";
      suggestedCat = direction === "credit" ? "BCH Farm Finance" : "Produce Stock Purchase";
    }
    else if (/maize|groundnut|soya|rice|beans|produce|farm produce|crop buying|commodity/.test(full)) {
      suggestedModule = "farming"; relation = "farm-produce-trading";
      suggestedCat = direction === "credit" ? "Sales Income" : "Produce Stock Purchase";
    }
    else if (/rainy season|planting|seed|fertilis|agrodealer|farm|harvest|pesticide|labou?r/.test(full)) {
      suggestedModule = "farming"; relation = "rainy-season-farming";
      suggestedCat = /harvest|sale|sold|buyer/.test(full) && direction === "credit" ? "Sales Income" : "Rainy Season Farming";
    }
    else if (/business clinic hub|clinic hub|bch|loan|borrow|repay|lending|application fee|penalty|default/.test(full)) {
      suggestedModule = "clinic"; relation = "business-clinic-hub";
      if (/application fee|app fee/.test(full)) suggestedCat = "Application Fee";
      else if (/penalty|late fee|delay/.test(full)) suggestedCat = "Penalty Income";
      else suggestedCat = direction === "credit" ? "Repayment Received" : "Loan Issued";
    }
    else if (/airtel|tnm|mobile money|mpamba|momo/.test(full))         suggestedCat = "Other";
    else if (/salary|payroll|wage/.test(full))                        suggestedCat = "Savings";
    else if (/fuel|petrol|transport|bus|taxi/.test(full))             suggestedCat = "Transport";
    else if (/food|grocery|supermarket|shoprite|spar/.test(full))     suggestedCat = "Food";
    else if (/school|tuition|education/.test(full))                   suggestedCat = "Education";
    else if (/hospital|clinic|pharmacy|health|medical/.test(full))    suggestedCat = "Health";
    else if (/electricity|water|zesco|escom|utility/.test(full))      suggestedCat = "Utilities";
    results.push({
      id: uid(), raw: block, amount: amount, date: date, direction: direction,
      note: note, suggestedCat: suggestedCat, module: suggestedModule, relation: relation,
      category: suggestedCat || (direction === "credit" ? "Savings" : "Other"),
      type: "Bank SMS", status: "pending",
    });
  });
  return results;
}

// ─── AI Insights ──────────────────────────────────────────────────────────────
async function fetchInsights(mod, txns) {
  if (!txns.length) return "No transactions yet. Add some data to receive insights.";
  var summary = txns.slice(-60).map(function(t){
    return t.date+" | "+t.type+" | "+t.category+" | MK"+t.amount+" | "+(t.note||"-");
  }).join("\n");
  var prompt = "You are a financial advisor. Analyse these recent "+MODULE_META[mod].label+" transactions and provide:\n1. Key spending/income patterns (2-3 bullets)\n2. Biggest concerns or risks (1-2 bullets)\n3. Actionable recommendations (2-3 bullets)\n4. One motivational insight\n\nTransactions:\n"+summary+"\n\nKeep it concise, practical, and specific to the numbers. Use MK (Malawian Kwacha). Format with clear emoji headers.";
  var res = await fetch("https://api.anthropic.com/v1/messages", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ model:"claude-sonnet-4-20250514", max_tokens:1000, messages:[{role:"user",content:prompt}] })
  });
  var data = await res.json();
  return (data && data.content && data.content[0] && data.content[0].text) ? data.content[0].text : "Unable to generate insights.";
}

// ─── Styles ───────────────────────────────────────────────────────────────────
var inp = { width:"100%", boxSizing:"border-box", padding:"9px 12px", border:"1px solid #d1d5db", borderRadius:9, fontSize:14, fontFamily:"inherit", outline:"none", background:"#fafafa" };
var btnBase = { padding:"11px 0", border:"none", borderRadius:10, fontWeight:600, fontSize:14, cursor:"pointer", fontFamily:"inherit" };

// ─── Small Components ─────────────────────────────────────────────────────────
function Badge(props) {
  return <span style={{display:"inline-block",padding:"2px 10px",borderRadius:99,fontSize:11,fontWeight:600,background:props.color+"22",color:props.color}}>{props.children}</span>;
}
function StatCard(props) {
  return (
    <div style={{background:"#fff",borderRadius:14,padding:"18px 20px",border:"1px solid #e5e7eb",flex:1,minWidth:130,borderLeft:"4px solid "+props.accent}}>
      <div style={{fontSize:12,color:"#6b7280",fontWeight:500,marginBottom:4}}>{props.label}</div>
      <div style={{fontSize:20,fontWeight:700,color:"#111"}}>{props.value}</div>
      {props.sub && <div style={{fontSize:11,color:"#9ca3af",marginTop:2}}>{props.sub}</div>}
    </div>
  );
}
function TxRow(props) {
  var tx = props.tx; var mod = props.mod;
  var income = txIsIncome(mod, tx);
  var dirLabel = tx.direction ? (tx.direction === "credit" ? "CR" : "DR") : "";
  return (
    <div style={{display:"flex",alignItems:"center",gap:12,padding:"11px 14px",borderRadius:10,background:income?"#f0fdf4":"#fef2f2",border:"1px solid "+(income?"#bbf7d0":"#fecaca"),marginBottom:6,fontSize:13}}>
      <div style={{flex:1}}>
        <div style={{fontWeight:600,color:"#111"}}>
          {tx.category}
          {tx.source==="sms" && <span style={{fontSize:10,background:"#fef9c3",color:"#854d0e",borderRadius:4,padding:"1px 5px",marginLeft:6}}>SMS</span>}
          {dirLabel && <span style={{fontSize:10,background:income?"#dcfce7":"#fee2e2",color:income?"#166534":"#991b1b",borderRadius:4,padding:"1px 5px",marginLeft:6}}>{dirLabel}</span>}
          {tx.note && <span style={{fontWeight:400,color:"#6b7280"}}> — {tx.note}</span>}
        </div>
        <div style={{fontSize:11,color:"#9ca3af",marginTop:1}}>{tx.date} · {tx.type}</div>
      </div>
      <div style={{fontWeight:700,color:income?"#16a34a":"#dc2626",minWidth:100,textAlign:"right"}}>
        {income?"+":"-"}{fmt(tx.amount)}
      </div>
      <button onClick={function(){ props.onDelete(tx.id); }} style={{background:"none",border:"none",cursor:"pointer",color:"#d1d5db",fontSize:16,padding:"0 2px"}}>×</button>
    </div>
  );
}

// ─── Add Transaction Modal ────────────────────────────────────────────────────
function AddTxModal(props) {
  var mod = props.mod;
  var accent = MODULE_META[mod].color;
  var [form, setForm] = useState({ date:today(), category:cats(mod)[0], amount:"", note:"", type:"Cash" });
  function set(k){ return function(e){ setForm(function(f){ var n=Object.assign({},f); n[k]=e.target.value; return n; }); }; }
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.45)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000}}>
      <div style={{background:"#fff",borderRadius:18,padding:"28px 28px 24px",width:"min(95vw,420px)",boxShadow:"0 20px 60px rgba(0,0,0,.15)"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
          <h3 style={{margin:0,fontSize:17,fontWeight:700}}>New Transaction</h3>
          <button onClick={props.onClose} style={{background:"none",border:"none",fontSize:22,cursor:"pointer",color:"#6b7280"}}>×</button>
        </div>
        {[
          {label:"Date",el:<input type="date" value={form.date} onChange={set("date")} style={inp}/>},
          {label:"Category",el:<select value={form.category} onChange={set("category")} style={inp}>{cats(mod).map(function(c){return <option key={c}>{c}</option>;})}</select>},
          {label:"Amount (MK)",el:<input type="number" placeholder="0.00" value={form.amount} onChange={set("amount")} style={inp}/>},
          {label:"Method",el:<select value={form.type} onChange={set("type")} style={inp}>{["Cash","Mobile Money","Bank Transfer","Cheque","Other"].map(function(t){return <option key={t}>{t}</option>;})}</select>},
          {label:"Note (optional)",el:<input placeholder="Description..." value={form.note} onChange={set("note")} style={inp}/>},
        ].map(function(row){return <div key={row.label} style={{marginBottom:14}}><div style={{fontSize:12,fontWeight:600,color:"#374151",marginBottom:5}}>{row.label}</div>{row.el}</div>;})}
        <div style={{display:"flex",gap:10,marginTop:20}}>
          <button onClick={props.onClose} style={Object.assign({},btnBase,{flex:1,background:"#f3f4f6",color:"#374151"})}>Cancel</button>
          <button onClick={function(){
            if(!form.amount||isNaN(+form.amount)) return;
            props.onSave(Object.assign({},form,{id:uid(),amount:+form.amount,module:mod}));
            props.onClose();
          }} style={Object.assign({},btnBase,{flex:2,background:accent,color:"#fff"})}>Save Transaction</button>
        </div>
      </div>
    </div>
  );
}

// ─── Budget Manager ───────────────────────────────────────────────────────────
function BudgetPanel(props) {
  var mod = props.mod; var txns = props.txns;
  var accent = MODULE_META[mod].color;
  var [budgets, setBudgets] = useState(props.budgets || {});
  var [editing, setEditing] = useState(null);
  var [editVal, setEditVal] = useState("");
  var currentMonth = today().slice(0,7);
  var monthTxns = txns.filter(function(t){ return t.date.slice(0,7) === currentMonth && !txIsIncome(mod,t); });
  var catSpend = {};
  monthTxns.forEach(function(t){ catSpend[t.category] = (catSpend[t.category]||0)+t.amount; });

  function saveBudget(cat) {
    var v = parseFloat(editVal);
    if (!isNaN(v) && v > 0) {
      var nb = Object.assign({},budgets); nb[cat]=v; setBudgets(nb);
      props.onUpdate(nb);
    }
    setEditing(null); setEditVal("");
  }

  return (
    <div style={{background:"#fff",border:"1px solid #e5e7eb",borderRadius:14,padding:"20px",marginBottom:20}}>
      <div style={{fontWeight:700,fontSize:15,marginBottom:4}}>📊 Monthly Budget Targets</div>
      <div style={{fontSize:12,color:"#6b7280",marginBottom:16}}>{monthLabel(currentMonth)}</div>
      {cats(mod).filter(function(c){ return !isIncome(mod,c); }).map(function(cat){
        var spent = catSpend[cat] || 0;
        var budget = budgets[cat] || 0;
        var pct = budget > 0 ? Math.min(100, Math.round((spent/budget)*100)) : 0;
        var over = budget > 0 && spent > budget;
        return (
          <div key={cat} style={{marginBottom:14}}>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:13,marginBottom:4,alignItems:"center"}}>
              <span style={{fontWeight:500}}>{cat}</span>
              <div style={{display:"flex",gap:8,alignItems:"center"}}>
                {editing===cat ? (
                  <span style={{display:"flex",gap:4}}>
                    <input type="number" value={editVal} onChange={function(e){setEditVal(e.target.value);}} style={{width:100,padding:"3px 8px",border:"1px solid #d1d5db",borderRadius:6,fontSize:12}} placeholder="Budget MK"/>
                    <button onClick={function(){saveBudget(cat);}} style={{fontSize:11,padding:"3px 10px",background:accent,color:"#fff",border:"none",borderRadius:6,cursor:"pointer"}}>Set</button>
                    <button onClick={function(){setEditing(null);}} style={{fontSize:11,padding:"3px 8px",background:"#f3f4f6",border:"none",borderRadius:6,cursor:"pointer"}}>✕</button>
                  </span>
                ) : (
                  <span style={{display:"flex",gap:6,alignItems:"center"}}>
                    <span style={{color:over?"#dc2626":"#6b7280",fontSize:12}}>{fmt(spent)}{budget>0?" / "+fmt(budget):""}</span>
                    <button onClick={function(){setEditing(cat);setEditVal(budget||"");}} style={{fontSize:10,padding:"2px 8px",background:"#f3f4f6",border:"none",borderRadius:5,cursor:"pointer",color:"#6b7280"}}>{budget>0?"Edit":"Set"}</button>
                  </span>
                )}
              </div>
            </div>
            {budget > 0 && (
              <div style={{height:7,background:"#f3f4f6",borderRadius:99}}>
                <div style={{height:7,width:pct+"%",background:over?"#dc2626":pct>80?"#f59e0b":accent,borderRadius:99,transition:"width .4s"}}/>
              </div>
            )}
            {over && <div style={{fontSize:11,color:"#dc2626",marginTop:2}}>⚠ Over budget by {fmt(spent-budget)}</div>}
          </div>
        );
      })}
    </div>
  );
}

// ─── Savings Goals ────────────────────────────────────────────────────────────
function SavingsGoals(props) {
  var [goals, setGoals] = useState(props.goals || []);
  var [showForm, setShowForm] = useState(false);
  var [form, setForm] = useState({name:"",target:"",deadline:"",saved:""});
  function setF(k){ return function(e){ setForm(function(f){ var n=Object.assign({},f); n[k]=e.target.value; return n; }); }; }
  function addGoal(){
    if(!form.name||!form.target) return;
    var ng = goals.concat([{id:uid(),name:form.name,target:+form.target,saved:+(form.saved||0),deadline:form.deadline}]);
    setGoals(ng); props.onUpdate(ng);
    setForm({name:"",target:"",deadline:"",saved:""}); setShowForm(false);
  }
  function updateSaved(id, v){
    var ng = goals.map(function(g){ return g.id===id ? Object.assign({},g,{saved:Math.min(g.target,Math.max(0,+v))}) : g; });
    setGoals(ng); props.onUpdate(ng);
  }
  function deleteGoal(id){
    var ng = goals.filter(function(g){ return g.id!==id; });
    setGoals(ng); props.onUpdate(ng);
  }
  return (
    <div style={{background:"#fff",border:"1px solid #e5e7eb",borderRadius:14,padding:"20px",marginBottom:20}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
        <div style={{fontWeight:700,fontSize:15}}>🎯 Savings Goals</div>
        <button onClick={function(){setShowForm(function(s){return !s;});}} style={Object.assign({},btnBase,{padding:"7px 16px",background:"#2563eb",color:"#fff",fontSize:12})}>+ Goal</button>
      </div>
      {showForm && (
        <div style={{background:"#eff6ff",borderRadius:12,padding:14,marginBottom:14}}>
          {[{label:"Goal Name",k:"name",ph:"e.g. New Tractor"},{label:"Target (MK)",k:"target",ph:"0"},{label:"Already Saved (MK)",k:"saved",ph:"0"},{label:"Deadline",k:"deadline",type:"date"}].map(function(row){
            return <div key={row.k} style={{marginBottom:10}}><div style={{fontSize:12,fontWeight:600,marginBottom:4}}>{row.label}</div><input type={row.type||"text"} placeholder={row.ph} value={form[row.k]} onChange={setF(row.k)} style={inp}/></div>;
          })}
          <div style={{display:"flex",gap:8}}><button onClick={function(){setShowForm(false);}} style={Object.assign({},btnBase,{flex:1,background:"#e5e7eb",color:"#374151",padding:"9px 0"})}>Cancel</button><button onClick={addGoal} style={Object.assign({},btnBase,{flex:2,background:"#2563eb",color:"#fff",padding:"9px 0"})}>Add Goal</button></div>
        </div>
      )}
      {goals.length===0 && <div style={{color:"#9ca3af",textAlign:"center",padding:"20px 0"}}>No savings goals yet</div>}
      {goals.map(function(g){
        var pct = Math.min(100,Math.round((g.saved/g.target)*100));
        var done = pct>=100;
        return (
          <div key={g.id} style={{border:"1px solid "+(done?"#bbf7d0":"#bfdbfe"),borderRadius:12,padding:"14px 16px",marginBottom:10,background:done?"#f0fdf4":"#eff6ff"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8}}>
              <div><div style={{fontWeight:700}}>{g.name}</div>{g.deadline&&<div style={{fontSize:11,color:"#6b7280"}}>By {g.deadline}</div>}</div>
              <div style={{textAlign:"right"}}><div style={{fontWeight:700,color:"#2563eb"}}>{fmt(g.saved)} / {fmt(g.target)}</div><Badge color={done?"#16a34a":"#2563eb"}>{done?"✓ Complete":pct+"%"}</Badge></div>
            </div>
            <div style={{height:8,background:"#e5e7eb",borderRadius:99,marginBottom:10}}><div style={{height:8,width:pct+"%",background:done?"#16a34a":"#2563eb",borderRadius:99,transition:"width .4s"}}/></div>
            {!done && (
              <div style={{display:"flex",gap:6,alignItems:"center"}}>
                <input type="number" placeholder="Update saved MK" style={Object.assign({},inp,{flex:1,padding:"6px 10px",fontSize:12})} onBlur={function(e){if(e.target.value)updateSaved(g.id,e.target.value);e.target.value="";}} />
                <span style={{fontSize:12,color:"#6b7280"}}>Remaining: {fmt(g.target-g.saved)}</span>
              </div>
            )}
            <button onClick={function(){deleteGoal(g.id);}} style={{background:"none",border:"none",color:"#d1d5db",cursor:"pointer",fontSize:11,marginTop:6}}>Remove</button>
          </div>
        );
      })}
    </div>
  );
}

// ─── Break-even Calculator ────────────────────────────────────────────────────
function BreakevenCalc() {
  var [costs, setCosts] = useState("");
  var [pricePerBag, setPricePerBag] = useState("");
  var [bags, setBags] = useState("");
  var totalRevenue = (+bags)*(+pricePerBag);
  var profit = totalRevenue - (+costs);
  var beenBags = pricePerBag > 0 ? Math.ceil((+costs)/(+pricePerBag)) : 0;
  return (
    <div style={{background:"#fff",border:"1px solid #e5e7eb",borderRadius:14,padding:"20px",marginBottom:20}}>
      <div style={{fontWeight:700,fontSize:15,marginBottom:4}}>🌽 Farming Break-Even Calculator</div>
      <div style={{fontSize:12,color:"#6b7280",marginBottom:16}}>Estimate profitability before the season</div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,marginBottom:14}}>
        {[{label:"Total Costs (MK)",val:costs,set:setCosts,ph:"e.g. 150000"},{label:"Price per Bag (MK)",val:pricePerBag,set:setPricePerBag,ph:"e.g. 35000"},{label:"Expected Bags",val:bags,set:setBags,ph:"e.g. 10"}].map(function(row){
          return <div key={row.label}><div style={{fontSize:12,fontWeight:600,marginBottom:5}}>{row.label}</div><input type="number" placeholder={row.ph} value={row.val} onChange={function(e){row.set(e.target.value);}} style={inp}/></div>;
        })}
      </div>
      {costs && pricePerBag && bags && (
        <div style={{background:profit>=0?"#f0fdf4":"#fef2f2",borderRadius:10,padding:"14px 16px",display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10}}>
          <div><div style={{fontSize:11,color:"#6b7280"}}>Total Revenue</div><div style={{fontWeight:700,fontSize:15}}>{fmt(totalRevenue)}</div></div>
          <div><div style={{fontSize:11,color:"#6b7280"}}>Break-even Bags</div><div style={{fontWeight:700,fontSize:15}}>{beenBags} bags</div></div>
          <div><div style={{fontSize:11,color:"#6b7280"}}>Profit / Loss</div><div style={{fontWeight:700,fontSize:15,color:profit>=0?"#16a34a":"#dc2626"}}>{fmt(profit)}</div></div>
        </div>
      )}
      <div style={{marginTop:14}}>
        <div style={{fontWeight:600,fontSize:13,marginBottom:8}}>📋 ADMARC Reference Prices</div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(140px,1fr))",gap:8}}>
          {ADMARC_PRICES.map(function(p){
            return <div key={p.crop} style={{background:"#f9fafb",border:"1px solid #e5e7eb",borderRadius:8,padding:"8px 12px"}}>
              <div style={{fontWeight:600,fontSize:13}}>{p.crop}</div>
              <div style={{fontSize:12,color:"#16a34a",fontWeight:700}}>{fmt(p.price)}</div>
              <div style={{fontSize:11,color:"#9ca3af"}}>per {p.unit}</div>
            </div>;
          })}
        </div>
      </div>
    </div>
  );
}

// ─── Interest Calculator ──────────────────────────────────────────────────────
function InterestCalc() {
  var [principal, setPrincipal] = useState("");
  var [rate, setRate] = useState(String(LOAN_INTEREST_RATE));
  var [months, setMonths] = useState("");
  var interest = (+principal)*(+rate/100)*(+months/12);
  var total = (+principal)+interest;
  var monthly = months>0 ? total/(+months) : 0;
  return (
    <div style={{background:"#fff",border:"1px solid #e5e7eb",borderRadius:14,padding:"20px",marginBottom:20}}>
      <div style={{fontWeight:700,fontSize:15,marginBottom:16}}>🧮 Clinic Hub Interest Calculator</div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,marginBottom:14}}>
        {[{label:"Principal (MK)",val:principal,set:setPrincipal,ph:"Loan amount"},{label:"Annual Rate (%)",val:rate,set:setRate,ph:"Default 35"},{label:"Duration (months)",val:months,set:setMonths,ph:"e.g. 12"}].map(function(row){
          return <div key={row.label}><div style={{fontSize:12,fontWeight:600,marginBottom:5}}>{row.label}</div><input type="number" placeholder={row.ph} value={row.val} onChange={function(e){row.set(e.target.value);}} style={inp}/></div>;
        })}
      </div>
      {principal && rate && months && (
        <div style={{background:"#f5f3ff",borderRadius:10,padding:"14px 16px",display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10}}>
          <div><div style={{fontSize:11,color:"#6b7280"}}>Interest</div><div style={{fontWeight:700,fontSize:15,color:"#7c3aed"}}>{fmt(interest)}</div></div>
          <div><div style={{fontSize:11,color:"#6b7280"}}>Total Repayable</div><div style={{fontWeight:700,fontSize:15}}>{fmt(total)}</div></div>
          <div><div style={{fontSize:11,color:"#6b7280"}}>Monthly Payment</div><div style={{fontWeight:700,fontSize:15}}>{fmt(monthly)}</div></div>
        </div>
      )}
    </div>
  );
}

// ─── Cash Flow Forecast ───────────────────────────────────────────────────────
function CashFlowForecast(props) {
  var txns = props.txns; var mod = props.mod;
  var accent = MODULE_META[mod].color;
  var byMonth = {};
  txns.forEach(function(t){ var m=t.date.slice(0,7); if(!byMonth[m]) byMonth[m]={in:0,out:0}; if(txIsIncome(mod,t)) byMonth[m].in+=t.amount; else byMonth[m].out+=t.amount; });
  var months3 = Object.keys(byMonth).sort();
  var last3 = months3.slice(-3);
  var avgIn  = last3.length ? last3.reduce(function(s,m){return s+byMonth[m].in;},0)/last3.length : 0;
  var avgOut = last3.length ? last3.reduce(function(s,m){return s+byMonth[m].out;},0)/last3.length : 0;
  var nextMonths = [1,2,3].map(function(i){
    var d = new Date(); d.setMonth(d.getMonth()+i);
    return d.toISOString().slice(0,7);
  });
  if (!last3.length) return null;
  return (
    <div style={{background:"#fff",border:"1px solid #e5e7eb",borderRadius:14,padding:"20px",marginBottom:20}}>
      <div style={{fontWeight:700,fontSize:15,marginBottom:4}}>📈 3-Month Cash Flow Forecast</div>
      <div style={{fontSize:12,color:"#6b7280",marginBottom:16}}>Based on your last {last3.length} month(s) average</div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10}}>
        {nextMonths.map(function(m){
          var net = avgIn - avgOut;
          return (
            <div key={m} style={{border:"1px solid #e5e7eb",borderRadius:10,padding:"12px 14px",background:"#fafafa"}}>
              <div style={{fontSize:12,fontWeight:600,marginBottom:8,color:accent}}>{monthLabel(m)}</div>
              <div style={{fontSize:12,color:"#16a34a"}}>In: {fmt(avgIn)}</div>
              <div style={{fontSize:12,color:"#dc2626"}}>Out: {fmt(avgOut)}</div>
              <div style={{fontSize:13,fontWeight:700,marginTop:6,color:net>=0?"#16a34a":"#dc2626"}}>Net: {fmt(net)}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Statement ────────────────────────────────────────────────────────────────
function Statement(props) {
  var txns = props.txns; var mod = props.mod;
  var accent = MODULE_META[mod].color;
  var [from, setFrom] = useState("");
  var [to, setTo] = useState("");
  var filtered = txns.filter(function(t){ return (!from||t.date>=from) && (!to||t.date<=to); });
  var byMonth = {};
  filtered.forEach(function(t){ var m=t.date.slice(0,7); if(!byMonth[m]) byMonth[m]=[]; byMonth[m].push(t); });
  var months4 = Object.keys(byMonth).sort().reverse();
  return (
    <div>
      <div style={{display:"flex",gap:10,marginBottom:16,flexWrap:"wrap"}}>
        <div style={{flex:1,minWidth:140}}><div style={{fontSize:12,fontWeight:600,marginBottom:4}}>From</div><input type="date" value={from} onChange={function(e){setFrom(e.target.value);}} style={inp}/></div>
        <div style={{flex:1,minWidth:140}}><div style={{fontSize:12,fontWeight:600,marginBottom:4}}>To</div><input type="date" value={to} onChange={function(e){setTo(e.target.value);}} style={inp}/></div>
        <div style={{display:"flex",alignItems:"flex-end"}}><button onClick={function(){setFrom("");setTo("");}} style={Object.assign({},btnBase,{padding:"9px 16px",background:"#f3f4f6",color:"#374151",fontSize:12})}>Clear</button></div>
      </div>
      {!months4.length && <div style={{textAlign:"center",padding:"40px 0",color:"#9ca3af"}}>No transactions in this range.</div>}
      {months4.map(function(m){
        var items = byMonth[m];
        var income2 = items.filter(function(t){return txIsIncome(mod,t);}).reduce(function(s,t){return s+t.amount;},0);
        var expense2 = items.filter(function(t){return !txIsIncome(mod,t);}).reduce(function(s,t){return s+t.amount;},0);
        return (
          <div key={m} style={{marginBottom:28}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",borderBottom:"2px solid "+accent,paddingBottom:8,marginBottom:12}}>
              <div style={{fontWeight:700,fontSize:15}}>{monthLabel(m)}</div>
              <div style={{fontSize:12,display:"flex",gap:14}}>
                <span style={{color:"#16a34a"}}>In: {fmt(income2)}</span>
                <span style={{color:"#dc2626"}}>Out: {fmt(expense2)}</span>
                <span style={{fontWeight:700,color:income2-expense2>=0?"#16a34a":"#dc2626"}}>Net: {fmt(income2-expense2)}</span>
              </div>
            </div>
            {items.slice().sort(function(a,b){return b.date.localeCompare(a.date);}).map(function(t){
              var inc=txIsIncome(mod,t);
              return (
                <div key={t.id} style={{display:"grid",gridTemplateColumns:"90px 1fr 100px 115px",gap:8,padding:"7px 0",borderBottom:"1px solid #f3f4f6",fontSize:13,alignItems:"center"}}>
                  <span style={{color:"#9ca3af"}}>{t.date}</span>
                  <span>{t.category}{t.note?" — "+t.note:""}{t.source==="sms"&&<span style={{fontSize:10,background:"#fef9c3",color:"#854d0e",borderRadius:3,padding:"1px 4px",marginLeft:4}}>SMS</span>}</span>
                  <span style={{color:"#6b7280",fontSize:11}}>{t.type}</span>
                  <span style={{textAlign:"right",fontWeight:600,color:inc?"#16a34a":"#dc2626"}}>{inc?"+":"-"}{fmt(t.amount)}</span>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

// ─── Insights ─────────────────────────────────────────────────────────────────
function InsightsPanel(props) {
  var mod = props.mod; var txns = props.txns;
  var accent = MODULE_META[mod].color;
  var [text, setText] = useState("");
  var [loading, setLoading] = useState(false);
  var run = useCallback(async function(){
    setLoading(true); setText("");
    var result = await fetchInsights(mod, txns);
    setText(result); setLoading(false);
  }, [mod, txns]);
  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
        <h3 style={{margin:0,fontSize:16,fontWeight:700}}>AI Financial Insights</h3>
        <button onClick={run} disabled={loading} style={Object.assign({},btnBase,{padding:"9px 18px",background:accent,color:"#fff",opacity:loading?0.7:1,fontSize:13})}>
          {loading?"Analysing…":"Get Insights ✦"}
        </button>
      </div>
      {!text&&!loading&&<div style={{background:"#f9fafb",border:"1px dashed #d1d5db",borderRadius:12,padding:"32px 24px",textAlign:"center",color:"#9ca3af"}}>Click "Get Insights" to receive AI-powered analysis.</div>}
      {loading&&<div style={{textAlign:"center",padding:"40px 0",color:accent}}><div style={{fontSize:28,marginBottom:8}}>✦</div><div style={{fontWeight:500}}>Analysing your transactions…</div></div>}
      {text&&<div style={{background:"#fafafa",border:"1px solid "+accent+"33",borderRadius:12,padding:"20px 22px",lineHeight:1.75,fontSize:14,color:"#1f2937",whiteSpace:"pre-wrap"}}>{text}</div>}
    </div>
  );
}

// ─── SMS Import Panel ─────────────────────────────────────────────────────────
function SmsImportPanel(props) {
  var [raw, setRaw] = useState("");
  var [parsed, setParsed] = useState([]);
  var [step, setStep] = useState("paste");
  var [doneCount, setDoneCount] = useState(0);

  function handleParse() {
    var results = parseSmsBlob(raw);
    if (!results.length) { alert("No Mwk transactions found. Ensure messages contain 'Mwk' followed by an amount."); return; }
    setParsed(results); setStep("review");
  }
  function update(id, field, val) { setParsed(function(p){ return p.map(function(r){ return r.id===id ? Object.assign({},r,{[field]:val}) : r; }); }); }
  function skip(id)   { update(id,"status","skipped"); }
  function unskip(id) { update(id,"status","pending"); }
  function handleImport() {
    var toImport = parsed.filter(function(r){ return r.status==="pending"; });
    toImport.forEach(function(r){ props.onImport({id:r.id,date:r.date,amount:r.amount,category:r.category,note:r.note,type:"Bank SMS",module:r.module,source:"sms",direction:r.direction,relation:r.relation}); });
    setDoneCount(toImport.length); setStep("done");
  }
  function reset() { setRaw(""); setParsed([]); setStep("paste"); }
  var pending = parsed.filter(function(r){ return r.status==="pending"; }).length;
  var skipped = parsed.filter(function(r){ return r.status==="skipped"; }).length;

  if (step==="paste") return (
    <div>
      <div style={{background:"linear-gradient(135deg,#1e3a5f,#2563eb)",borderRadius:16,padding:"20px 22px",color:"#fff",marginBottom:20}}>
        <div style={{fontSize:16,fontWeight:800,marginBottom:4}}>📲 Bank SMS Import</div>
        <div style={{fontSize:13,opacity:.85,lineHeight:1.6}}>Paste your bank SMS messages from <strong>626626</strong>. The app will find <strong>Mwk</strong>, dates, and CR/DR direction automatically.</div>
      </div>
      <textarea value={raw} onChange={function(e){setRaw(e.target.value);}} placeholder={"Paste SMS messages here...\n\nExample:\nFrom 626626\nYour account debited Mwk 12,500.00 for fuel. Date 24/05/2026"} style={Object.assign({},inp,{height:200,resize:"vertical",fontFamily:"monospace",fontSize:13,lineHeight:1.6})}/>
      <div style={{display:"flex",gap:10,marginTop:14}}>
        <button onClick={function(){setRaw("");}} style={Object.assign({},btnBase,{flex:1,background:"#f3f4f6",color:"#374151"})}>Clear</button>
        <button onClick={handleParse} disabled={!raw.trim()} style={Object.assign({},btnBase,{flex:3,background:raw.trim()?"#2563eb":"#93c5fd",color:"#fff"})}>Parse Messages →</button>
      </div>
    </div>
  );

  if (step==="review") return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
        <div><div style={{fontWeight:700,fontSize:16}}>Review Transactions</div><div style={{fontSize:13,color:"#6b7280",marginTop:2}}>{parsed.length} found · <span style={{color:"#16a34a"}}>{pending} to import</span>{skipped>0&&<span style={{color:"#9ca3af"}}> · {skipped} skipped</span>}</div></div>
        <button onClick={reset} style={Object.assign({},btnBase,{padding:"8px 14px",background:"#f3f4f6",color:"#374151",fontSize:12})}>← Back</button>
      </div>
      <div style={{maxHeight:480,overflowY:"auto"}}>
        {parsed.map(function(r){
          var skp = r.status==="skipped";
          return (
            <div key={r.id} style={{border:"1px solid "+(skp?"#e5e7eb":r.direction==="credit"?"#bbf7d0":"#fecaca"),borderRadius:12,padding:"14px 16px",marginBottom:10,background:skp?"#f9fafb":r.direction==="credit"?"#f0fdf4":"#fef2f2",opacity:skp?0.55:1}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}>
                <div><span style={{fontWeight:700,fontSize:15,color:r.direction==="credit"?"#16a34a":"#dc2626"}}>{r.direction==="credit"?"CR +":"DR -"}{fmt(r.amount)}</span><span style={{fontSize:11,color:"#9ca3af",marginLeft:8}}>{r.date}</span>{r.relation&&r.relation!=="personal"&&<Badge color="#2563eb">{r.relation.replace(/-/g," ")}</Badge>}</div>
                <button onClick={function(){skp?unskip(r.id):skip(r.id);}} style={{fontSize:11,padding:"3px 10px",border:"1px solid #d1d5db",borderRadius:6,background:"#fff",cursor:"pointer"}}>{skp?"+ Include":"Skip"}</button>
              </div>
              {!skp && (
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                  <div><div style={{fontSize:11,fontWeight:600,marginBottom:4}}>Module</div><select value={r.module} onChange={function(e){update(r.id,"module",e.target.value);}} style={Object.assign({},inp,{padding:"6px 10px",fontSize:13})}>{MODULES.map(function(m){return <option key={m} value={m}>{MODULE_META[m].label}</option>;})}</select></div>
                  <div><div style={{fontSize:11,fontWeight:600,marginBottom:4}}>Category</div><select value={r.category} onChange={function(e){update(r.id,"category",e.target.value);}} style={Object.assign({},inp,{padding:"6px 10px",fontSize:13})}>{cats(r.module).map(function(c){return <option key={c}>{c}</option>;})}</select></div>
                  <div><div style={{fontSize:11,fontWeight:600,marginBottom:4}}>Date</div><input type="date" value={r.date} onChange={function(e){update(r.id,"date",e.target.value);}} style={Object.assign({},inp,{padding:"6px 10px",fontSize:13})}/></div>
                  <div><div style={{fontSize:11,fontWeight:600,marginBottom:4}}>Note</div><input value={r.note} onChange={function(e){update(r.id,"note",e.target.value);}} placeholder="Edit note..." style={Object.assign({},inp,{padding:"6px 10px",fontSize:13})}/></div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div style={{display:"flex",gap:10,marginTop:16}}>
        <button onClick={reset} style={Object.assign({},btnBase,{flex:1,background:"#f3f4f6",color:"#374151"})}>Cancel</button>
        <button onClick={handleImport} disabled={pending===0} style={Object.assign({},btnBase,{flex:3,background:pending>0?"#16a34a":"#9ca3af",color:"#fff"})}>Import {pending} Transaction{pending!==1?"s":""} ✓</button>
      </div>
    </div>
  );

  return (
    <div style={{textAlign:"center",padding:"40px 20px"}}>
      <div style={{fontSize:48,marginBottom:12}}>✅</div>
      <div style={{fontWeight:700,fontSize:18,marginBottom:6}}>{doneCount} transaction{doneCount!==1?"s":""} imported!</div>
      <button onClick={reset} style={Object.assign({},btnBase,{padding:"11px 32px",background:"#2563eb",color:"#fff"})}>Import More</button>
    </div>
  );
}

// ─── Loan Tracker ─────────────────────────────────────────────────────────────
function LoanTracker(props) {
  var loans = props.loans;
  var [showForm, setShowForm] = useState(false);
  var [form, setForm] = useState({borrower:"",amount:"",date:today(),due:"",interestRate:String(LOAN_INTEREST_RATE),applicationFee:String(LOAN_APPLICATION_FEE),note:""});
  var [repayForm, setRepayForm] = useState({});
  function setF(k){ return function(e){ setForm(function(f){ var n=Object.assign({},f); n[k]=e.target.value; return n; }); }; }
  var totalOutstanding = loans.reduce(function(s,l){ return s+loanTotals(l).outstanding; },0);
  return (
    <div style={{background:"#fff",border:"1px solid #e5e7eb",borderRadius:14,padding:"20px",marginTop:20}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
        <h3 style={{margin:0,fontSize:16,fontWeight:700}}>🏥 Loan Register</h3>
        <button onClick={function(){setShowForm(function(s){return !s;});}} style={Object.assign({},btnBase,{padding:"8px 16px",background:"#7c3aed",color:"#fff",fontSize:13})}>+ New Loan</button>
      </div>
      <div style={{fontSize:12,color:"#6b7280",marginBottom:16}}>Default terms: 35% interest, MK 15,000 application fee, delay penalties from MK 15,000 to MK 40,000 per month. Total outstanding: <strong style={{color:"#dc2626"}}>{fmt(totalOutstanding)}</strong></div>
      {showForm && (
        <div style={{background:"#f5f3ff",borderRadius:12,padding:16,marginBottom:16}}>
          {[{label:"Borrower Name",k:"borrower",type:"text",ph:"Full name"},{label:"Amount (MK)",k:"amount",type:"number",ph:"0.00"},{label:"Issue Date",k:"date",type:"date"},{label:"Due Date",k:"due",type:"date"},{label:"Interest Rate (%)",k:"interestRate",type:"number",ph:"35"},{label:"Application Fee (MK)",k:"applicationFee",type:"number",ph:"15000"},{label:"Note",k:"note",type:"text",ph:"Purpose"}].map(function(row){
            return <div key={row.k} style={{marginBottom:10}}><div style={{fontSize:12,fontWeight:600,marginBottom:4}}>{row.label}</div><input type={row.type} placeholder={row.ph} value={form[row.k]} onChange={setF(row.k)} style={inp}/></div>;
          })}
          <div style={{display:"flex",gap:8}}><button onClick={function(){setShowForm(false);}} style={Object.assign({},btnBase,{flex:1,background:"#e5e7eb",color:"#374151",padding:"9px 0"})}>Cancel</button><button onClick={function(){if(!form.borrower||!form.amount)return;props.onAddLoan(Object.assign({},form,{id:uid(),amount:+form.amount,interestRate:+form.interestRate||LOAN_INTEREST_RATE,applicationFee:+form.applicationFee||LOAN_APPLICATION_FEE,repayments:[],status:"active"}));setForm({borrower:"",amount:"",date:today(),due:"",interestRate:String(LOAN_INTEREST_RATE),applicationFee:String(LOAN_APPLICATION_FEE),note:""});setShowForm(false);}} style={Object.assign({},btnBase,{flex:2,background:"#7c3aed",color:"#fff",padding:"9px 0"})}>Issue Loan</button></div>
        </div>
      )}
      {loans.length===0 && <div style={{color:"#9ca3af",textAlign:"center",padding:"24px 0"}}>No loans recorded</div>}
      {loans.map(function(loan){
        var totals=loanTotals(loan);
        var paid=totals.paid;
        var outstanding=totals.outstanding;
        var pct=totals.totalDue>0?Math.min(100,Math.round((paid/totals.totalDue)*100)):0;
        var overdue = totals.lateDays > 0 && outstanding > 0;
        return (
          <div key={loan.id} style={{border:"1px solid "+(outstanding<=0?"#bbf7d0":overdue?"#fecaca":"#ddd6fe"),borderRadius:12,padding:"14px 16px",marginBottom:12,background:outstanding<=0?"#f0fdf4":overdue?"#fef2f2":"#faf5ff"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8}}>
              <div>
                <div style={{fontWeight:700,fontSize:15}}>{loan.borrower}</div>
                <div style={{fontSize:12,color:"#6b7280"}}>Issued: {loan.date}{loan.due?" · Due: "+loan.due:""}</div>
                {loan.note&&<div style={{fontSize:12,color:"#7c3aed",marginTop:2}}>{loan.note}</div>}
                {overdue&&<div style={{fontSize:11,color:"#dc2626",marginTop:2}}>⚠ OVERDUE</div>}
              </div>
              <div style={{textAlign:"right"}}><div style={{fontWeight:700,color:"#7c3aed"}}>{fmt(totals.totalDue)}</div><Badge color={outstanding<=0?"#16a34a":overdue?"#dc2626":"#7c3aed"}>{outstanding<=0?"Settled":overdue?"Overdue: "+fmt(outstanding):"Outstanding: "+fmt(outstanding)}</Badge></div>
            </div>
            <div style={{height:6,background:"#e5e7eb",borderRadius:99,marginBottom:10}}><div style={{height:6,width:pct+"%",background:pct>=100?"#16a34a":"#7c3aed",borderRadius:99}}/></div>
            <div style={{fontSize:12,color:"#6b7280",marginBottom:8}}>Principal: {fmt(totals.principal)} · Interest: {fmt(totals.interest)} · Application: {fmt(totals.appFee)}{totals.penalty>0?" · Penalty: "+fmt(totals.penalty):""}</div>
            <div style={{fontSize:12,color:"#6b7280",marginBottom:8}}>Repaid: {fmt(paid)} ({pct}%) · {(loan.repayments||[]).length} payment(s)</div>
            {(loan.repayments||[]).map(function(r){ return <div key={r.id} style={{fontSize:12,color:"#374151",padding:"3px 8px",background:"rgba(255,255,255,.7)",borderRadius:6,marginBottom:4}}>{r.date} — {fmt(r.amount)}{r.note?" ("+r.note+")":""}</div>; })}
            {outstanding>0&&(
              <div style={{display:"flex",gap:6,marginTop:8}}>
                <input type="number" placeholder="Amount" value={(repayForm[loan.id]&&repayForm[loan.id].amt)||""} onChange={function(e){setRepayForm(function(f){ var n=Object.assign({},f); n[loan.id]=Object.assign({},f[loan.id]||{},{amt:e.target.value}); return n; });}} style={Object.assign({},inp,{flex:1,padding:"7px 10px"})}/>
                <input type="text" placeholder="Note" value={(repayForm[loan.id]&&repayForm[loan.id].note)||""} onChange={function(e){setRepayForm(function(f){ var n=Object.assign({},f); n[loan.id]=Object.assign({},f[loan.id]||{},{note:e.target.value}); return n; });}} style={Object.assign({},inp,{flex:2,padding:"7px 10px"})}/>
                <button onClick={function(){var rf=repayForm[loan.id]||{};if(!rf.amt)return;props.onAddRepayment(loan.id,{id:uid(),amount:+rf.amt,date:today(),note:rf.note||""});setRepayForm(function(f){var n=Object.assign({},f);n[loan.id]={};return n;});}} style={Object.assign({},btnBase,{padding:"7px 14px",background:"#7c3aed",color:"#fff",fontSize:12})}>Record</button>
              </div>
            )}
            <button onClick={function(){props.onDeleteLoan(loan.id);}} style={{background:"none",border:"none",color:"#d1d5db",cursor:"pointer",fontSize:11,marginTop:6}}>Remove loan</button>
          </div>
        );
      })}
    </div>
  );
}

// ─── Sign In ──────────────────────────────────────────────────────────────────
function AuthScreen(props) {
  var [mode, setMode] = useState(Object.keys(loadUsers()).length ? "login" : "signup");
  var [form, setForm] = useState({name:"",username:"",password:"",confirm:""});
  var [error, setError] = useState("");
  function setF(k){ return function(e){ setForm(function(f){ var n=Object.assign({},f); n[k]=e.target.value; return n; }); setError(""); }; }
  function submit() {
    var username = form.username.trim().toLowerCase();
    var users = loadUsers();
    if (!username || !form.password) { setError("Enter username and password."); return; }
    if (mode === "signup") {
      if (form.password.length < 6) { setError("Use at least 6 characters for the password."); return; }
      if (form.password !== form.confirm) { setError("Passwords do not match."); return; }
      if (users[username]) { setError("This username already exists. Log in instead."); return; }
      var salt = uid();
      users[username] = { name:form.name.trim()||username, username:username, salt:salt, passwordHash:hashPassword(form.password,salt), createdAt:new Date().toISOString() };
      saveUsers(users);
      var legacy = loadLegacyDb();
      saveDb(username, Object.keys(users).length === 1 && legacy.personal ? normalizeDb(legacy) : emptyDb());
      props.onAuth(username);
    } else {
      var user = users[username];
      if (!user || user.passwordHash !== hashPassword(form.password,user.salt)) { setError("Wrong username or password."); return; }
      props.onAuth(username);
    }
  }
  return (
    <div style={{minHeight:"100vh",background:"#0f172a",display:"flex",alignItems:"center",justifyContent:"center",padding:"24px 16px",fontFamily:"'DM Sans','Nunito',system-ui,sans-serif"}}>
      <div style={{background:"#fff",borderRadius:18,padding:"28px 24px",width:"min(94vw,420px)",boxShadow:"0 24px 80px rgba(0,0,0,.25)"}}>
        <div style={{fontSize:34,marginBottom:8}}>🔐</div>
        <div style={{fontWeight:800,fontSize:22,marginBottom:4}}>FinTrack Pro</div>
        <div style={{fontSize:13,color:"#64748b",lineHeight:1.55,marginBottom:22}}>Create credentials to protect this device's finance records. Your dashboard opens only after login.</div>
        <div style={{display:"flex",background:"#f1f5f9",borderRadius:12,padding:4,marginBottom:18}}>
          {["login","signup"].map(function(m){ return <button key={m} onClick={function(){setMode(m);setError("");}} style={{flex:1,border:"none",borderRadius:9,padding:"9px 0",fontWeight:700,cursor:"pointer",background:mode===m?"#fff":"transparent",color:mode===m?"#0f172a":"#64748b",boxShadow:mode===m?"0 1px 4px rgba(0,0,0,.08)":"none"}}>{m==="login"?"Log In":"Sign Up"}</button>; })}
        </div>
        {mode==="signup"&&<div style={{marginBottom:12}}><div style={{fontSize:12,fontWeight:700,marginBottom:5}}>Full Name</div><input value={form.name} onChange={setF("name")} placeholder="Your name" style={inp}/></div>}
        <div style={{marginBottom:12}}><div style={{fontSize:12,fontWeight:700,marginBottom:5}}>Username</div><input value={form.username} onChange={setF("username")} placeholder="e.g. businessclinic" autoCapitalize="none" style={inp}/></div>
        <div style={{marginBottom:12}}><div style={{fontSize:12,fontWeight:700,marginBottom:5}}>Password</div><input type="password" value={form.password} onChange={setF("password")} placeholder="Password" style={inp}/></div>
        {mode==="signup"&&<div style={{marginBottom:12}}><div style={{fontSize:12,fontWeight:700,marginBottom:5}}>Confirm Password</div><input type="password" value={form.confirm} onChange={setF("confirm")} placeholder="Repeat password" style={inp}/></div>}
        {error&&<div style={{background:"#fef2f2",border:"1px solid #fecaca",color:"#991b1b",borderRadius:10,padding:"9px 11px",fontSize:12,marginBottom:12}}>{error}</div>}
        <button onClick={submit} style={Object.assign({},btnBase,{width:"100%",background:"#2563eb",color:"#fff"})}>{mode==="login"?"Log In":"Create Account"}</button>
        <div style={{fontSize:11,color:"#94a3b8",lineHeight:1.5,marginTop:14}}>Note: this protects access inside the app on this phone/browser. Keep the phone screen lock on for stronger protection.</div>
      </div>
    </div>
  );
}

// ─── Onboarding ───────────────────────────────────────────────────────────────
function Onboarding(props) {
  var steps = [
    {icon:"💰",title:"Welcome to FinTrack Pro",body:"Your complete financial toolkit for personal finances, farming, and clinic hub management — built for Malawi."},
    {icon:"📲",title:"Import from SMS",body:"Paste your bank messages from 626626 and we'll automatically extract all your transactions."},
    {icon:"📊",title:"Track & Budget",body:"Set monthly budget targets, track savings goals, and get AI-powered insights on your spending."},
    {icon:"🌾",title:"Farming & Clinic Tools",body:"Use the break-even calculator for farming seasons and the loan register for your Clinic Hub lending."},
  ];
  var [step, setStep] = useState(0);
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(15,23,42,.92)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1500}}>
      <div style={{background:"#fff",borderRadius:20,padding:"36px 32px",width:"min(95vw,420px)",textAlign:"center"}}>
        <div style={{fontSize:56,marginBottom:12}}>{steps[step].icon}</div>
        <div style={{fontWeight:800,fontSize:20,marginBottom:10}}>{steps[step].title}</div>
        <div style={{color:"#6b7280",lineHeight:1.7,marginBottom:28,fontSize:15}}>{steps[step].body}</div>
        <div style={{display:"flex",gap:6,justifyContent:"center",marginBottom:24}}>
          {steps.map(function(_,i){ return <div key={i} style={{width:8,height:8,borderRadius:99,background:i===step?"#2563eb":"#e5e7eb",transition:"background .2s"}}/>; })}
        </div>
        <div style={{display:"flex",gap:10}}>
          {step>0&&<button onClick={function(){setStep(function(s){return s-1;});}} style={Object.assign({},btnBase,{flex:1,background:"#f3f4f6",color:"#374151"})}>Back</button>}
          <button onClick={function(){ if(step<steps.length-1) setStep(function(s){return s+1;}); else props.onDone(); }} style={Object.assign({},btnBase,{flex:2,background:"#2563eb",color:"#fff"})}>{step===steps.length-1?"Get Started →":"Next"}</button>
        </div>
      </div>
    </div>
  );
}

// ─── Module Page ──────────────────────────────────────────────────────────────
function ModulePage(props) {
  var mod = props.mod; var txns = props.txns;
  var meta = MODULE_META[mod]; var accent = meta.color;
  var [tab, setTab] = useState("dashboard");
  var [showAdd, setShowAdd] = useState(false);
  var [filter, setFilter] = useState("");
  var filtered = txns.filter(function(t){ return !filter||t.category.toLowerCase().includes(filter.toLowerCase())||(t.note||"").toLowerCase().includes(filter.toLowerCase()); });
  var income  = txns.filter(function(t){return txIsIncome(mod,t);}).reduce(function(s,t){return s+t.amount;},0);
  var expense = txns.filter(function(t){return !txIsIncome(mod,t);}).reduce(function(s,t){return s+t.amount;},0);
  var net = income-expense;
  var catTotals = {};
  txns.forEach(function(t){catTotals[t.category]=(catTotals[t.category]||0)+t.amount;});
  var topCats = Object.entries(catTotals).sort(function(a,b){return b[1]-a[1];}).slice(0,5);
  var smsTxns = txns.filter(function(t){return t.source==="sms";}).length;
  var tabs = ["dashboard","transactions","statement","insights"];
  if (mod==="personal") tabs = ["dashboard","budget","goals","transactions","statement","insights"];
  if (mod==="farming")  tabs = ["dashboard","budget","breakeven","transactions","statement","insights"];
  if (mod==="clinic")   tabs = ["dashboard","budget","transactions","statement","insights"];

  return (
    <div>
      <div style={{background:"linear-gradient(135deg,"+accent+","+accent+"cc)",borderRadius:16,padding:"22px 24px",marginBottom:20,color:"#fff"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
          <div>
            <div style={{fontSize:13,opacity:.8,marginBottom:4}}>{meta.icon} {meta.label}</div>
            <div style={{fontSize:28,fontWeight:800}}>{fmt(net)}</div>
            <div style={{fontSize:12,opacity:.7,marginTop:2}}>{txns.length} transactions{smsTxns>0?" · "+smsTxns+" from SMS":""}</div>
          </div>
          <button onClick={function(){setShowAdd(true);}} style={{background:"rgba(255,255,255,.25)",border:"1px solid rgba(255,255,255,.4)",color:"#fff",borderRadius:10,padding:"9px 18px",fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:"inherit"}}>+ Add</button>
        </div>
        <div style={{display:"flex",gap:16,marginTop:18}}>
          <div><div style={{fontSize:11,opacity:.7}}>Total In</div><div style={{fontWeight:700}}>{fmt(income)}</div></div>
          <div style={{borderLeft:"1px solid rgba(255,255,255,.3)",paddingLeft:16}}><div style={{fontSize:11,opacity:.7}}>Total Out</div><div style={{fontWeight:700}}>{fmt(expense)}</div></div>
        </div>
      </div>
      <div style={{display:"flex",gap:0,marginBottom:20,background:"#f3f4f6",borderRadius:12,padding:4,overflowX:"auto"}}>
        {tabs.map(function(t){ return <button key={t} onClick={function(){setTab(t);}} style={{flex:1,padding:"8px 0",border:"none",borderRadius:9,cursor:"pointer",fontFamily:"inherit",fontWeight:600,fontSize:11,background:tab===t?"#fff":"transparent",color:tab===t?accent:"#6b7280",whiteSpace:"nowrap",minWidth:60,boxShadow:tab===t?"0 1px 4px rgba(0,0,0,.08)":"none"}}>{t.charAt(0).toUpperCase()+t.slice(1)}</button>; })}
      </div>

      {tab==="dashboard"&&(
        <div>
          <CashFlowForecast txns={txns} mod={mod}/>
          <div style={{display:"flex",gap:10,flexWrap:"wrap",marginBottom:20}}>
            <StatCard label="Income / Inflows" value={fmt(income)} accent="#16a34a"/>
            <StatCard label="Expenses / Outflows" value={fmt(expense)} accent="#dc2626"/>
            <StatCard label="Net Balance" value={fmt(net)} accent={net>=0?"#16a34a":"#dc2626"} sub={net>=0?"Surplus":"Deficit"}/>
          </div>
          {topCats.length>0&&(
            <div style={{background:"#fff",border:"1px solid #e5e7eb",borderRadius:14,padding:"18px 20px",marginBottom:20}}>
              <div style={{fontWeight:700,fontSize:14,marginBottom:14}}>Top Categories</div>
              {topCats.map(function(entry){ var cat=entry[0]; var amt=entry[1]; var pct=Math.round((amt/((income+expense)||1))*100);
                return <div key={cat} style={{marginBottom:10}}><div style={{display:"flex",justifyContent:"space-between",fontSize:13,marginBottom:4}}><span>{cat}</span><span style={{fontWeight:600}}>{fmt(amt)}</span></div><div style={{height:6,background:"#f3f4f6",borderRadius:99}}><div style={{height:6,width:pct+"%",background:accent,borderRadius:99}}/></div></div>;
              })}
            </div>
          )}
          <div style={{background:"#fff",border:"1px solid #e5e7eb",borderRadius:14,padding:"18px 20px"}}>
            <div style={{fontWeight:700,fontSize:14,marginBottom:12}}>Recent Transactions</div>
            {txns.slice(-5).reverse().map(function(t){return <TxRow key={t.id} tx={t} mod={mod} onDelete={props.onDelete}/>;} )}
            {txns.length===0&&<div style={{color:"#9ca3af",textAlign:"center",padding:"20px 0"}}>No transactions yet</div>}
          </div>
        </div>
      )}
      {tab==="budget"&&<BudgetPanel mod={mod} txns={txns} budgets={props.budgets||{}} onUpdate={props.onBudgetUpdate}/>}
      {tab==="goals"&&<SavingsGoals goals={props.goals||[]} onUpdate={props.onGoalsUpdate}/>}
      {tab==="breakeven"&&<BreakevenCalc/>}
      {tab==="transactions"&&(
        <div>
          <input placeholder="Filter by category or note…" value={filter} onChange={function(e){setFilter(e.target.value);}} style={Object.assign({},inp,{marginBottom:14,background:"#fff"})}/>
          {filtered.slice().reverse().map(function(t){return <TxRow key={t.id} tx={t} mod={mod} onDelete={props.onDelete}/>;} )}
          {filtered.length===0&&<div style={{color:"#9ca3af",textAlign:"center",padding:"30px 0"}}>No results</div>}
        </div>
      )}
      {tab==="statement"&&(
        <div style={{background:"#fff",border:"1px solid #e5e7eb",borderRadius:14,padding:"20px"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
            <h3 style={{margin:0,fontSize:16,fontWeight:700}}>{meta.label} Statement</h3>
            <button onClick={function(){window.print();}} style={Object.assign({},btnBase,{padding:"8px 16px",background:"#f3f4f6",color:"#374151",fontSize:12})}>Print 🖨</button>
          </div>
          <Statement txns={txns} mod={mod}/>
        </div>
      )}
      {tab==="insights"&&(
        <div style={{background:"#fff",border:"1px solid #e5e7eb",borderRadius:14,padding:"20px"}}>
          <InsightsPanel mod={mod} txns={txns}/>
        </div>
      )}
      {showAdd&&<AddTxModal mod={mod} onSave={props.onAdd} onClose={function(){setShowAdd(false);}}/>}
    </div>
  );
}

// ─── Root App ─────────────────────────────────────────────────────────────────
function UnifiedBusinessDashboard(props) {
  var db = props.db;
  var farmIn = db.farming.filter(function(t){return txIsIncome("farming",t);}).reduce(function(s,t){return s+t.amount;},0);
  var farmOut = db.farming.filter(function(t){return !txIsIncome("farming",t);}).reduce(function(s,t){return s+t.amount;},0);
  var clinicIn = db.clinic.filter(function(t){return txIsIncome("clinic",t);}).reduce(function(s,t){return s+t.amount;},0);
  var clinicOut = db.clinic.filter(function(t){return !txIsIncome("clinic",t);}).reduce(function(s,t){return s+t.amount;},0);
  var produceStock = db.farming.filter(function(t){return t.category==="Produce Stock Purchase";}).reduce(function(s,t){return s+t.amount;},0);
  var rainySeason = db.farming.filter(function(t){return t.category==="Rainy Season Farming" || ["Seeds","Fertiliser","Labour","Pesticides","Harvest"].includes(t.category);}).reduce(function(s,t){return s+t.amount;},0);
  var farmFinance = db.farming.filter(function(t){return t.category==="BCH Farm Finance";}).reduce(function(s,t){return s+t.amount;},0);
  var loanBook = db.loans.reduce(function(s,l){return s+loanTotals(l).outstanding;},0);
  var expectedInterest = db.loans.reduce(function(s,l){return s+loanTotals(l).interest;},0);
  var penaltiesDue = db.loans.reduce(function(s,l){return s+loanTotals(l).penalty;},0);
  var allTxns = ["farming","clinic"].reduce(function(a,m){ return a.concat(db[m].map(function(t){return Object.assign({moduleName:m},t);})); },[]).sort(function(a,b){ return b.date.localeCompare(a.date); });
  return (
    <div>
      <div style={{background:"linear-gradient(135deg,#14532d,#7c3aed)",borderRadius:16,padding:"22px 24px",marginBottom:20,color:"#fff"}}>
        <div style={{fontSize:13,opacity:.8,marginBottom:4}}>Unified Business Dashboard</div>
        <div style={{fontSize:25,fontWeight:800}}>Farm Produce + Rainy Season Farm + Clinic Hub</div>
        <div style={{fontSize:12,opacity:.78,marginTop:6,lineHeight:1.6}}>Tracks related transactions in one place: produce bought for resale, rainy-season farming, no-interest financing from Business Clinic Hub, and 35% interest lending.</div>
      </div>
      <div style={{display:"flex",gap:10,flexWrap:"wrap",marginBottom:20}}>
        <StatCard label="Farming Net" value={fmt(farmIn-farmOut)} accent={farmIn-farmOut>=0?"#16a34a":"#dc2626"} sub={"In "+fmt(farmIn)+" / Out "+fmt(farmOut)}/>
        <StatCard label="Clinic Hub Net" value={fmt(clinicIn-clinicOut)} accent={clinicIn-clinicOut>=0?"#16a34a":"#dc2626"} sub={"In "+fmt(clinicIn)+" / Out "+fmt(clinicOut)}/>
        <StatCard label="Loan Book Outstanding" value={fmt(loanBook)} accent="#7c3aed" sub={db.loans.length+" active record(s)"}/>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))",gap:10,marginBottom:20}}>
        <StatCard label="Produce Stock Bought" value={fmt(produceStock)} accent="#ca8a04" sub="Maize, groundnuts and other produce"/>
        <StatCard label="Rainy Season Farming" value={fmt(rainySeason)} accent="#16a34a" sub="Inputs, labour and harvest costs"/>
        <StatCard label="BCH Farm Finance" value={fmt(farmFinance)} accent="#2563eb" sub="No-interest farm business funding"/>
        <StatCard label="Expected Loan Interest" value={fmt(expectedInterest)} accent="#7c3aed" sub="35% default lending rate"/>
        <StatCard label="Penalties Due" value={fmt(penaltiesDue)} accent="#dc2626" sub="Based on current overdue days"/>
      </div>
      <div style={{background:"#fff",border:"1px solid #e5e7eb",borderRadius:14,padding:"18px 20px",marginBottom:20}}>
        <div style={{fontWeight:700,fontSize:14,marginBottom:12}}>Business Rules</div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(220px,1fr))",gap:10,fontSize:13,color:"#374151",lineHeight:1.55}}>
          <div>Clinic Hub financing to the farm produce business is tracked as related internal funding with no interest.</div>
          <div>Customer borrowing through Clinic Hub uses 35% interest plus MK 15,000 application fee.</div>
          <div>Delay penalties: 1-5 days MK 15,000, 6-10 MK 20,000, 11-15 MK 25,000, 16-20 MK 30,000, 21-25 MK 35,000, then MK 40,000 per month.</div>
        </div>
      </div>
      <div style={{background:"#fff",border:"1px solid #e5e7eb",borderRadius:14,padding:"18px 20px"}}>
        <div style={{fontWeight:700,fontSize:14,marginBottom:12}}>Recent Related Transactions</div>
        {allTxns.slice(0,8).map(function(t){ var meta=MODULE_META[t.moduleName]; return <div key={t.id} style={{display:"flex",gap:10,alignItems:"center",padding:"8px 0",borderBottom:"1px solid #f3f4f6",fontSize:13}}><Badge color={meta.color}>{meta.label}</Badge><div style={{flex:1}}>{t.date} · {t.category}{t.note?" — "+t.note:""}</div><div style={{fontWeight:700,color:txIsIncome(t.moduleName,t)?"#16a34a":"#dc2626"}}>{txIsIncome(t.moduleName,t)?"+":"-"}{fmt(t.amount)}</div></div>; })}
        {!allTxns.length&&<div style={{color:"#9ca3af",textAlign:"center",padding:"20px 0"}}>No business transactions yet</div>}
      </div>
    </div>
  );
}

export default function App() {
  var [authUser, setAuthUser] = useState(function(){
    var session = loadSession();
    return loadUsers()[session] ? session : "";
  });
  var [activeModule, setActiveModule] = useState("overview");
  var [dark, setDark] = useState(false);
  var [showOnboard, setShowOnboard] = useState(false);
  var [db, setDb] = useState(function(){
    var session = loadSession();
    var raw = loadUsers()[session] ? loadDb(session) : emptyDb();
    if (!raw.personal) { setShowOnboard(true); }
    return raw;
  });

  useEffect(function(){ if(authUser) saveDb(authUser, db); },[authUser, db]);

  function handleAuth(username) {
    saveSession(username);
    setAuthUser(username);
    var nextDb = loadDb(username);
    if (!nextDb.personal.length && !nextDb.farming.length && !nextDb.clinic.length && !nextDb.loans.length) setShowOnboard(true);
    setDb(nextDb);
    setActiveModule("overview");
  }
  function logout() {
    clearSession();
    setAuthUser("");
    setDb(emptyDb());
    setActiveModule("overview");
  }

  function addTx(tx)         { setDb(function(d){ var n=Object.assign({},d); n[tx.module]=d[tx.module].concat([tx]); return n; }); }
  function delTx(mod,id)     { setDb(function(d){ var n=Object.assign({},d); n[mod]=d[mod].filter(function(t){return t.id!==id;}); return n; }); }
  function addLoan(loan)     { setDb(function(d){ return Object.assign({},d,{loans:d.loans.concat([loan])}); }); }
  function delLoan(id)       { setDb(function(d){ return Object.assign({},d,{loans:d.loans.filter(function(l){return l.id!==id;})}); }); }
  function addRepay(lid,rep) { setDb(function(d){ return Object.assign({},d,{loans:d.loans.map(function(l){ return l.id===lid?Object.assign({},l,{repayments:(l.repayments||[]).concat([rep])}):l; })}); }); }
  function updateBudgets(mod,b){ setDb(function(d){ var nb=Object.assign({},d.budgets); nb[mod]=b; return Object.assign({},d,{budgets:nb}); }); }
  function updateGoals(g)    { setDb(function(d){ return Object.assign({},d,{goals:g}); }); }

  var grandTotal = MODULES.reduce(function(s,m){
    var inc=db[m].filter(function(t){return txIsIncome(m,t);}).reduce(function(a,t){return a+t.amount;},0);
    var exp=db[m].filter(function(t){return !txIsIncome(m,t);}).reduce(function(a,t){return a+t.amount;},0);
    return s+(inc-exp);
  },0);
  var totalTxns = MODULES.reduce(function(s,m){return s+db[m].length;},0);
  var navItems = [
    {id:"overview",label:"Dashboard",icon:"📊"},
    {id:"sms",label:"SMS Import",icon:"📲"},
    {id:"personal",label:"Personal",icon:"👤"},
    {id:"farming",label:"Farming",icon:"🌾"},
    {id:"clinic",label:"Clinic Hub",icon:"🏥"},
  ];

  var bg = dark?"#0f172a":"#f8fafc";
  var cardBg = dark?"#1e293b":"#fff";
  var textColor = dark?"#f1f5f9":"#111";

  if (!authUser) return <AuthScreen onAuth={handleAuth}/>;

  return (
    <div style={{fontFamily:"'DM Sans','Nunito',system-ui,sans-serif",background:bg,minHeight:"100vh",paddingBottom:40,color:textColor,transition:"background .3s"}}>
      {showOnboard && <Onboarding onDone={function(){setShowOnboard(false);}}/>}
      <div style={{background:dark?"#020617":"#0f172a",color:"#fff",padding:"14px 20px",display:"flex",justifyContent:"space-between",alignItems:"center",position:"sticky",top:0,zIndex:100}}>
        <div>
          <div style={{fontWeight:800,fontSize:17,letterSpacing:-.3}}>FinTrack Pro</div>
          <div style={{fontSize:11,color:"#94a3b8",marginTop:1}}>{authUser} · {totalTxns} transactions</div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:12}}>
          <div style={{textAlign:"right"}}>
            <div style={{fontSize:11,color:"#94a3b8"}}>Overall Net</div>
            <div style={{fontWeight:700,fontSize:16,color:grandTotal>=0?"#4ade80":"#f87171"}}>{fmt(grandTotal)}</div>
          </div>
          <button onClick={function(){setDark(function(d){return !d;});}} title="Toggle dark mode" style={{background:"rgba(255,255,255,.1)",border:"none",borderRadius:8,padding:"6px 10px",cursor:"pointer",color:"#fff",fontSize:16}}>{dark?"☀️":"🌙"}</button>
          <button onClick={logout} title="Log out" style={{background:"rgba(255,255,255,.1)",border:"none",borderRadius:8,padding:"6px 10px",cursor:"pointer",color:"#fff",fontSize:13,fontWeight:700}}>Log out</button>
        </div>
      </div>
      <div style={{display:"flex",gap:0,background:cardBg,borderBottom:"1px solid "+(dark?"#334155":"#e5e7eb"),overflowX:"auto"}}>
        {navItems.map(function(item){
          var mm = MODULE_META[item.id] || {color:"#2563eb",light:"#eff6ff"};
          var active = activeModule===item.id;
          return <button key={item.id} onClick={function(){setActiveModule(item.id);}} style={{padding:"12px 18px",border:"none",borderRadius:0,fontFamily:"inherit",fontWeight:700,fontSize:13,cursor:"pointer",whiteSpace:"nowrap",background:active?(dark?"#1e293b":mm.light):"transparent",color:active?mm.color:(dark?"#94a3b8":"#6b7280"),borderBottom:active?"3px solid "+mm.color:"3px solid transparent"}}>{item.icon} {item.label}</button>;
        })}
      </div>
      <div style={{padding:"20px 16px",maxWidth:740,margin:"0 auto"}}>
        {activeModule==="overview" && <UnifiedBusinessDashboard db={db}/>}
        {activeModule==="sms" && (
          <div style={{background:cardBg,border:"1px solid "+(dark?"#334155":"#e5e7eb"),borderRadius:16,padding:"22px 20px"}}>
            <SmsImportPanel onImport={addTx}/>
          </div>
        )}
        {activeModule!=="overview" && activeModule!=="sms" && activeModule!=="clinic" && (
          <ModulePage mod={activeModule} txns={db[activeModule]} onAdd={addTx} onDelete={function(id){delTx(activeModule,id);}} budgets={db.budgets[activeModule]} onBudgetUpdate={function(b){updateBudgets(activeModule,b);}} goals={activeModule==="personal"?db.goals:[]} onGoalsUpdate={updateGoals}/>
        )}
        {activeModule==="clinic" && (
          <div>
            <ModulePage mod="clinic" txns={db.clinic} onAdd={addTx} onDelete={function(id){delTx("clinic",id);}} budgets={db.budgets.clinic} onBudgetUpdate={function(b){updateBudgets("clinic",b);}} goals={[]} onGoalsUpdate={function(){}}/>
            <InterestCalc/>
            <LoanTracker loans={db.loans} onAddLoan={addLoan} onDeleteLoan={delLoan} onAddRepayment={addRepay}/>
          </div>
        )}
      </div>
    </div>
  );
}
